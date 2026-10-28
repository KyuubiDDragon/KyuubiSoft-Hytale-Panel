import { pinoHttp } from 'pino-http';
import { randomUUID } from 'crypto';
import type { Request, Response, NextFunction, RequestHandler } from 'express';
import type { Logger } from 'pino';
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
 *
 * Credentials never reach the log: the serializers below blank the headers,
 * query parameters and path segments that carry them.
 */

const REDACTED = '[redacted]';

/** Request headers that carry credentials or session secrets. */
const SECRET_REQUEST_HEADERS = new Set([
  'authorization',
  'proxy-authorization',
  'cookie',
  'x-api-key',
  'x-csrf-token',
]);

/** Response headers that carry credentials (the login's refresh cookie). */
const SECRET_RESPONSE_HEADERS = new Set(['set-cookie']);

/**
 * Query and route parameters that carry a credential: the replay stream's
 * JWT (`token`; EventSource cannot send headers), WebSocket tickets, the SSO
 * callback's one-time `code` and `state`, map session ids.
 */
const SECRET_PARAMS = new Set([
  'token',
  'ticket',
  'access_token',
  'refresh_token',
  'code',
  'state',
  'api_key',
  'apikey',
  'password',
  'sessionid',
]);

/** Path segments that are the credential: one-shot replay downloads, map sessions. */
const SECRET_PATH_SEGMENTS = [/(\/replay\/download\/)[^/?#]+/g, /(\/webmap\/t\/)[^/?#]+/g];

function decodeKey(raw: string): string {
  try {
    return decodeURIComponent(raw.replace(/\+/g, ' ')).toLowerCase();
  } catch {
    return raw.toLowerCase();
  }
}

/** The URL with credential path segments and query values blanked; the rest stays as sent. */
export function redactUrl(url: string): string {
  const q = url.indexOf('?');
  let path = q < 0 ? url : url.slice(0, q);
  for (const pattern of SECRET_PATH_SEGMENTS) path = path.replace(pattern, `$1${REDACTED}`);
  if (q < 0) return path;
  const query = url
    .slice(q + 1)
    .split('&')
    .map((pair) => {
      const eq = pair.indexOf('=');
      const key = eq < 0 ? pair : pair.slice(0, eq);
      return SECRET_PARAMS.has(decodeKey(key)) ? `${key}=${REDACTED}` : pair;
    })
    .join('&');
  return `${path}?${query}`;
}

function redactEntries(value: unknown, secret: Set<string>): unknown {
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, v]) => [
      key,
      secret.has(key.toLowerCase()) ? REDACTED : v,
    ]),
  );
}

// pino-http hands these the output of pino's standard serializers.
type SerializedReq = { url?: unknown; query?: unknown; params?: unknown; headers?: unknown };
type SerializedRes = { headers?: unknown };

const serializers = {
  req: (req: SerializedReq) => ({
    ...req,
    url: typeof req.url === 'string' ? redactUrl(req.url) : req.url,
    query: redactEntries(req.query, SECRET_PARAMS),
    params: redactEntries(req.params, SECRET_PARAMS),
    headers: redactEntries(req.headers, SECRET_REQUEST_HEADERS),
  }),
  res: (res: SerializedRes) => ({
    ...res,
    headers: redactEntries(res.headers, SECRET_RESPONSE_HEADERS),
  }),
};

/** The middleware on any pino logger (tests pass one that writes to memory). */
export function createRequestLogger(base: Logger): RequestHandler {
  // pino-http's TS types are looser than what app.use() expects; we narrow
  // once here so callers don't have to.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const pinoMiddleware = (pinoHttp as any)({
    logger: base,
    serializers,
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
  return (req, res, next: NextFunction) => {
    pinoMiddleware(req, res, next);
  };
}

export const requestLogger: RequestHandler = createRequestLogger(logger.raw);
