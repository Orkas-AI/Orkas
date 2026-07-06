// ─── Auto tab ──────────────────────────────────────────────────────
// Sidebar peer of Commander / Agents / Skills. Lists user-authored
// auto tasks; each task is a (content + schedule + optional project
// scope) tuple. Reads / writes via `autoTasks.*` IPC channels;
// features/auto_tasks.ts in main handles persistence + the in-process
// scheduler that fires due tasks through groupChat.send.
//
// Layout (inline, no modal):
//   #panel-auto
//     .auto-scroll
//       .auto-create-section   create-or-edit form (always visible)
//       .auto-list-section     existing task list
//
// Edit happens by pre-filling the same create form (submit button toggles
// from "创建" to "保存", a "取消编辑" button shows). On submit or cancel
// the form resets to create mode. Project-detail's auto card lists
// tasks too; clicking its row's edit navigates here and enters edit mode.
//
// Reuses `.btn`, `.empty`, `.muted`, `.form-row`, `_aiSelectMount`, and the
// `.new-chat-input-area` chrome (CLAUDE.md §7 component reuse). Recipient
// chip + @ picker are wired by `agents.js::bindRecipientAnchor` against
// the new `'auto-recipient-chip'` anchor id.

const _autoLog = (typeof createLogger === 'function')
  ? createLogger('auto')
  : { info() {}, warn() {}, error() {} };

function _autoTrackClick(action, data) {
  try { if (window.Monitor) (() => {})(action, data || {}); } catch (_) {}
}

function _autoTrackEvent(action, data) {
  try { if (window.Monitor) (() => {})(action, data || {}); } catch (_) {}
}

function _autoTrackError(action, data) {
  try { if (window.Monitor) (() => {})(action, data || {}); } catch (_) {}
}

function _autoAttachmentPayload(files, source) {
  const list = Array.from(files || []);
  let totalBytes = 0;
  for (const file of list) totalBytes += Number((file && (file.size || file.bytes)) || 0);
  return {
    source,
    file_count: list.length,
    total_bytes: totalBytes,
    mode: _autoEditingTaskId ? 'edit' : 'create',
  };
}

const AUTO_ATTACH_ACCEPT = (typeof CHAT_ATTACH_ACCEPT !== 'undefined' && Array.isArray(CHAT_ATTACH_ACCEPT))
  ? CHAT_ATTACH_ACCEPT
  : [
      '.md', '.markdown', '.txt', '.csv', '.tsv', '.json', '.yaml', '.yml', '.log',
      '.pdf', '.docx', '.docm', '.xlsx', '.xlsm', '.pptx', '.pptm',
      '.png', '.jpg', '.jpeg', '.webp', '.gif',
      '.mp4', '.webm', '.mov', '.m4v', '.ogv',
      '.mp3', '.wav', '.ogg', '.opus', '.m4a', '.aac', '.flac',
    ];

function _autoAttachBaseName(p) {
  const parts = String(p || '').split(/[\\/]/).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : String(p || '');
}

function _autoAttachExtOf(name) {
  if (typeof _chatAttachExtOf === 'function') return _chatAttachExtOf(name);
  const i = String(name || '').lastIndexOf('.');
  return i >= 0 ? String(name || '').slice(i).toLowerCase() : '';
}

function _autoAttachKindFromExt(ext) {
  if (typeof _chatAttachKindFromExt === 'function') return _chatAttachKindFromExt(ext);
  if (['.png', '.jpg', '.jpeg', '.webp', '.gif'].includes(ext)) return 'image';
  if (['.mp4', '.webm', '.mov', '.m4v', '.ogv'].includes(ext)) return 'video';
  if (['.mp3', '.wav', '.ogg', '.opus', '.m4a', '.aac', '.flac'].includes(ext)) return 'audio';
  if (ext === '.pdf') return 'pdf';
  if (ext === '.docx' || ext === '.docm') return 'docx';
  if (ext === '.xlsx' || ext === '.xlsm') return 'spreadsheet';
  if (ext === '.pptx' || ext === '.pptm') return 'presentation';
  return 'text';
}

function _autoAttachKindForName(name, fallback = '') {
  return fallback || _autoAttachKindFromExt(_autoAttachExtOf(name));
}

function _autoAttachTempId() {
  return `auto-att-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function _autoAttachDisplayName(item) {
  return (item && (item.displayName || item.name)) || '';
}

let _autoTasks = [];           // last fetched global list
let _autoLoadedOnce = false;
let _autoEventsHandle = null;
let _autoFormMounted = false;  // _aiSelectMount only once
let _autoEditingTaskId = null; // null = create mode, taskId = edit mode
// Current device fingerprint — fetched lazily on first row render. Used to
// decide which device chip to show ("this device" vs. the task's stored hostname).
let _autoCurrentDevice = null; // { id, name } | null
async function _ensureAutoCurrentDevice() {
  if (_autoCurrentDevice) return _autoCurrentDevice;
  try {
    const res = await window.orkas.invoke('autoTasks.currentDevice');
    _autoCurrentDevice = (res && res.device) ? res.device : { id: '', name: '' };
  } catch (_) { _autoCurrentDevice = { id: '', name: '' }; }
  return _autoCurrentDevice;
}
let _autoCloudSyncEnabled = false;
function _autoSyncApiAvailable() {
  return false;
}
async function _refreshAutoSyncNotice() {
  if (!_autoSyncApiAvailable()) {
    _autoCloudSyncEnabled = false;
    _paintAutoSyncNotice();
    return false;
  }
  _autoCloudSyncEnabled = false;
  _paintAutoSyncNotice();
  return _autoCloudSyncEnabled;
}
function _paintAutoSyncNotice() {
  const listText = t('auto.sync_note_list');
  const createText = t('auto.sync_note_create');
  const targets = [
    { id: 'auto-sync-note', text: listText },
    { id: 'project-auto-sync-note', text: listText },
    { id: 'auto-task-dialog-sync-note', text: createText },
  ];
  for (const item of targets) {
    const el = document.getElementById(item.id);
    if (!el) continue;
    el.hidden = !_autoCloudSyncEnabled;
    el.textContent = _autoCloudSyncEnabled ? item.text : '';
  }
}
let _autoCurrentRecipient = { kind: 'commander' };
// Skill / connector pinned to this draft. Mirrors the commander composer's
// single-chip slot: setting one clears the other (matches the bus-side
// invariant that a single message can't pin both). Either may be null/empty.
// Pre-allocated id used for attachments uploaded BEFORE the task record
// exists. On submit, `autoTasks.create` adopts this id so the
// already-uploaded files live under the right per-task dir from the start.
// Allocated lazily on first attach + on edit-mode entry (= task.id).
let _autoCurrentTaskId = '';
let _autoCurrentAttachments = []; // [{ name, displayName?, kind?, bytes?, status? }]

// Cached `_aiSelectMount` handles for the inline form. Set on first mount.
let _autoFreqSel = null;
let _autoWeekdaySel = null;
let _autoMonthlyDaySel = null;
let _autoHourSel = null;
let _autoMinuteSel = null;
let _autoProjectSel = null;
// Set by `openAutoTaskDialog({projectId})` from the project-detail entry —
// the task gets bound to this project on save. Global-tab opens omit it,
// producing a project-less task. (No project picker inside the modal; the
// project a task lives under is determined by where it was created from.)
let _autoLockedProjectId = '';
let _autoEditingProjectId = '';
// Optional callback the dialog opener can pass to be notified after a
// successful save. Used by project-detail's auto tab to refresh its list.
let _autoOnSaved = null;

function _autoNormaliseTitle(raw) {
  let title = String(raw || '').trim();
  if (typeof window.limitNameDisplayText === 'function') title = window.limitNameDisplayText(title);
  return title;
}

function _bindAutoTitleNameLimit() {
  const input = document.getElementById('auto-title-input');
  if (input && typeof window.bindNameLimitControl === 'function') window.bindNameLimitControl(input);
}

// ─── Pretty-printers (used by both global list and project-detail card) ──

function _autoPadHM(n) { return String(Math.max(0, Math.min(59, Number(n) | 0))).padStart(2, '0'); }

function _autoFormatSummary(task) {
  const s = task.schedule || {};
  if (s.type === 'one_time') {
    let when = s.at;
    try {
      const d = new Date(s.at);
      when = (typeof formatIsoForList === 'function')
        ? formatIsoForList(d.toISOString())
        : d.toLocaleString();
    } catch (_) { /* fall through with raw */ }
    return t('auto.summary_one_time', { when });
  }
  const time = _autoPadHM(s.hour) + ':' + _autoPadHM(s.minute);
  if (s.type === 'daily') return t('auto.summary_daily', { time });
  if (s.type === 'weekly') {
    return t('auto.summary_weekly', { day: t('auto.weekday.' + s.weekday), time });
  }
  if (s.type === 'monthly') {
    const day = (s.day === 31) ? t('auto.day_last') : t('auto.day_value', { day: s.day });
    return t('auto.summary_monthly', { day, time });
  }
  return '';
}

function _autoFormatLastRun(iso) {
  if (!iso) return t('auto.never_run');
  let when;
  if (typeof formatIsoForList === 'function') when = formatIsoForList(iso);
  else {
    try { when = new Date(iso).toLocaleString(); }
    catch { when = String(iso).slice(0, 16).replace('T', ' '); }
  }
  return t('auto.last_run', { when });
}

function _autoDisplayDeviceName(name) {
  const raw = String(name || '').trim();
  if (!raw) return '';
  const display = raw.replace(/\.local\.?$/i, '');
  return display || raw;
}

function _buildProjectNameLookup() {
  return (pid) => {
    try {
      if (typeof _projectsCache !== 'undefined' && Array.isArray(_projectsCache)) {
        const p = _projectsCache.find((x) => x && x.project_id === pid);
        if (p && p.name) return p.name;
      }
    } catch (_) { /* ignore */ }
    return pid;
  };
}

// ─── Row rendering (shared between global tab and project-detail card) ──

function _autoRenderRow(task, opts) {
  // opts: { showProjectBadge?: boolean, onEdit: (task) => void, afterChange: () => void }
  const row = document.createElement('div');
  row.className = 'auto-row' + (task.enabled ? '' : ' is-disabled');
  row.dataset.taskId = task.id;

  // ── Main column (left) ────────────────────────────────────────────────
  // Layout: content preview (primary) → chip row (recipient / skill /
  // connector / attachment count). Title is folded into the content area
  // as a secondary line below the message preview, since the schedule
  // summary moved to the right column.
  const contentPreview = (task.content || '').slice(0, 160);
  const contentHtml = contentPreview
    ? `<div class="auto-row-content">${escapeHtml(contentPreview)}${task.content.length > 160 ? '…' : ''}</div>`
    : `<div class="auto-row-content auto-row-content-empty muted">${escapeHtml(t('auto.invalid_content'))}</div>`;
  const titleHtml = task.title
    ? `<div class="auto-row-title muted">${escapeHtml(task.title)}</div>`
    : '';

  // Chip row — only emitted for fields actually set on this task.
  const chips = [];
  if (task.recipient && task.recipient.kind === 'agent' && task.recipient.name) {
    chips.push(`<span class="auto-row-chip is-agent">${escapeHtml('@' + task.recipient.name)}</span>`);
  }
  if (task.skill && task.skill.name) {
    chips.push(`<span class="auto-row-chip is-skill">${escapeHtml(t('skills.use_label', { skill: task.skill.name }))}</span>`);
  }
  if (task.connector && task.connector.name) {
    chips.push(`<span class="auto-row-chip is-connector">${escapeHtml(t('connectors.use_label', { connector: task.connector.name }))}</span>`);
  }
  const attachCount = Array.isArray(task.attachments) ? task.attachments.length : 0;
  if (attachCount > 0) {
    chips.push(`<span class="auto-row-chip is-attach">📎 ${escapeHtml(t('auto.attachment_count', { n: attachCount }))}</span>`);
  }
  if (opts && opts.showProjectBadge && task.project_id) {
    const pname = _buildProjectNameLookup()(task.project_id) || task.project_id;
    chips.push(`<span class="auto-row-chip is-project">${escapeHtml(t('auto.project_scope', { name: pname }))}</span>`);
  }
  // Device chip — always shown so the user can tell at a glance which
  // machine each task is bound to. "本机" when the task was created here
  // (or for legacy tasks created before device-stamping shipped — treated
  // as current-device since they live in this uid's local cloud tree).
  // Otherwise the creator's hostname; hover tooltip spells out that
  // remote-device tasks don't fire locally.
  if (_autoCurrentDevice) {
    const isHere = !task.device_id || task.device_id === _autoCurrentDevice.id;
    if (isHere) {
      chips.push(`<span class="auto-row-chip is-device is-device-here">${escapeHtml(t('auto.device_current'))}</span>`);
    } else {
      const hostname = _autoDisplayDeviceName(task.device_name || task.device_id);
      const hint = t('auto.device_remote_hint', { name: hostname });
      chips.push(`<span class="auto-row-chip is-device is-device-remote" title="${escapeHtml(hint)}">${escapeHtml(hostname)}</span>`);
    }
  }
  const chipsHtml = chips.length ? `<div class="auto-row-chips">${chips.join('')}</div>` : '';

  // ── Right column (schedule + last run + ⋯) ───────────────────────────
  const summary = escapeHtml(_autoFormatSummary(task));
  const lastRun = escapeHtml(_autoFormatLastRun(task.last_run_at));
  const moreTitle = escapeHtml(t('auto.more_menu'));

  // Conversation count badge — number of convs in the global cache whose
  // origin_auto_task_id matches this task. Used for the "Conversations (N)"
  // expand header.
  const convCount = _autoCountConvsForTask(task.id);
  const expandIcon = (typeof window !== 'undefined' && typeof window.uiIconHtml === 'function')
    ? window.uiIconHtml('chevron-down', 'auto-row-expand-icon')
    : '▾';

  row.innerHTML = `
    <div class="auto-row-head">
      <button type="button" class="auto-row-expand" data-act="expand" aria-expanded="false" aria-label="${escapeHtml(t('auto.task_convs', { n: convCount }))}">
        ${expandIcon}
      </button>
      <div class="auto-row-main">
        ${contentHtml}
        ${titleHtml}
        ${chipsHtml}
      </div>
      <div class="auto-row-side">
        <div class="auto-row-schedule">${summary}</div>
        <div class="auto-row-lastrun">${lastRun}</div>
      </div>
      <button type="button" class="auto-row-more" data-act="more" title="${moreTitle}" aria-label="${moreTitle}">⋯</button>
    </div>
    <div class="auto-row-convs" hidden>
      <div class="auto-row-convs-head muted">${escapeHtml(t('auto.task_convs', { n: convCount }))}</div>
      <div class="auto-row-convs-list"></div>
    </div>
  `;

  // ── ⋯ menu (enable/disable + edit + delete) ──────────────────────────
  const moreBtn = row.querySelector('[data-act="more"]');
  moreBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    _openAutoRowMenu(moreBtn, task, opts);
  });
  // ── Expand toggle ────────────────────────────────────────────────────
  // Clicking anywhere on the row toggles expand/collapse — chevron is just
  // a visual cue. Interactive controls inside the card (⋯ button, chips,
  // nested conv items) stop propagation so they don't trigger the toggle.
  const expandBtn = row.querySelector('[data-act="expand"]');
  const convsWrap = row.querySelector('.auto-row-convs');
  const convsList = row.querySelector('.auto-row-convs-list');
  const toggleExpand = () => {
    const expanded = expandBtn.getAttribute('aria-expanded') === 'true';
    if (expanded) {
      expandBtn.setAttribute('aria-expanded', 'false');
      row.classList.remove('is-expanded');
      convsWrap.hidden = true;
    } else {
      expandBtn.setAttribute('aria-expanded', 'true');
      row.classList.add('is-expanded');
      convsWrap.hidden = false;
      _autoRenderTaskConvs(task.id, convsList);
    }
  };
  // Whole-row click → toggle, including clicks on the expanded panel's
  // header / empty hint (so the user can collapse by clicking anywhere
  // outside an actual interactive control). Only the conv-item rows
  // inside the panel and the ⋯ menu keep their own click semantics —
  // those would otherwise navigate to a conversation, which we don't want
  // to accidentally trigger when the user is trying to collapse the card.
  row.addEventListener('click', (e) => {
    if (e.target.closest('.auto-row-more, .auto-row-menu, .conv-item, .conv-item-action')) return;
    toggleExpand();
  });
  return row;
}

// Conversation count for a given task id — reads the shared `conversations`
// global populated by conversation.js. Auto-fired convs carry
// `origin_auto_task_id` (set by features/auto_tasks.ts on fire).
function _autoCountConvsForTask(taskId) {
  if (typeof conversations === 'undefined' || !Array.isArray(conversations)) return 0;
  return conversations.filter((c) => c && c.origin_auto_task_id === taskId).length;
}

function _autoRefreshTaskConvsChrome(taskId, container) {
  if (!container) return;
  const row = container.closest('.auto-row');
  if (!row) return;
  const count = _autoCountConvsForTask(taskId);
  const label = t('auto.task_convs', { n: count });
  const head = row.querySelector('.auto-row-convs-head');
  if (head) head.textContent = label;
  const expandBtn = row.querySelector('[data-act="expand"]');
  if (expandBtn) expandBtn.setAttribute('aria-label', label);
}

/** Render the list of conversations spawned by this task into the given
 *  container. Reuses the shared conversation row renderer so streaming dots
 *  and delete behave the same as the sidebar, while hiding pin controls in
 *  this execution-history surface. */
function _autoRenderTaskConvs(taskId, container) {
  if (!container) return;
  _autoRefreshTaskConvsChrome(taskId, container);
  const matches = (typeof conversations !== 'undefined' && Array.isArray(conversations))
    ? conversations.filter((c) => c && c.origin_auto_task_id === taskId)
    : [];
  if (!matches.length) {
    container.innerHTML = `<div class="muted auto-row-convs-empty">${escapeHtml(t('auto.no_convs'))}</div>`;
    return;
  }
  container.innerHTML = (typeof _renderConversationTimeBucketList === 'function')
    ? _renderConversationTimeBucketList(matches, { nested: true, hidePin: true, bucketScope: `auto:${taskId}` })
    : matches
        .slice()
        .sort((a, b) => {
          const ta = a.last_active_at || a.updated_at || a.created_at || '';
          const tb = b.last_active_at || b.updated_at || b.created_at || '';
          return tb.localeCompare(ta);
        })
        .map((c) => _renderConversationSidebarItem(c, { nested: true, hidePin: true }))
        .join('');
  if (typeof _bindConversationSidebarItems === 'function') {
    _bindConversationSidebarItems(container, {
      selector: '.conv-item',
      onBucketToggle: () => _autoRenderTaskConvs(taskId, container),
      async afterDelete() {
        _autoRenderTaskConvs(taskId, container);
      },
    });
  }
  if (typeof _refreshAllConvBadges === 'function') _refreshAllConvBadges();
}

function _refreshAutoExpandedTaskConvs() {
  const rows = document.querySelectorAll('.auto-row.is-expanded[data-task-id]');
  for (const row of rows) {
    const taskId = row.dataset.taskId;
    const list = row.querySelector('.auto-row-convs-list');
    if (taskId && list) _autoRenderTaskConvs(taskId, list);
  }
}

// One shared popover for all auto-task ⋯ menus. Mirrors `.agent-row-menu`:
// fixed-position, click-outside closes, Escape closes.
let _autoMenuEl = null;
function _ensureAutoMenu() {
  if (_autoMenuEl) return _autoMenuEl;
  const m = document.createElement('div');
  m.className = 'auto-row-menu';
  m.style.display = 'none';
  document.body.appendChild(m);
  document.addEventListener('click', (e) => {
    if (!_autoMenuEl || _autoMenuEl.style.display === 'none') return;
    if (_autoMenuEl.contains(e.target)) return;
    if (e.target.closest('.auto-row-more')) return;
    _closeAutoRowMenu();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && _autoMenuEl && _autoMenuEl.style.display !== 'none') _closeAutoRowMenu();
  });
  window.addEventListener('scroll', _closeAutoRowMenu, true);
  window.addEventListener('resize', _closeAutoRowMenu);
  _autoMenuEl = m;
  return m;
}
function _closeAutoRowMenu() {
  if (_autoMenuEl) {
    _autoMenuEl.style.display = 'none';
    _autoMenuEl.innerHTML = '';
  }
  for (const el of document.querySelectorAll('.auto-row.is-menu-open')) {
    el.classList.remove('is-menu-open');
  }
}

function _openAutoRowMenu(anchorBtn, task, opts) {
  const menu = _ensureAutoMenu();
  // Toggle off if already open for this task.
  if (menu.style.display !== 'none' && menu.dataset.taskId === task.id) {
    _closeAutoRowMenu();
    return;
  }
  for (const el of document.querySelectorAll('.auto-row.is-menu-open')) el.classList.remove('is-menu-open');
  anchorBtn.closest('.auto-row')?.classList.add('is-menu-open');
  menu.dataset.taskId = task.id;
  const toggleLabel = task.enabled ? t('auto.disable_btn') : t('auto.enable_btn');
  menu.innerHTML = `
    <div class="auto-row-menu-item" data-action="toggle-enabled">${escapeHtml(toggleLabel)}</div>
    <div class="auto-row-menu-item" data-action="edit">${escapeHtml(t('auto.edit_btn'))}</div>
    <div class="auto-row-menu-item is-danger" data-action="delete">${escapeHtml(t('auto.delete_btn'))}</div>
  `;
  for (const item of menu.querySelectorAll('.auto-row-menu-item')) {
    item.addEventListener('click', async (e) => {
      e.stopPropagation();
      const action = item.dataset.action;
      _closeAutoRowMenu();
      if (action === 'toggle-enabled') {
        const next = !task.enabled;
        try {
          const res = await window.orkas.invoke('autoTasks.setEnabled', { taskId: task.id, enabled: next });
          if (res && res.ok && res.task) {
            Object.assign(task, res.task);
            const row = document.querySelector(`.auto-row[data-task-id="${task.id}"]`);
            if (row) row.classList.toggle('is-disabled', !next);
            if (opts && typeof opts.afterChange === 'function') opts.afterChange();
          }
        } catch (err) { _autoLog.warn('toggle failed', err); }
      } else if (action === 'edit') {
        if (opts && typeof opts.onEdit === 'function') opts.onEdit(task);
      } else if (action === 'delete') {
        if (!(await uiConfirm(t('auto.delete_confirm')))) return;
        try {
          const res = await window.orkas.invoke('autoTasks.delete', { taskId: task.id });
          if (res && res.deleted && opts && typeof opts.afterChange === 'function') opts.afterChange();
        } catch (err) {
          await uiAlert(t('auto.delete_failed', { reason: (err && err.message) || err }));
        }
      }
    });
  }
  // Position the menu just below the anchor, right-aligned.
  const rect = anchorBtn.getBoundingClientRect();
  menu.style.display = 'block';
  const w = menu.offsetWidth;
  const h = menu.offsetHeight;
  let top = rect.bottom + 4;
  let left = rect.right - w;
  if (top + h > window.innerHeight) top = rect.top - h - 4;
  if (left < 8) left = 8;
  menu.style.top = top + 'px';
  menu.style.left = left + 'px';
}

// ─── Global auto tab — list rendering + form wiring ────────────────

async function loadAutoList(force) {
  const listEl = document.getElementById('auto-list');
  const emptyEl = document.getElementById('auto-empty');
  if (!listEl) return;
  await _refreshAutoSyncNotice();
  if (_autoLoadedOnce && !force) return;
  // Fetch device fingerprint in parallel with the task list so the device
  // chip can paint on the first render.
  await _ensureAutoCurrentDevice();
  try {
    const res = await window.orkas.invoke('autoTasks.list', {});
    _autoTasks = (res && Array.isArray(res.tasks)) ? res.tasks : [];
  } catch (err) {
    _autoTasks = [];
    _autoLog.warn('list failed', err);
    if (typeof uiAlert === 'function') uiAlert(t('auto.load_failed', { reason: (err && err.message) || err }));
  }
  _autoLoadedOnce = true;
  listEl.innerHTML = '';
  const headerCount = document.getElementById('auto-header-count');
  const n = _autoTasks.length;
  if (headerCount) headerCount.textContent = n > 0 ? String(n) : '';
  if (!_autoTasks.length) {
    if (emptyEl) emptyEl.style.display = '';
    return;
  }
  if (emptyEl) emptyEl.style.display = 'none';
  const onEdit = (task) => openAutoTaskDialog({ task });
  const afterChange = () => loadAutoList(true);
  for (const task of _autoTasks) {
    listEl.appendChild(_autoRenderRow(task, {
      showProjectBadge: true,
      onEdit,
      afterChange,
    }));
  }
}

// ─── Project-detail card ─────────────────────────────────────────────────

async function loadProjectAutoList(projectId) {
  const listEl = document.getElementById('project-auto-list');
  const emptyEl = document.getElementById('project-auto-empty');
  const countEl = document.getElementById('project-auto-tab-count');
  if (!listEl) return;
  await _ensureAutoCurrentDevice();
  await _refreshAutoSyncNotice();
  if (!projectId) {
    listEl.innerHTML = '';
    if (emptyEl) emptyEl.style.display = '';
    if (countEl) countEl.textContent = '';
    return;
  }
  let tasks = [];
  try {
    const res = await window.orkas.invoke('autoTasks.list', { projectId });
    tasks = (res && Array.isArray(res.tasks)) ? res.tasks : [];
  } catch (err) {
    _autoLog.warn('project list failed', err);
  }
  listEl.innerHTML = '';
  if (countEl) countEl.textContent = tasks.length > 0 ? String(tasks.length) : '';
  if (!tasks.length) {
    if (emptyEl) emptyEl.style.display = '';
    return;
  }
  if (emptyEl) emptyEl.style.display = 'none';
  // Edit + delete + toggle all happen via the same shared modal / row menu.
  // Edit opens the dialog with the host project pre-bound (locked mode).
  const onEdit = (task) => openAutoTaskDialog({
    task,
    projectId,
    onSaved: () => loadProjectAutoList(projectId),
  });
  const afterChange = () => {
    loadProjectAutoList(projectId);
    if (_autoLoadedOnce) loadAutoList(true).catch(() => {});
  };
  for (const task of tasks) {
    listEl.appendChild(_autoRenderRow(task, {
      showProjectBadge: false,
      onEdit,
      afterChange,
    }));
  }
}

// ─── Inline create / edit form ───────────────────────────────────────────

function _autoFreqOptions() {
  return [
    { value: 'one_time', label: t('auto.freq_one_time') },
    { value: 'daily',    label: t('auto.freq_daily') },
    { value: 'weekly',   label: t('auto.freq_weekly') },
    { value: 'monthly',  label: t('auto.freq_monthly') },
  ];
}

function _autoWeekdayOptions() {
  return [0, 1, 2, 3, 4, 5, 6].map((d) => ({ value: String(d), label: t('auto.weekday.' + d) }));
}

function _autoMonthlyDayOptions() {
  const opts = [];
  for (let d = 1; d <= 30; d++) opts.push({ value: String(d), label: t('auto.day_value', { day: d }) });
  opts.push({ value: '31', label: t('auto.day_last') });
  return opts;
}

/** Project picker options: leading "无" + every project in the cache.
 *  Refreshed on every `openAutoTaskDialog` so newly-created projects appear
 *  without needing a renderer reload. */
function _autoProjectOptions() {
  const opts = [{ value: '', label: t('auto.project_none') }];
  try {
    if (typeof _projectsCache !== 'undefined' && Array.isArray(_projectsCache)) {
      for (const p of _projectsCache) {
        if (p && p.project_id) opts.push({ value: p.project_id, label: p.name || p.project_id });
      }
    }
  } catch (_) { /* ignore */ }
  return opts;
}

function _autoProjectExists(projectId) {
  const pid = String(projectId || '');
  if (!pid) return false;
  try {
    if (typeof _projectsCache !== 'undefined' && Array.isArray(_projectsCache)) {
      return _projectsCache.some((p) => p && p.project_id === pid);
    }
  } catch (_) { /* no project cache in this renderer/test context */ }
  return true;
}

function _autoValidProjectId(projectId) {
  const pid = String(projectId || '');
  return pid && _autoProjectExists(pid) ? pid : '';
}

function _autoHasProjects() {
  try {
    return typeof _projectsCache !== 'undefined'
      && Array.isArray(_projectsCache)
      && _projectsCache.some((p) => p && p.project_id);
  } catch (_) { return false; }
}

function _autoSelectedProjectId() {
  if (_autoLockedProjectId) return _autoValidProjectId(_autoLockedProjectId);
  const projectRow = document.getElementById('auto-row-project');
  const projectRowVisible = projectRow && !projectRow.hidden;
  if (projectRowVisible && _autoProjectSel) return _autoValidProjectId(_autoProjectSel.getValue() || '');
  return _autoEditingTaskId ? _autoValidProjectId(_autoEditingProjectId || '') : '';
}

function _autoRefreshProjectScopedPicker() {
  if (typeof window !== 'undefined' && typeof window.refreshAgentPickerContext === 'function') {
    Promise.resolve(window.refreshAgentPickerContext('auto-recipient-chip')).catch(() => {});
  }
}

function _autoRefreshProjectOptions(removedProjectId = '') {
  const removedPid = String(removedProjectId || '');
  if (removedPid && _autoLockedProjectId === removedPid) _autoLockedProjectId = '';
  if (_autoLockedProjectId && !_autoProjectExists(_autoLockedProjectId)) _autoLockedProjectId = '';
  if (removedPid && _autoEditingProjectId === removedPid) _autoEditingProjectId = '';
  if (_autoEditingProjectId && !_autoProjectExists(_autoEditingProjectId)) _autoEditingProjectId = '';

  const projectRow = document.getElementById('auto-row-project');
  const showProjectRow = !_autoLockedProjectId && _autoHasProjects();
  if (projectRow) projectRow.hidden = !showProjectRow;
  if (_autoProjectSel) {
    const current = _autoProjectSel.getValue() || '';
    _autoProjectSel.setOptions(_autoProjectOptions(), { value: current });
    if (!showProjectRow || !_autoValidProjectId(_autoProjectSel.getValue() || '')) {
      _autoProjectSel.setValue('');
    }
  }
  _autoRefreshProjectScopedPicker();
}

async function _autoClearRecipientIfOutsideProject() {
  const rec = _autoCurrentRecipient;
  if (!rec || rec.kind !== 'agent' || !rec.id) return;
  const pid = _autoSelectedProjectId();
  if (!pid) return;
  try {
    const res = await window.orkas.invoke('projects.bindings.list', { projectId: pid });
    const allowed = new Set((res && res.bindings && res.bindings.agents) || []);
    if (!allowed.has(rec.id)) {
      _autoCurrentRecipient = { kind: 'commander' };
      _repaintAutoRecipientChip();
    }
  } catch (_) { /* backend validation still guards save */ }
}

function _autoHourOptions() {
  const opts = [];
  for (let h = 0; h < 24; h++) opts.push({ value: String(h), label: String(h).padStart(2, '0') });
  return opts;
}

function _autoMinuteOptions() {
  const opts = [];
  for (let m = 0; m < 60; m++) opts.push({ value: String(m), label: String(m).padStart(2, '0') });
  return opts;
}

/** Local-date input value (YYYY-MM-DD) from an ISO datetime. Used by the
 *  one_time path to pre-fill the date input. */
function _autoLocalDateInputValue(iso) {
  let d;
  try { d = iso ? new Date(iso) : new Date(); }
  catch { d = new Date(); }
  if (Number.isNaN(d.getTime())) d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function _autoUseToken(ref, kind) {
  if (!ref || !ref.id || typeof _chatUseTokenFor !== 'function') return '';
  return _chatUseTokenFor({
    kind,
    id: String(ref.id),
    name: String(ref.name || ref.id),
  });
}

function _autoComposerValueForTask(task) {
  const tokens = [];
  const skill = task && task.skill && (task.skill.id || task.skill.name) ? task.skill : null;
  const connector = task && task.connector && (task.connector.id || task.connector.name) ? task.connector : null;
  const skillToken = _autoUseToken(skill, 'skill');
  const connectorToken = _autoUseToken(connector, 'connector');
  if (skillToken) tokens.push(skillToken);
  if (connectorToken) tokens.push(connectorToken);
  const content = String((task && task.content) || '');
  return tokens.length ? `${tokens.join(' ')}${content ? ` ${content}` : ''}` : content;
}

function _autoSetComposerValue(value) {
  const ta = document.getElementById('auto-task-input');
  if (!ta) return;
  ta.value = String(value || '');
  try { ta.dispatchEvent(new Event('input', { bubbles: true })); } catch (_) {}
  try {
    if (typeof syncChatRichComposerFromTextarea === 'function') syncChatRichComposerFromTextarea(ta);
  } catch (_) {}
}

function _autoReadComposerUseState() {
  const selections = (typeof getChatUseSelections === 'function')
    ? getChatUseSelections('auto')
    : [];
  const toRef = (sel) => sel ? { id: sel.id || sel.name, name: sel.name || sel.id } : null;
  const skill = selections.find((sel) => sel && sel.kind === 'skill') || null;
  const connector = selections.find((sel) => sel && sel.kind === 'connector') || null;
  return {
    skill: toRef(skill),
    connector: toRef(connector),
    selections,
  };
}

function _autoStripComposerUseTokens(value) {
  const text = String(value || '');
  if (typeof _findChatUseTokens !== 'function') return text;
  const tokens = _findChatUseTokens(text);
  if (!tokens.length) return text;
  let out = '';
  let last = 0;
  tokens.forEach((token) => {
    out += text.slice(last, token.start);
    last = token.end;
  });
  out += text.slice(last);
  return out.replace(/[ \t]{2,}/g, ' ').replace(/^[ \t]+|[ \t]+$/g, '');
}


function _mountAutoForm() {
  const panel = document.getElementById('panel-auto');
  if (!panel) return;

  // Recipient chip wiring (chip click → picker; `@` keystroke in textarea →
  // picker). The same helper used by the three sticky composers; safe to
  // call multiple times — guarded by dataset.bound flags on the DOM nodes.
  if (typeof bindRecipientAnchor === 'function') {
    bindRecipientAnchor('auto-recipient-chip', 'auto-task-input');
  }
  // Picker dispatch hook consumed by agents.js when the anchorId is
  // 'auto-recipient-chip'. Skills/connectors use the shared inline
  // chat-use token path, so they render inside the composer like Commander.
  window._autoOnRecipientPicked = (rec) => {
    _autoCurrentRecipient = rec && rec.kind ? rec : { kind: 'commander' };
    _repaintAutoRecipientChip();
  };
  window._autoGetRecipient = () => _autoCurrentRecipient || { kind: 'commander' };
  // The picker scopes against the project currently locked by the host
  // (project detail) or selected in the form's project row.
  window._autoGetProjectId = () => _autoSelectedProjectId();

  // _aiSelectMount the five dropdowns once. Frequency drives the
  // conditional sub-rows below it.
  const freqMount = document.getElementById('auto-freq-select');
  const weekdayMount = document.getElementById('auto-weekday-select');
  const monthlyDayMount = document.getElementById('auto-monthly-day-select');
  const hourMount = document.getElementById('auto-hour-select');
  const minuteMount = document.getElementById('auto-minute-select');
  if (freqMount && !freqMount.dataset.mounted) {
    freqMount.dataset.mounted = '1';
    _autoWeekdaySel = _aiSelectMount(weekdayMount, {
      options: _autoWeekdayOptions(),
      value: '1',
    });
    _autoMonthlyDaySel = _aiSelectMount(monthlyDayMount, {
      options: _autoMonthlyDayOptions(),
      value: '1',
    });
    _autoHourSel = _aiSelectMount(hourMount, {
      options: _autoHourOptions(),
      value: '9',
    });
    _autoMinuteSel = _aiSelectMount(minuteMount, {
      options: _autoMinuteOptions(),
      value: '0',
    });
    _autoFreqSel = _aiSelectMount(freqMount, {
      options: _autoFreqOptions(),
      value: 'daily',
      onChange: (v) => _autoSyncFreqRows(v),
    });
    _autoSyncFreqRows(_autoFreqSel.getValue());
    // Project picker — options refreshed on every dialog open (per
    // `openAutoTaskDialog`), row visibility decided there too.
    const projectMount = document.getElementById('auto-project-select');
    _autoProjectSel = _aiSelectMount(projectMount, {
      options: _autoProjectOptions(),
      value: '',
      onChange: () => {
        _autoTrackClick('auto_project_select', { has_project: !!(_autoProjectSel && _autoProjectSel.getValue()) });
        _autoRefreshProjectScopedPicker();
        _autoClearRecipientIfOutsideProject().catch(() => {});
      },
    });
  }


  // Initial default for the date input (one_time only).
  const dateInput = document.getElementById('auto-date-input');
  if (dateInput && !dateInput.value) {
    dateInput.value = _autoLocalDateInputValue(new Date().toISOString());
  }

  // Bind buttons.
  const ta = document.getElementById('auto-task-input');
  const submitBtn = document.getElementById('auto-submit-btn');
  if (submitBtn && submitBtn.dataset.bound !== '1') {
    submitBtn.dataset.bound = '1';
    submitBtn.addEventListener('click', () => _autoSubmitForm());
  }
  // Modal cancel — closes the dialog without saving. Reset happens on the
  // next open so the form starts fresh.
  const dialogCancelBtn = document.getElementById('auto-dialog-cancel-btn');
  if (dialogCancelBtn && dialogCancelBtn.dataset.bound !== '1') {
    dialogCancelBtn.dataset.bound = '1';
    dialogCancelBtn.addEventListener('click', () => _hideAutoDialog());
  }
  // Attach button → file picker → upload to the task's attachment dir.
  // Pre-allocate the task id on first attach so subsequent submissions
  // adopt that id (so the files don't need to be moved).
  const attachBtn = document.getElementById('auto-attach-btn');
  if (attachBtn && attachBtn.dataset.bound !== '1') {
    attachBtn.dataset.bound = '1';
    attachBtn.addEventListener('click', () => _autoPickAndUploadFiles());
  }
  _bindAutoDropAttach();

  // Keep i18n labels updating on lang switch.
  window.addEventListener('i18n-change', _autoRepaintLabels);

  _bindAutoTitleNameLimit();
  _autoFormMounted = true;
  _repaintAutoRecipientChip();
  _autoRepaintLabels();
  _paintAutoSyncNotice();
  _renderAutoAttachmentChips();
}

// ── Attachment helpers ─────────────────────────────────────────────────

async function _ensureAutoDraftId() {
  if (_autoCurrentTaskId) return _autoCurrentTaskId;
  try {
    const res = await window.orkas.invoke('autoTasks.allocateDraftId');
    if (res && typeof res.id === 'string' && res.id) {
      _autoCurrentTaskId = res.id;
    }
  } catch (err) {
    _autoLog.warn('allocate draft id failed', err);
  }
  return _autoCurrentTaskId;
}

function _autoSetAttachmentItems(items) {
  _autoCurrentAttachments = Array.isArray(items) ? items : [];
  _renderAutoAttachmentChips();
}

function _autoPushReadyAttachment(name, patch = {}) {
  if (!name) return;
  const next = _autoCurrentAttachments.filter((a) => a && a.name !== name);
  next.push({
    name,
    displayName: patch.displayName || name,
    kind: _autoAttachKindForName(name, patch.kind || ''),
    bytes: patch.bytes || 0,
    status: 'ready',
  });
  _autoSetAttachmentItems(next);
}

function _autoReplaceAttachmentByTempId(tempId, patch) {
  const items = _autoCurrentAttachments.slice();
  const idx = items.findIndex((it) => it && it.tempId === tempId);
  if (idx < 0) return;
  if (patch === null) {
    items.splice(idx, 1);
  } else {
    const next = { ...items[idx], ...patch };
    const dupIdx = next.name
      ? items.findIndex((it, i) => i !== idx && it.name === next.name && it.status !== 'uploading')
      : -1;
    if (dupIdx >= 0) items.splice(idx, 1);
    else items[idx] = next;
  }
  _autoSetAttachmentItems(items);
}

async function _autoAlertAttachmentFailures(rejected) {
  if (!rejected || !rejected.length) return;
  await uiAlert(t('chat.attach_rejected_prefix', { list: rejected.join('\n') }));
}

async function _autoPrepareUploadFiles(fileList) {
  const files = Array.from(fileList || []).filter(Boolean);
  const rejected = [];
  const prepared = [];
  for (const file of files) {
    const name = file && file.name ? file.name : '';
    const ext = _autoAttachExtOf(name);
    if (!AUTO_ATTACH_ACCEPT.includes(ext)) {
      rejected.push(t('chat.attach_unsupported', { name: name || 'file' }));
      continue;
    }
    let buf;
    try {
      buf = await file.arrayBuffer();
    } catch (err) {
      rejected.push(t('chat.attach_upload_fail', {
        name,
        reason: (err && err.message) || t('chat.attach_upload_generic_fail'),
      }));
      continue;
    }
    prepared.push({ file, ext, buf });
  }
  return { prepared, rejected };
}

async function _autoUploadFiles(files, source = 'drop') {
  const list = Array.from(files || []);
  if (!list.length) return;
  const taskId = await _ensureAutoDraftId();
  if (!taskId) {
    await uiAlert(t('auto.save_failed', { reason: 'no_draft_id' }));
    return;
  }
  const payload = _autoAttachmentPayload(list, source);
  _autoTrackClick('auto_attachment_upload', payload);
  const { prepared, rejected } = await _autoPrepareUploadFiles(list);
  if (!prepared.length) {
    if (rejected.length) await _autoAlertAttachmentFailures(rejected);
    _autoTrackEvent('auto_attachment_upload_result', {
      ...payload,
      result: rejected.length ? 'failure' : 'skipped',
      uploaded_count: 0,
      failed_count: rejected.length,
    });
    return;
  }

  const placeholders = [];
  const current = _autoCurrentAttachments.slice();
  for (const item of prepared) {
    const { file, ext } = item;
    const tempId = _autoAttachTempId();
    const displayName = file.name;
    const kind = _autoAttachKindFromExt(ext);
    current.push({
      tempId,
      name: displayName,
      displayName,
      kind,
      bytes: file.size || 0,
      status: 'uploading',
    });
    placeholders.push({ ...item, tempId, displayName, kind });
  }
  _autoSetAttachmentItems(current);

  let uploadFailed = 0;
  await Promise.all(placeholders.map(async (ph) => {
    try {
      const dataBase64 = _arrayBufferToBase64(ph.buf);
      const res = await window.orkas.invoke('autoTasks.attachments.upload', {
        taskId,
        name: ph.file.name,
        dataBase64,
      });
      if (res && res.name) {
        _autoReplaceAttachmentByTempId(ph.tempId, {
          name: res.name,
          displayName: ph.displayName,
          kind: _autoAttachKindForName(res.name, ph.kind),
          bytes: ph.file.size || 0,
          status: 'ready',
        });
      } else {
        _autoReplaceAttachmentByTempId(ph.tempId, null);
        uploadFailed += 1;
        rejected.push(t('chat.attach_upload_fail', {
          name: ph.file.name,
          reason: t('chat.attach_upload_generic_fail'),
        }));
      }
    } catch (err) {
      _autoReplaceAttachmentByTempId(ph.tempId, null);
      uploadFailed += 1;
      _autoLog.warn('upload failed', err);
      rejected.push(t('chat.attach_upload_fail', {
        name: ph.file.name,
        reason: (err && err.message) || t('chat.attach_upload_generic_fail'),
      }));
    }
  }));
  const uploadedCount = Math.max(0, placeholders.length - uploadFailed);
  const failedCount = rejected.length;
  _autoTrackEvent('auto_attachment_upload_result', {
    ...payload,
    result: failedCount ? (uploadedCount ? 'partial_failure' : 'failure') : 'success',
    uploaded_count: uploadedCount,
    failed_count: failedCount,
  });
  if (rejected.length) await _autoAlertAttachmentFailures(rejected);
}

function _bindAutoDropAttach() {
  const input = document.getElementById('auto-task-input');
  const area = input ? input.closest('.new-chat-input-area') : null;
  if (!area || area.dataset.autoDropBound === '1') return;
  const isAttachDrag = (e) => {
    const types = e.dataTransfer && e.dataTransfer.types;
    if (!types) return false;
    for (let i = 0; i < types.length; i++) {
      if (types[i] === 'Files') return true;
      if (typeof ORKAS_FILE_DRAG_MIME !== 'undefined' && types[i] === ORKAS_FILE_DRAG_MIME) return true;
    }
    return false;
  };
  const allow = (e) => {
    if (!isAttachDrag(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    area.classList.add('drag-over');
  };
  area.addEventListener('dragover', allow);
  area.addEventListener('dragenter', allow);
  area.addEventListener('dragleave', () => area.classList.remove('drag-over'));
  area.addEventListener('drop', (e) => {
    if (!isAttachDrag(e)) return;
    e.preventDefault();
    area.classList.remove('drag-over');
    const internalFiles = (typeof _chatAttachInternalDragItems === 'function')
      ? _chatAttachInternalDragItems(e.dataTransfer)
      : [];
    if (internalFiles.length) {
      _autoImportPaths(internalFiles, 'internal_drop');
      return;
    }
    _autoUploadFiles(e.dataTransfer.files, 'drop');
  });
  area.dataset.autoDropBound = '1';
}

async function _autoImportPaths(entries, source = 'internal_drop') {
  const files = Array.isArray(entries) ? entries.filter((it) => it && it.path) : [];
  if (!files.length) return;
  const taskId = await _ensureAutoDraftId();
  if (!taskId) {
    await uiAlert(t('auto.save_failed', { reason: 'no_draft_id' }));
    return;
  }
  const payload = _autoAttachmentPayload(files, source);
  _autoTrackClick('auto_attachment_upload', payload);

  const rejected = [];
  const placeholders = [];
  const current = _autoCurrentAttachments.slice();
  for (const item of files) {
    const displayName = item.name || _autoAttachBaseName(item.path);
    const ext = _autoAttachExtOf(displayName);
    if (!AUTO_ATTACH_ACCEPT.includes(ext)) {
      rejected.push(t('chat.attach_unsupported', { name: displayName || item.path }));
      continue;
    }
    const tempId = _autoAttachTempId();
    current.push({
      tempId,
      name: displayName,
      displayName,
      kind: _autoAttachKindFromExt(ext),
      bytes: 0,
      status: 'uploading',
    });
    placeholders.push({ tempId, path: item.path, name: displayName });
  }
  _autoSetAttachmentItems(current);

  let uploadFailed = 0;
  await Promise.all(placeholders.map(async (ph) => {
    try {
      const data = await window.orkas.invoke('autoTasks.attachments.import', {
        taskId,
        path: ph.path,
        name: ph.name,
        projectId: _autoSelectedProjectId(),
      });
      const name = data && data.name;
      if (!name) throw new Error((data && data.error) || 'attach_failed');
      _autoReplaceAttachmentByTempId(ph.tempId, {
        name,
        displayName: ph.name,
        kind: _autoAttachKindForName(name),
        bytes: 0,
        status: 'ready',
      });
    } catch (err) {
      _autoReplaceAttachmentByTempId(ph.tempId, null);
      uploadFailed += 1;
      rejected.push(t('chat.attach_upload_fail', {
        name: ph.name,
        reason: (err && err.message) || t('chat.attach_upload_generic_fail'),
      }));
    }
  }));
  const uploadedCount = Math.max(0, placeholders.length - uploadFailed);
  _autoTrackEvent('auto_attachment_upload_result', {
    ...payload,
    result: rejected.length ? (uploadedCount ? 'partial_failure' : 'failure') : 'success',
    uploaded_count: uploadedCount,
    failed_count: rejected.length,
  });
  if (rejected.length) await _autoAlertAttachmentFailures(rejected);
}

async function _autoAttachLibraryFile(ref) {
  const taskId = await _ensureAutoDraftId();
  if (!taskId) {
    throw new Error('no_draft_id');
  }
  const scope = String(ref && ref.scope || 'global');
  const rel = String(ref && ref.rel || '');
  const projectId = _autoValidProjectId(ref && ref.projectId || '');
  if (!rel) return;
  if (scope === 'project' && !projectId) throw new Error('project_not_found');
  const payload = {
    taskId,
    ...(scope === 'project'
      ? { projectId, name: rel }
      : { relPath: rel }),
  };
  const channel = scope === 'project'
    ? 'autoTasks.attachments.attachProjectFile'
    : 'autoTasks.attachments.attachContext';
  _autoTrackClick('auto_library_attach', {
    scope,
    mode: _autoEditingTaskId ? 'edit' : 'create',
    has_project: !!projectId,
  });
  const displayName = _autoAttachBaseName(rel);
  const tempId = _autoAttachTempId();
  _autoSetAttachmentItems([
    ..._autoCurrentAttachments,
    {
      tempId,
      name: displayName,
      displayName,
      kind: _autoAttachKindForName(displayName),
      bytes: 0,
      status: 'uploading',
    },
  ]);
  try {
    const data = await window.orkas.invoke(channel, payload);
    const name = data && data.name;
    if (!name) throw new Error((data && data.error) || 'attach_failed');
    _autoReplaceAttachmentByTempId(tempId, {
      name,
      displayName,
      kind: _autoAttachKindForName(name),
      bytes: 0,
      status: 'ready',
    });
  } catch (err) {
    _autoReplaceAttachmentByTempId(tempId, null);
    _autoLog.warn('library attach failed', err);
    throw err;
  }
}

async function _autoPickAndUploadFiles() {
  const taskId = await _ensureAutoDraftId();
  if (!taskId) {
    await uiAlert(t('auto.save_failed', { reason: 'no_draft_id' }));
    return;
  }
  const payload = { source: 'picker', mode: _autoEditingTaskId ? 'edit' : 'create' };
  _autoTrackClick('auto_attachment_upload', payload);
  let data;
  try {
    data = await window.orkas.invoke('autoTasks.attachments.pickAndUpload', { taskId });
  } catch (err) {
    _autoLog.warn('native picker upload failed', err);
    _autoTrackEvent('auto_attachment_upload_result', {
      ...payload,
      result: 'failure',
      uploaded_count: 0,
      failed_count: 1,
    });
    await uiAlert(t('chat.attach_upload_fail', {
      name: '',
      reason: (err && err.message) || t('chat.attach_upload_generic_fail'),
    }));
    return;
  }
  const names = Array.isArray(data && data.items) ? data.items : [];
  for (const name of names) {
    _autoPushReadyAttachment(name, { displayName: name });
  }
  const failed = Array.isArray(data && data.failed) ? data.failed : [];
  _autoTrackEvent('auto_attachment_upload_result', {
    ...payload,
    result: failed.length ? (names.length ? 'partial_failure' : 'failure') : 'success',
    uploaded_count: names.length,
    failed_count: failed.length,
    file_count: names.length + failed.length,
  });
  if (failed.length) {
    await _autoAlertAttachmentFailures(failed.map((x) => t('chat.attach_upload_fail', {
      name: x.name || '',
      reason: x.error || t('chat.attach_upload_generic_fail'),
    })));
  }
}

function _arrayBufferToBase64(buf) {
  // Streamed conversion to avoid call-stack blow-up on big files.
  const bytes = new Uint8Array(buf);
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

function _renderAutoAttachmentChips() {
  const wrap = document.getElementById('auto-task-attachments');
  if (!wrap) return;
  if (!_autoCurrentAttachments.length) {
    wrap.innerHTML = '';
    wrap.style.display = 'none';
    return;
  }
  wrap.style.display = '';
  wrap.innerHTML = _autoCurrentAttachments.map((a, idx) => {
    const displayName = _autoAttachDisplayName(a);
    const kind = _autoAttachKindForName(displayName, a && a.kind);
    const icon = (typeof _chatFileIconHtml === 'function') ? _chatFileIconHtml(displayName, kind) : '';
    const busy = a && a.status === 'uploading';
    const label = escapeHtml(displayName);
    const klass = `chat-attach-chip${busy ? ' is-uploading' : ''}`;
    const spinner = busy ? `<span class="chat-attach-spinner" aria-label="${escapeHtml(t('chat.attach_uploading'))}"></span>` : '';
    const removeBtn = busy
      ? ''
      : `<span class="chat-attach-remove" data-idx="${idx}" title="${escapeHtml(t('chat.attach_remove_title'))}">×</span>`;
    return `
    <div class="${klass}" data-idx="${idx}" data-name="${escapeHtml(a.name || '')}" title="${label}">
      <span class="chat-attach-icon">${icon}</span>
      <span class="chat-attach-label">${label}</span>
      ${spinner}
      ${removeBtn}
    </div>`;
  }).join('');
  for (const chip of wrap.querySelectorAll('.chat-attach-chip')) {
    const remove = chip.querySelector('.chat-attach-remove');
    if (!remove) continue;
    remove.addEventListener('click', async () => {
      const idx = Number(remove.dataset.idx);
      const item = _autoCurrentAttachments[idx];
      const name = item && item.name;
      if (!name || !_autoCurrentTaskId) return;
      try {
        await window.orkas.invoke('autoTasks.attachments.delete', {
          taskId: _autoCurrentTaskId, name,
        });
      } catch (err) {
        _autoLog.warn('delete attachment failed', err);
      }
      const next = _autoCurrentAttachments.slice();
      next.splice(idx, 1);
      _autoSetAttachmentItems(next);
    });
  }
}

function _autoSyncFreqRows(type) {
  const dateRow = document.getElementById('auto-row-date');
  const weekdayRow = document.getElementById('auto-row-weekday');
  const monthlyDayRow = document.getElementById('auto-row-monthly-day');
  const timeRow = document.getElementById('auto-row-time');
  if (dateRow) dateRow.hidden = type !== 'one_time';
  if (weekdayRow) weekdayRow.hidden = type !== 'weekly';
  if (monthlyDayRow) monthlyDayRow.hidden = type !== 'monthly';
  // Time row visible for all 4 frequencies (one_time pairs Date + HH:MM).
  if (timeRow) timeRow.hidden = false;
}

function _repaintAutoRecipientChip() {
  const nameEl = document.getElementById('auto-recipient-name');
  if (!nameEl) return;
  const rec = _autoCurrentRecipient;
  if (!rec || rec.kind === 'commander' || !rec.id) {
    nameEl.textContent = t('chat.recipient_commander');
    nameEl.setAttribute('data-i18n', 'chat.recipient_commander');
  } else {
    nameEl.removeAttribute('data-i18n');
    nameEl.textContent = rec.name || rec.id;
  }
}

function _autoRepaintLabels() {
  const titleEl = document.getElementById('auto-task-dialog-title');
  if (titleEl) {
    titleEl.textContent = t(_autoEditingTaskId
      ? 'auto.edit_section_title'
      : 'auto.create_section_title');
  }
  const submitBtn = document.getElementById('auto-submit-btn');
  if (submitBtn) {
    submitBtn.textContent = t(_autoEditingTaskId ? 'auto.save_btn' : 'auto.create_btn');
  }
  const cancelBtn = document.getElementById('auto-dialog-cancel-btn');
  if (cancelBtn) cancelBtn.textContent = t('auto.cancel_btn');
  _paintAutoSyncNotice();
}

function _autoResetForm() {
  _autoEditingTaskId = null;
  _autoEditingProjectId = '';
  _autoCurrentRecipient = { kind: 'commander' };
  _autoCurrentTaskId = '';
  _autoCurrentAttachments = [];
  _autoSetComposerValue('');
  const titleInput = document.getElementById('auto-title-input');
  if (titleInput) {
    titleInput.value = '';
    _bindAutoTitleNameLimit();
  }
  const enabledInput = document.getElementById('auto-enabled-input');
  if (enabledInput) enabledInput.checked = true;
  const dateInput = document.getElementById('auto-date-input');
  if (dateInput) dateInput.value = _autoLocalDateInputValue(new Date().toISOString());
  if (_autoFreqSel) _autoFreqSel.setValue('daily');
  if (_autoWeekdaySel) _autoWeekdaySel.setValue('1');
  if (_autoMonthlyDaySel) _autoMonthlyDaySel.setValue('1');
  if (_autoHourSel) _autoHourSel.setValue('9');
  if (_autoMinuteSel) _autoMinuteSel.setValue('0');
  _autoSyncFreqRows('daily');
  _repaintAutoRecipientChip();
  _autoRepaintLabels();
  _renderAutoAttachmentChips();
}

/** Open the create / edit modal.
 *  opts.task?      — when provided, dialog opens in edit mode with the
 *                    task pre-filled.
 *  opts.projectId? — pre-bind the task to this project AND hide the project
 *                    picker (project-detail entry mode). For the global tab,
 *                    omit this — the user picks the project inside the modal.
 *  opts.onSaved?   — callback (task) => void, fired after a successful save.
 *                    Project-detail uses this to refresh its list. */
function openAutoTaskDialog(opts = {}) {
  if (!_autoFormMounted) _mountAutoForm();
  _refreshAutoSyncNotice().catch(() => {});
  const task = opts.task || null;
  _autoLockedProjectId = _autoValidProjectId((opts.projectId && typeof opts.projectId === 'string') ? opts.projectId : '');
  _autoOnSaved = (typeof opts.onSaved === 'function') ? opts.onSaved : null;

  // Project picker visibility:
  //   - hidden when the host already pinned a project (project-detail entry)
  //   - hidden when the user has zero projects (default = none is automatic)
  //   - otherwise visible, options refreshed from `_projectsCache` so newly
  //     created projects show up without a reload
  const projectRow = document.getElementById('auto-row-project');
  const showProjectRow = !_autoLockedProjectId && _autoHasProjects();
  if (projectRow) projectRow.hidden = !showProjectRow;
  if (showProjectRow && _autoProjectSel) {
    _autoProjectSel.setOptions(_autoProjectOptions());
    // Seed: edit → task's current project_id; create → empty (none).
    _autoProjectSel.setValue(task && task.project_id ? _autoValidProjectId(task.project_id) : '');
  }

  if (task) _autoFillForm(task);
  else _autoResetForm();
  _autoRefreshProjectOptions();
  _autoRepaintLabels();
  _showAutoDialog();
}

function _showAutoDialog() {
  const overlay = document.getElementById('auto-task-dialog-overlay');
  if (!overlay) return;
  _paintAutoSyncNotice();
  overlay.style.display = 'flex';
  overlay.classList.add('open');
  const ta = document.getElementById('auto-task-input');
  if (ta) setTimeout(() => ta.focus(), 50);
}

function _hideAutoDialog() {
  const overlay = document.getElementById('auto-task-dialog-overlay');
  if (overlay) {
    overlay.style.display = 'none';
    overlay.classList.remove('open');
  }
  _autoLockedProjectId = '';
  _autoOnSaved = null;
}

/** Hydrate the form fields from an existing task — used by edit mode. */
function _autoFillForm(task) {
  _autoEditingTaskId = task.id;
  _autoEditingProjectId = task.project_id || '';
  _autoCurrentTaskId = task.id;
  _autoCurrentAttachments = (Array.isArray(task.attachments) ? task.attachments : [])
    .map((name) => ({
      name,
      displayName: name,
      kind: _autoAttachKindForName(name),
      status: 'ready',
    }));
  _autoCurrentRecipient = (task.recipient && task.recipient.kind)
    ? task.recipient
    : { kind: 'commander' };
  _autoSetComposerValue(_autoComposerValueForTask(task));
  const titleInput = document.getElementById('auto-title-input');
  if (titleInput) {
    titleInput.value = task.title || '';
    _bindAutoTitleNameLimit();
    if (typeof window.enforceNameLimitOnControl === 'function') window.enforceNameLimitOnControl(titleInput);
  }
  const enabledInput = document.getElementById('auto-enabled-input');
  if (enabledInput) enabledInput.checked = task.enabled !== false;

  const sched = task.schedule || { type: 'daily', hour: 9, minute: 0 };
  if (_autoFreqSel) _autoFreqSel.setValue(sched.type || 'daily');
  _autoSyncFreqRows(sched.type || 'daily');

  let hour = 9, minute = 0;
  if (sched.type === 'one_time') {
    let d;
    try { d = new Date(sched.at); } catch { d = new Date(); }
    if (!Number.isNaN(d?.getTime?.())) {
      hour = d.getHours();
      minute = d.getMinutes();
    }
    const dateInput = document.getElementById('auto-date-input');
    if (dateInput) dateInput.value = _autoLocalDateInputValue(sched.at);
  } else if (Number.isInteger(sched.hour) && Number.isInteger(sched.minute)) {
    hour = sched.hour;
    minute = sched.minute;
  }
  if (_autoHourSel) _autoHourSel.setValue(String(hour));
  if (_autoMinuteSel) _autoMinuteSel.setValue(String(minute));
  if (sched.type === 'weekly' && _autoWeekdaySel) _autoWeekdaySel.setValue(String(sched.weekday));
  if (sched.type === 'monthly' && _autoMonthlyDaySel) _autoMonthlyDaySel.setValue(String(sched.day));
  _repaintAutoRecipientChip();
  _renderAutoAttachmentChips();
}

async function _autoSubmitForm() {
  const submitBtn = document.getElementById('auto-submit-btn');
  const ta = document.getElementById('auto-task-input');
  const titleInput = document.getElementById('auto-title-input');
  const enabledInput = document.getElementById('auto-enabled-input');
  const dateInput = document.getElementById('auto-date-input');
  if (!ta || !submitBtn || !_autoFreqSel || !_autoHourSel || !_autoMinuteSel) return;

  const rawContent = (ta.value || '').trim();
  const content = _autoStripComposerUseTokens(rawContent).trim();
  if (!content) { await uiAlert(t('auto.invalid_content')); return; }
  const useState = _autoReadComposerUseState();
  const skillField = useState.skill;
  const connectorField = useState.connector;

  // HH + MM dropdowns shared across all schedule types.
  const hour = parseInt(_autoHourSel.getValue() || '0', 10);
  const minute = parseInt(_autoMinuteSel.getValue() || '0', 10);
  if (!(hour >= 0 && hour <= 23) || !(minute >= 0 && minute <= 59)) {
    await uiAlert(t('auto.invalid_schedule')); return;
  }

  const type = _autoFreqSel.getValue();
  let schedule;
  if (type === 'one_time') {
    const raw = dateInput ? dateInput.value : '';
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(raw).trim());
    if (!m) { await uiAlert(t('auto.invalid_schedule')); return; }
    // Build the target in local time so the date/hour/minute the user picked
    // matches the wall-clock they expect, then store as ISO (UTC).
    const target = new Date(
      parseInt(m[1], 10),
      parseInt(m[2], 10) - 1,
      parseInt(m[3], 10),
      hour,
      minute,
      0,
      0,
    );
    if (Number.isNaN(target.getTime())) { await uiAlert(t('auto.invalid_schedule')); return; }
    schedule = { type: 'one_time', at: target.toISOString() };
  } else if (type === 'daily') {
    schedule = { type: 'daily', hour, minute };
  } else if (type === 'weekly') {
    const wd = _autoWeekdaySel ? parseInt(_autoWeekdaySel.getValue() || '1', 10) : 1;
    schedule = { type: 'weekly', weekday: Number.isInteger(wd) ? wd : 1, hour, minute };
  } else if (type === 'monthly') {
    const day = _autoMonthlyDaySel ? parseInt(_autoMonthlyDaySel.getValue() || '1', 10) : 1;
    schedule = { type: 'monthly', day: Number.isInteger(day) && day >= 1 ? day : 1, hour, minute };
  } else {
    await uiAlert(t('auto.invalid_schedule')); return;
  }

  const projectId = _autoSelectedProjectId();
  const isUpdate = !!_autoEditingTaskId;
  if (_autoCurrentAttachments.some((a) => a && a.status === 'uploading')) {
    await uiAlert(t('chat.attach_still_uploading'));
    return;
  }
  const readyAttachments = _autoCurrentAttachments
    .filter((a) => a && a.name && a.status !== 'error' && a.status !== 'uploading');
  const startedAt = performance.now();
  _autoTrackClick(isUpdate ? 'auto_task_update_submit' : 'auto_task_create_submit', {
    schedule_type: type,
    recipient_type: _autoCurrentRecipient.kind || 'commander',
    has_skill: !!skillField,
    has_connector: !!connectorField,
    has_project: !!projectId,
    attachment_count: readyAttachments.length,
    content_length: content.length,
  });

  submitBtn.disabled = true;
  try {
    const attachmentNames = readyAttachments.map((a) => a.name);
    const recipientField = _autoCurrentRecipient.kind === 'agent'
      ? {
          kind: 'agent',
          id: _autoCurrentRecipient.id,
          name: _autoCurrentRecipient.name || _autoCurrentRecipient.id,
        }
      : { kind: 'commander' };
    const payload = {
      content,
      schedule,
      title: titleInput ? _autoNormaliseTitle(titleInput.value) : '',
      enabled: enabledInput ? !!enabledInput.checked : true,
      recipient: recipientField,
      // Send `null` to clear an existing chip on update; omit on create.
      ...(skillField ? { skill: skillField } : (_autoEditingTaskId ? { skill: null } : {})),
      ...(connectorField ? { connector: connectorField } : (_autoEditingTaskId ? { connector: null } : {})),
      ...(projectId ? { project_id: projectId } : (_autoEditingTaskId ? { project_id: null } : {})),
      ...(attachmentNames.length ? { attachments: attachmentNames } : (_autoEditingTaskId ? { attachments: [] } : {})),
      // Carry the pre-allocated draft id (or current task id when editing) so
      // the backend adopts it — the already-uploaded files live under
      // auto_attachments/<this_id>/ and we don't want to relocate them.
      ...(!_autoEditingTaskId && _autoCurrentTaskId ? { id: _autoCurrentTaskId } : {}),
    };
    let res;
    if (_autoEditingTaskId) {
      res = await window.orkas.invoke('autoTasks.update', {
        taskId: _autoEditingTaskId,
        updates: payload,
      });
    } else {
      res = await window.orkas.invoke('autoTasks.create', payload);
    }
    if (!res || !res.task) {
      _autoTrackEvent(isUpdate ? 'auto_task_update_result' : 'auto_task_create_result', {
        result: 'failure',
        schedule_type: type,
        duration_ms: Math.round(performance.now() - startedAt),
      });
      _autoTrackError(isUpdate ? 'auto_task_update' : 'auto_task_create', {
        error_type: 'api',
      });
      await uiAlert(t('auto.save_failed', { reason: (res && res.error) || '' }));
      return;
    }
    const savedTask = res.task;
    _autoTrackEvent(isUpdate ? 'auto_task_update_result' : 'auto_task_create_result', {
      result: 'success',
      task_id: savedTask.id || '',
      schedule_type: type,
      recipient_type: recipientField.kind || 'commander',
      has_skill: !!skillField,
      has_connector: !!connectorField,
      has_project: !!projectId,
      attachment_count: attachmentNames.length,
      content_length: content.length,
      duration_ms: Math.round(performance.now() - startedAt),
    });
    const savedCb = _autoOnSaved;
    _hideAutoDialog();
    _autoResetForm();
    await loadAutoList(true);
    // Fire the project-detail refresh hook + the caller's onSaved callback.
    if (typeof _projectDetailPid !== 'undefined' && _projectDetailPid && projectId
        && _projectDetailPid === projectId
        && typeof loadProjectAutoList === 'function') {
      loadProjectAutoList(_projectDetailPid).catch(() => {});
    }
    if (typeof savedCb === 'function') {
      try { savedCb(savedTask); } catch (_) { /* ignore */ }
    }
  } catch (err) {
    _autoTrackEvent(isUpdate ? 'auto_task_update_result' : 'auto_task_create_result', {
      result: 'failure',
      schedule_type: type,
      duration_ms: Math.round(performance.now() - startedAt),
    });
    _autoTrackError(isUpdate ? 'auto_task_update' : 'auto_task_create', {
      error_type: 'ipc',
    });
    await uiAlert(t('auto.save_failed', { reason: (err && err.message) || err }));
  } finally {
    submitBtn.disabled = false;
  }
}

// ─── Exports + boot wiring ───────────────────────────────────────────────

if (typeof window !== 'undefined') {
  window.loadAutoList = loadAutoList;
  window.loadProjectAutoList = loadProjectAutoList;
  window.openAutoTaskDialog = openAutoTaskDialog;
  window.refreshAutoProjectOptions = _autoRefreshProjectOptions;
  window._autoUploadFilesFromComposer = _autoUploadFiles;
  window._autoAttachLibraryFile = _autoAttachLibraryFile;
  document.addEventListener('DOMContentLoaded', () => {
    const addBtn = document.getElementById('auto-add-btn');
    if (addBtn && addBtn.dataset.bound !== '1') {
      addBtn.dataset.bound = '1';
      addBtn.addEventListener('click', () => openAutoTaskDialog({}));
    }
  });
}

// ─── Boot-time fire subscription ─────────────────────────────────────────
// An auto fire creates the conv in main, so the renderer's local
// `conversations` array doesn't know about it. Subscribe once on boot to
// the long-lived `autoTasks.events` stream; on each `conv_created`
// event, reload the conversation list.

function startAutoEventsSubscription() {
  if (_autoEventsHandle) return;
  if (!window.orkas || typeof window.orkas.stream !== 'function') return;
  try {
    _autoEventsHandle = window.orkas.stream('autoTasks.events', {}, (ev) => {
      const inner = ev && ev.event;
      if (!inner) return;
      if (inner.type === 'fire_failed') {
        const taskId = inner.taskId || inner.task_id || '';
        const cid = inner.cid || inner.conversation_id || '';
        const errorCode = inner.error_code || 'unknown';
        _autoTrackEvent('auto_task_fire_result', {
          result: 'failure',
          task_id: taskId,
          conversation_id: cid,
          duration_ms: Number(inner.duration_ms) || 0,
          error_code: errorCode,
        });
        _autoTrackError('auto_task_fire', {
          task_id: taskId,
          conversation_id: cid,
          error_type: 'runtime',
          error_code: errorCode,
          error_message: errorCode,
        });
      } else if (inner.type === 'conv_created') {
        _autoTrackEvent('auto_task_fire_result', {
          result: 'success',
          task_id: inner.taskId || inner.task_id || '',
          conversation_id: inner.cid || inner.conversation_id || '',
          duration_ms: Number(inner.duration_ms) || 0,
        });
        if (typeof loadConversations === 'function') {
          loadConversations().catch((err) => _autoLog.warn('reload after fire failed', err));
        }
      } else {
        return;
      }
      // Refresh task last_run if the auto tab has been opened.
      if (_autoLoadedOnce) loadAutoList(true).catch(() => {});
    });
    _autoEventsHandle.promise.catch(() => { /* ignore */ });
  } catch (err) {
    _autoLog.warn('subscribe autoTasks.events failed', err);
  }
}

if (typeof window !== 'undefined') {
  window.startAutoEventsSubscription = startAutoEventsSubscription;
}

if (typeof module !== 'undefined' && typeof module.exports === 'object') {
  module.exports = { _autoDisplayDeviceName };
}
