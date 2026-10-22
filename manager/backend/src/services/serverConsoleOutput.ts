/**
 * Wait for the game server to print a line in reply to a command.
 *
 * Commands go to the server's stdin and their replies only show up in the
 * container log, so the panel reads recent log lines (with Docker
 * timestamps) and looks for the reply that follows its command. Hytale 0.7
 * prints command feedback in the server's language (English by default);
 * callers therefore always have a fallback (timeout, file checks) and treat
 * a missing reply as "unknown", not as failure.
 */
import { getLogs } from './docker.js';

const LOG_TAIL_LINES = 400;
const CLOCK_SLACK_MS = 250;
// Docker prefixes every line with an RFC 3339 timestamp when asked to.
const TIMESTAMPED_LINE = /(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z)\s(.*)$/;
// eslint-disable-next-line no-control-regex
const ANSI_SEQUENCE = /\x1b\[[0-9;?]*[A-Za-z]/g;

/** Console lines the server printed at or after `sinceMs` (ANSI colours removed). */
export async function consoleLinesSince(sinceMs: number, serverId?: string): Promise<string[]> {
  const raw = await getLogs(LOG_TAIL_LINES, serverId);
  const lines: string[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const m = TIMESTAMPED_LINE.exec(line);
    if (!m) continue;
    // Docker runs on the same host clock; a little slack for rounding only, so
    // the reply to an earlier command is not taken for this one.
    if (Date.parse(m[1]) < sinceMs - CLOCK_SLACK_MS) continue;
    lines.push(m[2].replace(ANSI_SEQUENCE, ''));
  }
  return lines;
}

export type ConsoleWaitResult =
  | { outcome: 'matched'; line: string }
  | { outcome: 'failed'; line: string }
  | { outcome: 'timeout' };

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Poll the console until a line matches `success` or `failure`, or until
 * `timeoutMs` has passed.
 */
export async function waitForConsoleLine(
  sinceMs: number,
  patterns: { success: RegExp[]; failure?: RegExp[] },
  options: { timeoutMs: number; pollMs?: number; serverId?: string },
): Promise<ConsoleWaitResult> {
  const deadline = Date.now() + options.timeoutMs;
  const pollMs = options.pollMs ?? 1000;
  for (;;) {
    const lines = await consoleLinesSince(sinceMs, options.serverId).catch(() => []);
    const failed = lines.find((l) => patterns.failure?.some((re) => re.test(l)));
    if (failed) return { outcome: 'failed', line: failed.trim() };
    const matched = lines.find((l) => patterns.success.some((re) => re.test(l)));
    if (matched) return { outcome: 'matched', line: matched.trim() };
    if (Date.now() >= deadline) return { outcome: 'timeout' };
    await sleep(Math.min(pollMs, Math.max(0, deadline - Date.now())));
  }
}
