/**
 * Host-port allocation for new server instances.
 *
 * servers.json only knows the ports of the servers the panel tracks. Any
 * other container on the host (a second stack, a stopped container that still
 * holds its bindings) can own a port as well, so Docker is the source of
 * truth: the published ports of every container, running or not, plus the
 * registry entries (an entry whose container does not exist right now still
 * owns its ports). Containers in host network mode publish nothing Docker
 * could report; their ports stay invisible here.
 */
import type Docker from 'dockerode';
import { isDemoMode } from './demoData.js';
import { getDockerInstance } from './docker.js';
import type { ServerInstance } from './servers.js';

export type PortProto = 'tcp' | 'udp';

export interface PortClaim {
  port: number;
  proto: PortProto;
  /** Container name, or `server:<id>` for a registry entry. */
  owner: string;
}

/** Hytale's own default; new game ports count up from here. */
export const GAME_PORT_BASE = 5520;
/**
 * Linux hands out ephemeral source ports from 32768 upwards, so a game port
 * there can be taken by any outgoing connection before the server binds it.
 */
export const GAME_PORT_MAX = 32767;
/** EasyWebMap's ports inside a container (the image default). */
export const WEBMAP_PORT_DEFAULT = 18081;
export const WEBMAP_WS_PORT_DEFAULT = 18082;
const PORT_MAX = 65535;

export interface PortRequest {
  serverPort?: number;
  webMapPort?: number;
  webMapWsPort?: number;
}

export interface InstancePorts {
  serverPort: number;
  webMapPort: number;
  webMapWsPort: number;
  /** Only map ports the caller asked for are published on the host. */
  publishWebMap: boolean;
}

export interface PortConflict {
  field: keyof PortRequest;
  port: number;
  proto: PortProto;
  owner: string;
}

export type PortAllocation =
  | { ok: true; ports: InstancePorts }
  | { ok: false; code: 'conflict'; conflicts: PortConflict[] }
  | { ok: false; code: 'exhausted'; field: keyof PortRequest }
  | { ok: false; code: 'docker_unavailable'; error: string };

/** "5520" or a range "5520-5530" → the ports in it. */
function parseHostPorts(hostPort: unknown): number[] {
  if (typeof hostPort !== 'string') return [];
  const m = /^(\d{1,5})(?:-(\d{1,5}))?$/.exec(hostPort.trim());
  if (!m) return [];
  const from = Number(m[1]);
  const to = m[2] ? Number(m[2]) : from;
  if (from < 1 || to > PORT_MAX || to < from) return [];
  const ports: number[] = [];
  for (let p = from; p <= to; p++) ports.push(p);
  return ports;
}

/** Claims from a HostConfig.PortBindings map (`{"5520/udp": [{HostPort: "5520"}]}`). */
export function claimsFromPortBindings(bindings: unknown, owner: string): PortClaim[] {
  if (!bindings || typeof bindings !== 'object') return [];
  const claims: PortClaim[] = [];
  for (const [key, hosts] of Object.entries(bindings as Record<string, unknown>)) {
    const proto: PortProto = key.endsWith('/udp') ? 'udp' : 'tcp';
    if (!Array.isArray(hosts)) continue;
    for (const host of hosts as Array<{ HostPort?: unknown }>) {
      for (const port of parseHostPorts(host?.HostPort)) claims.push({ port, proto, owner });
    }
  }
  return claims;
}

/** Host ports claimed by any container Docker knows, running or stopped. */
export async function listDockerPortClaims(docker: Docker): Promise<PortClaim[]> {
  const containers = await docker.listContainers({ all: true });
  const perContainer = await Promise.all(
    containers.map(async (c) => {
      const owner = (c.Names?.[0] ?? c.Id).replace(/^\//, '');
      const claims: PortClaim[] = (c.Ports ?? [])
        .filter((p) => typeof p.PublicPort === 'number' && p.PublicPort > 0)
        .map((p) => ({ port: p.PublicPort, proto: p.Type === 'udp' ? 'udp' : 'tcp', owner }));
      if (c.State === 'running') return claims;
      // A stopped container lists no published ports, but starting it again
      // binds whatever its HostConfig asks for.
      try {
        const info = await docker.getContainer(c.Id).inspect();
        return [...claims, ...claimsFromPortBindings(info.HostConfig?.PortBindings, owner)];
      } catch {
        // Removed between the listing and the inspect: it claims nothing.
        return claims;
      }
    }),
  );
  return perContainer.flat();
}

/** Ports the registry entries own on the host. */
export function registryPortClaims(servers: ServerInstance[]): PortClaim[] {
  return servers.flatMap((s) => {
    const owner = `server:${s.id}`;
    const claims: PortClaim[] = [{ port: s.network.serverPort, proto: 'udp', owner }];
    // Entries from before the publish switch always published their map ports.
    if (s.network.publishWebMap !== false) {
      claims.push(
        { port: s.network.webMapPort, proto: 'tcp', owner },
        { port: s.network.webMapWsPort, proto: 'tcp', owner },
      );
    }
    return claims;
  });
}

const claimKey = (port: number, proto: PortProto) => `${proto}:${port}`;

/**
 * Pick the ports for a new instance. Explicit ports are checked against the
 * claims and reported as conflicts, never moved; missing ones are the first
 * free ports from the defaults upwards. Without explicit map ports nothing is
 * published for the map: EasyWebMap then listens on its default ports inside
 * the container and the panel reaches it over the stack network.
 */
export function allocatePorts(request: PortRequest, claims: PortClaim[]): PortAllocation {
  const taken = new Map<string, string>();
  for (const c of claims) {
    if (!taken.has(claimKey(c.port, c.proto))) taken.set(claimKey(c.port, c.proto), c.owner);
  }
  const publishWebMap = request.webMapPort !== undefined || request.webMapWsPort !== undefined;
  const explicit: Array<{ field: keyof PortRequest; port: number; proto: PortProto }> = [];
  if (request.serverPort !== undefined) {
    explicit.push({ field: 'serverPort', port: request.serverPort, proto: 'udp' });
  }
  if (request.webMapPort !== undefined) {
    explicit.push({ field: 'webMapPort', port: request.webMapPort, proto: 'tcp' });
  }
  if (request.webMapWsPort !== undefined) {
    explicit.push({ field: 'webMapWsPort', port: request.webMapWsPort, proto: 'tcp' });
  }

  const conflicts: PortConflict[] = [];
  for (const e of explicit) {
    const owner = taken.get(claimKey(e.port, e.proto));
    if (owner) conflicts.push({ ...e, owner });
  }
  if (conflicts.length > 0) return { ok: false, code: 'conflict', conflicts };
  // Explicit ports first, so a generated port never lands on one of them.
  for (const e of explicit) taken.set(claimKey(e.port, e.proto), 'new server');

  const firstFree = (from: number, to: number, proto: PortProto): number | null => {
    for (let p = from; p <= to; p++) {
      if (!taken.has(claimKey(p, proto))) {
        taken.set(claimKey(p, proto), 'new server');
        return p;
      }
    }
    return null;
  };

  const serverPort = request.serverPort ?? firstFree(GAME_PORT_BASE, GAME_PORT_MAX, 'udp');
  if (serverPort === null) return { ok: false, code: 'exhausted', field: 'serverPort' };
  if (!publishWebMap) {
    return {
      ok: true,
      ports: {
        serverPort,
        webMapPort: WEBMAP_PORT_DEFAULT,
        webMapWsPort: WEBMAP_WS_PORT_DEFAULT,
        publishWebMap: false,
      },
    };
  }
  // A map port given alone gets its neighbour for the other one when that is
  // free (like 18081/18082), else the next free one above.
  const near = (preferred: number) =>
    firstFree(preferred, PORT_MAX, 'tcp') ?? firstFree(WEBMAP_PORT_DEFAULT, PORT_MAX, 'tcp');
  const webMapPort =
    request.webMapPort ??
    near(
      request.webMapWsPort !== undefined
        ? Math.max(request.webMapWsPort - 1, 1024)
        : WEBMAP_PORT_DEFAULT,
    );
  if (webMapPort === null) return { ok: false, code: 'exhausted', field: 'webMapPort' };
  const webMapWsPort = request.webMapWsPort ?? near(webMapPort + 1);
  if (webMapWsPort === null) return { ok: false, code: 'exhausted', field: 'webMapWsPort' };
  return { ok: true, ports: { serverPort, webMapPort, webMapWsPort, publishWebMap: true } };
}

/** {@link allocatePorts} against the live Docker claims plus the registry. */
export async function allocateInstancePorts(
  request: PortRequest,
  servers: ServerInstance[],
  dockerOverride?: Docker,
): Promise<PortAllocation> {
  let dockerClaims: PortClaim[] = [];
  if (!isDemoMode()) {
    try {
      dockerClaims = await listDockerPortClaims(dockerOverride ?? getDockerInstance());
    } catch (err) {
      // Without the Docker view a "free" port is a guess; refuse instead.
      return {
        ok: false,
        code: 'docker_unavailable',
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }
  return allocatePorts(request, [...dockerClaims, ...registryPortClaims(servers)]);
}

let lockTail: Promise<unknown> = Promise.resolve();

/**
 * Run `fn` while no other caller allocates ports or reconciles instances.
 * Covers the whole create (allocation, registry write, container create), so
 * two concurrent requests cannot pick the same free port.
 */
export function withPortLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = lockTail.then(fn, fn);
  lockTail = run.catch(() => undefined);
  return run;
}
