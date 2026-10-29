/**
 * Schema for the Hytale 0.7 server's config.json.
 *
 * Only what keeps the server from starting is an error: a known field with
 * the wrong type, an enum value the server does not know, a count below the
 * server's own minimum. The server reads the file with strict codecs and
 * refuses to start ("Failed to read server config!") on any of these.
 * Everything else is passed through untouched: the file carries module, mod
 * and storage settings the panel does not model, and new server versions add
 * fields. Keys the server does not know at all are ignored by it and dropped
 * the next time it saves its config.
 */
import { z } from 'zod';
import { isJsonObject } from '../utils/losslessJson.js';

/** Game modes of Hytale 0.7; `Defaults.GameMode` matches them case-insensitively. */
export const SERVER_GAME_MODES = ['Adventure', 'Creative'] as const;
export type ServerGameMode = (typeof SERVER_GAME_MODES)[number];
export const HARDCORE_MODES = ['None', 'PerPlayer', 'Global'] as const;
/** The server clamps MaxViewRadius to 1..32 (and warns) when it loads the file. */
export const MIN_VIEW_RADIUS = 1;
export const MAX_VIEW_RADIUS = 32;
/** Spelling of the update modes in config.json (see services/updateSettings.ts). */
const AUTO_APPLY_MODES = ['Disabled', 'WhenEmpty', 'Scheduled'] as const;

const INT32_MIN = -2147483648;
const INT32_MAX = 2147483647;
const int32 = () => z.number().int().min(INT32_MIN).max(INT32_MAX);
const anyObject = () => z.object({}).passthrough();

function caseInsensitive<T extends readonly string[]>(values: T) {
  return z.string().refine((v) => values.some((m) => m.toLowerCase() === v.toLowerCase()), {
    message: `must be one of ${values.join(', ')}`,
  });
}

/** The canonical spelling of a game mode, or null when the server would refuse it. */
export function normalizeGameMode(value: unknown): ServerGameMode | null {
  if (typeof value !== 'string') return null;
  return SERVER_GAME_MODES.find((m) => m.toLowerCase() === value.toLowerCase()) ?? null;
}

const DefaultsSchema = z
  .object({
    World: z.string().optional(),
    GameMode: caseInsensitive(SERVER_GAME_MODES).optional(),
    GameModeTypeOnDeath: z.string().optional(),
    HardcoreMode: caseInsensitive(HARDCORE_MODES).optional(),
    HardcoreLives: int32().min(1).optional(),
    CrashRecovery: anyObject().optional(),
  })
  .passthrough();

const UpdateSchema = z
  .object({
    Enabled: z.boolean().optional(),
    CheckIntervalSeconds: int32().optional(),
    NotifyPlayersOnAvailable: z.boolean().optional(),
    Patchline: z.string().optional(),
    RunBackupBeforeUpdate: z.boolean().optional(),
    BackupConfigBeforeUpdate: z.boolean().optional(),
    AutoApplyMode: z.enum(AUTO_APPLY_MODES).optional(),
    AutoApplyDelayMinutes: int32().optional(),
  })
  .passthrough();

const BackupSchema = z
  .object({
    Enabled: z.boolean().optional(),
    FrequencyMinutes: int32().min(1).optional(),
    Directory: z.string().min(1).optional(),
    MaxCount: int32().min(1).optional(),
    ArchiveMaxCount: int32().min(1).optional(),
  })
  .passthrough();

export const HytaleConfigSchema = z
  .object({
    Version: int32().optional(),
    ServerName: z.string().optional(),
    MOTD: z.string().optional(),
    Password: z.string().optional(),
    MaxPlayers: int32().optional(),
    MaxViewRadius: int32().optional(),
    Defaults: DefaultsSchema.optional(),
    ConnectionTimeouts: anyObject().optional(),
    RateLimit: anyObject().optional(),
    Modules: anyObject().optional(),
    LogLevels: anyObject().optional(),
    Mods: anyObject().optional(),
    ModLoadOrder: z.array(z.string()).optional(),
    DefaultModsEnabled: z.boolean().optional(),
    RequireJoinPermission: z.boolean().optional(),
    DisplayTmpTagsInStrings: z.boolean().optional(),
    PlayerStorage: anyObject().optional(),
    UniverseResourceStorage: anyObject().optional(),
    BanStorage: anyObject().optional(),
    AuthCredentialStore: anyObject().optional(),
    Update: UpdateSchema.optional(),
    Backup: BackupSchema.optional(),
    WorldMap: anyObject().optional(),
    // Error reporting target: missing = the game's default, "" = off.
    SentryDsn: z.string().optional(),
    FallbackServer: z
      .object({
        Host: z.string(),
        // Read as a signed 16-bit value.
        Port: z.number().int().min(-32768).max(32767),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

export type HytaleConfig = z.infer<typeof HytaleConfigSchema>;

/**
 * Keys earlier panel versions wrote that Hytale never read. `updateConfig`
 * is handled with the update settings (services/updateSettings.ts).
 */
export const LEGACY_SERVER_KEYS = ['Whitelist', 'AllowOp', 'ViewRadius'] as const;

export interface HytaleConfigParseResult {
  ok: boolean;
  config: HytaleConfig | Record<string, unknown>;
  /** Problems that keep the server from starting. */
  issues: string[];
  /** Accepted, but the server changes or ignores the value. */
  warnings: string[];
}

function formatIssues(error: z.ZodError): string[] {
  return error.issues.map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`);
}

function configWarnings(raw: Record<string, unknown>): string[] {
  const warnings: string[] = [];
  const radius = raw.MaxViewRadius;
  if (
    Number.isInteger(radius) &&
    ((radius as number) < MIN_VIEW_RADIUS || (radius as number) > MAX_VIEW_RADIUS)
  ) {
    warnings.push(
      `MaxViewRadius: the server uses ${Math.min(Math.max(radius as number, MIN_VIEW_RADIUS), MAX_VIEW_RADIUS)} (allowed ${MIN_VIEW_RADIUS}-${MAX_VIEW_RADIUS})`,
    );
  }
  for (const key of LEGACY_SERVER_KEYS) {
    if (key in raw) warnings.push(`${key}: not a server setting; the server ignores it`);
  }
  return warnings;
}

export function parseHytaleConfig(raw: unknown): HytaleConfigParseResult {
  if (!isJsonObject(raw)) {
    return { ok: false, config: {}, issues: ['<root>: must be a JSON object'], warnings: [] };
  }
  const result = HytaleConfigSchema.safeParse(raw);
  const warnings = configWarnings(raw);
  if (result.success) return { ok: true, config: result.data, issues: [], warnings };
  return { ok: false, config: raw, issues: formatIssues(result.error), warnings };
}

export interface LegacyChange {
  /** Dotted path of the key in the file. */
  key: string;
  action: 'removed' | 'renamed' | 'repaired';
  /** The value found (never the password). */
  value: unknown;
  /** Target key for a rename, new value for a repair. */
  to?: string;
  /** Why, for the log and the panel notice. */
  note: string;
}

/**
 * Cleans up what earlier panel versions wrote into config.json:
 *  - `Whitelist` and `AllowOp` were never server settings and are removed. A
 *    `Whitelist: true` is NOT turned into `RequireJoinPermission`: the server
 *    never enforced it, and switching it on now would lock out every player
 *    without the join permission.
 *  - `ViewRadius` becomes `MaxViewRadius` when that is not set yet.
 *  - a `Defaults.GameMode` the server cannot read (the wizard offered
 *    Survival and Spectator) keeps it from starting; it becomes Adventure.
 * Pure and idempotent: null when there is nothing to do.
 */
export function migrateLegacyServerConfig(
  raw: unknown,
): { config: Record<string, unknown>; changes: LegacyChange[] } | null {
  if (!isJsonObject(raw)) return null;
  const next: Record<string, unknown> = { ...raw };
  const changes: LegacyChange[] = [];

  if ('Whitelist' in next) {
    const value = next.Whitelist;
    delete next.Whitelist;
    changes.push({
      key: 'Whitelist',
      action: 'removed',
      value,
      note:
        value === true
          ? 'The setup wizard stored "whitelist on" under a key Hytale never read: the whitelist was never active. Turn it on in the whitelist page if you want it.'
          : 'Not a Hytale setting.',
    });
  }
  if ('AllowOp' in next) {
    changes.push({
      key: 'AllowOp',
      action: 'removed',
      value: next.AllowOp,
      note: 'Not a Hytale setting; the OP switch is a start option of the panel.',
    });
    delete next.AllowOp;
  }
  if ('ViewRadius' in next) {
    const value = next.ViewRadius;
    delete next.ViewRadius;
    const usable =
      Number.isInteger(value) &&
      (value as number) >= MIN_VIEW_RADIUS &&
      (value as number) <= MAX_VIEW_RADIUS;
    if (usable && next.MaxViewRadius === undefined) {
      next.MaxViewRadius = value;
      changes.push({
        key: 'ViewRadius',
        action: 'renamed',
        value,
        to: 'MaxViewRadius',
        note: 'Hytale reads the view radius from MaxViewRadius.',
      });
    } else {
      changes.push({
        key: 'ViewRadius',
        action: 'removed',
        value,
        note: usable
          ? 'Hytale reads MaxViewRadius, which is already set.'
          : 'Not a usable view radius.',
      });
    }
  }
  if (isJsonObject(next.Defaults) && next.Defaults.GameMode !== undefined) {
    const mode = next.Defaults.GameMode;
    if (normalizeGameMode(mode) === null) {
      next.Defaults = { ...next.Defaults, GameMode: 'Adventure' };
      changes.push({
        key: 'Defaults.GameMode',
        action: 'repaired',
        value: mode,
        to: 'Adventure',
        note: 'Hytale only knows Adventure and Creative; the server could not start with this value.',
      });
    }
  }
  return changes.length > 0 ? { config: next, changes } : null;
}
