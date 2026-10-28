// Shared editable calendar for to-dos and automation; loaded by both lazy bundles.
let _autoOpenDatePicker = null;

function _autoLocalDateParts(raw) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(raw || '').trim());
  if (!match) return null;
  const year = parseInt(match[1], 10);
  const month = parseInt(match[2], 10);
  const day = parseInt(match[3], 10);
  const parsed = new Date(year, month - 1, day);
  if (parsed.getFullYear() !== year || parsed.getMonth() !== month - 1 || parsed.getDate() !== day) return null;
  return { year, month, day, value: `${match[1]}-${match[2]}-${match[3]}` };
}

function _autoCalendarDateValue(date) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${String(date.getFullYear()).padStart(4, '0')}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function _autoCalendarCells(year, month) {
  const first = new Date(year, month, 1, 12);
  const cursor = new Date(year, month, 1 - first.getDay(), 12);
  const cells = [];
  for (let idx = 0; idx < 42; idx += 1) {
    const date = new Date(cursor.getFullYear(), cursor.getMonth(), cursor.getDate() + idx, 12);
    cells.push({
      value: _autoCalendarDateValue(date),
      day: date.getDate(),
      inMonth: date.getFullYear() === year && date.getMonth() === month,
    });
  }
  return cells;
}

function _autoCalendarDateFromValue(value) {
  const parts = _autoLocalDateParts(value);
  return parts ? new Date(parts.year, parts.month - 1, parts.day, 12) : null;
}

function _autoCalendarShiftDate(value, days) {
  const date = _autoCalendarDateFromValue(value) || new Date();
  date.setHours(12, 0, 0, 0);
  date.setDate(date.getDate() + days);
  return _autoCalendarDateValue(date);
}

function _autoCalendarShiftMonth(value, months) {
  const date = _autoCalendarDateFromValue(value) || new Date();
  const day = date.getDate();
  const target = new Date(date.getFullYear(), date.getMonth() + months, 1, 12);
  const lastDay = new Date(target.getFullYear(), target.getMonth() + 1, 0, 12).getDate();
  target.setDate(Math.min(day, lastDay));
  return _autoCalendarDateValue(target);
}

function _autoDatePickerMount(el, config = {}) {
  if (!el) return null;
  const input = el.querySelector('input');
  const toggle = el.querySelector('.auto-date-picker-toggle');
  const popover = el.querySelector('.auto-date-picker-popover');
  if (!input || !toggle || !popover) return null;

  const state = {
    open: false,
    viewYear: new Date().getFullYear(),
    viewMonth: new Date().getMonth(),
    activeValue: '',
  };
  const headingId = `${popover.id}-heading`;
  let portalParent = null;
  let portalNextSibling = null;

  const locale = () => {
    try {
      return typeof getLocaleMeta === 'function'
        ? getLocaleMeta(getLang()).intlLocale
        : 'en-US';
    } catch (_) {
      return 'en-US';
    }
  };
  const escape = (value) => (
    typeof escapeHtml === 'function'
      ? escapeHtml(String(value == null ? '' : value))
      : String(value == null ? '' : value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
  );
  const icon = (name, className) => (
    typeof window.uiIconHtml === 'function' ? window.uiIconHtml(name, className) : ''
  );
  const dateLabel = (date, options) => {
    try { return new Intl.DateTimeFormat(locale(), options).format(date); }
    catch (_) { return _autoCalendarDateValue(date); }
  };
  const todayValue = () => _autoCalendarDateValue(new Date());

  const syncViewFromInput = () => {
    const selected = _autoCalendarDateFromValue(input.value) || new Date();
    state.viewYear = selected.getFullYear();
    state.viewMonth = selected.getMonth();
    state.activeValue = _autoCalendarDateValue(selected);
  };

  const render = ({ focusActive = false } = {}) => {
    const selected = _autoLocalDateParts(input.value);
    const selectedValue = selected ? selected.value : '';
    const today = todayValue();
    const monthDate = new Date(state.viewYear, state.viewMonth, 1, 12);
    const monthTitle = dateLabel(monthDate, { year: 'numeric', month: 'long' });
    const cells = _autoCalendarCells(state.viewYear, state.viewMonth);
    const weekdays = [];
    for (let day = 0; day < 7; day += 1) {
      const date = new Date(2024, 0, 7 + day, 12);
      weekdays.push({
        short: dateLabel(date, { weekday: 'narrow' }),
        full: dateLabel(date, { weekday: 'long' }),
      });
    }
    if (!cells.some((cell) => cell.value === state.activeValue)) {
      const firstInMonth = cells.find((cell) => cell.inMonth);
      state.activeValue = firstInMonth ? firstInMonth.value : cells[0].value;
    }
    const weekdayHtml = weekdays.map((weekday) => (
      `<span role="columnheader" aria-label="${escape(weekday.full)}">${escape(weekday.short)}</span>`
    )).join('');
    const cellHtml = cells.map((cell) => {
      const date = _autoCalendarDateFromValue(cell.value);
      const classNames = ['auto-date-picker-day'];
      if (!cell.inMonth) classNames.push('is-outside');
      if (cell.value === today) classNames.push('is-today');
      if (cell.value === selectedValue) classNames.push('is-selected');
      const ariaCurrent = cell.value === today ? ' aria-current="date"' : '';
      return `<button type="button" class="${classNames.join(' ')}" data-date="${cell.value}" role="gridcell" aria-label="${escape(dateLabel(date, { year: 'numeric', month: 'long', day: 'numeric' }))}" aria-selected="${cell.value === selectedValue ? 'true' : 'false'}" tabindex="${cell.value === state.activeValue ? '0' : '-1'}"${ariaCurrent}>${cell.day}</button>`;
    }).join('');
    popover.setAttribute('aria-label', t(config.labelKey || 'auto.date_label'));
    popover.innerHTML = `
      <div class="auto-date-picker-header">
        <button type="button" class="auto-date-picker-nav" data-action="previous" aria-label="${escape(t('auto.calendar_previous_month'))}" title="${escape(t('auto.calendar_previous_month'))}">${icon('chevron-left', 'ui-icon')}</button>
        <div class="auto-date-picker-heading" id="${escape(headingId)}" aria-live="polite">${escape(monthTitle)}</div>
        <button type="button" class="auto-date-picker-nav" data-action="next" aria-label="${escape(t('auto.calendar_next_month'))}" title="${escape(t('auto.calendar_next_month'))}">${icon('chevron-right', 'ui-icon')}</button>
      </div>
      <div class="auto-date-picker-weekdays" role="row">${weekdayHtml}</div>
      <div class="auto-date-picker-grid" role="grid" aria-labelledby="${escape(headingId)}">${cellHtml}</div>
      <div class="auto-date-picker-footer">
        <button type="button" class="auto-date-picker-today" data-action="today">${escape(t('auto.calendar_today'))}</button>
      </div>`;
    if (focusActive) popover.querySelector('.auto-date-picker-day[tabindex="0"]')?.focus();
  };

  const reposition = () => {
    if (!state.open) return;
    const rect = el.getBoundingClientRect();
    const edge = 8;
    const width = Math.min(296, Math.max(240, window.innerWidth - edge * 2));
    const left = Math.max(edge, Math.min(rect.left, window.innerWidth - width - edge));
    popover.dataset.uiOverlay = '';
    popover.style.position = 'fixed';
    popover.style.left = `${left}px`;
    popover.style.width = `${width}px`;
    const popoverHeight = popover.offsetHeight || 340;
    const placement = typeof _dropdownVerticalPlacement === 'function'
      ? _dropdownVerticalPlacement(rect, popoverHeight, window.innerHeight, { edge, gap: 6 })
      : { top: Math.min(window.innerHeight - popoverHeight - edge, rect.bottom + 6), openAbove: false };
    popover.style.top = `${Math.max(edge, placement.top)}px`;
    popover.dataset.placement = placement.openAbove ? 'top' : 'bottom';
    popover.style.zIndex = String(
      typeof _aiSelectPopoverZIndexFor === 'function' ? _aiSelectPopoverZIndexFor(el) : 14000,
    );
  };

  const close = () => {
    if (!state.open) return;
    state.open = false;
    el.classList.remove('open');
    input.setAttribute('aria-expanded', 'false');
    toggle.setAttribute('aria-expanded', 'false');
    popover.hidden = true;
    popover.style.position = '';
    popover.style.left = '';
    popover.style.top = '';
    popover.style.width = '';
    popover.style.zIndex = '';
    delete popover.dataset.placement;
    if (portalParent) {
      if (portalParent.isConnected) portalParent.insertBefore(popover, portalNextSibling);
      else popover.remove();
      portalParent = null;
      portalNextSibling = null;
    }
    document.removeEventListener('mousedown', onDocumentDown, true);
    window.removeEventListener('scroll', reposition, true);
    window.removeEventListener('resize', reposition, true);
    if (_autoOpenDatePicker === api) _autoOpenDatePicker = null;
  };

  const open = ({ focusGrid = false } = {}) => {
    if (state.open) {
      if (focusGrid) render({ focusActive: true });
      return;
    }
    if (_autoOpenDatePicker && _autoOpenDatePicker !== api) _autoOpenDatePicker.close();
    _autoOpenDatePicker = api;
    syncViewFromInput();
    state.open = true;
    el.classList.add('open');
    input.setAttribute('aria-expanded', 'true');
    toggle.setAttribute('aria-expanded', 'true');
    portalParent = popover.parentNode;
    portalNextSibling = popover.nextSibling;
    // Keep calendar focus inside a form dialog while escaping its scroll area.
    (config.portalRoot || document.body).appendChild(popover);
    popover.hidden = false;
    render();
    reposition();
    document.addEventListener('mousedown', onDocumentDown, true);
    window.addEventListener('scroll', reposition, true);
    window.addEventListener('resize', reposition, true);
    if (focusGrid) popover.querySelector('.auto-date-picker-day[tabindex="0"]')?.focus();
  };

  const commit = (value) => {
    input.value = value;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    close();
    input.focus();
  };

  function onDocumentDown(event) {
    if (!el.contains(event.target) && !popover.contains(event.target)) close();
  }

  popover.addEventListener('click', (event) => {
    const button = event.target.closest('button');
    if (!button) return;
    if (button.dataset.date) {
      commit(button.dataset.date);
      return;
    }
    if (button.dataset.action === 'today') {
      commit(todayValue());
      return;
    }
    if (button.dataset.action === 'previous' || button.dataset.action === 'next') {
      const delta = button.dataset.action === 'previous' ? -1 : 1;
      state.activeValue = _autoCalendarShiftMonth(state.activeValue, delta);
      const active = _autoCalendarDateFromValue(state.activeValue);
      state.viewYear = active.getFullYear();
      state.viewMonth = active.getMonth();
      render({ focusActive: true });
      reposition();
    }
  });

  popover.addEventListener('keydown', (event) => {
    if (event.isComposing || event.keyCode === 229) return;
    let nextValue = '';
    if (event.key === 'Escape') {
      close();
      input.focus();
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    if (event.key === 'ArrowLeft') nextValue = _autoCalendarShiftDate(state.activeValue, -1);
    else if (event.key === 'ArrowRight') nextValue = _autoCalendarShiftDate(state.activeValue, 1);
    else if (event.key === 'ArrowUp') nextValue = _autoCalendarShiftDate(state.activeValue, -7);
    else if (event.key === 'ArrowDown') nextValue = _autoCalendarShiftDate(state.activeValue, 7);
    else if (event.key === 'Home') {
      const active = _autoCalendarDateFromValue(state.activeValue);
      nextValue = _autoCalendarShiftDate(state.activeValue, -active.getDay());
    } else if (event.key === 'End') {
      const active = _autoCalendarDateFromValue(state.activeValue);
      nextValue = _autoCalendarShiftDate(state.activeValue, 6 - active.getDay());
    } else if (event.key === 'PageUp') nextValue = _autoCalendarShiftMonth(state.activeValue, -1);
    else if (event.key === 'PageDown') nextValue = _autoCalendarShiftMonth(state.activeValue, 1);
    if (!nextValue) return;
    const active = _autoCalendarDateFromValue(nextValue);
    state.activeValue = nextValue;
    state.viewYear = active.getFullYear();
    state.viewMonth = active.getMonth();
    render({ focusActive: true });
    reposition();
    event.preventDefault();
  });

  input.addEventListener('click', () => open());
  input.addEventListener('input', () => {
    if (!state.open) return;
    const parsed = _autoCalendarDateFromValue(input.value);
    if (parsed) {
      state.viewYear = parsed.getFullYear();
      state.viewMonth = parsed.getMonth();
      state.activeValue = _autoCalendarDateValue(parsed);
    }
    render();
    reposition();
  });
  input.addEventListener('keydown', (event) => {
    if (event.isComposing || event.keyCode === 229) return;
    if ((event.altKey && event.key === 'ArrowDown') || event.key === 'F4') {
      open({ focusGrid: true });
      event.preventDefault();
    } else if (event.key === 'Escape' && state.open) {
      close();
      event.preventDefault();
      event.stopPropagation();
    }
  });
  toggle.addEventListener('click', () => {
    if (state.open) close();
    else open({ focusGrid: true });
  });

  const api = {
    el,
    state,
    getValue() { return input.value; },
    setValue(value) {
      input.value = String(value || '');
      if (state.open) {
        syncViewFromInput();
        render();
        reposition();
      }
    },
    repaint() {
      const label = t(config.labelKey || 'auto.date_label');
      input.setAttribute('aria-label', label);
      toggle.setAttribute('aria-label', t('auto.calendar_open'));
      toggle.setAttribute('title', t('auto.calendar_open'));
      popover.setAttribute('aria-label', label);
      if (state.open) {
        render();
        reposition();
      }
    },
    open,
    close,
  };

  input.setAttribute('aria-haspopup', 'dialog');
  input.setAttribute('aria-controls', popover.id);
  input.setAttribute('aria-expanded', 'false');
  toggle.setAttribute('aria-expanded', 'false');
  toggle.innerHTML = icon('calendar', 'ui-icon auto-date-picker-icon');
  api.repaint();
  return api;
}

// Only pure calendar helpers are exposed to deterministic tests.
if (typeof module !== 'undefined' && typeof module.exports === 'object') {
  module.exports = { _autoLocalDateParts, _autoCalendarCells, _autoCalendarShiftDate, _autoCalendarShiftMonth };
}
