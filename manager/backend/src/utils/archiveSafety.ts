/**
 * Safe extraction for archives that come from users: world imports, world
 * restores and the game-asset zip.
 *
 * The system tar/unzip happily recreate symlinks, hardlinks and device files,
 * and a member "link -> /app/data" followed by "link/users.json" writes
 * straight through the link. Archives are therefore checked twice:
 *   1. BEFORE extraction the member list is read directly from the archive
 *      (tar headers / zip central directory), one member at a time and
 *      within limits for name length and entry count (archiveListing.ts). A
 *      link, a special file, an absolute path or a ".." component rejects the
 *      whole archive, so a hostile archive never touches the disk.
 *   2. AFTER extraction into a private staging directory every entry is
 *      lstat()ed again, so a disagreement between this parser and the system
 *      tool can't leave a link behind.
 * Only a tree that passes both checks is merged into the destination.
 *
 * Callers can cap the unpacked size (ExtractLimits). The cap is checked
 * against the sizes in the listing, enforced while the extractor runs (by
 * watching the free space of the target filesystem, so an archive that
 * unpacks to more than it declares is stopped) and checked once more on the
 * extracted tree.
 *
 * tar/unzip run via spawn with an argv array (no shell).
 */
import path from 'path';
import { promises as fsp, type Stats } from 'fs';
import { spawn } from 'child_process';
import { resolveRealPath, resolveRealPathWithin } from './pathSecurity.js';
import { removeTree } from './noFollowFs.js';
import {
  ArchiveRejectedError,
  TYPE_REASONS,
  describeName,
  listArchiveEntries,
  rejectedEntry,
  scanArchiveEntries,
  type ArchiveEntry,
  type ArchiveFormat,
  type ScanOptions,
} from './archiveListing.js';

export { ArchiveRejectedError, listArchiveEntries, scanArchiveEntries };
export type {
  ArchiveEntry,
  ArchiveEntryType,
  ArchiveFormat,
  ScanOptions,
} from './archiveListing.js';

/** Optional caps for an extraction. */
export interface ExtractLimits {
  /** Maximum total unpacked size in bytes. */
  maxBytes?: number;
  /** Free space that must remain on the target filesystem after unpacking. */
  reserveBytes?: number;
}

export interface ArchiveSummary {
  files: number;
  totalBytes: number;
}

/** The target filesystem has too little free space. The message is meant to be shown to the user. */
export class ArchiveSpaceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ArchiveSpaceError';
  }
}

const STAGING_PREFIX = '.kp-extract-';
const STALE_STAGING_MS = 24 * 60 * 60 * 1000;
const EXTRACTOR_STDERR_MAX = 64 * 1024;
// How often the free space is sampled while an extractor runs, and how much
// filesystem overhead (inodes, directory blocks) is tolerated on top of the
// declared size before the extractor is stopped.
const SPACE_GUARD_INTERVAL_MS = 500;
const SPACE_GUARD_SLACK_BYTES = 256 * 1024 * 1024;
const EXTRACT_TIMEOUT_MS = 2 * 60 * 60 * 1000;

export function archiveFormatFromName(fileName: string): ArchiveFormat | null {
  const lower = fileName.toLowerCase();
  if (lower.endsWith('.zip')) return 'zip';
  if (lower.endsWith('.tar.gz') || lower.endsWith('.tgz')) return 'tar.gz';
  return null;
}

// ============================================================
// Entry validation
// ============================================================

function unsafeNameReason(name: string): string | null {
  if (name === '') return 'its name is empty';
  if (name.includes('\0')) return 'its name contains a NUL byte';
  // Backslashes count as separators: unzip rewrites them for archives made on Windows.
  const unified = name.replace(/\\/g, '/');
  if (unified.startsWith('/') || /^[a-zA-Z]:/.test(unified)) return 'it uses an absolute path';
  if (unified.split('/').includes('..')) return 'its path contains ".."';
  return null;
}

export function assertSafeArchiveEntry(entry: ArchiveEntry): void {
  const typeReason = TYPE_REASONS[entry.type];
  if (typeReason) throw rejectedEntry(entry.name, typeReason);
  for (const name of [entry.name, ...entry.aliases]) {
    const reason = unsafeNameReason(name);
    if (reason) throw rejectedEntry(name, reason);
  }
}

export function assertSafeArchiveEntries(entries: ArchiveEntry[]): void {
  for (const entry of entries) assertSafeArchiveEntry(entry);
}

// ============================================================
// Public API
// ============================================================

/** Read the member list and throw ArchiveRejectedError on the first unsafe member. */
export async function assertSafeArchive(archivePath: string, format: ArchiveFormat): Promise<void> {
  await inspectArchive(archivePath, format);
}

export function formatBytes(bytes: number): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${unit === 0 ? value : value.toFixed(1)} ${units[unit]}`;
}

function assertWithinLimit(totalBytes: number, maxBytes: number | undefined): void {
  if (maxBytes !== undefined && totalBytes > maxBytes) {
    throw new ArchiveRejectedError(
      `Archive rejected: it unpacks to ${formatBytes(totalBytes)}, more than the allowed ` +
        `${formatBytes(maxBytes)} (ARCHIVE_EXTRACT_MAX_GB).`,
    );
  }
}

/**
 * Validate every member while the archive is read (see
 * assertSafeArchiveEntry), and the declared unpacked size against
 * `limits.maxBytes`. The first unsafe member, a broken name or entry limit
 * (archiveListing.ts) or a running total above the size cap stops the read.
 * Returns the number of files and the declared total size.
 */
export async function inspectArchive(
  archivePath: string,
  format: ArchiveFormat,
  limits: ExtractLimits = {},
  options: ScanOptions = {},
): Promise<ArchiveSummary> {
  let files = 0;
  let totalBytes = 0;
  await scanArchiveEntries(
    archivePath,
    format,
    (entry) => {
      assertSafeArchiveEntry(entry);
      if (entry.type !== 'file') return;
      files++;
      totalBytes += entry.size;
      if (limits.maxBytes !== undefined && totalBytes > limits.maxBytes) {
        throw new ArchiveRejectedError(
          `Archive rejected: it unpacks to at least ${formatBytes(totalBytes)}, more than the ` +
            `allowed ${formatBytes(limits.maxBytes)} (ARCHIVE_EXTRACT_MAX_GB).`,
        );
      }
    },
    options,
  );
  return { files, totalBytes };
}

async function freeBytesOf(dir: string): Promise<number | null> {
  try {
    const st = await fsp.statfs(dir);
    return st.bavail * st.bsize;
  } catch {
    return null;
  }
}

/** Refuse up front when the target filesystem cannot hold `bytes` plus the reserve. */
export async function assertFreeSpace(dir: string, bytes: number, reserveBytes = 0): Promise<void> {
  const free = await freeBytesOf(dir);
  if (free !== null && free < bytes + reserveBytes) {
    throw new ArchiveSpaceError(
      `Not enough free disk space: unpacking needs ${formatBytes(bytes + reserveBytes)} ` +
        `(including a reserve of ${formatBytes(reserveBytes)}), only ${formatBytes(free)} are free.`,
    );
  }
}

function extractorCommand(
  archivePath: string,
  format: ArchiveFormat,
  staging: string,
): [string, string[]] {
  if (format === 'zip') return ['unzip', ['-q', '-o', archivePath, '-d', staging]];
  // Options before the operands (musl getopt does not permute). Ownership from
  // the archive is never applied, even when the panel runs as root.
  return ['tar', ['-x', '-z', '--no-same-owner', '-f', archivePath, '-C', staging]];
}

/**
 * Run tar/unzip into `staging`. When limits are given, the free space of the
 * staging filesystem is sampled while it runs: if clearly more than the
 * declared size was written, or less than `reserveBytes` is left, the
 * extractor is killed and the archive is refused, so a member that inflates
 * beyond its declared size cannot fill the disk. A hung extractor is stopped
 * after EXTRACT_TIMEOUT_MS.
 */
async function runExtractor(
  archivePath: string,
  format: ArchiveFormat,
  staging: string,
  limits: ExtractLimits,
  declaredBytes: number,
): Promise<void> {
  const [cmd, args] = extractorCommand(archivePath, format, staging);
  const freeAtStart = await freeBytesOf(staging);
  const guarded =
    freeAtStart !== null && (limits.maxBytes !== undefined || limits.reserveBytes !== undefined);
  await new Promise<void>((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    let guardError: Error | null = null;
    const stop = (err: Error) => {
      guardError ??= err;
      child.kill('SIGKILL');
    };
    child.stderr?.on('data', (chunk: Buffer) => {
      if (stderr.length < EXTRACTOR_STDERR_MAX) stderr += chunk.toString('utf8');
    });
    const guard = guarded
      ? setInterval(() => {
          void freeBytesOf(staging).then((free) => {
            if (free === null || guardError) return;
            // More written than the listing declared: the archive lied about its sizes.
            if (freeAtStart! - free > declaredBytes + SPACE_GUARD_SLACK_BYTES) {
              stop(
                new ArchiveRejectedError(
                  'Archive rejected: it unpacks to more data than its listing declares.',
                ),
              );
            } else if (limits.reserveBytes !== undefined && free < limits.reserveBytes) {
              stop(
                new ArchiveSpaceError(
                  `Unpacking stopped: less than ${formatBytes(limits.reserveBytes)} of disk space left.`,
                ),
              );
            }
          });
        }, SPACE_GUARD_INTERVAL_MS)
      : null;
    guard?.unref?.();
    const timer = setTimeout(
      () => stop(new Error(`${cmd} did not finish within ${EXTRACT_TIMEOUT_MS / 60000} minutes`)),
      EXTRACT_TIMEOUT_MS,
    );
    timer.unref?.();
    const done = () => {
      if (guard) clearInterval(guard);
      clearTimeout(timer);
    };
    child.on('error', (err) => {
      done();
      reject(err);
    });
    child.on('close', (code, signal) => {
      done();
      if (guardError) return reject(guardError);
      if (code === 0) return resolve();
      const detail = stderr.trim().slice(-500) || (signal ? `killed by ${signal}` : `exit ${code}`);
      reject(new Error(`${cmd} could not unpack the archive: ${detail}`));
    });
  });
}

/**
 * Validate `archivePath`, unpack it into the EMPTY directory `staging` and
 * re-verify the result (links, special files, size). The caller owns
 * `staging` and moves the tree on; on error the staging contents are left for
 * the caller to remove. `pre` skips the listing when the caller already ran
 * inspectArchive.
 */
export async function extractToStaging(
  archivePath: string,
  format: ArchiveFormat,
  staging: string,
  limits: ExtractLimits = {},
  pre?: ArchiveSummary,
): Promise<ArchiveSummary> {
  const declared = pre ?? (await inspectArchive(archivePath, format, limits));
  if (limits.maxBytes !== undefined || limits.reserveBytes !== undefined) {
    await assertFreeSpace(staging, declared.totalBytes, limits.reserveBytes ?? 0);
  }
  await runExtractor(archivePath, format, staging, limits, declared.totalBytes);
  const actual = await inspectExtractedTree(staging);
  if (actual.files === 0) throw new ArchiveRejectedError('The archive does not contain any files.');
  assertWithinLimit(actual.totalBytes, limits.maxBytes);
  return actual;
}

/**
 * Give the owner full access to an extracted directory. Archives may carry
 * directory modes without the x bit; as a non-root process we could then
 * neither verify nor move (nor clean up) what is inside.
 */
async function ensureOwnerAccess(dir: string, st: Stats): Promise<void> {
  if ((st.mode & 0o700) !== 0o700) await fsp.chmod(dir, (st.mode & 0o777) | 0o700);
}

/**
 * lstat() walk over an extracted tree. Anything but regular files and
 * directories is refused, as is a file with more than one link (a hardlink
 * the extractor created). setuid/setgid bits are stripped. Returns the
 * number of regular files.
 */
export async function assertSafeExtractedTree(dir: string): Promise<number> {
  return (await inspectExtractedTree(dir)).files;
}

/** assertSafeExtractedTree that also returns the total size of the regular files. */
export async function inspectExtractedTree(dir: string): Promise<ArchiveSummary> {
  let files = 0;
  let totalBytes = 0;
  const walk = async (current: string, rel: string): Promise<void> => {
    for (const name of await fsp.readdir(current)) {
      const full = path.join(current, name);
      const relName = rel ? `${rel}/${name}` : name;
      const st = await fsp.lstat(full);
      if (st.isSymbolicLink()) throw rejectedEntry(relName, TYPE_REASONS.symlink!);
      if (st.isDirectory()) {
        await ensureOwnerAccess(full, st);
        await walk(full, relName);
        continue;
      }
      if (!st.isFile()) throw rejectedEntry(relName, TYPE_REASONS.special!);
      if (st.nlink > 1) throw rejectedEntry(relName, TYPE_REASONS.hardlink!);
      if (st.mode & 0o6000) await fsp.chmod(full, st.mode & 0o777);
      files++;
      totalBytes += st.size;
    }
  };
  // A "./" member can rewrite the staging directory's own mode, too.
  await ensureOwnerAccess(dir, await fsp.lstat(dir));
  await walk(dir, '');
  return { files, totalBytes };
}

async function lstatOrNull(p: string): Promise<Stats | null> {
  try {
    return await fsp.lstat(p);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

async function moveEntry(from: string, to: string): Promise<void> {
  try {
    await fsp.rename(from, to);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EXDEV') throw err;
    // Staging and destination are on different mounts: copy, then drop the staged copy.
    // A link at the destination is removed first so the copy can't write through it.
    if ((await lstatOrNull(to))?.isSymbolicLink()) await fsp.unlink(to);
    await fsp.cp(from, to, { recursive: true, force: true });
    await removeTree(from, [path.dirname(from)]);
  }
}

/**
 * Move a verified staging tree into `destDir`, merging into existing folders
 * and replacing existing files (the behaviour of `unzip -o` / `tar -x`).
 * Never descends into an existing symlink: a world folder that is a link is a
 * conflict, not something to write through. A file move replaces a link
 * itself (rename never follows it).
 */
async function mergeInto(srcDir: string, destDir: string, rel: string): Promise<void> {
  for (const entry of await fsp.readdir(srcDir, { withFileTypes: true })) {
    const from = path.join(srcDir, entry.name);
    const to = path.join(destDir, entry.name);
    const relName = rel ? `${rel}/${entry.name}` : entry.name;
    const existing = await lstatOrNull(to);
    if (entry.isDirectory()) {
      if (!existing) {
        await moveEntry(from, to);
      } else if (existing.isDirectory() && resolveRealPath(to) === to) {
        // (re-resolved so a folder swapped for a link after the lstat is not followed)
        await mergeInto(from, to, relName);
      } else {
        throw new ArchiveRejectedError(
          `Cannot import "${describeName(relName)}": a file or link with that name already exists.`,
        );
      }
      continue;
    }
    if (existing?.isDirectory()) {
      throw new ArchiveRejectedError(
        `Cannot import "${describeName(relName)}": a folder with that name already exists.`,
      );
    }
    await moveEntry(from, to);
  }
}

/**
 * Merge an already verified tree (see assertSafeExtractedTree) into
 * `destDir`, for callers that run the extractor themselves.
 */
export async function mergeExtractedTree(srcDir: string, destDir: string): Promise<void> {
  const destReal = resolveRealPath(destDir);
  if (!destReal) throw new Error(`Destination is not accessible: ${destDir}`);
  await mergeInto(srcDir, destReal, '');
}

/** Remove staging dirs a crashed extraction left behind (older than a day). Best-effort. */
async function sweepStaleStaging(parent: string): Promise<void> {
  let names: string[];
  try {
    names = await fsp.readdir(parent);
  } catch {
    return;
  }
  for (const name of names) {
    if (!name.startsWith(STAGING_PREFIX)) continue;
    const full = path.join(parent, name);
    try {
      const st = await fsp.lstat(full);
      if (st.isDirectory() && Date.now() - st.mtimeMs > STALE_STAGING_MS) {
        await removeTree(full, [parent]);
      }
    } catch {
      // best-effort
    }
  }
}

/**
 * Validate, extract into a private staging directory next to `destDir`,
 * re-verify the extracted tree, then merge it into `destDir`. Throws
 * ArchiveRejectedError for unsafe or invalid archives; the destination is
 * left untouched in that case. The staging directory is always removed.
 *
 * `allowedRoots`: when given, the REAL destination must lie inside one of
 * them, so a destination folder replaced by a link (e.g. worlds -> panel
 * data) is refused instead of extracted into.
 */
export async function extractArchiveSafely(
  archivePath: string,
  format: ArchiveFormat,
  destDir: string,
  allowedRoots?: string[],
  limits: ExtractLimits = {},
): Promise<ArchiveSummary> {
  const declared = await inspectArchive(archivePath, format, limits);

  await fsp.mkdir(destDir, { recursive: true });
  const destReal = resolveRealPath(destDir);
  if (!destReal || (allowedRoots && !resolveRealPathWithin(destReal, allowedRoots))) {
    throw new Error(`Refusing to extract: ${destDir} resolves outside the allowed directories.`);
  }
  await sweepStaleStaging(path.dirname(destReal));
  // Stage next to the destination so the final moves are same-filesystem renames.
  const staging = await fsp.mkdtemp(path.join(path.dirname(destReal), STAGING_PREFIX));
  try {
    const summary = await extractToStaging(archivePath, format, staging, limits, declared);
    await mergeInto(staging, destReal, '');
    return summary;
  } finally {
    await removeTree(staging, [path.dirname(destReal)]).catch(() => undefined);
  }
}
