import { composerAccessorSource } from './composer-test-source';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vm from 'node:vm';

// Stopping a running turn hands the message that started it back to the
// composer so the user can adjust and resend. The snapshot must be the message
// the user *authored* (raw text, inline use tokens, recipient chip, references,
// attachments), never the dispatched payload — resending an already-expanded
// payload would double-apply the skill prefix and the `@Agent` routing tag.

const conversationSource = fs.readFileSync(
  path.join(__dirname, '../../src/renderer/modules/conversation.js'),
  'utf8',
);

function extractFunction(name: string): string {
  const marker = `function ${name}`;
  const start = conversationSource.indexOf(marker);
  if (start < 0) throw new Error(`missing ${name}`);
  // Scan from the end of the signature, not the first `{` — a default
  // parameter value such as `options = {}` would otherwise close the body.
  const signatureEnd = conversationSource.indexOf(') {', start);
  const braceStart = signatureEnd < 0 ? -1 : signatureEnd + 2;
  if (braceStart < 0) throw new Error(`missing body for ${name}`);
  let depth = 0;
  for (let i = braceStart; i < conversationSource.length; i += 1) {
    const ch = conversationSource[i];
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return conversationSource.slice(start, i + 1);
    }
  }
  throw new Error(`unterminated ${name}`);
}

function loadQueueDraft(stored = new Map<string, string>()) {
  const source = fs.readFileSync(
    path.join(__dirname, '../../src/renderer/modules/queue-draft.js'),
    'utf8',
  );
  const input = {
    value: '',
    focus: vi.fn(),
    setSelectionRange: vi.fn(),
  };
  const attachmentsByCid = new Map<string, any[]>();
  const recipientsByCid = new Map<string, any>();
  const queueEditRecipientsByCid = new Map<string, any>();
  const quotesByCid = new Map<string, any[]>();
  const context: any = {
    Map,
    Set,
    Date,
    Math,
    JSON,
    Promise,
    encodeURIComponent,
    clearTimeout,
    setTimeout,
    currentCid: '',
    messageQueues: new Map(),
    localStorage: {
      getItem: (key: string) => stored.get(key) ?? null,
      setItem: (key: string, value: string) => { stored.set(key, value); },
      removeItem: (key: string) => { stored.delete(key); },
    },
    document: {
      getElementById: (id: string) => (id === 'chat-input' ? input : null),
    },
    _DRAFT_KEY: (cid: string) => `draft:${cid}`,
    _updateConvSidebarBadge: vi.fn(),
    _updateConvSendUI: vi.fn(),
    escapeHtml: (value: unknown) => String(value ?? ''),
    formatChatUseLabel: (value: any) => value?.name || value?.id || '',
    formatChatUseTextForDisplay: (value: string) => value,
    apiFetch: vi.fn(),
    uiAlert: vi.fn(),
    t: (key: string) => key,
    _renderOrClaimPersistedUserMessage: vi.fn(),
    _queueSendNowActiveTurns: () => [],
    _quotesByCid: quotesByCid,
    _getQuotes: (cid: string) => quotesByCid.get(cid) || [],
    _renderQuotePreview: vi.fn(),
    _forgetCidRecipient: vi.fn(),
    isConvPending: vi.fn(() => false),
    // Mirrors the real prefixing: routing lives in the dispatched payload only.
    applyRecipientPrefix: (content: string, _target: string, opts: any = {}) => {
      const recipient = opts.recipientSnapshot;
      return recipient && recipient.kind === 'agent'
        ? `@${recipient.name} ${content}`
        : content;
    },
    transformWithChatUse: (content: string, selection: any) => (
      selection ? `use ${selection.name} skill: ${content}` : content
    ),
    sendInConversation: vi.fn(),
    autoGrow: vi.fn(),
    setChatUseSelection: vi.fn(),
    setChatRecipient: vi.fn((_target: string, recipient: any) => {
      recipientsByCid.set(context.currentCid, recipient);
    }),
    focusChatRichComposer: vi.fn(() => false),
    refreshChatComposer: vi.fn(),
    _chatAttachList: (cid: string) => attachmentsByCid.get(cid) || [],
    _chatAttachSet: (cid: string, items: any[]) => { attachmentsByCid.set(cid, items); },
    _chatAttachExtOf: (name: string) => {
      const dot = name.lastIndexOf('.');
      return dot >= 0 ? name.slice(dot).toLowerCase() : '';
    },
    _chatAttachKindFromExt: (ext: string) => (
      ['.png', '.jpg', '.jpeg'].includes(ext) ? 'image' : 'text'
    ),
    _chatMediaUrl: (cid: string, name: string) => `chat-media://${cid}/${name}`,
    getChatRecipient: () => (
      recipientsByCid.get(context.currentCid)
      || { kind: 'commander', id: '', name: '' }
    ),
    _setQueueEditRecipient: vi.fn((cid: string, recipient: any) => {
      queueEditRecipientsByCid.set(cid, recipient);
    }),
    _clearQueueEditRecipient: vi.fn((cid: string) => { queueEditRecipientsByCid.delete(cid); }),
    getChatUseSelections: () => [],
    _normalizeChatUseSelection: (value: any) => value || null,
    _normalizeChatUseSelections: (value: any) => (
      (Array.isArray(value) ? value : [value]).filter(Boolean)
    ),
    _chatUseSelectionsFromText: (text: string) => (
      text.includes('[skill:') ? [{ kind: 'skill', id: 'writer', name: 'writer' }] : []
    ),
    _chatUseTokenFor: (selection: any) => `[${selection.kind}:${selection.id}]`,
    _normaliseRecipientSnapshot: (recipient: any) => (recipient ? { ...recipient } : null),
    _referenceSnapshotsForQuotes: (references: any[]) => references,
  };
  vm.createContext(context);
  vm.runInContext(composerAccessorSource, context);
  vm.runInContext(source, context, { filename: 'queue-draft.js' });
  return { context, input, stored, attachmentsByCid, recipientsByCid, quotesByCid };
}

const AUTHORED = {
  text: 'tighten the intro [skill:writer]',
  recipient: { kind: 'agent', id: 'agent-writer', name: 'Writer' },
  references: [{ sourceCid: 'conv-b', msgId: 'msg-9', text: 'previous draft' }],
  attachments: [{ name: 'brief.png', kind: 'image', bytes: 2048 }],
};

describe('composer restore after a user stop', () => {
  it('hands the authored message back with its chips', () => {
    const { context, input, stored, attachmentsByCid, recipientsByCid, quotesByCid } = loadQueueDraft();
    context.currentCid = 'conv-a';

    context._rememberSentComposerSnapshot('conv-a', AUTHORED);
    expect(context._restoreSentComposerSnapshot('conv-a')).toBe(true);

    expect(input.value).toBe('tighten the intro [skill:writer]');
    expect(quotesByCid.get('conv-a')).toEqual([
      expect.objectContaining({ sourceCid: 'conv-b', msgId: 'msg-9', text: 'previous draft' }),
    ]);
    // The sent message still references these files, so the restored chips must
    // be reused — removing one here cannot delete bytes off disk.
    expect(attachmentsByCid.get('conv-a')).toEqual([
      expect.objectContaining({ name: 'brief.png', kind: 'image', reused: true, status: 'ready' }),
    ]);
    expect(recipientsByCid.get('conv-a')).toMatchObject({ kind: 'agent', id: 'agent-writer' });
    expect(JSON.parse(stored.get('draft:conv-a')!).text).toBe('tighten the intro [skill:writer]');
    expect(input.focus).toHaveBeenCalled();

    // One stop restores one message.
    expect(context._restoreSentComposerSnapshot('conv-a')).toBe(false);
  });

  it('restores the authored multi-recipient draft with its original single default', () => {
    const { context, input, recipientsByCid } = loadQueueDraft();
    context.currentCid = 'conv-a';
    context._rememberSentComposerSnapshot('conv-a', {
      ...AUTHORED, text: 'review first @Reviewer check',
      recipient: { kind: 'group', recipients: [AUTHORED.recipient, { kind: 'agent', id: 'reviewer', name: 'Reviewer' }], defaultRecipient: AUTHORED.recipient },
    });
    expect(context._restoreSentComposerSnapshot('conv-a')).toBe(true);
    expect(input.value).toBe('review first @Reviewer check');
    expect(recipientsByCid.get('conv-a')).toMatchObject({ kind: 'agent', id: 'agent-writer' });
  });

  it('keeps input the user typed while waiting and drops the snapshot', () => {
    const { context, input } = loadQueueDraft();
    context.currentCid = 'conv-a';
    context._rememberSentComposerSnapshot('conv-a', AUTHORED);
    input.value = 'actually, hold on';

    expect(context._restoreSentComposerSnapshot('conv-a')).toBe(false);
    expect(input.value).toBe('actually, hold on');
    input.value = '';
    expect(context._restoreSentComposerSnapshot('conv-a')).toBe(false);
  });

  it('writes a draft instead of painting a conversation that is not open', () => {
    const { context, input, stored, attachmentsByCid } = loadQueueDraft();
    context.currentCid = 'conv-open';

    context._rememberSentComposerSnapshot('conv-background', AUTHORED);
    expect(context._restoreSentComposerSnapshot('conv-background')).toBe(true);

    expect(input.value).toBe('');
    expect(attachmentsByCid.has('conv-background')).toBe(false);
    expect(JSON.parse(stored.get('draft:conv-background')!)).toMatchObject({
      text: 'tighten the intro [skill:writer]',
    });
  });

  it('drops the snapshot when the conversation is deleted', () => {
    const { context } = loadQueueDraft();
    context.currentCid = 'conv-a';
    context._rememberSentComposerSnapshot('conv-a', AUTHORED);

    context._forgetConvLocal('conv-a');

    expect(context._restoreSentComposerSnapshot('conv-a')).toBe(false);
  });

  it('supersedes the previous snapshot when the next message starts a turn', () => {
    const { context, input } = loadQueueDraft();
    context.currentCid = 'conv-a';

    context._rememberSentComposerSnapshot('conv-a', { ...AUTHORED, text: 'first turn' });
    context._rememberSentComposerSnapshot('conv-a', { ...AUTHORED, text: 'second turn' });

    expect(context._restoreSentComposerSnapshot('conv-a')).toBe(true);
    expect(input.value).toBe('second turn');
  });
});

describe('stop and settlement wiring', () => {
  function runAbort(options: Record<string, unknown>, tracked = true) {
    const restore = vi.fn();
    const context: any = {
      Map,
      Set,
      Promise,
      pendingConvs: new Map(tracked ? [['conv-a', { controller: { abort: vi.fn() }, aborted: false }]] : []),
      _latestActiveTurns: new Map([['conv-a', [{ actor: 'cli-a', turn_id: 'old-turn', steerable: true }]],
        ['conv-other', [{ actor: 'cli-b', turn_id: 'other-turn', steerable: true }]]]),
      window: { CliAsyncInput: { setActiveTurns: vi.fn() } },
      _groupPlaceholders: new Map(),
      currentCid: 'conv-a',
      _trackTaskStopClick: vi.fn(),
      _restoreSentComposerSnapshot: restore,
      _stopRuntimeActorRecovery: vi.fn(),
      _stopGroupEventObserver: vi.fn(),
      setGroupConversationBusy: vi.fn(),
      apiFetch: vi.fn(() => ({ catch: () => ({ finally: () => {} }) })),
      _refreshTaskSurfacesAfterAbort: vi.fn(),
      _beginTaskSurfaceAbortRefresh: vi.fn(() => ({ settled: false })),
      _updateConvSidebarBadge: vi.fn(),
      _updateConvSendUI: vi.fn(),
      _streamingMarkAborted: vi.fn(),
      stopPolling: vi.fn(),
      document: { getElementById: () => null },
    };
    vm.createContext(context);
  vm.runInContext(composerAccessorSource, context);
    vm.runInContext(`
      ${extractFunction('_settleConversationPlaceholdersOnAbort')}
      ${extractFunction('abortConvStream')}
    `, context, { filename: 'abort.js' });
    context.abortConvStream('conv-a', options);
    return { restore, context };
  }

  it('restores only when the user pressed stop', () => {
    expect(runAbort({ userInitiated: true }).restore).toHaveBeenCalledWith('conv-a');
    // Conversation delete and missing-conversation recovery also abort; neither
    // is an edit intent, so the composer must be left alone.
    expect(runAbort({}).restore).not.toHaveBeenCalled();
  });

  it.each([true, false])('expires questions only for the stopped conversation after streams detach (tracked=%s)', tracked => {
    const { context } = runAbort({ userInitiated: true }, tracked);
    expect(context._latestActiveTurns.get('conv-a')).toEqual([]);
    expect(context._latestActiveTurns.get('conv-other')).toEqual([
      { actor: 'cli-b', turn_id: 'other-turn', steerable: true },
    ]);
    expect(context.window.CliAsyncInput.setActiveTurns).toHaveBeenCalledExactlyOnceWith('conv-a', []);
    // Invalidating the view must not submit or cancel an answer on the user's behalf.
    expect(context.apiFetch).toHaveBeenCalledExactlyOnceWith('/api/conversations/conv-a/abort', { method: 'POST' });
  });

  it('drops the snapshot when the turn settles', () => {
    const clear = vi.fn();
    const watermarks = new Map([['conv-a', 12], ['conv-other', 20]]);
    const offViewDirty = new Set(['conv-a', 'conv-other']);
    const context: any = {
      Map,
      Set,
      pendingConvs: new Map([['conv-a', { aborted: false }]]),
      currentCid: 'conv-other',
      _clearSentComposerSnapshot: clear,
      _liveDisplayWatermarks: watermarks,
      _offViewLiveDisplayDirty: offViewDirty,
      _stopRuntimeActorRecovery: vi.fn(),
      _stopGroupEventObserver: vi.fn(),
      _lastGroupWorkEventAt: new Map(),
      isGroupConversationBusy: vi.fn(() => false),
      startPolling: vi.fn(),
      stopPolling: vi.fn(),
      _updateConvSidebarBadge: vi.fn(),
      _dispatchNextQueued: vi.fn(),
      document: { getElementById: () => null },
    };
    vm.createContext(context);
  vm.runInContext(composerAccessorSource, context);
    vm.runInContext(`${extractFunction('_finishStreamingMsg')}`, context, { filename: 'finish.js' });

    context._finishStreamingMsg('conv-a');

    expect(clear).toHaveBeenCalledWith('conv-a');
    expect([...watermarks]).toEqual([['conv-other', 20]]);
    // Composer state is retired, but a background transcript must still fetch
    // its saved terminal reply when the user returns to it.
    expect([...offViewDirty]).toEqual(['conv-a', 'conv-other']);
  });
});


function loadAbortTaskSurfaceLifecycle() {
  const abortReplies: Array<() => void> = [];
  const owners = new Map();
  const resync = vi.fn();
  const streams: Array<{ read: ReturnType<typeof vi.fn>; event: (event: unknown) => void; finish: () => void }> = [];
  const primaryHooks: any[] = [];
  const context: any = {
    Map, Set, Promise, setTimeout, clearTimeout,
    _taskSurfaceAbortRefreshOwners: owners,
    _forgottenTaskSurfaceObservers: new WeakSet(),
    _convChatCtrls: new Map(), _groupObserverReservations: new Map(), _groupObserverCtrls: new Map(),
    AbortController, TextDecoder,
    _startRuntimeActorRecovery: vi.fn(),
    isConvPending: () => false, isGroupConversationBusy: () => false,
    _conversationHistoryLoad: null, _lastGroupWorkEventAt: new Map(),
    _isConversationDisplayVisible: () => true, _syncTaskBoardForRuntimeState: vi.fn(),
    _createStreamingAssistantMessage: () => null, startPolling: vi.fn(),
    _finishStreamingMsg: vi.fn(),
    createChatController: vi.fn((config: any) => {
      primaryHooks.push(config.hooks);
      return { abort: vi.fn(), send: vi.fn() };
    }),
    pendingConvs: new Map(), currentCid: '',
    window: {
      TaskBoard: { resync },
      ConversationInfo: { refreshFiles: vi.fn() },
      CliAsyncInput: { setActiveTurns: vi.fn(), forget: vi.fn() },
    },
    _groupPlaceholders: new Map(), _recipientByCid: {},
    _saveRecipientMap: vi.fn(), setGroupConversationBusy: vi.fn(),
    _stopRuntimeActorRecovery: vi.fn(), _stopGroupEventObserver: vi.fn(),
    _restoreSentComposerSnapshot: vi.fn(), _updateConvSidebarBadge: vi.fn(),
    _updateConvSendUI: vi.fn(), stopPolling: vi.fn(),
    document: { getElementById: () => null },
    uiConfirm: vi.fn(async () => true), uiAlert: vi.fn(async () => {}),
    t: (key: string) => key, _projectIdForConversation: () => 'project-owner',
    _removeConversationFromSidebar: vi.fn(), _logConversationManageResult: vi.fn(),
    _convLog: { warn: vi.fn() }, setView: vi.fn(),
    deletionSucceeds: true,
  };
  for (const key of [
    '_autoRecipientByCid', '_serverFloorByCid', '_serverFloorRevisionByCid',
    '_pendingFloorResetByCid', '_latestInFlight', '_latestActiveTurns',
    '_liveDisplayWatermarks', '_conversationInfoFileRefreshTimers',
    '_quotesByCid', '_groupMembersCache', '_settledConvTurns',
    '_chatAttachmentRevisions', 'pollMsgCounts',
  ]) context[key] = new Map();
  context._offViewLiveDisplayDirty = new Set();
  context._failedConvs = new Set();
  context.apiFetch = vi.fn((url: string, options: { signal?: AbortSignal } = {}) => {
    if (url.endsWith('/events/stream')) {
      // Real response/reader protocol: even after AbortSignal changes, an
      // already queued IPC read can resolve later. The test owns that boundary.
      let resolveRead: ((reply: { done: boolean; value?: Uint8Array }) => void) | undefined;
      const read = vi.fn(() => new Promise(resolve => { resolveRead = resolve; }));
      streams.push({
        read,
        event: event => {
          if (!resolveRead) throw new Error('observer has not started reading');
          const resolve = resolveRead;
          resolveRead = undefined;
          resolve({ done: false, value: new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`) });
        },
        finish: () => {
          if (!resolveRead) throw new Error('observer has no pending read');
          const resolve = resolveRead;
          resolveRead = undefined;
          resolve({ done: true });
        },
      });
      return Promise.resolve({ ok: true, body: { getReader: () => ({ read }) } });
    }
    if (url.endsWith('/abort')) return new Promise(resolve => {
      abortReplies.push(() => resolve({ ok: true }));
    });
    return Promise.resolve({
      ok: context.deletionSucceeds,
      status: context.deletionSucceeds ? 200 : 500,
      json: async () => ({ ok: context.deletionSucceeds }),
    });
  });
  vm.createContext(context);
  vm.runInContext([
    extractFunction('_forgetConversationRuntime'),
    extractFunction('_beginTaskSurfaceAbortRefresh'),
    extractFunction('_refreshTaskSurfacesAfterAbort'),
    extractFunction('_forgetCidRecipient'),
    extractFunction('_settleConversationPlaceholdersOnAbort'),
    extractFunction('_taskBoardEventBypassesViewGuard'),
    conversationSource.slice(conversationSource.indexOf('function _handleGroupBusEvent('), conversationSource.indexOf('\nfunction ', conversationSource.indexOf('function _handleGroupBusEvent(') + 1)),
    extractFunction('_handleStreamEvent'),
    extractFunction('_makeConvChatController'),
    extractFunction('_observerShouldDeferCleanup'),
    extractFunction('_isPrimaryOwnedLiveEvent'),
    extractFunction('_nowForStreamYield'),
    extractFunction('_makeStreamPaintYield'),
    extractFunction('_observeConversationRunFromPlanAction'),
    extractFunction('abortConvStream'),
    'async ' + extractFunction('_deleteConversationWithConfirm'),
  ].join('\n'), context);
  context._forgetConvLocal = vi.fn((cid: string) => context._forgetCidRecipient(cid));
  return { context, owners, resync, abortReplies, streams, primaryHooks };
}

describe('abort task-surface refresh lifetime', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('refreshes an incoming bus abort without a local Stop and stops it after confirmed forget', async () => {
    const { context, owners, resync } = loadAbortTaskSurfaceLifecycle();
    const cid = 'project-task';
    context.currentCid = cid;
    context._convChatCtrls.set(cid, context._makeConvChatController(cid));
    context._handleStreamEvent(cid, null, { type: 'event', event: { stream: 'group', data: { type: 'aborted' } } });
    expect(resync).toHaveBeenCalledExactlyOnceWith(cid);
    context._forgetCidRecipient(cid);
    await vi.advanceTimersByTimeAsync(5000);
    context._handleStreamEvent(cid, null, { type: 'event', event: { stream: 'group', data: { type: 'aborted' } } });
    expect(resync).toHaveBeenCalledTimes(1);
    expect(owners.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('restores a live run while an activated old observer and primary onDone unwind', async () => {
    const { context, streams, primaryHooks } = loadAbortTaskSurfaceLifecycle();
    const cid = 'project-task';
    context.currentCid = cid;
    const oldDone = vi.fn();
    const oldPrimary = context._makeConvChatController(cid, { onDone: oldDone });
    context._convChatCtrls.set(cid, oldPrimary);
    // Drive the actual primary factory hook. It creates pending state and
    // attaches the actual paired observer, just as a started send does.
    primaryHooks[0].onAssistantStart(null, cid);
    await vi.advanceTimersByTimeAsync(0);
    const oldObserver = context._groupObserverReservations.get(cid);
    expect(context.pendingConvs.get(cid).controller).toBe(oldPrimary);
    expect(context.setGroupConversationBusy).toHaveBeenCalledWith(cid, true);
    expect(streams[0].read).toHaveBeenCalledTimes(1);
    // At least one valid event traverses the real decoder and observer loop.
    // A paired process event stays owned by its primary and is not duplicated.
    const ownsLiveEvent = vi.spyOn(context, '_isPrimaryOwnedLiveEvent');
    streams[0].event({ type: 'process', actor_id: 'commander', event: { type: 'text_delta', text: 'working' } });
    await vi.advanceTimersByTimeAsync(0);
    expect(ownsLiveEvent).toHaveBeenCalledWith(expect.objectContaining({ type: 'process' }));
    expect(streams[0].read).toHaveBeenCalledTimes(2);
    const other = { abort: vi.fn() };
    context._convChatCtrls.set('other-task', other);
    context._forgetCidRecipient(cid);
    expect(oldPrimary.abort).toHaveBeenCalledTimes(1);
    expect(context._convChatCtrls.has(cid)).toBe(false);
    expect(context._groupObserverReservations.has(cid)).toBe(false);
    expect(context._groupObserverCtrls.has(cid)).toBe(false);
    const restoredPrimary = context._makeConvChatController(cid);
    context._convChatCtrls.set(cid, restoredPrimary);
    primaryHooks[1].onAssistantStart(null, cid);
    await vi.advanceTimersByTimeAsync(0);
    const restoredObserver = context._groupObserverReservations.get(cid);
    expect(restoredPrimary).not.toBe(oldPrimary);
    expect(restoredObserver).toBeTruthy();
    expect(restoredObserver).not.toBe(oldObserver);
    expect(streams[1].read).toHaveBeenCalledTimes(1);
    const refreshFiles = context.window.ConversationInfo.refreshFiles;
    refreshFiles.mockClear();
    // The old stream finally is deliberately released only AFTER the restored
    // primary and shared subscription exist. No obsolete file/history lookup
    // or settlement may run against that restored conversation.
    streams[0].finish();
    await vi.advanceTimersByTimeAsync(0);
    primaryHooks[0].onDone(null, cid, { aborted: true });
    expect(oldDone).toHaveBeenCalledExactlyOnceWith({ aborted: true });
    expect(refreshFiles).not.toHaveBeenCalled();
    expect(context._convChatCtrls.get(cid)).toBe(restoredPrimary);
    expect(context.pendingConvs.get(cid).controller).toBe(restoredPrimary);
    expect(context._groupObserverReservations.get(cid)).toBe(restoredObserver);
    expect(context._finishStreamingMsg).not.toHaveBeenCalled();
    expect(other.abort).not.toHaveBeenCalled();
    expect(context._convChatCtrls.get('other-task')).toBe(other);
    expect(context._convLog.warn).not.toHaveBeenCalled();
    context._forgetCidRecipient(cid);
    streams[1].finish();
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('keeps immediate and settled refreshes for a project conversation outside the sidebar cache', async () => {
    const { context, resync, owners, abortReplies } = loadAbortTaskSurfaceLifecycle();
    context.abortConvStream('project-task', { userInitiated: true });
    expect(resync).toHaveBeenCalledExactlyOnceWith('project-task');
    abortReplies[0]();
    await vi.advanceTimersByTimeAsync(0);
    expect(resync).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1499);
    expect(resync).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(resync).toHaveBeenCalledTimes(3);
    expect(owners.size).toBe(0);
    expect(context._restoreSentComposerSnapshot).toHaveBeenCalledExactlyOnceWith('project-task');
  });

  it('preserves failed-delete recovery and cancels delayed work only after successful retry', async () => {
    const { context, owners, resync, abortReplies } = loadAbortTaskSurfaceLifecycle();
    context.deletionSucceeds = false;
    expect(await context._deleteConversationWithConfirm('project-task')).toBe(false);
    expect(context._forgetConvLocal).not.toHaveBeenCalled();
    expect(context.uiAlert).toHaveBeenCalled();
    abortReplies[0]();
    await vi.advanceTimersByTimeAsync(1500);
    expect(resync).toHaveBeenLastCalledWith('project-task');
    expect(resync).toHaveBeenCalledTimes(3);
    context.deletionSucceeds = true;
    expect(await context._deleteConversationWithConfirm('project-task')).toBe(true);
    expect(context._forgetConvLocal).toHaveBeenCalledExactlyOnceWith('project-task');
    const afterDelete = resync.mock.calls.length;
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(5000);
    abortReplies[1]();
    await vi.advanceTimersByTimeAsync(5000);
    expect(resync).toHaveBeenCalledTimes(afterDelete);
    expect(vi.getTimerCount()).toBe(0);
    expect(owners.size).toBe(0);
  });

  it('keeps other conversations alive and rejects a late old abort after the same cid is restored', async () => {
    const { context, owners, resync, abortReplies } = loadAbortTaskSurfaceLifecycle();
    context.abortConvStream('project-task');
    context.abortConvStream('other-task');
    context._forgetCidRecipient('project-task');
    context.abortConvStream('project-task');
    const restoredOwner = owners.get('project-task');
    const beforeOldReply = resync.mock.calls.length;
    abortReplies[0]();
    await vi.advanceTimersByTimeAsync(0);
    expect(resync).toHaveBeenCalledTimes(beforeOldReply);
    expect(owners.get('project-task')).toBe(restoredOwner);
    abortReplies[1]();
    abortReplies[2]();
    await vi.advanceTimersByTimeAsync(1500);
    expect(resync.mock.calls.filter(([cid]) => cid === 'other-task')).toHaveLength(3);
    expect(resync.mock.calls.filter(([cid]) => cid === 'project-task')).toHaveLength(4);
    expect(owners.size).toBe(0);
  });
});
