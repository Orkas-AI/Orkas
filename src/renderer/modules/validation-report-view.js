// ─── Quality validation report modal ─────────────────────────────────────
//
// Renders a `ValidationReport` (from `src/main/quality/types.ts`) as a
// scrollable modal with per-level color cues. Used by:
//   - marketplace.js: when install is rejected by the quality validator
//   - (future) skill / agent inline edit chats
//
// Reuses the dialog overlay chrome from dialogs.js (.modal-overlay /
// .ui-dialog / .modal-actions / .btn) per CLAUDE.md §8 "Reuse UI
// components" — the only new structure is the per-violation card list,
// which is layout-specific.
//
// API:
//   showValidationReport({ title, report, okLabel?, forceLabel? }): Promise<'close'|'force'>
//     title  — header text (caller localized)
//     report — { ok, violations, validated_at, validator_version }
//     okLabel — defaults to common.close
//     forceLabel — when present, shows a neutral override button
//
//   readQualityReport(kind, id): Promise<ValidationReport | null>
//     thin wrapper around window.orkas.quality.read{Skill,Agent}Report
//     so callers don't have to remember the channel name.

function _levelColor(level) {
  if (level === 'EXTREME') return 'var(--danger, #c83030)';
  if (level === 'MEDIUM') return '#d97706';  // amber-600 — distinct from danger
  return 'var(--muted, #8c8c8c)';
}

function _levelLabel(level) {
  // Single i18n key per level — kept as one-word labels so the badge stays compact.
  const key = `quality.level.${level}`;
  try {
    const v = t(key);
    if (v && v !== key) return v;
  } catch (_) { /* t() not ready */ }
  return level;
}

function _suggestedFixText(v) {
  const rule = v && v.rule ? String(v.rule) : '';
  if (rule) {
    const key = `quality.fix.${rule}`;
    try {
      const localized = t(key);
      if (localized && localized !== key) return localized;
    } catch (_) { /* t() not ready */ }
  }
  return v && v.suggested_fix ? String(v.suggested_fix) : '';
}

function _renderViolationCard(v) {
  const color = _levelColor(v.level);
  const label = _levelLabel(v.level);
  const suggestedFix = _suggestedFixText(v);
  return `
    <div class="quality-violation" style="border-left:3px solid ${color};padding:8px 12px;margin-bottom:10px;background:var(--surface-2,rgba(0,0,0,.03));border-radius:4px;">
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:4px;">
        <span style="font-size:11px;font-weight:600;color:${color};text-transform:uppercase;letter-spacing:.5px;">${escapeHtml(label)}</span>
        <span style="font-family:var(--mono,monospace);font-size:12px;color:var(--muted);">${escapeHtml(v.rule || '')}</span>
      </div>
      <div style="font-size:12px;color:var(--muted);margin-bottom:6px;font-family:var(--mono,monospace);">${escapeHtml(v.field || '')}</div>
      ${v.snippet ? `<pre style="margin:0 0 6px;padding:6px 8px;background:var(--surface-3,rgba(0,0,0,.05));border-radius:3px;font-size:12px;overflow-x:auto;white-space:pre-wrap;word-break:break-all;">${escapeHtml(v.snippet)}</pre>` : ''}
      <div style="font-size:13px;line-height:1.5;">${escapeHtml(suggestedFix)}</div>
    </div>
  `;
}

function showValidationReport({ title, report, okLabel, forceLabel } = {}) {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay ui-dialog-overlay open';

    const violations = (report && Array.isArray(report.violations)) ? report.violations : [];
    // Sort: EXTREME first, then MEDIUM, then LOW. Within a level keep
    // original order (the validator already emits them in detection order).
    const order = { EXTREME: 0, MEDIUM: 1, LOW: 2 };
    const sorted = violations.slice().sort((a, b) => (order[a.level] ?? 9) - (order[b.level] ?? 9));

    const ok = escapeHtml(okLabel || (() => {
      try { const v = t('common.close'); return v === 'common.close' ? 'Close' : v; }
      catch (_) { return 'Close'; }
    })());
    const titleText = escapeHtml(title || 'Quality validation');

    const bodyHtml = sorted.length
      ? sorted.map(_renderViolationCard).join('')
      : `<div class="muted" style="text-align:center;padding:20px;">${escapeHtml((() => {
          try { const v = t('quality.empty'); return v === 'quality.empty' ? 'No findings.' : v; }
          catch (_) { return 'No findings.'; }
        })())}</div>`;

    const force = forceLabel ? escapeHtml(forceLabel) : '';

    overlay.innerHTML = `
      <div class="modal ui-dialog quality-report-dialog" role="dialog" aria-modal="true" style="max-width:640px;width:90vw;">
        <div class="ui-dialog-title">${titleText}</div>
        <div class="quality-report-body" style="max-height:60vh;overflow-y:auto;margin:12px 0;">
          ${bodyHtml}
        </div>
        <div class="modal-actions">
          ${force ? `<button class="btn" data-act="force">${force}</button>` : ''}
          <button class="btn btn-primary" data-act="ok">${ok}</button>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);

    const okBtn = overlay.querySelector('[data-act="ok"]');
    const onKey = (e) => {
      if (e.isComposing || e.keyCode === 229) return;
      if (e.key === 'Escape' || e.key === 'Enter') finish('close');
    };
    const finish = (action = 'close') => {
      document.removeEventListener('keydown', onKey, true);
      overlay.remove();
      resolve(action);
    };
    overlay.querySelector('[data-act="force"]')?.addEventListener('click', () => finish('force'));
    okBtn.addEventListener('click', () => finish('close'));
    document.addEventListener('keydown', onKey, true);
    setTimeout(() => okBtn.focus(), 0);
  });
}

/** Fetch the latest persisted quality report for a skill or agent.
 *  Returns null on missing report / IPC error. */
async function readQualityReport(kind, id) {
  if (!id || (kind !== 'skill' && kind !== 'agent')) return null;
  try {
    const channel = kind === 'skill' ? 'readSkillReport' : 'readAgentReport';
    const r = await window.orkas.quality[channel](id);
    if (!r || r.ok === false) return null;
    return r.report || null;
  } catch (_) {
    return null;
  }
}

/** Heuristic: was this error message thrown by the quality validator?
 *  The main-side error builder uses a stable prefix ("Quality validation
 *  rejected ...") — see `features/marketplace.ts::_qualityInstallError`. */
function isQualityRejectionError(message) {
  return typeof message === 'string' && /^Quality validation rejected\b/.test(message);
}
