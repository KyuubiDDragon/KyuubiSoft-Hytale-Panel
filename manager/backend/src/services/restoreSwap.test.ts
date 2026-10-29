/**
 * In-place content swap of a data directory (restore without renaming the
 * mount point): panel files survive, a failure rolls back, and a crash in the
 * middle is recovered from the journal.
 */
import fs from 'fs';
import path from 'path';
import os from 'os';
import { spawnSync } from 'child_process';
import { describe, it, beforeEach, afterEach, expect, vi } from 'vitest';
import {
  createRestoreStage,
  hasInterruptedRestore,
  isInternalDataEntry,
  recoverInterruptedRestore,
  swapDataContents,
} from './restoreSwap.js';

// Lets a test make the journal write of one phase fail.
const { journalWrites, treeRemovals } = vi.hoisted(() => ({
  journalWrites: { failPhase: null as string | null },
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
vi.mock('../utils/jsonStore.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../utils/jsonStore.js')>();
  return {
    ...actual,
    writeJsonAtomic: async (...args: Parameters<typeof actual.writeJsonAtomic>) => {
      const phase = (args[1] as { phase?: string } | null)?.phase;
      if (journalWrites.failPhase && phase === journalWrites.failPhase) {
        throw Object.assign(new Error('simulated ENOSPC'), { code: 'ENOSPC' });
      }
      return actual.writeJsonAtomic(...args);
    },
  };
});

let data: string;

beforeEach(() => {
  data = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kp-swap-')));
});

afterEach(() => {
  vi.restoreAllMocks();
  journalWrites.failPhase = null;
  treeRemovals.failMatching = null;
  fs.rmSync(data, { recursive: true, force: true });
});

function write(rel: string, content: string, root = data): void {
  const file = path.join(root, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

function read(rel: string): string {
  return fs.readFileSync(path.join(data, rel), 'utf8');
}

/** Current game state + panel files in `data`, a restored tree in a stage. */
async function setUp(): Promise<string> {
  write('worlds/default/chunks.bin', 'live world');
  write('players/a.json', 'live player');
  write('warps.json', 'live warps');
  write('panel-config.json', 'current panel config');
  write('.machine-id', 'current machine id');
  const stage = await createRestoreStage(data, '20261022_120000');
  write('worlds/default/chunks.bin', 'backup world', stage);
  write('memories.json', 'backup memories', stage);
  write('panel-config.json', 'OLD panel config', stage);
  write('.machine-id', 'OLD machine id', stage);
  write('hytale-auth.json', 'auth status from backup', stage);
  return stage;
}

describe('swapDataContents', () => {
  it('replaces the game entries, keeps the panel files and cleans up', async () => {
    const stage = await setUp();
    const result = await swapDataContents(data, stage, '20261022_120000');

    expect(read('worlds/default/chunks.bin')).toBe('backup world');
    expect(read('memories.json')).toBe('backup memories');
    // Entries the backup does not have are gone (a restore is a replacement, not a merge).
    expect(fs.existsSync(path.join(data, 'players'))).toBe(false);
    expect(fs.existsSync(path.join(data, 'warps.json'))).toBe(false);
    // Panel-owned files: the current copy wins ...
    expect(read('panel-config.json')).toBe('current panel config');
    expect(read('.machine-id')).toBe('current machine id');
    // ... and the archived copy only fills a gap.
    expect(read('hytale-auth.json')).toBe('auth status from backup');
    expect(result.kept.sort()).toEqual(['.machine-id', 'panel-config.json']);
    // No staging, old dir or journal left behind.
    expect(fs.readdirSync(data).filter(isInternalDataEntry)).toEqual([]);
  });

  it("never brings the manager volume's files back from an old archive", async () => {
    const stage = await setUp();
    write('setup-config.json', '{"server":{"password":"from backup"}}', stage);
    write('users.json', '{"users":[]}', stage);
    write('config.json', '{"jwtSecret":"from backup"}', stage);

    const result = await swapDataContents(data, stage, '20261022_120000');

    for (const name of ['setup-config.json', 'users.json', 'config.json']) {
      expect(fs.existsSync(path.join(data, name))).toBe(false);
      expect(result.restored).not.toContain(name);
    }
    expect(read('worlds/default/chunks.bin')).toBe('backup world');
  });

  it('refuses a stage outside the data dir', async () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'kp-swap-outside-'));
    try {
      await expect(swapDataContents(data, outside, 'x')).rejects.toThrow(/inside the data dir/);
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  it('rolls back to the previous state when moving the restored entries in fails', async () => {
    const stage = await setUp();
    const realRename = fs.promises.rename;
    vi.spyOn(fs.promises, 'rename').mockImplementation(async (from, to) => {
      // Fail when the restored memories.json is about to move in.
      if (
        String(from).endsWith(`${path.sep}memories.json`) &&
        String(from).includes('.kp-restore-new-')
      ) {
        throw Object.assign(new Error('simulated EIO'), { code: 'EIO' });
      }
      return realRename(from, to);
    });

    await expect(swapDataContents(data, stage, '20261022_120000')).rejects.toThrow(/simulated EIO/);

    expect(read('worlds/default/chunks.bin')).toBe('live world');
    expect(read('players/a.json')).toBe('live player');
    expect(read('warps.json')).toBe('live warps');
    expect(read('panel-config.json')).toBe('current panel config');
    expect(fs.existsSync(path.join(data, 'memories.json'))).toBe(false);
    expect(fs.existsSync(path.join(data, 'hytale-auth.json'))).toBe(false);
    expect(fs.readdirSync(data).filter(isInternalDataEntry)).toEqual([]);
  });

  it('rolls back when moving the current entries aside fails half-way', async () => {
    const stage = await setUp();
    const realRename = fs.promises.rename;
    vi.spyOn(fs.promises, 'rename').mockImplementation(async (from, to) => {
      if (String(from) === path.join(data, 'warps.json')) {
        throw Object.assign(new Error('simulated EACCES'), { code: 'EACCES' });
      }
      return realRename(from, to);
    });

    await expect(swapDataContents(data, stage, '20261022_120000')).rejects.toThrow(/EACCES/);

    expect(read('worlds/default/chunks.bin')).toBe('live world');
    expect(read('players/a.json')).toBe('live player');
    expect(read('warps.json')).toBe('live warps');
    expect(fs.readdirSync(data).filter(isInternalDataEntry)).toEqual([]);
  });

  it('keeps a finished swap when the journal cannot be advanced afterwards', async () => {
    const stage = await setUp();
    journalWrites.failPhase = 'cleanup';

    const result = await swapDataContents(data, stage, '20261022_120000');

    expect(read('worlds/default/chunks.bin')).toBe('backup world');
    expect(result.cleanupWarning).toBeUndefined();
    // No journal is left at "moving-in", so the next start does not undo the restore.
    expect(await hasInterruptedRestore(data)).toBe(false);
    expect(await recoverInterruptedRestore(data)).toBe('none');
    expect(read('worlds/default/chunks.bin')).toBe('backup world');
  });

  it('reports a finished swap with a warning when the leftovers cannot be removed', async () => {
    const stage = await setUp();
    treeRemovals.failMatching = '.kp-restore-old-';

    const result = await swapDataContents(data, stage, '20261022_120000');

    expect(result.cleanupWarning).toMatch(/could not be removed.*simulated EBUSY/);
    expect(read('worlds/default/chunks.bin')).toBe('backup world');
    treeRemovals.failMatching = null;
    // The journal says "cleanup": the next start finishes the job instead of rolling back.
    expect(await recoverInterruptedRestore(data)).toBe('cleaned-up');
    expect(read('worlds/default/chunks.bin')).toBe('backup world');
    expect(read('memories.json')).toBe('backup memories');
    expect(fs.readdirSync(data).filter(isInternalDataEntry)).toEqual([]);
  });
});

describe('recoverInterruptedRestore', () => {
  /**
   * Simulate a crash: from the rename matching `predicate` on, every rename
   * fails, so the in-process rollback cannot run either (like a dead process)
   * and the journal stays behind.
   */
  async function crashAt(predicate: (from: string) => boolean): Promise<void> {
    const stage = await setUp();
    const realRename = fs.promises.rename;
    let crashed = false;
    const spy = vi.spyOn(fs.promises, 'rename').mockImplementation(async (from, to) => {
      if (crashed || predicate(String(from))) {
        crashed = true;
        throw new Error('process died');
      }
      return realRename(from, to);
    });
    await expect(swapDataContents(data, stage, '20261022_120000')).rejects.toThrow(
      /could not be rolled back/,
    );
    spy.mockRestore();
  }

  it('rolls back a swap that died while moving the restored entries in', async () => {
    await crashAt(
      (from) => from.endsWith(`${path.sep}memories.json`) && from.includes('.kp-restore-new-'),
    );
    expect(await hasInterruptedRestore(data)).toBe(true);

    expect(await recoverInterruptedRestore(data)).toBe('rolled-back');

    expect(read('worlds/default/chunks.bin')).toBe('live world');
    expect(read('players/a.json')).toBe('live player');
    expect(read('panel-config.json')).toBe('current panel config');
    expect(fs.existsSync(path.join(data, 'memories.json'))).toBe(false);
    expect(fs.readdirSync(data).filter(isInternalDataEntry)).toEqual([]);
    expect(await hasInterruptedRestore(data)).toBe(false);
  });

  it('rolls back a swap that died while moving the current entries aside', async () => {
    await crashAt((from) => from === path.join(data, 'warps.json'));

    expect(await recoverInterruptedRestore(data)).toBe('rolled-back');

    expect(read('worlds/default/chunks.bin')).toBe('live world');
    expect(read('warps.json')).toBe('live warps');
    expect(fs.readdirSync(data).filter(isInternalDataEntry)).toEqual([]);
  });

  it('removes a staging dir left by a crash during extraction (no journal)', async () => {
    await setUp();
    expect(await recoverInterruptedRestore(data)).toBe('none');
    expect(fs.readdirSync(data).filter(isInternalDataEntry)).toEqual([]);
    expect(read('worlds/default/chunks.bin')).toBe('live world');
  });

  it('keeps the stage of the restore that is about to run', async () => {
    const stage = await setUp();
    await recoverInterruptedRestore(data, { keep: stage });
    expect(fs.existsSync(stage)).toBe(true);
  });

  it('discards a tampered journal instead of moving files around', async () => {
    await setUp();
    write(
      '.kp-restore-journal.json',
      JSON.stringify({ version: 1, stage: '../../etc', old: 'x', phase: 'moving-in', moveIn: [] }),
    );
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect(await recoverInterruptedRestore(data)).toBe('discarded');
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/Discarded the restore journal/));
    expect(read('worlds/default/chunks.bin')).toBe('live world');
    expect(await hasInterruptedRestore(data)).toBe(false);
  });
});

describe('recoverInterruptedRestore with a journal the panel did not write', () => {
  const JOURNAL = '.kp-restore-journal.json';
  const IS_WINDOWS = process.platform === 'win32';
  let outside: string;

  beforeEach(() => {
    outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kp-swap-outside-')));
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    fs.rmSync(outside, { recursive: true, force: true });
  });

  function journal(fields: Record<string, unknown> = {}): string {
    return JSON.stringify({
      version: 1,
      stage: '.kp-restore-new-20261022_120000',
      old: '.kp-restore-old-20261022_120000',
      phase: 'moving-out',
      moveIn: [],
      ...fields,
    });
  }

  /** A restore right after the recovery still works: the journal no longer blocks it. */
  async function expectRestoreStillWorks(): Promise<void> {
    const stage = await createRestoreStage(data, '20261022_130000');
    write('worlds/default/chunks.bin', 'restored later', stage);
    await recoverInterruptedRestore(data, { keep: stage });
    await swapDataContents(data, stage, '20261022_130000');
    expect(read('worlds/default/chunks.bin')).toBe('restored later');
  }

  it('discards a journal whose old dir is a link and leaves the link target alone', async () => {
    write('worlds/default/chunks.bin', 'live world');
    write('secret.txt', 'panel secret', outside);
    // A junction needs no privileges on Windows; elsewhere it is a plain symlink.
    fs.symlinkSync(outside, path.join(data, '.kp-restore-old-20261022_120000'), 'junction');
    write(JOURNAL, journal());

    expect(await recoverInterruptedRestore(data)).toBe('discarded');

    // A rollback would have moved secret.txt into the data dir.
    expect(fs.existsSync(path.join(data, 'secret.txt'))).toBe(false);
    expect(fs.readFileSync(path.join(outside, 'secret.txt'), 'utf8')).toBe('panel secret');
    expect(fs.existsSync(path.join(data, JOURNAL))).toBe(false);
    await expectRestoreStillWorks();
  });

  it('discards a journal whose stage is a file instead of a directory', async () => {
    write('worlds/default/chunks.bin', 'live world');
    write('.kp-restore-new-20261022_120000', 'not a dir');
    write(JOURNAL, journal({ phase: 'moving-in', moveIn: ['worlds'] }));

    expect(await recoverInterruptedRestore(data)).toBe('discarded');
    expect(read('worlds/default/chunks.bin')).toBe('live world');
  });

  it('discards a journal whose stage and old dir belong to different restores', async () => {
    write('worlds/default/chunks.bin', 'live world');
    write(JOURNAL, journal({ old: '.kp-restore-old-20261022_999999' }));

    expect(await recoverInterruptedRestore(data)).toBe('discarded');
    expect(read('worlds/default/chunks.bin')).toBe('live world');
  });

  it('discards a journal that is not JSON without keeping a copy of it', async () => {
    write('worlds/default/chunks.bin', 'live world');
    write(JOURNAL, 'SQLite format 3\0 panel data');

    expect(await recoverInterruptedRestore(data)).toBe('discarded');
    expect(fs.readdirSync(data).filter((n) => n.includes('corrupt'))).toEqual([]);
    await expectRestoreStillWorks();
  });

  it.skipIf(IS_WINDOWS)('does not read a journal that is a link to a panel file', async () => {
    write('worlds/default/chunks.bin', 'live world');
    write('panel.sqlite', 'SQLite format 3\0 api keys', outside);
    fs.symlinkSync(path.join(outside, 'panel.sqlite'), path.join(data, JOURNAL));

    expect(await recoverInterruptedRestore(data)).toBe('discarded');

    // No copy of the target lands in the data dir the game server can read.
    expect(fs.readdirSync(data).filter((n) => n.includes('corrupt'))).toEqual([]);
    expect(fs.existsSync(path.join(data, JOURNAL))).toBe(false);
    expect(fs.readFileSync(path.join(outside, 'panel.sqlite'), 'utf8')).toContain('api keys');
  });

  it.skipIf(IS_WINDOWS)('does not hang on a journal that is a FIFO', async () => {
    write('worlds/default/chunks.bin', 'live world');
    const made = spawnSync('mkfifo', [path.join(data, JOURNAL)]);
    if (made.status !== 0) return; // no mkfifo on this host

    expect(await recoverInterruptedRestore(data)).toBe('discarded');
    expect(fs.existsSync(path.join(data, JOURNAL))).toBe(false);
  });

  it('sets a journal aside whose rollback cannot finish, so later restores still run', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    write('worlds/default/chunks.bin', 'live world');
    // A "previous" worlds folder that cannot be moved back over the live one.
    write('.kp-restore-old-20261022_120000/worlds/other/x.bin', 'planted');
    write(JOURNAL, journal());

    expect(await recoverInterruptedRestore(data)).toBe('failed');

    expect(error).toHaveBeenCalledWith(expect.stringMatching(/no longer blocks restores/));
    expect(read('worlds/default/chunks.bin')).toBe('live world');
    expect(fs.existsSync(path.join(data, JOURNAL))).toBe(false);
    expect(fs.readdirSync(data).some((n) => n.startsWith('.kp-restore-journal-failed-'))).toBe(
      true,
    );
    // Kept for a manual fix, never part of a swap or a backup.
    expect(fs.existsSync(path.join(data, '.kp-restore-old-20261022_120000/worlds'))).toBe(true);
    await expectRestoreStillWorks();
  });

  it('treats a journal that vanishes during the boot check as none', async () => {
    write('worlds/default/chunks.bin', 'live world');
    write(JOURNAL, journal());
    const realLstat = fs.promises.lstat;
    vi.spyOn(fs.promises, 'lstat').mockImplementation(async (p, ...rest) => {
      if (String(p).endsWith(JOURNAL)) {
        throw Object.assign(new Error('simulated ENOENT'), { code: 'ENOENT' });
      }
      return realLstat(p, ...(rest as []));
    });
    expect(await recoverInterruptedRestore(data, { startedBefore: Date.now() + 1000 })).toBe(
      'none',
    );
  });

  it('refuses a restore timestamp that would not survive the journal check', async () => {
    await expect(createRestoreStage(data, '../x')).rejects.toThrow(/Restore timestamp/);
  });
});
