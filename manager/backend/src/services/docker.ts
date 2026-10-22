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
import { validateCommand, containsControlChars } from '../utils/sanitize.js';
import { clearOnlinePlayers } from './players.js';
import { isDemoMode, getDemoStatus, getDemoStats, getDemoLogs } from './demoData.js';
import { ensureLoaded, getDefaultId, getServer, resolveServerId } from './servers.js';
import { createDockerClient } from './dockerClient.js';
import { ensurePluginAuthConfig } from './pluginAuth.js';
import { decodeDockerOutput } from './dockerStream.js';

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

// Hytale 0.7 registers `stop` with the alias `shutdown`; `--crash` makes it
// shut down as a crash, which the watchdog should still report as one.
function isStopCommand(command: string): boolean {
  return /^\/?(stop|shutdown)\b/i.test(command.trim()) && !/--crash\b/i.test(command);
}

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

// Stdin streams are kept per-server so we don't accidentally pipe a command
// for server A into server B's container shell.
const stdinStreams = new Map<string, NodeJS.WritableStream>();

async function ensureStdinAttached(serverId?: string): Promise<{ ok: boolean; key: string }> {
  // Same key for legacy and scoped callers, otherwise one container gets two
  // concurrent stdin attaches.
  const key = await resolveServerId(serverId);
  const existing = stdinStreams.get(key);
  if (existing) return { ok: true, key };
  try {
    const container = await getContainer(serverId);
    if (!container) return { ok: false, key };
    const info = await withTimeout('inspect', container.inspect());
    if (!info.State.Running) return { ok: false, key };
    const stream = await container.attach({
      stream: true,
      stdin: true,
      stdout: false,
      stderr: false,
      hijack: true,
    });
    // dockerode sends the attach options as a JSON request body, and Docker
    // forwards those bytes to the container's stdin. Without a line break they
    // would be glued in front of the first real command, which the server then
    // rejects as unknown. Terminate them so they stay one harmless line.
    stream.write('\n');
    stdinStreams.set(key, stream);
    stream.on('error', () => stdinStreams.delete(key));
    stream.on('close', () => stdinStreams.delete(key));
    return { ok: true, key };
  } catch (error) {
    console.error('Failed to attach stdin:', error);
    return { ok: false, key };
  }
}

export async function execCommand(command: string, serverId?: string): Promise<ActionResponse> {
  // SECURITY: single gate for everything written to the game console. It runs
  // after every caller has filled in its placeholders, so an embedded line
  // break (a second, unchecked console command) or a TTY control byte (Ctrl-C
  // shuts the server down) is rejected here no matter which path built it.
  const validation = validateCommand(command);
  if (!validation.valid) {
    // JSON.stringify keeps a smuggled line break from forging log lines.
    console.warn(
      `[SECURITY] Blocked command: ${JSON.stringify(String(command).slice(0, 80))} Reason: ${validation.error}`,
    );
    return { success: false, error: validation.error || 'Invalid command' };
  }
  return writeConsoleLine(command, serverId);
}

// The panel's own shutdown and countdown commands (serverLifecycle.ts). They
// are not on the operator console whitelist (`/world` also has destructive
// subcommands), so only these exact shapes pass here.
const LIFECYCLE_COMMAND =
  /^\/(?:stop|notify (?:warning|danger) \S.*|eventtitle \S.*|world save --all --confirm)$/;

export async function sendLifecycleCommand(
  command: string,
  serverId?: string,
): Promise<ActionResponse> {
  if (containsControlChars(command) || !LIFECYCLE_COMMAND.test(command)) {
    return { success: false, error: 'Not a lifecycle command' };
  }
  return writeConsoleLine(command, serverId);
}

// The only way commands reach the server: its console stdin. There used to be
// a `docker exec` fallback that echoed into /proc/1/fd/0; with a TTY that
// lands in the terminal's output, not its input, so it reported success for
// commands that never ran. A missing console is now reported as an error.
async function writeConsoleLine(command: string, serverId?: string): Promise<ActionResponse> {
  if (isDemoMode()) {
    return { success: true, message: `[DEMO] Command executed: ${command}` };
  }
  try {
    const container = await getContainer(serverId);
    if (!container) return { success: false, error: 'Container not found' };
    const info = await withTimeout('inspect', container.inspect());
    if (!info.State.Running) return { success: false, error: 'Container not running' };

    // A console stop exits the container just like a UI stop does.
    if (isStopCommand(command)) await noteIntentionalStop(serverId);

    const attached = await ensureStdinAttached(serverId);
    const stream = attached.ok ? stdinStreams.get(attached.key) : undefined;
    if (!stream) return { success: false, error: 'Server console is not reachable' };
    try {
      stream.write(command + '\n');
      return { success: true, message: `Command executed: ${command}` };
    } catch (error) {
      stdinStreams.delete(attached.key);
      const reason = error instanceof Error ? error.message : 'Unknown error';
      return { success: false, error: `Writing to the server console failed: ${reason}` };
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
