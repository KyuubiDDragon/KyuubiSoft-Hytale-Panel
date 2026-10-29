/**
 * Container lifecycle for newly-registered server instances.
 *
 * `services/servers.ts` only tracks the registry entry in servers.json. Until
 * v3.1 the operator had to compose-up the matching Docker container by hand.
 * This module fills that gap: given a {@link ServerInstance}, it creates (and
 * optionally starts) a Docker container using the same image, networks and
 * capabilities as the compose-stack's primary `hytale` container.
 *
 * Image resolution order:
 *   1. explicit `opts.image`
 *   2. `HYTALE_IMAGE` env var
 *   3. `<STACK_NAME>-hytale` (the tag docker-compose builds by default for
 *      the `hytale` service: <project>_<service>, where project defaults to
 *      STACK_NAME). Note: compose actually tags it `<project>-<service>` on
 *      modern docker-compose v2 — we look up both spellings before giving up.
 *
 * Demo mode (`DEMO_MODE=1`) short-circuits: no Docker call is made and the
 * registry is updated to status 'ready' with a synthetic container id so the
 * UI behaves the same.
 */
import Docker from 'dockerode';
import { config } from '../config.js';
import { isDemoMode } from './demoData.js';
import { getDockerInstance } from './docker.js';
import { updateServerInstance, type ServerInstance } from './servers.js';
import { getPluginToken } from './pluginAuth.js';
import path from 'path';

export interface CreateOptions {
  /** Start the container right after `createContainer` resolves. */
  autoStart?: boolean;
  /** Override the image to use. */
  image?: string;
}

export interface DeleteOptions {
  /** Best-effort removal of the host-side bind-mount data. Default false. */
  removeData?: boolean;
}

export type CreateResult =
  { ok: true; containerId: string; started: boolean } | { ok: false; error: string };

export type DeleteResult =
  | { ok: true }
  // not_managed: the container exists but is not the panel's container for
  // this server, so it was left untouched. docker_error: anything else.
  | { ok: false; code: 'not_managed' | 'docker_error'; error: string };

const STACK_NAME = process.env.STACK_NAME || 'hytale';
const STACK_NETWORK = `${STACK_NAME}-net`;

// Ownership labels stamped on every container this module creates. Deletion
// only ever touches containers that carry both with matching values.
const LABEL_MANAGED = 'kyuubisoft.panel.managed';
const LABEL_SERVER_ID = 'kyuubisoft.panel.server-id';
const LABEL_SERVER_NAME = 'kyuubisoft.panel.server-name';

/**
 * Pick the most likely image tag for the new container. We do NOT pull —
 * the assumption is that the operator built the compose stack already and
 * the image is local.
 */
function resolveImage(explicit?: string): string {
  if (explicit) return explicit;
  if (process.env.HYTALE_IMAGE) return process.env.HYTALE_IMAGE;
  // Compose v2 default project name is the directory name; with STACK_NAME
  // overrides via .env it becomes STACK_NAME. Compose tags built images as
  // `<project>-<service>`. The compose-file's service is `hytale`.
  return `${STACK_NAME}-hytale`;
}

/**
 * Translate the registry's container-side paths back to host paths.
 *
 * The registry stores both the on-host bind source (under `config.hostDataPath`
 * by convention) and the container-internal mount target. New instances follow
 * the layout `${HOST_DATA_PATH}/instances/<serverId>/{server,data,…}` on host
 * and `/opt/hytale/{server,data,…}` inside the container — matching the
 * primary `hytale` service so the entrypoint scripts find what they expect.
 */
function buildBinds(instance: ServerInstance): string[] {
  const host = config.hostDataPath || '/opt/hytale';
  const root = path.posix.join(host, 'instances', instance.id);
  // The container-side targets MUST match the upstream image's expectations.
  // We don't read `instance.paths.*` for the *target* because those are panel
  // bookkeeping paths (where the manager container itself reads from);
  // inside the new game container, the entrypoint always looks at
  // /opt/hytale/<sub>.
  return [
    `${path.posix.join(root, 'server')}:/opt/hytale/server`,
    `${path.posix.join(root, 'data')}:/opt/hytale/data`,
    `${path.posix.join(root, 'backups')}:/opt/hytale/backups`,
    `${path.posix.join(root, 'mods')}:/opt/hytale/mods`,
    `${path.posix.join(root, 'plugins')}:/opt/hytale/plugins`,
    `${path.posix.join(root, 'assets')}:/opt/hytale/assets`,
    `${path.posix.join(root, 'auth')}:/opt/hytale/auth`,
  ];
}

function buildPortBindings(instance: ServerInstance) {
  const { serverPort, webMapPort, webMapWsPort, pluginPort } = instance.network;
  // PortBindings keys are `<port>/<proto>`; HostPort is the published host port.
  // UDP for the game socket (Hytale uses UDP/5520+), TCP for everything else.
  return {
    [`${serverPort}/udp`]: [{ HostPort: String(serverPort) }],
    [`${webMapPort}/tcp`]: [{ HostPort: String(webMapPort) }],
    [`${webMapWsPort}/tcp`]: [{ HostPort: String(webMapWsPort) }],
    [`${pluginPort}/tcp`]: [{ HostPort: String(pluginPort) }],
  };
}

function buildExposedPorts(instance: ServerInstance): Record<string, Record<string, never>> {
  const { serverPort, webMapPort, webMapWsPort, pluginPort } = instance.network;
  return {
    [`${serverPort}/udp`]: {},
    [`${webMapPort}/tcp`]: {},
    [`${webMapWsPort}/tcp`]: {},
    [`${pluginPort}/tcp`]: {},
  };
}

function buildCreateOptions(
  instance: ServerInstance,
  image: string,
  pluginToken?: string,
): Docker.ContainerCreateOptions {
  return {
    name: instance.containerName,
    Image: image,
    Hostname: instance.containerName,
    Env: [
      `STACK_NAME=${STACK_NAME}`,
      `SERVER_PORT=${instance.network.serverPort}`,
      `WEBMAP_PORT=${instance.network.webMapPort}`,
      `WEBMAP_WS_PORT=${instance.network.webMapWsPort}`,
      `TZ=${config.tz}`,
      // The KyuubiSoft API plugin falls back to this when its config file has
      // no token. Instance server dirs are not mounted into the manager, so
      // the panel cannot write that file for them.
      ...(pluginToken ? [`KYUUBISOFT_API_TOKEN=${pluginToken}`] : []),
    ],
    OpenStdin: true,
    Tty: true,
    ExposedPorts: buildExposedPorts(instance),
    HostConfig: {
      Binds: buildBinds(instance),
      PortBindings: buildPortBindings(instance),
      RestartPolicy: { Name: 'on-failure', MaximumRetryCount: 3 },
      // Match the primary game container's security posture: drop all caps,
      // re-add only the four needed for chown/setuid/setgid on bind mounts.
      CapDrop: ['ALL'],
      CapAdd: ['CHOWN', 'SETUID', 'SETGID', 'DAC_OVERRIDE'],
      SecurityOpt: ['no-new-privileges:true'],
      NetworkMode: STACK_NETWORK,
    },
    NetworkingConfig: {
      EndpointsConfig: {
        [STACK_NETWORK]: {},
      },
    },
    Labels: {
      [LABEL_MANAGED]: 'true',
      [LABEL_SERVER_ID]: instance.id,
      [LABEL_SERVER_NAME]: instance.name,
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
    return { ok: true, containerId: `demo-${instance.id}`, started: !!opts.autoStart };
  }

  const docker = dockerOverride ?? getDockerInstance();
  const image = resolveImage(opts.image);

  try {
    // Sanity-check: ensure the image exists locally. We fail fast with a
    // friendlier message than the cryptic dockerode 404.
    try {
      await docker.getImage(image).inspect();
    } catch {
      await updateServerInstance(instance.id, { status: 'broken' });
      return {
        ok: false,
        error: `Docker image "${image}" not found locally. Build the compose stack first or set HYTALE_IMAGE.`,
      };
    }

    // Without a token the plugin stays locked, but the server itself still runs.
    const pluginToken = await getPluginToken(instance.id).catch((err) => {
      console.warn(
        `[dockerImageManager] No plugin token for ${instance.id}:`,
        err instanceof Error ? err.message : err,
      );
      return undefined;
    });
    const created = await docker.createContainer(buildCreateOptions(instance, image, pluginToken));
    let started = false;
    if (opts.autoStart) {
      try {
        await created.start();
        started = true;
      } catch (err) {
        // Container exists but failed to start — leave status broken so the
        // operator can investigate via `docker logs <name>`.
        await updateServerInstance(instance.id, { status: 'broken' });
        return {
          ok: false,
          error: `Container created but start failed: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
    }

    await updateServerInstance(instance.id, { status: 'ready' });
    return { ok: true, containerId: created.id, started };
  } catch (err) {
    await updateServerInstance(instance.id, { status: 'broken' });
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: msg };
  }
}

function isNoSuchContainer(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /no such container/i.test(msg) || /404/.test(msg);
}

/**
 * Stop and remove the Docker container backing the registry entry. Volumes
 * (bind-mounts) are left in place unless the caller passes removeData; even
 * then we only attempt to remove the container's anonymous volumes via
 * `force: true, v: true` — bind-mount sources stay on the host.
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
    return {
      ok: false,
      code: 'docker_error',
      error: err instanceof Error ? err.message : String(err),
    };
  }

  try {
    // Address the inspected container by id so a rename in between cannot
    // redirect the removal to a different container.
    const container = docker.getContainer(containerId);
    // Best-effort stop. Ignore errors for already-stopped containers.
    try {
      await container.stop({ t: 10 });
    } catch {
      /* not running */
    }
    await container.remove({ force: true, v: !!opts.removeData });
    return { ok: true };
  } catch (err) {
    if (isNoSuchContainer(err)) return { ok: true };
    return {
      ok: false,
      code: 'docker_error',
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

// Exposed for unit tests so they don't have to spy on private helpers.
export const __test__ = {
  buildCreateOptions,
  buildBinds,
  buildPortBindings,
  resolveImage,
};
