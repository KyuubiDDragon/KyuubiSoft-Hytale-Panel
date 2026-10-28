// Panel start settings in panel-config.json: patchline, start flags
// (accept-early-plugins, disable-sentry, allow-op) and JVM tuning. The
// server's own config.json is edited through serverConfig.ts.
import { Router, Request, Response, type NextFunction } from 'express';
import { rm } from 'fs/promises';
import path from 'path';
import { authMiddleware } from '../../middleware/auth.js';
import { requirePermission } from '../../middleware/permissions.js';
import * as dockerService from '../../services/docker.js';
import { config } from '../../config.js';
import { escapeShellArg } from '../../utils/sanitize.js';
import { isDemoMode, getDemoPatchlineConfig } from '../../services/demoData.js';
import {
  readPanelConfig,
  writePanelConfig,
  DEFAULT_NATIVE_BACKUP_MAX_COUNT,
  DEFAULT_NATIVE_BACKUP_ARCHIVE_MAX_COUNT,
} from './shared.js';
import {
  validateExtraJavaArgs,
  validateExtraServerArgs,
  normalizeBootCommands,
  maxHeapMbForLimit,
  ramToMb,
} from '../../services/jvmSettings.js';
import { authorizeCommand, actorFromRequest } from '../../services/commandPolicy.js';
import { resolveInstallPaths, discardStagedUpdate } from '../../services/serverInstall.js';
import { withServerStopped, LifecycleBusyError } from '../../services/serverLifecycle.js';
import { updateCommandRefusal } from '../../services/updateStatusReply.js';
import type { AuthenticatedRequest } from '../../types/index.js';

const router = Router();

async function isServerRunning(): Promise<boolean> {
  const state = await dockerService.getContainerState().catch(() => null);
  return state?.running === true;
}

/** Removed on a patchline switch, so the next start downloads the new build. */
const patchlineSwitchFiles = () =>
  ['HytaleServer.jar', 'Assets.zip', '.hytale-version'].map((name) =>
    path.join(config.serverPath, name),
  );

// GET /api/server/patchline - Get current patchline setting
router.get(
  '/patchline',
  authMiddleware,
  requirePermission('server.view_status'),
  async (_req: Request, res: Response) => {
    // Demo mode: return demo patchline
    if (isDemoMode()) {
      const demoPatchline = getDemoPatchlineConfig();
      res.json({
        patchline: demoPatchline.patchline,
        options: ['release', 'pre-release'],
      });
      return;
    }

    try {
      const panelConfig = await readPanelConfig();
      res.json({
        patchline: panelConfig.patchline,
        options: ['release', 'pre-release'],
      });
    } catch (error) {
      res.status(500).json({
        error: 'Failed to get patchline setting',
        message: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  },
);

// PUT /api/server/patchline - Set patchline setting
router.put(
  '/patchline',
  authMiddleware,
  requirePermission('config.edit'),
  async (req: Request, res: Response) => {
    // Demo mode: simulate patchline change
    if (isDemoMode()) {
      const { patchline } = req.body;
      res.json({
        success: true,
        patchline,
        changed: true,
        message: '[DEMO] Patchline changed (simulated)',
      });
      return;
    }

    try {
      const { patchline } = req.body;

      if (!patchline || !['release', 'pre-release'].includes(patchline)) {
        res.status(400).json({ error: 'Invalid patchline. Must be "release" or "pre-release"' });
        return;
      }

      const panelConfig = await readPanelConfig();
      const oldPatchline = panelConfig.patchline;
      const patchlineChanged = oldPatchline !== patchline;

      if (!patchlineChanged) {
        await writePanelConfig({ ...panelConfig, patchline });
      } else if (await isServerRunning()) {
        // A downloaded update (or a download in progress) is for the old
        // patchline; the start script would install it over the new build.
        // The running server drops it itself.
        if ((await dockerService.isServerProcessRunning()) === false) {
          res.status(409).json({
            success: false,
            reason: 'lifecycle_busy',
            error: 'The server is starting or installing an update; try again in a moment.',
          });
          return;
        }
        const cancelled = await dockerService.execCommand('/update cancel');
        if (!cancelled.success) {
          res.status(503).json({
            success: false,
            error: `Could not ask the server to discard its downloaded update: ${cancelled.error}`,
          });
          return;
        }
        // The server answered (through the plugin) that it could not drop it.
        const refused = updateCommandRefusal(cancelled);
        if (refused) {
          res.status(409).json({
            success: false,
            reason: refused,
            error: `The server could not discard its downloaded update: ${cancelled.message ?? refused}`,
          });
          return;
        }
        await writePanelConfig({ ...panelConfig, patchline });
        // Deleted via container exec so the running container's view stays
        // consistent. Paths are config-derived, but shell-escaped so the
        // command stays injection-proof.
        await dockerService.execInContainer(
          `rm -f ${patchlineSwitchFiles().map(escapeShellArg).join(' ')} 2>/dev/null || true`,
        );
      } else {
        // Stopped: the panel removes the staged update and the files itself,
        // under the lifecycle lock so nothing starts the server meanwhile.
        const { updaterPath } = await resolveInstallPaths();
        await withServerStopped(
          undefined,
          { reason: 'config', actor: (req as AuthenticatedRequest).user, rejectIfBusy: true },
          async () => {
            await discardStagedUpdate(updaterPath);
            await writePanelConfig({ ...panelConfig, patchline });
            for (const file of patchlineSwitchFiles()) await rm(file, { force: true });
          },
        );
      }

      // If patchline changed, the server files are gone: the next start downloads the new build
      if (patchlineChanged) {
        res.json({
          success: true,
          patchline,
          changed: true,
          message: `Patchline changed from ${oldPatchline} to ${patchline}. Server files deleted and the downloaded update discarded. Restart to download the new version.`,
        });
      } else {
        res.json({
          success: true,
          patchline,
          changed: false,
          message: 'Patchline unchanged.',
        });
      }
    } catch (error) {
      if (error instanceof LifecycleBusyError) {
        res.status(409).json({ success: false, reason: 'lifecycle_busy', error: error.message });
        return;
      }
      res.status(500).json({
        error: 'Failed to set patchline',
        message: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  },
);

// GET /api/server/accept-early-plugins - Get current acceptEarlyPlugins setting
router.get(
  '/accept-early-plugins',
  authMiddleware,
  requirePermission('server.view_status'),
  async (_req: Request, res: Response) => {
    // Demo mode: return demo setting
    if (isDemoMode()) {
      res.json({ acceptEarlyPlugins: true });
      return;
    }

    try {
      const panelConfig = await readPanelConfig();
      res.json({
        acceptEarlyPlugins: panelConfig.acceptEarlyPlugins,
      });
    } catch (error) {
      res.status(500).json({
        error: 'Failed to get accept early plugins setting',
        message: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  },
);

// PUT /api/server/accept-early-plugins - Set acceptEarlyPlugins setting
router.put(
  '/accept-early-plugins',
  authMiddleware,
  requirePermission('config.edit'),
  async (req: Request, res: Response) => {
    // Demo mode: simulate setting change
    if (isDemoMode()) {
      const { acceptEarlyPlugins } = req.body;
      res.json({
        success: true,
        acceptEarlyPlugins,
        changed: true,
        message: '[DEMO] Setting changed (simulated)',
      });
      return;
    }

    try {
      const { acceptEarlyPlugins } = req.body;

      if (typeof acceptEarlyPlugins !== 'boolean') {
        res.status(400).json({ error: 'Invalid value. Must be a boolean.' });
        return;
      }

      const panelConfig = await readPanelConfig();
      const oldValue = panelConfig.acceptEarlyPlugins;
      const valueChanged = oldValue !== acceptEarlyPlugins;

      // Update config
      panelConfig.acceptEarlyPlugins = acceptEarlyPlugins;
      await writePanelConfig(panelConfig);

      res.json({
        success: true,
        acceptEarlyPlugins,
        changed: valueChanged,
        message: valueChanged
          ? `Accept early plugins ${acceptEarlyPlugins ? 'enabled' : 'disabled'}. Restart the server to apply changes.`
          : 'Setting unchanged.',
      });
    } catch (error) {
      res.status(500).json({
        error: 'Failed to set accept early plugins',
        message: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  },
);

// GET /api/server/disable-sentry - Get current disableSentry setting
router.get(
  '/disable-sentry',
  authMiddleware,
  requirePermission('server.view_status'),
  async (_req: Request, res: Response) => {
    // Demo mode: return demo setting
    if (isDemoMode()) {
      res.json({ disableSentry: false });
      return;
    }

    try {
      const panelConfig = await readPanelConfig();
      res.json({
        disableSentry: panelConfig.disableSentry,
      });
    } catch (error) {
      res.status(500).json({
        error: 'Failed to get disable sentry setting',
        message: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  },
);

// PUT /api/server/disable-sentry - Set disableSentry setting
router.put(
  '/disable-sentry',
  authMiddleware,
  requirePermission('config.edit'),
  async (req: Request, res: Response) => {
    // Demo mode: simulate setting change
    if (isDemoMode()) {
      const { disableSentry } = req.body;
      res.json({
        success: true,
        disableSentry,
        changed: true,
        message: '[DEMO] Setting changed (simulated)',
      });
      return;
    }

    try {
      const { disableSentry } = req.body;

      if (typeof disableSentry !== 'boolean') {
        res.status(400).json({ error: 'Invalid value. Must be a boolean.' });
        return;
      }

      const panelConfig = await readPanelConfig();
      const oldValue = panelConfig.disableSentry;
      const valueChanged = oldValue !== disableSentry;

      // Update config
      panelConfig.disableSentry = disableSentry;
      await writePanelConfig(panelConfig);

      res.json({
        success: true,
        disableSentry,
        changed: valueChanged,
        message: valueChanged
          ? `Sentry crash reporting ${disableSentry ? 'disabled' : 'enabled'}. Restart the server to apply changes.`
          : 'Setting unchanged.',
      });
    } catch (error) {
      res.status(500).json({
        error: 'Failed to set disable sentry',
        message: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  },
);

// GET /api/server/allow-op - Get current allowOp setting
router.get(
  '/allow-op',
  authMiddleware,
  requirePermission('server.view_status'),
  async (_req: Request, res: Response) => {
    // Demo mode: return demo setting
    if (isDemoMode()) {
      res.json({ allowOp: true });
      return;
    }

    try {
      const panelConfig = await readPanelConfig();
      res.json({
        allowOp: panelConfig.allowOp,
      });
    } catch (error) {
      res.status(500).json({
        error: 'Failed to get allow op setting',
        message: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  },
);

const operatorPermission = requirePermission('players.op');

/**
 * Middleware: with --allow-op every player can make themselves an operator
 * (/op self), so turning it on also needs players.op; turning it off does not.
 */
function requireOpToAllowOp(req: Request, res: Response, next: NextFunction): void {
  if ((req.body as { allowOp?: unknown } | undefined)?.allowOp === true) {
    void operatorPermission(req as AuthenticatedRequest, res, next);
    return;
  }
  next();
}

// PUT /api/server/allow-op - Set allowOp setting (on: also players.op)
router.put(
  '/allow-op',
  authMiddleware,
  requirePermission('config.edit'),
  requireOpToAllowOp,
  async (req: Request, res: Response) => {
    // Demo mode: simulate setting change
    if (isDemoMode()) {
      const { allowOp } = req.body;
      res.json({
        success: true,
        allowOp,
        changed: true,
        message: '[DEMO] Setting changed (simulated)',
      });
      return;
    }

    try {
      const { allowOp } = req.body;

      if (typeof allowOp !== 'boolean') {
        res.status(400).json({ error: 'Invalid value. Must be a boolean.' });
        return;
      }

      const panelConfig = await readPanelConfig();
      const oldValue = panelConfig.allowOp;
      const valueChanged = oldValue !== allowOp;

      // Update config
      panelConfig.allowOp = allowOp;
      await writePanelConfig(panelConfig);

      res.json({
        success: true,
        allowOp,
        changed: valueChanged,
        message: valueChanged
          ? `OP commands ${allowOp ? 'enabled' : 'disabled'}. Restart the server to apply changes.`
          : 'Setting unchanged.',
      });
    } catch (error) {
      res.status(500).json({
        error: 'Failed to set allow op',
        message: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  },
);

// RAM like "3G" / "512M".
const RAM_RE = /^\d{1,5}[MmGg]$/;
const MIN_NATIVE_BACKUP_COUNT = 1;
const MAX_NATIVE_BACKUP_COUNT = 100;

function nativeBackupCount(value: unknown, fallback: number): number | null {
  if (value === undefined || value === null || value === '') return fallback;
  const n = Number(value);
  return Number.isInteger(n) && n >= MIN_NATIVE_BACKUP_COUNT && n <= MAX_NATIVE_BACKUP_COUNT
    ? n
    : null;
}

// GET /api/server/jvm - current JVM/startup tuning (RAM, extra args, boot
// commands, AOT cache, native backup retention) plus the container limit.
router.get(
  '/jvm',
  authMiddleware,
  requirePermission('config.view'),
  async (req: AuthenticatedRequest, res: Response) => {
    if (isDemoMode()) {
      res.json({
        javaMinRam: '3G',
        javaMaxRam: '4G',
        extraJavaArgs: '',
        extraServerArgs: '',
        bootCommands: [],
        aotCache: false,
        nativeBackupMaxCount: DEFAULT_NATIVE_BACKUP_MAX_COUNT,
        nativeBackupArchiveMaxCount: DEFAULT_NATIVE_BACKUP_ARCHIVE_MAX_COUNT,
        memoryLimitMb: 8192,
        maxHeapMb: 8192 - 1536,
        envDefaults: { javaMinRam: '3G', javaMaxRam: '4G' },
      });
      return;
    }
    try {
      const [panelConfig, limit] = await Promise.all([
        readPanelConfig(),
        dockerService.getContainerMemoryLimit(req.serverId),
      ]);
      // Values saved before the validation existed are still passed on by the
      // start script; report them so the UI can ask for a fix.
      const javaCheck = validateExtraJavaArgs(panelConfig.extraJavaArgs ?? '');
      const serverCheck = validateExtraServerArgs(panelConfig.extraServerArgs ?? '');
      res.json({
        invalid: {
          extraJavaArgs: javaCheck.ok ? null : javaCheck.error,
          extraServerArgs: serverCheck.ok ? null : serverCheck.error,
        },
        // Effective values fall back to the container env defaults when unset.
        javaMinRam: panelConfig.javaMinRam ?? process.env.JAVA_MIN_RAM ?? '3G',
        javaMaxRam: panelConfig.javaMaxRam ?? process.env.JAVA_MAX_RAM ?? '4G',
        extraJavaArgs: panelConfig.extraJavaArgs ?? '',
        extraServerArgs: panelConfig.extraServerArgs ?? '',
        bootCommands: panelConfig.bootCommands ?? [],
        aotCache: panelConfig.aotCache ?? false,
        nativeBackupMaxCount: panelConfig.nativeBackupMaxCount ?? DEFAULT_NATIVE_BACKUP_MAX_COUNT,
        nativeBackupArchiveMaxCount:
          panelConfig.nativeBackupArchiveMaxCount ?? DEFAULT_NATIVE_BACKUP_ARCHIVE_MAX_COUNT,
        memoryLimitMb: limit ? Math.floor(limit / 1024 / 1024) : null,
        maxHeapMb: maxHeapMbForLimit(limit),
        envDefaults: {
          javaMinRam: process.env.JAVA_MIN_RAM ?? '3G',
          javaMaxRam: process.env.JAVA_MAX_RAM ?? '4G',
        },
      });
    } catch (error) {
      res.status(500).json({
        error: 'Failed to read JVM settings',
        message: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  },
);

// PUT /api/server/jvm - persist JVM/startup tuning to panel-config.json.
// Everything is checked here because the start script passes it on as is: a
// heap above the container limit ends in an OOM-kill loop, an unknown server
// option stops the server, and code-loading JVM options are refused.
router.put(
  '/jvm',
  authMiddleware,
  requirePermission('config.edit'),
  async (req: AuthenticatedRequest, res: Response) => {
    if (isDemoMode()) {
      res.json({
        success: true,
        changed: true,
        message: '[DEMO] JVM settings changed (simulated)',
      });
      return;
    }
    try {
      const body = req.body ?? {};
      const minRam = String(body.javaMinRam ?? '').trim();
      const maxRam = String(body.javaMaxRam ?? '').trim();
      const extraJava = String(body.extraJavaArgs ?? '').trim();
      const extraServer = String(body.extraServerArgs ?? '').trim();

      if (!RAM_RE.test(minRam) || !RAM_RE.test(maxRam)) {
        res.status(400).json({ error: 'RAM must look like "3G" or "512M".' });
        return;
      }
      const minMb = ramToMb(minRam) as number;
      const maxMb = ramToMb(maxRam) as number;
      if (minMb > maxMb) {
        res.status(400).json({ error: 'Minimum RAM cannot exceed maximum RAM.' });
        return;
      }
      const panelConfig = await readPanelConfig();
      // Only a new value is held against the memory limit: the form always
      // sends the RAM along, and a value that is already in use (say
      // JAVA_MAX_RAM=7G with an 8G limit, which the docs used to allow) must
      // not block saving boot commands or other settings. The start script
      // still warns about it.
      const currentMaxMb = ramToMb(panelConfig.javaMaxRam ?? process.env.JAVA_MAX_RAM ?? '4G');
      const limit = await dockerService.getContainerMemoryLimit(req.serverId);
      const maxHeapMb = maxHeapMbForLimit(limit);
      if (maxHeapMb !== null && maxMb > maxHeapMb && maxMb !== currentMaxMb) {
        res.status(400).json({
          error: `Maximum RAM ${maxRam} does not fit the container memory limit of ${Math.floor((limit as number) / 1024 / 1024)} MB. The JVM needs memory beyond the heap; use at most ${maxHeapMb}M or raise DOCKER_MEMORY_LIMIT.`,
          maxHeapMb,
        });
        return;
      }
      for (const check of [
        validateExtraJavaArgs(extraJava),
        validateExtraServerArgs(extraServer),
      ]) {
        if (!check.ok) {
          res.status(400).json({ error: check.error });
          return;
        }
      }

      const boot = normalizeBootCommands(body.bootCommands ?? panelConfig.bootCommands);
      if (!boot.ok) {
        res.status(400).json({ error: boot.error });
        return;
      }
      // Boot commands run with full console rights on every start: new ones
      // need the same whitelist and permission tier as typing them into the
      // console. Commands already stored (maybe saved by an admin) stay as they are.
      const stored = new Set(panelConfig.bootCommands ?? []);
      for (const command of boot.commands.filter((c) => !stored.has(c))) {
        const auth = await authorizeCommand(actorFromRequest(req), `/${command}`, req.serverId);
        if (!auth.allowed) {
          res.status(auth.status).json({ error: `Boot command "${command}": ${auth.error}` });
          return;
        }
      }
      const backupMax = nativeBackupCount(
        body.nativeBackupMaxCount,
        panelConfig.nativeBackupMaxCount ?? DEFAULT_NATIVE_BACKUP_MAX_COUNT,
      );
      const archiveMax = nativeBackupCount(
        body.nativeBackupArchiveMaxCount,
        panelConfig.nativeBackupArchiveMaxCount ?? DEFAULT_NATIVE_BACKUP_ARCHIVE_MAX_COUNT,
      );
      if (backupMax === null || archiveMax === null) {
        res.status(400).json({
          error: `Native backup counts must be whole numbers from ${MIN_NATIVE_BACKUP_COUNT} to ${MAX_NATIVE_BACKUP_COUNT}.`,
        });
        return;
      }
      if (body.aotCache !== undefined && typeof body.aotCache !== 'boolean') {
        res.status(400).json({ error: 'aotCache must be a boolean.' });
        return;
      }
      const aotCache = body.aotCache ?? panelConfig.aotCache ?? false;

      const next = {
        ...panelConfig,
        javaMinRam: minRam,
        javaMaxRam: maxRam,
        extraJavaArgs: extraJava,
        extraServerArgs: extraServer,
        bootCommands: boot.commands,
        aotCache,
        nativeBackupMaxCount: backupMax,
        nativeBackupArchiveMaxCount: archiveMax,
      };
      const changed = (Object.keys(next) as (keyof typeof next)[]).some(
        (k) => JSON.stringify(next[k]) !== JSON.stringify(panelConfig[k]),
      );
      await writePanelConfig(next);

      res.json({
        success: true,
        changed,
        message: changed
          ? 'JVM settings saved. Restart the server to apply changes.'
          : 'Settings unchanged.',
      });
    } catch (error) {
      res.status(500).json({
        error: 'Failed to save JVM settings',
        message: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  },
);

export default router;
