/**
 * Route test for the --allow-op switch (PUT /api/server/allow-op). With it on
 * every player can make themselves an operator (/op self), so turning it on
 * needs players.op as well as config.edit; turning it off needs config.edit
 * only. Real panel-config.json in a temp dir; Docker, the lifecycle module,
 * auth and permissions are stubbed.
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import type { NextFunction, Request, Response } from 'express';
import type { AddressInfo } from 'net';
import type { Server } from 'http';
import path from 'path';
import os from 'os';
import fs from 'fs';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kp-allowop-route-'));
const dataDir = path.join(root, 'data');
process.env.MANAGER_DATA_PATH = path.join(root, 'manager');
process.env.SERVER_PATH = path.join(root, 'server');
process.env.DATA_PATH = dataDir;
process.env.BACKUPS_PATH = path.join(root, 'backups');
delete process.env.DEMO_MODE;

const denied = new Set<string>();

vi.mock('../../services/docker.js', () => ({
  getContainerState: vi.fn(async () => ({ running: false })),
}));
vi.mock('../../services/serverLifecycle.js', () => ({
  withServerStopped: vi.fn(),
  LifecycleBusyError: class LifecycleBusyError extends Error {},
}));
vi.mock('../../middleware/auth.js', () => ({
  authMiddleware: (req: Request & { user?: string }, _res: Response, next: NextFunction) => {
    req.user = 'tester';
    next();
  },
}));
vi.mock('../../middleware/permissions.js', () => ({
  requirePermission:
    (...perms: string[]) =>
    (_req: Request, res: Response, next: NextFunction) =>
      perms.some((p) => denied.has(p))
        ? res.status(403).json({ error: 'Insufficient permissions', required: perms })
        : next(),
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

const panelConfig = () => path.join(dataDir, 'panel-config.json');
const storedAllowOp = () =>
  fs.existsSync(panelConfig())
    ? JSON.parse(fs.readFileSync(panelConfig(), 'utf-8')).allowOp
    : undefined;

beforeEach(() => {
  denied.clear();
  fs.rmSync(dataDir, { recursive: true, force: true });
  fs.mkdirSync(dataDir, { recursive: true });
});

async function put(allowOp: unknown) {
  const res = await fetch(`${baseUrl}/allow-op`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ allowOp }),
  });
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

describe('PUT /allow-op', () => {
  it('turning it on needs players.op; the file stays as it was without it', async () => {
    denied.add('players.op');
    const refused = await put(true);
    expect(refused.status).toBe(403);
    expect(refused.json.required).toEqual(['players.op']);
    expect(storedAllowOp()).toBeUndefined();

    denied.clear();
    expect((await put(true)).status).toBe(200);
    expect(storedAllowOp()).toBe(true);
  });

  it('turning it off needs config.edit only', async () => {
    denied.add('players.op');
    expect((await put(false)).status).toBe(200);
    expect(storedAllowOp()).toBe(false);
    denied.add('config.edit');
    expect((await put(false)).status).toBe(403);
  });

  it('still refuses a value that is no boolean', async () => {
    expect((await put('yes')).status).toBe(400);
  });
});
