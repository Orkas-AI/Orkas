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

let _autoTasks = [];           // last fetched global list
let _autoLoadedOnce = false;
let _autoEventsHandle = null;
let _autoFormMounted = false;  // _aiSelectMount only once
let _autoEditingTaskId = null; // null = create mode, taskId = edit mode
// Current device fingerprint — fetched lazily on first row render. Used to
// decide which device chip to show ("本机" vs. the task's stored hostname).
let _autoCurrentDevice = null; // { id, name } | null
async function _ensureAutoCurrentDevice() {
  if (_autoCurrentDevice) return _autoCurrentDevice;
  try {
    const res = await window.orkas.invoke('autoTasks.currentDevice');
    _autoCurrentDevice = (res && res.device) ? res.device : { id: '', name: '' };
  } catch (_) { _autoCurrentDevice = { id: '', name: '' }; }
  return _autoCurrentDevice;
}
let _autoCurrentRecipient = { kind: 'commander' };
// Skill / connector pinned to this draft. Mirrors the commander composer's
// single-chip slot: setting one clears the other (matches the bus-side
// invariant that a single message can't pin both). Either may be null/empty.
let _autoCurrentSkill = null;       // { id, name } | null
let _autoCurrentConnector = null;   // { id, name } | null
// Pre-allocated id used for attachments uploaded BEFORE the task record
// exists. On submit, `autoTasks.create` adopts this id so the
// already-uploaded files live under the right per-task dir from the start.
// Allocated lazily on first attach + on edit-mode entry (= task.id).
let _autoCurrentTaskId = '';
let _autoCurrentAttachments = []; // [{ name }]

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
  if (_autoLoadedOnce && !force) return;
  const listEl = document.getElementById('auto-list');
  const emptyEl = document.getElementById('auto-empty');
  if (!listEl) return;
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

function _autoHasProjects() {
  try {
    return typeof _projectsCache !== 'undefined'
      && Array.isArray(_projectsCache)
      && _projectsCache.some((p) => p && p.project_id);
  } catch (_) { return false; }
}

function _autoSelectedProjectId() {
  if (_autoLockedProjectId) return _autoLockedProjectId;
  const projectRow = document.getElementById('auto-row-project');
  const projectRowVisible = projectRow && !projectRow.hidden;
  if (projectRowVisible && _autoProjectSel) return _autoProjectSel.getValue() || '';
  return _autoEditingTaskId ? (_autoEditingProjectId || '') : '';
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


function _mountAutoForm() {
  const panel = document.getElementById('panel-auto');
  if (!panel) return;

  // Recipient chip wiring (chip click → picker; `@` keystroke in textarea →
  // picker). The same helper used by the three sticky composers; safe to
  // call multiple times — guarded by dataset.bound flags on the DOM nodes.
  if (typeof bindRecipientAnchor === 'function') {
    bindRecipientAnchor('auto-recipient-chip', 'auto-task-input');
  }
  // Picker dispatch hooks consumed by agents.js when the anchorId is
  // 'auto-recipient-chip'. Three independent slots:
  //   - recipient: agent OR commander ("给: …" chip on the left)
  //   - skill: first-class chip field (`.chat-skill-chip` widget)
  //   - connector: first-class chip field (same widget; one-at-a-time)
  // Skill + connector share the chip slot, matching the commander
  // composer's single-`_chatUse` invariant — picking one clears the other.
  const recipientAllowsUse = () => !_autoCurrentRecipient || _autoCurrentRecipient.kind !== 'agent';
  window._autoOnRecipientPicked = (rec) => {
    _autoCurrentRecipient = rec && rec.kind ? rec : { kind: 'commander' };
    if (!recipientAllowsUse()) {
      _autoCurrentSkill = null;
      _autoCurrentConnector = null;
      _repaintAutoUseChip();
    }
    _repaintAutoRecipientChip();
  };
  window._autoOnSkillPicked = (ref) => {
    if (!recipientAllowsUse()) return;
    _autoCurrentSkill = (ref && ref.id) ? { id: String(ref.id), name: String(ref.name || ref.id) } : null;
    _autoCurrentConnector = null;
    _repaintAutoUseChip();
  };
  window._autoOnConnectorPicked = (ref) => {
    if (!recipientAllowsUse()) return;
    _autoCurrentConnector = (ref && ref.id) ? { id: String(ref.id), name: String(ref.name || ref.id) } : null;
    _autoCurrentSkill = null;
    _repaintAutoUseChip();
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
      onChange: () => { _autoClearRecipientIfOutsideProject().catch(() => {}); },
    });
  }


  // Initial default for the date input (one_time only).
  const dateInput = document.getElementById('auto-date-input');
  if (dateInput && !dateInput.value) {
    dateInput.value = _autoLocalDateInputValue(new Date().toISOString());
  }

  // Bind buttons.
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

  // Voice-to-text mic. The button is gated by the (stripped in OrkasOpen)
  // voice-input module; `attach` is a no-op when window.VoiceInput is absent.
  const micBtn = document.getElementById('auto-mic-btn');
  const ta = document.getElementById('auto-task-input');
  if (micBtn && ta && typeof window.VoiceInput === 'object' && typeof window.VoiceInput.attach === 'function') {
    window.VoiceInput.attach(micBtn, ta);
  } else if (micBtn) {
    // OrkasOpen strip: hide the button rather than leave a non-functional
    // affordance on the bar.
    micBtn.style.display = 'none';
  }

  // Keep i18n labels updating on lang switch.
  window.addEventListener('i18n-change', _autoRepaintLabels);

  _bindAutoTitleNameLimit();
  _autoFormMounted = true;
  _repaintAutoRecipientChip();
  _autoRepaintLabels();
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

async function _autoUploadFiles(files) {
  const taskId = await _ensureAutoDraftId();
  if (!taskId) {
    await uiAlert(t('auto.save_failed', { reason: 'no_draft_id' }));
    return;
  }
  for (const file of files) {
    try {
      const buf = await file.arrayBuffer();
      const dataBase64 = _arrayBufferToBase64(buf);
      const res = await window.orkas.invoke('autoTasks.attachments.upload', {
        taskId,
        name: file.name,
        dataBase64,
      });
      if (res && res.name) {
        // Dedupe — last upload for a given name wins (overwrite on the disk
        // side too since uploadAttachment writes the file).
        _autoCurrentAttachments = _autoCurrentAttachments.filter((a) => a.name !== res.name);
        _autoCurrentAttachments.push({ name: res.name });
      }
    } catch (err) {
      _autoLog.warn('upload failed', err);
      await uiAlert(t('auto.save_failed', { reason: (err && err.message) || err }));
    }
  }
  _renderAutoAttachmentChips();
}

async function _autoPickAndUploadFiles() {
  const taskId = await _ensureAutoDraftId();
  if (!taskId) {
    await uiAlert(t('auto.save_failed', { reason: 'no_draft_id' }));
    return;
  }
  let data;
  try {
    data = await window.orkas.invoke('autoTasks.attachments.pickAndUpload', { taskId });
  } catch (err) {
    _autoLog.warn('native picker upload failed', err);
    await uiAlert(t('auto.save_failed', { reason: (err && err.message) || err }));
    return;
  }
  const names = Array.isArray(data && data.items) ? data.items : [];
  for (const name of names) {
    _autoCurrentAttachments = _autoCurrentAttachments.filter((a) => a.name !== name);
    _autoCurrentAttachments.push({ name });
  }
  const failed = Array.isArray(data && data.failed) ? data.failed : [];
  if (failed.length) {
    await uiAlert(t('auto.save_failed', {
      reason: failed.map((x) => `${x.name || ''}: ${x.error || 'unknown'}`).join('\n'),
    }));
  }
  _renderAutoAttachmentChips();
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
  wrap.innerHTML = _autoCurrentAttachments.map((a) => `
    <div class="chat-attach-chip" data-name="${escapeHtml(a.name)}">
      <span class="chat-attach-label">${escapeHtml(a.name)}</span>
      <span class="chat-attach-remove" title="${escapeHtml(t('auto.delete_btn'))}">×</span>
    </div>
  `).join('');
  for (const chip of wrap.querySelectorAll('.chat-attach-chip')) {
    const remove = chip.querySelector('.chat-attach-remove');
    if (!remove) continue;
    remove.addEventListener('click', async () => {
      const name = chip.dataset.name;
      if (!name || !_autoCurrentTaskId) return;
      try {
        await window.orkas.invoke('autoTasks.attachments.delete', {
          taskId: _autoCurrentTaskId, name,
        });
      } catch (err) {
        _autoLog.warn('delete attachment failed', err);
      }
      _autoCurrentAttachments = _autoCurrentAttachments.filter((a) => a.name !== name);
      _renderAutoAttachmentChips();
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

/** Show / hide the single `.chat-skill-chip` widget. Skill and connector
 *  share the slot — at most one populated at a time. Label uses the same
 *  `skills.use_label` / `connectors.use_label` i18n keys as the commander
 *  composer so the chip reads identically (`使用 X 技能` / `使用 X 连接器`). */
function _repaintAutoUseChip() {
  const chip = document.getElementById('auto-skill-chip');
  if (!chip) return;
  const skill = _autoCurrentSkill;
  const connector = _autoCurrentConnector;
  if (!skill && !connector) {
    chip.style.display = 'none';
    chip.classList.remove('is-skill', 'is-connector');
    chip.innerHTML = '';
    return;
  }
  chip.style.display = '';
  chip.classList.remove('is-skill', 'is-connector');
  let prefix, name, kindClass;
  if (skill) {
    name = skill.name;
    prefix = t('skills.use_label', { skill: '' });
    kindClass = 'is-skill';
  } else {
    name = connector.name;
    prefix = t('connectors.use_label', { connector: '' });
    kindClass = 'is-connector';
  }
  chip.classList.add(kindClass);
  const fullLabel = (skill ? t('skills.use_label', { skill: name }) : t('connectors.use_label', { connector: name }));
  chip.innerHTML = `
    <span class="chip-label" title="${escapeHtml(fullLabel)}"><span class="chip-label-prefix">${escapeHtml(prefix)}</span><span class="chip-label-name">${escapeHtml(name)}</span></span>
    <span class="chip-close" title="${escapeHtml(t('chat.chip_remove_title'))}">×</span>
  `;
  const close = chip.querySelector('.chip-close');
  if (close) {
    close.addEventListener('click', () => {
      _autoCurrentSkill = null;
      _autoCurrentConnector = null;
      _repaintAutoUseChip();
    });
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
}

function _autoResetForm() {
  _autoEditingTaskId = null;
  _autoEditingProjectId = '';
  _autoCurrentRecipient = { kind: 'commander' };
  _autoCurrentSkill = null;
  _autoCurrentConnector = null;
  _autoCurrentTaskId = '';
  _autoCurrentAttachments = [];
  const ta = document.getElementById('auto-task-input');
  if (ta) ta.value = '';
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
  _repaintAutoUseChip();
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
  const task = opts.task || null;
  _autoLockedProjectId = (opts.projectId && typeof opts.projectId === 'string') ? opts.projectId : '';
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
    _autoProjectSel.setValue(task && task.project_id ? task.project_id : '');
  }

  if (task) _autoFillForm(task);
  else _autoResetForm();
  _autoRepaintLabels();
  _showAutoDialog();
}

function _showAutoDialog() {
  const overlay = document.getElementById('auto-task-dialog-overlay');
  if (!overlay) return;
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
  _autoCurrentAttachments = (Array.isArray(task.attachments) ? task.attachments : []).map((name) => ({ name }));
  _autoCurrentRecipient = (task.recipient && task.recipient.kind)
    ? task.recipient
    : { kind: 'commander' };
  _autoCurrentSkill = (task.skill && task.skill.id) ? { id: task.skill.id, name: task.skill.name } : null;
  _autoCurrentConnector = (task.connector && task.connector.id) ? { id: task.connector.id, name: task.connector.name } : null;
  if (_autoCurrentRecipient.kind === 'agent') {
    _autoCurrentSkill = null;
    _autoCurrentConnector = null;
  }
  const ta = document.getElementById('auto-task-input');
  if (ta) ta.value = task.content || '';
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
  _repaintAutoUseChip();
  _renderAutoAttachmentChips();
}

async function _autoSubmitForm() {
  const submitBtn = document.getElementById('auto-submit-btn');
  const ta = document.getElementById('auto-task-input');
  const titleInput = document.getElementById('auto-title-input');
  const enabledInput = document.getElementById('auto-enabled-input');
  const dateInput = document.getElementById('auto-date-input');
  if (!ta || !submitBtn || !_autoFreqSel || !_autoHourSel || !_autoMinuteSel) return;

  const content = (ta.value || '').trim();
  if (!content) { await uiAlert(t('auto.invalid_content')); return; }

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

  submitBtn.disabled = true;
  try {
    const attachmentNames = _autoCurrentAttachments.map((a) => a.name);
    // Build the chip refs explicitly so create/update can carry `null` for
    // "remove chip" semantics. The backend treats null as "clear field"
    // (only on update); create simply omits absent fields.
    const skillField = _autoCurrentSkill;
    const connectorField = _autoCurrentConnector;
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
      await uiAlert(t('auto.save_failed', { reason: (res && res.error) || '' }));
      return;
    }
    const savedTask = res.task;
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
      if (!inner || inner.type !== 'conv_created') return;
      if (typeof loadConversations === 'function') {
        loadConversations().catch((err) => _autoLog.warn('reload after fire failed', err));
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
