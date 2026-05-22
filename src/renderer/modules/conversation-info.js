// ─── Conversation info side panel ───────────────────────────────────────
// Right-side companion panel for the active conversation. It summarizes the
// structured plan, produced files, and attachments without adding new backend
// state: everything is derived from the same history / plan / attachment
// endpoints already used by the chat view.

const ConversationInfo = (() => {
  const _infoLog = (typeof createLogger === 'function')
    ? createLogger('conversation-info')
    : { warn: () => {}, info: () => {}, error: () => {} };

  let _cid = null;
  let _open = false;
  let _activeTab = 'tasks';
  let _seq = 0;
  let _loading = false;
  let _error = '';
  let _snapshot = {
    conversation: null,
    history: [],
    plan: null,
    attachments: [],
  };

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

  function _iconForName(name, kind) {
    if (typeof window !== 'undefined' && typeof window.fileKindIconHtml === 'function') return window.fileKindIconHtml(name, kind);
    return '';
  }

  function _uiIcon(name, className) {
    if (typeof window !== 'undefined' && typeof window.uiIconHtml === 'function') {
      return window.uiIconHtml(name, className);
    }
    return '';
  }

  function _kindForName(name) {
    const ext = (String(name || '').split('.').pop() || '').toLowerCase();
    if (['png', 'jpg', 'jpeg', 'webp', 'gif'].includes(ext)) return 'image';
    if (['mp4', 'webm', 'mov', 'm4v', 'ogv'].includes(ext)) return 'video';
    if (ext === 'pdf') return 'pdf';
    if (ext === 'docx') return 'docx';
    return 'text';
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
    const [historyData, planData, attachmentData] = await Promise.all([
      _fetchJson(`/api/conversations/${enc}/history?limit=500`),
      _fetchJson(`/api/conversations/${enc}/plan`).catch((err) => {
        _infoLog.warn('plan load failed', { cid, error: err && err.message });
        return { plan: null };
      }),
      _fetchJson(`/api/conversations/${enc}/attachments`).catch((err) => {
        _infoLog.warn('attachment load failed', { cid, error: err && err.message });
        return { items: [] };
      }),
    ]);
    return {
      conversation: historyData.conversation || null,
      history: Array.isArray(historyData.history) ? historyData.history : [],
      plan: planData.plan || null,
      attachments: Array.isArray(attachmentData.items) ? attachmentData.items : [],
    };
  }

  function _currentConversationTitle() {
    const c = _snapshot.conversation
      || (Array.isArray(conversations) ? conversations.find((x) => x && x.conversation_id === _cid) : null);
    return c && c.title ? c.title : _label('chat.new_conv_title', 'New conversation');
  }

  function _nearestPriorUserText(history, index) {
    for (let i = index; i >= 0; i--) {
      const m = history[i];
      if (m && (m.from === 'user' || m.role === 'user')) {
        return _compactText(m.text || m.content || '', 96);
      }
    }
    return '';
  }

  function _parseAnnouncementSteps(text) {
    const lines = String(text || '').split(/\r?\n/);
    const steps = [];
    for (const line of lines) {
      const m = line.match(/^\s*(\d+)[\.\)、)]\s+(.+?)\s*$/u);
      if (!m) continue;
      const idx = Number(m[1]);
      const body = String(m[2] || '').replace(/[（(][^）)]*[）)]\s*$/u, '').trim();
      if (!body) continue;
      steps.push({ index: idx, title: body, status: 'pending' });
    }
    return steps;
  }

  function _buildTasks() {
    const history = _snapshot.history || [];
    const plan = _snapshot.plan;
    const tasks = [];
    for (let i = 0; i < history.length; i++) {
      const m = history[i];
      if (!m || !m.plan_announcement) continue;
      const fallbackTitle = _nearestPriorUserText(history, i - 1)
        || _currentConversationTitle()
        || _label('conversation_info.task_plan_fallback', 'Execution plan');
      tasks.push({
        id: `plan-${m.id || i}`,
        title: fallbackTitle,
        time: m.ts || m.time || '',
        steps: _parseAnnouncementSteps(m.text || m.content || ''),
        current: false,
      });
    }

    if (plan && Array.isArray(plan.steps) && plan.steps.length) {
      const title = _compactText(plan.initial_message || '', 96)
        || (tasks.length ? tasks[tasks.length - 1].title : '')
        || _currentConversationTitle()
        || _label('conversation_info.task_plan_fallback', 'Execution plan');
      const current = {
        id: 'plan-current',
        title,
        time: plan.updated_at || plan.created_at || '',
        steps: plan.steps,
        current: true,
      };
      if (tasks.length) {
        tasks[tasks.length - 1] = { ...tasks[tasks.length - 1], ...current };
      } else {
        tasks.push(current);
      }
    }

    return tasks.sort((a, b) => new Date(b.time || 0).getTime() - new Date(a.time || 0).getTime());
  }

  function _statusLabel(status) {
    const raw = String(status || 'pending');
    const fallback = {
      pending: 'Pending',
      in_progress: 'Running',
      done: 'Done',
      failed: 'Failed',
      skipped: 'Skipped',
      blocked: 'Blocked',
    }[raw] || raw;
    return _label(`conversation_info.status.${raw}`, fallback);
  }

  function _statusIcon(status) {
    const raw = String(status || 'pending');
    const iconName = {
      pending: 'hourglass',
      in_progress: 'play',
      done: 'check-circle',
      failed: 'x-circle',
      skipped: 'skip-forward',
      blocked: 'document-pencil',
    }[raw] || 'info';
    if (typeof window !== 'undefined' && typeof window.uiIconHtml === 'function') {
      return window.uiIconHtml(iconName, 'ui-icon conversation-info-step-status-icon');
    }
    return '';
  }

  function _assigneeLabel(raw) {
    const a = String(raw || '').trim();
    if (!a) return '';
    if (a === 'commander') return _label('chat.recipient_commander', 'Commander');
    if (a === 'user') return _label('chat.from_user', 'User');
    return '@' + a;
  }

  function _renderStep(step) {
    const status = String(step.status || 'pending');
    const assignee = _assigneeLabel(step.assignee);
    const reason = step.failure_reason
      ? `<div class="conversation-info-step-reason">${escapeHtml(_compactText(step.failure_reason, 96))}</div>`
      : '';
    return `
      <div class="conversation-info-step is-${escapeHtml(status)}">
        <div class="conversation-info-step-head">
          <span class="conversation-info-step-icon" aria-label="${escapeHtml(status)}">${_statusIcon(status)}</span>
          <span class="conversation-info-step-index">${escapeHtml(step.index ? `${step.index}.` : '')}</span>
          <span class="conversation-info-step-title">${escapeHtml(step.title || '')}</span>
          <span class="conversation-info-status">${escapeHtml(_statusLabel(status))}</span>
        </div>
        ${assignee ? `<div class="conversation-info-step-meta">${escapeHtml(assignee)}</div>` : ''}
        ${reason}
      </div>
    `;
  }

  function _renderTasks() {
    const tasks = _buildTasks();
    if (!tasks.length) {
      return `<div class="conversation-info-empty">${escapeHtml(_label('conversation_info.empty_tasks', 'No tasks yet'))}</div>`;
    }
    return `<div class="conversation-info-task-list">${tasks.map((task) => {
      const count = Array.isArray(task.steps) ? task.steps.length : 0;
      const stepsHtml = count
        ? task.steps.map(_renderStep).join('')
        : `<div class="conversation-info-empty is-small">${escapeHtml(_label('conversation_info.empty_steps', 'No steps'))}</div>`;
      return `
        <div class="conversation-info-task">
          <div class="conversation-info-task-summary">
            <span class="conversation-info-task-title">${escapeHtml(task.title || _label('conversation_info.task_plan_fallback', 'Execution plan'))}</span>
          </div>
          <div class="conversation-info-task-steps">${stepsHtml}</div>
        </div>
      `;
    }).join('')}</div>`;
  }

  function _collectProducedFiles() {
    const byPath = new Map();
    for (const m of _snapshot.history || []) {
      const ts = m && (m.ts || m.time || '');
      const produced = Array.isArray(m && m.produced) ? m.produced : [];
      for (const p of produced) {
        if (!p) continue;
        byPath.set(String(p), { path: String(p), time: ts });
      }
    }
    const planSteps = _snapshot.plan && Array.isArray(_snapshot.plan.steps)
      ? _snapshot.plan.steps : [];
    for (const step of planSteps) {
      const produced = Array.isArray(step && step.output_files) ? step.output_files : [];
      for (const p of produced) {
        if (!p) continue;
        const key = String(p);
        if (!byPath.has(key)) byPath.set(key, { path: key, time: _snapshot.plan.updated_at || '' });
      }
    }
    return Array.from(byPath.values()).sort((a, b) => String(a.path).localeCompare(String(b.path)));
  }

  function _buildFileTree(files) {
    const root = { dirs: new Map(), files: [] };
    const common = _commonDirSegments(files.map((f) => f.path));
    for (const file of files) {
      const all = _splitPath(file.path);
      const rel = _samePrefix(common, all) ? all.slice(common.length) : all;
      const parts = rel.length ? rel : [_baseName(file.path)];
      let node = root;
      for (const part of parts.slice(0, -1)) {
        if (!node.dirs.has(part)) node.dirs.set(part, { dirs: new Map(), files: [] });
        node = node.dirs.get(part);
      }
      node.files.push({ ...file, name: parts[parts.length - 1] || _baseName(file.path) });
    }
    return root;
  }

  function _renderTreeNode(node, depth) {
    const dirs = Array.from(node.dirs.entries()).sort((a, b) => a[0].localeCompare(b[0]));
    const files = node.files.slice().sort((a, b) => a.name.localeCompare(b.name));
    const dirHtml = dirs.map(([name, child]) => `
      <details class="conversation-info-dir" style="--depth:${depth}" open>
        <summary class="conversation-info-dir-summary">
          <span class="conversation-info-dir-folder-icon conversation-info-dir-folder-closed">${_uiIcon('folder', 'ui-icon conversation-info-dir-svg-icon')}</span>
          <span class="conversation-info-dir-folder-icon conversation-info-dir-folder-open">${_uiIcon('folder-open', 'ui-icon conversation-info-dir-svg-icon')}</span>
          <span class="conversation-info-dir-name">${escapeHtml(name)}</span>
        </summary>
        ${_renderTreeNode(child, depth + 1)}
      </details>
    `).join('');
    const fileHtml = files.map((file) => `
      <button type="button" class="conversation-info-file" style="--depth:${depth}"
              data-file-path="${escapeHtml(file.path)}" title="${escapeHtml(file.path)}">
        <span class="conversation-info-file-icon">${_iconForName(file.name)}</span>
        <span class="conversation-info-file-name">${escapeHtml(file.name)}</span>
      </button>
    `).join('');
    return dirHtml + fileHtml;
  }

  function _renderFiles() {
    const files = _collectProducedFiles();
    if (!files.length) {
      return `<div class="conversation-info-empty">${escapeHtml(_label('conversation_info.empty_files', 'No generated files yet'))}</div>`;
    }
    const tree = _buildFileTree(files);
    return `<div class="conversation-info-tree">${_renderTreeNode(tree, 0)}</div>`;
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

  function _renderAttachments() {
    const items = _collectConversationAttachments();
    if (!items.length) {
      return `<div class="conversation-info-empty">${escapeHtml(_label('conversation_info.empty_attachments', 'No attachments'))}</div>`;
    }
    return `<div class="conversation-info-attachment-list">${items.map((item) => {
      const name = String(item.name || '');
      const size = _formatBytes(item.bytes);
      const meta = [item.kind || '', size].filter(Boolean).join(' · ');
      return `
        <button type="button" class="conversation-info-attachment" data-attachment-name="${escapeHtml(name)}" title="${escapeHtml(name)}">
          <span class="conversation-info-file-icon">${_iconForName(name, item.kind)}</span>
          <span class="conversation-info-attachment-main">
            <span class="conversation-info-file-name">${escapeHtml(name)}</span>
            ${meta ? `<span class="conversation-info-attachment-meta">${escapeHtml(meta)}</span>` : ''}
          </span>
        </button>
      `;
    }).join('')}</div>`;
  }

  function _renderBody() {
    const body = document.getElementById('conversation-info-body');
    if (!body) return;
    if (!_cid) {
      body.innerHTML = `<div class="conversation-info-empty">${escapeHtml(_label('conversation_info.no_conversation', 'Open a conversation to see details'))}</div>`;
      return;
    }
    if (_loading) {
      body.innerHTML = `<div class="conversation-info-empty">${escapeHtml(_label('common.loading', 'Loading…'))}</div>`;
      return;
    }
    if (_error) {
      body.innerHTML = `<div class="conversation-info-empty is-error">${escapeHtml(_label('conversation_info.load_failed', 'Could not load conversation info', { reason: _error }))}</div>`;
      return;
    }
    if (_activeTab === 'files') body.innerHTML = _renderFiles();
    else if (_activeTab === 'attachments') body.innerHTML = _renderAttachments();
    else body.innerHTML = _renderTasks();
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
    if (!silent) {
      _loading = true;
      _error = '';
      _renderBody();
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
        _loading = false;
        _renderBody();
      }
    }
  }

  function bind(cid) {
    _cid = cid || null;
    _open = false;
    _snapshot = { conversation: null, history: [], plan: null, attachments: [] };
    _error = '';
    _loading = false;
    _seq++;
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

  async function _openAttachment(name) {
    if (!_cid || !name || typeof openChatFileViewer !== 'function') return;
    try {
      const res = await window.orkas.invoke('attachments.absPath', { cid: _cid, name });
      if (!res || !res.ok || !res.path) {
        _infoLog.warn('attachment preview resolve failed', { cid: _cid, name, error: res && res.error });
        return;
      }
      openChatFileViewer(res.path, name, { cid: _cid });
    } catch (err) {
      _infoLog.warn('attachment preview threw', { cid: _cid, name, error: String(err && err.message || err) });
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
        _activeTab = tab.dataset.infoTab || 'tasks';
        _syncChrome();
        _renderBody();
      });
    });
    if (body && body.dataset.bound !== '1') {
      body.dataset.bound = '1';
      body.addEventListener('click', (ev) => {
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

  return {
    bind,
    unbind,
    refresh,
    refreshAttachments: refresh,
  };
})();

window.ConversationInfo = ConversationInfo;
