/**
 * Server lists of users and API keys follow the registry: a deleted server
 * leaves no id behind, and a server that appears under an id a list still
 * names (left over from a clean-up that failed) starts without those grants.
 */
import { onServerAdded, onServerDeleted } from './servers.js';
import { removeServerFromAllowedLists } from './users.js';
import { removeServerFromKeyLists } from './apiKeys.js';

let installed = false;

async function prune(serverId: string, reason: string): Promise<void> {
  const users = await removeServerFromAllowedLists(serverId);
  const keys = removeServerFromKeyLists(serverId);
  if (users + keys > 0) {
    console.log(
      `[ServerLists] ${reason}: removed server ${serverId} from ${users} user and ${keys} key lists`,
    );
  }
}

/** Hook the clean-up into the registry. Idempotent; called at startup. */
export function installServerListCleanup(): void {
  if (installed) return;
  installed = true;
  onServerDeleted((serverId) => prune(serverId, 'server deleted'));
  onServerAdded((server) => prune(server.id, 'server added'));
}
