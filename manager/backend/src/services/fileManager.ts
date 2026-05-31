import path from 'path';
import {
  promises as fsp,
  createReadStream,
  lstatSync,
  type Stats,
} from 'fs';
import type { ReadStream } from 'fs';
import { config } from '../config.js';

// ============================================================
// Types
// ============================================================

export interface FileManagerRoot {
  id: string;
  path: string;
  rw: boolean;
  permission: 'files.read' | 'files.write';
  deny?: string[];
  label?: string;
}

export interface DirEntry {
  name: string;
  path: string;          // relative to root
  type: 'file' | 'directory';
  size: number;
  mtime: string;         // ISO timestamp
  mtimeMs: number;       // ms epoch for ETag/conflict checks
  isReadOnly: boolean;
}

export interface ReadResult {
  content: string;
  encoding: 'utf-8' | 'base64';
  size: number;
  mtimeMs: number;
  mtime: string;
  truncated: boolean;
  isBinary: boolean;
}

export interface WriteResult {
  size: number;
  mtimeMs: number;
  mtime: string;
}

export class FileManagerError extends Error {
  public status: number;
  public code: string;
  constructor(message: string, status = 400, code = 'FILE_ERROR') {
    super(message);
    this.status = status;
    this.code = code;
    this.name = 'FileManagerError';
  }
}

// ============================================================
// Limits
// ============================================================

export const MAX_READ_BYTES = 5 * 1024 * 1024;   // 5 MB
export const MAX_WRITE_BYTES = 10 * 1024 * 1024; // 10 MB

// Default deny patterns applied to ALL roots in addition to per-root deny list.
// These cover credential/secret files and anything with a dedicated, validated
// editor — editing them through the generic file manager would either leak
// secrets or bypass schema validation. The server JAR is denied because
// replacing it is arbitrary-code-execution-on-restart.
const GLOBAL_DENY_PATTERNS: RegExp[] = [
  /(^|\/)\.env(\.|$)/i,
  /(^|\/)users\.json$/i,
  /(^|\/)audit\.sqlite(-journal)?$/i,
  /(^|\/)panel\.sqlite(-journal)?$/i,
  /(^|\/)HytaleServer\.jar$/i,   // server JAR replace = RCE on restart
  /(^|\/)auth\.enc$/i,           // encrypted Hytale auth credentials
  /(^|\/)config\.json$/i,        // use the dedicated, schema-validated config editor
];

// Extension-based denies target secret/credential FILES only. They must NEVER
// hide or block a *directory* — a folder named e.g. "cache.aot" is legitimate
// and must stay listable and navigable. (Applied with isDir=false only.)
const EXTENSION_DENY_PATTERNS: RegExp[] = [
  /\.key$/i,
  /\.pem$/i,
  /\.aot$/i,                     // AOT cache file (paired with the JAR)
];

// ============================================================
// Roots configuration (from config.ts paths)
// ============================================================

export function getRoots(): FileManagerRoot[] {
  return [
    {
      id: 'mods',
      path: config.modsPath,
      rw: true,
      permission: 'files.write',
      label: 'Mods',
    },
    {
      id: 'plugins',
      path: config.pluginsPath,
      rw: true,
      permission: 'files.write',
      label: 'Plugins',
    },
    {
      id: 'server',
      path: config.serverPath,
      rw: true,
      permission: 'files.write',
      // Hytale config.json has its own editor + auth/ is sensitive
      deny: ['config.json', 'auth/', 'auth'],
      label: 'Server',
    },
    {
      id: 'data',
      path: config.dataPath,
      rw: false,
      permission: 'files.read',
      label: 'Data',
    },
  ];
}

export function getRoot(rootId: string): FileManagerRoot {
  const root = getRoots().find((r) => r.id === rootId);
  if (!root) {
    throw new FileManagerError(`Unknown root: ${rootId}`, 404, 'ROOT_NOT_FOUND');
  }
  return root;
}

// ============================================================
// Path resolution & security
// ============================================================

/**
 * Resolve a relative path against a root, with traversal & deny protection.
 * Returns the absolute filesystem path.
 *
 * Throws FileManagerError(403) if path escapes root or matches deny patterns.
 */
export function resolveSafe(root: FileManagerRoot, relPath: string): string {
  const raw = relPath || '';

  // Reject obvious absolute paths or Windows-drive paths before normalisation
  if (
    raw.startsWith('/') ||
    raw.startsWith('\\') ||
    /^[a-zA-Z]:[\\/]/.test(raw)
  ) {
    throw new FileManagerError('Absolute paths not allowed', 403, 'PATH_FORBIDDEN');
  }

  // Normalize input (slashes only, no leading separator)
  const cleanRel = raw.replace(/\\/g, '/').replace(/^\/+/, '');

  if (path.isAbsolute(cleanRel)) {
    throw new FileManagerError('Absolute paths not allowed', 403, 'PATH_FORBIDDEN');
  }

  const rootAbs = path.resolve(root.path);
  const resolved = path.resolve(rootAbs, cleanRel);
  const relative = path.relative(rootAbs, resolved);

  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new FileManagerError('Path traversal detected', 403, 'PATH_TRAVERSAL');
  }

  // Deny matching - relative is the path inside the root with OS separators.
  // Extension denies apply to files only, so resolve dir-ness to keep
  // directories ending in .aot/.key/.pem navigable (name-exact secrets stay
  // blocked regardless). A non-existent target (create/write path) is treated
  // as a file.
  const relForCheck = (relative || '').replace(/\\/g, '/');
  let isDirTarget = false;
  try {
    isDirTarget = lstatSync(resolved).isDirectory();
  } catch {
    isDirTarget = false;
  }
  if (isDenied(root, relForCheck, isDirTarget)) {
    throw new FileManagerError('Path is in deny-list', 403, 'PATH_DENIED');
  }

  return resolved;
}

export function isDenied(root: FileManagerRoot, relPath: string, isDir = false): boolean {
  if (!relPath) return false;
  const lower = relPath.toLowerCase();

  // Global deny patterns (name-exact secrets) — apply to files AND directories.
  for (const re of GLOBAL_DENY_PATTERNS) {
    if (re.test(lower)) return true;
  }

  // Extension denies (.key/.pem/.aot) — files only, so a directory whose name
  // ends in one of these stays listable and navigable.
  if (!isDir) {
    for (const re of EXTENSION_DENY_PATTERNS) {
      if (re.test(lower)) return true;
    }
  }

  // Per-root deny list - exact name or prefix-of-directory
  if (root.deny) {
    for (const denied of root.deny) {
      const dn = denied.toLowerCase().replace(/\\/g, '/');
      if (dn.endsWith('/')) {
        // Directory prefix
        const dir = dn.slice(0, -1);
        if (lower === dir || lower.startsWith(dn) || lower.startsWith(`${dir}/`)) {
          return true;
        }
      } else {
        // Exact match or matches as basename anywhere in path
        if (lower === dn) return true;
        if (lower.endsWith(`/${dn}`)) return true;
        // Glob *.ext
        if (dn.startsWith('*.')) {
          const ext = dn.slice(1);
          if (lower.endsWith(ext)) return true;
        }
      }
    }
  }
  return false;
}

// ============================================================
// Binary detection
// ============================================================

const BINARY_EXTS = new Set([
  '.jar', '.zip', '.gz', '.tar', '.7z', '.rar',
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.ico',
  '.mp3', '.wav', '.ogg', '.flac', '.mp4', '.mkv', '.avi',
  '.exe', '.dll', '.so', '.dylib', '.bin', '.dat', '.db',
  '.sqlite', '.sqlite3', '.pdf', '.woff', '.woff2', '.ttf', '.otf',
]);

function isLikelyBinary(filePath: string, sample?: Buffer): boolean {
  const ext = path.extname(filePath).toLowerCase();
  if (BINARY_EXTS.has(ext)) return true;
  if (!sample) return false;
  // Heuristic: NUL byte in sample indicates binary
  for (let i = 0; i < Math.min(sample.length, 512); i++) {
    if (sample[i] === 0) return true;
  }
  return false;
}

// ============================================================
// Operations
// ============================================================

export async function listDir(rootId: string, relPath: string): Promise<{
  root: { id: string; path: string; rw: boolean };
  path: string;
  entries: DirEntry[];
}> {
  const root = getRoot(rootId);
  const abs = resolveSafe(root, relPath);

  let stat: Stats;
  try {
    stat = await fsp.stat(abs);
  } catch {
    throw new FileManagerError('Directory not found', 404, 'NOT_FOUND');
  }
  if (!stat.isDirectory()) {
    throw new FileManagerError('Not a directory', 400, 'NOT_A_DIRECTORY');
  }

  const names = await fsp.readdir(abs);
  const entries: DirEntry[] = [];
  for (const name of names) {
    const full = path.join(abs, name);
    let s: Stats;
    try {
      s = await fsp.lstat(full);
    } catch {
      continue;
    }
    // Skip symlinks for safety
    if (s.isSymbolicLink()) continue;

    const relForFile = path
      .relative(path.resolve(root.path), full)
      .replace(/\\/g, '/');

    // Honour deny list for listing too. Extension denies (.key/.pem/.aot)
    // apply to files only, so legitimate directories stay visible.
    if (isDenied(root, relForFile, s.isDirectory())) continue;

    entries.push({
      name,
      path: relForFile,
      type: s.isDirectory() ? 'directory' : 'file',
      size: s.size,
      mtime: s.mtime.toISOString(),
      mtimeMs: s.mtimeMs,
      isReadOnly: !root.rw,
    });
  }

  // Sort: directories first, then by name
  entries.sort((a, b) => {
    if (a.type !== b.type) return a.type === 'directory' ? -1 : 1;
    return a.name.localeCompare(b.name);
  });

  return {
    root: { id: root.id, path: root.path, rw: root.rw },
    path: (relPath || '').replace(/\\/g, '/').replace(/^\/+/, ''),
    entries,
  };
}

export async function readFile(
  rootId: string,
  relPath: string,
  maxBytes: number = MAX_READ_BYTES,
): Promise<ReadResult> {
  const root = getRoot(rootId);
  const abs = resolveSafe(root, relPath);

  let stat: Stats;
  try {
    stat = await fsp.stat(abs);
  } catch {
    throw new FileManagerError('File not found', 404, 'NOT_FOUND');
  }
  if (!stat.isFile()) {
    throw new FileManagerError('Not a file', 400, 'NOT_A_FILE');
  }

  if (stat.size > maxBytes) {
    throw new FileManagerError(
      `File too large (${stat.size} bytes, limit ${maxBytes}). Use download endpoint for large files.`,
      413,
      'FILE_TOO_LARGE',
    );
  }

  const buf = await fsp.readFile(abs);
  const binary = isLikelyBinary(abs, buf);

  if (binary) {
    return {
      content: buf.toString('base64'),
      encoding: 'base64',
      size: stat.size,
      mtimeMs: stat.mtimeMs,
      mtime: stat.mtime.toISOString(),
      truncated: false,
      isBinary: true,
    };
  }

  return {
    content: buf.toString('utf-8'),
    encoding: 'utf-8',
    size: stat.size,
    mtimeMs: stat.mtimeMs,
    mtime: stat.mtime.toISOString(),
    truncated: false,
    isBinary: false,
  };
}

export async function writeFile(
  rootId: string,
  relPath: string,
  content: string,
  encoding: 'utf-8' | 'base64' = 'utf-8',
  ifMatchMtime?: number,
): Promise<WriteResult> {
  const root = getRoot(rootId);
  if (!root.rw) {
    throw new FileManagerError('Root is read-only', 403, 'READ_ONLY');
  }
  const abs = resolveSafe(root, relPath);

  // Symlink defence: if the resolved path or any segment of its parent
  // chain is a symlink, refuse the write. This closes the TOCTOU window
  // between resolveSafe() and the actual write (a concurrent process
  // could otherwise swap a symlink in to redirect us outside the root).
  // We re-walk the directory chain with lstat — the absolute path is
  // already known to be inside `root.path` at this point.
  await assertNoSymlinkOnPath(root.path, abs);

  // Don't allow writing to a directory path
  let existing: Stats | null = null;
  try {
    existing = await fsp.lstat(abs);
  } catch {
    existing = null;
  }
  if (existing && existing.isSymbolicLink()) {
    throw new FileManagerError('Refusing to overwrite a symlink', 400, 'IS_SYMLINK');
  }
  if (existing && existing.isDirectory()) {
    throw new FileManagerError('Path is a directory', 400, 'IS_DIRECTORY');
  }

  // Conflict detection
  if (existing && ifMatchMtime !== undefined) {
    // Allow ~1 ms drift due to FS precision
    if (Math.abs(existing.mtimeMs - ifMatchMtime) > 1) {
      throw new FileManagerError(
        'File changed on disk since last read',
        409,
        'CONFLICT',
      );
    }
  }

  // Size check
  const buf = encoding === 'base64'
    ? Buffer.from(content, 'base64')
    : Buffer.from(content, 'utf-8');

  if (buf.length > MAX_WRITE_BYTES) {
    throw new FileManagerError(
      `Payload too large (${buf.length} bytes, limit ${MAX_WRITE_BYTES})`,
      413,
      'PAYLOAD_TOO_LARGE',
    );
  }

  // Ensure parent dir exists (re-check for symlinks afterwards in case
  // mkdir followed one — mkdir(recursive) doesn't create symlinks but
  // can succeed even if an intermediate dir is a symlink someone planted).
  await fsp.mkdir(path.dirname(abs), { recursive: true });
  await assertNoSymlinkOnPath(root.path, path.dirname(abs));

  // Atomic write via temp file + rename. The temp file lives in the same
  // directory so rename() is atomic on POSIX.
  const tmp = `${abs}.tmp-${process.pid}-${Date.now()}`;
  await fsp.writeFile(tmp, buf);
  await fsp.rename(tmp, abs);

  const newStat = await fsp.stat(abs);
  return {
    size: newStat.size,
    mtimeMs: newStat.mtimeMs,
    mtime: newStat.mtime.toISOString(),
  };
}

/**
 * Walk every path segment between rootDir and target and reject if any of
 * them is a symbolic link. Each segment is lstat()ed so the symlink-bit
 * is observed even when the target exists.
 */
async function assertNoSymlinkOnPath(rootDir: string, target: string): Promise<void> {
  const rel = path.relative(rootDir, target);
  if (rel.startsWith('..') || path.isAbsolute(rel)) return;
  const parts = rel.split(path.sep).filter(Boolean);
  let current = rootDir;
  for (const part of parts) {
    current = path.join(current, part);
    try {
      const st = await fsp.lstat(current);
      if (st.isSymbolicLink()) {
        throw new FileManagerError(`Refusing to traverse symlink ${path.relative(rootDir, current)}`, 400, 'PATH_SYMLINK');
      }
    } catch (err) {
      // Last segment may not exist yet (we're about to create it). Earlier
      // segments must exist; ENOENT there means the parent disappeared
      // between mkdir and write, which is itself suspicious — treat as
      // PATH_GONE.
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
      if (err instanceof FileManagerError) throw err;
      throw new FileManagerError('Failed to verify path', 500, 'PATH_VERIFY_FAILED');
    }
  }
}

export async function deleteFile(rootId: string, relPath: string): Promise<void> {
  const root = getRoot(rootId);
  if (!root.rw) {
    throw new FileManagerError('Root is read-only', 403, 'READ_ONLY');
  }
  const abs = resolveSafe(root, relPath);

  let stat: Stats;
  try {
    stat = await fsp.lstat(abs);
  } catch {
    throw new FileManagerError('Path not found', 404, 'NOT_FOUND');
  }

  // Don't allow deleting the root itself
  if (path.resolve(abs) === path.resolve(root.path)) {
    throw new FileManagerError('Cannot delete root directory', 403, 'FORBIDDEN');
  }

  if (stat.isDirectory()) {
    // Recursive delete; rm with force=false for safety
    await fsp.rm(abs, { recursive: true, force: false });
  } else {
    await fsp.unlink(abs);
  }
}

export async function moveFile(
  rootId: string,
  from: string,
  to: string,
): Promise<void> {
  const root = getRoot(rootId);
  if (!root.rw) {
    throw new FileManagerError('Root is read-only', 403, 'READ_ONLY');
  }
  const absFrom = resolveSafe(root, from);
  const absTo = resolveSafe(root, to);

  try {
    await fsp.access(absFrom);
  } catch {
    throw new FileManagerError('Source not found', 404, 'NOT_FOUND');
  }

  // Don't overwrite existing target
  try {
    await fsp.access(absTo);
    throw new FileManagerError('Target already exists', 409, 'TARGET_EXISTS');
  } catch (err) {
    if (err instanceof FileManagerError) throw err;
    // ENOENT is expected
  }

  await fsp.mkdir(path.dirname(absTo), { recursive: true });
  await fsp.rename(absFrom, absTo);
}

export interface UploadFileLike {
  buffer: Buffer;
  originalname: string;
  size: number;
}

export async function uploadFile(
  rootId: string,
  relPath: string,
  file: UploadFileLike,
): Promise<WriteResult> {
  const root = getRoot(rootId);
  if (!root.rw) {
    throw new FileManagerError('Root is read-only', 403, 'READ_ONLY');
  }
  if (file.size > MAX_WRITE_BYTES) {
    throw new FileManagerError(
      `Upload too large (${file.size} bytes, limit ${MAX_WRITE_BYTES})`,
      413,
      'PAYLOAD_TOO_LARGE',
    );
  }

  // Sanitize the destination - file goes into relPath (directory) with file.originalname
  const safeName = path.basename(file.originalname).replace(/[/\\]/g, '_');
  if (!safeName || safeName === '.' || safeName === '..') {
    throw new FileManagerError('Invalid filename', 400, 'INVALID_FILENAME');
  }

  const destRel = relPath
    ? `${relPath.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')}/${safeName}`
    : safeName;

  const abs = resolveSafe(root, destRel);
  await fsp.mkdir(path.dirname(abs), { recursive: true });

  const tmp = `${abs}.tmp-${process.pid}-${Date.now()}`;
  await fsp.writeFile(tmp, file.buffer);
  await fsp.rename(tmp, abs);

  const stat = await fsp.stat(abs);
  return {
    size: stat.size,
    mtimeMs: stat.mtimeMs,
    mtime: stat.mtime.toISOString(),
  };
}

export async function openDownloadStream(
  rootId: string,
  relPath: string,
): Promise<{ stream: ReadStream; size: number; filename: string }> {
  const root = getRoot(rootId);
  const abs = resolveSafe(root, relPath);

  let stat: Stats;
  try {
    stat = await fsp.stat(abs);
  } catch {
    throw new FileManagerError('File not found', 404, 'NOT_FOUND');
  }
  if (!stat.isFile()) {
    throw new FileManagerError('Not a file', 400, 'NOT_A_FILE');
  }
  return {
    stream: createReadStream(abs),
    size: stat.size,
    filename: path.basename(abs),
  };
}
