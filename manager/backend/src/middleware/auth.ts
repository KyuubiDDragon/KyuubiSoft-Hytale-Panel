import { Request, Response, NextFunction } from 'express';
import { verifyToken } from '../services/auth.js';
import type { AuthenticatedRequest } from '../types/index.js';

export function authMiddleware(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): void {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    res.status(401).json({ detail: 'Missing or invalid authorization header' });
    return;
  }

  const token = authHeader.substring(7);
  const username = verifyToken(token, 'access');

  if (!username) {
    res.status(401).json({ detail: 'Invalid or expired token' });
    return;
  }

  req.user = username;
  next();
}
