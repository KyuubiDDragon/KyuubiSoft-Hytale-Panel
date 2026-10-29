import { describe, it, expect, vi, beforeEach } from 'vitest';

const state = { running: false, busy: false, startsMeanwhile: false };
const withServerStopped = vi.fn(async (_id: unknown, _opts: unknown, fn: () => Promise<unknown>) =>
  fn(),
);
vi.mock('./docker.js', () => ({ getContainerState: async () => ({ running: state.running }) }));
vi.mock('./servers.js', () => ({ resolveServerId: async () => 'default' }));
vi.mock('./serverLifecycle.js', () => ({
  isLifecycleBusy: () => state.busy,
  withServerStopped: (id: unknown, opts: unknown, fn: () => Promise<unknown>) =>
    withServerStopped(id, opts, fn),
  runWhileServerStopped: async (_id: unknown, _opts: unknown, fn: () => Promise<unknown>) =>
    state.startsMeanwhile ? { ran: false } : { ran: true, value: await fn() },
  LifecycleError: class LifecycleError extends Error {},
  LifecycleBusyError: class LifecycleBusyError extends Error {},
}));

const { countdownFrom, writeWhileStopped } = await import('./serverConfigWrite.js');

beforeEach(() => {
  Object.assign(state, { running: false, busy: false, startsMeanwhile: false });
  withServerStopped.mockClear();
});

describe('writeWhileStopped', () => {
  const write = vi.fn(async () => 'done');
  beforeEach(() => write.mockClear());

  it('writes right away while the server is stopped', async () => {
    expect(await writeWhileStopped(undefined, { restart: false }, write)).toEqual({
      kind: 'written',
      restarted: false,
      value: 'done',
    });
    expect(withServerStopped).not.toHaveBeenCalled();
  });

  it('refuses on a running server unless a restart was asked for', async () => {
    state.running = true;
    expect(await writeWhileStopped(undefined, { restart: false }, write)).toEqual({
      kind: 'requires_restart',
    });
    expect(write).not.toHaveBeenCalled();
    const r = await writeWhileStopped(
      undefined,
      { restart: true, actor: 'a', countdownSeconds: 60 },
      write,
    );
    expect(r).toEqual({ kind: 'written', restarted: true, value: 'done' });
    expect(withServerStopped.mock.calls[0][1]).toMatchObject({
      reason: 'config',
      actor: 'a',
      countdownSeconds: 60,
      rejectIfBusy: true,
    });
  });

  it('notices a server that started in the meantime', async () => {
    state.startsMeanwhile = true;
    expect(await writeWhileStopped(undefined, { restart: false }, write)).toEqual({
      kind: 'requires_restart',
    });
    expect(write).not.toHaveBeenCalled();
  });

  it('does nothing while another server operation runs', async () => {
    state.busy = true;
    expect(await writeWhileStopped(undefined, { restart: true }, write)).toEqual({ kind: 'busy' });
    expect(write).not.toHaveBeenCalled();
  });
});

describe('countdownFrom', () => {
  it('takes a positive whole number, capped', () => {
    expect(countdownFrom({ countdownSeconds: 30 })).toBe(30);
    expect(countdownFrom({ countdownSeconds: 99_999 })).toBe(1800);
    expect(countdownFrom({ countdownSeconds: -1 })).toBe(0);
    expect(countdownFrom({ countdownSeconds: '30' })).toBe(0);
    expect(countdownFrom(undefined)).toBe(0);
  });
});
