/**
 * The game server's own log files (<server>/logs/<date>_server.log), read for
 * "load all" in the console.
 *
 * The server writes one file per run and keeps them, so they reach further
 * back than the container log. They are read newest first and only as far as
 * the limits allow; of the oldest file read only its end is kept. Only
 * regular files directly in the logs folder with the server's own naming are
 * opened, through utils/noFollowFs.ts: the game server can write that folder
 * and could leave a link to a panel file in it.
 */
import { readdir } from 'fs/promises';
import path from 'path';
import { UnsafeFileError, assertRegularDirectory, openRegularFile } from '../utils/noFollowFs.js';
import { parseLogs } from './logs.js';
import { resolveInstallPaths } from './serverInstall.js';
import type { LogEntry } from '../types/index.js';

// yyyy-MM-dd_HH-mm-ss_server.log; a second file of the same second gets a number.
const LOG_FILE_NAME = /^\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}\d{0,3}_server\.log$/;

export interface LogFileLimits {
  /** Files read at most, newest first. */
  maxFiles: number;
  /** Bytes read at most over all files. */
  maxBytes: number;
  /** Entries returned at most (the newest). */
  maxEntries: number;
}

export interface LogFilesResult {
  entries: LogEntry[];
  /** Names of the files read, oldest first. */
  files: string[];
  /** Older entries or files were left out to stay within the limits. */
  truncated: boolean;
}

/** Names of the server's log files, newest first. Null when the folder is not there. */
async function listLogFiles(logsDir: string, serverPath: string): Promise<string[] | null> {
  try {
    await assertRegularDirectory(logsDir, [serverPath]);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
  const dirents = await readdir(logsDir, { withFileTypes: true });
  // The names start with the run's start time, so their order is the run order.
  return dirents
    .filter((d) => d.isFile() && LOG_FILE_NAME.test(d.name))
    .map((d) => d.name)
    .sort()
    .reverse();
}

/** The last `maxBytes` of a log file, starting at a line. */
async function readLogFileEnd(
  filePath: string,
  logsDir: string,
  maxBytes: number,
): Promise<{ text: string; cut: boolean; bytes: number }> {
  const { fh, stats } = await openRegularFile(filePath, [logsDir]);
  try {
    const length = Math.min(stats.size, maxBytes);
    const start = stats.size - length;
    const buf = Buffer.alloc(length);
    let read = 0;
    while (read < length) {
      const { bytesRead } = await fh.read(buf, read, length - read, start + read);
      if (bytesRead === 0) break;
      read += bytesRead;
    }
    let text = buf.subarray(0, read).toString('utf8');
    if (start > 0) {
      // The first line is only a piece; start at the next one.
      const nl = text.indexOf('\n');
      text = nl >= 0 ? text.slice(nl + 1) : '';
    }
    return { text, cut: start > 0, bytes: read };
  } finally {
    await fh.close().catch(() => undefined);
  }
}

/**
 * Entries of the server's latest log files within the limits, oldest first.
 * Null when the server's logs folder is not available to the panel (an
 * additional server whose folder is not mounted, or no run yet).
 */
export async function readServerLogFiles(
  serverId: string | undefined,
  limits: LogFileLimits,
): Promise<LogFilesResult | null> {
  const { serverPath } = await resolveInstallPaths(serverId);
  const logsDir = path.join(serverPath, 'logs');
  const files = await listLogFiles(logsDir, serverPath);
  if (!files || files.length === 0) return null;

  let budget = limits.maxBytes;
  let truncated = files.length > limits.maxFiles;
  const read: Array<{ name: string; text: string }> = [];
  const skipped: string[] = [];
  for (const name of files.slice(0, limits.maxFiles)) {
    if (budget <= 0) {
      truncated = true;
      break;
    }
    let part: Awaited<ReturnType<typeof readLogFileEnd>>;
    try {
      part = await readLogFileEnd(path.join(logsDir, name), logsDir, budget);
    } catch (err) {
      // A link or special file under a log name, or one gone meanwhile: left out.
      if (!(err instanceof UnsafeFileError) && (err as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw err;
      }
      skipped.push(name);
      continue;
    }
    budget -= part.bytes;
    if (part.cut) truncated = true;
    read.push({ name, text: part.text });
  }
  if (skipped.length > 0) {
    console.warn(`[ServerLogFiles] Skipped unsafe or missing log files: ${skipped.join(', ')}`);
  }
  read.reverse();

  // Each file is a run of its own; records never continue across files.
  let entries = read.flatMap((f) => parseLogs(f.text));
  if (entries.length > limits.maxEntries) {
    entries = entries.slice(-limits.maxEntries);
    truncated = true;
  }
  return { entries, files: read.map((f) => f.name), truncated };
}
