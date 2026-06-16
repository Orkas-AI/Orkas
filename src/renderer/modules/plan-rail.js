/**
 * Plan rail — sticky-top visualization of `<cid>/plan.json` inside
 * #panel-conversation. Re-renders on `plan_changed` / `state_changed`
 * events from the conversation event stream (see conversation.js).
 *
 * Responsibilities:
 *   - Render every step with status icon + index + title + assignee
 *   - Show progress count `done/total` in the header
 *   - Surface the unified plan-level stop / continue control supplied by
 *     the backend (step-level retry / skip actions are intentionally absent)
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
let _lastControl = null;

function _rerenderCachedPlan() {
  if (_lastPlan) _render(_lastPlan, _lastControl);
}

function _refreshConversationInfo(cid) {
  if (window.ConversationInfo && typeof window.ConversationInfo.refreshTasks === 'function') {
    window.ConversationInfo.refreshTasks(cid, { silent: true });
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

function _alertStepActionFailure(action, reason) {
  const normalized = reason || 'unknown';
  if (action === 'continue') {
    uiAlert(t('plan.error.continue_failed', { reason: normalized }) || `Continue failed: ${normalized}`);
  } else if (action === 'stop') {
    uiAlert(t('plan.error.stop_failed', { reason: normalized }) || `Stop failed: ${normalized}`);
  }
}

async function _continuePlan(cid, control = null) {
  if (!cid) return false;
  const recoveryStream = _beginConversationRecoveryStream(cid);
  let recoveryStarted = false;
  if (control) control.disabled = true;
  try {
    const res = await apiFetch(
      `/api/conversations/${encodeURIComponent(cid)}/plan/continue`,
      { method: 'POST' },
    );
    const data = await res.json().catch(() => ({}));
    if (!data?.ok) {
      _alertStepActionFailure('continue', data?.error);
      _cancelConversationRecoveryStream(recoveryStream);
      return false;
    }
    recoveryStarted = true;
    return true;
  } catch (err) {
    _cancelConversationRecoveryStream(recoveryStream);
    _alertStepActionFailure('continue', err && err.message);
    return false;
  } finally {
    if (!recoveryStarted) _cancelConversationRecoveryStream(recoveryStream);
    if (control) control.disabled = false;
    await PlanRail.refresh(cid, { force: true });
    _refreshConversationInfo(cid);
  }
}

function _formatAssigneeMeta(raw) {
  const a = (raw || '').trim();
  if (!a) return '';
  // `user` / `用户` collapse into commander semantically: a plan step asking
  // the user for input is really commander driving the interaction. The human
  // is never a worker in the orchestration model, so don't surface "@用户"
  // — mirror `conversation-info.js::_resolveAssigneeAvatar` exactly.
  if (a === 'commander' || a === 'user' || a === '用户') {
    return `<div class="plan-rail-step-meta">${escapeHtml(t('chat.recipient_commander'))}</div>`;
  }
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
  return `<div class="plan-rail-step is-${step.status}" data-step-index="${step.index}" ${step.output_msg_id ? `data-msg-id="${escapeHtml(step.output_msg_id)}"` : ''}>
    <div class="plan-rail-step-head">
      <span class="plan-rail-step-icon" aria-label="${step.status}">${icon}</span>
      <span class="plan-rail-step-num">${num}</span>
      <span class="plan-rail-step-title">${title}</span>
      ${transient}
    </div>
    ${meta}
    ${reason}
  </div>`;
}

function _buildProgressText(plan) {
  const done = plan.steps.filter((s) => s.status === 'done' || s.status === 'skipped').length;
  return `${done}/${plan.steps.length}`;
}

function _isPlanFullyComplete(plan) {
  const steps = plan && Array.isArray(plan.steps) ? plan.steps : [];
  if (!steps.length) return false;
  return steps.every((s) => s && (s.status === 'done' || s.status === 'skipped'));
}

function _hideRail(root, body, progress, bar) {
  const control = document.getElementById('plan-rail-control');
  root.style.display = 'none';
  body.innerHTML = '';
  progress.textContent = '';
  if (bar) bar.innerHTML = '';
  if (control) {
    control.hidden = true;
    control.textContent = '';
    delete control.dataset.planAction;
  }
}

// Build the segmented progress bar — one cell per step. Classes drive the
// fill per PC/docs/design/PATTERNS.md P8 (done/active = primary; queued =
// surface-3 track; failed = danger). The chip itself stays in DOM either
// way; cells are pure presentational divs with no event handlers.
function _buildBarHtml(plan) {
  if (!plan || !Array.isArray(plan.steps)) return '';
  return plan.steps.map((s) => {
    const status = String(s && s.status || 'pending');
    let cls = '';
    if (status === 'done' || status === 'skipped') cls = ' is-done';
    else if (status === 'in_progress') cls = ' is-active';
    else if (status === 'failed') cls = ' is-failed';
    else if (status === 'blocked') cls = ' is-blocked';
    return `<span class="plan-rail-bar-cell${cls}" aria-hidden="true"></span>`;
  }).join('');
}

function _render(plan, controlState = null) {
  const root = document.getElementById('plan-rail');
  const body = document.getElementById('plan-rail-body');
  const progress = document.getElementById('plan-rail-progress');
  const bar = document.getElementById('plan-rail-bar');
  const control = document.getElementById('plan-rail-control');
  if (!root || !body || !progress) return;
  if (!plan || !Array.isArray(plan.steps) || plan.steps.length === 0) {
    _lastPlan = null;
    _lastControl = null;
    _hideRail(root, body, progress, bar);
    return;
  }
  if (_isPlanFullyComplete(plan)) {
    _lastPlan = plan;
    _lastControl = controlState || null;
    _hideRail(root, body, progress, bar);
    return;
  }
  _lastPlan = plan;
  _lastControl = controlState || null;
  root.style.display = '';
  progress.textContent = _buildProgressText(plan);
  if (bar) bar.innerHTML = _buildBarHtml(plan);
  if (control) {
    const action = controlState && controlState.action;
    if (action === 'stop' || action === 'continue') {
      control.hidden = false;
      control.dataset.planAction = action;
      control.textContent = action === 'stop'
        ? t('plan.action.stop')
        : t('plan.action.continue');
      control.classList.toggle('is-stop', action === 'stop');
      control.classList.toggle('is-continue', action === 'continue');
    } else {
      control.hidden = true;
      control.textContent = '';
      delete control.dataset.planAction;
      control.classList.remove('is-stop', 'is-continue');
    }
  }
  // Body is kept in DOM (hidden by [hidden] attr) for downstream consumers;
  // the rendered HTML lets them un-hide a step list without re-querying.
  body.innerHTML = plan.steps.map(_buildStepHtml).join('');
}

async function _fetchPlan(cid) {
  try {
    const res = await apiFetch(`/api/conversations/${encodeURIComponent(cid)}/plan`);
    if (!res.ok) return null;
    const data = await res.json();
    if (data?.ok && data.plan) return { plan: data.plan, control: data.control || null };
    return null;
  } catch (err) {
    _planRailLog.warn(`fetch plan failed cid=${cid}: ${err && err.message}`);
    return null;
  }
}

async function _doRefresh(cid, seq) {
  if (!cid) return;
  if (cid !== _currentCid) return;  // view switched mid-fetch
  const payload = await _fetchPlan(cid);
  if (cid !== _currentCid) return;
  if (seq !== _refreshSeq) return;
  _render(payload && payload.plan, payload && payload.control);
}

// ── Public API ───────────────────────────────────────────────────────────

const PlanRail = {
  /** Bind to a cid: refresh + remember. Call from conversation view-change.
   *  Clears the rail synchronously FIRST so any stale content from the
   *  previous cid is gone before the async fetch resolves. */
  bind(cid) {
    _currentCid = cid || null;
    _currentInFlight = [];
    _lastControl = null;
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
    _lastControl = null;
    _refreshInflight = null;
    _refreshSeq += 1;
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

  currentAction() {
    return _lastControl && _lastControl.action ? _lastControl.action : null;
  },

  continueCurrent() {
    if (!_currentCid || PlanRail.currentAction() !== 'continue') return false;
    const control = document.getElementById('plan-rail-control');
    return _continuePlan(_currentCid, control);
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

  // "展开详情 ▾" opens the conversation-info drawer to the Tasks tab. The
  // rail no longer has an inline-expanded body (that lives in the drawer
  // now per PC/docs/design/PATTERNS.md). Body clicks (action buttons / step
  // rows) still fall through to the handlers below — they're rendered into
  // the hidden #plan-rail-body so downstream features that un-hide it
  // continue to work.
  const expand = ev.target.closest('#plan-rail-expand');
  if (expand) {
    ev.stopPropagation();
    if (window.ConversationInfo && typeof window.ConversationInfo.openAndSetTab === 'function') {
      window.ConversationInfo.openAndSetTab('tasks');
    } else if (window.ConversationInfo && typeof window.ConversationInfo.open === 'function') {
      window.ConversationInfo.open();
    }
    return;
  }

  const control = ev.target.closest('#plan-rail-control');
  if (control) {
    ev.stopPropagation();
    if (control.disabled) return;
    const cid = _currentCid;
    const action = control.dataset.planAction;
    if (!cid || (action !== 'stop' && action !== 'continue')) return;
    const ok = await uiConfirm(action === 'stop'
      ? t('plan.confirm.stop')
      : t('plan.confirm.continue'));
    if (!ok) return;
    control.disabled = true;
    if (action === 'stop') {
      try {
        const runtime = window.ConversationRuntime;
        if (runtime && typeof runtime.abortConversation === 'function') {
          runtime.abortConversation(cid);
        } else {
          const res = await apiFetch(
            `/api/conversations/${encodeURIComponent(cid)}/abort`,
            { method: 'POST' },
          );
          const data = await res.json().catch(() => ({}));
          if (!res.ok || data?.ok === false) {
            throw new Error(data?.error || `HTTP ${res.status || 500}`);
          }
        }
      } catch (err) {
        _alertStepActionFailure('stop', err && err.message);
      } finally {
        control.disabled = false;
        await PlanRail.refresh(cid, { force: true });
        _refreshConversationInfo(cid);
      }
      return;
    }
    if (action === 'continue') {
      await _continuePlan(cid, control);
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

// Outside-click dismiss and collapsed-state persistence were removed when the
// rail moved from a floating chip to a permanent header strip — there's no
// inline-expanded body to dismiss, and the segmented bar is always visible
// when the rail has a plan. "展开详情 ▾" opens the conversation-info drawer
// (Tasks tab) instead, handled by the click delegate above.
