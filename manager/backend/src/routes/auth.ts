import { Router, Request, Response } from 'express';
import rateLimit from 'express-rate-limit';
import { verifyCredentials, createAccessToken, createRefreshToken, verifyToken } from '../services/auth.js';
import { authMiddleware } from '../middleware/auth.js';
import { getAllUsers, createUser, updateUser, deleteUser, getUser } from '../services/users.js';
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

  const accessToken = createAccessToken(username);
  const refreshToken = createRefreshToken(username);

  res.json({
    access_token: accessToken,
    refresh_token: refreshToken,
    token_type: 'bearer',
    role: result.role,
  });
});

// POST /api/auth/refresh
router.post('/refresh', refreshLimiter, (req: Request, res: Response) => {
  const { refresh_token } = req.body;

  if (!refresh_token) {
    res.status(400).json({ detail: 'Refresh token required' });
    return;
  }

  const username = verifyToken(refresh_token, 'refresh');

  if (!username) {
    res.status(401).json({ detail: 'Invalid or expired refresh token' });
    return;
  }

  const accessToken = createAccessToken(username);
  const newRefreshToken = createRefreshToken(username);

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
  if (!user) {
    res.json({ username, role: 'admin' });
    return;
  }
  res.json({ username, role: user.role });
});

// ============== USER MANAGEMENT (Admin only) ==============

// Middleware to check admin role
async function adminOnly(req: AuthenticatedRequest, res: Response, next: () => void) {
  const username = req.user!;  // authMiddleware guarantees this is set
  const user = await getUser(username);
  if (!user || user.role !== 'admin') {
    res.status(403).json({ error: 'Admin access required' });
    return;
  }
  next();
}

// GET /api/auth/users - List all users
router.get('/users', authMiddleware, async (req: AuthenticatedRequest, res: Response) => {
  await adminOnly(req, res, async () => {
    try {
      const users = await getAllUsers();
      res.json({ users });
    } catch (error) {
      res.status(500).json({ error: 'Failed to get users' });
    }
  });
});

// POST /api/auth/users - Create new user
router.post('/users', authMiddleware, async (req: AuthenticatedRequest, res: Response) => {
  await adminOnly(req, res, async () => {
    try {
      const { username, password, role } = req.body;

      if (!username || !password) {
        res.status(400).json({ error: 'Username and password required' });
        return;
      }

      const user = await createUser(username, password, role || 'viewer');
      res.json({ success: true, user });
    } catch (error) {
      res.status(400).json({ error: (error as Error).message });
    }
  });
});

// PUT /api/auth/users/:username - Update user
router.put('/users/:username', authMiddleware, async (req: AuthenticatedRequest, res: Response) => {
  await adminOnly(req, res, async () => {
    try {
      const { username } = req.params;
      const { password, role } = req.body;

      if (!password && !role) {
        res.status(400).json({ error: 'Nothing to update' });
        return;
      }

      const user = await updateUser(username, { password, role });
      res.json({ success: true, user });
    } catch (error) {
      res.status(400).json({ error: (error as Error).message });
    }
  });
});

// DELETE /api/auth/users/:username - Delete user
router.delete('/users/:username', authMiddleware, async (req: AuthenticatedRequest, res: Response) => {
  await adminOnly(req, res, async () => {
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
});

export default router;
