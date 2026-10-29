/**
 * Graceful server lifecycle.
 *
 * Every path that stops, restarts or briefly takes a game server down (the
 * UI, setup wizard, scheduler, watchdog, updates, rollback, backup restore)
 * goes through this module, so the server always gets the chance to save:
 *
 *   optional countdown in game → `/stop` on the console → wait for the
 *   container to exit → fall back to `docker stop` (SIGTERM, then SIGKILL)
 *
 * Hytale 0.7 saves every world and lets plugins flush their data while it
 * handles `/stop`. The start script forwards SIGTERM to Java, so the Docker
 * fallback runs the same shutdown sequence, only without the announcement.
 *
 * Operations are serialized per server: a restore can never overlap a
 * scheduled restart or an update. A countdown runs before the lock is taken,
 * so a long warning period does not block other operations. Calls made from
 * inside withServerStopped() for the same server re-enter the held lock
 * instead of deadlocking.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import fs from 'fs';
import path from 'path';
import * as dockerService from './docker.js';
import { clearOnlinePlayers } from './players.js';
import { publish } from './eventBus.js';
import { getServer, resolveServerId } from './servers.js';
import { isDemoMode } from './demoData.js';
import { toCommandText } from '../utils/sanitize.js';

export type LifecycleReason =
  | 'user'
  | 'restart'
  | 'scheduled'
  | 'update'
  | 'rollback'
  | 'restore'
  | 'config'
  | 'setup'
  | 'watchdog'
  | 'delete';

export interface GracefulOptions {
  reason: LifecycleReason;
  /** Panel user (or subsystem) that asked for it; recorded on the events. */
  actor?: string;
  /** Announce the stop in game and wait this long first (0 = stop right away). */
  countdownSeconds?: number;
  /** Countdown text. `{time}` becomes "5 minutes", "30 seconds", … */
  message?: string;
  /** Announced once more right before `/stop`, only after a countdown. */
  finalMessage?: string;
  /** Seconds before the stop at which to announce; defaults to WARNING_SECONDS. */
  warningSeconds?: number[];
  /** How long to wait for the server to exit after `/stop` before the Docker fallback. */
  timeoutMs?: number;
  /** Aborts a running countdown; the server is then left untouched. */
  signal?: AbortSignal;
  /**
   * Fail with LifecycleBusyError instead of queueing behind another operation
   * on the same server (a second click must not run the action twice).
   */
  rejectIfBusy?: boolean;
}

export interface LifecycleResult {
  ok: boolean;
  method: 'command' | 'docker' | 'already_stopped' | 'already_running' | 'cancelled';
  error?: string;
}

/** Thrown by withServerStopped() when the server could not be stopped or started again. */
export class LifecycleError extends Error {
  constructor(
    message: string,
    readonly phase: 'stop' | 'start' | 'cancelled',
  ) {
    super(message);
    this.name = 'LifecycleError';
  }
}

/** Another stop/start/restart/rollback/restore of the server runs or waits (rejectIfBusy). */
export class LifecycleBusyError extends Error {
  readonly reason = 'lifecycle_busy';

  constructor() {
    super('Another server operation (stop, start, rollback, restore) is running.');
    this.name = 'LifecycleBusyError';
  }
}

function envSeconds(name: string, def: number): number {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? v : def;
}

// How long a server gets to save and exit after `/stop`, and the SIGTERM grace
// period when `/stop` could not be sent at all. Keep it in line with the
// compose `stop_grace_period`.
const STOP_TIMEOUT_SECONDS = envSeconds('SERVER_STOP_TIMEOUT_SECONDS', 120);
// SIGTERM grace for the fallback after `/stop` already had its full timeout.
const FALLBACK_STOP_SECONDS = 30;
// Container without a running server process (entrypoint still busy).
const NO_SERVER_STOP_SECONDS = 10;
const EXIT_POLL_MS = 1000;

/** Default announcement points of a countdown, in seconds before the stop. */
export const WARNING_SECONDS = [1800, 900, 300, 60, 30, 10];
// The big on-screen title is shown once, at the first announcement in the
// last minute; the worlds are saved shortly before the stop.
const TITLE_AT_SECONDS = 60;
const SAVE_AT_SECONDS = 10;
const SAVE_COMMAND = '/world save --all --confirm';
const MAX_TEXT_LENGTH = 200;

// Written by the start script when the server exits with an error that a
// restart cannot fix; it keeps Docker's restart policy from retrying it. A
// start requested through the panel is a deliberate retry, so it clears it.
const EXIT_GUARD_FILE = '.server-exit';

// ---------------------------------------------------------------------------
// Per-server mutex
// ---------------------------------------------------------------------------

const lockTails = new Map<string, Promise<void>>();
const heldLocks = new AsyncLocalStorage<ReadonlySet<string>>();
const activeOps = new Map<string, { reason: LifecycleReason; since: number }>();

async function exclusive<T>(
  id: string,
  opts: Pick<GracefulOptions, 'reason' | 'rejectIfBusy'>,
  fn: () => Promise<T>,
): Promise<T> {
  const held = heldLocks.getStore();
  if (held?.has(id)) return fn();
  // Checked and taken without an await in between, so of two simultaneous
  // calls exactly one gets the lock.
  if (opts.rejectIfBusy && lockTails.has(id)) throw new LifecycleBusyError();
  const { reason } = opts;

  const previous = lockTails.get(id) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const tail = previous.then(() => gate);
  lockTails.set(id, tail);

  await previous;
  activeOps.set(id, { reason, since: Date.now() });
  try {
    return await heldLocks.run(new Set([...(held ?? []), id]), fn);
  } finally {
    activeOps.delete(id);
    release();
    if (lockTails.get(id) === tail) lockTails.delete(id);
  }
}

/**
 * The lifecycle operation currently holding a server's lock, if any. The
 * watchdog uses it to leave a server alone while the panel takes it down.
 */
export function getActiveOperation(
  serverId: string,
): { reason: LifecycleReason; since: number } | null {
  return activeOps.get(serverId) ?? null;
}

/** Whether an operation holds the server's lock or waits for it. */
export function isLifecycleBusy(serverId: string): boolean {
  return lockTails.has(serverId);
}

// ---------------------------------------------------------------------------
// Countdown
// ---------------------------------------------------------------------------

export interface CountdownStep {
  /** Seconds before the stop. */
  secondsLeft: number;
  commands: string[];
}

export function formatDuration(seconds: number): string {
  if (seconds >= 120) return `${Math.round(seconds / 60)} minutes`;
  if (seconds === 60) return '1 minute';
  return seconds === 1 ? '1 second' : `${seconds} seconds`;
}

/**
 * Free text (countdown and shutdown messages) as one console argument the
 * Hytale 0.7 command parser takes literally; see toCommandText.
 */
export function toConsoleText(text: string): string {
  return toCommandText(text, MAX_TEXT_LENGTH);
}

function fillTemplate(template: string, secondsLeft: number): string {
  return template
    .replace(/\{time\}/g, formatDuration(secondsLeft))
    .replace(/\{minutes\}/g, String(Math.max(1, Math.ceil(secondsLeft / 60))))
    .replace(/\{seconds\}/g, String(secondsLeft));
}

/**
 * The console commands of a countdown, latest announcement first. Pure, so the
 * scheduler and the UI preview can show exactly what will be sent.
 */
export function buildCountdownPlan(opts: {
  countdownSeconds: number;
  action: 'stop' | 'restart';
  message?: string;
  finalMessage?: string;
  warningSeconds?: number[];
}): CountdownStep[] {
  const total = Math.floor(opts.countdownSeconds);
  if (!(total > 0)) return [];
  const template =
    opts.message?.trim() ||
    (opts.action === 'restart' ? 'Server restart in {time}.' : 'Server shutdown in {time}.');
  const points = [
    ...new Set([
      total,
      ...(opts.warningSeconds ?? WARNING_SECONDS)
        .map((s) => Math.floor(s))
        .filter((s) => s > 0 && s < total),
    ]),
  ].sort((a, b) => b - a);

  const steps: CountdownStep[] = [];
  let titled = false;
  for (const secondsLeft of points) {
    const text = toConsoleText(fillTemplate(template, secondsLeft));
    if (!text) continue;
    const commands = [`/notify warning ${text}`];
    if (!titled && secondsLeft <= TITLE_AT_SECONDS) {
      commands.push(`/eventtitle ${text}`);
      titled = true;
    }
    steps.push({ secondsLeft, commands });
  }

  if (total >= SAVE_AT_SECONDS) {
    const at = steps.find((s) => s.secondsLeft === SAVE_AT_SECONDS);
    if (at) at.commands.push(SAVE_COMMAND);
    else steps.push({ secondsLeft: SAVE_AT_SECONDS, commands: [SAVE_COMMAND] });
  }

  const final = opts.finalMessage ? toConsoleText(opts.finalMessage) : '';
  if (final) steps.push({ secondsLeft: 0, commands: [`/notify danger ${final}`] });

  return steps.sort((a, b) => b.secondsLeft - a.secondsLeft);
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new LifecycleError('Cancelled', 'cancelled'));
      return;
    }
    const timer = setTimeout(done, Math.max(0, ms));
    function done(): void {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }
    function onAbort(): void {
      clearTimeout(timer);
      reject(new LifecycleError('Cancelled', 'cancelled'));
    }
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

async function sendOrWarn(id: string, command: string): Promise<boolean> {
  const r = await dockerService.sendLifecycleCommand(command, id);
  if (!r.success) {
    console.warn(`[Lifecycle:${id}] Could not send ${command.split(' ')[0]}: ${r.error}`);
  }
  return r.success;
}

/** Runs the in-game countdown (outside the lock). Throws LifecycleError('cancelled') on abort. */
async function runCountdown(
  id: string,
  opts: GracefulOptions,
  action: 'stop' | 'restart',
): Promise<void> {
  const countdownSeconds = opts.countdownSeconds ?? 0;
  if (!(countdownSeconds > 0)) return;
  const state = await dockerService.getContainerState(id).catch(() => null);
  if (!state?.running) return; // nobody to warn

  const plan = buildCountdownPlan({
    countdownSeconds,
    action,
    message: opts.message,
    finalMessage: opts.finalMessage,
    warningSeconds: opts.warningSeconds,
  });
  const deadline = Date.now() + Math.floor(countdownSeconds) * 1000;
  console.log(`[Lifecycle:${id}] ${action} in ${countdownSeconds}s (${opts.reason})`);
  for (const step of plan) {
    await sleep(deadline - step.secondsLeft * 1000 - Date.now(), opts.signal);
    for (const command of step.commands) await sendOrWarn(id, command);
  }
  await sleep(deadline - Date.now(), opts.signal);
}

// ---------------------------------------------------------------------------
// Stop / start (callers hold the lock)
// ---------------------------------------------------------------------------

type ExitOutcome = 'exited' | 'restarted' | 'timeout';

async function waitForExit(id: string, startedAt: string, timeoutMs: number): Promise<ExitOutcome> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await sleep(Math.min(EXIT_POLL_MS, Math.max(0, deadline - Date.now())));
    let state: dockerService.ContainerState | null;
    try {
      state = await dockerService.getContainerState(id);
    } catch {
      continue; // a slow daemon is no reason to give up early
    }
    if (!state || !state.running) return 'exited';
    // A restart policy (or someone else) brought it straight back up.
    if (state.startedAt !== startedAt) return 'restarted';
  }
  return 'timeout';
}

function eventPayload(opts: GracefulOptions, action: string): Record<string, unknown> {
  return { reason: opts.reason, initiator: opts.actor, action };
}

async function dockerStop(id: string, seconds: number, method: 'command' | 'docker') {
  const r = await dockerService.stopContainer(id, seconds);
  return r.success
    ? ({ ok: true, method } as LifecycleResult)
    : ({ ok: false, method: 'docker', error: r.error } as LifecycleResult);
}

async function stopLocked(
  id: string,
  opts: GracefulOptions,
  action: 'stop' | 'restart',
): Promise<LifecycleResult> {
  const state = await dockerService.getContainerState(id);
  if (!state) return { ok: false, method: 'docker', error: 'Container not found' };
  if (!state.running) {
    // A stop asked for a server that is already down (e.g. right after a
    // crash) is still a decision: the watchdog must not start it again.
    await dockerService.noteIntentionalStop(id);
    return { ok: true, method: 'already_stopped' };
  }

  publish('server.stopping', eventPayload(opts, action), id);
  await dockerService.noteIntentionalStop(id);

  let result: LifecycleResult;
  // While the entrypoint still runs (first download, update restart) nothing
  // reads the console and there is nothing to save.
  const serverUp = (await dockerService.isServerProcessRunning(id)) !== false;
  const sent = serverUp && (await sendOrWarn(id, '/stop'));
  if (!serverUp) {
    result = await dockerStop(id, NO_SERVER_STOP_SECONDS, 'docker');
  } else if (sent) {
    const timeoutMs = opts.timeoutMs ?? STOP_TIMEOUT_SECONDS * 1000;
    const outcome = await waitForExit(id, state.startedAt, timeoutMs);
    if (outcome === 'exited') {
      result = { ok: true, method: 'command' };
    } else if (outcome === 'restarted') {
      result = await dockerStop(id, FALLBACK_STOP_SECONDS, 'command');
    } else {
      console.warn(
        `[Lifecycle:${id}] Server did not exit within ${Math.round(timeoutMs / 1000)}s after /stop; stopping via Docker`,
      );
      result = await dockerStop(id, FALLBACK_STOP_SECONDS, 'docker');
    }
  } else {
    console.warn(`[Lifecycle:${id}] /stop could not be sent; stopping via Docker (SIGTERM)`);
    result = await dockerStop(id, STOP_TIMEOUT_SECONDS, 'docker');
  }

  if (result.ok) {
    // This server's players only; the other servers keep theirs.
    await clearOnlinePlayers(id);
    // Restart the watchdog's grace window: the exit may land well after /stop.
    await dockerService.noteIntentionalStop(id);
    publish('server.stopped', { ...eventPayload(opts, action), method: result.method }, id);
  }
  return result;
}

async function clearExitGuard(id: string): Promise<void> {
  try {
    const server = await getServer(id);
    if (server?.paths?.data)
      fs.rmSync(path.join(server.paths.data, EXIT_GUARD_FILE), { force: true });
  } catch {
    /* the manager may not see this server's data dir; the guard then expires on its own */
  }
}

// Work on the server's files that has to happen while it is still down, right
// before every start through the panel (the access files are brought to the
// form the server reads). A failing hook is logged; the start goes ahead.
type BeforeStartHook = (serverId: string) => Promise<void>;
const beforeStartHooks = new Map<string, BeforeStartHook>();

/** Registers (or replaces) a hook under `name`; see runBeforeStartHooks. */
export function registerBeforeStartHook(name: string, hook: BeforeStartHook): void {
  beforeStartHooks.set(name, hook);
}

async function runBeforeStartHooks(id: string): Promise<void> {
  for (const [name, hook] of beforeStartHooks) {
    try {
      await hook(id);
    } catch (error) {
      console.error(`[Lifecycle:${id}] Before-start step "${name}" failed:`, error);
    }
  }
}

async function startLocked(
  id: string,
  opts: GracefulOptions,
  action: 'start' | 'restart',
): Promise<LifecycleResult> {
  const state = await dockerService.getContainerState(id);
  if (!state) return { ok: false, method: 'docker', error: 'Container not found' };
  if (state.running) return { ok: true, method: 'already_running' };

  await clearExitGuard(id);
  await runBeforeStartHooks(id);
  publish('server.starting', eventPayload(opts, action), id);
  const r = await dockerService.startContainer(id);
  if (!r.success) return { ok: false, method: 'docker', error: r.error };
  publish('server.started', eventPayload(opts, action), id);
  return { ok: true, method: 'docker' };
}

function cancelled(): LifecycleResult {
  return { ok: false, method: 'cancelled', error: 'Cancelled' };
}

function isCancel(error: unknown): boolean {
  return error instanceof LifecycleError && error.phase === 'cancelled';
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Announce (optional), `/stop`, wait for the exit, fall back to `docker stop`. */
export async function stopServerGracefully(
  serverId: string | undefined,
  opts: GracefulOptions,
): Promise<LifecycleResult> {
  if (isDemoMode()) return { ok: true, method: 'command' };
  const id = await resolveServerId(serverId);
  try {
    await runCountdown(id, opts, 'stop');
  } catch (error) {
    if (isCancel(error)) return cancelled();
    throw error;
  }
  return exclusive(id, opts, () => stopLocked(id, opts, 'stop'));
}

export async function startServer(
  serverId: string | undefined,
  opts: GracefulOptions,
): Promise<LifecycleResult> {
  if (isDemoMode()) return { ok: true, method: 'docker' };
  const id = await resolveServerId(serverId);
  return exclusive(id, opts, () => startLocked(id, opts, 'start'));
}

/**
 * Graceful stop followed by a start. A stopped server is simply started, like
 * `docker restart` did before. `method` tells how the old process ended.
 */
export async function restartServerGracefully(
  serverId: string | undefined,
  opts: GracefulOptions,
): Promise<LifecycleResult> {
  if (isDemoMode()) return { ok: true, method: 'command' };
  const id = await resolveServerId(serverId);
  try {
    await runCountdown(id, opts, 'restart');
  } catch (error) {
    if (isCancel(error)) return cancelled();
    throw error;
  }
  return exclusive(id, opts, async () => {
    const stopped = await stopLocked(id, opts, 'restart');
    if (!stopped.ok) return stopped;
    const started = await startLocked(id, opts, 'restart');
    if (!started.ok) {
      return { ok: false, method: stopped.method, error: `Start failed: ${started.error}` };
    }
    return stopped;
  });
}

/**
 * Stop (if running), run fn, start again if it was running before – also when
 * fn throws. Throws LifecycleError if the server cannot be stopped (fn is then
 * not run) or, after fn succeeded, cannot be started again; an error from fn
 * always wins over a failed start.
 */
export async function withServerStopped<T>(
  serverId: string | undefined,
  opts: GracefulOptions,
  fn: () => Promise<T>,
): Promise<T> {
  if (isDemoMode()) return fn();
  const id = await resolveServerId(serverId);
  // Before the countdown as well: nothing is announced for an action that is refused.
  if (opts.rejectIfBusy && isLifecycleBusy(id) && !heldLocks.getStore()?.has(id)) {
    throw new LifecycleBusyError();
  }
  await runCountdown(id, opts, 'stop');
  return exclusive(id, opts, async () => {
    const before = await dockerService.getContainerState(id);
    const wasRunning = before?.running === true;
    if (wasRunning) {
      const stopped = await stopLocked(id, opts, 'stop');
      if (!stopped.ok) {
        throw new LifecycleError(`Could not stop the server: ${stopped.error}`, 'stop');
      }
    }

    let result: T | undefined;
    let failure: { error: unknown } | null = null;
    try {
      result = await fn();
    } catch (error) {
      failure = { error };
    }

    if (wasRunning) {
      const started = await startLocked(id, opts, 'start');
      if (!started.ok) {
        const message = `The server did not start again: ${started.error}`;
        if (failure) console.error(`[Lifecycle:${id}] ${message}`);
        else throw new LifecycleError(message, 'start');
      }
    } else {
      // It was down before and stays down: a crash the watchdog queued
      // before this operation must not start it afterwards.
      await dockerService.noteIntentionalStop(id).catch(() => undefined);
    }
    if (failure) throw failure.error;
    return result as T;
  });
}

/**
 * Stop (if running) and run fn under the server's lock, without starting it
 * again: for work after which the server stays down or is gone (deleting an
 * instance). Throws LifecycleError if the server cannot be stopped; fn is
 * then not run.
 */
export async function stopServerAndRun<T>(
  serverId: string | undefined,
  opts: GracefulOptions,
  fn: () => Promise<T>,
): Promise<T> {
  if (isDemoMode()) return fn();
  const id = await resolveServerId(serverId);
  if (opts.rejectIfBusy && isLifecycleBusy(id) && !heldLocks.getStore()?.has(id)) {
    throw new LifecycleBusyError();
  }
  await runCountdown(id, opts, 'stop');
  return exclusive(id, opts, async () => {
    const before = await dockerService.getContainerState(id);
    if (before?.running) {
      const stopped = await stopLocked(id, opts, 'stop');
      if (!stopped.ok) {
        throw new LifecycleError(`Could not stop the server: ${stopped.error}`, 'stop');
      }
    }
    return fn();
  });
}

/**
 * Runs fn under the server's lock if the server is stopped, so no start
 * through the panel can begin while fn edits files the server reads when it
 * starts. Does not stop or start anything: a running server resolves to
 * { ran: false } without calling fn. A container that does not exist counts
 * as stopped; a Docker error rejects.
 */
export async function runWhileServerStopped<T>(
  serverId: string | undefined,
  opts: Pick<GracefulOptions, 'reason' | 'rejectIfBusy'>,
  fn: () => Promise<T>,
): Promise<{ ran: true; value: T } | { ran: false }> {
  if (isDemoMode()) return { ran: true, value: await fn() };
  const id = await resolveServerId(serverId);
  return exclusive(id, opts, async () => {
    const state = await dockerService.getContainerState(id);
    if (state?.running) return { ran: false } as const;
    return { ran: true, value: await fn() } as const;
  });
}

export const __test__ = { EXIT_GUARD_FILE };
