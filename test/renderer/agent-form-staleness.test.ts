import { describe, it, expect, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vm from 'node:vm';

// _resolveAgentFormMount decides, per form mount, whether an unsubmitted
// agent form is still the agent's live decision card or a dead affordance.
// Production incident: a VideoStudio review produced newer candidates, and
// the older unsubmitted gate forms stayed clickable in history — every click
// was rejected server-side as superseded (user clicked three times in one
// session). The renderer must stop offering those clicks at all, without
// hard-coding any agent id.
function loadRuntime() {
  const context: any = {
    console,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    Date,
    JSON,
    Map,
    Set,
    Array,
    String,
    Number,
    RegExp,
    createLogger: () => ({ warn() {}, info() {}, error() {}, debug() {} }),
    t: (key: string) => key,
    escapeHtml: (s: unknown) => String(s ?? ''),
    currentCid: '',
    _BUCKET_ORDER: ['today', 'last30'],
    timeBucket: () => 'today',
    renderAvatarHtml: () => '',
    localStorage: {
      getItem: () => null,
      setItem() {},
      removeItem() {},
    },
    document: {
      readyState: 'loading',
      addEventListener() {},
      querySelector: () => null,
      querySelectorAll: () => [],
      getElementById: () => null,
    },
    window: {
      addEventListener() {},
      uiIconHtml: () => '',
      ConversationRuntime: {},
    },
  };
  context.window.window = context.window;
  vm.createContext(context);
  const source = fs.readFileSync(
    path.join(__dirname, '../../src/renderer/modules/conversation.js'),
    'utf8',
  );
  vm.runInContext(source, context);
  return context;
}

function loadResolver() {
  const context = loadRuntime();
  return context._resolveAgentFormMount as (
    existing: { formId: string; ts: number; submitted?: boolean } | null | undefined,
    next: { formId: string; ts: number; submitted: boolean },
  ) => { stale: boolean; becomesActive: boolean; flipPrevious: boolean };
}

describe('agent form staleness resolution', () => {
  const resolve = loadResolver();

  it('keeps the first unsubmitted form live and flips it when a newer one mounts', () => {
    expect(resolve(null, { formId: 'f1', ts: 100, submitted: false })).toEqual({
      stale: false,
      becomesActive: true,
      flipPrevious: false,
    });
    // Newer form from the same agent supersedes the registered one.
    expect(resolve({ formId: 'f1', ts: 100 }, { formId: 'f2', ts: 200, submitted: false })).toEqual({
      stale: false,
      becomesActive: true,
      flipPrevious: true,
    });
  });

  it('mounts an older unsubmitted form as stale during history pagination', () => {
    // Older page loads after the live form is registered: the old form must
    // not steal the live slot or render clickable.
    expect(resolve({ formId: 'f2', ts: 200 }, { formId: 'f1', ts: 100, submitted: false })).toEqual({
      stale: true,
      becomesActive: false,
      flipPrevious: false,
    });
  });

  it('treats a re-mount of the same form as a refresh, never as superseding itself', () => {
    // Tab switches re-render the same message; flipping it against itself
    // would kill the only live form.
    expect(resolve({ formId: 'f1', ts: 100 }, { formId: 'f1', ts: 100, submitted: false })).toEqual({
      stale: false,
      becomesActive: true,
      flipPrevious: false,
    });
  });

  it('never marks a submitted form stale and never lets it flip the live one', () => {
    // Submitted forms are the durable record of a past decision; readonly
    // rendering owns them. A submitted re-render must not disturb a newer
    // pending form from the same agent.
    expect(resolve({ formId: 'f2', ts: 200 }, { formId: 'f1', ts: 100, submitted: true })).toEqual({
      stale: false,
      becomesActive: false,
      flipPrevious: false,
    });
  });

  it('keeps an answered decision intact when the next pending question mounts', () => {
    expect(resolve({ formId: 'f1', ts: 100, submitted: true }, { formId: 'f2', ts: 200, submitted: false })).toEqual({
      stale: false, becomesActive: true, flipPrevious: false,
    });
  });
});

describe('form answer and replay ordering', () => {
  function fixture() {
    const runtime = loadRuntime();
    runtime.apiFetch = async () => ({ json: async () => ({ ok: true, submission: { text: 'Accepted answer' } }) });
    runtime.window.renderChatInputForm = (host: any, message: any, options: any) => { host.view = { message, ...options }; };
    const mount = (id: string, ts: string) => {
      const classes = new Set<string>();
      const host: any = { isConnected: true, innerHTML: '' };
      const message = { ts, form: { form_id: id, agent_id: 'agent-a', submitted: false } };
      const bubble = { dataset: { msgId: id }, querySelector: () => ({ classList: {
        add: (name: string) => classes.add(name), remove: (name: string) => classes.delete(name),
      } }) };
      runtime._mountChatInputForm(host, bubble, message, { cid: 'conversation-a' });
      return { host, message, classes };
    };
    return { runtime, mount };
  }

  it('preserves the durable answer while replay mounts a new question before returning', async () => {
    const { runtime, mount } = fixture();
    let release!: () => void;
    const pending = new Promise<void>(resolve => { release = resolve; });
    let next: ReturnType<typeof mount> | undefined;
    runtime.sendInConversation = async () => {
      next = mount('f2', '2026-11-14T00:00:02Z');
      await pending;
      return { started: true };
    };
    const first = mount('f1', '2026-11-14T00:00:01Z');
    const submitted = first.host.view.onSubmit('', { answer: 'Yes' }, []);
    try {
      await vi.waitFor(() => expect(next).toBeDefined());
      expect(first.message.form.submitted).toBe(true);
      expect(first.host.view.stale).toBe(false);
      expect(first.classes.has('is-submitted')).toBe(true);
      expect(next!.host.view.stale).toBe(false);
    } finally { release(); await submitted; }
  });

  it.each(['declined', 'thrown'])('keeps the answer retryable when replay is %s', async mode => {
    const { runtime, mount } = fixture();
    runtime.sendInConversation = async () => {
      if (mode === 'thrown') throw new Error('Controlled replay failure');
      return { started: false, queued: false };
    };
    const first = mount('f1', '2026-11-14T00:00:01Z');
    await expect(first.host.view.onSubmit('', { answer: 'Yes' }, [])).rejects.toThrow();
    expect(first.message.form.submitted).toBe(false);
    expect(first.classes.has('is-submitted')).toBe(false);
    mount('f2', '2026-11-14T00:00:02Z');
    expect(first.host.view.stale).toBe(true);
  });
});
