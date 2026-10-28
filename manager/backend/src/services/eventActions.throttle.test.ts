/**
 * The two brakes of the event-action engine together: the loop guard and
 * backup cooldown (a rule never reacts to its own events, a backup rule runs
 * at most once per cooldown and server) and the run budget per rule and event
 * name (RULE_RUNS_PER_MINUTE). Neither may use up or block the other: an event
 * the rule must not run for costs no budget, and a run the budget drops starts
 * no cooldown.
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from 'vitest';
import path from 'path';
import os from 'os';
import fs from 'fs';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kp-event-throttle-'));
process.env.MANAGER_DATA_PATH = tmpDir;

// The run budget reads the clock it found at import time; fake it first.
vi.useFakeTimers({ toFake: ['Date'] });
let clock = Date.UTC(2026, 0, 1);
vi.setSystemTime(clock);

const { createBackup, execCommand } = vi.hoisted(() => ({
  createBackup: vi.fn(async () => ({ success: true })),
  execCommand: vi.fn(),
}));
vi.mock('./docker.js', () => ({ execCommand }));
vi.mock('./backup.js', () => ({ createBackup }));
// Servers the rule creator may use (null = every server).
const creatorServers = vi.hoisted(() => ({ allowed: null as string[] | null }));
vi.mock('./roles.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./roles.js')>()),
  userMayAccessServer: async (_user: string, serverId: string) =>
    creatorServers.allowed === null || creatorServers.allowed.includes(serverId),
}));

const ea = await import('./eventActions.js');
const { publish } = await import('./eventBus.js');
const { logger } = await import('../utils/logger.js');

const flush = () => new Promise((resolve) => setTimeout(resolve, 20));

beforeAll(() => {
  ea.startEventActions();
});

beforeEach(() => {
  // Past every budget and cooldown of the previous test.
  clock += 60 * 60_000;
  vi.setSystemTime(clock);
  createBackup.mockClear();
  execCommand.mockReset();
  for (const r of ea.listEventActions()) ea.deleteEventAction(r.id);
});

// The temp dir stays: the panel database in it is still open (Windows refuses
// to delete it), as in eventActions.loop.test.ts.
afterAll(() => {
  vi.useRealTimers();
});

describe('event actions: loop guard, backup cooldown and run budget', () => {
  it('events a rule caused itself do not use up its run budget', async () => {
    ea.createEventAction({
      name: 'echo',
      serverId: null,
      eventPattern: 'server.alert',
      actionType: 'announce',
      actionPayload: { message: 'Alert {reason}' },
      createdBy: 'admin',
    });
    // The action causes another event the rule matches (e.g. a webhook alert).
    execCommand.mockImplementation(async () => {
      publish('server.alert', { reason: 'caused_by_rule' }, 'default');
      return { success: true };
    });

    for (let i = 0; i < ea.RULE_RUNS_PER_MINUTE; i++) {
      publish('server.alert', { reason: 'outside' }, 'default');
      await flush();
    }
    expect(execCommand).toHaveBeenCalledTimes(ea.RULE_RUNS_PER_MINUTE);

    // The budget itself still holds.
    publish('server.alert', { reason: 'outside' }, 'default');
    await flush();
    expect(execCommand).toHaveBeenCalledTimes(ea.RULE_RUNS_PER_MINUTE);
  });

  it('a rule for every server backs up each crashed server once per cooldown', async () => {
    ea.createEventAction({
      name: 'backup on crash',
      serverId: null,
      eventPattern: 'server.crashed',
      actionType: 'backup',
      actionPayload: {},
      createdBy: 'admin',
    });
    // One cooldown and one run budget per server: crashes on many servers
    // do not use up each other's runs.
    for (let i = 1; i <= ea.RULE_RUNS_PER_MINUTE + 1; i++) {
      publish('server.crashed', {}, `s${i}`);
      await flush();
    }
    expect(createBackup).toHaveBeenCalledTimes(ea.RULE_RUNS_PER_MINUTE + 1);
    const late = `s${ea.RULE_RUNS_PER_MINUTE + 1}`;
    expect(createBackup).toHaveBeenLastCalledWith({ kind: 'auto', label: 'event' }, late);

    // The same server again: inside its cooldown.
    publish('server.crashed', {}, late);
    await flush();
    expect(createBackup).toHaveBeenCalledTimes(ea.RULE_RUNS_PER_MINUTE + 1);
  });

  it('counts the run budget per server: a flood on one server leaves the others their runs', async () => {
    ea.createEventAction({
      name: 'alert',
      serverId: null,
      eventPattern: 'server.alert',
      actionType: 'announce',
      actionPayload: { message: 'Alert {reason}' },
      createdBy: 'admin',
    });
    execCommand.mockImplementation(async () => ({ success: true }));
    for (let i = 0; i < ea.RULE_RUNS_PER_MINUTE + 3; i++) {
      publish('server.alert', { reason: 'flood' }, 'a');
      await flush();
    }
    expect(execCommand).toHaveBeenCalledTimes(ea.RULE_RUNS_PER_MINUTE);

    publish('server.alert', { reason: 'other' }, 'b');
    await flush();
    expect(execCommand).toHaveBeenCalledTimes(ea.RULE_RUNS_PER_MINUTE + 1);
    expect(execCommand).toHaveBeenLastCalledWith('/broadcast Alert other', 'b', expect.anything());
  });

  it('a backup rule inside its cooldown costs no budget', async () => {
    ea.createEventAction({
      name: 'backup on crash',
      serverId: 'default',
      eventPattern: 'server.crashed',
      actionType: 'backup',
      actionPayload: {},
      createdBy: 'admin',
    });
    const warn = vi.spyOn(logger, 'warn');
    for (let i = 0; i < ea.RULE_RUNS_PER_MINUTE + 5; i++) {
      publish('server.crashed', {}, 'default');
      await flush();
    }
    expect(createBackup).toHaveBeenCalledOnce();
    // Skipped by the cooldown, never counted against (and dropped by) the budget.
    expect(warn.mock.calls.some(([m]) => String(m).includes('throttled'))).toBe(false);
    warn.mockRestore();

    // After the cooldown the rule runs again.
    clock += ea.BACKUP_ACTION_COOLDOWN_MS;
    vi.setSystemTime(clock);
    publish('server.crashed', {}, 'default');
    await flush();
    expect(createBackup).toHaveBeenCalledTimes(2);
  });

  it("a rule for one server ignores the other servers' events, also those without an id", async () => {
    ea.createEventAction({
      name: 'alert on B',
      serverId: 'b',
      eventPattern: 'server.alert',
      actionType: 'announce',
      actionPayload: { message: 'Alert {reason}' },
      createdBy: 'admin',
    });
    execCommand.mockImplementation(async () => ({ success: true }));
    publish('server.alert', { reason: 'on-default' }, 'default');
    // Without an id: the default server's event (here "default"), not B's.
    publish('server.alert', { reason: 'legacy' });
    await flush();
    expect(execCommand).not.toHaveBeenCalled();

    publish('server.alert', { reason: 'on-b' }, 'b');
    await flush();
    expect(execCommand).toHaveBeenCalledWith('/broadcast Alert on-b', 'b', expect.anything());
  });

  it('runs no action of any type on a server its creator may no longer use', async () => {
    for (const actionType of ['announce', 'backup'] as const) {
      ea.createEventAction({
        name: `${actionType} on alert`,
        serverId: null,
        eventPattern: 'server.alert',
        actionType,
        actionPayload: actionType === 'announce' ? { message: 'Alert {reason}' } : {},
        createdBy: 'admin',
      });
    }
    execCommand.mockImplementation(async () => ({ success: true }));
    creatorServers.allowed = ['b'];
    try {
      publish('server.alert', { reason: 'on-default' }, 'default');
      await flush();
      expect(execCommand).not.toHaveBeenCalled();
      expect(createBackup).not.toHaveBeenCalled();

      publish('server.alert', { reason: 'on-b' }, 'b');
      await flush();
      expect(execCommand).toHaveBeenCalledWith('/broadcast Alert on-b', 'b', expect.anything());
      expect(createBackup).toHaveBeenCalledWith({ kind: 'auto', label: 'event' }, 'b');
    } finally {
      creatorServers.allowed = null;
    }
  });
});
