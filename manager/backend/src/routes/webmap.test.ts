/**
 * Regression tests for the WebMap proxy: the third-party map must only be
 * reachable with a valid WebMap session of a user holding players.view, and
 * it must always be served sandboxed (opaque origin) without panel cookies.
 * A fake map server stands in for the game container.
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import http, { type IncomingMessage, type Server } from 'http';
import type { AddressInfo } from 'net';
import path from 'path';
import os from 'os';
import fs from 'fs';
import express from 'express';
import { WebSocketServer, WebSocket } from 'ws';

const tmpDir = path.join(os.tmpdir(), `kp-webmap-${Date.now()}`);
fs.mkdirSync(tmpDir, { recursive: true });
process.env.MANAGER_DATA_PATH = tmpDir;
process.env.JWT_SECRET = 'webmap-test-secret-0123456789abcdef0123456789';

// Users/roles are mocked so each test controls rights and token versions.
const permissions = new Map<string, string[]>();
const tokenVersions = new Map<string, number>();
vi.mock('../services/roles.js', () => ({
  getUserPermissions: async (u: string) => permissions.get(u) ?? [],
  getUserPermissionsForServer: async (u: string) => permissions.get(u) ?? [],
  hasPermission: async (u: string, p: string) => {
    const perms = permissions.get(u) ?? [];
    return perms.includes('*') || perms.includes(p);
  },
}));
vi.mock('../services/users.js', () => ({
  getTokenVersion: async (u: string) => tokenVersions.get(u) ?? 1,
  sessionProblem: async (u: string, v?: number) =>
    v !== undefined && v !== (tokenVersions.get(u) ?? 1) ? 'TOKEN_INVALIDATED' : null,
  isKeyOwnerCurrent: async () => true,
  isUserInvalidated: () => false,
  verifyUserCredentials: async () => null,
  updateLastLogin: async () => undefined,
}));
vi.mock('../services/apiKeys.js', () => ({ verifyApiKey: async () => null }));

const {
  createWebMapProxy,
  WEBMAP_PROXY_PREFIX,
  default: webMapRoutes,
} = await import('./webmap.js');
const { createAccessToken } = await import('../services/auth.js');
const sessions = await import('../services/webMapSessions.js');

const MAP_HTML =
  '<!DOCTYPE html><html><head><meta http-equiv="Content-Security-Policy" content="script-src \'self\'">' +
  '<title>Map</title></head><body><script src="js/map.js"></script></body></html>';

let upstream: Server;
let panel: Server;
let panelUrl: string;
let lastUpstreamRequest: IncomingMessage | null = null;

function listen(server: Server): Promise<number> {
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port)),
  );
}

beforeAll(async () => {
  upstream = http.createServer((req, res) => {
    lastUpstreamRequest = req;
    if (req.url === '/') {
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Set-Cookie': 'kp_refresh=attacker; Path=/api/auth',
        'X-Frame-Options': 'DENY',
        'Content-Security-Policy': "default-src 'none'",
      });
      res.end(MAP_HTML);
      return;
    }
    if (req.url === '/api/worlds') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify([{ name: 'default' }]));
      return;
    }
    if (req.url === '/moved') {
      res.writeHead(302, { Location: `http://${req.headers.host}/new/place?x=1` });
      res.end();
      return;
    }
    if (req.url === '/external') {
      res.writeHead(302, { Location: 'https://example.com/docs' });
      res.end();
      return;
    }
    res.writeHead(404);
    res.end();
  });
  const upstreamWss = new WebSocketServer({ server: upstream });
  upstreamWss.on('connection', (socket, req) => socket.send(`hello ${req.url}`));
  const upstreamPort = await listen(upstream);

  const proxy = createWebMapProxy(`http://127.0.0.1:${upstreamPort}`);
  const app = express();
  app.use('/api/webmap', proxy.middleware);
  app.use(express.json());
  app.use('/api/webmap', webMapRoutes);
  panel = http.createServer(app);
  panel.on('upgrade', (req, socket, head) => {
    if ((req.url || '').startsWith(WEBMAP_PROXY_PREFIX))
      void proxy.handleUpgrade(req, socket, head);
    else socket.destroy();
  });
  panelUrl = `http://127.0.0.1:${await listen(panel)}`;
});

afterAll(async () => {
  await new Promise((r) => panel.close(r));
  await new Promise((r) => upstream.close(r));
});

beforeEach(() => {
  permissions.clear();
  tokenVersions.clear();
  lastUpstreamRequest = null;
  vi.restoreAllMocks();
});

async function mintSession(user: string): Promise<{ ticket: string; path: string }> {
  const token = await createAccessToken(user);
  const res = await fetch(`${panelUrl}/api/webmap/session`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
  });
  expect(res.status).toBe(200);
  return (await res.json()) as { ticket: string; path: string };
}

describe('WebMap session endpoint', () => {
  it('requires authentication', async () => {
    const res = await fetch(`${panelUrl}/api/webmap/session`, { method: 'POST' });
    expect(res.status).toBe(401);
  });

  it('requires players.view', async () => {
    permissions.set('bob', ['console.view']);
    const token = await createAccessToken('bob');
    const res = await fetch(`${panelUrl}/api/webmap/session`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(403);
  });

  it('issues a session path for players.view', async () => {
    permissions.set('alice', ['players.view']);
    const session = await mintSession('alice');
    expect(session.ticket).toMatch(/^[a-f0-9]{64}$/);
    expect(session.path).toBe(`${WEBMAP_PROXY_PREFIX}${session.ticket}/`);
    expect((session as { expiresInSeconds?: number }).expiresInSeconds).toBe(
      sessions.WEBMAP_SESSION_MAX_TTL_MS / 1000,
    );
  });
});

describe('WebMap session status (heartbeat)', () => {
  async function status(
    user: string | null,
    ticket: unknown,
  ): Promise<{ code: number; body: Record<string, unknown> | null }> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (user) headers.Authorization = `Bearer ${await createAccessToken(user)}`;
    const res = await fetch(`${panelUrl}/api/webmap/session/status`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ ticket }),
    });
    const text = await res.text();
    return { code: res.status, body: text ? (JSON.parse(text) as Record<string, unknown>) : null };
  }

  it('requires authentication', async () => {
    permissions.set('kim', ['players.view']);
    const { ticket } = await mintSession('kim');
    expect((await status(null, ticket)).code).toBe(401);
  });

  it('rejects malformed tickets', async () => {
    permissions.set('kim', ['players.view']);
    expect((await status('kim', '../../etc')).code).toBe(400);
  });

  it('reports a live session with its hard expiry', async () => {
    permissions.set('kim', ['players.view']);
    const before = Date.now();
    const { ticket } = await mintSession('kim');
    const { code, body } = await status('kim', ticket);
    expect(code).toBe(200);
    expect(body?.valid).toBe(true);
    const expiresAt = Date.parse(String(body?.expiresAt));
    expect(expiresAt).toBeGreaterThanOrEqual(before + sessions.WEBMAP_SESSION_MAX_TTL_MS - 1000);
    expect(expiresAt).toBeLessThanOrEqual(Date.now() + sessions.WEBMAP_SESSION_MAX_TTL_MS);
  });

  it("reports another user's session as expired without revealing it", async () => {
    permissions.set('kim', ['players.view']);
    permissions.set('mallory', ['players.view']);
    const { ticket } = await mintSession('kim');
    expect((await status('mallory', ticket)).body).toEqual({ valid: false, reason: 'expired' });
  });

  it('reports revoked and unknown sessions as expired', async () => {
    permissions.set('kim', ['players.view']);
    const { ticket } = await mintSession('kim');
    sessions.revokeWebMapSession(ticket, 'kim');
    expect((await status('kim', ticket)).body).toEqual({ valid: false, reason: 'expired' });
    expect((await status('kim', 'b'.repeat(64))).body).toEqual({ valid: false, reason: 'expired' });
  });

  it('reports a lost players.view as forbidden', async () => {
    permissions.set('kim', ['players.view']);
    const { ticket } = await mintSession('kim');
    permissions.set('kim', ['console.view']);
    expect((await status('kim', ticket)).body).toEqual({ valid: false, reason: 'forbidden' });
  });

  it('reports a session past its hard maximum as expired', async () => {
    permissions.set('kim', ['players.view']);
    const id = await sessions.createWebMapSession('kim');
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + sessions.WEBMAP_SESSION_MAX_TTL_MS + 1000);
    expect(await sessions.getWebMapSessionStatus(id, 'kim')).toEqual({
      valid: false,
      reason: 'expired',
    });
  });

  it('keeps the session from idling out while the view polls it', async () => {
    permissions.set('kim', ['players.view']);
    const id = await sessions.createWebMapSession('kim');
    const start = Date.now();
    const now = vi.spyOn(Date, 'now');
    // Poll every 10 minutes for 30 minutes: twice the idle timeout.
    for (const minutes of [10, 20, 30]) {
      now.mockReturnValue(start + minutes * 60 * 1000);
      expect((await sessions.getWebMapSessionStatus(id, 'kim')).valid).toBe(true);
    }
  });
});

describe('WebMap proxy access control', () => {
  it('rejects requests without a session', async () => {
    const res = await fetch(`${panelUrl}/api/webmap/t/${'0'.repeat(64)}/`);
    expect(res.status).toBe(401);
    expect(lastUpstreamRequest).toBeNull();
  });

  it('does not proxy the old unauthenticated path', async () => {
    const res = await fetch(`${panelUrl}/api/webmap/`);
    expect(res.status).toBe(404);
    expect(lastUpstreamRequest).toBeNull();
  });

  it('rejects a valid session once the user lost players.view', async () => {
    permissions.set('carol', ['players.view']);
    const { path: mapPath } = await mintSession('carol');
    permissions.set('carol', ['console.view']);
    const res = await fetch(`${panelUrl}${mapPath}`);
    expect(res.status).toBe(403);
    expect(lastUpstreamRequest).toBeNull();
  });

  it('rejects a session after logout (token version changed)', async () => {
    permissions.set('dave', ['players.view']);
    const { path: mapPath } = await mintSession('dave');
    tokenVersions.set('dave', 2);
    const res = await fetch(`${panelUrl}${mapPath}`);
    expect(res.status).toBe(401);
  });

  it('rejects an idle-expired session', async () => {
    permissions.set('erin', ['players.view']);
    const { path: mapPath } = await mintSession('erin');
    const later = Date.now() + sessions.WEBMAP_SESSION_IDLE_TTL_MS + 1000;
    vi.spyOn(Date, 'now').mockReturnValue(later);
    const res = await fetch(`${panelUrl}${mapPath}`);
    expect(res.status).toBe(401);
  });

  it('rejects a revoked session', async () => {
    permissions.set('frank', ['players.view']);
    const { ticket, path: mapPath } = await mintSession('frank');
    const token = await createAccessToken('frank');
    const revoke = await fetch(`${panelUrl}/api/webmap/session/revoke`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ticket }),
    });
    expect(revoke.status).toBe(204);
    expect((await fetch(`${panelUrl}${mapPath}`)).status).toBe(401);
  });

  it("can't revoke another user's session", async () => {
    permissions.set('gina', ['players.view']);
    permissions.set('mallory', ['players.view']);
    const { ticket, path: mapPath } = await mintSession('gina');
    const token = await createAccessToken('mallory');
    await fetch(`${panelUrl}/api/webmap/session/revoke`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ticket }),
    });
    expect((await fetch(`${panelUrl}${mapPath}`)).status).toBe(200);
  });
});

describe('WebMap proxy forwarding', () => {
  it('serves the map sandboxed with the path-rewrite script injected', async () => {
    permissions.set('alice', ['players.view']);
    const { path: mapPath } = await mintSession('alice');
    const res = await fetch(`${panelUrl}${mapPath}`, { headers: { Cookie: 'kp_refresh=secret' } });
    expect(res.status).toBe(200);

    const csp = res.headers.get('content-security-policy') ?? '';
    expect(csp).toContain('sandbox allow-scripts');
    expect(csp).not.toContain('allow-same-origin');
    expect(csp).toContain("frame-ancestors 'self'");
    expect(res.headers.get('x-frame-options')).toBe('SAMEORIGIN');
    expect(res.headers.get('set-cookie')).toBeNull();
    expect(res.headers.get('referrer-policy')).toBe('no-referrer');

    const html = await res.text();
    expect(html).toContain(`var marker = '${WEBMAP_PROXY_PREFIX}'`);
    expect(html).not.toMatch(/http-equiv="Content-Security-Policy"/i);
    expect(html.indexOf('var marker')).toBeLessThan(html.indexOf('<title>'));

    expect(lastUpstreamRequest?.url).toBe('/');
    expect(lastUpstreamRequest?.headers.cookie).toBeUndefined();
  });

  it('forwards API calls under the session prefix without panel credentials', async () => {
    permissions.set('alice', ['players.view']);
    const { path: mapPath } = await mintSession('alice');
    const res = await fetch(`${panelUrl}${mapPath}api/worlds`, {
      headers: { Cookie: 'kp_refresh=secret', Authorization: 'Bearer leaked', Origin: 'null' },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([{ name: 'default' }]);
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
    expect(res.headers.get('content-security-policy')).toContain('sandbox allow-scripts');
    expect(lastUpstreamRequest?.url).toBe('/api/worlds');
    expect(lastUpstreamRequest?.headers.cookie).toBeUndefined();
    expect(lastUpstreamRequest?.headers.authorization).toBeUndefined();
  });

  it('answers CORS preflights for valid sessions', async () => {
    permissions.set('alice', ['players.view']);
    const { path: mapPath } = await mintSession('alice');
    const res = await fetch(`${panelUrl}${mapPath}api/tiles/batch`, {
      method: 'OPTIONS',
      headers: { Origin: 'null', 'Access-Control-Request-Method': 'POST' },
    });
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
    expect(res.headers.get('access-control-allow-headers')).toContain('Content-Type');
  });

  it('redirects the bare session path to its trailing-slash form', async () => {
    permissions.set('alice', ['players.view']);
    const { ticket } = await mintSession('alice');
    const res = await fetch(`${panelUrl}${WEBMAP_PROXY_PREFIX}${ticket}`, { redirect: 'manual' });
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe(`${WEBMAP_PROXY_PREFIX}${ticket}/`);
  });

  it('keeps upstream redirects under the session prefix', async () => {
    permissions.set('alice', ['players.view']);
    const { path: mapPath } = await mintSession('alice');
    const moved = await fetch(`${panelUrl}${mapPath}moved`, { redirect: 'manual' });
    expect(moved.headers.get('location')).toBe(`${mapPath}new/place?x=1`);
    const external = await fetch(`${panelUrl}${mapPath}external`, { redirect: 'manual' });
    expect(external.headers.get('location')).toBe('https://example.com/docs');
  });

  it('only forwards read methods and tile POSTs', async () => {
    permissions.set('alice', ['players.view']);
    const { path: mapPath } = await mintSession('alice');
    const res = await fetch(`${panelUrl}${mapPath}api/worlds`, { method: 'PUT', body: '{}' });
    expect(res.status).toBe(405);
    expect(lastUpstreamRequest).toBeNull();
  });
});

describe('WebMap WebSocket proxy', () => {
  function connect(url: string): Promise<{ message?: string; status?: number }> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      ws.on('message', (data) => {
        resolve({ message: data.toString() });
        ws.close();
      });
      ws.on('unexpected-response', (_req, res) => resolve({ status: res.statusCode }));
      ws.on('error', (err) => reject(err));
    });
  }

  it('proxies an authorized upgrade to the map /ws endpoint', async () => {
    permissions.set('alice', ['players.view']);
    const { path: mapPath } = await mintSession('alice');
    const result = await connect(`${panelUrl.replace('http', 'ws')}${mapPath}ws`);
    expect(result.message).toBe('hello /ws');
  });

  it('refuses an upgrade without a valid session', async () => {
    const result = await connect(
      `${panelUrl.replace('http', 'ws')}${WEBMAP_PROXY_PREFIX}${'a'.repeat(64)}/ws`,
    );
    expect(result.status).toBe(401);
  });

  it('refuses an upgrade when the user lacks players.view', async () => {
    permissions.set('carol', ['players.view']);
    const { path: mapPath } = await mintSession('carol');
    permissions.set('carol', []);
    const result = await connect(`${panelUrl.replace('http', 'ws')}${mapPath}ws`);
    expect(result.status).toBe(403);
  });

  it('closes an open map socket when its session is revoked', async () => {
    permissions.set('jade', ['players.view']);
    const { ticket, path: mapPath } = await mintSession('jade');
    const ws = new WebSocket(`${panelUrl.replace('http', 'ws')}${mapPath}ws`);
    await new Promise((resolve) => ws.once('message', resolve));
    const closed = new Promise((resolve) => ws.once('close', resolve));
    expect(sessions.revokeWebMapSession(ticket, 'jade')).toBe(true);
    await closed;
    expect(ws.readyState).toBe(WebSocket.CLOSED);
  });
});

describe('WebMap session lifetime', () => {
  it('expires after the hard maximum even while used', async () => {
    permissions.set('hank', ['players.view']);
    const id = await sessions.createWebMapSession('hank');
    const release = sessions.trackWebMapSocket(id, () => {});
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + sessions.WEBMAP_SESSION_MAX_TTL_MS + 1000);
    expect((await sessions.checkWebMapSession(id)).ok).toBe(false);
    release();
  });

  it('does not idle out while a map WebSocket is open', async () => {
    permissions.set('ivy', ['players.view']);
    const id = await sessions.createWebMapSession('ivy');
    const release = sessions.trackWebMapSocket(id, () => {});
    const start = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(start + sessions.WEBMAP_SESSION_IDLE_TTL_MS + 1000);
    expect((await sessions.checkWebMapSession(id)).ok).toBe(true);
    release();
  });

  it('rejects malformed session ids', async () => {
    expect(await sessions.checkWebMapSession('../../etc')).toMatchObject({
      ok: false,
      status: 401,
    });
  });
});
