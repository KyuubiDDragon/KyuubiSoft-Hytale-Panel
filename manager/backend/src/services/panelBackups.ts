/**
 * Where the panel keeps its self-backups (snapshots of panel.sqlite and the
 * config/users/servers JSON, see backupPanelData in services/backup.ts), and
 * the one-time move of the copies older versions left on the backups volume.
 *
 * The self-backups hold password hashes, API keys and possibly the JWT
 * secret, so they live in the manager's own data volume, which no game
 * container mounts. Older versions wrote them to `<backups>/_panel/`, a
 * folder the game server can read and write. migrateLegacyPanelBackups()
 * moves those copies here on boot:
 *
 *  - nothing on the backups volume is trusted: `_panel` must be a real
 *    folder, every file is opened without following links and must be a
 *    regular file of a plausible size with the name the panel used;
 *  - the copies land in a subfolder of their own (named `legacy-…`), because
 *    the game server could have changed them while they lay on its volume;
 *  - size, total and the free space of the manager volume are capped, so a
 *    planted file cannot fill it;
 *  - nothing below `_panel` is deleted recursively (a folder there can be
 *    swapped for a link at any time); unfinished snapshots are only named;
 *  - a copy is removed from the backups volume only after it was written and
 *    synced here; if the copy fails it stays, a warning is logged and the
 *    move is tried again on the next start;
 *  - once a run has completed, a marker stops later runs, so files the game
 *    server places there afterwards are never imported.
 */
import fs, { constants as fsConstants, promises as fsp } from 'fs';
import type { FileHandle } from 'fs/promises';
import path from 'path';
import { config } from '../config.js';
import { listServers } from './servers.js';

const MANAGER_DATA_DIR = process.env.MANAGER_DATA_PATH || '/app/data';

/** Panel self-backups (manager data volume only). */
export const PANEL_BACKUP_DIR = path.join(MANAGER_DATA_DIR, 'panel-backups');
/** Copies moved over from the backups volume. */
export const IMPORTED_PANEL_BACKUP_DIR = path.join(PANEL_BACKUP_DIR, 'from-backups-volume');

const LEGACY_DIR_NAME = '_panel';
const MIGRATION_MARKER = path.join(PANEL_BACKUP_DIR, '.backups-volume-migrated');
const LEGACY_BACKUP_NAME = /^panel-config_\d{4}-\d{2}-\d{2}_\d{4}(?:\d{2})?\.tar\.gz$/;
const LEGACY_STAGE_NAME = /^\.stage_/;
// Copies keep the old name behind this prefix. Nothing in the manager volume
// then matches LEGACY_BACKUP_NAME, so even a `_panel` swapped for a link
// right before the cleanup can never make it remove a file of the manager.
const IMPORTED_PREFIX = 'legacy-';
const MIB = 1024 * 1024;
// A self-backup is a few MB; the caps only keep planted files from filling
// the manager volume.
const MAX_IMPORT_BYTES = 256 * MIB;
const MAX_IMPORT_TOTAL_BYTES = 1024 * MIB;
const FREE_SPACE_RESERVE_BYTES = 512 * MIB;
// The old retention kept 14 per backups folder.
const MAX_IMPORT_FILES = 100;
// How many left-behind entries the warning names one by one.
const MAX_LISTED = 20;
const COPY_CHUNK_BYTES = 1024 * 1024;
const DIR_MODE = 0o700;
const FILE_MODE = 0o600;
// O_NOFOLLOW is POSIX only; on Windows (dev/tests) it is undefined.
const NO_FOLLOW = fsConstants.O_NOFOLLOW ?? 0;
const NON_BLOCK = fsConstants.O_NONBLOCK ?? 0;

/** Create the self-backup folder (owner only). */
export async function ensurePanelBackupDir(): Promise<string> {
  await fsp.mkdir(PANEL_BACKUP_DIR, { recursive: true, mode: DIR_MODE });
  await fsp.chmod(PANEL_BACKUP_DIR, DIR_MODE).catch(() => undefined);
  return PANEL_BACKUP_DIR;
}

interface MigrationTally {
  moved: number;
  refused: string[];
  failed: boolean;
  budget: number;
  bytesLeft: number;
}

function warn(message: string): void {
  console.warn(`[PanelBackup] ${message}`);
}

/** The legacy folder is still the real folder we looked at (not swapped for a link). */
async function isSameDir(dir: string, expected: fs.Stats): Promise<boolean> {
  try {
    const st = await fsp.lstat(dir);
    return st.isDirectory() && st.dev === expected.dev && st.ino === expected.ino;
  } catch {
    return false;
  }
}

/** A free name in the import folder (two backups folders may hold the same name). */
function freeImportPath(name: string): string {
  const base = `${IMPORTED_PREFIX}${name.replace(/\.tar\.gz$/, '')}`;
  for (let i = 1; i < 1000; i++) {
    const candidate = path.join(
      IMPORTED_PANEL_BACKUP_DIR,
      i === 1 ? `${base}.tar.gz` : `${base}-${i}.tar.gz`,
    );
    if (!fs.existsSync(candidate)) return candidate;
  }
  throw new Error(`no free name for ${name}`);
}

async function freeBytes(dir: string): Promise<number | null> {
  try {
    const st = await fsp.statfs(dir);
    return st.bavail * st.bsize;
  } catch {
    return null;
  }
}

/** Copy the first `size` bytes (what was there when the source was opened). */
async function copyHandle(input: FileHandle, output: FileHandle, size: number): Promise<void> {
  const buf = Buffer.alloc(Math.min(COPY_CHUNK_BYTES, Math.max(size, 1)));
  let position = 0;
  while (position < size) {
    const { bytesRead } = await input.read(buf, 0, Math.min(buf.length, size - position), position);
    if (bytesRead === 0) throw new Error('the file got shorter while it was copied');
    let written = 0;
    while (written < bytesRead) {
      written += (await output.write(buf, written, bytesRead - written)).bytesWritten;
    }
    position += bytesRead;
  }
}

/**
 * Copy one file out of the legacy folder without following links and remove
 * the original. Returns a reason when the file was refused (left in place).
 */
async function moveLegacyFile(
  legacyDir: string,
  legacyStat: fs.Stats,
  name: string,
  tally: MigrationTally,
): Promise<string | null> {
  const source = path.join(legacyDir, name);
  let input: FileHandle;
  try {
    input = await fsp.open(source, fsConstants.O_RDONLY | NO_FOLLOW | NON_BLOCK);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ELOOP') return 'it is a symbolic link';
    throw err;
  }
  let target: string;
  let sourceStat: fs.Stats;
  try {
    sourceStat = await input.stat();
    if (!sourceStat.isFile()) return 'it is not a regular file';
    if (sourceStat.size > MAX_IMPORT_BYTES) return 'it is larger than any panel backup';
    if (sourceStat.size > tally.bytesLeft) return 'more data than panel backups ever held';
    const free = await freeBytes(IMPORTED_PANEL_BACKUP_DIR);
    if (free !== null && free < sourceStat.size + FREE_SPACE_RESERVE_BYTES) {
      return 'not enough free space in the manager volume';
    }
    tally.bytesLeft -= sourceStat.size;
    target = freeImportPath(name);
    const temp = `${target}.partial`;
    await fsp.rm(temp, { force: true }); // left by a crash during an earlier run
    const output = await fsp.open(temp, 'wx', FILE_MODE);
    try {
      await copyHandle(input, output, sourceStat.size);
      await output.sync();
    } catch (err) {
      await output.close().catch(() => undefined);
      await fsp.rm(temp, { force: true });
      throw err;
    }
    await output.close();
    await fsp.rename(temp, target);
  } finally {
    await input.close();
  }
  // Remove the original only if the path still names the file that was copied.
  const now = await fsp.lstat(source).catch(() => null);
  if (
    !(await isSameDir(legacyDir, legacyStat)) ||
    !now ||
    now.dev !== sourceStat.dev ||
    now.ino !== sourceStat.ino
  ) {
    warn(`${source} changed while it was moved; the copy is in ${target}, the original was left.`);
    return null;
  }
  try {
    await fsp.unlink(source);
  } catch (err) {
    // The copy is complete: no retry (that would only copy it again).
    warn(
      `${source} was copied to ${target} but could not be removed (${
        err instanceof Error ? err.message : err
      }); delete it by hand.`,
    );
  }
  return null;
}

/** Move the self-backups out of one backups folder. */
async function migrateFrom(backupsDir: string, tally: MigrationTally): Promise<void> {
  const legacyDir = path.join(backupsDir, LEGACY_DIR_NAME);
  let legacyStat: fs.Stats;
  try {
    legacyStat = await fsp.lstat(legacyDir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw err;
  }
  if (!legacyStat.isDirectory()) {
    tally.refused.push(`${legacyDir} (not a real folder)`);
    return;
  }

  const names = (await fsp.readdir(legacyDir)).sort().reverse(); // newest first
  for (const name of names) {
    const full = path.join(legacyDir, name);
    if (LEGACY_STAGE_NAME.test(name)) {
      // Half-written snapshot of a crashed backup. Not removed here: deleting
      // a tree the game server controls follows whatever it swaps in meanwhile.
      tally.refused.push(
        `${full} (an unfinished panel backup that may hold copies of panel files)`,
      );
      continue;
    }
    if (!LEGACY_BACKUP_NAME.test(name)) {
      tally.refused.push(`${full} (not a panel backup)`);
      continue;
    }
    if (tally.budget <= 0) {
      tally.refused.push(`${full} (more files than a panel ever kept)`);
      continue;
    }
    tally.budget--;
    try {
      const reason = await moveLegacyFile(legacyDir, legacyStat, name, tally);
      if (reason) tally.refused.push(`${full} (${reason})`);
      else tally.moved++;
    } catch (err) {
      tally.failed = true;
      warn(
        `Could not move ${full} out of the backups volume (${
          err instanceof Error ? err.message : err
        }); it stays there and the move is retried on the next start.`,
      );
    }
  }
  // Gone once it is empty; anything left behind is named in the warning.
  if (await isSameDir(legacyDir, legacyStat)) await fsp.rmdir(legacyDir).catch(() => undefined);
}

async function defaultBackupsDirs(): Promise<string[]> {
  const dirs = [config.backupsPath];
  try {
    for (const s of await listServers()) dirs.push(s.paths.backups);
  } catch {
    /* registry not ready; the default folder is covered */
  }
  return dirs;
}

/**
 * Move panel self-backups from `<backups>/_panel/` (older versions) into
 * IMPORTED_PANEL_BACKUP_DIR. Runs once; never throws.
 */
export async function migrateLegacyPanelBackups(backupsDirs?: string[]): Promise<void> {
  try {
    if (fs.existsSync(MIGRATION_MARKER)) return;
    const dirs = [...new Set(backupsDirs ?? (await defaultBackupsDirs()))];
    await ensurePanelBackupDir();
    await fsp.mkdir(IMPORTED_PANEL_BACKUP_DIR, { recursive: true, mode: DIR_MODE });
    const tally: MigrationTally = {
      moved: 0,
      refused: [],
      failed: false,
      budget: MAX_IMPORT_FILES,
      bytesLeft: MAX_IMPORT_TOTAL_BYTES,
    };
    for (const dir of dirs) {
      try {
        await migrateFrom(dir, tally);
      } catch (err) {
        tally.failed = true;
        warn(
          `Could not check ${path.join(dir, LEGACY_DIR_NAME)} for old panel backups (${
            err instanceof Error ? err.message : err
          }); retried on the next start.`,
        );
      }
    }
    if (tally.moved > 0) {
      console.log(
        `[PanelBackup] Moved ${tally.moved} panel backup(s) from the backups volume to ${IMPORTED_PANEL_BACKUP_DIR}.`,
      );
    }
    if (tally.refused.length > 0) {
      const more = tally.refused.length - MAX_LISTED;
      warn(
        `Left on the backups volume (delete by hand if not needed): ${tally.refused
          .slice(0, MAX_LISTED)
          .join(', ')}${more > 0 ? ` and ${more} more` : ''}`,
      );
    }
    if (!tally.failed) {
      await fsp.writeFile(MIGRATION_MARKER, `${new Date().toISOString()}\n`, { mode: FILE_MODE });
    }
  } catch (err) {
    warn(
      `Moving old panel backups off the backups volume failed (${
        err instanceof Error ? err.message : err
      }); retried on the next start.`,
    );
  }
}
