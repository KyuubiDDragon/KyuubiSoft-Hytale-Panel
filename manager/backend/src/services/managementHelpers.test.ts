/**
 * Tests for verifyUploadMagic — the content-vs-extension signature guard on
 * file-manager uploads.
 */
import { describe, it, expect } from 'vitest';
import { verifyUploadMagic } from './managementHelpers.js';

const buf = (...bytes: number[]) => Buffer.from(bytes);

describe('verifyUploadMagic', () => {
  it('accepts genuine archives by magic bytes', () => {
    expect(verifyUploadMagic(buf(0x50, 0x4b, 0x03, 0x04, 0x00), 'pack.zip').ok).toBe(true);
    expect(verifyUploadMagic(buf(0x50, 0x4b, 0x03, 0x04), 'mod.jar').ok).toBe(true);
    expect(verifyUploadMagic(buf(0x1f, 0x8b, 0x08), 'world.gz').ok).toBe(true);
  });

  it('rejects a mislabeled archive (e.g. a script renamed to .zip)', () => {
    const r = verifyUploadMagic(Buffer.from('#!/bin/sh\necho pwned\n'), 'evil.zip');
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/does not match/i);
  });

  it('validates images by signature', () => {
    expect(verifyUploadMagic(buf(0x89, 0x50, 0x4e, 0x47), 'logo.png').ok).toBe(true);
    expect(verifyUploadMagic(buf(0x00, 0x01, 0x02, 0x03), 'logo.png').ok).toBe(false);
    expect(verifyUploadMagic(buf(0xff, 0xd8, 0xff, 0xe0), 'photo.jpg').ok).toBe(true);
  });

  it('lets unknown / text extensions through unchanged', () => {
    expect(verifyUploadMagic(Buffer.from('arbitrary bytes'), 'level.dat').ok).toBe(true);
    expect(verifyUploadMagic(Buffer.from('hello world'), 'notes.txt').ok).toBe(true);
    expect(verifyUploadMagic(Buffer.from('{"a":1}'), 'config.json').ok).toBe(true);
  });
});
