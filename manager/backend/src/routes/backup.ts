import { Router, Request, Response } from 'express';
import fs from 'fs';
import path from 'path';
import { pipeline } from 'stream';
import { authMiddleware } from '../middleware/auth.js';
import { requirePermission } from '../middleware/permissions.js';
import * as backupService from '../services/backup.js';
import { startRestore, type RestoreSource } from '../services/backupRestore.js';
import * as nativeBackups from '../services/nativeBackups.js';
import {
  getBackupJob,
  listBackupJobs,
  runningBackupJob,
  startBackupJob,
  waitForBackupJob,
} from '../services/backupJobs.js';
import { audit } from '../services/audit.js';
import { isDemoMode, getDemoBackups } from '../services/demoData.js';
import { resolveServerIdSync } from '../services/servers.js';

const router = Router();

// Demo storage info
const DEMO_STORAGE = {
  used: 1.8 * 1024 * 1024 * 1024, // 1.8 GB
  total: 50 * 1024 * 1024 * 1024, // 50 GB
  free: 48.2 * 1024 * 1024 * 1024, // 48.2 GB
};

function streamFile(res: Response, filePath: string, contentType: string): void {
  // Use streaming for large file downloads to prevent memory exhaustion
  const stat = fs.statSync(filePath);
  const filename = path.basename(filePath) || 'backup.tar.gz';

  res.setHeader('Content-Type', contentType);
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.setHeader('Content-Length', stat.size);

  // pipeline() closes the file when the client aborts and ends the response
  // on a read error (pipe() would leak the descriptor or leave it hanging).
  pipeline(fs.createReadStream(filePath), res, (err) => {
    if (!err) return;
    if ((err as NodeJS.ErrnoException).code !== 'ERR_STREAM_PREMATURE_CLOSE') {
      console.error('Backup download stream error:', err);
    }
    if (!res.headersSent) res.status(500).json({ detail: 'Error streaming backup file' });
    else res.destroy(err);
  });
}

/**
 * Start a restore job. Answers 202 with the job right away; the client polls
 * GET /jobs/:jobId. `?wait=true` keeps the old blocking behaviour for API
 * scripts (the request then stays open until the restore has finished).
 */
async function handleRestore(req: Request, res: Response, source: RestoreSource): Promise<void> {
  const started = await startRestore(source, req.serverId, req.user);
  if (!started.ok) {
    res.status(started.status).json({ success: false, error: started.error });
    return;
  }
  audit(req, 'backup.restore', {
    target: started.job.target,
    metadata: { jobId: started.job.id, type: started.job.type },
  });
  if (req.query.wait === 'true') {
    const finished = await waitForBackupJob(started.job.id)!;
    const ok = finished.state === 'succeeded';
    res.status(ok ? 200 : 500).json({
      success: ok,
      message: finished.message ?? undefined,
      error: finished.error ?? undefined,
      job: finished,
    });
    return;
  }
  res.status(202).json({ success: true, message: 'Restore started', job: started.job });
}

// GET /api/backups
router.get(
  '/',
  authMiddleware,
  requirePermission('backups.view'),
  async (req: Request, res: Response) => {
    const serverId = (req as { serverId?: string }).serverId;
    // Demo mode: return mock backups
    if (isDemoMode()) {
      const demoBackups = getDemoBackups();
      res.json({
        backups: demoBackups.map((b) => ({
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

    const backups = await backupService.listBackups(serverId);
    const storage = await backupService.getStorageInfo(serverId);

    res.json({ backups, storage });
  },
);

// GET /api/backups/jobs - restore / native backup jobs of this server scope, newest first
router.get(
  '/jobs',
  authMiddleware,
  requirePermission('backups.view'),
  (req: Request, res: Response) => {
    const scope = resolveServerIdSync(req.serverId);
    const jobs = listBackupJobs().filter((j) => j.serverId === scope);
    // Only one job runs at a time; `running` tells the UI to wait even if it
    // belongs to another server.
    res.json({
      jobs,
      running: jobs.find((j) => j.state === 'running') ?? null,
      busy: !!runningBackupJob(),
    });
  },
);

// GET /api/backups/jobs/:jobId - only jobs of this server scope (like the list)
router.get(
  '/jobs/:jobId',
  authMiddleware,
  requirePermission('backups.view'),
  (req: Request, res: Response) => {
    const job = getBackupJob(req.params.jobId);
    if (!job || job.serverId !== resolveServerIdSync(req.serverId)) {
      res.status(404).json({ detail: 'Job not found' });
      return;
    }
    res.json(job);
  },
);

// GET /api/backups/native - the server's own backups (native/ and native/archive/)
router.get(
  '/native',
  authMiddleware,
  requirePermission('backups.view'),
  async (req: Request, res: Response) => {
    if (isDemoMode()) {
      res.json({
        directory: '/opt/hytale/backups/native',
        available: false,
        inProgress: false,
        backups: [],
      });
      return;
    }
    res.json(await nativeBackups.listNativeBackups(req.serverId));
  },
);

// POST /api/backups/native - ask the running server for a native backup (job)
router.post(
  '/native',
  authMiddleware,
  requirePermission('backups.create'),
  (req: Request, res: Response) => {
    if (isDemoMode()) {
      res.json({ success: true, message: '[DEMO] Native backup created (simulated)' });
      return;
    }
    const running = runningBackupJob();
    if (running) {
      res
        .status(409)
        .json({ success: false, error: `Another backup job is running (${running.type})` });
      return;
    }
    const serverId = req.serverId;
    const job = startBackupJob(
      { type: 'native-create', serverId, target: 'native', startedBy: req.user },
      async (control) => {
        control.setStep('backing-up');
        const created = await nativeBackups.createNativeBackup(serverId);
        return { message: `Native backup ${created.name} created` };
      },
    );
    audit(req, 'backup.native_create', { metadata: { jobId: job.id } });
    res.status(202).json({ success: true, message: 'Native backup started', job });
  },
);

// GET /api/backups/native/:scope/:name/download
router.get(
  '/native/:scope/:name/download',
  authMiddleware,
  requirePermission('backups.download'),
  async (req: Request, res: Response) => {
    if (isDemoMode()) {
      res.status(400).json({ detail: '[DEMO] Download not available in demo mode' });
      return;
    }
    const file = await nativeBackups.getNativeBackupPath(
      req.params.scope,
      req.params.name,
      req.serverId,
    );
    if (!file) {
      res.status(404).json({ detail: 'Native backup not found' });
      return;
    }
    streamFile(res, file, 'application/zip');
  },
);

// DELETE /api/backups/native/:scope/:name
router.delete(
  '/native/:scope/:name',
  authMiddleware,
  requirePermission('backups.delete'),
  async (req: Request, res: Response) => {
    if (isDemoMode()) {
      res.json({ success: true, message: '[DEMO] Native backup deleted (simulated)' });
      return;
    }
    const result = await nativeBackups.deleteNativeBackup(
      req.params.scope,
      req.params.name,
      req.serverId,
    );
    if (!result.success) {
      res.status(result.error === 'Native backup not found' ? 404 : 500).json(result);
      return;
    }
    audit(req, 'backup.native_delete', { target: `${req.params.scope}/${req.params.name}` });
    res.json({ success: true, message: 'Native backup deleted' });
  },
);

// POST /api/backups/native/:scope/:name/restore - replace the universe with a native zip
router.post(
  '/native/:scope/:name/restore',
  authMiddleware,
  requirePermission('backups.restore'),
  async (req: Request, res: Response) => {
    if (isDemoMode()) {
      res.json({ success: true, message: '[DEMO] Native backup restored (simulated)' });
      return;
    }
    const { scope, name } = req.params;
    if (!nativeBackups.isNativeBackupScope(scope)) {
      res.status(400).json({ success: false, error: 'Invalid native backup' });
      return;
    }
    await handleRestore(req, res, { kind: 'native', scope, name });
  },
);

// POST /api/backups/native/:scope/:name/offsite - upload a native zip off-site
router.post(
  '/native/:scope/:name/offsite',
  authMiddleware,
  requirePermission('backups.create'),
  async (req: Request, res: Response) => {
    if (isDemoMode()) {
      res.json({ success: true, message: '[DEMO] Off-site upload (simulated)' });
      return;
    }
    const file = await nativeBackups.getNativeBackupPath(
      req.params.scope,
      req.params.name,
      req.serverId,
    );
    if (!file) {
      res.status(404).json({ success: false, error: 'Native backup not found' });
      return;
    }
    const { uploadBackup } = await import('../services/offsiteBackup.js');
    const result = await uploadBackup(file);
    if (!result.success) {
      res.status(502).json(result);
      return;
    }
    res.json({ success: true, message: 'Backup uploaded off-site', key: result.key });
  },
);

// GET /api/backups/:id
router.get(
  '/:id',
  authMiddleware,
  requirePermission('backups.view'),
  async (req: Request, res: Response) => {
    // Demo mode: return mock backup
    if (isDemoMode()) {
      const demoBackups = getDemoBackups();
      const backup = demoBackups.find((b) => b.name === req.params.id);
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

    const backup = await backupService.getBackup(
      req.params.id,
      (req as { serverId?: string }).serverId,
    );

    if (!backup) {
      res.status(404).json({ detail: 'Backup not found' });
      return;
    }

    res.json(backup);
  },
);

// POST /api/backups
router.post(
  '/',
  authMiddleware,
  requirePermission('backups.create'),
  async (req: Request, res: Response) => {
    // Demo mode: simulate backup creation
    if (isDemoMode()) {
      const { name } = req.body || {};
      const backupName =
        name || `backup_${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}.tar.gz`;
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
    const result = await backupService.createBackup(
      typeof name === 'string' && name ? name : {},
      req.serverId,
    );

    if (!result.success) {
      res.status(500).json(result);
      return;
    }

    res.json({
      success: true,
      message: result.message ?? 'Backup created successfully',
      warning: result.warning,
      backup: result.backup,
    });
  },
);

// DELETE /api/backups/:id
router.delete(
  '/:id',
  authMiddleware,
  requirePermission('backups.delete'),
  async (req: Request, res: Response) => {
    // Demo mode: simulate deletion
    if (isDemoMode()) {
      res.json({ success: true, message: '[DEMO] Backup deleted (simulated)' });
      return;
    }

    const result = await backupService.deleteBackup(req.params.id, req.serverId);

    if (!result.success) {
      res.status(500).json(result);
      return;
    }

    res.json(result);
  },
);

// POST /api/backups/:id/restore
router.post(
  '/:id/restore',
  authMiddleware,
  requirePermission('backups.restore'),
  async (req: Request, res: Response) => {
    // Demo mode: simulate restore
    if (isDemoMode()) {
      res.json({ success: true, message: '[DEMO] Backup restored (simulated)' });
      return;
    }
    await handleRestore(req, res, { kind: 'panel', backupId: req.params.id });
  },
);

// GET /api/backups/:id/download
router.get(
  '/:id/download',
  authMiddleware,
  requirePermission('backups.download'),
  async (req: Request, res: Response) => {
    // Demo mode: return error (can't download simulated files)
    if (isDemoMode()) {
      res.status(400).json({ detail: '[DEMO] Download not available in demo mode' });
      return;
    }

    const filePath = await backupService.getBackupPath(
      req.params.id,
      (req as { serverId?: string }).serverId,
    );

    if (!filePath) {
      res.status(404).json({ detail: 'Backup not found' });
      return;
    }

    streamFile(res, filePath, filePath.endsWith('.zip') ? 'application/zip' : 'application/gzip');
  },
);

// POST /api/backups/:id/offsite — upload an existing backup to off-site storage.
router.post(
  '/:id/offsite',
  authMiddleware,
  requirePermission('backups.create'),
  async (req: Request, res: Response) => {
    if (isDemoMode()) {
      res.json({ success: true, message: '[DEMO] Off-site upload (simulated)' });
      return;
    }

    const filePath = await backupService.getBackupPath(
      req.params.id,
      (req as { serverId?: string }).serverId,
    );
    if (!filePath) {
      res.status(404).json({ success: false, error: 'Backup not found' });
      return;
    }

    const { uploadBackup } = await import('../services/offsiteBackup.js');
    const result = await uploadBackup(filePath);
    if (!result.success) {
      res.status(502).json(result);
      return;
    }
    res.json({ success: true, message: 'Backup uploaded off-site', key: result.key });
  },
);

export default router;
