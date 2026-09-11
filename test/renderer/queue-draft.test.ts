import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vm from 'node:vm';

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
  const activeTurnsByCid = new Map<string, any[]>();
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
    t: (key: string, params: any = {}) => (
      key === 'chat.queue_send_now_failed'
        ? `Could not send: ${params.msg || ''}`
        : key
    ),
    _renderOrClaimPersistedUserMessage: vi.fn(),
    _queueSendNowActiveTurns: (cid: string) => activeTurnsByCid.get(cid) || [],
    _quotesByCid: quotesByCid,
    _getQuotes: vi.fn((cid: string) => quotesByCid.get(cid) || []),
    _renderQuotePreview: vi.fn(),
    _forgetCidRecipient: vi.fn(),
    isConvPending: vi.fn(() => false),
    applyRecipientPrefix: (content: string) => content,
    sendInConversation: vi.fn(),
    _trackChatSendResult: vi.fn(),
    autoGrow: vi.fn(),
    setChatUseSelection: vi.fn(),
    syncChatRichComposerFromTextarea: vi.fn(),
    _chatAttachList: (cid: string) => attachmentsByCid.get(cid) || [],
    _chatAttachSet: (cid: string, items: any[]) => {
      attachmentsByCid.set(cid, items);
      if (typeof context._persistQueueComposerEditState === 'function') {
        context._persistQueueComposerEditState(cid);
      }
    },
    _chatAttachExtOf: (name: string) => {
      const dot = name.lastIndexOf('.');
      return dot >= 0 ? name.slice(dot).toLowerCase() : '';
    },
    _chatAttachKindFromExt: (ext: string) => (
      ['.png', '.jpg', '.jpeg'].includes(ext) ? 'image' : 'text'
    ),
    _chatMediaUrl: (cid: string, name: string) => `chat-media://${cid}/${name}`,
    getChatRecipient: vi.fn(() => (
      queueEditRecipientsByCid.get(context.currentCid)
      || recipientsByCid.get(context.currentCid)
      || { kind: 'commander', id: '', name: '', resetFloor: false }
    )),
    _setQueueEditRecipient: vi.fn((cid: string, recipient: any) => {
      queueEditRecipientsByCid.set(cid, recipient || { kind: 'commander', id: '', name: '' });
    }),
    _clearQueueEditRecipient: vi.fn((cid: string) => {
      queueEditRecipientsByCid.delete(cid);
    }),
    getChatUseSelections: vi.fn(() => []),
    _normalizeChatUseSelection: (value: any) => value || null,
    _normalizeChatUseSelections: (value: any) => (
      (Array.isArray(value) ? value : [value]).filter(Boolean)
    ),
    _chatUseSelectionsFromText: vi.fn(() => []),
    _chatUseTokenFor: (selection: any) => `[${selection.kind}:${selection.id}]`,
    _normaliseRecipientSnapshot: (recipient: any) => recipient ? { ...recipient } : null,
    _referenceSnapshotsForQuotes: (references: any[]) => references.map((reference) => ({
      source_cid: reference.sourceCid || reference.source_cid,
      source_title: reference.sourceTitle || reference.source_title || '',
      source_msg_id: reference.msgId || reference.source_msg_id,
      from_actor: reference.fromActor || reference.from_actor || '',
      text: reference.text || '',
    })),
  };
  vm.createContext(context);
  vm.runInContext(source, context, { filename: 'queue-draft.js' });
  return {
    context,
    input,
    stored,
    attachmentsByCid,
    recipientsByCid,
    queueEditRecipientsByCid,
    quotesByCid,
    activeTurnsByCid,
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('conversation draft ownership', () => {
  it('snapshots separate drafts before a fast conversation switch', () => {
    vi.useFakeTimers();
    const { context, input, stored } = loadQueueDraft();
    context._getQuotes = vi.fn((cid: string) => [{ msg_id: `quote-${cid}` }]);

    context.currentCid = 'conversation-a';
    input.value = 'draft for A';
    context._saveDraft('conversation-a');

    context.currentCid = 'conversation-b';
    input.value = 'draft for B';
    context._saveDraft('conversation-b');
    vi.advanceTimersByTime(180);

    expect(JSON.parse(stored.get('draft:conversation-a')!)).toEqual({
      text: 'draft for A',
      references: [{ msg_id: 'quote-conversation-a' }],
    });
    expect(JSON.parse(stored.get('draft:conversation-b')!)).toEqual({
      text: 'draft for B',
      references: [{ msg_id: 'quote-conversation-b' }],
    });
  });

  it('does not let a pending debounce resurrect a deleted conversation draft', () => {
    vi.useFakeTimers();
    const { context, input, stored } = loadQueueDraft();

    input.value = 'delete me';
    context._saveDraft('conversation-a');
    input.value = 'keep me';
    context._saveDraft('conversation-b');
    context._forgetConvLocal('conversation-a');
    vi.advanceTimersByTime(180);

    expect(stored.has('draft:conversation-a')).toBe(false);
    expect(JSON.parse(stored.get('draft:conversation-b')!)).toEqual({
      text: 'keep me',
    });
  });
});

describe('conversation send control styles', () => {
  it('hides the stop icon until the send button enters streaming state', () => {
    const styles = fs.readFileSync(
      path.join(__dirname, '../../src/renderer/style.css'),
      'utf8',
    );

    expect(styles).toMatch(/\.chat-send-btn \.stop-icon\s*\{[^}]*display:\s*none;/s);
    expect(styles).toMatch(/\.chat-send-btn\.streaming \.stop-icon\s*\{\s*display:\s*block;\s*\}/s);
    expect(styles).not.toContain('.chat-send-btn .chat-send-btn .stop-icon');
  });
});
