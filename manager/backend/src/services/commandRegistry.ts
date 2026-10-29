/**
 * The server's real command list (vanilla and mod commands), read from the
 * KyuubiSoft API plugin and cached per server.
 *
 * The copy is kept until the plugin reports a different revision: after the
 * TTL a cheap `ifRevision` request confirms it, and a `commands_changed`
 * plugin event (a plugin loaded, unloaded or reloaded) or a new plugin
 * connection marks it for re-checking at once. The last good copy is also
 * written to `<dataPath>/command-registry/<serverId>.json`, so the list stays
 * available while the server is offline (served with `stale: true`).
 *
 * The data source for the console autocomplete and for the panel's command
 * whitelist (utils/commandWhitelist.ts). Every list read here is also
 * remembered there, so the synchronous check in validateCommand knows the
 * server's mod commands.
 */
import * as fs from 'fs/promises';
import * as path from 'path';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';
import {
  annotateCommands,
  rememberServerCommands,
  type CommandShape,
  type WithPanelPolicy,
} from '../utils/commandWhitelist.js';
import { resolveServerId } from './servers.js';
import {
  fetchCommandRegistry,
  type CommandNode,
  type PluginCommandRegistry,
} from './pluginCommands.js';

export type { CommandNode } from './pluginCommands.js';

export interface CommandRegistry extends PluginCommandRegistry {
  serverId: string;
  /** 'plugin': fetched from the running server; 'snapshot': last saved copy. */
  source: 'plugin' | 'snapshot';
  /** True when the server could not confirm this copy just now. */
  stale: boolean;
  fetchedAt: string;
}

export const REGISTRY_TTL_MS = 60_000;
const SNAPSHOT_DIR = 'command-registry';
const SAFE_ID = /^[A-Za-z0-9_-]{1,64}$/;

interface CacheEntry {
  registry: PluginCommandRegistry;
  fetchedAt: number;
  checkedAt: number;
}

const cache = new Map<string, CacheEntry>();
const inflight = new Map<
  string,
  { generation: number; promise: Promise<CommandRegistry | null> }
>();
// Bumped by every invalidation, so a refresh that started before it cannot
// mark its (possibly outdated) answer as fresh.
const generations = new Map<string, number>();
// After the plugin could not be asked, wait this long before asking again
// (every autocomplete reload would otherwise wait for an unreachable plugin).
export const UNAVAILABLE_RETRY_MS = 15_000;
const unavailableUntil = new Map<string, number>();

function generationOf(serverId: string): number {
  return generations.get(serverId) ?? 0;
}

function snapshotPath(serverId: string): string | null {
  return SAFE_ID.test(serverId)
    ? path.join(config.dataPath, SNAPSHOT_DIR, `${serverId}.json`)
    : null;
}

async function writeSnapshot(serverId: string, registry: PluginCommandRegistry): Promise<void> {
  const file = snapshotPath(serverId);
  if (!file) return;
  try {
    await fs.mkdir(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(registry), 'utf-8');
    await fs.rename(tmp, file);
  } catch (error) {
    logger.warn(
      `[CommandRegistry:${serverId}] could not save snapshot: ${error instanceof Error ? error.message : error}`,
    );
  }
}

async function readSnapshot(serverId: string): Promise<CacheEntry | null> {
  const file = snapshotPath(serverId);
  if (!file) return null;
  try {
    const [raw, stat] = await Promise.all([fs.readFile(file, 'utf-8'), fs.stat(file)]);
    const registry = JSON.parse(raw) as PluginCommandRegistry;
    if (!registry || typeof registry.revision !== 'string' || !Array.isArray(registry.commands)) {
      return null;
    }
    rememberServerCommands(serverId, registry.commands);
    // checkedAt 0: a snapshot is never trusted as fresh.
    return { registry, fetchedAt: stat.mtimeMs, checkedAt: 0 };
  } catch {
    return null;
  }
}

function view(
  serverId: string,
  entry: CacheEntry,
  source: CommandRegistry['source'],
  stale: boolean,
): CommandRegistry {
  return {
    ...entry.registry,
    serverId,
    source,
    stale,
    fetchedAt: new Date(entry.fetchedAt).toISOString(),
  };
}

async function refresh(
  serverId: string,
  force: boolean,
  generation: number,
): Promise<CommandRegistry | null> {
  const known = cache.get(serverId) ?? (await readSnapshot(serverId));
  const fromSnapshot = !cache.has(serverId);
  const result = await fetchCommandRegistry(serverId, force ? undefined : known?.registry.revision);
  const now = Date.now();
  // Invalidated meanwhile: keep the answer, but check again on the next call.
  const checkedAt = generationOf(serverId) === generation ? now : 0;

  // An invalidation meanwhile (plugin reconnected) allows the next try at once.
  if (result.kind !== 'unavailable') unavailableUntil.delete(serverId);
  else if (checkedAt !== 0) unavailableUntil.set(serverId, now + UNAVAILABLE_RETRY_MS);

  if (result.kind === 'registry') {
    const entry = { registry: result.registry, fetchedAt: now, checkedAt };
    cache.set(serverId, entry);
    rememberServerCommands(serverId, result.registry.commands);
    void writeSnapshot(serverId, result.registry);
    return view(serverId, entry, 'plugin', false);
  }
  if (result.kind === 'unchanged' && known) {
    const entry = { ...known, checkedAt };
    cache.set(serverId, entry);
    return view(serverId, entry, 'plugin', false);
  }
  if (result.kind === 'unavailable') {
    logger.debug(`[CommandRegistry:${serverId}] plugin registry unavailable: ${result.reason}`);
  }
  // Revision answered but nothing to compare against (should not happen), or
  // the plugin is unreachable: fall back to what we have.
  if (!known) return null;
  return view(serverId, known, fromSnapshot ? 'snapshot' : 'plugin', true);
}

/**
 * The command registry of a server, or null when neither the plugin nor a
 * saved snapshot has one. `force` refetches the full list.
 */
export async function getCommandRegistry(
  serverId?: string,
  options: { force?: boolean } = {},
): Promise<CommandRegistry | null> {
  const id = await resolveServerId(serverId);
  const entry = cache.get(id);
  if (entry && !options.force && Date.now() - entry.checkedAt < REGISTRY_TTL_MS) {
    return view(id, entry, 'plugin', false);
  }
  if (!options.force && (unavailableUntil.get(id) ?? 0) > Date.now()) {
    const known = entry ?? (await readSnapshot(id));
    return known ? view(id, known, entry ? 'plugin' : 'snapshot', true) : null;
  }
  const generation = generationOf(id);
  const running = inflight.get(id);
  if (running && running.generation === generation && !options.force) return running.promise;
  const pending = refresh(id, options.force === true, generation).finally(() => {
    if (inflight.get(id)?.promise === pending) inflight.delete(id);
  });
  inflight.set(id, { generation, promise: pending });
  return pending;
}

/**
 * Re-check the cached registry on its next use (plugin reported changed
 * commands, or the plugin connection was re-established after a restart).
 * The copy itself is kept so it can be revalidated by revision.
 */
export function invalidateCommandRegistry(serverId: string): void {
  generations.set(serverId, generationOf(serverId) + 1);
  unavailableUntil.delete(serverId);
  const entry = cache.get(serverId);
  if (entry) cache.set(serverId, { ...entry, checkedAt: 0 });
}

/** Test hook. */
export function clearCommandRegistryCache(): void {
  cache.clear();
  inflight.clear();
  generations.clear();
  unavailableUntil.clear();
}

// ---------------------------------------------------------------------------
// Helpers for consumers (autocomplete today, a registry-based whitelist later)
// ---------------------------------------------------------------------------

export interface FlatCommand {
  /** "/world add" — root name plus subcommand names. */
  path: string;
  aliases: string[];
  permission?: string;
  owner?: string;
  builtin?: boolean;
  depth: number;
}

/** Every command and subcommand as a flat list of paths, roots first. */
export function flattenCommands(registry: Pick<PluginCommandRegistry, 'commands'>): FlatCommand[] {
  const out: FlatCommand[] = [];
  const walk = (node: CommandNode, prefix: string, depth: number) => {
    const p = `${prefix} ${node.name}`.trim();
    out.push({
      path: p.startsWith('/') ? p : `/${p}`,
      aliases: node.aliases ?? [],
      permission: node.permission,
      owner: node.owner,
      builtin: node.builtin,
      depth,
    });
    for (const sub of node.subcommands ?? []) walk(sub, p.startsWith('/') ? p : `/${p}`, depth + 1);
  };
  for (const root of registry.commands) walk(root, '', 0);
  return out;
}

/**
 * Commands and subcommands annotated with the console tier the panel requires
 * for each (utils/commandWhitelist.ts resolves console lines the same way),
 * so the UI can mark admin commands.
 */
export function withPanelPolicy<T extends CommandShape = CommandNode>(
  commands: readonly T[],
): WithPanelPolicy<T>[] {
  return annotateCommands(commands);
}
