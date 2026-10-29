/**
 * Rules the panel keeps itself name no account as their creator (the
 * scheduler's welcome message). They run for the server they were made for,
 * on every install, without the account check refusing them; a rule for every
 * server or an account of the same name gets no such pass.
 *
 * Real roles and accounts (no mock of the access check); Docker is stubbed.
 */
import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import path from 'path';
import os from 'os';
import fs from 'fs';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kp-event-system-'));
process.env.MANAGER_DATA_PATH = tmpDir;
delete process.env.DEMO_MODE;

const { execCommand } = vi.hoisted(() => ({
  execCommand: vi.fn(async (_command: string, _serverId?: string) => ({ success: true })),
}));
vi.mock('./docker.js', () => ({ execCommand }));

const ea = await import('./eventActions.js');
const { publish } = await import('./eventBus.js');

const flush = () => ea.eventActionsIdle();
const welcomeRule = (serverId: string | null) =>
  ea.createEventAction({
    name: 'Welcome message (Scheduler)',
    serverId,
    eventPattern: 'player.joined',
    actionType: 'announce',
    actionPayload: { message: 'Welcome {player}' },
    createdBy: 'scheduler',
  });

function writeUsers(users: unknown[]): void {
  fs.writeFileSync(path.join(tmpDir, 'users.json'), JSON.stringify({ users }));
}

beforeAll(() => {
  writeUsers([]);
  ea.startEventActions();
});

beforeEach(() => {
  execCommand.mockClear();
  for (const r of ea.listEventActions()) ea.deleteEventAction(r.id);
});

// The temp dir stays: the panel database in it is still open (Windows refuses
// to delete it), as in eventActions.loop.test.ts.

describe('event actions created by the panel itself', () => {
  it("greets a joining player on the rule's own server", async () => {
    welcomeRule('default');
    publish('player.joined', { player: 'Steve' }, 'default');
    await flush();
    expect(execCommand).toHaveBeenCalledWith('/broadcast Welcome Steve', 'default', {
      actor: 'event/scheduler',
    });
  });

  it('does not run a system rule that is not bound to one server', async () => {
    welcomeRule(null);
    publish('player.joined', { player: 'Steve' }, 'default');
    await flush();
    expect(execCommand).not.toHaveBeenCalled();
  });

  it('checks an account of the same name like any other account', async () => {
    writeUsers([
      {
        username: 'scheduler',
        passwordHash: 'x',
        roleId: 'operator',
        createdAt: new Date().toISOString(),
        tokenVersion: 0,
        allowedServers: ['elsewhere'],
      },
    ]);
    try {
      welcomeRule('default');
      publish('player.joined', { player: 'Steve' }, 'default');
      await flush();
      expect(execCommand).not.toHaveBeenCalled();
    } finally {
      writeUsers([]);
    }
  });
});
