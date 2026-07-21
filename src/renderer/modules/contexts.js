const _contextsLog = createLogger('contexts');
// ─── Library (contexts) ───
// Single user-owned directory tree at `<uid>/cloud/contexts/`.
// Mutations (write / upload / mkdir / rename / delete) hit the backend directly;
// the backend enqueues `kb_indexer` jobs that produce status transitions
// broadcast back to the UI via `/api/kb/events/stream` (chips update live).

let _ctxTree = [];                  // tree of {name, path, type:'dir'|'file', children?, bytes?, mtime?}
let _ctxExpanded = new Set();       // dir paths that are open
let _ctxSelected = new Set();       // file-system style row selection (single / Cmd-Ctrl / Shift range)
let _ctxSelectionAnchor = null;     // last selected visible row for Shift range
let _ctxActive = null;              // {id} — currently opened file in right-pane
let _ctxMveController = null;       // active mountMdViewEdit controller for the right-pane md viewer
let _ctxOfficeBlobUrl = null;       // object URL for the current sandboxed Office preview iframe
let _ctxPendingRename = null;       // {path} — flagged for inline-rename on the
                                    // next renderCtxTree() (set by the "new
                                    // text file" action after creating an
                                    // untitled file so the user can rename
                                    // immediately, and by the ⋯ menu's
                                    // "rename" item).
let _kbStatusByPath = {};           // {[path]: {status, chunks?, error?, kind?}}
let _kbUnavailableCode = '';
let _kbUnavailableReportedCode = '';
let _kbEventsAbort = null;
let _kbStatusRefreshTimer = null;
let _kbReconcileInFlight = false;
const CTX_INTERNAL_DRAG_TYPE = 'application/x-context-path';

function _ctxUiIconHtml(name, className) {
  if (typeof window !== 'undefined' && typeof window.uiIconHtml === 'function') {
    return window.uiIconHtml(name, className);
  }
  return '';
}

async function loadContexts() {
  try {
    const [treeRes, kbRes] = await Promise.all([
      apiFetch('/api/contexts/tree'),
      apiFetch('/api/kb/status'),
    ]);
    const treeData = await treeRes.json();
    const kbData = await kbRes.json().catch(() => ({ ok: false }));
    if (treeData.ok !== false) _ctxTree = treeData.tree || [];
    if (_applyKbStatusResult(kbData)) _kbStatusByPath = _buildKbStatusMap(_ctxTree, kbData.files || []);
    renderCtxTree();
    _ensureKbEventSubscription();
    _kickKbReconcileIfNeeded();
    _scheduleKbStatusRefreshIfNeeded();
  } catch (e) {
    _contextsLog.error('load contexts failed', e);
  }
}

function _buildKbStatusMap(tree, statusRows) {
  const next = {};
  for (const f of statusRows || []) {
    if (!f || !f.path) continue;
    next[f.path] = {
      status: f.status, chunks: f.chunks, error: f.error, kind: f.kind,
    };
  }
  // Any file that's physically on disk (tree) but not yet in kb_files is
  // either newly synced/dropped in or waiting behind the indexer queue. Mark
  // it pending, then the reconcile + snapshot refresh loop below will either
  // start the job or clear the chip once the DB says ready.
  for (const p of _collectCtxFilePaths(tree)) {
    if (!next[p]) next[p] = { status: 'pending' };
  }
  return next;
}

function _applyKbStatusResult(data) {
  if (data && data.ok) {
    _kbUnavailableCode = '';
    _kbUnavailableReportedCode = '';
    return true;
  }
  const code = String((data && data.code) || 'E_LIBRARY_STATUS_UNAVAILABLE').slice(0, 80);
  _kbUnavailableCode = code;
  if (_kbUnavailableReportedCode !== code) {
    _kbUnavailableReportedCode = code;
  }
  return false;
}

function _hasActiveKbStatuses() {
  return Object.values(_kbStatusByPath || {}).some((st) =>
    st && (st.status === 'pending' || st.status === 'processing'));
}

function _kickKbReconcileIfNeeded() {
  if (_kbReconcileInFlight || !_hasActiveKbStatuses()) return;
  _kbReconcileInFlight = true;
  apiFetch('/api/kb/reconcile', { method: 'POST' })
    .then(() => _refreshKbStatusSnapshot())
    .catch((err) => _contextsLog.warn('kb reconcile failed', err))
    .finally(() => {
      _kbReconcileInFlight = false;
      _scheduleKbStatusRefreshIfNeeded();
    });
}

async function _refreshKbStatusSnapshot() {
  const res = await apiFetch('/api/kb/status');
  const data = await res.json().catch(() => ({ ok: false }));
  if (!_applyKbStatusResult(data)) {
    renderCtxTree();
    return;
  }
  _kbStatusByPath = _buildKbStatusMap(_ctxTree, data.files || []);
  renderCtxTree();
}

function _scheduleKbStatusRefreshIfNeeded() {
  if (_kbStatusRefreshTimer || !_hasActiveKbStatuses()) return;
  if (typeof currentView !== 'undefined' && currentView !== 'contexts') return;
  _kbStatusRefreshTimer = setTimeout(async () => {
    _kbStatusRefreshTimer = null;
    if (typeof currentView !== 'undefined' && currentView !== 'contexts') return;
    try { await _refreshKbStatusSnapshot(); }
    catch (err) { _contextsLog.warn('kb status refresh failed', err); }
    if (_hasActiveKbStatuses()) {
      _kickKbReconcileIfNeeded();
      _scheduleKbStatusRefreshIfNeeded();
    }
  }, 2000);
}

// ── KB event subscription ──
// Single long-lived stream; each server event updates one path's chip in
// place. Cleaned up automatically when the renderer goes away (ipcMain sees
// sender destroyed and aborts).
function _ensureKbEventSubscription() {
  if (_kbEventsAbort) return;
  const controller = new AbortController();
  _kbEventsAbort = controller;
  (async () => {
    try {
      const res = await apiFetch('/api/kb/events/stream', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
        signal: controller.signal,
      });
      if (!res.ok || !res.body) throw new Error('kb events stream rejected');
      const reader = res.body.getReader();
      const decoder = new TextDecoder('utf-8');
      let buffer = '';
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let idx;
        while ((idx = buffer.indexOf('\n\n')) >= 0) {
          const raw = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);
          const dataLines = raw.split('\n')
            .filter(l => l.startsWith('data:'))
            .map(l => l.slice(5).trimStart());
          if (!dataLines.length) continue;
          try {
            const msg = JSON.parse(dataLines.join('\n'));
            if (msg && msg.type === 'event' && msg.event) _applyKbEvent(msg.event);
          } catch { /* malformed event — skip */ }
        }
      }
    } catch (err) {
      if (!controller.signal.aborted) _contextsLog.warn('kb events stream dropped', err);
    } finally {
      const wasAborted = controller.signal.aborted;
      _kbEventsAbort = null;
      if (!wasAborted) {
        setTimeout(() => {
          if (!_kbEventsAbort) loadContexts();
        }, 1000);
      }
    }
  })();
}

function _applyKbEvent(ev) {
  const p = ev.relPath;
  if (!p) return;
  if (ev.status === 'deleted') {
    delete _kbStatusByPath[p];
  } else {
    _kbStatusByPath[p] = {
      status: ev.status,
      ...(ev.chunks != null ? { chunks: ev.chunks } : {}),
      ...(ev.error ? { error: ev.error } : {}),
      ...(ev.kind ? { kind: ev.kind } : {}),
    };
  }
  // Minimal-churn update: find the single DOM row by path and replace its
  // chip in place. Falls back to a full re-render only if the row isn't on
  // screen (collapsed parent dir, etc.).
  const row = document.querySelector(`.contexts-tree .ctx-tree-wrap[data-path="${_cssEscape(p)}"] > .skill-tree-node`);
  if (row) {
    const existing = row.querySelector('.ctx-kb-chip');
    const html = _kbStatusChipHtml(p);
    if (existing) {
      if (html) existing.outerHTML = html;
      else existing.remove();
    } else if (html) {
      const menuBtn = row.querySelector('.ctx-row-menu-btn');
      if (menuBtn) menuBtn.insertAdjacentHTML('beforebegin', html);
    }
  } else {
    renderCtxTree();
  }
  _scheduleKbStatusRefreshIfNeeded();
}

function _trackKbVectorizeEvent(relPath, ev) {
  if (!window.Monitor || !ev || !ev.status) return;
  if (ev.status === 'pending' || ev.status === 'processing') {
    if (!_kbVectorizeStartedAtByPath.has(relPath)) _kbVectorizeStartedAtByPath.set(relPath, performance.now());
    return;
  }
  if (ev.status !== 'ready' && ev.status !== 'failed') return;
  const startedAt = _kbVectorizeStartedAtByPath.get(relPath);
  _kbVectorizeStartedAtByPath.delete(relPath);
  const payload = {
    result: ev.status === 'ready' ? 'success' : 'failure',
    file_ext: _ctxExtOf(relPath),
    file_type: ev.kind || _kindOfPath(relPath),
    chunk_count: Number(ev.chunks || 0),
    duration_ms: startedAt ? Math.round(performance.now() - startedAt) : 0,
  };
  try { (() => {})('library_vectorize_result', payload); } catch (_) {}
  if (ev.status === 'failed') {
    try {
      (() => {})('library_vectorize', {
        file_ext: payload.file_ext,
        file_type: payload.file_type,
        error_message: ev.error || 'unknown',
      });
    } catch (_) {}
  }
}

function _cssEscape(s) {
  return String(s).replace(/(["\\])/g, '\\$1');
}

function _ctxFormatMtime(mtime) {
  const n = Number(mtime);
  if (!Number.isFinite(n) || n <= 0) return '';
  const ms = n > 100000000000 ? n : n * 1000;
  try {
    const locale = (typeof getLocaleMeta === 'function' && typeof getLang === 'function')
      ? getLocaleMeta(getLang()).intlLocale
      : undefined;
    return new Intl.DateTimeFormat(locale, {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).format(new Date(ms));
  } catch (_) {
    return new Date(ms).toLocaleString();
  }
}

function _kbStatusChipHtml(relpath) {
  const st = _kbStatusByPath[relpath];
  if (!st) return '';
  if (st.status === 'ready') return '';
  if (st.status === 'processing' || st.status === 'pending') {
    const label = st.status === 'pending' ? t('contexts.kb.pending') : t('contexts.kb.processing');
    return `<span class="ctx-kb-chip is-processing" title="${escapeHtml(label)}"><span class="ctx-kb-spinner"></span></span>`;
  }
  if (st.status === 'failed') {
    return `<span class="ctx-kb-chip is-failed" data-kb-reprocess title="${escapeHtml(t('contexts.kb.failed'))}">!</span>`;
  }
  return '';
}

// Walk `_ctxTree` (or subtree) and collect every file path. Used by
// `loadContexts` to seed missing kb statuses for freshly-uploaded files.
function _collectCtxFilePaths(nodes, out = []) {
  for (const n of nodes || []) {
    if (n.type === 'file') out.push(n.path);
    else if (n.children) _collectCtxFilePaths(n.children, out);
  }
  return out;
}

function _collectCtxEntryPaths(nodes, out = []) {
  for (const node of nodes || []) {
    if (!node?.path) continue;
    out.push(node.path);
    if (node.type === 'dir') _collectCtxEntryPaths(node.children || [], out);
  }
  return out;
}

// ── Tree render ──

// Total file count across the tree — drives the new Surface D page-header
// count + tree-column count chips. Cheap O(n) walk over the in-memory tree.
function _ctxTotalFiles() {
  try { return _collectCtxFilePaths(_ctxTree).length; } catch (_) { return 0; }
}

function _sortCtxNodes(nodes) {
  return (nodes || []).slice().sort((a, b) => {
    const aDir = a?.type === 'dir';
    const bDir = b?.type === 'dir';
    if (aDir !== bDir) return aDir ? -1 : 1;
    return String(a?.name || '').localeCompare(String(b?.name || ''), undefined, {
      sensitivity: 'base',
      numeric: true,
    });
  });
}

function _ctxFileIconHtml(name) {
  if (typeof window !== 'undefined' && typeof window.fileKindIconHtml === 'function') {
    return window.fileKindIconHtml(name);
  }
  return _ctxUiIconHtml('file', 'skill-tree-node-svg');
}

function _refreshCtxCounts() {
  const n = _ctxTotalFiles();
  const treeEl = document.getElementById('contexts-tree-count');
  if (treeEl) treeEl.textContent = n > 0 ? String(n) : '';
}

function _kbUnavailableHtml() {
  if (!_kbUnavailableCode) return '';
  const key = _kbUnavailableCode === 'E_STORAGE_FULL'
    ? 'contexts.kb.storage_full'
    : 'contexts.kb.unavailable';
  return `<div class="lazy-feature-error ctx-kb-unavailable">
    <span>${escapeHtml(t(key))}</span>
    <button type="button" class="btn btn-sm" data-kb-status-retry>${escapeHtml(t('chat.retry_btn'))}</button>
  </div>`;
}

function _bindKbUnavailableRetry(container) {
  if (!container || typeof container.querySelector !== 'function') return;
  const button = container.querySelector('[data-kb-status-retry]');
  if (!button) return;
  button.addEventListener('click', async () => {
    button.disabled = true;
    try { await _refreshKbStatusSnapshot(); }
    finally { if (button.isConnected) button.disabled = false; }
  });
}

function renderCtxTree() {
  const container = document.getElementById('contexts-tree');
  if (!container) {
    _refreshCtxCounts();
    return;
  }
  if (!_ctxTree.length) {
    _ctxSelected.clear();
    _ctxSelectionAnchor = null;
    container.innerHTML = `${_kbUnavailableHtml()}<div class="empty">${escapeHtml(t('contexts.empty'))}</div>`;
    // The root remains a valid destination even before the first file exists.
    // Binding here lets users populate an empty Library by dragging files in
    // from Finder / Explorer instead of having to use the upload menu first.
    _bindCtxTreeHandlers(container);
    _bindKbUnavailableRetry(container);
    _refreshCtxCounts();
    _renderCtxBatchBar();
    return;
  }
  const existing = new Set(_collectCtxEntryPaths(_ctxTree));
  for (const rel of Array.from(_ctxSelected)) {
    if (!existing.has(rel)) _ctxSelected.delete(rel);
  }
  if (_ctxSelectionAnchor && !existing.has(_ctxSelectionAnchor)) _ctxSelectionAnchor = null;
  container.innerHTML = `${_kbUnavailableHtml()}${_renderCtxNodes(_ctxTree)}`;
  _bindCtxTreeHandlers(container);
  _bindKbUnavailableRetry(container);
  _refreshCtxCounts();
  _renderCtxBatchBar();
}

function _renderCtxNodes(nodes, depth = 0) {
  const indent = 10 + depth * 14;
  const moreTitle = escapeHtml(t('contexts.menu.more_actions'));
  return _sortCtxNodes(nodes).map(n => {
    const isPendingRename = _ctxPendingRename && _ctxPendingRename.path === n.path;
    if (n.type === 'dir') {
      const open = _ctxExpanded.has(n.path);
      const selected = _ctxSelected.has(n.path) ? ' is-selected' : '';
      const caretCls = open ? 'skill-tree-caret' : 'skill-tree-caret collapsed';
      const icon = open
        ? _ctxUiIconHtml('folder-open', 'skill-tree-node-svg')
        : _ctxUiIconHtml('folder', 'skill-tree-node-svg');
      const childrenHtml = open
        ? `<div class="skill-tree-children">${_renderCtxNodes(n.children || [], depth + 1)}</div>`
        : '';
      const labelHtml = isPendingRename
        ? `<input class="ctx-tree-rename-input" type="text" value="${escapeHtml(n.name)}" autocomplete="off" spellcheck="false" />`
        : `<span class="skill-tree-label">${escapeHtml(n.name)}</span>`;
      return `
        <div class="ctx-tree-wrap" data-path="${escapeHtml(n.path)}" data-type="dir" draggable="true">
          <div class="skill-tree-node skill-tree-dir${selected}" style="padding-left:${indent}px" title="${escapeHtml(n.path)}">
            <span class="${caretCls}"></span>
            <span class="skill-tree-icon icon-folder">${icon}</span>
            ${labelHtml}
            <button type="button" class="ctx-row-menu-btn" data-menu title="${moreTitle}" aria-label="${moreTitle}">${_ctxUiIconHtml('more-horizontal', 'ctx-row-menu-icon')}</button>
          </div>
          ${childrenHtml}
        </div>
      `;
    }
    const active = _ctxActive && _ctxActive.id === n.path ? ' active' : '';
    const selected = _ctxSelected.has(n.path) ? ' is-selected' : '';
    const ext = (n.name.split('.').pop() || '').toLowerCase();
    const chip = _kbStatusChipHtml(n.path);
    // Inline-rename mode for a freshly-created "untitled.md" or for the rename
    // menu item — the label becomes an input autofocused with the stem
    // selected. Committed on Enter / blur; Esc keeps the file as-is. See
    // `_bindCtxTreeHandlers` for the handlers.
    const mtime = _ctxFormatMtime(n.mtime);
    const labelHtml = isPendingRename
      ? `<input class="ctx-tree-rename-input" type="text" value="${escapeHtml(n.name)}" autocomplete="off" spellcheck="false" />`
      : `<span class="skill-tree-main"><span class="skill-tree-label">${escapeHtml(n.name)}</span>${mtime ? `<span class="skill-tree-meta">${escapeHtml(mtime)}</span>` : ''}</span>`;
    return `
      <div class="ctx-tree-wrap" data-path="${escapeHtml(n.path)}" data-type="file" draggable="true">
        <div class="skill-tree-node skill-tree-file${active}${selected}" data-ext="${escapeHtml(ext)}" style="padding-left:${indent}px" title="${escapeHtml(n.path)}">
          <span class="skill-tree-caret skill-tree-caret-empty"></span>
          <span class="skill-tree-icon icon-file" data-ext="${escapeHtml(ext)}">${_ctxFileIconHtml(n.name)}</span>
          ${labelHtml}
          ${chip}
          <button type="button" class="ctx-row-menu-btn" data-menu title="${moreTitle}" aria-label="${moreTitle}">${_ctxUiIconHtml('more-horizontal', 'ctx-row-menu-icon')}</button>
        </div>
      </div>
    `;
  }).join('');
}

function _syncCtxSelectionDom(container) {
  (container || document.getElementById('contexts-tree'))?.querySelectorAll('.ctx-tree-wrap[data-path]').forEach((wrap) => {
    wrap.querySelector(':scope > .skill-tree-node')?.classList.toggle('is-selected', _ctxSelected.has(wrap.dataset.path));
  });
  _renderCtxBatchBar();
}

function _selectCtxEntry(rel, event, container) {
  const toggle = !!(event?.metaKey || event?.ctrlKey);
  const range = !!event?.shiftKey;
  if (range && _ctxSelectionAnchor) {
    const visible = Array.from(container.querySelectorAll('.ctx-tree-wrap[data-path]'))
      .filter((wrap) => wrap.offsetParent !== null)
      .map((wrap) => wrap.dataset.path);
    const start = visible.indexOf(_ctxSelectionAnchor);
    const end = visible.indexOf(rel);
    if (start >= 0 && end >= 0) {
      if (!toggle) _ctxSelected.clear();
      const [lo, hi] = start <= end ? [start, end] : [end, start];
      for (const path of visible.slice(lo, hi + 1)) _ctxSelected.add(path);
    }
  } else if (toggle) {
    if (_ctxSelected.has(rel)) _ctxSelected.delete(rel);
    else _ctxSelected.add(rel);
    _ctxSelectionAnchor = rel;
  } else {
    _ctxSelected.clear();
    _ctxSelected.add(rel);
    _ctxSelectionAnchor = rel;
  }
  _syncCtxSelectionDom(container);
  return toggle || range;
}

function _ctxSelectionFor(rel) {
  if (_ctxSelected.has(rel)) return Array.from(_ctxSelected);
  _ctxSelected.clear();
  _ctxSelected.add(rel);
  _ctxSelectionAnchor = rel;
  _syncCtxSelectionDom();
  return [rel];
}

function _renderCtxBatchBar() {
  const host = document.getElementById('contexts-tree-col');
  if (!host) return;
  let bar = document.getElementById('contexts-batch-bar');
  if (_ctxSelected.size < 2) {
    bar?.remove();
    return;
  }
  if (!bar) {
    bar = document.createElement('div');
    bar.id = 'contexts-batch-bar';
    bar.className = 'library-batch-bar';
    host.appendChild(bar);
  }
  bar.innerHTML = `
    <span class="library-batch-count">${escapeHtml(t('contexts.transfer.selected_count', { count: _ctxSelected.size }))}</span>
    <button type="button" class="btn btn-sm btn-primary" data-library-batch-organize>${escapeHtml(t('contexts.transfer.title'))}</button>
    <button type="button" class="library-batch-clear" data-library-batch-clear title="${escapeHtml(t('contexts.transfer.clear_selection'))}" aria-label="${escapeHtml(t('contexts.transfer.clear_selection'))}">${_ctxUiIconHtml('x', 'library-batch-clear-icon')}</button>
  `;
  bar.querySelector('[data-library-batch-organize]')?.addEventListener('click', () => _openCtxTransfer(Array.from(_ctxSelected), 'batch'));
  bar.querySelector('[data-library-batch-clear]')?.addEventListener('click', () => {
    _ctxSelected.clear();
    _ctxSelectionAnchor = null;
    _syncCtxSelectionDom();
  });
}

function _ctxHasDragType(dataTransfer, type) {
  try { return Array.from(dataTransfer?.types || []).includes(type); }
  catch (_) { return false; }
}

function _ctxDragKind(dataTransfer) {
  if (_ctxHasDragType(dataTransfer, CTX_INTERNAL_DRAG_TYPE)) return 'internal';
  if (_ctxHasDragType(dataTransfer, 'Files') || (dataTransfer?.files?.length || 0) > 0) return 'external';
  return '';
}

function _ctxDropPayload(dataTransfer) {
  let src = '';
  try { src = dataTransfer?.getData?.(CTX_INTERNAL_DRAG_TYPE) || ''; }
  catch (_) { /* protected drag data — rely on the advertised types */ }
  if (src) return { kind: 'internal', src, files: [] };
  const files = Array.from(dataTransfer?.files || []).filter(Boolean);
  if (_ctxHasDragType(dataTransfer, 'Files') || files.length) {
    return { kind: 'external', src: '', files };
  }
  return { kind: '', src: '', files: [] };
}

function _ctxExternalDropTargetDir(target) {
  const wrap = target?.closest?.('.ctx-tree-wrap');
  if (!wrap) return '';
  const rel = String(wrap.dataset?.path || '');
  if (wrap.dataset?.type === 'dir') return rel;
  const slash = rel.lastIndexOf('/');
  return slash >= 0 ? rel.slice(0, slash) : '';
}

function _ctxClearDropHighlights(container) {
  container.classList.remove('is-root-drag-over');
  container.querySelectorAll('.skill-tree-node.is-drag-over')
    .forEach((node) => node.classList.remove('is-drag-over'));
}

function _ctxShowExternalDropTarget(container, targetDir) {
  _ctxClearDropHighlights(container);
  if (!targetDir) {
    container.classList.add('is-root-drag-over');
    return;
  }
  const targetWrap = Array.from(container.querySelectorAll('.ctx-tree-wrap[data-type="dir"]'))
    .find((wrap) => wrap.dataset?.path === targetDir);
  targetWrap?.querySelector(':scope > .skill-tree-node')?.classList.add('is-drag-over');
}

async function _handleCtxDrop(dataTransfer, targetDir) {
  const payload = _ctxDropPayload(dataTransfer);
  if (payload.kind === 'internal') {
    await _handleCtxMove(payload.src, targetDir);
    return true;
  }
  if (payload.kind === 'external' && payload.files.length) {
    await handleCtxUpload(payload.files, targetDir);
    return true;
  }
  return false;
}

function _ctxParentDir(relPath) {
  const rel = String(relPath || '');
  const slash = rel.lastIndexOf('/');
  return slash >= 0 ? rel.slice(0, slash) : '';
}

function _ctxActiveFileDir() {
  return _ctxParentDir(_ctxActive?.id || '');
}

function _bindCtxDetailDrop(container, getTargetDir = _ctxActiveFileDir) {
  if (!container || container.dataset.externalDropBound) return;
  container.dataset.externalDropBound = '1';
  container.addEventListener('dragover', (e) => {
    if (_ctxDragKind(e.dataTransfer) !== 'external') return;
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = 'copy';
    container.classList.add('is-external-drag-over');
  });
  container.addEventListener('dragleave', (e) => {
    if (e.currentTarget.contains(e.relatedTarget)) return;
    container.classList.remove('is-external-drag-over');
  });
  container.addEventListener('drop', async (e) => {
    if (_ctxDragKind(e.dataTransfer) !== 'external') return;
    e.preventDefault();
    e.stopPropagation();
    container.classList.remove('is-external-drag-over');
    await _handleCtxDrop(e.dataTransfer, getTargetDir());
  });
}

function _bindCtxTreeHandlers(container) {
  // Wire inline-rename inputs (at most one per render; commits on Enter /
  // blur, cancels on Esc). Stopping propagation so clicks inside the input
  // don't bubble up to the row's expand/select handler.
  container.querySelectorAll('.ctx-tree-rename-input').forEach(input => {
    const wrap = input.closest('.ctx-tree-wrap');
    if (!wrap) return;
    const rel = wrap.dataset.path;
    input.addEventListener('click', (e) => e.stopPropagation());
    // Auto-select the stem (without extension) so the user overwrites the
    // "untitled" stem but keeps ".md" if they just type.
    const v = input.value;
    const dot = v.lastIndexOf('.');
    setTimeout(() => {
      input.focus();
      input.setSelectionRange(0, dot > 0 ? dot : v.length);
    }, 0);
    let committed = false;
    const commit = async (accept) => {
      if (committed) return;
      committed = true;
      const next = input.value.trim();
      _ctxPendingRename = null;
      if (!accept || !next || next === v) { renderCtxTree(); return; }
      await _commitInlineRename(rel, next);
    };
    input.addEventListener('keydown', (e) => {
      // IME guard (CLAUDE.md §8) — Enter while composing should commit
      // the candidate to the rename input, not finalise the rename.
      if (e.isComposing || e.keyCode === 229) return;
      if (e.key === 'Enter') { e.preventDefault(); commit(true); }
      else if (e.key === 'Escape') { e.preventDefault(); commit(false); }
    });
    input.addEventListener('blur', () => commit(true));
  });

  container.querySelectorAll('.ctx-tree-wrap').forEach(wrap => {
    const rel = wrap.dataset.path;
    const kind = wrap.dataset.type;
    const node = wrap.querySelector(':scope > .skill-tree-node');
    if (!node) return;
    node.addEventListener('click', async (e) => {
      if (e.target.closest('[data-menu]')) {
        e.stopPropagation();
        _ctxSelectionFor(rel);
        _openCtxRowMenu(e.target.closest('[data-menu]'), kind, rel);
        return;
      }
      if (e.target.closest('[data-kb-reprocess]')) {
        e.stopPropagation();
        await reprocessCtxKbFile(rel);
        return;
      }
      e.stopPropagation();
      const selectionOnly = _selectCtxEntry(rel, e, container);
      if (selectionOnly) return;
      if (kind === 'dir') {
        if (_ctxExpanded.has(rel)) _ctxExpanded.delete(rel);
        else _ctxExpanded.add(rel);
        renderCtxTree();
      } else {
        await openCtxFile(rel);
      }
    });

    // ── Drag-drop wiring ──
    // Every non-root row is draggable. Folders + the tree container itself
    // (root drop zone) accept drops. Validation (no self / no descendant
    // drop) runs in `_handleCtxMove`.
    wrap.addEventListener('dragstart', (e) => {
      e.stopPropagation();
      e.dataTransfer.setData(CTX_INTERNAL_DRAG_TYPE, rel);
      e.dataTransfer.effectAllowed = 'move';
      wrap.classList.add('is-dragging');
    });
    wrap.addEventListener('dragend', () => wrap.classList.remove('is-dragging'));

    if (kind === 'dir') {
      const hover = (e) => {
        const dragKind = _ctxDragKind(e.dataTransfer);
        if (!dragKind) return;
        e.preventDefault();
        e.stopPropagation();
        e.dataTransfer.dropEffect = dragKind === 'internal' ? 'move' : 'copy';
        if (dragKind === 'external') _ctxClearDropHighlights(container);
        node.classList.add('is-drag-over');
      };
      const leave = (e) => {
        // Only remove the hover class when leaving the row outright — moving
        // between this row's own children fires extra leaves we should ignore.
        if (e.currentTarget.contains(e.relatedTarget)) return;
        node.classList.remove('is-drag-over');
      };
      node.addEventListener('dragover', hover);
      node.addEventListener('dragenter', hover);
      node.addEventListener('dragleave', leave);
      node.addEventListener('drop', async (e) => {
        if (!_ctxDragKind(e.dataTransfer)) return;
        e.preventDefault();
        e.stopPropagation();
        node.classList.remove('is-drag-over');
        _ctxClearDropHighlights(container);
        await _handleCtxDrop(e.dataTransfer, rel);
      });
    }
  });

  // The whole tree is an external-file drop zone. Folder rows keep their
  // exact target above; drops over an existing file use that file's parent,
  // and all other tree space targets the root. Internal moves remain limited
  // to folder rows or bare root space.
  if (!container.dataset.dndRootBound) {
    container.dataset.dndRootBound = '1';
    container.addEventListener('dragover', (e) => {
      const dragKind = _ctxDragKind(e.dataTransfer);
      if (!dragKind) return;
      const overEntry = e.target.closest('.ctx-tree-wrap');
      if (dragKind === 'internal' && overEntry) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = dragKind === 'internal' ? 'move' : 'copy';
      if (dragKind === 'external') {
        _ctxShowExternalDropTarget(container, _ctxExternalDropTargetDir(e.target));
      } else {
        container.classList.add('is-root-drag-over');
      }
    });
    container.addEventListener('dragleave', (e) => {
      if (e.currentTarget.contains(e.relatedTarget)) return;
      _ctxClearDropHighlights(container);
    });
    container.addEventListener('drop', async (e) => {
      const dragKind = _ctxDragKind(e.dataTransfer);
      if (!dragKind) return;
      const overEntry = e.target.closest('.ctx-tree-wrap');
      if (dragKind === 'internal' && overEntry) return;
      e.preventDefault();
      e.stopPropagation();
      const targetDir = dragKind === 'external' ? _ctxExternalDropTargetDir(e.target) : '';
      _ctxClearDropHighlights(container);
      await _handleCtxDrop(e.dataTransfer, targetDir);
    });
  }
}

// ── Row-level actions ──

async function reprocessCtxKbFile(rel) {
  try {
    _kbStatusByPath[rel] = { ...(_kbStatusByPath[rel] || {}), status: 'pending' };
    _updateCtxKbChip(rel);
    _scheduleKbStatusRefreshIfNeeded();
    const res = await apiFetch('/api/kb/reprocess', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: rel }),
    });
    const data = await res.json();
    if (!data.ok) await uiAlert(t('contexts.kb.reprocess_failed'));
  } catch (_) {
    await uiAlert(t('contexts.kb.reprocess_failed'));
  }
}

function _updateCtxKbChip(rel) {
  const row = document.querySelector(`.contexts-tree .ctx-tree-wrap[data-path="${_cssEscape(rel)}"] > .skill-tree-node`);
  if (!row) { renderCtxTree(); return; }
  const existing = row.querySelector('.ctx-kb-chip');
  const html = _kbStatusChipHtml(rel);
  if (existing) {
    if (html) existing.outerHTML = html;
    else existing.remove();
  } else if (html) {
    const menuBtn = row.querySelector('.ctx-row-menu-btn');
    if (menuBtn) menuBtn.insertAdjacentHTML('beforebegin', html);
  }
}

async function deleteCtxEntry(rel, kind) {
  const name = String(rel || '').split('/').pop() || rel;
  const prompt = kind === 'dir'
    ? t('contexts.dir.del_confirm', { name })
    : t('contexts.file.del_confirm', { name });
  if (!(await uiConfirm(prompt))) return;
  try {
    const res = await apiFetch(`/api/contexts/delete?path=${encodeURIComponent(rel)}`, { method: 'DELETE' });
    const data = await res.json();
    if (!data.ok) { await uiAlert(t('contexts.delete_failed')); return; }
    if (_ctxActive && (_ctxActive.id === rel || _ctxActive.id.startsWith(rel + '/'))) {
      _clearCtxViewer();
    }
    // Drop drafts under the deleted path (file or whole dir subtree); a
    // stale draft pointing at a no-longer-existing file would silently
    // re-create itself on the next click into a same-named freshly-made
    // file.
    for (const key of Array.from(_ctxDrafts.keys())) {
      if (key === rel || key.startsWith(rel + '/')) _ctxDrafts.delete(key);
    }
    await loadContexts();
  } catch (_) {
    await uiAlert(t('contexts.delete_failed'));
  }
}

// Triggers in-place rename: flag the path and re-render so the label slot
// becomes an editable input. Commit handled by the existing inline-rename
// listeners in `_bindCtxTreeHandlers` → `_commitInlineRename`. Used by the
// row ⋯ menu's "rename" item.
function renameCtxEntry(rel /*, kind */) {
  // For dirs being renamed: must be expanded so the row is rendered as an
  // input. (Collapsed dirs whose ancestor is also collapsed wouldn't show.)
  // We don't toggle expansion here — the row exists by definition because
  // the menu was triggered from its own ⋯ button; the parent chain is open.
  _ctxPendingRename = { path: rel };
  renderCtxTree();
}

function _ctxMenuItemsHtml(items) {
  return items.map((it) => `
    ${it.dividerBefore ? '<div class="ctx-row-menu-divider" role="separator"></div>' : ''}
    <div class="ctx-row-menu-item${it.danger ? ' is-danger' : ''}" data-action="${escapeHtml(it.action)}">${escapeHtml(it.label)}</div>
  `).join('');
}

// Open the per-row ⋯ popover menu. `kind` ∈ 'root' | 'dir' | 'file'.
// Menu items are dynamic per kind — file kind further subdivides on whether
// the file is a text-editable type (controls the "edit" item).
function _openCtxRowMenu(anchorBtn, kind, relPath) {
  let menu = document.getElementById('ctx-row-menu');
  if (!menu) {
    menu = document.createElement('div');
    menu.id = 'ctx-row-menu';
    menu.className = 'ctx-row-menu';
    menu.style.display = 'none';
    document.body.appendChild(menu);
  }
  // Toggle off if already open for this same anchor.
  const sameAnchor = menu.dataset.anchorPath === relPath
    && menu.dataset.anchorKind === kind
    && menu.style.display !== 'none';
  if (sameAnchor) { _closeCtxRowMenu(); return; }
  _closeCtxRowMenu();

  const items = _ctxMenuItemsFor(kind, relPath);
  menu.innerHTML = _ctxMenuItemsHtml(items);
  menu.dataset.anchorPath = relPath;
  menu.dataset.anchorKind = kind;
  // While menu open, force the source row's ⋯ button visible so it doesn't
  // disappear when the user moves the mouse onto the popover.
  const srcRow = anchorBtn.closest('.skill-tree-node, .contexts-section-header');
  for (const r of document.querySelectorAll('.is-menu-open')) r.classList.remove('is-menu-open');
  if (srcRow) srcRow.classList.add('is-menu-open');

  _positionCtxRowMenu(menu, anchorBtn);
  for (const item of menu.querySelectorAll('.ctx-row-menu-item')) {
    item.addEventListener('click', async (e) => {
      e.stopPropagation();
      const action = item.dataset.action;
      _closeCtxRowMenu();
      await _runCtxMenuAction(action, kind, relPath);
    });
  }
}

function _closeCtxRowMenu() {
  const menu = document.getElementById('ctx-row-menu');
  if (menu) {
    menu.style.display = 'none';
    delete menu.dataset.anchorPath;
    delete menu.dataset.anchorKind;
  }
  for (const r of document.querySelectorAll('.is-menu-open')) r.classList.remove('is-menu-open');
}

function _positionCtxRowMenu(menuEl, anchorEl) {
  menuEl.style.display = 'block';
  menuEl.style.left = '-9999px';
  menuEl.style.top = '-9999px';
  const rect = anchorEl.getBoundingClientRect();
  const menuRect = menuEl.getBoundingClientRect();
  const margin = 8;
  const gap = 4;
  let left = rect.right - menuRect.width;
  if (left < margin) left = margin;
  if (left + menuRect.width > window.innerWidth - margin) {
    left = window.innerWidth - menuRect.width - margin;
  }
  const below = rect.bottom + gap + menuRect.height <= window.innerHeight - margin;
  const top = below ? rect.bottom + gap : Math.max(margin, rect.top - menuRect.height - gap);
  menuEl.style.left = left + 'px';
  menuEl.style.top = top + 'px';
}

function _ctxMenuItemsFor(kind, relPath) {
  if (kind === 'root') {
    return [
      { action: 'new_text',   label: t('contexts.menu.new_text') },
      { action: 'new_folder', label: t('contexts.menu.new_folder') },
      { action: 'upload',     label: t('contexts.menu.upload') },
    ];
  }
  if (kind === 'dir') {
    return [
      { action: 'new_text',   label: t('contexts.menu.new_text') },
      { action: 'new_folder', label: t('contexts.menu.new_folder') },
      { action: 'upload',     label: t('contexts.menu.upload') },
      { action: 'organize',   label: t('contexts.transfer.title'), dividerBefore: true },
      { action: 'rename',     label: t('contexts.menu.rename') },
      { action: 'delete',     label: t('contexts.menu.delete'), danger: true, dividerBefore: true },
    ];
  }
  // file
  const items = [];
  if (CTX_TEXT_EXTS.has(_ctxExtOf(relPath))) {
    items.push({ action: 'edit', label: t('contexts.menu.edit') });
  }
  items.push({ action: 'rename', label: t('contexts.menu.rename') });
  items.push({ action: 'delete', label: t('contexts.menu.delete'), danger: true });
  items.push({ action: 'ask_commander', label: t('contexts.menu.ask_commander'), dividerBefore: true });
  items.push({ action: 'organize', label: t('contexts.transfer.title') });
  items.push({ action: 'open_in_system', label: t('contexts.menu.open_in_system'), dividerBefore: true });
  return items;
}

async function _runCtxMenuAction(action, kind, relPath) {
  const dirArg = kind === 'root' ? '' : relPath;  // for new_text / new_folder / upload
  switch (action) {
    case 'new_text':   return createCtxNewTextFile(dirArg);
    case 'new_todo':   return createCtxNewTodoFile(dirArg);
    case 'new_folder': return promptCtxNewInDir(dirArg);
    case 'upload': {
      await handleCtxNativeUpload(dirArg);
      return;
    }
    case 'rename':     return renameCtxEntry(relPath, kind);
    case 'delete':     return deleteCtxEntry(relPath, kind);
    case 'organize':   return _openCtxTransfer(_ctxSelectionFor(relPath), 'menu');
    case 'edit':       { await openCtxFile(relPath); _enterCtxEdit(); return; }
    case 'open_in_system': return revealCtxFile(relPath);
    case 'ask_commander': return askCommanderAboutCtxFile(relPath);
  }
}

async function _openCtxTransfer(paths, entryPoint) {
  if (!window.LibraryTransfer?.open || !paths?.length) return;
  await window.LibraryTransfer.open({
    source: { scope: 'global' },
    paths,
    entryPoint,
    onComplete: async (result) => {
      const successful = (result.results || []).filter((row) => row.ok);
      if (result.mode === 'move') {
        for (const row of successful) {
          if (result.destination?.scope === 'global') {
            _applyCtxPathChange(row.source, row.destination, result.destination.dir || '');
          } else {
            for (const key of Array.from(_ctxDrafts.keys())) {
              if (key === row.source || key.startsWith(row.source + '/')) _ctxDrafts.delete(key);
            }
            if (_ctxActive && (_ctxActive.id === row.source || _ctxActive.id.startsWith(row.source + '/'))) {
              _clearCtxViewer();
            }
          }
        }
      }
      _ctxSelected.clear();
      _ctxSelectionAnchor = null;
      await loadContexts();
    },
  });
}

// Open a fresh GLOBAL commander conversation with this KB file attached as a
// reference, then navigate there so the user can ask about it. Main creates the
// conversation + imports the file (path resolution is server-side); we just
// surface it in the sidebar and open it (mirrors project-detail::_runProjectAgent).
async function askCommanderAboutCtxFile(relPath) {
  if (!relPath) return;
  if (typeof ensureModelConfigured === 'function' && !ensureModelConfigured()) return;
  try {
    // Attach the file to the commander draft pool and go to the chat home; the
    // user then types their question (no new conversation is created here).
    await window.attachKbFileToDraft(
      'contexts.attachToDraft',
      { relPath },
      window.COMMANDER_DRAFT_CID,
      () => { if (typeof setView === 'function') setView('new-chat'); },
    );
  } catch (_) {
    if (typeof uiAlert === 'function') await uiAlert(t('contexts.ask_commander_failed'));
  }
}

// Move src to live under targetDir (empty string = root). Defends against
// no-op moves, dropping into self, or dropping into own descendants. On
// backend conflict / failure shows a uiAlert.
function _ctxFlashMovedEntry(relPath) {
  const wraps = document.querySelectorAll('.contexts-tree .ctx-tree-wrap[data-path]');
  const wrap = Array.from(wraps).find((el) => el.dataset.path === relPath);
  const node = wrap?.querySelector(':scope > .skill-tree-node');
  if (!node) return;
  node.scrollIntoView?.({ block: 'nearest' });
  node.classList.remove('is-move-complete');
  requestAnimationFrame(() => node.classList.add('is-move-complete'));
  setTimeout(() => node.classList.remove('is-move-complete'), 1500);
}

function _ctxMoveTargetLabel(targetDir) {
  if (!targetDir) return t('contexts.root_label');
  const parts = String(targetDir).split('/');
  return parts[parts.length - 1] || t('contexts.root_label');
}

function _applyCtxPathChange(srcRel, dst, targetDir = '') {
  if (_ctxActive && (_ctxActive.id === srcRel || _ctxActive.id.startsWith(srcRel + '/'))) {
    _ctxActive.id = dst + _ctxActive.id.slice(srcRel.length);
  }
  for (const expanded of Array.from(_ctxExpanded)) {
    if (expanded === srcRel || expanded.startsWith(srcRel + '/')) {
      _ctxExpanded.delete(expanded);
      _ctxExpanded.add(dst + expanded.slice(srcRel.length));
    }
  }
  if (targetDir) _ctxExpanded.add(targetDir);
  for (const [key, val] of Array.from(_ctxDrafts.entries())) {
    if (key === srcRel) {
      _ctxDrafts.set(dst, val);
      _ctxDrafts.delete(srcRel);
    } else if (key.startsWith(srcRel + '/')) {
      _ctxDrafts.set(dst + key.slice(srcRel.length), val);
      _ctxDrafts.delete(key);
    }
  }
  _retargetCtxViewerAfterRename(srcRel, dst);
}

async function _handleCtxMove(srcRel, targetDir) {
  if (!srcRel) return;
  const base = srcRel.includes('/') ? srcRel.slice(srcRel.lastIndexOf('/') + 1) : srcRel;
  const dst = targetDir ? `${targetDir}/${base}` : base;
  if (dst === srcRel) return;
  const sourceWrap = Array.from(document.querySelectorAll('.contexts-tree .ctx-tree-wrap[data-path]'))
    .find((el) => el.dataset.path === srcRel);
  const trackResult = () => {};
  // Reject moves into self or own subtree (only meaningful for dirs but the
  // check is cheap and correct for files too).
  if (targetDir === srcRel || targetDir.startsWith(srcRel + '/')) {
    trackResult('failure', 'invalid_target', false);
    await uiAlert(t('contexts.dnd.invalid_self'));
    return;
  }
  try {
    const res = await apiFetch('/api/contexts/rename', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ src: srcRel, dst }),
    });
    const data = await res.json();
    if (!data.ok) {
      const errorCode = data.error === 'destination already exists' ? 'target_exists' : 'move_failed';
      trackResult('failure', errorCode);
      const message = errorCode === 'target_exists'
        ? t('contexts.dnd.target_exists', { name: base })
        : t('contexts.dnd.move_failed');
      await uiAlert(message);
      return;
    }
    _applyCtxPathChange(srcRel, dst, targetDir);
    await loadContexts();
    _ctxFlashMovedEntry(dst);
    if (typeof uiToast === 'function') {
      uiToast(t('contexts.dnd.moved_to', { target: _ctxMoveTargetLabel(targetDir) }), { variant: 'success' });
    }
    trackResult('success');
  } catch (e) {
    trackResult('failure', 'move_failed');
    _contextsLog.warn('move library entry failed', e);
    await uiAlert(t('contexts.dnd.move_failed'));
  }
}

/** If the right-pane md viewer is showing the renamed file (or any file
 *  nested under a renamed directory), update the controller's internal
 *  source.rel + the path label so the next save PUTs the correct path.
 *  Without this, an inline-rename or drag-drop move while the file is
 *  open in edit mode causes the next save to hit the backend with the
 *  stale path and the user gets `not found: <old path>`. The viewer is
 *  intentionally not re-rendered — the draft + cursor state stay put. */
function _retargetCtxViewerAfterRename(oldRel, newRel) {
  if (!_ctxMveController || typeof _ctxMveController.getSource !== 'function') return;
  const src = _ctxMveController.getSource();
  if (!src || src.kind !== 'context' || typeof src.rel !== 'string') return;
  let nextRel = null;
  if (src.rel === oldRel) nextRel = newRel;
  else if (src.rel.startsWith(oldRel + '/')) nextRel = newRel + src.rel.slice(oldRel.length);
  if (!nextRel) return;
  if (typeof _ctxMveController.setSource === 'function') {
    _ctxMveController.setSource({ ...src, rel: nextRel });
  }
  const pathEl = document.getElementById('contexts-editor-path');
  if (pathEl) pathEl.textContent = nextRel;
}

// Inline-rename commit (invoked by the tree's inline-rename input on Enter
// / blur). Same backend endpoint as `renameCtxEntry` but skips the uiPrompt
// and renders no alerts on empty / unchanged — those cases cancel silently.
async function _commitInlineRename(rel, nextBase) {
  const cleaned = String(nextBase).trim();
  if (!cleaned || cleaned.includes('/') || cleaned.includes('..') || cleaned.includes('\\')) {
    await uiAlert(t('contexts.entry.rename_bad_name'));
    await loadContexts();
    return;
  }
  const dir = rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : '';
  const dst = dir ? `${dir}/${cleaned}` : cleaned;
  if (dst === rel) { renderCtxTree(); return; }
  try {
    const res = await apiFetch('/api/contexts/rename', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ src: rel, dst }),
    });
    const data = await res.json();
    if (!data.ok) { await uiAlert(_ctxRenameFailureMessage(data.error)); await loadContexts(); return; }
    if (_ctxActive && _ctxActive.id === rel) _ctxActive.id = dst;
    // Re-key any drafts (file rename: one entry; dir rename: every entry
    // under the old prefix) so the draft survives the rename. Iterate a
    // snapshot since we're mutating the map.
    for (const [key, val] of Array.from(_ctxDrafts.entries())) {
      if (key === rel) {
        _ctxDrafts.set(dst, val);
        _ctxDrafts.delete(rel);
      } else if (key.startsWith(rel + '/')) {
        _ctxDrafts.set(dst + key.slice(rel.length), val);
        _ctxDrafts.delete(key);
      }
    }
    _retargetCtxViewerAfterRename(rel, dst);
    await loadContexts();
  } catch (_) {
    await uiAlert(t('contexts.entry.rename_failed'));
    await loadContexts();
  }
}

function _ctxRenameFailureMessage(error) {
  const code = String(error || '');
  if (code === 'destination already exists' || code === 'target_exists') {
    return t('contexts.entry.rename_target_exists');
  }
  if (code === 'destination has unsupported extension') {
    return t('contexts.entry.rename_unsupported');
  }
  return t('contexts.entry.rename_failed');
}

// Opens the "new directory" modal scoped to `parentDir` (relative, '' for
// root). The old "new" modal had tabs (dir / text) + a content
// textarea; it's now directory-only — the "+ text" action creates a
// file inline (see `createCtxNewTextFile`) without any modal.
async function promptCtxNewInDir(parentDir) {
  _ctxNewTargetDir = parentDir || '';
  document.getElementById('ctx-new-name').value = '';
  document.getElementById('ctx-new-msg').textContent = '';
  const dirLabel = parentDir ? `${parentDir}/` : t('contexts.root_label');
  document.getElementById('ctx-new-target').textContent = t('contexts.new.target', { rel: dirLabel });
  document.getElementById('ctx-new-modal').classList.add('open');
  setTimeout(() => document.getElementById('ctx-new-name')?.focus(), 40);
}
window.promptCtxNewInDir = promptCtxNewInDir;

let _ctxNewTargetDir = '';

function closeCtxNewModal() {
  document.getElementById('ctx-new-modal').classList.remove('open');
}
window.closeCtxNewModal = closeCtxNewModal;

// Directory-only "new entry" modal confirm. Text-file creation no longer
// goes through the modal — see `createCtxNewTextFile`.
async function saveCtxNew() {
  const nameRaw = document.getElementById('ctx-new-name').value.trim();
  const msg = document.getElementById('ctx-new-msg');
  msg.className = 'form-msg';
  if (!nameRaw) { msg.textContent = t('contexts.new.name_needed'); msg.className = 'form-msg err'; return; }
  if (nameRaw.includes('/') || nameRaw.includes('..') || nameRaw.includes('\\')) {
    msg.textContent = t('contexts.new.bad_chars'); msg.className = 'form-msg err'; return;
  }
  const joined = _ctxNewTargetDir ? `${_ctxNewTargetDir}/${nameRaw}` : nameRaw;
  try {
    const res = await apiFetch('/api/contexts/mkdir', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: joined }),
    });
    const data = await res.json();
    if (!data.ok) {
      msg.textContent = data.error === 'path exists and is not a directory'
        ? t('contexts.entry.name_exists')
        : t('contexts.dir.create_failed');
      msg.className = 'form-msg err';
      return;
    }
    _ctxExpanded.add(joined);
    closeCtxNewModal();
    if (_ctxNewTargetDir) _ctxExpanded.add(_ctxNewTargetDir);
    await loadContexts();
  } catch (_) {
    msg.textContent = t('contexts.dir.create_failed');
    msg.className = 'form-msg err';
  }
}
window.saveCtxNew = saveCtxNew;

// "+ text" handler — no modal. Writes an empty "untitled.md" (disambiguated if
// one already exists in that dir), opens it in the right pane, flags it
// for inline rename on the next tree render, and immediately drops the
// viewer into edit mode so the user can start typing content.
async function createCtxNewTextFile(parentDir = '') {
  const stemBase = t('contexts.new.untitled_stem');
  // Collect sibling file names so we can uniquify if a conflict exists.
  const siblings = _ctxListChildren(parentDir).map(n => n.name);
  let stem = stemBase;
  let i = 2;
  while (siblings.includes(`${stem}.md`)) { stem = `${stemBase} ${i++}`; }
  const name = `${stem}.md`;
  const fullPath = parentDir ? `${parentDir}/${name}` : name;
  try {
    const res = await apiFetch('/api/contexts/write', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: fullPath, content: '' }),
    });
    const data = await res.json();
    if (!data.ok) { await uiAlert(t('contexts.file.create_failed')); return; }
    if (parentDir) _ctxExpanded.add(parentDir);
    _ctxPendingRename = { path: fullPath };
    await loadContexts();
    // Show the file in the right pane already in edit mode (empty textarea
    // + Save/Cancel actions). `_ctxPendingRename` will be consumed by the
    // next renderCtxTree() call.
    _showCtxTextViewer(fullPath, '');
    _enterCtxEdit();
  } catch (_) {
    await uiAlert(t('contexts.file.create_failed'));
  }
}

// "+ todo list" handler — mirrors `createCtxNewTextFile` but seeds the file
// with a minimal task-list template so the user lands on something usable.
// Stored as plain .md (GitHub-style `- [ ]` syntax) — interactive checkbox
// behavior is layered on by the KB viewer; the file itself stays portable
// and indexable like any other md note.
async function createCtxNewTodoFile(parentDir = '') {
  const stemBase = t('contexts.new.todo_stem');
  const siblings = _ctxListChildren(parentDir).map(n => n.name);
  let stem = stemBase;
  let i = 2;
  while (siblings.includes(`${stem}.md`)) { stem = `${stemBase} ${i++}`; }
  const name = `${stem}.md`;
  const fullPath = parentDir ? `${parentDir}/${name}` : name;
  const heading = t('contexts.new.todo_template_heading');
  const template = `# ${heading}\n\n- [ ] \n- [ ] \n- [ ] \n`;
  try {
    const res = await apiFetch('/api/contexts/write', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: fullPath, content: template }),
    });
    const data = await res.json();
    if (!data.ok) { await uiAlert(t('contexts.file.create_failed')); return; }
    if (parentDir) _ctxExpanded.add(parentDir);
    _ctxPendingRename = { path: fullPath };
    await loadContexts();
    _showCtxTextViewer(fullPath, template);
    _enterCtxEdit();
  } catch (_) {
    await uiAlert(t('contexts.file.create_failed'));
  }
}

// Collect direct children of a dir path in the cached tree — used by
// `createCtxNewTextFile` to uniquify "untitled.md" when a collision exists.
function _ctxListChildren(dirPath) {
  if (!dirPath) return _ctxTree;
  const parts = dirPath.split('/');
  let cur = _ctxTree;
  for (const part of parts) {
    const hit = cur.find(n => n.type === 'dir' && n.name === part);
    if (!hit) return [];
    cur = hit.children || [];
  }
  return cur;
}

// ── Upload ──

const CTX_ALLOWED_EXTS = [
  '.md', '.markdown', '.txt', '.csv', '.tsv', '.json', '.yaml', '.yml', '.log',
  '.html', '.htm', '.xml', '.toml', '.ini', '.conf',
  '.py', '.pyi', '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',
  '.sh', '.bash', '.zsh', '.ps1', '.cmd', '.bat', '.rb', '.go', '.rs', '.java', '.kt',
  '.c', '.cpp', '.cc', '.h', '.hpp', '.css', '.scss', '.less',
  '.sql', '.graphql', '.gql',
  '.pdf', '.docx', '.docm', '.xlsx', '.xlsm', '.pptx', '.pptm',
  '.png', '.jpg', '.jpeg', '.webp', '.gif',
];

function _ctxExtOf(name) {
  const i = (name || '').lastIndexOf('.');
  return i >= 0 ? name.slice(i).toLowerCase() : '';
}

function _ctxHasHiddenPathSegment(name) {
  return String(name || '').split('/').some(part => part.startsWith('.'));
}

function _ctxUploadErrorCode(reason) {
  const text = String(reason || '').toLowerCase();
  if (text === 'ext') return 'ext';
  if (text === 'hidden') return 'hidden';
  if (/picker/.test(text)) return 'picker_failed';
  if (/network|fetch|timeout|econn|enotfound|socket/.test(text)) return 'network';
  return 'upload_failed';
}

function _ctxLibraryDirectoryLabel(existingDir) {
  const dir = String(existingDir || '').replace(/^\/+|\/+$/g, '');
  const leaf = dir || t('contexts.root_label');
  return `${t('contexts.title')} / ${leaf}`;
}

async function _ctxAlertDuplicateUploads(rows) {
  if (!rows.length) return;
  const dirs = Array.from(new Set(rows.map((row) => _ctxLibraryDirectoryLabel(row.existingDir))));
  await uiAlert(t('contexts.upload_duplicate', { dirs: dirs.join('\n') }));
}

async function _ctxAlertUploadFailures(rows) {
  if (!rows.length) return;
  const names = rows
    .map((row) => String((row && (row.name || row.target)) || '').trim())
    .filter(Boolean);
  await uiAlert(names.length
    ? t('contexts.upload_failed', { list: names.join('\n') })
    : t('contexts.upload_failed_generic'));
}

async function handleCtxUpload(fileList, targetDir = '') {
  const files = Array.from(fileList || []);
  _contextsLog.info(`upload: ${files.length} file(s), targetDir="${targetDir || '(root)'}"`);
  if (!files.length) return;
  if (targetDir) _ctxExpanded.add(targetDir);

  // Visible progress banner above the tree — without it the user has no
  // signal between "I clicked upload" and "the row appears" (which only
  // happens after loadContexts() at the end of all jobs). Hidden in the
  // finally block so a thrown exception still tears it down.
  const statusEl = document.getElementById('ctx-upload-status');
  const labelEl = document.getElementById('ctx-upload-status-label');
  if (statusEl && labelEl) {
    labelEl.textContent = t('contexts.upload.in_progress', { count: files.length });
    statusEl.style.display = '';
  }

  // Parallel upload: each file runs its own apiFetch on the IPC layer —
  // main-process handlers process invokes concurrently, and `kb_indexer`
  // funnels them all into the same single-worker queue on the back end (so
  // actual vectorization stays serial and predictable). Failures are
  // collected and surfaced once at the end, not per-file.
  const jobs = _ctxUploadMap(files, async (file) => {
    if (_ctxHasHiddenPathSegment(file.name)) return { ok: false, name: file.name, reason: 'hidden' };
    const ext = _ctxExtOf(file.name);
    if (!CTX_ALLOWED_EXTS.includes(ext)) return { ok: false, name: file.name, reason: 'ext' };
    try {
      const target = targetDir ? `${targetDir}/${file.name}` : file.name;
      _kbStatusByPath[target] = { status: 'pending' };
      let data = null;
      if (window.orkas && typeof window.orkas.importLocalFiles === 'function') {
        const imported = await window.orkas.importLocalFiles('contexts', [file], { targetDir });
        if (imported && imported.ok === false) {
          data = imported;
        } else if (Array.isArray(imported && imported.files) && imported.files.length) {
          data = imported.files[0];
        }
      }
      // Synthetic File objects used by browser tests have no OS path. Keep a
      // small compatibility fallback, but never allow a large payload back
      // onto the base64 bridge.
      if (!data) {
        if (Number(file.size || 0) > 8 * 1024 * 1024) {
          data = { ok: false, code: 'E_IMPORT_PATH', error: 'local file path unavailable' };
        } else {
          const buf = await file.arrayBuffer();
          const res = await apiFetch('/api/contexts/upload', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/octet-stream',
              'X-Filename': encodeURIComponent(target),
            },
            body: buf,
          });
          data = await res.json();
        }
      }
      if (!data.ok) {
        delete _kbStatusByPath[target];
        return {
          ok: false,
          name: file.name,
          reason: data.error || 'unknown',
          code: data.code || '',
          existingDir: typeof data.existingDir === 'string' ? data.existingDir : '',
        };
      }
      return { ok: true, name: file.name };
    } catch (e) {
      return { ok: false, name: file.name, reason: e.message || String(e) };
    }
  }, 2);
  let results;
  try {
    results = await jobs;
    // Single post-upload refresh picks up all new rows at once.
    await loadContexts();
  } finally {
    if (statusEl) statusEl.style.display = 'none';
  }

  const rejected = results.filter((r) => !r.ok);
  for (const r of rejected) {
    const errorCode = _ctxUploadErrorCode(r.code || r.reason);
    _contextsLog.warn(`upload failed: ${errorCode}`);
  }
  const extRejected = rejected.filter((r) => r.reason === 'ext');
  const hiddenRejected = rejected.filter((r) => r.reason === 'hidden');
  const duplicateRejected = rejected.filter((r) => r.code === 'duplicate_content');
  const failed = rejected.filter((r) => r.reason !== 'ext' && r.reason !== 'hidden' && r.code !== 'duplicate_content');
  if (extRejected.length) {
    await uiAlert(t('contexts.upload_rejected', {
      list: extRejected.map((r) => r.name || '').join('\n'),
    }));
  }
  if (hiddenRejected.length) {
    await uiAlert(t('contexts.upload_hidden_rejected', {
      list: hiddenRejected.map((r) => r.name || '').join('\n'),
    }));
  }
  await _ctxAlertDuplicateUploads(duplicateRejected);
  await _ctxAlertUploadFailures(failed);
}

async function _ctxUploadMap(items, worker, concurrency) {
  const results = new Array(items.length);
  let next = 0;
  const count = Math.min(Math.max(1, concurrency || 1), items.length);
  await Promise.all(Array.from({ length: count }, async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await worker(items[index]);
    }
  }));
  return results;
}

async function handleCtxNativeUpload(targetDir = '') {
  if (targetDir) _ctxExpanded.add(targetDir);
  const statusEl = document.getElementById('ctx-upload-status');
  const labelEl = document.getElementById('ctx-upload-status-label');
  if (statusEl && labelEl) {
    labelEl.textContent = t('contexts.upload.in_progress', { count: 1 });
    statusEl.style.display = '';
  }
  let data;
  try {
    data = await window.orkas.invoke('contexts.pickAndUpload', { targetDir });
    await loadContexts();
  } catch (err) {
    _contextsLog.warn('native upload failed', err);
    await uiAlert(t('contexts.upload_picker_failed'));
    return;
  } finally {
    if (statusEl) statusEl.style.display = 'none';
  }
  const files = Array.isArray(data && data.files) ? data.files : [];
  const extRejected = files.filter((r) => r && r.ok === false && r.reason === 'ext');
  if (extRejected.length) {
    await uiAlert(t('contexts.upload_rejected', {
      list: extRejected.map((r) => r.name || '').join('\n'),
    }));
  }
  const hiddenRejected = files.filter((r) => r && r.ok === false && r.reason === 'hidden');
  if (hiddenRejected.length) {
    await uiAlert(t('contexts.upload_hidden_rejected', {
      list: hiddenRejected.map((r) => r.name || '').join('\n'),
    }));
  }
  const duplicateRejected = files.filter((r) => r && r.ok === false && r.code === 'duplicate_content');
  await _ctxAlertDuplicateUploads(duplicateRejected);
  const failed = files.filter((r) => !r || (
    r.ok === false
    && r.reason !== 'ext'
    && r.reason !== 'hidden'
    && r.code !== 'duplicate_content'
  ));
  await _ctxAlertUploadFailures(failed);
}

// ── Viewer (right pane) ──
// Dispatches on file extension:
//   - text kinds        → markdown editor (read + edit + delete)
//   - image kinds       → inline <img> via base64
//   - pdf / office / else → inline preview or stub card; binary fallback opens the
//                         file in the OS default viewer. We still provide
//                         delete + "open in system" actions for consistency.

const CTX_TEXT_EXTS = new Set([
  '.md', '.markdown', '.txt', '.csv', '.tsv', '.json', '.yaml', '.yml', '.log',
  '.html', '.htm', '.xml', '.toml', '.ini', '.conf',
  '.py', '.pyi', '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',
  '.sh', '.bash', '.zsh', '.ps1', '.cmd', '.bat', '.rb', '.go', '.rs', '.java', '.kt',
  '.c', '.cpp', '.cc', '.h', '.hpp', '.css', '.scss', '.less',
  '.sql', '.graphql', '.gql',
]);
const CTX_IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif']);
const CTX_OFFICE_EXTS = new Set(['.docx', '.docm', '.xlsx', '.xlsm', '.pptx', '.pptm']);

function _kindOfPath(rel) {
  const ext = _ctxExtOf(rel);
  if (CTX_TEXT_EXTS.has(ext)) return 'text';
  if (CTX_IMAGE_EXTS.has(ext)) return 'image';
  if (ext === '.pdf') return 'pdf';
  if (CTX_OFFICE_EXTS.has(ext)) return 'office';
  return 'other';
}

// Add every ancestor directory of `rel` to the expanded set. Called from
// `openCtxFile` so deep-link navigation (global search → KB file) unrolls
// the tree to show where the file lives and why its row is marked active.
function _ctxExpandAncestors(rel) {
  const parts = String(rel || '').split('/');
  if (parts.length <= 1) return;
  let acc = '';
  for (let i = 0; i < parts.length - 1; i++) {
    acc = acc ? `${acc}/${parts[i]}` : parts[i];
    _ctxExpanded.add(acc);
  }
}

// After the tree re-renders, scroll the active file row into view. Used by
// `openCtxFile` so navigation into a deep path puts the selected row on
// screen without the user having to scroll the left pane.
function _ctxScrollActiveIntoView() {
  const container = document.getElementById('contexts-tree');
  if (!container) return;
  const active = container.querySelector('.skill-tree-node.skill-tree-file.active');
  if (active) active.scrollIntoView({ block: 'nearest', behavior: 'auto' });
}

async function openCtxFile(rel) {
  _ctxExpandAncestors(rel);
  const kind = _kindOfPath(rel);
  try {
    if (kind === 'text') {
      const res = await apiFetch(`/api/contexts/read?path=${encodeURIComponent(rel)}`);
      const data = await res.json();
      if (!data.ok) { await uiAlert(t('contexts.read_failed')); return; }
      _showCtxTextViewer(rel, data.content || '');
    } else if (kind === 'image') {
      const res = await apiFetch(`/api/contexts/image?path=${encodeURIComponent(rel)}`);
      const data = await res.json();
      if (!data.ok) { await uiAlert(t('contexts.read_failed')); return; }
      _showCtxImageViewer(rel, data.base64, data.mediaType, data.bytes);
    } else if (kind === 'pdf') {
      // Let Chromium's built-in PDFium render inline via the kb-file://
      // protocol registered in main/index.ts. Encoding: path segments are
      // URL-encoded individually so CJK filenames survive but `/` boundaries
      // stay visible to the router.
      _showCtxPdfViewer(rel);
    } else if (kind === 'office') {
      await _showCtxOfficeViewer(rel);
    } else {
      _showCtxBinaryViewer(rel, kind);
      revealCtxFile(rel);
    }
  } catch (_) {
    await uiAlert(t('contexts.read_failed'));
  }
}

function _encodeKbFileUrl(rel) {
  // `kb-file://kb/<relpath>` — the `kb` host is a stable fake. Chromium
  // normalises standard-scheme URLs that have an empty host (`kb-file:///…`)
  // in non-obvious ways (first segment can be interpreted as the host);
  // a fixed host avoids that ambiguity. Path segments are URL-encoded
  // individually so CJK / spaces survive but `/` separators stay visible.
  return 'kb-file://kb/' + rel.split('/').map(encodeURIComponent).join('/');
}

function _showCtxPdfViewer(rel) {
  const els = _prepCtxViewerShell(rel);
  if (!els) return;
  const src = _encodeKbFileUrl(rel);
  // #toolbar=1&navpanes=0 is the Chromium PDFium control hint — keep toolbar
  // (zoom, print, download) visible; hide the sidebar since the panel is
  // already narrow.
  els.bodyEl.innerHTML = `<iframe class="ctx-viewer-pdf" src="${src}#toolbar=1&navpanes=0" title="${escapeHtml(rel)}"></iframe>`;
  els.actionsEl.innerHTML = `
    <button class="btn btn-sm" id="ctx-viewer-reveal">${escapeHtml(t('contexts.viewer.open_system'))}</button>
    <button class="btn btn-sm btn-danger" id="ctx-viewer-del">${escapeHtml(t('contexts.viewer.delete'))}</button>
  `;
  els.actionsEl.querySelector('#ctx-viewer-reveal').addEventListener('click', () => revealCtxFile(rel));
  els.actionsEl.querySelector('#ctx-viewer-del').addEventListener('click', _deleteCtxFromViewer);
}

function _showCtxDocxViewer(rel, html) {
  const els = _prepCtxViewerShell(rel);
  if (!els) return;
  // mammoth's HTML is scrubbed (no <script>), but we still render it inside
  // a scoped `.ctx-viewer-docx` container so its styling doesn't bleed into
  // the rest of the app chrome.
  els.bodyEl.innerHTML = `<div class="ctx-viewer-docx markdown-body">${html || `<p class="muted">${escapeHtml(t('contexts.viewer.docx_empty'))}</p>`}</div>`;
  els.actionsEl.innerHTML = `
    <button class="btn btn-sm" id="ctx-viewer-reveal">${escapeHtml(t('contexts.viewer.open_system'))}</button>
    <button class="btn btn-sm btn-danger" id="ctx-viewer-del">${escapeHtml(t('contexts.viewer.delete'))}</button>
  `;
  els.actionsEl.querySelector('#ctx-viewer-reveal').addEventListener('click', () => revealCtxFile(rel));
  els.actionsEl.querySelector('#ctx-viewer-del').addEventListener('click', _deleteCtxFromViewer);
  els.bodyEl.scrollTop = 0;
}

async function _showCtxOfficeViewer(rel) {
  const els = _prepCtxViewerShell(rel);
  if (!els) return;
  els.bodyEl.innerHTML = `<div class="chat-file-viewer-loading">…</div>`;
  const res = await apiFetch(`/api/contexts/office?path=${encodeURIComponent(rel)}`);
  const data = await res.json();
  if (!data.ok) { await uiAlert(t('contexts.read_failed')); return; }
  if (_ctxOfficeBlobUrl) {
    try { URL.revokeObjectURL(_ctxOfficeBlobUrl); } catch (_) { /* ignore */ }
  }
  _ctxOfficeBlobUrl = URL.createObjectURL(new Blob([String(data.html || '')], { type: 'text/html;charset=utf-8' }));
  const style = data.previewHeight ? ` style="height:${Math.max(120, Number(data.previewHeight) || 0)}px"` : '';
  els.bodyEl.innerHTML = `<iframe class="ctx-viewer-office" sandbox="" src="${_ctxOfficeBlobUrl}"${style} title="${escapeHtml(rel)}"></iframe>`;
  els.actionsEl.innerHTML = `
    <button class="btn btn-sm" id="ctx-viewer-reveal">${escapeHtml(t('contexts.viewer.open_system'))}</button>
    <button class="btn btn-sm btn-danger" id="ctx-viewer-del">${escapeHtml(t('contexts.viewer.delete'))}</button>
  `;
  els.actionsEl.querySelector('#ctx-viewer-reveal').addEventListener('click', () => revealCtxFile(rel));
  els.actionsEl.querySelector('#ctx-viewer-del').addEventListener('click', _deleteCtxFromViewer);
  els.bodyEl.scrollTop = 0;
}

async function revealCtxFile(rel) {
  try {
    const res = await apiFetch('/api/contexts/reveal', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: rel }),
    });
    const data = await res.json();
    if (!data.ok) await uiAlert(t('contexts.reveal_failed'));
  } catch (_) {
    await uiAlert(t('contexts.reveal_failed'));
  }
}

function _prepCtxViewerShell(rel) {
  _ctxActive = { id: rel };
  if (_ctxOfficeBlobUrl) {
    try { URL.revokeObjectURL(_ctxOfficeBlobUrl); } catch (_) { /* ignore */ }
    _ctxOfficeBlobUrl = null;
  }
  // Tear down the previous md mount before switching files — otherwise the
  // outgoing controller's textarea-input listeners would still react to the
  // about-to-be-replaced DOM and the drafts map could record updates against
  // the wrong rel.
  if (_ctxMveController) { try { _ctxMveController.destroy(); } catch (_) {} _ctxMveController = null; }
  const empty = document.getElementById('contexts-editor-empty');
  const wrap = document.getElementById('contexts-viewer-wrap');
  const pathEl = document.getElementById('contexts-editor-path');
  if (!wrap) return null;
  empty.style.display = 'none';
  wrap.style.display = 'flex';
  pathEl.textContent = rel;
  renderCtxTree();
  // Deep-link navigation (search → file) may place the active row below the
  // fold of the scrollable tree pane; pull it into view so the highlight
  // is visible at a glance.
  _ctxScrollActiveIntoView();
  return {
    bodyEl: document.getElementById('contexts-viewer-body'),
    actionsEl: document.getElementById('contexts-viewer-actions'),
  };
}

// Per-file in-progress edit state, keyed by relpath. Survives switching to
// another KB file or to another sidebar tab — coming back to the file
// restores edit mode + the unsaved draft instead of dropping to read mode.
// Lifetime = renderer session (cleared on Save / Cancel / Delete; re-keyed
// on Rename). Not persisted across app restarts. Fed via the
// `onDraftChange` callback below.
const _ctxDrafts = new Map();

function _ctxClearDraft(path) {
  const key = path || (_ctxActive && _ctxActive.id);
  if (key) _ctxDrafts.delete(key);
}

function _showCtxTextViewer(rel, content) {
  const els = _prepCtxViewerShell(rel);
  if (!els) return;
  _ctxMveController = mountMdViewEdit({
    bodyEl: els.bodyEl,
    actionsEl: els.actionsEl,
    source: { kind: 'context', rel },
    // Skip the read round-trip — caller already has the bytes.
    initialContent: content,
    // Restore in-progress edits if the user was previously typing in this
    // file. mountMdViewEdit forces edit mode when `initialDraft` is present.
    initialDraft: _ctxDrafts.get(rel) || null,
    callbacks: {
      // Mirror draft state into the per-file Map so it survives switching
      // to another file in the tree and back.
      onDraftChange: (draft) => {
        if (draft === null) _ctxDrafts.delete(rel);
        else _ctxDrafts.set(rel, draft);
      },
      onReveal: () => revealCtxFile(rel),
      onDelete: () => _deleteCtxFromViewer(),
      onSaved:  async () => { await loadContexts(); },
    },
  });
  els.bodyEl.scrollTop = 0;
}

function _enterCtxEdit() {
  if (_ctxMveController) _ctxMveController.setMode('edit');
}

function _showCtxImageViewer(rel, base64, mediaType, bytes) {
  const els = _prepCtxViewerShell(rel);
  if (!els) return;
  const src = `data:${mediaType};base64,${base64}`;
  const sizeKb = bytes ? ` · ${Math.round(bytes / 1024)}KB` : '';
  els.bodyEl.innerHTML = `
    <div class="ctx-viewer-image-wrap">
      <img class="ctx-viewer-image" src="${src}" alt="${escapeHtml(rel)}"/>
      <div class="ctx-viewer-image-meta">${escapeHtml(rel)}${sizeKb}</div>
    </div>
  `;
  els.actionsEl.innerHTML = `
    <button class="btn btn-sm" id="ctx-viewer-reveal">${escapeHtml(t('contexts.viewer.open_system'))}</button>
    <button class="btn btn-sm btn-danger" id="ctx-viewer-del">${escapeHtml(t('contexts.viewer.delete'))}</button>
  `;
  els.actionsEl.querySelector('#ctx-viewer-reveal').addEventListener('click', () => revealCtxFile(rel));
  els.actionsEl.querySelector('#ctx-viewer-del').addEventListener('click', _deleteCtxFromViewer);
  els.bodyEl.scrollTop = 0;
}

function _showCtxBinaryViewer(rel, kind) {
  const els = _prepCtxViewerShell(rel);
  if (!els) return;
  const kindLabel = t(`contexts.viewer.kind_${kind}`) || kind.toUpperCase();
  const icon = (typeof window !== 'undefined' && typeof window.fileKindIconHtml === 'function')
    ? window.fileKindIconHtml(rel, kind)
    : '';
  els.bodyEl.innerHTML = `
    <div class="ctx-viewer-binary">
      <div class="ctx-viewer-binary-icon">${icon}</div>
      <div class="ctx-viewer-binary-name">${escapeHtml(rel)}</div>
      <div class="ctx-viewer-binary-hint">${escapeHtml(t('contexts.viewer.binary_hint', { kind: kindLabel }))}</div>
      <button class="btn btn-primary" id="ctx-viewer-reveal-big">${escapeHtml(t('contexts.viewer.open_system'))}</button>
    </div>
  `;
  els.actionsEl.innerHTML = `
    <button class="btn btn-sm" id="ctx-viewer-reveal">${escapeHtml(t('contexts.viewer.open_system'))}</button>
    <button class="btn btn-sm btn-danger" id="ctx-viewer-del">${escapeHtml(t('contexts.viewer.delete'))}</button>
  `;
  const openHandler = () => revealCtxFile(rel);
  els.bodyEl.querySelector('#ctx-viewer-reveal-big')?.addEventListener('click', openHandler);
  els.actionsEl.querySelector('#ctx-viewer-reveal').addEventListener('click', openHandler);
  els.actionsEl.querySelector('#ctx-viewer-del').addEventListener('click', _deleteCtxFromViewer);
}

async function _deleteCtxFromViewer() {
  if (!_ctxActive) return;
  const rel = _ctxActive.id;
  const name = String(rel || '').split('/').pop() || rel;
  if (!(await uiConfirm(t('contexts.file.del_confirm', { name })))) return;
  try {
    const res = await apiFetch(`/api/contexts/delete?path=${encodeURIComponent(rel)}`, { method: 'DELETE' });
    const data = await res.json();
    if (!data.ok) { await uiAlert(t('contexts.delete_failed')); return; }
    _ctxClearDraft(rel);
    _clearCtxViewer();
    await loadContexts();
  } catch (_) {
    await uiAlert(t('contexts.delete_failed'));
  }
}

function _clearCtxViewer() {
  if (_ctxMveController) { try { _ctxMveController.destroy(); } catch (_) {} _ctxMveController = null; }
  _ctxActive = null;
  const empty = document.getElementById('contexts-editor-empty');
  const wrap = document.getElementById('contexts-viewer-wrap');
  if (empty) empty.style.display = 'flex';
  if (wrap) wrap.style.display = 'none';
}

// ── Init bindings ──

function initCtxBindings() {
  _bindCtxDetailDrop(document.getElementById('contexts-editor-col'));
  document.getElementById('ctx-tmp-new-btn')?.addEventListener('click', createNewCtxTmpDraft);
  document.getElementById('ctx-tmp-new-name')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); saveCtxTmpNew(); }
  });
  // Root ⋯ menu — entry point for new_text / new_folder / upload at root.
  // The "anchor" path is empty string for root.
  document.getElementById('ctx-root-menu-btn')?.addEventListener('click', (e) => {
    e.stopPropagation();
    _openCtxRowMenu(e.currentTarget, 'root', '');
  });
  // Global menu dismissers — outside click / Esc / scroll / resize / i18n.
  document.addEventListener('click', (e) => {
    const menu = document.getElementById('ctx-row-menu');
    if (!menu || menu.style.display === 'none') return;
    if (menu.contains(e.target)) return;
    if (e.target.closest('[data-menu], #ctx-root-menu-btn')) return;
    _closeCtxRowMenu();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') _closeCtxRowMenu();
  });
  window.addEventListener('scroll', _closeCtxRowMenu, true);
  window.addEventListener('resize', _closeCtxRowMenu);
}
initCtxBindings();

// Re-run on i18n change to keep tree labels / empty state fresh.
window.addEventListener('i18n-change', () => { _closeCtxRowMenu(); renderCtxTree(); });
