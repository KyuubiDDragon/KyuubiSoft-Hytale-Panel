import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { PluginCommandAttempt } from './pluginCommands.js';

const runCommandViaPlugin = vi.fn<(command: string) => Promise<PluginCommandAttempt>>();
vi.mock('./pluginCommands.js', () => ({
  runCommandViaPlugin: (command: string) => runCommandViaPlugin(command),
}));

const {
  applyLiveQuickSettings,
  applyQuickSettings,
  changedQuickSettings,
  numberFromReply,
  quickSettingModes,
  readLiveQuickSettings,
  readQuickSettings,
  validateQuickSettingsPatch,
} = await import('./serverSettings.js');

function reply(messageIds: string[], text: string, ok = true): PluginCommandAttempt {
  return {
    kind: 'reply',
    reply: {
      ok,
      status: ok ? 'DONE' : 'FAILED',
      command: '',
      sender: 'Panel:tester',
      output: [text],
      messageIds,
      error: null,
      truncated: false,
      durationMs: 1,
    },
  };
}

beforeEach(() => runCommandViaPlugin.mockReset());

describe('quick settings', () => {
  it('reads the server fallbacks for missing or mistyped keys', () => {
    expect(readQuickSettings({ MaxPlayers: '50', Defaults: { GameMode: 'creative' } })).toEqual({
      serverName: 'Hytale Server',
      motd: '',
      password: '',
      maxPlayers: 100,
      maxViewRadius: 32,
      defaultGameMode: 'Creative',
    });
  });

  it('validates every field against what the server accepts', () => {
    expect(validateQuickSettingsPatch({ maxPlayers: 0, maxViewRadius: 32 }).ok).toBe(true);
    for (const body of [
      { maxPlayers: -1 },
      { maxPlayers: 10.5 },
      { maxPlayers: '20' },
      { maxViewRadius: 33 },
      { maxViewRadius: 0 },
      { defaultGameMode: 'Survival' },
      { serverName: '   ' },
      { motd: 'line\nbreak' },
      { password: 'x'.repeat(129) },
    ]) {
      const r = validateQuickSettingsPatch(body);
      expect(r.ok, JSON.stringify(body)).toBe(false);
    }
    const r = validateQuickSettingsPatch({
      serverName: '  My Server ',
      defaultGameMode: 'CREATIVE',
      unknown: 1,
    });
    expect(r).toEqual({
      ok: true,
      patch: { serverName: 'My Server', defaultGameMode: 'Creative' },
    });
  });

  it('applies a patch on a copy and keeps every other key', () => {
    const config = {
      MaxPlayers: 10,
      Defaults: { World: 'default', GameMode: 'Adventure' },
      Mods: { a: 1 },
    };
    const before = JSON.parse(JSON.stringify(config));
    const next = applyQuickSettings(config, { maxPlayers: 30, defaultGameMode: 'Creative' });
    expect(next).toEqual({
      MaxPlayers: 30,
      Defaults: { World: 'default', GameMode: 'Creative' },
      Mods: { a: 1 },
    });
    expect(config).toEqual(before);
  });

  it('lists only changed fields', () => {
    const current = readQuickSettings({ MaxPlayers: 10 });
    expect(changedQuickSettings(current, { maxPlayers: 10, motd: 'hi' })).toEqual(['motd']);
  });

  it('marks max players and view radius as live, the rest as restart', () => {
    expect(quickSettingModes()).toEqual({
      serverName: 'restart',
      motd: 'restart',
      password: 'restart',
      maxPlayers: 'live',
      maxViewRadius: 'live',
      defaultGameMode: 'restart',
    });
  });

  it('reads the first number of a reply', () => {
    expect(numberFromReply(['Max players is set to 1,000'])).toBe(1000);
    expect(numberFromReply(['no number'])).toBeNull();
  });
});

describe('live changes', () => {
  it('counts a change only when the server confirms it', async () => {
    runCommandViaPlugin
      .mockResolvedValueOnce(reply(['server.commands.maxplayers.set'], 'Max players set to 30'))
      .mockResolvedValueOnce(
        reply(['server.commands.maxviewradius.noHigherThan'], 'no higher than 32'),
      );
    const r = await applyLiveQuickSettings(
      ['maxPlayers', 'maxViewRadius'],
      { maxPlayers: 30, maxViewRadius: 20 },
      undefined,
      'tester',
    );
    expect(runCommandViaPlugin.mock.calls.map((c) => c[0])).toEqual([
      '/maxplayers --amount 30',
      '/maxviewradius 20',
    ]);
    expect(r).toEqual({
      kind: 'applied',
      results: [
        { field: 'maxPlayers', ok: true, message: 'Max players set to 30' },
        { field: 'maxViewRadius', ok: false, message: 'no higher than 32' },
      ],
    });
  });

  it('reports unavailable when the plugin does not take the first command', async () => {
    runCommandViaPlugin.mockResolvedValue({ kind: 'unavailable', reason: 'plugin not installed' });
    const r = await applyLiveQuickSettings(
      ['maxPlayers'],
      { maxPlayers: 30 },
      undefined,
      undefined,
    );
    expect(r).toEqual({ kind: 'unavailable', reason: 'plugin not installed' });
  });

  it('reads the live values with the query form', async () => {
    runCommandViaPlugin
      .mockResolvedValueOnce(reply(['server.commands.maxplayers.getInfinite'], 'unlimited'))
      .mockResolvedValueOnce(reply(['server.commands.maxviewradius.get'], 'Max view radius is 12'));
    expect(await readLiveQuickSettings(undefined, undefined)).toEqual({
      maxPlayers: 0,
      maxViewRadius: 12,
    });
    expect(runCommandViaPlugin.mock.calls.map((c) => c[0])).toEqual([
      '/maxplayers',
      '/maxviewradius',
    ]);
    runCommandViaPlugin.mockReset();
    runCommandViaPlugin.mockResolvedValue({ kind: 'unavailable', reason: 'down' });
    expect(await readLiveQuickSettings(undefined, undefined)).toBeNull();
  });
});
