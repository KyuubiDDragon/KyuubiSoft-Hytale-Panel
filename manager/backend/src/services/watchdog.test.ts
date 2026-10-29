/**
 * Watchdog crash detection vs. deliberate stops.
 *
 * Every UI action goes through the legacy routes, which call the Docker
 * service WITHOUT a server id, while the watchdog polls with the concrete
 * registry id. These tests pin that both sides agree on the key: a UI stop,
 * restart or console stop followed by a watchdog tick must not be reported as
 * a crash (nor auto-restarted), while a real unexpected stop still is.
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
const start = vi.fn(async () => {
  running = true;
});
const fakeContainer = {
  inspect: vi.fn(async () => ({
    Id: 'game00000001',
    Name: '/kptest-game',
    Created: '',
    State: { Status: running ? 'running' : 'exited', Running: running, StartedAt: '' },
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
  escapeShellArg: (s: string) => s,
}));

let tick: () => Promise<void>;
let docker: typeof import('./docker.js');

beforeAll(async () => {
  docker = await import('./docker.js');
  tick = (await import('./watchdog.js')).__test__.tick;
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
  await tick(); // observe "running" so the next stop is a transition
  publish.mockClear();
});

const crashEvents = () => publish.mock.calls.filter((c) => c[0] === 'server.crashed');

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
});
