/**
 * Multi-server registry.
 *
 * Each Hytale instance the panel manages has a row here. The migration from
 * v2.x is transparent: on first start, if servers.json doesn't exist, we
 * synthesise a single "default" entry from the legacy env-var configuration
 * (GAME_CONTAINER_NAME / SERVER_PATH / SERVER_PORT etc.) so existing
 * deployments keep working unchanged.
 *
 * A servers.json that exists but cannot be read or parsed is never replaced:
 * the panel keeps a copy next to it and refuses to start, because a fresh
 * registry would silently forget every additional server.
 *
 * Schema history: v1 stored a per-server plugin port; v2 drops it (the
 * KyuubiSoft API plugin always listens on 18085 inside its own container)
 * and records the host-side root of each additional instance. A v1 file is
 * migrated on load, the original is kept as servers.json.v1.bak.
 *
 * New servers can be added through POST /api/servers. The new container is
 * created on demand via dockerode (services/dockerImageManager.ts).
 */
import { readFile, writeFile, mkdir, rename, copyFile, readdir } from 'fs/promises';
import { constants as fsConstants } from 'fs';
import path from 'path';
import crypto from 'crypto';
import { config } from '../config.js';
import { z } from 'zod';

const DATA_DIR = process.env.MANAGER_DATA_PATH || '/app/data';
const SERVERS_FILE = path.join(DATA_DIR, 'servers.json');
const CORRUPT_COPY_PREFIX = 'servers.json.corrupt-';

/** Where the manager sees the files of additional instances (one folder per id). */
export const INSTANCES_ROOT = process.env.INSTANCES_PATH || '/opt/hytale-instances';

// Id of the registry entry synthesised from the legacy single-server env
// config. That entry is the compose-stack's `hytale` service.
export const COMPOSE_SERVER_ID = 'default';
const COMPOSE_AUTH_PATH = '/opt/hytale/auth';

// Ids end up in paths, container names and URLs: no separators or dots, and
// no leading underscore (reserved for routes like /api/servers/_default).
const ServerIdSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/, 'invalid server id');
const PortSchema = z.number().int().min(1).max(65535);

export const ServerPathsSchema = z.object({
  server: z.string(),
  data: z.string(),
  backups: z.string(),
  mods: z.string(),
  earlyplugins: z.string(),
  plugins: z.string(),
  assets: z.string(),
  auth: z.string(),
});
export type ServerPaths = z.infer<typeof ServerPathsSchema>;

export const ServerNetworkSchema = z.object({
  serverPort: PortSchema,
  webMapPort: PortSchema,
  webMapWsPort: PortSchema,
  /** Whether the map ports are published on the host; missing means yes (older entries). */
  publishWebMap: z.boolean().optional(),
});
export type ServerNetwork = z.infer<typeof ServerNetworkSchema>;

export const ServerLimitsSchema = z.object({
  /** Container memory limit in bytes. */
  memory: z.number().int().positive().optional(),
  cpus: z.number().positive().optional(),
});
export type ServerLimits = z.infer<typeof ServerLimitsSchema>;

// Unknown keys are dropped on parse, which is also how a v1 entry loses its
// network.pluginPort.
export const ServerInstanceSchema = z.object({
  id: ServerIdSchema,
  name: z.string().min(1).max(64),
  containerName: z.string().min(1),
  status: z.enum(['ready', 'creating', 'broken']).default('ready'),
  network: ServerNetworkSchema,
  paths: ServerPathsSchema,
  /** Host path of the instance folder (bind sources); additional servers only. */
  hostRoot: z.string().min(1).optional(),
  /** Image the container was created from. */
  image: z.string().min(1).optional(),
  limits: ServerLimitsSchema.optional(),
  createdAt: z.string(),
  createdBy: z.string().default('system'),
});
export type ServerInstance = z.infer<typeof ServerInstanceSchema>;

function registryShape<V extends 1 | 2>(version: V) {
  return z
    .object({
      schemaVersion: z.literal(version),
      defaultId: ServerIdSchema,
      servers: z.array(ServerInstanceSchema),
    })
    .superRefine((file, ctx) => {
      const ids = file.servers.map((s) => s.id);
      const duplicate = ids.find((id, i) => ids.indexOf(id) !== i);
      if (duplicate) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `duplicate server id "${duplicate}"`,
        });
      }
      if (!ids.includes(file.defaultId)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['defaultId'],
          message: `defaultId "${file.defaultId}" is not a registered server`,
        });
      }
    });
}

export const ServersFileSchema = registryShape(2);
const ServersFileV1Schema = registryShape(1);
export type ServersFile = z.infer<typeof ServersFileSchema>;

/** servers.json exists but is unusable; the panel must not start on top of it. */
export class ServerRegistryError extends Error {
  constructor(
    message: string,
    /** Copy of the damaged file, when one could be made. */
    readonly copyPath: string | null,
  ) {
    super(message);
    this.name = 'ServerRegistryError';
  }
}

let cache: ServersFile | null = null;
let loading: Promise<ServersFile> | null = null;
// Sticky: a damaged file is copied and reported once, not on every call.
let loadFailure: ServerRegistryError | null = null;

// Lightweight lifecycle hooks so cross-cutting services (pluginEvents,
// scheduler, websocket log streams, …) can react to add/delete of a server
// without servers.ts importing them and creating a cycle. Subscribers are
// fire-and-forget — failures are caught and logged.
// The add hooks run once per server, when it was created; a later change of
// its status (a reconcile finding its container again) is a status change.
type ServerLifecycleHook = (server: ServerInstance) => void | Promise<void>;
type ServerStatusHook = (
  server: ServerInstance,
  from: ServerInstance['status'],
) => void | Promise<void>;
const addHooks: ServerLifecycleHook[] = [];
const deleteHooks: Array<(serverId: string) => void | Promise<void>> = [];
const statusHooks: ServerStatusHook[] = [];

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

/**
 * Runs after the status of a registered server changed, also from `creating`
 * while it is created; the add and delete hooks are separate.
 */
export function onServerStatusChanged(hook: ServerStatusHook): () => void {
  statusHooks.push(hook);
  return () => {
    const i = statusHooks.indexOf(hook);
    if (i >= 0) statusHooks.splice(i, 1);
  };
}

async function fireStatusHooks(server: ServerInstance, from: ServerInstance['status']) {
  for (const h of statusHooks) {
    try {
      await h(server, from);
    } catch (err) {
      console.error('[servers] onServerStatusChanged hook threw:', err);
    }
  }
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

async function writeFileAtomic(data: ServersFile): Promise<void> {
  await mkdir(DATA_DIR, { recursive: true });
  const tmp = `${SERVERS_FILE}.tmp`;
  await writeFile(tmp, JSON.stringify(data, null, 2), 'utf-8');
  // atomic-ish: rename on POSIX is atomic
  await rename(tmp, SERVERS_FILE);
}

/**
 * The compose server's container, ports and paths are fixed by the compose
 * file and its env vars; the registry row only names it. Overlaying the live
 * config keeps a stale row (e.g. after a STACK_NAME change) from pointing the
 * panel at a container or folder that no longer exists.
 */
function composeRuntimeFields(): Pick<ServerInstance, 'containerName' | 'network' | 'paths'> {
  return {
    containerName: config.gameContainerName,
    network: {
      serverPort: config.serverPort,
      webMapPort: config.webMapPort,
      webMapWsPort: config.webMapWsPort,
    },
    paths: {
      server: config.serverPath,
      data: config.dataPath,
      backups: config.backupsPath,
      mods: config.modsPath,
      earlyplugins: config.earlyPluginsPath,
      plugins: config.pluginsPath,
      assets: config.assetsPath,
      auth: COMPOSE_AUTH_PATH,
    },
  };
}

function withComposeRuntime(file: ServersFile): ServersFile {
  return {
    ...file,
    servers: file.servers.map((s) =>
      isComposeServer(s) ? { ...s, ...composeRuntimeFields() } : s,
    ),
  };
}

function buildComposeEntry(): ServerInstance {
  return {
    id: COMPOSE_SERVER_ID,
    name: 'Primary Server',
    status: 'ready',
    ...composeRuntimeFields(),
    createdAt: new Date().toISOString(),
    createdBy: 'system',
  };
}

function instanceHostRoot(id: string): string {
  return path.posix.join(config.hostDataPath || '/opt/hytale', 'instances', id);
}

function instanceRoot(id: string): string {
  return path.posix.join(INSTANCES_ROOT, id);
}

/** v1 → v2: the plugin port is gone (stripped by the schema), instances get their host root. */
function migrateFromV1(v1: z.infer<typeof ServersFileV1Schema>): ServersFile {
  return {
    schemaVersion: 2,
    defaultId: v1.defaultId,
    servers: v1.servers.map((s) => {
      // Only the panel's own layout can be mapped back to a host folder.
      const standardLayout = s.paths.server === path.posix.join(instanceRoot(s.id), 'server');
      if (isComposeServer(s) || s.hostRoot || !standardLayout) return s;
      return { ...s, hostRoot: instanceHostRoot(s.id) };
    }),
  };
}

type ParseOutcome =
  { ok: true; file: ServersFile; migratedFrom: 1 | null } | { ok: false; reason: string };

function describeIssues(error: z.ZodError): string {
  return error.issues
    .slice(0, 5)
    .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
    .join('; ');
}

function parseRegistry(raw: string): ParseOutcome {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (err) {
    return { ok: false, reason: `invalid JSON (${err instanceof Error ? err.message : err})` };
  }
  const version = (json as { schemaVersion?: unknown } | null)?.schemaVersion;
  if (version === 1) {
    const v1 = ServersFileV1Schema.safeParse(json);
    if (!v1.success) return { ok: false, reason: describeIssues(v1.error) };
    return { ok: true, file: migrateFromV1(v1.data), migratedFrom: 1 };
  }
  if (version === 2) {
    const v2 = ServersFileSchema.safeParse(json);
    if (!v2.success) return { ok: false, reason: describeIssues(v2.error) };
    return { ok: true, file: v2.data, migratedFrom: null };
  }
  return { ok: false, reason: `unsupported schemaVersion ${JSON.stringify(version)}` };
}

/** Copy of the damaged file; reuses an identical earlier copy (restart loops). */
async function keepCorruptCopy(raw: string): Promise<string | null> {
  try {
    for (const name of await readdir(DATA_DIR)) {
      if (!name.startsWith(CORRUPT_COPY_PREFIX)) continue;
      const existing = path.join(DATA_DIR, name);
      if ((await readFile(existing, 'utf-8').catch(() => null)) === raw) return existing;
    }
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const target = path.join(DATA_DIR, `${CORRUPT_COPY_PREFIX}${stamp}`);
    await copyFile(SERVERS_FILE, target, fsConstants.COPYFILE_EXCL);
    return target;
  } catch (err) {
    console.error('[servers] Could not copy the damaged servers.json:', err);
    return null;
  }
}

/** servers.json.v1.bak, or a dated name when an older copy with other content exists. */
async function keepV1Copy(raw: string): Promise<string> {
  const first = `${SERVERS_FILE}.v1.bak`;
  const existing = await readFile(first, 'utf-8').catch(() => null);
  if (existing === raw) return first;
  const target =
    existing === null
      ? first
      : `${SERVERS_FILE}.v1-${new Date().toISOString().replace(/[:.]/g, '-')}.bak`;
  await copyFile(SERVERS_FILE, target, fsConstants.COPYFILE_EXCL);
  return target;
}

async function loadRegistry(): Promise<ServersFile> {
  let raw: string;
  try {
    raw = await readFile(SERVERS_FILE, 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw new ServerRegistryError(
        `${SERVERS_FILE} could not be read (${err instanceof Error ? err.message : err}). ` +
          'Fix its permissions; the panel does not start without it.',
        null,
      );
    }
    const initial: ServersFile = {
      schemaVersion: 2,
      defaultId: COMPOSE_SERVER_ID,
      servers: [buildComposeEntry()],
    };
    await writeFileAtomic(initial);
    console.log('[servers] Initialised servers.json with legacy single-server defaults');
    return initial;
  }

  const parsed = parseRegistry(raw);
  if (!parsed.ok) {
    const copyPath = await keepCorruptCopy(raw);
    throw new ServerRegistryError(
      `${SERVERS_FILE} is damaged: ${parsed.reason}. The panel did not overwrite it` +
        (copyPath ? ` and kept a copy at ${copyPath}` : '') +
        '. Repair the file (or restore it from a panel backup) and restart. ' +
        'Removing it recreates only the primary server; additional servers would have to be added again.',
      copyPath,
    );
  }
  if (parsed.migratedFrom === 1) {
    const copy = await keepV1Copy(raw);
    await writeFileAtomic(parsed.file);
    console.log(`[servers] Migrated servers.json to schema v2 (copy kept as ${copy})`);
  }
  return parsed.file;
}

/**
 * Lazy-initialised registry. First call materialises servers.json from the
 * legacy env-var setup if it doesn't exist yet so v2.x → v3 migration is
 * automatic and zero-touch. Throws {@link ServerRegistryError} when the file
 * exists but is unusable.
 */
export async function ensureLoaded(): Promise<ServersFile> {
  if (cache) return cache;
  if (loadFailure) throw loadFailure;
  loading ??= loadRegistry()
    .then((file) => {
      cache = withComposeRuntime(file);
      return cache;
    })
    .catch((err: unknown) => {
      if (err instanceof ServerRegistryError) loadFailure = err;
      throw err;
    })
    .finally(() => {
      loading = null;
    });
  return loading;
}

// Registry writes run one after another, each on the latest committed state.
let writeQueue: Promise<unknown> = Promise.resolve();

function withRegistryLock<T>(task: () => Promise<T>): Promise<T> {
  const run = writeQueue.then(task, task);
  writeQueue = run.catch(() => undefined);
  return run;
}

/** Write first, then publish: a failed write leaves the cache on the old state. */
async function commit(next: ServersFile): Promise<void> {
  await writeFileAtomic(next);
  cache = next;
}

export async function listServers(): Promise<ServerInstance[]> {
  return (await ensureLoaded()).servers;
}

export async function getServer(id: string): Promise<ServerInstance | null> {
  return (await ensureLoaded()).servers.find((s) => s.id === id) ?? null;
}

/**
 * The server legacy routes and unscoped callers act on. With multiserver off
 * that is always the compose server, even if an earlier setup pointed the
 * default elsewhere; the stored pointer stays for when the flag is turned on.
 */
function effectiveDefaultId(file: ServersFile): string {
  if (config.multiserverEnabled || file.defaultId === COMPOSE_SERVER_ID) return file.defaultId;
  return file.servers.some((s) => s.id === COMPOSE_SERVER_ID) ? COMPOSE_SERVER_ID : file.defaultId;
}

export async function getDefaultId(): Promise<string> {
  return effectiveDefaultId(await ensureLoaded());
}

/**
 * Synchronous variant for callers without an async boundary. The registry is
 * loaded during boot; before that the compose server's id is returned.
 */
export function getDefaultIdSync(): string {
  return cache ? effectiveDefaultId(cache) : COMPOSE_SERVER_ID;
}

/**
 * Normalise an optional server id to a concrete registry id. Legacy callers
 * (every /api/server/* route) pass `undefined`, old database rows `null`;
 * anything keyed per server — intentional-stop markers, stdin streams, … —
 * must use the same id the watchdog and the scoped routes use, never a
 * placeholder key. The id itself is not checked; getServerContext() does.
 */
export async function resolveServerId(serverId?: string | null): Promise<string> {
  if (serverId) return serverId;
  try {
    return await getDefaultId();
  } catch {
    // Registry not readable yet (very early boot): the legacy entry's id.
    return COMPOSE_SERVER_ID;
  }
}

/** {@link resolveServerId} for synchronous callers (see {@link getDefaultIdSync}). */
export function resolveServerIdSync(serverId?: string | null): string {
  return serverId || getDefaultIdSync();
}

/**
 * True for the entry backing the compose-stack's own game container, which
 * is never deletable. Matched by id only: an extra entry that merely reuses
 * that container's name stays removable (registry-only), while the container
 * itself is still protected by the ownership-label check on delete.
 */
export function isComposeServer(server: Pick<ServerInstance, 'id'>): boolean {
  return server.id === COMPOSE_SERVER_ID;
}

export async function setDefaultId(id: string): Promise<void> {
  await withRegistryLock(async () => {
    const file = await ensureLoaded();
    if (!file.servers.some((s) => s.id === id)) throw new Error('Unknown server id');
    await commit({ ...file, defaultId: id });
  });
}

export interface CreateServerInput {
  name: string;
  serverPort?: number;
  webMapPort?: number;
  webMapWsPort?: number;
  publishWebMap?: boolean;
  limits?: ServerLimits;
  paths?: Partial<ServerPaths>;
  createdBy: string;
}

function findFreePort(used: Set<number>, base: number): number {
  let p = base;
  while (used.has(p)) p++;
  used.add(p);
  return p;
}

/**
 * Registers a new server in `creating`. The add hooks do not run yet: the
 * caller fires them with notifyServerAdded() once the container exists.
 */
export async function createServerInstance(input: CreateServerInput): Promise<ServerInstance> {
  return withRegistryLock(async () => {
    const file = await ensureLoaded();
    // A duplicate id would make the next load reject the whole file.
    let id: string;
    do {
      id = crypto.randomUUID().slice(0, 8);
    } while (file.servers.some((s) => s.id === id));
    const used = new Set<number>();
    for (const s of file.servers) {
      used.add(s.network.serverPort);
      used.add(s.network.webMapPort);
      used.add(s.network.webMapWsPort);
    }
    for (const port of [input.serverPort, input.webMapPort, input.webMapWsPort]) {
      if (port !== undefined) used.add(port);
    }
    const network: ServerNetwork = {
      serverPort: input.serverPort ?? findFreePort(used, 5520),
      webMapPort: input.webMapPort ?? findFreePort(used, 18081),
      webMapWsPort: input.webMapWsPort ?? findFreePort(used, 18082),
      ...(input.publishWebMap !== undefined ? { publishWebMap: input.publishWebMap } : {}),
    };
    // Always generated: a caller-chosen name could point the instance (and a
    // later delete) at an unrelated container such as the manager itself.
    const containerName = `hytale-srv-${id}`;
    const root = instanceRoot(id);
    const created: ServerInstance = {
      id,
      name: input.name,
      containerName,
      status: 'creating',
      network,
      paths: {
        server: input.paths?.server ?? `${root}/server`,
        data: input.paths?.data ?? `${root}/data`,
        backups: input.paths?.backups ?? `${root}/backups`,
        mods: input.paths?.mods ?? `${root}/mods`,
        earlyplugins: input.paths?.earlyplugins ?? `${root}/earlyplugins`,
        plugins: input.paths?.plugins ?? `${root}/plugins`,
        assets: input.paths?.assets ?? `${root}/assets`,
        auth: input.paths?.auth ?? `${root}/auth`,
      },
      hostRoot: instanceHostRoot(id),
      ...(input.limits ? { limits: input.limits } : {}),
      createdAt: new Date().toISOString(),
      createdBy: input.createdBy,
    };
    await commit({ ...file, servers: [...file.servers, created] });
    return created;
  });
}

/** Runs the add hooks (scheduler, plugin events, …) for a server whose container now exists. */
export async function notifyServerAdded(id: string): Promise<void> {
  const server = await getServer(id);
  if (server) await fireAddHooks(server);
}

export type ServerInstancePatch = Partial<
  Pick<ServerInstance, 'name' | 'status' | 'image' | 'limits'>
>;

/**
 * Applies only the fields the patch defines; `undefined` never clears a field.
 * A changed status fires the status hooks once the entry is saved.
 */
export async function updateServerInstance(
  id: string,
  patch: ServerInstancePatch,
): Promise<ServerInstance | null> {
  const result = await withRegistryLock(async () => {
    const file = await ensureLoaded();
    const current = file.servers.find((s) => s.id === id);
    if (!current) return null;
    const defined = Object.fromEntries(
      Object.entries(patch).filter(([, value]) => value !== undefined),
    ) as ServerInstancePatch;
    const updated = ServerInstanceSchema.parse({ ...current, ...defined });
    await commit({ ...file, servers: file.servers.map((s) => (s.id === id ? updated : s)) });
    return { updated, from: current.status };
  });
  if (!result) return null;
  // Outside the registry lock: a hook may update the registry itself.
  if (result.updated.status !== result.from) await fireStatusHooks(result.updated, result.from);
  return result.updated;
}

export type DeleteBlockReason = 'not_found' | 'compose' | 'default' | 'last';

function deleteBlockReason(file: ServersFile, id: string): DeleteBlockReason | null {
  const server = file.servers.find((s) => s.id === id);
  if (!server) return 'not_found';
  if (isComposeServer(server)) return 'compose';
  if (file.defaultId === id) return 'default';
  if (file.servers.length <= 1) return 'last';
  return null;
}

/**
 * Why a registry entry may not be deleted, or null when it may. Callers must
 * check this BEFORE touching the backing container: the compose server, the
 * current default and the last remaining server are never deletable.
 */
export async function getDeleteBlockReason(id: string): Promise<DeleteBlockReason | null> {
  return deleteBlockReason(await ensureLoaded(), id);
}

export async function deleteServerInstance(id: string): Promise<boolean> {
  const deleted = await withRegistryLock(async () => {
    const file = await ensureLoaded();
    if (deleteBlockReason(file, id)) return false;
    await commit({ ...file, servers: file.servers.filter((s) => s.id !== id) });
    return true;
  });
  if (deleted) await fireDeleteHooks(id);
  return deleted;
}
