/**
 * The first-run setup:
 *  - keeps its state (setup-config.json, with the server password, store keys
 *    and for a while the admin password hash) in the manager volume, not in
 *    the game server's data folder;
 *  - hands none of it out through the public status;
 *  - stays sealed once finished, also when a file is damaged or missing;
 *  - does not take over an existing account, except the untouched one the
 *    panel created from MANAGER_USERNAME/MANAGER_PASSWORD.
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from 'vitest';
import { promises as fsp } from 'fs';
import path from 'path';
import os from 'os';
import bcrypt from 'bcrypt';

const ENV_KEYS = [
  'DATA_PATH',
  'MANAGER_DATA_PATH',
  'SERVER_PATH',
  'MANAGER_USERNAME',
  'MANAGER_PASSWORD',
] as const;
const prevEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));

const ENV_ADMIN = 'envadmin';
const ENV_PASSWORD = 'Env-Admin-Pass-2026!';
const WIZARD_PASSWORD = 'Wizard-Admin-Pass-2026!';

vi.mock('../routes/server/shared.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../routes/server/shared.js')>()),
  writePanelConfig: vi.fn(async () => undefined),
}));
vi.mock('./serverLifecycle.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./serverLifecycle.js')>()),
  restartServerGracefully: vi.fn(async () => ({ ok: true })),
}));

let root: string;
let dataDir: string;
let managerDir: string;
let setup: typeof import('./setupService.js');

beforeAll(async () => {
  root = await fsp.mkdtemp(path.join(os.tmpdir(), 'setup-seal-test-'));
  dataDir = path.join(root, 'data');
  managerDir = path.join(root, 'manager');
  // config.ts resolves these at import time.
  process.env.DATA_PATH = dataDir;
  process.env.MANAGER_DATA_PATH = managerDir;
  process.env.SERVER_PATH = path.join(root, 'server');
  process.env.MANAGER_USERNAME = ENV_ADMIN;
  process.env.MANAGER_PASSWORD = ENV_PASSWORD;
  setup = await import('./setupService.js');
});

afterAll(async () => {
  for (const k of ENV_KEYS) {
    if (prevEnv[k] === undefined) delete process.env[k];
    else process.env[k] = prevEnv[k];
  }
  await fsp.rm(root, { recursive: true, force: true });
});

beforeEach(async () => {
  for (const dir of [dataDir, managerDir]) {
    await fsp.rm(dir, { recursive: true, force: true });
    await fsp.mkdir(dir, { recursive: true });
  }
});

const exists = (file: string) =>
  fsp.access(file).then(
    () => true,
    () => false,
  );
const writeManager = (name: string, value: unknown) =>
  fsp.writeFile(
    path.join(managerDir, name),
    typeof value === 'string' ? value : JSON.stringify(value),
  );
const readManager = async (name: string) =>
  JSON.parse(await fsp.readFile(path.join(managerDir, name), 'utf-8'));

const account = (username: string, password: string) => ({
  username,
  passwordHash: bcrypt.hashSync(password, 4),
  roleId: 'admin',
  createdAt: new Date().toISOString(),
  tokenVersion: 1,
});

describe('setup state', () => {
  it('lives in the manager volume', async () => {
    expect((await setup.saveStepData('language', { language: 'de' })).success).toBe(true);

    expect(await exists(path.join(managerDir, 'setup-config.json'))).toBe(true);
    expect(await exists(path.join(dataDir, 'setup-config.json'))).toBe(false);
  });

  it('is not handed out by the status before the setup is finished', async () => {
    await setup.saveStepData('language', { language: 'de' });
    await setup.saveStepData('admin-account', { username: 'owner', password: WIZARD_PASSWORD });
    await setup.saveStepData('integrations', { modtaleApiKey: 'modtale-secret-key' });

    const status = await setup.getSetupStatus();

    expect(status.setupComplete).toBe(false);
    expect(status.stepsCompleted).toContain('admin-account');
    const shown = JSON.stringify(status);
    expect(shown).not.toContain('modtale-secret-key');
    expect(shown).not.toContain('_adminPasswordHash');
    expect(shown).not.toContain('$2');
    expect(status.config).toEqual({ language: 'de' });
  });
});

describe('sealing', () => {
  it('is open on a fresh install', async () => {
    expect(await setup.isSetupComplete()).toBe(false);
  });

  it('stays sealed when setup-config.json is missing but config.json says finished', async () => {
    await writeManager('config.json', { setupComplete: true, jwtSecret: 'x'.repeat(48) });
    expect(await setup.isSetupComplete()).toBe(true);
  });

  it('stays sealed when setup-config.json is damaged', async () => {
    await writeManager('setup-config.json', '{"setupComplete": tr');
    expect(await setup.isSetupComplete()).toBe(true);
  });

  it('stays sealed when config.json is damaged', async () => {
    await writeManager('config.json', '{"setupComplete"');
    await writeManager('setup-config.json', { setupComplete: false, language: 'en' });
    expect(await setup.isSetupComplete()).toBe(true);
  });

  it('does not reopen a finished setup whose config.json was deleted', async () => {
    await writeManager('setup-config.json', { setupComplete: true, language: 'en' });

    expect(await setup.isSetupComplete()).toBe(true);
    expect((await readManager('setup-config.json')).setupComplete).toBe(true);
  });
});

describe('the admin account of the wizard', () => {
  it('is refused when another account already has the name', async () => {
    await writeManager('users.json', { users: [account('alice', 'Alices-Own-Pass-2026!')] });

    const result = await setup.saveStepData('admin-account', {
      username: 'alice',
      password: WIZARD_PASSWORD,
    });

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/already exists/i);
  });

  it('does not replace the password or role of an existing account at the end', async () => {
    await setup.saveStepData('admin-account', { username: 'alice', password: WIZARD_PASSWORD });
    const before = { ...account('alice', 'Alices-Own-Pass-2026!'), roleId: 'viewer' };
    await writeManager('users.json', { users: [before] });

    const result = await setup.finalizeSetup();

    expect(result.success).toBe(false);
    const [alice] = (await readManager('users.json')).users;
    expect(alice.passwordHash).toBe(before.passwordHash);
    expect(alice.roleId).toBe('viewer');
    expect(await setup.isSetupComplete()).toBe(false);
  });

  it('may replace the account the panel created from the environment', async () => {
    const envAccount = account(ENV_ADMIN, ENV_PASSWORD);
    await writeManager('users.json', { users: [envAccount] });

    expect(
      (
        await setup.saveStepData('admin-account', {
          username: ENV_ADMIN,
          password: WIZARD_PASSWORD,
        })
      ).success,
    ).toBe(true);
    const result = await setup.finalizeSetup();

    expect(result.success).toBe(true);
    const [admin] = (await readManager('users.json')).users;
    expect(await bcrypt.compare(WIZARD_PASSWORD, admin.passwordHash)).toBe(true);
    expect(admin.tokenVersion).toBe(2);
  });

  it('starts above the token version of a deleted account with the same name', async () => {
    await writeManager('users.json', { users: [], deletedTokenVersions: { owner: 5, other: 2 } });
    await setup.saveStepData('admin-account', { username: 'owner', password: WIZARD_PASSWORD });

    const result = await setup.finalizeSetup();

    expect(result.success).toBe(true);
    const data = await readManager('users.json');
    const owner = data.users.find((u: { username: string }) => u.username === 'owner');
    // Tokens of the deleted account carry version 5 at most.
    expect(owner.tokenVersion).toBe(6);
    expect(data.deletedTokenVersions).toEqual({ other: 2 });
  });

  it('is refused for the environment name once that account has another password', async () => {
    await writeManager('users.json', { users: [account(ENV_ADMIN, 'Changed-In-Panel-2026!')] });

    const result = await setup.saveStepData('admin-account', {
      username: ENV_ADMIN,
      password: WIZARD_PASSWORD,
    });

    expect(result.success).toBe(false);
  });
});
