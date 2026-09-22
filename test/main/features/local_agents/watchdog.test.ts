import { afterEach, describe, it, expect, vi } from 'vitest';
import { armKillWatchdog } from '../../../../src/main/features/local_agents/backends/base';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import {
  AGENT_EXECUTION_IDLE_MS,
  AgentActivityClock,
  agentExecutionDeadline,
} from '../../../../src/main/util/agent-execution-budget';
import { resolveIdleKillMs } from '../../../../src/main/features/local_agents/runner';
import { localCliCapabilities } from '../../../../src/main/features/local_agents/registry';

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

describe('who gets an idle clock', () => {
  const previous = process.env.ORKAS_LOCAL_AGENT_IDLE_KILL_MS;
  afterEach(() => {
    if (previous === undefined) delete process.env.ORKAS_LOCAL_AGENT_IDLE_KILL_MS;
    else process.env.ORKAS_LOCAL_AGENT_IDLE_KILL_MS = previous;
  });

  it('arms the shared idle window for backends that can report progress', () => {
    delete process.env.ORKAS_LOCAL_AGENT_IDLE_KILL_MS;
    for (const cli of ['claude', 'codex', 'opencode'] as const) {
      expect(resolveIdleKillMs(cli), cli).toBe(AGENT_EXECUTION_IDLE_MS);
    }
  });

  it('leaves a backend without mid-run output on the wall cap alone', () => {
    // openclaw hands over its whole reply when the process exits, so silence is
    // its working state: an idle clock would cut a healthy long turn and throw
    // the answer away (openclaw_e2e.test.ts). Registry capability, not a name
    // list — a future silent backend inherits the same rule. Not the same as
    // `activeRunIngress`: opencode and hermes accept nothing into a live run
    // yet stream out of it, so they keep the clock.
    delete process.env.ORKAS_LOCAL_AGENT_IDLE_KILL_MS;
    expect(resolveIdleKillMs('openclaw')).toBeUndefined();
    for (const cli of ['opencode', 'hermes'] as const) {
      expect(localCliCapabilities(cli).activeRunIngress, cli).toBe('none');
      expect(resolveIdleKillMs(cli), cli).toBe(AGENT_EXECUTION_IDLE_MS);
    }
  });

  it('lets an explicit override decide either way, including for openclaw', () => {
    process.env.ORKAS_LOCAL_AGENT_IDLE_KILL_MS = '900000';
    expect(resolveIdleKillMs('openclaw')).toBe(900_000);
    process.env.ORKAS_LOCAL_AGENT_IDLE_KILL_MS = '0';
    expect(resolveIdleKillMs('claude')).toBeUndefined();
  });
});
