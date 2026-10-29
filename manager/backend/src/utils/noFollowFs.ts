/**
 * File access in directories the game server can write to (server/, updater/,
 * the world data folder).
 *
 * The game server runs as the same uid as the panel. Whatever it puts there
 * may be a symlink that only resolves in the panel's container (to
 * /app/data/config.json, say), a hard link, a FIFO or a device. A plain
 * copyFile() or readFile() would follow such a link and could copy panel
 * secrets to a place the server reads. These helpers only ever read, link or
 * copy regular files that have a single link:
 *   - the file is opened with O_NOFOLLOW (and O_NONBLOCK, so a FIFO cannot
 *     block a thread) and checked with fstat;
 *   - lstat of the path must still be that inode, and where the open file
 *     really lies (/proc/self/fd, or the resolved path elsewhere) must be
 *     inside the expected root, which also catches a parent directory that
 *     was swapped for a link;
 *   - new files are created with O_EXCL, which never follows a link, and are
 *     checked the same way before anything is written to them;
 *   - trees are deleted by descriptor (removeTree), so a folder swapped for a
 *     link while they are deleted cannot redirect the deletion.
 * Anything else stops the operation with an UnsafeFileError whose message can
 * be shown to the user.
 */
import crypto from 'crypto';
import { constants as fsConstants, type Stats } from 'fs';
import {
  link,
  lstat,
  mkdir,
  open,
  readdir,
  readlink,
  rename,
  rm,
  rmdir,
  unlink,
  type FileHandle,
} from 'fs/promises';
import path from 'path';
import { resolveRealPath, resolveRealPathWithin } from './pathSecurity.js';

// POSIX only; undefined on Windows (dev/tests), where the lstat comparison has to do.
const NO_FOLLOW = fsConstants.O_NOFOLLOW ?? 0;
const NON_BLOCK = fsConstants.O_NONBLOCK ?? 0;
const DIRECTORY = fsConstants.O_DIRECTORY ?? 0;
const COPY_CHUNK_BYTES = 4 * 1024 * 1024;
const READ_CHUNK_BYTES = 64 * 1024;

/** A file was a link, not a regular file, or not where it should be. The message is meant for the user. */
export class UnsafeFileError extends Error {
  constructor(
    readonly filePath: string,
    readonly why: string,
  ) {
    super(
      `Refusing to use ${filePath}: ${why}. Files in the server folders are only used when they ` +
        'are regular files; replace it with a regular file and try again.',
    );
    this.name = 'UnsafeFileError';
  }
}

export interface ConfineOptions {
  /** Directories the real source must lie in. */
  srcRoots: string[];
  /** Directories the real destination must lie in. */
  destRoots: string[];
  /**
   * Paths that may share the source's inode: hard links the panel made itself
   * (snapshot links of Assets.zip). Any other extra link refuses the source.
   */
  knownLinks?: string[];
}

async function lstatOrNull(p: string): Promise<Stats | null> {
  try {
    return await lstat(p);
  } catch {
    return null;
  }
}

const sameInode = (a: Stats, b: Stats) => a.dev === b.dev && a.ino === b.ino;

/** Where an open file really lies, when the platform can tell (Linux). */
async function descriptorPath(fh: FileHandle): Promise<string | null> {
  if (process.platform !== 'linux') return null;
  try {
    return await readlink(`/proc/self/fd/${fh.fd}`);
  } catch {
    return null;
  }
}

function isInside(realPath: string | null, roots: string[]): boolean {
  return !!realPath && resolveRealPathWithin(realPath, roots) !== null;
}

async function knownLinkCount(st: Stats, self: string, candidates: string[]): Promise<number> {
  let count = 0;
  for (const candidate of candidates) {
    if (path.resolve(candidate) === path.resolve(self)) continue;
    const other = await lstatOrNull(candidate);
    if (other?.isFile() && sameInode(other, st)) count++;
  }
  return count;
}

/**
 * Opens a regular file for reading (see the module comment for the checks).
 * A missing file rejects with the usual ENOENT error. The caller closes the
 * handle.
 */
export async function openRegularFile(
  filePath: string,
  roots: string[],
  { knownLinks = [] }: { knownLinks?: string[] } = {},
): Promise<{ fh: FileHandle; stats: Stats }> {
  let fh: FileHandle;
  try {
    fh = await open(filePath, fsConstants.O_RDONLY | NO_FOLLOW | NON_BLOCK);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ELOOP') {
      throw new UnsafeFileError(filePath, 'it is a symbolic link');
    }
    throw err;
  }
  try {
    const stats = await fh.stat();
    if (!stats.isFile()) throw new UnsafeFileError(filePath, 'it is not a regular file');
    const now = await lstatOrNull(filePath);
    if (now?.isSymbolicLink()) throw new UnsafeFileError(filePath, 'it is a symbolic link');
    if (!now || !sameInode(now, stats)) {
      throw new UnsafeFileError(filePath, 'it was replaced while it was being opened');
    }
    if (stats.nlink > 1 && stats.nlink > 1 + (await knownLinkCount(stats, filePath, knownLinks))) {
      throw new UnsafeFileError(
        filePath,
        'it has more than one hard link (made by the server, or by a backup or deduplication tool)',
      );
    }
    if (!isInside((await descriptorPath(fh)) ?? resolveRealPath(filePath), roots)) {
      throw new UnsafeFileError(filePath, 'it lies outside the expected folder');
    }
    return { fh, stats };
  } catch (err) {
    await fh.close().catch(() => undefined);
    throw err;
  }
}

/** Content of a regular file inside `roots`; refuses files larger than `maxBytes`. */
export async function readRegularFile(
  filePath: string,
  roots: string[],
  { maxBytes }: { maxBytes?: number } = {},
): Promise<Buffer> {
  const { fh, stats } = await openRegularFile(filePath, roots);
  try {
    if (maxBytes === undefined) return await fh.readFile();
    const tooLarge = () => new UnsafeFileError(filePath, `it is larger than ${maxBytes} bytes`);
    if (stats.size > maxBytes) throw tooLarge();
    // Counted while reading: the file may grow after the fstat.
    const chunk = Buffer.alloc(Math.min(READ_CHUNK_BYTES, maxBytes + 1));
    const parts: Buffer[] = [];
    let total = 0;
    for (;;) {
      const { bytesRead } = await fh.read(chunk, 0, chunk.length, total);
      if (bytesRead === 0) break;
      total += bytesRead;
      if (total > maxBytes) throw tooLarge();
      parts.push(Buffer.from(chunk.subarray(0, bytesRead)));
    }
    return Buffer.concat(parts, total);
  } finally {
    await fh.close().catch(() => undefined);
  }
}

/**
 * Creates `filePath`, which must not exist yet (O_EXCL never follows a link
 * planted under that name), and checks it lies inside `roots`.
 */
async function createExclusive(
  filePath: string,
  roots: string[],
  mode: number,
): Promise<FileHandle> {
  const fh = await open(
    filePath,
    fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | NO_FOLLOW,
    mode,
  );
  const real = (await descriptorPath(fh)) ?? resolveRealPath(filePath);
  if (isInside(real, roots)) return fh;
  await fh.close().catch(() => undefined);
  // Only the file just created (O_EXCL) is removed, wherever it ended up.
  await unlink(real ?? filePath).catch(() => undefined);
  throw new UnsafeFileError(filePath, 'it lies outside the expected folder');
}

async function copyContents(from: FileHandle, to: FileHandle): Promise<void> {
  const buf = Buffer.allocUnsafe(COPY_CHUNK_BYTES);
  let position = 0;
  for (;;) {
    const { bytesRead } = await from.read(buf, 0, buf.length, position);
    if (bytesRead === 0) return;
    let written = 0;
    while (written < bytesRead) {
      written += (await to.write(buf, written, bytesRead - written)).bytesWritten;
    }
    position += bytesRead;
  }
}

/**
 * Copies a regular file to `dest`, which must not exist yet. The copy keeps
 * the source's permission bits. Returns the source's stats.
 */
export async function copyRegularFile(
  src: string,
  dest: string,
  opts: ConfineOptions,
): Promise<Stats> {
  const { fh: from, stats } = await openRegularFile(src, opts.srcRoots, opts);
  try {
    const to = await createExclusive(dest, opts.destRoots, stats.mode & 0o777);
    try {
      await copyContents(from, to);
      await to.chmod(stats.mode & 0o777).catch(() => undefined);
    } catch (err) {
      await to.close().catch(() => undefined);
      await rm(dest, { force: true }).catch(() => undefined);
      throw err;
    }
    await to.close();
    return stats;
  } finally {
    await from.close().catch(() => undefined);
  }
}

/**
 * Hard-links a regular file to `dest`. link() itself does not follow a
 * symlink but would link the symlink, so the new entry is checked to be the
 * inode that was verified. Errors other than UnsafeFileError (another
 * filesystem, no hard links) leave nothing behind; callers then copy.
 */
export async function linkRegularFile(
  src: string,
  dest: string,
  opts: ConfineOptions,
): Promise<Stats> {
  const { fh, stats } = await openRegularFile(src, opts.srcRoots, opts);
  try {
    await link(src, dest);
    const created = await lstatOrNull(dest);
    let problem: UnsafeFileError | null = null;
    if (!created || !created.isFile() || !sameInode(created, stats)) {
      problem = new UnsafeFileError(src, 'it was replaced while it was being linked');
    } else if (!isInside(resolveRealPath(dest), opts.destRoots)) {
      problem = new UnsafeFileError(dest, 'it lies outside the expected folder');
    }
    if (problem) {
      await unlink(dest).catch(() => undefined);
      throw problem;
    }
    return stats;
  } finally {
    await fh.close().catch(() => undefined);
  }
}

/** A real directory (not a link) inside `roots`; returns its lstat. */
export async function assertRegularDirectory(dir: string, roots: string[]): Promise<Stats> {
  const st = await lstat(dir);
  if (st.isSymbolicLink()) throw new UnsafeFileError(dir, 'it is a symbolic link');
  if (!st.isDirectory()) throw new UnsafeFileError(dir, 'it is not a directory');
  if (!isInside(resolveRealPath(dir), roots)) {
    throw new UnsafeFileError(dir, 'it lies outside the expected folder');
  }
  return st;
}

/**
 * Copies a directory tree to `dest`, which must not exist yet. Only regular
 * files and directories are copied; a link or special file anywhere stops the
 * copy (the partial copy is left for the caller to remove).
 */
export async function copyDirectoryTree(
  srcDir: string,
  destDir: string,
  opts: ConfineOptions,
): Promise<void> {
  const st = await assertRegularDirectory(srcDir, opts.srcRoots);
  await mkdir(destDir, { mode: st.mode & 0o777 });
  await assertRegularDirectory(destDir, opts.destRoots);
  for (const name of await readdir(srcDir)) {
    const from = path.join(srcDir, name);
    const to = path.join(destDir, name);
    const entry = await lstat(from);
    if (entry.isDirectory()) await copyDirectoryTree(from, to, opts);
    else if (entry.isFile()) await copyRegularFile(from, to, { ...opts, knownLinks: [] });
    else {
      throw new UnsafeFileError(
        from,
        entry.isSymbolicLink() ? 'it is a symbolic link' : 'it is not a regular file',
      );
    }
  }
}

/**
 * Replaces `dest` with `content`: written to a new temporary file next to it
 * (O_EXCL), then renamed over it. rename() replaces a link at `dest` instead
 * of writing through it.
 */
export async function replaceFileContent(
  dest: string,
  content: string | Buffer,
  roots: string[],
  mode = 0o664,
): Promise<void> {
  const tmp = path.join(
    path.dirname(dest),
    `.${path.basename(dest)}.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`,
  );
  const fh = await createExclusive(tmp, roots, mode);
  try {
    await fh.writeFile(content);
  } catch (err) {
    await fh.close().catch(() => undefined);
    await rm(tmp, { force: true }).catch(() => undefined);
    throw err;
  }
  await fh.close();
  try {
    await rename(tmp, dest);
  } catch (err) {
    await rm(tmp, { force: true }).catch(() => undefined);
    throw err;
  }
}

const isCode = (err: unknown, ...codes: string[]) =>
  codes.includes((err as NodeJS.ErrnoException).code ?? '');

/** Empties the open directory `dir`, walking it only through its descriptor. */
async function emptyDirectory(dir: FileHandle): Promise<void> {
  // /proc/self/fd/N names the directory that was opened, wherever its path
  // points by now; entries are looked up inside that very directory.
  const base = `/proc/self/fd/${dir.fd}`;
  for (const name of await readdir(base)) {
    const entry = `${base}/${name}`;
    let sub: FileHandle | null = null;
    if ((await lstatOrNull(entry))?.isDirectory()) {
      try {
        sub = await open(entry, fsConstants.O_RDONLY | DIRECTORY | NO_FOLLOW);
      } catch (err) {
        // Swapped for a link or a file after the lstat: removed below like one.
        if (!isCode(err, 'ELOOP', 'ENOTDIR')) throw err;
      }
    }
    if (!sub) {
      await unlink(entry).catch((err) => {
        if (!isCode(err, 'ENOENT')) throw err;
      });
      continue;
    }
    try {
      await emptyDirectory(sub);
    } finally {
      await sub.close().catch(() => undefined);
    }
    await rmdir(entry);
  }
}

/**
 * Deletes `target` (a file, a link or a directory tree) inside `roots`
 * without following links. fs.rm({ recursive }) walks by path: a folder the
 * game server swaps for a link while it runs makes it delete whatever the
 * link points to (the panel's own data). On Linux every folder is opened with
 * O_NOFOLLOW and walked through its descriptor, so a swap cannot redirect the
 * walk; elsewhere (development) fs.rm is used. A missing target is fine.
 */
export async function removeTree(target: string, roots: string[]): Promise<void> {
  const st = await lstatOrNull(target);
  if (!st) return;
  if (!st.isDirectory()) {
    await unlink(target).catch((err) => {
      if (!isCode(err, 'ENOENT')) throw err;
    });
    return;
  }
  if (process.platform !== 'linux') {
    await rm(target, { recursive: true, force: true });
    return;
  }
  let fh: FileHandle;
  try {
    fh = await open(target, fsConstants.O_RDONLY | DIRECTORY | NO_FOLLOW);
  } catch (err) {
    if (!isCode(err, 'ELOOP', 'ENOTDIR')) throw err;
    // Swapped for a link or a file after the lstat: remove that entry itself.
    await unlink(target);
    return;
  }
  try {
    if (!isInside(await descriptorPath(fh), roots)) {
      throw new UnsafeFileError(target, 'it lies outside the expected folder');
    }
    await emptyDirectory(fh);
  } finally {
    await fh.close().catch(() => undefined);
  }
  await rmdir(target);
}
