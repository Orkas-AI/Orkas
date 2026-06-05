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

function showContextMenu(event, items) {
  closeContextMenu();
  if (!Array.isArray(items) || items.length === 0) return;
  _ctxMenuItems = items.filter((it) => it && typeof it.label === 'string' && typeof it.onClick === 'function');
  if (_ctxMenuItems.length === 0) return;

  const menu = document.createElement('div');
  menu.className = 'context-menu';
  menu.setAttribute('role', 'menu');
  menu.innerHTML = _ctxMenuItems.map((it, idx) => {
    const icon = it.icon && typeof uiIconHtml === 'function'
      ? `<span class="context-menu-icon">${uiIconHtml(it.icon)}</span>`
      : '';
    return `<button type="button" class="context-menu-item${it.disabled ? ' is-disabled' : ''}"`
    + ` data-context-menu-idx="${idx}" role="menuitem" tabindex="-1"`
    + ` ${it.disabled ? 'disabled' : ''}>${icon}<span class="context-menu-label">${escapeHtml(it.label)}</span></button>`;
  }).join('');
  document.body.appendChild(menu);
  _ctxMenuEl = menu;
  _ctxMenuOpen = true;
  _ctxMenuActiveIdx = -1;

  // Place at cursor; flip when overflowing viewport. Read offset after
  // appending so the menu has real dimensions.
  const x = event.clientX || 0;
  const y = event.clientY || 0;
  const rect = menu.getBoundingClientRect();
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const left = x + rect.width > vw - 4 ? Math.max(4, x - rect.width) : x;
  const top  = y + rect.height > vh - 4 ? Math.max(4, y - rect.height) : y;
  menu.style.left = `${left}px`;
  menu.style.top  = `${top}px`;

  menu.querySelectorAll('.context-menu-item').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const idx = Number(btn.dataset.contextMenuIdx);
      const it = _ctxMenuItems[idx];
      closeContextMenu();
      if (it && !it.disabled) {
        try { it.onClick(); }
        catch (err) { _ctxMenuLog.warn('item onClick threw', err); }
      }
    });
    btn.addEventListener('mouseenter', () => {
      const idx = Number(btn.dataset.contextMenuIdx);
      _setActiveIdx(idx);
    });
  });
}

function closeContextMenu() {
  if (!_ctxMenuOpen) return;
  _ctxMenuOpen = false;
  _ctxMenuActiveIdx = -1;
  if (_ctxMenuEl && _ctxMenuEl.parentNode) _ctxMenuEl.parentNode.removeChild(_ctxMenuEl);
  _ctxMenuEl = null;
  _ctxMenuItems = [];
}

function _setActiveIdx(idx) {
  if (!_ctxMenuEl) return;
  if (idx < 0 || idx >= _ctxMenuItems.length) {
    _ctxMenuActiveIdx = -1;
  } else {
    _ctxMenuActiveIdx = idx;
  }
  _ctxMenuEl.querySelectorAll('.context-menu-item').forEach((btn, i) => {
    btn.classList.toggle('is-active', i === _ctxMenuActiveIdx);
  });
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
    let next = _ctxMenuActiveIdx + 1;
    while (next < _ctxMenuItems.length && _ctxMenuItems[next].disabled) next += 1;
    if (next < _ctxMenuItems.length) _setActiveIdx(next);
    return;
  }
  if (e.key === 'ArrowUp') {
    e.preventDefault();
    let prev = _ctxMenuActiveIdx - 1;
    while (prev >= 0 && _ctxMenuItems[prev].disabled) prev -= 1;
    if (prev >= 0) _setActiveIdx(prev);
    return;
  }
  if (e.key === 'Enter') {
    if (_ctxMenuActiveIdx < 0) return;
    const it = _ctxMenuItems[_ctxMenuActiveIdx];
    if (!it || it.disabled) return;
    e.preventDefault();
    closeContextMenu();
    try { it.onClick(); }
    catch (err) { _ctxMenuLog.warn('item onClick threw on Enter', err); }
  }
});

window.addEventListener('scroll', () => closeContextMenu(), true);
window.addEventListener('resize', () => closeContextMenu());
window.addEventListener('i18n-change', () => closeContextMenu());

window.showContextMenu = showContextMenu;
window.closeContextMenu = closeContextMenu;
