/**
 * Regression tests for the --allow-op default.
 *
 * Hytale 0.7 only gates `/op self` behind the --allow-op start flag, and that
 * command hands the full-rights group to whichever player types it. The setup
 * wizard, the config defaults and the env migration used to switch the flag
 * on by default. It must only be on when an operator explicitly chose it, and
 * an existing explicit choice must not be changed silently.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { promises as fsp } from 'fs';
import path from 'path';
import os from 'os';

const ENV_KEYS = [
  'DATA_PATH',
  'MANAGER_DATA_PATH',
  'SERVER_PATH',
  'MANAGER_USERNAME',
  'MANAGER_PASSWORD',
] as const;
const prevEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));

let root: string;
let dataDir: string;
let managerDir: string;

type SetupService = typeof import('./setupService.js');
type Migration = typeof import('./migration.js');
let setupService: SetupService;
let migration: Migration;

beforeAll(async () => {
  root = await fsp.mkdtemp(path.join(os.tmpdir(), 'allow-op-test-'));
  dataDir = path.join(root, 'data');
  managerDir = path.join(root, 'manager');
  // config.ts resolves these paths at import time.
  process.env.DATA_PATH = dataDir;
  process.env.MANAGER_DATA_PATH = managerDir;
  process.env.SERVER_PATH = path.join(root, 'server');
  process.env.MANAGER_USERNAME = 'envadmin';
  process.env.MANAGER_PASSWORD = 'Env-Admin-Pass-2026!';
  setupService = await import('./setupService.js');
  migration = await import('./migration.js');
});

afterAll(async () => {
  for (const key of ENV_KEYS) {
    if (prevEnv[key] === undefined) delete process.env[key];
    else process.env[key] = prevEnv[key];
  }
  await fsp.rm(root, { recursive: true, force: true });
});

beforeEach(async () => {
  for (const dir of [dataDir, managerDir]) {
    await fsp.rm(dir, { recursive: true, force: true });
    await fsp.mkdir(dir, { recursive: true });
  }
});

async function readJson(name: string, dir = dataDir): Promise<Record<string, any>> {
  return JSON.parse(await fsp.readFile(path.join(dir, name), 'utf-8'));
}

describe('allowOp default', () => {
  it('is off in the default panel config', async () => {
    const { getDefaultConfig } = await import('./configService.js');
    expect(getDefaultConfig().server.allowOp).toBe(false);
  });

  it('stays off when the security step is saved without an explicit choice', async () => {
    const result = await setupService.saveStepData('security-settings', { whitelist: true });
    expect(result.success).toBe(true);
    // setup-config.json lives in the manager volume.
    expect((await readJson('setup-config.json', managerDir)).server.allowOp).toBe(false);
  });

  it('is on only when the operator explicitly enables it', async () => {
    await setupService.saveStepData('security-settings', { allowOp: true });
    expect((await readJson('setup-config.json', managerDir)).server.allowOp).toBe(true);
  });

  it('is off after migrating an env-based install without a panel config', async () => {
    expect(await migration.runMigration()).toBe(true);
    expect((await readJson('panel-config.json')).allowOp).toBe(false);
    expect((await readJson('setup-config.json', managerDir)).server.allowOp).toBe(false);
  });

  it('keeps an explicit earlier choice when migrating', async () => {
    await fsp.writeFile(
      path.join(dataDir, 'panel-config.json'),
      JSON.stringify({ allowOp: true }),
      'utf-8',
    );
    expect(await migration.runMigration()).toBe(true);
    expect((await readJson('panel-config.json')).allowOp).toBe(true);
  });
});

// users.json lives on the manager volume (MANAGER_DATA_PATH), not in DATA_PATH.
describe('env migration and users.json', () => {
  it('leaves an unreadable users.json untouched instead of replacing it with the env admin', async () => {
    const usersFile = path.join(managerDir, 'users.json');
    const broken = '{"users": [{"username": "alice", "passwordHash": "$2b$12$abc"';
    await fsp.writeFile(usersFile, broken, 'utf-8');
    expect(await migration.runMigration()).toBe(true);
    expect(await fsp.readFile(usersFile, 'utf-8')).toBe(broken);
  });

  it('leaves valid JSON with an unexpected structure untouched', async () => {
    const usersFile = path.join(managerDir, 'users.json');
    await fsp.writeFile(usersFile, '{"accounts": [{"username": "alice"}]}', 'utf-8');
    expect(await migration.runMigration()).toBe(true);
    expect(await fsp.readFile(usersFile, 'utf-8')).toBe('{"accounts": [{"username": "alice"}]}');
  });

  it('still creates users.json from the env when none exists', async () => {
    expect(await migration.runMigration()).toBe(true);
    expect(
      (await readJson('users.json', managerDir)).users.map((u: { username: string }) => u.username),
    ).toEqual(['envadmin']);
    await expect(fsp.access(path.join(dataDir, 'users.json'))).rejects.toThrow();
  });

  it('takes over a users.json an earlier version wrote into DATA_PATH instead of adding the env admin', async () => {
    const legacy = JSON.stringify({
      users: [{ username: 'alice', passwordHash: `$2b$12$${'x'.repeat(53)}`, roleId: 'admin' }],
    });
    // A finished install whose wizard put its admin into the data folder.
    await fsp.writeFile(path.join(managerDir, 'config.json'), '{"setupComplete":true}', 'utf-8');
    await fsp.writeFile(path.join(dataDir, 'users.json'), legacy, 'utf-8');
    expect(await migration.checkAndRunMigration()).toBe(true);
    expect(await fsp.readFile(path.join(managerDir, 'users.json'), 'utf-8')).toBe(legacy);
    // Taken over, so it no longer lies in the game server's data folder.
    await expect(fsp.access(path.join(dataDir, 'users.json'))).rejects.toThrow();
  });

  it('does not let a users.json from DATA_PATH name the admins of a fresh install', async () => {
    const planted = JSON.stringify({
      users: [{ username: 'mallory', passwordHash: `$2b$12$${'x'.repeat(53)}`, roleId: 'admin' }],
    });
    await fsp.writeFile(path.join(dataDir, 'users.json'), planted, 'utf-8');
    expect(await migration.checkAndRunMigration()).toBe(true);
    const current = await fsp
      .readFile(path.join(managerDir, 'users.json'), 'utf-8')
      .catch(() => '');
    expect(current).not.toContain('mallory');
    await expect(fsp.access(path.join(dataDir, 'users.json'))).rejects.toThrow();
  });
});
