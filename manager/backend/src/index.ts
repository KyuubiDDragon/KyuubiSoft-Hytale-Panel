import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import compression from 'compression';
import { createServer } from 'http';
import { WebSocketServer } from 'ws';
import path from 'path';
import { fileURLToPath } from 'url';

import { config } from './config.js';
import { setupWebSocket } from './websocket.js';

// Routes
import authRoutes from './routes/auth.js';
import serverRoutes from './routes/server.js';
import consoleRoutes from './routes/console.js';
import backupRoutes from './routes/backup.js';
import playersRoutes from './routes/players.js';
import managementRoutes from './routes/management.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const server = createServer(app);

// WebSocket server
const wss = new WebSocketServer({ server, path: '/api/console/ws' });
setupWebSocket(wss);

// Middleware
app.use(helmet({
  contentSecurityPolicy: false, // Disable for SPA
}));
app.use(compression());
app.use(cors({
  origin: config.corsOrigins === '*' ? '*' : config.corsOrigins.split(','),
  credentials: true,
}));
app.use(express.json());

// API Routes
app.use('/api/auth', authRoutes);
app.use('/api/server', serverRoutes);
app.use('/api/console', consoleRoutes);
app.use('/api/backups', backupRoutes);
app.use('/api/players', playersRoutes);
app.use('/api/management', managementRoutes);

// Health check
app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', service: 'hytale-manager' });
});

// Serve static frontend files
const staticPath = path.join(__dirname, '..', 'static');
app.use('/assets', express.static(path.join(staticPath, 'assets')));

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
server.listen(config.port, '0.0.0.0', () => {
  console.log(`
╔═══════════════════════════════════════════════════╗
║         Hytale Server Manager v1.0.0              ║
╠═══════════════════════════════════════════════════╣
║  Server running on http://0.0.0.0:${config.port}         ║
║  Target container: ${config.gameContainerName.padEnd(28)}║
╚═══════════════════════════════════════════════════╝
  `);
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('SIGTERM received, shutting down...');
  server.close(() => {
    process.exit(0);
  });
});

process.on('SIGINT', () => {
  console.log('SIGINT received, shutting down...');
  server.close(() => {
    process.exit(0);
  });
});
