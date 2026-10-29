/**
 * Regression tests for the JSON store behind users.json.
 *
 * The bug: any read error (including a half-written file) was treated like a
 * missing file, so the caller wrote a fresh file over it, and parallel
 * read-modify-write cycles overwrote each other.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { promises as fsp } from 'fs';
import { rename } from 'fs/promises';
import path from 'path';
import os from 'os';

// Pass-through by default; single tests make rename fail like a mount point.
vi.mock('fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs/promises')>();
  return { ...actual, rename: vi.fn(actual.rename) };
});

import {
  readJsonFile,
  writeJsonAtomic,
  updateJsonFile,
  withFileLock,
  JsonFileCorruptError,
} from './jsonStore.js';

let dir: string;
let file: string;

const hasItems = (v: unknown): boolean => Array.isArray((v as { items?: unknown } | null)?.items);

beforeEach(async () => {
  dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'json-store-test-'));
  file = path.join(dir, 'store.json');
});

afterEach(async () => {
  await fsp.rm(dir, { recursive: true, force: true });
});

async function leftovers(): Promise<string[]> {
  return (await fsp.readdir(dir)).filter((name) => name.includes('.tmp-'));
}

describe('readJsonFile', () => {
  it('returns null only for a missing file', async () => {
    expect(await readJsonFile(file)).toBeNull();
  });

  it('throws JsonFileCorruptError for invalid JSON and keeps one copy of it', async () => {
    const broken = '{"items": [1, 2';
    await fsp.writeFile(file, broken, 'utf-8');

    await expect(readJsonFile(file)).rejects.toBeInstanceOf(JsonFileCorruptError);
    await expect(readJsonFile(file)).rejects.toBeInstanceOf(JsonFileCorruptError);

    expect(await fsp.readFile(file, 'utf-8')).toBe(broken);
    const copies = (await fsp.readdir(dir)).filter((name) =>
      name.startsWith('store.json.corrupt-'),
    );
    expect(copies).toHaveLength(1);
    expect(await fsp.readFile(path.join(dir, copies[0]), 'utf-8')).toBe(broken);
  });

  it('treats an empty (truncated) file as corrupt, not as missing', async () => {
    await fsp.writeFile(file, '', 'utf-8');
    await expect(readJsonFile(file)).rejects.toBeInstanceOf(JsonFileCorruptError);
  });

  it('does not put file content into the error message', async () => {
    await fsp.writeFile(file, '{"secret": "TOTP-SECRET-VALUE", oops}', 'utf-8');
    const err = await readJsonFile(file).catch((e) => e as Error);
    expect(err).toBeInstanceOf(JsonFileCorruptError);
    expect((err as Error).message).not.toContain('TOTP-SECRET-VALUE');
  });

  it('rejects valid JSON with an unexpected structure', async () => {
    await fsp.writeFile(file, '{"other": true}', 'utf-8');
    await expect(readJsonFile(file, { isValid: hasItems })).rejects.toBeInstanceOf(
      JsonFileCorruptError,
    );
  });

  it('accepts a leading BOM', async () => {
    await fsp.writeFile(file, '﻿{"items": [1]}', 'utf-8');
    expect(await readJsonFile(file, { isValid: hasItems })).toEqual({ items: [1] });
  });
});

describe('writeJsonAtomic', () => {
  it('replaces the file and leaves no temp file behind', async () => {
    await writeJsonAtomic(file, { items: [1] });
    await writeJsonAtomic(file, { items: [1, 2] });
    expect(JSON.parse(await fsp.readFile(file, 'utf-8'))).toEqual({ items: [1, 2] });
    expect(await leftovers()).toEqual([]);
  });

  it('cleans up the temp file and keeps the old content when the rename fails', async () => {
    // A directory at the target path makes the final rename fail.
    const target = path.join(dir, 'blocked.json');
    await fsp.mkdir(target);
    await expect(writeJsonAtomic(target, { items: [] })).rejects.toThrow();
    expect(await leftovers()).toEqual([]);
    expect((await fsp.stat(target)).isDirectory()).toBe(true);
  });
});

describe('writeJsonAtomic on a target rename cannot replace', () => {
  it('rewrites a single-file mount in place instead of failing', async () => {
    await writeJsonAtomic(file, { items: [1] });
    const mountError = Object.assign(new Error('EXDEV: cross-device link not permitted'), {
      code: 'EXDEV',
    });
    vi.mocked(rename).mockRejectedValueOnce(mountError);

    await writeJsonAtomic(file, { items: [1, 2] });

    expect(JSON.parse(await fsp.readFile(file, 'utf-8'))).toEqual({ items: [1, 2] });
    expect(await leftovers()).toEqual([]);
  });
});

// Many writers at once; on a loaded machine (a commit hook next to other work) this takes seconds.
const PARALLEL_TIMEOUT_MS = 30_000;

describe('updateJsonFile', { timeout: PARALLEL_TIMEOUT_MS }, () => {
  it('serialises parallel read-modify-write cycles without losing updates', async () => {
    await writeJsonAtomic(file, { items: [] });

    await Promise.all(
      Array.from({ length: 50 }, (_, i) =>
        updateJsonFile<{ items: number[] }>(file, async (current) => {
          const next = current ?? { items: [] };
          // Yield inside the critical section so an unserialised version
          // would interleave and drop items.
          await new Promise((resolve) => setTimeout(resolve, 1));
          next.items.push(i);
          return next;
        }),
      ),
    );

    const final = JSON.parse(await fsp.readFile(file, 'utf-8')) as { items: number[] };
    expect(final.items).toHaveLength(50);
    expect(new Set(final.items).size).toBe(50);
    expect(await leftovers()).toEqual([]);
  });

  it('never calls the mutator or writes when the file is corrupt', async () => {
    await fsp.writeFile(file, 'not json', 'utf-8');
    let called = false;
    await expect(
      updateJsonFile(file, () => {
        called = true;
        return { items: [] };
      }),
    ).rejects.toBeInstanceOf(JsonFileCorruptError);
    expect(called).toBe(false);
    expect(await fsp.readFile(file, 'utf-8')).toBe('not json');
  });

  it('skips the write when the mutator returns undefined', async () => {
    await writeJsonAtomic(file, { items: [1] });
    const before = (await fsp.stat(file)).mtimeMs;
    const result = await updateJsonFile<{ items: number[] }>(file, () => undefined);
    expect(result).toEqual({ items: [1] });
    expect((await fsp.stat(file)).mtimeMs).toBe(before);
  });

  it('releases the lock when the mutator throws', async () => {
    await writeJsonAtomic(file, { items: [] });
    await expect(
      updateJsonFile(file, () => {
        throw new Error('nope');
      }),
    ).rejects.toThrow('nope');
    const result = await updateJsonFile<{ items: number[] }>(file, (current) => ({
      items: [...(current?.items ?? []), 1],
    }));
    expect(result).toEqual({ items: [1] });
  });

  it('passes null for a missing file and creates it', async () => {
    const result = await updateJsonFile<{ items: number[] }>(
      file,
      (current) => current ?? { items: [7] },
    );
    expect(result).toEqual({ items: [7] });
    expect(JSON.parse(await fsp.readFile(file, 'utf-8'))).toEqual({ items: [7] });
  });
});

describe('withFileLock', () => {
  it('runs critical sections for the same file one after another', async () => {
    const order: string[] = [];
    await Promise.all([
      withFileLock(file, async () => {
        order.push('a:start');
        await new Promise((resolve) => setTimeout(resolve, 20));
        order.push('a:end');
      }),
      withFileLock(file, async () => {
        order.push('b:start');
        order.push('b:end');
      }),
    ]);
    expect(order).toEqual(['a:start', 'a:end', 'b:start', 'b:end']);
  });
});
