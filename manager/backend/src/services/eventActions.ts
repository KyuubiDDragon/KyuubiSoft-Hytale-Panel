/**
 * Event-Action engine.
 *
 * Lets operators bind an action (run a console command, broadcast a message, or
 * create a backup) to a panel event (player.joined, server.crashed, backup.failed,
 * …). Rules are stored in SQLite and matched against every event flowing through
 * the panel EventBus, so it complements the time-based scheduler with reactive
 * automation (the standard "automation" feature in Crafty/Pterodactyl panels).
 *
 * Action command/message strings may reference event payload fields with
 * {placeholders}, e.g. "/broadcast Welcome {player}!" on player.joined.
 *
 * Security: a command rule runs on behalf of its creator and is re-checked
 * against that user's current console tier every time it fires (commandPolicy).
 * Placeholder values come from event payloads, some of them attacker-controlled
 * (the username of a failed login), so they are normalized before substitution:
 * name fields must look like a name, everything else loses control characters.
 */
import { getDb } from '../db/index.js';
import { logger } from '../utils/logger.js';
import { subscribe } from './eventBus.js';
import { PanelEventNames, type PanelEvent } from '../schemas/events.js';
import { isValidPlayerName, stripControlChars, containsControlChars } from '../utils/sanitize.js';
import {
  authorizeCommand,
  authorizeStoredCommand,
  reportSkippedCommand,
  type CommandActor,
} from './commandPolicy.js';
import { getServer } from './servers.js';

export type EventActionType = 'command' | 'announce' | 'backup';

export interface EventAction {
  id: string;
  name: string;
  serverId: string | null;
  eventPattern: string;
  actionType: EventActionType;
  actionPayload: { command?: string; message?: string };
  enabled: boolean;
  createdBy: string;
  createdAt: string;
}

interface EventActionRow {
  id: string;
  name: string;
  server_id: string | null;
  event_pattern: string;
  action_type: string;
  action_payload: string | null;
  enabled: number;
  created_by: string;
  created_at: string;
}

function rowToAction(r: EventActionRow): EventAction {
  let payload: { command?: string; message?: string } = {};
  try {
    payload = r.action_payload ? JSON.parse(r.action_payload) : {};
  } catch {
    /* ignore */
  }
  return {
    id: r.id,
    name: r.name,
    serverId: r.server_id,
    eventPattern: r.event_pattern,
    actionType: r.action_type as EventActionType,
    actionPayload: payload,
    enabled: r.enabled === 1,
    createdBy: r.created_by,
    createdAt: r.created_at,
  };
}

/** The events that rules may bind to (single source of truth = events.ts). */
export function availableEvents(): readonly string[] {
  return PanelEventNames;
}

export function listEventActions(): EventAction[] {
  const rows = getDb()
    .prepare('SELECT * FROM event_actions ORDER BY created_at DESC')
    .all() as EventActionRow[];
  return rows.map(rowToAction);
}

export function getEventAction(id: string): EventAction | null {
  const row = getDb().prepare('SELECT * FROM event_actions WHERE id = ?').get(id) as
    EventActionRow | undefined;
  return row ? rowToAction(row) : null;
}

export function createEventAction(input: {
  name: string;
  serverId?: string | null;
  eventPattern: string;
  actionType: EventActionType;
  actionPayload: { command?: string; message?: string };
  createdBy: string;
}): EventAction {
  const id =
    globalThis.crypto?.randomUUID?.() ?? `ea_${Date.now()}_${Math.round(Math.random() * 1e6)}`;
  const now = new Date().toISOString();
  getDb()
    .prepare(
      `
    INSERT INTO event_actions (id, name, server_id, event_pattern, action_type, action_payload, enabled, created_by, created_at)
    VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)
  `,
    )
    .run(
      id,
      input.name,
      input.serverId ?? null,
      input.eventPattern,
      input.actionType,
      JSON.stringify(input.actionPayload ?? {}),
      input.createdBy,
      now,
    );
  return getEventAction(id)!;
}

export function updateEventAction(
  id: string,
  updates: Partial<
    Pick<
      EventAction,
      | 'name'
      | 'serverId'
      | 'eventPattern'
      | 'actionType'
      | 'actionPayload'
      | 'enabled'
      | 'createdBy'
    >
  >,
): EventAction | null {
  const existing = getEventAction(id);
  if (!existing) return null;
  const merged = { ...existing, ...updates };
  getDb()
    .prepare(
      `
    UPDATE event_actions SET name = ?, server_id = ?, event_pattern = ?, action_type = ?, action_payload = ?, enabled = ?, created_by = ?
    WHERE id = ?
  `,
    )
    .run(
      merged.name,
      merged.serverId ?? null,
      merged.eventPattern,
      merged.actionType,
      JSON.stringify(merged.actionPayload ?? {}),
      merged.enabled ? 1 : 0,
      merged.createdBy,
      id,
    );
  return getEventAction(id);
}

export function deleteEventAction(id: string): boolean {
  return getDb().prepare('DELETE FROM event_actions WHERE id = ?').run(id).changes > 0;
}

function patternMatches(pattern: string, name: string): boolean {
  if (pattern === '*') return true;
  if (pattern.endsWith('.*')) return name.startsWith(pattern.slice(0, -1));
  return pattern === name;
}

export const ACTION_TYPES: readonly EventActionType[] = ['command', 'announce', 'backup'];
const MAX_EVENT_PATTERN_LENGTH = 64;
const MAX_RULE_NAME_LENGTH = 100;
const MAX_TEMPLATE_LENGTH = 500;

/**
 * '*', an exact event name, or '<category>.*' for a category that exists.
 * Patterns are matched by plain string comparison and never compiled into a
 * RegExp, so there is no ReDoS surface; this only rejects patterns that could
 * never match (and keeps them short).
 */
export function isValidEventPattern(pattern: unknown): pattern is string {
  if (typeof pattern !== 'string' || pattern.length > MAX_EVENT_PATTERN_LENGTH) return false;
  if (pattern === '*') return true;
  if (pattern.endsWith('.*')) {
    const prefix = pattern.slice(0, -1);
    return /^[a-z0-9_]+\.$/.test(prefix) && PanelEventNames.some((n) => n.startsWith(prefix));
  }
  return (PanelEventNames as readonly string[]).includes(pattern);
}

export type EventActionDraft = Pick<
  EventAction,
  'name' | 'serverId' | 'eventPattern' | 'actionType' | 'actionPayload' | 'enabled'
>;

export type EventActionReview =
  { ok: true; createdBy: string } | { ok: false; status: 400 | 403; error: string };

function validateDraft(draft: EventActionDraft): string | null {
  if (
    typeof draft.name !== 'string' ||
    !draft.name.trim() ||
    draft.name.length > MAX_RULE_NAME_LENGTH
  ) {
    return `name is required (max ${MAX_RULE_NAME_LENGTH} characters)`;
  }
  if (!isValidEventPattern(draft.eventPattern)) {
    return 'eventPattern must be "*", a known event name or "<category>.*"';
  }
  if (!ACTION_TYPES.includes(draft.actionType)) return 'a valid actionType is required';
  if (draft.serverId !== null && typeof draft.serverId !== 'string')
    return 'serverId must be a string or null';
  if (typeof draft.enabled !== 'boolean') return 'enabled must be a boolean';
  const payload = draft.actionPayload;
  if (!payload || typeof payload !== 'object') return 'actionPayload must be an object';
  const template =
    draft.actionType === 'command'
      ? payload.command
      : draft.actionType === 'announce'
        ? payload.message
        : undefined;
  if (draft.actionType !== 'backup') {
    const field =
      draft.actionType === 'command' ? 'actionPayload.command' : 'actionPayload.message';
    if (typeof template !== 'string' || !template.trim())
      return `${draft.actionType} action requires ${field}`;
    if (template.length > MAX_TEMPLATE_LENGTH)
      return `${field} is too long (max ${MAX_TEMPLATE_LENGTH})`;
    if (containsControlChars(template))
      return `${field} must be a single line without control characters`;
  }
  return null;
}

// Renaming or disabling a rule is harmless; anything that changes what runs,
// where, or on which event (including re-enabling it) needs re-authorization.
function changesExecution(prev: EventAction, next: EventActionDraft): boolean {
  return (
    prev.serverId !== next.serverId ||
    prev.eventPattern !== next.eventPattern ||
    prev.actionType !== next.actionType ||
    JSON.stringify(prev.actionPayload ?? {}) !== JSON.stringify(next.actionPayload ?? {}) ||
    (next.enabled && !prev.enabled)
  );
}

/**
 * Validate a rule before it is stored and decide whose rights it runs with.
 * A new rule, or an execution-relevant change, is authorized against the
 * saving actor (command rules need the console tier of their command on the
 * target server) and the actor becomes its creator. Otherwise the stored
 * creator is kept.
 */
export async function reviewEventAction(
  draft: EventActionDraft,
  prev: EventAction | null,
  actor: CommandActor,
): Promise<EventActionReview> {
  const invalid = validateDraft(draft);
  if (invalid) return { ok: false, status: 400, error: invalid };
  if (prev && !changesExecution(prev, draft)) return { ok: true, createdBy: prev.createdBy };
  if (draft.serverId !== null && !(await getServer(draft.serverId).catch(() => null))) {
    return { ok: false, status: 400, error: `Unknown server: ${draft.serverId}` };
  }
  if (draft.actionType === 'command') {
    // null = every server: only the global role counts then.
    const auth = await authorizeCommand(
      actor,
      draft.actionPayload.command ?? '',
      draft.serverId ?? undefined,
    );
    if (!auth.allowed) return { ok: false, status: auth.status, error: auth.error };
  }
  if (!actor.username) return { ok: false, status: 403, error: 'Authentication required' };
  return { ok: true, createdBy: actor.username };
}

// Payload fields that carry a player or panel account name. Their value must
// match the name format, otherwise the action is skipped; that covers the
// username of a failed login, which anyone can choose.
const NAME_PLACEHOLDERS = new Set([
  'player',
  'playerName',
  'username',
  'owner',
  'initiator',
  'target',
]);
const MAX_PLACEHOLDER_LENGTH = 200;

type RenderResult = { ok: true; text: string } | { ok: false; error: string };

function renderTemplate(template: string, evt: PanelEvent): RenderResult {
  let unsafeKey: string | null = null;
  const text = template.replace(/\{(\w+)\}/g, (_m, key: string) => {
    // Own payload fields only, so {constructor} & co. resolve to nothing.
    const raw =
      key === 'serverId'
        ? evt.serverId
        : key === 'event'
          ? evt.name
          : Object.prototype.hasOwnProperty.call(evt.payload, key)
            ? (evt.payload as Record<string, unknown>)[key]
            : undefined;
    if (raw === undefined || raw === null) return '';
    const value = String(raw);
    if (NAME_PLACEHOLDERS.has(key)) {
      if (isValidPlayerName(value)) return value;
      unsafeKey ??= key;
      return '';
    }
    return stripControlChars(value).trim().slice(0, MAX_PLACEHOLDER_LENGTH);
  });
  return unsafeKey
    ? { ok: false, error: `placeholder {${unsafeKey}} has an invalid value` }
    : { ok: true, text };
}

function skipAction(rule: EventAction, evt: PanelEvent, reason: string): void {
  reportSkippedCommand('event_action', `event_action:${rule.id}`, rule.createdBy, reason, {
    rule: rule.name,
    event: evt.name,
  });
}

async function runAction(rule: EventAction, evt: PanelEvent): Promise<void> {
  const serverId = rule.serverId ?? evt.serverId ?? undefined;
  try {
    if (rule.actionType === 'command' && rule.actionPayload.command) {
      const rendered = renderTemplate(rule.actionPayload.command, evt);
      if (!rendered.ok) return skipAction(rule, evt, rendered.error);
      // Runs with the creator's CURRENT rights on the target server.
      const auth = await authorizeStoredCommand(rule.createdBy, rendered.text, serverId);
      if (!auth.allowed) return skipAction(rule, evt, auth.error);
      const { execCommand } = await import('./docker.js');
      await execCommand(rendered.text, serverId);
    } else if (rule.actionType === 'announce' && rule.actionPayload.message) {
      const rendered = renderTemplate(rule.actionPayload.message, evt);
      if (!rendered.ok) return skipAction(rule, evt, rendered.error);
      const { execCommand } = await import('./docker.js');
      await execCommand(`/broadcast ${stripControlChars(rendered.text).trim()}`, serverId);
    } else if (rule.actionType === 'backup') {
      const { createBackup } = await import('./backup.js');
      await createBackup('event', serverId);
    }
    logger.info(`[EventAction] "${rule.name}" ran for ${evt.name}`);
  } catch (err) {
    logger.warn(
      `[EventAction] "${rule.name}" failed for ${evt.name}: ${err instanceof Error ? err.message : err}`,
    );
  }
}

let started = false;

export function startEventActions(): void {
  if (started) return;
  started = true;
  subscribe(['*'], (evt: PanelEvent) => {
    let rules: EventAction[];
    try {
      rules = listEventActions();
    } catch {
      return; // db not ready
    }
    for (const rule of rules) {
      if (!rule.enabled) continue;
      if (rule.serverId && evt.serverId && rule.serverId !== evt.serverId) continue;
      if (!patternMatches(rule.eventPattern, evt.name)) continue;
      void runAction(rule, evt);
    }
  });
  logger.info('[EventAction] engine started');
}
