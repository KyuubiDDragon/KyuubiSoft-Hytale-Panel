/**
 * Data export and erasure of a player work on the request's server: through
 * server B they never show or delete what the panel keeps for A. The player
 * is matched by name and by the UUIDs of that name on B (renames). Records
 * still in effect stay. Every server at once is an explicit option for
 * accounts with access to every server.
 *
 * Real router, database and chat log; authentication and roles are stubbed.
 */
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import type { NextFunction, Request, Response } from 'express';
import type { AddressInfo } from 'net';
import type { Server } from 'http';
import path from 'path';
import os from 'os';
import fs from 'fs';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kp-players-gdpr-'));
process.env.MANAGER_DATA_PATH = tmpDir;
delete process.env.DEMO_MODE;

vi.mock('../middleware/auth.js', () => ({
  authMiddleware: (req: Request & { user?: string }, _res: Response, next: NextFunction) => {
    req.user = String(req.headers['x-user'] ?? 'root');
    next();
  },
}));
// Only the server list matters here: "limited" may use server b1 only.
vi.mock('../middleware/permissions.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../middleware/permissions.js')>()),
  requirePermission: () => (_req: Request, _res: Response, next: NextFunction) => next(),
  accessibleServerIds: async (req: { user?: string }) => (req.user === 'limited' ? ['b1'] : null),
}));
vi.mock('../services/activityLog.js', () => ({ logActivity: vi.fn(async () => undefined) }));

const express = (await import('express')).default;
const { default: playersRouter } = await import('./players.js');
const { getDb, closeDb } = await import('../db/index.js');
const chat = await import('../services/chatLog.js');

const UUID = '0a1b2c3d-0000-4000-8000-0000000000aa';
const OTHER = '0a1b2c3d-0000-4000-8000-0000000000bb';
let server: Server;
let base: string;

function seed(): void {
  const db = getDb();
  const at = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();
  const future = new Date(Date.now() + 3_600_000).toISOString();
  const punish = db.prepare(
    'INSERT INTO punishments (server_id, player_name, uuid, type, reason, by_user, created_at, expires_at, active) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
  );
  punish.run('default', 'Steve', UUID, 'tempban', 'on A', 'mod', at(5), future, 1);
  punish.run('b1', 'Steve', UUID, 'kick', 'on B', 'mod', at(4), null, 0);
  punish.run('b1', 'SteveOld', UUID, 'warn', 'old name on B', 'mod', at(30), null, 0);
  punish.run('b1', 'Steve', UUID, 'tempban', 'running on B', 'mod', at(3), future, 1);
  punish.run('b1', 'Alex', OTHER, 'warn', 'someone else', 'mod', at(2), null, 0);
  const note = db.prepare(
    'INSERT INTO player_notes (server_id, player_name, uuid, note, by_user, created_at) VALUES (?, ?, ?, ?, ?, ?)',
  );
  note.run('default', 'Steve', UUID, 'note on A', 'mod', at(6));
  note.run('b1', 'Steve', UUID, 'note on B', 'mod', at(7));
  const session = db.prepare(
    'INSERT INTO play_sessions (server_id, player_name, uuid, joined_at, left_at, duration_ms) VALUES (?, ?, ?, ?, ?, ?)',
  );
  session.run('default', 'Steve', UUID, at(60), at(50), 600_000);
  session.run('b1', 'Steve', UUID, at(40), at(30), 600_000);
  session.run('b1', 'SteveOld', UUID, at(90), at(80), 600_000);
}

beforeAll(async () => {
  seed();
  await chat.addChatMessage('default', 'Steve', 'chat on A');
  await chat.addChatMessage('b1', 'Steve', 'chat on B');
  await chat.addChatMessage('b1', 'SteveOld', 'old name on B');

  const app = express();
  app.use(express.json());
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

async function call(method: 'GET' | 'DELETE', route: string, user = 'root') {
  const res = await fetch(`${base}/api/servers${route}`, { method, headers: { 'x-user': user } });
  return { status: res.status, body: (await res.json()) as Record<string, any> };
}

const count = (sql: string, ...params: unknown[]) =>
  (
    getDb()
      .prepare(sql)
      .get(...params) as { n: number }
  ).n;

describe('player data export and erasure per server', () => {
  it("exports only B's records, including those under an earlier name", async () => {
    await vi.waitFor(async () => {
      const { body } = await call('GET', '/b1/players/Steve/export-data');
      expect(body.chat.map((m: { message: string }) => m.message).sort()).toEqual([
        'chat on B',
        'old name on B',
      ]);
    });
    const { status, body } = await call('GET', '/b1/players/Steve/export-data');
    expect(status).toBe(200);
    expect(body.notes.map((n: { note: string }) => n.note)).toEqual(['note on B']);
    expect(body.punishments.map((p: { reason: string }) => p.reason).sort()).toEqual([
      'old name on B',
      'on B',
      'running on B',
    ]);
    expect(body.playSessions.map((s: { server_id: string }) => s.server_id)).toEqual(['b1', 'b1']);
    expect(body.uuids).toEqual([UUID]);
  });

  it('refuses every server to an account limited to some servers', async () => {
    const exported = await call('GET', '/b1/players/Steve/export-data?allServers=true', 'limited');
    expect(exported).toMatchObject({ status: 403, body: { code: 'ALL_SERVERS_REQUIRED' } });
    const erased = await call('DELETE', '/b1/players/Steve/data?allServers=true', 'limited');
    expect(erased).toMatchObject({ status: 403, body: { code: 'ALL_SERVERS_REQUIRED' } });
    expect(count('SELECT COUNT(*) AS n FROM punishments')).toBe(5);
  });

  it('exports every server only when asked for explicitly', async () => {
    const { status, body } = await call('GET', '/b1/players/Steve/export-data?allServers=true');
    expect(status).toBe(200);
    expect(body.notes.map((n: { note: string }) => n.note).sort()).toEqual([
      'note on A',
      'note on B',
    ]);
  });

  it("erases B's records, keeps those still in effect and leaves A alone", async () => {
    const { status, body } = await call('DELETE', '/b1/players/Steve/data');
    expect(status).toBe(200);
    expect(body.deleted).toMatchObject({ notes: 1, punishments: 2, playSessions: 2, chat: true });
    expect(body.kept).toEqual({ activePunishments: 1 });

    // The running tempban on A keeps its record, so its expiry still lifts it.
    expect(
      count(
        "SELECT COUNT(*) AS n FROM punishments WHERE server_id = 'default' AND active = 1 AND type = 'tempban'",
      ),
    ).toBe(1);
    expect(count("SELECT COUNT(*) AS n FROM player_notes WHERE server_id = 'default'")).toBe(1);
    expect(count("SELECT COUNT(*) AS n FROM play_sessions WHERE server_id = 'default'")).toBe(1);
    expect((await chat.getPlayerChatHistory('Steve', 'default')).map((m) => m.message)).toEqual([
      'chat on A',
    ]);
    // On B: only the running tempban and another player's record remain.
    expect(
      (
        getDb()
          .prepare("SELECT reason FROM punishments WHERE server_id = 'b1' ORDER BY reason")
          .all() as Array<{ reason: string }>
      ).map((r) => r.reason),
    ).toEqual(['running on B', 'someone else']);
    expect(await chat.getPlayerChatHistory('SteveOld', 'b1')).toEqual([]);
  });
});
