/**
 * Token buckets per key: on average `perMinute` takes per minute, bursts up to
 * `burst`. Used to throttle work that outside events can trigger (event
 * actions, webhook deliveries) so a flood of events cannot turn into a flood
 * of commands or HTTP calls.
 */
export interface TokenBucketOptions {
  perMinute: number;
  burst?: number;
  /** Most keys kept; full buckets are dropped first when the limit is reached. */
  maxKeys?: number;
  now?: () => number;
}

interface Bucket {
  tokens: number;
  refilledAt: number;
}

const DEFAULT_MAX_KEYS = 10_000;

export class KeyedTokenBucket {
  private readonly buckets = new Map<string, Bucket>();
  private readonly ratePerMs: number;
  private readonly burst: number;
  private readonly maxKeys: number;
  private readonly now: () => number;

  constructor(options: TokenBucketOptions) {
    this.ratePerMs = options.perMinute / 60_000;
    this.burst = options.burst ?? options.perMinute;
    this.maxKeys = options.maxKeys ?? DEFAULT_MAX_KEYS;
    this.now = options.now ?? Date.now;
  }

  /** Take one token for `key`; false when its bucket is empty. */
  tryTake(key: string): boolean {
    const now = this.now();
    const bucket = this.refill(key, now);
    if (bucket.tokens < 1) return false;
    this.buckets.set(key, { tokens: bucket.tokens - 1, refilledAt: now });
    return true;
  }

  private refill(key: string, now: number): Bucket {
    const known = this.buckets.get(key);
    if (!known) {
      if (this.buckets.size >= this.maxKeys) this.prune(now);
      return { tokens: this.burst, refilledAt: now };
    }
    const tokens = Math.min(this.burst, known.tokens + (now - known.refilledAt) * this.ratePerMs);
    return { tokens, refilledAt: now };
  }

  /** Forget buckets that have refilled completely (they behave like new ones). */
  private prune(now: number): void {
    for (const [key, bucket] of this.buckets) {
      if (bucket.tokens + (now - bucket.refilledAt) * this.ratePerMs >= this.burst) {
        this.buckets.delete(key);
      }
    }
    // Still full: drop the oldest entries; the limit only guards memory.
    while (this.buckets.size >= this.maxKeys) {
      const oldest = this.buckets.keys().next().value;
      if (oldest === undefined) break;
      this.buckets.delete(oldest);
    }
  }
}
