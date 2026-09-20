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

describe('queued message composer editing', () => {
  it.each(['ready', 'error'])('keeps displaced draft files out of an edit with a %s upload', async (uploadStatus) => {
    const { context, input, attachmentsByCid, stored } = loadQueueDraft();
    // Run the real snapshot producer with the real queued-edit consumer.
    const conversation = fs.readFileSync(path.join(__dirname, '../../src/renderer/modules/conversation.js'), 'utf8');
    vm.runInContext(conversation.slice(conversation.indexOf('function _chatAttachItemsFromServer('),
      conversation.indexOf('function _chatAttachSet(')), context);
    vm.runInContext(conversation.slice(conversation.indexOf('async function _chatAttachRefreshFromServer('),
      conversation.indexOf('function _renderMessageAttachmentsHtml(')), context);
    context.performance = performance;
    context._chatAttachHasPendingWork = () => false;
    context._chatAttachRevision = () => 0;
    context._convLog = { info: vi.fn(), warn: vi.fn() };
    context._chatAttachTryBeginSend = () => () => {};
    context.transformWithChatUse = (text: string) => text;
    context.window = { TaskBoard: { resync: vi.fn() } };
    context.currentCid = 'c1';
    input.value = 'separate draft';
    attachmentsByCid.set('c1', [{ name: 'draft.txt', status: 'ready' }]);
    let sent: any;
    context.apiFetch = vi.fn(async (url: string, options: any) => ({ json: async () => {
      if (url.endsWith('/begin-edit')) return { ok: true, message: { text: 'queued text', attachments: ['queued.txt'] } };
      if (url.endsWith('/attachments')) return { ok: true, items: [
        { name: 'draft.txt', kind: 'text', bytes: 3 },
        { name: 'new.txt', kind: 'text', bytes: 4 },
      ] };
      sent = JSON.parse(options.body);
      return { ok: true };
    } }));
    await context._startQueueItemEdit('c1', 'q1');
    context._chatAttachSet('c1', [...attachmentsByCid.get('c1')!, { name: 'new.txt', status: uploadStatus }]);
    // Navigation restores the edit, then boot requests a pending-file refresh.
    context.currentCid = 'c2'; input.value = 'other conversation';
    context.currentCid = 'c1'; context._restoreDraft('c1');
    await context._chatAttachRefreshFromServer('c1');
    expect(attachmentsByCid.get('c1')?.map((item) => item.name).sort()).toEqual(['new.txt', 'queued.txt']);
    expect(await context._finishQueueItemEdit('c1')).toBe(true);
    expect(sent.resources.attachments.slice().sort()).toEqual(['new.txt', 'queued.txt']);
    expect(input.value).toBe('separate draft');
    expect(attachmentsByCid.get('c1')?.map((item) => item.name)).toEqual(['draft.txt']);
    expect(stored.has('draft:c1:queue-edit')).toBe(false);
  });

  it.each(['edit', 'cancel-edit', 'cancel'])('restores the complete message and displaced draft after %s', async (action) => {
    const { context, input, attachmentsByCid, quotesByCid, stored } = loadQueueDraft();
    context.window = { TaskBoard: { resync: vi.fn() } };
    context.currentCid = 'c1';
    input.value = 'separate draft';
    attachmentsByCid.set('c1', [{ name: 'draft.txt', status: 'ready' }]);
    quotesByCid.set('c1', [{ sourceCid: 'old', msgId: 'old-msg', text: 'draft reference' }]);
    context._chatAttachTryBeginSend = vi.fn(() => () => {});
    context._chatAttachSnapshotForSend = vi.fn(async () => ({ ok: true, names: ['queued.txt'] }));
    context.transformWithChatUse = (text: string) => text;
    context.apiFetch = vi.fn(async () => ({ json: async () => ({ ok: true,
      message: { text: 'queued text', attachments: ['queued.txt'], references: [{ source_cid: 'ref', source_msg_id: 'msg', text: 'queued reference' }] },
      recipient: { kind: 'agent', id: 'a1', name: 'Writer' },
    }) }));
    await context._startQueueItemEdit('c1', 'q1');
    expect(input.value).toBe('queued text');
    expect(attachmentsByCid.get('c1')).toEqual([expect.objectContaining({ name: 'queued.txt', reused: true })]);
    expect(quotesByCid.get('c1')?.[0].text).toBe('queued reference');
    input.value = 'revised\nsecond line';
    await context._finishQueueItemEdit('c1', action);
    expect(input.value).toBe('separate draft');
    expect(attachmentsByCid.get('c1')?.[0].name).toBe('draft.txt');
    expect(quotesByCid.get('c1')?.[0].text).toBe('draft reference');
    expect(stored.has('draft:c1:queue-edit')).toBe(false);
    expect(context.apiFetch.mock.calls[1][0]).toBe(`/api/conversations/c1/tasks/${action}`);
    const body = JSON.parse(context.apiFetch.mock.calls[1][1].body);
    expect(body.task_id).toBe('q1');
    if (action === 'edit') expect(body).toMatchObject({ instruction: 'revised\nsecond line', expected_instruction: 'queued text', resources: { attachments: ['queued.txt'] } });
    else expect(body).not.toHaveProperty('instruction');
  });

  it('keeps failed edits across task switches and reload, and retries only once while a save is pending', async () => {
    const { context, input, stored } = loadQueueDraft();
    context.window = { TaskBoard: { resync: vi.fn() } };
    context.currentCid = 'c1';
    input.value = 'original draft';
    context._chatAttachTryBeginSend = () => () => {};
    context._chatAttachSnapshotForSend = async () => ({ ok: true, names: [] });
    context.transformWithChatUse = (text: string) => text;
    context.apiFetch = vi.fn(async () => ({ json: async () => ({ ok: true, message: { text: 'queued' } }) }));
    await context._startQueueItemEdit('c1', 'q1');
    input.value = 'my changes';
    context._saveDraft('c1');
    context.currentCid = 'c2'; input.value = 'other conversation';
    const reloaded = loadQueueDraft(stored);
    reloaded.context.currentCid = 'c1';
    reloaded.context._restoreDraft('c1');
    expect(reloaded.input.value).toBe('my changes');
    context.currentCid = 'c1'; context._restoreDraft('c1');
    context.apiFetch.mockRejectedValueOnce(new Error('offline'));
    expect(await context._finishQueueItemEdit('c1')).toBe(false);
    expect(input.value).toBe('my changes');
    expect(context.uiAlert).toHaveBeenCalledWith('chat.queue_edit_failed');
    let release: (value: unknown) => void = () => {};
    context.apiFetch.mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }));
    const saving = context._finishQueueItemEdit('c1');
    await new Promise((resolve) => setImmediate(resolve));
    expect(await context._finishQueueItemEdit('c1')).toBe(false);
    expect(await context._cancelQueueItemEdit('c1')).toBe(false);
    release({ json: async () => ({ ok: true }) });
    expect(await saving).toBe(true);
    expect(input.value).toBe('original draft');
    expect(context.apiFetch).toHaveBeenCalledTimes(3);
  });
});
