/**
 * Which console commands the panel lets through, and with which permission.
 *
 * The list of commands comes from the server itself: the KyuubiSoft API
 * plugin exports every registered command (vanilla and mods, with aliases and
 * subcommands, see services/commandRegistry.ts). When that list is not
 * available (plugin missing, server never ran with it) the vanilla commands of
 * Hytale 0.7.3 below stand in for it. A command that is in neither is refused.
 *
 * The permission tier is a fixed panel policy on top of that list: a short set
 * of informational, announcement and time/weather commands needs
 * `console.execute`, every other command `console.execute.admin`. Mod commands
 * are always admin. Holding the admin tier is full console access anyway (it
 * includes /op and /perm), so the server's own command list decides what
 * exists, the policy only who may run it.
 *
 * A console line is resolved exactly like the server does it: the root is the
 * text up to the first space, matched by name before alias (case-insensitive);
 * every following word that names a subcommand (name, then alias) descends one
 * level. The resolver only descends on plain words that are a subcommand's
 * name or alias, so it never goes deeper than the server; where it stops
 * earlier (a quoted word, say) it classifies the parent, and no command with
 * subcommands gets the plain tier for its whole subtree.
 */

export type CommandTier = 'console.execute' | 'console.execute.admin';

/** What the resolver needs of a command; a registry CommandNode fits. */
export interface CommandShape {
  name: string;
  aliases?: string[];
  /** True for Hytale's own commands. Only those can get the plain tier. */
  builtin?: boolean;
  subcommands?: CommandShape[];
  /** The plugin could not read this command; its subcommands may be missing. */
  error?: string;
}

const PLAIN: CommandTier = 'console.execute';
const ADMIN: CommandTier = 'console.execute.admin';

/**
 * Vanilla commands (canonical names, "root sub …") that need only
 * console.execute. Every other command, every mod command and every
 * subcommand a server update adds needs console.execute.admin: an entry
 * covers exactly that command, not its subcommands.
 */
export const PLAIN_TIER_COMMANDS: ReadonlySet<string> = new Set([
  // Information
  'help',
  'who',
  'version',
  'whoami',
  'whereami',
  'server stats',
  'server stats cpu',
  'server stats gc',
  'server stats memory',
  'world list',
  'world perf',
  'world perf graph',
  'world perf reset',
  'plugin list',
  'packs list',
  'warp list',
  'whitelist status',
  'whitelist list',
  // Announcements
  'say',
  'notify',
  'eventtitle',
  // Time of day and weather (not the time dilation)
  'time',
  'time dawn',
  'time dusk',
  'time midday',
  'time midnight',
  'time pause',
  'time set',
  'time set dawn',
  'time set dusk',
  'time set midday',
  'time set midnight',
  'weather',
  'weather get',
  'weather reset',
  'weather set',
  // Saving the worlds
  'world save',
]);

function cmd(spec: string, subcommands?: CommandShape[]): CommandShape {
  const [name, ...aliases] = spec.split('|');
  return {
    name,
    ...(aliases.length ? { aliases } : {}),
    builtin: true,
    ...(subcommands ? { subcommands } : {}),
  };
}

// Vanilla commands whose subcommands matter for the policy or the panel.
const VANILLA_TREES: CommandShape[] = [
  cmd('auth', [
    cmd('cancel'),
    cmd('login', [cmd('browser'), cmd('device')]),
    cmd('logout'),
    cmd('persistence'),
    cmd('select'),
    cmd('status'),
  ]),
  cmd('inventory|inv', [cmd('backpack'), cmd('clear'), cmd('item'), cmd('see')]),
  cmd('op', [cmd('add'), cmd('remove'), cmd('self')]),
  cmd('packs', [cmd('list|ls')]),
  cmd('player', [
    cmd('camera'),
    cmd('effect', [cmd('apply'), cmd('clear')]),
    cmd('lives', [cmd('clear'), cmd('get'), cmd('set')]),
    cmd('reset'),
    cmd('respawn'),
    cmd('stats|stat', [
      cmd('add'),
      cmd('dump'),
      cmd('get'),
      cmd('reset'),
      cmd('set'),
      cmd('settomax'),
    ]),
    cmd('viewradius', [cmd('get'), cmd('set')]),
    cmd('zone'),
  ]),
  cmd('plugin|pl|plugins', [
    cmd('list|ls'),
    cmd('load|l'),
    cmd('manage|m'),
    cmd('reload|r'),
    cmd('unload|u'),
  ]),
  cmd('server', [cmd('dump'), cmd('gc'), cmd('stats', [cmd('cpu'), cmd('gc'), cmd('memory|mem')])]),
  cmd('time|daytime', [
    cmd('dawn|day|morning'),
    cmd('dilation'),
    cmd('dusk|night'),
    cmd('midday|noon'),
    cmd('midnight'),
    cmd('pause|stop'),
    cmd('set', [cmd('dawn|day|morning'), cmd('dusk|night'), cmd('midday|noon'), cmd('midnight')]),
  ]),
  cmd('update', [
    cmd('apply'),
    cmd('cancel'),
    cmd('check'),
    cmd('download'),
    cmd('patchline'),
    cmd('setup'),
    cmd('status'),
  ]),
  cmd('warp', [cmd('go'), cmd('list'), cmd('reload'), cmd('remove'), cmd('set')]),
  cmd('weather', [cmd('get'), cmd('reset|clear'), cmd('set')]),
  cmd('whitelist', [
    cmd('add'),
    cmd('clear'),
    cmd('disable|off'),
    cmd('enable|on'),
    cmd('list'),
    cmd('remove'),
    cmd('status'),
  ]),
  cmd('world|worlds', [
    cmd('add'),
    cmd('config', [cmd('pausetime'), cmd('pvp'), cmd('seed'), cmd('setspawn', [cmd('default')])]),
    cmd('list|ls'),
    cmd('load'),
    cmd('pause'),
    cmd('perf', [cmd('graph'), cmd('reset')]),
    cmd('prune'),
    cmd('remove|rm'),
    cmd('rocksdb', [cmd('compact')]),
    cmd('save'),
    cmd('setdefault'),
    cmd('settings|ws'),
    cmd('tps|tickrate', [cmd('reset')]),
  ]),
];

// The other root commands of a vanilla 0.7.3 server ("name|alias|…").
const VANILLA_ROOTS = `
  abilities ambience|ambiance|ambient assets audio backup ban beam bindings block|blocks
  blockanimspeed blockselect blockset blockspawner buildertoolslegend camshake checkpoint
  chunk|chunks clearblocks|clear clearedithistory|clearhistory|cleartoolhistory clearentities
  commands contractselection|contract convertprefabs copy cut damage|hurt debug
  debugplayerposition delete|/d|/del deselect|clearselection desyncdamage discovery droplist
  echo editline editprefab|pedit|prefabedit emote encounter entity|entities
  environment|setenv|setenvironment ephemeral eventtitle expand extendface fillblocks|fill
  fillsignature flip floodfill fluid gameflags gamemode|gm give gmask goblins heal help|? hide
  hitbox hitboxcollision hitdetection hollow hotbar hub|cosmos|crossroads hudtest importimage
  importobj|obj instances|inst|instance interaction|interact itemstate kick kill
  kit knockback landiscovery lang|i18n|internationalization|translation layer lighting|light
  locate log maxplayers maxviewradius memories messagetest|msgtest model mount move neardeath
  network|net networkchunksending noon notify npc objective|obj packetstats particle paste
  path perm pidcheck ping play point portal|fragment pos1 pos2 prefab|p prefabpreview
  prefabspawner|pspawner recipe redo|r refer|transfer repairfillers replace repulsion reputation
  resetrotation rotate say|broadcast scriptedbrushes|sb|scriptbrush|scriptedbrush selectchunk
  selectchunksection selectionhistory setblocks|set setgroup setticking
  settimeandgohome|macrotest settoolhistorysize shift shrink sleep sound spawn spawnblock
  spawning|sp spawnitem spectate stack stash stop|shutdown submerge|flood sudo|su tagpattern
  tint toggleblockplacementoverride|tbpo|toggleplacement
  toggletmptags|tmpstring|tmpstrings|tmptag|tmptags|tmptext tp|teleport tpcinematic
  triggervolume|tv ui-gallery unban undo|u unstuck updateselection validatecpb version
  viewport voice voidevent wait wall|side|sides|walls whereami who whoami|uuid wilderness
  worldevent worldgen|wg worldgen2|wg2 worldmap|map worldpath
`;

/**
 * The commands of a vanilla Hytale 0.7.3 server, read from its registry.
 * Used when the server's own list is not available.
 */
export const VANILLA_COMMANDS: readonly CommandShape[] = [
  ...VANILLA_TREES,
  ...VANILLA_ROOTS.trim()
    .split(/\s+/)
    .map((spec) => cmd(spec)),
].sort((a, b) => a.name.localeCompare(b.name));

// A root token: printable ASCII, so case folding is the same here and on the server.
const ROOT_TOKEN = /^[\x21-\x7e]+$/;
const MAX_LINE_LENGTH = 4096;

/**
 * The words of a console line as the server reads them, or null when it is
 * not a command line. Like the plugin: surrounding spaces and one leading "/"
 * are dropped. A space right after the "/" is refused: the server would accept
 * "/ stop", but the panel's own checks of the raw line (a stop it caused
 * itself, say) expect the name right after the slash. Control characters must
 * have been rejected before.
 */
function words(line: string): string[] | null {
  if (typeof line !== 'string' || line.length > MAX_LINE_LENGTH) return null;
  const trimmed = line.replace(/^ +| +$/g, '');
  if (!trimmed.startsWith('/') || trimmed.startsWith('/ ')) return null;
  const tokens = trimmed.slice(1).split(' ').filter(Boolean);
  if (tokens.length === 0 || !ROOT_TOKEN.test(tokens[0])) return null;
  return tokens;
}

function lower(value: string): string {
  return value.toLowerCase();
}

/** Every root the token names; more than one only when roots share an alias. */
function findRoots(commands: readonly CommandShape[], token: string): CommandShape[] {
  const t = lower(token);
  const direct = commands.filter((c) => lower(c.name) === t);
  if (direct.length > 0) return direct;
  return commands.filter((c) => (c.aliases ?? []).some((a) => lower(a) === t));
}

function findSubcommand(node: CommandShape, token: string): CommandShape | undefined {
  const t = lower(token);
  const subs = node.subcommands ?? [];
  return (
    subs.find((c) => lower(c.name) === t) ??
    subs.find((c) => (c.aliases ?? []).some((a) => lower(a) === t))
  );
}

function chainFor(root: CommandShape, rest: string[]): CommandShape[] {
  const chain = [root];
  let current = root;
  for (let i = 0; i < rest.length; i++) {
    // A word followed by a comma is the first item of a list for the server,
    // not a subcommand.
    if (rest[i + 1]?.startsWith(',')) break;
    const sub = findSubcommand(current, rest[i]);
    if (!sub) break;
    chain.push(sub);
    current = sub;
  }
  return chain;
}

function pathOf(chain: CommandShape[]): string {
  return chain.map((c) => lower(c.name)).join(' ');
}

function tierOf(chain: CommandShape[]): CommandTier {
  // A mod (or a mod that replaced a vanilla command) never gets the plain tier.
  if (chain[0].builtin !== true) return ADMIN;
  // An unreadable command may hide the subcommand the server would run.
  if (chain.some((c) => c.error)) return ADMIN;
  return PLAIN_TIER_COMMANDS.has(pathOf(chain)) ? PLAIN : ADMIN;
}

function stricter(a: CommandTier, b: CommandTier): CommandTier {
  return a === ADMIN || b === ADMIN ? ADMIN : PLAIN;
}

export type CommandClassification =
  | {
      known: true;
      tier: CommandTier;
      /** Canonical command, e.g. "/world save". */
      path: string;
      builtin: boolean;
    }
  | { known: false; error: string };

/**
 * Resolve a console line against a command list and give the tier it needs.
 * When roots share an alias the server's choice is unknown, so the stricter
 * tier of the candidates applies.
 */
export function classifyCommand(
  line: string,
  commands: readonly CommandShape[],
): CommandClassification {
  const tokens = words(line);
  if (!tokens) return { known: false, error: 'Not a console command' };
  const roots = findRoots(commands, tokens[0]);
  if (roots.length === 0) {
    return {
      known: false,
      error: `Unknown command: /${tokens[0]}. Use /help for the server's commands.`,
    };
  }
  const chains = roots.map((root) => chainFor(root, tokens.slice(1)));
  const tier = chains.map(tierOf).reduce(stricter);
  return {
    known: true,
    tier,
    path: `/${pathOf(chains[0])}`,
    builtin: chains.every((c) => c[0].builtin === true),
  };
}

/**
 * The lowest tier that runs the command a (possibly partial) line names or one
 * of its subcommands; null for an unknown command. For autocomplete: a user
 * who may run `/world save` may see the subcommands of `/world`.
 */
export function lowestTierWithin(
  line: string,
  commands: readonly CommandShape[],
): CommandTier | null {
  const classified = classifyCommand(line, commands);
  if (!classified.known) return null;
  if (classified.tier === PLAIN || !classified.builtin) return classified.tier;
  const prefix = `${classified.path.slice(1)} `;
  const below = [...PLAIN_TIER_COMMANDS].some((path) => path.startsWith(prefix));
  return below ? PLAIN : ADMIN;
}

/** A command node annotated with what the panel does with it. */
export type WithPanelPolicy<T extends CommandShape> = Omit<T, 'subcommands'> & {
  panel: { allowed: true; permission: CommandTier };
  subcommands?: WithPanelPolicy<T>[];
};

/** Annotate a command tree (registry or fallback) with each command's tier. */
export function annotateCommands<T extends CommandShape>(
  commands: readonly T[],
): WithPanelPolicy<T>[] {
  const walk = (node: T, chain: CommandShape[]): WithPanelPolicy<T> => {
    const path = [...chain, node];
    const subs = node.subcommands as T[] | undefined;
    return {
      ...node,
      panel: { allowed: true, permission: tierOf(path) },
      ...(subs ? { subcommands: subs.map((s) => walk(s, path)) } : {}),
    };
  };
  return commands.map((node) => walk(node, []));
}

// ---------------------------------------------------------------------------
// Command names known right now, for the synchronous gate in validateCommand
// ---------------------------------------------------------------------------

const VANILLA_ROOT_NAMES = new Set(
  VANILLA_COMMANDS.flatMap((c) => [c.name, ...(c.aliases ?? [])].map(lower)),
);
// Root names and aliases of each server's last known registry.
const serverRootNames = new Map<string, Set<string>>();

/** Record the root commands of a server's registry (replaces the last ones). */
export function rememberServerCommands(serverId: string, commands: readonly CommandShape[]): void {
  serverRootNames.set(
    serverId,
    new Set(commands.flatMap((c) => [c.name, ...(c.aliases ?? [])].map(lower))),
  );
}

/** Test hook. */
export function forgetServerCommands(): void {
  serverRootNames.clear();
}

/**
 * Does the line start with a command that exists on a vanilla server or on
 * any server whose registry the panel has seen? The per-server check with the
 * permission tier is commandPolicy.authorizeCommand.
 */
export function isKnownCommandLine(line: string): boolean {
  const tokens = words(line);
  if (!tokens) return false;
  const root = lower(tokens[0]);
  if (VANILLA_ROOT_NAMES.has(root)) return true;
  for (const names of serverRootNames.values()) if (names.has(root)) return true;
  return false;
}
