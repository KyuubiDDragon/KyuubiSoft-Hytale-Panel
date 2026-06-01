// Hytale downloader OAuth flow + auth status endpoints.
import { Router, Request, Response } from 'express';
import { authMiddleware } from '../../middleware/auth.js';
import { requirePermission } from '../../middleware/permissions.js';
import * as dockerService from '../../services/docker.js';
import { isDemoMode, getDemoDownloaderStatus } from '../../services/demoData.js';
import {
  checkDownloaderCredentials,
  getLatestVersion,
  downloaderOAuthState,
  setDownloaderOAuthState,
} from './shared.js';

const router = Router();

// GET /api/server/downloader/auth-status - Check downloader authentication status
router.get('/downloader/auth-status', authMiddleware, requirePermission('server.view_status'), async (_req: Request, res: Response) => {
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
    const credCheck = await checkDownloaderCredentials();

    // Try to get version as a test
    if (credCheck.exists) {
      const testResult = await getLatestVersion('release');
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
      });
    }
  } catch (error) {
    res.status(500).json({
      error: 'Failed to check downloader auth status',
      message: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

// POST /api/server/downloader/initiate-auth - Start downloader OAuth flow
router.post('/downloader/initiate-auth', authMiddleware, requirePermission('server.restart'), async (_req: Request, res: Response) => {
  try {
    console.log('[Server] Initiating downloader OAuth flow...');

    // First, delete existing credentials to force re-authentication
    await dockerService.execInContainer(
      `rm -f /opt/hytale/downloader/.hytale-downloader-credentials.json 2>/dev/null || true`
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
    const authResult = await dockerService.execInContainer(
      `cd /opt/hytale/downloader && timeout 60 gosu hytale ./hytale-downloader-linux-amd64 2>&1 || true`
    );

    const output = authResult.output || '';
    console.log('[Server] Downloader auth output:', output.substring(0, 1000));

    // Parse OAuth URLs from output
    // The downloader outputs: "Visit: https://oauth.accounts.hytale.com/oauth2/device/verify"
    // And a user code like: "Enter code: fHmkjxFE" or the code might be in the URL
    const urlMatch = output.match(/(https:\/\/oauth\.accounts\.hytale\.com\/[^\s\n\]]+)/i);

    // Try multiple patterns for the user code
    let userCode: string | null = null;
    const codePatterns = [
      /(?:enter\s+code|user_code|code)[:\s=]+([A-Za-z0-9]{6,12})/i,
      /user_code=([A-Za-z0-9]{6,12})/i,
      /\[([A-Za-z0-9]{8})\]/,  // Code might be in brackets
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
      if (output.includes('Downloading') || output.includes('already') || output.includes('authenticated') || output.includes('success')) {
        return res.json({
          success: true,
          alreadyAuthenticated: true,
          message: 'Downloader is already authenticated',
        });
      }

      // Maybe the downloader isn't installed or there's another issue
      return res.status(400).json({
        success: false,
        error: 'Could not parse OAuth URL from downloader output. The downloader may need to be reinstalled.',
        output: output.substring(0, 800),
      });
    }

    let verificationUrl = urlMatch[1].trim();

    // Clean up URL - remove any trailing characters that might have been captured
    verificationUrl = verificationUrl.replace(/[\]\)\}\s]+$/, '');

    // If URL doesn't have user_code, add it
    if (userCode && !verificationUrl.includes('user_code=')) {
      verificationUrl += verificationUrl.includes('?') ? `&user_code=${userCode}` : `?user_code=${userCode}`;
    }

    // Store state
    setDownloaderOAuthState({
      active: true,
      verificationUrl,
      userCode: userCode || undefined,
      expiresAt: new Date(Date.now() + 15 * 60 * 1000), // 15 minutes
    });

    res.json({
      success: true,
      verificationUrl,
      userCode,
      expiresIn: 900, // 15 minutes
    });
  } catch (error) {
    res.status(500).json({
      error: 'Failed to initiate downloader auth',
      message: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

// GET /api/server/downloader/auth-poll - Poll for auth completion
router.get('/downloader/auth-poll', authMiddleware, requirePermission('server.restart'), async (_req: Request, res: Response) => {
  try {
    if (!downloaderOAuthState.active) {
      return res.json({
        completed: false,
        error: 'No active auth flow',
      });
    }

    // Check if expired
    if (downloaderOAuthState.expiresAt && new Date() > downloaderOAuthState.expiresAt) {
      setDownloaderOAuthState({ active: false });
      return res.json({
        completed: false,
        expired: true,
        error: 'Auth flow expired',
      });
    }

    // Check if credentials now exist and work
    const credCheck = await checkDownloaderCredentials();
    if (credCheck.exists) {
      const testResult = await getLatestVersion('release');
      if (testResult.version !== 'unknown' && !testResult.authRequired) {
        setDownloaderOAuthState({ active: false });
        return res.json({
          completed: true,
          version: testResult.version,
        });
      }
    }

    res.json({
      completed: false,
      verificationUrl: downloaderOAuthState.verificationUrl,
      userCode: downloaderOAuthState.userCode,
    });
  } catch (error) {
    res.status(500).json({
      error: 'Failed to poll auth status',
      message: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

export default router;
