import { afterEach, describe, expect, it, vi } from 'vitest';

import * as userInput from '../../../../src/main/features/local_agents/cli_user_input';
import { permissionResponseTimeoutMs } from '../../../../src/main/features/local_agents/cli_permissions';
import { notifyUserSwitch } from '../../../../src/main/features/user-switch-hooks';

afterEach(() => {
  vi.useRealTimers();
  userInput._resetForTest();
});

function request(overrides: Record<string, unknown> = {}) {
  return userInput.requestUserInput({
    uid: 'u1',
    cid: 'c1',
    runId: 'run-1',
    agentId: 'agent-1',
    agentName: 'Codex Agent',
    cli: 'codex',
    request: {
      id: 'native-request-1',
      questions: [{
        id: 'environment',
        header: 'Environment',
        question: 'Choose target',
        options: [{ label: 'staging', description: 'Use staging' }],
        isOther: true,
      }],
    },
    ...overrides,
  } as any);
}

describe('local_agents/cli_user_input', () => {
  it('returns empty answers immediately when no renderer can receive the request', async () => {
    userInput._setBroadcastForTest(() => false);

    await expect(request()).resolves.toEqual({
      cancelled: true,
      answers: { environment: [] },
    });
  });

  it('settles an unanswered blocking request at the host deadline and makes the late renderer reply stale', async () => {
    // Same contract as permission prompts: the host bounds the wait, so a user
    // who stepped away does not hold the task and its CLI slot for the 2 h wall
    // cap, and a reply that arrives after the deadline is stale.
    vi.useFakeTimers();
    const deliveries: Array<{ channel: string; payload: any }> = [];
    userInput._setBroadcastForTest((channel, payload) => { deliveries.push({ channel, payload }); });
    const pending = request({ request: {
      id: 'native-request-deadline', isBlocking: true,
      questions: [{ id: 'environment', question: 'Choose target', options: [{ label: 'staging' }] }],
    } });
    const requestId = deliveries[0].payload.request_id as string;

    vi.advanceTimersByTime(permissionResponseTimeoutMs() - 1);
    expect(deliveries.some((entry) => entry.channel === 'local-agent:user-input_cancelled')).toBe(false);
    vi.advanceTimersByTime(1);

    await expect(pending).resolves.toEqual({ cancelled: true, answers: { environment: [] } });
    expect(deliveries).toContainEqual({
      channel: 'local-agent:user-input_cancelled',
      payload: { request_ids: [requestId] },
    });
    expect(userInput.respond(requestId, 'u1', { environment: ['staging'] } as any)).toEqual({ handled: false });
  });

  it('publishes bounded questions and accepts one response from the owning account', async () => {
    let delivered: { channel: string; payload: any } | null = null;
    userInput._setBroadcastForTest((channel, payload) => {
      delivered = { channel, payload };
    });

    const pending = request({
      agentName: `Agent ${'n'.repeat(300)}\u0000`,
      conversationTitle: `Release ${'t'.repeat(300)}\u0007`,
      request: {
        id: 'must-not-be-rendered',
        isBlocking: true,
        questions: [
          {
            id: 'environment',
            question: `Choose ${'q'.repeat(3_000)}\u0000`,
            options: Array.from({ length: 20 }, (_, index) => ({
              label: `option-${index}`,
              description: 'description',
            })),
            isOther: true,
          },
          { id: 'token', question: 'Token', isSecret: true },
          { id: 'duplicate', question: 'First' },
          { id: 'ignored-fourth', question: 'Fourth' },
        ],
      },
    });

    expect(delivered?.channel).toBe('local-agent:user-input');
    expect(delivered?.payload).toMatchObject({
      cid: 'c1', agent_id: 'agent-1', cli: 'codex', is_blocking: true,
    });
    expect(delivered?.payload).not.toHaveProperty('id');
    expect(delivered?.payload.agent_name.length).toBeLessThanOrEqual(160);
    expect(delivered?.payload.conversation_title.length).toBeLessThanOrEqual(160);
    expect(delivered?.payload.questions).toHaveLength(3);
    expect(delivered?.payload.questions[0].question.length).toBe(2_000);
    expect(delivered?.payload.questions[0].options).toHaveLength(12);

    const requestId = delivered!.payload.request_id;
    expect(userInput.respond(requestId, 'u2', { environment: ['production'] })).toEqual({ handled: false });
    expect(userInput.respond(requestId, 'u1', {
      environment: ['staging', `custom-${'x'.repeat(5_000)}\u0000`],
      token: 'secret-value',
      ignored: ['not accepted'],
    })).toEqual({ handled: true, cancelled: false });

    const response = await pending;
    expect(response.cancelled).toBe(false);
    expect(response.answers.environment[0]).toBe('staging');
    expect(response.answers.environment[1]).toHaveLength(4_000);
    expect(response.answers.environment[1]).not.toContain('\u0000');
    expect(response.answers.token).toEqual(['secret-value']);
    expect(response.answers).not.toHaveProperty('ignored');
    expect(userInput.respond(requestId, 'u1', {})).toEqual({ handled: false });
  });

  it('cancels only the abandoned run and makes its renderer response stale', async () => {
    const deliveries: Array<{ channel: string; payload: any }> = [];
    userInput._setBroadcastForTest((channel, payload) => {
      deliveries.push({ channel, payload });
    });
    const abandoned = request();
    const survivor = request({ runId: 'run-2' });
    const requests = deliveries
      .filter(entry => entry.channel === 'local-agent:user-input')
      .map(entry => entry.payload.request_id);

    userInput.cancelForRun('run-1');
    await expect(abandoned).resolves.toEqual({ cancelled: true, answers: { environment: [] } });
    expect(deliveries).toContainEqual({
      channel: 'local-agent:user-input_cancelled',
      payload: { request_ids: [requests[0]] },
    });
    expect(userInput.respond(requests[0], 'u1', { environment: ['staging'] })).toEqual({ handled: false });
    expect(userInput.respond(requests[1], 'u1', { environment: ['staging'] })).toEqual({
      handled: true, cancelled: false,
    });
    await expect(survivor).resolves.toMatchObject({ cancelled: false });
  });

  it('honors the protocol auto-resolution deadline without leaving a native request pending', async () => {
    vi.useFakeTimers();
    const deliveries: Array<{ channel: string; payload: any }> = [];
    userInput._setBroadcastForTest((channel, payload) => {
      deliveries.push({ channel, payload });
    });
    const pending = request({
      request: {
        id: 'native-auto',
        autoResolutionMs: 25,
        questions: [{ id: 'environment', question: 'Choose target' }],
      },
    });

    await vi.advanceTimersByTimeAsync(25);
    await expect(pending).resolves.toEqual({ cancelled: true, answers: { environment: [] } });
    expect(deliveries.at(-1)).toMatchObject({ channel: 'local-agent:user-input_cancelled' });
  });

  it('cancels requests owned by the previous account on user switch', async () => {
    const deliveries: any[] = [];
    userInput._setBroadcastForTest((channel, payload) => deliveries.push({ channel, payload }));
    const previous = request();
    const next = request({ uid: 'u2', runId: 'run-u2' });

    notifyUserSwitch('u1', 'u2');
    await expect(previous).resolves.toMatchObject({ cancelled: true });
    const nextRequest = deliveries
      .filter(entry => entry.channel === 'local-agent:user-input')[1].payload.request_id;
    userInput.respond(nextRequest, 'u2', { environment: ['staging'] });
    await expect(next).resolves.toMatchObject({ cancelled: false });
  });
});
