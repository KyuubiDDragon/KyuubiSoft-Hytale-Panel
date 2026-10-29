import { describe, it, expect } from 'vitest';
import { EventEmitter } from 'events';
import type { NextFunction, Request, Response } from 'express';
import { bindCommandActor, currentCommandActor } from './commandActor.js';

function inRequest(
  req: Request & { user?: string },
  fn: () => Promise<unknown>,
  res: EventEmitter = new EventEmitter(),
): Promise<unknown> {
  let done: Promise<unknown> = Promise.resolve();
  bindCommandActor(
    req,
    res as unknown as Response,
    (() => {
      done = fn();
    }) as NextFunction,
  );
  return done;
}

describe('commandActor', () => {
  it('is empty outside a request', () => {
    expect(currentCommandActor()).toBeUndefined();
  });

  it('keeps only the user name once the request has closed', async () => {
    const req = { user: 'alice' } as Request & { user?: string };
    const res = new EventEmitter();
    const seen: Array<string | undefined> = [];
    await inRequest(
      req,
      async () => {
        seen.push(currentCommandActor());
        res.emit('close');
        // The request object is no longer read (it may be reused or collected).
        req.user = 'mallory';
        await new Promise((r) => setTimeout(r, 5));
        seen.push(currentCommandActor());
      },
      res,
    );
    expect(seen).toEqual(['alice', 'alice']);
  });

  it('reads the user the auth middleware sets later, across awaits', async () => {
    const req = {} as Request & { user?: string };
    let seen: string | undefined;
    await inRequest(req, async () => {
      req.user = 'alice';
      await new Promise((r) => setTimeout(r, 5));
      seen = currentCommandActor();
    });
    expect(seen).toBe('alice');
  });

  it('keeps concurrent requests apart', async () => {
    const seen: Array<string | undefined> = [];
    const a = { user: 'alice' } as Request & { user?: string };
    const b = { user: 'bob' } as Request & { user?: string };
    await Promise.all([
      inRequest(a, async () => {
        await new Promise((r) => setTimeout(r, 10));
        seen.push(currentCommandActor());
      }),
      inRequest(b, async () => {
        seen.push(currentCommandActor());
      }),
    ]);
    expect(seen.sort()).toEqual(['alice', 'bob']);
  });
});
