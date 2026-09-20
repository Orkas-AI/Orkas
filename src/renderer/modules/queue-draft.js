// ─── Composer drafts + interrupted-message restore (per-conversation) ───
//
// The renderer-local message queue that used to live here is retired: while a
// conversation is busy, sends go straight to the backend, where the scheduler
// queues them as visible, cancellable task-board rows (`bus.ts` admission).
// What remains renderer-local is composer state only — typed-but-unsent
// drafts and the Stop hand-back snapshot.

const _draftSaveTimers = new Map();
// cid → composer state of the message that started the running turn, as the
// user authored it (raw text with inline use tokens, recipient, references,
// attachments). Pressing Stop hands it back to the composer so the user can
// edit and resend. In-memory only: a snapshot surviving a restart would be
// restored onto an unrelated later turn.
const _sentComposerSnapshots = new Map();

// Drop all locally-cached state for a conversation (called on delete).
function _forgetConvLocal(cid) {
  if (!cid) return;
  _sentComposerSnapshots.delete(cid);
  try { localStorage.removeItem(_queueComposerEditKey(cid)); } catch (_) {}
  _cancelDraftSave(cid);
  try {
    // `queue_<cid>` is the retired pre-board local queue's storage key —
    // removed here so deleted conversations leave no stale rows behind.
    localStorage.removeItem(`queue_${cid}`);
    localStorage.removeItem(_DRAFT_KEY(cid));
  } catch (_) {}
  if (typeof _forgetCidRecipient === 'function') _forgetCidRecipient(cid);
}

function _composerSafeAttachmentItems(items) {
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

function _composerStoredAttachmentItems(cid, items, opts = {}) {
  return _composerSafeAttachmentItems(items).map((snapshot) => {
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

function _composerQuoteFromReference(ref) {
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
  _persistQueueComposerEditState(cid);
  const previous = _readDraftData(cid);
  const input = cid === currentCid ? document.getElementById('chat-input') : null;
  const text = input ? input.value : (typeof previous.text === 'string' ? previous.text : '');
  const references = typeof _getQuotes === 'function' ? _getQuotes(cid) : [];
  _writeDraftData(cid, text, references);
}

function _saveDraft(cid) {
  if (!cid) return;
  // Snapshot before the debounce. Reading the shared textarea later can
  // capture another conversation after a fast sidebar switch and write that
  // text under the old cid.
  const input = document.getElementById('chat-input');
  const text = input ? input.value : '';
  const references = typeof _getQuotes === 'function' ? _getQuotes(cid) : [];
  _persistQueueComposerEditState(cid);
  _cancelDraftSave(cid);
  const timer = setTimeout(() => {
    if (_draftSaveTimers.get(cid) !== timer) return;
    _draftSaveTimers.delete(cid);
    _writeDraftData(cid, text, references);
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
  if (_restoreQueueItemEdit(cid)) return;
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
    references: rawReferences.map(_composerQuoteFromReference).filter(Boolean).slice(0, 20),
    attachments: _composerSafeAttachmentItems(source.attachments),
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

function _clearSentComposerSnapshot(cid) {
  if (cid) _sentComposerSnapshots.delete(cid);
}

/** True when the composer already carries input the user has not sent. Restore
 *  must never overwrite it — losing what the user just typed is worse than not
 *  restoring the interrupted message. */
function _composerHoldsUnsentInput(cid) {
  if (!cid || _isQueueItemEditing(cid)) return true;
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
      _composerStoredAttachmentItems(cid, snapshot.attachments, { forceReused: true }),
    );
  }
  if (snapshot.recipient && typeof setChatRecipient === 'function') {
    setChatRecipient('conversation', snapshot.recipient.defaultRecipient || snapshot.recipient);
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

// Queued-message edits use the ordinary composer. The backend retains its
// queue slot and holds admission; this marker owns only the displaced draft.
const _queueComposerRestoring = new Set();
const _queueComposerSaving = new Set();
const _queueComposerStarting = new Set();
const _queueComposerEditKey = (cid) => `${_DRAFT_KEY(cid)}:queue-edit`;
function _queueComposerEditFor(cid) {
  try { return JSON.parse(localStorage.getItem(_queueComposerEditKey(cid)) || 'null'); }
  catch (_) { return null; }
}
function _isQueueItemEditing(cid) { return !!_queueComposerEditFor(cid); }
function _queueComposerContext(cid) {
  return {
    text: document.getElementById('chat-input')?.value || '',
    references: typeof _getQuotes === 'function' ? _getQuotes(cid).slice() : [],
    attachments: typeof _chatAttachList === 'function' ? _composerSafeAttachmentItems(_chatAttachList(cid)) : [],
    recipient: typeof getChatRecipient === 'function' ? getChatRecipient('conversation') : null,
  };
}
function _persistQueueComposerEditState(cid) {
  if (!cid || cid !== currentCid || _queueComposerRestoring.has(cid)) return;
  const edit = _queueComposerEditFor(cid);
  if (!edit) return;
  edit.draft = _queueComposerContext(cid);
  localStorage.setItem(_queueComposerEditKey(cid), JSON.stringify(edit));
}
function _applyQueueComposerContext(cid, draft) {
  _queueComposerRestoring.add(cid);
  try {
    _cancelDraftSave(cid);
    _writeDraftData(cid, draft.text, draft.references);
    if (typeof _chatAttachSet === 'function') {
      _chatAttachSet(cid, _composerStoredAttachmentItems(cid, draft.attachments || []));
    }
    if (cid !== currentCid) return;
    const input = document.getElementById('chat-input');
    if (!input) return;
    if (!_isQueueItemEditing(cid) && draft.recipient && typeof setChatRecipient === 'function') {
      setChatRecipient('conversation', draft.recipient);
    }
    input.value = draft.text || '';
    if (typeof _quotesByCid !== 'undefined') _quotesByCid.set(cid, draft.references || []);
    if (typeof _renderQuotePreview === 'function') _renderQuotePreview(cid);
    autoGrow(input, 200);
    if (typeof syncChatRichComposerFromTextarea === 'function') syncChatRichComposerFromTextarea(input);
    if (typeof _renderRecipientChip === 'function') _renderRecipientChip('conversation');
  } finally { _queueComposerRestoring.delete(cid); }
}
function _restoreQueueItemEdit(cid) {
  const edit = _queueComposerEditFor(cid);
  if (!edit) return false;
  _applyQueueComposerContext(cid, edit.draft);
  return true;
}
async function _queueEditRequest(cid, action, body) {
  const response = await apiFetch(`/api/conversations/${encodeURIComponent(cid)}/tasks/${action}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  return response.json();
}
function _queueEditError(error) {
  return t(error === 'edit_conflict' ? 'chat.queue_edit_conflict'
    : error === 'not_queued' || error === 'not_editable' ? 'chat.queue_edit_unavailable' : 'chat.queue_edit_failed');
}
async function _startQueueItemEdit(cid, taskId) {
  if (cid !== currentCid || _isQueueItemEditing(cid) || _queueComposerStarting.has(cid)) return;
  _queueComposerStarting.add(cid);
  try {
    const data = await _queueEditRequest(cid, 'begin-edit', { task_id: taskId });
    if (!data?.ok) { await uiAlert(_queueEditError(data?.error)); return; }
    if (cid !== currentCid) {
      await _queueEditRequest(cid, 'cancel-edit', { task_id: taskId });
      return;
    }
    const message = data.message;
    let text = message.text || '';
    if (typeof _chatUseTokenFor === 'function') {
      const present = typeof _chatUseSelectionsFromText === 'function' ? _chatUseSelectionsFromText(text) : [];
      const missing = (message.use_selections || []).filter((selection) => !present.some((p) => p.kind === selection.kind && p.id === selection.id));
      text = [...missing.map((selection) => _chatUseTokenFor(selection)), text].filter(Boolean).join(' ');
    }
    const edit = { taskId, original: message.text || '', recipient: data.recipient,
      previous: _queueComposerContext(cid),
      draft: { text, references: (message.references || []).map(_composerQuoteFromReference).filter(Boolean),
        attachments: (message.attachments || []).map((name) => ({ name, reused: true, status: 'ready' })) } };
    localStorage.setItem(_queueComposerEditKey(cid), JSON.stringify(edit));
    _applyQueueComposerContext(cid, edit.draft);
    _updateConvSendUI(cid);
    const input = document.getElementById('chat-input');
    if (typeof focusChatRichComposer !== 'function' || !focusChatRichComposer(input)) input?.focus();
  } catch (_) {
    // Failure to persist the local edit marker must not strand the backend
    // queue in a hold that no composer can subsequently release.
    if (!_isQueueItemEditing(cid)) {
      try { await _queueEditRequest(cid, 'cancel-edit', { task_id: taskId }); } catch (_) {}
    }
    await uiAlert(t('chat.queue_edit_failed'));
  }
  finally { _queueComposerStarting.delete(cid); }
}
async function _finishQueueItemEdit(cid, action = 'edit') {
  const edit = _queueComposerEditFor(cid);
  if (!edit || _queueComposerSaving.has(cid)) return false;
  _persistQueueComposerEditState(cid);
  const draft = _queueComposerEditFor(cid).draft;
  const selections = typeof getChatUseSelections === 'function' ? getChatUseSelections('conversation') : [];
  if (action === 'edit' && !draft.text.trim()) { await uiAlert(t('chat.queue_edit_empty')); return false; }
  _queueComposerSaving.add(cid);
  _updateConvSendUI(cid);
  let releaseAttachments;
  try {
    let resources;
    if (action === 'edit') {
      releaseAttachments = _chatAttachTryBeginSend(cid);
      if (!releaseAttachments) { await uiAlert(t('chat.attach_still_uploading')); return false; }
      const snapshot = await _chatAttachSnapshotForSend(cid, { onlySelected: true });
      if (!snapshot.ok) { await uiAlert(t('chat.attach_sync_failed')); return false; }
      resources = { attachments: snapshot.names,
        references: _referenceSnapshotsForQuotes(draft.references),
        use_selections: selections };
    }
    const data = await _queueEditRequest(cid, action, { task_id: edit.taskId,
      ...(action === 'edit' ? { instruction: transformWithChatUse(draft.text), expected_instruction: edit.original, resources } : {}) });
    if (!data?.ok) { await uiAlert(_queueEditError(data?.error)); return false; }
    localStorage.removeItem(_queueComposerEditKey(cid));
    _applyQueueComposerContext(cid, edit.previous);
    if (window.TaskBoard) window.TaskBoard.resync(cid);
    return true;
  } catch (_) { await uiAlert(t('chat.queue_edit_failed')); return false; }
  finally {
    releaseAttachments?.();
    _queueComposerSaving.delete(cid);
    _updateConvSendUI(cid);
  }
}
function _cancelQueueItemEdit(cid) { return _finishQueueItemEdit(cid, 'cancel-edit'); }
function _deleteQueueItemEdit(cid) { return _finishQueueItemEdit(cid, 'cancel'); }
