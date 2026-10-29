/**
 * The watchdog's two kinds of findings side by side: exits read from Docker's
 * events and container state (why a server stopped), and the per-world lag
 * alarm fed by tps_update frames (relative to the world's target rate). Both
 * run in the same poll and must neither hide nor duplicate each other.
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from 'vitest';
import path from 'path';
import os from 'os';
import fs from 'fs';

const tmpDir = path.join(os.tmpdir(), `kp-watchdog-combined-${Date.now()}`);
fs.mkdirSync(tmpDir, { recursive: true });
process.env.MANAGER_DATA_PATH = tmpDir;
process.env.GAME_CONTAINER_NAME = 'kptest-game';
process.env.WATCHDOG_AUTO_RESTART = 'true';
process.env.WATCHDOG_MEM_ALERT_PERCENT = '0';
process.env.WATCHDOG_DISK_ALERT_MIN_GB = '0';
// The default: 75 % of each world's target, no absolute threshold.
delete process.env.WATCHDOG_TPS_ALERT;
delete process.env.WATCHDOG_TPS_ALERT_PERCENT;
delete process.env.DEMO_MODE;

let running = true;
let exitCode = 1;
let startedAt = 'run-1';

const start = vi.fn(async () => {
  running = true;
  startedAt = `run-started-${Date.now()}`;
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
      OOMKilled: false,
    },
  })),
  start,
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

let tick: () => Promise<void>;
let onDockerEvent: (evt: object) => Promise<void>;
let tpsState: typeof import('./tpsState.js');

beforeAll(async () => {
  tpsState = await import('./tpsState.js');
  const wd = (await import('./watchdog.js')).__test__;
  tick = wd.tick;
  onDockerEvent = wd.onDockerEvent;
});

afterAll(() => {
  vi.useRealTimers();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// Every test starts past the alert cooldowns and restart windows of the last.
let clock = Date.UTC(2026, 0, 1);
beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  clock += 60 * 60_000;
  vi.setSystemTime(clock);
  vi.clearAllMocks();
  running = true;
  exitCode = 1;
  startedAt = `run-${clock}`;
  tpsState.clearTpsState();
  await tick(); // observe "running" so the next stop is a transition
  publish.mockClear();
});

const eventsNamed = (name: string) => publish.mock.calls.filter((c) => c[0] === name);
const alerts = (reason: string) =>
  eventsNamed('server.alert').filter((c) => (c[1] as { reason?: string }).reason === reason);
const die = (code: number) =>
  onDockerEvent({
    Action: 'die',
    Actor: { Attributes: { name: 'kptest-game', exitCode: String(code) } },
  });

function lag(world: string, minuteAvg: number) {
  tpsState.recordServerTick({
    serverId: 'default',
    world,
    tps: minuteAvg,
    mspt: 40,
    targetTps: 30,
    windows: [{ window: '1m', tpsAvg: minuteAvg }],
  });
}

describe('watchdog: exits and lag together', () => {
  it('raises the lag alarm of a running server and later reports its crash from the die event', async () => {
    lag('default', 30);
    lag('dungeon-7', 15);
    await tick();
    expect(alerts('low_tps')).toHaveLength(1);
    expect(alerts('low_tps')[0][1]).toMatchObject({ world: 'dungeon-7', thresholdPercent: 75 });

    exitCode = 1;
    running = false;
    await die(1);
    expect(eventsNamed('server.crashed')).toHaveLength(1);
    expect(eventsNamed('server.crashed')[0][1]).toMatchObject({ exitCode: 1, reason: 'crash' });
  });

  it('gives no lag alarm for a stopped server, although its last readings are fresh', async () => {
    lag('default', 10);
    running = false;
    await die(1);
    await tick();
    expect(alerts('low_tps')).toHaveLength(0);
    // Reported once by the event; the poll does not report the same exit again.
    expect(eventsNamed('server.crashed')).toHaveLength(1);
    expect(start).toHaveBeenCalledOnce(); // auto-restart, still down at the poll
  });

  it('reports a crash Docker restarted between two polls and the lag in the same poll', async () => {
    lag('default', 12);
    startedAt = 'run-restarted-by-docker';
    await tick();
    expect(eventsNamed('server.crashed')).toHaveLength(1);
    expect(eventsNamed('server.crashed')[0][1]).toMatchObject({ reason: 'restarted_by_docker' });
    expect(alerts('low_tps')).toHaveLength(1);
    expect(start).not.toHaveBeenCalled();
  });

  it('treats a clean /stop (exit 0) as a stop, without a crash or a lag alarm', async () => {
    lag('default', 10);
    exitCode = 0;
    running = false;
    await die(0);
    await tick();
    expect(eventsNamed('server.stopped')).toHaveLength(1);
    expect(eventsNamed('server.crashed')).toHaveLength(0);
    expect(alerts('low_tps')).toHaveLength(0);
    expect(start).not.toHaveBeenCalled();
  });
});
