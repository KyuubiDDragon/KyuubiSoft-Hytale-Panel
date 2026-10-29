/**
 * After an update is in place: remove the file of the old version. The store
 * installers download first and only then call this, so a failed download
 * keeps the old version. When the update kept the file name (or the names
 * only differ in case on a case-insensitive disk) the old path is the new
 * file and stays.
 */
import { lstat, unlink } from 'fs/promises';
import { logger } from './logger.js';

async function sameFile(a: string, b: string): Promise<boolean> {
  try {
    const [x, y] = await Promise.all([lstat(a), lstat(b)]);
    return x.dev === y.dev && x.ino === y.ino;
  } catch {
    return false;
  }
}

/**
 * Deletes `oldPath` unless it is `newPath`. `oldPath` null means the stored
 * name was not a plain file name of the folder (nothing is deleted).
 */
export async function removeReplacedFile(
  oldPath: string | null,
  newPath: string,
  label: string,
): Promise<void> {
  if (!oldPath) {
    logger.warn(`${label} Not removing the old version: its stored file name is invalid`);
    return;
  }
  if (await sameFile(oldPath, newPath)) return;
  try {
    await unlink(oldPath);
    logger.info(`${label} Removed old version: ${oldPath}`);
  } catch (e) {
    // The old file may already be gone.
    logger.info(`${label} Could not remove old version ${oldPath}:`, e);
  }
}
