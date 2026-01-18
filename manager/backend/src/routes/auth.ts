import { Router, Request, Response } from 'express';
import rateLimit from 'express-rate-limit';
import { verifyCredentials, createAccessToken, createRefreshToken, verifyToken } from '../services/auth.js';
import { authMiddleware } from '../middleware/auth.js';
import { requirePermission } from '../middleware/permissions.js';
import { getAllUsers, createUser, updateUser, deleteUser, getUser } from '../services/users.js';
import { getUserPermissions } from '../services/roles.js';
import { initiateDeviceLogin, checkAuthCompletion, getAuthStatus, resetAuth, setPersistence, listAuthFiles, inspectDownloaderCredentials } from '../services/hytaleAuth.js';
import type { AuthenticatedRequest, LoginRequest } from '../types/index.js';

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

  const result = await verifyCredentials(username, password);

  if (!result.valid) {
    res.status(401).json({ detail: 'Invalid credentials' });
    return;
  }

  const accessToken = await createAccessToken(username);
  const refreshToken = createRefreshToken(username);
  const permissions = await getUserPermissions(username);

  res.json({
    access_token: accessToken,
    refresh_token: refreshToken,
    token_type: 'bearer',
    role: result.role,
    permissions,
  });
});

// POST /api/auth/refresh
router.post('/refresh', refreshLimiter, async (req: Request, res: Response) => {
  const { refresh_token } = req.body;

  if (!refresh_token) {
    res.status(400).json({ detail: 'Refresh token required' });
    return;
  }

  const result = verifyToken(refresh_token, 'refresh');

  if (!result) {
    res.status(401).json({ detail: 'Invalid or expired refresh token' });
    return;
  }

  const accessToken = await createAccessToken(result.username);
  const newRefreshToken = createRefreshToken(result.username);

  res.json({
    access_token: accessToken,
    refresh_token: newRefreshToken,
    token_type: 'bearer',
  });
});

// POST /api/auth/logout
router.post('/logout', authMiddleware, (_req: Request, res: Response) => {
  res.json({ message: 'Logged out successfully' });
});

// GET /api/auth/me
router.get('/me', authMiddleware, async (req: AuthenticatedRequest, res: Response) => {
  const username = req.user!;  // authMiddleware guarantees this is set
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
  try {
    const users = await getAllUsers();
    res.json({ users });
  } catch (error) {
    res.status(500).json({ error: 'Failed to get users' });
  }
});

// POST /api/auth/users - Create new user
router.post('/users', authMiddleware, requirePermission('users.create'), async (req: AuthenticatedRequest, res: Response) => {
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
router.get('/hytale/status', authMiddleware, async (_req: Request, res: Response) => {
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
router.post('/hytale/check', authMiddleware, async (_req: Request, res: Response) => {
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
router.get('/hytale/files', authMiddleware, async (_req: Request, res: Response) => {
  try {
    const files = await listAuthFiles();
    res.json({ files });
  } catch (error) {
    res.status(500).json({ error: 'Failed to list auth files' });
  }
});

// GET /api/auth/hytale/inspect-credentials - Inspect downloader credentials structure (debug)
router.get('/hytale/inspect-credentials', authMiddleware, async (_req: Request, res: Response) => {
  try {
    const result = await inspectDownloaderCredentials();
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: 'Failed to inspect credentials' });
  }
});

export default router;
