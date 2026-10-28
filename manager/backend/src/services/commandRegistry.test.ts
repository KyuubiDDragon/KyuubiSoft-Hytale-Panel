/**
 * Command registry cache: one full fetch, revision checks after the TTL or an
 * invalidation (commands_changed, plugin reconnect), the last good copy when
 * the plugin is gone (memory first, then the snapshot on disk), and the
 * helpers a registry-based whitelist will build on.
 */
import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

const { fetchRegistry } = vi.hoisted(() => ({ fetchRegistry: vi.fn() }));

vi.mock('./pluginCommands.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./pluginCommands.js')>()),
  fetchCommandRegistry: fetchRegistry,
}));
vi.mock('./servers.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./servers.js')>()),
  resolveServerId: async (id?: string) => id ?? 'default',
}));

const { config } = await import('../config.js');
const registryModule = await import('./commandRegistry.js');
const {
  getCommandRegistry,
  invalidateCommandRegistry,
  clearCommandRegistryCache,
  flattenCommands,
  withPanelPolicy,
  REGISTRY_TTL_MS,
} = registryModule;

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kp-cmdreg-'));
const originalDataPath = config.dataPath;
config.dataPath = tmpDir;

const REGISTRY = {
  revision: 'rev-1',
  generatedAt: '2026-10-22T10:00:00Z',
  count: 3,
  commands: [
    { name: 'help', aliases: ['?'], permission: 'hytale.command.help', builtin: true },
    {
      name: 'world',
      permission: 'hytale.command.world',
      builtin: true,
      subcommands: [
        { name: 'add', usage: '/world add <name>', requiredArgs: [{ name: 'name' }] },
        { name: 'list', aliases: ['ls'] },
      ],
    },
    { name: 'kspet', owner: 'KyuubiSoft:Pets', builtin: false },
  ],
};

async function waitForSnapshot(serverId: string): Promise<string> {
  const file = path.join(tmpDir, 'command-registry', `${serverId}.json`);
  for (let i = 0; i < 50 && !fs.existsSync(file); i++) {
    await new Promise((r) => setTimeout(r, 10));
  }
  return file;
}

beforeEach(() => {
  clearCommandRegistryCache();
  fetchRegistry.mockReset();
  vi.useRealTimers();
});

afterAll(() => {
  config.dataPath = originalDataPath;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('getCommandRegistry cache', () => {
  it('fetches the full list once and serves it from memory within the TTL', async () => {
    fetchRegistry.mockResolvedValue({ kind: 'registry', registry: REGISTRY });

    const first = await getCommandRegistry('alpha');
    const second = await getCommandRegistry('alpha');

    expect(first).toMatchObject({
      revision: 'rev-1',
      source: 'plugin',
      stale: false,
      serverId: 'alpha',
    });
    expect(second?.commands).toHaveLength(3);
    expect(fetchRegistry).toHaveBeenCalledOnce();
    expect(fetchRegistry).toHaveBeenCalledWith('alpha', undefined);
  });

  it('shares one request between concurrent callers', async () => {
    fetchRegistry.mockResolvedValue({ kind: 'registry', registry: REGISTRY });
    await Promise.all([getCommandRegistry('beta'), getCommandRegistry('beta')]);
    expect(fetchRegistry).toHaveBeenCalledOnce();
  });

  it('only asks for the revision after the TTL and keeps the copy when unchanged', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    fetchRegistry.mockResolvedValueOnce({ kind: 'registry', registry: REGISTRY });
    await getCommandRegistry('gamma');

    vi.setSystemTime(Date.now() + REGISTRY_TTL_MS + 1);
    fetchRegistry.mockResolvedValueOnce({ kind: 'unchanged', revision: 'rev-1' });
    const again = await getCommandRegistry('gamma');

    expect(fetchRegistry).toHaveBeenLastCalledWith('gamma', 'rev-1');
    expect(again).toMatchObject({ revision: 'rev-1', stale: false });
    expect(again?.commands).toHaveLength(3);
  });

  it('re-checks right away after an invalidation and picks up new commands', async () => {
    fetchRegistry.mockResolvedValueOnce({ kind: 'registry', registry: REGISTRY });
    await getCommandRegistry('delta');

    invalidateCommandRegistry('delta');
    const reloaded = {
      ...REGISTRY,
      revision: 'rev-2',
      count: 4,
      commands: [...REGISTRY.commands, { name: 'ksshop' }],
    };
    fetchRegistry.mockResolvedValueOnce({ kind: 'registry', registry: reloaded });
    const fresh = await getCommandRegistry('delta');

    expect(fetchRegistry).toHaveBeenCalledTimes(2);
    expect(fetchRegistry).toHaveBeenLastCalledWith('delta', 'rev-1');
    expect(fresh?.revision).toBe('rev-2');
    expect(fresh?.commands.map((c) => c.name)).toContain('ksshop');
  });

  it('does not trust a refresh that was still running when commands changed', async () => {
    fetchRegistry.mockResolvedValueOnce({ kind: 'registry', registry: REGISTRY });
    await getCommandRegistry('iota');
    invalidateCommandRegistry('iota');

    let answer: (value: unknown) => void = () => undefined;
    fetchRegistry.mockReturnValueOnce(new Promise((resolve) => (answer = resolve)));
    const slow = getCommandRegistry('iota');
    await vi.waitFor(() => expect(fetchRegistry).toHaveBeenCalledTimes(2));
    invalidateCommandRegistry('iota'); // commands_changed arrives mid-request
    answer({ kind: 'unchanged', revision: 'rev-1' });
    await slow;

    const reloaded = { ...REGISTRY, revision: 'rev-3' };
    fetchRegistry.mockResolvedValueOnce({ kind: 'registry', registry: reloaded });
    const next = await getCommandRegistry('iota');
    expect(fetchRegistry).toHaveBeenCalledTimes(3);
    expect(next?.revision).toBe('rev-3');
  });

  it('serves the last copy as stale while the plugin is unreachable', async () => {
    fetchRegistry.mockResolvedValueOnce({ kind: 'registry', registry: REGISTRY });
    await getCommandRegistry('epsilon');
    invalidateCommandRegistry('epsilon');
    fetchRegistry.mockResolvedValueOnce({ kind: 'unavailable', reason: 'ECONNREFUSED' });

    const offline = await getCommandRegistry('epsilon');
    expect(offline).toMatchObject({ revision: 'rev-1', source: 'plugin', stale: true });
  });

  it('falls back to the snapshot on disk after a panel restart', async () => {
    fetchRegistry.mockResolvedValueOnce({ kind: 'registry', registry: REGISTRY });
    await getCommandRegistry('zeta');
    await waitForSnapshot('zeta');

    clearCommandRegistryCache(); // what a panel restart leaves behind
    fetchRegistry.mockResolvedValueOnce({ kind: 'unavailable', reason: 'server stopped' });
    const fromDisk = await getCommandRegistry('zeta');

    expect(fetchRegistry).toHaveBeenLastCalledWith('zeta', 'rev-1');
    expect(fromDisk).toMatchObject({ revision: 'rev-1', source: 'snapshot', stale: true });
    expect(fromDisk?.commands).toHaveLength(3);
  });

  it('does not ask an unreachable plugin again for a while, unless invalidated', async () => {
    fetchRegistry.mockResolvedValueOnce({ kind: 'registry', registry: REGISTRY });
    await getCommandRegistry('kappa');
    invalidateCommandRegistry('kappa');
    fetchRegistry.mockResolvedValueOnce({ kind: 'unavailable', reason: 'ECONNREFUSED' });
    await getCommandRegistry('kappa');
    expect(fetchRegistry).toHaveBeenCalledTimes(2);

    // Within the retry window the last copy is served without a new request.
    const cached = await getCommandRegistry('kappa');
    expect(fetchRegistry).toHaveBeenCalledTimes(2);
    expect(cached).toMatchObject({ revision: 'rev-1', stale: true });

    // A reconnect (commands_changed / WS open) invalidates: ask again at once.
    invalidateCommandRegistry('kappa');
    fetchRegistry.mockResolvedValueOnce({ kind: 'unchanged', revision: 'rev-1' });
    expect(await getCommandRegistry('kappa')).toMatchObject({ revision: 'rev-1', stale: false });
    expect(fetchRegistry).toHaveBeenCalledTimes(3);
  });

  it('returns null when neither the plugin nor a snapshot has a list', async () => {
    fetchRegistry.mockResolvedValueOnce({ kind: 'unavailable', reason: 'plugin not installed' });
    expect(await getCommandRegistry('eta')).toBeNull();
  });

  it('refetches the full list when forced', async () => {
    fetchRegistry.mockResolvedValue({ kind: 'registry', registry: REGISTRY });
    await getCommandRegistry('theta');
    await getCommandRegistry('theta', { force: true });
    expect(fetchRegistry).toHaveBeenLastCalledWith('theta', undefined);
  });

  it('does not write a snapshot for a server id that is not a plain token', async () => {
    fetchRegistry.mockResolvedValue({ kind: 'registry', registry: REGISTRY });
    await getCommandRegistry('../escape');
    await new Promise((r) => setTimeout(r, 30));
    expect(fs.existsSync(path.join(tmpDir, 'escape.json'))).toBe(false);
    expect(fs.existsSync(path.join(tmpDir, 'command-registry', '..', 'escape.json'))).toBe(false);
  });
});

describe('registry helpers', () => {
  it('flattens commands and subcommands into console paths', () => {
    const flat = flattenCommands(REGISTRY);
    expect(flat.map((c) => c.path)).toEqual([
      '/help',
      '/world',
      '/world add',
      '/world list',
      '/kspet',
    ]);
    expect(flat.find((c) => c.path === '/world list')).toMatchObject({ aliases: ['ls'], depth: 1 });
    expect(flat.find((c) => c.path === '/kspet')).toMatchObject({ owner: 'KyuubiSoft:Pets' });
  });

  it('annotates commands and subcommands with the console tier the panel requires', () => {
    const annotated = withPanelPolicy(REGISTRY.commands);
    expect(annotated.find((c) => c.name === 'help')?.panel).toEqual({
      allowed: true,
      permission: 'console.execute',
    });
    const world = annotated.find((c) => c.name === 'world');
    expect(world?.panel.permission).toBe('console.execute.admin');
    expect(world?.subcommands?.find((c) => c.name === 'list')?.panel.permission).toBe(
      'console.execute',
    );
    expect(world?.subcommands?.find((c) => c.name === 'add')?.panel.permission).toBe(
      'console.execute.admin',
    );
    // Mod commands exist on the server, so they are allowed, on the admin tier.
    expect(annotated.find((c) => c.name === 'kspet')?.panel).toEqual({
      allowed: true,
      permission: 'console.execute.admin',
    });
  });
});
