/**
 * The access files of a Hytale 0.7 server, read the way the server reads them,
 * and edits on them that leave everything else in the file as it was.
 *
 *  permissions.json  { users:  { <uuid>: { permissions?: [node], groups?: [group] } },
 *                      groups: { <name>: { parent?: <group>, permissions?: [node] } } }
 *                    A group may still be a bare array of nodes (older files).
 *                    A user key that is not a UUID, or a value of the wrong
 *                    type, makes the server refuse the whole file when it
 *                    starts. The permissions and the access control that
 *                    depends on them (bans, join permission) are core parts
 *                    of the server, so it then does not start at all.
 *  bans.json         { Version: 1, Bans: [{ Target, By, Timestamp, ExpiresOn?, Reason?, Metadata? }] }
 *                    Older files are a bare array of
 *                    { type, target, by, timestamp (ms), reason, expiresOn (ms) }.
 *                    A file the server cannot read keeps it from starting too.
 *  whitelist.json    From before 0.7: { enabled, list: [uuid] }. On start the
 *                    server grants every listed UUID the join permission,
 *                    turns RequireJoinPermission on when the list was enabled
 *                    (or does not say) and renames the file to
 *                    whitelist.json.migrated. Names in the list are dropped.
 *  config.json       RequireJoinPermission is the whitelist switch; BanStorage
 *                    names the ban file.
 *
 * Pure: no file access, so every rule can be tested without a server.
 */
import path from 'path';
import { isJsonObject } from '../utils/losslessJson.js';

export type JsonObject = Record<string, unknown>;

/** The permission a player needs to join while RequireJoinPermission is on. */
export const JOIN_PERMISSION = 'hytale.server.join';
/** The author the server records for a ban issued from the console. */
export const CONSOLE_UUID = '00000000-0000-0000-0000-000000000000';
export const DEFAULT_GROUP = 'hytale:Adventurer';
export const OPERATOR_GROUP = 'hytale:Admin';
/** The reason the server stores for a ban given without one. */
export const NO_REASON = 'No reason.';
export const BANS_VERSION = 1;
export const DEFAULT_BANS_FILE = 'bans.json';
/**
 * The access files in the server folder, and the name files older panel
 * versions kept next to them (the panel still reads names from those). The
 * ban file config.json names (BanStorage) comes on top of these.
 */
export const ACCESS_FILE_NAMES: readonly string[] = [
  'permissions.json',
  DEFAULT_BANS_FILE,
  'whitelist.json',
  'permissions-names.json',
  'bans-names.json',
];

// Limits of what the panel takes as input; the server itself sets none.
const MAX_GROUP_NAME = 64;
const MAX_PERMISSION_NODE = 128;
/** How far the server follows a group's parents when it checks a permission. */
export const MAX_GROUP_DEPTH = 32;

/** The built-in groups: the server forces their parent and adds these permissions. */
export const BUILTIN_GROUPS: ReadonlyMap<
  string,
  { parent: string | null; permissions: readonly string[] }
> = new Map([
  ['hytale:None', { parent: null, permissions: [] }],
  ['hytale:Adventurer', { parent: 'hytale:None', permissions: [] }],
  ['hytale:Builder', { parent: 'hytale:Adventurer', permissions: [] }],
  ['hytale:WorldEditor', { parent: 'hytale:Builder', permissions: [] }],
  ['hytale:ServerEditor', { parent: 'hytale:WorldEditor', permissions: [] }],
  ['hytale:Admin', { parent: 'hytale:ServerEditor', permissions: ['*'] }],
]);

// Group names of older servers, which the server still maps when it reads.
const LEGACY_GROUP_NAMES: Record<string, string> = {
  op: OPERATOR_GROUP,
  adventure: DEFAULT_GROUP,
  adventurer: DEFAULT_GROUP,
  creative: 'hytale:WorldEditor',
  default: DEFAULT_GROUP,
};

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// One group of a UUID as the server's parser reads it: an optional `+`, then hex digits.
const UUID_GROUP_PATTERN = /^\+?[0-9a-f]+$/i;
const UUID_GROUP_BITS = [32n, 16n, 16n, 16n, 48n];
const UUID_GROUP_DIGITS = [8, 4, 4, 4, 12];
const MAX_UUID_TEXT = 36;
const LONG_LIMIT = 1n << 63n;
// The server's own rules; it skips names and nodes that break them when it reads.
const GROUP_NAME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_:-]*$/;
const PERMISSION_NODE_PATTERN = /^-?\w[\w-]*(\.[\w*][\w*-]*)*$/;
// Keys the old panel editor wrote for players it had no UUID for.
const NAME_KEY_PREFIX = 'name:';

/** A UUID in its canonical form (what the panel sends and compares). */
export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_PATTERN.test(value);
}

/**
 * A UUID as the server reads it from its files, in canonical lower case, or
 * null when the server could not read it. The server is more lenient than the
 * canonical form: five groups of hex digits (each may start with `+`), at most
 * 36 characters, a group longer than usual losing its high digits.
 */
export function canonicalUuid(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > MAX_UUID_TEXT) return null;
  const parts = value.split('-');
  if (parts.length !== 5) return null;
  const out: string[] = [];
  for (const [i, part] of parts.entries()) {
    if (!UUID_GROUP_PATTERN.test(part)) return null;
    const number = BigInt(`0x${part.replace(/^\+/, '')}`);
    if (number >= LONG_LIMIT) return null;
    const masked = number & ((1n << UUID_GROUP_BITS[i]) - 1n);
    out.push(masked.toString(16).padStart(UUID_GROUP_DIGITS[i], '0'));
  }
  return out.join('-');
}

/** A group name the server reads (it sets no length limit). */
export function isValidGroupName(name: unknown): name is string {
  return typeof name === 'string' && GROUP_NAME_PATTERN.test(name);
}

/** A permission the server reads. Note: a bare `*` is not a node the server reads from the file. */
export function isValidPermissionNode(node: unknown): node is string {
  return typeof node === 'string' && PERMISSION_NODE_PATTERN.test(node);
}

/** A group name the panel accepts from an admin: what the server reads, within a sane length. */
export function isGroupNameInput(name: unknown): name is string {
  return isValidGroupName(name) && name.length <= MAX_GROUP_NAME;
}

/** A permission the panel accepts from an admin: what the server reads, within a sane length. */
export function isPermissionNodeInput(node: unknown): node is string {
  return isValidPermissionNode(node) && node.length <= MAX_PERMISSION_NODE;
}

export function resolveGroupName(name: string): string {
  return LEGACY_GROUP_NAMES[name.toLowerCase()] ?? name;
}

/** A JSON object (an exactly kept big integer of utils/losslessJson is not one). */
export function isObject(value: unknown): value is JsonObject {
  return isJsonObject(value);
}

const isPrimitive = (value: unknown): value is string | number | boolean =>
  typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean';

const unique = (values: Iterable<string>): string[] => [...new Set(values)];

/** A part of a file the server cannot use. `fatal`: it refuses the whole file. */
export interface FileProblem {
  fatal: boolean;
  where: string;
  detail: string;
}

// ============================================================
// permissions.json
// ============================================================

export interface PermissionsUser {
  uuid: string;
  permissions: string[];
  /** null: the file names no groups, so the server uses the default group. */
  groups: string[] | null;
}

export interface PermissionsGroup {
  name: string;
  parent: string | null;
  permissions: string[];
  builtin: boolean;
}

export interface PermissionsData {
  users: PermissionsUser[];
  groups: PermissionsGroup[];
  problems: FileProblem[];
}

function readNodeList(
  value: unknown,
  where: string,
  problems: FileProblem[],
  valid: (entry: string) => boolean,
): string[] | null {
  if (value === undefined) return null;
  if (!Array.isArray(value)) {
    problems.push({ fatal: true, where, detail: 'is not a list' });
    return [];
  }
  const out: string[] = [];
  for (const entry of value) {
    if (!isPrimitive(entry)) {
      problems.push({ fatal: true, where, detail: 'holds an entry that is not text' });
      continue;
    }
    const text = String(entry);
    if (valid(text)) out.push(text);
    else problems.push({ fatal: false, where, detail: `skips "${text.slice(0, 80)}"` });
  }
  return unique(out);
}

function readUsers(raw: unknown, problems: FileProblem[]): PermissionsUser[] {
  if (raw === undefined) return [];
  if (!isObject(raw)) {
    problems.push({ fatal: true, where: 'users', detail: 'is not an object' });
    return [];
  }
  const users = new Map<string, PermissionsUser>();
  for (const [key, value] of Object.entries(raw)) {
    const where = `users.${key.slice(0, 80)}`;
    const uuid = canonicalUuid(key);
    if (!uuid) {
      problems.push({ fatal: true, where, detail: 'is not a UUID' });
      continue;
    }
    if (!isObject(value)) {
      problems.push({ fatal: true, where, detail: 'is not an object' });
      continue;
    }
    const permissions = readNodeList(
      value.permissions,
      `${where}.permissions`,
      problems,
      isValidPermissionNode,
    );
    const read = readNodeList(value.groups, `${where}.groups`, problems, (g) =>
      isValidGroupName(resolveGroupName(g)),
    );
    const groups = read === null ? null : unique(read.map(resolveGroupName));
    // Two keys for one UUID (differing in case or form): the server merges them.
    const earlier = users.get(uuid);
    users.set(uuid, {
      uuid,
      permissions: unique([...(earlier?.permissions ?? []), ...(permissions ?? [])]),
      groups:
        earlier?.groups || groups ? unique([...(earlier?.groups ?? []), ...(groups ?? [])]) : null,
    });
  }
  return [...users.values()];
}

function readGroups(raw: unknown, problems: FileProblem[]): Map<string, PermissionsGroup> {
  const groups = new Map<string, PermissionsGroup>();
  if (raw !== undefined && !isObject(raw)) {
    problems.push({ fatal: true, where: 'groups', detail: 'is not an object' });
  } else if (raw) {
    for (const [key, value] of Object.entries(raw)) {
      const where = `groups.${key.slice(0, 80)}`;
      const name = resolveGroupName(key);
      if (!isValidGroupName(name)) {
        problems.push({ fatal: false, where, detail: 'is not a valid group name' });
        continue;
      }
      if (Array.isArray(value)) {
        const permissions = readNodeList(value, where, problems, isValidPermissionNode) ?? [];
        groups.set(name, { name, parent: null, permissions, builtin: false });
        continue;
      }
      if (!isObject(value)) {
        problems.push({ fatal: false, where, detail: 'is neither a list nor an object' });
        continue;
      }
      let parent: string | null = null;
      if (value.parent !== undefined) {
        if (!isPrimitive(value.parent)) {
          problems.push({ fatal: true, where: `${where}.parent`, detail: 'is not text' });
        } else if (isValidGroupName(resolveGroupName(String(value.parent)))) {
          parent = resolveGroupName(String(value.parent));
        } else {
          problems.push({ fatal: false, where: `${where}.parent`, detail: 'is not a group name' });
        }
      }
      const permissions =
        readNodeList(value.permissions, `${where}.permissions`, problems, isValidPermissionNode) ??
        [];
      groups.set(name, { name, parent, permissions, builtin: false });
    }
  }
  // The server forces the parent of a built-in group and merges its own permissions in.
  for (const [name, builtin] of BUILTIN_GROUPS) {
    const loaded = groups.get(name);
    groups.set(name, {
      name,
      parent: builtin.parent,
      permissions: unique([...builtin.permissions, ...(loaded?.permissions ?? [])]),
      builtin: true,
    });
  }
  return groups;
}

/** Reads permissions.json as the server would; `raw` null means no file. */
export function readPermissions(raw: unknown): PermissionsData {
  const problems: FileProblem[] = [];
  if (raw !== null && raw !== undefined && !isObject(raw)) {
    problems.push({ fatal: true, where: 'permissions.json', detail: 'is not a JSON object' });
    raw = {};
  }
  const root = (raw ?? {}) as JsonObject;
  const users = readUsers(root.users, problems);
  const groups = [...readGroups(root.groups, problems).values()].sort((a, b) =>
    a.name.localeCompare(b.name),
  );
  return { users, groups, problems };
}

/**
 * Effective permissions of a group: its own and its parents', where the most
 * specific group decides a node (`-node` in a child removes `node` of a parent).
 */
export function effectiveGroupPermissions(groups: PermissionsGroup[], name: string): string[] {
  const byName = new Map(groups.map((g) => [g.name, g]));
  const decided = new Set<string>();
  const effective: string[] = [];
  const visited = new Set<string>();
  let current: string | null = name;
  while (current && !visited.has(current)) {
    visited.add(current);
    const group = byName.get(current);
    if (!group) break;
    for (const node of group.permissions) {
      const base = node.startsWith('-') ? node.slice(1) : node;
      if (decided.has(base)) continue;
      decided.add(base);
      effective.push(node);
    }
    current = group.parent;
  }
  return effective.sort();
}

/**
 * What one set of nodes says about `node`, checked as the server does (a
 * deny wins): `-*`, `-node`, `node`, then the deny wildcards (`-a.b.*`, most
 * specific first), `*`, then the grant wildcards (`a.*`, `a.b.*`, ...).
 * undefined: the set does not decide.
 */
export function nodesDecide(
  nodes: Iterable<string> | undefined,
  node: string,
): boolean | undefined {
  const set = new Set(nodes ?? []);
  if (set.size === 0) return undefined;
  if (set.has('-*')) return false;
  if (set.has(`-${node}`)) return false;
  if (set.has(node)) return true;
  const parts = node.split('.');
  const wildcards = parts.map((_, i) => `${parts.slice(0, i + 1).join('.')}.*`);
  if (wildcards.some((w) => set.has(`-${w}`))) return false;
  if (set.has('*')) return true;
  if (wildcards.some((w) => set.has(w))) return true;
  return undefined;
}

export interface GroupNodes {
  name: string;
  parent?: string | null;
  permissions: readonly string[];
}

/**
 * What a group says about `node` for its members, as the server checks it:
 * the group's own nodes, its virtual nodes, then each parent in turn (at most
 * 32); the first that decides wins. undefined: nothing in the chain decides.
 */
export function groupDecides(
  groups: readonly GroupNodes[],
  name: string,
  node: string,
  virtualGroups: Readonly<Record<string, readonly string[]>> = {},
): boolean | undefined {
  const byName = new Map(groups.map((g) => [g.name, g]));
  const layer = (group: string) =>
    nodesDecide(byName.get(group)?.permissions, node) ?? nodesDecide(virtualGroups[group], node);
  const own = layer(name);
  if (own !== undefined) return own;
  let current = byName.get(name)?.parent ?? null;
  for (let depth = 0; current && depth < MAX_GROUP_DEPTH; depth++) {
    const decided = layer(current);
    if (decided !== undefined) return decided;
    current = byName.get(current)?.parent ?? null;
  }
  return undefined;
}

export interface PermissionsRepair {
  data: JsonObject;
  /** One line per change, for the report. */
  changes: string[];
  /** Entries taken out because nobody can be named for them. */
  removed: { key: string; value: unknown }[];
}

function sanitizeNodeArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.filter(isPrimitive).map(String);
}

function mergeUserEntries(into: JsonObject, from: JsonObject): JsonObject {
  const merged: JsonObject = { ...into };
  for (const key of ['permissions', 'groups'] as const) {
    const a = sanitizeNodeArray(into[key]) ?? [];
    const b = sanitizeNodeArray(from[key]) ?? [];
    if (into[key] !== undefined || from[key] !== undefined) merged[key] = unique([...a, ...b]);
  }
  return merged;
}

function repairUserEntry(value: JsonObject, where: string, changes: string[]): JsonObject {
  const entry: JsonObject = { ...value };
  for (const key of ['permissions', 'groups'] as const) {
    if (entry[key] === undefined) continue;
    const nodes = sanitizeNodeArray(entry[key]);
    if (nodes === undefined) {
      delete entry[key];
      changes.push(`${where}.${key}: removed, it was not a list`);
    } else if (nodes.length !== (entry[key] as unknown[]).length) {
      entry[key] = nodes;
      changes.push(`${where}.${key}: removed entries that were not text`);
    }
  }
  return entry;
}

function repairGroupEntry(value: unknown, where: string, changes: string[]): unknown {
  if (Array.isArray(value)) {
    const nodes = sanitizeNodeArray(value) ?? [];
    if (nodes.length !== value.length) changes.push(`${where}: removed entries that were not text`);
    return nodes;
  }
  if (!isObject(value)) return value;
  const entry: JsonObject = { ...value };
  if (entry.parent !== undefined && !isPrimitive(entry.parent)) {
    delete entry.parent;
    changes.push(`${where}.parent: removed, it was not text`);
  }
  if (entry.permissions !== undefined) {
    const nodes = sanitizeNodeArray(entry.permissions);
    if (nodes === undefined) {
      delete entry.permissions;
      changes.push(`${where}.permissions: removed, it was not a list`);
    } else if (nodes.length !== (entry.permissions as unknown[]).length) {
      entry.permissions = nodes;
      changes.push(`${where}.permissions: removed entries that were not text`);
    }
  }
  return entry;
}

/**
 * Fixes what makes the server refuse permissions.json: user keys that are not
 * UUIDs (a `name:<player>` key moves to the player's UUID when `uuidForName`
 * knows it), and values of the wrong type. Everything the server can read
 * stays as it is. Null when there is nothing to fix, or when the root is no
 * object (that file is left for a person to look at).
 */
export function repairPermissions(
  raw: unknown,
  uuidForName: (name: string) => string | undefined,
): PermissionsRepair | null {
  if (!isObject(raw)) return null;
  const changes: string[] = [];
  const removed: { key: string; value: unknown }[] = [];
  const data: JsonObject = { ...raw };

  if (data.users !== undefined && !isObject(data.users)) {
    removed.push({ key: 'users', value: data.users });
    delete data.users;
    changes.push('users: removed, it was not an object');
  } else if (isObject(data.users)) {
    const users: JsonObject = {};
    const moved: [string, JsonObject][] = [];
    for (const [key, value] of Object.entries(data.users)) {
      const where = `users.${key.slice(0, 80)}`;
      if (canonicalUuid(key)) {
        if (isObject(value)) users[key] = repairUserEntry(value, where, changes);
        else {
          removed.push({ key, value });
          changes.push(`${where}: removed, it was not an object`);
        }
        continue;
      }
      const name = key.startsWith(NAME_KEY_PREFIX) ? key.slice(NAME_KEY_PREFIX.length) : null;
      const uuid = name ? canonicalUuid(uuidForName(name)) : null;
      if (uuid && isObject(value)) {
        moved.push([uuid, repairUserEntry(value, where, changes)]);
        changes.push(`${where}: moved to ${uuid} (${name})`);
      } else {
        removed.push({ key, value });
        changes.push(
          name
            ? `${where}: removed, no UUID is known for ${name}`
            : `${where}: removed, it is not a UUID`,
        );
      }
    }
    for (const [uuid, entry] of moved) {
      const existingKey = Object.keys(users).find((k) => canonicalUuid(k) === uuid);
      if (existingKey)
        users[existingKey] = mergeUserEntries(users[existingKey] as JsonObject, entry);
      else users[uuid] = entry;
    }
    data.users = users;
  }

  if (data.groups !== undefined && !isObject(data.groups)) {
    removed.push({ key: 'groups', value: data.groups });
    delete data.groups;
    changes.push('groups: removed, it was not an object');
  } else if (isObject(data.groups)) {
    const groups: JsonObject = {};
    for (const [key, value] of Object.entries(data.groups)) {
      groups[key] = repairGroupEntry(value, `groups.${key.slice(0, 80)}`, changes);
    }
    data.groups = groups;
  }

  return changes.length > 0 ? { data, changes, removed } : null;
}

function findKey(object: JsonObject, matches: (key: string) => boolean): string | undefined {
  return Object.keys(object).find(matches);
}

export interface UserAccessEdit {
  /** null or []: no groups in the file, the server falls back to the default group. */
  groups?: string[] | null;
  addPermissions?: string[];
  removePermissions?: string[];
}

/** permissions.json with one user's groups and/or own permissions changed. */
export function withUserAccess(raw: unknown, uuid: string, edit: UserAccessEdit): JsonObject {
  // Copies along the changed path only: the rest is shared, never mutated.
  const data: JsonObject = isObject(raw) ? { ...raw } : {};
  const users: JsonObject = isObject(data.users) ? { ...data.users } : {};
  const target = canonicalUuid(uuid) ?? uuid.toLowerCase();
  const key = findKey(users, (k) => canonicalUuid(k) === target) ?? target;
  const entry: JsonObject = isObject(users[key]) ? { ...(users[key] as JsonObject) } : {};

  if (edit.groups !== undefined) {
    const groups = unique((edit.groups ?? []).map(resolveGroupName));
    if (groups.length > 0) entry.groups = groups;
    else delete entry.groups;
  }
  if (edit.addPermissions || edit.removePermissions) {
    const remove = new Set(edit.removePermissions ?? []);
    const nodes = unique([
      ...(sanitizeNodeArray(entry.permissions) ?? []),
      ...(edit.addPermissions ?? []),
    ]).filter((n) => !remove.has(n));
    if (nodes.length > 0) entry.permissions = nodes;
    else delete entry.permissions;
  }

  if (Object.keys(entry).length > 0) users[key] = entry;
  else delete users[key];
  if (Object.keys(users).length > 0) data.users = users;
  else delete data.users;
  return data;
}

/**
 * permissions.json with a group set to `permissions` (and `parent`, unless it
 * is undefined: then the stored parent stays). A built-in group keeps the
 * parent the server forces and does not store the permissions the server
 * adds itself. An older alias key of the group (`op`, `default`, ...) is
 * replaced by the group's name.
 */
export function withGroup(
  raw: unknown,
  name: string,
  edit: { permissions: string[]; parent?: string | null },
): JsonObject {
  const data: JsonObject = isObject(raw) ? { ...raw } : {};
  const groups: JsonObject = isObject(data.groups) ? { ...data.groups } : {};
  const keys = Object.keys(groups).filter((k) => resolveGroupName(k) === name);
  const previous = keys.map((k) => groups[k]).find(isObject) ?? {};
  for (const k of keys) delete groups[k];

  const builtin = BUILTIN_GROUPS.get(name);
  const entry: JsonObject = { ...previous };
  const parent = builtin ? builtin.parent : edit.parent;
  if (parent === null) delete entry.parent;
  else if (parent !== undefined) entry.parent = parent;
  const own = new Set(builtin?.permissions ?? []);
  entry.permissions = unique(edit.permissions).filter((n) => !own.has(n));
  groups[name] = entry;
  data.groups = groups;
  return data;
}

/** permissions.json without a group (users keep naming it; it then grants nothing). */
export function withoutGroup(raw: unknown, name: string): JsonObject {
  const data: JsonObject = isObject(raw) ? { ...raw } : {};
  if (!isObject(data.groups)) return data;
  const groups: JsonObject = { ...data.groups };
  for (const k of Object.keys(groups)) if (resolveGroupName(k) === name) delete groups[k];
  if (Object.keys(groups).length > 0) data.groups = groups;
  else delete data.groups;
  return data;
}

// ============================================================
// bans.json
// ============================================================

export interface BanRecord {
  target?: string;
  by?: string;
  timestamp?: string;
  expiresOn?: string;
  reason?: string;
  inEffect: boolean;
  /** false: the server could not read the entry; it still denies `target`. */
  readable: boolean;
}

export interface BansData {
  format: 'current' | 'legacy' | 'none';
  bans: BanRecord[];
  problems: FileProblem[];
}

const legacyInstant = (value: unknown): string | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? new Date(value).toISOString() : undefined;

// An instant as the server parses it: date and time with a zone (`Z` or an offset).
const INSTANT_PATTERN =
  /^[+-]?\d{4,}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}:\d{2}(:\d{2})?)$/i;

const isoInstant = (value: unknown): string | undefined =>
  typeof value === 'string' && INSTANT_PATTERN.test(value) && !Number.isNaN(Date.parse(value))
    ? value
    : undefined;

const lowerUuid = (value: unknown): string | undefined => canonicalUuid(value) ?? undefined;

/** An entry in the form the server writes now, or null if it cannot be read. */
function toCurrentEntry(entry: JsonObject): JsonObject | null {
  if ('type' in entry) {
    const target = lowerUuid(entry.target);
    const by = lowerUuid(entry.by);
    const timestamp = legacyInstant(entry.timestamp);
    if (!target || !by || !timestamp) return null;
    const current: JsonObject = { Target: target, By: by, Timestamp: timestamp };
    if (entry.reason !== undefined) {
      if (typeof entry.reason !== 'string') return null;
      current.Reason = entry.reason;
    }
    const expires = legacyInstant(entry.expiresOn);
    if (entry.expiresOn !== undefined) {
      if (!expires) return null;
      current.ExpiresOn = expires;
    }
    return current;
  }
  if (!lowerUuid(entry.Target) || !lowerUuid(entry.By) || !isoInstant(entry.Timestamp)) return null;
  if (entry.ExpiresOn !== undefined && !isoInstant(entry.ExpiresOn)) return null;
  if (entry.Reason !== undefined && typeof entry.Reason !== 'string') return null;
  if (entry.Metadata !== undefined && !isObject(entry.Metadata)) return null;
  return entry;
}

function entryTarget(entry: unknown): string | undefined {
  if (!isObject(entry)) return undefined;
  return lowerUuid('Target' in entry ? entry.Target : entry.target);
}

function describeBan(entry: unknown, now: number): BanRecord {
  const current = isObject(entry) ? toCurrentEntry(entry) : null;
  if (!current) return { target: entryTarget(entry), inEffect: true, readable: false };
  const expiresOn = current.ExpiresOn as string | undefined;
  return {
    target: lowerUuid(current.Target),
    by: lowerUuid(current.By),
    timestamp: current.Timestamp as string,
    expiresOn,
    reason: current.Reason as string | undefined,
    inEffect: !expiresOn || Date.parse(expiresOn) > now,
    readable: true,
  };
}

function banEntries(raw: unknown, problems: FileProblem[]): unknown[] | null {
  if (raw === null || raw === undefined) return [];
  if (Array.isArray(raw)) return raw;
  if (!isObject(raw)) {
    problems.push({ fatal: true, where: 'bans', detail: 'is not a ban list' });
    return null;
  }
  const version = raw.Version;
  if (version !== undefined) {
    if (typeof version !== 'number' || !Number.isInteger(version)) {
      problems.push({ fatal: true, where: 'Version', detail: 'is not a whole number' });
      return null;
    }
    if (version > BANS_VERSION) {
      problems.push({
        fatal: true,
        where: 'Version',
        detail: `${version} is newer than this panel reads`,
      });
      return null;
    }
  }
  if (!Array.isArray(raw.Bans)) {
    problems.push({ fatal: true, where: 'Bans', detail: 'is missing or not a list' });
    return null;
  }
  return raw.Bans;
}

/** Reads bans.json in either form; `raw` null means no file (no bans). */
export function readBans(raw: unknown, now = Date.now()): BansData {
  const problems: FileProblem[] = [];
  const entries = banEntries(raw, problems);
  const format =
    raw === null || raw === undefined ? 'none' : Array.isArray(raw) ? 'legacy' : 'current';
  const bans = (entries ?? []).map((entry) => describeBan(entry, now));
  for (const ban of bans) {
    if (!ban.readable) {
      problems.push({
        fatal: false,
        where: `Bans.${ban.target ?? '?'}`,
        detail: 'cannot be read; the server keeps it as it is',
      });
    }
  }
  return { format, bans, problems };
}

/** The ban list in the current form; entries that cannot be converted stay as they are. */
function currentBanList(raw: unknown): { root: JsonObject; list: unknown[] } {
  const problems: FileProblem[] = [];
  const entries = banEntries(raw, problems);
  if (!entries)
    throw new Error(`bans.json cannot be changed: ${problems[0]?.where} ${problems[0]?.detail}`);
  const root: JsonObject = isObject(raw) ? { ...raw } : {};
  const list = entries.map((entry) => (isObject(entry) ? (toCurrentEntry(entry) ?? entry) : entry));
  return { root, list };
}

function withBanList(root: JsonObject, list: unknown[]): JsonObject {
  return { ...root, Version: BANS_VERSION, Bans: list };
}

export interface NewBan {
  target: string;
  by?: string;
  reason?: string;
  expiresOn?: string;
}

/**
 * bans.json with a ban added, as the server adds one: refused while a ban on
 * the target is in effect; replaces an expired or unreadable one.
 */
export function withBan(
  raw: unknown,
  ban: NewBan,
  now = Date.now(),
): { data: JsonObject; added: boolean } {
  const { root, list } = currentBanList(raw);
  const target = lowerUuid(ban.target) ?? ban.target.toLowerCase();
  const active = list.some((entry) => {
    const described = describeBan(entry, now);
    return described.readable && described.target === target && described.inEffect;
  });
  if (active) return { data: withBanList(root, list), added: false };
  const entry: JsonObject = {
    Target: target,
    By: lowerUuid(ban.by) ?? CONSOLE_UUID,
    Timestamp: new Date(now).toISOString(),
    Reason: ban.reason?.trim() || NO_REASON,
  };
  if (ban.expiresOn) entry.ExpiresOn = ban.expiresOn;
  const kept = list.filter((e) => entryTarget(e) !== target);
  return { data: withBanList(root, [...kept, entry]), added: true };
}

/** bans.json without any entry (readable or not) for the target. */
export function withoutBan(raw: unknown, target: string): { data: JsonObject; removed: boolean } {
  const { root, list } = currentBanList(raw);
  const uuid = lowerUuid(target) ?? target.toLowerCase();
  const kept = list.filter((e) => entryTarget(e) !== uuid);
  return { data: withBanList(root, kept), removed: kept.length !== list.length };
}

// ============================================================
// whitelist.json (before 0.7) and config.json
// ============================================================

export interface LegacyWhitelist {
  /** As the server reads it: a file that does not say counts as enabled. */
  enabled: boolean;
  entries: { value: string; uuid: string | null }[];
}

/** Null when the server could not read the file either (it then refuses to start). */
export function readLegacyWhitelist(raw: unknown): LegacyWhitelist | null {
  if (!isObject(raw)) return null;
  if (raw.list !== undefined && !Array.isArray(raw.list)) return null;
  const enabled = typeof raw.enabled === 'boolean' ? raw.enabled : true;
  const list = (raw.list as unknown[] | undefined) ?? [];
  const entries = list
    .filter((e): e is string => typeof e === 'string')
    .map((value) => ({ value, uuid: lowerUuid(value) ?? null }));
  return { enabled, entries };
}

/**
 * whitelist.json with player names replaced by their UUIDs, so the server's
 * own migration keeps those players. Names nobody knows stay (the server
 * drops them). Null when nothing could be replaced.
 */
export function normalizeLegacyWhitelist(
  raw: unknown,
  uuidForName: (name: string) => string | undefined,
): { data: JsonObject; resolved: { name: string; uuid: string }[]; unresolved: string[] } | null {
  const legacy = readLegacyWhitelist(raw);
  if (!legacy || !isObject(raw)) return null;
  const resolved: { name: string; uuid: string }[] = [];
  const unresolved: string[] = [];
  const list = legacy.entries.map(({ value, uuid }) => {
    if (uuid) return uuid;
    const found = uuidForName(value);
    if (!found) {
      unresolved.push(value);
      return value;
    }
    resolved.push({ name: value, uuid: found.toLowerCase() });
    return found.toLowerCase();
  });
  if (resolved.length === 0) return null;
  return { data: { ...raw, list: unique(list) }, resolved, unresolved };
}

/** RequireJoinPermission of config.json; the server's default is off. */
export function readRequireJoinPermission(raw: unknown): boolean {
  return isObject(raw) && raw.RequireJoinPermission === true;
}

export function withRequireJoinPermission(raw: unknown, enabled: boolean): JsonObject {
  return { ...(isObject(raw) ? raw : {}), RequireJoinPermission: enabled };
}

/** Where config.json keeps the bans: a file name relative to the server folder, or why not. */
export function banStorageFile(raw: unknown): { file: string } | { unsupported: string } {
  const storage = isObject(raw) ? raw.BanStorage : undefined;
  if (storage === undefined) return { file: DEFAULT_BANS_FILE };
  if (!isObject(storage)) return { unsupported: 'BanStorage in config.json is not an object' };
  if (storage.Type !== undefined && storage.Type !== 'Disk') {
    return { unsupported: `the ban list is kept by "${String(storage.Type)}", not in a file` };
  }
  if (storage.Path === undefined) return { file: DEFAULT_BANS_FILE };
  if (typeof storage.Path !== 'string' || !storage.Path.trim()) {
    return { unsupported: 'BanStorage.Path in config.json is empty or not text' };
  }
  // The server resolves an absolute path in its own file system, which the panel does not share.
  if (path.posix.isAbsolute(storage.Path) || path.win32.isAbsolute(storage.Path)) {
    return { unsupported: 'BanStorage.Path in config.json is an absolute path' };
  }
  return { file: storage.Path };
}
