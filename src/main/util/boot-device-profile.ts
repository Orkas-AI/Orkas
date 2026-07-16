import * as os from 'node:os';

export type BootDeviceTier = 'low' | 'standard';

export interface BootDeviceProfile {
  tier: BootDeviceTier;
  logicalCpus: number;
  totalMemoryBytes: number;
  /** Additional delay after the normal deferred-base timer for disk walkers. */
  heavyDiskOffsetMs: number;
  /** Additional delay after the deferred-base timer for session/reflection work. */
  postStartupOffsetMs: number;
  /** Delay from verified account bootstrap to persisted connector reconnect. */
  connectorBootstrapDelayMs: number;
  /** Delay from verified account bootstrap to sync/marketplace capability init. */
  loginCapabilitiesDelayMs: number;
}

const GIB = 1024 ** 3;
const LOW_MEMORY_BYTES = 8 * GIB;
const LOW_LOGICAL_CPUS = 4;

export function classifyBootDevice(
  logicalCpus: number,
  totalMemoryBytes: number,
): BootDeviceProfile {
  const cpus = Math.max(1, Math.floor(Number(logicalCpus) || 1));
  const memory = Math.max(0, Number(totalMemoryBytes) || 0);
  const tier: BootDeviceTier = cpus <= LOW_LOGICAL_CPUS || memory <= LOW_MEMORY_BYTES
    ? 'low'
    : 'standard';
  return {
    tier,
    logicalCpus: cpus,
    totalMemoryBytes: memory,
    // Scheduling is deliberately uniform across hardware tiers. Device tier
    // remains useful telemetry, but non-critical work should be structurally
    // outside the interaction window on every machine rather than relying on
    // a low-spec exception to hide avoidable contention.
    heavyDiskOffsetMs: 30_000,
    postStartupOffsetMs: 90_000,
    connectorBootstrapDelayMs: 45_000,
    loginCapabilitiesDelayMs: 55_000,
  };
}

export function getBootDeviceProfile(): BootDeviceProfile {
  const logicalCpus = typeof os.availableParallelism === 'function'
    ? os.availableParallelism()
    : os.cpus().length;
  return classifyBootDevice(logicalCpus, os.totalmem());
}
