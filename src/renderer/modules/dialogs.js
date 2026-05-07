// ─── Custom dialogs (replace native confirm/alert) ──────────────────────
// Native `confirm()` / `alert()` render OS-locale buttons ("OK"/"Cancel").
// These helpers give us 取消 / 确认 every time and match the rest of the
// modal UI. Both return a Promise — callers must `await`.

// Pre-boot, `t()` may not yet have tables loaded — fall back to Chinese
// source strings so the dialog never renders blank if triggered early.
function _dialogLabel(key, zhFallback) {
  try { const v = t(key); return v === key ? zhFallback : v; } catch (_) { return zhFallback; }
}

function _uiShowDialog({ message, showCancel }) {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay ui-dialog-overlay open';
    const msgHtml = escapeHtml(String(message || '')).replace(/\n/g, '<br />');
    const cancelText = escapeHtml(_dialogLabel('common.cancel', '取消'));
    const okText = escapeHtml(_dialogLabel('common.confirm', '确认'));
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

function uiConfirm(message) {
  return _uiShowDialog({ message, showCancel: true });
}

function uiAlert(message) {
  return _uiShowDialog({ message, showCancel: false }).then(() => {});
}

// Text-input prompt with 取消 / 确认 buttons. Returns the entered string, or
// null on cancel. Mirrors native `prompt()` semantics.
function uiPrompt(message, defaultValue = '') {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay ui-dialog-overlay open';
    const msgHtml = escapeHtml(String(message || '')).replace(/\n/g, '<br />');
    const cancelText = escapeHtml(_dialogLabel('common.cancel', '取消'));
    const okText = escapeHtml(_dialogLabel('common.confirm', '确认'));
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

