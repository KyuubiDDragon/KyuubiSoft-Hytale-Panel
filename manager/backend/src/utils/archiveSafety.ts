/**
 * Safe extraction for archives that come from users: world imports, world
 * restores and the game-asset zip.
 *
 * The system tar/unzip happily recreate symlinks, hardlinks and device files,
 * and a member "link -> /app/data" followed by "link/users.json" writes
 * straight through the link. Archives are therefore checked twice:
 *   1. BEFORE extraction the member list is read directly from the archive
 *      (tar headers / zip central directory). A link, a special file, an
 *      absolute path or a ".." component rejects the whole archive, so a
 *      hostile archive never touches the disk.
 *   2. AFTER extraction into a private staging directory every entry is
 *      lstat()ed again, so a disagreement between this parser and the system
 *      tool can't leave a link behind.
 * Only a tree that passes both checks is merged into the destination.
 *
 * tar/unzip run via execFile with an argv array (no shell).
 */
import path from 'path';
import { createReadStream, promises as fsp, type Stats } from 'fs';
import type { FileHandle } from 'fs/promises';
import { createGunzip } from 'zlib';
import { Writable } from 'stream';
import { pipeline } from 'stream/promises';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { resolveRealPath, resolveRealPathWithin } from './pathSecurity.js';

const execFileAsync = promisify(execFile);

export type ArchiveFormat = 'zip' | 'tar.gz';
export type ArchiveEntryType = 'file' | 'directory' | 'symlink' | 'hardlink' | 'special';

export interface ArchiveEntry {
  /** Member name as the extractor will use it. */
  name: string;
  /** Other names the same member carries (ustar vs PAX/GNU long name, zip unicode path); all must be safe. */
  aliases: string[];
  type: ArchiveEntryType;
}

/** An archive that was refused. The message is meant to be shown to the user. */
export class ArchiveRejectedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ArchiveRejectedError';
  }
}

const NOT_A_TAR_GZ = 'The archive is not a valid .tar.gz file.';
const NOT_A_ZIP = 'The archive is not a valid .zip file.';
const STAGING_PREFIX = '.kp-extract-';
const STALE_STAGING_MS = 24 * 60 * 60 * 1000;
const EXTRACT_MAX_BUFFER = 1024 * 1024 * 10;
const NAME_DISPLAY_MAX = 120;

export function archiveFormatFromName(fileName: string): ArchiveFormat | null {
  const lower = fileName.toLowerCase();
  if (lower.endsWith('.zip')) return 'zip';
  if (lower.endsWith('.tar.gz') || lower.endsWith('.tgz')) return 'tar.gz';
  return null;
}

// ============================================================
// Entry validation
// ============================================================

const TYPE_REASONS: Partial<Record<ArchiveEntryType, string>> = {
  symlink: 'it is a symbolic link',
  hardlink: 'it is a hard link',
  special: 'it is a device, FIFO or other special file',
};

function describeName(name: string): string {
  // eslint-disable-next-line no-control-regex
  const printable = name.replace(/[\x00-\x1f\x7f]/g, '?');
  return printable.length > NAME_DISPLAY_MAX
    ? `${printable.slice(0, NAME_DISPLAY_MAX)}...`
    : printable;
}

function rejectedEntry(name: string, reason: string): ArchiveRejectedError {
  return new ArchiveRejectedError(
    `Archive rejected: "${describeName(name)}" is not allowed because ${reason}. ` +
      'Archives may only contain regular files and folders with relative paths.',
  );
}

function unsafeNameReason(name: string): string | null {
  if (name === '') return 'its name is empty';
  if (name.includes('\0')) return 'its name contains a NUL byte';
  // Backslashes count as separators: unzip rewrites them for archives made on Windows.
  const unified = name.replace(/\\/g, '/');
  if (unified.startsWith('/') || /^[a-zA-Z]:/.test(unified)) return 'it uses an absolute path';
  if (unified.split('/').includes('..')) return 'its path contains ".."';
  return null;
}

export function assertSafeArchiveEntries(entries: ArchiveEntry[]): void {
  for (const entry of entries) {
    const typeReason = TYPE_REASONS[entry.type];
    if (typeReason) throw rejectedEntry(entry.name, typeReason);
    for (const name of [entry.name, ...entry.aliases]) {
      const reason = unsafeNameReason(name);
      if (reason) throw rejectedEntry(name, reason);
    }
  }
}

// ============================================================
// tar.gz member listing (streamed, nothing is written to disk)
// ============================================================

const TAR_BLOCK = 512;
const MAX_TAR_META_BYTES = 1024 * 1024; // PAX / GNU long-name payloads

type TarMetaKind = 'pax' | 'paxGlobal' | 'longName' | 'longLink';

function readCString(buf: Buffer, offset: number, length: number): string {
  const nul = buf.indexOf(0, offset);
  const end = nul === -1 || nul > offset + length ? offset + length : nul;
  return buf.toString('utf8', offset, end);
}

function readTarNumber(block: Buffer, offset: number, length: number): number {
  if (block[offset] & 0x80) {
    // GNU base-256 encoding (sizes beyond the octal limit). 0xff = negative.
    if (block[offset] === 0xff) throw new ArchiveRejectedError(NOT_A_TAR_GZ);
    let value = 0;
    for (let i = offset + 1; i < offset + length; i++) value = value * 256 + block[i];
    return value;
  }
  const text = block.toString('latin1', offset, offset + length).replace(/^[\0 ]+|[\0 ]+$/g, '');
  if (text === '') return 0;
  if (!/^[0-7]+$/.test(text)) throw new ArchiveRejectedError(NOT_A_TAR_GZ);
  return parseInt(text, 8);
}

function tarChecksumOk(block: Buffer): boolean {
  const stored = readTarNumber(block, 148, 8);
  let unsigned = 0;
  let signed = 0;
  for (let i = 0; i < TAR_BLOCK; i++) {
    const b = i >= 148 && i < 156 ? 0x20 : block[i];
    unsigned += b;
    signed += b > 127 ? b - 256 : b;
  }
  return stored === unsigned || stored === signed;
}

function parsePaxRecords(data: Buffer): Record<string, string> {
  const records: Record<string, string> = {};
  let pos = 0;
  while (pos < data.length) {
    const space = data.indexOf(0x20, pos);
    if (space === -1) break;
    const length = parseInt(data.toString('latin1', pos, space), 10);
    if (!Number.isFinite(length) || length <= space - pos || pos + length > data.length) {
      throw new ArchiveRejectedError(NOT_A_TAR_GZ);
    }
    const record = data.toString('utf8', space + 1, pos + length - 1); // drop the trailing "\n"
    const eq = record.indexOf('=');
    if (eq > 0) records[record.slice(0, eq)] = record.slice(eq + 1);
    pos += length;
  }
  return records;
}

function tarEntryType(typeflag: string, name: string): ArchiveEntryType {
  switch (typeflag) {
    case '0':
    case '7':
      return name.endsWith('/') ? 'directory' : 'file';
    case '5':
      return 'directory';
    case '1':
      return 'hardlink';
    case '2':
      return 'symlink';
    default:
      // Character/block devices, FIFOs, GNU dumpdir/sparse/multi-volume and unknown types.
      return 'special';
  }
}

class TarHeaderScanner {
  readonly entries: ArchiveEntry[] = [];
  private header = Buffer.alloc(0);
  private skip = 0;
  private meta: { kind: TarMetaKind; remaining: number; padding: number; chunks: Buffer[] } | null =
    null;
  private paxPath: string | undefined;
  private paxSize: number | undefined;
  private longName: string | undefined;
  private zeroBlocks = 0;
  private ended = false;

  push(chunk: Buffer): void {
    let offset = 0;
    while (offset < chunk.length && !this.ended) {
      if (this.skip > 0) {
        const n = Math.min(this.skip, chunk.length - offset);
        this.skip -= n;
        offset += n;
        continue;
      }
      if (this.meta) {
        const n = Math.min(this.meta.remaining, chunk.length - offset);
        this.meta.chunks.push(chunk.subarray(offset, offset + n));
        this.meta.remaining -= n;
        offset += n;
        if (this.meta.remaining === 0) this.finishMeta();
        continue;
      }
      const n = Math.min(TAR_BLOCK - this.header.length, chunk.length - offset);
      this.header = Buffer.concat([this.header, chunk.subarray(offset, offset + n)]);
      offset += n;
      if (this.header.length === TAR_BLOCK) {
        const block = this.header;
        this.header = Buffer.alloc(0);
        this.handleHeader(block);
      }
    }
  }

  finish(): void {
    if (!this.ended && (this.header.length > 0 || this.skip > 0 || this.meta)) {
      throw new ArchiveRejectedError(`${NOT_A_TAR_GZ} It appears to be truncated.`);
    }
  }

  private handleHeader(block: Buffer): void {
    if (block.every((b) => b === 0)) {
      // Like GNU and BusyBox tar: only two zero blocks in a row end the
      // archive; a lone one is skipped and reading continues.
      this.zeroBlocks++;
      if (this.zeroBlocks >= 2) this.ended = true;
      return;
    }
    this.zeroBlocks = 0;
    if (!tarChecksumOk(block)) throw new ArchiveRejectedError(NOT_A_TAR_GZ);

    const typeflag = block[156] === 0 ? '0' : String.fromCharCode(block[156]);
    const headerSize = readTarNumber(block, 124, 12);

    const metaKind: TarMetaKind | null =
      typeflag === 'x'
        ? 'pax'
        : typeflag === 'g'
          ? 'paxGlobal'
          : typeflag === 'L'
            ? 'longName'
            : typeflag === 'K'
              ? 'longLink'
              : null;
    if (metaKind) {
      if (headerSize > MAX_TAR_META_BYTES)
        throw new ArchiveRejectedError(`${NOT_A_TAR_GZ} An extension header is too large.`);
      this.meta = {
        kind: metaKind,
        remaining: headerSize,
        padding: Math.ceil(headerSize / TAR_BLOCK) * TAR_BLOCK - headerSize,
        chunks: [],
      };
      if (headerSize === 0) this.finishMeta();
      return;
    }

    const rawName = readCString(block, 0, 100);
    // Only POSIX ustar uses the prefix field; old GNU headers store timestamps
    // there. An extractor might still join it, so that variant is checked too.
    const prefixField = readCString(block, 345, 155);
    const isPosixUstar = block.toString('latin1', 257, 263) === 'ustar\0';
    const headerName = isPosixUstar && prefixField ? `${prefixField}/${rawName}` : rawName;
    const name = this.paxPath ?? this.longName ?? headerName;
    const aliases = [
      headerName,
      rawName,
      prefixField ? `${prefixField}/${rawName}` : undefined,
      this.paxPath,
      this.longName,
    ].filter((n): n is string => n !== undefined && n !== '' && n !== name);
    const type = tarEntryType(typeflag, name);
    this.entries.push({ name, aliases: [...new Set(aliases)], type });

    const size = this.paxSize ?? headerSize;
    // GNU tar reads no data for a folder entry, this scanner would skip it:
    // a folder "carrying data" could hide the next header from the scan.
    if (type === 'directory' && size > 0) {
      throw rejectedEntry(name, 'it is a folder entry that carries data');
    }
    this.paxPath = undefined;
    this.paxSize = undefined;
    this.longName = undefined;
    this.skip = Math.ceil(size / TAR_BLOCK) * TAR_BLOCK;
  }

  private finishMeta(): void {
    const meta = this.meta!;
    this.meta = null;
    this.skip = meta.padding;
    const data = Buffer.concat(meta.chunks);
    if (meta.kind === 'longName') {
      this.longName = readCString(data, 0, data.length);
      return;
    }
    if (meta.kind === 'longLink') return; // link targets are irrelevant: links are refused anyway
    const records = parsePaxRecords(data);
    if (meta.kind === 'paxGlobal') {
      for (const key of ['path', 'linkpath', 'size']) {
        if (records[key] !== undefined) {
          throw new ArchiveRejectedError(
            `Archive rejected: a global tar header overrides the member ${key}, which is not supported.`,
          );
        }
      }
      return;
    }
    if (records.path !== undefined) this.paxPath = records.path;
    if (records.size !== undefined) {
      if (!/^\d+$/.test(records.size)) throw new ArchiveRejectedError(NOT_A_TAR_GZ);
      this.paxSize = Number(records.size);
    }
  }
}

async function listTarGzEntries(archivePath: string): Promise<ArchiveEntry[]> {
  const scanner = new TarHeaderScanner();
  try {
    await pipeline(
      createReadStream(archivePath),
      createGunzip(),
      new Writable({
        write(chunk: Buffer, _encoding, callback) {
          try {
            scanner.push(chunk);
            callback();
          } catch (err) {
            callback(err as Error);
          }
        },
      }),
    );
  } catch (err) {
    if (err instanceof ArchiveRejectedError) throw err;
    // zlib reports a non-gzip / corrupt stream with Z_* codes.
    if (String((err as NodeJS.ErrnoException).code ?? '').startsWith('Z_')) {
      throw new ArchiveRejectedError(NOT_A_TAR_GZ);
    }
    throw err;
  }
  scanner.finish();
  return scanner.entries;
}

// ============================================================
// zip member listing (central directory only)
// ============================================================

const ZIP_EOCD_SIG = 0x06054b50;
const ZIP64_LOCATOR_SIG = 0x07064b50;
const ZIP64_EOCD_SIG = 0x06064b50;
const ZIP_CENTRAL_SIG = 0x02014b50;
const ZIP_UNICODE_PATH_EXTRA = 0x7075;
const ZIP_EOCD_MIN = 22;
const MAX_ZIP_CENTRAL_DIR_BYTES = 256 * 1024 * 1024;

const S_IFMT = 0o170000;
const S_IFREG = 0o100000;
const S_IFDIR = 0o040000;
const S_IFLNK = 0o120000;

async function readExactly(fh: FileHandle, length: number, position: number): Promise<Buffer> {
  const buf = Buffer.alloc(length);
  let done = 0;
  while (done < length) {
    const { bytesRead } = await fh.read(buf, done, length - done, position + done);
    if (bytesRead === 0) throw new ArchiveRejectedError(NOT_A_ZIP);
    done += bytesRead;
  }
  return buf;
}

/** Info-ZIP unicode path extra field (0x7075). unzip prefers it over the plain name. */
function readZipUnicodePath(extra: Buffer): string | null {
  let pos = 0;
  while (pos + 4 <= extra.length) {
    const id = extra.readUInt16LE(pos);
    const length = extra.readUInt16LE(pos + 2);
    const start = pos + 4;
    const end = start + length;
    if (end > extra.length) break;
    if (id === ZIP_UNICODE_PATH_EXTRA && length >= 5) return extra.toString('utf8', start + 5, end);
    pos = end;
  }
  return null;
}

function zipEntryType(externalAttributes: number, name: string): ArchiveEntryType {
  // The upper 16 bits carry the Unix st_mode for archives made on Unix-like hosts.
  const kind = (externalAttributes >>> 16) & 0xffff & S_IFMT;
  if (kind === S_IFLNK) return 'symlink';
  if (kind === S_IFDIR) return 'directory';
  if (kind === 0 || kind === S_IFREG) return name.endsWith('/') ? 'directory' : 'file';
  return 'special';
}

function parseZipCentralDirectory(cd: Buffer, count: number): ArchiveEntry[] {
  const entries: ArchiveEntry[] = [];
  let pos = 0;
  for (let i = 0; i < count; i++) {
    if (pos + 46 > cd.length || cd.readUInt32LE(pos) !== ZIP_CENTRAL_SIG) {
      throw new ArchiveRejectedError(NOT_A_ZIP);
    }
    const flags = cd.readUInt16LE(pos + 8);
    const nameLength = cd.readUInt16LE(pos + 28);
    const extraLength = cd.readUInt16LE(pos + 30);
    const commentLength = cd.readUInt16LE(pos + 32);
    const externalAttributes = cd.readUInt32LE(pos + 38);
    const nameEnd = pos + 46 + nameLength;
    const extraEnd = nameEnd + extraLength;
    if (extraEnd + commentLength > cd.length) throw new ArchiveRejectedError(NOT_A_ZIP);

    // Bit 11 = UTF-8 name; otherwise CP437, for which latin1 keeps every ASCII byte intact.
    const plainName = cd.toString(flags & 0x800 ? 'utf8' : 'latin1', pos + 46, nameEnd);
    const unicodeName = readZipUnicodePath(cd.subarray(nameEnd, extraEnd));
    const name = unicodeName ?? plainName;
    entries.push({
      name,
      aliases: name !== plainName ? [plainName] : [],
      type: zipEntryType(externalAttributes, name),
    });
    pos = extraEnd + commentLength;
  }
  // Entries beyond the declared count (e.g. a wrapped 16-bit count) would be
  // seen by some unzip builds but not by this parser.
  if (pos !== cd.length) throw new ArchiveRejectedError(NOT_A_ZIP);
  return entries;
}

async function listZipEntries(archivePath: string): Promise<ArchiveEntry[]> {
  const fh = await fsp.open(archivePath, 'r');
  try {
    const { size } = await fh.stat();
    if (size < ZIP_EOCD_MIN) throw new ArchiveRejectedError(NOT_A_ZIP);
    const tailLength = Math.min(size, ZIP_EOCD_MIN + 0xffff);
    const tail = await readExactly(fh, tailLength, size - tailLength);

    let eocd = -1;
    for (let i = tailLength - ZIP_EOCD_MIN; i >= 0; i--) {
      if (tail.readUInt32LE(i) === ZIP_EOCD_SIG) {
        eocd = i;
        break;
      }
    }
    if (eocd < 0) throw new ArchiveRejectedError(NOT_A_ZIP);

    let count = tail.readUInt16LE(eocd + 10);
    let cdSize = tail.readUInt32LE(eocd + 12);
    let cdOffset = tail.readUInt32LE(eocd + 16);
    let multiDisk = tail.readUInt16LE(eocd + 4) !== 0 || tail.readUInt16LE(eocd + 6) !== 0;
    // Where the central directory must end: at the (ZIP64) end record.
    let cdEnd = size - tailLength + eocd;

    if (count === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) {
      // ZIP64: the locator sits directly in front of the classic EOCD record.
      const locatorPos = cdEnd - 20;
      if (locatorPos < 0) throw new ArchiveRejectedError(NOT_A_ZIP);
      const locator = await readExactly(fh, 20, locatorPos);
      if (locator.readUInt32LE(0) !== ZIP64_LOCATOR_SIG) throw new ArchiveRejectedError(NOT_A_ZIP);
      const zip64Pos = Number(locator.readBigUInt64LE(8));
      if (zip64Pos + 56 > locatorPos) throw new ArchiveRejectedError(NOT_A_ZIP);
      const zip64 = await readExactly(fh, 56, zip64Pos);
      if (zip64.readUInt32LE(0) !== ZIP64_EOCD_SIG) throw new ArchiveRejectedError(NOT_A_ZIP);
      multiDisk = zip64.readUInt32LE(16) !== 0 || zip64.readUInt32LE(20) !== 0;
      count = Number(zip64.readBigUInt64LE(32));
      cdSize = Number(zip64.readBigUInt64LE(40));
      cdOffset = Number(zip64.readBigUInt64LE(48));
      cdEnd = zip64Pos;
    }

    if (multiDisk)
      throw new ArchiveRejectedError('Split (multi-part) zip archives are not supported.');
    if (cdSize > MAX_ZIP_CENTRAL_DIR_BYTES) throw new ArchiveRejectedError(NOT_A_ZIP);
    // unzip tolerates a central directory that is not where the end record
    // says ("extra bytes at beginning") and goes looking for it; this parser
    // would then read a different one. Only the exact layout is accepted, so
    // self-extracting / prepended-data zips are refused.
    if (cdOffset + cdSize !== cdEnd) {
      throw new ArchiveRejectedError(
        `${NOT_A_ZIP} Its central directory is not where the end record says.`,
      );
    }
    const cd = await readExactly(fh, cdSize, cdOffset);
    return parseZipCentralDirectory(cd, count);
  } finally {
    await fh.close();
  }
}

// ============================================================
// Public API
// ============================================================

export function listArchiveEntries(
  archivePath: string,
  format: ArchiveFormat,
): Promise<ArchiveEntry[]> {
  return format === 'zip' ? listZipEntries(archivePath) : listTarGzEntries(archivePath);
}

/** Read the member list and throw ArchiveRejectedError on the first unsafe member. */
export async function assertSafeArchive(archivePath: string, format: ArchiveFormat): Promise<void> {
  assertSafeArchiveEntries(await listArchiveEntries(archivePath, format));
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
  let files = 0;
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
    }
  };
  // A "./" member can rewrite the staging directory's own mode, too.
  await ensureOwnerAccess(dir, await fsp.lstat(dir));
  await walk(dir, '');
  return files;
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
    await fsp.rm(from, { recursive: true, force: true });
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
        await fsp.rm(full, { recursive: true, force: true });
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
): Promise<void> {
  await assertSafeArchive(archivePath, format);

  await fsp.mkdir(destDir, { recursive: true });
  const destReal = resolveRealPath(destDir);
  if (!destReal || (allowedRoots && !resolveRealPathWithin(destReal, allowedRoots))) {
    throw new Error(`Refusing to extract: ${destDir} resolves outside the allowed directories.`);
  }
  await sweepStaleStaging(path.dirname(destReal));
  // Stage next to the destination so the final moves are same-filesystem renames.
  const staging = await fsp.mkdtemp(path.join(path.dirname(destReal), STAGING_PREFIX));
  try {
    if (format === 'zip') {
      await execFileAsync('unzip', ['-q', '-o', archivePath, '-d', staging], {
        maxBuffer: EXTRACT_MAX_BUFFER,
      });
    } else {
      await execFileAsync('tar', ['-xzf', archivePath, '-C', staging], {
        maxBuffer: EXTRACT_MAX_BUFFER,
      });
    }
    if ((await assertSafeExtractedTree(staging)) === 0) {
      throw new ArchiveRejectedError('The archive does not contain any files.');
    }
    await mergeInto(staging, destReal, '');
  } finally {
    await fsp.rm(staging, { recursive: true, force: true }).catch(() => undefined);
  }
}
