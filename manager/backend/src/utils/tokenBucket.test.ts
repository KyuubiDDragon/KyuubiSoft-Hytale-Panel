import { describe, it, expect } from 'vitest';
import { KeyedTokenBucket } from './tokenBucket.js';
import { eventPatternMatches } from '../schemas/events.js';

describe('KeyedTokenBucket', () => {
  it('allows a burst, then refills at the per-minute rate', () => {
    let now = 0;
    const bucket = new KeyedTokenBucket({ perMinute: 10, now: () => now });
    const taken = Array.from({ length: 15 }, () => bucket.tryTake('a')).filter(Boolean);
    expect(taken).toHaveLength(10);
    expect(bucket.tryTake('a')).toBe(false);
    now += 6_000; // one token per 6 s
    expect(bucket.tryTake('a')).toBe(true);
    expect(bucket.tryTake('a')).toBe(false);
  });

  it('keeps keys apart', () => {
    const bucket = new KeyedTokenBucket({ perMinute: 1, now: () => 0 });
    expect(bucket.tryTake('a')).toBe(true);
    expect(bucket.tryTake('a')).toBe(false);
    expect(bucket.tryTake('b')).toBe(true);
  });

  it('bounds the number of keys it remembers', () => {
    let now = 0;
    const bucket = new KeyedTokenBucket({ perMinute: 1, maxKeys: 2, now: () => now });
    expect(bucket.tryTake('a')).toBe(true);
    expect(bucket.tryTake('b')).toBe(true);
    // A third key evicts the oldest entry; the limit only guards memory.
    expect(bucket.tryTake('c')).toBe(true);
    now += 60_000;
    expect(bucket.tryTake('b')).toBe(true);
  });
});

describe('eventPatternMatches', () => {
  it('matches exact names, categories and *', () => {
    expect(eventPatternMatches('player.joined', 'player.joined')).toBe(true);
    expect(eventPatternMatches('player.*', 'player.joined')).toBe(true);
    expect(eventPatternMatches('*', 'backup.failed')).toBe(true);
    expect(eventPatternMatches('server.*', 'player.joined')).toBe(false);
    expect(eventPatternMatches('player.left', 'player.joined')).toBe(false);
  });

  it('never matches an event outsiders can cause through a wildcard', () => {
    expect(eventPatternMatches('*', 'player.join_denied')).toBe(false);
    expect(eventPatternMatches('player.*', 'player.join_denied')).toBe(false);
    expect(eventPatternMatches('player.join_denied', 'player.join_denied')).toBe(true);
  });
});
