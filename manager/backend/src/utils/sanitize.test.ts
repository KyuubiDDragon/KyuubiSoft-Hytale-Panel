import { describe, it, expect } from 'vitest';
import {
  isValidPlayerName,
  isValidItemId,
  isValidUUID,
  isValidGamemode,
  isCommandSafe,
  validateCommand,
  isCommandAllowed,
  getCommandRequiredPermission,
  escapeShellArg,
  sanitizeMessage,
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
      expect(isCommandSafe(command)).toBe(false);
      const result = validateCommand(command);
      expect(result.valid).toBe(false);
      expect(result.error).toMatch(/single line/);
      expect(getCommandRequiredPermission(command)).toBeNull();
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

  it('classifies a suffixed admin command by its base name', () => {
    expect(getCommandRequiredPermission('/op:add steve')).toBe('console.execute.admin');
    expect(getCommandRequiredPermission('/say:x hello')).toBe('console.execute');
  });

  it('puts every /auth subcommand and /save-off on the admin tier', () => {
    for (const cmd of [
      '/auth',
      '/auth status',
      '/auth logout',
      '/auth login device',
      '/auth select 1',
      '/auth cancel',
      '/auth persistence Memory',
      '/AUTH LOGOUT',
      '/auth:logout',
      '/save-off',
    ]) {
      expect(getCommandRequiredPermission(cmd)).toBe('console.execute.admin');
    }
    // Deliberately unchanged: these stay on the plain tier.
    for (const cmd of [
      '/save',
      '/save-on',
      '/save-all',
      '/setspawn',
      '/worldborder 100',
      '/tp a b',
      '/teleport a b',
    ]) {
      expect(getCommandRequiredPermission(cmd)).toBe('console.execute');
    }
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
  });
});

describe('sanitize.isCommandSafe', () => {
  it('blocks command chaining', () => {
    expect(isCommandSafe('/kick steve; rm -rf')).toBe(false);
    expect(isCommandSafe('/kick steve | curl evil')).toBe(false);
    expect(isCommandSafe('/kick steve && reboot')).toBe(false);
  });
  it('blocks substitutions and redirection', () => {
    expect(isCommandSafe('/say $(whoami)')).toBe(false);
    expect(isCommandSafe('/say ${HOME}')).toBe(false);
    expect(isCommandSafe('/say hi > /etc/passwd')).toBe(false);
  });
  it('allows ordinary content', () => {
    expect(isCommandSafe('/kick steve grief')).toBe(true);
    expect(isCommandSafe('/give @p adamantite_sword 1')).toBe(true);
  });
});

describe('sanitize.validateCommand', () => {
  it('only allows whitelisted prefixes', () => {
    expect(validateCommand('/kick steve').valid).toBe(true);
    expect(validateCommand('/eval Math.random()').valid).toBe(false);
  });
  it('requires a leading slash', () => {
    expect(validateCommand('kick steve').valid).toBe(false);
  });
});

describe('sanitize.getCommandRequiredPermission', () => {
  it('returns admin scope for privileged commands', () => {
    expect(getCommandRequiredPermission('/op steve')).toBe('console.execute.admin');
    expect(getCommandRequiredPermission('/ban steve')).toBe('console.execute.admin');
    expect(getCommandRequiredPermission('/stop')).toBe('console.execute.admin');
    expect(getCommandRequiredPermission('/give @p sword 1')).toBe('console.execute.admin');
  });
  it('returns plain execute for ordinary commands', () => {
    expect(getCommandRequiredPermission('/say hello')).toBe('console.execute');
    expect(getCommandRequiredPermission('/help')).toBe('console.execute');
    expect(getCommandRequiredPermission('/list')).toBe('console.execute');
  });
  it('returns null for unknown commands', () => {
    expect(getCommandRequiredPermission('/eval x()')).toBeNull();
    expect(getCommandRequiredPermission('not a command')).toBeNull();
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
  it('strips shell metacharacters but keeps spaces and punctuation', () => {
    expect(sanitizeMessage('Hello, world!')).toBe('Hello, world');
    expect(sanitizeMessage('a$b`c')).toBe('abc');
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
