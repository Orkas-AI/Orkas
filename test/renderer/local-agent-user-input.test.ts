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

// The module owns no markup of its own: every question goes through the shared
// uiChoice / uiPrompt dialogs, so the harness stubs those two globals with what
// a user would produce (a choice id, typed text, or null for a dismissed
// dialog) and observes what reaches IPC.
function loadHarness() {
  const handlers = new Map<string, (payload: any) => void>();
  const invoke = vi.fn(async (_channel: string, _payload: any) => ({ handled: true }));
  const uiChoice = vi.fn<(arg: any) => Promise<any>>();
  const uiPrompt = vi.fn<(message: string, defaultValue: string, options: any) => Promise<any>>();
  const context = vm.createContext({
    window: {
      orkas: {
        invoke,
        onPushEvent: (channel: string, handler: (payload: any) => void) => handlers.set(channel, handler),
      },
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
