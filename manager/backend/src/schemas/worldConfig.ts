/**
 * Schema and editable fields of a Hytale 0.7 world config
 * (universe/worlds/<name>/config.json).
 *
 * As with the server config, an error is only what keeps the server from
 * loading the world (wrong type, unknown game mode); everything else in the
 * file is passed through. The server holds the config of a loaded world in
 * memory and writes it back whenever the world stops, so the panel only
 * writes it while the server is stopped; PvP and the time pause can be
 * switched live (`/world config pvp`, `/world config pausetime`).
 */
import { z } from 'zod';
import { isJsonObject, isRawJsonNumber } from '../utils/losslessJson.js';
import { SERVER_GAME_MODES, type LegacyChange } from './hytaleConfig.js';

const int32 = () => z.number().int().min(-2147483648).max(2147483647);
const anyObject = () => z.object({}).passthrough();
// A Java long: a safe integer, or an integer JSON.parse could only keep raw.
const javaLong = z.union([z.number().int(), z.custom<unknown>((v) => isRawJsonNumber(v))]);

const ClientEffectsSchema = z
  .object({
    SunHeightPercent: z.number().optional(),
    SunAngleDegrees: z.number().optional(),
    BloomIntensity: z.number().optional(),
    BloomPower: z.number().optional(),
    SunIntensity: z.number().optional(),
    SunshaftIntensity: z.number().optional(),
    SunshaftScaleFactor: z.number().optional(),
  })
  .passthrough();

const bool = () => z.boolean().optional();

export const WorldConfigSchema = z
  .object({
    Version: int32().optional(),
    DisplayName: z.string().optional(),
    Seed: javaLong.optional(),
    IsTicking: bool(),
    IsBlockTicking: bool(),
    IsPvpEnabled: bool(),
    IsFallDamageEnabled: bool(),
    IsGameTimePaused: bool(),
    GameTime: z.string().optional(),
    ForcedWeather: z.string().optional(),
    ClientEffects: ClientEffectsSchema.optional(),
    RequiredPlugins: anyObject().optional(),
    // Exact spelling; unlike the server default, the world codec is case-sensitive.
    GameMode: z.enum(SERVER_GAME_MODES).optional(),
    DefaultPermissionGroup: z.string().optional(),
    IsSpawningNPC: bool(),
    IsBlockSpawnersEnabled: bool(),
    IsSpawnMarkersEnabled: bool(),
    IsAllNPCFrozen: bool(),
    GameplayConfig: z.string().optional(),
    Death: anyObject().optional(),
    DaytimeDurationSeconds: int32().optional(),
    NighttimeDurationSeconds: int32().optional(),
    IsCompassUpdating: bool(),
    IsSavingPlayers: bool(),
    IsSavingChunks: bool(),
    SaveNewChunks: bool(),
    IsUnloadingChunks: bool(),
    IsObjectiveMarkersEnabled: bool(),
    DeleteOnUniverseStart: bool(),
    DeleteOnRemove: bool(),
    CrashRecovery: anyObject().optional(),
    DisabledFluidTickers: z.array(z.string()).optional(),
  })
  .passthrough();

export interface WorldConfigParseResult {
  ok: boolean;
  issues: string[];
  warnings: string[];
}

/** Keys earlier panel versions wrote instead of the real ones. */
export const LEGACY_WORLD_KEYS: Readonly<Record<string, string>> = {
  DaytimeDurationSecondsOverride: 'DaytimeDurationSeconds',
  NighttimeDurationSecondsOverride: 'NighttimeDurationSeconds',
};

export function parseWorldConfig(raw: unknown): WorldConfigParseResult {
  if (!isJsonObject(raw)) {
    return { ok: false, issues: ['<root>: must be a JSON object'], warnings: [] };
  }
  const warnings = Object.keys(LEGACY_WORLD_KEYS)
    .filter((k) => k in raw)
    .map((k) => `${k}: not a world setting; the server reads ${LEGACY_WORLD_KEYS[k]}`);
  const result = WorldConfigSchema.safeParse(raw);
  if (result.success) return { ok: true, issues: [], warnings };
  return {
    ok: false,
    issues: result.error.issues.map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`),
    warnings,
  };
}

/**
 * Moves the day/night durations earlier panel versions saved under
 * `...Override` keys (which the server never read) to the real keys, unless
 * those are set already. Pure and idempotent: null when there is nothing to do.
 */
export function migrateLegacyWorldConfig(
  raw: unknown,
): { config: Record<string, unknown>; changes: LegacyChange[] } | null {
  if (!isJsonObject(raw)) return null;
  const next: Record<string, unknown> = { ...raw };
  const changes: LegacyChange[] = [];
  for (const [legacy, real] of Object.entries(LEGACY_WORLD_KEYS)) {
    if (!(legacy in next)) continue;
    const value = next[legacy];
    delete next[legacy];
    const usable = isDurationSeconds(value);
    if (usable && next[real] === undefined) {
      next[real] = value;
      changes.push({
        key: legacy,
        action: 'renamed',
        value,
        to: real,
        note: `The server reads ${real}.`,
      });
    } else {
      changes.push({
        key: legacy,
        action: 'removed',
        value,
        note: usable ? `${real} is already set.` : 'Not a usable duration.',
      });
    }
  }
  return changes.length > 0 ? { config: next, changes } : null;
}

// ---------------------------------------------------------------------------
// Fields of the world editor
// ---------------------------------------------------------------------------

/** Longest day or night phase the editor accepts (one real day). */
export const MAX_DURATION_SECONDS = 86_400;
const DISPLAY_NAME_MAX = 64;
const ASSET_ID = /^[A-Za-z0-9_][A-Za-z0-9_.:/-]{0,127}$/;
// eslint-disable-next-line no-control-regex -- rejects control characters
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

function isDurationSeconds(v: unknown): v is number {
  return Number.isInteger(v) && (v as number) >= 1 && (v as number) <= MAX_DURATION_SECONDS;
}

export type WorldFieldApply = 'live' | 'restart';

type FieldKind = 'boolean' | 'string' | 'assetId' | 'gameMode' | 'duration';

interface WorldField {
  key: string;
  kind: FieldKind;
  /** What the server uses when the key is absent; null = nothing (inherit). */
  fallback: unknown;
  apply: WorldFieldApply;
  /** Removing the key is allowed (null in the request). */
  clearable?: boolean;
}

const B = (key: string, fallback: boolean, apply: WorldFieldApply = 'restart'): WorldField => ({
  key,
  kind: 'boolean',
  fallback,
  apply,
});

/** camelCase API name → field of the world config. */
export const WORLD_FIELDS: Readonly<Record<string, WorldField>> = {
  displayName: {
    key: 'DisplayName',
    kind: 'string',
    fallback: null,
    apply: 'restart',
    clearable: true,
  },
  isTicking: B('IsTicking', true),
  isBlockTicking: B('IsBlockTicking', true),
  isPvpEnabled: B('IsPvpEnabled', false, 'live'),
  isFallDamageEnabled: B('IsFallDamageEnabled', true),
  isGameTimePaused: B('IsGameTimePaused', false, 'live'),
  isSpawningNPC: B('IsSpawningNPC', true),
  isBlockSpawnersEnabled: B('IsBlockSpawnersEnabled', true),
  isSpawnMarkersEnabled: B('IsSpawnMarkersEnabled', true),
  isAllNPCFrozen: B('IsAllNPCFrozen', false),
  isObjectiveMarkersEnabled: B('IsObjectiveMarkersEnabled', true),
  isCompassUpdating: B('IsCompassUpdating', true),
  isSavingPlayers: B('IsSavingPlayers', true),
  isSavingChunks: B('IsSavingChunks', true),
  saveNewChunks: B('SaveNewChunks', true),
  isUnloadingChunks: B('IsUnloadingChunks', true),
  deleteOnUniverseStart: B('DeleteOnUniverseStart', false),
  deleteOnRemove: B('DeleteOnRemove', false),
  gameMode: {
    key: 'GameMode',
    kind: 'gameMode',
    fallback: null,
    apply: 'restart',
    clearable: true,
  },
  gameplayConfig: { key: 'GameplayConfig', kind: 'assetId', fallback: 'Default', apply: 'restart' },
  daytimeDurationSeconds: {
    key: 'DaytimeDurationSeconds',
    kind: 'duration',
    fallback: null,
    apply: 'restart',
    clearable: true,
  },
  nighttimeDurationSeconds: {
    key: 'NighttimeDurationSeconds',
    kind: 'duration',
    fallback: null,
    apply: 'restart',
    clearable: true,
  },
};

export const CLIENT_EFFECT_KEYS: Readonly<Record<string, string>> = {
  sunHeightPercent: 'SunHeightPercent',
  sunAngleDegrees: 'SunAngleDegrees',
  bloomIntensity: 'BloomIntensity',
  bloomPower: 'BloomPower',
  sunIntensity: 'SunIntensity',
  sunshaftIntensity: 'SunshaftIntensity',
  sunshaftScaleFactor: 'SunshaftScaleFactor',
};
// Plenty for every effect; keeps the value a sane float.
const CLIENT_EFFECT_LIMIT = 100_000;

/** The editor's view of a world config: every field with the server's fallback. */
export function readWorldFields(config: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [name, field] of Object.entries(WORLD_FIELDS)) {
    out[name] = config[field.key] ?? field.fallback;
  }
  const effects = isJsonObject(config.ClientEffects) ? config.ClientEffects : null;
  if (effects) {
    out.clientEffects = Object.fromEntries(
      Object.entries(CLIENT_EFFECT_KEYS).map(([name, key]) => [name, effects[key]]),
    );
  }
  return out;
}

function checkValue(name: string, field: WorldField, value: unknown): string | null {
  if (value === null) return field.clearable ? null : `${name} cannot be removed`;
  switch (field.kind) {
    case 'boolean':
      return typeof value === 'boolean' ? null : `${name} must be true or false`;
    case 'string':
      return typeof value === 'string' &&
        value.length <= DISPLAY_NAME_MAX &&
        !CONTROL_CHARS.test(value)
        ? null
        : `${name} must be text of at most ${DISPLAY_NAME_MAX} characters`;
    case 'assetId':
      return typeof value === 'string' && ASSET_ID.test(value)
        ? null
        : `${name} must be an asset id like "Default"`;
    case 'gameMode':
      return SERVER_GAME_MODES.includes(value as (typeof SERVER_GAME_MODES)[number])
        ? null
        : `${name} must be ${SERVER_GAME_MODES.join(' or ')}`;
    case 'duration':
      return isDurationSeconds(value)
        ? null
        : `${name} must be a whole number of seconds from 1 to ${MAX_DURATION_SECONDS}`;
  }
}

export interface WorldPatch {
  /** File key → new value; null removes the key. */
  set: Record<string, unknown>;
  /** ClientEffects key → number. */
  clientEffects: Record<string, number>;
}

/**
 * Validates an editor request (camelCase fields, unknown ones ignored, so the
 * UI may send its whole form). An empty string clears a clearable field.
 */
export function validateWorldPatch(
  body: unknown,
): { ok: true; patch: WorldPatch } | { ok: false; error: string } {
  if (!isJsonObject(body)) return { ok: false, error: 'Body must be an object' };
  const patch: WorldPatch = { set: {}, clientEffects: {} };
  for (const [name, field] of Object.entries(WORLD_FIELDS)) {
    if (body[name] === undefined) continue;
    const value = body[name] === '' && field.clearable ? null : body[name];
    const error = checkValue(name, field, value);
    if (error) return { ok: false, error };
    patch.set[field.key] = value;
  }
  if (body.clientEffects !== undefined && body.clientEffects !== null) {
    if (!isJsonObject(body.clientEffects)) {
      return { ok: false, error: 'clientEffects must be an object' };
    }
    for (const [name, key] of Object.entries(CLIENT_EFFECT_KEYS)) {
      const value = body.clientEffects[name];
      if (value === undefined || value === null || value === '') continue;
      if (
        typeof value !== 'number' ||
        !Number.isFinite(value) ||
        Math.abs(value) > CLIENT_EFFECT_LIMIT
      ) {
        return { ok: false, error: `clientEffects.${name} must be a number` };
      }
      patch.clientEffects[key] = value;
    }
  }
  return { ok: true, patch };
}

/**
 * File keys (dotted for client effects) whose value the patch changes. A
 * missing key counts as the server's fallback, so a form that sends every
 * field does not "change" what the server already uses.
 */
export function changedWorldKeys(config: Record<string, unknown>, patch: WorldPatch): string[] {
  const changed: string[] = [];
  for (const [key, value] of Object.entries(patch.set)) {
    const fallback = Object.values(WORLD_FIELDS).find((f) => f.key === key)?.fallback ?? null;
    const current = config[key] ?? (fallback === null ? undefined : fallback);
    if (value === null ? config[key] !== undefined : current !== value) changed.push(key);
  }
  const effects = isJsonObject(config.ClientEffects) ? config.ClientEffects : {};
  for (const [key, value] of Object.entries(patch.clientEffects)) {
    if (effects[key] !== value) changed.push(`ClientEffects.${key}`);
  }
  return changed;
}

/** The part of a patch that sets the given file keys (from changedWorldKeys). */
export function pickWorldPatch(patch: WorldPatch, keys: readonly string[]): WorldPatch {
  const wanted = new Set(keys);
  return {
    set: Object.fromEntries(Object.entries(patch.set).filter(([k]) => wanted.has(k))),
    clientEffects: Object.fromEntries(
      Object.entries(patch.clientEffects).filter(([k]) => wanted.has(`ClientEffects.${k}`)),
    ),
  };
}

/** The editor field (camelCase) a changed file key belongs to. */
export function worldFieldName(key: string): string {
  if (key.startsWith('ClientEffects.')) return 'clientEffects';
  return Object.entries(WORLD_FIELDS).find(([, f]) => f.key === key)?.[0] ?? key;
}

/** Which changed keys only take effect with the server stopped. */
export function worldKeyApply(key: string): WorldFieldApply {
  const field = Object.values(WORLD_FIELDS).find((f) => f.key === key);
  return field?.apply ?? 'restart';
}

/** A new config object with the patch applied; every other key is kept. */
export function applyWorldPatch(
  config: Record<string, unknown>,
  patch: WorldPatch,
): Record<string, unknown> {
  const next: Record<string, unknown> = { ...config };
  for (const [key, value] of Object.entries(patch.set)) {
    if (value === null) delete next[key];
    else next[key] = value;
  }
  if (Object.keys(patch.clientEffects).length > 0) {
    const effects = isJsonObject(config.ClientEffects) ? config.ClientEffects : {};
    next.ClientEffects = { ...effects, ...patch.clientEffects };
  }
  return next;
}

/** apply/restart per editor field, for the UI. */
export function worldFieldModes(): Record<string, WorldFieldApply> {
  const modes: Record<string, WorldFieldApply> = Object.fromEntries(
    Object.entries(WORLD_FIELDS).map(([name, f]) => [name, f.apply]),
  );
  modes.clientEffects = 'restart';
  return modes;
}
