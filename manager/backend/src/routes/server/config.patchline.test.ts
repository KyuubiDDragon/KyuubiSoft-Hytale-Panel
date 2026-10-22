/**
 * Route tests for the patchline switch (PUT /api/server/patchline) and the
 * memory check of the JVM settings (PUT /api/server/jvm).
 *
 * A switch deletes the server files so the next start downloads the build of
 * the new patchline. A downloaded update of the old patchline must go as
 * well, or the start script installs it over the new build. Real filesystem
 * (temp dirs); Docker, the lifecycle module, auth and permissions are stubbed.
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import type { NextFunction, Request, Response } from 'express';
import type { AddressInfo } from 'net';
import type { Server } from 'http';
import path from 'path';
import os from 'os';
import fs from 'fs';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kp-patchline-route-'));
const serverDir = path.join(root, 'server');
const updaterDir = path.join(root, 'updater');
const dataDir = path.join(root, 'data');
process.env.MANAGER_DATA_PATH = path.join(root, 'manager');
process.env.SERVER_PATH = serverDir;
process.env.UPDATER_PATH = updaterDir;
process.env.DATA_PATH = dataDir;
process.env.BACKUPS_PATH = path.join(root, 'backups');
delete process.env.DEMO_MODE;

const state = { running: false, java: true as boolean | null };
const execCommand = vi.fn(async (_cmd: string) => ({ success: true }));
const execInContainer = vi.fn(async (_cmd: string) => ({ success: true, output: '' }));
vi.mock('../../services/docker.js', () => ({
  getContainerState: vi.fn(async () => ({ running: state.running })),
  isServerProcessRunning: vi.fn(async () => (state.running ? state.java : false)),
  execCommand: (cmd: string) => execCommand(cmd),
  execInContainer: (cmd: string) => execInContainer(cmd),
  getContainerMemoryLimit: vi.fn(async () => 8 * 1024 ** 3),
}));
const withServerStopped = vi.fn(async (_id: unknown, _opts: unknown, fn: () => Promise<unknown>) =>
  fn(),
);
vi.mock('../../services/serverLifecycle.js', () => ({
  withServerStopped: (id: unknown, opts: unknown, fn: () => Promise<unknown>) =>
    withServerStopped(id, opts, fn),
  LifecycleBusyError: class LifecycleBusyError extends Error {},
}));
vi.mock('../../middleware/auth.js', () => ({
  authMiddleware: (req: Request & { user?: string }, _res: Response, next: NextFunction) => {
    req.user = 'tester';
    next();
  },
}));
vi.mock('../../middleware/permissions.js', () => ({
  requirePermission: () => (_req: Request, _res: Response, next: NextFunction) => next(),
}));

const express = (await import('express')).default;
const { default: configRouter } = await import('./config.js');

let server: Server;
let baseUrl: string;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/server', configRouter);
  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', () => resolve());
  });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/server`;
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
  fs.rmSync(root, { recursive: true, force: true });
});

function write(file: string, content: string) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

const panelConfig = () =>
  JSON.parse(fs.readFileSync(path.join(dataDir, 'panel-config.json'), 'utf-8'));
const stagingExists = () => fs.existsSync(path.join(updaterDir, 'staging'));

beforeEach(() => {
  for (const d of [serverDir, updaterDir, dataDir]) {
    fs.rmSync(d, { recursive: true, force: true });
    fs.mkdirSync(d, { recursive: true });
  }
  state.running = false;
  state.java = true;
  execCommand.mockClear();
  execInContainer.mockClear();
  withServerStopped.mockClear();
  write(path.join(dataDir, 'panel-config.json'), JSON.stringify({ patchline: 'release' }));
  for (const f of ['HytaleServer.jar', 'Assets.zip', '.hytale-version']) {
    write(path.join(serverDir, f), 'release build');
  }
  write(path.join(updaterDir, 'staging', 'Server', 'HytaleServer.jar'), 'staged release update');
});

async function setPatchline(patchline: string) {
  const res = await fetch(`${baseUrl}/patchline`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ patchline }),
  });
  return { status: res.status, json: (await res.json()) as Record<string, any> };
}

describe('PUT /patchline', () => {
  it('discards the staged update and deletes the files of a stopped server itself', async () => {
    const { status, json } = await setPatchline('pre-release');
    expect(status).toBe(200);
    expect(json.changed).toBe(true);
    expect(withServerStopped).toHaveBeenCalledTimes(1);
    expect(withServerStopped.mock.calls[0][1]).toMatchObject({ rejectIfBusy: true });
    expect(stagingExists()).toBe(false);
    expect(fs.readdirSync(updaterDir)).toEqual([]);
    expect(fs.readdirSync(serverDir)).toEqual([]);
    expect(panelConfig().patchline).toBe('pre-release');
    // Nothing was asked of a container that is not running.
    expect(execCommand).not.toHaveBeenCalled();
    expect(execInContainer).not.toHaveBeenCalled();
  });

  it('asks a running server to drop its downloaded update (and a running download)', async () => {
    state.running = true;
    const { status } = await setPatchline('pre-release');
    expect(status).toBe(200);
    expect(execCommand).toHaveBeenCalledWith('/update cancel');
    expect(execInContainer.mock.calls[0][0]).toMatch(/rm -f .*HytaleServer\.jar.*Assets\.zip/);
    expect(withServerStopped).not.toHaveBeenCalled();
    expect(panelConfig().patchline).toBe('pre-release');
  });

  it('changes nothing while the container runs without Java (update or restart in progress)', async () => {
    state.running = true;
    state.java = false;
    const { status, json } = await setPatchline('pre-release');
    expect(status).toBe(409);
    expect(json.reason).toBe('lifecycle_busy');
    expect(panelConfig().patchline).toBe('release');
    expect(stagingExists()).toBe(true);
    expect(execCommand).not.toHaveBeenCalled();
  });

  it('does not switch when the running server cannot be asked to discard its update', async () => {
    state.running = true;
    execCommand.mockResolvedValueOnce({ success: false, error: 'console not reachable' } as never);
    const { status } = await setPatchline('pre-release');
    expect(status).toBe(503);
    expect(panelConfig().patchline).toBe('release');
    expect(execInContainer).not.toHaveBeenCalled();
  });

  it('keeps the staged update when the patchline stays the same', async () => {
    const { status, json } = await setPatchline('release');
    expect(status).toBe(200);
    expect(json.changed).toBe(false);
    expect(stagingExists()).toBe(true);
    expect(fs.existsSync(path.join(serverDir, 'HytaleServer.jar'))).toBe(true);
  });
});

describe('PUT /jvm memory check', () => {
  // 8 GB limit: the JVM keeps min(25 %, 1.5 GB) beyond the heap, so 6656M at most.
  async function saveJvm(javaMaxRam: string) {
    const res = await fetch(`${baseUrl}/jvm`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        javaMinRam: '3G',
        javaMaxRam,
        extraJavaArgs: '',
        extraServerArgs: '',
      }),
    });
    return { status: res.status, json: (await res.json()) as Record<string, any> };
  }

  it('refuses a new maximum that does not fit the container limit', async () => {
    const { status, json } = await saveJvm('7G');
    expect(status).toBe(400);
    expect(json.maxHeapMb).toBe(6656);
    expect((await saveJvm('6G')).status).toBe(200);
  });

  it('still saves the other settings when the stored maximum is above that', async () => {
    write(
      path.join(dataDir, 'panel-config.json'),
      JSON.stringify({ patchline: 'release', javaMaxRam: '7G' }),
    );
    const { status } = await saveJvm('7G');
    expect(status).toBe(200);
    // Raising it further is still refused.
    expect((await saveJvm('7500M')).status).toBe(400);
  });
});
