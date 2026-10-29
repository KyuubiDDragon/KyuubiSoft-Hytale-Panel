/**
 * Panel self-backups live in the manager's own volume, and the copies older
 * versions left in `<backups>/_panel/` (readable by the game server) are
 * moved there once, without following anything the game server could have
 * planted in that folder.
 */
import fs from 'fs';
import path from 'path';
import os from 'os';
import { spawnSync } from 'child_process';
import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest';

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kp-panel-backups-')));
const managerDir = path.join(root, 'manager');
const backupsDir = path.join(root, 'backups');
const outsideDir = path.join(root, 'outside');
process.env.MANAGER_DATA_PATH = managerDir;

const { PANEL_BACKUP_DIR, IMPORTED_PANEL_BACKUP_DIR, migrateLegacyPanelBackups } =
  await import('./panelBackups.js');

const IS_WINDOWS = process.platform === 'win32';
// GNU tar on Windows reads "C:\..." as a remote host spec (see archiveSafety.test.ts).
const HAS_TAR = !IS_WINDOWS && spawnSync('tar', ['--version'], { stdio: 'ignore' }).status === 0;
const legacyDir = path.join(backupsDir, '_panel');
const NAME_A = 'panel-config_2026-10-20_030000.tar.gz';
const NAME_B = 'panel-config_2026-10-21_030000.tar.gz';

let warn: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  for (const dir of [managerDir, backupsDir, outsideDir]) {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
  }
  warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
});

afterEach(() => vi.restoreAllMocks());
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

function writeLegacy(name: string, content: string): string {
  fs.mkdirSync(legacyDir, { recursive: true });
  const file = path.join(legacyDir, name);
  fs.writeFileSync(file, content);
  return file;
}

const imported = (name: string) => path.join(IMPORTED_PANEL_BACKUP_DIR, `legacy-${name}`);
const warnings = () => warn.mock.calls.map((c: unknown[]) => String(c[0])).join('\n');

describe('panel self-backup location', () => {
  it('lies in the manager data volume, not on the backups volume', () => {
    expect(PANEL_BACKUP_DIR).toBe(path.join(managerDir, 'panel-backups'));
    expect(path.relative(managerDir, IMPORTED_PANEL_BACKUP_DIR).startsWith('..')).toBe(false);
  });

  it.skipIf(!HAS_TAR)(
    'backupPanelData writes there (owner-only) and nothing to the backups volume',
    async () => {
      fs.writeFileSync(path.join(managerDir, 'users.json'), '{"users":[]}');
      const { backupPanelData } = await import('./backup.js');

      const result = await backupPanelData();

      expect(result.success).toBe(true);
      expect(path.dirname(result.file!)).toBe(PANEL_BACKUP_DIR);
      // Never the old name, which the move of the old copies looks for.
      expect(path.basename(result.file!)).toMatch(/^panel-backup_.*\.tar\.gz$/);
      expect(fs.statSync(result.file!).mode & 0o777).toBe(0o600);
      expect(fs.statSync(PANEL_BACKUP_DIR).mode & 0o777).toBe(0o700);
      const listing = spawnSync('tar', ['-tzf', result.file!]).stdout.toString();
      expect(listing).toMatch(/panel\.sqlite/);
      expect(listing).toMatch(/users\.json/);
      expect(fs.readdirSync(backupsDir)).toEqual([]);
      // No staging folder left behind.
      expect(fs.readdirSync(PANEL_BACKUP_DIR).filter((n) => n.startsWith('.stage_'))).toEqual([]);
    },
  );
});

describe('migrateLegacyPanelBackups', () => {
  it('moves the old self-backups and removes them from the backups volume', async () => {
    writeLegacy(NAME_A, 'snapshot A');
    writeLegacy(NAME_B, 'snapshot B');

    await migrateLegacyPanelBackups([backupsDir]);

    expect(fs.readFileSync(imported(NAME_A), 'utf8')).toBe('snapshot A');
    expect(fs.readFileSync(imported(NAME_B), 'utf8')).toBe('snapshot B');
    if (!IS_WINDOWS) expect(fs.statSync(imported(NAME_A)).mode & 0o777).toBe(0o600);
    // Nothing of the panel's state is left where the game server can read it.
    expect(fs.existsSync(legacyDir)).toBe(false);
    expect(warnings()).toBe('');
  });

  it('names an unfinished snapshot instead of deleting a tree the game server controls', async () => {
    writeLegacy(NAME_A, 'snapshot A');
    const stage = path.join(legacyDir, '.stage_2026-10-21_040000');
    fs.mkdirSync(stage);
    fs.writeFileSync(path.join(stage, 'users.json'), 'hashes');

    await migrateLegacyPanelBackups([backupsDir]);

    expect(fs.readFileSync(imported(NAME_A), 'utf8')).toBe('snapshot A');
    expect(fs.existsSync(path.join(stage, 'users.json'))).toBe(true);
    expect(warnings()).toMatch(/\.stage_2026-10-21_040000 \(an unfinished panel backup/);
  });

  it('does not copy again when only removing the original fails', async () => {
    const original = writeLegacy(NAME_A, 'snapshot A');
    const realUnlink = fs.promises.unlink;
    vi.spyOn(fs.promises, 'unlink').mockImplementation(async (file) => {
      if (String(file) === original) {
        throw Object.assign(new Error('simulated EROFS'), { code: 'EROFS' });
      }
      return realUnlink(file);
    });

    await migrateLegacyPanelBackups([backupsDir]);
    await migrateLegacyPanelBackups([backupsDir]);

    expect(fs.readFileSync(imported(NAME_A), 'utf8')).toBe('snapshot A');
    expect(fs.existsSync(original)).toBe(true);
    expect(warnings()).toMatch(/could not be removed .*simulated EROFS.*delete it by hand/);
    // The run counts as done: no second copy on the next start.
    expect(fs.readdirSync(IMPORTED_PANEL_BACKUP_DIR)).toEqual([`legacy-${NAME_A}`]);
  });

  it('leaves a file behind when the manager volume is short of space', async () => {
    const original = writeLegacy(NAME_A, 'snapshot A');
    vi.spyOn(fs.promises, 'statfs').mockResolvedValue({
      bavail: 1,
      bsize: 1024,
    } as Awaited<ReturnType<typeof fs.promises.statfs>>);

    await migrateLegacyPanelBackups([backupsDir]);

    expect(fs.existsSync(imported(NAME_A))).toBe(false);
    expect(fs.existsSync(original)).toBe(true);
    expect(warnings()).toMatch(/not enough free space in the manager volume/);
  });

  it('runs only once, so files placed there later are not imported', async () => {
    await migrateLegacyPanelBackups([backupsDir]);
    writeLegacy(NAME_A, 'planted after the migration');

    await migrateLegacyPanelBackups([backupsDir]);

    expect(fs.existsSync(imported(NAME_A))).toBe(false);
    expect(fs.existsSync(path.join(legacyDir, NAME_A))).toBe(true);
  });

  it('leaves files alone that the panel never wrote and names them in a warning', async () => {
    writeLegacy(NAME_A, 'snapshot A');
    writeLegacy('notes.txt', 'something else');

    await migrateLegacyPanelBackups([backupsDir]);

    expect(fs.existsSync(imported(NAME_A))).toBe(true);
    expect(fs.existsSync(path.join(legacyDir, 'notes.txt'))).toBe(true);
    expect(warnings()).toMatch(/notes\.txt \(not a panel backup\)/);
  });

  it('keeps the original and retries on the next start when the copy fails', async () => {
    const original = writeLegacy(NAME_A, 'snapshot A');
    const realOpen = fs.promises.open;
    const spy = vi.spyOn(fs.promises, 'open').mockImplementation(async (file, ...rest) => {
      if (String(file).endsWith('.partial')) {
        throw Object.assign(new Error('simulated ENOSPC'), { code: 'ENOSPC' });
      }
      return realOpen(file, ...(rest as [string]));
    });

    await migrateLegacyPanelBackups([backupsDir]);

    expect(fs.readFileSync(original, 'utf8')).toBe('snapshot A');
    expect(fs.existsSync(imported(NAME_A))).toBe(false);
    expect(warnings()).toMatch(/Could not move .*simulated ENOSPC.*retried on the next start/);

    spy.mockRestore();
    await migrateLegacyPanelBackups([backupsDir]);
    expect(fs.readFileSync(imported(NAME_A), 'utf8')).toBe('snapshot A');
    expect(fs.existsSync(original)).toBe(false);
  });

  it('gives a second copy of the same name its own file', async () => {
    const other = path.join(root, 'backups-2');
    fs.rmSync(other, { recursive: true, force: true });
    fs.mkdirSync(path.join(other, '_panel'), { recursive: true });
    fs.writeFileSync(path.join(other, '_panel', NAME_A), 'from server 2');
    writeLegacy(NAME_A, 'from server 1');

    await migrateLegacyPanelBackups([backupsDir, other]);

    const contents = fs
      .readdirSync(IMPORTED_PANEL_BACKUP_DIR)
      .map((n) => fs.readFileSync(path.join(IMPORTED_PANEL_BACKUP_DIR, n), 'utf8'))
      .sort();
    expect(contents).toEqual(['from server 1', 'from server 2']);
    fs.rmSync(other, { recursive: true, force: true });
  });

  it('does not follow a _panel folder that is a link', async () => {
    fs.writeFileSync(path.join(outsideDir, NAME_A), 'not on the backups volume');
    fs.symlinkSync(outsideDir, legacyDir, 'junction');

    await migrateLegacyPanelBackups([backupsDir]);

    expect(fs.existsSync(imported(NAME_A))).toBe(false);
    expect(fs.readFileSync(path.join(outsideDir, NAME_A), 'utf8')).toBe(
      'not on the backups volume',
    );
    expect(warnings()).toMatch(/_panel \(not a real folder\)/);
  });

  it.skipIf(IS_WINDOWS)('does not copy through a file link planted in _panel', async () => {
    fs.writeFileSync(path.join(managerDir, 'users.json'), 'password hashes');
    fs.mkdirSync(legacyDir, { recursive: true });
    fs.symlinkSync(path.join(managerDir, 'users.json'), path.join(legacyDir, NAME_A));

    await migrateLegacyPanelBackups([backupsDir]);

    expect(fs.existsSync(imported(NAME_A))).toBe(false);
    expect(fs.readFileSync(path.join(managerDir, 'users.json'), 'utf8')).toBe('password hashes');
    expect(warnings()).toMatch(/it is a symbolic link/);
  });

  it.skipIf(IS_WINDOWS)('does not hang on a FIFO planted in _panel', async () => {
    fs.mkdirSync(legacyDir, { recursive: true });
    const made = spawnSync('mkfifo', [path.join(legacyDir, NAME_A)]);
    if (made.status !== 0) return; // no mkfifo on this host

    await migrateLegacyPanelBackups([backupsDir]);

    expect(fs.existsSync(imported(NAME_A))).toBe(false);
    expect(warnings()).toMatch(/not a regular file/);
  });

  it('does nothing when there is no old folder', async () => {
    await migrateLegacyPanelBackups([backupsDir, path.join(root, 'missing')]);
    expect(fs.readdirSync(IMPORTED_PANEL_BACKUP_DIR)).toEqual([]);
    expect(warnings()).toBe('');
  });
});
