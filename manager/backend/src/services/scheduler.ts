/**
 * Scheduler service.
 *
 * Multi-server: the scheduler keeps one ScheduleConfig per registered server
 * id (`schedulerConfig: Record<serverId, ScheduleConfig>`) and dispatches all
 * tasks against the matching server. Timers run centrally inside this
 * module — there's no need for per-server cron daemons.
 *
 * Backward-compat: callers that omit `serverId` resolve to the default
 * server from the registry (services/servers.ts). The legacy single-server
 * manager-config.json living in `config.dataPath` continues to be loaded
 * for the default server so existing installs migrate transparently.
 */
import fs from 'fs';
import path from 'path';
import { config } from '../config.js';
import { createBackup, listBackups, deleteBackup } from './backup.js';
import * as dockerService from './docker.js';
import { validateCommand } from '../utils/sanitize.js';
import { ensureLoaded, getDefaultId, getServer, listServers, onServerAdded, onServerDeleted } from './servers.js';

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
    welcome: string;
    scheduled: ScheduledAnnouncement[];
  };
  scheduledRestarts: {
    enabled: boolean;
    times: string[]; // Array of times like ["03:00", "15:00"]
    warningMinutes: number[]; // Warning intervals before restart, e.g. [30, 15, 5, 1]
    warningMessage: string; // Message template, {minutes} placeholder
    restartMessage: string; // Final message before restart
    createBackup: boolean; // Create backup before restart
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
 */
interface ScheduledCommand {
  id: string;
  name: string;
  command: string;
  enabled: boolean;
  mode: 'daily' | 'interval';
  times: string[];
  intervalMinutes: number;
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
    warningMessage: 'Server restart in {minutes} minute(s)!',
    restartMessage: 'Server is restarting now!',
    createBackup: true,
  },
  quickCommands: [
    { id: '1', name: 'Save World', command: '/save', icon: 'save', category: 'server' },
    { id: '2', name: 'List Players', command: '/list', icon: 'users', category: 'players' },
    { id: '3', name: 'Set Day', command: '/time set day', icon: 'sun', category: 'world' },
    { id: '4', name: 'Set Night', command: '/time set night', icon: 'moon', category: 'world' },
    { id: '5', name: 'Clear Weather', command: '/weather clear', icon: 'cloud', category: 'world' },
    { id: '6', name: 'Rain', command: '/weather rain', icon: 'cloud-rain', category: 'world' },
  ],
  scheduledCommands: [],
};

// Per-server configuration cache (keyed by serverId).
const schedulerConfig: Record<string, ScheduleConfig> = {};

// Per-server timer state.
interface SchedulerTimers {
  backupTimer: NodeJS.Timeout | null;
  announcementTimers: Map<string, NodeJS.Timeout>;
  restartTimers: Map<string, NodeJS.Timeout>;
  restartWarningTimers: NodeJS.Timeout[];
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
    restartWarningTimers: [],
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
 * Resolve serverId, defaulting to the registry default.
 */
async function resolveServerId(serverId?: string): Promise<string> {
  if (serverId) return serverId;
  try {
    return await getDefaultId();
  } catch {
    // registry not ready yet (very early boot) — use a stable sentinel
    return 'default';
  }
}

/**
 * Resolve the on-disk config file path for a specific server.
 * The default server keeps using the legacy `<dataPath>/manager-config.json`
 * for backward compatibility; additional servers store under their own
 * data directory.
 */
async function getConfigFilePath(serverId: string): Promise<string> {
  try {
    const defaultId = await getDefaultId();
    if (serverId === defaultId) {
      return path.join(config.dataPath, 'manager-config.json');
    }
    const s = await getServer(serverId);
    if (s) return path.join(s.paths.data, 'manager-config.json');
  } catch { /* registry not ready */ }
  return path.join(config.dataPath, 'manager-config.json');
}

/**
 * Load configuration for a single server.
 */
export async function loadConfig(serverId?: string): Promise<ScheduleConfig> {
  const id = await resolveServerId(serverId);
  const filePath = await getConfigFilePath(id);
  let cfg: ScheduleConfig = { ...DEFAULT_CONFIG };
  try {
    if (fs.existsSync(filePath)) {
      const data = fs.readFileSync(filePath, 'utf-8');
      const loaded = JSON.parse(data);
      cfg = deepMerge(DEFAULT_CONFIG, loaded);
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
 * Save configuration for a single server.
 */
export function saveConfig(cfg: Partial<ScheduleConfig>, serverId?: string): boolean {
  // saveConfig is sync in the public API; use a microtask-friendly approach
  // that resolves the serverId synchronously when possible.
  // We rely on the cache being populated by loadConfig at startup.
  const id = serverId ?? '__pending__';
  if (id === '__pending__') {
    // Resolve default lazily — wrap async work in a synchronous-looking call
    // by returning the result of doSave().
    return doSaveSync(cfg);
  }
  return doSaveSync(cfg, id);
}

function doSaveSync(cfg: Partial<ScheduleConfig>, serverIdOverride?: string): boolean {
  try {
    const id = serverIdOverride ?? Object.keys(schedulerConfig)[0] ?? 'default';
    const current = schedulerConfig[id] ?? { ...DEFAULT_CONFIG };
    const merged = deepMerge(current, cfg);
    schedulerConfig[id] = merged;
    // Fire-and-forget async persist + restart for the resolved server.
    void (async () => {
      try {
        const filePath = await getConfigFilePath(id);
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        fs.writeFileSync(filePath, JSON.stringify(merged, null, 2));
        console.log(`[Scheduler:${id}] Config saved to file:`, filePath);
        stopSchedulersForServer(id);
        startSchedulersForServer(id);
      } catch (err) {
        console.error(`[Scheduler:${id}] Failed to persist config:`, err);
      }
    })();
    return true;
  } catch (error) {
    console.error('Failed to save scheduler config:', error);
    return false;
  }
}

/**
 * Get configuration for a specific server (default if omitted).
 */
export function getConfig(serverId?: string): ScheduleConfig {
  const id = serverId ?? Object.keys(schedulerConfig)[0] ?? 'default';
  return schedulerConfig[id] ?? { ...DEFAULT_CONFIG };
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

  const result = await createBackup('auto', serverId);

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
    if (backup.type === 'auto' && new Date(backup.created_at) < cutoffDate) {
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
  if (!message) return;

  try {
    await dockerService.execCommand(`/broadcast ${message}`, serverId);
    console.log(`[Scheduler:${serverId}] Sent announcement: ${message}`);
  } catch (error) {
    console.error(`[Scheduler:${serverId}] Failed to send announcement:`, error);
  }
}

// Calculate next restart time
function getNextRestartTime(serverId: string): { time: string; date: Date } | null {
  const cfg = schedulerConfig[serverId];
  if (!cfg || !cfg.scheduledRestarts.enabled || cfg.scheduledRestarts.times.length === 0) {
    return null;
  }

  const now = new Date();
  let nearestRestart: { time: string; date: Date } | null = null;

  for (const timeStr of cfg.scheduledRestarts.times) {
    const [hours, minutes] = timeStr.split(':').map(Number);
    const restartDate = new Date(now);
    restartDate.setHours(hours, minutes, 0, 0);

    if (restartDate <= now) {
      restartDate.setDate(restartDate.getDate() + 1);
    }

    if (!nearestRestart || restartDate < nearestRestart.date) {
      nearestRestart = { time: timeStr, date: restartDate };
    }
  }

  return nearestRestart;
}

// Send restart warning
async function sendRestartWarning(minutesLeft: number, serverId: string): Promise<void> {
  const cfg = schedulerConfig[serverId];
  if (!cfg) return;
  const message = cfg.scheduledRestarts.warningMessage.replace('{minutes}', minutesLeft.toString());
  await sendAnnouncement(message, serverId);
  console.log(`[Scheduler:${serverId}] Sent restart warning: ${minutesLeft} minutes remaining`);
}

// Execute the scheduled restart
async function executeScheduledRestart(serverId: string): Promise<void> {
  const cfg = schedulerConfig[serverId];
  if (!cfg) return;
  console.log(`[Scheduler:${serverId}] Executing scheduled restart...`);

  await sendAnnouncement(cfg.scheduledRestarts.restartMessage, serverId);

  await new Promise(resolve => setTimeout(resolve, 2000));

  if (cfg.scheduledRestarts.createBackup) {
    console.log(`[Scheduler:${serverId}] Creating pre-restart backup...`);
    const result = await createBackup('scheduled_restart', serverId);
    if (result.success) {
      console.log(`[Scheduler:${serverId}] Pre-restart backup created: ${result.backup?.filename}`);
    } else {
      console.error(`[Scheduler:${serverId}] Pre-restart backup failed:`, result.error);
    }
  }

  const restartResult = await dockerService.restartContainer(serverId);
  if (restartResult.success) {
    console.log(`[Scheduler:${serverId}] Server restart initiated successfully`);
  } else {
    console.error(`[Scheduler:${serverId}] Server restart failed:`, restartResult.error);
  }

  // Clear pending restart and schedule next one
  const timers = timersByServer[serverId];
  if (timers) timers.pendingRestart = null;
  scheduleNextRestart(serverId);
}

// Schedule a single restart with warnings
function scheduleRestartWithWarnings(restartTime: Date, timeStr: string, serverId: string): void {
  const cfg = schedulerConfig[serverId];
  const timers = timersByServer[serverId];
  if (!cfg || !timers) return;
  const now = Date.now();
  const restartMs = restartTime.getTime();
  const msUntilRestart = restartMs - now;

  for (const timer of timers.restartWarningTimers) clearTimeout(timer);
  timers.restartWarningTimers = [];

  for (const warningMinutes of cfg.scheduledRestarts.warningMinutes) {
    const warningMs = msUntilRestart - (warningMinutes * 60 * 1000);
    if (warningMs > 0) {
      const timer = setTimeout(() => {
        sendRestartWarning(warningMinutes, serverId);
      }, warningMs);
      timers.restartWarningTimers.push(timer);
    }
  }

  const restartTimer = setTimeout(() => {
    executeScheduledRestart(serverId);
  }, msUntilRestart);
  timers.restartTimers.set(timeStr, restartTimer);

  timers.pendingRestart = { time: timeStr, scheduledAt: restartTime };

  console.log(`[Scheduler:${serverId}] Restart scheduled for ${restartTime.toISOString()} (in ${Math.round(msUntilRestart / 60000)} minutes)`);
}

// Schedule the next restart
function scheduleNextRestart(serverId: string): void {
  const cfg = schedulerConfig[serverId];
  const timers = timersByServer[serverId];
  if (!cfg || !timers) return;

  for (const [, timer] of timers.restartTimers) clearTimeout(timer);
  timers.restartTimers.clear();

  for (const timer of timers.restartWarningTimers) clearTimeout(timer);
  timers.restartWarningTimers = [];
  timers.pendingRestart = null;

  if (!cfg.scheduledRestarts.enabled) return;

  const nextRestart = getNextRestartTime(serverId);
  if (nextRestart) {
    scheduleRestartWithWarnings(nextRestart.date, nextRestart.time, serverId);
  }
}

// Cancel pending restart
export function cancelPendingRestart(serverId?: string): boolean {
  const id = serverId ?? Object.keys(timersByServer)[0];
  if (!id) return false;
  const timers = timersByServer[id];
  if (!timers || !timers.pendingRestart) return false;

  for (const [, timer] of timers.restartTimers) clearTimeout(timer);
  timers.restartTimers.clear();

  for (const timer of timers.restartWarningTimers) clearTimeout(timer);
  timers.restartWarningTimers = [];

  console.log(`[Scheduler:${id}] Cancelled pending restart that was scheduled for ${timers.pendingRestart.scheduledAt.toISOString()}`);
  timers.pendingRestart = null;

  setTimeout(() => scheduleNextRestart(id), 60000);

  return true;
}

// Get pending restart info
export function getPendingRestart(serverId?: string): { time: string; scheduledAt: string } | null {
  const id = serverId ?? Object.keys(timersByServer)[0];
  if (!id) return null;
  const timers = timersByServer[id];
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

// Run a scheduled command after re-validating it against the console whitelist.
async function runScheduledCommand(cmd: ScheduledCommand, serverId: string): Promise<void> {
  const check = validateCommand(cmd.command);
  if (!check.valid) {
    console.error(`[Scheduler:${serverId}] Skipping scheduled command "${cmd.name}": ${check.error}`);
    return;
  }
  try {
    const result = await dockerService.execCommand(cmd.command, serverId);
    const timers = timersByServer[serverId];
    if (timers && result.success) timers.commandLastRun.set(cmd.id, Date.now());
    console.log(`[Scheduler:${serverId}] Ran scheduled command "${cmd.name}": ${cmd.command} (${result.success ? 'ok' : 'failed'})`);
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
      const timer = setInterval(() => { void runScheduledCommand(cmd, serverId); }, cmd.intervalMinutes * 60_000);
      timer.unref?.();
      timers.commandTimers.set(cmd.id, timer);
      console.log(`[Scheduler:${serverId}] Scheduled command "${cmd.name}" every ${cmd.intervalMinutes} min`);
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
      console.log(`[Scheduler:${serverId}] Scheduled command "${cmd.name}" daily at ${(cmd.times ?? []).join(', ')}`);
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
        const timer = setInterval(() => {
          sendAnnouncement(announcement.message, serverId);
        }, announcement.intervalMinutes * 60 * 1000);

        timers.announcementTimers.set(announcement.id, timer);
        console.log(`[Scheduler:${serverId}] Announcement "${announcement.id}" scheduled every ${announcement.intervalMinutes} minutes`);
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
  for (const [, t] of timers.restartTimers) clearTimeout(t);
  timers.restartTimers.clear();
  for (const t of timers.restartWarningTimers) clearTimeout(t);
  timers.restartWarningTimers = [];
  timers.pendingRestart = null;
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

// Create backup before restart (if enabled) — used by routes
export async function backupBeforeRestart(serverId?: string): Promise<boolean> {
  const id = await resolveServerId(serverId);
  const cfg = schedulerConfig[id] ?? (await loadConfig(id));
  if (!cfg.backups.beforeRestart) return true;
  console.log(`[Scheduler:${id}] Creating pre-restart backup...`);
  const result = await createBackup('pre_restart', id);
  return result.success;
}

// Send welcome message to a player joining a specific server
export async function sendWelcomeMessage(playerName: string, serverId?: string): Promise<void> {
  const id = await resolveServerId(serverId);
  const cfg = schedulerConfig[id] ?? (await loadConfig(id));
  if (!cfg.announcements.enabled || !cfg.announcements.welcome) return;
  const message = cfg.announcements.welcome.replace('{player}', playerName);
  await dockerService.execCommand(`/msg ${playerName} ${message}`, id);
}

// Quick commands
export function getQuickCommands(serverId?: string): QuickCommand[] {
  const id = serverId ?? Object.keys(schedulerConfig)[0] ?? 'default';
  return schedulerConfig[id]?.quickCommands ?? DEFAULT_CONFIG.quickCommands;
}

export function addQuickCommand(command: Omit<QuickCommand, 'id'>, serverId?: string): QuickCommand {
  const id = serverId ?? Object.keys(schedulerConfig)[0] ?? 'default';
  const cfg = schedulerConfig[id] ?? { ...DEFAULT_CONFIG };
  const newCommand: QuickCommand = { ...command, id: Date.now().toString() };
  cfg.quickCommands = [...cfg.quickCommands, newCommand];
  schedulerConfig[id] = cfg;
  doSaveSync(cfg, id);
  return newCommand;
}

export function updateQuickCommand(qcId: string, updates: Partial<QuickCommand>, serverId?: string): boolean {
  const id = serverId ?? Object.keys(schedulerConfig)[0] ?? 'default';
  const cfg = schedulerConfig[id];
  if (!cfg) return false;
  const index = cfg.quickCommands.findIndex(c => c.id === qcId);
  if (index === -1) return false;
  cfg.quickCommands[index] = { ...cfg.quickCommands[index], ...updates };
  doSaveSync(cfg, id);
  return true;
}

export function deleteQuickCommand(qcId: string, serverId?: string): boolean {
  const id = serverId ?? Object.keys(schedulerConfig)[0] ?? 'default';
  const cfg = schedulerConfig[id];
  if (!cfg) return false;
  const index = cfg.quickCommands.findIndex(c => c.id === qcId);
  if (index === -1) return false;
  cfg.quickCommands.splice(index, 1);
  doSaveSync(cfg, id);
  return true;
}

// Run a configured scheduled command immediately (used by the "Run now" button).
export async function runScheduledCommandNow(commandId: string, serverId?: string): Promise<{ success: boolean; error?: string }> {
  const id = await resolveServerId(serverId);
  const cfg = schedulerConfig[id] ?? (await loadConfig(id));
  const cmd = (cfg.scheduledCommands ?? []).find(c => c.id === commandId);
  if (!cmd) return { success: false, error: 'Scheduled command not found' };
  const check = validateCommand(cmd.command);
  if (!check.valid) return { success: false, error: check.error };
  await runScheduledCommand(cmd, id);
  return { success: true };
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
  return (cfg.scheduledCommands ?? []).map(cmd => {
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
  scheduledRestarts: { enabled: boolean; nextRestart: string | null; pendingRestart: { time: string; scheduledAt: string } | null; times: string[] };
  scheduledCommands: ScheduledCommandStatus[];
}> {
  const id = await resolveServerId(serverId);
  const cfg = schedulerConfig[id] ?? (await loadConfig(id));
  const timers = timersByServer[id] ?? emptyTimers();
  const nextBackup = getNextBackupTime(id);
  const backups = await listBackups(id);
  const lastAutoBackup = backups.find(b => b.type === 'auto');
  const nextRestart = getNextRestartTime(id);

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
  } catch { /* startSchedulers will retry */ }
})();
