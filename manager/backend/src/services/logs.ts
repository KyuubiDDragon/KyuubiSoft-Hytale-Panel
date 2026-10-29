/**
 * Parsing of the game server's console output into log entries.
 *
 * Hytale 0.7 formats every log record as
 *
 *   [yyyy/MM/dd HH:mm:ss LEVEL] <padding>[Logger] message
 *
 * with the time in UTC and the level right-aligned to six characters (WARNING
 * is printed as WARN, SEVERE goes to stderr). A record with a throwable carries
 * the stack trace on the following lines, and console answers to commands are
 * printed as raw records without that prefix. Unless the console is "dumb" the
 * formatter adds ANSI colours and ends every record, however many lines it
 * has, with ESC[m; that marker is what keeps multi-line records together here.
 * Without it (server log files) a stack-trace heuristic is used instead.
 *
 * Docker adds its own receive time (`timestamps: true`, RFC 3339 with
 * nanoseconds, UTC) to every line; it is the entry's time and also serves as a
 * cursor to resume a stream without duplicates.
 */
import type { LogEntry } from '../types/index.js';
import type { DockerLine, DockerStreamName } from './dockerStream.js';

export type LogLevel = 'DEBUG' | 'INFO' | 'WARN' | 'ERROR';

const DOCKER_TIMESTAMP = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?Z ?/;
const HYTALE_PREFIX =
  /^\[(\d{4})\/(\d{2})\/(\d{2}) (\d{2}):(\d{2}):(\d{2}) +([A-Z]{1,6})\] *(?:\[([^\]\n]{1,80})\] ?)?/;
// Lines of the start scripts: "[INFO] …" or "[2026-10-27 22:12:04] [WARN] …".
const SCRIPT_TAG =
  /^(?:\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\] )?\[(INFO|OK|WARN|WARNING|ERROR|DEBUG)\] /;
// The formatter's end-of-record marker (ESC[m), checked before colours are stripped.
// eslint-disable-next-line no-control-regex
const RECORD_END = /\x1b\[m$/;
// The level colour the formatter puts in front of a formatted record (ESC[m for INFO).
// eslint-disable-next-line no-control-regex
const LEADING_COLOUR = /^\x1b\[[0-9;]*m/;
// eslint-disable-next-line no-control-regex
const ANSI_SEQUENCE = /\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)|[@-Z\\-_])/g;
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\x00-\x08\x0b-\x1f\x7f]/g;
// Continuation lines of a stack trace when there are no record markers.
const STACK_LINE = /^(?:\s|Caused by: |\.\.\. \d+ more)/;
const EXCEPTION_HEADER = /^(?:[A-Za-z_$][\w$]*\.)+[A-Z][\w$]*(?:Exception|Error|Throwable)\b/;
// dockerode sends its attach options as the request body, which Docker passes
// to the server console; the server answers it with "Command not found! …".
// That line is the panel's own artifact, not server output.
const ATTACH_BODY_ECHO = '{"stream":true,"stdin":true,"stdout":false,"stderr":false,"hijack":true}';

/** Lines of one record arrive within microseconds; anything later is a new record. */
const CONTINUATION_WINDOW_NS = 50_000_000n;
export const MAX_ENTRY_LINES = 400;
export const MAX_ENTRY_CHARS = 64 * 1024;

const LEVELS: Record<string, LogLevel> = {
  SEVERE: 'ERROR',
  ERROR: 'ERROR',
  WARN: 'WARN',
  WARNIN: 'WARN',
  WARNING: 'WARN',
  INFO: 'INFO',
  OK: 'INFO',
  CONFIG: 'DEBUG',
  FINE: 'DEBUG',
  FINER: 'DEBUG',
  FINEST: 'DEBUG',
  ALL: 'DEBUG',
  DEBUG: 'DEBUG',
};

/** Docker's receive time of a line: Unix time in nanoseconds plus its ISO form. */
export interface DockerTime {
  ns: bigint;
  iso: string;
}

export function parseDockerTimestamp(line: string): { time: DockerTime | null; rest: string } {
  const m = DOCKER_TIMESTAMP.exec(line);
  if (!m) return { time: null, rest: line };
  const [, y, mo, d, h, mi, s, frac = ''] = m;
  const ms = Date.UTC(+y, +mo - 1, +d, +h, +mi, +s);
  if (!Number.isFinite(ms)) return { time: null, rest: line };
  const nanos = frac.padEnd(9, '0');
  return {
    time: {
      ns: BigInt(ms) * 1_000_000n + BigInt(nanos),
      iso: `${y}-${mo}-${d}T${h}:${mi}:${s}.${nanos.slice(0, 3)}Z`,
    },
    rest: line.slice(m[0].length),
  };
}

/** Docker's `since` value (Unix seconds with nanoseconds) for a receive time. */
export function dockerSince(ns: bigint): string {
  const seconds = ns / 1_000_000_000n;
  const nanos = ns % 1_000_000_000n;
  return `${seconds}.${nanos.toString().padStart(9, '0')}`;
}

/** Colours, cursor movement and other control characters removed. */
export function cleanConsoleText(text: string): string {
  let clean = text.replace(ANSI_SEQUENCE, '');
  // A carriage return redraws the line; what follows the last one is what shows.
  const cr = clean.lastIndexOf('\r');
  if (cr >= 0) clean = clean.slice(cr + 1);
  return clean.replace(CONTROL_CHARS, '');
}

interface LineHead {
  level: LogLevel;
  logger?: string;
  /** UTC time of a formatted record, ISO with zone. */
  time?: string;
  message: string;
  formatted: boolean;
  scriptTag: boolean;
}

function readLineHead(plain: string, stream: DockerStreamName): LineHead {
  const m = HYTALE_PREFIX.exec(plain);
  if (m) {
    const [prefix, y, mo, d, h, mi, s, level, logger] = m;
    return {
      level: LEVELS[level] ?? 'INFO',
      logger,
      time: `${y}-${mo}-${d}T${h}:${mi}:${s}.000Z`,
      message: plain.slice(prefix.length),
      formatted: true,
      scriptTag: false,
    };
  }
  const tag = SCRIPT_TAG.exec(plain);
  if (tag) {
    return { level: LEVELS[tag[1]], message: plain, formatted: false, scriptTag: true };
  }
  // Unformatted stderr comes from the JVM or a crash before the logger is up.
  return {
    level: stream === 'stderr' ? 'WARN' : 'INFO',
    message: plain,
    formatted: false,
    scriptTag: false,
  };
}

/**
 * Whether the first line of a record is exactly what the formatter writes:
 * on a stream with record markers a formatted record starts with its level
 * colour, then the text, then the end marker; without markers it is the bare
 * text. Anything else cleaning had to remove (a carriage return, another
 * escape sequence, a control character) means the line shows something other
 * than what was logged, so its start is not where it seems to be.
 *
 * This narrows what logged text can forge, it does not rule it out: text that
 * brings its own line break, end marker and level colour in front of a
 * complete record line produces exactly the formatter's bytes.
 */
function isExactLine(
  rest: string,
  plain: string,
  head: LineHead,
  ends: boolean,
  markers: boolean,
): boolean {
  let body = rest;
  if (markers && head.formatted) {
    const colour = LEADING_COLOUR.exec(body);
    if (!colour) return false;
    body = body.slice(colour[0].length);
  }
  if (ends) body = body.replace(RECORD_END, '');
  return body.replace(/\s+$/, '') === plain;
}

/** A log entry with the position it came from, for de-duplication. */
export interface AssembledLogEntry {
  entry: LogEntry;
  /** Docker receive time of the record's last line, when known. */
  cursor: bigint | null;
  stream: DockerStreamName;
  /**
   * False when the record did not start and end where the console's record
   * markers say records do: a line inside another record's message that only
   * looks like a record of its own (logged text with a line break in it), or
   * the first record of a stream or tail, which may have begun before it.
   * Also false when its first line is not exactly what the formatter writes
   * (see isExactLine): a carriage return or an escape sequence in logged text
   * can make a line look like it starts somewhere else.
   * Without markers (log files) line breaks cannot be told apart, so only
   * that last check applies there.
   */
  clean: boolean;
}

interface OpenRecord {
  head: LineHead;
  lines: string[];
  chars: number;
  firstTime: DockerTime | null;
  lastNs: bigint | null;
  stream: DockerStreamName;
  /** The stream ends its records with a marker, so this one should end with it too. */
  expectsMarker: boolean;
  /** The record before it ended with its marker. */
  atBoundary: boolean;
  /** Its first line is exactly what the formatter writes (isExactLine). */
  exact: boolean;
}

/**
 * Joins console lines into log entries. Lines are pushed as they arrive;
 * complete entries come back. An entry still waiting for its end marker is
 * returned by flush(), which a live stream calls once the output pauses.
 */
export class LogAssembler {
  private readonly open: Record<DockerStreamName, OpenRecord | null> = {
    stdout: null,
    stderr: null,
  };
  private readonly markers: Record<DockerStreamName, boolean> = { stdout: false, stderr: false };
  // Whether the next record starts where one ended. Unknown at first: a tail
  // or a stream may begin in the middle of a record.
  private readonly boundary: Record<DockerStreamName, boolean> = { stdout: false, stderr: false };
  private lastTimestamp: string | null = null;

  push(line: DockerLine): AssembledLogEntry[] {
    const done: AssembledLogEntry[] = [];
    const { time, rest } = parseDockerTimestamp(line.text);
    const ends = RECORD_END.test(rest);
    if (ends) this.markers[line.stream] = true;
    const plain = cleanConsoleText(rest).replace(/\s+$/, '');

    const open = this.open[line.stream];
    if (open && this.continues(open, plain, time)) {
      open.lines.push(plain);
      open.chars += plain.length + 1;
      open.lastNs = time?.ns ?? open.lastNs;
      if (ends) this.close(line.stream, done, true);
      return done;
    }
    this.close(line.stream, done);

    if (!plain || plain.includes(ATTACH_BODY_ECHO)) return done;
    const head = readLineHead(plain, line.stream);
    this.open[line.stream] = {
      head,
      lines: [head.message],
      chars: head.message.length,
      firstTime: time,
      lastNs: time?.ns ?? null,
      stream: line.stream,
      expectsMarker: this.markers[line.stream],
      atBoundary: this.boundary[line.stream],
      exact: isExactLine(rest, plain, head, ends, this.markers[line.stream]),
    };
    if (ends) this.close(line.stream, done, true);
    return done;
  }

  /** Entries still open (the output paused, or the stream ended). */
  flush(): AssembledLogEntry[] {
    const done: AssembledLogEntry[] = [];
    this.close('stdout', done);
    this.close('stderr', done);
    return done;
  }

  /** Whether an entry is waiting for more lines. */
  hasOpen(): boolean {
    return this.open.stdout !== null || this.open.stderr !== null;
  }

  private continues(open: OpenRecord, plain: string, time: DockerTime | null): boolean {
    if (HYTALE_PREFIX.test(plain) || SCRIPT_TAG.test(plain)) return false;
    if (open.lines.length >= MAX_ENTRY_LINES || open.chars + plain.length > MAX_ENTRY_CHARS) {
      return false;
    }
    if (time && open.lastNs !== null && time.ns - open.lastNs > CONTINUATION_WINDOW_NS) {
      return false;
    }
    // With record markers the open record runs until its marker.
    if (this.markers[open.stream]) return true;
    if (STACK_LINE.test(plain)) return true;
    return open.head.formatted && open.lines.length === 1 && EXCEPTION_HEADER.test(plain);
  }

  private close(stream: DockerStreamName, into: AssembledLogEntry[], byMarker = false): void {
    const open = this.open[stream];
    if (!open) return;
    this.open[stream] = null;
    while (open.lines.length > 1 && open.lines[open.lines.length - 1] === '') open.lines.pop();
    // A raw record in a log file has no time of its own; it follows the one before.
    const timestamp =
      open.firstTime?.iso ?? open.head.time ?? this.lastTimestamp ?? new Date().toISOString();
    this.lastTimestamp = timestamp;
    const entry: LogEntry = { timestamp, level: open.head.level, message: open.lines.join('\n') };
    if (open.head.logger) entry.logger = open.head.logger;
    const clean = open.exact && (!open.expectsMarker || (open.atBoundary && byMarker));
    // On a stream with markers a record only ends at its marker; one cut off
    // otherwise leaves the next one's start in doubt.
    this.boundary[stream] = byMarker || !this.markers[stream];
    into.push({ entry, cursor: open.lastNs, stream, clean });
  }
}

/** Entries of complete output (a log tail or a file), in order. */
export function assembleLogLines(lines: DockerLine[]): AssembledLogEntry[] {
  const assembler = new LogAssembler();
  const entries: AssembledLogEntry[] = [];
  for (const line of lines) entries.push(...assembler.push(line));
  entries.push(...assembler.flush());
  return entries;
}

/** Entries of plain log text (one stream), e.g. a server log file. */
export function parseLogs(rawLogs: string): LogEntry[] {
  const lines = rawLogs.split('\n').map((text) => ({ stream: 'stdout' as const, text }));
  return assembleLogLines(lines).map((e) => e.entry);
}
