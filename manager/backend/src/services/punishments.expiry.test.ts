/**
 * Hytale 0.7 bans have no end date, so the panel lifts an expired temp-ban
 * itself: by UUID, and only while the server's ban is still the one the panel
 * issued. A lift that fails for a passing reason is tried again; one that
 * cannot work keeps the ban (now without end date) instead of marking it
 * lifted while the server still bans the player. A permanent ban or an unban
 * closes the panel's temp-bans of that player, on that server only.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import path from 'path';
import os from 'os';
import fs from 'fs';

const tmpDir = path.join(os.tmpdir(), `kp-punish-expiry-${Date.now()}`);
fs.mkdirSync(tmpDir, { recursive: true });
process.env.MANAGER_DATA_PATH = tmpDir;

const h = vi.hoisted(() => {
  class FakeAccessError extends Error {
    constructor(
      readonly status: number,
      message: string,
      readonly code: string,
    ) {
      super(message);
    }
  }
  return {
    FakeAccessError,
    unbanPlayer: vi.fn(async (_serverId: string | undefined, _player: string) => ({})),
    currentBan: vi.fn(
      async (
        _serverId: string | undefined,
        _player: string,
      ): Promise<{ target: string; bannedAt?: string } | null> => null,
    ),
  };
});
const { FakeAccessError } = h;
vi.mock('./accessBans.js', () => ({ unbanPlayer: h.unbanPlayer, currentBan: h.currentBan }));
vi.mock('./accessContext.js', () => ({
  describeAccessError: (error: unknown) =>
    error instanceof h.FakeAccessError
      ? { status: error.status, error: error.message, code: error.code }
      : { status: 500, error: String(error), code: 'internal' },
}));
// The registry: the default server is called "default".
vi.mock('./servers.js', () => ({ resolveServerId: async (id?: string) => id ?? 'default' }));

const punishments = await import('./punishments.js');

const STEVE = '0a1b2c3d-0000-4000-8000-0000000000aa';
const HOUR = 3_600_000;

async function expireAndRun(player: string, uuid: string | null = STEVE) {
  const p = punishments.recordPunishment({
    serverId: 'default',
    playerName: player,
    uuid,
    type: 'tempban',
    reason: 'spam',
    byUser: 'admin',
    durationMs: 1,
  });
  await new Promise((r) => setTimeout(r, 5));
  await runOnce();
  return punishments.getPunishment(p.id)!;
}

/** A fresh loop runs once right away. */
async function runOnce() {
  punishments.stopPunishmentExpiry();
  punishments.startPunishmentExpiry();
  for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
}

/** The server's ban, recorded `offsetMs` from now (the panel's own ban: about now). */
const banAt = (offsetMs: number) => async (_s: string | undefined, player: string) => ({
  target: player,
  bannedAt: new Date(Date.now() + offsetMs).toISOString(),
});

// A braced body: mockReset() returns the mock, which vitest would call as a cleanup hook.
beforeEach(() => {
  h.unbanPlayer.mockReset();
  h.currentBan.mockReset();
  h.currentBan.mockImplementation(banAt(0));
});
afterEach(() => punishments.stopPunishmentExpiry());

describe('punishments: temp-ban expiry', () => {
  it('lifts an expired temp-ban by UUID through the access service', async () => {
    h.unbanPlayer.mockResolvedValue({ verified: true });
    const p = await expireAndRun('Steve');
    expect(h.currentBan).toHaveBeenCalledWith('default', STEVE);
    expect(h.unbanPlayer).toHaveBeenCalledWith('default', STEVE);
    expect(p.active).toBe(false);
  });

  it('goes by name for an entry an older version stored without UUID', async () => {
    h.unbanPlayer.mockResolvedValue({ verified: true });
    await expireAndRun('Oldie', null);
    expect(h.currentBan).toHaveBeenCalledWith('default', 'Oldie');
  });

  it('leaves a ban alone that was issued since, or that was there before', async () => {
    h.currentBan.mockImplementation(banAt(2 * HOUR));
    expect((await expireAndRun('Rebanned')).active).toBe(false);
    h.currentBan.mockImplementation(banAt(-24 * HOUR));
    expect((await expireAndRun('Permanent')).active).toBe(false);
    h.currentBan.mockImplementation(async (_s, player) => ({ target: player }));
    expect((await expireAndRun('Unreadable')).active).toBe(false);
    expect(h.unbanPlayer).not.toHaveBeenCalled();
  });

  it('has nothing to lift once the ban is gone', async () => {
    h.currentBan.mockResolvedValue(null);
    const p = await expireAndRun('Gone');
    expect(h.unbanPlayer).not.toHaveBeenCalled();
    expect(p.active).toBe(false);
  });

  it('tries again later when the server cannot be reached', async () => {
    h.unbanPlayer.mockImplementation(async () => {
      throw new FakeAccessError(503, 'No answer', 'unreachable');
    });
    const p = await expireAndRun('Alex');
    expect(p.active).toBe(true);
    expect(p.expiresAt).not.toBeNull();
    h.currentBan.mockImplementation(async () => {
      throw new FakeAccessError(503, 'Docker', 'docker_unavailable');
    });
    expect((await expireAndRun('Alex2')).expiresAt).not.toBeNull();
  });

  it('does not retry every minute on an error that would come back', async () => {
    h.unbanPlayer.mockImplementation(async () => {
      throw new Error('EACCES: bans.json');
    });
    const p = await expireAndRun('Locked');
    expect(p.active).toBe(true);
    expect(p.expiresAt).toBeNull();
  });

  it('keeps the ban without end date when it cannot be lifted', async () => {
    h.currentBan.mockImplementation(async () => {
      throw new FakeAccessError(404, 'Unknown player', 'unknown_player');
    });
    const p = await expireAndRun('Ghost', null);
    expect(p.active).toBe(true);
    expect(p.expiresAt).toBeNull();
  });

  it('keeps an unban the server did not confirm open, and waits before the next try', async () => {
    // Over the console the panel only knows the line was written; the ban is still there.
    h.unbanPlayer.mockResolvedValue({ via: 'stdin', verified: false, changed: true });
    const p = await expireAndRun('Unsure');
    expect(p).toMatchObject({ active: true, revokedBy: null });
    expect(p.expiresAt).not.toBeNull();
    // The next run comes before the pause is over: no second unban yet.
    await runOnce();
    expect(h.unbanPlayer).toHaveBeenCalledTimes(1);
    expect(punishments.getPunishment(p.id)?.active).toBe(true);
  });

  it('takes an unconfirmed unban as done once the ban is gone', async () => {
    h.unbanPlayer.mockResolvedValue({ via: 'stdin', verified: false, changed: true });
    h.currentBan.mockImplementationOnce(banAt(0)).mockResolvedValueOnce(null);
    expect((await expireAndRun('Slow')).active).toBe(false);
  });

  it('tries a refused unban again later (stopped, the panel lifts it in the file)', async () => {
    h.unbanPlayer.mockRejectedValue(
      new FakeAccessError(400, 'server is not authenticated', 'rejected'),
    );
    const p = await expireAndRun('Offline');
    expect(p.active).toBe(true);
    expect(p.expiresAt).not.toBeNull();
  });
});

describe('punishments: closing the ban entries of a player', () => {
  const tempban = (serverId: string | undefined, playerName: string, uuid?: string) =>
    punishments.recordPunishment({
      serverId,
      playerName,
      uuid,
      type: 'tempban',
      byUser: 'admin',
      durationMs: 7 * 24 * HOUR,
    });

  it('closes them by UUID or name on that server only', async () => {
    const BOB = '0a1b2c3d-0000-4000-8000-0000000000bb';
    const byUuid = tempban('default', 'OldName', BOB);
    const legacy = tempban(undefined, 'bob');
    const elsewhere = tempban('other', 'Bob', BOB);
    const ban = punishments.recordPunishment({
      serverId: 'default',
      playerName: 'Bob',
      type: 'ban',
      byUser: 'admin',
    });

    const closed = await punishments.closeBanRecords(
      { serverId: undefined, names: ['Bob', undefined], uuid: BOB.toUpperCase() },
      ['tempban'],
      'mod',
    );
    expect(closed).toBe(2);
    expect(punishments.getPunishment(byUuid.id)).toMatchObject({ active: false, revokedBy: 'mod' });
    expect(punishments.getPunishment(legacy.id)?.active).toBe(false);
    expect(punishments.getPunishment(elsewhere.id)?.active).toBe(true);
    expect(punishments.getPunishment(ban.id)?.active).toBe(true);

    // An unban closes the permanent entry too.
    await punishments.closeBanRecords(
      { serverId: 'default', names: ['bob'] },
      ['ban', 'tempban'],
      'mod',
    );
    expect(punishments.getPunishment(ban.id)?.active).toBe(false);
  });

  it('does nothing without a name or UUID', async () => {
    expect(await punishments.closeBanRecords({ names: [] }, ['tempban'], 'mod')).toBe(0);
  });
});

describe('punishments: which ban is the panel own', () => {
  const at = '2026-10-28T12:00:00.000Z';
  it('takes a ban from shortly before the entry, not one from long before or after', () => {
    expect(punishments.isOwnBan({ createdAt: at }, '2026-10-28T11:59:58.000Z')).toBe(true);
    expect(punishments.isOwnBan({ createdAt: at }, '2026-10-28T12:00:03.000Z')).toBe(true);
    // A ban later than the entry is a new one (e.g. unban and ban again on the console).
    expect(punishments.isOwnBan({ createdAt: at }, '2026-10-28T12:00:30.000Z')).toBe(false);
    expect(punishments.isOwnBan({ createdAt: at }, '2026-10-28T11:00:00.000Z')).toBe(false);
    expect(punishments.isOwnBan({ createdAt: at }, '2026-10-28T12:05:00.000Z')).toBe(false);
    expect(punishments.isOwnBan({ createdAt: at }, undefined)).toBe(false);
    expect(punishments.isOwnBan({ createdAt: at }, 'not a date')).toBe(false);
  });
});
