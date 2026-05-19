/**
 * SSO endpoints.
 *
 * /api/auth/sso/providers              public list of enabled provider ids
 * /api/auth/sso/:providerId/start      302 to provider authorize endpoint
 * /api/auth/sso/:providerId/callback   exchange code, mint panel tokens
 */
import { Router, Request, Response } from 'express';
import { getProvider, listProviders, issueState, consumeState, discordAuthorizeUrl, discordExchangeAndIdentify } from '../services/sso.js';
import { createAccessToken, createRefreshToken } from '../services/auth.js';
import { getUserPermissions } from '../services/roles.js';
import { readFile, writeFile } from 'fs/promises';
import path from 'path';
import { audit } from '../services/audit.js';
import type { CookieOptions } from 'express';
import { config } from '../config.js';

const router = Router();

const REFRESH_COOKIE = 'kp_refresh';

function refreshCookieOptions(): CookieOptions {
  return {
    httpOnly: true,
    secure: config.trustProxy,
    sameSite: 'strict',
    path: '/api/auth',
    maxAge: 7 * 24 * 60 * 60 * 1000,
  };
}

function callbackUrl(req: Request, providerId: string): string {
  const proto = req.headers['x-forwarded-proto'] || (req.secure ? 'https' : 'http');
  const host = req.headers.host;
  return `${proto}://${host}/api/auth/sso/${providerId}/callback`;
}

router.get('/providers', async (_req: Request, res: Response) => {
  res.json({ providers: await listProviders() });
});

router.get('/:providerId/start', async (req: Request, res: Response) => {
  const provider = await getProvider(req.params.providerId);
  if (!provider) { res.status(404).json({ detail: 'Unknown SSO provider' }); return; }
  const state = issueState(provider.id);
  const redirectUri = callbackUrl(req, provider.id);
  if (provider.type === 'discord') {
    res.redirect(discordAuthorizeUrl(provider, redirectUri, state));
    return;
  }
  res.status(501).json({ detail: 'Only Discord SSO is implemented in this alpha' });
});

const USERS_FILE = path.join(process.env.MANAGER_DATA_PATH || '/app/data', 'users.json');

interface PanelUser {
  username: string;
  passwordHash?: string;
  roleId: string;
  tokenVersion: number;
  createdAt: string;
  linkedAccounts?: Array<{ providerId: string; subject: string; linkedAt: string }>;
}

async function readUsers(): Promise<{ users: PanelUser[] }> {
  return JSON.parse(await readFile(USERS_FILE, 'utf-8')) as { users: PanelUser[] };
}
async function writeUsers(data: { users: PanelUser[] }): Promise<void> {
  await writeFile(USERS_FILE, JSON.stringify(data, null, 2), 'utf-8');
}

router.get('/:providerId/callback', async (req: Request, res: Response) => {
  const provider = await getProvider(req.params.providerId);
  if (!provider) { res.status(404).send('Unknown SSO provider'); return; }
  const { code, state } = req.query as { code?: string; state?: string };
  if (!code || !state) { res.status(400).send('Missing code or state'); return; }
  const consumed = consumeState(state, provider.id);
  if (!consumed.ok) { res.status(400).send('Invalid or expired state'); return; }

  const result = provider.type === 'discord'
    ? await discordExchangeAndIdentify(provider, callbackUrl(req, provider.id), code)
    : { error: 'unsupported provider type' };
  if ('error' in result) {
    audit(req, 'auth.sso_failed', { actor: provider.id, success: false, metadata: { reason: result.error } });
    res.status(401).send(`SSO failed: ${result.error}`);
    return;
  }

  const data = await readUsers();
  // Find an existing linked account first.
  let user = data.users.find(u => u.linkedAccounts?.some(a => a.providerId === provider.id && a.subject === result.providerSubject));
  if (!user && provider.autoCreate !== false) {
    // Create on the fly, with the suggested username uniquified.
    let candidate = result.suggestedUsername;
    let i = 1;
    while (data.users.some(u => u.username === candidate)) {
      candidate = `${result.suggestedUsername}-${i++}`;
    }
    user = {
      username: candidate,
      roleId: provider.defaultRoleId ?? 'viewer',
      tokenVersion: 1,
      createdAt: new Date().toISOString(),
      linkedAccounts: [{ providerId: provider.id, subject: result.providerSubject, linkedAt: new Date().toISOString() }],
    };
    data.users.push(user);
    await writeUsers(data);
    audit(req, 'user.created_via_sso', { actor: user.username, metadata: { providerId: provider.id } });
  }
  if (!user) { res.status(401).send('No linked account; ask an admin to invite you.'); return; }

  const accessToken = await createAccessToken(user.username);
  const refreshToken = await createRefreshToken(user.username);
  res.cookie(REFRESH_COOKIE, refreshToken, refreshCookieOptions());
  audit(req, 'auth.sso_login_success', { actor: user.username, metadata: { providerId: provider.id } });

  // Send the user back to the panel root with a short fragment payload that
  // the login page picks up to seed the auth store. Simpler than juggling
  // a one-time exchange code through localStorage.
  const permissions = await getUserPermissions(user.username);
  const payload = encodeURIComponent(JSON.stringify({
    access_token: accessToken,
    refresh_token: refreshToken,
    role: user.roleId,
    permissions,
  }));
  res.redirect(`/login?sso=${payload}`);
});

export default router;
