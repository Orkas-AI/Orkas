import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

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
  it('keeps quote visible while moving secondary actions into the overflow menu', () => {
    expect(conversationSource).toContain('<span class="chat-bubble-direct-actions">${quoteButton}</span>');
    expect(conversationSource).toContain('class="chat-bubble-more-menu" role="menu" hidden');
    expect(conversationSource).toContain('chat-bubble-menu-item bubble-copy-btn');
    expect(conversationSource).toContain('chat-bubble-menu-item bubble-select-btn');
    expect(conversationSource).toContain('chat-bubble-menu-item bubble-archive-btn');
    expect(styleSource).toContain('.chat-bubble-more-menu');
    expect(styleSource).toContain('.chat-bubble-menu-item');
    expect(conversationSource).not.toContain("'bubble-action-icon'");
    expect(styleSource).toContain('border: 1px solid color-mix(in srgb, var(--border) 88%, #94a3b8);');
    expect(styleSource).toContain('height: 24px;');
  });

  it('opens the overflow menu without scanning every message menu', () => {
    expect(conversationSource).toContain('let _openBubbleActionMenu = null;');
    expect(conversationSource).toContain('_openBubbleActionMenu = menu;');
    expect(conversationSource).not.toContain("document.querySelectorAll('.chat-bubble-more-menu:not([hidden])')");
  });

  it('adds quote plus copy/select overflow actions to persisted user messages', () => {
    expect(conversationSource).toContain("} else if (role === 'user') {");
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
    expect(projectDetailSource).toContain('const references = (typeof _referenceSnapshotsForQuotes === \'function\')');
    expect(projectDetailSource).toContain('...(references.length ? { references } : {})');
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

  it('renders references as a static quote block with a source-only title', () => {
    expect(conversationSource).toContain("t('chat.reference_bundle_title', { title: sourceTitle })");
    expect(conversationSource).toContain('class="chat-reference-title"');
    expect(conversationSource).not.toContain('<details class="chat-reference-bundle"');
    expect(conversationSource).not.toContain('chat.reference_bundle_summary');
    expect(styleSource).toContain('border-left: 3px solid rgba(37, 99, 235, 0.45);');
    expect(styleSource).toContain('background: rgba(37, 99, 235, 0.04);');
  });
});
