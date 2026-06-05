import { describe, it, expect, afterEach, vi } from 'vitest';

async function loadBootInit() {
  vi.resetModules();
  const boot = await import('../../../src/main/util/boot_init');
  boot._resetForTests();
  return boot;
}

afterEach(() => {
  vi.useRealTimers();
});

describe('util/boot_init', () => {
  it('treats serial tasks as barriers after in-flight parallel work', async () => {
    const boot = await loadBootInit();
    const order: string[] = [];
    let releaseParallel!: () => void;

    boot.registerImmediate('parallel-a', async () => {
      order.push('parallel-start');
      await new Promise<void>((resolve) => { releaseParallel = resolve; });
      order.push('parallel-end');
    });
    boot.registerImmediate('serial-b', () => {
      order.push('serial');
    }, 'serial');

    const run = boot.runBootPhases(60_000);
    await Promise.resolve();

    expect(order).toEqual(['parallel-start']);
    releaseParallel();
    await run;

    expect(order).toEqual(['parallel-start', 'parallel-end', 'serial']);
  });

  it('contains immediate task failures and continues the batch', async () => {
    const boot = await loadBootInit();
    const order: string[] = [];

    boot.registerImmediate('bad', () => {
      order.push('bad');
      throw new Error('boom');
    }, 'serial');
    boot.registerImmediate('good', () => {
      order.push('good');
    }, 'serial');

    await expect(boot.runBootPhases(60_000)).resolves.toBeUndefined();
    expect(order).toEqual(['bad', 'good']);
  });

  it('runs deferred tasks only after the configured delay', async () => {
    vi.useFakeTimers();
    const boot = await loadBootInit();
    const order: string[] = [];

    boot.registerDeferred('deferred', () => {
      order.push('deferred');
    });

    await boot.runBootPhases(25);
    expect(order).toEqual([]);

    await vi.advanceTimersByTimeAsync(24);
    expect(order).toEqual([]);

    await vi.advanceTimersByTimeAsync(1);
    await Promise.resolve();
    expect(order).toEqual(['deferred']);
  });
});
