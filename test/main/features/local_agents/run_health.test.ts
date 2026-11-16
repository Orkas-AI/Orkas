import { describe, expect, it } from 'vitest';
import { boundedRunHealth, LocalRunHealth } from '../../../../src/main/features/local_agents/run_health';

describe('read-only active run health', () => {
  it('distinguishes real progress, synthetic pulses, overlapping waits and tool activity without retaining content', () => {
    let now = 100;
    const health = new LocalRunHealth('hermes', () => now);
    expect(health.read()).toMatchObject({ phase: 'unknown', phase_elapsed_ms: null, last_activity_age_ms: null });
    health.event({ type: 'thinking', text: 'PRIVATE' }, 0);
    now = 1100;
    const approval = health.beginWait('waiting_approval');
    now = 2100;
    const input = health.beginWait('waiting_input');
    health.event({ type: 'thinking', synthetic: true }, 0);
    expect(health.read()).toMatchObject({ phase: 'waiting_approval', wait_elapsed_ms: 1000, last_activity_age_ms: 2000 });
    approval(); approval();
    expect(health.read()).toMatchObject({ phase: 'waiting_input', wait_elapsed_ms: 0 });
    now = 3100;
    input();
    expect(health.read()).toMatchObject({ phase: 'reasoning', wait_elapsed_ms: null, last_activity_age_ms: 3000 });
    health.event({ type: 'tool-event', phase: 'use', input: 'PRIVATE' }, 2);
    health.event({ type: 'tool-event', phase: 'result' }, 1);
    expect(health.read()).toMatchObject({ phase: 'tool_running' });
    health.event({ type: 'tool-event', phase: 'result' }, 0);
    expect(health.read()).toMatchObject({ phase: 'running' });
    expect(JSON.stringify(health.read())).not.toContain('PRIVATE');
    health.close(); health.activity();
    expect(health.read()).toBeNull();
    expect(new LocalRunHealth('hermes').read()).toMatchObject({ phase: 'unknown', last_activity_age_ms: null });
  });
  it('leaves a rejected input wait without manufacturing activity', async () => {
    const health = new LocalRunHealth('codex');
    await expect(health.wait('waiting_input', async () => { throw new Error('declined'); })).rejects.toThrow('declined');
    expect(health.read()).toMatchObject({ phase: 'unknown', wait_elapsed_ms: null, last_activity_age_ms: null });
  });
  it.each([0, 19, 20, 21])('bounds a snapshot of %i runs and reports unavailable phases as unknown', count => {
    let calls = 0;
    const rows = Array.from({ length: count }, () => () => { calls++; return null; });
    const result = boundedRunHealth(rows);
    expect(result.runs).toHaveLength(Math.min(count, 20));
    expect(result.runs_truncated).toBe(count > 20);
    expect(calls).toBe(Math.min(count, 20));
    for (const row of result.runs) expect(row).toEqual({ runtime: 'unknown', cli: null, phase: 'unknown',
      phase_elapsed_ms: null, wait_elapsed_ms: null, last_activity_age_ms: null });
  });
});
