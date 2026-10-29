/**
 * Folders of additional server instances as the manager sees them
 * (INSTANCES_ROOT/<id>, mounted from ${HOST_DATA_PATH}/instances).
 *
 * Deleting a server together with its data never removes files directly: the
 * instance folder is moved to INSTANCES_ROOT/.trash/<id>-<timestamp>. Only an
 * explicit purge of one trash entry deletes it, and nothing purges on its own.
 */
import { promises as fsp } from 'fs';
import path from 'path';
import { INSTANCES_ROOT, isComposeServer, type ServerInstance } from './servers.js';
import { checkServerFiles, contextFromServer, isInstancesMountPresent } from './serverContext.js';
import { INSTANCE_DIRS, instanceHostRoot } from './dockerImageManager.js';

const TRASH_DIR = '.trash';
// <server id>-<ISO time with ':' and '.' replaced by '-'>
const TRASH_ENTRY =
  /^([A-Za-z0-9][A-Za-z0-9_-]{0,63})-(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z)$/;
// The entrypoint waits for exactly these two files before it starts the server.
const SERVER_FILES = ['HytaleServer.jar', 'Assets.zip'];

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));
const errorCode = (err: unknown) => (err as NodeJS.ErrnoException | null)?.code;

function instanceDir(id: string): string {
  return path.join(INSTANCES_ROOT, id);
}

function trashDir(): string {
  return path.join(INSTANCES_ROOT, TRASH_DIR);
}

function isInside(child: string, parent: string): boolean {
  const rel = path.relative(parent, child);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/** Every registry path lies in INSTANCES_ROOT/<id>: the panel's own layout. */
function hasStandardLayout(instance: ServerInstance): boolean {
  const root = path.resolve(instanceDir(instance.id));
  return Object.values(instance.paths).every((p) => isInside(path.resolve(p), root));
}

/** The trash folder must not be a link: moves and purges would land wherever it points. */
async function isRealTrashDir(): Promise<boolean> {
  try {
    const stat = await fsp.lstat(trashDir());
    return stat.isDirectory() && !stat.isSymbolicLink();
  } catch {
    return false;
  }
}

/** Where the trash of this instance lives on the host (for messages). */
function hostTrashPath(instance: ServerInstance, entry: string): string {
  return path.posix.join(path.posix.dirname(instanceHostRoot(instance)), TRASH_DIR, entry);
}

/**
 * Create the instance folders as the panel's own user before Docker creates
 * missing bind sources as root: a root-owned instance folder could not be
 * moved to the trash later. Returns a warning instead of failing; the
 * container works with Docker-created folders too.
 */
export async function prepareInstanceDirs(instance: ServerInstance): Promise<string | null> {
  if (isComposeServer(instance) || !hasStandardLayout(instance)) return null;
  if (!isInstancesMountPresent()) {
    return (
      `${INSTANCES_ROOT} is not mounted into the manager: the panel cannot see the files of ` +
      'the new server, and Docker creates its folders as root.'
    );
  }
  try {
    for (const dir of INSTANCE_DIRS) {
      await fsp.mkdir(path.join(instanceDir(instance.id), dir), { recursive: true });
    }
    return null;
  } catch (err) {
    return `Could not create the folders of the new server (${errorText(err)}); Docker creates them as root.`;
  }
}

export type DataCheck = { ok: true } | { ok: false; code: 'layout' | 'unavailable'; error: string };

/** Null when `dir` is a real folder or does not exist, else what is wrong with it. */
async function notAFolder(
  dir: string,
): Promise<{ code: 'layout' | 'unavailable'; error: string } | null> {
  try {
    const stat = await fsp.lstat(dir);
    if (stat.isDirectory() && !stat.isSymbolicLink()) return null;
    return { code: 'layout', error: `${dir} is not a folder; nothing was changed` };
  } catch (err) {
    if (errorCode(err) === 'ENOENT') return null;
    return { code: 'unavailable', error: `${dir} cannot be checked: ${errorText(err)}` };
  }
}

/**
 * Whether {@link moveInstanceToTrash} can work for this server. Call it before
 * the container is stopped: a link in place of the instance or trash folder
 * would send the move somewhere else.
 */
export async function checkInstanceDataMovable(instance: ServerInstance): Promise<DataCheck> {
  if (isComposeServer(instance) || !hasStandardLayout(instance)) {
    return {
      ok: false,
      code: 'layout',
      error:
        `The files of server "${instance.name}" are not in the panel's instance folder; ` +
        'the panel only moves its own instance folders to the trash.',
    };
  }
  if (!isInstancesMountPresent()) {
    return {
      ok: false,
      code: 'unavailable',
      error:
        `The files of server "${instance.name}" are not visible to the panel (${INSTANCES_ROOT} ` +
        'is not mounted), so they cannot be moved to the trash.',
    };
  }
  for (const dir of [instanceDir(instance.id), trashDir()]) {
    const problem = await notAFolder(dir);
    if (problem) return { ok: false, ...problem };
  }
  return { ok: true };
}

export type TrashResult =
  | { ok: true; entry: string | null; hostPath: string | null }
  | { ok: false; code: 'layout' | 'unavailable' | 'failed'; error: string };

/** Move INSTANCES_ROOT/<id> into the trash. A missing folder moves nothing. */
export async function moveInstanceToTrash(instance: ServerInstance): Promise<TrashResult> {
  const check = await checkInstanceDataMovable(instance);
  if (!check.ok) return check;
  const source = instanceDir(instance.id);
  try {
    const stat = await fsp.lstat(source);
    // Never follow a link out of the instances folder.
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      return {
        ok: false,
        code: 'layout',
        error: `${source} is not a folder; it was left untouched`,
      };
    }
  } catch (err) {
    if (errorCode(err) === 'ENOENT') return { ok: true, entry: null, hostPath: null };
    return { ok: false, code: 'failed', error: errorText(err) };
  }
  const entry = `${instance.id}-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  try {
    await fsp.mkdir(trashDir(), { recursive: true });
    if (!(await isRealTrashDir())) {
      return {
        ok: false,
        code: 'layout',
        error: `${trashDir()} is not a folder; nothing was moved`,
      };
    }
    await fsp.rename(source, path.join(trashDir(), entry));
  } catch (err) {
    const hint =
      errorCode(err) === 'EACCES' || errorCode(err) === 'EPERM'
        ? ` The panel (uid ${process.getuid?.() ?? '?'}) may not move it; ` +
          `run "sudo chown -R 9999:9999 ${instanceHostRoot(instance)}" and delete again.`
        : '';
    return {
      ok: false,
      code: 'failed',
      error: `Could not move ${source} to the trash: ${errorText(err)}.${hint}`,
    };
  }
  return { ok: true, entry, hostPath: hostTrashPath(instance, entry) };
}

export interface TrashEntry {
  name: string;
  serverId: string;
  deletedAt: string;
}

/** Trash entries, newest first. Empty while the instances folder is not mounted. */
export async function listInstanceTrash(): Promise<TrashEntry[]> {
  if (!isInstancesMountPresent() || !(await isRealTrashDir())) return [];
  let names: string[];
  try {
    names = await fsp.readdir(trashDir());
  } catch (err) {
    if (errorCode(err) === 'ENOENT') return [];
    throw err;
  }
  const entries: TrashEntry[] = [];
  for (const name of names) {
    const m = TRASH_ENTRY.exec(name);
    if (!m) continue;
    const [date, time] = m[2].split('T');
    const [h, min, s, ms] = time.replace(/Z$/, '').split('-');
    entries.push({ name, serverId: m[1], deletedAt: `${date}T${h}:${min}:${s}.${ms}Z` });
  }
  return entries.sort((a, b) => b.deletedAt.localeCompare(a.deletedAt));
}

export type PurgeResult =
  | { ok: true }
  | { ok: false; code: 'invalid' | 'not_found' | 'unavailable' | 'failed'; error: string };

/** Permanently delete one trash entry. The only place that removes instance files. */
export async function purgeInstanceTrashEntry(name: string): Promise<PurgeResult> {
  if (!TRASH_ENTRY.test(name)) {
    return { ok: false, code: 'invalid', error: `"${name}" is not a trash entry` };
  }
  if (!isInstancesMountPresent()) {
    return {
      ok: false,
      code: 'unavailable',
      error: `${INSTANCES_ROOT} is not mounted into the manager`,
    };
  }
  const target = path.join(trashDir(), name);
  if (!(await isRealTrashDir())) {
    return { ok: false, code: 'not_found', error: `No trash entry "${name}"` };
  }
  try {
    const stat = await fsp.lstat(target);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      return {
        ok: false,
        code: 'invalid',
        error: `"${name}" is not a folder; it was left untouched`,
      };
    }
  } catch (err) {
    if (errorCode(err) === 'ENOENT') {
      return { ok: false, code: 'not_found', error: `No trash entry "${name}"` };
    }
    return { ok: false, code: 'failed', error: errorText(err) };
  }
  try {
    // rm does not follow symbolic links inside the folder; it removes the links.
    await fsp.rm(target, { recursive: true });
    return { ok: true };
  } catch (err) {
    return { ok: false, code: 'failed', error: `Could not delete "${name}": ${errorText(err)}` };
  }
}

/**
 * The heap the server's own panel settings start it with (`javaMaxRam` in
 * its data folder's panel-config.json, read by start-server.sh), if any.
 */
export async function readPanelJavaMaxRam(server: ServerInstance): Promise<string | undefined> {
  try {
    const cfg = JSON.parse(
      await fsp.readFile(path.join(server.paths.data, 'panel-config.json'), 'utf-8'),
    ) as { javaMaxRam?: unknown };
    return typeof cfg.javaMaxRam === 'string' && cfg.javaMaxRam ? cfg.javaMaxRam : undefined;
  } catch {
    // No file (never set) or not readable: the environment's heap applies.
    return undefined;
  }
}

/**
 * Whether the server has the files its container waits for. 'unknown' when
 * the panel cannot see the server folder (instances folder not mounted).
 */
export async function getServerFilesState(
  server: ServerInstance,
): Promise<'present' | 'missing' | 'unknown'> {
  const ctx = contextFromServer(server);
  const visible = checkServerFiles(ctx);
  if (!visible.available) return visible.reason === 'mount_missing' ? 'unknown' : 'missing';
  for (const file of SERVER_FILES) {
    try {
      await fsp.access(path.join(ctx.paths.server, file));
    } catch {
      return 'missing';
    }
  }
  return 'present';
}
