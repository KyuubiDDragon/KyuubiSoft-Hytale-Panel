/**
 * The replay recorder per server: with recording on, every server records
 * its own segments in its own folder, a segment only holds that server's
 * events, and the segment lookups never reach another server's files.
 */
import { describe, it, expect, vi, afterAll } from 'vitest';
import path from 'path';
import os from 'os';
import fs from 'fs';
import { gunzipSync } from 'zlib';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kp-replay-per-server-'));
process.env.MANAGER_DATA_PATH = tmpDir;

vi.mock('./configService.js', () => ({
  getConfig: async () => ({ replay: { recordingEnabled: true, retentionDays: 7 } }),
  updateConfig: async () => undefined,
}));
vi.mock('./servers.js', () => ({
  COMPOSE_SERVER_ID: 'default',
  listServers: async () => [{ id: 'default' }, { id: 'b1c2d3e4' }],
  onServerAdded: () => () => undefined,
  onServerDeleted: () => () => undefined,
}));

const replay = await import('./replay.js');
const { eventBus } = await import('./eventBus.js');

afterAll(async () => {
  await replay.shutdownReplay();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function recordedEvents(segmentDir: string): Array<{ payload: { player?: string } }> {
  const file = path.join(segmentDir, 'ticks.ndjson.gz');
  return gunzipSync(fs.readFileSync(file))
    .toString('utf-8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

describe('replay per server', () => {
  it("records each server's events into its own segment and folder", async () => {
    await replay.initializeReplay();
    eventBus.publish('player_chat', { player: 'Alice', message: 'a', serverId: 'default' });
    eventBus.publish('player_chat', { player: 'Bob', message: 'b', serverId: 'b1c2d3e4' });
    await replay.shutdownReplay();

    const [onDefault] = await replay.listSegments('default');
    const [onB] = await replay.listSegments('b1c2d3e4');
    expect(onDefault.serverId).toBe('default');
    expect(onB.serverId).toBe('b1c2d3e4');
    expect(fs.existsSync(path.join(tmpDir, 'replay', onDefault.id))).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, 'servers', 'b1c2d3e4', 'replay', onB.id))).toBe(true);

    expect(
      recordedEvents(path.join(tmpDir, 'replay', onDefault.id)).map((e) => e.payload.player),
    ).toEqual(['Alice']);
    expect(
      recordedEvents(path.join(tmpDir, 'servers', 'b1c2d3e4', 'replay', onB.id)).map(
        (e) => e.payload.player,
      ),
    ).toEqual(['Bob']);
  });

  it("does not find a segment under another server's id", async () => {
    const [onB] = await replay.listSegments('b1c2d3e4');
    expect(await replay.getManifest(onB.id, 'default')).toBeNull();
    expect(replay.openTicksStream(onB.id, 'default')).toBeNull();
    expect(await replay.createExportToken(onB.id, 'default')).toBeNull();
    expect(await replay.deleteSegment(onB.id, 'default')).toBe(false);
    expect(await replay.getManifest(onB.id, 'b1c2d3e4')).not.toBeNull();
  });
});
