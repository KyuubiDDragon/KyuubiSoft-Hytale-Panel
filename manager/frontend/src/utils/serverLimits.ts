/**
 * Memory and CPU limits of a server. The bounds match what the backend accepts
 * (at least 512 MiB, 0.1 to 1024 CPUs); the backend still checks them, and the
 * limit against the JVM heap.
 */
export const MIN_MEMORY_GIB = 0.5
export const MIN_CPUS = 0.1
export const MAX_CPUS = 1024

const BYTES_PER_GIB = 1024 ** 3

export interface LimitsPayload {
  memory?: number
  cpus?: number
}

/** `null` for a blank field. Returns an error key when a value is out of range. */
export function buildLimits(
  memoryGib: number | null,
  cpus: number | null,
): { limits?: LimitsPayload; error?: 'memory' | 'cpus' } {
  const limits: LimitsPayload = {}
  if (memoryGib !== null) {
    if (memoryGib < MIN_MEMORY_GIB) return { error: 'memory' }
    limits.memory = Math.round(memoryGib * BYTES_PER_GIB)
  }
  if (cpus !== null) {
    if (cpus < MIN_CPUS || cpus > MAX_CPUS) return { error: 'cpus' }
    limits.cpus = cpus
  }
  return Object.keys(limits).length > 0 ? { limits } : {}
}

export function bytesToGib(bytes: number | undefined): number | null {
  return typeof bytes === 'number' && bytes > 0
    ? Math.round((bytes / BYTES_PER_GIB) * 100) / 100
    : null
}
