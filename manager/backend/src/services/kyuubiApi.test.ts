import { describe, it, expect, beforeAll, vi } from 'vitest';
import path from 'path';
import os from 'os';
import fs from 'fs';

// Tests use a temp dir so we don't touch the real /app/data.
const tmpDir = path.join(os.tmpdir(), `kp-kyuubi-${Date.now()}`);
fs.mkdirSync(tmpDir, { recursive: true });
process.env.MANAGER_DATA_PATH = tmpDir;

describe('kyuubiApi per-server endpoint resolution', () => {
  let resolvePluginEndpoint: typeof import('./kyuubiApi.js').resolvePluginEndpoint;
  let createServerInstance: typeof import('./servers.js').createServerInstance;
  let ensureLoaded: typeof import('./servers.js').ensureLoaded;
  let getDefaultId: typeof import('./servers.js').getDefaultId;

  beforeAll(async () => {
    // Pre-seed servers.json with a default entry so resolvePluginEndpoint
    // doesn't trip on the config loader at boot.
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
            server: '/tmp/srv', data: '/tmp/data', backups: '/tmp/bk', mods: '/tmp/mods',
            plugins: '/tmp/pl', assets: '/tmp/as', auth: '/tmp/au',
          },
          createdAt: new Date().toISOString(),
          createdBy: 'system',
        },
      ],
    };
    fs.writeFileSync(path.join(tmpDir, 'servers.json'), JSON.stringify(seed));

    ({ resolvePluginEndpoint } = await import('./kyuubiApi.js'));
    ({ createServerInstance, ensureLoaded, getDefaultId } = await import('./servers.js'));
    await ensureLoaded();
  });

  it('resolves default-server endpoint when serverId is omitted', async () => {
    const ep = await resolvePluginEndpoint();
    expect(ep.host).toBe('hytale-primary');
    expect(ep.port).toBe(18085);
  });

  it('reads the explicit server\'s pluginPort from the registry', async () => {
    const created = await createServerInstance({
      name: 'second', containerName: 'hytale-second',
      serverPort: 5521, webMapPort: 18083, webMapWsPort: 18084, pluginPort: 18090,
      createdBy: 'tester',
    });
    const ep = await resolvePluginEndpoint(created.id);
    expect(ep.host).toBe('hytale-second');
    expect(ep.port).toBe(18090);
  });

  it('default-id stays untouched when adding a server', async () => {
    expect(await getDefaultId()).toBe('default');
  });
});
