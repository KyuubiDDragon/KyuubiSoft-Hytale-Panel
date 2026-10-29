/**
 * The live positions socket streams one server: the named one (path or
 * query, with a ticket for it) or the default server. The server is checked
 * after authentication, the multiserver switch applies, an API key must cover
 * the server, and a key revoked meanwhile closes the socket on the next ping.
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import http, { type Server } from 'http';
import type { AddressInfo } from 'net';
import { WebSocketServer, WebSocket } from 'ws';

type Sample = { serverId: string; playerName: string };
const h = vi.hoisted(() => ({
  multiserver: true,
  // ticket id -> what it was issued for
  tickets: new Map<
    string,
    { username: string; serverId?: string; apiKeyId?: string; apiKeyServerIds?: string[] }
  >(),
  keys: new Map<string, { scopes: string[]; serverIds: string[] | null }>(),
  servers: { default: 'compose', b: 'managed' } as Record<string, 'compose' | 'managed'>,
  listeners: new Set<(s: Sample) => void>(),
  samples: [] as Sample[],
}));

vi.mock('./config.js', () => ({
  config: {
    get multiserverEnabled() {
      return h.multiserver;
    },
  },
}));
vi.mock('./services/auth.js', () => ({
  verifyWsTicket: (id: string, expected?: string) => {
    const t = h.tickets.get(id);
    h.tickets.delete(id);
    if (!t || t.serverId !== expected) return { valid: false };
    return {
      valid: true,
      username: t.username,
      apiKeyId: t.apiKeyId,
      apiKeyScopes: t.apiKeyId ? h.keys.get(t.apiKeyId)?.scopes : undefined,
      apiKeyServerIds: t.apiKeyServerIds,
    };
  },
  verifyToken: () => null,
}));
vi.mock('./services/roles.js', () => ({ hasPermission: async () => true }));
vi.mock('./services/commandPolicy.js', () => ({
  scopeAllows: (scopes: string[] | undefined, p: string) => !scopes || scopes.includes(p),
}));
vi.mock('./services/apiKeys.js', () => ({
  getActiveApiKeyGrant: (id: string) => {
    const key = h.keys.get(id);
    return key ? { id, scopes: key.scopes, serverIds: key.serverIds } : null;
  },
}));
vi.mock('./services/servers.js', () => ({ resolveServerId: async () => 'default' }));
vi.mock('./services/serverContext.js', () => {
  class UnknownServerError extends Error {}
  return {
    UnknownServerError,
    getServerContext: async (id: string) => {
      const kind = h.servers[id];
      if (!kind) throw new UnknownServerError(id);
      return { id, kind };
    },
  };
});
vi.mock('./services/playerLocations.js', () => ({
  getLatestSnapshot: (serverId: string) => h.samples.filter((s) => s.serverId === serverId),
  addListener: (l: (s: Sample) => void) => {
    h.listeners.add(l);
    return () => h.listeners.delete(l);
  },
}));

const { setupLocationsSocket, isLocationsSocketPath } = await import('./locationsSocket.js');

let server: Server;
let base: string;

beforeAll(async () => {
  const wss = new WebSocketServer({ noServer: true });
  setupLocationsSocket(wss, { heartbeatMs: 60 });
  server = http.createServer();
  server.on('upgrade', (req, socket, head) => {
    if (!isLocationsSocketPath((req.url || '').split('?')[0])) {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  base = `ws://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise((r) => server.close(r));
});

beforeEach(() => {
  h.multiserver = true;
  h.tickets.clear();
  h.keys.clear();
  h.samples = [
    { serverId: 'default', playerName: 'Alice' },
    { serverId: 'b', playerName: 'Bob' },
  ];
});

let ticketNo = 0;
function ticket(serverId?: string, key?: { id: string; serverIds?: string[] }): string {
  const id = `t${++ticketNo}`;
  h.tickets.set(id, {
    username: 'kim',
    serverId,
    apiKeyId: key?.id,
    apiKeyServerIds: key?.serverIds,
  });
  return id;
}

/** Frames until `count` arrived or the socket closed. */
function open(path: string, count = 1): Promise<{ frames: unknown[]; closed?: number }> {
  return new Promise((resolve) => {
    const frames: unknown[] = [];
    const ws = new WebSocket(base + path);
    const timer = setTimeout(() => {
      ws.close();
      resolve({ frames });
    }, 2000);
    ws.on('message', (data) => {
      frames.push(JSON.parse(String(data)));
      if (frames.length >= count) {
        clearTimeout(timer);
        ws.close();
        resolve({ frames });
      }
    });
    ws.on('close', (code) => {
      clearTimeout(timer);
      resolve({ frames, closed: code });
    });
  });
}

describe('locations socket', () => {
  it("streams the named server's positions only, with a ticket for it", async () => {
    const ws = new WebSocket(`${base}/api/servers/b/players/locations/ws?ticket=${ticket('b')}`);
    const frames: Array<{ type: string; samples?: Sample[]; sample?: Sample }> = [];
    await new Promise<void>((resolve) => {
      ws.on('message', (data) => {
        frames.push(JSON.parse(String(data)));
        if (frames.length === 1) {
          for (const l of h.listeners) l({ serverId: 'default', playerName: 'Alice' });
          for (const l of h.listeners) l({ serverId: 'b', playerName: 'Bob' });
        }
        if (frames.length === 2) resolve();
      });
    });
    ws.close();
    expect(frames[0]).toEqual({
      type: 'snapshot',
      samples: [{ serverId: 'b', playerName: 'Bob' }],
    });
    expect(frames[1]).toEqual({ type: 'sample', sample: { serverId: 'b', playerName: 'Bob' } });
  });

  it('serves the default server on the legacy path, and ?serverId= like the scoped path', async () => {
    const legacy = await open(`/api/players/locations/ws?ticket=${ticket()}`);
    expect(legacy.frames[0]).toMatchObject({ samples: [{ playerName: 'Alice' }] });
    const query = await open(`/api/players/locations/ws?serverId=b&ticket=${ticket('b')}`);
    expect(query.frames[0]).toMatchObject({ samples: [{ playerName: 'Bob' }] });
    // A ticket without a server does not open a named server's stream.
    expect((await open(`/api/players/locations/ws?serverId=b&ticket=${ticket()}`)).closed).toBe(
      4001,
    );
  });

  it('checks the server only after authentication', async () => {
    expect((await open('/api/servers/zzz/players/locations/ws')).closed).toBe(4001);
    expect(
      (await open(`/api/servers/zzz/players/locations/ws?ticket=${ticket('zzz')}`)).closed,
    ).toBe(4004);
  });

  it('refuses additional servers while multiserver is off', async () => {
    h.multiserver = false;
    expect((await open(`/api/servers/b/players/locations/ws?ticket=${ticket('b')}`)).closed).toBe(
      4003,
    );
    expect(
      (await open(`/api/servers/default/players/locations/ws?ticket=${ticket('default')}`))
        .frames[0],
    ).toMatchObject({ type: 'snapshot' });
  });

  it('needs an API key that covers the server', async () => {
    h.keys.set('k1', { scopes: ['players.view'], serverIds: ['default'] });
    const r = await open(
      `/api/servers/b/players/locations/ws?ticket=${ticket('b', { id: 'k1', serverIds: ['default'] })}`,
    );
    expect(r.closed).toBe(4003);
  });

  it('closes the socket on the next ping once the key was revoked', async () => {
    h.keys.set('k2', { scopes: ['players.view'], serverIds: null });
    const ws = new WebSocket(
      `${base}/api/servers/b/players/locations/ws?ticket=${ticket('b', { id: 'k2' })}`,
    );
    await new Promise((r) => ws.once('message', r));
    h.keys.delete('k2');
    const code = await new Promise<number>((r) => ws.once('close', (c) => r(c)));
    expect(code).toBe(4003);
  });
});
