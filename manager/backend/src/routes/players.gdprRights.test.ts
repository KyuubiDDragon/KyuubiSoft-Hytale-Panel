/**
 * Export and erasure of a player's data have rights of their own: the export
 * holds staff notes, punishments and chat, so players.view (every viewer) is
 * not enough, and players.ban does not let a moderator erase records.
 *
 * Real router and real permission gate; authentication and the roles service
 * are stubbed.
 */
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import type { NextFunction, Request, Response } from 'express';
import type { AddressInfo } from 'net';
import type { Server } from 'http';
import path from 'path';
import os from 'os';
import fs from 'fs';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kp-players-gdpr-rights-'));
process.env.MANAGER_DATA_PATH = tmpDir;
delete process.env.DEMO_MODE;

const { perms } = vi.hoisted(() => ({ perms: new Map<string, string[]>() }));
vi.mock('../middleware/auth.js', () => ({
  authMiddleware: (req: Request & { user?: string }, _res: Response, next: NextFunction) => {
    req.user = String(req.headers['x-user'] ?? '');
    next();
  },
}));
vi.mock('../services/roles.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/roles.js')>()),
  getUserPermissions: async (user: string) => perms.get(user) ?? [],
  getUserPermissionsForServer: async (user: string) => perms.get(user) ?? [],
  getUserAllowedServers: async () => null,
}));
vi.mock('../services/activityLog.js', () => ({ logActivity: vi.fn(async () => undefined) }));

const express = (await import('express')).default;
const { default: playersRouter } = await import('./players.js');
const { closeDb } = await import('../db/index.js');

let server: Server;
let base: string;

beforeAll(async () => {
  perms.set('viewer', ['players.view']);
  perms.set('moderator', ['players.view', 'players.kick', 'players.ban', 'players.unban']);
  perms.set('exporter', ['players.export_data']);
  perms.set('eraser', ['players.erase_data']);
  const app = express();
  app.use(
    '/api/servers/:serverId/players',
    (req: Request & { serverId?: string }, _res: Response, next: NextFunction) => {
      req.serverId = req.params.serverId;
      next();
    },
    playersRouter,
  );
  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', () => resolve());
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  closeDb();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const call = async (method: 'GET' | 'DELETE', route: string, user: string) =>
  (
    await fetch(`${base}/api/servers/default/players/Steve${route}`, {
      method,
      headers: { 'x-user': user },
    })
  ).status;

describe('player data rights', () => {
  it('export needs players.export_data, players.view is not enough', async () => {
    expect(await call('GET', '/export-data', 'viewer')).toBe(403);
    expect(await call('GET', '/export-data', 'moderator')).toBe(403);
    expect(await call('GET', '/export-data', 'exporter')).toBe(200);
  });

  it('erasure needs players.erase_data, players.ban is not enough', async () => {
    expect(await call('DELETE', '/data', 'moderator')).toBe(403);
    expect(await call('DELETE', '/data', 'exporter')).toBe(403);
    expect(await call('DELETE', '/data', 'eraser')).toBe(200);
  });
});
