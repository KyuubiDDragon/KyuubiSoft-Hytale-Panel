/**
 * Demo mode changes nothing: changing a key's server list is simulated like
 * changing an account's.
 */
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import type { NextFunction, Request, Response } from 'express';
import type { AddressInfo } from 'net';
import type { Server } from 'http';
import path from 'path';
import os from 'os';
import fs from 'fs';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kp-user-servers-demo-'));
process.env.MANAGER_DATA_PATH = tmpDir;
process.env.DEMO_MODE = 'true';

const { setApiKeyServerIds } = vi.hoisted(() => ({ setApiKeyServerIds: vi.fn(() => true) }));
vi.mock('../services/apiKeys.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/apiKeys.js')>()),
  setApiKeyServerIds,
}));
vi.mock('../middleware/auth.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../middleware/auth.js')>()),
  authMiddleware: (req: Request & { user?: string }, _res: Response, next: NextFunction) => {
    req.user = 'admin';
    next();
  },
}));
vi.mock('../services/audit.js', () => ({ audit: vi.fn() }));

const express = (await import('express')).default;
const { default: userServersRouter } = await import('./userServers.js');

let server: Server;
let base: string;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/auth', userServersRouter);
  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', () => resolve());
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  delete process.env.DEMO_MODE;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('PUT /api/auth/api-keys/:id/servers in demo mode', () => {
  it('answers like a change but stores nothing', async () => {
    const res = await fetch(`${base}/api/auth/api-keys/some-key/servers`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ serverIds: ['default'] }),
    });

    expect(res.status).toBe(200);
    expect(((await res.json()) as { message?: string }).message).toMatch(/DEMO/);
    expect(setApiKeyServerIds).not.toHaveBeenCalled();
  });
});
