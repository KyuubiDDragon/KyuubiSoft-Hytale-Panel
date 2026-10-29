// Shared helpers, types, constants and state used by the routes/management/*
// submodules. Extracted from the previously monolithic routes/management.ts.
//
// Everything here is behavior-preserving — utilities used to live as private
// functions inside the original file and are now exported for reuse across
// the worlds / configs / cache / directories / worldConfigs submodules.
import { readdir, readFile, stat, lstat, realpath } from 'fs/promises';
import * as fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import multer from 'multer';
import { resolveRealPathWithin } from '../utils/pathSecurity.js';
import { replaceFileFromFile } from '../utils/noFollowFs.js';
import { ensureStagingDirSync } from '../utils/staging.js';
import { COMPOSE_SERVER_ID } from './servers.js';
import { getServerContext } from './serverContext.js';

// SECURITY: Magic bytes for file type verification
export const FILE_SIGNATURES: Record<string, number[][] | null> = {
  // ZIP/JAR files (PK\x03\x04 or PK\x05\x06 for empty)
  zip: [
    [0x50, 0x4b, 0x03, 0x04],
    [0x50, 0x4b, 0x05, 0x06],
    [0x50, 0x4b, 0x07, 0x08],
  ],
  // Lua script files start with -- or specific patterns
  lua: null, // Text file, check extension only
  // JavaScript files are text
  js: null, // Text file, check extension only
};

// How much of an upload verifyFileMagic looks at.
export const MAGIC_CHECK_BYTES = 512;

// SECURITY: Verify the uploaded content's magic bytes match the expected type
export function verifyFileMagic(content: Buffer, expectedType: 'zip' | 'lua' | 'js'): boolean {
  const signatures = FILE_SIGNATURES[expectedType];
  if (!signatures) {
    // Text files - no null byte (binary indicator) in the first 512 bytes
    return !content.subarray(0, MAGIC_CHECK_BYTES).includes(0);
  }
  return signatures.some((sig) => sig.every((byte, i) => content[i] === byte));
}

// Extension → acceptable leading-byte signatures. Enforced ONLY for these
// "this file claims a specific binary/archive format" extensions; every other
// extension (text, configs, world data, unknown types) is allowed because this
// is a general-purpose file manager.
const UPLOAD_MAGIC: Record<string, number[][]> = {
  '.zip': [
    [0x50, 0x4b, 0x03, 0x04],
    [0x50, 0x4b, 0x05, 0x06],
    [0x50, 0x4b, 0x07, 0x08],
  ],
  '.jar': [
    [0x50, 0x4b, 0x03, 0x04],
    [0x50, 0x4b, 0x05, 0x06],
    [0x50, 0x4b, 0x07, 0x08],
  ],
  '.gz': [[0x1f, 0x8b]],
  '.tgz': [[0x1f, 0x8b]],
  '.png': [[0x89, 0x50, 0x4e, 0x47]],
  '.jpg': [[0xff, 0xd8, 0xff]],
  '.jpeg': [[0xff, 0xd8, 0xff]],
  '.gif': [[0x47, 0x49, 0x46, 0x38]],
  '.pdf': [[0x25, 0x50, 0x44, 0x46]],
  '.7z': [[0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c]],
  '.rar': [[0x52, 0x61, 0x72, 0x21]],
  '.class': [[0xca, 0xfe, 0xba, 0xbe]],
  '.exe': [[0x4d, 0x5a]],
  '.dll': [[0x4d, 0x5a]],
};

/**
 * For a known binary/archive extension, confirm the buffer's leading bytes
 * match the claimed format. Stops a mislabeled payload (e.g. a script renamed
 * to .zip/.jar) from being stored where another tool might mishandle it on
 * extraction. Unknown extensions pass through unchanged.
 */
export function verifyUploadMagic(
  buffer: Buffer,
  filename: string,
): { ok: boolean; error?: string } {
  const ext = path.extname(filename).toLowerCase();
  const sigs = UPLOAD_MAGIC[ext];
  if (!sigs) return { ok: true };
  const matches = sigs.some((sig) => sig.every((b, i) => buffer[i] === b));
  return matches
    ? { ok: true }
    : { ok: false, error: `File content does not match its ${ext} extension` };
}

// SECURITY: Generate safe filename with unique prefix
export function generateSafeFilename(originalName: string): string {
  const ext = path.extname(originalName).toLowerCase();
  const baseName = path.basename(originalName, ext);
  // Sanitize the base name
  const safeName = baseName
    .replace(/[^a-zA-Z0-9._-]/g, '_')
    .replace(/\.+/g, '.')
    .replace(/^\.+|\.+$/g, '')
    .substring(0, 100);
  // Add unique prefix to prevent overwrites
  const uniqueId = crypto.randomBytes(4).toString('hex');
  return `${safeName}_${uniqueId}${ext}`;
}

/**
 * Puts a checked upload (its staged file) into the mods or plugins folder of
 * the request's server under a generated name. It is copied to a temporary
 * file there and renamed, so the server never loads a half-written file, and
 * a link planted under the name is replaced, not written through. Returns the
 * file name.
 */
export async function storeUpload(
  serverId: string | undefined,
  folder: 'mods' | 'plugins',
  file: { originalname: string; path: string },
): Promise<string> {
  const dir = (await getServerContext(serverId)).paths[folder];
  const filename = generateSafeFilename(file.originalname);
  await replaceFileFromFile(path.join(dir, filename), file.path, [dir]);
  return filename;
}

// SECURITY: Allowed file extensions for uploads
// Removed .dll and .so as they are native executables
export const ALLOWED_MOD_EXTENSIONS = ['.jar', '.zip', '.js', '.lua'];
export const MAX_UPLOAD_SIZE = 50 * 1024 * 1024; // 50MB limit (reduced from 100MB)

/**
 * " (server <id>)" for activity log details about any server but the compose
 * one, so the log of a single-server panel reads as before.
 */
export function onServer(serverId: string | undefined): string {
  return serverId && serverId !== COMPOSE_SERVER_ID ? ` (server ${serverId})` : '';
}

// Uploads wait in the staging folder of the manager volume (utils/staging.ts),
// at most MAX_UPLOAD_SIZE each, until their content is checked; storeUpload()
// then puts them into the folder of the request's server. Nothing unchecked
// ever lands where a running server loads mods, and no upload is held in
// memory. The route removes the staged file (discardStaged) when it is done;
// multer removes it itself when the upload fails.
const stagedUploads = multer.diskStorage({
  destination: (_req, _file, cb) => {
    try {
      cb(null, ensureStagingDirSync());
    } catch (err) {
      cb(err as Error, '');
    }
  },
});

export const uploadMod = multer({
  storage: stagedUploads,
  limits: { fileSize: MAX_UPLOAD_SIZE },
  fileFilter: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    // SECURITY: Only allow safe extensions
    if (ALLOWED_MOD_EXTENSIONS.includes(ext)) {
      cb(null, true);
    } else {
      cb(new Error(`Invalid file type. Allowed: ${ALLOWED_MOD_EXTENSIONS.join(', ')}`));
    }
  },
});

export const uploadPlugin = multer({
  storage: stagedUploads,
  limits: { fileSize: MAX_UPLOAD_SIZE },
  fileFilter: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    // SECURITY: Only allow safe extensions
    if (ALLOWED_MOD_EXTENSIONS.includes(ext)) {
      cb(null, true);
    } else {
      cb(new Error(`Invalid file type. Allowed: ${ALLOWED_MOD_EXTENSIONS.join(', ')}`));
    }
  },
});

// ============== WORLD-RELATED HELPERS ==============

export interface WorldFileInfo {
  name: string;
  path: string; // relative path within world (e.g., "config.json" or "resources/Time.json")
  size: number;
  lastModified: string;
}

export interface WorldInfo {
  name: string;
  path: string;
  size: number;
  lastModified: string;
  hasConfig: boolean;
  files: WorldFileInfo[]; // All editable JSON files in this world
}

// The worlds roots of a server come from worldRoots() in services/serverContext.ts.

/**
 * Locate `<worldsRoot>/<worldName>/<relFile>` across a server's worlds roots
 * (worldRoots(ctx)) and return its REAL path (symlinks resolved), or null. A
 * candidate that resolves outside its worlds root - e.g. a world folder or
 * config.json that is a link to a panel file - is ignored, so world config
 * reads/writes can't be redirected at secrets. Callers still validate
 * worldName/relFile.
 */
export async function findWorldFile(
  roots: string[],
  worldName: string,
  relFile: string,
): Promise<string | null> {
  for (const worldsPath of roots) {
    const candidate = path.join(worldsPath, worldName, relFile);
    const real = resolveRealPathWithin(candidate, [worldsPath]);
    if (!real) {
      if (fs.existsSync(candidate)) {
        console.warn(
          `[SECURITY] Ignoring world file that resolves outside ${worldsPath}: ${candidate}`,
        );
      }
      continue;
    }
    try {
      if ((await stat(real)).isFile()) return real;
    } catch {
      // Not in this root - try the next one
    }
  }
  return null;
}

export async function scanWorldFiles(worldPath: string): Promise<WorldFileInfo[]> {
  const files: WorldFileInfo[] = [];

  // Scan root level JSON files (config.json, etc.)
  try {
    const rootEntries = await readdir(worldPath, { withFileTypes: true });
    for (const entry of rootEntries) {
      if (entry.isFile() && entry.name.endsWith('.json') && !entry.name.endsWith('.bak')) {
        const filePath = path.join(worldPath, entry.name);
        try {
          const stats = await stat(filePath);
          files.push({
            name: entry.name,
            path: entry.name,
            size: stats.size,
            lastModified: stats.mtime.toISOString(),
          });
        } catch {
          // Skip
        }
      }
    }
  } catch {
    // Ignore
  }

  // Scan resources folder
  const resourcesPath = path.join(worldPath, 'resources');
  try {
    const resourceEntries = await readdir(resourcesPath, { withFileTypes: true });
    for (const entry of resourceEntries) {
      if (entry.isFile() && entry.name.endsWith('.json') && !entry.name.endsWith('.bak')) {
        const filePath = path.join(resourcesPath, entry.name);
        try {
          const stats = await stat(filePath);
          files.push({
            name: entry.name,
            path: `resources/${entry.name}`,
            size: stats.size,
            lastModified: stats.mtime.toISOString(),
          });
        } catch {
          // Skip
        }
      }
    }
  } catch {
    // resources folder doesn't exist
  }

  return files;
}

export async function scanWorldsInPath(
  worldsPath: string,
  seenRealPaths: Set<string>,
): Promise<WorldInfo[]> {
  const worlds: WorldInfo[] = [];
  try {
    const entries = await readdir(worldsPath, { withFileTypes: true });

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;

      const entryPath = path.join(worldsPath, entry.name);
      try {
        // Resolve symlinks to get the real path
        const realEntryPath = await realpath(entryPath);

        // Skip if we've already seen this real path (prevents duplicates from symlinks)
        if (seenRealPaths.has(realEntryPath)) {
          continue;
        }
        seenRealPaths.add(realEntryPath);

        const stats = await stat(entryPath);

        // Check if this is a real world by looking for config.json
        const configPath = path.join(entryPath, 'config.json');
        let hasConfig = false;
        try {
          await stat(configPath);
          hasConfig = true;
        } catch {
          // No config.json
        }

        // Scan all JSON files in this world
        const files = await scanWorldFiles(entryPath);

        // Calculate total size
        const totalSize = files.reduce((sum, f) => sum + f.size, 0);

        // Only include directories that have config.json (actual worlds)
        if (hasConfig) {
          worlds.push({
            name: entry.name,
            path: entryPath,
            size: totalSize,
            lastModified: stats.mtime.toISOString(),
            hasConfig: true,
            files,
          });
        }
      } catch {
        // Skip entries that can't be read
      }
    }
  } catch {
    // Path doesn't exist or can't be read
  }
  return worlds;
}

// ============== MOD/PLUGIN SCAN HELPERS ==============

export interface ModInfo {
  name: string;
  filename: string;
  size: number;
  lastModified: string;
  enabled: boolean;
  // Update info (optional - only for mods in registry)
  storeId?: string;
  installedVersion?: string;
  latestVersion?: string;
  hasUpdate?: boolean;
}

export async function scanDirectory(dirPath: string, _type: 'mod' | 'plugin'): Promise<ModInfo[]> {
  const items: ModInfo[] = [];
  try {
    const entries = await readdir(dirPath);

    for (const entry of entries) {
      const entryPath = path.join(dirPath, entry);
      try {
        // lstat: a link (e.g. to another server's jar) is not listed.
        const stats = await lstat(entryPath);
        if (stats.isFile()) {
          // Check for common mod/plugin extensions
          const ext = path.extname(entry).toLowerCase();
          const isValidFile = ['.jar', '.zip', '.js', '.lua', '.dll', '.so'].includes(ext);
          const isDisabled = entry.endsWith('.disabled');

          if (isValidFile || isDisabled) {
            items.push({
              name: entry.replace('.disabled', '').replace(ext, ''),
              filename: entry,
              size: stats.size,
              lastModified: stats.mtime.toISOString(),
              enabled: !isDisabled,
            });
          }
        }
      } catch {
        // Skip entries that can't be read
      }
    }
  } catch {
    // Directory doesn't exist or can't be read
  }
  return items;
}

// ============== MOD/PLUGIN CONFIG HELPERS ==============

// Helper: Extract base mod name without version (e.g., "EasyWebMap-v1.0.9" -> "EasyWebMap")
export function extractBaseModName(filename: string): string {
  // Remove extension first
  let name = filename.replace(/\.(jar|zip|disabled)$/i, '');
  // Remove version patterns like -v1.0.0, -1.0.0, _v1.0.0
  name = name.replace(/[-_]v?\d+(\.\d+)*$/i, '');
  return name;
}

// Helper: Find config directories matching mod name (fuzzy search)
export async function findConfigDirs(baseDir: string, modName: string): Promise<string[]> {
  const result: string[] = [];
  const modNameLower = modName.toLowerCase();

  try {
    const entries = await readdir(baseDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) {
        const entryLower = entry.name.toLowerCase();
        const entryNormalized = entryLower.replace(/[_-]/g, '');
        const modNameNormalized = modNameLower.replace(/[_-]/g, '');

        // Match patterns:
        // 1. Folder contains mod name: "cryptobench_EasyWebMap" contains "easywebmap"
        // 2. Mod name contains folder name
        // 3. Pattern: author_modname (e.g., cryptobench_EasyWebMap)
        // 4. Normalized comparison (ignoring _ and -)
        if (
          entryLower.includes(modNameLower) ||
          modNameLower.includes(entryLower) ||
          entryNormalized.includes(modNameNormalized) ||
          modNameNormalized.includes(entryNormalized) ||
          entryLower.endsWith('_' + modNameLower) ||
          entryLower.startsWith(modNameLower + '_')
        ) {
          result.push(path.join(baseDir, entry.name));
        }
      }
    }
  } catch (e) {
    // Directory doesn't exist or can't be read
    console.log(`findConfigDirs: Could not read ${baseDir}:`, e);
  }

  return result;
}

// ============== PERFORMANCE STATS HISTORY ==============

export interface StatsEntry {
  timestamp: string;
  cpu: number;
  memory: number;
  players: number;
}

export const statsHistory: StatsEntry[] = [];
export const MAX_STATS_HISTORY = 60; // Keep 60 entries (e.g., 1 hour at 1 per minute)

export function addStatsEntry(entry: Omit<StatsEntry, 'timestamp'>): void {
  statsHistory.push({
    ...entry,
    timestamp: new Date().toISOString(),
  });

  // Keep only the last MAX_STATS_HISTORY entries
  while (statsHistory.length > MAX_STATS_HISTORY) {
    statsHistory.shift();
  }
}

// ============== MOD TRACKING CLEANUP ==============

// NOTE: cleanupModTracking lives in routes/management/directories.ts to avoid
// circular service-to-service dependencies. It's the only consumer of the
// services here, and it's only used by the mod/plugin delete handlers.

// ============== READ HELPERS RE-EXPORTED FROM STDLIB ==============

// Re-export the readFile helper so consumers don't all have to import fs/promises.
// (Optional convenience; kept minimal to mirror old behavior.)
export { readFile, stat, readdir };
