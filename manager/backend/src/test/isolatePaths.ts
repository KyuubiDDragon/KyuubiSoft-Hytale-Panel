/**
 * Vitest setup (vitest.config.ts → setupFiles): runs before every test file.
 *
 * Without MANAGER_DATA_PATH the panel falls back to /app/data, and the
 * server folders default to /opt/hytale/…; a test that imports a module
 * which reads or writes them (servers.json, config.json, players.json, …)
 * would touch the real folders of the machine (on Windows D:\app, D:\opt).
 * Every path the test file did not set itself points into a fresh temp
 * folder instead. A test that sets one of them (before importing the panel)
 * keeps its own value.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kp-test-'));

const DEFAULTS: Record<string, string> = {
  MANAGER_DATA_PATH: 'manager',
  SERVER_PATH: 'hytale/server',
  DATA_PATH: 'hytale/data',
  BACKUPS_PATH: 'hytale/backups',
  MODS_PATH: 'hytale/mods',
  PLUGINS_PATH: 'hytale/plugins',
  ASSETS_PATH: 'hytale/assets',
  UPDATER_PATH: 'hytale/updater',
  DOWNLOADER_PATH: 'hytale/downloader',
  // Not INSTANCES_PATH: it is the instances' path inside the containers and
  // ends up in registry entries the tests compare; nothing writes below it.
};

for (const [name, sub] of Object.entries(DEFAULTS)) {
  if (process.env[name] === undefined) process.env[name] = path.join(root, sub);
}

// Best effort: a database still open (Windows) keeps its folder until the next cleanup of %TEMP%.
process.on('exit', () => {
  try {
    fs.rmSync(root, { recursive: true, force: true });
  } catch {
    /* left for the system's temp cleanup */
  }
});

/** The temp folder of this test file (for tests that want to look inside). */
export const TEST_ROOT = root;
