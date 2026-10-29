/**
 * Vitest port of the original tsx-runnable __fileManager.checks.ts.
 * Covers path-traversal blocking, deny lists, and resolveSafe behaviour.
 */
import fs, { promises as fsp } from 'fs';
import path from 'path';
import os from 'os';
import { describe, it, beforeAll, afterAll, expect } from 'vitest';
import {
  resolveSafe,
  isDenied,
  isAbsolutePathAllowed,
  listDir,
  readFile,
  writeFile,
  deleteFile,
  moveFile,
  uploadFile,
  openDownloadStream,
  type FileManagerRoot,
  FileManagerError,
} from './fileManager.js';
import { config } from '../config.js';

let tmpRoot: string;
let root: FileManagerRoot;

beforeAll(async () => {
  tmpRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'fm-test-'));
  root = {
    id: 'test',
    path: tmpRoot,
    rw: true,
    permission: 'files.write',
    deny: ['secret.txt', 'auth/'],
  };
  await fsp.writeFile(path.join(tmpRoot, 'hello.txt'), 'hello world', 'utf-8');
  await fsp.mkdir(path.join(tmpRoot, 'sub'));
  await fsp.writeFile(path.join(tmpRoot, 'sub', 'nested.txt'), 'nested', 'utf-8');
  await fsp.writeFile(path.join(tmpRoot, 'secret.txt'), 'top secret', 'utf-8');
  await fsp.mkdir(path.join(tmpRoot, 'auth'));
  await fsp.writeFile(path.join(tmpRoot, 'auth', 'token.txt'), 'tok', 'utf-8');
});

afterAll(async () => {
  await fsp.rm(tmpRoot, { recursive: true, force: true });
});

function expectFmError(fn: () => unknown, code: string) {
  try {
    fn();
    throw new Error('expected throw');
  } catch (e) {
    expect(e).toBeInstanceOf(FileManagerError);
    expect((e as FileManagerError).code).toBe(code);
  }
}

describe('fileManager.resolveSafe', () => {
  it('blocks .. traversal', () => {
    expectFmError(() => resolveSafe(root, '../../etc/passwd'), 'PATH_TRAVERSAL');
  });

  it('blocks absolute paths', () => {
    expectFmError(() => resolveSafe(root, '/etc/passwd'), 'PATH_FORBIDDEN');
  });

  it('blocks deep traversal via mixed separators', () => {
    expectFmError(() => resolveSafe(root, 'sub/../../etc'), 'PATH_TRAVERSAL');
  });

  it('allows valid relative path', () => {
    const resolved = resolveSafe(root, 'sub/nested.txt');
    expect(resolved.startsWith(tmpRoot)).toBe(true);
  });

  it('throws on deny match', () => {
    expectFmError(() => resolveSafe(root, 'secret.txt'), 'PATH_DENIED');
    expectFmError(() => resolveSafe(root, 'auth/token.txt'), 'PATH_DENIED');
  });
});

describe('fileManager.isDenied', () => {
  it('blocks per-root deny exact file', () => {
    expect(isDenied(root, 'secret.txt')).toBe(true);
  });
  it('blocks per-root deny dir prefix', () => {
    expect(isDenied(root, 'auth/token.txt')).toBe(true);
  });
  it('blocks global .env', () => {
    expect(isDenied(root, '.env')).toBe(true);
    expect(isDenied(root, 'foo/.env')).toBe(true);
  });
  it('blocks .key files globally', () => {
    expect(isDenied(root, 'tls/server.key')).toBe(true);
  });
  it('blocks users.json globally', () => {
    expect(isDenied(root, 'users.json')).toBe(true);
    // Atomic-write temp files and preserved corrupt copies hold the same secrets.
    expect(isDenied(root, 'users.json.tmp-123-abcd')).toBe(true);
    expect(isDenied(root, 'users.json.corrupt-2026-10-22T10-00-00-000Z')).toBe(true);
  });
  it('blocks the plugin token store globally', () => {
    expect(isDenied(root, 'plugin-tokens.json')).toBe(true);
    expect(isDenied(root, 'data/plugin-tokens.json.tmp-123-abcd')).toBe(true);
  });
  it('blocks every copy of a config.json, not just the file itself', () => {
    // The KyuubiSoft API plugin config holds its bearer token.
    expect(isDenied(root, 'config/kyuubisoft-api/config.json')).toBe(true);
    expect(
      isDenied(root, 'config/kyuubisoft-api/config.json.corrupt-2026-10-22T10-00-00-000Z'),
    ).toBe(true);
    expect(isDenied(root, 'config/kyuubisoft-api/config.json.tmp-123-abcd')).toBe(true);
    expect(isDenied(root, 'config.json.bak')).toBe(true);
  });
  it('blocks the whole KyuubiSoft API plugin config directory', () => {
    expect(isDenied(root, 'config/kyuubisoft-api', true)).toBe(true);
    expect(isDenied(root, 'config/KyuubiSoft-API/notes.txt')).toBe(true);
    expect(isDenied(root, 'config', true)).toBe(false);
    expect(isDenied(root, 'config/other-mod/settings.json')).toBe(false);
    expect(isDenied(root, 'myconfig.json')).toBe(false);
  });
  it('allows normal files', () => {
    expect(isDenied(root, 'hello.txt')).toBe(false);
    expect(isDenied(root, 'sub/nested.txt')).toBe(false);
  });
});

// Guards the legacy /api/management/config/{read,write} routes. These take an
// ABSOLUTE path, so getRealPathIfSafe()'s root-boundary check alone let a
// config.edit holder overwrite the server JAR (RCE) or read auth.enc.
describe('fileManager.isAbsolutePathAllowed', () => {
  const server = config.serverPath;
  const mods = config.modsPath;
  const data = config.dataPath;

  it('blocks overwriting the server JAR (RCE on restart)', () => {
    expect(isAbsolutePathAllowed(path.join(server, 'HytaleServer.jar'), 'write')).toBe(false);
  });
  it('blocks reading encrypted Hytale auth credentials', () => {
    expect(isAbsolutePathAllowed(path.join(server, 'auth.enc'), 'read')).toBe(false);
  });
  it('blocks the schema-validated config.json and users.json', () => {
    expect(isAbsolutePathAllowed(path.join(server, 'config.json'), 'write')).toBe(false);
    expect(isAbsolutePathAllowed(path.join(data, 'users.json'), 'read')).toBe(false);
  });
  it('blocks reading the plugin token through the plugin config or its copies', () => {
    const pluginDir = path.join(server, 'config', 'kyuubisoft-api');
    expect(isAbsolutePathAllowed(path.join(pluginDir, 'config.json'), 'read')).toBe(false);
    expect(isAbsolutePathAllowed(path.join(pluginDir, 'config.json.corrupt-1'), 'read')).toBe(
      false,
    );
    expect(isAbsolutePathAllowed(path.join(server, 'config.json.bak'), 'read')).toBe(false);
  });
  it('blocks key/pem secret files', () => {
    expect(isAbsolutePathAllowed(path.join(server, 'server.key'), 'read')).toBe(false);
    expect(isAbsolutePathAllowed(path.join(server, 'tls.pem'), 'read')).toBe(false);
  });
  it('blocks paths outside every managed root', () => {
    expect(isAbsolutePathAllowed('/etc/passwd', 'read')).toBe(false);
    expect(isAbsolutePathAllowed(path.join(server, '..', '..', 'etc', 'shadow'), 'read')).toBe(
      false,
    );
  });
  it('blocks writes under the read-only data root', () => {
    expect(isAbsolutePathAllowed(path.join(data, 'whatever.json'), 'write')).toBe(false);
  });
  it('allows legitimate mod/server config files', () => {
    expect(isAbsolutePathAllowed(path.join(mods, 'SomeMod', 'config.yml'), 'write')).toBe(true);
    expect(isAbsolutePathAllowed(path.join(server, 'server.properties'), 'write')).toBe(true);
  });
});

// Symlinks inside a root (e.g. planted by an imported world archive) must not
// give access to anything outside it. File symlinks need extra rights on
// Windows, so those cases are skipped there; directory links use a junction,
// which works unprivileged ('junction' is ignored on POSIX).
function canCreateLink(type: 'file' | 'junction'): boolean {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kp-link-probe-'));
  try {
    const target = path.join(dir, 'target');
    if (type === 'file') fs.writeFileSync(target, '');
    else fs.mkdirSync(target);
    fs.symlinkSync(target, path.join(dir, 'link'), type);
    return true;
  } catch {
    return false;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const CAN_LINK_FILES = canCreateLink('file');
const CAN_LINK_DIRS = canCreateLink('junction');

describe('fileManager symlink containment', () => {
  let base: string;
  let modsDir: string;
  let outside: string;
  let savedModsPath: string;

  beforeAll(async () => {
    base = await fsp.mkdtemp(path.join(os.tmpdir(), 'fm-links-'));
    modsDir = path.join(base, 'mods');
    outside = path.join(base, 'outside');
    await fsp.mkdir(modsDir);
    await fsp.mkdir(path.join(outside, 'dir'), { recursive: true });
    await fsp.writeFile(path.join(outside, 'users.json'), '{"secret":true}');
    await fsp.writeFile(path.join(outside, 'dir', 'secret.txt'), 'top secret');
    await fsp.writeFile(path.join(modsDir, 'ok.txt'), 'fine');
    await fsp.writeFile(path.join(modsDir, 'users.json'), 'denied inside the root');
    savedModsPath = config.modsPath;
    config.modsPath = modsDir;
    if (CAN_LINK_DIRS) {
      fs.symlinkSync(path.join(outside, 'dir'), path.join(modsDir, 'linkdir'), 'junction');
    }
    if (CAN_LINK_FILES) {
      fs.symlinkSync(path.join(outside, 'users.json'), path.join(modsDir, 'link.json'), 'file');
      fs.symlinkSync(path.join(modsDir, 'ok.txt'), path.join(modsDir, 'alias.txt'), 'file');
      fs.symlinkSync(path.join(modsDir, 'users.json'), path.join(modsDir, 'notes.txt'), 'file');
      fs.symlinkSync(path.join(base, 'missing'), path.join(modsDir, 'dangling.txt'), 'file');
    }
  });

  afterAll(async () => {
    config.modsPath = savedModsPath;
    await fsp.rm(base, { recursive: true, force: true });
  });

  const upload = (name: string) => ({ buffer: Buffer.from('x'), originalname: name, size: 1 });

  it.skipIf(!CAN_LINK_DIRS)(
    'refuses list/read/download through a directory link that leaves the root',
    async () => {
      await expect(listDir('mods', 'linkdir')).rejects.toMatchObject({
        code: 'PATH_SYMLINK_ESCAPE',
      });
      await expect(readFile('mods', 'linkdir/secret.txt')).rejects.toMatchObject({
        code: 'PATH_SYMLINK_ESCAPE',
      });
      await expect(openDownloadStream('mods', 'linkdir/secret.txt')).rejects.toMatchObject({
        code: 'PATH_SYMLINK_ESCAPE',
      });
    },
  );

  it.skipIf(!CAN_LINK_DIRS)(
    'refuses write/upload/move/delete through a directory link that leaves the root',
    async () => {
      await expect(writeFile('mods', 'linkdir/new.txt', 'x')).rejects.toMatchObject({
        code: 'PATH_SYMLINK_ESCAPE',
      });
      await expect(uploadFile('mods', 'linkdir', upload('up.txt'))).rejects.toMatchObject({
        code: 'PATH_SYMLINK_ESCAPE',
      });
      await expect(moveFile('mods', 'ok.txt', 'linkdir/moved.txt')).rejects.toMatchObject({
        code: 'PATH_SYMLINK_ESCAPE',
      });
      await expect(deleteFile('mods', 'linkdir/secret.txt')).rejects.toMatchObject({
        code: 'PATH_SYMLINK_ESCAPE',
      });
      expect(await fsp.readdir(path.join(outside, 'dir'))).toEqual(['secret.txt']);
      expect(fs.existsSync(path.join(modsDir, 'ok.txt'))).toBe(true);
    },
  );

  it.skipIf(!CAN_LINK_DIRS)(
    'hides links from listings and keeps normal files working',
    async () => {
      const listing = await listDir('mods', '');
      const names = listing.entries.map((e) => e.name);
      expect(names).toContain('ok.txt');
      expect(names).not.toContain('linkdir');
      const read = await readFile('mods', 'ok.txt');
      expect(read.content).toBe('fine');
    },
  );

  it.skipIf(!CAN_LINK_DIRS)('isAbsolutePathAllowed decides on the real location', () => {
    expect(isAbsolutePathAllowed(path.join(modsDir, 'linkdir', 'secret.txt'), 'read')).toBe(false);
    expect(isAbsolutePathAllowed(path.join(modsDir, 'linkdir', 'new.cfg'), 'write')).toBe(false);
    expect(isAbsolutePathAllowed(path.join(modsDir, 'ok.txt'), 'read')).toBe(true);
  });

  it.skipIf(!CAN_LINK_FILES)(
    'refuses read, write and delete through a file link that leaves the root',
    async () => {
      await expect(readFile('mods', 'link.json')).rejects.toMatchObject({
        code: 'PATH_SYMLINK_ESCAPE',
      });
      await expect(openDownloadStream('mods', 'link.json')).rejects.toMatchObject({
        code: 'PATH_SYMLINK_ESCAPE',
      });
      await expect(writeFile('mods', 'link.json', 'pwned')).rejects.toMatchObject({
        code: 'PATH_SYMLINK_ESCAPE',
      });
      await expect(deleteFile('mods', 'link.json')).rejects.toMatchObject({
        code: 'PATH_SYMLINK_ESCAPE',
      });
      expect(await fsp.readFile(path.join(outside, 'users.json'), 'utf-8')).toBe('{"secret":true}');
    },
  );

  it.skipIf(!CAN_LINK_FILES)(
    'applies the deny list to the link target, not only the link name',
    async () => {
      await expect(readFile('mods', 'notes.txt')).rejects.toMatchObject({ code: 'PATH_DENIED' });
      expect(isAbsolutePathAllowed(path.join(modsDir, 'notes.txt'), 'read')).toBe(false);
    },
  );

  it.skipIf(!CAN_LINK_FILES)(
    'refuses a broken link and allows a link that stays inside the root',
    async () => {
      await expect(readFile('mods', 'dangling.txt')).rejects.toMatchObject({
        code: 'PATH_SYMLINK',
      });
      const read = await readFile('mods', 'alias.txt');
      expect(read.content).toBe('fine');
    },
  );
});
