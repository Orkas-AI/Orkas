import { composerAccessorSource, composerDraftSource } from './composer-test-source';
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

function loadConversation(overrides: Record<string, any> = {}, surface = 'PC') {
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
  vm.runInContext(composerAccessorSource, proxied);
  vm.runInContext(fs.readFileSync(path.join(rendererRoot, 'modules/strip-structural-blocks.js'), 'utf8'), proxied);
  vm.runInContext(conversationSource, proxied);
  return { context: proxied, revoked, elements };
}

describe('empty addressed composer requests', () => {
  it.each(['new-chat', 'conversation', 'project'].flatMap((entry) =>
    ['@commander', '@Orkas Codex', '@Orkas Codex @QuoteReviewer'].map((text) => ({ entry, text }))))(
    'keeps $text in the $entry draft without starting a send', async ({ entry, text }) => {
    let modelChecks = 0;
    let requests = 0;
    const { context, elements } = loadConversation({
      ensureModelConfigured: () => { modelChecks += 1; return false; },
      apiFetch: async () => { requests += 1; throw new Error('An empty request must not reach transport'); },
    });
    if (entry === 'project') {
      vm.runInContext(fs.readFileSync(path.join(rendererRoot, 'modules/project-detail.js'), 'utf8'), context);
      vm.runInContext("_projectDetailPid = 'p_empty'", context);
    }
    vm.runInContext("currentCid = 'c_empty'", context);
    context._agentsCache = [{ agent_id: 'codex', name: 'Orkas Codex' }, { agent_id: 'reviewer', name: 'QuoteReviewer' }];
    if (entry === 'project') {
      vm.runInContext("_composerAgentScopes.set('project', { pid: 'p_empty', ids: new Set(['codex', 'reviewer']) })", context);
    }
    const id = entry === 'conversation' ? 'chat-input' : `${entry}-chat-input`;
    const inputId = entry === 'new-chat' ? 'new-chat-input' : id;
    elements[inputId] = stubEl({ value: text });
    Object.assign(context, { _getQuotes: () => [], _chatAttachList: () => [], getChatUseSelections: () => [] });
    await (entry === 'project' ? context._submitProjectChat()
      : entry === 'conversation' ? context.handleChatSubmit() : context.handleNewChatSubmit());
    expect(modelChecks).toBe(0);
    expect(requests).toBe(0);
    expect(elements[inputId].value).toBe(text);
  });
});

describe('attachment order continuity across input surfaces', () => {
  it('retains the first selection position when duplicate uploads complete in reverse order', () => {
    const { context } = loadConversation();
    context._chatAttachSet('task-a', [
      { tempId: 'first', name: 'z-first.txt', status: 'uploading' },
      { tempId: 'middle', name: 'a-middle.txt', status: 'ready' },
      { tempId: 'last', name: 'duplicate.txt', status: 'uploading' },
    ]);
    context._chatAttachReplaceByTempId('task-a', 'last', { name: 'z-first.txt', status: 'ready' });
    context._chatAttachReplaceByTempId('task-a', 'first', { name: 'z-first.txt', status: 'ready' });
    expect(context._chatAttachList('task-a').map((item: any) => item.name)).toEqual(['z-first.txt', 'a-middle.txt']);
  });

  it.each([
    ['PC', 'main_chat'], ['PC', 'task-a'], ['PC', 'projchat-p'], ['PC', 'agent-edit-a'], ['PC', 'skill-edit-s'],
  ])('%s %s keeps selection order after reopening and a renderer reload', async (surface, cid) => {
    const saved = new Map<string, string>();
    const names = ['z-first.png', 'a-second.png', 'm-third.txt'];
    const infos = names.map((name) => ({ name, kind: 'text', bytes: 1, status: 'ready' }));
    const overrides = { currentUserId: 'owner', localStorage: {
      getItem: (key: string) => saved.get(key) || null,
      setItem: (key: string, value: string) => saved.set(key, value),
      removeItem: (key: string) => saved.delete(key),
    }, apiFetch: async () => ({ json: async () => ({ ok: true, items: [...infos].reverse() }) }) };
    const first = loadConversation(overrides, surface).context;
    first._chatAttachSet(cid, infos);
    await first._chatAttachRefreshFromServer(cid);
    expect(first._chatAttachList(cid).map((item: any) => item.name)).toEqual(names);
    const reopened = loadConversation(overrides, surface).context;
    await reopened._chatAttachRefreshFromServer(cid);
    expect(reopened._chatAttachList(cid).map((item: any) => item.name)).toEqual(names);
    await reopened._chatAttachClear(cid);
    expect(saved.size).toBe(0);
  });

  it.each(['Agent', 'Skill'])('%s editing sends the same attachment order after refreshing the composer', async (kind) => {
    const cid = `${kind.toLowerCase()}-edit-abc`;
    const names = ['z-first.png', 'a-second.png'];
    const infos = names.map((name) => ({ name, kind: 'image', bytes: 1, status: 'ready' }));
    const { context } = loadConversation({ apiFetch: async () => ({ json: async () => ({ ok: true, items: [...infos].reverse() }) }) });
    const source = fs.readFileSync(path.join(rendererRoot, `modules/${kind.toLowerCase()}s.js`), 'utf8');
    const start = source.indexOf(`async function _build${kind}EditChatExtraBody(`);
    const end = source.indexOf(`\nfunction _ensure${kind}ChatController`, start);
    context[`_${kind.toLowerCase()}EditAttachmentCid`] = () => cid;
    vm.runInContext(source.slice(start, end), context);
    context._chatAttachSet(cid, infos);
    await context._chatAttachRefreshFromServer(cid);
    expect(await context[`_build${kind}EditChatExtraBody`]('Compare', 'abc', {})).toEqual({ attachments: names, attachment_cid: cid });
  });
});

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
  it.each(['new-chat', 'project'])('keeps one %s task when a list refresh runs during attachment adoption', async (entry) => {
    let releaseAdoption!: (value: any) => void;
    let reachedAdoption!: () => void;
    const adoptionStarted = new Promise<void>((resolve) => { reachedAdoption = resolve; });
    const original = { conversation_id: 'c_adopt_race', title: 'Initial title',
      created_at: '2026-05-15T09:00:00Z', updated_at: '2026-05-15T09:00:00Z',
      ...(entry === 'project' ? { project_id: 'p_race' } : {}) };
    const current = { ...original, title: 'Title changed while waiting', title_manually_set: true,
      updated_at: '2026-05-15T09:01:00Z', last_active_at: '2026-05-15T09:01:00Z', processing: true };
    const sends: any[] = [];
    let creates = 0;
    const { context, elements } = loadConversation({
      ensureModelConfigured: () => true,
      apiFetch: async (url: string) => {
        if (url.endsWith('/create')) {
          creates += 1;
          return { json: async () => ({ ok: true, conversation: { ...original } }) };
        }
        if (url.endsWith('/adopt')) {
          reachedAdoption();
          return new Promise((resolve) => { releaseAdoption = resolve; });
        }
        if (url.startsWith('/api/conversations/list')) return { json: async () => ({
          ok: true, conversations: [current], unprojected_pagination: { total: 1, next_offset: null },
          total: 1, next_offset: null,
        }) };
        throw new Error(`Unexpected fixture request: ${url}`);
      },
    });
    if (entry === 'project') {
      vm.runInContext(fs.readFileSync(path.join(rendererRoot, 'modules/project-detail.js'), 'utf8'), context);
      vm.runInContext("_projectDetailPid = 'p_race'", context);
    }
    Object.assign(context, {
      currentView: entry === 'project' ? 'project' : 'new-chat',
      _chatAttachTryBeginSend: () => () => {},
      _chatAttachSnapshotForSend: async () => ({ ok: true, items: [{ name: 'brief.pdf', status: 'ready' }] }),
      _recipientSnapshotForSend: () => ({ kind: 'commander' }),
      _getQuotes: () => [], _referenceSnapshotsForQuotes: () => [],
      transformWithChatUse: (text: string) => text, transformChatUseTokens: (text: string) => text,
      applyRecipientPrefix: (text: string) => text,
      _titleSeedWithoutRoutingMentions: (text: string) => text,
      _commanderMentionDisplayForSend: () => ({}),
      _autoTitle: (text: string) => text,
      getChatUseSelections: () => [], consumeChatUseSelections: () => [],
      renderConversationList() {}, loadProjects() {}, setView() {}, setChatRecipient() {},
      _renderRecipientChip() {}, _saveRecipientMap() {},
      unresolvedOssTemplatePlaceholder: () => false,
      sendInConversation: async (...args: any[]) => { sends.push(args); },
    });
    elements[entry === 'project' ? 'project-chat-input' : 'new-chat-input'] = stubEl({ value: 'Review the brief' });
    const submit = entry === 'project' ? context._submitProjectChat() : context.handleNewChatSubmit();
    await adoptionStarted;
    await context.loadConversations();
    releaseAdoption({ json: async () => ({ ok: true,
      items: [{ sourceName: 'brief.pdf', targetName: 'brief (1).pdf' }],
    }) });
    await submit;
    expect(creates).toBe(1);
    expect(context.conversations).toEqual([current]);
    expect(sends).toHaveLength(1);
    expect(sends[0].slice(0, 3)).toEqual(['c_adopt_race', 'Review the brief', {
      title_text: 'Review the brief', attachments: ['brief (1).pdf'],
    }]);
  });

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

describe('conversation send ownership across navigation', () => {
  it.each(['attachments', 'floor', 'busy-response', 'unchanged', 'new-draft'])('keeps submission and draft ownership during %s', async (phase) => {
    const sends: any[] = [];
    const clearedDrafts: string[] = [];
    let resume!: (value?: any) => void;
    let reached!: () => void;
    const waiting = new Promise<void>((resolve) => { reached = resolve; });
    const held = new Promise<any>((resolve) => { resume = resolve; });
    const { context, elements } = loadConversation({ currentCid: 'task-a' });
    context._DRAFT_KEY = (cid: string) => `draft:${cid}`;
    vm.runInContext(composerDraftSource, context);
    const input = stubEl({ value: 'Review A' });
    elements['chat-input'] = input;
    context.ensureModelConfigured = () => true;
    context._isQueueItemEditing = () => false;
    context._getQuotes = () => [];
    context._referenceSnapshotsForQuotes = () => [];
    context.getChatUseSelections = () => [];
    context._chatModelTelemetryContext = () => ({});
    context._readConversationTemplateAttribution = () => ({});
    context._unresolvedQuickStartPlaceholder = () => '';
    context._chatAttachSnapshotForSend = async () => {
      if (['attachments', 'unchanged', 'new-draft'].includes(phase)) { reached(); await held; }
      return { ok: true, items: [{ name: 'a.txt', status: 'ready' }], names: ['a.txt'] };
    };
    context._recipientSnapshotForSend = () => ({ kind: 'agent', id: context.currentCid, name: context.currentCid });
    context._commanderMentionDisplayForSend = () => ({});
    context._applyRecipientPrefixWithSnapshot = (text: string, recipient: any) => `@${recipient.id} ${text}`;
    context.transformWithChatUse = (text: string) => text;
    context.isConvPending = () => phase === 'busy-response';
    context._clearDraft = (cid: string) => { clearedDrafts.push(cid); };
    context._clearQuotes = () => {};
    context.autoGrow = () => {};
    context._rememberSentComposerSnapshot = () => {};
    context.sendInConversation = async (cid: string, content: string, extra: any) => {
      sends.push({ cid, content, extra });
      return { started: true };
    };
    context.apiFetch = async (url: string, options: any) => {
      sends.push({ cid: url.split('/')[3], ...JSON.parse(options.body) });
      reached();
      await held;
      return { json: async () => ({ ok: true }) };
    };
    if (phase === 'floor') {
      context.floorWait = held.then(() => ({}));
      vm.runInContext("_floorSyncByCid.set('task-a', floorWait)", context);
      context._chatAttachSnapshotForSend = async () => {
        reached();
        return { ok: true, items: [], names: [] };
      };
    }
    context._saveDraft('task-a');
    const sending = context.handleChatSubmit();
    await waiting;
    // Let the attachment continuation reach the held floor write.
    await Promise.resolve();
    const navigates = !['unchanged', 'new-draft'].includes(phase);
    if (navigates) {
      context.currentCid = 'task-b';
      input.value = 'Unsent B draft';
    } else if (phase === 'new-draft') {
      input.value = 'Updated A draft';
      context._saveDraft('task-a'); // real composer-change listener records this edit
    }
    resume();
    await sending;
    expect(sends).toHaveLength(1);
    expect(sends[0].cid).toBe('task-a');
    expect(sends[0].content).toBe('@task-a Review A');
    expect(input.value).toBe(navigates ? 'Unsent B draft' : phase === 'new-draft' ? 'Updated A draft' : '');
    expect(clearedDrafts).toEqual(phase === 'new-draft' ? [] : ['task-a']);
    expect(vm.runInContext("_chatAttachmentSendLocks.has('task-a')", context)).toBe(false);
  });
});

describe('composer attachment send lifecycle', () => {
  function setup(entry: string) {
    const sends: any[] = [];
    const alerts: string[] = [];
    const requests: string[] = [];
    const { context, elements } = loadConversation({ currentCid: 'task-a' });
    if (entry === 'project') {
      vm.runInContext(fs.readFileSync(path.join(rendererRoot, 'modules/project-detail.js'), 'utf8'), context);
      vm.runInContext("_projectDetailPid = 'p_send'", context);
    }
    Object.assign(context, {
      currentView: entry,
      ensureModelConfigured: () => true,
      _isQueueItemEditing: () => false,
      _getQuotes: () => [],
      getChatUseSelections: () => [],
      _recipientSnapshotForSend: () => ({ kind: 'commander' }),
      _commanderMentionDisplayForSend: () => ({}),
      transformWithChatUse: (text: string) => text,
      transformChatUseTokens: (text: string) => text,
      applyRecipientPrefix: (text: string) => text,
      _applyRecipientPrefixWithSnapshot: (text: string) => text,
      _titleSeedWithoutRoutingMentions: (text: string) => text,
      _autoTitle: (text: string) => text,
      unresolvedOssTemplatePlaceholder: () => false,
      isConvPending: () => false,
      _rememberSentComposerSnapshot() {},
      renderConversationList() {}, loadProjects() {}, setView() {},
      _renderRecipientChip() {}, _saveRecipientMap() {},
      uiAlert: async (message: string) => { alerts.push(message); },
      sendInConversation: async (...args: any[]) => { sends.push(args); },
      apiFetch: async (url: string) => {
        requests.push(url);
        if (url.endsWith('/attachments') || url.endsWith('/adopt')) {
          return { json: async () => ({ ok: true, items: [] }) };
        }
        if (url.endsWith('/create')) return { json: async () => ({ ok: true,
          conversation: { conversation_id: 'created', created_at: '2026-10-20T00:00:00Z' },
        }) };
        throw new Error('Unexpected send request');
      },
    });
    const inputId = entry === 'conversation' ? 'chat-input'
      : entry === 'project' ? 'project-chat-input' : 'new-chat-input';
    elements[inputId] = stubEl({ value: 'Send this text' });
    elements[entry === 'project' ? 'project-chat-send-btn' : 'new-chat-send-btn'] = stubEl();
    const cid = entry === 'conversation' ? 'task-a' : entry === 'project' ? 'projchat-p_send' : 'main_chat';
    const submit = () => entry === 'conversation' ? context.handleChatSubmit()
      : entry === 'project' ? context._submitProjectChat() : context.handleNewChatSubmit();
    return { context, elements, inputId, cid, submit, sends, alerts, requests };
  }

  it.each(['new-chat', 'conversation', 'project'])('preserves authored attachment order through refresh and %s send', async (entry) => {
    const { context, elements, cid, submit, sends, alerts } = setup(entry);
    const names = ['image.png', 'image-20261021-122943.png', 'alpha.txt'];
    const infos = names.map((name) => ({ name, kind: name.endsWith('.png') ? 'image' : 'text', bytes: 1 }));
    const fetch = context.apiFetch;
    context.apiFetch = async (url: string) => {
      if (url.endsWith('/attachments')) return { json: async () => ({ ok: true, items: [...infos].reverse() }) };
      if (url.endsWith('/adopt')) return { json: async () => ({ ok: true,
        items: [...names].reverse().map((name) => ({ sourceName: name, targetName: `saved-${name}` })),
      }) };
      return fetch(url);
    };
    const host = entry === 'conversation' ? 'chat-attachments' : entry === 'project' ? 'project-chat-attachments' : 'new-chat-attachments';
    elements[host] = stubEl();
    context._chatAttachSet(cid, infos.map((info) => ({ ...info, status: 'ready' })));
    await context._chatAttachRefreshFromServer(cid);
    expect(context._chatAttachList(cid).map((item: any) => item.name)).toEqual(names);
    expect([...elements[host].innerHTML.matchAll(/class="chat-attach-label">([^<]+)/g)].map((m: any) => m[1])).toEqual(names);
    await submit();
    expect(alerts).toEqual([]);
    expect(sends).toHaveLength(1);
    const expected = entry === 'conversation' ? names : names.map((name) => `saved-${name}`);
    expect(sends[0][2].attachments).toEqual(expected);
    const bubble = context._renderMessageAttachmentsHtml(sends[0][2].attachments, sends[0][0]);
    expect([...bubble.matchAll(/data-attach-name="([^"]+)"/g)].map((m: any) => m[1])).toEqual(expected);
  });

  it('keeps reused and pending files interleaved on retry and queued-message edits', async () => {
    const { context, cid } = setup('conversation');
    const names = ['z-old.png', 'b-new.png', 'a-old.png', 'c-new.png'];
    const infos = names.map((name, i) => ({ name, kind: 'image', bytes: 1, status: 'ready', reused: i % 2 === 0 }));
    context._chatAttachSet(cid, infos);
    let fail = true;
    context.apiFetch = async () => ({ json: async () => fail ? { ok: false } : {
      ok: true, items: [infos[3], infos[1], { name: 'recovered.txt', kind: 'text', bytes: 1 }],
    } });
    expect((await context._chatAttachSnapshotForSend(cid)).ok).toBe(false);
    expect(context._chatAttachList(cid).map((item: any) => item.name)).toEqual(names);
    fail = false;
    expect((await context._chatAttachSnapshotForSend(cid, { onlySelected: true })).names).toEqual(names);
    expect((await context._chatAttachSnapshotForSend(cid)).names).toEqual([...names, 'recovered.txt']);
  });

  it.each(['new-chat', 'conversation', 'project'])('ignores repeated %s submit during an empty attachment preflight', async (entry) => {
    const fixture = setup(entry);
    const { context, submit, sends, alerts, requests } = fixture;
    const fetch = context.apiFetch;
    let resume!: () => void;
    const held = new Promise<void>((resolve) => { resume = resolve; });
    context.apiFetch = async (url: string) => {
      if (url.endsWith('/attachments')) await held;
      return fetch(url);
    };
    const first = submit();
    await submit();
    resume();
    await first;
    expect(alerts).toEqual([]);
    expect(sends).toHaveLength(1);
    expect(requests.filter((url) => url.endsWith('/attachments'))).toHaveLength(1);
    expect(sends[0][1]).toBe('Send this text');
  });

  it.each(['new-chat', 'conversation', 'project'])('allows a %s retry after preparation throws with no attachments', async (entry) => {
    const { context, elements, inputId, cid, submit, sends, alerts, requests } = setup(entry);
    const references = context._referenceSnapshotsForQuotes;
    context._referenceSnapshotsForQuotes = () => { throw new Error('Preparation interrupted'); };
    await expect(submit()).rejects.toThrow('Preparation interrupted');
    expect(elements[inputId].value).toBe('Send this text');
    expect(sends).toEqual([]);
    expect(requests.some((url) => url.endsWith('/create'))).toBe(false);
    expect(vm.runInContext(`_chatAttachmentSendLocks.has('${cid}')`, context)).toBe(false);
    context._referenceSnapshotsForQuotes = references;
    await submit();
    expect(alerts).toEqual([]);
    expect(sends).toHaveLength(1);
  });

  it.each(['new-chat', 'conversation', 'project'])('keeps the %s draft blocked until an actual attachment operation completes', async (entry) => {
    const { context, elements, inputId, cid, submit, sends, alerts, requests } = setup(entry);
    // File reads and native picking begin before there is an attachment chip.
    const finish = context._chatAttachBeginOperation(cid);
    await submit();
    expect(alerts).toEqual(['chat.attach_still_uploading']);
    expect(requests).toEqual([]);
    expect(sends).toEqual([]);
    expect(elements[inputId].value).toBe('Send this text');
    finish();
    await submit();
    expect(sends).toHaveLength(1);
    expect(alerts).toHaveLength(1);
  });

  it('does not submit a busy conversation twice while its send response is pending', async () => {
    const { context, elements, inputId, submit, sends, alerts, requests } = setup('conversation');
    context.isConvPending = () => true;
    const fetch = context.apiFetch;
    let resume!: () => void;
    let reached!: () => void;
    const waiting = new Promise<void>((resolve) => { reached = resolve; });
    const held = new Promise<void>((resolve) => { resume = resolve; });
    context.apiFetch = async (url: string) => {
      if (!url.endsWith('/send')) return fetch(url);
      requests.push(url);
      reached();
      await held;
      return { json: async () => ({ ok: true }) };
    };
    const first = submit();
    await waiting;
    await submit();
    resume();
    await first;
    expect(alerts).toEqual([]);
    expect(requests.filter((url) => url.endsWith('/send'))).toHaveLength(1);
    expect(sends).toEqual([]);
    expect(elements[inputId].value).toBe('');
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
  vm.runInContext(composerAccessorSource, proxied);
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
