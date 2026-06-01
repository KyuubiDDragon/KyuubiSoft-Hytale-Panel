/**
 * Centralized dockerode connection setup.
 *
 * By default the panel talks to the local Docker socket (/var/run/docker.sock).
 * That socket grants full control of the host's Docker daemon, so mounting it
 * into the manager container — even read-only — is a real privilege-escalation
 * surface (a `:ro` bind on the socket node does NOT restrict the Docker API).
 *
 * To shrink that blast radius, operators can put a hardened Docker-socket proxy
 * (e.g. tecnativa/docker-socket-proxy) in front of the real socket and point
 * the panel at it over TCP by setting:
 *
 *   DOCKER_HOST=tcp://docker-socket-proxy:2375
 *
 * The proxy is configured to allow only the handful of endpoints the panel
 * needs (containers list/inspect/start/stop/restart, exec) and deny everything
 * else. See the commented `docker-socket-proxy` service in docker-compose.yml.
 *
 * All Docker clients in the backend MUST be built through createDockerClient()
 * so this single switch governs every connection.
 */
import Docker from 'dockerode';

/** Resolve dockerode connection options from the environment. */
export function dockerOptions(): Docker.DockerOptions {
  const host = process.env.DOCKER_HOST?.trim();
  if (host && /^tcp:\/\//i.test(host)) {
    const url = new URL(host);
    return {
      host: url.hostname,
      port: url.port ? Number(url.port) : 2375,
      // Plain HTTP by default (the proxy sits on a private network); flip to
      // TLS when the operator has wired certs and set DOCKER_TLS_VERIFY=1.
      protocol: process.env.DOCKER_TLS_VERIFY === '1' ? 'https' : 'http',
    };
  }
  // Local Unix socket. DOCKER_SOCKET_PATH overrides for non-standard hosts
  // (rootless Docker, Podman); otherwise the well-known path.
  return { socketPath: dockerSocketPath() };
}

/** The Unix socket path the panel falls back to when DOCKER_HOST is unset. */
export function dockerSocketPath(): string {
  return process.env.DOCKER_SOCKET_PATH?.trim() || '/var/run/docker.sock';
}

/** True when connecting via TCP (e.g. through a socket proxy) instead of a local socket. */
export function isTcpDockerHost(): boolean {
  const host = process.env.DOCKER_HOST?.trim();
  return !!host && /^tcp:\/\//i.test(host);
}

/** Construct a dockerode client from the resolved connection options. */
export function createDockerClient(): Docker {
  return new Docker(dockerOptions());
}
