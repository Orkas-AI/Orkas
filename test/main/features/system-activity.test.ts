import { afterEach, describe, expect, it, vi } from 'vitest';

const power = vi.hoisted(() => ({ listeners: new Map<string, () => void>(), on: vi.fn() }));
vi.mock('electron', () => ({ powerMonitor: { on: (event: string, fn: () => void) => {
  power.on(event); power.listeners.set(event, fn);
} } }));
afterEach(() => { vi.useRealTimers(); });

describe('SystemActivityTracker', () => {
  it('shares one registered OS clock across snapshot consumers and concurrent CLI runs, ignoring duplicate events', async () => {
    vi.resetModules();
    power.listeners.clear(); power.on.mockClear();
    vi.useFakeTimers(); vi.setSystemTime(1000);
    const { getSystemActivityClock, getSystemActivitySnapshot } = await import('../../../src/main/features/system_activity');
    const [first, second] = await Promise.all([getSystemActivityClock(), getSystemActivityClock()]);
    await getSystemActivitySnapshot();
    expect(power.on.mock.calls).toEqual([['suspend'], ['resume']]);
    expect(first()).toBe(1000);
    vi.setSystemTime(1100);
    power.listeners.get('suspend')!();
    vi.setSystemTime(1500);
    power.listeners.get('suspend')!();
    expect(first()).toBe(1100);
    expect(second()).toBe(1100);
    vi.setSystemTime(1700);
    power.listeners.get('resume')!(); power.listeners.get('resume')!();
    vi.setSystemTime(1900);
    expect(first()).toBe(1300);
    expect(await getSystemActivitySnapshot()).toEqual({
      wall_time_ms: 1900, suspended_total_ms: 600, suspend_count: 1,
    });
    expect(power.on).toHaveBeenCalledTimes(2);
  });

  it('exposes cumulative suspend time that can be differenced across a task', async () => {
    const { SystemActivityTracker } = await import('../../../src/main/features/system_activity');
    const listeners = new Map<string, () => void>();
    const monitor = {
      on(event: 'suspend' | 'resume', listener: () => void) {
        listeners.set(event, listener);
      },
    };
    let now = 1_000;
    const tracker = new SystemActivityTracker(monitor, () => now);

    expect(tracker.snapshot()).toEqual({
      wall_time_ms: 1_000,
      suspended_total_ms: 0,
      suspend_count: 0,
    });

    now = 1_100;
    listeners.get('suspend')!();
    now = 1_400;
    expect(tracker.snapshot()).toMatchObject({
      suspended_total_ms: 300,
      suspend_count: 1,
    });

    now = 1_500;
    listeners.get('resume')!();
    now = 1_900;
    expect(tracker.snapshot()).toMatchObject({
      suspended_total_ms: 400,
      suspend_count: 1,
    });
  });
});
