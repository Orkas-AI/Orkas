import { afterEach, describe, it, expect, vi } from 'vitest';
import { armKillWatchdog } from '../../../../src/main/features/local_agents/backends/base';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';

// Business invariants of the activity-aware kill watchdog
// (backends/base.ts::armKillWatchdog). The bug class this guards: a
// fixed wall-clock timer killed actively-working CLI dispatches; the
// idle window must SLIDE with activity, and only genuine silence (or
// the generous wall cap) may kill.

function fakeChild() {
  const kill = vi.fn();
  return { child: { kill } as unknown as ChildProcessWithoutNullStreams, kill };
}

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe('armKillWatchdog', () => {
  it('idle window slides with activity — an active run outlives many idle windows', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const { child, kill } = fakeChild();
    let lastEventAt = Date.now();
    const wd = armKillWatchdog(child, {
      timeoutMs: 10_000,
      idleKillMs: 150,
      lastEventAt: () => lastEventAt,
    });
    // Simulate steady activity for ~3 idle windows.
    for (let i = 0; i < 5; i++) {
      lastEventAt = Date.now();
      await vi.advanceTimersByTimeAsync(100);
    }
    expect(wd.fired()).toBe(null);
    expect(kill).not.toHaveBeenCalled();
    // Activity stops → idle kill fires within ~window + tick slack.
    await vi.advanceTimersByTimeAsync(200);
    expect(wd.fired()).toBe('idle');
    expect(kill).toHaveBeenCalledWith('SIGTERM');
    expect(wd.reason()).toMatch(/no activity for \d+ms/);
    wd.disarm();
  });

  it('wall cap fires even while events keep flowing (zombie insurance)', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const { child, kill } = fakeChild();
    const wd = armKillWatchdog(child, {
      timeoutMs: 120,
      idleKillMs: 10_000,
      lastEventAt: () => Date.now(), // perpetually active
    });
    await vi.advanceTimersByTimeAsync(150);
    expect(wd.fired()).toBe('wall');
    expect(kill).toHaveBeenCalledWith('SIGTERM');
    expect(wd.reason()).toMatch(/exceeded 120ms wall-clock cap/);
    wd.disarm();
  });

  it('idle-kill disabled (no idleKillMs / no clock) → only the wall cap can fire', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const { child, kill } = fakeChild();
    const wd = armKillWatchdog(child, { timeoutMs: 10_000 });
    await vi.advanceTimersByTimeAsync(250);
    expect(wd.fired()).toBe(null);
    expect(kill).not.toHaveBeenCalled();
    wd.disarm();
  });

  it('disarm stops the watchdog before it fires', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const { child, kill } = fakeChild();
    const wd = armKillWatchdog(child, { timeoutMs: 120 });
    wd.disarm();
    await vi.advanceTimersByTimeAsync(300);
    expect(wd.fired()).toBe(null);
    expect(kill).not.toHaveBeenCalled();
  });
});
