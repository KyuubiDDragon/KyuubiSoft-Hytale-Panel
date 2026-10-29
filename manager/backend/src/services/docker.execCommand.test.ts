/**
 * Regression tests for the single gate in execCommand: whatever a caller built
 * (console, scheduler, event actions, kick/ban reasons, …), a command that
 * carries a second line or a TTY control byte must never reach the plugin or
 * the container's stdin, while a normal command is sent exactly once.
 *
 * Also covers the path choice: the KyuubiSoft API plugin runs the command and
 * returns its answer; stdin is only the fallback when the plugin did not take
 * the command, and never a retry for one that may already have run.
 */
import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import type { NextFunction, Request as ExpressRequest, Response as ExpressResponse } from 'express';
import { EventEmitter } from 'events';

const { stdinWrite, containerExec, pluginInstalled, fetchMock } = vi.hoisted(() => ({
  stdinWrite: vi.fn(),
  containerExec: vi.fn(),
  pluginInstalled: vi.fn(async () => false),
  fetchMock: vi.fn<typeof fetch>(),
}));

vi.mock('./dockerClient.js', () => ({
  createDockerClient: () => ({
    getContainer: () => ({
      inspect: async () => ({ State: { Running: true } }),
      // Like a socket: the write callback runs once the data is handed off.
      attach: async () => ({
        write: (data: string, cb?: (error?: Error | null) => void) => {
          stdinWrite(data);
          queueMicrotask(() => cb?.());
          return true;
        },
        on: () => undefined,
      }),
      exec: containerExec,
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
vi.mock('./kyuubiApi.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./kyuubiApi.js')>()),
  isPluginInstalled: pluginInstalled,
  resolvePluginEndpoint: async () => ({ host: 'hytale-default', port: 18085 }),
  getPluginAuthHeaders: async () => ({ Authorization: 'Bearer test-token' }),
}));
vi.mock('./demoData.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./demoData.js')>()),
  isDemoMode: () => false,
}));
vi.mock('./players.js', () => ({ clearOnlinePlayers: vi.fn() }));

vi.stubGlobal('fetch', fetchMock);

const { execCommand } = await import('./docker.js');
const { resetPluginCommandState } = await import('./pluginCommands.js');
const { bindCommandActor } = await import('./commandActor.js');

const LINE_SEPARATOR = String.fromCharCode(0x2028);
const CTRL_C = String.fromCharCode(0x03);
const NEL = String.fromCharCode(0x85);

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function reply(overrides: Record<string, unknown> = {}) {
  return {
    ok: true,
    status: 'DONE',
    command: 'who',
    sender: 'Panel:alice',
    output: ['default (1): Alice'],
    messageIds: ['server.commands.who.list'],
    truncated: false,
    durationMs: 12,
    ...overrides,
  };
}

function connectError(code: string): Error {
  return Object.assign(new TypeError('fetch failed'), { cause: { code } });
}

function sentBody(call = 0): Record<string, unknown> {
  const init = fetchMock.mock.calls[call][1] as RequestInit;
  return JSON.parse(String(init.body)) as Record<string, unknown>;
}

beforeEach(() => {
  stdinWrite.mockReset();
  containerExec.mockReset();
  fetchMock.mockReset();
  pluginInstalled.mockReset();
  pluginInstalled.mockResolvedValue(false);
  resetPluginCommandState();
});

afterAll(() => {
  vi.unstubAllGlobals();
});

describe('docker.execCommand stdin gate', () => {
  it('writes a valid single-line command once, terminated by one newline', async () => {
    const result = await execCommand('/say hello', 'default');
    expect(result.success).toBe(true);
    expect(result.via).toBe('stdin');
    // A fresh attach first terminates the request body Docker leaks into stdin.
    const commandWrites = stdinWrite.mock.calls.filter(([data]) => data !== '\n');
    expect(commandWrites).toEqual([['/say hello\n']]);
  });

  const blocked = [
    ['an embedded line feed', '/say hi\n/op add Evil'],
    ['a carriage return', '/say hi\r/op add Evil'],
    ['Ctrl-C', `/say bye${CTRL_C}`],
    ['a C1 control', `/say hi${NEL}/op add Evil`],
    ['U+2028', `/say hi${LINE_SEPARATOR}/op add Evil`],
  ] as const;

  for (const [label, command] of blocked) {
    it(`never sends a command containing ${label} to the plugin or stdin`, async () => {
      pluginInstalled.mockResolvedValue(true);
      fetchMock.mockResolvedValue(jsonResponse(200, reply()));
      const result = await execCommand(command, 'default');
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/single line/);
      expect(fetchMock).not.toHaveBeenCalled();
      expect(stdinWrite).not.toHaveBeenCalled();
      expect(containerExec).not.toHaveBeenCalled();
    });
  }

  it('blocks a placeholder value with an embedded newline after substitution', async () => {
    pluginInstalled.mockResolvedValue(true);
    const username = 'Bob\n/op add Evil'; // e.g. the name of a failed login
    const result = await execCommand(`/say Failed login for ${username}`, 'default');
    expect(result.success).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(stdinWrite).not.toHaveBeenCalled();
  });
});

describe('docker.execCommand through the KyuubiSoft API plugin', () => {
  beforeEach(() => {
    pluginInstalled.mockResolvedValue(true);
  });

  it('returns the command answer from the plugin and does not touch stdin', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, reply()));
    // (The panel's whitelist still uses Minecraft-era names; /help is on it.)
    const result = await execCommand('/help', 'default', { actor: 'alice' });

    expect(result).toMatchObject({
      success: true,
      via: 'plugin',
      status: 'DONE',
      lines: ['default (1): Alice'],
      output: 'default (1): Alice',
      message: 'default (1): Alice',
    });
    expect(String(fetchMock.mock.calls[0][0])).toBe(
      'http://hytale-default:18085/api/commands/execute',
    );
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer test-token');
    expect(sentBody()).toMatchObject({ command: '/help', actor: 'alice', echo: false });
    expect(stdinWrite).not.toHaveBeenCalled();
  });

  it('reports a command the server refused as a failure with its message', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(
        200,
        reply({
          ok: false,
          status: 'REJECTED',
          output: ['Wrong number of required arguments'],
          error: 'Wrong number of required arguments',
        }),
      ),
    );
    const result = await execCommand('/kick Alice too many words', 'default');
    expect(result.success).toBe(false);
    expect(result.status).toBe('REJECTED');
    expect(result.error).toBe('Wrong number of required arguments');
    expect(stdinWrite).not.toHaveBeenCalled();
  });

  it('treats a command still running at the deadline as accepted', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, reply({ status: 'RUNNING', output: [] })));
    const result = await execCommand('/update check', 'default');
    expect(result.success).toBe(true);
    expect(result.status).toBe('RUNNING');
    expect(result.message).toMatch(/still running/);
  });

  const declined = [
    ['401 (token rejected)', 401],
    ['403 (plugin auth disabled)', 403],
    ['404 (plugin without the endpoint)', 404],
    ['503 (command system not up)', 503],
  ] as const;

  for (const [label, status] of declined) {
    it(`falls back to stdin when the plugin answers ${label}`, async () => {
      fetchMock.mockResolvedValue(jsonResponse(status, { status, error: 'nope' }));
      const result = await execCommand('/say hello', 'default');
      expect(result.via).toBe('stdin');
      expect(result.success).toBe(true);
      expect(stdinWrite).toHaveBeenCalledOnce();
      expect(stdinWrite).toHaveBeenCalledWith('/say hello\n');
    });
  }

  it('falls back to stdin when the plugin is not reachable', async () => {
    fetchMock.mockRejectedValue(connectError('ECONNREFUSED'));
    const result = await execCommand('/say hello', 'default');
    expect(result.via).toBe('stdin');
    expect(stdinWrite).toHaveBeenCalledOnce();
  });

  it('uses stdin without asking when the plugin is not installed', async () => {
    pluginInstalled.mockResolvedValue(false);
    const result = await execCommand('/say hello', 'default');
    expect(result.via).toBe('stdin');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(stdinWrite).toHaveBeenCalledOnce();
  });

  it('remembers a plugin without the endpoint instead of asking on every command', async () => {
    fetchMock.mockResolvedValue(jsonResponse(404, { status: 404, error: 'not found' }));
    await execCommand('/say one', 'default');
    await execCommand('/say two', 'default');
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(stdinWrite).toHaveBeenCalledTimes(2);
  });

  it('never resends a command whose plugin request may have arrived', async () => {
    fetchMock.mockRejectedValue(Object.assign(new Error('aborted'), { name: 'AbortError' }));
    const result = await execCommand('/give Alice Rock_Stone', 'default');
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/may still have run/);
    expect(stdinWrite).not.toHaveBeenCalled();
    expect(containerExec).not.toHaveBeenCalled();
  });

  it('does not resend after a plugin error reply either', async () => {
    fetchMock.mockResolvedValue(jsonResponse(500, { status: 500, error: 'Internal server error' }));
    const result = await execCommand('/give Alice Rock_Stone', 'default');
    expect(result.success).toBe(false);
    expect(stdinWrite).not.toHaveBeenCalled();
  });

  it('counts a stop without a reply as sent (the server is going down)', async () => {
    fetchMock.mockRejectedValue(connectError('ECONNRESET'));
    const result = await execCommand('/stop', 'default');
    expect(result.success).toBe(true);
    expect(stdinWrite).not.toHaveBeenCalled();
  });

  it('counts /update apply --confirm without a reply as sent (the server restarts into the update)', async () => {
    fetchMock.mockRejectedValue(connectError('ECONNRESET'));
    const result = await execCommand('/update apply --confirm', 'default');
    expect(result).toMatchObject({ success: true, via: 'plugin' });
    expect(stdinWrite).not.toHaveBeenCalled();
  });

  it('does not count an unanswered /update apply without --confirm as sent', async () => {
    fetchMock.mockRejectedValue(connectError('ECONNRESET'));
    const result = await execCommand('/update apply', 'default');
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/may still have run/);
  });

  it('passes the message ids of a reply on, so callers can read a refusal', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(
        200,
        reply({
          command: 'update apply --confirm',
          output: ['No update is staged.'],
          messageIds: ['server.commands.update.no_staged'],
        }),
      ),
    );
    const result = await execCommand('/update apply --confirm', 'default');
    expect(result).toMatchObject({
      success: true,
      status: 'DONE',
      message: 'No update is staged.',
      messageIds: ['server.commands.update.no_staged'],
    });
  });

  it('does not use stdin when the plugin refuses the command line itself', async () => {
    fetchMock.mockResolvedValue(jsonResponse(400, { status: 400, error: 'Command is too long' }));
    const result = await execCommand('/say hello', 'default');
    expect(result).toMatchObject({ success: false, error: 'Command is too long' });
    expect(stdinWrite).not.toHaveBeenCalled();
  });

  it('treats an unexpected reply body as unknown, not as success', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { success: true }));
    const result = await execCommand('/say hello', 'default');
    expect(result.success).toBe(false);
    expect(stdinWrite).not.toHaveBeenCalled();
  });

  it('echoes /auth answers to the server log, which the sign-in flow reads', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, reply()));
    await execCommand('/auth status', 'default');
    expect(sentBody()).toMatchObject({ echo: true, timeoutMs: 1500 });
  });

  it('echoes /backup answers to the server log, which the native backup reads', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, reply({ status: 'RUNNING', output: [] })));
    const result = await execCommand('/backup', 'default');
    expect(result.success).toBe(true);
    expect(sentBody()).toMatchObject({ echo: true, timeoutMs: 1500 });
  });

  it('names the user of the current request as actor when the caller passes none', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, reply()));
    const req = {} as ExpressRequest & { user?: string };
    let sent: Promise<unknown> = Promise.resolve();
    bindCommandActor(
      req,
      new EventEmitter() as unknown as ExpressResponse,
      (() => {
        // The auth middleware sets the user after the scope opened.
        req.user = 'bob';
        sent = execCommand('/help', 'default');
      }) as NextFunction,
    );
    await sent;
    expect(sentBody()).toMatchObject({ actor: 'bob' });
  });

  it('prefers an explicit actor over the request user', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, reply()));
    const req = { user: 'bob' } as ExpressRequest & { user?: string };
    let sent: Promise<unknown> = Promise.resolve();
    bindCommandActor(
      req,
      new EventEmitter() as unknown as ExpressResponse,
      (() => {
        sent = execCommand('/help', 'default', { actor: 'scheduler/alice' });
      }) as NextFunction,
    );
    await sent;
    expect(sentBody()).toMatchObject({ actor: 'scheduler/alice' });
  });
});

describe('docker stop detection', () => {
  it('recognises a stop however the slash and the name are written', async () => {
    const { __stopDetection } = await import('./docker.js');
    for (const line of ['/stop', 'stop', '/ stop', '  /  SHUTDOWN  ', '/Stop now']) {
      expect(__stopDetection.isStopCommand(line), line).toBe(true);
    }
    for (const line of ['/stop --crash', '/stopwatch', '/say stop', '/ /stop']) {
      expect(__stopDetection.isStopCommand(line), line).toBe(false);
    }
    expect(__stopDetection.takesServerDown('/ update  apply --confirm')).toBe(true);
    expect(__stopDetection.takesServerDown('/update apply')).toBe(false);
  });
});
