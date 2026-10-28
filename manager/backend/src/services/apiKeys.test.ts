/**
 * Unit tests for the REST API key service.
 *
 * Each test re-imports the module with a fresh MANAGER_DATA_PATH so the
 * panel.sqlite that backs api_keys is isolated.
 */
import path from 'path';
import os from 'os';
import fs from 'fs';
import { describe, it, expect, beforeAll } from 'vitest';

const tmpDir = path.join(os.tmpdir(), `kp-apikeys-${Date.now()}`);
fs.mkdirSync(tmpDir, { recursive: true });
process.env.MANAGER_DATA_PATH = tmpDir;

describe('apiKeys service', () => {
  let token: string;
  let id: string;

  beforeAll(async () => {
    const { createApiKey } = await import('./apiKeys.js');
    const r = await createApiKey({
      ownerUsername: 'alice',
      name: 'CI deploy bot',
      scopes: ['server.view_status', 'backups.create'],
    });
    token = r.token;
    id = r.key.id;
  });

  it('issues a kp_-prefixed token', () => {
    // base64 minus non-alphanumerics; final length is implementation-dependent
    // but always kp_ + at least ~20 ASCII alphanumerics.
    expect(token).toMatch(/^kp_[A-Za-z0-9]{20,40}$/);
  });

  it('lists the key for the owner without leaking the token', async () => {
    const { listApiKeys } = await import('./apiKeys.js');
    const keys = listApiKeys('alice');
    expect(keys).toHaveLength(1);
    expect(keys[0]).toMatchObject({ name: 'CI deploy bot', revokedAt: null });
    // No token field on the returned key
    expect((keys[0] as unknown as Record<string, unknown>).token).toBeUndefined();
    // prefix is the first 8 chars
    expect(token.startsWith(keys[0].prefix)).toBe(true);
  });

  it('verifyApiKey accepts the token and stamps last_used_at', async () => {
    const { verifyApiKey, listApiKeys } = await import('./apiKeys.js');
    const r = await verifyApiKey(token);
    expect(r).not.toBeNull();
    expect(r?.ownerUsername).toBe('alice');
    expect(r?.scopes).toEqual(['server.view_status', 'backups.create']);
    const after = listApiKeys('alice');
    expect(after[0].lastUsedAt).not.toBeNull();
  });

  it('rejects an unknown token', async () => {
    const { verifyApiKey } = await import('./apiKeys.js');
    expect(await verifyApiKey('kp_NOTAREALKEY01234567890123456789012')).toBeNull();
    expect(await verifyApiKey('Bearer something')).toBeNull();
  });

  it('rejects after revoke', async () => {
    const { revokeApiKey, verifyApiKey } = await import('./apiKeys.js');
    expect(revokeApiKey('alice', id)).toBe(true);
    expect(await verifyApiKey(token)).toBeNull();
  });
});

describe('apiKeys server lists', () => {
  it('creates keys without a list and reports serverIds: null', async () => {
    const { createApiKey, verifyApiKey } = await import('./apiKeys.js');
    const { key, token } = await createApiKey({ ownerUsername: 'bob', name: 'k', scopes: [] });
    expect(key.serverIds).toBeNull();
    expect((await verifyApiKey(token))?.serverIds).toBeNull();
  });

  it('stores a list, hands it to verifyApiKey and lifts it again', async () => {
    const { createApiKey, verifyApiKey, setApiKeyServerIds, listApiKeys } =
      await import('./apiKeys.js');
    const { key, token } = await createApiKey({ ownerUsername: 'bob', name: 'l', scopes: [] });
    expect(setApiKeyServerIds('bob', key.id, ['b1', 'b1', 'c2'])).toBe(true);
    expect((await verifyApiKey(token))?.serverIds).toEqual(['b1', 'c2']);
    expect(listApiKeys('bob').find((k) => k.id === key.id)?.serverIds).toEqual(['b1', 'c2']);
    expect(setApiKeyServerIds('bob', key.id, [])).toBe(true);
    expect((await verifyApiKey(token))?.serverIds).toEqual([]);
    expect(setApiKeyServerIds('bob', key.id, null)).toBe(true);
    expect((await verifyApiKey(token))?.serverIds).toBeNull();
  });

  it("does not touch another owner's or a revoked key", async () => {
    const { createApiKey, setApiKeyServerIds, revokeApiKey, getOwnApiKey } =
      await import('./apiKeys.js');
    const { key } = await createApiKey({ ownerUsername: 'bob', name: 'm', scopes: [] });
    expect(setApiKeyServerIds('mallory', key.id, ['b1'])).toBe(false);
    expect(getOwnApiKey('mallory', key.id)).toBeNull();
    revokeApiKey('bob', key.id);
    expect(setApiKeyServerIds('bob', key.id, ['b1'])).toBe(false);
    expect(getOwnApiKey('bob', key.id)?.serverIds).toBeNull();
  });

  it('limits a key with a damaged list to no server', async () => {
    const { createApiKey, verifyApiKey } = await import('./apiKeys.js');
    const { getDb } = await import('../db/index.js');
    const { key, token } = await createApiKey({ ownerUsername: 'bob', name: 'n', scopes: [] });
    for (const raw of ['not json', '"b1"', '[1,2]', '{"b1":true}']) {
      getDb().prepare('UPDATE api_keys SET server_ids = ? WHERE id = ?').run(raw, key.id);
      expect((await verifyApiKey(token))?.serverIds).toEqual([]);
    }
  });
});
