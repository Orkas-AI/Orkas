// ─── Plain-text view/edit controller ────────────────────────────────────
// Sibling to `mountMdViewEdit` for chat-file-viewer's non-markdown text
// files (.py, .json, .csv, .log, source code, etc.). Same controller shape
// (`destroy / isDirty / getMode / setMode`) so chat-file-viewer can hold
// either MD or text controller in `_viewerEditController` without branching.
//
// Why a sibling instead of a `plainText` flag on mountMdViewEdit:
//   - Plain text has no markdown toolbar, no preview toggle, no
//     task-checkbox interactivity. Threading `plainText: true` through
//     md-view-edit would mean three `if (!plainText) …` branches in the
//     editor / view paths — duplicating logic at the call site is less
//     code than gating each rendering primitive.
//   - PC/CLAUDE.md §8 "only md files show the md toolbar" — a physical
//     module boundary makes that invariant unforgeable; adding a flag
//     leaves the toolbar visible if anyone later forgets the gate.
//
// Backend reuse: same `produced.readText` / `produced.writeText` IPC as
// the workspace branch of md-view-edit. Path-sandbox + 2 MB read cap
// already enforced on the main side, so nothing new to validate here.
//
// Source shape: { absPath: string, cid?: string, projectId?: string }
//   `cid` widens the read/write scope to include this conversation's
//   attachment dir; `projectId` widens it to the project file pool.

const _tveLog = createLogger('text-view-edit');

/**
 * Mount a plain-text view/edit surface inside `bodyEl` with action buttons
 * placed in `actionsEl` (Edit in view mode; Save+Cancel in edit mode).
 *
 * Required: opts.bodyEl, opts.actionsEl, opts.source.absPath.
 * Optional: opts.initialContent (skips the initial read), opts.initialMode
 *           ('view' default), opts.actionIconOnly, opts.capabilities
 *           ({ edit, save } — defaults true; pass { edit: false } to lock
 *           read-only for Project Library files etc.), opts.callbacks
 *           ({ onDirtyChange, onSaved, onContentLoaded }).
 *
 * Returns a noop-shell controller on misuse rather than throwing — the
 * call site has no good fallback if mount fails after the overlay opened.
 */
function mountTextViewEdit(opts) {
  const bodyEl = opts && opts.bodyEl;
  const actionsEl = opts && opts.actionsEl;
  if (!bodyEl || !actionsEl) {
    _tveLog.warn('mountTextViewEdit called without bodyEl/actionsEl', { hasBody: !!bodyEl, hasActions: !!actionsEl });
    return _tveNoopController();
  }
  const source = opts.source;
  if (!source || typeof source.absPath !== 'string' || !source.absPath) {
    _tveLog.warn('mountTextViewEdit called without source.absPath');
    return _tveNoopController();
  }

  const caps = Object.assign({ edit: true, save: true }, opts.capabilities || {});
  const callbacks = opts.callbacks || {};

  const state = {
    source,
    caps,
    callbacks,
    bodyEl,
    actionsEl,
    actionIconOnly: opts.actionIconOnly === true,
    content: typeof opts.initialContent === 'string' ? opts.initialContent : '',
    draft: '',
    mode: opts.initialMode === 'edit' ? 'edit' : 'view',
    destroyed: false,
  };
  state.draft = state.content;

  if (typeof opts.initialContent !== 'string') {
    _tveLoadAndRender(state);
  } else {
    _tveRender(state);
  }

  function destroy() {
    state.destroyed = true;
    if (bodyEl) bodyEl.innerHTML = '';
    if (actionsEl) actionsEl.innerHTML = '';
  }
  function isDirty() { return state.mode === 'edit' && state.draft !== state.content; }
  function getMode() { return state.mode; }
  function setMode(m) {
    if (state.destroyed) return;
    if (m !== 'view' && m !== 'edit') return;
    if (m === 'edit') _tveEnterEdit(state);
    else _tveRenderView(state);
  }
  async function refreshContent() {
    if (state.destroyed) return;
    await _tveLoadAndRender(state);
  }

  return { destroy, isDirty, getMode, setMode, refreshContent };
}

function _tveNoopController() {
  return {
    destroy() {},
    isDirty() { return false; },
    getMode() { return 'view'; },
    setMode() {},
    refreshContent() {},
  };
}

async function _tveLoadAndRender(state) {
  state.bodyEl.innerHTML = `<div class="chat-file-viewer-loading">…</div>`;
  state.actionsEl.innerHTML = '';
  try {
    const payload = { path: state.source.absPath };
    if (state.source.cid) payload.cid = state.source.cid;
    if (state.source.projectId) payload.projectId = state.source.projectId;
    const res = await window.orkas.invoke('produced.readText', payload);
    if (state.destroyed) return;
    if (!res || !res.ok) {
      _tveRenderError(state, (res && res.error) || 'read_failed');
      return;
    }
    state.content = String(res.text || '');
    state.draft = state.content;
    if (state.callbacks.onContentLoaded) {
      try { state.callbacks.onContentLoaded(state.content); }
      catch (err) { _tveLog.warn('onContentLoaded threw', err); }
    }
    _tveRender(state);
  } catch (err) {
    if (state.destroyed) return;
    _tveRenderError(state, err && err.message || String(err));
  }
}

function _tveRenderError(state, msg) {
  state.bodyEl.innerHTML = `<div class="chat-file-viewer-loading">${escapeHtml(_tveLabel('contexts.viewer.read_failed', `Failed to read file: ${msg}`, { reason: msg }))}</div>`;
  state.actionsEl.innerHTML = '';
}

function _tveRender(state) {
  if (state.destroyed) return;
  if (state.mode === 'edit') _tveRenderEditor(state);
  else _tveRenderView(state);
}

function _tveTrack() {}

function _tveRenderView(state) {
  state.mode = 'view';
  state.bodyEl.innerHTML = `<pre class="chat-file-viewer-text">${escapeHtml(state.content)}</pre>`;
  const actions = [];
  if (state.caps.edit) actions.push(_tveActionButton(state, 'edit', 'contexts.viewer.edit', 'edit-pencil'));
  state.actionsEl.innerHTML = actions.join('');
  state.actionsEl.querySelector('[data-tve-action="edit"]')?.addEventListener('click', () => { _tveTrack('text_editor_edit', state); _tveEnterEdit(state); });
  _tveEmitDirty(state);
}

function _tveEnterEdit(state) {
  if (!state.caps.edit) return;
  state.mode = 'edit';
  state.draft = state.content;
  _tveRenderEditor(state);
  _tveEmitDirty(state);
}

function _tveRenderEditor(state) {
  // Tab key in the textarea inserts \t instead of moving focus — for code /
  // config files this matters (the alternative — sending tab to focus the
  // next action button — has no point inside a fullscreen editor).
  state.bodyEl.innerHTML = `<textarea class="ctx-viewer-editor" data-tve-textarea spellcheck="false">${escapeHtml(state.draft)}</textarea>`;
  const actions = [];
  if (state.caps.save) {
    actions.push(_tveActionButton(state, 'save', 'contexts.viewer.save', 'check', 'btn-primary'));
    actions.push(_tveActionButton(state, 'cancel', 'contexts.viewer.cancel', 'x'));
  }
  state.actionsEl.innerHTML = actions.join('');
  state.actionsEl.querySelector('[data-tve-action="save"]')?.addEventListener('click', () => { _tveTrack('text_editor_save', state, { chars: (state.draft || '').length }); _tveSave(state); });
  state.actionsEl.querySelector('[data-tve-action="cancel"]')?.addEventListener('click', () => { _tveTrack('text_editor_cancel', state, { dirty: state.draft !== state.content }); _tveCancelEdit(state); });

  const ta = state.bodyEl.querySelector('[data-tve-textarea]');
  if (ta) {
    ta.addEventListener('input', () => {
      state.draft = ta.value;
      _tveEmitDirty(state);
    });
    ta.addEventListener('keydown', (e) => {
      if (e.key === 'Tab') {
        e.preventDefault();
        const start = ta.selectionStart;
        const end = ta.selectionEnd;
        const before = ta.value.slice(0, start);
        const after = ta.value.slice(end);
        ta.value = `${before}\t${after}`;
        ta.selectionStart = ta.selectionEnd = start + 1;
        state.draft = ta.value;
        _tveEmitDirty(state);
      }
    });
    ta.focus();
  }
  _tveEmitDirty(state);
}

function _tveCancelEdit(state) {
  state.draft = state.content;
  _tveRenderView(state);
}

async function _tveSave(state) {
  const ta = state.bodyEl.querySelector('[data-tve-textarea]');
  if (ta) state.draft = ta.value;
  const next = state.draft;
  try {
    const payload = { path: state.source.absPath, content: next };
    if (state.source.cid) payload.cid = state.source.cid;
    if (state.source.projectId) payload.projectId = state.source.projectId;
    const res = await window.orkas.invoke('produced.writeText', payload);
    if (!res || !res.ok) {
      await uiAlert(_tveLabel('contexts.save_failed_with', `Save failed: ${(res && res.error) || 'unknown'}`, { reason: (res && res.error) || 'unknown' }));
      return;
    }
  } catch (err) {
    await uiAlert(_tveLabel('contexts.save_failed_with', `Save failed: ${err && err.message || err}`, { reason: err && err.message || String(err) }));
    return;
  }
  state.content = next;
  _tveRenderView(state);
  if (state.callbacks.onSaved) {
    try { state.callbacks.onSaved(next); }
    catch (err) { _tveLog.warn('onSaved threw', err); }
  }
}

function _tveActionButton(state, action, labelKey, iconName, extraClass) {
  const label = _tveLabel(labelKey, labelKey);
  const cls = `btn btn-sm${state.actionIconOnly ? ' btn-icon ctx-viewer-action-icon-btn' : ''}${extraClass ? ` ${extraClass}` : ''}`;
  if (!state.actionIconOnly) {
    return `<button type="button" class="${cls}" data-tve-action="${action}">${escapeHtml(label)}</button>`;
  }
  const icon = (typeof window !== 'undefined' && typeof window.uiIconHtml === 'function')
    ? window.uiIconHtml(iconName, 'ui-icon ctx-viewer-action-icon')
    : escapeHtml(label);
  return `<button type="button" class="${cls}" data-tve-action="${action}" aria-label="${escapeHtml(label)}" title="${escapeHtml(label)}">${icon}</button>`;
}

function _tveEmitDirty(state) {
  if (state.callbacks.onDirtyChange) {
    try { state.callbacks.onDirtyChange(state.mode === 'edit' && state.draft !== state.content); }
    catch (err) { _tveLog.warn('onDirtyChange threw', err); }
  }
}

// Localized label helper — falls back to the provided English when the
// key is missing. Mirrors chat-file-viewer's `_viewerLabel`.
function _tveLabel(key, fallback, vars) {
  try {
    const v = vars ? t(key, vars) : t(key);
    return v === key ? fallback : v;
  } catch (_) { return fallback; }
}
