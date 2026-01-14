import Docker from 'dockerode';
import { config } from '../config.js';
import type { ServerStatus, ServerStats, ActionResponse } from '../types/index.js';

const docker = new Docker({ socketPath: '/var/run/docker.sock' });

async function getContainer(): Promise<Docker.Container | null> {
  try {
    return docker.getContainer(config.gameContainerName);
  } catch {
    return null;
  }
}

export async function getStatus(): Promise<ServerStatus> {
  try {
    const container = await getContainer();
    if (!container) {
      return {
        status: 'not_found',
        running: false,
        error: 'Container not found',
      };
    }

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
    return {
      status: 'error',
      running: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}

export async function getStats(): Promise<ServerStats> {
  try {
    const container = await getContainer();
    if (!container) {
      return { error: 'Container not found' };
    }

    const info = await container.inspect();
    if (!info.State.Running) {
      return { error: 'Container not running' };
    }

    const stats = await container.stats({ stream: false });

    // Calculate CPU percentage
    const cpuDelta = stats.cpu_stats.cpu_usage.total_usage - stats.precpu_stats.cpu_usage.total_usage;
    const systemDelta = stats.cpu_stats.system_cpu_usage - stats.precpu_stats.system_cpu_usage;
    const cpuCount = stats.cpu_stats.online_cpus || 1;
    const cpuPercent = systemDelta > 0 ? (cpuDelta / systemDelta) * cpuCount * 100 : 0;

    // Memory usage
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

export async function startContainer(): Promise<ActionResponse> {
  try {
    const container = await getContainer();
    if (!container) {
      return { success: false, error: 'Container not found' };
    }

    await container.start();
    return { success: true, message: 'Container started' };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
  }
}

export async function stopContainer(): Promise<ActionResponse> {
  try {
    const container = await getContainer();
    if (!container) {
      return { success: false, error: 'Container not found' };
    }

    await container.stop({ t: 30 });
    return { success: true, message: 'Container stopped' };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
  }
}

export async function restartContainer(): Promise<ActionResponse> {
  try {
    const container = await getContainer();
    if (!container) {
      return { success: false, error: 'Container not found' };
    }

    await container.restart({ t: 30 });
    return { success: true, message: 'Container restarted' };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
  }
}

export async function getLogs(tail: number = 100): Promise<string> {
  try {
    const container = await getContainer();
    if (!container) {
      return '';
    }

    const logs = await container.logs({
      stdout: true,
      stderr: true,
      tail,
      timestamps: true,
    });

    return logs.toString('utf-8');
  } catch {
    return '';
  }
}

// Store the stdin stream for the container
let stdinStream: NodeJS.WritableStream | null = null;
let stdinAttached = false;

async function ensureStdinAttached(): Promise<boolean> {
  if (stdinAttached && stdinStream) {
    return true;
  }

  try {
    const container = await getContainer();
    if (!container) {
      return false;
    }

    const info = await container.inspect();
    if (!info.State.Running) {
      return false;
    }

    // Attach to container stdin
    const stream = await container.attach({
      stream: true,
      stdin: true,
      stdout: false,
      stderr: false,
      hijack: true,
    });

    stdinStream = stream;
    stdinAttached = true;

    stream.on('error', () => {
      stdinAttached = false;
      stdinStream = null;
    });

    stream.on('close', () => {
      stdinAttached = false;
      stdinStream = null;
    });

    return true;
  } catch (error) {
    console.error('Failed to attach stdin:', error);
    return false;
  }
}

export async function execCommand(command: string): Promise<ActionResponse> {
  try {
    const container = await getContainer();
    if (!container) {
      return { success: false, error: 'Container not found' };
    }

    const info = await container.inspect();
    if (!info.State.Running) {
      return { success: false, error: 'Container not running' };
    }

    // Try to use stdin stream first
    const attached = await ensureStdinAttached();
    if (attached && stdinStream) {
      try {
        stdinStream.write(command + '\n');
        return { success: true, message: `Command executed: ${command}` };
      } catch {
        // Reset and try fallback
        stdinAttached = false;
        stdinStream = null;
      }
    }

    // Fallback: Use screen or tmux if available, or direct write
    const exec = await container.exec({
      Cmd: ['sh', '-c', `
        if command -v screen > /dev/null && screen -list | grep -q hytale; then
          screen -S hytale -p 0 -X stuff "${command.replace(/"/g, '\\"')}\n"
        elif [ -p /tmp/server_input ]; then
          echo "${command.replace(/"/g, '\\"')}" > /tmp/server_input
        else
          echo "${command.replace(/"/g, '\\"')}" >> /proc/1/fd/0
        fi
      `],
      AttachStdout: true,
      AttachStderr: true,
    });

    const stream = await exec.start({});

    return new Promise((resolve) => {
      stream.on('end', () => {
        resolve({ success: true, message: `Command sent: ${command}` });
      });
      stream.on('error', (err: Error) => {
        resolve({ success: false, error: err.message });
      });

      setTimeout(() => {
        resolve({ success: true, message: `Command sent: ${command}` });
      }, 1000);
    });
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
  }
}

export function getDockerInstance(): Docker {
  return docker;
}

export function getContainerName(): string {
  return config.gameContainerName;
}
