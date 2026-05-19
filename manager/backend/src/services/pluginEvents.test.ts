import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'path';
import os from 'os';
import fs from 'fs';

const tmpDir = path.join(os.tmpdir(), `kp-pluginevents-${Date.now()}`);
fs.mkdirSync(tmpDir, { recursive: true });
process.env.MANAGER_DATA_PATH = tmpDir;

// Seed two servers so we can verify per-server WS state is independent.
const seed = {
  schemaVersion: 1,
  defaultId: 'default',
  servers: [
    {
      id: 'default', name: 'Primary', containerName: 'hytale-primary', status: 'ready',
      network: { serverPort: 5520, webMapPort: 18081, webMapWsPort: 18082, pluginPort: 18085 },
      paths: { server: '/tmp/s1', data: '/tmp/d1', backups: '/tmp/b1', mods: '/tmp/m1', plugins: '/tmp/p1', assets: '/tmp/a1', auth: '/tmp/au1' },
      createdAt: new Date().toISOString(), createdBy: 'system',
    },
    {
      id: 'secondary', name: 'Secondary', containerName: 'hytale-secondary', status: 'ready',
      network: { serverPort: 5521, webMapPort: 18083, webMapWsPort: 18084, pluginPort: 18090 },
      paths: { server: '/tmp/s2', data: '/tmp/d2', backups: '/tmp/b2', mods: '/tmp/m2', plugins: '/tmp/p2', assets: '/tmp/a2', auth: '/tmp/au2' },
      createdAt: new Date().toISOString(), createdBy: 'system',
    },
  ],
};
fs.writeFileSync(path.join(tmpDir, 'servers.json'), JSON.stringify(seed));

describe('pluginEvents per-server WS state', () => {
  let connect: typeof import('./pluginEvents.js').connect;
  let disconnect: typeof import('./pluginEvents.js').disconnect;
  let disconnectAll: typeof import('./pluginEvents.js').disconnectAll;
  let isConnectedToPlugin: typeof import('./pluginEvents.js').isConnectedToPlugin;

  beforeAll(async () => {
    ({ connect, disconnect, disconnectAll, isConnectedToPlugin } = await import('./pluginEvents.js'));
  });

  afterAll(() => {
    disconnectAll();
  });

  it('isConnectedToPlugin reports false for an unknown / not-yet-opened server', () => {
    expect(isConnectedToPlugin('secondary')).toBe(false);
    expect(isConnectedToPlugin()).toBe(false);
  });

  it('connect attempts a WS connection per server without throwing', async () => {
    // We don't have a real plugin running; we just need to verify connect()
    // doesn't crash and that the state is tracked per-server.
    await connect('default');
    await connect('secondary');
    // The WS will fail to connect (ECONNREFUSED) but state should be tracked.
    // Disconnect cleans up the failed reconnect timers.
    disconnect('default');
    disconnect('secondary');
    // After disconnect, neither should report as connected.
    expect(isConnectedToPlugin('default')).toBe(false);
    expect(isConnectedToPlugin('secondary')).toBe(false);
  });
});
