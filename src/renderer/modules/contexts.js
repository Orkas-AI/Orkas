const _contextsLog = createLogger('contexts');
// ─── Knowledge base (contexts) ───
// Single user-owned directory tree at `<uid>/cloud/contexts/`.
// Mutations (write / upload / mkdir / rename / delete) hit the backend directly;
// the backend enqueues `kb_indexer` jobs that produce status transitions
// broadcast back to the UI via `/api/kb/events/stream` (chips update live).

let _ctxTree = [];                  // tree of {name, path, type:'dir'|'file', children?, bytes?, mtime?}
let _ctxExpanded = new Set();       // dir paths that are open
let _ctxActive = null;              // {id, content} — currently opened file in right-pane
let _ctxPendingRename = null;       // {path} — flagged for inline-rename on the
                                    // next renderCtxTree() (set by the "new
                                    // text file" action after creating an
                                    // untitled file so the user can rename
                                    // immediately, and by the ⋯ menu's
                                    // "rename" item).
let _kbStatusByPath = {};           // {[path]: {status, chunks?, error?, kind?}}
let _kbEventsAbort = null;

async function loadContexts() {
  try {
    const [treeRes, kbRes] = await Promise.all([
      apiFetch('/api/contexts/tree'),
      apiFetch('/api/kb/status'),
    ]);
    const treeData = await treeRes.json();
    const kbData = await kbRes.json().catch(() => ({ ok: false }));
    if (treeData.ok) _ctxTree = treeData.tree || [];
    if (kbData.ok) {
      const next = {};
      for (const f of kbData.files || []) {
        next[f.path] = {
          status: f.status, chunks: f.chunks, error: f.error, kind: f.kind,
        };
      }
      // Any file that's physically on disk (tree) but not yet in kb_files
      // (backend status response) is queued behind the kb_indexer worker —
      // show 'pending' instead of leaving the chip blank. Without this, a
      // multi-file upload would silently have all-but-the-first file look
      // fully processed until the worker actually reached them.
      for (const p of _collectCtxFilePaths(_ctxTree)) {
        if (!next[p]) next[p] = { status: 'pending' };
      }
      _kbStatusByPath = next;
    }
    renderCtxTree();
    _ensureKbEventSubscription();
  } catch (e) {
    _contextsLog.error('load contexts failed', e);
  }
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
      _kbEventsAbort = null;
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
}

function _cssEscape(s) {
  return String(s).replace(/(["\\])/g, '\\$1');
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
    const err = st.error ? `${t('contexts.kb.failed')}: ${st.error}` : t('contexts.kb.failed');
    return `<span class="ctx-kb-chip is-failed" data-kb-reprocess title="${escapeHtml(err)}">!</span>`;
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

// ── Tree render ──

function renderCtxTree() {
  const container = document.getElementById('contexts-tree');
  if (!container) return;
  if (!_ctxTree.length) {
    container.innerHTML = `<div class="empty">${escapeHtml(t('contexts.empty'))}</div>`;
    return;
  }
  container.innerHTML = _renderCtxNodes(_ctxTree);
  _bindCtxTreeHandlers(container);
}

function _renderCtxNodes(nodes, depth = 0) {
  const indent = 10 + depth * 14;
  const moreTitle = escapeHtml(t('contexts.menu.more_actions'));
  return nodes.map(n => {
    const isPendingRename = _ctxPendingRename && _ctxPendingRename.path === n.path;
    if (n.type === 'dir') {
      const open = _ctxExpanded.has(n.path);
      const caretCls = open ? 'skill-tree-caret' : 'skill-tree-caret collapsed';
      const icon = open ? ICON_FOLDER_OPEN : ICON_FOLDER_CLOSED;
      const childrenHtml = open
        ? `<div class="skill-tree-children">${_renderCtxNodes(n.children || [], depth + 1)}</div>`
        : '';
      const labelHtml = isPendingRename
        ? `<input class="ctx-tree-rename-input" type="text" value="${escapeHtml(n.name)}" autocomplete="off" spellcheck="false" />`
        : `<span class="skill-tree-label">${escapeHtml(n.name)}</span>`;
      return `
        <div class="ctx-tree-wrap" data-path="${escapeHtml(n.path)}" data-type="dir" draggable="true">
          <div class="skill-tree-node skill-tree-dir" style="padding-left:${indent}px">
            <span class="${caretCls}">▶</span>
            <span class="skill-tree-icon icon-folder">${icon}</span>
            ${labelHtml}
            <button type="button" class="ctx-row-menu-btn" data-menu title="${moreTitle}" aria-label="${moreTitle}">⋯</button>
          </div>
          ${childrenHtml}
        </div>
      `;
    }
    const active = _ctxActive && _ctxActive.id === n.path ? ' active' : '';
    const ext = (n.name.split('.').pop() || '').toLowerCase();
    const chip = _kbStatusChipHtml(n.path);
    // Inline-rename mode for a freshly-created "untitled.md" or for the rename
    // menu item — the label becomes an input autofocused with the stem
    // selected. Committed on Enter / blur; Esc keeps the file as-is. See
    // `_bindCtxTreeHandlers` for the handlers.
    const labelHtml = isPendingRename
      ? `<input class="ctx-tree-rename-input" type="text" value="${escapeHtml(n.name)}" autocomplete="off" spellcheck="false" />`
      : `<span class="skill-tree-label">${escapeHtml(n.name)}</span>`;
    return `
      <div class="ctx-tree-wrap" data-path="${escapeHtml(n.path)}" data-type="file" draggable="true">
        <div class="skill-tree-node skill-tree-file${active}" data-ext="${escapeHtml(ext)}" style="padding-left:${indent}px">
          <span class="skill-tree-caret skill-tree-caret-empty"></span>
          <span class="skill-tree-icon icon-file" data-ext="${escapeHtml(ext)}">${ICON_FILE}</span>
          ${labelHtml}
          ${chip}
          <button type="button" class="ctx-row-menu-btn" data-menu title="${moreTitle}" aria-label="${moreTitle}">⋯</button>
        </div>
      </div>
    `;
  }).join('');
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
        _openCtxRowMenu(e.target.closest('[data-menu]'), kind, rel);
        return;
      }
      if (e.target.closest('[data-kb-reprocess]')) {
        e.stopPropagation();
        await reprocessCtxKbFile(rel);
        return;
      }
      e.stopPropagation();
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
      e.dataTransfer.setData('application/x-context-path', rel);
      e.dataTransfer.effectAllowed = 'move';
      wrap.classList.add('is-dragging');
    });
    wrap.addEventListener('dragend', () => wrap.classList.remove('is-dragging'));

    if (kind === 'dir') {
      const hover = (e) => {
        e.preventDefault();
        e.stopPropagation();
        e.dataTransfer.dropEffect = 'move';
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
        e.preventDefault();
        e.stopPropagation();
        node.classList.remove('is-drag-over');
        const src = e.dataTransfer.getData('application/x-context-path');
        if (src) await _handleCtxMove(src, rel);
      });
    }
  });

  // Root drop zone — empty area of the tree container itself accepts drops
  // to move items back to the root. Suppressed when dragging from the root
  // (no-op move) is left to `_handleCtxMove`'s validation.
  if (!container.dataset.dndRootBound) {
    container.dataset.dndRootBound = '1';
    container.addEventListener('dragover', (e) => {
      // Only highlight when dragging over the bare container (not over a row).
      if (e.target.closest('.ctx-tree-wrap')) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      container.classList.add('is-root-drag-over');
    });
    container.addEventListener('dragleave', (e) => {
      if (e.currentTarget.contains(e.relatedTarget)) return;
      container.classList.remove('is-root-drag-over');
    });
    container.addEventListener('drop', async (e) => {
      if (e.target.closest('.ctx-tree-wrap')) return;
      e.preventDefault();
      container.classList.remove('is-root-drag-over');
      const src = e.dataTransfer.getData('application/x-context-path');
      if (src) await _handleCtxMove(src, '');
    });
  }
}

// ── Row-level actions ──

async function reprocessCtxKbFile(rel) {
  try {
    const res = await apiFetch('/api/kb/reprocess', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: rel }),
    });
    const data = await res.json();
    if (!data.ok) await uiAlert(data.error || t('contexts.kb.reprocess_failed'));
  } catch (e) {
    await uiAlert(t('contexts.kb.reprocess_failed_with', { reason: e.message || e }));
  }
}

async function deleteCtxEntry(rel, kind) {
  const prompt = kind === 'dir'
    ? t('contexts.dir.del_confirm', { rel })
    : t('contexts.file.del_confirm', { rel });
  if (!(await uiConfirm(prompt))) return;
  try {
    const res = await apiFetch(`/api/contexts/delete?path=${encodeURIComponent(rel)}`, { method: 'DELETE' });
    const data = await res.json();
    if (!data.ok) { await uiAlert(data.error || t('contexts.delete_failed')); return; }
    if (_ctxActive && (_ctxActive.id === rel || _ctxActive.id.startsWith(rel + '/'))) {
      _clearCtxViewer();
    }
    await loadContexts();
  } catch (e) {
    await uiAlert(t('contexts.delete_failed_with', { reason: e.message || e }));
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
  menu.innerHTML = items.map(it =>
    `<div class="ctx-row-menu-item${it.danger ? ' is-danger' : ''}" data-action="${escapeHtml(it.action)}">${escapeHtml(it.label)}</div>`
  ).join('');
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
      { action: 'new_todo',   label: t('contexts.menu.new_todo') },
      { action: 'new_folder', label: t('contexts.menu.new_folder') },
      { action: 'upload',     label: t('contexts.menu.upload') },
    ];
  }
  if (kind === 'dir') {
    return [
      { action: 'new_text',   label: t('contexts.menu.new_text') },
      { action: 'new_todo',   label: t('contexts.menu.new_todo') },
      { action: 'new_folder', label: t('contexts.menu.new_folder') },
      { action: 'upload',     label: t('contexts.menu.upload') },
      { action: 'rename',     label: t('contexts.menu.rename') },
      { action: 'delete',     label: t('contexts.menu.delete'), danger: true },
    ];
  }
  // file
  const items = [];
  if (CTX_TEXT_EXTS.has(_ctxExtOf(relPath))) {
    items.push({ action: 'edit', label: t('contexts.menu.edit') });
  }
  items.push({ action: 'open_in_system', label: t('contexts.menu.open_in_system') });
  items.push({ action: 'rename', label: t('contexts.menu.rename') });
  items.push({ action: 'delete', label: t('contexts.menu.delete'), danger: true });
  return items;
}

async function _runCtxMenuAction(action, kind, relPath) {
  const dirArg = kind === 'root' ? '' : relPath;  // for new_text / new_todo / new_folder / upload
  switch (action) {
    case 'new_text':   return createCtxNewTextFile(dirArg);
    case 'new_todo':   return createCtxNewTodoFile(dirArg);
    case 'new_folder': return promptCtxNewInDir(dirArg);
    case 'upload': {
      const input = document.getElementById('ctx-file-input');
      if (input) { input.dataset.targetDir = dirArg; input.click(); }
      return;
    }
    case 'rename':     return renameCtxEntry(relPath, kind);
    case 'delete':     return deleteCtxEntry(relPath, kind);
    case 'edit':       { await openCtxFile(relPath); _enterCtxEdit(); return; }
    case 'open_in_system': return revealCtxFile(relPath);
  }
}

// Move src to live under targetDir (empty string = root). Defends against
// no-op moves, dropping into self, or dropping into own descendants. On
// backend conflict / failure shows a uiAlert.
async function _handleCtxMove(srcRel, targetDir) {
  if (!srcRel) return;
  const base = srcRel.includes('/') ? srcRel.slice(srcRel.lastIndexOf('/') + 1) : srcRel;
  const dst = targetDir ? `${targetDir}/${base}` : base;
  if (dst === srcRel) return;
  // Reject moves into self or own subtree (only meaningful for dirs but the
  // check is cheap and correct for files too).
  if (targetDir === srcRel || targetDir.startsWith(srcRel + '/')) {
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
    if (!data.ok) { await uiAlert(data.error || t('contexts.entry.rename_failed')); return; }
    // Carry over expanded / active state so the moved item stays visible.
    if (_ctxActive && _ctxActive.id === srcRel) _ctxActive.id = dst;
    if (_ctxExpanded.has(srcRel)) { _ctxExpanded.delete(srcRel); _ctxExpanded.add(dst); }
    if (targetDir) _ctxExpanded.add(targetDir);
    await loadContexts();
  } catch (e) {
    await uiAlert(t('contexts.entry.rename_failed_with', { reason: e.message || e }));
  }
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
    if (!data.ok) { await uiAlert(data.error || t('contexts.entry.rename_failed')); await loadContexts(); return; }
    if (_ctxActive && _ctxActive.id === rel) _ctxActive.id = dst;
    await loadContexts();
  } catch (e) {
    await uiAlert(t('contexts.entry.rename_failed_with', { reason: e.message || e }));
    await loadContexts();
  }
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
    if (!data.ok) { msg.textContent = data.error || t('contexts.dir.create_failed'); msg.className = 'form-msg err'; return; }
    _ctxExpanded.add(joined);
    closeCtxNewModal();
    if (_ctxNewTargetDir) _ctxExpanded.add(_ctxNewTargetDir);
    await loadContexts();
  } catch (e) {
    msg.textContent = t('contexts.network_error', { reason: e.message || e });
    msg.className = 'form-msg err';
  }
}
window.saveCtxNew = saveCtxNew;

// "+ text" handler — no modal. Writes an empty "untitled.md" (disambiguated if
// one already exists in that dir), opens it in the right pane, flags it
// for inline rename on the next tree render, and immediately drops the
// viewer into edit mode so the user can start typing content.
async function createCtxNewTextFile(parentDir = '') {
  const stemBase = t('contexts.new.untitled_stem') || 'untitled';
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
    if (!data.ok) { await uiAlert(data.error || t('contexts.file.create_failed')); return; }
    if (parentDir) _ctxExpanded.add(parentDir);
    _ctxPendingRename = { path: fullPath };
    await loadContexts();
    // Show the file in the right pane already in edit mode (empty textarea
    // + Save/Cancel actions). `_ctxPendingRename` will be consumed by the
    // next renderCtxTree() call.
    _showCtxTextViewer(fullPath, '');
    _enterCtxEdit();
  } catch (e) {
    await uiAlert(t('contexts.network_error', { reason: e.message || e }));
  }
}

// "+ todo list" handler — mirrors `createCtxNewTextFile` but seeds the file
// with a minimal task-list template so the user lands on something usable.
// Stored as plain .md (GitHub-style `- [ ]` syntax) — interactive checkbox
// behavior is layered on by the KB viewer; the file itself stays portable
// and indexable like any other md note.
async function createCtxNewTodoFile(parentDir = '') {
  const stemBase = t('contexts.new.todo_stem') || 'todo list';
  const siblings = _ctxListChildren(parentDir).map(n => n.name);
  let stem = stemBase;
  let i = 2;
  while (siblings.includes(`${stem}.md`)) { stem = `${stemBase} ${i++}`; }
  const name = `${stem}.md`;
  const fullPath = parentDir ? `${parentDir}/${name}` : name;
  const heading = t('contexts.new.todo_template_heading') || 'Todo';
  const template = `# ${heading}\n\n- [ ] \n- [ ] \n- [ ] \n`;
  try {
    const res = await apiFetch('/api/contexts/write', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: fullPath, content: template }),
    });
    const data = await res.json();
    if (!data.ok) { await uiAlert(data.error || t('contexts.file.create_failed')); return; }
    if (parentDir) _ctxExpanded.add(parentDir);
    _ctxPendingRename = { path: fullPath };
    await loadContexts();
    _showCtxTextViewer(fullPath, template);
    _enterCtxEdit();
  } catch (e) {
    await uiAlert(t('contexts.network_error', { reason: e.message || e }));
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
  '.pdf', '.docx', '.png', '.jpg', '.jpeg', '.webp', '.gif',
];

function _ctxExtOf(name) {
  const i = (name || '').lastIndexOf('.');
  return i >= 0 ? name.slice(i).toLowerCase() : '';
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
  const jobs = files.map(async (file) => {
    const ext = _ctxExtOf(file.name);
    if (!CTX_ALLOWED_EXTS.includes(ext)) return { ok: false, name: file.name, reason: 'ext' };
    try {
      const buf = await file.arrayBuffer();
      const target = targetDir ? `${targetDir}/${file.name}` : file.name;
      _kbStatusByPath[target] = { status: 'pending' };
      const res = await apiFetch('/api/contexts/upload', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/octet-stream',
          'X-Filename': encodeURIComponent(target),
        },
        body: buf,
      });
      const data = await res.json();
      if (!data.ok) {
        delete _kbStatusByPath[target];
        return { ok: false, name: file.name, reason: data.error || 'unknown' };
      }
      return { ok: true, name: file.name };
    } catch (e) {
      return { ok: false, name: file.name, reason: e.message || String(e) };
    }
  });
  let results;
  try {
    results = await Promise.all(jobs);
    // Single post-upload refresh picks up all new rows at once.
    await loadContexts();
  } finally {
    if (statusEl) statusEl.style.display = 'none';
  }

  const rejected = results.filter((r) => !r.ok);
  for (const r of rejected) {
    _contextsLog.warn('upload failed', r.name, r.reason);
  }
  if (rejected.length) {
    await uiAlert(t('contexts.upload_rejected', {
      exts: CTX_ALLOWED_EXTS.join(' / '),
      list: rejected.map((r) => r.reason === 'ext' ? r.name : `${r.name}(${r.reason})`).join('\n'),
    }));
  }
}

// ── Viewer (right pane) ──
// Dispatches on file extension:
//   - text kinds        → markdown editor (read + edit + delete)
//   - image kinds       → inline <img> via base64
//   - pdf / docx / else → stub card ("use system app"); clicking opens the
//                         file in the OS default viewer. We still provide
//                         delete + "open in system" actions for consistency.

const CTX_TEXT_EXTS = new Set([
  '.md', '.markdown', '.txt', '.csv', '.tsv', '.json', '.yaml', '.yml', '.log',
]);
const CTX_IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif']);

function _kindOfPath(rel) {
  const ext = _ctxExtOf(rel);
  if (CTX_TEXT_EXTS.has(ext)) return 'text';
  if (CTX_IMAGE_EXTS.has(ext)) return 'image';
  if (ext === '.pdf') return 'pdf';
  if (ext === '.docx') return 'docx';
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
      if (!data.ok) { await uiAlert(data.error || t('contexts.read_failed')); return; }
      _showCtxTextViewer(rel, data.content || '');
    } else if (kind === 'image') {
      const res = await apiFetch(`/api/contexts/image?path=${encodeURIComponent(rel)}`);
      const data = await res.json();
      if (!data.ok) { await uiAlert(data.error || t('contexts.read_failed')); return; }
      _showCtxImageViewer(rel, data.base64, data.mediaType, data.bytes);
    } else if (kind === 'pdf') {
      // Let Chromium's built-in PDFium render inline via the kb-file://
      // protocol registered in main/index.ts. Encoding: path segments are
      // URL-encoded individually so CJK filenames survive but `/` boundaries
      // stay visible to the router.
      _showCtxPdfViewer(rel);
    } else if (kind === 'docx') {
      const res = await apiFetch(`/api/contexts/docx?path=${encodeURIComponent(rel)}`);
      const data = await res.json();
      if (!data.ok) { await uiAlert(data.error || t('contexts.read_failed')); return; }
      _showCtxDocxViewer(rel, data.html || '');
    } else {
      _showCtxBinaryViewer(rel, kind);
      revealCtxFile(rel);
    }
  } catch (e) {
    await uiAlert(t('contexts.read_failed_with', { reason: e.message || e }));
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

async function revealCtxFile(rel) {
  try {
    const res = await apiFetch('/api/contexts/reveal', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: rel }),
    });
    const data = await res.json();
    if (!data.ok) await uiAlert(data.error || t('contexts.reveal_failed'));
  } catch (e) {
    await uiAlert(t('contexts.reveal_failed_with', { reason: e.message || e }));
  }
}

function _prepCtxViewerShell(rel) {
  _ctxActive = { id: rel, content: '' };
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

function _showCtxTextViewer(rel, content) {
  const els = _prepCtxViewerShell(rel);
  if (!els) return;
  _ctxActive.content = content;
  _renderCtxViewerMd(els.bodyEl, els.actionsEl);
  els.bodyEl.scrollTop = 0;
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
  els.bodyEl.innerHTML = `
    <div class="ctx-viewer-binary">
      <div class="ctx-viewer-binary-icon">${kind === 'pdf' ? '📄' : kind === 'docx' ? '📘' : '📎'}</div>
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

function _renderCtxViewerMd(bodyEl, actionsEl) {
  if (!_ctxActive) return;
  bodyEl = bodyEl || document.getElementById('contexts-viewer-body');
  actionsEl = actionsEl || document.getElementById('contexts-viewer-actions');
  const content = _ctxActive.content || '';
  bodyEl.innerHTML = `<div class="ctx-viewer-md markdown-body">${renderMarkdown(content)}</div>`;
  // After md render, walk the emitted `.task-item` checkboxes (renderMarkdown
  // emits them `disabled`) and wire them up to write back to the file. Order
  // of `.task-item` lis in DOM matches the order of `^(\s*)- \[( |x|X)\] `
  // lines in source by construction (renderMarkdown does not reorder).
  _ctxBindTaskCheckboxes(bodyEl);
  actionsEl.innerHTML = `
    <button class="btn btn-sm" id="ctx-viewer-edit">${escapeHtml(t('contexts.viewer.edit'))}</button>
    <button class="btn btn-sm" id="ctx-viewer-reveal">${escapeHtml(t('contexts.viewer.open_system'))}</button>
    <button class="btn btn-sm btn-danger" id="ctx-viewer-del">${escapeHtml(t('contexts.viewer.delete'))}</button>
  `;
  actionsEl.querySelector('#ctx-viewer-edit').addEventListener('click', _enterCtxEdit);
  actionsEl.querySelector('#ctx-viewer-reveal').addEventListener('click', () => revealCtxFile(_ctxActive.id));
  actionsEl.querySelector('#ctx-viewer-del').addEventListener('click', _deleteCtxFromViewer);
}

// Regex shared by checkbox-binding (preview side) and the editor's Todo
// toolbar button. Captures: 1=indent, 2=mark ( /x/X), 3=rest of line.
const _CTX_TODO_LINE_RE = /^(\s*)- \[( |x|X)\] (.*)$/;

// Scan source content for task-list lines. Returns `[{ lineIdx, checked }, ...]`
// in source order. The Nth entry corresponds to the Nth `.task-item` in the
// rendered DOM (renderMarkdown preserves source order for list items).
function _ctxScanTaskLines(content) {
  const lines = content.split('\n');
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(_CTX_TODO_LINE_RE);
    if (m) out.push({ lineIdx: i, checked: m[2].toLowerCase() === 'x' });
  }
  return out;
}

function _ctxBindTaskCheckboxes(rootEl) {
  if (!rootEl || !_ctxActive) return;
  const tasks = _ctxScanTaskLines(_ctxActive.content || '');
  const boxes = rootEl.querySelectorAll('.task-item input[type="checkbox"]');
  // Defensive: if the two counts diverge (e.g., user has malformed markdown
  // that renderMarkdown rescued differently), bail out rather than mis-wire.
  if (boxes.length !== tasks.length) return;
  boxes.forEach((box, i) => {
    box.removeAttribute('disabled');
    const li = box.closest('li.task-item');
    if (tasks[i].checked && li) li.classList.add('is-done');
    box.addEventListener('change', () => _ctxToggleTask(tasks[i].lineIdx, li, box));
  });
}

async function _ctxToggleTask(lineIdx, liEl, boxEl) {
  if (!_ctxActive) return;
  const lines = (_ctxActive.content || '').split('\n');
  const m = (lines[lineIdx] || '').match(_CTX_TODO_LINE_RE);
  if (!m) return;
  const wasChecked = m[2].toLowerCase() === 'x';
  const nextMark = wasChecked ? ' ' : 'x';
  lines[lineIdx] = `${m[1]}- [${nextMark}] ${m[3]}`;
  const next = lines.join('\n');
  // Optimistic UI — flip the `is-done` style + the box state immediately;
  // revert if the save round-trip fails.
  if (liEl) liEl.classList.toggle('is-done', !wasChecked);
  if (boxEl) boxEl.checked = !wasChecked;
  try {
    const res = await apiFetch('/api/contexts/update', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: _ctxActive.id, content: next }),
    });
    const data = await res.json();
    if (!data.ok) throw new Error(data.error || 'save_failed');
    _ctxActive.content = next;
  } catch (e) {
    if (liEl) liEl.classList.toggle('is-done', wasChecked);
    if (boxEl) boxEl.checked = wasChecked;
    await uiAlert(t('contexts.todo.save_failed', { reason: e.message || e }));
  }
}

// Editor mode = textarea + markdown toolbar; preview mode = renderMarkdown of
// the current draft. The draft is only persisted to disk on Save — the
// in-memory _ctxActive.content stays at the last-saved value, so Cancel can
// revert without re-fetch.
let _ctxEditPreview = false;
let _ctxEditDraft = '';

// Toolbar definition. `kind` keys map to `_ctxApplyMd()` cases; `icon` uses
// Unicode glyphs only (CLAUDE.md §8 — no colored emoji on process-info-style
// rails); `label` is the i18n key for the title tooltip.
const _CTX_EDITOR_TOOLBAR = [
  { kind: 'h1', icon: 'H1', label: 'contexts.editor.tb.h1' },
  { kind: 'h2', icon: 'H2', label: 'contexts.editor.tb.h2' },
  { kind: 'h3', icon: 'H3', label: 'contexts.editor.tb.h3' },
  { kind: 'sep' },
  { kind: 'bold', icon: 'B', label: 'contexts.editor.tb.bold', cls: 'is-bold' },
  { kind: 'italic', icon: 'I', label: 'contexts.editor.tb.italic', cls: 'is-italic' },
  { kind: 'strike', icon: 'S', label: 'contexts.editor.tb.strike', cls: 'is-strike' },
  { kind: 'sep' },
  { kind: 'ul', icon: '•', label: 'contexts.editor.tb.ul' },
  { kind: 'ol', icon: '1.', label: 'contexts.editor.tb.ol' },
  { kind: 'quote', icon: '“', label: 'contexts.editor.tb.quote' },
  { kind: 'sep' },
  { kind: 'code', icon: '<>', label: 'contexts.editor.tb.code' },
  { kind: 'codeblock', icon: '{ }', label: 'contexts.editor.tb.codeblock' },
  { kind: 'sep' },
  { kind: 'link', icon: '↗', label: 'contexts.editor.tb.link' },
  { kind: 'image', icon: '▣', label: 'contexts.editor.tb.image' },
  { kind: 'sep' },
  { kind: 'todo', icon: '☐', label: 'contexts.editor.tb.todo' },
];

function _enterCtxEdit() {
  if (!_ctxActive) return;
  _ctxEditPreview = false;
  _ctxEditDraft = _ctxActive.content || '';
  _ctxRenderEditor();
}

function _ctxRenderEditor() {
  const bodyEl = document.getElementById('contexts-viewer-body');
  const actionsEl = document.getElementById('contexts-viewer-actions');
  if (!bodyEl || !actionsEl) return;
  const toolbarHtml = _CTX_EDITOR_TOOLBAR.map(item => {
    if (item.kind === 'sep') return `<span class="ctx-editor-toolbar-sep" aria-hidden="true"></span>`;
    const disabled = _ctxEditPreview ? 'disabled' : '';
    const extraCls = item.cls ? ` ${item.cls}` : '';
    return `<button type="button" class="btn btn-sm btn-icon ctx-editor-tb-btn${extraCls}" data-kind="${item.kind}" title="${escapeHtml(t(item.label))}" ${disabled}>${escapeHtml(item.icon)}</button>`;
  }).join('');
  const toggleKey = _ctxEditPreview ? 'contexts.editor.tb.edit_back' : 'contexts.editor.tb.preview';
  const toggleIcon = _ctxEditPreview ? '✎' : '◐';
  const draft = _ctxEditDraft;
  const bodyHtml = _ctxEditPreview
    ? `<div class="ctx-viewer-md markdown-body ctx-editor-preview">${draft.trim() ? renderMarkdown(draft) : `<div class="ctx-viewer-msg">${escapeHtml(t('contexts.editor.preview_empty'))}</div>`}</div>`
    : `<textarea class="ctx-viewer-editor" id="ctx-viewer-textarea" spellcheck="false">${escapeHtml(draft)}</textarea>`;
  bodyEl.innerHTML = `
    <div class="ctx-editor-toolbar" role="toolbar">
      ${toolbarHtml}
      <span class="ctx-editor-toolbar-spacer"></span>
      <button type="button" class="btn btn-sm ctx-editor-toggle" id="ctx-editor-toggle" title="${escapeHtml(t(toggleKey))}">${toggleIcon} ${escapeHtml(t(toggleKey))}</button>
    </div>
    <div class="ctx-editor-body">${bodyHtml}</div>
  `;
  actionsEl.innerHTML = `
    <button class="btn btn-sm btn-primary" id="ctx-viewer-save">${escapeHtml(t('contexts.viewer.save'))}</button>
    <button class="btn btn-sm" id="ctx-viewer-cancel">${escapeHtml(t('contexts.viewer.cancel'))}</button>
  `;
  actionsEl.querySelector('#ctx-viewer-save').addEventListener('click', _saveCtxEdit);
  actionsEl.querySelector('#ctx-viewer-cancel').addEventListener('click', () => {
    _ctxEditPreview = false;
    _ctxEditDraft = '';
    _renderCtxViewerMd();
  });
  bodyEl.querySelector('#ctx-editor-toggle').addEventListener('click', _ctxTogglePreview);
  bodyEl.querySelectorAll('.ctx-editor-tb-btn').forEach(btn => {
    btn.addEventListener('mousedown', (e) => {
      // Prevent the textarea from losing focus on click (otherwise the cursor
      // position is lost and the inserted snippet lands at the end).
      e.preventDefault();
    });
    btn.addEventListener('click', () => {
      if (_ctxEditPreview) return;
      const ta = document.getElementById('ctx-viewer-textarea');
      if (!ta) return;
      _ctxApplyMd(ta, btn.dataset.kind);
    });
  });
  const ta = bodyEl.querySelector('#ctx-viewer-textarea');
  if (ta) {
    ta.addEventListener('keydown', (e) => _ctxOnKey(ta, e));
    ta.addEventListener('input', () => { _ctxEditDraft = ta.value; });
    ta.focus();
  }
}

function _ctxTogglePreview() {
  const ta = document.getElementById('ctx-viewer-textarea');
  if (ta) _ctxEditDraft = ta.value;
  _ctxEditPreview = !_ctxEditPreview;
  _ctxRenderEditor();
}

// Wrap-style ops toggle: if the selection is already wrapped with `mark`,
// unwrap it; otherwise insert the wrap (with the placeholder pre-selected
// when the selection is empty).
function _ctxWrapSelection(ta, mark, placeholder) {
  const start = ta.selectionStart;
  let end = ta.selectionEnd;
  const value = ta.value;
  // Trailing-newline clamp: when a user "selects a line" (triple-click /
  // Shift+Down) the selection often includes the trailing `\n`. Wrapping
  // that range would emit `**Hello\n**`, leaving the closing mark stranded
  // on the next line.
  while (end > start && value[end - 1] === '\n') end -= 1;
  const sel = value.slice(start, end);
  const before = value.slice(0, start);
  const after = value.slice(end);
  const markLen = mark.length;
  // Unwrap if the selection itself is wrapped, OR if the wrap marks are
  // immediately around the selection.
  if (sel.startsWith(mark) && sel.endsWith(mark) && sel.length >= markLen * 2) {
    const inner = sel.slice(markLen, sel.length - markLen);
    _ctxReplaceRange(ta, start, end, inner, start, start + inner.length);
    return;
  }
  if (
    before.endsWith(mark) &&
    after.startsWith(mark)
  ) {
    const newStart = start - markLen;
    const newEnd = end + markLen;
    _ctxReplaceRange(ta, newStart, newEnd, sel, newStart, newStart + sel.length);
    return;
  }
  const inner = sel || placeholder;
  const wrapped = `${mark}${inner}${mark}`;
  // If the selection was empty, leave the caret in the middle so the
  // placeholder is selected — the next keystroke replaces it.
  const innerStart = start + markLen;
  const innerEnd = innerStart + inner.length;
  _ctxReplaceRange(ta, start, end, wrapped, innerStart, innerEnd);
}

// Compute the line span (lineStart..lineEnd) covered by the current selection.
// **Trailing-newline clamp**: if the selection ends right after a `\n`, treat
// the selection as ending at the position before that `\n`. Without this,
// double-clicking / triple-clicking / Shift+Down to select a single line
// (which on most platforms grabs the trailing newline too) makes
// `indexOf('\n', selEnd)` find the NEXT line's terminator and the operation
// silently affects the line below.
function _ctxLineSpan(value, selStart, selEnd) {
  let effEnd = selEnd;
  if (effEnd > selStart && value[effEnd - 1] === '\n') effEnd -= 1;
  const lineStart = value.lastIndexOf('\n', selStart - 1) + 1;
  let lineEnd = value.indexOf('\n', effEnd);
  if (lineEnd === -1) lineEnd = value.length;
  return { lineStart, lineEnd };
}

// Heading op: replace any existing `^#+ ` prefix with the target level, or
// strip the prefix entirely if every line is already at the target level.
// Without this, applying H2 to a line that's already H1 would prepend a
// second `## ` and produce `## # Hello`.
function _ctxApplyHeading(ta, level) {
  const target = '#'.repeat(level) + ' ';
  const value = ta.value;
  const { lineStart, lineEnd } = _ctxLineSpan(value, ta.selectionStart, ta.selectionEnd);
  const block = value.slice(lineStart, lineEnd);
  const lines = block.split('\n');
  const stripHeading = (line) => line.replace(/^#{1,6} /, '');
  const isTarget = (line) => line === '' || line.startsWith(target);
  // Toggle: every line already at this level → strip headings entirely.
  if (lines.every(isTarget)) {
    const rebuilt = lines.map(stripHeading).join('\n');
    _ctxReplaceRange(ta, lineStart, lineEnd, rebuilt, lineStart, lineStart + rebuilt.length);
    return;
  }
  const rebuilt = lines.map(line => line === '' ? line : `${target}${stripHeading(line)}`).join('\n');
  _ctxReplaceRange(ta, lineStart, lineEnd, rebuilt, lineStart, lineStart + rebuilt.length);
}

// Todo three-state cycle (line-batch). The first non-empty selected line
// decides the target state for the whole batch:
//   - `- [ ] foo`  → `- [x] foo`        (mark batch as done)
//   - `- [x] foo`  → `foo`              (strip todo prefix entirely)
//   - anything else → `- [ ] foo`        (turn into a todo; first strips any
//                                         existing `- ` bullet so `- foo`
//                                         doesn't become `- [ ] - foo`)
function _ctxApplyTodo(ta) {
  const value = ta.value;
  const { lineStart, lineEnd } = _ctxLineSpan(value, ta.selectionStart, ta.selectionEnd);
  const block = value.slice(lineStart, lineEnd);
  const lines = block.split('\n');
  const placeholder = t('contexts.editor.placeholder.todo') || 'task';
  // Pick the mode from the first non-empty line.
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
    // mode === 'mark': turn the line into a todo. Drop any existing bullet
    // prefix (`- ` / `* ` / `+ ` / `1. `) so we don't double up.
    const body = rest.replace(/^([-*+]|\d+\.) +/, '') || placeholder;
    return `${indent}- [ ] ${body}`;
  }).join('\n');
  _ctxReplaceRange(ta, lineStart, lineEnd, rebuilt, lineStart, lineStart + rebuilt.length);
}

// Line-prefix ops: apply `prefix(idx)` to each selected line (or the caret
// line); toggle off if every line already carries the same prefix.
function _ctxLinePrefix(ta, prefixFn) {
  const value = ta.value;
  const { lineStart, lineEnd } = _ctxLineSpan(value, ta.selectionStart, ta.selectionEnd);
  const block = value.slice(lineStart, lineEnd);
  const lines = block.split('\n');
  // Toggle: if every non-empty line starts with the prefix (idx 0), strip it.
  const firstPrefix = prefixFn(0);
  const allMatch = lines.every(line => line.length === 0 || line.startsWith(firstPrefix));
  let rebuilt;
  if (allMatch && firstPrefix) {
    rebuilt = lines.map(line => line.startsWith(firstPrefix) ? line.slice(firstPrefix.length) : line).join('\n');
  } else {
    rebuilt = lines.map((line, idx) => `${prefixFn(idx)}${line}`).join('\n');
  }
  _ctxReplaceRange(ta, lineStart, lineEnd, rebuilt, lineStart, lineStart + rebuilt.length);
}

// Drop-in block insert (codeblock / link / image).
function _ctxInsertBlock(ta, opts) {
  const { text, selStart, selEnd } = opts;
  const start = ta.selectionStart;
  const end = ta.selectionEnd;
  _ctxReplaceRange(ta, start, end, text, start + selStart, start + selEnd);
}

function _ctxReplaceRange(ta, from, to, replacement, newSelStart, newSelEnd) {
  ta.setRangeText(replacement, from, to, 'preserve');
  ta.selectionStart = newSelStart;
  ta.selectionEnd = newSelEnd;
  _ctxEditDraft = ta.value;
  ta.focus();
}

function _ctxApplyMd(ta, kind) {
  switch (kind) {
    case 'bold':      return _ctxWrapSelection(ta, '**', t('contexts.editor.placeholder.bold'));
    case 'italic':    return _ctxWrapSelection(ta, '*',  t('contexts.editor.placeholder.italic'));
    case 'strike':    return _ctxWrapSelection(ta, '~~', t('contexts.editor.placeholder.strike'));
    case 'code':      return _ctxWrapSelection(ta, '`',  t('contexts.editor.placeholder.code'));
    case 'h1':        return _ctxApplyHeading(ta, 1);
    case 'h2':        return _ctxApplyHeading(ta, 2);
    case 'h3':        return _ctxApplyHeading(ta, 3);
    case 'quote':     return _ctxLinePrefix(ta, () => '> ');
    case 'ul':        return _ctxLinePrefix(ta, () => '- ');
    case 'ol':        return _ctxLinePrefix(ta, (i) => `${i + 1}. `);
    case 'todo':      return _ctxApplyTodo(ta);
    case 'codeblock': {
      const start = ta.selectionStart, end = ta.selectionEnd;
      const sel = ta.value.slice(start, end);
      const body = sel || t('contexts.editor.placeholder.code');
      // Ensure surrounding blank lines when the caret is mid-paragraph.
      const before = ta.value.slice(0, start);
      const after = ta.value.slice(end);
      const leadNl = before.length === 0 || before.endsWith('\n\n') ? '' : (before.endsWith('\n') ? '\n' : '\n\n');
      const tailNl = after.length === 0 || after.startsWith('\n\n') ? '' : (after.startsWith('\n') ? '\n' : '\n\n');
      const text = `${leadNl}\`\`\`\n${body}\n\`\`\`${tailNl}`;
      const innerStart = start + leadNl.length + 4; // after ```\n
      const innerEnd = innerStart + body.length;
      return _ctxInsertBlock(ta, { text, selStart: innerStart - start, selEnd: innerEnd - start });
    }
    case 'link': {
      const start = ta.selectionStart, end = ta.selectionEnd;
      const sel = ta.value.slice(start, end);
      const linkText = sel || t('contexts.editor.placeholder.link_text');
      const url = t('contexts.editor.placeholder.link_url');
      const text = `[${linkText}](${url})`;
      // Select the URL placeholder so the user can paste / type their URL.
      const urlStart = 1 + linkText.length + 2; // after "[text]("
      const urlEnd = urlStart + url.length;
      return _ctxInsertBlock(ta, { text, selStart: urlStart, selEnd: urlEnd });
    }
    case 'image': {
      const start = ta.selectionStart, end = ta.selectionEnd;
      const sel = ta.value.slice(start, end);
      const alt = sel || t('contexts.editor.placeholder.image_alt');
      const url = t('contexts.editor.placeholder.image_url');
      const text = `![${alt}](${url})`;
      const urlStart = 2 + alt.length + 2;
      const urlEnd = urlStart + url.length;
      return _ctxInsertBlock(ta, { text, selStart: urlStart, selEnd: urlEnd });
    }
  }
}

// Strip a leading list/quote marker; return null if the line isn't a list line.
function _ctxParseListPrefix(line) {
  const m = line.match(/^(\s*)([-*+]|\d+\.)(\s+)/);
  if (!m) return null;
  return { indent: m[1], marker: m[2], gap: m[3], total: m[0] };
}

function _ctxOnKey(ta, e) {
  // IME composition guard (CLAUDE.md §8) — Chinese / Japanese / Korean Enter
  // commits a candidate; don't fire shortcuts or list-continuation while a
  // composition is active.
  if (e.isComposing || e.keyCode === 229) return;

  const mod = e.metaKey || e.ctrlKey;
  if (mod && !e.shiftKey && !e.altKey) {
    const k = (e.key || '').toLowerCase();
    if (k === 'b') { e.preventDefault(); return _ctxApplyMd(ta, 'bold'); }
    if (k === 'i') { e.preventDefault(); return _ctxApplyMd(ta, 'italic'); }
    if (k === 'k') { e.preventDefault(); return _ctxApplyMd(ta, 'link'); }
    if (k === 's') { e.preventDefault(); return _saveCtxEdit(); }
  }

  if (e.key === 'Tab') {
    e.preventDefault();
    const start = ta.selectionStart;
    const end = ta.selectionEnd;
    const value = ta.value;
    const multiLine = value.slice(start, end).includes('\n');
    if (multiLine) {
      // Use the same trailing-newline-clamped span as the toolbar line ops,
      // so selecting "row1\nrow2\n" doesn't drag row3's leading column into
      // the indent batch.
      const { lineStart, lineEnd } = _ctxLineSpan(value, start, end);
      const block = value.slice(lineStart, lineEnd);
      const lines = block.split('\n');
      let rebuilt;
      if (e.shiftKey) {
        rebuilt = lines.map(l => l.replace(/^( {1,2}|\t)/, '')).join('\n');
      } else {
        rebuilt = lines.map(l => `  ${l}`).join('\n');
      }
      _ctxReplaceRange(ta, lineStart, lineEnd, rebuilt, lineStart, lineStart + rebuilt.length);
      return;
    }
    if (e.shiftKey) {
      const lineStart = value.lastIndexOf('\n', start - 1) + 1;
      const head = value.slice(lineStart, lineStart + 2);
      const strip = head === '  ' ? 2 : (head[0] === '\t' ? 1 : 0);
      if (strip) {
        const newStart = Math.max(lineStart, start - strip);
        _ctxReplaceRange(ta, lineStart, lineStart + strip, '', newStart, Math.max(newStart, end - strip));
      }
      return;
    }
    _ctxReplaceRange(ta, start, end, '  ', start + 2, start + 2);
    return;
  }

  if (e.key === 'Enter') {
    const value = ta.value;
    const start = ta.selectionStart;
    const end = ta.selectionEnd;
    if (start !== end) return; // non-empty selection: default behavior (replace)
    const lineStart = value.lastIndexOf('\n', start - 1) + 1;
    const lineSoFar = value.slice(lineStart, start);
    const parsed = _ctxParseListPrefix(lineSoFar);
    if (!parsed) return;
    // Empty list line → break out (remove the marker entirely).
    if (lineSoFar === parsed.total) {
      e.preventDefault();
      _ctxReplaceRange(ta, lineStart, start, '', lineStart, lineStart);
      return;
    }
    e.preventDefault();
    let nextMarker = parsed.marker;
    if (/^\d+\.$/.test(parsed.marker)) {
      const n = parseInt(parsed.marker, 10);
      nextMarker = `${n + 1}.`;
    }
    const insert = `\n${parsed.indent}${nextMarker}${parsed.gap}`;
    _ctxReplaceRange(ta, start, start, insert, start + insert.length, start + insert.length);
    return;
  }
}

async function _saveCtxEdit() {
  if (!_ctxActive) return;
  const ta = document.getElementById('ctx-viewer-textarea');
  // Textarea is only present in edit mode; preview mode saves from the draft
  // captured at the toggle point. Always sync the textarea value into the
  // draft first so the two paths converge.
  if (ta) _ctxEditDraft = ta.value;
  const next = _ctxEditDraft;
  try {
    const res = await apiFetch('/api/contexts/update', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: _ctxActive.id, content: next }),
    });
    const data = await res.json();
    if (!data.ok) { await uiAlert(data.error || t('contexts.save_failed')); return; }
    _ctxActive.content = next;
    _ctxEditPreview = false;
    _ctxEditDraft = '';
    _renderCtxViewerMd();
    await loadContexts();
  } catch (e) {
    await uiAlert(t('contexts.save_failed_with', { reason: e.message || e }));
  }
}

async function _deleteCtxFromViewer() {
  if (!_ctxActive) return;
  const rel = _ctxActive.id;
  if (!(await uiConfirm(t('contexts.file.del_confirm', { rel })))) return;
  try {
    const res = await apiFetch(`/api/contexts/delete?path=${encodeURIComponent(rel)}`, { method: 'DELETE' });
    const data = await res.json();
    if (!data.ok) { await uiAlert(data.error || t('contexts.delete_failed')); return; }
    _clearCtxViewer();
    await loadContexts();
  } catch (e) {
    await uiAlert(t('contexts.delete_failed_with', { reason: e.message || e }));
  }
}

function _clearCtxViewer() {
  _ctxActive = null;
  const empty = document.getElementById('contexts-editor-empty');
  const wrap = document.getElementById('contexts-viewer-wrap');
  if (empty) empty.style.display = 'flex';
  if (wrap) wrap.style.display = 'none';
}

// ── Init bindings ──

function initCtxBindings() {
  // Root ⋯ menu — entry point for new_text / new_folder / upload at root.
  // The "anchor" path is empty string for root.
  document.getElementById('ctx-root-menu-btn')?.addEventListener('click', (e) => {
    e.stopPropagation();
    _openCtxRowMenu(e.currentTarget, 'root', '');
  });
  // Hidden file input — both the root menu's "upload file" item and any
  // folder row's "upload file" route through here. Target dir is stashed on dataset before
  // .click() so this single handler routes correctly.
  document.getElementById('ctx-file-input')?.addEventListener('change', async (ev) => {
    const input = ev.target;
    const files = input.files;
    const targetDir = input.dataset.targetDir || '';
    try {
      await handleCtxUpload(files, targetDir);
    } finally {
      input.value = '';
      input.dataset.targetDir = '';
    }
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
