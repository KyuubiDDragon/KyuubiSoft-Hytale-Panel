/**
 * Structured logger for the panel backend.
 *
 * Wraps pino with a console-compatible variadic signature so migrating
 * legacy `console.log('foo:', err, x)` call sites is a one-liner — the
 * shim formats the args into pino's structured shape under the hood.
 *
 * In production (`NODE_ENV=production`) pino emits JSON; in dev a
 * pretty transport (pino-pretty) gives human output. `LOG_LEVEL` env
 * var overrides the default (debug in dev, info in prod).
 */
import pino from 'pino';

const isDev = process.env.NODE_ENV !== 'production';

const base = pino({
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

type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'fatal' | 'trace';

function format(args: unknown[]): [string, Record<string, unknown> | undefined] {
  // (msg)                                       → just print msg
  // (msg, err)                                  → attach { err }
  // ({field: val, ...}, msg)                    → already structured
  // (msg, ...args)                              → attach { args } where args are anything
  if (args.length === 0) return ['', undefined];
  if (args.length === 1) return [String(args[0]), undefined];
  const first = args[0];
  if (typeof first === 'object' && first !== null && !(first instanceof Error)) {
    return [args.slice(1).map(a => String(a)).join(' '), first as Record<string, unknown>];
  }
  // First arg is the label. Extras are either an Error or arbitrary values.
  const extras = args.slice(1);
  const errIdx = extras.findIndex(x => x instanceof Error);
  if (errIdx >= 0) {
    return [String(first), { err: extras[errIdx], extras: extras.filter((_, i) => i !== errIdx) }];
  }
  return [String(first), { extras }];
}

function emit(level: LogLevel, args: unknown[]): void {
  const [msg, obj] = format(args);
  if (obj) base[level](obj, msg);
  else base[level](msg);
}

/** Console-shaped facade for the rest of the codebase. */
export const logger = {
  debug: (...args: unknown[]) => emit('debug', args),
  info: (...args: unknown[]) => emit('info', args),
  warn: (...args: unknown[]) => emit('warn', args),
  error: (...args: unknown[]) => emit('error', args),
  fatal: (...args: unknown[]) => emit('fatal', args),
  trace: (...args: unknown[]) => emit('trace', args),
  /** Module-scoped logger. Bindings appear on every line. */
  child(bindings: Record<string, unknown>) {
    const c = base.child(bindings);
    return {
      debug: (...a: unknown[]) => { const [m, o] = format(a); o ? c.debug(o, m) : c.debug(m); },
      info:  (...a: unknown[]) => { const [m, o] = format(a); o ? c.info(o, m)  : c.info(m); },
      warn:  (...a: unknown[]) => { const [m, o] = format(a); o ? c.warn(o, m)  : c.warn(m); },
      error: (...a: unknown[]) => { const [m, o] = format(a); o ? c.error(o, m) : c.error(m); },
    };
  },
  /** Direct access to the underlying pino instance when you need structured logging. */
  raw: base,
};

export type Logger = typeof logger;
