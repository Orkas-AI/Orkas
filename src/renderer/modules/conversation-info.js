// ─── Conversation info side panel ───────────────────────────────────────
// Right-side companion panel for the active conversation. It summarizes the
// structured plan, workspace files, and attachments. The file tab reads the
// live conversation workspace first, then merges chip-tracked produced files
// from history so the panel stays aligned with disk even when tools create
// files through bash / CLI flows.

const ConversationInfo = (() => {
  const _infoLog = (typeof createLogger === 'function')
    ? createLogger('conversation-info')
    : { warn: () => {}, info: () => {}, error: () => {} };

  let _cid = null;
  let _open = false;
  let _activeTab = 'tasks';
  let _seq = 0;
  let _taskSeq = 0;
  let _attachmentSeq = 0;
  let _loading = false;
  let _error = '';
  let _snapshot = {
    conversation: null,
    history: [],
    plan: null,
    members: [],
    files: [],
    fileRoot: '',
    fileRootExists: false,
    filesTruncated: false,
    filesCount: 0,
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

  function _normalizePath(p) {
    return String(p || '').replace(/\\/g, '/').replace(/\/+/g, '/');
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
    const [historyData, planData, memberData, filesData, attachmentData] = await Promise.all([
      _fetchJson(`/api/conversations/${enc}/history?limit=500`),
      _fetchJson(`/api/conversations/${enc}/plan`).catch((err) => {
        _infoLog.warn('plan load failed', { cid, error: err && err.message });
        return { plan: null };
      }),
      _fetchJson(`/api/conversations/${enc}/members`).catch((err) => {
        _infoLog.warn('member load failed', { cid, error: err && err.message });
        return { actors: [] };
      }),
      _fetchJson(`/api/conversations/${enc}/files`).catch((err) => {
        _infoLog.warn('file list load failed', { cid, error: err && err.message });
        return { items: [], root: '', rootExists: false, truncated: false, count: 0 };
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
      members: Array.isArray(memberData.actors) ? memberData.actors : [],
      files: Array.isArray(filesData.items) ? filesData.items : [],
      fileRoot: typeof filesData.root === 'string' ? filesData.root : '',
      fileRootExists: filesData.rootExists === true,
      filesTruncated: filesData.truncated === true,
      filesCount: Number(filesData.count) || 0,
      attachments: Array.isArray(attachmentData.items) ? attachmentData.items : [],
    };
  }

  async function _loadTaskSnapshot(cid) {
    const enc = encodeURIComponent(cid);
    const [historyData, planData, memberData] = await Promise.all([
      _fetchJson(`/api/conversations/${enc}/history?limit=500`),
      _fetchJson(`/api/conversations/${enc}/plan`).catch((err) => {
        _infoLog.warn('plan load failed', { cid, error: err && err.message });
        return { plan: null };
      }),
      _fetchJson(`/api/conversations/${enc}/members`).catch((err) => {
        _infoLog.warn('member load failed', { cid, error: err && err.message });
        return { actors: [] };
      }),
    ]);
    return {
      conversation: historyData.conversation || null,
      history: Array.isArray(historyData.history) ? historyData.history : [],
      plan: planData.plan || null,
      members: Array.isArray(memberData.actors) ? memberData.actors : [],
    };
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

  function _nearestPriorUserText(history, index) {
    for (let i = index; i >= 0; i--) {
      const m = history[i];
      if (m && (m.from === 'user' || m.role === 'user')) {
        return _compactText(m.text || m.content || '', 96);
      }
    }
    return '';
  }

  function _normalizeActorKey(value) {
    return String(value || '').trim().replace(/^@+/, '').replace(/\s+/g, '').toLowerCase();
  }

  function _buildMemberLookup(members) {
    const byKey = new Map();
    const add = (key, actor) => {
      const norm = _normalizeActorKey(key);
      if (norm && actor) byKey.set(norm, actor);
    };
    for (const actor of Array.isArray(members) ? members : []) {
      if (!actor || !actor.id) continue;
      add(actor.id, actor);
      add(actor.name, actor);
    }
    add('commander', { id: 'commander', kind: 'commander', name: _label('chat.recipient_commander', 'Commander') });
    add('指挥官', { id: 'commander', kind: 'commander', name: _label('chat.recipient_commander', 'Commander') });
    add('我自己', { id: 'commander', kind: 'commander', name: _label('chat.recipient_commander', 'Commander') });
    add('自己', { id: 'commander', kind: 'commander', name: _label('chat.recipient_commander', 'Commander') });
    add('user', { id: 'user', kind: 'user', name: _label('chat.from_user', 'User') });
    add('用户', { id: 'user', kind: 'user', name: _label('chat.from_user', 'User') });
    return { byKey };
  }

  function _normalizeAssignee(raw, lookup) {
    const ref = String(raw || '').trim().replace(/^@+/, '').trim();
    if (!ref) return '';
    const actor = lookup && lookup.byKey ? lookup.byKey.get(_normalizeActorKey(ref)) : null;
    if (actor && actor.id) return String(actor.id);
    const key = _normalizeActorKey(ref);
    if (key === 'commander' || key === '指挥官' || key === '我自己' || key === '自己') return 'commander';
    if (key === 'user' || key === '用户') return 'user';
    return ref;
  }

  function _parseAnnouncementSteps(text, lookup) {
    const lines = String(text || '').split(/\r?\n/);
    const steps = [];
    for (const line of lines) {
      const m = line.match(/^\s*(\d+)[\.\)、)]\s+(.+?)\s*$/u);
      if (!m) continue;
      const idx = Number(m[1]);
      let body = String(m[2] || '').trim();
      let assignee = '';
      const assigneeMatch = body.match(/[（(]([^）)]*)[）)]\s*$/u);
      if (assigneeMatch) {
        assignee = _normalizeAssignee(assigneeMatch[1], lookup);
        body = body.slice(0, assigneeMatch.index).trim();
      }
      if (!body) continue;
      steps.push({ index: idx, title: body, status: 'pending', ...(assignee ? { assignee } : {}) });
    }
    return steps;
  }

  function _actorMatches(actorValue, ref, lookup) {
    if (!actorValue || !ref) return false;
    const actor = lookup && lookup.byKey ? lookup.byKey.get(_normalizeActorKey(actorValue)) : null;
    const refActor = lookup && lookup.byKey ? lookup.byKey.get(_normalizeActorKey(ref)) : null;
    const actorId = actor?.id || String(actorValue);
    const refId = refActor?.id || String(ref);
    if (actorId === refId) return true;
    return _normalizeActorKey(actorId) === _normalizeActorKey(refId)
      || _normalizeActorKey(actor?.name) === _normalizeActorKey(ref)
      || _normalizeActorKey(actorValue) === _normalizeActorKey(refActor?.name);
  }

  function _isUserVisibleTurn(m) {
    return !!m && !m.dispatch && !m.plan_announcement && (m.from || m.role);
  }

  function _messageTargetsAssignee(m, assignee, lookup) {
    if (!m || !m.dispatch || !assignee) return false;
    const to = Array.isArray(m.to) ? m.to : [];
    if (to.some((target) => _actorMatches(target, assignee, lookup))) return true;
    const text = String(m.text || m.content || '').trim();
    const mention = text.match(/^@([^\s，,：:]+)/u);
    return !!mention && _actorMatches(mention[1], assignee, lookup);
  }

  function _messageCarriesStepIndex(m, step) {
    const idx = Number(step && step.index);
    if (!Number.isFinite(idx)) return false;
    return Number(m && (m.triggered_step ?? m.plan_step_index ?? m.form?.plan_step_index)) === idx;
  }

  function _inferHistoricalSteps(steps, section, lookup) {
    if (!Array.isArray(steps) || !steps.length) return [];
    const usedDispatches = new Set();
    const usedDoneTurns = new Set();
    let previousDoneIdx = -1;
    return steps.map((step) => {
      const assignee = step.assignee || '';
      const explicitIdx = section.findIndex((m) => _messageCarriesStepIndex(m, step));
      const explicitDoneIdx = section.findIndex((m) =>
        _messageCarriesStepIndex(m, step) && _isUserVisibleTurn(m));
      const dispatchIdx = explicitIdx >= 0 ? explicitIdx : section.findIndex((m, idx) =>
        !usedDispatches.has(idx) && _messageTargetsAssignee(m, assignee, lookup));
      let doneIdx = -1;
      if (explicitDoneIdx >= 0) {
        doneIdx = explicitDoneIdx;
      } else if (assignee === 'commander') {
        const start = Math.max(0, previousDoneIdx + 1);
        doneIdx = section.findIndex((m, idx) =>
          idx >= start
          && !usedDoneTurns.has(idx)
          && _isUserVisibleTurn(m)
          && _actorMatches(m.from || m.role, 'commander', lookup));
      } else if (assignee) {
        const start = dispatchIdx >= 0 ? dispatchIdx : Math.max(0, previousDoneIdx + 1);
        doneIdx = section.findIndex((m, idx) =>
          idx >= start
          && !usedDoneTurns.has(idx)
          && _isUserVisibleTurn(m)
          && _actorMatches(m.from || m.role, assignee, lookup));
      }
      if (doneIdx >= 0) {
        usedDoneTurns.add(doneIdx);
        if (dispatchIdx >= 0) usedDispatches.add(dispatchIdx);
        previousDoneIdx = Math.max(previousDoneIdx, doneIdx);
        return { ...step, status: 'done' };
      }
      if (dispatchIdx >= 0) {
        usedDispatches.add(dispatchIdx);
        return { ...step, status: 'in_progress' };
      }
      return step;
    });
  }

  function _buildTasks() {
    const history = _snapshot.history || [];
    const plan = _snapshot.plan;
    const lookup = _buildMemberLookup(_snapshot.members);
    const tasks = [];
    for (let i = 0; i < history.length; i++) {
      const m = history[i];
      if (!m || !m.plan_announcement) continue;
      const nextPlanIdx = history.findIndex((next, idx) => idx > i && next && next.plan_announcement);
      const sectionEnd = nextPlanIdx >= 0 ? nextPlanIdx : history.length;
      const parsedSteps = _parseAnnouncementSteps(m.text || m.content || '', lookup);
      const fallbackTitle = _nearestPriorUserText(history, i - 1)
        || _currentConversationTitle()
        || _label('conversation_info.task_plan_fallback', 'Execution plan');
      tasks.push({
        id: `plan-${m.id || i}`,
        title: fallbackTitle,
        time: m.ts || m.time || '',
        steps: _inferHistoricalSteps(parsedSteps, history.slice(i + 1, sectionEnd), lookup),
        _historyIndex: i,
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
        tasks[tasks.length - 1] = { ...tasks[tasks.length - 1], ...current, _historyIndex: tasks[tasks.length - 1]._historyIndex };
      } else {
        tasks.push(current);
      }
    }

    return tasks
      .sort((a, b) => {
        const at = new Date(a.time || 0).getTime();
        const bt = new Date(b.time || 0).getTime();
        const timeDiff = (Number.isFinite(bt) ? bt : 0) - (Number.isFinite(at) ? at : 0);
        if (timeDiff !== 0) return timeDiff;
        return (b._historyIndex ?? -1) - (a._historyIndex ?? -1);
      })
      .map(({ _historyIndex, ...task }) => task);
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
    const lookup = _buildMemberLookup(_snapshot.members);
    const actor = lookup.byKey.get(_normalizeActorKey(a));
    return '@' + (actor?.name || a);
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

  function _collectHistoryProducedFiles() {
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
    const root = { dirs: new Map(), files: [] };
    const hasRelPaths = files.some((f) => f && f.relPath);
    const common = hasRelPaths ? [] : _commonDirSegments(files.map((f) => f.path));
    for (const file of files) {
      const treePath = hasRelPaths ? (file.relPath || _baseName(file.path)) : file.path;
      const all = _splitPath(treePath);
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
      <details class="conversation-info-dir" style="--depth:${depth}">
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
              data-file-path="${escapeHtml(file.path)}" draggable="true" title="${escapeHtml(file.path)}">
        <span class="conversation-info-file-icon">${_iconForName(file.name)}</span>
        <span class="conversation-info-file-name">${escapeHtml(file.name)}</span>
      </button>
    `).join('');
    return dirHtml + fileHtml;
  }

  function _renderFiles() {
    const files = _collectVisibleFiles();
    if (!files.length) {
      return `<div class="conversation-info-empty">${escapeHtml(_label('conversation_info.empty_files', 'No files yet'))}</div>`;
    }
    const tree = _buildFileTree(files);
    const trunc = _snapshot.filesTruncated
      ? `<div class="conversation-info-empty is-small">${escapeHtml(_label('conversation_info.files_truncated', 'Showing first {count} files', { count: _snapshot.filesCount || files.length }))}</div>`
      : '';
    return `${trunc}<div class="conversation-info-tree">${_renderTreeNode(tree, 0)}</div>`;
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

  function _renderAttachments() {
    const items = _collectConversationAttachments();
    if (!items.length) {
      return `<div class="conversation-info-empty">${escapeHtml(_label('conversation_info.empty_attachments', 'No attachments'))}</div>`;
    }
    return `<div class="conversation-info-attachment-list">${items.map((item) => {
      const name = String(item.name || '');
      const label = String(item.displayName || item.name || '');
      const size = _formatBytes(item.bytes);
      const meta = [item.kind || '', size].filter(Boolean).join(' · ');
      return `
        <button type="button" class="conversation-info-attachment" data-attachment-name="${escapeHtml(name)}" title="${escapeHtml(label)}">
          <span class="conversation-info-file-icon">${_iconForName(label, item.kind)}</span>
          <span class="conversation-info-attachment-main">
            <span class="conversation-info-file-name">${escapeHtml(label)}</span>
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

  async function refreshTasks(cid, opts = {}) {
    const target = cid || _cid;
    if (!target || target !== _cid || !_open) return;
    const seq = ++_taskSeq;
    const silent = !!opts.silent;
    if (!silent && _activeTab === 'tasks') {
      _loading = true;
      _error = '';
      _renderBody();
    }
    try {
      const partial = await _loadTaskSnapshot(target);
      if (seq !== _taskSeq || target !== _cid) return;
      _snapshot = { ..._snapshot, ...partial };
      _error = '';
    } catch (err) {
      if (seq !== _taskSeq || target !== _cid) return;
      _error = (err && err.message) || String(err);
    } finally {
      if (seq === _taskSeq && target === _cid) {
        _loading = false;
        if (_activeTab === 'tasks') _renderBody();
      }
    }
  }

  function bind(cid) {
    _cid = cid || null;
    _open = false;
    _snapshot = { conversation: null, history: [], plan: null, members: [], files: [], fileRoot: '', fileRootExists: false, filesTruncated: false, filesCount: 0, attachments: [] };
    _error = '';
    _loading = false;
    _seq++;
    _taskSeq++;
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
    refreshTasks,
    refreshAttachments,
  };
})();

window.ConversationInfo = ConversationInfo;
