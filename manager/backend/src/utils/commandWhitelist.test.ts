import { describe, it, expect, afterEach } from 'vitest';
import {
  VANILLA_COMMANDS,
  PLAIN_TIER_COMMANDS,
  annotateCommands,
  classifyCommand,
  forgetServerCommands,
  isKnownCommandLine,
  lowestTierWithin,
  rememberServerCommands,
  type CommandShape,
} from './commandWhitelist.js';

const PLAIN = 'console.execute';
const ADMIN = 'console.execute.admin';

function tier(line: string, commands: readonly CommandShape[] = VANILLA_COMMANDS) {
  const c = classifyCommand(line, commands);
  return c.known ? c.tier : null;
}

describe('commandWhitelist: tiers on a vanilla 0.7.3 server', () => {
  it('keeps every dangerous command on the admin tier', () => {
    for (const cmd of [
      '/op add Evil',
      '/op self',
      '/perm user add 00000000-0000-0000-0000-000000000000 *',
      '/perm group add Default *',
      '/setgroup OP Evil',
      '/stop',
      '/shutdown',
      '/auth status',
      '/auth logout',
      '/auth login device',
      '/update status',
      '/update apply --confirm',
      '/backup',
      '/whitelist add Evil',
      '/whitelist disable',
      '/whitelist clear',
      '/ban Steve griefing',
      '/unban Steve',
      '/kick Steve',
      '/kill Steve',
      '/give Steve Weapon_Sword_Iron',
      '/gamemode creative Steve',
      '/gm c Steve',
      '/sudo Steve op self',
      '/su Steve op self',
      '/inventory clear',
      '/inv see Steve',
      '/player stats settomax Health --player Steve',
      '/player respawn Steve',
      '/plugin unload KyuubiDDragon:KyuubiSoftAPI',
      '/pl load Evil',
      '/world remove default',
      '/world add Other',
      '/world tps 1',
      '/server dump',
      '/server gc',
      '/maxplayers --amount 0',
      '/refer evil.example 5520',
      '/time dilation 50',
      '/warp set Spawn',
      '/tp Steve 0 100 0',
      '/commands dump',
      '/log root FINEST',
    ]) {
      expect(tier(cmd), cmd).toBe(ADMIN);
    }
  });

  it('puts information, announcements, time, weather and saving on the plain tier', () => {
    for (const cmd of [
      '/help',
      '/? kick',
      '/who',
      '/version',
      '/whoami Steve',
      '/uuid Steve',
      '/whereami Steve',
      '/say <3 A & B; (x) > z | w',
      '/broadcast hello',
      '/notify Restart soon',
      '/eventtitle Welcome',
      '/server stats memory',
      '/server stats mem',
      '/world list',
      '/worlds ls',
      '/world perf',
      '/world save --all --confirm',
      '/plugin list',
      '/pl ls',
      '/packs list',
      '/warp list',
      '/whitelist status',
      '/whitelist list',
      '/time set day',
      '/time set night',
      '/daytime noon',
      '/time stop',
      '/weather set Zone1_Rain',
      '/weather clear',
      '/weather reset',
    ]) {
      expect(tier(cmd), cmd).toBe(PLAIN);
    }
  });

  it('only lists commands that exist on the server', () => {
    const paths = new Set<string>();
    const walk = (node: CommandShape, prefix: string) => {
      const path = `${prefix} ${node.name}`.trim();
      paths.add(path);
      for (const sub of node.subcommands ?? []) walk(sub, path);
    };
    for (const root of VANILLA_COMMANDS) walk(root, '');
    for (const plain of PLAIN_TIER_COMMANDS) expect(paths.has(plain), plain).toBe(true);
  });

  it('refuses commands Hytale 0.7 does not have', () => {
    for (const cmd of [
      '/save',
      '/save-all',
      '/save-off',
      '/list',
      '/tps',
      '/mute Steve',
      '/unmute Steve',
      '/msg Steve hi',
      '/tell Steve hi',
      '/difficulty hard',
      '/gamerule x',
      '/pregen start default 10',
      '/kick:x Steve',
      '/op:add Steve',
    ]) {
      expect(classifyCommand(cmd, VANILLA_COMMANDS).known, cmd).toBe(false);
    }
  });

  it('resolves names and aliases case-insensitively, like the server', () => {
    expect(classifyCommand('/WORLD SAVE --all --confirm', VANILLA_COMMANDS)).toEqual({
      known: true,
      tier: PLAIN,
      path: '/world save',
      builtin: true,
    });
    expect(classifyCommand('  /weather  clear ', VANILLA_COMMANDS)).toMatchObject({
      path: '/weather reset',
    });
    expect(classifyCommand('/TELEPORT a b', VANILLA_COMMANDS)).toMatchObject({ path: '/tp' });
  });

  it('never descends further than the server does', () => {
    // A quoted word or a list is no subcommand for the server either.
    expect(classifyCommand('/time "dilation" 50', VANILLA_COMMANDS)).toMatchObject({
      path: '/time',
    });
    // A word followed by a comma starts a list; /world itself is admin.
    expect(classifyCommand('/world save ,x', VANILLA_COMMANDS)).toMatchObject({
      path: '/world',
      tier: ADMIN,
    });
    expect(classifyCommand('/world [save]', VANILLA_COMMANDS)).toMatchObject({ path: '/world' });
    // After an --option every word is that option's value.
    expect(classifyCommand('/world --x save', VANILLA_COMMANDS)).toMatchObject({ path: '/world' });
  });

  it('gives a subcommand that is not on the list the admin tier, even below a plain command', () => {
    const registry: CommandShape[] = [
      { name: 'who', builtin: true, subcommands: [{ name: 'kickall', builtin: true }] },
      { name: 'time', builtin: true, subcommands: [{ name: 'wipe', builtin: true }] },
    ];
    expect(tier('/who', registry)).toBe(PLAIN);
    expect(tier('/who kickall', registry)).toBe(ADMIN);
    expect(tier('/time wipe', registry)).toBe(ADMIN);
  });

  it('gives a command the plugin could not read the admin tier', () => {
    // Its subcommands may be missing, so /time dilation could look like /time.
    const registry: CommandShape[] = [{ name: 'time', builtin: true, error: 'unreadable' }];
    expect(classifyCommand('/time dilation 5', registry)).toMatchObject({
      path: '/time',
      tier: ADMIN,
    });
  });

  it('refuses lines that are no single ASCII command word', () => {
    for (const cmd of [
      'say hi',
      '/',
      '   ',
      '/ stop',
      '/ who',
      '/ who',
      '/wörld list',
      `/${'a'.repeat(4096)}`,
    ]) {
      expect(classifyCommand(cmd, VANILLA_COMMANDS).known, JSON.stringify(cmd)).toBe(false);
    }
  });
});

describe('commandWhitelist: the server registry', () => {
  const registry: CommandShape[] = [
    { name: 'who', builtin: true },
    { name: 'ksadmin', builtin: false, aliases: ['ka'] },
    // A mod that registered over a vanilla name gets the admin tier.
    { name: 'version', builtin: false },
    // Two roots sharing an alias: the server keeps whichever registered last.
    { name: 'say', builtin: true, aliases: ['x'] },
    { name: 'wipeall', builtin: false, aliases: ['x'] },
    { name: 'help', builtin: true, aliases: ['ksadmin'] },
  ];

  it('runs mod commands on the admin tier only', () => {
    expect(tier('/ksadmin reload', registry)).toBe(ADMIN);
    expect(tier('/ka', registry)).toBe(ADMIN);
    expect(tier('/version', registry)).toBe(ADMIN);
  });

  it('prefers a name over another command alias, as the dispatcher does', () => {
    expect(classifyCommand('/ksadmin', registry)).toMatchObject({ path: '/ksadmin', tier: ADMIN });
  });

  it('takes the stricter tier when roots share an alias', () => {
    expect(tier('/x hello', registry)).toBe(ADMIN);
  });

  it('refuses vanilla commands the server does not list', () => {
    expect(classifyCommand('/kick Steve', registry).known).toBe(false);
  });

  it('lets autocomplete reach the plain subcommands of an admin command', () => {
    expect(lowestTierWithin('/world sa', VANILLA_COMMANDS)).toBe(PLAIN);
    expect(lowestTierWithin('/world', VANILLA_COMMANDS)).toBe(PLAIN);
    expect(lowestTierWithin('/world remove ', VANILLA_COMMANDS)).toBe(ADMIN);
    expect(lowestTierWithin('/op ', VANILLA_COMMANDS)).toBe(ADMIN);
    expect(lowestTierWithin('/ksadmin ', registry)).toBe(ADMIN);
    expect(lowestTierWithin('/nope', VANILLA_COMMANDS)).toBeNull();
  });

  it('annotates every command and subcommand with its tier', () => {
    const world = annotateCommands(VANILLA_COMMANDS).find((c) => c.name === 'world');
    expect(world?.panel).toEqual({ allowed: true, permission: ADMIN });
    const save = world?.subcommands?.find((c) => c.name === 'save');
    expect(save?.panel).toEqual({ allowed: true, permission: PLAIN });
    const remove = world?.subcommands?.find((c) => c.name === 'remove');
    expect(remove?.panel.permission).toBe(ADMIN);
  });
});

describe('commandWhitelist.isKnownCommandLine', () => {
  afterEach(() => forgetServerCommands());

  it('knows vanilla commands and the roots of loaded registries', () => {
    expect(isKnownCommandLine('/who')).toBe(true);
    expect(isKnownCommandLine('/ksadmin reload')).toBe(false);
    rememberServerCommands('alpha', [{ name: 'ksadmin', aliases: ['ka'] }]);
    expect(isKnownCommandLine('/ksadmin reload')).toBe(true);
    expect(isKnownCommandLine('/KA')).toBe(true);
    // A newer list replaces the server's previous one.
    rememberServerCommands('alpha', [{ name: 'other' }]);
    expect(isKnownCommandLine('/ksadmin')).toBe(false);
  });

  it('refuses what is no command line', () => {
    expect(isKnownCommandLine('who')).toBe(false);
    expect(isKnownCommandLine('/save')).toBe(false);
    expect(isKnownCommandLine('/ who')).toBe(false);
  });
});
