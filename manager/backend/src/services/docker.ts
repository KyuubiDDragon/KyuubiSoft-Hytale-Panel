/**
 * Docker control for one or more Hytale server containers.
 *
 * Every public function takes an optional `serverId`. When omitted the
 * default server from the registry (services/servers.ts) is used so all
 * legacy /api/server/* callers keep working unchanged. Multi-server clients
 * pass an explicit id, normally injected by the /api/servers/:id/* mount
 * point that copies req.params.serverId onto req.serverId.
 *
 * The registry is the single source of truth for container names, ports
 * and on-disk paths — never read these from `config.*` directly inside
 * Docker calls, because that would silently ignore multi-server setups.
 */
import type Docker from 'dockerode';
import { config } from '../config.js';
import type { ServerStatus, ServerStats, ActionResponse } from '../types/index.js';
import { validateCommand, containsControlChars, PLAYER_NAME_SOURCE } from '../utils/sanitize.js';
import { clearOnlinePlayers } from './players.js';
import { isDemoMode, getDemoStatus, getDemoStats, getDemoLogs } from './demoData.js';
import { ensureLoaded, getDefaultId, getServer, resolveServerId } from './servers.js';
import { createDockerClient } from './dockerClient.js';
import { ensurePluginAuthConfig } from './pluginAuth.js';
import { decodeDockerOutput } from './dockerStream.js';
import {
  runCommandViaPlugin,
  type PluginCommandAttempt,
  type PluginCommandStatus,
} from './pluginCommands.js';
import { currentCommandActor } from './commandActor.js';

const docker = createDockerClient();

// A hung Docker daemon (or a wedged socket/proxy) would otherwise block these
// calls forever and freeze every operator request that depends on them. We race
// each one-shot Docker call against a timeout so the handler always returns.
// Streaming calls (log follow, stdin attach) are deliberately NOT wrapped.
const DOCKER_OP_TIMEOUT_MS = 30_000;
// `docker stop` waits `t` seconds after SIGTERM before SIGKILL; allow some
// headroom on top before we give up on the whole operation.
const DEFAULT_STOP_SECONDS = 30;
const DOCKER_STOP_HEADROOM_MS = 15_000;

class DockerTimeoutError extends Error {
  constructor(op: string, ms: number) {
    super(`Docker '${op}' timed out after ${ms}ms (daemon unresponsive?)`);
    this.name = 'DockerTimeoutError';
  }
}

function withTimeout<T>(
  op: string,
  promise: Promise<T>,
  ms: number = DOCKER_OP_TIMEOUT_MS,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new DockerTimeoutError(op, ms)), ms);
    timer.unref?.();
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

/** Resolve the container name for an explicit or default server id. */
async function resolveContainerName(serverId?: string): Promise<string> {
  // Fast path for legacy single-server boot before servers.json exists.
  if (!serverId) {
    try {
      const id = await getDefaultId();
      const s = await getServer(id);
      return s?.containerName ?? config.gameContainerName;
    } catch {
      return config.gameContainerName;
    }
  }
  const s = await getServer(serverId);
  if (!s) throw new Error(`Unknown server id: ${serverId}`);
  return s.containerName;
}

async function getContainer(serverId?: string): Promise<Docker.Container | null> {
  try {
    const name = await resolveContainerName(serverId);
    return docker.getContainer(name);
  } catch {
    return null;
  }
}

export async function getStatus(serverId?: string): Promise<ServerStatus> {
  if (isDemoMode()) return getDemoStatus();
  try {
    const container = await getContainer(serverId);
    if (!container) return { status: 'not_found', running: false, error: 'Container not found' };
    const info = await withTimeout('inspect', container.inspect());
    return {
      status: info.State.Status,
      running: info.State.Running,
      id: info.Id.substring(0, 12),
      name: info.Name.replace('/', ''),
      created: info.Created,
      started_at: info.State.StartedAt,
    };
  } catch (error) {
    return {
      status: 'error',
      running: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}

export async function getStats(serverId?: string): Promise<ServerStats> {
  if (isDemoMode()) return getDemoStats();
  try {
    const container = await getContainer(serverId);
    if (!container) return { error: 'Container not found' };
    const info = await withTimeout('inspect', container.inspect());
    if (!info.State.Running) return { error: 'Container not running' };
    const stats = await withTimeout('stats', container.stats({ stream: false }));
    const cpuDelta =
      stats.cpu_stats.cpu_usage.total_usage - stats.precpu_stats.cpu_usage.total_usage;
    const systemDelta = stats.cpu_stats.system_cpu_usage - stats.precpu_stats.system_cpu_usage;
    const cpuCount = stats.cpu_stats.online_cpus || 1;
    const cpuPercent = systemDelta > 0 ? (cpuDelta / systemDelta) * cpuCount * 100 : 0;
    const memoryUsage = stats.memory_stats.usage || 0;
    const memoryLimit = stats.memory_stats.limit || 1;
    const memoryPercent = (memoryUsage / memoryLimit) * 100;
    return {
      cpu_percent: Math.round(cpuPercent * 100) / 100,
      memory_bytes: memoryUsage,
      memory_limit_bytes: memoryLimit,
      memory_percent: Math.round(memoryPercent * 100) / 100,
      memory_mb: Math.round((memoryUsage / (1024 * 1024)) * 10) / 10,
      memory_limit_mb: Math.round((memoryLimit / (1024 * 1024)) * 10) / 10,
    };
  } catch (error) {
    return { error: error instanceof Error ? error.message : 'Unknown error' };
  }
}

export interface ContainerState {
  running: boolean;
  status: string;
  startedAt: string;
  finishedAt: string;
  /** Exit code of the last run; Docker resets it to 0 while running. */
  exitCode: number;
  oomKilled: boolean;
  restartCount: number;
}

/**
 * Raw container state for the lifecycle and the watchdog. Null when the
 * container (or the server id) does not exist; other Docker errors throw.
 */
export async function getContainerState(serverId?: string): Promise<ContainerState | null> {
  let name: string;
  try {
    name = await resolveContainerName(serverId);
  } catch {
    return null;
  }
  try {
    const info = await withTimeout('inspect', docker.getContainer(name).inspect());
    return {
      running: info.State.Running === true,
      status: info.State.Status,
      startedAt: info.State.StartedAt ?? '',
      finishedAt: info.State.FinishedAt ?? '',
      exitCode: info.State.ExitCode ?? 0,
      oomKilled: info.State.OOMKilled === true,
      restartCount: info.RestartCount ?? 0,
    };
  } catch (error) {
    if ((error as { statusCode?: number }).statusCode === 404) return null;
    throw error;
  }
}

/**
 * The container's memory limit in bytes (compose `deploy.resources.limits.memory`),
 * or null when it has none or Docker cannot be asked.
 */
export async function getContainerMemoryLimit(serverId?: string): Promise<number | null> {
  if (isDemoMode()) return 8 * 1024 * 1024 * 1024;
  try {
    const name = await resolveContainerName(serverId);
    const info = await withTimeout('inspect', docker.getContainer(name).inspect());
    const limit = info.HostConfig?.Memory ?? 0;
    return limit > 0 ? limit : null;
  } catch {
    return null;
  }
}

/**
 * Whether the Java server process runs inside the container (it does not
 * while the entrypoint is still downloading or between update restarts).
 * Null when Docker cannot tell; callers then assume it does.
 */
export async function isServerProcessRunning(serverId?: string): Promise<boolean | null> {
  try {
    const container = await getContainer(serverId);
    if (!container) return null;
    const top = await withTimeout('top', container.top());
    const cmdIndex = (top.Titles ?? []).findIndex((t: string) => /^(CMD|COMMAND)$/i.test(t));
    if (cmdIndex < 0) return null;
    return (top.Processes ?? []).some((p: string[]) => /(^|\/)java\s/.test(p[cmdIndex] ?? ''));
  } catch {
    return null;
  }
}

// Records the last time the panel itself stopped/restarted a server, so the
// watchdog can tell a deliberate stop from a crash and not "restart" something
// an operator just stopped (or fight a restart already in progress).
// Keyed by the concrete registry id: legacy callers pass no id, the watchdog
// always passes the real one, so both sides go through resolveServerId().
const intentionalStops = new Map<string, number>();
export async function noteIntentionalStop(serverId?: string): Promise<void> {
  intentionalStops.set(await resolveServerId(serverId), Date.now());
}
export async function wasRecentlyStoppedIntentionally(
  serverId: string | undefined,
  withinMs: number,
): Promise<boolean> {
  const ts = intentionalStops.get(await resolveServerId(serverId));
  return ts !== undefined && Date.now() - ts < withinMs;
}

// The line as the server reads it: surrounding spaces and one leading "/" go,
// and so do spaces after that slash (the server accepts "/ stop" too). The
// stop detection must not depend on every caller having validated the line.
function commandWords(command: string): string {
  return command.trim().replace(/^\/\s*/, '');
}

// Hytale 0.7 registers `stop` with the alias `shutdown`; `--crash` makes it
// shut down as a crash, which the watchdog should still report as one.
function isStopCommand(command: string): boolean {
  return /^(stop|shutdown)\b/i.test(commandWords(command)) && !/--crash\b/i.test(command);
}

// Commands that take the server, and the plugin with it, down: a stop, and
// `/update apply --confirm`, which restarts into the staged update (exit 8).
function takesServerDown(command: string): boolean {
  return isStopCommand(command) || /^update\s+apply\b.*\s--confirm\b/i.test(commandWords(command));
}

/** Test hook. */
export const __stopDetection = { isStopCommand, takesServerDown };

export async function startContainer(serverId?: string): Promise<ActionResponse> {
  if (isDemoMode()) return { success: true, message: '[DEMO] Container started' };
  try {
    const container = await getContainer(serverId);
    if (!container) return { success: false, error: 'Container not found' };
    // The KyuubiSoft API plugin only accepts the panel's token; write it before
    // the server process starts. Never throws, so it cannot block the start.
    await ensurePluginAuthConfig(serverId);
    await withTimeout('start', container.start());
    return { success: true, message: 'Container started' };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
  }
}

/**
 * `docker stop`: SIGTERM, then SIGKILL after `timeoutSeconds`. The start script
 * forwards SIGTERM to Java, which then saves and shuts down. Prefer
 * serverLifecycle.stopServerGracefully(), which tries `/stop` first.
 */
export async function stopContainer(
  serverId?: string,
  timeoutSeconds: number = DEFAULT_STOP_SECONDS,
): Promise<ActionResponse> {
  if (isDemoMode()) return { success: true, message: '[DEMO] Container stopped' };
  try {
    const container = await getContainer(serverId);
    if (!container) return { success: false, error: 'Container not found' };
    await noteIntentionalStop(serverId); // tell the watchdog this stop was deliberate
    await withTimeout(
      'stop',
      container.stop({ t: timeoutSeconds }),
      timeoutSeconds * 1000 + DOCKER_STOP_HEADROOM_MS,
    );
    clearOnlinePlayers();
    return { success: true, message: 'Container stopped' };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
  }
}

/**
 * @deprecated No caller is left: it bypasses `/stop` and the per-server
 * lifecycle lock. Use restartServerGracefully() from services/serverLifecycle.ts.
 */
export async function restartContainer(serverId?: string): Promise<ActionResponse> {
  if (isDemoMode()) return { success: true, message: '[DEMO] Container restarted' };
  try {
    const container = await getContainer(serverId);
    if (!container) return { success: false, error: 'Container not found' };
    await noteIntentionalStop(serverId); // restart cycles through "stopped"; don't treat as a crash
    await ensurePluginAuthConfig(serverId); // picked up by the restarted process, see startContainer
    await withTimeout(
      'restart',
      container.restart({ t: DEFAULT_STOP_SECONDS }),
      DEFAULT_STOP_SECONDS * 1000 + DOCKER_STOP_HEADROOM_MS,
    );
    clearOnlinePlayers();
    return { success: true, message: 'Container restarted' };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
  }
}

export async function getLogs(tail: number = 100, serverId?: string): Promise<string> {
  if (isDemoMode()) return getDemoLogs(tail);
  try {
    const container = await getContainer(serverId);
    if (!container) return '';
    const logs = await withTimeout(
      'logs',
      container.logs({ stdout: true, stderr: true, tail, timestamps: true }) as Promise<Buffer>,
    );
    // Without a TTY Docker frames stdout/stderr; strip those headers.
    return decodeDockerOutput(logs);
  } catch {
    return '';
  }
}

// The stdin console of each server: one attach per server (keyed by the
// registry id, so a command for server A never reaches server B), shared by
// every caller and written to one line at a time.
//  - It belongs to the container run it was made for. After a restart the old
//    socket still looks writable until Docker closes it and would swallow the
//    next commands, so a changed container id or start time replaces it.
//  - Callers that need it at the same time wait for the same attach.
//  - Writes are queued per server and only count once the socket took them.
interface StdinConsole {
  stream: NodeJS.WritableStream;
  containerId: string | undefined;
  startedAt: string | undefined;
  closed: boolean;
}
const stdinConsoles = new Map<string, StdinConsole>();
const stdinAttaching = new Map<string, Promise<StdinConsole | null>>();
const consoleQueues = new Map<string, { tail: Promise<unknown>; waiting: number }>();
// Console lines of one server waiting for their turn at most.
const MAX_QUEUED_CONSOLE_LINES = 100;
const CONSOLE_WRITE_TIMEOUT_MS = 5_000;

type ConsoleRun = Pick<Docker.ContainerInspectInfo, 'Id'> & {
  State: Pick<Docker.ContainerInspectInfo['State'], 'StartedAt'>;
};

function isUsable(c: StdinConsole, info: ConsoleRun): boolean {
  const s = c.stream as NodeJS.WritableStream & { destroyed?: boolean; writableEnded?: boolean };
  return (
    !c.closed &&
    !s.destroyed &&
    !s.writableEnded &&
    s.writable !== false &&
    c.containerId === info.Id &&
    c.startedAt === info.State?.StartedAt
  );
}

function dropConsole(key: string, c: StdinConsole): void {
  c.closed = true;
  if (stdinConsoles.get(key) === c) stdinConsoles.delete(key);
  const s = c.stream as NodeJS.WritableStream & { destroy?: () => void };
  s.removeAllListeners?.('error');
  s.on?.('error', () => {}); // a dead socket may still report its error
  try {
    s.destroy?.();
  } catch {
    // already gone
  }
}

/** Writes and resolves once the socket took the bytes (or rejects). */
function writeToConsole(c: StdinConsole, data: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error('the console did not take the line in time')),
      CONSOLE_WRITE_TIMEOUT_MS,
    );
    try {
      c.stream.write(data, (error?: Error | null) => {
        clearTimeout(timer);
        if (error) reject(error);
        else resolve();
      });
    } catch (error) {
      clearTimeout(timer);
      reject(error);
    }
  });
}

async function attachConsole(
  key: string,
  container: Docker.Container,
  info: ConsoleRun,
): Promise<StdinConsole | null> {
  let c: StdinConsole | undefined;
  try {
    const stream = await container.attach({
      stream: true,
      stdin: true,
      stdout: false,
      stderr: false,
      hijack: true,
    });
    const own: StdinConsole = {
      stream,
      containerId: info.Id,
      startedAt: info.State?.StartedAt,
      closed: false,
    };
    c = own;
    const gone = () => {
      own.closed = true;
      if (stdinConsoles.get(key) === own) stdinConsoles.delete(key);
    };
    stream.on('error', gone);
    stream.on('close', gone);
    // dockerode sends the attach options as a JSON request body, and Docker
    // forwards those bytes to the container's stdin. Without a line break they
    // would be glued in front of the first real command, which the server then
    // rejects as unknown. Terminate them so they stay one harmless line.
    await writeToConsole(own, '\n');
    stdinConsoles.set(key, own);
    return own;
  } catch (error) {
    console.error('Failed to attach stdin:', error);
    // A socket that would not even take the first line is not kept open.
    if (c) dropConsole(key, c);
    return null;
  }
}

/** The server's stdin console for this container run, attached if needed. */
async function consoleFor(
  key: string,
  container: Docker.Container,
  info: ConsoleRun,
): Promise<StdinConsole | null> {
  const current = stdinConsoles.get(key);
  if (current && isUsable(current, info)) return current;
  if (current) dropConsole(key, current);
  let attaching = stdinAttaching.get(key);
  if (!attaching) {
    attaching = attachConsole(key, container, info).finally(() => stdinAttaching.delete(key));
    stdinAttaching.set(key, attaching);
  }
  return attaching;
}

/** Runs console writes of one server strictly one after another. */
function inConsoleQueue<T>(key: string, task: () => Promise<T>, busy: T): Promise<T> {
  let queue = consoleQueues.get(key);
  if (!queue) {
    queue = { tail: Promise.resolve(), waiting: 0 };
    consoleQueues.set(key, queue);
  }
  if (queue.waiting >= MAX_QUEUED_CONSOLE_LINES) return Promise.resolve(busy);
  const own = queue;
  own.waiting++;
  const run = own.tail.then(task, task);
  own.tail = run.catch(() => undefined);
  return run.finally(() => {
    own.waiting--;
    if (own.waiting === 0 && consoleQueues.get(key) === own) consoleQueues.delete(key);
  });
}

// Errors after which the line certainly did not leave the panel.
const NOT_WRITTEN_CODES = new Set(['ERR_STREAM_WRITE_AFTER_END', 'ERR_STREAM_DESTROYED']);

export interface ExecCommandOptions {
  /** Panel user the command runs for; defaults to the user of the current request. */
  actor?: string | null;
  /** Also print the answer to the server console; see echoesToServerLog. */
  echo?: boolean;
  /** How long the plugin waits for the command before answering RUNNING. */
  timeoutMs?: number;
}

/**
 * Outcome of execCommand. Through the KyuubiSoft API plugin (`via: 'plugin'`)
 * `success` is the command's real outcome, `lines`/`output` its answer and
 * `status` how it ended. Through stdin (`via: 'stdin'`) `success` only means
 * the line was written to the console.
 */
export interface CommandExecResult extends ActionResponse {
  via?: 'plugin' | 'stdin' | 'demo';
  status?: PluginCommandStatus;
  lines?: string[];
  messageIds?: string[];
}

// Some callers read a command's answer from the server log: the Hytale sign-in
// flow (services/hytaleAuth.ts, the setup wizard) the device code of /auth,
// the native backup (services/nativeBackups.ts) the result of /backup, and the
// panel backup (services/backup.ts) the end of `/world save --all`. Their
// answers are also printed there, as they were when every command ran as the
// console.
function echoesToServerLog(command: string): boolean {
  return /^\/?(auth|backup|world\s+save)\b/i.test(command.trim());
}
const ECHOED_COMMAND_TIMEOUT_MS = 1_500;

function fromPluginAttempt(
  command: string,
  attempt: Exclude<PluginCommandAttempt, { kind: 'unavailable' }>,
): CommandExecResult {
  if (attempt.kind === 'invalid') return { success: false, error: attempt.error, via: 'plugin' };
  if (attempt.kind === 'unknown') {
    // Such a command takes the plugin down with the server, often before it answers.
    if (takesServerDown(command)) {
      return { success: true, message: `Command sent: ${command}`, via: 'plugin' };
    }
    return {
      success: false,
      error: `${attempt.error}. The command may still have run; it was not sent again.`,
      via: 'plugin',
    };
  }
  const { reply } = attempt;
  const output = reply.output.join('\n');
  const fallbackMessage =
    reply.status === 'RUNNING'
      ? `Command still running: ${command}`
      : `Command executed: ${command}`;
  return {
    success: reply.ok,
    message: output || fallbackMessage,
    output,
    error: reply.ok ? undefined : (reply.error ?? 'Command failed'),
    via: 'plugin',
    status: reply.status,
    lines: reply.output,
    messageIds: reply.messageIds,
  };
}

export async function execCommand(
  command: string,
  serverId?: string,
  options: ExecCommandOptions = {},
): Promise<CommandExecResult> {
  // SECURITY: single gate for everything an operator, a rule or a route sends
  // to the game console, on either path below. It runs after every caller has
  // filled in its placeholders, so an embedded line break (a second, unchecked
  // console command) or a TTY control byte (Ctrl-C shuts the server down) is
  // rejected here no matter which path built it.
  const validation = validateCommand(command);
  if (!validation.valid) {
    // JSON.stringify keeps a smuggled line break from forging log lines.
    console.warn(
      `[SECURITY] Blocked command: ${JSON.stringify(String(command).slice(0, 80))} Reason: ${validation.error}`,
    );
    return { success: false, error: validation.error || 'Invalid command' };
  }
  return deliverCommand(command, serverId, options);
}

// The panel's own shutdown and countdown commands (serverLifecycle.ts). They
// are not on the operator console whitelist (`/world` also has destructive
// subcommands), so only these exact shapes pass here.
const LIFECYCLE_COMMAND =
  /^\/(?:stop|notify (?:warning|danger) \S.*|eventtitle \S.*|world save --all --confirm)$/;

export async function sendLifecycleCommand(
  command: string,
  serverId?: string,
): Promise<CommandExecResult> {
  if (containsControlChars(command) || !LIFECYCLE_COMMAND.test(command)) {
    return { success: false, error: 'Not a lifecycle command' };
  }
  return deliverCommand(command, serverId);
}

// The access pages' commands (services/accessCommands.ts): whitelist, bans
// and permissions. `/perm` is not on the operator console whitelist, so only
// these exact shapes pass here; the routes check the access rights.
const ACCESS_UUID = '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}';
const ACCESS_PLAYER = `(?:${PLAYER_NAME_SOURCE}|${ACCESS_UUID})`;
const ACCESS_GROUP = '[A-Za-z0-9][A-Za-z0-9_:-]{0,63}';
const ACCESS_NODE = '-?\\w[\\w-]*(?:\\.[\\w*][\\w*-]*){0,31}';
// Free text after the player, as words with single spaces: no quote, backslash,
// bracket or comma the server's tokenizer would act on, no word it reads as an option.
const ACCESS_WORD = '(?!--)[^\\s"\'\\\\\\[\\],]+';
const ACCESS_REASON = `(?=.{1,200}$)${ACCESS_WORD}(?: ${ACCESS_WORD})*`;
const ACCESS_COMMAND = new RegExp(
  '^/(?:' +
    [
      'whitelist (?:enable|disable|status|list)',
      `whitelist (?:add|remove) ${ACCESS_PLAYER}`,
      `ban ${ACCESS_PLAYER}(?: ${ACCESS_REASON})?`,
      `unban ${ACCESS_PLAYER}`,
      `perm user (?:add|remove) ${ACCESS_UUID} ${ACCESS_NODE}`,
      `perm user group (?:add|remove) ${ACCESS_UUID} ${ACCESS_GROUP}`,
      `perm group (?:add|remove) ${ACCESS_GROUP} ${ACCESS_NODE}`,
    ].join('|') +
    ')$',
);

export async function sendAccessCommand(
  command: string,
  serverId?: string,
): Promise<CommandExecResult> {
  if (containsControlChars(command) || !ACCESS_COMMAND.test(command)) {
    return { success: false, error: 'Not an access command' };
  }
  return deliverCommand(command, serverId);
}

// The two ways a command reaches the server, both behind the caller's gate.
// Preferred: the plugin runs the command and returns its answer. The stdin
// console is only used when the plugin did not take the command (not
// installed, unreachable, too old, token refused); a command that may have
// reached the plugin is never sent a second time.
async function deliverCommand(
  command: string,
  serverId: string | undefined,
  options: ExecCommandOptions = {},
): Promise<CommandExecResult> {
  if (isDemoMode()) {
    return { success: true, message: `[DEMO] Command executed: ${command}`, via: 'demo' };
  }

  // A console stop exits the container just like a UI stop does.
  if (isStopCommand(command)) await noteIntentionalStop(serverId);
  const echo = options.echo ?? echoesToServerLog(command);
  const attempt = await runCommandViaPlugin(command, serverId, {
    actor: options.actor ?? currentCommandActor(),
    echo,
    // Callers of echoed commands read the answer from the log; a long-running
    // one (/auth login device waits for the sign-in) must not hold them up.
    timeoutMs: options.timeoutMs ?? (echo ? ECHOED_COMMAND_TIMEOUT_MS : undefined),
  });
  if (attempt.kind !== 'unavailable') return fromPluginAttempt(command, attempt);
  return writeConsoleLine(command, serverId);
}

/**
 * A checked command line as the server's stdin console must receive it.
 *
 * The console reads stdin through a line editor that rewrites a line before
 * the server runs it: a backslash escapes the next character and is dropped
 * (`d\ilation` becomes `dilation`), and `!!`, `!$` or `!word` are replaced
 * with text of earlier console lines, inside quotes too. Each backslash and
 * each `!` is escaped with a backslash, so the server gets back exactly the
 * line the panel checked and classified. The plugin path takes the line as
 * it is.
 */
export function toConsoleLine(command: string): string {
  return command.replace(/[\\!]/g, '\\$&');
}

// The fallback: the server's console stdin. There used to be a `docker exec`
// fallback behind it that echoed into /proc/1/fd/0; with a TTY that lands in
// the terminal's output, not its input, so it reported success for commands
// that never ran. A missing console is now reported as an error.
async function writeConsoleLine(command: string, serverId?: string): Promise<CommandExecResult> {
  let key: string;
  try {
    // Same key for legacy and scoped callers, otherwise one container gets two
    // concurrent stdin attaches.
    key = await resolveServerId(serverId);
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
  }
  return inConsoleQueue(key, () => writeConsoleLineNow(command, serverId, key), {
    success: false,
    error: `Too many console commands waiting (${MAX_QUEUED_CONSOLE_LINES}); try again shortly`,
    via: 'stdin',
  });
}

async function writeConsoleLineNow(
  command: string,
  serverId: string | undefined,
  key: string,
): Promise<CommandExecResult> {
  try {
    const container = await getContainer(serverId);
    if (!container) return { success: false, error: 'Container not found' };
    const info = await withTimeout('inspect', container.inspect());
    if (!info.State.Running) return { success: false, error: 'Container not running' };

    const line = toConsoleLine(command) + '\n';
    // A socket that turns out dead before taking the line gets one fresh attach.
    for (let attempt = 0; ; attempt++) {
      const c = await consoleFor(key, container, info);
      if (!c) return { success: false, error: 'Server console is not reachable', via: 'stdin' };
      try {
        await writeToConsole(c, line);
        return { success: true, message: `Command executed: ${command}`, via: 'stdin' };
      } catch (error) {
        dropConsole(key, c);
        const code = (error as NodeJS.ErrnoException).code;
        if (attempt === 0 && code && NOT_WRITTEN_CODES.has(code)) continue;
        const reason = error instanceof Error ? error.message : 'Unknown error';
        return {
          success: false,
          error: `Writing to the server console failed: ${reason}`,
          via: 'stdin',
        };
      }
    }
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
  }
}

// How long execInContainer waits for a command before it returns the output
// collected so far (the command keeps running in the container).
const EXEC_OUTPUT_WAIT_MS = 5000;

export async function execInContainer(
  command: string,
  serverId?: string,
  options: { timeoutMs?: number } = {},
): Promise<ActionResponse & { output?: string }> {
  if (isDemoMode()) {
    if (command.includes('stats memory')) {
      const { getDemoMemoryStats } = await import('./demoData.js');
      return { success: true, output: getDemoMemoryStats().raw };
    }
    return { success: true, output: '[DEMO] Command executed' };
  }
  try {
    const container = await getContainer(serverId);
    if (!container) return { success: false, error: 'Container not found' };
    const info = await withTimeout('inspect', container.inspect());
    if (!info.State.Running) return { success: false, error: 'Container not running' };
    const exec = await withTimeout(
      'exec',
      container.exec({ Cmd: ['sh', '-c', command], AttachStdout: true, AttachStderr: true }),
    );
    const stream = await exec.start({});
    return new Promise((resolve) => {
      // exec output is framed (no TTY); decode the frames instead of guessing.
      const chunks: Buffer[] = [];
      const output = () => decodeDockerOutput(Buffer.concat(chunks)).trim();
      stream.on('data', (chunk: Buffer | string) => {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      });
      stream.on('end', () => resolve({ success: true, output: output() }));
      stream.on('error', (err: Error) => resolve({ success: false, error: err.message }));
      setTimeout(
        () => resolve({ success: true, output: output() }),
        options.timeoutMs ?? EXEC_OUTPUT_WAIT_MS,
      );
    });
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
  }
}

export function getDockerInstance(): Docker {
  return docker;
}

/**
 * Synchronous lookup — preserved for the few legacy call sites that need
 * a container name without an async boundary. Returns the registry value
 * when servers.json has been loaded, otherwise the env-var default.
 */
export function getContainerName(): string {
  // ensureLoaded is fire-and-forget here; the registry sync-cache fills in
  // after the first call. Until then we serve the env-var default which
  // happens to also be the default-server's container name on fresh installs.
  void ensureLoaded();
  return config.gameContainerName;
}
