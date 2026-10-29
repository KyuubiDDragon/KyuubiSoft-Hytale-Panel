import { Response, NextFunction } from 'express';
import { verifyToken } from '../services/auth.js';
import { isKeyOwnerCurrent, sessionProblem, type SessionProblem } from '../services/users.js';
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
    let ownerCurrent: boolean;
    try {
      ownerCurrent = await isKeyOwnerCurrent(result.ownerUsername, result.createdAt);
    } catch (err) {
      next(err);
      return;
    }
    if (!ownerCurrent) {
      res.status(401).json({ detail: 'The owner of this API key no longer exists' });
      return;
    }
    req.user = result.ownerUsername;
    req.apiKey = {
      id: result.keyId,
      scopes: result.scopes,
      serverIds: result.serverIds,
      expiresAt: result.expiresAt,
    };
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

  // The account must still exist (also after a restart) and its tokenVersion
  // match: deleted accounts, and accounts created again under the same name,
  // get none of the old sessions.
  let problem: SessionProblem | null;
  try {
    problem = await sessionProblem(result.username, result.tokenVersion);
  } catch (err) {
    // users.json unreadable (corrupt, permissions): fail closed with 500
    // via the global error handler instead of leaving the request hanging.
    next(err);
    return;
  }
  if (problem === 'USER_DELETED') {
    res.status(401).json({ detail: 'User session invalidated', code: 'USER_DELETED' });
    return;
  }
  if (problem === 'TOKEN_INVALIDATED') {
    res
      .status(401)
      .json({ detail: 'Session expired due to account changes', code: 'TOKEN_INVALIDATED' });
    return;
  }

  req.user = result.username;
  next();
}
