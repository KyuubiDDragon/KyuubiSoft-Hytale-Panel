/**
 * Unit tests for the permission perimeter (requirePermission / effective
 * permission resolution). The roles service is mocked so the tests pin the
 * exact authorization logic: role lookup, the admin wildcard, and — critically —
 * that an API key is limited to the INTERSECTION of its scopes and its owner's
 * current rights.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Response, NextFunction } from 'express';
import type { AuthenticatedRequest } from '../types/index.js';

const getUserPermissions = vi.fn();
const getUserPermissionsForServer = vi.fn();
vi.mock('../services/roles.js', () => ({
  getUserPermissions: (...a: unknown[]) => getUserPermissions(...a),
  getUserPermissionsForServer: (...a: unknown[]) => getUserPermissionsForServer(...a),
}));

const { requirePermission } = await import('./permissions.js');

function mockRes(): { res: Response; status: () => number | undefined } {
  let statusCode: number | undefined;
  const res = {} as Response;
  res.status = vi.fn((c: number) => { statusCode = c; return res; }) as unknown as Response['status'];
  res.json = vi.fn(() => res) as unknown as Response['json'];
  return { res, status: () => statusCode };
}
const run = (perm: string, req: Partial<AuthenticatedRequest>) => {
  const { res, status } = mockRes();
  const next = vi.fn();
  return requirePermission(perm as never)(req as AuthenticatedRequest, res, next as NextFunction)
    .then(() => ({ status, next }));
};

describe('requirePermission', () => {
  beforeEach(() => { getUserPermissions.mockReset(); getUserPermissionsForServer.mockReset(); });

  it('401s an unauthenticated request', async () => {
    const { status, next } = await run('backups.create', {});
    expect(status()).toBe(401);
    expect(next).not.toHaveBeenCalled();
  });

  it('calls next when the user holds the permission', async () => {
    getUserPermissions.mockResolvedValue(['backups.create', 'users.view']);
    const { next } = await run('backups.create', { user: 'alice' });
    expect(next).toHaveBeenCalledOnce();
  });

  it('403s when the user lacks the permission', async () => {
    getUserPermissions.mockResolvedValue(['backups.view']);
    const { status, next } = await run('backups.create', { user: 'bob' });
    expect(status()).toBe(403);
    expect(next).not.toHaveBeenCalled();
  });

  it('grants any permission to a wildcard (*) role', async () => {
    getUserPermissions.mockResolvedValue(['*']);
    const { next } = await run('anything.at.all', { user: 'admin' });
    expect(next).toHaveBeenCalledOnce();
  });

  it('limits an API key to the intersection of its scopes and the owner perms', async () => {
    getUserPermissions.mockResolvedValue(['backups.create', 'users.view']); // owner rights
    const apiKey = { id: 'k1', scopes: ['backups.create'] };
    // in-scope → allowed
    const allowed = await run('backups.create', { user: 'alice', apiKey });
    expect(allowed.next).toHaveBeenCalledOnce();
    // owner has users.view, but the key does not scope it → denied
    const denied = await run('users.view', { user: 'alice', apiKey });
    expect(denied.status()).toBe(403);
  });

  it('keeps an admin-owned key restricted to its declared scopes', async () => {
    getUserPermissions.mockResolvedValue(['*']); // owner is admin
    const apiKey = { id: 'k2', scopes: ['server.view_status'] };
    expect((await run('server.view_status', { user: 'root', apiKey })).next).toHaveBeenCalledOnce();
    expect((await run('users.delete', { user: 'root', apiKey })).status()).toBe(403);
  });

  it('gives a key no rights once its owner is gone', async () => {
    getUserPermissions.mockResolvedValue([]); // owner deleted ⇒ no perms
    const { status } = await run('backups.create', { user: 'ghost', apiKey: { id: 'k3', scopes: ['backups.create'] } });
    expect(status()).toBe(403);
  });

  it('uses per-server permissions when the route is server-scoped', async () => {
    getUserPermissionsForServer.mockResolvedValue(['console.execute']);
    const { next } = await run('console.execute', { user: 'op', serverId: 'srv-1' });
    expect(getUserPermissionsForServer).toHaveBeenCalledWith('op', 'srv-1');
    expect(next).toHaveBeenCalledOnce();
  });
});
