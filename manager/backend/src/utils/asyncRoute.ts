import type { Request, Response, NextFunction, RequestHandler } from 'express';

/**
 * Express 4 ignores the promise an async handler returns: if it rejects, the
 * request hangs and the error only reaches `unhandledRejection`. Wrapping the
 * handler forwards the rejection to the global error handler (HTTP 500).
 */
export function asyncRoute<Req extends Request = Request>(
  handler: (req: Req, res: Response, next: NextFunction) => Promise<unknown>,
): RequestHandler {
  return (req, res, next) => {
    handler(req as Req, res, next).catch(next);
  };
}
