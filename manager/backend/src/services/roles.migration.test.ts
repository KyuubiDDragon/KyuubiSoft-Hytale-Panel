/**
 * Permission migration for an existing roles.json: the built-in roles get what
 * a new install gives them (Operator and Viewer: mods.panel.view; the action
 * right stays with Administrator's '*'), custom roles stay as they are, and a
 * second start or a permission an admin removed later changes nothing.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { promises as fsp } from 'fs';
import path from 'path';
import os from 'os';
import type { RolesData } from '../types/permissions.js';

let tmpDir: string;
let prevDataPath: string | undefined;
let rolesFile: string;

const now = '2026-01-01T00:00:00.000Z';
const role = (id: string, name: string, permissions: string[], isSystem = true) => ({
  id,
  name,
  description: '',
  permissions,
  isSystem,
  createdAt: now,
  updatedAt: now,
});

/** roles.json as an install from before the mod panel wrote it. */
function legacyRoles(): RolesData {
  return {
    version: 7,
    lastModified: now,
    roles: [
      role('admin', 'Administrator', ['*']),
      role('moderator', 'Moderator', ['players.view', 'players.kick']),
      role('operator', 'Ops (renamed)', ['console.execute', 'mods.view']),
      role('viewer', 'Viewer', ['mods.view']),
      role('custom-1', 'Helpers', ['players.view'], false),
    ],
  } as RolesData;
}

async function readFileData(): Promise<RolesData> {
  return JSON.parse(await fsp.readFile(rolesFile, 'utf-8')) as RolesData;
}

const permsOf = (data: RolesData, id: string) => data.roles.find((r) => r.id === id)?.permissions;

beforeAll(async () => {
  prevDataPath = process.env.MANAGER_DATA_PATH;
  delete process.env.DEMO_MODE;
  tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'roles-migration-test-'));
  process.env.MANAGER_DATA_PATH = tmpDir;
  rolesFile = path.join(tmpDir, 'roles.json');
});

afterAll(async () => {
  if (prevDataPath === undefined) delete process.env.MANAGER_DATA_PATH;
  else process.env.MANAGER_DATA_PATH = prevDataPath;
  await fsp.rm(tmpDir, { recursive: true, force: true });
});

beforeEach(async () => {
  await fsp.rm(rolesFile, { force: true });
});

describe('built-in role permission migration', () => {
  it('grants mods.panel.view to Operator and Viewer, never mods.panel.action', async () => {
    await fsp.writeFile(rolesFile, JSON.stringify(legacyRoles()), 'utf-8');
    const { initializeRoles } = await import('./roles.js');
    await initializeRoles();

    const data = await readFileData();
    expect(permsOf(data, 'operator')).toEqual(['console.execute', 'mods.view', 'mods.panel.view']);
    expect(permsOf(data, 'viewer')).toEqual(['mods.view', 'mods.panel.view']);
    expect(permsOf(data, 'moderator')).toEqual(['players.view', 'players.kick']);
    expect(permsOf(data, 'admin')).toEqual(['*']);
    expect(permsOf(data, 'custom-1')).toEqual(['players.view']);
    expect(data.appliedMigrations).toContain('mod-panel-permissions');
    expect(data.version).toBe(8);
  });

  it('is idempotent and does not bring back a permission an admin removed', async () => {
    await fsp.writeFile(rolesFile, JSON.stringify(legacyRoles()), 'utf-8');
    const { initializeRoles } = await import('./roles.js');
    await initializeRoles();
    await initializeRoles();
    const once = await readFileData();
    expect(once.version).toBe(8);
    expect(permsOf(once, 'operator')?.filter((p) => p === 'mods.panel.view')).toHaveLength(1);

    // The admin takes the right away from Viewer again.
    const edited = {
      ...once,
      roles: once.roles.map((r) =>
        r.id === 'viewer'
          ? { ...r, permissions: r.permissions.filter((p) => p !== 'mods.panel.view') }
          : r,
      ),
    };
    await fsp.writeFile(rolesFile, JSON.stringify(edited), 'utf-8');
    await initializeRoles();
    const after = await readFileData();
    expect(permsOf(after, 'viewer')).toEqual(['mods.view']);
    expect(after.version).toBe(8);
  });

  it('writes new installs with the migration recorded and without the action right for Operator', async () => {
    const { initializeRoles } = await import('./roles.js');
    await initializeRoles();
    const data = await readFileData();
    expect(data.appliedMigrations).toContain('mod-panel-permissions');
    expect(permsOf(data, 'operator')).toContain('mods.panel.view');
    expect(permsOf(data, 'operator')).not.toContain('mods.panel.action');
    expect(permsOf(data, 'viewer')).toContain('mods.panel.view');
  });

  it('adds nothing twice to a role that already has the permission', async () => {
    const { migrateSystemRolePermissions } = await import('./roles.js');
    const data = legacyRoles();
    data.roles[3].permissions.push('mods.panel.view');
    expect(migrateSystemRolePermissions(data)).toBe(true);
    expect(permsOf(data, 'viewer')).toEqual(['mods.view', 'mods.panel.view']);
    expect(migrateSystemRolePermissions(data)).toBe(false);
  });
});
