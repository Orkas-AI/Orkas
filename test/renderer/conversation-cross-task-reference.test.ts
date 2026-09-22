import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vm from 'node:vm';

const conversationSource = fs.readFileSync(
  path.join(__dirname, '../../src/renderer/modules/conversation.js'),
  'utf8',
);
const draftSource = fs.readFileSync(
  path.join(__dirname, '../../src/renderer/modules/queue-draft.js'),
  'utf8',
);
const styleSource = fs.readFileSync(path.join(__dirname, '../../src/renderer/style.css'), 'utf8');
const projectDetailSource = fs.readFileSync(
  path.join(__dirname, '../../src/renderer/modules/project-detail.js'),
  'utf8',
);
const indexSource = fs.readFileSync(path.join(__dirname, '../../src/renderer/index.html'), 'utf8');

describe('conversation cross-task message reference UI', () => {
  it('exposes secondary actions after the quote without an overflow menu', () => {
    expect(conversationSource).toContain('<span class="chat-bubble-direct-actions">${quoteButton}</span>');
    expect(conversationSource).toContain('${secondaryActions}');
    const secondary = conversationSource.slice(
      conversationSource.indexOf('const secondaryActions ='),
      conversationSource.indexOf('actions.innerHTML = `', conversationSource.indexOf('const secondaryActions =')),
    );
    expect(secondary.indexOf('bubble-copy-btn')).toBeLessThan(secondary.indexOf('bubble-select-btn'));
    expect(secondary.indexOf('bubble-select-btn')).toBeLessThan(secondary.indexOf('bubble-archive-btn'));
    for (const retiredClass of ['bubble-more-btn', 'chat-bubble-more-menu', 'chat-bubble-menu-item']) {
      expect(conversationSource).not.toContain(retiredClass);
      expect(styleSource).not.toContain(retiredClass);
    }
  });

  it('adds quote plus copy/select overflow actions to persisted user messages', () => {
    expect(conversationSource).toContain("} else if (role === 'user' && opts.messageActions !== 'errors-only') {");
    expect(conversationSource).toContain('_attachBubbleActions(msgDiv, () => (');
    expect(conversationSource).toContain('), { archive: false });');
    expect(conversationSource).not.toContain('bubble-share-btn');
    expect(conversationSource).toContain("msgDiv.dataset.fromActor || (msgDiv.classList.contains('user') ? 'user' : '')");
    expect(conversationSource).toContain("'.bubble-quote-btn, .bubble-select-btn'");
  });

  it('does not expose hosted message-sharing entry points', () => {
    expect(conversationSource).not.toContain('bubble-share-btn');
    expect(conversationSource).not.toContain('data-selection-share');
    expect(conversationSource).not.toContain('openConversationShareDialog');
  });

  it('enters multi-select with the clicked message already selected', () => {
    expect(conversationSource).toContain('selected: new Set([msgId])');
    expect(conversationSource).not.toContain('data-selection-share');
    expect(conversationSource).not.toContain('data-selection-delete');
    expect(conversationSource).toContain('data-selection-reference');
    expect(styleSource).toContain('.chat-message-selection-bar');
    expect(styleSource).toContain('.chat-message.is-message-selected > .chat-bubble');
    expect(conversationSource).toContain("document.querySelectorAll('#chat-history .chat-message[data-msg-id]')");
  });

  it('uses a secondary reference action and exits selection after a successful handoff', () => {
    expect(conversationSource).toContain('class="btn btn-sm" data-selection-reference');
    expect(conversationSource).not.toContain('btn btn-sm btn-primary" data-selection-reference');
    expect(conversationSource).toMatch(/function _transferSelectedReferences[\s\S]*?_exitMessageSelection\(\)/);
    expect(conversationSource).toMatch(/function _stageReferencesForNewTask[\s\S]*?_exitMessageSelection\(\)/);
  });

  it('toggles selection when the message bubble is clicked without hijacking embedded controls', () => {
    expect(conversationSource).toContain("bubble.addEventListener('click', (event) => _messageBubbleSelectionClick(event, msg))");
    expect(conversationSource).toContain("event.target?.closest?.('a, button, input, textarea, select, label, summary, iframe, video, audio, [role=\"button\"], [contenteditable=\"true\"]')");
    expect(conversationSource).toContain('_toggleMessageSelection(msg)');
    expect(styleSource).toContain('.chat-message.is-message-selectable > .chat-bubble');
  });

  it('supports both new and existing destination tasks without auto-sending', () => {
    expect(conversationSource).toContain('data-new-task="1"');
    expect(conversationSource).toContain('data-target-cid=');
    expect(conversationSource).toContain("setView('conversation', targetCid");
    expect(conversationSource).toContain("setView('new-chat')");
    expect(conversationSource).toContain("setView('project', projectId)");
    expect(conversationSource).toContain('_stageReferencesForNewTask(payloads, sourceProjectId)');
    expect(conversationSource).not.toContain('function _createReferenceTargetTask');
    expect(conversationSource).not.toContain('_transferSelectedReferences(targetCid, payloads);\n  sendInCurrentConversation');
  });

  it('inherits project scope for new tasks and shows only the five most recent tasks by default', () => {
    expect(conversationSource).toContain("const sourceProjectId = _projectIdForConversation(currentCid)");
    expect(conversationSource).toContain('return projectId ? `projchat-${projectId}` : DRAFT_CID');
    expect(conversationSource).toContain("const res = await apiFetch('/api/conversations/list')");
    expect(conversationSource).toContain('const [targetConversations] = await Promise.all(loads)');
    expect(conversationSource).toContain('Array.isArray(targetConversations) ? targetConversations : []');
    expect(conversationSource).toContain('const tasks = needle ? matches.slice(0, 80) : matches.slice(0, 5)');
    expect(conversationSource).toContain('_referenceTargetActivity(b).localeCompare(_referenceTargetActivity(a))');
    expect(conversationSource).toContain("String(conv.title || '').toLowerCase().includes(needle)");
    expect(conversationSource).not.toContain('_referenceTargetAreaLabel(conv).toLowerCase().includes(needle)');
  });

  it('keeps search inside the existing-task section and uses compact picker typography', () => {
    const existingStart = conversationSource.indexOf('class="chat-reference-existing"');
    const searchStart = conversationSource.indexOf('class="chat-reference-target-search-wrap"');
    expect(existingStart).toBeGreaterThanOrEqual(0);
    expect(searchStart).toBeGreaterThan(existingStart);
    expect(styleSource).toContain('width: min(468px, calc(100vw - 40px));');
    expect(styleSource).toContain('.chat-reference-target-header h2');
    expect(styleSource).toContain('font-size: 13px;');
    expect(styleSource).toContain('height: 38px;');
    expect(conversationSource).not.toContain('chat-reference-new-task-icon');
    expect(conversationSource).not.toContain('chat-reference-target-item-icon');
    expect(conversationSource).not.toContain('chat-reference-target-chevron');
    expect(conversationSource).toContain('class="chat-reference-leading-plus"');
    expect(conversationSource).toContain('class="chat-reference-row-arrow"');
  });

  it('sends references as structured sidecar data and persists them with drafts', () => {
    expect(conversationSource).toContain('const references = _referenceSnapshotsForQuotes(quotes)');
    expect(conversationSource).toContain('...(references.length ? { references } : {})');
    expect(conversationSource).toMatch(/const titleText = \(typeof transformChatUseTokens === 'function'\)[\s\S]*?transformChatUseTokens\(titleSeed\)/);
    expect(conversationSource).toContain('if (titleText) conv.title = _autoTitle(titleText)');
    expect(projectDetailSource).toContain('const references = (typeof _referenceSnapshotsForQuotes === \'function\')');
    expect(projectDetailSource).toContain('...(references.length ? { references } : {})');
    expect(projectDetailSource).toMatch(/const titleText = \(typeof transformChatUseTokens === 'function'\)[\s\S]*?transformChatUseTokens\(titleSeed\)/);
    expect(projectDetailSource).toContain('if (titleText) {');
    expect(indexSource).toContain('id="new-chat-quote-preview"');
    expect(indexSource).toContain('id="project-chat-quote-preview"');
    expect(draftSource).toContain('function _persistQuoteDraft(cid)');
    expect(draftSource).toContain('{ references: safeReferences }');
    expect(draftSource).toContain('_quotesByCid.set(cid, references)');
  });

  it('flattens nested references and retains attachment locators in the draft bundle', () => {
    expect(conversationSource).toContain('for (const nested of quote.references || []) push(nested)');
    expect(conversationSource).toContain('...(quote.attachments?.length ? { attachments: quote.attachments.slice() } : {})');
    expect(conversationSource).toContain('msgDiv.dataset.references = JSON.stringify(message.references.slice(0, 20))');
    expect(conversationSource).toContain(".chat-reference-file.is-attachment[data-attach-name][data-attach-cid]");
    expect(styleSource).toContain('.chat-reference-file.is-attachment');
  });

  it('renders references as a static quote block and limits source titles to cross-task references', () => {
    expect(conversationSource).toContain('function _renderMessageReferencesHtml(references, targetCid)');
    expect(conversationSource).toContain('_renderMessageReferencesHtml(message.references, messageCid)');
    expect(conversationSource).toContain('_quotePreviewAttribution(ref, targetCid)');
    expect(conversationSource).toContain('class="chat-reference-author"');
    expect(conversationSource).not.toContain('class="chat-reference-title"');
    expect(conversationSource).not.toContain('<details class="chat-reference-bundle"');
    expect(conversationSource).not.toContain('chat.reference_bundle_summary');
    expect(styleSource).toContain('border-left: 3px solid rgba(37, 99, 235, 0.45);');
    expect(styleSource).toContain('background: rgba(37, 99, 235, 0.04);');
    expect(styleSource).toContain('.chat-reference-author { display: block; margin-bottom: 1px; color: #2563eb; font-size: 12px; font-weight: 500; }');
  });
});

// History is paginated: all-select must not silently omit older messages or
// overwrite a new selection after the user cancels a pending load.
function selectionHarness() {
  const messages = [{ dataset: { msgId: 'latest' } }];
  let row: any = { dataset: { cid: 'task', cursor: '20', state: 'idle' } };
  const context: any = {
    currentCid: 'task',
    t: (key: string) => key,
    uiToast: () => {},
    _messageSelectionState: { cid: 'task', selected: new Set(['latest']) },
    document: {
      querySelector: () => row,
      querySelectorAll: () => messages,
    },
    _updateMessageSelectionToolbar: () => {},
    _syncMessageSelectionUi: () => {},
  };
  vm.createContext(context);
  vm.runInContext(conversationSource.slice(
    conversationSource.indexOf('function _historyNextCursor('),
    conversationSource.indexOf('function _setEarlierHistoryLoaderState('),
  ) + conversationSource.slice(
    conversationSource.indexOf('function _allMessagesSelected('),
    conversationSource.indexOf('function _toggleMessageSelection('),
  ), context);
  return { context, messages, getRow: () => row, setRow: (value: any) => { row = value; } };
}

describe('select all across conversation history pages', () => {
  it('includes older pages before completing selection and can deselect the whole conversation', async () => {
    const { context, messages, setRow } = selectionHarness();
    context._loadOlderConversationHistory = async (_cid: string, cursor: number) => {
      messages.unshift({ dataset: { msgId: cursor === 20 ? 'middle' : 'oldest' } });
      setRow(cursor === 20 ? { dataset: { cid: 'task', cursor: '10', state: 'idle' } } : null);
    };
    await context._toggleAllMessageSelection();
    expect(Array.from(context._messageSelectionState.selected)).toEqual(['oldest', 'middle', 'latest']);
    expect(context._messageSelectionState.loadingAll).toBe(false);
    await context._toggleAllMessageSelection();
    expect(context._messageSelectionState.selected.size).toBe(0);
  });

  it('preserves the prior selection on a page failure and allows a complete retry', async () => {
    const { context, messages, getRow, setRow } = selectionHarness();
    context._loadOlderConversationHistory = async () => { getRow().dataset.state = 'error'; };
    await context._toggleAllMessageSelection();
    expect(Array.from(context._messageSelectionState.selected)).toEqual(['latest']);
    expect(context._messageSelectionState.loadingAll).toBe(false);
    expect(context._allMessagesSelected()).toBe(false);
    context._loadOlderConversationHistory = async () => {
      messages.unshift({ dataset: { msgId: 'oldest' } });
      setRow(null);
    };
    await context._toggleAllMessageSelection();
    expect(Array.from(context._messageSelectionState.selected)).toEqual(['oldest', 'latest']);
    expect(context._allMessagesSelected()).toBe(true);
  });

  it('does not select messages in another task when a pending all-select is cancelled', async () => {
    const { context, setRow } = selectionHarness();
    let finish!: () => void;
    context._loadOlderConversationHistory = () => new Promise<void>((resolve) => { finish = resolve; });
    const pending = context._toggleAllMessageSelection();
    expect(context._messageSelectionState.loadingAll).toBe(true);
    context.currentCid = 'other';
    context._messageSelectionState = { cid: 'other', selected: new Set(['chosen']) };
    setRow(null);
    finish();
    await pending;
    expect(Array.from(context._messageSelectionState.selected)).toEqual(['chosen']);
  });
});
