/**
 * Chat logs and death positions per server: the compose server keeps the
 * folders single-server installs used (chat/, deaths/), every other server
 * gets servers/<id>/. Reading a log never shows another server's messages;
 * the data export and the erasure cover every server.
 */
import { describe, it, expect, vi, afterAll } from 'vitest';
import path from 'path';
import os from 'os';
import fs from 'fs';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kp-chat-per-server-'));
process.env.MANAGER_DATA_PATH = tmpDir;
delete process.env.DEMO_MODE;

// The compose server is the default one.
vi.mock('./servers.js', () => ({
  COMPOSE_SERVER_ID: 'default',
  resolveServerId: async (id?: string) => id ?? 'default',
  getServer: async () => null,
  onServerDeleted: () => () => undefined,
}));

const chat = await import('./chatLog.js');

const today = new Date().toISOString().split('T')[0];

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('chat log per server', () => {
  it('stores each server in its own folder, the compose server where it always was', async () => {
    await chat.addChatMessage('default', 'Alice', 'hello from A');
    await chat.addChatMessage('b1c2d3e4', 'Alice', 'hello from B');
    await vi.waitFor(() => {
      expect(fs.existsSync(path.join(tmpDir, 'chat', 'global', `${today}.json`))).toBe(true);
      expect(
        fs.existsSync(path.join(tmpDir, 'servers', 'b1c2d3e4', 'chat', 'global', `${today}.json`)),
      ).toBe(true);
    });
  });

  it("reads one server's messages only; without an id the default server's", async () => {
    const a = await chat.getGlobalChatLog({}, 'default');
    const b = await chat.getGlobalChatLog({}, 'b1c2d3e4');
    expect(a.messages.map((m) => m.message)).toEqual(['hello from A']);
    expect(b.messages.map((m) => [m.message, m.serverId])).toEqual([['hello from B', 'b1c2d3e4']]);
    expect((await chat.getGlobalChatLog()).messages.map((m) => m.message)).toEqual([
      'hello from A',
    ]);
    await vi.waitFor(async () => {
      const own = await chat.getPlayerChatLog('Alice', {}, 'b1c2d3e4');
      expect(own.messages.map((m) => m.message)).toEqual(['hello from B']);
    });
  });

  it('keeps death positions per server', async () => {
    await chat.recordDeathPosition('default', 'Alice', 'Orbis', 1, 2, 3);
    await chat.recordDeathPosition('b1c2d3e4', 'Alice', 'Orbis', 7, 8, 9);
    expect((await chat.getLastDeathPosition('Alice', 'b1c2d3e4'))?.x).toBe(7);
    expect((await chat.getLastDeathPosition('Alice'))?.x).toBe(1);
  });

  it('exports and erases a player on one server only', async () => {
    await chat.addChatMessage('default', 'Carol', 'carol on A');
    await chat.addChatMessage('b1c2d3e4', 'Carol', 'carol on B');
    await vi.waitFor(async () => {
      const onB = await chat.getPlayerChatHistory('Carol', 'b1c2d3e4');
      expect(onB.map((m) => m.message)).toEqual(['carol on B']);
    });
    expect(await chat.deletePlayerChatData('Carol', 'b1c2d3e4')).toBe(true);
    expect(await chat.getPlayerChatHistory('Carol', 'b1c2d3e4')).toEqual([]);
    expect((await chat.getPlayerChatHistory('Carol', 'default')).map((m) => m.message)).toEqual([
      'carol on A',
    ]);
  });

  it('exports and erases a player on every server', async () => {
    await vi.waitFor(async () => {
      const all = await chat.getPlayerChatHistory('Alice', null);
      expect(all.map((m) => m.serverId).sort()).toEqual(['b1c2d3e4', 'default']);
    });
    expect(await chat.deletePlayerChatData('Alice', null)).toBe(true);
    expect(await chat.getPlayerChatHistory('Alice', null)).toEqual([]);
    expect(
      fs.existsSync(path.join(tmpDir, 'servers', 'b1c2d3e4', 'chat', 'players', 'alice')),
    ).toBe(false);
  });

  it('refuses a server id that is not a plain id', async () => {
    await expect(chat.addChatMessage('../escape', 'Alice', 'x')).rejects.toThrow(
      /Invalid server id/,
    );
  });
});
