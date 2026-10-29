/**
 * The access files are the access pages' business: those check the players.*
 * rights and keep the files readable for the server. The config page's file
 * editor can open them too, so reading one there needs the page's right,
 * writing one the rights to change it, and its content must be a file the
 * server reads (a broken permissions.json or ban file keeps the server from
 * starting). The same holds for the two access settings of config.json: the
 * whitelist switch and where the bans are kept. (The file manager leaves
 * these files alone, see fileManager.)
 */
import path from 'path';
import type { Permission } from '../types/permissions.js';
import { accessFiles, readServerJson } from './accessFiles.js';
import {
  banStorageFile,
  isObject,
  readBans,
  readLegacyWhitelist,
  readPermissions,
  type FileProblem,
} from './accessFormats.js';

const PERMISSION_RIGHTS: Permission[] = ['players.permissions', 'players.op'];
const BAN_RIGHTS: Permission[] = ['players.ban', 'players.unban'];
const WHITELIST_RIGHTS: Permission[] = ['players.whitelist'];

export interface AccessFileRule {
  /** To read it: the right of the access page that shows it. */
  readRights: Permission[];
  /** To write it: the rights of every change it can make. */
  rights: Permission[];
  /** What keeps the server from reading the new content; empty when it can. */
  problems: (parsed: unknown) => string[];
}

const fatal = (problems: FileProblem[]) =>
  problems.filter((p) => p.fatal).map((p) => `${p.where} ${p.detail}`);

const PERMISSIONS_RULE: AccessFileRule = {
  readRights: ['players.permissions'],
  rights: PERMISSION_RIGHTS,
  problems: (parsed) => fatal(readPermissions(parsed).problems),
};
const BANS_RULE: AccessFileRule = {
  readRights: ['players.ban'],
  rights: BAN_RIGHTS,
  problems: (parsed) => fatal(readBans(parsed).problems),
};

const RULES: Record<string, AccessFileRule> = {
  'permissions.json': PERMISSIONS_RULE,
  'bans.json': BANS_RULE,
  'whitelist.json': {
    readRights: WHITELIST_RIGHTS,
    rights: WHITELIST_RIGHTS,
    problems: (parsed) =>
      readLegacyWhitelist(parsed) ? [] : ['whitelist.json is not a list the server can read'],
  },
  // Names the panel still resolves players by: a wrong one would point a change at someone else.
  'permissions-names.json': { ...PERMISSIONS_RULE, problems: () => [] },
  'bans-names.json': { ...BANS_RULE, problems: () => [] },
};

/**
 * The rule for a file of the server folder (a bare file name), or null when
 * it is not an access file. The ban file config.json names counts as well,
 * whatever its name ends in (the panel itself only manages a .json one).
 */
export async function accessFileRule(
  serverId: string | undefined,
  filename: string,
): Promise<AccessFileRule | null> {
  const name = filename.toLowerCase();
  const fixed = RULES[name];
  if (fixed) return fixed;
  const files = await accessFiles(serverId);
  const storage = banStorageFile(
    await readServerJson(files.config, files.serverPath).catch(() => null),
  );
  if (!('file' in storage)) return null;
  const banFile = path.resolve(files.serverPath, storage.file);
  const inServerFolder = path.dirname(banFile) === path.resolve(files.serverPath);
  return inServerFolder && path.basename(banFile).toLowerCase() === name ? BANS_RULE : null;
}

const field = (raw: unknown, key: string) => (isObject(raw) ? raw[key] : undefined);
const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/** The rights a change of config.json needs beyond config.edit: those of the access settings it changes. */
export function configAccessRights(current: unknown, next: unknown): Permission[] {
  const rights: Permission[] = [];
  if (!same(field(current, 'RequireJoinPermission'), field(next, 'RequireJoinPermission'))) {
    rights.push(...WHITELIST_RIGHTS);
  }
  if (!same(field(current, 'BanStorage'), field(next, 'BanStorage'))) rights.push(...BAN_RIGHTS);
  return rights;
}
