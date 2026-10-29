/**
 * The staging folder: downloads and uploads wait here until they are checked.
 *
 * It lies in the manager volume (MANAGER_DATA_PATH), which no game server
 * mounts: a server can neither read a file before it is checked nor plant a
 * link where the panel writes it. A file is streamed in (so neither a large
 * mod nor many uploads at once are held in memory), its size, hashes or
 * content are checked there, and only then is it copied into the server
 * folder (replaceFileFromFile in utils/noFollowFs.ts).
 *
 * The folder belongs to the panel alone (0700, files 0600). Every file is
 * removed when its download or upload ends, and the folder is emptied at
 * every start, before requests are taken, for what a crash left behind.
 */
import crypto from 'crypto';
import { constants as fsConstants, mkdirSync, rmSync } from 'fs';
import { mkdir, open, rm, type FileHandle } from 'fs/promises';
import path from 'path';
import { logger } from './logger.js';

const DIR_MODE = 0o700;
const FILE_MODE = 0o600;
// POSIX only; undefined on Windows (dev/tests).
const NO_FOLLOW = fsConstants.O_NOFOLLOW ?? 0;

export function stagingDir(): string {
  return path.join(process.env.MANAGER_DATA_PATH || '/app/data', 'staging');
}

/** The folder, created when missing (for multer's destination callback). */
export function ensureStagingDirSync(): string {
  const dir = stagingDir();
  mkdirSync(dir, { recursive: true, mode: DIR_MODE });
  return dir;
}

/** Empties the folder. Called once at start, before the server listens. */
export function resetStagingDir(): void {
  const dir = stagingDir();
  try {
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true, mode: DIR_MODE });
  } catch (err) {
    logger.error(`[Staging] Could not empty ${dir}:`, err);
  }
}

/** A new, empty file in the folder (O_EXCL), open for writing. */
export async function createStagedFile(kind: string): Promise<{ path: string; fh: FileHandle }> {
  const dir = stagingDir();
  await mkdir(dir, { recursive: true, mode: DIR_MODE });
  const file = path.join(dir, `${kind}-${crypto.randomBytes(12).toString('hex')}`);
  const flags = fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | NO_FOLLOW;
  return { path: file, fh: await open(file, flags, FILE_MODE) };
}

/** The first `bytes` bytes of a staged file, for the content checks. */
export async function readStagedHead(file: string, bytes: number): Promise<Buffer> {
  const fh = await open(file, fsConstants.O_RDONLY | NO_FOLLOW);
  try {
    const head = Buffer.alloc(bytes);
    const { bytesRead } = await fh.read(head, 0, bytes, 0);
    return head.subarray(0, bytesRead);
  } finally {
    await fh.close().catch(() => undefined);
  }
}

/** Removes a staged file; a missing one is fine. */
export async function discardStaged(file: string | undefined): Promise<void> {
  if (!file) return;
  try {
    await rm(file, { force: true });
  } catch (err) {
    // Removed at the next start at the latest.
    logger.warn(`[Staging] Could not remove ${file}:`, err);
  }
}
