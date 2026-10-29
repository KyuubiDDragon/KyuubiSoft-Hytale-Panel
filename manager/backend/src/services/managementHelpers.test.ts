/**
 * Tests for verifyUploadMagic — the content-vs-extension signature guard on
 * file-manager uploads — and findWorldFile, the symlink-safe world file lookup.
 */
import fs from 'fs';
import path from 'path';
import os from 'os';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { verifyUploadMagic, findWorldFile } from './managementHelpers.js';
import { config } from '../config.js';

const buf = (...bytes: number[]) => Buffer.from(bytes);

describe('verifyUploadMagic', () => {
  it('accepts genuine archives by magic bytes', () => {
    expect(verifyUploadMagic(buf(0x50, 0x4b, 0x03, 0x04, 0x00), 'pack.zip').ok).toBe(true);
    expect(verifyUploadMagic(buf(0x50, 0x4b, 0x03, 0x04), 'mod.jar').ok).toBe(true);
    expect(verifyUploadMagic(buf(0x1f, 0x8b, 0x08), 'world.gz').ok).toBe(true);
  });

  it('rejects a mislabeled archive (e.g. a script renamed to .zip)', () => {
    const r = verifyUploadMagic(Buffer.from('#!/bin/sh\necho pwned\n'), 'evil.zip');
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/does not match/i);
  });

  it('validates images by signature', () => {
    expect(verifyUploadMagic(buf(0x89, 0x50, 0x4e, 0x47), 'logo.png').ok).toBe(true);
    expect(verifyUploadMagic(buf(0x00, 0x01, 0x02, 0x03), 'logo.png').ok).toBe(false);
    expect(verifyUploadMagic(buf(0xff, 0xd8, 0xff, 0xe0), 'photo.jpg').ok).toBe(true);
  });

  it('lets unknown / text extensions through unchanged', () => {
    expect(verifyUploadMagic(Buffer.from('arbitrary bytes'), 'level.dat').ok).toBe(true);
    expect(verifyUploadMagic(Buffer.from('hello world'), 'notes.txt').ok).toBe(true);
    expect(verifyUploadMagic(Buffer.from('{"a":1}'), 'config.json').ok).toBe(true);
  });
});

// File symlinks need extra rights on Windows (skipped there); directory links
// use a junction, which works unprivileged ('junction' is ignored on POSIX).
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

describe('findWorldFile', () => {
  const CAN_LINK_FILES = canCreateLink('file');
  const CAN_LINK_DIRS = canCreateLink('junction');
  let base: string;
  let worlds: string;
  let outside: string;
  const saved = { dataPath: config.dataPath, serverPath: config.serverPath };

  beforeAll(() => {
    base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kp-worlds-')));
    worlds = path.join(base, 'data', 'worlds');
    outside = path.join(base, 'panel');
    fs.mkdirSync(path.join(worlds, 'Good', 'resources'), { recursive: true });
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(worlds, 'Good', 'config.json'), '{"Seed":1}');
    fs.writeFileSync(path.join(worlds, 'Good', 'resources', 'Time.json'), '{}');
    fs.writeFileSync(path.join(outside, 'config.json'), '{"jwtSecret":"do-not-leak"}');
    if (CAN_LINK_DIRS) fs.symlinkSync(outside, path.join(worlds, 'Evil'), 'junction');
    if (CAN_LINK_FILES) {
      fs.mkdirSync(path.join(worlds, 'Sneaky'));
      fs.symlinkSync(
        path.join(outside, 'config.json'),
        path.join(worlds, 'Sneaky', 'config.json'),
        'file',
      );
    }
    config.dataPath = path.join(base, 'data');
    config.serverPath = path.join(base, 'server'); // does not exist
  });

  afterAll(() => {
    config.dataPath = saved.dataPath;
    config.serverPath = saved.serverPath;
    fs.rmSync(base, { recursive: true, force: true });
  });

  it('finds regular world files', async () => {
    expect(await findWorldFile('Good', 'config.json')).toBe(
      path.join(worlds, 'Good', 'config.json'),
    );
    expect(await findWorldFile('Good', 'resources/Time.json')).toBe(
      path.join(worlds, 'Good', 'resources', 'Time.json'),
    );
    expect(await findWorldFile('Missing', 'config.json')).toBeNull();
  });

  it.skipIf(!CAN_LINK_DIRS)(
    'ignores a world folder that links out of the worlds root',
    async () => {
      expect(await findWorldFile('Evil', 'config.json')).toBeNull();
    },
  );

  it.skipIf(!CAN_LINK_FILES)('ignores a world config.json that links to a panel file', async () => {
    expect(await findWorldFile('Sneaky', 'config.json')).toBeNull();
  });
});
