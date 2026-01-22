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

/**
 * GET /api/setup/download/status
 * Server-Sent Events endpoint for download progress
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
