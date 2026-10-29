/**
 * The quick settings of the configuration page, mapped onto the Hytale 0.7
 * config.json.
 *
 * The running server keeps its config in memory and writes all of it back
 * whenever something changes (every minute and when it stops), so a file
 * edit made while it runs is lost or never read. Each field therefore says
 * how it takes effect on a running server:
 *  - live:    the server has a command that changes the value in memory
 *             (`/maxplayers`, `/maxviewradius`); it saves the new value
 *             itself. The panel runs the command through the KyuubiSoft API
 *             plugin and checks the server's answer.
 *  - restart: only read at start; the file is written while the server is
 *             stopped (save and restart).
 * With the server stopped every field is simply written to the file.
 */
import { runCommandViaPlugin, type PluginCommandAttempt } from './pluginCommands.js';
import {
  MAX_VIEW_RADIUS,
  MIN_VIEW_RADIUS,
  normalizeGameMode,
  SERVER_GAME_MODES,
} from '../schemas/hytaleConfig.js';
import { isJsonObject } from '../utils/losslessJson.js';

export type ApplyMode = 'live' | 'restart';

export interface QuickSettings {
  serverName: string;
  motd: string;
  password: string;
  maxPlayers: number;
  maxViewRadius: number;
  defaultGameMode: string;
}
export type QuickSettingName = keyof QuickSettings;

export const SERVER_NAME_MAX = 64;
export const MOTD_MAX = 256;
export const PASSWORD_MAX = 128;
/** 0 = no limit (the server treats every value below 1 that way). */
export const MAX_PLAYERS_LIMIT = 10_000;
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

interface LiveCommand {
  command(value: number): string;
  /** Message ids of the server's answer when the value was applied. */
  appliedIds: readonly string[];
  /** Command that reports the value the server uses, and its answer ids. */
  query: string;
  queryIds: readonly string[];
  unlimitedIds?: readonly string[];
}

interface QuickField {
  path: readonly string[];
  apply: ApplyMode;
  /** What the server uses when the key is missing. */
  fallback: string | number;
  check(value: unknown): string | null;
  live?: LiveCommand;
}

function text(label: string, min: number, max: number) {
  return (value: unknown): string | null =>
    typeof value === 'string' &&
    value.trim().length >= min &&
    value.length <= max &&
    !CONTROL_CHARS.test(value)
      ? null
      : `${label} must be ${min > 0 ? `${min} to ` : 'at most '}${max} characters without line breaks`;
}

function integer(label: string, min: number, max: number) {
  return (value: unknown): string | null =>
    Number.isInteger(value) && (value as number) >= min && (value as number) <= max
      ? null
      : `${label} must be a whole number from ${min} to ${max}`;
}

export const QUICK_FIELDS: Readonly<Record<QuickSettingName, QuickField>> = {
  serverName: {
    path: ['ServerName'],
    apply: 'restart',
    fallback: 'Hytale Server',
    check: text('Server name', 1, SERVER_NAME_MAX),
  },
  motd: { path: ['MOTD'], apply: 'restart', fallback: '', check: text('MOTD', 0, MOTD_MAX) },
  password: {
    path: ['Password'],
    apply: 'restart',
    fallback: '',
    check: text('Password', 0, PASSWORD_MAX),
  },
  maxPlayers: {
    path: ['MaxPlayers'],
    apply: 'live',
    fallback: 100,
    check: integer('Max players', 0, MAX_PLAYERS_LIMIT),
    live: {
      // `amount` is an optional argument: a bare number is refused.
      command: (v) => `/maxplayers --amount ${v}`,
      appliedIds: ['server.commands.maxplayers.set', 'server.commands.maxplayers.setInfinite'],
      query: '/maxplayers',
      queryIds: ['server.commands.maxplayers.get'],
      unlimitedIds: ['server.commands.maxplayers.getInfinite'],
    },
  },
  maxViewRadius: {
    path: ['MaxViewRadius'],
    apply: 'live',
    fallback: 32,
    check: integer('View radius', MIN_VIEW_RADIUS, MAX_VIEW_RADIUS),
    live: {
      command: (v) => `/maxviewradius ${v}`,
      appliedIds: ['server.commands.maxviewradius.set'],
      query: '/maxviewradius',
      queryIds: ['server.commands.maxviewradius.get'],
    },
  },
  defaultGameMode: {
    path: ['Defaults', 'GameMode'],
    apply: 'restart',
    fallback: 'Adventure',
    check: (v) =>
      normalizeGameMode(v) ? null : `Default game mode must be ${SERVER_GAME_MODES.join(' or ')}`,
  },
};

const FIELD_NAMES = Object.keys(QUICK_FIELDS) as QuickSettingName[];

function getPath(config: Record<string, unknown>, path: readonly string[]): unknown {
  let current: unknown = config;
  for (const key of path) {
    if (!isJsonObject(current)) return undefined;
    current = current[key];
  }
  return current;
}

function setPath(
  config: Record<string, unknown>,
  path: readonly string[],
  value: unknown,
): Record<string, unknown> {
  const [key, ...rest] = path;
  if (rest.length === 0) return { ...config, [key]: value };
  const child = isJsonObject(config[key]) ? (config[key] as Record<string, unknown>) : {};
  return { ...config, [key]: setPath(child, rest, value) };
}

/** The quick settings as the server sees them (its default for a missing key). */
export function readQuickSettings(config: Record<string, unknown>): QuickSettings {
  const read = <K extends QuickSettingName>(name: K): QuickSettings[K] => {
    const field = QUICK_FIELDS[name];
    const value = getPath(config, field.path);
    const expected = typeof field.fallback;
    return (typeof value === expected ? value : field.fallback) as QuickSettings[K];
  };
  return {
    serverName: read('serverName'),
    motd: read('motd'),
    password: read('password'),
    maxPlayers: read('maxPlayers'),
    maxViewRadius: read('maxViewRadius'),
    defaultGameMode: normalizeGameMode(read('defaultGameMode')) ?? 'Adventure',
  };
}

export function quickSettingModes(): Record<QuickSettingName, ApplyMode> {
  return Object.fromEntries(FIELD_NAMES.map((n) => [n, QUICK_FIELDS[n].apply])) as Record<
    QuickSettingName,
    ApplyMode
  >;
}

/**
 * Validates a request body. Only the quick setting fields are looked at, so
 * the UI may send its whole form; a field that is not sent stays as it is.
 */
export function validateQuickSettingsPatch(
  body: unknown,
): { ok: true; patch: Partial<QuickSettings> } | { ok: false; error: string; field: string } {
  if (!isJsonObject(body)) return { ok: false, error: 'Body must be an object', field: '' };
  const patch: Partial<QuickSettings> = {};
  for (const name of FIELD_NAMES) {
    const value = body[name];
    if (value === undefined) continue;
    const error = QUICK_FIELDS[name].check(value);
    if (error) return { ok: false, error, field: name };
    (patch as Record<string, unknown>)[name] =
      name === 'defaultGameMode'
        ? normalizeGameMode(value)
        : name === 'serverName'
          ? (value as string).trim()
          : value;
  }
  return { ok: true, patch };
}

/** Fields whose value the patch changes, in a fixed order. */
export function changedQuickSettings(
  current: QuickSettings,
  patch: Partial<QuickSettings>,
): QuickSettingName[] {
  return FIELD_NAMES.filter((n) => patch[n] !== undefined && patch[n] !== current[n]);
}

/** A new config with the given fields set; every other key is kept. */
export function applyQuickSettings(
  config: Record<string, unknown>,
  patch: Partial<QuickSettings>,
): Record<string, unknown> {
  let next = config;
  for (const name of FIELD_NAMES) {
    const value = patch[name];
    if (value !== undefined) next = setPath(next, QUICK_FIELDS[name].path, value);
  }
  return next;
}

// ---------------------------------------------------------------------------
// Live changes through the plugin
// ---------------------------------------------------------------------------

export interface LiveResult {
  field: QuickSettingName;
  ok: boolean;
  /** The server's answer (or why there is none). */
  message: string;
}

export type LiveApplyOutcome =
  | { kind: 'applied'; results: LiveResult[] }
  /** The plugin did not take the first command; nothing was changed. */
  | { kind: 'unavailable'; reason: string };

function replyText(attempt: PluginCommandAttempt): string {
  if (attempt.kind === 'reply') {
    return attempt.reply.output.join(' ').trim() || attempt.reply.error || attempt.reply.status;
  }
  return attempt.kind === 'unavailable' ? attempt.reason : attempt.error;
}

/**
 * Runs the commands of the given live fields on the running server and
 * checks each answer: a change only counts when the server replied with the
 * message it sends after changing the value. Commands run one after another;
 * a failure does not stop the rest.
 */
export async function applyLiveQuickSettings(
  fields: QuickSettingName[],
  patch: Partial<QuickSettings>,
  serverId: string | undefined,
  actor: string | undefined,
): Promise<LiveApplyOutcome> {
  const results: LiveResult[] = [];
  for (const field of fields) {
    const live = QUICK_FIELDS[field].live;
    const value = patch[field];
    if (!live || typeof value !== 'number') continue;
    const attempt = await runCommandViaPlugin(live.command(value), serverId, { actor });
    if (attempt.kind === 'unavailable' && results.length === 0) {
      return { kind: 'unavailable', reason: attempt.reason };
    }
    const applied =
      attempt.kind === 'reply' &&
      attempt.reply.ok &&
      attempt.reply.messageIds.some((id) => live.appliedIds.includes(id));
    results.push({ field, ok: applied, message: replyText(attempt) });
  }
  return { kind: 'applied', results };
}

/** The first whole number in a reply ("Max players is set to 1,000" → 1000). */
export function numberFromReply(lines: string[]): number | null {
  const match = lines.join(' ').match(/\d[\d.,   ]*/);
  if (!match) return null;
  const digits = match[0].replace(/\D/g, '');
  return digits ? Number(digits) : null;
}

/**
 * The live values the running server uses, asked with the query form of the
 * commands; null when the plugin is not reachable. A field whose answer cannot
 * be read is left out. maxPlayers 0 means no limit.
 */
export async function readLiveQuickSettings(
  serverId: string | undefined,
  actor: string | undefined,
): Promise<Partial<Pick<QuickSettings, 'maxPlayers' | 'maxViewRadius'>> | null> {
  const values: Partial<Pick<QuickSettings, 'maxPlayers' | 'maxViewRadius'>> = {};
  for (const field of ['maxPlayers', 'maxViewRadius'] as const) {
    const live = QUICK_FIELDS[field].live as LiveCommand;
    const attempt = await runCommandViaPlugin(live.query, serverId, { actor });
    if (attempt.kind === 'unavailable') return null;
    if (attempt.kind !== 'reply' || !attempt.reply.ok) continue;
    const ids = attempt.reply.messageIds;
    if (live.unlimitedIds?.some((id) => ids.includes(id))) {
      values[field] = 0;
    } else if (live.queryIds.some((id) => ids.includes(id))) {
      const n = numberFromReply(attempt.reply.output);
      if (n !== null) values[field] = n;
    }
  }
  return values;
}
