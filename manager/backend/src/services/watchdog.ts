/**
 * Server Watchdog.
 *
 * Polls every registered server's container and:
 *   - detects an unexpected stop (a crash, i.e. a running→stopped transition
 *     that the panel did NOT initiate) and emits `server.crashed`;
 *   - optionally auto-restarts it with a crash-loop guard, emitting
 *     `server.restarted`, or `server.alert` once the restart budget is spent;
 *   - emits a debounced `server.alert` when container memory crosses a
 *     threshold.
 *
 * All events go through the panel EventBus, so the existing webhook and
 * notification sinks deliver them with no extra wiring.
 *
 * Everything is env-configurable and SAFE by default: monitoring/alerts are on,
 * but auto-restart is OFF unless WATCHDOG_AUTO_RESTART=true (an operator must
 * opt in to the panel power-cycling their server).
 */
import { logger } from '../utils/logger.js';
import { publish } from './eventBus.js';
import { listServers } from './servers.js';
import {
  getStatus,
  getStats,
  startContainer,
  wasRecentlyStoppedIntentionally,
} from './docker.js';
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

interface WatchState {
  wasRunning: boolean | null; // null until the first observation
  restartTimes: number[];     // epoch-ms of recent auto-restarts (windowed)
  lastMemAlertAt: number;
}

const state = new Map<string, WatchState>();
let timer: NodeJS.Timeout | null = null;

function getState(serverId: string): WatchState {
  let s = state.get(serverId);
  if (!s) {
    s = { wasRunning: null, restartTimes: [], lastMemAlertAt: 0 };
    state.set(serverId, s);
  }
  return s;
}

async function tickServer(serverId: string): Promise<void> {
  const s = getState(serverId);

  let running: boolean;
  try {
    running = (await getStatus(serverId)).running;
  } catch {
    return; // transient docker error — try again next tick
  }

  // Crash detection: a running→stopped transition we didn't cause.
  if (s.wasRunning === true && !running) {
    if (wasRecentlyStoppedIntentionally(serverId, INTENTIONAL_GRACE_MS)) {
      // Deliberate stop/restart — not a crash.
      s.wasRunning = running;
      return;
    }

    logger.warn(`[Watchdog] Server ${serverId} stopped unexpectedly (crash)`);
    publish('server.crashed', { serverId, detectedAt: new Date().toISOString() }, serverId);

    if (AUTO_RESTART) {
      const now = Date.now();
      s.restartTimes = s.restartTimes.filter(t => now - t < RESTART_WINDOW_MS);
      if (s.restartTimes.length < MAX_RESTARTS) {
        s.restartTimes.push(now);
        logger.warn(`[Watchdog] Auto-restarting ${serverId} (attempt ${s.restartTimes.length}/${MAX_RESTARTS})`);
        const r = await startContainer(serverId);
        publish(r.success ? 'server.restarted' : 'server.alert', {
          serverId,
          reason: r.success ? 'auto_restart' : 'auto_restart_failed',
          error: r.success ? undefined : r.error,
          attempt: s.restartTimes.length,
        }, serverId);
      } else {
        logger.error(`[Watchdog] ${serverId} exceeded ${MAX_RESTARTS} restarts in window — backing off (crash loop)`);
        publish('server.alert', {
          serverId,
          reason: 'crash_loop',
          message: `Server crashed ${MAX_RESTARTS}+ times within ${Math.round(RESTART_WINDOW_MS / 60000)} min; auto-restart paused.`,
        }, serverId);
      }
    }
  }

  // Memory threshold alert (only while running), debounced per server.
  if (running && MEM_ALERT_PERCENT > 0) {
    try {
      const stats = await getStats(serverId);
      const pct = (stats as { memory_percent?: number }).memory_percent;
      if (typeof pct === 'number' && pct >= MEM_ALERT_PERCENT) {
        const now = Date.now();
        if (now - s.lastMemAlertAt > MEM_ALERT_COOLDOWN_MS) {
          s.lastMemAlertAt = now;
          publish('server.alert', {
            serverId, reason: 'high_memory', memoryPercent: pct, threshold: MEM_ALERT_PERCENT,
          }, serverId);
        }
      }
    } catch { /* stats unavailable — ignore this tick */ }
  }

  s.wasRunning = running;
}

async function tick(): Promise<void> {
  try {
    const servers = await listServers();
    for (const srv of servers) {
      await tickServer(srv.id);
    }
  } catch (err) {
    logger.error('[Watchdog] tick failed:', err);
  }
}

export function startWatchdog(): void {
  if (!ENABLED || isDemoMode()) {
    logger.info(`[Watchdog] disabled (enabled=${ENABLED}, demo=${isDemoMode()})`);
    return;
  }
  if (timer) return;
  logger.info(`[Watchdog] started (poll=${POLL_MS}ms, autoRestart=${AUTO_RESTART}, maxRestarts=${MAX_RESTARTS}/${Math.round(RESTART_WINDOW_MS / 60000)}min, memAlert=${MEM_ALERT_PERCENT}%)`);
  timer = setInterval(() => { void tick(); }, POLL_MS);
  timer.unref?.();
}

export function stopWatchdog(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
