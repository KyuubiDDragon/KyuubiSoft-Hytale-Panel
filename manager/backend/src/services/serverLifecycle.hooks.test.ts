/**
 * The lock and hook paths of the lifecycle that the file writers rely on:
 * runWhileServerStopped(), the before-start hooks and writeWhileStopped() on
 * top of them. The real modules run; only Docker, the event bus and the
 * server registry are stubbed.
 */
import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kp-lifecycle-hooks-'));

const h = vi.hoisted(() => ({
  state: null as null | { running: boolean; startedAt: string },
  stateError: null as Error | null,
  log: [] as string[],
  hookError: null as Error | null,
  reenter: false,
}));

vi.mock('./docker.js', () => ({
  getContainerState: vi.fn(async () => {
    if (h.stateError) throw h.stateError;
    return h.state
      ? { ...h.state, status: '', finishedAt: '', exitCode: 0, oomKilled: false, restartCount: 0 }
      : null;
  }),
  isServerProcessRunning: vi.fn(async () => true),
  sendLifecycleCommand: vi.fn(async (command: string) => {
    if (command === '/stop' && h.state) {
      h.log.push('stop');
      h.state.running = false;
    }
    return { success: true };
  }),
  stopContainer: vi.fn(async () => {
    if (h.state) h.state.running = false;
    return { success: true };
  }),
  startContainer: vi.fn(async () => {
    h.log.push('start');
    if (h.state) h.state = { running: true, startedAt: `run-${h.log.length}` };
    return { success: true };
  }),
  noteIntentionalStop: vi.fn(async () => undefined),
}));
vi.mock('./servers.js', () => ({
  resolveServerId: async (id?: string) => id ?? 'default',
  getServer: async (id: string) => ({ id, paths: { data: dataDir } }),
}));
const publish = vi.fn((name: string) => h.log.push(`event:${name}`));
vi.mock('./eventBus.js', () => ({ publish: (name: string) => publish(name) }));
vi.mock('./players.js', () => ({ clearOnlinePlayers: vi.fn() }));
vi.mock('./demoData.js', () => ({ isDemoMode: () => false }));
vi.mock('../middleware/permissions.js', () => ({
  requirePermission: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));

const lifecycle = await import('./serverLifecycle.js');
const { writeWhileStopped } = await import('./serverConfigWrite.js');
const {
  LifecycleBusyError,
  isLifecycleBusy,
  registerBeforeStartHook,
  restartServerGracefully,
  runWhileServerStopped,
  startServer,
  withServerStopped,
} = lifecycle;

// Registered once, like the modules that register theirs on import; the
// flags above decide what they do in a test.
registerBeforeStartHook('first', async (id) => {
  h.log.push(`hook:first:${id}`);
  if (h.hookError) throw h.hookError;
});
registerBeforeStartHook('second', async (id) => {
  h.log.push(`hook:second:${id}`);
  if (!h.reenter) return;
  // A hook edits files while the start holds the lock (setup restart, access files).
  const r = await runWhileServerStopped(id, { reason: 'config', rejectIfBusy: true }, async () => {
    h.log.push('hook:second:write');
    return 'ok';
  });
  h.log.push(`hook:second:ran=${r.ran}`);
});

const stopped = () => ({ running: false, startedAt: 'run-0' });
const running = () => ({ running: true, startedAt: 'run-0' });

beforeEach(() => {
  vi.useFakeTimers();
  publish.mockClear();
  h.state = stopped();
  h.stateError = null;
  h.log = [];
  h.hookError = null;
  h.reenter = false;
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

afterAll(() => {
  fs.rmSync(dataDir, { recursive: true, force: true });
});

/** Run a lifecycle call to completion while advancing the fake clock. */
async function settle<T>(promise: Promise<T>, ms = 300_000): Promise<T> {
  let done = false;
  const outcome = promise.then(
    (value) => {
      done = true;
      return { ok: true as const, value };
    },
    (error: unknown) => {
      done = true;
      return { ok: false as const, error };
    },
  );
  for (let waited = 0; !done && waited < ms; waited += 500) {
    await vi.advanceTimersByTimeAsync(500);
  }
  const result = await outcome;
  if (!result.ok) throw result.error;
  return result.value;
}

/** A function that only finishes when told to, to hold the lock meanwhile. */
function gate() {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => (open = resolve));
  return { open, opened };
}

describe('runWhileServerStopped', () => {
  it('runs fn right away on a stopped server, and a start waits until fn is done', async () => {
    const g = gate();
    const write = runWhileServerStopped('a', { reason: 'config' }, async () => {
      h.log.push('write:begin');
      await g.opened;
      h.log.push('write:end');
      return 42;
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(isLifecycleBusy('a')).toBe(true);
    const start = startServer('a', { reason: 'user' });
    await vi.advanceTimersByTimeAsync(10);
    expect(h.log).toEqual(['write:begin']);
    g.open();
    expect(await write).toEqual({ ran: true, value: 42 });
    expect(await settle(start)).toMatchObject({ ok: true });
    expect(h.log.indexOf('write:end')).toBeLessThan(h.log.indexOf('start'));
    expect(isLifecycleBusy('a')).toBe(false);
  });

  it('does not call fn on a running server and leaves it running', async () => {
    h.state = running();
    const fn = vi.fn(async () => 1);
    expect(await runWhileServerStopped('a', { reason: 'config' }, fn)).toEqual({ ran: false });
    expect(fn).not.toHaveBeenCalled();
    expect(h.log).toEqual([]);
    expect(h.state.running).toBe(true);
  });

  it('counts a missing container as stopped', async () => {
    h.state = null;
    expect(await runWhileServerStopped('a', { reason: 'config' }, async () => 'x')).toEqual({
      ran: true,
      value: 'x',
    });
  });

  it('rejects on a Docker error without running fn, and frees the lock', async () => {
    h.stateError = new Error('docker down');
    const fn = vi.fn(async () => 1);
    await expect(runWhileServerStopped('a', { reason: 'config' }, fn)).rejects.toThrow(
      'docker down',
    );
    expect(fn).not.toHaveBeenCalled();
    expect(isLifecycleBusy('a')).toBe(false);
  });

  it('refuses with LifecycleBusyError while another operation holds the lock, if asked to', async () => {
    const g = gate();
    const holder = runWhileServerStopped('a', { reason: 'config' }, () => g.opened);
    await vi.advanceTimersByTimeAsync(0);
    const fn = vi.fn(async () => 1);
    await expect(
      runWhileServerStopped('a', { reason: 'config', rejectIfBusy: true }, fn),
    ).rejects.toBeInstanceOf(LifecycleBusyError);
    // Without rejectIfBusy it queues behind the holder.
    const queued = runWhileServerStopped('a', { reason: 'config' }, fn);
    await vi.advanceTimersByTimeAsync(10);
    expect(fn).not.toHaveBeenCalled();
    g.open();
    await holder;
    expect(await queued).toEqual({ ran: true, value: 1 });
  });

  it('keeps servers apart: a held lock on one does not block another', async () => {
    const g = gate();
    const holder = runWhileServerStopped('a', { reason: 'config' }, () => g.opened);
    await vi.advanceTimersByTimeAsync(0);
    expect(
      await runWhileServerStopped('b', { reason: 'config', rejectIfBusy: true }, async () => 'b'),
    ).toEqual({
      ran: true,
      value: 'b',
    });
    g.open();
    await holder;
  });

  it('re-enters the lock it already holds instead of deadlocking', async () => {
    h.state = running();
    const value = await settle(
      withServerStopped('a', { reason: 'config', rejectIfBusy: true }, async () => {
        const inner = await runWhileServerStopped(
          'a',
          { reason: 'config', rejectIfBusy: true },
          async () => 'inner',
        );
        return inner;
      }),
    );
    expect(value).toEqual({ ran: true, value: 'inner' });
    expect(h.log.filter((l) => l === 'stop' || l === 'start')).toEqual(['stop', 'start']);
  });
});

describe('before-start hooks', () => {
  it('run in the order they were registered, with the server id, before the start is announced', async () => {
    await settle(startServer(undefined, { reason: 'user' }));
    expect(h.log).toEqual([
      'hook:first:default',
      'hook:second:default',
      'event:server.starting',
      'start',
      'event:server.started',
    ]);
  });

  it('run before every start through the panel, also the one after a restart', async () => {
    h.state = running();
    await settle(restartServerGracefully('a', { reason: 'restart' }));
    expect(h.log).toEqual([
      'event:server.stopping',
      'stop',
      'event:server.stopped',
      'hook:first:a',
      'hook:second:a',
      'event:server.starting',
      'start',
      'event:server.started',
    ]);
  });

  it('do not run when the server is already up', async () => {
    h.state = running();
    expect(await settle(startServer('a', { reason: 'user' }))).toMatchObject({
      method: 'already_running',
    });
    expect(h.log).toEqual([]);
  });

  it('a failing hook is logged and does not keep the server from starting', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    h.hookError = new Error('broken file');
    const result = await settle(startServer('a', { reason: 'user' }));
    expect(result).toMatchObject({ ok: true });
    expect(h.log).toEqual([
      'hook:first:a',
      'hook:second:a',
      'event:server.starting',
      'start',
      'event:server.started',
    ]);
    expect(errors).toHaveBeenCalledWith(
      expect.stringContaining('Before-start step "first" failed'),
      h.hookError,
    );
  });

  it('a hook may take the lock the start holds (file work right before the start)', async () => {
    h.reenter = true;
    await settle(startServer('a', { reason: 'user' }));
    expect(h.log).toEqual([
      'hook:first:a',
      'hook:second:a',
      'hook:second:write',
      'hook:second:ran=true',
      'event:server.starting',
      'start',
      'event:server.started',
    ]);
  });
});

describe('writeWhileStopped on the real lifecycle', () => {
  it('writes a stopped server right away, under the lock', async () => {
    let busyWhileWriting: boolean | null = null;
    const outcome = await writeWhileStopped('a', { restart: false }, async () => {
      busyWhileWriting = isLifecycleBusy('a');
      return 'written';
    });
    expect(outcome).toEqual({ kind: 'written', restarted: false, value: 'written' });
    expect(busyWhileWriting).toBe(true);
    expect(h.log).toEqual([]);
  });

  it('refuses a running server without a restart and does not write', async () => {
    h.state = running();
    const write = vi.fn(async () => 'x');
    expect(await writeWhileStopped('a', { restart: false }, write)).toEqual({
      kind: 'requires_restart',
    });
    expect(write).not.toHaveBeenCalled();
    expect(h.state.running).toBe(true);
  });

  it('stops, writes and starts a running server when asked to restart', async () => {
    h.state = running();
    const outcome = await settle(
      writeWhileStopped('a', { restart: true, actor: 'alice' }, async () => {
        h.log.push(`write:running=${h.state?.running}`);
        return 'x';
      }),
    );
    expect(outcome).toEqual({ kind: 'written', restarted: true, value: 'x' });
    expect(h.log.filter((l) => !l.startsWith('event:'))).toEqual([
      'stop',
      'write:running=false',
      'hook:first:a',
      'hook:second:a',
      'start',
    ]);
  });

  it('answers busy while another operation holds the lock, without writing', async () => {
    const g = gate();
    const holder = runWhileServerStopped('a', { reason: 'config' }, () => g.opened);
    await vi.advanceTimersByTimeAsync(0);
    const write = vi.fn(async () => 'x');
    expect(await writeWhileStopped('a', { restart: true }, write)).toEqual({ kind: 'busy' });
    expect(write).not.toHaveBeenCalled();
    g.open();
    await holder;
  });
});
