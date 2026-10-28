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
  attaches: 0,
  attachDelayMs: 0,
  destroyed: 0,
  // Per write: an error for its callback, 'hang' for a callback that never comes.
  writeOutcome: null as null | ((data: string) => Error | 'hang' | null),
  startedAt: '2026-10-28T10:00:00Z',
  logs: Buffer.alloc(0),
  runCommandViaPlugin: vi.fn(),
}));

/** A hijacked attach socket: the write callback runs once the data is handed off. */
function fakeStdin() {
  const stream = {
    destroyed: false,
    write(data: string, cb?: (error?: Error | null) => void) {
      h.stdinWrite(data);
      const outcome = h.writeOutcome?.(data) ?? null;
      if (outcome !== 'hang') queueMicrotask(() => cb?.(outcome));
      return true;
    },
    on: () => stream,
    removeAllListeners: () => stream,
    destroy() {
      stream.destroyed = true;
      h.destroyed++;
    },
  };
  return stream;
}

vi.mock('./dockerClient.js', () => ({
  createDockerClient: () => ({
    getContainer: () => ({
      inspect: async () => ({ Id: 'c1', State: { Running: true, StartedAt: h.startedAt } }),
      attach: async () => {
        if (h.attachFails) throw new Error('attach refused');
        h.attaches++;
        if (h.attachDelayMs) await new Promise((r) => setTimeout(r, h.attachDelayMs));
        return fakeStdin();
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
  h.attaches = 0;
  h.attachDelayMs = 0;
  h.destroyed = 0;
  h.writeOutcome = null;
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

describe('one serialized stdin console per server', () => {
  const lines = (calls: unknown[][]) => calls.map(([d]) => d).filter((d) => d !== '\n');

  it('attaches once for callers that arrive together and writes every line once, in order', async () => {
    h.attachDelayMs = 20;
    const commands = Array.from({ length: 12 }, (_, i) => `/say line ${i}`);
    const results = await Promise.all(commands.map((c) => docker.execCommand(c, 'q1')));
    expect(results.every((r) => r.success && r.via === 'stdin')).toBe(true);
    expect(h.attaches).toBe(1);
    expect(lines(h.stdinWrite.mock.calls)).toEqual(commands.map((c) => c + '\n'));
  });

  it('attaches anew after a container restart instead of writing into the old socket', async () => {
    await docker.execCommand('/say before', 'q2');
    h.startedAt = '2026-10-28T11:00:00Z';
    const r = await docker.execCommand('/say after', 'q2');
    expect(r.success).toBe(true);
    expect(h.attaches).toBe(2);
    expect(h.destroyed).toBe(1);
    expect(h.stdinWrite.mock.calls.map(([d]) => d)).toEqual([
      '\n',
      '/say before\n',
      '\n',
      '/say after\n',
    ]);
  });

  it('retries once on a fresh socket when the old one turns out closed', async () => {
    await docker.execCommand('/say one', 'q3');
    let failed = false;
    h.writeOutcome = (data) => {
      if (data !== '/say two\n' || failed) return null;
      failed = true;
      return Object.assign(new Error('write after end'), { code: 'ERR_STREAM_WRITE_AFTER_END' });
    };
    const r = await docker.execCommand('/say two', 'q3');
    expect(r.success).toBe(true);
    expect(h.attaches).toBe(2);
    // Written to the dead socket (refused) and once to the new one.
    expect(lines(h.stdinWrite.mock.calls)).toEqual(['/say one\n', '/say two\n', '/say two\n']);
  });

  it('closes an attach whose first line fails instead of keeping it open', async () => {
    let first = true;
    h.writeOutcome = (data) => {
      if (data !== '\n' || !first) return null;
      first = false;
      return new Error('broken pipe');
    };
    const r = await docker.execCommand('/say one', 'q7');
    expect(r).toMatchObject({ success: false, error: 'Server console is not reachable' });
    expect(h.destroyed).toBe(1);
    const next = await docker.execCommand('/say two', 'q7');
    expect(next.success).toBe(true);
    expect(h.attaches).toBe(2);
  });

  it('reports a write that may have failed half-way instead of repeating it', async () => {
    await docker.execCommand('/say one', 'q4');
    h.writeOutcome = (data) =>
      data === '/say two\n' ? Object.assign(new Error('reset'), { code: 'ECONNRESET' }) : null;
    const r = await docker.execCommand('/say two', 'q4');
    expect(r).toMatchObject({ success: false, via: 'stdin' });
    expect(r.error).toMatch(/reset/);
    expect(lines(h.stdinWrite.mock.calls)).toEqual(['/say one\n', '/say two\n']);
    // The broken socket is not used again.
    const next = await docker.execCommand('/say three', 'q4');
    expect(next.success).toBe(true);
    expect(h.attaches).toBe(2);
  });

  it('fails a line the socket does not take in time, and goes on with the next', async () => {
    vi.useFakeTimers();
    try {
      await docker.execCommand('/say warm-up', 'q5');
      h.writeOutcome = (data) => (data === '/say stuck\n' ? 'hang' : null);
      const stuck = docker.execCommand('/say stuck', 'q5');
      const next = docker.execCommand('/say next', 'q5');
      await vi.advanceTimersByTimeAsync(5_000);
      expect(await stuck).toMatchObject({ success: false, via: 'stdin' });
      expect(await next).toMatchObject({ success: true, via: 'stdin' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('refuses lines beyond the queue limit instead of piling them up', async () => {
    h.writeOutcome = (data) => (data === '/say block\n' ? 'hang' : null);
    vi.useFakeTimers();
    try {
      // The stuck line and 99 behind it fill the queue of 100.
      const all = [docker.execCommand('/say block', 'q6')];
      for (let i = 0; i < 99; i++) all.push(docker.execCommand(`/say ${i}`, 'q6'));
      await vi.advanceTimersByTimeAsync(0);
      const over = await docker.execCommand('/say over', 'q6');
      expect(over).toMatchObject({ success: false, via: 'stdin' });
      expect(over.error).toMatch(/Too many console commands waiting/);
      h.writeOutcome = null;
      await vi.advanceTimersByTimeAsync(5_000);
      const results = await Promise.all(all);
      expect(results[0].success).toBe(false);
      expect(results.slice(1).every((r) => r.success)).toBe(true);
      expect(h.stdinWrite).not.toHaveBeenCalledWith('/say over\n');
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("stdin and the console's line editor", () => {
  // What the console's line editor does with a line before the server runs
  // it: a backslash keeps the next character and is dropped, an unescaped
  // `!` starts a history expansion (marked here, the editor inserts text of
  // earlier console lines). Checked against the console of a Hytale 0.7.4
  // server: every line below came back exactly after toConsoleLine.
  function readBack(line: string): string {
    let out = '';
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (c === '\\') {
        if (i + 1 < line.length) out += line[++i];
      } else if (c === '!') {
        out += '<history>';
      } else {
        out += c;
      }
    }
    return out;
  }

  const lines = [
    '/say hello world',
    '/time d\\ilation 0.1',
    '/time \\d\\i\\l\\a\\t\\i\\o\\n 0.1',
    '/say a!!b\\c',
    '/say !!',
    '/say !$',
    '/say !foo',
    '/time dilation !$',
    '/say "quoted !! and \\x"',
    "/say 'single !! and \\x'",
    '/say a\\\\b and trailing\\',
    '/ban Bob griefing!!',
    '/say \\u0041 ^x^y !#',
    '/say continued\\',
    '/say Wow!! great',
    // Already escaped by whoever typed it: still arrives as typed.
    '/say a\\\\b \\!\\! \\!$ end',
    '/time d\\\\ilation 0.1',
    '/say "q \\!\\! \\\\" x',
    '/say wow\\! ok',
    // Shell syntax means nothing to the console; it stays one line.
    '/say a; /op add Bob && x | y `whoami` $(id) ${HOME}',
  ];

  it('escapes every backslash and every ! so the server reads the checked line', () => {
    for (const line of lines) expect(readBack(docker.toConsoleLine(line)), line).toBe(line);
    expect(docker.toConsoleLine('/time d\\ilation 0.1')).toBe('/time d\\\\ilation 0.1');
    expect(docker.toConsoleLine('/say a!!b\\c')).toBe('/say a\\!\\!b\\\\c');
    expect(docker.toConsoleLine('/say hello world')).toBe('/say hello world');
  });

  it('writes the escaped line to stdin', async () => {
    await docker.execCommand('/say warm-up', 'e1');
    h.stdinWrite.mockClear();
    for (const command of ['/time d\\ilation 0.1', '/say !!', '/say !$', '/say !foo']) {
      const r = await docker.execCommand(command, 'e1');
      expect(r).toMatchObject({
        success: true,
        via: 'stdin',
        message: `Command executed: ${command}`,
      });
    }
    expect(h.stdinWrite.mock.calls.map(([d]) => d)).toEqual([
      '/time d\\\\ilation 0.1\n',
      '/say \\!\\!\n',
      '/say \\!$\n',
      '/say \\!foo\n',
    ]);
  });

  it('leaves the line alone on the plugin path, which takes it as it is', async () => {
    h.runCommandViaPlugin.mockResolvedValue({
      kind: 'reply',
      reply: {
        ok: true,
        status: 'DONE',
        command: 'say a!!b\\c',
        sender: 'Panel:alice',
        output: [],
        messageIds: [],
        error: null,
        truncated: false,
        durationMs: 1,
      },
    });
    await docker.execCommand('/say a!!b\\c', 'e2');
    expect(h.runCommandViaPlugin.mock.calls[0][0]).toBe('/say a!!b\\c');
    expect(h.stdinWrite).not.toHaveBeenCalled();
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
      // `!` escaped for the console's line editor (see above).
      expect(h.stdinWrite).toHaveBeenLastCalledWith(command.replace('!', '\\!') + '\n');
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
