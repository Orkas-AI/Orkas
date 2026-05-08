// ─── Avatar picker (combined icon + color popover) ───────────────────────
//
// Single popover containing two rows: icon grid + color grid. Each
// selection fires the callback and the UI updates immediately to
// reflect the new combination. Reuses `window.positionPickerPopover`
// for layout (the same helper agent/skill/agent picker uses), so the
// visual style stays consistent.
//
// Entry: openAvatarPicker(anchorEl, current, opts, onChange)
//   anchorEl:  the anchor element used for positioning.
//   current:   { icon, color }, used to highlight the current pick.
//   opts:
//     allowCommanderCombo: false — when true, crown / gold are not
//                                  filtered out (used by the
//                                  commander avatar settings).
//     hideIcons: false           — when true, only the color row is
//                                  rendered (the commander avatar's
//                                  icon is always crown).
//   onChange:  ({ icon, color }) => void, fires on every selection.

let _avatarPickerEl = null;
let _avatarPickerCurrent = null;
let _avatarPickerOpts = null;
let _avatarPickerOnChange = null;
let _avatarPickerOutsideBound = false;

function _ensureAvatarPickerDom() {
  if (_avatarPickerEl) return _avatarPickerEl;
  const el = document.createElement('div');
  el.id = 'avatar-picker';
  el.className = 'avatar-picker';
  el.style.display = 'none';
  el.innerHTML = `
    <div class="avatar-picker-section" data-role="icon-section">
      <div class="avatar-picker-label" data-i18n="avatar.icon_label">Icon</div>
      <div class="avatar-picker-grid" data-role="icon-grid"></div>
    </div>
    <div class="avatar-picker-section">
      <div class="avatar-picker-label" data-i18n="avatar.color_label">Color</div>
      <div class="avatar-picker-grid" data-role="color-grid"></div>
    </div>
  `;
  document.body.appendChild(el);
  _avatarPickerEl = el;
  if (!_avatarPickerOutsideBound) {
    _avatarPickerOutsideBound = true;
    document.addEventListener('click', (e) => {
      if (!_avatarPickerEl || _avatarPickerEl.style.display === 'none') return;
      if (_avatarPickerEl.contains(e.target)) return;
      // Don't close if click landed on the anchor that opened us — anchor's
      // own click handler is in charge of toggling closed.
      const anchor = _avatarPickerEl._anchor;
      if (anchor && anchor.contains(e.target)) return;
      closeAvatarPicker();
    });
    document.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return;
      if (_avatarPickerEl && _avatarPickerEl.style.display !== 'none') {
        closeAvatarPicker();
        e.preventDefault();
      }
    });
    window.addEventListener('scroll', closeAvatarPicker, true);
    window.addEventListener('resize', closeAvatarPicker);
  }
  if (typeof applyDomI18n === 'function') applyDomI18n(el);
  return el;
}

function _renderAvatarPicker() {
  const el = _ensureAvatarPickerDom();
  const allowCommander = !!(_avatarPickerOpts && _avatarPickerOpts.allowCommanderCombo);
  const hideIcons = !!(_avatarPickerOpts && _avatarPickerOpts.hideIcons);
  const iconSection = el.querySelector('[data-role="icon-section"]');
  const iconGrid = el.querySelector('[data-role="icon-grid"]');
  const colorGrid = el.querySelector('[data-role="color-grid"]');
  const cur = _avatarPickerCurrent || { icon: '', color: '' };

  if (iconSection) iconSection.style.display = hideIcons ? 'none' : '';

  const icons = AVATAR_ICONS.filter((i) => allowCommander || i.id !== COMMANDER_DEFAULT.icon);
  const colors = AVATAR_COLORS.filter((c) => allowCommander || c.id !== COMMANDER_DEFAULT.color);

  // i18n.t returns the raw key if no entry exists in either locale, so fall
  // back to the JSON-side English `label` for forward compatibility when a
  // new icon/color is added to avatars.json without a matching locale key.
  const _avatarLabel = (key, fallback) => {
    const r = t(key);
    return r === key ? fallback : r;
  };

  iconGrid.innerHTML = icons.map((i) => {
    const active = i.id === cur.icon ? ' is-active' : '';
    const label = _avatarLabel('avatar.icon.' + i.id, i.label);
    return `<button type="button" class="avatar-picker-cell avatar-picker-icon-cell${active}" data-icon="${i.id}" title="${label}" aria-label="${label}">${i.svg}</button>`;
  }).join('');

  colorGrid.innerHTML = colors.map((c) => {
    const active = c.id === cur.color ? ' is-active' : '';
    const label = _avatarLabel('avatar.color.' + c.id, c.label);
    return `<button type="button" class="avatar-picker-cell avatar-picker-color-cell${active}" data-color="${c.id}" style="background:${c.bg};color:${c.fg}" title="${label}" aria-label="${label}"></button>`;
  }).join('');

  iconGrid.querySelectorAll('[data-icon]').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      _avatarPickerCurrent = { ..._avatarPickerCurrent, icon: btn.dataset.icon };
      _renderAvatarPicker();
      _avatarPickerOnChange?.({ ..._avatarPickerCurrent });
    });
  });
  colorGrid.querySelectorAll('[data-color]').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      _avatarPickerCurrent = { ..._avatarPickerCurrent, color: btn.dataset.color };
      _renderAvatarPicker();
      _avatarPickerOnChange?.({ ..._avatarPickerCurrent });
    });
  });
}

function openAvatarPicker(anchorEl, current, opts, onChange) {
  if (!anchorEl) return;
  _avatarPickerCurrent = { icon: current?.icon || '', color: current?.color || '' };
  _avatarPickerOpts = opts || {};
  _avatarPickerOnChange = typeof onChange === 'function' ? onChange : null;
  const el = _ensureAvatarPickerDom();
  el._anchor = anchorEl;
  _renderAvatarPicker();
  if (typeof window.positionPickerPopover === 'function') {
    window.positionPickerPopover(el, anchorEl);
  } else {
    const rect = anchorEl.getBoundingClientRect();
    el.style.display = 'flex';
    el.style.left = rect.left + 'px';
    el.style.top = (rect.bottom + 8) + 'px';
  }
}

function closeAvatarPicker() {
  if (_avatarPickerEl) {
    _avatarPickerEl.style.display = 'none';
    _avatarPickerEl._anchor = null;
  }
  _avatarPickerOnChange = null;
  _avatarPickerCurrent = null;
  _avatarPickerOpts = null;
}

function isAvatarPickerOpenFor(anchorEl) {
  return !!(_avatarPickerEl
    && _avatarPickerEl.style.display !== 'none'
    && _avatarPickerEl._anchor === anchorEl);
}
