/**
 * One-time move of access files from before Hytale 0.7 (or written by older
 * panel versions) to the form the server reads now. Safe to run any number of
 * times: a file that is already fine is not touched, and every file is copied
 * (`<file>.pre-panel-migration-<time>`) before it is changed.
 *
 *  - permissions.json: user keys that are not UUIDs (`name:<player>` from the
 *    old editor) and values of the wrong type make the server refuse the
 *    whole file, and with it bans and the join permission. A `name:` entry
 *    moves to the player's UUID when the panel knows it; others are removed
 *    (they are in the copy and the report). Only with the server stopped.
 *  - whitelist.json: the server turns it into join grants when it starts, but
 *    drops names, so an enabled list of names locked everyone out. With the
 *    server stopped the panel applies it the way the server would (grants,
 *    RequireJoinPermission when it was enabled, rename to *.migrated) with the
 *    names resolved. With the server running it only replaces the names by
 *    UUIDs: the server reads the file at its next start, whoever starts it.
 *
 * Runs before every start through the panel (lifecycle hook) and on request.
 */
import path from 'path';
import { logActivity } from './activityLog.js';
import { registerBeforeStartHook } from './serverLifecycle.js';
import { resolveServerId } from './servers.js';
import { isDemoMode } from './demoData.js';
import { loadPlayerDirectory } from './accessDirectory.js';
import {
  accessFiles,
  backupServerFile,
  readServerJson,
  regularFileExists,
  retireLegacyWhitelist,
  SERVER_BACKUP_SUFFIX,
  updateServerJson,
  type AccessFiles,
} from './accessFiles.js';
import {
  JOIN_PERMISSION,
  isObject,
  normalizeLegacyWhitelist,
  readLegacyWhitelist,
  readPermissions,
  repairPermissions,
  withRequireJoinPermission,
  withUserAccess,
  type JsonObject,
} from './accessFormats.js';
import { logger } from '../utils/logger.js';

export const MIGRATION_BACKUP_TAG = 'pre-panel-migration';

export interface AccessMigrationReport {
  serverId: string | null;
  ranAt: string;
  serverStopped: boolean;
  /** Copies taken before a file was changed. */
  backups: string[];
  changes: string[];
  /** permissions.json entries taken out because no UUID is known for them. */
  removed: { key: string; value: unknown }[];
  /** Whitelist names no UUID is known for: those players are not on the whitelist. */
  unresolved: string[];
  /** What still needs a stopped server. */
  pending: string[];
  errors: string[];
}

/** What a migration would do, without changing anything (for the pages' notice). */
export interface AccessMigrationPreview {
  needed: boolean;
  items: string[];
}

const lastReports = new Map<string, AccessMigrationReport>();
// The registry id: the start hook passes it, the legacy routes pass nothing for the default server.
const reportKey = (serverId?: string | null) => resolveServerId(serverId ?? undefined);

export async function getLastMigrationReport(
  serverId?: string,
): Promise<AccessMigrationReport | null> {
  return lastReports.get(await reportKey(serverId)) ?? null;
}

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

async function legacyWhitelistSource(files: AccessFiles): Promise<string | null> {
  // The server reads the copy it keeps when a save of the list was interrupted.
  for (const file of [files.legacyWhitelist, files.legacyWhitelist + SERVER_BACKUP_SUFFIX]) {
    if (await regularFileExists(file)) return file;
  }
  return null;
}

type UuidForName = (name: string) => string | undefined;

async function migratePermissions(
  files: AccessFiles,
  uuidForName: UuidForName,
  stopped: boolean,
  report: AccessMigrationReport,
): Promise<void> {
  const raw = await readServerJson(files.permissions, files.serverPath);
  if (raw === null) return;
  if (!isObject(raw)) {
    report.errors.push('permissions.json is not a JSON object; fix or remove it by hand');
    return;
  }
  if (!repairPermissions(raw, uuidForName)) return;
  if (!stopped) {
    report.pending.push(
      'permissions.json has entries the server cannot read; they are repaired before the next start through the panel',
    );
    return;
  }
  const backup = await backupServerFile(files.permissions, files.serverPath, MIGRATION_BACKUP_TAG);
  if (backup) report.backups.push(path.basename(backup));
  await updateServerJson(files.permissions, files.serverPath, (current) => {
    const repair = repairPermissions(current, uuidForName);
    if (!repair) return undefined;
    report.changes.push(...repair.changes.map((c) => `permissions.json ${c}`));
    report.removed.push(...repair.removed);
    return repair.data;
  });
}

async function applyLegacyWhitelist(
  files: AccessFiles,
  source: string,
  raw: unknown,
  uuidForName: UuidForName,
  report: AccessMigrationReport,
): Promise<void> {
  const legacy = readLegacyWhitelist(raw)!;
  const uuids = new Set<string>();
  for (const entry of legacy.entries) {
    const uuid = entry.uuid ?? uuidForName(entry.value)?.toLowerCase();
    if (uuid) uuids.add(uuid);
    else report.unresolved.push(entry.value);
  }

  if (legacy.enabled && !(await regularFileExists(files.config))) {
    report.pending.push(
      'whitelist.json is enabled but config.json does not exist yet; the server applies the list when it starts',
    );
    return;
  }

  const backup = await backupServerFile(source, files.serverPath, MIGRATION_BACKUP_TAG);
  if (backup) report.backups.push(path.basename(backup));

  if (uuids.size > 0) {
    const permissionsBackup = await backupServerFile(
      files.permissions,
      files.serverPath,
      MIGRATION_BACKUP_TAG,
    );
    if (permissionsBackup) report.backups.push(path.basename(permissionsBackup));
    await updateServerJson(files.permissions, files.serverPath, (current) => {
      if (current !== null && !isObject(current)) {
        throw new Error('permissions.json is not a JSON object');
      }
      let data: JsonObject = (current as JsonObject | null) ?? {};
      for (const uuid of uuids)
        data = withUserAccess(data, uuid, { addPermissions: [JOIN_PERMISSION] });
      return data;
    });
  }
  if (legacy.enabled) {
    await updateServerJson(files.config, files.serverPath, (current) =>
      withRequireJoinPermission(current, true),
    );
  }
  const renamed = await retireLegacyWhitelist(files);
  report.changes.push(
    `whitelist.json: ${uuids.size} player(s) got ${JOIN_PERMISSION}` +
      (legacy.enabled ? ', RequireJoinPermission turned on' : '') +
      `; renamed ${renamed.join(', ')} to *.migrated`,
  );
}

async function migrateLegacyWhitelist(
  files: AccessFiles,
  uuidForName: UuidForName,
  stopped: boolean,
  report: AccessMigrationReport,
): Promise<void> {
  const source = await legacyWhitelistSource(files);
  if (!source) return;
  const name = path.basename(source);
  const raw = await readServerJson(source, files.serverPath);
  const legacy = readLegacyWhitelist(raw);
  if (!legacy) {
    report.errors.push(
      `${name} cannot be read; the server refuses to start until it is fixed or removed`,
    );
    return;
  }
  if (stopped) {
    if (
      readPermissions(await readServerJson(files.permissions, files.serverPath)).problems.some(
        (p) => p.fatal,
      )
    ) {
      report.pending.push(`${name} waits until permissions.json can be read by the server`);
      return;
    }
    await applyLegacyWhitelist(files, source, raw, uuidForName, report);
    return;
  }

  // The server reads the list only when it starts, so the names can be replaced now.
  const normalized = normalizeLegacyWhitelist(raw, uuidForName);
  if (normalized) {
    const backup = await backupServerFile(source, files.serverPath, MIGRATION_BACKUP_TAG);
    if (backup) report.backups.push(path.basename(backup));
    await updateServerJson(
      source,
      files.serverPath,
      (current) => normalizeLegacyWhitelist(current, uuidForName)?.data,
    );
    report.changes.push(
      `${name}: replaced ${normalized.resolved.length} name(s) by UUIDs (${normalized.resolved.map((r) => r.name).join(', ')})`,
    );
  }
  report.unresolved.push(
    ...legacy.entries.filter((e) => !e.uuid && !uuidForName(e.value)).map((e) => e.value),
  );
  report.pending.push(
    `${name} is applied before the next start (by the panel, or by the server itself)`,
  );
}

/**
 * Brings the access files of a server to the 0.7 form. `serverStopped` must
 * only be true while the caller holds the server stopped (lifecycle lock).
 */
export async function migrateAccessFiles(
  serverId: string | undefined,
  { serverStopped }: { serverStopped: boolean },
): Promise<AccessMigrationReport> {
  const report: AccessMigrationReport = {
    serverId: serverId ?? null,
    ranAt: new Date().toISOString(),
    serverStopped,
    backups: [],
    changes: [],
    removed: [],
    unresolved: [],
    pending: [],
    errors: [],
  };
  if (isDemoMode()) return report;

  const files = await accessFiles(serverId);
  const directory = await loadPlayerDirectory(serverId, { askPlugin: !serverStopped });
  const uuidForName: UuidForName = (name) => directory.uuidOf(name) ?? undefined;

  for (const step of [migratePermissions, migrateLegacyWhitelist]) {
    try {
      await step(files, uuidForName, serverStopped, report);
    } catch (error) {
      report.errors.push(errorText(error));
    }
  }

  // The pages show the last report that has something to say; a clean run clears it.
  if (
    report.changes.length > 0 ||
    report.errors.length > 0 ||
    report.pending.length > 0 ||
    report.unresolved.length > 0
  ) {
    lastReports.set(await reportKey(serverId), report);
  } else {
    lastReports.delete(await reportKey(serverId));
  }
  if (report.changes.length > 0) {
    logger.info(
      `[Access] Migrated access files of ${serverId ?? 'the default server'}:`,
      report.changes,
    );
    await logActivity(
      'system',
      'access_migration',
      'config',
      report.errors.length === 0,
      serverId ?? undefined,
      report.changes.join('; ').slice(0, 500),
    ).catch(() => undefined);
  }
  if (report.errors.length > 0) {
    logger.warn(
      `[Access] Access files of ${serverId ?? 'the default server'} need attention:`,
      report.errors,
    );
  }
  return report;
}

/** What migrateAccessFiles would change, read-only. */
export async function previewAccessMigration(serverId?: string): Promise<AccessMigrationPreview> {
  const items: string[] = [];
  if (isDemoMode()) return { needed: false, items };
  const files = await accessFiles(serverId);
  try {
    const raw = await readServerJson(files.permissions, files.serverPath);
    if (raw !== null && readPermissions(raw).problems.some((p) => p.fatal)) {
      items.push('permissions.json has entries the server cannot read');
    }
  } catch (error) {
    items.push(`permissions.json: ${errorText(error)}`);
  }
  try {
    const source = await legacyWhitelistSource(files);
    if (source) {
      const legacy = readLegacyWhitelist(await readServerJson(source, files.serverPath));
      items.push(
        legacy
          ? `${path.basename(source)} from before 0.7 (${legacy.entries.length} entries, ${legacy.enabled ? 'enabled' : 'disabled'})`
          : `${path.basename(source)} cannot be read`,
      );
    }
  } catch (error) {
    items.push(`whitelist.json: ${errorText(error)}`);
  }
  return { needed: items.length > 0, items };
}

let hookInstalled = false;

/** Migrates before every start through the panel; installed once. */
export function installAccessMigrationHook(): void {
  if (hookInstalled) return;
  hookInstalled = true;
  registerBeforeStartHook('access-files', async (serverId) => {
    await migrateAccessFiles(serverId, { serverStopped: true });
  });
}
