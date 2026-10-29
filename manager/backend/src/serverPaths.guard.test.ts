/**
 * Guard: a server's folders come from getServerContext(), not from
 * config.*Path.
 *
 * config.serverPath & co. are the compose server's folders. Code that reads
 * them directly works on the compose server whatever server a request is
 * for. Only the files listed below may still do so:
 *  - PERMANENT: about the compose server by definition.
 *  - PENDING: not switched to getServerContext() yet. Remove a file's entry
 *    once it is clean; the test fails on entries that no longer match, so
 *    the list only ever shrinks.
 *
 * It sees direct reads only (config.x, destructuring from config, the env
 * vars behind them). A helper that reads them hands the compose folders to
 * every caller, e.g. managementHelpers.getWorldsPaths(); such helpers are
 * listed themselves, their callers are not.
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const SRC = path.dirname(fileURLToPath(import.meta.url));
const FIELDS = 'serverPath|dataPath|backupsPath|modsPath|pluginsPath|assetsPath|updaterPath';
const SERVER_PATH_USE = [
  new RegExp(`\\bconfig\\.(${FIELDS})\\b`),
  new RegExp(`\\{[^}]*\\b(${FIELDS})\\b[^}]*\\}\\s*=\\s*config\\b`),
  /\bprocess\.env\.(SERVER|DATA|BACKUPS|MODS|PLUGINS|ASSETS|UPDATER)_PATH\b/,
];
// Where the fields are defined from the env.
const DEFINITION = 'config.ts';

const PERMANENT: Record<string, string> = {
  'services/servers.ts': 'builds the compose server entry from them',
  'services/serverInstall.ts': 'the updater folder is only mounted for the compose server',
  'routes/setup.ts': 'first-run setup installs the compose server',
  'services/setupService.ts': 'first-run setup installs the compose server',
  'services/migration.ts': 'migrates single-server installs from before the registry',
  'services/legacyManagerFiles.ts':
    "takes the panel's files over from the compose server's data folder of older versions",
  'services/systemCheck.ts': 'checks the compose stack',
  'services/backup.ts': 'the panel self-backup adds the compose server to all others',
  'services/panelBackups.ts': 'moves old panel backups off the compose backups volume',
  'services/commandRegistry.ts': 'keeps the per-server command snapshots in one folder',
  'services/configService.ts': 'Asset Explorer settings, which are panel-wide',
  'services/assets.ts': 'the extracted Asset Explorer cache is shared by all servers',
  'index.ts': '/api/health/permissions checks the compose mounts',
};

const PENDING: Record<string, string> = {};

function sourceFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    const isSource =
      entry.name.endsWith('.ts') &&
      !entry.name.endsWith('.test.ts') &&
      !entry.name.endsWith('.d.ts');
    return isSource ? [full] : [];
  });
}

/** Lines that read a server path, comment lines left out. */
function offendingLines(file: string): string[] {
  return fs
    .readFileSync(file, 'utf-8')
    .split('\n')
    .map((line, i) => ({ line, no: i + 1 }))
    .filter(
      ({ line }) =>
        !/^\s*(\/\/|\/\*|\*)/.test(line) && SERVER_PATH_USE.some((pattern) => pattern.test(line)),
    )
    .map(({ line, no }) => `${no}: ${line.trim()}`);
}

const usage = new Map(
  sourceFiles(SRC)
    .map(
      (file) => [path.relative(SRC, file).split(path.sep).join('/'), offendingLines(file)] as const,
    )
    .filter(([file, lines]) => file !== DEFINITION && lines.length > 0),
);

describe('server folders come from the server context', () => {
  it('reads config.*Path only in the listed files', () => {
    const unlisted = [...usage.entries()]
      .filter(([file]) => !(file in PERMANENT) && !(file in PENDING))
      .map(([file, lines]) => `${file}\n  ${lines.join('\n  ')}`);
    expect(unlisted, 'use getServerContext(serverId).paths instead').toEqual([]);
  });

  it('lists no file that is already clean', () => {
    const stale = [...Object.keys(PERMANENT), ...Object.keys(PENDING)].filter(
      (file) => !usage.has(file),
    );
    expect(stale, 'remove these entries from the list').toEqual([]);
  });

  it('keeps every file in one list only', () => {
    expect(Object.keys(PENDING).filter((file) => file in PERMANENT)).toEqual([]);
  });
});
