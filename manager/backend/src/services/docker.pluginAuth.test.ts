import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import path from 'path';
import os from 'os';
import fs from 'fs';

const tmpDir = path.join(os.tmpdir(), `kp-docker-pluginauth-${Date.now()}`);
fs.mkdirSync(tmpDir, { recursive: true });
process.env.MANAGER_DATA_PATH = tmpDir;
delete process.env.DEMO_MODE;

// Order of side effects across the mocks below.
const calls: string[] = [];

const container = {
  start: vi.fn(async () => {
    calls.push('start');
  }),
  restart: vi.fn(async () => {
    calls.push('restart');
  }),
};

vi.mock('./dockerClient.js', () => ({
  createDockerClient: () => ({ getContainer: () => container }),
}));
vi.mock('./players.js', () => ({ clearOnlinePlayers: vi.fn() }));
vi.mock('./pluginAuth.js', () => ({
  ensurePluginAuthConfig: vi.fn(async (serverId?: string) => {
    calls.push(`ensure:${serverId ?? 'default'}`);
    return { ok: true, changed: true };
  }),
}));

type Docker = typeof import('./docker.js');
let docker: Docker;
let ensure: ReturnType<typeof vi.fn>;

beforeAll(async () => {
  docker = await import('./docker.js');
  ensure = (await import('./pluginAuth.js')).ensurePluginAuthConfig as unknown as ReturnType<
    typeof vi.fn
  >;
});

beforeEach(() => {
  calls.length = 0;
});

describe('server start writes the plugin token first', () => {
  it('startContainer', async () => {
    expect(await docker.startContainer('default')).toMatchObject({ success: true });
    expect(calls).toEqual(['ensure:default', 'start']);
  });

  it('restartContainer', async () => {
    expect(await docker.restartContainer('default')).toMatchObject({ success: true });
    expect(calls).toEqual(['ensure:default', 'restart']);
  });

  it('a failed token write does not block the start', async () => {
    ensure.mockResolvedValueOnce({
      ok: false,
      changed: false,
      error: 'server directory not reachable',
    });
    expect(await docker.startContainer('default')).toMatchObject({ success: true });
    expect(calls).toContain('start');
  });
});
