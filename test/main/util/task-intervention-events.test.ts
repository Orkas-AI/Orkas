import { beforeEach, describe, expect, it, vi } from 'vitest';

const loggerMocks = vi.hoisted(() => ({ warn: vi.fn() }));

vi.mock('../../../src/main/logger', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: loggerMocks.warn,
    error: vi.fn(),
  }),
}));

import {
  _resetTaskInterventionsForTest,
  captureDeliveredTaskIntervention,
  subscribeTaskInterventions,
} from '../../../src/main/util/task-intervention-events';

describe('delivered task intervention signals', () => {
  beforeEach(() => {
    _resetTaskInterventionsForTest();
    loggerMocks.warn.mockReset();
  });

  it.each([
    ['bash:permission', { request_id: 'req-1', cid: 'c1' }, 'sensitive_operation'],
    ['local-agent:permission', { request_id: 'req-cli', cid: 'c-cli' }, 'sensitive_operation'],
    ['local-agent:permission', { request_id: 'req-2', cid: 'c2', permission_kind: 'connector' }, 'connector_permission'],
    ['connectors:install-confirm', { request_id: 'req-3', cid: 'c3' }, 'connector_install'],
    ['delete_file.confirmation_required', { confirm_id: 'req-4', cid: 'c4' }, 'delete_confirmation'],
  ] as const)('maps the delivered %s action surface without copying private prompt content', (channel, payload, kind) => {
    const listener = vi.fn();
    subscribeTaskInterventions(listener);
    const expectedId = 'request_id' in payload ? payload.request_id : payload.confirm_id;

    expect(captureDeliveredTaskIntervention(channel, {
      ...payload,
      command: 'private command',
      path: '/private/path',
    }, 'u1')).toBe(true);

    expect(listener).toHaveBeenCalledOnce();
    expect(listener).toHaveBeenCalledWith({
      attention_id: `${kind}:${expectedId}`,
      user_id: 'u1',
      conversation_id: payload.cid,
      kind,
    });
    expect(JSON.stringify(listener.mock.calls)).not.toContain('private command');
    expect(JSON.stringify(listener.mock.calls)).not.toContain('/private/path');
  });

  it('rejects malformed or unroutable look-alikes instead of raising false attention', () => {
    const listener = vi.fn();
    subscribeTaskInterventions(listener);

    expect(captureDeliveredTaskIntervention('bash:permission_cancelled', {
      request_id: 'req-1', cid: 'c1',
    }, 'u1')).toBe(false);
    expect(captureDeliveredTaskIntervention('bash:permission', {
      request_id: 'req-1',
    }, 'u1')).toBe(false);
    expect(captureDeliveredTaskIntervention('local-agent:permission', {
      request_id: 'req-2', cid: 'c2', permission_kind: 'connector',
    }, '')).toBe(false);
    expect(listener).not.toHaveBeenCalled();
  });

  it('emits one signal for repeated interactive CLI waiting frames and resets after the session ends', () => {
    const listener = vi.fn();
    subscribeTaskInterventions(listener);
    const waiting = {
      type: 'waiting_input',
      session_id: 'session-1',
      user_id: 'u1',
      conversation_id: 'c1',
      prompt_kind: 'secret',
    };

    expect(captureDeliveredTaskIntervention('interactive-cli:event', waiting, 'u1')).toBe(true);
    expect(captureDeliveredTaskIntervention('interactive-cli:event', waiting, 'u1')).toBe(false);
    expect(captureDeliveredTaskIntervention('interactive-cli:event', {
      type: 'exited', session_id: 'session-1', user_id: 'u1', conversation_id: 'c1',
    }, 'u1')).toBe(false);
    expect(captureDeliveredTaskIntervention('interactive-cli:event', waiting, 'u1')).toBe(true);

    expect(listener).toHaveBeenCalledTimes(2);
    expect(listener).toHaveBeenLastCalledWith({
      attention_id: 'interactive_cli_input:session-1',
      user_id: 'u1',
      conversation_id: 'c1',
      kind: 'interactive_cli_input',
    });
  });

  it('isolates a failing listener so the gated operation and later consumers still receive the signal', () => {
    const listenerError = new Error('notification consumer failed');
    const failingListener = vi.fn(() => { throw listenerError; });
    const healthyListener = vi.fn();
    subscribeTaskInterventions(failingListener);
    subscribeTaskInterventions(healthyListener);

    expect(() => captureDeliveredTaskIntervention('bash:permission', {
      request_id: 'req-resilient',
      cid: 'c-resilient',
    }, 'u1')).not.toThrow();

    expect(failingListener).toHaveBeenCalledOnce();
    expect(healthyListener).toHaveBeenCalledWith({
      attention_id: 'sensitive_operation:req-resilient',
      user_id: 'u1',
      conversation_id: 'c-resilient',
      kind: 'sensitive_operation',
    });
    expect(loggerMocks.warn).toHaveBeenCalledOnce();
    expect(loggerMocks.warn).toHaveBeenCalledWith(
      'task intervention listener failed',
      { error: listenerError },
    );
  });
});
