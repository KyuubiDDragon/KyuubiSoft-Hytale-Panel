import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import path from 'path';
import os from 'os';
import fs from 'fs';

// Route MANAGER_DATA_PATH to a temp dir before importing the modules that
// touch servers.json (services/servers.ts uses it eagerly). STACK_NAME and
// HOST_DATA_PATH are also captured at module-load time inside
// dockerImageManager.ts, so they must be set BEFORE the dynamic import below.
const tmpDir = path.join(os.tmpdir(), `kp-dim-${Date.now()}`);
fs.mkdirSync(tmpDir, { recursive: true });
process.env.MANAGER_DATA_PATH = tmpDir;
process.env.STACK_NAME = 'kptest';
process.env.HOST_DATA_PATH = '/srv/test';
delete process.env.HYTALE_IMAGE;
delete process.env.DEMO_MODE;

import type {
  createInstanceContainer as CreateFn,
  deleteInstanceContainer as DeleteFn,
  __test__ as TestHelpers,
} from './dockerImageManager.js';
import type { ServerInstance } from './servers.js';

// Dynamic import after env setup. Vitest hoists `vi.mock` but not regular
// imports, so this is the most reliable way to control module-init order.
let createInstanceContainer: typeof CreateFn;
let deleteInstanceContainer: typeof DeleteFn;
let __test__: typeof TestHelpers;
beforeAll(async () => {
  const mod = await import('./dockerImageManager.js');
  createInstanceContainer = mod.createInstanceContainer;
  deleteInstanceContainer = mod.deleteInstanceContainer;
  __test__ = mod.__test__;
});

function makeInstance(overrides: Partial<ServerInstance> = {}): ServerInstance {
  return {
    id: 'abc12345',
    name: 'Test Server',
    containerName: 'hytale-srv-abc12345',
    status: 'creating',
    network: { serverPort: 5521, webMapPort: 18091, webMapWsPort: 18092, pluginPort: 18095 },
    paths: {
      server: '/opt/hytale-instances/abc12345/server',
      data: '/opt/hytale-instances/abc12345/data',
      backups: '/opt/hytale-instances/abc12345/backups',
      mods: '/opt/hytale-instances/abc12345/mods',
      plugins: '/opt/hytale-instances/abc12345/plugins',
      assets: '/opt/hytale-instances/abc12345/assets',
      auth: '/opt/hytale-instances/abc12345/auth',
    },
    createdAt: new Date().toISOString(),
    createdBy: 'tester',
    ...overrides,
  };
}

describe('dockerImageManager helpers', () => {
  it('resolves image from STACK_NAME by default', () => {
    expect(__test__.resolveImage()).toBe('kptest-hytale');
  });

  it('honours explicit image override', () => {
    expect(__test__.resolveImage('custom:tag')).toBe('custom:tag');
  });

  it('builds host bind mounts under HOST_DATA_PATH/instances/<id>', () => {
    const binds = __test__.buildBinds(makeInstance());
    // Every bind should map a host path under /srv/test/instances/abc12345
    // to the canonical /opt/hytale/<sub> targets the upstream image expects.
    expect(binds).toContain('/srv/test/instances/abc12345/server:/opt/hytale/server');
    expect(binds).toContain('/srv/test/instances/abc12345/data:/opt/hytale/data');
    expect(binds).toContain('/srv/test/instances/abc12345/backups:/opt/hytale/backups');
    expect(binds).toContain('/srv/test/instances/abc12345/mods:/opt/hytale/mods');
    expect(binds).toContain('/srv/test/instances/abc12345/plugins:/opt/hytale/plugins');
    expect(binds).toContain('/srv/test/instances/abc12345/assets:/opt/hytale/assets');
    expect(binds).toContain('/srv/test/instances/abc12345/auth:/opt/hytale/auth');
  });

  it('uses UDP for the game port and TCP for everything else', () => {
    const bindings = __test__.buildPortBindings(makeInstance());
    expect(bindings['5521/udp']).toEqual([{ HostPort: '5521' }]);
    expect(bindings['18091/tcp']).toEqual([{ HostPort: '18091' }]);
    expect(bindings['18092/tcp']).toEqual([{ HostPort: '18092' }]);
    expect(bindings['18095/tcp']).toEqual([{ HostPort: '18095' }]);
  });

  it('builds a HostConfig with on-failure:3 restart and the four needed caps', () => {
    const opts = __test__.buildCreateOptions(makeInstance(), 'kptest-hytale');
    expect(opts.name).toBe('hytale-srv-abc12345');
    expect(opts.Image).toBe('kptest-hytale');
    expect(opts.HostConfig?.RestartPolicy).toEqual({ Name: 'on-failure', MaximumRetryCount: 3 });
    expect(opts.HostConfig?.CapDrop).toEqual(['ALL']);
    expect(opts.HostConfig?.CapAdd).toEqual(['CHOWN', 'SETUID', 'SETGID', 'DAC_OVERRIDE']);
    expect(opts.HostConfig?.NetworkMode).toBe('kptest-net');
    expect(opts.HostConfig?.SecurityOpt).toContain('no-new-privileges:true');
    expect(opts.Labels?.['kyuubisoft.panel.server-id']).toBe('abc12345');
  });

  it('keeps stdin open without a TTY and gives the server time to save on stop', () => {
    const opts = __test__.buildCreateOptions(makeInstance(), 'kptest-hytale');
    expect(opts.OpenStdin).toBe(true);
    expect(opts.Tty).toBe(false);
    expect(opts.StopTimeout).toBeGreaterThanOrEqual(120);
  });
});

describe('createInstanceContainer', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns a clear error when the image is missing locally', async () => {
    const inspect = vi.fn().mockRejectedValue(new Error('image not found'));
    const getImage = vi.fn().mockReturnValue({ inspect });
    const createContainer = vi.fn();
    const fakeDocker = { getImage, createContainer } as never;

    const result = await createInstanceContainer(makeInstance(), {}, fakeDocker);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/not found locally/);
    }
    expect(createContainer).not.toHaveBeenCalled();
  });

  it('calls createContainer with the expected HostConfig and skips start when autoStart is false', async () => {
    const inspect = vi.fn().mockResolvedValue({});
    const getImage = vi.fn().mockReturnValue({ inspect });
    const startSpy = vi.fn();
    const created = { id: 'deadbeef0000', start: startSpy };
    const createContainer = vi.fn().mockResolvedValue(created);
    const fakeDocker = { getImage, createContainer } as never;

    const result = await createInstanceContainer(makeInstance(), { autoStart: false }, fakeDocker);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.containerId).toBe('deadbeef0000');
      expect(result.started).toBe(false);
    }
    expect(startSpy).not.toHaveBeenCalled();
    expect(createContainer).toHaveBeenCalledOnce();

    const passed = createContainer.mock.calls[0][0] as {
      HostConfig?: { PortBindings?: Record<string, unknown> };
    };
    expect(passed.HostConfig?.PortBindings).toMatchObject({
      '5521/udp': [{ HostPort: '5521' }],
      '18091/tcp': [{ HostPort: '18091' }],
    });
  });

  it('starts the container when autoStart is true', async () => {
    const inspect = vi.fn().mockResolvedValue({});
    const getImage = vi.fn().mockReturnValue({ inspect });
    const startSpy = vi.fn().mockResolvedValue(undefined);
    const created = { id: 'feedface1111', start: startSpy };
    const createContainer = vi.fn().mockResolvedValue(created);
    const fakeDocker = { getImage, createContainer } as never;

    const result = await createInstanceContainer(makeInstance(), { autoStart: true }, fakeDocker);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.started).toBe(true);
    expect(startSpy).toHaveBeenCalledOnce();
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

  it('stops and removes a container carrying the panel labels for this server', async () => {
    const f = fakeDockerWith({ Id: 'c0ffee000001', Config: { Labels: ownLabels } });

    const result = await deleteInstanceContainer(makeInstance(), {}, f.docker);
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

    const result = await deleteInstanceContainer(makeInstance(), { whileStopped }, f.docker);
    expect(result.ok).toBe(true);
    expect(order).toEqual(['stopped', 'remove']);
    expect(f.stop).not.toHaveBeenCalled();
  });

  it('reports stop_failed and removes nothing when whileStopped cannot stop the server', async () => {
    const f = fakeDockerWith({ Id: 'c0ffee000003', Config: { Labels: ownLabels } });
    const whileStopped = vi.fn(async () => {
      throw new Error('Another server operation (stop, start, rollback, restore) is running.');
    });

    const result = await deleteInstanceContainer(makeInstance(), { whileStopped }, f.docker);
    expect(result).toMatchObject({ ok: false, code: 'stop_failed' });
    expect(f.remove).not.toHaveBeenCalled();
  });

  it("never calls whileStopped for a container that is not the panel's", async () => {
    const f = fakeDockerWith({ Id: 'f0e1gn000002', Config: { Labels: {} } });
    const whileStopped = vi.fn(async (remove: () => Promise<void>) => remove());

    const result = await deleteInstanceContainer(makeInstance(), { whileStopped }, f.docker);
    expect(result).toMatchObject({ ok: false, code: 'not_managed' });
    expect(whileStopped).not.toHaveBeenCalled();
  });

  it('refuses a container without the panel labels and leaves it untouched', async () => {
    const f = fakeDockerWith({
      Id: 'f0e1gn000001',
      Config: { Labels: { 'com.docker.compose.service': 'manager' } },
    });

    const result = await deleteInstanceContainer(makeInstance(), {}, f.docker);
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

    const result = await deleteInstanceContainer(makeInstance(), {}, f.docker);
    expect(result).toMatchObject({ ok: false, code: 'not_managed' });
    expect(f.remove).not.toHaveBeenCalled();
  });

  it('treats an already-removed container as success', async () => {
    const f = fakeDockerWith(() =>
      Promise.reject(new Error('No such container: hytale-srv-abc12345')),
    );

    const result = await deleteInstanceContainer(makeInstance(), {}, f.docker);
    expect(result.ok).toBe(true);
    expect(f.remove).not.toHaveBeenCalled();
  });

  it('reports a docker error without removing anything', async () => {
    const f = fakeDockerWith(() =>
      Promise.reject(new Error('connect ECONNREFUSED /var/run/docker.sock')),
    );

    const result = await deleteInstanceContainer(makeInstance(), {}, f.docker);
    expect(result).toMatchObject({ ok: false, code: 'docker_error' });
    expect(f.remove).not.toHaveBeenCalled();
  });
});
