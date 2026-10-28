/**
 * File access for the server's access files (permissions.json, bans.json,
 * config.json, the old whitelist.json), through utils/serverFiles: nothing in
 * the server folder is followed when it is a link, every write replaces the
 * file atomically and keeps the old content as `<name>.bak` like the server
 * does, big integers survive a read-modify-write, and changes inside the
 * panel are serialised per file.
 *
 * Writing these files is only right while the server is stopped (it keeps
 * them in memory and writes its own state back); callers decide that.
 */
import { lstat, rename } from 'fs/promises';
import path from 'path';
import { copyRegularFile, UnsafeFileError } from '../utils/noFollowFs.js';
import {
  readServerJson as readServerFileJson,
  updateServerJson as updateServerFileJson,
} from '../utils/serverFiles.js';
import { resolveInstallPaths } from './serverInstall.js';
import { banStorageFile, type JsonObject } from './accessFormats.js';

export const PERMISSIONS_FILE = 'permissions.json';
export const CONFIG_FILE = 'config.json';
export const LEGACY_WHITELIST_FILE = 'whitelist.json';
/** The name the server gives whitelist.json once it has migrated it. */
export const MIGRATED_SUFFIX = '.migrated';
/** The copy the server keeps next to a file it saves. */
export const SERVER_BACKUP_SUFFIX = '.bak';

export interface AccessFiles {
  serverPath: string;
  permissions: string;
  config: string;
  legacyWhitelist: string;
  /** null when config.json keeps the bans somewhere else (see bansUnsupported). */
  bans: string | null;
  bansUnsupported?: string;
}

/** The access files of a server; the ban file is the one config.json names. */
export async function accessFiles(serverId?: string): Promise<AccessFiles> {
  const { serverPath } = await resolveInstallPaths(serverId);
  const config = path.join(serverPath, CONFIG_FILE);
  const files: AccessFiles = {
    serverPath,
    permissions: path.join(serverPath, PERMISSIONS_FILE),
    config,
    legacyWhitelist: path.join(serverPath, LEGACY_WHITELIST_FILE),
    bans: null,
  };
  let configRaw: unknown = null;
  try {
    configRaw = await readServerJson(config, serverPath);
  } catch {
    // A broken config.json is reported where it is used; the ban file then has its default name.
  }
  const storage = banStorageFile(configRaw);
  if ('unsupported' in storage) {
    files.bansUnsupported = storage.unsupported;
    return files;
  }
  const bans = path.resolve(serverPath, storage.file);
  const relative = path.relative(path.resolve(serverPath), bans);
  const outside =
    !relative ||
    relative === '..' ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative);
  // The ban list must not be written over another of the server's access files.
  const otherFile = [config, files.permissions, files.legacyWhitelist].some(
    (f) => path.resolve(f).toLowerCase() === bans.toLowerCase(),
  );
  if (outside) {
    files.bansUnsupported = 'the ban file named in config.json lies outside the server folder';
  } else if (otherFile || path.extname(bans).toLowerCase() !== '.json') {
    files.bansUnsupported = 'the ban file named in config.json is not a separate .json file';
  } else {
    files.bans = bans;
  }
  return files;
}

/** Parsed content; null only when the file does not exist. Throws on a broken file or a link. */
export function readServerJson(file: string, serverPath: string): Promise<unknown> {
  return readServerFileJson(file, [serverPath]);
}

/**
 * Serialised read-modify-write of a server file. `mutate` returns the new
 * content, or undefined to leave the file as it is. Resolves to the content
 * afterwards.
 */
export function updateServerJson(
  file: string,
  serverPath: string,
  mutate: (current: unknown) => JsonObject | undefined | Promise<JsonObject | undefined>,
): Promise<unknown> {
  return updateServerFileJson(file, [serverPath], mutate);
}

const stamp = () => new Date().toISOString().replace(/[:.]/g, '-');

/**
 * Keeps a copy of a server file before the panel changes it for the first
 * time (`<file>.<tag>-<time>`). Null when the file does not exist.
 */
export async function backupServerFile(
  file: string,
  serverPath: string,
  tag: string,
): Promise<string | null> {
  const dest = `${file}.${tag}-${stamp()}`;
  try {
    await copyRegularFile(file, dest, { srcRoots: [serverPath], destRoots: [serverPath] });
    return dest;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

/** Whether a regular file exists; a link or a folder under that name is refused. */
export async function regularFileExists(file: string): Promise<boolean> {
  try {
    const st = await lstat(file);
    if (st.isSymbolicLink()) throw new UnsafeFileError(file, 'it is a symbolic link');
    if (!st.isFile()) throw new UnsafeFileError(file, 'it is not a regular file');
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw err;
  }
}

/**
 * Renames the old whitelist.json and the copy the server keeps of it to
 * `*.migrated`, as the server does once it has read them, so neither is read
 * again. Returns the files that were renamed.
 */
export async function retireLegacyWhitelist(files: AccessFiles): Promise<string[]> {
  const renamed: string[] = [];
  for (const file of [files.legacyWhitelist, files.legacyWhitelist + SERVER_BACKUP_SUFFIX]) {
    if (!(await regularFileExists(file))) continue;
    // rename() replaces an older *.migrated (or a link under that name) instead of writing through it.
    await rename(file, file + MIGRATED_SUFFIX);
    renamed.push(path.basename(file));
  }
  return renamed;
}
