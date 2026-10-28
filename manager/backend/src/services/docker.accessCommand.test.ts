/**
 * The gate for the access pages' commands (docker.sendAccessCommand): only the
 * exact whitelist, ban and permission shapes the panel builds reach the
 * server; anything else, a second line in particular, is refused before it is
 * delivered.
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('./demoData.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./demoData.js')>()),
  // Demo delivery answers without a server, so an accepted command is visible as `via: 'demo'`.
  isDemoMode: () => true,
}));

const { sendAccessCommand } = await import('./docker.js');

const A = '0a1b2c3d-0000-4000-8000-00000000000a';

async function accepted(command: string): Promise<boolean> {
  const result = await sendAccessCommand(command);
  if (result.success) expect(result.via).toBe('demo');
  else expect(result.error).toBe('Not an access command');
  return result.success;
}

describe('sendAccessCommand', () => {
  it('lets the access commands through', async () => {
    for (const command of [
      '/whitelist enable',
      '/whitelist disable',
      '/whitelist add Bob_1',
      `/whitelist remove ${A}`,
      `/perm user add ${A} hytale.server.join`,
      `/perm user remove ${A} -a.b.*`,
      `/perm user group add ${A} hytale:Admin`,
      '/perm group add Mods kick.use',
      '/perm group remove Mods kick.use',
      '/ban Bob',
      '/ban Bob griefing at spawn!',
      `/unban ${A}`,
    ]) {
      expect(await accepted(command), command).toBe(true);
    }
  });

  it('refuses other commands and argument shapes', async () => {
    for (const command of [
      '/op add Bob',
      '/perm reload',
      '/whitelist clear',
      '/perm user add Bob hytale.server.join',
      `/perm user add ${A} *`,
      `/perm user add ${A} a b`,
      '/ban Bob "quoted"',
      '/ban Bob a,b',
      '/ban Bob --help',
      '/ban Bob two  spaces',
      '/ban Bob trailing ',
      `/ban Bob ${'x'.repeat(201)}`,
      '/ban --help',
      '/whitelist add -Bob',
      '/ban Bob\n/stop',
      '/whitelist enable\r',
    ]) {
      expect(await accepted(command), JSON.stringify(command)).toBe(false);
    }
  });
});
