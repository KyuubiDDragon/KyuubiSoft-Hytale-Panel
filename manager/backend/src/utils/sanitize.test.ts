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
} from './sanitize.js';

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
