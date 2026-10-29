import { describe, it, expect, vi, afterAll } from 'vitest';
import path from 'path';
import os from 'os';
import fs from 'fs';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kp-world-settings-'));
const first = path.join(root, 'a');
const second = path.join(root, 'b');
vi.mock('./managementHelpers.js', () => ({ getWorldsPaths: () => [first, second] }));
vi.mock('./pluginCommands.js', () => ({ runCommandViaPlugin: vi.fn() }));

const { isValidWorldName, locateWorldFile, worldJsonPath, applyLiveWorldSettings } =
  await import('./worldSettings.js');
const { UnsafeFileError } = await import('../utils/noFollowFs.js');

afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

describe('names and paths', () => {
  it('accepts world folder names only', () => {
    for (const ok of ['default', 'flat_world', 'My World', 'w-1'])
      expect(isValidWorldName(ok)).toBe(true);
    for (const bad of ['', '.', '..', 'a/b', 'a\\b', '..x', 'a\nb', 'x'.repeat(129), 7]) {
      expect(isValidWorldName(bad), String(bad)).toBe(false);
    }
  });

  it('allows the JSON files of the world folder and resources/ only', () => {
    expect(worldJsonPath('config.json')).toBe('config.json');
    expect(worldJsonPath('resources/Time.json')).toBe('resources/Time.json');
    for (const bad of [
      'chunks/x.json',
      'resources/a/b.json',
      '../x.json',
      'a.txt',
      'resources//x.json',
      '/x.json',
    ]) {
      expect(worldJsonPath(bad), bad).toBeNull();
    }
  });
});

describe('locateWorldFile', () => {
  it('takes the first root that has the file', async () => {
    fs.mkdirSync(path.join(second, 'w'), { recursive: true });
    fs.writeFileSync(path.join(second, 'w', 'config.json'), '{"a":1}');
    const found = await locateWorldFile('w', 'config.json');
    expect(found).toMatchObject({ root: second, content: '{"a":1}' });
    expect(await locateWorldFile('missing', 'config.json')).toBeNull();
  });

  it.skipIf(process.platform === 'win32')('refuses a world file that is a link', async () => {
    const secret = path.join(root, 'secret.json');
    fs.writeFileSync(secret, '{"jwtSecret":"x"}');
    fs.mkdirSync(path.join(first, 'linked'), { recursive: true });
    fs.symlinkSync(secret, path.join(first, 'linked', 'config.json'));
    await expect(locateWorldFile('linked', 'config.json')).rejects.toBeInstanceOf(UnsafeFileError);
  });
});

describe('applyLiveWorldSettings', () => {
  it('does not build a command for a world name that would need quoting', async () => {
    expect(
      await applyLiveWorldSettings('My World', { IsPvpEnabled: true }, undefined, undefined),
    ).toEqual({
      kind: 'unavailable',
      reason: 'the world name cannot be used in a command',
    });
  });
});
