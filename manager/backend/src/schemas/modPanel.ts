/**
 * Wire format of the KyuubiSoft API plugin's mod panel registry
 * (`/api/mods/panel*`, plugin 2.1+): KS mods register a status page with
 * metric tiles, tables and admin actions there.
 *
 * The data comes from third-party mod code inside the game server, so every
 * response is validated and clipped before it reaches the frontend. Unknown
 * fields are dropped, unknown tones/statuses fall back to a neutral value so a
 * newer plugin does not break an older panel.
 */
import { z } from 'zod';

/** Provider ids as the plugin accepts them, e.g. "kyuubisoft:pets". */
export const MOD_PANEL_PROVIDER_ID = /^[a-z0-9][a-z0-9._:-]{0,63}$/;
/** Action ids. */
export const MOD_PANEL_ACTION_ID = /^[a-z0-9][a-z0-9_.-]{0,63}$/;

const MAX_TEXT = 500;

const text = (max = MAX_TEXT) => z.string().transform((s) => s.slice(0, max));
const optionalText = (max = MAX_TEXT) => text(max).nullable().optional();

export const ModPanelValueSchema = z.union([z.string(), z.number(), z.boolean(), z.null()]);
export type ModPanelValue = z.infer<typeof ModPanelValueSchema>;

const ToneSchema = z.enum(['neutral', 'info', 'success', 'warning', 'error']).catch('neutral');

export const ModPanelParamSchema = z.object({
  id: z.string().regex(MOD_PANEL_ACTION_ID),
  label: text(100),
  type: z.enum(['text', 'number', 'boolean', 'choice']),
  required: z.boolean().default(false),
  defaultValue: ModPanelValueSchema.optional(),
  hint: optionalText(),
  maxLength: z.number().int().positive().optional(),
  min: z.number().nullable().optional(),
  max: z.number().nullable().optional(),
  integer: z.boolean().optional(),
  choices: z.array(text(100)).max(100).optional(),
});

export const ModPanelActionSchema = z.object({
  id: z.string().regex(MOD_PANEL_ACTION_ID),
  label: text(100),
  description: optionalText(),
  confirmation: optionalText(),
  requiresConfirmation: z.boolean().default(false),
  dangerous: z.boolean().default(false),
  params: z.array(ModPanelParamSchema).max(20).default([]),
});

export const ModPanelProviderSchema = z.object({
  id: z.string().regex(MOD_PANEL_PROVIDER_ID),
  displayName: text(100),
  description: optionalText(300),
  version: optionalText(40),
  actions: z.array(ModPanelActionSchema).max(20).default([]),
});

export const ModPanelListSchema = z.object({
  apiVersion: z.number().int(),
  snapshotTimeoutMs: z.number().optional(),
  actionTimeoutMs: z.number().optional(),
  providers: z.array(ModPanelProviderSchema).max(200),
});

const MetricSchema = z.object({
  label: text(100),
  value: ModPanelValueSchema.optional().transform((v) => v ?? null),
  unit: optionalText(20),
  hint: optionalText(),
  tone: ToneSchema.default('neutral'),
});

const TableSchema = z.object({
  title: optionalText(100),
  columns: z.array(text(100)).max(16),
  rows: z.array(z.array(ModPanelValueSchema).max(16)).max(200),
  totalRows: z.number().int().nonnegative().optional(),
  truncated: z.boolean().optional(),
  emptyText: optionalText(),
});

const SectionSchema = z.object({
  title: text(100),
  description: optionalText(),
  metrics: z.array(MetricSchema).max(30).default([]),
  tables: z.array(TableSchema).max(10).default([]),
});

export const ModPanelSnapshotSchema = z.object({
  notices: z
    .array(z.object({ tone: ToneSchema.default('info'), text: text() }))
    .max(20)
    .default([]),
  sections: z.array(SectionSchema).max(20).default([]),
  truncated: z.boolean().optional(),
});

export const ModPanelSnapshotResponseSchema = ModPanelProviderSchema.extend({
  status: z.enum(['ok', 'error', 'timeout', 'busy']).catch('error'),
  error: optionalText(300),
  generatedAt: z.string().max(64).optional(),
  durationMs: z.number().optional(),
  snapshot: ModPanelSnapshotSchema.optional(),
});

export const ModPanelActionResultSchema = z.object({
  success: z.boolean(),
  status: z.enum(['ok', 'failed', 'error', 'timeout', 'busy']).catch('error'),
  message: optionalText(),
  data: z.record(ModPanelValueSchema).optional(),
  durationMs: z.number().optional(),
});

/** Body the panel frontend sends to run an action. */
export const ModPanelActionRequestSchema = z.object({
  params: z
    .record(
      z.string().regex(MOD_PANEL_ACTION_ID),
      z.union([z.string().max(2000), z.number(), z.boolean(), z.null()]),
    )
    .refine((p) => Object.keys(p).length <= 20, 'at most 20 parameters')
    .optional(),
  confirmed: z.boolean().optional(),
  locale: z.string().optional(),
});

export type ModPanelProvider = z.infer<typeof ModPanelProviderSchema>;
export type ModPanelList = z.infer<typeof ModPanelListSchema>;
export type ModPanelSnapshotResponse = z.infer<typeof ModPanelSnapshotResponseSchema>;
export type ModPanelActionResult = z.infer<typeof ModPanelActionResultSchema>;
export type ModPanelActionRequest = z.infer<typeof ModPanelActionRequestSchema>;
