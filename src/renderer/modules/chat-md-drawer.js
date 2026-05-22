// ─── Right-side markdown drawer for the chat view ───
// Hosted next to the main chat history, slides in from the right. Two source
// kinds today (defined by mountMdViewEdit):
//   workspace — a caller explicitly wants a side drawer for a workspace file
//   ephemeral — context-menu "临时编辑" on a chat selection
//
// Single-instance: reopening always closes the previous mount. The drawer's
// own close button (header) goes through the same dirty-check as opening a
// fresh source over an unsaved one.

const _chatMdDrawerLog = createLogger('chat-md-drawer');

let _cmdState = null;   // { controller, source, title, dirty }

function openChatMdDrawer({ source, initialMode, title }) {
  if (!source || typeof source.kind !== 'string') {
    _chatMdDrawerLog.warn('openChatMdDrawer called without source.kind');
    return;
  }
  const panel = document.getElementById('chat-md-drawer-panel');
  const titleEl = document.getElementById('chat-md-drawer-title');
  const bodyEl = document.getElementById('chat-md-drawer-body');
  const actionsEl = document.getElementById('chat-md-drawer-actions');
  if (!panel || !bodyEl || !actionsEl) {
    _chatMdDrawerLog.warn('chat-md-drawer DOM missing — drawer container not in index.html');
    return;
  }

  // Replacing an open mount: ask before discarding unsaved edits.
  if (_cmdState && _cmdState.controller && _cmdState.dirty) {
    const proceed = window.confirm(t('chat.md_drawer.close_confirm'));
    if (!proceed) return;
  }
  _teardownCmd();

  const resolvedTitle = title || _defaultTitle(source);
  if (titleEl) titleEl.textContent = resolvedTitle;
  panel.classList.add('is-open');
  panel.hidden = false;

  _cmdState = { controller: null, source, title: resolvedTitle, dirty: false };

  _cmdState.controller = mountMdViewEdit({
    bodyEl,
    actionsEl,
    source,
    initialMode: source.kind === 'ephemeral' ? 'edit' : (initialMode || 'view'),
    callbacks: {
      onDirtyChange: (dirty) => { if (_cmdState) _cmdState.dirty = !!dirty; },
      onReveal: () => {
        if (source.kind !== 'workspace') return;
        try {
          const payload = { path: source.absPath };
          if (source.cid) payload.cid = source.cid;
          window.orkas.invoke('workspace.revealPath', payload);
        } catch (err) {
          _chatMdDrawerLog.warn('revealPath failed', err);
        }
      },
      // The drawer does not surface a delete action; setting it here would
      // be ignored (capability defaults already skip delete for workspace).
      onSendToChatInput: (text) => {
        const ok = _sendDraftToChatInput(text);
        if (ok) closeChatMdDrawer({ force: true });
      },
    },
  });

  _bindCloseHandlers();
}

function closeChatMdDrawer({ force = false } = {}) {
  if (!_cmdState) return;
  if (!force && _cmdState.dirty) {
    const proceed = window.confirm(t('chat.md_drawer.close_confirm'));
    if (!proceed) return;
  }
  const panel = document.getElementById('chat-md-drawer-panel');
  if (panel) {
    panel.classList.remove('is-open');
    panel.hidden = true;
  }
  _teardownCmd();
}

function isChatMdDrawerOpen() {
  return !!_cmdState;
}

function _teardownCmd() {
  if (_cmdState && _cmdState.controller) {
    try { _cmdState.controller.destroy(); }
    catch (err) { _chatMdDrawerLog.warn('controller.destroy threw', err); }
  }
  _cmdState = null;
}

function _defaultTitle(source) {
  if (source.kind === 'workspace' && source.absPath) {
    return source.absPath.split(/[\\/]/).pop() || source.absPath;
  }
  if (source.kind === 'ephemeral') {
    return t('chat.md_drawer.scratch_title');
  }
  return '';
}

// ── Close button / Esc dismisser ────────────────────────────────────────

let _cmdHandlersBound = false;
function _bindCloseHandlers() {
  if (_cmdHandlersBound) return;
  _cmdHandlersBound = true;
  const closeBtn = document.getElementById('chat-md-drawer-close');
  if (closeBtn) closeBtn.addEventListener('click', () => closeChatMdDrawer());
  document.addEventListener('keydown', (e) => {
    // IME guard (CLAUDE.md §8): don't intercept Escape while the user is
    // committing a composition candidate.
    if (e.isComposing || e.keyCode === 229) return;
    if (e.key !== 'Escape' || !_cmdState) return;
    // If the drawer body has focus and is inside a textarea, let Escape
    // exit the textarea selection rather than close the drawer (matches
    // the behavior of the main chat composer).
    const active = document.activeElement;
    if (active && active.tagName === 'TEXTAREA' && active.closest('#chat-md-drawer-panel')) return;
    closeChatMdDrawer();
  });
}

// ── Send draft to chat input ────────────────────────────────────────────

function _sendDraftToChatInput(text) {
  const input = document.getElementById('chat-input');
  if (!input) {
    _chatMdDrawerLog.warn('chat-input not found — drawer "send to chat" no-op');
    return false;
  }
  // Prepend a newline when there's already content so the snippet doesn't
  // smash into the existing draft.
  const existing = input.value || '';
  const joiner = existing && !existing.endsWith('\n') ? '\n' : '';
  input.value = `${existing}${joiner}${text}`;
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.focus();
  // Move caret to end so the user sees the inserted block.
  try {
    const end = input.value.length;
    input.setSelectionRange(end, end);
  } catch (_) { /* old jsdom — ignore */ }
  return true;
}

// Expose to the global namespace so cross-module callers can open the drawer
// without ESM imports (per CLAUDE.md §8).
window.openChatMdDrawer  = openChatMdDrawer;
window.closeChatMdDrawer = closeChatMdDrawer;
window.isChatMdDrawerOpen = isChatMdDrawerOpen;
