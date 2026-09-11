// Time-bucket the sidebar conversation list by `last_active_at` (already
// computed by features/chats.ts::listConversations as
// `max(updated_at, created_at)`). Local-time boundaries: today / yesterday /
// last 7 days / last 30 days / older. Pure helper — `now` is injectable so
// the fixture tests in test/renderer/conversation-bucket.test.ts can pin
// DST-free wall clocks.
//
// Kept in its own file (per CLAUDE.md §9 — only pure functions are eligible
// for the CJS bridge that vitest uses; conversation.js touches createLogger /
// window / IPC at top level, so it can't be `require()`d directly).

const _BUCKET_ORDER = ['today', 'yesterday', 'last7', 'last30', 'older'];

function timeBucket(iso, now) {
  if (!now) now = new Date();
  if (!iso) return 'older';
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return 'older';
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  const todayMs = today.getTime();
  const dayMs = 24 * 60 * 60 * 1000;
  if (t >= todayMs) return 'today';
  if (t >= todayMs - dayMs) return 'yesterday';
  if (t >= todayMs - 7 * dayMs) return 'last7';
  if (t >= todayMs - 30 * dayMs) return 'last30';
  return 'older';
}

// Rows whose sidebar activity falls in today's local bucket, in input order.
// Feeds the "Today's Tasks" section with the same `last_active_at` reading as
// the bucketed lists, so a row is never under "Today" in one list and missing
// from the aggregate.
function selectTodayConversations(rows, now) {
  const out = [];
  for (const c of Array.isArray(rows) ? rows : []) {
    if (!c || !c.conversation_id) continue;
    const iso = c.last_active_at || c.updated_at || c.created_at || '';
    if (timeBucket(iso, now) === 'today') out.push(c);
  }
  return out;
}

if (typeof module !== 'undefined' && typeof module.exports === 'object') {
  module.exports = { timeBucket, selectTodayConversations, _BUCKET_ORDER };
}
