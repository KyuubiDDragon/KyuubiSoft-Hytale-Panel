// Per-world configuration endpoints: the world editor (config.json with the
// Hytale 0.7 field names, see schemas/worldConfig.ts) and the generic
// /worlds/:worldName/files/* read/write for the JSON files of a world folder
// (resources/*.json). The server keeps these in memory and writes them back,
// so they are only written while it is stopped (services/serverConfigWrite.ts);
// PvP and the time pause also apply live (services/worldSettings.ts).
//
// The world folders the panel sees are those of the default server, so these
// routes serve only that server: under /api/servers/<other id>/management
// they answer 409 default_server_only and touch nothing.
import { Router, Request, Response, NextFunction } from 'express';
import { authMiddleware } from '../../middleware/auth.js';
import { requirePermission } from '../../middleware/permissions.js';
import { logActivity } from '../../services/activityLog.js';
import { audit } from '../../services/audit.js';
import { isPluginInstalled } from '../../services/kyuubiApi.js';
import { getDefaultId } from '../../services/servers.js';
import {
  countdownFrom,
  isServerRunning,
  requireRestartPermissionIfAsked,
  sendRefusedWrite,
  sendWriteError,
  writeWhileStopped,
} from '../../services/serverConfigWrite.js';
import {
  applyLiveWorldSettings,
  forgetLiveValues,
  isValidWorldName,
  locateWorldFile,
  rememberLiveValues,
  withRecentLiveValues,
  worldJsonPath,
} from '../../services/worldSettings.js';
import {
  applyWorldPatch,
  changedWorldKeys,
  MAX_DURATION_SECONDS,
  parseWorldConfig,
  pickWorldPatch,
  readWorldFields,
  validateWorldPatch,
  worldFieldModes,
  worldFieldName,
  worldKeyApply,
} from '../../schemas/worldConfig.js';
import { SERVER_GAME_MODES } from '../../schemas/hytaleConfig.js';
import { isJsonObject, isRawJsonNumber, parseLosslessJson } from '../../utils/losslessJson.js';
import { updateServerJson, writeServerFile } from '../../utils/serverFiles.js';
import { UnsafeFileError } from '../../utils/noFollowFs.js';
import type { AuthenticatedRequest } from '../../types/index.js';

const router = Router();

/**
 * Lets only requests for the default server through: the legacy
 * /api/management routes (no server id) and that server's scoped routes.
 */
async function defaultServerOnly(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
): Promise<void> {
  if (req.serverId !== undefined) {
    let defaultId: string;
    try {
      defaultId = await getDefaultId();
    } catch {
      res.status(503).json({ success: false, error: 'The server registry is not ready yet' });
      return;
    }
    if (req.serverId !== defaultId) {
      res.status(409).json({
        success: false,
        reason: 'default_server_only',
        error: 'World configs can only be edited for the default server.',
      });
      return;
    }
  }
  next();
}

// The editor is for config files, not for data dumps.
const MAX_WORLD_FILE_BYTES = 5 * 1024 * 1024;

class WorldFileError extends Error {
  constructor(
    readonly status: number,
    readonly reason: string,
    message: string,
  ) {
    super(message);
    this.name = 'WorldFileError';
  }
}

const notFound = (what: string) => new WorldFileError(404, 'not_found', `${what} not found`);
const invalidJson = (file: string) =>
  new WorldFileError(
    409,
    'invalid_json',
    `${file} is not valid JSON. Fix it in the file editor or restore ${file}.bak first.`,
  );

function sendReadError(res: Response, error: unknown, what: string): void {
  if (error instanceof WorldFileError) {
    res.status(error.status).json({ success: false, reason: error.reason, error: error.message });
    return;
  }
  if (error instanceof UnsafeFileError) {
    res.status(403).json({ success: false, reason: 'unsafe_file', error: error.message });
    return;
  }
  res.status(500).json({
    success: false,
    error: `Failed to read ${what}`,
    message: error instanceof Error ? error.message : 'Unknown error',
  });
}

async function loadWorldConfig(worldName: string) {
  const found = await locateWorldFile(worldName, 'config.json');
  if (!found) throw notFound('World config');
  let config: unknown;
  try {
    config = parseLosslessJson(found.content);
  } catch {
    throw invalidJson('config.json');
  }
  if (!isJsonObject(config)) throw invalidJson('config.json');
  return { ...found, config };
}

/** A world seed as text: the server stores it as a Java long, beyond what a JS number holds. */
function seedText(seed: unknown): string | null {
  if (isRawJsonNumber(seed)) return (seed as { rawJSON: string }).rawJSON;
  return typeof seed === 'number' || typeof seed === 'string' ? String(seed) : null;
}

// GET /api/management/worlds/:worldName/config - the world editor's fields
// (with the server's fallback for a missing key) and how each takes effect.
router.get(
  '/worlds/:worldName/config',
  authMiddleware,
  defaultServerOnly,
  requirePermission('worlds.view'),
  async (req: AuthenticatedRequest, res: Response) => {
    const { worldName } = req.params;
    if (!isValidWorldName(worldName)) {
      res.status(400).json({ error: 'Invalid world name' });
      return;
    }
    try {
      const { config, content } = await loadWorldConfig(worldName);
      const running = await isServerRunning(req.serverId);
      if (!running) forgetLiveValues(worldName);
      const check = parseWorldConfig(config);
      res.json({
        name: worldName,
        raw: config,
        // The file as it is, for a text editor (a browser would round a big seed).
        rawText: content,
        ...readWorldFields(withRecentLiveValues(worldName, config)),
        seed: seedText(config.Seed),
        gameTime: typeof config.GameTime === 'string' ? config.GameTime : null,
        fields: worldFieldModes(),
        limits: { maxDurationSeconds: MAX_DURATION_SECONDS, gameModes: SERVER_GAME_MODES },
        issues: check.issues,
        warnings: check.warnings,
        serverRunning: running,
        liveAvailable: running && (await isPluginInstalled(req.serverId)),
      });
    } catch (error) {
      sendReadError(res, error, 'world config');
    }
  },
);

// PUT /api/management/worlds/:worldName/config - save the world editor.
//  - server stopped: written to the world's config.json;
//  - server running, only live fields changed: applied with the world
//    commands and checked (needs the plugin);
//  - server running, other fields changed: 409 requiresRestart unless
//    `restart: true` (stop, save, start; optional countdownSeconds).
router.put(
  '/worlds/:worldName/config',
  authMiddleware,
  defaultServerOnly,
  requirePermission('worlds.manage'),
  requireRestartPermissionIfAsked,
  async (req: AuthenticatedRequest, res: Response) => {
    const { worldName } = req.params;
    if (!isValidWorldName(worldName)) {
      res.status(400).json({ error: 'Invalid world name' });
      return;
    }
    const validation = validateWorldPatch(req.body);
    if (!validation.ok) {
      res.status(400).json({ success: false, error: validation.error });
      return;
    }
    const { patch } = validation;
    const { serverId } = req;
    try {
      const found = await loadWorldConfig(worldName);
      const running = await isServerRunning(serverId);
      if (!running) forgetLiveValues(worldName);
      const changed = changedWorldKeys(withRecentLiveValues(worldName, found.config), patch);
      if (changed.length === 0) {
        res.json({ success: true, changed: false, message: 'World config unchanged.' });
        return;
      }
      // Only what changes is applied: the form sends every field.
      const changes = pickWorldPatch(patch, changed);
      const liveKeys = changed.filter((k) => worldKeyApply(k) === 'live');
      const restartKeys = changed.filter((k) => worldKeyApply(k) === 'restart');
      const fieldNames = (keys: string[]) => [...new Set(keys.map(worldFieldName))];
      const details = { restartFields: fieldNames(restartKeys), liveFields: fieldNames(liveKeys) };
      const restart = req.body?.restart === true;
      const auditMeta = { world: worldName, fields: fieldNames(changed) };

      if (running && !restart) {
        if (restartKeys.length > 0) {
          sendRefusedWrite(res, { kind: 'requires_restart' }, details);
          return;
        }
        const values = Object.fromEntries(liveKeys.map((k) => [k, changes.set[k]]));
        const live = await applyLiveWorldSettings(worldName, values, serverId, req.user);
        if (live.kind === 'unavailable') {
          res.status(409).json({
            success: false,
            requiresRestart: true,
            reason: 'live_unavailable',
            ...details,
            error: `The change cannot be applied while the server runs (${live.reason}). Save with a restart instead.`,
          });
          return;
        }
        rememberLiveValues(
          worldName,
          Object.fromEntries(live.results.filter((r) => r.ok).map((r) => [r.key, values[r.key]])),
        );
        const failed = live.results.filter((r) => !r.ok);
        audit(req, 'world.config.live', {
          target: worldName,
          metadata: { ...auditMeta, failed: failed.map((r) => worldFieldName(r.key)) },
          success: failed.length === 0,
        });
        if (failed.length > 0) {
          res.status(502).json({
            success: false,
            reason: 'not_confirmed',
            results: live.results,
            error: `The server did not confirm: ${failed
              .map((r) => `${worldFieldName(r.key)} (${r.message})`)
              .join(', ')}`,
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

      const outcome = await writeWhileStopped(
        serverId,
        { restart, actor: req.user, countdownSeconds: countdownFrom(req.body) },
        () =>
          updateServerJson(found.file, [found.root], (current) => {
            if (current === null) throw notFound('World config');
            if (!isJsonObject(current)) throw invalidJson('config.json');
            return applyWorldPatch(current, changes);
          }),
      );
      if (sendRefusedWrite(res, outcome, details)) return;
      forgetLiveValues(worldName);
      const restarted = outcome.kind === 'written' && outcome.restarted;
      audit(req, 'world.config.saved', {
        target: worldName,
        metadata: { ...auditMeta, restarted },
      });
      await logActivity(
        req.user || 'unknown',
        'update_world_config',
        'config',
        true,
        worldName,
        `Updated world config for ${worldName}`,
      );
      res.json({
        success: true,
        changed: true,
        applied: restarted ? 'restart' : 'file',
        restarted,
        message: restarted
          ? 'World config saved, server restarted.'
          : 'World config saved. It takes effect when the server starts.',
      });
    } catch (error) {
      if (error instanceof WorldFileError) {
        sendReadError(res, error, 'world config');
        return;
      }
      sendWriteError(res, error, 'world config');
    }
  },
);

// GET /api/management/worlds/:worldName/files/:filePath - read a JSON file of a world
router.get(
  '/worlds/:worldName/files/*',
  authMiddleware,
  defaultServerOnly,
  requirePermission('worlds.view'),
  async (req: Request, res: Response) => {
    const { worldName } = req.params;
    const filePath = worldJsonPath(req.params[0]);
    if (!isValidWorldName(worldName)) {
      res.status(400).json({ error: 'Invalid world name' });
      return;
    }
    if (!filePath) {
      res.status(400).json({
        error: 'Invalid file path. Only .json files in the world folder or resources/ are allowed.',
      });
      return;
    }
    try {
      const found = await locateWorldFile(worldName, filePath);
      if (!found) throw notFound('File');
      let data: unknown;
      try {
        data = parseLosslessJson(found.content);
      } catch {
        res.status(400).json({ error: 'Invalid JSON file', raw: found.content });
        return;
      }
      res.json({
        worldName,
        filePath,
        fileName: filePath.split('/').pop(),
        content: data,
        raw: found.content,
      });
    } catch (error) {
      sendReadError(res, error, 'file');
    }
  },
);

/** Text of a file write request (a JSON string or a value), checked; null when invalid. */
function fileContent(
  filePath: string,
  content: unknown,
): { ok: true; text: string; warnings: string[] } | { ok: false; error: string } {
  let text: string;
  let parsed: unknown;
  if (typeof content === 'string') {
    try {
      parsed = parseLosslessJson(content);
    } catch (error) {
      return {
        ok: false,
        error: `Invalid JSON content: ${error instanceof Error ? error.message : error}`,
      };
    }
    text = content;
  } else {
    parsed = content;
    text = `${JSON.stringify(content, null, 2)}\n`;
  }
  if (!isJsonObject(parsed) && !Array.isArray(parsed)) {
    return { ok: false, error: 'The file must hold a JSON object or array' };
  }
  if (Buffer.byteLength(text, 'utf-8') > MAX_WORLD_FILE_BYTES) {
    return { ok: false, error: 'File too large' };
  }
  if (filePath !== 'config.json') return { ok: true, text, warnings: [] };
  const check = parseWorldConfig(parsed);
  return check.ok
    ? { ok: true, text, warnings: check.warnings }
    : {
        ok: false,
        error: `The server would not load this world config: ${check.issues.join('; ')}`,
      };
}

// PUT /api/management/worlds/:worldName/files/:filePath - replace a JSON file
// of a world (the old content is kept as .bak). The server saves the world's
// resources every few seconds, so with the server running this needs
// `restart: true`.
router.put(
  '/worlds/:worldName/files/*',
  authMiddleware,
  defaultServerOnly,
  requirePermission('worlds.manage'),
  requireRestartPermissionIfAsked,
  async (req: AuthenticatedRequest, res: Response) => {
    const { worldName } = req.params;
    const filePath = worldJsonPath(req.params[0]);
    if (!isValidWorldName(worldName)) {
      res.status(400).json({ error: 'Invalid world name' });
      return;
    }
    if (!filePath) {
      res.status(400).json({
        error: 'Invalid file path. Only .json files in the world folder or resources/ are allowed.',
      });
      return;
    }
    if (req.body?.content === undefined) {
      res.status(400).json({ error: 'Content is required' });
      return;
    }
    const content = fileContent(filePath, req.body.content);
    if (!content.ok) {
      res.status(400).json({ success: false, error: content.error });
      return;
    }
    try {
      // Only existing files: the editor does not create files in a world.
      const found = await locateWorldFile(worldName, filePath);
      if (!found) throw notFound('File');
      const outcome = await writeWhileStopped(
        req.serverId,
        {
          restart: req.body?.restart === true,
          actor: req.user,
          countdownSeconds: countdownFrom(req.body),
        },
        () => writeServerFile(found.file, [found.root], content.text),
      );
      if (sendRefusedWrite(res, outcome, { filename: filePath })) return;
      if (filePath === 'config.json') forgetLiveValues(worldName);
      const restarted = outcome.kind === 'written' && outcome.restarted;
      const fileName = filePath.split('/').pop();
      audit(req, 'world.file.saved', {
        target: `${worldName}/${filePath}`,
        metadata: { restarted },
      });
      await logActivity(
        req.user || 'unknown',
        'update_world_file',
        'config',
        true,
        `${worldName}/${filePath}`,
        `Updated ${fileName} in world ${worldName}`,
      );
      res.json({
        success: true,
        restarted,
        warnings: content.warnings,
        message: restarted
          ? `File ${fileName} updated, server restarted`
          : `File ${fileName} updated`,
      });
    } catch (error) {
      if (error instanceof WorldFileError || error instanceof UnsafeFileError) {
        sendReadError(res, error, 'file');
        return;
      }
      sendWriteError(res, error, 'file');
    }
  },
);

export default router;
