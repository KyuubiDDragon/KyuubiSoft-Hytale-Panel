/**
 * The Hytale 0.7 console commands the panel documents (help page, console
 * command reference), with the syntax the server accepts and the console tier
 * the panel requires for each: 'plain' = console.execute, 'admin' =
 * console.execute.admin. The backend decides the tier
 * (manager/backend/src/utils/commandWhitelist.ts); keep both in step.
 *
 * Every other command of the server (and of its mods) is listed live from the
 * server's own command registry (GET /api/console/commands).
 */

export type CommandTierLabel = 'plain' | 'admin'

export interface DocumentedCommand {
  command: string
  usage: string
  /** i18n key below help.commands */
  key: string
  tier: CommandTierLabel
}

export interface CommandCategory {
  id: 'players' | 'access' | 'server' | 'world' | 'chat'
  commands: DocumentedCommand[]
}

export const HYTALE_COMMANDS: CommandCategory[] = [
  {
    id: 'players',
    commands: [
      { command: '/who', usage: '/who', key: 'who', tier: 'plain' },
      { command: '/whoami', usage: '/whoami <player>', key: 'whoami', tier: 'plain' },
      { command: '/whereami', usage: '/whereami <player>', key: 'whereami', tier: 'plain' },
      { command: '/kick', usage: '/kick <player>', key: 'kick', tier: 'admin' },
      { command: '/kill', usage: '/kill <player>', key: 'kill', tier: 'admin' },
      {
        command: '/gamemode',
        usage: '/gamemode <adventure|creative> <player>',
        key: 'gamemode',
        tier: 'admin',
      },
      {
        command: '/give',
        usage: '/give <player> <item> --quantity=<n>',
        key: 'give',
        tier: 'admin',
      },
      {
        command: '/player stats settomax',
        usage: '/player stats settomax Health --player <player>',
        key: 'heal',
        tier: 'admin',
      },
      {
        command: '/player respawn',
        usage: '/player respawn <player>',
        key: 'respawn',
        tier: 'admin',
      },
      {
        command: '/player effect apply',
        usage: '/player effect apply <player> <effect> [--duration=<seconds>]',
        key: 'effectApply',
        tier: 'admin',
      },
      {
        command: '/player effect clear',
        usage: '/player effect clear <player>',
        key: 'effectClear',
        tier: 'admin',
      },
      { command: '/tp', usage: '/tp <player> <targetPlayer>', key: 'tpPlayer', tier: 'admin' },
      { command: '/tp', usage: '/tp <player> <x> <y> <z>', key: 'tpCoords', tier: 'admin' },
    ],
  },
  {
    id: 'access',
    commands: [
      {
        command: '/whitelist status',
        usage: '/whitelist status',
        key: 'whitelistStatus',
        tier: 'plain',
      },
      { command: '/whitelist list', usage: '/whitelist list', key: 'whitelistList', tier: 'plain' },
      {
        command: '/whitelist enable',
        usage: '/whitelist enable | disable',
        key: 'whitelistSwitch',
        tier: 'admin',
      },
      {
        command: '/whitelist add',
        usage: '/whitelist add <player>',
        key: 'whitelistAdd',
        tier: 'admin',
      },
      {
        command: '/whitelist remove',
        usage: '/whitelist remove <player>',
        key: 'whitelistRemove',
        tier: 'admin',
      },
      { command: '/ban', usage: '/ban <player> [reason]', key: 'ban', tier: 'admin' },
      { command: '/unban', usage: '/unban <player>', key: 'unban', tier: 'admin' },
      { command: '/op add', usage: '/op add <player>', key: 'opAdd', tier: 'admin' },
      { command: '/op remove', usage: '/op remove <player>', key: 'opRemove', tier: 'admin' },
      {
        command: '/perm user add',
        usage: '/perm user add <uuid> <permission>',
        key: 'permUser',
        tier: 'admin',
      },
      {
        command: '/perm group add',
        usage: '/perm group add <group> <permission>',
        key: 'permGroup',
        tier: 'admin',
      },
    ],
  },
  {
    id: 'server',
    commands: [
      { command: '/help', usage: '/help <command>', key: 'help', tier: 'plain' },
      { command: '/version', usage: '/version', key: 'version', tier: 'plain' },
      {
        command: '/server stats',
        usage: '/server stats <memory|cpu|gc>',
        key: 'stats',
        tier: 'plain',
      },
      { command: '/plugin list', usage: '/plugin list', key: 'pluginList', tier: 'plain' },
      {
        command: '/maxplayers',
        usage: '/maxplayers [--amount <n>]',
        key: 'maxplayers',
        tier: 'admin',
      },
      { command: '/backup', usage: '/backup', key: 'backup', tier: 'admin' },
      {
        command: '/update',
        usage: '/update <status|check|download|apply --confirm>',
        key: 'update',
        tier: 'admin',
      },
      { command: '/auth status', usage: '/auth status', key: 'authStatus', tier: 'admin' },
      { command: '/stop', usage: '/stop', key: 'stop', tier: 'admin' },
    ],
  },
  {
    id: 'world',
    commands: [
      { command: '/world list', usage: '/world list', key: 'worldList', tier: 'plain' },
      {
        command: '/world save',
        usage: '/world save --all --confirm',
        key: 'worldSave',
        tier: 'plain',
      },
      { command: '/world perf', usage: '/world perf', key: 'worldPerf', tier: 'plain' },
      { command: '/world add', usage: '/world add <name>', key: 'worldAdd', tier: 'admin' },
      { command: '/world load', usage: '/world load <name>', key: 'worldLoad', tier: 'admin' },
      {
        command: '/time set',
        usage: '/time set <dawn|midday|dusk|midnight>',
        key: 'timeSet',
        tier: 'plain',
      },
      { command: '/time pause', usage: '/time pause', key: 'timePause', tier: 'plain' },
      {
        command: '/weather set',
        usage: '/weather set <weather>',
        key: 'weatherSet',
        tier: 'plain',
      },
      { command: '/weather reset', usage: '/weather reset', key: 'weatherReset', tier: 'plain' },
      { command: '/warp list', usage: '/warp list', key: 'warpList', tier: 'plain' },
    ],
  },
  {
    id: 'chat',
    commands: [
      { command: '/say', usage: '/say <message>', key: 'say', tier: 'plain' },
      {
        command: '/notify',
        usage: '/notify [warning|danger|success] <message>',
        key: 'notify',
        tier: 'plain',
      },
      {
        command: '/eventtitle',
        usage: '/eventtitle <title> [--secondary=<text>]',
        key: 'eventtitle',
        tier: 'plain',
      },
    ],
  },
]
