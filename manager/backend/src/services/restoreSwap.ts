/**
 * Swap the CONTENTS of a server data directory for a restored tree.
 *
 * The data directory is a Docker bind mount in the manager container, so it
 * can't be renamed (rename(2) on a mount point fails with EBUSY). Instead the
 * restored tree is staged inside the directory itself and its top-level
 * entries are exchanged one by one: every rename stays on the same
 * filesystem, so each step is atomic and no data is copied.
 *
 *   <data>/.kp-restore-new-<ts>/   restored tree (extracted by the caller)
 *   <data>/.kp-restore-old-<ts>/   the previous entries, moved aside
 *   <data>/.kp-restore-journal.json
 *
 * The journal records the phase before each half of the swap, so a crash in
 * the middle can be rolled back exactly (recoverInterruptedRestore, run on
 * boot and before every swap). Entries the panel keeps in the data directory
 * (panel-config.json, .machine-id, tracking files) are never replaced: the
 * current copy wins, the archived copy is used only when there is none.
 */
import path from 'path';
import { constants as fsConstants, promises as fsp } from 'fs';
import { writeJsonAtomic } from '../utils/jsonStore.js';
import { removeTree } from '../utils/noFollowFs.js';

/**
 * Top-level files the panel and the container entrypoint keep in the data
 * directory. They describe the installation, not the game state, so a
 * restore must not roll them back (a stale panel-config.json would revert JVM
 * and startup settings, a different .machine-id breaks the encrypted server
 * credentials, tracking files would no longer match the installed mods, and
 * .server-exit is the start script's guard against pointless Docker retries).
 */
export const PANEL_OWNED_DATA_ENTRIES: ReadonlySet<string> = new Set([
  'panel-config.json',
  '.machine-id',
  '.server-exit',
  'setup-config.json',
  'config.json',
  'users.json',
  'manager-config.json',
  'hytale-auth.json',
  'update-history.json',
  'cfwidget-tracked.json',
  'curseforge-installed.json',
  'modtale-installed.json',
  'stackmart-installed.json',
]);

const RESTORE_PREFIX = '.kp-restore-';
const STAGE_PREFIX = `${RESTORE_PREFIX}new-`;
const OLD_PREFIX = `${RESTORE_PREFIX}old-`;
const JOURNAL_NAME = `${RESTORE_PREFIX}journal.json`;
// The <ts> part of the stage and old dir names (a backup timestamp).
const SWAP_SUFFIX = /^[A-Za-z0-9_-]{1,64}$/;
// A real journal is a few hundred bytes; anything larger is not one.
const JOURNAL_MAX_BYTES = 64 * 1024;
// O_NOFOLLOW is POSIX only; on Windows (dev/tests) it is undefined.
const NO_FOLLOW = fsConstants.O_NOFOLLOW ?? 0;
const NON_BLOCK = fsConstants.O_NONBLOCK ?? 0;

/**
 * Names the panel creates inside the data directory while it works on it
 * (restore staging, archive extraction staging, write probes). They are never
 * moved, never restored from an archive and excluded from panel backups.
 */
export const INTERNAL_DATA_PREFIXES: readonly string[] = [
  RESTORE_PREFIX,
  '.kp-extract-',
  '.write-test-',
];

export function isInternalDataEntry(name: string): boolean {
  return INTERNAL_DATA_PREFIXES.some((prefix) => name.startsWith(prefix));
}

export function isPanelOwnedDataEntry(name: string): boolean {
  return PANEL_OWNED_DATA_ENTRIES.has(name);
}

/**
 * Panel files that older versions kept in the data directory and that live in
 * the manager volume now (JWT secret, password hashes, setup secrets). An
 * archive's copy is never brought back into the data directory.
 */
const MANAGER_VOLUME_FILES: ReadonlySet<string> = new Set([
  'setup-config.json',
  'config.json',
  'users.json',
]);

type SwapPhase = 'moving-out' | 'moving-in' | 'cleanup';

interface RestoreJournal {
  version: 1;
  stage: string; // directory names inside the data dir
  old: string;
  phase: SwapPhase;
  /** Entries that are moved from the stage into the data dir. */
  moveIn: string[];
}

export interface SwapResult {
  replaced: string[]; // previous entries that were moved aside (and then deleted)
  restored: string[]; // entries taken from the archive
  kept: string[]; // panel-owned entries that stayed as they were
  /** Set when the swap succeeded but the leftovers could not be removed. */
  cleanupWarning?: string;
}

// The journal names the stage and old dir by this suffix; recovery refuses others.
function assertSwapSuffix(ts: string): void {
  if (!SWAP_SUFFIX.test(ts)) {
    throw new Error('Restore timestamp may only contain letters, digits, "_" and "-"');
  }
}

/** Create an empty staging directory inside `dataDir` for the restored tree. */
export async function createRestoreStage(dataDir: string, ts: string): Promise<string> {
  assertSwapSuffix(ts);
  const stage = path.join(dataDir, `${STAGE_PREFIX}${ts}`);
  await removeTree(stage, [dataDir]);
  await fsp.mkdir(stage);
  return stage;
}

/** Top-level names of a staged tree that a swap would bring into the data dir. */
export async function stagedEntries(stageDir: string): Promise<string[]> {
  return (await fsp.readdir(stageDir)).filter((name) => !isInternalDataEntry(name));
}

async function exists(p: string): Promise<boolean> {
  try {
    await fsp.lstat(p);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw err;
  }
}

function journalPath(dataDir: string): string {
  return path.join(dataDir, JOURNAL_NAME);
}

async function writeJournal(dataDir: string, journal: RestoreJournal): Promise<void> {
  await writeJsonAtomic(journalPath(dataDir), journal, { mode: 0o600 });
}

/** A plain entry name directly inside the data dir (no separators, not . or ..). */
function isPlainName(name: unknown): name is string {
  return (
    typeof name === 'string' &&
    name !== '' &&
    name !== '.' &&
    name !== '..' &&
    !/[/\\\0]/.test(name) &&
    path.basename(name) === name
  );
}

// The journal lives in a directory the game server (and its mods) can write
// to, so it is checked strictly before anything is moved because of it.
function isValidJournal(value: unknown): value is RestoreJournal {
  const j = value as RestoreJournal;
  return (
    !!j &&
    j.version === 1 &&
    isPlainName(j.stage) &&
    j.stage.startsWith(STAGE_PREFIX) &&
    isPlainName(j.old) &&
    j.old.startsWith(OLD_PREFIX) &&
    // Both are named after the same restore, as swapDataContents writes them.
    SWAP_SUFFIX.test(j.stage.slice(STAGE_PREFIX.length)) &&
    j.old.slice(OLD_PREFIX.length) === j.stage.slice(STAGE_PREFIX.length) &&
    ['moving-out', 'moving-in', 'cleanup'].includes(j.phase) &&
    Array.isArray(j.moveIn) &&
    j.moveIn.every((n) => isPlainName(n) && !isInternalDataEntry(n))
  );
}

type JournalRead =
  | { kind: 'none' }
  | { kind: 'invalid'; reason: string }
  | { kind: 'valid'; journal: RestoreJournal };

/**
 * Read the journal without following a link: a journal that points at a
 * panel file must not be read (let alone copied next to it, as the generic
 * JSON reader does with a damaged file). FIFOs and oversized files are not
 * journals either.
 */
async function readJournal(dataDir: string): Promise<JournalRead> {
  let handle: Awaited<ReturnType<typeof fsp.open>>;
  try {
    handle = await fsp.open(journalPath(dataDir), fsConstants.O_RDONLY | NO_FOLLOW | NON_BLOCK);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return { kind: 'none' };
    if (code === 'ELOOP') return { kind: 'invalid', reason: 'it is a symbolic link' };
    throw err;
  }
  try {
    const st = await handle.stat();
    if (!st.isFile()) return { kind: 'invalid', reason: 'it is not a regular file' };
    if (st.size > JOURNAL_MAX_BYTES) return { kind: 'invalid', reason: 'it is too large' };
    const buf = Buffer.alloc(st.size);
    let read = 0;
    while (read < buf.length) {
      const { bytesRead } = await handle.read(buf, read, buf.length - read, read);
      if (bytesRead === 0) break;
      read += bytesRead;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(buf.toString('utf8', 0, read));
    } catch {
      return { kind: 'invalid', reason: 'it is not valid JSON' };
    }
    return isValidJournal(parsed)
      ? { kind: 'valid', journal: parsed }
      : { kind: 'invalid', reason: 'it does not describe a restore of this panel' };
  } finally {
    await handle.close();
  }
}

/**
 * The stage and old dir a journal names may be missing (a swap that died
 * before mkdir, a half-finished cleanup), but if they exist they must be real
 * directories directly in the data dir: a rollback reads and renames inside
 * them, and a link would carry that somewhere else.
 */
async function journalDirProblem(dataDir: string, journal: RestoreJournal): Promise<string | null> {
  for (const name of [journal.stage, journal.old]) {
    let st;
    try {
      st = await fsp.lstat(path.join(dataDir, name));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw err;
    }
    if (!st.isDirectory()) return `${name} is not a plain directory`;
  }
  return null;
}

async function finishCleanup(dataDir: string, journal: RestoreJournal): Promise<void> {
  // The data dir is server-writable: delete without following swapped-in links.
  await removeTree(path.join(dataDir, journal.old), [dataDir]);
  await removeTree(path.join(dataDir, journal.stage), [dataDir]);
  await fsp.rm(journalPath(dataDir), { force: true });
}

/**
 * Undo an unfinished swap. In 'moving-in' the entries already taken from the
 * stage go back into it first; in both phases everything in the old dir then
 * returns to the data dir. Afterwards the data dir holds exactly the previous
 * entries again.
 */
/**
 * Checked again right before every read and rename inside the stage or old
 * dir: one swapped for a link after the journal check must not carry the
 * rollback out of the data dir.
 */
async function assertPlainDir(dir: string): Promise<void> {
  if (!(await fsp.lstat(dir)).isDirectory()) {
    throw new Error(`${dir} is no longer a plain directory`);
  }
}

async function rollback(dataDir: string, journal: RestoreJournal): Promise<void> {
  const stageDir = path.join(dataDir, journal.stage);
  const oldDir = path.join(dataDir, journal.old);
  if (journal.phase === 'moving-in') {
    await fsp.mkdir(stageDir, { recursive: true });
    for (const name of journal.moveIn) {
      const current = path.join(dataDir, name);
      await assertPlainDir(stageDir);
      if ((await exists(current)) && !(await exists(path.join(stageDir, name)))) {
        await fsp.rename(current, path.join(stageDir, name));
      }
    }
  }
  if (await exists(oldDir)) {
    await assertPlainDir(oldDir);
    for (const name of await fsp.readdir(oldDir)) {
      await assertPlainDir(oldDir);
      await fsp.rename(path.join(oldDir, name), path.join(dataDir, name));
    }
  }
  await finishCleanup(dataDir, journal);
}

/**
 * Replace the game entries of `dataDir` with the entries of `stageDir` (a
 * directory directly inside `dataDir`, see createRestoreStage). On any error
 * the previous state is restored before the error is rethrown.
 */
export async function swapDataContents(
  dataDir: string,
  stageDir: string,
  ts: string,
): Promise<SwapResult> {
  if (path.dirname(stageDir) !== dataDir || !path.basename(stageDir).startsWith(STAGE_PREFIX)) {
    throw new Error('Restore staging must be a .kp-restore-new-* directory inside the data dir');
  }
  assertSwapSuffix(ts);
  const current = (await fsp.readdir(dataDir)).filter((name) => !isInternalDataEntry(name));
  const moveOut = current.filter((name) => !isPanelOwnedDataEntry(name));
  const kept = current.filter(isPanelOwnedDataEntry);
  const incoming = await stagedEntries(stageDir);
  // Panel-owned entries from the archive only fill a gap (e.g. a lost .machine-id).
  const moveIn = incoming.filter(
    (name) =>
      !MANAGER_VOLUME_FILES.has(name) && !(isPanelOwnedDataEntry(name) && kept.includes(name)),
  );

  const journal: RestoreJournal = {
    version: 1,
    stage: path.basename(stageDir),
    old: `${OLD_PREFIX}${ts}`,
    phase: 'moving-out',
    moveIn,
  };
  const oldDir = path.join(dataDir, journal.old);
  // Journal first: a crash right after mkdir must not leave an untracked old dir.
  await writeJournal(dataDir, journal);
  await fsp.mkdir(oldDir);
  try {
    for (const name of moveOut) {
      await fsp.rename(path.join(dataDir, name), path.join(oldDir, name));
    }
    journal.phase = 'moving-in';
    await writeJournal(dataDir, journal);
    for (const name of moveIn) {
      await fsp.rename(path.join(stageDir, name), path.join(dataDir, name));
    }
  } catch (err) {
    try {
      await rollback(dataDir, journal);
    } catch (rollbackErr) {
      const reason = rollbackErr instanceof Error ? rollbackErr.message : String(rollbackErr);
      throw new RestoreRollbackError(
        `Restore failed (${err instanceof Error ? err.message : err}) and could not be rolled back ` +
          `automatically (${reason}). The previous data is in ${oldDir}; the journal ` +
          `${journalPath(dataDir)} lets the panel retry the rollback on its next start.`,
      );
    }
    throw err;
  }
  // Commit point: the restored entries are live. Nothing after this may throw,
  // and the journal must never stay at 'moving-in', or the next start would
  // roll back a restore that succeeded.
  let cleanupWarning: string | undefined;
  try {
    journal.phase = 'cleanup';
    await writeJournal(dataDir, journal);
  } catch {
    await fsp.rm(journalPath(dataDir), { force: true }).catch(() => undefined);
  }
  try {
    await finishCleanup(dataDir, journal);
  } catch (err) {
    cleanupWarning = `the previous data could not be removed from ${oldDir} (${
      err instanceof Error ? err.message : err
    }); delete it by hand`;
  }
  return { replaced: moveOut, restored: moveIn, kept, cleanupWarning };
}

/**
 * 'discarded': the journal was not one this panel wrote; it was removed,
 * nothing was moved. 'failed': the rollback or cleanup it asked for did not
 * finish; the journal was set aside (logged) so it no longer blocks restores.
 */
export type RecoveryOutcome = 'none' | 'rolled-back' | 'cleaned-up' | 'discarded' | 'failed';

/**
 * Roll back or clean up what a valid journal describes. If that fails, the
 * journal is moved aside instead of failing every later restore and boot
 * with the same error: whatever could not be moved back stays in the old
 * dir (excluded from swaps and backups by its prefix) for a manual fix, and
 * the next restore takes a safety backup of the state as it is.
 */
async function finishFromJournal(
  dataDir: string,
  journal: RestoreJournal,
): Promise<RecoveryOutcome> {
  try {
    if (journal.phase === 'cleanup') {
      await finishCleanup(dataDir, journal);
      return 'cleaned-up';
    }
    await rollback(dataDir, journal);
    return 'rolled-back';
  } catch (err) {
    const aside = path.join(dataDir, `${RESTORE_PREFIX}journal-failed-${Date.now()}.json`);
    await fsp
      .rename(journalPath(dataDir), aside)
      .catch(() => fsp.rm(journalPath(dataDir), { force: true }));
    console.error(
      `[Restore] Could not ${journal.phase === 'cleanup' ? 'clean up' : 'roll back'} the ` +
        `interrupted restore in ${dataDir} (${err instanceof Error ? err.message : err}). ` +
        `Entries that could not be moved back are in ${path.join(dataDir, journal.old)}; ` +
        `the journal was set aside as ${aside}, so it no longer blocks restores.`,
    );
    return 'failed';
  }
}

/** A swap failed AND its rollback failed; the data dir needs attention. */
export class RestoreRollbackError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RestoreRollbackError';
  }
}

/**
 * Finish what an interrupted restore left behind in `dataDir`: an unfinished
 * swap is rolled back, a finished one is cleaned up, and staging dirs without
 * a journal (the crash happened while extracting) are removed, except
 * `options.keep` (the stage of the restore that is about to run). A journal
 * that is not what this panel writes (wrong shape or names, a link, its stage
 * or old dir not a real directory) is removed and logged, so it can neither
 * move files nor block later restores. Must only run while the server is
 * stopped.
 */
export async function recoverInterruptedRestore(
  dataDir: string,
  options: { keep?: string; startedBefore?: number } = {},
): Promise<RecoveryOutcome> {
  let outcome: RecoveryOutcome = 'none';
  // startedBefore (the boot sweep): leave alone what a restore of this
  // process is creating right now. Something gone meanwhile is not older.
  const isOlder = async (p: string): Promise<boolean> => {
    if (options.startedBefore === undefined) return true;
    try {
      return (await fsp.lstat(p)).mtimeMs < options.startedBefore;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw err;
    }
  };
  const read = await readJournal(dataDir);
  if (read.kind !== 'none' && (await isOlder(journalPath(dataDir)))) {
    const problem =
      read.kind === 'invalid' ? read.reason : await journalDirProblem(dataDir, read.journal);
    if (read.kind === 'invalid' || problem !== null) {
      console.warn(
        `[Restore] Discarded the restore journal ${journalPath(dataDir)} (${problem}); ` +
          'nothing was moved because of it.',
      );
      await fsp.rm(journalPath(dataDir), { force: true });
      outcome = 'discarded';
    } else {
      outcome = await finishFromJournal(dataDir, read.journal);
    }
  }
  const keep = options.keep ? path.basename(options.keep) : null;
  for (const name of await fsp.readdir(dataDir)) {
    if (
      name.startsWith(STAGE_PREFIX) &&
      name !== keep &&
      (await isOlder(path.join(dataDir, name)))
    ) {
      await removeTree(path.join(dataDir, name), [dataDir]);
    }
  }
  return outcome;
}

/** True when `dataDir` holds a journal of a swap that did not finish. */
export async function hasInterruptedRestore(dataDir: string): Promise<boolean> {
  return exists(journalPath(dataDir));
}
