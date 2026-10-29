/**
 * Console command policy shared by every feature that stores or replays
 * console commands (scheduler, quick commands, event actions).
 *
 * It applies exactly the console's own rules: the command whitelist plus the
 * injection guard (validateCommand), then the permission tier derived from the
 * command (console.execute or console.execute.admin), scoped to the server the
 * command will run on. Without this, scheduler.edit alone was enough to plan
 * /op, /stop or /ban and have the panel run it later with full console rights.
 *
 *  - authorizeCommand: an interactive actor (the user saving or running it now)
 *  - authorizeStoredCommand: a stored entry firing later, on behalf of the user
 *    who saved it, re-checked against that user's CURRENT rights
 */
import { hasPermission } from './roles.js';
import { audit } from './audit.js';
import { logger } from '../utils/logger.js';
import { validateCommand, getCommandRequiredPermission } from '../utils/sanitize.js';
import type { AuthenticatedRequest } from '../types/index.js';

export type CommandTier = 'console.execute' | 'console.execute.admin';

export interface CommandActor {
  username?: string | null;
  /** Present when the caller authenticated with an API key. */
  apiKeyScopes?: string[];
}

export type CommandAuthorization =
  { allowed: true; permission: CommandTier } | { allowed: false; status: 400 | 403; error: string };

/** Actor for the user (or API key) behind a request. */
export function actorFromRequest(req: AuthenticatedRequest): CommandActor {
  return { username: req.user, apiKeyScopes: req.apiKey?.scopes };
}

/**
 * Does an API key's scope list cover `permission`? `undefined` means the
 * caller is not an API key, so only the owner's role applies. This is only
 * the key half of the check; the owner must hold the permission as well.
 */
export function scopeAllows(apiKeyScopes: string[] | undefined, permission: string): boolean {
  return !apiKeyScopes || apiKeyScopes.includes('*') || apiKeyScopes.includes(permission);
}

function requiredTier(command: string): CommandTier {
  return getCommandRequiredPermission(command) ?? 'console.execute';
}

// Fail closed: if the rights can't be read (e.g. an unreadable users file),
// the command is denied instead of the caller (or a timer) throwing.
async function holds(
  username: string,
  permission: CommandTier,
  serverId?: string,
): Promise<boolean> {
  try {
    return await hasPermission(username, permission, serverId);
  } catch (err) {
    logger.error(
      `[commandPolicy] permission check failed for "${username}": ${err instanceof Error ? err.message : err}`,
    );
    return false;
  }
}

/**
 * May this actor run `command` on `serverId` right now? Omitting serverId
 * checks the global role only, which is also the right answer for entries
 * that apply to every server.
 */
export async function authorizeCommand(
  actor: CommandActor,
  command: string,
  serverId?: string,
): Promise<CommandAuthorization> {
  const validation = validateCommand(command);
  if (!validation.valid) {
    return { allowed: false, status: 400, error: validation.error || 'Invalid command' };
  }
  const permission = requiredTier(command);
  const denied = {
    allowed: false as const,
    status: 403 as const,
    error: `Permission denied: ${permission} required`,
  };
  if (!actor.username) return denied;
  // An API key never exceeds its declared scopes, even when its owner could.
  if (!scopeAllows(actor.apiKeyScopes, permission)) return denied;
  if (!(await holds(actor.username, permission, serverId))) return denied;
  return { allowed: true, permission };
}

/**
 * May a stored command fire now? It runs on behalf of `createdBy`, so a creator
 * who was demoted or deleted no longer gets their admin commands executed.
 * Entries saved before creators were recorded have no owner to check against:
 * they may only run commands that need no admin tier.
 */
export async function authorizeStoredCommand(
  createdBy: string | null | undefined,
  command: string,
  serverId?: string,
): Promise<CommandAuthorization> {
  const validation = validateCommand(command);
  if (!validation.valid) {
    return { allowed: false, status: 400, error: validation.error || 'Invalid command' };
  }
  const permission = requiredTier(command);
  if (!createdBy) {
    if (permission === 'console.execute') return { allowed: true, permission };
    return {
      allowed: false,
      status: 403,
      error: `no recorded creator; ${permission} commands must be saved again by a user who holds that permission`,
    };
  }
  if (!(await holds(createdBy, permission, serverId))) {
    return {
      allowed: false,
      status: 403,
      error: `creator "${createdBy}" no longer holds ${permission}`,
    };
  }
  return { allowed: true, permission };
}

export type StoredCommandBlock = 'invalid_command' | 'no_creator' | 'creator_lacks_permission';

/**
 * Why a stored command would be skipped if it fired now, or null if it would
 * run. Same decision as authorizeStoredCommand, without logging or auditing;
 * meant for list/config responses so the UI can flag entries that need an
 * explicit approval (POST …/approve) instead of being skipped silently.
 */
export async function storedCommandBlockedReason(
  createdBy: string | null | undefined,
  command: string,
  serverId?: string,
): Promise<StoredCommandBlock | null> {
  const auth = await authorizeStoredCommand(createdBy, command, serverId);
  if (auth.allowed) return null;
  if (auth.status === 400) return 'invalid_command';
  return createdBy ? 'creator_lacks_permission' : 'no_creator';
}

// Entry+reason pairs already written to the audit log in this process.
const auditedSkips = new Set<string>();

/**
 * Record that a stored command was not run. Every skip is logged; only the
 * first one per entry and reason is audited, so a blocked interval entry or a
 * busy event can't flood the audit log.
 */
export function reportSkippedCommand(
  source: 'scheduler' | 'event_action',
  target: string,
  createdBy: string | null | undefined,
  reason: string,
  metadata: Record<string, unknown> = {},
): void {
  logger.warn(`[${source}] Skipped ${target}: ${reason}`);
  const key = `${target}\u0000${reason}`;
  if (auditedSkips.has(key)) return;
  auditedSkips.add(key);
  audit(null, `${source}.command_skipped`, {
    actor: createdBy || 'system',
    actorType: 'system',
    target,
    success: false,
    metadata: { ...metadata, reason },
  });
}
