// Web Push (PWA) subscription management.
//
// A browser obtains the VAPID public key, registers a PushSubscription with its
// push service, and POSTs it here. Alert-worthy panel events then fan out to
// the user's devices via services/webPush. All routes require an authenticated
// session; subscriptions are owned by the requesting user.
import { Router, Response } from 'express';
import { authMiddleware } from '../middleware/auth.js';
import type { AuthenticatedRequest } from '../types/index.js';
import { logger } from '../utils/logger.js';
import {
  getVapidPublicKey,
  saveSubscription,
  removeSubscription,
  countSubscriptions,
  pushToUser,
  type PushSubscriptionInput,
} from '../services/webPush.js';

const router = Router();

// GET /api/push/vapid-public-key — the application server key for subscribe(),
// or { enabled: false } when Web Push is off.
router.get('/vapid-public-key', authMiddleware, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const key = await getVapidPublicKey();
    if (!key) {
      res.json({ enabled: false, key: null, devices: 0 });
      return;
    }
    res.json({ enabled: true, key, devices: countSubscriptions(req.user || '') });
  } catch (error) {
    logger.error('[push] failed to read VAPID key:', error);
    res.status(500).json({ error: 'Failed to read push configuration' });
  }
});

function isValidSubscription(v: unknown): v is PushSubscriptionInput {
  const s = v as PushSubscriptionInput | undefined;
  return !!(s && typeof s.endpoint === 'string' && /^https:\/\//.test(s.endpoint)
    && s.keys && typeof s.keys.p256dh === 'string' && typeof s.keys.auth === 'string');
}

// POST /api/push/subscribe — persist a PushSubscription for this user/device.
router.post('/subscribe', authMiddleware, async (req: AuthenticatedRequest, res: Response) => {
  const sub = req.body?.subscription ?? req.body;
  if (!isValidSubscription(sub)) {
    res.status(400).json({ error: 'Invalid push subscription' });
    return;
  }
  try {
    saveSubscription(req.user || 'unknown', sub, String(req.headers['user-agent'] || '').slice(0, 256));
    res.json({ success: true, devices: countSubscriptions(req.user || '') });
  } catch (error) {
    logger.error('[push] failed to save subscription:', error);
    res.status(500).json({ error: 'Failed to save subscription' });
  }
});

// POST /api/push/unsubscribe — remove a subscription by endpoint.
router.post('/unsubscribe', authMiddleware, async (req: AuthenticatedRequest, res: Response) => {
  const endpoint = req.body?.endpoint;
  if (typeof endpoint !== 'string' || !endpoint) {
    res.status(400).json({ error: 'Missing endpoint' });
    return;
  }
  removeSubscription(endpoint);
  res.json({ success: true, devices: countSubscriptions(req.user || '') });
});

// POST /api/push/test — send a test notification to this user's devices.
router.post('/test', authMiddleware, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const user = req.user || '';
    if (countSubscriptions(user) === 0) {
      res.status(400).json({ error: 'No subscribed devices' });
      return;
    }
    await pushToUser(user, {
      title: 'KyuubiSoft Hytale Panel',
      body: 'Push notifications are working 🎉',
      level: 'success',
      link: '/',
    });
    res.json({ success: true });
  } catch (error) {
    logger.error('[push] test failed:', error);
    res.status(500).json({ error: 'Failed to send test notification' });
  }
});

export default router;
