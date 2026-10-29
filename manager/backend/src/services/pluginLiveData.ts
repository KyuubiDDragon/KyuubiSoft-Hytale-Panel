/**
 * Panel-side helpers for the plugin's live-data endpoints: maps the live
 * inventory onto the view the player modal already renders for the saved
 * player file, and turns a failed plugin read into the HTTP status to answer.
 */

import { formatItemName, type ParsedInventoryItem } from './players.js';
import type {
  LiveInventoryItem,
  LiveInventorySectionId,
  LivePlayerInventory,
  PluginApiResponse,
} from './kyuubiApi.js';

/** Same shape as the saved-file inventory, plus where the data came from. */
export interface LiveInventoryView {
  source: 'live';
  uuid: string;
  name: string;
  world?: string;
  hotbar: ParsedInventoryItem[];
  storage: ParsedInventoryItem[];
  armor: ParsedInventoryItem[];
  utility: ParsedInventoryItem[];
  tools: ParsedInventoryItem[];
  backpack: ParsedInventoryItem[];
  activeHotbarSlot: number;
  totalSlots: number;
  usedSlots: number;
  capacities: Record<LiveInventorySectionId, number>;
}

function toItem(item: LiveInventoryItem): ParsedInventoryItem {
  return {
    slot: item.slot,
    itemId: item.itemId,
    displayName: formatItemName(item.itemId),
    amount: item.amount,
    // The file view uses 0/0 for "no durability"; the modal then shows a full bar.
    durability: item.durability ?? 0,
    maxDurability: item.maxDurability ?? 0,
  };
}

const SECTION_IDS: readonly LiveInventorySectionId[] = [
  'hotbar',
  'storage',
  'armor',
  'utility',
  'tools',
  'backpack',
];

/**
 * Does the plugin's answer hold a real inventory? KyuubiSoft API 2.0.0 answers
 * the same path with 200 and an empty placeholder (`{ items: [], totalSlots: 36 }`,
 * no `sections`), which must not replace the saved player file in the modal.
 */
export function isLiveInventory(inv: unknown): inv is LivePlayerInventory {
  if (!inv || typeof inv !== 'object') return false;
  const sections = (inv as { sections?: unknown }).sections;
  if (!sections || typeof sections !== 'object' || Array.isArray(sections)) return false;
  return SECTION_IDS.some((id) => {
    const section = (sections as Record<string, unknown>)[id];
    return (
      !!section &&
      typeof section === 'object' &&
      typeof (section as { capacity?: unknown }).capacity === 'number'
    );
  });
}

/**
 * The plugin's live inventory read, or a 501 refusal ("not offered") when the
 * plugin only sent a placeholder, so the client falls back to the player file.
 */
export function requireLiveInventory(
  result: PluginApiResponse & { data?: LivePlayerInventory },
): PluginApiResponse & { data?: LivePlayerInventory } {
  if (!result.success || result.data === undefined || isLiveInventory(result.data)) return result;
  return {
    success: false,
    status: 501,
    error: 'The plugin sent no live inventory (KyuubiSoft API 2.1 or newer is needed)',
  };
}

export function toInventoryView(inv: LivePlayerInventory): LiveInventoryView {
  // requireLiveInventory has checked the shape; a missing section is just empty.
  const sections = inv.sections ?? {};
  const items = (id: LiveInventorySectionId): ParsedInventoryItem[] =>
    (sections[id]?.items ?? []).map(toItem).sort((a, b) => a.slot - b.slot);
  const capacity = (id: LiveInventorySectionId): number => sections[id]?.capacity ?? 0;
  return {
    source: 'live',
    uuid: inv.uuid,
    name: inv.name,
    world: inv.world,
    hotbar: items('hotbar'),
    storage: items('storage'),
    armor: items('armor'),
    utility: items('utility'),
    tools: items('tools'),
    backpack: items('backpack'),
    activeHotbarSlot: sections.hotbar?.activeSlot ?? 0,
    totalSlots: inv.totalSlots,
    usedSlots: inv.usedSlots,
    capacities: {
      hotbar: capacity('hotbar'),
      storage: capacity('storage'),
      armor: capacity('armor'),
      utility: capacity('utility'),
      tools: capacity('tools'),
      backpack: capacity('backpack'),
    },
  };
}

/**
 * HTTP status for a failed live read: the plugin's own answer where it means
 * something to the client (404 offline, 409 changing worlds, 501 not offered
 * by this server build), otherwise 503 (plugin unreachable or refusing).
 */
export function liveFailureStatus(result: PluginApiResponse): number {
  if (result.authError) return 503;
  switch (result.status) {
    case 400:
    case 404:
    case 409:
    case 501:
      return result.status;
    default:
      return 503;
  }
}
