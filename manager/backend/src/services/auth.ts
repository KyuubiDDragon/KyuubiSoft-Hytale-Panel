import jwt, { type SignOptions } from 'jsonwebtoken';
import crypto from 'crypto';
import { config } from '../config.js';
import type { JwtPayload } from '../types/index.js';
import { verifyUserCredentials, updateLastLogin, getTokenVersion, type User } from './users.js';

// WebSocket ticket storage - short-lived, single-use tokens
interface WsTicket {
  username: string;
  createdAt: number;
  used: boolean;
}

const wsTickets = new Map<string, WsTicket>();
const WS_TICKET_TTL = 30000; // 30 seconds
const WS_TICKET_CLEANUP_INTERVAL = 60000; // 1 minute

// Cleanup expired tickets periodically
setInterval(() => {
  const now = Date.now();
  for (const [ticketId, ticket] of wsTickets.entries()) {
    if (now - ticket.createdAt > WS_TICKET_TTL || ticket.used) {
      wsTickets.delete(ticketId);
    }
  }
}, WS_TICKET_CLEANUP_INTERVAL);

// Verify credentials using users service
export async function verifyCredentials(
  username: string,
  password: string
): Promise<{ valid: boolean; user?: Omit<User, 'passwordHash'>; role?: string }> {
  const user = await verifyUserCredentials(username, password);
  if (!user) {
    return { valid: false };
  }
  await updateLastLogin(username);
  const { passwordHash, ...userWithoutPassword } = user;
  return { valid: true, user: userWithoutPassword, role: user.roleId };
}

export async function createAccessToken(subject: string): Promise<string> {
  const tokenVersion = await getTokenVersion(subject);
  return jwt.sign(
    { sub: subject, type: 'access', tokenVersion },
    config.jwtSecret,
    { expiresIn: config.jwtExpiresIn, algorithm: 'HS256' } as SignOptions
  );
}

export function createRefreshToken(subject: string): string {
  return jwt.sign(
    { sub: subject, type: 'refresh' },
    config.jwtSecret,
    { expiresIn: config.refreshExpiresIn, algorithm: 'HS256' } as SignOptions
  );
}

export function verifyToken(token: string, type: 'access' | 'refresh' = 'access'): { username: string; tokenVersion?: number } | null {
  try {
    const payload = jwt.verify(token, config.jwtSecret, { algorithms: ['HS256'] }) as JwtPayload & { tokenVersion?: number };
    if (payload.type !== type) {
      return null;
    }
    return { username: payload.sub, tokenVersion: payload.tokenVersion };
  } catch {
    return null;
  }
}

// WebSocket Ticket System
// Creates short-lived, single-use tickets for WebSocket authentication
// This prevents tokens from being exposed in URL query strings

export function createWsTicket(username: string): string {
  const ticketId = crypto.randomBytes(32).toString('hex');
  wsTickets.set(ticketId, {
    username,
    createdAt: Date.now(),
    used: false,
  });
  return ticketId;
}

export function verifyWsTicket(ticketId: string): { valid: boolean; username?: string } {
  const ticket = wsTickets.get(ticketId);

  if (!ticket) {
    return { valid: false };
  }

  // Check if ticket is expired
  if (Date.now() - ticket.createdAt > WS_TICKET_TTL) {
    wsTickets.delete(ticketId);
    return { valid: false };
  }

  // Check if ticket was already used
  if (ticket.used) {
    wsTickets.delete(ticketId);
    return { valid: false };
  }

  // Mark ticket as used and return success
  ticket.used = true;
  // Delete ticket after short delay to allow for connection establishment
  setTimeout(() => wsTickets.delete(ticketId), 5000);

  return { valid: true, username: ticket.username };
}
