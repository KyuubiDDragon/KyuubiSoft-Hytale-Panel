import { readFile, writeFile, mkdir } from 'fs/promises';
import path from 'path';

// Activity log entry
export interface ActivityLogEntry {
  id: string;
  timestamp: string;
  user: string;
  action: string;
  target?: string;
  details?: string;
  category: 'player' | 'server' | 'backup' | 'config' | 'mod' | 'user' | 'system';
  success: boolean;
}

// In-memory log storage (recent entries)
const activityLog: ActivityLogEntry[] = [];
const MAX_LOG_ENTRIES = 500;

// Path to persistent log file
const DATA_DIR = process.env.DATA_PATH || '/app/data';
const LOG_FILE = path.join(DATA_DIR, 'activity-log.json');

// Generate unique ID
function generateId(): string {
  return `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
}

// Ensure data directory exists
async function ensureDataDir(): Promise<void> {
  try {
    await mkdir(DATA_DIR, { recursive: true });
  } catch {
    // Directory may already exist
  }
}

// Load logs from file on startup
export async function loadActivityLog(): Promise<void> {
  try {
    const content = await readFile(LOG_FILE, 'utf-8');
    const data = JSON.parse(content);
    if (Array.isArray(data)) {
      activityLog.push(...data.slice(-MAX_LOG_ENTRIES));
    }
  } catch {
    // File doesn't exist or is invalid, start with empty log
  }
}

// Save logs to file
async function saveLogs(): Promise<void> {
  await ensureDataDir();
  await writeFile(LOG_FILE, JSON.stringify(activityLog.slice(-MAX_LOG_ENTRIES), null, 2), 'utf-8');
}

// Add new log entry
export async function logActivity(
  user: string,
  action: string,
  category: ActivityLogEntry['category'],
  success: boolean,
  target?: string,
  details?: string
): Promise<ActivityLogEntry> {
  const entry: ActivityLogEntry = {
    id: generateId(),
    timestamp: new Date().toISOString(),
    user,
    action,
    target,
    details,
    category,
    success,
  };

  activityLog.push(entry);

  // Keep only recent entries in memory
  while (activityLog.length > MAX_LOG_ENTRIES) {
    activityLog.shift();
  }

  // Save to file (async, don't await to avoid blocking)
  saveLogs().catch(console.error);

  return entry;
}

// Get activity log entries
export function getActivityLog(options?: {
  limit?: number;
  offset?: number;
  category?: ActivityLogEntry['category'];
  user?: string;
}): { entries: ActivityLogEntry[]; total: number } {
  let entries = [...activityLog].reverse(); // Most recent first

  // Filter by category
  if (options?.category) {
    entries = entries.filter(e => e.category === options.category);
  }

  // Filter by user
  if (options?.user) {
    entries = entries.filter(e => e.user === options.user);
  }

  const total = entries.length;

  // Apply pagination
  if (options?.offset) {
    entries = entries.slice(options.offset);
  }
  if (options?.limit) {
    entries = entries.slice(0, options.limit);
  }

  return { entries, total };
}

// Clear activity log
export async function clearActivityLog(): Promise<void> {
  activityLog.length = 0;
  await saveLogs();
}

// Initialize log on module load
loadActivityLog().catch(console.error);
