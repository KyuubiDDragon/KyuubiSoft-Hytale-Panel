/**
 * Structured logger for the panel backend.
 *
 * Uses pino with a pretty transport in development (NODE_ENV !== 'production')
 * and JSON in production so log shippers can ingest it directly. The
 * `correlationId` field is set per-request by pino-http; every line written
 * inside a request handler carries the same id, which makes tracing one
 * client interaction across services trivial.
 *
 * Migration: existing code keeps using `console.*` which still works. New
 * code should `import { logger } from '../utils/logger.js'` and use
 * `logger.info({ ... }, 'message')`. The two strategies coexist.
 */
import pino from 'pino';

const isDev = process.env.NODE_ENV !== 'production';

export const logger = pino({
  level: process.env.LOG_LEVEL || (isDev ? 'debug' : 'info'),
  ...(isDev
    ? {
        transport: {
          target: 'pino-pretty',
          options: { colorize: true, translateTime: 'HH:MM:ss.l', ignore: 'pid,hostname' },
        },
      }
    : {}),
});

export function child(bindings: Record<string, unknown>): pino.Logger {
  return logger.child(bindings);
}
