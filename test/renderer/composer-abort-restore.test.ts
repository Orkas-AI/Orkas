import { describe, expect, it, vi } from 'vitest';
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
    _QUEUE_KEY: (cid: string) => `queue:${cid}`,
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
    syncChatRichComposerFromTextarea: vi.fn(),
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

  it('restores the raw message, not the dispatched payload', () => {
    const { context, input, recipientsByCid } = loadQueueDraft();
    context.currentCid = 'conv-a';
    context.messageQueues.set('conv-a', [{
      id: 'q1',
      content: 'draft the release note',
      use: { kind: 'skill', id: 'writer', name: 'writer' },
      recipient: { kind: 'agent', id: 'agent-writer', name: 'Writer' },
    }]);

    context._dispatchNextQueued('conv-a');

    // What went to the model carries the routing tag and the expanded skill.
    const [, dispatched] = context.sendInConversation.mock.calls[0];
    expect(dispatched).toBe('@Writer use writer skill: draft the release note');

    expect(context._restoreSentComposerSnapshot('conv-a')).toBe(true);
    // What comes back is re-sendable: the recipient lives in the chip and the
    // skill in an inline token, so sending again cannot double-apply either.
    expect(input.value).toBe('[skill:writer] draft the release note');
    expect(input.value).not.toContain('@Writer');
    expect(input.value).not.toContain('use writer skill:');
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

  it('leaves a queued-item edit that owns the composer untouched', () => {
    const { context, input, stored } = loadQueueDraft();
    context.currentCid = 'conv-a';
    context.messageQueues.set('conv-a', [{ id: 'q1', content: 'queued follow-up', direct: true }]);
    context._rememberSentComposerSnapshot('conv-a', AUTHORED);

    context._startQueueItemEdit('conv-a', { dataset: { qid: 'q1' } });
    expect(context._restoreSentComposerSnapshot('conv-a')).toBe(false);

    expect(input.value).toBe('queued follow-up');
    expect(context._isQueueItemEditing('conv-a')).toBe(true);
    expect(JSON.parse(stored.get('queue:conv-a')!)[0].composer_edit).toBeTruthy();
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

  it('drops the snapshot when the dispatch never leaves the renderer', () => {
    const { context } = loadQueueDraft();
    context.currentCid = 'conv-a';
    context.sendInConversation = vi.fn(() => { throw new Error('model not configured'); });
    context.messageQueues.set('conv-a', [{ id: 'q1', content: 'queued item', direct: true }]);

    context._dispatchNextQueued('conv-a');

    // The item is still queued; a later stop belongs to whatever turn is
    // actually running, not to this message.
    expect(context.messageQueues.get('conv-a')).toHaveLength(1);
    expect(context._restoreSentComposerSnapshot('conv-a')).toBe(false);
  });

  it('drops the snapshot when steering the live turn fails', async () => {
    const { context } = loadQueueDraft();
    context.currentCid = 'conv-a';
    // Send-now only exists while a turn is running, so the failure must not
    // fall through into a fresh dispatch.
    context.isConvPending = () => true;
    context.apiFetch = vi.fn(() => Promise.reject(new Error('offline')));
    const item = { id: 'q1', content: 'steer the turn', direct: true };
    context.messageQueues.set('conv-a', [item]);

    await context._sendQueuedMessageIntoActiveRun('conv-a', item);

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
  function runAbort(options: Record<string, unknown>) {
    const restore = vi.fn();
    const context: any = {
      Map,
      Set,
      Promise,
      pendingConvs: new Map([['conv-a', { controller: { abort: vi.fn() }, aborted: false }]]),
      currentCid: 'conv-a',
      _trackTaskStopClick: vi.fn(),
      _restoreSentComposerSnapshot: restore,
      _stopRuntimeActorRecovery: vi.fn(),
      _stopGroupEventObserver: vi.fn(),
      setGroupConversationBusy: vi.fn(),
      apiFetch: vi.fn(() => ({ catch: () => ({ finally: () => {} }) })),
      _refreshTaskSurfacesAfterAbort: vi.fn(),
      _updateConvSidebarBadge: vi.fn(),
      _updateConvSendUI: vi.fn(),
      stopPolling: vi.fn(),
      document: { getElementById: () => null },
    };
    vm.createContext(context);
    vm.runInContext(`${extractFunction('abortConvStream')}`, context, { filename: 'abort.js' });
    context.abortConvStream('conv-a', options);
    return restore;
  }

  it('restores only when the user pressed stop', () => {
    expect(runAbort({ userInitiated: true })).toHaveBeenCalledWith('conv-a');
    // Conversation delete and missing-conversation recovery also abort; neither
    // is an edit intent, so the composer must be left alone.
    expect(runAbort({})).not.toHaveBeenCalled();
  });

  it('drops the snapshot when the turn settles', () => {
    const clear = vi.fn();
    const context: any = {
      Map,
      Set,
      pendingConvs: new Map([['conv-a', { aborted: false }]]),
      currentCid: 'conv-other',
      _clearSentComposerSnapshot: clear,
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
    vm.runInContext(`${extractFunction('_finishStreamingMsg')}`, context, { filename: 'finish.js' });

    context._finishStreamingMsg('conv-a');

    expect(clear).toHaveBeenCalledWith('conv-a');
  });
});
