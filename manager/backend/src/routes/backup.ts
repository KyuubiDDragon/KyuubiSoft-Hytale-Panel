import { Router, Request, Response } from 'express';
import fs from 'fs';
import { authMiddleware } from '../middleware/auth.js';
import * as backupService from '../services/backup.js';

const router = Router();

// GET /api/backups
router.get('/', authMiddleware, (_req: Request, res: Response) => {
  const backups = backupService.listBackups();
  const storage = backupService.getStorageInfo();

  res.json({ backups, storage });
});

// GET /api/backups/:id
router.get('/:id', authMiddleware, (req: Request, res: Response) => {
  const backup = backupService.getBackup(req.params.id);

  if (!backup) {
    res.status(404).json({ detail: 'Backup not found' });
    return;
  }

  res.json(backup);
});

// POST /api/backups
router.post('/', authMiddleware, (req: Request, res: Response) => {
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
router.delete('/:id', authMiddleware, (req: Request, res: Response) => {
  const result = backupService.deleteBackup(req.params.id);

  if (!result.success) {
    res.status(500).json(result);
    return;
  }

  res.json(result);
});

// POST /api/backups/:id/restore
router.post('/:id/restore', authMiddleware, (req: Request, res: Response) => {
  const result = backupService.restoreBackup(req.params.id);

  if (!result.success) {
    res.status(500).json(result);
    return;
  }

  res.json(result);
});

// GET /api/backups/:id/download
router.get('/:id/download', authMiddleware, (req: Request, res: Response) => {
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
