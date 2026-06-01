/**
 * Zod schema for the Hytale server's config.json.
 *
 * Hytale is still pre-1.0 (Early Access since 2026-01-13); the schema below
 * covers the fields documented by Hypixel Studios and seen in the wild, but
 * tolerates unknown keys via .passthrough() so a fresh Hytale build with
 * new fields doesn't immediately break the editor.
 *
 * If the actual file on disk fails to parse against this schema, the loader
 * returns the raw JSON plus a list of validation issues so the frontend can
 * surface them rather than silently dropping fields.
 */
import { z } from 'zod';

export const HytaleGameModeSchema = z.enum(['Exploration', 'Creative', 'Adventure']);

export const HytaleConfigSchema = z.object({
  ServerName: z.string().min(1).max(64).optional(),
  MOTD: z.string().max(256).optional(),
  Password: z.string().max(128).optional(),
  MaxPlayers: z.number().int().min(1).max(2000).optional(),
  MaxViewRadius: z.number().int().min(4).max(64).optional(),
  Defaults: z.object({
    GameMode: HytaleGameModeSchema.optional(),
  }).passthrough().optional(),
  // Hytale lists the server in the public browser when Listed === true.
  // Shipped with Update 5 (2026-05-28); older builds ignore the field.
  Listed: z.boolean().optional(),
}).passthrough();

export type HytaleConfig = z.infer<typeof HytaleConfigSchema>;

export interface HytaleConfigParseResult {
  ok: boolean;
  config: HytaleConfig | Record<string, unknown>;
  issues: string[];
}

export function parseHytaleConfig(raw: unknown): HytaleConfigParseResult {
  const result = HytaleConfigSchema.safeParse(raw);
  if (result.success) {
    return { ok: true, config: result.data, issues: [] };
  }
  return {
    ok: false,
    config: (raw && typeof raw === 'object') ? (raw as Record<string, unknown>) : {},
    issues: result.error.issues.map(i => `${i.path.join('.') || '<root>'}: ${i.message}`),
  };
}
