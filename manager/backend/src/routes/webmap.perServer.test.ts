/**
 * The WebMap proxy per server: a map session belongs to one server, its HTTP
 * requests and WebSocket go to that server's map, the right is checked on
 * that server, and a session of a removed server stops working.
 */
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import http, { type Server } from 'http';
import type { AddressInfo } from 'net';
import path from 'path';
import os from 'os';
import fs from 'fs';
import express from 'express';
import { WebSocketServer, WebSocket } from 'ws';

process.env.MANAGER_DATA_PATH = fs.mkdtempSync(path.join(os.tmpdir(), 'kp-webmap-servers-'));

const h = vi.hoisted(() => ({
  servers: new Set(['a', 'b']),
  rightOn: new Set(['a', 'b']),
  checkedOn: [] as Array<string | undefined>,
}));
vi.mock('../services/roles.js', () => ({
  hasPermission: async (_u: string, _p: string, serverId?: string) => {
    h.checkedOn.push(serverId);
    return serverId !== undefined && h.rightOn.has(serverId);
  },
}));
vi.mock('../services/users.js', () => ({
  getTokenVersion: async () => 1,
  sessionProblem: async () => null,
  isKeyOwnerCurrent: async () => true,
  isUserInvalidated: () => false,
}));
// The default server is "a".
vi.mock('../services/servers.js', () => ({
  resolveServerId: async (id?: string) => id ?? 'a',
  getServer: async (id: string) => (h.servers.has(id) ? { id } : null),
}));

const { createWebMapProxy, WEBMAP_PROXY_PREFIX } = await import('./webmap.js');
const sessions = await import('../services/webMapSessions.js');

const upstreams: Record<string, Server> = {};
const ports: Record<string, number> = {};
let panel: Server;
let panelUrl: string;

function listen(server: Server): Promise<number> {
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port)),
  );
}

beforeAll(async () => {
  for (const id of ['a', 'b']) {
    const upstream = http.createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ map: id, url: req.url }));
    });
    new WebSocketServer({ server: upstream }).on('connection', (socket) =>
      socket.send(`map ${id}`),
    );
    upstreams[id] = upstream;
    ports[id] = await listen(upstream);
  }
  const proxy = createWebMapProxy(async (serverId) => {
    if (!ports[serverId]) throw new Error(`no map for ${serverId}`);
    return `http://127.0.0.1:${ports[serverId]}`;
  });
  const app = express();
  app.use('/api/webmap', proxy.middleware);
  panel = http.createServer(app);
  panel.on('upgrade', (req, socket, head) => void proxy.handleUpgrade(req, socket, head));
  panelUrl = `http://127.0.0.1:${await listen(panel)}`;
});

afterAll(async () => {
  await new Promise((r) => panel.close(r));
  for (const upstream of Object.values(upstreams)) await new Promise((r) => upstream.close(r));
});

const get = (ticket: string, rest = 'api/worlds') =>
  fetch(`${panelUrl}${WEBMAP_PROXY_PREFIX}${ticket}/${rest}`);

describe('webmap per server', () => {
  it("sends a session's requests to its server's map; without a server to the default one", async () => {
    const forB = await sessions.createWebMapSession('kim', 'b');
    const forDefault = await sessions.createWebMapSession('kim');
    expect(await (await get(forB)).json()).toEqual({ map: 'b', url: '/api/worlds' });
    expect(await (await get(forDefault)).json()).toEqual({ map: 'a', url: '/api/worlds' });
  });

  it("opens the map WebSocket of the session's server", async () => {
    const ticket = await sessions.createWebMapSession('kim', 'b');
    const ws = new WebSocket(`${panelUrl.replace('http', 'ws')}${WEBMAP_PROXY_PREFIX}${ticket}/ws`);
    const first = await new Promise<string>((resolve, reject) => {
      ws.once('message', (data) => resolve(String(data)));
      ws.once('error', reject);
    });
    ws.close();
    expect(first).toBe('map b');
  });

  it('checks players.view on the session’s server', async () => {
    const ticket = await sessions.createWebMapSession('kim', 'b');
    h.checkedOn.length = 0;
    h.rightOn.delete('b');
    try {
      expect((await get(ticket)).status).toBe(403);
      expect(h.checkedOn).toEqual(['b']);
    } finally {
      h.rightOn.add('b');
    }
  });

  it('ends the sessions of a removed server', async () => {
    const ticket = await sessions.createWebMapSession('kim', 'b');
    h.servers.delete('b');
    try {
      expect((await get(ticket)).status).toBe(401);
    } finally {
      h.servers.add('b');
    }
  });
});
