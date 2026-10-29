/**
 * Regression tests for moving the legacy `updateConfig` block at startup and
 * for panel-config.json writes keeping keys they do not know.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { promises as fsp } from 'fs';
import path from 'path';
import os from 'os';

const ENV_KEYS = ['DATA_PATH', 'MANAGER_DATA_PATH', 'SERVER_PATH'] as const;
const prevEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));

let root: string;
let serverDir: string;
let dataDir: string;
let migration: typeof import('./migration.js');
let shared: typeof import('../routes/server/shared.js');

beforeAll(async () => {
  root = await fsp.mkdtemp(path.join(os.tmpdir(), 'update-migration-test-'));
  serverDir = path.join(root, 'server');
  dataDir = path.join(root, 'data');
  // config.ts resolves these paths at import time.
  process.env.DATA_PATH = dataDir;
  process.env.MANAGER_DATA_PATH = path.join(root, 'manager');
  process.env.SERVER_PATH = serverDir;
  migration = await import('./migration.js');
  shared = await import('../routes/server/shared.js');
});

afterAll(async () => {
  for (const key of ENV_KEYS) {
    if (prevEnv[key] === undefined) delete process.env[key];
    else process.env[key] = prevEnv[key];
  }
  await fsp.rm(root, { recursive: true, force: true });
});

beforeEach(async () => {
  for (const d of [serverDir, dataDir]) {
    await fsp.rm(d, { recursive: true, force: true });
    await fsp.mkdir(d, { recursive: true });
  }
});

const serverConfig = async () =>
  JSON.parse(await fsp.readFile(path.join(serverDir, 'config.json'), 'utf-8'));

describe('migrateUpdateConfig', () => {
  it('moves the wizard-written camelCase block into Update', async () => {
    await fsp.writeFile(
      path.join(serverDir, 'config.json'),
      JSON.stringify({
        ServerName: 'Mine',
        Update: {},
        updateConfig: {
          enabled: true,
          checkIntervalSeconds: 3600,
          notifyPlayersOnAvailable: true,
          patchline: 'release',
          runBackupBeforeUpdate: true,
          backupConfigBeforeUpdate: true,
          autoApplyMode: 'WHEN_EMPTY',
          autoApplyDelayMinutes: 5,
        },
      }),
    );
    expect(await migration.migrateUpdateConfig()).toEqual({
      migrated: true,
      newFeatures: ['native_update_system'],
    });
    expect(await serverConfig()).toEqual({
      ServerName: 'Mine',
      Update: {
        Enabled: true,
        CheckIntervalSeconds: 3600,
        NotifyPlayersOnAvailable: true,
        RunBackupBeforeUpdate: true,
        BackupConfigBeforeUpdate: true,
        AutoApplyMode: 'WhenEmpty',
        AutoApplyDelayMinutes: 5,
      },
    });
    // Idempotent: a second start changes nothing.
    expect((await migration.migrateUpdateConfig()).migrated).toBe(false);
  });

  it('leaves config.json alone while the server runs (it writes its own config back)', async () => {
    const legacy = { ServerName: 'Mine', updateConfig: { checkIntervalSeconds: 600 } };
    await fsp.writeFile(path.join(serverDir, 'config.json'), JSON.stringify(legacy));
    expect(await migration.migrateUpdateConfig({ isServerRunning: async () => true })).toEqual({
      migrated: false,
      deferred: true,
      newFeatures: [],
    });
    // A failing state check counts as running.
    const unknown = await migration.migrateUpdateConfig({
      isServerRunning: async () => {
        throw new Error('docker unreachable');
      },
    });
    expect(unknown.deferred).toBe(true);
    expect(await serverConfig()).toEqual(legacy);

    const stopped = await migration.migrateUpdateConfig({ isServerRunning: async () => false });
    expect(stopped.migrated).toBe(true);
    expect(await serverConfig()).toEqual({
      ServerName: 'Mine',
      Update: { CheckIntervalSeconds: 600 },
    });
  });

  it('does not ask for the server state when there is nothing to move', async () => {
    await fsp.writeFile(path.join(serverDir, 'config.json'), JSON.stringify({ Update: {} }));
    let asked = false;
    const result = await migration.migrateUpdateConfig({
      isServerRunning: async () => {
        asked = true;
        return true;
      },
    });
    expect(result).toEqual({ migrated: false, newFeatures: [] });
    expect(asked).toBe(false);
  });

  it('adds nothing to a config without a legacy block and never creates config.json', async () => {
    await fsp.writeFile(path.join(serverDir, 'config.json'), JSON.stringify({ Update: {} }));
    expect((await migration.migrateUpdateConfig()).migrated).toBe(false);
    expect(await serverConfig()).toEqual({ Update: {} });

    await fsp.rm(path.join(serverDir, 'config.json'));
    expect((await migration.migrateUpdateConfig()).migrated).toBe(false);
    await expect(fsp.access(path.join(serverDir, 'config.json'))).rejects.toThrow();
  });
});

describe('writePanelConfig', () => {
  it('keeps keys it does not model and the values a caller leaves undefined', async () => {
    const file = path.join(dataDir, 'panel-config.json');
    await fsp.writeFile(
      file,
      JSON.stringify({ patchline: 'release', bootCommands: ['say hi'], futureKey: 42 }),
    );
    const cfg = await shared.readPanelConfig();
    await shared.writePanelConfig({ ...cfg, allowOp: true, aotCache: undefined });
    expect(JSON.parse(await fsp.readFile(file, 'utf-8'))).toMatchObject({
      patchline: 'release',
      allowOp: true,
      bootCommands: ['say hi'],
      futureKey: 42,
    });
  });
});
