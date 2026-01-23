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

// In-memory state for OAuth device code flow
let downloaderAuthState: {
  deviceCode: string;
  verificationUrl: string;
  userCode: string;
  expiresAt: Date;
  pollInterval: number;
  authenticated: boolean;
} | null = null;

// In-memory state for download progress
let downloadState: {
  status: 'idle' | 'downloading' | 'complete' | 'error';
  serverJar: { percent: number; downloaded: number; total: number; complete: boolean };
  assetsZip: { percent: number; downloaded: number; total: number; speed: number; eta: number; complete: boolean };
  error?: string;
} = {
  status: 'idle',
  serverJar: { percent: 0, downloaded: 0, total: 0, complete: false },
  assetsZip: { percent: 0, downloaded: 0, total: 0, speed: 0, eta: 0, complete: false },
};

/**
 * POST /api/setup/download/auth/start
 * Start OAuth device code flow for Hytale downloader authentication
 *
 * Response:
 * {
 *   success: boolean,
 *   deviceCode?: string,
 *   verificationUrl?: string,
 *   userCode?: string,
 *   expiresIn?: number,
 *   pollInterval?: number,
 *   error?: string
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

    // For now, simulate OAuth device code flow
    // In production, this would call the actual Hytale OAuth API
    const deviceCode = `SETUP-${Date.now()}-${Math.random().toString(36).substring(7)}`;
    const userCode = Math.random().toString(36).substring(2, 8).toUpperCase();
    const expiresIn = 900; // 15 minutes
    const pollInterval = 5;

    downloaderAuthState = {
      deviceCode,
      verificationUrl: 'https://auth.hytale.com/device',
      userCode,
      expiresAt: new Date(Date.now() + expiresIn * 1000),
      pollInterval,
      authenticated: false,
    };

    // Auto-authenticate after 3 seconds for demo/development
    // In production, this would be triggered by the actual OAuth callback
    setTimeout(() => {
      if (downloaderAuthState && downloaderAuthState.deviceCode === deviceCode) {
        downloaderAuthState.authenticated = true;
        console.log('[Setup] Downloader auth auto-completed (demo mode)');
      }
    }, 3000);

    res.json({
      success: true,
      deviceCode,
      verificationUrl: downloaderAuthState.verificationUrl,
      userCode,
      expiresIn,
      pollInterval,
    });
  } catch (error) {
    console.error('[Setup] Failed to start downloader auth:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to start authentication',
      detail: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

/**
 * GET /api/setup/download/auth/status
 * Check downloader OAuth authentication status
 *
 * Response:
 * {
 *   authenticated: boolean,
 *   expired?: boolean,
 *   error?: string
 * }
 */
router.get('/download/auth/status', async (_req: Request, res: Response) => {
  try {
    if (!downloaderAuthState) {
      res.json({
        authenticated: false,
        error: 'No authentication in progress',
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

    res.json({
      authenticated: downloaderAuthState.authenticated,
      expired: false,
    });
  } catch (error) {
    console.error('[Setup] Failed to get downloader auth status:', error);
    res.status(500).json({
      authenticated: false,
      error: 'Failed to check authentication status',
    });
  }
});

/**
 * POST /api/setup/download/start
 * Start downloading server files
 *
 * Body:
 * { method: 'official' | 'custom', serverUrl?: string, assetsUrl?: string }
 *
 * Response:
 * { success: boolean, error?: string }
 */
router.post('/download/start', async (req: Request, res: Response) => {
  try {
    const { method, serverUrl, assetsUrl } = req.body;

    // Check if setup is already complete
    const complete = await isSetupComplete();
    if (complete) {
      res.status(400).json({
        success: false,
        error: 'Setup is already complete',
      });
      return;
    }

    // Reset download state
    downloadState = {
      status: 'downloading',
      serverJar: { percent: 0, downloaded: 0, total: 50 * 1024 * 1024, complete: false },
      assetsZip: { percent: 0, downloaded: 0, total: 500 * 1024 * 1024, speed: 0, eta: 0, complete: false },
    };

    // Simulate download progress for demo
    // In production, this would actually download the files
    const simulateDownload = async () => {
      // Simulate server JAR download (fast)
      for (let i = 0; i <= 100; i += 20) {
        await new Promise(resolve => setTimeout(resolve, 200));
        downloadState.serverJar.percent = i;
        downloadState.serverJar.downloaded = Math.floor(downloadState.serverJar.total * i / 100);
      }
      downloadState.serverJar.complete = true;

      // Simulate assets download (slower)
      for (let i = 0; i <= 100; i += 5) {
        await new Promise(resolve => setTimeout(resolve, 100));
        downloadState.assetsZip.percent = i;
        downloadState.assetsZip.downloaded = Math.floor(downloadState.assetsZip.total * i / 100);
        downloadState.assetsZip.speed = 10 * 1024 * 1024; // 10 MB/s
        downloadState.assetsZip.eta = Math.floor((100 - i) / 5);
      }
      downloadState.assetsZip.complete = true;
      downloadState.status = 'complete';
    };

    simulateDownload();

    console.log(`[Setup] Starting download with method: ${method}`);
    if (method === 'custom') {
      console.log(`[Setup] Custom URLs - Server: ${serverUrl}, Assets: ${assetsUrl}`);
    }

    res.json({
      success: true,
    });
  } catch (error) {
    console.error('[Setup] Failed to start download:', error);
    downloadState.status = 'error';
    downloadState.error = error instanceof Error ? error.message : 'Unknown error';
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
 * Server-Sent Events endpoint for download progress
 *
 * Response: SSE stream with download progress objects
 */
router.get('/download/progress', (req: Request, res: Response) => {
  // Set headers for SSE
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');

  const sendProgress = () => {
    if (downloadState.serverJar.percent < 100) {
      res.write(`data: ${JSON.stringify({
        type: 'progress',
        currentFile: 'HytaleServer.jar',
        percent: downloadState.serverJar.percent,
        bytesDone: downloadState.serverJar.downloaded,
        bytesTotal: downloadState.serverJar.total,
      })}\n\n`);
    } else if (downloadState.assetsZip.percent < 100) {
      res.write(`data: ${JSON.stringify({
        type: 'progress',
        currentFile: 'Assets.zip',
        percent: downloadState.assetsZip.percent,
        bytesDone: downloadState.assetsZip.downloaded,
        bytesTotal: downloadState.assetsZip.total,
        bytesPerSecond: downloadState.assetsZip.speed,
        estimatedSeconds: downloadState.assetsZip.eta,
      })}\n\n`);
    } else if (downloadState.status === 'complete') {
      res.write(`data: ${JSON.stringify({ type: 'complete' })}\n\n`);
      clearInterval(interval);
      res.end();
      return;
    } else if (downloadState.status === 'error') {
      res.write(`data: ${JSON.stringify({ type: 'error', error: downloadState.error })}\n\n`);
      clearInterval(interval);
      res.end();
      return;
    }
  };

  sendProgress();
  const interval = setInterval(sendProgress, 500);

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
