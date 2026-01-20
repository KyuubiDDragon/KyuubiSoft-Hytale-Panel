import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import compression from 'compression';
import { createServer } from 'http';
import { WebSocketServer } from 'ws';
import path from 'path';
import { fileURLToPath } from 'url';
import { access, constants, writeFile as fsWriteFile, unlink } from 'fs/promises';
import { randomBytes } from 'crypto';
import { createProxyMiddleware } from 'http-proxy-middleware';

import { config, checkSecurityConfig } from './config.js';
import { setupWebSocket } from './websocket.js';

// Routes
import authRoutes from './routes/auth.js';
import serverRoutes from './routes/server.js';
import consoleRoutes from './routes/console.js';
import backupRoutes from './routes/backup.js';
import playersRoutes from './routes/players.js';
import managementRoutes from './routes/management.js';
import schedulerRoutes from './routes/scheduler.js';
import assetsRoutes from './routes/assets.js';
import rolesRouter from './routes/roles.js';

// Services
import { startSchedulers } from './services/scheduler.js';
import { initializePlayerTracking } from './services/players.js';
import { initializePluginEvents, disconnectFromPluginWebSocket } from './services/pluginEvents.js';
import { initializeRoles } from './services/roles.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const server = createServer(app);

// Reverse Proxy Support - must be set before other middleware
// This enables proper handling of X-Forwarded-* headers when behind nginx, traefik, etc.
if (config.trustProxy) {
  app.set('trust proxy', 1);
  console.log('Reverse proxy mode enabled (TRUST_PROXY=true)');
}

// WebSocket server
const wss = new WebSocketServer({ server, path: '/api/console/ws' });
setupWebSocket(wss);

// WebMap Proxy - MUST be mounted BEFORE helmet so our CSP doesn't affect WebMap content
// The WebMap loads Leaflet from unpkg.com CDN which would be blocked by our CSP
const webMapProxyOptions = {
  target: `http://${config.gameContainerName}:18081`,
  changeOrigin: true,
  ws: true, // Enable WebSocket proxying
  on: {
    error: (err: Error, _req: unknown, res: unknown) => {
      console.error('[WebMap Proxy] Error:', err.message);
      if (res && typeof res === 'object' && 'writeHead' in res && typeof (res as { writeHead: unknown }).writeHead === 'function') {
        const httpRes = res as { writeHead: (code: number, headers: Record<string, string>) => void; end: (data: string) => void };
        httpRes.writeHead(502, { 'Content-Type': 'application/json' });
        httpRes.end(JSON.stringify({ error: 'WebMap unavailable', detail: err.message }));
      }
    },
    // Remove restrictive headers from WebMap response
    proxyRes: (proxyRes: { headers: Record<string, unknown> }) => {
      delete proxyRes.headers['content-security-policy'];
      delete proxyRes.headers['x-frame-options'];
    },
  },
};

// Main WebMap proxy (for iframe content)
const webMapProxy = createProxyMiddleware({
  ...webMapProxyOptions,
  pathRewrite: {
    '^/api/webmap': '', // Remove /api/webmap prefix when forwarding
  },
});
app.use('/api/webmap', webMapProxy);

// WebMap API proxies - The WebMap JavaScript uses absolute paths for its API calls
// These routes don't conflict with our panel routes (auth, server, console, etc.)
const webMapApiProxy = createProxyMiddleware(webMapProxyOptions);
app.use('/api/worlds', webMapApiProxy);  // WebMap world list API
app.use('/api/tiles', webMapApiProxy);   // WebMap tile batch API

// WebMap WebSocket proxy at /ws (WebMap uses this for live updates)
const webMapWsProxy = createProxyMiddleware({
  ...webMapProxyOptions,
  ws: true,
});
app.use('/ws', webMapWsProxy);

// Handle WebSocket upgrade for /ws path
server.on('upgrade', (request, socket, head) => {
  const pathname = request.url || '';
  if (pathname === '/ws' || pathname.startsWith('/ws?')) {
    // Cast Duplex to Socket for http-proxy-middleware compatibility
    webMapWsProxy.upgrade?.(request, socket as import('net').Socket, head);
  }
  // Note: /api/console/ws is handled by our own WebSocketServer
});

// Middleware
// SECURITY: Configure Content-Security-Policy for SPA
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-eval'"], // Vue.js needs unsafe-eval for template compilation
      styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"], // Vue/CSS-in-JS + Google Fonts
      imgSrc: ["'self'", "data:", "blob:", "https://cdn.modtale.net", "https://stackmart.org"], // Allow data URIs, Modtale CDN and StackMart
      fontSrc: ["'self'", "data:", "https://fonts.gstatic.com"], // Google Fonts
      connectSrc: ["'self'", "ws:", "wss:"], // Allow WebSocket connections
      frameSrc: ["'self'", "https:", "http:"], // Allow embedding web map iframe from external sources
      objectSrc: ["'none'"],
      baseUri: ["'self'"],
      formAction: ["'self'"],
      frameAncestors: ["'none'"], // Prevent clickjacking
      // Note: upgradeInsecureRequests removed - only use if running behind HTTPS proxy
    },
  },
  // Additional security headers
  crossOriginEmbedderPolicy: false, // Disable for compatibility with external resources
  crossOriginOpenerPolicy: false, // Disable for HTTP compatibility
  crossOriginResourcePolicy: { policy: 'cross-origin' }, // Allow loading cross-origin resources
}));
app.use(compression());

// CORS configuration - must be explicitly set
const corsOrigins = config.corsOrigins
  ? (config.corsOrigins === '*' ? '*' : config.corsOrigins.split(',').map(o => o.trim()))
  : false; // Disable CORS if not configured (same-origin only)

app.use(cors({
  origin: corsOrigins,
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-CSRF-Token'],
}));

// CSRF Protection via Origin/Referer validation for state-changing requests
app.use((req, res, next) => {
  // Skip for safe methods
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
    return next();
  }

  // Skip for non-API routes (static files)
  if (!req.path.startsWith('/api/')) {
    return next();
  }

  // Get origin from headers
  const origin = req.headers.origin;
  const referer = req.headers.referer;

  // If no origin header, check referer (some browsers don't send origin)
  const requestOrigin = origin || (referer ? new URL(referer).origin : null);

  // Allow same-origin requests (no origin header means same-origin in most cases)
  if (!requestOrigin) {
    // For security, require origin header for cross-origin requests
    // Same-origin requests from browsers typically don't include Origin for non-CORS
    return next();
  }

  // Validate origin against allowed CORS origins
  if (config.corsOrigins === '*') {
    // Wildcard CORS - allow but log warning
    return next();
  }

  const allowedOrigins = config.corsOrigins.split(',').map(o => o.trim());

  // Also allow requests from the server's own origin (same-origin)
  const host = req.headers.host;
  const protocol = req.secure || req.headers['x-forwarded-proto'] === 'https' ? 'https' : 'http';
  const serverOrigin = `${protocol}://${host}`;

  if (allowedOrigins.includes(requestOrigin) || requestOrigin === serverOrigin) {
    return next();
  }

  // Origin mismatch - potential CSRF
  console.warn(`CSRF: Blocked request from origin ${requestOrigin} to ${req.path}`);
  res.status(403).json({ error: 'CSRF validation failed', detail: 'Origin not allowed' });
});

// SECURITY: Limit JSON body size to prevent memory exhaustion attacks
app.use(express.json({ limit: '100kb' }));

// API Routes
app.use('/api/auth', authRoutes);
app.use('/api/server', serverRoutes);
app.use('/api/console', consoleRoutes);
app.use('/api/backups', backupRoutes);
app.use('/api/players', playersRoutes);
app.use('/api/management', managementRoutes);
app.use('/api/scheduler', schedulerRoutes);
app.use('/api/assets', assetsRoutes);
app.use('/api/roles', rolesRouter);

// Health check
app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', service: 'hytale-manager' });
});

// Permission health check - checks if data directories are writable
// Used to warn users about permission issues after upgrading to non-root container
interface PermissionCheckResult {
  path: string;
  name: string;
  readable: boolean;
  writable: boolean;
  error?: string;
}

interface PermissionHealthResponse {
  ok: boolean;
  issues: PermissionCheckResult[];
  message?: string;
}

app.get('/api/health/permissions', async (_req, res) => {
  const pathsToCheck = [
    { path: config.serverPath, name: 'Server' },
    { path: config.backupsPath, name: 'Backups' },
    { path: config.dataPath, name: 'Data' },
    { path: config.modsPath, name: 'Mods' },
    { path: config.pluginsPath, name: 'Plugins' },
  ];

  const results: PermissionCheckResult[] = [];
  let hasIssues = false;

  for (const { path: dirPath, name } of pathsToCheck) {
    const result: PermissionCheckResult = {
      path: dirPath,
      name,
      readable: false,
      writable: false,
    };

    try {
      // Check if directory is readable
      await access(dirPath, constants.R_OK);
      result.readable = true;

      // Check if directory is writable by actually trying to write a temp file
      const testFile = path.join(dirPath, `.perm-test-${randomBytes(4).toString('hex')}`);
      try {
        await fsWriteFile(testFile, 'test', 'utf-8');
        await unlink(testFile);
        result.writable = true;
      } catch (writeErr) {
        result.writable = false;
        result.error = `Cannot write: ${writeErr instanceof Error ? writeErr.message : 'Unknown error'}`;
        hasIssues = true;
      }
    } catch (readErr) {
      result.readable = false;
      result.error = `Cannot access: ${readErr instanceof Error ? readErr.message : 'Unknown error'}`;
      hasIssues = true;
    }

    results.push(result);
  }

  const response: PermissionHealthResponse = {
    ok: !hasIssues,
    issues: results.filter(r => !r.readable || !r.writable),
  };

  if (hasIssues) {
    response.message = `Some directories have permission issues. This may happen after upgrading to v2.0.0 which runs as non-root. Run: sudo chown -R 1001:1001 ${config.hostDataPath}`;
  }

  res.json(response);
});

// Serve static frontend files
const staticPath = path.join(__dirname, '..', 'static');
app.use('/assets', express.static(path.join(staticPath, 'assets')));
// Serve root-level static files (logo.png, favicon.svg, etc.)
app.use(express.static(staticPath, { index: false }));

// SPA fallback - serve index.html for all non-API routes
app.get('*', (req, res) => {
  // Don't serve index.html for API routes
  if (req.path.startsWith('/api/')) {
    res.status(404).json({ error: 'Not found' });
    return;
  }

  const indexPath = path.join(staticPath, 'index.html');
  res.sendFile(indexPath, (err) => {
    if (err) {
      res.status(404).json({ error: 'Frontend not found' });
    }
  });
});

// SECURITY: Global error handler - catches all unhandled errors in routes
// Prevents stack traces from leaking to clients in production
app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  // Log the full error for debugging
  console.error('[ERROR]', err.stack || err.message || err);

  // Check if headers already sent
  if (res.headersSent) {
    return;
  }

  // Determine if we should expose error details
  const isDev = process.env.NODE_ENV !== 'production';

  // Handle known error types
  if (err.name === 'UnauthorizedError') {
    res.status(401).json({ error: 'Unauthorized', detail: 'Invalid or expired token' });
    return;
  }

  if (err.name === 'ValidationError') {
    res.status(400).json({ error: 'Validation failed', detail: isDev ? err.message : 'Invalid input' });
    return;
  }

  // Generic server error - don't expose internal details in production
  res.status(500).json({
    error: 'Internal server error',
    detail: isDev ? err.message : 'An unexpected error occurred',
  });
});

// SECURITY: Handle uncaught exceptions at process level
process.on('uncaughtException', (err) => {
  console.error('[FATAL] Uncaught Exception:', err);
  // Give time for logging then exit
  setTimeout(() => process.exit(1), 1000);
});

// SECURITY: Handle unhandled promise rejections
process.on('unhandledRejection', (reason, promise) => {
  console.error('[ERROR] Unhandled Promise Rejection at:', promise, 'reason:', reason);
  // Don't exit, just log - but this shouldn't happen in production
});

// Start server
server.listen(config.port, '0.0.0.0', async () => {
  console.log(`
╔═══════════════════════════════════════════════════╗
║         KyuubiSoft Panel v2.0.0                   ║
║         Hytale Server Management                  ║
╠═══════════════════════════════════════════════════╣
║  Panel running on http://0.0.0.0:${config.port}          ║
║  Target container: ${config.gameContainerName.padEnd(28)}║
╚═══════════════════════════════════════════════════╝
  `);

  // SECURITY: Check for insecure default credentials
  checkSecurityConfig();

  // Initialize roles (load or create default roles)
  await initializeRoles();

  // Initialize player tracking (load persisted data)
  initializePlayerTracking().catch(err => {
    console.error('Failed to initialize player tracking:', err);
  });

  // Initialize plugin events connection (chat, deaths)
  initializePluginEvents();

  // Start schedulers
  startSchedulers();
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('SIGTERM received, shutting down...');
  disconnectFromPluginWebSocket();
  server.close(() => {
    process.exit(0);
  });
});

process.on('SIGINT', () => {
  console.log('SIGINT received, shutting down...');
  disconnectFromPluginWebSocket();
  server.close(() => {
    process.exit(0);
  });
});
