/**
 * "Load all" from the server's own log files: newest first within the
 * limits, only the server's log names, and never through a link the game
 * server could have planted in its logs folder.
 */
import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kp-logfiles-'));
const serverPath = path.join(root, 'server');
const logsDir = path.join(serverPath, 'logs');

vi.mock('./serverInstall.js', () => ({
  resolveInstallPaths: async () => ({ serverPath, backupsPath: root, updaterPath: null }),
}));

const { readServerLogFiles } = await import('./serverLogFiles.js');

const OLD_RUN = '2026-10-27_22-12-06_server.log';
const NEW_RUN = '2026-10-28_09-00-00_server.log';
const LIMITS = { maxFiles: 5, maxBytes: 1024 * 1024, maxEntries: 1000 };

function record(time: string, message: string): string {
  return `[2026/10/28 ${time}   INFO]          [HytaleServer] ${message}\n`;
}

beforeEach(() => {
  fs.rmSync(serverPath, { recursive: true, force: true });
  fs.mkdirSync(logsDir, { recursive: true });
  fs.writeFileSync(path.join(logsDir, OLD_RUN), record('07:00:00', 'old run'));
  fs.writeFileSync(
    path.join(logsDir, NEW_RUN),
    record('09:00:00', 'new run') +
      '[2026/10/28 09:00:01 SEVERE]          [PluginManager] Failed\njava.lang.IllegalStateException: boom\n\tat a.B.c(B.java:1)\n' +
      record('09:00:02', 'done'),
  );
  fs.writeFileSync(path.join(logsDir, `${NEW_RUN}.lck`), '');
  fs.writeFileSync(path.join(logsDir, 'notes.txt'), record('09:30:00', 'not a log'));
});

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('server log files', () => {
  it('reads the runs oldest first and keeps a stack trace with its record', async () => {
    const r = await readServerLogFiles('default', LIMITS);
    expect(r?.files).toEqual([OLD_RUN, NEW_RUN]);
    expect(r?.truncated).toBe(false);
    expect(r?.entries.map((e) => [e.level, e.message.split('\n')[0]])).toEqual([
      ['INFO', 'old run'],
      ['INFO', 'new run'],
      ['ERROR', 'Failed'],
      ['INFO', 'done'],
    ]);
  });

  it('stops at the file and byte limits, newest first, starting at a whole line', async () => {
    const one = await readServerLogFiles('default', { ...LIMITS, maxFiles: 1 });
    expect(one?.files).toEqual([NEW_RUN]);
    expect(one?.truncated).toBe(true);

    const doneLine = record('09:00:02', 'done');
    const tight = await readServerLogFiles('default', { ...LIMITS, maxBytes: doneLine.length + 5 });
    expect(tight?.files).toEqual([NEW_RUN]);
    expect(tight?.entries.map((e) => e.message)).toEqual(['done']);
    expect(tight?.truncated).toBe(true);
  });

  it('keeps only the newest entries', async () => {
    const r = await readServerLogFiles('default', { ...LIMITS, maxEntries: 2 });
    expect(r?.entries.map((e) => e.message.split('\n')[0])).toEqual(['Failed', 'done']);
    expect(r?.truncated).toBe(true);
  });

  it('leaves out links to files elsewhere instead of reading them', async () => {
    const secret = path.join(root, 'secret.json');
    fs.writeFileSync(secret, record('09:59:59', 'panel secret'));
    let linked = 0;
    try {
      fs.symlinkSync(secret, path.join(logsDir, '2026-10-28_10-00-00_server.log'));
      linked++;
    } catch {
      // no symlink rights on this system
    }
    try {
      fs.linkSync(secret, path.join(logsDir, '2026-10-28_11-00-00_server.log'));
      linked++;
    } catch {
      // no hard links on this file system
    }
    const r = await readServerLogFiles('default', LIMITS);
    expect(r?.entries.some((e) => e.message.includes('panel secret'))).toBe(false);
    expect(r?.files).toEqual([OLD_RUN, NEW_RUN]);
    expect(linked).toBeGreaterThan(0);
  });

  it('answers null when the server has no logs folder the panel can see', async () => {
    fs.rmSync(logsDir, { recursive: true, force: true });
    expect(await readServerLogFiles('default', LIMITS)).toBeNull();
  });
});
