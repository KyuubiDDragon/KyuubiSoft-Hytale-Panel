/**
 * Path Security Utilities
 * Prevents path traversal and ensures file access is within allowed directories
 */

import path from 'path';
import fs from 'fs';

/**
 * Check if a path is safely within an allowed directory
 * Prevents path traversal attacks
 */
export function isPathSafe(targetPath: string, allowedDirectories: string[]): boolean {
  try {
    // Resolve to absolute path
    const resolvedPath = path.resolve(targetPath);

    // Check against each allowed directory
    for (const allowedDir of allowedDirectories) {
      const resolvedAllowed = path.resolve(allowedDir);

      // Ensure the target is within the allowed directory
      if (resolvedPath.startsWith(resolvedAllowed + path.sep) || resolvedPath === resolvedAllowed) {
        return true;
      }
    }

    return false;
  } catch {
    return false;
  }
}

/**
 * True when `child` is `parent` itself or lies below it. Both must already be
 * absolute. Unlike a plain startsWith() this does not treat a sibling such as
 * "/data-old" as being inside "/data", and a file literally named "..foo" is
 * still inside.
 */
function isWithinDir(child: string, parent: string): boolean {
  const rel = path.relative(parent, child);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
}

/**
 * Resolve every symlink in `targetPath` and return its real location.
 *
 * A path that does not exist yet (the target of a create/write/move) resolves
 * its nearest existing ancestor and re-appends the missing tail, so a
 * symlinked parent directory can't smuggle a new file somewhere else.
 * Returns null when a component exists but can't be resolved (a broken or
 * looping symlink) or on any other error, so callers fail closed.
 */
export function resolveRealPath(targetPath: string): string | null {
  const isMissing = (err: unknown) => {
    const code = (err as NodeJS.ErrnoException).code;
    return code === 'ENOENT' || code === 'ENOTDIR';
  };

  let current = path.resolve(targetPath);
  const missingTail: string[] = [];
  for (;;) {
    try {
      const real = fs.realpathSync(current);
      return missingTail.length > 0 ? path.join(real, ...missingTail.reverse()) : real;
    } catch (err) {
      if (!isMissing(err)) return null;
    }
    // realpath also reports ENOENT for a dangling symlink. Only an entry that
    // is genuinely absent may be skipped; a link we can't follow is refused.
    try {
      fs.lstatSync(current);
      return null;
    } catch (err) {
      if (!isMissing(err)) return null;
    }
    const parent = path.dirname(current);
    if (parent === current) return null;
    missingTail.push(path.basename(current));
    current = parent;
  }
}

/**
 * Symlink-aware variant of isPathSafe(): resolves `targetPath` AND the allowed
 * directories through resolveRealPath() and checks where the path really
 * points. A link inside an allowed directory that leads elsewhere is
 * rejected. Returns the resolved real path, or null if it is not inside any
 * allowed directory.
 */
export function resolveRealPathWithin(
  targetPath: string,
  allowedDirectories: string[],
): string | null {
  const real = resolveRealPath(targetPath);
  if (!real) return null;
  for (const dir of allowedDirectories) {
    const realDir = resolveRealPath(dir);
    if (realDir && isWithinDir(real, realDir)) return real;
  }
  return null;
}

/**
 * Join a stored or user-supplied bare file name onto `baseDir` for a
 * destructive operation (unlink/overwrite of a mod file and similar). Only a
 * plain basename is accepted: no path separators of either flavour, no "." or
 * "..", no control characters. Returns null for anything else, so a value
 * like "../users.json" or "C:\x" can never reach unlink().
 */
export function resolveFileInDir(baseDir: string, fileName: unknown): string | null {
  if (typeof fileName !== 'string' || fileName.length === 0 || fileName.length > 255) return null;
  // eslint-disable-next-line no-control-regex
  if (/[/\\\x00-\x1f\x7f]/.test(fileName) || fileName === '.' || fileName === '..') return null;
  if (path.isAbsolute(fileName) || /^[a-zA-Z]:/.test(fileName)) return null;
  const joined = path.join(baseDir, fileName);
  return isPathSafe(joined, [baseDir]) ? joined : null;
}

/**
 * Get the real path (resolving symlinks) and verify it's within allowed directories
 */
export function getRealPathIfSafe(targetPath: string, allowedDirectories: string[]): string | null {
  try {
    // First check if the path exists
    if (!fs.existsSync(targetPath)) {
      // For non-existent files, verify the parent directory
      const parentDir = path.dirname(targetPath);
      if (!fs.existsSync(parentDir)) {
        return null;
      }

      // Check parent is within allowed directories
      const realParent = fs.realpathSync(parentDir);
      if (!isPathSafe(realParent, allowedDirectories)) {
        return null;
      }

      // Return the resolved path (parent real + basename)
      return path.join(realParent, path.basename(targetPath));
    }

    // For existing files, resolve the real path
    const realPath = fs.realpathSync(targetPath);

    // Verify it's within allowed directories
    if (!isPathSafe(realPath, allowedDirectories)) {
      return null;
    }

    return realPath;
  } catch {
    return null;
  }
}

/**
 * Sanitize a filename to prevent directory traversal
 */
export function sanitizeFileName(fileName: string): string | null {
  if (typeof fileName !== 'string' || !fileName) {
    return null;
  }

  // Get only the base name (removes any directory components)
  const baseName = path.basename(fileName);

  // Check for hidden files or dangerous patterns
  if (baseName.startsWith('.') || baseName.includes('..')) {
    return null;
  }

  // Only allow safe characters
  const safePattern = /^[a-zA-Z0-9._-]+$/;
  if (!safePattern.test(baseName)) {
    return null;
  }

  return baseName;
}

/**
 * Join paths safely, preventing directory traversal
 */
export function safePathJoin(baseDir: string, ...parts: string[]): string | null {
  try {
    // Sanitize each part
    const sanitizedParts = parts.map((part) => {
      // Remove any leading slashes and path traversal attempts
      return part.replace(/^[/\\]+/, '').replace(/\.\./g, '');
    });

    // Join the paths
    const joined = path.join(baseDir, ...sanitizedParts);
    const resolved = path.resolve(joined);
    const resolvedBase = path.resolve(baseDir);

    // Verify the result is within the base directory
    if (!resolved.startsWith(resolvedBase + path.sep) && resolved !== resolvedBase) {
      return null;
    }

    return resolved;
  } catch {
    return null;
  }
}

/**
 * Check if a file extension is in the allowed list
 */
export function isAllowedExtension(filePath: string, allowedExtensions: string[]): boolean {
  const ext = path.extname(filePath).toLowerCase();
  return allowedExtensions.includes(ext);
}

export default {
  isPathSafe,
  resolveRealPath,
  resolveRealPathWithin,
  resolveFileInDir,
  getRealPathIfSafe,
  sanitizeFileName,
  safePathJoin,
  isAllowedExtension,
};
