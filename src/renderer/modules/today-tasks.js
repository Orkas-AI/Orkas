/* Orkas Frontend — sidebar "Recent Tasks" (formerly "Today's Tasks")
 *
 * Aggregates pinned conversations and those active in the last 24 hours,
 * whether they live under a Project or in the catch-all Tasks list, so running work and finished work
 * that still needs a look sit in one place. The section is a mirror only:
 * rows reuse the shared conversation row renderer, click/menu handlers,
 * unread dots, and live-run badges, and the `conversations` cache remains the
 * single source of truth. Only the visible row limit belongs to this list;
 * opening a task from either copy clears both copies' attention cue.
 *
 * `selectRecentConversations` (conv-bucket.js) uses the shared activity
 * timestamp and a rolling cutoff for unpinned tasks. Normal refreshes,
 * reopening this section, and the debounced foreground check update membership; there is no expiry
 * timer. Rows for collapsed projects reach the cache through the startup
 * slice's matching `active_since` filter and unconditional pin inclusion.
 *
 * DOM ids, the i18n keys and the section's collapse key keep their historical
 * `today` names; only the window and the label changed.
 *
 * Regular refreshes use `renderConversationList`'s trailing badge pass.
 * Loading more or reopening refreshes only this list and its badges;
 * reopening resets the visible row limit to the first page.
 */

const _RECENT_TASK_PAGE_SIZE = 10;
let _recentTaskVisibleCount = _RECENT_TASK_PAGE_SIZE;
let _recentTaskOldestActivityMs = Infinity;

function refreshTodayTasksSectionForTimeChange(now) {
  // Ordinary foreground returns need only one timestamp comparison. There is
  // no timer or scan until a previously included row falls outside the window.
  if (recentConversationsSince(now).getTime() <= _recentTaskOldestActivityMs) return;
  renderTodayTasksSection();
  _refreshAllConvBadges();
}

function _todayTaskRows(now) {
  const rows = typeof conversations !== 'undefined' && Array.isArray(conversations)
    ? conversations
    : [];
  const selected = typeof selectRecentConversations === 'function'
    ? selectRecentConversations(rows, now)
    : [];
  const recent = Array.isArray(selected) ? selected : [];
  if (typeof _compareConversationsForSidebar === 'function') {
    recent.sort(_compareConversationsForSidebar);
  }
  return recent;
}

function renderTodayTasksSection() {
  const container = document.getElementById('today-list');
  if (!container) return;
  // An inline rename that lives in this list keeps its editor mounted; the
  // owning submit/cancel path renders again. Other lists refresh normally.
  if (typeof _conversationInlineRenameBlocksRender === 'function'
      && _conversationInlineRenameBlocksRender(container)) {
    return;
  }
  const rows = _todayTaskRows(new Date());
  _recentTaskOldestActivityMs = rows.reduce((oldest, c) => c.pinned_at ? oldest : Math.min(oldest,
    new Date(c.last_active_at || c.updated_at || c.created_at).getTime()), Infinity);
  if (!rows.length) {
    container.innerHTML = `<div class="conv-empty" data-i18n="sidebar.today_empty">${escapeHtml(t('sidebar.today_empty'))}</div>`;
    return;
  }
  const visibleRows = rows.slice(0, _recentTaskVisibleCount);
  const projectByCid = new Map(visibleRows.map((c) => [c.conversation_id, c.project_id || '']));
  container.innerHTML = visibleRows.map((c) => _renderConversationSidebarItem(c, { listId: 'today-list' })).join('');
  if (rows.length > visibleRows.length) {
    container.insertAdjacentHTML('beforeend', `<button type="button" class="conversation-list-load-more" data-recent-conv-more="1">
      ${escapeHtml(t('sidebar.load_more_conversations'))}</button>`);
    container.querySelector('[data-recent-conv-more]').addEventListener('click', () => {
      _recentTaskVisibleCount += _RECENT_TASK_PAGE_SIZE;
      renderTodayTasksSection();
      _refreshAllConvBadges();
      container.querySelector('[data-recent-conv-more]')?.focus({ preventScroll: true });
    });
  }
  _bindConversationSidebarItems(container, {
    scope: 'recent',
    async afterDelete(cid) {
      // A projected task also changes its project's count; the nested project
      // list does the same refresh after its own delete.
      if (projectByCid.get(cid) && typeof loadProjects === 'function') await loadProjects(true);
    },
  });
}

window.addEventListener('sidebar-section-toggle', (event) => {
  if (event?.detail?.name !== 'today' || event.detail.collapsed !== false) return;
  _recentTaskVisibleCount = _RECENT_TASK_PAGE_SIZE;
  renderTodayTasksSection();
  _refreshAllConvBadges();
});
