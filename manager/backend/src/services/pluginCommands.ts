/**
 * Client for the command endpoints of the KyuubiSoft API plugin (2.1.0+):
 *
 *   POST /api/commands/execute   run a command, get its real answer back
 *   GET  /api/commands           every registered command (vanilla + mods)
 *   GET  /api/commands/complete  console-style completion for a line
 *
 * The plugin runs commands as "Panel:<user>" with console rights, so callers
 * must have passed the panel's own checks (validateCommand / commandPolicy, or
 * the fixed command set of the lifecycle) before calling runCommandViaPlugin.
 * docker.execCommand and docker.sendLifecycleCommand are the only callers.
 */
import { z } from 'zod';
import { getPluginAuthHeaders, isPluginInstalled, resolvePluginEndpoint } from './kyuubiApi.js';
import { resolveServerId } from './servers.js';

export const COMMAND_STATUSES = ['DONE', 'RUNNING', 'NOT_FOUND', 'REJECTED', 'FAILED'] as const;
export type PluginCommandStatus = (typeof COMMAND_STATUSES)[number];

const CommandReplySchema = z.object({
  ok: z.boolean(),
  status: z.enum(COMMAND_STATUSES),
  command: z.string(),
  sender: z.string(),
  output: z.array(z.string()),
  messageIds: z.array(z.string()).default([]),
  error: z.string().nullish(),
  truncated: z.boolean().default(false),
  durationMs: z.number().default(0),
});
export type PluginCommandReply = z.infer<typeof CommandReplySchema>;

/**
 * - reply:       the plugin ran the command (whatever the outcome)
 * - unavailable: the plugin did not run it; the stdin console may be used
 * - invalid:     the plugin refused the command line itself; do not retry
 * - unknown:     no usable answer although the request may have arrived, so
 *                the command may have run; never send it a second time
 */
export type PluginCommandAttempt =
  | { kind: 'reply'; reply: PluginCommandReply }
  | { kind: 'unavailable'; reason: string }
  | { kind: 'invalid'; error: string }
  | { kind: 'unknown'; error: string };

export interface PluginCommandOptions {
  /** Panel user the plugin names as sender ("Panel:<actor>"). */
  actor?: string;
  /** Also print the answer to the server console, like the console sender does. */
  echo?: boolean;
  /** How long the plugin waits for the command before replying RUNNING. */
  timeoutMs?: number;
}

export const DEFAULT_COMMAND_TIMEOUT_MS = 5_000;
// The plugin replies by its own deadline; this margin covers transport only.
const REPLY_MARGIN_MS = 3_000;
const REGISTRY_TIMEOUT_MS = 8_000;
const COMPLETION_TIMEOUT_MS = 2_000;
// A plugin without the endpoint (or with auth switched off) stays that way
// until the server restarts; don't ask it on every command.
const SKIP_AFTER_REFUSAL_MS = 60_000;

// Failures that happen before a request leaves the panel: it cannot have run.
const NOT_SENT_ERROR_CODES = new Set([
  'ECONNREFUSED',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'UND_ERR_CONNECT_TIMEOUT',
]);

// HTTP statuses with which the plugin declines without running anything:
// 401 wrong token, 403 auth disabled in the plugin, 404 plugin too old,
// 503 no token configured / command system not up yet.
const DECLINED_STATUSES = new Set([401, 403, 404, 503]);
const STICKY_DECLINES = new Set([403, 404]);

const skipUntil = new Map<string, number>();

function errorCode(error: unknown): string | undefined {
  const candidate = error as { code?: unknown; cause?: { code?: unknown } } | null;
  const code = candidate?.cause?.code ?? candidate?.code;
  return typeof code === 'string' ? code : undefined;
}

function wasNeverSent(error: unknown): boolean {
  const code = errorCode(error);
  return code !== undefined && NOT_SENT_ERROR_CODES.has(code);
}

function describe(error: unknown): string {
  if (error instanceof Error && error.name === 'AbortError') return 'no reply in time';
  const code = errorCode(error);
  const message = error instanceof Error ? error.message : String(error);
  return code ? `${message} (${code})` : message;
}

async function pluginFetch(
  serverId: string,
  path: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const { host, port } = await resolvePluginEndpoint(serverId);
  const headers = { ...(await getPluginAuthHeaders(serverId)), ...(init.headers ?? {}) };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref?.();
  try {
    return await fetch(`http://${host}:${port}${path}`, {
      ...init,
      headers,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

async function errorMessage(response: Response): Promise<string> {
  const body = (await response.json().catch(() => null)) as { error?: unknown } | null;
  return typeof body?.error === 'string' ? body.error : `HTTP ${response.status}`;
}

/**
 * Run an already validated and authorized command through the plugin.
 * Never throws.
 */
export async function runCommandViaPlugin(
  command: string,
  serverId: string | undefined,
  options: PluginCommandOptions = {},
): Promise<PluginCommandAttempt> {
  let id: string;
  try {
    id = await resolveServerId(serverId);
  } catch (error) {
    return { kind: 'unavailable', reason: describe(error) };
  }
  const skippedUntil = skipUntil.get(id);
  if (skippedUntil !== undefined && Date.now() < skippedUntil) {
    return { kind: 'unavailable', reason: 'plugin has no usable command endpoint' };
  }
  if (!(await isPluginInstalled(id))) {
    return { kind: 'unavailable', reason: 'plugin not installed' };
  }

  const timeoutMs = options.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;
  let response: Response;
  try {
    response = await pluginFetch(
      id,
      '/api/commands/execute',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          command,
          actor: options.actor,
          echo: options.echo === true,
          timeoutMs,
        }),
      },
      timeoutMs + REPLY_MARGIN_MS,
    );
  } catch (error) {
    return wasNeverSent(error)
      ? { kind: 'unavailable', reason: describe(error) }
      : { kind: 'unknown', error: `KyuubiSoft API plugin: ${describe(error)}` };
  }

  if (DECLINED_STATUSES.has(response.status)) {
    if (STICKY_DECLINES.has(response.status)) skipUntil.set(id, Date.now() + SKIP_AFTER_REFUSAL_MS);
    return { kind: 'unavailable', reason: `${response.status}: ${await errorMessage(response)}` };
  }
  if (response.status === 400) {
    return { kind: 'invalid', error: await errorMessage(response) };
  }
  if (!response.ok) {
    return { kind: 'unknown', error: `KyuubiSoft API plugin: ${await errorMessage(response)}` };
  }

  const parsed = CommandReplySchema.safeParse(await response.json().catch(() => null));
  if (!parsed.success) {
    return { kind: 'unknown', error: 'KyuubiSoft API plugin sent an unexpected command reply' };
  }
  skipUntil.delete(id);
  return { kind: 'reply', reply: parsed.data };
}

// ---------------------------------------------------------------------------
// Registry and completion
// ---------------------------------------------------------------------------

const ArgSchema = z.object({
  name: z.string(),
  type: z.string().optional(),
  description: z.string().optional(),
});

const OptionSchema = ArgSchema.extend({
  kind: z.enum(['optional', 'default', 'flag']),
  permission: z.string().optional(),
  aliases: z.array(z.string()).optional(),
  defaultValue: z.string().optional(),
});

const VariantSchema = z.object({
  usage: z.string(),
  description: z.string().optional(),
  requiredArgs: z.array(ArgSchema).optional(),
});

export interface CommandNode {
  name: string;
  aliases?: string[];
  description?: string;
  permission?: string;
  owner?: string;
  builtin?: boolean;
  usage?: string;
  requiredArgs?: z.infer<typeof ArgSchema>[];
  optionalArgs?: z.infer<typeof OptionSchema>[];
  variants?: z.infer<typeof VariantSchema>[];
  subcommands?: CommandNode[];
  /** Set when the plugin could not read this command. */
  error?: string;
}

const CommandNodeSchema: z.ZodType<CommandNode> = z.lazy(() =>
  z.object({
    name: z.string(),
    aliases: z.array(z.string()).optional(),
    description: z.string().optional(),
    permission: z.string().optional(),
    owner: z.string().optional(),
    builtin: z.boolean().optional(),
    usage: z.string().optional(),
    requiredArgs: z.array(ArgSchema).optional(),
    optionalArgs: z.array(OptionSchema).optional(),
    variants: z.array(VariantSchema).optional(),
    subcommands: z.array(CommandNodeSchema).optional(),
    error: z.string().optional(),
  }),
);

const RegistrySchema = z.object({
  revision: z.string(),
  generatedAt: z.string(),
  count: z.number(),
  commands: z.array(CommandNodeSchema),
});
export type PluginCommandRegistry = z.infer<typeof RegistrySchema>;

const UnchangedSchema = z.object({ revision: z.string(), unchanged: z.literal(true) });

const CompletionSchema = z.object({
  wordIndex: z.number(),
  prefix: z.string(),
  suggestions: z.array(z.string()),
  truncated: z.boolean().default(false),
});
export type PluginCompletion = z.infer<typeof CompletionSchema>;

export type RegistryFetch =
  | { kind: 'registry'; registry: PluginCommandRegistry }
  | { kind: 'unchanged'; revision: string }
  | { kind: 'unavailable'; reason: string };

/** Fetch the command registry; with `ifRevision` an unchanged registry is not resent. */
export async function fetchCommandRegistry(
  serverId: string,
  ifRevision?: string,
): Promise<RegistryFetch> {
  try {
    if (!(await isPluginInstalled(serverId))) {
      return { kind: 'unavailable', reason: 'plugin not installed' };
    }
    const query = ifRevision ? `?ifRevision=${encodeURIComponent(ifRevision)}` : '';
    const response = await pluginFetch(
      serverId,
      `/api/commands${query}`,
      { method: 'GET' },
      REGISTRY_TIMEOUT_MS,
    );
    if (!response.ok) {
      return { kind: 'unavailable', reason: `${response.status}: ${await errorMessage(response)}` };
    }
    const body: unknown = await response.json();
    const unchanged = UnchangedSchema.safeParse(body);
    if (unchanged.success) return { kind: 'unchanged', revision: unchanged.data.revision };
    const registry = RegistrySchema.safeParse(body);
    if (!registry.success) {
      return { kind: 'unavailable', reason: 'unexpected registry format from the plugin' };
    }
    return { kind: 'registry', registry: registry.data };
  } catch (error) {
    return { kind: 'unavailable', reason: describe(error) };
  }
}

/** Server-side completion for the last token of `line`, or null when unavailable. */
export async function fetchCommandCompletions(
  serverId: string,
  line: string,
): Promise<PluginCompletion | null> {
  try {
    if (!(await isPluginInstalled(serverId))) return null;
    const response = await pluginFetch(
      serverId,
      `/api/commands/complete?line=${encodeURIComponent(line)}`,
      { method: 'GET' },
      COMPLETION_TIMEOUT_MS,
    );
    if (!response.ok) return null;
    const parsed = CompletionSchema.safeParse(await response.json());
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** Test hook: forget remembered refusals. */
export function resetPluginCommandState(): void {
  skipUntil.clear();
}
