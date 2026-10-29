import { describe, it, expect } from 'vitest';
import {
  isValidPlayerName,
  isValidItemId,
  isValidUUID,
  isValidGamemode,
  validateCommand,
  escapeShellArg,
  sanitizeMessage,
  toCommandText,
  containsControlChars,
  stripControlChars,
} from './sanitize.js';

// Built from code points so the source file itself stays free of raw separators.
const LINE_SEPARATOR = String.fromCharCode(0x2028);
const PARAGRAPH_SEPARATOR = String.fromCharCode(0x2029);
const CTRL_C = String.fromCharCode(0x03);
const ESC = String.fromCharCode(0x1b);
const DEL = String.fromCharCode(0x7f);
const NEL = String.fromCharCode(0x85); // C1 "next line"
const CSI_C1 = String.fromCharCode(0x9b);

describe('sanitize: console line injection (control characters)', () => {
  const smuggled = [
    ['line feed', '/say hi\n/op add Evil'],
    ['carriage return', '/say hi\r/op add Evil'],
    ['CRLF', '/say hi\r\n/op add Evil'],
    ['tab', '/say\t/op add Evil'],
    ['Ctrl-C', `/say hi${CTRL_C}`],
    ['ESC sequence', `/say hi${ESC}[A`],
    ['DEL', `/say hi${DEL}`],
    ['C1 NEL', `/say hi${NEL}/op add Evil`],
    ['C1 CSI', `/say hi${CSI_C1}A`],
    ['U+2028', `/say hi${LINE_SEPARATOR}/op add Evil`],
    ['U+2029', `/say hi${PARAGRAPH_SEPARATOR}/op add Evil`],
    ['trailing line feed', '/say hi\n'],
  ] as const;

  for (const [label, command] of smuggled) {
    it(`rejects a command with ${label}`, () => {
      expect(containsControlChars(command)).toBe(true);
      const result = validateCommand(command);
      expect(result.valid).toBe(false);
      expect(result.error).toMatch(/single line/);
    });
  }

  it('reproduces the reported bypass: a second line can no longer pass as /say', () => {
    expect(validateCommand('/say a\n/op add Name').valid).toBe(false);
  });

  it('keeps ordinary single-line commands valid', () => {
    expect(containsControlChars('/say Grüße an alle! ÄÖÜ ß 日本')).toBe(false);
    expect(validateCommand('/say Grüße an alle').valid).toBe(true);
  });

  it('stripControlChars collapses each run into one space', () => {
    expect(stripControlChars('a\r\nb')).toBe('a b');
    expect(stripControlChars(`a${CTRL_C}${ESC}b${LINE_SEPARATOR}c\td`)).toBe('a b c d');
    expect(stripControlChars('plain')).toBe('plain');
  });

  it('sanitizeMessage turns every control character into a space (kick/ban reasons)', () => {
    expect(sanitizeMessage(`spam${CTRL_C}`)).toBe('spam');
    expect(sanitizeMessage(`a\nb${LINE_SEPARATOR}c\td${NEL}e`)).toBe('a b c d e');
    expect(containsControlChars(sanitizeMessage(`x\r\n/op add Evil${ESC}`))).toBe(false);
  });
});

describe('sanitize.isValidPlayerName', () => {
  it('accepts standard names', () => {
    expect(isValidPlayerName('Steve')).toBe(true);
    expect(isValidPlayerName('player_123')).toBe(true);
    expect(isValidPlayerName('A-B-C')).toBe(true);
  });
  it('rejects shell metacharacters', () => {
    expect(isValidPlayerName('foo;rm -rf')).toBe(false);
    expect(isValidPlayerName('foo bar')).toBe(false);
    expect(isValidPlayerName('foo$bar')).toBe(false);
  });
  it('rejects empty and overlong', () => {
    expect(isValidPlayerName('')).toBe(false);
    expect(isValidPlayerName('a'.repeat(33))).toBe(false);
    expect(isValidPlayerName('a'.repeat(32))).toBe(true);
  });
  it('rejects a leading hyphen, which the command parser reads as an option', () => {
    expect(isValidPlayerName('--confirm')).toBe(false);
    expect(isValidPlayerName('-x')).toBe(false);
    expect(isValidPlayerName('_x-y')).toBe(true);
  });
});

describe('sanitize.validateCommand', () => {
  it('accepts the commands of the server', () => {
    expect(validateCommand('/kick steve').valid).toBe(true);
    expect(validateCommand('/world save --all --confirm').valid).toBe(true);
    expect(validateCommand('/eval Math.random()').valid).toBe(false);
    expect(validateCommand('/save').valid).toBe(false);
  });
  it('requires a leading slash', () => {
    expect(validateCommand('kick steve').valid).toBe(false);
  });
  it('no longer blocks characters that only mean something to a shell', () => {
    // The console is no shell: these are ordinary text for /say and /notify.
    for (const cmd of [
      '/say <3 A & B; (x) > z | w',
      '/say $(whoami) ${HOME} `id`',
      '/notify Restart in 5 min! #1 ~ ^ *',
      '/say a/../b',
    ]) {
      expect(validateCommand(cmd), cmd).toEqual({ valid: true });
    }
  });
  it('rejects overlong lines', () => {
    expect(validateCommand(`/say ${'x'.repeat(5000)}`).valid).toBe(false);
  });
});

describe('sanitize.toCommandText', () => {
  it('keeps text a shell would care about', () => {
    expect(toCommandText('<3 A & B; (x) > z | w $HOME')).toBe('<3 A & B; (x) > z | w $HOME');
    expect(toCommandText("it's fine, isn't it?")).toBe("it's fine, isn't it?");
  });
  it('replaces what the Hytale command parser would reject', () => {
    expect(toCommandText('say "hi')).toBe('say \u201dhi');
    expect(toCommandText("'quoted")).toBe('\u2019quoted');
    expect(toCommandText("a ,'b")).toBe('a ,\u2019b');
    expect(toCommandText('a]b [c [d]')).toBe('a)b (c (d)');
    expect(toCommandText('C:\\path')).toBe('C:/path');
    expect(toCommandText('wait,,, what , , now')).toBe('wait, what , now');
    expect(toCommandText(', starts with a comma')).toBe('starts with a comma');
    expect(toCommandText('hello --world and,--x')).toBe('hello \u2013world and,\u2013x');
    expect(toCommandText('{"text":"json"}')).toBe('(\u201dtext\u201d:\u201djson\u201d}');
  });
  it('makes one line and cuts to the limit', () => {
    expect(toCommandText(`a\r\n/op add Evil${CTRL_C}`)).toBe('a /op add Evil');
    expect(toCommandText('  many    spaces  ')).toBe('many spaces');
    expect(toCommandText('x'.repeat(300), 10)).toBe('x'.repeat(10));
    expect(toCommandText(undefined as unknown as string)).toBe('');
  });
});

describe('sanitize.escapeShellArg', () => {
  it('wraps single quotes correctly', () => {
    expect(escapeShellArg("can't")).toBe(`'can'\\''t'`);
    expect(escapeShellArg('plain')).toBe(`'plain'`);
  });
});

describe('sanitize.isValidUUID', () => {
  it('matches RFC 4122 form', () => {
    expect(isValidUUID('550e8400-e29b-41d4-a716-446655440000')).toBe(true);
    expect(isValidUUID('not-a-uuid')).toBe(false);
  });
});

describe('sanitize.sanitizeMessage', () => {
  it('keeps punctuation and symbols, only control characters go', () => {
    expect(sanitizeMessage('Hello, world!')).toBe('Hello, world!');
    expect(sanitizeMessage('a$b`c <3 & ;')).toBe('a$b`c <3 & ;');
  });
  it('truncates', () => {
    expect(sanitizeMessage('x'.repeat(500)).length).toBeLessThanOrEqual(256);
  });
});

describe('sanitize.isValidGamemode', () => {
  it('accepts the two Hytale modes', () => {
    expect(isValidGamemode('creative')).toBe(true);
    expect(isValidGamemode('adventure')).toBe(true);
    expect(isValidGamemode('c')).toBe(true);
    expect(isValidGamemode('survival')).toBe(false);
  });
});

describe('sanitize.isValidItemId', () => {
  it('accepts hytale-namespaced ids', () => {
    expect(isValidItemId('hytale:cobalt_sword')).toBe(true);
    expect(isValidItemId('adamantite_chest')).toBe(true);
  });
  it('rejects path traversal', () => {
    expect(isValidItemId('../etc/passwd')).toBe(false);
  });
});
