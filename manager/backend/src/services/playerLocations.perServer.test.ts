/**
 * Live positions per server: every plugin frame carries its server, the
 * snapshot and history are read for one server, and a frame without a
 * server (it cannot be placed) is dropped.
 */
import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';

delete process.env.DEMO_MODE;
const h = vi.hoisted(() => ({ deleteHooks: [] as Array<(id: string) => void> }));
vi.mock('./servers.js', () => ({
  COMPOSE_SERVER_ID: 'default',
  onServerDeleted: (hook: (id: string) => void) => {
    h.deleteHooks.push(hook);
    return () => undefined;
  },
}));

const locations = await import('./playerLocations.js');
const { eventBus } = await import('./eventBus.js');

const position = (serverId: string | undefined, playerName: string, x: number) =>
  eventBus.publish('player_position', { playerName, uuid: playerName, x, y: 64, z: 0, serverId });

beforeAll(() => {
  locations.initializePlayerLocations();
  locations.stopPlayerLocations(); // no demo simulation
});

beforeEach(() => {
  for (const id of ['a', 'b']) locations.clearPlayerLocations(id);
});

describe('player locations per server', () => {
  it('keeps the positions of each server apart', () => {
    position('a', 'Alice', 1);
    position('b', 'Bob', 2);
    position(undefined, 'Ghost', 3);
    expect(locations.getLatestSnapshot('a').map((s) => s.playerName)).toEqual(['Alice']);
    expect(locations.getLatestSnapshot('b').map((s) => [s.playerName, s.serverId])).toEqual([
      ['Bob', 'b'],
    ]);
    expect(locations.getHistory({ serverId: 'a' }).map((s) => s.playerName)).toEqual(['Alice']);
  });

  it('tells listeners the server of each sample', () => {
    const seen: string[] = [];
    const off = locations.addListener((s) => seen.push(`${s.serverId}:${s.playerName}`));
    position('b', 'Bob', 5);
    off();
    expect(seen).toEqual(['b:Bob']);
  });

  it('forgets a removed server', () => {
    position('b', 'Bob', 2);
    for (const hook of h.deleteHooks) hook('b');
    expect(locations.getLatestSnapshot('b')).toEqual([]);
  });
});
