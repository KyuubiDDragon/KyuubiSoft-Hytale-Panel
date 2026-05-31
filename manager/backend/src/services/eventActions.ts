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
 */
import { getDb } from '../db/index.js';
import { logger } from '../utils/logger.js';
import { subscribe } from './eventBus.js';
import { PanelEventNames, type PanelEvent } from '../schemas/events.js';

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
  try { payload = r.action_payload ? JSON.parse(r.action_payload) : {}; } catch { /* ignore */ }
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
  const rows = getDb().prepare('SELECT * FROM event_actions ORDER BY created_at DESC').all() as EventActionRow[];
  return rows.map(rowToAction);
}

export function getEventAction(id: string): EventAction | null {
  const row = getDb().prepare('SELECT * FROM event_actions WHERE id = ?').get(id) as EventActionRow | undefined;
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
  const id = (globalThis.crypto?.randomUUID?.() ?? `ea_${Date.now()}_${Math.round(Math.random() * 1e6)}`);
  const now = new Date().toISOString();
  getDb().prepare(`
    INSERT INTO event_actions (id, name, server_id, event_pattern, action_type, action_payload, enabled, created_by, created_at)
    VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)
  `).run(id, input.name, input.serverId ?? null, input.eventPattern, input.actionType, JSON.stringify(input.actionPayload ?? {}), input.createdBy, now);
  return getEventAction(id)!;
}

export function updateEventAction(id: string, updates: Partial<Pick<EventAction, 'name' | 'serverId' | 'eventPattern' | 'actionType' | 'actionPayload' | 'enabled'>>): EventAction | null {
  const existing = getEventAction(id);
  if (!existing) return null;
  const merged = { ...existing, ...updates };
  getDb().prepare(`
    UPDATE event_actions SET name = ?, server_id = ?, event_pattern = ?, action_type = ?, action_payload = ?, enabled = ?
    WHERE id = ?
  `).run(merged.name, merged.serverId ?? null, merged.eventPattern, merged.actionType, JSON.stringify(merged.actionPayload ?? {}), merged.enabled ? 1 : 0, id);
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

function interpolate(template: string, evt: PanelEvent): string {
  return template.replace(/\{(\w+)\}/g, (_m, key: string) => {
    if (key === 'serverId') return evt.serverId ?? '';
    if (key === 'event') return evt.name;
    const v = (evt.payload as Record<string, unknown>)[key];
    return v === undefined || v === null ? '' : String(v);
  });
}

async function runAction(rule: EventAction, evt: PanelEvent): Promise<void> {
  const serverId = rule.serverId ?? evt.serverId ?? undefined;
  try {
    if (rule.actionType === 'command' && rule.actionPayload.command) {
      const { execCommand } = await import('./docker.js');
      const cmd = interpolate(rule.actionPayload.command, evt);
      await execCommand(cmd, serverId);
    } else if (rule.actionType === 'announce' && rule.actionPayload.message) {
      const { execCommand } = await import('./docker.js');
      await execCommand(`/broadcast ${interpolate(rule.actionPayload.message, evt)}`, serverId);
    } else if (rule.actionType === 'backup') {
      const { createBackup } = await import('./backup.js');
      await createBackup('event', serverId);
    }
    logger.info(`[EventAction] "${rule.name}" ran for ${evt.name}`);
  } catch (err) {
    logger.warn(`[EventAction] "${rule.name}" failed for ${evt.name}: ${err instanceof Error ? err.message : err}`);
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
