import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vm from 'node:vm';

function loadQueueDraft() {
  const source = fs.readFileSync(
    path.join(__dirname, '../../src/renderer/modules/queue-draft.js'),
    'utf8',
  );
  const stored = new Map<string, string>();
  const input = {
    value: '',
    setSelectionRange: vi.fn(),
  };
  const context: any = {
    Map,
    Set,
    Date,
    Math,
    JSON,
    Promise,
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
    _getQuotes: vi.fn(() => []),
    _forgetCidRecipient: vi.fn(),
    isConvPending: vi.fn(() => false),
    applyRecipientPrefix: (content: string) => content,
    sendInCurrentConversation: vi.fn(),
    autoGrow: vi.fn(),
    setChatUseSelection: vi.fn(),
  };
  vm.createContext(context);
  vm.runInContext(source, context, { filename: 'queue-draft.js' });
  return { context, input, stored };
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
  it('coalesces repeated drains while the queue head is still in preflight', async () => {
    const { context } = loadQueueDraft();
    context.currentCid = 'conversation-a';
    context.messageQueues.set('conversation-a', [
      { id: 'q1', content: 'send exactly once', direct: true },
    ]);
    let release!: () => void;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    context.sendInCurrentConversation = vi.fn(() => pending);

    context._dispatchNextQueued('conversation-a');
    context._dispatchNextQueued('conversation-a');

    expect(context.sendInCurrentConversation).toHaveBeenCalledTimes(1);
    expect(context.messageQueues.get('conversation-a')).toHaveLength(1);

    const options = context.sendInCurrentConversation.mock.calls[0][2];
    options.onStarted();
    expect(context.messageQueues.get('conversation-a')).toHaveLength(0);
    release();
    await pending;
  });

  it('keeps a preflight-rejected item retryable without duplicating it', async () => {
    const { context } = loadQueueDraft();
    context.currentCid = 'conversation-a';
    context.messageQueues.set('conversation-a', [
      { id: 'q1', content: 'retry after setup', direct: true },
    ]);
    context.sendInCurrentConversation = vi.fn(async () => ({ started: false }));

    context._dispatchNextQueued('conversation-a');
    await vi.waitFor(() => expect(context.sendInCurrentConversation).toHaveBeenCalledTimes(1));
    expect(context.messageQueues.get('conversation-a')).toHaveLength(1);

    context._dispatchNextQueued('conversation-a');
    await vi.waitFor(() => expect(context.sendInCurrentConversation).toHaveBeenCalledTimes(2));
    expect(context.messageQueues.get('conversation-a')).toHaveLength(1);
  });
});
