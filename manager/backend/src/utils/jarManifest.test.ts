import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { promises as fsp } from 'fs';
import path from 'path';
import os from 'os';
import { deflateRawSync, crc32 } from 'zlib';
import { parseManifest, readJarManifest, readHytaleJarVersion } from './jarManifest.js';

interface Entry {
  name: string;
  data: string;
  deflate?: boolean;
}

/** Minimal zip writer (stored/deflated entries, optional ZIP64 EOCD) for tests. */
function buildZip(entries: Entry[], { zip64 = false } = {}): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    const raw = Buffer.from(e.data, 'utf8');
    const body = e.deflate ? deflateRawSync(raw) : raw;
    const name = Buffer.from(e.name, 'utf8');
    const lfh = Buffer.alloc(30);
    lfh.writeUInt32LE(0x04034b50, 0);
    lfh.writeUInt16LE(20, 4);
    lfh.writeUInt16LE(e.deflate ? 8 : 0, 8);
    lfh.writeUInt32LE(crc32(raw), 14);
    lfh.writeUInt32LE(body.length, 18);
    lfh.writeUInt32LE(raw.length, 22);
    lfh.writeUInt16LE(name.length, 26);
    locals.push(lfh, name, body);
    const cdh = Buffer.alloc(46);
    cdh.writeUInt32LE(0x02014b50, 0);
    cdh.writeUInt16LE(20, 4);
    cdh.writeUInt16LE(20, 6);
    cdh.writeUInt16LE(e.deflate ? 8 : 0, 10);
    cdh.writeUInt32LE(crc32(raw), 16);
    cdh.writeUInt32LE(body.length, 20);
    cdh.writeUInt32LE(raw.length, 24);
    cdh.writeUInt16LE(name.length, 28);
    cdh.writeUInt32LE(offset, 42);
    centrals.push(cdh, name);
    offset += lfh.length + name.length + body.length;
  }
  const cd = Buffer.concat(centrals);
  const parts = [...locals, cd];
  const cdOffset = offset;
  if (zip64) {
    const rec = Buffer.alloc(56);
    rec.writeUInt32LE(0x06064b50, 0);
    rec.writeBigUInt64LE(44n, 4);
    rec.writeBigUInt64LE(BigInt(entries.length), 24);
    rec.writeBigUInt64LE(BigInt(entries.length), 32);
    rec.writeBigUInt64LE(BigInt(cd.length), 40);
    rec.writeBigUInt64LE(BigInt(cdOffset), 48);
    const loc = Buffer.alloc(20);
    loc.writeUInt32LE(0x07064b50, 0);
    loc.writeBigUInt64LE(BigInt(cdOffset + cd.length), 8);
    loc.writeUInt32LE(1, 16);
    parts.push(rec, loc);
  }
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(zip64 ? 0xffff : entries.length, 8);
  eocd.writeUInt16LE(zip64 ? 0xffff : entries.length, 10);
  eocd.writeUInt32LE(zip64 ? 0xffffffff : cd.length, 12);
  eocd.writeUInt32LE(zip64 ? 0xffffffff : cdOffset, 16);
  parts.push(eocd);
  return Buffer.concat(parts);
}

const HYTALE_MANIFEST =
  'Manifest-Version: 1.0\r\n' +
  'Main-Class: com.hypixel.hytale.Main\r\n' +
  'Implementation-Patchline: release\r\n' +
  'Implementation-Vendor-Id: com.hypixel.hytale\r\n' +
  'Implementation-Version: 0.7.3\r\n\r\n';

let dir: string;

beforeAll(async () => {
  dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'jar-manifest-test-'));
});

afterAll(async () => {
  await fsp.rm(dir, { recursive: true, force: true });
});

async function writeJar(name: string, buf: Buffer): Promise<string> {
  const p = path.join(dir, name);
  await fsp.writeFile(p, buf);
  return p;
}

describe('parseManifest', () => {
  it('joins continuation lines and only reads the main section', () => {
    const m = parseManifest(
      'Manifest-Version: 1.0\nImplementation-Title: Very long\n  title\n\nName: a/b\nImplementation-Version: 9.9.9\n',
    );
    expect(m['Implementation-Title']).toBe('Very long title');
    // a per-entry section must not supply a main attribute
    expect(m['Implementation-Version']).toBeUndefined();
    expect(parseManifest('constructor: x\ntoString: y\n')).toEqual({
      constructor: 'x',
      toString: 'y',
    });
    const m2 = parseManifest(
      'Implementation-Version: 0.7.3\n\nName: x\nImplementation-Version: 1.0\n',
    );
    expect(m2['Implementation-Version']).toBe('0.7.3');
  });
});

describe('readJarManifest', () => {
  it('reads a deflated manifest that is not the first entry', async () => {
    const jar = await writeJar(
      'deflated.jar',
      buildZip([
        { name: 'com/hypixel/Foo.class', data: 'x'.repeat(100), deflate: true },
        { name: 'META-INF/MANIFEST.MF', data: HYTALE_MANIFEST, deflate: true },
      ]),
    );
    const m = await readJarManifest(jar);
    expect(m?.['Implementation-Version']).toBe('0.7.3');
    expect(m?.['Implementation-Patchline']).toBe('release');
  });

  it('finds a manifest listed after the first 64 KB of the central directory', async () => {
    const filler = Array.from({ length: 1500 }, (_, i) => ({
      name: `com/hypixel/hytale/some/deep/package/Class${String(i).padStart(5, '0')}.class`,
      data: 'c',
    }));
    const jar = await writeJar(
      'late.jar',
      buildZip([...filler, { name: 'META-INF/MANIFEST.MF', data: HYTALE_MANIFEST, deflate: true }]),
    );
    expect((await readJarManifest(jar))?.['Implementation-Version']).toBe('0.7.3');
  });

  it('reads a stored manifest from a ZIP64 archive', async () => {
    const jar = await writeJar(
      'zip64.jar',
      buildZip([{ name: 'META-INF/MANIFEST.MF', data: HYTALE_MANIFEST }], { zip64: true }),
    );
    expect((await readJarManifest(jar))?.['Implementation-Version']).toBe('0.7.3');
  });

  it('returns null for missing files, non-zips and jars without a manifest', async () => {
    expect(await readJarManifest(path.join(dir, 'missing.jar'))).toBeNull();
    expect(
      await readJarManifest(await writeJar('garbage.jar', Buffer.from('not a zip'))),
    ).toBeNull();
    const noManifest = await writeJar('empty.jar', buildZip([{ name: 'a.txt', data: 'hi' }]));
    expect(await readJarManifest(noManifest)).toBeNull();
  });
});

describe('readHytaleJarVersion', () => {
  it('returns version and patchline for a Hytale server jar', async () => {
    const jar = await writeJar(
      'server.jar',
      buildZip([{ name: 'META-INF/MANIFEST.MF', data: HYTALE_MANIFEST, deflate: true }]),
    );
    expect(await readHytaleJarVersion(jar)).toEqual({ version: '0.7.3', patchline: 'release' });
  });

  // The JARs lie in folders the game server can write to. (Symlinks need
  // extra rights on Windows; O_NOFOLLOW is POSIX only.)
  it.skipIf(process.platform === 'win32')(
    'does not follow a symlink or read a directory',
    async () => {
      const jar = await writeJar(
        'real.jar',
        buildZip([{ name: 'META-INF/MANIFEST.MF', data: HYTALE_MANIFEST }]),
      );
      await fsp.symlink(jar, path.join(dir, 'link.jar'));
      await fsp.mkdir(path.join(dir, 'folder.jar'));
      expect(await readHytaleJarVersion(path.join(dir, 'link.jar'))).toBeNull();
      expect(await readHytaleJarVersion(path.join(dir, 'folder.jar'))).toBeNull();
    },
  );

  it('ignores jars from other vendors, like the server does for staged updates', async () => {
    const jar = await writeJar(
      'other.jar',
      buildZip([
        {
          name: 'META-INF/MANIFEST.MF',
          data: 'Implementation-Vendor-Id: org.example\nImplementation-Version: 1.2.3\n',
        },
      ]),
    );
    expect(await readHytaleJarVersion(jar)).toBeNull();
  });
});
