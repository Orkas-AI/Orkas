import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as bp from '../../../../src/main/model/core-agent/bash-permissions';

// Capture the `bash:permission` push so we can answer it the way the renderer
// would, without an Electron IPC bridge.
let pushed: Array<{ channel: string; payload: any }> = [];

beforeEach(() => {
  pushed = [];
  bp._resetForTest();
  bp._setBroadcastForTest((channel, payload) => { pushed.push({ channel, payload }); });
});

afterEach(() => {
  bp._setBroadcastForTest(null);
  bp._resetForTest();
  vi.useRealTimers();
});

function ask(over: Partial<Parameters<typeof bp.requestBashDecision>[0]> = {}) {
  return bp.requestBashDecision({
    uid: 'u1', cid: 'c1', agentId: 'a1', agentName: 'Agent',
    command: 'rm -rf /', reasons: ['destructive'],
    ...over,
  });
}

describe('bash-permissions', () => {
  it('pushes a request and resolves with the user verdict (allow_once)', async () => {
    const p = ask();
    expect(pushed).toHaveLength(1);
    const id = pushed[0].payload.request_id;
    expect(bp.respond(id, 'allow_once')).toBe(true);
    expect(await p).toBe('allow_once');
  });

  it('deny verdict resolves to deny', async () => {
    const p = ask();
    bp.respond(pushed[0].payload.request_id, 'deny');
    expect(await p).toBe('deny');
  });

  it('allow_run grants the category for the rest of the run (no second prompt)', async () => {
    const p1 = ask();
    bp.respond(pushed[0].payload.request_id, 'allow_run');
    expect(await p1).toBe('allow_run');

    // same (cid, agentId, category) → silent allow, no new push
    const p2 = ask();
    expect(await p2).toBe('allow_run');
    expect(pushed).toHaveLength(1); // still just the first prompt
  });

  it('run grant does not cover a different category', async () => {
    const p1 = ask({ reasons: ['destructive'] });
    bp.respond(pushed[0].payload.request_id, 'allow_run');
    await p1;

    const p2 = ask({ reasons: ['network_egress'] });
    expect(pushed).toHaveLength(2); // a fresh prompt was raised
    bp.respond(pushed[1].payload.request_id, 'deny');
    expect(await p2).toBe('deny');
  });

  it('run grant is scoped to the cid — a different conversation re-prompts', async () => {
    const p1 = ask({ cid: 'c1' });
    bp.respond(pushed[0].payload.request_id, 'allow_run');
    await p1;

    const p2 = ask({ cid: 'c2' });
    expect(pushed).toHaveLength(2);
    bp.respond(pushed[1].payload.request_id, 'deny');
    await p2;
  });

  it('cancelForCid denies pending requests and clears run grants', async () => {
    const p1 = ask();
    bp.cancelForCid('c1');
    expect(await p1).toBe('deny');

    // a previously-granted run scope would be cleared too: grant then cancel
    const p2 = ask();
    bp.respond(pushed[1].payload.request_id, 'allow_run');
    await p2;
    bp.cancelForCid('c1');
    const p3 = ask();
    expect(pushed).toHaveLength(3); // re-prompted, run grant was dropped
    bp.respond(pushed[2].payload.request_id, 'deny');
    await p3;
  });

  it('denies on timeout when no answer arrives', async () => {
    vi.useFakeTimers();
    const p = ask();
    await vi.advanceTimersByTimeAsync(120 * 1000 + 10);
    expect(await p).toBe('deny');
  });

  it('truncates an oversized command in the push payload', async () => {
    const big = 'echo ' + 'x'.repeat(2000);
    const p = ask({ command: big, reasons: ['network_egress'] });
    expect(pushed[0].payload.command.length).toBeLessThan(big.length);
    bp.respond(pushed[0].payload.request_id, 'deny');
    await p;
  });
});
