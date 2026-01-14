import jwt, { type SignOptions } from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import { config } from '../config.js';
import type { JwtPayload } from '../types/index.js';

// Hash the password at startup
const hashedPassword = bcrypt.hashSync(config.managerPassword, 12);

export function verifyPassword(password: string): boolean {
  return bcrypt.compareSync(password, hashedPassword);
}

export function verifyCredentials(username: string, password: string): boolean {
  if (username !== config.managerUsername) {
    return false;
  }
  return verifyPassword(password);
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
