import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

class Element {
  children: Element[] = [];
  className = '';
  classList = { add: () => {} };
  textContent = '';
  value = '';
  disabled = false;
  isConnected = true;
  hidden = false;
  scrollIntoView = vi.fn();
  parentElement: Element | null = null;
  get firstElementChild() { return this.children[0]; }
  remove() { if (this.parentElement) this.parentElement.children = this.parentElement.children.filter(el => el !== this); this.parentElement = null; }
  listeners = new Map<string, () => any>();
  constructor(public tagName = 'div') {}
  appendChild(el: Element) { el.remove(); this.children.push(el); el.parentElement = this; return el; }
  replaceChildren() { this.children = []; }
  attributes = new Map<string, string>();
  placeholder = '';
  rows = 0;
  maxLength = 0;
  type = '';
  setAttribute(name?: string, value?: string) { if (name) this.attributes.set(name, String(value)); }
  addEventListener(type: string, listener: () => any) { this.listeners.set(type, listener); }
  async fire(type: string) { if (type !== 'click' || !this.disabled) await this.listeners.get(type)?.(); }
  all(tag: string): Element[] { return this.children.flatMap(el => [...(el.tagName === tag ? [el] : []), ...el.all(tag)]); }
}

afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

function load(expiresAt?: number) {
  const invoke = vi.fn(async (_channel: string, payload: any) => ({ ok: true, message: { from: 'user', cli_answer: { message_id: payload.message_id, answers: payload.answers } } }));
  const dock = new Element();
  const context: any = { Date, setTimeout, clearTimeout, window: { orkas: { invoke }, addEventListener() {} }, document: { getElementById: () => dock, createElement: (tag: string) => new Element(tag), addEventListener() {} }, t: (key: string) => key };
  vm.runInNewContext(fs.readFileSync(path.resolve(__dirname, '../../src/renderer/modules/cli_async_input.js'), 'utf8'), context);
  const message = { id: 'question-1', from: 'agent', turn_id: 'turn-1', cli_question: { expires_at_ms: expiresAt, questions: [{ title: 'Which scope?', options: ['Current', 'All'] }] } };
  const api = context.window.CliAsyncInput;
  const host = new Element();
  const onAnswer = vi.fn();
  api.mount(host, message, { cid: 'chat-1', onAnswer });
  return { invoke, api, host, message, onAnswer, dock };
}
const send = (host: Element) => host.all('button').find(el => el.textContent === 'chat.cli_question.send')!;

/** A blocking request card: same dock, same markup, caller-owned delivery. */
function loadRequest(questions: any[], overrides: Record<string, any> = {}) {
  const dock = new Element();
  const context: any = {
    Date, setTimeout, clearTimeout,
    window: { orkas: { invoke: vi.fn() }, addEventListener() {} },
    document: { getElementById: () => dock, createElement: (tag: string) => new Element(tag), addEventListener() {} },
    t: (key: string) => key,
  };
  vm.runInNewContext(fs.readFileSync(path.resolve(__dirname, '../../src/renderer/modules/cli_async_input.js'), 'utf8'), context);
  const api = context.window.CliAsyncInput;
  const submit = vi.fn(async () => true);
  const cancel = vi.fn(async () => 'closed');
  const onClosed = vi.fn();
  api.showConversation('chat-1');
  const close = api.showCliInputRequest({
    requestId: 'request-1', cid: 'chat-1', actorLabel: 'Orkas Codex',
    questions, submit, cancel, onClosed, ...overrides,
  });
  const host = dock.children[0];
  return { api, dock, host, close, submit, cancel, onClosed, context };
}
const cardButton = (host: Element, text: string) => host.all('button').find(el => el.textContent === text)!;
const cardInputs = (host: Element) => host.all('textarea');

describe('native asynchronous question drafts and delivery', () => {
  it('keeps a draft answerable after twenty minutes and ignores a previously stored host deadline', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1000);
    const h = load(2000);
    await h.host.all('button')[0].fire('click');
    await vi.advanceTimersByTimeAsync(500);
    h.host.isConnected = false;
    const restored = new Element();
    h.api.mount(restored, h.message, { cid: 'chat-1' });
    await vi.advanceTimersByTimeAsync(20 * 60_000);
    expect(send(restored).disabled).toBe(false);
    expect(restored.children[0].textContent).toBe('chat.cli_question.title');
    expect(restored.all('textarea')[0].value).toBe('Current');
    expect(restored.all('textarea')[0].disabled).toBe(false);
    expect(h.invoke).not.toHaveBeenCalled();
    await send(restored).fire('click');
    expect(h.invoke).toHaveBeenCalledOnce();
    h.api.forget('chat-1');
    expect(vi.getTimerCount()).toBe(0);
  });
  it('requires a user answer, preserves a draft across view changes, and restores the submitted card from history', async () => {
    const h = load();
    expect(send(h.host).disabled).toBe(true);
    await h.host.all('button')[0].fire('click');
    expect(h.invoke).not.toHaveBeenCalled();
    const input = h.host.all('textarea')[0];
    input.value = 'Custom folder';
    await input.fire('input');
    h.host.isConnected = false;
    const restored = new Element();
    h.api.mount(restored, h.message, { cid: 'chat-1', onAnswer: h.onAnswer });
    expect(restored.all('textarea')[0].value).toBe('Custom folder');
    await send(restored).fire('click');
    expect(h.invoke).toHaveBeenCalledExactlyOnceWith('localAgents.asyncInputResponse', { cid: 'chat-1', message_id: 'question-1', answers: ['Custom folder'] });
    expect(h.onAnswer).toHaveBeenCalledOnce();
    expect(restored.all('textarea')[0].disabled).toBe(true);
    const reloaded = load();
    reloaded.api.observe('chat-1', { from: 'user', cli_answer: { message_id: 'question-1', answers: ['Saved choice'] } });
    expect(reloaded.host.all('textarea')[0].value).toBe('Saved choice');
    expect(reloaded.host.all('textarea')[0].disabled).toBe(true);
  });

  it('keeps a failed answer retryable and expires only questions belonging to a completed turn', async () => {
    const h = load();
    const active = [{ actor: 'agent', turn_id: 'turn-1', steerable: true }];
    h.api.setActiveTurns('chat-1', active);
    const input = h.host.all('textarea')[0];
    input.value = 'Current';
    await input.fire('input');
    h.api.setActiveTurns('chat-1', active.map(row => ({ ...row, started_at_ms: 1 })));
    expect(h.host.all('textarea')[0]).toBe(input);
    h.invoke.mockResolvedValueOnce({ ok: false, error: 'delivery_failed' } as any);
    await send(h.host).fire('click');
    expect(send(h.host).disabled).toBe(false);
    expect(h.host.all('textarea')[0].value).toBe('Current');
    h.api.setActiveTurns('other-chat', []);
    expect(send(h.host).disabled).toBe(false);
    h.api.setActiveTurns('chat-1', [{ actor: 'agent', turn_id: 'replacement-turn', steerable: true }]);
    expect(send(h.host).disabled).toBe(true);
    expect(h.host.children[0].textContent).toBe('chat.cli_question.expired');
    expect(h.host.all('textarea')[0].value).toBe('Current');
    await send(h.host).fire('click');
    expect(h.invoke).toHaveBeenCalledTimes(1);
  });

  it('keeps a slow submission single-flight and ignores answers from another conversation', async () => {
    const h = load();
    let resolve!: (result: any) => void;
    h.invoke.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
    await h.host.all('button')[0].fire('click');
    const pending = send(h.host).fire('click');
    await send(h.host).fire('click');
    expect(h.invoke).toHaveBeenCalledTimes(1);
    h.api.observe('other-chat', { cli_answer: { message_id: 'question-1', answers: ['Wrong answer'] } });
    expect(h.host.all('textarea')[0].value).toBe('Current');
    resolve({ ok: true, message: { cli_answer: { message_id: 'question-1', answers: ['Current'] } } });
    await pending;
    expect(h.host.all('textarea')[0].disabled).toBe(true);
  });

  it('allows retrying an accepted answer save after task completion and reopening the card', async () => {
    vi.useFakeTimers();
    const h = load(Date.now() + 1000);
    await h.host.all('button')[0].fire('click');
    h.invoke.mockResolvedValueOnce({ ok: false, error: 'save_failed' } as any);
    await send(h.host).fire('click');
    await vi.advanceTimersByTimeAsync(1000);
    h.api.setActiveTurns('chat-1', []);
    h.host.isConnected = false;
    const restored = new Element();
    h.api.mount(restored, h.message, { cid: 'chat-1', onAnswer: h.onAnswer });
    expect(restored.all('textarea')[0].disabled).toBe(true);
    expect(send(restored).disabled).toBe(false);
    await send(restored).fire('click');
    expect(h.invoke.mock.calls[1][1].answers).toEqual(['Current']);
    expect(restored.all('textarea')[0].disabled).toBe(true);
    expect(send(restored)).toBeUndefined();
  });
});


describe('blocking native request card', () => {
  const questions = [{
    id: 'target', header: '推送目标', question: '这次提交推到哪个远端分支?',
    options: [
      { label: '新建 origin/release_2.0.0', description: '远端会出现一条新的发布分支。' },
      { label: '推进 origin/release_1.7.0' },
    ],
  }];

  it('answers through the caller\'s delivery and leaves the dock when it settles', async () => {
    const { dock, host, submit, onClosed } = loadRequest(questions);
    expect(dock.children).toHaveLength(1);
    expect(host.all('div').find(el => el.className === 'form-title')!.textContent)
      .toBe('Orkas Codex · chat.cli_question.title');
    // The question, its options and the free-text box are one field.
    expect(host.all('label')[0].textContent).toBe('推送目标 · 这次提交推到哪个远端分支?');
    // One row per described option, its name split out so a wrapped
    // description cannot read as the next option's opening line.
    const described = host.all('div').filter(el => el.className === 'form-field-desc-option');
    expect(described).toHaveLength(1);
    expect(described[0].all('span').map(el => el.textContent))
      .toEqual(['新建 origin/release_2.0.0:', '远端会出现一条新的发布分支。']);
    expect(cardInputs(host)).toHaveLength(1);
    // Nothing is implicit: send stays closed until there is an answer.
    expect(cardButton(host, 'chat.cli_question.send').disabled).toBe(true);

    await cardButton(host, '新建 origin/release_2.0.0').fire('click');
    expect(cardInputs(host)[0].value).toBe('新建 origin/release_2.0.0');
    expect(cardButton(host, '新建 origin/release_2.0.0').className).toContain('is-selected');
    expect(cardButton(host, 'chat.cli_question.send').disabled).toBe(false);

    await cardButton(host, 'chat.cli_question.send').fire('click');
    expect(submit).toHaveBeenCalledWith(['新建 origin/release_2.0.0'], [['新建 origin/release_2.0.0']]);
    expect(onClosed).toHaveBeenCalledOnce();
    expect(dock.children).toHaveLength(0);
  });

  it('keeps the card and reports a failed delivery so the answer can be retried', async () => {
    const { dock, host, onClosed } = loadRequest(questions, { submit: vi.fn(async () => false) });
    await cardButton(host, '推进 origin/release_1.7.0').fire('click');
    await cardButton(host, 'chat.cli_question.send').fire('click');
    expect(host.all('div').find(el => el.className === 'form-error')!.textContent)
      .toBe('chat.cli_question.send_failed');
    expect(onClosed).not.toHaveBeenCalled();
    expect(dock.children).toHaveLength(1);
    expect(cardButton(host, 'chat.cli_question.send').disabled).toBe(false);
  });

  it('sends a declined request through cancel and drops a typed-over option', async () => {
    const declined = loadRequest(questions);
    await cardButton(declined.host, 'common.cancel').fire('click');
    expect(declined.cancel).toHaveBeenCalledOnce();
    expect(declined.submit).not.toHaveBeenCalled();
    expect(declined.dock.children).toHaveLength(0);

    const edited = loadRequest(questions);
    await cardButton(edited.host, '推进 origin/release_1.7.0').fire('click');
    const input = cardInputs(edited.host)[0];
    input.value = '推到 main';
    await input.fire('input');
    expect(cardButton(edited.host, '推进 origin/release_1.7.0').className).not.toContain('is-selected');
    await cardButton(edited.host, 'chat.cli_question.send').fire('click');
    // A label the user typed over must not travel back as a selected option.
    expect(edited.submit).toHaveBeenCalledWith(['推到 main'], [[]]);
  });

  it('accumulates a multi-select answer and asks every question before sending', async () => {
    const { host, submit } = loadRequest([
      { id: 'scope', question: 'Which areas?', multiSelect: true, options: [{ label: 'Docs' }, { label: 'Tests' }] },
      { id: 'note', question: 'Anything to add?' },
    ]);
    expect(cardInputs(host)).toHaveLength(2);
    await cardButton(host, 'Docs').fire('click');
    await cardButton(host, 'Tests').fire('click');
    expect(cardInputs(host)[0].value).toBe('Docs, Tests');
    // The second question is still unanswered, so nothing may be sent yet.
    expect(cardButton(host, 'chat.cli_question.send').disabled).toBe(true);
    cardInputs(host)[1].value = 'ship it';
    await cardInputs(host)[1].fire('input');
    await cardButton(host, 'chat.cli_question.send').fire('click');
    expect(submit).toHaveBeenCalledWith(['Docs, Tests', 'ship it'], [['Docs', 'Tests'], []]);
  });

  it('shows the card only in its own conversation and refuses a duplicate request id', () => {
    const first = loadRequest(questions);
    expect(first.dock.children).toHaveLength(1);
    first.api.showConversation('chat-2');
    expect(first.dock.children).toHaveLength(0);
    first.api.showConversation('chat-1');
    expect(first.dock.children).toHaveLength(1);
    expect(first.api.showCliInputRequest({
      requestId: 'request-1', cid: 'chat-1', questions, submit: vi.fn(), cancel: vi.fn(),
    })).toBeNull();
  });

  it('hides a cancelling card, retries once, and restores its answer without a message if both attempts fail', async () => {
    const cancel = vi.fn(async () => 'failed');
    const h = loadRequest(questions, { cancel });
    await cardButton(h.host, '推进 origin/release_1.7.0').fire('click');
    const pending = cardButton(h.host, 'common.cancel').fire('click');
    expect(h.dock.children).toHaveLength(0);
    await pending;
    expect(cancel).toHaveBeenCalledTimes(2);
    expect(h.dock.children).toEqual([h.host]);
    expect(cardInputs(h.host)[0].value).toBe('推进 origin/release_1.7.0');
    expect(cardButton(h.host, 'common.cancel').disabled).toBe(false);
    expect(h.host.all('div').find(el => el.className === 'form-error')!.textContent).toBe('');
    cancel.mockResolvedValueOnce('closed');
    await cardButton(h.host, 'common.cancel').fire('click');
    expect(h.dock.children).toHaveLength(0);
    expect(h.onClosed).toHaveBeenCalledOnce();
    expect(h.submit).not.toHaveBeenCalled();
  });

  it('restores a failed cancellation only in its original conversation and preserves multi-select answers', async () => {
    let failRetry!: (value: string) => void;
    const cancel = vi.fn(async () => 'failed').mockImplementationOnce(() =>
      new Promise<string>(resolve => { failRetry = resolve; }));
    const h = loadRequest([{
      id: 'checks', question: 'Which checks?', multiSelect: true,
      options: [{ label: 'Unit, fast' }, { label: 'Integration' }],
    }], { cancel });
    await cardButton(h.host, 'Unit, fast').fire('click');
    await cardButton(h.host, 'Integration').fire('click');
    const pending = cardButton(h.host, 'common.cancel').fire('click');
    await cardButton(h.host, 'common.cancel').fire('click');
    expect(cancel).toHaveBeenCalledOnce();
    h.api.showConversation('chat-2');
    failRetry('failed');
    await pending;
    expect(cancel).toHaveBeenCalledTimes(2);
    expect(h.dock.children).toHaveLength(0);
    h.api.showConversation('chat-1');
    expect(h.dock.children).toEqual([h.host]);
    expect(cardInputs(h.host)[0].value).toBe('Unit, fast, Integration');
    expect(cardButton(h.host, 'Unit, fast').attributes.get('aria-pressed')).toBe('true');
    expect(cardButton(h.host, 'Integration').attributes.get('aria-pressed')).toBe('true');
    await cardButton(h.host, 'chat.cli_question.send').fire('click');
    expect(h.submit).toHaveBeenCalledWith(['Unit, fast, Integration'], [['Unit, fast', 'Integration']]);
    expect(h.dock.children).toHaveLength(0);
  });

  it.each(['unknown', 'ipc-error', 'failed-then-unknown', 'malformed'])('keeps an uncertain cancellation hidden without retry or message: %s', async outcome => {
    const cancel = vi.fn(async () => 'unknown');
    if (outcome === 'ipc-error') cancel.mockRejectedValueOnce(new Error('reply lost'));
    if (outcome === 'failed-then-unknown') cancel.mockResolvedValueOnce('failed');
    if (outcome === 'malformed') cancel.mockResolvedValueOnce(undefined as any);
    const h = loadRequest(questions, { cancel });
    await cardButton(h.host, 'common.cancel').fire('click');
    expect(cancel).toHaveBeenCalledTimes(outcome === 'failed-then-unknown' ? 2 : 1);
    expect(h.dock.children).toHaveLength(0);
    expect(h.onClosed).toHaveBeenCalledOnce();
    expect(h.host.all('div').find(el => el.className === 'form-error')!.textContent).toBe('');
    h.api.showConversation('chat-2');
    h.api.showConversation('chat-1');
    h.close(); // A late CLI withdrawal must not resurrect or close it twice.
    expect(h.dock.children).toHaveLength(0);
    expect(h.onClosed).toHaveBeenCalledOnce();
    expect(h.submit).not.toHaveBeenCalled();
  });

  it('keeps the card closed when cancellation succeeds on retry or the CLI withdraws during cancellation', async () => {
    const cancel = vi.fn(async () => 'closed').mockResolvedValueOnce('failed');
    const retried = loadRequest(questions, { cancel });
    await cardButton(retried.host, 'common.cancel').fire('click');
    expect(cancel).toHaveBeenCalledTimes(2);
    expect(retried.dock.children).toHaveLength(0);

    let finish!: (value: string) => void;
    const slowCancel = vi.fn(() => new Promise<string>(resolve => { finish = resolve; }));
    const withdrawn = loadRequest(questions, { cancel: slowCancel });
    const pending = cardButton(withdrawn.host, 'common.cancel').fire('click');
    withdrawn.close();
    finish('failed');
    await pending;
    expect(slowCancel).toHaveBeenCalledOnce();
    expect(withdrawn.dock.children).toHaveLength(0);
    expect(withdrawn.onClosed).toHaveBeenCalledOnce();
  });
});

describe('composer question dock', () => {
  it('shows questions only in their conversation, retains a draft without rebuilding focused controls, and retracts on answer', async () => {
    const h = load();
    h.api.setActiveTurns('chat-1', [{ actor: 'agent', turn_id: 'turn-1', steerable: true }]);
    h.api.showQuestion(h.message, { cid: 'chat-1', actorLabel: 'Codex' });
    expect(h.dock.hidden).toBe(true);
    h.api.showConversation('chat-1');
    expect(h.dock.hidden).toBe(false);
    expect(h.dock.children[0].scrollIntoView).toHaveBeenCalledOnce();
    const input = h.dock.all('textarea')[0];
    input.value = 'Use my draft';
    await input.fire('input');
    h.api.showConversation('chat-2');
    expect(h.dock.hidden).toBe(true);
    h.api.showConversation('chat-1');
    expect(h.dock.all('textarea')[0]).toBe(input);
    h.api.showQuestion(h.message, { cid: 'chat-1' });
    expect(h.dock.all('textarea')).toHaveLength(1);
    expect(h.dock.children[0].scrollIntoView).toHaveBeenCalledTimes(2); // Only first arrival and returning to the conversation.
    await send(h.dock).fire('click');
    expect(h.invoke).toHaveBeenCalledExactlyOnceWith('localAgents.asyncInputResponse', { cid: 'chat-1', message_id: 'question-1', answers: ['Use my draft'] });
    expect(h.dock.hidden).toBe(true);
    h.api.showQuestion(h.message, { cid: 'chat-1' });
    expect(h.dock.hidden).toBe(true);
  });

  it('keeps concurrent questions separate and never reopens completed questions on history replay', async () => {
    const h = load();
    h.api.showConversation('chat-1');
    h.api.showQuestion(h.message, { cid: 'chat-1' });
    expect(h.dock.hidden).toBe(true); // History without runtime state cannot revive a question.
    h.api.setActiveTurns('chat-1', [{ actor: 'agent', turn_id: 'turn-1', steerable: true }]);
    const input = h.dock.all('textarea')[0];
    input.value = 'Unsubmitted draft';
    await input.fire('input');
    h.api.showQuestion({ ...h.message, id: 'question-2' }, { cid: 'chat-1' });
    expect(h.dock.all('textarea')).toHaveLength(2);
    expect(h.dock.all('textarea')[0]).toBe(input);
    h.api.setActiveTurns('chat-1', []);
    expect(h.dock.hidden).toBe(true);
    expect(h.invoke).not.toHaveBeenCalled();
    h.api.showQuestion(h.message, { cid: 'chat-1' });
    expect(h.dock.hidden).toBe(true);
    h.api.forget('chat-1');
    h.api.setActiveTurns('chat-1', [{ actor: 'agent', turn_id: 'turn-1', steerable: true }]);
    expect(h.dock.hidden).toBe(true);
  });

  it('keeps an accepted answer with a failed history save accessible after leaving and task completion', async () => {
    const h = load();
    h.api.showConversation('chat-1');
    h.api.setActiveTurns('chat-1', [{ actor: 'agent', turn_id: 'turn-1', steerable: true }]);
    h.api.showQuestion(h.message, { cid: 'chat-1' });
    await h.dock.all('button')[0].fire('click');
    let resolve!: (result: any) => void;
    h.invoke.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
    const pending = send(h.dock).fire('click');
    h.api.showConversation(null);
    h.api.setActiveTurns('chat-1', []);
    resolve({ ok: false, error: 'save_failed' });
    await pending;
    h.api.showConversation('chat-1');
    expect(h.dock.hidden).toBe(false);
    expect(h.dock.all('textarea')[0].disabled).toBe(true);
    expect(send(h.dock).disabled).toBe(false);
    await send(h.dock).fire('click');
    expect(h.dock.hidden).toBe(true);
    expect(h.invoke).toHaveBeenCalledTimes(2);
  });
});
