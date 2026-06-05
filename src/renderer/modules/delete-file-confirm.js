// Renderer-side inline confirm card for the main-side `delete_file` tool.
// Main emits a `delete_file.confirmation_required` push when an LLM agent
// calls `delete_file(path)`; we render an inline card at the bottom of the
// chat history (NOT a modal — the modal was disruptive and blocked the rest
// of the UI). The card carries the path + Cancel / Delete buttons; clicking
// either sends `delete_file.respond` back through IPC and the main-side
// tool unblocks.
//
// See: src/main/model/core-agent/delete-file-confirm.ts (request side)
//      src/main/ipc/index.ts          (`delete_file.respond` handler)
//
// CLAUDE.md §8: classic-script module, no ESM. `bootApp` (in `boot.js`)
// calls `startDeleteFileConfirmSubscription()` once at startup; this
// module defines that fn and the card mount helper.

const _deleteFileLog = (typeof createLogger === 'function')
  ? createLogger('delete-file-confirm')
  : { info: () => {}, warn: () => {} };

let _deleteFileSubscription = null;

function startDeleteFileConfirmSubscription() {
  if (_deleteFileSubscription) return;  // idempotent
  if (!window.orkas || typeof window.orkas.onPushEvent !== 'function') return;
  try {
    _deleteFileSubscription = window.orkas.onPushEvent(
      'delete_file.confirmation_required',
      _handleDeleteFileConfirmRequest,
    );
  } catch (err) {
    _deleteFileLog.warn('subscribe failed: ' + ((err && err.message) || String(err)));
  }
}

// Resolve an i18n key; if the lookup returns the key itself (untranslated),
// fall back to the literal we ship — keeps the card readable even before the
// locale tables load.
function _tDelete(key, fallback, vars) {
  if (typeof t !== 'function') return fallback;
  const v = t(key, vars || {});
  if (!v || v === key) {
    // Manual {path} interp on the fallback so the literal still shows the
    // path when vars are provided.
    if (vars) {
      let out = fallback;
      for (const [k, val] of Object.entries(vars)) {
        out = out.replace(new RegExp('\\{' + k + '\\}', 'g'), String(val));
      }
      return out;
    }
    return fallback;
  }
  return v;
}

function _handleDeleteFileConfirmRequest(payload) {
  if (!payload || typeof payload.confirm_id !== 'string') return;
  _mountDeleteConfirmCard(payload);
}

/** Find the chat-history container the user is currently looking at.
 *  Three surfaces can host a delete_file tool call:
 *    - main group chat (`#chat-history`)
 *    - per-skill inline edit chat (`#skills-chat-messages`)
 *    - per-agent inline edit chat (`#agents-chat-messages`)
 *  Without this lookup the card silently mounts to `#chat-history`,
 *  which is hidden when the user is on the skills / agents tab —
 *  invisible card = tool blocks the worker for the full timeout window.
 *  Check `offsetParent` (null when ancestor `display:none`) rather than
 *  inspecting computed style, which would also miss `visibility:hidden`. */
function _findActiveChatContainer() {
  const ids = ['skills-chat-messages', 'agents-chat-messages', 'chat-history'];
  for (const id of ids) {
    const el = document.getElementById(id);
    if (el && el.offsetParent !== null) return el;
  }
  // Fallback: nothing visible — return chat-history anyway so the card
  // exists in DOM (under a hidden parent it's still a DOM record); main
  // will time out in 60 s and return denied if the user never finds it.
  return document.getElementById('chat-history');
}

function _mountDeleteConfirmCard(payload) {
  const container = _findActiveChatContainer();
  if (!container) {
    // No host at all — fail closed by responding "no" immediately so the
    // tool isn't stuck.
    _respondDeleteConfirm(payload.confirm_id, false);
    return;
  }
  const displayPath = String(payload.path || payload.abs_path || '');
  const title       = _tDelete('local.delete_file.title',        '确认删除文件');
  const message     = _tDelete('local.delete_file.message',      '是否删除以下文件?该操作不可撤销。');
  const okLabel     = _tDelete('local.delete_file.confirm_button', '删除');
  const cancelLabel = _tDelete('local.delete_file.cancel_button',  '取消');
  const confirmedText = _tDelete('local.delete_file.confirmed',  '已确认删除');
  const cancelledText = _tDelete('local.delete_file.cancelled',  '已取消');

  const card = document.createElement('div');
  card.className = 'delete-confirm-card';
  card.dataset.deleteConfirmId = payload.confirm_id;
  card.innerHTML = `
    <div class="delete-confirm-title">${escapeHtml(title)}</div>
    <div class="delete-confirm-path"><code></code></div>
    <div class="delete-confirm-message">${escapeHtml(message)}</div>
    <div class="delete-confirm-actions">
      <button class="btn" type="button" data-delete-act="cancel">${escapeHtml(cancelLabel)}</button>
      <button class="btn btn-danger" type="button" data-delete-act="ok">${escapeHtml(okLabel)}</button>
    </div>
    <div class="delete-confirm-result" hidden></div>
  `;
  // Set the path via textContent to avoid any HTML interpretation of slashes
  // / quoting that escapeHtml on long abs paths can mangle visually.
  card.querySelector('.delete-confirm-path code').textContent = displayPath;
  container.appendChild(card);
  _scrollDeleteConfirmIntoView(card);

  const okBtn = card.querySelector('[data-delete-act="ok"]');
  const cancelBtn = card.querySelector('[data-delete-act="cancel"]');
  const resultEl = card.querySelector('.delete-confirm-result');

  let settled = false;
  const settle = async (granted) => {
    if (settled) return;
    settled = true;
    okBtn.disabled = true;
    cancelBtn.disabled = true;
    card.classList.add(granted ? 'is-confirmed' : 'is-cancelled');
    resultEl.textContent = granted ? confirmedText : cancelledText;
    resultEl.hidden = false;
    await _respondDeleteConfirm(payload.confirm_id, granted);
    // The token state flip alone doesn't wake the LLM — Step 1 already
    // ended the turn, so without a fresh user message Step 2 never fires
    // and the file isn't actually unlinked. Auto-dispatch a short user
    // message via the active surface's input + send button so the LLM
    // gets a new turn and retries with the token. Cancel doesn't need
    // this — the LLM treats `denied` as terminal.
    if (granted) {
      const trigger = _tDelete('local.delete_file.user_continue', '已确认,请继续。');
      const fired = _autoTriggerLLMContinue(trigger);
      if (!fired) {
        const hint = _tDelete('local.delete_file.send_to_continue', '请发送一条消息让智能体继续完成删除。');
        resultEl.textContent = (resultEl.textContent || '') + ' — ' + hint;
      }
    }
  };

  okBtn.addEventListener('click', () => settle(true));
  cancelBtn.addEventListener('click', () => settle(false));
}

/** Fire a fresh user message in the currently active chat surface so the
 *  LLM gets a turn-trigger to retry `delete_file` Step 2 with the token.
 *  We pick the visible input + send button (same scan order as the card
 *  container lookup) and simulate user typing + send. Skipped (returns
 *  false) when the user already has a draft (preserve their typing) or
 *  the send button is disabled (mid-stream — let the queue handle it). */
function _autoTriggerLLMContinue(text) {
  const surfaces = [
    ['skills-chat-input', 'skills-chat-send-btn', 'skills-chat-messages'],
    ['agents-chat-input', 'agents-chat-send-btn', 'agents-chat-messages'],
    ['chat-input',        'chat-send-btn',        'chat-history'],
  ];
  for (const [inputId, sendId, historyId] of surfaces) {
    const inp = document.getElementById(inputId);
    const btn = document.getElementById(sendId);
    if (!inp || !btn) continue;
    if (inp.offsetParent === null) continue;
    if (inp.value && inp.value.trim()) return false;
    // Suppress scroll-pin for this one send so the historic messages
    // (and the confirm card itself) stay in view instead of being pushed
    // off-screen by the 100vh spacer that pins the user message to top.
    const history = document.getElementById(historyId);
    if (history) history.dataset.suppressScrollPin = '1';
    inp.value = text;
    try { inp.dispatchEvent(new Event('input', { bubbles: true })); } catch (_) {}
    // Mid-stream the button is a Stop button, so clicking it would abort.
    // Submit with Enter instead: main / skill / agent chats all route plain
    // Enter through their queue-aware send handler, which appends this tiny
    // continuation behind the in-flight reply and drains it automatically.
    if (btn.disabled || btn.classList.contains('streaming') || btn.classList.contains('aborting')) {
      const queued = _dispatchDeleteContinueEnter(inp);
      if (!queued) {
        inp.value = '';
        try { inp.dispatchEvent(new Event('input', { bubbles: true })); } catch (_) {}
        if (history && history.dataset.suppressScrollPin === '1') delete history.dataset.suppressScrollPin;
      }
      return queued;
    }
    btn.click();
    return true;
  }
  return false;
}

function _dispatchDeleteContinueEnter(inputEl) {
  try {
    const ev = new KeyboardEvent('keydown', {
      key: 'Enter',
      code: 'Enter',
      bubbles: true,
      cancelable: true,
    });
    inputEl.dispatchEvent(ev);
    // The queue-aware handlers clear the textarea on success. If it still
    // contains text, no handler consumed the synthetic Enter.
    return !(inputEl.value && inputEl.value.trim());
  } catch (_) {
    return false;
  }
}

async function _respondDeleteConfirm(confirmId, granted) {
  try {
    await window.orkas.invoke('delete_file.respond', { confirm_id: confirmId, granted });
  } catch (err) {
    _deleteFileLog.warn('respond failed: ' + ((err && err.message) || String(err)));
  }
}

function _scrollDeleteConfirmIntoView(card) {
  try { card.scrollIntoView({ behavior: 'smooth', block: 'end' }); }
  catch (_) { /* IE-ish fallback unnecessary in Electron */ }
}
