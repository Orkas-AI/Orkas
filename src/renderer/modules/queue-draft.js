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
