/**
 * Who a console command is run for.
 *
 * The KyuubiSoft API plugin runs panel commands as "Panel:<user>", so the
 * server log names the panel user behind every command. Instead of threading
 * the user through every caller of execCommand (player actions, update and
 * world routes, setup, …), the request is remembered for the duration of its
 * async work and execCommand reads the user from there. Work without a request
 * (scheduler, event actions, WebSocket console) passes the actor explicitly.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import type { NextFunction, Request, Response } from 'express';

interface ActorScope {
  // Read lazily while the request runs: the auth middleware sets req.user
  // only after this scope opened.
  req: (Request & { user?: string }) | null;
  user?: string;
}

const scope = new AsyncLocalStorage<ActorScope>();

/**
 * Express middleware. Must run after the body parsers, so their stream
 * callbacks don't run outside the scope.
 */
export function bindCommandActor(req: Request, res: Response, next: NextFunction): void {
  const holder: ActorScope = { req };
  // Once the request is over only the user name is kept, so async work that
  // outlives it (a timer or poller it started) does not hold the request,
  // response and body in memory.
  res.once('close', () => {
    holder.user = holder.req?.user ?? undefined;
    holder.req = null;
  });
  scope.run(holder, next);
}

/** The authenticated panel user of the current request, if any. */
export function currentCommandActor(): string | undefined {
  const holder = scope.getStore();
  if (!holder) return undefined;
  return (holder.req ? holder.req.user : holder.user) ?? undefined;
}
