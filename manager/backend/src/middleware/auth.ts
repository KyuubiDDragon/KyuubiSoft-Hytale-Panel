import { Response, NextFunction } from 'express';
import { verifyToken } from '../services/auth.js';
import { getTokenVersion, isUserInvalidated } from '../services/users.js';
import { verifyApiKey } from '../services/apiKeys.js';
import type { AuthenticatedRequest } from '../types/index.js';

/**
 * Auth middleware that accepts EITHER a Bearer JWT (browser/cookie flow)
 * OR a REST API key (`Authorization: ApiKey kp_<base32>`).
 *
 * API-key auth populates req.apiKey so requirePermission() can fall back to
 * the key's scope list when role lookup would otherwise fail.
 */
export async function authMiddleware(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const authHeader = req.headers.authorization;

  if (!authHeader) {
    res.status(401).json({ detail: 'Missing or invalid authorization header' });
    return;
  }

  // API key path
  if (authHeader.startsWith('ApiKey ')) {
    const token = authHeader.substring(7).trim();
    const result = await verifyApiKey(token);
    if (!result) {
      res.status(401).json({ detail: 'Invalid or revoked API key' });
      return;
    }
    req.user = result.ownerUsername;
    req.apiKey = { id: result.keyId, scopes: result.scopes };
    next();
    return;
  }

  // Bearer JWT path (default)
  if (!authHeader.startsWith('Bearer ')) {
    res.status(401).json({ detail: 'Missing or invalid authorization header' });
    return;
  }

  const token = authHeader.substring(7);
  const result = verifyToken(token, 'access');

  if (!result) {
    res.status(401).json({ detail: 'Invalid or expired token' });
    return;
  }

  if (isUserInvalidated(result.username)) {
    res.status(401).json({ detail: 'User session invalidated', code: 'USER_DELETED' });
    return;
  }

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
