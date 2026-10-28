/**
 * Reading and writing files the game server owns: its config.json, the other
 * JSON files in the server folder (permissions.json, bans.json) and the world
 * configs.
 *
 * Writes follow the server's own scheme (it keeps the replaced content as
 * `<name>.bak` and reads that copy when the file itself is unreadable), and
 * use the link-safe helpers of noFollowFs: only a regular file inside the
 * expected folder is read, the new content goes to a fresh temporary file that
 * is renamed over the old one. Callers in this process are serialized per file
 * with the same lock jsonStore uses, so they cannot lose each other's changes.
 *
 * None of this keeps the running server from writing its own copy back; the
 * routes only write while it is stopped (see services/serverLifecycle.ts).
 */
import path from 'path';
import { withFileLock } from './jsonStore.js';
import { openRegularFile, replaceFileContent, UnsafeFileError } from './noFollowFs.js';
import { parseLosslessJson, stringifyJson } from './losslessJson.js';

/** Larger than any config the server writes; a bigger file is refused. */
export const MAX_SERVER_FILE_BYTES = 16 * 1024 * 1024;
const DEFAULT_MODE = 0o664;

export interface ServerFile {
  content: string;
  /** Permission bits, kept when the file is replaced. */
  mode: number;
}

const isMissing = (err: unknown) => (err as NodeJS.ErrnoException).code === 'ENOENT';

/** Content of a regular file inside `roots`, or null when it does not exist. */
export async function readServerFile(
  filePath: string,
  roots: string[],
): Promise<ServerFile | null> {
  let opened: Awaited<ReturnType<typeof openRegularFile>>;
  try {
    opened = await openRegularFile(filePath, roots);
  } catch (err) {
    if (isMissing(err)) return null;
    throw err;
  }
  const { fh, stats } = opened;
  try {
    if (stats.size > MAX_SERVER_FILE_BYTES) {
      throw new UnsafeFileError(filePath, `it is larger than ${MAX_SERVER_FILE_BYTES} bytes`);
    }
    return { content: (await fh.readFile()).toString('utf-8'), mode: stats.mode & 0o777 };
  } finally {
    await fh.close().catch(() => undefined);
  }
}

async function writeLocked(
  filePath: string,
  roots: string[],
  content: string,
  previous: ServerFile | null,
): Promise<void> {
  const mode = previous?.mode ?? DEFAULT_MODE;
  if (previous) await replaceFileContent(`${filePath}.bak`, previous.content, roots, mode);
  await replaceFileContent(filePath, content, roots, mode);
}

/** Replaces the file with `content`; the old content becomes `<name>.bak`. */
export async function writeServerFile(
  filePath: string,
  roots: string[],
  content: string,
): Promise<void> {
  await withFileLock(filePath, async () =>
    writeLocked(filePath, roots, content, await readServerFile(filePath, roots)),
  );
}

/** A server JSON file that is not valid JSON; the panel will not rewrite it. */
export class ServerJsonParseError extends Error {
  constructor(readonly filePath: string) {
    super(
      `${path.basename(filePath)} is not valid JSON. Fix it in the file editor or restore ` +
        `${path.basename(filePath)}.bak first.`,
    );
    this.name = 'ServerJsonParseError';
  }
}

/** Parsed content (big integers kept exactly), or null when the file does not exist. */
export async function readServerJson(filePath: string, roots: string[]): Promise<unknown | null> {
  const file = await readServerFile(filePath, roots);
  if (!file) return null;
  try {
    return parseLosslessJson(file.content);
  } catch {
    throw new ServerJsonParseError(filePath);
  }
}

/**
 * Read-modify-write of a server JSON file under its lock. `mutate` gets the
 * parsed content (null when the file does not exist) and returns the new
 * content, or undefined to leave the file alone. Resolves to what the file
 * holds afterwards.
 */
export async function updateServerJson<T>(
  filePath: string,
  roots: string[],
  mutate: (current: unknown | null) => T | undefined | Promise<T | undefined>,
): Promise<T | unknown | null> {
  return withFileLock(filePath, async () => {
    const previous = await readServerFile(filePath, roots);
    let current: unknown | null = null;
    if (previous) {
      try {
        current = parseLosslessJson(previous.content);
      } catch {
        throw new ServerJsonParseError(filePath);
      }
    }
    const next = await mutate(current);
    if (next === undefined) return current;
    await writeLocked(filePath, roots, `${stringifyJson(next)}\n`, previous);
    return next;
  });
}
