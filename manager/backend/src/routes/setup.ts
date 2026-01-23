import { Router, Request, Response } from 'express';
import rateLimit from 'express-rate-limit';
import {
  isSetupComplete,
  getSetupStatus,
  saveStepData,
  finalizeSetup,
  getExtractionProgress,
  startAssetsExtraction,
  getDownloadProgress,
  getAuthStatusForSetup,
  resetSetup,
} from '../services/setupService.js';
import { runSystemChecks, runSingleCheck } from '../services/systemCheck.js';

const router = Router();

// Rate limiting for setup endpoints to prevent abuse
const setupLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 60, // 60 requests per minute
  message: { detail: 'Too many setup requests, please slow down' },
  standardHeaders: true,
  legacyHeaders: false,
});

// Apply rate limiting to all setup routes
router.use(setupLimiter);

/**
 * GET /api/setup/status
 * Check if setup is complete and get current setup state
 *
 * Response:
 * {
 *   setupComplete: boolean,
 *   currentStep: number,
 *   totalSteps: number,
 *   stepsCompleted: string[],
 *   config?: Partial<SetupConfig>
 * }
 */
router.get('/status', async (_req: Request, res: Response) => {
  try {
    const status = await getSetupStatus();
    res.json(status);
  } catch (error) {
    console.error('[Setup] Failed to get status:', error);
    res.status(500).json({
      error: 'Failed to get setup status',
      detail: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

/**
 * GET /api/setup/check
 * Quick check if setup is complete (lightweight endpoint for middleware)
 *
 * Response:
 * { setupComplete: boolean }
 */
router.get('/check', async (_req: Request, res: Response) => {
  try {
    const complete = await isSetupComplete();
    res.json({ setupComplete: complete });
  } catch (error) {
    // On error, assume setup is not complete
    console.error('[Setup] Check failed:', error);
    res.json({ setupComplete: false });
  }
});

/**
 * GET /api/setup/system-check
 * Run all system checks and return results
 *
 * Response:
 * {
 *   checks: SystemCheck[],
 *   canProceed: boolean
 * }
 */
router.get('/system-check', async (_req: Request, res: Response) => {
  try {
    const result = await runSystemChecks();
    res.json(result);
  } catch (error) {
    console.error('[Setup] System check failed:', error);
    res.status(500).json({
      error: 'System check failed',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

/**
 * GET /api/setup/system-check/:checkId
 * Run a single system check by ID
 *
 * Params:
 * - checkId: The ID of the check to run (e.g., 'docker_socket', 'port_5520', 'disk_space')
 *
 * Response:
 * SystemCheck object or 404 if check not found
 */
router.get('/system-check/:checkId', async (req: Request, res: Response) => {
  try {
    const { checkId } = req.params;
    const result = await runSingleCheck(checkId);

    if (!result) {
      res.status(404).json({
        error: 'Check not found',
        message: `No system check found with ID: ${checkId}`,
      });
      return;
    }

    res.json(result);
  } catch (error) {
    console.error('[Setup] Single system check failed:', error);
    res.status(500).json({
      error: 'System check failed',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

/**
 * POST /api/setup/step/:stepId
 * Save step data for a specific setup step
 *
 * Params:
 * - stepId: The step identifier
 *
 * Body:
 * Step-specific data object
 *
 * Response:
 * { success: boolean, nextStep: string, error?: string }
 */
router.post('/step/:stepId', async (req: Request, res: Response) => {
  try {
    const { stepId } = req.params;
    const data = req.body;

    // Validate stepId
    const validSteps = [
      'system-check',
      'language',
      'admin-account',
      'download-method',
      'download',
      'assets-extract',
      'server-auth',
      'server-config',
      'automation',
      'performance',
      'plugin',
      'integrations',
      'network',
      'summary',
    ];

    if (!validSteps.includes(stepId)) {
      res.status(400).json({
        success: false,
        error: 'Invalid step ID',
        validSteps,
      });
      return;
    }

    // Check if setup is already complete
    const complete = await isSetupComplete();
    if (complete) {
      res.status(400).json({
        success: false,
        error: 'Setup is already complete',
      });
      return;
    }

    const result = await saveStepData(stepId, data);

    if (!result.success) {
      res.status(400).json(result);
      return;
    }

    res.json(result);
  } catch (error) {
    console.error('[Setup] Failed to save step data:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to save step data',
      detail: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

/**
 * POST /api/setup/admin
 * Create admin account (Phase 2)
 *
 * Request body:
 * { username: string, password: string }
 *
 * Response:
 * { success: boolean, error?: string }
 */
router.post('/admin', async (req: Request, res: Response) => {
  try {
    const { username, password } = req.body;

    // Validate username
    if (!username || typeof username !== 'string') {
      res.status(400).json({
        success: false,
        error: 'Username is required',
      });
      return;
    }

    if (username.length < 3 || username.length > 32) {
      res.status(400).json({
        success: false,
        error: 'Username must be between 3 and 32 characters',
      });
      return;
    }

    if (!/^[a-zA-Z0-9_]+$/.test(username)) {
      res.status(400).json({
        success: false,
        error: 'Username can only contain letters, numbers, and underscores',
      });
      return;
    }

    // Validate password
    if (!password || typeof password !== 'string') {
      res.status(400).json({
        success: false,
        error: 'Password is required',
      });
      return;
    }

    if (password.length < 12) {
      res.status(400).json({
        success: false,
        error: 'Password must be at least 12 characters',
      });
      return;
    }

    // Check if setup is already complete
    const complete = await isSetupComplete();
    if (complete) {
      res.status(400).json({
        success: false,
        error: 'Setup is already complete',
      });
      return;
    }

    // Save admin account data (password will be hashed during finalization)
    const result = await saveStepData('admin-account', { username, password });

    if (!result.success) {
      res.status(400).json(result);
      return;
    }

    res.json({
      success: true,
    });
  } catch (error) {
    console.error('[Setup] Failed to create admin account:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to create admin account',
      detail: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

/**
 * POST /api/setup/complete
 * Finalize setup - creates admin user, generates JWT secret, writes final config
 *
 * Response:
 * { success: boolean, message?: string, redirectUrl?: string, error?: string }
 */
router.post('/complete', async (_req: Request, res: Response) => {
  try {
    // Check if setup is already complete
    const complete = await isSetupComplete();
    if (complete) {
      res.status(400).json({
        success: false,
        error: 'Setup is already complete',
      });
      return;
    }

    const result = await finalizeSetup();

    if (!result.success) {
      res.status(400).json(result);
      return;
    }

    res.json({
      success: true,
      message: 'Setup completed successfully',
      redirectUrl: '/login',
      // Note: In production, jwtSecret should be written to a secure config
      // and the user should be instructed to set JWT_SECRET env var
      jwtSecretGenerated: true,
    });
  } catch (error) {
    console.error('[Setup] Failed to complete setup:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to complete setup',
      detail: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

// ==========================================
// Download Flow Endpoints
// ==========================================

import {
  getStatus as getDockerStatus,
  getLogs,
  restartContainer,
  startContainer
} from '../services/docker.js';

// In-memory state for OAuth device code flow (parsed from container logs)
let downloaderAuthState: {
  verificationUrl: string;
  userCode: string;
  expiresAt: Date;
  authenticated: boolean;
  downloadStarted: boolean;
  downloadComplete: boolean;
} | null = null;

// Parse OAuth info from container logs
function parseOAuthFromLogs(logs: string): { verificationUrl?: string; userCode?: string; authenticated?: boolean; downloadComplete?: boolean } {
  const result: { verificationUrl?: string; userCode?: string; authenticated?: boolean; downloadComplete?: boolean } = {};

  // Look for the OAuth URL pattern from Hytale downloader
  // Format varies, but typically contains something like:
  // "Open URL: https://..." or "Visit: https://..."
  const urlMatch = logs.match(/(?:Open|Visit|Go to)[:\s]+?(https:\/\/[^\s\n]+)/i);
  if (urlMatch) {
    result.verificationUrl = urlMatch[1];
  }

  // Look for user code - typically 6-8 character alphanumeric
  // Format: "Enter code: ABCD1234" or "Code: ABCD-1234"
  const codeMatch = logs.match(/(?:Enter\s+)?[Cc]ode[:\s]+([A-Z0-9]{4,8}(?:-[A-Z0-9]{4})?)/);
  if (codeMatch) {
    result.userCode = codeMatch[1];
  }

  // Check if authentication succeeded
  if (logs.includes('Download successful') || logs.includes('Authentication successful') || logs.includes('Credentials saved')) {
    result.authenticated = true;
  }

  // Check if download completed
  if (logs.includes('Extraction complete') || logs.includes('Server files verified')) {
    result.downloadComplete = true;
  }

  return result;
}

/**
 * POST /api/setup/download/auth/start
 * Start the download process - this restarts the game container with USE_HYTALE_DOWNLOADER
 *
 * Response:
 * {
 *   success: boolean,
 *   deviceCode?: string,
 *   verificationUrl?: string,
 *   userCode?: string,
 *   expiresIn?: number,
 *   pollInterval?: number,
 *   error?: string,
 *   needsEnvConfig?: boolean
 * }
 */
router.post('/download/auth/start', async (_req: Request, res: Response) => {
  try {
    // Check if setup is already complete
    const complete = await isSetupComplete();
    if (complete) {
      res.status(400).json({
        success: false,
        error: 'Setup is already complete',
      });
      return;
    }

    // Check if game container is running
    const containerStatus = await getDockerStatus();
    if (containerStatus.status === 'not_found') {
      res.status(400).json({
        success: false,
        error: 'Game container not found. Make sure docker-compose is running.',
      });
      return;
    }

    // Reset auth state
    downloaderAuthState = {
      verificationUrl: '',
      userCode: '',
      expiresAt: new Date(Date.now() + 15 * 60 * 1000), // 15 minutes
      authenticated: false,
      downloadStarted: false,
      downloadComplete: false,
    };

    // If container is not running, start it
    if (!containerStatus.running) {
      console.log('[Setup] Starting game container for download...');
      await startContainer();

      // Wait a bit for container to start
      await new Promise(resolve => setTimeout(resolve, 3000));
    }

    // Poll logs for OAuth info (initial check)
    const logs = await getLogs(200);
    const oauthInfo = parseOAuthFromLogs(logs);

    if (oauthInfo.verificationUrl) {
      downloaderAuthState.verificationUrl = oauthInfo.verificationUrl;
    }
    if (oauthInfo.userCode) {
      downloaderAuthState.userCode = oauthInfo.userCode;
    }
    if (oauthInfo.authenticated) {
      downloaderAuthState.authenticated = true;
    }
    if (oauthInfo.downloadComplete) {
      downloaderAuthState.downloadComplete = true;
    }

    // Check if USE_HYTALE_DOWNLOADER might not be set
    if (logs.includes('SERVER FILES NOT FOUND') && !logs.includes('AUTHENTICATION REQUIRED')) {
      res.json({
        success: false,
        needsEnvConfig: true,
        error: 'USE_HYTALE_DOWNLOADER=true is not set. Please add it to your .env file and restart containers with docker-compose up -d',
        instructions: [
          '1. Add USE_HYTALE_DOWNLOADER=true to your .env file',
          '2. Run: docker-compose down && docker-compose up -d',
          '3. Then retry the download'
        ],
      });
      return;
    }

    res.json({
      success: true,
      deviceCode: 'container-oauth',
      verificationUrl: downloaderAuthState.verificationUrl || 'Checking container logs...',
      userCode: downloaderAuthState.userCode || 'Waiting for code...',
      expiresIn: 900,
      pollInterval: 3,
    });
  } catch (error) {
    console.error('[Setup] Failed to start download auth:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to start download process',
      detail: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

/**
 * GET /api/setup/download/auth/status
 * Check downloader OAuth authentication status by monitoring container logs
 *
 * Response:
 * {
 *   authenticated: boolean,
 *   expired?: boolean,
 *   error?: string,
 *   verificationUrl?: string,
 *   userCode?: string,
 *   downloadComplete?: boolean
 * }
 */
router.get('/download/auth/status', async (_req: Request, res: Response) => {
  try {
    if (!downloaderAuthState) {
      res.json({
        authenticated: false,
        error: 'No download in progress. Start the download first.',
      });
      return;
    }

    // Check if expired
    if (new Date() > downloaderAuthState.expiresAt) {
      res.json({
        authenticated: false,
        expired: true,
      });
      return;
    }

    // Poll container logs for updates
    const logs = await getLogs(300);
    const oauthInfo = parseOAuthFromLogs(logs);

    // Update state with new info
    if (oauthInfo.verificationUrl && !downloaderAuthState.verificationUrl) {
      downloaderAuthState.verificationUrl = oauthInfo.verificationUrl;
    }
    if (oauthInfo.userCode && !downloaderAuthState.userCode) {
      downloaderAuthState.userCode = oauthInfo.userCode;
    }
    if (oauthInfo.authenticated) {
      downloaderAuthState.authenticated = true;
    }
    if (oauthInfo.downloadComplete) {
      downloaderAuthState.downloadComplete = true;
    }

    res.json({
      authenticated: downloaderAuthState.authenticated,
      expired: false,
      verificationUrl: downloaderAuthState.verificationUrl,
      userCode: downloaderAuthState.userCode,
      downloadComplete: downloaderAuthState.downloadComplete,
    });
  } catch (error) {
    console.error('[Setup] Failed to get download auth status:', error);
    res.status(500).json({
      authenticated: false,
      error: 'Failed to check download status',
    });
  }
});

/**
 * POST /api/setup/download/start
 * Start downloading server files (container should already be running with USE_HYTALE_DOWNLOADER)
 *
 * Body:
 * { method: 'official' | 'custom', serverUrl?: string, assetsUrl?: string }
 *
 * Response:
 * { success: boolean, error?: string }
 */
router.post('/download/start', async (req: Request, res: Response) => {
  try {
    const { method } = req.body;

    // Check if setup is already complete
    const complete = await isSetupComplete();
    if (complete) {
      res.status(400).json({
        success: false,
        error: 'Setup is already complete',
      });
      return;
    }

    console.log(`[Setup] Download method selected: ${method}`);

    if (method === 'official') {
      // For official download, the container should already be handling it
      // Just confirm it's running
      const containerStatus = await getDockerStatus();
      if (!containerStatus.running) {
        await startContainer();
      }

      res.json({
        success: true,
        message: 'Download in progress via game container',
      });
    } else if (method === 'custom') {
      // Custom URLs would need to be set via environment variables
      // For now, inform user to set them manually
      res.json({
        success: false,
        error: 'Custom URLs must be set in docker-compose.yml or .env file',
        instructions: [
          'Add to .env:',
          '  SERVER_JAR_URL=https://your-url/HytaleServer.jar',
          '  ASSETS_URL=https://your-url/Assets.zip',
          'Then restart: docker-compose up -d'
        ],
      });
    } else {
      res.json({ success: true });
    }
  } catch (error) {
    console.error('[Setup] Failed to start download:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to start download',
      detail: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

/**
 * GET /api/setup/download/verify
 * Verify downloaded server files
 *
 * Response:
 * {
 *   success: boolean,
 *   serverJarSize?: string,
 *   serverJarIntegrity?: boolean,
 *   assetsZipSize?: string,
 *   assetsZipIntegrity?: boolean,
 *   version?: string,
 *   patchline?: string,
 *   error?: string
 * }
 */
router.get('/download/verify', async (_req: Request, res: Response) => {
  try {
    const { config } = await import('../config.js');
    const fs = await import('fs/promises');
    const path = await import('path');

    const serverJarPath = path.join(config.serverPath, 'HytaleServer.jar');
    const assetsZipPath = path.join(config.serverPath, 'Assets.zip');

    let serverJarSize = '0 B';
    let serverJarIntegrity = false;
    let assetsZipSize = '0 B';
    let assetsZipIntegrity = false;

    // Check server JAR
    try {
      const serverJarStat = await fs.stat(serverJarPath);
      serverJarSize = formatBytes(serverJarStat.size);
      serverJarIntegrity = serverJarStat.size > 0;
    } catch {
      // File doesn't exist
    }

    // Check assets ZIP
    try {
      const assetsZipStat = await fs.stat(assetsZipPath);
      assetsZipSize = formatBytes(assetsZipStat.size);
      assetsZipIntegrity = assetsZipStat.size > 0;
    } catch {
      // File doesn't exist
    }

    res.json({
      success: serverJarIntegrity || assetsZipIntegrity,
      serverJarSize,
      serverJarIntegrity,
      assetsZipSize,
      assetsZipIntegrity,
      version: '2.0.x',
      patchline: 'release',
    });
  } catch (error) {
    console.error('[Setup] Failed to verify download:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to verify downloaded files',
      detail: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

// Helper function to format bytes
function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(1))} ${sizes[i]}`;
}

/**
 * GET /api/setup/download/progress
 * Server-Sent Events endpoint for download progress (monitors container logs)
 *
 * Response: SSE stream with download progress objects
 */
router.get('/download/progress', (req: Request, res: Response) => {
  // Set headers for SSE
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');

  const sendProgress = async () => {
    try {
      const logs = await getLogs(100);
      const oauthInfo = parseOAuthFromLogs(logs);

      // Parse download progress from logs if available
      const progressMatch = logs.match(/(\d+(?:\.\d+)?)\s*%/);
      const percent = progressMatch ? parseFloat(progressMatch[1]) : 0;

      if (oauthInfo.downloadComplete) {
        res.write(`data: ${JSON.stringify({ type: 'complete' })}\n\n`);
        clearInterval(interval);
        res.end();
        return;
      }

      res.write(`data: ${JSON.stringify({
        type: 'progress',
        currentFile: oauthInfo.authenticated ? 'Downloading...' : 'Waiting for authentication...',
        percent: percent,
        authenticated: oauthInfo.authenticated,
        verificationUrl: oauthInfo.verificationUrl,
        userCode: oauthInfo.userCode,
      })}\n\n`);
    } catch (error) {
      res.write(`data: ${JSON.stringify({ type: 'error', error: 'Failed to get progress' })}\n\n`);
    }
  };

  sendProgress();
  const interval = setInterval(sendProgress, 2000);

  req.on('close', () => {
    clearInterval(interval);
  });
});

/**
 * GET /api/setup/download/status
 * Server-Sent Events endpoint for download progress (legacy)
 *
 * Response: SSE stream with DownloadProgress objects
 */
router.get('/download/status', (req: Request, res: Response) => {
  // Set headers for SSE
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no'); // Disable nginx buffering

  // Send initial status
  const sendStatus = () => {
    const progress = getDownloadProgress();
    res.write(`data: ${JSON.stringify(progress)}\n\n`);
  };

  // Send status immediately
  sendStatus();

  // Send updates every second
  const interval = setInterval(sendStatus, 1000);

  // Clean up on connection close
  req.on('close', () => {
    clearInterval(interval);
  });
});

/**
 * GET /api/setup/auth/status
 * Get Hytale authentication status (downloader + server)
 *
 * Response:
 * {
 *   downloaderAuth: { authenticated: boolean, username?: string },
 *   serverAuth: { authenticated: boolean, persistent: boolean }
 * }
 */
router.get('/auth/status', async (_req: Request, res: Response) => {
  try {
    const status = await getAuthStatusForSetup();
    res.json(status);
  } catch (error) {
    console.error('[Setup] Failed to get auth status:', error);
    res.status(500).json({
      error: 'Failed to get auth status',
      detail: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

/**
 * POST /api/setup/assets/extract
 * Start assets extraction process
 *
 * Response:
 * { success: boolean, message?: string, error?: string }
 */
router.post('/assets/extract', async (_req: Request, res: Response) => {
  try {
    // Check if setup is already complete
    const complete = await isSetupComplete();
    if (complete) {
      res.status(400).json({
        success: false,
        error: 'Setup is already complete',
      });
      return;
    }

    const result = await startAssetsExtraction();

    if (!result.success) {
      res.status(400).json(result);
      return;
    }

    res.json({
      success: true,
      message: 'Asset extraction started',
    });
  } catch (error) {
    console.error('[Setup] Failed to start asset extraction:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to start asset extraction',
      detail: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

/**
 * GET /api/setup/assets/status
 * Server-Sent Events endpoint for extraction progress
 *
 * Response: SSE stream with ExtractionProgress objects
 */
router.get('/assets/status', (req: Request, res: Response) => {
  // Set headers for SSE
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no'); // Disable nginx buffering

  // Send initial status
  const sendStatus = () => {
    const progress = getExtractionProgress();
    res.write(`data: ${JSON.stringify(progress)}\n\n`);

    // If extraction is complete or errored, close the connection after a short delay
    if (progress.status === 'complete' || progress.status === 'error') {
      setTimeout(() => {
        clearInterval(interval);
        res.end();
      }, 1000);
    }
  };

  // Send status immediately
  sendStatus();

  // Send updates every second
  const interval = setInterval(sendStatus, 1000);

  // Clean up on connection close
  req.on('close', () => {
    clearInterval(interval);
  });
});

/**
 * GET /api/setup/detect-ip
 * Detect the server's local IP address for LAN access
 *
 * Response:
 * { ip: string | null, port: number, panelUrl: string }
 */
router.get('/detect-ip', async (req: Request, res: Response) => {
  try {
    const os = await import('os');
    const { config } = await import('../config.js');

    // Get all network interfaces
    const interfaces = os.networkInterfaces();
    let detectedIp: string | null = null;

    // Find the first non-internal IPv4 address
    for (const name of Object.keys(interfaces)) {
      const nets = interfaces[name];
      if (!nets) continue;

      for (const net of nets) {
        // Skip internal and non-IPv4 addresses
        if (net.internal || net.family !== 'IPv4') continue;

        // Prefer addresses in common private ranges
        if (net.address.startsWith('192.168.') ||
            net.address.startsWith('10.') ||
            net.address.match(/^172\.(1[6-9]|2[0-9]|3[0-1])\./)) {
          detectedIp = net.address;
          break;
        }
      }
      if (detectedIp) break;
    }

    // Fallback: use the x-forwarded-for header if behind proxy
    if (!detectedIp && req.headers['x-forwarded-for']) {
      const forwarded = req.headers['x-forwarded-for'];
      const ip = Array.isArray(forwarded) ? forwarded[0] : forwarded.split(',')[0];
      if (ip && !ip.startsWith('127.') && !ip.startsWith('::')) {
        detectedIp = ip.trim();
      }
    }

    const port = config.externalPort;
    const panelUrl = detectedIp ? `http://${detectedIp}:${port}` : `http://localhost:${port}`;

    res.json({
      ip: detectedIp,
      port,
      panelUrl,
      serverPort: config.serverPort,
      interfaces: Object.keys(interfaces),
    });
  } catch (error) {
    console.error('[Setup] Failed to detect IP:', error);
    res.status(500).json({
      error: 'Failed to detect IP address',
      ip: null,
      port: 18080,
    });
  }
});

/**
 * GET /api/setup/server-info
 * Get server configuration info for the setup wizard
 *
 * Response:
 * { port: number, serverPort: number, gameContainerName: string }
 */
router.get('/server-info', async (_req: Request, res: Response) => {
  try {
    const { config } = await import('../config.js');

    res.json({
      managerPort: config.externalPort,
      serverPort: config.serverPort,
      gameContainerName: config.gameContainerName,
      serverPath: config.serverPath,
      dataPath: config.dataPath,
      hostDataPath: config.hostDataPath,
    });
  } catch (error) {
    console.error('[Setup] Failed to get server info:', error);
    res.status(500).json({
      error: 'Failed to get server info',
    });
  }
});

/**
 * POST /api/setup/reset
 * Reset setup (development only)
 * This endpoint is protected and only works in development mode
 *
 * Response:
 * { success: boolean, message?: string, error?: string }
 */
router.post('/reset', async (_req: Request, res: Response) => {
  // Only allow in development mode
  if (process.env.NODE_ENV === 'production') {
    res.status(403).json({
      success: false,
      error: 'Setup reset is not allowed in production',
    });
    return;
  }

  try {
    const result = await resetSetup();

    if (!result.success) {
      res.status(400).json(result);
      return;
    }

    res.json({
      success: true,
      message: 'Setup has been reset',
    });
  } catch (error) {
    console.error('[Setup] Failed to reset setup:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to reset setup',
      detail: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

export default router;
