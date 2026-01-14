import jwt, { type SignOptions } from 'jsonwebtoken';
import { config } from '../config.js';
import type { JwtPayload } from '../types/index.js';
import { verifyUserCredentials, updateLastLogin, type User } from './users.js';

// Verify credentials using users service
export async function verifyCredentials(
  username: string,
  password: string
): Promise<{ valid: boolean; user?: Omit<User, 'passwordHash'>; role?: User['role'] }> {
  const user = await verifyUserCredentials(username, password);
  if (!user) {
    return { valid: false };
  }
  await updateLastLogin(username);
  const { passwordHash, ...userWithoutPassword } = user;
  return { valid: true, user: userWithoutPassword, role: user.role };
}

export function createAccessToken(subject: string): string {
  return jwt.sign(
    { sub: subject, type: 'access' },
    config.jwtSecret,
    { expiresIn: config.jwtExpiresIn } as SignOptions
  );
}

export function createRefreshToken(subject: string): string {
  return jwt.sign(
    { sub: subject, type: 'refresh' },
    config.jwtSecret,
    { expiresIn: config.refreshExpiresIn } as SignOptions
  );
}

export function verifyToken(token: string, type: 'access' | 'refresh' = 'access'): string | null {
  try {
    const payload = jwt.verify(token, config.jwtSecret) as JwtPayload;
    if (payload.type !== type) {
      return null;
    }
    return payload.sub;
  } catch {
    return null;
  }
}
