import fs from 'fs';
import path from 'path';
import { config } from '../config.js';
import { createBackup, listBackups, deleteBackup } from './backup.js';
import * as dockerService from './docker.js';

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
}

interface ScheduledAnnouncement {
  id: string;
  message: string;
  intervalMinutes: number;
  enabled: boolean;
}

interface QuickCommand {
  id: string;
  name: string;
  command: string;
  icon: string;
  category: string;
}

const CONFIG_FILE = path.join(config.serverPath, '..', 'manager-config.json');

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
};

let schedulerConfig: ScheduleConfig = { ...DEFAULT_CONFIG };
let backupTimer: NodeJS.Timeout | null = null;
let announcementTimers: Map<string, NodeJS.Timeout> = new Map();
let restartTimers: Map<string, NodeJS.Timeout> = new Map();
let restartWarningTimers: NodeJS.Timeout[] = [];
let pendingRestart: { time: string; scheduledAt: Date } | null = null;

// Deep merge helper for nested objects
function deepMerge<T extends Record<string, unknown>>(target: T, source: Partial<T>): T {
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
        // Recursively merge nested objects
        (result as Record<string, unknown>)[key] = deepMerge(
          targetValue as Record<string, unknown>,
          sourceValue as Record<string, unknown>
        );
      } else {
        // Direct assignment for primitives and arrays
        (result as Record<string, unknown>)[key] = sourceValue;
      }
    }
  }

  return result;
}

// Load configuration
export function loadConfig(): ScheduleConfig {
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      const data = fs.readFileSync(CONFIG_FILE, 'utf-8');
      const loaded = JSON.parse(data);
      // Use deep merge to preserve default values for missing nested properties
      schedulerConfig = deepMerge(DEFAULT_CONFIG, loaded);
      console.log('[Scheduler] Config loaded from file:', CONFIG_FILE);
    } else {
      console.log('[Scheduler] No config file found, using defaults');
    }
  } catch (error) {
    console.error('Failed to load scheduler config:', error);
  }
  return schedulerConfig;
}

// Save configuration
export function saveConfig(config: Partial<ScheduleConfig>): boolean {
  try {
    // Use deep merge to properly handle partial nested updates
    schedulerConfig = deepMerge(schedulerConfig, config);
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(schedulerConfig, null, 2));
    console.log('[Scheduler] Config saved to file:', CONFIG_FILE);

    // Restart schedulers with new config
    stopSchedulers();
    startSchedulers();

    return true;
  } catch (error) {
    console.error('Failed to save scheduler config:', error);
    return false;
  }
}

// Get configuration
export function getConfig(): ScheduleConfig {
  return schedulerConfig;
}

// Calculate next backup time
function getNextBackupTime(): Date | null {
  if (!schedulerConfig.backups.enabled || !schedulerConfig.backups.schedule) {
    return null;
  }

  const [hours, minutes] = schedulerConfig.backups.schedule.split(':').map(Number);
  const now = new Date();
  const next = new Date(now);
  next.setHours(hours, minutes, 0, 0);

  // If time already passed today, schedule for tomorrow
  if (next <= now) {
    next.setDate(next.getDate() + 1);
  }

  return next;
}

// Run automatic backup
async function runAutoBackup(): Promise<void> {
  console.log('[Scheduler] Running automatic backup...');

  const result = createBackup('auto');

  if (result.success) {
    console.log(`[Scheduler] Backup created: ${result.backup?.filename}`);

    // Clean old backups
    cleanOldBackups();
  } else {
    console.error('[Scheduler] Backup failed:', result.error);
  }
}

// Clean old backups based on retention
function cleanOldBackups(): void {
  const backups = listBackups();
  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - schedulerConfig.backups.retentionDays);

  let deleted = 0;
  for (const backup of backups) {
    if (backup.type === 'auto' && new Date(backup.created_at) < cutoffDate) {
      const result = deleteBackup(backup.id);
      if (result.success) {
        deleted++;
      }
    }
  }

  if (deleted > 0) {
    console.log(`[Scheduler] Cleaned ${deleted} old backup(s)`);
  }
}

// Send announcement to server
async function sendAnnouncement(message: string): Promise<void> {
  if (!message) return;

  try {
    await dockerService.execCommand(`/broadcast ${message}`);
    console.log(`[Scheduler] Sent announcement: ${message}`);
  } catch (error) {
    console.error('[Scheduler] Failed to send announcement:', error);
  }
}

// Calculate next restart time from configured times
function getNextRestartTime(): { time: string; date: Date } | null {
  if (!schedulerConfig.scheduledRestarts.enabled || schedulerConfig.scheduledRestarts.times.length === 0) {
    return null;
  }

  const now = new Date();
  let nearestRestart: { time: string; date: Date } | null = null;

  for (const timeStr of schedulerConfig.scheduledRestarts.times) {
    const [hours, minutes] = timeStr.split(':').map(Number);
    const restartDate = new Date(now);
    restartDate.setHours(hours, minutes, 0, 0);

    // If time already passed today, schedule for tomorrow
    if (restartDate <= now) {
      restartDate.setDate(restartDate.getDate() + 1);
    }

    if (!nearestRestart || restartDate < nearestRestart.date) {
      nearestRestart = { time: timeStr, date: restartDate };
    }
  }

  return nearestRestart;
}

// Send restart warning message
async function sendRestartWarning(minutesLeft: number): Promise<void> {
  const message = schedulerConfig.scheduledRestarts.warningMessage.replace('{minutes}', minutesLeft.toString());
  await sendAnnouncement(message);
  console.log(`[Scheduler] Sent restart warning: ${minutesLeft} minutes remaining`);
}

// Execute the scheduled restart
async function executeScheduledRestart(): Promise<void> {
  console.log('[Scheduler] Executing scheduled restart...');

  // Send final restart message
  await sendAnnouncement(schedulerConfig.scheduledRestarts.restartMessage);

  // Wait a moment for the message to be sent
  await new Promise(resolve => setTimeout(resolve, 2000));

  // Create backup if enabled
  if (schedulerConfig.scheduledRestarts.createBackup) {
    console.log('[Scheduler] Creating pre-restart backup...');
    const result = createBackup('scheduled_restart');
    if (result.success) {
      console.log(`[Scheduler] Pre-restart backup created: ${result.backup?.filename}`);
    } else {
      console.error('[Scheduler] Pre-restart backup failed:', result.error);
    }
  }

  // Restart the server
  const restartResult = await dockerService.restartContainer();
  if (restartResult.success) {
    console.log('[Scheduler] Server restart initiated successfully');
  } else {
    console.error('[Scheduler] Server restart failed:', restartResult.error);
  }

  // Clear pending restart
  pendingRestart = null;

  // Schedule next restart
  scheduleNextRestart();
}

// Schedule a single restart with warnings
function scheduleRestartWithWarnings(restartTime: Date, timeStr: string): void {
  const now = Date.now();
  const restartMs = restartTime.getTime();
  const msUntilRestart = restartMs - now;

  // Clear any existing warning timers
  for (const timer of restartWarningTimers) {
    clearTimeout(timer);
  }
  restartWarningTimers = [];

  // Schedule warning messages
  for (const warningMinutes of schedulerConfig.scheduledRestarts.warningMinutes) {
    const warningMs = msUntilRestart - (warningMinutes * 60 * 1000);
    if (warningMs > 0) {
      const timer = setTimeout(() => {
        sendRestartWarning(warningMinutes);
      }, warningMs);
      restartWarningTimers.push(timer);
    }
  }

  // Schedule the actual restart
  const restartTimer = setTimeout(() => {
    executeScheduledRestart();
  }, msUntilRestart);
  restartTimers.set(timeStr, restartTimer);

  // Store pending restart info
  pendingRestart = { time: timeStr, scheduledAt: restartTime };

  console.log(`[Scheduler] Restart scheduled for ${restartTime.toISOString()} (in ${Math.round(msUntilRestart / 60000)} minutes)`);
}

// Schedule the next restart
function scheduleNextRestart(): void {
  // Clear existing restart timers
  for (const [, timer] of restartTimers) {
    clearTimeout(timer);
  }
  restartTimers.clear();

  for (const timer of restartWarningTimers) {
    clearTimeout(timer);
  }
  restartWarningTimers = [];
  pendingRestart = null;

  if (!schedulerConfig.scheduledRestarts.enabled) {
    return;
  }

  const nextRestart = getNextRestartTime();
  if (nextRestart) {
    scheduleRestartWithWarnings(nextRestart.date, nextRestart.time);
  }
}

// Cancel pending restart
export function cancelPendingRestart(): boolean {
  if (!pendingRestart) {
    return false;
  }

  // Clear timers
  for (const [, timer] of restartTimers) {
    clearTimeout(timer);
  }
  restartTimers.clear();

  for (const timer of restartWarningTimers) {
    clearTimeout(timer);
  }
  restartWarningTimers = [];

  console.log(`[Scheduler] Cancelled pending restart that was scheduled for ${pendingRestart.scheduledAt.toISOString()}`);
  pendingRestart = null;

  // Re-schedule for the next time slot
  setTimeout(() => {
    scheduleNextRestart();
  }, 60000); // Wait 1 minute before re-scheduling

  return true;
}

// Get pending restart info
export function getPendingRestart(): { time: string; scheduledAt: string } | null {
  if (!pendingRestart) {
    return null;
  }
  return {
    time: pendingRestart.time,
    scheduledAt: pendingRestart.scheduledAt.toISOString(),
  };
}

// Start all schedulers
export function startSchedulers(): void {
  loadConfig();

  console.log('[Scheduler] Starting schedulers with config:', {
    backups: { enabled: schedulerConfig.backups.enabled, schedule: schedulerConfig.backups.schedule },
    announcements: { enabled: schedulerConfig.announcements.enabled },
    scheduledRestarts: {
      enabled: schedulerConfig.scheduledRestarts.enabled,
      times: schedulerConfig.scheduledRestarts.times
    }
  });

  // Start backup scheduler
  if (schedulerConfig.backups.enabled) {
    const nextBackup = getNextBackupTime();
    if (nextBackup) {
      const msUntilBackup = nextBackup.getTime() - Date.now();

      backupTimer = setTimeout(() => {
        runAutoBackup();
        // Schedule next backup in 24 hours
        backupTimer = setInterval(runAutoBackup, 24 * 60 * 60 * 1000);
      }, msUntilBackup);

      console.log(`[Scheduler] Next backup scheduled for ${nextBackup.toISOString()}`);
    }
  }

  // Start announcement schedulers
  if (schedulerConfig.announcements.enabled) {
    for (const announcement of schedulerConfig.announcements.scheduled) {
      if (announcement.enabled && announcement.intervalMinutes > 0) {
        const timer = setInterval(() => {
          sendAnnouncement(announcement.message);
        }, announcement.intervalMinutes * 60 * 1000);

        announcementTimers.set(announcement.id, timer);
        console.log(`[Scheduler] Announcement "${announcement.id}" scheduled every ${announcement.intervalMinutes} minutes`);
      }
    }
  }

  // Start scheduled restart scheduler
  scheduleNextRestart();
}

// Stop all schedulers
export function stopSchedulers(): void {
  if (backupTimer) {
    clearTimeout(backupTimer);
    clearInterval(backupTimer);
    backupTimer = null;
  }

  for (const [, timer] of announcementTimers) {
    clearInterval(timer);
  }
  announcementTimers.clear();

  // Stop restart timers
  for (const [, timer] of restartTimers) {
    clearTimeout(timer);
  }
  restartTimers.clear();

  for (const timer of restartWarningTimers) {
    clearTimeout(timer);
  }
  restartWarningTimers = [];
  pendingRestart = null;

  console.log('[Scheduler] All schedulers stopped');
}

// Create backup before restart (if enabled)
export async function backupBeforeRestart(): Promise<boolean> {
  if (!schedulerConfig.backups.beforeRestart) {
    return true;
  }

  console.log('[Scheduler] Creating pre-restart backup...');
  const result = createBackup('pre_restart');
  return result.success;
}

// Send welcome message to player
export async function sendWelcomeMessage(playerName: string): Promise<void> {
  if (!schedulerConfig.announcements.enabled || !schedulerConfig.announcements.welcome) {
    return;
  }

  const message = schedulerConfig.announcements.welcome.replace('{player}', playerName);
  await dockerService.execCommand(`/msg ${playerName} ${message}`);
}

// Quick commands
export function getQuickCommands(): QuickCommand[] {
  return schedulerConfig.quickCommands;
}

export function addQuickCommand(command: Omit<QuickCommand, 'id'>): QuickCommand {
  const newCommand: QuickCommand = {
    ...command,
    id: Date.now().toString(),
  };
  schedulerConfig.quickCommands.push(newCommand);
  saveConfig(schedulerConfig);
  return newCommand;
}

export function updateQuickCommand(id: string, updates: Partial<QuickCommand>): boolean {
  const index = schedulerConfig.quickCommands.findIndex(c => c.id === id);
  if (index === -1) return false;

  schedulerConfig.quickCommands[index] = { ...schedulerConfig.quickCommands[index], ...updates };
  saveConfig(schedulerConfig);
  return true;
}

export function deleteQuickCommand(id: string): boolean {
  const index = schedulerConfig.quickCommands.findIndex(c => c.id === id);
  if (index === -1) return false;

  schedulerConfig.quickCommands.splice(index, 1);
  saveConfig(schedulerConfig);
  return true;
}

// Get scheduler status
export function getSchedulerStatus(): {
  backups: { enabled: boolean; nextRun: string | null; lastRun: string | null; schedule: string };
  announcements: { enabled: boolean; activeCount: number };
  scheduledRestarts: { enabled: boolean; nextRestart: string | null; pendingRestart: { time: string; scheduledAt: string } | null; times: string[] };
} {
  const nextBackup = getNextBackupTime();
  const backups = listBackups();
  const lastAutoBackup = backups.find(b => b.type === 'auto');
  const nextRestart = getNextRestartTime();

  return {
    backups: {
      enabled: schedulerConfig.backups.enabled,
      nextRun: nextBackup?.toISOString() || null,
      lastRun: lastAutoBackup?.created_at || null,
      schedule: schedulerConfig.backups.schedule,
    },
    announcements: {
      enabled: schedulerConfig.announcements.enabled,
      activeCount: announcementTimers.size,
    },
    scheduledRestarts: {
      enabled: schedulerConfig.scheduledRestarts.enabled,
      nextRestart: nextRestart?.date.toISOString() || null,
      pendingRestart: getPendingRestart(),
      times: schedulerConfig.scheduledRestarts.times,
    },
  };
}

// Initialize on module load
loadConfig();
