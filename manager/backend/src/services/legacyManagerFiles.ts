/**
 * config.json (JWT secret), users.json (password hashes) and setup-config.json
 * (server password, store keys, during the wizard the admin password hash)
 * that older versions wrote into the game server's data folder.
 *
 * The panel reads them from its own volume. The data folder is one the game
 * server (and every mod on it) can write to, and every game backup contains
 * it, so the files are moved out of there exactly once, and nothing in them
 * is trusted beyond what an older panel version wrote there:
 *  - a marker in the manager volume records the run (setup-config.json has a
 *    marker of its own, it moved later); after it nothing in the data folder
 *    is taken over again (a file put there later stays unused);
 *  - only a regular file (no link) that has the shape of the panel's own file
 *    is used; anything else is left where it is and reported;
 *  - config.json: only the record that the setup is done, never the JWT
 *    secret (JWT_SECRET from the environment, or a new secret), CORS origins,
 *    proxy trust, sign-in or backup settings: those come from the environment,
 *    as they did while the file lay unused in the data folder;
 *  - users.json: only into a manager volume whose setup was already finished
 *    before (an older wizard put its admin there); never into a fresh volume,
 *    where a planted file would name the first admin;
 *  - setup-config.json: only the setup state and the first choices of the
 *    wizard (language, download method, patchline, auto-update), never the
 *    admin, its password hash, network, store keys or server settings: the
 *    wizard writes those into config.json at its end. An unfinished setup
 *    keeps only its language and asks for the rest again; a finished one
 *    without config.json in the manager volume runs the wizard again (a new
 *    volume, old leftovers);
 *  - a file the manager volume already has, or one that is not taken over, is
 *    kept beside it under legacy-data-files/ (not used) instead;
 *  - the file in the data folder is removed only after its copy in the
 *    manager volume was read back and found identical, and only if it did not
 *    change in the meantime;
 *  - an I/O error stops the run without the marker, so it is repeated on the
 *    next start.
 */
import { promises as fsp } from 'fs';
import path from 'path';
import crypto from 'crypto';
import { z } from 'zod';
import { config, getManagerDataDir, reloadConfigFromFile } from '../config.js';
import { logger } from '../utils/logger.js';
import { readRegularFile, UnsafeFileError } from '../utils/noFollowFs.js';

const MARKER_NAME = '.legacy-data-files-adopted';
const SETUP_MARKER_NAME = '.legacy-setup-config-adopted';
const KEPT_DIR_NAME = 'legacy-data-files';
// The files are a few KB; the cap only keeps a planted file from filling the volume.
const MAX_BYTES = 4 * 1024 * 1024;
const FILE_MODE = 0o600;
const DIR_MODE = 0o700;
// Same minimum as the security check of config.ts.
const MIN_SECRET_LENGTH = 32;

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

const SetupConfigSchema = z.object({ setupComplete: z.boolean() }).passthrough();

// What the env migration of older versions wrote into config.json beyond the
// settings the environment still provides.
const ADOPTED_CONFIG_KEYS = [
  'setupComplete',
  'automation',
  'plugin',
  'panelVersion',
  'newFeaturesAvailable',
  'newFeaturesBannerDismissed',
];
// What setup-config.json of a finished setup keeps; of an unfinished one only
// the language.
const ADOPTED_SETUP_KEYS = [
  'setupComplete',
  'setupCompletedAt',
  'language',
  'downloadMethod',
  'patchline',
  'autoUpdate',
];
const ADOPTED_OPEN_SETUP_KEYS = ['setupComplete', 'language'];

type Json = Record<string, unknown>;

interface AdoptContext {
  managerDir: string;
  /** The manager volume's config.json said the setup is finished before this run. */
  setupFinishedBefore: boolean;
}

/** The content for the manager volume, or why the file is not taken over. */
type Adoption = { content: Buffer } | { refused: string };

interface LegacyFile {
  name: string;
  schema: z.ZodTypeAny;
  adopt: (json: Json, raw: Buffer, ctx: AdoptContext) => Promise<Adoption>;
}

const toBuffer = (json: Json) => Buffer.from(`${JSON.stringify(json, null, 2)}\n`, 'utf-8');

function pick(json: Json, keys: string[]): Json {
  const picked: Json = {};
  for (const key of keys) {
    if (json[key] !== undefined) picked[key] = json[key];
  }
  return picked;
}

async function adoptConfig(json: Json): Promise<Adoption> {
  const content = pick(json, ADOPTED_CONFIG_KEYS);
  // Without a usable JWT_SECRET the panel would have no secret at all.
  if ((process.env.JWT_SECRET ?? '').length < MIN_SECRET_LENGTH) {
    content.jwtSecret = crypto.randomBytes(48).toString('base64');
  }
  return { content: toBuffer(content) };
}

async function adoptUsers(_json: Json, raw: Buffer, ctx: AdoptContext): Promise<Adoption> {
  if (!ctx.setupFinishedBefore) {
    return { refused: 'the manager volume has no finished setup to add these accounts to' };
  }
  return { content: raw };
}

async function adoptSetupConfig(json: Json, _raw: Buffer, ctx: AdoptContext): Promise<Adoption> {
  // A finished setup without config.json in the manager volume is run again.
  const finished =
    json.setupComplete === true &&
    (await readIfExists(path.join(ctx.managerDir, 'config.json'))) !== null;
  const content = pick(json, finished ? ADOPTED_SETUP_KEYS : ADOPTED_OPEN_SETUP_KEYS);
  content.setupComplete = finished;
  return { content: toBuffer(content) };
}

const ACCOUNT_FILES: LegacyFile[] = [
  { name: 'config.json', schema: PanelConfigSchema, adopt: adoptConfig },
  { name: 'users.json', schema: UsersSchema, adopt: adoptUsers },
];
const SETUP_FILES: LegacyFile[] = [
  { name: 'setup-config.json', schema: SetupConfigSchema, adopt: adoptSetupConfig },
];

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

function parseLegacy(schema: z.ZodTypeAny, content: Buffer): { json: Json } | { problem: string } {
  let json: unknown;
  try {
    json = JSON.parse(content.toString('utf-8'));
  } catch {
    return { problem: 'not valid JSON' };
  }
  const parsed = schema.safeParse(json);
  if (parsed.success) return { json: json as Json };
  return {
    problem: parsed.error.issues
      .slice(0, 3)
      .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('; '),
  };
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

async function keepCopy(managerDir: string, name: string, content: Buffer): Promise<string> {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const copy = path.join(managerDir, KEPT_DIR_NAME, `${name}.${stamp}`);
  await writeVerifiedCopy(copy, content);
  return copy;
}

async function takeOver(
  spec: LegacyFile,
  dataDir: string,
  ctx: AdoptContext,
): Promise<TakeOverResult> {
  const legacy = path.join(dataDir, spec.name);
  const content = await readLegacy(legacy, dataDir);
  if (content === null) return { outcome: 'absent' };
  if (content === 'refused') return { outcome: 'refused' };
  const parsed = parseLegacy(spec.schema, content);
  if ('problem' in parsed) {
    logger.error(
      `[Migration] ${legacy} does not look like the panel's ${spec.name} (${parsed.problem}). ` +
        'It was not taken over and was left in place.',
    );
    return { outcome: 'refused' };
  }

  const target = path.join(ctx.managerDir, spec.name);
  const existing = await readIfExists(target);
  let outcome: Outcome;
  let copy = target;
  let why = '';
  if (existing === null) {
    const adoption = await spec.adopt(parsed.json, content, ctx);
    if ('content' in adoption) {
      await writeVerifiedCopy(target, adoption.content);
      outcome = 'adopted';
    } else {
      copy = await keepCopy(ctx.managerDir, spec.name, content);
      outcome = 'kept';
      why = adoption.refused;
    }
  } else if (existing.equals(content)) {
    outcome = 'removed';
  } else {
    copy = await keepCopy(ctx.managerDir, spec.name, content);
    outcome = 'kept';
    why = `the manager volume has its own ${spec.name}`;
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
        ? `not taken over (${why}); the old copy was kept as ${copy}`
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

async function setupFinished(managerDir: string): Promise<boolean> {
  try {
    const content = await readIfExists(path.join(managerDir, 'config.json'));
    if (content === null) return false;
    return (JSON.parse(content.toString('utf-8')) as Json).setupComplete === true;
  } catch {
    return false;
  }
}

/** Takes `specs` over once (marker `markerName`); returns the files copied into the manager volume. */
async function takeOverOnce(
  markerName: string,
  specs: LegacyFile[],
  dataDir: string,
  ctx: AdoptContext,
): Promise<{ adopted: string[]; legacySecret: string | null }> {
  const marker = path.join(ctx.managerDir, markerName);
  if ((await readIfExists(marker)) !== null) return { adopted: [], legacySecret: null };
  const adopted: string[] = [];
  let legacySecret: string | null = null;
  try {
    for (const spec of specs) {
      const { outcome, content } = await takeOver(spec, dataDir, ctx);
      if (outcome === 'adopted') adopted.push(spec.name);
      if (spec.name === 'config.json' && content) legacySecret = secretOf(content);
    }
    await fsp.mkdir(ctx.managerDir, { recursive: true });
    await fsp.writeFile(marker, `${new Date().toISOString()}\n`, { flag: 'wx', mode: FILE_MODE });
  } catch (err) {
    logger.error(
      `[Migration] Taking over ${specs.map((s) => s.name).join('/')} from the data folder ` +
        'failed; retried on the next start:',
      err,
    );
  }
  return { adopted, legacySecret };
}

/**
 * Takes config.json, users.json and setup-config.json over from the data
 * folder, once (see the module comment). Returns the files copied into the
 * manager volume.
 */
export async function adoptLegacyManagerFiles(): Promise<string[]> {
  const dataDir = config.dataPath;
  const managerDir = getManagerDataDir();
  if (path.resolve(dataDir) === path.resolve(managerDir)) return [];
  const ctx: AdoptContext = { managerDir, setupFinishedBefore: await setupFinished(managerDir) };

  const accounts = await takeOverOnce(MARKER_NAME, ACCOUNT_FILES, dataDir, ctx);
  const setup = await takeOverOnce(SETUP_MARKER_NAME, SETUP_FILES, dataDir, ctx);
  if (accounts.adopted.includes('config.json')) reloadConfigFromFile();
  warnIfSecretWasExposed(accounts.legacySecret);
  return [...accounts.adopted, ...setup.adopted];
}
