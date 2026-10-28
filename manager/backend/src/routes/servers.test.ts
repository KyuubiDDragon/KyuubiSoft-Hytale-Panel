/**
 * Route tests for /api/servers: the delete guard (registry policy before any
 * Docker call, ownership labels before removing a container), the
 * MULTISERVER_ENABLED feature flag, creating from the primary container's
 * template with checked host ports, the servers.manage permission, the trash
 * and the reconcile.
 *
 * The real registry (services/servers.ts) runs against a temp dir; auth,
 * permissions and audit are stubbed, and Docker is a fake handed to the real
 * dockerImageManager via the mocked getDockerInstance().
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import type { NextFunction, Request, Response } from 'express';
import type { AddressInfo } from 'net';
import type { Server } from 'http';
import path from 'path';
import os from 'os';
import fs from 'fs';

const tmpDir = path.join(os.tmpdir(), `kp-servers-route-${Date.now()}`);
const instancesRoot = path.join(tmpDir, 'instances');
fs.mkdirSync(instancesRoot, { recursive: true });
process.env.MANAGER_DATA_PATH = tmpDir;
process.env.INSTANCES_PATH = instancesRoot;
process.env.GAME_CONTAINER_NAME = 'kptest-game';
process.env.STACK_NAME = 'kptest';
delete process.env.DEMO_MODE;
delete process.env.MULTISERVER_ENABLED;
delete process.env.HYTALE_IMAGE;
delete process.env.WEBMAP_BIND;

const GiB = 1024 ** 3;

/** `docker inspect` of the compose stack's game container. */
const primaryInfo = () => ({
  Id: 'primary000001',
  Image: 'sha256:primary',
  Config: {
    Image: 'kptest-hytale',
    Env: [
      'JAVA_MAX_RAM=6G',
      'USE_HYTALE_DOWNLOADER=false',
      'HYTALE_AUTH_KEY_FILE=/run/secrets/key',
    ],
    Labels: { 'com.docker.compose.service': 'hytale' },
  },
  HostConfig: { NetworkMode: 'kptest-net', Memory: 8 * GiB, NanoCpus: 4e9 },
  NetworkSettings: { Networks: { 'kptest-net': {} } },
});

// The instance container (inspect/stop/remove/update) and the primary.
const inspect = vi.fn();
const stop = vi.fn();
const remove = vi.fn();
const update = vi.fn();
const primaryInspect = vi.fn();
const getContainer = vi.fn((name: string) =>
  name === 'kptest-game' ? { inspect: primaryInspect } : { inspect, stop, remove, update },
);
const imageInspect = vi.fn();
const fakeDocker = {
  getContainer,
  getImage: vi.fn((ref: string) => ({ inspect: () => imageInspect(ref) })),
  getNetwork: vi.fn(() => ({ inspect: vi.fn().mockResolvedValue({}) })),
  listContainers: vi.fn(),
  createContainer: vi.fn(),
};

vi.mock('../services/docker.js', () => ({ getDockerInstance: () => fakeDocker }));
// The graceful stop itself is covered in serverLifecycle.test.ts; here only
// that the delete goes through it, after the ownership check.
const { stopServerAndRun } = vi.hoisted(() => ({
  stopServerAndRun: vi.fn(async (_id: string, _opts: unknown, fn: () => Promise<unknown>) => fn()),
}));
vi.mock('../services/serverLifecycle.js', () => ({ stopServerAndRun }));
vi.mock('../services/audit.js', () => ({ audit: vi.fn() }));
vi.mock('../middleware/auth.js', () => ({
  authMiddleware: (req: Request & { user?: string }, _res: Response, next: NextFunction) => {
    req.user = 'tester';
    next();
  },
}));
// Permissions: the caller holds `granted.perms` ('*' = everything).
const granted = vi.hoisted(() => ({ perms: new Set<string>(['*']) }));
vi.mock('../middleware/permissions.js', () => ({
  requirePermission:
    (...perms: string[]) =>
    (_req: Request, res: Response, next: NextFunction) => {
      if (granted.perms.has('*') || perms.every((p) => granted.perms.has(p))) {
        next();
        return;
      }
      res.status(403).json({ error: 'Insufficient permissions', required: perms });
    },
  // Server lists are covered by servers.access.test.ts; here the caller has every server.
  filterAccessibleServers: async (_req: Request, servers: unknown[]) => servers,
  requireServerAccess: () => (_req: Request, _res: Response, next: NextFunction) => next(),
  requireAllServerAccess: () => (_req: Request, _res: Response, next: NextFunction) => next(),
}));
// Whether the instances folder is mounted is a property of the container.
const mount = vi.hoisted(() => ({ present: true }));
vi.mock('../services/serverContext.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/serverContext.js')>()),
  isInstancesMountPresent: () => mount.present,
}));

const express = (await import('express')).default;
const { default: serversRouter } = await import('./servers.js');
const { config } = await import('../config.js');
const registry = await import('../services/servers.js');

let server: Server;
let baseUrl: string;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/servers', serversRouter);
  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', () => resolve());
  });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/servers`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

beforeEach(() => {
  vi.clearAllMocks();
  config.multiserverEnabled = false;
  granted.perms = new Set(['*']);
  mount.present = true;
  primaryInspect.mockResolvedValue(primaryInfo());
  // The primary's tag still points at the image it runs.
  imageInspect.mockImplementation(async (ref: string) => ({
    Id: ref === 'kptest-hytale' ? 'sha256:primary' : ref,
  }));
  fakeDocker.listContainers.mockResolvedValue([]);
  fakeDocker.createContainer.mockResolvedValue({ id: 'new000000001', start: vi.fn() });
});

async function call(method: string, suffix: string, body?: unknown) {
  const res = await fetch(`${baseUrl}${suffix}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

async function addExtraServer(name = 'Extra') {
  const created = await registry.createServerInstance({ name, createdBy: 'tester' });
  return (await registry.updateServerInstance(created.id, { status: 'ready' }))!;
}

const ownLabelsFor = (id: string) => ({
  'kyuubisoft.panel.managed': 'true',
  'kyuubisoft.panel.server-id': id,
});

describe('DELETE /api/servers/:id', () => {
  it('refuses to delete the compose server without any Docker call', async () => {
    const res = await call('DELETE', '/default');
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ code: 'SERVER_NOT_DELETABLE', reason: 'compose' });
    expect(getContainer).not.toHaveBeenCalled();
    expect(await registry.getServer('default')).not.toBeNull();
  });

  it('refuses to delete the current default server without any Docker call', async () => {
    config.multiserverEnabled = true;
    const extra = await addExtraServer('Default for a while');
    await registry.setDefaultId(extra.id);
    try {
      const res = await call('DELETE', `/${extra.id}`);
      expect(res.status).toBe(409);
      expect(res.body).toMatchObject({ code: 'SERVER_NOT_DELETABLE', reason: 'default' });
      expect(getContainer).not.toHaveBeenCalled();
    } finally {
      await registry.setDefaultId('default');
    }
  });

  it('404s an unknown server', async () => {
    const res = await call('DELETE', '/nope1234');
    expect(res.status).toBe(404);
    expect(getContainer).not.toHaveBeenCalled();
  });

  it('refuses to remove a foreign container without the panel labels and keeps the entry', async () => {
    const extra = await addExtraServer();
    inspect.mockResolvedValue({ Id: 'f0e1gn000001', Config: { Labels: {} } });

    const res = await call('DELETE', `/${extra.id}`);
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ code: 'CONTAINER_NOT_MANAGED' });
    expect(stopServerAndRun).not.toHaveBeenCalled();
    expect(stop).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
    expect(await registry.getServer(extra.id)).not.toBeNull();
  });

  it('drops only the registry entry with keepContainer=true', async () => {
    const extra = await addExtraServer();

    const res = await call('DELETE', `/${extra.id}?keepContainer=true`);
    expect(res.status).toBe(200);
    expect(getContainer).not.toHaveBeenCalled();
    expect(await registry.getServer(extra.id)).toBeNull();
  });

  it('removes its own labelled container and the entry, and keeps the data', async () => {
    const extra = await addExtraServer();
    inspect.mockResolvedValue({ Id: 'own000000001', Config: { Labels: ownLabelsFor(extra.id) } });
    stop.mockResolvedValue(undefined);
    remove.mockResolvedValue(undefined);

    const res = await call('DELETE', `/${extra.id}`);
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ kept: true });
    expect(getContainer).toHaveBeenCalledWith(extra.containerName);
    // Stopped through the lifecycle (/stop, wait, under the server's lock),
    // not with Docker's 10-second SIGTERM.
    expect(stopServerAndRun).toHaveBeenCalledWith(
      extra.id,
      { reason: 'delete', actor: 'tester', rejectIfBusy: true },
      expect.any(Function),
    );
    expect(stop).not.toHaveBeenCalled();
    expect(remove).toHaveBeenCalledWith({ force: true, v: false });
    expect(await registry.getServer(extra.id)).toBeNull();
  });

  it('moves the server folder to the trash with removeData=true', async () => {
    const extra = await addExtraServer();
    const dataDir = path.join(instancesRoot, extra.id, 'data');
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(path.join(dataDir, 'world.dat'), 'x');
    inspect.mockResolvedValue({ Id: 'own000000009', Config: { Labels: ownLabelsFor(extra.id) } });
    remove.mockResolvedValue(undefined);

    const res = await call('DELETE', `/${extra.id}?removeData=true`);
    expect(res.status).toBe(200);
    const entry = (res.body.data as { trashEntry: string }).trashEntry;
    expect(entry).toMatch(new RegExp(`^${extra.id}-`));
    expect(fs.existsSync(path.join(instancesRoot, extra.id))).toBe(false);
    expect(fs.existsSync(path.join(instancesRoot, '.trash', entry, 'data', 'world.dat'))).toBe(
      true,
    );
    expect(await registry.getServer(extra.id)).toBeNull();
  });

  it('refuses removeData before touching anything while the files are not visible', async () => {
    const extra = await addExtraServer();
    mount.present = false;

    const res = await call('DELETE', `/${extra.id}?removeData=true`);
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ code: 'INSTANCE_DATA_UNAVAILABLE' });
    expect(getContainer).not.toHaveBeenCalled();
    expect(await registry.getServer(extra.id)).not.toBeNull();
  });

  it('refuses removeData before any stop when the trash is not a folder', async () => {
    const extra = await addExtraServer();
    fs.mkdirSync(path.join(instancesRoot, extra.id, 'data'), { recursive: true });
    const trash = path.join(instancesRoot, '.trash');
    const parked = path.join(tmpDir, 'trash-parked');
    const hadTrash = fs.existsSync(trash);
    if (hadTrash) fs.renameSync(trash, parked);
    fs.writeFileSync(trash, 'not a folder');
    try {
      const res = await call('DELETE', `/${extra.id}?removeData=true`);
      expect(res.status).toBe(409);
      expect(res.body).toMatchObject({ code: 'INSTANCE_DATA_LAYOUT' });
      expect(getContainer).not.toHaveBeenCalled();
      expect(await registry.getServer(extra.id)).not.toBeNull();
    } finally {
      fs.rmSync(trash, { force: true });
      if (hadTrash) fs.renameSync(parked, trash);
    }
  });

  it('keeps the entry as broken when the folder cannot be moved after the container is gone', async () => {
    const extra = await addExtraServer();
    fs.mkdirSync(path.join(instancesRoot, extra.id, 'data'), { recursive: true });
    inspect.mockResolvedValue({ Id: 'own000000011', Config: { Labels: ownLabelsFor(extra.id) } });
    remove.mockResolvedValue(undefined);
    const denied = Object.assign(new Error('EACCES: permission denied, rename'), {
      code: 'EACCES',
    });
    const rename = vi.spyOn(fs.promises, 'rename').mockRejectedValueOnce(denied);
    try {
      const res = await call('DELETE', `/${extra.id}?removeData=true`);
      expect(res.status).toBe(500);
      expect(res.body).toMatchObject({
        code: 'INSTANCE_DATA_MOVE_FAILED',
        detail: expect.stringMatching(/sudo chown -R 9999:9999/),
      });
      expect(remove).toHaveBeenCalled();
      expect((await registry.getServer(extra.id))?.status).toBe('broken');
      expect(fs.existsSync(path.join(instancesRoot, extra.id, 'data'))).toBe(true);
    } finally {
      rename.mockRestore();
    }
  });

  it('refuses removeData together with keepContainer', async () => {
    const extra = await addExtraServer();
    const res = await call('DELETE', `/${extra.id}?removeData=true&keepContainer=true`);
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'INVALID_DELETE_OPTIONS' });
    expect(await registry.getServer(extra.id)).not.toBeNull();
  });

  it('keeps the container and the entry when the server cannot be stopped', async () => {
    const extra = await addExtraServer();
    inspect.mockResolvedValue({ Id: 'own000000002', Config: { Labels: ownLabelsFor(extra.id) } });
    stopServerAndRun.mockRejectedValueOnce(new Error('Could not stop the server: daemon gone'));

    const res = await call('DELETE', `/${extra.id}`);
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({
      code: 'SERVER_STOP_FAILED',
      detail: expect.stringMatching(/Could not stop the server/),
    });
    expect(remove).not.toHaveBeenCalled();
    expect(await registry.getServer(extra.id)).not.toBeNull();
  });

  it('reports a failed removal after the stop as a Docker error', async () => {
    const extra = await addExtraServer();
    inspect.mockResolvedValue({ Id: 'own000000003', Config: { Labels: ownLabelsFor(extra.id) } });
    remove.mockRejectedValueOnce(new Error('removal of container is already in progress'));

    const res = await call('DELETE', `/${extra.id}`);
    expect(res.status).toBe(502);
    expect(res.body).toMatchObject({ code: 'CONTAINER_REMOVE_FAILED' });
    expect(await registry.getServer(extra.id)).not.toBeNull();
  });

  it('keeps the entry when Docker cannot verify the container', async () => {
    const extra = await addExtraServer();
    inspect.mockRejectedValue(new Error('connect ECONNREFUSED /var/run/docker.sock'));

    const res = await call('DELETE', `/${extra.id}`);
    expect(res.status).toBe(502);
    expect(res.body).toMatchObject({ code: 'CONTAINER_REMOVE_FAILED' });
    expect(await registry.getServer(extra.id)).not.toBeNull();
  });
});

describe('multiserver feature flag', () => {
  it('refuses to create a server while MULTISERVER_ENABLED is off', async () => {
    const before = (await registry.listServers()).length;

    const res = await call('POST', '', { name: 'Blocked' });
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: 'MULTISERVER_DISABLED' });
    expect(fakeDocker.createContainer).not.toHaveBeenCalled();
    expect((await registry.listServers()).length).toBe(before);
  });

  it('reports the flag, the compose server and the derived state in the listing', async () => {
    const res = await call('GET', '');
    expect(res.status).toBe(200);
    expect(res.body.multiserverEnabled).toBe(false);
    const servers = res.body.servers as Array<{
      id: string;
      kind: string;
      state: string;
      files: string;
    }>;
    const compose = servers.find((s) => s.id === 'default');
    expect(compose?.kind).toBe('compose');
    expect(['ready', 'waiting_for_files']).toContain(compose?.state);
  });

  it('only lets the default point back at the compose server while the flag is off', async () => {
    const extra = await addExtraServer();

    const away = await call('PUT', '/default', { id: extra.id });
    expect(away.status).toBe(403);
    expect(away.body).toMatchObject({ code: 'MULTISERVER_DISABLED' });
    expect(await registry.getDefaultId()).toBe('default');

    const back = await call('PUT', '/default', { id: 'default' });
    expect(back.status).toBe(200);
  });

  it('moves the default to another server with the flag on, and back', async () => {
    config.multiserverEnabled = true;
    const extra = await addExtraServer();

    for (const route of ['/_default', '/default']) {
      const away = await call('PUT', route, { id: extra.id });
      expect(away.status).toBe(200);
      expect(away.body).toEqual({ success: true, defaultId: extra.id });
      expect(await registry.getDefaultId()).toBe(extra.id);
      expect((await call('PUT', '/_default', { id: 'default' })).status).toBe(200);
      expect(await registry.getDefaultId()).toBe('default');
    }
    expect((await call('PUT', '/_default', { id: 'nope1234' })).status).toBe(400);
    expect(await registry.getDefaultId()).toBe('default');
  });
});

describe('POST /api/servers', () => {
  beforeEach(() => {
    config.multiserverEnabled = true;
  });

  it('creates from the primary template with a generated name and answers 201', async () => {
    const res = await call('POST', '', {
      name: 'Allowed',
      containerName: 'kptest-manager',
      pluginPort: 18095,
    });
    expect(res.status).toBe(201);
    const created = res.body.server as {
      id: string;
      containerName: string;
      status: string;
      state: string;
      files: string;
      network: { serverPort: number };
    };
    expect(created.containerName).toBe(`hytale-srv-${created.id}`);
    expect(created.status).toBe('ready');
    // The folders exist, the game files do not: the container waits for them.
    expect(created.files).toBe('missing');
    expect(created.state).toBe('waiting_for_files');
    expect(res.body.warnings).toEqual(
      expect.arrayContaining([expect.stringMatching(/no game files yet/)]),
    );

    const opts = fakeDocker.createContainer.mock.calls[0][0] as {
      name: string;
      Image: string;
      Env: string[];
      ExposedPorts: Record<string, unknown>;
      HostConfig: Record<string, unknown> & { PortBindings: Record<string, unknown> };
    };
    expect(opts.name).toBe(`hytale-srv-${created.id}`);
    // The image id the primary runs, not its tag.
    expect(opts.Image).toBe('sha256:primary');
    expect(opts.HostConfig).toMatchObject({
      Memory: 8 * GiB,
      NanoCpus: 4e9,
      NetworkMode: 'kptest-net',
    });
    // Only the game port: no plugin port, no map without explicit map ports.
    expect(Object.keys(opts.HostConfig.PortBindings)).toEqual([
      `${created.network.serverPort}/udp`,
    ]);
    expect(Object.keys(opts.ExposedPorts)).toEqual([`${created.network.serverPort}/udp`]);
    expect(opts.Env).toContain('JAVA_MAX_RAM=6G');
    expect(opts.Env.some((e) => e.startsWith('HYTALE_AUTH_KEY_FILE='))).toBe(false);

    const stored = await registry.getServer(created.id);
    expect(stored).toMatchObject({
      status: 'ready',
      image: 'sha256:primary',
      network: { publishWebMap: false },
    });
    expect(stored?.network).not.toHaveProperty('pluginPort');
  });

  it('answers 409 for an explicit port another container holds and creates nothing', async () => {
    fakeDocker.listContainers.mockResolvedValue([
      {
        Id: 'other',
        Names: ['/other-stack-game'],
        State: 'running',
        Ports: [{ PublicPort: 5530, PrivatePort: 5520, Type: 'udp' }],
      },
    ]);
    const before = (await registry.listServers()).length;

    const res = await call('POST', '', { name: 'Clash', serverPort: 5530 });
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({
      code: 'PORT_CONFLICT',
      conflicts: [{ field: 'serverPort', port: 5530, proto: 'udp', owner: 'other-stack-game' }],
    });
    expect(fakeDocker.createContainer).not.toHaveBeenCalled();
    expect((await registry.listServers()).length).toBe(before);
  });

  it('skips host ports other containers hold when it picks one', async () => {
    const used = (await registry.listServers()).map((s) => s.network.serverPort);
    const next = Math.max(...used) + 1;
    fakeDocker.listContainers.mockResolvedValue([
      { Id: 'x', Names: ['/x'], State: 'running', Ports: [{ PublicPort: next, Type: 'udp' }] },
    ]);
    const res = await call('POST', '', { name: 'Picks' });
    expect(res.status).toBe(201);
    const port = (res.body.server as { network: { serverPort: number } }).network.serverPort;
    expect(used).not.toContain(port);
    expect(port).not.toBe(next);
  });

  it('publishes the map only for explicitly requested map ports', async () => {
    const res = await call('POST', '', { name: 'Map', webMapPort: 26081 });
    expect(res.status).toBe(201);
    const opts = fakeDocker.createContainer.mock.calls[0][0] as {
      HostConfig: { PortBindings: Record<string, unknown> };
    };
    expect(opts.HostConfig.PortBindings).toMatchObject({ '26081/tcp': [{ HostPort: '26081' }] });
    const network = (res.body.server as { network: Record<string, unknown> }).network;
    expect(network).toMatchObject({ webMapPort: 26081, publishWebMap: true });
  });

  it('refuses a game port in the ephemeral range', async () => {
    const res = await call('POST', '', { name: 'High', serverPort: 40000 });
    expect(res.status).toBe(400);
  });

  it('refuses another image instead of ignoring it, and accepts the template image', async () => {
    const other = await call('POST', '', { name: 'Img', image: 'evil/image:latest' });
    expect(other.status).toBe(400);
    expect(other.body).toMatchObject({ code: 'IMAGE_NOT_SELECTABLE' });
    expect(fakeDocker.createContainer).not.toHaveBeenCalled();

    const same = await call('POST', '', { name: 'Img', image: 'kptest-hytale' });
    expect(same.status).toBe(201);
  });

  it('answers 503 and registers nothing when image and network are unknown', async () => {
    primaryInspect.mockRejectedValue(new Error('No such container: kptest-game'));
    imageInspect.mockRejectedValue(new Error('No such image'));
    const before = (await registry.listServers()).length;

    const res = await call('POST', '', { name: 'NoImage' });
    expect(res.status).toBe(503);
    expect(res.body).toMatchObject({ code: 'INSTANCE_TEMPLATE_UNAVAILABLE' });
    expect((await registry.listServers()).length).toBe(before);
  });

  it('refuses a memory limit the inherited heap does not fit', async () => {
    const res = await call('POST', '', { name: 'Small', limits: { memory: 4 * GiB } });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'MEMORY_LIMIT_TOO_SMALL' });
  });

  it('takes the limits of the request over the primary', async () => {
    const res = await call('POST', '', { name: 'Big', limits: { memory: 12 * GiB, cpus: 2 } });
    expect(res.status).toBe(201);
    const opts = fakeDocker.createContainer.mock.calls[0][0] as {
      HostConfig: Record<string, unknown>;
    };
    expect(opts.HostConfig).toMatchObject({ Memory: 12 * GiB, NanoCpus: 2e9 });
    const id = (res.body.server as { id: string }).id;
    expect((await registry.getServer(id))?.limits).toEqual({ memory: 12 * GiB, cpus: 2 });
  });

  it('answers 502 with the broken entry when Docker refuses the container', async () => {
    fakeDocker.createContainer.mockRejectedValue(
      new Error('Conflict. The container name is already in use'),
    );

    const res = await call('POST', '', { name: 'Refused' });
    expect(res.status).toBe(502);
    expect(res.body).toMatchObject({
      code: 'CONTAINER_CREATE_FAILED',
      server: { status: 'broken' },
    });
  });

  it('answers 503 when Docker cannot list the host ports', async () => {
    fakeDocker.listContainers.mockRejectedValue(new Error('connect ENOENT /var/run/docker.sock'));
    const res = await call('POST', '', { name: 'NoDocker' });
    expect(res.status).toBe(503);
    expect(res.body).toMatchObject({ code: 'DOCKER_UNAVAILABLE' });
  });
});

describe('PUT /api/servers/:id and the default pointer', () => {
  it('refuses a status from the outside', async () => {
    const extra = await addExtraServer();
    const res = await call('PUT', `/${extra.id}`, { status: 'creating' });
    expect(res.status).toBe(400);
    expect((await registry.getServer(extra.id))?.status).toBe('ready');
  });

  it('renames a server', async () => {
    const extra = await addExtraServer();
    const res = await call('PUT', `/${extra.id}`, { name: 'Renamed' });
    expect(res.status).toBe(200);
    expect((await registry.getServer(extra.id))?.name).toBe('Renamed');
  });

  it('applies new limits to the running container and stores them', async () => {
    const extra = await addExtraServer();
    inspect.mockResolvedValue({
      Id: 'own000000010',
      Config: { Labels: ownLabelsFor(extra.id) },
      HostConfig: {},
    });
    update.mockResolvedValue(undefined);

    const res = await call('PUT', `/${extra.id}`, { limits: { cpus: 2 } });
    expect(res.status).toBe(200);
    expect(update).toHaveBeenCalledWith({ NanoCpus: 2e9 });
    expect((await registry.getServer(extra.id))?.limits).toEqual({ cpus: 2 });
  });

  it("refuses limits for the compose server and for someone else's container", async () => {
    // Without `id`, PUT /default edits the compose server instead of moving the pointer.
    const compose = await call('PUT', '/default', { limits: { cpus: 2 } });
    expect(compose.status).toBe(409);
    expect(compose.body).toMatchObject({ code: 'COMPOSE_LIMITS' });

    const extra = await addExtraServer();
    inspect.mockResolvedValue({ Id: 'foreign', Config: { Labels: {} }, HostConfig: {} });
    const foreign = await call('PUT', `/${extra.id}`, { limits: { cpus: 2 } });
    expect(foreign.status).toBe(409);
    expect(foreign.body).toMatchObject({ code: 'CONTAINER_NOT_MANAGED' });
    expect(update).not.toHaveBeenCalled();
  });

  it('needs servers.manage, not servers.create, to edit a server', async () => {
    const extra = await addExtraServer();
    granted.perms = new Set(['servers.list', 'servers.create']);
    const res = await call('PUT', `/${extra.id}`, { name: 'Nope' });
    expect(res.status).toBe(403);

    granted.perms = new Set(['servers.manage']);
    const ok = await call('PUT', `/${extra.id}`, { name: 'Yes' });
    expect(ok.status).toBe(200);
  });

  it('needs servers.manage, not servers.list, to change the default', async () => {
    for (const route of ['/default', '/_default']) {
      granted.perms = new Set(['servers.list']);
      const res = await call('PUT', route, { id: 'default' });
      expect(res.status).toBe(403);

      granted.perms = new Set(['servers.manage']);
      const ok = await call('PUT', route, { id: 'default' });
      expect(ok.status).toBe(200);
      // Reading the pointer needs servers.list.
      expect((await call('GET', route)).status).toBe(403);
      granted.perms = new Set(['servers.list']);
      expect((await call('GET', route)).body).toEqual({ defaultId: 'default' });
    }
  });

  it('renames the compose server through PUT /default without an id', async () => {
    const res = await call('PUT', '/default', { name: 'Main' });
    expect(res.status).toBe(200);
    expect((await registry.getServer('default'))?.name).toBe('Main');
    expect(await registry.getDefaultId()).toBe('default');
  });
});

describe('trash and reconcile', () => {
  async function trashedEntry(): Promise<string> {
    const extra = await addExtraServer('Trash me');
    fs.mkdirSync(path.join(instancesRoot, extra.id, 'server'), { recursive: true });
    inspect.mockResolvedValue({
      Id: `own-${extra.id}`,
      Config: { Labels: ownLabelsFor(extra.id) },
    });
    remove.mockResolvedValue(undefined);
    const res = await call('DELETE', `/${extra.id}?removeData=true`);
    return (res.body.data as { trashEntry: string }).trashEntry;
  }

  it('lists the trash and purges one entry only with the name repeated', async () => {
    const entry = await trashedEntry();
    const list = await call('GET', '/_trash');
    expect(list.status).toBe(200);
    expect((list.body.entries as Array<{ name: string }>).map((e) => e.name)).toContain(entry);

    const unconfirmed = await call('DELETE', `/_trash/${entry}`);
    expect(unconfirmed.status).toBe(400);
    expect(unconfirmed.body).toMatchObject({ code: 'CONFIRMATION_REQUIRED' });
    expect(fs.existsSync(path.join(instancesRoot, '.trash', entry))).toBe(true);

    const purged = await call('DELETE', `/_trash/${entry}?confirm=${entry}`);
    expect(purged.status).toBe(200);
    expect(fs.existsSync(path.join(instancesRoot, '.trash', entry))).toBe(false);
  });

  it('needs servers.delete for the trash', async () => {
    granted.perms = new Set(['servers.list']);
    expect((await call('GET', '/_trash')).status).toBe(403);
  });

  it('reconciles on request with servers.manage', async () => {
    const stuck = await registry.createServerInstance({ name: 'Stuck', createdBy: 'tester' });
    fakeDocker.listContainers.mockResolvedValue([
      {
        Id: 'c-stuck',
        Names: [`/${stuck.containerName}`],
        Labels: ownLabelsFor(stuck.id),
        State: 'created',
      },
    ]);

    granted.perms = new Set(['servers.create']);
    expect((await call('POST', '/_reconcile')).status).toBe(403);

    granted.perms = new Set(['servers.manage']);
    const res = await call('POST', '/_reconcile');
    expect(res.status).toBe(200);
    expect(res.body.changes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ serverId: stuck.id, from: 'creating', to: 'ready' }),
      ]),
    );
    expect((await registry.getServer(stuck.id))?.status).toBe('ready');
  });
});
