/**
 * Reads META-INF/MANIFEST.MF straight out of a JAR (zip) file.
 *
 * The panel needs the version of HytaleServer.jar files it does not run: the
 * staged update, the native updater backup and JAR snapshots. Starting a JVM
 * for that is slow and only possible inside the game container, so this parses
 * the zip central directory with plain fs + zlib instead (no extra dependency).
 *
 * Only what a JAR needs is supported: stored or deflated entries, ZIP64
 * end-of-central-directory records (large JARs exceed 65535 entries).
 */
import { constants as fsConstants } from 'fs';
import { open } from 'fs/promises';
import { inflateRawSync } from 'zlib';

// POSIX only; undefined on Windows (dev/tests).
const NO_FOLLOW = fsConstants.O_NOFOLLOW ?? 0;
const NON_BLOCK = fsConstants.O_NONBLOCK ?? 0;

const EOCD_SIG = 0x06054b50;
const ZIP64_LOCATOR_SIG = 0x07064b50;
const ZIP64_EOCD_SIG = 0x06064b50;
const CDH_SIG = 0x02014b50;
const LFH_SIG = 0x04034b50;
const EOCD_MIN = 22;
const MAX_COMMENT = 0xffff;
// A manifest is a few hundred bytes; anything bigger is not a manifest we trust.
const MAX_MANIFEST_BYTES = 1024 * 1024;
// Upper bound for the central directory we are willing to read into memory.
const MAX_CENTRAL_DIR_BYTES = 64 * 1024 * 1024;
const CD_WINDOW_BYTES = 64 * 1024;
const MANIFEST_NAME = 'META-INF/MANIFEST.MF';
const HYTALE_VENDOR_ID = 'com.hypixel.hytale';

export type JarManifest = Record<string, string>;

export interface HytaleJarVersion {
  version: string;
  patchline: string | null;
}

interface FileHandleLike {
  read(
    buffer: Buffer,
    offset: number,
    length: number,
    position: number,
  ): Promise<{ bytesRead: number }>;
}

async function readAt(fh: FileHandleLike, position: number, length: number): Promise<Buffer> {
  const buf = Buffer.alloc(length);
  let done = 0;
  while (done < length) {
    const { bytesRead } = await fh.read(buf, done, length - done, position + done);
    if (bytesRead === 0) throw new Error('Unexpected end of file');
    done += bytesRead;
  }
  return buf;
}

/** Locates the central directory: { offset, size } from the (ZIP64) EOCD record. */
async function findCentralDirectory(
  fh: FileHandleLike,
  fileSize: number,
): Promise<{ offset: number; size: number }> {
  const tailLen = Math.min(fileSize, EOCD_MIN + MAX_COMMENT);
  const tailStart = fileSize - tailLen;
  const tail = await readAt(fh, tailStart, tailLen);
  let eocd = -1;
  for (let i = tail.length - EOCD_MIN; i >= 0; i--) {
    if (tail.readUInt32LE(i) === EOCD_SIG) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('Not a zip file (no end of central directory)');

  let size = tail.readUInt32LE(eocd + 12);
  let offset = tail.readUInt32LE(eocd + 16);
  if (size === 0xffffffff || offset === 0xffffffff) {
    // ZIP64: the locator sits directly in front of the classic EOCD record.
    const locatorPos = tailStart + eocd - 20;
    if (locatorPos < 0) throw new Error('Truncated ZIP64 locator');
    const locator = await readAt(fh, locatorPos, 20);
    if (locator.readUInt32LE(0) !== ZIP64_LOCATOR_SIG) throw new Error('Missing ZIP64 locator');
    const recordPos = Number(locator.readBigUInt64LE(8));
    const record = await readAt(fh, recordPos, 56);
    if (record.readUInt32LE(0) !== ZIP64_EOCD_SIG) throw new Error('Missing ZIP64 record');
    size = Number(record.readBigUInt64LE(40));
    offset = Number(record.readBigUInt64LE(48));
  }
  if (offset + size > fileSize || size > MAX_CENTRAL_DIR_BYTES) {
    throw new Error('Invalid central directory bounds');
  }
  return { offset, size };
}

/** Reads the ZIP64 extra field values that replace 0xFFFFFFFF placeholders. */
function applyZip64Extra(
  extra: Buffer,
  fields: { uncompressed: number; compressed: number; localOffset: number },
): void {
  let p = 0;
  while (p + 4 <= extra.length) {
    const id = extra.readUInt16LE(p);
    const len = extra.readUInt16LE(p + 2);
    if (id === 0x0001) {
      let q = p + 4;
      const end = q + len;
      if (fields.uncompressed === 0xffffffff && q + 8 <= end) {
        fields.uncompressed = Number(extra.readBigUInt64LE(q));
        q += 8;
      }
      if (fields.compressed === 0xffffffff && q + 8 <= end) {
        fields.compressed = Number(extra.readBigUInt64LE(q));
        q += 8;
      }
      if (fields.localOffset === 0xffffffff && q + 8 <= end) {
        fields.localOffset = Number(extra.readBigUInt64LE(q));
      }
      return;
    }
    p += 4 + len;
  }
}

interface ManifestEntry {
  method: number;
  compressed: number;
  uncompressed: number;
  localOffset: number;
}

/**
 * Scans central directory records for the manifest. Returns 'more' when the
 * buffer ended before the manifest was found (it may be a partial window),
 * null when the records stop (end of directory or garbage).
 */
function findEntry(dir: Buffer): ManifestEntry | 'more' | null {
  let p = 0;
  while (p + 46 <= dir.length) {
    if (dir.readUInt32LE(p) !== CDH_SIG) return null;
    const nameLen = dir.readUInt16LE(p + 28);
    const extraLen = dir.readUInt16LE(p + 30);
    const commentLen = dir.readUInt16LE(p + 32);
    const end = p + 46 + nameLen + extraLen + commentLen;
    if (end > dir.length) return 'more';
    if (dir.toString('utf8', p + 46, p + 46 + nameLen) === MANIFEST_NAME) {
      const fields = {
        compressed: dir.readUInt32LE(p + 20),
        uncompressed: dir.readUInt32LE(p + 24),
        localOffset: dir.readUInt32LE(p + 42),
      };
      applyZip64Extra(dir.subarray(p + 46 + nameLen, p + 46 + nameLen + extraLen), fields);
      return { method: dir.readUInt16LE(p + 10), ...fields };
    }
    p = end;
  }
  return 'more';
}

/** Parses manifest text: "Key: Value" lines, continuation lines start with one space. */
export function parseManifest(text: string): JarManifest {
  const result: JarManifest = Object.create(null);
  let lastKey: string | null = null;
  for (const raw of text.split(/\r\n|\n|\r/)) {
    // Only the main section counts; per-entry sections follow the first blank line.
    if (raw === '') break;
    if (raw.startsWith(' ') && lastKey) {
      result[lastKey] += raw.slice(1);
      continue;
    }
    const idx = raw.indexOf(':');
    if (idx <= 0) {
      lastKey = null;
      continue;
    }
    lastKey = raw.slice(0, idx).trim();
    if (Object.hasOwn(result, lastKey)) {
      lastKey = null;
      continue;
    }
    result[lastKey] = raw.slice(idx + 1).trim();
  }
  return { ...result };
}

/**
 * Returns the main manifest attributes of a JAR, or null when the file does not
 * exist, is not a zip or has no manifest. Never throws.
 */
export async function readJarManifest(jarPath: string): Promise<JarManifest | null> {
  let fh;
  try {
    // The JARs lie in folders the game server can write to: a symlink is not
    // followed, and a FIFO in place of the JAR must not block the thread.
    fh = await open(jarPath, fsConstants.O_RDONLY | NO_FOLLOW | NON_BLOCK);
  } catch {
    return null;
  }
  try {
    const st = await fh.stat();
    if (!st.isFile()) return null;
    const fileSize = st.size;
    const cd = await findCentralDirectory(fh, fileSize);
    // The manifest is normally one of the first entries, so a small window of
    // the central directory (a server JAR has ~40k entries, ~4 MB) is enough.
    let entry = findEntry(await readAt(fh, cd.offset, Math.min(cd.size, CD_WINDOW_BYTES)));
    if (entry === 'more' && cd.size > CD_WINDOW_BYTES) {
      entry = findEntry(await readAt(fh, cd.offset, cd.size));
    }
    if (!entry || entry === 'more') return null;
    if (entry.uncompressed > MAX_MANIFEST_BYTES || entry.compressed > MAX_MANIFEST_BYTES) {
      return null;
    }
    const lfh = await readAt(fh, entry.localOffset, 30);
    if (lfh.readUInt32LE(0) !== LFH_SIG) return null;
    const dataStart = entry.localOffset + 30 + lfh.readUInt16LE(26) + lfh.readUInt16LE(28);
    const data = await readAt(fh, dataStart, entry.compressed);
    let content: Buffer;
    if (entry.method === 0) content = data;
    else if (entry.method === 8) {
      content = inflateRawSync(data, { maxOutputLength: MAX_MANIFEST_BYTES });
    } else return null;
    return parseManifest(content.toString('utf8'));
  } catch {
    return null;
  } finally {
    await fh.close().catch(() => undefined);
  }
}

/**
 * Version and patchline of a Hytale server JAR, read the same way the server
 * itself reads a staged JAR: only JARs whose vendor id is Hypixel count.
 */
export async function readHytaleJarVersion(jarPath: string): Promise<HytaleJarVersion | null> {
  const manifest = await readJarManifest(jarPath);
  if (!manifest || manifest['Implementation-Vendor-Id'] !== HYTALE_VENDOR_ID) return null;
  const version = manifest['Implementation-Version'];
  if (!version) return null;
  return { version, patchline: manifest['Implementation-Patchline'] || null };
}
