/**
 * Regression tests for the "users.json falls back to the .env admin" bug.
 *
 * Before the fix every read error — including a half-written file — made the
 * users service write a fresh users.json containing only the env admin, which
 * wiped all other accounts and their 2FA. Writes were also unserialised, so
 * parallel logins/updates could overwrite each other.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { promises as fsp } from 'fs';
import path from 'path';
import os from 'os';
import bcrypt from 'bcrypt';
import { authenticator } from 'otplib';

const ENV_ADMIN = 'envadmin';
const ENV_PASSWORD = 'Env-Admin-Pass-2026!';
const JWT_SECRET = 'users-store-test-secret-0123456789abcdef0123456789';

let tmpDir: string;
let usersFile: string;
const prevEnv = {
  dataPath: process.env.MANAGER_DATA_PATH,
  username: process.env.MANAGER_USERNAME,
  password: process.env.MANAGER_PASSWORD,
};

type Users = typeof import('./users.js');
type Totp = typeof import('./totp.js');
let users: Users;
let totp: Totp;

beforeAll(async () => {
  tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'users-store-test-'));
  usersFile = path.join(tmpDir, 'users.json');
  // config.ts and users.ts read these at import time.
  process.env.MANAGER_DATA_PATH = tmpDir;
  process.env.MANAGER_USERNAME = ENV_ADMIN;
  process.env.MANAGER_PASSWORD = ENV_PASSWORD;
  process.env.JWT_SECRET ??= JWT_SECRET;
  users = await import('./users.js');
  totp = await import('./totp.js');
});

afterAll(async () => {
  for (const [key, value] of [
    ['MANAGER_DATA_PATH', prevEnv.dataPath],
    ['MANAGER_USERNAME', prevEnv.username],
    ['MANAGER_PASSWORD', prevEnv.password],
  ] as const) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await fsp.rm(tmpDir, { recursive: true, force: true });
});

beforeEach(async () => {
  for (const name of await fsp.readdir(tmpDir)) {
    await fsp.rm(path.join(tmpDir, name), { recursive: true, force: true });
  }
});

function seedUser(username: string, extra: Record<string, unknown> = {}) {
  return {
    username,
    passwordHash: 'x',
    roleId: 'viewer',
    createdAt: '2026-01-01T00:00:00.000Z',
    tokenVersion: 1,
    ...extra,
  };
}

async function seed(records: Array<Record<string, unknown>>): Promise<void> {
  await fsp.writeFile(usersFile, JSON.stringify({ users: records }, null, 2), 'utf-8');
}

async function readStore(): Promise<{ users: Array<Record<string, any>> }> {
  return JSON.parse(await fsp.readFile(usersFile, 'utf-8'));
}

async function tempFiles(): Promise<string[]> {
  return (await fsp.readdir(tmpDir)).filter((name) => name.includes('.tmp-'));
}

describe('corrupt users.json', () => {
  it('is never replaced by the env admin and every access fails loudly', async () => {
    // A write that was cut off mid-way.
    const broken = JSON.stringify({
      users: [seedUser('alice', { totpEnabled: true, totpSecret: 'S' }), seedUser('bob')],
    }).slice(0, 80);
    await fsp.writeFile(usersFile, broken, 'utf-8');

    await expect(users.getAllUsers()).rejects.toThrow(/corrupt/);
    await expect(users.verifyUserCredentials(ENV_ADMIN, ENV_PASSWORD)).rejects.toThrow(/corrupt/);
    await expect(users.updateLastLogin('alice')).rejects.toThrow(/corrupt/);
    await expect(users.getTokenVersion('alice')).rejects.toThrow(/corrupt/);
    // 2FA must fail closed, not report "not enabled".
    await expect(totp.isTotpEnabled('alice')).rejects.toThrow(/corrupt/);

    expect(await fsp.readFile(usersFile, 'utf-8')).toBe(broken);
    const copies = (await fsp.readdir(tmpDir)).filter((name) =>
      name.startsWith('users.json.corrupt-'),
    );
    expect(copies).toHaveLength(1);
  });

  it('makes authMiddleware hand the error to the error handler (500) instead of hanging', async () => {
    const jwt = (await import('jsonwebtoken')).default;
    const { config } = await import('../config.js');
    const { authMiddleware } = await import('../middleware/auth.js');
    await fsp.writeFile(usersFile, '{"users": [', 'utf-8');

    const token = jwt.sign({ sub: 'alice', type: 'access', tokenVersion: 1 }, config.jwtSecret, {
      algorithm: 'HS256',
    });
    const req = { headers: { authorization: `Bearer ${token}` } };
    const res: Record<string, unknown> = {};
    res.status = () => res;
    res.json = () => res;
    let forwarded: unknown;
    await authMiddleware(req as never, res as never, (err?: unknown) => {
      forwarded = err;
    });
    expect(String(forwarded)).toMatch(/corrupt/);
  });

  it('rejects a file without a users array instead of starting over', async () => {
    await fsp.writeFile(usersFile, '{"accounts": []}', 'utf-8');
    await expect(users.getAllUsers()).rejects.toThrow(/corrupt/);
    await expect(users.createUser('newbie', 'Fresh-Account-Pw-9', 'viewer')).rejects.toThrow(
      /corrupt/,
    );
    expect(await fsp.readFile(usersFile, 'utf-8')).toBe('{"accounts": []}');
  });
});

describe('missing users.json', () => {
  it('bootstraps exactly one env admin, even for concurrent first requests', async () => {
    const results = await Promise.all(Array.from({ length: 5 }, () => users.getAllUsers()));
    for (const list of results) {
      expect(list.map((u) => u.username)).toEqual([ENV_ADMIN]);
    }
    const store = await readStore();
    expect(store.users).toHaveLength(1);
    expect(store.users[0]).toMatchObject({ username: ENV_ADMIN, roleId: 'admin', tokenVersion: 1 });
    expect(await bcrypt.compare(ENV_PASSWORD, store.users[0].passwordHash)).toBe(true);
    expect(await tempFiles()).toEqual([]);
  });
});

// Many writers at once; on a loaded machine (a commit hook next to other work) this takes seconds.
const PARALLEL_TIMEOUT_MS = 30_000;

describe('parallel updates', { timeout: PARALLEL_TIMEOUT_MS }, () => {
  it('lose no accounts or fields across users and 2FA writers', async () => {
    const names = Array.from({ length: 20 }, (_, i) => `user${i}`);
    await seed([seedUser('root', { roleId: 'admin' }), ...names.map((n) => seedUser(n))]);

    await Promise.all([
      ...names.map((n) => users.invalidateUserTokens(n)),
      ...names.map((n) => users.updateLastLogin(n)),
      ...names.slice(0, 5).map((n) => totp.startTotpEnrollment(n, 'KP-Tests')),
    ]);

    const store = await readStore();
    expect(store.users).toHaveLength(21);
    for (const n of names) {
      const record = store.users.find((u) => u.username === n)!;
      expect(record.tokenVersion).toBe(2);
      expect(typeof record.lastLogin).toBe('string');
    }
    for (const n of names.slice(0, 5)) {
      expect(typeof store.users.find((u) => u.username === n)!.totpPendingSecret).toBe('string');
    }
    expect(await tempFiles()).toEqual([]);
  });

  it('keeps every concurrently created account and rejects a duplicate', async () => {
    await seed([seedUser('root', { roleId: 'admin' })]);
    const password = 'Unrelated-Secret-42';
    const created = ['alpha', 'bravo', 'charlie'].map((n) =>
      users.createUser(n, password, 'viewer'),
    );
    const duplicates = await Promise.allSettled([
      users.createUser('delta', password, 'viewer'),
      users.createUser('delta', password, 'viewer'),
    ]);
    await Promise.all(created);

    expect(duplicates.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const rejected = duplicates.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect(String(rejected.reason)).toMatch(/already exists/);
    const usernames = (await readStore()).users.map((u) => u.username).sort();
    expect(usernames).toEqual(['alpha', 'bravo', 'charlie', 'delta', 'root']);
  });
});

describe('2FA consume races', { timeout: PARALLEL_TIMEOUT_MS }, () => {
  async function enrolledUser(): Promise<{ secret: string; backupCodes: string[] }> {
    await seed([seedUser('root', { roleId: 'admin' })]);
    const { secret } = await totp.startTotpEnrollment('root', 'KP-Tests');
    const { backupCodes } = await totp.verifyAndEnableTotp('root', authenticator.generate(secret));
    return { secret, backupCodes };
  }

  it('accepts the same TOTP code only once when submitted in parallel', async () => {
    const { secret } = await enrolledUser();
    const code = authenticator.generate(secret);
    const results = await Promise.all([
      totp.verifyTotpOrBackup('root', code),
      totp.verifyTotpOrBackup('root', code),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
  });

  it('consumes a backup code only once when submitted in parallel', async () => {
    const { backupCodes } = await enrolledUser();
    const results = await Promise.all([
      totp.verifyTotpOrBackup('root', backupCodes[0]),
      totp.verifyTotpOrBackup('root', backupCodes[0]),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
    const record = (await readStore()).users.find((u) => u.username === 'root')!;
    expect(record.backupCodeHashes).toHaveLength(9);
  });

  it('accepts a backup code typed without the dash or in lower case', async () => {
    // Used to compare the dash-less input against the hash of "XXXX-XXXX",
    // so no backup code was ever accepted.
    const { backupCodes } = await enrolledUser();
    expect(
      await totp.verifyTotpOrBackup('root', backupCodes[1].replace('-', '').toLowerCase()),
    ).toBe(true);
    expect(await totp.verifyTotpOrBackup('root', backupCodes[1])).toBe(false); // consumed
    expect(await totp.verifyTotpOrBackup('root', backupCodes[2])).toBe(true);
  });
});
