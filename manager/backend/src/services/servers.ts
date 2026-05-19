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

function buildDefaultEntryFromLegacyConfig(): ServerInstance {
  const containerName = config.gameContainerName;
  return {
    id: 'default',
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
  return (await ensureLoaded()).servers.find(s => s.id === id) ?? null;
}

export async function getDefaultId(): Promise<string> {
  return (await ensureLoaded()).defaultId;
}

export async function setDefaultId(id: string): Promise<void> {
  const file = await ensureLoaded();
  if (!file.servers.some(s => s.id === id)) throw new Error('Unknown server id');
  file.defaultId = id;
  await writeFileAtomic(file);
}

export interface CreateServerInput {
  name: string;
  containerName?: string;
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
  const containerName = input.containerName ?? `hytale-srv-${id}`;
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
  return instance;
}

export async function updateServerInstance(id: string, patch: Partial<Pick<ServerInstance, 'name' | 'status'>>): Promise<ServerInstance | null> {
  const file = await ensureLoaded();
  const idx = file.servers.findIndex(s => s.id === id);
  if (idx < 0) return null;
  file.servers[idx] = { ...file.servers[idx], ...patch };
  await writeFileAtomic(file);
  return file.servers[idx];
}

export async function deleteServerInstance(id: string): Promise<boolean> {
  const file = await ensureLoaded();
  if (file.defaultId === id && file.servers.length > 1) {
    // Promote the first remaining server as new default
    const fallback = file.servers.find(s => s.id !== id);
    if (fallback) file.defaultId = fallback.id;
  }
  if (file.defaultId === id) return false; // can't delete the only server
  const before = file.servers.length;
  file.servers = file.servers.filter(s => s.id !== id);
  if (file.servers.length === before) return false;
  await writeFileAtomic(file);
  return true;
}
