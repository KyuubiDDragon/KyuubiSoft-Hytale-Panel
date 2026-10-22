/**
 * Tests for the archive safety layer used by world import/restore and the
 * asset extraction. Archives are built byte-by-byte here so hostile members
 * (symlinks, hardlinks, "..", absolute paths, PAX/unicode-name tricks) can be
 * produced without relying on the local tar/zip tools.
 *
 * The end-to-end extraction cases shell out to the system tar/unzip and are
 * skipped on Windows (CI runs them on Linux).
 */
import fs from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';
import { gzipSync } from 'zlib';
import { spawnSync } from 'child_process';
import { describe, it, beforeEach, afterEach, expect } from 'vitest';
import {
  ArchiveRejectedError,
  ArchiveSpaceError,
  archiveFormatFromName,
  assertFreeSpace,
  assertSafeArchive,
  assertSafeExtractedTree,
  extractArchiveSafely,
  extractToStaging,
  inspectArchive,
  listArchiveEntries,
  scanArchiveEntries,
} from './archiveSafety.js';
import { ARCHIVE_NAME_MAX_BYTES, archiveMaxEntries } from './archiveListing.js';

// ------------------------------------------------------------
// Archive builders
// ------------------------------------------------------------

interface TarMember {
  name: string;
  type?: string; // tar typeflag, default '0'
  data?: string;
  linkname?: string;
  pax?: Record<string, string>;
  longName?: string; // emit a GNU 'L' record before the header
  mode?: number; // default 0755 for folders, 0644 otherwise
  size?: number; // header size override (default: data length for files, 0 otherwise)
  base256Size?: boolean; // encode the size in GNU base-256 instead of octal
  globalPax?: Record<string, string>; // emit a global 'g' header before the member
  zeroBlockBefore?: boolean; // emit a lone zero block before the member
}

function tarHeader(
  name: string,
  typeflag: string,
  size: number,
  linkname = '',
  mode?: number,
  base256Size = false,
): Buffer {
  const h = Buffer.alloc(512);
  h.write(name, 0, 100, 'utf8');
  h.write(
    `${(mode ?? (typeflag === '5' ? 0o755 : 0o644)).toString(8).padStart(7, '0')}\0`,
    100,
    'latin1',
  );
  h.write('0000000\0', 108, 'latin1');
  h.write('0000000\0', 116, 'latin1');
  if (base256Size) {
    h[124] = 0x80;
    let rest = size;
    for (let i = 135; i > 124; i--) {
      h[i] = rest % 256;
      rest = Math.floor(rest / 256);
    }
  } else {
    h.write(`${size.toString(8).padStart(11, '0')}\0`, 124, 'latin1');
  }
  h.write('00000000000\0', 136, 'latin1');
  h.write('        ', 148, 'latin1');
  h.write(typeflag, 156, 'latin1');
  h.write(linkname, 157, 100, 'utf8');
  h.write('ustar\0', 257, 'latin1');
  h.write('00', 263, 'latin1');
  let sum = 0;
  for (const b of h) sum += b;
  h.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 'latin1');
  return h;
}

function padBlock(buf: Buffer): Buffer {
  const rem = buf.length % 512;
  return rem === 0 ? buf : Buffer.concat([buf, Buffer.alloc(512 - rem)]);
}

function paxData(fields: Record<string, string>): Buffer {
  let out = '';
  for (const [key, value] of Object.entries(fields)) {
    const body = ` ${key}=${value}\n`;
    const bodyBytes = Buffer.byteLength(body);
    let length = bodyBytes + 1;
    while (String(length).length + bodyBytes !== length) length = String(length).length + bodyBytes;
    out += `${length}${body}`;
  }
  return Buffer.from(out, 'utf8');
}

function buildTarGz(members: TarMember[]): Buffer {
  const parts: Buffer[] = [];
  for (const m of members) {
    if (m.zeroBlockBefore) parts.push(Buffer.alloc(512));
    if (m.globalPax) {
      const data = paxData(m.globalPax);
      parts.push(tarHeader('GlobalHead', 'g', data.length), padBlock(data));
    }
    if (m.pax) {
      const data = paxData(m.pax);
      parts.push(tarHeader('PaxHeader', 'x', data.length), padBlock(data));
    }
    if (m.longName) {
      const data = Buffer.from(`${m.longName}\0`, 'utf8');
      parts.push(tarHeader('././@LongLink', 'L', data.length), padBlock(data));
    }
    const type = m.type ?? '0';
    const data = Buffer.from(m.data ?? '', 'utf8');
    const size = m.size ?? (type === '0' ? data.length : 0);
    parts.push(tarHeader(m.name, type, size, m.linkname, m.mode, m.base256Size));
    if (data.length > 0) parts.push(padBlock(data));
  }
  parts.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(parts));
}

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf: Buffer): number {
  let c = -1;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

interface ZipMember {
  name: string;
  data?: string;
  mode?: number; // Unix st_mode stored in the upper 16 bits of the external attributes
  unicodeName?: string; // Info-ZIP unicode path extra field
}

interface ZipLayout {
  prepend?: Buffer; // bytes in front of the zip (self-extractor style), offsets stay relative
  declaredCount?: number; // entry count written to the end record
}

function buildZip(members: ZipMember[], layout: ZipLayout = {}): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const m of members) {
    const name = Buffer.from(m.name, 'utf8');
    const data = Buffer.from(m.data ?? '', 'utf8');
    const crc = crc32(data);
    let extra = Buffer.alloc(0);
    if (m.unicodeName !== undefined) {
      const uname = Buffer.from(m.unicodeName, 'utf8');
      extra = Buffer.alloc(4 + 5 + uname.length);
      extra.writeUInt16LE(0x7075, 0);
      extra.writeUInt16LE(5 + uname.length, 2);
      extra.writeUInt8(1, 4);
      extra.writeUInt32LE(crc32(name), 5);
      uname.copy(extra, 9);
    }

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x800, 6);
    local.writeUInt16LE(0, 8); // stored
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0x21, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(extra.length, 28);
    const localRecord = Buffer.concat([local, name, extra, data]);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE((3 << 8) | 30, 4); // made by Unix
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x800, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0x21, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(extra.length, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    const mode = m.mode ?? (m.name.endsWith('/') ? 0o040755 : 0o100644);
    central.writeUInt32LE((mode << 16) >>> 0, 38);
    central.writeUInt32LE(offset, 42);
    centrals.push(Buffer.concat([central, name, extra]));

    locals.push(localRecord);
    offset += localRecord.length;
  }
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  const count = layout.declaredCount ?? members.length;
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(count, 8);
  eocd.writeUInt16LE(count, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([layout.prepend ?? Buffer.alloc(0), ...locals, cd, eocd]);
}

// ------------------------------------------------------------
// Helpers
// ------------------------------------------------------------

let work: string;

beforeEach(() => {
  work = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kp-archive-')));
});

afterEach(() => {
  fs.rmSync(work, { recursive: true, force: true });
});

function writeArchive(name: string, content: Buffer): string {
  const file = path.join(work, name);
  fs.writeFileSync(file, content);
  return file;
}

async function expectRejected(promise: Promise<unknown>, pattern: RegExp): Promise<void> {
  const err = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(ArchiveRejectedError);
  expect((err as Error).message).toMatch(pattern);
}

function hasTool(cmd: string, args: string[]): boolean {
  try {
    return spawnSync(cmd, args, { stdio: 'ignore' }).status === 0;
  } catch {
    return false;
  }
}

function canCreateLink(type: 'file' | 'junction'): boolean {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kp-link-probe-'));
  try {
    const target = path.join(dir, 'target');
    if (type === 'file') fs.writeFileSync(target, '');
    else fs.mkdirSync(target);
    fs.symlinkSync(target, path.join(dir, 'link'), type);
    return true;
  } catch {
    return false;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// GNU tar on Windows reads "C:\..." as a remote host spec, so the
// extraction round-trips only run on POSIX (CI is Linux).
const IS_WINDOWS = process.platform === 'win32';
const HAS_TAR = !IS_WINDOWS && hasTool('tar', ['--version']);
const HAS_UNZIP = !IS_WINDOWS && hasTool('unzip', ['-v']);
// GNU tar applies directory modes only after extracting; BusyBox applies them
// immediately and then cannot write into a folder archived without the x bit.
const IS_GNU_TAR = HAS_TAR && /GNU tar/.test(String(spawnSync('tar', ['--version']).stdout));
const CAN_LINK_DIRS = canCreateLink('junction');

// ------------------------------------------------------------
// Tests
// ------------------------------------------------------------

describe('archiveFormatFromName', () => {
  it('maps supported extensions and rejects others', () => {
    expect(archiveFormatFromName('World.ZIP')).toBe('zip');
    expect(archiveFormatFromName('world.tar.gz')).toBe('tar.gz');
    expect(archiveFormatFromName('world.tgz')).toBe('tar.gz');
    expect(archiveFormatFromName('world.tar')).toBeNull();
    expect(archiveFormatFromName('world.rar')).toBeNull();
  });
});

describe('tar.gz member validation', () => {
  it('lists regular files and folders and accepts them', async () => {
    const file = writeArchive(
      'ok.tar.gz',
      buildTarGz([
        { name: 'MyWorld/', type: '5' },
        { name: 'MyWorld/config.json', data: '{"Seed":1}' },
        { name: 'MyWorld/chunks/0.region', data: 'x'.repeat(1500) },
      ]),
    );
    const entries = await listArchiveEntries(file, 'tar.gz');
    expect(entries.map((e) => [e.name, e.type])).toEqual([
      ['MyWorld/', 'directory'],
      ['MyWorld/config.json', 'file'],
      ['MyWorld/chunks/0.region', 'file'],
    ]);
    await expect(assertSafeArchive(file, 'tar.gz')).resolves.toBeUndefined();
  });

  it('rejects a symlink member', async () => {
    const file = writeArchive(
      'link.tar.gz',
      buildTarGz([
        { name: 'MyWorld/', type: '5' },
        { name: 'MyWorld/config.json', type: '2', linkname: '/app/data/config.json' },
      ]),
    );
    await expectRejected(assertSafeArchive(file, 'tar.gz'), /symbolic link/);
  });

  it('rejects a hardlink member', async () => {
    const file = writeArchive(
      'hard.tar.gz',
      buildTarGz([{ name: 'MyWorld/users.json', type: '1', linkname: '/app/data/users.json' }]),
    );
    await expectRejected(assertSafeArchive(file, 'tar.gz'), /hard link/);
  });

  it('rejects device and FIFO members', async () => {
    for (const type of ['3', '4', '6']) {
      const file = writeArchive(`dev${type}.tar.gz`, buildTarGz([{ name: 'MyWorld/dev', type }]));
      await expectRejected(assertSafeArchive(file, 'tar.gz'), /special file/);
    }
  });

  it('rejects ".." components and absolute paths', async () => {
    const dotdot = writeArchive(
      'dotdot.tar.gz',
      buildTarGz([{ name: 'MyWorld/../../users.json', data: 'x' }]),
    );
    await expectRejected(assertSafeArchive(dotdot, 'tar.gz'), /contains "\.\."/);
    const absolute = writeArchive(
      'abs.tar.gz',
      buildTarGz([{ name: '/app/data/users.json', data: 'x' }]),
    );
    await expectRejected(assertSafeArchive(absolute, 'tar.gz'), /absolute path/);
    const backslash = writeArchive(
      'bs.tar.gz',
      buildTarGz([{ name: 'MyWorld\\..\\..\\users.json', data: 'x' }]),
    );
    await expectRejected(assertSafeArchive(backslash, 'tar.gz'), /contains "\.\."/);
  });

  it('checks the PAX path override, not just the plain header name', async () => {
    const file = writeArchive(
      'pax.tar.gz',
      buildTarGz([
        { name: 'MyWorld/harmless.txt', data: 'x', pax: { path: '../../app/data/users.json' } },
      ]),
    );
    await expectRejected(assertSafeArchive(file, 'tar.gz'), /contains "\.\."/);
  });

  it('honours GNU long names', async () => {
    const longName = `MyWorld/${'deep/'.repeat(30)}file.txt`;
    const file = writeArchive(
      'long.tar.gz',
      buildTarGz([{ name: 'placeholder', data: 'x', longName }]),
    );
    const entries = await listArchiveEntries(file, 'tar.gz');
    expect(entries[0].name).toBe(longName);

    const evil = writeArchive(
      'long-evil.tar.gz',
      buildTarGz([
        {
          name: 'placeholder',
          data: 'x',
          longName: `${'a/'.repeat(60)}${'../'.repeat(61)}app/data/users.json`,
        },
      ]),
    );
    await expectRejected(assertSafeArchive(evil, 'tar.gz'), /contains "\.\."/);
  });

  it('rejects data that is not a gzip tar', async () => {
    const notGzip = writeArchive('junk.tar.gz', Buffer.from('this is not an archive'));
    await expectRejected(assertSafeArchive(notGzip, 'tar.gz'), /not a valid \.tar\.gz/);
    const notTar = writeArchive('junk2.tar.gz', gzipSync(Buffer.alloc(512, 0x41)));
    await expectRejected(assertSafeArchive(notTar, 'tar.gz'), /not a valid \.tar\.gz/);
  });
});

describe('zip member validation', () => {
  it('lists regular files and folders and accepts them', async () => {
    const file = writeArchive(
      'ok.zip',
      buildZip([{ name: 'MyWorld/' }, { name: 'MyWorld/config.json', data: '{}' }]),
    );
    const entries = await listArchiveEntries(file, 'zip');
    expect(entries.map((e) => [e.name, e.type])).toEqual([
      ['MyWorld/', 'directory'],
      ['MyWorld/config.json', 'file'],
    ]);
    await expect(assertSafeArchive(file, 'zip')).resolves.toBeUndefined();
  });

  it('rejects a symlink member (Unix mode in the external attributes)', async () => {
    const file = writeArchive(
      'link.zip',
      buildZip([{ name: 'MyWorld/config.json', data: '/app/data/config.json', mode: 0o120777 }]),
    );
    await expectRejected(assertSafeArchive(file, 'zip'), /symbolic link/);
  });

  it('rejects FIFO/device members', async () => {
    const file = writeArchive('fifo.zip', buildZip([{ name: 'MyWorld/pipe', mode: 0o010644 }]));
    await expectRejected(assertSafeArchive(file, 'zip'), /special file/);
  });

  it('rejects "..", backslash traversal and absolute names', async () => {
    const dotdot = writeArchive('dotdot.zip', buildZip([{ name: '../users.json', data: 'x' }]));
    await expectRejected(assertSafeArchive(dotdot, 'zip'), /contains "\.\."/);
    const backslash = writeArchive(
      'bs.zip',
      buildZip([{ name: 'MyWorld\\..\\..\\users.json', data: 'x' }]),
    );
    await expectRejected(assertSafeArchive(backslash, 'zip'), /contains "\.\."/);
    const absolute = writeArchive(
      'abs.zip',
      buildZip([{ name: '/app/data/users.json', data: 'x' }]),
    );
    await expectRejected(assertSafeArchive(absolute, 'zip'), /absolute path/);
    const drive = writeArchive('drive.zip', buildZip([{ name: 'C:/Windows/x.txt', data: 'x' }]));
    await expectRejected(assertSafeArchive(drive, 'zip'), /absolute path/);
  });

  it('checks the unicode path extra field unzip would actually use', async () => {
    const file = writeArchive(
      'unicode.zip',
      buildZip([{ name: 'MyWorld/harmless.txt', data: 'x', unicodeName: '../../users.json' }]),
    );
    await expectRejected(assertSafeArchive(file, 'zip'), /contains "\.\."/);
  });

  it('names a member by its unicode path only where unzip uses it (no UTF-8 flag, CRC matches)', async () => {
    const file = writeArchive(
      'unicode-cp437.zip',
      buildZip([{ name: 'MyWorld/plain.txt', data: 'x', unicodeName: 'MyWorld/unicode.txt' }]),
    );
    // Clear the UTF-8 flag (bit 11) in the local and the central header.
    const raw = fs.readFileSync(file);
    raw.writeUInt16LE(0, raw.indexOf(Buffer.from([0x50, 0x4b, 0x03, 0x04])) + 6);
    raw.writeUInt16LE(0, raw.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02])) + 8);
    fs.writeFileSync(file, raw);
    const [entry] = await listArchiveEntries(file, 'zip');
    expect(entry.name).toBe('MyWorld/unicode.txt');
    expect(entry.aliases).toEqual(['MyWorld/plain.txt']);
  });

  it('names a member like unzip when its unicode path no longer matches the plain name', async () => {
    const file = writeArchive(
      'unicode-stale.zip',
      buildZip([{ name: 'MyWorld/plain.txt', data: 'x', unicodeName: 'MyWorld/unicode.txt' }]),
    );
    // The CRC in the extra field belongs to another plain name: unzip ignores the field.
    const raw = fs.readFileSync(file);
    const at = raw.indexOf(
      Buffer.from([0x75, 0x70]),
      raw.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02])),
    );
    raw.writeUInt32LE(0xdeadbeef, at + 5);
    fs.writeFileSync(file, raw);
    const [entry] = await listArchiveEntries(file, 'zip');
    expect(entry.name).toBe('MyWorld/plain.txt');
    expect(entry.aliases).toEqual(['MyWorld/unicode.txt']);

    // A stale field is still checked: it could be what another unzip build uses.
    const evil = writeArchive(
      'unicode-stale-evil.zip',
      buildZip([{ name: 'MyWorld/plain.txt', data: 'x', unicodeName: '../../users.json' }]),
    );
    const bytes = fs.readFileSync(evil);
    const pos = bytes.indexOf(
      Buffer.from([0x75, 0x70]),
      bytes.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02])),
    );
    bytes.writeUInt32LE(0xdeadbeef, pos + 5);
    fs.writeFileSync(evil, bytes);
    await expectRejected(assertSafeArchive(evil, 'zip'), /contains "\.\."/);
  });

  it('rejects data that is not a zip', async () => {
    const file = writeArchive('junk.zip', Buffer.from('definitely not a zip file, just text'));
    await expectRejected(assertSafeArchive(file, 'zip'), /not a valid \.zip/);
  });
});

// Cases where a naive scanner and the real tar/unzip would disagree about
// which members an archive contains.
describe('scanner/extractor agreement', () => {
  it('keeps scanning after a lone zero block, like tar does', async () => {
    const file = writeArchive(
      'lone-zero.tar.gz',
      buildTarGz([
        { name: 'MyWorld/config.json', data: '{}' },
        { name: 'MyWorld/escape', type: '2', linkname: '/app/data', zeroBlockBefore: true },
      ]),
    );
    await expectRejected(assertSafeArchive(file, 'tar.gz'), /symbolic link/);
  });

  it('rejects a folder entry that carries data (could hide the next header)', async () => {
    const file = writeArchive(
      'dir-data.tar.gz',
      buildTarGz([{ name: 'MyWorld/', type: '5', size: 512, data: 'x'.repeat(512) }]),
    );
    await expectRejected(assertSafeArchive(file, 'tar.gz'), /folder entry that carries data/);
  });

  it('rejects GNU dumpdir entries and global PAX overrides', async () => {
    const dumpdir = writeArchive('dumpdir.tar.gz', buildTarGz([{ name: 'MyWorld/', type: 'D' }]));
    await expectRejected(assertSafeArchive(dumpdir, 'tar.gz'), /special file/);
    for (const key of ['path', 'size', 'linkpath']) {
      const file = writeArchive(
        `global-${key}.tar.gz`,
        buildTarGz([
          { name: 'MyWorld/a.txt', data: 'x', globalPax: { [key]: key === 'size' ? '0' : 'x' } },
        ]),
      );
      await expectRejected(
        assertSafeArchive(file, 'tar.gz'),
        new RegExp(`global tar header overrides the member ${key}`),
      );
    }
  });

  it('reads GNU base-256 sizes so the following header is found', async () => {
    const file = writeArchive(
      'base256.tar.gz',
      buildTarGz([
        { name: 'MyWorld/big.bin', data: 'y'.repeat(700), base256Size: true },
        { name: 'MyWorld/escape', type: '2', linkname: '/' },
      ]),
    );
    const entries = await listArchiveEntries(file, 'tar.gz');
    expect(entries.map((e) => e.name)).toEqual(['MyWorld/big.bin', 'MyWorld/escape']);
    await expectRejected(assertSafeArchive(file, 'tar.gz'), /symbolic link/);
  });

  it('rejects a zip whose central directory is not where the end record says', async () => {
    const file = writeArchive(
      'prepended.zip',
      buildZip([{ name: 'MyWorld/config.json', data: '{}' }], {
        prepend: Buffer.from('#!/bin/sh\nexit 0\n'),
      }),
    );
    await expectRejected(assertSafeArchive(file, 'zip'), /central directory is not where/);
  });

  it('rejects a zip with more central-directory entries than declared', async () => {
    const file = writeArchive(
      'hidden.zip',
      buildZip(
        [
          { name: 'MyWorld/config.json', data: '{}' },
          { name: 'MyWorld/escape', data: '/app/data', mode: 0o120777 },
        ],
        { declaredCount: 1 },
      ),
    );
    await expectRejected(assertSafeArchive(file, 'zip'), /not a valid \.zip/);
  });
});

describe('assertSafeExtractedTree', () => {
  it('counts regular files in a clean tree', async () => {
    fs.mkdirSync(path.join(work, 'tree', 'World', 'chunks'), { recursive: true });
    fs.writeFileSync(path.join(work, 'tree', 'World', 'config.json'), '{}');
    fs.writeFileSync(path.join(work, 'tree', 'World', 'chunks', 'a'), 'a');
    expect(await assertSafeExtractedTree(path.join(work, 'tree'))).toBe(2);
  });

  it('rejects a hard-linked file', async () => {
    fs.mkdirSync(path.join(work, 'tree'));
    fs.writeFileSync(path.join(work, 'victim.json'), 'secret');
    fs.linkSync(path.join(work, 'victim.json'), path.join(work, 'tree', 'users.json'));
    await expectRejected(assertSafeExtractedTree(path.join(work, 'tree')), /hard link/);
  });

  it.skipIf(!CAN_LINK_DIRS)('rejects a symlinked directory', async () => {
    fs.mkdirSync(path.join(work, 'tree'));
    fs.mkdirSync(path.join(work, 'outside'));
    fs.symlinkSync(path.join(work, 'outside'), path.join(work, 'tree', 'escape'), 'junction');
    await expectRejected(assertSafeExtractedTree(path.join(work, 'tree')), /symbolic link/);
  });

  it.skipIf(IS_WINDOWS)('strips setuid/setgid bits from extracted files', async () => {
    fs.mkdirSync(path.join(work, 'tree'));
    const file = path.join(work, 'tree', 'tool.sh');
    fs.writeFileSync(file, '#!/bin/sh\n');
    fs.chmodSync(file, 0o6755);
    await assertSafeExtractedTree(path.join(work, 'tree'));
    expect(fs.statSync(file).mode & 0o7777).toBe(0o755);
  });
});

describe('extractArchiveSafely destination', () => {
  it.skipIf(!CAN_LINK_DIRS)(
    'refuses a destination folder that links outside the allowed roots',
    async () => {
      const data = path.join(work, 'data');
      const panel = path.join(work, 'panel-data');
      fs.mkdirSync(data);
      fs.mkdirSync(panel);
      fs.symlinkSync(panel, path.join(data, 'worlds'), 'junction');
      const file = writeArchive(
        'world.tar.gz',
        buildTarGz([{ name: 'users.json', data: '{"pwned":true}' }]),
      );
      const err = await extractArchiveSafely(file, 'tar.gz', path.join(data, 'worlds'), [
        data,
      ]).then(
        () => null,
        (e: unknown) => e,
      );
      expect((err as Error).message).toMatch(/resolves outside the allowed directories/);
      expect(fs.readdirSync(panel)).toEqual([]);
    },
  );
});

describe.skipIf(!HAS_TAR)('extractArchiveSafely (tar.gz)', () => {
  it('extracts into the destination, merging with existing worlds', async () => {
    const dest = path.join(work, 'data', 'worlds');
    fs.mkdirSync(path.join(dest, 'MyWorld'), { recursive: true });
    fs.writeFileSync(path.join(dest, 'MyWorld', 'config.json'), 'old');
    fs.writeFileSync(path.join(dest, 'MyWorld', 'keep.txt'), 'keep');
    const file = writeArchive(
      'world.tar.gz',
      buildTarGz([
        { name: 'MyWorld/', type: '5' },
        { name: 'MyWorld/config.json', data: 'new' },
        { name: 'MyWorld/resources/Time.json', data: '{}' },
      ]),
    );

    await extractArchiveSafely(file, 'tar.gz', dest);

    expect(fs.readFileSync(path.join(dest, 'MyWorld', 'config.json'), 'utf-8')).toBe('new');
    expect(fs.readFileSync(path.join(dest, 'MyWorld', 'keep.txt'), 'utf-8')).toBe('keep');
    expect(fs.existsSync(path.join(dest, 'MyWorld', 'resources', 'Time.json'))).toBe(true);
    // The staging directory is cleaned up.
    expect(fs.readdirSync(path.join(work, 'data'))).toEqual(['worlds']);
  });

  it.skipIf(!IS_GNU_TAR)('copes with folders whose archived mode lacks the x bit', async () => {
    const dest = path.join(work, 'data', 'worlds');
    const file = writeArchive(
      'modes.tar.gz',
      buildTarGz([
        { name: 'Locked/', type: '5', mode: 0o644 },
        { name: 'Locked/config.json', data: '{}' },
      ]),
    );
    await extractArchiveSafely(file, 'tar.gz', dest);
    expect(fs.readFileSync(path.join(dest, 'Locked', 'config.json'), 'utf-8')).toBe('{}');
    expect(fs.readdirSync(path.join(work, 'data'))).toEqual(['worlds']);
  });

  it('refuses a symlink archive without touching the destination', async () => {
    const dest = path.join(work, 'data', 'worlds');
    const file = writeArchive(
      'evil.tar.gz',
      buildTarGz([
        { name: 'Evil/', type: '5' },
        { name: 'Evil/escape', type: '2', linkname: '/' },
        { name: 'Evil/escape/tmp/pwned.txt', data: 'pwned' },
      ]),
    );
    await expectRejected(extractArchiveSafely(file, 'tar.gz', dest), /symbolic link/);
    expect(fs.existsSync(path.join(dest, 'Evil'))).toBe(false);
  });

  it('refuses an archive without any file', async () => {
    const dest = path.join(work, 'data', 'worlds');
    const file = writeArchive('empty.tar.gz', buildTarGz([{ name: 'Empty/', type: '5' }]));
    await expectRejected(extractArchiveSafely(file, 'tar.gz', dest), /does not contain any files/);
    expect(fs.existsSync(path.join(dest, 'Empty'))).toBe(false);
  });

  it('does not write through an existing symlinked world folder', async () => {
    const dest = path.join(work, 'data', 'worlds');
    const outside = path.join(work, 'outside');
    fs.mkdirSync(dest, { recursive: true });
    fs.mkdirSync(outside);
    fs.symlinkSync(outside, path.join(dest, 'MyWorld'));
    const file = writeArchive(
      'world.tar.gz',
      buildTarGz([{ name: 'MyWorld/config.json', data: 'x' }]),
    );
    await expectRejected(extractArchiveSafely(file, 'tar.gz', dest), /already exists/);
    expect(fs.readdirSync(outside)).toEqual([]);
  });
});

describe.skipIf(!HAS_UNZIP)('extractArchiveSafely (zip)', () => {
  it('extracts a clean zip', async () => {
    const dest = path.join(work, 'data', 'worlds');
    const file = writeArchive(
      'world.zip',
      buildZip([{ name: 'ZipWorld/' }, { name: 'ZipWorld/config.json', data: '{"Seed":2}' }]),
    );
    await extractArchiveSafely(file, 'zip', dest);
    expect(fs.readFileSync(path.join(dest, 'ZipWorld', 'config.json'), 'utf-8')).toBe('{"Seed":2}');
    expect(fs.readdirSync(path.join(work, 'data'))).toEqual(['worlds']);
  });

  it('refuses a zip with a symlink member', async () => {
    const dest = path.join(work, 'data', 'worlds');
    const file = writeArchive(
      'evil.zip',
      buildZip([{ name: 'ZipWorld/config.json', data: '/app/data/config.json', mode: 0o120777 }]),
    );
    await expectRejected(extractArchiveSafely(file, 'zip', dest), /symbolic link/);
    expect(fs.existsSync(path.join(dest, 'ZipWorld'))).toBe(false);
  });
});

// ------------------------------------------------------------
// Sizes and the extraction cap
// ------------------------------------------------------------

/** A one-member zip whose central directory declares `size` via the ZIP64 extra field. */
function buildZip64SizedZip(name: string, size: bigint): Buffer {
  const nameBuf = Buffer.from(name, 'utf8');
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(45, 4);
  local.writeUInt16LE(nameBuf.length, 26);
  const localRecord = Buffer.concat([local, nameBuf]);

  const extra = Buffer.alloc(4 + 8);
  extra.writeUInt16LE(0x0001, 0);
  extra.writeUInt16LE(8, 2);
  extra.writeBigUInt64LE(size, 4);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE((3 << 8) | 45, 4);
  central.writeUInt16LE(45, 6);
  central.writeUInt32LE(0, 20); // compressed size (fits in 32 bit)
  central.writeUInt32LE(0xffffffff, 24); // uncompressed size -> ZIP64 extra
  central.writeUInt16LE(nameBuf.length, 28);
  central.writeUInt16LE(extra.length, 30);
  central.writeUInt32LE((0o100644 << 16) >>> 0, 38);
  central.writeUInt32LE(0, 42);
  const cd = Buffer.concat([central, nameBuf, extra]);

  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(1, 8);
  eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(localRecord.length, 16);
  return Buffer.concat([localRecord, cd, eocd]);
}

describe('declared sizes and the size cap', () => {
  it('reports the size of every tar.gz and zip member', async () => {
    const tar = writeArchive(
      'sizes.tar.gz',
      buildTarGz([
        { name: 'World/', type: '5' },
        { name: 'World/a.bin', data: 'hello' },
        { name: 'World/b.bin', data: 'hello world' },
      ]),
    );
    expect((await listArchiveEntries(tar, 'tar.gz')).map((e) => e.size)).toEqual([0, 5, 11]);
    const zip = writeArchive(
      'sizes.zip',
      buildZip([{ name: 'World/' }, { name: 'World/a.bin', data: 'abc' }]),
    );
    expect((await listArchiveEntries(zip, 'zip')).map((e) => e.size)).toEqual([0, 3]);
  });

  it('reads the ZIP64 size of a member of 4 GiB and more', async () => {
    const file = writeArchive(
      'zip64.zip',
      buildZip64SizedZip('universe/big.bin', 5n * 1024n ** 3n),
    );
    const [entry] = await listArchiveEntries(file, 'zip');
    expect(entry.size).toBe(5 * 1024 ** 3);
    await expectRejected(
      inspectArchive(file, 'zip', { maxBytes: 4 * 1024 ** 3 }),
      /unpacks to at least 5\.0 GB, more than the allowed 4\.0 GB/,
    );
  });

  it('sums the declared size and refuses an archive above the cap', async () => {
    const file = writeArchive(
      'big.tar.gz',
      buildTarGz([
        { name: 'a.bin', data: 'x'.repeat(600) },
        { name: 'b.bin', data: 'x'.repeat(600) },
      ]),
    );
    expect(await inspectArchive(file, 'tar.gz')).toEqual({ files: 2, totalBytes: 1200 });
    expect(await inspectArchive(file, 'tar.gz', { maxBytes: 1200 })).toEqual({
      files: 2,
      totalBytes: 1200,
    });
    await expectRejected(
      inspectArchive(file, 'tar.gz', { maxBytes: 1199 }),
      /ARCHIVE_EXTRACT_MAX_GB/,
    );
  });

  it('refuses a PAX sparse member (its real size is hidden in GNU.sparse records)', async () => {
    const file = writeArchive(
      'sparse.tar.gz',
      buildTarGz([
        {
          name: 'GNUSparseFile.0/disk.img',
          data: 'x',
          pax: {
            'GNU.sparse.major': '1',
            'GNU.sparse.minor': '0',
            'GNU.sparse.realsize': '1099511627776',
          },
        },
      ]),
    );
    await expectRejected(assertSafeArchive(file, 'tar.gz'), /special file/);
  });

  it('refuses up front when the filesystem cannot hold the unpacked data', async () => {
    const err = await assertFreeSpace(work, Number.MAX_SAFE_INTEGER).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(ArchiveSpaceError);
    expect((err as Error).message).toMatch(/Not enough free disk space/);
    await expect(assertFreeSpace(work, 1)).resolves.toBeUndefined();
  });
});

describe.skipIf(!HAS_TAR)('extractToStaging', () => {
  it('unpacks into the staging dir and reports the real size', async () => {
    const file = writeArchive(
      'world.tar.gz',
      buildTarGz([
        { name: 'worlds/', type: '5' },
        { name: 'worlds/default/', type: '5' },
        { name: 'worlds/default/config.json', data: '{"Seed":1}' },
      ]),
    );
    const staging = path.join(work, 'stage');
    fs.mkdirSync(staging);
    const summary = await extractToStaging(file, 'tar.gz', staging, { maxBytes: 1024 });
    expect(summary).toEqual({ files: 1, totalBytes: 10 });
    expect(fs.readFileSync(path.join(staging, 'worlds/default/config.json'), 'utf8')).toBe(
      '{"Seed":1}',
    );
  });

  it('re-checks the cap on the unpacked tree (an archive that lied in its listing)', async () => {
    const file = writeArchive(
      'lie.tar.gz',
      buildTarGz([{ name: 'a.bin', data: 'x'.repeat(2000) }]),
    );
    const staging = path.join(work, 'stage');
    fs.mkdirSync(staging);
    // Pretend the listing declared less than the cap; the real tree is larger.
    await expectRejected(
      extractToStaging(file, 'tar.gz', staging, { maxBytes: 1000 }, { files: 1, totalBytes: 10 }),
      /unpacks to 2\.0 KB, more than the allowed 1000 B/,
    );
  });
});

describe('tar parser differentials', () => {
  it('refuses a member whose PAX size differs from its header size (BusyBox reads the header)', async () => {
    // The 1024 bytes after "decoy.txt" are data for a PAX-honouring reader but
    // a symlink header for BusyBox tar, which ignores the PAX size.
    const hidden = Buffer.concat([tarHeader('evil', '2', 0, '/tmp'), Buffer.alloc(512)]);
    const pax = paxData({ size: '1024' });
    const raw = Buffer.concat([
      tarHeader('PaxHeader', 'x', pax.length),
      padBlock(pax),
      tarHeader('decoy.txt', '0', 0),
      hidden,
      Buffer.alloc(1024),
    ]);
    const file = writeArchive('pax-size.tar.gz', gzipSync(raw));
    await expectRejected(assertSafeArchive(file, 'tar.gz'), /size of "decoy\.txt" is ambiguous/);
  });

  it('refuses GNU.sparse records in a global header', async () => {
    const file = writeArchive(
      'global-sparse.tar.gz',
      buildTarGz([{ name: 'a.bin', data: 'x', globalPax: { 'GNU.sparse.major': '1' } }]),
    );
    await expectRejected(assertSafeArchive(file, 'tar.gz'), /global tar header/);
  });

  it('refuses a base-256 size whose first byte is not the plain 0x80 marker', async () => {
    // BusyBox ignores the low bits of the first byte, GNU tar does not: with
    // 0x81 one of them reads 5 bytes of data, the other 2^88 + 5.
    for (const marker of [0x81, 0xbf, 0xc0]) {
      const header = tarHeader('a.txt', '0', 5, '', undefined, true);
      header[124] = marker;
      header.write('        ', 148, 'latin1');
      let sum = 0;
      for (const b of header) sum += b;
      header.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 'latin1');
      const raw = Buffer.concat([header, padBlock(Buffer.from('hello')), Buffer.alloc(1024)]);
      const file = writeArchive(`base256-${marker}.tar.gz`, gzipSync(raw));
      await expectRejected(assertSafeArchive(file, 'tar.gz'), /not a valid \.tar\.gz/);
    }
  });
});

describe('listing limits (names, entries, streaming)', () => {
  const files = (n: number, dir = 'w') =>
    Array.from({ length: n }, (_, i) => ({ name: `${dir}/f${i}.bin`, data: 'x' }));

  it('refuses more files and folders than ARCHIVE_MAX_ENTRIES (tar and zip)', async () => {
    // 1 folder + 10 files = 11 entries.
    const tar = writeArchive('many.tar.gz', buildTarGz([{ name: 'w/', type: '5' }, ...files(10)]));
    expect(await inspectArchive(tar, 'tar.gz', {}, { maxEntries: 11 })).toEqual({
      files: 10,
      totalBytes: 10,
    });
    await expectRejected(
      inspectArchive(tar, 'tar.gz', {}, { maxEntries: 10 }),
      /more than 10 files and folders \(ARCHIVE_MAX_ENTRIES\)/,
    );

    const zip = writeArchive('many.zip', buildZip(files(10).map((f) => ({ name: f.name }))));
    await expectRejected(inspectArchive(zip, 'zip', {}, { maxEntries: 9 }), /ARCHIVE_MAX_ENTRIES/);
    // 10 files plus the folder their paths imply.
    await expectRejected(inspectArchive(zip, 'zip', {}, { maxEntries: 10 }), /ARCHIVE_MAX_ENTRIES/);
    expect((await inspectArchive(zip, 'zip', {}, { maxEntries: 11 })).files).toBe(10);
  });

  it('counts the folders a member path implies, once per tree', async () => {
    // One file six levels deep creates five folders and the file.
    const deep = writeArchive('deep.tar.gz', buildTarGz([{ name: 'a/b/c/d/e/f.txt', data: 'x' }]));
    await expectRejected(inspectArchive(deep, 'tar.gz', {}, { maxEntries: 5 }), /more than 5/);
    expect((await inspectArchive(deep, 'tar.gz', {}, { maxEntries: 6 })).files).toBe(1);
    // Members in tree order share their folders.
    const tree = writeArchive(
      'tree.tar.gz',
      buildTarGz([
        { name: 'a/', type: '5' },
        { name: 'a/b/', type: '5' },
        { name: 'a/b/1.txt', data: '1' },
        { name: 'a/b/2.txt', data: '2' },
        { name: 'a/3.txt', data: '3' },
      ]),
    );
    expect((await inspectArchive(tree, 'tar.gz', {}, { maxEntries: 5 })).files).toBe(3);
  });

  it('reads ARCHIVE_MAX_ENTRIES per call and falls back to the default', () => {
    const before = process.env.ARCHIVE_MAX_ENTRIES;
    try {
      process.env.ARCHIVE_MAX_ENTRIES = '1234';
      expect(archiveMaxEntries()).toBe(1234);
      for (const bad of ['0', '-5', 'x', '1.5']) {
        process.env.ARCHIVE_MAX_ENTRIES = bad;
        expect(archiveMaxEntries()).toBe(500_000);
      }
    } finally {
      if (before === undefined) delete process.env.ARCHIVE_MAX_ENTRIES;
      else process.env.ARCHIVE_MAX_ENTRIES = before;
    }
  });

  it('accepts names up to 1024 bytes and refuses longer ones (PAX path, GNU long name, zip)', async () => {
    const atLimit = `${'d/'.repeat(500)}${'x'.repeat(ARCHIVE_NAME_MAX_BYTES - 1000)}`;
    expect(Buffer.byteLength(atLimit)).toBe(ARCHIVE_NAME_MAX_BYTES);
    const ok = writeArchive(
      'pax-1024.tar.gz',
      buildTarGz([{ name: 'short', data: 'x', pax: { path: atLimit } }]),
    );
    expect((await listArchiveEntries(ok, 'tar.gz')).map((e) => e.name)).toEqual([atLimit]);

    const tooLong = `${atLimit}y`;
    const pax = writeArchive(
      'pax-1025.tar.gz',
      buildTarGz([{ name: 'short', data: 'x', pax: { path: tooLong } }]),
    );
    await expectRejected(assertSafeArchive(pax, 'tar.gz'), /longer than 1024 bytes/);
    const gnu = writeArchive(
      'gnu-long.tar.gz',
      buildTarGz([{ name: 'short', data: 'x', longName: tooLong }]),
    );
    await expectRejected(assertSafeArchive(gnu, 'tar.gz'), /longer than 1024 bytes/);
    const zip = writeArchive('long.zip', buildZip([{ name: tooLong, data: 'x' }]));
    await expectRejected(assertSafeArchive(zip, 'zip'), /longer than 1024 bytes/);
  });

  it('refuses a PAX header larger than 64 KiB', async () => {
    const file = writeArchive(
      'pax-huge.tar.gz',
      buildTarGz([{ name: 'a.txt', data: 'x', pax: { comment: 'c'.repeat(70 * 1024) } }]),
    );
    await expectRejected(assertSafeArchive(file, 'tar.gz'), /extension header is too large/);
  });

  it('reads octal fields like BusyBox: leading spaces yes, digits after a NUL no', async () => {
    const withField = (field: string) => {
      const header = tarHeader('a.txt', '0', 0);
      header.write(field.padEnd(12, '\0'), 124, 'latin1');
      header.write('        ', 148, 'latin1');
      let sum = 0;
      for (const b of header) sum += b;
      header.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 'latin1');
      return gzipSync(Buffer.concat([header, padBlock(Buffer.from('hello')), Buffer.alloc(1024)]));
    };
    const spaced = writeArchive('size-spaces.tar.gz', withField('        5 '));
    expect((await listArchiveEntries(spaced, 'tar.gz'))[0].size).toBe(5);
    // BusyBox reads "\0\0\05" as an empty string, i.e. size 0, and would take
    // the next 512 bytes for a header this scan treats as data.
    const nulFirst = writeArchive('size-nul.tar.gz', withField('\x00\x00\x005'));
    await expectRejected(assertSafeArchive(nulFirst, 'tar.gz'), /not a valid \.tar\.gz/);
    const tab = writeArchive('size-tab.tar.gz', withField('\t5'));
    await expectRejected(assertSafeArchive(tab, 'tar.gz'), /not a valid \.tar\.gz/);
  });

  it('joins the prefix field like BusyBox, also for old GNU headers', async () => {
    const header = tarHeader('g.txt', '0', 1);
    header.write('ustar  \0', 257, 'latin1');
    header.write('pre', 345, 'latin1');
    header.write('        ', 148, 'latin1');
    let sum = 0;
    for (const b of header) sum += b;
    header.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 'latin1');
    const file = writeArchive(
      'gnu-prefix.tar.gz',
      gzipSync(Buffer.concat([header, padBlock(Buffer.from('g')), Buffer.alloc(1024)])),
    );
    const [entry] = await listArchiveEntries(file, 'tar.gz');
    expect(entry.name).toBe('pre/g.txt');
    expect(entry.aliases).toContain('g.txt');
  });

  it('takes the PAX path or GNU long name read last, like BusyBox', async () => {
    const pax = (fields: Record<string, string>) => {
      const data = paxData(fields);
      return [tarHeader('PaxHeader', 'x', data.length), padBlock(data)];
    };
    const long = (name: string) => {
      const data = Buffer.from(`${name}\0`, 'utf8');
      return [tarHeader('././@LongLink', 'L', data.length), padBlock(data)];
    };
    const member = [tarHeader('short', '0', 1), padBlock(Buffer.from('x'))];
    const end = [Buffer.alloc(1024)];
    const paxFirst = writeArchive(
      'pax-then-long.tar.gz',
      gzipSync(
        Buffer.concat([...pax({ path: 'a/pax.txt' }), ...long('b/long.txt'), ...member, ...end]),
      ),
    );
    const longFirst = writeArchive(
      'long-then-pax.tar.gz',
      gzipSync(
        Buffer.concat([...long('b/long.txt'), ...pax({ path: 'a/pax.txt' }), ...member, ...end]),
      ),
    );
    const [one] = await listArchiveEntries(paxFirst, 'tar.gz');
    expect(one.name).toBe('b/long.txt');
    expect(one.aliases).toContain('a/pax.txt');
    const [two] = await listArchiveEntries(longFirst, 'tar.gz');
    expect(two.name).toBe('a/pax.txt');
    expect(two.aliases).toContain('b/long.txt');
  });

  it('counts the folders of the longest reading of a name against the entry limit', async () => {
    const data = Buffer.from('d1/d2/d3/d4/d5/f.txt\0', 'utf8');
    const p = paxData({ path: 'a.txt' });
    const raw = Buffer.concat([
      tarHeader('././@LongLink', 'L', data.length),
      padBlock(data),
      tarHeader('PaxHeader', 'x', p.length),
      padBlock(p),
      tarHeader('short', '0', 1),
      padBlock(Buffer.from('x')),
      Buffer.alloc(1024),
    ]);
    const file = writeArchive('alias-depth.tar.gz', gzipSync(raw));
    // Listed as "a.txt" (read last), but the other reading creates five folders.
    await expectRejected(inspectArchive(file, 'tar.gz', {}, { maxEntries: 5 }), /more than 5/);
    expect((await inspectArchive(file, 'tar.gz', {}, { maxEntries: 6 })).files).toBe(1);
  });

  it('stops reading at the end-of-archive marker', async () => {
    // A broken gzip trailer far behind the end marker: only a reader that
    // decompresses past the marker runs into it.
    const tar = Buffer.concat([
      tarHeader('a.txt', '0', 1),
      padBlock(Buffer.from('a')),
      Buffer.alloc(1024),
      crypto.randomBytes(2 * 1024 * 1024),
    ]);
    const gz = gzipSync(tar);
    gz.writeUInt32LE((gz.readUInt32LE(gz.length - 8) ^ 0xffffffff) >>> 0, gz.length - 8);
    const file = writeArchive('after-end.tar.gz', gz);
    expect(await inspectArchive(file, 'tar.gz')).toEqual({ files: 1, totalBytes: 1 });
  });

  it('refuses a base-256 size beyond what can be counted exactly', async () => {
    const header = tarHeader('a.txt', '0', 0, '', undefined, true);
    header.fill(0xff, 125, 136); // 2^88 - 1 after the 0x80 marker
    header.write('        ', 148, 'latin1');
    let sum = 0;
    for (const b of header) sum += b;
    header.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 'latin1');
    const file = writeArchive(
      'base256-huge.tar.gz',
      gzipSync(Buffer.concat([header, Buffer.alloc(1024)])),
    );
    await expectRejected(assertSafeArchive(file, 'tar.gz'), /not a valid \.tar\.gz/);
  });

  it('stops reading at the first refused member instead of listing the rest', async () => {
    const members = [{ name: 'evil', type: '2', linkname: '/app/data' }, ...files(2000)];
    for (const [name, content, format] of [
      ['stop.tar.gz', buildTarGz(members), 'tar.gz'],
      [
        'stop.zip',
        buildZip([{ name: 'evil', mode: 0o120777 }, ...files(2000).map((f) => ({ name: f.name }))]),
        'zip',
      ],
    ] as const) {
      const file = writeArchive(name, content);
      let seen = 0;
      await expectRejected(
        scanArchiveEntries(file, format, (entry) => {
          seen++;
          if (entry.type === 'symlink') throw new ArchiveRejectedError('stop here');
        }),
        /stop here/,
      );
      expect(seen).toBe(1);
      await expectRejected(assertSafeArchive(file, format), /symbolic link/);
    }
  });

  it('reads a zip central directory larger than one read chunk', async () => {
    // ~8000 entries of ~200 bytes each: about 1.5 MB of central directory.
    const names = Array.from({ length: 8000 }, (_, i) => `universe/${'n'.repeat(140)}/${i}.bin`);
    const file = writeArchive('wide.zip', buildZip(names.map((name) => ({ name }))));
    const entries = await listArchiveEntries(file, 'zip');
    expect(entries.length).toBe(8000);
    expect(entries[0].name).toBe(names[0]);
    expect(entries[7999].name).toBe(names[7999]);
    expect((await inspectArchive(file, 'zip')).files).toBe(8000);
  });
});
