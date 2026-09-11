import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vm from 'node:vm';

// Regression coverage for three renderer fixes from the 2026-07-25 infra review:
// 1. _chatAttachClear revokes blob preview URLs even WITHOUT deleteFiles (the
//    normal after-send path) — before the fix each sent image/audio attachment
//    pinned its bytes in the Blob registry for the renderer's lifetime.
// 2. handleNewChatSubmit is re-entrancy-gated — before the fix a held Enter
//    (key auto-repeat) during the create round trip made TWO conversations and
//    TWO paid model runs from one composer text.
// 3. skills.js selectSkillFile drops a stale body response after the user has
//    switched skill/file (header showed B while the body showed A).

function escapeHtml(s: unknown) {
  return String(s ?? '').replace(/[&<>"]/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;',
  }[c] || c));
}

const rendererRoot = path.join(__dirname, '../../src/renderer');
const conversationSource = fs.readFileSync(path.join(rendererRoot, 'modules/conversation.js'), 'utf8');
const skillsSource = fs.readFileSync(path.join(rendererRoot, 'modules/skills.js'), 'utf8');

// Wrap a vm context in a Proxy so any global identifier the module references
// but the test didn't stub resolves to a benign no-op function instead of
// throwing ReferenceError. These are 2-4K-line classic-script modules with a
// wide flat-global surface; the tests only exercise one narrow path each.
function withNoopFallback(target: any) {
  const noop = () => undefined;
  return new Proxy(target, {
    has: () => true, // shadows vm intrinsics too — get() restores them below
    get(t, key) {
      if (typeof key === 'symbol') return undefined;
      if (key in t) return t[key];
      // Real JS intrinsics (Object, Math, Reflect…) from the host realm, so
      // the blanket `has` doesn't break ordinary language-level code.
      if (key in globalThis) return (globalThis as any)[key];
      return noop;
    },
  });
}

function stubEl(extra: Record<string, any> = {}) {
  return {
    value: '', textContent: '', innerHTML: '', title: '', hidden: false, disabled: false,
    dataset: {} as Record<string, string>, style: {} as Record<string, string>,
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
    addEventListener() {}, removeEventListener() {}, setAttribute() {}, removeAttribute() {},
    appendChild() {}, prepend() {}, querySelector: () => null, querySelectorAll: () => [] as any[],
    focus() {}, ...extra,
  };
}

function loadConversation(overrides: Record<string, any> = {}) {
  const revoked: string[] = [];
  const elements: Record<string, any> = {};
  const context: any = {
    console, setTimeout, clearTimeout, encodeURIComponent, URLSearchParams,
    Date, JSON, Map, Set, Array, String, Number, RegExp, Promise,
    performance: { now: () => 0 },
    requestAnimationFrame: (fn: Function) => { setTimeout(fn, 0); return 1; },
    CSS: { escape: (s: string) => String(s) },
    URL: { revokeObjectURL: (u: string) => { revoked.push(u); }, createObjectURL: () => 'blob:new' },
    createLogger: () => ({ warn() {}, info() {}, error() {}, debug() {} }),
    escapeHtml,
    t: (key: string) => key,
    currentCid: '',
    conversations: [],
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    document: {
      readyState: 'loading',
      addEventListener() {},
      querySelector: () => null,
      querySelectorAll: () => [] as any[],
      getElementById: (id: string) => elements[id] || null,
      createElement: () => stubEl(),
    },
    window: { addEventListener() {}, uiIconHtml: () => '', ConversationRuntime: {} },
    ...overrides,
  };
  context.window.window = context.window;
  const proxied = withNoopFallback(context);
  vm.createContext(proxied);
  vm.runInContext(conversationSource, proxied);
  return { context: proxied, revoked, elements };
}

describe('chat attachment blob URL lifecycle', () => {
  it('revokes blob preview URLs on the plain after-send clear (no deleteFiles)', async () => {
    const { context, revoked } = loadConversation();
    context._chatAttachSet('c1', [
      { name: 'a.png', kind: 'image', status: 'ready', dataUrl: 'blob:one' },
      { name: 'b.txt', kind: 'text', status: 'ready' },
      { name: 'c.png', kind: 'image', status: 'ready', dataUrl: 'chat-media://kept' },
    ]);

    await context._chatAttachClear('c1');

    // Only the blob: preview is revoked; persistent chat-media:// URLs untouched.
    expect(revoked).toEqual(['blob:one']);
    expect(context._chatAttachList('c1')).toEqual([]);
  });
});

describe('new-chat submit re-entrancy gate', () => {
  it('a second submit during the create round trip does not create a second conversation', async () => {
    const createCalls: string[] = [];
    let resolveCreate: (v: any) => void = () => {};
    const { context, elements } = loadConversation({
      ensureModelConfigured: () => true,
      _getQuotes: () => [],
      _clearQuotes: () => {},
      transformWithChatUse: (x: string) => x,
      getChatUseSelections: () => [],
      consumeChatUseSelections: () => [],
      unresolvedOssTemplatePlaceholder: () => false,
      apiFetch: (url: string) => {
        createCalls.push(url);
        return new Promise((resolve) => {
          resolveCreate = resolve;
        });
      },
      setView: () => {},
      autoGrow: () => {},
    });
    context._chatAttachTryBeginSend = () => () => {};
    context._chatAttachSnapshotForSend = async () => ({ ok: true, items: [] });
    elements['new-chat-input'] = stubEl({ value: 'hello world' });
    elements['new-chat-send-btn'] = stubEl();

    // First submit: parks on the (unresolved) create fetch with text intact.
    const first = context.handleNewChatSubmit();
    await new Promise((r) => setTimeout(r, 0));
    expect(createCalls.filter((u) => u.includes('/conversations/create'))).toHaveLength(1);

    // Key auto-repeat fires again while the first create is still in flight.
    await context.handleNewChatSubmit();
    expect(createCalls.filter((u) => u.includes('/conversations/create'))).toHaveLength(1);

    // Fail the first create: gate must release so the user can retry.
    resolveCreate({ json: async () => ({ ok: false, error: 'boom' }) });
    await first;
    // Retry submit re-enters (don't await — its create stays pending by design).
    void context.handleNewChatSubmit();
    await new Promise((r) => setTimeout(r, 0));
    expect(createCalls.filter((u) => u.includes('/conversations/create'))).toHaveLength(2);
  });
});

describe('submitted composer ownership across asynchronous sends', () => {
  function loadSender(busy: boolean, delayed: 'attachments' | 'send') {
    const stored = new Map<string, string>();
    const sent: any[] = [];
    const alerts: string[] = [];
    let release!: (response: any) => void;
    const blocked = new Promise((resolve) => { release = resolve; });
    let entered!: () => void;
    const reachedBoundary = new Promise<void>((resolve) => { entered = resolve; });
    const { context, elements } = loadConversation({
      currentCid: 'c1',
      ensureModelConfigured: () => true,
      _DRAFT_KEY: (cid: string) => `draft_${cid}`,
      localStorage: {
        getItem: (key: string) => stored.get(key) || null,
        setItem: (key: string, value: string) => { stored.set(key, value); },
        removeItem: (key: string) => { stored.delete(key); },
      },
      uiAlert: async (message: string) => { alerts.push(message); },
    });
    vm.runInContext(fs.readFileSync(path.join(rendererRoot, 'modules/queue-draft.js'), 'utf8'), context);
    elements['chat-input'] = stubEl({ value: 'First message' });
    const input = elements['chat-input'];
    const firstQuote = { sourceCid: 'source', msgId: 'first', text: 'First reference' };
    const laterQuote = { sourceCid: 'source', msgId: 'later', text: 'Later reference' };
    context._addQuote('c1', firstQuote);
    context._chatAttachSet('c1', [{ name: 'brief.pdf', status: 'ready' }]);
    context.isConvPending = () => busy;
    context._recipientSnapshotForSend = () => ({ kind: 'agent', id: context.currentCid === 'c1' ? 'author' : 'designer' });
    context._commanderMentionDisplayForSend = () => ({});
    context._composerEffectiveDispatchMode = () => null;
    context._applyRecipientPrefixWithSnapshot = (text: string, recipient: any) => `${recipient.id}: ${text}`;
    context.transformWithChatUse = (text: string) => text;
    context._referenceSnapshotsForQuotes = (quotes: any[]) => quotes;
    context.getChatUseSelections = () => [];
    context.sendInConversation = async (cid: string, content: string, extra: any) => {
      sent.push({ cid, content, ...extra });
    };
    context.apiFetch = async (url: string, options: any) => {
      if (url.endsWith('/attachments')) {
        if (delayed === 'attachments') { entered(); await blocked; }
        return { json: async () => ({ ok: true, items: [{ name: 'brief.pdf', kind: 'pdf', bytes: 10 }] }) };
      }
      sent.push({ cid: decodeURIComponent(url.split('/')[3]), ...JSON.parse(options.body) });
      if (delayed === 'send' && sent.length === 1) { entered(); return { json: () => blocked }; }
      return { json: async () => ({ ok: true }) };
    };
    return { context, input, stored, sent, alerts, laterQuote, release, reachedBoundary };
  }

  it.each([
    { busy: true, delayed: 'send' as const },
    { busy: true, delayed: 'attachments' as const },
    { busy: false, delayed: 'attachments' as const },
  ])('preserves the next draft during $delayed while busy=$busy', async ({ busy, delayed }) => {
    const s = loadSender(busy, delayed);
    const first = s.context.handleChatSubmit();
    await s.reachedBoundary;
    s.input.value = 'Next message';
    s.context._addQuote('c1', s.laterQuote);
    s.context._saveDraft('c1');
    s.release({ ok: true });
    await first;

    expect(s.sent).toHaveLength(1);
    expect(s.sent[0]).toMatchObject({ cid: 'c1', content: 'author: First message', attachments: ['brief.pdf'] });
    expect(s.sent[0].references.map((q: any) => q.msgId)).toEqual(['first']);
    expect(s.input.value).toBe('Next message');
    expect(s.context._getQuotes('c1').map((q: any) => q.msgId)).toEqual(['later']);
    expect(s.context._chatAttachList('c1')).toEqual([]);
    expect(s.context._readDraftData('c1')).toMatchObject({ text: 'Next message', references: [{ msgId: 'later' }] });
    expect(s.alerts).toEqual([]);
  });

  it.each([true, false])('keeps the destination and other conversation draft after navigation while busy=%s', async (busy) => {
    const s = loadSender(busy, 'attachments');
    const first = s.context.handleChatSubmit();
    await s.reachedBoundary;
    s.context.currentCid = 'c2';
    s.input.value = 'Other conversation draft';
    s.context._addQuote('c2', s.laterQuote);
    // Navigation restores reference objects from persisted JSON. Their stable
    // source/message identities must still belong to the submitted message.
    s.context.currentCid = 'c1';
    s.context._restoreDraft('c1');
    s.context.currentCid = 'c2';
    s.context._restoreDraft('c2');
    s.release({ ok: true });
    await first;

    expect(s.sent).toHaveLength(1);
    expect(s.sent[0]).toMatchObject({ cid: 'c1', content: 'author: First message' });
    expect(s.input.value).toBe('Other conversation draft');
    expect(s.context._readDraftData('c2')).toMatchObject({ text: 'Other conversation draft' });
    expect(s.context._readDraftData('c1')).toEqual({});
    expect(s.context._getQuotes('c2').map((q: any) => q.msgId)).toEqual(['later']);
  });

  it('retains the submitted draft and attachments when the busy send is rejected, then allows retry', async () => {
    const s = loadSender(true, 'send');
    const first = s.context.handleChatSubmit();
    await s.reachedBoundary;
    s.release({ ok: false, error: 'injected rejection' });
    await first;
    expect(s.input.value).toBe('First message');
    expect(s.context._getQuotes('c1').map((q: any) => q.msgId)).toEqual(['first']);
    expect(s.context._chatAttachList('c1').map((a: any) => a.name)).toEqual(['brief.pdf']);
    expect(s.alerts).toEqual(['chat.send_failed']);
    await s.context.handleChatSubmit();
    expect(s.sent).toHaveLength(2);
    expect(s.input.value).toBe('');
    expect(s.context._getQuotes('c1')).toEqual([]);
    expect(s.context._chatAttachList('c1')).toEqual([]);
    expect(s.context._readDraftData('c1')).toEqual({});
    expect(s.alerts).toHaveLength(1);
  });
});

describe('skill file body staleness guard', () => {
  function loadSkills() {
    const bodies: Record<string, any> = {};
    const pending: Record<string, (v: any) => void> = {};
    const elements: Record<string, any> = {
      'skills-detail-body': stubEl(),
      'skills-detail-name': stubEl(),
      'skills-detail-source': stubEl(),
      'skills-detail-content': stubEl(),
      'skills-chat-col': stubEl(),
    };
    const context: any = {
      console, setTimeout, clearTimeout, encodeURIComponent, URLSearchParams,
      Date, JSON, Map, Set, Array, String, Number, RegExp, Promise,
      createLogger: () => ({ warn() {}, info() {}, error() {}, debug() {} }),
      escapeHtml,
      t: (key: string) => key,
      getLang: () => 'en',
      pickDesc: () => '',
      localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
      apiFetch: (url: string) => new Promise((resolve) => {
        const m = /file=([^&]+)/.exec(url);
        const file = m ? decodeURIComponent(m[1]) : url;
        pending[file] = resolve;
      }),
      document: {
        readyState: 'loading',
        addEventListener() {},
        querySelector: () => null,
        querySelectorAll: () => [] as any[],
        getElementById: (id: string) => elements[id] || null,
        createElement: () => stubEl(),
      },
      window: { addEventListener() {} },
      _renderSourceMetaHtml: () => '',
      _mountDetailCategorySelect: () => {},
    };
    context.window.window = context.window;
    const proxied = withNoopFallback(context);
    vm.createContext(proxied);
    vm.runInContext(skillsSource, proxied);
    return { context: proxied, elements, pending, bodies };
  }

  it('a slower earlier file response never overwrites the newer selection body', async () => {
    const { context, elements, pending } = loadSkills();
    context._skillsCache = [{ id: 's1', source: 'custom', name: 'S1' }];

    const selA = context.selectSkillFile('custom', 's1', 'a.md', null);
    const selB = context.selectSkillFile('custom', 's1', 'b.md', null);
    await new Promise((r) => setTimeout(r, 0));

    // b.md resolves first (fast), then a.md's stale response arrives late.
    pending['b.md']({ json: async () => ({ ok: true, content: 'BODY-B', ext: 'md' }) });
    await new Promise((r) => setTimeout(r, 0));
    const afterB = String(elements['skills-detail-body'].innerHTML || elements['skills-detail-body'].textContent || '');

    pending['a.md']({ json: async () => ({ ok: true, content: 'BODY-A', ext: 'md' }) });
    await Promise.allSettled([selA, selB]);

    const finalBody = String(elements['skills-detail-body'].innerHTML || elements['skills-detail-body'].textContent || '');
    expect(afterB).toBe(finalBody); // A's late reply changed nothing
    expect(finalBody).not.toContain('BODY-A');
  });
});
