/**
 * The console WebSocket against a real ws server: commands sent before the
 * socket is authenticated, sockets that leave during that time, heartbeat,
 * revoked rights, a slow reader and the command rate limit. Auth, rights,
 * the log stream and command execution are stubbed.
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import http from 'http';
import type { AddressInfo } from 'net';
import { WebSocket, WebSocketServer, type ClientOptions } from 'ws';
import type { AssembledLogEntry } from './services/logs.js';

interface Sub {
  serverId: string;
  listener: {
    onHistory(entries: AssembledLogEntry[], truncated: boolean): void;
    onEntries(entries: AssembledLogEntry[]): void;
  };
  off: boolean;
}

const h = vi.hoisted(() => ({
  subs: [] as Sub[],
  allowed: true,
  permissionDelayMs: 0,
  execCommand: vi.fn(),
}));

vi.mock('./services/auth.js', () => ({
  verifyWsTicket: (ticket: string) =>
    ticket.startsWith('ok') ? { valid: true, username: 'alice' } : { valid: false },
  verifyToken: () => null,
}));
vi.mock('./services/roles.js', () => ({
  hasPermission: async () => {
    if (h.permissionDelayMs) await new Promise((r) => setTimeout(r, h.permissionDelayMs));
    return h.allowed;
  },
}));
vi.mock('./services/commandPolicy.js', () => ({
  authorizeCommand: async () => ({ allowed: true }),
  scopeAllows: () => true,
}));
vi.mock('./services/docker.js', () => ({ execCommand: h.execCommand }));
vi.mock('./services/servers.js', () => ({
  getDefaultId: async () => 'default',
  getServer: async (id: string) => (id === 'default' ? { id } : null),
}));
vi.mock('./services/serverLogStream.js', () => ({
  subscribeServerLogWithHistory: (serverId: string, _opts: unknown, listener: Sub['listener']) => {
    const sub: Sub = { serverId, listener, off: false };
    h.subs.push(sub);
    return () => {
      sub.off = true;
    };
  },
}));
vi.mock('./services/playerPresence.js', () => ({ onPresenceChange: () => () => undefined }));

const { setupWebSocket } = await import('./websocket.js');

const HEARTBEAT_MS = 150;
let server: http.Server;
let wss: WebSocketServer;
let url: string;

beforeAll(async () => {
  server = http.createServer();
  wss = new WebSocketServer({ server });
  setupWebSocket(wss, { heartbeatMs: HEARTBEAT_MS });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  url = `ws://127.0.0.1:${(server.address() as AddressInfo).port}/api/console/ws?ticket=ok`;
});

afterAll(async () => {
  for (const c of wss.clients) c.terminate();
  await new Promise<void>((r) => wss.close(() => r()));
  await new Promise<void>((r) => server.close(() => r()));
});

beforeEach(() => {
  h.subs = [];
  h.allowed = true;
  h.permissionDelayMs = 0;
  h.execCommand.mockReset();
  h.execCommand.mockImplementation(async (command: string) => ({
    success: true,
    via: 'plugin',
    status: 'DONE',
    lines: [`ran ${command}`],
  }));
});

interface Client {
  ws: WebSocket;
  messages: Array<Record<string, unknown>>;
  closed: Promise<number>;
}

function open(options: ClientOptions = {}): Promise<Client> {
  const ws = new WebSocket(url, options);
  const messages: Array<Record<string, unknown>> = [];
  ws.on('message', (data) => messages.push(JSON.parse(data.toString())));
  const closed = new Promise<number>((r) => ws.on('close', (code) => r(code)));
  return new Promise((resolve, reject) => {
    ws.once('open', () => resolve({ ws, messages, closed }));
    ws.once('error', reject);
  });
}

function entry(message: string): AssembledLogEntry {
  return {
    entry: { timestamp: '2026-10-28T10:00:00.000Z', level: 'INFO', message },
    cursor: 1n,
    stream: 'stdout',
    clean: true,
  };
}

const of = (c: Client, type: string) => c.messages.filter((m) => m.type === type);

describe('console WebSocket', () => {
  it('runs a command sent right at open once the socket is authenticated', async () => {
    h.permissionDelayMs = 80;
    const ws = new WebSocket(url);
    const messages: Array<Record<string, unknown>> = [];
    ws.on('message', (d) => messages.push(JSON.parse(d.toString())));
    await new Promise<void>((r) =>
      ws.once('open', () => {
        ws.send(JSON.stringify({ type: 'command', payload: '/who', requestId: 'r1' }));
        r();
      }),
    );
    await vi.waitFor(() =>
      expect(messages.find((m) => m.type === 'command_response')).toMatchObject({
        requestId: 'r1',
        command: '/who',
        success: true,
        lines: ['ran /who'],
      }),
    );
    expect(h.execCommand).toHaveBeenCalledTimes(1);
    ws.close();
  });

  it('never subscribes a socket that closed while it was being authenticated', async () => {
    h.permissionDelayMs = 80;
    const c = await open();
    c.ws.close();
    await c.closed;
    await new Promise((r) => setTimeout(r, 150));
    expect(h.subs).toEqual([]);
  });

  it('gives each console the history and the live log, and unsubscribes on close', async () => {
    const [a, b] = await Promise.all([open(), open()]);
    await vi.waitFor(() => expect(h.subs).toHaveLength(2));
    for (const sub of h.subs) {
      sub.listener.onHistory([entry('old')], true);
      sub.listener.onEntries([entry('new')]);
    }
    for (const c of [a, b]) {
      await vi.waitFor(() => expect(of(c, 'log_batch')).toHaveLength(2));
      expect(of(c, 'log_batch')[0]).toMatchObject({
        history: true,
        truncated: true,
        entries: [{ message: 'old', stream: 'stdout', cursor: '1' }],
      });
    }
    a.ws.close();
    await a.closed;
    await vi.waitFor(() => expect(h.subs.filter((s) => s.off)).toHaveLength(1));
    b.ws.close();
    await vi.waitFor(() => expect(h.subs.every((s) => s.off)).toBe(true));
  });

  it('closes a console that does not answer pings and keeps the ones that do', async () => {
    const dead = await open({ autoPong: false });
    const alive = await open();
    await dead.closed;
    expect(alive.ws.readyState).toBe(WebSocket.OPEN);
    alive.ws.close();
  });

  it('closes a console whose user lost console.view', async () => {
    const c = await open();
    await vi.waitFor(() => expect(h.subs).toHaveLength(1));
    h.allowed = false;
    expect(await c.closed).toBe(4003);
  });

  it('holds log batches back while the socket is behind and says how many it missed', async () => {
    const c = await open();
    await vi.waitFor(() => expect(h.subs).toHaveLength(1));
    const sub = h.subs[0];
    sub.listener.onHistory([], false);
    const serverSide = [...wss.clients].find((s) => s.readyState === WebSocket.OPEN)!;
    let buffered = 2 * 1024 * 1024;
    Object.defineProperty(serverSide, 'bufferedAmount', {
      get: () => buffered,
      configurable: true,
    });
    sub.listener.onEntries([entry('a'), entry('b')]);
    sub.listener.onEntries([entry('c')]);
    buffered = 0;
    sub.listener.onEntries([entry('d')]);
    await vi.waitFor(() => expect(of(c, 'log_batch')).toHaveLength(2));
    const types = c.messages.map((m) => m.type);
    expect(types.slice(-2)).toEqual(['logs_dropped', 'log_batch']);
    expect(of(c, 'logs_dropped')[0]).toMatchObject({ count: 3, reason: 'slow_connection' });
    expect(of(c, 'log_batch')[1]).toMatchObject({ entries: [{ message: 'd' }] });
    c.ws.close();
  });

  it('refuses commands beyond the rate limit', async () => {
    const c = await open();
    await vi.waitFor(() => expect(h.subs).toHaveLength(1));
    // Time stands still, so the allowance does not refill during the test.
    const now = vi.spyOn(Date, 'now').mockReturnValue(Date.now());
    try {
      for (let i = 0; i < 31; i++) {
        c.ws.send(JSON.stringify({ type: 'command', payload: `/say ${i}`, requestId: `q${i}` }));
        await vi.waitFor(() => expect(of(c, 'command_response')).toHaveLength(i + 1));
      }
    } finally {
      now.mockRestore();
    }
    const refused = of(c, 'command_response').filter((m) => m.success === false);
    expect(refused).toHaveLength(1);
    expect(refused[0]).toMatchObject({ requestId: 'q30' });
    expect(String(refused[0].error)).toMatch(/Too many commands/);
    expect(h.execCommand).toHaveBeenCalledTimes(30);
    c.ws.close();
  });
});
