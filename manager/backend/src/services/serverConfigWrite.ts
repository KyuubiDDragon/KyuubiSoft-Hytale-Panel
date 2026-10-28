/**
 * When the panel may write a file the game server owns (config.json, the
 * other JSON files of the server folder, world configs).
 *
 * A running server keeps these in memory and writes its own copy back
 * (config.json whenever something changed, a world config whenever the world
 * stops), so the panel only writes them while the server is stopped:
 *  - stopped: written right away, under the lifecycle lock so no start
 *    through the panel reads the file halfway;
 *  - running: refused (requires_restart) unless the caller asked for a
 *    restart; then the server is stopped, the file written and the server
 *    started again (optionally after an in-game countdown).
 */
import type { NextFunction, Response } from 'express';
import * as dockerService from './docker.js';
import { requirePermission } from '../middleware/permissions.js';
import type { AuthenticatedRequest } from '../types/index.js';
import {
  LifecycleBusyError,
  LifecycleError,
  isLifecycleBusy,
  runWhileServerStopped,
  withServerStopped,
} from './serverLifecycle.js';
import { resolveServerId } from './servers.js';
import { UnsafeFileError } from '../utils/noFollowFs.js';
import { ServerJsonParseError } from '../utils/serverFiles.js';

export const MAX_COUNTDOWN_SECONDS = 1800;

export interface ServerWriteOptions {
  /** Stop, write and start again when the server runs. */
  restart: boolean;
  actor?: string;
  countdownSeconds?: number;
}

export type ServerWriteOutcome<T> =
  | { kind: 'written'; restarted: boolean; value: T }
  | { kind: 'requires_restart' }
  | { kind: 'busy' };

export async function isServerRunning(serverId?: string): Promise<boolean> {
  const state = await dockerService.getContainerState(serverId).catch(() => null);
  return state?.running === true;
}

/** Countdown from a request body, capped; 0 when absent or invalid. */
export function countdownFrom(body: unknown): number {
  const v = (body as { countdownSeconds?: unknown } | undefined)?.countdownSeconds;
  return Number.isInteger(v) && (v as number) > 0
    ? Math.min(v as number, MAX_COUNTDOWN_SECONDS)
    : 0;
}

/**
 * Runs `write` while the server is stopped (see the module comment). Throws
 * what `write` throws, LifecycleError when the server cannot be stopped or
 * started again, LifecycleBusyError when another operation got in first.
 */
export async function writeWhileStopped<T>(
  serverId: string | undefined,
  opts: ServerWriteOptions,
  write: () => Promise<T>,
): Promise<ServerWriteOutcome<T>> {
  if (isLifecycleBusy(await resolveServerId(serverId))) return { kind: 'busy' };
  if (!(await isServerRunning(serverId))) {
    const done = await runWhileServerStopped(
      serverId,
      { reason: 'config', rejectIfBusy: true },
      write,
    );
    if (done.ran) return { kind: 'written', restarted: false, value: done.value };
    // Started in the meantime.
    if (!opts.restart) return { kind: 'requires_restart' };
  } else if (!opts.restart) {
    return { kind: 'requires_restart' };
  }
  const value = await withServerStopped(
    serverId,
    {
      reason: 'config',
      actor: opts.actor,
      countdownSeconds: opts.countdownSeconds ?? 0,
      rejectIfBusy: true,
    },
    write,
  );
  return { kind: 'written', restarted: true, value };
}

const restartPermission = requirePermission('server.restart');

/**
 * Middleware: saving with `restart: true` restarts the server, so it also
 * needs the right to restart it, not only to edit the file.
 */
export function requireRestartPermissionIfAsked(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
): void {
  if ((req.body as { restart?: unknown } | undefined)?.restart === true) {
    void restartPermission(req, res, next);
    return;
  }
  next();
}

export const BUSY_RESPONSE = {
  success: false,
  reason: 'lifecycle_busy',
  error: 'Another server operation (stop, start, rollback, restore) is running.',
};

/**
 * Answers a refused write. Returns false for an outcome that was written, so
 * the caller sends its own success response.
 */
export function sendRefusedWrite(
  res: Response,
  outcome: ServerWriteOutcome<unknown>,
  details: Record<string, unknown> = {},
): boolean {
  if (outcome.kind === 'busy') {
    res.status(409).json(BUSY_RESPONSE);
    return true;
  }
  if (outcome.kind === 'requires_restart') {
    res.status(409).json({
      success: false,
      requiresRestart: true,
      reason: 'requires_restart',
      error:
        'The server is running and keeps this file in memory; it would overwrite the change. Save with a restart, or stop the server first.',
      ...details,
    });
    return true;
  }
  return false;
}

/** Maps an error of a write to a response. */
export function sendWriteError(res: Response, error: unknown, what: string): void {
  if (error instanceof LifecycleBusyError) {
    res.status(409).json(BUSY_RESPONSE);
    return;
  }
  if (error instanceof UnsafeFileError || error instanceof ServerJsonParseError) {
    const reason = error instanceof ServerJsonParseError ? 'invalid_json' : 'unsafe_file';
    res.status(409).json({ success: false, reason, error: error.message });
    return;
  }
  const status = error instanceof LifecycleError ? 503 : 500;
  res.status(status).json({
    success: false,
    error: `Failed to save ${what}`,
    message: error instanceof Error ? error.message : 'Unknown error',
  });
}
