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
    const sanitizedParts = parts.map(part => {
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
  getRealPathIfSafe,
  sanitizeFileName,
  safePathJoin,
  isAllowedExtension,
};
