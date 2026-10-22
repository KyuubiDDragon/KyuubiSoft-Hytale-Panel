/**
 * Integration test against a REAL bind mount, the layout of the manager
 * container (/opt/hytale/data is a mount point). Renaming the mount point
 * fails with EBUSY, which is what broke every restore before; the in-place
 * content swap has to work there.
 *
 * Runs only when KP_IT_DATA_MOUNT names such a mount point: in CI via
 * `mount --bind`, locally via manager/backend/scripts/test-restore-bindmount.sh
 * (Docker). Skipped everywhere else.
 */
import fs from 'fs';
import path from 'path';
import os from 'os';
import { describe, it, expect, vi } from 'vitest';

const MOUNT = process.env.KP_IT_DATA_MOUNT ?? '';
// The backups dir is on another filesystem than the mount, as in production.
const backupsDir = MOUNT ? fs.mkdtempSync(path.join(os.tmpdir(), 'kp-it-backups-')) : '';
const paths = { backups: backupsDir, data: MOUNT };
if (MOUNT) process.env.MANAGER_DATA_PATH = fs.mkdtempSync(path.join(os.tmpdir(), 'kp-it-manager-'));

const { lifecycle } = vi.hoisted(() => ({ lifecycle: [] as string[] }));
vi.mock('./backupCommon.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./backupCommon.js')>()),
  resolveBackupPaths: async () => paths,
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

const { createBackup } = await import('./backup.js');
const { startRestore } = await import('./backupRestore.js');
const { waitForBackupJob } = await import('./backupJobs.js');

function write(rel: string, content: string): void {
  const file = path.join(MOUNT, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}
const read = (rel: string) => fs.readFileSync(path.join(MOUNT, rel), 'utf8');

describe.skipIf(!MOUNT)('restore on a bind-mounted data dir', () => {
  it('cannot rename the mount point itself (EBUSY, the old restore path)', () => {
    let code: string | undefined;
    try {
      fs.renameSync(MOUNT, `${MOUNT}_restore_old`);
    } catch (err) {
      code = (err as NodeJS.ErrnoException).code;
    }
    expect(code).toBe('EBUSY');
  });

  it('restores by swapping the contents inside the mount', async () => {
    for (const entry of fs.readdirSync(MOUNT)) {
      fs.rmSync(path.join(MOUNT, entry), { recursive: true, force: true });
    }
    write('worlds/default/region.bin', 'state A');
    write('panel-config.json', 'panel A');
    write('.machine-id', 'machine A');
    const created = await createBackup('it');
    expect(created.success).toBe(true);

    write('worlds/default/region.bin', 'state B');
    write('players/b.json', 'B');
    write('panel-config.json', 'panel B');

    const started = await startRestore({ kind: 'panel', backupId: created.backup!.id });
    expect(started.ok).toBe(true);
    const job = (await waitForBackupJob((started as { job: { id: string } }).job.id))!;

    expect(job.error).toBeNull();
    expect(job.state).toBe('succeeded');
    expect(lifecycle).toEqual(['stop:restore', 'start']);
    expect(read('worlds/default/region.bin')).toBe('state A');
    expect(fs.existsSync(path.join(MOUNT, 'players'))).toBe(false);
    expect(read('panel-config.json')).toBe('panel B');
    expect(read('.machine-id')).toBe('machine A');
    expect(fs.readdirSync(MOUNT).filter((n) => n.startsWith('.kp-'))).toEqual([]);
    expect(fs.readdirSync(backupsDir).some((n) => n.startsWith('manual_pre_restore_'))).toBe(true);
  });
});
