/**
 * Container lifecycle for additional server instances.
 *
 * `services/servers.ts` only tracks the registry entry in servers.json. This
 * module creates (and optionally starts) the matching Docker container from a
 * template read off the compose stack's primary game container:
 *
 *  - Image: `HYTALE_IMAGE` when set (the only override), else the image id
 *    the primary container runs (its tag may since point at another build).
 *    Without a primary container: `<STACK_NAME>-hytale`, then
 *    `<STACK_NAME>_hytale` (compose v2 and v1 tag spellings). Never pulled.
 *  - Network: the primary's stack network (`<STACK_NAME>-net` preferred).
 *  - Limits: the primary's memory and CPU limits; an instance can override them.
 *  - Environment: an allowlist of the primary's settings (never its secrets)
 *    plus the instance's own ports and plugin token.
 *
 * The KyuubiSoft API plugin listens on 18085 inside every container and is
 * never published: the panel reaches it over the stack network. Map ports are
 * published only when the instance asks for it (`network.publishWebMap`).
 *
 * Demo mode (`DEMO_MODE=1`) short-circuits: no Docker call is made and the
 * registry is updated to status 'ready' with a synthetic container id so the
 * UI behaves the same.
 */
import Docker from 'dockerode';
import net from 'net';
import path from 'path';
import { config } from '../config.js';
import { isDemoMode } from './demoData.js';
import { getDockerInstance } from './docker.js';
import { updateServerInstance, type ServerInstance } from './servers.js';
import { getPluginToken } from './pluginAuth.js';
import { maxHeapMbForLimit, ramToMb } from './jvmSettings.js';

const STACK_NAME = process.env.STACK_NAME || 'hytale';
const STACK_NETWORK = `${STACK_NAME}-net`;

// Ownership labels stamped on every container this module creates. Deletion
// only ever touches containers that carry managed + server-id with matching
// values; the primary label tells this panel's instances apart from those of
// another stack on the same host.
const LABEL_MANAGED = 'kyuubisoft.panel.managed';
const LABEL_SERVER_ID = 'kyuubisoft.panel.server-id';
const LABEL_SERVER_NAME = 'kyuubisoft.panel.server-name';
const LABEL_PRIMARY = 'kyuubisoft.panel.primary';

export const INSTANCE_LABELS = {
  managed: LABEL_MANAGED,
  serverId: LABEL_SERVER_ID,
  primary: LABEL_PRIMARY,
} as const;

/**
 * Primary-container variables a new instance inherits. An allowlist, not a
 * copy: the primary's environment can hold secrets (HYTALE_AUTH_KEY_FILE,
 * download URLs with credentials, its own plugin token) and settings that
 * only fit the primary (EXTRA_*_ARGS with its paths and ports).
 */
const INHERITED_ENV: readonly string[] = [
  'JAVA_MIN_RAM',
  'JAVA_MAX_RAM',
  'SERVER_BIND',
  'SERVER_JAR',
  'AUTH_MODE',
  'TZ',
  'USE_HYTALE_DOWNLOADER',
  'HYTALE_PATCHLINE',
  'AUTO_UPDATE',
  'DOWNLOADER_TIMEOUT',
  'LOG_RETENTION_DAYS',
  'LOG_MAX_FILES',
  'FIX_OWNERSHIP',
];

/** Heap the image starts with when JAVA_MAX_RAM is not set (Dockerfile). */
const IMAGE_DEFAULT_MAX_RAM = '4G';

/**
 * Folders of an instance: `<hostRoot>/<dir>` on the host, `/opt/hytale/<dir>`
 * in its container. Every VOLUME of the image is bound, so no data ends up in
 * an anonymous volume.
 */
export const INSTANCE_DIRS = [
  'server',
  'data',
  'backups',
  'mods',
  'plugins',
  'prefabs',
  'downloader',
  'auth',
  'updater',
  'assets',
] as const;

// Same log rotation as the compose service.
const LOG_CONFIG = { Type: 'json-file', Config: { 'max-size': '50m', 'max-file': '5' } };

export interface ResourceLimits {
  /** Bytes. */
  memory?: number;
  /** Bytes; only kept while it fits under the memory limit. */
  memoryReservation?: number;
  cpus?: number;
}

export interface InstanceTemplate {
  /** What new containers are created from: the primary's image id, or HYTALE_IMAGE. */
  image: string;
  /** The readable tag of that image, when it still points at it. */
  imageName?: string;
  network: string;
  /** Allowlisted variables of the primary container. */
  env: Readonly<Record<string, string>>;
  /** The primary's limits; an instance's own `limits` override them. */
  limits: Readonly<ResourceLimits>;
  /** HostIp for published map ports (WEBMAP_BIND); '' = all interfaces. */
  webMapBindIp: string;
  /** Things the operator should know, e.g. the primary could not be inspected. */
  warnings: string[];
}

export type TemplateResult =
  { ok: true; template: InstanceTemplate } | { ok: false; error: string };

export interface CreateOptions {
  /** Start the container right after `createContainer` resolves. */
  autoStart?: boolean;
  /** Template resolved by the caller; resolved here when missing. */
  template?: InstanceTemplate;
}

export interface DeleteOptions {
  /**
   * Runs `remove` once the server is stopped. The route passes the lifecycle
   * (`/stop`, wait for the exit, Docker fallback, under the server's lock);
   * without it Docker stops the container with its own stop timeout.
   */
  whileStopped?: (remove: () => Promise<void>) => Promise<void>;
}

export type CreateResult =
  | { ok: true; containerId: string; started: boolean; image: string; warnings: string[] }
  // template: image or network unknown, nothing was created. create: Docker
  // refused the container. start: the container exists but did not start.
  | { ok: false; code: 'template' | 'create' | 'start'; error: string };

export type DeleteResult =
  | { ok: true }
  // not_managed: the container exists but is not the panel's container for
  // this server, so it was left untouched. stop_failed: whileStopped could not
  // stop the server (or another operation holds it); nothing was removed.
  // docker_error: anything else.
  | { ok: false; code: 'not_managed' | 'stop_failed' | 'docker_error'; error: string };

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));

// ------------------------------------------------------------------
// Template from the primary container
// ------------------------------------------------------------------

/** The local image id of `ref`; the ref itself when Docker reports none, null when missing. */
async function localImageId(docker: Docker, ref: string): Promise<string | null> {
  try {
    const info = await docker.getImage(ref).inspect();
    return info?.Id || ref;
  } catch {
    return null;
  }
}

async function resolveImage(
  docker: Docker,
  primary: Docker.ContainerInspectInfo | null,
): Promise<{ ok: true; image: string; imageName?: string } | { ok: false; error: string }> {
  const override = process.env.HYTALE_IMAGE?.trim();
  if (override) {
    if (await localImageId(docker, override))
      return { ok: true, image: override, imageName: override };
    return {
      ok: false,
      error: `HYTALE_IMAGE "${override}" is not available locally. Build or pull it first.`,
    };
  }
  // The image id the primary runs, not its tag: a tag can move on to a newer
  // build (or one of another stack). The tag only names it while it still
  // points at the same image.
  if (primary?.Image && (await localImageId(docker, primary.Image))) {
    const tag = primary.Config?.Image;
    const sameImage =
      !!tag && tag !== primary.Image && (await localImageId(docker, tag)) === primary.Image;
    return { ok: true, image: primary.Image, ...(sameImage ? { imageName: tag } : {}) };
  }
  const candidates = [
    primary?.Config?.Image,
    `${STACK_NAME}-hytale`,
    `${STACK_NAME}_hytale`,
  ].filter((ref, i, all): ref is string => !!ref && all.indexOf(ref) === i);
  for (const ref of candidates) {
    if (await localImageId(docker, ref)) return { ok: true, image: ref, imageName: ref };
  }
  return {
    ok: false,
    error:
      `Cannot determine the game server image (tried ${candidates.map((c) => `"${c}"`).join(', ')}). ` +
      `Start the compose stack first, check GAME_CONTAINER_NAME (now "${config.gameContainerName}") ` +
      'or set HYTALE_IMAGE.',
  };
}

async function resolveNetwork(
  docker: Docker,
  primary: Docker.ContainerInspectInfo | null,
): Promise<{ ok: true; network: string; warnings: string[] } | { ok: false; error: string }> {
  if (primary) {
    if (primary.HostConfig?.NetworkMode === 'host') {
      return {
        ok: false,
        error:
          'The primary container uses host networking. Additional servers need the stack network, ' +
          'since they would all compete for the same ports otherwise.',
      };
    }
    const names = Object.keys(primary.NetworkSettings?.Networks ?? {});
    const stackNet =
      names.find((n) => n === STACK_NETWORK) ??
      names.find((n) => !['bridge', 'host', 'none'].includes(n));
    if (stackNet) return { ok: true, network: stackNet, warnings: [] };
    if (names.includes('bridge')) {
      return {
        ok: true,
        network: 'bridge',
        warnings: [
          "The primary container is only on Docker's default bridge network. The panel cannot " +
            'reach the new server by name there (console via Docker works, the plugin does not).',
        ],
      };
    }
  }
  try {
    await docker.getNetwork(STACK_NETWORK).inspect();
    return { ok: true, network: STACK_NETWORK, warnings: [] };
  } catch {
    return {
      ok: false,
      error:
        `Cannot determine the stack network: the primary container "${config.gameContainerName}" ` +
        `is not available and the network "${STACK_NETWORK}" does not exist. Set STACK_NAME for the manager.`,
    };
  }
}

function inheritEnv(primary: Docker.ContainerInspectInfo | null): Record<string, string> {
  const env: Record<string, string> = {};
  for (const entry of primary?.Config?.Env ?? []) {
    const eq = entry.indexOf('=');
    if (eq <= 0) continue;
    const key = entry.slice(0, eq);
    const value = entry.slice(eq + 1);
    if (value !== '' && INHERITED_ENV.includes(key)) env[key] = value;
  }
  return env;
}

const positive = (n: unknown): number | undefined =>
  typeof n === 'number' && Number.isFinite(n) && n > 0 ? n : undefined;

function primaryLimits(primary: Docker.ContainerInspectInfo | null): ResourceLimits {
  const host = primary?.HostConfig;
  if (!host) return {};
  const nanoCpus = positive(host.NanoCpus);
  const quota = positive(host.CpuQuota);
  const period = positive(host.CpuPeriod);
  let cpus: number | undefined;
  if (nanoCpus) cpus = nanoCpus / 1e9;
  else if (quota && period) cpus = quota / period;
  return {
    memory: positive(host.Memory),
    memoryReservation: positive(host.MemoryReservation),
    cpus,
  };
}

function resolveWebMapBindIp(): { ok: true; ip: string } | { ok: false; error: string } {
  const raw = process.env.WEBMAP_BIND?.trim() ?? '';
  if (raw === '' || raw === '0.0.0.0') return { ok: true, ip: '' };
  if (net.isIP(raw)) return { ok: true, ip: raw };
  return { ok: false, error: `WEBMAP_BIND "${raw}" is not an IP address` };
}

/**
 * Image, network, limits and inherited settings for a new instance. Fails
 * with a message the operator can act on when image or network cannot be
 * determined; nothing is created in that case.
 */
export async function resolveInstanceTemplate(dockerOverride?: Docker): Promise<TemplateResult> {
  const bind = resolveWebMapBindIp();
  if (!bind.ok) return bind;
  if (isDemoMode()) {
    return {
      ok: true,
      template: {
        image: 'demo',
        network: STACK_NETWORK,
        env: {},
        limits: {},
        webMapBindIp: bind.ip,
        warnings: [],
      },
    };
  }
  const docker = dockerOverride ?? getDockerInstance();
  const warnings: string[] = [];
  let primary: Docker.ContainerInspectInfo | null = null;
  try {
    primary = await docker.getContainer(config.gameContainerName).inspect();
  } catch (err) {
    warnings.push(
      `The primary container "${config.gameContainerName}" could not be inspected (${errorText(err)}). ` +
        'The new server gets no memory/CPU limits and none of its settings.',
    );
  }
  const image = await resolveImage(docker, primary);
  if (!image.ok) return image;
  const network = await resolveNetwork(docker, primary);
  if (!network.ok) return network;
  return {
    ok: true,
    template: {
      image: image.image,
      ...(image.imageName ? { imageName: image.imageName } : {}),
      network: network.network,
      env: inheritEnv(primary),
      limits: primaryLimits(primary),
      webMapBindIp: bind.ip,
      warnings: [...warnings, ...network.warnings],
    },
  };
}

/**
 * Null when the heap the instance starts with fits the memory limit, else
 * why not. Same rule as the panel's JVM settings and start-server.sh.
 */
export function checkHeapFitsLimit(javaMaxRam: string | undefined, memory: number): string | null {
  const maxRam = javaMaxRam ?? IMAGE_DEFAULT_MAX_RAM;
  const heapMb = ramToMb(maxRam);
  const maxHeapMb = maxHeapMbForLimit(memory);
  if (heapMb === null || maxHeapMb === null || heapMb <= maxHeapMb) return null;
  return (
    `A memory limit of ${Math.floor(memory / 1024 / 1024)} MB leaves no room for the ` +
    `${maxRam} heap the server starts with (at most ${maxHeapMb} MB fit). Raise the limit.`
  );
}

// ------------------------------------------------------------------
// Container create options
// ------------------------------------------------------------------

function effectiveLimits(instance: ServerInstance, template: InstanceTemplate): ResourceLimits {
  const memory = instance.limits?.memory ?? template.limits.memory;
  const cpus = instance.limits?.cpus ?? template.limits.cpus;
  // Docker rejects a reservation above the limit.
  const reservation = template.limits.memoryReservation;
  const memoryReservation =
    reservation && (!memory || reservation <= memory) ? reservation : undefined;
  return { memory, memoryReservation, cpus };
}

/** Host folder of an instance (bind sources). */
export function instanceHostRoot(instance: ServerInstance): string {
  return (
    instance.hostRoot ??
    path.posix.join(config.hostDataPath || '/opt/hytale', 'instances', instance.id)
  );
}

function buildBinds(instance: ServerInstance): string[] {
  const root = instanceHostRoot(instance);
  // The container-side targets MUST match the image's expectations: the
  // entrypoint always looks at /opt/hytale/<dir>. `instance.paths.*` are the
  // manager's view of the same folders.
  return INSTANCE_DIRS.map((dir) => `${path.posix.join(root, dir)}:/opt/hytale/${dir}`);
}

/** Entries from before the publish switch always published their map ports. */
const publishesWebMap = (instance: ServerInstance): boolean =>
  instance.network.publishWebMap !== false;

function buildPortBindings(instance: ServerInstance, webMapBindIp: string) {
  const { serverPort, webMapPort, webMapWsPort } = instance.network;
  // PortBindings keys are `<port>/<proto>`; HostPort is the published host
  // port. UDP for the game socket (QUIC), TCP for the map.
  const bindings: Record<string, Array<{ HostIp?: string; HostPort: string }>> = {
    [`${serverPort}/udp`]: [{ HostPort: String(serverPort) }],
  };
  if (publishesWebMap(instance)) {
    const host = webMapBindIp ? { HostIp: webMapBindIp } : {};
    bindings[`${webMapPort}/tcp`] = [{ ...host, HostPort: String(webMapPort) }];
    bindings[`${webMapWsPort}/tcp`] = [{ ...host, HostPort: String(webMapWsPort) }];
  }
  return bindings;
}

function buildEnv(
  instance: ServerInstance,
  template: InstanceTemplate,
  pluginToken?: string,
): string[] {
  const env: Record<string, string> = {
    TZ: config.tz,
    ...template.env,
    SERVER_PORT: String(instance.network.serverPort),
    WEBMAP_PORT: String(instance.network.webMapPort),
    WEBMAP_WS_PORT: String(instance.network.webMapWsPort),
    // Periodic native backups off, as in the compose default; /backup and the
    // backup before an update still work.
    ENABLE_BACKUP: 'false',
  };
  // The KyuubiSoft API plugin falls back to this when its config file has
  // no token yet.
  if (pluginToken) env.KYUUBISOFT_API_TOKEN = pluginToken;
  return Object.entries(env).map(([key, value]) => `${key}=${value}`);
}

function buildCreateOptions(
  instance: ServerInstance,
  template: InstanceTemplate,
  pluginToken?: string,
): Docker.ContainerCreateOptions {
  const portBindings = buildPortBindings(instance, template.webMapBindIp);
  const limits = effectiveLimits(instance, template);
  return {
    name: instance.containerName,
    Image: template.image,
    Hostname: instance.containerName,
    Env: buildEnv(instance, template, pluginToken),
    // Same console setup as the compose service: commands via stdin, no TTY
    // (Ctrl+C in `docker attach` would kill the server), and time to save on
    // `docker stop` instead of Docker's 10 s default.
    OpenStdin: true,
    Tty: false,
    StopTimeout: 120,
    ExposedPorts: Object.fromEntries(Object.keys(portBindings).map((key) => [key, {}])),
    HostConfig: {
      Binds: buildBinds(instance),
      PortBindings: portBindings,
      RestartPolicy: { Name: 'on-failure', MaximumRetryCount: 3 },
      // Match the primary game container's security posture: drop all caps,
      // re-add only the four needed for chown/setuid/setgid on bind mounts.
      CapDrop: ['ALL'],
      CapAdd: ['CHOWN', 'SETUID', 'SETGID', 'DAC_OVERRIDE'],
      SecurityOpt: ['no-new-privileges:true'],
      NetworkMode: template.network,
      LogConfig: LOG_CONFIG,
      ...(limits.memory ? { Memory: limits.memory } : {}),
      ...(limits.memoryReservation ? { MemoryReservation: limits.memoryReservation } : {}),
      ...(limits.cpus ? { NanoCpus: Math.round(limits.cpus * 1e9) } : {}),
    },
    NetworkingConfig: {
      EndpointsConfig: {
        [template.network]: {},
      },
    },
    Labels: {
      [LABEL_MANAGED]: 'true',
      [LABEL_SERVER_ID]: instance.id,
      [LABEL_SERVER_NAME]: instance.name,
      [LABEL_PRIMARY]: config.gameContainerName,
    },
  };
}

/**
 * Create a Docker container that matches the given registry entry. Updates
 * `servers.json` status on completion. Returns a structured result rather
 * than throwing — callers in routes/* prefer to map this to an HTTP response.
 */
export async function createInstanceContainer(
  instance: ServerInstance,
  opts: CreateOptions = {},
  dockerOverride?: Docker,
): Promise<CreateResult> {
  // Demo mode: no real Docker call. We still flip the status so the UI
  // doesn't get stuck on "creating".
  if (isDemoMode()) {
    await updateServerInstance(instance.id, { status: 'ready' });
    return {
      ok: true,
      containerId: `demo-${instance.id}`,
      started: !!opts.autoStart,
      image: 'demo',
      warnings: [],
    };
  }

  const docker = dockerOverride ?? getDockerInstance();
  let template = opts.template;
  if (!template) {
    const resolved = await resolveInstanceTemplate(docker);
    if (!resolved.ok) {
      await updateServerInstance(instance.id, { status: 'broken' });
      return { ok: false, code: 'template', error: resolved.error };
    }
    template = resolved.template;
  }

  let created: Docker.Container;
  try {
    // Without a token the plugin stays locked, but the server itself still runs.
    const pluginToken = await getPluginToken(instance.id).catch((err) => {
      console.warn(`[dockerImageManager] No plugin token for ${instance.id}:`, errorText(err));
      return undefined;
    });
    created = await docker.createContainer(buildCreateOptions(instance, template, pluginToken));
  } catch (err) {
    await updateServerInstance(instance.id, { status: 'broken' });
    return { ok: false, code: 'create', error: errorText(err) };
  }

  if (opts.autoStart) {
    try {
      await created.start();
    } catch (err) {
      // Container exists but failed to start — leave status broken so the
      // operator can investigate via `docker logs <name>`.
      await updateServerInstance(instance.id, { status: 'broken', image: template.image });
      return {
        ok: false,
        code: 'start',
        error: `Container created but start failed: ${errorText(err)}`,
      };
    }
  }

  await updateServerInstance(instance.id, { status: 'ready', image: template.image });
  return {
    ok: true,
    containerId: created.id,
    started: !!opts.autoStart,
    image: template.image,
    warnings: template.warnings,
  };
}

function isNoSuchContainer(err: unknown): boolean {
  const msg = errorText(err);
  return /no such container/i.test(msg) || /404/.test(msg);
}

export type LimitsUpdateResult =
  | { ok: true }
  | { ok: false; code: 'not_found' | 'not_managed' | 'heap' | 'docker_error'; error: string };

/**
 * Apply new memory/CPU limits to the instance's container right away
 * (`docker update`, no restart). Only the panel's own container is touched.
 * A memory limit must fit the heap the server starts with: `panelMaxRam`
 * (the instance's panel-config.json), else the container's JAVA_MAX_RAM.
 */
export async function updateInstanceLimits(
  instance: ServerInstance,
  limits: Pick<ResourceLimits, 'memory' | 'cpus'>,
  opts: { panelMaxRam?: string } = {},
  dockerOverride?: Docker,
): Promise<LimitsUpdateResult> {
  if (isDemoMode()) return { ok: true };
  const docker = dockerOverride ?? getDockerInstance();
  let info: Docker.ContainerInspectInfo;
  try {
    info = await docker.getContainer(instance.containerName).inspect();
  } catch (err) {
    if (isNoSuchContainer(err)) {
      return {
        ok: false,
        code: 'not_found',
        error: `Container "${instance.containerName}" does not exist`,
      };
    }
    return { ok: false, code: 'docker_error', error: errorText(err) };
  }
  const labels = info.Config?.Labels ?? {};
  if (labels[LABEL_MANAGED] !== 'true' || labels[LABEL_SERVER_ID] !== instance.id) {
    return {
      ok: false,
      code: 'not_managed',
      error: `Container "${instance.containerName}" is not managed by the panel for server ${instance.id}; it was left untouched`,
    };
  }
  if (limits.memory) {
    const envMaxRam = (info.Config?.Env ?? [])
      .find((e) => e.startsWith('JAVA_MAX_RAM='))
      ?.slice('JAVA_MAX_RAM='.length);
    const heapProblem = checkHeapFitsLimit(
      opts.panelMaxRam ?? (envMaxRam || undefined),
      limits.memory,
    );
    if (heapProblem) return { ok: false, code: 'heap', error: heapProblem };
  }
  const update: Record<string, number> = {};
  if (limits.memory) {
    update.Memory = limits.memory;
    // Docker refuses a memory limit above the current swap limit; twice the
    // memory is what it sets itself for a container created with a limit.
    update.MemorySwap = limits.memory * 2;
    const reservation = positive(info.HostConfig?.MemoryReservation);
    if (reservation && reservation > limits.memory) update.MemoryReservation = limits.memory;
  }
  if (limits.cpus) update.NanoCpus = Math.round(limits.cpus * 1e9);
  try {
    await docker.getContainer(info.Id).update(update);
    return { ok: true };
  } catch (err) {
    return { ok: false, code: 'docker_error', error: errorText(err) };
  }
}

/**
 * Stop and remove the Docker container backing the registry entry. Bind-mount
 * data stays on the host (moving it to the trash is the caller's separate
 * step) and anonymous volumes are kept as well: nothing here deletes data.
 *
 * The container is inspected first and only removed when it carries the
 * panel's ownership labels for exactly this server id. Anything else (the
 * compose stack's own container, the manager, unrelated containers that
 * happen to share the name) is refused with `code: 'not_managed'`.
 */
export async function deleteInstanceContainer(
  instance: ServerInstance,
  opts: DeleteOptions = {},
  dockerOverride?: Docker,
): Promise<DeleteResult> {
  if (isDemoMode()) {
    return { ok: true };
  }

  const docker = dockerOverride ?? getDockerInstance();
  let containerId: string;
  try {
    const info = await docker.getContainer(instance.containerName).inspect();
    const labels = info.Config?.Labels ?? {};
    if (labels[LABEL_MANAGED] !== 'true' || labels[LABEL_SERVER_ID] !== instance.id) {
      return {
        ok: false,
        code: 'not_managed',
        error: `Container "${instance.containerName}" is not managed by the panel for server ${instance.id}; it was left untouched`,
      };
    }
    containerId = info.Id;
  } catch (err) {
    // 404 = already gone; treat as success.
    if (isNoSuchContainer(err)) return { ok: true };
    return { ok: false, code: 'docker_error', error: errorText(err) };
  }

  try {
    // Address the inspected container by id so a rename in between cannot
    // redirect the removal to a different container.
    const container = docker.getContainer(containerId);
    let removeFailed = false;
    const remove = async () => {
      try {
        await container.remove({ force: true, v: false });
      } catch (err) {
        removeFailed = true;
        throw err;
      }
    };
    // Only after the ownership check: a container that is not ours is never stopped.
    if (opts.whileStopped) {
      try {
        await opts.whileStopped(remove);
      } catch (err) {
        if (removeFailed) throw err;
        return { ok: false, code: 'stop_failed', error: errorText(err) };
      }
    } else {
      try {
        // No `t`: the container's StopTimeout (120 s) gives the server time to save.
        await container.stop();
      } catch {
        /* not running */
      }
      await remove();
    }
    return { ok: true };
  } catch (err) {
    if (isNoSuchContainer(err)) return { ok: true };
    return { ok: false, code: 'docker_error', error: errorText(err) };
  }
}

// Exposed for unit tests so they don't have to spy on private helpers.
export const __test__ = {
  buildCreateOptions,
  buildBinds,
  buildPortBindings,
  buildEnv,
  inheritEnv,
  primaryLimits,
};
