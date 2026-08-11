// ─── Shared composer model picker ─────────────────────────────────────────
// Every model-backed composer exposes the same locally configured priority
// list. Picking an entry moves it to the front; credentials and drag ordering
// remain owned by Settings > Models.

let _composerModelEntries = [];
let _composerModelMenu = null;
let _composerModelBusy = false;
let _composerModelOptionsByProvider = new Map();
const _composerModelLog = createLogger('composer-model-picker');

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

function _composerModelEntryIsOfficial(_entry) {
  // Managed/official subscription entries are filtered from the open build;
  // every remaining composer entry is configured by the user.
  return false;
}

function _composerModelProviderLabel(entry) {
  const labelKey = String((entry && entry.providerLabelKey) || '').trim();
  if (labelKey) return t(labelKey);
  return String((entry && (entry.providerLabel || entry.provider)) || '').trim();
}

function _composerModelAccountLabel(entry) {
  return [
    _composerModelProviderLabel(entry),
    String((entry && entry.profileLabel) || '').trim(),
  ].filter(Boolean).join(' · ');
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
  const first = _composerModelEntries.find((entry) => entry && entry.selectable !== false);
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
    const res = await window.orkas.invoke('auth.listComposerEntries');
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

function _composerModelVersionOptions(entry) {
  const models = _composerModelOptionsByProvider.get(String((entry && entry.provider) || ''));
  const options = Array.isArray(models)
    ? models
      .filter((model) => model && typeof model.id === 'string' && model.id.trim())
      .map((model) => ({ id: model.id, name: String(model.name || model.id) }))
    : [];
  if (entry && !_composerModelEntryIsOfficial(entry) && entry.model
      && !options.some((model) => model.id === entry.model)) {
    options.unshift({ id: entry.model, name: _composerModelEntryLabel(entry) });
  }
  return options;
}

async function _refreshComposerModelOptions(entries) {
  const providers = Array.from(new Set((Array.isArray(entries) ? entries : [])
    .filter((entry) => (
      entry
      && !_composerModelEntryIsOfficial(entry)
      && entry.modelEditable !== false
      && entry.selectable !== false
      && entry.provider
    ))
    .map((entry) => String(entry.provider))));
  const results = await Promise.all(providers.map(async (provider) => {
    try {
      const res = await window.orkas.invoke('auth.listModels', { provider });
      return [provider, res && res.ok && Array.isArray(res.models) ? res.models : []];
    } catch (_) {
      _composerModelLog.warn('model version discovery failed', { provider });
      return [provider, []];
    }
  }));
  _composerModelOptionsByProvider = new Map(results);
}

function _closeComposerModelMenu() {
  if (!_composerModelMenu) return;
  _closeComposerModelVersionMenu();
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

function _clearComposerModelVersionCloseTimer() {
  if (!_composerModelMenu || !_composerModelMenu.versionCloseTimer) return;
  clearTimeout(_composerModelMenu.versionCloseTimer);
  _composerModelMenu.versionCloseTimer = null;
}

function _closeComposerModelVersionMenu({ focusOwner = false } = {}) {
  if (!_composerModelMenu) return;
  _clearComposerModelVersionCloseTimer();
  const { versionMenu, versionOwner } = _composerModelMenu;
  versionOwner?.classList.remove('is-version-open');
  const versionTrigger = versionOwner?.querySelector('.composer-model-menu-disclosure');
  versionTrigger?.setAttribute('aria-expanded', 'false');
  versionMenu?.remove();
  _composerModelMenu.versionMenu = null;
  _composerModelMenu.versionOwner = null;
  if (focusOwner) versionTrigger?.focus();
}

function _scheduleComposerModelVersionMenuClose() {
  if (!_composerModelMenu) return;
  _clearComposerModelVersionCloseTimer();
  const menuState = _composerModelMenu;
  menuState.versionCloseTimer = setTimeout(() => {
    if (_composerModelMenu === menuState) _closeComposerModelVersionMenu();
  }, 120);
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

function _composerModelCascadePlacement(ownerRect, menuSize, viewportWidth, viewportHeight) {
  const edge = 8;
  const gap = 5;
  const width = Math.min(menuSize.width, Math.max(0, viewportWidth - (edge * 2)));
  const maxHeight = Math.max(0, viewportHeight - (edge * 2));
  const visibleHeight = Math.min(menuSize.height, maxHeight);
  const rightLeft = ownerRect.right + gap;
  const leftLeft = ownerRect.left - gap - width;
  const openLeft = rightLeft + width > viewportWidth - edge && leftLeft >= edge;
  const preferredLeft = openLeft ? leftLeft : rightLeft;
  return {
    left: Math.max(edge, Math.min(preferredLeft, viewportWidth - width - edge)),
    top: Math.max(edge, Math.min(ownerRect.top, viewportHeight - visibleHeight - edge)),
    maxHeight,
    openLeft,
  };
}

function _positionComposerModelVersionMenu(versionMenu, owner) {
  if (!versionMenu || !owner) return;
  versionMenu.style.maxHeight = '';
  const rect = versionMenu.getBoundingClientRect();
  const placement = _composerModelCascadePlacement(
    owner.getBoundingClientRect(),
    { width: rect.width, height: Math.max(rect.height, versionMenu.scrollHeight || 0) },
    window.innerWidth || document.documentElement.clientWidth,
    window.innerHeight || document.documentElement.clientHeight,
  );
  versionMenu.style.left = `${placement.left}px`;
  versionMenu.style.top = `${placement.top}px`;
  versionMenu.style.maxHeight = `${placement.maxHeight}px`;
  versionMenu.dataset.placement = placement.openLeft ? 'left' : 'right';
}

function _openComposerModelVersionMenu(owner, versionMenu, { focusFirst = false } = {}) {
  if (!_composerModelMenu || !owner || !versionMenu) return;
  _clearComposerModelVersionCloseTimer();
  if (_composerModelMenu.versionMenu !== versionMenu) {
    _closeComposerModelVersionMenu();
    _composerModelMenu.versionMenu = versionMenu;
    _composerModelMenu.versionOwner = owner;
    versionMenu.style.visibility = 'hidden';
    document.body.appendChild(versionMenu);
  }
  owner.classList.add('is-version-open');
  owner.querySelector('.composer-model-menu-disclosure')?.setAttribute('aria-expanded', 'true');
  _positionComposerModelVersionMenu(versionMenu, owner);
  versionMenu.style.visibility = '';
  if (focusFirst) versionMenu.querySelector('button')?.focus();
}

async function _selectComposerModel(entry) {
  if (_composerModelBusy || !entry || !entry.entryId) return;
  const requestedModel = String(entry.model || '').trim();
  _composerModelBusy = true;
  const previousEntries = _composerModelEntries.slice();
  try {
    const res = await window.orkas.invoke('auth.selectEntry', {
      entryId: entry.entryId,
      ...(requestedModel ? { model: requestedModel } : {}),
    });
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

function _setComposerModelVersionItemCurrent(item, current) {
  if (!item) return;
  item.setAttribute('aria-checked', current ? 'true' : 'false');
  item.classList.toggle('is-current', current);
  const existingDot = item.querySelector('.composer-model-menu-version-current-dot');
  if (current && !existingDot) {
    const dot = document.createElement('span');
    dot.className = 'composer-model-menu-version-current-dot';
    dot.textContent = '●';
    dot.setAttribute('aria-hidden', 'true');
    item.appendChild(dot);
  } else if (!current) {
    existingDot?.remove();
  }
}

async function _updateComposerModelVersion(entry, _target, version, item, versionList) {
  if (_composerModelBusy || !entry || !entry.entryId || entry.selectable === false || !version) return;
  const requestedModel = String(version.id || '').trim();
  if (!requestedModel || requestedModel === String(entry.model || '').trim()) return;
  _composerModelBusy = true;
  try {
    const res = await window.orkas.invoke('auth.updateEntryModel', {
      entryId: entry.entryId,
      model: requestedModel,
    });
    if (!res || !res.ok) throw new Error('model version update failed');
    const modelName = String(version.name || requestedModel);
    entry.model = requestedModel;
    entry.modelName = modelName;
    const index = _composerModelEntries.findIndex((candidate) => candidate.entryId === entry.entryId);
    if (index >= 0) {
      _composerModelEntries[index] = { ..._composerModelEntries[index], model: requestedModel, modelName };
    }
    item?.querySelector('.composer-model-menu-current-model')?.replaceChildren(modelName);
    versionList?.querySelectorAll('.composer-model-menu-version-item').forEach((versionItem) => {
      _setComposerModelVersionItemCurrent(versionItem, versionItem.dataset.model === requestedModel);
    });
    _renderComposerModelChips();
    try {
      window.dispatchEvent(new CustomEvent('orkas:model-entries-changed', {
        detail: { entries: _composerModelEntries },
      }));
    } catch (_) {}
  } catch (err) {
    _composerModelLog.warn('model version update failed', {
      error_type: err && typeof err.name === 'string' ? err.name : 'unknown',
    });
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
  const item = document.createElement('div');
  item.className = `composer-model-menu-item${isActive ? ' is-active' : ''}`;
  item.dataset.entryId = entry.entryId;
  const disabled = entry.selectable === false;
  if (disabled) item.classList.add('is-disabled');

  const select = document.createElement('button');
  select.type = 'button';
  select.className = 'composer-model-menu-select';
  select.setAttribute('role', 'menuitemradio');
  select.setAttribute('aria-checked', isActive ? 'true' : 'false');
  select.disabled = disabled;
  select.setAttribute('aria-disabled', disabled ? 'true' : 'false');

  const copy = document.createElement('span');
  copy.className = 'composer-model-menu-copy';
  const title = document.createElement('span');
  title.className = 'composer-model-menu-title';
  const titleName = document.createElement('span');
  titleName.className = 'composer-model-menu-title-name';
  titleName.textContent = _composerModelProviderLabel(entry) || _composerModelEntryLabel(entry);
  title.appendChild(titleName);
  copy.appendChild(title);
  const account = String((entry && entry.profileLabel) || '').trim();
  const currentModelName = _composerModelEntryLabel(entry);
  if (account || currentModelName) {
    const meta = document.createElement('span');
    meta.className = 'composer-model-menu-meta';
    if (account) {
      const accountLabel = document.createElement('span');
      accountLabel.className = 'composer-model-menu-account-label';
      accountLabel.textContent = account;
      meta.appendChild(accountLabel);
    }
    if (account && currentModelName) {
      const separator = document.createElement('span');
      separator.className = 'composer-model-menu-meta-separator';
      separator.textContent = ' · ';
      meta.appendChild(separator);
    }
    if (currentModelName) {
      const modelLabel = document.createElement('span');
      modelLabel.className = 'composer-model-menu-current-model';
      modelLabel.textContent = currentModelName;
      meta.appendChild(modelLabel);
    }
    copy.appendChild(meta);
  }
  if (disabled) {
    const state = document.createElement('span');
    state.className = 'composer-model-menu-state';
    state.textContent = entry.availability === 'user_disabled'
      ? t('new_chat.model_picker.disabled')
      : (String(entry.availabilityReason || '').trim().slice(0, 200)
        || t('new_chat.model_picker.unavailable'));
    copy.appendChild(state);
  }
  select.appendChild(copy);

  if (isActive) {
    const check = document.createElement('span');
    check.className = 'composer-model-menu-check';
    check.innerHTML = typeof window.uiIconHtml === 'function'
      ? window.uiIconHtml('check', 'ui-icon')
      : '✓';
    select.appendChild(check);
  }
  select.addEventListener('click', async () => {
    if (disabled) return;
    _closeComposerModelMenu();
    await _selectComposerModel(entry);
    anchor.focus();
  });
  item.appendChild(select);

  const versions = entry.modelEditable !== false
    ? _composerModelVersionOptions(entry)
    : [];
  if (!disabled && versions.length > 1) {
    const disclosure = document.createElement('button');
    disclosure.type = 'button';
    disclosure.className = 'composer-model-menu-disclosure';
    disclosure.innerHTML = typeof window.uiIconHtml === 'function'
      ? window.uiIconHtml('chevron-right', 'ui-icon')
      : '›';
    disclosure.setAttribute('role', 'menuitem');
    disclosure.setAttribute('aria-haspopup', 'menu');
    disclosure.setAttribute('aria-expanded', 'false');
    disclosure.setAttribute('aria-label', t('new_chat.model_picker.choose_version', {
      account: _composerModelAccountLabel(entry) || _composerModelEntryLabel(entry),
    }));
    item.appendChild(disclosure);

    const versionList = document.createElement('div');
    versionList.className = 'composer-model-menu-version-list';
    versionList.dataset.entryId = entry.entryId;
    versionList.setAttribute('role', 'menu');
    versionList.setAttribute('aria-label', t('new_chat.model_picker.version_list', {
      account: _composerModelAccountLabel(entry) || _composerModelEntryLabel(entry),
    }));
    versions.forEach((version) => {
      const versionItem = document.createElement('button');
      versionItem.type = 'button';
      versionItem.className = 'composer-model-menu-version-item';
      versionItem.dataset.model = version.id;
      versionItem.setAttribute('role', 'menuitemradio');
      const current = version.id === entry.model;
      versionItem.setAttribute('aria-checked', current ? 'true' : 'false');
      const label = document.createElement('span');
      label.className = 'composer-model-menu-version-label';
      label.textContent = version.name;
      versionItem.appendChild(label);
      _setComposerModelVersionItemCurrent(versionItem, current);
      versionItem.addEventListener('click', async (event) => {
        event.stopPropagation();
        await _updateComposerModelVersion(
          entry,
          anchor.dataset.composerModelChip,
          version,
          item,
          versionList,
        );
      });
      versionList.appendChild(versionItem);
    });

    item.addEventListener('mouseenter', () => {
      _openComposerModelVersionMenu(item, versionList);
    });
    item.addEventListener('mouseleave', () => {
      _scheduleComposerModelVersionMenuClose();
    });
    disclosure.addEventListener('click', (event) => {
      event.stopPropagation();
      event.preventDefault();
      _openComposerModelVersionMenu(item, versionList, { focusFirst: true });
    });
    select.addEventListener('keydown', (event) => {
      if (event.key !== 'ArrowRight') return;
      event.preventDefault();
      _openComposerModelVersionMenu(item, versionList, { focusFirst: true });
    });
    versionList.addEventListener('mouseenter', _clearComposerModelVersionCloseTimer);
    versionList.addEventListener('mouseleave', _scheduleComposerModelVersionMenuClose);
    versionList.addEventListener('keydown', (event) => {
      if (event.key !== 'ArrowLeft' && event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      _closeComposerModelVersionMenu({ focusOwner: true });
    });
  }
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
  await _refreshComposerModelOptions(_composerModelEntries);
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
    const versionMenu = _composerModelMenu?.versionMenu;
    if (!menu.contains(event.target)
        && !versionMenu?.contains(event.target)
        && !anchor.contains(event.target)) {
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
    const versionMenu = _composerModelMenu?.versionMenu;
    const eventNode = event?.target && event.target.nodeType ? event.target : null;
    const insideParent = !!eventNode && menu.contains(eventNode);
    const insideVersionMenu = !!eventNode && !!versionMenu?.contains(eventNode);
    if (insideParent || insideVersionMenu) {
      if (event.type === 'scroll' && insideParent) {
        _closeComposerModelVersionMenu();
      }
      return;
    }
    _positionComposerModelMenu(menu, anchor);
    if (versionMenu && _composerModelMenu?.versionOwner) {
      _positionComposerModelVersionMenu(versionMenu, _composerModelMenu.versionOwner);
    }
  };
  _composerModelMenu = {
    element: menu,
    anchor,
    onOutside,
    onKeydown,
    onViewportChange,
    versionMenu: null,
    versionOwner: null,
    versionCloseTimer: null,
  };
  setTimeout(() => document.addEventListener('mousedown', onOutside), 0);
  document.addEventListener('keydown', onKeydown);
  window.addEventListener('resize', onViewportChange);
  window.addEventListener('scroll', onViewportChange, true);
  (menu.querySelector('.composer-model-menu-item.is-active .composer-model-menu-select')
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
  try {
    if (window.orkas && typeof window.orkas.onPushEvent === 'function') {
      window.orkas.onPushEvent('client-config:changed', (payload) => {
        const keys = Array.isArray(payload && payload.keys) ? payload.keys : [];
        if (!keys.includes('model_catalog')) return;
        if (_composerModelMenu) _closeComposerModelMenu();
        _refreshComposerModelEntries().catch(() => {});
      });
    }
  } catch (_) {}
  window.addEventListener('i18n-change', () => {
    _renderComposerModelChips();
    if (_composerModelMenu) _closeComposerModelMenu();
  });
  _refreshComposerModelEntries().catch(() => {});
});
