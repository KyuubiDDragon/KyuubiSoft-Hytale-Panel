/**
 * servers.json v2: migration from v1, the refusal to overwrite a damaged
 * file, the compose server following the env config, patch semantics and
 * the default server while multiserver is off. Every case loads a fresh
 * registry module against its own temp dir.
 */
import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kp-registry-'));
let dataDir: string;

type Registry = typeof import('./servers.js');

function entry(id: string, over: Record<string, unknown> = {}) {
  const base = id === 'default' ? '/opt/hytale' : `/opt/hytale-instances/${id}`;
  return {
    id,
    name: id === 'default' ? 'Primary Server' : `Server ${id}`,
    containerName: id === 'default' ? 'stale-name' : `hytale-srv-${id}`,
    status: 'ready',
    network: { serverPort: 5520, webMapPort: 18081, webMapWsPort: 18082, pluginPort: 18085 },
    paths: {
      server: `${base}/server`,
      data: `${base}/data`,
      backups: `${base}/backups`,
      mods: `${base}/mods`,
      plugins: `${base}/plugins`,
      assets: `${base}/assets`,
      auth: `${base}/auth`,
    },
    createdAt: '2026-10-01T00:00:00.000Z',
    createdBy: 'system',
    ...over,
  };
}

const v1File = () => ({
  schemaVersion: 1,
  defaultId: 'default',
  servers: [
    entry('default'),
    entry('a1b2c3d4', { network: { ...entry('x').network, serverPort: 5521 } }),
  ],
});

const file = () => path.join(dataDir, 'servers.json');
const writeRaw = (raw: string) => fs.writeFileSync(file(), raw);
const readJson = () => JSON.parse(fs.readFileSync(file(), 'utf-8'));
const corruptCopies = () =>
  fs.readdirSync(dataDir).filter((n) => n.startsWith('servers.json.corrupt-'));

// Other test files of the same worker may have set these.
const CASE_ENV = ['MULTISERVER_ENABLED', 'SERVER_PATH', 'SERVER_PORT', 'INSTANCES_PATH'] as const;

async function loadRegistry(env: Record<string, string> = {}): Promise<Registry> {
  vi.resetModules();
  process.env.MANAGER_DATA_PATH = dataDir;
  process.env.GAME_CONTAINER_NAME = 'kptest-compose';
  process.env.HOST_DATA_PATH = '/srv/hytale';
  for (const key of CASE_ENV) delete process.env[key];
  Object.assign(process.env, env);
  return import('./servers.js');
}

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(root, 'case-'));
});

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('servers.json migration v1 → v2', () => {
  it('drops the plugin port, records the instance host root and keeps the v1 file', async () => {
    writeRaw(JSON.stringify(v1File()));
    const registry = await loadRegistry();

    const loaded = await registry.ensureLoaded();
    expect(loaded.schemaVersion).toBe(2);
    const onDisk = readJson();
    expect(onDisk.schemaVersion).toBe(2);
    for (const s of onDisk.servers) expect(s.network).not.toHaveProperty('pluginPort');
    const extra = onDisk.servers.find((s: { id: string }) => s.id === 'a1b2c3d4');
    expect(extra.hostRoot).toBe('/srv/hytale/instances/a1b2c3d4');
    expect(extra.network.serverPort).toBe(5521);
    expect(onDisk.servers.find((s: { id: string }) => s.id === 'default')).not.toHaveProperty(
      'hostRoot',
    );
    expect(JSON.parse(fs.readFileSync(`${file()}.v1.bak`, 'utf-8'))).toEqual(v1File());
  });

  it('is idempotent: a migrated file loads unchanged and the v1 copy stays the first one', async () => {
    writeRaw(JSON.stringify(v1File()));
    await (await loadRegistry()).ensureLoaded();
    const migrated = fs.readFileSync(file(), 'utf-8');
    const backup = fs.readFileSync(`${file()}.v1.bak`, 'utf-8');

    await (await loadRegistry()).ensureLoaded();
    expect(fs.readFileSync(file(), 'utf-8')).toBe(migrated);
    expect(fs.readFileSync(`${file()}.v1.bak`, 'utf-8')).toBe(backup);
  });

  it('keeps a second v1 file next to an older copy instead of dropping it', async () => {
    fs.writeFileSync(`${file()}.v1.bak`, '{"older": true}');
    writeRaw(JSON.stringify(v1File()));
    await (await loadRegistry()).ensureLoaded();
    expect(fs.readFileSync(`${file()}.v1.bak`, 'utf-8')).toBe('{"older": true}');
    const dated = fs.readdirSync(dataDir).filter((n) => /^servers\.json\.v1-.+\.bak$/.test(n));
    expect(dated).toHaveLength(1);
    expect(JSON.parse(fs.readFileSync(path.join(dataDir, dated[0]), 'utf-8'))).toEqual(v1File());
  });

  it('leaves an instance with custom paths without a guessed host root', async () => {
    const custom = entry('cafe0001', {
      paths: { ...entry('cafe0001').paths, server: '/elsewhere/server' },
    });
    writeRaw(JSON.stringify({ ...v1File(), servers: [entry('default'), custom] }));
    const registry = await loadRegistry();
    expect((await registry.getServer('cafe0001'))?.hostRoot).toBeUndefined();
  });
});

describe('a damaged servers.json', () => {
  const cases: Array<[string, string]> = [
    ['broken JSON', '{"schemaVersion": 2, "defaultId": '],
    ['an empty file', ''],
    [
      'a schema error',
      JSON.stringify({ schemaVersion: 2, defaultId: 'default', servers: [{ id: 'default' }] }),
    ],
    [
      'a default that is not registered',
      JSON.stringify({ ...v1File(), schemaVersion: 2, defaultId: 'gone' }),
    ],
    [
      'duplicate ids',
      JSON.stringify({ ...v1File(), servers: [entry('default'), entry('default')] }),
    ],
    [
      'an id that could leave its folder',
      JSON.stringify({ ...v1File(), servers: [entry('default'), entry('../x')] }),
    ],
    ['an unknown schema version', JSON.stringify({ ...v1File(), schemaVersion: 3 })],
  ];

  it.each(cases)(
    'with %s stops the load, keeps the file and makes one copy',
    async (_name, raw) => {
      writeRaw(raw);
      const registry = await loadRegistry();

      const err = await registry.ensureLoaded().catch((e: unknown) => e);
      expect(err).toBeInstanceOf(registry.ServerRegistryError);
      expect((err as Error).message).toMatch(/did not overwrite it/);
      expect(fs.readFileSync(file(), 'utf-8')).toBe(raw);
      expect(corruptCopies()).toHaveLength(1);
      expect(fs.readFileSync(path.join(dataDir, corruptCopies()[0]), 'utf-8')).toBe(raw);

      // Every later call reports the same failure without another copy, and
      // nothing writes over the file (no fresh registry in its place).
      await expect(registry.listServers()).rejects.toBe(err);
      await expect(registry.setDefaultId('default')).rejects.toBe(err);
      expect(fs.readFileSync(file(), 'utf-8')).toBe(raw);
      expect(corruptCopies()).toHaveLength(1);
    },
  );

  it('reuses the copy of the same damage across restarts', async () => {
    writeRaw('{ nope');
    await (await loadRegistry()).ensureLoaded().catch(() => undefined);
    await (await loadRegistry()).ensureLoaded().catch(() => undefined);
    expect(corruptCopies()).toHaveLength(1);
  });

  it('creates a fresh registry only when the file does not exist', async () => {
    const registry = await loadRegistry();
    const loaded = await registry.ensureLoaded();
    expect(loaded).toMatchObject({ schemaVersion: 2, defaultId: 'default' });
    expect(readJson().servers.map((s: { id: string }) => s.id)).toEqual(['default']);
  });
});

describe('registry contents', () => {
  it('takes the compose server container, ports and folders from the env config', async () => {
    writeRaw(JSON.stringify(v1File()));
    const registry = await loadRegistry({ SERVER_PATH: '/env/server', SERVER_PORT: '5600' });
    const compose = (await registry.getServer('default'))!;
    expect(compose.containerName).toBe('kptest-compose');
    expect(compose.paths.server).toBe('/env/server');
    expect(compose.network.serverPort).toBe(5600);
    // Additional servers keep their own registry values.
    expect((await registry.getServer('a1b2c3d4'))?.containerName).toBe('hytale-srv-a1b2c3d4');
  });

  it('patches only the given fields and validates the result', async () => {
    writeRaw(JSON.stringify(v1File()));
    const registry = await loadRegistry();
    const updated = await registry.updateServerInstance('a1b2c3d4', {
      name: 'Renamed',
      status: undefined,
    });
    expect(updated).toMatchObject({ name: 'Renamed', status: 'ready' });
    expect(readJson().servers.find((s: { id: string }) => s.id === 'a1b2c3d4').name).toBe(
      'Renamed',
    );
    await expect(registry.updateServerInstance('a1b2c3d4', { name: '' })).rejects.toThrow();
    expect(await registry.updateServerInstance('nope', { name: 'x' })).toBeNull();
  });

  it('refuses an unknown default and runs the delete hooks after a delete', async () => {
    writeRaw(JSON.stringify(v1File()));
    const registry = await loadRegistry();
    await expect(registry.setDefaultId('nope')).rejects.toThrow('Unknown server id');
    const deleted: string[] = [];
    registry.onServerDeleted((id) => {
      deleted.push(id);
    });
    expect(await registry.deleteServerInstance('default')).toBe(false);
    expect(await registry.deleteServerInstance('a1b2c3d4')).toBe(true);
    expect(deleted).toEqual(['a1b2c3d4']);
    expect(readJson().servers.map((s: { id: string }) => s.id)).toEqual(['default']);
  });

  it('does not hand out an explicitly requested port again', async () => {
    writeRaw(JSON.stringify(v1File()));
    const registry = await loadRegistry();
    const created = await registry.createServerInstance({
      name: 'Ports',
      webMapPort: 18082,
      createdBy: 't',
    });
    expect(created.network.webMapPort).toBe(18082);
    expect(created.network.webMapWsPort).not.toBe(18082);
  });

  it('serialises concurrent writes without losing one', async () => {
    writeRaw(JSON.stringify(v1File()));
    const registry = await loadRegistry();
    const created = await Promise.all(
      ['one', 'two', 'three'].map((name) =>
        registry.createServerInstance({ name, createdBy: 't' }),
      ),
    );
    const ids = readJson().servers.map((s: { id: string }) => s.id);
    for (const c of created) expect(ids).toContain(c.id);
    expect(new Set(created.map((c) => c.network.serverPort)).size).toBe(3);
  });

  it('creates an instance without plugin port, with its host root, and without running the add hooks', async () => {
    writeRaw(JSON.stringify(v1File()));
    const registry = await loadRegistry();
    const added: string[] = [];
    registry.onServerAdded((s) => {
      added.push(s.id);
    });
    const created = await registry.createServerInstance({ name: 'New', createdBy: 't' });
    expect(created.network).not.toHaveProperty('pluginPort');
    expect(created.hostRoot).toBe(`/srv/hytale/instances/${created.id}`);
    expect(created.paths.server).toBe(`/opt/hytale-instances/${created.id}/server`);
    expect(added).toEqual([]);
    await registry.notifyServerAdded(created.id);
    expect(added).toEqual([created.id]);
  });
});

describe('default server', () => {
  const pointedAway = () => ({ ...v1File(), schemaVersion: 2, defaultId: 'a1b2c3d4' });

  it('stays the compose server while multiserver is off, whatever the file points at', async () => {
    writeRaw(JSON.stringify(pointedAway()));
    const registry = await loadRegistry();
    expect(await registry.getDefaultId()).toBe('default');
    expect(registry.getDefaultIdSync()).toBe('default');
    expect(await registry.resolveServerId()).toBe('default');
    expect(await registry.resolveServerId(null)).toBe('default');
    // The stored pointer is kept for when multiserver is turned on.
    expect(readJson().defaultId).toBe('a1b2c3d4');
    expect(await registry.getDeleteBlockReason('a1b2c3d4')).toBe('default');
  });

  it('follows the stored pointer with multiserver on', async () => {
    writeRaw(JSON.stringify(pointedAway()));
    const registry = await loadRegistry({ MULTISERVER_ENABLED: 'true' });
    expect(await registry.getDefaultId()).toBe('a1b2c3d4');
    expect(registry.resolveServerIdSync(undefined)).toBe('a1b2c3d4');
    expect(registry.resolveServerIdSync('other')).toBe('other');
  });
});
