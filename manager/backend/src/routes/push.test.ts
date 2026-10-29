/**
 * /api/push/subscribe answers refusals with a machine-readable code, so the
 * panel can show them in the user's language instead of the English text.
 */
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import type { NextFunction, Request, Response } from 'express';
import type { AddressInfo } from 'net';
import type { Server } from 'http';

const { state } = vi.hoisted(() => ({ state: { saved: true } }));

vi.mock('../middleware/auth.js', () => ({
  authMiddleware: (req: Request & { user?: string }, _res: Response, next: NextFunction) => {
    req.user = 'alice';
    next();
  },
}));
vi.mock('../services/webPush.js', () => ({
  getVapidPublicKey: async () => null,
  isAllowedPushEndpoint: (endpoint: string) => endpoint.startsWith('https://push.example/'),
  saveSubscription: () => state.saved,
  removeSubscription: () => true,
  countSubscriptions: () => 1,
  pushToUser: async () => 0,
}));

const express = (await import('express')).default;
const { default: pushRouter } = await import('./push.js');

let server: Server;
let base: string;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/push', pushRouter);
  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', () => resolve());
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

function subscribe(endpoint: string) {
  return fetch(`${base}/api/push/subscribe`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ endpoint, keys: { p256dh: 'k', auth: 'a' } }),
  });
}

describe('POST /api/push/subscribe', () => {
  it('stores a subscription from a known push service', async () => {
    state.saved = true;
    const res = await subscribe('https://push.example/abc');
    expect(res.status).toBe(200);
  });

  it('names an unknown push host with a code', async () => {
    const res = await subscribe('https://elsewhere.example/abc');
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: 'PUSH_ENDPOINT_UNKNOWN' });
  });

  it('names a subscription of another account with a code', async () => {
    state.saved = false;
    const res = await subscribe('https://push.example/abc');
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: 'PUSH_SUBSCRIPTION_FOREIGN' });
  });
});
