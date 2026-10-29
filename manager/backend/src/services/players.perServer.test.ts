/**
 * Every server keeps its own player list (players.json in its server folder):
 * sessions, playtime and the online flags of one server never change another
 * one's, and a stop of server B leaves the players online on A.
 */
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import path from 'path';
import os from 'os';
import fs from 'fs';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kp-players-per-server-'));
const folderOf = (id: string) => path.join(root, id);

vi.mock('./servers.js', () => ({
  resolveServerId: async (id?: string) => id ?? 'a',
  listServers: async () => [{ id: 'a' }, { id: 'b' }],
  onServerDeleted: () => () => undefined,
}));
vi.mock('./perServerData.js', () => ({
  serverFolders: async (id?: string) => {
    const resolved = id ?? 'a';
    if (resolved === 'gone') throw new Error('Unknown server id: gone');
    return { id: resolved, name: resolved, server: folderOf(resolved), data: folderOf(resolved) };
  },
}));
// The plugin is not reachable: the online list comes from the panel's own tracking.
vi.mock('./kyuubiApi.js', () => ({ isPluginRunning: async () => false }));
vi.mock('./playerPresence.js', () => ({ isWatching: () => false, onlinePlayers: () => [] }));

const players = await import('./players.js');

const ALICE = '0a1b2c3d-0000-4000-8000-0000000000a1';
const BOB = '0a1b2c3d-0000-4000-8000-0000000000b0';

function writeUniversePlayer(serverId: string, uuid: string, name: string): void {
  const dir = path.join(folderOf(serverId), 'universe', 'players');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, `${uuid}.json`),
    JSON.stringify({ Components: { Nameplate: { Text: name } } }),
  );
}

beforeAll(() => {
  for (const id of ['a', 'b']) fs.mkdirSync(folderOf(id), { recursive: true });
});

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

const online = async (serverId: string) =>
  (await players.getAllPlayers(serverId)).filter((p) => p.online).map((p) => p.name);

describe('players: one list per server', () => {
  it('a stop of server B leaves the players of server A online', async () => {
    players.notePlayerOnline('a', 'Alice', { uuid: ALICE });
    players.notePlayerOnline('b', 'Bobby', { uuid: BOB });
    await vi.waitFor(async () => expect(await online('a')).toEqual(['Alice']));
    expect(await online('b')).toEqual(['Bobby']);

    await players.clearOnlinePlayers('b');

    expect(await online('b')).toEqual([]);
    expect(await online('a')).toEqual(['Alice']);
    expect(await players.getPlayerCount('a')).toBe(1);
    expect(await players.getPlayerCount('b')).toBe(0);
  });

  it('keeps sessions apart: a player known on A is unknown on B', async () => {
    expect((await players.getAllPlayers('a')).map((p) => p.name)).toContain('Alice');
    expect((await players.getAllPlayers('b')).map((p) => p.name)).not.toContain('Alice');
    // Without an id: the default server (here A).
    expect((await players.getAllPlayers()).map((p) => p.name)).toContain('Alice');
  });

  it("writes each server's players.json into its own folder", async () => {
    await vi.waitFor(
      () => {
        const a = JSON.parse(fs.readFileSync(path.join(folderOf('a'), 'players.json'), 'utf-8'));
        const b = JSON.parse(fs.readFileSync(path.join(folderOf('b'), 'players.json'), 'utf-8'));
        expect(a.map((p: { name: string }) => p.name)).toEqual(['Alice']);
        expect(b.map((p: { name: string }) => p.name)).toEqual(['Bobby']);
      },
      { timeout: 4000 },
    );
  });

  it("reads the saved players from the server's own universe", async () => {
    writeUniversePlayer('a', ALICE, 'Alice');
    writeUniversePlayer('b', BOB, 'Bobby');
    expect((await players.getAllPlayerFiles('a')).map((p) => p.name)).toEqual(['Alice']);
    expect((await players.getAllPlayerFiles('b')).map((p) => p.name)).toEqual(['Bobby']);
    const unified = await players.getAllPlayersUnified('b');
    expect(unified.map((p) => p.name)).toEqual(['Bobby']);
  });

  it('moves a players.json that is not valid JSON aside instead of overwriting it', async () => {
    fs.mkdirSync(folderOf('c'), { recursive: true });
    fs.writeFileSync(path.join(folderOf('c'), 'players.json'), '{ not json');
    expect(await players.getAllPlayers('c')).toEqual([]);
    const names = fs.readdirSync(folderOf('c'));
    expect(names.some((n) => n.startsWith('players.json.corrupt-'))).toBe(true);
  });

  it('never writes a list it could not load', async () => {
    players.notePlayerOnline('gone', 'Zed');
    await new Promise((r) => setTimeout(r, 1500)); // past the save debounce
    expect(fs.readdirSync(root).sort()).toEqual(['a', 'b', 'c']);
  });

  it('a leave on one server ends only the session there', async () => {
    players.notePlayerOnline('b', 'Alice', { uuid: ALICE });
    await vi.waitFor(async () => expect(await online('b')).toEqual(['Alice']));
    players.notePlayerOffline('b', 'Alice');
    await vi.waitFor(async () => expect(await online('b')).toEqual([]));
    expect(await online('a')).toEqual(['Alice']);
  });
});
