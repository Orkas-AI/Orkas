// ─── Shared composer model picker ─────────────────────────────────────────
// Every model-backed composer exposes the same locally configured priority
// list. Picking an entry moves it to the front; credentials and drag ordering
// remain owned by Settings > Models.

let _composerModelEntries = [];
let _composerModelMenu = null;
let _composerModelBusy = false;

const _COMPOSER_MODEL_PICKER_TARGETS = [
  { selector: '#panel-new-chat .chat-bottom-bar', target: 'new-chat' },
  { selector: '#panel-conversation .chat-bottom-bar', target: 'conversation' },
  { selector: '#panel-project .chat-bottom-bar', target: 'project' },
  { selector: '#auto-task-dialog-overlay .chat-bottom-bar', target: 'auto' },
  { selector: '#skills-chat-col .skills-chat-input-area', target: 'skill-edit', compact: true },
  { selector: '#agents-chat-col .agents-chat-input-area', target: 'agent-edit', compact: true },
];

const _COMPOSER_RECIPIENT_TARGETS = ['new-chat', 'conversation', 'project', 'auto'];

function _composerRecipientForTarget(target) {
  try {
    if (target === 'auto') {
      return typeof window._autoGetRecipient === 'function'
        ? window._autoGetRecipient()
        : null;
    }
    return typeof getChatRecipient === 'function'
      ? getChatRecipient(target)
      : null;
  } catch (_) {
    return null;
  }
}

function _composerRecipientUsesExternalAgent(target) {
  const recipient = _composerRecipientForTarget(target);
  if (!recipient || recipient.kind !== 'agent' || !recipient.id) return false;
  if (typeof _agentsCache === 'undefined' || !Array.isArray(_agentsCache)) return false;
  const agent = _agentsCache.find((item) => item && item.agent_id === recipient.id);
  return !!(agent && agent.runtime && agent.runtime.kind === 'cli');
}

function _syncComposerModelChipAvailability(target) {
  const targets = target ? [target] : _COMPOSER_RECIPIENT_TARGETS;
  targets.forEach((item) => {
    const chip = document.querySelector(`[data-composer-model-chip="${item}"]`);
    if (!chip) return;
    const disabled = _composerRecipientUsesExternalAgent(item);
    if (disabled && _composerModelMenu?.anchor === chip) _closeComposerModelMenu();
    chip.disabled = disabled;
  });
}

function _composerModelEntryLabel(entry) {
  const model = String((entry && (entry.modelName || entry.model)) || '');
  const modelName = model
    .split(/\s*·\s*/)
    .map((part) => part.trim())
    .filter(Boolean)
    .pop();
  return modelName
    || String((entry && entry.profileLabel) || '')
    || t('new_chat.model_picker.configure');
}

function _createComposerModelChip(target, compact) {
  const chip = document.createElement('button');
  chip.type = 'button';
  chip.className = `composer-model-chip${compact ? ' is-compact' : ''}`;
  chip.dataset.composerModelChip = target;
  chip.setAttribute('aria-haspopup', 'menu');
  chip.setAttribute('aria-expanded', 'false');
  chip.innerHTML = `
    <span class="composer-model-chip-name">${escapeHtml(t('new_chat.model_picker.loading'))}</span>
    ${typeof window.uiIconHtml === 'function' ? window.uiIconHtml('chevron-down', 'composer-model-chip-chevron') : ''}
  `;
  chip.addEventListener('click', () => _toggleComposerModelMenu(chip));
  return chip;
}

function _mountComposerModelChips() {
  for (const spec of _COMPOSER_MODEL_PICKER_TARGETS) {
    const container = document.querySelector(spec.selector);
    if (!container) continue;
    const chip = container.querySelector(`[data-composer-model-chip="${spec.target}"]`)
      || _createComposerModelChip(spec.target, !!spec.compact);
    const recipient = container.querySelector('.chat-recipient-chip');
    if (recipient) {
      container.insertBefore(chip, recipient);
      continue;
    }
    const input = container.querySelector('textarea');
    if (input) {
      container.insertBefore(chip, input);
      continue;
    }
    container.appendChild(chip);
  }
  _renderComposerModelChips();
}

function _renderComposerModelChips() {
  const first = _composerModelEntries[0];
  const label = first
    ? _composerModelEntryLabel(first)
    : t('new_chat.model_picker.configure');
  document.querySelectorAll('[data-composer-model-chip]').forEach((chip) => {
    const name = chip.querySelector('.composer-model-chip-name');
    if (name) name.textContent = label;
    chip.title = `${t('new_chat.model_picker.aria_label')}: ${label}`;
    chip.setAttribute('aria-label', `${t('new_chat.model_picker.aria_label')}: ${label}`);
  });
  _syncComposerModelChipAvailability();
}

async function _refreshComposerModelEntries() {
  try {
    const res = await window.orkas.invoke('auth.listEntries');
    if (res && res.ok && Array.isArray(res.entries)) {
      // Managed subscription models do not exist in the open-source build.
      // Keep this boundary defensive so a stale profile cannot surface one.
      _composerModelEntries = res.entries.filter((entry) => entry && entry.profileType !== 'managed');
    }
  } catch (_) {
    // Keep the previous snapshot. The model guard owns global error handling.
  }
  _renderComposerModelChips();
  return _composerModelEntries;
}

function _closeComposerModelMenu() {
  if (!_composerModelMenu) return;
  const {
    element,
    anchor,
    onOutside,
    onKeydown,
    onViewportChange,
  } = _composerModelMenu;
  element.remove();
  document.removeEventListener('mousedown', onOutside);
  document.removeEventListener('keydown', onKeydown);
  window.removeEventListener('resize', onViewportChange);
  window.removeEventListener('scroll', onViewportChange, true);
  anchor.classList.remove('is-open');
  anchor.setAttribute('aria-expanded', 'false');
  _composerModelMenu = null;
}

function _positionComposerModelMenu(menu, anchor) {
  const edge = 8;
  const gap = 7;
  const viewportWidth = window.innerWidth || document.documentElement.clientWidth;
  const viewportHeight = window.innerHeight || document.documentElement.clientHeight;
  const anchorRect = anchor.getBoundingClientRect();
  menu.style.maxHeight = '';
  const menuRect = menu.getBoundingClientRect();
  const fullHeight = Math.max(menuRect.height, menu.scrollHeight || 0);
  const placement = _dropdownVerticalPlacement(
    anchorRect,
    fullHeight,
    viewportHeight,
    { edge, gap },
  );
  const left = Math.max(
    edge,
    Math.min(anchorRect.right - menuRect.width, viewportWidth - menuRect.width - edge),
  );
  menu.style.left = `${left}px`;
  menu.style.top = `${placement.top}px`;
  menu.style.maxHeight = `${placement.availableHeight}px`;
  menu.dataset.placement = placement.openAbove ? 'top' : 'bottom';
}

async function _selectComposerModel(entry) {
  if (_composerModelBusy || !entry || !entry.entryId) return;
  _composerModelBusy = true;
  const previousEntries = _composerModelEntries.slice();
  try {
    const orderedIds = [
      entry.entryId,
      ...previousEntries
        .filter((item) => item.entryId !== entry.entryId)
        .map((item) => item.entryId),
    ];
    const res = await window.orkas.invoke('auth.reorderEntries', { orderedIds });
    if (!res || !res.ok) throw new Error('model reorder failed');
    _composerModelEntries = Array.isArray(res.entries)
      ? res.entries.filter((item) => item && item.profileType !== 'managed')
      : [
        entry,
        ...previousEntries.filter((item) => item.entryId !== entry.entryId),
      ];
    _renderComposerModelChips();
    try {
      window.dispatchEvent(new CustomEvent('orkas:model-entries-changed', {
        detail: { entries: _composerModelEntries },
      }));
    } catch (_) {}
  } catch (_) {
    if (typeof uiToast === 'function') {
      uiToast(t('new_chat.model_picker.switch_failed'), { variant: 'error' });
    }
  } finally {
    _composerModelBusy = false;
  }
}

function _openComposerModelSettings() {
  _closeComposerModelMenu();
  if (typeof _hideAutoDialog === 'function') _hideAutoDialog();
  if (typeof _markBootUserNavigation === 'function') _markBootUserNavigation();
  setView('settings', null, { entryPoint: 'composer_model_picker' });
  if (typeof _activateModelCredentialsTab === 'function') _activateModelCredentialsTab();
}

function _buildComposerModelMenuItem(entry, activeEntryId, anchor) {
  const isActive = entry.entryId === activeEntryId;
  const item = document.createElement('button');
  item.type = 'button';
  item.className = `composer-model-menu-item${isActive ? ' is-active' : ''}`;
  item.dataset.entryId = entry.entryId;
  item.setAttribute('role', 'menuitemradio');
  item.setAttribute('aria-checked', isActive ? 'true' : 'false');

  const copy = document.createElement('span');
  copy.className = 'composer-model-menu-copy';
  const title = document.createElement('span');
  title.className = 'composer-model-menu-title';
  title.textContent = _composerModelEntryLabel(entry);
  copy.appendChild(title);
  const account = String((entry && entry.profileLabel) || '').trim();
  if (account) {
    const meta = document.createElement('span');
    meta.className = 'composer-model-menu-meta';
    meta.textContent = account;
    copy.appendChild(meta);
  }
  item.appendChild(copy);

  if (isActive) {
    const check = document.createElement('span');
    check.className = 'composer-model-menu-check';
    check.innerHTML = typeof window.uiIconHtml === 'function'
      ? window.uiIconHtml('check', 'ui-icon')
      : '✓';
    item.appendChild(check);
  }

  item.addEventListener('click', async () => {
    _closeComposerModelMenu();
    await _selectComposerModel(entry);
    anchor.focus();
  });
  return item;
}

function _buildComposerModelMenuGroup(entries, activeEntryId, anchor) {
  const section = document.createElement('div');
  section.className = 'composer-model-menu-group';
  section.dataset.modelGroup = 'custom';
  section.setAttribute('role', 'group');
  section.setAttribute('aria-label', t('new_chat.model_picker.group_custom'));

  const header = document.createElement('div');
  header.className = 'composer-model-menu-group-header';
  const label = document.createElement('span');
  label.className = 'composer-model-menu-group-label';
  label.textContent = t('new_chat.model_picker.group_custom');
  label.setAttribute('aria-hidden', 'true');
  header.appendChild(label);
  section.appendChild(header);

  entries.forEach((entry) => {
    section.appendChild(_buildComposerModelMenuItem(entry, activeEntryId, anchor));
  });
  return section;
}

async function _toggleComposerModelMenu(anchor) {
  if (!anchor || anchor.disabled) return;
  if (_composerModelMenu) {
    const wasSameAnchor = _composerModelMenu.anchor === anchor;
    _closeComposerModelMenu();
    if (wasSameAnchor) return;
  }

  await _refreshComposerModelEntries();
  const menu = document.createElement('div');
  menu.id = 'composer-model-menu';
  menu.className = 'composer-model-menu';
  menu.setAttribute('role', 'menu');
  menu.setAttribute('aria-label', t('new_chat.model_picker.aria_label'));

  if (_composerModelEntries.length) {
    const activeEntryId = _composerModelEntries[0]?.entryId || '';
    menu.appendChild(_buildComposerModelMenuGroup(
      _composerModelEntries,
      activeEntryId,
      anchor,
    ));
  } else {
    const empty = document.createElement('div');
    empty.className = 'composer-model-menu-empty';
    empty.textContent = t('new_chat.model_picker.empty');
    menu.appendChild(empty);
  }

  const separator = document.createElement('div');
  separator.className = 'composer-model-menu-separator';
  menu.appendChild(separator);
  const configure = document.createElement('button');
  configure.type = 'button';
  configure.className = 'composer-model-menu-configure';
  configure.setAttribute('role', 'menuitem');
  configure.innerHTML = `
    ${typeof window.uiIconHtml === 'function' ? window.uiIconHtml('settings', 'composer-model-menu-configure-icon') : ''}
    <span>${escapeHtml(t('new_chat.model_picker.configure'))}</span>
  `;
  configure.addEventListener('click', _openComposerModelSettings);
  menu.appendChild(configure);

  menu.style.visibility = 'hidden';
  document.body.appendChild(menu);
  _positionComposerModelMenu(menu, anchor);
  menu.style.visibility = '';
  anchor.classList.add('is-open');
  anchor.setAttribute('aria-expanded', 'true');

  const onOutside = (event) => {
    if (!menu.contains(event.target) && !anchor.contains(event.target)) {
      _closeComposerModelMenu();
    }
  };
  const onKeydown = (event) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      _closeComposerModelMenu();
      anchor.focus();
    }
  };
  const onViewportChange = (event) => {
    if (event && menu.contains(event.target)) return;
    _positionComposerModelMenu(menu, anchor);
  };
  _composerModelMenu = {
    element: menu,
    anchor,
    onOutside,
    onKeydown,
    onViewportChange,
  };
  setTimeout(() => document.addEventListener('mousedown', onOutside), 0);
  document.addEventListener('keydown', onKeydown);
  window.addEventListener('resize', onViewportChange);
  window.addEventListener('scroll', onViewportChange, true);
  (menu.querySelector('.composer-model-menu-item.is-active')
    || menu.querySelector('button'))?.focus();
}

document.addEventListener('DOMContentLoaded', () => {
  _mountComposerModelChips();
  window.addEventListener('orkas:boot-ready', () => {
    _mountComposerModelChips();
    _refreshComposerModelEntries().catch(() => {});
  });
  window.addEventListener('orkas:model-entries-changed', (event) => {
    const entries = event && event.detail && event.detail.entries;
    if (Array.isArray(entries)) {
      _composerModelEntries = entries.filter((entry) => entry && entry.profileType !== 'managed');
      _renderComposerModelChips();
    } else {
      _refreshComposerModelEntries().catch(() => {});
    }
  });
  window.addEventListener('i18n-change', () => {
    _renderComposerModelChips();
    if (_composerModelMenu) _closeComposerModelMenu();
  });
  _refreshComposerModelEntries().catch(() => {});
});
