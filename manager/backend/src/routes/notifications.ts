import { Router, Response } from 'express';
import { authMiddleware } from '../middleware/auth.js';
import type { AuthenticatedRequest } from '../types/index.js';
import {
  listNotifications, markRead, dismissAll,
  getPreferences, setPreference,
} from '../services/notifications.js';

const router = Router();

router.get('/', authMiddleware, (req: AuthenticatedRequest, res: Response) => {
  const unreadOnly = req.query.unreadOnly === 'true';
  const limit = req.query.limit ? parseInt(req.query.limit as string, 10) : undefined;
  res.json({ notifications: listNotifications(req.user!, { unreadOnly, limit }) });
});

router.post('/:id/read', authMiddleware, (req: AuthenticatedRequest, res: Response) => {
  const id = parseInt(req.params.id, 10);
  if (Number.isNaN(id)) { res.status(400).json({ detail: 'Invalid id' }); return; }
  markRead(req.user!, id);
  res.json({ success: true });
});

router.post('/dismiss-all', authMiddleware, (req: AuthenticatedRequest, res: Response) => {
  const dismissed = dismissAll(req.user!);
  res.json({ success: true, dismissed });
});

router.get('/preferences', authMiddleware, (req: AuthenticatedRequest, res: Response) => {
  res.json({ preferences: getPreferences(req.user!) });
});

router.put('/preferences', authMiddleware, (req: AuthenticatedRequest, res: Response) => {
  const body = req.body as Record<string, { inApp?: boolean; email?: boolean; webhook?: boolean }>;
  for (const [eventName, pref] of Object.entries(body)) {
    setPreference(req.user!, eventName, pref);
  }
  res.json({ success: true });
});

export default router;
