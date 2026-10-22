/**
 * Multi-server registry.
 *
 * Each Hytale instance the panel manages has a row here. The migration from
 * v2.x is transparent: on first start, if servers.json doesn't exist, we
 * synthesise a single "default" entry from the legacy env-var configuration
 * (GAME_CONTAINER_NAME / SERVER_PATH / SERVER_PORT etc.) so existing
 * deployments keep working unchanged.
 *
 * New servers can be added through POST /api/servers. The new container is
 * created on demand via dockerode using the same image (`STACK_NAME`-built)
 * and port range 5520+ / 18081+ / 18085+.
 */
import { readFile, writeFile, mkdir } from 'fs/promises';
import path from 'path';
import crypto from 'crypto';
import { config } from '../config.js';
import { z } from 'zod';

const DATA_DIR = process.env.MANAGER_DATA_PATH || '/app/data';
const SERVERS_FILE = path.join(DATA_DIR, 'servers.json');

export const ServerPathsSchema = z.object({
  server: z.string(),
  data: z.string(),
  backups: z.string(),
  mods: z.string(),
  plugins: z.string(),
  assets: z.string(),
  auth: z.string(),
});

export const ServerInstanceSchema = z.object({
  id: z.string(),
  name: z.string().min(1).max(64),
  containerName: z.string().min(1),
  status: z.enum(['ready', 'creating', 'broken']).default('ready'),
  network: z.object({
    serverPort: z.number().int(),
    webMapPort: z.number().int(),
    webMapWsPort: z.number().int(),
    pluginPort: z.number().int(),
  }),
  paths: ServerPathsSchema,
  createdAt: z.string(),
  createdBy: z.string().default('system'),
});
export type ServerInstance = z.infer<typeof ServerInstanceSchema>;

export const ServersFileSchema = z.object({
  schemaVersion: z.literal(1),
  defaultId: z.string(),
  servers: z.array(ServerInstanceSchema),
});
export type ServersFile = z.infer<typeof ServersFileSchema>;

let cache: ServersFile | null = null;

// Lightweight lifecycle hooks so cross-cutting services (pluginEvents,
// scheduler, websocket log streams, …) can react to add/delete of a server
// without servers.ts importing them and creating a cycle. Subscribers are
// fire-and-forget — failures are caught and logged.
type ServerLifecycleHook = (server: ServerInstance) => void | Promise<void>;
const addHooks: ServerLifecycleHook[] = [];
const deleteHooks: Array<(serverId: string) => void | Promise<void>> = [];

export function onServerAdded(hook: ServerLifecycleHook): () => void {
  addHooks.push(hook);
  return () => {
    const i = addHooks.indexOf(hook);
    if (i >= 0) addHooks.splice(i, 1);
  };
}

export function onServerDeleted(hook: (serverId: string) => void | Promise<void>): () => void {
  deleteHooks.push(hook);
  return () => {
    const i = deleteHooks.indexOf(hook);
    if (i >= 0) deleteHooks.splice(i, 1);
  };
}

async function fireAddHooks(server: ServerInstance): Promise<void> {
  for (const h of addHooks) {
    try {
      await h(server);
    } catch (err) {
      console.error('[servers] onServerAdded hook threw:', err);
    }
  }
}

async function fireDeleteHooks(serverId: string): Promise<void> {
  for (const h of deleteHooks) {
    try {
      await h(serverId);
    } catch (err) {
      console.error('[servers] onServerDeleted hook threw:', err);
    }
  }
}

async function readFileOrNull(): Promise<ServersFile | null> {
  try {
    const raw = await readFile(SERVERS_FILE, 'utf-8');
    return ServersFileSchema.parse(JSON.parse(raw));
  } catch {
    return null;
  }
}

async function writeFileAtomic(data: ServersFile): Promise<void> {
  await mkdir(DATA_DIR, { recursive: true });
  const tmp = `${SERVERS_FILE}.tmp`;
  await writeFile(tmp, JSON.stringify(data, null, 2), 'utf-8');
  // atomic-ish: rename on POSIX is atomic
  const { rename } = await import('fs/promises');
  await rename(tmp, SERVERS_FILE);
}

// Id of the registry entry synthesised from the legacy single-server env
// config. That entry is the compose-stack's `hytale` service.
const LEGACY_DEFAULT_ID = 'default';

function buildDefaultEntryFromLegacyConfig(): ServerInstance {
  const containerName = config.gameContainerName;
  return {
    id: LEGACY_DEFAULT_ID,
    name: 'Primary Server',
    containerName,
    status: 'ready',
    network: {
      serverPort: config.serverPort,
      webMapPort: config.webMapPort,
      webMapWsPort: config.webMapWsPort,
      pluginPort: 18085,
    },
    paths: {
      server: config.serverPath,
      data: config.dataPath,
      backups: config.backupsPath,
      mods: config.modsPath,
      plugins: config.pluginsPath,
      assets: config.assetsPath,
      auth: '/opt/hytale/auth',
    },
    createdAt: new Date().toISOString(),
    createdBy: 'system',
  };
}

/**
 * Lazy-initialised registry. First call materialises servers.json from the
 * legacy env-var setup if it doesn't exist yet so v2.x → v3 migration is
 * automatic and zero-touch.
 */
export async function ensureLoaded(): Promise<ServersFile> {
  if (cache) return cache;
  const onDisk = await readFileOrNull();
  if (onDisk) {
    cache = onDisk;
    return cache;
  }
  const defaultEntry = buildDefaultEntryFromLegacyConfig();
  const initial: ServersFile = {
    schemaVersion: 1,
    defaultId: defaultEntry.id,
    servers: [defaultEntry],
  };
  await writeFileAtomic(initial);
  cache = initial;
  console.log('[servers] Initialised servers.json with legacy single-server defaults');
  return cache;
}

export async function listServers(): Promise<ServerInstance[]> {
  return (await ensureLoaded()).servers;
}

export async function getServer(id: string): Promise<ServerInstance | null> {
  return (await ensureLoaded()).servers.find((s) => s.id === id) ?? null;
}

export async function getDefaultId(): Promise<string> {
  return (await ensureLoaded()).defaultId;
}

/**
 * Normalise an optional server id to a concrete registry id. Legacy callers
 * (every /api/server/* route) pass `undefined`; anything keyed per server —
 * intentional-stop markers, stdin streams, … — must use the same id the
 * watchdog and the scoped routes use, never a placeholder key.
 */
export async function resolveServerId(serverId?: string): Promise<string> {
  if (serverId) return serverId;
  try {
    return await getDefaultId();
  } catch {
    // Registry not readable yet (very early boot): the legacy entry's id.
    return LEGACY_DEFAULT_ID;
  }
}

/**
 * True for the entry backing the compose-stack's own game container, which
 * is never deletable. Matched by id only: an extra entry that merely reuses
 * that container's name stays removable (registry-only), while the container
 * itself is still protected by the ownership-label check on delete.
 */
export function isComposeServer(server: ServerInstance): boolean {
  return server.id === LEGACY_DEFAULT_ID;
}

export async function setDefaultId(id: string): Promise<void> {
  const file = await ensureLoaded();
  if (!file.servers.some((s) => s.id === id)) throw new Error('Unknown server id');
  file.defaultId = id;
  await writeFileAtomic(file);
}

export interface CreateServerInput {
  name: string;
  serverPort?: number;
  webMapPort?: number;
  webMapWsPort?: number;
  pluginPort?: number;
  paths?: Partial<ServerInstance['paths']>;
  createdBy: string;
}

function findFreePort(used: Set<number>, base: number): number {
  let p = base;
  while (used.has(p)) p++;
  used.add(p);
  return p;
}

export async function createServerInstance(input: CreateServerInput): Promise<ServerInstance> {
  const file = await ensureLoaded();
  const id = crypto.randomUUID().slice(0, 8);
  const used = new Set<number>();
  for (const s of file.servers) {
    used.add(s.network.serverPort);
    used.add(s.network.webMapPort);
    used.add(s.network.webMapWsPort);
    used.add(s.network.pluginPort);
  }
  const serverPort = input.serverPort ?? findFreePort(used, 5520);
  const webMapPort = input.webMapPort ?? findFreePort(used, 18081);
  const webMapWsPort = input.webMapWsPort ?? findFreePort(used, 18082);
  const pluginPort = input.pluginPort ?? findFreePort(used, 18085);
  // Always generated: a caller-chosen name could point the instance (and a
  // later delete) at an unrelated container such as the manager itself.
  const containerName = `hytale-srv-${id}`;
  const root = `/opt/hytale-instances/${id}`;
  const instance: ServerInstance = {
    id,
    name: input.name,
    containerName,
    status: 'creating',
    network: { serverPort, webMapPort, webMapWsPort, pluginPort },
    paths: {
      server: input.paths?.server ?? `${root}/server`,
      data: input.paths?.data ?? `${root}/data`,
      backups: input.paths?.backups ?? `${root}/backups`,
      mods: input.paths?.mods ?? `${root}/mods`,
      plugins: input.paths?.plugins ?? `${root}/plugins`,
      assets: input.paths?.assets ?? `${root}/assets`,
      auth: input.paths?.auth ?? `${root}/auth`,
    },
    createdAt: new Date().toISOString(),
    createdBy: input.createdBy,
  };
  file.servers.push(instance);
  await writeFileAtomic(file);
  await fireAddHooks(instance);
  return instance;
}

export async function updateServerInstance(
  id: string,
  patch: Partial<Pick<ServerInstance, 'name' | 'status'>>,
): Promise<ServerInstance | null> {
  const file = await ensureLoaded();
  const idx = file.servers.findIndex((s) => s.id === id);
  if (idx < 0) return null;
  file.servers[idx] = { ...file.servers[idx], ...patch };
  await writeFileAtomic(file);
  return file.servers[idx];
}

export type DeleteBlockReason = 'not_found' | 'compose' | 'default' | 'last';

/**
 * Why a registry entry may not be deleted, or null when it may. Callers must
 * check this BEFORE touching the backing container: the compose server, the
 * current default and the last remaining server are never deletable.
 */
export async function getDeleteBlockReason(id: string): Promise<DeleteBlockReason | null> {
  const file = await ensureLoaded();
  const server = file.servers.find((s) => s.id === id);
  if (!server) return 'not_found';
  if (isComposeServer(server)) return 'compose';
  if (file.defaultId === id) return 'default';
  if (file.servers.length <= 1) return 'last';
  return null;
}

export async function deleteServerInstance(id: string): Promise<boolean> {
  if (await getDeleteBlockReason(id)) return false;
  const file = await ensureLoaded();
  file.servers = file.servers.filter((s) => s.id !== id);
  await writeFileAtomic(file);
  await fireDeleteHooks(id);
  return true;
}
