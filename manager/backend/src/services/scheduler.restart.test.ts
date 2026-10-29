/**
 * Scheduled restarts run through the graceful lifecycle (countdown in game,
 * /stop, wait, start) instead of `docker restart`; skipped, cancelled and
 * finished slots are not planned again; the welcome message is an Event
 * Action rule kept in sync with the scheduler settings.
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kp-sched-restart-'));
process.env.MANAGER_DATA_PATH = tmpDir;
process.env.DATA_PATH = tmpDir;

const h = vi.hoisted(() => ({
  running: true,
  online: [] as Array<{ name: string }>,
  rules: new Map<string, Record<string, unknown>>(),
}));

vi.mock('./servers.js', () => ({
  ensureLoaded: async () => ({ schemaVersion: 2, defaultId: 'default', servers: [] }),
  getDefaultId: async () => 'default',
  resolveServerId: async (id?: string) => id || 'default',
  resolveServerIdSync: (id?: string) => id || 'default',
  isComposeServer: (s: { id: string }) => s.id === 'default',
  getServer: async (id: string) => ({ id, paths: { data: tmpDir } }),
  listServers: async () => [{ id: 'default' }],
  onServerAdded: () => () => undefined,
  onServerDeleted: () => () => undefined,
}));
vi.mock('./docker.js', () => ({
  getStatus: vi.fn(async () => ({ status: 'running', running: h.running })),
  execCommand: vi.fn(async () => ({ success: true })),
  sendLifecycleCommand: vi.fn(async () => ({ success: true })),
}));
vi.mock('./backup.js', () => ({
  createBackup: vi.fn(async () => ({ success: true, backup: { filename: 'b.tar.gz' } })),
  listBackups: vi.fn(async () => []),
  deleteBackup: vi.fn(async () => ({ success: true })),
  isAutomaticBackupId: () => false,
}));
vi.mock('./players.js', () => ({ getOnlinePlayers: vi.fn(async () => h.online) }));
vi.mock('./commandPolicy.js', () => ({
  authorizeCommand: vi.fn(async () => ({ allowed: true })),
  authorizeStoredCommand: vi.fn(async () => ({ allowed: true })),
  reportSkippedCommand: vi.fn(),
  storedCommandBlockedReason: vi.fn(async () => null),
}));
vi.mock('./eventActions.js', () => ({
  createEventAction: vi.fn((input: Record<string, unknown>) => {
    const rule = { ...input, id: `ea-${h.rules.size + 1}`, enabled: true };
    h.rules.set(rule.id, rule);
    return rule;
  }),
  getEventAction: vi.fn((id: string) => h.rules.get(id) ?? null),
  updateEventAction: vi.fn((id: string, updates: Record<string, unknown>) => {
    const rule = { ...h.rules.get(id), ...updates };
    h.rules.set(id, rule);
    return rule;
  }),
}));
vi.mock('./serverLifecycle.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./serverLifecycle.js')>();
  return {
    LifecycleError: actual.LifecycleError,
    restartServerGracefully: vi.fn(async () => ({ ok: true, method: 'command' })),
    withServerStopped: vi.fn(async (_id: string, _opts: unknown, fn: () => Promise<unknown>) =>
      fn(),
    ),
  };
});

const lifecycle = await import('./serverLifecycle.js');
const docker = await import('./docker.js');
const backup = await import('./backup.js');
const eventActions = await import('./eventActions.js');
const scheduler = await import('./scheduler.js');

const flush = () => vi.advanceTimersByTimeAsync(1);
const at = (iso: string) => new Date(iso).getTime();

async function plan(restart: Record<string, unknown>): Promise<void> {
  await scheduler.saveConfig(
    {
      scheduledRestarts: {
        enabled: true,
        times: ['03:00'],
        warningMinutes: [30, 15, 5, 1],
        warningMessage: 'Restart in {time}!',
        restartMessage: 'Restarting now!',
        createBackup: false,
        onlyWhenEmpty: false,
        ...restart,
      },
    } as never,
    'default',
  );
  await flush();
  await flush();
}

const pendingAt = async () =>
  (await scheduler.getSchedulerStatus('default')).scheduledRestarts.pendingRestart?.scheduledAt;

beforeAll(async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-22T02:00:00'));
  await scheduler.startSchedulers();
});

beforeEach(() => {
  vi.clearAllMocks();
  h.running = true;
  h.online = [];
});

afterAll(() => {
  scheduler.stopSchedulers();
  vi.useRealTimers();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('scheduled restart plan', () => {
  it('starts the countdown at the first warning and restarts through the lifecycle', async () => {
    vi.setSystemTime(new Date('2026-10-22T02:00:00'));
    await plan({});
    expect(await pendingAt()).toBe(new Date('2026-10-22T03:00:00').toISOString());

    await vi.advanceTimersByTimeAsync(29 * 60_000);
    expect(lifecycle.restartServerGracefully).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(60_000 + 10);

    expect(lifecycle.restartServerGracefully).toHaveBeenCalledOnce();
    const [id, opts] = vi.mocked(lifecycle.restartServerGracefully).mock.calls[0];
    expect(id).toBe('default');
    expect(opts).toMatchObject({
      reason: 'scheduled',
      countdownSeconds: 1800,
      warningSeconds: [1800, 900, 300, 60],
      message: 'Restart in {time}!',
      finalMessage: 'Restarting now!',
    });
    expect(opts.signal).toBeInstanceOf(AbortSignal);
    // Done: the next slot is tomorrow, not today's again.
    expect(await pendingAt()).toBe(new Date('2026-10-23T03:00:00').toISOString());
  });

  it('takes the backup while the server is stopped', async () => {
    vi.setSystemTime(new Date('2026-10-23T02:40:00'));
    await plan({ createBackup: true });
    await vi.advanceTimersByTimeAsync(20 * 60_000);
    expect(lifecycle.withServerStopped).toHaveBeenCalledOnce();
    expect(lifecycle.restartServerGracefully).not.toHaveBeenCalled();
    expect(backup.createBackup).toHaveBeenCalledWith(
      { kind: 'auto', label: 'scheduled_restart' },
      'default',
    );
    // 20 minutes left when it was planned: the countdown is shortened.
    expect(vi.mocked(lifecycle.withServerStopped).mock.calls[0][1]).toMatchObject({
      countdownSeconds: 1200,
    });
  });

  it('skips the slot when the server is not running', async () => {
    vi.setSystemTime(new Date('2026-10-24T02:00:00'));
    await plan({});
    h.running = false;
    await vi.advanceTimersByTimeAsync(31 * 60_000);
    expect(lifecycle.restartServerGracefully).not.toHaveBeenCalled();
    expect(await pendingAt()).toBe(new Date('2026-10-25T03:00:00').toISOString());
  });

  it('only when empty: no countdown, and skipped while players are online', async () => {
    vi.setSystemTime(new Date('2026-11-02T02:00:00'));
    await plan({ onlyWhenEmpty: true });
    h.online = [{ name: 'Alice' }];
    await vi.advanceTimersByTimeAsync(31 * 60_000);
    expect(docker.getStatus).not.toHaveBeenCalled(); // nothing happens at T-30
    await vi.advanceTimersByTimeAsync(30 * 60_000);
    expect(lifecycle.restartServerGracefully).not.toHaveBeenCalled();
    expect(await pendingAt()).toBe(new Date('2026-11-03T03:00:00').toISOString());
  });

  it('only when empty: restarts right away on an empty server', async () => {
    vi.setSystemTime(new Date('2026-11-03T02:59:00'));
    await plan({ onlyWhenEmpty: true });
    await vi.advanceTimersByTimeAsync(61_000);
    expect(vi.mocked(lifecycle.restartServerGracefully).mock.calls[0][1]).toMatchObject({
      countdownSeconds: 0,
    });
  });

  it('cancelling during the countdown aborts it, tells the players and skips the slot', async () => {
    vi.setSystemTime(new Date('2026-11-04T02:29:00'));
    vi.mocked(lifecycle.restartServerGracefully).mockImplementationOnce(
      (_id, opts) =>
        new Promise((resolve) =>
          opts.signal?.addEventListener('abort', () =>
            resolve({ ok: false, method: 'cancelled', error: 'Cancelled' }),
          ),
        ),
    );
    await plan({});
    await vi.advanceTimersByTimeAsync(61_000); // countdown running now
    expect((await scheduler.getSchedulerStatus('default')).scheduledRestarts.countdownRunning).toBe(
      true,
    );

    expect(scheduler.cancelPendingRestart('default')).toBe(true);
    await flush();
    expect(docker.sendLifecycleCommand).toHaveBeenCalledWith(
      '/notify warning The scheduled restart was cancelled.',
      'default',
    );
    expect(await pendingAt()).toBe(new Date('2026-11-05T03:00:00').toISOString());
    await vi.advanceTimersByTimeAsync(40 * 60_000);
    expect(lifecycle.restartServerGracefully).toHaveBeenCalledOnce(); // not re-armed for today
  });

  it('cancelling before the countdown skips today without announcing anything', async () => {
    vi.setSystemTime(new Date('2026-11-05T01:00:00'));
    await plan({});
    expect(scheduler.cancelPendingRestart('default')).toBe(true);
    expect(await pendingAt()).toBe(new Date('2026-11-06T03:00:00').toISOString());
    await vi.advanceTimersByTimeAsync(2 * 60 * 60_000 + 60_000);
    expect(lifecycle.restartServerGracefully).not.toHaveBeenCalled();
    expect(docker.sendLifecycleCommand).not.toHaveBeenCalled();
  });

  it('keeps saved warning minutes within bounds', async () => {
    await plan({ warningMinutes: [1, 'x', -5, 30, 30, 9999, 2.5] });
    expect(scheduler.getConfig('default').scheduledRestarts.warningMinutes).toEqual([30, 1]);
  });

  it('keeps at most 10 warnings: the earliest (countdown start) and the last nine', async () => {
    await plan({ warningMinutes: Array.from({ length: 240 }, (_, i) => i + 1) });
    expect(scheduler.getConfig('default').scheduledRestarts.warningMinutes).toEqual([
      240, 9, 8, 7, 6, 5, 4, 3, 2, 1,
    ]);
  });
});

describe('restart times', () => {
  it('accepts strict, well-spaced "HH:MM" times, sorted and without duplicates', () => {
    expect(scheduler.reviewRestartTimes(['15:00', '03:00', '03:00', '04:00'])).toEqual({
      ok: true,
      value: ['03:00', '04:00', '15:00'],
    });
    expect(scheduler.reviewRestartTimes([])).toEqual({ ok: true, value: [] });
    // 24 times an hour apart is the maximum.
    const hourly = Array.from({ length: 24 }, (_, h) => `${String(h).padStart(2, '0')}:00`);
    expect(scheduler.reviewRestartTimes(hourly)).toMatchObject({ ok: true });
  });

  it('refuses anything that is not a time of day', () => {
    for (const bad of [['x'], ['3:00'], ['24:00'], ['03:60'], ['03:00 '], [3], [null], 'x', null]) {
      expect(scheduler.reviewRestartTimes(bad)).toMatchObject({ ok: false });
    }
  });

  it('refuses times closer than an hour, also across midnight, and more than 24', () => {
    expect(scheduler.reviewRestartTimes(['03:00', '03:59'])).toMatchObject({
      ok: false,
      error: expect.stringMatching(/03:00 and 03:59 are less than 60 minutes apart/),
    });
    // 24 restarts at 15-minute steps would keep the server restarting for hours.
    expect(scheduler.reviewRestartTimes(['00:00', '00:15', '00:30'])).toMatchObject({ ok: false });
    expect(scheduler.reviewRestartTimes(['23:30', '00:20'])).toMatchObject({
      ok: false,
      error: expect.stringMatching(/23:30 and 00:20/),
    });
    const hourlyPlusOne = [
      ...Array.from({ length: 24 }, (_, h) => `${String(h).padStart(2, '0')}:00`),
      '12:30',
    ];
    expect(scheduler.reviewRestartTimes(hourlyPlusOne)).toMatchObject({
      ok: false,
      error: expect.stringMatching(/At most 24/),
    });
  });

  it('normalizes a stored plan on load and never restarts for an invalid time', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    // What an older version accepted (and what the game server could write
    // into its data dir): "x" made setTimeout(NaN) fire at once, in a loop.
    fs.writeFileSync(
      path.join(tmpDir, 'manager-config.json'),
      JSON.stringify({
        scheduledRestarts: {
          enabled: true,
          times: ['x', '03:00', '03:45', 7, '15:00', '03:00', '25:00'],
          warningMinutes: [],
          createBackup: false,
          onlyWhenEmpty: false,
        },
      }),
    );
    await scheduler.loadConfig('default');
    expect(scheduler.getConfig('default').scheduledRestarts.times).toEqual(['03:00', '15:00']);
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/Restart times .* adjusted to/));

    fs.writeFileSync(
      path.join(tmpDir, 'manager-config.json'),
      JSON.stringify({ scheduledRestarts: { enabled: true, times: ['x'], warningMinutes: [] } }),
    );
    await scheduler.loadConfig('default');
    await scheduler.saveConfig({}, 'default');
    await flush();
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(lifecycle.restartServerGracefully).not.toHaveBeenCalled();
    expect(await pendingAt()).toBeUndefined();
    warn.mockRestore();
  });
});

describe('welcome message', () => {
  it('becomes an announce rule on player.joined and follows later edits', async () => {
    await scheduler.saveConfig(
      { announcements: { enabled: true, welcome: 'Welcome {player}!', scheduled: [] } } as never,
      'default',
    );
    expect(eventActions.createEventAction).toHaveBeenCalledWith(
      expect.objectContaining({
        eventPattern: 'player.joined',
        actionType: 'announce',
        actionPayload: { message: 'Welcome {player}!' },
        serverId: 'default',
      }),
    );
    const ruleId = scheduler.getConfig('default').announcements.welcomeActionId;
    expect(ruleId).toBe('ea-1');

    // A client cannot point the scheduler at another rule.
    h.rules.set('admin-rule', { id: 'admin-rule', name: 'Op on join', createdBy: 'admin' });
    await scheduler.saveConfig(
      {
        announcements: {
          enabled: true,
          welcome: 'Hi {player}',
          scheduled: [],
          welcomeActionId: 'admin-rule',
        },
      } as never,
      'default',
    );
    expect(eventActions.updateEventAction).toHaveBeenCalledWith(
      'ea-1',
      expect.objectContaining({ actionPayload: { message: 'Hi {player}' }, enabled: true }),
    );
    expect(eventActions.updateEventAction).not.toHaveBeenCalledWith(
      'admin-rule',
      expect.anything(),
    );
    expect(scheduler.getConfig('default').announcements.welcomeActionId).toBe('ea-1');

    await scheduler.saveConfig(
      { announcements: { enabled: true, welcome: '', scheduled: [] } } as never,
      'default',
    );
    expect(vi.mocked(eventActions.updateEventAction).mock.calls.at(-1)).toEqual([
      'ea-1',
      expect.objectContaining({ enabled: false }),
    ]);
  });

  it("leaves another server's welcome rule alone when the data file names it", async () => {
    // The game server can write its manager-config.json.
    h.rules.set('rule-of-a', {
      id: 'rule-of-a',
      name: 'Welcome message (Scheduler)',
      createdBy: 'scheduler',
      actionType: 'announce',
      serverId: 'srv-a',
    });
    fs.writeFileSync(
      path.join(tmpDir, 'manager-config.json'),
      JSON.stringify({
        announcements: { enabled: true, welcome: 'x', scheduled: [], welcomeActionId: 'rule-of-a' },
      }),
    );
    await scheduler.loadConfig('srv-b');
    vi.mocked(eventActions.updateEventAction).mockClear();

    await scheduler.saveConfig(
      { announcements: { enabled: true, welcome: 'Hi', scheduled: [] } } as never,
      'srv-b',
    );

    expect(eventActions.updateEventAction).not.toHaveBeenCalledWith('rule-of-a', expect.anything());
    expect(h.rules.get('rule-of-a')?.serverId).toBe('srv-a');
    expect(scheduler.getConfig('srv-b').announcements.welcomeActionId).not.toBe('rule-of-a');
  });
});
