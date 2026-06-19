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
  let _fileSeq = 0;
  let _attachmentSeq = 0;
  const _locallyDeletedPaths = new Set();
  let _loading = false;
  let _error = '';
  let _snapshot = {
    conversation: null,
    history: [],
    plan: null,
    planControl: null,
    members: [],
    files: [],
    fileRoot: '',
    fileRootExists: false,
    filesTruncated: false,
    filesCount: 0,
    filesScanSkipped: false,
    syncEnabled: false,
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
    const ext = (String(name || '').split('.').pop() || '').toLowerCase();
    if (['png', 'jpg', 'jpeg', 'webp', 'gif'].includes(ext)) return 'image';
    if (['mp4', 'webm', 'mov', 'm4v', 'ogv'].includes(ext)) return 'video';
    if (ext === 'pdf') return 'pdf';
    if (ext === 'docx' || ext === 'docm') return 'docx';
    if (ext === 'xlsx' || ext === 'xlsm') return 'spreadsheet';
    if (ext === 'pptx' || ext === 'pptm') return 'presentation';
    if (['doc', 'xls', 'ppt'].includes(ext)) return 'legacy_office';
    return 'text';
  }

  function _canAddEntryToLibrary(kind) {
    return kind !== 'video' && kind !== 'dir';
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
    const [historyData, planData, memberData, filesData, attachmentData, syncEnabled] = await Promise.all([
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
      plan: planData.plan || null,
      planControl: planData.control || null,
      members: Array.isArray(memberData.actors) ? memberData.actors : [],
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
      planControl: planData.control || null,
      members: Array.isArray(memberData.actors) ? memberData.actors : [],
    };
  }

  async function _loadFileSnapshot(cid) {
    const enc = encodeURIComponent(cid);
    const [historyData, planData, filesData, syncEnabled] = await Promise.all([
      _fetchJson(`/api/conversations/${enc}/history?limit=500`),
      _fetchJson(`/api/conversations/${enc}/plan`).catch((err) => {
        _infoLog.warn('plan load failed', { cid, error: err && err.message });
        return { plan: null };
      }),
      _fetchJson(`/api/conversations/${enc}/files`).catch((err) => {
        _infoLog.warn('file list load failed', { cid, error: err && err.message });
        return { items: [], root: '', rootExists: false, truncated: false, count: 0, scanSkipped: false };
      }),
    ]);
    return {
      conversation: historyData.conversation || null,
      history: Array.isArray(historyData.history) ? historyData.history : [],
      plan: planData.plan || null,
      files: Array.isArray(filesData.items) ? filesData.items : [],
      fileRoot: typeof filesData.root === 'string' ? filesData.root : '',
      fileRootExists: filesData.rootExists === true,
      filesTruncated: filesData.truncated === true,
      filesCount: Number(filesData.count) || 0,
      filesScanSkipped: filesData.scanSkipped === true,
      syncEnabled: syncEnabled === true,
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

  // Deterministic id → palette pick — mirrors PC/docs/design/TOKENS.md §1.4
  // (agent role colors). Used for assignee avatars in the new Tasks/Files
  // body where the actor row may not carry a .color field.
  const _CI_MEMBER_PALETTE = ['#0ea5e9', '#8b5cf6', '#10b981', '#f59e0b', '#ef4444', '#06b6d4', '#16181d'];
  function _ciPickColor(actor) {
    if (actor && actor.color && typeof actor.color === 'string') return actor.color;
    const id = String((actor && actor.id) || actor || '');
    if (!id) return _CI_MEMBER_PALETTE[0];
    let h = 0;
    for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
    return _CI_MEMBER_PALETTE[h % _CI_MEMBER_PALETTE.length];
  }
  function _ciInitial(name) {
    return String((name || '?').trim().slice(0, 1)).toUpperCase();
  }

  // Compact elapsed `Nm Ss` style; mono-formatted in the header strip.
  function _ciFormatElapsed(plan) {
    if (!plan || !plan.created_at) return '';
    const start = new Date(plan.created_at).getTime();
    if (!Number.isFinite(start)) return '';
    const end = (plan.updated_at && _isPlanComplete(plan))
      ? new Date(plan.updated_at).getTime()
      : Date.now();
    const diff = Math.max(0, end - start);
    const s = Math.floor(diff / 1000);
    if (s < 60) return `${s}s`;
    const m = Math.floor(s / 60);
    const rs = s % 60;
    if (m < 60) return `${m}m ${rs}s`;
    const h = Math.floor(m / 60);
    return `${h}h ${m % 60}m`;
  }
  function _isPlanComplete(plan) {
    const steps = (plan && plan.steps) || [];
    return steps.length > 0 && steps.every((s) => s && (s.status === 'done' || s.status === 'skipped'));
  }
  function _planDoneCount(plan) {
    const steps = (plan && plan.steps) || [];
    return steps.filter((s) => s && (s.status === 'done' || s.status === 'skipped')).length;
  }

  /** Resolve the right-side avatar spec for a step's assignee. Returns
   *  `{icon, color, name, seed}` ready to feed `renderAvatarHtml`, or
   *  `null` when the caches haven't surfaced an icon yet (caller falls
   *  back to the legacy initial-color chip).
   *
   *  Cross-module symbols: `_agentsCache` lives in `agents.js`,
   *  `_commanderAvatar` in `conversation.js` — both are top-level per
   *  PC/CLAUDE.md §8 (no ESM in the renderer), so they're directly
   *  reachable here. Guarded with `typeof` for the cold-boot window
   *  before those modules' loaders have populated.
   */
  function _resolveAssigneeAvatar(assigneeId, actor) {
    if (!assigneeId) return null;
    const norm = _normalizeActorKey(assigneeId);
    // `user` / `用户` collapse into commander semantically: the plan author
    // (commander) is the one driving user-facing steps; the human is never a
    // worker in the orchestration model. So a step assigned to "user" is
    // really commander asking the user — display it as @指挥官 with the
    // commander avatar.
    if (norm === 'commander' || norm === 'user' || norm === '用户') {
      const av = (typeof _commanderAvatar === 'function') ? _commanderAvatar() : { icon: '', color: '' };
      return {
        icon: av.icon || '',
        color: av.color || '',
        name: _label('chat.recipient_commander', 'Commander'),
        seed: 'commander',
      };
    }
    // Plan `s.assignee` stores the @-mention text (the agent's display name,
    // e.g. "内容整理员"), not the 12-hex `agent_id`. `_buildMemberLookup`
    // indexes members.json by both id AND name, so `actor.id` carries the
    // canonical id when name resolution succeeded. Fall back to name match
    // for agents that aren't in members.json yet (fresh plan, no turn run).
    const canonicalId = (actor && actor.id) ? String(actor.id) : '';
    if (typeof _agentsCache !== 'undefined' && Array.isArray(_agentsCache)) {
      const ag = _agentsCache.find((x) => x && (
        (canonicalId && x.agent_id === canonicalId) || x.name === assigneeId
      ));
      if (ag) {
        return {
          icon: ag.icon || '',
          color: ag.color || '',
          name: ag.name || (actor && actor.name) || assigneeId,
          seed: ag.agent_id || assigneeId,
        };
      }
    }
    return null;
  }

  function _renderTasks() {
    const plan = _snapshot.plan;
    const control = _snapshot.planControl || {};
    const steps = (plan && Array.isArray(plan.steps)) ? plan.steps : [];
    if (!plan || !steps.length) {
      return `<div class="conversation-info-empty">${escapeHtml(_label('conversation_info.empty_tasks', 'No tasks yet'))}</div>`;
    }
    const done = _planDoneCount(plan);
    const elapsed = _ciFormatElapsed(plan);
    const bar = steps.map((s) => {
      const status = String(s && s.status || 'pending');
      let cls = '';
      if (status === 'done' || status === 'skipped') cls = ' is-done';
      else if (status === 'in_progress') cls = ' is-active';
      else if (status === 'failed') cls = ' is-failed';
      else if (status === 'blocked') cls = ' is-blocked';
      return `<span class="ci-tasks-bar-cell${cls}"></span>`;
    }).join('');
    const lookup = _buildMemberLookup(_snapshot.members);
    const checkIcon = _uiIcon('check', 'ci-tasks-step-check');
    const list = steps.map((s) => {
      const status = String(s && s.status || 'pending');
      let kind = 'queued';
      if (status === 'done') kind = 'done';
      else if (status === 'skipped') kind = 'skipped';
      else if (status === 'in_progress') kind = 'active';
      else if (status === 'failed') kind = 'failed';
      else if (status === 'blocked') kind = 'blocked';
      const assigneeId = String(s && s.assignee || '');
      const actor = lookup.byKey.get(_normalizeActorKey(assigneeId));
      const avatarSpec = _resolveAssigneeAvatar(assigneeId, actor);
      // Right-side avatar: agent's real icon + color (from `_agentsCache`)
      // or commander's avatar; fall back to the initial-color chip when the
      // caches haven't loaded yet or the assignee is a bare id string.
      let avatarHtml = '';
      if (avatarSpec && typeof renderAvatarHtml === 'function') {
        avatarHtml = renderAvatarHtml(avatarSpec.icon, avatarSpec.color, {
          size: 20,
          seed: avatarSpec.seed,
          extraClass: 'ci-tasks-step-avatar',
        });
      } else if (assigneeId) {
        const fallbackName = (actor && actor.name) || assigneeId;
        const fallbackColor = _ciPickColor({ id: assigneeId, color: actor && actor.color });
        avatarHtml = `<span class="ci-tasks-step-assignee" style="background:${fallbackColor}" title="${escapeHtml(fallbackName)}">${escapeHtml(_ciInitial(fallbackName))}</span>`;
      }
      // Assignee name line under the title — `@commander` / `@user` map
      // through i18n so a zh user sees 指挥官/用户 instead of the raw token,
      // matching `plan-rail.js::_formatAssigneeMeta` semantics.
      const displayName = (avatarSpec && avatarSpec.name) || (actor && actor.name) || assigneeId;
      const nameHtml = assigneeId
        ? `<div class="ci-tasks-step-assignee-name">@${escapeHtml(displayName)}</div>`
        : '';
      let inside = '';
      if (kind === 'done')   inside = checkIcon;
      else if (kind === 'active') inside = `<span class="ci-tasks-step-dot"></span>`;
      else if (kind === 'failed') inside = _uiIcon('x', 'ci-tasks-step-check');
      else if (kind === 'blocked') inside = _uiIcon('document-pencil', 'ci-tasks-step-check');
      return `
        <div class="ci-tasks-step is-${kind}" data-step-index="${escapeHtml(String(s.index || ''))}">
          <span class="ci-tasks-step-circle">${inside}</span>
          <div class="ci-tasks-step-main">
            <div class="ci-tasks-step-title">${escapeHtml(s.title || '')}</div>
            ${nameHtml}
          </div>
          ${avatarHtml}
        </div>
      `;
    }).join('');
    const planLabel = _label('plan.title', 'Execution Plan');
    const action = control.action;
    const controlHtml = (action === 'stop' || action === 'continue')
      ? `<button type="button" class="ci-tasks-control is-${escapeHtml(action)}" id="ci-tasks-plan-control" data-plan-action="${escapeHtml(action)}">${escapeHtml(action === 'stop'
        ? _label('plan.action.stop', 'Stop')
        : _label('plan.action.continue', 'Continue'))}</button>`
      : '';
    return `
      <div class="ci-tasks">
        <div class="ci-tasks-head">
          <div class="ci-tasks-head-row">
            <span class="ci-tasks-head-label">${escapeHtml(planLabel)}</span>
            <span class="ci-tasks-head-progress">${done}/${steps.length}</span>
            ${elapsed ? `<span class="ci-tasks-head-elapsed">${escapeHtml(elapsed)}</span>` : ''}
            ${controlHtml}
          </div>
          <div class="ci-tasks-bar">${bar}</div>
        </div>
        <div class="ci-tasks-list">${list}</div>
      </div>
    `;
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
    const planSteps = _snapshot.plan && Array.isArray(_snapshot.plan.steps)
      ? _snapshot.plan.steps : [];
    for (const step of planSteps) {
      const produced = Array.isArray(step && step.output_files) ? step.output_files : [];
      for (const p of produced) {
        if (!p) continue;
        const key = String(p);
        if (_isLocallyDeletedPath(key)) continue;
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
    const fileHtml = files.map((file) => `
      <div class="conversation-info-file" role="button" tabindex="0" style="--depth:${depth}"
              data-file-path="${escapeHtml(file.path)}" draggable="true" title="${escapeHtml(file.path)}">
        <span class="conversation-info-file-icon">${_iconForName(file.name)}</span>
        <span class="conversation-info-file-name">${escapeHtml(file.name)}</span>
        <button type="button" class="conversation-info-file-menu-btn" data-file-menu
                data-entry-kind="file" data-entry-path="${escapeHtml(file.path)}" data-entry-name="${escapeHtml(file.name)}"
                title="${escapeHtml(moreTitle)}" aria-label="${escapeHtml(moreTitle)}">⋯</button>
      </div>
    `).join('');
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
            'Cloud sync does not include these files. Add any file to Library if you want it synced.'
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
      const meta = [item.kind || '', size, time].filter(Boolean).join(' · ');
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
    const plan = _snapshot.plan;
    const steps = (plan && Array.isArray(plan.steps)) ? plan.steps : [];
    const tasksEl = document.getElementById('conversation-info-tab-count-tasks');
    if (tasksEl) {
      tasksEl.textContent = steps.length ? `${_planDoneCount(plan)}/${steps.length}` : '';
    }
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
    if (_activeTab === 'files') body.innerHTML = _renderFiles();
    else if (_activeTab === 'attachments') body.innerHTML = _renderAttachments();
    else body.innerHTML = _renderTasks();
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

  async function refreshFiles(cid, opts = {}) {
    const target = cid || _cid;
    if (!target || target !== _cid || !_open) return;
    const seq = ++_fileSeq;
    const silent = !!opts.silent;
    if (!silent && _activeTab === 'files') {
      _loading = true;
      _error = '';
      _renderBody();
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
      if (seq === _fileSeq && target === _cid && !silent) {
        _loading = false;
        if (_activeTab === 'files') _renderBody();
      }
    }
  }

  function bind(cid) {
    _cid = cid || null;
    _open = false;
    _snapshot = { conversation: null, history: [], plan: null, planControl: null, members: [], files: [], fileRoot: '', fileRootExists: false, filesTruncated: false, filesCount: 0, filesScanSkipped: false, syncEnabled: false, attachments: [] };
    _error = '';
    _loading = false;
    _seq++;
    _taskSeq++;
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

  async function _fallbackImportAttachments(entries) {
    const rejected = [];
    const imported = [];
    for (const entry of entries) {
      try {
        const res = await apiFetch(`/api/conversations/${encodeURIComponent(_cid)}/attachments/import`, {
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
    if (imported.length) await refreshAttachments(_cid);
    if (rejected.length) {
      await uiAlert(_label('chat.attach_rejected_prefix', 'The following files could not be uploaded:\n\n{list}', {
        list: rejected.join('\n'),
      }));
    }
  }

  function _fileActionPayload(absPath) {
    const payload = { path: absPath };
    if (_cid) payload.cid = _cid;
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
    document.querySelectorAll('.conversation-info-file.is-menu-open, .conversation-info-dir-summary.is-menu-open')
      .forEach((row) => row.classList && row.classList.remove && row.classList.remove('is-menu-open'));
    if (document.removeEventListener) {
      document.removeEventListener('mousedown', _onFileMenuOutside, true);
      document.removeEventListener('keydown', _onFileMenuKeyDown, true);
    }
    if (window.removeEventListener) window.removeEventListener('resize', _closeFileMenu);
  }

  function _onFileMenuOutside(ev) {
    const menu = document.getElementById('conversation-info-file-menu');
    if (!menu || menu.style.display === 'none') return;
    if (menu.contains(ev.target)) return;
    if (ev.target && ev.target.closest && ev.target.closest('.conversation-info-file-menu-btn')) return;
    _closeFileMenu();
  }

  function _onFileMenuKeyDown(ev) {
    if (ev.key === 'Escape') _closeFileMenu();
  }

  async function _openFileMenu(anchorBtn, absPath, displayName, kind) {
    if (!anchorBtn || !absPath) return;
    const menu = _ensureFileMenu();
    const sameFile = menu.dataset.filePath === absPath && menu.style.display !== 'none';
    if (sameFile) { _closeFileMenu(); return; }
    _closeFileMenu();

    const name = displayName || _baseName(absPath);
    const entryKind = kind === 'dir' ? 'dir' : 'file';
    const revealLabel = _label('conversation_info.file_reveal_action', 'Show in folder');
    const addLabel = _label('conversation_info.file_add_to_chat_action', 'Add to chat');
    const addLibraryLabel = _label('conversation_info.file_add_to_library_action', 'Add to Library');
    const saveAppLabel = _label('apps.save_from_file_action', 'Save as app');
    const deleteLabel = _label('common.delete', 'Delete');
    let canSaveApp = false;
    try {
      const inspected = await window.orkas.invoke('savedApps.inspectBundleFromPath', _fileActionPayload(absPath));
      canSaveApp = !!(inspected && inspected.ok !== false && inspected.canSave);
    } catch (_) { canSaveApp = false; }
    // Directory entries omit "add to chat" — only individual files can be
    // attached to the active conversation.
    const addItem = entryKind === 'file'
      ? `<div class="ctx-row-menu-item" data-action="add-to-chat">${escapeHtml(addLabel)}</div>`
      : '';
    const addLibraryItem = entryKind === 'file' && _canAddEntryToLibrary(kind)
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
    const row = anchorBtn.closest('.conversation-info-file, .conversation-info-dir-summary');
    if (row) row.classList.add('is-menu-open');
    _positionFileMenu(menu, anchorBtn);

    menu.querySelectorAll('.ctx-row-menu-item').forEach((item) => {
      item.addEventListener('click', async (e) => {
        e.stopPropagation();
        const action = item.dataset.action || '';
        _closeFileMenu();
        await _runFileMenuAction(action, absPath, name, entryKind);
      });
    });
    document.addEventListener('mousedown', _onFileMenuOutside, true);
    document.addEventListener('keydown', _onFileMenuKeyDown, true);
    window.addEventListener('resize', _closeFileMenu);
  }

  async function _revealEntry(absPath) {
    try {
      const res = await window.orkas.invoke('workspace.revealPath', _fileActionPayload(absPath));
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

  async function _addEntryToChat(absPath, kind) {
    if (!_cid) return;
    const entries = _attachmentEntriesForPath(absPath, kind);
    if (!entries.length) {
      await uiAlert(_label('conversation_info.dir_add_empty', 'No files in this folder can be added'));
      return;
    }
    if (typeof window.addChatAttachmentsFromPaths === 'function') {
      await window.addChatAttachmentsFromPaths(_cid, entries);
      return;
    }
    await _fallbackImportAttachments(entries);
  }

  async function _addEntryToLibrary(absPath, kind) {
    if (!_canAddEntryToLibrary(kind)) return;
    try {
      const res = await window.orkas.invoke('library.importProduced', _fileActionPayload(absPath));
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

  async function _saveEntryAsApp(absPath) {
    try {
      const res = await window.orkas.invoke('savedApps.saveFromPath', _fileActionPayload(absPath));
      if (!res || res.ok === false) throw new Error((res && res.error) || 'failed');
      const message = _label('apps.saved_toast', 'Saved to My Apps');
      if (typeof uiToast === 'function') uiToast(message, { variant: 'success' });
      else if (typeof uiAlert === 'function') await uiAlert(message);
      try { if (typeof loadSavedApps === 'function') loadSavedApps(true); } catch (_) {}
    } catch (err) {
      await uiAlert(_label('apps.save_failed', 'Could not save the app') + ': ' + String(err && err.message || err));
    }
  }

  async function _deleteEntry(absPath, displayName, kind) {
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
      const res = await window.orkas.invoke('workspace.deletePath', _fileActionPayload(absPath));
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
      refresh(_cid, { silent: true });
    } catch (err) {
      await uiAlert(_label(isDir ? 'conversation_info.dir_delete_failed' : 'conversation_info.file_delete_failed', 'Could not delete: {reason}', {
        reason: String(err && err.message || err),
      }));
    }
  }

  async function _runFileMenuAction(action, absPath, displayName, kind) {
    if (action === 'reveal') return _revealEntry(absPath);
    if (action === 'save-as-app') return _saveEntryAsApp(absPath);
    if (action === 'add-to-library') return _addEntryToLibrary(absPath, kind);
    if (action === 'add-to-chat') return _addEntryToChat(absPath, kind);
    if (action === 'delete') return _deleteEntry(absPath, displayName, kind);
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

  async function _runPlanControl(action) {
    if (!_cid || (action !== 'stop' && action !== 'continue')) return;
    if (typeof uiConfirm === 'function') {
      const ok = await uiConfirm(action === 'stop'
        ? _label('plan.confirm.stop', 'Stop the execution plan?')
        : _label('plan.confirm.continue', 'Continue the execution plan?'));
      if (!ok) return;
    }
    try {
      await window.orkas.invoke(action === 'stop' ? 'groupChat.abort' : 'groupChat.continuePlan', { cid: _cid });
      if (action === 'continue' && window.ConversationRuntime && typeof window.ConversationRuntime.observePlanRecoveryRun === 'function') {
        window.ConversationRuntime.observePlanRecoveryRun(_cid);
      }
      if (window.PlanRail) window.PlanRail.refresh(_cid, { force: true });
      await refreshTasks(_cid, { silent: true });
    } catch (err) {
      _infoLog.warn('plan-control failed', { cid: _cid, action, error: String(err && err.message || err) });
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
        const planControl = ev.target.closest('#ci-tasks-plan-control');
        if (planControl) {
          ev.preventDefault();
          _runPlanControl(planControl.dataset.planAction || '');
          return;
        }
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

  // External callers (chat header "详情" button, plan strip "展开详情",
  // i18n-change listeners) read open/close/toggle via this surface. Keeping
  // the imperative variant + `openAndSetTab(tab)` shorthand instead of
  // exposing _setOpen + _setActiveTab separately keeps the contract narrow.
  function open()  { _setOpen(true); }
  function close() { _setOpen(false); }
  function toggle() { _setOpen(!_open); }
  function openAndSetTab(tab) {
    _activeTab = tab || 'tasks';
    _setOpen(true);
    _syncChrome();
    _renderBody();
  }

  return {
    bind,
    unbind,
    refresh,
    refreshTasks,
    refreshFiles,
    refreshAttachments,
    open,
    close,
    toggle,
    openAndSetTab,
  };
})();

window.ConversationInfo = ConversationInfo;
