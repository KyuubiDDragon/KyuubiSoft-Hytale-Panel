/**
 * Event actions must not trigger themselves: a backup rule bound to backup.*
 * used to start a new backup for every backup event it caused, until the disk
 * was full.
 */
import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import path from 'path';
import os from 'os';
import fs from 'fs';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kp-event-loop-'));
process.env.MANAGER_DATA_PATH = tmpDir;

const { createBackup, execCommand } = vi.hoisted(() => ({
  createBackup: vi.fn(),
  execCommand: vi.fn(async (command: string) => ({ success: true, message: `sent ${command}` })),
}));
vi.mock('./docker.js', () => ({ execCommand }));
vi.mock('./backup.js', () => ({ createBackup }));
// The rule creators may use every server; the server list has its own tests.
vi.mock('./roles.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./roles.js')>()),
  userMayAccessServer: async () => true,
}));

const ea = await import('./eventActions.js');
const { publish } = await import('./eventBus.js');

/** Like the real createBackup: publishes its events while it runs. */
function realisticBackup() {
  createBackup.mockImplementation(async (_opts: unknown, serverId?: string) => {
    publish('backup.started', { name: 'auto_event_x' }, serverId);
    await new Promise((resolve) => setTimeout(resolve, 5));
    publish('backup.completed', { name: 'auto_event_x', sizeMb: 1 }, serverId);
    return { success: true };
  });
}

function rule(over: Partial<Parameters<typeof ea.createEventAction>[0]>) {
  return ea.createEventAction({
    name: 'rule',
    serverId: null,
    eventPattern: 'backup.*',
    actionType: 'backup',
    actionPayload: {},
    createdBy: 'admin',
    ...over,
  });
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 60));

beforeAll(() => {
  ea.startEventActions();
});

beforeEach(() => {
  createBackup.mockReset();
  execCommand.mockClear();
  realisticBackup();
  for (const r of ea.listEventActions()) ea.deleteEventAction(r.id);
});

describe('event actions: no self-triggering', () => {
  it('a backup rule on backup.* runs once, not for the events of its own backup', async () => {
    rule({ eventPattern: 'backup.*' });
    publish('backup.completed', { name: 'manual_x' }, 'default');
    await flush();
    expect(createBackup).toHaveBeenCalledTimes(1);
    expect(createBackup).toHaveBeenCalledWith({ kind: 'auto', label: 'event' }, 'default');
  });

  it('a backup rule runs at most once per cooldown', async () => {
    rule({ eventPattern: 'server.crashed' });
    publish('server.crashed', {}, 'default');
    publish('server.crashed', {}, 'default');
    await flush();
    publish('server.crashed', {}, 'default');
    await flush();
    expect(createBackup).toHaveBeenCalledTimes(1);
    expect(ea.BACKUP_ACTION_COOLDOWN_MS).toBeGreaterThanOrEqual(60_000);
  });

  it('still lets a different rule react to the events of a backup rule', async () => {
    rule({ eventPattern: 'server.crashed' });
    rule({
      eventPattern: 'backup.completed',
      actionType: 'announce',
      actionPayload: { message: 'Backup {name} done' },
    });
    publish('server.crashed', {}, 'default');
    await flush();
    expect(createBackup).toHaveBeenCalledTimes(1);
    expect(execCommand).toHaveBeenCalledTimes(1);
    expect(execCommand).toHaveBeenCalledWith('/broadcast Backup auto_event_x done', 'default', {
      actor: 'event/admin',
    });
  });

  it('two backup rules do not ping-pong', async () => {
    rule({ eventPattern: 'backup.*', name: 'one' });
    rule({ eventPattern: 'backup.completed', name: 'two' });
    // Only "one" matches the operator's event. Its backup triggers "two"; the
    // events of "two"'s backup carry both rules in their chain and end there.
    publish('backup.started', { name: 'manual_x' }, 'default');
    await flush();
    await flush();
    expect(createBackup).toHaveBeenCalledTimes(2);
  });
});
