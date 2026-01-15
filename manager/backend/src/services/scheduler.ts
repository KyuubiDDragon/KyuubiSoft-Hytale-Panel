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

// Load configuration
export function loadConfig(): ScheduleConfig {
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      const data = fs.readFileSync(CONFIG_FILE, 'utf-8');
      const loaded = JSON.parse(data);
      schedulerConfig = { ...DEFAULT_CONFIG, ...loaded };
    }
  } catch (error) {
    console.error('Failed to load scheduler config:', error);
  }
  return schedulerConfig;
}

// Save configuration
export function saveConfig(config: Partial<ScheduleConfig>): boolean {
  try {
    schedulerConfig = { ...schedulerConfig, ...config };
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(schedulerConfig, null, 2));

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

// Start all schedulers
export function startSchedulers(): void {
  loadConfig();

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
}

// Stop all schedulers
export function stopSchedulers(): void {
  if (backupTimer) {
    clearTimeout(backupTimer);
    clearInterval(backupTimer);
    backupTimer = null;
  }

  for (const [id, timer] of announcementTimers) {
    clearInterval(timer);
  }
  announcementTimers.clear();

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
  backups: { enabled: boolean; nextRun: string | null; lastRun: string | null };
  announcements: { enabled: boolean; activeCount: number };
} {
  const nextBackup = getNextBackupTime();
  const backups = listBackups();
  const lastAutoBackup = backups.find(b => b.type === 'auto');

  return {
    backups: {
      enabled: schedulerConfig.backups.enabled,
      nextRun: nextBackup?.toISOString() || null,
      lastRun: lastAutoBackup?.created_at || null,
    },
    announcements: {
      enabled: schedulerConfig.announcements.enabled,
      activeCount: announcementTimers.size,
    },
  };
}

// Initialize on module load
loadConfig();
