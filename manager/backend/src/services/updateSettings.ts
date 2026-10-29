/**
 * Native update settings in the server's config.json.
 *
 * Hytale 0.7 reads them from the `Update` block with PascalCase keys. Earlier
 * panel versions wrote a camelCase `updateConfig` block the server never
 * read, so every setting (including the setup wizard's "Auto-updates" switch)
 * was silently ignored. The API keeps the camelCase shape the frontend uses and
 * this module maps it onto the server's real field names.
 *
 * The patchline is owned by the panel's patchline setting (panel-config.json,
 * used by the downloader). The `Update.Patchline` key is never written here:
 * without it the server checks the patchline of its own JAR, which is the
 * patchline the panel installed. A second, diverging patchline would make the
 * native updater and the downloader replace each other's builds.
 */
import path from 'path';
import { updateJsonFile } from '../utils/jsonStore.js';

export type AutoApplyMode = 'DISABLED' | 'WHEN_EMPTY' | 'SCHEDULED';

export interface UpdateSettings {
  enabled: boolean;
  checkIntervalSeconds: number;
  notifyPlayersOnAvailable: boolean;
  patchline: string;
  runBackupBeforeUpdate: boolean;
  backupConfigBeforeUpdate: boolean;
  autoApplyMode: AutoApplyMode;
  autoApplyDelayMinutes: number;
}

type WritableKey = Exclude<keyof UpdateSettings, 'patchline'>;

/** camelCase API field -> key in the server's `Update` block. */
const SERVER_KEYS: Record<keyof UpdateSettings, string> = {
  enabled: 'Enabled',
  checkIntervalSeconds: 'CheckIntervalSeconds',
  notifyPlayersOnAvailable: 'NotifyPlayersOnAvailable',
  patchline: 'Patchline',
  runBackupBeforeUpdate: 'RunBackupBeforeUpdate',
  backupConfigBeforeUpdate: 'BackupConfigBeforeUpdate',
  autoApplyMode: 'AutoApplyMode',
  autoApplyDelayMinutes: 'AutoApplyDelayMinutes',
};

export const UPDATE_BLOCK_KEY = 'Update';
export const LEGACY_UPDATE_BLOCK_KEY = 'updateConfig';
export const AUTO_APPLY_MODES: readonly AutoApplyMode[] = ['DISABLED', 'WHEN_EMPTY', 'SCHEDULED'];

/**
 * How Hytale 0.7 spells the modes in config.json. Its enum codec only accepts
 * these exact names; "WHEN_EMPTY" makes the server fail to read its config
 * and refuse to start.
 */
const SERVER_AUTO_APPLY_MODES: Record<AutoApplyMode, string> = {
  DISABLED: 'Disabled',
  WHEN_EMPTY: 'WhenEmpty',
  SCHEDULED: 'Scheduled',
};

/** API mode for a config value, also accepting the upper-case API spelling. */
function autoApplyModeFromServer(value: unknown): AutoApplyMode | null {
  if (typeof value !== 'string') return null;
  const normalized = value.replace(/_/g, '').toLowerCase();
  return AUTO_APPLY_MODES.find((m) => m.replace(/_/g, '').toLowerCase() === normalized) ?? null;
}

/** What the server uses when a key is absent (Hytale 0.7 defaults). */
export const SERVER_UPDATE_DEFAULTS: Omit<UpdateSettings, 'patchline'> = {
  enabled: true,
  checkIntervalSeconds: 3600,
  notifyPlayersOnAvailable: true,
  runBackupBeforeUpdate: true,
  backupConfigBeforeUpdate: true,
  autoApplyMode: 'DISABLED',
  autoApplyDelayMinutes: 30,
};

const MIN_CHECK_INTERVAL_SECONDS = 60;
const MAX_CHECK_INTERVAL_SECONDS = 7 * 24 * 3600;
const MAX_AUTO_APPLY_DELAY_MINUTES = 24 * 60;

type JsonObject = Record<string, unknown>;

function isObject(v: unknown): v is JsonObject {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Effective settings: the `Update` block, server defaults for missing keys. */
export function readUpdateSettings(serverConfig: unknown, panelPatchline: string): UpdateSettings {
  const block =
    isObject(serverConfig) && isObject(serverConfig[UPDATE_BLOCK_KEY])
      ? (serverConfig[UPDATE_BLOCK_KEY] as JsonObject)
      : {};
  const bool = (k: keyof UpdateSettings, d: boolean) =>
    typeof block[SERVER_KEYS[k]] === 'boolean' ? (block[SERVER_KEYS[k]] as boolean) : d;
  const int = (k: keyof UpdateSettings, d: number) =>
    Number.isInteger(block[SERVER_KEYS[k]]) ? (block[SERVER_KEYS[k]] as number) : d;
  const mode = block[SERVER_KEYS.autoApplyMode];
  const patchline = block[SERVER_KEYS.patchline];
  return {
    enabled: bool('enabled', SERVER_UPDATE_DEFAULTS.enabled),
    checkIntervalSeconds: int('checkIntervalSeconds', SERVER_UPDATE_DEFAULTS.checkIntervalSeconds),
    notifyPlayersOnAvailable: bool(
      'notifyPlayersOnAvailable',
      SERVER_UPDATE_DEFAULTS.notifyPlayersOnAvailable,
    ),
    patchline: typeof patchline === 'string' && patchline ? patchline : panelPatchline,
    runBackupBeforeUpdate: bool(
      'runBackupBeforeUpdate',
      SERVER_UPDATE_DEFAULTS.runBackupBeforeUpdate,
    ),
    backupConfigBeforeUpdate: bool(
      'backupConfigBeforeUpdate',
      SERVER_UPDATE_DEFAULTS.backupConfigBeforeUpdate,
    ),
    autoApplyMode: autoApplyModeFromServer(mode) ?? SERVER_UPDATE_DEFAULTS.autoApplyMode,
    autoApplyDelayMinutes: int(
      'autoApplyDelayMinutes',
      SERVER_UPDATE_DEFAULTS.autoApplyDelayMinutes,
    ),
  };
}

export type UpdateSettingsPatch = Partial<Pick<UpdateSettings, WritableKey>>;

/**
 * Validates a request body. `patchline` may be echoed back unchanged (the UI
 * sends the whole object) but cannot be changed here.
 */
export function validateUpdateSettingsPatch(
  body: unknown,
  current: UpdateSettings,
): { ok: true; patch: UpdateSettingsPatch } | { ok: false; error: string } {
  if (!isObject(body)) return { ok: false, error: 'Body must be an object' };
  const patch: UpdateSettingsPatch = {};
  for (const key of [
    'enabled',
    'notifyPlayersOnAvailable',
    'runBackupBeforeUpdate',
    'backupConfigBeforeUpdate',
  ] as const) {
    if (body[key] === undefined) continue;
    if (typeof body[key] !== 'boolean')
      return { ok: false, error: `Field "${key}" must be boolean` };
    patch[key] = body[key] as boolean;
  }
  const interval = body.checkIntervalSeconds;
  if (interval !== undefined) {
    if (
      !Number.isInteger(interval) ||
      (interval as number) < MIN_CHECK_INTERVAL_SECONDS ||
      (interval as number) > MAX_CHECK_INTERVAL_SECONDS
    ) {
      return {
        ok: false,
        error: `Field "checkIntervalSeconds" must be an integer between ${MIN_CHECK_INTERVAL_SECONDS} and ${MAX_CHECK_INTERVAL_SECONDS}`,
      };
    }
    patch.checkIntervalSeconds = interval as number;
  }
  const delay = body.autoApplyDelayMinutes;
  if (delay !== undefined) {
    if (
      !Number.isInteger(delay) ||
      (delay as number) < 1 ||
      (delay as number) > MAX_AUTO_APPLY_DELAY_MINUTES
    ) {
      return {
        ok: false,
        error: `Field "autoApplyDelayMinutes" must be an integer between 1 and ${MAX_AUTO_APPLY_DELAY_MINUTES}`,
      };
    }
    patch.autoApplyDelayMinutes = delay as number;
  }
  if (body.autoApplyMode !== undefined) {
    if (!AUTO_APPLY_MODES.includes(body.autoApplyMode as AutoApplyMode)) {
      return {
        ok: false,
        error: 'Field "autoApplyMode" must be DISABLED, WHEN_EMPTY, or SCHEDULED',
      };
    }
    patch.autoApplyMode = body.autoApplyMode as AutoApplyMode;
  }
  if (body.patchline !== undefined && body.patchline !== current.patchline) {
    return {
      ok: false,
      error: 'The patchline is changed in the server settings (patchline switch), not here',
    };
  }
  return { ok: true, patch };
}

/** A recognised AutoApplyMode that is not spelled the way the server reads it. */
function hasMisspelledMode(block: JsonObject): boolean {
  const raw = block[SERVER_KEYS.autoApplyMode];
  const mode = autoApplyModeFromServer(raw);
  return mode !== null && raw !== SERVER_AUTO_APPLY_MODES[mode];
}

/**
 * Returns a new config object with the patch written into the `Update` block.
 * A mode spelled the API way ("WHEN_EMPTY") is rewritten to the server's
 * spelling on the way, since it would keep the server from starting.
 */
export function applyUpdateSettings(serverConfig: unknown, patch: UpdateSettingsPatch): JsonObject {
  const base = isObject(serverConfig) ? serverConfig : {};
  const block = isObject(base[UPDATE_BLOCK_KEY]) ? (base[UPDATE_BLOCK_KEY] as JsonObject) : {};
  const nextBlock: JsonObject = { ...block };
  if (hasMisspelledMode(block)) {
    const mode = autoApplyModeFromServer(block[SERVER_KEYS.autoApplyMode]) as AutoApplyMode;
    nextBlock[SERVER_KEYS.autoApplyMode] = SERVER_AUTO_APPLY_MODES[mode];
  }
  for (const [key, value] of Object.entries(patch) as [WritableKey, unknown][]) {
    if (value === undefined) continue;
    nextBlock[SERVER_KEYS[key]] =
      key === 'autoApplyMode' ? SERVER_AUTO_APPLY_MODES[value as AutoApplyMode] : value;
  }
  const next: JsonObject = { ...base, [UPDATE_BLOCK_KEY]: nextBlock };
  delete next[LEGACY_UPDATE_BLOCK_KEY];
  return next;
}

/**
 * Moves an old camelCase `updateConfig` block into `Update` (keys already set
 * in `Update` win; the legacy patchline is dropped, see the module comment) and
 * repairs a misspelled AutoApplyMode. Returns null when there is nothing to do.
 */
export function migrateLegacyUpdateBlock(serverConfig: unknown): JsonObject | null {
  if (!isObject(serverConfig)) return null;
  const current = isObject(serverConfig[UPDATE_BLOCK_KEY])
    ? (serverConfig[UPDATE_BLOCK_KEY] as JsonObject)
    : {};
  if (!(LEGACY_UPDATE_BLOCK_KEY in serverConfig) && !hasMisspelledMode(current)) return null;
  const legacy = serverConfig[LEGACY_UPDATE_BLOCK_KEY];
  const patch: UpdateSettingsPatch = {};
  if (isObject(legacy)) {
    for (const [key, value] of Object.entries(validLegacyFields(legacy)) as [
      WritableKey,
      unknown,
    ][]) {
      if (current[SERVER_KEYS[key]] === undefined) (patch as JsonObject)[key] = value;
    }
  }
  return applyUpdateSettings(serverConfig, patch);
}

/** Invalid legacy values are skipped field by field, never the whole block. */
function validLegacyFields(legacy: JsonObject): UpdateSettingsPatch {
  const out: UpdateSettingsPatch = {};
  const probe = { ...SERVER_UPDATE_DEFAULTS, patchline: '' };
  for (const key of Object.keys(SERVER_KEYS) as (keyof UpdateSettings)[]) {
    if (key === 'patchline' || legacy[key] === undefined) continue;
    const r = validateUpdateSettingsPatch({ [key]: legacy[key] }, probe);
    if (r.ok) Object.assign(out, r.patch);
  }
  return out;
}

/**
 * Read-modify-write of config.json; keeps every other key of the file. A
 * legacy block still in the file is moved first, so its settings are not lost
 * where the patch does not set them. The server folder is the server's: a
 * config.json that is a link (to a panel file, say) is refused instead of
 * being read and written back there.
 */
export async function writeUpdateSettings(
  configPath: string,
  patch: UpdateSettingsPatch,
): Promise<JsonObject> {
  const written = await updateJsonFile<JsonObject>(
    configPath,
    (current) => applyUpdateSettings(migrateLegacyUpdateBlock(current) ?? current ?? {}, patch),
    { confineTo: [path.dirname(configPath)] },
  );
  return written ?? {};
}
