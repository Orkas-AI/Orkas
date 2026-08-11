import { describe, expect, it } from 'vitest';

describe('SystemActivityTracker', () => {
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
