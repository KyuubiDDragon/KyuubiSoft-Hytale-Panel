/**
 * Server context: the one place that answers, for a server id, which
 * container it is, where the manager sees its files and how to reach its
 * KyuubiSoft API plugin.
 *
 * Every per-server lookup goes through getServerContext() instead of reading
 * config.*Path or the registry by hand:
 *  - `undefined`/`null` resolves to the default server (legacy routes),
 *  - an id that is not registered throws UnknownServerError — it never falls
 *    back to the default server's files,
 *  - the compose server always reflects the live env config (see servers.ts).
 */
import fs from 'fs';
import path from 'path';
import { resolveRealPathWithin } from '../utils/pathSecurity.js';
import {
  INSTANCES_ROOT,
  getServer,
  isComposeServer,
  listServers,
  resolveServerId,
  type ServerInstance,
  type ServerNetwork,
  type ServerPaths,
} from './servers.js';

/** Port of the KyuubiSoft API plugin inside every game container. */
export const PLUGIN_INTERNAL_PORT = 18085;

export type ServerKind = 'compose' | 'managed';

export interface ServerContext {
  readonly id: string;
  readonly kind: ServerKind;
  readonly name: string;
  readonly containerName: string;
  /** Paths as the manager container sees them. */
  readonly paths: Readonly<ServerPaths>;
  readonly network: Readonly<ServerNetwork>;
  /** Plugin endpoint on the stack network (never a published host port). */
  readonly plugin: { readonly host: string; readonly port: number };
}

export class UnknownServerError extends Error {
  readonly code = 'unknown_server';

  constructor(readonly serverId: string) {
    super(`Unknown server id: ${serverId}`);
    this.name = 'UnknownServerError';
  }
}

/** Context of a registry entry the caller already holds (e.g. from listServers()). */
export function contextFromServer(server: ServerInstance): ServerContext {
  return {
    id: server.id,
    kind: isComposeServer(server) ? 'compose' : 'managed',
    name: server.name,
    containerName: server.containerName,
    paths: { ...server.paths },
    network: { ...server.network },
    plugin: { host: server.containerName, port: PLUGIN_INTERNAL_PORT },
  };
}

export async function getServerContext(serverId?: string | null): Promise<ServerContext> {
  const id = await resolveServerId(serverId);
  const server = await getServer(id);
  if (!server) throw new UnknownServerError(id);
  return contextFromServer(server);
}

/**
 * Whether `target` really lies inside one of the server's own folders (the
 * folders bound into its container). The game server can put links into
 * them whose absolute target only means something in its own container: the
 * game image links `server/universe` to `/opt/hytale/data`, which in the
 * manager is the primary server's data, not an additional server's. Every
 * folder below the server's own folders is used only when its real path
 * stays inside them, so the panel never follows such a link to another
 * server's files or to its own data.
 */
export function isInsideServerFolders(ctx: Pick<ServerContext, 'paths'>, target: string): boolean {
  return resolveRealPathWithin(target, Object.values(ctx.paths)) !== null;
}

/**
 * Where a server keeps its worlds, in the order the game uses them. A
 * location that leads out of the server's folders is left out (see
 * isInsideServerFolders): for an additional server `server/universe/worlds`
 * is such a link, its worlds are in `data/worlds`.
 */
export function worldRoots(ctx: Pick<ServerContext, 'paths'>): string[] {
  return [
    path.join(ctx.paths.data, 'worlds'),
    path.join(ctx.paths.server, 'universe', 'worlds'),
    path.join(ctx.paths.server, 'worlds'),
  ].filter((dir) => isInsideServerFolders(ctx, dir));
}

/**
 * The folder with the server's saved players (`universe/players`), or null
 * when no location stays inside its server or data folder. The game keeps its
 * universe in the data folder and links `server/universe` to it.
 */
export function playersDir(folders: Pick<ServerPaths, 'server' | 'data'>): string | null {
  const own = [folders.server, folders.data];
  return (
    [path.join(folders.server, 'universe', 'players'), path.join(folders.data, 'players')].find(
      (dir) => resolveRealPathWithin(dir, own) !== null,
    ) ?? null
  );
}

// ------------------------------------------------------------------
// Are the server's files visible to the manager?
// ------------------------------------------------------------------

export type ServerFilesState =
  { available: true } | { available: false; reason: 'mount_missing' | 'not_found'; detail: string };

function isDirectory(dir: string): boolean {
  try {
    return fs.statSync(dir).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Whether the instances folder is mounted into the manager container. In the
 * Linux container a folder on the container's own filesystem (same device as
 * `/`) is not the host folder, whatever its name, trailing slash or symlink;
 * elsewhere (tests, local runs) an existing folder counts.
 */
export function isInstancesMountPresent(): boolean {
  let st: fs.Stats;
  try {
    st = fs.statSync(INSTANCES_ROOT);
  } catch {
    return false;
  }
  if (!st.isDirectory()) return false;
  if (process.platform !== 'linux') return true;
  try {
    return st.dev !== fs.statSync('/').dev;
  } catch {
    return true;
  }
}

function isUnder(child: string, parent: string): boolean {
  const rel = path.relative(parent, child);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/**
 * The compose server's folders are mounted by the compose file itself. An
 * additional server's folders are only visible once the instances folder is
 * mounted and the instance has been created.
 */
export function checkServerFiles(ctx: ServerContext): ServerFilesState {
  if (ctx.kind === 'compose' || isDirectory(ctx.paths.server)) return { available: true };
  if (isUnder(ctx.paths.server, INSTANCES_ROOT) && !isInstancesMountPresent()) {
    return {
      available: false,
      reason: 'mount_missing',
      detail:
        `The files of server "${ctx.name}" are not visible to the panel: ${INSTANCES_ROOT} is not ` +
        'mounted into the manager container. Add the instances volume to docker-compose.yml and ' +
        're-create the stack.',
    };
  }
  return {
    available: false,
    reason: 'not_found',
    detail: `The server folder of "${ctx.name}" does not exist (${ctx.paths.server}).`,
  };
}

/**
 * Boot check: warn when additional servers are registered but their files
 * can't be reached, instead of letting each route find out on its own.
 */
export async function warnIfServerFilesUnavailable(): Promise<void> {
  const managed = (await listServers()).map(contextFromServer).filter((c) => c.kind === 'managed');
  if (managed.length === 0) return;
  const missing = managed.filter((c) => {
    const state = checkServerFiles(c);
    return !state.available && state.reason === 'mount_missing';
  });
  if (missing.length > 0) {
    console.warn(
      `[servers] WARNING: ${missing.length} additional server(s) (${missing.map((c) => c.id).join(', ')}) ` +
        `have no files in the manager: ${INSTANCES_ROOT} is not mounted. Add ` +
        `"\${HOST_DATA_PATH}/instances:${INSTANCES_ROOT}" to the manager's volumes in docker-compose.yml ` +
        'and re-create the stack. Until then their file-based pages answer 409.',
    );
    return;
  }
  try {
    fs.accessSync(INSTANCES_ROOT, fs.constants.W_OK);
  } catch {
    console.warn(
      `[servers] WARNING: ${INSTANCES_ROOT} is mounted but not writable for the panel ` +
        `(uid ${process.getuid?.() ?? '?'}). Run: sudo chown 9999:9999 <HOST_DATA_PATH>/instances`,
    );
  }
}
