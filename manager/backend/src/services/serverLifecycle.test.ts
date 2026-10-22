/**
 * Graceful lifecycle: `/stop` first, wait for the exit, Docker only as the
 * fallback; per-server serialization; the countdown plan; and the cleanup
 * that withServerStopped() guarantees.
 */
import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type { ContainerState } from './docker.js';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kp-lifecycle-'));

const h = vi.hoisted(() => ({
  state: null as null | {
    running: boolean;
    status: string;
    startedAt: string;
    finishedAt: string;
    exitCode: number;
    oomKilled: boolean;
    restartCount: number;
  },
  serverUp: true as boolean | null,
  sendOk: true,
  // What the fake server does when it reads /stop from its console.
  onStop: 'exit' as 'exit' | 'hang' | 'policy-restart',
  startOk: true,
  sent: [] as string[],
  log: [] as string[],
}));

vi.mock('./docker.js', () => ({
  getContainerState: vi.fn(async () => (h.state ? { ...h.state } : null)),
  isServerProcessRunning: vi.fn(async () => h.serverUp),
  sendLifecycleCommand: vi.fn(async (command: string) => {
    h.sent.push(command);
    if (!h.sendOk) return { success: false, error: 'Server console is not reachable' };
    if (command === '/stop' && h.state) {
      h.log.push('stop-command');
      if (h.onStop === 'exit') h.state.running = false;
      if (h.onStop === 'policy-restart') h.state.startedAt = 'run-policy';
    }
    return { success: true };
  }),
  stopContainer: vi.fn(async () => {
    h.log.push('docker-stop');
    if (h.state) h.state.running = false;
    return { success: true };
  }),
  startContainer: vi.fn(async () => {
    h.log.push('start');
    if (!h.startOk) return { success: false, error: 'boom' };
    if (h.state) {
      h.state.running = true;
      h.state.startedAt = `run-${h.log.length}`;
    }
    return { success: true };
  }),
  noteIntentionalStop: vi.fn(async () => undefined),
}));
vi.mock('./servers.js', () => ({
  resolveServerId: async (id?: string) => id ?? 'default',
  getServer: async (id: string) => ({ id, paths: { data: dataDir } }),
}));
const publish = vi.fn();
vi.mock('./eventBus.js', () => ({ publish: (...a: unknown[]) => publish(...a) }));
vi.mock('./players.js', () => ({ clearOnlinePlayers: vi.fn() }));
vi.mock('./demoData.js', () => ({ isDemoMode: () => false }));

const docker = await import('./docker.js');
const lifecycle = await import('./serverLifecycle.js');
const {
  stopServerGracefully,
  restartServerGracefully,
  startServer,
  withServerStopped,
  getActiveOperation,
  buildCountdownPlan,
  toConsoleText,
  LifecycleError,
} = lifecycle;

function runningState(): ContainerState {
  return {
    running: true,
    status: 'running',
    startedAt: 'run-0',
    finishedAt: '',
    exitCode: 0,
    oomKilled: false,
    restartCount: 0,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  h.state = runningState();
  h.serverUp = true;
  h.sendOk = true;
  h.onStop = 'exit';
  h.startOk = true;
  h.sent = [];
  h.log = [];
});

afterEach(() => {
  vi.useRealTimers();
});

afterAll(() => {
  fs.rmSync(dataDir, { recursive: true, force: true });
});

/** Run a lifecycle call to completion while advancing the fake clock. */
async function settle<T>(promise: Promise<T>, ms = 400_000): Promise<T> {
  let done = false;
  // Handle the rejection right away, so it never counts as unhandled meanwhile.
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

const eventNames = () => publish.mock.calls.map((c) => c[0]);

describe('stopServerGracefully', () => {
  it('sends /stop and waits for the exit instead of killing the container', async () => {
    const r = await settle(stopServerGracefully('default', { reason: 'user', actor: 'alice' }));
    expect(r).toEqual({ ok: true, method: 'command' });
    expect(h.sent).toEqual(['/stop']);
    expect(docker.stopContainer).not.toHaveBeenCalled();
    expect(docker.noteIntentionalStop).toHaveBeenCalledWith('default');
    expect(eventNames()).toEqual(['server.stopping', 'server.stopped']);
    expect(publish.mock.calls[0][1]).toMatchObject({ reason: 'user', initiator: 'alice' });
  });

  it('falls back to docker stop when the server does not exit in time', async () => {
    h.onStop = 'hang';
    const r = await settle(stopServerGracefully('default', { reason: 'user', timeoutMs: 5000 }));
    expect(r).toEqual({ ok: true, method: 'docker' });
    expect(h.log).toEqual(['stop-command', 'docker-stop']);
    expect(docker.stopContainer).toHaveBeenCalledWith('default', 30);
  });

  it('uses docker stop with the full grace period when /stop cannot be sent', async () => {
    h.sendOk = false;
    const r = await settle(stopServerGracefully('default', { reason: 'user' }));
    expect(r).toEqual({ ok: true, method: 'docker' });
    expect(docker.stopContainer).toHaveBeenCalledWith('default', 120);
  });

  it('does not send /stop while no server process runs (entrypoint still busy)', async () => {
    h.serverUp = false;
    const r = await settle(stopServerGracefully('default', { reason: 'setup' }));
    expect(r.method).toBe('docker');
    expect(h.sent).toEqual([]);
    expect(docker.stopContainer).toHaveBeenCalledWith('default', 10);
  });

  it('keeps the server down when a restart policy brought it straight back', async () => {
    h.onStop = 'policy-restart';
    const r = await settle(stopServerGracefully('default', { reason: 'user' }));
    expect(r).toEqual({ ok: true, method: 'command' });
    expect(h.log).toEqual(['stop-command', 'docker-stop']);
  });

  it('reports an already stopped server without touching it', async () => {
    h.state!.running = false;
    const r = await settle(stopServerGracefully('default', { reason: 'user' }));
    expect(r).toEqual({ ok: true, method: 'already_stopped' });
    expect(h.sent).toEqual([]);
    expect(publish).not.toHaveBeenCalled();
  });

  it('fails cleanly for an unknown container', async () => {
    h.state = null;
    const r = await settle(stopServerGracefully('default', { reason: 'user' }));
    expect(r).toMatchObject({ ok: false, error: 'Container not found' });
  });
});

describe('startServer / restartServerGracefully', () => {
  it('starts a stopped server and clears the exit guard of the start script', async () => {
    h.state!.running = false;
    const guard = path.join(dataDir, lifecycle.__test__.EXIT_GUARD_FILE);
    fs.writeFileSync(guard, `2 ${Math.floor(Date.now() / 1000)}\n`);
    const r = await settle(startServer(undefined, { reason: 'user' }));
    expect(r).toEqual({ ok: true, method: 'docker' });
    expect(fs.existsSync(guard)).toBe(false);
    expect(eventNames()).toEqual(['server.starting', 'server.started']);
  });

  it('does not start a running server twice', async () => {
    const r = await settle(startServer('default', { reason: 'user' }));
    expect(r).toEqual({ ok: true, method: 'already_running' });
    expect(docker.startContainer).not.toHaveBeenCalled();
  });

  it('restarts with /stop, then start', async () => {
    const r = await settle(restartServerGracefully('default', { reason: 'restart' }));
    expect(r).toEqual({ ok: true, method: 'command' });
    expect(h.log).toEqual(['stop-command', 'start']);
  });

  it('starts a stopped server on restart, like docker restart did', async () => {
    h.state!.running = false;
    const r = await settle(restartServerGracefully('default', { reason: 'restart' }));
    expect(r).toEqual({ ok: true, method: 'already_stopped' });
    expect(h.log).toEqual(['start']);
  });

  it('reports a failed start after the stop', async () => {
    h.startOk = false;
    const r = await settle(restartServerGracefully('default', { reason: 'restart' }));
    expect(r).toMatchObject({ ok: false, method: 'command', error: 'Start failed: boom' });
  });
});

describe('withServerStopped', () => {
  it('stops, runs the job and starts the server again', async () => {
    const r = await settle(
      withServerStopped('default', { reason: 'restore' }, async () => {
        h.log.push(`job(running=${h.state!.running})`);
        return 42;
      }),
    );
    expect(r).toBe(42);
    expect(h.log).toEqual(['stop-command', 'job(running=false)', 'start']);
  });

  it('starts the server again when the job throws, and rethrows the job error', async () => {
    const p = withServerStopped('default', { reason: 'update' }, async () => {
      throw new Error('swap failed');
    });
    await expect(settle(p)).rejects.toThrow('swap failed');
    expect(h.log).toEqual(['stop-command', 'start']);
  });

  it('does not run the job when the server cannot be stopped', async () => {
    vi.mocked(docker.stopContainer).mockResolvedValueOnce({ success: false, error: 'daemon gone' });
    h.sendOk = false;
    const job = vi.fn(async () => 'never');
    const p = withServerStopped('default', { reason: 'restore' }, job);
    await expect(settle(p)).rejects.toMatchObject({ name: 'LifecycleError', phase: 'stop' });
    expect(job).not.toHaveBeenCalled();
  });

  it('reports a server that does not come back after a successful job', async () => {
    h.startOk = false;
    const p = withServerStopped('default', { reason: 'restore' }, async () => 'done');
    await expect(settle(p)).rejects.toBeInstanceOf(LifecycleError);
  });

  it('leaves a stopped server stopped', async () => {
    h.state!.running = false;
    const r = await settle(withServerStopped('default', { reason: 'restore' }, async () => 'ok'));
    expect(r).toBe('ok');
    expect(h.log).toEqual([]);
  });

  it('lets the job use the lifecycle for the same server without deadlocking', async () => {
    const r = await settle(
      withServerStopped('default', { reason: 'update' }, () =>
        stopServerGracefully('default', { reason: 'update' }),
      ),
    );
    expect(r).toEqual({ ok: true, method: 'already_stopped' });
  });

  it('serializes operations on the same server and reports the active one', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const restore = withServerStopped('default', { reason: 'restore' }, async () => {
      h.log.push('restore-job');
      await gate;
    });
    await vi.advanceTimersByTimeAsync(2000);
    expect(getActiveOperation('default')?.reason).toBe('restore');

    const restart = restartServerGracefully('default', { reason: 'scheduled' });
    await vi.advanceTimersByTimeAsync(5000);
    expect(h.log).toEqual(['stop-command', 'restore-job']); // restart still waits

    release();
    await settle(Promise.all([restore, restart]));
    expect(h.log).toEqual(['stop-command', 'restore-job', 'start', 'stop-command', 'start']);
    expect(getActiveOperation('default')).toBeNull();
  });

  it('with rejectIfBusy refuses a second action instead of running it after the first', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const first = withServerStopped(
      'default',
      { reason: 'rollback', rejectIfBusy: true },
      async () => {
        h.log.push('rollback-1');
        await gate;
      },
    );
    await vi.advanceTimersByTimeAsync(2000);
    expect(lifecycle.isLifecycleBusy('default')).toBe(true);

    // A second click: refused at once, its job never runs, nothing is stopped or started.
    const second = vi.fn(async () => h.log.push('rollback-2'));
    await expect(
      withServerStopped('default', { reason: 'rollback', rejectIfBusy: true }, second),
    ).rejects.toBeInstanceOf(lifecycle.LifecycleBusyError);
    await expect(
      startServer('default', { reason: 'update', rejectIfBusy: true }),
    ).rejects.toBeInstanceOf(lifecycle.LifecycleBusyError);

    release();
    await settle(first);
    expect(second).not.toHaveBeenCalled();
    expect(h.log).toEqual(['stop-command', 'rollback-1', 'start']);
    expect(lifecycle.isLifecycleBusy('default')).toBe(false);

    // Once it is done the next one runs normally.
    await settle(withServerStopped('default', { reason: 'rollback', rejectIfBusy: true }, second));
    expect(second).toHaveBeenCalledTimes(1);
  });

  it('lets two simultaneous calls with rejectIfBusy run exactly one job', async () => {
    const jobs: string[] = [];
    const a = withServerStopped('default', { reason: 'config', rejectIfBusy: true }, async () => {
      jobs.push('a');
    });
    const b = withServerStopped('default', { reason: 'config', rejectIfBusy: true }, async () => {
      jobs.push('b');
    });
    const results = await settle(Promise.allSettled([a, b]));
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(jobs).toHaveLength(1);
  });
});

describe('countdown', () => {
  it('plans notify warnings, one event title in the last minute and a save before the stop', () => {
    const plan = buildCountdownPlan({
      countdownSeconds: 1800,
      action: 'restart',
      finalMessage: 'Restarting now!',
    });
    expect(plan).toEqual([
      { secondsLeft: 1800, commands: ['/notify warning Server restart in 30 minutes.'] },
      { secondsLeft: 900, commands: ['/notify warning Server restart in 15 minutes.'] },
      { secondsLeft: 300, commands: ['/notify warning Server restart in 5 minutes.'] },
      {
        secondsLeft: 60,
        commands: [
          '/notify warning Server restart in 1 minute.',
          '/eventtitle Server restart in 1 minute.',
        ],
      },
      { secondsLeft: 30, commands: ['/notify warning Server restart in 30 seconds.'] },
      {
        secondsLeft: 10,
        commands: ['/notify warning Server restart in 10 seconds.', '/world save --all --confirm'],
      },
      { secondsLeft: 0, commands: ['/notify danger Restarting now!'] },
    ]);
  });

  it('starts a short countdown with the title and honours custom warning points', () => {
    const plan = buildCountdownPlan({
      countdownSeconds: 45,
      action: 'stop',
      message: 'Down in {time} ({minutes} min)',
      warningSeconds: [20],
    });
    expect(plan.map((s) => [s.secondsLeft, s.commands])).toEqual([
      [
        45,
        ['/notify warning Down in 45 seconds (1 min)', '/eventtitle Down in 45 seconds (1 min)'],
      ],
      [20, ['/notify warning Down in 20 seconds (1 min)']],
      [10, ['/world save --all --confirm']],
    ]);
  });

  it('makes free text safe for the console and the command parser', () => {
    expect(toConsoleText('Don\'t "panic"\n/op add Evil [now]')).toBe(
      'Don’t ”panic” /op add Evil (now)',
    );
    expect(toConsoleText('{"text":"x"}')).toMatch(/^\(/);
    expect(toConsoleText('x'.repeat(500))).toHaveLength(200);
  });

  it('announces on schedule and then stops', async () => {
    const p = restartServerGracefully('default', {
      reason: 'scheduled',
      countdownSeconds: 70,
      warningSeconds: [60, 10],
    });
    await vi.advanceTimersByTimeAsync(100);
    expect(h.sent).toEqual(['/notify warning Server restart in 70 seconds.']);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(h.sent.slice(1)).toEqual([
      '/notify warning Server restart in 1 minute.',
      '/eventtitle Server restart in 1 minute.',
    ]);
    await vi.advanceTimersByTimeAsync(50_000);
    expect(h.sent.at(-1)).toBe('/world save --all --confirm');
    expect(h.sent).not.toContain('/stop');
    const r = await settle(p);
    expect(r.ok).toBe(true);
    expect(h.sent.at(-1)).toBe('/stop');
  });

  it('can be cancelled during the countdown without touching the server', async () => {
    const abort = new AbortController();
    const p = stopServerGracefully('default', {
      reason: 'scheduled',
      countdownSeconds: 300,
      signal: abort.signal,
    });
    await vi.advanceTimersByTimeAsync(1000);
    abort.abort();
    const r = await settle(p);
    expect(r).toEqual({ ok: false, method: 'cancelled', error: 'Cancelled' });
    expect(h.sent).not.toContain('/stop');
    expect(h.state!.running).toBe(true);
  });

  it('skips the countdown when the server is not running', async () => {
    h.state!.running = false;
    const r = await settle(
      restartServerGracefully('default', { reason: 'scheduled', countdownSeconds: 600 }),
      2000,
    );
    expect(r.method).toBe('already_stopped');
    expect(h.sent).toEqual([]);
  });
});

describe('stopServerAndRun (deleting an instance)', () => {
  it('stops with /stop, waits for the exit and runs the job without starting again', async () => {
    const r = await settle(
      lifecycle.stopServerAndRun('default', { reason: 'delete' }, async () => {
        h.log.push(`remove(running=${h.state!.running})`);
        return 'removed';
      }),
    );
    expect(r).toBe('removed');
    expect(h.log).toEqual(['stop-command', 'remove(running=false)']);
    expect(docker.stopContainer).not.toHaveBeenCalled();
    expect(docker.startContainer).not.toHaveBeenCalled();
    expect(eventNames()).toEqual(['server.stopping', 'server.stopped']);
  });

  it('runs the job right away for a stopped or missing container', async () => {
    h.state!.running = false;
    expect(
      await settle(lifecycle.stopServerAndRun('default', { reason: 'delete' }, async () => 1)),
    ).toBe(1);
    h.state = null;
    expect(
      await settle(lifecycle.stopServerAndRun('default', { reason: 'delete' }, async () => 2)),
    ).toBe(2);
    expect(h.log).toEqual([]);
  });

  it('does not run the job when the server cannot be stopped', async () => {
    vi.mocked(docker.stopContainer).mockResolvedValueOnce({ success: false, error: 'daemon gone' });
    h.sendOk = false;
    const job = vi.fn(async () => 'never');
    const p = lifecycle.stopServerAndRun('default', { reason: 'delete' }, job);
    await expect(settle(p)).rejects.toMatchObject({ name: 'LifecycleError', phase: 'stop' });
    expect(job).not.toHaveBeenCalled();
  });

  it('waits for, or with rejectIfBusy refuses, a restore running on the same server', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const restore = withServerStopped('default', { reason: 'restore' }, async () => {
      h.log.push('restore-job');
      await gate;
    });
    await vi.advanceTimersByTimeAsync(2000);

    const job = vi.fn(async () => 'never');
    await expect(
      lifecycle.stopServerAndRun('default', { reason: 'delete', rejectIfBusy: true }, job),
    ).rejects.toMatchObject({ name: 'LifecycleBusyError' });

    const queued = lifecycle.stopServerAndRun('default', { reason: 'delete' }, async () => {
      h.log.push('remove');
    });
    await vi.advanceTimersByTimeAsync(5000);
    expect(h.log).toEqual(['stop-command', 'restore-job']); // the delete waits for the restore

    release();
    await settle(Promise.all([restore, queued]));
    expect(h.log).toEqual(['stop-command', 'restore-job', 'start', 'stop-command', 'remove']);
    expect(job).not.toHaveBeenCalled();
  });
});
