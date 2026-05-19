/**
 * Docker control for one or more Hytale server containers.
 *
 * Every public function takes an optional `serverId`. When omitted the
 * default server from the registry (services/servers.ts) is used so all
 * legacy /api/server/* callers keep working unchanged. Multi-server clients
 * pass an explicit id, normally injected by the /api/servers/:id/* mount
 * point that copies req.params.serverId onto req.serverId.
 *
 * The registry is the single source of truth for container names, ports
 * and on-disk paths — never read these from `config.*` directly inside
 * Docker calls, because that would silently ignore multi-server setups.
 */
import Docker from 'dockerode';
import { config } from '../config.js';
import type { ServerStatus, ServerStats, ActionResponse } from '../types/index.js';
import { validateCommand, escapeShellArg } from '../utils/sanitize.js';
import { clearOnlinePlayers } from './players.js';
import { isDemoMode, getDemoStatus, getDemoStats, getDemoLogs } from './demoData.js';
import { ensureLoaded, getDefaultId, getServer } from './servers.js';

const docker = new Docker({ socketPath: '/var/run/docker.sock' });

/** Resolve the container name for an explicit or default server id. */
async function resolveContainerName(serverId?: string): Promise<string> {
  // Fast path for legacy single-server boot before servers.json exists.
  if (!serverId) {
    try {
      const id = await getDefaultId();
      const s = await getServer(id);
      return s?.containerName ?? config.gameContainerName;
    } catch {
      return config.gameContainerName;
    }
  }
  const s = await getServer(serverId);
  if (!s) throw new Error(`Unknown server id: ${serverId}`);
  return s.containerName;
}

async function getContainer(serverId?: string): Promise<Docker.Container | null> {
  try {
    const name = await resolveContainerName(serverId);
    return docker.getContainer(name);
  } catch {
    return null;
  }
}

export async function getStatus(serverId?: string): Promise<ServerStatus> {
  if (isDemoMode()) return getDemoStatus();
  try {
    const container = await getContainer(serverId);
    if (!container) return { status: 'not_found', running: false, error: 'Container not found' };
    const info = await container.inspect();
    return {
      status: info.State.Status,
      running: info.State.Running,
      id: info.Id.substring(0, 12),
      name: info.Name.replace('/', ''),
      created: info.Created,
      started_at: info.State.StartedAt,
    };
  } catch (error) {
    return { status: 'error', running: false, error: error instanceof Error ? error.message : 'Unknown error' };
  }
}

export async function getStats(serverId?: string): Promise<ServerStats> {
  if (isDemoMode()) return getDemoStats();
  try {
    const container = await getContainer(serverId);
    if (!container) return { error: 'Container not found' };
    const info = await container.inspect();
    if (!info.State.Running) return { error: 'Container not running' };
    const stats = await container.stats({ stream: false });
    const cpuDelta = stats.cpu_stats.cpu_usage.total_usage - stats.precpu_stats.cpu_usage.total_usage;
    const systemDelta = stats.cpu_stats.system_cpu_usage - stats.precpu_stats.system_cpu_usage;
    const cpuCount = stats.cpu_stats.online_cpus || 1;
    const cpuPercent = systemDelta > 0 ? (cpuDelta / systemDelta) * cpuCount * 100 : 0;
    const memoryUsage = stats.memory_stats.usage || 0;
    const memoryLimit = stats.memory_stats.limit || 1;
    const memoryPercent = (memoryUsage / memoryLimit) * 100;
    return {
      cpu_percent: Math.round(cpuPercent * 100) / 100,
      memory_bytes: memoryUsage,
      memory_limit_bytes: memoryLimit,
      memory_percent: Math.round(memoryPercent * 100) / 100,
      memory_mb: Math.round(memoryUsage / (1024 * 1024) * 10) / 10,
      memory_limit_mb: Math.round(memoryLimit / (1024 * 1024) * 10) / 10,
    };
  } catch (error) {
    return { error: error instanceof Error ? error.message : 'Unknown error' };
  }
}

export async function startContainer(serverId?: string): Promise<ActionResponse> {
  if (isDemoMode()) return { success: true, message: '[DEMO] Container started' };
  try {
    const container = await getContainer(serverId);
    if (!container) return { success: false, error: 'Container not found' };
    await container.start();
    return { success: true, message: 'Container started' };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
  }
}

export async function stopContainer(serverId?: string): Promise<ActionResponse> {
  if (isDemoMode()) return { success: true, message: '[DEMO] Container stopped' };
  try {
    const container = await getContainer(serverId);
    if (!container) return { success: false, error: 'Container not found' };
    await container.stop({ t: 30 });
    clearOnlinePlayers();
    return { success: true, message: 'Container stopped' };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
  }
}

export async function restartContainer(serverId?: string): Promise<ActionResponse> {
  if (isDemoMode()) return { success: true, message: '[DEMO] Container restarted' };
  try {
    const container = await getContainer(serverId);
    if (!container) return { success: false, error: 'Container not found' };
    await container.restart({ t: 30 });
    clearOnlinePlayers();
    return { success: true, message: 'Container restarted' };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
  }
}

export async function getLogs(tail: number = 100, serverId?: string): Promise<string> {
  if (isDemoMode()) return getDemoLogs(tail);
  try {
    const container = await getContainer(serverId);
    if (!container) return '';
    const logs = await container.logs({ stdout: true, stderr: true, tail, timestamps: true });
    return logs.toString('utf-8');
  } catch {
    return '';
  }
}

// Stdin streams are kept per-server so we don't accidentally pipe a command
// for server A into server B's container shell.
const stdinStreams = new Map<string, NodeJS.WritableStream>();

async function ensureStdinAttached(serverId?: string): Promise<{ ok: boolean; key: string }> {
  const key = serverId ?? '__default__';
  const existing = stdinStreams.get(key);
  if (existing) return { ok: true, key };
  try {
    const container = await getContainer(serverId);
    if (!container) return { ok: false, key };
    const info = await container.inspect();
    if (!info.State.Running) return { ok: false, key };
    const stream = await container.attach({ stream: true, stdin: true, stdout: false, stderr: false, hijack: true });
    stdinStreams.set(key, stream);
    stream.on('error', () => stdinStreams.delete(key));
    stream.on('close', () => stdinStreams.delete(key));
    return { ok: true, key };
  } catch (error) {
    console.error('Failed to attach stdin:', error);
    return { ok: false, key };
  }
}

export async function execCommand(command: string, serverId?: string): Promise<ActionResponse> {
  if (isDemoMode()) {
    const validation = validateCommand(command);
    if (!validation.valid) return { success: false, error: validation.error || 'Invalid command' };
    return { success: true, message: `[DEMO] Command executed: ${command}` };
  }
  try {
    const validation = validateCommand(command);
    if (!validation.valid) {
      console.warn(`[SECURITY] Blocked command: ${command.substring(0, 50)}... Reason: ${validation.error}`);
      return { success: false, error: validation.error || 'Invalid command' };
    }
    const container = await getContainer(serverId);
    if (!container) return { success: false, error: 'Container not found' };
    const info = await container.inspect();
    if (!info.State.Running) return { success: false, error: 'Container not running' };

    const attached = await ensureStdinAttached(serverId);
    const stream = attached.ok ? stdinStreams.get(attached.key) : undefined;
    if (stream) {
      try {
        stream.write(command + '\n');
        return { success: true, message: `Command executed: ${command}` };
      } catch {
        stdinStreams.delete(attached.key);
      }
    }

    const escapedCommand = escapeShellArg(command);
    const exec = await container.exec({
      Cmd: ['sh', '-c', `
        if command -v screen > /dev/null && screen -list | grep -q hytale; then
          screen -S hytale -p 0 -X stuff ${escapedCommand}$'\n'
        elif [ -p /tmp/server_input ]; then
          echo ${escapedCommand} > /tmp/server_input
        else
          echo ${escapedCommand} >> /proc/1/fd/0
        fi
      `],
      AttachStdout: true,
      AttachStderr: true,
    });
    const execStream = await exec.start({});
    return new Promise((resolve) => {
      execStream.on('end', () => resolve({ success: true, message: `Command sent: ${command}` }));
      execStream.on('error', (err: Error) => resolve({ success: false, error: err.message }));
      setTimeout(() => resolve({ success: true, message: `Command sent: ${command}` }), 1000);
    });
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
  }
}

export async function execInContainer(command: string, serverId?: string): Promise<ActionResponse & { output?: string }> {
  if (isDemoMode()) {
    if (command.includes('stats memory')) {
      const { getDemoMemoryStats } = await import('./demoData.js');
      return { success: true, output: getDemoMemoryStats().raw };
    }
    return { success: true, output: '[DEMO] Command executed' };
  }
  try {
    const container = await getContainer(serverId);
    if (!container) return { success: false, error: 'Container not found' };
    const info = await container.inspect();
    if (!info.State.Running) return { success: false, error: 'Container not running' };
    const exec = await container.exec({ Cmd: ['sh', '-c', command], AttachStdout: true, AttachStderr: true });
    const stream = await exec.start({});
    return new Promise((resolve) => {
      let output = '';
      stream.on('data', (chunk: Buffer) => { output += chunk.toString('utf8'); });
      stream.on('end', () => resolve({ success: true, output: output.replace(/[\x00-\x08]/g, '').trim() }));
      stream.on('error', (err: Error) => resolve({ success: false, error: err.message }));
      setTimeout(() => resolve({ success: true, output: output.replace(/[\x00-\x08]/g, '').trim() }), 5000);
    });
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
  }
}

export function getDockerInstance(): Docker {
  return docker;
}

/**
 * Synchronous lookup — preserved for the few legacy call sites that need
 * a container name without an async boundary. Returns the registry value
 * when servers.json has been loaded, otherwise the env-var default.
 */
export function getContainerName(): string {
  // ensureLoaded is fire-and-forget here; the registry sync-cache fills in
  // after the first call. Until then we serve the env-var default which
  // happens to also be the default-server's container name on fresh installs.
  void ensureLoaded();
  return config.gameContainerName;
}
