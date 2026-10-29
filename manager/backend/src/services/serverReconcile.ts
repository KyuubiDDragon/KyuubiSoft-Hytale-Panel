/**
 * Reconcile servers.json with the containers the panel created.
 *
 * A restart between "registry entry written" and "container created" leaves
 * an entry in `creating` for good, and a container removed by hand leaves an
 * entry that still looks fine. At boot (and on demand) every additional
 * server is checked against Docker by container name and ownership labels:
 *  - own container exists              → ready
 *  - no container                      → broken
 *  - another container holds the name  → broken
 * A changed status fires the status hooks, never the add hooks: those ran
 * when the server was created (the services that follow every server pick
 * up the registered ones at boot), and running them again would, for
 * example, drop the server from the user and key lists that name it.
 * Panel containers without a registry entry are only reported. Nothing here
 * stops, removes or creates a container.
 */
import type Docker from 'dockerode';
import { config } from '../config.js';
import { isDemoMode } from './demoData.js';
import { getDockerInstance } from './docker.js';
import { INSTANCE_LABELS } from './dockerImageManager.js';
import { withPortLock } from './portAllocator.js';
import {
  isComposeServer,
  listServers,
  updateServerInstance,
  type ServerInstance,
} from './servers.js';

type Status = ServerInstance['status'];

export interface ReconcileChange {
  serverId: string;
  from: Status;
  to: Status;
  reason: string;
}

export interface OrphanContainer {
  containerId: string;
  containerName: string;
  /** The server id on the container's label; no registry entry has it. */
  serverId: string;
  state: string;
}

export interface ReconcileReport {
  /** Additional servers compared with Docker. */
  checked: number;
  changes: ReconcileChange[];
  orphans: OrphanContainer[];
  /** Set when nothing was compared (demo mode). */
  skipped?: string;
}

const containerName = (c: Docker.ContainerInfo) => (c.Names?.[0] ?? c.Id).replace(/^\//, '');

const isOwnContainer = (c: Docker.ContainerInfo, serverId: string) =>
  c.Labels?.[INSTANCE_LABELS.managed] === 'true' &&
  c.Labels?.[INSTANCE_LABELS.serverId] === serverId;

/** Labelled by this panel: same primary container, or created before that label existed. */
function belongsToThisPanel(c: Docker.ContainerInfo): boolean {
  if (c.Labels?.[INSTANCE_LABELS.managed] !== 'true') return false;
  const primary = c.Labels?.[INSTANCE_LABELS.primary];
  return primary === undefined || primary === config.gameContainerName;
}

function targetStatus(
  server: ServerInstance,
  container: Docker.ContainerInfo | undefined,
): { to: Status; reason: string } {
  if (!container) {
    return { to: 'broken', reason: `container ${server.containerName} does not exist` };
  }
  if (!isOwnContainer(container, server.id)) {
    return {
      to: 'broken',
      reason: `container ${server.containerName} is not the panel's container for this server`,
    };
  }
  return { to: 'ready', reason: `container ${server.containerName} exists` };
}

async function compare(docker: Docker): Promise<ReconcileReport> {
  const containers = await docker.listContainers({ all: true });
  const byName = new Map(containers.map((c) => [containerName(c), c]));
  const servers = await listServers();
  const additional = servers.filter((s) => !isComposeServer(s));

  const changes: ReconcileChange[] = [];
  for (const server of additional) {
    const { to, reason } = targetStatus(server, byName.get(server.containerName));
    if (to === server.status) continue;
    await updateServerInstance(server.id, { status: to });
    changes.push({ serverId: server.id, from: server.status, to, reason });
  }

  const known = new Set(servers.map((s) => s.id));
  const orphans = containers
    .filter((c) => belongsToThisPanel(c))
    .filter((c) => !known.has(c.Labels?.[INSTANCE_LABELS.serverId] ?? ''))
    .map((c) => ({
      containerId: c.Id,
      containerName: containerName(c),
      serverId: c.Labels?.[INSTANCE_LABELS.serverId] ?? '',
      state: c.State,
    }));

  return { checked: additional.length, changes, orphans };
}

/**
 * Compare every additional server with Docker and fix its status. Runs while
 * no server is being created (same lock as the port allocation), so an
 * in-flight create is never marked broken halfway. Throws when Docker cannot
 * be reached; nothing is changed then.
 */
export async function reconcileServers(dockerOverride?: Docker): Promise<ReconcileReport> {
  if (isDemoMode()) return { checked: 0, changes: [], orphans: [], skipped: 'demo mode' };
  return withPortLock(() => compare(dockerOverride ?? getDockerInstance()));
}

function logReport(report: ReconcileReport): void {
  for (const c of report.changes) {
    console.log(`[reconcile] Server ${c.serverId}: ${c.from} -> ${c.to} (${c.reason})`);
  }
  for (const o of report.orphans) {
    console.warn(
      `[reconcile] Container ${o.containerName} (${o.state}) carries the panel's labels for server ` +
        `"${o.serverId}", which is not registered. It was left untouched; remove it with ` +
        `"docker rm ${o.containerName}" if it is no longer needed.`,
    );
  }
}

/** Boot-time run; logs the outcome and never throws. */
export async function startServerReconcile(): Promise<void> {
  try {
    logReport(await reconcileServers());
  } catch (err) {
    console.warn(
      '[reconcile] Could not compare the servers with Docker:',
      err instanceof Error ? err.message : err,
    );
  }
}
