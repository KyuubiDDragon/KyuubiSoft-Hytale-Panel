// Shared helpers, types, constants and state used by the routes/management/*
// submodules. Extracted from the previously monolithic routes/management.ts.
//
// Everything here is behavior-preserving — utilities used to live as private
// functions inside the original file and are now exported for reuse across
// the worlds / configs / cache / directories / worldConfigs submodules.
import { readdir, readFile, stat, realpath } from 'fs/promises';
import * as fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import multer from 'multer';
import { config } from '../config.js';

// SECURITY: Magic bytes for file type verification
export const FILE_SIGNATURES: Record<string, number[][] | null> = {
  // ZIP/JAR files (PK\x03\x04 or PK\x05\x06 for empty)
  zip: [
    [0x50, 0x4B, 0x03, 0x04],
    [0x50, 0x4B, 0x05, 0x06],
    [0x50, 0x4B, 0x07, 0x08],
  ],
  // Lua script files start with -- or specific patterns
  lua: null, // Text file, check extension only
  // JavaScript files are text
  js: null, // Text file, check extension only
};

// SECURITY: Verify file magic bytes match expected type
export function verifyFileMagic(filePath: string, expectedType: 'zip' | 'lua' | 'js'): boolean {
  try {
    const signatures = FILE_SIGNATURES[expectedType];
    if (!signatures) {
      // Text files - verify they don't contain binary data
      const buffer = Buffer.alloc(512);
      const fd = fs.openSync(filePath, 'r');
      fs.readSync(fd, buffer, 0, 512, 0);
      fs.closeSync(fd);
      // Check for null bytes (binary indicator)
      for (let i = 0; i < Math.min(buffer.length, 512); i++) {
        if (buffer[i] === 0) return false;
      }
      return true;
    }

    const buffer = Buffer.alloc(8);
    const fd = fs.openSync(filePath, 'r');
    fs.readSync(fd, buffer, 0, 8, 0);
    fs.closeSync(fd);

    return signatures.some(sig =>
      sig.every((byte, i) => buffer[i] === byte)
    );
  } catch {
    return false;
  }
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

// SECURITY: Allowed file extensions for uploads
// Removed .dll and .so as they are native executables
export const ALLOWED_MOD_EXTENSIONS = ['.jar', '.zip', '.js', '.lua'];
export const MAX_UPLOAD_SIZE = 50 * 1024 * 1024; // 50MB limit (reduced from 100MB)

// Configure multer for file uploads with security improvements
const modsStorage = multer.diskStorage({
  destination: (_req, _file, cb) => {
    cb(null, config.modsPath);
  },
  filename: (_req, file, cb) => {
    // SECURITY: Generate safe filename to prevent path traversal and overwrites
    cb(null, generateSafeFilename(file.originalname));
  },
});

const pluginsStorage = multer.diskStorage({
  destination: (_req, _file, cb) => {
    cb(null, config.pluginsPath);
  },
  filename: (_req, file, cb) => {
    // SECURITY: Generate safe filename to prevent path traversal and overwrites
    cb(null, generateSafeFilename(file.originalname));
  },
});

export const uploadMod = multer({
  storage: modsStorage,
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
  storage: pluginsStorage,
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
  path: string;  // relative path within world (e.g., "config.json" or "resources/Time.json")
  size: number;
  lastModified: string;
}

export interface WorldInfo {
  name: string;
  path: string;
  size: number;
  lastModified: string;
  hasConfig: boolean;
  files: WorldFileInfo[];  // All editable JSON files in this world
}

// Possible world paths to check - only actual world directories
export function getWorldsPaths(): string[] {
  return [
    path.join(config.dataPath, 'worlds'),                    // /opt/hytale/data/worlds
    path.join(config.serverPath, 'universe', 'worlds'),      // /opt/hytale/server/universe/worlds (symlink)
    path.join(config.serverPath, 'worlds'),                  // /opt/hytale/server/worlds (fallback)
  ];
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

export async function scanWorldsInPath(worldsPath: string, seenRealPaths: Set<string>): Promise<WorldInfo[]> {
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
        const stats = await stat(entryPath);
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
