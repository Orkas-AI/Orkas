/* Generated from desktop AiSelect; run node scripts/update-builtin-app-controls.cjs. */
(function(){'use strict';
const t=key=>window.ContentLocales[document.documentElement.lang][{placeholder:'operation',empty:'noMatches',multiple:'selected'}[key.split('.')[1]]]||'';
function escapeHtml(str) {
  if (str === null || str === undefined) return '';
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#039;');
}

// ─── Shared dropdown vertical placement ───────────────────────────────────
// Standard anchored dropdowns open below their trigger. They only flip above
// when the full dropdown does not fit below and the upper side has more room.
// If neither side fits, callers constrain the dropdown to `availableHeight`.

function _dropdownVerticalPlacement(
  anchorRect,
  contentHeight,
  viewportHeight,
  options = {},
) {
  const edge = Number.isFinite(options.edge) ? Math.max(0, options.edge) : 8;
  const gap = Number.isFinite(options.gap) ? Math.max(0, options.gap) : 4;
  const aboveReferenceTop = Number.isFinite(options.aboveReferenceTop)
    ? options.aboveReferenceTop
    : anchorRect.top;
  const spaceAbove = Math.max(0, aboveReferenceTop - gap - edge);
  const spaceBelow = Math.max(0, viewportHeight - anchorRect.bottom - gap - edge);
  const fullHeight = Math.max(0, Number(contentHeight) || 0);
  const openAbove = fullHeight > spaceBelow && spaceAbove > spaceBelow;
  const availableHeight = openAbove ? spaceAbove : spaceBelow;
  const visibleHeight = Math.min(fullHeight, availableHeight);
  const top = openAbove
    ? Math.max(edge, aboveReferenceTop - gap - visibleHeight)
    : anchorRect.bottom + gap;

  return {
    openAbove,
    availableHeight,
    visibleHeight,
    spaceAbove,
    spaceBelow,
    top,
  };
}

const AI_SELECT_BASE_POPOVER_Z_INDEX = 14000;
let _aiSelectIdSeq = 0;

function _aiSelectNormalizeOptions(options) {
  if (!Array.isArray(options)) return [];
  const seen = new Set();
  const normalized = [];
  for (const raw of options) {
    if (!raw || typeof raw !== 'object' || typeof raw.value !== 'string' || seen.has(raw.value)) continue;
    seen.add(raw.value);
    normalized.push({
      ...raw,
      label: raw.label === null || raw.label === undefined ? raw.value : String(raw.label),
      hint: raw.hint === null || raw.hint === undefined ? '' : String(raw.hint),
      iconName: raw.iconName === null || raw.iconName === undefined ? '' : String(raw.iconName),
      ...(raw.disabled === true ? { disabled: true } : {}),
    });
  }
  return normalized;
}

function _aiSelectNextZIndex(values, fallback = AI_SELECT_BASE_POPOVER_Z_INDEX) {
  let z = fallback;
  for (const raw of values || []) {
    const n = Number.parseInt(String(raw || ''), 10);
    if (Number.isFinite(n)) z = Math.max(z, n + 1);
  }
  return z;
}

function _aiSelectPopoverZIndexFor(el) {
  const values = [];
  for (let n = el; n && n.nodeType === 1; n = n.parentElement) {
    const raw = window.getComputedStyle(n).zIndex;
    if (raw && raw !== 'auto') values.push(raw);
  }
  // Some modal systems put the high z-index on a sibling/backdrop instead
  // of an ancestor of the select. Include visible app overlays so a body-
  // portaled dropdown still paints above the current dialog layer.
  if (typeof document !== 'undefined' && document.body) {
    const layerSelector = [
      '.modal-overlay.open',
      '.ui-dialog-overlay.open',
      '[role="dialog"][aria-modal="true"]',
    ].join(',');
    for (const n of document.querySelectorAll(layerSelector)) {
      if (!n || n === el || n.hidden) continue;
      const style = window.getComputedStyle(n);
      if (style.display === 'none' || style.visibility === 'hidden') continue;
      if (style.zIndex && style.zIndex !== 'auto') values.push(style.zIndex);
    }
  }
  return _aiSelectNextZIndex(values);
}

function _aiSelectMount(el, config) {
  if (!el) return null;
  const state = {
    options: [],        // [{value, label, hint?, iconName?, avatar?, disabled?, group?, displayOnly?}]
    value: '',
    allowMultiple: false,
    multiple: false,
    values: [],
    placeholder: (t('ai_select.placeholder')),
    onChange: () => {},
    open: false,
    activeIdx: -1,
  };
  Object.assign(state, config || {});
  state.options = _aiSelectNormalizeOptions(state.options);
  state.value = typeof state.value === 'string' ? state.value : '';
  state.placeholder = String(state.placeholder || t('ai_select.placeholder'));
  if (state.value && !state.options.some(
    option => option.value === state.value && !option.disabled && typeof option.action !== 'function',
  )) state.value = '';

  state.multiple = state.allowMultiple && state.multiple === true;
  const disabled = option => option.disabled || (state.multiple && option.singleOnly);
  const normalizeValues = values => state.options
    .filter(option => !disabled(option) && typeof option.action !== 'function' && values.includes(option.value)).map(option => option.value);
  state.values = state.multiple ? normalizeValues(state.values) : (state.value ? [state.value] : []);

  const caretIcon = (typeof window !== 'undefined' && typeof window.uiIconHtml === 'function')
    ? window.uiIconHtml('chevron-down', 'ai-select-caret')
    : '';

  el.classList.add('ai-select');
  const controlId = el.id || `ai-select-${++_aiSelectIdSeq}`;
  const triggerId = `${controlId}-trigger`;
  const listboxId = `${controlId}-listbox`;
  const externalTrigger = state.anchor;
  const searchConfig = state.search;
  const accessibleName = () => String(
    state.ariaLabel
    || el.getAttribute?.('aria-label')
    || state.placeholder,
  );
  const selectedLabelId = `${triggerId}-value`;
  const triggerHtml = externalTrigger ? '' : `
    <button type="button" class="ai-select-trigger" id="${escapeHtml(triggerId)}"
      ${searchConfig ? `aria-describedby="${escapeHtml(selectedLabelId)}"` : 'role="combobox"'}
      aria-haspopup="listbox" aria-expanded="false"
      aria-controls="${escapeHtml(listboxId)}" aria-label="${escapeHtml(accessibleName())}">
      <span class="ai-select-label"${searchConfig ? ` id="${escapeHtml(selectedLabelId)}"` : ''}></span>
      ${caretIcon}
    </button>`;
  const popoverHtml = searchConfig ? `
    <div class="ai-select-popover is-searchable" hidden>
      <div class="ai-select-search">
        ${typeof uiIconHtml === 'function' ? uiIconHtml('search', 'ai-select-search-icon') : ''}
        <input class="ai-select-search-input" type="text" role="combobox" aria-autocomplete="list" aria-expanded="true" aria-controls="${escapeHtml(listboxId)}" autocomplete="off">
        <button class="ai-select-search-clear" type="button" tabindex="-1" hidden>${typeof uiIconHtml === 'function' ? uiIconHtml('x', 'ai-select-search-icon') : '&#215;'}</button>
      </div>
      <div class="ai-select-results" id="${escapeHtml(listboxId)}" role="listbox"></div>
      <div class="ai-select-empty ai-select-no-match" role="status" hidden></div>
    </div>` : `<div class="ai-select-popover" id="${escapeHtml(listboxId)}"
      role="listbox" aria-labelledby="${escapeHtml(triggerId)}" hidden></div>`;
  el.innerHTML = triggerHtml + popoverHtml;

  const trigger = externalTrigger || el.querySelector('.ai-select-trigger');
  const labelEl = el.querySelector('.ai-select-label');
  const popover = el.querySelector('.ai-select-popover');
  const input = searchConfig ? popover.querySelector('input') : null;
  const clearSearch = searchConfig ? popover.querySelector('.ai-select-search-clear') : null;
  const noMatch = searchConfig ? popover.querySelector('.ai-select-no-match') : null;
  const listbox = searchConfig ? popover.querySelector('.ai-select-results') : popover;
  if (externalTrigger && !searchConfig) {
    listbox.removeAttribute('aria-labelledby');
    listbox.setAttribute('aria-label', accessibleName());
  }
  const focusOwner = input || trigger;
  let visibleOptions = state.options;
  let optionNodes = [];

  const renderOptionLabel = (target, opt) => {
    target.innerHTML = '';
    if (opt && opt.avatar && typeof renderAvatarHtml === 'function') {
      const avatar = document.createElement('span');
      avatar.className = 'ai-select-option-icon';
      avatar.setAttribute('aria-hidden', 'true');
      avatar.innerHTML = renderAvatarHtml(opt.avatar.icon, opt.avatar.color, {
        size: 18, seed: opt.avatar.seed,
      });
      target.appendChild(avatar);
    } else if (opt && opt.iconName && typeof window !== 'undefined' && typeof window.uiIconHtml === 'function') {
      const iconWrap = document.createElement('span');
      iconWrap.className = 'ai-select-option-icon';
      iconWrap.innerHTML = window.uiIconHtml(opt.iconName, 'ui-icon ai-select-svg-icon');
      target.appendChild(iconWrap);
    }
    const text = document.createElement('span');
    text.textContent = opt ? opt.label : state.placeholder;
    target.appendChild(text);
  };

  const renderTrigger = () => {
    el.dataset.value = state.value || '';
    if (input) {
      listbox.setAttribute('aria-label', accessibleName());
      input.placeholder = t(searchConfig.placeholderKey);
      input.setAttribute('aria-label', input.placeholder);
      clearSearch.setAttribute('aria-label', t('common.clear'));
    }
    if (externalTrigger) return;
    trigger.setAttribute('aria-label', accessibleName());
    const selected = state.multiple ? state.options.filter(o => state.values.includes(o.value)) : [];
    const opt = state.multiple
      ? (selected.length ? { label: selected.map(o => o.label).join(t('ai_select.separator')) } : null)
      : state.options.find(o => o.value === state.value);
    if (opt) {
      renderOptionLabel(labelEl, opt);
      labelEl.classList.remove('placeholder');
    } else {
      renderOptionLabel(labelEl, null);
      labelEl.classList.add('placeholder');
    }
    if (state.allowMultiple) {
      el.dataset.values = JSON.stringify(state.values);
      trigger.title = opt ? opt.label : '';
      trigger.setAttribute('aria-label', opt ? accessibleName() + ': ' + opt.label : accessibleName());
    }
  };

  const setActiveIndex = (idx, scroll = false) => {
    optionNodes[state.activeIdx]?.classList.remove('hover');
    state.activeIdx = idx;
    const item = optionNodes[idx];
    if (item) {
      item.classList.add('hover');
      focusOwner.setAttribute('aria-activedescendant', item.id);
      if (scroll) item.scrollIntoView({ block: 'nearest' });
    } else focusOwner.removeAttribute('aria-activedescendant');
  };

  const renderPopover = () => {
    const scrollTop = listbox.scrollTop;
    listbox.replaceChildren();
    listbox.setAttribute('aria-multiselectable', String(state.multiple));
    optionNodes = [];
    if (state.allowMultiple) {
      const header = document.createElement('label');
      header.className = 'ai-select-multiple-row';
      header.textContent = t('ai_select.multiple');
      const toggle = document.createElement('input');
      toggle.type = 'checkbox';
      toggle.className = 'ai-select-multiple-toggle';
      toggle.setAttribute('role', 'switch');
      toggle.checked = state.multiple;
      toggle.addEventListener('change', () => {
        api.setMultiple(toggle.checked);
        state.onChange(state.multiple ? [...state.values] : state.value);
        popover.querySelector('.ai-select-multiple-toggle')?.focus();
      });
      header.appendChild(toggle);
      listbox.appendChild(header);
    }
    if (noMatch) {
      noMatch.hidden = visibleOptions.length > 0;
      noMatch.textContent = visibleOptions.length ? '' : t(searchConfig.emptyKey);
    } else if (visibleOptions.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'ai-select-empty';
      empty.textContent = t('ai_select.empty');
      listbox.appendChild(empty);
    }
    const groups = new Map();
    visibleOptions.forEach((opt, idx) => {
      const item = document.createElement('div');
      item.className = 'ai-select-item' + (typeof opt.action === 'function' ? ' is-action' : '');
      item.id = `${listboxId}-option-${idx}`;
      item.dataset.value = opt.value;
      item.setAttribute('role', 'option');
      const selected = state.multiple ? state.values.includes(opt.value) : opt.value === state.value;
      item.setAttribute('aria-selected', selected ? 'true' : 'false');
      item.setAttribute('aria-disabled', disabled(opt) ? 'true' : 'false');
      if (selected) item.classList.add('active');
      if (disabled(opt)) item.classList.add('disabled');
      const main = document.createElement('div');
      main.className = 'ai-select-item-label';
      renderOptionLabel(main, opt);
      item.appendChild(main);
      if ((state.multiple || state.showCheck) && selected) {
        const check = document.createElement('span');
        check.className = 'ai-select-check';
        check.setAttribute('aria-hidden', 'true');
        check.innerHTML = typeof window.uiIconHtml === 'function' ? window.uiIconHtml('check', 'ui-icon') : '\u2713';
        main.appendChild(check);
      }
      if (opt.hint) {
        const hint = document.createElement('div');
        hint.className = 'ai-select-item-hint';
        hint.textContent = opt.hint;
        item.appendChild(hint);
      }
      item.addEventListener('mousedown', (e) => {
        e.preventDefault();
        if (disabled(opt)) return;
        _aiSelectPick(api, opt.value);
      });
      item.addEventListener('mouseenter', () => {
        if (disabled(opt)) return;
        setActiveIndex(idx);
      });
      let parent = listbox;
      if (input && opt.group) {
        if (!groups.has(opt.group)) {
          const group = document.createElement('div');
          const heading = document.createElement('div');
          const label = t(opt.group);
          group.setAttribute('role', 'group');
          group.setAttribute('aria-label', label);
          heading.className = 'ai-select-group-label';
          heading.setAttribute('aria-hidden', 'true');
          heading.textContent = label;
          group.appendChild(heading);
          listbox.appendChild(group);
          groups.set(opt.group, group);
        }
        parent = groups.get(opt.group);
      }
      parent.appendChild(item);
      optionNodes.push(item);
    });
    if (state.allowMultiple || input) listbox.scrollTop = scrollTop;
    setActiveIndex(state.activeIdx);
  };

  const refreshVisibleOptions = () => {
    if (!input) {
      visibleOptions = state.options;
      return;
    }
    const query = input.value.trim().toLowerCase();
    const groups = new Map();
    for (const option of state.options) {
      if (option.displayOnly) continue;
      const name = option.label.toLowerCase();
      const match = name.indexOf(query);
      if (match < 0) continue;
      const group = option.group || '';
      if (!groups.has(group)) groups.set(group, [[], [], []]);
      const rank = !query || name === query ? 0 : match === 0 ? 1 : 2;
      groups.get(group)[rank].push(option);
    }
    visibleOptions = [...groups.values()].flat(2);
    clearSearch.hidden = !input.value;
  };

  // Use viewport positioning to escape scrolling containers. Search in a
  // modal stays under the dialog node so its focus trap and AT include it.
  let portalParent = null;
  let portalNextSibling = null;
  const reposition = () => {
    if (!state.open) return;
    // Establish the portal's final positioning before measuring. An absolute
    // popover under body can temporarily add a scrollbar and shift a centered
    // trigger; the scrollbar vanishes once the menu is positioned in view.
    popover.style.position = 'fixed';
    // The in-slot CSS sets both edges. With an explicit portal width, RTL
    // resolves that overconstraint by ignoring left; release the opposite edge.
    popover.style.right = 'auto';
    popover.style.top = '0px';
    const rect = trigger.getBoundingClientRect();
    popover.dataset.uiOverlay = '';
    const minWidth = input ? 220 : state.minWidth;
    const width = minWidth ? Math.min(Math.max(rect.width, minWidth), window.innerWidth - 16) : rect.width;
    const start = minWidth && window.getComputedStyle(trigger).direction === 'rtl' ? rect.right - width : rect.left;
    const left = minWidth ? Math.max(8, Math.min(start, window.innerWidth - width - 8)) : start;
    popover.style.left = left + 'px';
    popover.style.width = width + 'px';
    popover.style.maxHeight = '';
    const popH = popover.offsetHeight || 260;
    // A reserved RTL scrollbar gutter can offset the fixed containing block
    // from viewport coordinates. Correct from the rendered menu, retaining
    // the shared trigger measurement and any app-owned CSS positioning.
    const horizontalOffset = left - popover.getBoundingClientRect().left;
    if (horizontalOffset) popover.style.left = (left + horizontalOffset) + 'px';
    const placement = _dropdownVerticalPlacement(rect, popH, window.innerHeight, {
      edge: 8,
      gap: 4,
    });
    popover.style.top = placement.top + 'px';
    popover.style.maxHeight = Math.min(260, placement.availableHeight) + 'px';
    popover.dataset.placement = placement.openAbove ? 'top' : 'bottom';
    popover.style.zIndex = String(_aiSelectPopoverZIndexFor(trigger));
  };
  const open = () => {
    if (state.open || trigger.disabled) return;
    state.open = true;
    el.classList.add('open');
    trigger.setAttribute('aria-expanded', 'true');
    if (externalTrigger) trigger.setAttribute('aria-controls', listboxId);
    popover.hidden = false;
    portalParent = popover.parentNode;
    portalNextSibling = popover.nextSibling;
    const portal = (input && el.closest('[role="dialog"]')) || document.body;
    portal.appendChild(popover);
    if (input) {
      input.value = '';
      listbox.scrollTop = 0;
    }
    refreshVisibleOptions();
    const selectedIdx = visibleOptions.findIndex(o => (state.multiple ? state.values.includes(o.value) : o.value === state.value) && !disabled(o));
    state.activeIdx = selectedIdx >= 0
      ? selectedIdx
      : visibleOptions.findIndex(option => !disabled(option));
    renderPopover();
    reposition();
    setTimeout(() => {
      if (state.open) document.addEventListener('mousedown', onDocDown, true);
    }, 0);
    document.addEventListener('keydown', onKey, true);
    window.addEventListener('scroll', reposition, true);
    window.addEventListener('resize', reposition, true);
    if (input || externalTrigger) focusOwner.focus({ preventScroll: true });
  };

  const close = (restoreFocus = false) => {
    if (!state.open) return;
    state.open = false;
    el.classList.remove('open');
    trigger.setAttribute('aria-expanded', 'false');
    if (externalTrigger) trigger.removeAttribute('aria-controls');
    focusOwner.removeAttribute('aria-activedescendant');
    popover.hidden = true;
    popover.style.position = '';
    popover.style.left = '';
    popover.style.right = '';
    popover.style.top = '';
    popover.style.width = '';
    popover.style.maxHeight = '';
    popover.style.zIndex = '';
    delete popover.dataset.placement;
    // Restore popover to its original parent if that parent is still
    // attached to the document. If the host widget got removed mid-open
    // (e.g., the detail page re-rendered and replaced our slot), just
    // detach the popover so it doesn't dangle on document.body.
    if (portalParent) {
      if (portalParent.isConnected) {
        portalParent.insertBefore(popover, portalNextSibling);
      } else if (popover.parentNode) {
        popover.parentNode.removeChild(popover);
      }
      portalParent = null;
      portalNextSibling = null;
    }
    document.removeEventListener('mousedown', onDocDown, true);
    document.removeEventListener('keydown', onKey, true);
    window.removeEventListener('scroll', reposition, true);
    window.removeEventListener('resize', reposition, true);
    if (restoreFocus) trigger.focus({ preventScroll: true });
    state.onClose?.();
  };

  const onDocDown = (e) => {
    if (!el.contains(e.target) && !trigger.contains(e.target) && !popover.contains(e.target)) close();
  };
  const nextEnabledIndex = (start, step) => {
    for (let idx = start; idx >= 0 && idx < visibleOptions.length; idx += step) {
      if (!disabled(visibleOptions[idx])) return idx;
    }
    return state.activeIdx;
  };
  const onKey = (e) => {
    // IME composition guard (CLAUDE.md §8): the popover keydown listener
    // is on `document`, so a Chinese / Japanese / Korean composition in an
    // adjacent input would otherwise commit its Enter into "pick the
    // active option" of this select.
    if (e.isComposing || e.keyCode === 229) return;
    if (input && !popover.contains(e.target) && e.target !== trigger) return;
    if (externalTrigger && !input && e.target !== trigger) return;
    if (e.key === 'Escape') {
      close(Boolean(input || state.allowMultiple));
      e.preventDefault();
      if (input) e.stopPropagation();
    }
    else if (input && e.key === 'Tab') { close(true); }
    else if (externalTrigger && e.key === 'Tab') { close(); }
    else if (state.allowMultiple && e.key === 'Tab') { close(); if (e.target !== trigger) trigger.focus(); }
    else if (e.target.classList?.contains('ai-select-multiple-toggle')) return;
    else if (e.key === 'ArrowDown') {
      setActiveIndex(nextEnabledIndex(state.activeIdx + 1, 1), Boolean(input || externalTrigger));
      e.preventDefault();
    } else if (e.key === 'ArrowUp') {
      setActiveIndex(nextEnabledIndex(
        state.activeIdx < 0 ? visibleOptions.length - 1 : state.activeIdx - 1,
        -1,
      ), Boolean(input || externalTrigger));
      e.preventDefault();
    } else if (e.key === 'Enter' || (state.multiple && e.key === ' ')) {
      const option = visibleOptions[state.activeIdx];
      if (option && !disabled(option)) {
        _aiSelectPick(api, option.value);
        e.preventDefault();
      } else if (input) e.preventDefault();
    }
  };

  if (!externalTrigger) trigger.addEventListener('click', () => state.open ? close() : open());
  if (input) {
    const filter = () => {
      refreshVisibleOptions();
      state.activeIdx = -1;
      listbox.scrollTop = 0;
      renderPopover();
      reposition();
    };
    input.addEventListener('input', e => { if (!e.isComposing) filter(); });
    input.addEventListener('compositionend', filter);
    clearSearch.addEventListener('click', () => {
      input.value = '';
      input.focus({ preventScroll: true });
      filter();
    });
  }

  const api = {
    el,
    state,
    setOptions(options, { value, placeholder } = {}) {
      const activeValue = visibleOptions[state.activeIdx]?.value;
      state.options = _aiSelectNormalizeOptions(options);
      refreshVisibleOptions();
      if (typeof value === 'string') state.value = value;
      if (typeof placeholder === 'string') state.placeholder = placeholder;
      // Normalize value if not in options
      if (state.value && !state.options.some(
        option => option.value === state.value && !option.disabled && typeof option.action !== 'function',
      )) state.value = '';
      if (input) {
        state.activeIdx = visibleOptions.findIndex(option => option.value === activeValue && !disabled(option));
      } else if (state.open && activeValue !== undefined) {
        state.activeIdx = visibleOptions.findIndex(option => option.value === activeValue && !disabled(option));
        if (state.activeIdx < 0) state.activeIdx = visibleOptions.findIndex(option => option.value === state.value && !disabled(option));
        if (state.activeIdx < 0) state.activeIdx = visibleOptions.findIndex(option => !disabled(option));
      } else if (state.activeIdx >= state.options.length || state.options[state.activeIdx]?.disabled) {
        state.activeIdx = visibleOptions.findIndex(option => !disabled(option));
      }
      if (state.multiple) state.values = normalizeValues(state.values);
      else state.values = state.value ? [state.value] : [];
      renderTrigger();
      if (state.open) {
        renderPopover();
        if (input || externalTrigger) reposition();
      }
    },
    setValue(value) {
      state.value = typeof value === 'string' && state.options.some(
        option => option.value === value && !option.disabled && typeof option.action !== 'function',
      )
        ? value
        : '';
      renderTrigger();
    },
    setSelection(values, multiple) {
      state.multiple = state.allowMultiple && multiple === true;
      state.values = normalizeValues(Array.isArray(values) ? values : []);
      state.value = state.multiple ? '' : (state.values.length === 1 ? state.values[0] : '');
      if (!state.multiple) state.values = state.value ? [state.value] : [];
      renderTrigger();
      if (state.open) { renderPopover(); reposition(); }
    },
    setMultiple(multiple) {
      const values = state.multiple ? state.values : (state.value ? [state.value] : []);
      const expanded = values.flatMap(value => {
        const option = state.options.find(opt => opt.value === value);
        return multiple && option?.singleOnly ? (option.multipleValues || []) : [value];
      });
      api.setSelection(expanded, multiple);
    },
    isMultiple() { return state.multiple; },
    getValues() { return state.multiple ? [...state.values] : (state.value ? [state.value] : []); },
    toggleValue(value) {
      const next = state.options.find(option => option.value === value);
      if (!next || disabled(next)) return;
      const values = state.values.includes(value) ? state.values.filter(v => v !== value) : [...state.values, value];
      api.setSelection(values, true);
      state.onChange([...state.values]);
    },
    setAriaLabel(value) {
      state.ariaLabel = value === null || value === undefined ? '' : String(value);
      renderTrigger();
    },
    getValue() { return state.value; },
    onChange(fn) { state.onChange = typeof fn === 'function' ? fn : () => {}; },
    open,
    close,
  };

  renderTrigger();
  return api;
}

function _aiSelectPick(api, value) {
  const next = api.state.options.find(option => option.value === value);
  if (!next || next.disabled || (api.state.multiple && next.singleOnly)) return;
  if (typeof next.action === 'function') { api.close(); next.action(); return; }
  if (api.state.multiple) { api.toggleValue(value); return; }
  const prev = api.state.value;
  api.state.value = value || '';
  api.el.dataset.value = api.state.value;
  api.close(Boolean(api.state.search));
  if (prev !== api.state.value) {
    try { api.state.onChange(api.state.value); } catch (_) {}
  }
  api.setValue(api.state.value);
}


window.ContentControls=Object.freeze({mount:_aiSelectMount});
})();
