import { describe, it, expect, vi } from 'vitest';
import type { Request, Response, NextFunction } from 'express';
import { asyncRoute } from './asyncRoute.js';

describe('asyncRoute', () => {
  it('forwards a rejected handler to next() so the error handler answers 500', async () => {
    const failure = new Error('users.json is corrupt');
    const next = vi.fn();
    asyncRoute(async () => {
      throw failure;
    })({} as Request, {} as Response, next as NextFunction);
    await vi.waitFor(() => expect(next).toHaveBeenCalledWith(failure));
  });

  it('does not call next() for a handler that completes', async () => {
    const next = vi.fn();
    const handler = vi.fn(async (_req: Request, res: Response) => {
      res.json({ ok: true });
    });
    const res = { json: vi.fn() } as unknown as Response;
    asyncRoute(handler)({} as Request, res, next as NextFunction);
    await vi.waitFor(() => expect(res.json).toHaveBeenCalled());
    expect(next).not.toHaveBeenCalled();
  });
});
