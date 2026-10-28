/* Settings-only history cleanup. Selection belongs to a frozen account receipt;
 * project-wide choices include unloaded pages without hydrating task history. */
(() => {
  let owner = '', days = 30, token = '', total = 0, selectableTotal = 0;
  let entries = [], offset = 0, nextOffset = null, treeTotal = 0;
  let expanded = false, confirming = false, busy = false, loading = false, stopped = false;
  let allSelected = false, result = null, failed = [], error = false, picker = null, bound = false;
  let returnTarget = null;
  const projectChoices = new Map(), itemChoices = new Map(), projects = new Map(), knownRows = new Map(), projectViews = new Map();
  const removed = new Set(), removedByProject = new Map();
  const log = createLogger('task-cleanup');
  const user = () => typeof currentUserId === 'string' ? currentUserId : '';
  const body = () => document.getElementById('settings-task-cleanup-body');
  const backButton = () => document.getElementById('chat-cleanup-back');
  window.TaskCleanupNavigation = {
    beforeNavigate(view, cid, opts = {}) {
      const valid = returnTarget && returnTarget.owner === user();
      const restore = !!(valid && opts.restoreTaskCleanup && view === 'settings'
        && currentView === 'conversation' && currentCid === returnTarget.cid);
      if (!valid || view !== 'conversation' || cid !== returnTarget.cid) returnTarget = null;
      if (backButton()) backButton().hidden = !returnTarget;
      return restore;
    },
    back() {
      const saved = returnTarget;
      if (!saved || saved.owner !== user() || currentView !== 'conversation' || currentCid !== saved.cid) {
        returnTarget = null;
        if (backButton()) backButton().hidden = true;
        return;
      }
      setView('settings', null, { restoreTaskCleanup: true });
      // Reuse the mounted receipt: revisiting Settings normally refreshes it,
      // which would discard the user's selection, expanded projects and page.
      for (const { element, top } of saved.scroll) element.scrollTop = top;
      const buttons = body()?.querySelectorAll?.('[data-cleanup-action="open"]') || [];
      for (const button of buttons) if (button.dataset.cleanupOwner === saved.cid) {
        button.focus({ preventScroll: true }); break;
      }
    },
  };
  const baseSelected = row => projectChoices.get(row.projectId)?.selected ?? allSelected;
  const isSelected = row => !removed.has(row.cid) && !!row.selectable && (itemChoices.get(row.cid)?.selected ?? baseSelected(row));
  function selectionCounts() {
    let count = allSelected ? selectableTotal : 0;
    const perProject = new Map();
    for (const [pid, p] of projects) perProject.set(pid, (projectChoices.get(pid)?.selected ?? allSelected) ? p.selectableTotal : 0);
    for (const choice of projectChoices.values()) count += (Number(choice.selected) - Number(allSelected)) * choice.total;
    for (const { row, selected } of itemChoices.values()) {
      const delta = Number(selected) - Number(baseSelected(row));
      count += delta;
      if (row.projectId) perProject.set(row.projectId, (perProject.get(row.projectId) || 0) + delta);
    }
    return { count, perProject };
  }
  const selectedCount = () => selectionCounts().count;
  const aliases = { retry: 'chat.retry_btn', stop: 'chat.task_stop', loading: 'common.loading', refresh: 'common.refresh', view: 'settings.recycle.view', collapse: 'settings.recycle.collapse', cancel: 'common.cancel', confirm_title: 'settings.cleanup.title' };
  const tr = (key, values) => key === 'all' ? `${t('chat.message_select_all')} (${values.n})`
    : key === 'page' ? `${values.from}–${values.to} / ${values.n}` : t(aliases[key] || `settings.cleanup.${key}`, values);
  const resultText = () => tr('result', result) + (Number.isSafeInteger(result?.remaining)
    ? ' · ' + tr('remaining', { n: result.remaining }) : '');
  const esc = value => escapeHtml(String(value));
  const button = (action, label, disabled = false, danger = false, projectId = '') =>
    `<button type="button" class="btn btn-sm${danger ? ' btn-danger' : ''}" data-cleanup-action="${action}" data-cleanup-owner="${esc(projectId)}"${disabled ? ' disabled' : ''}>${esc(label)}</button>`;
  const options = () => [7, 14, 30, 60, 90, 180].map(n => ({ value: String(n), label: tr('days', { n }) }));
  function draftIds() {
    const ids = new Set();
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      const match = /^draft_([A-Za-z0-9_-]+)(:queue-edit)?$/.exec(key || '');
      if (!match) continue;
      const raw = localStorage.getItem(key); if (!raw) continue;
      let draft;
      try { draft = JSON.parse(raw); } catch (_) { ids.add(match[1]); continue; }
      if (match[2] || draft?.text?.trim() || draft?.references?.length || draft?.attachments?.length) ids.add(match[1]);
    }
    if (typeof _chatAttachments !== 'undefined') for (const [cid, items] of _chatAttachments) if (items.length) ids.add(cid);
    if (typeof currentCid === 'string' && currentCid && typeof _composerHoldsUnsentInput === 'function' && _composerHoldsUnsentInput(currentCid)) ids.add(currentCid);
    return [...ids].filter(cid => /^[A-Za-z0-9_-]+$/.test(cid));
  }
  async function invoke(action, payload) {
    if (!owner || owner !== user()) throw new Error('cleanup_account_changed');
    const expectedOwner = owner;
    const response = await window.orkas.invoke(`conversations.cleanup.${action}`, { ...payload, expectedUserId: expectedOwner });
    if (expectedOwner !== user() || owner !== expectedOwner) throw new Error('cleanup_account_changed');
    if (!response || response.ok !== true) throw new Error('cleanup_failed');
    return response;
  }
  function remember(items) {
    for (const row of items) {
      if (row.type === 'project') {
        const count = removedByProject.get(row.projectId) || 0;
        projects.set(row.projectId, { ...row, total: row.total - count, selectableTotal: row.selectableTotal - count });
      } else if (!removed.has(row.cid)) knownRows.set(row.cid, row);
    }
  }
  function forgetCompleted(cid) {
    const row = knownRows.get(cid);
    if (!row || removed.has(cid)) return;
    removed.add(cid); knownRows.delete(cid); itemChoices.delete(cid);
    total--; selectableTotal--;
    if (row.projectId) {
      removedByProject.set(row.projectId, (removedByProject.get(row.projectId) || 0) + 1);
      const project = projects.get(row.projectId), choice = projectChoices.get(row.projectId);
      if (project) { project.total--; project.selectableTotal--; }
      if (choice) choice.total--;
    }
  }
  function resetSelection() { allSelected = false; projectChoices.clear(); itemChoices.clear(); }
  function checkbox(attr, count, available, disabled = false, label = '') {
    return `<input type="checkbox" ${attr} aria-label="${esc(label)}"${count && count === available ? ' checked' : ''}${count && count < available ? ' data-cleanup-mixed' : ''}${disabled || !available ? ' disabled' : ''}>`;
  }
  function taskRow(row, nested, drafts) {
    if (removed.has(row.cid)) return '';
    const labels = [];
    if (row.pinned) labels.push(tr('pinned'));
    if (window.TaskUnread?.isUnread?.(row.cid)) labels.push(tr('unread'));
    if (row.draft || drafts.has(row.cid)) labels.push(tr('draft'));
    if (row.automation) labels.push(tr('automation'));
    return `<label class="settings-cleanup-item${nested ? ' is-nested' : ''}">${checkbox(`data-cleanup-cid="${esc(row.cid)}"`, Number(isSelected(row)), Number(row.selectable), confirming, row.title)}<span class="settings-cleanup-copy"><span class="settings-cleanup-title" title="${esc(row.title)}">${esc(row.title)}</span>${labels.map(label => `<span class="settings-cleanup-tag">${esc(label)}</span>`).join('')}</span><span class="settings-cleanup-meta">${row.blocked === 'unknown' ? `<span>${esc(tr('unavailable'))}</span>` : ''}<button type="button" class="settings-link-btn settings-cleanup-open" data-cleanup-action="open" data-cleanup-owner="${esc(row.cid)}"${confirming ? ' disabled' : ''}>${esc(tr('view'))}</button><time>${esc(new Date(row.activeAt).toLocaleDateString())}</time></span></label>`;
  }
  function pagination(start, length, size, next, projectId = '') {
    if (start === 0 && next === null) return '';
    return `<div class="settings-sheet-foot"><span>${esc(tr('page', { from: start + 1, to: start + length, n: size }))}</span><div class="settings-cleanup-actions">${button('previous', tr('previous'), start === 0 || confirming, false, projectId)}${button('next', tr('next'), next === null || confirming, false, projectId)}</div></div>`;
  }
  function render() {
    const host = body(); if (!host) return;
    const scroll = host.querySelector?.('.settings-cleanup-list')?.scrollTop || 0;
    const focused = document.activeElement;
    const focusAttr = ['data-cleanup-cid', 'data-cleanup-project', 'data-cleanup-action'].find(key => focused?.hasAttribute?.(key));
    const focusValue = focusAttr ? focused.getAttribute(focusAttr) : null;
    const focusOwner = focused?.getAttribute?.('data-cleanup-owner') || '';
    picker?.setOptions(options(), { value: String(days) }); picker?.setAriaLabel(tr('age'));
    const trigger = document.getElementById('settings-task-cleanup-age')?.querySelector?.('.ai-select-trigger');
    if (trigger) trigger.disabled = busy || loading || confirming;
    const { count: selected, perProject } = selectionCounts();
    let html = '';
    if (busy) html += `<div class="settings-row" role="status"><span class="settings-row-desc">${esc(tr('progress', { done: result.done, total: result.total }))}</span>${button('stop', tr('stop'), stopped)}</div>`;
    else if (loading) html += `<div class="settings-row" role="status">${esc(tr('loading'))}</div>`;
    else if (error) html += `<div class="settings-row" role="alert"><span class="settings-row-desc">${esc(tr('error'))}${result ? ' ' + esc(resultText()) : ''}</span><div class="settings-cleanup-actions">${failed.length ? button('retry', tr('retry')) : ''}${button('refresh', tr('refresh'))}</div></div>`;
    else {
      if (confirming) html += `<div class="settings-row" role="group" aria-label="${esc(tr('confirm_title'))}"><span class="settings-row-desc">${esc(tr('confirm', { n: selected }))}</span><div class="settings-cleanup-actions">${button('cancel', tr('cancel'))}${button('confirm', tr('move', { n: selected }), !selected, true)}</div></div>`;
      else html += `<div class="settings-row"><div class="settings-cleanup-copy">${total ? `<label class="settings-cleanup-select-all">${checkbox('data-cleanup-all', selected, selectableTotal, false, tr('all', { n: total }))}<span>${esc(tr('all', { n: total }))}</span></label>` : ''}${result || !total ? `<span class="settings-row-desc" role="status">${esc(result ? resultText() : tr('empty'))}</span>` : ''}</div><div class="settings-cleanup-actions">${failed.length ? button('retry', tr('retry')) : ''}${total ? button('view', tr(expanded ? 'collapse' : 'view')) : ''}${button('prepare', `${tr('clean')} (${selected})`, !selected, true)}</div></div>`;
      if (expanded && total) {
        const drafts = new Set(draftIds());
        html += '<div class="settings-cleanup-list">';
        for (const item of entries) {
          if (item.type !== 'project') { html += taskRow(item, false, drafts); continue; }
          const pid = item.projectId, entry = projects.get(pid);
          if (!entry.total) continue;
          const view = projectViews.get(pid);
          const icon = 'folder';
          html += `<div class="settings-cleanup-project" data-cleanup-group="${esc(pid)}"><div class="settings-cleanup-project-head">${checkbox(`data-cleanup-project="${esc(pid)}"`, perProject.get(pid) || 0, entry.selectableTotal, confirming, entry.title)}<button type="button" class="settings-cleanup-project-toggle" data-cleanup-action="project" data-cleanup-owner="${esc(pid)}" aria-expanded="${!!view?.open}"${confirming ? ' disabled' : ''}><span data-ui-icon="${icon}" aria-hidden="true"></span><span class="settings-cleanup-title">${esc(entry.title)}</span><span data-ui-icon="${view?.open ? 'chevron-down' : 'chevron-right'}" aria-hidden="true"></span></button><span class="settings-row-desc">${esc(perProject.get(pid) ? `${perProject.get(pid)} / ${entry.total}` : entry.total)}</span></div>`;
          if (view?.open) html += view.rows.map(row => taskRow(row, true, drafts)).join('') + pagination(view.offset, view.rows.length, entry.total, view.nextOffset, pid);
          html += '</div>';
        }
        html += '</div>' + pagination(offset, entries.length, treeTotal, nextOffset);
      }
    }
    host.innerHTML = html;
    window.hydrateUiIcons?.(host);
    host.querySelectorAll?.('[data-cleanup-mixed]').forEach(el => { el.indeterminate = true; });
    const list = host.querySelector?.('.settings-cleanup-list'); if (list) list.scrollTop = scroll;
    if (focusAttr) {
      const candidates = host.querySelectorAll?.(`[${focusAttr}]`) || [];
      for (const el of candidates) if (el.getAttribute(focusAttr) === focusValue && (el.getAttribute('data-cleanup-owner') || '') === focusOwner) { el.focus({ preventScroll: true }); break; }
    }
  }
  async function refresh(keepResult = false) {
    if (busy || loading) return;
    loading = true; error = false; confirming = false;
    if (!keepResult) { result = null; failed = []; }
    render();
    try {
      const p = await invoke('preview', { days, draftIds: draftIds() });
      if (!Array.isArray(p.entries) || !Number.isSafeInteger(p.total) || !Number.isSafeInteger(p.selectableTotal) || typeof p.token !== 'string') throw new Error('invalid_preview');
      if (keepResult && result) result.remaining = p.total;
      token = p.token; total = p.total; selectableTotal = p.selectableTotal; entries = p.entries; offset = 0;
      nextOffset = p.treeNextOffset; treeTotal = p.treeTotal;
      projects.clear(); knownRows.clear(); projectViews.clear(); removed.clear(); removedByProject.clear(); resetSelection(); remember(entries);
    } catch (_) { error = true; token = ''; total = 0; selectableTotal = 0; entries = []; resetSelection(); }
    finally { loading = false; render(); }
  }
  async function changePage(next, projectId = '') {
    if (loading || busy || confirming) return;
    loading = true;
    try {
      const p = await invoke('page', { token, offset: next, ...(projectId ? { projectId } : { tree: true }) });
      if (projectId) { remember(p.rows); projectViews.set(projectId, { rows: p.rows, offset: next, nextOffset: p.nextOffset, open: true }); }
      else { entries = p.entries; remember(entries); offset = next; nextOffset = p.nextOffset; treeTotal = p.listTotal; }
    } catch (_) { error = true; }
    finally { loading = false; render(); }
  }
  async function run(retry = false) {
    if (busy || loading || owner !== user() || (!retry && !confirming)) return;
    busy = true; confirming = false; stopped = false; error = false;
    const operationOwner = owner, startedAt = Date.now(), retryIds = failed.slice(); failed = [];
    result = { deleted: 0, skipped: 0, failed: 0, done: 0, total: retry ? retryIds.length : selectedCount() }; render();
    try {
      let next = 0;
      do {
        const p = retry ? { rows: retryIds.map(cid => ({ cid })), nextOffset: null } : await invoke('page', { token, offset: next });
        for (const row of p.rows) {
          if (stopped || operationOwner !== user()) break;
          if (!retry && !isSelected(row)) continue;
          if (!retry) knownRows.set(row.cid, row);
          try {
            const response = await invoke('remove', { token, cid: row.cid });
            if (!['deleted', 'skipped'].includes(response.status)) throw new Error('invalid_cleanup_result');
            result[response.status]++;
            if (response.status === 'deleted') {
              forgetCompleted(row.cid);
              _removeConversationFromSidebar(row.cid, { deferRender: true });
              if (typeof _chatAttachClear === 'function') await _chatAttachClear(row.cid);
              if (typeof _forgetConvLocal === 'function') _forgetConvLocal(row.cid);
              if (typeof _forgetUnreadConversation === 'function') _forgetUnreadConversation(row.cid);
            }
          } catch (_) { result.failed++; failed.push(row.cid); }
          result.done++; render();
        }
        next = p.nextOffset;
      } while (!retry && next !== null && !stopped && operationOwner === user());
    } catch (_) { error = true; }
    finally {
      busy = false;
      if (typeof _logConversationManageResult === 'function') {
        const failedOperation = error || result.failed;
        _logConversationManageResult('delete', startedAt, failedOperation ? 'failure' : 'success',
          failedOperation ? 'delete_failed' : '');
      }
      if (operationOwner === user()) {
        window.initRecycleBin?.();
        if (typeof loadConversations === 'function') try { await loadConversations({ fresh: true }); } catch (_) { log.warn('cleanup navigation refresh failed'); }
        if (!failed.length && !error) await refresh(true); else render();
      } else { owner = ''; token = ''; total = 0; selectableTotal = 0; entries = []; result = null; failed = []; resetSelection(); render(); }
    }
  }
  async function click(event) {
    const target = event.target.closest('[data-cleanup-action]');
    const action = target?.dataset.cleanupAction, pid = target?.dataset.cleanupOwner || '';
    if (action === 'stop') { stopped = true; render(); return; }
    if (busy || loading) return;
    if (action === 'cancel') { confirming = false; render(); body().querySelector('[data-cleanup-action="prepare"]')?.focus(); return; }
    if (action === 'confirm') { await run(); return; }
    if (confirming) return;
    if (action === 'open') {
      event.preventDefault();
      if (owner === user() && knownRows.has(pid)) {
        const scroll = [document.querySelector('#panel-settings .settings-body'), body()?.querySelector('.settings-cleanup-list')]
          .filter(Boolean).map(element => ({ element, top: element.scrollTop }));
        returnTarget = { owner, cid: pid, scroll };
        setView('conversation', pid);
      }
      return;
    }
    if (action === 'view') { expanded = !expanded; render(); }
    if (action === 'project' && projects.has(pid)) {
      const view = projectViews.get(pid);
      if (view) { view.open = !view.open; render(); } else await changePage(0, pid);
    }
    if (action === 'prepare' && token && selectedCount() > 0) { confirming = true; render(); body().querySelector('[data-cleanup-action="cancel"]')?.focus(); }
    if (action === 'retry') await run(true);
    if (action === 'refresh') await refresh();
    if (action === 'previous') await changePage(Math.max(0, (pid ? projectViews.get(pid)?.offset || 0 : offset) - 20), pid);
    const next = pid ? projectViews.get(pid)?.nextOffset : nextOffset;
    if (action === 'next' && next != null) await changePage(next, pid);
  }
  function change(event) {
    if (busy || loading || confirming) return;
    const el = event.target, cid = el.getAttribute('data-cleanup-cid'), pid = el.getAttribute('data-cleanup-project');
    if (cid) {
      const row = knownRows.get(cid); if (!row?.selectable) return;
      if (el.checked === baseSelected(row)) itemChoices.delete(cid); else itemChoices.set(cid, { row, selected: el.checked });
    } else if (pid && projects.has(pid)) {
      projectChoices.set(pid, { selected: el.checked, total: projects.get(pid).selectableTotal });
      for (const [id, choice] of itemChoices) if (choice.row.projectId === pid) itemChoices.delete(id);
    } else if (el.hasAttribute('data-cleanup-all')) { allSelected = el.checked; projectChoices.clear(); itemChoices.clear(); }
    render();
  }
  window.initTaskCleanup = async function () {
    if (!body() || !user()) return;
    if (!bound) {
      body().addEventListener('click', click); body().addEventListener('change', change); bound = true;
      backButton()?.addEventListener('click', () => window.TaskCleanupNavigation.back());
      picker = _aiSelectMount(document.getElementById('settings-task-cleanup-age'), { options: options(), value: String(days), ariaLabel: tr('age') });
      picker.onChange(value => { if (!busy && !loading && !confirming) { days = Number(value); refresh(); } });
    }
    if (owner !== user()) { owner = user(); token = ''; resetSelection(); result = null; failed = []; confirming = false; }
    if (!busy && !loading && !confirming) await refresh();
  };
  window.addEventListener('i18n-change', render);
  if (document.querySelector('[data-settings-tab="data"].is-active')) window.initTaskCleanup();
})();
