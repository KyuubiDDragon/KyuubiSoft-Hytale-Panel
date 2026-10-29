/**
 * The replay switch with the real config service: turning recording on
 * starts it at once (no restart), turning it off stops it.
 */
import { describe, it, expect, vi, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kp-replay-config-'));
process.env.MANAGER_DATA_PATH = tmpDir;

vi.mock('./servers.js', () => ({
  COMPOSE_SERVER_ID: 'default',
  listServers: async () => [{ id: 'default' }],
  onServerAdded: () => () => undefined,
  onServerDeleted: () => () => undefined,
}));

const replay = await import('./replay.js');
const { getConfig } = await import('./configService.js');

afterAll(async () => {
  await replay.shutdownReplay();
});

describe('replay switch', () => {
  it('starts and stops recording right away', async () => {
    await replay.initializeReplay(); // off by default
    expect(await replay.listSegments('default')).toEqual([]);
    // The config is cached from here on.
    expect((await getConfig()) as unknown as { replay?: unknown }).toBeDefined();

    expect((await replay.setReplayConfig({ recordingEnabled: true })).recordingEnabled).toBe(true);
    expect((await replay.getReplayConfig()).recordingEnabled).toBe(true);
    expect(await replay.listSegments('default')).toHaveLength(1);

    await replay.setReplayConfig({ recordingEnabled: false });
    expect((await replay.getReplayConfig()).recordingEnabled).toBe(false);
    // The closed segment stays; no new one is started.
    await replay.applyReplayConfig();
    expect(await replay.listSegments('default')).toHaveLength(1);
  });
});
