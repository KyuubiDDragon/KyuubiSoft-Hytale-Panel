/**
 * Server Watchdog.
 *
 * Follows Docker's container events and polls every registered server's
 * container to:
 *   - notice a stop the panel did NOT initiate and explain it from the exit
 *     code (see serverExit.ts): a clean `/stop` or a signal is reported as
 *     `server.stopped`, a crash as `server.crashed` with the reason in plain
 *     text, an OOM kill additionally as `server.alert`;
 *   - optionally auto-restart a crash with a crash-loop guard, emitting
 *     `server.restarted`, or `server.alert` once the restart budget is spent.
 *     Exits a restart cannot fix (auth failed, broken mod, …) are never
 *     restarted, and Docker's own restart policy gets the first try;
 *   - emits a debounced `server.alert` when container memory crosses a
 *     threshold.
 *
 * The events matter because Docker's restart policy brings a crashed
 * container back within milliseconds, long before the next poll; polling
 * alone would never see the crash (it still catches it via a changed start
 * time, just without the exit code).
 *
 * All events go through the panel EventBus, so the existing webhook and
 * notification sinks deliver them with no extra wiring.
 *
 * Everything is env-configurable and SAFE by default: monitoring/alerts are on,
 * but auto-restart is OFF unless WATCHDOG_AUTO_RESTART=true (an operator must
 * opt in to the panel power-cycling their server).
 */
import fs from 'fs';
import { logger } from '../utils/logger.js';
import { publish } from './eventBus.js';
import { listServers, type ServerInstance } from './servers.js';
import { findLaggingWorld, getWorldTicks, startTpsState, tpsRatio } from './tpsState.js';
import {
  getContainerState,
  getDockerInstance,
  getStats,
  wasRecentlyStoppedIntentionally,
} from './docker.js';
import { getActiveOperation, startServer } from './serverLifecycle.js';
import { classifyExit, isRestartable, type ExitInfo } from './serverExit.js';
import { isDemoMode } from './demoData.js';

function envBool(name: string, def: boolean): boolean {
  const v = process.env[name];
  if (v === undefined) return def;
  return v === 'true' || v === '1';
}
function envInt(name: string, def: number): number {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v >= 0 ? v : def;
}

const ENABLED = envBool('WATCHDOG_ENABLED', true);
const AUTO_RESTART = envBool('WATCHDOG_AUTO_RESTART', false);
const POLL_MS = envInt('WATCHDOG_POLL_MS', 15_000);
const MAX_RESTARTS = envInt('WATCHDOG_MAX_RESTARTS', 3);
const RESTART_WINDOW_MS = envInt('WATCHDOG_RESTART_WINDOW_MS', 10 * 60_000);
const INTENTIONAL_GRACE_MS = envInt('WATCHDOG_INTENTIONAL_STOP_GRACE_MS', 60_000);
const MEM_ALERT_PERCENT = envInt('WATCHDOG_MEM_ALERT_PERCENT', 95);
const MEM_ALERT_COOLDOWN_MS = envInt('WATCHDOG_MEM_ALERT_COOLDOWN_MS', 5 * 60_000);
// Low-TPS (server lag) alert. TPS arrives per world from the plugin's
// server_tick events. The threshold is relative to each world's target rate
// (Hytale: 30 TPS): alert when a world runs below this percentage.
// WATCHDOG_TPS_ALERT (absolute TPS) still works and wins when set; 0 = off.
const TPS_ALERT_PERCENT = envInt('WATCHDOG_TPS_ALERT_PERCENT', 75);
// A blank value (e.g. an uncommented "WATCHDOG_TPS_ALERT=") counts as unset.
const TPS_ALERT_ABSOLUTE = process.env.WATCHDOG_TPS_ALERT?.trim()
  ? envInt('WATCHDOG_TPS_ALERT', 0)
  : null;
const TPS_ALERT_ENABLED =
  TPS_ALERT_ABSOLUTE !== null ? TPS_ALERT_ABSOLUTE > 0 : TPS_ALERT_PERCENT > 0;
const TPS_ALERT_COOLDOWN_MS = envInt('WATCHDOG_TPS_ALERT_COOLDOWN_MS', 5 * 60_000);
const TPS_STALE_MS = envInt('WATCHDOG_TPS_STALE_MS', 60_000); // ignore TPS readings older than this
// Low-disk alert on each server's data volume.
const DISK_ALERT_MIN_GB = envInt('WATCHDOG_DISK_ALERT_MIN_GB', 2); // alert when free < this; 0 = off
const DISK_ALERT_COOLDOWN_MS = envInt('WATCHDOG_DISK_ALERT_COOLDOWN_MS', 30 * 60_000);
// Docker emits `oom` just before the `die` of the killed run.
const OOM_EVENT_WINDOW_MS = 10_000;
const EVENTS_RETRY_MS = 30_000;

interface WatchState {
  wasRunning: boolean | null; // null until the first observation
  startedAt: string | null; // start time of the run last seen running
  restartTimes: number[]; // epoch-ms of recent auto-restarts (windowed)
  // A restartable crash waiting for the next poll: Docker's restart policy
  // gets the first try, the watchdog only starts what is still down then.
  pendingRestart: ExitInfo | null;
  lastCrash: { reason: string; at: number } | null; // de-duplicates Docker's retries
  lastOomAt: number;
  lastMemAlertAt: number;
  lastTpsAlertAt: number;
  lastDiskAlertAt: number;
}

const state = new Map<string, WatchState>();
let timer: NodeJS.Timeout | null = null;

function getState(serverId: string): WatchState {
  let s = state.get(serverId);
  if (!s) {
    s = {
      wasRunning: null,
      startedAt: null,
      restartTimes: [],
      pendingRestart: null,
      lastCrash: null,
      lastOomAt: 0,
      lastMemAlertAt: 0,
      lastTpsAlertAt: 0,
      lastDiskAlertAt: 0,
    };
    state.set(serverId, s);
  }
  return s;
}

// A stop the panel caused itself (UI, scheduler, update, restore, console /stop).
async function isDeliberateStop(serverId: string): Promise<boolean> {
  return (
    getActiveOperation(serverId) !== null ||
    (await wasRecentlyStoppedIntentionally(serverId, INTENTIONAL_GRACE_MS))
  );
}

// Report an exit the panel did not cause, and queue a restart if one can help.
function handleExit(serverId: string, s: WatchState, info: ExitInfo): void {
  const details = {
    serverId,
    exitCode: info.code,
    reason: info.reason,
    message: info.message,
    hint: info.hint,
  };
  s.pendingRestart = null;

  if (info.kind === 'clean' || info.kind === 'signal' || info.kind === 'update') {
    // e.g. /stop typed in game, or `docker stop` outside the panel: no crash.
    logger.info(`[Watchdog] Server ${serverId} stopped: ${info.message} (exit ${info.code})`);
    if (info.kind !== 'update')
      publish('server.stopped', { ...details, initiator: 'server' }, serverId);
    return;
  }

  // Docker's restart policy retries an unrecoverable failure a few times in a
  // row; one notification per failure is enough.
  const now = Date.now();
  const repeat =
    s.lastCrash !== null &&
    s.lastCrash.reason === info.reason &&
    now - s.lastCrash.at < RESTART_WINDOW_MS;
  s.lastCrash = { reason: info.reason, at: now };

  if (!repeat || info.kind !== 'unrecoverable') {
    logger.warn(`[Watchdog] Server ${serverId} crashed: ${info.message} (exit ${info.code})`);
    publish(
      'server.crashed',
      { ...details, restartable: isRestartable(info), detectedAt: new Date(now).toISOString() },
      serverId,
    );
    if (info.reason === 'out_of_memory') {
      publish('server.alert', { ...details, reason: 'out_of_memory' }, serverId);
    }
  }

  if (!AUTO_RESTART) return;
  if (isRestartable(info)) {
    s.pendingRestart = info;
  } else if (!repeat) {
    logger.warn(
      `[Watchdog] Not auto-restarting ${serverId}: a restart cannot fix "${info.reason}"`,
    );
  }
}

// Restart a queued crash, unless Docker's restart policy already did.
async function maybeAutoRestart(serverId: string, s: WatchState, running: boolean): Promise<void> {
  const crash = s.pendingRestart;
  if (!crash) return;
  s.pendingRestart = null;
  if (running) return;
  // The panel took the server over since the crash (a stop clicked on the
  // crashed server, a restore): leave it the way the panel wants it.
  if (await isDeliberateStop(serverId)) {
    logger.info(
      `[Watchdog] Not auto-restarting ${serverId} after "${crash.reason}": the panel stopped or took over the server meanwhile`,
    );
    return;
  }

  const now = Date.now();
  s.restartTimes = s.restartTimes.filter((t) => now - t < RESTART_WINDOW_MS);
  if (s.restartTimes.length >= MAX_RESTARTS) {
    logger.error(
      `[Watchdog] ${serverId} exceeded ${MAX_RESTARTS} restarts in window — backing off (crash loop)`,
    );
    publish(
      'server.alert',
      {
        serverId,
        reason: 'crash_loop',
        message: `Server crashed ${MAX_RESTARTS}+ times within ${Math.round(RESTART_WINDOW_MS / 60000)} min; auto-restart paused.`,
      },
      serverId,
    );
    return;
  }
  s.restartTimes.push(now);
  logger.warn(
    `[Watchdog] Auto-restarting ${serverId} after "${crash.reason}" (attempt ${s.restartTimes.length}/${MAX_RESTARTS})`,
  );
  const r = await startServer(serverId, { reason: 'watchdog', actor: 'watchdog' });
  publish(
    r.ok ? 'server.restarted' : 'server.alert',
    {
      serverId,
      reason: r.ok ? 'auto_restart' : 'auto_restart_failed',
      crashReason: crash.reason,
      error: r.ok ? undefined : r.error,
      attempt: s.restartTimes.length,
    },
    serverId,
  );
}

async function tickServer(srv: ServerInstance): Promise<void> {
  const serverId = srv.id;
  const s = getState(serverId);

  let state: Awaited<ReturnType<typeof getContainerState>>;
  try {
    state = await getContainerState(serverId);
  } catch {
    return; // transient docker error — try again next tick
  }
  if (!state) return; // container gone (deleted/recreated): nothing to watch
  if (state.status === 'restarting') return; // Docker's restart policy is between attempts
  const running = state.running;

  // A running→stopped transition we didn't cause (the event stream may have
  // reported it already, which resets wasRunning).
  if (s.wasRunning === true && !running) {
    if (!(await isDeliberateStop(serverId))) {
      handleExit(serverId, s, classifyExit(state.exitCode, state.oomKilled));
    }
  } else if (
    s.wasRunning === true &&
    running &&
    s.startedAt !== null &&
    state.startedAt !== s.startedAt &&
    !(await isDeliberateStop(serverId))
  ) {
    // Stopped and brought back by Docker between two polls without an event
    // reaching us; Docker has reset the exit code by now.
    handleExit(serverId, s, {
      code: -1,
      reason: 'restarted_by_docker',
      kind: 'crash',
      message: 'The server stopped unexpectedly and Docker restarted it.',
      hint: 'See the console log for the cause.',
    });
  }
  await maybeAutoRestart(serverId, s, running);
  s.startedAt = running ? state.startedAt : null;

  // Memory threshold alert (only while running), debounced per server.
  if (running && MEM_ALERT_PERCENT > 0) {
    try {
      const stats = await getStats(serverId);
      const pct = (stats as { memory_percent?: number }).memory_percent;
      if (typeof pct === 'number' && pct >= MEM_ALERT_PERCENT) {
        const now = Date.now();
        if (now - s.lastMemAlertAt > MEM_ALERT_COOLDOWN_MS) {
          s.lastMemAlertAt = now;
          publish(
            'server.alert',
            {
              serverId,
              reason: 'high_memory',
              memoryPercent: pct,
              threshold: MEM_ALERT_PERCENT,
            },
            serverId,
          );
        }
      }
    } catch {
      /* stats unavailable — ignore this tick */
    }
  }

  // Low-TPS (lag) alert, only while running and only on fresh readings.
  if (running && TPS_ALERT_ENABLED) {
    const lagging = findLaggingWorld(getWorldTicks(serverId, TPS_STALE_MS), {
      absolute: TPS_ALERT_ABSOLUTE,
      percent: TPS_ALERT_PERCENT,
    });
    if (lagging) {
      const now = Date.now();
      if (now - s.lastTpsAlertAt > TPS_ALERT_COOLDOWN_MS) {
        s.lastTpsAlertAt = now;
        const { tick } = lagging;
        publish(
          'server.alert',
          {
            serverId,
            reason: 'low_tps',
            world: tick.world || undefined,
            tps: Math.round(lagging.tps * 100) / 100,
            targetTps: tick.targetTps,
            percentOfTarget: Math.round(
              tpsRatio({ tps: lagging.tps, targetTps: tick.targetTps }) * 100,
            ),
            mspt: tick.mspt,
            threshold: Math.round(lagging.limit * 100) / 100,
            thresholdPercent: TPS_ALERT_ABSOLUTE !== null ? undefined : TPS_ALERT_PERCENT,
          },
          serverId,
        );
      }
    }
  }

  // Low-disk alert on the server's data volume, debounced.
  if (DISK_ALERT_MIN_GB > 0) {
    try {
      const st = fs.statfsSync(srv.paths.data);
      const freeGb = (st.bavail * st.bsize) / 1024 ** 3;
      if (freeGb < DISK_ALERT_MIN_GB) {
        const now = Date.now();
        if (now - s.lastDiskAlertAt > DISK_ALERT_COOLDOWN_MS) {
          s.lastDiskAlertAt = now;
          publish(
            'server.alert',
            {
              serverId,
              reason: 'low_disk',
              freeGb: Math.round(freeGb * 100) / 100,
              threshold: DISK_ALERT_MIN_GB,
              path: srv.paths.data,
            },
            serverId,
          );
        }
      }
    } catch {
      /* statfs unsupported on this fs — skip */
    }
  }

  s.wasRunning = running;
}

async function tick(): Promise<void> {
  try {
    const servers = await listServers();
    for (const srv of servers) {
      await tickServer(srv);
    }
  } catch (err) {
    logger.error('[Watchdog] tick failed:', err);
  }
}

// ---------- Docker events (exit codes the poll would miss) ----------

interface DockerEvent {
  Action?: string;
  status?: string; // older API versions
  Actor?: { Attributes?: Record<string, string> };
}

async function onDockerEvent(evt: DockerEvent): Promise<void> {
  const action = evt.Action ?? evt.status;
  const name = evt.Actor?.Attributes?.name;
  if (!name || (action !== 'die' && action !== 'oom')) return;
  const srv = (await listServers()).find((x) => x.containerName === name);
  if (!srv) return;
  const s = getState(srv.id);
  if (action === 'oom') {
    s.lastOomAt = Date.now();
    return;
  }

  // This run is over; the poll must not report it a second time.
  s.wasRunning = false;
  s.startedAt = null;
  if (await isDeliberateStop(srv.id)) return;

  const raw = evt.Actor?.Attributes?.exitCode;
  const code = raw !== undefined && /^\d+$/.test(raw) ? Number(raw) : -1;
  let oom = Date.now() - s.lastOomAt < OOM_EVENT_WINDOW_MS;
  if (!oom && code === 137) {
    oom = (await getContainerState(srv.id).catch(() => null))?.oomKilled === true;
  }
  handleExit(srv.id, s, classifyExit(code, oom));
}

let eventStream: NodeJS.ReadableStream | null = null;

async function watchDockerEvents(): Promise<void> {
  if (eventStream || !timer) return;
  const retry = (): void => {
    const t = setTimeout(() => void watchDockerEvents(), EVENTS_RETRY_MS);
    t.unref?.();
  };
  let stream: NodeJS.ReadableStream;
  try {
    stream = await getDockerInstance().getEvents({
      filters: { type: ['container'], event: ['die', 'oom'] },
    });
  } catch (err) {
    logger.warn('[Watchdog] Docker events unavailable, relying on polling:', err);
    retry();
    return;
  }
  eventStream = stream;
  let buffered = '';
  stream.on('data', (chunk: Buffer | string) => {
    buffered += chunk.toString();
    let nl: number;
    while ((nl = buffered.indexOf('\n')) >= 0) {
      const line = buffered.slice(0, nl).trim();
      buffered = buffered.slice(nl + 1);
      if (!line) continue;
      try {
        void onDockerEvent(JSON.parse(line) as DockerEvent).catch((err) =>
          logger.error('[Watchdog] event handling failed:', err),
        );
      } catch {
        /* not JSON — ignore the line */
      }
    }
  });
  const reconnect = (): void => {
    if (eventStream !== stream) return;
    eventStream = null;
    if (timer) retry();
  };
  stream.on('end', reconnect);
  stream.on('close', reconnect);
  stream.on('error', reconnect);
}

export function startWatchdog(): void {
  if (!ENABLED || isDemoMode()) {
    logger.info(`[Watchdog] disabled (enabled=${ENABLED}, demo=${isDemoMode()})`);
    return;
  }
  if (timer) return;
  startTpsState();
  const tpsAlert = !TPS_ALERT_ENABLED
    ? 'off'
    : TPS_ALERT_ABSOLUTE !== null
      ? `${TPS_ALERT_ABSOLUTE}`
      : `${TPS_ALERT_PERCENT}%`;
  logger.info(
    `[Watchdog] started (poll=${POLL_MS}ms, autoRestart=${AUTO_RESTART}, maxRestarts=${MAX_RESTARTS}/${Math.round(RESTART_WINDOW_MS / 60000)}min, memAlert=${MEM_ALERT_PERCENT}%, tpsAlert=${tpsAlert}, diskAlert=${DISK_ALERT_MIN_GB}GB)`,
  );
  timer = setInterval(() => {
    void tick();
  }, POLL_MS);
  timer.unref?.();
  void watchDockerEvents();
}

export function stopWatchdog(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
  const stream = eventStream as (NodeJS.ReadableStream & { destroy?: () => void }) | null;
  eventStream = null;
  stream?.destroy?.();
}

// Exposed for unit tests so they can drive a poll cycle without the timer.
export const __test__ = {
  tick,
  onDockerEvent,
};
