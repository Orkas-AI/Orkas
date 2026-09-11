// ─── Auto tab ──────────────────────────────────────────────────────
// Sidebar peer of Commander / Agents / Skills. Lists user-authored
// auto tasks; each task is a (content + schedule + optional project
// scope) tuple. Reads / writes via `autoTasks.*` IPC channels;
// features/auto_tasks.ts in main handles persistence + the in-process
// scheduler that fires due tasks through groupChat.send.
//
// Layout:
//   #panel-auto
//     .auto-scroll
//       .auto-list   global tasks first, then project groups in sidebar order
//
// Create and edit share a modal with the project-detail Automation tab.
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

function _autoLogFailure(action, data) {
  _autoLog.warn('automation operation failed', { action, ...(data || {}) });
}

const _AUTO_STABLE_FAILURE_CODES = new Set([
  'action_failed',
  'attachment_uploading',
  'attach_failed',
  'conv_create_failed',
  'create_failed',
  'delete_failed',
  'file_prepare_failed',
  'invalid_connector',
  'invalid_content',
  'invalid_end_condition',
  'invalid_id',
  'invalid_message_parts',
  'invalid_name',
  'invalid_project',
  'invalid_recipient',
  'invalid_schedule',
  'invalid_skill',
  'invalid_task_id',
  'invoke_failed',
  'library_attach_failed',
  'no_draft_id',
  'no_valid_files',
  'not_found',
  'project_not_found',
  'run_failed',
  'send_not_ok',
  'send_threw',
  'too_many_tasks',
  'update_failed',
  'upload_failed',
]);

function _autoErrorCandidate(value) {
  if (typeof value === 'string') return value;
  if (!value || typeof value !== 'object') return '';
  return value.error_code || value.code || value.error || value.message || '';
}

function _autoStableErrorCode(value, fallback = 'action_failed') {
  const candidate = String(_autoErrorCandidate(value) || '').trim().toLowerCase();
  if (_AUTO_STABLE_FAILURE_CODES.has(candidate)) return candidate;
  if (/^e_[a-z0-9_]{1,61}$/.test(candidate)) return candidate.toUpperCase();
  return _AUTO_STABLE_FAILURE_CODES.has(fallback) ? fallback : 'action_failed';
}

function _autoFailureType(errorCode, fallback = 'operation') {
  const code = String(errorCode || '').toLowerCase();
  if (code.startsWith('invalid_') || code === 'no_valid_files' || code === 'attachment_uploading') return 'validation';
  if (code === 'invoke_failed' || code === 'no_draft_id') return 'ipc';
  if (code === 'conv_create_failed' || code === 'send_not_ok' || code === 'send_threw') return 'runtime';
  if (_AUTO_STABLE_FAILURE_CODES.has(code)) return 'operation';
  return fallback;
}

function _autoResultFailure(error, fallback, fallbackType = 'operation') {
  const errorCode = _autoStableErrorCode(error, fallback);
  return {
    error_code: errorCode,
    error_type: _autoFailureType(errorCode, fallbackType),
  };
}

function _autoAttachmentPayload(files, source) {
  const list = Array.from(files || []);
  let totalBytes = 0;
  for (const file of list) {
    const bytes = Number((file && (file.size || file.bytes)) || 0);
    if (Number.isFinite(bytes) && bytes > 0) totalBytes += bytes;
  }
  const sourceType = ['drop', 'internal_drop', 'paste', 'picker'].includes(source)
    ? source
    : 'unknown';
  return {
    source: sourceType,
    file_count: list.length,
    total_bytes: totalBytes,
    mode: _autoEditingTaskId ? 'edit' : 'create',
  };
}

function _autoTrackAttachmentResult(payload, startedAt, result, counts, failure = null) {
  const eventPayload = {
    ...payload,
    result,
    ...counts,
    duration_ms: Math.max(0, Math.round(performance.now() - startedAt)),
  };
  if (failure && (result === 'failure' || result === 'partial_failure')) {
    Object.assign(eventPayload, failure);
  }
  _autoTrackEvent('auto_attachment_upload_result', eventPayload);
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
// Presentation state belongs to this list, independently of sidebar expansion.
const _autoCollapsedGroups = new Set();
let _autoFormMounted = false;  // _aiSelectMount only once
let _autoEditingTaskId = null; // null = create mode, taskId = edit mode
// Current persistent installation identity — fetched lazily on first row
// render. Used to decide which device chip to show ("this device" vs. the
// task's stored hostname).
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
  const targets = [
    { id: 'auto-sync-note', text: listText },
    { id: 'project-auto-sync-note', text: listText },
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

// Execution-history data is paged independently from the sidebar's bounded
// startup conversation cache. Counts are loaded in one batch for every
// visible auto task; pages are fetched only when a task card is expanded.
const _autoTaskConversationCounts = new Map(); // taskId -> total
const _autoTaskConversationPages = new Map();  // taskId -> page state

// Cached `_aiSelectMount` handles for the inline form. Set on first mount.
let _autoFreqSel = null;
let _autoEndSel = null;
let _autoWeekdaySel = null;
let _autoMonthlyDaySel = null;
let _autoHourSel = null;
let _autoMinuteSel = null;
let _autoProjectSel = null;
let _autoRunDeviceSel = null;
let _autoDatePicker = null;
let _autoEndDatePicker = null;
let _autoOpenDatePicker = null;
// Set by `openAutoTaskDialog({projectId})` from the project-detail entry —
// the task gets bound to this project on save. Global-tab opens omit it,
// producing a project-less task. (No project picker inside the modal; the
// project a task lives under is determined by where it was created from.)
let _autoLockedProjectId = '';
let _autoEditingProjectId = '';
let _autoEditingDeviceTask = null;
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
  let summary = '';
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
  if (s.type === 'hourly') summary = t('auto.summary_hourly', { hours: s.interval_hours });
  const time = _autoPadHM(s.hour) + ':' + _autoPadHM(s.minute);
  if (s.type === 'daily') summary = t('auto.summary_daily', { time });
  if (s.type === 'weekly') {
    summary = t('auto.summary_weekly', { day: t('auto.weekday.' + s.weekday), time });
  }
  if (s.type === 'monthly') {
    const day = (s.day === 31) ? t('auto.day_last') : t('auto.day_value', { day: s.day });
    summary = t('auto.summary_monthly', { day, time });
  }
  const end = _autoFormatEndSummary(task);
  return summary && end ? t('auto.summary_with_end', { schedule: summary, end }) : summary;
}

function _autoFormatEndSummary(task) {
  const condition = task && task.end_condition;
  if (!condition) return '';
  if (condition.type === 'date') return t('auto.summary_end_date', { date: condition.date });
  if (condition.type === 'count') {
    const current = Number.isSafeInteger(task.scheduled_run_count) ? task.scheduled_run_count : 0;
    return t('auto.summary_end_count', { current, max: condition.max_runs });
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

function _autoIsTaskOnCurrentDevice(task, device = _autoCurrentDevice) {
  if (!task || !task.device_id) return true;
  return !!device && task.device_id === device.id;
}

function _autoCanTransferTaskToCurrentDevice(task, device = _autoCurrentDevice) {
  return !!task && !!device && !!device.id && !_autoIsTaskOnCurrentDevice(task, device);
}

function _autoRunDeviceOptions(task, device = _autoCurrentDevice, translate = t) {
  if (!_autoCanTransferTaskToCurrentDevice(task, device)) return [];
  return [
    {
      value: 'assigned',
      label: _autoDisplayDeviceName(task.device_name || task.device_id),
    },
    { value: 'current', label: translate('auto.device_current') },
  ];
}

// Consume the exact projects.list order used by the sidebar. Keep unresolved
// project references separate from global tasks while project metadata loads.
function _autoGroupTasks(tasks, projects) {
  const byProject = new Map();
  for (const task of tasks) {
    const projectId = task.project_id || '';
    if (!byProject.has(projectId)) byProject.set(projectId, []);
    byProject.get(projectId).push(task);
  }
  const groups = [{ projectId: '', name: '', tasks: byProject.get('') || [] }];
  byProject.delete('');
  for (const project of projects) {
    const projectId = project.project_id;
    if (!byProject.has(projectId)) continue;
    groups.push({ projectId, name: project.name || '', tasks: byProject.get(projectId) });
    byProject.delete(projectId);
  }
  for (const [projectId, items] of byProject) {
    groups.push({ projectId, name: '', tasks: items });
  }
  return groups;
}

function _autoUiIcon(name, className) {
  return typeof window !== 'undefined' && typeof window.uiIconHtml === 'function'
    ? window.uiIconHtml(name, className)
    : '';
}

function _autoStructuredMessagePreview(task, maxLength) {
  if (!task || !Array.isArray(task.message_parts)
      || typeof chatUseTextFromMessageParts !== 'function') return null;
  const limit = Math.max(1, Number(maxLength) || 160);
  const totalTextLength = task.message_parts.reduce((sum, part) => (
    sum + (part && part.type === 'text' && typeof part.text === 'string' ? part.text.length : 0)
  ), 0);
  const previewParts = [];
  let remaining = limit;
  for (const part of task.message_parts) {
    if (totalTextLength > limit && remaining <= 0) break;
    if (part && part.type === 'text' && typeof part.text === 'string') {
      const text = totalTextLength > limit ? part.text.slice(0, remaining) : part.text;
      if (text) previewParts.push({ type: 'text', text });
      remaining -= text.length;
      if (text.length < part.text.length) break;
    } else {
      previewParts.push(part);
    }
  }
  const value = chatUseTextFromMessageParts(previewParts);
  return value ? { value, truncated: totalTextLength > limit } : null;
}

function _autoTaskMessagePreviewHtml(task, maxLength = 160) {
  const content = String((task && task.content) || '');
  const limit = Math.max(1, Number(maxLength) || 160);
  const structured = _autoStructuredMessagePreview(task, limit);
  const previewContent = structured ? '' : content.slice(0, limit);
  const previewTask = { ...(task || {}), content: previewContent };
  const previewValue = structured ? structured.value : _autoComposerValueForTask(previewTask);
  let html;
  if (typeof _renderChatUseMirrorHtml === 'function') {
    html = _renderChatUseMirrorHtml(previewValue, (value) => escapeHtml(value));
  } else if (typeof formatChatUseTextForDisplay === 'function') {
    html = escapeHtml(formatChatUseTextForDisplay(previewValue));
  } else {
    // `chat-use.js` loads before this lazy module in the app. Keep a readable
    // fallback for focused tests or partial renderer shells without exposing
    // the invisible token metadata as text.
    const labels = [];
    if (task && task.skill && task.skill.name) {
      labels.push(t('skills.use_label', { skill: task.skill.name }));
    }
    if (task && task.connector && task.connector.name) {
      labels.push(t('connectors.use_label', { connector: task.connector.name }));
    }
    html = escapeHtml(labels.concat(previewContent ? [previewContent] : []).join(' '));
  }
  const truncated = structured ? structured.truncated : content.length > limit;
  return `${html}${truncated ? '…' : ''}`;
}

// ─── Row rendering (shared between global tab and project-detail card) ──

function _autoRenderRow(task, opts) {
  // opts: { expanded?: boolean, onEdit: (task) => void, afterChange: () => void }
  const row = document.createElement('div');
  row.className = 'auto-row' + (task.enabled ? '' : ' is-disabled');
  row.dataset.taskId = task.id;

  // ── Main column (left) ────────────────────────────────────────────────
  // Name and message preview lead; enabled state sits with device metadata.
  // Inline skill/connector resources retain the shared message rendering.
  const contentText = String(task.content || '');
  const contentHtml = contentText
    ? `<div class="auto-row-content">${_autoTaskMessagePreviewHtml(task)}</div>`
    : `<div class="auto-row-content auto-row-content-empty muted">${escapeHtml(t('auto.invalid_content'))}</div>`;
  const titleHtml = task.title
    ? `<div class="auto-row-title">${escapeHtml(task.title)}</div>`
    : '';
  if (!task.title) row.classList.add('is-untitled');
  const statusHtml = `<span class="auto-row-status">${escapeHtml(t(task.enabled ? 'auto.status_enabled' : 'auto.status_disabled'))}</span>`;

  // Metadata chip row — skill and connector belong to the message preview
  // above, matching the current chat composer instead of forming a second row.
  const chips = [];
  if (task.recipient && task.recipient.kind === 'agent' && task.recipient.name) {
    chips.push(`<span class="auto-row-chip is-agent" title="${escapeHtml(task.recipient.name)}">${_autoUiIcon('user', 'auto-row-meta-icon')}<span class="auto-row-chip-label">${escapeHtml(task.recipient.name)}</span></span>`);
  } else if (!task.recipient || task.recipient.kind !== 'agent') {
    chips.push(`<span class="auto-row-chip is-agent">${_autoUiIcon('user', 'auto-row-meta-icon')}<span class="auto-row-chip-label">${escapeHtml(t('chat.recipient_commander'))}</span></span>`);
  }
  // Device chip — always shown so the user can tell at a glance which
  // machine each task is bound to. "本机" when the task is assigned here
  // (or for legacy tasks created before device-stamping shipped — treated
  // as current-device since they live in this uid's local cloud tree).
  // Otherwise the assigned device's hostname; hover tooltip spells out that
  // remote-device tasks don't fire locally.
  if (_autoCurrentDevice) {
    const isHere = _autoIsTaskOnCurrentDevice(task);
    if (isHere) {
      chips.push(`<span class="auto-row-chip is-device">${_autoUiIcon('monitor', 'auto-row-meta-icon')}<span class="auto-row-chip-label">${escapeHtml(t('auto.device_current'))}</span></span>`);
    } else {
      const hostname = _autoDisplayDeviceName(task.device_name || task.device_id);
      const hint = t('auto.device_remote_hint', { name: hostname });
      chips.push(`<span class="auto-row-chip is-device" title="${escapeHtml(hint)}">${_autoUiIcon('monitor', 'auto-row-meta-icon')}<span class="auto-row-chip-label">${escapeHtml(hostname)}</span></span>`);
    }
  }
  chips.push(statusHtml);
  const attachCount = Array.isArray(task.attachments) ? task.attachments.length : 0;
  if (attachCount > 0) {
    chips.push(`<span class="auto-row-chip">${_autoUiIcon('paperclip', 'auto-row-meta-icon')}<span class="auto-row-chip-label">${escapeHtml(t('auto.attachment_count', { n: attachCount }))}</span></span>`);
  }
  const chipsHtml = chips.length ? `<div class="auto-row-chips">${chips.join('')}</div>` : '';

  // ── Right column (schedule + last run + ⋯) ───────────────────────────
  const summary = escapeHtml(_autoFormatSummary(task));
  const lastRun = escapeHtml(_autoFormatLastRun(task.last_run_at));
  const moreTitle = escapeHtml(t('auto.more_menu'));

  // Conversation count labels the row's optional execution-history disclosure.
  // The row itself is the disclosure surface; the redundant per-row chevron is
  // intentionally omitted so project grouping remains the only visible
  // expand/collapse control in the list.
  const convCount = _autoCountConvsForTask(task.id);

  row.innerHTML = `
    <div class="auto-row-head">
      <div class="auto-row-main">
        ${titleHtml}
        ${contentHtml}
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
  row.tabIndex = 0;
  row.setAttribute('aria-expanded', 'false');
  row.setAttribute('aria-label', t('auto.task_convs', { n: convCount }));

  // ── ⋯ menu (enable/disable + edit + delete) ──────────────────────────
  const moreBtn = row.querySelector('[data-act="more"]');
  moreBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    _openAutoRowMenu(moreBtn, task, opts);
  });
  // ── Execution-history disclosure ────────────────────────────────────
  // Clicking the row still reveals its runs, but project grouping owns the
  // only visible chevron. Interactive controls keep their own click semantics.
  const convsWrap = row.querySelector('.auto-row-convs');
  const convsList = row.querySelector('.auto-row-convs-list');
  const toggleExpand = () => {
    const expanded = row.getAttribute('aria-expanded') === 'true';
    if (expanded) {
      row.setAttribute('aria-expanded', 'false');
      row.classList.remove('is-expanded');
      convsWrap.hidden = true;
      if (contentText) row.querySelector('.auto-row-content').innerHTML = _autoTaskMessagePreviewHtml(task);
    } else {
      row.setAttribute('aria-expanded', 'true');
      row.classList.add('is-expanded');
      convsWrap.hidden = false;
      if (contentText) row.querySelector('.auto-row-content').innerHTML = _autoTaskMessagePreviewHtml(task, Number.MAX_SAFE_INTEGER);
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
  row.addEventListener('keydown', (e) => {
    if (e.target !== row || (e.key !== 'Enter' && e.key !== ' ')) return;
    e.preventDefault();
    toggleExpand();
  });
  if (opts && opts.expanded) toggleExpand();
  return row;
}

function _autoCachedTaskConversations(taskId) {
  if (typeof conversations === 'undefined' || !Array.isArray(conversations)) return [];
  return conversations.filter((c) => c && c.origin_auto_task_id === taskId);
}

// Prefer the authoritative batch/page total. The shared `conversations`
// array remains a fallback for the brief interval before counts arrive.
function _autoCountConvsForTask(taskId) {
  const page = _autoTaskConversationPages.get(taskId);
  if (page && page.initialized) return Math.max(0, Number(page.total) || 0);
  if (_autoTaskConversationCounts.has(taskId)) {
    return Math.max(0, Number(_autoTaskConversationCounts.get(taskId)) || 0);
  }
  return _autoCachedTaskConversations(taskId).length;
}

async function _autoLoadTaskConversationCounts(taskIds) {
  const ids = Array.from(new Set((Array.isArray(taskIds) ? taskIds : [])
    .map((id) => String(id || ''))
    .filter(Boolean)));
  if (!ids.length) return;
  try {
    const res = await window.orkas.invoke('conversations.autoTaskCounts', { task_ids: ids });
    if (!res || res.ok === false) throw new Error(res?.error || 'auto task conversation count failed');
    const counts = (res.counts && typeof res.counts === 'object') ? res.counts : {};
    for (const taskId of ids) {
      const total = Math.max(0, Number(counts[taskId]) || 0);
      const page = _autoTaskConversationPages.get(taskId);
      // A changed total means the existing offset belongs to an older index
      // snapshot. Drop it so the next expansion starts from the correct head.
      if (page && page.initialized && page.total !== total) {
        _autoTaskConversationPages.delete(taskId);
      }
      _autoTaskConversationCounts.set(taskId, total);
    }
  } catch (err) {
    _autoLog.warn('load task conversation counts failed', err);
  }
}

function _autoTaskConversationPage(taskId) {
  let page = _autoTaskConversationPages.get(taskId);
  if (!page) {
    page = {
      items: [],
      total: _autoCountConvsForTask(taskId),
      nextOffset: 0,
      initialized: false,
      loading: null,
    };
    _autoTaskConversationPages.set(taskId, page);
  }
  return page;
}

function _autoMergeConversationRows(existing, incoming) {
  const byCid = new Map();
  for (const row of Array.isArray(existing) ? existing : []) {
    if (row && row.conversation_id) byCid.set(row.conversation_id, row);
  }
  for (const row of Array.isArray(incoming) ? incoming : []) {
    if (row && row.conversation_id) byCid.set(row.conversation_id, row);
  }
  return Array.from(byCid.values());
}

function _autoMergeIntoConversationCache(rows) {
  if (!Array.isArray(rows) || !rows.length || typeof conversations === 'undefined') return;
  if (typeof _appendConversationSlice === 'function') {
    _appendConversationSlice(rows);
    return;
  }
  conversations = _autoMergeConversationRows(
    Array.isArray(conversations) ? conversations : [],
    rows,
  );
}

async function _autoLoadTaskConversationPage(taskId, append = false) {
  const page = _autoTaskConversationPage(taskId);
  if (page.loading) return page.loading;
  if (append && (!page.initialized || page.nextOffset === null)) return page;
  const offset = append ? page.nextOffset : 0;
  const run = (async () => {
    const res = await window.orkas.invoke('conversations.list', {
      mode: 'auto_task',
      task_id: taskId,
      offset,
    });
    if (!res || res.ok === false) throw new Error(res?.error || 'auto task conversation page failed');
    const rows = Array.isArray(res.conversations) ? res.conversations : [];
    page.items = append ? _autoMergeConversationRows(page.items, rows) : rows;
    page.total = Math.max(0, Number(res.total) || 0);
    const next = res.next_offset === null ? null : Number(res.next_offset);
    page.nextOffset = Number.isSafeInteger(next) && next >= 0 ? next : null;
    page.initialized = true;
    _autoTaskConversationCounts.set(taskId, page.total);
    _autoMergeIntoConversationCache(rows);
    return page;
  })();
  page.loading = run;
  try {
    return await run;
  } finally {
    if (page.loading === run) page.loading = null;
  }
}

function _autoRefreshTaskConvsChrome(taskId, container) {
  if (!container) return;
  const row = container.closest('.auto-row');
  if (!row) return;
  const count = _autoCountConvsForTask(taskId);
  const label = t('auto.task_convs', { n: count });
  const head = row.querySelector('.auto-row-convs-head');
  if (head) head.textContent = label;
  row.setAttribute('aria-label', label);
}

/** Render the list of conversations spawned by this task into the given
 *  container. Reuses the shared conversation row renderer so streaming dots
 *  and delete behave the same as the sidebar, while hiding pin controls in
 *  this execution-history surface. */
function _autoRenderTaskConvs(taskId, container) {
  if (!container) return;
  _autoRefreshTaskConvsChrome(taskId, container);
  const page = _autoTaskConversationPages.get(taskId);
  if (!page || !page.initialized) {
    container.innerHTML = `<div class="muted auto-row-convs-empty">${escapeHtml(t('chat.loading'))}</div>`;
    _autoLoadTaskConversationPage(taskId).then(() => {
      if (container.isConnected) _autoRenderTaskConvs(taskId, container);
    }).catch((err) => {
      _autoLog.warn('load task conversations failed', err);
      if (container.isConnected) {
        container.innerHTML = `<div class="muted auto-row-convs-empty">${escapeHtml(t('auto.load_failed', { reason: err?.message || err }))}</div>`;
      }
    });
    return;
  }
  const matches = page.items;
  if (!matches.length) {
    container.innerHTML = `<div class="muted auto-row-convs-empty">${escapeHtml(t('auto.no_convs'))}</div>`;
    return;
  }
  let html = (typeof _renderConversationTimeBucketList === 'function')
    ? _renderConversationTimeBucketList(matches, { nested: true, hidePin: true })
    : matches
        .slice()
        .sort((a, b) => {
          const ta = a.last_active_at || a.updated_at || a.created_at || '';
          const tb = b.last_active_at || b.updated_at || b.created_at || '';
          return tb.localeCompare(ta);
        })
        .map((c) => _renderConversationSidebarItem(c, { nested: true, hidePin: true }))
        .join('');
  if (page.nextOffset !== null) {
    html += `<button type="button" class="conversation-list-load-more" data-auto-task-convs-more="1">${escapeHtml(t('sidebar.load_more_conversations'))}</button>`;
  }
  container.innerHTML = html;
  if (typeof _bindConversationSidebarItems === 'function') {
    _bindConversationSidebarItems(container, {
      selector: '.conv-item',
      async afterSave(updated) {
        if (!updated || !updated.conversation_id) return;
        page.items = page.items.map((item) => (
          item && item.conversation_id === updated.conversation_id
            ? { ...item, ...updated }
            : item
        ));
        _autoRenderTaskConvs(taskId, container);
      },
      async afterDelete(cid) {
        const previousLength = page.items.length;
        page.items = page.items.filter((item) => item && item.conversation_id !== cid);
        if (page.items.length !== previousLength) {
          page.total = Math.max(0, page.total - 1);
          if (page.nextOffset !== null) {
            page.nextOffset = Math.max(page.items.length, page.nextOffset - 1);
          }
          _autoTaskConversationCounts.set(taskId, page.total);
        }
        _autoRenderTaskConvs(taskId, container);
      },
    });
  }
  const more = container.querySelector('[data-auto-task-convs-more="1"]');
  if (more) {
    more.addEventListener('click', async (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (more.disabled) return;
      more.disabled = true;
      more.setAttribute('aria-busy', 'true');
      try {
        await _autoLoadTaskConversationPage(taskId, true);
        if (container.isConnected) _autoRenderTaskConvs(taskId, container);
      } catch (err) {
        _autoLog.warn('load more task conversations failed', err);
        if (more.isConnected) {
          more.disabled = false;
          more.removeAttribute('aria-busy');
        }
      }
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
let _autoMenuAnchorEl = null;
function _ensureAutoMenu() {
  if (_autoMenuEl) return _autoMenuEl;
  const m = document.createElement('div');
  m.className = 'auto-row-menu';
  m.id = 'auto-row-menu-popover';
  m.setAttribute('role', 'menu');
  m.style.display = 'none';
  document.body.appendChild(m);
  m.addEventListener('keydown', (e) => {
    const items = Array.from(m.querySelectorAll('[role="menuitem"]'));
    if (!items.length) return;
    const index = Math.max(0, items.indexOf(document.activeElement));
    let next = null;
    if (e.key === 'ArrowDown') next = items[(index + 1) % items.length];
    else if (e.key === 'ArrowUp') next = items[(index - 1 + items.length) % items.length];
    else if (e.key === 'Home') next = items[0];
    else if (e.key === 'End') next = items[items.length - 1];
    if (next) {
      e.preventDefault();
      next.focus();
    }
  });
  document.addEventListener('click', (e) => {
    if (!_autoMenuEl || _autoMenuEl.style.display === 'none') return;
    if (_autoMenuEl.contains(e.target)) return;
    if (e.target.closest('.auto-row-more')) return;
    _closeAutoRowMenu();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && _autoMenuEl && _autoMenuEl.style.display !== 'none') {
      e.preventDefault();
      _closeAutoRowMenu(true);
    }
  });
  window.addEventListener('scroll', _closeAutoRowMenu, true);
  window.addEventListener('resize', _closeAutoRowMenu);
  _autoMenuEl = m;
  return m;
}
function _closeAutoRowMenu(restoreFocus = false) {
  const anchor = _autoMenuAnchorEl;
  _autoMenuAnchorEl = null;
  if (_autoMenuEl) {
    _autoMenuEl.style.display = 'none';
    _autoMenuEl.innerHTML = '';
    _autoMenuEl.removeAttribute('aria-label');
  }
  if (anchor) anchor.setAttribute('aria-expanded', 'false');
  for (const el of document.querySelectorAll('.auto-row.is-menu-open')) {
    el.classList.remove('is-menu-open');
  }
  if (restoreFocus && anchor && anchor.isConnected) anchor.focus();
}

function _autoCreateActionTracker(action) {
  const startedAt = Date.now();
  let done = false;
  return (result, errorCode = '') => {
    if (done) return;
    done = true;
    const payload = {
      result,
      action,
      duration_ms: Math.max(0, Date.now() - startedAt),
    };
    if (result !== 'success') {
      const failure = _autoResultFailure(errorCode, 'action_failed', 'ipc');
      payload.error_code = failure.error_code;
      payload.error_type = failure.error_type;
    }
    try {
      if (window.Monitor) Monitor.event('auto_task_action_result', payload);
    } catch (_) {}
    if (result === 'failure') {
      _autoLogFailure('auto_task_action', {
        action,
        error_type: payload.error_type,
        error_code: payload.error_code,
      });
    }
  };
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
  _autoMenuAnchorEl = anchorBtn;
  anchorBtn.setAttribute('aria-haspopup', 'menu');
  anchorBtn.setAttribute('aria-controls', menu.id);
  anchorBtn.setAttribute('aria-expanded', 'true');
  menu.setAttribute('aria-label', anchorBtn.getAttribute('aria-label') || '');
  menu.dataset.taskId = task.id;
  const toggleLabel = task.enabled ? t('auto.disable_btn') : t('auto.enable_btn');
  menu.innerHTML = `
    <button type="button" role="menuitem" class="auto-row-menu-item" data-action="run-now">${escapeHtml(t('auto.run_now'))}</button>
    <button type="button" role="menuitem" class="auto-row-menu-item" data-action="toggle-enabled">${escapeHtml(toggleLabel)}</button>
    <button type="button" role="menuitem" class="auto-row-menu-item" data-action="edit">${escapeHtml(t('auto.edit_btn'))}</button>
    <button type="button" role="menuitem" class="auto-row-menu-item is-danger" data-action="delete">${escapeHtml(t('auto.delete_btn'))}</button>
  `;
  for (const item of menu.querySelectorAll('.auto-row-menu-item')) {
    item.addEventListener('click', async (e) => {
      e.stopPropagation();
      const action = item.dataset.action;
      _closeAutoRowMenu();
      if (action === 'run-now') {
        try {
          const res = await window.orkas.invoke('autoTasks.runNow', { taskId: task.id });
          const cid = res && res.cid;
          if (!cid) throw new Error('manual run did not return a conversation id');
          setView('conversation', cid, { entryPoint: 'auto_task_run_now' });
        } catch (err) {
          _autoLog.warn('manual run failed', err);
          await uiAlert(t('auto.run_failed'));
        }
      } else if (action === 'toggle-enabled') {
        const next = !task.enabled;
        const trackResult = _autoCreateActionTracker('toggle');
        try {
          const res = await window.orkas.invoke('autoTasks.setEnabled', { taskId: task.id, enabled: next });
          if (res && res.ok && res.task) {
            trackResult('success');
            Object.assign(task, res.task);
            const row = document.querySelector(`.auto-row[data-task-id="${task.id}"]`);
            if (row) row.classList.toggle('is-disabled', !next);
            if (opts && typeof opts.afterChange === 'function') opts.afterChange();
          } else {
            trackResult('failure', 'update_failed');
          }
        } catch (err) {
          trackResult('failure', 'invoke_failed');
          _autoLog.warn('toggle failed', err);
        }
      } else if (action === 'edit') {
        if (opts && typeof opts.onEdit === 'function') opts.onEdit(task);
      } else if (action === 'delete') {
        if (!(await uiConfirm(t('auto.delete_confirm')))) return;
        const trackResult = _autoCreateActionTracker('delete');
        try {
          const res = await window.orkas.invoke('autoTasks.delete', { taskId: task.id });
          if (res && res.deleted) {
            trackResult('success');
            if (opts && typeof opts.afterChange === 'function') opts.afterChange();
          } else {
            trackResult('failure', 'delete_failed');
          }
        } catch (err) {
          trackResult('failure', 'invoke_failed');
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
  menu.querySelector('.auto-row-menu-item')?.focus();
}

// ─── Global auto tab — list rendering + form wiring ────────────────

async function loadAutoList(force) {
  if (!document.getElementById('auto-list')) return;
  await _refreshAutoSyncNotice();
  if (_autoLoadedOnce && !force) { _autoRenderList(); return; }
  // Resolve the shared project metadata and device identity before grouping.
  // The sidebar's project cache is the grouping authority; ask it to load only
  // while nothing is cached yet, because even a warm `loadProjects()` repaints
  // the sidebar section.
  const projectsCached = typeof _projectsCache !== 'undefined' && Array.isArray(_projectsCache);
  await Promise.all([
    _ensureAutoCurrentDevice(),
    typeof loadProjects === 'function' && !projectsCached ? loadProjects() : Promise.resolve(),
  ]);
  try {
    const res = await window.orkas.invoke('autoTasks.list', {});
    _autoTasks = (res && Array.isArray(res.tasks)) ? res.tasks : [];
    await _autoLoadTaskConversationCounts(_autoTasks.map((task) => task && task.id));
  } catch (err) {
    _autoTasks = [];
    _autoLog.warn('list failed', err);
    if (typeof uiAlert === 'function') uiAlert(t('auto.load_failed', { reason: (err && err.message) || err }));
  }
  _autoLoadedOnce = true;
  _autoRenderList();
}

function _autoRenderList() {
  const listEl = document.getElementById('auto-list');
  const emptyEl = document.getElementById('auto-empty');
  if (!listEl || !_autoLoadedOnce) return;
  // The list lives only on the Auto tab. A projects reload or language change
  // while another view is open waits for the next tab visit, which always
  // reloads and repaints from the current caches.
  if (typeof currentView !== 'undefined' && currentView !== 'auto') return;
  const expandedIds = new Set(Array.from(listEl.querySelectorAll('.auto-row.is-expanded'), (row) => row.dataset.taskId));
  _closeAutoRowMenu();
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
  const projects = typeof _projectsCache !== 'undefined' && Array.isArray(_projectsCache) ? _projectsCache : [];
  for (const group of _autoGroupTasks(_autoTasks, projects)) {
    const section = document.createElement('section');
    section.className = 'auto-group';
    section.dataset.projectId = group.projectId;
    const name = group.projectId ? (group.name || t('auto.project_unavailable')) : t('auto.global');
    const expanded = !_autoCollapsedGroups.has(group.projectId);
    section.innerHTML = `
      <div class="auto-group-head">
        <button type="button" class="auto-group-toggle" aria-expanded="${expanded}">
          <span class="auto-group-icon">${_autoUiIcon(expanded ? 'folder-open' : 'folder', 'auto-group-folder-icon')}</span>
          <span class="auto-group-name">${escapeHtml(name)}</span>
          <span class="auto-group-count">${group.tasks.length}</span>
        </button>
        ${!group.projectId || _autoProjectExists(group.projectId) ? `
          <button type="button" class="project-todo-menu auto-group-add" aria-label="${escapeHtml(t('auto.create_btn') + ' · ' + name)}" title="${escapeHtml(t('auto.create_btn'))}">
            ${_autoUiIcon('plus')}
          </button>` : ''}
      </div>
      <div class="auto-group-list"${expanded ? '' : ' hidden'}></div>`;
    const groupList = section.querySelector('.auto-group-list');
    groupList.id = `auto-group-list-${group.projectId || 'global'}`;
    const toggle = section.querySelector('.auto-group-toggle');
    const add = section.querySelector('.auto-group-add');
    if (add) add.addEventListener('click', () => openAutoTaskDialog({ initialProjectId: group.projectId }));
    toggle.setAttribute('aria-controls', groupList.id);
    toggle.addEventListener('click', () => {
      const next = toggle.getAttribute('aria-expanded') !== 'true';
      toggle.setAttribute('aria-expanded', String(next));
      groupList.hidden = !next;
      if (next) _autoCollapsedGroups.delete(group.projectId);
      else _autoCollapsedGroups.add(group.projectId);
      section.querySelector('.auto-group-icon').innerHTML = _autoUiIcon(next ? 'folder-open' : 'folder', 'auto-group-folder-icon');
      _closeAutoRowMenu();
    });
    if (!group.tasks.length) {
      groupList.innerHTML = `<div class="auto-group-empty">${escapeHtml(t('auto.global_empty'))}</div>`;
    }
    for (const task of group.tasks) {
      groupList.appendChild(_autoRenderRow(task, { onEdit, afterChange, expanded: expandedIds.has(task.id) }));
    }
    listEl.appendChild(section);
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
    if (countEl) countEl.textContent = '0';
    return;
  }
  let tasks = [];
  try {
    const res = await window.orkas.invoke('autoTasks.list', { projectId });
    tasks = (res && Array.isArray(res.tasks)) ? res.tasks : [];
    await _autoLoadTaskConversationCounts(tasks.map((task) => task && task.id));
  } catch (err) {
    _autoLog.warn('project list failed', err);
  }
  listEl.innerHTML = '';
  if (countEl) countEl.textContent = String(tasks.length);
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
      onEdit,
      afterChange,
    }));
  }
}

// ─── Inline create / edit form ───────────────────────────────────────────

function _autoFreqOptions() {
  return [
    { value: 'one_time', label: t('auto.freq_one_time') },
    { value: 'hourly',   label: t('auto.freq_hourly') },
    { value: 'daily',    label: t('auto.freq_daily') },
    { value: 'weekly',   label: t('auto.freq_weekly') },
    { value: 'monthly',  label: t('auto.freq_monthly') },
  ];
}

function _autoEndOptions() {
  return [
    { value: 'none', label: t('auto.end_none') },
    { value: 'date', label: t('auto.end_on_date') },
    { value: 'count', label: t('auto.end_after_count') },
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

/** Project picker options: Global followed by every project in sidebar order.
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
  if (removedPid && _autoLoadedOnce) loadAutoList(true).catch(() => {});
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

function _autoLocalDateParts(raw) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(raw || '').trim());
  if (!match) return null;
  const year = parseInt(match[1], 10);
  const month = parseInt(match[2], 10);
  const day = parseInt(match[3], 10);
  const parsed = new Date(year, month - 1, day);
  if (parsed.getFullYear() !== year || parsed.getMonth() !== month - 1 || parsed.getDate() !== day) return null;
  return { year, month, day, value: `${match[1]}-${match[2]}-${match[3]}` };
}

function _autoCalendarDateValue(date) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${String(date.getFullYear()).padStart(4, '0')}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function _autoCalendarCells(year, month) {
  const first = new Date(year, month, 1, 12);
  const cursor = new Date(year, month, 1 - first.getDay(), 12);
  const cells = [];
  for (let idx = 0; idx < 42; idx += 1) {
    const date = new Date(cursor.getFullYear(), cursor.getMonth(), cursor.getDate() + idx, 12);
    cells.push({
      value: _autoCalendarDateValue(date),
      day: date.getDate(),
      inMonth: date.getFullYear() === year && date.getMonth() === month,
    });
  }
  return cells;
}

function _autoCalendarDateFromValue(value) {
  const parts = _autoLocalDateParts(value);
  return parts ? new Date(parts.year, parts.month - 1, parts.day, 12) : null;
}

function _autoCalendarShiftDate(value, days) {
  const date = _autoCalendarDateFromValue(value) || new Date();
  date.setHours(12, 0, 0, 0);
  date.setDate(date.getDate() + days);
  return _autoCalendarDateValue(date);
}

function _autoCalendarShiftMonth(value, months) {
  const date = _autoCalendarDateFromValue(value) || new Date();
  const day = date.getDate();
  const target = new Date(date.getFullYear(), date.getMonth() + months, 1, 12);
  const lastDay = new Date(target.getFullYear(), target.getMonth() + 1, 0, 12).getDate();
  target.setDate(Math.min(day, lastDay));
  return _autoCalendarDateValue(target);
}

function _autoDatePickerMount(el, config = {}) {
  if (!el) return null;
  const input = el.querySelector('input');
  const toggle = el.querySelector('.auto-date-picker-toggle');
  const popover = el.querySelector('.auto-date-picker-popover');
  if (!input || !toggle || !popover) return null;

  const state = {
    open: false,
    viewYear: new Date().getFullYear(),
    viewMonth: new Date().getMonth(),
    activeValue: '',
  };
  const headingId = `${popover.id}-heading`;
  let portalParent = null;
  let portalNextSibling = null;

  const locale = () => {
    try {
      return typeof getLocaleMeta === 'function'
        ? getLocaleMeta(getLang()).intlLocale
        : 'en-US';
    } catch (_) {
      return 'en-US';
    }
  };
  const escape = (value) => (
    typeof escapeHtml === 'function'
      ? escapeHtml(String(value == null ? '' : value))
      : String(value == null ? '' : value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
  );
  const icon = (name, className) => (
    typeof window.uiIconHtml === 'function' ? window.uiIconHtml(name, className) : ''
  );
  const dateLabel = (date, options) => {
    try { return new Intl.DateTimeFormat(locale(), options).format(date); }
    catch (_) { return _autoCalendarDateValue(date); }
  };
  const todayValue = () => _autoCalendarDateValue(new Date());

  const syncViewFromInput = () => {
    const selected = _autoCalendarDateFromValue(input.value) || new Date();
    state.viewYear = selected.getFullYear();
    state.viewMonth = selected.getMonth();
    state.activeValue = _autoCalendarDateValue(selected);
  };

  const render = ({ focusActive = false } = {}) => {
    const selected = _autoLocalDateParts(input.value);
    const selectedValue = selected ? selected.value : '';
    const today = todayValue();
    const monthDate = new Date(state.viewYear, state.viewMonth, 1, 12);
    const monthTitle = dateLabel(monthDate, { year: 'numeric', month: 'long' });
    const cells = _autoCalendarCells(state.viewYear, state.viewMonth);
    const weekdays = [];
    for (let day = 0; day < 7; day += 1) {
      const date = new Date(2024, 0, 7 + day, 12);
      weekdays.push({
        short: dateLabel(date, { weekday: 'narrow' }),
        full: dateLabel(date, { weekday: 'long' }),
      });
    }
    if (!cells.some((cell) => cell.value === state.activeValue)) {
      const firstInMonth = cells.find((cell) => cell.inMonth);
      state.activeValue = firstInMonth ? firstInMonth.value : cells[0].value;
    }
    const weekdayHtml = weekdays.map((weekday) => (
      `<span role="columnheader" aria-label="${escape(weekday.full)}">${escape(weekday.short)}</span>`
    )).join('');
    const cellHtml = cells.map((cell) => {
      const date = _autoCalendarDateFromValue(cell.value);
      const classNames = ['auto-date-picker-day'];
      if (!cell.inMonth) classNames.push('is-outside');
      if (cell.value === today) classNames.push('is-today');
      if (cell.value === selectedValue) classNames.push('is-selected');
      const ariaCurrent = cell.value === today ? ' aria-current="date"' : '';
      return `<button type="button" class="${classNames.join(' ')}" data-date="${cell.value}" role="gridcell" aria-label="${escape(dateLabel(date, { year: 'numeric', month: 'long', day: 'numeric' }))}" aria-selected="${cell.value === selectedValue ? 'true' : 'false'}" tabindex="${cell.value === state.activeValue ? '0' : '-1'}"${ariaCurrent}>${cell.day}</button>`;
    }).join('');
    popover.setAttribute('aria-label', t(config.labelKey || 'auto.date_label'));
    popover.innerHTML = `
      <div class="auto-date-picker-header">
        <button type="button" class="auto-date-picker-nav" data-action="previous" aria-label="${escape(t('auto.calendar_previous_month'))}" title="${escape(t('auto.calendar_previous_month'))}">${icon('chevron-left', 'ui-icon')}</button>
        <div class="auto-date-picker-heading" id="${escape(headingId)}" aria-live="polite">${escape(monthTitle)}</div>
        <button type="button" class="auto-date-picker-nav" data-action="next" aria-label="${escape(t('auto.calendar_next_month'))}" title="${escape(t('auto.calendar_next_month'))}">${icon('chevron-right', 'ui-icon')}</button>
      </div>
      <div class="auto-date-picker-weekdays" role="row">${weekdayHtml}</div>
      <div class="auto-date-picker-grid" role="grid" aria-labelledby="${escape(headingId)}">${cellHtml}</div>
      <div class="auto-date-picker-footer">
        <button type="button" class="auto-date-picker-today" data-action="today">${escape(t('auto.calendar_today'))}</button>
      </div>`;
    if (focusActive) popover.querySelector('.auto-date-picker-day[tabindex="0"]')?.focus();
  };

  const reposition = () => {
    if (!state.open) return;
    const rect = el.getBoundingClientRect();
    const edge = 8;
    const width = Math.min(296, Math.max(240, window.innerWidth - edge * 2));
    const left = Math.max(edge, Math.min(rect.left, window.innerWidth - width - edge));
    popover.style.position = 'fixed';
    popover.style.left = `${left}px`;
    popover.style.width = `${width}px`;
    const popoverHeight = popover.offsetHeight || 340;
    const placement = typeof _dropdownVerticalPlacement === 'function'
      ? _dropdownVerticalPlacement(rect, popoverHeight, window.innerHeight, { edge, gap: 6 })
      : { top: Math.min(window.innerHeight - popoverHeight - edge, rect.bottom + 6), openAbove: false };
    popover.style.top = `${Math.max(edge, placement.top)}px`;
    popover.dataset.placement = placement.openAbove ? 'top' : 'bottom';
    popover.style.zIndex = String(
      typeof _aiSelectPopoverZIndexFor === 'function' ? _aiSelectPopoverZIndexFor(el) : 14000,
    );
  };

  const close = () => {
    if (!state.open) return;
    state.open = false;
    el.classList.remove('open');
    input.setAttribute('aria-expanded', 'false');
    toggle.setAttribute('aria-expanded', 'false');
    popover.hidden = true;
    popover.style.position = '';
    popover.style.left = '';
    popover.style.top = '';
    popover.style.width = '';
    popover.style.zIndex = '';
    delete popover.dataset.placement;
    if (portalParent) {
      if (portalParent.isConnected) portalParent.insertBefore(popover, portalNextSibling);
      else popover.remove();
      portalParent = null;
      portalNextSibling = null;
    }
    document.removeEventListener('mousedown', onDocumentDown, true);
    window.removeEventListener('scroll', reposition, true);
    window.removeEventListener('resize', reposition, true);
    if (_autoOpenDatePicker === api) _autoOpenDatePicker = null;
  };

  const open = ({ focusGrid = false } = {}) => {
    if (state.open) {
      if (focusGrid) render({ focusActive: true });
      return;
    }
    if (_autoOpenDatePicker && _autoOpenDatePicker !== api) _autoOpenDatePicker.close();
    _autoOpenDatePicker = api;
    syncViewFromInput();
    state.open = true;
    el.classList.add('open');
    input.setAttribute('aria-expanded', 'true');
    toggle.setAttribute('aria-expanded', 'true');
    portalParent = popover.parentNode;
    portalNextSibling = popover.nextSibling;
    document.body.appendChild(popover);
    popover.hidden = false;
    render();
    reposition();
    document.addEventListener('mousedown', onDocumentDown, true);
    window.addEventListener('scroll', reposition, true);
    window.addEventListener('resize', reposition, true);
    if (focusGrid) popover.querySelector('.auto-date-picker-day[tabindex="0"]')?.focus();
  };

  const commit = (value) => {
    input.value = value;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    close();
    input.focus();
  };

  function onDocumentDown(event) {
    if (!el.contains(event.target) && !popover.contains(event.target)) close();
  }

  popover.addEventListener('click', (event) => {
    const button = event.target.closest('button');
    if (!button) return;
    if (button.dataset.date) {
      commit(button.dataset.date);
      return;
    }
    if (button.dataset.action === 'today') {
      commit(todayValue());
      return;
    }
    if (button.dataset.action === 'previous' || button.dataset.action === 'next') {
      const delta = button.dataset.action === 'previous' ? -1 : 1;
      state.activeValue = _autoCalendarShiftMonth(state.activeValue, delta);
      const active = _autoCalendarDateFromValue(state.activeValue);
      state.viewYear = active.getFullYear();
      state.viewMonth = active.getMonth();
      render({ focusActive: true });
      reposition();
    }
  });

  popover.addEventListener('keydown', (event) => {
    if (event.isComposing || event.keyCode === 229) return;
    let nextValue = '';
    if (event.key === 'Escape') {
      close();
      input.focus();
      event.preventDefault();
      return;
    }
    if (event.key === 'ArrowLeft') nextValue = _autoCalendarShiftDate(state.activeValue, -1);
    else if (event.key === 'ArrowRight') nextValue = _autoCalendarShiftDate(state.activeValue, 1);
    else if (event.key === 'ArrowUp') nextValue = _autoCalendarShiftDate(state.activeValue, -7);
    else if (event.key === 'ArrowDown') nextValue = _autoCalendarShiftDate(state.activeValue, 7);
    else if (event.key === 'Home') {
      const active = _autoCalendarDateFromValue(state.activeValue);
      nextValue = _autoCalendarShiftDate(state.activeValue, -active.getDay());
    } else if (event.key === 'End') {
      const active = _autoCalendarDateFromValue(state.activeValue);
      nextValue = _autoCalendarShiftDate(state.activeValue, 6 - active.getDay());
    } else if (event.key === 'PageUp') nextValue = _autoCalendarShiftMonth(state.activeValue, -1);
    else if (event.key === 'PageDown') nextValue = _autoCalendarShiftMonth(state.activeValue, 1);
    if (!nextValue) return;
    const active = _autoCalendarDateFromValue(nextValue);
    state.activeValue = nextValue;
    state.viewYear = active.getFullYear();
    state.viewMonth = active.getMonth();
    render({ focusActive: true });
    reposition();
    event.preventDefault();
  });

  input.addEventListener('click', () => open());
  input.addEventListener('input', () => {
    if (!state.open) return;
    const parsed = _autoCalendarDateFromValue(input.value);
    if (parsed) {
      state.viewYear = parsed.getFullYear();
      state.viewMonth = parsed.getMonth();
      state.activeValue = _autoCalendarDateValue(parsed);
    }
    render();
    reposition();
  });
  input.addEventListener('keydown', (event) => {
    if (event.isComposing || event.keyCode === 229) return;
    if ((event.altKey && event.key === 'ArrowDown') || event.key === 'F4') {
      open({ focusGrid: true });
      event.preventDefault();
    } else if (event.key === 'Escape' && state.open) {
      close();
      event.preventDefault();
    }
  });
  toggle.addEventListener('click', () => {
    if (state.open) close();
    else open({ focusGrid: true });
  });

  const api = {
    el,
    state,
    getValue() { return input.value; },
    setValue(value) {
      input.value = String(value || '');
      if (state.open) {
        syncViewFromInput();
        render();
        reposition();
      }
    },
    repaint() {
      const label = t(config.labelKey || 'auto.date_label');
      input.setAttribute('aria-label', label);
      toggle.setAttribute('aria-label', t('auto.calendar_open'));
      toggle.setAttribute('title', t('auto.calendar_open'));
      popover.setAttribute('aria-label', label);
      if (state.open) {
        render();
        reposition();
      }
    },
    open,
    close,
  };

  input.setAttribute('aria-haspopup', 'dialog');
  input.setAttribute('aria-controls', popover.id);
  input.setAttribute('aria-expanded', 'false');
  toggle.setAttribute('aria-expanded', 'false');
  toggle.innerHTML = icon('calendar', 'ui-icon auto-date-picker-icon');
  api.repaint();
  return api;
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
  if (task && Array.isArray(task.message_parts)
      && typeof chatUseTextFromMessageParts === 'function') {
    const structured = chatUseTextFromMessageParts(task.message_parts);
    if (structured) return structured;
  }
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

  // Mount the shared dropdown controls once. Frequency drives the
  // conditional schedule sub-rows below it.
  const freqMount = document.getElementById('auto-freq-select');
  const endMount = document.getElementById('auto-end-select');
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
    _autoEndSel = _aiSelectMount(endMount, {
      options: _autoEndOptions(),
      value: 'none',
      onChange: (v) => _autoSyncEndRows(v),
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
        _autoRefreshProjectScopedPicker();
        _autoClearRecipientIfOutsideProject().catch(() => {});
      },
    });
    const runDeviceMount = document.getElementById('auto-run-device-select');
    _autoRunDeviceSel = _aiSelectMount(runDeviceMount, {
      options: [],
      value: '',
    });
  }

  if (!_autoDatePicker) {
    _autoDatePicker = _autoDatePickerMount(document.getElementById('auto-date-picker'), {
      labelKey: 'auto.date_label',
    });
  }
  if (!_autoEndDatePicker) {
    _autoEndDatePicker = _autoDatePickerMount(document.getElementById('auto-end-date-picker'), {
      labelKey: 'auto.end_date_label',
    });
  }

  // Initial defaults for the one-time and optional end-date controls.
  const initialDate = _autoLocalDateInputValue(new Date().toISOString());
  if (_autoDatePicker && !_autoDatePicker.getValue()) _autoDatePicker.setValue(initialDate);
  if (_autoEndDatePicker && !_autoEndDatePicker.getValue()) _autoEndDatePicker.setValue(initialDate);

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
  const startedAt = performance.now();
  const payload = _autoAttachmentPayload(list, source);
  const taskId = await _ensureAutoDraftId();
  if (!taskId) {
    _autoTrackAttachmentResult(payload, startedAt, 'failure', {
      uploaded_count: 0,
      failed_count: list.length,
      rejected_count: 0,
    }, _autoResultFailure('no_draft_id', 'upload_failed', 'ipc'));
    await uiAlert(t('auto.save_failed', { reason: 'no_draft_id' }));
    return;
  }
  const { prepared, rejected } = await _autoPrepareUploadFiles(list);
  const rejectedCount = rejected.length;
  if (!prepared.length) {
    _autoTrackAttachmentResult(payload, startedAt, 'failure', {
      uploaded_count: 0,
      failed_count: rejected.length || list.length,
      rejected_count: rejectedCount,
    }, _autoResultFailure(
      rejected.length ? 'file_prepare_failed' : 'no_valid_files',
      'file_prepare_failed',
      'operation',
    ));
    if (rejected.length) await _autoAlertAttachmentFailures(rejected);
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
  const result = failedCount ? (uploadedCount ? 'partial_failure' : 'failure') : 'success';
  _autoTrackAttachmentResult(payload, startedAt, result, {
    uploaded_count: uploadedCount,
    failed_count: failedCount,
    rejected_count: rejectedCount,
  }, failedCount ? _autoResultFailure('upload_failed', 'upload_failed') : null);
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
  const startedAt = performance.now();
  const payload = _autoAttachmentPayload(files, source);
  const taskId = await _ensureAutoDraftId();
  if (!taskId) {
    _autoTrackAttachmentResult(payload, startedAt, 'failure', {
      uploaded_count: 0,
      failed_count: files.length,
      rejected_count: 0,
    }, _autoResultFailure('no_draft_id', 'upload_failed', 'ipc'));
    await uiAlert(t('auto.save_failed', { reason: 'no_draft_id' }));
    return;
  }

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
  const rejectedCount = rejected.length;
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
  const result = rejected.length ? (uploadedCount ? 'partial_failure' : 'failure') : 'success';
  _autoTrackAttachmentResult(payload, startedAt, result, {
    uploaded_count: uploadedCount,
    failed_count: rejected.length,
    rejected_count: rejectedCount,
  }, rejected.length ? _autoResultFailure('upload_failed', 'upload_failed') : null);
  if (rejected.length) await _autoAlertAttachmentFailures(rejected);
}

async function _autoAttachLibraryFile(ref) {
  const startedAt = performance.now();
  const scope = ref && ref.scope === 'project' ? 'project' : 'global';
  const rel = String(ref && ref.rel || '');
  const projectId = _autoValidProjectId(ref && ref.projectId || '');
  if (!rel) return;
  const telemetry = {
    scope,
    mode: _autoEditingTaskId ? 'edit' : 'create',
    has_project: !!projectId,
  };
  const displayName = _autoAttachBaseName(rel);
  const tempId = _autoAttachTempId();
  let attachedName = '';
  try {
    const taskId = await _ensureAutoDraftId();
    if (!taskId) throw new Error('no_draft_id');
    if (scope === 'project' && !projectId) throw new Error('project_not_found');
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
    const payload = {
      taskId,
      ...(scope === 'project'
        ? { projectId, name: rel }
        : { relPath: rel }),
    };
    const channel = scope === 'project'
      ? 'autoTasks.attachments.attachProjectFile'
      : 'autoTasks.attachments.attachContext';
    const data = await window.orkas.invoke(channel, payload);
    const name = data && data.name;
    if (!name) throw new Error((data && data.error) || 'attach_failed');
    attachedName = name;
  } catch (err) {
    const failure = _autoResultFailure(err, 'library_attach_failed');
    _autoLogFailure('auto_library_attach', { ...telemetry, ...failure });
    _autoTrackEvent('auto_library_attach_result', {
      ...telemetry,
      result: 'failure',
      duration_ms: Math.max(0, Math.round(performance.now() - startedAt)),
      ...failure,
    });
    try { _autoReplaceAttachmentByTempId(tempId, null); } catch (_) {}
    throw err;
  }

  _autoTrackEvent('auto_library_attach_result', {
    ...telemetry,
    result: 'success',
    duration_ms: Math.max(0, Math.round(performance.now() - startedAt)),
  });
  try {
    _autoReplaceAttachmentByTempId(tempId, {
      name: attachedName,
      displayName,
      kind: _autoAttachKindForName(attachedName),
      bytes: 0,
      status: 'ready',
    });
  } catch (err) {
    _autoLog.warn('refresh after automation library attach failed', err);
  }
}

async function _autoPickAndUploadFiles() {
  const startedAt = performance.now();
  const payload = _autoAttachmentPayload([], 'picker');
  const taskId = await _ensureAutoDraftId();
  if (!taskId) {
    _autoTrackAttachmentResult(payload, startedAt, 'failure', {
      file_count: 0,
      uploaded_count: 0,
      failed_count: 1,
      rejected_count: 0,
    }, _autoResultFailure('no_draft_id', 'upload_failed', 'ipc'));
    await uiAlert(t('auto.save_failed', { reason: 'no_draft_id' }));
    return;
  }
  let data;
  try {
    data = await window.orkas.invoke('autoTasks.attachments.pickAndUpload', { taskId });
  } catch (err) {
    _autoLog.warn('native picker upload failed', err);
    _autoTrackAttachmentResult(payload, startedAt, 'failure', {
      file_count: 0,
      uploaded_count: 0,
      failed_count: 1,
      rejected_count: 0,
    }, _autoResultFailure(err, 'upload_failed', 'ipc'));
    await uiAlert(t('chat.attach_upload_fail', {
      name: '',
      reason: (err && err.message) || t('chat.attach_upload_generic_fail'),
    }));
    return;
  }
  if (data && data.cancelled === true) {
    _autoTrackAttachmentResult(payload, startedAt, 'cancelled', {
      file_count: 0,
      uploaded_count: 0,
      failed_count: 0,
      rejected_count: 0,
    });
    return;
  }
  const names = Array.isArray(data && data.items) ? data.items : [];
  const failed = Array.isArray(data && data.failed) ? data.failed : [];
  const fileCount = names.length + failed.length;
  const result = fileCount === 0
    ? 'failure'
    : (failed.length ? (names.length ? 'partial_failure' : 'failure') : 'success');
  const failure = result === 'success'
    ? null
    : _autoResultFailure(failed[0] && failed[0].error, 'upload_failed', 'operation');
  _autoTrackAttachmentResult(payload, startedAt, result, {
    uploaded_count: names.length,
    failed_count: failed.length,
    rejected_count: 0,
    file_count: fileCount,
  }, failure);
  for (const name of names) {
    _autoPushReadyAttachment(name, { displayName: name });
  }
  if (failed.length) {
    await _autoAlertAttachmentFailures(failed.map((x) => t('chat.attach_upload_fail', {
      name: x.name || '',
      reason: x.error || t('chat.attach_upload_generic_fail'),
    })));
  }
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
  const hourlyIntervalRow = document.getElementById('auto-row-hourly-interval');
  const dateRow = document.getElementById('auto-row-date');
  const weekdayRow = document.getElementById('auto-row-weekday');
  const monthlyDayRow = document.getElementById('auto-row-monthly-day');
  const timeRow = document.getElementById('auto-row-time');
  const endRow = document.getElementById('auto-row-end');
  if (hourlyIntervalRow) hourlyIntervalRow.hidden = type !== 'hourly';
  if (dateRow) dateRow.hidden = type !== 'one_time';
  if (type !== 'one_time' && _autoDatePicker) _autoDatePicker.close();
  if (weekdayRow) weekdayRow.hidden = type !== 'weekly';
  if (monthlyDayRow) monthlyDayRow.hidden = type !== 'monthly';
  // Hourly cadence is anchored to create / previous scheduled execution;
  // calendar schedules use an explicit wall-clock time.
  if (timeRow) timeRow.hidden = type === 'hourly';
  if (endRow) endRow.hidden = type === 'one_time';
  _autoSyncEndRows(_autoEndSel ? _autoEndSel.getValue() : 'none');
}

function _autoSyncEndRows(type) {
  const oneTime = _autoFreqSel && _autoFreqSel.getValue() === 'one_time';
  const dateRow = document.getElementById('auto-row-end-date');
  const countRow = document.getElementById('auto-row-end-count');
  if (dateRow) dateRow.hidden = oneTime || type !== 'date';
  if (countRow) countRow.hidden = oneTime || type !== 'count';
  if ((oneTime || type !== 'date') && _autoEndDatePicker) _autoEndDatePicker.close();
}

function _repaintAutoRecipientChip() {
  const nameEl = document.getElementById('auto-recipient-name');
  const rec = _autoCurrentRecipient;
  if (nameEl) {
    if (!rec || rec.kind === 'commander' || !rec.id) {
      nameEl.textContent = t('chat.recipient_commander');
      nameEl.setAttribute('data-i18n', 'chat.recipient_commander');
    } else {
      nameEl.removeAttribute('data-i18n');
      nameEl.textContent = rec.name || rec.id;
    }
  }
  if (typeof _syncComposerModelChipAvailability === 'function') {
    _syncComposerModelChipAvailability('auto');
  }
}

function _autoRefreshRunDevicePicker(resetValue = false) {
  const row = document.getElementById('auto-row-run-device');
  const options = _autoRunDeviceOptions(_autoEditingDeviceTask);
  const visible = options.length > 0;
  if (row) row.hidden = !visible;
  if (!_autoRunDeviceSel) return;
  const previous = _autoRunDeviceSel.getValue();
  const value = !resetValue && options.some((option) => option.value === previous)
    ? previous
    : (visible ? 'assigned' : '');
  _autoRunDeviceSel.setOptions(options, { value });
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
  if (_autoFreqSel) {
    const value = _autoFreqSel.getValue();
    _autoFreqSel.setOptions(_autoFreqOptions(), { value });
  }
  if (_autoEndSel) {
    const value = _autoEndSel.getValue();
    _autoEndSel.setOptions(_autoEndOptions(), { value });
  }
  if (_autoWeekdaySel) {
    const value = _autoWeekdaySel.getValue();
    _autoWeekdaySel.setOptions(_autoWeekdayOptions(), { value });
  }
  if (_autoMonthlyDaySel) {
    const value = _autoMonthlyDaySel.getValue();
    _autoMonthlyDaySel.setOptions(_autoMonthlyDayOptions(), { value });
  }
  if (_autoDatePicker) _autoDatePicker.repaint();
  if (_autoEndDatePicker) _autoEndDatePicker.repaint();
  _autoSyncFreqRows(_autoFreqSel ? _autoFreqSel.getValue() : 'daily');
  _autoRefreshRunDevicePicker();
  _paintAutoSyncNotice();
}

function _autoResetForm() {
  _autoEditingTaskId = null;
  _autoEditingProjectId = '';
  _autoEditingDeviceTask = null;
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
  _autoRefreshRunDevicePicker(true);
  const defaultDate = _autoLocalDateInputValue(new Date().toISOString());
  if (_autoDatePicker) _autoDatePicker.setValue(defaultDate);
  const hourlyInput = document.getElementById('auto-hourly-interval-input');
  if (hourlyInput) hourlyInput.value = '1';
  if (_autoEndDatePicker) _autoEndDatePicker.setValue(defaultDate);
  const endCountInput = document.getElementById('auto-end-count-input');
  if (endCountInput) endCountInput.value = '10';
  if (_autoFreqSel) _autoFreqSel.setValue('daily');
  if (_autoEndSel) _autoEndSel.setValue('none');
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
 *  opts.initialProjectId? — preselect a project while keeping the picker visible.
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
    // Editing keeps the task's scope; group creation starts in that group.
    _autoProjectSel.setValue(_autoValidProjectId(task ? task.project_id : opts.initialProjectId));
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
  if (ta) {
    const activeAtOpen = document.activeElement;
    setTimeout(() => {
      if (!overlay.classList.contains('open')) return;
      const active = document.activeElement;
      const composerStillOwnsFocus = typeof _chatComposerHasFocus === 'function'
        && _chatComposerHasFocus(ta);
      // The delayed convenience focus must not steal input after the user has
      // already moved into another dialog control (for example, the title).
      if (active !== activeAtOpen && !composerStillOwnsFocus) return;
      ta.focus();
    }, 50);
  }
}

function _hideAutoDialog() {
  if (_autoDatePicker) _autoDatePicker.close();
  if (_autoEndDatePicker) _autoEndDatePicker.close();
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
  _autoEditingDeviceTask = task;
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
  _autoRefreshRunDevicePicker(true);

  const sched = task.schedule || { type: 'daily', hour: 9, minute: 0 };
  if (_autoFreqSel) _autoFreqSel.setValue(sched.type || 'daily');
  _autoSyncFreqRows(sched.type || 'daily');

  const hourlyInput = document.getElementById('auto-hourly-interval-input');
  if (hourlyInput) hourlyInput.value = String(
    sched.type === 'hourly' && Number.isSafeInteger(sched.interval_hours)
      ? sched.interval_hours
      : 1,
  );
  const endCondition = task.end_condition || null;
  if (_autoEndSel) _autoEndSel.setValue(endCondition ? endCondition.type : 'none');
  if (_autoEndDatePicker) {
    _autoEndDatePicker.setValue(endCondition && endCondition.type === 'date'
      ? endCondition.date
      : _autoLocalDateInputValue(new Date().toISOString()));
  }
  const endCountInput = document.getElementById('auto-end-count-input');
  if (endCountInput) {
    endCountInput.value = String(
      endCondition && endCondition.type === 'count' ? endCondition.max_runs : 10,
    );
  }
  _autoSyncEndRows(endCondition ? endCondition.type : 'none');

  let hour = 9, minute = 0;
  if (sched.type === 'one_time') {
    let d;
    try { d = new Date(sched.at); } catch { d = new Date(); }
    if (!Number.isNaN(d?.getTime?.())) {
      hour = d.getHours();
      minute = d.getMinutes();
    }
    if (_autoDatePicker) _autoDatePicker.setValue(_autoLocalDateInputValue(sched.at));
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
  const hourlyInput = document.getElementById('auto-hourly-interval-input');
  const endDateInput = document.getElementById('auto-end-date-input');
  const endCountInput = document.getElementById('auto-end-count-input');
  if (!ta || !submitBtn || !_autoFreqSel || !_autoHourSel || !_autoMinuteSel) return;

  const rawContent = (ta.value || '').trim();
  const content = _autoStripComposerUseTokens(rawContent).trim();
  const messageParts = (typeof chatUseMessagePartsFromText === 'function')
    ? chatUseMessagePartsFromText(rawContent)
    : null;
  const useState = _autoReadComposerUseState();
  const skillField = useState.skill;
  const connectorField = useState.connector;
  const type = _autoFreqSel.getValue();
  const projectId = _autoSelectedProjectId();
  const isUpdate = !!_autoEditingTaskId;
  const readyAttachments = _autoCurrentAttachments
    .filter((a) => a && a.name && a.status !== 'error' && a.status !== 'uploading');
  const startedAt = performance.now();
  const resultContext = {
    schedule_type: type,
    recipient_type: _autoCurrentRecipient.kind === 'agent' ? 'agent' : 'commander',
    has_skill: !!skillField,
    has_connector: !!connectorField,
    has_project: !!projectId,
    attachment_count: readyAttachments.length,
    content_length: content.length,
  };
  const resultEventName = isUpdate ? 'auto_task_update_result' : 'auto_task_create_result';
  let terminalRecorded = false;
  const trackSaveResult = (result, failure = null) => {
    if (terminalRecorded) return;
    terminalRecorded = true;
    _autoTrackEvent(resultEventName, {
      result,
      ...resultContext,
      duration_ms: Math.max(0, Math.round(performance.now() - startedAt)),
      ...(failure || {}),
    });
  };
  const blockSave = async (errorCode, messageKey) => {
    trackSaveResult('blocked', _autoResultFailure(errorCode, errorCode, 'validation'));
    await uiAlert(t(messageKey));
  };
  // Create remains the canonical funnel-intent click. Updates intentionally
  // use only their terminal result, including client-side validation blocks.
  if (!isUpdate) _autoTrackClick('auto_task_create_submit', resultContext);

  if (!content) {
    await blockSave('invalid_content', 'auto.invalid_content');
    return;
  }

  // HH + MM dropdowns are shared across calendar schedule types.
  const hour = parseInt(_autoHourSel.getValue() || '0', 10);
  const minute = parseInt(_autoMinuteSel.getValue() || '0', 10);
  if (!(hour >= 0 && hour <= 23) || !(minute >= 0 && minute <= 59)) {
    await blockSave('invalid_schedule', 'auto.invalid_schedule');
    return;
  }

  let schedule;
  if (type === 'one_time') {
    const raw = dateInput ? dateInput.value : '';
    const parts = _autoLocalDateParts(raw);
    if (!parts) {
      await blockSave('invalid_schedule', 'auto.invalid_schedule');
      return;
    }
    // Build the target in local time so the date/hour/minute the user picked
    // matches the wall-clock they expect, then store as ISO (UTC).
    const target = new Date(
      parts.year,
      parts.month - 1,
      parts.day,
      hour,
      minute,
      0,
      0,
    );
    if (Number.isNaN(target.getTime())) {
      await blockSave('invalid_schedule', 'auto.invalid_schedule');
      return;
    }
    schedule = { type: 'one_time', at: target.toISOString() };
  } else if (type === 'hourly') {
    const intervalHours = Number(hourlyInput ? hourlyInput.value : '');
    if (!Number.isSafeInteger(intervalHours) || intervalHours < 1 || intervalHours > 876000) {
      await blockSave('invalid_schedule', 'auto.invalid_schedule');
      return;
    }
    schedule = { type: 'hourly', interval_hours: intervalHours };
  } else if (type === 'daily') {
    schedule = { type: 'daily', hour, minute };
  } else if (type === 'weekly') {
    const wd = _autoWeekdaySel ? parseInt(_autoWeekdaySel.getValue() || '1', 10) : 1;
    schedule = { type: 'weekly', weekday: Number.isInteger(wd) ? wd : 1, hour, minute };
  } else if (type === 'monthly') {
    const day = _autoMonthlyDaySel ? parseInt(_autoMonthlyDaySel.getValue() || '1', 10) : 1;
    schedule = { type: 'monthly', day: Number.isInteger(day) && day >= 1 ? day : 1, hour, minute };
  } else {
    await blockSave('invalid_schedule', 'auto.invalid_schedule');
    return;
  }

  let endCondition = null;
  const endType = _autoEndSel ? _autoEndSel.getValue() : 'none';
  if (type !== 'one_time' && endType === 'date') {
    const parts = _autoLocalDateParts(endDateInput ? endDateInput.value : '');
    if (!parts) {
      await blockSave('invalid_end_condition', 'auto.invalid_end_condition');
      return;
    }
    endCondition = { type: 'date', date: parts.value };
  } else if (type !== 'one_time' && endType === 'count') {
    const maxRuns = Number(endCountInput ? endCountInput.value : '');
    if (!Number.isSafeInteger(maxRuns) || maxRuns < 1) {
      await blockSave('invalid_end_condition', 'auto.invalid_end_condition');
      return;
    }
    endCondition = { type: 'count', max_runs: maxRuns };
  }

  if (_autoCurrentAttachments.some((a) => a && a.status === 'uploading')) {
    await blockSave('attachment_uploading', 'chat.attach_still_uploading');
    return;
  }

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
      ...(messageParts
        ? { message_parts: messageParts }
        : (_autoEditingTaskId ? { message_parts: null } : {})),
      schedule,
      ...(endCondition
        ? { end_condition: endCondition }
        : (_autoEditingTaskId ? { end_condition: null } : {})),
      title: titleInput ? _autoNormaliseTitle(titleInput.value) : '',
      enabled: enabledInput ? !!enabledInput.checked : true,
      ...(isUpdate && _autoRunDeviceSel && _autoRunDeviceSel.getValue() === 'current'
        ? { run_on_current_device: true }
        : {}),
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
    try {
      if (_autoEditingTaskId) {
        res = await window.orkas.invoke('autoTasks.update', {
          taskId: _autoEditingTaskId,
          updates: payload,
        });
      } else {
        res = await window.orkas.invoke('autoTasks.create', payload);
      }
    } catch (err) {
      const failure = _autoResultFailure(err, 'invoke_failed', 'ipc');
      trackSaveResult('failure', failure);
      _autoLogFailure(isUpdate ? 'auto_task_update' : 'auto_task_create', failure);
      await uiAlert(t('auto.save_failed', { reason: (err && err.message) || err }));
      return;
    }
    if (!res || !res.task) {
      const fallback = isUpdate ? 'update_failed' : 'create_failed';
      const failure = _autoResultFailure(res && res.error, fallback, 'api');
      trackSaveResult('failure', failure);
      _autoLogFailure(isUpdate ? 'auto_task_update' : 'auto_task_create', failure);
      await uiAlert(t('auto.save_failed', { reason: (res && res.error) || '' }));
      return;
    }
    const savedTask = res.task;
    trackSaveResult('success');
    const savedCb = _autoOnSaved;
    try { _hideAutoDialog(); } catch (err) { _autoLog.warn('close after automation save failed', err); }
    try { _autoResetForm(); } catch (err) { _autoLog.warn('reset after automation save failed', err); }
    try { await loadAutoList(true); } catch (err) { _autoLog.warn('refresh after automation save failed', err); }
    // Fire the project-detail refresh hook + the caller's onSaved callback.
    if (typeof _projectDetailPid !== 'undefined' && _projectDetailPid && projectId
        && _projectDetailPid === projectId
        && typeof loadProjectAutoList === 'function') {
      try { Promise.resolve(loadProjectAutoList(_projectDetailPid)).catch(() => {}); } catch (_) {}
    }
    if (typeof savedCb === 'function') {
      try { savedCb(savedTask); } catch (_) { /* ignore */ }
    }
  } catch (err) {
    if (!terminalRecorded) {
      const fallback = isUpdate ? 'update_failed' : 'create_failed';
      const failure = _autoResultFailure(err, fallback, 'operation');
      trackSaveResult('failure', failure);
      _autoLogFailure(isUpdate ? 'auto_task_update' : 'auto_task_create', failure);
      await uiAlert(t('auto.save_failed', { reason: (err && err.message) || err }));
    } else {
      _autoLog.warn('presentation after automation save failed', err);
    }
  } finally {
    submitBtn.disabled = false;
  }
}

// ─── Exports + boot wiring ───────────────────────────────────────────────

if (typeof window !== 'undefined') {
  window.loadAutoList = loadAutoList;
  window.refreshAutoProjectGroups = _autoRenderList;
  window.loadProjectAutoList = loadProjectAutoList;
  window.openAutoTaskDialog = openAutoTaskDialog;
  window.openAutoTaskById = async function openAutoTaskById(taskId) {
    const id = String(taskId || '').trim();
    if (!id) return false;
    await loadAutoList(true);
    const task = _autoTasks.find((candidate) => candidate && candidate.id === id);
    if (!task) return false;
    openAutoTaskDialog({ task });
    return true;
  };
  window.refreshAutoProjectOptions = _autoRefreshProjectOptions;
  window._autoUploadFilesFromComposer = _autoUploadFiles;
  window._autoAttachLibraryFile = _autoAttachLibraryFile;
  const bindAutoAddButton = () => {
    const addBtn = document.getElementById('auto-add-btn');
    if (addBtn && addBtn.dataset.bound !== '1') {
      addBtn.dataset.bound = '1';
      addBtn.addEventListener('click', () => openAutoTaskDialog({}));
    }
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bindAutoAddButton, { once: true });
  else bindAutoAddButton();
  window.addEventListener('i18n-change', () => {
    _autoRenderList();
    if (typeof _projectDetailPid !== 'undefined' && _projectDetailPid) {
      loadProjectAutoList(_projectDetailPid).catch(() => {});
    }
  });
}

if (typeof module !== 'undefined' && typeof module.exports === 'object') {
  module.exports = {
    _autoGroupTasks,
    _autoDisplayDeviceName,
    _autoIsTaskOnCurrentDevice,
    _autoCanTransferTaskToCurrentDevice,
    _autoRunDeviceOptions,
    _autoTaskMessagePreviewHtml,
    _autoComposerValueForTask,
    _autoLocalDateParts,
    _autoCalendarCells,
    _autoCalendarShiftDate,
    _autoCalendarShiftMonth,
  };
}
