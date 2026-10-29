/**
 * The shared log stream per server: one Docker stream for all listeners, no
 * stream left behind by fast subscribe/unsubscribe cycles, no lost or repeated
 * lines when the stream is reopened, and the end of the log handed out once
 * before the live entries.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';

class FakeStream extends EventEmitter {
  destroyed = false;
  destroy() {
    this.destroyed = true;
  }
}

interface LogsCall {
  options: Record<string, unknown>;
  stream: FakeStream;
  resolve: () => void;
}

const h = vi.hoisted(() => ({
  logsCalls: [] as LogsCall[],
  // Answer logs() right away unless a test holds it.
  holdLogs: false,
  tailStream: null as FakeStream | null,
}));

vi.mock('./docker.js', () => ({
  getDockerInstance: () => ({
    getContainer: () => ({
      logs: (options: Record<string, unknown>) =>
        new Promise((resolve) => {
          const stream = new FakeStream();
          const call: LogsCall = { options, stream, resolve: () => resolve(stream) };
          h.logsCalls.push(call);
          if (!h.holdLogs) call.resolve();
        }),
      modem: {
        dial: (_opts: unknown, cb: (err: Error | null, stream?: FakeStream) => void) => {
          h.tailStream = new FakeStream();
          cb(null, h.tailStream);
        },
      },
    }),
  }),
}));
vi.mock('./servers.js', () => ({
  getServer: async (id: string) => ({ id, containerName: `hytale-${id}` }),
  resolveServerId: async (id?: string) => id ?? 'default',
}));
vi.mock('./demoData.js', () => ({ isDemoMode: () => false, getNextDemoLogLine: () => '' }));

const logStream = await import('./serverLogStream.js');
const { dockerSince } = await import('./logs.js');

function frame(stream: 1 | 2, payload: string): Buffer {
  const body = Buffer.from(payload, 'utf8');
  const header = Buffer.alloc(8);
  header[0] = stream;
  header.writeUInt32BE(body.length, 4);
  return Buffer.concat([header, body]);
}

const END = '\x1b[m';
const T = (s: number, ns = 0) =>
  `2026-10-28T10:00:${String(s).padStart(2, '0')}.${String(ns).padStart(9, '0')}Z`;
const nsOf = (s: number, ns = 0) =>
  BigInt(Date.parse(`2026-10-28T10:00:${String(s).padStart(2, '0')}Z`)) * 1_000_000n + BigInt(ns);
const line = (s: number, text: string, ns = 0) =>
  `${T(s, ns)} ${END}[2026/10/28 10:00:${String(s).padStart(2, '0')}   INFO] [Test] ${text}${END}\n`;

function recorder() {
  const messages: string[] = [];
  const dropped: number[] = [];
  return {
    messages,
    dropped,
    listener: {
      onEntries: (entries: { entry: { message: string } }[]) =>
        messages.push(...entries.map((e) => e.entry.message)),
      onDropped: (n: number) => dropped.push(n),
    },
  };
}

const settle = () => vi.advanceTimersByTimeAsync(200);

beforeEach(() => {
  vi.useFakeTimers();
  h.logsCalls = [];
  h.holdLogs = false;
  h.tailStream = null;
});

afterEach(() => {
  logStream.stopAllServerLogStreams();
  vi.useRealTimers();
});

describe('shared log stream', () => {
  it('opens one stream for subscribers that arrive together and destroys it when the last leaves', async () => {
    const a = recorder();
    const b = recorder();
    const offA = logStream.subscribeServerLog('s1', a.listener);
    const offB = logStream.subscribeServerLog('s1', b.listener);
    await settle();
    expect(h.logsCalls).toHaveLength(1);
    expect(logStream.activeServerLogStreams()).toBe(1);

    h.logsCalls[0].stream.emit('data', frame(1, line(1, 'hello')));
    await settle();
    expect(a.messages).toEqual(['hello']);
    expect(b.messages).toEqual(['hello']);

    offA();
    expect(h.logsCalls[0].stream.destroyed).toBe(false);
    offB();
    expect(h.logsCalls[0].stream.destroyed).toBe(true);
    expect(logStream.activeServerLogStreams()).toBe(0);
  });

  it('destroys a stream Docker hands over after everyone left, and survives its late error', async () => {
    h.holdLogs = true;
    const off = logStream.subscribeServerLog('s2', recorder().listener);
    await settle();
    off();
    h.logsCalls[0].resolve();
    await settle();
    const late = h.logsCalls[0].stream;
    expect(late.destroyed).toBe(true);
    expect(logStream.activeServerLogStreams()).toBe(0);
    // Without an error listener this would be an uncaught exception.
    expect(() => late.emit('error', new Error('socket hang up'))).not.toThrow();
  });

  it('joins a line split across chunks and frames', async () => {
    const r = recorder();
    logStream.subscribeServerLog('s3', r.listener);
    await settle();
    const buf = Buffer.concat([frame(1, line(1, 'first half and')), frame(1, line(2, 'second'))]);
    for (let i = 0; i < buf.length; i += 7)
      h.logsCalls[0].stream.emit('data', buf.subarray(i, i + 7));
    await settle();
    expect(r.messages).toEqual(['first half and', 'second']);
  });

  it('starts a new stream a little before now, and resumes from the last line of each stream', async () => {
    const r = recorder();
    logStream.subscribeServerLog('s4', r.listener);
    await settle();
    const first = h.logsCalls[0];
    expect(Number(first.options.since)).toBeGreaterThan(Date.now() / 1000 - 5);
    expect(first.options.tail).toBeUndefined();

    // stderr is stamped separately: its line is older than the last stdout line.
    first.stream.emit(
      'data',
      Buffer.concat([frame(2, line(1, 'err one', 5)), frame(1, line(3, 'out one'))]),
    );
    first.stream.emit('end');
    await vi.advanceTimersByTimeAsync(2_100);
    expect(h.logsCalls).toHaveLength(2);
    const second = h.logsCalls[1];
    expect(second.options.since).toBe(dockerSince(nsOf(1, 5)));

    // Docker repeats everything from `since` on.
    second.stream.emit(
      'data',
      Buffer.concat([
        frame(2, line(1, 'err one', 5)),
        frame(2, line(2, 'err two')),
        frame(1, line(3, 'out one')),
        frame(1, line(4, 'out two')),
      ]),
    );
    await settle();
    expect(r.messages).toEqual(['err one', 'out one', 'err two', 'out two']);
  });

  it('keeps two different lines that Docker stamped with the same time', async () => {
    const r = recorder();
    logStream.subscribeServerLog('s8', r.listener);
    await settle();
    h.logsCalls[0].stream.emit(
      'data',
      Buffer.concat([frame(1, line(1, 'one', 7)), frame(1, line(1, 'two', 7))]),
    );
    await settle();
    expect(r.messages).toEqual(['one', 'two']);
  });

  it('drops the oldest entries when a burst exceeds the text budget', async () => {
    const r = recorder();
    logStream.subscribeServerLog('s9', r.listener);
    await settle();
    const big = 'x'.repeat(60_000);
    const lines = Array.from({ length: 150 }, (_, i) => frame(1, line(6, `${i} ${big}`, i + 1)));
    h.logsCalls[0].stream.emit('data', Buffer.concat(lines));
    await settle();
    const kept = r.messages.length;
    expect(r.dropped).toEqual([150 - kept]);
    expect(kept).toBeLessThan(150);
    expect(kept * 60_000).toBeLessThanOrEqual(8 * 1024 * 1024);
    expect(r.messages[kept - 1].startsWith('149 ')).toBe(true);
  });

  it('counts the entries a burst beyond the limit had to drop', async () => {
    const r = recorder();
    logStream.subscribeServerLog('s5', r.listener);
    await settle();
    const lines = Array.from({ length: 5_003 }, (_, i) => frame(1, line(5, `n${i}`, i + 1)));
    h.logsCalls[0].stream.emit('data', Buffer.concat(lines));
    await settle();
    expect(r.dropped).toEqual([3]);
    expect(r.messages).toHaveLength(5_000);
    expect(r.messages[0]).toBe('n3');
  });
});

describe('history subscription', () => {
  it('hands out the end of the log first, then only the live entries after it', async () => {
    const history: string[][] = [];
    const r = recorder();
    logStream.subscribeServerLogWithHistory(
      's6',
      { tail: 100, maxBytes: 100_000, maxEntries: 50 },
      { ...r.listener, onHistory: (entries) => history.push(entries.map((e) => e.entry.message)) },
    );
    await settle();
    // Live lines arrive while the history is still being read; one is in both.
    h.logsCalls[0].stream.emit(
      'data',
      Buffer.concat([frame(1, line(2, 'b')), frame(1, line(3, 'c'))]),
    );
    await settle();
    expect(history).toEqual([]);

    h.tailStream!.emit('data', Buffer.concat([frame(1, line(1, 'a')), frame(1, line(2, 'b'))]));
    h.tailStream!.emit('end');
    await settle();
    expect(history).toEqual([['a', 'b']]);
    expect(r.messages).toEqual(['c']);

    h.logsCalls[0].stream.emit('data', frame(1, line(4, 'd')));
    await settle();
    expect(r.messages).toEqual(['c', 'd']);
  });

  it('keeps only the newest entries of the history', async () => {
    const history: Array<{ messages: string[]; truncated: boolean }> = [];
    logStream.subscribeServerLogWithHistory(
      's7',
      { tail: 100, maxBytes: 100_000, maxEntries: 2 },
      {
        onEntries: () => undefined,
        onHistory: (entries, truncated) =>
          history.push({ messages: entries.map((e) => e.entry.message), truncated }),
      },
    );
    await settle();
    h.tailStream!.emit('data', Buffer.concat([1, 2, 3].map((s) => frame(1, line(s, `m${s}`)))));
    h.tailStream!.emit('end');
    await settle();
    expect(history).toEqual([{ messages: ['m2', 'm3'], truncated: true }]);
  });
});
