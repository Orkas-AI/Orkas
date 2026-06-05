// ─── Chat file preview ────────────────────────────────────────────────
// In-app overlay for files the LLM produced (green chips) and for non-image
// user attachment chips. Mirrors `chat-lightbox.js`'s lazy-singleton pattern;
// kept separate from it because the renderer logic per kind diverges enough
// (iframe vs. <div> vs. <pre> body, no zoom/pan) that one merged module
// would just be two co-located if-trees.
//
// Render strategies:
//   image (.png/.jpg/.jpeg/.webp/.gif) → delegate to openChatImageLightbox
//   video (.mp4/.webm/.mov/.m4v/.ogv)  → <video controls>
//   pdf   (.pdf)                       → <iframe> + Chromium PDFium
//   html  (.html/.htm)                 → sandbox="allow-scripts" iframe
//   md    (.md/.markdown)              → mountMdViewEdit (markdown toolbar
//                                        only fires here — that's the
//                                        contract the markdown editor
//                                        carries that text files don't)
//   text  (.txt/.json/.csv/.code…)     → mountTextViewEdit (<pre> view +
//                                        plain textarea edit, no toolbar)
//   else                               → uiConfirm "Open the folder?"
//
// chat-media://local/<abs> serves pdf/html bytes (streamed via
// serveFileRange — no JS-heap explosion even on huge files). Markdown / text
// go via the `produced.readText` IPC; that path slurps the whole file into
// the JS heap and crosses IPC, hence the 2 MB cap on the main side, hence
// the "too large → open folder" fallback below.
//
// Security:
//   - HTML iframe sandbox is "allow-scripts" ONLY — no allow-same-origin,
//     no allow-popups, no allow-top-navigation. `chat-media://` origin ≠
//     renderer origin, so SOP already blocks parent.* access; the sandbox
//     flags pre-empt top-window navigation and new-window pop.
//   - The reveal-in-folder header button goes through workspace.revealPath,
//     which the main process re-validates against the workspace + attachment
//     scope.
//
// Usage:
//   openChatFileViewer(absPath, displayName?, opts?)
//     opts.cid — pass through when the file is a per-conv attachment, so
//                main can include the cid's attachment dir in the reveal /
//                read scope. Workspace-only paths can omit it.
//     opts.projectId — pass through when the file belongs to a project file
//                pool so reveal / text preview can include that scope.

let _viewerEl = null;
let _viewerBody = null;
let _viewerTitle = null;
let _viewerRevealBtn = null;
let _viewerAddLibraryBtn = null;
let _viewerSaveAppBtn = null;
let _viewerMdActions = null;
let _viewerKeyHandler = null;
let _viewerCurrentPath = null;
let _viewerCurrentCid = null;
let _viewerCurrentProjectId = null;
// Active view/edit controller — md (mountMdViewEdit) or text
// (mountTextViewEdit). Both expose the same shape (`destroy / isDirty /
// getMode / setMode`), so the close path can teardown without branching.
let _viewerEditController = null;
let _viewerDirty = false;
let _viewerDiscardConfirmPending = false;
let _viewerRenderSeq = 0;

const _viewerLog = (typeof createLogger === 'function')
  ? createLogger('chat-file-viewer')
  : { warn: () => {}, info: () => {}, error: () => {} };

function _viewerTrack(action, data) {
  
}

function _viewerTrackError(action, data) {
  
}

// Extensions we'll try to render inline. Anything else falls through to the
// "unsupported — open folder?" dialog. Lists are intentionally narrow:
// adding a new ext here is fine, but the renderer should actually have
// something useful to do with it; otherwise the fallback is the better UX.
const _IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif']);
const _VIDEO_EXTS = new Set(['.mp4', '.webm', '.mov', '.m4v', '.ogv']);
const _MARKDOWN_EXTS = new Set(['.md', '.markdown']);
// Text exts: the source-as-text bucket. Keep code-ish exts here too so the
// user can peek at a generated script without leaving the app. No syntax
// highlighting in this round; <pre> with white-space:pre-wrap is enough.
const _TEXT_EXTS = new Set([
  '.txt', '.log',
  '.csv', '.tsv',
  '.json', '.yaml', '.yml',
  '.xml', '.ini', '.toml', '.conf',
  '.py', '.pyi',
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',
  '.sh', '.bash', '.zsh',
  '.rb', '.go', '.rs', '.java', '.kt',
  '.c', '.cpp', '.cc', '.h', '.hpp',
  '.css', '.scss', '.less',
  '.sql', '.graphql', '.gql',
]);

function _extOf(name) {
  if (!name) return '';
  const i = name.lastIndexOf('.');
  return i >= 0 ? name.slice(i).toLowerCase() : '';
}

// Pure kind classifier. Exposed as `_kindOf` for fixture tests via the
// CJS-bridge at the bottom of this file (PC/CLAUDE.md §9 escape hatch).
function _kindOf(name) {
  const ext = _extOf(name);
  if (_IMAGE_EXTS.has(ext)) return 'image';
  if (_VIDEO_EXTS.has(ext)) return 'video';
  if (ext === '.pdf') return 'pdf';
  if (ext === '.html' || ext === '.htm') return 'html';
  if (_MARKDOWN_EXTS.has(ext)) return 'markdown';
  if (_TEXT_EXTS.has(ext)) return 'text';
  return 'unsupported';
}

// Build `chat-media://local/<abs>` URL. Matches main-side _pathnameToAbsPath:
// strip the leading `/` on Unix (the parser adds it back via pathname); on
// Windows replace `\` with `/`. encodeURI (not encodeURIComponent) preserves
// the `/` separators while escaping spaces / non-ASCII so URL parsing on
// the main side stays well-formed.
function _chatMediaLocalUrl(absPath) {
  let p = String(absPath || '');
  // Normalize Windows drive paths: `C:\a\b` → `C:/a/b`.
  if (p.includes('\\')) p = p.replace(/\\/g, '/');
  // Strip the single leading slash on Unix so the abs path becomes the URL
  // path; main re-adds it. Win paths start with `C:` so this branch is a
  // no-op there.
  if (p.startsWith('/')) p = p.slice(1);
  return `chat-media://local/${encodeURI(p)}`;
}

// Localized label helper — falls back to the English fallback when i18n
// tables aren't loaded yet (mirrors dialogs.js).
function _viewerLabel(key, fallback) {
  try { const v = t(key); return v === key ? fallback : v; } catch (_) { return fallback; }
}

function _viewerLabelVars(key, fallback, vars) {
  try {
    const v = t(key, vars || undefined);
    return v === key ? fallback : v;
  } catch (_) {
    return fallback;
  }
}

function _viewerUiIconHtml(name, className) {
  if (typeof window !== 'undefined' && typeof window.uiIconHtml === 'function') {
    return window.uiIconHtml(name, className);
  }
  return '';
}

function _viewerAddLibraryButtonHtml(_label, iconName = 'database') {
  return _viewerUiIconHtml(iconName, 'chat-file-viewer-add-library-icon');
}

function _viewerSaveAppButtonHtml(_label, iconName = 'layout-grid') {
  return _viewerUiIconHtml(iconName, 'chat-file-viewer-save-app-icon');
}

function _setViewerButtonLabel(btn, label) {
  if (!btn) return;
  btn.setAttribute('aria-label', label);
  btn.setAttribute('title', label);
  btn.dataset.tooltip = label;
}

function _setSaveAppVisible(visible) {
  if (!_viewerSaveAppBtn) return;
  _viewerSaveAppBtn.hidden = !visible;
  _viewerSaveAppBtn.disabled = !visible;
}

function _isViewerOpen() {
  return !!(_viewerEl && _viewerEl.classList.contains('is-open'));
}

function _ensureViewer() {
  if (_viewerEl) return _viewerEl;
  const root = document.createElement('div');
  root.className = 'chat-file-viewer';
  root.setAttribute('aria-hidden', 'true');
  const closeLabel = _viewerLabel('chat.preview_close_title', 'Close');
  const revealLabel = _viewerLabel('chat.preview_reveal_title', 'Open in folder');
  const addLibraryLabel = _viewerLabel('chat.preview_add_library_title', 'Add to Library');
  const saveAppLabel = _viewerLabel('apps.save_from_file_action', 'Save as app');
  const folderIcon = _viewerUiIconHtml('folder', 'chat-file-viewer-folder-icon');
  root.innerHTML = `
    <div class="chat-file-viewer-backdrop"></div>
    <div class="chat-file-viewer-stage">
      <div class="chat-file-viewer-header">
        <span class="chat-file-viewer-title"></span>
        <div class="chat-file-viewer-actions">
          <div class="chat-file-viewer-md-actions"></div>
          <button type="button" class="chat-file-viewer-add-library" aria-label="${addLibraryLabel}" title="${addLibraryLabel}" data-tooltip="${addLibraryLabel}">
            ${_viewerAddLibraryButtonHtml(addLibraryLabel)}
          </button>
          <button type="button" class="chat-file-viewer-save-app" aria-label="${saveAppLabel}" title="${saveAppLabel}" data-tooltip="${saveAppLabel}" hidden>
            ${_viewerSaveAppButtonHtml(saveAppLabel)}
          </button>
          <button type="button" class="chat-file-viewer-reveal" aria-label="${revealLabel}" title="${revealLabel}" data-tooltip="${revealLabel}">${folderIcon}</button>
          <button type="button" class="chat-file-viewer-close" aria-label="${closeLabel}" title="${closeLabel}" data-tooltip="${closeLabel}">×</button>
        </div>
      </div>
      <div class="chat-file-viewer-body"></div>
    </div>
  `;
  document.body.appendChild(root);

  _viewerEl = root;
  _viewerBody = root.querySelector('.chat-file-viewer-body');
  _viewerTitle = root.querySelector('.chat-file-viewer-title');
  _viewerRevealBtn = root.querySelector('.chat-file-viewer-reveal');
  _viewerAddLibraryBtn = root.querySelector('.chat-file-viewer-add-library');
  _viewerSaveAppBtn = root.querySelector('.chat-file-viewer-save-app');
  _viewerMdActions = root.querySelector('.chat-file-viewer-md-actions');

  // i18n change → re-label the icon-only buttons. Same lazy listener pattern
  // as chat-lightbox; the singleton is created on first open so the
  // listener doesn't leak per re-open.
  window.addEventListener('i18n-change', () => {
    if (!_viewerEl) return;
    const c = _viewerEl.querySelector('.chat-file-viewer-close');
    const r = _viewerEl.querySelector('.chat-file-viewer-reveal');
    const a = _viewerEl.querySelector('.chat-file-viewer-add-library');
    const s = _viewerEl.querySelector('.chat-file-viewer-save-app');
    const cl = _viewerLabel('chat.preview_close_title', 'Close');
    const rl = _viewerLabel('chat.preview_reveal_title', 'Open in folder');
    const al = _viewerLabel('chat.preview_add_library_title', 'Add to Library');
    const sl = _viewerLabel('apps.save_from_file_action', 'Save as app');
    _setViewerButtonLabel(c, cl);
    _setViewerButtonLabel(r, rl);
    if (a) {
      _setViewerButtonLabel(a, al);
      if (!a.disabled) a.innerHTML = _viewerAddLibraryButtonHtml(al);
    }
    if (s) {
      _setViewerButtonLabel(s, sl);
      if (!s.disabled) s.innerHTML = _viewerSaveAppButtonHtml(sl);
    }
  });

  root.querySelector('.chat-file-viewer-close').addEventListener('click', closeChatFileViewer);
  _viewerRevealBtn.addEventListener('click', _onRevealClick);
  _viewerAddLibraryBtn.addEventListener('click', _onAddLibraryClick);
  _viewerSaveAppBtn.addEventListener('click', _onSaveAppClick);

  return root;
}

async function _confirmDiscardViewerEdits() {
  if (!_viewerDirty) return true;
  if (_viewerDiscardConfirmPending) return false;
  _viewerDiscardConfirmPending = true;
  const message = _viewerLabel('chat.md_drawer.close_confirm', 'Discard unsaved changes?');
  try {
    return typeof uiConfirm === 'function' ? await uiConfirm(message) : false;
  } finally {
    _viewerDiscardConfirmPending = false;
  }
}

function _teardownViewerContent() {
  if (_viewerEditController) {
    try { _viewerEditController.destroy(); }
    catch (err) { _viewerLog.warn('edit controller destroy threw', err); }
  }
  _viewerEditController = null;
  _viewerDirty = false;
  if (_viewerBody) _viewerBody.innerHTML = '';
  if (_viewerMdActions) _viewerMdActions.innerHTML = '';
  if (_viewerEl) _viewerEl.classList.remove('is-markdown', 'is-text');
}

function _typesetViewerMarkdown() {
  if (typeof typesetMath !== 'function' || !_viewerBody) return;
  try { typesetMath(_viewerBody); } catch (_) { /* non-fatal */ }
}

async function _onRevealClick() {
  const p = _viewerCurrentPath;
  if (!p) return;
  _viewerTrack('file_preview_reveal', { kind: _kindOf(p), has_cid: !!_viewerCurrentCid, has_project: !!_viewerCurrentProjectId });
  try {
    const payload = { path: p };
    if (_viewerCurrentCid) payload.cid = _viewerCurrentCid;
    if (_viewerCurrentProjectId) payload.projectId = _viewerCurrentProjectId;
    const res = await window.orkas.invoke('workspace.revealPath', payload);
    if (!res || !res.ok) {
      _viewerTrackError('file_preview_reveal', { kind: _kindOf(p), msg: res && res.error || 'failed' });
      _viewerLog.warn('reveal failed', { path: p, error: res && res.error });
    }
  } catch (err) {
    _viewerTrackError('file_preview_reveal', { kind: _kindOf(p), msg: String(err && err.message || err) });
    _viewerLog.warn('reveal threw', { path: p, error: String(err && err.message || err) });
  }
}

async function _onAddLibraryClick() {
  const p = _viewerCurrentPath;
  if (!p || !_viewerCurrentCid || !_viewerAddLibraryBtn || _viewerAddLibraryBtn.disabled) return;
  _viewerTrack('file_preview_add_library', { kind: _kindOf(p), has_project: !!_viewerCurrentProjectId });
  const label = _viewerLabel('chat.preview_add_library_title', 'Add to Library');
  const doneLabel = _viewerLabel('chat.preview_add_library_done', 'Added');
  const original = _viewerAddLibraryButtonHtml(label);
  _viewerAddLibraryBtn.disabled = true;
  try {
    const payload = { path: p };
    if (_viewerCurrentCid) payload.cid = _viewerCurrentCid;
    if (_viewerCurrentProjectId) payload.projectId = _viewerCurrentProjectId;
    const res = await window.orkas.invoke('library.importProduced', payload);
    if (!res || !res.ok) throw new Error((res && res.error) || 'failed');
    _viewerTrack('file_preview_add_library_ok', { kind: _kindOf(p), scope: res.scope || '' });
    _viewerAddLibraryBtn.innerHTML = _viewerAddLibraryButtonHtml(doneLabel, 'check');
    if (res.scope === 'global' && typeof currentView !== 'undefined' && currentView === 'contexts' && typeof loadContexts === 'function') {
      loadContexts();
    }
    if (res.scope === 'project' && res.projectId && typeof currentView !== 'undefined' && currentView === 'project' && typeof loadProjectDetail === 'function') {
      loadProjectDetail(res.projectId).catch(() => {});
    }
  } catch (err) {
    const reason = String(err && err.message || err);
    _viewerTrackError('file_preview_add_library', { kind: _kindOf(p), msg: reason });
    _viewerLog.warn('add to library failed', { path: p, error: reason });
    if (typeof uiAlert === 'function') {
      let message = `Add to Library failed: ${reason}`;
      if (typeof t === 'function') {
        try {
          const got = t('chat.preview_add_library_failed_with', { reason });
          if (got && got !== 'chat.preview_add_library_failed_with') message = got;
        } catch (_) { /* keep fallback */ }
      }
      await uiAlert(message);
    }
  } finally {
    setTimeout(() => {
      if (!_viewerAddLibraryBtn) return;
      _viewerAddLibraryBtn.innerHTML = original;
      _viewerAddLibraryBtn.disabled = false;
    }, 1500);
  }
}

function _viewerFileActionPayload(path) {
  const payload = { path };
  if (_viewerCurrentCid) payload.cid = _viewerCurrentCid;
  if (_viewerCurrentProjectId) payload.projectId = _viewerCurrentProjectId;
  return payload;
}

async function _refreshSaveAppButton(path) {
  if (!_viewerSaveAppBtn) return;
  _setSaveAppVisible(false);
  if (!path) return;
  try {
    const inspected = await window.orkas.invoke('savedApps.inspectBundleFromPath', _viewerFileActionPayload(path));
    if (!_isViewerOpen() || _viewerCurrentPath !== path) return;
    const canSave = !!(inspected && inspected.ok !== false && inspected.canSave);
    _setSaveAppVisible(canSave);
  } catch (err) {
    if (!_isViewerOpen() || _viewerCurrentPath !== path) return;
    _viewerLog.warn('inspect app bundle failed', { path, error: String(err && err.message || err) });
    _setSaveAppVisible(false);
  }
}

async function _onSaveAppClick() {
  const p = _viewerCurrentPath;
  if (!p || !_viewerSaveAppBtn || _viewerSaveAppBtn.disabled) return;
  _viewerTrack('file_preview_save_app', { kind: _kindOf(p), has_project: !!_viewerCurrentProjectId });
  if (_viewerDirty) {
    _viewerTrack('file_preview_save_app_dirty_blocked');
    const message = _viewerLabel('apps.save_from_file_dirty', 'Save the file changes before saving it as an app.');
    if (typeof uiAlert === 'function') await uiAlert(message);
    return;
  }
  const label = _viewerLabel('apps.save_from_file_action', 'Save as app');
  const doneLabel = _viewerLabel('apps.saved_toast', 'Saved to My Apps');
  const original = _viewerSaveAppButtonHtml(label);
  _setSaveAppVisible(false);
  try {
    const res = await window.orkas.invoke('savedApps.saveFromPath', _viewerFileActionPayload(p));
    if (!res || res.ok === false) throw new Error((res && res.error) || 'failed');
    _viewerTrack('file_preview_save_app_ok', { kind: _kindOf(p) });
    _viewerSaveAppBtn.innerHTML = _viewerSaveAppButtonHtml(doneLabel, 'check');
    if (typeof uiToast === 'function') uiToast(doneLabel, { variant: 'success' });
    else if (typeof uiAlert === 'function') await uiAlert(doneLabel);
    try { if (typeof loadSavedApps === 'function') loadSavedApps(true); } catch (_) {}
  } catch (err) {
    const reason = String(err && err.message || err);
    _viewerTrackError('file_preview_save_app', { kind: _kindOf(p), msg: reason });
    _viewerLog.warn('save as app failed', { path: p, error: reason });
    if (typeof uiAlert === 'function') {
      const prefix = _viewerLabel('apps.save_failed', 'Could not save the app');
      await uiAlert(`${prefix}: ${reason}`);
    }
  } finally {
    setTimeout(() => {
      if (!_viewerSaveAppBtn) return;
      _viewerSaveAppBtn.innerHTML = original;
      _refreshSaveAppButton(p);
    }, 1500);
  }
}

async function _openViewerShell(displayName, opts) {
  const el = _ensureViewer();
  if (!(await _confirmDiscardViewerEdits())) return null;
  _teardownViewerContent();
  _viewerRenderSeq += 1;
  const absPath = opts && opts.absPath;
  const cid = (opts && opts.cid) || null;
  const projectId = (opts && opts.projectId) || null;
  _viewerCurrentPath = absPath || null;
  _viewerCurrentCid = cid;
  _viewerCurrentProjectId = projectId;
  if (_viewerAddLibraryBtn) _viewerAddLibraryBtn.hidden = !cid;
  void _refreshSaveAppButton(_viewerCurrentPath);
  _viewerTitle.textContent = displayName || '';
  // `is-markdown` / `is-text` switch the body to a flex column so an editor
  // textarea can fill the available height. View-mode `<pre>` and view-mode
  // markdown both rely on this same layout — see style.css §chat-file-viewer
  // for the per-class rules.
  if (opts && opts.kind === 'markdown') el.classList.add('is-markdown');
  if (opts && opts.kind === 'text') el.classList.add('is-text');
  el.classList.add('is-open');
  el.setAttribute('aria-hidden', 'false');
  if (!_viewerKeyHandler) {
    _viewerKeyHandler = (e) => {
      if (!_isViewerOpen()) return;
      // IME guard: Esc commits IME composition cancel — don't double-fire close.
      if (e.isComposing || e.keyCode === 229) return;
      const active = document.activeElement;
      if (active && active.tagName === 'TEXTAREA' && active.closest('.chat-file-viewer')) return;
      if (e.key === 'Escape') void closeChatFileViewer();
    };
    document.addEventListener('keydown', _viewerKeyHandler);
  }
  return _viewerRenderSeq;
}

async function closeChatFileViewer(opts) {
  if (!_viewerEl) return;
  const force = !!(opts && opts.force);
  if (!force && !(await _confirmDiscardViewerEdits())) return false;
  _viewerTrack('file_preview_close', { force, dirty: !!_viewerDirty, kind: _viewerCurrentPath ? _kindOf(_viewerCurrentPath) : '' });
  _viewerRenderSeq += 1;
  _viewerEl.classList.remove('is-open');
  _viewerEl.setAttribute('aria-hidden', 'true');
  // Drop iframe / blob src so big preview docs can be GC'd promptly when
  // the user closes the overlay. Without this, hidden iframes keep the
  // PDFium / HTML document alive in memory until the next reopen.
  _teardownViewerContent();
  _viewerCurrentPath = null;
  _viewerCurrentCid = null;
  _viewerCurrentProjectId = null;
  if (_viewerAddLibraryBtn) _viewerAddLibraryBtn.hidden = true;
  if (_viewerSaveAppBtn) _viewerSaveAppBtn.hidden = true;
  if (_viewerKeyHandler) {
    document.removeEventListener('keydown', _viewerKeyHandler);
    _viewerKeyHandler = null;
  }
  return true;
}

// ── Per-kind body builders ───────────────────────────────────────────────

async function _renderPdfBody(absPath, displayName, cid, projectId) {
  if (!(await _openViewerShell(displayName, { kind: 'pdf', absPath, cid, projectId }))) return;
  const url = _chatMediaLocalUrl(absPath);
  // `#toolbar=1&navpanes=0` are Chromium PDFium control hints (keep toolbar,
  // hide left sidebar). Same pattern as the KB context PDF viewer.
  _viewerBody.innerHTML = `<iframe class="chat-file-viewer-pdf" src="${url}#toolbar=1&navpanes=0" title="${escapeHtml(displayName || '')}"></iframe>`;
}

async function _renderHtmlBody(absPath, displayName, cid, projectId) {
  if (!(await _openViewerShell(displayName, { kind: 'html', absPath, cid, projectId }))) return;
  const url = _chatMediaLocalUrl(absPath);
  // sandbox: allow-scripts ONLY. chat-media:// is a distinct origin from
  // file://, so SOP blocks parent.* access; we additionally forbid
  // allow-same-origin (no cookie / localStorage / sibling-fetch reach),
  // allow-popups (no window.open), and allow-top-navigation (no top-frame
  // redirects). Self-contained LLM-generated HTML still runs its inline
  // scripts and styles.
  const sandbox = 'allow-scripts';
  _viewerBody.innerHTML = `<iframe class="chat-file-viewer-html" sandbox="${sandbox}" src="${url}" title="${escapeHtml(displayName || '')}"></iframe>`;
}

async function _renderVideoBody(absPath, displayName, cid, projectId) {
  if (!(await _openViewerShell(displayName, { kind: 'video', absPath, cid, projectId }))) return;
  const url = _chatMediaLocalUrl(absPath);
  _viewerBody.innerHTML = `<div class="chat-file-viewer-video-wrap"><video class="chat-file-viewer-video" controls preload="metadata" src="${url}"></video></div>`;
}

async function _renderMarkdownBody(absPath, displayName, cid, projectId) {
  const seq = await _openViewerShell(displayName, { kind: 'markdown', absPath, cid, projectId });
  if (!seq) return;
  _viewerBody.innerHTML = `<div class="chat-file-viewer-loading">…</div>`;
  const text = await _readTextFile(absPath, cid, projectId, seq);
  if (text === null || seq !== _viewerRenderSeq || !_isViewerOpen()) return; // _readTextFile already routed to the fallback dialog
  if (typeof mountMdViewEdit !== 'function') {
    _viewerLog.warn('mountMdViewEdit missing; falling back to read-only markdown preview');
    const md = (typeof renderMarkdown === 'function') ? renderMarkdown(text) : escapeHtml(text);
    _viewerBody.innerHTML = `<div class="chat-file-viewer-md">${md}</div>`;
    _typesetViewerMarkdown();
    return;
  }
  _viewerEditController = mountMdViewEdit({
    bodyEl: _viewerBody,
    actionsEl: _viewerMdActions,
    source: { kind: 'workspace', absPath, cid: cid || undefined, projectId: projectId || undefined },
    capabilities: projectId
      ? { edit: false, save: false, delete: false, reveal: false, taskCheckbox: false }
      : { reveal: false, delete: false },
    initialMode: 'view',
    initialContent: text,
    actionIconOnly: true,
    callbacks: {
      onDirtyChange: (dirty) => { _viewerDirty = !!dirty; },
      onSaved: () => _typesetViewerMarkdown(),
    },
  });
  _typesetViewerMarkdown();
}

async function _renderTextBody(absPath, displayName, cid, projectId) {
  const seq = await _openViewerShell(displayName, { kind: 'text', absPath, cid, projectId });
  if (!seq) return;
  _viewerBody.innerHTML = `<div class="chat-file-viewer-loading">…</div>`;
  // Pre-fetch via _readTextFile so the too_large / read-failure path falls
  // back to the "open the folder?" dialog (same UX as the read-only path
  // before). On success, hand the text to mountTextViewEdit; it owns the
  // view ↔ edit transitions, save IPC, and dirty tracking from there.
  const text = await _readTextFile(absPath, cid, projectId, seq);
  if (text === null || seq !== _viewerRenderSeq || !_isViewerOpen()) return;
  if (typeof mountTextViewEdit !== 'function') {
    _viewerLog.warn('mountTextViewEdit missing; falling back to read-only text preview');
    _viewerBody.innerHTML = `<pre class="chat-file-viewer-text">${escapeHtml(text)}</pre>`;
    return;
  }
  _viewerEditController = mountTextViewEdit({
    bodyEl: _viewerBody,
    actionsEl: _viewerMdActions,
    source: { absPath, cid: cid || undefined, projectId: projectId || undefined },
    // Project Library files are read-only by design (the LLM owns project workspace
    // mutations); workspace / per-conv attachments allow edit + save.
    capabilities: projectId ? { edit: false, save: false } : { edit: true, save: true },
    initialMode: 'view',
    initialContent: text,
    actionIconOnly: true,
    callbacks: {
      onDirtyChange: (dirty) => { _viewerDirty = !!dirty; },
    },
  });
}

// Fetch a file's text via IPC. Returns the text on success; on rejection
// surfaces the fallback dialog (and returns null so the caller knows to
// stop). Closes the overlay before showing the dialog so it doesn't stack
// on top of a half-built viewer.
async function _readTextFile(absPath, cid, projectId, seq) {
  _viewerCurrentPath = absPath;
  _viewerCurrentCid = cid || null;
  _viewerCurrentProjectId = projectId || null;
  try {
    const payload = { path: absPath };
    if (cid) payload.cid = cid;
    if (projectId) payload.projectId = projectId;
    const res = await window.orkas.invoke('produced.readText', payload);
    if (seq && seq !== _viewerRenderSeq) return null;
    if (res && res.ok) return String(res.text || '');
    // Specifically distinguish too_large so the user sees "file is X MB,
    // open in folder?" instead of a generic failure.
    const err = (res && res.error) || 'unknown';
    await closeChatFileViewer({ force: true });
    if (err === 'too_large') {
      const sizeMb = ((res && res.size) || 0) / 1024 / 1024;
      const capMb = ((res && res.cap) || 2 * 1024 * 1024) / 1024 / 1024;
      await _showUnsupportedDialog(absPath, cid, projectId, {
        messageKey: 'chat.preview_too_large_message',
        vars: { name: absPath.split(/[\\/]/).pop() || absPath, size: sizeMb.toFixed(1), cap: capMb.toFixed(0) },
        fallback: `File is ${sizeMb.toFixed(1)} MB (over the ${capMb.toFixed(0)} MB preview cap). Open the containing folder?`,
      });
    } else {
      await _showUnsupportedDialog(absPath, cid, projectId, {
        messageKey: 'chat.preview_read_failed_message',
        vars: { name: absPath.split(/[\\/]/).pop() || absPath },
        fallback: 'Could not read this file. Open the containing folder?',
      });
    }
    return null;
  } catch (e) {
    if (seq && seq !== _viewerRenderSeq) return null;
    _viewerLog.warn('readText threw', { path: absPath, error: String(e && e.message || e) });
    await closeChatFileViewer({ force: true });
    await _showUnsupportedDialog(absPath, cid, projectId, {
      messageKey: 'chat.preview_read_failed_message',
      vars: { name: absPath.split(/[\\/]/).pop() || absPath },
      fallback: 'Could not read this file. Open the containing folder?',
    });
    return null;
  }
}

// Fallback dialog: explain to the user that we can't preview this file
// inline, and offer to open the folder it lives in. uiConfirm returns true
// on the (relabeled) primary button.
async function _showUnsupportedDialog(absPath, cid, projectId, opts) {
  const name = absPath.split(/[\\/]/).pop() || absPath;
  const ext = _extOf(name) || _viewerLabel('chat.preview_unsupported_no_ext', '(no extension)');
  const message = opts && opts.messageKey
    ? _viewerLabel(opts.messageKey, opts.fallback || '')
    : _viewerLabel('chat.preview_unsupported_message', `Cannot preview ${ext} files in app. Open the containing folder?`);
  // i18n substitution: do the {var} replace ourselves — `t()` only
  // substitutes when called with `vars`, but _viewerLabel hides that. Reach
  // through to `t` directly with vars when we have them.
  let final = message;
  if (opts && opts.vars && typeof t === 'function') {
    try {
      const v = t(opts.messageKey, opts.vars);
      if (v && v !== opts.messageKey) final = v;
    } catch (_) { /* keep fallback */ }
  } else if (typeof t === 'function') {
    try {
      const v = t('chat.preview_unsupported_message', { ext });
      if (v && v !== 'chat.preview_unsupported_message') final = v;
    } catch (_) { /* keep fallback */ }
  }
  const okLabel = _viewerLabel('chat.preview_unsupported_reveal', 'Open Folder');
  const cancelLabel = _viewerLabel('chat.preview_cancel', 'Close');
  const ok = await uiConfirm({ message: final, okLabel, cancelLabel });
  if (!ok) return;
  try {
    const payload = { path: absPath };
    if (cid) payload.cid = cid;
    if (projectId) payload.projectId = projectId;
    const res = await window.orkas.invoke('workspace.revealPath', payload);
    if (!res || !res.ok) _viewerLog.warn('fallback reveal failed', { path: absPath, error: res && res.error });
  } catch (err) {
    _viewerLog.warn('fallback reveal threw', { path: absPath, error: String(err && err.message || err) });
  }
}

async function _ensureViewerFileExists(absPath, cid, projectId) {
  if (!window.orkas || typeof window.orkas.invoke !== 'function') return true;
  try {
    const payload = { path: absPath };
    if (cid) payload.cid = cid;
    if (projectId) payload.projectId = projectId;
    const res = await window.orkas.invoke('workspace.statPath', payload);
    if (res && res.ok && res.exists && res.isFile !== false) return true;
    if (res && res.ok && res.exists && res.isFile === false) return true;
    const name = String(absPath || '').split(/[\\/]/).pop() || String(absPath || '');
    const message = _viewerLabelVars(
      'chat.file_missing_toast',
      'The file no longer exists.',
      { name }
    );
    if (typeof uiToast === 'function') uiToast(message, { variant: 'warning' });
    else if (typeof uiAlert === 'function') await uiAlert(message);
    return false;
  } catch (err) {
    _viewerLog.warn('statPath threw', { path: absPath, error: String(err && err.message || err) });
    return true;
  }
}

// ── Public entry point ───────────────────────────────────────────────────

async function openChatFileViewer(absPath, displayName, opts) {
  if (!absPath) return;
  const cid = (opts && opts.cid) || null;
  const projectId = (opts && opts.projectId) || null;
  const name = displayName || (absPath.split(/[\\/]/).pop() || absPath);
  const exists = await _ensureViewerFileExists(absPath, cid, projectId);
  if (!exists) return;
  const kind = _kindOf(name);
  _viewerTrack('file_preview_open', { kind, has_cid: !!cid, has_project: !!projectId });

  if (kind === 'image') {
    // Delegate — the image lightbox already has zoom / pan / keyboard. We
    // need the chat-media:// URL since openChatImageLightbox expects an
    // <img>-loadable src, not an abs path.
    if (typeof openChatImageLightbox === 'function') {
      openChatImageLightbox(_chatMediaLocalUrl(absPath), name, cid ? { absPath, cid, projectId } : undefined);
    }
    return;
  }
  if (kind === 'pdf')      return _renderPdfBody(absPath, name, cid, projectId);
  if (kind === 'video')    return _renderVideoBody(absPath, name, cid, projectId);
  if (kind === 'html')     return _renderHtmlBody(absPath, name, cid, projectId);
  if (kind === 'markdown') return _renderMarkdownBody(absPath, name, cid, projectId);
  if (kind === 'text')     return _renderTextBody(absPath, name, cid, projectId);
  // unsupported — go straight to the dialog, never open the shell.
  return _showUnsupportedDialog(absPath, cid, projectId, {});
}

// CJS bridge for vitest — pure functions only, per PC/CLAUDE.md §9.
if (typeof module !== 'undefined' && typeof module.exports === 'object') {
  module.exports = { _kindOf, _extOf, _chatMediaLocalUrl };
}
