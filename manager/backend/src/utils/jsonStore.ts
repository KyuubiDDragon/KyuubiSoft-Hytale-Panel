/**
 * Safe access to JSON files that several code paths read-modify-write
 * (users.json above all).
 *
 *  - readJsonFile: `null` ONLY when the file does not exist. Invalid JSON or
 *    an unexpected structure throws JsonFileCorruptError (and keeps a copy of
 *    the broken file), any other I/O error is rethrown. Callers must never
 *    treat a damaged file as "empty" and write a fresh one over it.
 *  - writeJsonAtomic: tmp file in the same directory → fsync → rename, so a
 *    reader sees either the old or the new content, never a half-written file.
 *  - withFileLock / updateJsonFile: per-file promise queue so concurrent
 *    read-modify-write cycles inside this process cannot lose each other's
 *    changes. The lock is NOT re-entrant and does not cover other processes.
 *
 * Deliberately free of config/service imports so the recovery CLI can use it.
 */
import {
  readFile,
  writeFile,
  open,
  rename,
  stat,
  unlink,
  copyFile,
  chmod,
  constants as fsConstants,
} from 'fs/promises';
import path from 'path';
import crypto from 'crypto';
import { readRegularFile } from './noFollowFs.js';

const NEW_FILE_MODE = 0o600;
const RENAME_RETRY_CODES = new Set(['EPERM', 'EACCES', 'EBUSY']);
const RENAME_MAX_ATTEMPTS = 10;
const RENAME_RETRY_BASE_MS = 15;
// A target that is itself a mount point (single-file Docker bind mount) or on
// another device cannot be replaced by rename.
const IN_PLACE_FALLBACK_CODES = new Set(['EBUSY', 'EXDEV']);

export class JsonFileCorruptError extends Error {
  readonly code = 'EJSONCORRUPT';

  constructor(
    readonly filePath: string,
    readonly reason: string,
    readonly backupPath: string | null,
  ) {
    super(
      `${path.basename(filePath)} is corrupt (${reason}); refusing to use or overwrite it.` +
        (backupPath ? ` A copy was saved as ${path.basename(backupPath)}.` : ''),
    );
    this.name = 'JsonFileCorruptError';
  }
}

export interface ReadJsonOptions {
  /** Structural check; returning false marks the file as corrupt. */
  isValid?: (value: unknown) => boolean;
  /**
   * For files in directories the game server can write to: only a regular
   * file inside one of these directories is read (no symlink, no extra hard
   * link, see noFollowFs), and a corrupt copy is written from what was read.
   */
  confineTo?: string[];
}

// A JSON file in a server folder bigger than this is not one the panel wrote.
const CONFINED_MAX_BYTES = 16 * 1024 * 1024;

export interface WriteJsonOptions {
  /** Mode for a newly created file. An existing file keeps its mode. */
  mode?: number;
}

// ============================================================
// Lock
// ============================================================

const lockTails = new Map<string, Promise<void>>();

function lockKey(filePath: string): string {
  const resolved = path.resolve(filePath);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

/**
 * Runs `fn` after every earlier critical section for the same file has
 * finished. Not re-entrant: calling it again for the same file from inside
 * `fn` deadlocks.
 */
export async function withFileLock<T>(filePath: string, fn: () => Promise<T>): Promise<T> {
  const key = lockKey(filePath);
  const previous = lockTails.get(key) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = previous.then(() => current);
  lockTails.set(key, tail);

  await previous;
  try {
    return await fn();
  } finally {
    release();
    if (lockTails.get(key) === tail) lockTails.delete(key);
  }
}

// ============================================================
// Read
// ============================================================

// One preserved copy per distinct broken content (size + mtime), so a file
// that is read on every request does not produce a copy per request.
const corruptCopies = new Map<string, Promise<string | null>>();

async function preserveCorruptCopy(
  filePath: string,
  confinedContent?: string,
): Promise<string | null> {
  let signature: string;
  try {
    const st = await stat(filePath);
    signature = `${lockKey(filePath)}|${st.size}|${st.mtimeMs}`;
  } catch {
    return null;
  }

  const known = corruptCopies.get(signature);
  if (known) return known;

  const pending = (async () => {
    const backupPath = `${filePath}.corrupt-${new Date().toISOString().replace(/[:.]/g, '-')}`;
    try {
      if (confinedContent !== undefined) {
        // Not copied from the path again: that could now be a link.
        await writeFile(backupPath, confinedContent, { flag: 'wx', mode: NEW_FILE_MODE });
      } else {
        await copyFile(filePath, backupPath, fsConstants.COPYFILE_EXCL);
      }
      await chmod(backupPath, NEW_FILE_MODE).catch(() => {});
      console.error(
        `[JsonStore] ${filePath} is corrupt. It is left untouched; a copy was saved as ${backupPath}. ` +
          'Repair the file or restore it from a backup.',
      );
      return backupPath;
    } catch (err) {
      console.error(`[JsonStore] ${filePath} is corrupt and no copy could be saved:`, err);
      return null;
    }
  })();
  corruptCopies.set(signature, pending);
  return pending;
}

/**
 * Reads and parses a JSON file. Returns null only when it does not exist.
 */
export async function readJsonFile<T>(
  filePath: string,
  options: ReadJsonOptions = {},
): Promise<T | null> {
  let raw: string;
  try {
    raw = options.confineTo
      ? (
          await readRegularFile(filePath, options.confineTo, { maxBytes: CONFINED_MAX_BYTES })
        ).toString('utf-8')
      : await readFile(filePath, 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
  const confinedContent = options.confineTo ? raw : undefined;

  let parsed: unknown;
  try {
    // Tolerate a BOM left by Windows editors.
    parsed = JSON.parse(raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw);
  } catch {
    // The parser message is not included: recent V8 versions quote a slice
    // of the input, which here would be password hashes or TOTP secrets.
    throw new JsonFileCorruptError(
      filePath,
      'invalid JSON',
      await preserveCorruptCopy(filePath, confinedContent),
    );
  }

  if (options.isValid && !options.isValid(parsed)) {
    throw new JsonFileCorruptError(
      filePath,
      'unexpected structure',
      await preserveCorruptCopy(filePath, confinedContent),
    );
  }
  return parsed as T;
}

// ============================================================
// Write
// ============================================================

async function renameWithRetry(from: string, to: string): Promise<void> {
  // Windows refuses to replace a file that a scanner or indexer has open
  // (EPERM/EACCES/EBUSY) for a short moment; retry briefly. POSIX renames
  // either work at once or fail for good.
  for (let attempt = 1; ; attempt++) {
    try {
      await rename(from, to);
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code ?? '';
      if (
        process.platform !== 'win32' ||
        !RENAME_RETRY_CODES.has(code) ||
        attempt >= RENAME_MAX_ATTEMPTS
      ) {
        throw err;
      }
      await new Promise((resolve) => setTimeout(resolve, RENAME_RETRY_BASE_MS * attempt));
    }
  }
}

const inPlaceWarned = new Set<string>();

// Last resort when rename cannot replace the target: rewrite it in place.
// Not atomic (the behaviour before this store existed), so say so once.
async function writeInPlace(filePath: string, content: string, code: string): Promise<void> {
  const fh = await open(filePath, 'w');
  try {
    await fh.writeFile(content, 'utf-8');
    await fh.sync();
  } finally {
    await fh.close();
  }
  if (!inPlaceWarned.has(filePath)) {
    inPlaceWarned.add(filePath);
    console.warn(
      `[JsonStore] ${filePath} cannot be replaced atomically (${code}); rewriting it in place. ` +
        'Mount its directory instead of the single file to get crash-safe writes.',
    );
  }
}

async function syncDirectory(dir: string): Promise<void> {
  // Makes the rename itself durable. Windows cannot open directories.
  if (process.platform === 'win32') return;
  try {
    const dh = await open(dir, 'r');
    try {
      await dh.sync();
    } finally {
      await dh.close();
    }
  } catch {
    // Best effort: some filesystems reject fsync on directories.
  }
}

/**
 * Atomically replaces `filePath` with `data` serialised as pretty JSON.
 * Keeps the existing file's mode; when running as root (recovery CLI via
 * `docker exec`) it also keeps the owner, so the panel user can still write
 * the file afterwards. New files get `options.mode` (default 0600).
 * A target that rename cannot replace (single-file bind mount) is rewritten
 * in place instead, with a one-time warning.
 */
export async function writeJsonAtomic(
  filePath: string,
  data: unknown,
  options: WriteJsonOptions = {},
): Promise<void> {
  const content = JSON.stringify(data, null, 2);
  const dir = path.dirname(filePath);

  let mode = options.mode ?? NEW_FILE_MODE;
  let owner: { uid: number; gid: number } | null = null;
  try {
    const st = await stat(filePath);
    mode = st.mode & 0o777;
    owner = { uid: st.uid, gid: st.gid };
  } catch {
    try {
      const st = await stat(dir);
      owner = { uid: st.uid, gid: st.gid };
    } catch {
      // Missing directory: surfaced by open() below.
    }
  }

  const tmpPath = path.join(
    dir,
    `${path.basename(filePath)}.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`,
  );
  const fh = await open(tmpPath, 'wx', mode);
  try {
    try {
      await fh.chmod(mode).catch(() => {});
      if (owner && typeof process.getuid === 'function' && process.getuid() === 0) {
        await fh.chown(owner.uid, owner.gid).catch(() => {});
      }
      await fh.writeFile(content, 'utf-8');
      await fh.sync();
    } finally {
      await fh.close();
    }
    try {
      await renameWithRetry(tmpPath, filePath);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code ?? '';
      if (!IN_PLACE_FALLBACK_CODES.has(code)) throw err;
      await writeInPlace(filePath, content, code);
      await unlink(tmpPath).catch(() => {});
      return;
    }
  } catch (err) {
    await unlink(tmpPath).catch(() => {});
    throw err;
  }
  await syncDirectory(dir);
}

/**
 * Serialised read-modify-write. `mutate` gets the current content (null when
 * the file does not exist) and returns the content to write, or undefined to
 * leave the file untouched; throwing aborts without writing. A corrupt file
 * throws before `mutate` runs. Resolves to the file's content afterwards.
 */
export async function updateJsonFile<T>(
  filePath: string,
  mutate: (current: T | null) => T | undefined | Promise<T | undefined>,
  options: ReadJsonOptions & WriteJsonOptions = {},
): Promise<T | null> {
  return withFileLock(filePath, async () => {
    const current = await readJsonFile<T>(filePath, options);
    const next = await mutate(current);
    if (next === undefined) return current;
    await writeJsonAtomic(filePath, next, options);
    return next;
  });
}
