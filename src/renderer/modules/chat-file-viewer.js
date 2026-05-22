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
//   md    (.md/.markdown)              → renderMarkdown(text) in a <div>
//   text  (.txt/.json/.csv/.code…)     → <pre> with the source
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

let _viewerEl = null;
let _viewerBody = null;
let _viewerTitle = null;
let _viewerRevealBtn = null;
let _viewerKeyHandler = null;
let _viewerCurrentPath = null;
let _viewerCurrentCid = null;

const _viewerLog = (typeof createLogger === 'function')
  ? createLogger('chat-file-viewer')
  : { warn: () => {}, info: () => {}, error: () => {} };

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
  const folderIcon = (typeof window !== 'undefined' && typeof window.uiIconHtml === 'function')
    ? window.uiIconHtml('folder', 'chat-file-viewer-folder-icon')
    : '';
  root.innerHTML = `
    <div class="chat-file-viewer-backdrop"></div>
    <div class="chat-file-viewer-stage">
      <div class="chat-file-viewer-header">
        <span class="chat-file-viewer-title"></span>
        <div class="chat-file-viewer-actions">
          <button type="button" class="chat-file-viewer-reveal" aria-label="${revealLabel}" title="${revealLabel}">${folderIcon}</button>
          <button type="button" class="chat-file-viewer-close" aria-label="${closeLabel}" title="${closeLabel}">×</button>
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

  // i18n change → re-label the icon-only buttons. Same lazy listener pattern
  // as chat-lightbox; the singleton is created on first open so the
  // listener doesn't leak per re-open.
  window.addEventListener('i18n-change', () => {
    if (!_viewerEl) return;
    const c = _viewerEl.querySelector('.chat-file-viewer-close');
    const r = _viewerEl.querySelector('.chat-file-viewer-reveal');
    const cl = _viewerLabel('chat.preview_close_title', 'Close');
    const rl = _viewerLabel('chat.preview_reveal_title', 'Open in folder');
    if (c) { c.setAttribute('aria-label', cl); c.setAttribute('title', cl); }
    if (r) { r.setAttribute('aria-label', rl); r.setAttribute('title', rl); }
  });

  root.querySelector('.chat-file-viewer-backdrop').addEventListener('click', closeChatFileViewer);
  root.querySelector('.chat-file-viewer-close').addEventListener('click', closeChatFileViewer);
  _viewerRevealBtn.addEventListener('click', _onRevealClick);

  return root;
}

async function _onRevealClick() {
  const p = _viewerCurrentPath;
  if (!p) return;
  try {
    const payload = { path: p };
    if (_viewerCurrentCid) payload.cid = _viewerCurrentCid;
    const res = await window.orkas.invoke('workspace.revealPath', payload);
    if (!res || !res.ok) {
      _viewerLog.warn('reveal failed', { path: p, error: res && res.error });
    }
  } catch (err) {
    _viewerLog.warn('reveal threw', { path: p, error: String(err && err.message || err) });
  }
}

function _openViewerShell(displayName) {
  const el = _ensureViewer();
  _viewerTitle.textContent = displayName || '';
  _viewerBody.innerHTML = '';
  el.classList.add('is-open');
  el.setAttribute('aria-hidden', 'false');
  if (!_viewerKeyHandler) {
    _viewerKeyHandler = (e) => {
      if (!_isViewerOpen()) return;
      // IME guard: Esc commits IME composition cancel — don't double-fire close.
      if (e.isComposing || e.keyCode === 229) return;
      if (e.key === 'Escape') closeChatFileViewer();
    };
    document.addEventListener('keydown', _viewerKeyHandler);
  }
  return el;
}

function closeChatFileViewer() {
  if (!_viewerEl) return;
  _viewerEl.classList.remove('is-open');
  _viewerEl.setAttribute('aria-hidden', 'true');
  // Drop iframe / blob src so big preview docs can be GC'd promptly when
  // the user closes the overlay. Without this, hidden iframes keep the
  // PDFium / HTML document alive in memory until the next reopen.
  if (_viewerBody) _viewerBody.innerHTML = '';
  _viewerCurrentPath = null;
  _viewerCurrentCid = null;
  if (_viewerKeyHandler) {
    document.removeEventListener('keydown', _viewerKeyHandler);
    _viewerKeyHandler = null;
  }
}

// ── Per-kind body builders ───────────────────────────────────────────────

function _renderPdfBody(absPath, displayName) {
  _openViewerShell(displayName);
  const url = _chatMediaLocalUrl(absPath);
  // `#toolbar=1&navpanes=0` are Chromium PDFium control hints (keep toolbar,
  // hide left sidebar). Same pattern as the KB context PDF viewer.
  _viewerBody.innerHTML = `<iframe class="chat-file-viewer-pdf" src="${url}#toolbar=1&navpanes=0" title="${escapeHtml(displayName || '')}"></iframe>`;
}

function _renderHtmlBody(absPath, displayName) {
  _openViewerShell(displayName);
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

function _renderVideoBody(absPath, displayName) {
  _openViewerShell(displayName);
  const url = _chatMediaLocalUrl(absPath);
  _viewerBody.innerHTML = `<div class="chat-file-viewer-video-wrap"><video class="chat-file-viewer-video" controls preload="metadata" src="${url}"></video></div>`;
}

async function _renderMarkdownBody(absPath, displayName, cid) {
  _openViewerShell(displayName);
  _viewerBody.innerHTML = `<div class="chat-file-viewer-loading">…</div>`;
  const text = await _readTextFile(absPath, cid);
  if (text === null) return; // _readTextFile already routed to the fallback dialog
  // renderMarkdown is the single markdown surface; matches chat bubbles so
  // generated reports look identical here and inline.
  const md = (typeof renderMarkdown === 'function') ? renderMarkdown(text) : escapeHtml(text);
  _viewerBody.innerHTML = `<div class="chat-file-viewer-md">${md}</div>`;
  // Same async LaTeX typeset chat bubbles use. Skipped silently if math.js
  // isn't loaded (e.g. tests).
  if (typeof typesetMath === 'function') {
    try { typesetMath(_viewerBody); } catch (_) { /* non-fatal */ }
  }
}

async function _renderTextBody(absPath, displayName, cid) {
  _openViewerShell(displayName);
  _viewerBody.innerHTML = `<div class="chat-file-viewer-loading">…</div>`;
  const text = await _readTextFile(absPath, cid);
  if (text === null) return;
  _viewerBody.innerHTML = `<pre class="chat-file-viewer-text">${escapeHtml(text)}</pre>`;
}

// Fetch a file's text via IPC. Returns the text on success; on rejection
// surfaces the fallback dialog (and returns null so the caller knows to
// stop). Closes the overlay before showing the dialog so it doesn't stack
// on top of a half-built viewer.
async function _readTextFile(absPath, cid) {
  _viewerCurrentPath = absPath;
  _viewerCurrentCid = cid || null;
  try {
    const payload = { path: absPath };
    if (cid) payload.cid = cid;
    const res = await window.orkas.invoke('produced.readText', payload);
    if (res && res.ok) return String(res.text || '');
    // Specifically distinguish too_large so the user sees "file is X MB,
    // open in folder?" instead of a generic failure.
    const err = (res && res.error) || 'unknown';
    closeChatFileViewer();
    if (err === 'too_large') {
      const sizeMb = ((res && res.size) || 0) / 1024 / 1024;
      const capMb = ((res && res.cap) || 2 * 1024 * 1024) / 1024 / 1024;
      await _showUnsupportedDialog(absPath, cid, {
        messageKey: 'chat.preview_too_large_message',
        vars: { name: absPath.split(/[\\/]/).pop() || absPath, size: sizeMb.toFixed(1), cap: capMb.toFixed(0) },
        fallback: `File is ${sizeMb.toFixed(1)} MB (over the ${capMb.toFixed(0)} MB preview cap). Open the containing folder?`,
      });
    } else {
      await _showUnsupportedDialog(absPath, cid, {
        messageKey: 'chat.preview_read_failed_message',
        vars: { name: absPath.split(/[\\/]/).pop() || absPath },
        fallback: 'Could not read this file. Open the containing folder?',
      });
    }
    return null;
  } catch (e) {
    _viewerLog.warn('readText threw', { path: absPath, error: String(e && e.message || e) });
    closeChatFileViewer();
    await _showUnsupportedDialog(absPath, cid, {
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
async function _showUnsupportedDialog(absPath, cid, opts) {
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
    const res = await window.orkas.invoke('workspace.revealPath', payload);
    if (!res || !res.ok) _viewerLog.warn('fallback reveal failed', { path: absPath, error: res && res.error });
  } catch (err) {
    _viewerLog.warn('fallback reveal threw', { path: absPath, error: String(err && err.message || err) });
  }
}

// ── Public entry point ───────────────────────────────────────────────────

function openChatFileViewer(absPath, displayName, opts) {
  if (!absPath) return;
  const cid = (opts && opts.cid) || null;
  const name = displayName || (absPath.split(/[\\/]/).pop() || absPath);
  const kind = _kindOf(name);
  _viewerCurrentPath = absPath;
  _viewerCurrentCid = cid;

  if (kind === 'image') {
    // Delegate — the image lightbox already has zoom / pan / keyboard. We
    // need the chat-media:// URL since openChatImageLightbox expects an
    // <img>-loadable src, not an abs path.
    if (typeof openChatImageLightbox === 'function') {
      openChatImageLightbox(_chatMediaLocalUrl(absPath), name);
    }
    return;
  }
  if (kind === 'pdf')      return _renderPdfBody(absPath, name);
  if (kind === 'video')    return _renderVideoBody(absPath, name);
  if (kind === 'html')     return _renderHtmlBody(absPath, name);
  if (kind === 'markdown') return _renderMarkdownBody(absPath, name, cid);
  if (kind === 'text')     return _renderTextBody(absPath, name, cid);
  // unsupported — go straight to the dialog, never open the shell.
  return _showUnsupportedDialog(absPath, cid, {});
}

// CJS bridge for vitest — pure functions only, per PC/CLAUDE.md §9.
if (typeof module !== 'undefined' && typeof module.exports === 'object') {
  module.exports = { _kindOf, _extOf, _chatMediaLocalUrl };
}
