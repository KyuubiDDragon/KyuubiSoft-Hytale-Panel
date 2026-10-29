/**
 * Web Push subscriptions: only endpoints of the browsers' push services are
 * taken (or hosts the operator adds with WEB_PUSH_EXTRA_HOSTS), another
 * user's subscription is neither taken over nor removed, and a push is never
 * sent to an endpoint outside that list.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import path from 'path';
import os from 'os';
import fs from 'fs';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kp-web-push-'));
process.env.MANAGER_DATA_PATH = tmpDir;

const { sendNotification } = vi.hoisted(() => ({ sendNotification: vi.fn(async () => ({})) }));
vi.mock('web-push', () => ({
  default: { sendNotification, setVapidDetails: () => undefined, generateVAPIDKeys: () => ({}) },
  sendNotification,
  setVapidDetails: () => undefined,
  generateVAPIDKeys: () => ({}),
}));
vi.mock('./configService.js', () => ({
  getConfig: async () => ({
    webPush: {
      enabled: true,
      vapidPublicKey: 'pub',
      vapidPrivateKey: 'priv',
      subject: 'mailto:a@b.c',
    },
  }),
  updateConfig: async () => undefined,
}));

const push = await import('./webPush.js');
const { getDb } = await import('../db/index.js');

const FCM = 'https://fcm.googleapis.com/fcm/send/abc123';
const sub = (endpoint: string, p256dh = 'key-1', auth = 'auth-1') => ({
  endpoint,
  keys: { p256dh, auth },
});
const owner = (endpoint: string) =>
  (
    getDb().prepare('SELECT username FROM push_subscriptions WHERE endpoint = ?').get(endpoint) as
      { username: string } | undefined
  )?.username;

beforeEach(() => {
  getDb().prepare('DELETE FROM push_subscriptions').run();
  sendNotification.mockClear();
});

afterEach(() => {
  delete process.env.WEB_PUSH_EXTRA_HOSTS;
});

describe('push endpoints', () => {
  it.each([
    FCM,
    'https://updates.push.services.mozilla.com/wpush/v2/gAAA',
    'https://wns2-par02p.notify.windows.com/w/?token=x',
    'https://web.push.apple.com/QAbc',
  ])('takes the push service endpoint %s', (endpoint) => {
    expect(push.isAllowedPushEndpoint(endpoint)).toBe(true);
  });

  it.each([
    'https://169.254.169.254/latest/meta-data/',
    'https://internal.example.com/hook',
    'http://fcm.googleapis.com/fcm/send/x',
    'https://fcm.googleapis.com.evil.example/x',
  ])('refuses %s', (endpoint) => {
    expect(push.isAllowedPushEndpoint(endpoint)).toBe(false);
  });

  it('takes hosts the operator adds', () => {
    process.env.WEB_PUSH_EXTRA_HOSTS = 'push.example.org, Other.Example';
    expect(push.isAllowedPushEndpoint('https://push.example.org/x')).toBe(true);
    expect(push.isAllowedPushEndpoint('https://a.other.example/x')).toBe(true);
    expect(push.isAllowedPushEndpoint('https://example.org/x')).toBe(false);
  });
});

describe('subscriptions', () => {
  it('does not hand another user the subscription of a device', () => {
    expect(push.saveSubscription('alice', sub(FCM))).toBe(true);
    expect(push.saveSubscription('mallory', sub(FCM, 'key-x', 'auth-x'))).toBe(false);
    expect(owner(FCM)).toBe('alice');
  });

  it('moves a subscription to the user now signed in on the same browser', () => {
    push.saveSubscription('alice', sub(FCM));
    // the same browser hands over the same endpoint with the same keys
    expect(push.saveSubscription('bob', sub(FCM))).toBe(true);
    expect(owner(FCM)).toBe('bob');
  });

  it('lets the owner renew the keys', () => {
    push.saveSubscription('alice', sub(FCM));
    expect(push.saveSubscription('alice', sub(FCM, 'key-2', 'auth-2'))).toBe(true);
    expect(push.countSubscriptions('alice')).toBe(1);
  });

  it('removes a subscription only for its owner', () => {
    push.saveSubscription('alice', sub(FCM));
    expect(push.removeSubscription(FCM, 'mallory')).toBe(false);
    expect(owner(FCM)).toBe('alice');
    expect(push.removeSubscription(FCM, 'alice')).toBe(true);
    expect(owner(FCM)).toBeUndefined();
  });

  it('never sends to an endpoint outside the push services', async () => {
    push.saveSubscription('alice', sub(FCM));
    getDb()
      .prepare(
        `INSERT INTO push_subscriptions (username, endpoint, p256dh, auth, created_at) VALUES ('alice', 'https://10.0.0.5/x', 'k', 'a', 'now')`,
      )
      .run();
    await push.pushToUser('alice', { title: 'Test' });
    expect(sendNotification).toHaveBeenCalledTimes(1);
    const [target, , options] = sendNotification.mock.calls[0] as unknown as [
      { endpoint: string },
      string,
      { timeout?: number; agent?: unknown },
    ];
    expect(target.endpoint).toBe(FCM);
    expect(options.timeout).toBeGreaterThan(0);
    expect(options.agent).toBeTruthy();
  });
});
