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
      id: 'default', name: 'Primary', containerName: 'hytale-primary', status: 'ready',
      network: { serverPort: 5520, webMapPort: 18081, webMapWsPort: 18082, pluginPort: 18085 },
      paths: { server: '/tmp/s1', data: dataDir, backups: '/tmp/b1', mods: '/tmp/m1', plugins: '/tmp/p1', assets: '/tmp/a1', auth: '/tmp/au1' },
      createdAt: new Date().toISOString(), createdBy: 'system',
    },
    {
      id: 'secondary', name: 'Secondary', containerName: 'hytale-secondary', status: 'ready',
      network: { serverPort: 5521, webMapPort: 18083, webMapWsPort: 18084, pluginPort: 18090 },
      paths: { server: '/tmp/s2', data: secondDataDir, backups: '/tmp/b2', mods: '/tmp/m2', plugins: '/tmp/p2', assets: '/tmp/a2', auth: '/tmp/au2' },
      createdAt: new Date().toISOString(), createdBy: 'system',
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
    saveConfig({ backups: { enabled: true, schedule: '04:30', retentionDays: 5, beforeRestart: false } }, 'default');
    // Wait for the async persist to land.
    await new Promise(resolve => setTimeout(resolve, 100));
    const persisted = JSON.parse(fs.readFileSync(path.join(dataDir, 'manager-config.json'), 'utf-8'));
    expect(persisted.backups.schedule).toBe('04:30');
    expect(persisted.backups.enabled).toBe(true);
  });
});
