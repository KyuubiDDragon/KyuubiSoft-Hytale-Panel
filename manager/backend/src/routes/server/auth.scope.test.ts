/**
 * Downloader login and Hytale server sign-in per server: the routes of
 * server B check B's token, run the downloader and the console commands in
 * B's container, read B's log, keep their state for B and write into B's
 * folders, never A's. Docker is stubbed; both servers have temp folders.
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import http, { type Server } from 'http';
import type { AddressInfo } from 'net';
import fs from 'fs';
import os from 'os';
import path from 'path';
import express from 'express';
import type { ServerContext } from '../../services/serverContext.js';
import { serverContextIn } from '../../test/serverContextStub.js';

const { contexts, docker } = vi.hoisted(() => ({
  contexts: new Map<string, ServerContext>(),
  docker: {
    logs: new Map<string, string>(),
    javaRunning: new Set<string>(),
    execInContainer: vi.fn(),
    execCommand: vi.fn(),
    getLogs: vi.fn(),
  },
}));
vi.mock('../../middleware/auth.js', () => ({
  authMiddleware: (req: { user?: string }, _res: unknown, next: () => void) => {
    req.user = 'alice';
    next();
  },
}));
vi.mock('../../middleware/permissions.js', () => ({
  requirePermission: () => (_req: unknown, _res: unknown, next: () => void) => next(),
  mayAccessServer: async () => true,
  SERVER_NOT_ALLOWED: 'SERVER_NOT_ALLOWED',
}));
vi.mock('../../services/serverContext.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/serverContext.js')>();
  return {
    ...actual,
    getServerContext: async (id?: string | null) => {
      const ctx = contexts.get(id ?? 'default');
      if (!ctx) throw new actual.UnknownServerError(String(id));
      return ctx;
    },
  };
});
vi.mock('../../services/servers.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../services/servers.js')>()),
  resolveServerId: async (id?: string | null) => id || 'default',
}));
vi.mock('../../services/docker.js', () => ({
  execInContainer: (cmd: string, id: string) => docker.execInContainer(cmd, id),
  execCommand: (cmd: string, id: string) => docker.execCommand(cmd, id),
  getLogs: (tail: number, id: string) => docker.getLogs(tail, id),
  // Both containers run, their game servers do not (the entrypoint waits).
  getContainerState: async () => ({ running: true, startedAt: '2026-01-01T00:00:00Z' }),
  isServerProcessRunning: async (id: string) => docker.javaRunning.has(id),
}));

const { default: downloaderRoutes } = await import('./auth.js');
const { default: hytaleAuthRoutes } = await import('../hytaleAuth.js');

let base: string;
let a: ServerContext;
let b: ServerContext;
let server: Server;
let legacy: string;
let scoped: string;

const scope = (id: string | null) => (req: express.Request, _res: unknown, next: () => void) => {
  req.serverId = id ?? req.params.serverId;
  next();
};

const PROMPT = (code: string) =>
  [
    `${new Date().toISOString()} [INFO] Attempting download (attempt 1)...`,
    `${new Date().toISOString()} Visit: https://oauth.accounts.hytale.com/oauth2/device/verify`,
    `${new Date().toISOString()} Enter code: ${code}`,
    `${new Date().toISOString()} Or visit: https://oauth.accounts.hytale.com/oauth2/device/verify?user_code=${code}`,
  ].join('\n');

async function send(method: string, url: string, body?: unknown) {
  const res = await fetch(url, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json()) as Record<string, any> };
}

beforeAll(async () => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'kp-auth-scope-'));
  a = serverContextIn(path.join(base, 'a'), 'default');
  b = serverContextIn(path.join(base, 'b'), 'srv-b');
  for (const ctx of [a, b]) contexts.set(ctx.id, ctx);

  const app = express();
  app.use(express.json());
  for (const [prefix, id] of [
    ['/api/server', 'default'],
    ['/api/servers/:serverId/server', null],
  ] as const) {
    app.use(prefix, scope(id), downloaderRoutes);
    app.use(`${prefix}/hytale-auth`, scope(id), hytaleAuthRoutes);
  }
  server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  legacy = `${origin}/api/server`;
  scoped = `${origin}/api/servers/srv-b/server`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  fs.rmSync(base, { recursive: true, force: true });
});

beforeEach(() => {
  for (const ctx of [a, b]) {
    fs.rmSync(path.join(base, ctx === a ? 'a' : 'b'), { recursive: true, force: true });
    for (const dir of [ctx.paths.server, ctx.paths.data, ctx.paths.auth]) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }
  docker.logs.clear();
  docker.javaRunning.clear();
  docker.getLogs.mockReset();
  docker.getLogs.mockImplementation(async (_tail: number, id: string) => docker.logs.get(id) ?? '');
  docker.execInContainer.mockReset();
  // No token anywhere: the probe in the container says "missing".
  docker.execInContainer.mockResolvedValue({ success: true, output: 'missing' });
  docker.execCommand.mockReset();
  docker.execCommand.mockResolvedValue({ success: true, message: 'sent' });
});

describe('downloader login per server', () => {
  it("reports the login B's container waits for, from B's log", async () => {
    docker.logs.set('srv-b', PROMPT('BbBb1234'));
    docker.logs.set('default', PROMPT('AaAa1234'));
    const r = await send('GET', `${scoped}/downloader/auth-status`);
    expect(r.json).toMatchObject({
      credentialsExist: false,
      pendingLogin: { userCode: 'BbBb1234' },
    });
    expect(docker.getLogs.mock.calls.map((c) => c[1])).toEqual(['srv-b']);
    expect(docker.execInContainer.mock.calls.map((c) => c[1])).toEqual(['srv-b']);
  });

  it('does not take a prompt from the log while the game server runs (a mod could print it)', async () => {
    docker.logs.set('srv-b', PROMPT('FakE1234'));
    docker.javaRunning.add('srv-b');
    const r = await send('GET', `${scoped}/downloader/auth-status`);
    expect(r.json.pendingLogin).toBeNull();
  });

  it('hands out the waiting login of B instead of starting a second downloader', async () => {
    docker.logs.set('srv-b', PROMPT('BbBb1234'));
    const r = await send('POST', `${scoped}/downloader/initiate-auth`);
    expect(r.json).toMatchObject({ success: true, source: 'container', userCode: 'BbBb1234' });
    // Only the token probe ran; nothing was deleted or started in a container.
    expect(docker.execInContainer).toHaveBeenCalledTimes(1);
    expect(docker.execInContainer.mock.calls[0][0]).toMatch(/^test -f /);

    // The flow is B's: A has none.
    expect((await send('GET', `${legacy}/downloader/auth-poll`)).json.error).toBe(
      'No active auth flow',
    );
    const poll = await send('GET', `${scoped}/downloader/auth-poll`);
    expect(poll.json).toMatchObject({ completed: false, userCode: 'BbBb1234' });
  });

  it("runs the downloader login in B's container when nothing waits", async () => {
    docker.execInContainer.mockImplementation(async (cmd: string) =>
      cmd.startsWith('test -f')
        ? { success: true, output: 'missing' }
        : { success: true, output: PROMPT('CcCc1234') },
    );
    const r = await send('POST', `${scoped}/downloader/initiate-auth`);
    expect(r.json).toMatchObject({ success: true, userCode: 'CcCc1234' });
    expect(new Set(docker.execInContainer.mock.calls.map((c) => c[1]))).toEqual(new Set(['srv-b']));
  });

  it('counts a token B wrote while its own download holds the lock as done', async () => {
    docker.logs.set('srv-b', PROMPT('BbBb1234'));
    await send('POST', `${scoped}/downloader/initiate-auth`);
    // The user logged in: the token exists, the container's download runs.
    fs.mkdirSync(path.join(base, 'b', 'downloader'), { recursive: true });
    fs.writeFileSync(
      path.join(base, 'b', 'downloader', '.hytale-downloader-credentials.json'),
      '{}',
    );
    docker.execInContainer.mockResolvedValue({ success: true, output: '__DOWNLOADER_BUSY__' });
    const poll = await send('GET', `${scoped}/downloader/auth-poll`);
    expect(poll.json).toEqual({ completed: true, downloading: true });
  });
});

describe('Hytale server sign-in per server', () => {
  it("starts /auth login device on B and keeps the flow in B's data folder", async () => {
    docker.logs.set('srv-b', PROMPT('DdDd1234'));
    const r = await send('POST', `${scoped}/hytale-auth/initiate`);
    expect(r.json).toMatchObject({ success: true, userCode: 'DdDd1234' });
    expect(docker.execCommand).toHaveBeenCalledWith('/auth login device', 'srv-b');
    expect(docker.getLogs.mock.calls.map((c) => c[1])).toEqual(['srv-b']);
    const saved = JSON.parse(fs.readFileSync(path.join(b.paths.data, 'hytale-auth.json'), 'utf-8'));
    expect(saved).toMatchObject({ userCode: 'DdDd1234', authenticated: false });
    expect(fs.existsSync(path.join(a.paths.data, 'hytale-auth.json'))).toBe(false);
  });

  it('passes on how long the server says the code lives', async () => {
    docker.logs.set(
      'srv-b',
      `${PROMPT('EeEe1234')}\nWaiting for authorization (expires in 599 seconds)...`,
    );
    const r = await send('POST', `${scoped}/hytale-auth/initiate`);
    expect(r.json).toMatchObject({ success: true, userCode: 'EeEe1234', expiresIn: 599 });
    const saved = JSON.parse(fs.readFileSync(path.join(b.paths.data, 'hytale-auth.json'), 'utf-8'));
    expect(saved.expiresAt - saved.lastChecked).toBeLessThanOrEqual(599_000);
  });

  it("finds B's token in B's auth folder and A's in A's", async () => {
    fs.writeFileSync(path.join(b.paths.auth, 'auth.enc'), 'token');
    expect((await send('GET', `${scoped}/hytale-auth/status`)).json.authenticated).toBe(true);
    expect((await send('GET', `${legacy}/hytale-auth/status`)).json.authenticated).toBe(false);
    expect((await send('GET', `${scoped}/hytale-auth/files`)).json.files).toEqual(['auth.enc']);
    expect((await send('GET', `${legacy}/hytale-auth/files`)).json.files).toEqual([]);
  });

  it.skipIf(process.platform === 'win32')(
    'does not follow links the game server planted in its auth folders',
    async () => {
      const secret = path.join(base, 'secret');
      fs.mkdirSync(secret, { recursive: true });
      fs.writeFileSync(path.join(secret, 'users.json'), '{}');
      fs.writeFileSync(path.join(secret, 'auth.enc'), 'x');
      fs.symlinkSync(secret, path.join(b.paths.server, '.auth'));
      fs.symlinkSync(path.join(secret, 'auth.enc'), path.join(b.paths.auth, 'auth.enc'));
      expect((await send('GET', `${scoped}/hytale-auth/files`)).json.files).toEqual([]);
      expect((await send('GET', `${scoped}/hytale-auth/status`)).json.authenticated).toBe(false);
    },
  );

  it('sets the persistence on the requested server only', async () => {
    docker.logs.set('srv-b', 'Persistence type set to Encrypted');
    const r = await send('POST', `${scoped}/hytale-auth/persistence`, { type: 'Encrypted' });
    expect(docker.execCommand).toHaveBeenCalledWith('/auth persistence Encrypted', 'srv-b');
    expect(r.json.success).toBe(true);
  }, 10_000);
});
