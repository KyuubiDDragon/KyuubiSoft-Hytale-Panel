// The server's own settings: the quick settings of the configuration page
// (config.json, Hytale 0.7 field names) and the file editor for the config
// files in the server folder. See services/serverSettings.ts for which
// settings apply live and services/serverConfigWrite.ts for when a file the
// server owns may be written.
import { Router, Response, type NextFunction } from 'express';
import { readdir, stat } from 'fs/promises';
import path from 'path';
import { authMiddleware } from '../../middleware/auth.js';
import { requirePermission } from '../../middleware/permissions.js';
import { audit } from '../../services/audit.js';
import {
  isDemoMode,
  getDemoQuickSettings,
  getDemoConfigFiles,
  getDemoServerConfig,
} from '../../services/demoData.js';
import { isPluginInstalled } from '../../services/kyuubiApi.js';
import { resolveInstallPaths } from '../../services/serverInstall.js';
import {
  applyLiveQuickSettings,
  applyQuickSettings,
  changedQuickSettings,
  MAX_PLAYERS_LIMIT,
  MOTD_MAX,
  PASSWORD_MAX,
  quickSettingModes,
  QUICK_FIELDS,
  readLiveQuickSettings,
  readQuickSettings,
  SERVER_NAME_MAX,
  validateQuickSettingsPatch,
  type QuickSettingName,
  type QuickSettings,
} from '../../services/serverSettings.js';
import {
  countdownFrom,
  isServerRunning,
  requireRestartPermissionIfAsked,
  sendRefusedWrite,
  sendWriteError,
  writeWhileStopped,
} from '../../services/serverConfigWrite.js';
import { dismissMigrationNotes, readMigrationNotes } from '../../services/serverConfigMigration.js';
import { accessFileRule, configAccessRights } from '../../services/accessFileGuard.js';
import {
  LEGACY_SERVER_KEYS,
  MAX_VIEW_RADIUS,
  MIN_VIEW_RADIUS,
  parseHytaleConfig,
  SERVER_GAME_MODES,
} from '../../schemas/hytaleConfig.js';
import {
  readServerFile,
  readServerJson,
  ServerJsonParseError,
  updateServerJson,
  writeServerFile,
} from '../../utils/serverFiles.js';
import { isJsonObject, parseLosslessJson } from '../../utils/losslessJson.js';
import { UnsafeFileError } from '../../utils/noFollowFs.js';
import { CONFIG_EXTENSIONS } from './shared.js';
import type { AuthenticatedRequest } from '../../types/index.js';
import type { Permission } from '../../types/permissions.js';

const router = Router();

const SERVER_CONFIG = 'config.json';
// The editor is for config files, not for data dumps.
const MAX_CONFIG_FILE_BYTES = 5 * 1024 * 1024;

const LIMITS = {
  serverName: SERVER_NAME_MAX,
  motd: MOTD_MAX,
  password: PASSWORD_MAX,
  maxPlayers: MAX_PLAYERS_LIMIT,
  minViewRadius: MIN_VIEW_RADIUS,
  maxViewRadius: MAX_VIEW_RADIUS,
  gameModes: SERVER_GAME_MODES,
};

class ConfigMissingError extends Error {
  constructor() {
    super(
      'config.json does not exist yet. The server creates it when it starts for the first time.',
    );
    this.name = 'ConfigMissingError';
  }
}

async function serverConfigFile(serverId?: string): Promise<{ file: string; serverPath: string }> {
  const { serverPath } = await resolveInstallPaths(serverId);
  return { file: path.join(serverPath, SERVER_CONFIG), serverPath };
}

function sendReadError(res: Response, error: unknown, what: string): void {
  if (error instanceof ConfigMissingError) {
    res.status(404).json({ success: false, reason: 'config_missing', error: error.message });
    return;
  }
  if (error instanceof UnsafeFileError) {
    res.status(409).json({ success: false, reason: 'unsafe_file', error: error.message });
    return;
  }
  if (error instanceof ServerJsonParseError) {
    res.status(409).json({ success: false, reason: 'invalid_json', error: error.message });
    return;
  }
  res.status(500).json({
    success: false,
    error: `Failed to load ${what}`,
    message: error instanceof Error ? error.message : 'Unknown error',
  });
}

async function loadServerConfig(serverId?: string): Promise<Record<string, unknown>> {
  const { file, serverPath } = await serverConfigFile(serverId);
  const raw = await readServerJson(file, [serverPath]);
  if (raw === null) throw new ConfigMissingError();
  if (!isJsonObject(raw)) throw new Error('config.json is not a JSON object');
  return raw;
}

// GET /api/server/quick-settings - quick settings from config.json, with how
// each one takes effect on a running server. `?live=1` also asks the running
// server for the live values (through the KyuubiSoft API plugin).
router.get(
  '/quick-settings',
  authMiddleware,
  requirePermission('config.view'),
  async (req: AuthenticatedRequest, res: Response) => {
    if (isDemoMode()) {
      res.json({
        ...getDemoQuickSettings(),
        fields: quickSettingModes(),
        limits: LIMITS,
        serverRunning: false,
        liveAvailable: false,
        liveValues: null,
        legacyKeys: [],
        notes: [],
      });
      return;
    }
    try {
      const raw = await loadServerConfig(req.serverId);
      const running = await isServerRunning(req.serverId);
      const liveValues =
        running && req.query.live === '1'
          ? await readLiveQuickSettings(req.serverId, req.user)
          : null;
      const liveAvailable =
        running && (liveValues !== null || (await isPluginInstalled(req.serverId)));
      res.json({
        ...readQuickSettings(raw),
        fields: quickSettingModes(),
        limits: LIMITS,
        serverRunning: running,
        liveAvailable,
        liveValues,
        // Keys from older panel versions the server ignores; cleaned up at the next start.
        legacyKeys: LEGACY_SERVER_KEYS.filter((k) => k in raw),
        notes: await readMigrationNotes(),
      });
    } catch (error) {
      sendReadError(res, error, 'quick settings');
    }
  },
);

// PUT /api/server/quick-settings - save quick settings.
//  - server stopped: written to config.json;
//  - server running, only live settings changed: applied with the server's
//    command and checked (needs the plugin);
//  - server running, a restart setting changed: 409 requiresRestart unless
//    `restart: true` (stop, save, start; optional countdownSeconds).
router.put(
  '/quick-settings',
  authMiddleware,
  requirePermission('config.edit'),
  requireRestartPermissionIfAsked,
  async (req: AuthenticatedRequest, res: Response) => {
    if (isDemoMode()) {
      res.json({ success: true, message: '[DEMO] Quick settings saved (simulated)' });
      return;
    }
    const validation = validateQuickSettingsPatch(req.body);
    if (!validation.ok) {
      res.status(400).json({ success: false, error: validation.error, field: validation.field });
      return;
    }
    try {
      const running = await isServerRunning(req.serverId);
      // A running server saves a live change about a minute later; until then
      // compare with what it uses, not with the file.
      const liveValues = running ? await readLiveQuickSettings(req.serverId, req.user) : null;
      const current = { ...readQuickSettings(await loadServerConfig(req.serverId)), ...liveValues };
      const changed = changedQuickSettings(current, validation.patch);
      if (changed.length === 0) {
        res.json({ success: true, changed: false, message: 'Settings unchanged.' });
        return;
      }
      const patch: Partial<QuickSettings> = Object.fromEntries(
        changed.map((name) => [name, validation.patch[name]]),
      );
      const restartFields = changed.filter((n) => QUICK_FIELDS[n].apply === 'restart');
      const liveFields = changed.filter((n) => QUICK_FIELDS[n].apply === 'live');
      const restart = req.body?.restart === true;
      const auditMeta = { fields: changed };

      if (running && !restart) {
        if (restartFields.length > 0) {
          sendRefusedWrite(res, { kind: 'requires_restart' }, { restartFields, liveFields });
          return;
        }
        const live = await applyLiveQuickSettings(liveFields, patch, req.serverId, req.user);
        if (live.kind === 'unavailable') {
          res.status(409).json({
            success: false,
            requiresRestart: true,
            reason: 'live_unavailable',
            restartFields,
            liveFields,
            error: `The change cannot be applied while the server runs: the KyuubiSoft API plugin is not reachable (${live.reason}). Save with a restart instead.`,
          });
          return;
        }
        const failed = live.results.filter((r) => !r.ok);
        audit(req, 'server.config.live', {
          metadata: { ...auditMeta, failed: failed.map((r) => r.field) },
          success: failed.length === 0,
        });
        if (failed.length > 0) {
          res.status(502).json({
            success: false,
            reason: 'not_confirmed',
            results: live.results,
            error: `The server did not confirm: ${failed.map((r) => `${r.field} (${r.message})`).join(', ')}`,
          });
          return;
        }
        res.json({
          success: true,
          changed: true,
          applied: 'live',
          results: live.results,
          message: 'Applied on the running server; it saves the new values itself.',
        });
        return;
      }

      // With a restart the file is written after the server saved its own
      // state, which the live values may not have shown: write every live
      // field that was sent as well.
      const sentLive = Object.fromEntries(
        Object.entries(validation.patch).filter(
          ([name]) => QUICK_FIELDS[name as QuickSettingName].apply === 'live',
        ),
      );
      const filePatch: Partial<QuickSettings> =
        running && restart ? { ...sentLive, ...patch } : patch;
      const { file, serverPath } = await serverConfigFile(req.serverId);
      const outcome = await writeWhileStopped(
        req.serverId,
        { restart, actor: req.user, countdownSeconds: countdownFrom(req.body) },
        () =>
          updateServerJson(file, [serverPath], (cfg) => {
            if (!isJsonObject(cfg)) throw new ConfigMissingError();
            return applyQuickSettings(cfg, filePatch);
          }),
      );
      if (sendRefusedWrite(res, outcome, { restartFields, liveFields })) return;
      const restarted = outcome.kind === 'written' && outcome.restarted;
      audit(req, 'server.config.saved', { metadata: { ...auditMeta, restarted } });
      res.json({
        success: true,
        changed: true,
        applied: restarted ? 'restart' : 'file',
        restarted,
        message: restarted
          ? 'Settings saved, server restarted.'
          : 'Settings saved. They take effect when the server starts.',
      });
    } catch (error) {
      if (error instanceof ConfigMissingError) {
        sendReadError(res, error, 'quick settings');
        return;
      }
      sendWriteError(res, error, 'quick settings');
    }
  },
);

// DELETE /api/server/quick-settings/notes - dismiss the notices about settings
// from older panel versions that were cleaned up.
router.delete(
  '/quick-settings/notes',
  authMiddleware,
  requirePermission('config.edit'),
  async (_req: AuthenticatedRequest, res: Response) => {
    try {
      if (!isDemoMode()) await dismissMigrationNotes();
      res.json({ success: true });
    } catch (error) {
      res.status(500).json({
        success: false,
        error: 'Failed to dismiss the notices',
        message: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  },
);

// GET /api/server/config/files - config files in the server folder (regular files only)
router.get(
  '/config/files',
  authMiddleware,
  requirePermission('config.view'),
  async (req: AuthenticatedRequest, res: Response) => {
    if (isDemoMode()) {
      res.json({
        files: getDemoConfigFiles().map((f) => ({
          name: f.name,
          size: f.size,
          modified: f.lastModified,
        })),
      });
      return;
    }
    try {
      const { serverPath } = await resolveInstallPaths(req.serverId);
      const entries = await readdir(serverPath, { withFileTypes: true });
      const names = entries
        .filter(
          (e) => e.isFile() && CONFIG_EXTENSIONS.some((ext) => e.name.toLowerCase().endsWith(ext)),
        )
        .map((e) => e.name);
      const files = await Promise.all(
        names.map(async (name) => {
          try {
            const st = await stat(path.join(serverPath, name));
            return { name, size: st.size, modified: st.mtime.toISOString() };
          } catch {
            return { name, size: 0, modified: null };
          }
        }),
      );
      res.json({ files });
    } catch (error) {
      res.status(500).json({
        error: 'Failed to list config files',
        message: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  },
);

/** A top-level config file name of the server folder, or null. */
function configFileName(filename: string): string | null {
  if (!filename || filename !== path.basename(filename) || filename.includes('..')) return null;
  if (filename.includes('\\') || /[\u0000-\u001f]/.test(filename)) return null;
  return CONFIG_EXTENSIONS.some((ext) => filename.toLowerCase().endsWith(ext)) ? filename : null;
}

// GET /api/server/config/:filename - read a config file of the server folder
// (an access file also needs the right of its access page, guardAccessFileReads)
router.get(
  '/config/:filename',
  authMiddleware,
  requirePermission('config.view'),
  guardAccessFileReads,
  async (req: AuthenticatedRequest, res: Response) => {
    const filename = configFileName(req.params.filename);
    if (isDemoMode()) {
      res.json({ filename: req.params.filename, content: getDemoServerConfig() });
      return;
    }
    if (!filename) {
      res.status(400).json({ error: 'Invalid filename' });
      return;
    }
    try {
      const { serverPath } = await resolveInstallPaths(req.serverId);
      const file = await readServerFile(path.join(serverPath, filename), [serverPath]);
      if (!file) {
        res.status(404).json({ error: 'File not found' });
        return;
      }
      res.json({ filename, content: file.content });
    } catch (error) {
      if (error instanceof UnsafeFileError) {
        console.warn(`[SECURITY] Blocked server config read: ${error.message}`);
        res.status(403).json({ error: 'Access denied - invalid path' });
        return;
      }
      res.status(500).json({
        error: 'Failed to read config file',
        message: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  },
);

/** Problems with new content: invalid JSON, or a config.json the server would not start with. */
function checkConfigContent(
  filename: string,
  content: string,
): { ok: true; warnings: string[] } | { ok: false; body: Record<string, unknown> } {
  if (!filename.toLowerCase().endsWith('.json')) return { ok: true, warnings: [] };
  let parsed: unknown;
  try {
    parsed = parseLosslessJson(content);
  } catch (error) {
    return {
      ok: false,
      body: {
        reason: 'invalid_json',
        error: `${filename} is not valid JSON: ${error instanceof Error ? error.message : error}`,
      },
    };
  }
  if (filename.toLowerCase() !== SERVER_CONFIG) {
    return isJsonObject(parsed) || Array.isArray(parsed)
      ? { ok: true, warnings: [] }
      : {
          ok: false,
          body: { reason: 'invalid_json', error: `${filename} must hold a JSON object` },
        };
  }
  const check = parseHytaleConfig(parsed);
  if (!check.ok) {
    return {
      ok: false,
      body: {
        reason: 'invalid_config',
        issues: check.issues,
        warnings: check.warnings,
        error: `The server would not start with this config.json: ${check.issues.join('; ')}`,
      },
    };
  }
  return { ok: true, warnings: check.warnings };
}

/**
 * Middleware: an access file (permissions.json, the ban file, ...) or a change
 * to the access settings of config.json also needs the rights of the access
 * pages, and an access file must stay readable for the server: valid JSON
 * whatever its name ends in, in the form the server reads. Anything the route
 * refuses anyway (bad name, no string; invalid JSON in config.json) passes on to it.
 */
async function guardAccessFiles(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  const filename = configFileName(req.params.filename);
  const content: unknown = req.body?.content;
  if (isDemoMode() || !filename || typeof content !== 'string') return next();
  const isServerConfig = filename.toLowerCase() === SERVER_CONFIG;
  let rights: Permission[] = [];
  let problems: string[] = [];
  try {
    const rule = isServerConfig ? null : await accessFileRule(req.serverId, filename);
    if (!isServerConfig && !rule) return next();
    let parsed: unknown;
    try {
      parsed = parseLosslessJson(content);
    } catch (error) {
      if (isServerConfig) return next();
      parsed = undefined;
      problems = [`it is not valid JSON: ${error instanceof Error ? error.message : error}`];
    }
    if (rule) {
      rights = rule.rights;
      if (problems.length === 0) problems = rule.problems(parsed);
    } else {
      const { file, serverPath } = await serverConfigFile(req.serverId);
      // A file that cannot be read counts as one without these settings.
      const current = await readServerJson(file, [serverPath]).catch(() => ({}));
      rights = configAccessRights(current, parsed);
    }
  } catch (error) {
    sendWriteError(res, error, 'config');
    return;
  }
  const checkContent = (error?: unknown) => {
    if (error) return next(error);
    if (problems.length === 0) return next();
    res.status(400).json({
      success: false,
      reason: 'invalid_config',
      issues: problems,
      error: `The server could not read this ${filename}: ${problems.join('; ')}`,
    });
  };
  if (rights.length === 0) return checkContent();
  await requirePermission(...rights)(req, res, checkContent);
}

/** Middleware: reading an access file needs the right of the access page that shows it. */
async function guardAccessFileReads(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  const filename = configFileName(req.params.filename);
  if (isDemoMode() || !filename || filename.toLowerCase() === SERVER_CONFIG) return next();
  let rule: Awaited<ReturnType<typeof accessFileRule>>;
  try {
    rule = await accessFileRule(req.serverId, filename);
  } catch (error) {
    sendReadError(res, error, 'config file');
    return;
  }
  if (!rule) return next();
  await requirePermission(...rule.readRights)(req, res, next);
}

// PUT /api/server/config/:filename - write a config file of the server folder.
// JSON is checked (config.json against the server's schema), the old content
// is kept as .bak, the file is replaced atomically. The server keeps these
// files in memory, so with the server running it needs `restart: true`.
// The access files need the access pages' rights as well (guardAccessFiles).
router.put(
  '/config/:filename',
  authMiddleware,
  requirePermission('config.edit'),
  requireRestartPermissionIfAsked,
  guardAccessFiles,
  async (req: AuthenticatedRequest, res: Response) => {
    const filename = configFileName(req.params.filename);
    const content = req.body?.content;
    if (isDemoMode()) {
      res.json({
        success: true,
        filename: req.params.filename,
        message: '[DEMO] Config saved (simulated)',
      });
      return;
    }
    if (!filename) {
      res.status(400).json({ error: 'Invalid filename' });
      return;
    }
    if (typeof content !== 'string') {
      res.status(400).json({ error: 'Content must be a string' });
      return;
    }
    if (Buffer.byteLength(content, 'utf-8') > MAX_CONFIG_FILE_BYTES) {
      res.status(413).json({ error: 'File too large' });
      return;
    }
    const check = checkConfigContent(filename, content);
    if (!check.ok) {
      res.status(400).json({ success: false, ...check.body });
      return;
    }
    try {
      const { serverPath } = await resolveInstallPaths(req.serverId);
      const outcome = await writeWhileStopped(
        req.serverId,
        {
          restart: req.body?.restart === true,
          actor: req.user,
          countdownSeconds: countdownFrom(req.body),
        },
        () => writeServerFile(path.join(serverPath, filename), [serverPath], content),
      );
      if (sendRefusedWrite(res, outcome, { filename })) return;
      const restarted = outcome.kind === 'written' && outcome.restarted;
      audit(req, 'server.config.file_saved', { target: filename, metadata: { restarted } });
      res.json({
        success: true,
        restarted,
        warnings: check.warnings,
        message: restarted ? 'Config saved, server restarted' : 'Config saved',
      });
    } catch (error) {
      sendWriteError(res, error, 'config');
    }
  },
);

export default router;
