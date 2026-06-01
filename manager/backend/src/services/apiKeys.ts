/**
 * REST API keys with scopes.
 *
 * Tokens are issued once at creation, stored only as bcrypt hashes. The
 * first eight characters of the token act as a public prefix for the UI
 * ("show me my key kp_ab12cd34…") and for fast lookup during authentication
 * (narrows the bcrypt comparison set to a single row in practice).
 */
import bcrypt from 'bcrypt';
import crypto from 'crypto';
import { getDb } from '../db/index.js';

export interface ApiKey {
  id: string;
  ownerUsername: string;
  name: string;
  scopes: string[];
  prefix: string;
  createdAt: string;
  lastUsedAt: string | null;
  expiresAt: string | null;
  revokedAt: string | null;
}

interface ApiKeyRow {
  id: string;
  owner_username: string;
  name: string;
  scopes: string;
  hashed_token: string;
  prefix: string;
  created_at: string;
  last_used_at: string | null;
  expires_at: string | null;
  revoked_at: string | null;
}

function rowToKey(row: ApiKeyRow): ApiKey {
  return {
    id: row.id,
    ownerUsername: row.owner_username,
    name: row.name,
    scopes: JSON.parse(row.scopes) as string[],
    prefix: row.prefix,
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at,
    expiresAt: row.expires_at,
    revokedAt: row.revoked_at,
  };
}

export async function createApiKey(opts: {
  ownerUsername: string;
  name: string;
  scopes: string[];
  expiresAt?: string | null;
}): Promise<{ key: ApiKey; token: string }> {
  const id = crypto.randomUUID();
  // The token format kp_<32 base32 chars>. base32 (no padding) gives ~160 bits
  // of entropy in 32 chars without ambiguous characters.
  const raw = crypto.randomBytes(20).toString('base64').replace(/[^A-Za-z0-9]/g, '').slice(0, 32);
  const token = `kp_${raw}`;
  const prefix = token.slice(0, 8);
  const hashed = await bcrypt.hash(token, 10);
  const now = new Date().toISOString();

  getDb().prepare(`
    INSERT INTO api_keys
      (id, owner_username, name, scopes, hashed_token, prefix, created_at, expires_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, opts.ownerUsername, opts.name, JSON.stringify(opts.scopes), hashed, prefix, now, opts.expiresAt ?? null);

  return {
    key: {
      id, ownerUsername: opts.ownerUsername, name: opts.name, scopes: opts.scopes,
      prefix, createdAt: now, lastUsedAt: null, expiresAt: opts.expiresAt ?? null, revokedAt: null,
    },
    token,
  };
}

export function listApiKeys(ownerUsername: string): ApiKey[] {
  const rows = getDb()
    .prepare('SELECT * FROM api_keys WHERE owner_username = ? ORDER BY created_at DESC')
    .all(ownerUsername) as ApiKeyRow[];
  return rows.map(rowToKey);
}

export function revokeApiKey(ownerUsername: string, id: string): boolean {
  const info = getDb()
    .prepare("UPDATE api_keys SET revoked_at = ? WHERE id = ? AND owner_username = ? AND revoked_at IS NULL")
    .run(new Date().toISOString(), id, ownerUsername);
  return info.changes > 0;
}

/**
 * Look up a token. Returns null if the token is unknown, revoked, expired,
 * or doesn't match. Updates last_used_at on success.
 */
export async function verifyApiKey(token: string): Promise<{ keyId: string; ownerUsername: string; scopes: string[] } | null> {
  if (!token.startsWith('kp_')) return null;
  const prefix = token.slice(0, 8);
  const candidates = getDb()
    .prepare(`SELECT * FROM api_keys WHERE prefix = ? AND revoked_at IS NULL`)
    .all(prefix) as ApiKeyRow[];
  const now = Date.now();
  for (const row of candidates) {
    if (row.expires_at && Date.parse(row.expires_at) < now) continue;
    if (await bcrypt.compare(token, row.hashed_token)) {
      getDb().prepare('UPDATE api_keys SET last_used_at = ? WHERE id = ?').run(new Date().toISOString(), row.id);
      return {
        keyId: row.id,
        ownerUsername: row.owner_username,
        scopes: JSON.parse(row.scopes) as string[],
      };
    }
  }
  return null;
}
