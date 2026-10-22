/**
 * The server's native backups: listing (recent + archive, in-progress .tmp),
 * path validation, and /backup with the waiting for the finished zip.
 */
import fs from 'fs';
import path from 'path';
import os from 'os';
import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kp-native-')));
const paths = { backups: path.join(root, 'backups'), data: path.join(root, 'data') };
const nativeDir = path.join(paths.backups, 'native');

const { docker } = vi.hoisted(() => ({
  docker: {
    running: true,
    logs: '',
    onCommand: (_command: string) => {},
    commands: [] as string[],
  },
}));
vi.mock('./backupCommon.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./backupCommon.js')>()),
  resolveBackupPaths: async () => paths,
  runBackupHookAsync: () => {},
}));
vi.mock('./offsiteBackup.js', () => ({ uploadBackupAsync: () => {} }));
vi.mock('./docker.js', () => ({
  getStatus: async () => ({
    status: docker.running ? 'running' : 'exited',
    running: docker.running,
  }),
  execCommand: async (command: string) => {
    docker.commands.push(command);
    docker.onCommand(command);
    return { success: true };
  },
  getLogs: async () => docker.logs,
}));

const native = await import('./nativeBackups.js');

afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

beforeEach(() => {
  fs.rmSync(paths.backups, { recursive: true, force: true });
  fs.mkdirSync(path.join(nativeDir, 'archive'), { recursive: true });
  docker.running = true;
  docker.logs = '';
  docker.commands = [];
  docker.onCommand = () => {};
});

const logLine = (text: string) => `${new Date(Date.now() + 500).toISOString()} ${text}\n`;

describe('listNativeBackups', () => {
  it('lists recent and archived zips, newest first, and reports a running backup', async () => {
    fs.writeFileSync(path.join(nativeDir, '2026-10-22_03-00-00.zip'), 'abc');
    fs.utimesSync(
      path.join(nativeDir, '2026-10-22_03-00-00.zip'),
      new Date('2026-10-22T03:00:00Z'),
      new Date('2026-10-22T03:00:00Z'),
    );
    fs.writeFileSync(path.join(nativeDir, 'archive', '2026-10-21_03-00-00.zip'), 'a');
    fs.utimesSync(
      path.join(nativeDir, 'archive', '2026-10-21_03-00-00.zip'),
      new Date('2026-10-21T03:00:00Z'),
      new Date('2026-10-21T03:00:00Z'),
    );
    fs.writeFileSync(path.join(nativeDir, '2026-10-22_04-00-00.zip.tmp'), 'partial');
    fs.writeFileSync(path.join(nativeDir, 'notes.txt'), 'ignored');

    const list = await native.listNativeBackups();
    expect(list.available).toBe(true);
    expect(list.inProgress).toBe(true);
    expect(list.backups.map((b) => [b.scope, b.name, b.size_bytes])).toEqual([
      ['recent', '2026-10-22_03-00-00.zip', 3],
      ['archive', '2026-10-21_03-00-00.zip', 1],
    ]);
  });

  it('reports a missing native directory as unavailable', async () => {
    fs.rmSync(nativeDir, { recursive: true, force: true });
    expect(await native.listNativeBackups()).toMatchObject({ available: false, backups: [] });
  });
});

describe('getNativeBackupPath / deleteNativeBackup', () => {
  it('resolves only valid names inside the native directory', async () => {
    fs.writeFileSync(path.join(nativeDir, 'archive', 'a.zip'), 'x');
    expect(await native.getNativeBackupPath('archive', 'a.zip')).toBe(
      path.join(nativeDir, 'archive', 'a.zip'),
    );
    expect(await native.getNativeBackupPath('recent', 'a.zip')).toBeNull();
    expect(await native.getNativeBackupPath('archive', '../archive/a.zip')).toBeNull();
    expect(await native.getNativeBackupPath('other', 'a.zip')).toBeNull();
    expect(await native.getNativeBackupPath('recent', 'a.zip.tmp')).toBeNull();
  });

  it('refuses a backup reached through a "native" folder that is a link', async () => {
    const outside = path.join(root, 'outside');
    fs.rmSync(outside, { recursive: true, force: true });
    fs.mkdirSync(path.join(outside, 'archive'), { recursive: true });
    fs.writeFileSync(path.join(outside, 'c.zip'), 'not a server backup');
    fs.rmSync(nativeDir, { recursive: true, force: true });
    fs.symlinkSync(outside, nativeDir, 'junction');

    expect(await native.getNativeBackupPath('recent', 'c.zip')).toBeNull();
    expect(await native.deleteNativeBackup('recent', 'c.zip')).toMatchObject({ success: false });
    expect(fs.existsSync(path.join(outside, 'c.zip'))).toBe(true);
    fs.rmSync(nativeDir, { force: true, recursive: true });
    fs.rmSync(outside, { recursive: true, force: true });
  });

  it('deletes a native backup', async () => {
    fs.writeFileSync(path.join(nativeDir, 'b.zip'), 'x');
    expect(await native.deleteNativeBackup('recent', 'b.zip')).toEqual({ success: true });
    expect(fs.existsSync(path.join(nativeDir, 'b.zip'))).toBe(false);
    expect(await native.deleteNativeBackup('recent', 'b.zip')).toMatchObject({ success: false });
  });
});

describe('createNativeBackup', () => {
  it('sends /backup and returns once the new zip is complete', async () => {
    fs.writeFileSync(path.join(nativeDir, 'old.zip'), 'old');
    docker.onCommand = () => {
      // The server writes <name>.zip.tmp first and renames it when done.
      const tmp = path.join(nativeDir, '2026-10-22_05-00-00.zip.tmp');
      fs.writeFileSync(tmp, 'zip');
      setTimeout(() => fs.renameSync(tmp, path.join(nativeDir, '2026-10-22_05-00-00.zip')), 30);
    };
    const created = await native.createNativeBackup(undefined, { pollMs: 10, timeoutMs: 5000 });
    expect(docker.commands).toEqual(['/backup']);
    expect(created).toMatchObject({
      name: '2026-10-22_05-00-00.zip',
      scope: 'recent',
      size_bytes: 3,
    });
  });

  it('refuses when the server is not running', async () => {
    docker.running = false;
    await expect(native.createNativeBackup()).rejects.toThrow(/must be running/);
    expect(docker.commands).toEqual([]);
  });

  it('explains a server started without --backup-dir', async () => {
    docker.onCommand = () => {
      docker.logs = logLine('The server must be started with --backup-dir to use this command!');
    };
    await expect(
      native.createNativeBackup(undefined, { pollMs: 10, timeoutMs: 5000 }),
    ).rejects.toThrow(/not configured/);
  });

  it('notices when the server wrote its backup somewhere else', async () => {
    docker.onCommand = () => {
      docker.logs = logLine('Backup completed!');
    };
    await expect(
      native.createNativeBackup(undefined, { pollMs: 10, timeoutMs: 5000 }),
    ).rejects.toThrow(/no new file appeared/);
  });
});
