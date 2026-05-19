import { Router, Request, Response, CookieOptions } from 'express';
import rateLimit from 'express-rate-limit';
import { config } from '../config.js';
import { verifyCredentials, createAccessToken, createRefreshToken, verifyToken, createWsTicket } from '../services/auth.js';
import { authMiddleware } from '../middleware/auth.js';
import { requirePermission } from '../middleware/permissions.js';
import { getAllUsers, createUser, updateUser, deleteUser, getUser, invalidateUserTokens, getTokenVersion } from '../services/users.js';
import { getUserPermissions, hasPermission } from '../services/roles.js';
import { initiateDeviceLogin, checkAuthCompletion, getAuthStatus, resetAuth, setPersistence, listAuthFiles, inspectDownloaderCredentials } from '../services/hytaleAuth.js';
import type { AuthenticatedRequest, LoginRequest } from '../types/index.js';
import { isDemoMode, getDemoUsers, getDemoRoles } from '../services/demoData.js';
import {
  startTotpEnrollment, verifyAndEnableTotp, disableTotp,
  regenerateBackupCodes, isTotpEnabled, verifyTotpOrBackup,
} from '../services/totp.js';
import { createApiKey, listApiKeys, revokeApiKey } from '../services/apiKeys.js';
import { audit } from '../services/audit.js';

// HttpOnly refresh-token cookie. SameSite=Strict because the panel and the
// API live on the same origin in every supported deployment, so the cookie
// only needs to ride first-party navigations. `Secure` is auto-enabled when
// the operator is behind a reverse proxy (TRUST_PROXY=true) — over plain
// HTTP a Secure cookie would just be dropped silently.
const REFRESH_COOKIE_NAME = 'kp_refresh';
const REFRESH_COOKIE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days, matches refreshExpiresIn

function refreshCookieOptions(): CookieOptions {
  return {
    httpOnly: true,
    secure: config.trustProxy,
    sameSite: 'strict',
    path: '/api/auth',
    maxAge: REFRESH_COOKIE_MAX_AGE_MS,
  };
}

function setRefreshCookie(res: Response, token: string): void {
  res.cookie(REFRESH_COOKIE_NAME, token, refreshCookieOptions());
}

function clearRefreshCookie(res: Response): void {
  res.clearCookie(REFRESH_COOKIE_NAME, { ...refreshCookieOptions(), maxAge: 0 });
}

function readRefreshToken(req: Request): string | undefined {
  // Cookie wins; body fallback keeps non-browser callers working during the
  // transition period and lets the deprecation be staged.
  const cookieVal = (req as Request & { cookies?: Record<string, string> }).cookies?.[REFRESH_COOKIE_NAME];
  if (cookieVal) return cookieVal;
  return (req.body && typeof req.body === 'object') ? req.body.refresh_token : undefined;
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

// POST /api/auth/login
router.post('/login', loginLimiter, async (req: Request, res: Response) => {
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
      res.status(401).json({ detail: 'Invalid credentials. Use demo/demo or admin/admin in demo mode.' });
      return;
    }

    const role = isAdmin ? 'admin' : 'viewer';
    const permissions = isAdmin ? ['*'] : ['server.view_status', 'players.view', 'console.view', 'performance.view', 'backups.view', 'scheduler.view', 'mods.view', 'plugins.view', 'worlds.view', 'chat.view', 'activity.view'];

    // Create tokens even in demo mode for consistent behavior
    const accessToken = await createAccessToken(username);
    const refreshToken = await createRefreshToken(username);

    setRefreshCookie(res, refreshToken);
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
    res.status(401).json({ detail: 'Invalid credentials' });
    return;
  }

  // 2FA gate. If the user has TOTP enabled we require a valid code (TOTP
  // or a single-use backup code) BEFORE issuing any tokens. Browsers will
  // typically submit a second login request with the code field populated.
  if (await isTotpEnabled(username)) {
    const totpCode = (req.body as { totpCode?: string }).totpCode;
    if (!totpCode) {
      res.status(401).json({ detail: '2FA code required', code: '2FA_REQUIRED' });
      return;
    }
    const ok = await verifyTotpOrBackup(username, totpCode);
    if (!ok) {
      audit(req, 'auth.2fa_failed', { actor: username, success: false });
      res.status(401).json({ detail: 'Invalid 2FA code', code: '2FA_INVALID' });
      return;
    }
  }

  const accessToken = await createAccessToken(username);
  const refreshToken = await createRefreshToken(username);
  const permissions = await getUserPermissions(username);

  setRefreshCookie(res, refreshToken);
  audit(req, 'auth.login_success', { actor: username });
  res.json({
    access_token: accessToken,
    refresh_token: refreshToken, // kept in body for back-compat; cookie is the new path
    token_type: 'bearer',
    role: result.role,
    permissions,
  });
});

// ============== 2FA / TOTP ==============

router.post('/2fa/setup', authMiddleware, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const result = await startTotpEnrollment(req.user!);
    res.json(result);
  } catch (err) {
    res.status(400).json({ detail: err instanceof Error ? err.message : 'Failed to start 2FA setup' });
  }
});

router.post('/2fa/verify-enable', authMiddleware, async (req: AuthenticatedRequest, res: Response) => {
  const { code } = req.body as { code?: string };
  if (!code) { res.status(400).json({ detail: 'Code required' }); return; }
  try {
    const result = await verifyAndEnableTotp(req.user!, code);
    audit(req, 'auth.2fa_enabled');
    res.json(result);
  } catch (err) {
    res.status(400).json({ detail: err instanceof Error ? err.message : 'Failed to enable 2FA' });
  }
});

router.post('/2fa/disable', authMiddleware, async (req: AuthenticatedRequest, res: Response) => {
  const { password, code } = req.body as { password?: string; code?: string };
  if (!password || !code) { res.status(400).json({ detail: 'Password and 2FA code required' }); return; }
  const creds = await verifyCredentials(req.user!, password);
  if (!creds.valid) { res.status(401).json({ detail: 'Invalid password' }); return; }
  if (!(await verifyTotpOrBackup(req.user!, code))) {
    res.status(401).json({ detail: 'Invalid 2FA code' });
    return;
  }
  await disableTotp(req.user!);
  audit(req, 'auth.2fa_disabled');
  res.json({ success: true });
});

router.post('/2fa/regenerate-backup-codes', authMiddleware, async (req: AuthenticatedRequest, res: Response) => {
  const { password } = req.body as { password?: string };
  if (!password) { res.status(400).json({ detail: 'Password required' }); return; }
  const creds = await verifyCredentials(req.user!, password);
  if (!creds.valid) { res.status(401).json({ detail: 'Invalid password' }); return; }
  try {
    const backupCodes = await regenerateBackupCodes(req.user!);
    audit(req, 'auth.2fa_backup_codes_regenerated');
    res.json({ backupCodes });
  } catch (err) {
    res.status(400).json({ detail: err instanceof Error ? err.message : 'Failed' });
  }
});

router.get('/2fa/status', authMiddleware, async (req: AuthenticatedRequest, res: Response) => {
  res.json({ enabled: await isTotpEnabled(req.user!) });
});

// ============== REST API KEYS ==============

router.get('/api-keys', authMiddleware, requirePermission('apikeys.manage'), (req: AuthenticatedRequest, res: Response) => {
  res.json({ keys: listApiKeys(req.user!) });
});

router.post('/api-keys', authMiddleware, requirePermission('apikeys.manage'), async (req: AuthenticatedRequest, res: Response) => {
  const { name, scopes, expiresAt } = req.body as { name?: string; scopes?: string[]; expiresAt?: string };
  if (!name || !Array.isArray(scopes) || scopes.length === 0) {
    res.status(400).json({ detail: 'name and scopes[] required' });
    return;
  }
  // Disallow giving an API key more rights than its owner has, except for
  // admins (`*`). This prevents privilege escalation through key creation.
  const ownerPerms = await getUserPermissions(req.user!);
  if (!ownerPerms.includes('*')) {
    const bad = scopes.filter(s => !(ownerPerms as string[]).includes(s));
    if (bad.length) {
      res.status(403).json({ detail: 'Cannot grant scopes you do not hold', scopes: bad });
      return;
    }
  }
  const { key, token } = await createApiKey({
    ownerUsername: req.user!,
    name,
    scopes,
    expiresAt: expiresAt ?? null,
  });
  audit(req, 'apikey.created', { target: `apikey:${key.id}`, metadata: { name, scopes } });
  res.json({ key, token });
});

router.delete('/api-keys/:id', authMiddleware, requirePermission('apikeys.manage'), (req: AuthenticatedRequest, res: Response) => {
  const ok = revokeApiKey(req.user!, req.params.id);
  if (!ok) { res.status(404).json({ detail: 'Key not found' }); return; }
  audit(req, 'apikey.revoked', { target: `apikey:${req.params.id}` });
  res.json({ success: true });
});

// POST /api/auth/refresh
router.post('/refresh', refreshLimiter, async (req: Request, res: Response) => {
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
    const permissions = isAdmin ? ['*'] : ['server.view_status', 'players.view', 'console.view', 'performance.view', 'backups.view', 'scheduler.view', 'mods.view', 'plugins.view', 'worlds.view', 'chat.view', 'activity.view'];

    setRefreshCookie(res, newRefreshToken);
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

  setRefreshCookie(res, newRefreshToken);
  res.json({
    access_token: accessToken,
    refresh_token: newRefreshToken,
    token_type: 'bearer',
  });
});

// POST /api/auth/logout
// SECURITY: Invalidate tokens on logout to prevent token reuse
router.post('/logout', authMiddleware, async (req: Request, res: Response) => {
  const authReq = req as AuthenticatedRequest;
  if (authReq.user) {
    await invalidateUserTokens(authReq.user);
  }
  clearRefreshCookie(res);
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

router.post('/ws-ticket', authMiddleware, wsTicketLimiter, async (req: AuthenticatedRequest, res: Response) => {
  const username = req.user!;

  // Verify user has console.view permission before issuing ticket
  const canViewConsole = await hasPermission(username, 'console.view');
  if (!canViewConsole) {
    res.status(403).json({ error: 'Permission denied: console.view required' });
    return;
  }

  const ticket = createWsTicket(username);
  res.json({ ticket, expiresIn: 30 }); // 30 seconds TTL
});

// GET /api/auth/me
router.get('/me', authMiddleware, async (req: AuthenticatedRequest, res: Response) => {
  const username = req.user!;  // authMiddleware guarantees this is set

  // Demo mode: return demo user info
  if (isDemoMode()) {
    const isAdmin = username === DEMO_ADMIN_USERNAME;
    const role = isAdmin ? 'admin' : 'viewer';
    const permissions = isAdmin ? ['*'] : ['server.view_status', 'players.view', 'console.view', 'performance.view', 'backups.view', 'scheduler.view', 'mods.view', 'plugins.view', 'worlds.view', 'chat.view', 'activity.view'];
    res.json({ username, role, permissions, demo: true });
    return;
  }

  const user = await getUser(username);
  const permissions = await getUserPermissions(username);
  if (!user) {
    res.json({ username, role: 'admin', permissions });
    return;
  }
  res.json({ username, role: user.roleId, permissions });
});

// ============== USER MANAGEMENT ==============

// GET /api/auth/users - List all users
router.get('/users', authMiddleware, requirePermission('users.view'), async (_req: AuthenticatedRequest, res: Response) => {
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
});

// POST /api/auth/users - Create new user
router.post('/users', authMiddleware, requirePermission('users.create'), async (req: AuthenticatedRequest, res: Response) => {
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

    const user = await createUser(username, password, roleId || 'viewer');
    res.json({ success: true, user });
  } catch (error) {
    res.status(400).json({ error: (error as Error).message });
  }
});

// PUT /api/auth/users/:username - Update user
router.put('/users/:username', authMiddleware, requirePermission('users.edit'), async (req: AuthenticatedRequest, res: Response) => {
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

    // Prevent users from changing their own role (security)
    if (roleId && username === req.user) {
      res.status(400).json({ error: 'Cannot change your own role' });
      return;
    }

    const user = await updateUser(username, { password, roleId });
    res.json({ success: true, user });
  } catch (error) {
    res.status(400).json({ error: (error as Error).message });
  }
});

// DELETE /api/auth/users/:username - Delete user
router.delete('/users/:username', authMiddleware, requirePermission('users.delete'), async (req: AuthenticatedRequest, res: Response) => {
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

    await deleteUser(username);
    res.json({ success: true });
  } catch (error) {
    res.status(400).json({ error: (error as Error).message });
  }
});

// ============== HYTALE SERVER AUTHENTICATION ==============

// GET /api/auth/hytale/status - Get Hytale authentication status
router.get('/hytale/status', authMiddleware, requirePermission('hytale_auth.manage'), async (_req: Request, res: Response) => {
  // Demo mode: return authenticated status
  if (isDemoMode()) {
    res.json({
      authenticated: true,
      username: 'demo@kyuubisoft.com',
      persistence: 'Memory',
      lastAuth: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString(),
      demo: true,
    });
    return;
  }

  try {
    // Always verify auth status by checking for token files
    const result = await checkAuthCompletion();
    const status = await getAuthStatus();
    res.json({
      ...status,
      authenticated: result.success || status.authenticated,
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to get auth status' });
  }
});

// POST /api/auth/hytale/initiate - Initiate Hytale device login
router.post('/hytale/initiate', authMiddleware, requirePermission('hytale_auth.manage'), async (_req: AuthenticatedRequest, res: Response) => {
  // Demo mode: simulate device login initiation
  if (isDemoMode()) {
    res.json({
      success: true,
      message: '[DEMO] Device login initiated (simulated)',
      deviceCode: 'DEMO-1234-5678',
      verificationUri: 'https://hypixel.net/activate',
      expiresIn: 300,
      demo: true,
    });
    return;
  }

  try {
    const result = await initiateDeviceLogin();

    if (!result.success) {
      res.status(400).json(result);
      return;
    }

    res.json(result);
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Failed to initiate login'
    });
  }
});

// POST /api/auth/hytale/check - Check if authentication is complete
router.post('/hytale/check', authMiddleware, requirePermission('hytale_auth.manage'), async (_req: Request, res: Response) => {
  // Demo mode: return authenticated
  if (isDemoMode()) {
    res.json({ success: true, authenticated: true, demo: true });
    return;
  }

  try {
    const result = await checkAuthCompletion();
    res.json(result);
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Failed to check auth status'
    });
  }
});

// POST /api/auth/hytale/reset - Reset Hytale authentication
router.post('/hytale/reset', authMiddleware, requirePermission('hytale_auth.manage'), async (_req: AuthenticatedRequest, res: Response) => {
  // Demo mode: simulate reset
  if (isDemoMode()) {
    res.json({ success: true, message: '[DEMO] Auth reset (simulated)', demo: true });
    return;
  }

  try {
    const result = await resetAuth();
    res.json(result);
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Failed to reset auth'
    });
  }
});

// POST /api/auth/hytale/persistence - Set authentication persistence type
router.post('/hytale/persistence', authMiddleware, requirePermission('hytale_auth.manage'), async (req: AuthenticatedRequest, res: Response) => {
  // Demo mode: simulate persistence change
  if (isDemoMode()) {
    const { type } = req.body;
    res.json({ success: true, message: `[DEMO] Persistence set to ${type} (simulated)`, demo: true });
    return;
  }

  try {
    const { type } = req.body;
    if (!type || !['Memory', 'Encrypted'].includes(type)) {
      res.status(400).json({
        success: false,
        error: 'Invalid persistence type. Must be "Memory" or "Encrypted"'
      });
      return;
    }

    const result = await setPersistence(type);
    res.json(result);
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Failed to set persistence'
    });
  }
});

// GET /api/auth/hytale/files - List files in auth directory (debug)
router.get('/hytale/files', authMiddleware, requirePermission('hytale_auth.manage'), async (_req: Request, res: Response) => {
  // Demo mode: return simulated file list
  if (isDemoMode()) {
    res.json({ files: ['credentials.json', 'token.json'], demo: true });
    return;
  }

  try {
    const files = await listAuthFiles();
    res.json({ files });
  } catch (error) {
    res.status(500).json({ error: 'Failed to list auth files' });
  }
});

// GET /api/auth/hytale/inspect-credentials - Inspect downloader credentials structure (debug)
router.get('/hytale/inspect-credentials', authMiddleware, requirePermission('hytale_auth.manage'), async (_req: Request, res: Response) => {
  // Demo mode: return simulated credentials info
  if (isDemoMode()) {
    res.json({ success: true, hasCredentials: true, structure: { username: 'demo@kyuubisoft.com' }, demo: true });
    return;
  }

  try {
    const result = await inspectDownloaderCredentials();
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: 'Failed to inspect credentials' });
  }
});

export default router;
