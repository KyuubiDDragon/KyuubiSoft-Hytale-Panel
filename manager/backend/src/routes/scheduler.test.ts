/**
 * Route tests for /api/scheduler: restart times are validated before they
 * reach the scheduler (400 instead of a stop/start loop), and running a
 * backup needs the backup right, not only the scheduler right.
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import type { NextFunction, Request, Response } from 'express';
import type { AddressInfo } from 'net';
import type { Server } from 'http';
import path from 'path';
import os from 'os';
import fs from 'fs';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kp-scheduler-route-'));
process.env.MANAGER_DATA_PATH = tmpDir;
process.env.DATA_PATH = tmpDir;
delete process.env.DEMO_MODE;

const h = vi.hoisted(() => ({
  granted: [] as string[],
  saveConfig: vi.fn(() => true),
  createBackup: vi.fn(async () => ({ success: true })),
}));

vi.mock('../services/docker.js', () => ({}));
vi.mock('../services/audit.js', () => ({ audit: vi.fn() }));
vi.mock('../services/backup.js', () => ({ createBackup: h.createBackup }));
vi.mock('../services/scheduler.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/scheduler.js')>()),
  saveConfig: h.saveConfig,
}));
vi.mock('../middleware/auth.js', () => ({
  authMiddleware: (req: Request & { user?: string }, _res: Response, next: NextFunction) => {
    req.user = 'tester';
    next();
  },
}));
vi.mock('../middleware/permissions.js', () => ({
  // Like the real middleware: every listed permission is required.
  requirePermission:
    (...required: string[]) =>
    (_req: Request, res: Response, next: NextFunction) => {
      if (required.every((p) => h.granted.includes(p))) next();
      else res.status(403).json({ error: 'Insufficient permissions', required });
    },
}));

const express = (await import('express')).default;
const { default: schedulerRouter } = await import('./scheduler.js');

let server: Server;
let baseUrl: string;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/scheduler', schedulerRouter);
  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', () => resolve());
  });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/scheduler`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

beforeEach(() => {
  vi.clearAllMocks();
  h.granted = ['scheduler.edit'];
});

async function call(method: string, suffix: string, body?: unknown) {
  const res = await fetch(`${baseUrl}${suffix}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

describe('PUT /api/scheduler/config restart times', () => {
  it('refuses a time that is not "HH:MM" with 400 and saves nothing', async () => {
    for (const times of [['x'], ['3:00'], [3], 'x']) {
      const res = await call('PUT', '/config', { scheduledRestarts: { enabled: true, times } });
      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
    }
    expect(h.saveConfig).not.toHaveBeenCalled();
  });

  it('refuses times less than an hour apart and more than 24 times', async () => {
    const close = await call('PUT', '/config', {
      scheduledRestarts: { enabled: true, times: ['03:00', '03:30'] },
    });
    expect(close.status).toBe(400);
    expect(String(close.body.error)).toMatch(/less than 60 minutes apart/);

    const many = Array.from({ length: 25 }, (_, i) => `${String(i % 24).padStart(2, '0')}:30`);
    many[24] = '00:00';
    const tooMany = await call('PUT', '/config', {
      scheduledRestarts: { enabled: true, times: many },
    });
    expect(tooMany.status).toBe(400);
    expect(h.saveConfig).not.toHaveBeenCalled();
  });

  it('refuses a restart plan that is not an object', async () => {
    const res = await call('PUT', '/config', { scheduledRestarts: ['03:00'] });
    expect(res.status).toBe(400);
    expect(h.saveConfig).not.toHaveBeenCalled();
  });

  it('saves valid times sorted and without duplicates', async () => {
    const res = await call('PUT', '/config', {
      scheduledRestarts: { enabled: true, times: ['15:00', '03:00', '15:00'], createBackup: true },
    });
    expect(res.status).toBe(200);
    expect(h.saveConfig).toHaveBeenCalledWith(
      { scheduledRestarts: { enabled: true, times: ['03:00', '15:00'], createBackup: true } },
      undefined,
    );
  });

  it('leaves a plan without times alone', async () => {
    const res = await call('PUT', '/config', { scheduledRestarts: { enabled: false } });
    expect(res.status).toBe(200);
    expect(h.saveConfig).toHaveBeenCalledWith({ scheduledRestarts: { enabled: false } }, undefined);
  });
});

describe('POST /api/scheduler/backup/run', () => {
  it('needs backups.create in addition to scheduler.edit', async () => {
    const denied = await call('POST', '/backup/run');
    expect(denied.status).toBe(403);
    expect(h.createBackup).not.toHaveBeenCalled();

    h.granted = ['scheduler.edit', 'backups.create'];
    const allowed = await call('POST', '/backup/run');
    expect(allowed.status).toBe(200);
    expect(h.createBackup).toHaveBeenCalledOnce();
  });
});
