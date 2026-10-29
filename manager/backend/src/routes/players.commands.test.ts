/**
 * Player actions send the Hytale 0.7 syntax and never report a success that
 * did not happen:
 *  - kick takes only the player; the reason stays in the panel
 *  - heal / respawn / effects use the 0.7 commands when the plugin fails
 *  - inventory clear has no console command, so it needs the plugin
 *  - mute and private messages do not exist: 501, nothing recorded
 *  - over stdin (no plugin) the answer says the result is not confirmed
 *  - bans and the whitelist go through the access services (UUID, read back,
 *    files while stopped); a temp-ban is a ban the panel lifts itself
 *
 * Real router; authentication, roles, Docker and the plugin client are stubbed.
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import type { NextFunction, Request, Response } from 'express';
import type { AddressInfo } from 'net';
import type { Server } from 'http';
import path from 'path';
import os from 'os';
import fs from 'fs';

const tmpDir = path.join(os.tmpdir(), `kp-players-commands-${Date.now()}`);
fs.mkdirSync(tmpDir, { recursive: true });
process.env.MANAGER_DATA_PATH = tmpDir;
delete process.env.DEMO_MODE;

type Exec = { success: boolean; via?: 'plugin' | 'stdin'; error?: string; message?: string };
const h = vi.hoisted(() => ({
  execCommand: vi.fn(async (_command: string, _serverId?: string): Promise<Exec> => ({
    success: true,
    via: 'plugin',
  })),
  plugin: vi.fn(async (): Promise<{ success: boolean; error?: string; maybeRan?: boolean }> => ({
    success: false,
    error: 'Plugin not reachable',
  })),
  recordPunishment: vi.fn((_opts: Record<string, unknown>) => ({
    expiresAt: null as string | null,
  })),
  deactivate: vi.fn(),
  closeBanRecords: vi.fn(async (..._args: unknown[]) => 0),
  outcome: {
    via: 'plugin',
    verified: true,
    changed: true,
    view: {},
    uuid: '0a1b2c3d-0000-4000-8000-00000000005e',
    name: 'Steve',
  },
  banPlayer: vi.fn(
    async (_s: string | undefined, _p: string, _r?: unknown): Promise<unknown> => h.outcome,
  ),
  unbanPlayer: vi.fn(async (_s: string | undefined, _p: string): Promise<unknown> => h.outcome),
  addToWhitelist: vi.fn(async (_s: string | undefined, _p: string): Promise<unknown> => h.outcome),
  removeFromWhitelist: vi.fn(
    async (_s: string | undefined, _p: string): Promise<unknown> => h.outcome,
  ),
  AccessError: class extends Error {
    constructor(
      readonly status: number,
      message: string,
      readonly code: string,
    ) {
      super(message);
    }
  },
}));

vi.mock('../services/roles.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/roles.js')>()),
  getUserPermissions: async () => ['*'],
  getUserPermissionsForServer: async () => ['*'],
  hasPermission: async () => true,
}));
vi.mock('../services/docker.js', () => ({ execCommand: h.execCommand }));
vi.mock('../services/kyuubiApi.js', () => ({
  healPlayerViaPlugin: h.plugin,
  respawnPlayerViaPlugin: h.plugin,
  clearInventoryViaPlugin: h.plugin,
  killPlayerViaPlugin: h.plugin,
}));
vi.mock('../services/punishments.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/punishments.js')>()),
  recordPunishment: h.recordPunishment,
  deactivateActiveForPlayer: h.deactivate,
  closeBanRecords: h.closeBanRecords,
}));
vi.mock('../services/accessBans.js', () => ({
  banPlayer: h.banPlayer,
  unbanPlayer: h.unbanPlayer,
}));
vi.mock('../services/accessWhitelist.js', () => ({
  addToWhitelist: h.addToWhitelist,
  removeFromWhitelist: h.removeFromWhitelist,
}));
vi.mock('../services/accessContext.js', () => ({
  describeAccessError: (error: unknown) =>
    error instanceof h.AccessError
      ? { status: error.status, error: error.message, code: error.code }
      : { status: 500, error: 'internal', code: 'internal' },
}));
vi.mock('../services/activityLog.js', () => ({ logActivity: vi.fn(async () => undefined) }));
vi.mock('../services/audit.js', () => ({ audit: vi.fn() }));
vi.mock('../middleware/auth.js', () => ({
  authMiddleware: (req: Request & { user?: string }, _res: Response, next: NextFunction) => {
    req.user = 'root';
    next();
  },
}));

const express = (await import('express')).default;
const { default: playersRouter } = await import('./players.js');

let server: Server;
let base: string;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/players', playersRouter);
  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', () => resolve());
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

beforeEach(() => {
  h.execCommand.mockReset();
  h.execCommand.mockImplementation(async () => ({ success: true, via: 'plugin' }));
  h.plugin.mockReset();
  h.plugin.mockImplementation(async () => ({ success: false, error: 'Plugin not reachable' }));
  h.recordPunishment.mockClear();
  h.deactivate.mockClear();
  h.closeBanRecords.mockClear();
  for (const fn of [h.banPlayer, h.unbanPlayer, h.addToWhitelist, h.removeFromWhitelist]) {
    fn.mockReset();
    fn.mockImplementation(async () => h.outcome);
  }
});

async function call(method: 'POST' | 'DELETE', route: string, body?: unknown) {
  const res = await fetch(`${base}/api/players${route}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

const sent = () => h.execCommand.mock.calls.map(([command]) => command);

describe('players: kick', () => {
  it('sends /kick with the player only and keeps the reason in the panel', async () => {
    const r = await call('POST', '/Steve/kick', { reason: 'Spam; "caps" & <links>' });
    expect(r.status).toBe(200);
    expect(sent()).toEqual(['/kick Steve']);
    expect(r.body).toMatchObject({ success: true, confirmed: true, reasonStoredOnly: true });
    expect(h.recordPunishment).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'kick', reason: 'Spam; "caps" & <links>' }),
    );
  });

  it('records nothing when the server rejects the kick', async () => {
    h.execCommand.mockImplementation(async () => ({
      success: false,
      via: 'plugin',
      error: 'No such player "Steve".',
    }));
    const r = await call('POST', '/Steve/kick');
    expect(r.status).toBe(500);
    expect(r.body.error).toBe('No such player "Steve".');
    expect(h.recordPunishment).not.toHaveBeenCalled();
  });

  it('says so when the kick only reached the console', async () => {
    h.execCommand.mockImplementation(async () => ({ success: true, via: 'stdin' }));
    const r = await call('POST', '/Steve/kick');
    expect(r.body.confirmed).toBe(false);
    expect(String(r.body.message)).toMatch(/not confirmed/);
  });

  it('bulk kick sends no reason either', async () => {
    const r = await call('POST', '/bulk', {
      names: ['Steve', 'Alex'],
      action: 'kick',
      reason: 'x',
    });
    expect(r.status).toBe(200);
    expect(sent()).toEqual(['/kick Steve', '/kick Alex']);
  });
});

describe('players: mute and private messages', () => {
  it('answers 501 for mute and records nothing', async () => {
    const r = await call('POST', '/Steve/mute', { duration: '10m', reason: 'spam' });
    expect(r.status).toBe(501);
    expect(r.body).toMatchObject({ success: false, unsupported: true });
    expect(sent()).toEqual([]);
    expect(h.recordPunishment).not.toHaveBeenCalled();
  });

  it('unmute only closes the panel records', async () => {
    const r = await call('DELETE', '/Steve/mute');
    expect(r.status).toBe(200);
    expect(sent()).toEqual([]);
    // Unscoped mount: the default server (resolved by the service).
    expect(h.deactivate).toHaveBeenCalledWith('Steve', ['mute', 'tempmute'], 'root', undefined);
  });

  it('answers 501 for a private message', async () => {
    const r = await call('POST', '/Steve/message', { message: 'hi' });
    expect(r.status).toBe(501);
    expect(sent()).toEqual([]);
  });
});

describe('players: actions with the 0.7 syntax', () => {
  it('heals health and stamina when the plugin cannot', async () => {
    const r = await call('POST', '/Steve/heal');
    expect(r.status).toBe(200);
    expect(sent()).toEqual([
      '/player stats settomax Health --player Steve',
      '/player stats settomax Stamina --player Steve',
    ]);
  });

  it('reports a failed heal instead of success', async () => {
    h.execCommand.mockImplementation(async () => ({
      success: false,
      via: 'plugin',
      error: 'No such player "Steve".',
    }));
    const r = await call('POST', '/Steve/heal');
    expect(r.status).toBe(500);
    expect(sent()).toEqual(['/player stats settomax Health --player Steve']);
  });

  it('respawns with the player as argument', async () => {
    await call('POST', '/Steve/respawn');
    expect(sent()).toEqual(['/player respawn Steve']);
  });

  it('applies and clears effects with the player first', async () => {
    await call('POST', '/Steve/effect', { effect: 'burn' });
    await call('POST', '/Steve/effect', { action: 'clear' });
    expect(sent()).toEqual(['/player effect apply Steve burn', '/player effect clear Steve']);
  });

  it('clears an inventory only through the plugin', async () => {
    const failed = await call('POST', '/Steve/inventory/clear');
    expect(failed.status).toBe(502);
    expect(String(failed.body.error)).toMatch(/needs the KyuubiSoft API plugin/);
    expect(sent()).toEqual([]);

    h.plugin.mockImplementation(async () => ({ success: true }));
    const done = await call('POST', '/Steve/inventory/clear');
    expect(done.body).toMatchObject({ success: true, confirmed: true });
  });

  it('does not repeat an action the plugin may still be running', async () => {
    h.plugin.mockImplementation(async () => ({ success: false, maybeRan: true }));
    const r = await call('POST', '/Steve/kill');
    expect(r.status).toBe(504);
    expect(sent()).toEqual([]);
  });
});

describe('players: bans and the whitelist go through the access services', () => {
  it('bans by the access service and records the reason in the panel', async () => {
    const r = await call('POST', '/Steve/ban', { reason: 'Griefing, again "twice"' });
    expect(r.status).toBe(200);
    expect(h.banPlayer).toHaveBeenCalledWith(undefined, 'Steve', 'Griefing, again "twice"');
    expect(sent()).toEqual([]);
    expect(h.recordPunishment).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'ban', reason: 'Griefing, again "twice"' }),
    );
    expect(r.body).toMatchObject({ success: true, confirmed: true });
  });

  it('answers 202 when the ban could not be read back', async () => {
    h.banPlayer.mockImplementation(async () => ({ ...h.outcome, verified: false, via: 'stdin' }));
    const r = await call('POST', '/Steve/ban');
    expect(r.status).toBe(202);
    expect(r.body.confirmed).toBe(false);
  });

  it('passes the access error on and records nothing', async () => {
    h.banPlayer.mockImplementation(async () => {
      throw new h.AccessError(409, '"Bo" matches more than one player', 'ambiguous_player');
    });
    const r = await call('POST', '/Bo/ban');
    expect(r.status).toBe(409);
    expect(r.body).toMatchObject({ success: false, code: 'ambiguous_player' });
    expect(h.recordPunishment).not.toHaveBeenCalled();
  });

  it('unbans by the access service and closes the panel records', async () => {
    const r = await call('DELETE', '/Steve/ban');
    expect(r.status).toBe(200);
    expect(h.unbanPlayer).toHaveBeenCalledWith(undefined, 'Steve');
    expect(h.closeBanRecords).toHaveBeenCalledWith(
      { serverId: undefined, names: ['Steve', 'Steve'], uuid: h.outcome.uuid },
      ['ban', 'tempban'],
      'root',
    );
  });

  it('a permanent ban ends a temp-ban the panel runs, even when the player was banned already', async () => {
    h.banPlayer.mockImplementation(async () => ({ ...h.outcome, changed: false }));
    const r = await call('POST', '/Steve/ban', { reason: 'for good' });
    expect(r.status).toBe(200);
    expect(h.closeBanRecords).toHaveBeenCalledWith(
      { serverId: undefined, names: ['Steve', 'Steve'], uuid: h.outcome.uuid },
      ['tempban'],
      'root',
    );
    expect(h.recordPunishment).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'ban', uuid: h.outcome.uuid }),
    );
  });

  it('warns when the temp-bans of the player could not be closed, and still records the ban', async () => {
    h.closeBanRecords.mockRejectedValueOnce(new Error('database is locked'));
    const r = await call('POST', '/Steve/ban');
    expect(r.status).toBe(200);
    expect(String(r.body.warning)).toMatch(/temporary bans/);
    expect(h.recordPunishment).toHaveBeenCalledWith(expect.objectContaining({ type: 'ban' }));
  });

  it('temp-bans with a plain ban the panel lifts at the end date', async () => {
    h.recordPunishment.mockImplementation(() => ({ expiresAt: '2030-01-01T00:00:00.000Z' }));
    const r = await call('POST', '/Steve/tempban', { duration: '2h', reason: 'spam' });
    expect(r.status).toBe(200);
    // No duration goes to the server: it would end up in the reason.
    expect(h.banPlayer).toHaveBeenCalledWith(undefined, 'Steve', 'spam');
    // By UUID, so the end date lifts the right player even after a rename.
    expect(h.recordPunishment).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'tempban',
        durationMs: 2 * 3600 * 1000,
        uuid: h.outcome.uuid,
      }),
    );
    expect(r.body).toMatchObject({ liftedByPanel: true, expiresAt: '2030-01-01T00:00:00.000Z' });
  });

  it('refuses a temp-ban on a player who is banned already and records nothing', async () => {
    h.banPlayer.mockImplementation(async () => ({ ...h.outcome, changed: false }));
    const r = await call('POST', '/Steve/tempban', { duration: '1m' });
    expect(r.status).toBe(409);
    expect(r.body).toMatchObject({ success: false, code: 'already_banned' });
    expect(String(r.body.error)).toMatch(/banned already/);
    expect(h.recordPunishment).not.toHaveBeenCalled();
  });

  it('does not report a ban that happened as failed when the panel record fails', async () => {
    h.recordPunishment.mockImplementationOnce(() => {
      throw new Error('database is locked');
    });
    const r = await call('POST', '/Steve/tempban', { duration: '2h' });
    expect(r.status).toBe(200);
    expect(r.body.success).toBe(true);
    expect(String(r.body.warning)).toMatch(/lifted by hand/);
  });

  it('adds to and removes from the whitelist by the access service', async () => {
    expect((await call('POST', '/Steve/whitelist')).status).toBe(200);
    expect((await call('DELETE', '/Steve/whitelist')).status).toBe(200);
    expect(h.addToWhitelist).toHaveBeenCalledWith(undefined, 'Steve');
    expect(h.removeFromWhitelist).toHaveBeenCalledWith(undefined, 'Steve');
    expect(sent()).toEqual([]);
  });

  it('bulk ban and unban use the access service too', async () => {
    h.unbanPlayer.mockImplementationOnce(async () => {
      throw new h.AccessError(404, 'Unknown player', 'unknown_player');
    });
    const ban = await call('POST', '/bulk', { names: ['Steve'], action: 'ban', reason: 'x' });
    const unban = await call('POST', '/bulk', { names: ['Ghost', 'Alex'], action: 'unban' });
    expect(h.banPlayer).toHaveBeenCalledWith(undefined, 'Steve', 'x');
    expect(ban.body.summary).toMatchObject({ success: 1, failed: 0 });
    expect(unban.body.results).toEqual([
      { name: 'Ghost', success: false, error: 'Unknown player' },
      { name: 'Alex', success: true },
    ]);
    expect(sent()).toEqual([]);
    // Like the single routes: the ban ends temp-bans, the unban every ban entry; a failed one nothing.
    expect(
      h.closeBanRecords.mock.calls.map((c) => [(c[0] as { names: string[] }).names[0], c[1]]),
    ).toEqual([
      ['Steve', ['tempban']],
      ['Alex', ['ban', 'tempban']],
    ]);
  });
});
