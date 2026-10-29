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
 * Joins and leaves the panel read from the server log (no plugin connection)
 * run no command rules at all, see commandFromLogEvent.
 *
 * Loops: an event published while a rule's action runs (backup.completed from
 * the rule's own backup) is tagged with the chain of running rules. A rule
 * never fires for an event its own action caused, chains stop after
 * MAX_RULE_CHAIN rules, and a backup rule runs at most once per cooldown.
 * Floods: every rule runs at most RULE_RUNS_PER_MINUTE times per event name
 * and server, so a flood on one server does not use up the others' runs.
 *
 * Servers: a rule with a server only fires for that server's events. An event
 * published without a server id is the default server's (legacy callers),
 * except account and panel events, which concern no server (eventServer.ts).
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { getDb } from '../db/index.js';
import { logger } from '../utils/logger.js';
import { subscribe } from './eventBus.js';
import { PanelEventNames, eventPatternMatches, type PanelEvent } from '../schemas/events.js';
import { KeyedTokenBucket } from '../utils/tokenBucket.js';
import { isValidPlayerName, containsControlChars, toCommandText } from '../utils/sanitize.js';
import {
  authorizeCommand,
  authorizeStoredCommand,
  reportSkippedCommand,
  storedCommandBlockedReason,
  type CommandActor,
  type StoredCommandBlock,
} from './commandPolicy.js';
import { getServer, resolveServerId } from './servers.js';
import { userMayAccessServer } from './roles.js';
import { getUser } from './users.js';
import { eventServerId } from './eventServer.js';

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

export type EventActionView = EventAction & { blockedReason: StoredCommandBlock | null };

/**
 * Rules as served to clients: command rules carry a derived `blockedReason`
 * (why they would be skipped right now, e.g. the creator lost the console
 * tier). Rules for every server are judged by the creator's global role.
 */
export async function listEventActionViews(): Promise<EventActionView[]> {
  return Promise.all(
    listEventActions().map(async (rule) => ({
      ...rule,
      blockedReason:
        rule.actionType === 'command' && rule.actionPayload.command
          ? await storedCommandBlockedReason(
              rule.createdBy,
              rule.actionPayload.command,
              rule.serverId ?? undefined,
            )
          : null,
    })),
  );
}

/**
 * Explicit approval: the requester becomes the creator of a command rule, but
 * only if they may run its command on the rule's server themselves.
 */
export async function approveEventAction(
  id: string,
  actor: CommandActor,
): Promise<
  { ok: true; rule: EventAction } | { ok: false; status: 400 | 403 | 404; error: string }
> {
  const rule = getEventAction(id);
  if (!rule) return { ok: false, status: 404, error: 'Rule not found' };
  if (rule.actionType !== 'command' || !rule.actionPayload.command) {
    return { ok: false, status: 400, error: 'Only command rules need approval' };
  }
  const auth = await authorizeCommand(
    actor,
    rule.actionPayload.command,
    rule.serverId ?? undefined,
  );
  if (!auth.allowed) return { ok: false, status: auth.status, error: auth.error };
  if (!actor.username) return { ok: false, status: 403, error: 'Authentication required' };
  const updated = updateEventAction(id, { createdBy: actor.username });
  return updated
    ? { ok: true, rule: updated }
    : { ok: false, status: 404, error: 'Rule not found' };
}

// One rule runs at most this often per event name and server. Some events can
// be caused from outside (refused joins under made-up names), and a rule must
// not turn a flood of them into a flood of console commands, broadcasts or
// backups.
export const RULE_RUNS_PER_MINUTE = 10;
const THROTTLE_LOG_INTERVAL_MS = 60_000;
const ruleThrottle = new KeyedTokenBucket({ perMinute: RULE_RUNS_PER_MINUTE });
const throttleLoggedAt = new Map<string, number>();

/** May `rule` run for `evt` now? A dropped run is logged before anything executes. */
function withinRuleBudget(rule: EventAction, evt: PanelEvent): boolean {
  const server = evt.serverId ?? '';
  const key = `${rule.id}\u0000${server}\u0000${evt.name}`;
  if (ruleThrottle.tryTake(key)) return true;
  const now = Date.now();
  if (now - (throttleLoggedAt.get(key) ?? 0) >= THROTTLE_LOG_INTERVAL_MS) {
    throttleLoggedAt.set(key, now);
    logger.warn(
      `[EventAction] "${rule.name}" throttled for ${evt.name}${server ? ` on ${server}` : ''}: more than ${RULE_RUNS_PER_MINUTE} runs per minute, further runs are dropped (logged at most once per minute)`,
    );
  }
  return false;
}

// A join or leave read from the server log (payload source 'log', only while
// the server has no plugin connection) rests on text the server printed, and
// a mod may print text a client sent. Such events run no console commands;
// announcements, backups, webhooks and the online list still get them.
const logSkipLoggedAt = new Map<string, number>();

/** Is this a command rule the event must not run? The skip is logged once a minute per rule and event. */
function commandFromLogEvent(rule: EventAction, evt: PanelEvent): boolean {
  if (rule.actionType !== 'command' || evt.payload.source !== 'log') return false;
  const key = `${rule.id}\u0000${evt.name}`;
  const now = Date.now();
  if (now - (logSkipLoggedAt.get(key) ?? 0) >= THROTTLE_LOG_INTERVAL_MS) {
    logSkipLoggedAt.set(key, now);
    logger.info(
      `[EventAction] "${rule.name}" skipped for ${evt.name}: the event was read from the server log (no plugin connection), which runs no commands (logged at most once per minute)`,
    );
  }
  return true;
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

// Placeholders with a checked name or a value the panel or the server sets;
// any other one carries text from the event (a chat message, a reason).
const FIXED_PLACEHOLDERS = new Set([...NAME_PLACEHOLDERS, 'uuid', 'serverId', 'event']);

// Events the panel reads from the server log while a server has no plugin
// connection (services/playerPresence.ts); their payload has source 'log'.
const LOG_SOURCED_EVENTS = ['player.joined', 'player.left'];

export type EventActionWarning =
  | { code: 'free_text_placeholder'; placeholders: string[]; message: string }
  | { code: 'log_events_run_no_commands'; events: string[]; message: string };

export interface EventActionWarningContext {
  /** The rule's server (one of them, for a rule on every server) has no plugin connection now. */
  withoutPlugin?: boolean;
}

/**
 * Warnings for a rule the panel still saves:
 *  - a command template with a free text placeholder lets whoever causes the
 *    event (a player chatting, someone failing a login) add words or
 *    arguments to the command; the rule keeps running with its creator's
 *    rights, so this is a hint, not a refusal;
 *  - a command rule on joins or leaves does not run while they come from the
 *    server log (see commandFromLogEvent).
 */
export function eventActionWarnings(
  rule: Pick<EventActionDraft, 'actionType' | 'actionPayload' | 'eventPattern'>,
  context: EventActionWarningContext = {},
): EventActionWarning[] {
  if (rule.actionType !== 'command') return [];
  const warnings: EventActionWarning[] = [];
  const template = rule.actionPayload?.command;
  const keys = new Set<string>();
  for (const [, key] of (typeof template === 'string' ? template : '').matchAll(/\{(\w+)\}/g)) {
    if (!FIXED_PLACEHOLDERS.has(key)) keys.add(key);
  }
  if (keys.size > 0) {
    const placeholders = [...keys];
    warnings.push({
      code: 'free_text_placeholder',
      placeholders,
      message: `${placeholders.map((k) => `{${k}}`).join(', ')} put text from the event into the command: whoever causes the event can add words or arguments to it.`,
    });
  }
  const events = LOG_SOURCED_EVENTS.filter((name) => eventPatternMatches(rule.eventPattern, name));
  if (context.withoutPlugin && events.length > 0) {
    warnings.push({
      code: 'log_events_run_no_commands',
      events,
      message: `Without a connected KyuubiSoft API plugin the panel reads ${events.join(' and ')} from the server log, and those events run no commands. Install the plugin for this rule to run.`,
    });
  }
  return warnings;
}

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
    // Plain text for the command parser: no quotes, brackets or --options
    // a chat message could slip into the command.
    return toCommandText(value, MAX_PLACEHOLDER_LENGTH);
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

// Sender name in the server log: "Panel:event/<creator>".
function eventActor(rule: EventAction): string {
  return rule.createdBy ? `event/${rule.createdBy}` : 'event';
}

function commandFailed(rule: EventAction, evt: PanelEvent, error: string | undefined): void {
  logger.warn(
    `[EventAction] "${rule.name}" command failed for ${evt.name}: ${error ?? 'unknown error'}`,
  );
}

/**
 * Creators of the rules the panel keeps itself (the scheduler's welcome
 * message). They name no account, so the account check would always refuse
 * them; instead such a rule only runs for the server it was made for. A
 * change to what a rule does makes the editing user its creator, and an
 * account that happens to carry one of these names is checked like any other.
 */
const SYSTEM_CREATORS: ReadonlySet<string> = new Set(['scheduler']);

/** May the rule's creator act on `target` (before any per-permission check)? */
async function creatorMayUse(rule: EventAction, target: string): Promise<boolean> {
  if (SYSTEM_CREATORS.has(rule.createdBy) && (await getUser(rule.createdBy)) === null) {
    return rule.serverId === target;
  }
  return userMayAccessServer(rule.createdBy, target);
}

async function runAction(rule: EventAction, evt: PanelEvent): Promise<void> {
  const serverId = rule.serverId ?? evt.serverId ?? undefined;
  try {
    // Every action works on its target server (an announcement or a backup as
    // much as a command): the creator must still be allowed to use it.
    const target = await resolveServerId(serverId);
    if (!(await creatorMayUse(rule, target))) {
      return skipAction(rule, evt, `the creator has no access to server ${target}`);
    }
    if (rule.actionType === 'command' && rule.actionPayload.command) {
      const rendered = renderTemplate(rule.actionPayload.command, evt);
      if (!rendered.ok) return skipAction(rule, evt, rendered.error);
      // Runs with the creator's CURRENT rights on the target server.
      const auth = await authorizeStoredCommand(rule.createdBy, rendered.text, serverId);
      if (!auth.allowed) return skipAction(rule, evt, auth.error);
      const { execCommand } = await import('./docker.js');
      const result = await execCommand(rendered.text, serverId, { actor: eventActor(rule) });
      if (!result.success) return commandFailed(rule, evt, result.error);
    } else if (rule.actionType === 'announce' && rule.actionPayload.message) {
      const rendered = renderTemplate(rule.actionPayload.message, evt);
      if (!rendered.ok) return skipAction(rule, evt, rendered.error);
      const { execCommand } = await import('./docker.js');
      const result = await execCommand(
        `/broadcast ${toCommandText(rendered.text, MAX_TEMPLATE_LENGTH)}`,
        serverId,
        { actor: eventActor(rule) },
      );
      if (!result.success) return commandFailed(rule, evt, result.error);
    } else if (rule.actionType === 'backup') {
      const { createBackup } = await import('./backup.js');
      const result = await createBackup({ kind: 'auto', label: 'event' }, serverId);
      if (!result.success) throw new Error(result.error ?? 'backup failed');
    }
    logger.info(`[EventAction] "${rule.name}" ran for ${evt.name}`);
  } catch (err) {
    logger.warn(
      `[EventAction] "${rule.name}" failed for ${evt.name}: ${err instanceof Error ? err.message : err}`,
    );
  }
}

// Ids of the rules whose actions are running in the current async context.
// eventBus.publish() calls listeners synchronously, so an event an action
// causes is seen with that action's chain.
const ruleChain = new AsyncLocalStorage<readonly string[]>();
const MAX_RULE_CHAIN = 3;
export const BACKUP_ACTION_COOLDOWN_MS = 10 * 60 * 1000;
const lastBackupAction = new Map<string, number>();

/**
 * Whether `rule` may fire for an event seen with `chain`; records backup runs.
 * A backup run counts at its start, also when it fails: a rule whose backup
 * keeps failing (full disk) must not retry on every matching event.
 *
 * The checks without side effects come first, so an event the rule must not
 * run for (its own, or one inside the backup cooldown) costs it no run of its
 * per-event budget, and a run the budget drops starts no backup cooldown.
 */
function mayFire(rule: EventAction, evt: PanelEvent, chain: readonly string[]): boolean {
  if (chain.includes(rule.id)) return false; // its own action caused this event
  if (rule.actionType !== 'backup') return withinRuleBudget(rule, evt);
  const now = Date.now();
  // Expired entries are dropped, so deleted rules and servers don't pile up.
  for (const [k, at] of lastBackupAction) {
    if (now - at >= BACKUP_ACTION_COOLDOWN_MS) lastBackupAction.delete(k);
  }
  // Per target server: a rule for all servers may back up each of them.
  const key = `${rule.id}:${rule.serverId ?? evt.serverId ?? ''}`;
  if (lastBackupAction.has(key)) {
    logger.info(`[EventAction] "${rule.name}" skipped for ${evt.name}: backup cooldown`);
    return false;
  }
  if (!withinRuleBudget(rule, evt)) return false;
  lastBackupAction.set(key, now);
  return true;
}

let started = false;

/**
 * Run the matching rules for one event. `chain` is the rule chain the event
 * was published in, read when it was published.
 */
async function dispatch(evt: PanelEvent, chain: readonly string[]): Promise<void> {
  let rules: EventAction[];
  try {
    rules = listEventActions().filter(
      // Wildcards never cover events outsiders can cause (schemas/events.ts).
      (rule) => rule.enabled && eventPatternMatches(rule.eventPattern, evt.name),
    );
  } catch {
    return; // db not ready
  }
  if (rules.length === 0) return;
  // The event's server, resolved: a legacy event without one is the default server's.
  const serverId = await eventServerId(evt);
  const scoped: PanelEvent = serverId ? { ...evt, serverId } : evt;
  for (const rule of rules) {
    // A rule for one server only fires for that server's events, never panel-wide ones.
    if (rule.serverId && rule.serverId !== serverId) continue;
    if (commandFromLogEvent(rule, scoped)) continue;
    if (!mayFire(rule, scoped, chain)) continue;
    void ruleChain.run([...chain, rule.id], () => runAction(rule, scoped));
  }
}

export function startEventActions(): void {
  if (started) return;
  started = true;
  subscribe(['*'], (evt: PanelEvent) => {
    const chain = ruleChain.getStore() ?? [];
    if (chain.length >= MAX_RULE_CHAIN) {
      logger.warn(`[EventAction] ${evt.name} ignored: rule chain too long (${chain.length})`);
      return;
    }
    dispatch(evt, chain).catch((err) =>
      logger.warn(
        `[EventAction] ${evt.name} not handled: ${err instanceof Error ? err.message : err}`,
      ),
    );
  });
  logger.info('[EventAction] engine started');
}
