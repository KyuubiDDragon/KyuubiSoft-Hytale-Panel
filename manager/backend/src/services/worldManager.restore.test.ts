/**
 * World import and world restore: an import only adds new world folders, a
 * restore replaces one world folder while the server is stopped and keeps a
 * backup of the replaced state. Uses the system tar (skipped on Windows).
 */
import fs from 'fs';
import path from 'path';
import os from 'os';
import { spawnSync } from 'child_process';
import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kp-worlds-')));
const dataDir = path.join(root, 'data');
const worldsDir = path.join(dataDir, 'worlds');
const backupsDir = path.join(root, 'backups');
process.env.DATA_PATH = dataDir;
process.env.SERVER_PATH = path.join(root, 'server');
process.env.MANAGER_DATA_PATH = path.join(root, 'manager');
fs.mkdirSync(process.env.MANAGER_DATA_PATH, { recursive: true });

const { lifecycle } = vi.hoisted(() => ({ lifecycle: [] as string[] }));
vi.mock('./managementHelpers.js', () => ({ getWorldsPaths: () => [worldsDir] }));
vi.mock('./servers.js', () => ({
  getDefaultId: async () => 'default',
  getServer: async () => ({ paths: { backups: backupsDir, server: process.env.SERVER_PATH } }),
  listServers: async () => [],
}));
vi.mock('./serverLifecycle.js', () => ({
  withServerStopped: async (_id: unknown, opts: { reason: string }, fn: () => Promise<unknown>) => {
    lifecycle.push(`stop:${opts.reason}`);
    try {
      return await fn();
    } finally {
      lifecycle.push('start');
    }
  },
}));
vi.mock('./docker.js', () => ({
  getStatus: async () => ({ status: 'exited', running: false }),
  sendLifecycleCommand: async () => ({ success: true }),
  execCommand: async () => ({ success: true }),
  getLogs: async () => '',
}));

const worlds = await import('./worldManager.js');

const HAS_TAR =
  process.platform !== 'win32' &&
  spawnSync('sh', ['-c', 'command -v tar'], { stdio: 'ignore' }).status === 0;

afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

beforeEach(() => {
  lifecycle.length = 0;
  for (const dir of [dataDir, backupsDir]) {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.mkdirSync(worldsDir, { recursive: true });
});

function write(rel: string, content: string, base = worldsDir): void {
  const file = path.join(base, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

/** tar.gz of `dir`'s entries (like an uploaded world archive). */
function tarOf(dir: string, out: string): string {
  const entries = fs.readdirSync(dir);
  expect(spawnSync('tar', ['-czf', out, '-C', dir, ...entries]).status).toBe(0);
  return out;
}

describe.skipIf(!HAS_TAR)('importWorldArchive', () => {
  it('adds a new world folder', async () => {
    const src = path.join(root, 'src1');
    write('Fresh/config.json', '{"Seed":1}', src);
    const archive = tarOf(src, path.join(root, 'fresh.tar.gz'));
    expect(await worlds.importWorldArchive(archive, 'fresh.tar.gz')).toEqual({ success: true });
    expect(fs.readFileSync(path.join(worldsDir, 'Fresh/config.json'), 'utf8')).toBe('{"Seed":1}');
    expect(fs.readdirSync(dataDir).filter((n) => n.startsWith('.kp-'))).toEqual([]);
  });

  it('never writes into an existing world', async () => {
    write('Live/config.json', 'live');
    const src = path.join(root, 'src2');
    write('Live/config.json', 'imported', src);
    const archive = tarOf(src, path.join(root, 'live.tar.gz'));
    const result = await worlds.importWorldArchive(archive, 'live.tar.gz');
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/already exists/);
    expect(fs.readFileSync(path.join(worldsDir, 'Live/config.json'), 'utf8')).toBe('live');
  });

  it('refuses loose files at the top level', async () => {
    const src = path.join(root, 'src3');
    write('users.json', '{}', src);
    const archive = tarOf(src, path.join(root, 'loose.tar.gz'));
    const result = await worlds.importWorldArchive(archive, 'loose.tar.gz');
    expect(result.error).toMatch(/only contain world folders/);
    expect(fs.existsSync(path.join(worldsDir, 'users.json'))).toBe(false);
  });
});

describe.skipIf(!HAS_TAR)('world restore', () => {
  it('replaces the world folder with the server stopped and keeps the previous state', async () => {
    write('Spawn/region.bin', 'state A');
    const created = await worlds.backupWorld('Spawn');
    expect(created.success).toBe(true);
    write('Spawn/region.bin', 'state B');
    write('Spawn/new-chunk.bin', 'only in B');

    const result = await worlds.restoreWorld(created.backup!.id, undefined, 'alice');

    expect(result.error).toBeUndefined();
    expect(result).toMatchObject({ success: true });
    expect(result.message).toMatch(/previous state was saved as world_Spawn_/);
    expect(lifecycle).toEqual(['stop:restore', 'start']);
    expect(fs.readFileSync(path.join(worldsDir, 'Spawn/region.bin'), 'utf8')).toBe('state A');
    expect(fs.existsSync(path.join(worldsDir, 'Spawn/new-chunk.bin'))).toBe(false);
    expect(fs.readdirSync(dataDir).filter((n) => n.startsWith('.kp-'))).toEqual([]);
    expect((await worlds.listWorldBackups()).length).toBe(2);
  });

  it('rejects an invalid backup id without a job', async () => {
    expect(await worlds.startWorldRestore('../../etc/passwd')).toMatchObject({
      ok: false,
      status: 400,
    });
    expect(lifecycle).toEqual([]);
  });
});

describe('world backup ids', () => {
  it('lists, deletes and accepts both the current and the old timestamp format', async () => {
    fs.mkdirSync(backupsDir, { recursive: true });
    // Older versions wrote YYYY-MM-DD-HHMM, which the id check then refused.
    fs.writeFileSync(path.join(backupsDir, 'world_Spawn_2026-10-22-0304.tar.gz'), 'x');
    fs.writeFileSync(path.join(backupsDir, 'world_My World_20261022-030405.tar.gz'), 'x');

    const listed = (await worlds.listWorldBackups()).map((b) => b.world).sort();
    expect(listed).toEqual(['My World', 'Spawn']);
    expect(await worlds.deleteWorldBackup('world_Spawn_2026-10-22-0304.tar.gz')).toEqual({ success: true });
    expect(fs.existsSync(path.join(backupsDir, 'world_Spawn_2026-10-22-0304.tar.gz'))).toBe(false);
    expect(await worlds.deleteWorldBackup('world_x_2026-10-22.tar.gz')).toMatchObject({ success: false });
  });
});

describe.skipIf(!HAS_TAR)('world backup names', () => {
  it('are YYYYMMDD-HHMMSS and accepted by the restore', async () => {
    write('Spawn/region.bin', 'A');
    const created = await worlds.backupWorld('Spawn');
    expect(created.backup!.id).toMatch(/^world_Spawn_\d{8}-\d{6}\.tar\.gz$/);
  });
});
