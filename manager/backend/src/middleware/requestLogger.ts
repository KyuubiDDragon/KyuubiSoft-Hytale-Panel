import { pinoHttp } from 'pino-http';
import { randomUUID } from 'crypto';
import type { Request, Response, NextFunction, RequestHandler } from 'express';
import { logger } from '../utils/logger.js';

/**
 * Express middleware that assigns every request a correlation id and emits
 * one structured log line per request/response pair (skipping health
 * checks). Wrapped via RequestHandler so the Express types accept it as a
 * middleware without an additional cast at the use-site.
 *
 * IMPORTANT: pino-http reads `logger.levels.values` internally to decide
 * which custom log levels are valid. Our public `logger` export is a
 * console-compatible variadic shim around pino — it doesn't carry pino's
 * own internal fields. Pass the underlying pino instance (`logger.raw`)
 * to pino-http; calls to logger.info / logger.error from application code
 * still flow through the shim.
 */
// pino-http's TS types are looser than what app.use() expects; we narrow
// once here so callers don't have to.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const _pinoMiddleware = (pinoHttp as any)({
  logger: logger.raw,
  genReqId: (req: Request, res: Response): string => {
    const existing = (req.headers['x-request-id'] as string | undefined)?.trim();
    const id = existing || randomUUID();
    res.setHeader('x-request-id', id);
    return id;
  },
  autoLogging: {
    ignore: (req: Request) => req.url?.startsWith('/api/health') ?? false,
  },
  customLogLevel: (_req: Request, res: Response, err: Error | undefined) => {
    if (err || res.statusCode >= 500) return 'error';
    if (res.statusCode >= 400) return 'warn';
    return 'info';
  },
});

export const requestLogger: RequestHandler = (req, res, next: NextFunction) => {
  _pinoMiddleware(req, res, next);
};
