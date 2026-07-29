// ─── Generic right-click context menu ───
// Small floating menu anchored at the cursor; items are { label, onClick,
// disabled?, icon? }. There's exactly one menu instance at a time — opening a new
// menu closes the previous one. Dismissers: outside click, Escape, scroll,
// resize, and the i18n-change broadcast (label text may need refreshing).
//
// IME guard (CLAUDE.md §8): the up/down/Enter shortcuts early-return when a
// composition is active so a half-typed Chinese candidate doesn't trigger
// the wrong menu item.

const _ctxMenuLog = createLogger('context-menu');

let _ctxMenuEl = null;
let _ctxMenuItems = [];
let _ctxMenuActiveIdx = -1;
let _ctxMenuOpen = false;
let _ctxMenuPreviousFocus = null;

function _runContextMenuAction(item) {
  if (!item || item.disabled) return;
  try {
    const result = item.onClick();
    if (result && typeof result.then === 'function') {
      Promise.resolve(result).catch(() => _ctxMenuLog.warn('context menu action failed'));
    }
  } catch (_) {
    _ctxMenuLog.warn('context menu action failed');
  }
}

function showContextMenu(event, items) {
  closeContextMenu();
  if (!Array.isArray(items) || items.length === 0) return;
  _ctxMenuItems = items.filter((it) => it && typeof it.label === 'string' && typeof it.onClick === 'function');
  if (_ctxMenuItems.length === 0) return;

  const menu = document.createElement('div');
  menu.className = 'context-menu';
  menu.setAttribute('role', 'menu');
  menu.tabIndex = -1;
  _ctxMenuItems.forEach((it, idx) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `context-menu-item${it.disabled ? ' is-disabled' : ''}`;
    btn.dataset.contextMenuIdx = String(idx);
    btn.setAttribute('role', 'menuitem');
    btn.setAttribute('tabindex', '-1');
    btn.disabled = !!it.disabled;
    if (it.icon && typeof uiIconHtml === 'function') {
      const icon = document.createElement('span');
      icon.className = 'context-menu-icon';
      icon.innerHTML = uiIconHtml(it.icon);
      btn.appendChild(icon);
    }
    const label = document.createElement('span');
    label.className = 'context-menu-label';
    label.textContent = it.label;
    btn.appendChild(label);
    menu.appendChild(btn);
  });
  _ctxMenuPreviousFocus = document.activeElement;
  document.body.appendChild(menu);
  _ctxMenuEl = menu;
  _ctxMenuOpen = true;
  _ctxMenuActiveIdx = -1;

  // Place at cursor; flip when overflowing viewport. Read offset after
  // appending so the menu has real dimensions.
  const x = Number.isFinite(event && event.clientX) ? event.clientX : 0;
  const y = Number.isFinite(event && event.clientY) ? event.clientY : 0;
  const rect = menu.getBoundingClientRect();
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const margin = 4;
  const preferredLeft = x + rect.width > vw - margin ? x - rect.width : x;
  const preferredTop = y + rect.height > vh - margin ? y - rect.height : y;
  const left = Math.min(
    Math.max(margin, vw - rect.width - margin),
    Math.max(margin, preferredLeft),
  );
  const top = Math.min(
    Math.max(margin, vh - rect.height - margin),
    Math.max(margin, preferredTop),
  );
  menu.style.left = `${left}px`;
  menu.style.top  = `${top}px`;

  menu.querySelectorAll('.context-menu-item').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const idx = Number(btn.dataset.contextMenuIdx);
      const it = _ctxMenuItems[idx];
      closeContextMenu();
      _runContextMenuAction(it);
    });
    btn.addEventListener('mouseenter', () => {
      const idx = Number(btn.dataset.contextMenuIdx);
      _setActiveIdx(idx);
    });
  });

  const firstEnabled = _ctxMenuItems.findIndex((item) => !item.disabled);
  if (firstEnabled >= 0) _setActiveIdx(firstEnabled);
  else menu.focus();
}

function closeContextMenu() {
  if (!_ctxMenuOpen) return;
  _ctxMenuOpen = false;
  _ctxMenuActiveIdx = -1;
  if (_ctxMenuEl && _ctxMenuEl.parentNode) _ctxMenuEl.parentNode.removeChild(_ctxMenuEl);
  _ctxMenuEl = null;
  _ctxMenuItems = [];
  const previousFocus = _ctxMenuPreviousFocus;
  _ctxMenuPreviousFocus = null;
  try { previousFocus?.focus?.(); } catch (_) {}
}

function _setActiveIdx(idx) {
  if (!_ctxMenuEl) return;
  if (idx < 0 || idx >= _ctxMenuItems.length) {
    _ctxMenuActiveIdx = -1;
  } else {
    _ctxMenuActiveIdx = idx;
  }
  _ctxMenuEl.querySelectorAll('.context-menu-item').forEach((btn, i) => {
    const active = i === _ctxMenuActiveIdx;
    btn.classList.toggle('is-active', active);
    btn.setAttribute('tabindex', active ? '0' : '-1');
    if (active) {
      try { btn.focus(); } catch (_) {}
    }
  });
}

function _findEnabledIdx(from, direction) {
  const length = _ctxMenuItems.length;
  if (!length) return -1;
  const start = from >= 0 ? from : (direction > 0 ? -1 : 0);
  for (let step = 1; step <= length; step += 1) {
    const idx = (start + direction * step + length * 2) % length;
    if (!_ctxMenuItems[idx].disabled) return idx;
  }
  return -1;
}

// ── Dismissers ─────────────────────────────────────────────────────────

document.addEventListener('mousedown', (e) => {
  if (!_ctxMenuOpen) return;
  if (_ctxMenuEl && _ctxMenuEl.contains(e.target)) return;
  closeContextMenu();
}, true);

document.addEventListener('keydown', (e) => {
  if (!_ctxMenuOpen) return;
  // IME composition guard — Chinese / Japanese / Korean Enter commits a
  // candidate; don't fire menu actions while a composition is active.
  if (e.isComposing || e.keyCode === 229) return;
  if (e.key === 'Escape') { e.preventDefault(); closeContextMenu(); return; }
  if (e.key === 'ArrowDown') {
    e.preventDefault();
    const next = _findEnabledIdx(_ctxMenuActiveIdx, 1);
    if (next >= 0) _setActiveIdx(next);
    return;
  }
  if (e.key === 'ArrowUp') {
    e.preventDefault();
    const prev = _findEnabledIdx(_ctxMenuActiveIdx, -1);
    if (prev >= 0) _setActiveIdx(prev);
    return;
  }
  if (e.key === 'Home' || e.key === 'End') {
    e.preventDefault();
    const next = _findEnabledIdx(-1, e.key === 'Home' ? 1 : -1);
    if (next >= 0) _setActiveIdx(next);
    return;
  }
  if (e.key === 'Tab') {
    closeContextMenu();
    return;
  }
  if (e.key === 'Enter') {
    if (_ctxMenuActiveIdx < 0) return;
    const it = _ctxMenuItems[_ctxMenuActiveIdx];
    if (!it || it.disabled) return;
    e.preventDefault();
    closeContextMenu();
    _runContextMenuAction(it);
  }
});

window.addEventListener('scroll', () => closeContextMenu(), true);
window.addEventListener('resize', () => closeContextMenu());
window.addEventListener('i18n-change', () => closeContextMenu());

window.showContextMenu = showContextMenu;
window.closeContextMenu = closeContextMenu;
