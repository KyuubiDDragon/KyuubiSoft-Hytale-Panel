/**
 * Watchdog crash detection vs. deliberate stops, and exit-code handling.
 *
 * Every UI action goes through the legacy routes, which call the Docker
 * service WITHOUT a server id, while the watchdog polls with the concrete
 * registry id. These tests pin that both sides agree on the key: a UI stop,
 * restart or console stop followed by a watchdog tick must not be reported as
 * a crash (nor auto-restarted), while a real unexpected stop still is.
 *
 * The exit code decides what an unexpected stop is: a clean /stop or a signal
 * is no crash, an unrecoverable failure is reported but never restarted, and
 * Docker's `die` events catch crashes the restart policy hides from polling.
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from 'vitest';
import path from 'path';
import os from 'os';
import fs from 'fs';

const tmpDir = path.join(os.tmpdir(), `kp-watchdog-${Date.now()}`);
fs.mkdirSync(tmpDir, { recursive: true });
process.env.MANAGER_DATA_PATH = tmpDir;
process.env.GAME_CONTAINER_NAME = 'kptest-game';
process.env.WATCHDOG_AUTO_RESTART = 'true';
process.env.WATCHDOG_MEM_ALERT_PERCENT = '0';
process.env.WATCHDOG_TPS_ALERT = '0';
process.env.WATCHDOG_DISK_ALERT_MIN_GB = '0';
delete process.env.DEMO_MODE;

let running = true;
let exitCode = 1;
let oomKilled = false;
let runNo = 1;
let startedAt = 'run-1';
let activeOp: { reason: string; since: number } | null = null;

const start = vi.fn(async () => {
  running = true;
  startedAt = `run-${++runNo}`;
});
const fakeContainer = {
  inspect: vi.fn(async () => ({
    Id: 'game00000001',
    Name: '/kptest-game',
    Created: '',
    RestartCount: 0,
    State: {
      Status: running ? 'running' : 'exited',
      Running: running,
      StartedAt: startedAt,
      ExitCode: running ? 0 : exitCode,
      OOMKilled: oomKilled,
    },
  })),
  start,
  stop: vi.fn(async () => {
    running = false;
  }),
  restart: vi.fn(async () => {
    running = true;
  }),
  attach: vi.fn(async () => ({ write: vi.fn(), on: vi.fn() })),
};

const publish = vi.fn();
vi.mock('./dockerClient.js', () => ({
  createDockerClient: () => ({ getContainer: () => fakeContainer }),
}));
vi.mock('./eventBus.js', () => ({
  publish: (...a: unknown[]) => publish(...a),
  eventBus: { subscribe: vi.fn() },
}));
vi.mock('./players.js', () => ({ clearOnlinePlayers: vi.fn() }));
// Command validation is covered by its own tests; keep this file independent of it.
vi.mock('../utils/sanitize.js', () => ({
  validateCommand: () => ({ valid: true }),
  containsControlChars: () => false,
  stripControlChars: (s: string) => s,
}));
vi.mock('./serverLifecycle.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./serverLifecycle.js')>()),
  getActiveOperation: () => activeOp,
}));

let tick: () => Promise<void>;
let onDockerEvent: (evt: object) => Promise<void>;
let docker: typeof import('./docker.js');

beforeAll(async () => {
  docker = await import('./docker.js');
  const wd = (await import('./watchdog.js')).__test__;
  tick = wd.tick;
  onDockerEvent = wd.onDockerEvent;
});

afterAll(() => {
  vi.useRealTimers();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// Each test starts well past the intentional-stop grace window and the
// auto-restart window of the previous one, so markers never leak across.
let clock = Date.UTC(2026, 0, 1);
beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  clock += 60 * 60_000;
  vi.setSystemTime(clock);
  vi.clearAllMocks();
  running = true;
  exitCode = 1;
  oomKilled = false;
  activeOp = null;
  await tick(); // observe "running" so the next stop is a transition
  publish.mockClear();
});

const eventsNamed = (name: string) => publish.mock.calls.filter((c) => c[0] === name);
const crashEvents = () => eventsNamed('server.crashed');
const die = (code: number | string, name = 'kptest-game') =>
  onDockerEvent({ Action: 'die', Actor: { Attributes: { name, exitCode: String(code) } } });

describe('watchdog crash detection', () => {
  it('reports an unexpected stop as a crash and auto-restarts', async () => {
    running = false;
    await tick();
    expect(crashEvents()).toHaveLength(1);
    expect(crashEvents()[0][2]).toBe('default');
    expect(start).toHaveBeenCalledOnce();
  });

  it('does not report a UI stop (legacy call without server id) as a crash', async () => {
    const r = await docker.stopContainer();
    expect(r.success).toBe(true);
    await tick();
    expect(crashEvents()).toHaveLength(0);
    expect(start).not.toHaveBeenCalled();
  });

  it('does not report a stop through the scoped route as a crash', async () => {
    await docker.stopContainer('default');
    await tick();
    expect(crashEvents()).toHaveLength(0);
  });

  it('does not report a UI restart caught mid-cycle as a crash', async () => {
    await docker.restartContainer();
    running = false; // the poll lands while the container is still down
    await tick();
    expect(crashEvents()).toHaveLength(0);
    expect(start).not.toHaveBeenCalled();
  });

  it('does not report a console /stop as a crash', async () => {
    const r = await docker.execCommand('/stop');
    expect(r.success).toBe(true);
    running = false; // the server process exits and takes the container down
    await tick();
    expect(crashEvents()).toHaveLength(0);
  });

  it('still reports /stop --crash as a crash', async () => {
    await docker.execCommand('/stop --crash');
    running = false;
    exitCode = 1; // Hytale 0.7 exits with its "crash" code
    await tick();
    expect(crashEvents()).toHaveLength(1);
  });

  it('reports a crash again once the grace window after a UI stop has passed', async () => {
    await docker.stopContainer();
    running = true;
    await tick();
    clock += 5 * 60_000;
    vi.setSystemTime(clock);
    running = false;
    await tick();
    expect(crashEvents()).toHaveLength(1);
  });

  it('leaves a server alone while a lifecycle operation holds it', async () => {
    activeOp = { reason: 'restore', since: Date.now() };
    running = false;
    await tick();
    expect(crashEvents()).toHaveLength(0);
    expect(start).not.toHaveBeenCalled();
  });
});

describe('watchdog exit codes', () => {
  it('treats a /stop from inside the game (exit 0) as a stop, not a crash', async () => {
    running = false;
    exitCode = 0;
    await tick();
    expect(crashEvents()).toHaveLength(0);
    expect(eventsNamed('server.stopped')[0][1]).toMatchObject({ exitCode: 0, reason: 'normal' });
    expect(start).not.toHaveBeenCalled();
  });

  it('treats a docker stop outside the panel (exit 143) as a stop', async () => {
    running = false;
    exitCode = 143;
    await tick();
    expect(crashEvents()).toHaveLength(0);
    expect(eventsNamed('server.stopped')[0][1]).toMatchObject({ reason: 'stopped_by_signal' });
    expect(start).not.toHaveBeenCalled();
  });

  it('reports an auth failure (exit 2) with a hint and never auto-restarts it', async () => {
    running = false;
    exitCode = 2;
    await tick();
    expect(crashEvents()).toHaveLength(1);
    expect(crashEvents()[0][1]).toMatchObject({
      exitCode: 2,
      reason: 'auth_failed',
      restartable: false,
    });
    expect(String(crashEvents()[0][1].hint)).toMatch(/\/auth login device/);
    expect(start).not.toHaveBeenCalled();
  });

  it('never auto-restarts a mod error (exit 9)', async () => {
    running = false;
    exitCode = 9;
    await tick();
    expect(crashEvents()[0][1]).toMatchObject({ reason: 'mod_error', restartable: false });
    expect(start).not.toHaveBeenCalled();
  });

  it('reports an OOM kill with a memory alert and restarts it', async () => {
    running = false;
    exitCode = 137;
    oomKilled = true;
    await tick();
    expect(crashEvents()[0][1]).toMatchObject({ exitCode: 137, reason: 'out_of_memory' });
    expect(eventsNamed('server.alert').map((c) => c[1].reason)).toContain('out_of_memory');
    expect(start).toHaveBeenCalledOnce();
  });

  it('notices a crash that Docker restarted between two polls (start time changed)', async () => {
    startedAt = 'run-restarted-by-docker'; // still running, but a new run
    await tick();
    expect(crashEvents()).toHaveLength(1);
    expect(crashEvents()[0][1]).toMatchObject({ reason: 'restarted_by_docker' });
    expect(start).not.toHaveBeenCalled(); // it is running again already
  });
});

describe('watchdog Docker events', () => {
  it('reports a crash from a die event although Docker restarted the container before the poll', async () => {
    await die(1);
    expect(crashEvents()).toHaveLength(1);
    expect(crashEvents()[0][1]).toMatchObject({ exitCode: 1, reason: 'crash' });
    startedAt = 'run-after-policy-restart'; // restart policy brought it back
    await tick();
    expect(crashEvents()).toHaveLength(1); // not reported twice
    expect(start).not.toHaveBeenCalled(); // Docker already restarted it
  });

  it('restarts after a die event when the next poll still finds the server down', async () => {
    await die(1);
    running = false;
    await tick();
    expect(crashEvents()).toHaveLength(1);
    expect(start).toHaveBeenCalledOnce();
  });

  it('drops a queued restart when the panel holds the server before the next poll', async () => {
    await die(1); // queued for the next poll
    running = false;
    activeOp = { reason: 'restore', since: Date.now() };
    await tick();
    activeOp = null;
    await tick();
    expect(crashEvents()).toHaveLength(1);
    expect(start).not.toHaveBeenCalled();
  });

  it('drops a queued restart when Stop is clicked on the crashed server', async () => {
    await die(1);
    running = false;
    const { stopServerGracefully } = await import('./serverLifecycle.js');
    expect(await stopServerGracefully('default', { reason: 'user' })).toMatchObject({
      ok: true,
      method: 'already_stopped',
    });
    await tick();
    expect(start).not.toHaveBeenCalled();
  });

  it('notifies once when Docker retries an unrecoverable exit', async () => {
    await die(2);
    await die(2);
    await die(2);
    expect(crashEvents()).toHaveLength(1);
    running = false;
    await tick();
    expect(start).not.toHaveBeenCalled();
  });

  it('marks a kill after an oom event as out of memory', async () => {
    await onDockerEvent({ Action: 'oom', Actor: { Attributes: { name: 'kptest-game' } } });
    await die(137);
    expect(crashEvents()[0][1]).toMatchObject({ reason: 'out_of_memory' });
  });

  it('ignores the die event of a deliberate stop', async () => {
    await docker.stopContainer();
    await die(143);
    expect(crashEvents()).toHaveLength(0);
    expect(eventsNamed('server.stopped')).toHaveLength(0);
  });

  it('ignores containers that are not registered servers', async () => {
    await die(1, 'some-other-container');
    expect(publish).not.toHaveBeenCalled();
  });
});
