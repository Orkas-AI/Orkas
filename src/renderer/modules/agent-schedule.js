// ─── Scheduled tasks dialog ──────────────────────────────────────────────
// Opens from the agent card ⋯ menu's "Scheduled tasks" item. Reads / writes
// scheduled task entries via `window.orkas.invoke('scheduledTasks.*')`;
// each fire is dispatched in the main process by features/scheduled_tasks.ts
// through the same bus entry point as a manual `useAgent` call (a fresh
// conversation + `@<agent> <default input>` enqueue) so the UX is identical.
//
// Reuses .modal-overlay / .modal / .form-row / .btn chrome (CLAUDE.md §7)
// + _aiSelectMount for the schedule-type dropdown (matches settings page).

const _scheduleLog = (typeof createLogger === 'function')
  ? createLogger('agent-schedule')
  : { info() {}, warn() {}, error() {} };

const _WEEKDAY_KEYS = ['0', '1', '2', '3', '4', '5', '6'];

function _scheduleTypeOptions() {
  return [
    { value: 'interval', label: t('agents.schedule.type_interval') },
    { value: 'daily',    label: t('agents.schedule.type_daily') },
    { value: 'weekly',   label: t('agents.schedule.type_weekly') },
  ];
}

function _padHM(n) { return String(Math.max(0, Math.min(59, Number(n) | 0))).padStart(2, '0'); }

function _hmToStr(h, m) { return _padHM(h) + ':' + _padHM(m); }

function _strToHM(s) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(s || '').trim());
  if (!m) return null;
  const h = parseInt(m[1], 10);
  const min = parseInt(m[2], 10);
  if (!Number.isInteger(h) || h < 0 || h > 23) return null;
  if (!Number.isInteger(min) || min < 0 || min > 59) return null;
  return { hour: h, minute: min };
}

function _formatSummary(task) {
  const s = task.schedule || {};
  if (s.type === 'interval') {
    return t('agents.schedule.summary_interval', { minutes: s.minutes });
  }
  if (s.type === 'daily') {
    return t('agents.schedule.summary_daily', { time: _hmToStr(s.hour, s.minute) });
  }
  if (s.type === 'weekly') {
    const labels = (s.weekdays || [])
      .slice()
      .sort((a, b) => a - b)
      .map((d) => t('agents.schedule.weekday.' + d))
      .join('/');
    return t('agents.schedule.summary_weekly', { days: labels, time: _hmToStr(s.hour, s.minute) });
  }
  return '';
}

function _formatLastRun(iso) {
  if (!iso) return t('agents.schedule.never_run');
  let when;
  if (typeof formatIsoForList === 'function') {
    when = formatIsoForList(iso);
  } else {
    try { when = new Date(iso).toLocaleString(); }
    catch { when = String(iso).slice(0, 16).replace('T', ' '); }
  }
  return t('agents.schedule.last_run', { when });
}

function _defaultSchedule() {
  return { type: 'interval', minutes: 60 };
}

// Open the dialog for a single agent. Returns a promise that resolves
// when the dialog closes (no value).
async function openAgentScheduleDialog(agentId) {
  if (!agentId) return;
  // Resolve agent name for the dialog title.
  let agentName = agentId;
  try {
    if (typeof _agentsCache !== 'undefined' && Array.isArray(_agentsCache)) {
      const a = _agentsCache.find((x) => x && x.agent_id === agentId);
      if (a && a.name) agentName = a.name;
    }
  } catch (_) { /* best-effort */ }

  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay ui-dialog-overlay open';
  overlay.innerHTML = `
    <div class="modal ui-dialog agent-schedule-dialog" role="dialog" aria-modal="true">
      <div class="ui-dialog-title agent-schedule-title"></div>
      <div class="agent-schedule-body">
        <div class="agent-schedule-list"></div>
        <div class="agent-schedule-form" hidden></div>
        <div class="agent-schedule-actions-row">
          <button type="button" class="btn btn-primary" data-act="add"></button>
        </div>
      </div>
      <div class="modal-actions">
        <button type="button" class="btn" data-act="close"></button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);

  const titleEl = overlay.querySelector('.agent-schedule-title');
  const listEl  = overlay.querySelector('.agent-schedule-list');
  const formEl  = overlay.querySelector('.agent-schedule-form');
  const addBtn  = overlay.querySelector('[data-act="add"]');
  const closeBtn = overlay.querySelector('[data-act="close"]');

  const applyLabels = () => {
    titleEl.textContent = t('agents.schedule.dialog_title', { name: agentName });
    addBtn.textContent = t('agents.schedule.add_btn');
    closeBtn.textContent = t('agents.schedule.close_btn');
  };
  applyLabels();
  window.addEventListener('i18n-change', applyLabels);

  let tasks = [];
  let editingId = null; // task id being edited; 'new' = add-new form open

  // ── Fetch + render ─────────────────────────────────────────────────────
  const fetchTasks = async () => {
    try {
      const res = await window.orkas.invoke('scheduledTasks.list', { agentId });
      tasks = (res && res.ok && Array.isArray(res.tasks)) ? res.tasks : [];
    } catch (err) {
      tasks = [];
      _scheduleLog.warn('list failed', err);
      await uiAlert(t('agents.schedule.load_failed', { reason: (err && err.message) || err }));
    }
  };

  const renderList = () => {
    listEl.innerHTML = '';
    if (!tasks.length) {
      const empty = document.createElement('div');
      empty.className = 'empty agent-schedule-empty';
      empty.textContent = t('agents.schedule.empty');
      listEl.appendChild(empty);
      return;
    }
    for (const task of tasks) {
      listEl.appendChild(renderTaskRow(task));
    }
  };

  const renderTaskRow = (task) => {
    const row = document.createElement('div');
    row.className = 'agent-schedule-row' + (task.enabled ? '' : ' is-disabled');
    row.dataset.taskId = task.id;
    const summary = escapeHtml(_formatSummary(task));
    const title = escapeHtml(task.title || '');
    const lastRun = escapeHtml(_formatLastRun(task.last_run_at));
    const inputPreview = (task.default_input || '').slice(0, 80);
    const inputHtml = inputPreview
      ? `<div class="agent-schedule-row-input">${escapeHtml(inputPreview)}${task.default_input.length > 80 ? '…' : ''}</div>`
      : '';
    row.innerHTML = `
      <div class="agent-schedule-row-head">
        <label class="agent-schedule-row-toggle" title="${escapeHtml(t('agents.schedule.enabled_label'))}">
          <input type="checkbox" data-act="toggle" ${task.enabled ? 'checked' : ''} />
        </label>
        <div class="agent-schedule-row-meta">
          <div class="agent-schedule-row-summary">${summary}</div>
          ${title ? `<div class="agent-schedule-row-title">${title}</div>` : ''}
          <div class="agent-schedule-row-lastrun muted">${lastRun}</div>
        </div>
        <div class="agent-schedule-row-actions">
          <button type="button" class="btn btn-sm" data-act="edit">${escapeHtml(t('agents.schedule.edit_btn'))}</button>
          <button type="button" class="btn btn-sm btn-danger" data-act="delete">${escapeHtml(t('agents.schedule.delete_btn'))}</button>
        </div>
      </div>
      ${inputHtml}
    `;
    row.querySelector('[data-act="toggle"]').addEventListener('change', async (e) => {
      const next = !!e.target.checked;
      try {
        const res = await window.orkas.invoke('scheduledTasks.setEnabled', {
          taskId: task.id, enabled: next,
        });
        if (res && res.ok) {
          task.enabled = next;
          row.classList.toggle('is-disabled', !next);
        }
      } catch (err) {
        _scheduleLog.warn('toggle failed', err);
        e.target.checked = !next; // revert
      }
    });
    row.querySelector('[data-act="edit"]').addEventListener('click', () => {
      openForm(task.id);
    });
    row.querySelector('[data-act="delete"]').addEventListener('click', async () => {
      if (!(await uiConfirm(t('agents.schedule.delete_confirm')))) return;
      try {
        const res = await window.orkas.invoke('scheduledTasks.delete', { taskId: task.id });
        if (res && res.ok) {
          tasks = tasks.filter((tt) => tt.id !== task.id);
          renderList();
        }
      } catch (err) {
        await uiAlert(t('agents.schedule.delete_failed', { reason: (err && err.message) || err }));
      }
    });
    return row;
  };

  // ── Inline form (add / edit) ───────────────────────────────────────────
  const openForm = (idOrNew) => {
    editingId = idOrNew;
    const existing = idOrNew === 'new' ? null : tasks.find((tt) => tt.id === idOrNew);
    formEl.hidden = false;
    addBtn.disabled = true;
    renderForm(existing);
  };

  const closeForm = () => {
    editingId = null;
    formEl.hidden = true;
    formEl.innerHTML = '';
    addBtn.disabled = false;
  };

  const renderForm = (existing) => {
    const sched = (existing && existing.schedule) || _defaultSchedule();
    const enabledInitial = existing ? !!existing.enabled : true;
    const defaultInputInit = (existing && typeof existing.default_input === 'string') ? existing.default_input : '';
    const titleInit = (existing && typeof existing.title === 'string') ? existing.title : '';

    formEl.innerHTML = `
      <div class="form-row">
        <label data-i18n="agents.schedule.type_label"></label>
        <div class="agent-schedule-type-select"></div>
      </div>

      <div class="form-row agent-schedule-row-interval" hidden>
        <label data-i18n="agents.schedule.interval_label"></label>
        <div class="agent-schedule-interval-controls">
          <input type="number" class="agent-schedule-interval-input" min="1" max="43200" step="1" />
          <span class="form-hint" data-i18n="agents.schedule.interval_unit"></span>
        </div>
      </div>

      <div class="form-row agent-schedule-row-weekdays" hidden>
        <label data-i18n="agents.schedule.weekdays_label"></label>
        <div class="agent-schedule-weekdays"></div>
      </div>

      <div class="form-row agent-schedule-row-time" hidden>
        <label data-i18n="agents.schedule.time_label"></label>
        <input type="time" class="agent-schedule-time-input" />
      </div>

      <div class="form-row">
        <label data-i18n="agents.schedule.title_label"></label>
        <input type="text" class="agent-schedule-title-input" maxlength="80" />
      </div>

      <div class="form-row">
        <label data-i18n="agents.schedule.default_input_label"></label>
        <textarea class="agent-schedule-input-textarea" rows="3" maxlength="4000"></textarea>
      </div>

      <div class="form-row">
        <label class="agent-schedule-enabled-label">
          <input type="checkbox" class="agent-schedule-enabled-input" />
          <span data-i18n="agents.schedule.enabled_label"></span>
        </label>
      </div>

      <div class="modal-actions">
        <button type="button" class="btn" data-act="form-cancel"></button>
        <button type="button" class="btn btn-primary" data-act="form-save"></button>
      </div>
    `;
    if (typeof applyDomI18n === 'function') applyDomI18n(formEl);

    const intervalRow = formEl.querySelector('.agent-schedule-row-interval');
    const weekdaysRow = formEl.querySelector('.agent-schedule-row-weekdays');
    const timeRow     = formEl.querySelector('.agent-schedule-row-time');
    const intervalInput = formEl.querySelector('.agent-schedule-interval-input');
    const timeInput     = formEl.querySelector('.agent-schedule-time-input');
    const titleInput    = formEl.querySelector('.agent-schedule-title-input');
    const inputTextarea = formEl.querySelector('.agent-schedule-input-textarea');
    const enabledInput  = formEl.querySelector('.agent-schedule-enabled-input');
    const weekdaysWrap  = formEl.querySelector('.agent-schedule-weekdays');
    const cancelBtn     = formEl.querySelector('[data-act="form-cancel"]');
    const saveBtn       = formEl.querySelector('[data-act="form-save"]');

    cancelBtn.textContent = t('agents.schedule.cancel_btn');
    saveBtn.textContent   = t('agents.schedule.save_btn');
    titleInput.placeholder = t('agents.schedule.title_placeholder', { name: agentName });
    inputTextarea.placeholder = t('agents.schedule.default_input_placeholder');

    // Weekday chip buttons (matches the existing chip pattern used elsewhere).
    weekdaysWrap.innerHTML = _WEEKDAY_KEYS.map((d) => `
      <button type="button" class="agent-schedule-weekday-chip" data-day="${d}">
        ${escapeHtml(t('agents.schedule.weekday.' + d))}
      </button>
    `).join('');
    const setWeekdaysChecked = (set) => {
      for (const btn of weekdaysWrap.querySelectorAll('.agent-schedule-weekday-chip')) {
        const day = Number(btn.dataset.day);
        btn.classList.toggle('is-on', set.has(day));
      }
    };
    const currentWeekdaysSet = new Set();
    for (const btn of weekdaysWrap.querySelectorAll('.agent-schedule-weekday-chip')) {
      btn.addEventListener('click', () => {
        const day = Number(btn.dataset.day);
        if (currentWeekdaysSet.has(day)) currentWeekdaysSet.delete(day);
        else currentWeekdaysSet.add(day);
        setWeekdaysChecked(currentWeekdaysSet);
      });
    }

    // Initial values.
    titleInput.value = titleInit;
    inputTextarea.value = defaultInputInit;
    enabledInput.checked = enabledInitial;
    if (sched.type === 'interval') intervalInput.value = String(sched.minutes || 60);
    else intervalInput.value = '60';
    if (sched.type === 'daily' || sched.type === 'weekly') {
      timeInput.value = _hmToStr(sched.hour, sched.minute);
    } else {
      timeInput.value = '09:00';
    }
    if (sched.type === 'weekly' && Array.isArray(sched.weekdays)) {
      for (const d of sched.weekdays) currentWeekdaysSet.add(Number(d));
      setWeekdaysChecked(currentWeekdaysSet);
    } else {
      // Default to Mon-Fri
      [1, 2, 3, 4, 5].forEach((d) => currentWeekdaysSet.add(d));
      setWeekdaysChecked(currentWeekdaysSet);
    }

    // Schedule-type select (shared widget).
    const syncTypeRows = (type) => {
      intervalRow.hidden = type !== 'interval';
      weekdaysRow.hidden = type !== 'weekly';
      timeRow.hidden = type === 'interval';
    };
    const selectMount = formEl.querySelector('.agent-schedule-type-select');
    const typeSel = _aiSelectMount(selectMount, {
      options: _scheduleTypeOptions(),
      value: sched.type,
      onChange: (next) => syncTypeRows(next),
    });
    syncTypeRows(typeSel.getValue());

    // Save handler.
    saveBtn.addEventListener('click', async () => {
      const type = typeSel.getValue();
      let schedule;
      if (type === 'interval') {
        const minutes = parseInt(intervalInput.value, 10);
        if (!Number.isFinite(minutes) || minutes < 1 || minutes > 43200) {
          await uiAlert(t('agents.schedule.invalid_interval'));
          return;
        }
        schedule = { type: 'interval', minutes };
      } else if (type === 'daily') {
        const hm = _strToHM(timeInput.value);
        if (!hm) { await uiAlert(t('agents.schedule.invalid_time')); return; }
        schedule = { type: 'daily', hour: hm.hour, minute: hm.minute };
      } else if (type === 'weekly') {
        const hm = _strToHM(timeInput.value);
        if (!hm) { await uiAlert(t('agents.schedule.invalid_time')); return; }
        const weekdays = Array.from(currentWeekdaysSet).sort((a, b) => a - b);
        if (!weekdays.length) { await uiAlert(t('agents.schedule.invalid_weekdays')); return; }
        schedule = { type: 'weekly', weekdays, hour: hm.hour, minute: hm.minute };
      } else {
        return;
      }
      saveBtn.disabled = true;
      try {
        const payload = {
          schedule,
          default_input: inputTextarea.value,
          title: titleInput.value,
          enabled: !!enabledInput.checked,
        };
        let res;
        if (editingId === 'new') {
          res = await window.orkas.invoke('scheduledTasks.create', {
            agentId, ...payload,
          });
        } else {
          res = await window.orkas.invoke('scheduledTasks.update', {
            taskId: editingId, updates: payload,
          });
        }
        if (!res || !res.ok || !res.task) {
          await uiAlert(t('agents.schedule.save_failed', { reason: (res && res.error) || '' }));
          return;
        }
        // Merge back into local cache.
        const idx = tasks.findIndex((tt) => tt.id === res.task.id);
        if (idx >= 0) tasks[idx] = res.task;
        else tasks.push(res.task);
        renderList();
        closeForm();
      } catch (err) {
        await uiAlert(t('agents.schedule.save_failed', { reason: (err && err.message) || err }));
      } finally {
        saveBtn.disabled = false;
      }
    });

    cancelBtn.addEventListener('click', () => closeForm());
  };

  // ── Wire top-level controls ────────────────────────────────────────────
  addBtn.addEventListener('click', () => openForm('new'));
  closeBtn.addEventListener('click', () => closeDialog());

  const onKey = (e) => {
    if (e.isComposing || e.keyCode === 229) return;
    if (e.key === 'Escape') {
      if (!formEl.hidden) closeForm();
      else closeDialog();
    }
  };
  const closeDialog = () => {
    document.removeEventListener('keydown', onKey, true);
    window.removeEventListener('i18n-change', applyLabels);
    overlay.remove();
  };
  document.addEventListener('keydown', onKey, true);
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) closeDialog();
  });

  // First load.
  await fetchTasks();
  renderList();
}

if (typeof window !== 'undefined') {
  window.openAgentScheduleDialog = openAgentScheduleDialog;
}

// ─── Boot-time fire subscription ─────────────────────────────────────────
// A scheduled fire creates the conv in main, so the renderer's local
// `conversations` array doesn't know about it. Subscribe once on boot to
// the long-lived `scheduledTasks.events` stream; on each `conv_created`
// event, reload the conversation list. `loadConversations` is defined by
// conversation.js (a sibling script) — guard for the function existing
// in case load order changes.

let _scheduleEventsHandle = null;

function startScheduledTaskEventsSubscription() {
  if (_scheduleEventsHandle) return;
  if (!window.orkas || typeof window.orkas.stream !== 'function') return;
  try {
    _scheduleEventsHandle = window.orkas.stream('scheduledTasks.events', {}, (ev) => {
      // Stream-handler wraps each push as { type:'event', event: <our payload> }.
      const inner = ev && ev.event;
      if (!inner || inner.type !== 'conv_created') return;
      if (typeof loadConversations === 'function') {
        loadConversations().catch((err) => _scheduleLog.warn('reload after fire failed', err));
      }
    });
    // Promise rejects on cancel — swallow so the subscription doesn't
    // surface as an unhandled error on quit.
    _scheduleEventsHandle.promise.catch(() => { /* ignore */ });
  } catch (err) {
    _scheduleLog.warn('subscribe scheduledTasks.events failed', err);
  }
}
