/* Orkas Frontend — sidebar "Today's Tasks"
 *
 * Aggregates every conversation with activity today, whether it lives under a
 * Project or in the catch-all Tasks list, so running work and finished work
 * that still needs a look sit in one place. The section is a mirror only:
 * rows reuse the shared conversation row renderer, click/menu handlers,
 * unread dots, and live-run badges, and the `conversations` cache remains the
 * single source of truth. Nothing here owns state or changes what the other
 * lists do; opening a task from either copy clears both copies' attention cue.
 *
 * Day boundary: `selectTodayConversations` (conv-bucket.js) reads the same
 * activity timestamp and local-midnight rule as the "Today" bucket headers, so
 * a row is never "today" in one list and absent here. Rows for collapsed
 * projects reach the cache through the startup slice's `active_since` filter.
 *
 * Badges and unread dots are not painted here: every caller is a branch of
 * `renderConversationList`, whose single trailing `_refreshAllConvBadges` pass
 * runs after this list and the Projects section have both rendered.
 */

function _todayTaskRows(now) {
  const rows = typeof conversations !== 'undefined' && Array.isArray(conversations)
    ? conversations
    : [];
  const today = typeof selectTodayConversations === 'function'
    ? selectTodayConversations(rows, now)
    : [];
  if (typeof _compareConversationsForSidebar === 'function') {
    today.sort(_compareConversationsForSidebar);
  }
  return today;
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
  if (!rows.length) {
    container.innerHTML = `<div class="conv-empty" data-i18n="sidebar.today_empty">${escapeHtml(t('sidebar.today_empty'))}</div>`;
    return;
  }
  const projectByCid = new Map(rows.map((c) => [c.conversation_id, c.project_id || '']));
  container.innerHTML = rows.map((c) => _renderConversationSidebarItem(c, { listId: 'today-list' })).join('');
  _bindConversationSidebarItems(container, {
    scope: 'today',
    async afterDelete(cid) {
      // A projected task also changes its project's count; the nested project
      // list does the same refresh after its own delete.
      if (projectByCid.get(cid) && typeof loadProjects === 'function') await loadProjects(true);
    },
  });
}
