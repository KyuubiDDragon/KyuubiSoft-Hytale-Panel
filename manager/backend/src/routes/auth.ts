import { Router, Request, Response, CookieOptions } from 'express';
import rateLimit from 'express-rate-limit';
import {
  verifyCredentials,
  createAccessToken,
  createRefreshToken,
  verifyToken,
  createWsTicket,
} from '../services/auth.js';
import { authMiddleware } from '../middleware/auth.js';
import { asyncRoute } from '../utils/asyncRoute.js';
import { JsonFileCorruptError } from '../utils/jsonStore.js';
import {
  requirePermission,
  effectivePermissions,
  accessibleServerIds,
  mayAccessServer,
  SERVER_NOT_ALLOWED,
} from '../middleware/permissions.js';
import {
  checkAccountWithinCaller,
  checkRoleWithinCaller,
  checkServersWithinCaller,
  readServerList,
} from '../services/accountPolicy.js';
import { resolveServerId } from '../services/servers.js';
import {
  getAllUsers,
  createUser,
  updateUser,
  deleteUser,
  getUser,
  invalidateUserTokens,
  getTokenVersion,
} from '../services/users.js';
import { getUserPermissions, hasPermission } from '../services/roles.js';
import { legacyServerScope } from '../middleware/serverScope.js';
import hytaleAuthRoutes from './hytaleAuth.js';
import type { AuthenticatedRequest, LoginRequest } from '../types/index.js';
import { isDemoMode, getDemoUsers, getDemoRoles } from '../services/demoData.js';
import {
  startTotpEnrollment,
  verifyAndEnableTotp,
  disableTotp,
  regenerateBackupCodes,
  isTotpEnabled,
  verifyTotpOrBackup,
} from '../services/totp.js';
import { createApiKey, listApiKeys, revokeApiKey } from '../services/apiKeys.js';
import { scopeAllows } from '../services/commandPolicy.js';
import { audit } from '../services/audit.js';
import { publish } from '../services/eventBus.js';
import { authLogins } from '../services/metrics.js';

// HttpOnly refresh-token cookie. SameSite=Strict because the panel and the
// API live on the same origin in every supported deployment, so the cookie
// only needs to ride first-party navigations. `Secure` is set whenever the
// actual (proxy-resolved) connection is HTTPS — `req.secure` already reflects
// a trusted X-Forwarded-Proto when TRUST_PROXY is on. Deliberately NO blanket
// `|| config.trustProxy` here: with TRUST_PROXY=true but the panel reached
// over plain HTTP (LAN IP, proxy bypass) the browser silently drops a Secure
// cookie — refresh then breaks and users get "logged in but session dead"
// states after the 15-minute access token expires.
const REFRESH_COOKIE_NAME = 'kp_refresh';
const REFRESH_COOKIE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days, matches refreshExpiresIn

function refreshCookieOptions(req?: Request): CookieOptions {
  return {
    httpOnly: true,
    secure: req?.secure ?? false,
    sameSite: 'strict',
    path: '/api/auth',
    maxAge: REFRESH_COOKIE_MAX_AGE_MS,
  };
}

function setRefreshCookie(res: Response, token: string, req?: Request): void {
  res.cookie(REFRESH_COOKIE_NAME, token, refreshCookieOptions(req));
}

function clearRefreshCookie(res: Response, req?: Request): void {
  res.clearCookie(REFRESH_COOKIE_NAME, { ...refreshCookieOptions(req), maxAge: 0 });
}

function readRefreshToken(req: Request): string | undefined {
  // Cookie wins; body fallback keeps non-browser callers working during the
  // transition period and lets the deprecation be staged.
  const cookieVal = (req as Request & { cookies?: Record<string, string> }).cookies?.[
    REFRESH_COOKIE_NAME
  ];
  if (cookieVal) return cookieVal;
  return req.body && typeof req.body === 'object' ? req.body.refresh_token : undefined;
}

// Demo credentials
const DEMO_USERNAME = 'demo';
const DEMO_PASSWORD = 'demo';
const DEMO_ADMIN_USERNAME = 'admin';
const DEMO_ADMIN_PASSWORD = 'admin';

const router = Router();

// SECURITY: Rate limiting for authentication endpoints
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 5, // 5 attempts per window
  message: { detail: 'Too many login attempts, please try again after 15 minutes' },
  standardHeaders: true,
  legacyHeaders: false,
  skipSuccessfulRequests: true, // Only count failed attempts
});

const refreshLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 10, // 10 refreshes per minute
  message: { detail: 'Too many refresh requests, please slow down' },
  standardHeaders: true,
  legacyHeaders: false,
});

// Per-username TOTP failure counter. The loginLimiter is already IP-based,
// but distributed attackers could rotate IPs; this adds an account-level
// brake that locks 2FA for 15 min after 10 wrong codes. Mounted as a tiny
// in-process counter — sufficient for a single-process panel.
const totpFailures = new Map<string, { count: number; lockedUntil: number }>();
const TOTP_MAX_ATTEMPTS = 10;
const TOTP_LOCK_MS = 15 * 60_000;
function totpLockState(username: string): { locked: boolean; retryInSec: number } {
  const now = Date.now();
  const e = totpFailures.get(username);
  if (!e) return { locked: false, retryInSec: 0 };
  if (e.lockedUntil > now)
    return { locked: true, retryInSec: Math.ceil((e.lockedUntil - now) / 1000) };
  if (e.lockedUntil > 0) {
    totpFailures.delete(username);
    return { locked: false, retryInSec: 0 };
  }
  return { locked: false, retryInSec: 0 };
}
function recordTotpFailure(username: string): void {
  const e = totpFailures.get(username) ?? { count: 0, lockedUntil: 0 };
  e.count += 1;
  if (e.count >= TOTP_MAX_ATTEMPTS) e.lockedUntil = Date.now() + TOTP_LOCK_MS;
  totpFailures.set(username, e);
}
function clearTotpFailures(username: string): void {
  totpFailures.delete(username);
}

// POST /api/auth/login
router.post(
  '/login',
  loginLimiter,
  asyncRoute(async (req: Request, res: Response) => {
    const { username, password } = req.body as LoginRequest;

    if (!username || !password) {
      res.status(400).json({ detail: 'Username and password required' });
      return;
    }

    // Demo mode: Accept demo credentials
    if (isDemoMode()) {
      const isAdmin = username === DEMO_ADMIN_USERNAME && password === DEMO_ADMIN_PASSWORD;
      const isDemo = username === DEMO_USERNAME && password === DEMO_PASSWORD;

      if (!isAdmin && !isDemo) {
        res
          .status(401)
          .json({ detail: 'Invalid credentials. Use demo/demo or admin/admin in demo mode.' });
        return;
      }

      const role = isAdmin ? 'admin' : 'viewer';
      const permissions = isAdmin
        ? ['*']
        : [
            'server.view_status',
            'players.view',
            'console.view',
            'performance.view',
            'backups.view',
            'scheduler.view',
            'mods.view',
            'plugins.view',
            'worlds.view',
            'chat.view',
            'activity.view',
          ];

      // Create tokens even in demo mode for consistent behavior
      const accessToken = await createAccessToken(username);
      const refreshToken = await createRefreshToken(username);

      setRefreshCookie(res, refreshToken, req);
      res.json({
        access_token: accessToken,
        refresh_token: refreshToken, // kept in body for back-compat; cookie is the new path
        token_type: 'bearer',
        role,
        permissions,
        demo: true,
      });
      return;
    }

    const result = await verifyCredentials(username, password);

    if (!result.valid) {
      audit(req, 'auth.login_failed', { actor: username, success: false });
      publish('auth.login_failed', { username, reason: 'invalid_credentials' });
      authLogins.inc({ result: 'failed' });
      res.status(401).json({ detail: 'Invalid credentials' });
      return;
    }

    // 2FA gate. If the user has TOTP enabled we require a valid code (TOTP
    // or a single-use backup code) BEFORE issuing any tokens. Browsers will
    // typically submit a second login request with the code field populated.
    if (await isTotpEnabled(username)) {
      // Per-account lockout on top of the IP-based loginLimiter.
      const lock = totpLockState(username);
      if (lock.locked) {
        audit(req, 'auth.2fa_locked', { actor: username, success: false });
        res.status(429).json({
          detail: 'Too many 2FA failures, account temporarily locked',
          code: '2FA_LOCKED',
          retryAfter: lock.retryInSec,
        });
        return;
      }
      const totpCode = (req.body as { totpCode?: string }).totpCode;
      if (!totpCode) {
        res.status(401).json({ detail: '2FA code required', code: '2FA_REQUIRED' });
        return;
      }
      const ok = await verifyTotpOrBackup(username, totpCode);
      if (!ok) {
        recordTotpFailure(username);
        audit(req, 'auth.2fa_failed', { actor: username, success: false });
        publish('auth.2fa_failed', { username });
        authLogins.inc({ result: '2fa_failed' });
        res.status(401).json({ detail: 'Invalid 2FA code', code: '2FA_INVALID' });
        return;
      }
      clearTotpFailures(username);
    }

    const accessToken = await createAccessToken(username);
    const refreshToken = await createRefreshToken(username);
    const permissions = await getUserPermissions(username);

    setRefreshCookie(res, refreshToken, req);
    audit(req, 'auth.login_success', { actor: username });
    publish('auth.login_success', { username });
    authLogins.inc({ result: 'success' });
    res.json({
      access_token: accessToken,
      refresh_token: refreshToken, // kept in body for back-compat; cookie is the new path
      token_type: 'bearer',
      role: result.role,
      permissions,
    });
  }),
);

// ============== 2FA / TOTP ==============

router.post(
  '/2fa/setup',
  authMiddleware,
  asyncRoute(async (req: AuthenticatedRequest, res: Response) => {
    try {
      const result = await startTotpEnrollment(req.user!);
      res.json(result);
    } catch (err) {
      if (err instanceof JsonFileCorruptError) throw err;
      res
        .status(400)
        .json({ detail: err instanceof Error ? err.message : 'Failed to start 2FA setup' });
    }
  }),
);

router.post(
  '/2fa/verify-enable',
  authMiddleware,
  asyncRoute(async (req: AuthenticatedRequest, res: Response) => {
    const { code } = req.body as { code?: string };
    if (!code) {
      res.status(400).json({ detail: 'Code required' });
      return;
    }
    try {
      const result = await verifyAndEnableTotp(req.user!, code);
      audit(req, 'auth.2fa_enabled');
      res.json(result);
    } catch (err) {
      if (err instanceof JsonFileCorruptError) throw err;
      res.status(400).json({ detail: err instanceof Error ? err.message : 'Failed to enable 2FA' });
    }
  }),
);

router.post(
  '/2fa/disable',
  authMiddleware,
  asyncRoute(async (req: AuthenticatedRequest, res: Response) => {
    const { password, code } = req.body as { password?: string; code?: string };
    if (!password || !code) {
      res.status(400).json({ detail: 'Password and 2FA code required' });
      return;
    }
    const creds = await verifyCredentials(req.user!, password);
    if (!creds.valid) {
      res.status(401).json({ detail: 'Invalid password' });
      return;
    }
    if (!(await verifyTotpOrBackup(req.user!, code))) {
      res.status(401).json({ detail: 'Invalid 2FA code' });
      return;
    }
    await disableTotp(req.user!);
    audit(req, 'auth.2fa_disabled');
    res.json({ success: true });
  }),
);

router.post(
  '/2fa/regenerate-backup-codes',
  authMiddleware,
  asyncRoute(async (req: AuthenticatedRequest, res: Response) => {
    const { password } = req.body as { password?: string };
    if (!password) {
      res.status(400).json({ detail: 'Password required' });
      return;
    }
    const creds = await verifyCredentials(req.user!, password);
    if (!creds.valid) {
      res.status(401).json({ detail: 'Invalid password' });
      return;
    }
    try {
      const backupCodes = await regenerateBackupCodes(req.user!);
      audit(req, 'auth.2fa_backup_codes_regenerated');
      res.json({ backupCodes });
    } catch (err) {
      res.status(400).json({ detail: err instanceof Error ? err.message : 'Failed' });
    }
  }),
);

router.get(
  '/2fa/status',
  authMiddleware,
  asyncRoute(async (req: AuthenticatedRequest, res: Response) => {
    res.json({ enabled: await isTotpEnabled(req.user!) });
  }),
);

// ============== REST API KEYS ==============

router.get(
  '/api-keys',
  authMiddleware,
  requirePermission('apikeys.manage'),
  (req: AuthenticatedRequest, res: Response) => {
    res.json({ keys: listApiKeys(req.user!) });
  },
);

router.post(
  '/api-keys',
  authMiddleware,
  requirePermission('apikeys.manage'),
  asyncRoute(async (req: AuthenticatedRequest, res: Response) => {
    const { name, scopes, expiresAt } = req.body as {
      name?: string;
      scopes?: string[];
      expiresAt?: string;
    };
    if (!name || !Array.isArray(scopes) || scopes.length === 0) {
      res.status(400).json({ detail: 'name and scopes[] required' });
      return;
    }
    // Disallow giving an API key more rights than its owner has, except for
    // admins (`*`). This prevents privilege escalation through key creation.
    const ownerPerms = await getUserPermissions(req.user!);
    if (!ownerPerms.includes('*')) {
      const bad = scopes.filter((s) => !(ownerPerms as string[]).includes(s));
      if (bad.length) {
        res.status(403).json({ detail: 'Cannot grant scopes you do not hold', scopes: bad });
        return;
      }
    }
    // Optional server list, set with the key itself so it is never wider than
    // chosen. Without one the key follows its owner, which is only "no more
    // than the caller has" when the caller is not itself a key with a list.
    let serverIds: string[] | null = null;
    const keyLimited = Array.isArray(req.apiKey?.serverIds);
    if (req.body?.serverIds !== undefined || keyLimited) {
      const list =
        req.body?.serverIds === undefined
          ? ({ ok: true, value: null } as const)
          : await readServerList(req.body, 'serverIds');
      if (!list.ok) {
        res.status(list.status).json(list.body);
        return;
      }
      const refusal =
        list.value === null && !keyLimited
          ? null
          : checkServersWithinCaller(await accessibleServerIds(req), list.value);
      if (refusal) {
        res.status(refusal.status).json(refusal.body);
        return;
      }
      serverIds = list.value;
    }
    const { key, token } = await createApiKey({
      ownerUsername: req.user!,
      name,
      scopes,
      expiresAt: expiresAt ?? null,
      serverIds,
    });
    audit(req, 'apikey.created', {
      target: `apikey:${key.id}`,
      metadata: { name, scopes, serverIds },
    });
    publish('user.created', { kind: 'api_key', name, scopes, owner: req.user });
    res.json({ key, token });
  }),
);

router.delete(
  '/api-keys/:id',
  authMiddleware,
  requirePermission('apikeys.manage'),
  (req: AuthenticatedRequest, res: Response) => {
    const ok = revokeApiKey(req.user!, req.params.id);
    if (!ok) {
      res.status(404).json({ detail: 'Key not found' });
      return;
    }
    audit(req, 'apikey.revoked', { target: `apikey:${req.params.id}` });
    res.json({ success: true });
  },
);

// POST /api/auth/refresh
router.post(
  '/refresh',
  refreshLimiter,
  asyncRoute(async (req: Request, res: Response) => {
    const refresh_token = readRefreshToken(req);

    if (!refresh_token) {
      res.status(400).json({ detail: 'Refresh token required' });
      return;
    }

    const result = verifyToken(refresh_token, 'refresh');

    if (!result) {
      res.status(401).json({ detail: 'Invalid or expired refresh token' });
      return;
    }

    // Verify the refresh token wasn't invalidated by a password or role change.
    if (!isDemoMode()) {
      const currentVersion = await getTokenVersion(result.username);
      if (result.tokenVersion !== undefined && result.tokenVersion !== currentVersion) {
        res.status(401).json({ detail: 'Refresh token invalidated', code: 'TOKEN_INVALIDATED' });
        return;
      }
    }

    // Demo mode: Create new tokens for demo users
    if (isDemoMode()) {
      const isAdmin = result.username === DEMO_ADMIN_USERNAME;
      const accessToken = await createAccessToken(result.username);
      const newRefreshToken = await createRefreshToken(result.username);
      const permissions = isAdmin
        ? ['*']
        : [
            'server.view_status',
            'players.view',
            'console.view',
            'performance.view',
            'backups.view',
            'scheduler.view',
            'mods.view',
            'plugins.view',
            'worlds.view',
            'chat.view',
            'activity.view',
          ];

      setRefreshCookie(res, newRefreshToken, req);
      res.json({
        access_token: accessToken,
        refresh_token: newRefreshToken,
        token_type: 'bearer',
        role: isAdmin ? 'admin' : 'viewer',
        permissions,
        demo: true,
      });
      return;
    }

    const accessToken = await createAccessToken(result.username);
    const newRefreshToken = await createRefreshToken(result.username);

    setRefreshCookie(res, newRefreshToken, req);
    res.json({
      access_token: accessToken,
      refresh_token: newRefreshToken,
      token_type: 'bearer',
    });
  }),
);

// POST /api/auth/logout
// Clears the refresh cookie ALWAYS — even when the access token is already
// dead — so a client can never get stuck "authenticated" with a lingering
// kp_refresh cookie that silently revives the session (the root of the
// "had to delete cookies to log in" reports). Not behind authMiddleware for
// that reason; when a valid token IS present we also bump the user's
// tokenVersion to invalidate any other outstanding sessions.
router.post('/logout', async (req: Request, res: Response) => {
  // Best-effort: if a valid bearer token is present, invalidate that user's
  // tokens server-side too. A missing/expired token is fine — we still clear.
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    const result = verifyToken(authHeader.substring(7), 'access');
    if (result && !isDemoMode()) {
      try {
        await invalidateUserTokens(result.username);
      } catch {
        /* ignore */
      }
    }
  }
  clearRefreshCookie(res, req);
  res.json({ message: 'Logged out successfully' });
});

// POST /api/auth/ws-ticket - Get a single-use WebSocket connection ticket
// This creates a short-lived (30s) token that can only be used once
// This is more secure than putting the JWT in the WebSocket URL
const wsTicketLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 30, // 30 tickets per minute
  message: { detail: 'Too many WebSocket ticket requests' },
  standardHeaders: true,
  legacyHeaders: false,
});

router.post(
  '/ws-ticket',
  authMiddleware,
  wsTicketLimiter,
  asyncRoute(async (req: AuthenticatedRequest, res: Response) => {
    const username = req.user!;
    // Optional server scope. Callers can request a scoped ticket for a
    // specific Hytale instance; the ticket then only opens the matching
    // /api/servers/:id/console/ws upgrade — cross-server reuse is rejected
    // by verifyWsTicket().
    const requestedServerId =
      req.body &&
      typeof req.body === 'object' &&
      typeof (req.body as { serverId?: string }).serverId === 'string'
        ? (req.body as { serverId?: string }).serverId
        : undefined;

    // A WS ticket binds the username (and API-key scopes); the concrete per-socket permission is
    // re-checked on connect (console.view for the console stream, players.view
    // for the live player-locations stream). Issue a ticket if the caller holds
    // either of those view rights, so a players.view-only user can still open the
    // live map without being granted console access.
    // SECURITY: an API key needs the view right in its own scopes too, and its
    // scopes travel with the ticket so the socket keeps honouring them (e.g. a
    // key without console.execute.admin can't run /op over the WS console).
    const keyScopes = req.apiKey?.scopes;
    // An unscoped ticket opens the legacy sockets, which stream the default
    // server: the rights and server lists of that server apply.
    const targetServerId = requestedServerId ?? (await resolveServerId());
    if (!(await mayAccessServer(req, targetServerId))) {
      res.status(403).json({
        error: 'No access to this server',
        code: SERVER_NOT_ALLOWED,
        serverId: targetServerId,
      });
      return;
    }
    const canViewConsole =
      scopeAllows(keyScopes, 'console.view') &&
      (await hasPermission(username, 'console.view', targetServerId));
    const canViewPlayers =
      scopeAllows(keyScopes, 'players.view') &&
      (await hasPermission(username, 'players.view', targetServerId));
    if (!canViewConsole && !canViewPlayers) {
      res.status(403).json({ error: 'Permission denied: console.view or players.view required' });
      return;
    }

    // The whole key grant travels with the ticket (scopes, server list, id),
    // so the socket follows the key's current state.
    const ticket = createWsTicket(username, requestedServerId, req.apiKey);
    res.json({ ticket, expiresIn: 30, serverId: requestedServerId ?? null });
  }),
);

// GET /api/auth/me
router.get(
  '/me',
  authMiddleware,
  asyncRoute(async (req: AuthenticatedRequest, res: Response) => {
    const username = req.user!; // authMiddleware guarantees this is set

    // Demo mode: return demo user info
    if (isDemoMode()) {
      const isAdmin = username === DEMO_ADMIN_USERNAME;
      const role = isAdmin ? 'admin' : 'viewer';
      const permissions = isAdmin
        ? ['*']
        : [
            'server.view_status',
            'players.view',
            'console.view',
            'performance.view',
            'backups.view',
            'scheduler.view',
            'mods.view',
            'plugins.view',
            'worlds.view',
            'chat.view',
            'activity.view',
          ];
      res.json({ username, role, permissions, demo: true });
      return;
    }

    const user = await getUser(username);
    const permissions = await getUserPermissions(username);
    if (!user) {
      // Validly-signed token for a username with no users.json record (the
      // env-bootstrap admin before the file is written). It claims the admin
      // role, so return admin permissions to match — otherwise the client would
      // render a full admin as a permission-less "viewer".
      res.json({ username, role: 'admin', permissions: ['*'] });
      return;
    }
    res.json({ username, role: user.roleId, permissions });
  }),
);

// ============== USER MANAGEMENT ==============

// GET /api/auth/users - List all users
router.get(
  '/users',
  authMiddleware,
  requirePermission('users.view'),
  async (_req: AuthenticatedRequest, res: Response) => {
    // Demo mode: return demo users
    if (isDemoMode()) {
      res.json({ users: getDemoUsers() });
      return;
    }

    try {
      const users = await getAllUsers();
      res.json({ users });
    } catch (error) {
      res.status(500).json({ error: 'Failed to get users' });
    }
  },
);

// POST /api/auth/users - Create new user
router.post(
  '/users',
  authMiddleware,
  requirePermission('users.create'),
  async (req: AuthenticatedRequest, res: Response) => {
    // Demo mode: simulate user creation
    if (isDemoMode()) {
      const { username, roleId } = req.body;
      res.json({
        success: true,
        message: '[DEMO] User created (simulated)',
        user: { username, role: roleId || 'viewer', createdAt: new Date().toISOString() },
      });
      return;
    }

    try {
      const { username, password, roleId } = req.body;

      if (!username || !password) {
        res.status(400).json({ error: 'Username and password required' });
        return;
      }

      const targetRole = roleId || 'viewer';
      if (typeof targetRole !== 'string') {
        res.status(400).json({ error: 'roleId must be a string' });
        return;
      }

      // SECURITY: prevent privilege escalation — a creator can't mint a user with
      // a role more powerful than their own (e.g. a users.create holder making an admin),
      // and the new account gets at most the creator's servers: the creator's
      // list, or one named in the body inside it.
      const callerPerms = await effectivePermissions(req);
      const callerIds = await accessibleServerIds(req);
      let allowedServers = callerIds;
      if ((req.body as { allowedServers?: unknown }).allowedServers !== undefined) {
        const list = await readServerList(req.body, 'allowedServers');
        if (!list.ok) {
          res.status(list.status).json(list.body);
          return;
        }
        allowedServers = list.value;
      }
      const refusal =
        (await checkRoleWithinCaller(callerPerms, targetRole)) ??
        checkServersWithinCaller(callerIds, allowedServers);
      if (refusal) {
        res.status(refusal.status).json(refusal.body);
        return;
      }

      const user = await createUser(username, password, targetRole, allowedServers);
      res.json({ success: true, user });
    } catch (error) {
      res.status(400).json({ error: (error as Error).message });
    }
  },
);

// PUT /api/auth/users/:username - Update user
router.put(
  '/users/:username',
  authMiddleware,
  requirePermission('users.edit'),
  async (req: AuthenticatedRequest, res: Response) => {
    // Demo mode: simulate user update
    if (isDemoMode()) {
      res.json({ success: true, message: '[DEMO] User updated (simulated)' });
      return;
    }

    try {
      const { username } = req.params;
      const { password, roleId } = req.body;

      if (!password && !roleId) {
        res.status(400).json({ error: 'Nothing to update' });
        return;
      }

      if (roleId !== undefined && typeof roleId !== 'string') {
        res.status(400).json({ error: 'roleId must be a string' });
        return;
      }

      // Prevent users from changing their own role (security)
      if (roleId && username === req.user) {
        res.status(400).json({ error: 'Cannot change your own role' });
        return;
      }

      const target = await getUser(username);
      if (!target) {
        res.status(404).json({ error: 'User not found' });
        return;
      }

      // SECURITY: an account's password or role is only changed by someone
      // holding every right it has (an admin only by an admin), and no account
      // gets a role beyond the actor's own permissions.
      const callerPerms = await effectivePermissions(req);
      const refusal =
        (await checkAccountWithinCaller(callerPerms, await accessibleServerIds(req), target)) ??
        (roleId ? await checkRoleWithinCaller(callerPerms, roleId) : null);
      if (refusal) {
        res.status(refusal.status).json(refusal.body);
        return;
      }

      const user = await updateUser(username, { password, roleId });
      res.json({ success: true, user });
    } catch (error) {
      res.status(400).json({ error: (error as Error).message });
    }
  },
);

// DELETE /api/auth/users/:username - Delete user
router.delete(
  '/users/:username',
  authMiddleware,
  requirePermission('users.delete'),
  async (req: AuthenticatedRequest, res: Response) => {
    // Demo mode: simulate user deletion
    if (isDemoMode()) {
      res.json({ success: true, message: '[DEMO] User deleted (simulated)' });
      return;
    }

    try {
      const { username } = req.params;

      // Prevent deleting yourself
      if (username === req.user) {
        res.status(400).json({ error: 'Cannot delete your own account' });
        return;
      }

      const target = await getUser(username);
      if (!target) {
        res.status(404).json({ error: 'User not found' });
        return;
      }
      // SECURITY: no deleting an account with rights the actor does not have.
      const refusal = await checkAccountWithinCaller(
        await effectivePermissions(req),
        await accessibleServerIds(req),
        target,
      );
      if (refusal) {
        res.status(refusal.status).json(refusal.body);
        return;
      }

      await deleteUser(username);
      res.json({ success: true });
    } catch (error) {
      res.status(400).json({ error: (error as Error).message });
    }
  },
);

// ============== HYTALE SERVER AUTHENTICATION ==============

// /api/auth/hytale/* is the older path of the default server's Hytale sign-in;
// every server has it at /api/servers/:serverId/server/hytale-auth/* (routes/hytaleAuth.ts).
router.use('/hytale', legacyServerScope, hytaleAuthRoutes);

export default router;
