import { describe, it, expect } from 'vitest';
import {
  isLiveInventory,
  liveFailureStatus,
  requireLiveInventory,
  toInventoryView,
} from './pluginLiveData.js';
import type { LivePlayerInventory } from './kyuubiApi.js';

const inventory: LivePlayerInventory = {
  uuid: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
  name: 'Steve',
  world: 'flat_world',
  sections: {
    hotbar: {
      capacity: 9,
      activeSlot: 2,
      items: [
        { slot: 4, itemId: 'Food_Bread', amount: 12 },
        {
          slot: 0,
          itemId: 'Tool_Pickaxe_Iron',
          amount: 1,
          durability: 87.5,
          maxDurability: 100,
        },
      ],
    },
    storage: { capacity: 36, items: [{ slot: 10, itemId: 'Rock_Stone', amount: 64 }] },
    armor: { capacity: 4, items: [] },
    utility: { capacity: 4, items: [] },
    tools: { capacity: 2, items: [] },
  },
  items: [],
  totalSlots: 55,
  usedSlots: 3,
};

describe('toInventoryView', () => {
  it('maps the live inventory onto the saved-file view', () => {
    const view = toInventoryView(inventory);
    expect(view.source).toBe('live');
    expect(view.activeHotbarSlot).toBe(2);
    expect(view.hotbar.map((i) => i.slot)).toEqual([0, 4]);
    expect(view.hotbar[0]).toEqual({
      slot: 0,
      itemId: 'Tool_Pickaxe_Iron',
      displayName: 'Iron Pickaxe',
      amount: 1,
      durability: 87.5,
      maxDurability: 100,
    });
    // Items without durability use 0/0 like the file view (full bar in the UI).
    expect(view.hotbar[1]).toMatchObject({ displayName: 'Bread', durability: 0, maxDurability: 0 });
    expect(view.storage).toHaveLength(1);
    expect(view.capacities).toEqual({
      hotbar: 9,
      storage: 36,
      armor: 4,
      utility: 4,
      tools: 2,
      backpack: 0,
    });
    // A missing section (no backpack) is empty, not absent.
    expect(view.backpack).toEqual([]);
    expect(view.totalSlots).toBe(55);
    expect(view.usedSlots).toBe(3);
  });

  it('falls back to slot 0 when no hotbar slot is active', () => {
    const view = toInventoryView({ ...inventory, sections: {} });
    expect(view.activeHotbarSlot).toBe(0);
    expect(view.hotbar).toEqual([]);
  });
});

describe('isLiveInventory / requireLiveInventory', () => {
  // What KyuubiSoft API 2.0.0 answers for an online player: 200 with no sections.
  const placeholder = {
    uuid: 'u',
    name: 'Steve',
    items: [],
    totalSlots: 36,
    usedSlots: 0,
  } as unknown as LivePlayerInventory;

  it('accepts an inventory with at least one real section', () => {
    expect(isLiveInventory(inventory)).toBe(true);
    expect(requireLiveInventory({ success: true, data: inventory })).toEqual({
      success: true,
      data: inventory,
    });
  });

  it('refuses the 2.0.0 placeholder and empty or malformed sections as 501', () => {
    expect(isLiveInventory(placeholder)).toBe(false);
    expect(isLiveInventory({ ...inventory, sections: {} })).toBe(false);
    expect(isLiveInventory({ ...inventory, sections: [] })).toBe(false);
    expect(isLiveInventory({ ...inventory, sections: { hotbar: { items: [] } } })).toBe(false);
    expect(isLiveInventory(null)).toBe(false);
    const refused = requireLiveInventory({ success: true, data: placeholder });
    expect(refused.success).toBe(false);
    expect(refused.status).toBe(501);
    expect(liveFailureStatus(refused)).toBe(501);
  });

  it('passes failed reads through unchanged', () => {
    const failed = { success: false, status: 404, error: 'Player is not online' };
    expect(requireLiveInventory(failed)).toBe(failed);
  });
});

describe('liveFailureStatus', () => {
  it('keeps the statuses the client can act on', () => {
    for (const status of [400, 404, 409, 501]) {
      expect(liveFailureStatus({ success: false, status })).toBe(status);
    }
  });

  it('maps everything else to 503', () => {
    expect(liveFailureStatus({ success: false })).toBe(503);
    expect(liveFailureStatus({ success: false, status: 500 })).toBe(503);
    expect(liveFailureStatus({ success: false, status: 504 })).toBe(503);
    expect(liveFailureStatus({ success: false, status: 404, authError: 'token_rejected' })).toBe(
      503,
    );
  });
});
