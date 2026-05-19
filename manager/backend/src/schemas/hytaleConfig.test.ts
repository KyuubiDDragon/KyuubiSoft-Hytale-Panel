import { describe, it, expect } from 'vitest';
import { parseHytaleConfig, HytaleConfigSchema } from './hytaleConfig.js';

describe('hytaleConfig parser', () => {
  it('accepts a minimal valid config', () => {
    const r = parseHytaleConfig({
      ServerName: 'Test',
      MaxPlayers: 50,
      Defaults: { GameMode: 'Adventure' },
    });
    expect(r.ok).toBe(true);
    expect(r.issues).toEqual([]);
  });

  it('reports schema issues without dropping the file', () => {
    const r = parseHytaleConfig({
      ServerName: '',
      MaxPlayers: -1,
    });
    expect(r.ok).toBe(false);
    expect(r.issues.length).toBeGreaterThan(0);
    expect(r.config).toMatchObject({ ServerName: '', MaxPlayers: -1 });
  });

  it('preserves unknown fields via .passthrough()', () => {
    const result = HytaleConfigSchema.safeParse({
      ServerName: 'OK',
      FutureHytaleField: { nested: 1 },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect((result.data as Record<string, unknown>).FutureHytaleField).toEqual({ nested: 1 });
    }
  });

  it('refuses unknown gamemodes', () => {
    const r = parseHytaleConfig({ Defaults: { GameMode: 'Hardcore' } });
    expect(r.ok).toBe(false);
  });
});
