/**
 * Where the panel keeps state that belongs to one server.
 *
 *  - Panel-side records (chat log, death positions, replay segments) live in
 *    the manager's data volume. The compose server keeps the folders single
 *    server installs always used, so nothing has to move on upgrade; every
 *    other server gets its own folder under `servers/<id>/`.
 *  - Files next to the game (players.json, the universe, the update history)
 *    live in the server's own folders (services/serverContext.ts).
 */
import path from 'path';
import { COMPOSE_SERVER_ID, getServer } from './servers.js';
import { getServerContext } from './serverContext.js';

export { COMPOSE_SERVER_ID };

const DATA_DIR = process.env.MANAGER_DATA_PATH || '/app/data';

// Registry ids are generated (8 hex) or 'default'; anything else never names a folder.
const SERVER_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

export function isValidServerId(serverId: unknown): serverId is string {
  return typeof serverId === 'string' && SERVER_ID_PATTERN.test(serverId);
}

/** The manager-side folder for one server's panel records. */
export function managerDataDir(serverId: string): string {
  if (serverId === COMPOSE_SERVER_ID) return DATA_DIR;
  if (!isValidServerId(serverId)) throw new Error(`Invalid server id: ${serverId}`);
  return path.join(DATA_DIR, 'servers', serverId);
}

export interface ServerFolders {
  /** Resolved registry id. */
  id: string;
  name: string;
  /** Server folder (HytaleServer.jar, universe/, players.json). */
  server: string;
  /** Data folder (panel-config.json, update history). */
  data: string;
}

/**
 * The game-side folders of a server as the manager sees them; `undefined`
 * means the default server. Throws for an id the registry does not know.
 */
export async function serverFolders(serverId?: string): Promise<ServerFolders> {
  const ctx = await getServerContext(serverId);
  return { id: ctx.id, name: ctx.name, server: ctx.paths.server, data: ctx.paths.data };
}

/** Display name of a server for messages and webhooks; the id when it is not registered. */
export async function serverDisplayName(serverId: string): Promise<string> {
  const server = await getServer(serverId).catch(() => null);
  return server?.name ?? serverId;
}
