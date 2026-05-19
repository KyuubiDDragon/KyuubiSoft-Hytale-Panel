import { describe, it, expect, beforeAll } from 'vitest';
import path from 'path';
import os from 'os';
import fs from 'fs';

const tmpDir = path.join(os.tmpdir(), `kp-websocket-${Date.now()}`);
fs.mkdirSync(tmpDir, { recursive: true });
process.env.MANAGER_DATA_PATH = tmpDir;

// Seed two servers so we can verify the per-server WS routing.
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
      id: 'abc123', name: 'Secondary', containerName: 'hytale-secondary', status: 'ready',
      network: { serverPort: 5521, webMapPort: 18083, webMapWsPort: 18084, pluginPort: 18090 },
      paths: { server: '/tmp/s2', data: '/tmp/d2', backups: '/tmp/b2', mods: '/tmp/m2', plugins: '/tmp/p2', assets: '/tmp/a2', auth: '/tmp/au2' },
      createdAt: new Date().toISOString(), createdBy: 'system',
    },
  ],
};
fs.writeFileSync(path.join(tmpDir, 'servers.json'), JSON.stringify(seed));

describe('websocket per-server console routing', () => {
  let resolveSocketServerId: typeof import('./websocket.js').resolveSocketServerId;

  beforeAll(async () => {
    // Force the registry to load from our seed before importing websocket.
    const { ensureLoaded } = await import('./services/servers.js');
    await ensureLoaded();
    ({ resolveSocketServerId } = await import('./websocket.js'));
  });

  it('legacy /api/console/ws falls back to the default server', async () => {
    const id = await resolveSocketServerId('/api/console/ws?ticket=abc');
    expect(id).toBe('default');
  });

  it('scoped /api/servers/:id/console/ws extracts and validates the id', async () => {
    const id = await resolveSocketServerId('/api/servers/abc123/console/ws?ticket=xyz');
    expect(id).toBe('abc123');
  });

  it('rejects unknown server ids', async () => {
    const id = await resolveSocketServerId('/api/servers/does-not-exist/console/ws');
    expect(id).toBeNull();
  });

  it('returns null for unrelated paths', async () => {
    const id = await resolveSocketServerId('/api/players/locations/ws');
    expect(id).toBeNull();
  });
});
