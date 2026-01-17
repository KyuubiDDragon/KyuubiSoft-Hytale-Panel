/**
 * Asset Service
 * Handles extraction, browsing, and reading of Hytale game assets
 * Assets are extracted to a separate directory (not backed up)
 */

import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import crypto from 'crypto';
import { config } from '../config.js';
import { isPathSafe, safePathJoin } from '../utils/pathSecurity.js';

// Asset metadata file to track extraction state
const ASSET_META_FILE = '.asset-meta.json';

interface AssetMeta {
  sourceHash: string;
  extractedAt: string;
  sourceFile: string;
  fileCount: number;
}

interface AssetFileInfo {
  name: string;
  path: string;
  type: 'file' | 'directory';
  size: number;
  lastModified: string;
  extension?: string;
}

interface AssetTreeNode {
  name: string;
  path: string;
  type: 'file' | 'directory';
  size: number;
  extension?: string;
  children?: AssetTreeNode[];
}

interface AssetStatus {
  extracted: boolean;
  sourceExists: boolean;
  sourceFile: string | null;
  sourceSize: number;
  extractedAt: string | null;
  fileCount: number;
  needsUpdate: boolean;
  totalSize: number;
  extracting: boolean;
  extractProgress: ExtractionProgress | null;
}

interface ExtractionProgress {
  started: string;
  filesExtracted: number;
  currentFile: string;
  status: 'running' | 'completed' | 'failed';
  error?: string;
}

// Global extraction state
let extractionInProgress = false;
let extractionProgress: ExtractionProgress | null = null;

interface SearchResult {
  path: string;
  name: string;
  type: 'file' | 'directory';
  size: number;
  extension?: string;
  matchType: 'filename' | 'content';
  contentPreview?: string;
}

/**
 * Find the Assets.zip file in the server directory
 */
export function findAssetsArchive(): string | null {
  const possibleNames = ['Assets.zip', 'assets.zip', 'ASSETS.ZIP'];

  for (const name of possibleNames) {
    const archivePath = path.join(config.serverPath, name);
    if (fs.existsSync(archivePath)) {
      return archivePath;
    }
  }

  // Also check in data directory
  for (const name of possibleNames) {
    const archivePath = path.join(config.dataPath, name);
    if (fs.existsSync(archivePath)) {
      return archivePath;
    }
  }

  return null;
}

/**
 * Calculate hash of the assets archive for version tracking (streaming for large files)
 */
function calculateFileHashSync(filePath: string): string {
  // For large files, use file stats (size + mtime) as a quick hash
  // This avoids loading multi-GB files into memory
  const stat = fs.statSync(filePath);
  const hashSum = crypto.createHash('sha256');
  hashSum.update(`${stat.size}-${stat.mtimeMs}`);
  return hashSum.digest('hex').substring(0, 16);
}

/**
 * Calculate hash of a large file using streams (async version)
 */
async function calculateFileHashAsync(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hashSum = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath);

    stream.on('data', (chunk) => hashSum.update(chunk));
    stream.on('end', () => resolve(hashSum.digest('hex').substring(0, 16)));
    stream.on('error', reject);
  });
}

/**
 * Read asset metadata
 */
function readAssetMeta(): AssetMeta | null {
  const metaPath = path.join(config.assetsPath, ASSET_META_FILE);
  if (!fs.existsSync(metaPath)) {
    return null;
  }

  try {
    const content = fs.readFileSync(metaPath, 'utf-8');
    return JSON.parse(content);
  } catch {
    return null;
  }
}

/**
 * Write asset metadata
 */
function writeAssetMeta(meta: AssetMeta): void {
  const metaPath = path.join(config.assetsPath, ASSET_META_FILE);
  fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2));
}

/**
 * Count files in a directory recursively
 */
function countFiles(dirPath: string): number {
  let count = 0;

  try {
    const items = fs.readdirSync(dirPath);
    for (const item of items) {
      if (item.startsWith('.')) continue;
      const itemPath = path.join(dirPath, item);
      const stat = fs.statSync(itemPath);
      if (stat.isFile()) {
        count++;
      } else if (stat.isDirectory()) {
        count += countFiles(itemPath);
      }
    }
  } catch {
    // Ignore errors
  }

  return count;
}

/**
 * Get total size of a directory
 */
function getDirectorySize(dirPath: string): number {
  let size = 0;

  try {
    const items = fs.readdirSync(dirPath);
    for (const item of items) {
      if (item.startsWith('.')) continue;
      const itemPath = path.join(dirPath, item);
      const stat = fs.statSync(itemPath);
      if (stat.isFile()) {
        size += stat.size;
      } else if (stat.isDirectory()) {
        size += getDirectorySize(itemPath);
      }
    }
  } catch {
    // Ignore errors
  }

  return size;
}

/**
 * Get status of the asset extraction
 */
export function getAssetStatus(): AssetStatus {
  const sourceFile = findAssetsArchive();
  const meta = readAssetMeta();

  let needsUpdate = false;
  let sourceSize = 0;

  if (sourceFile) {
    try {
      const stat = fs.statSync(sourceFile);
      sourceSize = stat.size;
    } catch {
      // Ignore
    }

    if (meta) {
      const currentHash = calculateFileHashSync(sourceFile);
      needsUpdate = currentHash !== meta.sourceHash;
    }
  }

  return {
    extracted: meta !== null && fs.existsSync(config.assetsPath),
    sourceExists: sourceFile !== null,
    sourceFile: sourceFile,
    sourceSize: sourceSize,
    extractedAt: meta?.extractedAt || null,
    fileCount: meta?.fileCount || 0,
    needsUpdate: needsUpdate,
    totalSize: fs.existsSync(config.assetsPath) ? getDirectorySize(config.assetsPath) : 0,
    extracting: extractionInProgress,
    extractProgress: extractionProgress,
  };
}

/**
 * Extract assets from the archive (async with progress tracking)
 */
export function extractAssets(): { success: boolean; error?: string; message?: string } {
  const sourceFile = findAssetsArchive();

  if (!sourceFile) {
    return { success: false, error: 'Assets.zip not found in server or data directory' };
  }

  if (extractionInProgress) {
    return { success: false, error: 'Extraction already in progress' };
  }

  // Start extraction in background
  extractionInProgress = true;
  extractionProgress = {
    started: new Date().toISOString(),
    filesExtracted: 0,
    currentFile: 'Starting...',
    status: 'running',
  };

  // Run extraction asynchronously
  runExtraction(sourceFile).catch((err) => {
    console.error('[Assets] Extraction error:', err);
    if (extractionProgress) {
      extractionProgress.status = 'failed';
      extractionProgress.error = err.message || 'Unknown error';
    }
    extractionInProgress = false;
  });

  return {
    success: true,
    message: 'Extraction started. Check status for progress.'
  };
}

/**
 * Internal async extraction function
 */
async function runExtraction(sourceFile: string): Promise<void> {
  try {
    // Create assets directory if it doesn't exist
    if (!fs.existsSync(config.assetsPath)) {
      fs.mkdirSync(config.assetsPath, { recursive: true });
    }

    // Clear existing assets (except meta file)
    if (extractionProgress) {
      extractionProgress.currentFile = 'Clearing old files...';
    }

    const existingItems = fs.readdirSync(config.assetsPath);
    for (const item of existingItems) {
      if (item === ASSET_META_FILE) continue;
      const itemPath = path.join(config.assetsPath, item);
      fs.rmSync(itemPath, { recursive: true, force: true });
    }

    // Extract using unzip command with verbose output to track progress
    if (extractionProgress) {
      extractionProgress.currentFile = 'Extracting...';
    }

    await new Promise<void>((resolve, reject) => {
      // Use unzip with verbose mode to track files
      const unzip = spawn('unzip', ['-o', sourceFile, '-d', config.assetsPath], {
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      let fileCount = 0;
      let lastFile = '';

      unzip.stdout.on('data', (data: Buffer) => {
        const lines = data.toString().split('\n');
        for (const line of lines) {
          // unzip outputs "  inflating: filename" or "   creating: dirname/"
          const match = line.match(/(?:inflating|creating|extracting):\s+(.+)/);
          if (match) {
            fileCount++;
            lastFile = match[1].trim();
            if (extractionProgress) {
              extractionProgress.filesExtracted = fileCount;
              extractionProgress.currentFile = lastFile.length > 50
                ? '...' + lastFile.slice(-47)
                : lastFile;
            }
          }
        }
      });

      unzip.stderr.on('data', (data: Buffer) => {
        console.error('[Assets] unzip stderr:', data.toString());
      });

      unzip.on('close', (code) => {
        if (code === 0) {
          resolve();
        } else {
          reject(new Error(`unzip exited with code ${code}`));
        }
      });

      unzip.on('error', (err) => {
        reject(err);
      });

      // Timeout after 60 minutes
      setTimeout(() => {
        unzip.kill();
        reject(new Error('Extraction timed out after 60 minutes'));
      }, 60 * 60 * 1000);
    });

    // Count final files
    if (extractionProgress) {
      extractionProgress.currentFile = 'Finalizing...';
    }

    const fileCount = countFiles(config.assetsPath);

    // Calculate hash and save metadata
    const sourceHash = calculateFileHashSync(sourceFile);
    writeAssetMeta({
      sourceHash,
      extractedAt: new Date().toISOString(),
      sourceFile: sourceFile,
      fileCount,
    });

    if (extractionProgress) {
      extractionProgress.filesExtracted = fileCount;
      extractionProgress.currentFile = 'Complete';
      extractionProgress.status = 'completed';
    }

    console.log(`[Assets] Extraction complete: ${fileCount} files`);
  } catch (error) {
    console.error('[Assets] Extraction failed:', error);
    if (extractionProgress) {
      extractionProgress.status = 'failed';
      extractionProgress.error = error instanceof Error ? error.message : 'Unknown error';
    }
    throw error;
  } finally {
    extractionInProgress = false;
  }
}

/**
 * Delete extracted assets (clear cache)
 */
export function clearAssets(): { success: boolean; error?: string } {
  try {
    if (fs.existsSync(config.assetsPath)) {
      fs.rmSync(config.assetsPath, { recursive: true, force: true });
    }
    return { success: true };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Failed to clear assets'
    };
  }
}

/**
 * List files in a directory within the assets
 */
export function listAssetDirectory(relativePath: string = ''): AssetFileInfo[] | null {
  const targetPath = safePathJoin(config.assetsPath, relativePath);

  if (!targetPath || !isPathSafe(targetPath, [config.assetsPath])) {
    return null;
  }

  if (!fs.existsSync(targetPath)) {
    return null;
  }

  const stat = fs.statSync(targetPath);
  if (!stat.isDirectory()) {
    return null;
  }

  const items: AssetFileInfo[] = [];
  const entries = fs.readdirSync(targetPath);

  for (const entry of entries) {
    if (entry.startsWith('.')) continue;

    const entryPath = path.join(targetPath, entry);
    const entryRelPath = relativePath ? `${relativePath}/${entry}` : entry;

    try {
      const entryStat = fs.statSync(entryPath);
      const isDir = entryStat.isDirectory();

      items.push({
        name: entry,
        path: entryRelPath,
        type: isDir ? 'directory' : 'file',
        size: isDir ? 0 : entryStat.size,
        lastModified: entryStat.mtime.toISOString(),
        extension: isDir ? undefined : path.extname(entry).toLowerCase(),
      });
    } catch {
      // Skip entries we can't read
      continue;
    }
  }

  // Sort: directories first, then files, alphabetically
  items.sort((a, b) => {
    if (a.type !== b.type) {
      return a.type === 'directory' ? -1 : 1;
    }
    return a.name.localeCompare(b.name);
  });

  return items;
}

/**
 * Get asset directory tree (recursive, with depth limit)
 */
export function getAssetTree(relativePath: string = '', maxDepth: number = 3): AssetTreeNode | null {
  const targetPath = safePathJoin(config.assetsPath, relativePath);

  if (!targetPath || !isPathSafe(targetPath, [config.assetsPath])) {
    return null;
  }

  if (!fs.existsSync(targetPath)) {
    return null;
  }

  function buildTree(dirPath: string, relPath: string, depth: number): AssetTreeNode {
    const stat = fs.statSync(dirPath);
    const name = path.basename(dirPath) || 'Assets';

    if (stat.isFile()) {
      return {
        name,
        path: relPath,
        type: 'file',
        size: stat.size,
        extension: path.extname(name).toLowerCase(),
      };
    }

    const node: AssetTreeNode = {
      name,
      path: relPath,
      type: 'directory',
      size: 0,
      children: [],
    };

    if (depth < maxDepth) {
      try {
        const entries = fs.readdirSync(dirPath);
        for (const entry of entries) {
          if (entry.startsWith('.')) continue;

          const entryPath = path.join(dirPath, entry);
          const entryRelPath = relPath ? `${relPath}/${entry}` : entry;

          node.children!.push(buildTree(entryPath, entryRelPath, depth + 1));
        }

        // Sort children
        node.children!.sort((a, b) => {
          if (a.type !== b.type) {
            return a.type === 'directory' ? -1 : 1;
          }
          return a.name.localeCompare(b.name);
        });
      } catch {
        // Ignore errors
      }
    }

    return node;
  }

  return buildTree(targetPath, relativePath, 0);
}

/**
 * Read file content from assets
 */
export function readAssetFile(relativePath: string): {
  success: boolean;
  content?: string | Buffer;
  mimeType?: string;
  size?: number;
  error?: string;
  isBinary?: boolean;
} {
  const targetPath = safePathJoin(config.assetsPath, relativePath);

  if (!targetPath || !isPathSafe(targetPath, [config.assetsPath])) {
    return { success: false, error: 'Invalid path' };
  }

  if (!fs.existsSync(targetPath)) {
    return { success: false, error: 'File not found' };
  }

  const stat = fs.statSync(targetPath);
  if (!stat.isFile()) {
    return { success: false, error: 'Not a file' };
  }

  // Determine file type
  const ext = path.extname(relativePath).toLowerCase();
  const textExtensions = ['.json', '.txt', '.xml', '.yml', '.yaml', '.cfg', '.conf', '.properties', '.md', '.lua', '.js', '.ts', '.css', '.html', '.csv', '.ini', '.log'];
  const imageExtensions = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.ico', '.svg'];

  const isText = textExtensions.includes(ext);
  const isImage = imageExtensions.includes(ext);

  // Limit file size for reading (10MB for text, 50MB for binary)
  const maxSize = isText ? 10 * 1024 * 1024 : 50 * 1024 * 1024;
  if (stat.size > maxSize) {
    return { success: false, error: `File too large (max ${maxSize / 1024 / 1024}MB)` };
  }

  try {
    if (isImage) {
      // Return base64 encoded image
      const content = fs.readFileSync(targetPath);
      const mimeTypes: Record<string, string> = {
        '.png': 'image/png',
        '.jpg': 'image/jpeg',
        '.jpeg': 'image/jpeg',
        '.gif': 'image/gif',
        '.webp': 'image/webp',
        '.bmp': 'image/bmp',
        '.ico': 'image/x-icon',
        '.svg': 'image/svg+xml',
      };

      return {
        success: true,
        content: content.toString('base64'),
        mimeType: mimeTypes[ext] || 'application/octet-stream',
        size: stat.size,
        isBinary: true,
      };
    } else if (isText) {
      // Return text content
      const content = fs.readFileSync(targetPath, 'utf-8');
      return {
        success: true,
        content,
        mimeType: ext === '.json' ? 'application/json' : 'text/plain',
        size: stat.size,
        isBinary: false,
      };
    } else {
      // Return hex preview for binary files
      const content = fs.readFileSync(targetPath);
      const hexPreview = content.subarray(0, 1024).toString('hex').match(/.{1,2}/g)?.join(' ') || '';

      return {
        success: true,
        content: hexPreview,
        mimeType: 'application/octet-stream',
        size: stat.size,
        isBinary: true,
      };
    }
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Failed to read file'
    };
  }
}

/**
 * Search for files in assets
 */
export function searchAssets(query: string, options?: {
  searchContent?: boolean;
  extensions?: string[];
  maxResults?: number;
}): SearchResult[] {
  const results: SearchResult[] = [];
  const maxResults = options?.maxResults || 100;
  const searchContent = options?.searchContent || false;
  const extensions = options?.extensions;
  const queryLower = query.toLowerCase();

  function searchDir(dirPath: string, relativePath: string): void {
    if (results.length >= maxResults) return;

    try {
      const entries = fs.readdirSync(dirPath);

      for (const entry of entries) {
        if (results.length >= maxResults) break;
        if (entry.startsWith('.')) continue;

        const entryPath = path.join(dirPath, entry);
        const entryRelPath = relativePath ? `${relativePath}/${entry}` : entry;

        try {
          const stat = fs.statSync(entryPath);
          const ext = path.extname(entry).toLowerCase();

          // Filter by extension if specified
          if (extensions && extensions.length > 0 && stat.isFile()) {
            if (!extensions.includes(ext)) continue;
          }

          // Check filename match
          if (entry.toLowerCase().includes(queryLower)) {
            results.push({
              path: entryRelPath,
              name: entry,
              type: stat.isDirectory() ? 'directory' : 'file',
              size: stat.isFile() ? stat.size : 0,
              extension: stat.isFile() ? ext : undefined,
              matchType: 'filename',
            });
          }

          // Search content for text files
          if (searchContent && stat.isFile() && stat.size < 1024 * 1024) { // Max 1MB for content search
            const textExtensions = ['.json', '.txt', '.xml', '.yml', '.yaml', '.cfg', '.lua', '.js'];
            if (textExtensions.includes(ext)) {
              try {
                const content = fs.readFileSync(entryPath, 'utf-8');
                const lowerContent = content.toLowerCase();
                const matchIndex = lowerContent.indexOf(queryLower);

                if (matchIndex !== -1) {
                  // Get preview around match
                  const start = Math.max(0, matchIndex - 50);
                  const end = Math.min(content.length, matchIndex + query.length + 50);
                  const preview = (start > 0 ? '...' : '') +
                                  content.substring(start, end) +
                                  (end < content.length ? '...' : '');

                  // Avoid duplicate if already matched by filename
                  if (!results.some(r => r.path === entryRelPath)) {
                    results.push({
                      path: entryRelPath,
                      name: entry,
                      type: 'file',
                      size: stat.size,
                      extension: ext,
                      matchType: 'content',
                      contentPreview: preview.replace(/\n/g, ' '),
                    });
                  }
                }
              } catch {
                // Skip files that can't be read as text
              }
            }
          }

          // Recurse into directories
          if (stat.isDirectory()) {
            searchDir(entryPath, entryRelPath);
          }
        } catch {
          // Skip entries we can't read
        }
      }
    } catch {
      // Ignore directory read errors
    }
  }

  if (fs.existsSync(config.assetsPath)) {
    searchDir(config.assetsPath, '');
  }

  return results;
}

export default {
  findAssetsArchive,
  getAssetStatus,
  extractAssets,
  clearAssets,
  listAssetDirectory,
  getAssetTree,
  readAssetFile,
  searchAssets,
};
