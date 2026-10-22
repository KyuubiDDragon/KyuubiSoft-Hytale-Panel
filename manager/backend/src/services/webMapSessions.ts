/**
 * WebMap access sessions.
 *
 * The WebMap page comes from a third-party map mod running in the game
 * container. The panel proxies it, but forces it into a sandbox with an
 * opaque origin (see routes/webmap.ts) so its JavaScript can't read the
 * panel's stored tokens or call the panel API as the logged-in user.
 *
 * A sandboxed document sends neither the panel's Bearer token nor its
 * SameSite cookies, so access is bound to an unguessable session id that is
 * part of the proxied path: /api/webmap/t/<id>/... — the map's relative URLs
 * keep working under that prefix.
 *
 * Sessions are minted by an authenticated user holding players.view and are
 * re-checked on every request: the user must still exist, still hold
 * players.view and still have the token version the session was minted
 * with, so logout, password/role changes and permission revocation take
 * effect immediately. A session expires after WEBMAP_SESSION_IDLE_TTL_MS
 * without use (an open map WebSocket counts as use) and after
 * WEBMAP_SESSION_MAX_TTL_MS in any case.
 */
import crypto from 'crypto';
import { hasPermission } from './roles.js';
import { getTokenVersion, isUserInvalidated } from './users.js';

export const WEBMAP_SESSION_IDLE_TTL_MS = 15 * 60 * 1000; // 15 minutes
export const WEBMAP_SESSION_MAX_TTL_MS = 12 * 60 * 60 * 1000; // 12 hours
const MAX_SESSIONS_PER_USER = 20;
const CLEANUP_INTERVAL_MS = 60 * 1000;
const SESSION_ID_PATTERN = /^[a-f0-9]{64}$/;

interface WebMapSession {
  readonly username: string;
  readonly tokenVersion: number;
  readonly createdAt: number;
  readonly lastUsedAt: number;
  readonly openSockets: number;
}

export type WebMapAccess =
  { ok: true; username: string } | { ok: false; status: 401 | 403; error: string };

const sessions = new Map<string, WebMapSession>();
// Close callbacks of the WebSockets open on each session.
const socketClosers = new Map<string, Set<() => void>>();

const INVALID: WebMapAccess = {
  ok: false,
  status: 401,
  error: 'WebMap session invalid or expired',
};
const FORBIDDEN: WebMapAccess = {
  ok: false,
  status: 403,
  error: 'Permission denied: players.view required',
};

function isExpired(session: WebMapSession, now: number): boolean {
  if (now - session.createdAt > WEBMAP_SESSION_MAX_TTL_MS) return true;
  return session.openSockets === 0 && now - session.lastUsedAt > WEBMAP_SESSION_IDLE_TTL_MS;
}

setInterval(() => {
  const now = Date.now();
  for (const [id, session] of sessions.entries()) {
    if (isExpired(session, now)) sessions.delete(id);
  }
}, CLEANUP_INTERVAL_MS).unref();

export function isWebMapSessionId(value: unknown): value is string {
  return typeof value === 'string' && SESSION_ID_PATTERN.test(value);
}

/** Mint a session for `username`. The caller must have checked players.view. */
export async function createWebMapSession(username: string): Promise<string> {
  const tokenVersion = await getTokenVersion(username);

  // Bound memory per user: drop the oldest sessions beyond the cap, idle
  // ones (no open map WebSocket) first so a live map keeps working.
  const own = [...sessions.entries()]
    .filter(([, s]) => s.username === username)
    .sort(([, a], [, b]) => Number(a.openSockets > 0) - Number(b.openSockets > 0) || a.createdAt - b.createdAt);
  for (const [id] of own.slice(0, Math.max(0, own.length - MAX_SESSIONS_PER_USER + 1))) {
    sessions.delete(id);
  }

  const id = crypto.randomBytes(32).toString('hex');
  const now = Date.now();
  sessions.set(id, { username, tokenVersion, createdAt: now, lastUsedAt: now, openSockets: 0 });
  return id;
}

/**
 * Validate a session for one proxied request and mark it as used.
 * 401 = unknown/expired/revoked session, 403 = user lacks players.view.
 */
export async function checkWebMapSession(id: string): Promise<WebMapAccess> {
  const session = isWebMapSessionId(id) ? sessions.get(id) : undefined;
  if (!session) return INVALID;

  const now = Date.now();
  if (isExpired(session, now)) {
    sessions.delete(id);
    return INVALID;
  }
  if (
    isUserInvalidated(session.username) ||
    (await getTokenVersion(session.username)) !== session.tokenVersion
  ) {
    sessions.delete(id);
    return INVALID;
  }
  if (!(await hasPermission(session.username, 'players.view'))) return FORBIDDEN;

  const current = sessions.get(id);
  if (!current) return INVALID; // revoked while we were checking
  sessions.set(id, { ...current, lastUsedAt: now });
  return { ok: true, username: session.username };
}

/** Revoke a session and close its WebSockets; only its owner may do so. */
export function revokeWebMapSession(id: string, username: string): boolean {
  const session = sessions.get(id);
  if (!session || session.username !== username) return false;
  sessions.delete(id);
  for (const close of socketClosers.get(id) ?? []) close();
  socketClosers.delete(id);
  return true;
}

/**
 * Register an open map WebSocket on a session. While any socket is open the
 * session doesn't idle out; `close` is called if the session is revoked.
 * Returns the release callback for socket close.
 */
export function trackWebMapSocket(id: string, close: () => void): () => void {
  const update = (delta: number): void => {
    const session = sessions.get(id);
    if (!session) return;
    sessions.set(id, {
      ...session,
      openSockets: Math.max(0, session.openSockets + delta),
      lastUsedAt: Date.now(),
    });
  };
  update(1);
  const closers = socketClosers.get(id) ?? new Set<() => void>();
  closers.add(close);
  socketClosers.set(id, closers);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    closers.delete(close);
    if (closers.size === 0 && socketClosers.get(id) === closers) socketClosers.delete(id);
    update(-1);
  };
}
