import { Request, Response, NextFunction } from 'express';
import { verifyToken } from '../services/auth.js';
import { getTokenVersion, isUserInvalidated } from '../services/users.js';
import { isDemoModeEnabled, isDemoUser } from '../services/demo.js';
import type { AuthenticatedRequest } from '../types/index.js';

export async function authMiddleware(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    res.status(401).json({ detail: 'Missing or invalid authorization header' });
    return;
  }

  const token = authHeader.substring(7);
  const result = verifyToken(token, 'access');

  if (!result) {
    res.status(401).json({ detail: 'Invalid or expired token' });
    return;
  }

  // Skip user validation for demo users
  if (isDemoModeEnabled() && isDemoUser(result.username)) {
    req.user = result.username;
    next();
    return;
  }

  // Check if user was deleted
  if (isUserInvalidated(result.username)) {
    res.status(401).json({ detail: 'User session invalidated', code: 'USER_DELETED' });
    return;
  }

  // Check if token version matches (if present in token)
  if (result.tokenVersion !== undefined) {
    const currentVersion = await getTokenVersion(result.username);
    if (currentVersion !== result.tokenVersion) {
      res.status(401).json({ detail: 'Session expired due to account changes', code: 'TOKEN_INVALIDATED' });
      return;
    }
  }

  req.user = result.username;
  next();
}
