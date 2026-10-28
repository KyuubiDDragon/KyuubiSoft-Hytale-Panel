import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import path from 'path';
import os from 'os';
import fs from 'fs';

// Route MANAGER_DATA_PATH to a temp dir before importing the modules that
// touch servers.json (services/servers.ts uses it eagerly). STACK_NAME,
// HOST_DATA_PATH and GAME_CONTAINER_NAME are also captured at module-load
// time, so they must be set BEFORE the dynamic import below.
const tmpDir = path.join(os.tmpdir(), `kp-dim-${Date.now()}`);
fs.mkdirSync(tmpDir, { recursive: true });
process.env.MANAGER_DATA_PATH = tmpDir;
process.env.STACK_NAME = 'kptest';
process.env.HOST_DATA_PATH = '/srv/test';
process.env.GAME_CONTAINER_NAME = 'kptest';
delete process.env.HYTALE_IMAGE;
delete process.env.WEBMAP_BIND;
delete process.env.DEMO_MODE;

import type * as DimModule from './dockerImageManager.js';
import type * as ServersModule from './servers.js';
import type { ServerInstance } from './servers.js';

// Dynamic import after env setup. Vitest hoists `vi.mock` but not regular
// imports, so this is the most reliable way to control module-init order.
let dim: typeof DimModule;
let servers: typeof ServersModule;
beforeAll(async () => {
  dim = await import('./dockerImageManager.js');
  servers = await import('./servers.js');
});

afterEach(() => {
  delete process.env.HYTALE_IMAGE;
  delete process.env.WEBMAP_BIND;
});

function makeInstance(overrides: Partial<ServerInstance> = {}): ServerInstance {
  return {
    id: 'abc12345',
    name: 'Test Server',
    containerName: 'hytale-srv-abc12345',
    status: 'creating',
    network: { serverPort: 5521, webMapPort: 18081, webMapWsPort: 18082, publishWebMap: false },
    paths: {
      server: '/opt/hytale-instances/abc12345/server',
      data: '/opt/hytale-instances/abc12345/data',
      backups: '/opt/hytale-instances/abc12345/backups',
      mods: '/opt/hytale-instances/abc12345/mods',
      plugins: '/opt/hytale-instances/abc12345/plugins',
      assets: '/opt/hytale-instances/abc12345/assets',
      auth: '/opt/hytale-instances/abc12345/auth',
    },
    hostRoot: '/srv/test/instances/abc12345',
    createdAt: new Date().toISOString(),
    createdBy: 'tester',
    ...overrides,
  };
}

function makeTemplate(
  overrides: Partial<DimModule.InstanceTemplate> = {},
): DimModule.InstanceTemplate {
  return {
    image: 'kptest-hytale',
    network: 'kptest-net',
    env: { JAVA_MAX_RAM: '4G', USE_HYTALE_DOWNLOADER: 'true' },
    limits: { memory: 8 * 1024 ** 3, memoryReservation: 4 * 1024 ** 3, cpus: 4 },
    webMapBindIp: '',
    warnings: [],
    ...overrides,
  };
}

/** What `docker inspect` returns for the compose stack's game container. */
function primaryInfo(overrides: Record<string, unknown> = {}) {
  return {
    Id: 'primary000001',
    Image: 'sha256:primaryimage',
    Config: {
      Image: 'kptest-hytale',
      Env: [
        'PATH=/usr/local/bin:/usr/bin',
        'JAVA_MAX_RAM=6G',
        'JAVA_MIN_RAM=3G',
        'SERVER_BIND=0.0.0.0',
        'TZ=Europe/Berlin',
        'USE_HYTALE_DOWNLOADER=true',
        'HYTALE_PATCHLINE=pre-release',
        'AUTH_MODE=',
        'HYTALE_AUTH_KEY_FILE=/run/secrets/auth-key',
        'SERVER_JAR_URL=https://user:secret@nas.local/HytaleServer.jar',
        'ASSETS_URL=https://user:secret@nas.local/Assets.zip',
        'EXTRA_JAVA_ARGS=-Dtoken=abc',
        'KYUUBISOFT_API_TOKEN=primary-token',
      ],
    },
    HostConfig: {
      NetworkMode: 'kptest-net',
      Memory: 8 * 1024 ** 3,
      MemoryReservation: 6 * 1024 ** 3,
      NanoCpus: 4e9,
    },
    NetworkSettings: { Networks: { 'kptest-net': {} } },
    ...overrides,
  };
}

/** Fake Docker for the template lookup: containers by name, images and networks by set. */
function templateDocker(opts: {
  primary?: unknown;
  /** Local images: refs (own id) or ref → image id. */
  images?: string[] | Record<string, string>;
  networks?: string[];
}) {
  const images = new Map<string, string>(
    Array.isArray(opts.images)
      ? opts.images.map((ref) => [ref, ref])
      : Object.entries(opts.images ?? {}),
  );
  const networks = new Set(opts.networks ?? []);
  return {
    getContainer: vi.fn((name: string) => ({
      inspect: vi.fn(async () => {
        if (name === 'kptest' && opts.primary) return opts.primary;
        throw new Error(`No such container: ${name}`);
      }),
    })),
    getImage: vi.fn((ref: string) => ({
      inspect: vi.fn(async () => {
        if (images.has(ref)) return { Id: images.get(ref) };
        throw new Error(`No such image: ${ref}`);
      }),
    })),
    getNetwork: vi.fn((name: string) => ({
      inspect: vi.fn(async () => {
        if (networks.has(name)) return {};
        throw new Error(`network ${name} not found`);
      }),
    })),
  };
}

describe('container create options', () => {
  it('binds every instance folder below the host root', () => {
    const binds = dim.__test__.buildBinds(makeInstance());
    expect(binds).toEqual(
      dim.INSTANCE_DIRS.map((d) => `/srv/test/instances/abc12345/${d}:/opt/hytale/${d}`),
    );
    // The folders that used to land in anonymous volumes.
    for (const d of ['prefabs', 'downloader', 'updater']) {
      expect(binds).toContain(`/srv/test/instances/abc12345/${d}:/opt/hytale/${d}`);
    }
  });

  it('falls back to HOST_DATA_PATH/instances/<id> without a host root', () => {
    const binds = dim.__test__.buildBinds(makeInstance({ hostRoot: undefined }));
    expect(binds[0]).toBe('/srv/test/instances/abc12345/server:/opt/hytale/server');
  });

  it('publishes only the game port unless the map is asked for, and never the plugin port', () => {
    const quiet = dim.__test__.buildPortBindings(makeInstance(), '');
    expect(quiet).toEqual({ '5521/udp': [{ HostPort: '5521' }] });

    const map = dim.__test__.buildPortBindings(
      makeInstance({
        network: { serverPort: 5521, webMapPort: 18091, webMapWsPort: 18092, publishWebMap: true },
      }),
      '127.0.0.1',
    );
    expect(map).toEqual({
      '5521/udp': [{ HostPort: '5521' }],
      '18091/tcp': [{ HostIp: '127.0.0.1', HostPort: '18091' }],
      '18092/tcp': [{ HostIp: '127.0.0.1', HostPort: '18092' }],
    });
    expect(Object.keys(map).some((k) => k.startsWith('18085'))).toBe(false);
  });

  it('keeps publishing the map for entries from before the publish switch', () => {
    const legacy = makeInstance({
      network: { serverPort: 5521, webMapPort: 18091, webMapWsPort: 18092 },
    });
    expect(Object.keys(dim.__test__.buildPortBindings(legacy, ''))).toEqual([
      '5521/udp',
      '18091/tcp',
      '18092/tcp',
    ]);
  });

  it('takes limits, log rotation, labels and the security posture into the HostConfig', () => {
    const opts = dim.__test__.buildCreateOptions(makeInstance(), makeTemplate());
    expect(opts.name).toBe('hytale-srv-abc12345');
    expect(opts.Image).toBe('kptest-hytale');
    expect(opts.ExposedPorts).toEqual({ '5521/udp': {} });
    expect(opts.HostConfig).toMatchObject({
      Memory: 8 * 1024 ** 3,
      MemoryReservation: 4 * 1024 ** 3,
      NanoCpus: 4e9,
      LogConfig: { Type: 'json-file', Config: { 'max-size': '50m', 'max-file': '5' } },
      RestartPolicy: { Name: 'on-failure', MaximumRetryCount: 3 },
      CapDrop: ['ALL'],
      CapAdd: ['CHOWN', 'SETUID', 'SETGID', 'DAC_OVERRIDE'],
      SecurityOpt: ['no-new-privileges:true'],
      NetworkMode: 'kptest-net',
    });
    expect(opts.NetworkingConfig?.EndpointsConfig).toEqual({ 'kptest-net': {} });
    expect(opts.Labels).toEqual({
      'kyuubisoft.panel.managed': 'true',
      'kyuubisoft.panel.server-id': 'abc12345',
      'kyuubisoft.panel.server-name': 'Test Server',
      'kyuubisoft.panel.primary': 'kptest',
    });
  });

  it("lets the instance's own limits win and drops a reservation above the new limit", () => {
    const opts = dim.__test__.buildCreateOptions(
      makeInstance({ limits: { memory: 3 * 1024 ** 3, cpus: 1.5 } }),
      makeTemplate(),
    );
    expect(opts.HostConfig?.Memory).toBe(3 * 1024 ** 3);
    expect(opts.HostConfig?.NanoCpus).toBe(1.5e9);
    expect(opts.HostConfig?.MemoryReservation).toBeUndefined();
  });

  it('sets no limits when neither the primary nor the instance has any', () => {
    const opts = dim.__test__.buildCreateOptions(makeInstance(), makeTemplate({ limits: {} }));
    expect(opts.HostConfig).not.toHaveProperty('Memory');
    expect(opts.HostConfig).not.toHaveProperty('NanoCpus');
  });

  it('keeps stdin open without a TTY and gives the server time to save on stop', () => {
    const opts = dim.__test__.buildCreateOptions(makeInstance(), makeTemplate());
    expect(opts.OpenStdin).toBe(true);
    expect(opts.Tty).toBe(false);
    expect(opts.StopTimeout).toBeGreaterThanOrEqual(120);
  });

  it("builds the environment from the inherited settings and the instance's own values", () => {
    const env = dim.__test__.buildEnv(
      makeInstance(),
      makeTemplate({ env: { JAVA_MAX_RAM: '6G', TZ: 'UTC', SERVER_PORT: '5520' } }),
      'instance-token',
    );
    expect(env).toEqual(
      expect.arrayContaining([
        'JAVA_MAX_RAM=6G',
        'TZ=UTC',
        'SERVER_PORT=5521',
        'WEBMAP_PORT=18081',
        'WEBMAP_WS_PORT=18082',
        'ENABLE_BACKUP=false',
        'KYUUBISOFT_API_TOKEN=instance-token',
      ]),
    );
    expect(env.filter((e) => e.startsWith('SERVER_PORT='))).toEqual(['SERVER_PORT=5521']);
  });
});

describe('inherited environment', () => {
  it('copies only allowlisted, non-empty variables of the primary', () => {
    const env = dim.__test__.inheritEnv(primaryInfo() as never);
    expect(env).toEqual({
      JAVA_MAX_RAM: '6G',
      JAVA_MIN_RAM: '3G',
      SERVER_BIND: '0.0.0.0',
      TZ: 'Europe/Berlin',
      USE_HYTALE_DOWNLOADER: 'true',
      HYTALE_PATCHLINE: 'pre-release',
    });
    for (const secret of [
      'HYTALE_AUTH_KEY_FILE',
      'SERVER_JAR_URL',
      'ASSETS_URL',
      'EXTRA_JAVA_ARGS',
      'KYUUBISOFT_API_TOKEN',
      'PATH',
    ]) {
      expect(env).not.toHaveProperty(secret);
    }
  });

  it('reads CPU limits from NanoCpus or from quota and period', () => {
    expect(dim.__test__.primaryLimits(primaryInfo() as never)).toEqual({
      memory: 8 * 1024 ** 3,
      memoryReservation: 6 * 1024 ** 3,
      cpus: 4,
    });
    const quota = primaryInfo({ HostConfig: { CpuQuota: 150000, CpuPeriod: 100000 } });
    expect(dim.__test__.primaryLimits(quota as never)).toEqual({
      memory: undefined,
      memoryReservation: undefined,
      cpus: 1.5,
    });
  });
});

describe('resolveInstanceTemplate', () => {
  it("uses the primary container's image, network, limits and settings", async () => {
    const docker = templateDocker({
      primary: primaryInfo(),
      images: {
        'sha256:primaryimage': 'sha256:primaryimage',
        'kptest-hytale': 'sha256:primaryimage',
      },
    });
    const result = await dim.resolveInstanceTemplate(docker as never);
    expect(result).toMatchObject({
      ok: true,
      template: {
        image: 'sha256:primaryimage',
        imageName: 'kptest-hytale',
        network: 'kptest-net',
        limits: { memory: 8 * 1024 ** 3, cpus: 4 },
        env: { JAVA_MAX_RAM: '6G' },
        warnings: [],
      },
    });
  });

  it('keeps the image the primary runs when its tag moved on to another build', async () => {
    const docker = templateDocker({
      primary: primaryInfo(),
      images: {
        'sha256:primaryimage': 'sha256:primaryimage',
        'kptest-hytale': 'sha256:newerbuild',
      },
    });
    const result = await dim.resolveInstanceTemplate(docker as never);
    expect(result.ok && result.template.image).toBe('sha256:primaryimage');
    expect(result.ok && result.template.imageName).toBeUndefined();
  });

  it("falls back to the primary's tag when its image id is not available", async () => {
    const docker = templateDocker({ primary: primaryInfo(), images: ['kptest-hytale'] });
    const result = await dim.resolveInstanceTemplate(docker as never);
    expect(result.ok && result.template.image).toBe('kptest-hytale');
  });

  it('prefers the stack network when the primary is on several', async () => {
    const primary = primaryInfo({
      HostConfig: { NetworkMode: 'traefik' },
      NetworkSettings: { Networks: { traefik: {}, 'kptest-net': {} } },
    });
    const docker = templateDocker({ primary, images: ['kptest-hytale'] });
    const result = await dim.resolveInstanceTemplate(docker as never);
    expect(result.ok && result.template.network).toBe('kptest-net');
  });

  it('lets HYTALE_IMAGE override the image, and fails clearly when it is missing', async () => {
    process.env.HYTALE_IMAGE = 'custom/hytale:1';
    const ok = await dim.resolveInstanceTemplate(
      templateDocker({
        primary: primaryInfo(),
        images: ['custom/hytale:1', 'kptest-hytale'],
      }) as never,
    );
    expect(ok.ok && ok.template.image).toBe('custom/hytale:1');

    const missing = await dim.resolveInstanceTemplate(
      templateDocker({ primary: primaryInfo(), images: ['kptest-hytale'] }) as never,
    );
    expect(missing).toEqual({
      ok: false,
      error: expect.stringMatching(/HYTALE_IMAGE "custom\/hytale:1" is not available locally/),
    });
  });

  it('falls back to the compose tag and stack network without a primary, with a warning', async () => {
    const docker = templateDocker({ images: ['kptest_hytale'], networks: ['kptest-net'] });
    const result = await dim.resolveInstanceTemplate(docker as never);
    expect(result).toMatchObject({
      ok: true,
      template: { image: 'kptest_hytale', network: 'kptest-net', env: {}, limits: {} },
    });
    expect(result.ok && result.template.warnings[0]).toMatch(/could not be inspected/);
  });

  it('names what to fix when no image can be found', async () => {
    const result = await dim.resolveInstanceTemplate(templateDocker({}) as never);
    expect(result).toEqual({
      ok: false,
      error: expect.stringMatching(
        /Cannot determine the game server image.*GAME_CONTAINER_NAME.*HYTALE_IMAGE/,
      ),
    });
  });

  it('refuses a primary in host network mode', async () => {
    const primary = primaryInfo({
      HostConfig: { NetworkMode: 'host' },
      NetworkSettings: { Networks: { host: {} } },
    });
    const result = await dim.resolveInstanceTemplate(
      templateDocker({ primary, images: ['kptest-hytale'] }) as never,
    );
    expect(result).toEqual({ ok: false, error: expect.stringMatching(/host networking/) });
  });

  it('refuses a WEBMAP_BIND that is not an IP address', async () => {
    process.env.WEBMAP_BIND = 'localhost';
    const result = await dim.resolveInstanceTemplate(
      templateDocker({ primary: primaryInfo(), images: ['kptest-hytale'] }) as never,
    );
    expect(result).toEqual({ ok: false, error: 'WEBMAP_BIND "localhost" is not an IP address' });
  });
});

describe('checkHeapFitsLimit', () => {
  it('rejects a limit that leaves the heap no room', () => {
    expect(dim.checkHeapFitsLimit('4G', 4 * 1024 ** 3)).toMatch(/leaves no room for the 4G heap/);
    expect(dim.checkHeapFitsLimit('4G', 6 * 1024 ** 3)).toBeNull();
  });

  it("checks against the image's default heap when none is set", () => {
    expect(dim.checkHeapFitsLimit(undefined, 2 * 1024 ** 3)).toMatch(/4G heap/);
  });
});

describe('createInstanceContainer', () => {
  beforeEach(() => vi.clearAllMocks());

  async function registered() {
    return servers.createServerInstance({ name: 'Created', createdBy: 'tester' });
  }

  it('marks the entry broken and creates nothing when the template cannot be resolved', async () => {
    const instance = await registered();
    const createContainer = vi.fn();
    const docker = { ...templateDocker({}), createContainer };

    const result = await dim.createInstanceContainer(instance, {}, docker as never);
    expect(result).toMatchObject({ ok: false, code: 'template' });
    expect(createContainer).not.toHaveBeenCalled();
    expect((await servers.getServer(instance.id))?.status).toBe('broken');
  });

  it('creates the container from the template and records the image', async () => {
    const instance = await registered();
    const start = vi.fn();
    const createContainer = vi.fn().mockResolvedValue({ id: 'deadbeef0000', start });

    const result = await dim.createInstanceContainer(
      instance,
      { autoStart: false, template: makeTemplate() },
      { createContainer } as never,
    );
    expect(result).toEqual({
      ok: true,
      containerId: 'deadbeef0000',
      started: false,
      image: 'kptest-hytale',
      warnings: [],
    });
    expect(start).not.toHaveBeenCalled();
    const passed = createContainer.mock.calls[0][0] as { HostConfig?: Record<string, unknown> };
    expect(passed.HostConfig?.Memory).toBe(8 * 1024 ** 3);
    const stored = await servers.getServer(instance.id);
    expect(stored).toMatchObject({ status: 'ready', image: 'kptest-hytale' });
  });

  it('starts the container when autoStart is true', async () => {
    const instance = await registered();
    const start = vi.fn().mockResolvedValue(undefined);
    const createContainer = vi.fn().mockResolvedValue({ id: 'feedface1111', start });

    const result = await dim.createInstanceContainer(
      instance,
      { autoStart: true, template: makeTemplate() },
      { createContainer } as never,
    );
    expect(result.ok && result.started).toBe(true);
    expect(start).toHaveBeenCalledOnce();
  });

  it('reports a failed start and leaves the entry broken', async () => {
    const instance = await registered();
    const start = vi.fn().mockRejectedValue(new Error('port is already allocated'));
    const createContainer = vi.fn().mockResolvedValue({ id: 'feedface2222', start });

    const result = await dim.createInstanceContainer(
      instance,
      { autoStart: true, template: makeTemplate() },
      { createContainer } as never,
    );
    expect(result).toEqual({
      ok: false,
      code: 'start',
      error: 'Container created but start failed: port is already allocated',
    });
    expect((await servers.getServer(instance.id))?.status).toBe('broken');
  });

  it('reports a refused create', async () => {
    const instance = await registered();
    const createContainer = vi
      .fn()
      .mockRejectedValue(new Error('Conflict. The container name is already in use'));

    const result = await dim.createInstanceContainer(instance, { template: makeTemplate() }, {
      createContainer,
    } as never);
    expect(result).toMatchObject({ ok: false, code: 'create' });
    expect((await servers.getServer(instance.id))?.status).toBe('broken');
  });
});

describe('updateInstanceLimits', () => {
  const ownLabels = {
    'kyuubisoft.panel.managed': 'true',
    'kyuubisoft.panel.server-id': 'abc12345',
  };

  function limitsDocker(inspectResult: unknown) {
    const update = vi.fn().mockResolvedValue(undefined);
    const inspect =
      inspectResult instanceof Error
        ? vi.fn().mockRejectedValue(inspectResult)
        : vi.fn().mockResolvedValue(inspectResult);
    const getContainer = vi.fn(() => ({ inspect, update }));
    return { docker: { getContainer } as never, getContainer, update };
  }

  const own = (env: string[] = ['JAVA_MAX_RAM=2G']) => ({
    Id: 'own1',
    Config: { Labels: ownLabels, Env: env },
    HostConfig: { MemoryReservation: 6 * 1024 ** 3 },
  });

  it("updates the panel's own container without a restart", async () => {
    const f = limitsDocker(own());
    const result = await dim.updateInstanceLimits(
      makeInstance(),
      { memory: 4 * 1024 ** 3, cpus: 2 },
      {},
      f.docker,
    );
    expect(result).toEqual({ ok: true });
    expect(f.getContainer).toHaveBeenLastCalledWith('own1');
    expect(f.update).toHaveBeenCalledWith({
      Memory: 4 * 1024 ** 3,
      MemorySwap: 8 * 1024 ** 3,
      MemoryReservation: 4 * 1024 ** 3,
      NanoCpus: 2e9,
    });
  });

  it("refuses a memory limit below the container's heap, and the panel setting wins", async () => {
    const byEnv = limitsDocker(own(['JAVA_MAX_RAM=6G']));
    expect(
      await dim.updateInstanceLimits(makeInstance(), { memory: 4 * 1024 ** 3 }, {}, byEnv.docker),
    ).toMatchObject({ ok: false, code: 'heap', error: expect.stringMatching(/6G heap/) });
    expect(byEnv.update).not.toHaveBeenCalled();

    const byPanel = limitsDocker(own(['JAVA_MAX_RAM=2G']));
    expect(
      await dim.updateInstanceLimits(
        makeInstance(),
        { memory: 4 * 1024 ** 3 },
        { panelMaxRam: '5G' },
        byPanel.docker,
      ),
    ).toMatchObject({ ok: false, code: 'heap', error: expect.stringMatching(/5G heap/) });
  });

  it('leaves a container without the panel labels untouched', async () => {
    const f = limitsDocker({ Id: 'foreign', Config: { Labels: {} }, HostConfig: {} });
    const result = await dim.updateInstanceLimits(makeInstance(), { cpus: 2 }, {}, f.docker);
    expect(result).toMatchObject({ ok: false, code: 'not_managed' });
    expect(f.update).not.toHaveBeenCalled();
  });

  it('reports a missing container', async () => {
    const f = limitsDocker(new Error('No such container: hytale-srv-abc12345'));
    const result = await dim.updateInstanceLimits(makeInstance(), { cpus: 2 }, {}, f.docker);
    expect(result).toMatchObject({ ok: false, code: 'not_found' });
  });
});

describe('deleteInstanceContainer', () => {
  beforeEach(() => vi.clearAllMocks());

  // One fake container answering both the by-name inspect and the by-id
  // stop/remove that follows it.
  function fakeDockerWith(inspectResult: unknown) {
    const inspect =
      typeof inspectResult === 'function'
        ? vi.fn(inspectResult as () => Promise<unknown>)
        : vi.fn().mockResolvedValue(inspectResult);
    const stop = vi.fn().mockResolvedValue(undefined);
    const remove = vi.fn().mockResolvedValue(undefined);
    const getContainer = vi.fn().mockReturnValue({ inspect, stop, remove });
    return { docker: { getContainer } as never, getContainer, inspect, stop, remove };
  }

  const ownLabels = {
    'kyuubisoft.panel.managed': 'true',
    'kyuubisoft.panel.server-id': 'abc12345',
  };

  it('stops and removes a container carrying the panel labels for this server, keeping volumes', async () => {
    const f = fakeDockerWith({ Id: 'c0ffee000001', Config: { Labels: ownLabels } });

    const result = await dim.deleteInstanceContainer(makeInstance(), {}, f.docker);
    expect(result.ok).toBe(true);
    expect(f.getContainer).toHaveBeenNthCalledWith(1, 'hytale-srv-abc12345');
    // The removal targets the inspected container id, not the name again.
    expect(f.getContainer).toHaveBeenNthCalledWith(2, 'c0ffee000001');
    // Without a lifecycle hook Docker uses the container's own StopTimeout (120 s), not 10 s.
    expect(f.stop).toHaveBeenCalledWith();
    expect(f.remove).toHaveBeenCalledWith({ force: true, v: false });
  });

  it('removes inside whileStopped instead of stopping the container itself', async () => {
    const f = fakeDockerWith({ Id: 'c0ffee000002', Config: { Labels: ownLabels } });
    const order: string[] = [];
    f.remove.mockImplementation(async () => {
      order.push('remove');
    });
    const whileStopped = vi.fn(async (remove: () => Promise<void>) => {
      order.push('stopped');
      await remove();
    });

    const result = await dim.deleteInstanceContainer(makeInstance(), { whileStopped }, f.docker);
    expect(result.ok).toBe(true);
    expect(order).toEqual(['stopped', 'remove']);
    expect(f.stop).not.toHaveBeenCalled();
  });

  it('reports stop_failed and removes nothing when whileStopped cannot stop the server', async () => {
    const f = fakeDockerWith({ Id: 'c0ffee000003', Config: { Labels: ownLabels } });
    const whileStopped = vi.fn(async () => {
      throw new Error('Another server operation (stop, start, rollback, restore) is running.');
    });

    const result = await dim.deleteInstanceContainer(makeInstance(), { whileStopped }, f.docker);
    expect(result).toMatchObject({ ok: false, code: 'stop_failed' });
    expect(f.remove).not.toHaveBeenCalled();
  });

  it("never calls whileStopped for a container that is not the panel's", async () => {
    const f = fakeDockerWith({ Id: 'f0e1gn000002', Config: { Labels: {} } });
    const whileStopped = vi.fn(async (remove: () => Promise<void>) => remove());

    const result = await dim.deleteInstanceContainer(makeInstance(), { whileStopped }, f.docker);
    expect(result).toMatchObject({ ok: false, code: 'not_managed' });
    expect(whileStopped).not.toHaveBeenCalled();
  });

  it('refuses a container without the panel labels and leaves it untouched', async () => {
    const f = fakeDockerWith({
      Id: 'f0e1gn000001',
      Config: { Labels: { 'com.docker.compose.service': 'manager' } },
    });

    const result = await dim.deleteInstanceContainer(makeInstance(), {}, f.docker);
    expect(result).toMatchObject({ ok: false, code: 'not_managed' });
    expect(f.stop).not.toHaveBeenCalled();
    expect(f.remove).not.toHaveBeenCalled();
  });

  it('refuses a panel-managed container that belongs to another server id', async () => {
    const f = fakeDockerWith({
      Id: 'other0000001',
      Config: {
        Labels: { 'kyuubisoft.panel.managed': 'true', 'kyuubisoft.panel.server-id': 'zzz99999' },
      },
    });

    const result = await dim.deleteInstanceContainer(makeInstance(), {}, f.docker);
    expect(result).toMatchObject({ ok: false, code: 'not_managed' });
    expect(f.remove).not.toHaveBeenCalled();
  });

  it('treats an already-removed container as success', async () => {
    const f = fakeDockerWith(() =>
      Promise.reject(new Error('No such container: hytale-srv-abc12345')),
    );

    const result = await dim.deleteInstanceContainer(makeInstance(), {}, f.docker);
    expect(result.ok).toBe(true);
    expect(f.remove).not.toHaveBeenCalled();
  });

  it('reports a docker error without removing anything', async () => {
    const f = fakeDockerWith(() =>
      Promise.reject(new Error('connect ECONNREFUSED /var/run/docker.sock')),
    );

    const result = await dim.deleteInstanceContainer(makeInstance(), {}, f.docker);
    expect(result).toMatchObject({ ok: false, code: 'docker_error' });
    expect(f.remove).not.toHaveBeenCalled();
  });
});
