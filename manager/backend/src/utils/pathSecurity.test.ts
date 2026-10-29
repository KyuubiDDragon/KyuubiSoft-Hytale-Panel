/**
 * Tests for the symlink-aware path helpers: resolveRealPath(),
 * resolveRealPathWithin() and resolveFileInDir().
 *
 * Creating file symlinks on Windows needs extra rights, so those cases are
 * skipped there (CI runs on Linux). Directory links use a junction on Windows,
 * which works unprivileged; on POSIX the 'junction' type is ignored.
 */
import fs from 'fs';
import path from 'path';
import os from 'os';
import { describe, it, beforeAll, afterAll, expect } from 'vitest';
import { resolveRealPath, resolveRealPathWithin, resolveFileInDir } from './pathSecurity.js';

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

let base: string;
let allowed: string;
let outside: string;

beforeAll(() => {
  base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kp-pathsec-')));
  allowed = path.join(base, 'allowed');
  outside = path.join(base, 'outside');
  fs.mkdirSync(path.join(allowed, 'sub'), { recursive: true });
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(allowed, 'sub', 'file.txt'), 'inside');
  fs.writeFileSync(path.join(outside, 'secret.json'), '{"jwtSecret":"x"}');
  if (CAN_LINK_DIRS) {
    fs.symlinkSync(outside, path.join(allowed, 'escape'), 'junction');
    fs.symlinkSync(path.join(allowed, 'sub'), path.join(allowed, 'inner'), 'junction');
  }
  if (CAN_LINK_FILES) {
    fs.symlinkSync(
      path.join(outside, 'secret.json'),
      path.join(allowed, 'secret-link.json'),
      'file',
    );
    fs.symlinkSync(path.join(base, 'does-not-exist'), path.join(allowed, 'dangling'), 'file');
  }
});

afterAll(() => {
  fs.rmSync(base, { recursive: true, force: true });
});

describe('resolveRealPath', () => {
  it('returns the real path of an existing file', () => {
    expect(resolveRealPath(path.join(allowed, 'sub', 'file.txt'))).toBe(
      path.join(allowed, 'sub', 'file.txt'),
    );
  });

  it('resolves a not-yet-existing target through its nearest existing ancestor', () => {
    expect(resolveRealPath(path.join(allowed, 'sub', 'new', 'deep.txt'))).toBe(
      path.join(allowed, 'sub', 'new', 'deep.txt'),
    );
  });

  it.skipIf(!CAN_LINK_DIRS)('follows a symlinked parent of a not-yet-existing target', () => {
    expect(resolveRealPath(path.join(allowed, 'escape', 'planted.txt'))).toBe(
      path.join(outside, 'planted.txt'),
    );
  });

  it.skipIf(!CAN_LINK_FILES)(
    'returns null for a dangling symlink instead of treating it as absent',
    () => {
      expect(resolveRealPath(path.join(allowed, 'dangling'))).toBeNull();
      expect(resolveRealPath(path.join(allowed, 'dangling', 'child.txt'))).toBeNull();
    },
  );
});

describe('resolveRealPathWithin', () => {
  it('accepts paths that really are inside the allowed directory', () => {
    expect(resolveRealPathWithin(path.join(allowed, 'sub', 'file.txt'), [allowed])).not.toBeNull();
    expect(resolveRealPathWithin(path.join(allowed, 'new.txt'), [allowed])).not.toBeNull();
  });

  it('rejects lexical traversal and sibling-prefix directories', () => {
    expect(
      resolveRealPathWithin(path.join(allowed, '..', 'outside', 'secret.json'), [allowed]),
    ).toBeNull();
    expect(resolveRealPathWithin(`${allowed}-old${path.sep}x`, [allowed])).toBeNull();
  });

  it.skipIf(!CAN_LINK_DIRS)(
    'rejects a path that leaves the directory through a symlinked folder',
    () => {
      expect(
        resolveRealPathWithin(path.join(allowed, 'escape', 'secret.json'), [allowed]),
      ).toBeNull();
      expect(resolveRealPathWithin(path.join(allowed, 'escape', 'new.txt'), [allowed])).toBeNull();
    },
  );

  it.skipIf(!CAN_LINK_DIRS)(
    'accepts a symlink that stays inside and an allowed dir reached via a link',
    () => {
      expect(resolveRealPathWithin(path.join(allowed, 'inner', 'file.txt'), [allowed])).toBe(
        path.join(allowed, 'sub', 'file.txt'),
      );
      expect(
        resolveRealPathWithin(path.join(outside, 'secret.json'), [path.join(allowed, 'escape')]),
      ).not.toBeNull();
    },
  );

  it.skipIf(!CAN_LINK_FILES)('rejects a file symlink pointing outside', () => {
    expect(resolveRealPathWithin(path.join(allowed, 'secret-link.json'), [allowed])).toBeNull();
  });
});

describe('resolveFileInDir', () => {
  it('joins a plain file name onto the directory', () => {
    expect(resolveFileInDir(allowed, 'Mod-1.2.3.jar')).toBe(path.join(allowed, 'Mod-1.2.3.jar'));
    expect(resolveFileInDir(allowed, 'My Mod (beta).zip')).toBe(
      path.join(allowed, 'My Mod (beta).zip'),
    );
  });

  it('rejects traversal, absolute and separator-bearing names', () => {
    const bad = [
      '../users.json',
      '../../app/data/users.json',
      '..\\users.json',
      '..\\..\\setup-config.json',
      'sub/file.jar',
      'sub\\file.jar',
      '/etc/passwd',
      '\\\\server\\share\\x.jar',
      'C:\\Windows\\x.jar',
      'C:x.jar',
      '..',
      '.',
      '',
      'evil\0.jar',
      'line\nbreak.jar',
    ];
    for (const name of bad) {
      expect(resolveFileInDir(allowed, name), JSON.stringify(name)).toBeNull();
    }
  });

  it('rejects non-string and overlong values', () => {
    expect(resolveFileInDir(allowed, undefined)).toBeNull();
    expect(resolveFileInDir(allowed, 42)).toBeNull();
    expect(resolveFileInDir(allowed, `${'a'.repeat(300)}.jar`)).toBeNull();
  });
});
