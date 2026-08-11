// ─── Message queue (per-conversation) ───
//
// While a reply is streaming, additional user messages are queued instead of
// sent immediately. Queue is per-cid, persisted in localStorage so a refresh
// mid-stream doesn't drop pending messages. Drained one-by-one when the
// current reply finishes (or is aborted). Each entry records the raw user
// text, recipient, and model telemetry snapshots visible when the user pressed
// send. Inline skill / connector tokens stay in `content`; legacy rows may
// still carry `use`, which is expanded at dispatch time for compatibility.

const _queueDispatching = new Set();
const _draftSaveTimers = new Map();
const _queueComposerRestoring = new Set();
// cid → composer state of the message that started the running turn, as the
// user authored it (raw text with inline use tokens, recipient, references,
// attachments). Pressing Stop hands it back to the composer so the user can
// edit and resend. In-memory only: a snapshot surviving a restart would be
// restored onto an unrelated later turn.
const _sentComposerSnapshots = new Map();

function _queueEditingItem(cid) {
  if (!cid) return null;
  return _getQueue(cid).find(item => (
    item
    && item.composer_edit
    && typeof item.composer_edit === 'object'
  )) || null;
}

function _isQueueItemEditing(cid) {
  return !!_queueEditingItem(cid);
}

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
  _queueDispatching.delete(cid);
  _sentComposerSnapshots.delete(cid);
  _cancelDraftSave(cid);
  try {
    localStorage.removeItem(_QUEUE_KEY(cid));
    localStorage.removeItem(_DRAFT_KEY(cid));
  } catch (_) {}
  if (typeof _clearQueueEditRecipient === 'function') _clearQueueEditRecipient(cid);
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

function _queueItemUseSelections(item) {
  if (!item) return [];
  const sidecar = item.extra && Array.isArray(item.extra.use_selections)
    ? item.extra.use_selections
    : [];
  const legacy = _queueItemUseSelection(item);
  if (typeof _normalizeChatUseSelections === 'function') {
    return _normalizeChatUseSelections([
      ...sidecar,
      ...(legacy ? [legacy] : []),
    ]);
  }
  return sidecar.slice();
}

function _queueItemTargetActor(item) {
  const recipient = item && item.recipient;
  if (!recipient || typeof recipient !== 'object') return '';
  if (recipient.kind === 'commander') return 'commander';
  if (recipient.kind === 'agent' && recipient.id) return String(recipient.id);
  return '';
}

/** True only when clicking Send can affect the exact live turn represented by
 * the row. The main process owns rich runtime capability (`steerable`); the
 * renderer only adds recipient matching and repeats it at click time. */
function _canSendQueueItemIntoActiveTurn(cid, item) {
  if (!cid || !item || !isConvPending(cid)) return false;
  const targetActor = _queueItemTargetActor(item);
  if (!targetActor || typeof _queueSendNowActiveTurns !== 'function') return false;
  const activeTurns = _queueSendNowActiveTurns(cid);
  return Array.isArray(activeTurns) && activeTurns.some(turn => (
    turn
    && turn.steerable === true
    && String(turn.actor || '') === targetActor
  ));
}

function _queueSafeAttachmentItems(items) {
  if (!Array.isArray(items)) return [];
  return items
    .filter(item => item && typeof item === 'object' && String(item.name || '').trim())
    .slice(0, 20)
    .map((item) => ({
      name: String(item.name),
      ...(item.displayName ? { displayName: String(item.displayName) } : {}),
      ...(item.kind ? { kind: String(item.kind) } : {}),
      ...(Number.isFinite(Number(item.bytes)) ? { bytes: Number(item.bytes) } : {}),
      ...(item.dataUrl ? { dataUrl: String(item.dataUrl) } : {}),
      ...(item.sha256 ? { sha256: String(item.sha256) } : {}),
      ...(item.tempId ? { tempId: String(item.tempId) } : {}),
      ...(item.status ? { status: String(item.status) } : {}),
      ...(item.reused === true ? { reused: true } : {}),
    }));
}

function _queueStoredAttachmentItemsForComposer(cid, items, opts = {}) {
  return _queueSafeAttachmentItems(items).map((snapshot) => {
    const kind = snapshot.kind || (
      typeof _chatAttachKindFromExt === 'function' && typeof _chatAttachExtOf === 'function'
        ? _chatAttachKindFromExt(_chatAttachExtOf(snapshot.name))
        : ''
    );
    const media = kind === 'image' || kind === 'video' || kind === 'audio';
    const staleLocalPreview = snapshot.dataUrl && snapshot.dataUrl.startsWith('blob:');
    return {
      ...snapshot,
      displayName: snapshot.displayName || snapshot.name,
      kind,
      bytes: Number(snapshot.bytes) || 0,
      dataUrl: media
        && typeof _chatMediaUrl === 'function'
        && (!snapshot.dataUrl || staleLocalPreview)
        ? _chatMediaUrl(cid, snapshot.name)
        : (snapshot.dataUrl || null),
      status: snapshot.status || 'ready',
      ...(opts.forceReused === true ? { reused: true } : {}),
    };
  });
}

function _queueAttachmentItemsForComposer(cid, item) {
  const names = Array.isArray(item && item.extra && item.extra.attachments)
    ? item.extra.attachments.map(name => String(name || '')).filter(Boolean)
    : [];
  const snapshots = _queueSafeAttachmentItems(item && item.attachment_items);
  const byName = new Map(snapshots.map(attachment => [attachment.name, attachment]));
  const ordered = names.map((name) => {
    const snapshot = byName.get(name) || {};
    return {
      ...snapshot,
      name,
      displayName: snapshot.displayName || name,
      status: 'ready',
    };
  });
  // Files already belong to the conversation attachment pool. Removing one
  // from this edit must not delete bytes referenced by an older message or
  // another queued item.
  return _queueStoredAttachmentItemsForComposer(cid, ordered, { forceReused: true });
}

function _queueQuoteFromReference(ref) {
  if (!ref || typeof ref !== 'object') return null;
  const sourceCid = String(ref.sourceCid || ref.source_cid || '');
  const msgId = String(ref.msgId || ref.source_msg_id || '');
  if (!sourceCid || !msgId) return null;
  return {
    sourceCid,
    sourceTitle: String(ref.sourceTitle || ref.source_title || ''),
    msgId,
    fromActor: String(ref.fromActor || ref.from_actor || ''),
    ...(ref.fromName || ref.from_name
      ? { fromName: String(ref.fromName || ref.from_name) }
      : {}),
    ts: String(ref.ts || ref.source_ts || ''),
    text: String(ref.text || ''),
    attachments: Array.isArray(ref.attachments) ? ref.attachments.slice() : [],
    produced: Array.isArray(ref.produced) ? ref.produced.slice() : [],
    references: Array.isArray(ref.references) ? ref.references.slice(0, 20) : [],
    referenceCount: Math.max(
      0,
      Number(ref.referenceCount || ref.reference_count) || ref.references?.length || 0,
    ),
  };
}

function _queueReferencesForComposer(item) {
  const refs = Array.isArray(item && item.extra && item.extra.references)
    ? item.extra.references
    : [];
  return refs.map(_queueQuoteFromReference).filter(Boolean).slice(0, 20);
}

function _queueReferenceSnapshots(references) {
  if (typeof _referenceSnapshotsForQuotes === 'function') {
    return _referenceSnapshotsForQuotes(references);
  }
  return (Array.isArray(references) ? references : [])
    .map((ref) => {
      const quote = _queueQuoteFromReference(ref);
      if (!quote) return null;
      return {
        source_cid: quote.sourceCid,
        source_title: quote.sourceTitle,
        source_msg_id: quote.msgId,
        from_actor: quote.fromActor,
        ...(quote.fromName ? { from_name: quote.fromName } : {}),
        source_ts: quote.ts,
        text: quote.text,
        ...(quote.attachments.length ? { attachments: quote.attachments.slice() } : {}),
        ...(quote.produced.length ? { produced: quote.produced.slice() } : {}),
      };
    })
    .filter(Boolean)
    .slice(0, 20);
}

function _queueCurrentComposerContext(cid) {
  const references = typeof _getQuotes === 'function'
    ? _getQuotes(cid).slice(0, 20)
    : [];
  const attachments = typeof _chatAttachList === 'function'
    ? _queueSafeAttachmentItems(_chatAttachList(cid))
    : [];
  const recipient = typeof getChatRecipient === 'function'
    ? getChatRecipient('conversation')
    : null;
  const useSelections = typeof getChatUseSelections === 'function'
    ? getChatUseSelections('conversation')
    : [];
  return {
    references,
    attachments,
    ...(recipient ? { recipient } : {}),
    ...(useSelections.length ? { use_selections: useSelections } : {}),
  };
}

function _persistQueueComposerEditState(cid) {
  if (!cid || _queueComposerRestoring.has(cid)) return;
  const item = _queueEditingItem(cid);
  if (!item || !item.composer_edit) return;
  item.composer_edit.draft_context = _queueCurrentComposerContext(cid);
  _saveQueueToStorage(cid);
}

function enqueueMessage(cid, content, useSelection, opts = {}) {
  const q = _getQueue(cid);
  const extra = opts && opts.extra && typeof opts.extra === 'object' ? opts.extra : null;
  const modelTelemetry = typeof _chatModelTelemetryContext === 'function'
    ? _chatModelTelemetryContext(opts && opts.modelTelemetry)
    : {};
  const attachmentItems = _queueSafeAttachmentItems(opts && opts.attachmentItems);
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
    ...(Object.keys(modelTelemetry).length ? { model_telemetry: modelTelemetry } : {}),
    ...(attachmentItems.length ? { attachment_items: attachmentItems } : {}),
  });
  _saveQueueToStorage(cid);
  _updateConvSidebarBadge(cid);
  if (cid === currentCid) {
    renderMessageQueue(cid);
    _updateConvSendUI(cid);
  }
}

function _trackQueuedChatSendTerminal(item, result, durationMs) {
  if (!item || typeof _trackChatSendResult !== 'function') return;
  const attachmentCount = Array.isArray(item.extra && item.extra.attachments)
    ? item.extra.attachments.length
    : 0;
  const measuredDurationMs = Number(durationMs);
  _trackChatSendResult(result, {
    source_view: 'conversation',
    content_length: String(item.content || '').length,
    attachment_count: attachmentCount,
    ...(durationMs !== null && durationMs !== undefined && Number.isFinite(measuredDurationMs)
      ? { duration_ms: Math.max(0, Math.round(measuredDurationMs)) }
      : {}),
    ...(typeof _chatModelTelemetryContext === 'function'
      ? _chatModelTelemetryContext(item.model_telemetry)
      : {}),
  });
}

function removeQueuedMessage(cid, qid) {
  const q = _getQueue(cid);
  const idx = q.findIndex(m => m.id === qid);
  if (idx < 0) return;
  const [removed] = q.splice(idx, 1);
  // Removing a queued row starts no transport, so it has no send duration.
  _trackQueuedChatSendTerminal(removed, 'cancelled');
  _saveQueueToStorage(cid);
  _updateConvSidebarBadge(cid);
  if (cid === currentCid) {
    renderMessageQueue(cid);
    _updateConvSendUI(cid);
  }
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

function _queueItemDispatchPayload(next) {
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
  return {
    content,
    extra: Object.keys(extra).length ? extra : undefined,
  };
}

function _removeDispatchedQueueItem(cid, qid) {
  const liveQueue = _getQueue(cid);
  const idx = liveQueue.findIndex((item) => item && item.id === qid);
  if (idx < 0) return false;
  liveQueue.splice(idx, 1);
  _saveQueueToStorage(cid);
  _updateConvSidebarBadge(cid);
  if (cid === currentCid) {
    renderMessageQueue(cid);
    _updateConvSendUI(cid);
  }
  return true;
}

function _dispatchQueuedItem(cid, next) {
  if (!cid || !next || _queueDispatching.has(cid)) return false;
  const { content, extra } = _queueItemDispatchPayload(next);
  const removeStartedItem = () => {
    // Once onStarted fires, isConvPending(cid) becomes the execution lock.
    // Release the preflight lock before terminal settlement synchronously
    // drains the next queue item.
    _queueDispatching.delete(cid);
    _removeDispatchedQueueItem(cid, next.id);
  };
  // Fire-and-forget: the send path owns stream failures and final cleanup.
  // Keep the queue head durable until onStarted. A synchronous throw or an
  // async preflight refusal releases only the dispatch lock so a later
  // recovery trigger can retry the same item.
  _queueDispatching.add(cid);
  _rememberSentComposerSnapshot(cid, _sentComposerSnapshotFromQueueItem(cid, next));
  let sendPromise;
  try {
    sendPromise = sendInConversation(
      cid,
      content,
      extra,
      {
        from_queue: true,
        source_view: 'conversation',
        // Keep the terminal row aligned with the click-time authored request.
        // Dispatch may add recipient/resource routing prefixes to `content`,
        // which are transport details rather than user-entered text.
        content_length: String(next.content || '').length,
        ...(typeof _chatModelTelemetryContext === 'function'
          ? _chatModelTelemetryContext(next.model_telemetry)
          : {}),
        // Background queues share the same execution lifecycle, but their
        // optimistic user/assistant nodes must not be appended to whichever
        // conversation happens to be visible.
        background: cid !== currentCid,
        onStarted: removeStartedItem,
      },
    );
  } catch (_) {
    _queueDispatching.delete(cid);
    _clearSentComposerSnapshot(cid);
    return false;
  }
  Promise.resolve(sendPromise).then(
    () => { _queueDispatching.delete(cid); },
    () => { _queueDispatching.delete(cid); },
  );
  return true;
}

async function _sendQueuedMessageIntoActiveRun(cid, next) {
  if (!cid || !next || _queueDispatching.has(cid) || _isQueueItemEditing(cid)) return false;
  const { content, extra } = _queueItemDispatchPayload(next);
  _queueDispatching.add(cid);
  // Steering the live turn makes this the newest sent message, so Stop must
  // hand back this one rather than whatever started the turn.
  _rememberSentComposerSnapshot(cid, _sentComposerSnapshotFromQueueItem(cid, next));
  if (cid === currentCid) renderMessageQueue(cid);
  const startedAt = Date.now();
  try {
    const res = await apiFetch(`/api/conversations/${encodeURIComponent(cid)}/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        content,
        ...(extra || {}),
      }),
    });
    const data = await res.json();
    if (!res.ok || !data || data.ok !== true || !data.msg) {
      throw new Error((data && data.error) || `HTTP ${res.status}`);
    }
    // The existing run observer normally renders the persisted user event
    // before this request resolves. Claim-or-render is idempotent and also
    // covers a tab switch or observer reconnect during the click.
    if (cid === currentCid && typeof _renderOrClaimPersistedUserMessage === 'function') {
      _renderOrClaimPersistedUserMessage(cid, data.msg);
    }
    _removeDispatchedQueueItem(cid, next.id);
    _trackQueuedChatSendTerminal(next, 'success', Date.now() - startedAt);
    return true;
  } catch (err) {
    // Nothing reached the live turn, so this message is not what a stop would
    // be interrupting.
    _clearSentComposerSnapshot(cid);
    try {
      uiAlert(t('chat.queue_send_now_failed', {
        msg: err && err.message ? err.message : String(err || ''),
      }));
    } catch (_) {}
    return false;
  } finally {
    _queueDispatching.delete(cid);
    if (cid === currentCid) renderMessageQueue(cid);
    // The active run may have settled while the request was in flight. Resume
    // the remaining durable queue now; the pending check prevents overlap.
    _dispatchNextQueued(cid);
  }
}

function sendQueuedMessageNow(cid, qid) {
  if (!cid || !qid || _isQueueItemEditing(cid) || _queueDispatching.has(cid)) return false;
  const next = _getQueue(cid).find(item => item && item.id === qid);
  if (!next || !_canSendQueueItemIntoActiveTurn(cid, next)) return false;
  void _sendQueuedMessageIntoActiveRun(cid, next);
  return true;
}

// Called by _finishStreamingMsg when a reply completes/aborts/errors.
function _dispatchNextQueued(cid) {
  const q = _getQueue(cid);
  if (!q.length) return;
  // Editing a queued item is a queue-wide lock. The edited item remains
  // durable at its original array position but is temporarily owned by the
  // composer, so neither it nor a later item may overtake the edit.
  if (_isQueueItemEditing(cid)) return;
  if (isConvPending(cid)) return;
  // The controller may spend time in an async preflight before onStarted, or
  // an active-run send-now request may still be persisting its selected row.
  // Coalesce settlement drains so neither path submits a durable item twice.
  if (_queueDispatching.has(cid)) return;
  // Keep the item durable until the chat controller has actually entered its
  // started state. A model-config/preflight rejection must not silently drop
  // the queued user message.
  _dispatchQueuedItem(cid, q[0]);
}

function renderMessageQueue(cid) {
  const panel = document.getElementById('chat-queue');
  const list = document.getElementById('chat-queue-list');
  const countEl = document.getElementById('chat-queue-count');
  if (!panel || !list) return;
  const q = cid ? _getQueue(cid) : [];
  const editing = cid ? _isQueueItemEditing(cid) : false;
  const dispatching = cid ? _queueDispatching.has(cid) : false;
  const visible = q
    .map((item, index) => ({ item, index }))
    .filter(({ item }) => !(item && item.composer_edit));
  if (!visible.length) {
    panel.style.display = 'none';
    list.innerHTML = '';
    if (countEl) countEl.textContent = '0';
    return;
  }
  panel.style.display = '';
  if (countEl) countEl.textContent = String(visible.length);
  list.innerHTML = visible.map(({ item, index }) => {
    const use = _queueItemUseSelection(item);
    const useChip = use
      ? `<span class="chat-queue-skill">${escapeHtml(formatChatUseLabel(use))}</span>` : '';
    const displayContent = (typeof formatChatUseTextForDisplay === 'function')
      ? formatChatUseTextForDisplay(item.content || '')
      : (item.content || '');
    const preview = escapeHtml(displayContent.replace(/\s+/g, ' ')).slice(0, 200);
    const attachmentCount = Array.isArray(item.extra && item.extra.attachments)
      ? item.extra.attachments.length
      : 0;
    const attachmentLabel = attachmentCount
      ? `<span class="chat-queue-attachments">${escapeHtml(t('chat.queue_attachment_count', { n: attachmentCount }))}</span>`
      : '';
    const canSendNow = !editing && !dispatching
      && _canSendQueueItemIntoActiveTurn(cid, item);
    const sendAction = canSendNow
      ? `<button class="chat-queue-btn" data-act="send">${escapeHtml(t('chat.queue_send_now'))}</button>`
      : '';
    return `
      <div class="chat-queue-item" draggable="${editing || dispatching ? 'false' : 'true'}" data-qid="${item.id}" data-idx="${index}">
        <div class="chat-queue-drag" title="${escapeHtml(t('chat.queue_drag_title'))}">⋮⋮</div>
        <div class="chat-queue-text">${useChip}${preview}${attachmentLabel}</div>
        <div class="chat-queue-actions">
          ${sendAction}
          <button class="chat-queue-btn" data-act="edit"${editing || dispatching ? ' disabled' : ''}>${escapeHtml(t('chat.queue_edit'))}</button>
          <button class="chat-queue-btn danger" data-act="del"${dispatching ? ' disabled' : ''}>×</button>
        </div>
      </div>
    `;
  }).join('');
  _wireQueueItemEvents(cid);
}

function _wireQueueItemEvents(cid) {
  const list = document.getElementById('chat-queue-list');
  if (!list) return;

  list.querySelectorAll('.chat-queue-btn[data-act="send"]').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const qid = btn.closest('.chat-queue-item')?.dataset.qid;
      if (qid) sendQueuedMessageNow(cid, qid);
    });
  });

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
  list.querySelectorAll('.chat-queue-item').forEach((row) => {
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
  const input = document.getElementById('chat-input');
  if (!item || !input || _isQueueItemEditing(cid)) return;

  const previousDraft = _readDraftData(cid);
  previousDraft.text = input.value || '';
  if (typeof _getQuotes === 'function') {
    const references = _getQuotes(cid);
    if (references.length) previousDraft.references = references.slice(0, 20);
    else delete previousDraft.references;
  }
  if (typeof _chatAttachList === 'function') {
    const attachments = _queueSafeAttachmentItems(_chatAttachList(cid));
    if (attachments.length) previousDraft.attachments = attachments;
    else delete previousDraft.attachments;
  }
  item.composer_edit = {
    previous_draft: previousDraft,
    draft_context: {
      references: _queueReferencesForComposer(item),
      attachments: _queueAttachmentItemsForComposer(cid, item),
      ...((item.recipient && typeof item.recipient === 'object')
        ? { recipient: { ...item.recipient } }
        : {}),
      ...(_queueItemUseSelections(item).length
        ? { use_selections: _queueItemUseSelections(item) }
        : {}),
    },
  };
  _saveQueueToStorage(cid);

  // The queued message now owns the whole composer, not just its textarea.
  // Persist the text under the normal draft key and keep every non-text chip
  // in the durable queue marker so refresh can rebuild the same edit.
  _cancelDraftSave(cid);
  _writeDraftData(cid, item.content || '', item.composer_edit.draft_context.references);
  _restoreQueueItemEdit(cid, _readDraftData(cid));
  renderMessageQueue(cid);
  _updateConvSendUI(cid);
  input.focus();
  input.setSelectionRange(input.value.length, input.value.length);
}

function _queueEditTextWithUseSelections(text, selections) {
  const raw = String(text || '');
  if (typeof _chatUseTokenFor !== 'function') return raw;
  const present = typeof _chatUseSelectionsFromText === 'function'
    ? _chatUseSelectionsFromText(raw)
    : [];
  const presentKeys = new Set((Array.isArray(present) ? present : []).map(
    selection => `${selection.kind || ''}:${selection.id || selection.name || ''}`,
  ));
  const tokens = (Array.isArray(selections) ? selections : [])
    .filter(selection => !presentKeys.has(
      `${selection.kind || ''}:${selection.id || selection.name || ''}`,
    ))
    .map(selection => _chatUseTokenFor(selection))
    .filter(Boolean);
  if (!tokens.length) return raw;
  return `${tokens.join(' ')}${raw ? ` ${raw}` : ''}`;
}

function _restoreQueueItemEdit(cid, draftData = {}) {
  const item = _queueEditingItem(cid);
  const input = document.getElementById('chat-input');
  if (!item || !input) return false;
  const context = item.composer_edit.draft_context || {};
  const references = Array.isArray(context.references)
    ? context.references.slice(0, 20)
    : _queueReferencesForComposer(item);
  const attachments = Array.isArray(context.attachments)
    ? _queueStoredAttachmentItemsForComposer(cid, context.attachments)
    : _queueAttachmentItemsForComposer(cid, item);
  const useSelections = Array.isArray(context.use_selections)
    ? context.use_selections
    : _queueItemUseSelections(item);
  const rawText = typeof draftData.text === 'string'
    ? draftData.text
    : (item.content || '');
  const text = _queueEditTextWithUseSelections(rawText, useSelections);

  _queueComposerRestoring.add(cid);
  try {
    input.value = text;
    autoGrow(input, 200);
    if (typeof _quotesByCid !== 'undefined') {
      if (references.length) _quotesByCid.set(cid, references);
      else _quotesByCid.delete(cid);
    }
    if (typeof _renderQuotePreview === 'function') _renderQuotePreview(cid);
    if (typeof _chatAttachSet === 'function') _chatAttachSet(cid, attachments);
    if (typeof _setQueueEditRecipient === 'function') {
      const recipient = context.recipient || item.recipient;
      _setQueueEditRecipient(cid, recipient);
    }
    if (typeof syncChatRichComposerFromTextarea === 'function') {
      syncChatRichComposerFromTextarea(input);
    }
    try { input.setSelectionRange(input.value.length, input.value.length); } catch (_) {}
  } finally {
    _queueComposerRestoring.delete(cid);
  }
  return true;
}

function _replaceQueueExtraList(extra, key, value) {
  if (Array.isArray(value) && value.length) extra[key] = value;
  else delete extra[key];
}

function _restoreDisplacedQueueDraft(cid, previousDraft = {}) {
  _cancelDraftSave(cid);
  _writeDraftData(
    cid,
    typeof previousDraft.text === 'string' ? previousDraft.text : '',
    Array.isArray(previousDraft.references) ? previousDraft.references : [],
  );
  if (typeof _clearQueueEditRecipient === 'function') _clearQueueEditRecipient(cid);
  if (cid !== currentCid) return;

  _restoreDraft(cid);
  if (typeof _chatAttachSet === 'function') {
    _queueComposerRestoring.add(cid);
    try {
      _chatAttachSet(
        cid,
        Array.isArray(previousDraft.attachments)
          ? _queueStoredAttachmentItemsForComposer(cid, previousDraft.attachments)
          : [],
      );
    } finally {
      _queueComposerRestoring.delete(cid);
    }
  }
  renderMessageQueue(cid);
  _updateConvSendUI(cid);
}

function _finishQueueItemEdit(cid, content) {
  const item = _queueEditingItem(cid);
  if (!item) return false;
  const shouldCommit = typeof content === 'string';
  const nextContent = shouldCommit ? content.trim() : '';
  if (shouldCommit && !nextContent) return false;

  const previousDraft = item.composer_edit.previous_draft || {};
  if (shouldCommit) {
    const context = _queueCurrentComposerContext(cid);
    const extra = item.extra && typeof item.extra === 'object' ? { ...item.extra } : {};
    const attachmentItems = _queueSafeAttachmentItems(context.attachments)
      .filter(attachment => attachment.status !== 'error');
    const attachments = attachmentItems.map(attachment => attachment.name);
    const references = _queueReferenceSnapshots(context.references);
    const useSelections = typeof _normalizeChatUseSelections === 'function'
      ? _normalizeChatUseSelections(context.use_selections)
      : (Array.isArray(context.use_selections) ? context.use_selections : []);

    item.content = nextContent;
    // Legacy rows carried a single Skill/Connector outside the text. Restoring
    // them inserts a real inline token, so the committed text is authoritative:
    // clearing these fields prevents a chip deleted during editing from being
    // silently re-applied when the queue drains.
    item.use = null;
    item.skill = '';
    _replaceQueueExtraList(extra, 'attachments', attachments);
    _replaceQueueExtraList(extra, 'references', references);
    _replaceQueueExtraList(extra, 'use_selections', useSelections);
    if (Object.keys(extra).length) item.extra = extra;
    else delete item.extra;
    if (attachmentItems.length) item.attachment_items = attachmentItems;
    else delete item.attachment_items;
    if (context.recipient && typeof _normaliseRecipientSnapshot === 'function') {
      const recipient = _normaliseRecipientSnapshot(context.recipient);
      if (recipient) item.recipient = recipient;
    }
  }
  delete item.composer_edit;
  _saveQueueToStorage(cid);
  _restoreDisplacedQueueDraft(cid, previousDraft);
  _dispatchNextQueued(cid);
  return true;
}

function _commitQueueItemEdit(cid, content) {
  return _finishQueueItemEdit(cid, content);
}

function _cancelQueueItemEdit(cid) {
  return _finishQueueItemEdit(cid);
}

function _deleteQueueItemEdit(cid) {
  const q = _getQueue(cid);
  const index = q.findIndex(item => (
    item
    && item.composer_edit
    && typeof item.composer_edit === 'object'
  ));
  if (index < 0) return false;

  const previousDraft = q[index].composer_edit.previous_draft || {};
  q.splice(index, 1);
  _saveQueueToStorage(cid);
  _updateConvSidebarBadge(cid);
  _restoreDisplacedQueueDraft(cid, previousDraft);
  // Deletion itself never submits the removed content. If other queue items
  // remain, release the edit lock so the normal FIFO lifecycle can continue.
  _dispatchNextQueued(cid);
  return true;
}

// ─── Input draft persistence (per-conversation) ───
//
// Typed-but-unsent text is bound to the conversation id and survives tab
// switches, panel navigation, and reloads. Inline skill / connector chips live
// inside the text itself; old saved `use` fields are restored as inline tokens.

function _cancelDraftSave(cid) {
  const timer = _draftSaveTimers.get(cid);
  if (timer == null) return;
  clearTimeout(timer);
  _draftSaveTimers.delete(cid);
}

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
  _persistQueueComposerEditState(cid);
}

function _saveDraft(cid) {
  if (!cid) return;
  // Snapshot before the debounce. Reading the shared textarea later can
  // capture another conversation after a fast sidebar switch and write that
  // text under the old cid.
  const input = document.getElementById('chat-input');
  const text = input ? input.value : '';
  const references = typeof _getQuotes === 'function' ? _getQuotes(cid) : [];
  _cancelDraftSave(cid);
  const timer = setTimeout(() => {
    if (_draftSaveTimers.get(cid) !== timer) return;
    _draftSaveTimers.delete(cid);
    _writeDraftData(cid, text, references);
    _persistQueueComposerEditState(cid);
  }, 180);
  _draftSaveTimers.set(cid, timer);
}

function _clearDraft(cid) {
  if (!cid) return;
  _cancelDraftSave(cid);
  try { localStorage.removeItem(_DRAFT_KEY(cid)); } catch (_) {}
}

function _restoreDraft(cid) {
  const input = document.getElementById('chat-input');
  if (!input) return;
  const data = _readDraftData(cid);
  if (_restoreQueueItemEdit(cid, data)) return;
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

// ─── Interrupted-message composer restore (per-conversation) ───
//
// Sending clears the composer, so stopping the turn it started would otherwise
// force the user to retype a message they only wanted to adjust. Each send
// records the composer as it was authored — raw text with inline use tokens,
// recipient, references, attachments — and Stop hands that state back. The sent
// message itself stays in the transcript; this is a copy to edit, not an
// un-send.

function _sentComposerSnapshotPayload(source) {
  const text = String((source && source.text) || '');
  if (!text) return null;
  const rawReferences = Array.isArray(source.references) ? source.references : [];
  return {
    text,
    recipient: (source.recipient && typeof _normaliseRecipientSnapshot === 'function')
      ? _normaliseRecipientSnapshot(source.recipient)
      : null,
    references: rawReferences.map(_queueQuoteFromReference).filter(Boolean).slice(0, 20),
    attachments: _queueSafeAttachmentItems(source.attachments),
  };
}

function _rememberSentComposerSnapshot(cid, source) {
  if (!cid) return false;
  const snapshot = _sentComposerSnapshotPayload(source);
  // A send with no restorable text still supersedes the previous turn's
  // snapshot — otherwise Stop would hand back an older message.
  if (!snapshot) {
    _sentComposerSnapshots.delete(cid);
    return false;
  }
  _sentComposerSnapshots.set(cid, snapshot);
  return true;
}

function _sentComposerSnapshotFromQueueItem(cid, item) {
  if (!item) return null;
  return {
    text: _queueEditTextWithUseSelections(item.content || '', _queueItemUseSelections(item)),
    recipient: item.recipient,
    references: _queueReferencesForComposer(item),
    attachments: _queueAttachmentItemsForComposer(cid, item),
  };
}

function _clearSentComposerSnapshot(cid) {
  if (cid) _sentComposerSnapshots.delete(cid);
}

/** True when the composer already carries input the user has not sent. Restore
 *  must never overwrite it — losing what the user just typed is worse than not
 *  restoring the interrupted message. */
function _composerHoldsUnsentInput(cid) {
  if (!cid) return true;
  if (cid !== currentCid) {
    const draft = _readDraftData(cid);
    return !!(String(draft.text || '').trim()
      || (Array.isArray(draft.references) && draft.references.length));
  }
  const input = document.getElementById('chat-input');
  if (input && String(input.value || '').trim()) return true;
  if (typeof _getQuotes === 'function' && _getQuotes(cid).length) return true;
  if (typeof _chatAttachList === 'function' && _chatAttachList(cid).length) return true;
  return false;
}

function _restoreSentComposerSnapshot(cid) {
  const snapshot = cid ? _sentComposerSnapshots.get(cid) : null;
  if (!snapshot) return false;
  _sentComposerSnapshots.delete(cid);
  // A queued item being edited owns the whole composer; its durable slot wins.
  if (_isQueueItemEditing(cid)) return false;
  if (_composerHoldsUnsentInput(cid)) return false;
  if (cid !== currentCid) {
    // No composer is showing this conversation. Text and references survive
    // through the normal draft key; chips are composer-only state.
    _cancelDraftSave(cid);
    _writeDraftData(cid, snapshot.text, snapshot.references);
    return true;
  }
  const input = document.getElementById('chat-input');
  if (!input) return false;
  input.value = snapshot.text;
  autoGrow(input, 200);
  if (typeof _quotesByCid !== 'undefined') {
    if (snapshot.references.length) _quotesByCid.set(cid, snapshot.references.slice());
    else _quotesByCid.delete(cid);
  }
  if (typeof _renderQuotePreview === 'function') _renderQuotePreview(cid);
  // The files still belong to the conversation attachment pool because the sent
  // message references them, so they re-enter the composer as reused.
  if (typeof _chatAttachSet === 'function') {
    _chatAttachSet(
      cid,
      _queueStoredAttachmentItemsForComposer(cid, snapshot.attachments, { forceReused: true }),
    );
  }
  if (snapshot.recipient && typeof setChatRecipient === 'function') {
    setChatRecipient('conversation', snapshot.recipient);
  }
  if (typeof syncChatRichComposerFromTextarea === 'function') {
    syncChatRichComposerFromTextarea(input);
  }
  _cancelDraftSave(cid);
  _writeDraftData(cid, snapshot.text, snapshot.references);
  if (typeof focusChatRichComposer !== 'function' || !focusChatRichComposer(input)) input.focus();
  try { input.setSelectionRange(input.value.length, input.value.length); } catch (_) {}
  return true;
}
