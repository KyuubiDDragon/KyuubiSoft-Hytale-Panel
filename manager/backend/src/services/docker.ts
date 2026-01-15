import Docker from 'dockerode';
import { config } from '../config.js';
import type { ServerStatus, ServerStats, ActionResponse } from '../types/index.js';
import { isCommandSafe, escapeShellArg } from '../utils/sanitize.js';

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
    // SECURITY: Validate command before execution
    if (!command || typeof command !== 'string') {
      return { success: false, error: 'Invalid command' };
    }

    // Check for command injection attempts
    if (!isCommandSafe(command)) {
      console.warn(`[SECURITY] Blocked potentially dangerous command: ${command.substring(0, 50)}...`);
      return { success: false, error: 'Command contains invalid characters' };
    }

    const container = await getContainer();
    if (!container) {
      return { success: false, error: 'Container not found' };
    }

    const info = await container.inspect();
    if (!info.State.Running) {
      return { success: false, error: 'Container not running' };
    }

    // Try to use stdin stream first (safest method - no shell interpolation)
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

    // SECURITY: Use proper shell escaping for fallback method
    const escapedCommand = escapeShellArg(command);

    // Fallback: Use screen or tmux if available, or direct write
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

// Execute a shell command inside the container and capture output
export async function execInContainer(command: string): Promise<ActionResponse & { output?: string }> {
  try {
    const container = await getContainer();
    if (!container) {
      return { success: false, error: 'Container not found' };
    }

    const info = await container.inspect();
    if (!info.State.Running) {
      return { success: false, error: 'Container not running' };
    }

    const exec = await container.exec({
      Cmd: ['sh', '-c', command],
      AttachStdout: true,
      AttachStderr: true,
    });

    const stream = await exec.start({});

    return new Promise((resolve) => {
      let output = '';

      stream.on('data', (chunk: Buffer) => {
        // Docker stream multiplexing: first 8 bytes are header
        // Skip header bytes and extract actual output
        const data = chunk.toString('utf8');
        output += data;
      });

      stream.on('end', () => {
        // Clean up docker stream headers (binary characters)
        const cleanOutput = output.replace(/[\x00-\x08]/g, '').trim();
        resolve({ success: true, output: cleanOutput });
      });

      stream.on('error', (err: Error) => {
        resolve({ success: false, error: err.message });
      });

      setTimeout(() => {
        const cleanOutput = output.replace(/[\x00-\x08]/g, '').trim();
        resolve({ success: true, output: cleanOutput });
      }, 5000);
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
