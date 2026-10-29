/**
 * The server settings of the setup wizard and how they reach the Hytale 0.7
 * config.json.
 *
 * Only real server fields are written, with the server's names and types:
 * ServerName, MOTD, Password, MaxPlayers, MaxViewRadius, Defaults.GameMode,
 * RequireJoinPermission (the wizard's "whitelist") and the Update block. The
 * OP switch is a start flag of the panel (panel-config.json), never a
 * config.json key. Keys earlier panel versions wrote instead (Whitelist,
 * AllowOp, ViewRadius) are cleaned up on the way.
 *
 * The server reads config.json only when it starts and writes its own copy
 * back, so the file is written while it is stopped: right away when it is
 * down, otherwise during the restart that ends the setup anyway (to load the
 * mods it installed), between stop and start.
 */
import path from 'path';
import { access, constants } from 'fs/promises';
import { QUICK_FIELDS } from './serverSettings.js';
import { applyUpdateSettings } from './updateSettings.js';
import { resolveInstallPaths } from './serverInstall.js';
import { runWhileServerStopped, startServer, withServerStopped } from './serverLifecycle.js';
import {
  MAX_VIEW_RADIUS,
  migrateLegacyServerConfig,
  MIN_VIEW_RADIUS,
  normalizeGameMode,
  parseHytaleConfig,
  SERVER_GAME_MODES,
  type LegacyChange,
  type ServerGameMode,
} from '../schemas/hytaleConfig.js';
import { updateServerJson } from '../utils/serverFiles.js';
import { isJsonObject } from '../utils/losslessJson.js';
import { logger } from '../utils/logger.js';

export interface WizardServerSettings {
  name: string;
  motd: string;
  maxPlayers: number;
  gameMode: ServerGameMode;
  password: string;
  /** RequireJoinPermission: only players with the join permission get in. */
  whitelist: boolean;
  /** The --allow-op start flag (panel-config.json). */
  allowOp: boolean;
}

export const WIZARD_DEFAULTS: Readonly<WizardServerSettings> = {
  name: 'Hytale Server',
  motd: 'Welcome to Hytale!',
  maxPlayers: 20,
  gameMode: 'Adventure',
  password: '',
  whitelist: false,
  // --allow-op lets ANY player run `/op self` and take full admin rights.
  allowOp: false,
};
export const WIZARD_DEFAULT_VIEW_RADIUS = 16;
// How long the setup waits for the server to save and exit before Docker stops it.
const SETUP_STOP_TIMEOUT_MS = 60_000;

type StepResult<T> = { ok: true; value: T } | { ok: false; error: string };

const pick = (data: Record<string, unknown>, ...keys: string[]) =>
  keys.map((k) => data[k]).find((v) => v !== undefined);

/**
 * The "server-config" step (name, MOTD, max players, game mode). The
 * security fields of an earlier save are kept, so going back and saving this
 * step again does not reset them.
 */
export function validateServerStep(
  data: Record<string, unknown>,
  previous?: Partial<WizardServerSettings>,
): StepResult<WizardServerSettings> {
  const name = pick(data, 'name', 'serverName') ?? WIZARD_DEFAULTS.name;
  const motd = data.motd ?? WIZARD_DEFAULTS.motd;
  const maxPlayers = data.maxPlayers ?? WIZARD_DEFAULTS.maxPlayers;
  const rawMode = pick(data, 'gameMode', 'defaultGamemode') ?? WIZARD_DEFAULTS.gameMode;
  const error =
    QUICK_FIELDS.serverName.check(name) ??
    QUICK_FIELDS.motd.check(motd) ??
    QUICK_FIELDS.maxPlayers.check(maxPlayers);
  if (error) return { ok: false, error };
  const gameMode = normalizeGameMode(rawMode);
  if (!gameMode) {
    return { ok: false, error: `Game mode must be ${SERVER_GAME_MODES.join(' or ')}` };
  }
  return {
    ok: true,
    value: {
      ...WIZARD_DEFAULTS,
      ...previous,
      name: (name as string).trim(),
      motd: motd as string,
      maxPlayers: maxPlayers as number,
      gameMode,
    },
  };
}

/** The "security-settings" step (password, whitelist, OP switch) on top of the server step. */
export function validateSecurityStep(
  data: Record<string, unknown>,
  previous?: Partial<WizardServerSettings>,
): StepResult<WizardServerSettings> {
  const base: WizardServerSettings = { ...WIZARD_DEFAULTS, ...previous };
  const password = data.password === null ? '' : (data.password ?? base.password);
  const error = QUICK_FIELDS.password.check(password);
  if (error) return { ok: false, error };
  return {
    ok: true,
    value: {
      ...base,
      password: password as string,
      whitelist: data.whitelist === undefined ? base.whitelist : data.whitelist === true,
      allowOp: data.allowOp === undefined ? base.allowOp : data.allowOp === true,
    },
  };
}

/** The view radius of the "performance" step (the server allows 1 to 32 chunks). */
export function validateViewRadius(raw: unknown): StepResult<number> {
  if (raw === undefined || raw === null) return { ok: true, value: WIZARD_DEFAULT_VIEW_RADIUS };
  // A range input hands its value over as text.
  const value = typeof raw === 'string' && /^\d{1,3}$/.test(raw) ? Number(raw) : raw;
  return Number.isInteger(value) &&
    (value as number) >= MIN_VIEW_RADIUS &&
    (value as number) <= MAX_VIEW_RADIUS
    ? { ok: true, value: value as number }
    : {
        ok: false,
        error: `View radius must be a whole number from ${MIN_VIEW_RADIUS} to ${MAX_VIEW_RADIUS}`,
      };
}

export interface WizardConfigInput {
  server: WizardServerSettings;
  viewRadius?: number;
  autoUpdate: boolean;
  /**
   * Adopting an existing installation: values the config already has win
   * over the wizard's (except an explicitly typed password).
   */
  preserveExisting: boolean;
}

/**
 * The new config.json content for the wizard's settings: a new object, every
 * key the wizard does not set is kept. Throws when the result would keep the
 * server from starting.
 */
export function buildWizardServerConfig(
  current: unknown,
  input: WizardConfigInput,
): { config: Record<string, unknown>; changes: LegacyChange[] } {
  if (current !== null && current !== undefined && !isJsonObject(current)) {
    throw new Error('config.json does not hold a JSON object; the setup leaves it alone');
  }
  const existing = isJsonObject(current) ? current : null;
  const migrated = existing ? migrateLegacyServerConfig(existing) : null;
  const base: Record<string, unknown> = migrated?.config ?? existing ?? {};
  const preserve = input.preserveExisting && existing !== null;
  const has = (key: string) => preserve && base[key] !== undefined && base[key] !== '';
  const { server } = input;

  const next: Record<string, unknown> = { ...base };
  const set = (key: string, value: unknown) => {
    if (!has(key)) next[key] = value;
  };
  set('ServerName', server.name);
  set('MOTD', server.motd);
  set('MaxPlayers', server.maxPlayers);
  set('RequireJoinPermission', server.whitelist);
  if (input.viewRadius !== undefined) set('MaxViewRadius', input.viewRadius);
  // A password typed in the wizard always counts (it may be a rotation); an
  // empty one leaves an existing installation's password alone.
  if (server.password) next.Password = server.password;
  else if (!preserve) next.Password = '';

  const defaults = isJsonObject(base.Defaults) ? base.Defaults : {};
  next.Defaults =
    preserve && normalizeGameMode(defaults.GameMode)
      ? defaults
      : // A wizard saved by an older panel may still hold Survival or Spectator.
        { ...defaults, GameMode: normalizeGameMode(server.gameMode) ?? WIZARD_DEFAULTS.gameMode };

  // The wizard's "auto-updates" switch lets the server download updates and
  // apply them while nobody is online; the patchline stays with the panel.
  const config = applyUpdateSettings(next, {
    enabled: true,
    autoApplyMode: input.autoUpdate ? 'WHEN_EMPTY' : 'DISABLED',
  });
  const check = parseHytaleConfig(config);
  if (!check.ok) {
    throw new Error(`The server would not start with this config.json: ${check.issues.join('; ')}`);
  }
  return { config, changes: migrated?.changes ?? [] };
}

export interface WizardConfigResult {
  written: boolean;
  /**
   * The server runs: the file is written during the restart that ends the
   * setup (restartWithWizardConfig), not while it could write its own copy.
   */
  pending: boolean;
  /** Why nothing was written (no error: the server folder is not there yet). */
  skipped?: string;
  error?: string;
  /** Settings of older panel versions that were cleaned up on the way. */
  changes: LegacyChange[];
}

type Write = () => Promise<LegacyChange[]>;

async function wizardWrite(input: WizardConfigInput): Promise<Write | { skipped: string }> {
  const { serverPath } = await resolveInstallPaths();
  try {
    await access(serverPath, constants.W_OK);
  } catch {
    return { skipped: 'server folder not ready' };
  }
  const file = path.join(serverPath, 'config.json');
  return async () => {
    let changes: LegacyChange[] = [];
    await updateServerJson(file, [serverPath], (current) => {
      const built = buildWizardServerConfig(current, input);
      changes = built.changes;
      return built.config;
    });
    return changes;
  };
}

function failed(error: unknown, written = false): WizardConfigResult {
  const message = error instanceof Error ? error.message : String(error);
  logger.error('[Setup] Server config.json:', message);
  return { written, pending: false, error: message, changes: [] };
}

/**
 * Writes the wizard's settings into config.json if the server is stopped;
 * a running server is left alone (pending). Never throws.
 */
export async function writeWizardServerConfig(
  input: WizardConfigInput,
): Promise<WizardConfigResult> {
  try {
    const write = await wizardWrite(input);
    if (typeof write !== 'function') return { written: false, pending: false, ...write, changes: [] };
    const done = await runWhileServerStopped(undefined, { reason: 'setup' }, write);
    return done.ran
      ? { written: true, pending: false, changes: done.value }
      : { written: false, pending: true, changes: [] };
  } catch (error) {
    return failed(error);
  }
}

/**
 * The restart that ends the setup, with the pending settings written while
 * the server is down; the server runs afterwards. Never throws.
 */
export async function restartWithWizardConfig(
  input: WizardConfigInput,
): Promise<WizardConfigResult> {
  let written = false;
  try {
    const write = await wizardWrite(input);
    if (typeof write !== 'function') return { written: false, pending: false, ...write, changes: [] };
    const changes = await withServerStopped(
      undefined,
      { reason: 'setup', actor: 'setup', timeoutMs: SETUP_STOP_TIMEOUT_MS },
      async () => {
        const result = await write();
        written = true;
        return result;
      },
    );
    // Stopped in the meantime: the setup still ends with a running server.
    const started = await startServer(undefined, { reason: 'setup', actor: 'setup' });
    if (!started.ok) return failed(new Error(`The server did not start: ${started.error}`), true);
    return { written: true, pending: false, changes };
  } catch (error) {
    // Written, but the server did not come up again: the settings are in place.
    return failed(error, written);
  }
}
