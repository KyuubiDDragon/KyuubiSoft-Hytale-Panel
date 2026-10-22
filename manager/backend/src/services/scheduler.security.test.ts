/**
 * Scheduler × console admin gate. scheduler.edit used to be enough to plan
 * /op, /stop or /ban. These tests pin the fix on both ends: saving checks the
 * saving user's console tier and records them as creator; firing re-checks the
 * creator's current tier (legacy entries without creator only run plain
 * commands); "Run now" and quick commands check the user who triggers them.
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import path from 'path';
import os from 'os';
import fs from 'fs';

const tmpDir = path.join(os.tmpdir(), `kp-scheduler-sec-${Date.now()}`);
const dataDir = path.join(tmpDir, 'data');
fs.mkdirSync(dataDir, { recursive: true });
process.env.MANAGER_DATA_PATH = tmpDir;
process.env.DATA_PATH = dataDir;
fs.writeFileSync(
  path.join(tmpDir, 'servers.json'),
  JSON.stringify({
    schemaVersion: 1,
    defaultId: 'default',
    servers: [
      {
        id: 'default',
        name: 'Primary',
        containerName: 'hytale-primary',
        status: 'ready',
        network: { serverPort: 5520, webMapPort: 18081, webMapWsPort: 18082, pluginPort: 18085 },
        paths: {
          server: '/tmp/s1',
          data: dataDir,
          backups: '/tmp/b1',
          mods: '/tmp/m1',
          plugins: '/tmp/p1',
          assets: '/tmp/a1',
          auth: '/tmp/au1',
        },
        createdAt: new Date().toISOString(),
        createdBy: 'system',
      },
    ],
  }),
);

const { perms, execCommand } = vi.hoisted(() => ({
  perms: new Map<string, string[]>(),
  execCommand: vi.fn(async (command: string) => ({ success: true, message: `sent ${command}` })),
}));
vi.mock('./roles.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./roles.js')>()),
  hasPermission: async (user: string, permission: string) => {
    const p = perms.get(user) ?? [];
    return p.includes('*') || p.includes(permission);
  },
}));
vi.mock('./docker.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./docker.js')>()),
  execCommand,
}));

type Scheduler = typeof import('./scheduler.js');
let scheduler: Scheduler;

const operator = { username: 'operator' };
const admin = { username: 'admin' };

function entry(id: string, command: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    name: id,
    command,
    enabled: true,
    mode: 'interval',
    times: [],
    intervalMinutes: 1,
    ...extra,
  };
}

// Persist + scheduler restart happen asynchronously after saveConfig.
async function saveAndRestart(scheduledCommands: unknown[]): Promise<void> {
  scheduler.saveConfig({ scheduledCommands } as never, 'default');
  await new Promise((resolve) => setTimeout(resolve, 150));
}

beforeAll(async () => {
  scheduler = await import('./scheduler.js');
  await scheduler.loadConfig('default');
});

beforeEach(() => {
  perms.clear();
  perms.set('admin', ['*']);
  perms.set('operator', ['console.execute', 'scheduler.edit']);
  execCommand.mockClear();
});

describe('scheduler: saving scheduled commands', () => {
  it('rejects an operator planning /op (403) and does not touch the stored list', async () => {
    const review = await scheduler.reviewScheduledCommands(
      [entry('sc-op', '/op add Evil')],
      operator,
      'default',
    );
    expect(review).toMatchObject({ ok: false, status: 403 });
    if (!review.ok) expect(review.error).toContain('console.execute.admin');
  });

  it('rejects a multi-line command with 400', async () => {
    const review = await scheduler.reviewScheduledCommands(
      [entry('sc-nl', '/say hi\n/op add Evil')],
      admin,
      'default',
    );
    expect(review).toMatchObject({ ok: false, status: 400 });
  });

  it('records the saving user as creator and ignores a client-sent createdBy', async () => {
    const forged = await scheduler.reviewScheduledCommands(
      [entry('sc-forged', '/stop', { createdBy: 'admin' })],
      operator,
      'default',
    );
    expect(forged.ok).toBe(false);

    const review = await scheduler.reviewScheduledCommands(
      [entry('sc-say', '/say hi', { createdBy: 'admin' })],
      operator,
      'default',
    );
    expect(review.ok).toBe(true);
    if (review.ok) expect(review.value[0].createdBy).toBe('operator');
  });

  it('keeps an untouched admin entry (and its creator) when an operator saves other changes', async () => {
    const adminSave = await scheduler.reviewScheduledCommands(
      [entry('sc-stop', '/stop')],
      admin,
      'default',
    );
    expect(adminSave.ok).toBe(true);
    if (!adminSave.ok) return;
    await saveAndRestart(adminSave.value);

    const opSave = await scheduler.reviewScheduledCommands(
      [entry('sc-stop', '/stop', { createdBy: 'operator' }), entry('sc-list', '/list')],
      operator,
      'default',
    );
    expect(opSave.ok).toBe(true);
    if (opSave.ok) {
      expect(opSave.value.find((c) => c.id === 'sc-stop')?.createdBy).toBe('admin');
      expect(opSave.value.find((c) => c.id === 'sc-list')?.createdBy).toBe('operator');
    }

    // Disabling or renaming is fine; changing the schedule or re-enabling is not.
    const disable = await scheduler.reviewScheduledCommands(
      [entry('sc-stop', '/stop', { enabled: false, name: 'renamed' })],
      operator,
      'default',
    );
    expect(disable.ok).toBe(true);
    const reschedule = await scheduler.reviewScheduledCommands(
      [entry('sc-stop', '/stop', { intervalMinutes: 5 })],
      operator,
      'default',
    );
    expect(reschedule).toMatchObject({ ok: false, status: 403 });
  });

  it('rejects duplicate ids', async () => {
    const review = await scheduler.reviewScheduledCommands(
      [entry('dup', '/list'), entry('dup', '/list')],
      admin,
      'default',
    );
    expect(review).toMatchObject({ ok: false, status: 400 });
  });

  it('rejects flood-style schedules (fractional/huge interval, malformed times)', async () => {
    for (const bad of [
      entry('i-frac', '/say hi', { intervalMinutes: 0.0001 }),
      entry('i-huge', '/say hi', { intervalMinutes: 1e9 }),
      entry('d-time', '/say hi', { mode: 'daily', times: ['25:99'], intervalMinutes: 0 }),
    ]) {
      const review = await scheduler.reviewScheduledCommands([bad], admin, 'default');
      expect(review).toMatchObject({ ok: false, status: 400 });
    }
  });
});

describe('scheduler: firing scheduled commands', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
  });
  afterEach(async () => {
    await saveAndRestart([]);
    vi.useRealTimers();
  });

  async function fireOnce(): Promise<string[]> {
    await vi.advanceTimersByTimeAsync(60_000);
    await new Promise((resolve) => setTimeout(resolve, 20));
    return execCommand.mock.calls.map((c) => c[0]);
  }

  it('runs an admin entry for its admin creator, and stops after the creator is demoted', async () => {
    await saveAndRestart([entry('fire-stop', '/stop', { createdBy: 'admin' })]);
    expect(await fireOnce()).toContain('/stop');

    execCommand.mockClear();
    perms.set('admin', ['console.execute']);
    expect(await fireOnce()).not.toContain('/stop');
  });

  it('runs a legacy entry without creator only if it needs no admin tier', async () => {
    await saveAndRestart([entry('legacy-op', '/op add Evil'), entry('legacy-save', '/save')]);
    const sent = await fireOnce();
    expect(sent).toContain('/save');
    expect(sent).not.toContain('/op add Evil');
  });
});

describe('scheduler: interactive runs', () => {
  it('"Run now" checks the requesting user, not just scheduler.edit', async () => {
    await saveAndRestart([entry('now-stop', '/stop', { createdBy: 'admin', enabled: false })]);
    const denied = await scheduler.runScheduledCommandNow('now-stop', 'default', operator);
    expect(denied).toMatchObject({ success: false, status: 403 });
    expect(execCommand).not.toHaveBeenCalled();

    const ok = await scheduler.runScheduledCommandNow('now-stop', 'default', admin);
    expect(ok.success).toBe(true);
    expect(execCommand).toHaveBeenCalledWith('/stop', 'default');
    await saveAndRestart([]);
  });

  it('quick commands: an operator cannot store /stop, untouched entries still pass', async () => {
    const existing = scheduler.getQuickCommands('default');
    const add = await scheduler.reviewQuickCommands(
      [...existing, { id: 'qc-stop', name: 'Stop', command: '/stop' }],
      operator,
      'default',
    );
    expect(add).toMatchObject({ ok: false, status: 403 });

    const keep = await scheduler.reviewQuickCommands(
      [...existing, { id: 'qc-time', name: 'Day', command: '/time set day' }],
      operator,
      'default',
    );
    expect(keep.ok).toBe(true);
  });
});

describe('scheduler: blocked entries are reported and can be approved', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
  });
  afterEach(async () => {
    await saveAndRestart([]);
    vi.useRealTimers();
  });

  async function reasons(): Promise<Record<string, string | null>> {
    const view = await scheduler.getConfigView('default');
    return Object.fromEntries(view.scheduledCommands.map((c) => [c.id, c.blockedReason]));
  }

  it('derives blockedReason without changing the stored entries', async () => {
    await saveAndRestart([
      entry('legacy-op', '/op add Evil'),
      entry('legacy-save', '/save'),
      entry('admin-stop', '/stop', { createdBy: 'admin' }),
      entry('bad', '/eval x()', { createdBy: 'admin' }),
    ]);
    perms.set('admin', ['console.execute']); // demoted after saving /stop
    expect(await reasons()).toEqual({
      'legacy-op': 'no_creator',
      'legacy-save': null,
      'admin-stop': 'creator_lacks_permission',
      bad: 'invalid_command',
    });
    expect(
      scheduler.getConfig('default').scheduledCommands.every((c) => !('blockedReason' in c)),
    ).toBe(true);
  });

  it('approve: a non-admin gets 403, an admin is stamped as creator and the entry runs', async () => {
    await saveAndRestart([entry('legacy-op', '/op add Steve')]);

    const denied = await scheduler.approveScheduledCommand('legacy-op', 'default', operator);
    expect(denied).toMatchObject({ success: false, status: 403 });
    expect((await reasons())['legacy-op']).toBe('no_creator');

    const missing = await scheduler.approveScheduledCommand('nope', 'default', admin);
    expect(missing).toMatchObject({ success: false, status: 404 });

    const approved = await scheduler.approveScheduledCommand('legacy-op', 'default', admin);
    expect(approved).toMatchObject({ success: true, command: { createdBy: 'admin' } });
    await new Promise((resolve) => setTimeout(resolve, 150)); // persist + re-arm timers
    expect((await reasons())['legacy-op']).toBeNull();

    await vi.advanceTimersByTimeAsync(60_000);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(execCommand.mock.calls.map((c) => c[0])).toContain('/op add Steve');
  });
});
