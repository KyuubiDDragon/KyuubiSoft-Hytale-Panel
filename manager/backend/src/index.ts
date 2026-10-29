import express from 'express';
import cookieParser from 'cookie-parser';
import cors from 'cors';
import helmet from 'helmet';
import compression from 'compression';
import { createServer, IncomingMessage } from 'http';
import { WebSocketServer } from 'ws';
import path from 'path';
import { fileURLToPath } from 'url';
import { config, checkSecurityConfig } from './config.js';
import { setupWebSocket } from './websocket.js';
import { isLocationsSocketPath, setupLocationsSocket } from './locationsSocket.js';
import { getServerContext } from './services/serverContext.js';
import { requestLogger } from './middleware/requestLogger.js';
import { logger } from './utils/logger.js';
import { resetStagingDir } from './utils/staging.js';

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
import userServersRoutes from './routes/userServers.js';
import { installServerListCleanup } from './services/serverLists.js';
import filesRoutes from './routes/files.js';
import playerLocationsRoutes from './routes/playerLocations.js';
import replayRoutes from './routes/replay.js';
import wikiRoutes from './routes/wiki.js';
import metricsRoutes from './routes/metrics.js';
import settingsRoutes from './routes/settings.js';
import pushRoutes from './routes/push.js';
import publicRoutes from './routes/public.js';
import eventActionsRoutes from './routes/eventActions.js';
import modPanelRoutes from './routes/modPanel.js';
import healthRoutes from './routes/health.js';
import { createProxyCheck } from './middleware/proxyCheck.js';
import webMapRoutes, { createWebMapProxy, WEBMAP_PROXY_PREFIX } from './routes/webmap.js';
import { metricsMiddleware } from './services/metrics.js';

// Services
import { startSchedulers } from './services/scheduler.js';
import { initializePlayerTracking } from './services/players.js';
import { startPlayerPresence } from './services/playerPresence.js';
import { stopAllServerLogStreams } from './services/serverLogStream.js';
import { initializePluginEvents, disconnectFromPluginWebSocket } from './services/pluginEvents.js';
import { initializePluginAuth } from './services/pluginAuth.js';
import { initializePlayerLocations } from './services/playerLocations.js';
import { initializeReplay, shutdownReplay } from './services/replay.js';
import { initializeRoles } from './services/roles.js';
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
import { bindCommandActor } from './services/commandActor.js';

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
// The setting can be wrong either way (middleware/proxyCheck.ts): logged once
// the requests show it.
app.use(createProxyCheck(config.trustProxy));

// WebSocket server - use noServer mode so we can handle multiple WebSocket paths
// Console messages are small JSON frames (a command line, a ping).
const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });
setupWebSocket(wss);

// Secondary WSS for live player-location broadcasts of one server
// (locationsSocket.ts). Kept separate so the console WS handler stays untouched.
const locationsWss = new WebSocketServer({ noServer: true });
setupLocationsSocket(locationsWss);

// WebMap proxy - MUST be mounted BEFORE helmet: the third-party map page gets
// its own sandboxing CSP (routes/webmap.ts) instead of the panel's strict one.
// It is only reachable under /api/webmap/t/<session>/ with a session minted via
// POST /api/webmap/session (players.view), and always runs with an opaque
// origin, so its scripts can't use the panel's token, cookies or API.
// Each session belongs to one server; its map runs in that server's container.
// While MULTISERVER_ENABLED is off only the compose server's map is served.
async function webMapTargetFor(serverId: string): Promise<string> {
  const ctx = await getServerContext(serverId);
  if (!config.multiserverEnabled && ctx.kind !== 'compose') {
    throw new Error(`Multiserver is disabled; no map for server ${serverId}`);
  }
  return `http://${ctx.containerName}:${ctx.network.webMapPort}`;
}
console.log(
  `[WebMap] Proxy configured for http://${config.gameContainerName}:${config.webMapPort} (compose server) and each additional server's container`,
);
const webMapProxy = createWebMapProxy(webMapTargetFor);
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

  // Handle /api/players/locations/ws and /api/servers/:id/players/locations/ws -
  // live position broadcasts of one server
  if (isLocationsSocketPath(pathname.split('?')[0])) {
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

// Console commands a request sends run as "Panel:<user>" in the server log
// (services/commandActor.ts). After the body parsers, before every route.
app.use(bindCommandActor);

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
// return 410 for everything else. Fails closed: isSetupComplete() counts a
// damaged or unreadable file as finished, and an error here refuses the
// request. Until the startup migration has taken over files of older versions
// the action endpoints wait, so they never answer from a half-migrated state.
let releaseSetupGate: () => void = () => {};
const setupGateReady = new Promise<void>((resolve) => {
  releaseSetupGate = resolve;
});
app.use(async (req, res, next) => {
  // Lower-cased comparison so a case-variant path can't slip past the seal
  // (belt-and-braces with `case sensitive routing` set above).
  const lowerPath = req.path.toLowerCase();
  if (!lowerPath.startsWith('/api/setup')) return next();
  const sub = lowerPath.slice('/api/setup'.length); // '', '/status', '/server/start', …
  const readOnlyAllowed = req.method === 'GET' && (sub === '/status' || sub === '/check');
  if (readOnlyAllowed) return next();
  try {
    await setupGateReady;
    if (await isSetupComplete()) {
      res.status(410).json({
        error: 'Setup already completed',
        detail: 'Setup endpoints are disabled after the panel has been set up.',
      });
      return;
    }
  } catch (err) {
    console.error('[Setup Gate] Could not determine setup state, refusing:', err);
    res.status(503).json({
      error: 'Setup state unknown',
      detail: 'The setup state could not be read; see the panel log.',
    });
    return;
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

// The server registry loads before the first request resolves a server. A
// damaged servers.json stops the panel here instead of being replaced by a
// fresh one that forgets every additional server.
import { ensureLoaded as loadServerRegistry } from './services/servers.js';
import { warnIfServerFilesUnavailable } from './services/serverContext.js';
import {
  legacyServerScope,
  requireServerFiles,
  serverScopeMiddleware,
} from './middleware/serverScope.js';
try {
  await loadServerRegistry();
} catch (err) {
  console.error(`[FATAL] ${err instanceof Error ? err.message : err}`);
  process.exit(1);
}
installServerListCleanup();
await warnIfServerFilesUnavailable().catch((err) =>
  console.error('[servers] Could not check the server folders:', err),
);

// Server-bound resources exist twice: legacy /api/<resource>/... acts on the
// default server, /api/servers/:serverId/<resource>/... on the named one.
// Both set req.serverId, so handlers always get a concrete id. Routers whose
// every route works on the server's files also answer 409 while those files
// are not visible to the panel.
app.use('/api/auth', authRoutes);
app.use('/api/auth', userServersRoutes);
app.use('/api/auth/sso', ssoRoutes);
app.use('/api/server', legacyServerScope, serverRoutes);
app.use('/api/console', legacyServerScope, consoleRoutes);
app.use('/api/backups', legacyServerScope, requireServerFiles, backupRoutes);
// IMPORTANT: more specific player routes must come before /api/players.
app.use('/api/players/locations', legacyServerScope, playerLocationsRoutes);
app.use('/api/players', legacyServerScope, playersRoutes);
app.use('/api/management', legacyServerScope, requireServerFiles, managementRoutes);
app.use('/api/scheduler', legacyServerScope, requireServerFiles, schedulerRoutes);
app.use('/api/assets', legacyServerScope, assetsRoutes);
app.use('/api/roles', rolesRouter);
// Webhooks and event actions take a server id as a filter (none = every
// server), so they get no default id.
app.use('/api/webhooks', webhooksRoutes);
app.use('/api/me/notifications', notificationsRoutes);
app.use('/api/audit-log', auditRoutes);
app.use('/api/files', legacyServerScope, requireServerFiles, filesRoutes);
app.use('/api/metrics', metricsRoutes);
app.use('/api/replay', legacyServerScope, replayRoutes);
app.use('/api/wiki', legacyServerScope, wikiRoutes);
app.use('/api/settings', settingsRoutes);
app.use('/api/push', pushRoutes);
app.use('/api/event-actions', eventActionsRoutes);
app.use('/api/mod-panel', legacyServerScope, modPanelRoutes);
// WebMap session minting/revocation (the map proxy is mounted before helmet).
app.use('/api/webmap', legacyServerScope, webMapRoutes);
// Public, unauthenticated status (off unless config.publicStatus.enabled).
app.use('/api/public', publicRoutes);

// v3 multi-server registry.
//
//   /api/servers/*                        — registry CRUD (this router)
//   /api/servers/:serverId/<resource>/... — scoped invocation of a resource
//                                           router. serverScopeMiddleware
//                                           validates the id (only the
//                                           compose server while
//                                           MULTISERVER_ENABLED is off) and
//                                           sets req.serverId.
app.use('/api/servers', serversRoutes);

const scoped = [serverScopeMiddleware];
const scopedWithFiles = [serverScopeMiddleware, requireServerFiles];
app.use('/api/servers/:serverId/server', scoped, serverRoutes);
app.use('/api/servers/:serverId/console', scoped, consoleRoutes);
app.use('/api/servers/:serverId/backups', scopedWithFiles, backupRoutes);
// More specific player routes first, as on the legacy mounts.
app.use('/api/servers/:serverId/players/locations', scoped, playerLocationsRoutes);
app.use('/api/servers/:serverId/players', scoped, playersRoutes);
app.use('/api/servers/:serverId/replay', scoped, replayRoutes);
app.use('/api/servers/:serverId/webmap', scoped, webMapRoutes);
app.use('/api/servers/:serverId/management', scopedWithFiles, managementRoutes);
app.use('/api/servers/:serverId/scheduler', scopedWithFiles, schedulerRoutes);
app.use('/api/servers/:serverId/assets', scoped, assetsRoutes);
app.use('/api/servers/:serverId/files', scopedWithFiles, filesRoutes);
app.use('/api/servers/:serverId/mod-panel', scoped, modPanelRoutes);
app.use('/api/servers/:serverId/wiki', scoped, wikiRoutes);

// Health check (public) and folder permission check (settings.view)
app.use('/api/health', healthRoutes);

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

// Downloads and uploads a crash or restart left half-done; before any request.
resetStagingDir();

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
  try {
    await checkAndRunMigration();
  } finally {
    releaseSetupGate();
  }

  // Migrate UpdateConfig for native update system (Hytale 24.01.2026+); only
  // while the game server is stopped (it would write its own config back).
  const { getContainerState } = await import('./services/docker.js');
  const updateMigration = await migrateUpdateConfig({
    isServerRunning: async () => (await getContainerState())?.running === true,
  });
  if (updateMigration.migrated) {
    console.log('[Startup] Migrated to native update system');
  }

  // Clean up settings older panel versions wrote into config.json and the
  // world configs under names Hytale never read. Same rule: only while the
  // game server is stopped, otherwise right before its next start.
  const { installLegacyConfigHook, migrateLegacyConfigKeysAtStartup } =
    await import('./services/serverConfigMigration.js');
  installLegacyConfigHook();
  const configMigration = await migrateLegacyConfigKeysAtStartup();
  if (configMigration.deferred) {
    console.log('[Startup] Server config cleanup deferred until the next server start');
  } else if (configMigration.notes.length > 0) {
    console.log(`[Startup] Cleaned up ${configMigration.notes.length} old server setting(s)`);
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
  // Follow who is online on each server (plugin events, else the server's log).
  startPlayerPresence().catch((err) => {
    console.error('Failed to start the join/leave tracking:', err);
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

  // Match the status of additional servers with their containers (an entry
  // left in "creating" by a restart, a container removed by hand).
  void (await import('./services/serverReconcile.js')).startServerReconcile();

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

  // Move panel self-backups older versions left on the backups volume (which
  // the game server can read) into the manager's own volume. Runs once.
  void (await import('./services/panelBackups.js')).migrateLegacyPanelBackups();

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
  stopAllServerLogStreams();
  shutdownReplay().catch((err) => console.error('[replay] shutdown failed:', err));
  server.close(() => {
    process.exit(0);
  });
});

process.on('SIGINT', () => {
  console.log('SIGINT received, shutting down...');
  disconnectFromPluginWebSocket();
  stopAllServerLogStreams();
  shutdownReplay().catch((err) => console.error('[replay] shutdown failed:', err));
  server.close(() => {
    process.exit(0);
  });
});
