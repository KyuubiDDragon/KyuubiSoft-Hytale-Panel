/**
 * Regression tests for the single gate in execCommand: whatever a caller built
 * (console, scheduler, event actions, kick/ban reasons, …), a command that
 * carries a second line or a TTY control byte must never reach the container's
 * stdin, while a normal command is written exactly once with one newline.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { stdinWrite, containerExec } = vi.hoisted(() => ({
  stdinWrite: vi.fn(),
  containerExec: vi.fn(),
}));

vi.mock('./dockerClient.js', () => ({
  createDockerClient: () => ({
    getContainer: () => ({
      inspect: async () => ({ State: { Running: true } }),
      attach: async () => ({ write: stdinWrite, on: () => undefined }),
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
vi.mock('./demoData.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./demoData.js')>()),
  isDemoMode: () => false,
}));
vi.mock('./players.js', () => ({ clearOnlinePlayers: vi.fn() }));

const { execCommand } = await import('./docker.js');

const LINE_SEPARATOR = String.fromCharCode(0x2028);
const CTRL_C = String.fromCharCode(0x03);
const NEL = String.fromCharCode(0x85);

describe('docker.execCommand stdin gate', () => {
  beforeEach(() => {
    stdinWrite.mockReset();
    containerExec.mockReset();
  });

  it('writes a valid single-line command once, terminated by one newline', async () => {
    const result = await execCommand('/say hello', 'default');
    expect(result.success).toBe(true);
    expect(stdinWrite).toHaveBeenCalledOnce();
    expect(stdinWrite).toHaveBeenCalledWith('/say hello\n');
  });

  const blocked = [
    ['an embedded line feed', '/say hi\n/op add Evil'],
    ['a carriage return', '/say hi\r/op add Evil'],
    ['Ctrl-C', `/say bye${CTRL_C}`],
    ['a C1 control', `/say hi${NEL}/op add Evil`],
    ['U+2028', `/say hi${LINE_SEPARATOR}/op add Evil`],
  ] as const;

  for (const [label, command] of blocked) {
    it(`never writes a command containing ${label}`, async () => {
      const result = await execCommand(command, 'default');
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/single line/);
      expect(stdinWrite).not.toHaveBeenCalled();
      expect(containerExec).not.toHaveBeenCalled();
    });
  }

  it('blocks a placeholder value with an embedded newline after substitution', async () => {
    const username = 'Bob\n/op add Evil'; // e.g. the name of a failed login
    const result = await execCommand(`/say Failed login for ${username}`, 'default');
    expect(result.success).toBe(false);
    expect(stdinWrite).not.toHaveBeenCalled();
  });
});
