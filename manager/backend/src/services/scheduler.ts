/**
 * Scheduler service.
 *
 * Multi-server: the scheduler keeps one ScheduleConfig per registered server
 * id (`schedulerConfig: Record<serverId, ScheduleConfig>`) and dispatches all
 * tasks against the matching server. Timers run centrally inside this
 * module — there's no need for per-server cron daemons.
 *
 * Backward-compat: callers that omit `serverId` resolve to the default
 * server from the registry (services/servers.ts). Each server keeps its
 * manager-config.json in its own data directory; for the compose server
 * that is the legacy single-server location, so existing installs migrate
 * transparently.
 */
import fs from 'fs';
import path from 'path';
import { createBackup, listBackups, deleteBackup, isAutomaticBackupId } from './backup.js';
import * as dockerService from './docker.js';
import { validateCommand, stripControlChars, toCommandText } from '../utils/sanitize.js';
import {
  authorizeCommand,
  authorizeStoredCommand,
  reportSkippedCommand,
  storedCommandBlockedReason,
  type CommandActor,
  type StoredCommandBlock,
} from './commandPolicy.js';
import {
  ensureLoaded,
  listServers,
  onServerAdded,
  onServerDeleted,
  resolveServerId,
  resolveServerIdSync,
} from './servers.js';
import { getServerContext } from './serverContext.js';
import { readRegularFile, replaceFileContent } from '../utils/noFollowFs.js';
import { MAX_SERVER_FILE_BYTES } from '../utils/serverFiles.js';
import {
  LifecycleError,
  restartServerGracefully,
  withServerStopped,
  type GracefulOptions,
} from './serverLifecycle.js';
import { getOnlinePlayers } from './players.js';
import {
  createEventAction,
  deleteEventAction,
  getEventAction,
  updateEventAction,
} from './eventActions.js';

// Scheduler configuration
interface ScheduleConfig {
  backups: {
    enabled: boolean;
    schedule: string; // cron-like: "03:00" for 3 AM daily
    retentionDays: number;
    beforeRestart: boolean;
  };
  announcements: {
    enabled: boolean;
    // Posted in chat when a player joins ({player} = name), by an Event Action
    // rule kept in sync on save (see syncWelcomeAction).
    welcome: string;
    welcomeActionId?: string;
    scheduled: ScheduledAnnouncement[];
  };
  scheduledRestarts: {
    enabled: boolean;
    times: string[]; // Array of times like ["03:00", "15:00"]
    warningMinutes: number[]; // Countdown announcements before the restart, e.g. [30, 15, 5, 1]
    warningMessage: string; // Countdown text: {time} ("5 minutes", "30 seconds"), {minutes}
    restartMessage: string; // Announced right before /stop
    createBackup: boolean; // Back up while the server is stopped for the restart
    onlyWhenEmpty: boolean; // Restart only when no player is online, else skip this slot
  };
  quickCommands: QuickCommand[];
  scheduledCommands: ScheduledCommand[];
}

interface ScheduledAnnouncement {
  id: string;
  message: string;
  intervalMinutes: number;
  enabled: boolean;
}

/**
 * A console command run automatically on a schedule. `command` is validated
 * against the same console whitelist as manual execution before every run, so
 * a persisted config can't be used to smuggle an arbitrary shell command.
 *   - mode 'daily'    → runs at each "HH:MM" in `times` every day
 *   - mode 'interval' → runs every `intervalMinutes` minutes
 *
 * `createdBy` is the panel user who last authorized the entry. Every run is
 * re-checked against that user's current console tier (see commandPolicy);
 * entries saved before it was recorded only run commands without admin tier.
 */
interface ScheduledCommand {
  id: string;
  name: string;
  command: string;
  enabled: boolean;
  mode: 'daily' | 'interval';
  times: string[];
  intervalMinutes: number;
  createdBy?: string;
}

interface QuickCommand {
  id: string;
  name: string;
  command: string;
  icon: string;
  category: string;
}

// Default configuration
const DEFAULT_CONFIG: ScheduleConfig = {
  backups: {
    enabled: false,
    schedule: '03:00',
    retentionDays: 7,
    beforeRestart: true,
  },
  announcements: {
    enabled: false,
    welcome: '',
    scheduled: [],
  },
  scheduledRestarts: {
    enabled: false,
    times: [],
    warningMinutes: [30, 15, 5, 1],
    warningMessage: 'Server restart in {time}!',
    restartMessage: 'Server is restarting now!',
    createBackup: true,
    onlyWhenEmpty: false,
  },
  // Hytale 0.7 commands; all of them need only console.execute.
  quickCommands: [
    {
      id: '1',
      name: 'Save World',
      command: '/world save --all --confirm',
      icon: 'save',
      category: 'server',
    },
    { id: '2', name: 'List Players', command: '/who', icon: 'users', category: 'players' },
    { id: '3', name: 'Set Day', command: '/time set day', icon: 'sun', category: 'world' },
    { id: '4', name: 'Set Night', command: '/time set night', icon: 'moon', category: 'world' },
    { id: '5', name: 'Reset Weather', command: '/weather reset', icon: 'cloud', category: 'world' },
    {
      id: '6',
      name: 'Rain',
      command: '/weather set Zone1_Rain',
      icon: 'cloud-rain',
      category: 'world',
    },
    {
      id: '7',
      name: 'Memory Usage',
      command: '/server stats memory',
      icon: 'cpu',
      category: 'server',
    },
    {
      id: '8',
      name: 'World Performance',
      command: '/world perf',
      icon: 'activity',
      category: 'server',
    },
  ],
  scheduledCommands: [],
};

// Defaults of panel versions before Hytale 0.7 whose commands no longer exist
// (/save, /list, /weather rain) or do something else (/weather clear only
// resets the forced weather). A stored entry that still equals one of them
// was never edited and gets the 0.7 default with the same id.
const LEGACY_QUICK_COMMANDS: QuickCommand[] = [
  { id: '1', name: 'Save World', command: '/save', icon: 'save', category: 'server' },
  { id: '2', name: 'List Players', command: '/list', icon: 'users', category: 'players' },
  { id: '5', name: 'Clear Weather', command: '/weather clear', icon: 'cloud', category: 'world' },
  { id: '6', name: 'Rain', command: '/weather rain', icon: 'cloud-rain', category: 'world' },
];

function sameQuickCommand(a: QuickCommand, b: QuickCommand): boolean {
  return (
    a.id === b.id &&
    a.name === b.name &&
    a.command === b.command &&
    a.icon === b.icon &&
    a.category === b.category
  );
}

/**
 * Replace unedited pre-0.7 default quick commands with their 0.7 defaults.
 * Entries the user changed, added or removed are left as they are.
 */
export function migrateQuickCommands(stored: QuickCommand[]): {
  quickCommands: QuickCommand[];
  replaced: string[];
} {
  const replaced: string[] = [];
  const quickCommands = stored.map((entry) => {
    const legacy = LEGACY_QUICK_COMMANDS.find((old) => sameQuickCommand(old, entry));
    const current = legacy && DEFAULT_CONFIG.quickCommands.find((c) => c.id === legacy.id);
    if (!current) return entry;
    replaced.push(`${entry.command} -> ${current.command}`);
    return { ...current };
  });
  return { quickCommands, replaced };
}

// Per-server configuration cache (keyed by serverId).
const schedulerConfig: Record<string, ScheduleConfig> = {};

// Per-server timer state.
interface SchedulerTimers {
  backupTimer: NodeJS.Timeout | null;
  announcementTimers: Map<string, NodeJS.Timeout>;
  restartTimers: Map<string, NodeJS.Timeout>;
  // Running restart countdown; aborting it leaves the server untouched.
  restartCountdown: AbortController | null;
  // Epoch-ms of the restart slot that last ran, was skipped or cancelled.
  lastRestartSlot: number;
  pendingRestart: { time: string; scheduledAt: Date } | null;
  // One timer per scheduled command id. Daily-mode commands store a setTimeout
  // (re-armed on fire); interval-mode commands store a setInterval.
  commandTimers: Map<string, NodeJS.Timeout>;
  // Last successful run per command id (epoch-ms), in-memory only.
  commandLastRun: Map<string, number>;
}
const timersByServer: Record<string, SchedulerTimers> = {};

function emptyTimers(): SchedulerTimers {
  return {
    backupTimer: null,
    announcementTimers: new Map(),
    restartTimers: new Map(),
    restartCountdown: null,
    lastRestartSlot: 0,
    pendingRestart: null,
    commandTimers: new Map(),
    commandLastRun: new Map(),
  };
}

// Deep merge helper for nested objects
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function deepMerge(target: any, source: any): any {
  const result = { ...target };

  for (const key in source) {
    if (Object.prototype.hasOwnProperty.call(source, key)) {
      const sourceValue = source[key];
      const targetValue = target[key];

      if (
        sourceValue !== null &&
        typeof sourceValue === 'object' &&
        !Array.isArray(sourceValue) &&
        targetValue !== null &&
        typeof targetValue === 'object' &&
        !Array.isArray(targetValue)
      ) {
        result[key] = deepMerge(targetValue, sourceValue);
      } else {
        result[key] = sourceValue;
      }
    }
  }

  return result;
}

/**
 * The on-disk config file of a server: `manager-config.json` in its data
 * directory (for the compose server that is the legacy location).
 */
async function getConfigFilePath(serverId: string): Promise<string> {
  const { paths } = await getServerContext(serverId);
  return path.join(paths.data, 'manager-config.json');
}

// The data folder belongs to the game server, which can put links there: the
// file is only read when it is a regular file in that folder, and replaced
// (fresh temporary file, then rename) instead of written through a link.
async function writeConfigFile(filePath: string, cfg: ScheduleConfig): Promise<void> {
  await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
  await replaceFileContent(filePath, JSON.stringify(cfg, null, 2), [path.dirname(filePath)]);
}

/** The file's content, or null when it does not exist. */
async function readConfigFile(filePath: string): Promise<string | null> {
  try {
    const content = await readRegularFile(filePath, [path.dirname(filePath)], {
      maxBytes: MAX_SERVER_FILE_BYTES,
    });
    return content.toString('utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

/**
 * Load configuration for a single server.
 */
export async function loadConfig(serverId?: string): Promise<ScheduleConfig> {
  const id = await resolveServerId(serverId);
  const filePath = await getConfigFilePath(id);
  let cfg: ScheduleConfig = { ...DEFAULT_CONFIG };
  try {
    const data = await readConfigFile(filePath);
    if (data !== null) {
      const loaded = JSON.parse(data);
      cfg = deepMerge(DEFAULT_CONFIG, carryOverRestartBackup(loaded));
      // The file sits in the server's data dir; its restart plan gets the same
      // checks as one saved through the API.
      const plan = normalizeRestartPlan(cfg.scheduledRestarts);
      const storedTimes = (cfg.scheduledRestarts as { times?: unknown } | null)?.times;
      // Order and duplicates alone are not worth a warning.
      const comparable = Array.isArray(storedTimes)
        ? [...new Set(storedTimes)].sort()
        : storedTimes;
      if (JSON.stringify(plan.times) !== JSON.stringify(comparable)) {
        console.warn(
          `[Scheduler:${id}] Restart times ${JSON.stringify(storedTimes)?.slice(0, 200)} ` +
            `adjusted to ${JSON.stringify(plan.times)} (strict "HH:MM", at most ` +
            `${MAX_RESTART_TIMES}, at least ${MIN_RESTART_GAP_MINUTES} minutes apart)`,
        );
      }
      cfg = { ...cfg, scheduledRestarts: plan };
      if (Array.isArray(cfg.quickCommands)) {
        const migrated = migrateQuickCommands(cfg.quickCommands);
        if (migrated.replaced.length > 0) {
          console.log(
            `[Scheduler:${id}] Quick commands updated to Hytale 0.7: ${migrated.replaced.join(', ')}`,
          );
          cfg = { ...cfg, quickCommands: migrated.quickCommands };
        }
      }
      console.log(`[Scheduler:${id}] Config loaded from file:`, filePath);
    } else {
      console.log(`[Scheduler:${id}] No config file found, using defaults`);
    }
  } catch (error) {
    console.error(`[Scheduler:${id}] Failed to load config:`, error);
  }
  schedulerConfig[id] = cfg;
  return cfg;
}

/**
 * Save configuration for a single server (default if omitted). Resolves once
 * the server's file is written and its timers run on the new config; false
 * when the file could not be written, the previous config then stays active.
 */
export function saveConfig(cfg: Partial<ScheduleConfig>, serverId?: string): Promise<boolean> {
  return applyConfig(cfg, resolveServerIdSync(serverId));
}

// Saves of one server run one after another, each on the last saved config.
const saveQueues = new Map<string, Promise<unknown>>();

function queueSave<T>(id: string, task: () => Promise<T>): Promise<T> {
  const run = (saveQueues.get(id) ?? Promise.resolve()).then(task, task);
  const settled = run.catch(() => undefined);
  saveQueues.set(id, settled);
  void settled.then(() => {
    if (saveQueues.get(id) === settled) saveQueues.delete(id);
  });
  return run;
}

/**
 * `change` may be computed from the config current at the time of the save;
 * returning null saves nothing (and counts as success). A server whose config
 * was not loaded yet is loaded first, never replaced by the defaults.
 */
function applyConfig(
  change: Partial<ScheduleConfig> | ((current: ScheduleConfig) => Partial<ScheduleConfig> | null),
  id: string,
): Promise<boolean> {
  return queueSave(id, async () => {
    try {
      const current = schedulerConfig[id] ?? (await loadConfig(id));
      const cfg = typeof change === 'function' ? change(current) : change;
      if (cfg) await writeMergedConfig(id, current, cfg);
      return true;
    } catch (error) {
      console.error(`[Scheduler:${id}] Failed to save config:`, error);
      return false;
    }
  });
}

async function writeMergedConfig(
  id: string,
  current: ScheduleConfig,
  cfg: Partial<ScheduleConfig>,
): Promise<void> {
  // Resolved first: a server that does not exist gets no welcome rule.
  const filePath = await getConfigFilePath(id);
  // The welcome rule id is managed here, never taken from a client.
  const incoming = cfg.announcements
    ? { ...cfg, announcements: { ...cfg.announcements, welcomeActionId: undefined } }
    : cfg;
  let merged: ScheduleConfig = deepMerge(current, incoming);
  merged = { ...merged, scheduledRestarts: normalizeRestartPlan(merged.scheduledRestarts) };
  let createdRuleId: string | undefined;
  if (cfg.announcements) {
    const previousRuleId = current.announcements?.welcomeActionId;
    const welcomeActionId = syncWelcomeAction(id, {
      ...merged,
      announcements: { ...merged.announcements, welcomeActionId: previousRuleId },
    });
    if (welcomeActionId && welcomeActionId !== previousRuleId) createdRuleId = welcomeActionId;
    merged = { ...merged, announcements: { ...merged.announcements, welcomeActionId } };
  }
  try {
    await writeConfigFile(filePath, merged);
  } catch (err) {
    // No saved config would name the new rule; a retry creates it again.
    if (createdRuleId) deleteEventAction(createdRuleId);
    throw err;
  }
  console.log(`[Scheduler:${id}] Config saved to file:`, filePath);
  schedulerConfig[id] = merged;
  stopSchedulersForServer(id);
  startSchedulersForServer(id);
}

/**
 * Get configuration for a specific server (default if omitted).
 */
export function getConfig(serverId?: string): ScheduleConfig {
  return schedulerConfig[resolveServerIdSync(serverId)] ?? { ...DEFAULT_CONFIG };
}

// Calculate next backup time for a server
function getNextBackupTime(serverId: string): Date | null {
  const cfg = schedulerConfig[serverId];
  if (!cfg || !cfg.backups.enabled || !cfg.backups.schedule) {
    return null;
  }

  const [hours, minutes] = cfg.backups.schedule.split(':').map(Number);
  const now = new Date();
  const next = new Date(now);
  next.setHours(hours, minutes, 0, 0);

  if (next <= now) {
    next.setDate(next.getDate() + 1);
  }

  return next;
}

// Run automatic backup for a server
async function runAutoBackup(serverId: string): Promise<void> {
  console.log(`[Scheduler:${serverId}] Running automatic backup...`);

  const result = await createBackup({ kind: 'auto', label: 'daily' }, serverId);

  if (result.success) {
    console.log(`[Scheduler:${serverId}] Backup created: ${result.backup?.filename}`);
    await cleanOldBackups(serverId);
  } else {
    console.error(`[Scheduler:${serverId}] Backup failed:`, result.error);
  }
}

// Clean old backups based on retention
async function cleanOldBackups(serverId: string): Promise<void> {
  const cfg = schedulerConfig[serverId];
  if (!cfg) return;
  const backups = await listBackups(serverId);
  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - cfg.backups.retentionDays);

  let deleted = 0;
  for (const backup of backups) {
    // Exact name prefix only: a manual backup called e.g. "autumn" is never pruned.
    if (isAutomaticBackupId(backup.id) && new Date(backup.created_at) < cutoffDate) {
      const result = await deleteBackup(backup.id, serverId);
      if (result.success) deleted++;
    }
  }

  if (deleted > 0) {
    console.log(`[Scheduler:${serverId}] Cleaned ${deleted} old backup(s)`);
  }
}

// Send announcement to a specific server
async function sendAnnouncement(message: string, serverId: string): Promise<void> {
  // One line of plain text: no extra console commands, nothing the server's
  // command parser would reject.
  const text = toCommandText(message, 500);
  if (!text) return;

  try {
    await dockerService.execCommand(`/broadcast ${text}`, serverId, { actor: 'scheduler' });
    console.log(`[Scheduler:${serverId}] Sent announcement: ${text}`);
  } catch (error) {
    console.error(`[Scheduler:${serverId}] Failed to send announcement:`, error);
  }
}

// Calculate next restart time. Slots up to `notBeforeMs` (the one that just
// ran, was skipped or cancelled) are not offered again.
function getNextRestartTime(
  serverId: string,
  notBeforeMs = 0,
): { time: string; date: Date } | null {
  const cfg = schedulerConfig[serverId];
  if (!cfg || !cfg.scheduledRestarts.enabled || cfg.scheduledRestarts.times.length === 0) {
    return null;
  }

  const now = new Date();
  const earliest = Math.max(now.getTime(), notBeforeMs);
  let nearestRestart: { time: string; date: Date } | null = null;

  for (const timeStr of cfg.scheduledRestarts.times) {
    // Normalized on load and save; anything else would plan an invalid date.
    if (typeof timeStr !== 'string' || !DAILY_TIME.test(timeStr)) continue;
    const [hours, minutes] = timeStr.split(':').map(Number);
    const restartDate = new Date(now);
    restartDate.setHours(hours, minutes, 0, 0);

    if (restartDate.getTime() <= earliest) {
      restartDate.setDate(restartDate.getDate() + 1);
    }

    if (!nearestRestart || restartDate < nearestRestart.date) {
      nearestRestart = { time: timeStr, date: restartDate };
    }
  }

  return nearestRestart;
}

// The countdown runs from the earliest warning; a restart planned without
// warnings (or only when empty) fires at the restart time itself.
function countdownMsFor(cfg: ScheduleConfig): number {
  const plan = cfg.scheduledRestarts;
  if (plan.onlyWhenEmpty) return 0;
  const minutes = (plan.warningMinutes ?? []).filter((m) => Number.isFinite(m) && m > 0);
  return minutes.length ? Math.max(...minutes) * 60_000 : 0;
}

// Abort reasons of a running countdown: a cancelled restart is skipped, a
// rescheduled one (config saved meanwhile) is planned again from the new config.
const CANCELLED = 'cancel';
const RESCHEDULED = 'reschedule';

/**
 * The scheduled restart: countdown in game (/notify, /eventtitle in the last
 * minute, /world save shortly before), then /stop, wait for the exit and start
 * again – all through the lifecycle service, so the worlds are saved and no
 * update or restore runs at the same time. The optional backup is taken while
 * the server is stopped, so it is consistent.
 */
async function executeScheduledRestart(serverId: string, restartAt: Date): Promise<void> {
  const cfg = schedulerConfig[serverId];
  const timers = timersByServer[serverId];
  if (!cfg || !timers) return;
  const plan = cfg.scheduledRestarts;
  const abort = new AbortController();
  timers.restartCountdown = abort;
  const log = (msg: string) => console.log(`[Scheduler:${serverId}] ${msg}`);
  let countdownAborted = false;

  try {
    if (!(await dockerService.getStatus(serverId)).running) {
      log('Scheduled restart skipped: the server is not running');
      return;
    }
    if (plan.onlyWhenEmpty) {
      const online = await getOnlinePlayers(serverId).catch(() => null);
      if (online === null || online.length > 0) {
        log(
          `Scheduled restart skipped: ${online === null ? 'player count unknown' : `${online.length} player(s) online`}`,
        );
        return;
      }
    }

    const opts: GracefulOptions = {
      reason: 'scheduled',
      actor: 'scheduler',
      countdownSeconds: plan.onlyWhenEmpty
        ? 0
        : Math.max(0, Math.round((restartAt.getTime() - Date.now()) / 1000)),
      warningSeconds: (plan.warningMinutes ?? []).map((m) => m * 60),
      message: plan.warningMessage,
      finalMessage: plan.restartMessage,
      signal: abort.signal,
    };
    log(`Scheduled restart: countdown ${opts.countdownSeconds}s`);

    if (plan.createBackup) {
      await withServerStopped(serverId, opts, async () => {
        const result = await createBackup({ kind: 'auto', label: 'scheduled_restart' }, serverId);
        if (result.success) log(`Pre-restart backup created: ${result.backup?.filename}`);
        else console.error(`[Scheduler:${serverId}] Pre-restart backup failed:`, result.error);
      });
      log('Server restarted');
    } else {
      const result = await restartServerGracefully(serverId, opts);
      if (result.ok) log(`Server restarted (${result.method})`);
      else if (result.method === 'cancelled') countdownAborted = true;
      else console.error(`[Scheduler:${serverId}] Server restart failed:`, result.error);
    }
  } catch (error) {
    if (error instanceof LifecycleError && error.phase === 'cancelled') countdownAborted = true;
    else console.error(`[Scheduler:${serverId}] Scheduled restart failed:`, error);
  } finally {
    if (timers.restartCountdown === abort) timers.restartCountdown = null;
    // Players were warned; tell them it is off (not for a mere reschedule).
    if (countdownAborted && abort.signal.reason === CANCELLED) {
      log('Scheduled restart cancelled');
      void dockerService.sendLifecycleCommand(
        '/notify warning The scheduled restart was cancelled.',
        serverId,
      );
    }
    // A rescheduled countdown has already been planned again by the caller.
    if (abort.signal.reason !== RESCHEDULED) {
      timers.lastRestartSlot = restartAt.getTime();
      scheduleNextRestart(serverId);
    }
  }
}

// Arm one restart: a single timer at the start of its countdown.
function scheduleRestartWithWarnings(restartTime: Date, timeStr: string, serverId: string): void {
  const cfg = schedulerConfig[serverId];
  const timers = timersByServer[serverId];
  if (!cfg || !timers) return;
  const msUntilRestart = restartTime.getTime() - Date.now();
  const fireIn = Math.max(0, msUntilRestart - countdownMsFor(cfg));
  // setTimeout(NaN) fires at once; a broken time must never become a restart loop.
  if (!Number.isFinite(fireIn)) {
    console.error(`[Scheduler:${serverId}] Restart time ${timeStr} is invalid; not scheduled`);
    return;
  }

  const restartTimer = setTimeout(() => {
    void executeScheduledRestart(serverId, restartTime);
  }, fireIn);
  timers.restartTimers.set(timeStr, restartTimer);

  timers.pendingRestart = { time: timeStr, scheduledAt: restartTime };

  console.log(
    `[Scheduler:${serverId}] Restart scheduled for ${restartTime.toISOString()} (in ${Math.round(msUntilRestart / 60000)} minutes)`,
  );
}

function clearRestartTimers(timers: SchedulerTimers, abortReason: string): void {
  for (const [, timer] of timers.restartTimers) clearTimeout(timer);
  timers.restartTimers.clear();
  timers.restartCountdown?.abort(abortReason);
  timers.restartCountdown = null;
  timers.pendingRestart = null;
}

// Schedule the next restart
function scheduleNextRestart(serverId: string): void {
  const cfg = schedulerConfig[serverId];
  const timers = timersByServer[serverId];
  if (!cfg || !timers) return;

  clearRestartTimers(timers, RESCHEDULED);

  if (!cfg.scheduledRestarts.enabled) return;

  const nextRestart = getNextRestartTime(serverId, timers.lastRestartSlot);
  if (nextRestart) {
    scheduleRestartWithWarnings(nextRestart.date, nextRestart.time, serverId);
  }
}

// Cancel the pending restart (also mid-countdown); the next slot is planned.
export function cancelPendingRestart(serverId?: string): boolean {
  const id = resolveServerIdSync(serverId);
  const timers = timersByServer[id];
  if (!timers || !timers.pendingRestart) return false;

  const slot = timers.pendingRestart.scheduledAt;
  console.log(
    `[Scheduler:${id}] Cancelled pending restart that was scheduled for ${slot.toISOString()}`,
  );
  timers.lastRestartSlot = slot.getTime();
  const countdown = timers.restartCountdown;
  timers.restartCountdown = null;
  // A running countdown announces the cancellation and plans the next slot itself.
  countdown?.abort(CANCELLED);
  if (!countdown) scheduleNextRestart(id);

  return true;
}

// Get pending restart info
export function getPendingRestart(serverId?: string): { time: string; scheduledAt: string } | null {
  const timers = timersByServer[resolveServerIdSync(serverId)];
  if (!timers || !timers.pendingRestart) return null;
  return {
    time: timers.pendingRestart.time,
    scheduledAt: timers.pendingRestart.scheduledAt.toISOString(),
  };
}

// ============================================================
// Scheduled custom commands
// ============================================================

// Compute the next daily occurrence (ms-from-now) among a list of "HH:MM".
function msUntilNextDailyTime(times: string[]): number | null {
  const now = new Date();
  let best: number | null = null;
  for (const timeStr of times) {
    const [h, m] = timeStr.split(':').map(Number);
    if (Number.isNaN(h) || Number.isNaN(m)) continue;
    const next = new Date(now);
    next.setHours(h, m, 0, 0);
    if (next <= now) next.setDate(next.getDate() + 1);
    const delta = next.getTime() - now.getTime();
    if (best === null || delta < best) best = delta;
  }
  return best;
}

// Timer-fired run: acts on behalf of whoever saved the entry, re-checked against
// the whitelist and that user's current console tier on this server.
async function runScheduledCommand(cmd: ScheduledCommand, serverId: string): Promise<void> {
  const auth = await authorizeStoredCommand(cmd.createdBy, cmd.command, serverId);
  if (!auth.allowed) {
    reportSkippedCommand(
      'scheduler',
      `scheduled_command:${serverId}:${cmd.id}`,
      cmd.createdBy,
      auth.error,
      {
        name: cmd.name,
        serverId,
      },
    );
    return;
  }
  await executeScheduledCommand(cmd, serverId);
}

async function executeScheduledCommand(cmd: ScheduledCommand, serverId: string): Promise<void> {
  try {
    const result = await dockerService.execCommand(cmd.command, serverId, {
      actor: cmd.createdBy ? `scheduler/${cmd.createdBy}` : 'scheduler',
    });
    const timers = timersByServer[serverId];
    if (timers && result.success) timers.commandLastRun.set(cmd.id, Date.now());
    // The server's answer is only known when the plugin ran the command.
    const outcome = result.status ?? (result.success ? 'ok' : 'failed');
    const detail = result.success ? '' : `: ${result.error ?? 'unknown error'}`;
    console.log(
      `[Scheduler:${serverId}] Ran scheduled command "${cmd.name}": ${cmd.command} (${outcome}${detail})`,
    );
  } catch (err) {
    console.error(`[Scheduler:${serverId}] Scheduled command "${cmd.name}" failed:`, err);
  }
}

function clearScheduledCommands(timers: SchedulerTimers): void {
  for (const [, t] of timers.commandTimers) {
    clearTimeout(t);
    clearInterval(t);
  }
  timers.commandTimers.clear();
}

function scheduleCommandsForServer(serverId: string): void {
  const cfg = schedulerConfig[serverId];
  const timers = timersByServer[serverId];
  if (!cfg || !timers) return;

  clearScheduledCommands(timers);

  for (const cmd of cfg.scheduledCommands ?? []) {
    if (!cmd.enabled) continue;

    if (cmd.mode === 'interval') {
      if (!cmd.intervalMinutes || cmd.intervalMinutes <= 0) continue;
      const timer = setInterval(() => {
        void runScheduledCommand(cmd, serverId);
      }, cmd.intervalMinutes * 60_000);
      timer.unref?.();
      timers.commandTimers.set(cmd.id, timer);
      console.log(
        `[Scheduler:${serverId}] Scheduled command "${cmd.name}" every ${cmd.intervalMinutes} min`,
      );
    } else {
      // daily mode: arm a one-shot to the next "HH:MM", re-arming after each fire.
      const arm = (): void => {
        const ms = msUntilNextDailyTime(cmd.times ?? []);
        if (ms === null) return;
        const timer = setTimeout(() => {
          void runScheduledCommand(cmd, serverId);
          arm(); // schedule tomorrow's (or next time's) occurrence
        }, ms);
        timer.unref?.();
        timers.commandTimers.set(cmd.id, timer);
      };
      arm();
      console.log(
        `[Scheduler:${serverId}] Scheduled command "${cmd.name}" daily at ${(cmd.times ?? []).join(', ')}`,
      );
    }
  }
}

/**
 * Start schedulers for a specific server.
 */
function startSchedulersForServer(serverId: string): void {
  const cfg = schedulerConfig[serverId];
  if (!cfg) return;
  if (!timersByServer[serverId]) timersByServer[serverId] = emptyTimers();
  const timers = timersByServer[serverId];

  console.log(`[Scheduler:${serverId}] Starting schedulers with config:`, {
    backups: { enabled: cfg.backups.enabled, schedule: cfg.backups.schedule },
    announcements: { enabled: cfg.announcements.enabled },
    scheduledRestarts: {
      enabled: cfg.scheduledRestarts.enabled,
      times: cfg.scheduledRestarts.times,
    },
  });

  if (cfg.backups.enabled) {
    const nextBackup = getNextBackupTime(serverId);
    if (nextBackup) {
      const msUntilBackup = nextBackup.getTime() - Date.now();

      timers.backupTimer = setTimeout(() => {
        runAutoBackup(serverId);
        timers.backupTimer = setInterval(() => runAutoBackup(serverId), 24 * 60 * 60 * 1000);
      }, msUntilBackup);

      console.log(`[Scheduler:${serverId}] Next backup scheduled for ${nextBackup.toISOString()}`);
    }
  }

  if (cfg.announcements.enabled) {
    for (const announcement of cfg.announcements.scheduled) {
      if (announcement.enabled && announcement.intervalMinutes > 0) {
        const timer = setInterval(
          () => {
            sendAnnouncement(announcement.message, serverId);
          },
          announcement.intervalMinutes * 60 * 1000,
        );

        timers.announcementTimers.set(announcement.id, timer);
        console.log(
          `[Scheduler:${serverId}] Announcement "${announcement.id}" scheduled every ${announcement.intervalMinutes} minutes`,
        );
      }
    }
  }

  scheduleNextRestart(serverId);
  scheduleCommandsForServer(serverId);
}

function stopSchedulersForServer(serverId: string): void {
  const timers = timersByServer[serverId];
  if (!timers) return;
  if (timers.backupTimer) {
    clearTimeout(timers.backupTimer);
    clearInterval(timers.backupTimer);
    timers.backupTimer = null;
  }
  for (const [, t] of timers.announcementTimers) clearInterval(t);
  timers.announcementTimers.clear();
  // A running countdown is re-planned from the (new) config by the next start.
  clearRestartTimers(timers, RESCHEDULED);
  clearScheduledCommands(timers);
  console.log(`[Scheduler:${serverId}] Schedulers stopped`);
}

let lifecycleHooksRegistered = false;

/**
 * Start schedulers for every registered server. Idempotent.
 */
export async function startSchedulers(): Promise<void> {
  try {
    await ensureLoaded();
    const servers = await listServers();
    for (const s of servers) {
      await loadConfig(s.id);
      startSchedulersForServer(s.id);
    }
    if (!lifecycleHooksRegistered) {
      onServerAdded(async (server) => {
        await loadConfig(server.id);
        // Never a second set of timers for a server that already has some.
        stopSchedulersForServer(server.id);
        startSchedulersForServer(server.id);
      });
      onServerDeleted((serverId) => {
        stopSchedulersForServer(serverId);
        delete schedulerConfig[serverId];
        delete timersByServer[serverId];
      });
      lifecycleHooksRegistered = true;
    }
  } catch (err) {
    console.error('[Scheduler] Failed to start schedulers:', err);
  }
}

/**
 * Stop schedulers for every server.
 */
export function stopSchedulers(): void {
  for (const id of Object.keys(timersByServer)) {
    stopSchedulersForServer(id);
  }
}

/**
 * Configs from before the restart plan kept "back up before restart" under
 * backups.beforeRestart, which nothing ever read. Carry it over to the plan's
 * createBackup unless the plan already has its own value.
 */
export function carryOverRestartBackup(loaded: any): any {
  const legacy = loaded?.backups?.beforeRestart;
  if (typeof legacy !== 'boolean' || typeof loaded?.scheduledRestarts?.createBackup === 'boolean') {
    return loaded;
  }
  return { ...loaded, scheduledRestarts: { ...loaded.scheduledRestarts, createBackup: legacy } };
}

const WELCOME_ACTION_NAME = 'Welcome message (Scheduler)';

/**
 * The welcome message is an Event Action rule (player.joined → announce), so
 * it fires from the plugin's join event without its own wiring. Hytale 0.7 has
 * no private message command, which makes it a chat line for everyone. The
 * rule follows the scheduler settings; its id is stored in the config.
 */
function syncWelcomeAction(serverId: string, cfg: ScheduleConfig): string | undefined {
  const text = stripControlChars(cfg.announcements.welcome ?? '').trim();
  const enabled = cfg.announcements.enabled && text !== '';
  const storedId = cfg.announcements.welcomeActionId;
  try {
    const stored = storedId ? getEventAction(storedId) : null;
    // Only ever touch the rule this created for this server, whatever id a
    // config file holds (the game server can write the file and name the
    // welcome rule of another server).
    const ours =
      stored?.createdBy === 'scheduler' &&
      stored.name === WELCOME_ACTION_NAME &&
      stored.actionType === 'announce' &&
      stored.serverId === serverId
        ? stored
        : null;
    if (ours) {
      updateEventAction(ours.id, { actionPayload: { message: text }, enabled, serverId });
      return ours.id;
    }
    if (!enabled) return undefined;
    return createEventAction({
      name: WELCOME_ACTION_NAME,
      serverId,
      eventPattern: 'player.joined',
      actionType: 'announce',
      actionPayload: { message: text },
      createdBy: 'scheduler',
    }).id;
  } catch (error) {
    console.error(`[Scheduler:${serverId}] Could not update the welcome message rule:`, error);
    return storedId;
  }
}

const MAX_WARNING_MINUTES = 240;
// Each warning is an on-screen notice for every player; the earliest one sets
// the countdown length and is always kept.
const MAX_WARNINGS = 10;
const MAX_MESSAGE_LENGTH = 200;
// Restart times are "HH:MM" (local time of the manager), daily.
const MAX_RESTART_TIMES = 24;
// Minimum distance between two restart times, also across midnight. One
// restart needs the countdown (30 minutes by default), up to about 2.5
// minutes to stop (SERVER_STOP_TIMEOUT_SECONDS plus the Docker fallback), the
// optional backup and the boot. An hour covers that with room to spare, so
// the default countdown always runs in full and the server is up for most of
// every hour; at most 24 restarts a day, matching MAX_RESTART_TIMES. A longer
// countdown than the gap is shortened, never overlapped: the next time is
// only armed once the previous restart has finished.
const MIN_RESTART_GAP_MINUTES = 60;
const MINUTES_PER_DAY = 24 * 60;

function minutesOfDay(time: string): number {
  const [h, m] = time.split(':').map(Number);
  return h * 60 + m;
}

/** First pair of (sorted, unique) times closer than the minimum gap, or null. */
function restartGapConflict(sorted: string[]): [string, string] | null {
  for (let i = 1; i < sorted.length; i++) {
    if (minutesOfDay(sorted[i]) - minutesOfDay(sorted[i - 1]) < MIN_RESTART_GAP_MINUTES) {
      return [sorted[i - 1], sorted[i]];
    }
  }
  if (sorted.length > 1) {
    const last = sorted[sorted.length - 1];
    if (minutesOfDay(sorted[0]) + MINUTES_PER_DAY - minutesOfDay(last) < MIN_RESTART_GAP_MINUTES) {
      return [last, sorted[0]];
    }
  }
  return null;
}

/**
 * Check restart times from a client: strict "HH:MM", at most
 * MAX_RESTART_TIMES, at least MIN_RESTART_GAP_MINUTES apart. Duplicates are
 * dropped; the result is sorted.
 */
export function reviewRestartTimes(
  value: unknown,
): { ok: true; value: string[] } | { ok: false; error: string } {
  if (!Array.isArray(value)) {
    return { ok: false, error: 'scheduledRestarts.times must be a list of "HH:MM" times' };
  }
  for (const t of value) {
    if (typeof t !== 'string' || !DAILY_TIME.test(t)) {
      return {
        ok: false,
        error: `Restart time ${JSON.stringify(t)?.slice(0, 40)} is not a time of day ("HH:MM")`,
      };
    }
  }
  const times = [...new Set(value as string[])].sort();
  if (times.length > MAX_RESTART_TIMES) {
    return { ok: false, error: `At most ${MAX_RESTART_TIMES} restart times are allowed` };
  }
  const conflict = restartGapConflict(times);
  if (conflict) {
    return {
      ok: false,
      error:
        `Restart times ${conflict[0]} and ${conflict[1]} are less than ` +
        `${MIN_RESTART_GAP_MINUTES} minutes apart`,
    };
  }
  return { ok: true, value: times };
}

/**
 * The same rules for a stored plan (a config written by an older version or
 * by hand): invalid entries are dropped, and of two times too close together
 * the later one.
 */
function normalizeRestartTimes(value: unknown): string[] {
  const valid = [
    ...new Set(
      (Array.isArray(value) ? value : []).filter(
        (t): t is string => typeof t === 'string' && DAILY_TIME.test(t),
      ),
    ),
  ].sort();
  const kept: string[] = [];
  for (const t of valid) {
    const prev = kept[kept.length - 1];
    if (prev === undefined || minutesOfDay(t) - minutesOfDay(prev) >= MIN_RESTART_GAP_MINUTES) {
      kept.push(t);
    }
  }
  while (kept.length > 1 && restartGapConflict(kept)) kept.pop();
  return kept.slice(0, MAX_RESTART_TIMES);
}

// Keep a saved restart plan within sane bounds (the client sends it as-is).
function normalizeRestartPlan(raw: unknown): ScheduleConfig['scheduledRestarts'] {
  const plan: ScheduleConfig['scheduledRestarts'] =
    raw && typeof raw === 'object' && !Array.isArray(raw)
      ? (raw as ScheduleConfig['scheduledRestarts'])
      : DEFAULT_CONFIG.scheduledRestarts;
  const sorted = [
    ...new Set(
      (Array.isArray(plan.warningMinutes) ? plan.warningMinutes : [])
        .map(Number)
        .filter((m) => Number.isInteger(m) && m >= 1 && m <= MAX_WARNING_MINUTES),
    ),
  ].sort((a, b) => b - a);
  const warningMinutes =
    sorted.length > MAX_WARNINGS
      ? [sorted[0], ...sorted.slice(sorted.length - (MAX_WARNINGS - 1))]
      : sorted;
  const text = (value: unknown, fallback: string) =>
    (typeof value === 'string' ? value : fallback).slice(0, MAX_MESSAGE_LENGTH);
  return {
    ...plan,
    times: normalizeRestartTimes(plan.times),
    warningMinutes,
    warningMessage: text(plan.warningMessage, DEFAULT_CONFIG.scheduledRestarts.warningMessage),
    restartMessage: text(plan.restartMessage, DEFAULT_CONFIG.scheduledRestarts.restartMessage),
    onlyWhenEmpty: plan.onlyWhenEmpty === true,
  };
}

// Quick commands

/** A copy of the default quick commands (new installs, the demo). */
export function defaultQuickCommands(): QuickCommand[] {
  return DEFAULT_CONFIG.quickCommands.map((c) => ({ ...c }));
}

export function getQuickCommands(serverId?: string): QuickCommand[] {
  return getConfig(serverId).quickCommands;
}

/** The new command, or null when the config could not be saved. */
export async function addQuickCommand(
  command: Omit<QuickCommand, 'id'>,
  serverId?: string,
): Promise<QuickCommand | null> {
  const newCommand: QuickCommand = { ...command, id: Date.now().toString() };
  const saved = await applyConfig(
    (current) => ({ quickCommands: [...current.quickCommands, newCommand] }),
    resolveServerIdSync(serverId),
  );
  return saved ? newCommand : null;
}

export type QuickCommandChange = 'ok' | 'not_found' | 'save_failed';

/** Replaces the server's quick commands with `edit(current)`; null = command not found. */
async function changeQuickCommands(
  serverId: string | undefined,
  edit: (current: QuickCommand[]) => QuickCommand[] | null,
): Promise<QuickCommandChange> {
  let found = true;
  const saved = await applyConfig((current) => {
    const quickCommands = edit(current.quickCommands);
    found = quickCommands !== null;
    return quickCommands ? { quickCommands } : null;
  }, resolveServerIdSync(serverId));
  if (!found) return 'not_found';
  return saved ? 'ok' : 'save_failed';
}

export function updateQuickCommand(
  qcId: string,
  updates: Partial<QuickCommand>,
  serverId?: string,
): Promise<QuickCommandChange> {
  return changeQuickCommands(serverId, (current) =>
    current.some((c) => c.id === qcId)
      ? current.map((c) => (c.id === qcId ? { ...c, ...updates, id: qcId } : c))
      : null,
  );
}

export function deleteQuickCommand(qcId: string, serverId?: string): Promise<QuickCommandChange> {
  return changeQuickCommands(serverId, (current) =>
    current.some((c) => c.id === qcId) ? current.filter((c) => c.id !== qcId) : null,
  );
}

// ============================================================
// Save-time review of stored commands
// ============================================================

export type CommandReview<T> =
  { ok: true; value: T } | { ok: false; status: 400 | 403; error: string };

function asString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function normalizeScheduledCommand(raw: Partial<ScheduledCommand>): ScheduledCommand {
  return {
    id: asString(raw.id),
    name: asString(raw.name),
    command: asString(raw.command),
    enabled: Boolean(raw.enabled),
    mode: raw.mode === 'interval' ? 'interval' : 'daily',
    times: Array.isArray(raw.times)
      ? raw.times.filter((t): t is string => typeof t === 'string')
      : [],
    intervalMinutes: Number(raw.intervalMinutes) || 0,
  };
}

// Renaming or disabling an entry is harmless. Anything that changes what runs,
// or when, is re-authorized against the user saving it.
function changesExecution(prev: ScheduledCommand, next: ScheduledCommand): boolean {
  return (
    prev.command !== next.command ||
    (next.enabled && !prev.enabled) ||
    prev.mode !== next.mode ||
    prev.intervalMinutes !== next.intervalMinutes ||
    JSON.stringify(prev.times) !== JSON.stringify(next.times)
  );
}

const MAX_INTERVAL_MINUTES = 7 * 24 * 60;
const DAILY_TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

// A fractional or huge interval would turn an allowed command into a flood
// (Node clamps delays above 2^31 ms to 1 ms).
function scheduleError(cmd: ScheduledCommand): string | null {
  if (cmd.mode === 'interval') {
    const ok =
      Number.isInteger(cmd.intervalMinutes) &&
      cmd.intervalMinutes >= 1 &&
      cmd.intervalMinutes <= MAX_INTERVAL_MINUTES;
    return ok
      ? null
      : `intervalMinutes must be a whole number between 1 and ${MAX_INTERVAL_MINUTES}`;
  }
  return cmd.times.every((t) => DAILY_TIME.test(t)) ? null : 'times must be "HH:MM" values';
}

/**
 * Validate an incoming `scheduledCommands` array before it replaces the stored
 * one. New or execution-relevant changes must pass the console check for the
 * saving actor and are stamped with them as creator; untouched entries keep
 * their stored creator (a client-sent `createdBy` is never trusted).
 */
export async function reviewScheduledCommands(
  incoming: unknown,
  actor: CommandActor,
  serverId?: string,
): Promise<CommandReview<ScheduledCommand[]>> {
  if (!Array.isArray(incoming)) {
    return { ok: false, status: 400, error: 'scheduledCommands must be an array' };
  }
  const stored = new Map(
    (getConfig(serverId).scheduledCommands ?? []).map((c) => [c.id, c] as const),
  );
  const seen = new Set<string>();
  const reviewed: ScheduledCommand[] = [];
  for (const raw of incoming) {
    const next = normalizeScheduledCommand((raw ?? {}) as Partial<ScheduledCommand>);
    const label = next.name || next.command;
    if (!next.id || seen.has(next.id)) {
      return {
        ok: false,
        status: 400,
        error: `Scheduled command "${label}": missing or duplicate id`,
      };
    }
    seen.add(next.id);
    // An unchanged entry is kept as it is, even when its command no longer
    // exists (e.g. /save from before Hytale 0.7): it is checked again before
    // every run and flagged through blockedReason instead of blocking the save.
    const prevRaw = stored.get(next.id);
    if (prevRaw && !changesExecution(normalizeScheduledCommand(prevRaw), next)) {
      reviewed.push(prevRaw.createdBy ? { ...next, createdBy: prevRaw.createdBy } : next);
      continue;
    }
    const check = validateCommand(next.command);
    if (!check.valid) {
      return { ok: false, status: 400, error: `Scheduled command "${label}": ${check.error}` };
    }
    const invalidSchedule = scheduleError(next);
    if (invalidSchedule) {
      return { ok: false, status: 400, error: `Scheduled command "${label}": ${invalidSchedule}` };
    }
    const auth = await authorizeCommand(actor, next.command, serverId);
    if (!auth.allowed) {
      return {
        ok: false,
        status: auth.status,
        error: `Scheduled command "${label}": ${auth.error}`,
      };
    }
    reviewed.push({ ...next, createdBy: actor.username ?? undefined });
  }
  return { ok: true, value: reviewed };
}

function normalizeQuickCommand(raw: Partial<QuickCommand>): QuickCommand {
  return {
    id: asString(raw.id),
    name: asString(raw.name),
    command: asString(raw.command),
    icon: asString(raw.icon, 'terminal') || 'terminal',
    category: asString(raw.category, 'custom') || 'custom',
  };
}

/**
 * Validate an incoming `quickCommands` array (PUT /config). Quick commands are
 * always re-checked against the user who clicks them, so only new or changed
 * commands need the saver's console tier; untouched entries pass as stored.
 */
export async function reviewQuickCommands(
  incoming: unknown,
  actor: CommandActor,
  serverId?: string,
): Promise<CommandReview<QuickCommand[]>> {
  if (!Array.isArray(incoming)) {
    return { ok: false, status: 400, error: 'quickCommands must be an array' };
  }
  const stored = new Map(getQuickCommands(serverId).map((c) => [c.id, c] as const));
  const seen = new Set<string>();
  const reviewed: QuickCommand[] = [];
  for (const raw of incoming) {
    const next = normalizeQuickCommand((raw ?? {}) as Partial<QuickCommand>);
    const label = next.name || next.command;
    if (!next.id || seen.has(next.id) || !next.name) {
      return {
        ok: false,
        status: 400,
        error: `Quick command "${label}": name and a unique id are required`,
      };
    }
    seen.add(next.id);
    if (stored.get(next.id)?.command !== next.command) {
      const auth = await authorizeCommand(actor, next.command, serverId);
      if (!auth.allowed) {
        return { ok: false, status: auth.status, error: `Quick command "${label}": ${auth.error}` };
      }
    }
    reviewed.push(next);
  }
  return { ok: true, value: reviewed };
}

// Run a configured scheduled command immediately (used by the "Run now" button).
// "Run now" acts on behalf of the requesting user, exactly like the console.
export async function runScheduledCommandNow(
  commandId: string,
  serverId: string | undefined,
  actor: CommandActor,
): Promise<{ success: boolean; error?: string; status?: number }> {
  const id = await resolveServerId(serverId);
  const cfg = schedulerConfig[id] ?? (await loadConfig(id));
  const cmd = (cfg.scheduledCommands ?? []).find((c) => c.id === commandId);
  if (!cmd) return { success: false, error: 'Scheduled command not found', status: 404 };
  const auth = await authorizeCommand(actor, cmd.command, id);
  if (!auth.allowed) return { success: false, error: auth.error, status: auth.status };
  await executeScheduledCommand(cmd, id);
  return { success: true };
}

export type ScheduledCommandView = ScheduledCommand & { blockedReason: StoredCommandBlock | null };

/**
 * The config as served to clients. Each scheduled command carries a derived
 * `blockedReason` (why its timer would skip it right now, e.g. an entry saved
 * before creators were recorded); it is never persisted, and a client that
 * sends it back has it dropped by reviewScheduledCommands.
 */
export async function getConfigView(
  serverId?: string,
): Promise<
  Omit<ScheduleConfig, 'scheduledCommands'> & { scheduledCommands: ScheduledCommandView[] }
> {
  const cfg = getConfig(serverId);
  const id = await resolveServerId(serverId);
  const scheduledCommands = await Promise.all(
    (cfg.scheduledCommands ?? []).map(async (c) => ({
      ...c,
      blockedReason: await storedCommandBlockedReason(c.createdBy, c.command, id),
    })),
  );
  return { ...cfg, scheduledCommands };
}

/**
 * Explicit approval: the requesting user takes over a stored entry as its
 * creator, but only if they may run the command themselves. This is how a
 * legacy entry (no creator) or one whose creator lost the tier runs again,
 * without silently adopting entries on an unrelated save.
 */
export async function approveScheduledCommand(
  commandId: string,
  serverId: string | undefined,
  actor: CommandActor,
): Promise<
  | { success: true; command: ScheduledCommand; serverId: string }
  | { success: false; status: number; error: string }
> {
  const id = await resolveServerId(serverId);
  const cfg = schedulerConfig[id] ?? (await loadConfig(id));
  const cmd = (cfg.scheduledCommands ?? []).find((c) => c.id === commandId);
  if (!cmd) return { success: false, status: 404, error: 'Scheduled command not found' };
  const auth = await authorizeCommand(actor, cmd.command, id);
  if (!auth.allowed) return { success: false, status: auth.status, error: auth.error };
  if (!actor.username) return { success: false, status: 403, error: 'Authentication required' };
  const approved: ScheduledCommand = { ...cmd, createdBy: actor.username };
  // Only the entry that was authorized: one edited meanwhile is not stamped.
  let unchanged = true;
  const saved = await applyConfig((current) => {
    const now = current.scheduledCommands.find((c) => c.id === commandId);
    unchanged = JSON.stringify(now) === JSON.stringify(cmd);
    if (!unchanged) return null;
    // New array, so the timers are re-armed from the stamped entry.
    return {
      scheduledCommands: current.scheduledCommands.map((c) => (c.id === commandId ? approved : c)),
    };
  }, id);
  if (!unchanged) {
    return { success: false, status: 409, error: 'The command was changed meanwhile; try again' };
  }
  if (!saved) return { success: false, status: 500, error: 'Failed to save the approval' };
  return { success: true, command: approved, serverId: id };
}

export interface ScheduledCommandStatus {
  id: string;
  name: string;
  command: string;
  enabled: boolean;
  mode: 'daily' | 'interval';
  nextRun: string | null;
  lastRun: string | null;
}

function getScheduledCommandStatuses(serverId: string): ScheduledCommandStatus[] {
  const cfg = schedulerConfig[serverId];
  const timers = timersByServer[serverId];
  if (!cfg) return [];
  const now = Date.now();
  return (cfg.scheduledCommands ?? []).map((cmd) => {
    let nextRun: string | null = null;
    if (cmd.enabled) {
      if (cmd.mode === 'interval' && cmd.intervalMinutes > 0) {
        const last = timers?.commandLastRun.get(cmd.id) ?? now;
        nextRun = new Date(last + cmd.intervalMinutes * 60_000).toISOString();
      } else if (cmd.mode === 'daily') {
        const ms = msUntilNextDailyTime(cmd.times ?? []);
        if (ms !== null) nextRun = new Date(now + ms).toISOString();
      }
    }
    const lastRunMs = timers?.commandLastRun.get(cmd.id);
    return {
      id: cmd.id,
      name: cmd.name,
      command: cmd.command,
      enabled: cmd.enabled,
      mode: cmd.mode,
      nextRun,
      lastRun: lastRunMs ? new Date(lastRunMs).toISOString() : null,
    };
  });
}

// Get scheduler status
export async function getSchedulerStatus(serverId?: string): Promise<{
  backups: { enabled: boolean; nextRun: string | null; lastRun: string | null; schedule: string };
  announcements: { enabled: boolean; activeCount: number };
  scheduledRestarts: {
    enabled: boolean;
    nextRestart: string | null;
    pendingRestart: { time: string; scheduledAt: string } | null;
    /** The in-game countdown for the pending restart is running. */
    countdownRunning: boolean;
    times: string[];
  };
  scheduledCommands: ScheduledCommandStatus[];
}> {
  const id = await resolveServerId(serverId);
  const cfg = schedulerConfig[id] ?? (await loadConfig(id));
  const timers = timersByServer[id] ?? emptyTimers();
  const nextBackup = getNextBackupTime(id);
  const backups = await listBackups(id);
  const lastAutoBackup = backups.find((b) => b.type === 'auto');
  const nextRestart = getNextRestartTime(id, timers.lastRestartSlot);

  return {
    backups: {
      enabled: cfg.backups.enabled,
      nextRun: nextBackup?.toISOString() || null,
      lastRun: lastAutoBackup?.created_at || null,
      schedule: cfg.backups.schedule,
    },
    announcements: {
      enabled: cfg.announcements.enabled,
      activeCount: timers.announcementTimers.size,
    },
    scheduledRestarts: {
      enabled: cfg.scheduledRestarts.enabled,
      nextRestart: nextRestart?.date.toISOString() || null,
      pendingRestart: getPendingRestart(id),
      countdownRunning: timers.restartCountdown !== null,
      times: cfg.scheduledRestarts.times,
    },
    scheduledCommands: getScheduledCommandStatuses(id),
  };
}

// Eagerly initialise the default-server config on module load so callers
// that use the sync getConfig()/getQuickCommands() before startSchedulers()
// runs get a sensible snapshot. The async work happens in the background;
// until it completes, schedulerConfig may be empty and callers get DEFAULT.
void (async () => {
  try {
    const id = await resolveServerId();
    await loadConfig(id);
  } catch {
    /* startSchedulers will retry */
  }
})();
