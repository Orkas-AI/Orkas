// Conversation task board — agent groups and queued-message controls.
//
// Mirrors the main-process conversation task board (group_chat/task_board.ts)
// through `task_created` / `task_state` bus events plus a one-shot `/tasks`
// list fetch per conversation. The bar normally surfaces only while a SECOND
// live task exists; lone queued/blocked rows remain visible because they own
// the task trace or recovery controls (PC/docs/plans/conversation-task-board.md
// §3/§4.9). Every status shown here is host-driven — this module never invents
// or predicts a transition.
//
// Reuses the `.chat-queue*` style family (the renderer's existing queued-work
// panel look) rather than adding a near-duplicate style set.

const _taskBoardTasks = new Map();       // cid → Map(task_id → task snapshot)
const _taskBoardLoaded = new Set();      // cids with a completed list fetch
const _taskBoardLoading = new Set();
const _taskBoardMemberNames = new Map(); // cid → Map(actor id → display name)
// The roster write is asynchronous to task publication, so a newly assigned
// task can reach the renderer before its conversation-member name. Keep the
// enabled Agent catalog only as a display-name fallback for that window.
let _taskBoardAllAgents = []; // [{id, name}]

function _taskBoardMapFor(cid) {
  let m = _taskBoardTasks.get(cid);
  if (!m) { m = new Map(); _taskBoardTasks.set(cid, m); }
  return m;
}

// Live rows in display order: running work first, then input-blocked, then
// queued. Queued rows follow their explicit scan position (`order`, P4
// reorder) before creation time, so the panel shows the real admission scan
// order. Terminal rows do not count as live; the current batch may add them
// back while the board is visible. Pure function (renderer tests extract it).
function _taskBoardLiveRows(tasks) {
  const rank = { running: 0, waiting_input: 1, blocked: 2, queued: 3 };
  return (Array.isArray(tasks) ? tasks : [])
    .filter((t) => t
      && !t.absorbed_into_turn_id
      && Object.prototype.hasOwnProperty.call(rank, t.status))
    .sort((a, b) => (rank[a.status] - rank[b.status])
      || ((Number.isFinite(a.order) ? a.order : Infinity) - (Number.isFinite(b.order) ? b.order : Infinity))
      || String(a.created_at || '').localeCompare(String(b.created_at || '')));
}

// Group by the actual recipient id, not display name or dispatch parent.
// Input order preserves status/scan order within each agent's section.
function _taskBoardAgentGroups(rows) {
  const groups = new Map();
  for (const task of (Array.isArray(rows) ? rows : [])) {
    let group = groups.get(task.assignee);
    if (!group) {
      group = { assignee: task.assignee, tasks: [] };
      groups.set(task.assignee, group);
    }
    group.tasks.push(task);
  }
  return [...groups.values()];
}

// Translate a drop edge into the existing before-task IPC contract. Both
// endpoints must still be queued for the same agent; null means no move.
function _taskBoardDropOrder(tasks, taskId, targetId, afterTarget) {
  const queued = _taskBoardLiveRows(tasks).filter((task) => task.status === 'queued');
  const source = queued.find((task) => task.task_id === taskId);
  const target = queued.find((task) => task.task_id === targetId);
  if (!source || !target || source === target || source.assignee !== target.assignee) return null;
  const peers = queued.filter((task) => task.assignee === source.assignee);
  const rest = peers.filter((task) => task.task_id !== taskId);
  const index = rest.findIndex((task) => task.task_id === targetId) + (afterTarget ? 1 : 0);
  const beforeTaskId = rest[index]?.task_id || '';
  const oldIndex = peers.findIndex((task) => task.task_id === taskId);
  if ((peers[oldIndex + 1]?.task_id || '') === beforeTaskId) return null;
  return { task_id: taskId, before_task_id: beforeTaskId };
}

// Visibility (user directive 2026-09-04, D25): the board is a multi-task
// control surface, so an ordinary single running/waiting turn must not keep
// it above the composer. A lone queued row remains visible because its user
// message is not persisted until admission (D21), and a lone blocked row
// remains visible because the board owns its run-anyway/cancel recovery.
// Initial admission is not actual waiting: the host marks newly created
// rows until its scheduler either starts them or confirms they must queue.
// Pure decision function — renderer tests extract it.
function _taskBoardVisibility(liveRows) {
  const rows = Array.isArray(liveRows) ? liveRows : [];
  const hasStandaloneControl = rows.some((task) => (
    task && (task.status === 'blocked'
      || (task.status === 'queued' && task.admission_pending !== true))
  ));
  return { visible: rows.length >= 2 || hasStandaloneControl };
}

// Latest-batch display retains failed/stopped outcomes alongside live work;
// completed and cancelled messages leave the panel. It retracts once only
// an ordinary single running/waiting task (or no live work) remains. A batch
// resets when a task is created while every tracked task is already terminal.
// Seed/resync unions live disk rows in without wiping batch terminals.
const _taskBoardBatchIds = new Map();     // cid → Set(task_id)
const _taskBoardCollapsedCids = new Set(); // cids the user collapsed
const _taskBoardCollapsedAgents = new Map(); // cid → Set(assignee); groups start expanded
const _taskBoardSendingNow = new Set();    // `${cid}:${task_id}` awaiting live-turn acknowledgement

function _taskBoardBatchAfterCreate(batchIds, tasksById, createdId) {
  const ids = batchIds instanceof Set ? batchIds : new Set();
  let allTerminal = true;
  for (const id of ids) {
    const t = tasksById.get(id);
    if (t && !_TASK_BOARD_TERMINAL.has(t.status)) { allTerminal = false; break; }
  }
  const next = allTerminal ? new Set() : new Set(ids);
  next.add(createdId);
  return next;
}

// Keep the batch's failed/stopped outcomes first (in creation order), then
// the live block in its admission order (running >
// waiting > blocked > queued — that block's order is the reorder contract).
function _taskBoardDisplayRows(tasks, batchIds) {
  const live = _taskBoardLiveRows(tasks);
  const ids = batchIds instanceof Set ? batchIds : new Set();
  const terminals = (Array.isArray(tasks) ? tasks : [])
    .filter((t) => t
      && t.task_id
      && !t.absorbed_into_turn_id
      && _TASK_BOARD_TERMINAL.has(t.status)
      && t.status !== 'cancelled'
      && t.status !== 'done'
      && ids.has(t.task_id))
    .sort((a, b) => String(a.created_at || '').localeCompare(String(b.created_at || '')))
    .slice(-20);
  return [...terminals, ...live];
}

// Seed/resync merge rule (pure — renderer tests extract it): a task that is
// TERMINAL on disk always overwrites the in-memory snapshot. Terminal states
// are absorbing (nothing transitions out of done/stopped/failed/cancelled; the board
// persists before the event fires), so the disk row can never be staler than
// a live-looking cached one. Initial admission also settles only once, so
// a confirmed queue/start can replace that initial snapshot after a missed
// event. Other non-terminal rows only fill gaps: a concurrent bus event may
// already have written a fresher running/waiting snapshot.
const _TASK_BOARD_TERMINAL = new Set(['done', 'stopped', 'failed', 'cancelled']);
function _taskBoardMergeSeedRows(map, rows) {
  for (const task of (Array.isArray(rows) ? rows : [])) {
    if (!task || !task.task_id) continue;
    const cached = map.get(task.task_id);
    const admissionSettled = cached?.status === 'queued'
      && cached.admission_pending === true && task.admission_pending !== true;
    if (_TASK_BOARD_TERMINAL.has(task.status) || !cached || admissionSettled) {
      map.set(task.task_id, task);
    }
  }
}

// Re-seed the board from disk. Called when a group events stream (re)opens
// and after an abort settles: a terminal `task_state` emitted while no
// stream was attached is gone for good, and the once-per-conversation seed
// never re-reads — without this a cancelled task stayed painted "running"
// with a dead Stop button (observed on-device 2026-08-23: the Stop click
// tore the stream down milliseconds before the abort settled the task).
function _taskBoardResync(cid) {
  if (!cid) return;
  _taskBoardLoaded.delete(cid);
  void _taskBoardSync(cid);
}

function _taskBoardOnEvent(cid, evData) {
  const task = evData && evData.task;
  if (!cid || !task || !task.task_id) return;
  const m = _taskBoardMapFor(cid);
  const cached = m.get(task.task_id);
  // The primary send stream, observer stream and list resync can overlap.
  // A delayed snapshot must not undo a settled lifecycle fact: terminal
  // tasks never revive, initial admission settles once, and a started task
  // never returns to queued/blocked (form resume goes straight to running).
  // Otherwise a stale row can briefly invent concurrent or waiting work.
  if (cached && (
    (_TASK_BOARD_TERMINAL.has(cached.status) && !_TASK_BOARD_TERMINAL.has(task.status))
    || (task.admission_pending === true && cached.admission_pending !== true)
    || ((task.status === 'queued' || task.status === 'blocked')
      && (cached.status === 'running' || cached.status === 'waiting_input'))
  )) return;
  // A task id this board has never seen starts (or joins) the current batch;
  // if everything tracked is already terminal, the new task opens a FRESH
  // batch and the previous run's terminal rows leave the active board view.
  if (!m.has(task.task_id)) {
    _taskBoardBatchIds.set(cid, _taskBoardBatchAfterCreate(_taskBoardBatchIds.get(cid), m, task.task_id));
  }
  m.set(task.task_id, task);
  if (task.status !== 'queued' || task.absorbed_into_turn_id) {
    _taskBoardSendingNow.delete(`${cid}:${task.task_id}`);
  }
  if (typeof currentCid !== 'undefined' && cid === currentCid) _taskBoardRender(cid);
}

// Ensure the board is seeded from disk once per conversation, then render.
// Called from the runtime-state render hook, so a renderer reload mid-queue
// restores the live board without waiting for the next task event.
async function _taskBoardSync(cid) {
  if (!cid) { _taskBoardRender(cid); return; }
  if (!_taskBoardLoaded.has(cid) && !_taskBoardLoading.has(cid)) {
    _taskBoardLoading.add(cid);
    try {
      const [tasksRes, membersRes, agentsRes] = await Promise.all([
        apiFetch(`/api/conversations/${encodeURIComponent(cid)}/tasks`),
        apiFetch(`/api/conversations/${encodeURIComponent(cid)}/members`),
        apiFetch('/api/agents/list?summary=1'),
      ]);
      const tasksData = await tasksRes.json();
      if (tasksData && tasksData.ok && Array.isArray(tasksData.tasks)) {
        const m = _taskBoardMapFor(cid);
        _taskBoardMergeSeedRows(m, tasksData.tasks);
        // Batch after seed/resync: keep whatever this session already tracks
        // (so a mid-batch resync doesn't drop its finished rows) and add every
        // live disk row; historical terminals stay off the active board view.
        const batch = new Set(_taskBoardBatchIds.get(cid) || []);
        for (const t of m.values()) {
          if (t && t.task_id && !_TASK_BOARD_TERMINAL.has(t.status)) batch.add(t.task_id);
        }
        _taskBoardBatchIds.set(cid, batch);
      }
      const membersData = await membersRes.json();
      if (membersData && Array.isArray(membersData.actors)) {
        const names = new Map();
        for (const actor of membersData.actors) {
          if (actor && actor.id && actor.name) names.set(actor.id, actor.name);
        }
        _taskBoardMemberNames.set(cid, names);
      }
      const agentsData = await agentsRes.json();
      const agentRows = agentsData && (Array.isArray(agentsData.agents) ? agentsData.agents : Array.isArray(agentsData) ? agentsData : null);
      if (agentRows) {
        _taskBoardAllAgents = agentRows
          .filter((a) => a && a.agent_id && a.enabled !== false)
          .map((a) => ({ id: a.agent_id, name: a.name || a.agent_id }));
      }
      _taskBoardLoaded.add(cid);
    } catch (_) {
      // Transient IPC failure — the next runtime-state render retries.
    } finally {
      _taskBoardLoading.delete(cid);
    }
  }
  _taskBoardRender(cid);
}

function _taskBoardAssigneeLabel(cid, task) {
  if (!task) return '';
  if (task.assignee === 'commander') return t('chat.recipient_commander');
  const names = _taskBoardMemberNames.get(cid);
  const member = names && names.get(task.assignee);
  if (member) return member;
  const agent = _taskBoardAllAgents.find((a) => a.id === task.assignee);
  return (agent && agent.name) || task.assignee;
}

function _taskBoardStatusLabel(status) {
  switch (status) {
    case 'running': return t('chat.task_status_running');
    case 'queued': return t('chat.task_status_queued');
    case 'waiting_input': return t('chat.task_status_waiting_input');
    case 'blocked': return t('chat.task_status_blocked');
    case 'done': return t('chat.task_status_done');
    case 'stopped': return t('chat.task_status_stopped');
    case 'failed': return t('chat.task_status_failed');
    case 'cancelled': return t('chat.task_status_cancelled');
    default: return String(status || '');
  }
}

// Send now is meaningful only for a user-authored queued task whose exact
// assignee currently exposes a live-turn ingress. Commander-created child
// contracts intentionally remain cancel-only.
function _taskBoardCanSendNow(cid, task) {
  if (!cid || !task || task.status !== 'queued' || task.created_by !== 'user') return false;
  if (task.after) return false; // chained starts stay ordered (§4.8)
  if (typeof _latestActiveTurns === 'undefined') return false;
  const turns = _latestActiveTurns.get(cid);
  return Array.isArray(turns) && turns.some((turn) => (
    turn
    && turn.steerable === true
    && String(turn.actor || '') === String(task.assignee || '')
  ));
}

// One-time header wiring: while the board is visible, its header toggles the
// row list for the CURRENT conversation. Chevron + counts stay visible.
function _taskBoardWireHeader(panel) {
  const header = panel.querySelector('.chat-queue-header');
  if (!header || header.dataset.taskBoardToggleWired === '1') return;
  header.dataset.taskBoardToggleWired = '1';
  header.classList.add('chat-task-board-toggle');
  header.title = t('chat.task_board_toggle_title');
  header.addEventListener('click', () => {
    const cid = typeof currentCid !== 'undefined' ? currentCid : null;
    if (!cid) return;
    if (_taskBoardCollapsedCids.has(cid)) _taskBoardCollapsedCids.delete(cid);
    else _taskBoardCollapsedCids.add(cid);
    _taskBoardRender(cid);
  });
}

function _taskBoardRender(cid) {
  // The board is a per-conversation surface living in ONE shared DOM slot:
  // only the conversation the user is looking at may paint it. Background
  // conversations keep their rows in `_taskBoardTasks` and repaint when the
  // user switches in (boot.js calls TaskBoard.sync on every conversation
  // open); without this guard a background sync/event repainted the visible
  // panel with another session's tasks.
  if (cid && typeof currentCid !== 'undefined' && currentCid && cid !== currentCid) return;
  const panel = document.getElementById('chat-task-board');
  const list = document.getElementById('chat-task-board-list');
  const countEl = document.getElementById('chat-task-board-count');
  const hintEl = document.getElementById('chat-task-board-hint');
  if (!panel || !list) return;
  _taskBoardWireHeader(panel);
  _taskBoardWireDrag(list);
  // Keep the native drag source attached while runtime events update the
  // snapshots. A source that starts/sends meanwhile cancels the gesture.
  if (_taskBoardDragging) {
    if (_taskBoardDragging.cid === cid && _taskBoardCanDrag(cid, _taskBoardDragging.taskId)) return;
    _taskBoardDragging = null;
  }
  const all = cid ? [..._taskBoardMapFor(cid).values()] : [];
  const rows = _taskBoardLiveRows(all);
  const decision = _taskBoardVisibility(rows);
  if (!decision.visible) {
    panel.style.display = 'none';
    list.innerHTML = '';
    if (countEl) countEl.textContent = '0';
    return;
  }
  const running = rows.filter((t) => t.status === 'running').length;
  const queued = rows.filter((t) => t.status === 'queued').length;
  panel.style.display = '';
  // Collapse affects the visible multi-task surface only; the row list folds
  // away per conversation while the summary header remains.
  const collapsed = cid ? _taskBoardCollapsedCids.has(cid) : false;
  list.style.display = collapsed ? 'none' : '';
  const chevron = document.getElementById('chat-task-board-chevron');
  if (chevron) chevron.style.transform = collapsed ? 'rotate(-90deg)' : '';
  const displayRows = cid ? _taskBoardDisplayRows(all, _taskBoardBatchIds.get(cid)) : [];
  if (countEl) countEl.textContent = String(displayRows.length);
  if (hintEl) hintEl.textContent = t('chat.task_board_counts', { running, queued });
  if (collapsed) { list.innerHTML = ''; return; }
  const groups = _taskBoardAgentGroups(displayRows);
  // A commander row with a live dispatched child is ORCHESTRATING — its own
  // turn is suspended on the child — so the status text says that instead of
  // a second confusing "running".
  const orchestratingIds = new Set(rows.map((task) => task.parent_task_id).filter(Boolean));
  // Runtime updates replace these buttons. Restore the focused agent rather
  // than its index, which can change when another agent finishes.
  const activeToggle = document.activeElement;
  const focusedAssignee = activeToggle?.matches?.('.chat-queue-agent-toggle') && list.contains(activeToggle)
    ? activeToggle.closest('.chat-queue-agent-group')?.dataset.assignee : null;
  list.innerHTML = groups.map((group, index) => {
    const expanded = !_taskBoardCollapsedAgents.get(cid)?.has(group.assignee);
    return `
    <section class="chat-queue-agent-group" data-assignee="${escapeHtml(group.assignee)}">
      <button type="button" class="chat-queue-agent-toggle" aria-expanded="${expanded}" aria-controls="chat-task-agent-${index}">
        ${uiIconHtml('chevron-down', 'ui-icon chat-queue-agent-chevron')}
        <span class="chat-queue-agent-name">${escapeHtml(_taskBoardAssigneeLabel(cid, group.tasks[0]))}</span>
      </button>
      <div id="chat-task-agent-${index}" class="chat-queue-agent-items"${expanded ? '' : ' hidden'}>${group.tasks.map((task) => {
        const statusText = task.assignee === 'commander' && task.status === 'running' && orchestratingIds.has(task.task_id)
          ? t('chat.task_status_orchestrating')
          : _taskBoardStatusLabel(task.status);
        // Terminal rows of the current batch stay on the active board as OUTCOME
        // records — muted chip, no action buttons.
        const isTerminal = _TASK_BOARD_TERMINAL.has(task.status);
        const statusChip = `<span class="chat-queue-skill${isTerminal ? ' chat-queue-dep' : ''}">${escapeHtml(statusText)}</span>`;
        // Dispatch origin remains visible even when parent and child belong to
        // different agent sections.
        const parent = _taskBoardMapFor(cid).get(task.parent_task_id);
        const origin = parent
          ? `${_taskBoardAssigneeLabel(cid, parent)}: ${String(parent.instruction || '').replace(/\s+/g, ' ').slice(0, 160)}`
          : '';
        const dispatchedChip = task.created_by === 'commander'
          ? `<span class="chat-queue-skill chat-queue-dep" title="${escapeHtml(origin)}">${escapeHtml(t('chat.task_dispatched'))}</span>`
          : '';
        const preview = escapeHtml(String(task.instruction || '').replace(/\s+/g, ' ')).slice(0, 160);
        // Chain dependency as read-only row information (D18/D24): a queued row
        // that waits on a predecessor names it inline. The predecessor may
        // already be terminal (snapshot still in the map) during the moments
        // before this row flips running.
        let depChip = '';
        if (task.status === 'queued' && task.after) {
          const prev = _taskBoardMapFor(cid).get(task.after);
          const prevName = prev ? _taskBoardAssigneeLabel(cid, prev) : String(task.after).slice(0, 6);
          const prevPreview = prev ? String(prev.instruction || '').replace(/\s+/g, ' ').slice(0, 80) : '';
          depChip = `<span class="chat-queue-skill chat-queue-dep" title="${escapeHtml(prevPreview)}">${escapeHtml(t('chat.task_waiting_on', { name: prevName }))}</span>`;
        }
        // queued → cancel before it runs; running → stop ONLY this execution
        // (per-task abort; the header Stop remains the whole-conversation one);
        // blocked → the §4.8 user decision: run anyway or cancel.
        const sendNowKey = `${cid}:${task.task_id}`;
        const sendingNow = _taskBoardSendingNow.has(sendNowKey);
        const canSendNow = _taskBoardCanSendNow(cid, task);
        const sendNowBtn = (canSendNow || sendingNow)
          ? `<button class="chat-queue-btn" data-act="task-send-now"${sendingNow ? ' disabled' : ''}>${escapeHtml(t(sendingNow ? 'chat.queue_sending_now' : 'chat.queue_send_now'))}</button>`
          : '';
        const cancelBtn = task.status === 'queued' || task.status === 'blocked'
          ? `<button class="chat-queue-btn danger" data-act="task-cancel"${sendingNow ? ' disabled' : ''}>${escapeHtml(t('chat.task_cancel'))}</button>`
          : task.status === 'running'
            ? `<button class="chat-queue-btn danger" data-act="task-cancel">${escapeHtml(t('chat.task_stop'))}</button>`
            : '';
        const runAnywayBtn = task.status === 'blocked'
          ? `<button class="chat-queue-btn" data-act="task-run-anyway">${escapeHtml(t('chat.task_run_anyway'))}</button>`
          : '';
        const draggable = _taskBoardCanDrag(cid, task.task_id);
        return `
          <div class="chat-queue-item" draggable="${draggable}"${draggable ? ` title="${escapeHtml(t('chat.queue_drag_title'))}"` : ''} data-task-id="${escapeHtml(task.task_id)}">
            ${draggable ? `<span class="chat-queue-drag" title="${escapeHtml(t('chat.queue_drag_title'))}">${uiIconHtml('grip-vertical', 'ui-icon')}</span>` : ''}
            <div class="chat-queue-text">${statusChip}${dispatchedChip}${depChip}${preview}</div>
            <div class="chat-queue-actions">${sendNowBtn}${runAnywayBtn}${cancelBtn}</div>
          </div>
        `;
      }).join('')}</div>
    </section>
  `;
  }).join('');
  list.querySelectorAll('.chat-queue-agent-toggle').forEach((button) => {
    button.addEventListener('click', () => {
      const group = button.closest('.chat-queue-agent-group');
      let collapsedAgents = _taskBoardCollapsedAgents.get(cid);
      if (!collapsedAgents) {
        collapsedAgents = new Set();
        _taskBoardCollapsedAgents.set(cid, collapsedAgents);
      }
      const expanded = button.getAttribute('aria-expanded') !== 'true';
      if (expanded) collapsedAgents.delete(group.dataset.assignee);
      else collapsedAgents.add(group.dataset.assignee);
      button.setAttribute('aria-expanded', String(expanded));
      group.querySelector('.chat-queue-agent-items').hidden = !expanded;
    });
    button.addEventListener('keydown', (event) => {
      if (event.key !== ' ' || event.isComposing) return;
      // Native Space clicks on keyup, but a task update can detach the pressed
      // button first. Activate on keydown and suppress native/repeated clicks.
      event.preventDefault();
      if (!event.repeat) button.click();
    });
    if (focusedAssignee != null && button.closest('.chat-queue-agent-group')?.dataset.assignee === focusedAssignee) {
      button.focus({ preventScroll: true });
    }
  });
  list.querySelectorAll('.chat-queue-btn[data-act="task-send-now"]').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const taskId = btn.closest('.chat-queue-item')?.dataset.taskId;
      if (taskId) _taskBoardSendNow(cid, taskId);
    });
  });
  list.querySelectorAll('.chat-queue-btn[data-act="task-cancel"]').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const taskId = btn.closest('.chat-queue-item')?.dataset.taskId;
      if (taskId) _taskBoardCancel(cid, taskId);
    });
  });
  list.querySelectorAll('.chat-queue-btn[data-act="task-run-anyway"]').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const taskId = btn.closest('.chat-queue-item')?.dataset.taskId;
      if (taskId) _taskBoardResumeBlocked(cid, taskId);
    });
  });
}

let _taskBoardDragging = null; // { cid, taskId }; never accepted from external drag data

function _taskBoardCanDrag(cid, taskId) {
  const task = _taskBoardMapFor(cid).get(taskId);
  return !!task && task.status === 'queued' && !task.absorbed_into_turn_id
    && !_taskBoardSendingNow.has(`${cid}:${taskId}`);
}

// Native drag events use the same row affordances as the legacy draft queue.
// Delegate on the stable list so queued state updates do not lose handlers.
function _taskBoardWireDrag(list) {
  if (list.dataset.taskBoardDragWired === '1') return;
  list.dataset.taskBoardDragWired = '1';
  const clearTargets = () => {
    list.querySelectorAll('.drop-target').forEach((row) => {
      row.classList.remove('drop-target');
      delete row.dataset.dropEdge;
    });
  };
  const endDrag = () => {
    const drag = _taskBoardDragging;
    _taskBoardDragging = null;
    clearTargets();
    if (drag) _taskBoardRender(drag.cid);
  };
  const dropOrder = (event) => {
    const drag = _taskBoardDragging;
    const row = event.target.closest('.chat-queue-item[data-task-id]');
    if (!drag || drag.cid !== currentCid || !row || !list.contains(row)
      || !_taskBoardCanDrag(drag.cid, drag.taskId)
      || !_taskBoardCanDrag(drag.cid, row.dataset.taskId)) return null;
    const rect = row.getBoundingClientRect();
    const after = event.clientY > rect.top + rect.height / 2;
    const order = _taskBoardDropOrder([..._taskBoardMapFor(drag.cid).values()], drag.taskId, row.dataset.taskId, after);
    return order ? { row, order, after } : null;
  };
  list.addEventListener('dragstart', (event) => {
    const row = event.target.closest('.chat-queue-item[data-task-id]');
    const cid = currentCid;
    if (!row || event.target.closest('button') || !_taskBoardCanDrag(cid, row.dataset.taskId)) {
      event.preventDefault();
      return;
    }
    _taskBoardDragging = { cid, taskId: row.dataset.taskId };
    row.classList.add('dragging');
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('application/x-orkas-task', row.dataset.taskId);
  });
  list.addEventListener('dragover', (event) => {
    clearTargets();
    const target = dropOrder(event);
    if (!target) {
      if (_taskBoardDragging) event.dataTransfer.dropEffect = 'none';
      return;
    }
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
    target.row.classList.add('drop-target');
    target.row.dataset.dropEdge = target.after ? 'after' : 'before';
  });
  list.addEventListener('dragleave', (event) => {
    if (!list.contains(event.relatedTarget)) clearTargets();
  });
  list.addEventListener('drop', (event) => {
    if (!_taskBoardDragging) return;
    event.preventDefault();
    event.stopPropagation();
    const cid = _taskBoardDragging.cid;
    const target = dropOrder(event);
    endDrag();
    if (target) void _taskBoardReorder(cid, target.order);
  });
  document.addEventListener('dragend', endDrag);
}

async function _taskBoardReorder(cid, order) {
  try {
    const res = await apiFetch(`/api/conversations/${encodeURIComponent(cid)}/tasks/reorder`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(order),
    });
    const data = await res.json();
    if (!data || !data.ok) _taskBoardResync(cid);
    // Accepted: the per-row task_state events carry the new `order` values.
  } catch (_) {
    _taskBoardResync(cid);
  }
}

async function _taskBoardResumeBlocked(cid, taskId) {
  try {
    const res = await apiFetch(`/api/conversations/${encodeURIComponent(cid)}/tasks/resume-blocked`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ task_id: taskId }),
    });
    const data = await res.json();
    if (data && data.ok) {
      const m = _taskBoardMapFor(cid);
      const task = m.get(taskId);
      // State events may beat the command acknowledgement. Only advance a
      // still-blocked snapshot; never overwrite an already running or
      // completed task with this acknowledgement's earlier queued state.
      if (task && task.status === 'blocked') m.set(taskId, { ...task, status: 'queued', after: undefined });
      _taskBoardRender(cid);
      // Run-anyway STARTS an execution from a bare invoke — no send stream is
      // attached, so the released task's task_state/turn events would have no
      // subscriber and the board kept a ghost queued row while the turn ran
      // invisibly (probe 2026-08-23). Attach the external-run observer (the
      // same hook scheduled-task fires use); its stream connect also resyncs
      // this board from disk.
      try {
        if (window.ConversationRuntime
          && typeof window.ConversationRuntime.observePlanRecoveryRun === 'function') {
          window.ConversationRuntime.observePlanRecoveryRun(cid, { attachExisting: true });
        }
      } catch (_) { /* board resync on the next stream connect still applies */ }
    }
  } catch (_) {
    // Bus events reconcile the truth on the next task_state.
  }
}

async function _taskBoardSendNow(cid, taskId) {
  const key = `${cid}:${taskId}`;
  if (_taskBoardSendingNow.has(key)) return;
  _taskBoardSendingNow.add(key);
  _taskBoardRender(cid);
  try {
    const res = await apiFetch(`/api/conversations/${encodeURIComponent(cid)}/tasks/send-now`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ task_id: taskId }),
    });
    const data = await res.json();
    if (!data || data.ok !== true) {
      throw new Error((data && data.error) || `HTTP ${res.status}`);
    }
    // Keep the row locked as "Sending" until the authoritative task_state
    // says the live runtime accepted it (absorbed marker) or it starts as the
    // ordinary FIFO fallback. Preparation/transport failure leaves it queued.
  } catch (err) {
    _taskBoardSendingNow.delete(key);
    _taskBoardRender(cid);
    try {
      uiAlert(t('chat.queue_send_now_failed', {
        msg: err && err.message ? err.message : String(err || ''),
      }));
    } catch (_) {}
  }
}

async function _taskBoardCancel(cid, taskId) {
  try {
    const res = await apiFetch(`/api/conversations/${encodeURIComponent(cid)}/tasks/cancel`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ task_id: taskId }),
    });
    const data = await res.json();
    if (data && data.ok) {
      // The authoritative `task_state` event follows through the bus stream;
      // apply locally too so the row clears even if the stream is between
      // reconnects.
      const m = _taskBoardMapFor(cid);
      const task = m.get(taskId);
      if (task) m.set(taskId, { ...task, status: 'cancelled' });
      _taskBoardRender(cid);
    }
  } catch (_) {
    // Leave the row; the user can retry, and bus events reconcile the truth.
  }
}

// Queued rows currently known for a conversation. Telemetry-facing (the
// task_stop click reports how much work was waiting behind the stopped
// execution); 0 for a conversation whose board was never observed.
function _taskBoardQueuedCount(cid) {
  const m = cid ? _taskBoardTasks.get(cid) : null;
  if (!m) return 0;
  let n = 0;
  for (const t of m.values()) { if (t && t.status === 'queued') n += 1; }
  return n;
}

window.TaskBoard = {
  onEvent: _taskBoardOnEvent,
  sync: _taskBoardSync,
  resync: _taskBoardResync,
  render: _taskBoardRender,
  queuedCount: _taskBoardQueuedCount,
};
