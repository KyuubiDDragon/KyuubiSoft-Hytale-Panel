/**
 * getConfig() keeps config.json in memory. A change saved through the
 * service (updateConfig / saveConfig) must be what getConfig() returns right
 * after, without a reload; before, the old value stayed until a restart, so
 * e.g. the Discord settings or the replay switch only took effect then.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kp-config-cache-'));
process.env.MANAGER_DATA_PATH = tmpDir;

const configService = await import('./configService.js');

beforeEach(() => {
  configService.clearConfigCache();
  fs.rmSync(path.join(tmpDir, 'config.json'), { force: true });
});

describe('config cache', () => {
  it('serves a change made with updateConfig at once', async () => {
    expect((await configService.getConfig()).publicStatus?.enabled).toBe(false);
    await configService.updateConfig({ publicStatus: { enabled: true } });
    expect((await configService.getConfig()).publicStatus?.enabled).toBe(true);
    // And as it is on disk.
    expect(await configService.getConfig()).toEqual(await configService.loadConfig());
  });

  it('serves a config saved with saveConfig at once', async () => {
    const cfg = await configService.getConfig();
    await configService.saveConfig({ ...cfg, publicStatus: { enabled: true } });
    expect((await configService.getConfig()).publicStatus?.enabled).toBe(true);
  });

  it('keeps the cache apart from the object that was saved', async () => {
    const saved = await configService.updateConfig({ publicStatus: { enabled: true } });
    saved.publicStatus = { enabled: false };
    expect((await configService.getConfig()).publicStatus?.enabled).toBe(true);
  });
});
