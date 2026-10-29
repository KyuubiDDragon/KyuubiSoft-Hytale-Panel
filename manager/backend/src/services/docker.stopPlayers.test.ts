/**
 * A Docker stop or restart marks only that server's players offline: with
 * several servers, stopping B must leave A's online players alone. Docker,
 * the registry and the player store are stubs.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { stopped, clearOnlinePlayers } = vi.hoisted(() => ({
  stopped: [] as string[],
  clearOnlinePlayers: vi.fn(async (_serverId?: string) => undefined),
}));

vi.mock('./dockerClient.js', () => ({
  createDockerClient: () => ({
    getContainer: (name: string) => ({
      stop: async () => {
        stopped.push(`stop:${name}`);
      },
      restart: async () => {
        stopped.push(`restart:${name}`);
      },
    }),
  }),
}));
vi.mock('./servers.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./servers.js')>()),
  getServer: async (id: string) => ({ id, containerName: `hytale-${id}` }),
  resolveServerId: async (id?: string | null) => id || 'default',
  isComposeServer: (s: { id: string }) => s.id === 'default',
}));
vi.mock('./players.js', () => ({ clearOnlinePlayers }));
vi.mock('./pluginAuth.js', () => ({
  ensurePluginAuthConfig: vi.fn(async () => ({ ok: true, changed: false })),
}));
vi.mock('./demoData.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./demoData.js')>()),
  isDemoMode: () => false,
}));

const docker = await import('./docker.js');

beforeEach(() => {
  stopped.length = 0;
  clearOnlinePlayers.mockClear();
});

describe('stopping a server container', () => {
  it("marks only the stopped server's players offline", async () => {
    expect(await docker.stopContainer('b1c2d3e4', 5)).toMatchObject({ success: true });
    expect(stopped).toEqual(['stop:hytale-b1c2d3e4']);
    expect(clearOnlinePlayers).toHaveBeenCalledTimes(1);
    expect(clearOnlinePlayers).toHaveBeenCalledWith('b1c2d3e4');
  });

  it('keeps the default server for a call without id', async () => {
    await docker.stopContainer(undefined, 5);
    expect(stopped).toEqual(['stop:hytale-default']);
    expect(clearOnlinePlayers).toHaveBeenCalledWith(undefined);
  });

  it('does the same on a restart', async () => {
    expect(await docker.restartContainer('b1c2d3e4')).toMatchObject({ success: true });
    expect(stopped).toEqual(['restart:hytale-b1c2d3e4']);
    expect(clearOnlinePlayers).toHaveBeenCalledWith('b1c2d3e4');
  });

  it('still reports the stop as done when the player list cannot be updated', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    clearOnlinePlayers.mockRejectedValueOnce(new Error('players.json unreadable'));
    try {
      expect(await docker.stopContainer('b1c2d3e4', 5)).toMatchObject({ success: true });
      await vi.waitFor(() => expect(warn).toHaveBeenCalled());
      expect(String(warn.mock.calls[0][0])).toMatch(/b1c2d3e4/);
    } finally {
      warn.mockRestore();
    }
  });
});
