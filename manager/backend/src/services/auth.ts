import jwt, { type SignOptions } from 'jsonwebtoken';
import crypto from 'crypto';
import { config } from '../config.js';
import type { JwtPayload } from '../types/index.js';
import { verifyUserCredentials, updateLastLogin, getTokenVersion, type User } from './users.js';

// WebSocket ticket storage - short-lived, single-use tokens
interface WsTicket {
  username: string;
  createdAt: number;
  /** Server id this ticket is bound to. Tickets without scope are
   *  legacy / default-server. Verify enforces the binding. */
  serverId?: string;
}

const wsTickets = new Map<string, WsTicket>();
const WS_TICKET_TTL = 30000; // 30 seconds
const WS_TICKET_CLEANUP_INTERVAL = 60000; // 1 minute

// Cleanup expired tickets periodically
setInterval(() => {
  const now = Date.now();
  for (const [ticketId, ticket] of wsTickets.entries()) {
    if (now - ticket.createdAt > WS_TICKET_TTL) {
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

// Refresh tokens also carry tokenVersion so password/role changes invalidate them.
export async function createRefreshToken(subject: string): Promise<string> {
  const tokenVersion = await getTokenVersion(subject);
  return jwt.sign(
    { sub: subject, type: 'refresh', tokenVersion },
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
// Creates short-lived, single-use tickets for WebSocket authentication.
// Tickets are deleted atomically on first verify to eliminate any race window.

export function createWsTicket(username: string, serverId?: string): string {
  const ticketId = crypto.randomBytes(32).toString('hex');
  wsTickets.set(ticketId, {
    username,
    createdAt: Date.now(),
    serverId,
  });
  return ticketId;
}

/**
 * Verify a single-use ticket. When `expectedServerId` is passed, the ticket
 * must have been issued for the same server (or unscoped). Tickets issued
 * with a serverId can only open WebSockets for that server — this prevents
 * cross-server ticket reuse.
 */
export function verifyWsTicket(ticketId: string, expectedServerId?: string): { valid: boolean; username?: string; serverId?: string } {
  // Atomic check-and-delete: Map.delete returns true only if it existed.
  // This guarantees that even if two requests arrive with the same ticket,
  // only one of them gets past this point.
  const ticket = wsTickets.get(ticketId);
  if (!ticket) {
    return { valid: false };
  }
  const removed = wsTickets.delete(ticketId);
  if (!removed) {
    return { valid: false };
  }

  if (Date.now() - ticket.createdAt > WS_TICKET_TTL) {
    return { valid: false };
  }

  // Scoped ticket must match the request's server scope. Unscoped tickets
  // (legacy single-server) only open unscoped connections.
  if (ticket.serverId !== undefined && expectedServerId !== undefined && ticket.serverId !== expectedServerId) {
    return { valid: false };
  }
  if (ticket.serverId !== undefined && expectedServerId === undefined) {
    // A scoped ticket can't open the legacy unscoped WS endpoint.
    return { valid: false };
  }

  return { valid: true, username: ticket.username, serverId: ticket.serverId };
}
