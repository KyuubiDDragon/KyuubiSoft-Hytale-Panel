/**
 * Event actions × console admin gate and placeholder injection.
 *  - saving: a command rule needs the console tier of its command; patterns
 *    and templates are validated
 *  - firing: the rule runs with its creator's current rights, and placeholder
 *    values are normalized (a crafted username from a failed login must never
 *    become a second console line)
 */
import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import path from 'path';
import os from 'os';
import fs from 'fs';

const tmpDir = path.join(os.tmpdir(), `kp-event-actions-${Date.now()}`);
fs.mkdirSync(tmpDir, { recursive: true });
process.env.MANAGER_DATA_PATH = tmpDir;

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
// eventActions only needs execCommand (imported lazily when a rule fires).
vi.mock('./docker.js', () => ({ execCommand }));

const ea = await import('./eventActions.js');
const { publish } = await import('./eventBus.js');

type Draft = import('./eventActions.js').EventActionDraft;
const draft = (over: Partial<Draft> = {}): Draft => ({
  name: 'rule',
  serverId: null,
  eventPattern: 'player.joined',
  actionType: 'command',
  actionPayload: { command: '/say Welcome {player}' },
  enabled: true,
  ...over,
});

const operator = { username: 'operator' };
const admin = { username: 'admin' };

async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 50));
}

beforeAll(() => {
  ea.startEventActions();
});

beforeEach(() => {
  perms.clear();
  perms.set('admin', ['*']);
  perms.set('operator', ['console.execute', 'scheduler.edit']);
  execCommand.mockClear();
  for (const rule of ea.listEventActions()) ea.deleteEventAction(rule.id);
});

describe('event actions: saving', () => {
  it('rejects an operator binding /op to an event (403)', async () => {
    const r = await ea.reviewEventAction(
      draft({ actionPayload: { command: '/op add {player}' } }),
      null,
      operator,
    );
    expect(r).toMatchObject({ ok: false, status: 403 });
  });

  it('accepts a plain command for an operator and an admin command for an admin', async () => {
    expect(await ea.reviewEventAction(draft(), null, operator)).toEqual({
      ok: true,
      createdBy: 'operator',
    });
    expect(
      await ea.reviewEventAction(
        draft({ actionPayload: { command: '/kick {player}' } }),
        null,
        admin,
      ),
    ).toEqual({ ok: true, createdBy: 'admin' });
  });

  it('validates the event pattern (known names / categories only, bounded length)', async () => {
    for (const eventPattern of ['player.(a+)+$', 'nope.*', 'player', 'x'.repeat(65), '']) {
      const r = await ea.reviewEventAction(draft({ eventPattern }), null, admin);
      expect(r).toMatchObject({ ok: false, status: 400 });
    }
    for (const eventPattern of ['*', 'player.*', 'auth.login_failed']) {
      expect((await ea.reviewEventAction(draft({ eventPattern }), null, admin)).ok).toBe(true);
    }
  });

  it('rejects a template with a line break and an unknown server', async () => {
    const nl = await ea.reviewEventAction(
      draft({ actionPayload: { command: '/say hi\n/op add Evil' } }),
      null,
      admin,
    );
    expect(nl).toMatchObject({ ok: false, status: 400 });
    const srv = await ea.reviewEventAction(draft({ serverId: 'does-not-exist' }), null, admin);
    expect(srv).toMatchObject({ ok: false, status: 400 });
  });

  it('lets an operator rename or disable an admin rule but not change what it runs', async () => {
    const rule = ea.createEventAction({
      ...draft({ actionPayload: { command: '/kick {player}' } }),
      createdBy: 'admin',
    });
    const rename = await ea.reviewEventAction(
      { ...rule, name: 'renamed', enabled: false },
      rule,
      operator,
    );
    expect(rename).toEqual({ ok: true, createdBy: 'admin' });
    const change = await ea.reviewEventAction(
      { ...rule, actionPayload: { command: '/ban {player}' } },
      rule,
      operator,
    );
    expect(change).toMatchObject({ ok: false, status: 403 });
  });
});

describe('event actions: firing', () => {
  it('does not run a command whose placeholder carries a crafted failed-login username', async () => {
    ea.createEventAction({
      ...draft({
        eventPattern: 'auth.login_failed',
        actionPayload: { command: '/say Failed login: {username}' },
      }),
      createdBy: 'admin',
    });

    publish('auth.login_failed', { username: 'Bob\n/op add Evil', reason: 'invalid_credentials' });
    await flush();
    expect(execCommand).not.toHaveBeenCalled();

    publish('auth.login_failed', { username: 'Bob', reason: 'invalid_credentials' });
    await flush();
    expect(execCommand).toHaveBeenCalledWith('/say Failed login: Bob', undefined, {
      actor: 'event/admin',
    });
  });

  it('runs an admin rule for its admin creator, but not a stored /stop from an operator', async () => {
    ea.createEventAction({
      ...draft({ actionPayload: { command: '/kick {player}' } }),
      createdBy: 'admin',
    });
    // Inserted directly, i.e. a rule stored before this check existed.
    ea.createEventAction({
      ...draft({ actionPayload: { command: '/stop' } }),
      createdBy: 'operator',
    });

    publish('player.joined', { player: 'Steve', uuid: 'u-1' }, 'default');
    await flush();
    const sent = execCommand.mock.calls.map((c) => c[0]);
    expect(sent).toContain('/kick Steve');
    expect(sent).not.toContain('/stop');
  });

  it('turns control characters in free-text placeholders into spaces', async () => {
    ea.createEventAction({
      ...draft({
        eventPattern: 'backup.failed',
        actionType: 'announce',
        actionPayload: { message: 'Backup failed: {error}' },
      }),
      createdBy: 'admin',
    });
    publish('backup.failed', { name: 'b1', error: 'disk\nfull\r/stop' }, 'default');
    await flush();
    expect(execCommand).toHaveBeenCalledWith(
      '/broadcast Backup failed: disk full /stop',
      'default',
      { actor: expect.stringMatching(/^event\//) },
    );
  });

  it('resolves only own payload fields (no prototype members)', async () => {
    ea.createEventAction({
      ...draft({
        eventPattern: 'player.left',
        actionPayload: { command: '/say bye {player}{constructor}' },
      }),
      createdBy: 'admin',
    });
    publish('player.left', { player: 'Steve' }, 'default');
    await flush();
    expect(execCommand).toHaveBeenCalledWith('/say bye Steve', 'default', { actor: 'event/admin' });
  });
});

describe('event actions: events from outside and throttling', () => {
  it('wildcard rules do not fire for refused joins; only the exact event name does', async () => {
    for (const eventPattern of ['*', 'player.*']) {
      ea.createEventAction({
        ...draft({ eventPattern, actionPayload: { command: `/say wildcard ${eventPattern}` } }),
        createdBy: 'admin',
      });
    }
    ea.createEventAction({
      ...draft({
        eventPattern: 'player.join_denied',
        actionPayload: { command: '/say denied {player}' },
      }),
      createdBy: 'admin',
    });

    publish('player.join_denied', { player: 'Stranger', kind: 'whitelist' }, 'default');
    await flush();
    expect(execCommand.mock.calls.map((c) => c[0])).toEqual(['/say denied Stranger']);
  });

  it(`runs one rule at most ${ea.RULE_RUNS_PER_MINUTE} times per minute for one event`, async () => {
    ea.createEventAction({ ...draft(), createdBy: 'admin' });
    // One after another: vitest can hand parallel lazy imports the real
    // docker module instead of the mock. The budget is per minute either way.
    for (let i = 0; i < ea.RULE_RUNS_PER_MINUTE + 5; i++) {
      publish('player.joined', { player: `Steve${i}`, uuid: `u-${i}` }, 'default');
      await flush();
    }
    expect(execCommand).toHaveBeenCalledTimes(ea.RULE_RUNS_PER_MINUTE);
    // Another event name has its own budget.
    ea.createEventAction({ ...draft({ eventPattern: 'player.left' }), createdBy: 'admin' });
    publish('player.left', { player: 'Steve' }, 'default');
    await flush();
    expect(execCommand).toHaveBeenCalledTimes(ea.RULE_RUNS_PER_MINUTE + 1);
  });
});

describe('event actions: blocked rules are reported and can be approved', () => {
  it('derives blockedReason for command rules only', async () => {
    const opRule = ea.createEventAction({
      ...draft({ actionPayload: { command: '/stop' } }),
      createdBy: 'operator',
    });
    const adminRule = ea.createEventAction({
      ...draft({ actionPayload: { command: '/kick {player}' } }),
      createdBy: 'admin',
    });
    const announce = ea.createEventAction({
      ...draft({ actionType: 'announce', actionPayload: { message: 'Hi {player}' } }),
      createdBy: 'ghost',
    });
    const views = new Map((await ea.listEventActionViews()).map((r) => [r.id, r.blockedReason]));
    expect(views.get(opRule.id)).toBe('creator_lacks_permission');
    expect(views.get(adminRule.id)).toBeNull();
    expect(views.get(announce.id)).toBeNull();
  });

  it('approve: a non-admin gets 403, an admin is stamped as creator and the rule runs', async () => {
    const rule = ea.createEventAction({
      ...draft({ actionPayload: { command: '/kick {player}' } }),
      createdBy: 'operator',
    });

    expect(await ea.approveEventAction(rule.id, operator)).toMatchObject({
      ok: false,
      status: 403,
    });
    expect(ea.getEventAction(rule.id)?.createdBy).toBe('operator');

    const approved = await ea.approveEventAction(rule.id, admin);
    expect(approved).toMatchObject({ ok: true, rule: { createdBy: 'admin' } });

    publish('player.joined', { player: 'Steve', uuid: 'u-1' }, 'default');
    await flush();
    expect(execCommand).toHaveBeenCalledWith('/kick Steve', 'default', { actor: 'event/admin' });
  });

  it('approve rejects non-command rules and unknown ids', async () => {
    const backup = ea.createEventAction({
      ...draft({ actionType: 'backup', actionPayload: {} }),
      createdBy: 'admin',
    });
    expect(await ea.approveEventAction(backup.id, admin)).toMatchObject({ ok: false, status: 400 });
    expect(await ea.approveEventAction('missing', admin)).toMatchObject({ ok: false, status: 404 });
  });
});
