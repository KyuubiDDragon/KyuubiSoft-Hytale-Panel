/**
 * Live console output of each game server, shared by every consumer.
 *
 * One Docker log stream per server, opened while anyone listens: the console
 * WebSockets and the log-based join/leave detection (services/playerPresence.ts).
 * Lines are joined into entries (services/logs.ts) and handed out in batches.
 *
 * - The stream is (re)opened with `since` = the last line seen, so a container
 *   restart or a Docker hiccup loses nothing and repeats nothing. Docker stamps
 *   stdout and stderr in two places, so their times are only in order within
 *   one stream; each stream keeps its own cursor.
 * - Every (re)start bumps a generation counter. A Docker call that returns
 *   after the tap was stopped or restarted destroys its stream instead of
 *   installing it, so fast connect/disconnect cycles cannot leak streams.
 * - Streams are destroyed, not just detached, and keep an error listener, so a
 *   late error on an abandoned stream cannot crash the process.
 * - subscribeServerLogWithHistory() hands out the end of the log first and
 *   then the live entries after it, without a gap and without repeats.
 */
import { getDockerInstance } from './docker.js';
import {
  createDockerLineDecoder,
  type DockerLine,
  type DockerLineDecoder,
  type DockerStreamName,
} from './dockerStream.js';
import {
  LogAssembler,
  assembleLogLines,
  dockerSince,
  parseDockerTimestamp,
  parseLogs,
  type AssembledLogEntry,
} from './logs.js';
import { getServer, resolveServerId } from './servers.js';
import { isDemoMode, getNextDemoLogLine } from './demoData.js';

export interface ServerLogListener {
  /** New entries, oldest first. The array is shared between listeners. */
  onEntries(entries: AssembledLogEntry[]): void;
  /** Entries this tap had to drop (a burst faster than the listeners). */
  onDropped?(count: number): void;
  /** The Docker stream failed; it is retried. */
  onError?(message: string): void;
}

// Entries are handed out at most this often, in one batch per listener.
const TICK_MS = 50;
// A record still waiting for its end marker is passed on after this pause.
const IDLE_FLUSH_MS = 120;
// Entries (and their text) waiting for the next tick; a burst beyond this is
// dropped, oldest first, and counted.
const MAX_PENDING_ENTRIES = 5_000;
const MAX_PENDING_CHARS = 8 * 1024 * 1024;
const RETRY_INITIAL_MS = 2_000;
const RETRY_MAX_MS = 10_000;
// A new tap starts this far back, so the clocks of Docker and the panel may
// differ a little without losing the lines written while it opens. The
// history subscription drops what it already handed out.
const FRESH_START_LOOKBACK_MS = 2_000;

type LogStream = NodeJS.ReadableStream & { destroy?: (error?: Error) => void };
type Cursors = Record<DockerStreamName, bigint | null>;

/** Entries waiting to be handed out, within MAX_PENDING_ENTRIES and MAX_PENDING_CHARS. */
class EntryBuffer {
  private entries: AssembledLogEntry[] = [];
  private chars = 0;
  private dropped = 0;

  push(entry: AssembledLogEntry): void {
    this.entries.push(entry);
    this.chars += entry.entry.message.length;
    while (
      this.entries.length > MAX_PENDING_ENTRIES ||
      (this.chars > MAX_PENDING_CHARS && this.entries.length > 1)
    ) {
      this.chars -= this.entries.shift()!.entry.message.length;
      this.dropped++;
    }
  }

  addDropped(count: number): void {
    this.dropped += count;
  }

  isEmpty(): boolean {
    return this.entries.length === 0 && this.dropped === 0;
  }

  /** Everything waiting, and how many were dropped since the last take. */
  take(): { entries: AssembledLogEntry[]; dropped: number } {
    const taken = { entries: this.entries, dropped: this.dropped };
    this.entries = [];
    this.chars = 0;
    this.dropped = 0;
    return taken;
  }
}

interface Tap {
  serverId: string;
  listeners: Set<ServerLogListener>;
  generation: number;
  stream: LogStream | null;
  decoder: DockerLineDecoder | null;
  assembler: LogAssembler;
  /** Docker receive time of the last line read per stream, to resume without duplicates. */
  lastNs: Cursors;
  /** After a resume: lines up to these times are repeats of lines already read. */
  replayUntil: Cursors;
  /** Where a tap without any line read yet starts. */
  startNs: bigint;
  lastDataAt: number;
  pending: EntryBuffer;
  tickTimer: NodeJS.Timeout | null;
  retryTimer: NodeJS.Timeout | null;
  retryDelayMs: number;
  demoTimer: NodeJS.Timeout | null;
  lastError: string | null;
}

const taps = new Map<string, Tap>();

const nowNs = () => BigInt(Date.now()) * 1_000_000n;

function newTap(serverId: string): Tap {
  return {
    serverId,
    listeners: new Set(),
    generation: 0,
    stream: null,
    decoder: null,
    assembler: new LogAssembler(),
    lastNs: { stdout: null, stderr: null },
    replayUntil: { stdout: null, stderr: null },
    startNs: nowNs() - BigInt(FRESH_START_LOOKBACK_MS) * 1_000_000n,
    lastDataAt: 0,
    pending: new EntryBuffer(),
    tickTimer: null,
    retryTimer: null,
    retryDelayMs: RETRY_INITIAL_MS,
    demoTimer: null,
    lastError: null,
  };
}

/**
 * Listen to a server's console output from now on. The first listener opens
 * the stream, the last one to leave closes it. Returns the unsubscribe
 * function. `serverId` is a registry id (see resolveServerId).
 */
export function subscribeServerLog(serverId: string, listener: ServerLogListener): () => void {
  let tap = taps.get(serverId);
  if (!tap) {
    tap = newTap(serverId);
    taps.set(serverId, tap);
  }
  tap.listeners.add(listener);
  // Decided synchronously: two subscribers arriving together start one stream.
  if (tap.listeners.size === 1) startTap(tap);
  const own = tap;
  let subscribed = true;
  return () => {
    if (!subscribed) return;
    subscribed = false;
    own.listeners.delete(listener);
    if (own.listeners.size === 0) stopTap(own);
  };
}

export interface LogHistoryOptions {
  /** Lines read from the end of the container log. */
  tail: number;
  /** Text kept at most from those lines. */
  maxBytes: number;
  /** Entries handed out at most (the newest). */
  maxEntries: number;
}

export interface ServerLogHistoryListener extends ServerLogListener {
  /**
   * The end of the log, once, before any live entry. `truncated` when older
   * entries were left out to stay within the limits.
   */
  onHistory(entries: AssembledLogEntry[], truncated: boolean): void;
}

/**
 * subscribeServerLog with the end of the log first. Live entries that arrive
 * while the history is read are held back and handed out after it, minus
 * those the history already contained.
 */
export function subscribeServerLogWithHistory(
  serverId: string,
  history: LogHistoryOptions,
  listener: ServerLogHistoryListener,
): () => void {
  let live = false;
  let closed = false;
  let held = new EntryBuffer();
  const unsubscribe = subscribeServerLog(serverId, {
    onEntries(entries) {
      if (live) {
        listener.onEntries(entries);
        return;
      }
      for (const entry of entries) held.push(entry);
    },
    onDropped(count) {
      if (live) listener.onDropped?.(count);
      else held.addDropped(count);
    },
    onError: (message) => listener.onError?.(message),
  });

  void readHistory(serverId, history).then(({ entries, truncated }) => {
    if (closed) return;
    const seen: Cursors = { stdout: null, stderr: null };
    for (const e of entries) {
      if (e.cursor !== null && (seen[e.stream] === null || e.cursor > seen[e.stream]!)) {
        seen[e.stream] = e.cursor;
      }
    }
    const waiting = held.take();
    const fresh = waiting.entries.filter((e) => {
      const last = seen[e.stream];
      return e.cursor === null || last === null || e.cursor > last;
    });
    const dropped = waiting.dropped;
    live = true;
    try {
      listener.onHistory(entries, truncated);
      if (dropped > 0) listener.onDropped?.(dropped);
      if (fresh.length > 0) listener.onEntries(fresh);
    } catch (err) {
      console.error(`[ServerLog:${serverId}] history listener failed:`, err);
    }
  });

  return () => {
    closed = true;
    held = new EntryBuffer();
    unsubscribe();
  };
}

async function readHistory(
  serverId: string,
  { tail, maxBytes, maxEntries }: LogHistoryOptions,
): Promise<{ entries: AssembledLogEntry[]; truncated: boolean }> {
  if (tail <= 0 || maxEntries <= 0) return { entries: [], truncated: false };
  try {
    const read = await readServerLogTail(serverId, { tail, maxBytes });
    const all = assembleLogLines(read.lines);
    const entries = all.length > maxEntries ? all.slice(-maxEntries) : all;
    return { entries, truncated: read.truncated || all.length > maxEntries };
  } catch (err) {
    console.error(`[ServerLog:${serverId}] reading the log history failed: ${describe(err)}`);
    return { entries: [], truncated: false };
  }
}

/** Close every stream (panel shutdown). */
export function stopAllServerLogStreams(): void {
  for (const tap of [...taps.values()]) {
    tap.listeners.clear();
    stopTap(tap);
  }
}

/** Open Docker log streams, for the health of the shared taps (tests). */
export function activeServerLogStreams(): number {
  let open = 0;
  for (const tap of taps.values()) if (tap.stream) open++;
  return open;
}

function startTap(tap: Tap): void {
  const generation = ++tap.generation;
  if (isDemoMode()) {
    startDemo(tap);
    return;
  }
  void openStream(tap, generation).catch((err) => {
    if (generation === tap.generation) scheduleRetry(tap, describe(err));
  });
}

function stopTap(tap: Tap): void {
  tap.generation++;
  clearTimer(tap, 'tickTimer');
  clearTimer(tap, 'retryTimer');
  if (tap.demoTimer) {
    clearInterval(tap.demoTimer);
    tap.demoTimer = null;
  }
  closeStream(tap);
  // A later subscriber starts fresh; replaying from an old cursor could flood it.
  if (taps.get(tap.serverId) === tap) taps.delete(tap.serverId);
}

/** Where to resume: the older of the two stream cursors, or the tap's start. */
function resumeFrom(tap: Tap): bigint {
  const { stdout, stderr } = tap.lastNs;
  if (stdout !== null && stderr !== null) return stdout < stderr ? stdout : stderr;
  return stdout ?? stderr ?? tap.startNs;
}

async function openStream(tap: Tap, generation: number): Promise<void> {
  const server = await getServer(tap.serverId);
  if (generation !== tap.generation) return;
  if (!server?.containerName) {
    scheduleRetry(tap, 'Unknown container for this server');
    return;
  }
  const container = getDockerInstance().getContainer(server.containerName);
  const stream = (await container.logs({
    follow: true,
    stdout: true,
    stderr: true,
    timestamps: true,
    since: dockerSince(resumeFrom(tap)),
  })) as LogStream;
  if (generation !== tap.generation) {
    // Stopped or restarted while Docker answered: this stream is nobody's.
    destroyStream(stream);
    return;
  }
  tap.stream = stream;
  tap.decoder = createDockerLineDecoder();
  tap.replayUntil = { ...tap.lastNs };

  stream.on('data', (chunk: Buffer) => {
    if (generation !== tap.generation || !tap.decoder) return;
    tap.retryDelayMs = RETRY_INITIAL_MS;
    tap.lastError = null;
    readLines(tap, tap.decoder.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
  });
  const gone = (error?: Error) => {
    if (generation !== tap.generation) return;
    closeStream(tap);
    // `follow` ends right away for a stopped container; it is retried quietly.
    scheduleRetry(tap, error ? describe(error) : null);
  };
  stream.on('error', gone);
  stream.on('end', () => gone());
  stream.on('close', () => gone());
}

function readLines(tap: Tap, lines: DockerLine[]): void {
  if (lines.length === 0) return;
  tap.lastDataAt = Date.now();
  for (const line of lines) {
    const time = parseDockerTimestamp(line.text).time;
    if (time) {
      // After a resume Docker repeats lines from `since` on; skip what was
      // read. Only until the first new line: two lines may share a time.
      const until = tap.replayUntil[line.stream];
      if (until !== null) {
        if (time.ns <= until) continue;
        tap.replayUntil[line.stream] = null;
      }
      const last = tap.lastNs[line.stream];
      if (last === null || time.ns > last) tap.lastNs[line.stream] = time.ns;
    }
    queue(tap, tap.assembler.push(line));
  }
  scheduleTick(tap);
}

function queue(tap: Tap, entries: AssembledLogEntry[]): void {
  for (const entry of entries) tap.pending.push(entry);
}

function scheduleTick(tap: Tap): void {
  if (tap.tickTimer) return;
  tap.tickTimer = setTimeout(() => {
    tap.tickTimer = null;
    tick(tap);
  }, TICK_MS);
}

function tick(tap: Tap): void {
  if (tap.assembler.hasOpen() && Date.now() - tap.lastDataAt >= IDLE_FLUSH_MS) {
    queue(tap, tap.assembler.flush());
  }
  deliver(tap);
  if (tap.assembler.hasOpen()) scheduleTick(tap);
}

function deliver(tap: Tap): void {
  const { entries, dropped } = tap.pending.take();
  for (const listener of [...tap.listeners]) {
    try {
      if (dropped > 0) listener.onDropped?.(dropped);
      if (entries.length > 0) listener.onEntries(entries);
    } catch (err) {
      console.error(`[ServerLog:${tap.serverId}] listener failed:`, err);
    }
  }
}

function closeStream(tap: Tap): void {
  if (tap.decoder) {
    const rest = tap.decoder.end();
    tap.decoder = null;
    readLines(tap, rest);
  }
  if (tap.assembler.hasOpen()) queue(tap, tap.assembler.flush());
  if (!tap.pending.isEmpty()) deliver(tap);
  clearTimer(tap, 'tickTimer');
  if (tap.stream) {
    destroyStream(tap.stream);
    tap.stream = null;
  }
}

function destroyStream(stream: LogStream): void {
  stream.removeAllListeners('data');
  stream.removeAllListeners('end');
  stream.removeAllListeners('close');
  stream.removeAllListeners('error');
  // Kept for good: a destroyed socket may still report an error later.
  stream.on('error', () => {});
  try {
    stream.destroy?.();
  } catch {
    // already gone
  }
}

function scheduleRetry(tap: Tap, error: string | null): void {
  if (tap.listeners.size === 0 || tap.retryTimer) return;
  if (error && error !== tap.lastError) {
    tap.lastError = error;
    console.error(`[ServerLog:${tap.serverId}] log stream failed: ${error}`);
    for (const listener of [...tap.listeners]) {
      try {
        listener.onError?.(error);
      } catch {
        // a listener's problem is not the stream's
      }
    }
  }
  const delay = tap.retryDelayMs;
  tap.retryDelayMs = Math.min(tap.retryDelayMs * 2, RETRY_MAX_MS);
  const generation = tap.generation;
  tap.retryTimer = setTimeout(() => {
    tap.retryTimer = null;
    if (generation !== tap.generation || tap.listeners.size === 0) return;
    startTap(tap);
  }, delay);
}

function clearTimer(tap: Tap, key: 'tickTimer' | 'retryTimer'): void {
  const timer = tap[key];
  if (timer) clearTimeout(timer);
  tap[key] = null;
}

function startDemo(tap: Tap): void {
  if (tap.demoTimer) clearInterval(tap.demoTimer);
  tap.demoTimer = setInterval(
    () => {
      queue(
        tap,
        parseLogs(getNextDemoLogLine()).map((entry) => ({
          entry,
          cursor: null,
          stream: 'stdout' as const,
          clean: true,
        })),
      );
      deliver(tap);
    },
    3000 + Math.random() * 5000,
  );
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// ---- One-shot reads (history for the console, "load all") ----

// A one-shot read that has not ended by then returns what it has.
const TAIL_READ_TIMEOUT_MS = 15_000;

export interface LogTailOptions {
  /** Lines from the end of the container log. */
  tail: number;
  /** Text kept at most; older lines beyond it are dropped. */
  maxBytes: number;
}

export interface LogTail {
  lines: DockerLine[];
  /** Older lines were dropped to stay within `maxBytes`, or the read timed out. */
  truncated: boolean;
}

/**
 * The last `tail` lines of a server's container log. Read as a stream that
 * keeps only the newest `maxBytes` of text, so a log with huge lines cannot
 * be loaded into memory at once.
 */
export async function readServerLogTail(
  serverId: string | undefined,
  { tail, maxBytes }: LogTailOptions,
): Promise<LogTail> {
  if (isDemoMode()) return { lines: [], truncated: false };
  const server = await getServer(await resolveServerId(serverId));
  if (!server?.containerName) return { lines: [], truncated: false };
  const stream = await openLogRead(server.containerName, tail);
  const decoder = createDockerLineDecoder();
  const lines: DockerLine[] = [];
  let kept = 0;
  let truncated = false;
  const keep = (more: DockerLine[]) => {
    for (const line of more) {
      lines.push(line);
      kept += Buffer.byteLength(line.text);
    }
    while (kept > maxBytes && lines.length > 1) {
      kept -= Buffer.byteLength(lines.shift()!.text);
      truncated = true;
    }
  };
  return new Promise<LogTail>((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error, timedOut = false) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      destroyStream(stream);
      if (error) {
        reject(error);
        return;
      }
      if (!timedOut) keep(decoder.end());
      resolve({ lines, truncated: truncated || timedOut });
    };
    const timer = setTimeout(() => finish(undefined, true), TAIL_READ_TIMEOUT_MS);
    stream.on('data', (chunk: Buffer) => {
      keep(decoder.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    });
    stream.on('end', () => finish());
    stream.on('close', () => finish());
    stream.on('error', (err: Error) => finish(err));
  });
}

interface DockerModem {
  dial(
    options: Record<string, unknown>,
    callback: (error: Error | null, stream?: LogStream) => void,
  ): void;
}

/**
 * A non-following log read as a stream. dockerode's `logs()` buffers the
 * whole answer unless it follows, and a following stream never ends on a
 * quiet server, so the request goes through the modem directly.
 */
function openLogRead(containerName: string, tail: number): Promise<LogStream> {
  const container = getDockerInstance().getContainer(containerName);
  const modem = (container as unknown as { modem: DockerModem }).modem;
  return new Promise((resolve, reject) => {
    modem.dial(
      {
        path: `/containers/${encodeURIComponent(containerName)}/logs?`,
        method: 'GET',
        isStream: true,
        statusCodes: { 200: true, 404: 'no such container', 500: 'server error' },
        options: { stdout: true, stderr: true, timestamps: true, tail },
      },
      (error, stream) => {
        if (error || !stream) reject(error ?? new Error('No log stream'));
        else resolve(stream);
      },
    );
  });
}
