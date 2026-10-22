import express from 'express';
import cookieParser from 'cookie-parser';
import cors from 'cors';
import helmet from 'helmet';
import compression from 'compression';
import { createServer, IncomingMessage } from 'http';
import { WebSocketServer } from 'ws';
import path from 'path';
import { fileURLToPath } from 'url';
import { access, constants, writeFile as fsWriteFile, unlink } from 'fs/promises';
import { randomBytes } from 'crypto';

import { config, checkSecurityConfig } from './config.js';
import { setupWebSocket } from './websocket.js';
import { verifyWsTicket, verifyToken } from './services/auth.js';
import { hasPermission } from './services/roles.js';
import { requestLogger } from './middleware/requestLogger.js';
import { logger } from './utils/logger.js';

// Routes
import authRoutes from './routes/auth.js';
import serverRoutes from './routes/server/index.js';
import consoleRoutes from './routes/console.js';
import backupRoutes from './routes/backup.js';
import playersRoutes from './routes/players.js';
import managementRoutes from './routes/management/index.js';
import schedulerRoutes from './routes/scheduler.js';
import assetsRoutes from './routes/assets.js';
import rolesRouter from './routes/roles.js';
import setupRoutes from './routes/setup.js';
import webhooksRoutes from './routes/webhooks.js';
import notificationsRoutes from './routes/notifications.js';
import auditRoutes from './routes/audit.js';
import serversRoutes from './routes/servers.js';
import ssoRoutes from './routes/sso.js';
import filesRoutes from './routes/files.js';
import playerLocationsRoutes from './routes/playerLocations.js';
import replayRoutes from './routes/replay.js';
import wikiRoutes from './routes/wiki.js';
import metricsRoutes from './routes/metrics.js';
import settingsRoutes from './routes/settings.js';
import pushRoutes from './routes/push.js';
import publicRoutes from './routes/public.js';
import eventActionsRoutes from './routes/eventActions.js';
import webMapRoutes, { createWebMapProxy, WEBMAP_PROXY_PREFIX } from './routes/webmap.js';
import { metricsMiddleware } from './services/metrics.js';

// Services
import { startSchedulers } from './services/scheduler.js';
import { initializePlayerTracking } from './services/players.js';
import { initializePluginEvents, disconnectFromPluginWebSocket } from './services/pluginEvents.js';
import { initializePluginAuth } from './services/pluginAuth.js';
import { initializePlayerLocations } from './services/playerLocations.js';
import { initializeReplay, shutdownReplay } from './services/replay.js';
import { initializeRoles } from './services/roles.js';
import * as playerLocations from './services/playerLocations.js';
import { isSetupComplete } from './services/setupService.js';
import {
  checkAndRunMigration,
  migrateUpdateConfig,
  checkPanelVersionAndFeatures,
} from './services/migration.js';
import { startAutoUpdateCheck } from './services/cfwidget.js';
import { getCurrentVersion } from './services/panelVersionService.js';
import { startWatchdog } from './services/watchdog.js';
import { startPunishmentExpiry } from './services/punishments.js';
import { startPlaytimeTracking } from './services/playtime.js';
import { startCrashCapture } from './services/crashReports.js';
import { startPerfHistory } from './services/perfHistory.js';
import { startAutoMod } from './services/autoMod.js';
import { startRetention } from './services/retention.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const server = createServer(app);

// SECURITY: case-sensitive routing. Express matches mounts case-INsensitively
// by default, so `/API/setup/...` would reach the setup router while the
// security gates (which compare req.path === '/api/setup...') were bypassed —
// re-opening sealed setup endpoints and the CSRF origin check after setup is
// complete. With this flag, `/API/...` no longer matches the lowercase API
// mounts; the gates below additionally lower-case their comparisons as
// defense-in-depth.
app.set('case sensitive routing', true);

// Reverse Proxy Support - must be set before other middleware
// This enables proper handling of X-Forwarded-* headers when behind nginx, traefik, etc.
if (config.trustProxy) {
  app.set('trust proxy', 1);
  console.log('Reverse proxy mode enabled (TRUST_PROXY=true)');
}

// WebSocket server - use noServer mode so we can handle multiple WebSocket paths
const wss = new WebSocketServer({ noServer: true });
setupWebSocket(wss);

// Secondary WSS for live player-location broadcasts. Kept separate so the
// console WS handler stays untouched.
const locationsWss = new WebSocketServer({ noServer: true });
locationsWss.on('connection', async (socket: import('ws').WebSocket, req: IncomingMessage) => {
  // SECURITY: authenticate BEFORE streaming. This socket exposes live player
  // UUIDs + world coordinates, so it must enforce the same players.view gate
  // as GET /api/players/locations. Previously it streamed to anyone who could
  // reach the panel — no token, no permission check. Accepts a single-use WS
  // ticket (preferred) or an access token (legacy fallback, mirrors the
  // console WS).
  try {
    const url = new URL(req.url || '', `http://${req.headers.host}`);
    const ticket = url.searchParams.get('ticket');
    const token = url.searchParams.get('token');
    let username: string | null = null;
    if (ticket) {
      const r = verifyWsTicket(ticket);
      if (r.valid && r.username) username = r.username;
    } else if (token) {
      const r = verifyToken(token, 'access');
      if (r) username = r.username;
    }
    if (!username) {
      socket.close(4001, 'Authentication required');
      return;
    }
    if (!(await hasPermission(username, 'players.view'))) {
      socket.close(4003, 'Permission denied: players.view required');
      return;
    }
  } catch {
    socket.close(4001, 'Authentication failed');
    return;
  }

  // Authenticated: send initial snapshot, then stream subsequent updates.
  try {
    socket.send(JSON.stringify({ type: 'snapshot', samples: playerLocations.getLatestSnapshot() }));
  } catch {
    /* socket may already be closed */
  }
  const unsubscribe = playerLocations.addListener((s) => {
    try {
      socket.send(JSON.stringify({ type: 'sample', sample: s }));
    } catch {
      /* ignore - will be cleaned up by close */
    }
  });
  socket.on('close', () => unsubscribe());
  socket.on('error', () => unsubscribe());
});

// WebMap proxy - MUST be mounted BEFORE helmet: the third-party map page gets
// its own sandboxing CSP (routes/webmap.ts) instead of the panel's strict one.
// It is only reachable under /api/webmap/t/<session>/ with a session minted via
// POST /api/webmap/session (players.view), and always runs with an opaque
// origin, so its scripts can't use the panel's token, cookies or API.
const webMapTarget = `http://${config.gameContainerName}:${config.webMapPort}`;
console.log(`[WebMap] Proxy configured for: ${webMapTarget}`);
const webMapProxy = createWebMapProxy(webMapTarget);
app.use('/api/webmap', webMapProxy.middleware);

// Handle ALL WebSocket upgrades manually (noServer mode)
server.on('upgrade', (request, socket, head) => {
  const pathname = request.url || '';
  // Keep WebMap session ids out of the log.
  console.log(
    `[WebSocket Upgrade] Path: ${pathname.replace(/^\/api\/webmap\/t\/[^/?]+/, '/api/webmap/t/<session>')}`,
  );

  // Handle /api/console/ws - our panel's console WebSocket (legacy, default server)
  // and /api/servers/:serverId/console/ws (per-server console stream).
  if (
    pathname.startsWith('/api/console/ws') ||
    /^\/api\/servers\/[^/?]+\/console\/ws/.test(pathname)
  ) {
    console.log(`[Console WS] Handling console WebSocket upgrade for ${pathname}`);
    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit('connection', ws, request);
    });
    return;
  }

  // Handle /api/players/locations/ws - live position broadcasts
  if (pathname.startsWith('/api/players/locations/ws')) {
    console.log(`[Locations WS] Handling player-locations WebSocket upgrade`);
    locationsWss.handleUpgrade(request, socket, head, (ws) => {
      locationsWss.emit('connection', ws, request);
    });
    return;
  }

  // Handle /api/webmap/t/<session>/ws - session-checked proxy to the map's /ws
  if (pathname.startsWith(WEBMAP_PROXY_PREFIX)) {
    void webMapProxy.handleUpgrade(request, socket, head);
    return;
  }

  // Unknown WebSocket path - destroy connection
  console.log(`[WebSocket Upgrade] Unknown path: ${pathname}, destroying socket`);
  socket.destroy();
});

// Middleware
// SECURITY: Configure Content-Security-Policy for SPA
app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'", "'unsafe-eval'", 'blob:'], // Vue.js needs unsafe-eval; Monaco loads workers from blob:
        workerSrc: ["'self'", 'blob:'], // Monaco editor uses Web Workers via blob URLs
        childSrc: ["'self'", 'blob:'], // Fallback for older browsers that don't honour workerSrc
        styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'], // Vue/CSS-in-JS + Google Fonts
        imgSrc: [
          "'self'",
          'data:',
          'blob:',
          'https://cdn.modtale.net',
          'https://stackmart.org',
          'https://hyvatar.io',
          'https://media.forgecdn.net',
        ], // Allow data URIs, Modtale CDN, StackMart, Hyvatar and CurseForge CDN
        fontSrc: ["'self'", 'data:', 'https://fonts.gstatic.com'], // Google Fonts
        connectSrc: ["'self'", 'ws:', 'wss:'], // Allow WebSocket connections
        frameSrc: ["'self'", 'https:', 'http:'], // Allow embedding web map iframe from external sources
        objectSrc: ["'none'"],
        baseUri: ["'self'"],
        formAction: ["'self'"],
        frameAncestors: ["'none'"], // Prevent clickjacking
        // CRITICAL: Disable upgrade-insecure-requests for HTTP deployments
        // This directive forces browsers to upgrade all HTTP requests to HTTPS
        // Only enable when behind HTTPS proxy, otherwise causes ERR_SSL_PROTOCOL_ERROR
        upgradeInsecureRequests: config.trustProxy ? [] : null,
      },
    },
    // HSTS: Only enable when behind a reverse proxy with HTTPS (TRUST_PROXY=true)
    // Without this, browsers over HTTP will cache the HSTS header and force-upgrade
    // all subsequent requests to HTTPS, causing ERR_SSL_PROTOCOL_ERROR (white page)
    hsts: config.trustProxy ? { maxAge: 31536000, includeSubDomains: true } : false,
    // Additional security headers
    crossOriginEmbedderPolicy: false, // Disable for compatibility with external resources
    crossOriginOpenerPolicy: false, // Disable for HTTP compatibility
    crossOriginResourcePolicy: { policy: 'cross-origin' }, // Allow loading cross-origin resources
  }),
);
app.use(compression());
// Structured request logging with correlation IDs. Mount BEFORE any router
// so every log line in a handler carries req.id automatically. Health
// checks are filtered out to keep the stream readable.
app.use(requestLogger);
// Prometheus per-request metrics. Pure timing + counter, no route filter.
app.use(metricsMiddleware);
// Parse refresh-token cookie (HttpOnly, set by /api/auth/login & /refresh).
// Body-based refresh tokens still work for backward compat — see auth route.
app.use(cookieParser());

// CORS configuration - must be explicitly set
const corsOrigins = config.corsOrigins
  ? config.corsOrigins === '*'
    ? '*'
    : config.corsOrigins.split(',').map((o) => o.trim())
  : false; // Disable CORS if not configured (same-origin only)

app.use(
  cors({
    origin: corsOrigins,
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-CSRF-Token'],
  }),
);

// CSRF Protection via Origin/Referer validation for state-changing requests.
// Modern browsers always send Origin on POST/PUT/PATCH/DELETE, so missing
// Origin AND missing Referer on a state-changing request is suspicious and
// rejected (was previously waved through, which made CSRF protection toothless).
app.use((req, res, next) => {
  // Skip for safe methods
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
    return next();
  }

  // Skip for non-API routes (static files)
  if (!req.path.startsWith('/api/')) {
    return next();
  }

  // Wildcard CORS disables CSRF protection — only honor it when the operator
  // has explicitly opted in. Otherwise treat '*' as misconfiguration.
  if (config.corsOrigins === '*') {
    if (!config.corsAllowWildcard) {
      console.warn(
        `[CSRF] Blocking ${req.method} ${req.path}: CORS_ORIGINS=* without CORS_ALLOW_WILDCARD=true`,
      );
      res.status(403).json({
        error: 'CSRF validation failed',
        detail: 'Wildcard CORS requires CORS_ALLOW_WILDCARD=true',
      });
      return;
    }
    return next();
  }

  const origin = req.headers.origin;
  const referer = req.headers.referer;
  let requestOrigin: string | null = null;
  if (origin) {
    requestOrigin = origin;
  } else if (referer) {
    try {
      requestOrigin = new URL(referer).origin;
    } catch {
      requestOrigin = null;
    }
  }

  if (!requestOrigin) {
    console.warn(`[CSRF] Blocked ${req.method} ${req.path}: missing Origin and Referer headers`);
    res
      .status(403)
      .json({ error: 'CSRF validation failed', detail: 'Origin or Referer header required' });
    return;
  }

  const allowedOrigins = (config.corsOrigins || '')
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean);

  // Also allow requests from the server's own origin (same-origin).
  // Derive the protocol from req.secure only — Express already resolves it from
  // a *trusted* X-Forwarded-Proto when TRUST_PROXY is on, so we must never read
  // the raw header here (it is attacker-controllable without a trusted proxy).
  const host = req.headers.host;
  const protocol = req.secure ? 'https' : 'http';
  const serverOrigin = `${protocol}://${host}`;

  if (allowedOrigins.includes(requestOrigin) || requestOrigin === serverOrigin) {
    return next();
  }

  // Origin mismatch - potential CSRF
  console.warn(`[CSRF] Blocked ${req.method} ${req.path} from origin ${requestOrigin}`);
  res.status(403).json({ error: 'CSRF validation failed', detail: 'Origin not allowed' });
});

// SECURITY: Limit JSON body size to prevent memory exhaustion attacks
// The file-manager /api/files/write route has its own parser with a larger
// limit (~15 MB) because file content payloads can legitimately exceed 100kb.
app.use((req, res, next) => {
  if (req.path === '/api/files/write') {
    return next();
  }
  express.json({ limit: '100kb' })(req, res, next);
});

// ============================================================
// Setup Routes - MUST be BEFORE auth middleware and other routes
// These routes work without authentication during first-run setup
// ============================================================
//
// SECURITY: The setup router is unauthenticated by design (first-run has no
// users yet). Once setup is complete it MUST be sealed: its action endpoints
// (server start/stop, /auth console injection, raw log/SSE streams that leak
// OAuth device codes) would otherwise stay reachable without any auth. After
// completion we allow only the two read-only status probes the SPA needs and
// return 410 for everything else. Fails open during first run so the wizard
// can never lock itself out.
app.use(async (req, res, next) => {
  // Lower-cased comparison so a case-variant path can't slip past the seal
  // (belt-and-braces with `case sensitive routing` set above).
  const lowerPath = req.path.toLowerCase();
  if (!lowerPath.startsWith('/api/setup')) return next();
  const sub = lowerPath.slice('/api/setup'.length); // '', '/status', '/server/start', …
  const readOnlyAllowed = req.method === 'GET' && (sub === '/status' || sub === '/check');
  if (readOnlyAllowed) return next();
  try {
    if (await isSetupComplete()) {
      res.status(410).json({
        error: 'Setup already completed',
        detail: 'Setup endpoints are disabled after the panel has been set up.',
      });
      return;
    }
  } catch (err) {
    // If we can't determine setup state, fail open so first-run isn't blocked.
    console.error('[Setup Gate] Could not determine setup state, allowing:', err);
  }
  next();
});
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

  // Skip for static assets
  if (
    req.path.startsWith('/assets') ||
    req.path.endsWith('.js') ||
    req.path.endsWith('.css') ||
    req.path.endsWith('.png') ||
    req.path.endsWith('.svg') ||
    req.path.endsWith('.ico')
  ) {
    return next();
  }

  try {
    const setupComplete = await isSetupComplete();

    if (!setupComplete) {
      // For API requests, return 503 with setup required message
      if (req.path.startsWith('/api/')) {
        res.status(503).json({
          error: 'Setup required',
          message:
            'The panel setup has not been completed. Please complete the setup wizard first.',
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
app.use('/api/auth/sso', ssoRoutes);
app.use('/api/server', serverRoutes);
app.use('/api/console', consoleRoutes);
app.use('/api/backups', backupRoutes);
// IMPORTANT: more specific player routes must come before /api/players.
app.use('/api/players/locations', playerLocationsRoutes);
app.use('/api/players', playersRoutes);
app.use('/api/management', managementRoutes);
app.use('/api/scheduler', schedulerRoutes);
app.use('/api/assets', assetsRoutes);
app.use('/api/roles', rolesRouter);
app.use('/api/webhooks', webhooksRoutes);
app.use('/api/me/notifications', notificationsRoutes);
app.use('/api/audit-log', auditRoutes);
app.use('/api/files', filesRoutes);
app.use('/api/metrics', metricsRoutes);
app.use('/api/replay', replayRoutes);
app.use('/api/wiki', wikiRoutes);
app.use('/api/settings', settingsRoutes);
app.use('/api/push', pushRoutes);
app.use('/api/event-actions', eventActionsRoutes);
// WebMap session minting/revocation (the map proxy is mounted before helmet).
app.use('/api/webmap', webMapRoutes);
// Public, unauthenticated status (off unless config.publicStatus.enabled).
app.use('/api/public', publicRoutes);

// v3 multi-server registry.
//
//   /api/servers/*                        — registry CRUD (this router)
//   /api/servers/:serverId/<resource>/... — scoped invocation of any
//                                           resource router. The serverScope
//                                           middleware sets req.serverId,
//                                           the service layer (docker.ts,
//                                           scheduler.ts, backup.ts, …) uses
//                                           it. Legacy /api/<resource>/...
//                                           still works against the default
//                                           server identified by
//                                           servers.json.defaultId.
app.use('/api/servers', serversRoutes);

import { serverScopeMiddleware } from './middleware/serverScope.js';
app.use('/api/servers/:serverId/server', serverScopeMiddleware, serverRoutes);
app.use('/api/servers/:serverId/console', serverScopeMiddleware, consoleRoutes);
app.use('/api/servers/:serverId/backups', serverScopeMiddleware, backupRoutes);
app.use('/api/servers/:serverId/players', serverScopeMiddleware, playersRoutes);
app.use('/api/servers/:serverId/management', serverScopeMiddleware, managementRoutes);
app.use('/api/servers/:serverId/scheduler', serverScopeMiddleware, schedulerRoutes);
app.use('/api/servers/:serverId/assets', serverScopeMiddleware, assetsRoutes);
app.use('/api/servers/:serverId/files', serverScopeMiddleware, filesRoutes);

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
    issues: results.filter((r) => !r.readable || !r.writable),
  };

  if (hasIssues) {
    response.message = `Some directories have permission issues. This may happen after upgrading to v2.0.0 which runs as non-root. Run: sudo chown -R 9999:9999 ${config.hostDataPath}`;
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
    res
      .status(400)
      .json({ error: 'Validation failed', detail: isDev ? err.message : 'Invalid input' });
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
  const panelVersion = await getCurrentVersion(); // single source of truth: package.json
  console.log(`
╔═══════════════════════════════════════════════════╗
║         KyuubiSoft Panel ${('v' + panelVersion).padEnd(25)}║
║         Hytale Server Management                  ║
╠═══════════════════════════════════════════════════╣
║  Panel: http://localhost:${config.externalPort.toString().padEnd(23)}║
║  Container: ${config.gameContainerName.padEnd(34)}║
║  Server Port: ${config.serverPort.toString().padEnd(32)}║
╚═══════════════════════════════════════════════════╝
  `);

  // Check for existing installation and run migration if needed
  // This must happen BEFORE security check as it may create config files
  await checkAndRunMigration();

  // Migrate UpdateConfig for native update system (Hytale 24.01.2026+)
  const updateMigration = await migrateUpdateConfig();
  if (updateMigration.migrated) {
    console.log('[Startup] Migrated to native update system');
  }

  // Check panel version and new features
  const versionCheck = await checkPanelVersionAndFeatures();
  if (versionCheck.newFeatures.length > 0) {
    console.log('[Startup] New features available:', versionCheck.newFeatures);
  }

  // SECURITY: Check for insecure default credentials
  checkSecurityConfig();

  // Initialize roles (load or create default roles)
  await initializeRoles();

  // Initialize users early so the startup log states which credential source
  // is active (users.json vs MANAGER_USERNAME/MANAGER_PASSWORD) instead of
  // operators discovering it at the first failed login.
  const { initializeUsers } = await import('./services/users.js');
  await initializeUsers().catch((err) => {
    console.error('Failed to initialize users:', err);
  });

  // Initialize player tracking (load persisted data)
  initializePlayerTracking().catch((err) => {
    console.error('Failed to initialize player tracking:', err);
  });

  // Keep each installed plugin's config on the panel's token (plugin 2.0 requires it)
  initializePluginAuth();

  // Initialize plugin events connection (chat, deaths)
  initializePluginEvents();

  // Initialize live player locations (simulated in demo mode / when plugin
  // does not yet emit positions)
  initializePlayerLocations();

  // Start replay recorder if enabled in config.json
  initializeReplay().catch((err) => console.error('[replay] init failed:', err));

  // Start schedulers
  startSchedulers().catch((err) => console.error('[Startup] Scheduler init failed:', err));

  // Start CFWidget mod update checker (checks hourly for CurseForge mod updates)
  startAutoUpdateCheck();

  // Start the crash watchdog (monitoring/alerts always; auto-restart opt-in via
  // WATCHDOG_AUTO_RESTART=true).
  startWatchdog();

  // Start the punishment-expiry loop (lifts lapsed temp bans/mutes).
  startPunishmentExpiry();

  // Start playtime/session tracking (records play_sessions from join/leave).
  startPlaytimeTracking();

  // Capture a log snapshot whenever the watchdog reports a crash.
  startCrashCapture();

  // Sample TPS/MSPT/CPU/memory into a ring buffer for the performance charts.
  startPerfHistory();

  // Daily delete-by-age sweep so operational log tables don't grow unbounded.
  startRetention();

  // Clear any restore staging dirs stranded by a crash mid-restore.
  void (await import('./services/backup.js')).sweepOrphanedRestoreDirs().catch(() => {});

  // Start the event-action engine (reactive automations bound to the EventBus).
  const { startEventActions } = await import('./services/eventActions.js');
  startEventActions();

  // Start the Discord bot if enabled in config (off by default).
  const { startDiscordBot } = await import('./services/discordBot.js');
  startDiscordBot().catch((err) => console.error('[Discord] start failed:', err));

  // Start chat auto-moderation (acts only when config.automod.enabled).
  startAutoMod();

  // Start the event-bus consumers (webhook dispatcher + notification fanout).
  const { startWebhookDispatcher } = await import('./services/webhooks.js');
  const { startNotificationFanout } = await import('./services/notifications.js');
  startWebhookDispatcher();
  startNotificationFanout();
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('SIGTERM received, shutting down...');
  disconnectFromPluginWebSocket();
  shutdownReplay().catch((err) => console.error('[replay] shutdown failed:', err));
  server.close(() => {
    process.exit(0);
  });
});

process.on('SIGINT', () => {
  console.log('SIGINT received, shutting down...');
  disconnectFromPluginWebSocket();
  shutdownReplay().catch((err) => console.error('[replay] shutdown failed:', err));
  server.close(() => {
    process.exit(0);
  });
});
