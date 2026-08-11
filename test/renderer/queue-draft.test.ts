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
    _QUEUE_KEY: (cid: string) => `queue:${cid}`,
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

describe('queued message dispatch ownership', () => {
  it('closes a deleted queued send as cancelled without exposing a conversation id', () => {
    const { context } = loadQueueDraft();
    context.messageQueues.set('conversation-a', [{
      id: 'q-cancel',
      content: 'cancel this queued request',
      extra: { attachments: ['brief.pdf'] },
      model_telemetry: { provider: 'custom', model: 'custom' },
    }]);

    context.removeQueuedMessage('conversation-a', 'q-cancel');

    expect(context._trackChatSendResult).toHaveBeenCalledTimes(1);
    expect(context._trackChatSendResult).toHaveBeenCalledWith('cancelled', expect.objectContaining({
      source_view: 'conversation',
      content_length: 'cancel this queued request'.length,
      attachment_count: 1,
    }));
    expect(context._trackChatSendResult.mock.calls[0][1]).not.toHaveProperty('duration_ms');
    expect(context._trackChatSendResult.mock.calls[0][1]).not.toHaveProperty('conversation_id');
  });

  it('edits in the composer, blocks dispatch, and preserves the queue position', () => {
    vi.useFakeTimers();
    const { context, input, stored } = loadQueueDraft();
    context.currentCid = 'conversation-a';
    input.value = 'separate draft';
    context._saveDraft('conversation-a');
    context.messageQueues.set('conversation-a', [
      { id: 'q1', content: 'first', direct: true },
      { id: 'q2', content: 'second', direct: true },
      { id: 'q3', content: 'third', direct: true },
    ]);

    context._startQueueItemEdit('conversation-a', { dataset: { qid: 'q2' } });

    expect(input.value).toBe('second');
    expect(context._isQueueItemEditing('conversation-a')).toBe(true);
    expect(context.messageQueues.get('conversation-a').map((item: any) => item.id))
      .toEqual(['q1', 'q2', 'q3']);
    expect(JSON.parse(stored.get('queue:conversation-a')!)[1].composer_edit)
      .toBeTruthy();

    context._dispatchNextQueued('conversation-a');
    expect(context.sendInConversation).not.toHaveBeenCalled();

    input.value = 'second, revised';
    context._saveDraft('conversation-a');
    expect(context._commitQueueItemEdit('conversation-a', input.value)).toBe(true);
    vi.advanceTimersByTime(180);

    const queue = context.messageQueues.get('conversation-a');
    expect(queue.map((item: any) => [item.id, item.content])).toEqual([
      ['q1', 'first'],
      ['q2', 'second, revised'],
      ['q3', 'third'],
    ]);
    expect(input.value).toBe('separate draft');
    expect(JSON.parse(stored.get('draft:conversation-a')!)).toEqual({
      text: 'separate draft',
    });
    // Unlocking resumes the parked queue, but the durable head remains until
    // the send controller confirms that it actually started.
    expect(context.sendInConversation).toHaveBeenCalledTimes(1);
    expect(context.sendInConversation.mock.calls[0].slice(0, 2))
      .toEqual(['conversation-a', 'first']);
  });

  it('restores and commits every queued composer sidecar without losing the displaced draft', () => {
    const {
      context,
      input,
      attachmentsByCid,
      recipientsByCid,
      queueEditRecipientsByCid,
      quotesByCid,
    } = loadQueueDraft();
    const draftQuote = {
      sourceCid: 'draft-source',
      msgId: 'draft-msg',
      fromActor: 'user',
      text: 'draft reference',
    };
    const queuedReference = {
      source_cid: 'source-chat',
      source_title: 'Source chat',
      source_msg_id: 'source-msg',
      from_actor: 'research-agent',
      from_name: 'Research Agent',
      source_ts: '2026-07-31T00:00:00.000Z',
      text: 'queued reference',
      attachments: ['reference.pdf'],
      produced: ['/workspace/report.md'],
    };
    const queuedUses = [
      { kind: 'skill', id: 'deep-research', name: 'Deep Research' },
      { kind: 'connector', id: 'notion', name: 'Notion' },
    ];
    const queuedRecipient = {
      kind: 'agent',
      id: 'agent-reviewer',
      name: 'Reviewer',
      resetFloor: false,
    };
    const draftRecipient = {
      kind: 'agent',
      id: 'agent-draft',
      name: 'Draft Agent',
      resetFloor: false,
    };
    context.currentCid = 'conversation-a';
    input.value = 'unrelated composer draft';
    quotesByCid.set('conversation-a', [draftQuote]);
    attachmentsByCid.set('conversation-a', [
      {
        name: 'draft-notes.txt',
        displayName: 'Draft notes.txt',
        kind: 'text',
        bytes: 12,
        status: 'ready',
      },
    ]);
    recipientsByCid.set('conversation-a', draftRecipient);
    context.messageQueues.set('conversation-a', [
      { id: 'q1', content: 'first', direct: true },
      {
        id: 'q2',
        content: 'queued body',
        recipient: queuedRecipient,
        extra: {
          attachments: ['brief.pdf', 'chart.png'],
          references: [queuedReference],
          use_selections: queuedUses,
        },
        attachment_items: [
          {
            name: 'brief.pdf',
            displayName: 'Original brief.pdf',
            kind: 'pdf',
            bytes: 2048,
          },
          {
            name: 'chart.png',
            displayName: 'Chart.png',
            kind: 'image',
            bytes: 4096,
          },
        ],
      },
    ]);

    context._startQueueItemEdit('conversation-a', { dataset: { qid: 'q2' } });

    expect(input.value).toContain('[skill:deep-research]');
    expect(input.value).toContain('[connector:notion]');
    expect(input.value).toContain('queued body');
    expect(attachmentsByCid.get('conversation-a')).toEqual([
      expect.objectContaining({
        name: 'brief.pdf',
        displayName: 'Original brief.pdf',
        kind: 'pdf',
        reused: true,
      }),
      expect.objectContaining({
        name: 'chart.png',
        displayName: 'Chart.png',
        kind: 'image',
        dataUrl: 'chat-media://conversation-a/chart.png',
        reused: true,
      }),
    ]);
    expect(quotesByCid.get('conversation-a')).toEqual([
      expect.objectContaining({
        sourceCid: 'source-chat',
        msgId: 'source-msg',
        fromActor: 'research-agent',
        fromName: 'Research Agent',
        text: 'queued reference',
      }),
    ]);
    expect(queueEditRecipientsByCid.get('conversation-a')).toEqual(queuedRecipient);

    const revisedReference = {
      sourceCid: 'revised-source',
      msgId: 'revised-msg',
      fromActor: 'user',
      text: 'revised reference',
    };
    const revisedRecipient = {
      kind: 'agent',
      id: 'agent-final',
      name: 'Final Agent',
      resetFloor: false,
    };
    const revisedUses = [
      { kind: 'connector', id: 'github', name: 'GitHub' },
    ];
    input.value = '[connector:github] revised body';
    quotesByCid.set('conversation-a', [revisedReference]);
    queueEditRecipientsByCid.set('conversation-a', revisedRecipient);
    context.getChatUseSelections = vi.fn(() => revisedUses);
    context._chatAttachSet('conversation-a', [
      {
        name: 'final.docx',
        displayName: 'Final.docx',
        kind: 'docx',
        bytes: 8192,
        status: 'ready',
        reused: true,
      },
    ]);

    expect(context._commitQueueItemEdit('conversation-a', input.value)).toBe(true);

    const edited = context.messageQueues.get('conversation-a')[1];
    expect(edited.content).toBe('[connector:github] revised body');
    expect(edited.recipient).toEqual(revisedRecipient);
    expect(edited.extra).toEqual({
      attachments: ['final.docx'],
      references: [{
        source_cid: 'revised-source',
        source_title: '',
        source_msg_id: 'revised-msg',
        from_actor: 'user',
        text: 'revised reference',
      }],
      use_selections: revisedUses,
    });
    expect(edited.attachment_items).toEqual([
      expect.objectContaining({
        name: 'final.docx',
        displayName: 'Final.docx',
        bytes: 8192,
      }),
    ]);

    expect(input.value).toBe('unrelated composer draft');
    expect(attachmentsByCid.get('conversation-a')).toEqual([
      expect.objectContaining({
        name: 'draft-notes.txt',
        displayName: 'Draft notes.txt',
      }),
    ]);
    expect(quotesByCid.get('conversation-a')).toEqual([draftQuote]);
    expect(queueEditRecipientsByCid.has('conversation-a')).toBe(false);
    expect(recipientsByCid.get('conversation-a')).toEqual(draftRecipient);
    expect(context.sendInConversation).toHaveBeenCalledTimes(1);
    expect(context.sendInConversation.mock.calls[0].slice(0, 2))
      .toEqual(['conversation-a', 'first']);
  });

  it('keeps an empty composer edit locked instead of dropping or sending it', () => {
    const { context, input } = loadQueueDraft();
    context.currentCid = 'conversation-a';
    context.messageQueues.set('conversation-a', [
      { id: 'q1', content: 'keep this', direct: true },
    ]);

    context._startQueueItemEdit('conversation-a', { dataset: { qid: 'q1' } });
    input.value = '   ';

    expect(context._commitQueueItemEdit('conversation-a', input.value)).toBe(false);
    context._dispatchNextQueued('conversation-a');

    expect(context._isQueueItemEditing('conversation-a')).toBe(true);
    expect(context.messageQueues.get('conversation-a')[0].content).toBe('keep this');
    expect(context.sendInConversation).not.toHaveBeenCalled();
  });

  it('does not resurrect a legacy Skill sidecar removed from the composer edit', () => {
    const { context, input } = loadQueueDraft();
    context.currentCid = 'conversation-a';
    context._chatUseSelectionsFromText = (text: string) => (
      text.includes('[connector:notion]')
        ? [{ kind: 'connector', id: 'notion', name: 'Notion' }]
        : []
    );
    context.messageQueues.set('conversation-a', [{
      id: 'q1',
      content: '[connector:notion] legacy queued body',
      direct: true,
      use: { kind: 'skill', id: 'legacy-skill', name: 'Legacy Skill' },
      skill: 'Legacy Skill',
    }]);

    context._startQueueItemEdit('conversation-a', { dataset: { qid: 'q1' } });
    expect(input.value).toBe(
      '[skill:legacy-skill] [connector:notion] legacy queued body',
    );

    input.value = 'plain revised body';
    context.getChatUseSelections = vi.fn(() => []);
    expect(context._commitQueueItemEdit('conversation-a', input.value)).toBe(true);

    const edited = context.messageQueues.get('conversation-a')[0];
    expect(edited.content).toBe('plain revised body');
    expect(edited.use).toBeNull();
    expect(edited.skill).toBe('');
    expect(edited.extra).toBeUndefined();
  });

  it('cancels back to the original message and displaced draft before resuming', () => {
    const {
      context,
      input,
      stored,
      attachmentsByCid,
      recipientsByCid,
      queueEditRecipientsByCid,
      quotesByCid,
    } = loadQueueDraft();
    const quote = {
      sourceCid: 'draft-source',
      msgId: 'quote-1',
      fromActor: 'user',
      text: 'preserve this reference',
    };
    const draftRecipient = {
      kind: 'agent',
      id: 'draft-agent',
      name: 'Draft Agent',
      resetFloor: false,
    };
    const queuedRecipient = {
      kind: 'agent',
      id: 'queued-agent',
      name: 'Queued Agent',
      resetFloor: false,
    };
    context.currentCid = 'conversation-a';
    quotesByCid.set('conversation-a', [quote]);
    attachmentsByCid.set('conversation-a', [{
      name: 'draft.txt',
      displayName: 'Draft.txt',
      kind: 'text',
      bytes: 10,
      status: 'ready',
    }]);
    recipientsByCid.set('conversation-a', draftRecipient);
    input.value = 'unrelated composer draft';
    context.messageQueues.set('conversation-a', [
      { id: 'q1', content: 'first', direct: true },
      {
        id: 'q2',
        content: 'keep original second',
        direct: true,
        recipient: queuedRecipient,
        extra: {
          attachments: ['queued.pdf'],
          references: [{
            source_cid: 'queued-source',
            source_msg_id: 'queued-msg',
            from_actor: 'researcher',
            text: 'queued reference',
          }],
          use_selections: [{
            kind: 'skill',
            id: 'queued-skill',
            name: 'Queued Skill',
          }],
        },
        attachment_items: [{
          name: 'queued.pdf',
          displayName: 'Queued.pdf',
          kind: 'pdf',
          bytes: 20,
        }],
      },
    ]);

    context._startQueueItemEdit('conversation-a', { dataset: { qid: 'q2' } });
    input.value = 'discard this edit';
    context._chatAttachSet('conversation-a', []);
    quotesByCid.set('conversation-a', []);
    queueEditRecipientsByCid.set('conversation-a', {
      kind: 'commander',
      id: '',
      name: '',
      resetFloor: true,
    });
    expect(context._cancelQueueItemEdit('conversation-a')).toBe(true);

    expect(context.messageQueues.get('conversation-a').map((item: any) => ({
      id: item.id,
      content: item.content,
      editing: !!item.composer_edit,
    }))).toEqual([
      { id: 'q1', content: 'first', editing: false },
      { id: 'q2', content: 'keep original second', editing: false },
    ]);
    const original = context.messageQueues.get('conversation-a')[1];
    expect(original.recipient).toEqual(queuedRecipient);
    expect(original.extra).toEqual({
      attachments: ['queued.pdf'],
      references: [{
        source_cid: 'queued-source',
        source_msg_id: 'queued-msg',
        from_actor: 'researcher',
        text: 'queued reference',
      }],
      use_selections: [{
        kind: 'skill',
        id: 'queued-skill',
        name: 'Queued Skill',
      }],
    });
    expect(original.attachment_items).toEqual([{
      name: 'queued.pdf',
      displayName: 'Queued.pdf',
      kind: 'pdf',
      bytes: 20,
    }]);
    expect(input.value).toBe('unrelated composer draft');
    expect(JSON.parse(stored.get('draft:conversation-a')!)).toEqual({
      text: 'unrelated composer draft',
      references: [quote],
    });
    expect(attachmentsByCid.get('conversation-a')).toEqual([
      expect.objectContaining({
        name: 'draft.txt',
        displayName: 'Draft.txt',
      }),
    ]);
    expect(quotesByCid.get('conversation-a')).toEqual([quote]);
    expect(queueEditRecipientsByCid.has('conversation-a')).toBe(false);
    expect(recipientsByCid.get('conversation-a')).toEqual(draftRecipient);
    expect(context.sendInConversation).toHaveBeenCalledTimes(1);
    expect(context.sendInConversation.mock.calls[0].slice(0, 2))
      .toEqual(['conversation-a', 'first']);
  });

  it('deletes the composer-owned queued message without sending and restores every displaced sidecar', () => {
    const {
      context,
      input,
      stored,
      attachmentsByCid,
      recipientsByCid,
      queueEditRecipientsByCid,
      quotesByCid,
    } = loadQueueDraft();
    const draftQuote = {
      sourceCid: 'draft-source',
      msgId: 'draft-msg',
      fromActor: 'user',
      text: 'draft reference',
    };
    const draftRecipient = {
      kind: 'agent',
      id: 'draft-agent',
      name: 'Draft Agent',
      resetFloor: false,
    };
    context.currentCid = 'conversation-a';
    input.value = '[skill:draft-skill] displaced draft';
    quotesByCid.set('conversation-a', [draftQuote]);
    attachmentsByCid.set('conversation-a', [{
      name: 'draft.png',
      displayName: 'Draft.png',
      kind: 'image',
      bytes: 128,
      dataUrl: 'blob:stale-preview',
      status: 'ready',
    }]);
    recipientsByCid.set('conversation-a', draftRecipient);
    context.messageQueues.set('conversation-a', [{
      id: 'q1',
      content: '[connector:notion] never send this',
      direct: true,
      recipient: {
        kind: 'agent',
        id: 'queued-agent',
        name: 'Queued Agent',
        resetFloor: false,
      },
      extra: {
        attachments: ['queued.pdf'],
        references: [{
          source_cid: 'queued-source',
          source_msg_id: 'queued-msg',
          from_actor: 'reviewer',
          text: 'queued reference',
        }],
        use_selections: [{ kind: 'connector', id: 'notion', name: 'Notion' }],
      },
      attachment_items: [{
        name: 'queued.pdf',
        displayName: 'Queued.pdf',
        kind: 'pdf',
        bytes: 512,
      }],
    }]);

    context._startQueueItemEdit('conversation-a', { dataset: { qid: 'q1' } });
    input.value = 'edited content that must also be discarded';
    context._chatAttachSet('conversation-a', []);
    quotesByCid.set('conversation-a', []);
    queueEditRecipientsByCid.set('conversation-a', {
      kind: 'commander', id: '', name: '', resetFloor: true,
    });

    expect(context._deleteQueueItemEdit('conversation-a')).toBe(true);

    expect(context.messageQueues.get('conversation-a')).toEqual([]);
    expect(stored.has('queue:conversation-a')).toBe(false);
    expect(input.value).toBe('[skill:draft-skill] displaced draft');
    expect(JSON.parse(stored.get('draft:conversation-a')!)).toEqual({
      text: '[skill:draft-skill] displaced draft',
      references: [draftQuote],
    });
    expect(attachmentsByCid.get('conversation-a')).toEqual([
      expect.objectContaining({
        name: 'draft.png',
        displayName: 'Draft.png',
        dataUrl: 'chat-media://conversation-a/draft.png',
      }),
    ]);
    expect(quotesByCid.get('conversation-a')).toEqual([draftQuote]);
    expect(queueEditRecipientsByCid.has('conversation-a')).toBe(false);
    expect(recipientsByCid.get('conversation-a')).toEqual(draftRecipient);
    expect(context.sendInConversation).not.toHaveBeenCalled();

    // Negative boundary: without an active queue edit, delete is a no-op and
    // cannot accidentally submit or clear the restored composer.
    expect(context._deleteQueueItemEdit('conversation-a')).toBe(false);
    expect(input.value).toBe('[skill:draft-skill] displaced draft');
    expect(context.sendInConversation).not.toHaveBeenCalled();
  });

  it('recovers a durable composer edit after reload without draining it', () => {
    vi.useFakeTimers();
    const stored = new Map<string, string>();
    const first = loadQueueDraft(stored);
    first.context.currentCid = 'conversation-a';
    first.input.value = 'draft displaced before reload';
    first.attachmentsByCid.set('conversation-a', [{
      name: 'draft-image.png',
      displayName: 'Draft image.png',
      kind: 'image',
      bytes: 256,
      dataUrl: 'blob:preview-that-cannot-survive-reload',
      status: 'ready',
    }]);
    first.context.messageQueues.set('conversation-a', [
      { id: 'q1', content: 'first', direct: true },
      {
        id: 'q2',
        content: 'second',
        direct: true,
        recipient: {
          kind: 'agent',
          id: 'agent-after-reload',
          name: 'Reload Agent',
          resetFloor: false,
        },
        extra: {
          attachments: ['reload.png'],
          references: [{
            source_cid: 'reload-source',
            source_msg_id: 'reload-msg',
            from_actor: 'user',
            text: 'reference after reload',
          }],
        },
        attachment_items: [{
          name: 'reload.png',
          displayName: 'Reload.png',
          kind: 'image',
          bytes: 512,
        }],
      },
      { id: 'q3', content: 'third', direct: true },
    ]);
    first.context._startQueueItemEdit('conversation-a', { dataset: { qid: 'q2' } });
    first.input.value = 'second, edited before reload';
    first.context._saveDraft('conversation-a');
    vi.advanceTimersByTime(180);

    const reloaded = loadQueueDraft(stored);
    reloaded.context.currentCid = 'conversation-a';
    reloaded.context._restoreDraft('conversation-a');

    expect(reloaded.input.value).toBe('second, edited before reload');
    expect(reloaded.context._isQueueItemEditing('conversation-a')).toBe(true);
    expect(reloaded.attachmentsByCid.get('conversation-a')).toEqual([
      expect.objectContaining({
        name: 'reload.png',
        displayName: 'Reload.png',
        dataUrl: 'chat-media://conversation-a/reload.png',
        reused: true,
      }),
    ]);
    expect(reloaded.quotesByCid.get('conversation-a')).toEqual([
      expect.objectContaining({
        sourceCid: 'reload-source',
        msgId: 'reload-msg',
        text: 'reference after reload',
      }),
    ]);
    expect(reloaded.queueEditRecipientsByCid.get('conversation-a')).toEqual({
      kind: 'agent',
      id: 'agent-after-reload',
      name: 'Reload Agent',
      resetFloor: false,
    });
    reloaded.context._dispatchNextQueued('conversation-a');
    expect(reloaded.context.sendInConversation).not.toHaveBeenCalled();

    expect(reloaded.context._commitQueueItemEdit(
      'conversation-a',
      reloaded.input.value,
    )).toBe(true);
    expect(reloaded.context.messageQueues.get('conversation-a').map((item: any) => [
      item.id,
      item.content,
    ])).toEqual([
      ['q1', 'first'],
      ['q2', 'second, edited before reload'],
      ['q3', 'third'],
    ]);
    expect(reloaded.input.value).toBe('draft displaced before reload');
    expect(reloaded.attachmentsByCid.get('conversation-a')).toEqual([
      expect.objectContaining({
        name: 'draft-image.png',
        displayName: 'Draft image.png',
        dataUrl: 'chat-media://conversation-a/draft-image.png',
      }),
    ]);
    expect(reloaded.context.sendInConversation).toHaveBeenCalledTimes(1);
    expect(reloaded.context.sendInConversation.mock.calls[0].slice(0, 2))
      .toEqual(['conversation-a', 'first']);
  });

  it('persists attachment references and sends them with the queued message', () => {
    const { context, stored } = loadQueueDraft();
    context.currentCid = 'conversation-a';
    context._chatModelTelemetryContext = () => ({
      provider: 'deepseek',
      model: 'deepseek-v4-pro',
    });

    context.enqueueMessage('conversation-a', 'review these files', null, {
      direct: true,
      extra: { attachments: ['brief.pdf', 'chart.png'] },
    });

    expect(JSON.parse(stored.get('queue:conversation-a')!)[0].extra.attachments)
      .toEqual(['brief.pdf', 'chart.png']);
    expect(JSON.parse(stored.get('queue:conversation-a')!)[0].model_telemetry)
      .toEqual({ provider: 'deepseek', model: 'deepseek-v4-pro' });

    context._dispatchNextQueued('conversation-a');
    expect(context.sendInConversation).toHaveBeenCalledWith(
      'conversation-a',
      'review these files',
      { attachments: ['brief.pdf', 'chart.png'] },
      expect.objectContaining({
        from_queue: true,
        background: false,
        content_length: 'review these files'.length,
        provider: 'deepseek',
        model: 'deepseek-v4-pro',
      }),
    );

    const options = context.sendInConversation.mock.calls[0][3];
    options.onStarted();
    expect(context.messageQueues.get('conversation-a')).toHaveLength(0);
  });

  it('does not expose the active-turn action while idle; normal FIFO drain remains unchanged', () => {
    const { context } = loadQueueDraft();
    context.currentCid = 'conversation-a';
    context.messageQueues.set('conversation-a', [
      {
        id: 'q2',
        content: 'send this later',
        recipient: { kind: 'commander', id: '', name: '' },
      },
    ]);

    expect(context.sendQueuedMessageNow('conversation-a', 'q2')).toBe(false);
    expect(context.sendInConversation).not.toHaveBeenCalled();

    context._dispatchNextQueued('conversation-a');
    expect(context.sendInConversation).toHaveBeenCalledWith(
      'conversation-a',
      'send this later',
      undefined,
      expect.objectContaining({ from_queue: true, background: false }),
    );
  });

  it.each([
    {
      label: 'plain text',
      actor: 'commander',
      item: {
        content: 'plain update',
        recipient: { kind: 'commander', id: '', name: '' },
      },
      expected: { content: 'plain update' },
    },
    {
      label: 'a file-free quoted reference',
      actor: 'commander',
      item: {
        content: 'consider the quote',
        recipient: { kind: 'commander', id: '', name: '' },
        extra: {
          references: [{
            source_cid: 'source-cid',
            source_msg_id: 'source-1',
            text: 'quoted text only',
          }],
        },
      },
      expected: {
        content: 'consider the quote',
        references: [{
          source_cid: 'source-cid',
          source_msg_id: 'source-1',
          text: 'quoted text only',
        }],
      },
    },
    {
      label: 'text addressed to the same active Agent',
      actor: 'reviewer',
      item: {
        content: 'review this now',
        direct: false,
        recipient: { kind: 'agent', id: 'reviewer', name: 'Reviewer' },
      },
      expected: { content: '@reviewer review this now' },
    },
  ])('sends $label into a matching steerable active turn', async ({ actor, item, expected }) => {
    const { context, activeTurnsByCid } = loadQueueDraft();
    context.currentCid = 'conversation-a';
    context.isConvPending = vi.fn(() => true);
    activeTurnsByCid.set('conversation-a', [{ actor, turn_id: 'turn-live', steerable: true }]);
    context.applyRecipientPrefix = vi.fn((content: string, _target: string, options: any) => (
      options?.recipientSnapshot?.kind === 'agent'
        ? `@${options.recipientSnapshot.id} ${content}`
        : content
    ));
    context.apiFetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        ok: true,
        msg: { id: 'user-now', from: 'user', text: expected.content, ts: '2026-08-01T12:00:00.000Z' },
      }),
    }));
    context.messageQueues.set('conversation-a', [{ id: 'q-rich', ...item }]);

    expect(context.sendQueuedMessageNow('conversation-a', 'q-rich')).toBe(true);
    await vi.waitFor(() => expect(context.apiFetch).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(context.messageQueues.get('conversation-a')).toEqual([]));

    expect(JSON.parse(context.apiFetch.mock.calls[0][1].body)).toEqual({
      ...expected,
    });
  });

  it.each([
    {
      label: 'an attachment',
      item: {
        content: 'use this file',
        recipient: { kind: 'commander', id: '', name: '' },
        extra: { attachments: ['brief.pdf'] },
      },
      expected: {
        content: 'use this file',
        attachments: ['brief.pdf'],
      },
    },
    {
      label: 'a referenced attachment',
      item: {
        content: 'use the quoted file',
        recipient: { kind: 'commander', id: '', name: '' },
        extra: { references: [{ source_msg_id: 'source-1', attachments: ['source.pdf'] }] },
      },
      expected: {
        content: 'use the quoted file',
        references: [{ source_msg_id: 'source-1', attachments: ['source.pdf'] }],
      },
    },
    {
      label: 'a referenced produced file',
      item: {
        content: 'use the quoted output',
        recipient: { kind: 'commander', id: '', name: '' },
        extra: { references: [{ source_msg_id: 'source-1', produced: ['/workspace/report.md'] }] },
      },
      expected: {
        content: 'use the quoted output',
        references: [{ source_msg_id: 'source-1', produced: ['/workspace/report.md'] }],
      },
    },
    {
      label: 'a Skill',
      item: {
        content: 'use Review',
        recipient: { kind: 'commander', id: '', name: '' },
        extra: { use_selections: [{ kind: 'skill', id: 'review', name: 'Review' }] },
      },
      expected: {
        content: 'use Review',
        use_selections: [{ kind: 'skill', id: 'review', name: 'Review' }],
      },
    },
    {
      label: 'a Connector',
      item: {
        content: 'use Notion',
        recipient: { kind: 'commander', id: '', name: '' },
        extra: { use_selections: [{ kind: 'connector', id: 'notion', name: 'Notion' }] },
      },
      expected: {
        content: 'use Notion',
        use_selections: [{ kind: 'connector', id: 'notion', name: 'Notion' }],
      },
    },
  ])('sends $label into the matching rich-steer turn', async ({ item, expected }) => {
    const { context, activeTurnsByCid } = loadQueueDraft();
    context.currentCid = 'conversation-a';
    context.isConvPending = vi.fn(() => true);
    activeTurnsByCid.set('conversation-a', [{
      actor: 'commander', turn_id: 'turn-live', steerable: true,
    }]);
    context.apiFetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        ok: true,
        msg: { id: 'user-rich', from: 'user', text: item.content, ts: '2026-08-01T12:00:00.000Z' },
      }),
    }));
    context.messageQueues.set('conversation-a', [{ id: 'q-rich', ...item }]);

    expect(context._canSendQueueItemIntoActiveTurn('conversation-a', context.messageQueues.get('conversation-a')[0]))
      .toBe(true);
    expect(context.sendQueuedMessageNow('conversation-a', 'q-rich')).toBe(true);
    await vi.waitFor(() => expect(context.apiFetch).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(context.messageQueues.get('conversation-a')).toEqual([]));
    expect(JSON.parse(context.apiFetch.mock.calls[0][1].body)).toEqual({
      ...expected,
    });
  });

  it.each([
    {
      label: 'a different active Agent',
      active: { actor: 'writer', turn_id: 'turn-live', steerable: true },
    },
    {
      label: 'a CLI-backed active Agent',
      active: { actor: 'reviewer', turn_id: 'turn-live', steerable: false },
    },
  ])('hides active-turn send for $label', ({ active }) => {
    const { context, activeTurnsByCid } = loadQueueDraft();
    context.currentCid = 'conversation-a';
    context.isConvPending = vi.fn(() => true);
    activeTurnsByCid.set('conversation-a', [active]);
    const item = {
      id: 'q-agent',
      content: 'review this now',
      recipient: { kind: 'agent', id: 'reviewer', name: 'Reviewer' },
    };
    context.messageQueues.set('conversation-a', [item]);

    expect(context._canSendQueueItemIntoActiveTurn('conversation-a', item)).toBe(false);
    expect(context.sendQueuedMessageNow('conversation-a', 'q-agent')).toBe(false);
    expect(context.apiFetch).not.toHaveBeenCalled();
  });

  it('renders Send only on rows that can affect the matching active turn', () => {
    const { context, activeTurnsByCid } = loadQueueDraft();
    const panel: any = { style: {} };
    const count: any = { textContent: '' };
    const list: any = {
      innerHTML: '',
      querySelectorAll: () => [],
    };
    context.document.getElementById = (id: string) => ({
      'chat-input': { value: '', focus: vi.fn(), setSelectionRange: vi.fn() },
      'chat-queue': panel,
      'chat-queue-list': list,
      'chat-queue-count': count,
    } as Record<string, any>)[id] || null;
    context.currentCid = 'conversation-a';
    context.isConvPending = vi.fn(() => true);
    activeTurnsByCid.set('conversation-a', [{
      actor: 'reviewer', turn_id: 'turn-live', steerable: true,
    }]);
    context.messageQueues.set('conversation-a', [
      {
        id: 'q-text-same-agent',
        content: 'can steer',
        recipient: { kind: 'agent', id: 'reviewer', name: 'Reviewer' },
      },
      {
        id: 'q-text-other-agent',
        content: 'cannot steer this turn',
        recipient: { kind: 'agent', id: 'writer', name: 'Writer' },
      },
      {
        id: 'q-attachment-same-agent',
        content: 'can steer with rich context',
        recipient: { kind: 'agent', id: 'reviewer', name: 'Reviewer' },
        extra: { attachments: ['brief.pdf'] },
      },
    ]);

    context.renderMessageQueue('conversation-a');

    expect((list.innerHTML.match(/data-act="send"/g) || [])).toHaveLength(2);
    expect(list.innerHTML).toContain('data-qid="q-text-same-agent"');
    expect(list.innerHTML).toContain('data-qid="q-attachment-same-agent"');
    expect(count.textContent).toBe('3');
  });

  it('persists a text row into the matching active Agent and renders the authoritative message', async () => {
    const { context, stored, activeTurnsByCid } = loadQueueDraft();
    context.currentCid = 'conversation-a';
    context.isConvPending = vi.fn(() => true);
    activeTurnsByCid.set('conversation-a', [{
      actor: 'reviewer', turn_id: 'turn-live', steerable: true,
    }]);
    context.applyRecipientPrefix = vi.fn((content: string, _target: string, options: any) => (
      options?.recipientSnapshot?.kind === 'agent'
        ? `@${options.recipientSnapshot.id} ${content}`
        : content
    ));
    const persisted = {
      id: 'user-now',
      from: 'user',
      text: '@reviewer add this constraint',
      ts: '2026-08-01T12:00:00.000Z',
    };
    context.apiFetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ ok: true, msg: persisted }),
    }));
    context.messageQueues.set('conversation-a', [
      { id: 'q1', content: 'leave first queued', direct: true },
      {
        id: 'q2',
        content: 'add this constraint',
        recipient: { kind: 'agent', id: 'reviewer', name: 'Reviewer' },
      },
    ]);

    expect(context.sendQueuedMessageNow('conversation-a', 'q2')).toBe(true);
    await vi.waitFor(() => expect(context.apiFetch).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(context.messageQueues.get('conversation-a').map((item: any) => item.id))
      .toEqual(['q1']));

    expect(context.apiFetch).toHaveBeenCalledWith(
      '/api/conversations/conversation-a/send',
      expect.objectContaining({ method: 'POST' }),
    );
    const body = JSON.parse(context.apiFetch.mock.calls[0][1].body);
    expect(body).toEqual({
      content: '@reviewer add this constraint',
    });
    expect(context._renderOrClaimPersistedUserMessage)
      .toHaveBeenCalledWith('conversation-a', persisted);
    expect(context.sendInConversation).not.toHaveBeenCalled();
    expect(context._trackChatSendResult).toHaveBeenCalledTimes(1);
    expect(context._trackChatSendResult).toHaveBeenCalledWith('success', expect.objectContaining({
      source_view: 'conversation',
      content_length: 'add this constraint'.length,
      attachment_count: 0,
    }));
    expect(JSON.parse(stored.get('queue:conversation-a')!)).toEqual([
      { id: 'q1', content: 'leave first queued', direct: true },
    ]);
  });

  it('keeps an active-run send-now row durable when persistence fails', async () => {
    const { context, activeTurnsByCid } = loadQueueDraft();
    context.currentCid = 'conversation-a';
    context.isConvPending = vi.fn(() => true);
    activeTurnsByCid.set('conversation-a', [{
      actor: 'commander', turn_id: 'turn-live', steerable: true,
    }]);
    context.apiFetch = vi.fn(async () => ({
      ok: false,
      status: 503,
      json: async () => ({ ok: false, error: 'temporarily unavailable' }),
    }));
    context.messageQueues.set('conversation-a', [
      {
        id: 'q1',
        content: 'do not lose me',
        recipient: { kind: 'commander', id: '', name: '' },
      },
    ]);

    expect(context.sendQueuedMessageNow('conversation-a', 'q1')).toBe(true);
    await vi.waitFor(() => expect(context.uiAlert).toHaveBeenCalledTimes(1));

    expect(context.messageQueues.get('conversation-a')).toEqual([
      {
        id: 'q1',
        content: 'do not lose me',
        recipient: { kind: 'commander', id: '', name: '' },
      },
    ]);
    expect(context._renderOrClaimPersistedUserMessage).not.toHaveBeenCalled();
    expect(context._trackChatSendResult).not.toHaveBeenCalled();
  });

  it('renders the eligible send action before edit and enforces eligibility again on click', () => {
    const source = fs.readFileSync(
      path.join(__dirname, '../../src/renderer/modules/queue-draft.js'),
      'utf8',
    );
    const sendAt = source.indexOf('data-act="send"');
    const editAt = source.indexOf('data-act="edit"', sendAt);

    expect(sendAt).toBeGreaterThan(-1);
    expect(editAt).toBeGreaterThan(sendAt);
    expect(source).toContain("if (!cid || !qid || _isQueueItemEditing(cid) || _queueDispatching.has(cid)) return false;");
    expect(source).toContain("if (!next || !_canSendQueueItemIntoActiveTurn(cid, next)) return false;");
  });

  it('dispatches an idle background queue to its owning conversation', () => {
    const { context } = loadQueueDraft();
    context.currentCid = 'conversation-b';
    context.messageQueues.set('conversation-a', [
      {
        id: 'q1',
        content: 'continue in the background',
        direct: true,
        extra: { attachments: ['background.pdf'] },
      },
    ]);

    context._dispatchNextQueued('conversation-a');

    expect(context.sendInConversation).toHaveBeenCalledWith(
      'conversation-a',
      'continue in the background',
      { attachments: ['background.pdf'] },
      expect.objectContaining({
        from_queue: true,
        background: true,
      }),
    );
    expect(context.currentCid).toBe('conversation-b');
    expect(context.messageQueues.get('conversation-a')).toHaveLength(1);

    const options = context.sendInConversation.mock.calls[0][3];
    options.onStarted();
    expect(context.messageQueues.get('conversation-a')).toHaveLength(0);
  });

  it('coalesces repeated drains while the queue head is still in preflight', async () => {
    const { context } = loadQueueDraft();
    context.currentCid = 'conversation-a';
    context.messageQueues.set('conversation-a', [
      { id: 'q1', content: 'send exactly once', direct: true },
    ]);
    let release!: () => void;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    context.sendInConversation = vi.fn(() => pending);

    context._dispatchNextQueued('conversation-a');
    context._dispatchNextQueued('conversation-a');

    expect(context.sendInConversation).toHaveBeenCalledTimes(1);
    expect(context.messageQueues.get('conversation-a')).toHaveLength(1);

    const options = context.sendInConversation.mock.calls[0][3];
    options.onStarted();
    expect(context.messageQueues.get('conversation-a')).toHaveLength(0);
    release();
    await pending;
  });

  it('keeps a preflight-rejected item retryable without duplicating it', async () => {
    const { context } = loadQueueDraft();
    context.currentCid = 'conversation-a';
    context.messageQueues.set('conversation-a', [
      {
        id: 'q1',
        content: 'retry after setup',
        direct: true,
        extra: { attachments: ['brief.pdf'] },
      },
    ]);
    context.sendInConversation = vi.fn(async () => ({ started: false }));

    context._dispatchNextQueued('conversation-a');
    await vi.waitFor(() => expect(context.sendInConversation).toHaveBeenCalledTimes(1));
    expect(context.messageQueues.get('conversation-a')).toHaveLength(1);

    context._dispatchNextQueued('conversation-a');
    await vi.waitFor(() => expect(context.sendInConversation).toHaveBeenCalledTimes(2));
    expect(context.messageQueues.get('conversation-a')).toHaveLength(1);
    expect(context.sendInConversation.mock.calls[1][2])
      .toEqual({ attachments: ['brief.pdf'] });
  });
});
