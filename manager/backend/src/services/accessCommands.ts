/**
 * Console commands of the access pages and how their answers are read.
 *
 * A running server keeps whitelist, bans and permissions in memory and writes
 * its own state back, so changes go through its commands:
 *   /whitelist enable|disable          the RequireJoinPermission switch
 *   /whitelist add|remove <player>     join grant; resolves names through the
 *                                      connected players or the profile service
 *   /perm user add|remove <uuid> <node>
 *                                      own permissions, also the join grant for a
 *                                      known UUID (no profile lookup needed)
 *   /perm user group add|remove <uuid> <group>
 *   /perm group add|remove <group> <node>
 *   /ban <player> [reason]  /unban <player>
 *                                      resolve the player like /whitelist add
 * The server matches a name against connected players by prefix (`Bob` may
 * hit `Bobby`) and needs to be signed in to look up anyone else, so the
 * services send a UUID wherever the panel knows one.
 * Every builder checks its input; docker.sendAccessCommand checks the shape
 * once more before anything reaches the server.
 */
import { sendAccessCommand, type CommandExecResult } from './docker.js';
import {
  JOIN_PERMISSION,
  isUuid,
  isGroupNameInput,
  isPermissionNodeInput,
} from './accessFormats.js';
import { isValidPlayerName, sanitizeMessage } from '../utils/sanitize.js';
import { toConsoleText } from './serverLifecycle.js';

export const MAX_BAN_REASON = 200;

export class AccessInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AccessInputError';
  }
}

function player(value: string): string {
  if (isUuid(value)) return value.toLowerCase();
  // A valid name never starts with `-`, so the server's parser cannot read it as an option (`--x`).
  if (isValidPlayerName(value)) return value;
  throw new AccessInputError('A player name or UUID is required');
}

function uuid(value: string): string {
  if (!isUuid(value)) throw new AccessInputError('A UUID is required');
  return value.toLowerCase();
}

function group(value: string): string {
  if (!isGroupNameInput(value)) throw new AccessInputError(`"${value}" is not a valid group name`);
  return value;
}

function node(value: string): string {
  if (!isPermissionNodeInput(value)) {
    throw new AccessInputError(`"${value}" is not a permission the server accepts`);
  }
  return value;
}

/**
 * A ban reason the console takes as plain words (may be empty). The server's
 * command parser acts on quotes, backslashes, brackets and commas, reads a
 * word starting with `--` as an option, and joins the words with single
 * spaces; none of that is left in. (toConsoleText already turns a leading
 * "--" into a dash look-alike; such a word starts with a single "-" here.)
 */
export function banReasonText(reason: unknown): string {
  if (typeof reason !== 'string') return '';
  return toConsoleText(sanitizeMessage(reason, MAX_BAN_REASON))
    .replace(/["'\\[\],]/g, ' ')
    .split(/\s+/)
    .map((word) => word.replace(/^(?:-{2,}|\u2013)/, '-'))
    .filter((word) => word && word !== '-')
    .join(' ')
    .slice(0, MAX_BAN_REASON)
    .trim();
}

export const accessCommand = {
  whitelistSwitch: (enabled: boolean) => (enabled ? '/whitelist enable' : '/whitelist disable'),
  whitelistAdd: (name: string) => `/whitelist add ${player(name)}`,
  whitelistRemove: (name: string) => `/whitelist remove ${player(name)}`,
  grantJoin: (id: string) => `/perm user add ${uuid(id)} ${JOIN_PERMISSION}`,
  revokeJoin: (id: string) => `/perm user remove ${uuid(id)} ${JOIN_PERMISSION}`,
  ban: (name: string, reason?: string) => {
    const text = banReasonText(reason);
    return text ? `/ban ${player(name)} ${text}` : `/ban ${player(name)}`;
  },
  unban: (name: string) => `/unban ${player(name)}`,
  userGroup: (action: 'add' | 'remove', id: string, name: string) =>
    `/perm user group ${action} ${uuid(id)} ${group(name)}`,
  userPermission: (action: 'add' | 'remove', id: string, permission: string) =>
    `/perm user ${action} ${uuid(id)} ${node(permission)}`,
  groupPermission: (action: 'add' | 'remove', name: string, permission: string) =>
    `/perm group ${action} ${group(name)} ${node(permission)}`,
};

/**
 * - done: the plugin ran the command and answered;
 * - sent: it went to the console (or is still running), the answer is unknown;
 * - rejected: the server refused it (unknown player, bad argument, ...);
 * - failed: it could not be delivered, or may have run without an answer.
 */
export type AccessCommandOutcome =
  | { kind: 'done'; message: string; messageIds: string[] }
  | { kind: 'sent'; via: 'plugin' | 'stdin'; message: string }
  | { kind: 'rejected'; message: string; messageIds: string[] }
  | { kind: 'failed'; message: string };

export function readCommandOutcome(result: CommandExecResult): AccessCommandOutcome {
  const text = (result.lines ?? []).join(' ').trim() || result.output || result.message || '';
  if (result.success) {
    if (result.via === 'plugin' && result.status === 'DONE') {
      return { kind: 'done', message: text, messageIds: result.messageIds ?? [] };
    }
    return { kind: 'sent', via: result.via === 'plugin' ? 'plugin' : 'stdin', message: text };
  }
  if (result.status === 'REJECTED' || result.status === 'NOT_FOUND' || result.status === 'FAILED') {
    const error = result.error && !text.includes(result.error) ? result.error : '';
    return {
      kind: 'rejected',
      message: [error, text].filter(Boolean).join(': ') || 'The server refused the command',
      messageIds: result.messageIds ?? [],
    };
  }
  return { kind: 'failed', message: result.error || 'The command could not be sent' };
}

export async function runAccessCommand(
  command: string,
  serverId?: string,
): Promise<AccessCommandOutcome> {
  return readCommandOutcome(await sendAccessCommand(command, serverId));
}

/** Whether one of the server's answers carries a message id ending in one of `suffixes`. */
export function answered(outcome: AccessCommandOutcome, ...suffixes: string[]): boolean {
  if (outcome.kind !== 'done' && outcome.kind !== 'rejected') return false;
  return outcome.messageIds.some((id) => suffixes.some((s) => id.endsWith(s)));
}
