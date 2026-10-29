/**
 * Test helper: a server context whose folders all lie below `root`, for
 * services that take the server they work on as an argument.
 */
import path from 'path';
import type { ServerContext } from '../services/serverContext.js';

export function serverContextIn(root: string, id = 'srv-b'): ServerContext {
  const dir = (name: string) => path.join(root, name);
  const containerName = `hytale-srv-${id}`;
  return {
    id,
    kind: id === 'default' ? 'compose' : 'managed',
    name: `Server ${id}`,
    containerName,
    paths: {
      server: dir('server'),
      data: dir('data'),
      backups: dir('backups'),
      mods: dir('mods'),
      plugins: dir('plugins'),
      assets: dir('assets'),
      auth: dir('auth'),
    },
    network: { serverPort: 5520, webMapPort: 18081, webMapWsPort: 18082 },
    plugin: { host: containerName, port: 18085 },
  };
}
