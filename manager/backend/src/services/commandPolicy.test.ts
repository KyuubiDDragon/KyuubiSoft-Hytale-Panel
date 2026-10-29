/**
 * The command policy is what keeps stored commands (scheduler, quick commands,
 * event actions) inside the console's admin gate. Roles are mocked so the
 * tests pin the decision itself: the command must exist on the server (here
 * the vanilla 0.7.3 list, no plugin is installed), then the tier of the
 * command for the actor (when saving) or the stored creator (when firing).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import path from 'path';
import os from 'os';
import fs from 'fs';

const tmpDir = path.join(os.tmpdir(), `kp-cmdpolicy-${Date.now()}`);
fs.mkdirSync(tmpDir, { recursive: true });
process.env.MANAGER_DATA_PATH = tmpDir;

const { perms } = vi.hoisted(() => ({ perms: new Map<string, string[]>() }));
vi.mock('./roles.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./roles.js')>()),
  hasPermission: async (user: string, permission: string) => {
    if (user === 'unreadable') throw new Error('users.json could not be parsed');
    const p = perms.get(user) ?? [];
    return p.includes('*') || p.includes(permission);
  },
}));

const { authorizeCommand, authorizeStoredCommand, holdsCommandTier, reportSkippedCommand } =
  await import('./commandPolicy.js');
const { listAuditEvents } = await import('./audit.js');

describe('commandPolicy.authorizeCommand (saving / running now)', () => {
  beforeEach(() => {
    perms.clear();
    perms.set('admin', ['*']);
    perms.set('operator', ['console.execute', 'scheduler.edit']);
    perms.set('scheduler-only', ['scheduler.edit']);
  });

  it('lets an operator store a plain command', async () => {
    const r = await authorizeCommand({ username: 'operator' }, '/say hello');
    expect(r).toEqual({ allowed: true, permission: 'console.execute' });
  });

  it('rejects an operator planning /op, /stop or /ban with 403', async () => {
    for (const cmd of [
      '/op add Evil',
      '/stop',
      '/ban Steve',
      '/give Steve Weapon_Sword_Iron',
      '/auth logout',
      '/perm group add Default *',
      '/sudo Steve op self',
      '/world remove default',
      '/plugin unload KyuubiDDragon:KyuubiSoftAPI',
      '/shutdown',
    ]) {
      const r = await authorizeCommand({ username: 'operator' }, cmd);
      expect(r.allowed).toBe(false);
      if (!r.allowed) {
        expect(r.status).toBe(403);
        expect(r.error).toContain('console.execute.admin');
      }
    }
  });

  it('allows admin commands for an admin', async () => {
    expect((await authorizeCommand({ username: 'admin' }, '/op add Steve')).allowed).toBe(true);
  });

  it('requires console.execute even for plain commands (scheduler.edit is not enough)', async () => {
    const r = await authorizeCommand({ username: 'scheduler-only' }, '/say hi');
    expect(r.allowed).toBe(false);
  });

  it('lets an operator save the worlds, read the stats and set time and weather', async () => {
    for (const cmd of [
      '/world save --all --confirm',
      '/who',
      '/server stats memory',
      '/time set day',
      '/weather set Zone1_Rain',
      '/notify Restart <3 & more',
    ]) {
      expect(await authorizeCommand({ username: 'operator' }, cmd), cmd).toEqual({
        allowed: true,
        permission: 'console.execute',
      });
    }
  });

  it('rejects unknown or multi-line commands with 400 before any rights check', async () => {
    for (const cmd of ['/eval x()', '/save', '/mute Steve', '/say hi\n/op add Evil']) {
      const r = await authorizeCommand({ username: 'admin' }, cmd);
      expect(r).toMatchObject({ allowed: false, status: 400 });
    }
  });

  it('keeps an API key within its scopes even when the owner is admin', async () => {
    const actor = { username: 'admin', apiKeyScopes: ['scheduler.edit', 'console.execute'] };
    expect((await authorizeCommand(actor, '/say hi')).allowed).toBe(true);
    expect((await authorizeCommand(actor, '/stop')).allowed).toBe(false);
  });

  it('denies an anonymous actor', async () => {
    expect((await authorizeCommand({ username: null }, '/say hi')).allowed).toBe(false);
  });

  it('keeps an API key within its server list, and off entries for every server', async () => {
    const actor = { username: 'admin', apiKeyScopes: ['*'], apiKeyServerIds: ['srv-b'] };
    expect((await authorizeCommand(actor, '/say hi', 'srv-b')).allowed).toBe(true);
    expect((await authorizeCommand(actor, '/say hi', 'default')).allowed).toBe(false);
    expect((await authorizeCommand(actor, '/say hi')).allowed).toBe(false);
    expect(await holdsCommandTier(actor, 'console.execute', 'default')).toBe(false);
    expect(await holdsCommandTier(actor, 'console.execute', 'srv-b')).toBe(true);
    // a key without a list follows its owner, as before
    const unlimited = { username: 'admin', apiKeyScopes: ['*'] };
    expect((await authorizeCommand(unlimited, '/say hi')).allowed).toBe(true);
  });
});

describe('commandPolicy.authorizeStoredCommand (firing later)', () => {
  beforeEach(() => {
    perms.clear();
    perms.set('admin', ['*']);
    perms.set('operator', ['console.execute']);
  });

  it('runs an admin command for a creator who still is admin', async () => {
    expect((await authorizeStoredCommand('admin', '/stop', 'default')).allowed).toBe(true);
  });

  it('stops running it once the creator is demoted or deleted', async () => {
    perms.set('admin', ['console.execute']);
    expect((await authorizeStoredCommand('admin', '/stop', 'default')).allowed).toBe(false);
    expect((await authorizeStoredCommand('ghost', '/say hi', 'default')).allowed).toBe(false);
  });

  it('lets legacy entries without creator run only plain commands', async () => {
    expect((await authorizeStoredCommand(undefined, '/who', 'default')).allowed).toBe(true);
    const r = await authorizeStoredCommand(undefined, '/op add Evil', 'default');
    expect(r.allowed).toBe(false);
    if (!r.allowed) expect(r.error).toMatch(/no recorded creator/);
  });

  it('never fires a stored command with an embedded line break', async () => {
    expect(
      (await authorizeStoredCommand('admin', '/say hi\n/op add Evil', 'default')).allowed,
    ).toBe(false);
  });

  it('fails closed when the rights cannot be read', async () => {
    await expect(authorizeStoredCommand('unreadable', '/say hi', 'default')).resolves.toMatchObject(
      { allowed: false },
    );
    await expect(authorizeCommand({ username: 'unreadable' }, '/say hi')).resolves.toMatchObject({
      allowed: false,
    });
  });
});

describe('commandPolicy.reportSkippedCommand', () => {
  it('audits the first skip per entry and reason only', () => {
    reportSkippedCommand(
      'scheduler',
      'scheduled_command:default:t1',
      undefined,
      'no recorded creator',
    );
    reportSkippedCommand(
      'scheduler',
      'scheduled_command:default:t1',
      undefined,
      'no recorded creator',
    );
    const { events } = listAuditEvents({ action: 'scheduler.command_skipped' });
    const forEntry = events.filter((e) => e.target === 'scheduled_command:default:t1');
    expect(forEntry).toHaveLength(1);
    expect(forEntry[0].success).toBe(false);
  });
});
