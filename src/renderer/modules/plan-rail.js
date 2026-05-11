/**
 * Plan rail — sticky-top visualization of `<cid>/plan.json` inside
 * #panel-conversation. Re-renders on `plan_changed` / `state_changed`
 * events from the conversation event stream (see conversation.js).
 *
 * Responsibilities:
 *   - Render every step with status icon + index + title + assignee
 *   - Show progress count `done/total` in the header
 *   - On `failed` steps (and only when state.in_flight is empty),
 *     surface retry / skip / abort actions wired to IPC
 *   - On `pending` steps with `transient_attempts > 0`, render a small
 *     `🔁 N/2` badge so users see the auto-retry in flight (otherwise the
 *     transient retry would silently look like the step is just stuck)
 *   - Click a step row → scroll chat-history to that step's `output_msg_id`
 *
 * Status icon set is FIXED — single source of truth in this file's
 * STATUS_ICON constant. Do not duplicate / template / let the LLM rewrite.
 */

const _planRailLog = createLogger('plan-rail');

// FIXED status → icon mapping. Single source of truth — no LLM input,
// no backend, no locales should ever inject a different glyph.
const STATUS_ICON = {
  pending:     '⏳',
  in_progress: '▶️',
  done:        '✅',
  failed:      '❌',
  skipped:     '⏭️',
  blocked:     '📝',
};
const TRANSIENT_BADGE_ICON = '🔁';
const MAX_TRANSIENT_RETRIES = 2; // mirrors plan_executor.ts

let _currentCid = null;
let _currentInFlight = [];
let _refreshInflight = null;  // dedup overlapping refresh requests

function _isStepActionable(step, inFlight) {
  return step.status === 'failed' && (!inFlight || inFlight.length === 0);
}

function _buildStepHtml(step) {
  const icon = STATUS_ICON[step.status] || STATUS_ICON.pending;
  const num  = `${step.index}.`;
  const title = escapeHtml(step.title || '');
  const assignee = step.assignee ? escapeHtml(step.assignee) : '';
  const transient = (step.status === 'pending' || step.status === 'in_progress')
    && Number(step.transient_attempts) > 0
    ? `<span class="plan-rail-step-transient">${TRANSIENT_BADGE_ICON} ${step.transient_attempts}/${MAX_TRANSIENT_RETRIES}</span>`
    : '';
  const meta = assignee
    ? `<div class="plan-rail-step-meta">@${assignee}</div>`
    : '';
  const reason = step.failure_reason
    ? `<div class="plan-rail-step-reason">${escapeHtml(step.failure_reason)}</div>`
    : '';
  const actions = _isStepActionable(step, _currentInFlight)
    ? `<div class="plan-rail-step-actions">
         <button type="button" class="btn btn-sm" data-action="retry" data-i18n="plan.action.retry">${escapeHtml(t('plan.action.retry') || 'Retry')}</button>
         <button type="button" class="btn btn-sm" data-action="skip"  data-i18n="plan.action.skip">${escapeHtml(t('plan.action.skip')  || 'Skip')}</button>
         <button type="button" class="btn btn-sm btn-danger" data-action="abort" data-i18n="plan.action.abort">${escapeHtml(t('plan.action.abort') || 'Abandon plan')}</button>
       </div>`
    : '';
  return `<div class="plan-rail-step is-${step.status}" data-step-index="${step.index}" ${step.output_msg_id ? `data-msg-id="${escapeHtml(step.output_msg_id)}"` : ''}>
    <div class="plan-rail-step-head">
      <span class="plan-rail-step-icon" aria-label="${step.status}">${icon}</span>
      <span class="plan-rail-step-num">${num}</span>
      <span class="plan-rail-step-title">${title}</span>
      ${transient}
    </div>
    ${meta}
    ${reason}
    ${actions}
  </div>`;
}

function _buildProgressText(plan) {
  const done = plan.steps.filter((s) => s.status === 'done' || s.status === 'skipped').length;
  return `${done}/${plan.steps.length}`;
}

function _render(plan) {
  const root = document.getElementById('plan-rail');
  const body = document.getElementById('plan-rail-body');
  const progress = document.getElementById('plan-rail-progress');
  if (!root || !body || !progress) return;
  // Mirror visibility onto the wrapper so .chat-queue can reserve left-side
  // room for the rail's pill chip (chip floats above the input bubble's
  // left shoulder; without this the queue panel's bottom-left would
  // overlap the chip — symmetric to the workspace-chip reservation on the
  // right).
  const wrap = root.closest('.chat-input-wrapper');
  if (!plan || !Array.isArray(plan.steps) || plan.steps.length === 0) {
    root.style.display = 'none';
    body.innerHTML = '';
    progress.textContent = '';
    if (wrap) wrap.classList.remove('has-plan-rail');
    return;
  }
  root.style.display = '';
  if (wrap) wrap.classList.add('has-plan-rail');
  progress.textContent = _buildProgressText(plan);
  body.innerHTML = plan.steps.map(_buildStepHtml).join('');
}

async function _fetchPlan(cid) {
  try {
    const res = await apiFetch(`/api/conversations/${encodeURIComponent(cid)}/plan`);
    if (!res.ok) return null;
    const data = await res.json();
    if (data?.ok && data.plan) return data.plan;
    return null;
  } catch (err) {
    _planRailLog.warn(`fetch plan failed cid=${cid}: ${err && err.message}`);
    return null;
  }
}

async function _doRefresh(cid) {
  if (!cid) return;
  if (cid !== _currentCid) return;  // view switched mid-fetch
  const plan = await _fetchPlan(cid);
  if (cid !== _currentCid) return;
  _render(plan);
}

// ── Public API ───────────────────────────────────────────────────────────

const PlanRail = {
  /** Bind to a cid: refresh + remember. Call from conversation view-change.
   *  Clears the rail synchronously FIRST so any stale content from the
   *  previous cid is gone before the async fetch resolves. */
  bind(cid) {
    _currentCid = cid || null;
    _currentInFlight = [];
    // Drop any pending refresh from the previous cid — its result would
    // race with this bind's fetch and could write stale content into the
    // DOM. The cid-mismatch guard inside _doRefresh covers most of it,
    // but resetting the dedup slot also lets the new refresh fire instead
    // of being coalesced into the old one.
    _refreshInflight = null;
    _render(null);
    if (!cid) return;
    PlanRail.refresh(cid);
  },

  /** Detach from any cid. Hides the rail. Call when leaving conversation view. */
  unbind() {
    _currentCid = null;
    _currentInFlight = [];
    _refreshInflight = null;
    _render(null);
  },

  /** Re-fetch + re-render. Coalesces concurrent calls for the SAME cid;
   *  bind() is responsible for clearing the slot when cid changes. */
  refresh(cid) {
    if (!cid || cid !== _currentCid) return;
    if (_refreshInflight) return _refreshInflight;
    _refreshInflight = (async () => {
      try { await _doRefresh(cid); }
      finally { _refreshInflight = null; }
    })();
    return _refreshInflight;
  },

  /** Update the in_flight snapshot used to show/hide action buttons. Called
   *  from conversation.js's `state_changed` handler. Triggers a re-render. */
  setInFlight(cid, inFlight) {
    if (cid !== _currentCid) return;
    _currentInFlight = Array.isArray(inFlight) ? inFlight.slice() : [];
    PlanRail.refresh(cid);
  },
};

// Expose on the global namespace for conversation.js to hook.
window.PlanRail = PlanRail;

// ── Action wiring ────────────────────────────────────────────────────────

document.addEventListener('click', async (ev) => {
  const root = document.getElementById('plan-rail');
  if (!root || !root.contains(ev.target)) return;

  // Whole header is the toggle. Body clicks (action buttons / step rows)
  // are not inside .plan-rail-header so they fall through to the handlers
  // further down.
  const header = ev.target.closest('.plan-rail-header');
  if (header) {
    const isCollapsed = root.classList.toggle('is-collapsed');
    const toggle = document.getElementById('plan-rail-toggle');
    if (toggle) toggle.textContent = isCollapsed ? '▴' : '▾';
    try { localStorage.setItem(`plan-rail-collapsed-${_currentCid}`, isCollapsed ? '1' : '0'); }
    catch { /* ignore */ }
    return;
  }

  // Action buttons.
  const btn = ev.target.closest('[data-action]');
  if (btn) {
    ev.stopPropagation();
    const stepEl = btn.closest('[data-step-index]');
    const stepIndex = stepEl ? Number(stepEl.dataset.stepIndex) : NaN;
    const cid = _currentCid;
    if (!cid || !Number.isFinite(stepIndex)) return;
    const action = btn.dataset.action;
    if (action === 'retry') {
      try {
        const res = await apiFetch(
          `/api/conversations/${encodeURIComponent(cid)}/plan/steps/${stepIndex}/retry`,
          { method: 'POST' },
        );
        const data = await res.json().catch(() => ({}));
        if (!data?.ok) {
          uiAlert(t('plan.error.retry_failed', { reason: data?.error || 'unknown' }) || `Retry failed: ${data?.error || 'unknown'}`);
        }
      } catch (err) {
        uiAlert(t('plan.error.retry_failed', { reason: err && err.message }) || `Retry failed: ${err && err.message}`);
      }
      return;
    }
    if (action === 'skip') {
      const ok = await uiConfirm(t('plan.confirm.skip') || 'Skip this step?');
      if (!ok) return;
      try {
        const res = await apiFetch(
          `/api/conversations/${encodeURIComponent(cid)}/plan/steps/${stepIndex}/skip`,
          { method: 'POST' },
        );
        const data = await res.json().catch(() => ({}));
        if (!data?.ok) {
          uiAlert(t('plan.error.skip_failed', { reason: data?.error || 'unknown' }) || `Skip failed: ${data?.error || 'unknown'}`);
        }
      } catch (err) {
        uiAlert(t('plan.error.skip_failed', { reason: err && err.message }) || `Skip failed: ${err && err.message}`);
      }
      return;
    }
    if (action === 'abort') {
      const ok = await uiConfirm(t('plan.confirm.abort') || 'Abandon the entire plan?');
      if (!ok) return;
      try {
        await apiFetch(
          `/api/conversations/${encodeURIComponent(cid)}/abort`,
          { method: 'POST' },
        );
      } catch (err) {
        uiAlert(t('plan.error.abort_failed', { reason: err && err.message }) || `Abort failed: ${err && err.message}`);
      }
      return;
    }
    return;
  }

  // Click step row → scroll chat-history to its output_msg_id.
  const stepEl = ev.target.closest('[data-step-index]');
  if (stepEl && stepEl.dataset.msgId) {
    const target = document.querySelector(`[data-msg-id="${CSS.escape(stepEl.dataset.msgId)}"]`);
    if (target && typeof target.scrollIntoView === 'function') {
      target.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  }
});

// Restore collapsed state when binding a cid. Default is collapsed (the
// floating chip UX assumes the panel is opened on demand). localStorage
// only flips that when the user explicitly opened it last visit.
const _origBind = PlanRail.bind;
PlanRail.bind = function (cid) {
  _origBind.call(PlanRail, cid);
  const root = document.getElementById('plan-rail');
  const toggle = document.getElementById('plan-rail-toggle');
  if (!root || !toggle || !cid) return;
  let collapsed = true;
  try {
    const stored = localStorage.getItem(`plan-rail-collapsed-${cid}`);
    if (stored === '0') collapsed = false;
  } catch { /* ignore */ }
  root.classList.toggle('is-collapsed', collapsed);
  toggle.textContent = collapsed ? '▴' : '▾';
};
