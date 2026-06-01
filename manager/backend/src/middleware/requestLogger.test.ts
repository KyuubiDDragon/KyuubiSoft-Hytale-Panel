/**
 * Regression test for the pino-http crash that took the manager down in
 * production: requestLogger was passing the variadic console-compat shim
 * to pino-http, which then crashed reading `logger.levels.values` at
 * module load time.
 *
 * If this file imports cleanly the middleware doesn't blow up at import,
 * which is the bar we missed last time.
 */
import { describe, it, expect } from 'vitest';

describe('requestLogger middleware', () => {
  it('imports and exposes a callable RequestHandler', async () => {
    const mod = await import('./requestLogger.js');
    expect(typeof mod.requestLogger).toBe('function');
    // The RequestHandler shape: (req, res, next) — three arguments.
    expect(mod.requestLogger.length).toBe(3);
  });

  it('does not crash when invoked with minimal req/res stubs', async () => {
    const { requestLogger } = await import('./requestLogger.js');
    // pino-http will inspect req.headers and res, so provide just enough
    // surface area for it not to throw during the middleware call.
    const req = {
      headers: {},
      method: 'GET',
      url: '/api/health',
      socket: { remoteAddress: '127.0.0.1' },
    } as unknown as Parameters<typeof requestLogger>[0];
    const headers = new Map<string, string>();
    const res = {
      setHeader: (k: string, v: string) => headers.set(k, v),
      getHeader: (k: string) => headers.get(k),
      statusCode: 200,
      on: () => undefined,
      once: () => undefined,
      emit: () => true,
    } as unknown as Parameters<typeof requestLogger>[1];
    let nextCalled = false;
    requestLogger(req, res, () => { nextCalled = true });
    expect(nextCalled).toBe(true);
    // pino-http stamps x-request-id on the response — proof it actually ran.
    expect(headers.get('x-request-id')).toMatch(/^[0-9a-f-]{36}$/i);
  });
});
