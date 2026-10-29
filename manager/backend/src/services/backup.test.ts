/**
 * Panel backup naming and retention selection: only backups the panel made
 * automatically (exact prefix) are subject to retention, never a manual one
 * whose name happens to contain "auto".
 */
import fs from 'fs';
import path from 'path';
import os from 'os';
import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kp-backup-names-')));
const paths = { backups: path.join(root, 'backups'), data: path.join(root, 'data') };
process.env.MANAGER_DATA_PATH = path.join(root, 'manager');
fs.mkdirSync(process.env.MANAGER_DATA_PATH, { recursive: true });

vi.mock('./backupCommon.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./backupCommon.js')>()),
  resolveBackupPaths: async () => paths,
}));

const { isAutomaticBackupId, listBackups, backupTimestamp, safetyBackupName, withBackupLock } =
  await import('./backup.js');

afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

beforeEach(() => {
  fs.rmSync(paths.backups, { recursive: true, force: true });
  fs.mkdirSync(paths.backups, { recursive: true });
});

describe('isAutomaticBackupId', () => {
  it('accepts the automatic prefix and the two legacy scheduler names', () => {
    expect(isAutomaticBackupId('auto_daily_2026-10-22_030000')).toBe(true);
    expect(isAutomaticBackupId('auto_scheduled_restart_2026-10-22_030000')).toBe(true);
    expect(isAutomaticBackupId('auto_event_2026-10-22_030000')).toBe(true);
    // Written by the scheduler before automatic backups had their own prefix
    // (and before the timestamp had seconds).
    expect(isAutomaticBackupId('manual_auto_2026-10-22_0300')).toBe(true);
    expect(isAutomaticBackupId('manual_scheduled_restart_2026-10-22_0300')).toBe(true);
    expect(isAutomaticBackupId('manual_auto_2026-10-22_030000')).toBe(true);
  });

  it('never treats a manual backup as automatic because of its name', () => {
    expect(isAutomaticBackupId('manual_autumn_2026-10-22_030000')).toBe(false);
    expect(isAutomaticBackupId('manual_before_auto_update_2026-10-22_030000')).toBe(false);
    expect(isAutomaticBackupId('manual_my_scheduled_test_2026-10-22_030000')).toBe(false);
    expect(isAutomaticBackupId('manual_auto_2026-10-22_030000_copy')).toBe(false);
    expect(isAutomaticBackupId('manual_2026-10-22_030000')).toBe(false);
    // The safety copy of a restore is kept until it is deleted by hand.
    expect(isAutomaticBackupId(safetyBackupName('2026-10-22_030000'))).toBe(false);
    // Native/other files that merely start with "auto".
    expect(isAutomaticBackupId('autosave')).toBe(false);
    expect(isAutomaticBackupId('auto_2026-10-22_030000')).toBe(false);
  });
});

describe('listBackups type', () => {
  it('derives "auto" from the exact prefix only', async () => {
    for (const name of [
      'auto_daily_2026-10-22_030000.tar.gz',
      'manual_autumn_2026-10-22_030000.tar.gz',
      'manual_auto_2026-10-22_030000.tar.gz',
      'manual_2026-10-22_030000.tar.gz',
    ]) {
      fs.writeFileSync(path.join(paths.backups, name), 'x');
    }
    const types = Object.fromEntries((await listBackups()).map((b) => [b.id, b.type]));
    expect(types).toEqual({
      'auto_daily_2026-10-22_030000': 'auto',
      'manual_autumn_2026-10-22_030000': 'manual',
      'manual_auto_2026-10-22_030000': 'auto',
      'manual_2026-10-22_030000': 'manual',
    });
  });

  it('does not list the native backup folder or the panel self-backups', async () => {
    fs.mkdirSync(path.join(paths.backups, 'native', 'archive'), { recursive: true });
    fs.writeFileSync(path.join(paths.backups, 'native', '2026-10-22_03-00-00.zip'), 'x');
    fs.mkdirSync(path.join(paths.backups, '_panel'), { recursive: true });
    expect(await listBackups()).toEqual([]);
  });
});

describe('backupTimestamp', () => {
  it('is YYYY-MM-DD_HHMMSS in UTC', () => {
    expect(backupTimestamp(new Date('2026-10-22T03:04:05.678Z'))).toBe('2026-10-22_030405');
  });
});

describe('withBackupLock', () => {
  it('runs operations one after another and is released after each (also after a failure)', async () => {
    const order: string[] = [];
    const slow = (name: string, ms: number) =>
      withBackupLock(async () => {
        order.push(`start ${name}`);
        await new Promise((r) => setTimeout(r, ms));
        order.push(`end ${name}`);
        return name;
      });
    const a = slow('a', 20);
    const failing = withBackupLock(async () => {
      order.push('start failing');
      throw new Error('boom');
    });
    const b = slow('b', 5);
    const results = await Promise.allSettled([a, failing, b]);
    expect(results.map((r) => r.status)).toEqual(['fulfilled', 'rejected', 'fulfilled']);
    expect(order).toEqual(['start a', 'end a', 'start failing', 'start b', 'end b']);
    // Regression: a later operation must still get the lock (the old lock was
    // never released and the next caller spun forever).
    await expect(withBackupLock(() => 'again')).resolves.toBe('again');
    await expect(withBackupLock(() => 'and again')).resolves.toBe('and again');
  });
});

describe('freeTimestampedPath', () => {
  it('moves the timestamp forward instead of overwriting a backup from the same second', async () => {
    const { freeTimestampedPath } = await import('./backupCommon.js');
    const at = new Date('2026-10-22T03:04:05.000Z');
    const make = (d: Date) => path.join(paths.backups, `manual_${backupTimestamp(d)}.tar.gz`);
    fs.writeFileSync(make(at), 'first');
    expect(path.basename(freeTimestampedPath(make, at))).toBe('manual_2026-10-22_030406.tar.gz');
  });
});
