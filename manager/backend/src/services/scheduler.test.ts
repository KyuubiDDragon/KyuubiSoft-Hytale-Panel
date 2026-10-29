import { describe, it, expect, beforeAll } from 'vitest';
import path from 'path';
import os from 'os';
import fs from 'fs';

const tmpDir = path.join(os.tmpdir(), `kp-scheduler-${Date.now()}`);
const dataDir = path.join(tmpDir, 'data');
fs.mkdirSync(dataDir, { recursive: true });
process.env.MANAGER_DATA_PATH = tmpDir;
// Scheduler keeps the legacy default-server config under config.dataPath
// (driven by DATA_PATH env var) so v2.x → v3 manager-config.json files
// continue to be honoured. Override it for the test.
process.env.DATA_PATH = dataDir;

// Pre-seed two servers; the second has its own data dir so its scheduler
// config lives in a separate manager-config.json.
const secondDataDir = path.join(tmpDir, 'secondary-data');
fs.mkdirSync(secondDataDir, { recursive: true });

const seed = {
  schemaVersion: 1,
  defaultId: 'default',
  servers: [
    {
      id: 'default',
      name: 'Primary',
      containerName: 'hytale-primary',
      status: 'ready',
      network: { serverPort: 5520, webMapPort: 18081, webMapWsPort: 18082, pluginPort: 18085 },
      paths: {
        server: '/tmp/s1',
        data: dataDir,
        backups: '/tmp/b1',
        mods: '/tmp/m1',
        plugins: '/tmp/p1',
        assets: '/tmp/a1',
        auth: '/tmp/au1',
      },
      createdAt: new Date().toISOString(),
      createdBy: 'system',
    },
    {
      id: 'secondary',
      name: 'Secondary',
      containerName: 'hytale-secondary',
      status: 'ready',
      network: { serverPort: 5521, webMapPort: 18083, webMapWsPort: 18084, pluginPort: 18090 },
      paths: {
        server: '/tmp/s2',
        data: secondDataDir,
        backups: '/tmp/b2',
        mods: '/tmp/m2',
        plugins: '/tmp/p2',
        assets: '/tmp/a2',
        auth: '/tmp/au2',
      },
      createdAt: new Date().toISOString(),
      createdBy: 'system',
    },
  ],
};
fs.writeFileSync(path.join(tmpDir, 'servers.json'), JSON.stringify(seed));

describe('scheduler per-server config', () => {
  let loadConfig: typeof import('./scheduler.js').loadConfig;
  let getConfig: typeof import('./scheduler.js').getConfig;

  beforeAll(async () => {
    ({ loadConfig, getConfig } = await import('./scheduler.js'));
    await loadConfig('default');
    await loadConfig('secondary');
  });

  it('loads independent configs per server', async () => {
    const a = getConfig('default');
    const b = getConfig('secondary');
    expect(a).toBeDefined();
    expect(b).toBeDefined();
    // Independent objects, not aliases.
    expect(a).not.toBe(b);
  });

  it('default config has expected shape', () => {
    const cfg = getConfig('default');
    expect(cfg.backups.schedule).toBe('03:00');
    expect(cfg.backups.enabled).toBe(false);
    expect(cfg.scheduledRestarts.warningMinutes).toEqual([30, 15, 5, 1]);
    expect(cfg.quickCommands.length).toBeGreaterThan(0);
  });

  it('writes default-server config to legacy <dataPath>/manager-config.json', async () => {
    const { saveConfig } = await import('./scheduler.js');
    const saved = await saveConfig(
      { backups: { enabled: true, schedule: '04:30', retentionDays: 5, beforeRestart: false } },
      'default',
    );
    expect(saved).toBe(true);
    const persisted = JSON.parse(
      fs.readFileSync(path.join(dataDir, 'manager-config.json'), 'utf-8'),
    );
    expect(persisted.backups.schedule).toBe('04:30');
    expect(persisted.backups.enabled).toBe(true);
  });

  it("writes another server's config into that server's data dir only", async () => {
    const { saveConfig } = await import('./scheduler.js');
    expect(
      await saveConfig(
        { backups: { enabled: true, schedule: '05:15', retentionDays: 2, beforeRestart: false } },
        'secondary',
      ),
    ).toBe(true);
    const read = (dir: string) =>
      JSON.parse(fs.readFileSync(path.join(dir, 'manager-config.json'), 'utf-8'));
    expect(read(secondDataDir).backups.schedule).toBe('05:15');
    expect(read(dataDir).backups.schedule).toBe('04:30');
    expect(getConfig('secondary').backups.schedule).toBe('05:15');
  });

  it('keeps every change of saves that run at the same time', async () => {
    const { saveConfig, addQuickCommand, deleteQuickCommand, getQuickCommands } =
      await import('./scheduler.js');
    const before = getQuickCommands('secondary').length;
    const [cfgSaved, added, missing] = await Promise.all([
      saveConfig({ announcements: { enabled: true } } as never, 'secondary'),
      addQuickCommand({ name: 'One', command: '/who', icon: 'x', category: 'c' }, 'secondary'),
      deleteQuickCommand('no-such-command', 'secondary'),
    ]);
    expect(cfgSaved).toBe(true);
    expect(added).not.toBeNull();
    expect(missing).toBe('not_found');
    const persisted = JSON.parse(
      fs.readFileSync(path.join(secondDataDir, 'manager-config.json'), 'utf-8'),
    );
    expect(persisted.announcements.enabled).toBe(true);
    expect(persisted.quickCommands).toHaveLength(before + 1);
    expect(await deleteQuickCommand(added!.id, 'secondary')).toBe('ok');
    expect(getQuickCommands('secondary')).toHaveLength(before);
  });
});

describe('carryOverRestartBackup', () => {
  let carryOverRestartBackup: typeof import('./scheduler.js').carryOverRestartBackup;

  beforeAll(async () => {
    ({ carryOverRestartBackup } = await import('./scheduler.js'));
  });

  it('moves the old backups.beforeRestart switch to the restart plan', () => {
    const loaded = { backups: { beforeRestart: false }, scheduledRestarts: { enabled: true } };
    expect(carryOverRestartBackup(loaded).scheduledRestarts).toEqual({
      enabled: true,
      createBackup: false,
    });
    // The input is not mutated.
    expect(loaded.scheduledRestarts).toEqual({ enabled: true });
  });

  it('keeps a value the restart plan already has', () => {
    const loaded = {
      backups: { beforeRestart: false },
      scheduledRestarts: { createBackup: true },
    };
    expect(carryOverRestartBackup(loaded)).toBe(loaded);
  });

  it('ignores configs without the old switch', () => {
    expect(carryOverRestartBackup({ backups: {} })).toEqual({ backups: {} });
    expect(carryOverRestartBackup(null)).toBeNull();
  });
});

describe('quick commands for Hytale 0.7', () => {
  const legacy = [
    { id: '1', name: 'Save World', command: '/save', icon: 'save', category: 'server' },
    { id: '2', name: 'List Players', command: '/list', icon: 'users', category: 'players' },
    { id: '3', name: 'Set Day', command: '/time set day', icon: 'sun', category: 'world' },
    { id: '4', name: 'Set Night', command: '/time set night', icon: 'moon', category: 'world' },
    { id: '5', name: 'Clear Weather', command: '/weather clear', icon: 'cloud', category: 'world' },
    { id: '6', name: 'Rain', command: '/weather rain', icon: 'cloud-rain', category: 'world' },
  ];

  it('replaces the untouched pre-0.7 defaults and keeps edited or own entries', async () => {
    const { migrateQuickCommands } = await import('./scheduler.js');
    const edited = { ...legacy[1], name: 'Who is online' };
    const own = { id: '99', name: 'Mine', command: '/save', icon: 'save', category: 'custom' };
    const { quickCommands, replaced } = migrateQuickCommands([
      legacy[0],
      edited,
      legacy[2],
      legacy[4],
      legacy[5],
      own,
    ]);
    expect(quickCommands.map((c) => c.command)).toEqual([
      '/world save --all --confirm',
      '/list',
      '/time set day',
      '/weather reset',
      '/weather set Zone1_Rain',
      '/save',
    ]);
    expect(quickCommands[3].name).toBe('Reset Weather');
    expect(replaced).toHaveLength(3);
    // Already migrated: nothing more to do.
    expect(migrateQuickCommands(quickCommands).replaced).toEqual([]);
  });

  it('migrates a stored config when it is loaded', async () => {
    const { loadConfig, getConfig } = await import('./scheduler.js');
    fs.writeFileSync(
      path.join(secondDataDir, 'manager-config.json'),
      JSON.stringify({ quickCommands: legacy }),
    );
    await loadConfig('secondary');
    expect(getConfig('secondary').quickCommands.map((c) => c.command)).toEqual([
      '/world save --all --confirm',
      '/who',
      '/time set day',
      '/time set night',
      '/weather reset',
      '/weather set Zone1_Rain',
    ]);
  });

  it('ships defaults that exist in 0.7 and need only console.execute', async () => {
    const { getQuickCommands } = await import('./scheduler.js');
    const { classifyCommand, VANILLA_COMMANDS } = await import('../utils/commandWhitelist.js');
    const defaults = getQuickCommands('no-such-server');
    expect(defaults.length).toBeGreaterThanOrEqual(8);
    for (const qc of defaults) {
      expect(classifyCommand(qc.command, VANILLA_COMMANDS), qc.command).toMatchObject({
        known: true,
        tier: 'console.execute',
      });
    }
  });

  it('hands out copies of the defaults (also the demo list)', async () => {
    const { defaultQuickCommands, getQuickCommands } = await import('./scheduler.js');
    const copy = defaultQuickCommands();
    expect(copy).toEqual(getQuickCommands('no-such-server'));
    expect(copy.map((c) => c.command)).not.toContain('/save-all');
    copy[0].command = '/changed';
    expect(defaultQuickCommands()[0].command).toBe('/world save --all --confirm');
  });
});
