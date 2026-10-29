import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import path from 'path';
import os from 'os';
import fs from 'fs';

const serverDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kp-setup-config-'));
const lifecycle = { running: false, events: [] as string[] };
vi.mock('./serverInstall.js', () => ({
  resolveInstallPaths: async () => ({ serverPath: serverDir, backupsPath: serverDir }),
}));
vi.mock('./serverLifecycle.js', () => ({
  runWhileServerStopped: async (_id: unknown, _opts: unknown, fn: () => Promise<unknown>) =>
    lifecycle.running ? { ran: false } : { ran: true, value: await fn() },
  withServerStopped: async (_id: unknown, _opts: unknown, fn: () => Promise<unknown>) => {
    const was = lifecycle.running;
    lifecycle.events.push('stop');
    lifecycle.running = false;
    // On its way down the server saves its own copy.
    fs.writeFileSync(
      path.join(serverDir, 'config.json'),
      '{"Version":4,"ServerName":"From memory"}',
    );
    try {
      return await fn();
    } finally {
      if (was) {
        lifecycle.events.push('start');
        lifecycle.running = true;
      }
    }
  },
  startServer: async () => {
    if (!lifecycle.running) lifecycle.events.push('start');
    lifecycle.running = true;
    return { ok: true, method: 'docker' };
  },
}));

const {
  buildWizardServerConfig,
  restartWithWizardConfig,
  validateSecurityStep,
  validateServerStep,
  validateViewRadius,
  writeWizardServerConfig,
  WIZARD_DEFAULTS,
} = await import('./setupServerConfig.js');
type WizardServerSettings = import('./setupServerConfig.js').WizardServerSettings;
const { parseHytaleConfig } = await import('../schemas/hytaleConfig.js');

afterAll(() => fs.rmSync(serverDir, { recursive: true, force: true }));

const SERVER: WizardServerSettings = {
  name: 'My Server',
  motd: 'Hello',
  maxPlayers: 20,
  gameMode: 'Creative',
  password: '',
  whitelist: true,
  allowOp: true,
};

describe('wizard steps', () => {
  it('accepts the server step and keeps the security fields of an earlier save', () => {
    const r = validateServerStep(
      { name: ' My Server ', motd: 'Hi', maxPlayers: 50, gameMode: 'creative' },
      { password: 'secret', whitelist: true, allowOp: false },
    );
    expect(r).toEqual({
      ok: true,
      value: {
        name: 'My Server',
        motd: 'Hi',
        maxPlayers: 50,
        gameMode: 'Creative',
        password: 'secret',
        whitelist: true,
        allowOp: false,
      },
    });
  });

  it('refuses game modes Hytale does not have and invalid values', () => {
    expect(validateServerStep({ gameMode: 'Survival' }).ok).toBe(false);
    expect(validateServerStep({ gameMode: 'Spectator' }).ok).toBe(false);
    expect(validateServerStep({ maxPlayers: -5 }).ok).toBe(false);
    expect(validateServerStep({ name: 'x'.repeat(65) }).ok).toBe(false);
    expect(validateServerStep({ motd: 'a\nb' }).ok).toBe(false);
    expect(validateServerStep({}).ok).toBe(true);
  });

  it('defaults to the safe security settings', () => {
    const r = validateSecurityStep({});
    expect(r.ok && r.value).toMatchObject({ whitelist: false, allowOp: false, password: '' });
    expect(WIZARD_DEFAULTS.allowOp).toBe(false);
    const set = validateSecurityStep(
      { password: null, whitelist: true },
      { ...SERVER, password: 'x' },
    );
    expect(set.ok && set.value).toMatchObject({
      name: 'My Server',
      password: '',
      whitelist: true,
      allowOp: true,
    });
    expect(validateSecurityStep({ password: 'x'.repeat(200) }).ok).toBe(false);
  });

  it('checks the view radius against the server limit', () => {
    expect(validateViewRadius(undefined)).toEqual({ ok: true, value: 16 });
    expect(validateViewRadius(32)).toEqual({ ok: true, value: 32 });
    expect(validateViewRadius(33).ok).toBe(false);
    // A range input sends text.
    expect(validateViewRadius('20')).toEqual({ ok: true, value: 20 });
    expect(validateViewRadius('20.5').ok).toBe(false);
    expect(validateViewRadius('64').ok).toBe(false);
  });
});

describe('buildWizardServerConfig', () => {
  it('writes only real server fields for a fresh install', () => {
    const { config, changes } = buildWizardServerConfig(null, {
      server: SERVER,
      viewRadius: 12,
      autoUpdate: true,
      preserveExisting: false,
    });
    expect(config).toEqual({
      ServerName: 'My Server',
      MOTD: 'Hello',
      MaxPlayers: 20,
      RequireJoinPermission: true,
      MaxViewRadius: 12,
      Password: '',
      Defaults: { GameMode: 'Creative' },
      Update: { Enabled: true, AutoApplyMode: 'WhenEmpty' },
    });
    expect(changes).toEqual([]);
    expect(parseHytaleConfig(config)).toMatchObject({ ok: true, warnings: [] });
  });

  it('cleans what older panels wrote and keeps the rest of the file', () => {
    const current = {
      Version: 4,
      Whitelist: true,
      AllowOp: true,
      ViewRadius: 10,
      Mods: { 'a:b': { Enabled: true } },
      Defaults: { World: 'default', GameMode: 'Adventure' },
      updateConfig: { enabled: true },
    };
    const before = JSON.parse(JSON.stringify(current));
    const { config, changes } = buildWizardServerConfig(current, {
      server: { ...SERVER, gameMode: 'Adventure' },
      autoUpdate: false,
      preserveExisting: false,
    });
    for (const key of ['Whitelist', 'AllowOp', 'ViewRadius', 'updateConfig']) {
      expect(config).not.toHaveProperty(key);
    }
    expect(config).toMatchObject({
      Version: 4,
      MaxViewRadius: 10,
      Mods: { 'a:b': { Enabled: true } },
      Defaults: { World: 'default', GameMode: 'Adventure' },
      Update: { Enabled: true, AutoApplyMode: 'Disabled' },
    });
    expect(changes.map((c) => c.key)).toEqual(['Whitelist', 'AllowOp', 'ViewRadius']);
    expect(current).toEqual(before);
  });

  it('keeps the values of an adopted installation, except a typed password', () => {
    const current = {
      ServerName: 'Old',
      MOTD: 'Old motd',
      MaxPlayers: 5,
      Password: 'old',
      RequireJoinPermission: false,
      MaxViewRadius: 8,
      Defaults: { GameMode: 'Creative' },
    };
    const kept = buildWizardServerConfig(current, {
      server: { ...SERVER, gameMode: 'Adventure' },
      viewRadius: 16,
      autoUpdate: false,
      preserveExisting: true,
    }).config;
    expect(kept).toMatchObject({ ...current });
    const rotated = buildWizardServerConfig(current, {
      server: { ...SERVER, password: 'new' },
      autoUpdate: false,
      preserveExisting: true,
    }).config;
    expect(rotated.Password).toBe('new');
  });

  it('repairs a game mode an older wizard stored', () => {
    const { config } = buildWizardServerConfig(null, {
      server: { ...SERVER, gameMode: 'Survival' as never },
      autoUpdate: false,
      preserveExisting: false,
    });
    expect(config.Defaults).toEqual({ GameMode: 'Adventure' });
  });

  it('leaves a file that is not a JSON object alone', () => {
    expect(() =>
      buildWizardServerConfig([1, 2], {
        server: SERVER,
        autoUpdate: false,
        preserveExisting: false,
      }),
    ).toThrow(/JSON object/);
  });
});

describe('writing config.json at the end of the setup', () => {
  const input = { server: SERVER, viewRadius: 12, autoUpdate: false, preserveExisting: false };
  const configFile = path.join(serverDir, 'config.json');
  beforeEach(() => {
    fs.rmSync(configFile, { force: true });
    lifecycle.running = false;
    lifecycle.events = [];
  });

  it('writes right away while the server is stopped', async () => {
    expect(await writeWizardServerConfig(input)).toEqual({
      written: true,
      pending: false,
      changes: [],
    });
    expect(JSON.parse(fs.readFileSync(configFile, 'utf-8'))).toMatchObject({
      ServerName: 'My Server',
      RequireJoinPermission: true,
      MaxViewRadius: 12,
    });
  });

  it('leaves a running server alone and writes between stop and start of the final restart', async () => {
    lifecycle.running = true;
    expect(await writeWizardServerConfig(input)).toEqual({
      written: false,
      pending: true,
      changes: [],
    });
    expect(fs.existsSync(configFile)).toBe(false);
    const r = await restartWithWizardConfig(input);
    expect(r).toMatchObject({ written: true, pending: false });
    expect(lifecycle.events).toEqual(['stop', 'start']);
    // Written after the server saved its own copy, on top of it.
    expect(JSON.parse(fs.readFileSync(configFile, 'utf-8'))).toMatchObject({
      Version: 4,
      ServerName: 'My Server',
      MaxPlayers: 20,
    });
    expect(lifecycle.running).toBe(true);
  });

  it('reports a config.json it will not touch instead of throwing', async () => {
    fs.writeFileSync(configFile, '[1]');
    const r = await writeWizardServerConfig(input);
    expect(r.written).toBe(false);
    expect(r.error).toMatch(/JSON object/);
    expect(fs.readFileSync(configFile, 'utf-8')).toBe('[1]');
  });
});
