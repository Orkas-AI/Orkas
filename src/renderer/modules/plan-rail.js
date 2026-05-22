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
 *     retry badge so users see the auto-retry in flight (otherwise the
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
  pending:     'hourglass',
  in_progress: 'play',
  done:        'check-circle',
  failed:      'x-circle',
  skipped:     'skip-forward',
  blocked:     'document-pencil',
};
const TRANSIENT_BADGE_ICON = 'refresh';
const MAX_TRANSIENT_RETRIES = 2; // mirrors plan_executor.ts

function _planIcon(name, className) {
  if (typeof window !== 'undefined' && typeof window.uiIconHtml === 'function') return window.uiIconHtml(name, className || 'ui-icon plan-rail-svg-icon');
  return '';
}

let _currentCid = null;
let _currentInFlight = [];
let _refreshInflight = null;  // dedup overlapping refresh requests
let _refreshSeq = 0;          // invalidate stale forced refresh responses
let _lastPlan = null;
const _stepActionRequests = new Set();

function _isStepActionable(step, inFlight) {
  return step.status === 'failed' && (!inFlight || inFlight.length === 0);
}

function _stepActionKey(cid, stepIndex) {
  return `${cid || ''}:${Number(stepIndex) || 0}`;
}

function _hasStepActionRequest(step) {
  if (!_currentCid || !step) return false;
  return _stepActionRequests.has(_stepActionKey(_currentCid, step.index));
}

function _setStepActionRequest(cid, stepIndex, pending) {
  const key = _stepActionKey(cid, stepIndex);
  if (pending) _stepActionRequests.add(key);
  else _stepActionRequests.delete(key);
}

function _clearStepActionRequests(cid) {
  const prefix = `${cid || ''}:`;
  for (const key of Array.from(_stepActionRequests)) {
    if (!cid || key.startsWith(prefix)) _stepActionRequests.delete(key);
  }
}

function _pruneStepActionRequests(plan) {
  if (!_currentCid || !plan || !Array.isArray(plan.steps)) return;
  const liveSteps = new Set(
    plan.steps
      .filter(Boolean)
      .map((s) => _stepActionKey(_currentCid, s.index)),
  );
  const prefix = `${_currentCid}:`;
  for (const key of Array.from(_stepActionRequests)) {
    if (key.startsWith(prefix) && !liveSteps.has(key)) _stepActionRequests.delete(key);
  }
}

function _lockRenderedStepActions(stepEl) {
  if (!stepEl) return;
  stepEl.querySelectorAll('[data-action]').forEach((el) => {
    el.disabled = true;
    el.setAttribute('aria-disabled', 'true');
  });
}

function _applyOptimisticStepStatus(cid, stepIndex, status, patch = {}) {
  if (!cid || cid !== _currentCid || !_lastPlan || !Array.isArray(_lastPlan.steps)) return;
  const steps = _lastPlan.steps.map((step) => {
    if (!step || Number(step.index) !== Number(stepIndex)) return step;
    return { ...step, ...patch, status };
  });
  _render({ ..._lastPlan, steps });
}

function _rerenderCachedPlan() {
  if (_lastPlan) _render(_lastPlan);
}

function _beginStepAction(cid, stepIndex, stepEl, optimistic = null) {
  _setStepActionRequest(cid, stepIndex, true);
  // A recovery click changes the local interaction contract immediately:
  // any older plan fetch that resolves after this point must not repaint the
  // failed row and resurrect retry / skip / abort while the POST is in flight.
  _refreshSeq += 1;
  _refreshInflight = null;
  _lockRenderedStepActions(stepEl);
  if (optimistic && optimistic.status) {
    _applyOptimisticStepStatus(cid, stepIndex, optimistic.status, optimistic.patch || {});
  } else {
    _rerenderCachedPlan();
  }
}

async function _finishStepAction(cid, stepIndex, opts = {}) {
  const refreshPromise = PlanRail.refresh(cid, { force: true });
  if (opts.refreshInfo) _refreshConversationInfo(cid);
  if (opts.clearAfterRefresh) {
    try { await refreshPromise; }
    finally {
      _setStepActionRequest(cid, stepIndex, false);
      if (cid === _currentCid) _rerenderCachedPlan();
    }
    return;
  }
  _setStepActionRequest(cid, stepIndex, false);
  if (opts.rerender && cid === _currentCid) _rerenderCachedPlan();
}

function _refreshConversationInfo(cid) {
  if (window.ConversationInfo && typeof window.ConversationInfo.refresh === 'function') {
    window.ConversationInfo.refresh(cid, { silent: true });
  }
}

function _beginConversationRecoveryStream(cid) {
  const runtime = window.ConversationRuntime;
  if (!runtime || typeof runtime.observePlanRecoveryRun !== 'function') return null;
  try { return runtime.observePlanRecoveryRun(cid); }
  catch (_) { return null; }
}

function _cancelConversationRecoveryStream(handle) {
  try { if (handle && typeof handle.cancel === 'function') handle.cancel(); }
  catch (_) {}
}

async function _postStepAction(cid, stepIndex, action) {
  const res = await apiFetch(
    `/api/conversations/${encodeURIComponent(cid)}/plan/steps/${stepIndex}/${action}`,
    { method: 'POST' },
  );
  return res.json().catch(() => ({}));
}

function _alertStepActionFailure(action, reason) {
  const normalized = reason || 'unknown';
  if (action === 'retry') {
    uiAlert(t('plan.error.retry_failed', { reason: normalized }) || `Retry failed: ${normalized}`);
  } else if (action === 'skip') {
    uiAlert(t('plan.error.skip_failed', { reason: normalized }) || `Skip failed: ${normalized}`);
  } else if (action === 'abort') {
    uiAlert(t('plan.error.abort_failed', { reason: normalized }) || `Abort failed: ${normalized}`);
  }
}

function _formatAssigneeMeta(raw) {
  const a = (raw || '').trim();
  if (!a) return '';
  // Mirror plan.ts::formatPlanAnnouncement (commander/user are role tokens, not @-mentions).
  if (a === 'commander') return `<div class="plan-rail-step-meta">${escapeHtml(t('chat.recipient_commander'))}</div>`;
  if (a === 'user')      return `<div class="plan-rail-step-meta">${escapeHtml(t('chat.from_user'))}</div>`;
  return `<div class="plan-rail-step-meta">@${escapeHtml(a)}</div>`;
}

function _buildStepHtml(step) {
  const icon = _planIcon(STATUS_ICON[step.status] || STATUS_ICON.pending, 'ui-icon plan-rail-svg-icon');
  const num  = `${step.index}.`;
  const title = escapeHtml(step.title || '');
  // assignee literals `commander` / `user` are role tokens (commander wrote them via
  // plan_set), not real agent names — route them through i18n so a zh user sees
  // 指挥官/用户 instead of the raw English token. Agent names are user-authored single-
  // language strings (Agent spec has no name_zh/_en) and pass through verbatim with `@`.
  const meta = _formatAssigneeMeta(step.assignee);
  const transient = (step.status === 'pending' || step.status === 'in_progress')
    && Number(step.transient_attempts) > 0
    ? `<span class="plan-rail-step-transient">${_planIcon(TRANSIENT_BADGE_ICON, 'ui-icon plan-rail-transient-icon')}<span>${step.transient_attempts}/${MAX_TRANSIENT_RETRIES}</span></span>`
    : '';
  const reason = step.failure_reason
    ? `<div class="plan-rail-step-reason">${escapeHtml(step.failure_reason)}</div>`
    : '';
  const actionRequested = _hasStepActionRequest(step);
  const actions = _isStepActionable(step, _currentInFlight) && !actionRequested
    ? `<div class="plan-rail-step-actions">
         <button type="button" class="btn btn-sm" data-action="retry" data-i18n="plan.action.retry">${escapeHtml(t('plan.action.retry'))}</button>
         <button type="button" class="btn btn-sm" data-action="skip"  data-i18n="plan.action.skip">${escapeHtml(t('plan.action.skip'))}</button>
         <button type="button" class="btn btn-sm btn-danger" data-action="abort" data-i18n="plan.action.abort">${escapeHtml(t('plan.action.abort'))}</button>
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
    _lastPlan = null;
    root.style.display = 'none';
    body.innerHTML = '';
    progress.textContent = '';
    if (wrap) wrap.classList.remove('has-plan-rail');
    return;
  }
  _lastPlan = plan;
  root.style.display = '';
  if (wrap) wrap.classList.add('has-plan-rail');
  _pruneStepActionRequests(plan);
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

async function _doRefresh(cid, seq) {
  if (!cid) return;
  if (cid !== _currentCid) return;  // view switched mid-fetch
  const plan = await _fetchPlan(cid);
  if (cid !== _currentCid) return;
  if (seq !== _refreshSeq) return;
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
    _clearStepActionRequests();
    _refreshSeq += 1;
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
    _refreshSeq += 1;
    _clearStepActionRequests();
    _render(null);
  },

  /** Re-fetch + re-render. Coalesces concurrent calls for the SAME cid unless
   *  force=true, which is used after user actions so stale pre-click fetches
   *  cannot re-enable old recovery buttons. */
  refresh(cid, opts = {}) {
    if (!cid || cid !== _currentCid) return;
    if (_refreshInflight && !opts.force) return _refreshInflight;
    const seq = ++_refreshSeq;
    _refreshInflight = (async () => {
      try { await _doRefresh(cid, seq); }
      finally {
        if (seq === _refreshSeq) _refreshInflight = null;
      }
    })();
    return _refreshInflight;
  },

  /** Update the in_flight snapshot used to show/hide action buttons. Called
   *  from conversation.js's `state_changed` handler. Triggers a re-render. */
  setInFlight(cid, inFlight) {
    if (cid !== _currentCid) return;
    _currentInFlight = Array.isArray(inFlight) ? inFlight.slice() : [];
    _rerenderCachedPlan();
    PlanRail.refresh(cid);
  },
};

// Expose on the global namespace for conversation.js to hook.
window.PlanRail = PlanRail;

// Re-render on language change so commander/user labels swap zh↔en immediately (the rail
// is JS-injected HTML — applyDomI18n doesn't reach inside it). Refresh is no-op when
// unbound or when the cid switched meanwhile.
document.addEventListener('i18n-change', () => {
  if (_currentCid) PlanRail.refresh(_currentCid);
});

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
    if (btn.disabled) return;
    const stepEl = btn.closest('[data-step-index]');
    const stepIndex = stepEl ? Number(stepEl.dataset.stepIndex) : NaN;
    const cid = _currentCid;
    if (!cid || !Number.isFinite(stepIndex)) return;
    if (_stepActionRequests.has(_stepActionKey(cid, stepIndex))) return;
    const action = btn.dataset.action;
    if (action === 'retry') {
      _beginStepAction(cid, stepIndex, stepEl, {
        status: 'pending',
        patch: {
          failure_reason: '',
          output_msg_id: '',
          transient_attempts: 0,
        },
      });
      const recoveryStream = _beginConversationRecoveryStream(cid);
      let recoveryStarted = false;
      try {
        const data = await _postStepAction(cid, stepIndex, 'retry');
        if (!data?.ok) {
          _alertStepActionFailure('retry', data?.error);
          _cancelConversationRecoveryStream(recoveryStream);
        } else {
          recoveryStarted = true;
        }
      } catch (err) {
        _cancelConversationRecoveryStream(recoveryStream);
        _alertStepActionFailure('retry', err && err.message);
      } finally {
        if (!recoveryStarted) _cancelConversationRecoveryStream(recoveryStream);
        await _finishStepAction(cid, stepIndex, { refreshInfo: true, clearAfterRefresh: true });
      }
      return;
    }
    if (action === 'skip') {
      _beginStepAction(cid, stepIndex, stepEl);
      const ok = await uiConfirm(t('plan.confirm.skip'));
      if (!ok) {
        await _finishStepAction(cid, stepIndex, { rerender: true });
        return;
      }
      const recoveryStream = _beginConversationRecoveryStream(cid);
      let recoveryStarted = false;
      try {
        const data = await _postStepAction(cid, stepIndex, 'skip');
        if (!data?.ok) {
          _alertStepActionFailure('skip', data?.error);
          _cancelConversationRecoveryStream(recoveryStream);
        } else {
          recoveryStarted = true;
          _applyOptimisticStepStatus(cid, stepIndex, 'skipped');
        }
      } catch (err) {
        _cancelConversationRecoveryStream(recoveryStream);
        _alertStepActionFailure('skip', err && err.message);
      } finally {
        if (!recoveryStarted) _cancelConversationRecoveryStream(recoveryStream);
        await _finishStepAction(cid, stepIndex, { refreshInfo: true, clearAfterRefresh: true });
      }
      return;
    }
    if (action === 'abort') {
      _beginStepAction(cid, stepIndex, stepEl);
      const ok = await uiConfirm(t('plan.confirm.abort'));
      if (!ok) {
        await _finishStepAction(cid, stepIndex, { rerender: true });
        return;
      }
      try {
        await apiFetch(
          `/api/conversations/${encodeURIComponent(cid)}/abort`,
          { method: 'POST' },
        );
      } catch (err) {
        _alertStepActionFailure('abort', err && err.message);
      } finally {
        await _finishStepAction(cid, stepIndex, { refreshInfo: true, clearAfterRefresh: true });
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

// Outside-click dismiss: collapse an expanded rail when the user clicks anywhere outside it.
// Companion to the header toggle above — that handler returns early on in-rail clicks, so
// this one only ever fires when the click is somewhere else on the page. Persists the
// collapsed state so it survives view re-bind, same as a manual toggle.
document.addEventListener('click', (ev) => {
  const root = document.getElementById('plan-rail');
  if (!root || root.style.display === 'none') return;
  if (root.classList.contains('is-collapsed')) return;
  if (root.contains(ev.target)) return;
  root.classList.add('is-collapsed');
  const toggle = document.getElementById('plan-rail-toggle');
  if (toggle) toggle.textContent = '▴';
  if (_currentCid) {
    try { localStorage.setItem(`plan-rail-collapsed-${_currentCid}`, '1'); }
    catch { /* ignore */ }
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
