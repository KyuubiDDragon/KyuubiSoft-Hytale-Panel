/**
 * Punishments belong to one server: new entries store the resolved id (the
 * default server for callers without one), lists filter by server, and an
 * unban or unmute on server B leaves the entries of server A alone.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import path from 'path';
import os from 'os';
import fs from 'fs';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kp-punish-per-server-'));
process.env.MANAGER_DATA_PATH = tmpDir;

// The registry: the default server is "a".
vi.mock('./servers.js', () => ({ resolveServerId: async (id?: string) => id ?? 'a' }));

const punishments = await import('./punishments.js');
const { getDb } = await import('../db/index.js');

const STEVE = '0a1b2c3d-0000-4000-8000-0000000000aa';

beforeEach(() => {
  getDb().prepare('DELETE FROM punishments').run();
});

const ban = (serverId: string | undefined, type: 'ban' | 'tempban' | 'mute' = 'ban') =>
  punishments.recordPunishment({
    serverId,
    playerName: 'Steve',
    uuid: STEVE,
    type,
    byUser: 'admin',
    durationMs: type === 'tempban' ? 3_600_000 : null,
  });

describe('punishments per server', () => {
  it('stores the resolved server, also for callers without one', async () => {
    expect((await ban(undefined)).serverId).toBe('a');
    expect((await ban('b')).serverId).toBe('b');
  });

  it('listPunishments({ serverId }) only returns that server; without it every server', async () => {
    await ban('a');
    await ban('b', 'tempban');
    expect(punishments.listPunishments({ serverId: 'a' }).map((p) => p.serverId)).toEqual(['a']);
    expect(punishments.listPunishments({ serverId: 'b' }).map((p) => p.type)).toEqual(['tempban']);
    expect(punishments.listPunishments({ serverId: 'c' })).toEqual([]);
    expect(
      punishments
        .listPunishments()
        .map((p) => p.serverId)
        .sort(),
    ).toEqual(['a', 'b']);
    expect(punishments.getActivePunishments('Steve', 'b').map((p) => p.serverId)).toEqual(['b']);
  });

  it('an unban on B leaves the bans of A active', async () => {
    const onA = await ban('a');
    const tempOnA = await ban('a', 'tempban');
    const onB = await ban('b');
    const closed = await punishments.closeBanRecords(
      { serverId: 'b', names: ['Steve'], uuid: STEVE },
      ['ban', 'tempban'],
      'mod',
    );
    expect(closed).toBe(1);
    expect(punishments.getPunishment(onB.id)?.active).toBe(false);
    expect(punishments.getPunishment(onA.id)?.active).toBe(true);
    expect(punishments.getPunishment(tempOnA.id)?.active).toBe(true);

    // Without an id: the default server (A).
    expect(await punishments.closeBanRecords({ names: ['steve'] }, ['ban', 'tempban'], 'mod')).toBe(
      2,
    );
  });

  it('closing old mute records on B leaves those of A', async () => {
    const muteA = await ban('a', 'mute');
    const muteB = await ban('b', 'mute');
    expect(await punishments.deactivateActiveForPlayer('Steve', ['mute'], 'mod', 'b')).toBe(1);
    expect(punishments.getPunishment(muteB.id)?.active).toBe(false);
    expect(punishments.getPunishment(muteA.id)?.active).toBe(true);
  });
});
