/**
 * The access pages' console commands: every builder checks its input, ban
 * reasons are reduced to words the server's command parser takes literally,
 * and the answers are read from the plugin's reply.
 */
import { describe, it, expect } from 'vitest';
import {
  AccessInputError,
  accessCommand,
  answered,
  banReasonText,
  readCommandOutcome,
} from './accessCommands.js';

const A = '0a1b2c3d-0000-4000-8000-00000000000a';

describe('accessCommand', () => {
  it('builds the 0.7 commands', () => {
    expect(accessCommand.whitelistSwitch(true)).toBe('/whitelist enable');
    expect(accessCommand.whitelistSwitch(false)).toBe('/whitelist disable');
    expect(accessCommand.whitelistAdd('Bob')).toBe('/whitelist add Bob');
    expect(accessCommand.grantJoin(A.toUpperCase())).toBe(`/perm user add ${A} hytale.server.join`);
    expect(accessCommand.revokeJoin(A)).toBe(`/perm user remove ${A} hytale.server.join`);
    expect(accessCommand.userGroup('add', A, 'hytale:Admin')).toBe(
      `/perm user group add ${A} hytale:Admin`,
    );
    expect(accessCommand.userPermission('remove', A, '-a.b.*')).toBe(
      `/perm user remove ${A} -a.b.*`,
    );
    expect(accessCommand.groupPermission('add', 'Mods', 'kick')).toBe('/perm group add Mods kick');
    expect(accessCommand.ban('Bob', 'griefing the spawn')).toBe('/ban Bob griefing the spawn');
    expect(accessCommand.ban(A)).toBe(`/ban ${A}`);
    expect(accessCommand.unban('Bob')).toBe('/unban Bob');
  });

  it('refuses input that is no player, UUID, group or permission', () => {
    expect(() => accessCommand.whitelistAdd('Bob Smith')).toThrow(AccessInputError);
    expect(() => accessCommand.ban('a;b')).toThrow(AccessInputError);
    // The server's parser would read these as an option or a sign.
    expect(() => accessCommand.ban('--help')).toThrow(AccessInputError);
    expect(() => accessCommand.whitelistAdd('-x')).toThrow(AccessInputError);
    expect(() => accessCommand.grantJoin('Bob')).toThrow(AccessInputError);
    expect(() => accessCommand.userGroup('add', A, 'bad group')).toThrow(AccessInputError);
    expect(() => accessCommand.userGroup('add', A, 'g'.repeat(65))).toThrow(AccessInputError);
    expect(() => accessCommand.userPermission('add', A, '*')).toThrow(AccessInputError);
    expect(() => accessCommand.groupPermission('add', 'Mods', 'a b')).toThrow(AccessInputError);
  });
});

describe('banReasonText', () => {
  it('keeps plain words', () => {
    expect(banReasonText('griefing at spawn!')).toBe('griefing at spawn!');
  });

  it('replaces what the command parser would act on', () => {
    // Look-alikes for quotes, brackets and backslashes; commas go. An
    // apostrophe that closes a word is plain text for the parser, so it is
    // not given a look-alike; the gate takes no quotes, so it goes as well.
    expect(banReasonText('"quoted" \'x\' a\\b [list] a,,b, c')).toBe(
      '”quoted” ’x a/b (list) a b c',
    );
    expect(banReasonText('--help me --')).toBe('-help me');
    expect(banReasonText('a\nb\tc   d')).toBe('a b c d');
  });

  it('always yields a reason the access gate lets through', async () => {
    const reason = banReasonText('"a" --b [c], \\d \'e\' ,,f --');
    expect(reason).toMatch(/^(?!--)[^\s"'\\[\],]+(?: (?!--)[^\s"'\\[\],]+)*$/);
  });

  it('limits the length and ignores what is not text', () => {
    expect(banReasonText('x'.repeat(500)).length).toBeLessThanOrEqual(200);
    expect(banReasonText(undefined)).toBe('');
    expect(banReasonText(42)).toBe('');
  });
});

describe('readCommandOutcome', () => {
  it('reads a command the plugin ran', () => {
    const outcome = readCommandOutcome({
      success: true,
      via: 'plugin',
      status: 'DONE',
      lines: ['Bob is now whitelisted'],
      messageIds: ['server.modules.whitelist.addSuccess'],
    });
    expect(outcome).toEqual({
      kind: 'done',
      message: 'Bob is now whitelisted',
      messageIds: ['server.modules.whitelist.addSuccess'],
    });
    expect(answered(outcome, '.addSuccess')).toBe(true);
    expect(answered(outcome, '.alreadyWhitelisted')).toBe(false);
  });

  it('reads a refusal and a command that only went to the console', () => {
    expect(
      readCommandOutcome({
        success: false,
        via: 'plugin',
        status: 'FAILED',
        error: 'Command failed',
        lines: ['No player found'],
        messageIds: ['server.commands.parsing.argtype.playerUuidLookup.notFound'],
      }),
    ).toMatchObject({ kind: 'rejected', message: 'Command failed: No player found' });
    expect(
      readCommandOutcome({ success: true, via: 'stdin', message: 'Command executed' }),
    ).toEqual({
      kind: 'sent',
      via: 'stdin',
      message: 'Command executed',
    });
    expect(readCommandOutcome({ success: false, error: 'Container not running' })).toEqual({
      kind: 'failed',
      message: 'Container not running',
    });
  });
});
