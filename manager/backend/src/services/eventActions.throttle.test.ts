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

  it('a backup run the budget drops leaves no cooldown behind', async () => {
    ea.createEventAction({
      name: 'backup on crash',
      serverId: null,
      eventPattern: 'server.crashed',
      actionType: 'backup',
      actionPayload: {},
      createdBy: 'admin',
    });
    // One rule for every server: one cooldown per server, one budget per event name.
    for (let i = 1; i <= ea.RULE_RUNS_PER_MINUTE; i++) {
      publish('server.crashed', {}, `s${i}`);
      await flush();
    }
    expect(createBackup).toHaveBeenCalledTimes(ea.RULE_RUNS_PER_MINUTE);

    const late = `s${ea.RULE_RUNS_PER_MINUTE + 1}`;
    publish('server.crashed', {}, late);
    await flush();
    expect(createBackup).toHaveBeenCalledTimes(ea.RULE_RUNS_PER_MINUTE); // budget spent

    // A minute later the budget has refilled, long before a cooldown would end.
    clock += 60_000;
    vi.setSystemTime(clock);
    publish('server.crashed', {}, late);
    await flush();
    expect(createBackup).toHaveBeenCalledTimes(ea.RULE_RUNS_PER_MINUTE + 1);
    expect(createBackup).toHaveBeenLastCalledWith({ kind: 'auto', label: 'event' }, late);
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
});
