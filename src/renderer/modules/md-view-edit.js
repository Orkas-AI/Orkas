// ─── Shared markdown viewer/editor ───
// Single implementation behind both knowledge-base file editing (contexts.js)
// and chat-side scratch / generated-md editing (chat-md-drawer.js). Two body
// modes — `view` (renderMarkdown + clickable task lists) and `edit` (textarea
// + markdown toolbar + preview toggle) — and a `source.kind` dispatch table
// for read / write / delete that lets each host plug its own backend in
// without forking the renderer code.
//
// Why this lives in its own module:
//   - the KB pane and the chat drawer have different chrome (file tree vs.
//     drawer header), but the markdown editing surface MUST behave identically
//     (CLAUDE.md §8 reuse rule). Forking the toolbar / keyboard / draft logic
//     across two callers has bitten us before — kept here as one file with
//     parameterized I/O.
//
// API:
//   mountMdViewEdit({ bodyEl, actionsEl, source, capabilities?, initialMode?,
//                     initialContent?, initialDraft?, actionIconOnly?, callbacks? })
//     → { destroy, refreshContent, getMode, setMode, isDirty,
//         getDraft, setDraftAsContent, getSource }
//
//   source: { kind: 'context',   rel: string }
//         | { kind: 'workspace', absPath: string, cid?: string }
//         | { kind: 'ephemeral', initialText: string }
//
// Capabilities default per kind:
//   context   → edit/save/delete/reveal/taskCheckbox = true
//   workspace → edit/save/reveal/taskCheckbox = true; delete = false
//   ephemeral → edit forced (no view); save/delete/reveal = false;
//               actionsEl exposes copyDraft + sendToChatInput instead
//
// What the caller still owns:
//   - the surrounding container (path / title / close chrome). mountMdViewEdit
//     never touches anything outside bodyEl + actionsEl.
//   - cross-mount draft persistence (KB needs per-file survival across file
//     switches; chat doesn't). Pass / consume `initialDraft` + `onDraftChange`.

const _mveLog = createLogger('md-view-edit');

const _MVE_TODO_LINE_RE = /^(\s*)- \[( |x|X)\] (.*)$/;

// Toolbar definition. `kind` keys map to `_mveApplyMd()` cases; SVG icons
// come from icons.js; `label` is the i18n key for the tooltip. Keys are the
// historical `contexts.editor.tb.*` set — kept as-is so the three locales
// don't churn just for a rename. Same goes for `contexts.editor.placeholder.*`
// strings used by `_mveApplyMd`.
const _MVE_EDITOR_TOOLBAR = [
  { kind: 'h1', icon: 'H1', label: 'contexts.editor.tb.h1' },
  { kind: 'h2', icon: 'H2', label: 'contexts.editor.tb.h2' },
  { kind: 'h3', icon: 'H3', label: 'contexts.editor.tb.h3' },
  { kind: 'sep' },
  { kind: 'bold', icon: 'B', label: 'contexts.editor.tb.bold', cls: 'is-bold' },
  { kind: 'italic', icon: 'I', label: 'contexts.editor.tb.italic', cls: 'is-italic' },
  { kind: 'strike', icon: 'S', label: 'contexts.editor.tb.strike', cls: 'is-strike' },
  { kind: 'sep' },
  { kind: 'ul', iconName: 'list', label: 'contexts.editor.tb.ul' },
  { kind: 'ol', iconName: 'list-ordered', label: 'contexts.editor.tb.ol' },
  { kind: 'quote', iconName: 'quote', label: 'contexts.editor.tb.quote' },
  { kind: 'sep' },
  { kind: 'code', iconName: 'code', label: 'contexts.editor.tb.code' },
  { kind: 'codeblock', iconName: 'code-block', label: 'contexts.editor.tb.codeblock' },
  { kind: 'sep' },
  { kind: 'link', iconName: 'link', label: 'contexts.editor.tb.link' },
  { kind: 'image', iconName: 'image', label: 'contexts.editor.tb.image' },
  { kind: 'sep' },
  { kind: 'todo', iconName: 'square', label: 'contexts.editor.tb.todo' },
];

function _mveDefaultCapabilities(kind) {
  if (kind === 'context') {
    return { edit: true, save: true, delete: true, reveal: true, taskCheckbox: true };
  }
  if (kind === 'workspace') {
    return { edit: true, save: true, delete: false, reveal: true, taskCheckbox: true };
  }
  if (kind === 'project-file') {
    return { edit: true, save: true, delete: true, reveal: true, taskCheckbox: true };
  }
  // ephemeral
  return { edit: true, save: false, delete: false, reveal: false, taskCheckbox: false };
}

function mountMdViewEdit(opts) {
  const bodyEl    = opts.bodyEl;
  const actionsEl = opts.actionsEl;
  if (!bodyEl || !actionsEl) {
    _mveLog.warn('mountMdViewEdit called without bodyEl/actionsEl', { hasBody: !!bodyEl, hasActions: !!actionsEl });
    return _mveNoopController();
  }
  const source = opts.source;
  if (!source || typeof source.kind !== 'string') {
    _mveLog.warn('mountMdViewEdit called without source.kind');
    return _mveNoopController();
  }

  const caps = Object.assign(
    _mveDefaultCapabilities(source.kind),
    opts.capabilities || {},
  );
  const callbacks = opts.callbacks || {};

  // ── State ─────────────────────────────────────────────────────────────
  const state = {
    source,
    caps,
    callbacks,
    bodyEl,
    actionsEl,
    actionIconOnly: opts.actionIconOnly === true,
    // Canonical content (from disk / source). Ephemeral seeds this with
    // initialText; the "is dirty" check compares draft vs. this.
    content: '',
    // Modes:
    //   'view' — renderMarkdown of content + (optional) clickable tasks
    //   'edit' — textarea + toolbar (preview is a sub-toggle of edit)
    mode: 'view',
    draft: '',
    preview: false,
    destroyed: false,
    // Suppress an automatic re-render after an external setMode call so the
    // caller can chain `setMode('edit')` then push focus / scroll
    // synchronously without fighting the controller.
    _suppressRender: false,
  };

  // Ephemeral starts in edit mode with the seeded text — no view mode for
  // it (a "view" of pre-loaded text the user is about to mutate would be
  // surprising; the textarea+preview toggle covers the read case).
  if (source.kind === 'ephemeral') {
    state.content = source.initialText || '';
    state.draft = state.content;
    state.mode = 'edit';
  } else if (typeof opts.initialContent === 'string') {
    // Caller (KB) already fetched the content — skip the round-trip.
    state.content = opts.initialContent;
    state.mode = opts.initialMode === 'edit' ? 'edit' : 'view';
  } else {
    state.mode = opts.initialMode === 'edit' ? 'edit' : 'view';
  }

  // Optional inherited draft (KB per-file survival).
  if (opts.initialDraft && typeof opts.initialDraft.content === 'string') {
    state.draft = opts.initialDraft.content;
    state.preview = !!opts.initialDraft.isPreview;
    state.mode = 'edit';
  }

  // Render after first paint. If we're not ephemeral and the caller didn't
  // pre-fill content, fetch it now. Errors land in `_mveRenderError`.
  if (source.kind !== 'ephemeral' && typeof opts.initialContent !== 'string') {
    _mveLoadAndRender(state);
  } else {
    _mveRender(state);
  }

  // ── Controller ────────────────────────────────────────────────────────
  function destroy() {
    state.destroyed = true;
    if (bodyEl) bodyEl.innerHTML = '';
    if (actionsEl) actionsEl.innerHTML = '';
  }

  async function refreshContent() {
    if (state.destroyed) return;
    if (state.source.kind === 'ephemeral') return;
    await _mveLoadAndRender(state);
  }

  function getMode()  { return state.mode; }
  function setMode(m) {
    if (state.destroyed) return;
    if (m !== 'view' && m !== 'edit') return;
    if (m === 'edit') _mveEnterEdit(state);
    else _mveRenderView(state);
  }
  function isDirty()  { return state.mode === 'edit' && state.draft !== state.content; }
  function getDraft() { return { content: state.draft, isPreview: state.preview }; }
  function getSource() { return state.source; }
  /** Update the controller's source descriptor in place. Used when the
   *  host renamed the underlying file out from under us — `state.draft`
   *  / `state.content` stay intact (rename doesn't change bytes), only
   *  the address used by future read/write IPC swaps. Caller is
   *  responsible for surface updates (e.g. the host's path label);
   *  controller doesn't re-render. Without this, saves after an inline
   *  rename hit the backend with the stale path and the user gets a
   *  spurious `not found` alert. */
  function setSource(nextSource) {
    if (state.destroyed) return;
    if (!nextSource || typeof nextSource !== 'object') return;
    state.source = nextSource;
  }

  // Replace the canonical content with the current draft and re-render in
  // view mode. Used by the "send to chat input" flow where the host wants
  // to mark the draft as consumed without persisting it.
  function setDraftAsContent() {
    state.content = state.draft;
    state.mode = 'view';
    state.preview = false;
    _mveRender(state);
  }

  return { destroy, refreshContent, getMode, setMode, isDirty, getDraft, setDraftAsContent, getSource, setSource };
}

function _mveNoopController() {
  return {
    destroy()        {},
    refreshContent() {},
    getMode()        { return 'view'; },
    setMode()        {},
    isDirty()        { return false; },
    getDraft()       { return { content: '', isPreview: false }; },
    setDraftAsContent() {},
    getSource()      { return null; },
    setSource()      {},
  };
}

// ── Source dispatch ──────────────────────────────────────────────────────

async function _mveReadSource(source) {
  if (source.kind === 'ephemeral') {
    return { ok: true, content: source.initialText || '' };
  }
  if (source.kind === 'context') {
    try {
      const res = await apiFetch(`/api/contexts/read?path=${encodeURIComponent(source.rel)}`);
      const data = await res.json();
      if (!data.ok) return { ok: false, error: data.error || 'read_failed' };
      return { ok: true, content: String(data.content || '') };
    } catch (e) {
      return { ok: false, error: e.message || String(e) };
    }
  }
  if (source.kind === 'workspace') {
    try {
      const payload = { path: source.absPath };
      if (source.cid) payload.cid = source.cid;
      if (source.projectId) payload.projectId = source.projectId;
      const res = await window.orkas.invoke('produced.readText', payload);
      if (!res || !res.ok) return { ok: false, error: (res && res.error) || 'read_failed', detail: res };
      return { ok: true, content: String(res.text || '') };
    } catch (e) {
      return { ok: false, error: e.message || String(e) };
    }
  }
  if (source.kind === 'project-file') {
    try {
      const res = await window.orkas.invoke('projects.files.readText', {
        projectId: source.projectId,
        name: source.name,
      });
      if (!res || !res.ok) return { ok: false, error: (res && res.error) || 'read_failed' };
      return { ok: true, content: String(res.content || '') };
    } catch (e) {
      return { ok: false, error: e.message || String(e) };
    }
  }
  return { ok: false, error: 'unknown source kind' };
}

async function _mveWriteSource(source, content) {
  if (source.kind === 'context') {
    try {
      const res = await apiFetch('/api/contexts/update', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: source.rel, content }),
      });
      const data = await res.json();
      if (!data.ok) return { ok: false, error: data.error || 'save_failed' };
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e.message || String(e) };
    }
  }
  if (source.kind === 'workspace') {
    try {
      const payload = { path: source.absPath, content };
      if (source.cid) payload.cid = source.cid;
      if (source.projectId) payload.projectId = source.projectId;
      const res = await window.orkas.invoke('produced.writeText', payload);
      if (!res || !res.ok) return { ok: false, error: (res && res.error) || 'save_failed' };
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e.message || String(e) };
    }
  }
  if (source.kind === 'project-file') {
    try {
      const res = await window.orkas.invoke('projects.files.updateText', {
        projectId: source.projectId,
        name: source.name,
        content,
      });
      if (!res || !res.ok) return { ok: false, error: (res && res.error) || 'save_failed' };
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e.message || String(e) };
    }
  }
  return { ok: false, error: 'source is not writable' };
}

// ── Rendering ────────────────────────────────────────────────────────────

async function _mveLoadAndRender(state) {
  const res = await _mveReadSource(state.source);
  if (state.destroyed) return;
  if (!res.ok) {
    _mveRenderError(state, res.error || 'read_failed');
    return;
  }
  state.content = res.content;
  if (!state.draft) state.draft = state.content;
  if (state.callbacks.onContentLoaded) {
    try { state.callbacks.onContentLoaded(state.content); }
    catch (e) { _mveLog.warn('onContentLoaded threw', e); }
  }
  _mveRender(state);
}

function _mveRender(state) {
  if (state.destroyed) return;
  if (state.mode === 'edit') _mveRenderEditor(state);
  else _mveRenderView(state);
}

function _mveRenderError(state, msg) {
  const body = state.bodyEl;
  body.innerHTML = `<div class="ctx-viewer-msg">${escapeHtml(t('contexts.viewer.read_failed', { reason: msg }) || `Failed to read file: ${msg}`)}</div>`;
  state.actionsEl.innerHTML = '';
}

function _mveActionButton(state, action, labelKey, iconName, extraClass) {
  const label = t(labelKey);
  const cls = `btn btn-sm${state.actionIconOnly ? ' btn-icon ctx-viewer-action-icon-btn' : ''}${extraClass ? ` ${extraClass}` : ''}`;
  if (!state.actionIconOnly) {
    return `<button class="${cls}" data-mve-action="${action}">${escapeHtml(label)}</button>`;
  }
  const icon = (typeof window !== 'undefined' && typeof window.uiIconHtml === 'function')
    ? window.uiIconHtml(iconName, 'ui-icon ctx-viewer-action-icon')
    : escapeHtml(label);
  return `<button type="button" class="${cls}" data-mve-action="${action}" aria-label="${escapeHtml(label)}" title="${escapeHtml(label)}">${icon}</button>`;
}

function _mveTrack(action, state, data) {
  try {
    if (!window.Monitor) return;
    (() => {})(action, Object.assign({
      source: state && state.source ? String(state.source.kind || '') : '',
      can_save: !!(state && state.caps && state.caps.save),
    }, data || {}));
  } catch (_) {}
}

function _mveRenderView(state) {
  state.mode = 'view';
  const bodyEl = state.bodyEl;
  const actionsEl = state.actionsEl;
  const content = state.content || '';
  bodyEl.innerHTML = `<div class="ctx-viewer-md markdown-body">${renderMarkdown(content)}</div>`;
  if (state.caps.taskCheckbox) _mveBindTaskCheckboxes(state, bodyEl);

  const actions = [];
  if (state.caps.edit)   actions.push(_mveActionButton(state, 'edit', 'contexts.viewer.edit', 'edit-pencil'));
  if (state.caps.reveal) actions.push(_mveActionButton(state, 'reveal', 'contexts.viewer.open_system', 'folder-open'));
  if (state.caps.delete) actions.push(_mveActionButton(state, 'delete', 'contexts.viewer.delete', 'trash', 'btn-danger'));
  actionsEl.innerHTML = actions.join('');

  actionsEl.querySelector('[data-mve-action="edit"]')?.addEventListener('click', () => { _mveTrack('markdown_editor_edit', state); _mveEnterEdit(state); });
  actionsEl.querySelector('[data-mve-action="reveal"]')?.addEventListener('click', () => { _mveTrack('markdown_editor_reveal', state); state.callbacks.onReveal?.(); });
  actionsEl.querySelector('[data-mve-action="delete"]')?.addEventListener('click', () => { _mveTrack('markdown_editor_delete', state); state.callbacks.onDelete?.(); });

  _mveEmitDirty(state);
}

function _mveEnterEdit(state) {
  state.mode = 'edit';
  // Only seed the draft from canonical content if we don't have a draft yet
  // — caller-provided initialDraft and prior edit state both reach here.
  if (!state.draft) state.draft = state.content || '';
  _mveRenderEditor(state);
  _mveEmitDirty(state);
}

function _mveRenderEditor(state) {
  const bodyEl = state.bodyEl;
  const actionsEl = state.actionsEl;
  const toolbarHtml = _MVE_EDITOR_TOOLBAR.map(item => {
    if (item.kind === 'sep') return `<span class="ctx-editor-toolbar-sep" aria-hidden="true"></span>`;
    const disabled = state.preview ? 'disabled' : '';
    const extraCls = item.cls ? ` ${item.cls}` : '';
    const icon = item.iconName && typeof window !== 'undefined' && typeof window.uiIconHtml === 'function'
      ? window.uiIconHtml(item.iconName, 'ui-icon ctx-editor-svg-icon')
      : escapeHtml(item.icon || '');
    return `<button type="button" class="btn btn-sm btn-icon ctx-editor-tb-btn${extraCls}" data-kind="${item.kind}" title="${escapeHtml(t(item.label))}" ${disabled}>${icon}</button>`;
  }).join('');
  const toggleKey = state.preview ? 'contexts.editor.tb.edit_back' : 'contexts.editor.tb.preview';
  const toggleIcon = typeof window !== 'undefined' && typeof window.uiIconHtml === 'function'
    ? window.uiIconHtml(state.preview ? 'edit-pencil' : 'eye', 'ui-icon ctx-editor-toggle-icon')
    : '';
  const draft = state.draft;
  const bodyHtml = state.preview
    ? `<div class="ctx-viewer-md markdown-body ctx-editor-preview">${draft.trim() ? renderMarkdown(draft) : `<div class="ctx-viewer-msg">${escapeHtml(t('contexts.editor.preview_empty'))}</div>`}</div>`
    : `<textarea class="ctx-viewer-editor" data-mve-textarea spellcheck="false">${escapeHtml(draft)}</textarea>`;
  bodyEl.innerHTML = `
    <div class="ctx-editor-toolbar" role="toolbar">
      ${toolbarHtml}
      <span class="ctx-editor-toolbar-spacer"></span>
      <button type="button" class="btn btn-sm ctx-editor-toggle" data-mve-toggle title="${escapeHtml(t(toggleKey))}">${toggleIcon}<span>${escapeHtml(t(toggleKey))}</span></button>
    </div>
    <div class="ctx-editor-body">${bodyHtml}</div>
  `;

  // Actions: save/cancel for persisted sources; copy/sendToChat for ephemeral.
  const actions = [];
  if (state.caps.save) {
    actions.push(_mveActionButton(state, 'save', 'contexts.viewer.save', 'check', 'btn-primary'));
    actions.push(_mveActionButton(state, 'cancel', 'contexts.viewer.cancel', 'x'));
  } else if (state.source.kind === 'ephemeral') {
    actions.push(_mveActionButton(state, 'copy-draft', 'chat.md_drawer.copy_draft', 'clipboard-list'));
    actions.push(_mveActionButton(state, 'send-to-chat', 'chat.md_drawer.send_to_chat', 'send', 'btn-primary'));
  }
  actionsEl.innerHTML = actions.join('');

  actionsEl.querySelector('[data-mve-action="save"]')?.addEventListener('click', () => { _mveTrack('markdown_editor_save', state, { chars: (state.draft || '').length }); _mveSave(state); });
  actionsEl.querySelector('[data-mve-action="cancel"]')?.addEventListener('click', () => { _mveTrack('markdown_editor_cancel', state, { dirty: state.draft !== state.content }); _mveCancelEdit(state); });
  actionsEl.querySelector('[data-mve-action="copy-draft"]')?.addEventListener('click', () => { _mveTrack('markdown_editor_copy_draft', state, { chars: (state.draft || '').length }); _mveCopyDraft(state); });
  actionsEl.querySelector('[data-mve-action="send-to-chat"]')?.addEventListener('click', () => { _mveTrack('markdown_editor_send_to_chat', state, { chars: (state.draft || '').length }); _mveSendDraftToChat(state); });

  bodyEl.querySelector('[data-mve-toggle]')?.addEventListener('click', () => { _mveTrack('markdown_editor_preview_toggle', state, { preview: !state.preview }); _mveTogglePreview(state); });
  bodyEl.querySelectorAll('.ctx-editor-tb-btn').forEach(btn => {
    btn.addEventListener('mousedown', (e) => e.preventDefault());
    btn.addEventListener('click', () => {
      if (state.preview) return;
      _mveTrack('markdown_editor_toolbar', state, { tool: btn.dataset.kind || '' });
      const ta = bodyEl.querySelector('[data-mve-textarea]');
      if (!ta) return;
      _mveApplyMd(state, ta, btn.dataset.kind);
    });
  });
  const ta = bodyEl.querySelector('[data-mve-textarea]');
  if (ta) {
    ta.addEventListener('keydown', (e) => _mveOnKey(state, ta, e));
    ta.addEventListener('input', () => {
      state.draft = ta.value;
      _mveEmitDraftChange(state);
      _mveEmitDirty(state);
    });
    ta.focus();
  }

  _mveEmitDirty(state);
}

function _mveCancelEdit(state) {
  state.draft = state.content;
  state.preview = false;
  _mveRenderView(state);
  _mveEmitDraftChange(state, /* cleared = */ true);
  _mveEmitDirty(state);
}

async function _mveSave(state) {
  const ta = state.bodyEl.querySelector('[data-mve-textarea]');
  if (ta) state.draft = ta.value;
  const next = state.draft;
  const res = await _mveWriteSource(state.source, next);
  if (!res.ok) {
    await uiAlert(t('contexts.save_failed_with', { reason: res.error || 'unknown' }));
    return;
  }
  state.content = next;
  state.preview = false;
  _mveRenderView(state);
  _mveEmitDraftChange(state, /* cleared = */ true);
  _mveEmitDirty(state);
  if (state.callbacks.onSaved) {
    try { state.callbacks.onSaved(next); }
    catch (e) { _mveLog.warn('onSaved threw', e); }
  }
}

function _mveTogglePreview(state) {
  const ta = state.bodyEl.querySelector('[data-mve-textarea]');
  if (ta) state.draft = ta.value;
  state.preview = !state.preview;
  _mveEmitDraftChange(state);
  _mveRenderEditor(state);
}

function _mveCopyDraft(state) {
  const ta = state.bodyEl.querySelector('[data-mve-textarea]');
  const text = ta ? ta.value : state.draft;
  navigator.clipboard.writeText(text || '').catch(() => {});
}

function _mveSendDraftToChat(state) {
  const ta = state.bodyEl.querySelector('[data-mve-textarea]');
  const text = (ta ? ta.value : state.draft) || '';
  if (state.callbacks.onSendToChatInput) {
    try { state.callbacks.onSendToChatInput(text); }
    catch (e) { _mveLog.warn('onSendToChatInput threw', e); }
  }
}

// ── Task-checkbox view-mode interactivity ────────────────────────────────

function _mveScanTaskLines(content) {
  const lines = (content || '').split('\n');
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(_MVE_TODO_LINE_RE);
    if (m) out.push({ lineIdx: i, checked: m[2].toLowerCase() === 'x' });
  }
  return out;
}

function _mveBindTaskCheckboxes(state, rootEl) {
  if (!rootEl) return;
  const tasks = _mveScanTaskLines(state.content);
  const boxes = rootEl.querySelectorAll('.task-item input[type="checkbox"]');
  if (boxes.length !== tasks.length) return;
  boxes.forEach((box, i) => {
    box.removeAttribute('disabled');
    const li = box.closest('li.task-item');
    if (tasks[i].checked && li) li.classList.add('is-done');
    box.addEventListener('change', () => _mveToggleTask(state, tasks[i].lineIdx, li, box));
  });
}

async function _mveToggleTask(state, lineIdx, liEl, boxEl) {
  const lines = (state.content || '').split('\n');
  const m = (lines[lineIdx] || '').match(_MVE_TODO_LINE_RE);
  if (!m) return;
  const wasChecked = m[2].toLowerCase() === 'x';
  const nextMark = wasChecked ? ' ' : 'x';
  lines[lineIdx] = `${m[1]}- [${nextMark}] ${m[3]}`;
  const next = lines.join('\n');
  if (liEl) liEl.classList.toggle('is-done', !wasChecked);
  if (boxEl) boxEl.checked = !wasChecked;
  const res = await _mveWriteSource(state.source, next);
  if (!res.ok) {
    if (liEl) liEl.classList.toggle('is-done', wasChecked);
    if (boxEl) boxEl.checked = wasChecked;
    await uiAlert(t('contexts.todo.save_failed', { reason: res.error || 'unknown' }));
    return;
  }
  state.content = next;
}

// ── Toolbar / keyboard operations (textarea selection math) ─────────────

function _mveWrapSelection(state, ta, mark, placeholder) {
  const start = ta.selectionStart;
  let end = ta.selectionEnd;
  const value = ta.value;
  while (end > start && value[end - 1] === '\n') end -= 1;
  const sel = value.slice(start, end);
  const before = value.slice(0, start);
  const after = value.slice(end);
  const markLen = mark.length;
  if (sel.startsWith(mark) && sel.endsWith(mark) && sel.length >= markLen * 2) {
    const inner = sel.slice(markLen, sel.length - markLen);
    _mveReplaceRange(state, ta, start, end, inner, start, start + inner.length);
    return;
  }
  if (before.endsWith(mark) && after.startsWith(mark)) {
    const newStart = start - markLen;
    const newEnd = end + markLen;
    _mveReplaceRange(state, ta, newStart, newEnd, sel, newStart, newStart + sel.length);
    return;
  }
  const inner = sel || placeholder;
  const wrapped = `${mark}${inner}${mark}`;
  const innerStart = start + markLen;
  const innerEnd = innerStart + inner.length;
  _mveReplaceRange(state, ta, start, end, wrapped, innerStart, innerEnd);
}

function _mveLineSpan(value, selStart, selEnd) {
  let effEnd = selEnd;
  if (effEnd > selStart && value[effEnd - 1] === '\n') effEnd -= 1;
  const lineStart = value.lastIndexOf('\n', selStart - 1) + 1;
  let lineEnd = value.indexOf('\n', effEnd);
  if (lineEnd === -1) lineEnd = value.length;
  return { lineStart, lineEnd };
}

function _mveApplyHeading(state, ta, level) {
  const target = '#'.repeat(level) + ' ';
  const value = ta.value;
  const { lineStart, lineEnd } = _mveLineSpan(value, ta.selectionStart, ta.selectionEnd);
  const block = value.slice(lineStart, lineEnd);
  const lines = block.split('\n');
  const stripHeading = (line) => line.replace(/^#{1,6} /, '');
  const isTarget = (line) => line === '' || line.startsWith(target);
  if (lines.every(isTarget)) {
    const rebuilt = lines.map(stripHeading).join('\n');
    _mveReplaceRange(state, ta, lineStart, lineEnd, rebuilt, lineStart, lineStart + rebuilt.length);
    return;
  }
  const rebuilt = lines.map(line => line === '' ? line : `${target}${stripHeading(line)}`).join('\n');
  _mveReplaceRange(state, ta, lineStart, lineEnd, rebuilt, lineStart, lineStart + rebuilt.length);
}

function _mveApplyTodo(state, ta) {
  const value = ta.value;
  const { lineStart, lineEnd } = _mveLineSpan(value, ta.selectionStart, ta.selectionEnd);
  const block = value.slice(lineStart, lineEnd);
  const lines = block.split('\n');
  const placeholder = t('contexts.editor.placeholder.todo');
  const firstNonEmpty = lines.find(l => l.trim().length > 0) || '';
  let mode;
  if (/^(\s*)- \[ \] /.test(firstNonEmpty)) mode = 'check';
  else if (/^(\s*)- \[[xX]\] /.test(firstNonEmpty)) mode = 'strip';
  else mode = 'mark';
  const rebuilt = lines.map(line => {
    if (line.trim().length === 0) return line;
    const indent = (line.match(/^(\s*)/) || ['', ''])[1];
    const rest = line.slice(indent.length);
    if (mode === 'check') {
      const m = rest.match(/^- \[ \] (.*)$/);
      return m ? `${indent}- [x] ${m[1]}` : line;
    }
    if (mode === 'strip') {
      return `${indent}${rest.replace(/^- \[[ xX]\] /, '')}`;
    }
    const body = rest.replace(/^([-*+]|\d+\.) +/, '') || placeholder;
    return `${indent}- [ ] ${body}`;
  }).join('\n');
  _mveReplaceRange(state, ta, lineStart, lineEnd, rebuilt, lineStart, lineStart + rebuilt.length);
}

function _mveLinePrefix(state, ta, prefixFn) {
  const value = ta.value;
  const { lineStart, lineEnd } = _mveLineSpan(value, ta.selectionStart, ta.selectionEnd);
  const block = value.slice(lineStart, lineEnd);
  const lines = block.split('\n');
  const firstPrefix = prefixFn(0);
  const allMatch = lines.every(line => line.length === 0 || line.startsWith(firstPrefix));
  let rebuilt;
  if (allMatch && firstPrefix) {
    rebuilt = lines.map(line => line.startsWith(firstPrefix) ? line.slice(firstPrefix.length) : line).join('\n');
  } else {
    rebuilt = lines.map((line, idx) => `${prefixFn(idx)}${line}`).join('\n');
  }
  _mveReplaceRange(state, ta, lineStart, lineEnd, rebuilt, lineStart, lineStart + rebuilt.length);
}

function _mveInsertBlock(state, ta, opts) {
  const { text, selStart, selEnd } = opts;
  const start = ta.selectionStart;
  const end = ta.selectionEnd;
  _mveReplaceRange(state, ta, start, end, text, start + selStart, start + selEnd);
}

function _mveReplaceRange(state, ta, from, to, replacement, newSelStart, newSelEnd) {
  ta.setRangeText(replacement, from, to, 'preserve');
  ta.selectionStart = newSelStart;
  ta.selectionEnd = newSelEnd;
  state.draft = ta.value;
  _mveEmitDraftChange(state);
  _mveEmitDirty(state);
  ta.focus();
}

function _mveApplyMd(state, ta, kind) {
  switch (kind) {
    case 'bold':      return _mveWrapSelection(state, ta, '**', t('contexts.editor.placeholder.bold'));
    case 'italic':    return _mveWrapSelection(state, ta, '*',  t('contexts.editor.placeholder.italic'));
    case 'strike':    return _mveWrapSelection(state, ta, '~~', t('contexts.editor.placeholder.strike'));
    case 'code':      return _mveWrapSelection(state, ta, '`',  t('contexts.editor.placeholder.code'));
    case 'h1':        return _mveApplyHeading(state, ta, 1);
    case 'h2':        return _mveApplyHeading(state, ta, 2);
    case 'h3':        return _mveApplyHeading(state, ta, 3);
    case 'quote':     return _mveLinePrefix(state, ta, () => '> ');
    case 'ul':        return _mveLinePrefix(state, ta, () => '- ');
    case 'ol':        return _mveLinePrefix(state, ta, (i) => `${i + 1}. `);
    case 'todo':      return _mveApplyTodo(state, ta);
    case 'codeblock': {
      const start = ta.selectionStart, end = ta.selectionEnd;
      const sel = ta.value.slice(start, end);
      const body = sel || t('contexts.editor.placeholder.code');
      const before = ta.value.slice(0, start);
      const after = ta.value.slice(end);
      const leadNl = before.length === 0 || before.endsWith('\n\n') ? '' : (before.endsWith('\n') ? '\n' : '\n\n');
      const tailNl = after.length === 0 || after.startsWith('\n\n') ? '' : (after.startsWith('\n') ? '\n' : '\n\n');
      const text = `${leadNl}\`\`\`\n${body}\n\`\`\`${tailNl}`;
      const innerStart = start + leadNl.length + 4; // after ```\n
      const innerEnd = innerStart + body.length;
      return _mveInsertBlock(state, ta, { text, selStart: innerStart - start, selEnd: innerEnd - start });
    }
    case 'link': {
      const start = ta.selectionStart, end = ta.selectionEnd;
      const sel = ta.value.slice(start, end);
      const linkText = sel || t('contexts.editor.placeholder.link_text');
      const url = t('contexts.editor.placeholder.link_url');
      const text = `[${linkText}](${url})`;
      const urlStart = 1 + linkText.length + 2; // after "[text]("
      const urlEnd = urlStart + url.length;
      return _mveInsertBlock(state, ta, { text, selStart: urlStart, selEnd: urlEnd });
    }
    case 'image': {
      const start = ta.selectionStart, end = ta.selectionEnd;
      const sel = ta.value.slice(start, end);
      const alt = sel || t('contexts.editor.placeholder.image_alt');
      const url = t('contexts.editor.placeholder.image_url');
      const text = `![${alt}](${url})`;
      const urlStart = 2 + alt.length + 2;
      const urlEnd = urlStart + url.length;
      return _mveInsertBlock(state, ta, { text, selStart: urlStart, selEnd: urlEnd });
    }
  }
}

function _mveParseListPrefix(line) {
  const m = line.match(/^(\s*)([-*+]|\d+\.)(\s+)/);
  if (!m) return null;
  return { indent: m[1], marker: m[2], gap: m[3], total: m[0] };
}

function _mveOnKey(state, ta, e) {
  // IME composition guard (CLAUDE.md §8).
  if (e.isComposing || e.keyCode === 229) return;

  const mod = e.metaKey || e.ctrlKey;
  if (mod && !e.shiftKey && !e.altKey) {
    const k = (e.key || '').toLowerCase();
    if (k === 'b') { e.preventDefault(); return _mveApplyMd(state, ta, 'bold'); }
    if (k === 'i') { e.preventDefault(); return _mveApplyMd(state, ta, 'italic'); }
    if (k === 'k') { e.preventDefault(); return _mveApplyMd(state, ta, 'link'); }
    if (k === 's' && state.caps.save) { e.preventDefault(); return _mveSave(state); }
  }

  if (e.key === 'Tab') {
    e.preventDefault();
    const start = ta.selectionStart;
    const end = ta.selectionEnd;
    const value = ta.value;
    const multiLine = value.slice(start, end).includes('\n');
    if (multiLine) {
      const { lineStart, lineEnd } = _mveLineSpan(value, start, end);
      const block = value.slice(lineStart, lineEnd);
      const lines = block.split('\n');
      let rebuilt;
      if (e.shiftKey) {
        rebuilt = lines.map(l => l.replace(/^( {1,2}|\t)/, '')).join('\n');
      } else {
        rebuilt = lines.map(l => `  ${l}`).join('\n');
      }
      _mveReplaceRange(state, ta, lineStart, lineEnd, rebuilt, lineStart, lineStart + rebuilt.length);
      return;
    }
    if (e.shiftKey) {
      const lineStart = value.lastIndexOf('\n', start - 1) + 1;
      const head = value.slice(lineStart, lineStart + 2);
      const strip = head === '  ' ? 2 : (head[0] === '\t' ? 1 : 0);
      if (strip) {
        const newStart = Math.max(lineStart, start - strip);
        _mveReplaceRange(state, ta, lineStart, lineStart + strip, '', newStart, Math.max(newStart, end - strip));
      }
      return;
    }
    _mveReplaceRange(state, ta, start, end, '  ', start + 2, start + 2);
    return;
  }

  if (e.key === 'Enter') {
    const value = ta.value;
    const start = ta.selectionStart;
    const end = ta.selectionEnd;
    if (start !== end) return;
    const lineStart = value.lastIndexOf('\n', start - 1) + 1;
    const lineSoFar = value.slice(lineStart, start);
    const parsed = _mveParseListPrefix(lineSoFar);
    if (!parsed) return;
    if (lineSoFar === parsed.total) {
      e.preventDefault();
      _mveReplaceRange(state, ta, lineStart, start, '', lineStart, lineStart);
      return;
    }
    e.preventDefault();
    let nextMarker = parsed.marker;
    if (/^\d+\.$/.test(parsed.marker)) {
      const n = parseInt(parsed.marker, 10);
      nextMarker = `${n + 1}.`;
    }
    const insert = `\n${parsed.indent}${nextMarker}${parsed.gap}`;
    _mveReplaceRange(state, ta, start, start, insert, start + insert.length, start + insert.length);
    return;
  }
}

function mountMarkdownToolbarForTextarea(opts = {}) {
  const toolbarEl = typeof opts.toolbarEl === 'string'
    ? document.getElementById(opts.toolbarEl)
    : opts.toolbarEl;
  const ta = typeof opts.textarea === 'string'
    ? document.getElementById(opts.textarea)
    : opts.textarea;
  if (!toolbarEl || !ta) return { destroy() {} };

  const state = {
    source: { kind: 'composer' },
    caps: { save: false },
    callbacks: {
      onDraftChange: () => { if (typeof opts.onChange === 'function') opts.onChange(ta.value); },
      onDirtyChange: () => {},
    },
    content: ta.value || '',
    draft: ta.value || '',
    preview: false,
    mode: 'edit',
  };

  const syncSelection = () => {
    try {
      if (typeof getChatRichComposerSelection === 'function') getChatRichComposerSelection(ta);
    } catch (_) {}
  };
  const syncEditor = () => {
    state.draft = ta.value || '';
    try {
      if (typeof syncChatRichComposerFromTextarea === 'function') syncChatRichComposerFromTextarea(ta);
      if (typeof focusChatRichComposer === 'function' && focusChatRichComposer(ta)) return;
    } catch (_) {}
    try { ta.focus(); } catch (_) {}
  };
  const apply = (kind) => {
    if (!kind) return;
    syncSelection();
    state.draft = ta.value || '';
    _mveApplyMd(state, ta, kind);
    syncEditor();
  };
  const onKeydown = (e) => {
    syncSelection();
    state.draft = ta.value || '';
    _mveOnKey(state, ta, e);
    if (e.defaultPrevented) syncEditor();
  };
  let shortcutTarget = null;
  const bindShortcutTarget = () => {
    const editor = typeof getChatRichComposerEditor === 'function'
      ? getChatRichComposerEditor(ta)
      : null;
    const target = editor || ta;
    if (!target || target === shortcutTarget) return;
    if (shortcutTarget) shortcutTarget.removeEventListener('keydown', onKeydown);
    shortcutTarget = target;
    target.addEventListener('keydown', onKeydown);
  };
  const render = () => {
    toolbarEl.innerHTML = _MVE_EDITOR_TOOLBAR.map(item => {
      if (item.kind === 'sep') return `<span class="ctx-editor-toolbar-sep" aria-hidden="true"></span>`;
      const extraCls = item.cls ? ` ${item.cls}` : '';
      const icon = item.iconName && typeof window !== 'undefined' && typeof window.uiIconHtml === 'function'
        ? window.uiIconHtml(item.iconName, 'ui-icon ctx-editor-svg-icon')
        : escapeHtml(item.icon || '');
      return `<button type="button" class="btn btn-sm btn-icon ctx-editor-tb-btn${extraCls}" data-kind="${item.kind}" title="${escapeHtml(t(item.label))}">${icon}</button>`;
    }).join('');
    toolbarEl.querySelectorAll('.ctx-editor-tb-btn').forEach((btn) => {
      btn.addEventListener('mousedown', (e) => e.preventDefault());
      btn.addEventListener('click', () => apply(btn.dataset.kind || ''));
    });
    bindShortcutTarget();
  };

  const onInput = () => { state.draft = ta.value || ''; };
  const onI18n = () => render();
  ta.addEventListener('input', onInput);
  window.addEventListener('i18n-change', onI18n);
  render();

  return {
    destroy() {
      ta.removeEventListener('input', onInput);
      if (shortcutTarget) shortcutTarget.removeEventListener('keydown', onKeydown);
      window.removeEventListener('i18n-change', onI18n);
      toolbarEl.innerHTML = '';
    },
  };
}

if (typeof window !== 'undefined') {
  window.mountMarkdownToolbarForTextarea = mountMarkdownToolbarForTextarea;
}

// ── Callback emission helpers ────────────────────────────────────────────

function _mveEmitDirty(state) {
  if (!state.callbacks.onDirtyChange) return;
  try { state.callbacks.onDirtyChange(state.mode === 'edit' && state.draft !== state.content); }
  catch (e) { _mveLog.warn('onDirtyChange threw', e); }
}

function _mveEmitDraftChange(state, cleared = false) {
  if (!state.callbacks.onDraftChange) return;
  try {
    state.callbacks.onDraftChange(
      cleared ? null : { content: state.draft, isPreview: state.preview }
    );
  } catch (e) { _mveLog.warn('onDraftChange threw', e); }
}

// CommonJS bridge for unit tests (CLAUDE.md §9 testability exception).
if (typeof module !== 'undefined' && typeof module.exports === 'object') {
  module.exports = {
    _mveScanTaskLines,
    _MVE_TODO_LINE_RE,
  };
}
