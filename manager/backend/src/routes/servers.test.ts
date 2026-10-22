/**
 * Route tests for /api/servers: the delete guard (registry policy before any
 * Docker call, ownership labels before removing a container) and the
 * MULTISERVER_ENABLED feature flag.
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
fs.mkdirSync(tmpDir, { recursive: true });
process.env.MANAGER_DATA_PATH = tmpDir;
process.env.GAME_CONTAINER_NAME = 'kptest-game';
delete process.env.DEMO_MODE;
delete process.env.MULTISERVER_ENABLED;

const inspect = vi.fn();
const stop = vi.fn();
const remove = vi.fn();
const getContainer = vi.fn(() => ({ inspect, stop, remove }));
const fakeDocker = {
  getContainer,
  getImage: vi.fn(() => ({ inspect: vi.fn().mockResolvedValue({}) })),
  createContainer: vi.fn().mockResolvedValue({ id: 'new000000001', start: vi.fn() }),
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
vi.mock('../middleware/permissions.js', () => ({
  requirePermission: () => (_req: Request, _res: Response, next: NextFunction) => next(),
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
  return registry.createServerInstance({ name, createdBy: 'tester' });
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

  it('removes its own labelled container and the entry', async () => {
    const extra = await addExtraServer();
    inspect.mockResolvedValue({ Id: 'own000000001', Config: { Labels: ownLabelsFor(extra.id) } });
    stop.mockResolvedValue(undefined);
    remove.mockResolvedValue(undefined);

    const res = await call('DELETE', `/${extra.id}`);
    expect(res.status).toBe(200);
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

  it('creates a server with a generated container name while the flag is on', async () => {
    config.multiserverEnabled = true;

    const res = await call('POST', '', { name: 'Allowed', containerName: 'kptest-manager' });
    expect(res.status).toBe(200);
    const created = res.body.server as { id: string; containerName: string };
    expect(created.containerName).toBe(`hytale-srv-${created.id}`);
    expect(fakeDocker.createContainer).toHaveBeenCalledWith(
      expect.objectContaining({ name: `hytale-srv-${created.id}` }),
    );
  });

  it('reports the flag and the compose server in the listing', async () => {
    const res = await call('GET', '');
    expect(res.status).toBe(200);
    expect(res.body.multiserverEnabled).toBe(false);
    const servers = res.body.servers as Array<{ id: string; kind: string }>;
    expect(servers.find((s) => s.id === 'default')?.kind).toBe('compose');
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
});
