/**
 * Watchdog low-TPS alarm fed by per-world tps_update frames: the threshold is
 * relative to the world's target rate (default 75 % of 30 TPS).
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from 'vitest';
import path from 'path';
import os from 'os';
import fs from 'fs';

const tmpDir = path.join(os.tmpdir(), `kp-watchdog-tps-${Date.now()}`);
fs.mkdirSync(tmpDir, { recursive: true });
process.env.MANAGER_DATA_PATH = tmpDir;
process.env.GAME_CONTAINER_NAME = 'kptest-game';
process.env.WATCHDOG_AUTO_RESTART = 'false';
process.env.WATCHDOG_MEM_ALERT_PERCENT = '0';
process.env.WATCHDOG_DISK_ALERT_MIN_GB = '0';
delete process.env.WATCHDOG_TPS_ALERT;
delete process.env.WATCHDOG_TPS_ALERT_PERCENT;
delete process.env.DEMO_MODE;

const fakeContainer = {
  inspect: vi.fn(async () => ({
    Id: 'game00000001',
    Name: '/kptest-game',
    Created: '',
    State: { Status: 'running', Running: true, StartedAt: '' },
  })),
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
let tpsState: typeof import('./tpsState.js');

beforeAll(async () => {
  tpsState = await import('./tpsState.js');
  tick = (await import('./watchdog.js')).__test__.tick;
});

afterAll(() => {
  vi.useRealTimers();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

let clock = Date.UTC(2026, 0, 1);
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  // Past the alert cooldown of the previous test.
  clock += 60 * 60_000;
  vi.setSystemTime(clock);
  publish.mockClear();
  tpsState.clearTpsState();
});

const lowTpsAlerts = () =>
  publish.mock.calls.filter(
    (c) => c[0] === 'server.alert' && (c[1] as { reason?: string }).reason === 'low_tps',
  );

function frame(world: string, tps: number, minuteAvg?: number) {
  tpsState.recordServerTick({
    serverId: 'default',
    world,
    tps,
    mspt: 12.5,
    targetTps: 30,
    windows: minuteAvg === undefined ? undefined : [{ window: '1m', tpsAvg: minuteAvg }],
  });
}

describe('watchdog low-TPS alarm', () => {
  it('stays quiet at the normal 30 TPS (no more false 20-TPS ceiling)', async () => {
    frame('default', 30, 30);
    await tick();
    expect(lowTpsAlerts()).toHaveLength(0);
  });

  it('alerts for a world below 75 % of its target and names it', async () => {
    frame('default', 30, 30);
    frame('dungeon-7', 18, 19.5);
    await tick();

    expect(lowTpsAlerts()).toHaveLength(1);
    expect(lowTpsAlerts()[0][1]).toMatchObject({
      serverId: 'default',
      world: 'dungeon-7',
      tps: 19.5,
      targetTps: 30,
      percentOfTarget: 65,
      threshold: 22.5,
      thresholdPercent: 75,
    });
  });

  it('ignores readings older than the stale window', async () => {
    frame('default', 10, 10);
    clock += 2 * 60_000;
    vi.setSystemTime(clock);
    await tick();
    expect(lowTpsAlerts()).toHaveLength(0);
  });

  it('does not repeat the alert within the cooldown', async () => {
    frame('default', 10, 10);
    await tick();
    frame('default', 10, 10);
    await tick();
    expect(lowTpsAlerts()).toHaveLength(1);
  });
});
