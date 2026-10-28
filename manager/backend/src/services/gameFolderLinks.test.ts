/**
 * Links in the folders of an additional server. The game image links
 * `server/universe` to `/opt/hytale/data`: inside the server's own container
 * that is its data, in the manager it is the primary server's. And whoever
 * runs code on a server can plant more links there. The panel must neither
 * read nor write another server's files (or its own data) through them.
 */
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { EventEmitter } from 'events';
import fs from 'fs';
import os from 'os';
import path from 'path';

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kp-game-links-')));
const managerDir = path.join(root, 'manager');
const panelDir = path.join(root, 'panel-data');
const aRoot = path.join(root, 'a');
const instances = path.join(root, 'instances');
const bRoot = path.join(instances, 'b1');
const a = (sub: string) => path.join(aRoot, sub);
const b = (sub: string) => path.join(bRoot, sub);

process.env.MANAGER_DATA_PATH = managerDir;
process.env.INSTANCES_PATH = instances;
process.env.SERVER_PATH = a('server');
process.env.DATA_PATH = a('data');
process.env.MODS_PATH = a('mods');
process.env.PLUGINS_PATH = a('plugins');
process.env.BACKUPS_PATH = a('backups');
process.env.ASSETS_PATH = a('assets');
process.env.CURSEFORGE_API_KEY = 'test-key';

const SECRET = 'TOP-SECRET-JWT';
const MOD_ID = 4242;
const PAYLOAD = 'JAR-FROM-THE-STORE';

// CurseForge API and CDN: the mod's details, then the file itself.
vi.mock('https', () => {
  const respond = (cb: (res: EventEmitter) => void, body: string) => {
    const res = Object.assign(new EventEmitter(), {
      statusCode: 200,
      headers: {},
      resume: () => undefined,
    });
    setImmediate(() => {
      cb(res);
      res.emit('data', Buffer.from(body));
      res.emit('end');
    });
    const req = Object.assign(new EventEmitter(), { write: () => true, end: () => undefined });
    return req;
  };
  const details = JSON.stringify({
    data: {
      id: 4242,
      name: 'Evil',
      allowModDistribution: true,
      latestFiles: [
        {
          id: 77,
          fileName: 'Evil.jar',
          displayName: '1.0',
          releaseType: 1,
          downloadUrl: 'https://edge.forgecdn.net/files/Evil.jar',
          gameVersions: [],
        },
      ],
    },
  });
  const request = (_opts: unknown, cb: (res: EventEmitter) => void) => respond(cb, details);
  const get = (_opts: unknown, cb: (res: EventEmitter) => void) =>
    respond(cb, 'JAR-FROM-THE-STORE');
  return { default: { request, get }, request, get };
});
// The plugin is not reachable: the online list comes from the panel's own tracking.
vi.mock('./kyuubiApi.js', () => ({ isPluginRunning: async () => false }));
vi.mock('./playerPresence.js', () => ({ isWatching: () => false, onlinePlayers: () => [] }));

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
const CAN_LINK_FILES = canCreateLink('file');
const CAN_LINK_DIRS = canCreateLink('junction');

const write = (file: string, content: string) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
};
const isLink = (file: string) => fs.lstatSync(file).isSymbolicLink();

const ALICE = '0a1b2c3d-0000-4000-8000-0000000000a1';
const BOB = '0a1b2c3d-0000-4000-8000-0000000000b0';
const playerSave = (name: string) => JSON.stringify({ Components: { Nameplate: { Text: name } } });

beforeAll(() => {
  for (const dir of ['server', 'data', 'backups', 'mods', 'plugins', 'assets', 'auth']) {
    fs.mkdirSync(a(dir), { recursive: true });
    fs.mkdirSync(b(dir), { recursive: true });
  }
  fs.mkdirSync(panelDir, { recursive: true });
  fs.mkdirSync(managerDir, { recursive: true });
  // The primary server: a world and a player of its own.
  write(a('data/worlds/arena/config.json'), '{"Seed":"A-secret"}');
  write(a('data/players/' + `${ALICE}.json`), playerSave('Alice'));
  write(a('mods/Evil.jar'), 'A-ORIGINAL');
  // Server B: its own world and player in its data folder.
  write(b('data/worlds/own/config.json'), '{"Seed":"B"}');
  write(b('data/players/' + `${BOB}.json`), playerSave('Bobby'));
  // The panel's own data.
  write(path.join(panelDir, 'config.json'), JSON.stringify({ jwtSecret: SECRET }));
  write(
    path.join(panelDir, 'users.json'),
    JSON.stringify([{ name: 'Mallory', uuid: ALICE, online: false }]),
  );
  write(
    path.join(panelDir, 'list.json'),
    JSON.stringify({ mods: { '999': { modId: 999, filename: 'leaked.jar' } } }),
  );

  if (CAN_LINK_DIRS) {
    // The primary server's universe link leads into its own data folder.
    fs.symlinkSync(a('data'), a('server/universe'), 'junction');
    // What the game image creates in B's server folder, as the manager sees it.
    fs.symlinkSync(a('data'), b('server/universe'), 'junction');
    fs.symlinkSync(a('plugins'), b('server/plugins'), 'junction');
  }

  const network = (port: number) => ({
    serverPort: port,
    webMapPort: port + 100,
    webMapWsPort: port + 101,
  });
  const registry = {
    schemaVersion: 2,
    defaultId: 'default',
    servers: [
      {
        id: 'default',
        name: 'Primary',
        containerName: 'hytale',
        status: 'ready',
        network: network(5520),
        paths: {
          server: a('server'),
          data: a('data'),
          backups: a('backups'),
          mods: a('mods'),
          plugins: a('plugins'),
          assets: a('assets'),
          auth: a('auth'),
        },
        createdAt: new Date().toISOString(),
        createdBy: 'system',
      },
      {
        id: 'b1',
        name: 'Server B',
        containerName: 'hytale-srv-b1',
        status: 'ready',
        network: network(5521),
        paths: {
          server: b('server'),
          data: b('data'),
          backups: b('backups'),
          mods: b('mods'),
          plugins: b('plugins'),
          assets: b('assets'),
          auth: b('auth'),
        },
        hostRoot: '/srv/hytale/instances/b1',
        createdAt: new Date().toISOString(),
        createdBy: 'admin',
      },
    ],
  };
  write(path.join(managerDir, 'servers.json'), JSON.stringify(registry));
});

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe.skipIf(!CAN_LINK_DIRS)('the universe link of an additional server', () => {
  it("leaves the primary server's worlds out of B's world roots", async () => {
    const { getServerContext, worldRoots } = await import('./serverContext.js');
    const ctxB = await getServerContext('b1');
    expect(worldRoots(ctxB)).toEqual([b('data/worlds'), b('server/worlds')]);
    // The primary server itself still uses its universe link.
    const ctxA = await getServerContext('default');
    expect(worldRoots(ctxA)).toContain(path.join(a('server'), 'universe', 'worlds'));
  });

  it("finds B's world configs only in B, never A's world of another name", async () => {
    const { locateWorldFile } = await import('./worldSettings.js');
    expect(await locateWorldFile('arena', 'config.json', 'b1')).toBeNull();
    expect((await locateWorldFile('own', 'config.json', 'b1'))?.content).toBe('{"Seed":"B"}');
  });

  it("reads B's saved players from its data folder, not A's", async () => {
    const { getAllPlayerFiles } = await import('./players.js');
    expect(await getAllPlayerFiles('b1')).toEqual([{ uuid: BOB, name: 'Bobby' }]);
  });

  it('does not take a server folder that is a link out of it as a config folder', async () => {
    const { getServerContext, isInsideServerFolders } = await import('./serverContext.js');
    const ctxB = await getServerContext('b1');
    expect(isInsideServerFolders(ctxB, b('server/plugins'))).toBe(false);
    expect(isInsideServerFolders(ctxB, b('plugins'))).toBe(true);
  });

  it('ignores a worlds folder B replaced by a link to A', async () => {
    const { getServerContext, worldRoots } = await import('./serverContext.js');
    fs.symlinkSync(a('data/worlds'), b('server/worlds'), 'junction');
    try {
      expect(worldRoots(await getServerContext('b1'))).toEqual([b('data/worlds')]);
    } finally {
      fs.unlinkSync(b('server/worlds'));
    }
  });
});

describe.skipIf(!CAN_LINK_FILES)('files the panel writes into game folders', () => {
  it('replaces a link at a store download instead of writing through it to A', async () => {
    const { installModFromCurseForge } = await import('./curseforge.js');
    const { getServerContext } = await import('./serverContext.js');
    fs.symlinkSync(a('mods/Evil.jar'), b('mods/Evil.jar'), 'file');

    const result = await installModFromCurseForge(await getServerContext('b1'), MOD_ID);

    expect(result.success).toBe(true);
    expect(fs.readFileSync(a('mods/Evil.jar'), 'utf-8')).toBe('A-ORIGINAL');
    expect(isLink(b('mods/Evil.jar'))).toBe(false);
    expect(fs.readFileSync(b('mods/Evil.jar'), 'utf-8')).toBe(PAYLOAD);
  });

  it('neither reads nor writes an install list that is a link', async () => {
    const { getInstalledCurseForgeInfo, untrackInstalledMod } = await import('./curseforge.js');
    const { getServerContext } = await import('./serverContext.js');
    const ctxB = await getServerContext('b1');
    const list = b('data/curseforge-installed.json');
    fs.rmSync(list, { force: true });
    fs.symlinkSync(path.join(panelDir, 'list.json'), list, 'file');
    const before = fs.readFileSync(path.join(panelDir, 'list.json'), 'utf-8');

    expect(await getInstalledCurseForgeInfo(ctxB)).toEqual({});
    await untrackInstalledMod(ctxB, 999);

    expect(fs.readFileSync(path.join(panelDir, 'list.json'), 'utf-8')).toBe(before);
  });

  it('does not load or save players.json through a link', async () => {
    const players = await import('./players.js');
    fs.symlinkSync(path.join(panelDir, 'users.json'), b('server/players.json'), 'file');
    const before = fs.readFileSync(path.join(panelDir, 'users.json'), 'utf-8');

    players.notePlayerOnline('b1', 'Bobby', { uuid: BOB });
    expect((await players.getAllPlayers('b1')).map((p) => p.name)).not.toContain('Mallory');
    // Longer than the save debounce.
    await new Promise((resolve) => setTimeout(resolve, 1300));

    expect(fs.readFileSync(path.join(panelDir, 'users.json'), 'utf-8')).toBe(before);
    expect(isLink(b('server/players.json'))).toBe(true);
  });

  it('keeps panel secrets out of a scheduler config that is a link', async () => {
    const { loadConfig, saveConfig } = await import('./scheduler.js');
    const file = b('data/manager-config.json');
    fs.symlinkSync(path.join(panelDir, 'config.json'), file, 'file');
    const before = fs.readFileSync(path.join(panelDir, 'config.json'), 'utf-8');

    const loaded = await loadConfig('b1');
    expect(JSON.stringify(loaded)).not.toContain(SECRET);
    expect(await saveConfig({ backups: { ...loaded.backups, enabled: false } }, 'b1')).toBe(true);

    expect(fs.readFileSync(path.join(panelDir, 'config.json'), 'utf-8')).toBe(before);
    expect(isLink(file)).toBe(false);
    expect(fs.readFileSync(file, 'utf-8')).not.toContain(SECRET);
  });
});
