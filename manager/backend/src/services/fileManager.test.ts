/**
 * Vitest port of the original tsx-runnable __fileManager.checks.ts.
 * Covers path-traversal blocking, deny lists, and resolveSafe behaviour.
 */
import { promises as fsp } from 'fs';
import path from 'path';
import os from 'os';
import { describe, it, beforeAll, afterAll, expect } from 'vitest';
import {
  resolveSafe,
  isDenied,
  type FileManagerRoot,
  FileManagerError,
} from './fileManager.js';

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
  });
  it('allows normal files', () => {
    expect(isDenied(root, 'hello.txt')).toBe(false);
    expect(isDenied(root, 'sub/nested.txt')).toBe(false);
  });
});
