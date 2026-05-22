// ─── Custom dialogs (replace native confirm/alert) ──────────────────────
// Native `confirm()` / `alert()` render OS-locale buttons ("OK"/"Cancel").
// These helpers give us a localized cancel / confirm pair every time
// and match the rest of the modal UI. Both return a Promise — callers
// must `await`.

// Pre-boot, `t()` may not yet have tables loaded — fall back to a
// Chinese source string so the dialog never renders blank if triggered
// early. (The fallback string itself is intentionally left as Chinese
// to match the historical default; the i18n key takes over once tables
// load.)
function _dialogLabel(key, zhFallback) {
  try { const v = t(key); return v === key ? zhFallback : v; } catch (_) { return zhFallback; }
}

function _uiShowDialog({ message, showCancel, okLabel, cancelLabel }) {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay ui-dialog-overlay open';
    const msgHtml = escapeHtml(String(message || '')).replace(/\n/g, '<br />');
    const cancelText = escapeHtml(cancelLabel || _dialogLabel('common.cancel', 'Cancel'));
    const okText = escapeHtml(okLabel || _dialogLabel('common.confirm', 'Confirm'));
    overlay.innerHTML = `
      <div class="modal ui-dialog" role="dialog" aria-modal="true">
        <div class="ui-dialog-message">${msgHtml}</div>
        <div class="modal-actions">
          ${showCancel ? `<button class="btn" data-act="cancel">${cancelText}</button>` : ''}
          <button class="btn btn-primary" data-act="ok">${okText}</button>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);

    const okBtn = overlay.querySelector('[data-act="ok"]');
    const cancelBtn = overlay.querySelector('[data-act="cancel"]');
    const onKey = (e) => {
      // IME guard (CLAUDE.md §8) — Enter while composing should commit
      // the IME candidate, not auto-confirm the dialog.
      if (e.isComposing || e.keyCode === 229) return;
      if (e.key === 'Escape') finish(false);
      else if (e.key === 'Enter') finish(true);
    };
    const finish = (val) => {
      document.removeEventListener('keydown', onKey, true);
      overlay.remove();
      resolve(val);
    };
    okBtn.addEventListener('click', () => finish(true));
    if (cancelBtn) cancelBtn.addEventListener('click', () => finish(false));
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) finish(showCancel ? false : true);
    });
    document.addEventListener('keydown', onKey, true);
    setTimeout(() => okBtn.focus(), 0);
  });
}

// Backwards-compatible: `uiConfirm("message")` keeps the original
// "Confirm" / "Cancel" pair. Pass `{message, okLabel?, cancelLabel?}` when
// the action wants a more specific verb (e.g. "Open Folder" for the
// preview-fallback dialog) — avoids forking a near-duplicate confirm
// helper per CLAUDE.md §"Reuse UI components".
function uiConfirm(arg) {
  if (arg && typeof arg === 'object') {
    return _uiShowDialog({
      message: arg.message,
      showCancel: true,
      okLabel: arg.okLabel,
      cancelLabel: arg.cancelLabel,
    });
  }
  return _uiShowDialog({ message: arg, showCancel: true });
}

function uiAlert(message) {
  return _uiShowDialog({ message, showCancel: false }).then(() => {});
}

// Danger-styled confirm: title + multi-line message + custom danger button
// label. The primary button uses .btn-danger (red) so the user sees the
// destructive action signed by the action wording itself. Used by the
// project delete flow ("delete project + N conversations") — generic enough
// to adopt for other irreversible actions later.
//
// Returns true if the user confirmed (clicked the danger button), false on
// cancel / outside click / Esc.
function uiConfirmDanger({ title, message, dangerLabel, cancelLabel } = {}) {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay ui-dialog-overlay open';
    const titleHtml = title ? `<div class="ui-dialog-title">${escapeHtml(String(title))}</div>` : '';
    const msgHtml = escapeHtml(String(message || '')).replace(/\n/g, '<br />');
    const cancelText = escapeHtml(cancelLabel || _dialogLabel('common.cancel', 'Cancel'));
    const dangerText = escapeHtml(dangerLabel || _dialogLabel('common.confirm', 'Confirm'));
    overlay.innerHTML = `
      <div class="modal ui-dialog ui-dialog-danger" role="dialog" aria-modal="true">
        ${titleHtml}
        <div class="ui-dialog-message">${msgHtml}</div>
        <div class="modal-actions">
          <button class="btn" data-act="cancel">${cancelText}</button>
          <button class="btn btn-danger" data-act="ok">${dangerText}</button>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);

    const okBtn = overlay.querySelector('[data-act="ok"]');
    const cancelBtn = overlay.querySelector('[data-act="cancel"]');
    const onKey = (e) => {
      if (e.isComposing || e.keyCode === 229) return;
      if (e.key === 'Escape') finish(false);
      // Enter does NOT auto-fire danger — the user must explicitly click
      // the red button. Reduces accidental confirmation on irreversible
      // actions. (Standard uiConfirm keeps Enter-to-confirm.)
    };
    const finish = (val) => {
      document.removeEventListener('keydown', onKey, true);
      overlay.remove();
      resolve(val);
    };
    okBtn.addEventListener('click', () => finish(true));
    cancelBtn.addEventListener('click', () => finish(false));
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) finish(false);
    });
    document.addEventListener('keydown', onKey, true);
    setTimeout(() => cancelBtn.focus(), 0);  // focus cancel by default — safer
  });
}

// Multi-button choice dialog. The user picks one of `choices[]` (each
// gets its own button); the resolved value is the chosen `id`, or `null`
// on cancel / Esc / outside-click. Used when an action has two valid
// follow-up paths (e.g. close-sync with / without cloud purge) — a plain
// uiConfirm would force the user to imagine the alternative.
//
// `choices: [{ id, label, style? }]` — `style` may be 'primary' (default),
// 'danger', or '' for the neutral .btn look.
function uiChoice({ title, message, choices = [], cancelLabel } = {}) {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay ui-dialog-overlay open';
    const titleHtml = title ? `<div class="ui-dialog-title">${escapeHtml(String(title))}</div>` : '';
    const msgHtml = escapeHtml(String(message || '')).replace(/\n/g, '<br />');
    const cancelText = escapeHtml(cancelLabel || _dialogLabel('common.cancel', 'Cancel'));
    const choiceHtml = choices.map((c) => {
      const cls = c.style === 'danger' ? 'btn btn-danger'
        : c.style === '' ? 'btn'
        : 'btn btn-primary';
      return `<button class="${cls}" data-act="choice" data-id="${escapeHtml(String(c.id))}">${escapeHtml(String(c.label || c.id))}</button>`;
    }).join('');
    overlay.innerHTML = `
      <div class="modal ui-dialog" role="dialog" aria-modal="true">
        ${titleHtml}
        <div class="ui-dialog-message">${msgHtml}</div>
        <div class="modal-actions">
          <button class="btn" data-act="cancel">${cancelText}</button>
          ${choiceHtml}
        </div>
      </div>
    `;
    document.body.appendChild(overlay);

    const onKey = (e) => {
      if (e.isComposing || e.keyCode === 229) return;
      if (e.key === 'Escape') finish(null);
      // No Enter-to-confirm — caller must pick a choice explicitly.
    };
    const finish = (val) => {
      document.removeEventListener('keydown', onKey, true);
      overlay.remove();
      resolve(val);
    };
    overlay.querySelectorAll('[data-act="choice"]').forEach((btn) => {
      btn.addEventListener('click', () => finish(btn.dataset.id || null));
    });
    overlay.querySelector('[data-act="cancel"]').addEventListener('click', () => finish(null));
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) finish(null);
    });
    document.addEventListener('keydown', onKey, true);
  });
}

// Text-input prompt with cancel / confirm buttons. Returns the entered string, or
// null on cancel. Mirrors native `prompt()` semantics.
function uiPrompt(message, defaultValue = '') {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay ui-dialog-overlay open';
    const msgHtml = escapeHtml(String(message || '')).replace(/\n/g, '<br />');
    const cancelText = escapeHtml(_dialogLabel('common.cancel', 'Cancel'));
    const okText = escapeHtml(_dialogLabel('common.confirm', 'Confirm'));
    overlay.innerHTML = `
      <div class="modal ui-dialog" role="dialog" aria-modal="true">
        <div class="ui-dialog-message">${msgHtml}</div>
        <div class="form-row" style="margin-top:12px;margin-bottom:0">
          <input type="text" class="ui-dialog-input" />
        </div>
        <div class="modal-actions">
          <button class="btn" data-act="cancel">${cancelText}</button>
          <button class="btn btn-primary" data-act="ok">${okText}</button>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);

    const input = overlay.querySelector('.ui-dialog-input');
    input.value = defaultValue;
    const okBtn = overlay.querySelector('[data-act="ok"]');
    const cancelBtn = overlay.querySelector('[data-act="cancel"]');
    const onKey = (e) => {
      // IME guard (CLAUDE.md §8) — Enter while composing in the prompt
      // input belongs to the IME, not to the dialog confirm action.
      if (e.isComposing || e.keyCode === 229) return;
      if (e.key === 'Escape') finish(null);
      else if (e.key === 'Enter' && e.target === input) finish(input.value);
    };
    const finish = (val) => {
      document.removeEventListener('keydown', onKey, true);
      overlay.remove();
      resolve(val);
    };
    okBtn.addEventListener('click', () => finish(input.value));
    cancelBtn.addEventListener('click', () => finish(null));
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) finish(null);
    });
    document.addEventListener('keydown', onKey, true);
    setTimeout(() => { input.focus(); input.select(); }, 0);
  });
}

