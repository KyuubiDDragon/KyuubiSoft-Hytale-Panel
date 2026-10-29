/**
 * Regression tests for the native update settings mapping.
 *
 * Hytale 0.7 reads `Update` with PascalCase keys; the panel used to write a
 * camelCase `updateConfig` block that the server ignored. Its AutoApplyMode
 * enum only accepts "Disabled" / "WhenEmpty" / "Scheduled": a test server
 * refused to start with "WHEN_EMPTY" ("Failed to find enum value").
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { promises as fsp } from 'fs';
import path from 'path';
import os from 'os';
import {
  readUpdateSettings,
  validateUpdateSettingsPatch,
  applyUpdateSettings,
  migrateLegacyUpdateBlock,
  writeUpdateSettings,
  SERVER_UPDATE_DEFAULTS,
} from './updateSettings.js';

describe('readUpdateSettings', () => {
  it('reads the PascalCase Update block and fills server defaults', () => {
    const s = readUpdateSettings(
      { Update: { Enabled: false, AutoApplyMode: 'WhenEmpty', CheckIntervalSeconds: 600 } },
      'release',
    );
    expect(s).toEqual({
      ...SERVER_UPDATE_DEFAULTS,
      enabled: false,
      autoApplyMode: 'WHEN_EMPTY',
      checkIntervalSeconds: 600,
      patchline: 'release',
    });
  });

  it('ignores the legacy camelCase block the server never read', () => {
    const s = readUpdateSettings(
      { updateConfig: { enabled: false, autoApplyMode: 'SCHEDULED' } },
      'pre-release',
    );
    expect(s.enabled).toBe(true);
    expect(s.autoApplyMode).toBe('DISABLED');
    expect(s.patchline).toBe('pre-release');
  });

  it('maps every server spelling of the mode, and tolerates the upper-case one', () => {
    const mode = (v: unknown) =>
      readUpdateSettings({ Update: { AutoApplyMode: v } }, 'release').autoApplyMode;
    expect(mode('Disabled')).toBe('DISABLED');
    expect(mode('WhenEmpty')).toBe('WHEN_EMPTY');
    expect(mode('Scheduled')).toBe('SCHEDULED');
    expect(mode('WHEN_EMPTY')).toBe('WHEN_EMPTY');
    expect(mode('Sometimes')).toBe('DISABLED');
  });

  it('prefers an explicit Update.Patchline over the panel patchline', () => {
    expect(readUpdateSettings({ Update: { Patchline: 'pre-release' } }, 'release').patchline).toBe(
      'pre-release',
    );
  });
});

describe('validateUpdateSettingsPatch', () => {
  const current = { ...SERVER_UPDATE_DEFAULTS, patchline: 'release' };

  it('accepts the full object the UI sends back, including the unchanged patchline', () => {
    const r = validateUpdateSettingsPatch({ ...current, autoApplyMode: 'SCHEDULED' }, current);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.patch.autoApplyMode).toBe('SCHEDULED');
      expect(r.patch).not.toHaveProperty('patchline');
    }
  });

  it('rejects a patchline change, bad types and out-of-range numbers', () => {
    expect(validateUpdateSettingsPatch({ patchline: 'pre-release' }, current).ok).toBe(false);
    expect(validateUpdateSettingsPatch({ enabled: 'yes' }, current).ok).toBe(false);
    expect(validateUpdateSettingsPatch({ checkIntervalSeconds: 30 }, current).ok).toBe(false);
    expect(validateUpdateSettingsPatch({ autoApplyDelayMinutes: 0 }, current).ok).toBe(false);
    expect(validateUpdateSettingsPatch({ autoApplyMode: 'ALWAYS' }, current).ok).toBe(false);
  });
});

describe('applyUpdateSettings', () => {
  it('writes PascalCase keys, keeps other config and drops the legacy block', () => {
    const original = {
      ServerName: 'My Server',
      Update: { Enabled: true, Patchline: 'release', SomeFutureKey: 1 },
      updateConfig: { enabled: false },
    };
    const next = applyUpdateSettings(original, { enabled: false, autoApplyDelayMinutes: 10 });
    expect(next).toEqual({
      ServerName: 'My Server',
      Update: { Enabled: false, Patchline: 'release', SomeFutureKey: 1, AutoApplyDelayMinutes: 10 },
    });
    // immutable: the input is untouched
    expect(original.updateConfig).toEqual({ enabled: false });
    expect(original.Update.Enabled).toBe(true);
  });

  it('writes the mode in the spelling the server accepts and repairs an old one', () => {
    expect(applyUpdateSettings({}, { autoApplyMode: 'WHEN_EMPTY' })).toEqual({
      Update: { AutoApplyMode: 'WhenEmpty' },
    });
    expect(applyUpdateSettings({ Update: { AutoApplyMode: 'SCHEDULED' } }, {})).toEqual({
      Update: { AutoApplyMode: 'Scheduled' },
    });
  });
});

describe('migrateLegacyUpdateBlock', () => {
  it('returns null when there is nothing to migrate or repair', () => {
    expect(
      migrateLegacyUpdateBlock({ Update: { Enabled: true, AutoApplyMode: 'WhenEmpty' } }),
    ).toBeNull();
    expect(migrateLegacyUpdateBlock(null)).toBeNull();
  });

  it('repairs an upper-case mode that keeps the server from starting', () => {
    expect(migrateLegacyUpdateBlock({ Update: { AutoApplyMode: 'WHEN_EMPTY' } })).toEqual({
      Update: { AutoApplyMode: 'WhenEmpty' },
    });
  });

  it('carries legacy values over, without the patchline and without overriding Update', () => {
    const migrated = migrateLegacyUpdateBlock({
      MaxPlayers: 20,
      Update: { AutoApplyDelayMinutes: 15 },
      updateConfig: {
        enabled: true,
        checkIntervalSeconds: 3600,
        patchline: 'pre-release',
        autoApplyMode: 'WHEN_EMPTY',
        autoApplyDelayMinutes: 5,
        notifyPlayersOnAvailable: 'not-a-bool',
      },
    });
    expect(migrated).toEqual({
      MaxPlayers: 20,
      Update: {
        AutoApplyDelayMinutes: 15,
        Enabled: true,
        CheckIntervalSeconds: 3600,
        AutoApplyMode: 'WhenEmpty',
      },
    });
  });
});

describe('writeUpdateSettings', () => {
  let dir: string;
  beforeAll(async () => {
    dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'update-settings-test-'));
  });
  afterAll(async () => {
    await fsp.rm(dir, { recursive: true, force: true });
  });

  it('merges into an existing config.json without losing other keys', async () => {
    const file = path.join(dir, 'config.json');
    await fsp.writeFile(
      file,
      JSON.stringify({ ServerName: 'A', Defaults: { GameMode: 'Adventure' } }),
    );
    await writeUpdateSettings(file, { autoApplyMode: 'WHEN_EMPTY' });
    expect(JSON.parse(await fsp.readFile(file, 'utf-8'))).toEqual({
      ServerName: 'A',
      Defaults: { GameMode: 'Adventure' },
      Update: { AutoApplyMode: 'WhenEmpty' },
    });
  });

  it('refuses to overwrite a corrupt config.json', async () => {
    const file = path.join(dir, 'broken.json');
    await fsp.writeFile(file, '{ not json');
    await expect(writeUpdateSettings(file, { enabled: false })).rejects.toThrow();
    expect(await fsp.readFile(file, 'utf-8')).toBe('{ not json');
  });
});
