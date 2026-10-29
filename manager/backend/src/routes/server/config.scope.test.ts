/**
 * The start settings in panel-config.json belong to one server each: the
 * routes of server B read and write B's file and B's game files, the
 * container commands and the lifecycle lock go to B, and server A's folders
 * stay byte for byte as they were. A server whose files the panel cannot see
 * gets 409 instead of another server's settings. Auth and permissions are
 * stubbed; both servers have their own temp folders.
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import http, { type Server } from 'http';
import type { AddressInfo } from 'net';
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import express from 'express';
import type { ServerContext } from '../../services/serverContext.js';
import { serverContextIn } from '../../test/serverContextStub.js';

const { contexts, docker, lifecycle } = vi.hoisted(() => ({
  contexts: new Map<string, ServerContext>(),
  docker: {
    running: new Set<string>(),
    getContainerState: vi.fn(),
    isServerProcessRunning: vi.fn(),
    execCommand: vi.fn(),
    execInContainer: vi.fn(),
    getContainerMemoryLimit: vi.fn(),
    /** Container env by container name. */
    env: {
      'hytale-srv-default': ['JAVA_MIN_RAM=3G', 'JAVA_MAX_RAM=6G'],
      'hytale-srv-srv-b': ['TZ=UTC', 'JAVA_MIN_RAM=1G', 'JAVA_MAX_RAM=2G'],
    } as Record<string, string[]>,
  },
  lifecycle: { withServerStopped: vi.fn() },
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
vi.mock('../../services/docker.js', () => ({
  getContainerState: (id: string) => docker.getContainerState(id),
  isServerProcessRunning: (id: string) => docker.isServerProcessRunning(id),
  execCommand: (cmd: string, id: string) => docker.execCommand(cmd, id),
  execInContainer: (cmd: string, id: string) => docker.execInContainer(cmd, id),
  getContainerMemoryLimit: (id: string) => docker.getContainerMemoryLimit(id),
  getDockerInstance: () => ({
    getContainer: (name: string) => ({
      inspect: async () => ({ Config: { Env: docker.env[name] ?? [] } }),
    }),
  }),
}));
vi.mock('../../services/serverLifecycle.js', () => ({
  withServerStopped: (id: string, opts: unknown, fn: () => Promise<unknown>) =>
    lifecycle.withServerStopped(id, opts, fn),
  LifecycleBusyError: class LifecycleBusyError extends Error {},
}));
vi.mock('../../services/commandPolicy.js', () => ({
  authorizeCommand: async () => ({ allowed: true }),
  actorFromRequest: () => ({ username: 'alice' }),
}));

const { default: configRoutes } = await import('./config.js');

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

/** sha256 of every file below `dir`, by relative path. */
function digest(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (d: string) => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) walk(full);
      else {
        out[path.relative(dir, full)] = crypto
          .createHash('sha256')
          .update(fs.readFileSync(full))
          .digest('hex');
      }
    }
  };
  walk(dir);
  return out;
}

const panelConfig = (ctx: ServerContext) =>
  JSON.parse(fs.readFileSync(path.join(ctx.paths.data, 'panel-config.json'), 'utf-8'));

async function send(method: string, url: string, body?: unknown) {
  const res = await fetch(url, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json()) as Record<string, any> };
}

beforeAll(async () => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'kp-config-scope-'));
  a = serverContextIn(path.join(base, 'a'), 'default');
  b = serverContextIn(path.join(base, 'b'), 'srv-b');
  for (const ctx of [a, b]) contexts.set(ctx.id, ctx);
  // A server registered without folders the panel can see.
  contexts.set('srv-c', serverContextIn(path.join(base, 'c'), 'srv-c'));

  const app = express();
  app.use(express.json());
  app.use('/api/server', scope('default'), configRoutes);
  app.use('/api/servers/:serverId/server', scope(null), configRoutes);
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
    fs.rmSync(path.dirname(ctx.paths.server), { recursive: true, force: true });
    fs.mkdirSync(ctx.paths.server, { recursive: true });
    fs.mkdirSync(ctx.paths.data, { recursive: true });
    for (const f of ['HytaleServer.jar', 'Assets.zip', '.hytale-version']) {
      fs.writeFileSync(path.join(ctx.paths.server, f), `${ctx.id} release build`);
    }
    fs.writeFileSync(
      path.join(ctx.paths.data, 'panel-config.json'),
      JSON.stringify({ patchline: 'release', allowOp: false, custom: ctx.id }),
    );
  }
  docker.running.clear();
  docker.getContainerState.mockReset();
  docker.getContainerState.mockImplementation(async (id: string) => ({
    running: docker.running.has(id),
  }));
  docker.isServerProcessRunning.mockReset();
  docker.isServerProcessRunning.mockImplementation(async (id: string) => docker.running.has(id));
  docker.execCommand.mockReset();
  docker.execCommand.mockResolvedValue({ success: true, message: 'ok' });
  docker.execInContainer.mockReset();
  docker.execInContainer.mockResolvedValue({ success: true, output: '' });
  docker.getContainerMemoryLimit.mockReset();
  docker.getContainerMemoryLimit.mockResolvedValue(8 * 1024 ** 3);
  lifecycle.withServerStopped.mockReset();
  lifecycle.withServerStopped.mockImplementation(
    async (_id: string, _opts: unknown, fn: () => Promise<unknown>) => fn(),
  );
});

describe('panel-config.json per server', () => {
  it('switches the patchline of a stopped server B in its own folders only', async () => {
    const before = { server: digest(a.paths.server), data: digest(a.paths.data) };
    const r = await send('PUT', `${scoped}/patchline`, { patchline: 'pre-release' });
    expect(r.status).toBe(200);
    expect(r.json.changed).toBe(true);
    expect(panelConfig(b)).toMatchObject({ patchline: 'pre-release', custom: 'srv-b' });
    expect(fs.readdirSync(b.paths.server)).toEqual([]);
    expect(lifecycle.withServerStopped.mock.calls.map((c) => c[0])).toEqual(['srv-b']);
    expect(docker.getContainerState.mock.calls.map((c) => c[0])).toEqual(['srv-b']);
    expect({ server: digest(a.paths.server), data: digest(a.paths.data) }).toEqual(before);
  });

  it('asks the running server B, not A, to drop its update and deletes in its container', async () => {
    docker.running.add('srv-b');
    const before = digest(path.dirname(a.paths.server));
    const r = await send('PUT', `${scoped}/patchline`, { patchline: 'pre-release' });
    expect(r.status).toBe(200);
    expect(docker.execCommand).toHaveBeenCalledWith('/update cancel', 'srv-b');
    const [cmd, id] = docker.execInContainer.mock.calls[0];
    expect(id).toBe('srv-b');
    // The container's own paths, never the manager's view of B's folders.
    expect(cmd).toContain("'/opt/hytale/server/HytaleServer.jar'");
    expect(cmd).not.toContain(base);
    expect(panelConfig(b).patchline).toBe('pre-release');
    expect(digest(path.dirname(a.paths.server))).toEqual(before);
  });

  it('reads and writes the start flags and JVM settings of the requested server', async () => {
    expect((await send('GET', `${scoped}/patchline`)).json.patchline).toBe('release');
    for (const [route, body] of [
      ['accept-early-plugins', { acceptEarlyPlugins: true }],
      ['disable-sentry', { disableSentry: true }],
      ['allow-op', { allowOp: true }],
    ] as const) {
      const r = await send('PUT', `${scoped}/${route}`, body);
      expect(r.status, route).toBe(200);
      expect(r.json.changed, route).toBe(true);
    }
    const jvm = await send('PUT', `${scoped}/jvm`, {
      javaMinRam: '1G',
      javaMaxRam: '2G',
      bootCommands: ['say hi'],
    });
    expect(jvm.status).toBe(200);
    expect(docker.getContainerMemoryLimit.mock.calls.map((c) => c[0])).toEqual(['srv-b']);
    expect(panelConfig(b)).toMatchObject({
      acceptEarlyPlugins: true,
      disableSentry: true,
      allowOp: true,
      javaMinRam: '1G',
      javaMaxRam: '2G',
      bootCommands: ['say hi'],
      custom: 'srv-b',
    });
    expect((await send('GET', `${scoped}/allow-op`)).json.allowOp).toBe(true);
    // A's own file: untouched, and its routes still answer A's values.
    expect(panelConfig(a)).toEqual({ patchline: 'release', allowOp: false, custom: 'default' });
    expect((await send('GET', `${legacy}/allow-op`)).json.allowOp).toBe(false);
    expect((await send('GET', `${legacy}/jvm`)).json.javaMaxRam).not.toBe('2G');
  });

  it("shows each server's own container heap as the default", async () => {
    const onB = await send('GET', `${scoped}/jvm`);
    expect(onB.json).toMatchObject({
      javaMinRam: '1G',
      javaMaxRam: '2G',
      envDefaults: { javaMinRam: '1G', javaMaxRam: '2G' },
    });
    const onA = await send('GET', `${legacy}/jvm`);
    expect(onA.json.envDefaults).toEqual({ javaMinRam: '3G', javaMaxRam: '6G' });
  });

  it('names the server limit, not DOCKER_MEMORY_LIMIT, for a heap B does not fit', async () => {
    docker.getContainerMemoryLimit.mockResolvedValue(2 * 1024 ** 3);
    const r = await send('PUT', `${scoped}/jvm`, { javaMinRam: '1G', javaMaxRam: '6G' });
    expect(r.status).toBe(400);
    expect(r.json.error).toContain('the memory limit of this server');
    expect(panelConfig(b).javaMaxRam).toBeUndefined();
  });

  it('answers 409 for a server whose files the panel does not see, and writes nothing', async () => {
    const r = await send('PUT', `${scoped.replace('srv-b', 'srv-c')}/allow-op`, { allowOp: true });
    expect(r.status).toBe(409);
    expect(r.json.code).toBe('server_files_unavailable');
    expect(fs.existsSync(path.join(base, 'c'))).toBe(false);
    expect(panelConfig(a).allowOp).toBe(false);
  });

  it('does not follow a link planted as panel-config.json', async () => {
    if (process.platform === 'win32') return;
    const secret = path.join(base, 'secret.json');
    fs.writeFileSync(secret, '{"jwtSecret":"x","patchline":"pre-release"}');
    fs.rmSync(path.join(b.paths.data, 'panel-config.json'));
    fs.symlinkSync(secret, path.join(b.paths.data, 'panel-config.json'));
    expect((await send('GET', `${scoped}/patchline`)).json.patchline).toBe('release');
    await send('PUT', `${scoped}/disable-sentry`, { disableSentry: true });
    expect(fs.lstatSync(path.join(b.paths.data, 'panel-config.json')).isSymbolicLink()).toBe(false);
    expect(panelConfig(b)).not.toHaveProperty('jwtSecret');
    expect(fs.readFileSync(secret, 'utf-8')).toBe('{"jwtSecret":"x","patchline":"pre-release"}');
  });
});
