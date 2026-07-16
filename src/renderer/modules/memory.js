// Memory detail page + import/export flows.
//
// A view over the main-process `features/memory.ts` (channels in
// `ipc/memory.ts`): cross-session memory surfaced in Settings. This page shows
// user profile (USER.md, scope "user") and global shared notes (MEMORY.md,
// scope "shared"). Per-agent memory still exists for agent detail/runtime, but
// is intentionally not shown here.
//
// Char limits live in the backend and travel in each list response's
// `usage.limit` — never hardcoded here. Stored entries are plain text.

const _MEM_LIMIT_WARN = 0.85; // usage bar turns warn above this fraction

// Ordered scope descriptors for the current render:
//   { key, kind:'user'|'shared', title, sub, icon }
let _memScopes = [];
// Last list result per scope-key: { entries:[], usage:{current,limit}, path }.
let _memData = {};
// Inline editor state: at most one entry editable at a time.
//   { target /* scope-key */, mode:'edit'|'add', oldText? } — null when closed.
let _memEditor = null;

function _memIc(name, className) {
  return (typeof uiIconHtml === 'function') ? uiIconHtml(name, className) : '';
}

function _memToast(msg, variant) {
  if (typeof uiToast === 'function') uiToast(msg, { variant: variant || 'info' });
}

function _memTrack(action, data) {
  try { if (window.Monitor) (() => {})(action, data || {}); } catch (_) {}
}

function _memTrackError(action, data) {
  try { if (window.Monitor) (() => {})(action, data || {}); } catch (_) {}
}

async function _memInvoke(channel, payload) {
  if (!window.orkas || typeof window.orkas.invoke !== 'function') {
    return { ok: false, error: 'ipc bridge unavailable' };
  }

  try {
    const res = await window.orkas.invoke(channel, payload || {});
    if (res && res.ok === false) _memTrackError('memory_ipc_result', { channel, msg: res.error || 'failed' });
    return res || { ok: false, error: 'no response' };
  } catch (err) {
    _memTrackError('memory_ipc', { channel, msg: (err && err.message) || String(err) });
    return { ok: false, error: (err && err.message) || String(err) };
  }
}

// ── Scope plumbing ───────────────────────────────────────────────────────────

// A scope-key ('user' | 'shared') → the IPC payload the backend expects.
// 'memory' (legacy) is accepted as 'shared'.
function _memParseScope(key) {
  if (key === 'user') return { target: 'user' };
  return { target: 'shared' }; // 'shared' | 'memory' | default
}

function _memScopePayload(key, extra) {
  return Object.assign({}, _memParseScope(key), extra || {});
}

// ── Data load ──────────────────────────────────────────────────────────────

async function _memLoad() {
  _memScopes = [
    { key: 'user', kind: 'user', title: t('memory.section_user'), sub: t('memory.section_user_sub'), icon: 'users' },
    { key: 'shared', kind: 'shared', title: t('memory.section_shared'), sub: t('memory.section_shared_sub'), icon: 'sparkles' },
  ];

  const results = await Promise.all(_memScopes.map((s) => _memInvoke('memory.list', _memParseScope(s.key))));
  _memData = {};
  _memScopes.forEach((s, i) => {
    const r = results[i];
    _memData[s.key] = (r && r.ok) ? r : { entries: [], usage: { current: 0, limit: 0 }, path: '' };
  });
}

// ── Page render ──────────────────────────────────────────────────────────────

async function renderMemoryPage() {
  const host = document.getElementById('memory-page');
  if (!host) return;
  await _memLoad();
  _memRenderInto(host);
}

function _memRenderInto(host) {
  let total = 0;
  _memScopes.forEach((s) => { total += ((_memData[s.key] && _memData[s.key].entries) || []).length; });

  const sections = [];
  _memScopes.forEach((s) => {
    const data = _memData[s.key] || { entries: [], usage: { current: 0, limit: 0 } };
    sections.push(_memRenderSection(s, data));
  });

  host.innerHTML = `
    <div class="memory-detail-header">
      <div class="memory-detail-title-row">
        <button type="button" class="btn btn-sm memory-back-btn" data-mem-action="back">${escapeHtml(t('common.back'))}</button>
        <div class="memory-detail-main">
          <div class="memory-detail-name-row">
            <h1 class="memory-detail-title">${escapeHtml(t('memory.title'))}</h1>
            <span class="memory-detail-count">${t('memory.count', { n: total })}</span>
          </div>
          <p class="memory-detail-desc">${escapeHtml(t('memory.page_desc'))}</p>
        </div>
        <div class="memory-detail-actions">
          <button type="button" class="btn btn-sm" data-mem-action="open-export">${_memIc('external')}<span>${escapeHtml(t('memory.export'))}</span></button>
          <button type="button" class="btn btn-sm btn-primary" data-mem-action="open-import">${_memIc('plus')}<span>${escapeHtml(t('memory.import'))}</span></button>
        </div>
      </div>
    </div>

    <div class="memory-scroll o-scroll">
      <div class="memory-col">
        ${sections.join('')}
      </div>
    </div>
  `;

  if (typeof window.hydrateUiIcons === 'function') window.hydrateUiIcons(host);
  _memBindPage(host);
}

function _memRenderSection(scope, data) {
  const target = scope.key;
  const entries = data.entries || [];
  const usage = data.usage || { current: 0, limit: 0 };
  const fileName = scope.kind === 'user' ? 'USER.md' : 'MEMORY.md';
  const rows = [];

  // "Add" inline editor at the top of the section when adding here.
  if (_memEditor && _memEditor.target === target && _memEditor.mode === 'add') {
    rows.push(_memRenderEditor(target, ''));
  }
  entries.forEach((text, idx) => {
    const editing = _memEditor && _memEditor.target === target
      && _memEditor.mode === 'edit' && _memEditor.oldText === text;
    rows.push(editing ? _memRenderEditor(target, text) : _memRenderEntry(target, text, idx));
  });
  if (!entries.length && !(rows.length)) {
    rows.push(`<div class="memory-empty muted">${escapeHtml(t('memory.section_empty'))}</div>`);
  }

  return `
    <div class="memory-section">
      <div class="memory-section-head">
        <span class="memory-section-icon">${_memIc(scope.icon)}</span>
        <h2 class="memory-section-title">${escapeHtml(scope.title)}</h2>
        <span class="memory-section-file">${escapeHtml(fileName)} · ${t('memory.count', { n: entries.length })}</span>
        <span class="memory-flex"></span>
        ${_memRenderUsage(usage)}
        <button type="button" class="memory-icon-btn" data-mem-action="add" data-mem-target="${escapeHtml(target)}" title="${escapeHtml(t('memory.add_entry'))}">${_memIc('plus')}</button>
      </div>
      <p class="memory-section-sub">${escapeHtml(scope.sub)}</p>
      ${rows.join('')}
    </div>
  `;
}

function _memRenderUsage(usage) {
  const limit = usage.limit || 0;
  const current = usage.current || 0;
  const pct = limit > 0 ? Math.min(100, Math.round((100 * current) / limit)) : 0;
  const warn = limit > 0 && current / limit > _MEM_LIMIT_WARN;
  return `
    <span class="memory-usage${warn ? ' is-warn' : ''}">
      <span class="memory-usage-track"><span class="memory-usage-fill" style="width:${pct}%"></span></span>
      <span class="memory-usage-text">${current} / ${limit}</span>
    </span>
  `;
}

function _memRenderEntry(target, text, idx) {
  return `
    <div class="memory-entry">
      <div class="memory-entry-text">${escapeHtml(text)}</div>
      <div class="memory-entry-foot">
        <span class="memory-flex"></span>
        <button type="button" class="memory-icon-btn" data-mem-action="edit" data-mem-target="${escapeHtml(target)}" data-mem-idx="${idx}" title="${escapeHtml(t('memory.edit'))}">${_memIc('edit-pencil')}</button>
        <button type="button" class="memory-icon-btn is-muted" data-mem-action="delete" data-mem-target="${escapeHtml(target)}" data-mem-idx="${idx}" title="${escapeHtml(t('memory.delete'))}">${_memIc('x')}</button>
      </div>
    </div>
  `;
}

function _memRenderEditor(target, text) {
  const usage = (_memData[target] && _memData[target].usage) || { current: 0, limit: 0 };
  return `
    <div class="memory-entry is-editing" data-mem-editor="${escapeHtml(target)}">
      <textarea class="memory-entry-textarea" rows="3">${escapeHtml(text)}</textarea>
      <div class="memory-entry-foot">
        <span class="memory-entry-charcount" data-mem-charcount>${(text || '').length}</span>
        <span class="memory-entry-charlimit muted"> / ${usage.limit || 0}</span>
        <span class="memory-flex"></span>
        <button type="button" class="btn btn-sm" data-mem-action="cancel-edit">${escapeHtml(t('memory.cancel'))}</button>
        <button type="button" class="btn btn-sm btn-primary" data-mem-action="save-edit" data-mem-target="${escapeHtml(target)}">${escapeHtml(t('memory.save'))}</button>
      </div>
    </div>
  `;
}

// ── Page events ──────────────────────────────────────────────────────────────

function _memBindPage(host) {
  host.querySelectorAll('[data-mem-action]').forEach((el) => {
    el.addEventListener('click', _memOnPageAction);
  });
  // Live char count + limit guard on the open editor.
  const ta = host.querySelector('.memory-entry-textarea');
  if (ta) {
    const editorEl = ta.closest('[data-mem-editor]');
    const target = editorEl && editorEl.getAttribute('data-mem-editor');
    const countEl = editorEl && editorEl.querySelector('[data-mem-charcount]');
    const saveBtn = editorEl && editorEl.querySelector('[data-mem-action="save-edit"]');
    const sync = () => {
      const len = ta.value.length;
      if (countEl) countEl.textContent = String(len);
      const over = _memWouldOverflow(target, ta.value);
      if (countEl) countEl.classList.toggle('is-over', over);
      if (saveBtn) saveBtn.disabled = over || !ta.value.trim();
    };
    ta.addEventListener('input', sync);
    sync();
    // preventScroll: the editor is already in view (scroll is preserved across
    // the rerender) — focusing must not yank the page to the textarea.
    try { ta.focus({ preventScroll: true }); } catch (_) { ta.focus(); }
    // place caret at end
    try { ta.setSelectionRange(ta.value.length, ta.value.length); } catch (_) { /* noop */ }
  }
}

// Soft pre-check mirroring saveEntries' tail-drop: would this op push the
// section over its limit? Uses backend-reported usage (no hardcoded limit /
// separator); the separator delta on add is ignored — backend is authoritative
// and truncates anyway, this only drives the disabled-save affordance.
function _memWouldOverflow(target, newText) {
  const data = _memData[target];
  if (!data || !data.usage || !data.usage.limit) return false;
  const limit = data.usage.limit;
  const current = data.usage.current || 0;
  const oldLen = (_memEditor && _memEditor.mode === 'edit') ? (_memEditor.oldText || '').length : 0;
  const projected = current - oldLen + (newText || '').length;
  return projected > limit;
}

async function _memOnPageAction(e) {
  const el = e.currentTarget;
  const action = el.getAttribute('data-mem-action');
  const target = el.getAttribute('data-mem-target');
  const idx = el.getAttribute('data-mem-idx');

  switch (action) {
    case 'back':
      _memTrack('memory_back_settings');
      if (typeof setView === 'function') setView('settings');
      return;
    case 'open-import':
      _memTrack('memory_import_open', { mode: 'paste' });
      _memOpenImport('paste');
      return;
    case 'open-export':
      _memTrack('memory_export_open');
      _memOpenExport();
      return;
    case 'add':
      _memTrack('memory_entry_add_start', { target });
      _memEditor = { target, mode: 'add' };
      _memRerender();
      return;
    case 'edit': {
      const text = ((_memData[target] && _memData[target].entries) || [])[Number(idx)];
      if (text === undefined) return;
      _memTrack('memory_entry_edit_start', { target, idx: Number(idx) });
      _memEditor = { target, mode: 'edit', oldText: text };
      _memRerender();
      return;
    }
    case 'cancel-edit':
      _memTrack('memory_entry_edit_cancel', { target: _memEditor && _memEditor.target, mode: _memEditor && _memEditor.mode });
      _memEditor = null;
      _memRerender();
      return;
    case 'save-edit':
      _memTrack('memory_entry_save_click', { target, mode: _memEditor && _memEditor.mode });
      await _memSaveEditor(target);
      return;
    case 'delete': {
      const text = ((_memData[target] && _memData[target].entries) || [])[Number(idx)];
      if (text === undefined) return;
      _memTrack('memory_entry_delete_click', { target, idx: Number(idx) });
      await _memDelete(target, text);
      return;
    }
    default:
      return;
  }
}

function _memRerender() {
  const host = document.getElementById('memory-page');
  if (!host) return;
  // Preserve scroll across the full innerHTML rewrite — without this, opening /
  // saving / deleting an entry snaps the page back to the top.
  const prev = host.querySelector('.memory-scroll');
  const scrollTop = prev ? prev.scrollTop : 0;
  _memRenderInto(host);
  const next = host.querySelector('.memory-scroll');
  if (next) next.scrollTop = scrollTop;
}

async function _memSaveEditor(target) {
  const editorEl = document.querySelector(`[data-mem-editor="${CSS.escape(target)}"]`);
  const ta = editorEl && editorEl.querySelector('.memory-entry-textarea');
  if (!ta) return;
  const content = ta.value.trim();
  if (!content) return;
  const isEdit = _memEditor && _memEditor.mode === 'edit';
  const res = isEdit
    ? await _memInvoke('memory.replace', _memScopePayload(target, { oldText: _memEditor.oldText, content }))
    : await _memInvoke('memory.add', _memScopePayload(target, { content }));
  if (!res.ok) {
    _memTrackError('memory_entry_save', { target, mode: isEdit ? 'edit' : 'add', msg: res.error || 'failed' });
    _memToast(_memErrorToText(res.error), 'error');
    return;
  }
  _memTrack('memory_entry_save_ok', { target, mode: isEdit ? 'edit' : 'add', chars: content.length });
  _memEditor = null;
  // Refresh just this scope from the op result (it already carries entries+usage).
  const prev = _memData[target] || {};
  _memData[target] = { entries: res.entries || [], usage: res.usage || prev.usage, path: prev.path };
  _memRerender();
}

async function _memDelete(target, text) {
  const ok = (typeof uiConfirm === 'function')
    ? await uiConfirm({ message: t('memory.delete_confirm'), okLabel: t('memory.delete'), cancelLabel: t('memory.cancel') })
    : true;
  if (!ok) return;
  const res = await _memInvoke('memory.remove', _memScopePayload(target, { oldText: text }));
  if (!res.ok) {
    _memTrackError('memory_entry_delete', { target, msg: res.error || 'failed' });
    _memToast(_memErrorToText(res.error), 'error');
    return;
  }
  _memTrack('memory_entry_delete_ok', { target });
  const prev = _memData[target] || {};
  _memData[target] = { entries: res.entries || [], usage: res.usage || prev.usage, path: prev.path };
  _memRerender();
}

// Map the backend's English `{ok:false, error}` to a localized toast.
function _memErrorToText(error) {
  const e = String(error || '');
  if (/^blocked/i.test(e)) return t('memory.blocked_injection');
  if (/empty content/i.test(e)) return t('memory.error_empty');
  return t('memory.error_generic');
}

// ── Modal shell ──────────────────────────────────────────────────────────────

function _memCloseModal() {
  const host = document.getElementById('memory-modal-host');
  if (host) host.remove();
}

function _memOpenModal(width, innerHtml) {
  _memCloseModal();
  const host = document.createElement('div');
  host.id = 'memory-modal-host';
  host.className = 'memory-modal-overlay';
  host.innerHTML = `<div class="memory-modal" style="width:${width}px" role="dialog" aria-modal="true">${innerHtml}</div>`;
  document.body.appendChild(host);
  if (typeof window.hydrateUiIcons === 'function') window.hydrateUiIcons(host);
  // Esc close. Backdrop clicks are ignored to avoid accidental dismissals.
  const onKey = (e) => {
    if (e.key === 'Escape') { _memCloseModal(); document.removeEventListener('keydown', onKey); }
  };
  document.addEventListener('keydown', onKey);
  return host;
}

function _memModalHeader(title, step, sub) {
  return `
    <div class="memory-modal-head">
      <div class="memory-modal-head-main">
        <div class="memory-modal-head-titlerow">
          <h2 class="memory-modal-title">${escapeHtml(title)}</h2>
          ${step ? `<span class="memory-modal-step">${escapeHtml(step)}</span>` : ''}
        </div>
        ${sub ? `<p class="memory-modal-sub">${escapeHtml(sub)}</p>` : ''}
      </div>
      <button type="button" class="modal-close-btn" data-mem-action="modal-close" title="${escapeHtml(t('common.close'))}" aria-label="${escapeHtml(t('common.close'))}">${_memIc('x', 'modal-close-icon')}</button>
    </div>
  `;
}

// ── Import flow (user + shared only; per-agent seeding is done inline) ─────────

let _memImportItems = []; // [{ text, target:'user'|'shared', kind, threat, keep }]

function _memOpenImport(mode) {
  const host = _memOpenModal(560, `
    ${_memModalHeader(t('memory.import_title'), '1 / 2', t('memory.import_step1_sub'))}
    <div class="memory-modal-body">
      <div class="memory-import-tabs">
        <button type="button" class="memory-tab is-active" data-mem-import-tab="paste">${escapeHtml(t('memory.import_paste'))}</button>
        <button type="button" class="memory-tab" data-mem-import-tab="file">${escapeHtml(t('memory.import_file'))}</button>
        <span class="memory-flex"></span>
        <span class="memory-import-formats muted">${escapeHtml(t('memory.import_formats'))}</span>
      </div>
      <textarea class="memory-import-textarea" id="memory-import-text" placeholder="${escapeHtml(t('memory.import_placeholder'))}"></textarea>
    </div>
    <div class="memory-modal-foot">
      <span class="memory-import-stat muted" id="memory-import-stat"></span>
      <span class="memory-flex"></span>
      <button type="button" class="btn btn-sm" data-mem-action="modal-close">${escapeHtml(t('memory.cancel'))}</button>
      <button type="button" class="btn btn-sm btn-primary" id="memory-import-parse-btn">${escapeHtml(t('memory.parse'))}</button>
    </div>
  `);

  const ta = host.querySelector('#memory-import-text');
  const stat = host.querySelector('#memory-import-stat');
  const updateStat = () => {
    const v = ta.value;
    const lines = v.trim() ? v.trim().split(/\n+/).length : 0;
    stat.textContent = t('memory.import_stat', { lines, chars: v.length });
  };
  ta.addEventListener('input', updateStat);
  updateStat();

  host.querySelectorAll('[data-mem-import-tab]').forEach((tab) => {
    tab.addEventListener('click', () => {
      const which = tab.getAttribute('data-mem-import-tab');
      _memTrack('memory_import_mode', { mode: which });
      host.querySelectorAll('[data-mem-import-tab]').forEach((tt) => tt.classList.toggle('is-active', tt === tab));
      if (which === 'file') _memPickImportFile(ta, updateStat);
      else ta.focus();
    });
  });

  host.querySelector('#memory-import-parse-btn').addEventListener('click', () => _memDoParse(ta.value));
  host.querySelectorAll('[data-mem-action="modal-close"]').forEach((b) => b.addEventListener('click', _memCloseModal));

  if (mode === 'file') _memPickImportFile(ta, updateStat);
  else setTimeout(() => ta.focus(), 0);
}

async function _memPickImportFile(ta, updateStat) {
  try {
    const res = await window.orkas.invoke('common.pickFiles', {
      title: t('memory.import_file'),
      extensions: ['md', 'txt', 'json'],
      multiple: false,
    });
    const file = res && Array.isArray(res.files) ? res.files[0] : null;
    if (!file) return;
    ta.value = _memDecodeBase64Text(file.dataBase64 || '');
    updateStat();
  } catch (_) {
    _memToast(t('memory.error_generic'), 'error');
  }
}

function _memDecodeBase64Text(b64) {
  const bin = atob(String(b64 || ''));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder('utf-8').decode(bytes);
}

async function _memDoParse(text) {
  if (!text.trim()) { _memToast(t('memory.import_empty'), 'warning'); return; }
  _memTrack('memory_import_parse', { chars: text.length });
  const res = await _memInvoke('memory.importParse', { text });
  if (!res.ok || !Array.isArray(res.items)) { _memTrackError('memory_import_parse', { msg: res.error || 'failed' }); _memToast(t('memory.error_generic'), 'error'); return; }
  if (!res.items.length) { _memToast(t('memory.import_empty'), 'warning'); return; }
  // Flagged items default to unchecked; clean ones checked. The backend
  // classifier emits 'memory'|'user' — normalize 'memory' → 'shared'.
  _memImportItems = res.items.map((it) => ({
    ...it,
    target: it.target === 'user' ? 'user' : 'shared',
    keep: !it.threat,
  }));
  _memOpenImportReview();
}

function _memOpenImportReview() {
  const flagged = _memImportItems.filter((it) => it.threat).length;
  const bannerClean = flagged === 0;
  const banner = bannerClean
    ? `<div class="memory-safety-banner is-clean">${_memIc('check-circle')}<span>${escapeHtml(t('memory.safety_clean', { n: _memImportItems.length }))}</span></div>`
    : `<div class="memory-safety-banner is-flagged">${_memIc('warning')}<span>${escapeHtml(t('memory.safety_flagged', { n: flagged }))}</span></div>`;

  const rows = _memImportItems.map((it, i) => _memRenderImportRow(it, i)).join('');

  const host = _memOpenModal(620, `
    ${_memModalHeader(t('memory.review_title'), '2 / 2', t('memory.review_sub'))}
    <div class="memory-modal-body">
      ${banner}
      ${rows}
    </div>
    <div class="memory-modal-foot">
      <span class="memory-import-stat" id="memory-merge-summary"></span>
      <span class="memory-flex"></span>
      <button type="button" class="btn btn-sm" id="memory-review-back">${escapeHtml(t('memory.back'))}</button>
      <button type="button" class="btn btn-sm btn-primary" id="memory-review-merge"><span id="memory-merge-label"></span></button>
    </div>
  `);

  _memBindImportReview(host);
  _memUpdateMergeSummary(host);
}

function _memRenderImportRow(it, i) {
  const kindLabel = t('memory.kind_' + (it.kind || '').replace(/-/g, '_'));
  const threatLabel = it.threat ? t('memory.threat_' + it.threat.replace(/-/g, '_')) : '';
  return `
    <div class="memory-import-row${it.keep ? '' : ' is-off'}${it.threat ? ' is-threat' : ''}" data-mem-row="${i}">
      <button type="button" class="memory-check${it.keep ? ' is-on' : ''}" data-mem-action="toggle-keep" data-mem-row="${i}" aria-pressed="${it.keep}">${it.keep ? _memIc('check') : ''}</button>
      <div class="memory-import-row-body">
        <div class="memory-import-row-text">${escapeHtml(it.text)}</div>
        <div class="memory-import-row-meta">
          <div class="memory-seg" role="group">
            <button type="button" class="memory-seg-opt${it.target === 'user' ? ' is-active' : ''}" data-mem-action="set-target" data-mem-row="${i}" data-mem-target="user">${escapeHtml(t('memory.kind_group_user'))}</button>
            <button type="button" class="memory-seg-opt${it.target === 'shared' ? ' is-active' : ''}" data-mem-action="set-target" data-mem-row="${i}" data-mem-target="shared">${escapeHtml(t('memory.kind_group_shared'))}</button>
          </div>
          ${kindLabel ? `<span class="memory-kind-pill">${escapeHtml(kindLabel)}</span>` : ''}
          ${threatLabel ? `<span class="memory-threat-pill">${escapeHtml(threatLabel)}</span>` : ''}
        </div>
      </div>
    </div>
  `;
}

function _memBindImportReview(host) {
  host.querySelectorAll('[data-mem-action="toggle-keep"]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const i = Number(btn.getAttribute('data-mem-row'));
      _memTrack('memory_import_toggle_keep', { row: i, keep: !_memImportItems[i].keep });
      _memImportItems[i].keep = !_memImportItems[i].keep;
      _memOpenImportReview(); // re-render keeps state simple
    });
  });
  host.querySelectorAll('[data-mem-action="set-target"]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const i = Number(btn.getAttribute('data-mem-row'));
      _memTrack('memory_import_set_target', { row: i, target: btn.getAttribute('data-mem-target') });
      _memImportItems[i].target = btn.getAttribute('data-mem-target');
      _memOpenImportReview();
    });
  });
  host.querySelectorAll('[data-mem-action="modal-close"]').forEach((b) => b.addEventListener('click', _memCloseModal));
  host.querySelector('#memory-review-back').addEventListener('click', () => {
    _memTrack('memory_import_back');
    _memOpenImport('paste');
  });
  host.querySelector('#memory-review-merge').addEventListener('click', () => {
    _memTrack('memory_import_merge_click', { kept: _memImportItems.filter((it) => it.keep).length });
    _memDoMerge();
  });
}

function _memUpdateMergeSummary(host) {
  const kept = _memImportItems.filter((it) => it.keep);
  const nUser = kept.filter((it) => it.target === 'user').length;
  const nShared = kept.filter((it) => it.target === 'shared').length;
  const summary = host.querySelector('#memory-merge-summary');
  const label = host.querySelector('#memory-merge-label');
  if (summary) summary.textContent = t('memory.merge_summary', { user: nUser, memory: nShared });
  if (label) label.textContent = ' ' + t('memory.merge_action', { n: kept.length });
  const mergeBtn = host.querySelector('#memory-review-merge');
  if (mergeBtn) mergeBtn.disabled = kept.length === 0;
}

async function _memDoMerge() {
  const kept = _memImportItems.filter((it) => it.keep);
  if (!kept.length) return;
  let added = 0;
  let failed = 0;
  for (const it of kept) {
    // it.target is 'user' | 'shared' (a scope-key the backend accepts directly).
    const res = await _memInvoke('memory.add', _memScopePayload(it.target, { content: it.text }));
    if (res.ok) added++;
    else failed++;
  }
  _memCloseModal();
  if (added) _memToast(t('memory.merge_done', { n: added }), 'success');
  if (failed) _memToast(t('memory.merge_partial', { n: failed }), 'warning');
  _memTrack('memory_import_merge_done', { added, failed });
  await renderMemoryPage();
}

// ── Export flow ──────────────────────────────────────────────────────────────

async function _memOpenExport() {
  const info = await _memInvoke('memory.exportInfo', {});
  if (!info.ok || !info.files) { _memToast(t('memory.error_generic'), 'error'); return; }
  const files = info.files;

  // Each export row carries its scope-key + a raw-text payload, looked up by id.
  const rawByScope = {};
  const row = (scopeKey, f, name, label) => {
    rawByScope[scopeKey] = (f && f.raw) || '';
    return `
      <div class="memory-export-row" data-mem-export="${escapeHtml(scopeKey)}">
        <span class="memory-export-icon">${_memIc('file-text')}</span>
        <div class="memory-export-meta">
          <div class="memory-export-namerow">
            <span class="memory-export-name">${escapeHtml(name)}</span>
            <span class="memory-export-label muted">${escapeHtml(label)}</span>
          </div>
          <div class="memory-export-sub">${t('memory.count', { n: (f && f.count) || 0 })} · ${_memFmtSize((f && f.size) || 0)}</div>
        </div>
        <button type="button" class="btn btn-sm" data-mem-action="copy" data-mem-target="${escapeHtml(scopeKey)}"><span>${escapeHtml(t('memory.copy_content'))}</span></button>
        <button type="button" class="btn btn-sm" data-mem-action="reveal" data-mem-target="${escapeHtml(scopeKey)}"><span>${escapeHtml(t('memory.reveal_file'))}</span></button>
      </div>
    `;
  };

  const host = _memOpenModal(460, `
    ${_memModalHeader(t('memory.export_title'), '', t('memory.export_sub'))}
    <div class="memory-modal-body memory-export-body">
      ${row('user', files.user, t('memory.section_user'), t('memory.kind_group_user'))}
      ${row('shared', files.shared, t('memory.section_shared'), t('memory.kind_group_shared'))}
    </div>
  `);

  host.querySelectorAll('[data-mem-action="modal-close"]').forEach((b) => b.addEventListener('click', _memCloseModal));
  host.querySelectorAll('[data-mem-action="copy"]').forEach((b) => {
    const labelEl = b.querySelector('span');
    const original = labelEl ? labelEl.textContent : '';
    b.addEventListener('click', async () => {
      const scopeKey = b.getAttribute('data-mem-target');
      const raw = rawByScope[scopeKey] || '';
      // Inline feedback (not a toast) — the toast host sits below this modal,
      // so a copy-success toast would be occluded. Swap the button label.
      let ok = true;
      try {
        await navigator.clipboard.writeText(raw);
      } catch (_) {
        ok = false;
      }
      if (labelEl) labelEl.textContent = ok ? t('memory.copied_inline') : t('memory.copy_failed');
      b.classList.add(ok ? 'is-copied' : 'is-copy-failed');
      setTimeout(() => {
        if (labelEl) labelEl.textContent = original;
        b.classList.remove('is-copied', 'is-copy-failed');
      }, 1600);
    });
  });
  host.querySelectorAll('[data-mem-action="reveal"]').forEach((b) => {
    b.addEventListener('click', () => _memInvoke('memory.reveal', _memParseScope(b.getAttribute('data-mem-target'))));
  });
}

function _memFmtSize(bytes) {
  const b = Number(bytes) || 0;
  if (b < 1024) return `${b} B`;
  return `${(b / 1024).toFixed(1)} KB`;
}

// ── Wiring ───────────────────────────────────────────────────────────────────

function _memInitSettingsEntry() {
  const card = document.getElementById('memory-entry-card');
  if (card && card.dataset.bound !== '1') {
    card.dataset.bound = '1';
    card.addEventListener('click', () => {
      if (typeof setView === 'function') setView('memory');
    });
  }
  // Fill the entry-card description (with live count) on first paint.
  _memRefreshEntryCount();

  const tabBtn = document.querySelector('[data-settings-tab="data"]');
  if (tabBtn && tabBtn.dataset.memoryBound !== '1') {
    tabBtn.dataset.memoryBound = '1';
    tabBtn.addEventListener('click', _memRefreshEntryCount);
  }
}

// This module is normally loaded lazily after DOMContentLoaded. Bind
// immediately in that case; retain the event path for eager/test loading.
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', _memInitSettingsEntry, { once: true });
} else {
  _memInitSettingsEntry();
}

// Re-render the page + close any open modal on language switch so dynamic copy
// follows the active language (static data-i18n is handled by applyDomI18n).
window.addEventListener('i18n-change', () => {
  _memCloseModal();
  const panel = document.getElementById('panel-memory');
  if (panel && panel.classList.contains('active')) renderMemoryPage();
  // Refresh the entry-card count regardless (it lives in the settings pane).
  _memRefreshEntryCount();
});

async function _memRefreshEntryCount() {
  const desc = document.getElementById('memory-entry-desc');
  if (!desc) return;
  // Settings memory count mirrors this page: user + global shared only.
  const info = await _memInvoke('memory.exportInfo', {});
  let n = 0;
  if (info && info.ok && info.files) {
    n += (info.files.user && info.files.user.count) || 0;
    n += (info.files.shared && info.files.shared.count) || 0;
  }
  desc.textContent = t('memory.entry_desc', { n });
}
