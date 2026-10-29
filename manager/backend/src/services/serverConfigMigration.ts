/**
 * One-time cleanup of settings earlier panel versions wrote into the
 * server's config.json and the world configs under names Hytale never read
 * (see migrateLegacyServerConfig / migrateLegacyWorldConfig for the rules).
 *
 * Idempotent: a cleaned file has nothing left to do. Only runs while the
 * server is stopped, because a running server writes its own copy back:
 * at panel start (when the server is down) and before every start through
 * the panel (lifecycle hook). Every change is logged and kept as a notice for
 * the configuration page until an admin dismisses it.
 */
import path from 'path';
import { readdir } from 'fs/promises';
import { logger } from '../utils/logger.js';
import { readJsonFile, writeJsonAtomic, withFileLock } from '../utils/jsonStore.js';
import { updateServerJson } from '../utils/serverFiles.js';
import { isJsonObject } from '../utils/losslessJson.js';
import { migrateLegacyServerConfig, type LegacyChange } from '../schemas/hytaleConfig.js';
import { migrateLegacyWorldConfig } from '../schemas/worldConfig.js';
import { getWorldsPaths } from './managementHelpers.js';
import { resolveInstallPaths } from './serverInstall.js';
import { getDefaultId, resolveServerId } from './servers.js';
import { registerBeforeStartHook, runWhileServerStopped } from './serverLifecycle.js';
import { isDemoMode } from './demoData.js';

const NOTES_FILE = path.join(process.env.MANAGER_DATA_PATH || '/app/data', 'config-migration.json');
const MAX_NOTES = 50;
const WORLD_NAME = /^[^/\\]+$/;

export interface MigrationNote extends LegacyChange {
  /** config.json or worlds/<name>/config.json */
  file: string;
  at: string;
}

async function migrateFile(
  file: string,
  roots: string[],
  label: string,
  migrate: (raw: unknown) => { config: Record<string, unknown>; changes: LegacyChange[] } | null,
): Promise<MigrationNote[]> {
  const notes: MigrationNote[] = [];
  const at = new Date().toISOString();
  await updateServerJson(file, roots, (current) => {
    // A missing file is never created here.
    const result = current === null ? null : migrate(current);
    if (!result) return undefined;
    for (const change of result.changes) notes.push({ ...change, file: label, at });
    return result.config;
  });
  return notes;
}

async function worldConfigFiles(): Promise<{ file: string; roots: string[]; label: string }[]> {
  const files: { file: string; roots: string[]; label: string }[] = [];
  const seen = new Set<string>();
  for (const root of getWorldsPaths()) {
    let entries: import('fs').Dirent[];
    try {
      entries = await readdir(root, { withFileTypes: true });
    } catch {
      continue; // root absent
    }
    for (const entry of entries) {
      // Real directories only; a world folder that is a link is left alone.
      if (!entry.isDirectory() || !WORLD_NAME.test(entry.name) || seen.has(entry.name)) continue;
      seen.add(entry.name);
      files.push({
        file: path.join(root, entry.name, 'config.json'),
        roots: [root],
        label: `worlds/${entry.name}/config.json`,
      });
    }
  }
  return files;
}

async function appendNotes(notes: MigrationNote[]): Promise<void> {
  if (notes.length === 0) return;
  await withFileLock(NOTES_FILE, async () => {
    const current = await readJsonFile<{ notes?: MigrationNote[] }>(NOTES_FILE).catch(() => null);
    const kept = Array.isArray(current?.notes) ? current.notes : [];
    await writeJsonAtomic(NOTES_FILE, { notes: [...kept, ...notes].slice(-MAX_NOTES) });
  });
}

function describe(note: MigrationNote): string {
  const target = note.to ? ` → ${note.to}` : '';
  return `${note.file}: ${note.key} ${note.action}${target} (${note.note})`;
}

/**
 * Cleans the server's config.json and, for the default server, every world
 * config. The caller makes sure the server is stopped. A file that cannot be
 * read (broken JSON, a link) is skipped with a warning.
 */
export async function migrateLegacyConfigKeys(serverId?: string): Promise<MigrationNote[]> {
  const notes: MigrationNote[] = [];
  const { serverPath } = await resolveInstallPaths(serverId);
  const targets = [
    {
      file: path.join(serverPath, 'config.json'),
      roots: [serverPath],
      label: 'config.json',
      migrate: migrateLegacyServerConfig,
    },
  ];
  // World folders are only known for the default server.
  if ((await resolveServerId(serverId)) === (await getDefaultId())) {
    for (const world of await worldConfigFiles()) {
      targets.push({ ...world, migrate: migrateLegacyWorldConfig });
    }
  }
  for (const target of targets) {
    try {
      notes.push(...(await migrateFile(target.file, target.roots, target.label, target.migrate)));
    } catch (error) {
      logger.warn(
        `[ConfigMigration] ${target.label} skipped: ${error instanceof Error ? error.message : error}`,
      );
    }
  }
  for (const note of notes) logger.info(`[ConfigMigration] ${describe(note)}`);
  await appendNotes(notes).catch((error) =>
    logger.warn('[ConfigMigration] Could not store the notices:', error),
  );
  return notes;
}

/**
 * At panel start: only with the default server stopped (under its lifecycle
 * lock), otherwise at its next start through the panel.
 */
export async function migrateLegacyConfigKeysAtStartup(): Promise<{
  deferred: boolean;
  notes: MigrationNote[];
}> {
  if (isDemoMode()) return { deferred: false, notes: [] };
  try {
    const done = await runWhileServerStopped(undefined, { reason: 'config' }, () =>
      migrateLegacyConfigKeys(),
    );
    return done.ran ? { deferred: false, notes: done.value } : { deferred: true, notes: [] };
  } catch (error) {
    logger.warn(`[ConfigMigration] Deferred: ${error instanceof Error ? error.message : error}`);
    return { deferred: true, notes: [] };
  }
}

/** Notices about cleaned-up settings that no admin dismissed yet. */
export async function readMigrationNotes(): Promise<MigrationNote[]> {
  const current = await readJsonFile<{ notes?: unknown }>(NOTES_FILE).catch(() => null);
  return Array.isArray(current?.notes)
    ? (current.notes as unknown[]).filter((n): n is MigrationNote => isJsonObject(n))
    : [];
}

export async function dismissMigrationNotes(): Promise<void> {
  await withFileLock(NOTES_FILE, () => writeJsonAtomic(NOTES_FILE, { notes: [] }));
}

let hookInstalled = false;

/** Cleans up before every start through the panel (the server is down then). */
export function installLegacyConfigHook(): void {
  if (hookInstalled) return;
  hookInstalled = true;
  registerBeforeStartHook('legacy-config-keys', async (serverId) => {
    await migrateLegacyConfigKeys(serverId);
  });
}
