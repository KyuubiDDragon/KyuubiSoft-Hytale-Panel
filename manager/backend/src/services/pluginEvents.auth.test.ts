import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import path from 'path';
import os from 'os';
import fs from 'fs';
import http from 'http';
import type { AddressInfo } from 'net';
import { WebSocketServer } from 'ws';

const tmpDir = path.join(os.tmpdir(), `kp-pluginevents-auth-${Date.now()}`);
fs.mkdirSync(tmpDir, { recursive: true });
process.env.MANAGER_DATA_PATH = tmpDir;
delete process.env.DEMO_MODE;

// A plugin stand-in that accepts upgrades and records their headers.
const upgradeHeaders: http.IncomingHttpHeaders[] = [];
let wss: WebSocketServer;

// A plugin 2.0 stand-in with the wrong token: refuses every upgrade with 401.
let refusals = 0;
const refusing = http.createServer();
refusing.on('upgrade', (_req, socket) => {
  refusals++;
  socket.end('HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\nConnection: close\r\n\r\n');
});

function server(id: string, port: number) {
  return {
    id,
    name: id,
    containerName: '127.0.0.1',
    status: 'ready',
    network: { serverPort: 5520, webMapPort: 18081, webMapWsPort: 18082, pluginPort: port },
    paths: {
      server: '/tmp/s',
      data: '/tmp/d',
      backups: '/tmp/b',
      mods: '/tmp/m',
      plugins: '/tmp/p',
      assets: '/tmp/a',
      auth: '/tmp/au',
    },
    createdAt: new Date().toISOString(),
    createdBy: 'system',
  };
}

type PluginEvents = typeof import('./pluginEvents.js');
let events: PluginEvents;
let tokenFor: (id: string) => Promise<string>;

beforeAll(async () => {
  await new Promise<void>((resolve) => {
    wss = new WebSocketServer({ port: 0, host: '127.0.0.1' }, () => resolve());
  });
  wss.on('headers', (_headers, req) => {
    upgradeHeaders.push(req.headers);
  });
  await new Promise<void>((resolve) => refusing.listen(0, '127.0.0.1', () => resolve()));
  const okPort = (wss.address() as AddressInfo).port;
  const refusingPort = (refusing.address() as AddressInfo).port;
  fs.writeFileSync(
    path.join(tmpDir, 'servers.json'),
    JSON.stringify({
      schemaVersion: 1,
      defaultId: 'ok',
      servers: [server('ok', okPort), server('stale', refusingPort)],
    }),
  );
  events = await import('./pluginEvents.js');
  ({ getPluginToken: tokenFor } = await import('./pluginAuth.js'));
});

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  events.disconnectAll();
  await new Promise<void>((resolve) => wss.close(() => resolve()));
  await new Promise<void>((resolve) => refusing.close(() => resolve()));
});

async function waitFor(check: () => boolean, ms = 3000): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > ms) throw new Error('timed out');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

describe('plugin WebSocket auth', () => {
  it('sends the server token as a bearer header on the upgrade request', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    await events.connect('ok');
    await waitFor(() => events.isConnectedToPlugin('ok'));

    expect(upgradeHeaders).toHaveLength(1);
    expect(upgradeHeaders[0].authorization).toBe(`Bearer ${await tokenFor('ok')}`);
    events.disconnect('ok');
  });

  it('logs a token hint once for a refused handshake instead of a generic error', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});

    await events.connect('stale');
    await waitFor(() => refusals >= 1 && warn.mock.calls.length >= 1);
    // A second refused attempt (as on reconnect) must not repeat the hint.
    await events.connect('stale');
    await waitFor(() => refusals >= 2);
    await new Promise((resolve) => setTimeout(resolve, 50));
    events.disconnect('stale');

    const hints = warn.mock.calls.map((c) => String(c[0])).filter((m) => m.includes('HTTP 401'));
    expect(hints).toHaveLength(1);
    expect(hints[0]).toMatch(/Restart the server/);
    expect(error).not.toHaveBeenCalled();
    expect(events.isConnectedToPlugin('stale')).toBe(false);
  });

  it('reads the status code from the ws handshake error', () => {
    expect(events.refusedHandshakeStatus(new Error('Unexpected server response: 401'))).toBe(401);
    expect(events.refusedHandshakeStatus(new Error('connect ECONNREFUSED 127.0.0.1:1'))).toBeNull();
  });
});
