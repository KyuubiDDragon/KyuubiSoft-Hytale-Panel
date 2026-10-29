/**
 * Links in a server's own mods folder: whoever runs code on the server can put
 * a link there to another server's mod jars (in the manager, a relative link
 * resolves into that server's folders). The wiki scan and the mod list only
 * read regular files of the folder itself.
 */
import { describe, it, expect, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { serverContextIn } from '../test/serverContextStub.js';

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kp-mod-links-')));
process.env.MANAGER_DATA_PATH = path.join(root, 'manager');

const { regenerateWiki } = await import('./wiki.js');
const { scanDirectory } = await import('./managementHelpers.js');

afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

function canLink(): boolean {
  const probe = path.join(os.tmpdir(), `kp-link-probe-${process.pid}-${Date.now()}`);
  try {
    fs.symlinkSync(fileURLToPath(import.meta.url), probe, 'file');
    fs.unlinkSync(probe);
    return true;
  } catch {
    return false;
  }
}

const b = serverContextIn(path.join(root, 'b'));
const foreign = path.join(root, 'a', 'mods', 'Secret-1.0.jar');

describe.skipIf(!canLink())('a link in the mods folder', () => {
  it('is neither scanned for the wiki nor listed as a mod', async () => {
    fs.mkdirSync(b.paths.mods, { recursive: true });
    fs.mkdirSync(b.paths.plugins, { recursive: true });
    fs.mkdirSync(path.dirname(foreign), { recursive: true });
    fs.writeFileSync(foreign, 'PK\u0003\u0004 foreign');
    fs.writeFileSync(path.join(b.paths.mods, 'Own-1.0.jar'), 'PK\u0003\u0004 own');
    fs.symlinkSync(foreign, path.join(b.paths.mods, 'Secret-1.0.jar'), 'file');

    const wiki = await regenerateWiki(b);
    expect(wiki.entries.map((e) => e.fileName)).toEqual(['Own-1.0.jar']);

    const mods = await scanDirectory(b.paths.mods, 'mod');
    expect(mods.map((m) => m.filename)).toEqual(['Own-1.0.jar']);
  });
});
