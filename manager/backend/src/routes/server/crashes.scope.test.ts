/**
 * Crash reports per server, on the real crash store (SQLite in a temp
 * folder): the list and a single report of server B only show B's crashes,
 * and a crash of another server is not readable by its id under B (404).
 * Auth and permissions are stubbed.
 */
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import http, { type Server } from 'http';
import type { AddressInfo } from 'net';
import fs from 'fs';
import os from 'os';
import path from 'path';
import express from 'express';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kp-crashes-scope-'));
process.env.MANAGER_DATA_PATH = tmpDir;

vi.mock('../../middleware/auth.js', () => ({
  authMiddleware: (req: { user?: string }, _res: unknown, next: () => void) => {
    req.user = 'alice';
    next();
  },
}));
vi.mock('../../middleware/permissions.js', () => ({
  requirePermission: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));
vi.mock('../../services/servers.js', () => ({
  resolveServerId: async (id?: string | null) => id || 'default',
}));

const { getDb, closeDb } = await import('../../db/index.js');
const { default: crashesRoutes } = await import('./crashes.js');

let server: Server;
let origin: string;
const crashOf: Record<string, number> = {};

const scope = (id: string | null) => (req: express.Request, _res: unknown, next: () => void) => {
  req.serverId = id ?? req.params.serverId;
  next();
};

beforeAll(async () => {
  const insert = getDb().prepare(
    'INSERT INTO crash_reports (server_id, detected_at, log_tail, created_at) VALUES (?, ?, ?, ?)',
  );
  for (const id of ['default', 'srv-b']) {
    const at = new Date().toISOString();
    crashOf[id] = Number(insert.run(id, at, `log of ${id}`, at).lastInsertRowid);
  }

  const app = express();
  app.use('/api/server', scope('default'), crashesRoutes);
  app.use('/api/servers/:serverId/server', scope(null), crashesRoutes);
  server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  closeDb();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const get = async (url: string) => {
  const res = await fetch(`${origin}${url}`);
  return { status: res.status, json: (await res.json()) as Record<string, any> };
};

describe('crash reports per server', () => {
  it("lists only the requested server's crashes", async () => {
    const onB = await get('/api/servers/srv-b/server/crashes');
    expect(onB.json.crashes.map((c: { id: number }) => c.id)).toEqual([crashOf['srv-b']]);
    const onA = await get('/api/server/crashes');
    expect(onA.json.crashes.map((c: { id: number }) => c.id)).toEqual([crashOf.default]);
  });

  it("does not show another server's crash log by its id", async () => {
    const own = await get(`/api/servers/srv-b/server/crashes/${crashOf['srv-b']}`);
    expect(own.status).toBe(200);
    expect(own.json.logTail).toBe('log of srv-b');

    const foreign = await get(`/api/servers/srv-b/server/crashes/${crashOf.default}`);
    expect(foreign.status).toBe(404);
    expect(foreign.json).not.toHaveProperty('logTail');
    // The legacy route is the default server's: B's crash is not there either.
    expect((await get(`/api/server/crashes/${crashOf['srv-b']}`)).status).toBe(404);
  });
});
