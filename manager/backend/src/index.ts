import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import compression from 'compression';
import { createServer } from 'http';
import { WebSocketServer } from 'ws';
import path from 'path';
import { fileURLToPath } from 'url';

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

// Middleware
app.use(helmet({
  contentSecurityPolicy: false, // Disable for SPA
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

app.use(express.json());

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

// Start server
server.listen(config.port, '0.0.0.0', async () => {
  console.log(`
╔═══════════════════════════════════════════════════╗
║         KyuubiSoft Panel v1.0.0                   ║
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
