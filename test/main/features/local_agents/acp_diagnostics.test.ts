import { describe, expect, it } from 'vitest';
import { AcpDiagnostics } from '../../../../src/main/features/local_agents/backends/acp-diagnostics';

describe('ACP diagnostic evidence', () => {
  it('distinguishes a stalled tool from progress, completion and raw stdout traffic', () => {
    let now = 100;
    const d = new AcpDiagnostics(() => now);
    d.sent('session/prompt');
    d.bytes('stdout');
    const update = (status?: string) => d.received({ method: 'session/update', params: { update: {
      sessionUpdate: 'tool_call_update', toolCallId: 'private-id', ...(status ? { status } : {}),
    } } });
    update('in_progress');
    now = 200;
    update(); // Content-only updates do not prove completion.
    now = 300;
    d.bytes('stdout');
    d.malformed();
    d.bytes('stderr');
    now = 400;
    expect(d.snapshot('timeout', 'close', 'close', null)).toMatchObject({
      stage: 'prompt', last: 'tool_progress', pending: 1, oldestMs: 300,
      rxAgeMs: 200, outAgeMs: 100, errAgeMs: 100, invalid: 1,
    });
    update('completed');
    expect(d.snapshot('completed', 'protocol', 'open', null)).toMatchObject({ pending: 0, oldestMs: null, last: 'tool_end' });
    update('pending');
    update('failed');
    expect(d.snapshot('failed', 'protocol', 'open', null).pending).toBe(0);
  });

  it('separates an unanswered initialize, pending approval and structured RPC failure without leaking error data', () => {
    const d = new AcpDiagnostics(() => 100);
    expect(d.snapshot('timeout', 'close', 'close', null)).toMatchObject({ stage: 'initialize', initAck: false, rxAgeMs: null });
    d.received({ id: 1, result: {} });
    d.sent('session/new');
    d.permissionStarted();
    d.received({ id: 2, error: { code: -32603, message: '/private/config secret', data: { token: 'private-token' } } });
    const s = d.snapshot('failed', 'protocol', 'open', null);
    expect(s).toMatchObject({ stage: 'session_new', initAck: true, rpcCode: -32603, errorData: true, permissions: 1 });
    expect(JSON.stringify(s)).not.toMatch(/private|secret|token/);
    d.permissionEnded();
    expect(d.snapshot('cancelled', 'close', 'close', null).permissions).toBe(0);
  });

  it('bounds tool tracking and reports incomplete evidence instead of claiming every tool finished', () => {
    const d = new AcpDiagnostics(() => 10);
    for (let i = 0; i < 1000; i++) d.received({ method: 'session/update', params: { update: {
      sessionUpdate: 'tool_call', toolCallId: `private-${i}`, title: 'secret command', rawInput: 'private data',
    } } });
    d.received({ id: 100, result: { stopReason: 'private-stop-reason' } });
    const s = d.snapshot('failed', 'protocol', 'open', null);
    expect(s).toMatchObject({ pending: 64, trackingLost: true, stop: 'other', messages: 1001 });
    expect(JSON.stringify(s)).not.toMatch(/private|secret/);
    expect(`ACP ${JSON.stringify(s)}`.length).toBeLessThanOrEqual(500);
  });
});
