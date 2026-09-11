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
  setAttribute() {}
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
