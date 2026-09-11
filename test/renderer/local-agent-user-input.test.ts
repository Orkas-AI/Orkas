import { describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vm from 'node:vm';

const source = fs.readFileSync(
  path.resolve(__dirname, '../../src/renderer/modules/local_agent_user_input.js'),
  'utf8',
);

async function flush() {
  await new Promise<void>(resolve => setImmediate(resolve));
  await new Promise<void>(resolve => setImmediate(resolve));
}

// The module routes requests to the shared card or dialogs. Drive their
// callbacks with user decisions and observe what reaches IPC.
function loadHarness(options: { dock?: boolean } = {}) {
  const handlers = new Map<string, (payload: any) => void>();
  const invoke = vi.fn(async (_channel: string, _payload: any) => ({ handled: true }));
  const uiChoice = vi.fn<(arg: any) => Promise<any>>();
  const uiPrompt = vi.fn<(message: string, defaultValue: string, options: any) => Promise<any>>();
  // The composer dock owns the card; the harness records the spec it receives
  // and drives it the way a user would (answer, decline, or a cancelled run).
  const requests: any[] = [];
  const closed: string[] = [];
  const CliAsyncInput = options.dock === false ? undefined : {
    showCliInputRequest: vi.fn((spec: any) => {
      requests.push(spec);
      return () => { closed.push(spec.requestId); spec.onClosed?.(); };
    }),
  };
  const context = vm.createContext({
    window: {
      orkas: {
        invoke,
        onPushEvent: (channel: string, handler: (payload: any) => void) => handlers.set(channel, handler),
      },
      ...(CliAsyncInput ? { CliAsyncInput } : {}),
    },
    AbortController,
    createLogger: () => ({ warn() {} }),
    t: (key: string) => key,
    uiChoice,
    uiPrompt,
  });
  vm.runInContext(source, context, { filename: 'local_agent_user_input.js' });
  return {
    invoke,
    uiChoice,
    uiPrompt,
    requests,
    closed,
    CliAsyncInput,
    push: (channel: string, payload: any) => handlers.get(channel)?.(payload),
  };
}

describe('renderer local Agent structured user input', () => {
  const choiceQuestion = {
    id: 'environment',
    header: 'Deployment',
    question: 'Choose target',
    options: [{ label: 'Staging', description: 'Pre-production' }, { label: 'Production' }],
  };
  const textQuestion = { id: 'note', question: 'Release note' };

  it('shows a request only once, including after its card has closed, while allowing a new question with identical text', async () => {
    const harness = loadHarness();
    const info = { request_id: 'card-once', cid: 'chat-1', questions: [choiceQuestion] };
    // The real dock refuses another mount for the same pending request.
    harness.CliAsyncInput!.showCliInputRequest.mockImplementationOnce(spec => {
      harness.requests.push(spec);
      return () => spec.onClosed?.();
    }).mockImplementationOnce(() => null as any);
    harness.push('local-agent:user-input', info);
    harness.push('local-agent:user-input', info);
    await flush();
    expect(harness.CliAsyncInput!.showCliInputRequest).toHaveBeenCalledOnce();
    expect(harness.uiChoice).not.toHaveBeenCalled();
    expect(harness.uiPrompt).not.toHaveBeenCalled();

    await harness.requests[0].submit(['Staging'], [['Staging']]);
    harness.requests[0].onClosed();
    harness.push('local-agent:user-input', info);
    expect(harness.CliAsyncInput!.showCliInputRequest).toHaveBeenCalledOnce();
    expect(harness.invoke).toHaveBeenCalledOnce();

    harness.CliAsyncInput!.showCliInputRequest.mockReset().mockImplementation(spec => {
      harness.requests.push(spec);
      return () => spec.onClosed?.();
    });
    harness.push('local-agent:user-input', { ...info, request_id: 'card-new' });
    expect(harness.requests).toHaveLength(2);
    expect(harness.uiChoice).not.toHaveBeenCalled();
  });

  it('does not enqueue duplicate dialogs or reopen an answered request', async () => {
    const harness = loadHarness({ dock: false });
    const resolvers: Array<(value: string) => void> = [];
    harness.uiPrompt.mockImplementation(() => new Promise(resolve => resolvers.push(resolve)));
    const first = { request_id: 'dialog-first', questions: [textQuestion] };
    const second = { request_id: 'dialog-second', questions: [textQuestion] };
    for (const info of [first, first, second, second]) harness.push('local-agent:user-input', info);
    expect(harness.uiPrompt).toHaveBeenCalledOnce();
    resolvers[0]('first answer');
    await flush();
    expect(harness.uiPrompt).toHaveBeenCalledTimes(2);
    resolvers[1]('second answer');
    await flush();
    harness.push('local-agent:user-input', first);
    harness.push('local-agent:user-input', second);
    await flush();
    expect(harness.uiPrompt).toHaveBeenCalledTimes(2);
    expect(harness.invoke.mock.calls.map(([, payload]) => payload.request_id))
      .toEqual(['dialog-first', 'dialog-second']);
  });

  it('never displays a withdrawn request again, even when cancellation arrives before its delivery', async () => {
    const harness = loadHarness();
    const info = { request_id: 'withdrawn-card', cid: 'chat-1', questions: [choiceQuestion] };
    harness.push('local-agent:user-input', info);
    harness.push('local-agent:user-input_cancelled', { request_ids: [info.request_id, 'cancelled-before-delivery'] });
    harness.push('local-agent:user-input', info);
    harness.push('local-agent:user-input', { ...info, request_id: 'cancelled-before-delivery' });
    await flush();
    expect(harness.requests).toHaveLength(1);
    expect(harness.closed).toEqual([info.request_id]);
    expect(harness.uiChoice).not.toHaveBeenCalled();
    expect(harness.uiPrompt).not.toHaveBeenCalled();
    expect(harness.invoke).not.toHaveBeenCalled();
  });

  it('renders a conversation question in the composer dock and replies only over the dedicated IPC', async () => {
    const harness = loadHarness();

    harness.push('local-agent:user-input', {
      request_id: 'request-card',
      cid: 'chat-1',
      agent_name: 'Orkas Codex',
      questions: [{ ...choiceQuestion, multiSelect: true, isOther: true }],
    });
    await flush();

    // No dialog for a question that has a conversation to live in.
    expect(harness.uiChoice).not.toHaveBeenCalled();
    expect(harness.uiPrompt).not.toHaveBeenCalled();
    expect(harness.requests).toHaveLength(1);
    expect(harness.requests[0]).toMatchObject({
      requestId: 'request-card',
      cid: 'chat-1',
      actorLabel: 'Orkas Codex',
      questions: [expect.objectContaining({ id: 'environment' })],
    });

    // Two picked options stay two values; the card reports what it holds.
    expect(await harness.requests[0].submit(['Staging, Production'], [['Staging', 'Production']])).toBe(true);
    expect(harness.invoke).toHaveBeenCalledWith('localAgents.userInputResponse', {
      request_id: 'request-card',
      answers: { environment: ['Staging', 'Production'] },
      cancelled: false,
    });
  });

  it('sends a typed answer as one value and a declined card as a cancellation', async () => {
    const typed = loadHarness();
    typed.push('local-agent:user-input', {
      request_id: 'request-typed', cid: 'chat-1', questions: [choiceQuestion],
    });
    await flush();
    expect(await typed.requests[0].submit(['Canary ring'], [[]])).toBe(true);
    expect(typed.invoke).toHaveBeenCalledWith('localAgents.userInputResponse', {
      request_id: 'request-typed', answers: { environment: ['Canary ring'] }, cancelled: false,
    });

    const declined = loadHarness();
    declined.push('local-agent:user-input', {
      request_id: 'request-declined', cid: 'chat-1', questions: [choiceQuestion],
    });
    await flush();
    await declined.requests[0].cancel();
    expect(declined.invoke).toHaveBeenCalledWith('localAgents.userInputResponse', {
      request_id: 'request-declined', answers: {}, cancelled: true,
    });
  });

  it('reports a failed reply so the card can keep the answer for a retry', async () => {
    const harness = loadHarness();
    harness.invoke.mockRejectedValueOnce(new Error('ipc down'));
    harness.push('local-agent:user-input', {
      request_id: 'request-retry', cid: 'chat-1', questions: [choiceQuestion],
    });
    await flush();
    expect(await harness.requests[0].submit(['Staging'], [['Staging']])).toBe(false);
    expect(await harness.requests[0].submit(['Staging'], [['Staging']])).toBe(true);
  });

  it('accepts only confirmed cancellation or native closure, never IPC receipt alone', async () => {
    const harness = loadHarness();
    harness.push('local-agent:user-input', {
      request_id: 'cancel-status', cid: 'chat-1', questions: [choiceQuestion],
    });
    expect(await harness.requests[0].cancel()).toBe('unknown');
    harness.invoke.mockResolvedValueOnce({ handled: false, cancel_failed: true } as any);
    expect(await harness.requests[0].cancel()).toBe('failed');
    harness.invoke.mockResolvedValueOnce({ handled: true, cancelled: true } as any);
    expect(await harness.requests[0].cancel()).toBe('closed');
    harness.invoke.mockResolvedValueOnce({ handled: false, closed: true } as any);
    expect(await harness.requests[0].cancel()).toBe('closed');
    harness.invoke.mockRejectedValueOnce(new Error('ipc unavailable'));
    await expect(harness.requests[0].cancel()).rejects.toThrow('ipc unavailable');
  });

  it('keeps the dialog for masked input and when no dock can host the card', async () => {
    const secret = loadHarness();
    secret.uiPrompt.mockResolvedValue('hunter2');
    secret.push('local-agent:user-input', {
      request_id: 'request-secret-card',
      cid: 'chat-1',
      questions: [{ id: 'token', question: 'Paste the deploy token', isSecret: true }],
    });
    await flush();
    expect(secret.requests).toHaveLength(0);
    expect(secret.uiPrompt).toHaveBeenCalledWith('Paste the deploy token', '', { signal: expect.any(AbortSignal), secret: true });

    const noDock = loadHarness({ dock: false });
    noDock.uiChoice.mockResolvedValue('option-0');
    noDock.push('local-agent:user-input', {
      request_id: 'request-no-dock', cid: 'chat-1', questions: [choiceQuestion],
    });
    await flush();
    expect(noDock.uiChoice).toHaveBeenCalledOnce();
    expect(noDock.invoke).toHaveBeenCalledWith('localAgents.userInputResponse', {
      request_id: 'request-no-dock', answers: { environment: ['Staging'] }, cancelled: false,
    });
  });

  it('retracts a docked card when the CLI cancels its request', async () => {
    const harness = loadHarness();
    harness.push('local-agent:user-input', {
      request_id: 'request-gone', cid: 'chat-1', questions: [choiceQuestion],
    });
    await flush();
    expect(harness.requests).toHaveLength(1);

    harness.push('local-agent:user-input_cancelled', { request_ids: ['request-gone'] });
    await flush();
    expect(harness.closed).toEqual(['request-gone']);
    // A cancelled request is settled by the run; the renderer must not answer.
    expect(harness.invoke).not.toHaveBeenCalled();
  });

  it('answers each question through the shared dialogs and replies only over the dedicated IPC', async () => {
    const harness = loadHarness();
    harness.uiChoice.mockResolvedValue('option-1');
    harness.uiPrompt.mockResolvedValue('ship it');

    harness.push('local-agent:user-input', {
      request_id: 'request-1',
      questions: [choiceQuestion, textQuestion],
    });
    await flush();

    expect(harness.uiChoice).toHaveBeenCalledWith({
      title: 'agents.cli_user_input_title',
      message: 'Deployment\nChoose target\nStaging: Pre-production',
      // No free-text escape hatch unless the CLI asked for one.
      choices: [{ id: 'option-0', label: 'Staging' }, { id: 'option-1', label: 'Production' }],
      // CLI options are prose, so they render as a wrapping group above the
      // action row (2026-09-09, requested by the product owner: same style as
      // the native-question card in the composer dock).
      choiceLayout: 'group',
      signal: expect.any(AbortSignal),
    });
    expect(harness.uiPrompt).toHaveBeenCalledWith('Release note', '', { signal: expect.any(AbortSignal), secret: false });
    expect(harness.invoke).toHaveBeenCalledOnce();
    expect(harness.invoke).toHaveBeenCalledWith('localAgents.userInputResponse', {
      request_id: 'request-1',
      answers: { environment: ['Production'], note: ['ship it'] },
      cancelled: false,
    });
  });

  it('lets the user type an answer when the CLI allows "other"', async () => {
    const harness = loadHarness();
    harness.uiChoice.mockResolvedValue('other');
    harness.uiPrompt.mockResolvedValue('Canary ring');

    harness.push('local-agent:user-input', {
      request_id: 'request-other',
      questions: [{ ...choiceQuestion, isOther: true }],
    });
    await flush();

    expect(harness.uiChoice.mock.calls[0][0].choices).toEqual([
      { id: 'option-0', label: 'Staging' },
      { id: 'option-1', label: 'Production' },
      { id: 'other', label: 'agents.cli_user_input_other' },
    ]);
    expect(harness.uiPrompt).toHaveBeenCalledWith('Choose target', '', { signal: expect.any(AbortSignal) });
    expect(harness.invoke).toHaveBeenCalledWith('localAgents.userInputResponse', {
      request_id: 'request-other',
      answers: { environment: ['Canary ring'] },
      cancelled: false,
    });
  });

  it('masks the answer when the CLI marks a question secret', async () => {
    const harness = loadHarness();
    harness.uiPrompt.mockResolvedValue('hunter2');

    harness.push('local-agent:user-input', {
      request_id: 'request-secret',
      questions: [{ id: 'token', question: 'Paste the deploy token', isSecret: true }],
    });
    await flush();

    expect(harness.uiChoice).not.toHaveBeenCalled();
    expect(harness.uiPrompt).toHaveBeenCalledWith('Paste the deploy token', '', { signal: expect.any(AbortSignal), secret: true });
    expect(harness.invoke).toHaveBeenCalledWith('localAgents.userInputResponse', {
      request_id: 'request-secret', answers: { token: ['hunter2'] }, cancelled: false,
    });
  });

  it('returns multiple selected labels and a custom answer to a native question', async () => {
    const harness = loadHarness();
    harness.uiChoice.mockResolvedValue(['option-0', 'option-1', 'other']);
    harness.uiPrompt.mockResolvedValue('Canary');
    harness.push('local-agent:user-input', {
      request_id: 'multi-question', questions: [{ ...choiceQuestion, multiSelect: true, isOther: true }],
    });
    await flush();
    expect(harness.uiChoice.mock.calls[0][0].multiple).toBe(true);
    expect(harness.invoke).toHaveBeenCalledWith('localAgents.userInputResponse', {
      request_id: 'multi-question', cancelled: false, answers: { environment: ['Staging', 'Production', 'Canary'] },
    });
  });

  it.each(['choice', 'text'])('maps a dismissed %s dialog to a cancelled response without leaking earlier answers', async (dismissed) => {
    const harness = loadHarness();
    harness.uiChoice.mockResolvedValue(dismissed === 'choice' ? null : 'option-0');
    harness.uiPrompt.mockResolvedValue(dismissed === 'text' ? null : 'typed');

    harness.push('local-agent:user-input', {
      request_id: 'request-dismissed',
      // The first question is answered; dismissing the second cancels the whole request.
      questions: dismissed === 'choice' ? [textQuestion, choiceQuestion] : [choiceQuestion, textQuestion],
    });
    await flush();

    expect(harness.invoke).toHaveBeenCalledOnce();
    expect(harness.invoke).toHaveBeenCalledWith('localAgents.userInputResponse', {
      request_id: 'request-dismissed', answers: {}, cancelled: true,
    });
  });

  it('aborts the open dialog and drops queued requests when main cancels them', async () => {
    const harness = loadHarness();
    harness.uiPrompt.mockImplementation((_message, _defaultValue, options) => new Promise((resolve) => {
      options.signal.addEventListener('abort', () => resolve(null), { once: true });
    }));

    harness.push('local-agent:user-input', { request_id: 'request-cancelled', questions: [textQuestion] });
    harness.push('local-agent:user-input', { request_id: 'request-queued', questions: [textQuestion] });
    harness.push('local-agent:user-input_cancelled', { request_ids: ['request-cancelled', 'request-queued'] });
    await flush();

    expect(harness.uiPrompt).toHaveBeenCalledOnce();
    expect(harness.invoke).not.toHaveBeenCalled();
  });

  it('serializes native requests so dialogs never overlap', async () => {
    const harness = loadHarness();
    const resolvers: Array<(value: any) => void> = [];
    harness.uiPrompt.mockImplementation(() => new Promise((resolve) => resolvers.push(resolve)));

    harness.push('local-agent:user-input', { request_id: 'request-1', questions: [{ id: 'first', question: 'First' }] });
    harness.push('local-agent:user-input', { request_id: 'request-2', questions: [{ id: 'second', question: 'Second' }] });
    expect(harness.uiPrompt).toHaveBeenCalledTimes(1);

    resolvers[0]('done');
    await flush();
    expect(harness.uiPrompt).toHaveBeenCalledTimes(2);
    expect(harness.uiPrompt.mock.calls[1][0]).toBe('Second');
    resolvers[1]('done');
    await flush();
    expect(harness.invoke.mock.calls.map(([, payload]) => payload.request_id)).toEqual(['request-1', 'request-2']);
  });
});
