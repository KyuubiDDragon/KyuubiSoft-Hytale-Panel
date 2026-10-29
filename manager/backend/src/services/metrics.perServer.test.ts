/**
 * The fleet gauges are read on scrape from what the panel keeps in memory:
 * players online per server and the number of registered servers. A removed
 * server stops reporting, and a scrape asks neither Docker nor a plugin.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import path from 'path';
import os from 'os';
import fs from 'fs';

// Nothing may touch the real data folder, even if a mock were bypassed.
process.env.MANAGER_DATA_PATH = fs.mkdtempSync(path.join(os.tmpdir(), 'kp-metrics-'));

const h = vi.hoisted(() => ({
  servers: [{ id: 'a' }, { id: 'b' }] as Array<{ id: string }>,
  online: { a: ['Alice'], b: ['Bob', 'Carol'] } as Record<string, string[]>,
  failRegistry: false,
}));

vi.mock('./servers.js', () => ({
  listServers: async () => {
    if (h.failRegistry) throw new Error('registry unreadable');
    return h.servers;
  },
}));
vi.mock('./playerPresence.js', () => ({
  onlinePlayers: (serverId: string) => (h.online[serverId] ?? []).map((name) => ({ name })),
}));
// Nothing may reach Docker during a scrape.
vi.mock('./docker.js', () => {
  throw new Error('docker must not be loaded by a metrics scrape');
});

const { exposition } = await import('./metrics.js');

beforeEach(() => {
  h.servers = [{ id: 'a' }, { id: 'b' }];
  h.failRegistry = false;
});

describe('fleet metrics', () => {
  it('reports the players online per server and the server count', async () => {
    const text = await exposition();
    expect(text).toContain('kp_online_players{server="a"} 1');
    expect(text).toContain('kp_online_players{server="b"} 2');
    expect(text).toMatch(/^kp_servers_registered 2$/m);
  });

  it('drops a removed server from the next scrape', async () => {
    await exposition();
    h.servers = [{ id: 'a' }];
    const text = await exposition();
    expect(text).toContain('kp_online_players{server="a"} 1');
    expect(text).not.toContain('server="b"');
    expect(text).toMatch(/^kp_servers_registered 1$/m);
  });

  it('still answers when the registry cannot be read', async () => {
    h.failRegistry = true;
    const text = await exposition();
    expect(text).toContain('kp_http_requests_total');
    expect(text).not.toContain('kp_online_players{');
  });
});
