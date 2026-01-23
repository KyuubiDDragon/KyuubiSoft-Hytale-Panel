import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import compression from 'compression';
import { createServer, IncomingMessage, ServerResponse } from 'http';
import { createGunzip, createInflate } from 'zlib';
import { WebSocketServer } from 'ws';
import path from 'path';
import { fileURLToPath } from 'url';
import { access, constants, writeFile as fsWriteFile, unlink } from 'fs/promises';
import { randomBytes } from 'crypto';
import { createProxyMiddleware } from 'http-proxy-middleware';
import httpProxy from 'http-proxy';

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
import setupRoutes from './routes/setup.js';

// Services
import { startSchedulers } from './services/scheduler.js';
import { initializePlayerTracking } from './services/players.js';
import { initializePluginEvents, disconnectFromPluginWebSocket } from './services/pluginEvents.js';
import { initializeRoles } from './services/roles.js';
import { isSetupComplete } from './services/setupService.js';

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

// WebSocket server - use noServer mode so we can handle multiple WebSocket paths
const wss = new WebSocketServer({ noServer: true });
setupWebSocket(wss);

// WebMap Proxy - MUST be mounted BEFORE helmet so our CSP doesn't affect WebMap content
// The WebMap loads Leaflet from unpkg.com CDN which would be blocked by our CSP
const webMapTarget = `http://${config.gameContainerName}:18081`;

const createWebMapProxyErrorHandler = () => ({
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
});

// Script to inject into WebMap HTML to rewrite WebSocket URLs from /ws to /api/webmap-ws
const webMapWsRewriteScript = `
<script>
(function() {
  var OriginalWebSocket = window.WebSocket;
  window.WebSocket = function(url, protocols) {
    // Rewrite /ws to /api/webmap-ws for WebMap's live updates
    if (url && (url.endsWith('/ws') || url.includes('/ws?'))) {
      url = url.replace(/\\/ws(\\?|$)/, '/api/webmap-ws$1');
    }
    return protocols ? new OriginalWebSocket(url, protocols) : new OriginalWebSocket(url);
  };
  window.WebSocket.prototype = OriginalWebSocket.prototype;
  window.WebSocket.CONNECTING = OriginalWebSocket.CONNECTING;
  window.WebSocket.OPEN = OriginalWebSocket.OPEN;
  window.WebSocket.CLOSING = OriginalWebSocket.CLOSING;
  window.WebSocket.CLOSED = OriginalWebSocket.CLOSED;
})();
</script>
`;

// Main WebMap proxy (for iframe content - strips /api/webmap prefix)
// Injects script to rewrite WebSocket URLs from /ws to /api/webmap-ws
const webMapProxy = createProxyMiddleware({
  target: webMapTarget,
  changeOrigin: true,
  selfHandleResponse: true, // We'll handle the response to inject script
  pathRewrite: {
    '^/api/webmap': '', // Remove /api/webmap prefix when forwarding
  },
  on: {
    // Request the uncompressed version to simplify HTML injection
    proxyReq: (proxyReq) => {
      proxyReq.setHeader('Accept-Encoding', 'identity');
    },
    error: (err: Error, _req: unknown, res: unknown) => {
      console.error('[WebMap Proxy] Error:', err.message);
      if (res && typeof res === 'object' && 'writeHead' in res && typeof (res as { writeHead: unknown }).writeHead === 'function') {
        const httpRes = res as { writeHead: (code: number, headers: Record<string, string>) => void; end: (data: string) => void };
        httpRes.writeHead(502, { 'Content-Type': 'application/json' });
        httpRes.end(JSON.stringify({ error: 'WebMap unavailable', detail: err.message }));
      }
    },
    proxyRes: (proxyResRaw, _req, resRaw) => {
      const proxyRes = proxyResRaw as IncomingMessage;
      const res = resRaw as ServerResponse;

      // Remove restrictive headers
      delete proxyRes.headers['content-security-policy'];
      delete proxyRes.headers['x-frame-options'];

      const contentType = (proxyRes.headers['content-type'] as string) || '';
      const contentEncoding = ((proxyRes.headers['content-encoding'] as string) || '').toLowerCase();
      const isHtml = contentType.toLowerCase().includes('text/html');

      console.log(`[WebMap Proxy] Content-Type: ${contentType}, Content-Encoding: ${contentEncoding}, isHtml: ${isHtml}`);

      if (isHtml) {
        // Collect response body, decompress if needed, and inject script
        const chunks: Buffer[] = [];
        let decompressionFailed = false;

        // Create decompression stream if content is compressed
        let stream: NodeJS.ReadableStream = proxyRes;
        if (contentEncoding === 'gzip') {
          console.log('[WebMap Proxy] Decompressing gzip content');
          const gunzip = createGunzip();
          gunzip.on('error', (err) => {
            console.error('[WebMap Proxy] Gunzip stream error:', err.message);
            decompressionFailed = true;
          });
          stream = proxyRes.pipe(gunzip);
        } else if (contentEncoding === 'deflate') {
          console.log('[WebMap Proxy] Decompressing deflate content');
          const inflate = createInflate();
          inflate.on('error', (err) => {
            console.error('[WebMap Proxy] Inflate stream error:', err.message);
            decompressionFailed = true;
          });
          stream = proxyRes.pipe(inflate);
        }

        stream.on('data', (chunk: Buffer) => chunks.push(chunk));
        stream.on('end', () => {
          const rawBody = Buffer.concat(chunks);
          let body = rawBody.toString('utf-8');

          // Check if decompression worked (body should start with < for HTML)
          if (body.length > 0 && !body.trimStart().startsWith('<') && !decompressionFailed) {
            console.log('[WebMap Proxy] Warning: Decompressed content does not look like HTML, first bytes:', rawBody.slice(0, 20).toString('hex'));
          }

          console.log(`[WebMap Proxy] Body length: ${body.length}, starts with: ${body.substring(0, 100).replace(/\n/g, '\\n')}`);
          // Inject our WebSocket rewrite script after <head>
          body = body.replace(/<head>/i, '<head>' + webMapWsRewriteScript);

          // Update headers - remove encoding since we send uncompressed
          const newHeaders = { ...proxyRes.headers };
          delete newHeaders['content-length'];
          delete newHeaders['content-encoding'];
          delete newHeaders['transfer-encoding'];

          res.writeHead(proxyRes.statusCode || 200, newHeaders);
          res.end(body);
        });
        stream.on('error', (err) => {
          console.error('[WebMap Proxy] Stream error:', err.message);
          res.writeHead(502, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'WebMap proxy error', detail: err.message }));
        });
      } else {
        // For non-HTML, just pipe through
        res.writeHead(proxyRes.statusCode || 200, proxyRes.headers);
        proxyRes.pipe(res);
      }
    },
  },
});
app.use('/api/webmap', webMapProxy);

// WebMap API proxies - The WebMap JavaScript uses absolute paths for its API calls
// These routes don't conflict with our panel routes (auth, server, console, etc.)
// When using app.use() with a path, Express strips it from req.url, so we need pathRewrite to restore it
// Handle root path without trailing slash: '/' -> '/api/worlds', '/batch' -> '/api/worlds/batch'
app.use('/api/worlds', createProxyMiddleware({
  target: webMapTarget,
  changeOrigin: true,
  pathRewrite: (path) => path === '/' || path === '' ? '/api/worlds' : `/api/worlds${path}`,
  on: createWebMapProxyErrorHandler(),
}));
app.use('/api/tiles', createProxyMiddleware({
  target: webMapTarget,
  changeOrigin: true,
  pathRewrite: (path) => path === '/' || path === '' ? '/api/tiles' : `/api/tiles${path}`,
  on: createWebMapProxyErrorHandler(),
}));

// WebMap WebSocket proxy at /api/webmap-ws (under /api/ so reverse proxies forward it)
// Use http-proxy directly for reliable WebSocket proxying
const webMapWsProxy = httpProxy.createProxyServer({
  target: webMapTarget,
  ws: true,
  changeOrigin: true,
});

webMapWsProxy.on('error', (err, _req, res) => {
  console.error('[WebMap WS Proxy] Error:', err.message);
  if (res && 'writeHead' in res && typeof res.writeHead === 'function') {
    res.writeHead(502, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'WebMap WebSocket unavailable', detail: err.message }));
  }
});

// Handle ALL WebSocket upgrades manually (noServer mode)
server.on('upgrade', (request, socket, head) => {
  const pathname = request.url || '';
  console.log(`[WebSocket Upgrade] Path: ${pathname}`);

  // Handle /api/console/ws - our panel's console WebSocket
  if (pathname.startsWith('/api/console/ws')) {
    console.log(`[Console WS] Handling console WebSocket upgrade`);
    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit('connection', ws, request);
    });
    return;
  }

  // Handle /api/webmap-ws - proxy to WebMap's /ws endpoint
  if (pathname === '/api/webmap-ws' || pathname.startsWith('/api/webmap-ws?')) {
    console.log(`[WebMap WS] Proxying WebSocket upgrade to /ws`);
    // Rewrite the URL to /ws for the WebMap server
    request.url = pathname.replace('/api/webmap-ws', '/ws');
    webMapWsProxy.ws(request, socket, head);
    return;
  }

  // Unknown WebSocket path - destroy connection
  console.log(`[WebSocket Upgrade] Unknown path: ${pathname}, destroying socket`);
  socket.destroy();
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

  // Skip for WebMap proxy routes (these are proxied to the game server, not our API)
  if (req.path.startsWith('/api/webmap') || req.path.startsWith('/api/worlds') || req.path.startsWith('/api/tiles')) {
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

// ============================================================
// Setup Routes - MUST be BEFORE auth middleware and other routes
// These routes work without authentication during first-run setup
// ============================================================
app.use('/api/setup', setupRoutes);

// ============================================================
// Setup Redirect Middleware
// If setup is not complete, redirect non-setup API requests
// and frontend routes to the setup wizard
// ============================================================
app.use(async (req, res, next) => {
  // Skip for setup routes (already handled above)
  if (req.path.startsWith('/api/setup')) {
    return next();
  }

  // Skip for health check
  if (req.path === '/api/health') {
    return next();
  }

  // Skip for WebMap proxy routes
  if (req.path.startsWith('/api/webmap') || req.path.startsWith('/api/worlds') || req.path.startsWith('/api/tiles')) {
    return next();
  }

  // Skip for static assets
  if (req.path.startsWith('/assets') || req.path.endsWith('.js') || req.path.endsWith('.css') ||
      req.path.endsWith('.png') || req.path.endsWith('.svg') || req.path.endsWith('.ico')) {
    return next();
  }

  try {
    const setupComplete = await isSetupComplete();

    if (!setupComplete) {
      // For API requests, return 503 with setup required message
      if (req.path.startsWith('/api/')) {
        res.status(503).json({
          error: 'Setup required',
          message: 'The panel setup has not been completed. Please complete the setup wizard first.',
          setupRequired: true,
          redirectUrl: '/setup',
        });
        return;
      }

      // For frontend routes (except /setup), the SPA will handle the redirect
      // based on the /api/setup/status response
    }
  } catch (error) {
    // On error checking setup status, continue normally
    console.error('[Setup Check] Error checking setup status:', error);
  }

  next();
});

// ============================================================
// API Routes (require setup to be complete)
// ============================================================
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
║  Panel: http://localhost:${config.externalPort.toString().padEnd(23)}║
║  Container: ${config.gameContainerName.padEnd(34)}║
║  Server Port: ${config.serverPort.toString().padEnd(32)}║
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
