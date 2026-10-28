/**
 * The users service side of server lists, and what it hands out about an
 * account: allowedServers is read fail-closed, and listings / update replies
 * carry only the public fields, never another module's 2FA or SSO data.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'path';
import os from 'os';
import fs from 'fs';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kp-users-servers-'));
process.env.MANAGER_DATA_PATH = tmpDir;
delete process.env.DEMO_MODE;

const usersFile = path.join(tmpDir, 'users.json');
fs.writeFileSync(
  usersFile,
  JSON.stringify({
    users: [
      {
        username: 'alice',
        passwordHash: 'secret-hash',
        roleId: 'operator',
        createdAt: '2026-01-01T00:00:00.000Z',
        tokenVersion: 3,
        totpSecret: 'TOTPSECRET',
        totpPendingSecret: 'PENDING',
        backupCodeHashes: ['h1'],
        ssoLinks: [{ provider: 'x', subject: 'y' }],
      },
      {
        username: 'bob',
        passwordHash: 'x',
        roleId: 'viewer',
        createdAt: '2026-01-01T00:00:00.000Z',
        tokenVersion: 1,
        allowedServers: 'b1',
      },
    ],
  }),
);

const users = await import('./users.js');

afterAll(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

describe('allowedServersOf', () => {
  it('reads an absent list as every server and a list as itself, deduplicated', () => {
    expect(users.allowedServersOf({ username: 'a' })).toBeNull();
    expect(users.allowedServersOf({ username: 'a', allowedServers: ['b1', 'b1'] })).toEqual(['b1']);
    expect(users.allowedServersOf({ username: 'a', allowedServers: [] })).toEqual([]);
  });

  it('reads damaged data and a missing account as no server', () => {
    const broken = (value: unknown) =>
      users.allowedServersOf({ username: 'a', allowedServers: value as string[] });
    expect(broken('b1')).toEqual([]);
    expect(broken([1])).toEqual([]);
    expect(broken({ b1: true })).toEqual([]);
    expect(users.allowedServersOf(null)).toEqual([]);
  });
});

describe('public account fields', () => {
  beforeAll(async () => {
    await users.setUserAllowedServers('alice', ['b1', 'b1']);
  });

  it('lists accounts without hashes, 2FA or SSO data, with the effective list', async () => {
    const list = await users.getAllUsers();
    expect(list.find((u) => u.username === 'alice')).toEqual({
      username: 'alice',
      roleId: 'operator',
      createdAt: '2026-01-01T00:00:00.000Z',
      tokenVersion: 3,
      allowedServers: ['b1'],
    });
    // a damaged list shows what is enforced: no server
    expect(list.find((u) => u.username === 'bob')?.allowedServers).toEqual([]);
  });

  it('answers an update with the public fields only', async () => {
    const updated = await users.updateUser('alice', { roleId: 'viewer' });
    expect(Object.keys(updated).sort()).toEqual(
      ['allowedServers', 'createdAt', 'roleId', 'tokenVersion', 'username'].sort(),
    );
  });

  it("keeps the other modules' data in users.json", () => {
    const raw = JSON.parse(fs.readFileSync(usersFile, 'utf-8'));
    const alice = raw.users.find((u: { username: string }) => u.username === 'alice');
    expect(alice).toMatchObject({ totpSecret: 'TOTPSECRET', allowedServers: ['b1'] });
  });

  it('removes the list again on null', async () => {
    const result = await users.setUserAllowedServers('alice', null);
    expect(result.allowedServers).toBeUndefined();
    const raw = JSON.parse(fs.readFileSync(usersFile, 'utf-8'));
    expect(raw.users[0]).not.toHaveProperty('allowedServers');
  });

  it('refuses an unknown account', async () => {
    await expect(users.setUserAllowedServers('nobody', [])).rejects.toThrow('User not found');
  });
});
