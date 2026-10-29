/**
 * Files the generic file manager leaves alone: the setup state (game server
 * password, store keys) and the keys of the encrypted server login are not
 * shown at all; world files in the server folder can be read, but changes go
 * through the world editor, which validates them and writes while the server
 * is stopped.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  deleteFile,
  FileManagerError,
  isAbsolutePathAllowed,
  listDir,
  moveFile,
  readFile,
  uploadFile,
  writeFile,
  type FileManagerFolders,
} from './fileManager.js';

let base: string;
let folders: FileManagerFolders;
const WORLD = 'universe/worlds/Main';

beforeAll(() => {
  base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fm-editors-')));
  folders = {
    server: path.join(base, 'server'),
    data: path.join(base, 'data'),
    mods: path.join(base, 'mods'),
    plugins: path.join(base, 'plugins'),
  };
  for (const dir of Object.values(folders)) fs.mkdirSync(dir, { recursive: true });
  fs.mkdirSync(path.join(folders.server, WORLD, 'resources'), { recursive: true });
  fs.writeFileSync(path.join(folders.server, WORLD, 'resources', 'Time.json'), '{"t":1}');
  for (const name of ['setup-config.json', 'setup-config.json.bak', '.machine-id', 'notes.txt']) {
    fs.writeFileSync(path.join(folders.data, name), 'secret');
  }
});

afterAll(() => fs.rmSync(base, { recursive: true, force: true }));

async function refusal(op: Promise<unknown>): Promise<FileManagerError> {
  const err = await op.then(
    () => null,
    (e) => e,
  );
  expect(err).toBeInstanceOf(FileManagerError);
  expect((err as FileManagerError).status).toBe(403);
  return err as FileManagerError;
}

describe('secrets in the data folder', () => {
  it('neither lists nor reads the setup state or the machine id', async () => {
    const names = (await listDir(folders, 'data', '')).entries.map((e) => e.name);
    expect(names).toEqual(['notes.txt']);
    await refusal(readFile(folders, 'data', 'setup-config.json'));
    await refusal(readFile(folders, 'data', '.machine-id'));
    expect(
      isAbsolutePathAllowed(folders, path.join(folders.data, 'setup-config.json.bak'), 'read'),
    ).toBe(false);
  });
});

describe('world files in the server folder', () => {
  const time = `${WORLD}/resources/Time.json`;

  it('can be read', async () => {
    expect((await readFile(folders, 'server', time)).content).toBe('{"t":1}');
    expect(isAbsolutePathAllowed(folders, path.join(folders.server, time), 'read')).toBe(true);
  });

  it('are changed only through the world editor', async () => {
    const err = await refusal(writeFile(folders, 'server', time, '{"t":2}'));
    expect(err.message).toMatch(/Worlds page/);
    await refusal(deleteFile(folders, 'server', time));
    await refusal(moveFile(folders, 'server', time, 'Time.json'));
    await refusal(deleteFile(folders, 'server', WORLD));
    await refusal(
      uploadFile(folders, 'server', `${WORLD}/resources`, {
        buffer: Buffer.from('{}'),
        originalname: 'Weather.json',
        size: 2,
      }),
    );
    expect(isAbsolutePathAllowed(folders, path.join(folders.server, time), 'write')).toBe(false);
    expect(fs.readFileSync(path.join(folders.server, time), 'utf-8')).toBe('{"t":1}');
  });

  it('covers JSON files deeper inside a world', async () => {
    const deep = `${WORLD}/resources/spawns/Village.json`;
    fs.mkdirSync(path.join(folders.server, path.dirname(deep)), { recursive: true });
    fs.writeFileSync(path.join(folders.server, deep), '{"v":1}');

    await refusal(writeFile(folders, 'server', deep, '{"v":2}'));
    await refusal(deleteFile(folders, 'server', deep));
    expect(isAbsolutePathAllowed(folders, path.join(folders.server, deep), 'write')).toBe(false);
    expect(fs.readFileSync(path.join(folders.server, deep), 'utf-8')).toBe('{"v":1}');
  });

  it('leaves other server files writable', async () => {
    await writeFile(folders, 'server', 'server.properties', 'motd=hi');
    expect(fs.readFileSync(path.join(folders.server, 'server.properties'), 'utf-8')).toBe(
      'motd=hi',
    );
    await writeFile(folders, 'server', 'universe/notes.txt', 'kept');
    expect(fs.readFileSync(path.join(folders.server, 'universe/notes.txt'), 'utf-8')).toBe('kept');
  });

  // Last: without the lock these would take every world with them.
  it('keeps the folders that hold the worlds', async () => {
    await refusal(deleteFile(folders, 'server', 'universe/worlds'));
    await refusal(moveFile(folders, 'server', 'universe/worlds', 'worlds-old'));
    const err = await refusal(deleteFile(folders, 'server', 'universe'));
    expect(err.message).toMatch(/Worlds page/);
    await refusal(moveFile(folders, 'server', 'universe', 'universe-old'));
    expect(fs.existsSync(path.join(folders.server, WORLD, 'resources', 'Time.json'))).toBe(true);
  });
});
