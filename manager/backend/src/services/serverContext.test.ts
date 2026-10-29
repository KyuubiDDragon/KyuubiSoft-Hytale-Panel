/**
 * getServerContext(): which server, where its files are, how to reach its
 * plugin; and checkServerFiles() for servers whose folders the manager
 * can't see. Real registry against a temp dir.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kp-context-'));
const instancesRoot = path.join(root, 'instances');
process.env.MANAGER_DATA_PATH = path.join(root, 'manager');
process.env.INSTANCES_PATH = instancesRoot;
process.env.GAME_CONTAINER_NAME = 'kptest-compose';
process.env.SERVER_PATH = path.join(root, 'compose', 'server');
process.env.DATA_PATH = path.join(root, 'compose', 'data');
fs.mkdirSync(process.env.MANAGER_DATA_PATH, { recursive: true });

function instance(id: string, base: string) {
  return {
    id,
    name: `Server ${id}`,
    containerName: `hytale-srv-${id}`,
    status: 'ready',
    network: { serverPort: 5521, webMapPort: 18083, webMapWsPort: 18084 },
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
  };
}

const compose = { ...instance('default', '/stale'), containerName: 'stale-name', name: 'Primary' };
const visible = instance(
  'aaaa0001',
  path.posix.join(instancesRoot.split(path.sep).join('/'), 'aaaa0001'),
);
const unmounted = instance(
  'bbbb0002',
  path.posix.join(instancesRoot.split(path.sep).join('/'), 'bbbb0002'),
);
const elsewhere = instance('cccc0003', path.join(root, 'nowhere').split(path.sep).join('/'));

fs.writeFileSync(
  path.join(process.env.MANAGER_DATA_PATH, 'servers.json'),
  JSON.stringify({
    schemaVersion: 2,
    defaultId: 'default',
    servers: [compose, visible, unmounted, elsewhere],
  }),
);

const ctxModule = await import('./serverContext.js');
const { config } = await import('../config.js');
const { getServerContext, checkServerFiles, UnknownServerError, PLUGIN_INTERNAL_PORT } = ctxModule;

beforeAll(() => {
  fs.mkdirSync(path.join(instancesRoot, 'aaaa0001', 'server'), { recursive: true });
});

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
  for (const key of ['INSTANCES_PATH', 'GAME_CONTAINER_NAME', 'SERVER_PATH', 'DATA_PATH']) {
    delete process.env[key];
  }
});

describe('getServerContext', () => {
  it('resolves an omitted or null id to the default server', async () => {
    for (const id of [undefined, null, '']) {
      expect((await getServerContext(id)).id).toBe('default');
    }
  });

  it('gives the compose server the env config, not its registry row', async () => {
    const ctx = await getServerContext('default');
    expect(ctx).toMatchObject({
      kind: 'compose',
      name: 'Primary',
      containerName: 'kptest-compose',
      plugin: { host: 'kptest-compose', port: PLUGIN_INTERNAL_PORT },
    });
    expect(ctx.paths.server).toBe(config.serverPath);
    expect(ctx.paths.data).toBe(config.dataPath);
    expect(ctx.network.webMapPort).toBe(config.webMapPort);
  });

  it("gives an additional server its registry folders and the plugin's internal port", async () => {
    const ctx = await getServerContext('aaaa0001');
    expect(ctx).toMatchObject({
      id: 'aaaa0001',
      kind: 'managed',
      containerName: 'hytale-srv-aaaa0001',
      paths: visible.paths,
      network: visible.network,
      plugin: { host: 'hytale-srv-aaaa0001', port: 18085 },
    });
  });

  it('throws for an unknown id instead of falling back to the default server', async () => {
    const err = await getServerContext('nope').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UnknownServerError);
    expect(err).toMatchObject({ code: 'unknown_server', serverId: 'nope' });
  });
});

describe('checkServerFiles', () => {
  it('always has the compose server', async () => {
    expect(checkServerFiles(await getServerContext('default'))).toEqual({ available: true });
  });

  it('has an instance whose server folder the manager sees', async () => {
    expect(checkServerFiles(await getServerContext('aaaa0001'))).toEqual({ available: true });
  });

  it('reports a missing instance folder', async () => {
    const state = checkServerFiles(await getServerContext('bbbb0002'));
    expect(state).toMatchObject({ available: false });
    // On Linux a folder on the root filesystem is not a mount; elsewhere an
    // existing folder counts as mounted.
    const onRootFs = fs.statSync(instancesRoot).dev === fs.statSync('/').dev;
    const expected = process.platform === 'linux' && onRootFs ? 'mount_missing' : 'not_found';
    expect(state).toMatchObject({ reason: expected });
    expect(ctxModule.isInstancesMountPresent()).toBe(expected === 'not_found');
  });

  it('reports a missing instances mount', async () => {
    fs.rmSync(instancesRoot, { recursive: true, force: true });
    try {
      const state = checkServerFiles(await getServerContext('bbbb0002'));
      expect(state).toMatchObject({ available: false, reason: 'mount_missing' });
      expect(state.available === false && state.detail).toMatch(/not mounted into the manager/);
    } finally {
      fs.mkdirSync(path.join(instancesRoot, 'aaaa0001', 'server'), { recursive: true });
    }
  });

  it('reports a folder outside the instances root as not found', async () => {
    expect(checkServerFiles(await getServerContext('cccc0003'))).toMatchObject({
      available: false,
      reason: 'not_found',
    });
  });
});
