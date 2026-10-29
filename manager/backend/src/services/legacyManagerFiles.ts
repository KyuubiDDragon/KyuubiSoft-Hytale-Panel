/**
 * config.json (JWT secret) and users.json (password hashes) that older
 * versions wrote into the game server's data folder.
 *
 * The panel reads both from its own volume, so such an install fell back into
 * the setup wizard. The data folder is one the game server can write to, and
 * every game backup contains it, so the files are taken over exactly once and
 * then removed from there:
 *  - a marker in the manager volume records the run; after it nothing in the
 *    data folder is taken over again (a file put there later stays unused);
 *  - only a regular file (no link) that has the shape of the panel's own file
 *    is used; anything else is left where it is and reported;
 *  - a file the manager volume does not have yet is taken over; when it has
 *    one of its own, the old copy is kept beside it under legacy-data-files/;
 *  - the file in the data folder is removed only after its copy in the
 *    manager volume was read back and found identical, and only if it did not
 *    change in the meantime;
 *  - an I/O error stops the run without the marker, so it is repeated on the
 *    next start.
 */
import { promises as fsp } from 'fs';
import path from 'path';
import { z } from 'zod';
import { config, getManagerDataDir, reloadConfigFromFile } from '../config.js';
import { logger } from '../utils/logger.js';
import { readRegularFile, UnsafeFileError } from '../utils/noFollowFs.js';

const MARKER_NAME = '.legacy-data-files-adopted';
const KEPT_DIR_NAME = 'legacy-data-files';
// Both files are a few KB; the cap only keeps a planted file from filling the volume.
const MAX_BYTES = 4 * 1024 * 1024;
const FILE_MODE = 0o600;
const DIR_MODE = 0o700;

const PanelConfigSchema = z
  .object({
    setupComplete: z.boolean(),
    jwtSecret: z.union([z.literal(''), z.string().min(32)]).optional(),
    corsOrigins: z.array(z.string()).optional(),
  })
  .passthrough();

const UsersSchema = z
  .object({
    users: z
      .array(
        z
          .object({
            username: z.string().regex(/^[a-zA-Z0-9_-]{3,32}$/),
            passwordHash: z.string().regex(/^\$2[aby]\$\d{2}\$[./A-Za-z0-9]{53}$/),
            roleId: z.string().min(1),
          })
          .passthrough(),
      )
      .min(1),
  })
  .passthrough();

const LEGACY_FILES = [
  { name: 'config.json', schema: PanelConfigSchema },
  { name: 'users.json', schema: UsersSchema },
] as const;

type Outcome = 'absent' | 'refused' | 'adopted' | 'kept' | 'removed';

interface TakeOverResult {
  outcome: Outcome;
  /** What was read, when it had the panel's shape. */
  content?: Buffer;
}

const isMissing = (err: unknown) => (err as NodeJS.ErrnoException).code === 'ENOENT';

async function readIfExists(file: string): Promise<Buffer | null> {
  try {
    return await fsp.readFile(file);
  } catch (err) {
    if (isMissing(err)) return null;
    throw err;
  }
}

function schemaProblem(schema: z.ZodTypeAny, content: Buffer): string | null {
  let json: unknown;
  try {
    json = JSON.parse(content.toString('utf-8'));
  } catch {
    return 'not valid JSON';
  }
  const parsed = schema.safeParse(json);
  if (parsed.success) return null;
  return parsed.error.issues
    .slice(0, 3)
    .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
    .join('; ');
}

/** The file in the data folder, if it is a regular file there; null when missing or refused. */
async function readLegacy(legacy: string, dataDir: string): Promise<Buffer | null | 'refused'> {
  try {
    return await readRegularFile(legacy, [dataDir], { maxBytes: MAX_BYTES });
  } catch (err) {
    if (isMissing(err)) return null;
    if (err instanceof UnsafeFileError) {
      logger.error(
        `[Migration] Not taking over ${legacy}: ${err.why}. It was left in place and is not used.`,
      );
      return 'refused';
    }
    throw err;
  }
}

async function writeVerifiedCopy(file: string, content: Buffer): Promise<void> {
  await fsp.mkdir(path.dirname(file), { recursive: true, mode: DIR_MODE });
  await fsp.writeFile(file, content, { flag: 'wx', mode: FILE_MODE });
  if (!(await fsp.readFile(file)).equals(content)) {
    throw new Error(`the copy ${file} does not match what was read`);
  }
}

async function takeOver(
  spec: (typeof LEGACY_FILES)[number],
  dataDir: string,
  managerDir: string,
): Promise<TakeOverResult> {
  const legacy = path.join(dataDir, spec.name);
  const content = await readLegacy(legacy, dataDir);
  if (content === null) return { outcome: 'absent' };
  if (content === 'refused') return { outcome: 'refused' };
  const problem = schemaProblem(spec.schema, content);
  if (problem) {
    logger.error(
      `[Migration] ${legacy} does not look like the panel's ${spec.name} (${problem}). ` +
        'It was not taken over and was left in place.',
    );
    return { outcome: 'refused' };
  }

  const target = path.join(managerDir, spec.name);
  const existing = await readIfExists(target);
  let outcome: Outcome;
  let copy = target;
  if (existing === null) {
    await writeVerifiedCopy(target, content);
    outcome = 'adopted';
  } else if (existing.equals(content)) {
    outcome = 'removed';
  } else {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    copy = path.join(managerDir, KEPT_DIR_NAME, `${spec.name}.${stamp}`);
    await writeVerifiedCopy(copy, content);
    outcome = 'kept';
  }

  // Removed only while it still is exactly what was copied.
  const now = await readLegacy(legacy, dataDir);
  if (!Buffer.isBuffer(now) || !now.equals(content)) {
    logger.warn(
      `[Migration] ${legacy} changed while it was taken over and was left in place; ` +
        'delete it by hand, the panel does not use it.',
    );
    return { outcome, content };
  }
  await fsp.unlink(legacy);
  const what =
    outcome === 'adopted'
      ? `taken over into ${target}`
      : outcome === 'kept'
        ? `not taken over (the manager volume has its own ${spec.name}); the old copy was kept as ${copy}`
        : `identical to ${target}`;
  logger.warn(
    `[Migration] Removed ${legacy} from the game server's data folder: ${what}. ` +
      'It no longer ends up in game backups.',
  );
  return { outcome, content };
}

/** Warns when a JWT secret that lay in the data folder is the one the panel signs with now. */
function warnIfSecretWasExposed(legacySecret: string | null): void {
  if (!legacySecret || config.jwtSecret !== legacySecret) return;
  logger.warn(
    "[Migration] The panel's JWT secret lay in the game server's data folder (and in its " +
      'backups). Replace it with a new secret (jwtSecret in config.json or JWT_SECRET); ' +
      'everyone then has to sign in again.',
  );
}

function secretOf(content: Buffer): string | null {
  try {
    const secret = (JSON.parse(content.toString('utf-8')) as { jwtSecret?: unknown }).jwtSecret;
    return typeof secret === 'string' && secret !== '' ? secret : null;
  } catch {
    return null;
  }
}

/**
 * Takes config.json and users.json over from the data folder, once (see the
 * module comment). Returns the files copied into the manager volume.
 */
export async function adoptLegacyManagerFiles(): Promise<string[]> {
  const dataDir = config.dataPath;
  const managerDir = getManagerDataDir();
  if (path.resolve(dataDir) === path.resolve(managerDir)) return [];
  const marker = path.join(managerDir, MARKER_NAME);
  if ((await readIfExists(marker)) !== null) return [];

  const adopted: string[] = [];
  let legacySecret: string | null = null;
  try {
    for (const spec of LEGACY_FILES) {
      const { outcome, content } = await takeOver(spec, dataDir, managerDir);
      if (outcome === 'adopted') adopted.push(spec.name);
      if (spec.name === 'config.json' && content) legacySecret = secretOf(content);
    }
    await fsp.mkdir(managerDir, { recursive: true });
    await fsp.writeFile(marker, `${new Date().toISOString()}\n`, { flag: 'wx', mode: FILE_MODE });
  } catch (err) {
    logger.error(
      '[Migration] Taking over config.json/users.json from the data folder failed; ' +
        'retried on the next start:',
      err,
    );
  }
  if (adopted.includes('config.json')) reloadConfigFromFile();
  warnIfSecretWasExposed(legacySecret);
  return adopted;
}
