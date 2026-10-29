/**
 * Who may hand out what: the subset rule for accounts, roles and server lists.
 *
 * Every check compares with what the caller holds right now (the permissions
 * and servers of the request, see middleware/permissions.ts) and refuses
 * anything beyond it:
 *  - an account is only created, changed or deleted by a caller holding every
 *    right that account's roles grant; an admin account only by an admin
 *  - a role is only granted, created or changed by a caller holding all of
 *    its permissions; '*' only by an admin; only catalog permissions exist
 *  - servers are only handed out by a caller who may use them
 *
 * Existing accounts and roles are never rewritten here; only new changes are
 * checked.
 */
import { z } from 'zod';
import { getRolePermissions, roleExists } from './roles.js';
import { allowedServersOf, type User } from './users.js';
import { listServers } from './servers.js';
import { getAllPermissions, WILDCARD_PERMISSION } from '../types/permissions.js';

export type Refusal = { status: number; body: Record<string, unknown> };
export type Checked<T> = { ok: true; value: T } | ({ ok: false } & Refusal);

export function refuse(status: number, error: string, code: string, extra = {}): Refusal {
  return { status, body: { error, code, ...extra } };
}

/** Does `held` cover every permission in `wanted`? Only '*' covers '*'. */
export function coversPermissions(held: readonly string[], wanted: readonly string[]): boolean {
  if (held.includes(WILDCARD_PERMISSION)) return true;
  return !wanted.includes(WILDCARD_PERMISSION) && wanted.every((p) => held.includes(p));
}

/** What a role grants as roles.json defines it; the built-in admin is always '*'. */
export async function rolePermissions(roleId: string): Promise<string[]> {
  if (roleId === 'admin') return [WILDCARD_PERMISSION];
  return (await getRolePermissions(roleId)) as string[];
}

/**
 * Everything an account's roles grant, global and per server. Server lists do
 * not shrink it: an account with a list holds fewer rights only while the
 * list is there, and lifting the list hands them back.
 */
export async function accountPermissions(user: User): Promise<string[]> {
  const scopes = (user as { serverScopes?: Record<string, { roleId?: unknown }> }).serverScopes;
  const roleIds = [user.roleId, ...Object.values(scopes ?? {}).map((s) => s?.roleId)].filter(
    (id): id is string => typeof id === 'string' && id !== '',
  );
  return (await Promise.all(roleIds.map(rolePermissions))).flat();
}

/**
 * May the caller create, change or delete this account? Not when the account
 * holds rights the caller lacks, and, for a caller with a server list, not when
 * the account reaches servers outside that list.
 */
export async function checkAccountWithinCaller(
  callerPerms: readonly string[],
  callerIds: readonly string[] | null,
  target: User,
): Promise<Refusal | null> {
  if (!coversPermissions(callerPerms, await accountPermissions(target))) {
    return refuse(
      403,
      'Cannot change an account that has rights you do not have',
      'TARGET_OUTRANKS_YOU',
    );
  }
  if (callerIds !== null) {
    const current = allowedServersOf(target);
    if (current === null || current.some((id) => !callerIds.includes(id))) {
      return refuse(
        403,
        'Cannot change an account that reaches servers outside your own',
        'TARGET_OUTSIDE_YOUR_SERVERS',
      );
    }
  }
  return null;
}

/** May the caller give an account this role? Only an existing one, with all of its permissions. */
export async function checkRoleWithinCaller(
  callerPerms: readonly string[],
  roleId: string,
): Promise<Refusal | null> {
  if (!(await roleExists(roleId))) return refuse(400, 'Unknown role', 'UNKNOWN_ROLE');
  return coversPermissions(callerPerms, await rolePermissions(roleId))
    ? null
    : refuse(403, 'Cannot assign a role with more permissions than your own', 'ROLE_EXCEEDS_YOURS');
}

/** A caller limited to some servers may only hand out those; null = every server. */
export function checkServersWithinCaller(
  callerIds: readonly string[] | null,
  ids: readonly string[] | null,
): Refusal | null {
  if (callerIds === null) return null;
  if (ids === null) {
    return refuse(403, 'You cannot grant every server', 'SERVERS_NOT_HELD', { serverIds: null });
  }
  const notHeld = ids.filter((id) => !callerIds.includes(id));
  return notHeld.length > 0
    ? refuse(403, 'You cannot grant servers you do not have', 'SERVERS_NOT_HELD', {
        serverIds: notHeld,
      })
    : null;
}

const MAX_SERVER_IDS = 256;
const serverListSchema = z
  .array(z.string().regex(/^[A-Za-z0-9_-]{1,64}$/))
  .max(MAX_SERVER_IDS)
  .nullable();

/** `body[field]`: a list of registered server ids, or null for every server. */
export async function readServerList(
  body: unknown,
  field: string,
): Promise<Checked<string[] | null>> {
  const raw =
    body && typeof body === 'object' ? (body as Record<string, unknown>)[field] : undefined;
  const parsed = serverListSchema.safeParse(raw);
  if (raw === undefined || !parsed.success) {
    return {
      ok: false,
      ...refuse(400, `${field} must be a list of server ids or null`, 'INVALID_SERVER_LIST'),
    };
  }
  if (parsed.data === null) return { ok: true, value: null };
  const ids = [...new Set(parsed.data)];
  const known = new Set((await listServers()).map((s) => s.id));
  const unknown = ids.filter((id) => !known.has(id));
  if (unknown.length > 0) {
    return {
      ok: false,
      ...refuse(400, 'Unknown server', 'UNKNOWN_SERVER', { serverIds: unknown }),
    };
  }
  return { ok: true, value: ids };
}

/** A role's permission list from a request body: catalog permissions or '*'. */
export function readPermissionList(value: unknown): Checked<string[]> {
  if (!Array.isArray(value) || !value.every((p) => typeof p === 'string')) {
    return {
      ok: false,
      ...refuse(400, 'Permissions must be a list of permission names', 'INVALID_PERMISSIONS'),
    };
  }
  const catalog = new Set<string>([...getAllPermissions(), WILDCARD_PERMISSION]);
  const unknown = value.filter((p) => !catalog.has(p));
  if (unknown.length > 0) {
    return {
      ok: false,
      ...refuse(400, 'Unknown permission', 'UNKNOWN_PERMISSION', { permissions: unknown }),
    };
  }
  return { ok: true, value: [...new Set(value as string[])] };
}

/** May the caller give a role these permissions? '*' only an admin. */
export function checkPermissionsWithinCaller(
  callerPerms: readonly string[],
  permissions: readonly string[],
): Refusal | null {
  if (coversPermissions(callerPerms, permissions)) return null;
  const notHeld = callerPerms.includes(WILDCARD_PERMISSION)
    ? []
    : permissions.filter((p) => !callerPerms.includes(p));
  return refuse(403, 'Cannot grant permissions you do not have', 'PERMISSIONS_EXCEED_YOURS', {
    permissions: notHeld,
  });
}
