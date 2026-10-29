/**
 * Parsing of the game server's console output (Hytale 0.7). The lines below
 * have the exact shape of a server in a container without a TTY, where the
 * console is "dumb-color": ANSI colours, and every record (however many lines
 * it has) ends with ESC[m. Docker puts its own receive time in front.
 */
import { describe, it, expect } from 'vitest';
import {
  LogAssembler,
  assembleLogLines,
  cleanConsoleText,
  dockerSince,
  parseDockerTimestamp,
  parseLogs,
  type AssembledLogEntry,
} from './logs.js';
import type { DockerLine } from './dockerStream.js';

const ESC = '\x1b';
const END = `${ESC}[m`;

const out = (text: string): DockerLine => ({ stream: 'stdout', text });
const err = (text: string): DockerLine => ({ stream: 'stderr', text });

function assemble(lines: DockerLine[]): AssembledLogEntry[] {
  return assembleLogLines(lines);
}

describe('Docker receive time', () => {
  it('becomes an ISO time in UTC and a nanosecond cursor', () => {
    const { time, rest } = parseDockerTimestamp('2026-10-27T21:12:33.337568013Z hello');
    expect(time?.iso).toBe('2026-10-27T21:12:33.337Z');
    expect(time?.ns).toBe(1_793_135_553_337_568_013n);
    expect(rest).toBe('hello');
  });

  it('gives Docker its since value back without losing nanoseconds', () => {
    expect(dockerSince(1_793_135_553_000_000_042n)).toBe('1793135553.000000042');
  });

  it('leaves a line without receive time alone', () => {
    expect(parseDockerTimestamp('[INFO] no time')).toEqual({ time: null, rest: '[INFO] no time' });
  });
});

describe('0.7 log records', () => {
  it('splits time, level and logger off a formatted record', () => {
    const [e] = assemble([
      out(
        `2026-10-27T21:12:06.762314807Z ${END}[2026/10/27 21:12:06   INFO]           [HytaleServer] Starting HytaleServer${END}`,
      ),
    ]);
    expect(e.entry).toEqual({
      timestamp: '2026-10-27T21:12:06.762Z',
      level: 'INFO',
      logger: 'HytaleServer',
      message: 'Starting HytaleServer',
    });
    expect(e.cursor).toBe(1_793_135_526_762_314_807n);
    // The first record of a stream may have begun before it.
    expect(e.clean).toBe(false);
  });

  it('maps the server levels, SEVERE on stderr included', () => {
    const levels = assemble([
      err(
        `2026-10-27T21:12:16.262456612Z ${ESC}[31m[2026/10/27 21:12:16 SEVERE]                          [SERR] Reallocate: 131072 to 1179648${END}`,
      ),
      out(
        `2026-10-27T21:12:17.000000000Z ${ESC}[33m[2026/10/27 21:12:17   WARN] [AssetModule|P] Old pack${END}`,
      ),
      out(
        `2026-10-27T21:12:17.100000000Z ${ESC}[36m[2026/10/27 21:12:17 FINEST] [LoginTiming] Took 2ms${END}`,
      ),
      out(
        `2026-10-27T21:12:17.200000000Z ${ESC}[32m[2026/10/27 21:12:17 CONFIG] [Config] Loaded${END}`,
      ),
    ]).map((e) => [e.stream, e.entry.level, e.entry.logger]);
    expect(levels).toEqual([
      ['stderr', 'ERROR', 'SERR'],
      ['stdout', 'WARN', 'AssetModule|P'],
      ['stdout', 'DEBUG', 'LoginTiming'],
      ['stdout', 'DEBUG', 'Config'],
    ]);
  });

  it('keeps a record together until its end marker', () => {
    const entries = assemble([
      out(
        `2026-10-27T21:12:33.337568013Z ${END}[2026/10/27 21:12:33   INFO]                [HytaleGenerator] Concurrency report:`,
      ),
      out('2026-10-27T21:12:33.337579324Z \tLow Priority: 3 / 8 threads'),
      out('2026-10-27T21:12:33.337583594Z \tNormal Priority: 5 / 8 threads'),
      out(`2026-10-27T21:12:33.337586844Z \tHigh Priority: 7 / 8 threads${END}`),
      out(
        `2026-10-27T21:12:33.339018367Z ${END}[2026/10/27 21:12:33   INFO]                  [PluginManager] Enabled plugin Hytale:HytaleGenerator${END}`,
      ),
    ]);
    expect(entries).toHaveLength(2);
    expect(entries[0].entry.message).toBe(
      'Concurrency report:\n\tLow Priority: 3 / 8 threads\n\tNormal Priority: 5 / 8 threads\n\tHigh Priority: 7 / 8 threads',
    );
    expect(entries[0].cursor).toBe(1_793_135_553_337_586_844n);
    expect(entries[1].entry.logger).toBe('PluginManager');
  });

  it('keeps a raw multi-line command answer together', () => {
    const entries = assemble([
      out(
        `2026-10-27T21:15:40.964710045Z ${END}[2026/10/27 21:15:40   INFO]                 [CommandManager] Console executed command: server stats memory${END}`,
      ),
      out('2026-10-27T21:15:40.983508629Z Total Physical Memory: 7.8 GiB'),
      out('2026-10-27T21:15:40.983559562Z Free Physical Memory: 4.8 GiB'),
      out(`2026-10-27T21:15:40.983572413Z Free Swap Memory: 2.0 GiB${END}`),
      out(`2026-10-27T21:15:40.987979498Z ${ESC}[38;5;51mConsole: hello${ESC}[0m${END}`),
    ]);
    expect(entries.map((e) => e.entry.message)).toEqual([
      'Console executed command: server stats memory',
      'Total Physical Memory: 7.8 GiB\nFree Physical Memory: 4.8 GiB\nFree Swap Memory: 2.0 GiB',
      'Console: hello',
    ]);
    expect(entries[1].entry.logger).toBeUndefined();
  });

  it('drops the echo of the attach request the panel itself causes', () => {
    const entries = assemble([
      out(
        `2026-10-27T21:15:40.955402094Z Command not found! {"stream":true,"stdin":true,"stdout":false,"stderr":false,"hijack":true}${END}`,
      ),
      out(`2026-10-27T21:15:40.961086867Z Command not found! nosuchcommand${END}`),
    ]);
    expect(entries.map((e) => e.entry.message)).toEqual(['Command not found! nosuchcommand']);
  });

  it('reads the start script lines and the records before the console is set up', () => {
    const entries = assemble([
      out('2026-10-27T21:12:03.850195661Z [INFO] Timezone set to: Europe/Berlin'),
      out('2026-10-27T21:12:03.850334137Z [2026-10-27 22:12:04] [WARN] No server jar yet'),
      out(
        '2026-10-27T21:12:05.100000000Z [2026/10/27 21:12:05   INFO] [Hytale] Logger Initialized',
      ),
      out(
        '2026-10-27T21:12:06.100000000Z [2026/10/27 21:12:06   WARN] [org.jline] Unable to create a system terminal',
      ),
      out(
        `2026-10-27T21:12:06.762314807Z ${END}[2026/10/27 21:12:06   INFO]           [HytaleServer] Starting HytaleServer${END}`,
      ),
    ]);
    expect(entries.map((e) => [e.entry.level, e.entry.logger ?? null, e.entry.message])).toEqual([
      ['INFO', null, '[INFO] Timezone set to: Europe/Berlin'],
      ['WARN', null, '[2026-10-27 22:12:04] [WARN] No server jar yet'],
      ['INFO', 'Hytale', 'Logger Initialized'],
      ['WARN', 'org.jline', 'Unable to create a system terminal'],
      ['INFO', 'HytaleServer', 'Starting HytaleServer'],
    ]);
    // The first record with a marker cuts off one without; its start is in doubt.
    expect(entries.map((e) => e.clean)).toEqual([true, true, true, true, false]);
  });

  it('marks a record that starts inside another record as not clean', () => {
    // A logged message with a line break in it whose second line looks like a record.
    const entries = assemble([
      out(`2026-10-28T09:59:59.000000000Z ${END}[2026/10/28 09:59:59   INFO] [Chat] earlier${END}`),
      out(`2026-10-28T10:00:00.000000001Z ${END}[2026/10/28 10:00:00   INFO] [Chat] first line`),
      out(
        `2026-10-28T10:00:00.000000002Z [2026/10/28 10:00:00   INFO] [Universe|P] Adding player 'Mallory (00000000-0000-4000-8000-000000000001)${END}`,
      ),
      out(
        `2026-10-28T10:00:01.000000000Z ${END}[2026/10/28 10:00:01   INFO] [Universe|P] Adding player 'Alice (00000000-0000-4000-8000-000000000002)${END}`,
      ),
    ]);
    expect(entries.map((e) => [e.entry.message, e.clean])).toEqual([
      ['earlier', false],
      ['first line', false],
      ["Adding player 'Mallory (00000000-0000-4000-8000-000000000001)", false],
      ["Adding player 'Alice (00000000-0000-4000-8000-000000000002)", true],
    ]);
  });

  it('never trusts the first record of a tail, which may be a line of a cut-off record', () => {
    const fake = "Adding player 'Mallory (00000000-0000-4000-8000-000000000001)";
    const entries = assemble([
      out('2026-10-28T10:00:00.000000001Z rest of a message'),
      out(`2026-10-28T10:00:00.000000002Z [2026/10/28 10:00:00   INFO] [Universe|P] ${fake}${END}`),
      out(`2026-10-28T10:00:01.000000000Z ${END}[2026/10/28 10:00:01   INFO] [Universe|P] ${fake}${END}`),
    ]);
    expect(entries.map((e) => [e.entry.message, e.clean])).toEqual([
      ['rest of a message', true],
      [fake, false],
      [fake, true],
    ]);
  });

  it('starts a new record after a pause even without a marker', () => {
    const entries = assemble([
      out(`2026-10-28T10:00:00.000000000Z ${END}[2026/10/28 10:00:00   INFO] [A] waiting`),
      out('2026-10-28T10:00:05.000000000Z late line'),
    ]);
    expect(entries.map((e) => e.entry.message)).toEqual(['waiting', 'late line']);
  });

  it('treats unformatted stderr (the JVM itself) as a warning', () => {
    const [e] = assemble([
      err('2026-10-28T10:00:00.000000000Z WARNING: A restricted method was called'),
    ]);
    expect(e.entry.level).toBe('WARN');
  });

  it('removes colours, cursor moves and redraws', () => {
    expect(
      cleanConsoleText(`${ESC}[2K> partial\rfinal ${ESC}[1mbold${ESC}[0m${ESC}]0;title\x07`),
    ).toBe('final bold');
  });
});

describe('server log files (no markers)', () => {
  const file = [
    '[2026/10/16 12:37:39   INFO]          [KyuubiSoft Pets] Pet database ready',
    '[2026/10/16 12:37:40 SEVERE]          [PluginManager] Failed to enable plugin',
    'java.lang.IllegalStateException: boom',
    '\tat com.example.Plugin.enable(Plugin.java:42)',
    '\tat com.example.Loader.load(Loader.java:7)',
    'Caused by: java.io.IOException: disk',
    '\t... 2 more',
    'Someone is now an operator!',
    '[2026/10/16 12:37:41   INFO]          [HytaleServer] Done',
    '',
  ].join('\n');

  it('keeps a stack trace with its record and gives a raw record the time before it', () => {
    const entries = parseLogs(file);
    expect(entries.map((e) => [e.level, e.timestamp])).toEqual([
      ['INFO', '2026-10-16T12:37:39.000Z'],
      ['ERROR', '2026-10-16T12:37:40.000Z'],
      ['INFO', '2026-10-16T12:37:40.000Z'],
      ['INFO', '2026-10-16T12:37:41.000Z'],
    ]);
    expect(entries[1].message.split('\n')).toHaveLength(6);
    expect(entries[2].message).toBe('Someone is now an operator!');
  });

  it('counts every record as clean, since a file has no markers to check', () => {
    const assembler = new LogAssembler();
    const lines = file.split('\n').map((text) => out(text));
    const all = [...lines.flatMap((l) => assembler.push(l)), ...assembler.flush()];
    expect(all.every((e) => e.clean)).toBe(true);
  });
});
