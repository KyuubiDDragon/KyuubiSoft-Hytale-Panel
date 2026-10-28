/**
 * Guard for the test setup (src/test/isolatePaths.ts): a test file that sets
 * no paths of its own must not see the machine's /app/data or /opt/hytale
 * folders, neither through the env nor through the config and the registry
 * that read it. Fails when the setup file is dropped from vitest.config.ts.
 */
import { describe, it, expect } from 'vitest';
import os from 'os';
import path from 'path';

const tmp = path.resolve(os.tmpdir()).toLowerCase();
const inTemp = (p: string | undefined) =>
  !!p &&
  path
    .resolve(p)
    .toLowerCase()
    .startsWith(tmp + path.sep);

describe('test path isolation', () => {
  it('points the data and server folders into a temp folder', () => {
    for (const name of [
      'MANAGER_DATA_PATH',
      'SERVER_PATH',
      'DATA_PATH',
      'BACKUPS_PATH',
      'MODS_PATH',
      'PLUGINS_PATH',
      'ASSETS_PATH',
      'UPDATER_PATH',
      'DOWNLOADER_PATH',
    ]) {
      expect(inTemp(process.env[name]), `${name}=${process.env[name]}`).toBe(true);
    }
  });

  it('gives the config and the compose server those folders', async () => {
    const { config } = await import('../config.js');
    for (const p of [
      config.serverPath,
      config.dataPath,
      config.backupsPath,
      config.modsPath,
      config.pluginsPath,
      config.assetsPath,
    ]) {
      expect(inTemp(p), p).toBe(true);
    }
    const { getServerContext } = await import('../services/serverContext.js');
    const compose = await getServerContext();
    expect(inTemp(compose.paths.server), compose.paths.server).toBe(true);
    expect(inTemp(compose.paths.data), compose.paths.data).toBe(true);
  });
});
