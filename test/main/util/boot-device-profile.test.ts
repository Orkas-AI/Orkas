import { describe, expect, it } from 'vitest';
import { classifyBootDevice } from '../../../src/main/util/boot-device-profile';

describe('boot device profile', () => {
  it('keeps non-critical work outside the interaction window on normal machines', () => {
    expect(classifyBootDevice(8, 16 * 1024 ** 3)).toMatchObject({
      tier: 'standard',
      heavyDiskOffsetMs: 30_000,
      postStartupOffsetMs: 90_000,
      connectorBootstrapDelayMs: 45_000,
      loginCapabilitiesDelayMs: 55_000,
    });
  });

  it.each([
    [4, 16 * 1024 ** 3],
    [8, 8 * 1024 ** 3],
  ])('uses the same startup-safe schedule for %s CPUs / %s bytes', (cpus, memory) => {
    expect(classifyBootDevice(cpus, memory)).toMatchObject({
      tier: 'low',
      heavyDiskOffsetMs: 30_000,
      postStartupOffsetMs: 90_000,
      connectorBootstrapDelayMs: 45_000,
      loginCapabilitiesDelayMs: 55_000,
    });
  });
});
