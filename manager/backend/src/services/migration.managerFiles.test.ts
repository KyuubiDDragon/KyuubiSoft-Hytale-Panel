/**
 * config.json and users.json belong to the manager volume. Earlier versions
 * wrote them into DATA_PATH, the game server's data folder, which the setup
 * check never looks at. They are taken over from there once (marker), only
 * when they have the panel's shape, and then removed from the data folder.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import fs, { promises as fsp } from 'fs';
import path from 'path';
import os from 'os';

const ENV_KEYS = [
  'DATA_PATH',
  'MANAGER_DATA_PATH',
  'SERVER_PATH',
  'MANAGER_USERNAME',
  'MANAGER_PASSWORD',
  'JWT_SECRET',
] as const;
const prevEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));

let root: string;
let dataDir: string;
let managerDir: string;
let migration: typeof import('./migration.js');

const SECRET = 'a-legacy-jwt-secret-that-is-long-enough-123';
const CONFIG = JSON.stringify({ setupComplete: true, jwtSecret: SECRET });
const USERS = JSON.stringify({
  users: [
    {
      username: 'admin',
      passwordHash: `$2b$10$${'a'.repeat(53)}`,
      roleId: 'admin',
      createdAt: '2026-01-01T00:00:00.000Z',
      tokenVersion: 1,
    },
  ],
});

function canCreateFileLink(): boolean {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kp-link-probe-'));
  try {
    fs.writeFileSync(path.join(dir, 'target'), '');
    fs.symlinkSync(path.join(dir, 'target'), path.join(dir, 'link'), 'file');
    return true;
  } catch {
    return false;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

beforeAll(async () => {
  root = await fsp.mkdtemp(path.join(os.tmpdir(), 'migration-manager-files-'));
  dataDir = path.join(root, 'data');
  managerDir = path.join(root, 'manager');
  // config.ts resolves these paths at import time.
  process.env.DATA_PATH = dataDir;
  process.env.MANAGER_DATA_PATH = managerDir;
  process.env.SERVER_PATH = path.join(root, 'server');
  migration = await import('./migration.js');
});

afterAll(async () => {
  for (const k of ENV_KEYS) {
    if (prevEnv[k] === undefined) delete process.env[k];
    else process.env[k] = prevEnv[k];
  }
  await fsp.rm(root, { recursive: true, force: true });
});

beforeEach(async () => {
  await fsp.rm(dataDir, { recursive: true, force: true });
  await fsp.rm(managerDir, { recursive: true, force: true });
  await fsp.mkdir(dataDir, { recursive: true });
});

const read = (dir: string, name: string) => fsp.readFile(path.join(dir, name), 'utf-8');
const exists = (dir: string, name: string) =>
  fsp.access(path.join(dir, name)).then(
    () => true,
    () => false,
  );
const writeData = (name: string, content: string) =>
  fsp.writeFile(path.join(dataDir, name), content);

describe('adoptLegacyManagerFiles', () => {
  it('takes both files over and removes them from the data folder', async () => {
    await writeData('config.json', CONFIG);
    await writeData('users.json', USERS);

    const adopted = await migration.adoptLegacyManagerFiles();

    expect(adopted.sort()).toEqual(['config.json', 'users.json']);
    expect(await read(managerDir, 'config.json')).toBe(CONFIG);
    expect(await read(managerDir, 'users.json')).toBe(USERS);
    expect(await exists(dataDir, 'config.json')).toBe(false);
    expect(await exists(dataDir, 'users.json')).toBe(false);
  });

  it('takes nothing over after the first run, whatever appears later', async () => {
    expect(await migration.adoptLegacyManagerFiles()).toEqual([]);
    await writeData('config.json', CONFIG);
    await writeData('users.json', USERS);

    expect(await migration.adoptLegacyManagerFiles()).toEqual([]);

    expect(await exists(managerDir, 'config.json')).toBe(false);
    expect(await exists(managerDir, 'users.json')).toBe(false);
    expect(await read(dataDir, 'config.json')).toBe(CONFIG);
  });

  it("never replaces the manager volume's own file; the old copy is kept there", async () => {
    await writeData('config.json', CONFIG);
    await writeData('users.json', USERS);
    await fsp.mkdir(managerDir, { recursive: true });
    await fsp.writeFile(path.join(managerDir, 'config.json'), '{"setupComplete":true}');
    await fsp.writeFile(path.join(managerDir, 'users.json'), USERS);

    expect(await migration.adoptLegacyManagerFiles()).toEqual([]);

    expect(await read(managerDir, 'config.json')).toBe('{"setupComplete":true}');
    const kept = await fsp.readdir(path.join(managerDir, 'legacy-data-files'));
    expect(kept).toHaveLength(1);
    expect(kept[0]).toMatch(/^config\.json\./);
    expect(await read(path.join(managerDir, 'legacy-data-files'), kept[0])).toBe(CONFIG);
    // users.json was identical: no copy needed, only removed.
    expect(await exists(dataDir, 'config.json')).toBe(false);
    expect(await exists(dataDir, 'users.json')).toBe(false);
  });

  it('refuses files without the shape of the panel files and leaves them alone', async () => {
    await writeData('config.json', '{"Seed":1,"WorldGen":{}}');
    await writeData('users.json', '{"users":[{"username":"x"}]}');

    expect(await migration.adoptLegacyManagerFiles()).toEqual([]);

    expect(await exists(managerDir, 'config.json')).toBe(false);
    expect(await exists(managerDir, 'users.json')).toBe(false);
    expect(await read(dataDir, 'config.json')).toBe('{"Seed":1,"WorldGen":{}}');
    expect(await read(dataDir, 'users.json')).toBe('{"users":[{"username":"x"}]}');
  });

  it.skipIf(!canCreateFileLink())('does not follow a link in the data folder', async () => {
    const panelFile = path.join(root, 'elsewhere-config.json');
    await fsp.writeFile(panelFile, CONFIG);
    await fsp.symlink(panelFile, path.join(dataDir, 'config.json'), 'file');

    expect(await migration.adoptLegacyManagerFiles()).toEqual([]);

    expect(await exists(managerDir, 'config.json')).toBe(false);
    expect((await fsp.lstat(path.join(dataDir, 'config.json'))).isSymbolicLink()).toBe(true);
    expect(await read(root, 'elsewhere-config.json')).toBe(CONFIG);
  });
});

describe('runMigration', () => {
  it('writes config.json and users.json to the manager volume only', async () => {
    process.env.MANAGER_USERNAME = 'admin';
    process.env.MANAGER_PASSWORD = 'Migrated-Pass-2026!';
    process.env.JWT_SECRET = SECRET;

    expect(await migration.runMigration()).toBe(true);

    expect(await exists(managerDir, 'config.json')).toBe(true);
    expect(await exists(managerDir, 'users.json')).toBe(true);
    expect(await exists(dataDir, 'config.json')).toBe(false);
    expect(await exists(dataDir, 'users.json')).toBe(false);
  });
});

describe('checkPanelVersionAndFeatures', () => {
  it('reads config.json from the manager volume', async () => {
    await fsp.mkdir(managerDir, { recursive: true });
    await fsp.writeFile(
      path.join(managerDir, 'config.json'),
      JSON.stringify({ setupComplete: true, panelVersion: '2.0.0' }),
    );
    await migration.checkPanelVersionAndFeatures();
    const written = JSON.parse(await read(managerDir, 'config.json'));
    expect(written.panelVersion).not.toBe('2.0.0');
    expect(await exists(dataDir, 'config.json')).toBe(false);
  });
});
