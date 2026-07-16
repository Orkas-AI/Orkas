// ─── Conversation info side panel ───────────────────────────────────────
// Right-side companion panel for the active conversation. It summarizes the
// workspace files and attachments. The file tab reads the live conversation
// workspace first, then merges chip-tracked produced files from history so
// the panel stays aligned with disk even when tools create files through
// bash / CLI flows.

const ConversationInfo = (() => {
  const _infoLog = (typeof createLogger === 'function')
    ? createLogger('conversation-info')
    : { warn: () => {}, info: () => {}, error: () => {} };

  let _cid = null;
  let _open = false;
  let _activeTab = 'files';
  let _seq = 0;
  let _fileSeq = 0;
  let _attachmentSeq = 0;
  const _locallyDeletedPaths = new Set();
  let _loading = false;
  let _loadingSource = '';
  let _loadingSeq = 0;
  let _error = '';
  let _fileMenuScrollHost = null;
  let _snapshot = {
    conversation: null,
    history: [],
    files: [],
    fileRoot: '',
    fileRootExists: false,
    filesTruncated: false,
    filesCount: 0,
    filesScanSkipped: false,
    syncEnabled: false,
    attachments: [],
  };
  const _CI_TEXT_EXTS = new Set([
    'md', 'markdown', 'txt', 'csv', 'tsv', 'json', 'yaml', 'yml', 'log',
    'html', 'htm', 'xml', 'toml', 'ini', 'conf',
    'py', 'pyi', 'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs',
    'sh', 'bash', 'zsh', 'ps1', 'cmd', 'bat', 'rb', 'go', 'rs', 'java', 'kt',
    'c', 'cpp', 'cc', 'h', 'hpp', 'css', 'scss', 'less',
    'sql', 'graphql', 'gql',
  ]);
  const _CI_IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'webp', 'gif']);
  const _CI_VIDEO_EXTS = new Set(['mp4', 'webm', 'mov', 'm4v', 'ogv']);
  const _CI_AUDIO_EXTS = new Set(['mp3', 'wav', 'ogg', 'opus', 'm4a', 'aac', 'flac']);
  const _CI_OFFICE_WORD_EXTS = new Set(['docx', 'docm']);
  const _CI_OFFICE_SHEET_EXTS = new Set(['xlsx', 'xlsm']);
  const _CI_OFFICE_PRESENTATION_EXTS = new Set(['pptx', 'pptm']);

  function _label(key, fallback, vars) {
    try {
      const v = typeof t === 'function' ? t(key, vars || undefined) : key;
      return v && v !== key ? v : fallback;
    } catch (_) {
      return fallback;
    }
  }

  function _compactText(text, max = 82) {
    const s = String(text || '').replace(/\s+/g, ' ').trim();
    if (!s) return '';
    return s.length > max ? s.slice(0, max - 1) + '…' : s;
  }

  function _baseName(p) {
    const parts = String(p || '').split(/[\\/]/).filter(Boolean);
    return parts.length ? parts[parts.length - 1] : String(p || '');
  }

  function _extForName(name) {
    const base = _baseName(name);
    const idx = base.lastIndexOf('.');
    return idx >= 0 ? base.slice(idx + 1).toLowerCase() : '';
  }

  function _dirName(p) {
    const s = String(p || '').replace(/\\/g, '/');
    const idx = s.lastIndexOf('/');
    return idx >= 0 ? s.slice(0, idx) : '';
  }

  function _splitPath(p) {
    return String(p || '')
      .replace(/\\/g, '/')
      .split('/')
      .filter(Boolean);
  }

  function _normalizePath(p) {
    return String(p || '').replace(/\\/g, '/').replace(/\/+/g, '/');
  }

  function _pathIsSameOrInside(parent, target) {
    const p = _normalizePath(parent).replace(/\/+$/, '');
    const t = _normalizePath(target);
    return !!p && (t === p || t.startsWith(p + '/'));
  }

  function _isLocallyDeletedPath(p) {
    const target = _normalizePath(p);
    for (const deleted of _locallyDeletedPaths) {
      if (_pathIsSameOrInside(deleted, target)) return true;
    }
    return false;
  }

  function _relPathUnder(root, target) {
    const r = _normalizePath(root).replace(/\/+$/, '');
    const t = _normalizePath(target);
    if (!r || !t) return '';
    if (t === r) return '';
    const prefix = r + '/';
    return t.startsWith(prefix) ? t.slice(prefix.length) : '';
  }

  function _samePrefix(a, b) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length > b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (a[i] !== b[i]) return false;
    }
    return true;
  }

  function _commonDirSegments(paths) {
    const dirs = paths.map((p) => _splitPath(_dirName(p)));
    if (!dirs.length) return [];
    let common = dirs[0].slice();
    for (let i = 1; i < dirs.length; i++) {
      const next = dirs[i];
      let j = 0;
      while (j < common.length && j < next.length && common[j] === next[j]) j++;
      common = common.slice(0, j);
    }
    return common;
  }

  // One-time warn when the shared icons helpers (`window.fileKindIconHtml` /
  // `window.uiIconHtml`, defined by `modules/icons.js`) are missing — typical
  // cause is an `index.html` script-list refactor that put `icons.js` after a
  // consumer. Without this warn the panel just paints rows without icons,
  // silently degrading; logging once lets DevTools surface the broken load
  // order on the first render attempt. The flag is per-module-lifetime to
  // avoid spamming on every refresh.
  let _warnedIconsMissing = false;
  function _warnIconsHelperMissingOnce(helperName) {
    if (_warnedIconsMissing) return;
    _warnedIconsMissing = true;
    _infoLog.warn(`icons.js helper missing: ${helperName} — check index.html <script> load order`);
  }

  function _iconForName(name, kind) {
    if (typeof window !== 'undefined' && typeof window.fileKindIconHtml === 'function') return window.fileKindIconHtml(name, kind);
    _warnIconsHelperMissingOnce('fileKindIconHtml');
    return '';
  }

  function _uiIcon(name, className) {
    if (typeof window !== 'undefined' && typeof window.uiIconHtml === 'function') {
      return window.uiIconHtml(name, className);
    }
    _warnIconsHelperMissingOnce('uiIconHtml');
    return '';
  }

  function _kindForName(name) {
    const ext = _extForName(name);
    if (_CI_IMAGE_EXTS.has(ext)) return 'image';
    if (_CI_VIDEO_EXTS.has(ext)) return 'video';
    if (_CI_AUDIO_EXTS.has(ext)) return 'audio';
    if (ext === 'pdf') return 'pdf';
    if (_CI_OFFICE_WORD_EXTS.has(ext)) return 'docx';
    if (_CI_OFFICE_SHEET_EXTS.has(ext)) return 'spreadsheet';
    if (_CI_OFFICE_PRESENTATION_EXTS.has(ext)) return 'presentation';
    if (['doc', 'xls', 'ppt'].includes(ext)) return 'legacy_office';
    if (_CI_TEXT_EXTS.has(ext)) return 'text';
    return 'unsupported';
  }

  function _fileOperationPolicy() {
    return typeof window !== 'undefined' ? window.FileOperationPolicy : null;
  }

  function _canAddEntryToLibrary(name, projectScoped = false) {
    const policy = _fileOperationPolicy();
    return !!(policy && policy.canAddToLibrary(name, { projectScoped }));
  }

  function _canAddEntryToChat(name) {
    const policy = _fileOperationPolicy();
    return !!(policy && policy.canAddToChat(name));
  }

  function _canShareEntry(name) {
    const policy = _fileOperationPolicy();
    return !!(policy && policy.canShare(name));
  }

  function _isProjectConversation(cid) {
    const target = String(cid || '');
    const snapshotConversation = _snapshot.conversation;
    if (snapshotConversation
      && (!target || target === _cid || snapshotConversation.conversation_id === target)
      && snapshotConversation.project_id) return true;
    if (typeof conversations === 'undefined' || !Array.isArray(conversations)) return false;
    const conversation = conversations.find((item) => item && item.conversation_id === target);
    return !!(conversation && conversation.project_id);
  }

  function _formatBytes(bytes) {
    const n = Number(bytes);
    if (!Number.isFinite(n) || n <= 0) return '';
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10 * 1024 ? 1 : 0)} KB`;
    return `${(n / 1024 / 1024).toFixed(n < 10 * 1024 * 1024 ? 1 : 0)} MB`;
  }

  async function _fetchJson(url) {
    const res = await apiFetch(url);
    const data = await res.json();
    if (!data || data.ok === false) throw new Error((data && data.error) || 'load failed');
    return data;
  }

  async function _load(cid) {
    const enc = encodeURIComponent(cid);
    const [historyData, filesData, attachmentData, syncEnabled] = await Promise.all([
      _fetchJson(typeof _historyRequestUrl === 'function'
        ? _historyRequestUrl(cid)
        : `/api/conversations/${enc}/history?limit=10`),
      _fetchJson(`/api/conversations/${enc}/files`).catch((err) => {
        _infoLog.warn('file list load failed', { cid, error: err && err.message });
        return { items: [], root: '', rootExists: false, truncated: false, count: 0, scanSkipped: false };
      }),
      _fetchJson(`/api/conversations/${enc}/attachments`).catch((err) => {
        _infoLog.warn('attachment load failed', { cid, error: err && err.message });
        return { items: [] };
      }),
      _loadSyncEnabled(),
    ]);
    return {
      conversation: historyData.conversation || null,
      history: Array.isArray(historyData.history) ? historyData.history : [],
      files: Array.isArray(filesData.items) ? filesData.items : [],
      fileRoot: typeof filesData.root === 'string' ? filesData.root : '',
      fileRootExists: filesData.rootExists === true,
      filesTruncated: filesData.truncated === true,
      filesCount: Number(filesData.count) || 0,
      filesScanSkipped: filesData.scanSkipped === true,
      syncEnabled: syncEnabled === true,
      attachments: Array.isArray(attachmentData.items) ? attachmentData.items : [],
    };
  }

  async function _loadFileSnapshot(cid) {
    const enc = encodeURIComponent(cid);
    const filesData = await _fetchJson(`/api/conversations/${enc}/files`).catch((err) => {
      _infoLog.warn('file list load failed', { cid, error: err && err.message });
      return { items: [], root: '', rootExists: false, truncated: false, count: 0, scanSkipped: false };
    });
    // A file-only refresh used to fetch the complete history again just to
    // preserve the existing snapshot. The original panel load already owns
    // that history; generated files are authoritative in the workspace scan.
    // Leave history/conversation/syncEnabled untouched in the caller's merge.
    return {
      files: Array.isArray(filesData.items) ? filesData.items : [],
      fileRoot: typeof filesData.root === 'string' ? filesData.root : '',
      fileRootExists: filesData.rootExists === true,
      filesTruncated: filesData.truncated === true,
      filesCount: Number(filesData.count) || 0,
      filesScanSkipped: filesData.scanSkipped === true,
    };
  }

  async function _loadSyncEnabled() {
    return false;
  }

  function _normalizeAttachmentItems(items) {
    return (Array.isArray(items) ? items : [])
      .filter((item) => item && item.status !== 'error')
      .map((item) => ({
        name: String(item.name || ''),
        displayName: item.displayName ? String(item.displayName) : '',
        kind: item.kind || _kindForName(item.name || item.displayName || ''),
        bytes: Number(item.bytes) || 0,
        mtime: item.mtime,
        status: item.status || '',
      }))
      .filter((item) => item.name);
  }

  function _currentConversationTitle() {
    const c = _snapshot.conversation
      || (Array.isArray(conversations) ? conversations.find((x) => x && x.conversation_id === _cid) : null);
    return c && c.title ? c.title : _label('chat.new_conv_title', 'New conversation');
  }

  function _collectHistoryProducedFiles() {
    const byPath = new Map();
    for (const m of _snapshot.history || []) {
      const ts = m && (m.ts || m.time || '');
      const produced = Array.isArray(m && m.produced) ? m.produced : [];
      for (const p of produced) {
        if (!p) continue;
        const abs = String(p);
        if (_isLocallyDeletedPath(abs)) continue;
        byPath.set(abs, { path: abs, time: ts });
      }
    }
    return Array.from(byPath.values()).sort((a, b) => String(a.path).localeCompare(String(b.path)));
  }

  function _collectVisibleFiles() {
    const byPath = new Map();
    const fileRoot = _snapshot.fileRoot || '';
    const workspaceFiles = Array.isArray(_snapshot.files) ? _snapshot.files : [];
    for (const item of workspaceFiles) {
      const p = item && item.path ? String(item.path) : '';
      if (!p) continue;
      const key = _normalizePath(p);
      const relPath = item.relPath ? String(item.relPath) : _relPathUnder(fileRoot, p);
      byPath.set(key, {
        path: p,
        relPath,
        name: item.name || _baseName(p),
        kind: item.kind || _kindForName(item.name || p),
        time: item.mtime ? new Date(Number(item.mtime)).toISOString() : '',
        bytes: Number(item.bytes) || 0,
        source: 'workspace',
      });
    }

    const hasAuthoritativeWorkspaceSnapshot = !!fileRoot && _snapshot.fileRootExists === true;
    for (const produced of _collectHistoryProducedFiles()) {
      const p = produced && produced.path ? String(produced.path) : '';
      if (!p) continue;
      const key = _normalizePath(p);
      if (byPath.has(key)) continue;
      const relPath = _relPathUnder(fileRoot, p);
      if (relPath && hasAuthoritativeWorkspaceSnapshot && !_snapshot.filesTruncated) {
        // The workspace snapshot is authoritative for files under its root.
        // If a produced file was deleted or renamed, don't keep showing the
        // stale history record.
        continue;
      }
      byPath.set(key, {
        ...produced,
        relPath,
        name: _baseName(p),
        kind: _kindForName(_baseName(p)),
        source: 'produced',
      });
    }

    return Array.from(byPath.values()).sort((a, b) => {
      const ar = a.relPath || a.path || '';
      const br = b.relPath || b.path || '';
      return String(ar).localeCompare(String(br));
    });
  }

  function _buildFileTree(files) {
    const root = { dirs: new Map(), files: [], path: '' };
    const hasRelPaths = files.some((f) => f && f.relPath);
    const common = hasRelPaths ? [] : _commonDirSegments(files.map((f) => f.path));
    for (const file of files) {
      const treePath = hasRelPaths ? (file.relPath || _baseName(file.path)) : file.path;
      const all = _splitPath(treePath);
      const rel = _samePrefix(common, all) ? all.slice(common.length) : all;
      const parts = rel.length ? rel : [_baseName(file.path)];
      const fullParts = _splitPath(file.path);
      const baseOffset = Math.max(0, fullParts.length - parts.length);
      let node = root;
      for (let i = 0; i < parts.slice(0, -1).length; i++) {
        const part = parts[i];
        const dirPath = _pathFromSegmentsLike(file.path, fullParts.slice(0, baseOffset + i + 1));
        if (!node.dirs.has(part)) node.dirs.set(part, { dirs: new Map(), files: [], path: dirPath });
        else if (!node.dirs.get(part).path && dirPath) node.dirs.get(part).path = dirPath;
        node = node.dirs.get(part);
      }
      node.files.push({ ...file, name: parts[parts.length - 1] || _baseName(file.path) });
    }
    return root;
  }

  function _pathFromSegmentsLike(sourcePath, segments) {
    const source = _normalizePath(sourcePath);
    const prefix = source.startsWith('/') ? '/' : '';
    return prefix + (segments || []).join('/');
  }

  function _renderTreeNode(node, depth) {
    const dirs = Array.from(node.dirs.entries()).sort((a, b) => a[0].localeCompare(b[0]));
    const files = node.files.slice().sort((a, b) => a.name.localeCompare(b.name));
    const moreTitle = _label('common.more', 'More');
    const dirHtml = dirs.map(([name, child]) => {
      const dirPath = child && child.path ? String(child.path) : '';
      return `
      <details class="conversation-info-dir" style="--depth:${depth}">
        <summary class="conversation-info-dir-summary" title="${escapeHtml(dirPath || name)}">
          <span class="conversation-info-dir-folder-icon conversation-info-dir-folder-closed">${_uiIcon('folder', 'ui-icon conversation-info-dir-svg-icon')}</span>
          <span class="conversation-info-dir-folder-icon conversation-info-dir-folder-open">${_uiIcon('folder-open', 'ui-icon conversation-info-dir-svg-icon')}</span>
          <span class="conversation-info-dir-name">${escapeHtml(name)}</span>
          ${dirPath ? `<button type="button" class="conversation-info-file-menu-btn" data-file-menu
                  data-entry-kind="dir" data-entry-path="${escapeHtml(dirPath)}" data-entry-name="${escapeHtml(name)}"
                  title="${escapeHtml(moreTitle)}" aria-label="${escapeHtml(moreTitle)}">⋯</button>` : ''}
        </summary>
        ${_renderTreeNode(child, depth + 1)}
      </details>
    `;
    }).join('');
    const fileHtml = files.map((file) => {
      const kind = file.kind || _kindForName(file.name || file.path);
      return `
      <div class="conversation-info-file" role="button" tabindex="0" style="--depth:${depth}"
              data-file-path="${escapeHtml(file.path)}" draggable="true" title="${escapeHtml(file.path)}">
        <span class="conversation-info-file-icon">${_iconForName(file.name)}</span>
        <span class="conversation-info-file-name">${escapeHtml(file.name)}</span>
        <button type="button" class="conversation-info-file-menu-btn" data-file-menu
                data-entry-kind="${escapeHtml(kind)}" data-entry-path="${escapeHtml(file.path)}" data-entry-name="${escapeHtml(file.name)}"
                title="${escapeHtml(moreTitle)}" aria-label="${escapeHtml(moreTitle)}">⋯</button>
      </div>
    `;
    }).join('');
    return dirHtml + fileHtml;
  }

  function _renderFiles() {
    const files = _collectVisibleFiles();
    if (!files.length) {
      if (_snapshot.filesScanSkipped) {
        return `<div class="conversation-info-empty">${escapeHtml(_label(
          'conversation_info.files_scan_skipped',
          'File listing is paused for this privacy-protected workspace. Files created or attached in chat still appear.'
        ))}</div>`;
      }
      return `<div class="conversation-info-empty">${escapeHtml(_label('conversation_info.empty_files', 'No files yet'))}</div>`;
    }
    const tree = _buildFileTree(files);
    const syncNotice = _snapshot.syncEnabled
      ? `<div class="ci-files-sync-note">
          <span class="ci-files-sync-note-icon">${_uiIcon('info', 'ui-icon ci-files-sync-note-svg')}</span>
          <span>${escapeHtml(_label(
            'conversation_info.files_sync_note',
            'Cloud sync does not include these files. Add supported files to Library if you want them synced.'
          ))}</span>
        </div>`
      : '';
    const trunc = _snapshot.filesTruncated
      ? `<div class="conversation-info-empty is-small">${escapeHtml(_label('conversation_info.files_truncated', 'Showing first {count} files', { count: _snapshot.filesCount || files.length }))}</div>`
      : '';
    return `<div class="ci-files">${syncNotice}${trunc}<div class="conversation-info-tree">${_renderTreeNode(tree, 0)}</div></div>`;
  }

  function _collectConversationAttachments() {
    const byName = new Map();
    for (const m of _snapshot.history || []) {
      const ts = m && (m.ts || m.time || '');
      const attachments = Array.isArray(m && m.attachments) ? m.attachments : [];
      for (const name of attachments) {
        if (typeof name !== 'string' || !name) continue;
        if (!byName.has(name)) {
          byName.set(name, { name, kind: _kindForName(name), bytes: 0, time: ts, pending: false });
        }
      }
    }
    for (const item of _snapshot.attachments || []) {
      const name = String(item && item.name || '');
      if (!name) continue;
      byName.set(name, {
        name,
        displayName: item.displayName ? String(item.displayName) : '',
        kind: item.kind || _kindForName(name),
        bytes: Number(item.bytes) || 0,
        time: item.mtime ? new Date(Number(item.mtime) * 1000).toISOString() : '',
        pending: true,
      });
    }
    return Array.from(byName.values()).sort((a, b) => {
      const at = new Date(a.time || 0).getTime();
      const bt = new Date(b.time || 0).getTime();
      if (bt !== at) return bt - at;
      return String(a.name || '').localeCompare(String(b.name || ''));
    });
  }

  function _ciThumbForKind(kind, name) {
    const n = String(name || '').toLowerCase();
    if (kind === 'image' || /\.(png|jpe?g|gif|webp|svg)$/i.test(n)) return { cls: 'is-image', label: 'IMG' };
    if (kind === 'pdf' || /\.pdf$/i.test(n)) return { cls: '', label: 'PDF' };
    if (/\.(docx?|docm)$/i.test(n)) return { cls: 'is-doc', label: 'DOC' };
    if (/\.(xlsx?|xlsm)$/i.test(n)) return { cls: 'is-doc', label: 'XLS' };
    if (/\.(pptx?|pptm)$/i.test(n)) return { cls: 'is-doc', label: 'PPT' };
    if (/\.(md|markdown|txt|csv|tsv|json|yaml|yml|log)$/i.test(n)) return { cls: 'is-doc', label: (n.split('.').pop() || 'TXT').slice(0, 4).toUpperCase() };
    return { cls: 'is-doc', label: 'FILE' };
  }

  function _renderAttachments() {
    const items = _collectConversationAttachments();
    if (!items.length) {
      return `<div class="conversation-info-empty">${escapeHtml(_label('conversation_info.empty_attachments', 'No attachments'))}</div>`;
    }
    const rows = items.map((item) => {
      const name = String(item.name || '');
      const label = String(item.displayName || item.name || '');
      const size = _formatBytes(item.bytes);
      const time = item.time ? new Date(item.time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '';
      const meta = [size, time].filter(Boolean).join(' · ');
      const thumb = _ciThumbForKind(item.kind, label);
      return `
        <button type="button" class="ci-attach-row" data-attachment-name="${escapeHtml(name)}" title="${escapeHtml(label)}">
          <span class="ci-attach-row-thumb ${thumb.cls}">${escapeHtml(thumb.label)}</span>
          <div class="ci-attach-row-main">
            <span class="ci-attach-row-name">${escapeHtml(label)}</span>
            ${meta ? `<span class="ci-attach-row-meta">${escapeHtml(meta)}</span>` : ''}
          </div>
        </button>
      `;
    }).join('');
    return `<div class="ci-attach"><div class="ci-attach-list">${rows}</div></div>`;
  }

  // Tab count chips — filled from the same _snapshot as the body renderers.
  // Tasks count is `done/total`; files / attachments mirror visible rows.
  function _refreshTabCounts() {
    const filesEl = document.getElementById('conversation-info-tab-count-files');
    if (filesEl) {
      const count = _collectVisibleFiles().length;
      filesEl.textContent = count > 0 ? String(count) : '';
    }
    const attachEl = document.getElementById('conversation-info-tab-count-attachments');
    if (attachEl) {
      const count = _collectConversationAttachments().length;
      attachEl.textContent = count > 0 ? String(count) : '';
    }
  }

  function _renderBody() {
    _closeFileMenu();
    const body = document.getElementById('conversation-info-body');
    if (!body) return;
    if (!_cid) {
      body.innerHTML = `<div class="conversation-info-empty">${escapeHtml(_label('conversation_info.no_conversation', 'Open a conversation to see details'))}</div>`;
      _refreshTabCounts();
      return;
    }
    if (_loading) {
      body.innerHTML = `<div class="conversation-info-empty">${escapeHtml(_label('common.loading', 'Loading…'))}</div>`;
      _refreshTabCounts();
      return;
    }
    if (_error) {
      body.innerHTML = `<div class="conversation-info-empty is-error">${escapeHtml(_label('conversation_info.load_failed', 'Could not load conversation info', { reason: _error }))}</div>`;
      _refreshTabCounts();
      return;
    }
    if (_activeTab === 'attachments') body.innerHTML = _renderAttachments();
    else body.innerHTML = _renderFiles();
    // Hydrate any data-ui-icon placeholders that the renderers emitted.
    if (typeof window !== 'undefined' && typeof window.hydrateUiIcons === 'function') {
      window.hydrateUiIcons(body);
    }
    _refreshTabCounts();
  }

  function _syncChrome() {
    const panel = document.getElementById('conversation-info-panel');
    const toggle = document.getElementById('conversation-info-toggle');
    if (panel) panel.hidden = !_open;
    if (toggle) {
      toggle.classList.toggle('is-active', _open);
      toggle.setAttribute('aria-expanded', _open ? 'true' : 'false');
    }
    document.querySelectorAll('.conversation-info-tab').forEach((tab) => {
      tab.classList.toggle('is-active', tab.dataset.infoTab === _activeTab);
    });
  }

  function _beginLoading(source, seq) {
    _loading = true;
    _loadingSource = source || '';
    _loadingSeq = seq || 0;
    _renderBody();
  }

  function _clearLoading(source, seq, opts = {}) {
    if (!_loading || _loadingSource !== source) return false;
    if (opts.clearAnyForSource === true || _loadingSeq === seq) {
      _loading = false;
      _loadingSource = '';
      _loadingSeq = 0;
      return true;
    }
    return false;
  }

  function _resetLoading() {
    _loading = false;
    _loadingSource = '';
    _loadingSeq = 0;
  }

  function _setOpen(next) {
    _open = !!next;
    _syncChrome();
    if (_open) refresh(_cid);
  }

  async function refresh(cid, opts = {}) {
    const target = cid || _cid;
    if (!target || target !== _cid || !_open) return;
    const seq = ++_seq;
    const silent = !!opts.silent;
    if (silent && _loadingSource === 'full') {
      _clearLoading('full', seq, { clearAnyForSource: true });
      _renderBody();
    }
    if (!silent) {
      _error = '';
      _beginLoading('full', seq);
    }
    try {
      const snapshot = await _load(target);
      if (seq !== _seq || target !== _cid) return;
      _snapshot = snapshot;
      _error = '';
    } catch (err) {
      if (seq !== _seq || target !== _cid) return;
      _error = (err && err.message) || String(err);
    } finally {
      if (seq === _seq && target === _cid) {
        _clearLoading('full', seq, { clearAnyForSource: silent });
        _renderBody();
      }
    }
  }

  async function refreshAttachments(cid, opts = {}) {
    const target = cid || _cid;
    if (!target || target !== _cid || !_open) return;
    const items = Array.isArray(opts.items) ? _normalizeAttachmentItems(opts.items) : null;
    if (items) {
      _snapshot = { ..._snapshot, attachments: items };
      if (_activeTab === 'attachments') _renderBody();
      return;
    }

    const seq = ++_attachmentSeq;
    try {
      const data = await _fetchJson(`/api/conversations/${encodeURIComponent(target)}/attachments`);
      if (seq !== _attachmentSeq || target !== _cid) return;
      _snapshot = {
        ..._snapshot,
        attachments: Array.isArray(data.items) ? data.items : [],
      };
      if (_activeTab === 'attachments') _renderBody();
    } catch (err) {
      _infoLog.warn('attachment refresh failed', { cid: target, error: err && err.message });
    }
  }

  async function refreshFiles(cid, opts = {}) {
    const target = cid || _cid;
    if (!target || target !== _cid || !_open) return;
    const seq = ++_fileSeq;
    const silent = !!opts.silent;
    if (silent && _loadingSource === 'files') {
      _clearLoading('files', seq, { clearAnyForSource: true });
      if (_activeTab === 'files') _renderBody();
    }
    if (!silent && _activeTab === 'files') {
      _error = '';
      _beginLoading('files', seq);
    }
    try {
      const partial = await _loadFileSnapshot(target);
      if (seq !== _fileSeq || target !== _cid) return;
      _snapshot = { ..._snapshot, ...partial };
      _error = '';
      if (_activeTab === 'files') _renderBody();
    } catch (err) {
      if (seq !== _fileSeq || target !== _cid) return;
      _infoLog.warn('file refresh failed', { cid: target, error: err && err.message });
      if (!silent) {
        _error = (err && err.message) || String(err);
        if (_activeTab === 'files') _renderBody();
      }
    } finally {
      if (seq === _fileSeq && target === _cid) {
        _clearLoading('files', seq, { clearAnyForSource: silent });
        if (_activeTab === 'files') _renderBody();
      }
    }
  }

  function bind(cid) {
    _cid = cid || null;
    _open = false;
    _snapshot = { conversation: null, history: [], files: [], fileRoot: '', fileRootExists: false, filesTruncated: false, filesCount: 0, filesScanSkipped: false, syncEnabled: false, attachments: [] };
    _error = '';
    _resetLoading();
    _seq++;
    _fileSeq++;
    _attachmentSeq++;
    _syncChrome();
    _renderBody();
    if (_open && _cid) refresh(_cid);
  }

  function unbind() {
    bind(null);
  }

  function _openFile(absPath) {
    if (!absPath || typeof openChatFileViewer !== 'function') return;
    openChatFileViewer(absPath, _baseName(absPath), _cid ? { cid: _cid } : undefined);
  }

  function _attachmentEntriesForPath(absPath, kind) {
    if (kind !== 'dir') {
      return [{ path: absPath, name: _baseName(absPath) }];
    }
    return _collectVisibleFiles()
      .filter((file) => file && file.path && _pathIsSameOrInside(absPath, file.path))
      .map((file) => ({ path: file.path, name: _baseName(file.path) }));
  }

  async function _fallbackImportAttachments(entries, cidOverride) {
    const targetCid = cidOverride || _cid;
    if (!targetCid) return;
    const rejected = [];
    const imported = [];
    for (const entry of entries) {
      try {
        const res = await apiFetch(`/api/conversations/${encodeURIComponent(targetCid)}/attachments/import`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ path: entry.path, name: entry.name }),
        });
        const data = await res.json();
        if (!data || !data.ok) {
          rejected.push(_label('chat.attach_upload_fail', '{name} ({reason})', {
            name: entry.name,
            reason: (data && data.error) || _label('chat.attach_upload_generic_fail', 'Upload failed'),
          }));
          continue;
        }
        if (data.info) imported.push(data.info);
      } catch (err) {
        rejected.push(_label('chat.attach_upload_fail', '{name} ({reason})', {
          name: entry.name,
          reason: String(err && err.message || err),
        }));
      }
    }
    if (imported.length) await refreshAttachments(targetCid);
    if (rejected.length) {
      await uiAlert(_label('chat.attach_rejected_prefix', 'The following files could not be uploaded:\n\n{list}', {
        list: rejected.join('\n'),
      }));
    }
  }

  function _fileActionPayload(absPath, cidOverride) {
    const payload = { path: absPath };
    const targetCid = cidOverride || _cid;
    if (targetCid) payload.cid = targetCid;
    return payload;
  }

  function _ensureFileMenu() {
    let menu = document.getElementById('conversation-info-file-menu');
    if (!menu) {
      menu = document.createElement('div');
      menu.id = 'conversation-info-file-menu';
      menu.className = 'ctx-row-menu conversation-info-file-menu';
      menu.style.display = 'none';
      document.body.appendChild(menu);
    }
    return menu;
  }

  function _positionFileMenu(menuEl, anchorEl) {
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
    menuEl.style.left = `${left}px`;
    menuEl.style.top = `${top}px`;
  }

  function _closeFileMenu() {
    const menu = document.getElementById('conversation-info-file-menu');
    if (!menu || !menu.style) return;
    menu.style.display = 'none';
    if (menu.dataset) {
      delete menu.dataset.filePath;
      delete menu.dataset.fileName;
    }
    document.querySelectorAll('.conversation-info-file.is-menu-open, .conversation-info-dir-summary.is-menu-open, .chat-msg-produced-item.is-menu-open')
      .forEach((row) => row.classList && row.classList.remove && row.classList.remove('is-menu-open'));
    if (document.removeEventListener) {
      document.removeEventListener('mousedown', _onFileMenuOutside, true);
      document.removeEventListener('keydown', _onFileMenuKeyDown, true);
    }
    if (window.removeEventListener) window.removeEventListener('resize', _closeFileMenu);
    if (_fileMenuScrollHost && _fileMenuScrollHost.removeEventListener) {
      _fileMenuScrollHost.removeEventListener('scroll', _closeFileMenu);
    }
    _fileMenuScrollHost = null;
  }

  function _onFileMenuOutside(ev) {
    const menu = document.getElementById('conversation-info-file-menu');
    if (!menu || menu.style.display === 'none') return;
    if (menu.contains(ev.target)) return;
    if (ev.target && ev.target.closest && ev.target.closest('.conversation-info-file-menu-btn, .chat-msg-produced-menu-btn')) return;
    _closeFileMenu();
  }

  function _onFileMenuKeyDown(ev) {
    if (ev.key === 'Escape') _closeFileMenu();
  }

  async function _openFileMenu(anchorBtn, absPath, displayName, kind, options = {}) {
    if (!anchorBtn || !absPath) return;
    const menu = _ensureFileMenu();
    const sameFile = menu.dataset.filePath === absPath && menu.style.display !== 'none';
    if (sameFile) { _closeFileMenu(); return; }
    _closeFileMenu();

    const name = displayName || _baseName(absPath);
    const entryKind = kind === 'dir' ? 'dir' : 'file';
    const targetCid = options.cid || _cid;
    const projectScoped = _isProjectConversation(targetCid);
    const revealLabel = _label('conversation_info.file_reveal_action', 'Show in folder');
    const addLabel = _label('conversation_info.file_add_to_chat_action', 'Add to chat');
    const addLibraryLabel = _label('conversation_info.file_add_to_library_action', 'Add to Library');
    const saveAppLabel = _label('apps.save_from_file_action', 'Save as app');
    const deleteLabel = _label('common.delete', 'Delete');
    let canSaveApp = false;
    try {
      const inspected = await window.orkas.invoke('savedApps.inspectBundleFromPath', _fileActionPayload(absPath, targetCid));
      canSaveApp = !!(inspected && inspected.ok !== false && inspected.canSave);
    } catch (_) { canSaveApp = false; }
    const addItem = entryKind === 'file' && _canAddEntryToChat(name || absPath)
      ? `<div class="ctx-row-menu-item" data-action="add-to-chat">${escapeHtml(addLabel)}</div>`
      : '';
    const addLibraryItem = entryKind === 'file' && _canAddEntryToLibrary(name || absPath, projectScoped)
      ? `<div class="ctx-row-menu-item" data-action="add-to-library">${escapeHtml(addLibraryLabel)}</div>`
      : '';
    const saveAppItem = canSaveApp
      ? `<div class="ctx-row-menu-item" data-action="save-as-app">${escapeHtml(saveAppLabel)}</div>`
      : '';
    menu.innerHTML = `
      <div class="ctx-row-menu-item" data-action="reveal">${escapeHtml(revealLabel)}</div>
      ${saveAppItem}
      ${addLibraryItem}
      ${addItem}
      <div class="ctx-row-menu-item is-danger" data-action="delete">${escapeHtml(deleteLabel)}</div>
    `;
    menu.dataset.filePath = absPath;
    menu.dataset.fileName = name;
    menu.dataset.entryKind = entryKind;
    const row = anchorBtn.closest('.conversation-info-file, .conversation-info-dir-summary, .chat-msg-produced-item');
    if (row) row.classList.add('is-menu-open');
    _positionFileMenu(menu, anchorBtn);
    _fileMenuScrollHost = anchorBtn.closest('.chat-msg-produced');
    if (_fileMenuScrollHost && _fileMenuScrollHost.addEventListener) {
      _fileMenuScrollHost.addEventListener('scroll', _closeFileMenu, { passive: true });
    }

    menu.querySelectorAll('.ctx-row-menu-item').forEach((item) => {
      item.addEventListener('click', async (e) => {
        e.stopPropagation();
        const action = item.dataset.action || '';
        _closeFileMenu();
        await _runFileMenuAction(action, absPath, name, entryKind, {
          cid: targetCid,
          onDeleted: typeof options.onDeleted === 'function' ? options.onDeleted : null,
        });
      });
    });
    document.addEventListener('mousedown', _onFileMenuOutside, true);
    document.addEventListener('keydown', _onFileMenuKeyDown, true);
    window.addEventListener('resize', _closeFileMenu);
  }

  async function _revealEntry(absPath, cidOverride) {
    try {
      const res = await window.orkas.invoke('workspace.revealPath', _fileActionPayload(absPath, cidOverride));
      if (!res || !res.ok) {
        await uiAlert(_label('conversation_info.file_reveal_failed', 'Could not show in folder: {reason}', {
          reason: (res && res.error) || 'failed',
        }));
      }
    } catch (err) {
      await uiAlert(_label('conversation_info.file_reveal_failed', 'Could not show in folder: {reason}', {
        reason: String(err && err.message || err),
      }));
    }
  }

  async function _addEntryToChat(absPath, kind, cidOverride) {
    const targetCid = cidOverride || _cid;
    if (!targetCid) return;
    const entries = _attachmentEntriesForPath(absPath, kind);
    if (!entries.length) {
      await uiAlert(_label('conversation_info.dir_add_empty', 'No files in this folder can be added'));
      return;
    }
    if (typeof window.addChatAttachmentsFromPaths === 'function') {
      await window.addChatAttachmentsFromPaths(targetCid, entries);
      return;
    }
    await _fallbackImportAttachments(entries, targetCid);
  }

  async function _addEntryToLibrary(absPath, cidOverride) {
    if (!_canAddEntryToLibrary(absPath)) return;
    try {
      const res = await window.orkas.invoke('library.importProduced', _fileActionPayload(absPath, cidOverride));
      if (!res || !res.ok) throw new Error((res && res.error) || 'failed');
      if (res.scope === 'global' && typeof currentView !== 'undefined' && currentView === 'contexts' && typeof loadContexts === 'function') {
        loadContexts();
      }
      if (res.scope === 'project' && res.projectId && typeof currentView !== 'undefined' && currentView === 'project' && typeof loadProjectDetail === 'function') {
        loadProjectDetail(res.projectId).catch(() => {});
      }
    } catch (err) {
      await uiAlert(_label('conversation_info.file_add_to_library_failed', 'Add to Library failed: {reason}', {
        reason: String(err && err.message || err),
      }));
    }
  }

  async function _saveEntryAsApp(absPath, cidOverride) {
    try {
      const res = await window.orkas.invoke('savedApps.saveFromPath', _fileActionPayload(absPath, cidOverride));
      if (!res || res.ok === false) throw new Error((res && res.error) || 'failed');
      const message = _label('apps.saved_toast', 'Saved to My Apps');
      if (typeof uiToast === 'function') uiToast(message, { variant: 'success' });
      else if (typeof uiAlert === 'function') await uiAlert(message);
      try { if (typeof loadSavedApps === 'function') loadSavedApps(true); } catch (_) {}
    } catch (err) {
      await uiAlert(_label('apps.save_failed', 'Could not save the app') + ': ' + String(err && err.message || err));
    }
  }

  async function _deleteEntry(absPath, displayName, kind, options = {}) {
    const name = displayName || _baseName(absPath);
    const isDir = kind === 'dir';
    const confirmTitle = isDir
      ? _label('conversation_info.dir_delete_confirm_title', 'Delete folder')
      : _label('conversation_info.file_delete_confirm_title', 'Delete file');
    const confirmMessage = isDir
      ? _label('conversation_info.dir_delete_confirm_msg', 'Delete folder "{name}" and everything inside it?', { name })
      : _label('conversation_info.file_delete_confirm_msg', 'Delete "{name}"?', { name });
    const dangerLabel = _label('common.delete', 'Delete');
    const ok = typeof uiConfirmDanger === 'function'
      ? await uiConfirmDanger({ title: confirmTitle, message: confirmMessage, dangerLabel })
      : await uiConfirm(confirmMessage);
    if (!ok) return;

    try {
      const res = await window.orkas.invoke('workspace.deletePath', _fileActionPayload(absPath, options.cid));
      if (!res || !res.ok) {
        await uiAlert(_label(isDir ? 'conversation_info.dir_delete_failed' : 'conversation_info.file_delete_failed', 'Could not delete: {reason}', {
          reason: (res && res.error) || 'failed',
        }));
        return;
      }
      const deletedPath = _normalizePath(res.path || absPath);
      _locallyDeletedPaths.add(deletedPath);
      _snapshot = {
        ..._snapshot,
        files: (_snapshot.files || []).filter((item) => !_pathIsSameOrInside(deletedPath, item && item.path)),
      };
      _renderBody();
      if (_cid) refresh(_cid, { silent: true });
      if (typeof options.onDeleted === 'function') options.onDeleted(deletedPath);
    } catch (err) {
      await uiAlert(_label(isDir ? 'conversation_info.dir_delete_failed' : 'conversation_info.file_delete_failed', 'Could not delete: {reason}', {
        reason: String(err && err.message || err),
      }));
    }
  }

  async function _runFileMenuAction(action, absPath, displayName, kind, options = {}) {
    if (action === 'reveal') return _revealEntry(absPath, options.cid);
    if (action === 'save-as-app') return _saveEntryAsApp(absPath, options.cid);
    if (action === 'add-to-library') return _addEntryToLibrary(absPath, options.cid);
    if (action === 'add-to-chat') return _addEntryToChat(absPath, kind, options.cid);
    if (action === 'delete') return _deleteEntry(absPath, displayName, kind, options);
  }

  async function _openAttachment(name) {
    if (!_cid || !name || typeof openChatFileViewer !== 'function') return;
    try {
      const res = await window.orkas.invoke('attachments.absPath', { cid: _cid, name });
      if (!res || !res.ok || !res.path) {
        _infoLog.warn('attachment preview resolve failed', { cid: _cid, name, error: res && res.error });
        const message = _label('chat.file_missing_toast', 'The file no longer exists.', { name });
        if (typeof uiToast === 'function') uiToast(message, { variant: 'warning' });
        else if (typeof uiAlert === 'function') await uiAlert(message);
        return;
      }
      openChatFileViewer(res.path, name, { cid: _cid });
    } catch (err) {
      _infoLog.warn('attachment preview threw', { cid: _cid, name, error: String(err && err.message || err) });
      const message = _label('chat.file_missing_toast', 'The file no longer exists.', { name });
      if (typeof uiToast === 'function') uiToast(message, { variant: 'warning' });
      else if (typeof uiAlert === 'function') await uiAlert(message);
    }
  }

  function _bindDom() {
    const toggle = document.getElementById('conversation-info-toggle');
    const close = document.getElementById('conversation-info-close');
    const body = document.getElementById('conversation-info-body');
    if (toggle && toggle.dataset.bound !== '1') {
      toggle.dataset.bound = '1';
      toggle.addEventListener('click', () => _setOpen(!_open));
    }
    if (close && close.dataset.bound !== '1') {
      close.dataset.bound = '1';
      close.addEventListener('click', () => _setOpen(false));
    }
    document.querySelectorAll('.conversation-info-tab').forEach((tab) => {
      if (tab.dataset.bound === '1') return;
      tab.dataset.bound = '1';
      tab.addEventListener('click', () => {
        _activeTab = tab.dataset.infoTab || 'files';
        _syncChrome();
        _renderBody();
      });
    });
    if (body && body.dataset.bound !== '1') {
      body.dataset.bound = '1';
      body.addEventListener('click', (ev) => {
        const ciAttach = ev.target.closest('.ci-attach-row[data-attachment-name]');
        if (ciAttach) {
          ev.preventDefault();
          _openAttachment(ciAttach.dataset.attachmentName || '');
          return;
        }
        const menuBtn = ev.target.closest('.conversation-info-file-menu-btn[data-entry-path]');
        if (menuBtn) {
          ev.preventDefault();
          ev.stopPropagation();
          _openFileMenu(
            menuBtn,
            menuBtn.dataset.entryPath || '',
            menuBtn.dataset.entryName || '',
            menuBtn.dataset.entryKind || 'file',
          );
          return;
        }
        const file = ev.target.closest('.conversation-info-file[data-file-path]');
        if (file) {
          ev.preventDefault();
          _openFile(file.dataset.filePath || '');
          return;
        }
        const attachment = ev.target.closest('.conversation-info-attachment[data-attachment-name]');
        if (attachment) {
          ev.preventDefault();
          _openAttachment(attachment.dataset.attachmentName || '');
        }
      });
      body.addEventListener('keydown', (ev) => {
        const file = ev.target.closest('.conversation-info-file[data-file-path]');
        if (!file || ev.target.closest('.conversation-info-file-menu-btn')) return;
        if (ev.key !== 'Enter' && ev.key !== ' ') return;
        ev.preventDefault();
        _openFile(file.dataset.filePath || '');
      });
      body.addEventListener('dragstart', (ev) => {
        const file = ev.target.closest('.conversation-info-file[data-file-path]');
        if (!file || !ev.dataTransfer) return;
        const path = file.dataset.filePath || '';
        if (!path) return;
        const name = (file.querySelector('.conversation-info-file-name')?.textContent || _baseName(path)).trim();
        try {
          ev.dataTransfer.effectAllowed = 'copy';
          ev.dataTransfer.setData('application/x-orkas-file', JSON.stringify({ path, name }));
          ev.dataTransfer.setData('text/plain', path);
        } catch (_) { /* best-effort */ }
      });
      body.addEventListener('scroll', _closeFileMenu);
    }
    _syncChrome();
    _renderBody();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', _bindDom, { once: true });
  } else {
    _bindDom();
  }
  window.addEventListener('i18n-change', () => {
    _syncChrome();
    _renderBody();
  });

  // External callers (chat header "详情" button, i18n-change listeners) read
  // open/close/toggle via this surface. Keeping the imperative variant +
  // `openAndSetTab(tab)` shorthand instead of exposing _setOpen +
  // _setActiveTab separately keeps the contract narrow.
  function open()  { _setOpen(true); }
  function close() { _setOpen(false); }
  function toggle() { _setOpen(!_open); }
  function openAndSetTab(tab) {
    _activeTab = tab || 'files';
    _setOpen(true);
    _syncChrome();
    _renderBody();
  }
  function openFileMenu(anchorBtn, absPath, displayName, options = {}) {
    return _openFileMenu(anchorBtn, absPath, displayName, 'file', options);
  }

  return {
    bind,
    unbind,
    refresh,
    refreshFiles,
    refreshAttachments,
    open,
    close,
    toggle,
    openAndSetTab,
    openFileMenu,
  };
})();

window.ConversationInfo = ConversationInfo;
