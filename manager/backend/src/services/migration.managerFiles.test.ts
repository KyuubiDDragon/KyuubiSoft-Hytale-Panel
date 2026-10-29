/**
 * config.json and users.json belong to the manager volume. Earlier versions
 * wrote them into DATA_PATH, the game server's data folder, which the setup
 * check never looks at. They are taken over from there once (marker), only
 * when they have the panel's shape, and then removed from the data folder.
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import fs, { promises as fsp } from 'fs';
import path from 'path';
import os from 'os';
import { logger } from '../utils/logger.js';

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

const readJson = async (dir: string, name: string) => JSON.parse(await read(dir, name));
const keptCopies = async () => {
  try {
    return await fsp.readdir(path.join(managerDir, 'legacy-data-files'));
  } catch {
    return [];
  }
};

describe('adoptLegacyManagerFiles', () => {
  it('takes users.json over into a manager volume whose setup was finished before', async () => {
    await fsp.mkdir(managerDir, { recursive: true });
    await fsp.writeFile(path.join(managerDir, 'config.json'), '{"setupComplete":true}');
    await writeData('users.json', USERS);

    const adopted = await migration.adoptLegacyManagerFiles();

    expect(adopted).toEqual(['users.json']);
    expect(await read(managerDir, 'users.json')).toBe(USERS);
    expect(await exists(dataDir, 'users.json')).toBe(false);
  });

  it('never takes users.json over into a fresh manager volume, also not with config.json', async () => {
    await writeData('config.json', CONFIG);
    await writeData('users.json', USERS);

    const adopted = await migration.adoptLegacyManagerFiles();

    expect(adopted).toEqual(['config.json']);
    expect(await exists(managerDir, 'users.json')).toBe(false);
    // Out of the game's folder and its backups, kept aside, not used.
    expect(await exists(dataDir, 'users.json')).toBe(false);
    const kept = await keptCopies();
    expect(kept.some((name) => name.startsWith('users.json.'))).toBe(true);
  });

  it('never takes the JWT secret over; JWT_SECRET from the environment stays in charge', async () => {
    process.env.JWT_SECRET = 'an-environment-jwt-secret-that-is-long-enough-456';
    try {
      await writeData('config.json', CONFIG);

      expect(await migration.adoptLegacyManagerFiles()).toEqual(['config.json']);

      const adopted = await readJson(managerDir, 'config.json');
      expect(adopted.setupComplete).toBe(true);
      expect(adopted).not.toHaveProperty('jwtSecret');
    } finally {
      delete process.env.JWT_SECRET;
    }
  });

  it('gives a taken-over config.json a new JWT secret when the environment has none', async () => {
    await writeData('config.json', CONFIG);

    await migration.adoptLegacyManagerFiles();

    const { jwtSecret } = await readJson(managerDir, 'config.json');
    expect(typeof jwtSecret).toBe('string');
    expect(jwtSecret.length).toBeGreaterThanOrEqual(32);
    expect(jwtSecret).not.toBe(SECRET);
  });

  it('takes only the setup state from a config.json in the data folder', async () => {
    await writeData(
      'config.json',
      JSON.stringify({
        setupComplete: true,
        jwtSecret: SECRET,
        corsOrigins: ['https://attacker.example'],
        network: { trustProxy: true },
        sso: { providers: [{ id: 'discord', autoCreate: true, defaultRoleId: 'admin' }] },
        offsiteBackup: { enabled: true, bucket: 'elsewhere' },
        panelVersion: '3.0.0',
      }),
    );

    await migration.adoptLegacyManagerFiles();

    const adopted = await readJson(managerDir, 'config.json');
    expect(Object.keys(adopted).sort()).toEqual(['jwtSecret', 'panelVersion', 'setupComplete']);
    expect(adopted.jwtSecret).not.toBe(SECRET);
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

describe('adoptLegacyManagerFiles and setup-config.json', () => {
  const marker = () =>
    fsp.writeFile(path.join(managerDir, '.legacy-data-files-adopted'), 'earlier run\n');

  it('moves it into the manager volume, also after config.json/users.json were done', async () => {
    await fsp.mkdir(managerDir, { recursive: true });
    await marker();
    await fsp.writeFile(path.join(managerDir, 'config.json'), '{"setupComplete":true}');
    const setup = JSON.stringify({
      setupComplete: true,
      language: 'de',
      server: { password: 'pw' },
    });
    await writeData('setup-config.json', setup);

    expect(await migration.adoptLegacyManagerFiles()).toEqual(['setup-config.json']);

    expect(await readJson(managerDir, 'setup-config.json')).toEqual({
      setupComplete: true,
      language: 'de',
    });
    expect(await exists(dataDir, 'setup-config.json')).toBe(false);
    // Once only.
    await writeData('setup-config.json', setup);
    expect(await migration.adoptLegacyManagerFiles()).toEqual([]);
  });

  it('drops the admin password hash of an unfinished setup; the wizard asks again', async () => {
    await writeData(
      'setup-config.json',
      JSON.stringify({
        setupComplete: false,
        language: 'de',
        admin: { username: 'planted' },
        _adminPasswordHash: `$2b$12$${'b'.repeat(53)}`,
      }),
    );

    await migration.adoptLegacyManagerFiles();

    expect(await readJson(managerDir, 'setup-config.json')).toEqual({
      setupComplete: false,
      language: 'de',
    });
  });

  // The wizard writes network, store keys and server settings into config.json
  // at its end: a planted file must not set them for the admin.
  const planted = {
    downloadMethod: 'official',
    patchline: 'release',
    autoUpdate: true,
    network: { accessMode: 'domain', domain: 'https://attacker.example', trustProxy: true },
    integrations: { modtaleApiKey: 'planted', stackmartApiKey: 'planted', webmap: true },
    server: { name: 'x', password: 'pw' },
    plugin: { kyuubiApiInstalled: true },
    automation: { backups: { enabled: false, interval: 'daily', retention: 1 } },
  };

  it('takes only the setup state and the first choices of a finished setup', async () => {
    await fsp.mkdir(managerDir, { recursive: true });
    await fsp.writeFile(path.join(managerDir, 'config.json'), '{"setupComplete":true}');
    await writeData(
      'setup-config.json',
      JSON.stringify({ setupComplete: true, language: 'de', ...planted }),
    );

    await migration.adoptLegacyManagerFiles();

    expect(await readJson(managerDir, 'setup-config.json')).toEqual({
      setupComplete: true,
      language: 'de',
      downloadMethod: 'official',
      patchline: 'release',
      autoUpdate: true,
    });
  });

  it('keeps only the language of an unfinished setup', async () => {
    await writeData(
      'setup-config.json',
      JSON.stringify({ setupComplete: false, language: 'de', ...planted }),
    );

    await migration.adoptLegacyManagerFiles();

    expect(await readJson(managerDir, 'setup-config.json')).toEqual({
      setupComplete: false,
      language: 'de',
    });
  });

  it('runs the wizard again for a finished setup without config.json in the manager volume', async () => {
    await writeData('setup-config.json', JSON.stringify({ setupComplete: true, language: 'en' }));

    await migration.adoptLegacyManagerFiles();

    expect((await readJson(managerDir, 'setup-config.json')).setupComplete).toBe(false);
  });

  it('leaves a file without the shape of the setup state where it is', async () => {
    await writeData('setup-config.json', '["not", "a", "setup"]');

    expect(await migration.adoptLegacyManagerFiles()).toEqual([]);

    expect(await exists(managerDir, 'setup-config.json')).toBe(false);
    expect(await exists(dataDir, 'setup-config.json')).toBe(true);
  });
});

describe('runMigration', () => {
  it('writes config.json, users.json and setup-config.json to the manager volume only', async () => {
    process.env.MANAGER_USERNAME = 'admin';
    process.env.MANAGER_PASSWORD = 'Migrated-Pass-2026!';
    process.env.JWT_SECRET = SECRET;

    expect(await migration.runMigration()).toBe(true);

    for (const name of ['config.json', 'users.json', 'setup-config.json']) {
      expect(await exists(managerDir, name)).toBe(true);
      expect(await exists(dataDir, name)).toBe(false);
    }
  });

  // The setup stays sealed with a damaged file; the migration then writes a
  // new one, but the old content (server password, store keys) is kept.
  it.each(['setup-config.json', 'config.json'])(
    'keeps a copy of a damaged %s before it replaces it and names it in the log',
    async (name) => {
      process.env.MANAGER_USERNAME = 'admin';
      process.env.MANAGER_PASSWORD = 'Migrated-Pass-2026!';
      process.env.JWT_SECRET = SECRET;
      await fsp.mkdir(managerDir, { recursive: true });
      await fsp.writeFile(path.join(managerDir, name), '{{garbage');
      const warn = vi.spyOn(logger, 'warn');
      try {
        expect(await migration.runMigration()).toBe(true);

        const copies = (await fsp.readdir(managerDir)).filter((n) =>
          n.startsWith(`${name}.corrupt-`),
        );
        expect(copies).toHaveLength(1);
        expect(await read(managerDir, copies[0])).toBe('{{garbage');
        if (process.platform !== 'win32') {
          expect((await fsp.stat(path.join(managerDir, copies[0]))).mode & 0o777).toBe(0o600);
        }
        expect((await readJson(managerDir, name)).setupComplete).toBe(true);
        const told = warn.mock.calls.map((args) => String(args[0]));
        expect(told.filter((line) => line.includes(copies[0]))).toHaveLength(1);
      } finally {
        warn.mockRestore();
      }
    },
  );
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
