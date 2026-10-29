/**
 * The console path into the game server: stdin attach only (the old
 * `docker exec` fallback reported success for commands that never arrived),
 * the attach-body quirk, and the narrow command set of the lifecycle.
 *
 * Commands first go to the KyuubiSoft API plugin (docker.execCommand.test.ts
 * covers that client); here it is stubbed, and stdin is what the panel falls
 * back to when the plugin did not take a command.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { PluginCommandAttempt } from './pluginCommands.js';

const UNAVAILABLE: PluginCommandAttempt = { kind: 'unavailable', reason: 'plugin not installed' };

const h = vi.hoisted(() => ({
  stdinWrite: vi.fn(),
  containerExec: vi.fn(),
  attachFails: false,
  logs: Buffer.alloc(0),
  runCommandViaPlugin: vi.fn(),
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
vi.mock('./pluginCommands.js', () => ({ runCommandViaPlugin: h.runCommandViaPlugin }));

const docker = await import('./docker.js');

beforeEach(() => {
  h.stdinWrite.mockReset();
  h.containerExec.mockReset();
  h.attachFails = false;
  h.runCommandViaPlugin.mockReset();
  h.runCommandViaPlugin.mockResolvedValue(UNAVAILABLE);
});

describe('console input', () => {
  it('reports an unreachable console instead of a fake success', async () => {
    h.attachFails = true;
    const r = await docker.execCommand('/say hello', 'a');
    expect(r).toMatchObject({ success: false, error: 'Server console is not reachable' });
    expect(h.containerExec).not.toHaveBeenCalled();
  });

  it('asks the plugin first and falls back to stdin only, never to docker exec', async () => {
    h.attachFails = true;
    const r = await docker.execCommand('/say hello', 'a2');
    expect(h.runCommandViaPlugin).toHaveBeenCalledOnce();
    expect(h.runCommandViaPlugin.mock.calls[0][0]).toBe('/say hello');
    expect(r).toMatchObject({ success: false, via: 'stdin' });
    expect(h.containerExec).not.toHaveBeenCalled();
  });

  it('does not touch stdin when the plugin ran the command', async () => {
    h.runCommandViaPlugin.mockResolvedValue({
      kind: 'reply',
      reply: {
        ok: true,
        status: 'DONE',
        command: 'say hello',
        sender: 'Panel:alice',
        output: [],
        messageIds: [],
        error: null,
        truncated: false,
        durationMs: 3,
      },
    });
    const r = await docker.execCommand('/say hello', 'a3');
    expect(r).toMatchObject({ success: true, via: 'plugin', status: 'DONE' });
    expect(h.stdinWrite).not.toHaveBeenCalled();
    expect(h.containerExec).not.toHaveBeenCalled();
  });

  it('checks a command before either path', async () => {
    const r = await docker.execCommand('/say hi\n/op add Evil', 'a4');
    expect(r.success).toBe(false);
    expect(h.runCommandViaPlugin).not.toHaveBeenCalled();
    expect(h.stdinWrite).not.toHaveBeenCalled();
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
      expect(h.runCommandViaPlugin).not.toHaveBeenCalled();
      expect(h.stdinWrite).not.toHaveBeenCalled();
    });
  }

  it('go through the plugin like every other command, with stdin as fallback', async () => {
    await docker.sendLifecycleCommand('/notify warning Server restart in 5 minutes.', 'c');
    expect(h.runCommandViaPlugin).toHaveBeenCalledOnce();
    expect(h.stdinWrite).toHaveBeenLastCalledWith('/notify warning Server restart in 5 minutes.\n');
  });

  it('echo the world save to the server log, where the panel backup waits for its end', async () => {
    await docker.sendLifecycleCommand('/world save --all --confirm', 'c');
    expect(h.runCommandViaPlugin.mock.calls[0][2]).toMatchObject({ echo: true, timeoutMs: 1500 });
  });

  it('count a stop the plugin could not answer as sent, without a second try', async () => {
    h.runCommandViaPlugin.mockResolvedValue({ kind: 'unknown', error: 'socket hang up' });
    const r = await docker.sendLifecycleCommand('/stop', 'c2');
    expect(r).toMatchObject({ success: true, via: 'plugin' });
    expect(h.stdinWrite).not.toHaveBeenCalled();
  });
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
