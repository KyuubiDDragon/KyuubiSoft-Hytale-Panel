/**
 * Restore flow with a mocked server lifecycle: the archive is validated and
 * unpacked while the server runs, the server is stopped only around the
 * safety backup and the swap, the panel's files in the data dir survive, and
 * a refused archive never stops the server.
 *
 * Uses the system tar/unzip, so it runs on Linux/macOS (CI and the Docker
 * integration run) and is skipped on Windows.
 */
import fs from 'fs';
import path from 'path';
import os from 'os';
import { gzipSync } from 'zlib';
import { spawnSync } from 'child_process';
import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kp-restore-')));
const paths = { backups: path.join(root, 'backups'), data: path.join(root, 'data') };
process.env.MANAGER_DATA_PATH = path.join(root, 'manager');
fs.mkdirSync(process.env.MANAGER_DATA_PATH, { recursive: true });

const { lifecycle, serverState, treeRemovals } = vi.hoisted(() => ({
  lifecycle: [] as string[],
  serverState: { running: true },
  treeRemovals: { failMatching: null as string | null },
}));

vi.mock('../utils/noFollowFs.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../utils/noFollowFs.js')>();
  return {
    ...actual,
    removeTree: async (...args: Parameters<typeof actual.removeTree>) => {
      if (treeRemovals.failMatching && args[0].includes(treeRemovals.failMatching)) {
        throw Object.assign(new Error('simulated EBUSY'), { code: 'EBUSY' });
      }
      return actual.removeTree(...args);
    },
  };
});

vi.mock('./backupCommon.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./backupCommon.js')>()),
  resolveBackupPaths: async () => paths,
}));
vi.mock('./serverLifecycle.js', () => ({
  withServerStopped: vi.fn(
    async (_id: string | undefined, opts: { reason: string }, fn: () => Promise<unknown>) => {
      // What the data dir looked like when the server went down.
      const staged = fs.readdirSync(paths.data).some((n) => n.startsWith('.kp-restore-new-'));
      lifecycle.push(`stop:${opts.reason}:${staged ? 'staged' : 'not-staged'}`);
      serverState.running = false;
      try {
        return await fn();
      } finally {
        serverState.running = true;
        lifecycle.push('start');
      }
    },
  ),
}));
vi.mock('./docker.js', () => ({
  getStatus: async () => ({ status: 'running', running: serverState.running }),
  sendLifecycleCommand: async () => ({ success: true }),
  execCommand: async () => ({ success: true }),
  getLogs: async () => '',
}));

const { createBackup } = await import('./backup.js');
const { startRestore } = await import('./backupRestore.js');
const { waitForBackupJob } = await import('./backupJobs.js');

// GNU tar on Windows reads "C:\..." as a remote host; BusyBox has no --version.
const HAS_TOOLS =
  process.platform !== 'win32' &&
  spawnSync('sh', ['-c', 'command -v tar && command -v unzip'], { stdio: 'ignore' }).status === 0;

afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

function write(rel: string, content: string, base = paths.data): void {
  const file = path.join(base, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

const read = (rel: string) => fs.readFileSync(path.join(paths.data, rel), 'utf8');

async function finish(jobId: string) {
  return (await waitForBackupJob(jobId))!;
}

/** Minimal stored zip (what the server's native backup writes). */
function storedZip(files: Record<string, string>): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc32 = (buf: Buffer) => {
    let c = 0xffffffff;
    for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  for (const [name, content] of Object.entries(files)) {
    const nameBuf = Buffer.from(name);
    const data = Buffer.from(content);
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    const record = Buffer.concat([local, nameBuf, data]);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE((3 << 8) | 20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE((0o100644 << 16) >>> 0, 38);
    central.writeUInt32LE(offset, 42);
    centrals.push(Buffer.concat([central, nameBuf]));
    locals.push(record);
    offset += record.length;
  }
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(centrals.length, 8);
  eocd.writeUInt16LE(centrals.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, eocd]);
}

beforeEach(() => {
  lifecycle.length = 0;
  serverState.running = true;
  delete process.env.ARCHIVE_EXTRACT_MAX_GB;
  for (const dir of [paths.data, paths.backups]) {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
  }
});

describe('startRestore (input checks)', () => {
  it('answers 404 / 400 without starting a job', async () => {
    expect(await startRestore({ kind: 'panel', backupId: 'manual_missing' })).toMatchObject({
      ok: false,
      status: 404,
    });
    expect(await startRestore({ kind: 'panel', backupId: '../etc/passwd' })).toMatchObject({
      ok: false,
      status: 400,
    });
    expect(
      await startRestore({ kind: 'native', scope: 'recent', name: '../../x.zip' }),
    ).toMatchObject({ ok: false, status: 400 });
    expect(lifecycle).toEqual([]);
  });
});

describe.skipIf(!HAS_TOOLS)('restore of a panel backup', () => {
  it('stops the server only after unpacking, keeps panel files and writes a safety backup', async () => {
    write('worlds/default/region.bin', 'state A');
    write('warps.json', 'warps A');
    write('panel-config.json', 'panel config A');
    write('.machine-id', 'machine A');
    serverState.running = false; // offline backup: plain tar
    const created = await createBackup('before_test');
    expect(created.success).toBe(true);
    serverState.running = true;

    // The world moves on, the panel settings change.
    write('worlds/default/region.bin', 'state B');
    write('players/new.json', 'player B');
    fs.rmSync(path.join(paths.data, 'warps.json'));
    write('panel-config.json', 'panel config B');

    const started = await startRestore(
      { kind: 'panel', backupId: created.backup!.id },
      undefined,
      'alice',
    );
    expect(started.ok).toBe(true);
    const job = await finish((started as { job: { id: string } }).job.id);

    expect(job.state).toBe('succeeded');
    expect(job.message).toMatch(/previous state was saved as manual_pre_restore_/);
    expect(lifecycle).toEqual(['stop:restore:staged', 'start']);
    expect(read('worlds/default/region.bin')).toBe('state A');
    expect(read('warps.json')).toBe('warps A');
    expect(fs.existsSync(path.join(paths.data, 'players'))).toBe(false);
    expect(read('panel-config.json')).toBe('panel config B');
    expect(read('.machine-id')).toBe('machine A');
    expect(fs.readdirSync(paths.data).filter((n) => n.startsWith('.kp-'))).toEqual([]);

    // The safety backup holds state B.
    const safety = fs.readdirSync(paths.backups).find((n) => n.startsWith('manual_pre_restore_'))!;
    const listing = spawnSync('tar', [
      '-xzOf',
      path.join(paths.backups, safety),
      './worlds/default/region.bin',
    ]);
    expect(String(listing.stdout)).toBe('state B');
  });

  it('refuses an archive with a symlink without stopping the server', async () => {
    write('worlds/default/region.bin', 'live');
    const header = Buffer.alloc(512);
    header.write('escape', 0);
    header.write('0000777\0', 100);
    header.write('0000000\0', 108);
    header.write('0000000\0', 116);
    header.write('00000000000\0', 124);
    header.write('00000000000\0', 136);
    header.write('        ', 148);
    header.write('2', 156);
    header.write('/etc', 157);
    header.write('ustar\0', 257);
    header.write('00', 263);
    let sum = 0;
    for (const b of header) sum += b;
    header.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148);
    fs.writeFileSync(
      path.join(paths.backups, 'manual_evil_2026-10-22_000000.tar.gz'),
      gzipSync(Buffer.concat([header, Buffer.alloc(1024)])),
    );

    const started = await startRestore({
      kind: 'panel',
      backupId: 'manual_evil_2026-10-22_000000',
    });
    const job = await finish((started as { job: { id: string } }).job.id);

    expect(job.state).toBe('failed');
    expect(job.error).toMatch(/symbolic link.*no data was changed/s);
    expect(lifecycle).toEqual([]);
    expect(read('worlds/default/region.bin')).toBe('live');
  });

  it('refuses an archive above ARCHIVE_EXTRACT_MAX_GB without stopping the server', async () => {
    write('worlds/default/region.bin', 'x'.repeat(4096));
    serverState.running = false;
    const created = await createBackup('big');
    serverState.running = true;
    process.env.ARCHIVE_EXTRACT_MAX_GB = String(1024 / 1024 ** 3); // 1 KiB

    const started = await startRestore({ kind: 'panel', backupId: created.backup!.id });
    const job = await finish((started as { job: { id: string } }).job.id);

    expect(job.state).toBe('failed');
    expect(job.error).toMatch(/ARCHIVE_EXTRACT_MAX_GB/);
    expect(lifecycle).toEqual([]);
  });

  it('reports a restore as done when only removing the previous data fails', async () => {
    write('worlds/default/region.bin', 'state A');
    serverState.running = false;
    const created = await createBackup('cleanup');
    serverState.running = true;
    write('worlds/default/region.bin', 'state B');
    treeRemovals.failMatching = '.kp-restore-old-';
    try {
      const started = await startRestore({ kind: 'panel', backupId: created.backup!.id });
      const job = await finish((started as { job: { id: string } }).job.id);

      expect(job.state).toBe('succeeded');
      expect(job.message).toMatch(/could not be removed/);
      expect(read('worlds/default/region.bin')).toBe('state A');
      expect(lifecycle).toEqual(['stop:restore:staged', 'start']);
    } finally {
      treeRemovals.failMatching = null;
    }
  });

  it('allows one backup job at a time', async () => {
    write('worlds/default/region.bin', 'A');
    serverState.running = false;
    const created = await createBackup('twice');
    serverState.running = true;
    const first = await startRestore({ kind: 'panel', backupId: created.backup!.id });
    const second = await startRestore({ kind: 'panel', backupId: created.backup!.id });
    expect(second).toMatchObject({ ok: false, status: 409 });
    await finish((first as { job: { id: string } }).job.id);
  });
});

describe.skipIf(!HAS_TOOLS)('restore of a native backup', () => {
  it('replaces the universe with the zip and keeps the panel files', async () => {
    write('worlds/default/region.bin', 'current');
    write('panel-config.json', 'current panel config');
    const native = path.join(paths.backups, 'native');
    fs.mkdirSync(native, { recursive: true });
    // The server zips the whole universe dir, panel files included.
    fs.writeFileSync(
      path.join(native, '2026-10-22_03-00-00.zip'),
      storedZip({
        'worlds/default/region.bin': 'from native backup',
        'players/p.json': 'player',
        'panel-config.json': 'stale panel config',
      }),
    );

    const started = await startRestore({
      kind: 'native',
      scope: 'recent',
      name: '2026-10-22_03-00-00.zip',
    });
    const job = await finish((started as { job: { id: string } }).job.id);

    expect(job.state).toBe('succeeded');
    expect(job.type).toBe('native-restore');
    expect(read('worlds/default/region.bin')).toBe('from native backup');
    expect(read('players/p.json')).toBe('player');
    expect(read('panel-config.json')).toBe('current panel config');
    expect(lifecycle).toEqual(['stop:restore:staged', 'start']);
  });

  it('refuses an empty native zip (written while the universe was a symlink)', async () => {
    write('worlds/default/region.bin', 'current');
    const native = path.join(paths.backups, 'native');
    fs.mkdirSync(native, { recursive: true });
    fs.writeFileSync(path.join(native, '2026-10-21_03-00-00.zip'), storedZip({}));

    const started = await startRestore({
      kind: 'native',
      scope: 'recent',
      name: '2026-10-21_03-00-00.zip',
    });
    const job = await finish((started as { job: { id: string } }).job.id);

    expect(job.state).toBe('failed');
    expect(lifecycle).toEqual([]);
    expect(read('worlds/default/region.bin')).toBe('current');
  });
});
