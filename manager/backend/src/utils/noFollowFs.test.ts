/**
 * Tests for the no-follow file helpers used on folders the game server can
 * write to.
 *
 * Creating file symlinks on Windows needs extra rights, so those cases are
 * skipped there (CI runs on Linux). Directory links use a junction on Windows,
 * which works unprivileged; hard links work everywhere.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';
import { describe, it, beforeEach, afterAll, expect } from 'vitest';
import {
  UnsafeFileError,
  copyDirectoryTree,
  copyRegularFile,
  linkRegularFile,
  readRegularFile,
  removeTree,
  replaceFileContent,
} from './noFollowFs.js';

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
const HAS_MKFIFO =
  process.platform !== 'win32' && spawnSync('mkfifo', ['--help']).error === undefined;

const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kp-nofollow-')));
const server = path.join(base, 'server');
const panel = path.join(base, 'panel');
const SECRET = 'panel-secret';
const secret = path.join(panel, 'config.json');
const roots = { srcRoots: [server], destRoots: [server] };

beforeEach(() => {
  for (const d of [server, panel]) {
    fs.rmSync(d, { recursive: true, force: true });
    fs.mkdirSync(d, { recursive: true });
  }
  fs.writeFileSync(secret, SECRET);
  fs.writeFileSync(path.join(server, 'HytaleServer.jar'), 'jar');
});

afterAll(() => {
  fs.rmSync(base, { recursive: true, force: true });
});

const inServer = (...p: string[]) => path.join(server, ...p);

describe('readRegularFile / copyRegularFile', () => {
  it('copies a regular file and keeps its mode', async () => {
    fs.chmodSync(inServer('HytaleServer.jar'), 0o640);
    await copyRegularFile(inServer('HytaleServer.jar'), inServer('copy.jar'), roots);
    expect(fs.readFileSync(inServer('copy.jar'), 'utf-8')).toBe('jar');
    if (process.platform !== 'win32') {
      expect(fs.statSync(inServer('copy.jar')).mode & 0o777).toBe(0o640);
    }
    expect((await readRegularFile(inServer('copy.jar'), [server])).toString()).toBe('jar');
  });

  it.skipIf(!CAN_LINK_FILES)('refuses a symlink, also one that stays inside the root', async () => {
    fs.symlinkSync(secret, inServer('evil.jar'), 'file');
    fs.symlinkSync(inServer('HytaleServer.jar'), inServer('inner.jar'), 'file');
    for (const src of ['evil.jar', 'inner.jar']) {
      await expect(copyRegularFile(inServer(src), inServer('out'), roots)).rejects.toThrow(
        /symbolic link/,
      );
      await expect(readRegularFile(inServer(src), [server])).rejects.toBeInstanceOf(
        UnsafeFileError,
      );
    }
    expect(fs.existsSync(inServer('out'))).toBe(false);
  });

  it.skipIf(!CAN_LINK_DIRS)('refuses a file reached through a linked folder', async () => {
    fs.symlinkSync(panel, inServer('sub'), 'junction');
    await expect(
      copyRegularFile(inServer('sub', 'config.json'), inServer('out'), roots),
    ).rejects.toThrow(/outside the expected folder/);
    expect(fs.existsSync(inServer('out'))).toBe(false);
  });

  it('refuses a file with a second hard link unless the panel made it', async () => {
    fs.linkSync(secret, inServer('Assets.zip'));
    await expect(copyRegularFile(inServer('Assets.zip'), inServer('out'), roots)).rejects.toThrow(
      /more than one hard link/,
    );
    // A snapshot link the panel made itself is accounted for.
    fs.writeFileSync(inServer('live.zip'), 'assets');
    fs.linkSync(inServer('live.zip'), inServer('snap.zip'));
    await copyRegularFile(inServer('snap.zip'), inServer('out'), {
      ...roots,
      knownLinks: [inServer('live.zip')],
    });
    expect(fs.readFileSync(inServer('out'), 'utf-8')).toBe('assets');
  });

  it('refuses a directory and a file above the size cap', async () => {
    fs.mkdirSync(inServer('dir.jar'));
    await expect(readRegularFile(inServer('dir.jar'), [server])).rejects.toThrow();
    await expect(
      readRegularFile(inServer('HytaleServer.jar'), [server], { maxBytes: 2 }),
    ).rejects.toThrow(/larger than 2 bytes/);
  });

  it.skipIf(!HAS_MKFIFO)('does not block on a FIFO', async () => {
    spawnSync('mkfifo', [inServer('fifo.jar')]);
    await expect(readRegularFile(inServer('fifo.jar'), [server])).rejects.toThrow(
      /not a regular file/,
    );
  });

  it.skipIf(!CAN_LINK_FILES)('never writes through a link planted at the destination', async () => {
    fs.symlinkSync(secret, inServer('out'), 'file');
    await expect(
      copyRegularFile(inServer('HytaleServer.jar'), inServer('out'), roots),
    ).rejects.toThrow(/EEXIST/);
    expect(fs.readFileSync(secret, 'utf-8')).toBe(SECRET);
  });

  it.skipIf(!CAN_LINK_DIRS)('refuses a destination in a linked folder', async () => {
    fs.symlinkSync(panel, inServer('sub'), 'junction');
    await expect(
      copyRegularFile(inServer('HytaleServer.jar'), inServer('sub', 'out.jar'), roots),
    ).rejects.toThrow(/outside the expected folder/);
    expect(fs.existsSync(path.join(panel, 'out.jar'))).toBe(false);
  });
});

describe('linkRegularFile', () => {
  it('hard-links a regular file', async () => {
    await linkRegularFile(inServer('HytaleServer.jar'), inServer('link.jar'), roots);
    expect(fs.statSync(inServer('link.jar')).nlink).toBe(2);
  });

  it.skipIf(!CAN_LINK_FILES)('refuses a symlink instead of linking the link', async () => {
    fs.symlinkSync(secret, inServer('evil.zip'), 'file');
    await expect(linkRegularFile(inServer('evil.zip'), inServer('out.zip'), roots)).rejects.toThrow(
      /symbolic link/,
    );
    expect(fs.existsSync(inServer('out.zip'))).toBe(false);
  });
});

describe('copyDirectoryTree', () => {
  it('copies regular files and folders', async () => {
    fs.mkdirSync(inServer('Licenses', 'sub'), { recursive: true });
    fs.writeFileSync(inServer('Licenses', 'a.txt'), 'a');
    fs.writeFileSync(inServer('Licenses', 'sub', 'b.txt'), 'b');
    await copyDirectoryTree(inServer('Licenses'), inServer('copy'), roots);
    expect(fs.readFileSync(inServer('copy', 'sub', 'b.txt'), 'utf-8')).toBe('b');
  });

  it.skipIf(!CAN_LINK_DIRS)('stops at a link inside the tree', async () => {
    fs.mkdirSync(inServer('Licenses'));
    fs.symlinkSync(panel, inServer('Licenses', 'escape'), 'junction');
    await expect(copyDirectoryTree(inServer('Licenses'), inServer('copy'), roots)).rejects.toThrow(
      /escape.*symbolic link/,
    );
    expect(fs.existsSync(inServer('copy', 'escape'))).toBe(false);
  });

  it.skipIf(!CAN_LINK_DIRS)('refuses a linked source folder', async () => {
    fs.symlinkSync(panel, inServer('Licenses'), 'junction');
    await expect(copyDirectoryTree(inServer('Licenses'), inServer('copy'), roots)).rejects.toThrow(
      /symbolic link/,
    );
  });
});

describe('replaceFileContent', () => {
  it.skipIf(!CAN_LINK_FILES)(
    'replaces a link at the destination instead of writing through it',
    async () => {
      fs.symlinkSync(secret, inServer('.hytale-version'), 'file');
      await replaceFileContent(inServer('.hytale-version'), '0.7.3\nrelease\n', [server]);
      expect(fs.readFileSync(secret, 'utf-8')).toBe(SECRET);
      expect(fs.lstatSync(inServer('.hytale-version')).isFile()).toBe(true);
      expect(fs.readFileSync(inServer('.hytale-version'), 'utf-8')).toBe('0.7.3\nrelease\n');
    },
  );

  it('writes a new file and leaves no temporary file behind', async () => {
    await replaceFileContent(inServer('history.json'), '[]', [server]);
    expect(fs.readdirSync(server).sort()).toEqual(['HytaleServer.jar', 'history.json']);
  });

  it('reads a file below the size cap completely', async () => {
    fs.writeFileSync(inServer('big.json'), 'x'.repeat(200_000));
    const buf = await readRegularFile(inServer('big.json'), [server], { maxBytes: 200_000 });
    expect(buf.length).toBe(200_000);
  });
});

describe('removeTree', () => {
  it('deletes a tree, a single file and nothing at all', async () => {
    fs.mkdirSync(inServer('staging', 'Server', 'Licenses'), { recursive: true });
    fs.writeFileSync(inServer('staging', 'Server', 'HytaleServer.jar'), 'jar');
    fs.writeFileSync(inServer('staging', 'Server', 'Licenses', 'a.txt'), 'a');
    await removeTree(inServer('staging'), [server]);
    expect(fs.existsSync(inServer('staging'))).toBe(false);
    await removeTree(inServer('HytaleServer.jar'), [server]);
    expect(fs.existsSync(inServer('HytaleServer.jar'))).toBe(false);
    await expect(removeTree(inServer('missing'), [server])).resolves.toBeUndefined();
  });

  it.skipIf(!CAN_LINK_DIRS)('deletes a linked folder inside the tree, not what it points to', async () => {
    fs.mkdirSync(inServer('staging'));
    fs.writeFileSync(inServer('staging', 'own.txt'), 'own');
    fs.symlinkSync(panel, inServer('staging', 'escape'), 'junction');
    await removeTree(inServer('staging'), [server]);
    expect(fs.existsSync(inServer('staging'))).toBe(false);
    expect(fs.readFileSync(secret, 'utf-8')).toBe(SECRET);
  });

  it.skipIf(!CAN_LINK_DIRS)('removes only the link when the tree itself is a linked folder', async () => {
    fs.symlinkSync(panel, inServer('staging'), 'junction');
    await removeTree(inServer('staging'), [server]);
    expect(fs.existsSync(inServer('staging'))).toBe(false);
    expect(fs.readFileSync(secret, 'utf-8')).toBe(SECRET);
  });
});
