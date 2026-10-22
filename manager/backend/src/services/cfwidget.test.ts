/**
 * Regression tests for the CFWidget tracking path traversal: a tracked
 * filename becomes an unlink() target on update/uninstall, so it must never
 * be able to point outside the mods folder (e.g. at users.json or
 * setup-config.json in the data dir).
 *
 * No network is involved: filename validation happens before any CFWidget
 * lookup, and uninstall only touches the local tracking file.
 */
import fs from 'fs';
import path from 'path';
import os from 'os';
import { describe, it, beforeAll, afterAll, beforeEach, expect } from 'vitest';
import { config } from '../config.js';
import {
  resolveTrackedModFile,
  trackMod,
  getTrackedMods,
  uninstallTrackedMod,
  checkModUpdate,
  updateInstalledVersion,
  untrackMod,
} from './cfwidget.js';

let base: string;
let modsDir: string;
let dataDir: string;
let victim: string;
const saved = { modsPath: config.modsPath, dataPath: config.dataPath };

function trackedFile(): string {
  return path.join(dataDir, 'cfwidget-tracked.json');
}

function entry(filename: string, installed = true) {
  return {
    filename,
    curseforgeSlug: 'some-mod',
    hasUpdate: false,
    lastChecked: new Date(0).toISOString(),
    installed,
  };
}

beforeAll(() => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'kp-cfwidget-'));
  modsDir = path.join(base, 'mods');
  dataDir = path.join(base, 'data');
  fs.mkdirSync(modsDir);
  fs.mkdirSync(dataDir);
  victim = path.join(dataDir, 'users.json');
  config.modsPath = modsDir;
  config.dataPath = dataDir;
});

afterAll(() => {
  config.modsPath = saved.modsPath;
  config.dataPath = saved.dataPath;
  fs.rmSync(base, { recursive: true, force: true });
});

beforeEach(() => {
  fs.writeFileSync(victim, '{"users":[]}');
  fs.rmSync(trackedFile(), { force: true });
});

const TRAVERSAL_NAMES = [
  '../data/users.json',
  '../../app/data/users.json',
  '../data/evil.jar',
  '..\\data\\evil.jar',
  '..\\..\\setup-config.jar',
  'sub/Mod.jar',
  '/app/data/users.jar',
  'C:\\Windows\\Mod.jar',
];

describe('resolveTrackedModFile', () => {
  it('accepts plain .jar/.zip names (also disabled ones) inside the mods folder', () => {
    expect(resolveTrackedModFile('Mod-1.0.2.jar')).toBe(path.join(modsDir, 'Mod-1.0.2.jar'));
    expect(resolveTrackedModFile('Pack.zip')).toBe(path.join(modsDir, 'Pack.zip'));
    expect(resolveTrackedModFile('Mod.jar.disabled')).toBe(path.join(modsDir, 'Mod.jar.disabled'));
  });

  it('rejects traversal, absolute paths, backslash variants and foreign extensions', () => {
    for (const name of [...TRAVERSAL_NAMES, 'users.json', 'panel.sqlite', '..', '', 'evil\0.jar']) {
      expect(resolveTrackedModFile(name), JSON.stringify(name)).toBeNull();
    }
    expect(resolveTrackedModFile(undefined)).toBeNull();
    expect(resolveTrackedModFile({ filename: 'x.jar' })).toBeNull();
  });
});

describe('trackMod', () => {
  it('refuses traversal filenames before any lookup and stores nothing', async () => {
    for (const name of TRAVERSAL_NAMES) {
      const result = await trackMod(name, 'some-mod');
      expect(result.success, name).toBe(false);
      expect(result.error).toMatch(/Invalid mod filename/);
    }
    expect(fs.existsSync(trackedFile())).toBe(false);
  });
});

describe('stored tracking entries', () => {
  it('drops planted traversal entries when the tracking file is loaded', async () => {
    fs.writeFileSync(
      trackedFile(),
      JSON.stringify({
        mods: {
          '../data/users.json': entry('../data/users.json'),
          'Disguised.jar': entry('../data/users.json'), // valid key, hostile filename
          'Good.jar': entry('Good.jar'),
          '[wishlist]some-mod': entry('[wishlist]some-mod', false),
          '[wishlist]../x': entry('[wishlist]../x', false),
        },
        lastGlobalCheck: null,
      }),
    );
    const tracked = await getTrackedMods();
    expect(Object.keys(tracked.mods).sort()).toEqual(['Good.jar', '[wishlist]some-mod']);
  });

  it('never deletes outside the mods folder on uninstall', async () => {
    fs.writeFileSync(
      trackedFile(),
      JSON.stringify({
        mods: { '../data/users.json': entry('../data/users.json') },
        lastGlobalCheck: null,
      }),
    );
    const result = await uninstallTrackedMod('../data/users.json');
    expect(result.success).toBe(false);
    expect(fs.existsSync(victim)).toBe(true);
  });

  it('still uninstalls a valid tracked mod', async () => {
    fs.writeFileSync(path.join(modsDir, 'Good.jar'), 'jar');
    fs.writeFileSync(
      trackedFile(),
      JSON.stringify({
        mods: { 'Good.jar': entry('Good.jar') },
        lastGlobalCheck: null,
      }),
    );
    const result = await uninstallTrackedMod('Good.jar');
    expect(result.success).toBe(true);
    expect(fs.existsSync(path.join(modsDir, 'Good.jar'))).toBe(false);
    expect(fs.existsSync(victim)).toBe(true);
    expect(Object.keys((await getTrackedMods()).mods)).toEqual([]);
  });
});

describe('lookup keys from the route', () => {
  it('treats "__proto__" and friends as unknown mods instead of touching Object.prototype', async () => {
    fs.writeFileSync(
      trackedFile(),
      JSON.stringify({
        mods: { 'Good.jar': entry('Good.jar') },
        lastGlobalCheck: null,
      }),
    );
    expect(await checkModUpdate('__proto__')).toBeNull();
    expect(await updateInstalledVersion('__proto__', '9.9.9', 1)).toBe(false);
    expect(await untrackMod('constructor')).toBe(false);
    expect((await uninstallTrackedMod('__proto__')).success).toBe(false);
    const probe: Record<string, unknown> = {};
    expect(probe.installed).toBeUndefined();
    expect(probe.installedVersion).toBeUndefined();
    expect(Object.keys((await getTrackedMods()).mods)).toEqual(['Good.jar']);
  });
});
