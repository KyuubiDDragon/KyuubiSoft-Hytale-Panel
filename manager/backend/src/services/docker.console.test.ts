/**
 * The console path into the game server: stdin attach only (the old
 * `docker exec` fallback reported success for commands that never arrived),
 * the attach-body quirk, and the narrow command set of the lifecycle.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
  stdinWrite: vi.fn(),
  containerExec: vi.fn(),
  attachFails: false,
  logs: Buffer.alloc(0),
}));

vi.mock('./dockerClient.js', () => ({
  createDockerClient: () => ({
    getContainer: () => ({
      inspect: async () => ({ State: { Running: true } }),
      attach: async () => {
        if (h.attachFails) throw new Error('attach refused');
        return { write: h.stdinWrite, on: () => undefined };
      },
      exec: h.containerExec,
      logs: async () => h.logs,
      top: async () => ({
        Titles: ['UID', 'PID', 'PPID', 'C', 'STIME', 'TTY', 'TIME', 'CMD'],
        Processes: [
          [
            'hytale',
            '1',
            '0',
            '0',
            '10:00',
            '?',
            '00:00:00',
            '/bin/bash /opt/hytale/start-server.sh',
          ],
          ['hytale', '7', '1', '9', '10:00', '?', '00:01:00', 'java -Xms3G -jar HytaleServer.jar'],
        ],
      }),
    }),
  }),
}));
vi.mock('./servers.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./servers.js')>()),
  ensureLoaded: async () => ({ schemaVersion: 1, defaultId: 'default', servers: [] }),
  getDefaultId: async () => 'default',
  getServer: async (id: string) => ({ id, containerName: `hytale-${id}` }),
  resolveServerId: async (id?: string) => id ?? 'default',
}));
vi.mock('./demoData.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./demoData.js')>()),
  isDemoMode: () => false,
}));
vi.mock('./players.js', () => ({ clearOnlinePlayers: vi.fn() }));

const docker = await import('./docker.js');

beforeEach(() => {
  h.stdinWrite.mockReset();
  h.containerExec.mockReset();
  h.attachFails = false;
});

describe('console input', () => {
  it('reports an unreachable console instead of a fake success', async () => {
    h.attachFails = true;
    const r = await docker.execCommand('/say hello', 'a');
    expect(r).toMatchObject({ success: false, error: 'Server console is not reachable' });
    expect(h.containerExec).not.toHaveBeenCalled();
  });

  it('terminates the attach request body that Docker forwards to stdin before the first command', async () => {
    const r = await docker.execCommand('/say hello', 'b');
    expect(r.success).toBe(true);
    expect(h.stdinWrite.mock.calls).toEqual([['\n'], ['/say hello\n']]);
  });

  it('reuses the attached stream for later commands', async () => {
    await docker.execCommand('/say again', 'b');
    expect(h.stdinWrite.mock.calls).toEqual([['/say again\n']]);
  });
});

describe('lifecycle commands', () => {
  const allowed = [
    '/stop',
    '/notify warning Server restart in 5 minutes.',
    '/notify danger Restarting now!',
    '/eventtitle Server restart in 1 minute.',
    '/world save --all --confirm',
  ];
  for (const command of allowed) {
    it(`sends ${command.split(' ').slice(0, 2).join(' ')}`, async () => {
      const r = await docker.sendLifecycleCommand(command, 'c');
      expect(r.success).toBe(true);
      expect(h.stdinWrite).toHaveBeenLastCalledWith(command + '\n');
    });
  }

  const rejected = [
    '/world remove default',
    '/world save',
    '/op add Evil',
    '/notify warning hi\n/op add Evil',
    '/notify hi', // style is always explicit, so user text cannot pick one
    '/stop --crash',
  ];
  for (const command of rejected) {
    it(`refuses ${JSON.stringify(command)}`, async () => {
      const r = await docker.sendLifecycleCommand(command, 'c');
      expect(r.success).toBe(false);
      expect(h.stdinWrite).not.toHaveBeenCalled();
    });
  }
});

describe('container introspection', () => {
  it('finds the Java server process', async () => {
    expect(await docker.isServerProcessRunning('d')).toBe(true);
  });

  it('decodes framed (non-TTY) logs', async () => {
    const header = Buffer.from([1, 0, 0, 0, 0, 0, 0, 6]);
    h.logs = Buffer.concat([header, Buffer.from('hello\n')]);
    expect(await docker.getLogs(10, 'd')).toBe('hello\n');
  });
});
