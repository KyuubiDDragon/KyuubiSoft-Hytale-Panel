import type { LogEntry } from '../types/index.js';

type LogLevel = 'DEBUG' | 'INFO' | 'WARN' | 'ERROR' | 'UNKNOWN';

const LOG_PATTERNS: [RegExp, LogLevel][] = [
  // Hytale Server format: [2026/01/14 12:41:18   ERROR]
  [/\s+ERROR\]|ERROR:|SEVERE:|SEVERE\]/i, 'ERROR'],
  [/\s+WARN\]|WARN:|WARNING:|WARNING\]/i, 'WARN'],
  [/\s+DEBUG\]|DEBUG:|FINE\]|FINEST\]/i, 'DEBUG'],
  [/\s+INFO\]|INFO:/i, 'INFO'],
];

export function detectLogLevel(line: string): LogLevel {
  for (const [pattern, level] of LOG_PATTERNS) {
    if (pattern.test(line)) {
      return level;
    }
  }
  return 'INFO';
}

export function parseLogLine(line: string): LogEntry | null {
  const trimmed = line.trim();
  if (!trimmed) return null;

  const level = detectLogLevel(trimmed);

  let timestamp: string | null = null;
  let message = trimmed;

  // Hytale Server format: [2026/01/14 12:41:18   INFO] message
  const hytaleMatch = /^\[(\d{4}\/\d{2}\/\d{2}\s+\d{2}:\d{2}:\d{2})\s+\w+\]\s*(.*)$/.exec(trimmed);
  if (hytaleMatch) {
    // Convert 2026/01/14 12:41:18 to ISO format
    const dateStr = hytaleMatch[1].replace(/\//g, '-').replace(' ', 'T');
    timestamp = dateStr;
    message = hytaleMatch[2].trim();
  } else {
    // Docker logs format: 2024-01-14T12:00:00.000000000Z message
    const dockerMatch = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})/.exec(trimmed);
    if (dockerMatch) {
      timestamp = dockerMatch[1];
      message = trimmed.substring(dockerMatch[0].length).replace(/^[\.\d]*Z?\s*/, '').trim();
    }
  }

  return {
    timestamp: timestamp || new Date().toISOString(),
    level,
    message,
    raw: trimmed,
  };
}

export function parseLogs(rawLogs: string): LogEntry[] {
  const lines = rawLogs.split('\n');
  const entries: LogEntry[] = [];

  for (const line of lines) {
    const entry = parseLogLine(line);
    if (entry) {
      entries.push(entry);
    }
  }

  return entries;
}
