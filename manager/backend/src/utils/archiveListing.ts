/**
 * Member listing of .tar.gz and .zip archives, read directly from the archive
 * (tar headers / zip central directory) without extracting anything, so
 * archiveSafety.ts can vet an archive before the system tar/unzip touches it.
 *
 * Members are handed to a callback one by one as they are read; nothing is
 * collected, so the memory a hostile archive can cost is bounded by the size
 * of one member's headers. Two limits stop the scan early:
 *  - names (and their aliases) of at most ARCHIVE_NAME_MAX_BYTES (1024), so a
 *    member cannot carry megabytes of name and the staging folder plus a
 *    member path always stay below the Linux PATH_MAX of 4096;
 *  - at most ARCHIVE_MAX_ENTRIES (default 500 000) files and folders, counting
 *    the folders a member's path implies, so a small archive cannot use up
 *    the inodes of the target filesystem.
 */
import { createReadStream, promises as fsp } from 'fs';
import type { FileHandle } from 'fs/promises';
import { createGunzip, crc32 } from 'zlib';
import { Writable } from 'stream';
import { pipeline } from 'stream/promises';

export type ArchiveFormat = 'zip' | 'tar.gz';
export type ArchiveEntryType = 'file' | 'directory' | 'symlink' | 'hardlink' | 'special';

export interface ArchiveEntry {
  /** Member name as the extractor will use it. */
  name: string;
  /** Other names the same member carries (ustar vs PAX/GNU long name, zip unicode path); all must be safe. */
  aliases: string[];
  type: ArchiveEntryType;
  /** Unpacked size in bytes as declared by the archive (0 for folders). */
  size: number;
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
const NAME_DISPLAY_MAX = 120;

/**
 * Longest member name (in UTF-8 bytes) that is accepted. The extractor works
 * relative to the staging folder, but the panel checks, moves and removes the
 * tree with absolute paths, which fail beyond PATH_MAX (4096): a 4096-byte
 * name would leave a tree behind that the panel can neither verify nor
 * delete. Real members are far shorter (the game asset zip: 174 bytes).
 */
export const ARCHIVE_NAME_MAX_BYTES = 1024;
// The game asset zip has about 70 000 members, a large universe some 10 000;
// half a million inodes is still a small share of any filesystem.
const DEFAULT_MAX_ENTRIES = 500_000;

/**
 * Upper bound for the files and folders an archive may create
 * (ARCHIVE_MAX_ENTRIES, default 500 000). Read per call like
 * ARCHIVE_EXTRACT_MAX_GB.
 */
export function archiveMaxEntries(): number {
  const raw = Number(process.env.ARCHIVE_MAX_ENTRIES);
  return Number.isInteger(raw) && raw > 0 ? raw : DEFAULT_MAX_ENTRIES;
}

export interface ScanOptions {
  /** Defaults to archiveMaxEntries(). */
  maxEntries?: number;
}

export type EntryVisitor = (entry: ArchiveEntry) => void;

// ============================================================
// Messages
// ============================================================

export const TYPE_REASONS: Partial<Record<ArchiveEntryType, string>> = {
  symlink: 'it is a symbolic link',
  hardlink: 'it is a hard link',
  special: 'it is a device, FIFO or other special file',
};

export function describeName(name: string): string {
  // eslint-disable-next-line no-control-regex
  const printable = name.replace(/[\x00-\x1f\x7f]/g, '?');
  return printable.length > NAME_DISPLAY_MAX
    ? `${printable.slice(0, NAME_DISPLAY_MAX)}...`
    : printable;
}

export function rejectedEntry(name: string, reason: string): ArchiveRejectedError {
  return new ArchiveRejectedError(
    `Archive rejected: "${describeName(name)}" is not allowed because ${reason}. ` +
      'Archives may only contain regular files and folders with relative paths.',
  );
}

// ============================================================
// Limits shared by both formats
// ============================================================

/**
 * Counts what an extractor creates: every member plus the folders its path
 * implies. Folders shared with the previous member are not counted again;
 * an archive in tree order (as tar and zip tools write them) is counted
 * exactly, any other order only too high, never too low.
 */
class EntryBudget {
  private created = 0;
  private previousDirs: string[] = [];

  constructor(private readonly max: number) {}

  add(entry: ArchiveEntry): void {
    // Whichever reading of the name implies the most folders is counted, in
    // case the extractor takes another one than the listing.
    const parts = [entry.name, ...entry.aliases]
      .map((n) => n.split(/[/\\]/).filter((p) => p !== '' && p !== '.'))
      .reduce((a, b) => (b.length > a.length ? b : a));
    const dirs = entry.type === 'directory' ? parts : parts.slice(0, -1);
    let shared = 0;
    while (
      shared < dirs.length &&
      shared < this.previousDirs.length &&
      dirs[shared] === this.previousDirs[shared]
    ) {
      shared++;
    }
    this.created += dirs.length - shared + (entry.type === 'directory' ? 0 : 1);
    this.previousDirs = dirs;
    if (this.created > this.max) {
      throw new ArchiveRejectedError(
        `Archive rejected: it creates more than ${this.max} files and folders (ARCHIVE_MAX_ENTRIES).`,
      );
    }
  }
}

/** Check the name limits, count the member and pass it on. */
function emitter(visit: EntryVisitor, options: ScanOptions): EntryVisitor {
  const budget = new EntryBudget(options.maxEntries ?? archiveMaxEntries());
  return (entry) => {
    for (const name of [entry.name, ...entry.aliases]) {
      if (Buffer.byteLength(name, 'utf8') > ARCHIVE_NAME_MAX_BYTES) {
        throw rejectedEntry(name, `its path is longer than ${ARCHIVE_NAME_MAX_BYTES} bytes`);
      }
    }
    budget.add(entry);
    visit(entry);
  };
}

// ============================================================
// tar.gz member listing (streamed, nothing is written to disk)
// ============================================================

const TAR_BLOCK = 512;
// PAX payloads (path, times, ...); a path in there is capped at
// ARCHIVE_NAME_MAX_BYTES anyway.
const MAX_TAR_META_BYTES = 64 * 1024;
// GNU long name / long link payload: the name plus its NUL.
const MAX_TAR_LONG_NAME_BYTES = ARCHIVE_NAME_MAX_BYTES + 1;

type TarMetaKind = 'pax' | 'paxGlobal' | 'longName' | 'longLink';

function readCString(buf: Buffer, offset: number, length: number): string {
  const nul = buf.indexOf(0, offset);
  const end = nul === -1 || nul > offset + length ? offset + length : nul;
  return buf.toString('utf8', offset, end);
}

function readTarNumber(block: Buffer, offset: number, length: number): number {
  if (block[offset] & 0x80) {
    // GNU base-256 encoding (sizes beyond the octal limit). Only the plain
    // positive marker 0x80 is accepted: BusyBox tar ignores the low bits of
    // the first byte, GNU tar counts them, so any other marker would make the
    // two read different sizes (and different headers) from the same bytes.
    if (block[offset] !== 0x80) throw new ArchiveRejectedError(NOT_A_TAR_GZ);
    let value = 0;
    for (let i = offset + 1; i < offset + length; i++) value = value * 256 + block[i];
    // Beyond 2^53 the arithmetic above is no longer exact (and no real
    // archive is that large).
    if (!Number.isSafeInteger(value)) throw new ArchiveRejectedError(NOT_A_TAR_GZ);
    return value;
  }
  // Octal: optional leading spaces, the digits, then only NULs or spaces.
  // BusyBox reads the field as a C string, so digits after a NUL ("\0\0012")
  // count as 0 there; accepting them here would make the two read different
  // sizes (and so different headers) from the same bytes.
  const match = /^ *([0-7]*)[\0 ]*$/.exec(block.toString('latin1', offset, offset + length));
  if (!match) throw new ArchiveRejectedError(NOT_A_TAR_GZ);
  return match[1] === '' ? 0 : parseInt(match[1], 8);
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
  private header = Buffer.alloc(0);
  private skip = 0;
  private meta: { kind: TarMetaKind; remaining: number; padding: number; chunks: Buffer[] } | null =
    null;
  private paxPath: string | undefined;
  private paxSize: number | undefined;
  private paxSparse = false;
  private longName: string | undefined;
  // BusyBox keeps one name override and the PAX path or GNU long name read
  // last replaces it, so the order decides which one the extractor uses.
  private lastOverride: 'pax' | 'longName' | undefined;
  private zeroBlocks = 0;
  private ended = false;

  constructor(private readonly emit: EntryVisitor) {}

  /** Two zero blocks were read; nothing after them is part of the archive. */
  get isEnded(): boolean {
    return this.ended;
  }

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
      const isLongName = metaKind === 'longName' || metaKind === 'longLink';
      if (isLongName && headerSize > MAX_TAR_LONG_NAME_BYTES) {
        throw new ArchiveRejectedError(
          `Archive rejected: a member name is longer than ${ARCHIVE_NAME_MAX_BYTES} bytes.`,
        );
      }
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
    // BusyBox tar joins a non-empty prefix field whatever the magic says;
    // GNU tar only for POSIX ustar (old GNU headers keep timestamps there).
    // The listing follows BusyBox, the manager's extractor; the plain name
    // stays an alias, so both readings are checked.
    const prefixField = readCString(block, 345, 155);
    const headerName = prefixField ? `${prefixField}/${rawName}` : rawName;
    const name =
      (this.lastOverride === 'longName' ? this.longName : this.paxPath) ??
      this.longName ??
      headerName;
    const aliases = [
      headerName,
      rawName,
      prefixField ? `${prefixField}/${rawName}` : undefined,
      this.paxPath,
      this.longName,
    ].filter((n): n is string => n !== undefined && n !== '' && n !== name);
    // A PAX sparse member is a regular-file header whose real (unpacked) size
    // lives in a GNU.sparse.* record; it is refused like the GNU 'S' type.
    const type = this.paxSparse ? 'special' : tarEntryType(typeflag, name);
    // BusyBox tar (the extractor in the Alpine-based manager image) ignores a
    // PAX size record and reads the header size; GNU tar does the opposite.
    // If they differ, the two read different headers from the same bytes and
    // a link could hide in what this scan treats as file data.
    if (this.paxSize !== undefined && this.paxSize !== headerSize) {
      throw new ArchiveRejectedError(
        `Archive rejected: the size of "${describeName(name)}" is ambiguous ` +
          `(the PAX header says ${this.paxSize} bytes, the tar header ${headerSize}).`,
      );
    }
    const size = headerSize;
    // GNU tar reads no data for a folder entry, this scanner would skip it:
    // a folder "carrying data" could hide the next header from the scan.
    if (type === 'directory' && size > 0) {
      throw rejectedEntry(name, 'it is a folder entry that carries data');
    }
    this.emit({
      name,
      aliases: [...new Set(aliases)],
      type,
      size: type === 'directory' ? 0 : size,
    });
    this.paxPath = undefined;
    this.paxSize = undefined;
    this.paxSparse = false;
    this.longName = undefined;
    this.lastOverride = undefined;
    this.skip = Math.ceil(size / TAR_BLOCK) * TAR_BLOCK;
  }

  private finishMeta(): void {
    const meta = this.meta!;
    this.meta = null;
    this.skip = meta.padding;
    const data = Buffer.concat(meta.chunks);
    if (meta.kind === 'longName') {
      this.longName = readCString(data, 0, data.length);
      this.lastOverride = 'longName';
      return;
    }
    if (meta.kind === 'longLink') return; // link targets are irrelevant: links are refused anyway
    const records = parsePaxRecords(data);
    if (meta.kind === 'paxGlobal') {
      for (const key of Object.keys(records)) {
        if (['path', 'linkpath', 'size'].includes(key) || key.startsWith('GNU.sparse.')) {
          throw new ArchiveRejectedError(
            `Archive rejected: a global tar header overrides the member ${key}, which is not supported.`,
          );
        }
      }
      return;
    }
    if (records.path !== undefined) {
      this.paxPath = records.path;
      this.lastOverride = 'pax';
    }
    if (Object.keys(records).some((key) => key.startsWith('GNU.sparse.'))) this.paxSparse = true;
    if (records.size !== undefined) {
      if (!/^\d+$/.test(records.size)) throw new ArchiveRejectedError(NOT_A_TAR_GZ);
      this.paxSize = Number(records.size);
    }
  }
}

async function scanTarGzEntries(archivePath: string, emit: EntryVisitor): Promise<void> {
  const scanner = new TarHeaderScanner(emit);
  // Whatever follows the end marker is not decompressed (a gzip bomb there
  // would only cost time).
  const done = new AbortController();
  try {
    await pipeline(
      createReadStream(archivePath),
      createGunzip(),
      new Writable({
        write(chunk: Buffer, _encoding, callback) {
          try {
            scanner.push(chunk);
            callback();
            if (scanner.isEnded) done.abort();
          } catch (err) {
            callback(err as Error);
          }
        },
      }),
      { signal: done.signal },
    );
  } catch (err) {
    if (scanner.isEnded && done.signal.aborted) return;
    if (err instanceof ArchiveRejectedError) throw err;
    // zlib reports a non-gzip / corrupt stream with Z_* codes.
    if (String((err as NodeJS.ErrnoException).code ?? '').startsWith('Z_')) {
      throw new ArchiveRejectedError(NOT_A_TAR_GZ);
    }
    throw err;
  }
  scanner.finish();
}

// ============================================================
// zip member listing (central directory only)
// ============================================================

const ZIP_EOCD_SIG = 0x06054b50;
const ZIP64_LOCATOR_SIG = 0x07064b50;
const ZIP64_EOCD_SIG = 0x06064b50;
const ZIP_CENTRAL_SIG = 0x02014b50;
const ZIP_UNICODE_PATH_EXTRA = 0x7075;
const ZIP64_EXTRA = 0x0001;
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

function findZipExtraField(extra: Buffer, wantedId: number): Buffer | null {
  let pos = 0;
  while (pos + 4 <= extra.length) {
    const id = extra.readUInt16LE(pos);
    const length = extra.readUInt16LE(pos + 2);
    const start = pos + 4;
    const end = start + length;
    if (end > extra.length) break;
    if (id === wantedId) return extra.subarray(start, end);
    pos = end;
  }
  return null;
}

/**
 * Info-ZIP unicode path extra field (0x7075): version 1, the CRC-32 of the
 * plain name, then the UTF-8 path. unzip uses it instead of the plain name
 * only for a name not flagged as UTF-8 and only while the CRC still matches
 * that name (measured with the manager image's UnZip 6.00). `current` says
 * whether it applies, so the listing names the member the way unzip will.
 */
function readZipUnicodePath(
  extra: Buffer,
  rawName: Buffer,
  nameIsUtf8: boolean,
): { path: string; current: boolean } | null {
  const field = findZipExtraField(extra, ZIP_UNICODE_PATH_EXTRA);
  if (!field || field.length < 5) return null;
  const current = !nameIsUtf8 && field[0] === 1 && field.readUInt32LE(1) === crc32(rawName);
  return { path: field.toString('utf8', 5), current };
}

/**
 * Uncompressed size of a central directory entry. Members of 4 GiB and more
 * store 0xffffffff and carry the real value in the ZIP64 extra field, whose
 * first slot is the uncompressed size.
 */
function readZipUncompressedSize(size32: number, extra: Buffer): number {
  if (size32 !== 0xffffffff) return size32;
  const field = findZipExtraField(extra, ZIP64_EXTRA);
  if (!field || field.length < 8) throw new ArchiveRejectedError(NOT_A_ZIP);
  return Number(field.readBigUInt64LE(0));
}

function zipEntryType(externalAttributes: number, name: string): ArchiveEntryType {
  // The upper 16 bits carry the Unix st_mode for archives made on Unix-like hosts.
  const kind = (externalAttributes >>> 16) & 0xffff & S_IFMT;
  if (kind === S_IFLNK) return 'symlink';
  if (kind === S_IFDIR) return 'directory';
  if (kind === 0 || kind === S_IFREG) return name.endsWith('/') ? 'directory' : 'file';
  return 'special';
}

const ZIP_CENTRAL_HEADER = 46;
const ZIP_CD_READ_BYTES = 1024 * 1024;

/**
 * Sequential reader over the central directory, one chunk at a time: a
 * directory of hundreds of MB never has to be in memory at once.
 */
class ZipCentralDirectoryReader {
  private buf = Buffer.alloc(0);
  private offset = 0;

  constructor(
    private readonly fh: FileHandle,
    private next: number,
    private readonly end: number,
  ) {}

  get remaining(): number {
    return this.buf.length - this.offset + (this.end - this.next);
  }

  /** The next `length` bytes. */
  async take(length: number): Promise<Buffer> {
    if (length > this.remaining) throw new ArchiveRejectedError(NOT_A_ZIP);
    if (this.buf.length - this.offset < length) {
      const missing = length - (this.buf.length - this.offset);
      const want = Math.min(Math.max(ZIP_CD_READ_BYTES, missing), this.end - this.next);
      const more = await readExactly(this.fh, want, this.next);
      this.next += want;
      this.buf = Buffer.concat([this.buf.subarray(this.offset), more]);
      this.offset = 0;
    }
    const out = this.buf.subarray(this.offset, this.offset + length);
    this.offset += length;
    return out;
  }
}

async function scanZipCentralDirectory(
  reader: ZipCentralDirectoryReader,
  count: number,
  emit: EntryVisitor,
): Promise<void> {
  for (let i = 0; i < count; i++) {
    const header = await reader.take(ZIP_CENTRAL_HEADER);
    if (header.readUInt32LE(0) !== ZIP_CENTRAL_SIG) throw new ArchiveRejectedError(NOT_A_ZIP);
    const flags = header.readUInt16LE(8);
    const uncompressedSize32 = header.readUInt32LE(24);
    const nameLength = header.readUInt16LE(28);
    const extraLength = header.readUInt16LE(30);
    const commentLength = header.readUInt16LE(32);
    const externalAttributes = header.readUInt32LE(38);
    const nameAndExtra = await reader.take(nameLength + extraLength);
    await reader.take(commentLength);

    // Bit 11 = UTF-8 name; otherwise CP437, for which latin1 keeps every ASCII byte intact.
    const plainName = nameAndExtra.toString(flags & 0x800 ? 'utf8' : 'latin1', 0, nameLength);
    const extra = nameAndExtra.subarray(nameLength);
    const unicode = readZipUnicodePath(
      extra,
      nameAndExtra.subarray(0, nameLength),
      (flags & 0x800) !== 0,
    );
    const name = unicode?.current ? unicode.path : plainName;
    const type = zipEntryType(externalAttributes, name);
    emit({
      name,
      // The name unzip does not use is checked as well.
      aliases: [plainName, unicode?.path].filter((n): n is string => n !== undefined && n !== name),
      type,
      size: type === 'directory' ? 0 : readZipUncompressedSize(uncompressedSize32, extra),
    });
  }
  // Entries beyond the declared count (e.g. a wrapped 16-bit count) would be
  // seen by some unzip builds but not by this parser.
  if (reader.remaining !== 0) throw new ArchiveRejectedError(NOT_A_ZIP);
}

async function scanZipEntries(
  archivePath: string,
  emit: EntryVisitor,
  maxEntries: number,
): Promise<void> {
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
    // Every member creates at least one entry, so the declared count alone
    // can already be too many.
    if (count > maxEntries) {
      throw new ArchiveRejectedError(
        `Archive rejected: it creates more than ${maxEntries} files and folders (ARCHIVE_MAX_ENTRIES).`,
      );
    }
    await scanZipCentralDirectory(new ZipCentralDirectoryReader(fh, cdOffset, cdEnd), count, emit);
  } finally {
    await fh.close();
  }
}

// ============================================================
// Public API
// ============================================================

/**
 * Read the members of an archive and hand each to `visit` as soon as it is
 * read; an error thrown by `visit` (or a broken limit) stops the scan.
 * Throws ArchiveRejectedError for archives that are invalid or too large.
 */
export async function scanArchiveEntries(
  archivePath: string,
  format: ArchiveFormat,
  visit: EntryVisitor,
  options: ScanOptions = {},
): Promise<void> {
  const emit = emitter(visit, options);
  if (format === 'zip') {
    await scanZipEntries(archivePath, emit, options.maxEntries ?? archiveMaxEntries());
  } else {
    await scanTarGzEntries(archivePath, emit);
  }
}

/** All members as a list (bounded by the entry limit); production code scans instead. */
export async function listArchiveEntries(
  archivePath: string,
  format: ArchiveFormat,
  options: ScanOptions = {},
): Promise<ArchiveEntry[]> {
  const entries: ArchiveEntry[] = [];
  await scanArchiveEntries(archivePath, format, (entry) => entries.push(entry), options);
  return entries;
}
