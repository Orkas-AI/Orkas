// Memory detail page + import/export flows.
//
// A view over the main-process `features/memory.ts` (channels in
// `ipc/memory.ts`): personal cross-session memory the agents keep about the
// user. TWO kinds — preferences (USER.md, target="user") and facts (MEMORY.md,
// target="memory"). Memory is PERSONAL, not team-shared.
//
// The page (breadcrumb + header + two sections) renders into #memory-page;
// the import/export modals mount into a body overlay. Char limits live in the
// backend and travel in each list response's `usage.limit` — never hardcoded
// here. Stored entries are plain text (no per-entry kind/source in the model),
// so detail cards show text only; the advisory kind pill appears only in the
// import-review step where it's freshly computed by `memory.importParse`.

const _MEM_TARGETS = ['user', 'memory'];
const _MEM_LIMIT_WARN = 0.85; // usage bar turns warn above this fraction

// Last list result per target: { entries:[], usage:{current,limit}, path }.
let _memData = { user: null, memory: null };
// Inline editor state: at most one entry editable at a time.
//   { target, mode:'edit'|'add', oldText? }  — null when no editor open.
let _memEditor = null;

function _memIc(name) {
  return (typeof uiIconHtml === 'function') ? uiIconHtml(name) : '';
}

function _memToast(msg, variant) {
  if (typeof uiToast === 'function') uiToast(msg, { variant: variant || 'info' });
}

function _memTrack(action, data) {
  
}

function _memTrackError(action, data) {
  
}

async function _memInvoke(channel, payload) {
  try {
    const res = await window.orkas.invoke(channel, payload || {});
    if (res && res.ok === false) _memTrackError('memory_ipc_result', { channel, msg: res.error || 'failed' });
    return res || { ok: false, error: 'no response' };
  } catch (err) {
    _memTrackError('memory_ipc', { channel, msg: (err && err.message) || String(err) });
    return { ok: false, error: (err && err.message) || String(err) };
  }
}

// ── Data load ──────────────────────────────────────────────────────────────

async function _memLoad() {
  const [user, mem] = await Promise.all([
    _memInvoke('memory.list', { target: 'user' }),
    _memInvoke('memory.list', { target: 'memory' }),
  ]);
  _memData.user = user && user.ok ? user : { entries: [], usage: { current: 0, limit: 0 }, path: '' };
  _memData.memory = mem && mem.ok ? mem : { entries: [], usage: { current: 0, limit: 0 }, path: '' };
}

// ── Page render ──────────────────────────────────────────────────────────────

async function renderMemoryPage() {
  const host = document.getElementById('memory-page');
  if (!host) return;
  await _memLoad();
  _memRenderInto(host);
}

function _memRenderInto(host) {
  const u = _memData.user || { entries: [], usage: { current: 0, limit: 0 } };
  const m = _memData.memory || { entries: [], usage: { current: 0, limit: 0 } };
  const total = (u.entries || []).length + (m.entries || []).length;

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
        ${_memRenderSection('user', u, 'users', t('memory.section_user'), t('memory.section_user_sub'))}
        ${_memRenderSection('memory', m, 'sparkles', t('memory.section_memory'), t('memory.section_memory_sub'))}
      </div>
    </div>
  `;

  if (typeof window.hydrateUiIcons === 'function') window.hydrateUiIcons(host);
  _memBindPage(host);
}

function _memRenderSection(target, data, iconName, title, sub) {
  const entries = data.entries || [];
  const usage = data.usage || { current: 0, limit: 0 };
  const fileName = target === 'memory' ? 'MEMORY.md' : 'USER.md';
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
        <span class="memory-section-icon">${_memIc(iconName)}</span>
        <h2 class="memory-section-title">${escapeHtml(title)}</h2>
        <span class="memory-section-file">${escapeHtml(fileName)} · ${t('memory.count', { n: entries.length })}</span>
        <span class="memory-flex"></span>
        ${_memRenderUsage(usage)}
        <button type="button" class="memory-icon-btn" data-mem-action="add" data-mem-target="${target}" title="${escapeHtml(t('memory.add_entry'))}">${_memIc('plus')}</button>
      </div>
      <p class="memory-section-sub">${escapeHtml(sub)}</p>
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
        <button type="button" class="memory-icon-btn" data-mem-action="edit" data-mem-target="${target}" data-mem-idx="${idx}" title="${escapeHtml(t('memory.edit'))}">${_memIc('edit-pencil')}</button>
        <button type="button" class="memory-icon-btn is-muted" data-mem-action="delete" data-mem-target="${target}" data-mem-idx="${idx}" title="${escapeHtml(t('memory.delete'))}">${_memIc('x')}</button>
      </div>
    </div>
  `;
}

function _memRenderEditor(target, text) {
  const usage = (_memData[target] && _memData[target].usage) || { current: 0, limit: 0 };
  return `
    <div class="memory-entry is-editing" data-mem-editor="${target}">
      <textarea class="memory-entry-textarea" rows="3">${escapeHtml(text)}</textarea>
      <div class="memory-entry-foot">
        <span class="memory-entry-charcount" data-mem-charcount>${(text || '').length}</span>
        <span class="memory-entry-charlimit muted"> / ${usage.limit || 0}</span>
        <span class="memory-flex"></span>
        <button type="button" class="btn btn-sm" data-mem-action="cancel-edit">${escapeHtml(t('memory.cancel'))}</button>
        <button type="button" class="btn btn-sm btn-primary" data-mem-action="save-edit" data-mem-target="${target}">${escapeHtml(t('memory.save'))}</button>
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
      const text = (_memData[target].entries || [])[Number(idx)];
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
      const text = (_memData[target].entries || [])[Number(idx)];
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
  const editorEl = document.querySelector(`[data-mem-editor="${target}"]`);
  const ta = editorEl && editorEl.querySelector('.memory-entry-textarea');
  if (!ta) return;
  const content = ta.value.trim();
  if (!content) return;
  const isEdit = _memEditor && _memEditor.mode === 'edit';
  const res = isEdit
    ? await _memInvoke('memory.replace', { target, oldText: _memEditor.oldText, content })
    : await _memInvoke('memory.add', { target, content });
  if (!res.ok) {
    _memTrackError('memory_entry_save', { target, mode: isEdit ? 'edit' : 'add', msg: res.error || 'failed' });
    _memToast(_memErrorToText(res.error), 'error');
    return;
  }
  _memTrack('memory_entry_save_ok', { target, mode: isEdit ? 'edit' : 'add', chars: content.length });
  _memEditor = null;
  // Refresh just this target from the op result (it already carries entries+usage).
  _memData[target] = { entries: res.entries || [], usage: res.usage || _memData[target].usage, path: _memData[target].path };
  _memRerender();
}

async function _memDelete(target, text) {
  const ok = (typeof uiConfirm === 'function')
    ? await uiConfirm({ message: t('memory.delete_confirm'), okLabel: t('memory.delete'), cancelLabel: t('memory.cancel') })
    : true;
  if (!ok) return;
  const res = await _memInvoke('memory.remove', { target, oldText: text });
  if (!res.ok) {
    _memTrackError('memory_entry_delete', { target, msg: res.error || 'failed' });
    _memToast(_memErrorToText(res.error), 'error');
    return;
  }
  _memTrack('memory_entry_delete_ok', { target });
  _memData[target] = { entries: res.entries || [], usage: res.usage || _memData[target].usage, path: _memData[target].path };
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
      <button type="button" class="memory-icon-btn is-muted" data-mem-action="modal-close">${_memIc('x')}</button>
    </div>
  `;
}

// ── Import flow ──────────────────────────────────────────────────────────────

let _memImportItems = []; // [{ text, target, kind, threat, keep }]

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
      <input type="file" id="memory-import-file-input" accept=".md,.txt,.json" hidden />
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
  const fileInput = host.querySelector('#memory-import-file-input');
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
      if (which === 'file') fileInput.click();
      else ta.focus();
    });
  });
  fileInput.addEventListener('change', async () => {
    const f = fileInput.files && fileInput.files[0];
    if (!f) return;
    try {
      ta.value = await f.text();
      updateStat();
    } catch (_) {
      _memToast(t('memory.error_generic'), 'error');
    }
  });

  host.querySelector('#memory-import-parse-btn').addEventListener('click', () => _memDoParse(ta.value));
  host.querySelectorAll('[data-mem-action="modal-close"]').forEach((b) => b.addEventListener('click', _memCloseModal));

  if (mode === 'file') fileInput.click();
  else setTimeout(() => ta.focus(), 0);
}

async function _memDoParse(text) {
  if (!text.trim()) { _memToast(t('memory.import_empty'), 'warning'); return; }
  _memTrack('memory_import_parse', { chars: text.length });
  const res = await _memInvoke('memory.importParse', { text });
  if (!res.ok || !Array.isArray(res.items)) { _memTrackError('memory_import_parse', { msg: res.error || 'failed' }); _memToast(t('memory.error_generic'), 'error'); return; }
  if (!res.items.length) { _memToast(t('memory.import_empty'), 'warning'); return; }
  // Flagged items default to unchecked; clean ones checked.
  _memImportItems = res.items.map((it) => ({ ...it, keep: !it.threat }));
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
            <button type="button" class="memory-seg-opt${it.target === 'memory' ? ' is-active' : ''}" data-mem-action="set-target" data-mem-row="${i}" data-mem-target="memory">${escapeHtml(t('memory.kind_group_memory'))}</button>
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
  const nMem = kept.filter((it) => it.target === 'memory').length;
  const summary = host.querySelector('#memory-merge-summary');
  const label = host.querySelector('#memory-merge-label');
  if (summary) summary.textContent = t('memory.merge_summary', { user: nUser, memory: nMem });
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
    const res = await _memInvoke('memory.add', { target: it.target, content: it.text });
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
  const fileRow = (target, name, label) => {
    const f = files[target] || { count: 0, size: 0 };
    return `
      <div class="memory-export-row" data-mem-export="${target}">
        <span class="memory-export-icon">${_memIc('file-text')}</span>
        <div class="memory-export-meta">
          <div class="memory-export-namerow">
            <span class="memory-export-name">${escapeHtml(name)}</span>
            <span class="memory-export-label muted">${escapeHtml(label)}</span>
          </div>
          <div class="memory-export-sub">${t('memory.count', { n: f.count })} · ${_memFmtSize(f.size)}</div>
        </div>
        <button type="button" class="btn btn-sm" data-mem-action="copy" data-mem-target="${target}"><span>${escapeHtml(t('memory.copy_content'))}</span></button>
        <button type="button" class="btn btn-sm" data-mem-action="reveal" data-mem-target="${target}"><span>${escapeHtml(t('memory.reveal_file'))}</span></button>
      </div>
    `;
  };

  const host = _memOpenModal(460, `
    ${_memModalHeader(t('memory.export_title'), '', t('memory.export_sub'))}
    <div class="memory-modal-body memory-export-body">
      ${fileRow('user', 'USER.md', t('memory.kind_group_user'))}
      ${fileRow('memory', 'MEMORY.md', t('memory.kind_group_memory'))}
    </div>
  `);

  host.querySelectorAll('[data-mem-action="modal-close"]').forEach((b) => b.addEventListener('click', _memCloseModal));
  host.querySelectorAll('[data-mem-action="copy"]').forEach((b) => {
    const labelEl = b.querySelector('span');
    const original = labelEl ? labelEl.textContent : '';
    b.addEventListener('click', async () => {
      const target = b.getAttribute('data-mem-target');
      const raw = (files[target] && files[target].raw) || '';
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
    b.addEventListener('click', () => _memInvoke('memory.reveal', { target: b.getAttribute('data-mem-target') }));
  });
}

function _memFmtSize(bytes) {
  const b = Number(bytes) || 0;
  if (b < 1024) return `${b} B`;
  return `${(b / 1024).toFixed(1)} KB`;
}

// ── Wiring ───────────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', () => {
  const card = document.getElementById('memory-entry-card');
  if (card) {
    card.addEventListener('click', () => {
      if (typeof setView === 'function') setView('memory');
    });
  }
  // Fill the entry-card description (with live count) on first paint.
  _memRefreshEntryCount();
});

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
  const [u, m] = await Promise.all([
    _memInvoke('memory.list', { target: 'user' }),
    _memInvoke('memory.list', { target: 'memory' }),
  ]);
  const n = ((u.entries || []).length) + ((m.entries || []).length);
  desc.textContent = t('memory.entry_desc', { n });
}

// Keep the entry-card count fresh when the settings panel is shown.
document.addEventListener('DOMContentLoaded', () => {
  const tabBtn = document.querySelector('[data-settings-tab="data"]');
  if (tabBtn) tabBtn.addEventListener('click', _memRefreshEntryCount);
});
