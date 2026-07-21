// ─── Message queue (per-conversation) ───
//
// While a reply is streaming, additional user messages are queued instead of
// sent immediately. Queue is per-cid, persisted in localStorage so a refresh
// mid-stream doesn't drop pending messages. Drained one-by-one when the
// current reply finishes (or is aborted). Each entry records the raw user
// text and the recipient snapshot visible when the user pressed send. Inline
// skill / connector tokens stay in `content`; legacy rows may still carry
// `use`, which is expanded at dispatch time for compatibility.

function _loadQueueFromStorage(cid) {
  if (!cid) return [];
  try {
    const raw = localStorage.getItem(_QUEUE_KEY(cid));
    const arr = raw ? JSON.parse(raw) : [];
    return Array.isArray(arr) ? arr : [];
  } catch (_) { return []; }
}

function _saveQueueToStorage(cid) {
  if (!cid) return;
  const q = messageQueues.get(cid) || [];
  try {
    if (q.length) localStorage.setItem(_QUEUE_KEY(cid), JSON.stringify(q));
    else localStorage.removeItem(_QUEUE_KEY(cid));
  } catch (_) {}
}

function _getQueue(cid) {
  if (!messageQueues.has(cid)) messageQueues.set(cid, _loadQueueFromStorage(cid));
  return messageQueues.get(cid);
}

// Drop all locally-cached state for a conversation (called on delete).
function _forgetConvLocal(cid) {
  if (!cid) return;
  messageQueues.delete(cid);
  try {
    localStorage.removeItem(_QUEUE_KEY(cid));
    localStorage.removeItem(_DRAFT_KEY(cid));
  } catch (_) {}
  if (typeof _forgetCidRecipient === 'function') _forgetCidRecipient(cid);
}

function _queueItemUseSelection(item) {
  if (!item) return null;
  if (item.use && typeof _normalizeChatUseSelection === 'function') {
    return _normalizeChatUseSelection(item.use);
  }
  if (item.skill && typeof _normalizeChatUseSelection === 'function') {
    return _normalizeChatUseSelection({ kind: 'skill', id: item.skill, name: item.skill });
  }
  return null;
}

function enqueueMessage(cid, content, useSelection, opts = {}) {
  const q = _getQueue(cid);
  const extra = opts && opts.extra && typeof opts.extra === 'object' ? opts.extra : null;
  const recipient = opts && typeof _normaliseRecipientSnapshot === 'function'
    ? _normaliseRecipientSnapshot(opts.recipient)
    : null;
  const use = typeof _normalizeChatUseSelection === 'function'
    ? _normalizeChatUseSelection(useSelection)
    : null;
  q.push({
    id: `q${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
    content,
    use: use || null,
    skill: use && use.kind === 'skill' ? (use.name || use.id || '') : '',
    direct: !!(opts && opts.direct),
    ...(recipient ? { recipient } : {}),
    ...(extra ? { extra } : {}),
  });
  _saveQueueToStorage(cid);
  _updateConvSidebarBadge(cid);
  if (cid === currentCid) {
    renderMessageQueue(cid);
    _updateConvSendUI(cid);
  }
}

function removeQueuedMessage(cid, qid) {
  const q = _getQueue(cid);
  const idx = q.findIndex(m => m.id === qid);
  if (idx < 0) return;
  q.splice(idx, 1);
  _saveQueueToStorage(cid);
  _updateConvSidebarBadge(cid);
  if (cid === currentCid) {
    renderMessageQueue(cid);
    _updateConvSendUI(cid);
  }
}

function updateQueuedMessage(cid, qid, newContent) {
  const q = _getQueue(cid);
  const item = q.find(m => m.id === qid);
  if (!item) return;
  item.content = newContent;
  _saveQueueToStorage(cid);
  if (cid === currentCid) renderMessageQueue(cid);
}

function reorderQueuedMessage(cid, fromIdx, toIdx) {
  const q = _getQueue(cid);
  if (fromIdx < 0 || fromIdx >= q.length) return;
  if (toIdx < 0) toIdx = 0;
  if (toIdx > q.length) toIdx = q.length;
  const [item] = q.splice(fromIdx, 1);
  const insertAt = fromIdx < toIdx ? toIdx - 1 : toIdx;
  q.splice(insertAt, 0, item);
  _saveQueueToStorage(cid);
  if (cid === currentCid) renderMessageQueue(cid);
}

// Called by _finishStreamingMsg when a reply completes/aborts/errors.
function _dispatchNextQueued(cid) {
  const q = _getQueue(cid);
  if (!q.length) return;
  if (isConvPending(cid)) return;
  // Only auto-dispatch for the currently-viewed conversation so the user sees
  // messages go out in order. Queues on other cids stay parked until the user
  // switches back (then on render we'll also kick the next item).
  if (cid !== currentCid) return;
  // Keep the item durable until the chat controller has actually entered its
  // started state. A model-config/preflight rejection must not silently drop
  // the queued user message.
  const next = q[0];
  // Inline skill / connector tokens are expanded at dispatch time. Agent runs
  // are just "run <name>" text — no flag. Legacy queued rows may still carry a
  // separate `use` field; keep honoring it until old localStorage drains.
  // Recipient prefix (`@<agent>`) is applied from the enqueue-time snapshot.
  // Falling back to current chip is only for legacy queue rows persisted before
  // snapshots existed.
  let use = _queueItemUseSelection(next);
  const inlineUseSelections = (typeof _chatUseSelectionsFromText === 'function')
    ? _chatUseSelectionsFromText(next.content || '')
    : [];
  if (use && typeof isChatUseAllowedForTarget === 'function' && !isChatUseAllowedForTarget('conversation', use.kind)) {
    use = null;
  }
  // Drop a connector prefix whose target is no longer live (disconnected /
  // user-disabled / uninstalled between enqueue and drain). Without this,
  // commander gets `use <connector>: …` text whose connector has no matching
  // entry in the `## Connectors` system block, so the LLM either hallucinates
  // a tool call or surfaces an error. Skill / agent prefixes have the same
  // orphan failure class, but the renderer doesn't yet carry their live-state
  // cache — left as separate Pending items.
  if (use && use.kind === 'connector'
      && typeof isConnectorLive === 'function'
      && !isConnectorLive(use.id)) {
    const label = use.name || use.id;
    use = null;
    try { uiAlert(t('connectors.dropped_at_drain', { connector: label })); } catch (_) {}
  }
  const withUse = (typeof transformWithChatUse === 'function')
    ? transformWithChatUse(next.content, use)
    : next.content;
  const content = next.direct
    ? next.content
    : applyRecipientPrefix(withUse, 'conversation', { recipientSnapshot: next.recipient });
  const extra = next.extra && typeof next.extra === 'object' ? { ...next.extra } : {};
  if (!Array.isArray(extra.use_selections) && typeof _normalizeChatUseSelections === 'function') {
    const selections = _normalizeChatUseSelections([
      ...inlineUseSelections,
      ...(use ? [use] : []),
    ]);
    if (selections.length) extra.use_selections = selections;
  }
  const removeStartedItem = () => {
    const liveQueue = _getQueue(cid);
    const idx = liveQueue.findIndex((item) => item && item.id === next.id);
    if (idx < 0) return;
    liveQueue.splice(idx, 1);
    _saveQueueToStorage(cid);
    _updateConvSidebarBadge(cid);
    if (cid === currentCid) renderMessageQueue(cid);
  };
  // Fire-and-forget: the send path owns stream failures and final cleanup.
  // `onStarted` runs synchronously before the request begins, so a second
  // drain cannot overtake this item; if preflight refuses the send, it stays
  // at the head of the persisted queue.
  Promise.resolve(sendInCurrentConversation(
    content,
    Object.keys(extra).length ? extra : undefined,
    { from_queue: true, source_view: 'conversation', onStarted: removeStartedItem },
  )).catch(() => {});
}

function renderMessageQueue(cid) {
  const panel = document.getElementById('chat-queue');
  const list = document.getElementById('chat-queue-list');
  const countEl = document.getElementById('chat-queue-count');
  if (!panel || !list) return;
  const q = cid ? _getQueue(cid) : [];
  if (!q.length) {
    panel.style.display = 'none';
    list.innerHTML = '';
    if (countEl) countEl.textContent = '0';
    return;
  }
  panel.style.display = '';
  if (countEl) countEl.textContent = String(q.length);
  list.innerHTML = q.map(item => {
    const use = _queueItemUseSelection(item);
    const useChip = use
      ? `<span class="chat-queue-skill">${escapeHtml(formatChatUseLabel(use))}</span>` : '';
    const displayContent = (typeof formatChatUseTextForDisplay === 'function')
      ? formatChatUseTextForDisplay(item.content || '')
      : (item.content || '');
    const preview = escapeHtml(displayContent.replace(/\s+/g, ' ')).slice(0, 200);
    return `
      <div class="chat-queue-item" draggable="true" data-qid="${item.id}">
        <div class="chat-queue-drag" title="${escapeHtml(t('chat.queue_drag_title'))}">⋮⋮</div>
        <div class="chat-queue-text">${useChip}${preview}</div>
        <div class="chat-queue-actions">
          <button class="chat-queue-btn" data-act="edit">${escapeHtml(t('chat.queue_edit'))}</button>
          <button class="chat-queue-btn danger" data-act="del">×</button>
        </div>
      </div>
    `;
  }).join('');
  _wireQueueItemEvents(cid);
}

function _wireQueueItemEvents(cid) {
  const list = document.getElementById('chat-queue-list');
  if (!list) return;

  list.querySelectorAll('.chat-queue-btn[data-act="del"]').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const qid = btn.closest('.chat-queue-item')?.dataset.qid;
      if (qid) removeQueuedMessage(cid, qid);
    });
  });

  list.querySelectorAll('.chat-queue-btn[data-act="edit"]').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const row = btn.closest('.chat-queue-item');
      if (row) _startQueueItemEdit(cid, row);
    });
  });

  // Drag-reorder (HTML5 native). Store source index in dataTransfer.
  let draggingEl = null;
  list.querySelectorAll('.chat-queue-item').forEach((row, idx) => {
    row.dataset.idx = String(idx);
    row.addEventListener('dragstart', (e) => {
      draggingEl = row;
      row.classList.add('dragging');
      try {
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', row.dataset.qid || '');
      } catch (_) {}
    });
    row.addEventListener('dragend', () => {
      row.classList.remove('dragging');
      list.querySelectorAll('.drop-target').forEach(el => el.classList.remove('drop-target'));
      draggingEl = null;
    });
    row.addEventListener('dragover', (e) => {
      if (!draggingEl || draggingEl === row) return;
      e.preventDefault();
      list.querySelectorAll('.drop-target').forEach(el => el.classList.remove('drop-target'));
      row.classList.add('drop-target');
    });
    row.addEventListener('drop', (e) => {
      e.preventDefault();
      if (!draggingEl || draggingEl === row) return;
      const fromIdx = parseInt(draggingEl.dataset.idx, 10);
      let toIdx = parseInt(row.dataset.idx, 10);
      // Drop AFTER the target if the pointer is in its lower half.
      const rect = row.getBoundingClientRect();
      if (e.clientY > rect.top + rect.height / 2) toIdx += 1;
      row.classList.remove('drop-target');
      if (Number.isInteger(fromIdx) && Number.isInteger(toIdx)) {
        reorderQueuedMessage(cid, fromIdx, toIdx);
      }
    });
  });
}

function _startQueueItemEdit(cid, row) {
  const qid = row.dataset.qid;
  const item = _getQueue(cid).find(m => m.id === qid);
  if (!item) return;
  row.classList.add('editing');
  row.innerHTML = `
    <textarea class="chat-queue-edit" rows="2"></textarea>
    <div class="chat-queue-edit-actions">
      <button class="chat-queue-btn" data-act="cancel">${escapeHtml(t('chat.queue_cancel'))}</button>
      <button class="chat-queue-btn" data-act="save">${escapeHtml(t('chat.queue_save'))}</button>
    </div>
  `;
  const ta = row.querySelector('.chat-queue-edit');
  ta.value = item.content || '';
  ta.focus();
  ta.setSelectionRange(ta.value.length, ta.value.length);

  const finish = () => renderMessageQueue(cid);
  row.querySelector('[data-act="cancel"]').addEventListener('click', finish);
  row.querySelector('[data-act="save"]').addEventListener('click', () => {
    const v = (ta.value || '').trim();
    if (!v) { removeQueuedMessage(cid, qid); return; }
    updateQueuedMessage(cid, qid, v);
  });
  ta.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { e.preventDefault(); finish(); }
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      const v = (ta.value || '').trim();
      if (!v) { removeQueuedMessage(cid, qid); return; }
      updateQueuedMessage(cid, qid, v);
    }
  });
}

// ─── Input draft persistence (per-conversation) ───
//
// Typed-but-unsent text is bound to the conversation id and survives tab
// switches, panel navigation, and reloads. Inline skill / connector chips live
// inside the text itself; old saved `use` fields are restored as inline tokens.

let _draftSaveTimer = null;

function _readDraftData(cid) {
  try {
    const raw = cid ? localStorage.getItem(_DRAFT_KEY(cid)) : null;
    const data = raw ? JSON.parse(raw) : null;
    return data && typeof data === 'object' ? data : {};
  } catch (_) { return {}; }
}

function _writeDraftData(cid, text, references) {
  if (!cid) return;
  const safeText = typeof text === 'string' ? text : '';
  const safeReferences = Array.isArray(references) ? references.slice(0, 20) : [];
  try {
    if (safeText || safeReferences.length) {
      localStorage.setItem(_DRAFT_KEY(cid), JSON.stringify({
        text: safeText,
        ...(safeReferences.length ? { references: safeReferences } : {}),
      }));
    } else {
      localStorage.removeItem(_DRAFT_KEY(cid));
    }
  } catch (_) {}
}

// Quote/reference chips are part of the destination task's draft. Persist
// them immediately so cross-task transfer survives navigation or reload even
// when the destination textarea is still empty.
function _persistQuoteDraft(cid) {
  if (!cid) return;
  const previous = _readDraftData(cid);
  const input = cid === currentCid ? document.getElementById('chat-input') : null;
  const text = input ? input.value : (typeof previous.text === 'string' ? previous.text : '');
  const references = typeof _getQuotes === 'function' ? _getQuotes(cid) : [];
  _writeDraftData(cid, text, references);
}

function _saveDraft(cid) {
  if (!cid) return;
  if (_draftSaveTimer) clearTimeout(_draftSaveTimer);
  _draftSaveTimer = setTimeout(() => {
    const input = document.getElementById('chat-input');
    const text = input ? input.value : '';
    const references = typeof _getQuotes === 'function' ? _getQuotes(cid) : [];
    _writeDraftData(cid, text, references);
  }, 180);
}

function _clearDraft(cid) {
  if (!cid) return;
  if (_draftSaveTimer) { clearTimeout(_draftSaveTimer); _draftSaveTimer = null; }
  try { localStorage.removeItem(_DRAFT_KEY(cid)); } catch (_) {}
}

function _restoreDraft(cid) {
  const input = document.getElementById('chat-input');
  if (!input) return;
  const data = _readDraftData(cid);
  const text = (data && typeof data.text === 'string') ? data.text : '';
  const use = data && data.use
    ? data.use
    : ((data && typeof data.skill === 'string' && data.skill)
      ? { kind: 'skill', id: data.skill, name: data.skill }
      : null);
  input.value = text;
  autoGrow(input, 200);
  if (typeof _quotesByCid !== 'undefined') {
    const references = Array.isArray(data.references) ? data.references.slice(0, 20) : [];
    if (references.length) _quotesByCid.set(cid, references);
    else _quotesByCid.delete(cid);
    if (cid === currentCid && typeof _renderQuotePreview === 'function') _renderQuotePreview();
  }
  if (use && typeof _chatUseSelectionsFromText === 'function' && !_chatUseSelectionsFromText(text).length) {
    try { input.setSelectionRange(0, 0); } catch (_) {}
    setChatUseSelection('conversation', use, { focus: false });
    try { input.setSelectionRange(input.value.length, input.value.length); } catch (_) {}
  } else if (!text) {
    setChatUseSelection('conversation', null, { focus: false });
  } else {
    try { input.setSelectionRange(input.value.length, input.value.length); } catch (_) {}
  }
}
