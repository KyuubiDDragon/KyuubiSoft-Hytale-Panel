import { Router, Request, Response } from 'express';
import fs from 'fs';
import { authMiddleware } from '../middleware/auth.js';
import { requirePermission } from '../middleware/permissions.js';
import * as backupService from '../services/backup.js';
import { isDemoMode, getDemoBackups } from '../services/demoData.js';

const router = Router();

// Demo storage info
const DEMO_STORAGE = {
  used: 1.8 * 1024 * 1024 * 1024, // 1.8 GB
  total: 50 * 1024 * 1024 * 1024, // 50 GB
  free: 48.2 * 1024 * 1024 * 1024, // 48.2 GB
};

// GET /api/backups
router.get('/', authMiddleware, requirePermission('backups.view'), (_req: Request, res: Response) => {
  // Demo mode: return mock backups
  if (isDemoMode()) {
    const demoBackups = getDemoBackups();
    res.json({
      backups: demoBackups.map(b => ({
        id: b.name,
        name: b.name,
        size: b.size,
        created: b.created,
        type: b.type,
      })),
      storage: DEMO_STORAGE,
    });
    return;
  }

  const backups = backupService.listBackups();
  const storage = backupService.getStorageInfo();

  res.json({ backups, storage });
});

// GET /api/backups/:id
router.get('/:id', authMiddleware, requirePermission('backups.view'), (req: Request, res: Response) => {
  // Demo mode: return mock backup
  if (isDemoMode()) {
    const demoBackups = getDemoBackups();
    const backup = demoBackups.find(b => b.name === req.params.id);
    if (!backup) {
      res.status(404).json({ detail: 'Backup not found' });
      return;
    }
    res.json({
      id: backup.name,
      name: backup.name,
      size: backup.size,
      created: backup.created,
      type: backup.type,
    });
    return;
  }

  const backup = backupService.getBackup(req.params.id);

  if (!backup) {
    res.status(404).json({ detail: 'Backup not found' });
    return;
  }

  res.json(backup);
});

// POST /api/backups
router.post('/', authMiddleware, requirePermission('backups.create'), (req: Request, res: Response) => {
  // Demo mode: simulate backup creation
  if (isDemoMode()) {
    const { name } = req.body || {};
    const backupName = name || `backup_${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}.tar.gz`;
    res.json({
      success: true,
      message: '[DEMO] Backup created successfully (simulated)',
      backup: {
        id: backupName,
        name: backupName,
        size: Math.floor(150 + Math.random() * 100) * 1024 * 1024,
        created: new Date().toISOString(),
        type: 'manual',
      },
    });
    return;
  }

  const { name } = req.body || {};
  const result = backupService.createBackup(name);

  if (!result.success) {
    res.status(500).json(result);
    return;
  }

  res.json({
    success: true,
    message: 'Backup created successfully',
    backup: result.backup,
  });
});

// DELETE /api/backups/:id
router.delete('/:id', authMiddleware, requirePermission('backups.delete'), (req: Request, res: Response) => {
  // Demo mode: simulate deletion
  if (isDemoMode()) {
    res.json({ success: true, message: '[DEMO] Backup deleted (simulated)' });
    return;
  }

  const result = backupService.deleteBackup(req.params.id);

  if (!result.success) {
    res.status(500).json(result);
    return;
  }

  res.json(result);
});

// POST /api/backups/:id/restore
router.post('/:id/restore', authMiddleware, requirePermission('backups.restore'), (req: Request, res: Response) => {
  // Demo mode: simulate restore
  if (isDemoMode()) {
    res.json({ success: true, message: '[DEMO] Backup restored (simulated)' });
    return;
  }

  const result = backupService.restoreBackup(req.params.id);

  if (!result.success) {
    res.status(500).json(result);
    return;
  }

  res.json(result);
});

// GET /api/backups/:id/download
router.get('/:id/download', authMiddleware, requirePermission('backups.download'), (req: Request, res: Response) => {
  // Demo mode: return error (can't download simulated files)
  if (isDemoMode()) {
    res.status(400).json({ detail: '[DEMO] Download not available in demo mode' });
    return;
  }

  const filePath = backupService.getBackupPath(req.params.id);

  if (!filePath) {
    res.status(404).json({ detail: 'Backup not found' });
    return;
  }

  // Use streaming for large file downloads to prevent memory exhaustion
  const stat = fs.statSync(filePath);
  const filename = filePath.split('/').pop() || 'backup.tar.gz';

  res.setHeader('Content-Type', 'application/gzip');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.setHeader('Content-Length', stat.size);

  const readStream = fs.createReadStream(filePath);

  readStream.on('error', (err) => {
    console.error('Backup download stream error:', err);
    if (!res.headersSent) {
      res.status(500).json({ detail: 'Error streaming backup file' });
    }
  });

  readStream.pipe(res);
});

export default router;
