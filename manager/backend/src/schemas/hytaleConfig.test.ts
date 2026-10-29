import { describe, it, expect } from 'vitest';
import {
  HytaleConfigSchema,
  migrateLegacyServerConfig,
  normalizeGameMode,
  parseHytaleConfig,
} from './hytaleConfig.js';

// What a Hytale 0.7.3 server writes on its first start (trimmed).
const SERVER_WRITTEN = {
  Version: 4,
  ServerName: 'Hytale Server',
  MOTD: '',
  Password: '',
  MaxPlayers: 100,
  MaxViewRadius: 32,
  Defaults: { World: 'default', GameMode: 'Adventure', HardcoreMode: 'None', CrashRecovery: {} },
  ConnectionTimeouts: { PlayTimeout: 'PT3M' },
  RateLimit: {},
  Modules: { PathPlugin: { Modules: {} } },
  LogLevels: {},
  Mods: { 'electro:HyCitizensRoles': { Enabled: true } },
  RequireJoinPermission: false,
  DisplayTmpTagsInStrings: false,
  PlayerStorage: { Type: 'Hytale' },
  BanStorage: { Type: 'Disk', Path: 'bans.json' },
  AuthCredentialStore: { Type: 'Encrypted', Path: 'auth.enc' },
  Update: {},
  Backup: {},
  WorldMap: {},
};

describe('parseHytaleConfig', () => {
  it('accepts the config a 0.7 server writes', () => {
    const r = parseHytaleConfig(SERVER_WRITTEN);
    expect(r.ok).toBe(true);
    expect(r.issues).toEqual([]);
    expect(r.warnings).toEqual([]);
  });

  it('accepts values the server takes as they are (empty name, MaxPlayers 0 = no limit)', () => {
    expect(parseHytaleConfig({ ServerName: '', MaxPlayers: 0 }).ok).toBe(true);
  });

  it('refuses what keeps the server from starting', () => {
    for (const bad of [
      { MaxPlayers: 'ten' },
      { MaxPlayers: 1.5 },
      { MaxPlayers: 2 ** 31 },
      { RequireJoinPermission: 'yes' },
      { Defaults: { GameMode: 'Survival' } },
      { Defaults: { GameMode: 'Exploration' } },
      { Defaults: { HardcoreMode: 'Sometimes' } },
      { Update: { AutoApplyMode: 'WHEN_EMPTY' } },
      { Backup: { FrequencyMinutes: 0 } },
      { FallbackServer: { Host: 'lobby', Port: 70000 } },
    ]) {
      const r = parseHytaleConfig(bad);
      expect(r.ok, JSON.stringify(bad)).toBe(false);
      expect(r.issues.length).toBeGreaterThan(0);
    }
    expect(parseHytaleConfig([]).ok).toBe(false);
    expect(parseHytaleConfig('{}').ok).toBe(false);
  });

  it('reads game and hardcore modes case-insensitively like the server', () => {
    expect(
      parseHytaleConfig({ Defaults: { GameMode: 'creative', HardcoreMode: 'perplayer' } }).ok,
    ).toBe(true);
    expect(normalizeGameMode('ADVENTURE')).toBe('Adventure');
    expect(normalizeGameMode('Survival')).toBeNull();
    expect(normalizeGameMode(1)).toBeNull();
  });

  it('accepts the update modes in the spelling of config.json', () => {
    expect(parseHytaleConfig({ Update: { AutoApplyMode: 'WhenEmpty' } }).ok).toBe(true);
  });

  it('knows SentryDsn: empty (off) and a URL are kept without a warning, other types refused', () => {
    for (const dsn of ['', 'https://key@o0.ingest.example.invalid/1']) {
      const r = parseHytaleConfig({ ...SERVER_WRITTEN, SentryDsn: dsn });
      expect(r).toMatchObject({ ok: true, issues: [], warnings: [] });
      expect((r.config as Record<string, unknown>).SentryDsn).toBe(dsn);
    }
    for (const dsn of [42, true, null, {}]) {
      const r = parseHytaleConfig({ SentryDsn: dsn });
      expect(r.ok, JSON.stringify(dsn)).toBe(false);
      expect(r.issues.join()).toContain('SentryDsn');
    }
  });

  it('warns about a view radius the server clamps and about keys it ignores', () => {
    const r = parseHytaleConfig({ MaxViewRadius: 64, Whitelist: true, ViewRadius: 12 });
    expect(r.ok).toBe(true);
    expect(r.warnings).toEqual([
      'MaxViewRadius: the server uses 32 (allowed 1-32)',
      'Whitelist: not a server setting; the server ignores it',
      'ViewRadius: not a server setting; the server ignores it',
    ]);
  });

  it('keeps fields it does not model', () => {
    const result = HytaleConfigSchema.safeParse({
      ServerName: 'OK',
      FutureHytaleField: { nested: 1 },
      Defaults: { GameMode: 'Adventure', NewDefault: 2 },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect((result.data as Record<string, unknown>).FutureHytaleField).toEqual({ nested: 1 });
      expect((result.data.Defaults as Record<string, unknown>).NewDefault).toBe(2);
    }
  });
});

describe('migrateLegacyServerConfig', () => {
  const legacy = {
    ...SERVER_WRITTEN,
    MaxViewRadius: undefined,
    Whitelist: true,
    AllowOp: true,
    ViewRadius: 12,
    Defaults: { GameMode: 'Survival', World: 'default' },
  };

  it('removes, renames and repairs what older panels wrote', () => {
    const input = JSON.parse(JSON.stringify(legacy));
    const r = migrateLegacyServerConfig(input);
    expect(r).not.toBeNull();
    expect(r!.config).not.toHaveProperty('Whitelist');
    expect(r!.config).not.toHaveProperty('AllowOp');
    expect(r!.config).not.toHaveProperty('ViewRadius');
    expect(r!.config.MaxViewRadius).toBe(12);
    expect(r!.config.Defaults).toEqual({ GameMode: 'Adventure', World: 'default' });
    // The whitelist was never active: it is not switched on now.
    expect(r!.config.RequireJoinPermission).toBe(false);
    expect(r!.changes.map((c) => [c.key, c.action])).toEqual([
      ['Whitelist', 'removed'],
      ['AllowOp', 'removed'],
      ['ViewRadius', 'renamed'],
      ['Defaults.GameMode', 'repaired'],
    ]);
    expect(parseHytaleConfig(r!.config).ok).toBe(true);
    // Pure: the input is untouched.
    expect(input).toEqual(JSON.parse(JSON.stringify(legacy)));
  });

  it('is idempotent', () => {
    const once = migrateLegacyServerConfig(legacy)!.config;
    expect(migrateLegacyServerConfig(once)).toBeNull();
    expect(migrateLegacyServerConfig(SERVER_WRITTEN)).toBeNull();
  });

  it('keeps an existing MaxViewRadius and drops an unusable ViewRadius', () => {
    const kept = migrateLegacyServerConfig({ MaxViewRadius: 20, ViewRadius: 12 })!;
    expect(kept.config).toEqual({ MaxViewRadius: 20 });
    expect(kept.changes[0]).toMatchObject({ key: 'ViewRadius', action: 'removed' });
    const unusable = migrateLegacyServerConfig({ ViewRadius: 64 })!;
    expect(unusable.config).toEqual({});
  });

  it('leaves anything that is not an object alone', () => {
    expect(migrateLegacyServerConfig(null)).toBeNull();
    expect(migrateLegacyServerConfig([1])).toBeNull();
  });
});
