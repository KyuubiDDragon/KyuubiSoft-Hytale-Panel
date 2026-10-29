/**
 * Host-port allocation for new instances: Docker's view of every container
 * (running ones from the listing, stopped ones from their HostConfig) plus
 * the registry, explicit ports reported as conflicts instead of being moved,
 * and map ports only published when asked for.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  allocateInstancePorts,
  allocatePorts,
  claimsFromPortBindings,
  listDockerPortClaims,
  registryPortClaims,
  withPortLock,
  GAME_PORT_MAX,
  type PortClaim,
} from './portAllocator.js';
import type { ServerInstance } from './servers.js';

delete process.env.DEMO_MODE;

function server(id: string, network: Partial<ServerInstance['network']> = {}): ServerInstance {
  return {
    id,
    name: id,
    containerName: `hytale-srv-${id}`,
    status: 'ready',
    network: { serverPort: 5520, webMapPort: 18081, webMapWsPort: 18082, ...network },
    paths: {
      server: `/opt/hytale-instances/${id}/server`,
      data: `/opt/hytale-instances/${id}/data`,
      backups: `/opt/hytale-instances/${id}/backups`,
      mods: `/opt/hytale-instances/${id}/mods`,
      plugins: `/opt/hytale-instances/${id}/plugins`,
      assets: `/opt/hytale-instances/${id}/assets`,
      auth: `/opt/hytale-instances/${id}/auth`,
    },
    createdAt: '2026-10-28T00:00:00.000Z',
    createdBy: 'tester',
  };
}

const claim = (port: number, proto: 'tcp' | 'udp', owner = 'other'): PortClaim => ({
  port,
  proto,
  owner,
});

describe('claimsFromPortBindings', () => {
  it('reads single ports, ranges and skips unpublished entries', () => {
    const claims = claimsFromPortBindings(
      {
        '5520/udp': [{ HostIp: '', HostPort: '5520' }],
        '18081/tcp': [{ HostIp: '127.0.0.1', HostPort: '18081' }],
        '7000/tcp': [{ HostPort: '7000-7002' }],
        '18085/tcp': null,
        '9000/tcp': [{ HostPort: '' }],
      },
      'c1',
    );
    expect(claims).toEqual([
      claim(5520, 'udp', 'c1'),
      claim(18081, 'tcp', 'c1'),
      claim(7000, 'tcp', 'c1'),
      claim(7001, 'tcp', 'c1'),
      claim(7002, 'tcp', 'c1'),
    ]);
  });

  it('ignores garbage', () => {
    expect(claimsFromPortBindings(undefined, 'x')).toEqual([]);
    expect(claimsFromPortBindings({ '1/tcp': [{ HostPort: 'abc' }] }, 'x')).toEqual([]);
    expect(claimsFromPortBindings({ '1/tcp': [{ HostPort: '70000' }] }, 'x')).toEqual([]);
  });
});

describe('listDockerPortClaims', () => {
  it('takes running containers from the listing and stopped ones from their HostConfig', async () => {
    const inspect = vi.fn(async () => ({
      HostConfig: { PortBindings: { '5521/udp': [{ HostPort: '5521' }] } },
    }));
    const docker = {
      listContainers: vi.fn(async () => [
        {
          Id: 'run1',
          Names: ['/other-stack'],
          State: 'running',
          Ports: [
            { IP: '0.0.0.0', PrivatePort: 5520, PublicPort: 5520, Type: 'udp' },
            { IP: '', PrivatePort: 18085, Type: 'tcp' },
          ],
        },
        { Id: 'stop1', Names: ['/stopped'], State: 'exited', Ports: [] },
      ]),
      getContainer: vi.fn(() => ({ inspect })),
    };

    const claims = await listDockerPortClaims(docker as never);
    expect(claims).toEqual([claim(5520, 'udp', 'other-stack'), claim(5521, 'udp', 'stopped')]);
    // Running containers need no inspect.
    expect(docker.getContainer).toHaveBeenCalledTimes(1);
    expect(docker.getContainer).toHaveBeenCalledWith('stop1');
  });

  it('skips a container that disappears between listing and inspect', async () => {
    const docker = {
      listContainers: vi.fn(async () => [
        { Id: 'gone', Names: ['/gone'], State: 'created', Ports: [] },
      ]),
      getContainer: vi.fn(() => ({
        inspect: vi.fn().mockRejectedValue(new Error('No such container')),
      })),
    };
    expect(await listDockerPortClaims(docker as never)).toEqual([]);
  });
});

describe('registryPortClaims', () => {
  it('counts map ports only for entries that publish them', () => {
    const claims = registryPortClaims([
      server('old'),
      server('new', { serverPort: 5521, publishWebMap: false }),
    ]);
    expect(claims).toEqual([
      claim(5520, 'udp', 'server:old'),
      claim(18081, 'tcp', 'server:old'),
      claim(18082, 'tcp', 'server:old'),
      claim(5521, 'udp', 'server:new'),
    ]);
  });
});

describe('allocatePorts', () => {
  it('picks the first free game port and keeps the map unpublished by default', () => {
    const result = allocatePorts({}, [claim(5520, 'udp'), claim(5521, 'udp'), claim(18081, 'tcp')]);
    expect(result).toEqual({
      ok: true,
      ports: { serverPort: 5522, webMapPort: 18081, webMapWsPort: 18082, publishWebMap: false },
    });
  });

  it('treats udp and tcp separately', () => {
    const result = allocatePorts({}, [claim(5520, 'tcp')]);
    expect(result.ok && result.ports.serverPort).toBe(5520);
  });

  it('reports an explicit port that is taken instead of moving it', () => {
    const result = allocatePorts({ serverPort: 5520, webMapPort: 18091 }, [
      claim(5520, 'udp', 'hytale'),
      claim(18091, 'tcp', 'other-stack'),
    ]);
    expect(result).toEqual({
      ok: false,
      code: 'conflict',
      conflicts: [
        { field: 'serverPort', port: 5520, proto: 'udp', owner: 'hytale' },
        { field: 'webMapPort', port: 18091, proto: 'tcp', owner: 'other-stack' },
      ],
    });
  });

  it('publishes the map when one map port is given and fills in the other around it', () => {
    const result = allocatePorts({ webMapPort: 18082 }, [claim(18083, 'tcp')]);
    expect(result).toEqual({
      ok: true,
      ports: { serverPort: 5520, webMapPort: 18082, webMapWsPort: 18084, publishWebMap: true },
    });
  });

  it('pairs a single map port with its neighbour', () => {
    expect(allocatePorts({ webMapPort: 26091 }, [])).toMatchObject({
      ok: true,
      ports: { webMapPort: 26091, webMapWsPort: 26092, publishWebMap: true },
    });
    expect(allocatePorts({ webMapWsPort: 26092 }, [])).toMatchObject({
      ok: true,
      ports: { webMapPort: 26091, webMapWsPort: 26092, publishWebMap: true },
    });
  });

  it('never generates a game port in the ephemeral range', () => {
    const taken: PortClaim[] = [];
    for (let p = 5520; p <= GAME_PORT_MAX; p++) taken.push(claim(p, 'udp'));
    expect(allocatePorts({}, taken)).toEqual({ ok: false, code: 'exhausted', field: 'serverPort' });
  });
});

describe('allocateInstancePorts', () => {
  it('refuses when Docker cannot be asked', async () => {
    const docker = { listContainers: vi.fn().mockRejectedValue(new Error('connect ENOENT')) };
    const result = await allocateInstancePorts({}, [], docker as never);
    expect(result).toMatchObject({
      ok: false,
      code: 'docker_unavailable',
      error: 'connect ENOENT',
    });
  });

  it('combines the Docker claims with the registry', async () => {
    const docker = {
      listContainers: vi.fn(async () => [
        { Id: 'a', Names: ['/a'], State: 'running', Ports: [{ PublicPort: 5520, Type: 'udp' }] },
      ]),
      getContainer: vi.fn(),
    };
    const result = await allocateInstancePorts(
      {},
      [server('b', { serverPort: 5521 })],
      docker as never,
    );
    expect(result.ok && result.ports.serverPort).toBe(5522);
  });
});

describe('withPortLock', () => {
  it('runs callers one after another, also after a failure', async () => {
    const order: string[] = [];
    let release!: () => void;
    const first = withPortLock(
      () =>
        new Promise<void>((resolve) => {
          order.push('first:start');
          release = () => {
            order.push('first:end');
            resolve();
          };
        }),
    );
    const failing = withPortLock(async () => {
      order.push('failing');
      throw new Error('boom');
    });
    const third = withPortLock(async () => {
      order.push('third');
    });
    await Promise.resolve();
    expect(order).toEqual(['first:start']);
    release();
    await first;
    await expect(failing).rejects.toThrow('boom');
    await third;
    expect(order).toEqual(['first:start', 'first:end', 'failing', 'third']);
  });
});
