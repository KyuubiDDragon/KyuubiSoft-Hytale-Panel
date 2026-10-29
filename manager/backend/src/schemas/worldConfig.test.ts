import { describe, it, expect } from 'vitest';
import {
  applyWorldPatch,
  changedWorldKeys,
  migrateLegacyWorldConfig,
  parseWorldConfig,
  pickWorldPatch,
  readWorldFields,
  validateWorldPatch,
  worldFieldModes,
  worldFieldName,
  worldKeyApply,
} from './worldConfig.js';
import { parseLosslessJson, stringifyJson } from '../utils/losslessJson.js';

const WORLD = {
  Version: 4,
  DisplayName: 'Spawn',
  Seed: 1234,
  IsPvpEnabled: false,
  GameTime: '0001-01-01T08:00:00Z',
  ClientEffects: { BloomIntensity: 0.3 },
  WorldGen: { Type: 'Hytale', Name: 'Default' },
};

describe('parseWorldConfig', () => {
  it('accepts a world config and keeps a seed beyond 2^53 exactly', () => {
    const text = '{"Seed": 9007199254740993, "IsPvpEnabled": true, "WorldGen": {"Type": "Flat"}}';
    const parsed = parseLosslessJson(text) as Record<string, unknown>;
    expect(parseWorldConfig(parsed).ok).toBe(true);
    expect(stringifyJson(parsed)).toContain('9007199254740993');
  });

  it('refuses wrong types and a game mode the world codec does not know', () => {
    expect(parseWorldConfig({ IsPvpEnabled: 'yes' }).ok).toBe(false);
    expect(parseWorldConfig({ GameMode: 'creative' }).ok).toBe(false);
    expect(parseWorldConfig({ DaytimeDurationSeconds: 1.5 }).ok).toBe(false);
    expect(parseWorldConfig([]).ok).toBe(false);
  });

  it('warns about the duration keys older panels wrote', () => {
    const r = parseWorldConfig({ DaytimeDurationSecondsOverride: 600 });
    expect(r.ok).toBe(true);
    expect(r.warnings).toEqual([
      'DaytimeDurationSecondsOverride: not a world setting; the server reads DaytimeDurationSeconds',
    ]);
  });
});

describe('world editor patch', () => {
  it('validates fields and ignores what it does not know', () => {
    const r = validateWorldPatch({
      isPvpEnabled: true,
      gameMode: 'Creative',
      daytimeDurationSeconds: 900,
      nighttimeDurationSeconds: '',
      displayName: 'Hub',
      seed: 'ignored',
      clientEffects: { bloomIntensity: 0.5, sunIntensity: '' },
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.patch.set).toEqual({
      IsPvpEnabled: true,
      GameMode: 'Creative',
      DaytimeDurationSeconds: 900,
      NighttimeDurationSeconds: null,
      DisplayName: 'Hub',
    });
    expect(r.patch.clientEffects).toEqual({ BloomIntensity: 0.5 });
  });

  it('refuses invalid values', () => {
    for (const body of [
      { isPvpEnabled: 'true' },
      { gameMode: 'Survival' },
      { daytimeDurationSeconds: 0 },
      { daytimeDurationSeconds: 86_401 },
      { gameplayConfig: '../x' },
      { gameplayConfig: null },
      { displayName: 'a\nb' },
      { clientEffects: { bloomIntensity: Number.POSITIVE_INFINITY } },
      { clientEffects: 'x' },
    ]) {
      expect(validateWorldPatch(body).ok, JSON.stringify(body)).toBe(false);
    }
    expect(validateWorldPatch(null).ok).toBe(false);
  });

  it('lists the keys that really change and applies them on a copy', () => {
    const r = validateWorldPatch({
      isPvpEnabled: true,
      displayName: 'Spawn',
      clientEffects: { bloomIntensity: 0.3, bloomPower: 2 },
    });
    if (!r.ok) throw new Error(r.error);
    expect(changedWorldKeys(WORLD, r.patch)).toEqual(['IsPvpEnabled', 'ClientEffects.BloomPower']);
    const before = JSON.parse(JSON.stringify(WORLD));
    const next = applyWorldPatch(WORLD, r.patch);
    expect(next).toMatchObject({ IsPvpEnabled: true, WorldGen: WORLD.WorldGen });
    expect(next.ClientEffects).toEqual({ BloomIntensity: 0.3, BloomPower: 2 });
    expect(WORLD).toEqual(before);
  });

  it('counts a missing key as the server fallback, so a full form changes nothing', () => {
    const r = validateWorldPatch({ ...readWorldFields(WORLD), isPvpEnabled: true });
    if (!r.ok) throw new Error(r.error);
    const changed = changedWorldKeys(WORLD, r.patch);
    expect(changed).toEqual(['IsPvpEnabled']);
    expect(pickWorldPatch(r.patch, changed)).toEqual({ set: { IsPvpEnabled: true }, clientEffects: {} });
    expect(applyWorldPatch(WORLD, pickWorldPatch(r.patch, changed))).not.toHaveProperty('IsTicking');
  });

  it('removes a cleared key', () => {
    const r = validateWorldPatch({ displayName: null });
    if (!r.ok) throw new Error(r.error);
    expect(changedWorldKeys(WORLD, r.patch)).toEqual(['DisplayName']);
    expect(applyWorldPatch(WORLD, r.patch)).not.toHaveProperty('DisplayName');
  });

  it('reads the editor fields with the server fallbacks', () => {
    const fields = readWorldFields({ IsPvpEnabled: true });
    expect(fields).toMatchObject({
      isPvpEnabled: true,
      isFallDamageEnabled: true,
      gameplayConfig: 'Default',
      gameMode: null,
      daytimeDurationSeconds: null,
    });
    expect(fields).not.toHaveProperty('clientEffects');
  });

  it('names fields and how they take effect', () => {
    expect(worldFieldName('IsPvpEnabled')).toBe('isPvpEnabled');
    expect(worldFieldName('ClientEffects.BloomPower')).toBe('clientEffects');
    expect(worldKeyApply('IsPvpEnabled')).toBe('live');
    expect(worldKeyApply('IsGameTimePaused')).toBe('live');
    expect(worldKeyApply('GameMode')).toBe('restart');
    expect(worldKeyApply('ClientEffects.BloomPower')).toBe('restart');
    expect(worldFieldModes()).toMatchObject({ isPvpEnabled: 'live', clientEffects: 'restart' });
  });
});

describe('migrateLegacyWorldConfig', () => {
  it('moves the ...Override durations to the real keys, once', () => {
    const legacy = {
      ...WORLD,
      DaytimeDurationSecondsOverride: 600,
      NighttimeDurationSecondsOverride: 0,
    };
    const r = migrateLegacyWorldConfig(legacy)!;
    expect(r.config.DaytimeDurationSeconds).toBe(600);
    expect(r.config).not.toHaveProperty('DaytimeDurationSecondsOverride');
    expect(r.config).not.toHaveProperty('NighttimeDurationSecondsOverride');
    expect(r.config).not.toHaveProperty('NighttimeDurationSeconds');
    expect(r.changes.map((c) => c.action)).toEqual(['renamed', 'removed']);
    expect(migrateLegacyWorldConfig(r.config)).toBeNull();
    expect(legacy.DaytimeDurationSecondsOverride).toBe(600);
  });

  it('does not overwrite a real key that is already set', () => {
    const r = migrateLegacyWorldConfig({
      DaytimeDurationSeconds: 300,
      DaytimeDurationSecondsOverride: 600,
    })!;
    expect(r.config).toEqual({ DaytimeDurationSeconds: 300 });
  });
});
