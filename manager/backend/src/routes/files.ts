import { Router, Response } from 'express';
import multer from 'multer';
import rateLimit from 'express-rate-limit';
import { authMiddleware } from '../middleware/auth.js';
import { requirePermission } from '../middleware/permissions.js';
import { AuthenticatedRequest } from '../types/index.js';
import { logActivity } from '../services/activityLog.js';
import {
  getRoots,
  listDir,
  readFile,
  writeFile,
  deleteFile,
  moveFile,
  uploadFile,
  openDownloadStream,
  FileManagerError,
  MAX_WRITE_BYTES,
} from '../services/fileManager.js';
import { verifyUploadMagic } from '../services/managementHelpers.js';

const router = Router();

// ============================================================
// Helpers
// ============================================================

function fmError(res: Response, err: unknown): void {
  if (err instanceof FileManagerError) {
    res.status(err.status).json({ error: err.message, code: err.code });
    return;
  }
  const msg = err instanceof Error ? err.message : 'Unknown error';
  console.error('[files] Unexpected error:', err);
  res.status(500).json({ error: 'Internal server error', detail: msg });
}

async function audit(
  req: AuthenticatedRequest,
  action: string,
  target: string,
  success: boolean,
  details?: string,
): Promise<void> {
  try {
    await logActivity(
      req.user || 'unknown',
      action,
      'config',
      success,
      target,
      details,
    );
  } catch (e) {
    console.error('[files] audit failed:', e);
  }
}

// ============================================================
// Rate limiter for write operations (30/min per user)
// ============================================================

const writeRateLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many write operations, slow down', code: 'RATE_LIMITED' },
  keyGenerator: (req) => {
    const aReq = req as AuthenticatedRequest;
    return aReq.user || req.ip || 'unknown';
  },
});

// ============================================================
// Multer for in-memory uploads
// ============================================================

const uploadMw = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_WRITE_BYTES },
});

// ============================================================
// JSON body limit override for /write (content can be up to ~13 MB base64)
// Note: global express.json() limit is 100kb, so we need a larger one here
// ============================================================

import express from 'express';
const writeJsonParser = express.json({ limit: '15mb' });

// ============================================================
// Routes
// ============================================================

// GET /api/files/roots
router.get(
  '/roots',
  authMiddleware,
  requirePermission('files.read'),
  (_req: AuthenticatedRequest, res: Response) => {
    const roots = getRoots().map((r) => ({
      id: r.id,
      path: r.path,
      rw: r.rw,
      label: r.label || r.id,
      permission: r.permission,
    }));
    res.json({ roots });
  },
);

// GET /api/files/list?rootId=&path=
router.get(
  '/list',
  authMiddleware,
  requirePermission('files.read'),
  async (req: AuthenticatedRequest, res: Response) => {
    const rootId = String(req.query.rootId || '');
    const relPath = String(req.query.path || '');
    if (!rootId) {
      res.status(400).json({ error: 'rootId is required' });
      return;
    }
    try {
      const result = await listDir(rootId, relPath);
      res.json(result);
    } catch (err) {
      fmError(res, err);
    }
  },
);

// GET /api/files/read?rootId=&path=
router.get(
  '/read',
  authMiddleware,
  requirePermission('files.read'),
  async (req: AuthenticatedRequest, res: Response) => {
    const rootId = String(req.query.rootId || '');
    const relPath = String(req.query.path || '');
    if (!rootId || !relPath) {
      res.status(400).json({ error: 'rootId and path are required' });
      return;
    }
    try {
      const result = await readFile(rootId, relPath);
      res.json({
        rootId,
        path: relPath,
        ...result,
      });
    } catch (err) {
      fmError(res, err);
    }
  },
);

// PUT /api/files/write
router.put(
  '/write',
  authMiddleware,
  requirePermission('files.write'),
  writeRateLimiter,
  writeJsonParser,
  async (req: AuthenticatedRequest, res: Response) => {
    const { rootId, path: relPath, content, encoding, ifMatchMtime } =
      req.body as {
        rootId?: string;
        path?: string;
        content?: string;
        encoding?: 'utf-8' | 'base64';
        ifMatchMtime?: number;
      };

    if (!rootId || !relPath || content === undefined) {
      res.status(400).json({ error: 'rootId, path and content are required' });
      return;
    }

    try {
      const result = await writeFile(
        rootId,
        relPath,
        content,
        encoding || 'utf-8',
        ifMatchMtime,
      );
      await audit(req, 'file.write', `files:${rootId}:${relPath}`, true);
      res.json({ ok: true, ...result });
    } catch (err) {
      await audit(
        req,
        'file.write',
        `files:${rootId}:${relPath}`,
        false,
        err instanceof Error ? err.message : 'error',
      );
      fmError(res, err);
    }
  },
);

// POST /api/files/upload (multipart) - fields: rootId, path (target dir), file
router.post(
  '/upload',
  authMiddleware,
  requirePermission('files.write'),
  writeRateLimiter,
  uploadMw.single('file'),
  async (req: AuthenticatedRequest, res: Response) => {
    const rootId = String(req.body.rootId || '');
    const relPath = String(req.body.path || '');
    const file = req.file;

    if (!rootId) {
      res.status(400).json({ error: 'rootId is required' });
      return;
    }
    if (!file) {
      res.status(400).json({ error: 'file is required' });
      return;
    }

    // Reject content that doesn't match a claimed binary/archive extension
    // (e.g. a script renamed to .zip/.jar). Unknown extensions pass through.
    const magic = verifyUploadMagic(file.buffer, file.originalname);
    if (!magic.ok) {
      res.status(400).json({ error: magic.error });
      return;
    }

    try {
      const result = await uploadFile(rootId, relPath, {
        buffer: file.buffer,
        originalname: file.originalname,
        size: file.size,
      });
      await audit(req, 'file.upload', `files:${rootId}:${relPath}/${file.originalname}`, true);
      res.json({ ok: true, name: file.originalname, ...result });
    } catch (err) {
      await audit(
        req,
        'file.upload',
        `files:${rootId}:${relPath}`,
        false,
        err instanceof Error ? err.message : 'error',
      );
      fmError(res, err);
    }
  },
);

// DELETE /api/files
router.delete(
  '/',
  authMiddleware,
  requirePermission('files.write'),
  writeRateLimiter,
  async (req: AuthenticatedRequest, res: Response) => {
    const { rootId, path: relPath, confirmToken } = req.body as {
      rootId?: string;
      path?: string;
      confirmToken?: string;
    };
    if (!rootId || !relPath) {
      res.status(400).json({ error: 'rootId and path are required' });
      return;
    }
    if (!confirmToken) {
      res.status(400).json({ error: 'confirmToken is required' });
      return;
    }
    try {
      await deleteFile(rootId, relPath);
      await audit(req, 'file.delete', `files:${rootId}:${relPath}`, true);
      res.json({ ok: true });
    } catch (err) {
      await audit(
        req,
        'file.delete',
        `files:${rootId}:${relPath}`,
        false,
        err instanceof Error ? err.message : 'error',
      );
      fmError(res, err);
    }
  },
);

// POST /api/files/move
router.post(
  '/move',
  authMiddleware,
  requirePermission('files.write'),
  writeRateLimiter,
  async (req: AuthenticatedRequest, res: Response) => {
    const { rootId, from, to } = req.body as {
      rootId?: string;
      from?: string;
      to?: string;
    };
    if (!rootId || !from || !to) {
      res.status(400).json({ error: 'rootId, from and to are required' });
      return;
    }
    try {
      await moveFile(rootId, from, to);
      await audit(req, 'file.move', `files:${rootId}:${from} -> ${to}`, true);
      res.json({ ok: true });
    } catch (err) {
      await audit(
        req,
        'file.move',
        `files:${rootId}:${from} -> ${to}`,
        false,
        err instanceof Error ? err.message : 'error',
      );
      fmError(res, err);
    }
  },
);

// GET /api/files/download?rootId=&path=
router.get(
  '/download',
  authMiddleware,
  requirePermission('files.read'),
  async (req: AuthenticatedRequest, res: Response) => {
    const rootId = String(req.query.rootId || '');
    const relPath = String(req.query.path || '');
    if (!rootId || !relPath) {
      res.status(400).json({ error: 'rootId and path are required' });
      return;
    }
    try {
      const { stream, size, filename } = await openDownloadStream(rootId, relPath);
      res.setHeader('Content-Type', 'application/octet-stream');
      res.setHeader('Content-Length', String(size));
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="${filename.replace(/"/g, '')}"`,
      );
      stream.on('error', (err) => {
        console.error('[files] download stream error:', err);
        if (!res.headersSent) {
          res.status(500).end();
        } else {
          res.end();
        }
      });
      stream.pipe(res);
    } catch (err) {
      fmError(res, err);
    }
  },
);

export default router;
