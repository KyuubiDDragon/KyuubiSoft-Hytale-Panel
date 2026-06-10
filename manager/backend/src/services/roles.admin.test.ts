/**
 * Regression test for the "stuck as a permission-less viewer" bug.
 *
 * A user with the built-in roleId 'admin' must ALWAYS resolve to full access
 * (['*']), even when roles.json no longer contains a cleanly-resolvable admin
 * role (edited/renamed via the Roles UI, a migration, or a bad merge). Before
 * the safety net, getUserPermissions() fell through to `return []`, which the
 * UI rendered as a viewer with no permissions.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { promises as fsp } from 'fs';
import path from 'path';
import os from 'os';

let tmpDir: string;
let prevDataPath: string | undefined;

beforeAll(async () => {
  prevDataPath = process.env.MANAGER_DATA_PATH;
  tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'roles-admin-test-'));
  process.env.MANAGER_DATA_PATH = tmpDir;

  // An admin account in users.json…
  await fsp.writeFile(
    path.join(tmpDir, 'users.json'),
    JSON.stringify({
      users: [
        { username: 'boss', passwordHash: 'x', roleId: 'admin', createdAt: new Date().toISOString(), tokenVersion: 1 },
      ],
    }),
    'utf-8',
  );
  // …but a roles.json that does NOT contain a resolvable 'admin'/'Administrator'
  // role, simulating a corrupted/edited file.
  await fsp.writeFile(
    path.join(tmpDir, 'roles.json'),
    JSON.stringify({
      version: 1,
      lastModified: new Date().toISOString(),
      roles: [
        { id: 'viewer', name: 'Viewer', description: '', permissions: ['players.view'], isSystem: true, createdAt: '', updatedAt: '' },
      ],
    }),
    'utf-8',
  );
});

afterAll(async () => {
  if (prevDataPath === undefined) delete process.env.MANAGER_DATA_PATH;
  else process.env.MANAGER_DATA_PATH = prevDataPath;
  await fsp.rm(tmpDir, { recursive: true, force: true });
});

describe('getUserPermissions admin safety net', () => {
  it("returns ['*'] for a roleId 'admin' user even when roles.json can't resolve it", async () => {
    const { getUserPermissions } = await import('./roles.js');
    const perms = await getUserPermissions('boss');
    expect(perms).toEqual(['*']);
  });
});
