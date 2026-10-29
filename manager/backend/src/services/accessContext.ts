/**
 * Where the access pages read from and write to.
 *
 *  - Server running, plugin answering: read live from the server, write with
 *    the server's commands and read the result back from the plugin.
 *  - Server running, no plugin: read the files (the server writes them on
 *    every change, so they match), write with the commands over the console
 *    and watch the file for the result.
 *  - Server stopped: read and write the files, under the server's lifecycle
 *    lock so no start through the panel can begin halfway through.
 */
import path from 'path';
import * as dockerService from './docker.js';
import { LifecycleBusyError, runWhileServerStopped } from './serverLifecycle.js';
import { AccessInputError, type AccessCommandOutcome } from './accessCommands.js';
import { UnsafeFileError } from '../utils/noFollowFs.js';
import { ServerJsonParseError } from '../utils/serverFiles.js';
import type { FileProblem } from './accessFormats.js';

export type AccessSource = 'live' | 'file';
export type WriteVia = 'plugin' | 'stdin' | 'file';

export type AccessErrorCode =
  | 'invalid_input'
  | 'unknown_player'
  | 'ambiguous_player'
  | 'rejected'
  | 'not_confirmed'
  | 'unreachable'
  | 'busy'
  | 'needs_stopped_server'
  | 'file_missing'
  | 'file_broken'
  | 'unsupported'
  | 'docker_unavailable';

/** A refusal the routes answer with `status` and `{ success: false, error, code }`. */
export class AccessError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code: AccessErrorCode,
  ) {
    super(message);
    this.name = 'AccessError';
  }
}

export interface WriteOutcome<V> {
  view: V;
  via: WriteVia;
  /** The new state was read back (from the plugin or the file). */
  verified: boolean;
  /** false: it was already that way. */
  changed: boolean;
  message?: string;
}

/** Common fields of the access pages' views. */
export interface AccessViewBase {
  source: AccessSource;
  /** null: Docker could not tell. */
  serverRunning: boolean | null;
  /** What the server cannot read in its files (fatal ones keep the access control off). */
  problems: FileProblem[];
}

/** The UUID a file edit needs, or why there is none. */
export function requireUuid(target: { input: string; uuid?: string; ambiguous?: boolean }): string {
  if (target.uuid) return target.uuid;
  if (target.ambiguous) {
    throw new AccessError(
      409,
      `More than one known player is called "${target.input}"; use the UUID.`,
      'ambiguous_player',
    );
  }
  throw new AccessError(
    404,
    `No UUID is known for "${target.input}". Use the UUID, or a player who has joined this server before.`,
    'unknown_player',
  );
}

/**
 * What a command names the player by: the UUID wherever it is known. A name
 * goes to the server only when it cannot pick someone else with it (it matches
 * names by prefix, so `Bob` would hit an online `Bobby`).
 */
export function commandTarget(target: {
  input: string;
  uuid?: string;
  ambiguous?: boolean;
  longerNames?: string[];
}): string {
  if (target.uuid) return target.uuid;
  if (target.ambiguous) return requireUuid(target);
  if (target.longerNames && target.longerNames.length > 0) {
    throw new AccessError(
      409,
      `The server could take "${target.input}" for ${target.longerNames.slice(0, 3).join(', ')}; use the full name or the UUID.`,
      'ambiguous_player',
    );
  }
  return target.input;
}

/** For reads: whether the server runs, null when Docker cannot tell. */
export async function serverRunningOrNull(serverId?: string): Promise<boolean | null> {
  const status = await dockerService.getStatus(serverId);
  return status.status === 'error' ? null : status.running;
}

/**
 * Runs `onFile` while the server is stopped (under its lock) and `onCommand`
 * while it runs. Docker that cannot tell refuses the write.
 */
export async function writeFilesOrCommand<T>(
  serverId: string | undefined,
  onFile: () => Promise<T>,
  onCommand: () => Promise<T>,
): Promise<T> {
  const dockerUnavailable = () =>
    new AccessError(
      503,
      'Docker cannot tell whether the server is running, so nothing was changed',
      'docker_unavailable',
    );
  let running: boolean;
  try {
    running = (await dockerService.getContainerState(serverId))?.running === true;
  } catch {
    throw dockerUnavailable();
  }
  if (running) return onCommand();
  // Errors of the file edit itself pass through; the others come from the lock or Docker.
  let fromFile = false;
  const editFiles = async () => {
    try {
      return await onFile();
    } catch (error) {
      fromFile = true;
      throw error;
    }
  };
  let result: { ran: true; value: T } | { ran: false };
  try {
    result = await runWhileServerStopped(
      serverId,
      { reason: 'config', rejectIfBusy: true },
      editFiles,
    );
  } catch (error) {
    if (fromFile) throw error;
    if (error instanceof LifecycleBusyError) {
      throw new AccessError(
        409,
        'The server is being started or stopped right now; try again in a moment',
        'busy',
      );
    }
    throw dockerUnavailable();
  }
  // The server came up meanwhile: then the change goes through its commands.
  return result.ran ? result.value : onCommand();
}

/** Polls `check` until it is true or `timeoutMs` passed. */
export async function waitFor(
  check: () => Promise<boolean>,
  timeoutMs = 3000,
  intervalMs = 250,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await check().catch(() => false)) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

/** The AccessError for a command that did not go through. */
export function commandFailure(outcome: AccessCommandOutcome, hint?: string): AccessError {
  if (outcome.kind === 'rejected') {
    return new AccessError(400, hint ? `${outcome.message} ${hint}` : outcome.message, 'rejected');
  }
  return new AccessError(
    503,
    outcome.kind === 'failed' ? outcome.message : 'No answer',
    'unreachable',
  );
}

/** Maps errors of the access services to an HTTP status and a message the user can act on. */
export function describeAccessError(error: unknown): {
  status: number;
  error: string;
  code: string;
} {
  if (error instanceof AccessError) {
    return { status: error.status, error: error.message, code: error.code };
  }
  if (error instanceof AccessInputError) {
    return { status: 400, error: error.message, code: 'invalid_input' };
  }
  if (error instanceof ServerJsonParseError) {
    return { status: 409, error: error.message, code: 'file_broken' };
  }
  if (error instanceof UnsafeFileError) {
    // Only the file name: the server folder's place on the host is none of the client's business.
    return {
      status: 409,
      error: `${path.basename(error.filePath)} cannot be used: ${error.why}. Replace it with a regular file.`,
      code: 'file_broken',
    };
  }
  return { status: 500, error: 'The access files could not be read or written', code: 'internal' };
}
