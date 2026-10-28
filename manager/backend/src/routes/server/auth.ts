// Hytale downloader OAuth flow + auth status endpoints, per server: every game
// container has its own downloader and token, so the request's server is the
// one that is checked and logged in.
import { Router, Response } from 'express';
import { authMiddleware } from '../../middleware/auth.js';
import { requirePermission } from '../../middleware/permissions.js';
import * as dockerService from '../../services/docker.js';
import { isDemoMode, getDemoDownloaderStatus } from '../../services/demoData.js';
import { resolveServerId } from '../../services/servers.js';
import type { AuthenticatedRequest } from '../../types/index.js';
import {
  checkDownloaderCredentials,
  getLatestVersion,
  getDownloaderOAuthState,
  setDownloaderOAuthState,
  downloaderShellCommand,
  findPendingDeviceLogin,
  DEVICE_LOGIN_LIFETIME_MS,
  DOWNLOADER_BUSY_MARKER,
  type PendingDeviceLogin,
} from './shared.js';

const router = Router();

// Log lines searched for a device login the container started itself.
const LOGIN_PROMPT_LOG_LINES = 200;

/**
 * A device login the server's container waits for (its own downloader run),
 * or null. Only read from the current container run, and only while the game
 * server is not running: then the entrypoint's downloader wrote the log, not
 * the server or one of its mods.
 */
async function pendingContainerLogin(serverId: string): Promise<PendingDeviceLogin | null> {
  const state = await dockerService.getContainerState(serverId).catch(() => null);
  if (!state?.running) return null;
  if ((await dockerService.isServerProcessRunning(serverId)) !== false) return null;
  const startedAt = Date.parse(state.startedAt);
  return findPendingDeviceLogin(
    await dockerService.getLogs(LOGIN_PROMPT_LOG_LINES, serverId),
    Date.now(),
    Number.isFinite(startedAt) ? startedAt : undefined,
  );
}

function expiryOf(login: PendingDeviceLogin): Date {
  const shown = login.shownAt ? Date.parse(login.shownAt) : Date.now();
  return new Date(shown + DEVICE_LOGIN_LIFETIME_MS);
}

// GET /api/server/downloader/auth-status - Check downloader authentication status
router.get(
  '/downloader/auth-status',
  authMiddleware,
  requirePermission('server.view_status'),
  async (req: AuthenticatedRequest, res: Response) => {
    // Demo mode: return demo downloader status
    if (isDemoMode()) {
      const demoStatus = getDemoDownloaderStatus();
      res.json({
        authenticated: demoStatus.authenticated,
        credentialsExist: true,
        authRequired: false,
        username: demoStatus.username,
        lastAuth: demoStatus.lastAuth,
      });
      return;
    }

    try {
      const serverId = await resolveServerId(req.serverId);
      const credCheck = await checkDownloaderCredentials(serverId);

      // Try to get version as a test
      if (credCheck.exists) {
        const testResult = await getLatestVersion('release', serverId);
        res.json({
          authenticated: testResult.version !== 'unknown' && !testResult.authRequired,
          credentialsExist: true,
          authRequired: testResult.authRequired || false,
          error: testResult.authRequired ? 'Token expired or invalid' : undefined,
        });
      } else {
        res.json({
          authenticated: false,
          credentialsExist: false,
          authRequired: true,
          error: 'No credentials found',
          // A new server's container waits for this login before it downloads.
          pendingLogin: await pendingContainerLogin(serverId),
        });
      }
    } catch (error) {
      res.status(500).json({
        error: 'Failed to check downloader auth status',
        message: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  },
);

// POST /api/server/downloader/initiate-auth - Start downloader OAuth flow
router.post(
  '/downloader/initiate-auth',
  authMiddleware,
  requirePermission('server.restart'),
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      const serverId = await resolveServerId(req.serverId);
      console.log(`[Server] Initiating downloader OAuth flow for ${serverId}...`);

      // The container's own download may already wait for a login (a new
      // server with USE_HYTALE_DOWNLOADER): that login is the one to finish.
      // It holds the downloader lock, so a second run could not start anyway.
      if (!(await checkDownloaderCredentials(serverId)).exists) {
        const waiting = await pendingContainerLogin(serverId);
        if (waiting) {
          setDownloaderOAuthState(serverId, {
            active: true,
            verificationUrl: waiting.verificationUrl,
            userCode: waiting.userCode ?? undefined,
            expiresAt: expiryOf(waiting),
          });
          const expiresIn = Math.max(
            0,
            Math.round((expiryOf(waiting).getTime() - Date.now()) / 1000),
          );
          return res.json({
            success: true,
            source: 'container',
            verificationUrl: waiting.verificationUrl,
            userCode: waiting.userCode,
            expiresIn,
          });
        }
      }

      // First, delete existing credentials to force re-authentication
      await dockerService.execInContainer(
        `rm -f /opt/hytale/downloader/.hytale-downloader-credentials.json 2>/dev/null || true`,
        serverId,
      );

      // Run the downloader - it will start OAuth flow when credentials are missing.
      // Use a timeout since it will wait for user input.
      // IMPORTANT: run as `hytale` (uid 9999) via gosu. The OAuth flow writes
      // .hytale-downloader-credentials.json into /opt/hytale/downloader; if we run
      // as root those credentials are created root-owned (mode 0600) and the
      // actual server download — which runs as `gosu hytale` in entrypoint.sh —
      // cannot read them, so it loops "downloading" forever without ever
      // succeeding. Authenticating as hytale keeps the credential file usable by
      // the server process.
      // Shares the downloader lock with the entrypoint and the version probes.
      const authResult = await dockerService.execInContainer(
        downloaderShellCommand('-skip-update-check', 60),
        serverId,
      );

      const output = authResult.output || '';
      console.log('[Server] Downloader auth output:', output.substring(0, 1000));
      if (output.includes(DOWNLOADER_BUSY_MARKER)) {
        return res.status(409).json({
          success: false,
          error: 'The downloader is busy (a download is running). Try again in a few minutes.',
        });
      }

      // Parse OAuth URLs from output
      // The downloader outputs: "Visit: https://oauth.accounts.hytale.com/oauth2/device/verify"
      // And a user code like: "Enter code: fHmkjxFE" or the code might be in the URL
      const urlMatch = output.match(/(https:\/\/oauth\.accounts\.hytale\.com\/[^\s\n\]]+)/i);

      // Try multiple patterns for the user code
      let userCode: string | null = null;
      const codePatterns = [
        /(?:enter\s+code|user_code|code)[:\s=]+([A-Za-z0-9]{6,12})/i,
        /user_code=([A-Za-z0-9]{6,12})/i,
        /\[([A-Za-z0-9]{8})\]/, // Code might be in brackets
      ];

      for (const pattern of codePatterns) {
        const match = output.match(pattern);
        if (match) {
          userCode = match[1].trim();
          break;
        }
      }

      if (!urlMatch) {
        // Check if already authenticated or if download started
        if (
          output.includes('Downloading') ||
          output.includes('already') ||
          output.includes('authenticated') ||
          output.includes('success')
        ) {
          return res.json({
            success: true,
            alreadyAuthenticated: true,
            message: 'Downloader is already authenticated',
          });
        }

        // Maybe the downloader isn't installed or there's another issue
        return res.status(400).json({
          success: false,
          error:
            'Could not parse OAuth URL from downloader output. The downloader may need to be reinstalled.',
          output: output.substring(0, 800),
        });
      }

      let verificationUrl = urlMatch[1].trim();

      // Clean up URL - remove any trailing characters that might have been captured
      verificationUrl = verificationUrl.replace(/[\]\)\}\s]+$/, '');

      // If URL doesn't have user_code, add it
      if (userCode && !verificationUrl.includes('user_code=')) {
        verificationUrl += verificationUrl.includes('?')
          ? `&user_code=${userCode}`
          : `?user_code=${userCode}`;
      }

      // Store state
      setDownloaderOAuthState(serverId, {
        active: true,
        verificationUrl,
        userCode: userCode || undefined,
        expiresAt: new Date(Date.now() + DEVICE_LOGIN_LIFETIME_MS),
      });

      res.json({
        success: true,
        verificationUrl,
        userCode,
        expiresIn: DEVICE_LOGIN_LIFETIME_MS / 1000,
      });
    } catch (error) {
      res.status(500).json({
        error: 'Failed to initiate downloader auth',
        message: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  },
);

// GET /api/server/downloader/auth-poll - Poll for auth completion
router.get(
  '/downloader/auth-poll',
  authMiddleware,
  requirePermission('server.restart'),
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      const serverId = await resolveServerId(req.serverId);
      const state = getDownloaderOAuthState(serverId);
      if (!state.active) {
        return res.json({
          completed: false,
          error: 'No active auth flow',
        });
      }

      // Check if expired
      if (state.expiresAt && new Date() > state.expiresAt) {
        setDownloaderOAuthState(serverId, { active: false });
        return res.json({
          completed: false,
          expired: true,
          error: 'Auth flow expired',
        });
      }

      // Check if credentials now exist and work
      const credCheck = await checkDownloaderCredentials(serverId);
      if (credCheck.exists) {
        const testResult = await getLatestVersion('release', serverId);
        if (testResult.version !== 'unknown' && !testResult.authRequired) {
          setDownloaderOAuthState(serverId, { active: false });
          return res.json({
            completed: true,
            version: testResult.version,
          });
        }
        // The token is there and the container's own download holds the
        // downloader: the login worked, the files are on their way.
        if (testResult.busy) {
          setDownloaderOAuthState(serverId, { active: false });
          return res.json({ completed: true, downloading: true });
        }
      }

      res.json({
        completed: false,
        verificationUrl: state.verificationUrl,
        userCode: state.userCode,
      });
    } catch (error) {
      res.status(500).json({
        error: 'Failed to poll auth status',
        message: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  },
);

export default router;
