import { describe, it, expect } from 'vitest';
import { evaluate } from './modCompat.js';

describe('modCompat.evaluate', () => {
  it('returns unknown when the mod declares nothing', () => {
    const r = evaluate({}, '1.0.4', 'none');
    expect(r.verdict).toBe('unknown');
  });

  it('returns unknown when the server version is unknown', () => {
    const r = evaluate({ gameVersions: ['1.0.4'] }, null, 'registry');
    expect(r.verdict).toBe('unknown');
  });

  it('matches an exact declared game version (ignoring v prefix)', () => {
    expect(evaluate({ gameVersions: ['v1.0.4'] }, '1.0.4', 'registry').verdict).toBe('compatible');
    expect(evaluate({ gameVersions: ['1.0.4'] }, '1.0.5', 'registry').verdict).toBe('incompatible');
  });

  it('treats pre-release suffixes as the base release for matching', () => {
    expect(evaluate({ gameVersions: ['1.0.0'] }, '1.0.0-pre1', 'registry').verdict).toBe('compatible');
  });

  it('honors a minServerVersion lower bound', () => {
    expect(evaluate({ minServerVersion: '1.0.0' }, '1.0.4', 'registry').verdict).toBe('compatible');
    expect(evaluate({ minServerVersion: '1.1.0' }, '1.0.4', 'registry').verdict).toBe('incompatible');
  });

  it('honors a maxServerVersion upper bound', () => {
    expect(evaluate({ maxServerVersion: '1.1.0' }, '1.0.4', 'registry').verdict).toBe('compatible');
    expect(evaluate({ maxServerVersion: '1.0.0' }, '1.0.4', 'registry').verdict).toBe('incompatible');
  });

  it('accepts a value inside a min/max range', () => {
    const r = evaluate({ minServerVersion: '1.0.0', maxServerVersion: '2.0.0' }, '1.5.0', 'registry');
    expect(r.verdict).toBe('compatible');
  });
});
