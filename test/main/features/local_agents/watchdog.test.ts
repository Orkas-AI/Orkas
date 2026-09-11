import { afterEach, describe, it, expect, vi } from 'vitest';
import { armKillWatchdog } from '../../../../src/main/features/local_agents/backends/base';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { AgentActivityClock, agentExecutionDeadline } from '../../../../src/main/util/agent-execution-budget';

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
  it('retains the original 24-hour deadline across an internal retry, but a new dispatch gets a fresh budget', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const deadlineAt = agentExecutionDeadline();
    expect(deadlineAt).toBe(86_400_000);
    const first = fakeChild();
    const initial = armKillWatchdog(first.child, { timeoutMs: 86_400_000, deadlineAt });
    vi.setSystemTime(86_390_000);
    initial.disarm();
    const retry = fakeChild();
    const wd = armKillWatchdog(retry.child, {
      timeoutMs: 86_400_000, deadlineAt, idleKillMs: 1_800_000, lastEventAt: Date.now,
    });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(wd.fired()).toBe('wall');
    expect(retry.kill).toHaveBeenCalledWith('SIGTERM');
    expect(agentExecutionDeadline()).toBe(172_800_000);
    wd.disarm();
  });

  it('pauses only idle time for overlapping approvals; releasing one wait cannot resume another', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const clock = new AgentActivityClock();
    const { child, kill } = fakeChild();
    const wd = armKillWatchdog(child, { timeoutMs: 10_000, idleKillMs: 300, lastEventAt: clock.lastEventAt });
    await vi.advanceTimersByTimeAsync(150);
    const resumeFirst = clock.pause();
    const resumeSecond = clock.pause();
    await vi.advanceTimersByTimeAsync(600);
    resumeFirst();
    resumeFirst(); // Idempotent cleanup cannot release the other prompt.
    await vi.advanceTimersByTimeAsync(600);
    expect(kill).not.toHaveBeenCalled();
    resumeSecond();
    await vi.advanceTimersByTimeAsync(75);
    expect(kill).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(150);
    expect(wd.fired()).toBe('idle');
    expect(kill).toHaveBeenCalledWith('SIGTERM');
    wd.disarm();
  });

  it('a pending user prompt cannot bypass the absolute execution limit', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const clock = new AgentActivityClock();
    const resume = clock.pause();
    const { child, kill } = fakeChild();
    const wd = armKillWatchdog(child, { timeoutMs: 300, idleKillMs: 100, lastEventAt: clock.lastEventAt });
    await vi.advanceTimersByTimeAsync(300);
    expect(wd.fired()).toBe('wall');
    expect(kill).toHaveBeenCalledWith('SIGTERM');
    resume();
    wd.disarm();
  });

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
