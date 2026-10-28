/**
 * The one-time cleanup of keys older panels wrote into config.json and the
 * world configs, on a real temp folder: what changes, that a second run does
 * nothing, that unreadable files are skipped and missing ones not created,
 * and when it runs (server stopped, before a start through the panel).
 */
import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import path from 'path';
import os from 'os';
import fs from 'fs';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kp-config-migration-'));
const serverDir = path.join(root, 'server');
const worldsRoot = path.join(root, 'worlds');
process.env.MANAGER_DATA_PATH = path.join(root, 'manager');
delete process.env.DEMO_MODE;

const state = { running: false };
const hooks = new Map<string, (id: string) => Promise<void>>();
vi.mock('./serverLifecycle.js', () => ({
  registerBeforeStartHook: (name: string, hook: (id: string) => Promise<void>) =>
    hooks.set(name, hook),
  runWhileServerStopped: async (_id: unknown, _opts: unknown, fn: () => Promise<unknown>) =>
    state.running ? { ran: false } : { ran: true, value: await fn() },
}));
vi.mock('./servers.js', () => ({
  resolveServerId: async (id?: string) => id ?? 'default',
  getDefaultId: async () => 'default',
}));
vi.mock('./serverInstall.js', () => ({
  resolveInstallPaths: async () => ({ serverPath: serverDir, backupsPath: root }),
}));
vi.mock('./managementHelpers.js', () => ({ getWorldsPaths: () => [worldsRoot] }));

const {
  dismissMigrationNotes,
  installLegacyConfigHook,
  migrateLegacyConfigKeys,
  migrateLegacyConfigKeysAtStartup,
  readMigrationNotes,
} = await import('./serverConfigMigration.js');

const LEGACY_SERVER = {
  ServerName: 'S',
  Whitelist: true,
  AllowOp: false,
  ViewRadius: 12,
  Mods: { 'a:b': {} },
};
const LEGACY_WORLD = { Seed: 1, DaytimeDurationSecondsOverride: 600 };
const serverFile = path.join(serverDir, 'config.json');
const worldFile = (name: string) => path.join(worldsRoot, name, 'config.json');
const read = (file: string) => JSON.parse(fs.readFileSync(file, 'utf-8'));

function write(file: string, value: unknown) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value, null, 2));
}

beforeEach(async () => {
  for (const dir of [serverDir, worldsRoot]) fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(process.env.MANAGER_DATA_PATH!, { recursive: true });
  write(serverFile, LEGACY_SERVER);
  write(worldFile('default'), LEGACY_WORLD);
  state.running = false;
  await dismissMigrationNotes();
});

afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

describe('migrateLegacyConfigKeys', () => {
  it('cleans config.json and every world config, once', async () => {
    const notes = await migrateLegacyConfigKeys();
    expect(notes.map((n) => `${n.file}:${n.key}:${n.action}`)).toEqual([
      'config.json:Whitelist:removed',
      'config.json:AllowOp:removed',
      'config.json:ViewRadius:renamed',
      'worlds/default/config.json:DaytimeDurationSecondsOverride:renamed',
    ]);
    expect(read(serverFile)).toEqual({ ServerName: 'S', Mods: { 'a:b': {} }, MaxViewRadius: 12 });
    expect(read(worldFile('default'))).toEqual({ Seed: 1, DaytimeDurationSeconds: 600 });
    expect(read(`${serverFile}.bak`)).toEqual(LEGACY_SERVER);
    expect((await readMigrationNotes()).length).toBe(4);

    const mtime = fs.statSync(serverFile).mtimeMs;
    expect(await migrateLegacyConfigKeys()).toEqual([]);
    expect(fs.statSync(serverFile).mtimeMs).toBe(mtime);
    expect((await readMigrationNotes()).length).toBe(4);
  });

  it('skips a broken file and never creates a missing one', async () => {
    write(serverFile, '{ broken');
    fs.rmSync(worldFile('default'));
    write(worldFile('other'), LEGACY_WORLD);
    const notes = await migrateLegacyConfigKeys();
    expect(notes.map((n) => n.file)).toEqual(['worlds/other/config.json']);
    expect(fs.readFileSync(serverFile, 'utf-8')).toBe('{ broken');
    expect(fs.existsSync(worldFile('default'))).toBe(false);
  });

  it('only touches world folders of the default server', async () => {
    const notes = await migrateLegacyConfigKeys('second');
    expect(notes.every((n) => n.file === 'config.json')).toBe(true);
    expect(read(worldFile('default'))).toEqual(LEGACY_WORLD);
  });

  it('notes can be dismissed', async () => {
    await migrateLegacyConfigKeys();
    await dismissMigrationNotes();
    expect(await readMigrationNotes()).toEqual([]);
  });
});

describe('when it runs', () => {
  it('waits for the next start while the server runs', async () => {
    state.running = true;
    expect(await migrateLegacyConfigKeysAtStartup()).toEqual({ deferred: true, notes: [] });
    expect(read(serverFile)).toEqual(LEGACY_SERVER);
    installLegacyConfigHook();
    state.running = false;
    await hooks.get('legacy-config-keys')!('default');
    expect(read(serverFile)).not.toHaveProperty('Whitelist');
  });

  it('runs at panel start when the server is down', async () => {
    const r = await migrateLegacyConfigKeysAtStartup();
    expect(r.deferred).toBe(false);
    expect(r.notes.length).toBe(4);
  });
});
