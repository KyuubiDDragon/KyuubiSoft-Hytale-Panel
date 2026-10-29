/**
 * The Hytale adapter exists once per server and reads that server's version
 * and plugin; the version comes from the stamped `.hytale-version` here.
 */
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type { ServerContext } from './serverContext.js';
import { serverContextIn } from '../test/serverContextStub.js';

const { contexts, pluginStatus } = vi.hoisted(() => ({
  contexts: new Map<string, ServerContext>(),
  pluginStatus: vi.fn(),
}));
vi.mock('./serverContext.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./serverContext.js')>();
  return {
    ...actual,
    getServerContext: async (id?: string | null) => {
      const ctx = contexts.get(id ?? 'default');
      if (!ctx) throw new actual.UnknownServerError(String(id));
      return ctx;
    },
  };
});
vi.mock('./kyuubiApi.js', () => ({
  getPluginStatus: pluginStatus,
  fetchFromPlugin: vi.fn(),
}));

const { getHytaleApi, HytaleAPIFactory } = await import('./hytaleAdapter.js');

let base: string;

beforeAll(() => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'kp-adapter-'));
  for (const [id, version] of [
    ['default', '0.7.3'],
    ['srv-b', '0.7.4'],
  ]) {
    const ctx = serverContextIn(path.join(base, id), id);
    contexts.set(id, ctx);
    fs.mkdirSync(ctx.paths.server, { recursive: true });
    fs.writeFileSync(path.join(ctx.paths.server, '.hytale-version'), `${version}\nrelease\n`);
  }
});

afterAll(() => {
  HytaleAPIFactory.reset();
  fs.rmSync(base, { recursive: true, force: true });
});

describe('Hytale adapter per server', () => {
  it("reads each server's own version and plugin", async () => {
    expect((await getHytaleApi('srv-b').getVersion()).version).toBe('0.7.4');
    expect((await getHytaleApi('default').getVersion()).version).toBe('0.7.3');
    expect(getHytaleApi('srv-b')).toBe(getHytaleApi('srv-b'));
    expect(getHytaleApi('srv-b')).not.toBe(getHytaleApi('default'));

    pluginStatus.mockResolvedValue({ running: true });
    await getHytaleApi('srv-b').isReachable();
    expect(pluginStatus).toHaveBeenCalledWith('srv-b');
  });

  it('fails for a server that is not registered instead of reading another one', async () => {
    await expect(getHytaleApi('gone').getVersion()).rejects.toThrow(/Unknown server id/);
  });
});
