// ─── Message queue (per-conversation) ───
//
// While a reply is streaming, additional user messages are queued instead of
// sent immediately. Queue is per-cid, persisted in localStorage so a refresh
// mid-stream doesn't drop pending messages. Drained one-by-one when the
// current reply finishes (or is aborted). Each entry records the raw user
// text plus the selected skill / connector — the "use X" prefix is applied
// at dispatch time so a later selection change is reflected correctly.

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
  const use = typeof _normalizeChatUseSelection === 'function'
    ? _normalizeChatUseSelection(useSelection)
    : null;
  q.push({
    id: `q${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
    content,
    use: use || null,
    skill: use && use.kind === 'skill' ? (use.name || use.id || '') : '',
    direct: !!(opts && opts.direct),
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
  const next = q.shift();
  _saveQueueToStorage(cid);
  _updateConvSidebarBadge(cid);
  renderMessageQueue(cid);
  // Skill / connector is an inline text prefix (applied at dispatch time so
  // later selection changes take effect). Agent runs are just "run <name>"
  // text — no flag.
  // Recipient prefix (`@<agent>`) is also applied at dispatch time so the
  // message routes to whoever is currently selected in the chip.
  let use = _queueItemUseSelection(next);
  if (use && typeof isChatUseAllowedForTarget === 'function' && !isChatUseAllowedForTarget('conversation')) {
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
  const withUse = use ? transformWithChatUse(next.content, use) : next.content;
  const content = next.direct ? next.content : applyRecipientPrefix(withUse, 'conversation');
  // Fire-and-forget: sendInCurrentConversation handles its own errors via
  // _streamingSetError + _finishStreamingMsg (which will re-enter this fn).
  sendInCurrentConversation(content, next.extra);
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
    const preview = escapeHtml((item.content || '').replace(/\s+/g, ' ')).slice(0, 200);
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
// switches, panel navigation, and reloads. The selected skill / connector
// chip for the conversation input is persisted alongside so it's restored too.

let _draftSaveTimer = null;

function _saveDraft(cid) {
  if (!cid) return;
  if (_draftSaveTimer) clearTimeout(_draftSaveTimer);
  _draftSaveTimer = setTimeout(() => {
    const input = document.getElementById('chat-input');
    const text = input ? input.value : '';
    const use = getChatUseSelection('conversation');
    try {
      if (text || use) {
        localStorage.setItem(_DRAFT_KEY(cid), JSON.stringify({
          text,
          use,
          skill: use && use.kind === 'skill' ? (use.name || use.id || '') : '',
        }));
      } else {
        localStorage.removeItem(_DRAFT_KEY(cid));
      }
    } catch (_) {}
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
  let data = null;
  try {
    const raw = cid ? localStorage.getItem(_DRAFT_KEY(cid)) : null;
    data = raw ? JSON.parse(raw) : null;
  } catch (_) {}
  const text = (data && typeof data.text === 'string') ? data.text : '';
  const use = data && data.use
    ? data.use
    : ((data && typeof data.skill === 'string' && data.skill)
      ? { kind: 'skill', id: data.skill, name: data.skill }
      : null);
  input.value = text;
  autoGrow(input, 200);
  // Apply or clear the chip without re-persisting the draft (no input event fires).
  setChatUseSelection('conversation', use);
}
