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
import type { ApiKeyGrant } from '../types/index.js';

export interface ApiKey {
  id: string;
  ownerUsername: string;
  name: string;
  scopes: string[];
  /** Servers the key may act on; null = every server its owner may use. */
  serverIds: string[] | null;
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
  /** JSON list of server ids; NULL = every server. */
  server_ids?: string | null;
  hashed_token: string;
  prefix: string;
  created_at: string;
  last_used_at: string | null;
  expires_at: string | null;
  revoked_at: string | null;
}

/**
 * The stored server list of a key. Fails closed: a value that is not a JSON
 * list of ids limits the key to no server instead of every server.
 */
function parseServerIds(row: ApiKeyRow): string[] | null {
  if (row.server_ids === undefined || row.server_ids === null) return null;
  try {
    const value: unknown = JSON.parse(row.server_ids);
    if (Array.isArray(value) && value.every((id) => typeof id === 'string')) return value;
  } catch {
    // reported below
  }
  console.error(
    `[ApiKeys] server_ids of key ${row.id} is not a list of server ids; key gets no server`,
  );
  return [];
}

function rowToKey(row: ApiKeyRow): ApiKey {
  return {
    id: row.id,
    ownerUsername: row.owner_username,
    name: row.name,
    scopes: JSON.parse(row.scopes) as string[],
    serverIds: parseServerIds(row),
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
  /** Servers the key may use, stored with the key itself; null = its owner's. */
  serverIds?: string[] | null;
}): Promise<{ key: ApiKey; token: string }> {
  const id = crypto.randomUUID();
  // The token format kp_<32 base32 chars>. base32 (no padding) gives ~160 bits
  // of entropy in 32 chars without ambiguous characters.
  const raw = crypto
    .randomBytes(20)
    .toString('base64')
    .replace(/[^A-Za-z0-9]/g, '')
    .slice(0, 32);
  const token = `kp_${raw}`;
  const prefix = token.slice(0, 8);
  const hashed = await bcrypt.hash(token, 10);
  const now = new Date().toISOString();
  const serverIds = opts.serverIds ? [...new Set(opts.serverIds)] : null;

  // One statement: the key never exists without the list it was created with.
  getDb()
    .prepare(
      `
    INSERT INTO api_keys
      (id, owner_username, name, scopes, hashed_token, prefix, created_at, expires_at, server_ids)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `,
    )
    .run(
      id,
      opts.ownerUsername,
      opts.name,
      JSON.stringify(opts.scopes),
      hashed,
      prefix,
      now,
      opts.expiresAt ?? null,
      serverIds === null ? null : JSON.stringify(serverIds),
    );

  return {
    key: {
      id,
      ownerUsername: opts.ownerUsername,
      name: opts.name,
      scopes: opts.scopes,
      serverIds,
      prefix,
      createdAt: now,
      lastUsedAt: null,
      expiresAt: opts.expiresAt ?? null,
      revokedAt: null,
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

/** One of the owner's keys (revoked ones included), or null. */
export function getOwnApiKey(ownerUsername: string, id: string): ApiKey | null {
  const row = getDb()
    .prepare('SELECT * FROM api_keys WHERE id = ? AND owner_username = ?')
    .get(id, ownerUsername) as ApiKeyRow | undefined;
  return row ? rowToKey(row) : null;
}

/**
 * Limit an active key of the owner to `serverIds`, or lift the limit (null).
 * Returns false when the owner has no such active key.
 */
export function setApiKeyServerIds(
  ownerUsername: string,
  id: string,
  serverIds: string[] | null,
): boolean {
  const value = serverIds === null ? null : JSON.stringify([...new Set(serverIds)]);
  const info = getDb()
    .prepare(
      'UPDATE api_keys SET server_ids = ? WHERE id = ? AND owner_username = ? AND revoked_at IS NULL',
    )
    .run(value, id, ownerUsername);
  return info.changes > 0;
}

/** Take a deleted server off every key's list. Returns how many lists changed. */
export function removeServerFromKeyLists(serverId: string): number {
  const db = getDb();
  const rows = db
    .prepare('SELECT * FROM api_keys WHERE server_ids IS NOT NULL')
    .all() as ApiKeyRow[];
  const update = db.prepare('UPDATE api_keys SET server_ids = ? WHERE id = ?');
  let changed = 0;
  db.transaction(() => {
    for (const row of rows) {
      const ids = parseServerIds(row);
      if (!ids?.includes(serverId)) continue;
      update.run(JSON.stringify(ids.filter((id) => id !== serverId)), row.id);
      changed++;
    }
  })();
  return changed;
}

export function revokeApiKey(ownerUsername: string, id: string): boolean {
  const info = getDb()
    .prepare(
      'UPDATE api_keys SET revoked_at = ? WHERE id = ? AND owner_username = ? AND revoked_at IS NULL',
    )
    .run(new Date().toISOString(), id, ownerUsername);
  return info.changes > 0;
}

/** Revoke every active key of an account (it was deleted). Returns how many. */
export function revokeApiKeysOf(ownerUsername: string): number {
  return getDb()
    .prepare('UPDATE api_keys SET revoked_at = ? WHERE owner_username = ? AND revoked_at IS NULL')
    .run(new Date().toISOString(), ownerUsername).changes;
}

/** Scopes and servers of a key that is neither revoked nor expired, else null. */
export function getActiveApiKeyGrant(id: string): ApiKeyGrant | null {
  const row = getDb()
    .prepare('SELECT * FROM api_keys WHERE id = ? AND revoked_at IS NULL')
    .get(id) as ApiKeyRow | undefined;
  if (!row || (row.expires_at && Date.parse(row.expires_at) < Date.now())) return null;
  return { id: row.id, scopes: JSON.parse(row.scopes) as string[], serverIds: parseServerIds(row) };
}

/**
 * Look up a token. Returns null if the token is unknown, revoked, expired,
 * or doesn't match. Updates last_used_at on success.
 */
export async function verifyApiKey(token: string): Promise<{
  keyId: string;
  ownerUsername: string;
  scopes: string[];
  serverIds: string[] | null;
  createdAt: string;
  expiresAt: string | null;
} | null> {
  if (!token.startsWith('kp_')) return null;
  const prefix = token.slice(0, 8);
  const candidates = getDb()
    .prepare(`SELECT * FROM api_keys WHERE prefix = ? AND revoked_at IS NULL`)
    .all(prefix) as ApiKeyRow[];
  const now = Date.now();
  for (const row of candidates) {
    if (row.expires_at && Date.parse(row.expires_at) < now) continue;
    if (await bcrypt.compare(token, row.hashed_token)) {
      getDb()
        .prepare('UPDATE api_keys SET last_used_at = ? WHERE id = ?')
        .run(new Date().toISOString(), row.id);
      return {
        keyId: row.id,
        ownerUsername: row.owner_username,
        scopes: JSON.parse(row.scopes) as string[],
        serverIds: parseServerIds(row),
        createdAt: row.created_at,
        expiresAt: row.expires_at,
      };
    }
  }
  return null;
}
