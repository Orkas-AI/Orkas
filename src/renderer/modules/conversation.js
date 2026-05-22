const _convLog = createLogger('conversation');

function _uiIconHtml(name, className) {
  if (typeof window !== 'undefined' && typeof window.uiIconHtml === 'function') return window.uiIconHtml(name, className || 'ui-icon');
  return '';
}

// ─── @-mention highlighting (post-render DOM walk) ────────────────────────
// Wrap `@<token>` matches in a `<span class="msg-mention">` so the chat
// bubbles paint mentions in accent color. Done after markdown render via a
// TreeWalker so we don't double-process inside `<code>` / `<pre>` / `<a>`
// (links and code are protected — markdown owners).
//
// Names that contain whitespace or punctuation (e.g. "Software Requirements
// Analyst") can't fit in a static char-class regex. We resolve this by
// dynamically building the regex per call, alternating known agent names
// (longest-first so "Software Requirements Analyst" wins over "Software")
// with the fallback ASCII+CJK token. The fallback handles unknown / partial
// mentions and also matches the bus router's mention parser.
const _MENTION_FALLBACK_CLASS = '[A-Za-z0-9_一-鿿-]+';
const _MENTION_SKIP = new Set(['CODE', 'PRE', 'A', 'SCRIPT', 'STYLE']);

function _escapeForRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function _buildMentionRe() {
  const names = (typeof _agentsCache !== 'undefined' && Array.isArray(_agentsCache))
    ? _agentsCache.map((a) => a && a.name).filter((n) => typeof n === 'string' && n.length)
    : [];
  // Longest-first so multi-word names anchor before any single-word prefix
  // shared with another agent. Two agents named "Foo" and "Foo Bar" both
  // match correctly when the longer alternative is tried first.
  names.sort((a, b) => b.length - a.length);
  const namedAlt = names.length ? names.map(_escapeForRegex).join('|') + '|' : '';
  return new RegExp(`(^|[^A-Za-z0-9_一-鿿-])(@(?:${namedAlt}${_MENTION_FALLBACK_CLASS}))`, 'gu');
}

function _highlightMentionsIn(rootEl) {
  if (!rootEl) return;
  const re = _buildMentionRe();
  const walker = document.createTreeWalker(rootEl, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      let p = node.parentNode;
      while (p && p !== rootEl) {
        if (p.tagName && _MENTION_SKIP.has(p.tagName)) return NodeFilter.FILTER_REJECT;
        p = p.parentNode;
      }
      re.lastIndex = 0;
      return re.test(node.nodeValue || '')
        ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
    },
  });
  const targets = [];
  let n;
  while ((n = walker.nextNode())) targets.push(n);
  for (const node of targets) {
    const text = node.nodeValue || '';
    re.lastIndex = 0;
    const frag = document.createDocumentFragment();
    let last = 0;
    let m;
    while ((m = re.exec(text)) !== null) {
      const beforeStart = last;
      const beforeEnd = m.index + m[1].length;
      if (beforeEnd > beforeStart) {
        frag.appendChild(document.createTextNode(text.slice(beforeStart, beforeEnd)));
      }
      const span = document.createElement('span');
      span.className = 'msg-mention';
      span.textContent = m[2];
      frag.appendChild(span);
      last = re.lastIndex;
    }
    if (last < text.length) frag.appendChild(document.createTextNode(text.slice(last)));
    if (node.parentNode) node.parentNode.replaceChild(frag, node);
  }
}

// Wrap `renderMarkdownFull` so every chat-bubble render passes through the
// mention highlighter. Same signature as the underlying function so call
// sites just swap.
function _renderMessageMarkdown(text) {
  const html = renderMarkdownFull(String(text || ''));
  // Mention highlighting requires DOM walking — do it on a detached
  // container, then return its innerHTML for the bubble to embed.
  if (!html || html.indexOf('@') < 0) return html;
  const tmp = document.createElement('div');
  tmp.innerHTML = html;
  _highlightMentionsIn(tmp);
  return tmp.innerHTML;
}

// Build the mirror HTML for a textarea's raw value. Escapes everything
// EXCEPT `@<token>` matches, which become accent-coloured spans. The
// trailing-newline special-case (`\n` → `\n​`) keeps the mirror's
// content height matching the textarea after the user just hit Enter,
// otherwise CSS `pre-wrap` collapses the trailing line and the mirror
// shows a half-line less than the textarea.
function _buildMirrorHtml(text) {
  if (!text) return '';
  const re = _buildMentionRe();
  let html = '';
  let last = 0;
  let m;
  while ((m = re.exec(text)) !== null) {
    const beforeStart = last;
    const beforeEnd = m.index + m[1].length;
    if (beforeEnd > beforeStart) html += escapeHtml(text.slice(beforeStart, beforeEnd));
    html += `<span class="msg-mention">${escapeHtml(m[2])}</span>`;
    last = re.lastIndex;
  }
  if (last < text.length) html += escapeHtml(text.slice(last));
  if (text.endsWith('\n')) html += '​';
  return html;
}

// Wrap a chat textarea with a synced mirror div for inline mention
// highlighting. Idempotent — flagged via dataset.mentionMirror so a
// re-init (e.g. theme switch) doesn't double-wrap. Quietly skips if the
// element is already mounted (e.g. when called too early at boot, the
// caller can retry on `DOMContentLoaded`).
function _initMentionMirror(textarea) {
  if (!textarea || textarea.dataset.mentionMirror === '1') return;
  if (!textarea.parentNode) return;
  textarea.dataset.mentionMirror = '1';

  const wrap = document.createElement('div');
  wrap.className = 'chat-input-mirror-wrap';
  const mirror = document.createElement('div');
  mirror.className = 'chat-input-mirror';
  mirror.setAttribute('aria-hidden', 'true');

  // Insert wrap in place of textarea, move textarea inside.
  textarea.parentNode.insertBefore(wrap, textarea);
  wrap.appendChild(mirror);
  wrap.appendChild(textarea);

  let lastSynced = '';
  const sync = () => {
    const v = textarea.value || '';
    if (v === lastSynced) return;
    lastSynced = v;
    mirror.innerHTML = _buildMirrorHtml(v);
  };
  const syncScroll = () => {
    mirror.scrollTop = textarea.scrollTop;
  };
  textarea.addEventListener('input', sync);
  textarea.addEventListener('scroll', syncScroll, { passive: true });
  // Programmatic value changes (send-clears the input, agent-picker
  // inserts `@<name>`, draft restore on conv switch) don't fire `input`
  // natively. Most call sites dispatch one explicitly, but a 100ms
  // safety poll catches any we missed without per-callsite plumbing.
  // String-compare cost is negligible; we only do real work when the
  // value actually drifted from the last paint.
  setInterval(sync, 100);
  sync();
}

// Set up mirrors for the two chat panels that participate in the group-
// chat `@` semantics. Other chat panels (skill-edit, agent-edit) don't
// route via the bus's mention parser, so they keep the plain textarea.
function _initAllMentionMirrors() {
  const chatInput = document.getElementById('chat-input');
  if (chatInput) _initMentionMirror(chatInput);
  const newChatInput = document.getElementById('new-chat-input');
  if (newChatInput) _initMentionMirror(newChatInput);
}
if (typeof window !== 'undefined') {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', _initAllMentionMirrors, { once: true });
  } else {
    _initAllMentionMirrors();
  }
}

// ─── Recipient chip — per-cid for conversations, ephemeral for new-chat ──
// Each persisted conversation remembers its own last-picked recipient (so
// switching between conversations restores their distinct contexts) and
// stays sticky on view-enter — the only thing that overrides it is the
// auto-switch to a live interactive agent (see `_evaluateAutoRecipient`).
// The new-chat (commander landing) resets to commander only when its input
// box is empty; otherwise the user's in-progress draft keeps its target.
const _COMMANDER = { kind: 'commander', id: '', name: '' };
const _RECIPIENT_LS_KEY = 'chat.recipientByCid';
let _recipientByCid = {};       // { [cid]: {kind,id,name} } — agents only; commander = absence
let _newChatRecipient = { ..._COMMANDER }; // ephemeral, reset on view-enter
let _pendingNewChatRecipient = null;        // captured at send time, transferred to new cid

function _loadRecipientMap() {
  try {
    const raw = localStorage.getItem(_RECIPIENT_LS_KEY);
    if (!raw) return;
    const v = JSON.parse(raw);
    if (v && typeof v === 'object') _recipientByCid = v;
  } catch (_) { /* corrupt entry — start fresh */ }
}
_loadRecipientMap();

function _saveRecipientMap() {
  try { localStorage.setItem(_RECIPIENT_LS_KEY, JSON.stringify(_recipientByCid)); } catch (_) {}
}

// Quote-reply state (per-cid, in-memory). Declared early so the
// DOMContentLoaded init branch below — which may invoke _renderQuotePreview
// synchronously when the document is already loaded — doesn't hit a TDZ on
// the binding. The helper functions live further down with the rest of the
// quote infrastructure (_setQuote / _getQuote / _clearQuote / _renderQuotePreview).
const _quoteByCid = new Map();   // cid → { fromActor, fromName, msgId, text, produced[] } | undefined

function _normRecipient(next) {
  if (!next || (next.kind !== 'commander' && next.kind !== 'agent')) return null;
  if (next.kind === 'commander') return { ..._COMMANDER };
  return { kind: 'agent', id: String(next.id || ''), name: String(next.name || next.id || '') };
}

function _activeRecipient(target) {
  if (target === 'new-chat') return _newChatRecipient;
  if (currentCid && _recipientByCid[currentCid]) return _recipientByCid[currentCid];
  return _COMMANDER;
}

function getChatRecipient(target) { return { ..._activeRecipient(target) }; }

function _onRecipientChanged(_target) { /* reserved for future hooks */ }

/** When the active project's bindings change (commander chip → switch
 *  project, or project rename/binding edit while a chat is open), the
 *  current recipient may no longer be a valid agent for the new scope.
 *  Reset to commander silently — the user will see the chip flip and the
 *  recipient picker collapse to commander-only on next open. Called from
 *  `projects.js` post project-pick. No-op for `commander` recipients and
 *  for orphan contexts (pid empty). */
async function validateRecipientAgainstProject(target, pid) {
  const cur = _activeRecipient(target);
  if (!cur || cur.kind !== 'agent') return;
  if (!pid) return;
  try {
    const res = await window.orkas.invoke('projects.bindings.list', { projectId: pid });
    if (!res || !res.ok) return;
    const bound = new Set((res.bindings && res.bindings.agents) || []);
    if (!bound.has(cur.id)) {
      setChatRecipient(target, { kind: 'commander' });
      _renderRecipientChip(target);
    }
  } catch (_) { /* leave as-is on failure */ }
}

function setChatRecipient(target, next, _opts = {}) {
  const r = _normRecipient(next);
  if (!r) return;
  if (target === 'new-chat') {
    _newChatRecipient = r;
  } else if (currentCid) {
    if (r.kind === 'commander') delete _recipientByCid[currentCid];
    else _recipientByCid[currentCid] = r;
    _saveRecipientMap();
  }
  _renderRecipientChip(target);
  _onRecipientChanged(target);
}

// Called by the new-chat send path *after* the new conv id is known so the
// freshly-created conversation inherits the recipient the user picked on
// the landing page (otherwise the chip would snap back to commander as
// soon as the conversation panel takes over).
function _transferNewChatRecipientTo(cid) {
  if (!cid || !_pendingNewChatRecipient) { _pendingNewChatRecipient = null; return; }
  const r = _pendingNewChatRecipient;
  _pendingNewChatRecipient = null;
  if (r.kind === 'agent') {
    _recipientByCid[cid] = r;
    _saveRecipientMap();
  }
}

function _renderRecipientChip(target) {
  const targets = target ? [target] : ['conversation', 'new-chat'];
  for (const tg of targets) {
    const id = tg === 'new-chat' ? 'new-chat-recipient-name' : 'chat-recipient-name';
    const nameEl = document.getElementById(id);
    if (!nameEl) continue;
    const r = _activeRecipient(tg);
    if (r.kind === 'agent' && r.id) {
      // Resolve name from the live registry first — the `r.name` field is
      // a snapshot taken at picker time and stays stale after rename. Fall
      // back to the snapshot only when the registry doesn't know the agent
      // (e.g. it was deleted), then to the id as a last resort.
      let display = '';
      if (typeof _agentsCache !== 'undefined' && Array.isArray(_agentsCache)) {
        const a = _agentsCache.find((x) => x && x.agent_id === r.id);
        if (a && a.name) display = a.name;
      }
      if (!display) display = r.name || r.id;
      nameEl.textContent = '@' + display;
      nameEl.removeAttribute('data-i18n');
    } else {
      nameEl.setAttribute('data-i18n', 'chat.recipient_commander');
      nameEl.textContent = t('chat.recipient_commander');
    }
  }
}

// Hooks called by setView (boot.js) so the chip mirrors the active context.
function onEnterNewChatView() {
  // The new-chat input is the only place the recipient is ephemeral. Reset
  // to commander only when the textarea is empty — if the user has typed
  // anything, treat that as an in-progress message whose target they
  // already chose, and leave the chip alone.
  const input = document.getElementById('new-chat-input');
  const hasDraft = !!(input && input.value);
  if (!hasDraft) _newChatRecipient = { ..._COMMANDER };
  _renderRecipientChip('new-chat');
  // Project chip lives in projects.js — restore the last manual pick
  // (lastProject localStorage) and refresh the workspace chip's scope.
  if (typeof onEnterCommanderProjectChip === 'function') onEnterCommanderProjectChip();
}
function onEnterConversationView() {
  _renderRecipientChip('conversation');
  // Workspace chip scope follows the active conv's project (resolved on
  // main side via cid → conv.project_id). Refresh whenever a conv mounts.
  if (typeof refreshWorkspaceChip === 'function') refreshWorkspaceChip();
  // Recipient validation: bindings may have changed since this conv was
  // last open (user removed the agent from the project). If the sticky
  // recipient is no longer in the project's agents, drop back to commander
  // so the chip matches what the dispatch path will actually route to.
  if (currentCid && Array.isArray(conversations)) {
    const conv = conversations.find((c) => c && c.conversation_id === currentCid);
    const pid = (conv && conv.project_id) || '';
    if (pid && typeof validateRecipientAgainstProject === 'function') {
      validateRecipientAgainstProject('conversation', pid);
    }
  }
  // Empty-bindings banner: when this conv belongs to a project and the
  // project has zero agents bound, surface a one-line notice + "Open
  // project page" affordance. Cheap IPC; only fires for in-project
  // conversations.
  if (typeof refreshConvProjectEmptyBanner === 'function') refreshConvProjectEmptyBanner(currentCid);
  // One-shot auto-expand: if the conv we just entered belongs to a
  // project, surface the project's row in the sidebar. Skipped when the
  // project is already expanded; manual user collapse on subsequent
  // renders is preserved (the auto-expand does not run inside
  // renderProjectsSection — see comments in projects.js).
  if (typeof autoExpandActiveConvProject === 'function') autoExpandActiveConvProject();
  // Kick a one-shot evaluation so that a cid mid-plan picks up its current
  // interactive assignee even if no plan_changed/state_changed event fires
  // before the user types. View-enter never reverts to commander (see
  // `_evaluateAutoRecipient`); the persisted per-cid pick stays sticky.
  if (currentCid) _evaluateAutoRecipient(currentCid);
  // Bind the plan rail to the active cid on EVERY conversation-view enter,
  // including the `skipLoad: true` path used by fresh conversations (where
  // loadConversationHistory is intentionally skipped). Without this hook,
  // the rail would keep displaying the previous cid's plan content.
  if (window.PlanRail) window.PlanRail.bind(currentCid || null);
  if (window.ConversationInfo) window.ConversationInfo.bind(currentCid || null);
  // Quote preview is per-cid; rerender so a quote captured in another conv
  // doesn't bleed into this one (and a quote left in this conv reappears
  // when the user navigates back).
  _renderQuotePreview();
}

// Called by queue-draft.js::_forgetConvLocal when a conv is deleted so we
// don't accumulate dead entries in localStorage forever.
function _forgetCidRecipient(cid) {
  if (!cid) return;
  if (_recipientByCid[cid]) {
    delete _recipientByCid[cid];
    _saveRecipientMap();
  }
  setGroupConversationBusy(cid, false);
  _latestInFlight.delete(cid);
  _lastInteractiveTurnAgent.delete(cid);
  // Drop any pending quote for the deleted conv (memory only — no localStorage).
  _quoteByCid.delete(cid);
}

// ─── Auto-recipient: follow the interactive agent on plan dispatch ───────
// Goal: when a plan step assigned to an `interactive: true` agent enters
// `in_progress`, default the input box recipient to that agent so the user's
// next reply lands there without manual @-mention. When no interactive step
// is in flight, leave the recipient alone — the persisted per-cid pick is
// the source of truth. Auto-switching to a live interactive agent always
// wins, even over a manual pick (the user explicitly asked for this).
//
// Concurrency notes:
//   - Multiple interactive in_progress steps → take the latest plan index
//     ("most recently dispatched" matches user intent in linear chains; in
//     true fan-out interactive agents are a degenerate case the user can
//     correct manually).
//   - Re-entrancy guarded by `_autoEvalInflight` so back-to-back plan_changed
//     + state_changed events coalesce into one fetch round.
//   - Sticky beyond `in_progress`: an interactive agent's step often ends
//     `blocked` (form pause) or even `done` (back-and-forth tutoring with
//     no form) before the user has typed a single character. Reverting away
//     the instant the agent's turn settles erases the auto-target before it
//     has any value. Logic widens to "blocked and done count too, last
//     terminal step's assignee wins when no live step is running".
const _autoEvalInflight = new Set(); // cid set
const _latestInFlight = new Map();   // cid → string[] (mirrors state_changed.state.in_flight)
// cid → most recent interactive agent that produced an end-of-turn message.
// Used as Phase 1.5 sticky when there's no plan + nobody in flight (single
// agent dispatch via @-mention finished a turn but user hasn't replied yet).
const _lastInteractiveTurnAgent = new Map();
async function _evaluateAutoRecipient(cid) {
  if (!cid || cid !== currentCid) return;
  if (_autoEvalInflight.has(cid)) return;
  _autoEvalInflight.add(cid);
  try {
    // Fetch members + plan in parallel. Members carry the per-agent
    // `interactive` flag (server enriches in `groupChat.listMembers`).
    const [members, plan] = await Promise.all([
      _refreshGroupMembers(cid),
      _fetchPlanForAutoRecipient(cid),
    ]);
    if (cid !== currentCid) return; // user navigated away mid-fetch
    const inFlight = _latestInFlight.get(cid) || [];
    const interactiveAgent = _pickInteractiveAgent(plan, members || [], inFlight);
    if (!interactiveAgent) return; // no live interactive target — keep the persisted pick
    const cur = _activeRecipient('conversation');
    if (cur.kind === 'agent' && cur.id === interactiveAgent.id) return;
    setChatRecipient('conversation',
      { kind: 'agent', id: interactiveAgent.id, name: interactiveAgent.name });
  } catch (err) {
    _convLog?.warn?.('auto-recipient evaluate failed', err);
  } finally {
    _autoEvalInflight.delete(cid);
  }
}

async function _fetchPlanForAutoRecipient(cid) {
  try {
    const res = await apiFetch(`/api/conversations/${cid}/plan`);
    const data = await res.json();
    if (data?.ok && data.plan && Array.isArray(data.plan.steps)) return data.plan;
  } catch (_) { /* best-effort */ }
  return null;
}

function _pickInteractiveAgent(plan, members, inFlight) {
  // Commander mid-turn → don't auto-switch to an agent (commander's reply is
  // about to land); leave the persisted recipient as-is.
  if (Array.isArray(inFlight) && inFlight.includes('commander')) return null;

  const byName = new Map();
  const byId = new Map();
  for (const m of members) {
    if (m && m.kind === 'agent') {
      if (m.name) byName.set(m.name, m);
      if (m.id) byId.set(m.id, m);
    }
  }
  const isReserved = (a) => a === 'commander' || a === '指挥官';
  const isUser = (a) => a === 'user' || a === '用户';
  const lookup = (a) => byName.get(a) || byId.get(a);

  // Phase 0 — any agent in flight right now (covers single-agent dispatch
  // via commander `@<name>` which never creates a plan, and so the
  // plan-only Phase 1 / 2 below would miss it). Last-wins among interactive
  // in-flight agents; a non-interactive agent in flight = release the chip
  // (let user reply via commander).
  if (Array.isArray(inFlight) && inFlight.length) {
    let liveInflight = null;
    let nonInteractive = false;
    for (const id of inFlight) {
      if (isReserved(id) || isUser(id)) continue;
      const actor = byId.get(id) || byName.get(id);
      if (!actor) continue;
      if (actor.interactive === true) liveInflight = actor;
      else nonInteractive = true;
    }
    if (liveInflight) return liveInflight;
    if (nonInteractive) return null;
  }

  // Phase 1.5 — sticky on the agent that last spoke a turn-end message,
  // **only** when nothing is currently running (Phase 0 already returned
  // for a live in-flight). Covers single-agent dispatch (no plan) where the
  // agent finishes its turn and waits for the user to reply.
  const stickyId = _lastInteractiveTurnAgent.get(currentCid);
  const stickyEmpty = !Array.isArray(inFlight) || inFlight.length === 0;
  if (stickyId && stickyEmpty) {
    const actor = byId.get(stickyId) || byName.get(stickyId);
    if (actor && actor.interactive === true) return actor;
  }

  if (!plan || !Array.isArray(plan.steps) || plan.steps.length === 0) return null;

  // Phase 1 — any live plan step (in_progress / blocked).
  // Commander live anywhere → release. Else last-wins among interactive
  // agents; non-interactive agent live elsewhere → release (let it own the
  // floor, user replies should go via commander).
  let livePick = null;
  let livePresent = false;
  let liveNonInteractive = false;
  for (const s of plan.steps) {
    if (s.status !== 'in_progress' && s.status !== 'blocked') continue;
    livePresent = true;
    const a = String(s.assignee || '').trim();
    if (isReserved(a)) return null;
    if (isUser(a)) continue;
    const actor = lookup(a);
    if (actor && actor.interactive === true) livePick = actor;
    else liveNonInteractive = true;
  }
  if (livePick) return livePick;
  if (livePresent && liveNonInteractive) return null;

  // Phase 2 — no live plan step. Look at the most recent terminal step's
  // actor; if it's an interactive agent, stay sticky on it so the user's
  // next message reaches the same agent (covers "tutor said something,
  // waiting for the student" — no form, step already `done`, no successor
  // running).
  for (let i = plan.steps.length - 1; i >= 0; i--) {
    const s = plan.steps[i];
    const term = s.status === 'done' || s.status === 'failed' || s.status === 'skipped';
    if (!term) continue;
    const a = String(s.assignee || '').trim();
    if (isReserved(a)) return null;     // commander ran last → commander chip
    if (isUser(a)) continue;            // user-targeted step → look further back
    const actor = lookup(a);
    return actor && actor.interactive === true ? actor : null;
  }
  return null;
}

// Strip a leading `@<name>` token so the mention regex matches the bus
// router's charset. Used to detect whether the user already typed an
// @-prefix that would route somewhere.
const _LEADING_MENTION_RE = /^@([A-Za-z0-9_一-鿿-]+)\s?/u;

function applyRecipientPrefix(raw, target) {
  const r = _activeRecipient(target || 'conversation');
  if (r.kind !== 'agent' || !r.id) return raw;
  const text = String(raw || '');
  if (_LEADING_MENTION_RE.exec(text)) return text;
  // Resolve from the live registry by id — `r.name` is a localStorage
  // snapshot taken at picker time, so a rename leaves it stale and the
  // outgoing `@<token>` would still carry the old name. Fall back to the
  // snapshot when the registry doesn't know the agent (deleted), then to
  // the id as last resort.
  let display = '';
  if (typeof _agentsCache !== 'undefined' && Array.isArray(_agentsCache)) {
    const a = _agentsCache.find((x) => x && x.agent_id === r.id);
    if (a && a.name) display = a.name;
  }
  if (!display) display = r.name || r.id;
  const tag = '@' + String(display);
  // When the raw body starts with a blockquote (e.g. the quote-reply prefix
  // injected by applyQuotePrefix), use a newline separator so the @-mention
  // ends up on its own line — markdown only treats `>` as a blockquote when
  // it sits at column 0, and `@AgentB > ...` on one line collapses the
  // blockquote into plain prose. Plain-text bodies keep the original space.
  const sep = /^>/.test(text) ? '\n' : ' ';
  return tag + sep + text;
}

if (typeof window !== 'undefined') {
  const initChip = () => { _renderRecipientChip(); _renderQuotePreview(); };
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initChip, { once: true });
  } else {
    initChip();
  }
  window.addEventListener('i18n-change', () => { _renderRecipientChip(); _renderQuotePreview(); });
}

// ─── Group-chat translation layer ─────────────────────────────────────────
// Backend now stores GroupMessage{ id, ts, from, to, mentions?, text, ... }.
// Renderer's existing bubble code expects MessageRecord{ role, content, time }.
// Translate at read/stream boundary so we don't have to rewrite every render
// path. `from === 'user'` → role=user; otherwise role=assistant with a
// "from-name" label rendered as a header chip on the bubble.
const GROUP_RESERVED = new Set(['user', 'commander']);

// Commander avatar preference, lazy-loaded cache. Used by the chat row
// renderer — fire one IPC before the first render, then refresh this
// cache on every subsequent update. `null` = not loaded / unavailable;
// the render layer falls back to the default itself.
let _commanderAvatarCache = null;
function _commanderAvatar() {
  return _commanderAvatarCache || COMMANDER_DEFAULT;
}
async function _ensureCommanderAvatarLoaded() {
  if (_commanderAvatarCache) return _commanderAvatarCache;
  try {
    const res = await window.orkas.invoke('prefs.getCommanderAvatar');
    if (res?.ok && res.avatar) {
      _commanderAvatarCache = { icon: res.avatar.icon, color: res.avatar.color };
    }
  } catch (_) { /* fall back to default */ }
  return _commanderAvatarCache || COMMANDER_DEFAULT;
}
function setCommanderAvatarCache(avatar) {
  if (avatar && avatar.icon && avatar.color) {
    _commanderAvatarCache = { icon: avatar.icon, color: avatar.color };
  }
}
/** Render the message row avatar. `fromId` is known to be non-'user'. */
function _renderActorAvatarHtml(fromId) {
  if (fromId === 'commander') {
    const a = _commanderAvatar();
    return renderAvatarHtml(a.icon, a.color, { size: 28, seed: 'commander' });
  }
  // The global agents registry takes priority — it's always the current
  // truth. The per-group member cache is just a join-time snapshot and
  // does not follow rename / avatar changes, so it serves as fallback
  // for legacy conversations whose agent has since been deleted from
  // the registry.
  let icon, color;
  if (typeof _agentsCache !== 'undefined' && Array.isArray(_agentsCache)) {
    const a = _agentsCache.find((x) => x && x.agent_id === fromId);
    if (a) { icon = a.icon; color = a.color; }
  }
  if (!icon || !color) {
    const members = _groupMembersCache.get(currentCid);
    if (members) {
      const m = members.find((x) => x.id === fromId);
      if (m) { icon = icon || m.icon; color = color || m.color; }
    }
  }
  return renderAvatarHtml(icon, color, { size: 28, seed: fromId || 'agent' });
}
/** Resolve an actor id (commander / user / agent_id) to a human-readable
 *  display name. **Never returns the raw agent_id** — UI shouldn't expose
 *  hex strings to the user. Global registry is checked first so renames
 *  reflect immediately in old conversations; per-conv roster (a join-time
 *  snapshot) is the fallback for agents the registry no longer knows about
 *  (deleted agents whose old chats still need a label). */
function _groupActorLabel(fromId) {
  if (fromId === 'user') return null;
  if (fromId === 'commander') return t('chat.from_commander');
  if (typeof _agentsCache !== 'undefined' && Array.isArray(_agentsCache)) {
    const a = _agentsCache.find((x) => x && x.agent_id === fromId);
    if (a && a.name) return a.name;
  }
  const cached = _groupMembersCache.get(currentCid);
  if (cached) {
    const a = cached.find((x) => x.id === fromId);
    if (a && a.name) return a.name;
  }
  // Last resort: never leak the id. Show a neutral placeholder; the chip
  // will repaint as soon as the cache catches up (state_changed handler
  // refreshes _groupMembersCache).
  return t('chat.from_agent_unknown');
}
const _groupMembersCache = new Map(); // cid → Actor[]
async function _refreshGroupMembers(cid) {
  if (!cid) return [];
  try {
    const res = await apiFetch(`/api/conversations/${cid}/members`);
    const data = await res.json();
    if (data?.ok && Array.isArray(data.actors)) {
      _groupMembersCache.set(cid, data.actors);
      _refreshActorPlaceholders(cid);
      // Roster change can flip the inline "create agent" button visibility:
      // a freshly @-mentioned agent joins members.json before it streams a
      // reply, and the button must hide as soon as that happens.
      if (cid === currentCid) {
        try { _ensureConvCreateAgentInline(); } catch (_) { /* non-fatal */ }
      }
      return data.actors;
    }
  } catch (_) { /* non-fatal */ }
  return _groupMembersCache.get(cid) || [];
}

function _rememberGroupActor(cid, actor) {
  if (!cid || !actor || !actor.id) return;
  const existing = _groupMembersCache.get(cid) || [];
  const idx = existing.findIndex((x) => x && x.id === actor.id);
  const next = existing.slice();
  if (idx >= 0) next[idx] = { ...next[idx], ...actor };
  else next.push(actor);
  _groupMembersCache.set(cid, next);
  _refreshActorPlaceholders(cid, actor.id);
}

// Read-side normalizer: jsonl records written before the multi-edit
// migration carry singular `created_agent`; new ones carry plural
// `created_agents`. Returns the array, or `null` when neither field is set.
function _normalizeCreatedAgents(gm) {
  if (!gm) return null;
  if (Array.isArray(gm.created_agents) && gm.created_agents.length) return gm.created_agents;
  if (gm.created_agent && gm.created_agent.agent_id) return [gm.created_agent];
  return null;
}
function _normalizeCreatedSkills(gm) {
  if (!gm) return null;
  if (Array.isArray(gm.created_skills) && gm.created_skills.length) return gm.created_skills;
  if (gm.created_skill && gm.created_skill.skill_id) return [gm.created_skill];
  return null;
}

function _groupMsgToLegacy(gm) {
  if (!gm || typeof gm !== 'object') return gm;
  if (gm.role !== undefined) return gm; // already legacy shape
  const fromId = String(gm.from || 'user');
  const role = fromId === 'user' ? 'user' : 'assistant';
  // Prepend a "from-name" header so user can tell who sent each message.
  // Skip for `user` (their own messages) and `commander` (default reply
  // source — labeling every commander msg is noise; UI accent color tells).
  let body = String(gm.text || '');
  let label = '';
  if (fromId !== 'user' && fromId !== 'commander') {
    label = _groupActorLabel(fromId) || fromId;
  }
  const out = {
    role,
    content: body,
    time: gm.ts || new Date().toISOString(),
    _from: fromId,
    _msg_id: gm.id,
    ...(label ? { _from_label: label } : {}),
    ...(Array.isArray(gm.attachments) && gm.attachments.length ? { attachments: gm.attachments } : {}),
    ...(Array.isArray(gm.produced) && gm.produced.length ? { produced: gm.produced } : {}),
    ...(gm.form ? { form: gm.form } : {}),
    ...(_normalizeCreatedAgents(gm) ? { created_agents: _normalizeCreatedAgents(gm) } : {}),
    ...(_normalizeCreatedSkills(gm) ? { created_skills: _normalizeCreatedSkills(gm) } : {}),
    ...(Array.isArray(gm.artifacts) && gm.artifacts.length ? { artifacts: gm.artifacts } : {}),
    ...(Array.isArray(gm.marketplace_requests) && gm.marketplace_requests.length ? { marketplace_requests: gm.marketplace_requests } : {}),
    ...(gm.plan_announcement ? { _plan_announcement: true } : {}),
    ...(Array.isArray(gm.process) && gm.process.length ? { process: gm.process } : {}),
  };
  return out;
}

// ─── Chat attachments (pending-send pool per cid) ─────────────────────────
// User picks files via "+" → we upload them to `<cid>/` and remember them in
// this Map. On send we hand the filenames to the server; on success the list
// for that cid is cleared (per-message granularity). Each entry is {name, kind, bytes, dataUrl?}.

const _chatAttachments = new Map();   // cid → Array<{name, kind, bytes, dataUrl?}>

// Draft cid used by the commander (new-chat) tab — files land under
// `data/<uid>/chat_attachments/main_chat/` until the user hits send, at which
// point the backend renames that dir to the freshly-minted conversation cid
// (see `adoptDraftAttachments`).
const DRAFT_CID = 'main_chat';

const CHAT_ATTACH_ACCEPT = [
  '.md', '.markdown', '.txt', '.csv', '.tsv', '.json', '.yaml', '.yml', '.log',
  '.pdf', '.docx',
  '.png', '.jpg', '.jpeg', '.webp', '.gif',
  '.mp4', '.webm', '.mov', '.m4v', '.ogv',
];

const CHAT_IMAGE_EXTS = ['.png', '.jpg', '.jpeg', '.webp', '.gif'];
const CHAT_VIDEO_EXTS = ['.mp4', '.webm', '.mov', '.m4v', '.ogv'];

function _chatFileIconHtml(name, kind) {
  if (typeof window !== 'undefined' && typeof window.fileKindIconHtml === 'function') return window.fileKindIconHtml(name, kind);
  return '';
}

function _chatAttachExtOf(name) {
  const i = (name || '').lastIndexOf('.');
  return i >= 0 ? name.slice(i).toLowerCase() : '';
}

function _chatAttachKindFromExt(ext) {
  if (CHAT_IMAGE_EXTS.includes(ext)) return 'image';
  if (CHAT_VIDEO_EXTS.includes(ext)) return 'video';
  if (ext === '.pdf') return 'pdf';
  if (ext === '.docx') return 'docx';
  return 'text';
}

// Build the `chat-media://` URL for serving an attachment's raw bytes to an
// <img> or <video>. The main-process handler enforces uid + path safety; we
// just URL-encode both path segments here.
function _chatMediaUrl(cid, name) {
  return `chat-media://cid/${encodeURIComponent(cid)}/${encodeURIComponent(name)}`;
}

function _chatAttachList(cid) {
  return _chatAttachments.get(cid) || [];
}

function _chatAttachSet(cid, items) {
  _chatAttachments.set(cid, items);
  _chatAttachRenderChips(cid);
  if (cid && cid === currentCid && window.ConversationInfo) {
    window.ConversationInfo.refreshAttachments(cid);
  }
}

function _chatAttachClear(cid) {
  _chatAttachments.delete(cid);
  _chatAttachRenderChips(cid);
}

// cid → DOM host id for the chip row. Draft cid (commander tab) renders into the
// new-chat panel; any real cid renders into the active conversation panel
// only when it matches currentCid (stale states for other cids stay in the
// Map but aren't painted).
function _chatAttachHostIdFor(cid) {
  if (cid === DRAFT_CID) return 'new-chat-attachments';
  if (cid && cid === currentCid) return 'chat-attachments';
  return null;
}

function _chatAttachRenderChips(cid) {
  const targetCid = cid || currentCid;
  const hostId = _chatAttachHostIdFor(targetCid);
  if (!hostId) return;
  const host = document.getElementById(hostId);
  if (!host) return;
  const items = _chatAttachList(targetCid);
  if (!items.length) {
    host.style.display = 'none';
    host.innerHTML = '';
    return;
  }
  host.style.display = '';
  host.innerHTML = items.map((it, i) => {
    const icon = it.kind === 'image'
      ? (it.dataUrl ? `<img class="chat-attach-thumb" src="${it.dataUrl}" alt="">` : _chatFileIconHtml(it.name, it.kind))
      : _chatFileIconHtml(it.name, it.kind);
    const label = escapeHtml(it.name);
    const busy = it.status === 'uploading';
    const errored = it.status === 'error';
    const klass = `chat-attach-chip${busy ? ' is-uploading' : ''}${errored ? ' is-error' : ''}`;
    const overlay = busy ? `<span class="chat-attach-spinner" aria-label="${escapeHtml(t('chat.attach_uploading'))}"></span>` : '';
    const removable = !busy;   // × stays clickable when errored so user can clear
    const removeBtn = removable
      ? `<span class="chat-attach-remove" data-idx="${i}" title="${escapeHtml(t('chat.attach_remove_title'))}">×</span>`
      : '';
    return `
      <span class="${klass}" data-idx="${i}" title="${label}">
        <span class="chat-attach-icon">${icon}</span>
        <span class="chat-attach-label">${label}</span>
        ${overlay}
        ${removeBtn}
      </span>`;
  }).join('');
  host.querySelectorAll('.chat-attach-remove').forEach((el) => {
    el.addEventListener('click', async (e) => {
      e.stopPropagation();
      const idx = Number(el.dataset.idx);
      await _chatAttachRemove(targetCid, idx);
    });
  });
}

async function _chatAttachRemove(cid, idx) {
  const items = _chatAttachList(cid).slice();
  const item = items[idx];
  if (!item) return;
  // Revoke object URLs we minted locally for image previews.
  if (item.dataUrl && item.dataUrl.startsWith('blob:')) {
    try { URL.revokeObjectURL(item.dataUrl); } catch (_) { /* ignore */ }
  }
  // Only hit the server if the upload actually completed — placeholders
  // that errored out or are still uploading have no disk counterpart yet.
  if (item.status !== 'uploading') {
    try {
      await apiFetch(`/api/conversations/${encodeURIComponent(cid)}/attachments?name=${encodeURIComponent(item.name)}`, {
        method: 'DELETE',
      });
    } catch (err) {
      _convLog.warn('delete attachment failed', err);
    }
  }
  items.splice(idx, 1);
  _chatAttachSet(cid, items);
}

function _chatAttachReplaceByTempId(cid, tempId, patch) {
  const items = _chatAttachList(cid).slice();
  const idx = items.findIndex((it) => it.tempId === tempId);
  if (idx < 0) return;
  if (patch === null) {
    // Drop the entry entirely (error path).
    items.splice(idx, 1);
  } else {
    items[idx] = { ...items[idx], ...patch };
  }
  _chatAttachSet(cid, items);
}

async function _chatAttachUpload(cid, fileList) {
  const files = Array.from(fileList || []);
  if (!files.length) return;

  // ── Step 1: show placeholders immediately ────────────────────────────
  // Append a busy chip for each file *before* any network I/O so the user
  // sees the chip appear the instant they pick files. Images get a cheap
  // local preview via URL.createObjectURL — no extra roundtrip needed.
  const placeholders = [];
  const current = _chatAttachList(cid).slice();
  for (const file of files) {
    const ext = _chatAttachExtOf(file.name);
    const kind = _chatAttachKindFromExt(ext);
    const tempId = `att-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    let localPreview = null;
    if (kind === 'image') {
      try { localPreview = URL.createObjectURL(file); } catch (_) { /* ignore */ }
    }
    const entry = {
      tempId, name: file.name, kind, bytes: file.size || 0,
      dataUrl: localPreview, status: 'uploading',
    };
    current.push(entry);
    placeholders.push({ tempId, file, ext });
  }
  _chatAttachSet(cid, current);

  // ── Step 2: upload all in parallel; rendering is already done ─────────
  const rejected = [];
  await Promise.all(placeholders.map(async (ph) => {
    if (!CHAT_ATTACH_ACCEPT.includes(ph.ext)) {
      _chatAttachReplaceByTempId(cid, ph.tempId, null);
      rejected.push(t('chat.attach_unsupported', { name: ph.file.name }));
      return;
    }
    try {
      const buf = await ph.file.arrayBuffer();
      const res = await apiFetch(`/api/conversations/${encodeURIComponent(cid)}/attachments/upload`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/octet-stream',
          'X-Filename': encodeURIComponent(ph.file.name),
        },
        body: buf,
      });
      const data = await res.json();
      if (!data.ok) {
        _chatAttachReplaceByTempId(cid, ph.tempId, null);
        rejected.push(t('chat.attach_upload_fail', { name: ph.file.name, reason: data.error || t('chat.attach_upload_generic_fail') }));
        return;
      }
      const info = data.info;
      // Keep the local blob URL for image previews — no need for a second
      // roundtrip to fetch a dataUrl the server would just base64 back.
      _chatAttachReplaceByTempId(cid, ph.tempId, {
        name: info.name,
        kind: info.kind,
        bytes: info.bytes,
        status: 'ready',
      });
    } catch (err) {
      _chatAttachReplaceByTempId(cid, ph.tempId, null);
      rejected.push(t('chat.attach_upload_fail', { name: ph.file.name, reason: err.message || t('chat.attach_upload_generic_fail') }));
    }
  }));

  if (rejected.length) {
    uiAlert(t('chat.attach_rejected_prefix', { list: rejected.join('\n') }));
  }
}

async function _chatAttachRefreshFromServer(cid) {
  try {
    const res = await apiFetch(`/api/conversations/${encodeURIComponent(cid)}/attachments`);
    const data = await res.json();
    if (!data.ok) return;
    const items = (data.items || []).map((info) => {
      // Preview URL resolves from uid + cid + name on demand via the
      // `chat-media://` protocol — no per-item IPC fetch here.
      const dataUrl = (info.kind === 'image' || info.kind === 'video')
        ? _chatMediaUrl(cid, info.name)
        : null;
      return { name: info.name, kind: info.kind, bytes: info.bytes, dataUrl, status: 'ready' };
    });
    _chatAttachSet(cid, items);
  } catch (err) {
    _convLog.warn('refresh attachments failed', err);
  }
}

function _renderMessageAttachmentsHtml(names, cid) {
  const items = names.map((n) => {
    const ext = _chatAttachExtOf(n);
    const kind = _chatAttachKindFromExt(ext);
    const icon = _chatFileIconHtml(n, kind);
    const label = escapeHtml(n);
    if (kind === 'image' && cid) {
      const url = _chatMediaUrl(cid, n);
      return `<span class="chat-msg-attach is-image" data-attach-name="${label}" data-attach-cid="${escapeHtml(cid)}" title="${label}">
        <img class="chat-msg-attach-thumb" src="${url}" alt="${label}" />
        <span class="chat-msg-attach-label">${label}</span>
      </span>`;
    }
    if (kind === 'video' && cid) {
      const url = _chatMediaUrl(cid, n);
      return `<span class="chat-msg-attach is-video" data-attach-name="${label}" data-attach-cid="${escapeHtml(cid)}" title="${label}">
        <video class="chat-msg-attach-video" controls preload="metadata" src="${url}"></video>
        <span class="chat-msg-attach-label">${label}</span>
      </span>`;
    }
    return `<span class="chat-msg-attach" title="${label}">
      <span class="chat-msg-attach-icon">${icon}</span>
      <span class="chat-msg-attach-label">${label}</span>
    </span>`;
  });
  return `<div class="chat-msg-attachments">${items.join('')}</div>`;
}

// ── Produced files (assistant messages only) ─────────────────────────────
// Files written by the LLM via write_file / markdown_to_pdf / html_to_pdf.
// Chips use the same visual language as attachments; clicking opens an
// in-app preview overlay (chat-file-viewer.js) that renders the file's
// final form (PDF / HTML / markdown / text) or falls through to a dialog
// offering "open the containing folder" for unsupported kinds.

function _iconForProduced(name) {
  return _chatFileIconHtml(name);
}

function _renderMessageProducedHtml(absPaths) {
  // Chip shows just the filename. The full absolute path lives only in
  // `data-produced-path` for the click handler; tooltip is a static
  // localized "preview" hint instead of the raw OS path (which exposes
  // the user's home directory and is hostile UX in mixed-locale contexts).
  const hint = t('chat.produced_preview_title');
  const items = absPaths.map((p) => {
    const base = p.split(/[\\/]/).pop() || p;
    const icon = _iconForProduced(base);
    return `<span class="chat-msg-produced-item" data-produced-path="${escapeHtml(p)}" title="${escapeHtml(hint)}">
      <span class="chat-msg-produced-icon">${icon}</span>
      <span class="chat-msg-produced-label">${escapeHtml(base)}</span>
    </span>`;
  });
  return `<div class="chat-msg-produced">${items.join('')}</div>`;
}

// Render one or more "view details" chips on an assistant bubble — one chip
// per agent quick-created or quick-edited in that turn. Same visual slot as
// produced chips (inside the bubble, below content), in .is-custom green.
// Label is neutral ("view details") for both `kind: 'created'` and
// `kind: 'updated'`; the commander's surrounding prose tells the user which.
function _renderMessageCreatedAgentHtml(list) {
  const arr = Array.isArray(list) ? list : (list ? [list] : []);
  const chips = arr
    .filter((p) => p && p.agent_id)
    .map((p) => {
      const name = p.name || p.agent_id;
      return `<span class="chat-msg-created-agent-chip" data-agent-id="${escapeHtml(p.agent_id)}" title="${escapeHtml(name)}">
      <span class="chat-msg-created-agent-icon">◆</span>
      <span class="chat-msg-created-agent-label">${escapeHtml(t('chat.created_agent_chip', { name }))}</span>
    </span>`;
    })
    .join('');
  return chips ? `<div class="chat-msg-created-agent">${chips}</div>` : '';
}

function _hydrateMessageCreatedAgentChip(msgDiv) {
  const chips = msgDiv.querySelectorAll('.chat-msg-created-agent-chip[data-agent-id]');
  for (const chip of chips) {
    if (chip.dataset.bound === '1') continue;
    chip.dataset.bound = '1';
    chip.addEventListener('click', async () => {
      const aid = chip.dataset.agentId;
      if (!aid) return;
      setView('agents');
      // Pre-check the agent is still loadable; if it was deleted (or its
      // record is broken) the detail view would render an empty shell —
      // bail to the grid instead.
      try {
        const res = await apiFetch(`/api/agents/${encodeURIComponent(aid)}`);
        const data = await res.json();
        if (!data?.ok || !data?.agent) return;
      } catch { return; }
      if (typeof _showAgentsDetailView === 'function') _showAgentsDetailView(aid);
      else if (typeof selectAgent === 'function') selectAgent(aid);
    });
  }
}

// Skill mirror of the agent chip. Commander writes only custom skills,
// so the chip always opens the custom-source detail view.
function _renderMessageCreatedSkillHtml(list) {
  const arr = Array.isArray(list) ? list : (list ? [list] : []);
  const chips = arr
    .filter((p) => p && p.skill_id)
    .map((p) => {
      const name = p.name || p.skill_id;
      return `<span class="chat-msg-created-agent-chip" data-skill-id="${escapeHtml(p.skill_id)}" title="${escapeHtml(name)}">
      <span class="chat-msg-created-agent-icon">◆</span>
      <span class="chat-msg-created-agent-label">${escapeHtml(t('chat.created_skill_chip', { name }))}</span>
    </span>`;
    })
    .join('');
  return chips ? `<div class="chat-msg-created-agent">${chips}</div>` : '';
}

function _hydrateMessageCreatedSkillChip(msgDiv) {
  const chips = msgDiv.querySelectorAll('.chat-msg-created-agent-chip[data-skill-id]');
  for (const chip of chips) {
    if (chip.dataset.bound === '1') continue;
    chip.dataset.bound = '1';
    chip.addEventListener('click', async () => {
      const sid = chip.dataset.skillId;
      if (!sid) return;
      setView('skills');
      // Pre-check SKILL.md is readable; covers both "skill was deleted" and
      // "skill row exists but its files are missing" (entering the detail
      // would render a 'file not found' shell otherwise).
      try {
        const res = await apiFetch(`/api/skills/read?source=custom&id=${encodeURIComponent(sid)}&file=SKILL.md`);
        const data = await res.json();
        if (!data?.ok) return;
      } catch { return; }
      if (typeof _showSkillsDetailView === 'function') _showSkillsDetailView('custom', sid);
    });
  }
}

function _hydrateMessageProducedChips(msgDiv) {
  const chips = msgDiv.querySelectorAll('.chat-msg-produced-item');
  chips.forEach((chip) => {
    chip.addEventListener('click', (e) => {
      e.stopPropagation();
      const p = chip.dataset.producedPath;
      if (!p) return;
      // chat-file-viewer dispatches by extension to in-app preview overlay
      // or, on unsupported kinds, an "open folder?" fallback dialog.
      if (typeof openChatFileViewer === 'function') {
        const base = p.split(/[\\/]/).pop() || p;
        openChatFileViewer(p, base);
      }
    });
  });
}

function _hydrateMessageAttachmentThumbs(msgDiv, cid) {
  // Image chips have a thumb we want to enlarge via the lightbox; the rest
  // (pdf / docx / text / video) get the same kind-aware viewer as produced
  // chips. Video chips have inline <video> controls in the bubble already,
  // so clicking the chip body shouldn't re-open the same playback — skip
  // them. We rely on `_chatMediaUrl(cid, name)` having loaded the bytes for
  // images so the lightbox can reuse the already-cached resource.
  const allChips = msgDiv.querySelectorAll('.chat-msg-attach');
  allChips.forEach((chip) => {
    if (chip.classList.contains('is-video')) return;
    if (chip.classList.contains('is-image')) {
      const img = chip.querySelector('img.chat-msg-attach-thumb');
      if (!img) return;
      chip.addEventListener('click', (e) => {
        e.stopPropagation();
        if (typeof openChatImageLightbox === 'function') {
          openChatImageLightbox(img.src, chip.dataset.attachName || '');
        }
      });
      return;
    }
    // Non-image, non-video attachment chip → open the file viewer. The
    // chip carries `(cid, name)`, not an absolute path; resolve via
    // `attachments.absPath` so the viewer keeps a single "abs path in"
    // contract. cid flows through to the viewer so reveal / read scope
    // includes the per-conversation attachment dir.
    const name = chip.dataset.attachName || (chip.querySelector('.chat-msg-attach-label')?.textContent || '').trim();
    const chipCid = chip.dataset.attachCid || cid;
    if (!name || !chipCid) return;
    chip.classList.add('is-clickable');
    chip.addEventListener('click', async (e) => {
      e.stopPropagation();
      if (typeof openChatFileViewer !== 'function') return;
      try {
        const res = await window.orkas.invoke('attachments.absPath', { cid: chipCid, name });
        if (!res || !res.ok || !res.path) {
          _convLog.warn('attachments.absPath failed', { cid: chipCid, name, error: res && res.error });
          return;
        }
        openChatFileViewer(res.path, name, { cid: chipCid });
      } catch (err) {
        _convLog.warn('attachments.absPath threw', { cid: chipCid, name, error: String(err && err.message || err) });
      }
    });
  });
}

// Wire `paste` on a textarea to the same upload pipeline as the "+" button.
// Triggers when the clipboard contains any File entries — screenshots from
// the OS clipboard (Cmd/Ctrl+Shift+screenshot) and files copied from Finder
// / Explorer both land in `clipboardData.files`. Plain-text pastes have an
// empty FileList and fall through to the textarea's native paste handler.
function _bindChatPasteAttach(inputSelector, getCid) {
  const el = document.querySelector(inputSelector);
  if (!el || el.dataset.pasteBound === '1') return;
  el.addEventListener('paste', (e) => {
    const cid = getCid();
    if (!cid) return;
    const cd = e.clipboardData;
    if (!cd || !cd.files || !cd.files.length) return;
    e.preventDefault();
    // Fire-and-forget — _chatAttachUpload paints placeholder chips
    // synchronously before any network IO, so the user sees the chip
    // appear at the top of the input area as soon as the paste lands.
    _chatAttachUpload(cid, cd.files);
  });
  el.dataset.pasteBound = '1';
}

// Same upload pipeline, drop variant. Binds on the input-area wrapper so
// the user has a generous target — dropping on the textarea, the chip
// row, or the toolbar all land here. dragover/dragenter must preventDefault
// to mark the area as a drop target (otherwise the browser refuses the
// drop and falls through to the page-level navigate-to-file behaviour).
function _bindChatDropAttach(wrapSelector, getCid) {
  const el = document.querySelector(wrapSelector);
  if (!el || el.dataset.dropBound === '1') return;
  const isFileDrag = (e) => {
    const types = e.dataTransfer && e.dataTransfer.types;
    if (!types) return false;
    for (let i = 0; i < types.length; i++) {
      if (types[i] === 'Files') return true;
    }
    return false;
  };
  const allow = (e) => {
    if (!isFileDrag(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
  };
  el.addEventListener('dragover', allow);
  el.addEventListener('dragenter', allow);
  el.addEventListener('drop', (e) => {
    if (!isFileDrag(e)) return;
    e.preventDefault();
    const cid = getCid();
    if (!cid) return;
    _chatAttachUpload(cid, e.dataTransfer.files);
  });
  el.dataset.dropBound = '1';
}

function _initChatAttachInput() {
  const btn = document.getElementById('chat-attach-btn');
  const input = document.getElementById('chat-attach-input');
  if (!btn || !input || btn.dataset.bound === '1') return;
  btn.addEventListener('click', () => {
    if (!currentCid) return;
    input.click();
  });
  input.addEventListener('change', async () => {
    if (!currentCid) { input.value = ''; return; }
    await _chatAttachUpload(currentCid, input.files);
    input.value = '';
  });
  _bindChatPasteAttach('#chat-input', () => currentCid);
  _bindChatDropAttach('.chat-input-area', () => currentCid);
  btn.dataset.bound = '1';
}

// The commander (new-chat) tab's "+" button uses the same upload
// pipeline; the only difference is that it passes DRAFT_CID instead of
// a real conversation cid. After the user clicks send,
// handleNewChatSubmit calls adopt to rename the whole `main_chat/`
// directory to the freshly-minted cid; the pre-processing cache
// follows in place and doesn't need to be rerun.

function _initNewChatAttachInput() {
  const btn = document.getElementById('new-chat-attach-btn');
  const input = document.getElementById('new-chat-attach-input');
  if (!btn || !input || btn.dataset.bound === '1') return;
  btn.addEventListener('click', () => input.click());
  input.addEventListener('change', async () => {
    await _chatAttachUpload(DRAFT_CID, input.files);
    input.value = '';
  });
  _bindChatPasteAttach('#new-chat-input', () => DRAFT_CID);
  _bindChatDropAttach('.new-chat-input-area', () => DRAFT_CID);
  btn.dataset.bound = '1';
}

// ─── Conversation list ───

async function loadConversations() {
  try {
    const res = await apiFetch('/api/conversations/list');
    const data = await res.json();
    if (data.ok) {
      conversations = data.conversations || [];
      renderConversationList();
    }
  } catch (e) {
    _convLog.error('load conversations failed', e);
  }
}

// Subscribe once to the main-side relay activity push. When iOS triggers a task on this PC,
// after `groupChat.send` returns — we either reload the full list (new cid) or just bump the
// existing entry to the top (matches what `_handleGroupBusEvent('message')` does for PC-local
// activity). Without this, iOS-created convs only appear in the sidebar after a PC relaunch.
let _relayActivityWatchStarted = false;
function startRelayActivitySubscription() {
  if (_relayActivityWatchStarted) return;
  if (!window.orkas || typeof window.orkas.onPushEvent !== 'function') return;
  try {
      if (!payload || !payload.cid) return;
      if (payload.created) {
        loadConversations().catch((err) => _convLog.warn('relay reload failed', err));
      } else {
        _bumpConvToTop(payload.cid);
      }
    });
    _relayActivityWatchStarted = true;
  } catch (err) {
    _convLog.warn('relay activity subscribe failed', err);
  }
}

// Move a conversation to the top of the sidebar list and re-render.
// Called whenever a non-internal message lands on a cid so the list stays
// ordered by last activity (matches backend listConversations sort, which
// reads <cid>.jsonl mtime on the next full reload).
function _bumpConvToTop(cid) {
  if (!cid || !Array.isArray(conversations) || !conversations.length) return;
  const idx = conversations.findIndex((c) => c && c.conversation_id === cid);
  if (idx <= 0) return;
  const [c] = conversations.splice(idx, 1);
  c.last_active_at = new Date().toISOString();
  conversations.unshift(c);
  renderConversationList();
}

function renderConversationList() {
  const container = document.getElementById('conversation-list');
  // Conversations with a project_id are rendered nested under their project
  // by `projects.js::renderProjectsSection`. The "Conversations" section
  // here only shows the unprojected ones — same data model as the user's
  // mental picture (projected convs live "inside" their project, the rest
  // sit in the catch-all section).
  const unprojected = (conversations || []).filter((c) => !c || !c.project_id);
  if (!unprojected.length) {
    container.innerHTML = `<div class="conv-empty" data-i18n="sidebar.conv_empty">${escapeHtml(t('sidebar.conv_empty'))}</div>`;
    // Still re-render the projects section so its badges refresh (the call
    // is cheap when the cache is already loaded).
    if (typeof renderProjectsSection === 'function') renderProjectsSection();
    return;
  }
  const delTitle = escapeHtml(t('chat.conv_del_title'));
  container.innerHTML = unprojected.map(c => {
    // All conversations are now the single `normal` kind — no type badge.
    const title = escapeHtml(c.title || t('chat.new_conv_title'));
    return `
      <div class="conv-item" data-cid="${c.conversation_id}">
        <div class="conv-item-title" title="${title}">${title}</div>
        <button class="conv-item-del" data-del-cid="${c.conversation_id}" title="${delTitle}">×</button>
      </div>
    `;
  }).join('');

  container.querySelectorAll('.conv-item').forEach(el => {
    el.addEventListener('click', (e) => {
      if (e.target.closest('.conv-item-del')) return;
      setView('conversation', el.dataset.cid);
    });
  });
  container.querySelectorAll('.conv-item-del').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const cid = btn.dataset.delCid;
      if (!(await uiConfirm(t('chat.conv_del_confirm')))) return;
      abortConvStream(cid);
      _forgetConvLocal(cid);
      await apiFetch(`/api/conversations/${cid}`, { method: 'DELETE' });
      if (currentCid === cid) setView('new-chat');
      await loadConversations();
    });
  });

  // Re-render the projects section (it consumes the same `conversations`
  // global to group projected items by project).
  if (typeof renderProjectsSection === 'function') renderProjectsSection();

  // Reapply pending / queued status badges after the DOM was re-rendered
  // (covers both the unprojected list and the projects section's nested
  // conv items, since the helper queries by cid only).
  _refreshAllConvBadges();
}

// ─── Conversation history render ───

// Inline "create agent" entry that lives at the very end of the conversation
// history — visually a divider with a small button in the middle, anchored
// to the last message. Hidden while a stream is in flight (the scroll-pin
// spacer is present then) so it doesn't tempt the user to sediment a
// half-finished reply.
function _ensureConvCreateAgentInline() {
  const container = document.getElementById('chat-history');
  if (!container) return;
  let el = document.getElementById('conv-create-agent-inline');
  if (!el) {
    el = document.createElement('div');
    el.id = 'conv-create-agent-inline';
    el.className = 'conv-create-agent-inline';
    el.style.display = 'none';
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.setAttribute('data-i18n', 'chat.create_agent_inline');
    btn.textContent = t('chat.create_agent_inline');
    btn.addEventListener('click', () => {
      if (!currentCid) return;
      const input = document.getElementById('chat-input');
      if (!input) return;
      input.value = t('chat.create_agent_message');
      autoGrow(input, 200);
      handleChatSubmit();
    });
    el.appendChild(btn);
  }
  // Position: last child of chat-history, but BEFORE the scroll-pin spacer
  // when one exists (spacer's job is to be the literal final element).
  const spacer = container.querySelector('.chat-scroll-spacer');
  if (spacer) {
    if (el.nextSibling !== spacer) container.insertBefore(el, spacer);
  } else if (container.lastChild !== el) {
    container.appendChild(el);
  }
  const hasUserMsg = !!container.querySelector('.chat-message.user');
  const isStreaming = !!spacer;
  // Once any agent (other than commander / user) joins the conversation,
  // hide the entry — in a multi-agent flow the "promote a single agent"
  // semantic no longer holds. Either signal counts:
  //   1) The roster contains a member with kind === 'agent' (most
  //      authoritative — includes agents that were @-mentioned but
  //      haven't spoken yet).
  //   2) The DOM contains an utterance whose _from / fromActor is
  //      non-empty and not commander/user (fallback that fires before
  //      the member cache loads).
  const members = _groupMembersCache.get(currentCid) || [];
  const hasAgentMember = members.some((a) => a && a.kind === 'agent');
  const hasAgentMsg = hasAgentMember || Array.from(
    container.querySelectorAll('.chat-message.assistant'),
  ).some((m) => {
    const f = m.dataset.from || m.dataset.fromActor;
    return f && f !== 'commander' && f !== 'user';
  });
  el.style.display = (hasUserMsg && !isStreaming && !hasAgentMsg) ? '' : 'none';
}

// Single observer wired once — any childList change on chat-history
// (history load, send, stream final, spacer add/remove) re-runs ensure.
let _createAgentInlineObserver = null;
function _ensureCreateAgentInlineObserver() {
  if (_createAgentInlineObserver) return;
  const target = document.getElementById('chat-history');
  if (!target) return;
  _createAgentInlineObserver = new MutationObserver(_ensureConvCreateAgentInline);
  _createAgentInlineObserver.observe(target, { childList: true });
  _ensureConvCreateAgentInline();
}

async function loadConversationHistory(cid) {
  const container = document.getElementById('chat-history');
  container.classList.remove('has-scroll-offset');
  container.innerHTML = `<div class="empty">${escapeHtml(t('chat.loading'))}</div>`;
  _ensureCreateAgentInlineObserver();
  // (Plan rail bind happens in onEnterConversationView — covers both this
  // load path AND the skipLoad freshly-created-conv path.)
  try {
    // Warm `_agentsCache` if a chat-first session never visited the agents
    // tab — `_buildMentionRe` / `_groupActorLabel` both read it for current
    // names. Without this, a user who lands straight in a conversation gets
    // multi-word `@<name>` highlighting truncated to the first whitespace.
    if (typeof loadAgents === 'function'
        && typeof _agentsCache !== 'undefined' && !_agentsCache) {
      try { await loadAgents(); } catch (_) { /* non-fatal */ }
    }
    const res = await apiFetch(`/api/conversations/${cid}/history?limit=500`);
    const data = await res.json();
    if (!data.ok) throw new Error(data.error || 'load failed');
    // Members cache MUST be populated before we render history bubbles —
    // appendChatMessage calls _groupActorLabel which uses this cache to
    // resolve agent_id → name. Without the await we'd briefly show
    // generic "agent" placeholders on first paint and have to repaint on refresh, which is ugly.
    await _refreshGroupMembers(cid);
    // History reload: drop ALL per-actor placeholder map entries — the
    // `container.innerHTML=''` below detaches every placeholder DOM node,
    // including the ones for this cid. Keeping `${cid}:*` entries leaves
    // the map pointing at orphan nodes; the next `_consumeActorPlaceholder`
    // would find an entry whose `parentElement` is null, fall through to
    // the `appendChatMessage` fallback, and any deltas accumulated on
    // that orphan during the in-flight stream are lost (the symptom users
    // see as "the in-flight reply bubble disappears + a duplicate final
    // appears below"). After clearing, the next `_ensureActorPlaceholder`
    // re-adopts `state.loadingEl` (re-attached below via the
    // `isConvPending` branch) for the first actor and mints fresh
    // placeholders for any additional actors — no orphan window.
    _groupPlaceholders.clear();
    // Drop internal plan-step dispatch messages (commander → agent
    // hand-off). The user already saw the plan announcement; surfacing
    // these adds noise (e.g. "@<agent-name> <user request>") in the user's view.
    // The agent's visibility slice still carries them so the agent has
    // the dispatch text in its own context.
    const history = (data.history || [])
      .filter((gm) => !(gm && gm.dispatch))
      .map(_groupMsgToLegacy)
      // Defensive sort by ts: jsonl is append-ordered (already chronological),
      // but stable-sort guards against any future writer that lands a message
      // out of order so loadConversationHistory matches `_insertByTimestamp`.
      .sort((a, b) => _msTs(a && a.time) - _msTs(b && b.time));
    if (!history.length) {
      container.innerHTML = `<div class="empty">${escapeHtml(t('chat.empty'))}</div>`;
    } else {
      container.innerHTML = '';
      history.forEach((msg, idx) => appendChatMessage(msg, false, { cid, msgIndex: idx }));
    }

    // Detect unanswered user message (e.g. after page refresh while server was processing).
    // Only show the "thinking…" bubble if the server *really* still has this
    // conversation in processing state AND the work started recently — a stale
    // `processing: true` from a crashed prior run is swept on boot, but we
    // also belt-and-braces check the flag here so no flash occurs.
    const lastMsg = history[history.length - 1];
    const convMeta = data.conversation || {};
    // Cache the conv-bound agent's enabled state so _updateConvSendUI can
    // grey out the input without a second IPC round trip. Backend stamps
    // `agent_enabled` on the conversation payload (true when no agent_id).
    convAgentEnabledByCid.set(cid, convMeta.agent_enabled !== false);
    _renderConvDisabledBanner(cid);
    const processingFresh = convMeta.processing === true
      && convMeta.processing_since
      && (Date.now() - new Date(convMeta.processing_since).getTime()) < 15 * 60 * 1000;
    const wasPendingBeforeHistoryRecovery = isConvPending(cid);
    if (processingFresh && !wasPendingBeforeHistoryRecovery) {
      setGroupConversationBusy(cid, true);
      _updateConvSidebarBadge(cid, true);
      startPolling(cid);
      if (cid === currentCid) _updateConvSendUI(cid);
    }
    if (lastMsg?.role === 'user' && !wasPendingBeforeHistoryRecovery && processingFresh) {
      pollMsgCounts.set(cid, history.length);
      const loadingEl = _createStreamingAssistantMessage(container, { hiddenUntilActor: true });
      pendingConvs.set(cid, { loadingEl, needsIndicator: false });
      _updateConvSendUI(cid);
    } else if (isConvPending(cid)) {
      // User navigated away and back during an in-flight request. The stream
      // reader loop in createChatController.send() holds the original msgEl
      // in closure and keeps dispatching deltas/final to that *specific* node
      // — so we must re-attach the original node, not mint a fresh bubble.
      // Minting a new one here (as before) stranded the stream: events kept
      // landing on the orphaned node and the new bubble stayed at "thinking…"
      // until stream end / polling rescue.
      let state = pendingConvs.get(cid);
      if (!state) {
        state = { loadingEl: null, needsIndicator: false, controller: null, aborted: false };
        pendingConvs.set(cid, state);
      }
      pollMsgCounts.set(cid, history.length);
      if (state.loadingEl) {
        const emptyEl = container.querySelector('.empty');
        if (emptyEl) emptyEl.remove();
        _appendBeforeSpacer(container, state.loadingEl);
      } else {
        const loadingEl = _createStreamingAssistantMessage(container, { hiddenUntilActor: true });
        state.loadingEl = loadingEl;
      }
      state.needsIndicator = false;
      startPolling(cid); // ensure polling is running as backup
    }

    // Re-add the inline "create agent" entry BEFORE scrolling so it's part of
    // scrollHeight when we jump to the bottom — otherwise the MutationObserver
    // adds it post-scroll and it ends up below the visible area.
    _ensureConvCreateAgentInline();
    _scrollToBottomNoAnim(container);
    if (window.ConversationInfo) window.ConversationInfo.refresh(cid);
  } catch (e) {
    container.innerHTML = `<div class="empty">${escapeHtml(t('chat.load_failed', { msg: e.message || '' }))}</div>`;
    if (window.ConversationInfo) window.ConversationInfo.refresh(cid);
  }
}

// Jump to bottom without smooth animation. Use when opening a conversation —
// the last message should appear immediately, no scrolling effect.
function _scrollToBottomNoAnim(container) {
  if (!container) return;
  const prev = container.style.scrollBehavior;
  container.style.scrollBehavior = 'auto';
  container.scrollTop = container.scrollHeight;
  // Explicit jump-to-bottom = the user is now pinned to the bottom; arm
  // the sticky-follow flag so subsequent stream content keeps tracking.
  container._stickyEnabled = true;
  _bindStickToBottom(container);
  requestAnimationFrame(() => {
    container.style.scrollBehavior = prev || '';
  });
}

// ─── Sticky-bottom auto-scroll ─────────────────────────────────────────────
// Track per-container "is the user pinned to the bottom?" so streaming
// content (process info / token deltas / new bubbles) auto-scrolls down
// only while the user wants to follow. Mid-stream scroll-up suspends
// auto-stick; scrolling back to (near) bottom resumes it. Tab-switch back
// re-applies the stick if it was on at the moment of going hidden.
//
// Why a threshold (32 px) instead of strict equality: programmatic scrolls
// (`scrollTop = scrollHeight`) and Chromium's sub-pixel rounding leave a
// 1–2 px gap that would otherwise toggle the flag off on the first scroll
// event. 32 px is comfortable for the user too — being "almost at bottom"
// counts as following.
const STICKY_BOTTOM_THRESHOLD = 32;
function _isNearBottom(el, threshold = STICKY_BOTTOM_THRESHOLD) {
  if (!el) return true;
  return (el.scrollHeight - el.scrollTop - el.clientHeight) <= threshold;
}
function _bindStickToBottom(el) {
  if (!el || el._stickyBound) return;
  el._stickyBound = true;
  if (el._stickyEnabled === undefined) el._stickyEnabled = true;
  el.addEventListener('scroll', () => {
    el._stickyEnabled = _isNearBottom(el);
  }, { passive: true });
}
// Scroll the container to the bottom, but only if the user hasn't scrolled
// up. Safe to call after every DOM mutation that adds height — the no-op
// branch (sticky off) lets the user keep reading process info undisturbed.
//
// `scroll-behavior: smooth` is set on every chat history surface so the
// scrollbar drag / search-jump feels animated. Honouring that on a stream
// hot path queues overlapping ~300 ms animated scrolls per delta and the
// view visibly shakes; force `auto` for this programmatic stick so each
// call lands instantly without fighting the previous animation.
function _stickBottomIfPinned(el) {
  if (!el) return;
  if (el._stickyEnabled === false) return;
  const prev = el.style.scrollBehavior;
  el.style.scrollBehavior = 'auto';
  el.scrollTop = el.scrollHeight;
  if (prev) el.style.scrollBehavior = prev;
  else el.style.removeProperty('scroll-behavior');
}
// Convenience for stream handlers that hold a `msg` element. The container
// is whatever element the bubble lives in (chat-history for the main conv,
// or a skill/agent edit chat's messages box) — same generic stickiness
// applies to all of them.
function _stickBottomFromMsg(msg) {
  if (!msg) return;
  _stickBottomIfPinned(msg.parentElement);
}

// Tab visibility: while the renderer is hidden, scroll events don't fire
// and stream content piles up below the fold. On return, if the user was
// pinned to the bottom before going hidden, jump to the latest content so
// the conversation tracks live again.
if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
    // Cover every chat history surface (main conv + skill/agent edit chats).
    const ids = ['chat-history', 'skills-chat-messages', 'agents-chat-messages'];
    for (const id of ids) {
      const el = document.getElementById(id);
      if (el && el._stickyEnabled !== false) _stickBottomIfPinned(el);
    }
  });
}

function appendChatMessage(message, autoScroll = true, opts = {}) {
  const container = opts.container
    ? (typeof opts.container === 'string' ? document.getElementById(opts.container) : opts.container)
    : document.getElementById('chat-history');
  if (!container) return null;
  const archive = opts.archive !== false;   // default on for backwards compat

  // Dedupe by `_msg_id`: when the user switches conv tabs during a
  // streaming turn, the same persisted message can reach the renderer
  // twice — once via `loadConversationHistory` reading jsonl on
  // switch-back, once via the trailing group-bus `message` event whose
  // cid-mismatch guard had dropped its DOM update on the way out and
  // now arrives after `currentCid` has flipped back. Without this
  // guard, the second arrival's fallback `appendChatMessage` (used
  // when the stale per-actor placeholder no longer has a
  // `parentElement`) prints a duplicate bubble below the history-painted
  // one. Idempotent re-render is the right contract — return the
  // existing node so callers that want to mutate it (chip mounting /
  // dataset writes) still find the right target.
  if (message && message._msg_id) {
    const existing = container.querySelector(
      `.chat-message[data-msg-id="${CSS.escape(String(message._msg_id))}"]`,
    );
    if (existing) return existing;
  }

  const emptyEl = container.querySelector('.empty');
  if (emptyEl) emptyEl.remove();

  const role = message.role === 'assistant' ? 'assistant' : 'user';
  const msgDiv = document.createElement('div');
  msgDiv.className = `chat-message ${role}`;
  // Sender id stamp — used by `_ensureConvCreateAgentInline` to detect
  // whether any agent (≠ user / commander) has spoken in this conversation.
  // Empty when unknown (e.g. stale records lacking _from); the inline button
  // treats unknown as "not an agent" to avoid hiding by mistake.
  if (message._from) msgDiv.dataset.from = String(message._from);

  const rawContent = message.content || '';
  const isHtmlSnippet = typeof rawContent === 'string' && rawContent.startsWith('<');
  // User messages carrying an `<agent-input-submission>` tag (form submit
  // replay) strip the XML tag for display — the bullet list above it
  // describes the same values, and the LLM still parses the tag from the
  // stored raw text. Assistant messages get a defensive structural-block
  // strip covering `<agent>` / `<agent-input-form>` / `<agent-input-submission>`
  // in case the backend's extractor missed a format variant (see
  // `_stripSurvivingStructuralBlocks` in strip-structural-blocks.js).
  let displayContent = rawContent;
  if (!isHtmlSnippet) {
    if (role === 'user') {
      displayContent = _stripMarketplaceInstallResultTagForDisplay(
        _stripArtifactResultTagForDisplay(_stripSubmissionTagForDisplay(rawContent)),
      );
    }
    else if (role === 'assistant') displayContent = _stripSurvivingStructuralBlocks(rawContent);
  }
  const contentHtml = isHtmlSnippet
    ? rawContent
    : `<div class="markdown-body">${_renderMessageMarkdown(displayContent)}</div>`;

  const attachmentsHtml = (role === 'user' && Array.isArray(message.attachments) && message.attachments.length)
    ? _renderMessageAttachmentsHtml(message.attachments, opts.cid || currentCid)
    : '';
  const producedHtml = (role === 'assistant' && Array.isArray(message.produced) && message.produced.length)
    ? _renderMessageProducedHtml(message.produced)
    : '';
  const createdAgentsList = role === 'assistant' ? _normalizeCreatedAgents(message) : null;
  const createdAgentHtml = createdAgentsList
    ? _renderMessageCreatedAgentHtml(createdAgentsList)
    : '';
  const createdSkillsList = role === 'assistant' ? _normalizeCreatedSkills(message) : null;
  const createdSkillHtml = createdSkillsList
    ? _renderMessageCreatedSkillHtml(createdSkillsList)
    : '';
  // Group-chat header sits **above** the bubble, outside it: sender name +
  // timestamp on one row. Same DOM strip for historical (loaded via
  // getMessages) and live-streamed messages so users always see "who said
  // what when" at the same place. User messages drop the sender chip
  // (it's their own bubble) and right-align the time to match the
  // right-aligned bubble below.
  // Always go through _groupActorLabel for non-user messages so we never
  // accidentally render the raw agent_id. _from_label was eagerly computed
  // at translate time but the cache may have been empty then; recompute.
  const headerName = role === 'user'
    ? ''
    : _groupActorLabel(message._from || (message._from_label ? '' : ''))
      || message._from_label
      || (t('chat.from_agent_unknown'));
  const avatarHtml = role === 'user' ? '' : _renderActorAvatarHtml(message._from);
  const headerHtml = role === 'user'
    ? `<div class="chat-msg-header chat-msg-header-user"><span class="chat-msg-time">${formatTime(message.time || new Date().toISOString())}</span></div>`
    : `<div class="chat-msg-header">${avatarHtml}<span class="chat-msg-from">${escapeHtml(headerName)}</span><span class="chat-msg-time">${formatTime(message.time || new Date().toISOString())}</span></div>`;
  const planAnnHtml = message._plan_announcement
    ? `<div class="chat-plan-announce">${_uiIconHtml('clipboard-list', 'ui-icon chat-plan-announce-icon')}<span>${escapeHtml(t('chat.plan_announce'))}</span></div>` : '';
  // Below-bubble action row holds produced-file chips + created-agent chip
  // + archive button (the legacy `.chat-meta` slot). Lives OUTSIDE the
  // bubble so chips read as a footer, not as inline body content.
  msgDiv.innerHTML = `
    ${headerHtml}
    <div class="chat-bubble">${planAnnHtml}${contentHtml}${attachmentsHtml}</div>
    <div class="chat-msg-actions" data-role="msg-actions">${producedHtml}${createdAgentHtml}${createdSkillHtml}</div>
  `;
  if (typeof opts.msgIndex === 'number') msgDiv.dataset.msgIndex = String(opts.msgIndex);
  if (message._msg_id) msgDiv.dataset.msgId = String(message._msg_id);
  if (message._from) msgDiv.dataset.fromActor = String(message._from);
  msgDiv.dataset.ts = String(_msTs(message.time));
  // Stash chip-tracked produced paths on the DOM so the 引用 handler can
  // attach them to the quote payload without plumbing message into every
  // _attachBubbleArchiveBtn call site. Only chip-tracked files belong here
  // (write_file / edit_file / markdown_to_pdf / html_to_pdf / generate_image);
  // bash scratch is intentionally outside this set.
  if (Array.isArray(message.produced) && message.produced.length) {
    msgDiv.dataset.produced = JSON.stringify(message.produced);
  }
  _insertByTimestamp(container, msgDiv);
  if (!isHtmlSnippet && typeof typesetMath === 'function') {
    const md = msgDiv.querySelector('.markdown-body');
    if (md) typesetMath(md);
  }
  if (attachmentsHtml) _hydrateMessageAttachmentThumbs(msgDiv, opts.cid || currentCid);
  if (producedHtml) _hydrateMessageProducedChips(msgDiv);
  if (createdAgentHtml) _hydrateMessageCreatedAgentChip(msgDiv);
  if (createdSkillHtml) _hydrateMessageCreatedSkillChip(msgDiv);
  // Interactive input-form widget (assistant messages only). Appended inside
  // the bubble after markdown + chips so it reads as "reply text → confirm
  // this form". See chat-input-form.js for the widget implementation.
  if (role === 'assistant' && message.form && typeof window.renderChatInputForm === 'function') {
    const bubble = msgDiv.querySelector('.chat-bubble');
    if (bubble) {
      const formHost = document.createElement('div');
      bubble.appendChild(formHost);
      _mountChatInputForm(formHost, msgDiv, message, opts);
    }
  }
  // Commander → user marketplace install confirmation cards. The model can
  // request approval, but only this human click path performs the install.
  if (role === 'assistant' && Array.isArray(message.marketplace_requests) && message.marketplace_requests.length) {
    const bubble = msgDiv.querySelector('.chat-bubble');
    if (bubble) _mountMarketplaceInstallRequests(bubble, msgDiv, message, opts);
  }
  // Interactive web-app artifacts (assistant messages only) — sandboxed
  // `<iframe>` over the `chat-app://` protocol, appended after the form so it
  // reads as "reply text → embedded app". See chat-artifact.js.
  if (role === 'assistant' && Array.isArray(message.artifacts) && message.artifacts.length
      && typeof window.mountMessageArtifacts === 'function') {
    const bubble = msgDiv.querySelector('.chat-bubble');
    if (bubble) window.mountMessageArtifacts(bubble, message.artifacts, opts.cid || currentCid);
  }
  // Archive button is only for finalised assistant replies (raw markdown,
  // not an HTML placeholder / status stub).
  if (role === 'assistant' && !isHtmlSnippet && archive) {
    _attachBubbleArchiveBtn(msgDiv, () => rawContent);
  }
  // Persisted-process trail is independent of body type — it must render
  // for HTML-stub bodies too (e.g. CLI warning spans),
  // otherwise after a refresh the only visible signal of a failed run is
  // the red error line and "what happened" is gone. Auto-expand for any
  // empty / abort-stub / HTML-stub body so the rail IS the content.
  if (role === 'assistant' && Array.isArray(message.process) && message.process.length) {
    const bodyText = String(displayContent || '').trim();
    // Match both possible forms — jsonl history can carry either depending
    // on the UI language at the time of write (i18n key `model.aborted` →
    // '(stopped)' in en, '（已中断）' in zh).
    const isAbortStub = bodyText === '（已中断）' || bodyText === '(stopped)' || bodyText === '';
    const expanded = isAbortStub || isHtmlSnippet;
    _renderPersistedProcess(msgDiv, message.process, { expanded });
  }

  if (autoScroll) {
    // Respect the user's scroll position: only follow if they were already
    // pinned to the bottom (sticky on). This preserves the legacy "new
    // message arrives → snap to bottom" behaviour for users who were
    // following, without yanking users who scrolled up to read older
    // process info. _bindStickToBottom is a no-op after first bind.
    _bindStickToBottom(container);
    _stickBottomIfPinned(container);
  }
  return msgDiv;
}

// Mount the input-form widget into a bubble. Wires the widget's submit
// callback to (a) flag the assistant form as submitted server-side and
// (b) fire the composed user message through the normal send pipeline,
// so conversation state stays consistent regardless of scene.
function _mountChatInputForm(host, msgDiv, message, opts) {
  const cid = opts.cid || currentCid;
  if (!cid) return;
  window.renderChatInputForm(host, message, {
    readonly: !!(message.form && message.form.submitted),
    cid,
    onSubmit: async (_encodedText, values, attachments) => {
      // Group chat form submit is a TWO-STEP operation:
      //   1. POST `form-submitted` → backend marks the form submitted on
      //      both the main jsonl and the agent's visibility slice. Returns
      //      the encoded submission text + recipient agent_id so the
      //      renderer doesn't have to re-encode (XML format must match
      //      bus's submission decoder exactly).
      //   2. Send the returned text via the normal send pipeline. This
      //      paints the user bubble locally + opens the IPC stream so the
      //      agent's reply (deltas, process events, final message) actually
      //      reaches the UI. Skipping step 2 was the "click submit, no
      //      reaction" bug — backend dispatched but no listener received.
      const msgId = msgDiv.dataset.msgId || (message._msg_id || '');
      if (!msgId) {
        _convLog.warn('form submit missing msgId');
        return;
      }
      let submissionText = null;
      try {
        const res = await apiFetch(`/api/conversations/${cid}/form-submitted`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ msgId, formId: message.form.form_id, values }),
        });
        const data = await res.json();
        if (!data || data.ok === false) {
          _convLog.warn('markFormSubmitted failed', data && data.error);
          return;
        }
        submissionText = data.submission && data.submission.text;
      } catch (err) {
        _convLog.warn('markFormSubmitted threw', err && err.message ? err.message : err);
        return;
      }
      if (!submissionText) return;
      const extra = (Array.isArray(attachments) && attachments.length)
        ? { attachments }
        : undefined;
      try { await sendInCurrentConversation(submissionText, extra); }
      catch (err) { _convLog.error('form replay send failed', err); }
    },
  });
}

function _marketplaceRequestKindLabel(kind) {
  return kind === 'skill' ? t('marketplace_request.kind_skill') : t('marketplace_request.kind_agent');
}

function _marketplaceRequestStatusLabel(status) {
  if (status === 'installed') return t('marketplace_request.status_installed');
  if (status === 'skipped') return t('marketplace_request.status_skipped');
  if (status === 'failed') return t('marketplace_request.status_failed');
  return t('marketplace_request.status_pending');
}

function _marketplaceRequestAgentAvatarHtml(req) {
  return renderAvatarHtml(req.icon || '', req.color || '', {
    size: 32,
    seed: req.id || req.name || 'marketplace-agent',
    extraClass: 'marketplace-card-avatar chat-marketplace-request-avatar',
    dataAttrs: { 'mp-avatar-slot': '1' },
  });
}

const _MARKETPLACE_REQUEST_CATEGORY_LABELS = {
  education: { zh: '教育', en: 'Education' },
  ecommerce: { zh: '电商', en: 'E-commerce' },
  rnd: { zh: '产研', en: 'R&D' },
  writing: { zh: '写作', en: 'Writing' },
  data: { zh: '数据', en: 'Data' },
  general: { zh: '通用', en: 'General' },
};

function _marketplaceRequestCategoryLabel(code, lang) {
  if (!code) return '';
  const row = _MARKETPLACE_REQUEST_CATEGORY_LABELS[String(code)] || null;
  if (!row) return String(code);
  return lang === 'zh' ? row.zh : row.en;
}

function _marketplaceRequestAuthorBadgeHtml(createUid) {
  if (!createUid) return '';
  const label = String(createUid) === '0'
    ? t('marketplace.author_platform')
    : t('marketplace.author_user').replace('{uid}', String(createUid));
  const cls = String(createUid) === '0' ? 'marketplace-card-chip is-platform' : 'marketplace-card-chip is-user';
  return `<span class="${cls}">${escapeHtml(label)}</span>`;
}

async function _hydrateMarketplaceRequestMeta(card, req, cid, msgId) {
  if (!card || !req) return;
  const hasAvatar = req.kind !== 'agent' || req.icon || req.color;
  const hasCardMeta = req.description_zh || req.description_en || req.category || req.create_uid;
  if (hasAvatar && hasCardMeta) return;
  try {
    const q = req.name || req.id || '';
    const channel = req.kind === 'skill' ? 'marketplace.listSkills' : 'marketplace.listAgents';
    const res = await window.orkas.invoke(channel, { q, size: 20 });
    const row = (res?.list || []).find((x) => x && x.id === req.id);
    if (!row) return;
    req.icon = row.icon || '';
    req.color = row.color || '';
    req.description_zh = row.description_zh || '';
    req.description_en = row.description_en || '';
    req.category = row.category || '';
    req.create_uid = row.create_uid || '';
    _renderMarketplaceInstallCard(card, req, cid, msgId);
  } catch (_) { /* fallback content is already rendered */ }
}

function _setMarketplaceCardBusy(card, busy) {
  if (!card) return;
  card.dataset.busy = busy ? '1' : '0';
  card.classList.toggle('is-busy', !!busy);
  card.querySelectorAll('button').forEach((btn) => { btn.disabled = !!busy; });
}

function _renderMarketplaceInstallCard(card, req, cid, msgId) {
  if (!card || !req) return;
  const status = req.status || 'pending';
  const kind = req.kind === 'skill' ? 'skill' : 'agent';
  card.className = `marketplace-card chat-marketplace-request is-${status}`;
  card.dataset.marketplaceRequestId = String(req.request_id || '');
  card.dataset.marketplaceKind = kind;
  const name = req.name || req.id || '';
  const kindLabel = _marketplaceRequestKindLabel(kind);
  const statusLabel = _marketplaceRequestStatusLabel(status);
  const version = req.version ? t('marketplace.version').replace('{version}', String(req.version)) : '';
  const lang = getLang();
  const descText = pickDesc(req, lang) || req.reason || '';
  const desc = descText ? `<div class="marketplace-card-desc">${escapeHtml(descText)}</div>` : '';
  const catLabel = _marketplaceRequestCategoryLabel(req.category, lang);
  const meta = [
    version ? `<span class="marketplace-card-chip is-version">${escapeHtml(version)}</span>` : '',
    catLabel ? `<span class="marketplace-card-chip">${escapeHtml(catLabel)}</span>` : '',
    _marketplaceRequestAuthorBadgeHtml(req.create_uid),
  ].filter(Boolean).join('');
  const error = req.error ? `<div class="chat-marketplace-request-error">${escapeHtml(req.error)}</div>` : '';
  const iconHtml = kind === 'agent'
    ? _marketplaceRequestAgentAvatarHtml(req)
    : '';
  const actions = status === 'pending'
    ? `<div class="marketplace-card-actions chat-marketplace-request-actions">
        <button type="button" class="btn btn-primary btn-sm" data-mp-decision="install">${escapeHtml(t('marketplace_request.install'))}</button>
        <button type="button" class="btn btn-sm" data-mp-decision="skip">${escapeHtml(t('marketplace_request.skip'))}</button>
      </div>`
    : `<div class="marketplace-card-actions chat-marketplace-request-actions">
        <span class="chat-marketplace-request-status">${escapeHtml(statusLabel)}</span>
      </div>`;
  card.innerHTML = `
    <div class="marketplace-card-header chat-marketplace-request-head">
      ${iconHtml}
      <div class="chat-marketplace-request-main">
        <div class="chat-marketplace-request-title-row">
          <span class="marketplace-card-name chat-marketplace-request-title">${escapeHtml(name)}</span>
          <span class="marketplace-card-chip chat-marketplace-request-kind">${escapeHtml(kindLabel)}</span>
        </div>
      </div>
    </div>
    ${desc}
    ${error}
    <div class="marketplace-card-footer chat-marketplace-request-footer">
      <div class="marketplace-card-meta">${meta}</div>
      ${actions}
    </div>
  `;

  const installBtn = card.querySelector('[data-mp-decision="install"]');
  const skipBtn = card.querySelector('[data-mp-decision="skip"]');
  if (installBtn) {
    installBtn.addEventListener('click', () => {
      _resolveMarketplaceInstallRequest(card, { ...req, kind }, cid, msgId, 'install');
    });
  }
  if (skipBtn) {
    skipBtn.addEventListener('click', () => {
      _resolveMarketplaceInstallRequest(card, { ...req, kind }, cid, msgId, 'skip');
    });
  }
  _hydrateMarketplaceRequestMeta(card, { ...req, kind }, cid, msgId);
}

function _mountMarketplaceInstallRequests(host, msgDiv, message, opts) {
  const cid = opts.cid || currentCid;
  if (!cid || !host || !message) return;
  const msgId = msgDiv.dataset.msgId || message._msg_id || '';
  if (!msgId) return;
  const requests = Array.isArray(message.marketplace_requests) ? message.marketplace_requests : [];
  for (const req of requests) {
    if (!req || !req.request_id) continue;
    const selector = `.chat-marketplace-request[data-marketplace-request-id="${CSS.escape(String(req.request_id))}"]`;
    if (host.querySelector(selector)) continue;
    const card = document.createElement('div');
    host.appendChild(card);
    _renderMarketplaceInstallCard(card, req, cid, msgId);
  }
}

async function _resolveMarketplaceInstallRequest(card, req, cid, msgId, decision) {
  if (!card || card.dataset.busy === '1') return;
  _setMarketplaceCardBusy(card, true);
  const installBtn = card.querySelector('[data-mp-decision="install"]');
  if (decision === 'install' && installBtn) installBtn.textContent = t('marketplace.installing');
  try {
    const res = await apiFetch(`/api/conversations/${encodeURIComponent(cid)}/marketplace-install`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ msgId, requestId: req.request_id, decision }),
    });
    const data = await res.json();
    if (!data || data.ok === false) {
      throw new Error((data && data.error) || 'marketplace install request failed');
    }
    const updated = data.request || { ...req, status: decision === 'install' ? 'installed' : 'skipped' };
    _renderMarketplaceInstallCard(card, updated, cid, msgId);
    if (updated.status === 'installed') {
      if (updated.kind === 'agent') { try { loadAgents?.(true); } catch (_) {} }
      else { try { loadSkills?.(true); } catch (_) {} }
    }
    const submissionText = data.submission && data.submission.text;
    if (submissionText) await sendInCurrentConversation(submissionText);
  } catch (err) {
    _setMarketplaceCardBusy(card, false);
    const reason = (err && err.message) || String(err);
    _convLog.warn('marketplace install request failed', reason);
    try { await uiAlert(t('marketplace.install_failed').replace('{reason}', reason)); } catch (_) {}
  }
}

// Insert a "process info" block above the assistant bubble content
// using the items we stored at stream time. Collapsed by default so
// old threads stay tidy; the user can click ▶ to expand. Exception:
// when the bubble's text body has no real reply (only the "(stopped)"
// abort placeholder or empty content for a turn that never produced
// final text), the process trail IS the content — auto-open it so
// refreshing doesn't appear to erase what the user already watched
// stream in (tool calls / progress lines).
function _renderPersistedProcess(msgDiv, items, { expanded = false } = {}) {
  const bubble = msgDiv.querySelector('.chat-bubble');
  if (!bubble) return;
  const details = document.createElement('details');
  details.className = 'stream-process';
  if (expanded) details.open = true;
  details.innerHTML = `
    <summary class="stream-process-summary">
      <span class="stream-process-label">${escapeHtml(t('chat.process_info'))}</span>
    </summary>
    <div class="stream-process-body"></div>
  `;
  const body = details.querySelector('.stream-process-body');
  for (const item of items) {
    let text = '';
    if (item && item.type === 'progress') text = item.text || '';
    else if (item && item.type === 'event') text = _formatEventLine(item.event) || '';
    if (!text) continue;
    const line = document.createElement('div');
    const kind = item && item.type === 'event'
      ? _eventProcessKind(item.event, text)
      : _processKindOf(text);
    line.className = 'stream-process-line' + (kind ? ' kind-' + kind : '');
    _setProcessLineContent(line, text, kind);
    body.appendChild(line);
  }
  if (body.childElementCount === 0) return;  // nothing renderable
  bubble.insertBefore(details, bubble.firstChild);
}

// ─── Quote-reply (per-cid) ───────────────────────────────────────────────
// Feishu-style: clicking 引用 on an assistant bubble captures its text +
// chip-tracked produced files into a per-cid payload. The payload renders as
// a preview block above the textarea (with × to drop), survives conv switch
// (in-memory, not localStorage — drafts are ephemeral), and is prepended as
// a markdown blockquote when the user finally hits send. Routing reuses the
// existing 给：picker — quote does NOT change the recipient.
//
// Why dataset-driven: produced[] sits on the message object during render but
// the bubble action row only sees `msgDiv` + a getContent closure. Putting
// produced on `msgDiv.dataset.produced` (set in appendChatMessage and the
// stream-finalize path) lets the quote handler stay zero-arg without
// plumbing message into every _attachBubbleArchiveBtn call site.
//
// `_quoteByCid` itself is declared early (above `_recipientByCid`'s neighbour
// block) so the DOMContentLoaded init can call _renderQuotePreview before
// this section evaluates without hitting a TDZ.

function _setQuote(cid, payload) {
  if (!cid) return;
  if (!payload) _quoteByCid.delete(cid);
  else _quoteByCid.set(cid, payload);
  if (cid === currentCid) _renderQuotePreview();
}
function _getQuote(cid) { return cid ? _quoteByCid.get(cid) || null : null; }
function _clearQuote(cid) { _setQuote(cid, null); }

// Render (or hide) the preview block for the active cid. Idempotent — safe
// to call on conv switch / i18n change / quote set / quote clear.
function _renderQuotePreview() {
  const wrap = document.getElementById('chat-quote-preview');
  if (!wrap) return;
  const q = _getQuote(currentCid);
  if (!q) {
    wrap.style.display = 'none';
    wrap.innerHTML = '';
    return;
  }
  // fromName resolved at render time (not at click time) so renames after
  // capture flow through naturally; fall back to the click-time snapshot
  // when the actor was deleted between capture and render.
  const liveName = q.fromActor === 'commander'
    ? (t('chat.from_commander'))
    : _groupActorLabel(q.fromActor);
  const fromName = liveName || q.fromName || (t('chat.from_agent_unknown'));
  const trunc = String(q.text || '');
  const fileChips = (q.produced || []).map((p) => {
    const base = String(p || '').split(/[\\/]/).pop() || p;
    return `<span class="chat-quote-file" title="${escapeHtml(p)}">${_chatFileIconHtml(base)}<span class="chat-quote-file-label">${escapeHtml(base)}</span></span>`;
  }).join('');
  wrap.innerHTML = `
    <div class="chat-quote-header">
      <span class="chat-quote-from">${escapeHtml(t('chat.quote_from', { name: fromName }))}</span>
      <button type="button" class="chat-quote-close" title="${escapeHtml(t('chat.quote_remove_title'))}">×</button>
    </div>
    <div class="chat-quote-body">${escapeHtml(trunc)}</div>
    ${fileChips ? `<div class="chat-quote-files">${fileChips}</div>` : ''}
  `;
  wrap.style.display = '';
  const closeBtn = wrap.querySelector('.chat-quote-close');
  if (closeBtn) closeBtn.addEventListener('click', () => _clearQuote(currentCid));
}

// Prepend the active quote as a markdown blockquote so the receiving agent
// sees it as inbound message body (no special parsing needed). File paths
// land as absolute paths — same shape `produced[]` already stores; the agent
// can `read_file('<abs>')` directly without any cwd assumptions.
//
// **No `引用自 @<sender>` attribution line in the persisted text.** Earlier
// versions prefixed the block with `> **引用自 @<name>：**` for context, but
// `bus.ts::resolveRecipients` scans the message body for `@<token>` mentions
// (including aliases `@指挥官` / `@user`) and union-routes to every match —
// so the attribution `@<sender>` was being parsed as a second recipient,
// re-triggering the original agent / commander on every quote-forward. The
// sender's name is still shown in the input-area preview (renderer-only,
// never serialised), which is enough context for the user pressing send.
function applyQuotePrefix(raw, target) {
  if (target !== 'conversation') return raw;
  const q = _getQuote(currentCid);
  if (!q) return raw;
  const bodyLines = String(q.text || '').split('\n').map((l) => `> ${l}`).join('\n');
  let block = bodyLines;
  if (Array.isArray(q.produced) && q.produced.length) {
    const filesHead = t('chat.quote_files_label');
    const fileLines = q.produced.map((p) => `> - \`${p}\``).join('\n');
    block += `\n>\n> ${filesHead}\n${fileLines}`;
  }
  return raw ? `${block}\n\n${raw}` : block;
}

// Attach a small "archive" button next to the time in the chat-meta row. Kept
// outside the bubble so it never overlaps bubble content. `getContent` is a
// callback so it can return the latest text after streaming completes.
function _attachBubbleArchiveBtn(msgDiv, getContent) {
  // Archive button lives in the `.chat-msg-actions` row below the bubble
  // (alongside produced-file chips). Lazily create the row if a caller
  // (e.g. streaming placeholders that didn't allocate one) needs it.
  let actionsRow = msgDiv.querySelector('[data-role="msg-actions"]');
  if (!actionsRow) {
    actionsRow = document.createElement('div');
    actionsRow.className = 'chat-msg-actions';
    actionsRow.dataset.role = 'msg-actions';
    msgDiv.appendChild(actionsRow);
  }
  if (actionsRow.querySelector('.chat-bubble-actions')) return; // already attached
  const actions = document.createElement('span');
  actions.className = 'chat-bubble-actions';
  actions.innerHTML = `
    <button class="bubble-archive-btn" title="${escapeHtml(t('chat.archive_btn_title'))}">${escapeHtml(t('chat.archive_btn'))}</button>
    <button class="bubble-copy-btn" title="${escapeHtml(t('chat.copy_btn_title'))}">${escapeHtml(t('chat.copy_btn'))}</button>
    <button class="bubble-quote-btn" title="${escapeHtml(t('chat.quote_btn_title'))}">${escapeHtml(t('chat.quote_btn'))}</button>
  `;
  const btn = actions.querySelector('.bubble-archive-btn');
  const copyBtn = actions.querySelector('.bubble-copy-btn');
  const quoteBtn = actions.querySelector('.bubble-quote-btn');
  quoteBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    const text = typeof getContent === 'function' ? (getContent() || '') : '';
    if (!text.trim()) return;
    const fromActor = msgDiv.dataset.fromActor || '';
    const msgId = msgDiv.dataset.msgId || '';
    let produced = [];
    try {
      const raw = msgDiv.dataset.produced || '';
      if (raw) produced = JSON.parse(raw);
      if (!Array.isArray(produced)) produced = [];
    } catch (_) { produced = []; }
    const fromName = fromActor === 'commander'
      ? (t('chat.from_commander') || 'Commander')
      ? (t('chat.from_commander'))
      : (_groupActorLabel(fromActor) || '');
    _setQuote(currentCid, { fromActor, fromName, msgId, text, produced });
    const input = document.getElementById('chat-input');
    if (input) { input.focus(); }
  });
  copyBtn.addEventListener('click', async (e) => {
    e.stopPropagation();
    const text = typeof getContent === 'function' ? (getContent() || '') : '';
    if (!text.trim() || copyBtn.disabled) return;
    copyBtn.disabled = true;
    const orig = copyBtn.innerHTML;
    try {
      await navigator.clipboard.writeText(text);
      copyBtn.innerHTML = `${_uiIconHtml('check', 'ui-icon btn-inline-icon')}<span>${escapeHtml(t('chat.copy_done'))}</span>`;
    } catch (err) {
      copyBtn.textContent = t('chat.copy_failed');
    }
    setTimeout(() => { copyBtn.innerHTML = orig; copyBtn.disabled = false; }, 1500);
  });
  btn.addEventListener('click', async (e) => {
    e.stopPropagation();
    const text = typeof getContent === 'function' ? (getContent() || '') : '';
    if (!text.trim() || btn.disabled) return;
    // Open the KB picker with a default filename derived from the first
    // ~20 visible chars; user confirms directory + filename before any
    // network call happens.
    const pick = await pickKbLocation({
      defaultName: deriveKbArchiveName(text),
      title: t('chat.archive_picker_title'),
    });
    if (!pick) return;
    btn.disabled = true;
    const orig = btn.innerHTML;
    try {
      const res = await apiFetch('/api/contexts/write', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: pick.path, content: text }),
      });
      const data = await res.json();
      if (data.ok) {
        btn.innerHTML = `${_uiIconHtml('check', 'ui-icon btn-inline-icon')}<span>${escapeHtml(t('chat.archive_done'))}</span>`;
        if (currentView === 'contexts' && typeof loadContexts === 'function') {
          loadContexts();
        }
      } else {
        btn.textContent = t('chat.archive_failed');
        await uiAlert(t('chat.archive_failed_with_reason', { reason: data.error || t('chat.unknown_error') }));
      }
    } catch (err) {
      btn.textContent = t('chat.archive_failed');
      await uiAlert(t('chat.archive_failed_with_reason', { reason: err.message || err }));
    }
    setTimeout(() => { btn.innerHTML = orig; btn.disabled = false; }, 2000);
  });
  actionsRow.appendChild(actions);
}

// ─── Send flows ───

async function handleNewChatSubmit() {
  const input = document.getElementById('new-chat-input');
  const raw = (input.value || '').trim();
  if (!raw) return;
  if (!ensureModelConfigured()) return;
  const skill = consumeChatSkill('new-chat');
  // Snapshot the new-chat recipient *now* so a stray view-change between
  // here and conv-create doesn't reset it before we can transfer.
  _pendingNewChatRecipient = { ..._newChatRecipient };
  // Same pattern for the commander project chip — capture before any
  // view-change so the freshly-created conv inherits the picked project.
  if (typeof _captureCommanderProjectForNewChat === 'function') {
    _captureCommanderProjectForNewChat();
  }
  const content = applyRecipientPrefix(transformWithSkill(raw, skill), 'new-chat');
  const draftItems = _chatAttachList(DRAFT_CID);
  if (draftItems.some((a) => a.status === 'uploading')) {
    await uiAlert(t('chat.attach_still_uploading'));
    return;
  }
  const draftNames = draftItems.filter((a) => a.status !== 'error').map((a) => a.name);
  _convLog.info('new chat submit', {
    content_length: content.length,
    skill: skill || null,
    attachments: draftNames.length,
  });

  // Mirror the selected skill onto the conversation input so subsequent messages
  // in the same thread stay consistent until the user removes the chip.
  if (skill) setChatSkill('conversation', skill);

  const newBtn = document.getElementById('new-chat-send-btn');
  if (newBtn) newBtn.disabled = true;
  let convId;
  try {
    const projectId = (typeof _consumeCommanderProjectForNewChat === 'function')
      ? _consumeCommanderProjectForNewChat()
      : '';
    const res = await apiFetch('/api/conversations/create', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind: 'normal', ...(projectId ? { projectId } : {}) }),
    });
    const data = await res.json();
    if (!data.ok) throw new Error(data.error || t('chat.create_conv_failed'));
    const conv = data.conversation;
    convId = conv.conversation_id;
    // Optimistic title from the user-visible text (raw, not the transformed form).
    // Use the shared `_autoTitle` so this matches backend `autoTitle` —
    // otherwise the optimistic + backend-refreshed titles disagree and
    // the sidebar entry flips on the next loadConversations.
    conv.title = _autoTitle(raw);
    conversations.unshift(conv);
    renderConversationList();
    // The new conv may have landed inside a project — refresh the projects
    // cache so its conv_count reflects the new total. Cheap (single IPC).
    if (projectId && typeof loadProjects === 'function') loadProjects(true);
  } catch (e) {
    await uiAlert(t('chat.create_conv_failed_with_reason', { reason: e.message || e }));
    if (newBtn) newBtn.disabled = false;
    return;
  }

  // Rename `main_chat/` → `<convId>/` on disk. Preprocessing caches
  // (`.<name>.extracted.NNN.md`) move with their source — nothing to re-run.
  let attachments = [];
  if (draftNames.length) {
    try {
      const res = await apiFetch('/api/conversations/attachments/adopt', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ from_cid: DRAFT_CID, to_cid: convId }),
      });
      const data = await res.json();
      if (data.ok) {
        attachments = draftNames;
      } else {
        _convLog.warn('adopt draft attachments failed', data.error);
        await uiAlert(t('chat.attach_adopt_failed', { reason: data.error || t('chat.unknown_error') }));
      }
    } catch (err) {
      _convLog.warn('adopt draft attachments threw', err);
      await uiAlert(t('chat.attach_adopt_failed', { reason: err.message || err }));
    }
  }
  // Clear BOTH: the draft pool under #new-chat-attachments AND the target cid
  // so the conversation view's chip area stays empty. Mirrors how main-chat's
  // handleChatSubmit clears its own cid before send (conversation.js:667).
  _chatAttachClear(DRAFT_CID);
  _chatAttachClear(convId);

  input.value = '';
  autoGrow(input, 260);
  // Also clear the conversation-view input. setView with skipLoad:true
  // bypasses _restoreDraft, so without this the new conv would inherit
  // whatever draft text the previously-active conversation left behind in
  // #chat-input — and the next keystroke would save that stale text under
  // the new cid's draft key.
  const chatInput = document.getElementById('chat-input');
  if (chatInput) {
    chatInput.value = '';
    autoGrow(chatInput, 200);
  }
  setView('conversation', convId, { skipLoad: true });
  // Carry the new-chat recipient pick into the new conv's per-cid state so
  // the chip stays "@<agent>" instead of snapping back to commander.
  _transferNewChatRecipientTo(convId);
  _renderRecipientChip('conversation');
  if (newBtn) newBtn.disabled = false;
  await sendInCurrentConversation(content, attachments.length ? { attachments } : undefined);
}

async function handleChatSubmit() {
  const input = document.getElementById('chat-input');
  const raw = (input.value || '').trim();
  if (!currentCid) return;
  // A bare quote with no extra text is a legitimate "look at this" forward;
  // only reject when both the textarea AND the quote are empty.
  if (!raw && !_getQuote(currentCid)) return;
  if (!ensureModelConfigured()) return;
  const cid = currentCid;
  const skill = _chatSkill['conversation'] || '';
  const attachList = _chatAttachList(cid);
  if (attachList.some((a) => a.status === 'uploading')) {
    await uiAlert(t('chat.attach_still_uploading'));
    return;
  }
  const attachments = attachList.filter((a) => a.status !== 'error').map((a) => a.name);
  _convLog.info('chat submit', { cid, length: raw.length, skill: skill || null, attachments: attachments.length });

  // If this conversation is already streaming OR has queued items waiting,
  // enqueue the new message instead of sending it now. Keep the raw text +
  // skill so the prefix is applied fresh when it's actually sent.
  // Quote is baked into the queued content here (rather than carried as a
  // sidecar field on the queue entry) — by the time the queue dispatches,
  // the user may have already cleared/replaced the quote in the preview;
  // capture-at-enqueue keeps each queued message tied to the quote that was
  // visible when the user pressed send.
  if (isConvPending(cid) || (messageQueues.get(cid) || []).length) {
    if (attachments.length) {
      await uiAlert(t('chat.attach_queue_blocked'));
      return;
    }
    enqueueMessage(cid, applyQuotePrefix(raw, 'conversation'), skill);
    _clearQuote(cid);
    input.value = '';
    autoGrow(input, 200);
    _clearDraft(cid);
    return;
  }

  const content = applyRecipientPrefix(applyQuotePrefix(transformWithSkill(raw, skill), 'conversation'), 'conversation');
  _clearQuote(cid);
  input.value = '';
  autoGrow(input, 200);
  _clearDraft(cid);
  // Clear chip area immediately — the server will return with the final
  // attachment state tied to the user message record. If the send fails or
  // is aborted, the files remain on disk but the user can re-attach via the
  // "+" button (listAttachments shows what's still there).
  if (attachments.length) _chatAttachClear(cid);
  await sendInCurrentConversation(content, attachments.length ? { attachments } : undefined);
}

// One transient controller per conversation send. Multi-cid support comes
// from keying this map on cid — user can send in A, navigate to B, and
// trigger a second send in B; each send owns its own controller with its
// own AbortController. Entries are dropped on done via the hooks below.
const _convChatCtrls = new Map();  // cid → controller

function _makeConvChatController(cid) {
  // Captured into the hooks below so we can compare identity before deleting
  // — see onDone for why.
  let self = null;
  const ctrl = createChatController({
    historyEl: 'chat-history',
    inputEl: 'chat-input',
    sendBtnEl: 'chat-send-btn',
    getCurrentId: () => cid,
    historyEndpoint: (id) => `/api/conversations/${id}/history`,
    streamEndpoint: (id) => `/api/conversations/${id}/send/stream`,
    features: {
      archive: true,
      scrollPin: true,
      bindInput: false,   // main chat owns its input wiring (queue-aware)
    },
    hooks: {
      onUserAppended(userMsgEl, _content, _id) {
        // Remember the pair so the stream-end logic can re-pin it.
        userMsgEl.dataset.convPair = '1';
      },
      onAssistantStart(msgEl, id) {
        // New send → drop any stale per-actor placeholders left over from a
        // previous turn in this same conv. Their DOM is finalized (or
        // detached on conv switch); leaving them in `_groupPlaceholders`
        // would cause `_ensureActorPlaceholder` to return a finalized
        // bubble and write fresh deltas into the wrong row.
        for (const k of Array.from(_groupPlaceholders.keys())) {
          if (k.startsWith(`${id}:`)) _groupPlaceholders.delete(k);
        }
        // Bridge the controller's abort into the existing pendingConvs
        // state shape so legacy code (abortConvStream, sidebar badge,
        // polling recovery) keeps working untouched.
        pendingConvs.set(id, {
          loadingEl: msgEl,
          needsIndicator: false,
          controller: { abort: () => _convChatCtrls.get(id)?.abort() },
          aborted: false,
        });
        _updateConvSendUI(id);
        _updateConvSidebarBadge(id, true);
        startPolling(id);
      },
      onAbort(_msgEl, id) {
        const state = pendingConvs.get(id);
        if (state) state.aborted = true;
        _finishStreamingMsg(id);
      },
      onDone(_msgEl, id) {
        // Unconditional cleanup — safe even if polling already resolved.
        // `_finishStreamingMsg` synchronously drains the next queued
        // message (via `_dispatchNextQueued` → new `ctrl.send`), which
        // appends the user bubble + RE-ARMS the scroll-pin spacer for the
        // new turn. We must NOT call `_setChatScrollOffset(false)` here —
        // the controller finally block already removed the OLD spacer
        // before invoking us, so a second removal would strip the spacer
        // the new turn just added and the queued user message would render
        // off-screen until later layout shifts pushed it into view.
        _finishStreamingMsg(id);
        // Only drop the map entry if it still refers to *this* controller.
        // On abort we dispatch the next queued message synchronously from
        // `onAbort`, which assigns a new controller into `_convChatCtrls`
        // before this finally block runs — we must not stomp on it.
        if (_convChatCtrls.get(id) === self) _convChatCtrls.delete(id);
      },
    },
  });
  self = ctrl;
  return ctrl;
}

async function sendInCurrentConversation(content, extra) {
  const cid = currentCid;
  if (!cid || isConvPending(cid)) return;

  // Scroll-pin spacer is owned by the controller (features.scrollPin) —
  // appending it here would land *before* userMsg/asstMsg in DOM order,
  // padding the top instead of the bottom and defeating the pin.

  const ctrl = _makeConvChatController(cid);
  _convChatCtrls.set(cid, ctrl);
  await ctrl.send(content, extra);
}

// Append/remove a sized spacer as the last child of the messages container
// so a short user message can still scroll to the very top while the reply
// is streaming. A real DOM element (not padding) is used so flex-column
// parents (skill/agent edit chat) don't collapse the sibling input area —
// padding-bottom on the messages box would have inflated its intrinsic
// content size and pushed the input off-screen, even with `min-height: 0`
// on the messages child, because of how Chromium sizes flex items with
// `overflow-y: auto`.
function _setChatScrollOffset(on, containerOrId = 'chat-history') {
  const container = typeof containerOrId === 'string'
    ? document.getElementById(containerOrId)
    : containerOrId;
  if (!container) return;
  const existing = container.querySelector(':scope > .chat-scroll-spacer');
  if (!on) {
    if (existing) existing.remove();
    return;
  }
  const spacer = existing || document.createElement('div');
  if (!existing) {
    spacer.className = 'chat-scroll-spacer';
    container.appendChild(spacer);
  }
  // Only top up enough height to "let the last user message scroll to
  // the top" — viewport height minus (the user message and any
  // siblings already after it). Always reserving a full viewport leaves
  // a big blank when the reply is short; this exact-fit calculation
  // makes the blank shrink to almost nothing for short replies. The
  // -24 matches _scrollToMessageTop's offset, leaving room for the
  // floating delete button.
  const userMsgs = container.querySelectorAll(':scope > .chat-message.user');
  const lastUser = userMsgs[userMsgs.length - 1];
  let needed = container.clientHeight - 24;
  if (lastUser) {
    let n = lastUser;
    while (n && n !== spacer) {
      needed -= n.offsetHeight;
      n = n.nextElementSibling;
    }
  }
  spacer.style.height = `${Math.max(0, needed)}px`;
}

// Append `msg` into `container` BEFORE the scroll-pin spacer (if present).
// `_setChatScrollOffset(true)` parks a `.chat-scroll-spacer` at the end of
// chat-history to give short user messages enough room to pin to the top
// during streaming. Naive `container.appendChild(msg)` would put new bubbles
// AFTER that spacer — visually a 100vh blank gap appears between the
// previous bubble and the new one until streaming ends and the spacer is
// removed. Inserting before the spacer keeps the bubble flow contiguous.
function _appendBeforeSpacer(container, msg) {
  const spacer = container.querySelector(':scope > .chat-scroll-spacer');
  if (spacer) container.insertBefore(msg, spacer);
  else container.appendChild(msg);
}

/** Insert a bubble into chat-history at its correct chronological position
 *  based on `data-ts` (ms since epoch). Replaces the older "finalized goes
 *  before live placeholders" heuristic, which had two mutually exclusive
 *  cases:
 *    - Multi-agent burst (commander dispatches A/B/C in quick succession,
 *      each followed by that agent's state_changed): we wanted dispatches
 *      grouped above placeholders.
 *    - Single commander turn: placeholder created at turn-start (~early
 *      ts), plan announcement emitted later (~mid-turn ts) → we want
 *      placeholder ABOVE the announcement.
 *  Time-stamp sort handles BOTH naturally — earlier ts comes first. The
 *  bubble carries `data-ts` set by its creator (state_changed → Date.now()
 *  for placeholders, or `gm.ts` for finalized messages).
 *
 *  Insertion: scan top-down for the first existing bubble whose ts is
 *  STRICTLY LATER than the new one; insert before that. Equal-ts bubbles
 *  preserve insertion order (renderer-arrival sequence as tiebreak). If
 *  no later bubble exists, append at end (before the scroll-pin spacer).
 *
 *  Bubbles without `data-ts` (legacy / history-load) are treated as
 *  earlier-than-anything new — new bubbles always append after them. */
function _insertByTimestamp(container, msg) {
  const newTs = Number(msg.dataset.ts || 0);
  const children = container.querySelectorAll(':scope > .chat-message[data-ts]');
  for (const existing of children) {
    const existingTs = Number(existing.dataset.ts || 0);
    if (existingTs > newTs) {
      container.insertBefore(msg, existing);
      return;
    }
  }
  _appendBeforeSpacer(container, msg);
}

/** Convert various ts representations (ISO string, numeric ms, undefined)
 *  to ms-since-epoch for sortable comparison. Falls back to `Date.now()`
 *  so a missing ts pins the bubble at the moment of creation rather than
 *  at the dawn of time. */
function _msTs(input) {
  if (typeof input === 'number' && Number.isFinite(input)) return input;
  if (typeof input === 'string') {
    const ms = Date.parse(input);
    if (Number.isFinite(ms)) return ms;
  }
  return Date.now();
}

function _createStreamingAssistantMessage(container, opts = {}) {
  if (typeof container === 'string') container = document.getElementById(container);
  if (!container) container = document.getElementById('chat-history');
  const emptyEl = container.querySelector('.empty');
  if (emptyEl) emptyEl.remove();

  const msg = document.createElement('div');
  msg.className = 'chat-message assistant';
  // The streaming placeholder mirrors the bubble layout from
  // appendChatMessage: header strip (sender chip + time) inside the
  // bubble, then process / thinking / final body. The from chip stays
  // empty until we know which actor (commander vs an agent) produced the
  // first reply — _handleGroupBusEvent.message replaces this whole bubble
  // with a freshly-rendered one carrying the right name.
  // Header is intentionally empty until we know who's actually working.
  // The bus may route the user's `@<name>` message to commander OR an
  // agent depending on resolution; hard-coding "commander" misled the user
  // when @-routing succeeded. Once the first state_changed event
  // identifies the in-flight actor we'll fill the chip in (see
  // _handleGroupBusEvent's state_changed branch).
  msg.innerHTML = `
    <div class="chat-msg-header">
      <span class="chat-msg-avatar-slot" data-role="from-avatar"></span>
      <span class="chat-msg-from" data-role="from-chip"></span>
      <span class="chat-msg-time">${formatTime(new Date().toISOString())}</span>
    </div>
    <div class="chat-bubble">
      <details class="stream-process" data-role="process-container" open style="display:none">
        <summary class="stream-process-summary">
          <span class="stream-process-label">${escapeHtml(t('chat.process_info'))}</span>
        </summary>
        <div class="stream-process-body" data-role="process"></div>
      </details>
      <div class="stream-final" data-role="final" style="display:none"></div>
      <div class="stream-thinking" data-role="thinking" aria-label="${escapeHtml(t('chat.thinking_short'))}">
        <span class="stream-thinking-dot"></span>
        <span class="stream-thinking-dot"></span>
        <span class="stream-thinking-dot"></span>
      </div>
    </div>
  `;
  msg.dataset.placeholder = '1';
  if (opts.hiddenUntilActor) {
    msg.dataset.identityPending = '1';
    msg.style.display = 'none';
  }
  // Pin placeholder by creation time so `_insertByTimestamp` keeps it in
  // chronological order with surrounding messages. Updated to the actual
  // gm.ts when the placeholder finalizes (so the bubble's position settles
  // to where it belongs once we know the message's true timestamp).
  msg.dataset.ts = String(Date.now());
  _appendBeforeSpacer(container, msg);
  return msg;
}

function _hideThinking(msg) {
  const thinking = msg.querySelector('[data-role="thinking"]');
  if (thinking) thinking.style.display = 'none';
}

const _PROCESS_GLYPH_KIND = {
  '\u25EF': 'err',
  '\u2717': 'err',
  '\u25CB': 'warn',
  '\u25C9': 'patch',
  '\u25A0': 'tool',
  '\u25B7': 'out',
  '\u25C6': 'think',
  '\u25C7': 'info',
  '\u25B6': 'bound',
  '\u25CF': 'bound',
  '\u25A3': 'plan',
  '\u25D0': 'live',
  '\u25AA': 'meta',
};
const _PROCESS_KIND_ICON = {
  bound: 'play',
  tool: 'squareFilled',
  plan: 'clipboard-list',
  patch: 'document-pencil',
  think: 'diamond',
  live: 'live',
  out: 'output',
  meta: 'dot',
  warn: 'warning',
  err: 'x-circle',
  info: 'info',
};

function _processKindOf(text) {
  const g = (text || '').trimStart().charAt(0);
  return _PROCESS_GLYPH_KIND[g] || '';
}

function _processLineText(text) {
  return String(text || '').replace(/^\s*[\u25EF\u2717\u25CB\u25C9\u25A0\u25B7\u25C6\u25C7\u25B6\u25CF\u25A3\u25D0\u25AA]\uFE0F?\s*/u, '');
}

function _setProcessLineContent(line, text, kind) {
  if (!line) return;
  const body = _processLineText(text);
  line.dataset.processText = body;
  const icon = kind ? _uiIconHtml(_PROCESS_KIND_ICON[kind] || 'info', 'ui-icon stream-process-icon') : '';
  line.innerHTML = `${icon}<span class="stream-process-text">${escapeHtml(body)}</span>`;
}

function _eventProcessKind(evt, text) {
  if (!evt || typeof evt !== 'object') return _processKindOf(text);
  const stream = evt.stream;
  const data = evt.data || {};
  if (stream === 'lifecycle') {
    const p = data.phase;
    if (p === 'error') return 'err';
    if (p === 'start' || p === 'end') return 'bound';
    return 'meta';
  }
  if (stream === 'item') return 'think';
  if (stream === 'plan') return 'plan';
  if (stream === 'tool') return data.isError ? 'err' : 'tool';
  if (stream === 'command_output') return (!data.stdout && data.stderr) ? 'warn' : 'out';
  if (stream === 'patch') return 'patch';
  if (stream === 'approval') return 'warn';
  if (stream === 'error') return 'err';
  if (stream === 'cli') {
    const type = String(data.type || '').toLowerCase();
    if (type === 'tool-event') return 'tool';
    if (type === 'process-info') return 'bound';
    if (type === 'stderr-line' || type === 'idle') return 'warn';
    if (type === 'permission-request') return 'info';
    if (type === 'raw-line') return 'meta';
    if (type === 'log') {
      const level = String(data.level || 'info').toLowerCase();
      return level === 'error' ? 'err' : level === 'warn' ? 'warn' : 'meta';
    }
    if (type === 'status') {
      const st = String(data.status || '').toLowerCase();
      if (st === 'error' || st === 'failed' || st === 'timeout') return 'err';
      if (st === 'cancelled' || st === 'aborted') return 'warn';
      if (st === 'session_ready' || st === 'running' || st === 'result' || st === 'completed' || st === 'usage') return 'bound';
      return 'meta';
    }
  }
  return _processKindOf(text) || 'meta';
}

function _streamingAppendProgress(msg, text, kindHint) {
  // Keep the "thinking…" row visible alongside the process trace — hiding it
  // while only process info shows makes long tool runs look stuck. The row
  // is cleared when the final reply (or an error) arrives.
  const container = msg.querySelector('[data-role="process-container"]');
  if (container) container.style.display = '';
  const body = msg.querySelector('[data-role="process"]');
  if (!body) return;
  // Decide auto-scroll on the inner body BEFORE appending the line —
  // once the new line lands, scrollHeight grows and "near bottom" would
  // misread as false even when the user was tracking the latest output.
  // Threshold is 10 px (one-line tolerance) so the slightest manual
  // scroll-up suspends auto-scroll, letting the user read older entries
  // without being yanked back.
  const innerWasAtBottom = _isNearBottom(body, 10);
  const line = document.createElement('div');
  const kind = kindHint || _processKindOf(text);
  line.className = 'stream-process-line' + (kind ? ' kind-' + kind : '');
  if (kind === 'bound' && /^tokens\b/.test(_processLineText(text))) {
    line.dataset.streamUsage = '1';
  }
  _setProcessLineContent(line, text, kind);
  body.appendChild(line);
  if (innerWasAtBottom) body.scrollTop = body.scrollHeight;
  // Outer chat-history follows independently — its own sticky-bottom
  // logic respects user scroll on the conversation level.
  _stickBottomFromMsg(msg);
}

// Cancel any rAF queued by `_streamingAppendFinalDelta`. Callers that are
// about to overwrite `[data-role="final"]` with canonical content (final
// text / error span) must call this first — otherwise the queued flush
// fires after the overwrite and either (a) wipes finalEl with empty
// markdown when streamBuf was deleted (`_streamingSetFinal` path) or
// (b) paints the half-streamed assistant text over the error span
// (`_streamingSetError` path). Skip for `_streamingMarkAborted` — that
// only adds a sibling note and *wants* the partial content to remain.
function _cancelPendingStreamRaf(msg) {
  if (!msg) return;
  if (msg._streamRafHandle != null && typeof cancelAnimationFrame === 'function') {
    cancelAnimationFrame(msg._streamRafHandle);
  }
  msg._streamRafHandle = null;
  msg._streamRafScheduled = false;
}

// Paint the final reply into a streaming bubble. Caller controls whether
// to attach the archive button afterwards (not all scenes want it — skill and
// agent edit chats skip it by design).
function _streamingSetFinal(msg, text, { archive = false } = {}) {
  _hideThinking(msg);
  const finalEl = msg.querySelector('[data-role="final"]');
  if (!finalEl) return;
  _cancelPendingStreamRaf(msg);
  // Keep the user pinned through the placeholder → final-markdown swap
  // (collapsing the process pane changes scrollHeight). The helper no-ops
  // when the user has scrolled up to read; here that's the expected
  // behaviour — finalize shouldn't yank a reader back to the bottom.
  _stickBottomFromMsg(msg);
  // Always repaint on final: during streaming the DOM may contain
  // placeholder markers (from `_stripAgentCreateBlocksForStream` etc.)
  // that need to be replaced with the backend-cleaned prose. A previous
  // flash-prevention "skip repaint if buf === text" optimisation made
  // placeholders stick when the stream buffer was not exactly equal to
  // the final text for reasons unrelated to cleanliness — the safer
  // default is to always paint the final text (same DOM node, minor
  // reflow, no visible flash in practice).
  const display = _stripSurvivingStructuralBlocks(text);
  finalEl.innerHTML = `<div class="markdown-body">${_renderMessageMarkdown(display)}</div>`;
  finalEl.style.display = '';
  msg.dataset.finalText = display || '';
  delete msg.dataset.streamBuf;
  if (typeof typesetMath === 'function') typesetMath(finalEl);
  if (archive) _attachBubbleArchiveBtn(msg, () => msg.dataset.finalText || '');

  // Preserve the live preview line (keeps the full trace) — just freeze it.
  const live = msg.querySelector('.stream-process-live');
  if (live) {
    live.classList.remove('stream-process-live');
    live.textContent = t('chat.stream_done');
  }

  // Auto-collapse the process section so the finalised reply reads
  // cleanly. But if the entire streaming turn never produced a progress
  // line (e.g. the model answered in one shot with no reasoning / tool
  // calls), keep the initial display:none so we don't render an empty
  // "process info" bubble.
  // **Exception**: when the final body is just an empty/abort stub
  // (i.e. the "(stopped)" placeholder for a turn that never produced
  // real text), the process trail IS the user-visible output — keep
  // it expanded; otherwise the user perceives it as "the process I
  // just watched stream is gone after finalize", which gets worse on
  // refresh.
  const details = msg.querySelector('.stream-process');
  if (details) {
    const body = details.querySelector('.stream-process-body');
    const hasProcess = !!body && body.children.length > 0;
    const bodyText = String(display || '').trim();
    // Match both possible forms — jsonl history can carry either depending
    // on the UI language at the time of write (i18n key `model.aborted` →
    // '(stopped)' in en, '（已中断）' in zh).
    const isAbortStub = bodyText === '（已中断）' || bodyText === '(stopped)' || bodyText === '';
    if (hasProcess && isAbortStub) {
      details.open = true;
      details.style.display = '';
    } else if (hasProcess) {
      details.removeAttribute('open');
      details.style.display = '';
    } else {
      details.removeAttribute('open');
      // else: keep display:none (the initial value set by _createStreamingAssistantMessage).
    }
  }
}

function _streamingSetError(msg, text) {
  _hideThinking(msg);
  _cancelPendingStreamRaf(msg);
  // Freeze the live preview line so it stops looking like it's still streaming.
  const live = msg.querySelector('.stream-process-live');
  if (live) {
    live.classList.remove('stream-process-live');
    live.textContent = (live.textContent || '').replace(/^◐ /, '◯ ') || t('chat.stream_done');
  }
  // On error we also preserve the accumulated process info: if the
  // body is non-empty we display it (matching _streamingSetFinal /
  // _streamingMarkAborted), so the user no longer has to reopen the
  // conversation to see it backfilled from the persisted
  // message.process.
  const details = msg.querySelector('.stream-process');
  if (details) {
    const body = details.querySelector('.stream-process-body');
    const hasProcess = !!body && body.children.length > 0;
    if (hasProcess) details.style.display = '';
  }
  const finalEl = msg.querySelector('[data-role="final"]');
  if (!finalEl) return;
  // Preserve any partial reply that streamed in before the error so the
  // user keeps the assistant's in-flight prose / process info, then append
  // the error pill underneath. Without this, mid-stream errors wipe the
  // visible turn entirely and the user only sees the error pill.
  const partial = String(msg.dataset.streamBuf || '');
  let bodyHtml = '';
  if (partial) {
    const display = _stripSurvivingStructuralBlocks(partial);
    if (display) {
      bodyHtml = `<div class="markdown-body">${_renderMessageMarkdown(display)}</div>`;
      msg.dataset.finalText = display;
    }
  }
  const errPill = `<div class="msg-error" style="color:var(--danger);margin-top:6px">${escapeHtml(t('chat.send_failed', { msg: text }))}</div>`;
  finalEl.innerHTML = bodyHtml + errPill;
  finalEl.style.display = '';
  delete msg.dataset.streamBuf;
  if (bodyHtml && typeof typesetMath === 'function') typesetMath(finalEl);
}

// Mark the assistant bubble as user-interrupted. Preserves whatever partial
// content streamed into the process pane; just stamps a "stopped" note.
function _streamingMarkAborted(msg) {
  _hideThinking(msg);
  // Freeze any live preview line so it's not misread as still generating.
  const live = msg.querySelector('.stream-process-live');
  if (live) {
    live.classList.remove('stream-process-live');
    live.textContent = (live.textContent || '').replace(/^◐ /, '◯ ') || t('chat.stream_interrupted_line');
  }
  const bubble = msg.querySelector('.chat-bubble');
  if (bubble && !bubble.querySelector('.stream-aborted-note')) {
    const note = document.createElement('div');
    note.className = 'stream-aborted-note';
    note.textContent = t('chat.interrupted');
    bubble.appendChild(note);
  }
  const details = msg.querySelector('.stream-process');
  if (details) details.style.display = '';
}

function _finishStreamingMsg(cid) {
  pendingConvs.delete(cid);
  if (isGroupConversationBusy(cid)) startPolling(cid);
  else stopPolling(cid);
  _updateConvSidebarBadge(cid, false);
  if (cid === currentCid) _updateConvSendUI(cid);
  // Drain the next queued message for this conversation, if any.
  _dispatchNextQueued(cid);
}

// Scroll the given message to the top of the visible chat area.
function _scrollToMessageTop(msgEl, containerId = 'chat-history') {
  if (!msgEl) return;
  const container = document.getElementById(containerId);
  if (!container) return;
  // Pin-to-top intentionally moves the user away from the bottom; if
  // sticky-bottom were left armed, the first stream delta would race the
  // pin and yank the view back down. Disarm synchronously here — the
  // user has to scroll back to bottom themselves to re-arm following.
  container._stickyEnabled = false;
  // Instant scroll to avoid the animation getting clobbered by streaming DOM
  // mutations that land during the send. Use rAF twice to make sure layout
  // has settled (style recalc after appendChild, then paint).
  requestAnimationFrame(() => requestAnimationFrame(() => {
    const containerRect = container.getBoundingClientRect();
    const msgRect = msgEl.getBoundingClientRect();
    // Reserve only enough margin so the floating delete button
    // (top:20px + ~33px tall) doesn't sit flush against the message;
    // a larger blank exposes the previous message and feels noisy.
    // 24px lines up with the bottom of the delete button.
    const offset = msgRect.top - containerRect.top + container.scrollTop - 24;
    // Force auto behavior so the jump is immediate — the CSS default of
    // scroll-behavior:smooth would otherwise animate and get interrupted by
    // streaming DOM mutations that land during the scroll.
    const prev = container.style.scrollBehavior;
    container.style.scrollBehavior = 'auto';
    container.scrollTop = offset;
    requestAnimationFrame(() => {
      container.style.scrollBehavior = prev || '';
    });
  }));
}

// ─── Generic chat controller ─────────────────────────────────────────────
// Encapsulates the shared send/stream/abort/scroll pipeline so different
// scenes (main conversation, skill-edit inline chat, agent-edit inline chat)
// can share one implementation. Per-scene differences are expressed via the
// `config` arg, not by forking the code.
//
// config shape:
//   historyEl:       HTMLElement   — where messages render
//   inputEl:         HTMLTextArea  — the send textarea
//   sendBtnEl:       HTMLElement   — send/stop button
//   getCurrentId():  returns the target id (cid / skill id / agent id)
//   streamEndpoint(id): returns the URL string for the streaming POST
//   historyEndpoint(id): returns the URL for GET history
//   clearEndpoint(id):   (optional) URL for DELETE history
//   features: {
//     archive:    bool  // attach archive button on final
//     scrollPin:  bool  // pin newly-sent user message to top of viewport
//   }
//   hooks: {
//     beforeSend(content, id)     → transformedContent | null   // cancel by returning null
//     onUserAppended(userMsgEl, content, id)
//     onAssistantStart(msgEl, id)
//     onStreamEvent(ev, msgEl, id)   // extra side-effects per event
//     onFinal(ev, msgEl, id)         // e.g. refresh skill view, update agent fields
//     onError(text, msgEl, id)
//     onAbort(msgEl, id)
//     onDone(msgEl, id, { aborted, errored })
//     onHistoryLoaded(history, conversationMeta, id)
//     appendHistoryMessage(message, autoScroll, id)  // default uses global appendChatMessage
//   }
//
// Returns { loadHistory, send, abort, clear, isBusy }
function createChatController(config) {
  const features = { archive: false, scrollPin: true, bindInput: true, queue: false, ...(config.features || {}) };
  const hooks = config.hooks || {};
  let pending = null;   // { controller, msgEl, userMsgEl, aborted, errored }

  const historyEl = typeof config.historyEl === 'string'
    ? document.getElementById(config.historyEl)
    : config.historyEl;
  const inputEl = typeof config.inputEl === 'string'
    ? document.getElementById(config.inputEl)
    : config.inputEl;
  const sendBtnEl = typeof config.sendBtnEl === 'string'
    ? document.getElementById(config.sendBtnEl)
    : config.sendBtnEl;

  // ── Optional queue module (features.queue enabled) ──────────────────
  // Mirrors the main-chat queue (stacked while a reply is streaming,
  // drained on done, drag-reorderable, edit-in-place). Storage is per
  // (keyPrefix, currentId) in localStorage so navigating between
  // skills/agents keeps each queue isolated.
  const qCfg = config.queue || null;
  const qEls = features.queue && qCfg ? {
    panel: typeof qCfg.panelId === 'string' ? document.getElementById(qCfg.panelId) : null,
    list:  typeof qCfg.listId  === 'string' ? document.getElementById(qCfg.listId)  : null,
    count: typeof qCfg.countId === 'string' ? document.getElementById(qCfg.countId) : null,
  } : null;
  const qKeyPrefix = qCfg?.keyPrefix || 'ctrl';
  const _qStorageKey = (id) => `queue_${qKeyPrefix}:${id}`;
  const _qCache = new Map();   // id → array

  function _qLoad(id) {
    if (!id) return [];
    try {
      const raw = localStorage.getItem(_qStorageKey(id));
      const arr = raw ? JSON.parse(raw) : [];
      return Array.isArray(arr) ? arr : [];
    } catch { return []; }
  }
  function _qSave(id, arr) {
    if (!id) return;
    try {
      if (arr.length) localStorage.setItem(_qStorageKey(id), JSON.stringify(arr));
      else localStorage.removeItem(_qStorageKey(id));
    } catch {}
  }
  function _qGet(id) {
    if (!id) return [];
    if (!_qCache.has(id)) _qCache.set(id, _qLoad(id));
    return _qCache.get(id);
  }
  function enqueue(content, meta = {}) {
    if (!features.queue) return false;
    const id = config.getCurrentId();
    if (!id) return false;
    const q = _qGet(id);
    q.push({
      id: `q${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
      content, meta,
    });
    _qSave(id, q);
    renderQueue();
    return true;
  }
  function _qRemove(qid) {
    const id = config.getCurrentId(); if (!id) return;
    const q = _qGet(id);
    const idx = q.findIndex(m => m.id === qid);
    if (idx < 0) return;
    q.splice(idx, 1);
    _qSave(id, q);
    renderQueue();
  }
  function _qUpdate(qid, newContent) {
    const id = config.getCurrentId(); if (!id) return;
    const q = _qGet(id);
    const item = q.find(m => m.id === qid);
    if (!item) return;
    item.content = newContent;
    _qSave(id, q);
    renderQueue();
  }
  function _qReorder(fromIdx, toIdx) {
    const id = config.getCurrentId(); if (!id) return;
    const q = _qGet(id);
    if (fromIdx < 0 || fromIdx >= q.length) return;
    toIdx = Math.max(0, Math.min(q.length, toIdx));
    const [item] = q.splice(fromIdx, 1);
    q.splice(fromIdx < toIdx ? toIdx - 1 : toIdx, 0, item);
    _qSave(id, q);
    renderQueue();
  }
  function _qDispatchNext() {
    if (!features.queue) return;
    const id = config.getCurrentId(); if (!id) return;
    if (pending) return;
    const q = _qGet(id);
    if (!q.length) return;
    const next = q.shift();
    _qSave(id, q);
    renderQueue();
    send(next.content);
  }
  function renderQueue() {
    if (!features.queue || !qEls || !qEls.panel || !qEls.list) return;
    const id = config.getCurrentId();
    const q = id ? _qGet(id) : [];
    if (qEls.count) qEls.count.textContent = String(q.length);
    if (!q.length) {
      qEls.panel.style.display = 'none';
      qEls.list.innerHTML = '';
      return;
    }
    qEls.panel.style.display = '';
    qEls.list.innerHTML = q.map(item => {
      const preview = escapeHtml((item.content || '').replace(/\s+/g, ' ')).slice(0, 200);
      return `
        <div class="chat-queue-item" draggable="true" data-qid="${item.id}">
          <div class="chat-queue-drag" title="${escapeHtml(t('chat.queue_drag_title'))}">⋮⋮</div>
          <div class="chat-queue-text">${preview}</div>
          <div class="chat-queue-actions">
            <button class="chat-queue-btn" data-act="edit">${escapeHtml(t('chat.queue_edit'))}</button>
            <button class="chat-queue-btn danger" data-act="del">×</button>
          </div>
        </div>`;
    }).join('');
    _wireQueueItemEvents();
  }
  function _wireQueueItemEvents() {
    if (!qEls?.list) return;
    qEls.list.querySelectorAll('.chat-queue-btn[data-act="del"]').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const qid = btn.closest('.chat-queue-item')?.dataset.qid;
        if (qid) _qRemove(qid);
      });
    });
    qEls.list.querySelectorAll('.chat-queue-btn[data-act="edit"]').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const row = btn.closest('.chat-queue-item');
        if (row) _qStartEdit(row);
      });
    });
    let dragEl = null;
    qEls.list.querySelectorAll('.chat-queue-item').forEach((row, idx) => {
      row.dataset.idx = String(idx);
      row.addEventListener('dragstart', (e) => {
        dragEl = row; row.classList.add('dragging');
        try {
          e.dataTransfer.effectAllowed = 'move';
          e.dataTransfer.setData('text/plain', row.dataset.qid || '');
        } catch {}
      });
      row.addEventListener('dragend', () => {
        row.classList.remove('dragging');
        qEls.list.querySelectorAll('.drop-target').forEach(el => el.classList.remove('drop-target'));
        dragEl = null;
      });
      row.addEventListener('dragover', (e) => {
        if (!dragEl || dragEl === row) return;
        e.preventDefault();
        qEls.list.querySelectorAll('.drop-target').forEach(el => el.classList.remove('drop-target'));
        row.classList.add('drop-target');
      });
      row.addEventListener('drop', (e) => {
        e.preventDefault();
        if (!dragEl || dragEl === row) return;
        const fromIdx = parseInt(dragEl.dataset.idx, 10);
        let toIdx = parseInt(row.dataset.idx, 10);
        const rect = row.getBoundingClientRect();
        if (e.clientY > rect.top + rect.height / 2) toIdx += 1;
        row.classList.remove('drop-target');
        if (Number.isInteger(fromIdx) && Number.isInteger(toIdx)) _qReorder(fromIdx, toIdx);
      });
    });
  }
  function _qStartEdit(row) {
    const id = config.getCurrentId(); if (!id) return;
    const qid = row.dataset.qid;
    const item = _qGet(id).find(m => m.id === qid);
    if (!item) return;
    row.classList.add('editing');
    row.innerHTML = `
      <textarea class="chat-queue-edit" rows="2"></textarea>
      <div class="chat-queue-edit-actions">
        <button class="chat-queue-btn" data-act="cancel">${escapeHtml(t('chat.queue_cancel'))}</button>
        <button class="chat-queue-btn" data-act="save">${escapeHtml(t('chat.queue_save'))}</button>
      </div>`;
    const ta = row.querySelector('.chat-queue-edit');
    ta.value = item.content || '';
    ta.focus();
    ta.setSelectionRange(ta.value.length, ta.value.length);
    const finish = () => renderQueue();
    row.querySelector('[data-act="cancel"]').addEventListener('click', finish);
    row.querySelector('[data-act="save"]').addEventListener('click', () => {
      const v = (ta.value || '').trim();
      if (!v) _qRemove(qid);
      else _qUpdate(qid, v);
    });
    ta.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { e.preventDefault(); finish(); }
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        const v = (ta.value || '').trim();
        if (!v) _qRemove(qid); else _qUpdate(qid, v);
      }
    });
  }

  function isBusy() { return !!pending; }

  function _updateSendUI() {
    // When the scene owns its input wiring (features.bindInput=false), leave
    // send-button state to the caller — their own _updateXxx logic is
    // authoritative (queue-aware, multi-cid etc.).
    if (!features.bindInput) return;
    if (!sendBtnEl) return;
    const busy = !!pending;
    // `.aborting` is the "stop clicked, stream not yet unwound" lock. While
    // set, keep the send-style + disabled appearance so the click feels
    // immediate; it self-clears once the stream truly ends (busy === false).
    if (sendBtnEl.classList.contains('aborting')) {
      if (busy) return;
      sendBtnEl.classList.remove('aborting');
    }
    sendBtnEl.classList.toggle('streaming', busy);
    sendBtnEl.disabled = false;
    sendBtnEl.title = busy ? t('chat.stop_reply') : t('chat.send_title');
    if (inputEl) {
      inputEl.placeholder = busy
        ? t('chat.replying')
        : (inputEl.dataset.placeholder || inputEl.placeholder);
    }
  }

  function _appendHistoryMessage(message, autoScroll, cid, msgIndex) {
    if (typeof hooks.appendHistoryMessage === 'function') {
      return hooks.appendHistoryMessage(message, autoScroll, config.getCurrentId());
    }
    // Default renderer — reuses the main-chat bubble so skills/agents look
    // identical out of the box. Archive defaults to scene's features flag.
    return appendChatMessage(message, autoScroll, {
      container: historyEl,
      archive: features.archive,
      cid: cid || config.getCurrentId(),
      ...(typeof msgIndex === 'number' ? { msgIndex } : {}),
    });
  }

  async function loadHistory() {
    const id = config.getCurrentId();
    if (!id) return;
    historyEl.innerHTML = `<div class="empty">${escapeHtml(t('chat.loading'))}</div>`;
    try {
      const res = await apiFetch(config.historyEndpoint(id));
      const data = await res.json();
      if (!data.ok) throw new Error(data.error || 'load failed');
      const history = data.history || data.messages || [];
      if (!history.length) {
        historyEl.innerHTML = `<div class="empty">${escapeHtml(t('chat.empty'))}</div>`;
      } else {
        historyEl.innerHTML = '';
        history.forEach((msg, idx) => _appendHistoryMessage(msg, false, id, idx));
      }
      _scrollToBottomNoAnim(historyEl);
      if (features.queue) renderQueue();
      if (hooks.onHistoryLoaded) hooks.onHistoryLoaded(history, data.conversation || null, id);
    } catch (e) {
      historyEl.innerHTML = `<div class="empty">${escapeHtml(t('chat.load_failed', { msg: e.message || '' }))}</div>`;
    }
  }

  async function send(rawContent, extraBody) {
    if (pending) return;   // single-threaded send per controller
    const id = config.getCurrentId();
    if (!id) return;
    let content = (rawContent || '').trim();
    if (!content) return;
    // Gate every chat-controller send on model config — covers the normal
    // conversation flow plus skill/agent edit chats, and also catches queue
    // drains and auto-seed sends (e.g. skills.js 'autoSeed').
    if (!ensureModelConfigured()) return;
    if (hooks.beforeSend) {
      const transformed = await hooks.beforeSend(content, id);
      if (transformed === null || transformed === undefined) return;
      content = transformed;
    }

    const attachmentsForBubble = Array.isArray(extraBody && extraBody.attachments)
      ? extraBody.attachments
      : undefined;
    const userMsgEl = _appendHistoryMessage(
      {
        role: 'user',
        content,
        // Match server's `nowIso()` format (local-time, second-precision).
        // Using `new Date().toISOString()` here would ms-bump the user
        // bubble past the server-stamped agent reply within the same
        // second and `_insertByTimestamp` would render the agent's
        // reply before the user message.
        time: nowIsoLocal(),
        ...(attachmentsForBubble ? { attachments: attachmentsForBubble } : {}),
      },
      false,
      id,
    );
    if (hooks.onUserAppended) hooks.onUserAppended(userMsgEl, content, id);

    const msgEl = _createStreamingAssistantMessage(historyEl, { hiddenUntilActor: true });
    if (hooks.onAssistantStart) hooks.onAssistantStart(msgEl, id);

    // On send, pin the user's message to the top of the viewport once;
    // do NOT scroll during or after streaming — that would yank a user
    // who scrolled up mid-stream back to the initial position.
    // Paired with `has-scroll-offset` reserving 100vh of bottom
    // space so even short messages can be scrolled to the top; the
    // controller is responsible for toggling it so each scene doesn't
    // copy-paste the same logic.
    if (features.scrollPin) {
      _setChatScrollOffset(true, historyEl);
      _scrollToMessageTop(userMsgEl, historyEl.id);
    }

    const controller = new AbortController();
    pending = { controller, msgEl, userMsgEl, aborted: false, errored: false };
    _updateSendUI();

    try {
      const res = await apiFetch(config.streamEndpoint(id), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content, ...(extraBody || {}) }),
        signal: controller.signal,
      });
      if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);

      const reader = res.body.getReader();
      const decoder = new TextDecoder('utf-8');
      let buffer = '';
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let idx;
        while ((idx = buffer.indexOf('\n\n')) >= 0) {
          const rawEvent = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);
          const dataLines = rawEvent.split('\n')
            .filter(l => l.startsWith('data:'))
            .map(l => l.slice(5).trimStart());
          if (!dataLines.length) continue;
          try {
            const ev = JSON.parse(dataLines.join('\n'));
            // Post-abort events can still arrive while main's for-await drains
            // its buffer — drop them so the bubble stays frozen at the "stopped" state
            // instead of accumulating more deltas / a final reply behind it.
            if (pending?.aborted) continue;
            _handleStreamEvent(id, msgEl, ev, { archive: features.archive });
            if (hooks.onStreamEvent) hooks.onStreamEvent(ev, msgEl, id);
            if (ev.type === 'final' && hooks.onFinal) hooks.onFinal(ev, msgEl, id);
            if (ev.type === 'error') {
              pending.errored = true;
              if (hooks.onError) hooks.onError(ev.text, msgEl, id);
            }
          } catch (_) { /* skip malformed */ }
        }
      }
    } catch (err) {
      if (err?.name === 'AbortError' || pending?.aborted) {
        _streamingMarkAborted(msgEl);
        if (hooks.onAbort) hooks.onAbort(msgEl, id);
      } else {
        _streamingSetError(msgEl, err.message || String(err));
        pending.errored = true;
        if (hooks.onError) hooks.onError(err.message || String(err), msgEl, id);
      }
    } finally {
      const wasAborted = pending?.aborted;
      const wasErrored = pending?.errored;
      pending = null;
      _updateSendUI();
      if (features.scrollPin) _setChatScrollOffset(false, historyEl);
      if (hooks.onDone) hooks.onDone(msgEl, id, { aborted: wasAborted, errored: wasErrored });
      // No re-pin at stream end — respect the user's scroll position
      // if they scrolled up mid-stream.
      // Drain one queued message if any, matching main-chat behaviour.
      if (features.queue) _qDispatchNext();
    }
  }

  function abort() {
    if (!pending) return;
    pending.aborted = true;
    try { pending.controller.abort(); } catch (_) {}
    // Main's for-await loop only checks `cancelled` between yields, so it
    // can take a while to emit `done` — that means _streamingMarkAborted
    // (called from the catch block) runs late and the "thinking…" row stays
    // visible. Mark the bubble now so the UI terminates on click, and rely
    // on reader-loop gating (pending.aborted) to drop any stragglers.
    if (pending.msgEl) {
      try { _streamingMarkAborted(pending.msgEl); } catch (_) {}
    }
    // Immediate button feedback — fetch abort only unwinds the reader when
    // the current chunk settles, so without this the .streaming class would
    // linger and the click looks dead. See _updateSendUI's .aborting guard.
    if (features.bindInput && sendBtnEl) {
      sendBtnEl.classList.remove('streaming');
      sendBtnEl.classList.add('aborting');
      sendBtnEl.disabled = true;
    }
  }

  async function clear() {
    if (!config.clearEndpoint) return;
    const id = config.getCurrentId();
    if (!id) return;
    try {
      await apiFetch(config.clearEndpoint(id), { method: 'DELETE' });
    } catch (_) { /* ignore */ }
    historyEl.innerHTML = `<div class="empty">${escapeHtml(t('chat.empty'))}</div>`;
  }

  // Queue-aware submit: mirrors main-chat semantics.
  //   - pending stream + submit → enqueue the new message
  //   - idle + queue non-empty + submit → enqueue, so the user's stacked
  //     items keep their FIFO order (next item drains on done)
  //   - idle + empty queue → send directly
  function _submitFromInput() {
    if (!inputEl) return;
    const content = inputEl.value;
    if (!content.trim()) return;
    const id = config.getCurrentId();
    const hasQueue = features.queue && id && _qGet(id).length > 0;
    inputEl.value = '';
    autoGrow(inputEl, 160);
    if (pending || hasQueue) {
      if (features.queue) enqueue(content);
    } else {
      send(content);
    }
  }

  // Wire send button + Cmd/Ctrl+Enter to the controller. Scenes that have
  // their own binding (e.g. the main conversation's queue-aware logic) can
  // opt out via features.bindInput=false and just call ctrl.send() directly.
  if (features.bindInput) {
    if (sendBtnEl && !sendBtnEl.dataset.ctrlBound) {
      sendBtnEl.dataset.ctrlBound = '1';
      sendBtnEl.addEventListener('click', () => {
        if (pending) abort();
        else _submitFromInput();
      });
    }
    if (inputEl && !inputEl.dataset.ctrlBound) {
      inputEl.dataset.ctrlBound = '1';
      inputEl.addEventListener('keydown', (e) => {
        // Enter sends; Shift+Enter newline; Ctrl/Cmd+Enter also sends. Skip IME
        // (CLAUDE.md §8 — keyCode 229 catches older Electron / Safari builds
        // where `isComposing` is occasionally inaccurate).
        if (e.isComposing || e.keyCode === 229) return;
        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault();
          _submitFromInput();
        }
      });
    }
  }

  _updateSendUI();
  return { loadHistory, send, abort, clear, isBusy, enqueue, renderQueue };
}

function _handleStreamEvent(cid, msg, ev, { archive = false } = {}) {
  if (ev.type === 'progress') {
    _streamingAppendProgress(msg, ev.text);
  } else if (ev.type === 'event') {
    const inner = ev.event || {};
    // Group-chat bus events arrive as `{stream:'group', data:GroupEvent}`.
    // Each `data.type === 'message'` is a fully-formed actor reply — render
    // it as a new bubble (commander or agent), skipping the legacy "single
    // streaming bubble" model entirely. Process events go on the rail of
    // the streaming placeholder bubble (msg) until the first `message`
    // arrives, then on the most-recent rendered bubble for that actor.
    if (inner.stream === 'group' && inner.data) {
      _handleGroupBusEvent(cid, msg, inner.data, { archive });
      return;
    }
    if (inner.stream === 'agent_created' && inner.data && inner.data.agent_id) {
      _mountCreatedAgentChip(msg, inner.data);
      return;
    }
    _renderAgentEvent(msg, ev.event);
  } else if (ev.type === 'delta') {
    _streamingAppendFinalDelta(msg, ev.text || '');
  } else if (ev.type === 'final') {
    _streamingSetFinal(msg, ev.text, { archive });
    // Attach input-form widget if the final event carries one. Main
    // already stripped the fenced block from `ev.text`, so the bubble
    // shows clean markdown + the widget below it.
    if (ev.form && typeof window.renderChatInputForm === 'function') {
      const bubble = msg.querySelector('.chat-bubble');
      if (bubble && !bubble.querySelector('.chat-input-form')) {
        if (typeof ev.msgIndex === 'number') msg.dataset.msgIndex = String(ev.msgIndex);
        const host = document.createElement('div');
        bubble.appendChild(host);
        _mountChatInputForm(host, msg, { role: 'assistant', form: ev.form }, { cid });
      }
    }
    // Created-agent chips also arrive on the final event payload — attach
    // here in case the relay event was missed (e.g. on reconnect / replay).
    const finalCreated = _normalizeCreatedAgents(ev);
    if (finalCreated) {
      for (const payload of finalCreated) _mountCreatedAgentChip(msg, payload);
    }
  } else if (ev.type === 'error') {
    _streamingSetError(msg, ev.text);
  }
}

// Per-(cid, actor) streaming placeholder cache. Group-chat turns can run
// multiple actors interleaved (commander → agent → ...); each one needs
// its OWN placeholder bubble so token streaming, tool-call rails and
// thinking dots don't smash into the wrong row. The initial placeholder
// passed in by the chat controller is co-opted for whichever actor the
// first state_changed identifies; later actors get fresh placeholders
// minted lazily on first state/process event addressed to them.
const _groupPlaceholders = new Map(); // key = `${cid}:${actorId}` → element

function _phKey(cid, actorId) { return `${cid}:${actorId || ''}`; }

function _knownGroupActorLabel(cid, actorId) {
  if (!actorId) return '';
  if (actorId === 'commander') return t('chat.from_commander');
  if (typeof _agentsCache !== 'undefined' && Array.isArray(_agentsCache)) {
    const a = _agentsCache.find((x) => x && x.agent_id === actorId);
    if (a && a.name) return a.name;
  }
  const cached = _groupMembersCache.get(cid) || [];
  const a = cached.find((x) => x && x.id === actorId);
  return a && a.name ? a.name : '';
}

function _setPlaceholderActor(ph, actorId, opts = {}) {
  if (!ph) return;
  const cid = opts.cid || currentCid;
  const force = !!opts.force;
  ph.dataset.fromActor = actorId || '';
  const label = _knownGroupActorLabel(cid, actorId);
  const ready = !!actorId && (actorId === 'commander' || !!label || !!opts.allowFallback);
  const chip = ph.querySelector('[data-role="from-chip"]');
  if (chip && (force || !chip.textContent)) {
    chip.textContent = label || (opts.allowFallback ? t('chat.from_agent_unknown') : '');
  }
  const avatarSlot = ph.querySelector('[data-role="from-avatar"]');
  if (avatarSlot && actorId && (force || !avatarSlot.firstChild)) {
    avatarSlot.innerHTML = label
      ? _renderActorAvatarHtml(actorId)
      : '';
  }
  if (ph.dataset.identityPending === '1') {
    if (ready) {
      ph.style.display = '';
      delete ph.dataset.identityPending;
    } else {
      ph.style.display = 'none';
    }
  }
}

function _refreshActorPlaceholders(cid, actorId) {
  if (!cid) return;
  for (const [key, ph] of _groupPlaceholders.entries()) {
    if (!key.startsWith(`${cid}:`)) continue;
    const id = ph?.dataset?.fromActor || key.slice(`${cid}:`.length);
    if (actorId && id !== actorId) continue;
    _setPlaceholderActor(ph, id, { cid, force: true });
  }
}

function _ensureActorPlaceholder(cid, actorId, fallbackPh) {
  const k = _phKey(cid, actorId);
  let ph = _groupPlaceholders.get(k);
  if (ph && ph.parentElement) return ph;
  // Adopt the controller's initial placeholder for the first actor seen,
  // so we don't waste it on an empty bubble when only one actor runs.
  // Skip adoption if `fallbackPh` was already finalized in a prior turn —
  // otherwise commander's second turn (the post-agent summary) would
  // re-adopt commander's turn-1 bubble and overwrite its content with
  // turn-2 deltas. The `finalized` flag is stamped by
  // `_consumeActorPlaceholder` when a turn ends; once set, the bubble is
  // a finished history record and must not be reused as a streaming target.
  if (fallbackPh && fallbackPh.parentElement
      && fallbackPh.dataset.finalized !== '1'
      && (!fallbackPh.dataset.fromActor || fallbackPh.dataset.fromActor === actorId)) {
    _setPlaceholderActor(fallbackPh, actorId, { cid });
    _groupPlaceholders.set(k, fallbackPh);
    return fallbackPh;
  }
  const container = document.getElementById('chat-history');
  if (!container) return null;
  ph = _createStreamingAssistantMessage(container, { hiddenUntilActor: true });
  _setPlaceholderActor(ph, actorId, { cid });
  _groupPlaceholders.set(k, ph);
  if (actorId && actorId !== 'commander' && !_knownGroupActorLabel(cid, actorId)) {
    _refreshGroupMembers(cid).then(() => _refreshActorPlaceholders(cid, actorId)).catch(() => {});
  }
  return ph;
}

function _consumeActorPlaceholder(cid, actorId) {
  const k = _phKey(cid, actorId);
  const ph = _groupPlaceholders.get(k);
  _groupPlaceholders.delete(k);
  // Mark the consumed bubble as finalized so a later `_ensureActorPlaceholder`
  // (e.g. commander's second turn after an agent reports back) doesn't
  // re-adopt this same DOM node as a fresh streaming target — otherwise
  // turn-2 deltas would overwrite turn-1's persisted content.
  if (ph) ph.dataset.finalized = '1';
  return ph || null;
}

// Transform a streaming placeholder bubble into its finalized form:
// freeze the process rail (keep visible + collapsed by default),
// render markdown into [data-role="final"], append produced-files chip /
// form widget / created-agent chip / submission-tag stripping for user
// messages — everything appendChatMessage would have done. Pre-existing
// stream content (live deltas) is replaced with the canonical text from
// the GroupMessage so the bubble matches the persisted record.
function _finalizeActorPlaceholder(ph, gm, cid, archive) {
  if (!ph || !gm) return;
  ph.dataset.fromActor = String(gm.from || '');
  ph.dataset.msgId = String(gm.id || '');

  // Update the header timestamp to the message's actual ts (placeholder
  // showed the moment we started waiting; persisted msg has the real time).
  const timeEl = ph.querySelector('.chat-msg-time');
  if (timeEl && gm.ts) timeEl.textContent = formatTime(gm.ts);
  // Reposition the bubble to its canonical chronological slot: placeholder
  // was created at the moment its worker started thinking, but the message
  // that finalizes it carries the actual `gm.ts` (often later than
  // sibling actors' messages that landed first). Without re-sorting here,
  // a slow actor's bubble stays at its creation-time slot, ahead of
  // faster actors' actually-earlier messages — refresh fixes it because
  // history loads in jsonl order, but live UI looked out of order.
  if (gm.ts) {
    const newTs = _msTs(gm.ts);
    ph.dataset.ts = String(newTs);
    const parent = ph.parentElement;
    if (parent) {
      parent.removeChild(ph);
      _insertByTimestamp(parent, ph);
    }
  }
  // Also fill the from chip in case state_changed never set it.
  _setPlaceholderActor(ph, gm.from, { cid, force: true, allowFallback: true });

  // Plan-announcement label (commander first plan_set).
  if (gm.plan_announcement) {
    const bubble = ph.querySelector('.chat-bubble');
    if (bubble && !bubble.querySelector('.chat-plan-announce')) {
      const lbl = document.createElement('div');
      lbl.className = 'chat-plan-announce';
      lbl.innerHTML = `${_uiIconHtml('clipboard-list', 'ui-icon chat-plan-announce-icon')}<span>${escapeHtml(t('chat.plan_announce'))}</span>`;
      bubble.insertBefore(lbl, bubble.firstChild);
    }
  }

  // Final markdown body: reuses the legacy helper which preserves the
  // .stream-process rail (collapsed if non-empty, hidden if empty) so
  // tool calls stay scannable after the reply lands.
  const text = String(gm.text || '');
  _streamingSetFinal(ph, text, { archive });

  // Lazily allocate the below-bubble actions row (post-stream placeholders
  // didn't get one at creation time; appendChatMessage history bubbles do).
  let actionsRow = ph.querySelector('[data-role="msg-actions"]');
  if (!actionsRow) {
    actionsRow = document.createElement('div');
    actionsRow.className = 'chat-msg-actions';
    actionsRow.dataset.role = 'msg-actions';
    ph.appendChild(actionsRow);
  }

  // Produced-files chips (assistant local-exec output) — chip-style inside
  // the actions row, NOT inside the bubble. Click → reveal in OS file
  // manager via `workspace.revealPath` IPC.
  if (Array.isArray(gm.produced) && gm.produced.length) {
    if (!actionsRow.querySelector('.chat-msg-produced')) {
      const wrap = document.createElement('div');
      wrap.innerHTML = _renderMessageProducedHtml(gm.produced);
      const node = wrap.firstElementChild;
      if (node) {
        actionsRow.appendChild(node);
        _hydrateMessageProducedChips(ph);
      }
    }
    // Mirror dataset.produced so the 引用 button can read it (same contract
    // as appendChatMessage above; without this, post-stream finalize would
    // leave the chip row in place but the quote payload would carry no files).
    ph.dataset.produced = JSON.stringify(gm.produced);
  }

  // Created-agent chips (commander quick-create / quick-edit) — same actions row.
  const gmCreated = _normalizeCreatedAgents(gm);
  if (gmCreated) {
    for (const payload of gmCreated) _mountCreatedAgentChip(ph, payload);
  }
  // Created-skill chip (commander skill create / edit).
  const gmSkills = _normalizeCreatedSkills(gm);
  if (gmSkills) {
    for (const payload of gmSkills) _mountCreatedSkillChip(ph, payload);
  }

  // Form widget (agent → user input form).
  if (gm.form && typeof window.renderChatInputForm === 'function') {
    const bubble = ph.querySelector('.chat-bubble');
    if (bubble && !bubble.querySelector('.chat-input-form')) {
      const host = document.createElement('div');
      bubble.appendChild(host);
      const formMessage = {
        role: 'assistant',
        form: gm.form,
        _msg_id: gm.id,
      };
      _mountChatInputForm(host, ph, formMessage, { cid });
    }
  }

  if (Array.isArray(gm.marketplace_requests) && gm.marketplace_requests.length) {
    const bubble = ph.querySelector('.chat-bubble');
    if (bubble) {
      const reqMessage = {
        role: 'assistant',
        marketplace_requests: gm.marketplace_requests,
        _msg_id: gm.id,
      };
      _mountMarketplaceInstallRequests(bubble, ph, reqMessage, { cid });
    }
  }

  // Interactive web-app artifacts (chat-app:// iframe). Idempotent — skips
  // ids already mounted in this bubble.
  if (Array.isArray(gm.artifacts) && gm.artifacts.length && typeof window.mountMessageArtifacts === 'function') {
    const bubble = ph.querySelector('.chat-bubble');
    if (bubble) window.mountMessageArtifacts(bubble, gm.artifacts, cid);
  }
}

// Group-chat bus event router. Each event is one of:
//   { type: 'message', cid, msg: GroupMessage }
//   { type: 'process', cid, actor, data: { type, text?, event? } }
//   { type: 'plan_changed', cid }
//   { type: 'state_changed', cid, state: { status, in_flight } }
//   { type: 'member_joined', cid, actor }
//   { type: 'aborted', cid }
function _handleGroupBusEvent(cid, streamingMsg, evData, { archive = false } = {}) {
  if (!evData || typeof evData !== 'object') return;
  // Bump the conv to the top of the sidebar list whenever a user-visible
  // message lands — applies to both currently-viewed and background convs,
  // so the sidebar stays ordered by last activity in real time. Skip
  // internal commander→agent dispatch records (they're not visible in the
  // user's view; visible end-of-turn replies will bump shortly after).
  if (evData.type === 'message' && evData.msg && !evData.msg.dispatch) {
    _bumpConvToTop(cid);
    if (window.ConversationInfo) window.ConversationInfo.refresh(cid);
  }
  // Cross-cid leakage guard: per-cid controllers stay alive when the user
  // navigates away mid-stream (a legit pattern — let the conv finish in
  // the background, sidebar badge tracks completion). But all cids share
  // the SAME `chat-history` DOM, and `_createStreamingAssistantMessage`
  // appends fresh placeholder bubbles to whatever element
  // `getElementById('chat-history')` returns — i.e. the currently-viewed
  // conv. Without this guard, switching from cid A (still streaming) to
  // cid B causes A's process / state_changed events to mint NEW bubbles
  // inside B's view, so users see "two streams running simultaneously".
  // Persistence isn't affected (jsonl is written by the bus regardless),
  // and on switch-back `loadConversationHistory` rebuilds the cid's view
  // from disk — so dropping live UI updates here is safe.
  if (cid !== currentCid) return;
  if (evData.type === 'message') {
    const gm = evData.msg;
    if (!gm) return;
    // Skip echoing the user's own send — already rendered as the user
    // bubble by the input handler.
    if (gm.from === 'user') return;
    // Internal plan-step dispatch (commander → agent) — agent slice gets
    // it for context, user view ignores. See loadConversationHistory's
    // matching filter for refresh consistency.
    if (gm.dispatch) return;
    // `turn_end: true` ONLY when this message is the actor's own end-of-turn
    // reply (bus marks it via runTurn). Tool-emitted side-effect messages
    // (plan_set's plan announcement, plan_executor's commander → agent
    // dispatch) come WITHOUT this flag — they're "the actor said this
    // mid-turn", not "the actor is done." Consuming the streaming
    // placeholder for mid-turn messages causes a stuck-bubble bug:
    // post-tool process events recreate a new placeholder that nothing
    // ends up consuming when the actor's actual turn finishes silent.
    const isTurnEnd = !!evData.turn_end;
    if (isTurnEnd) {
      // Track the most recent interactive agent's turn-end so the chip can
      // stay sticky on it after in_flight clears (Phase 1.5 in
      // _pickInteractiveAgent). Look up via the cached members roster
      // populated by _refreshGroupMembers.
      if (gm.from && gm.from !== 'user' && gm.from !== 'commander') {
        const members = _groupMembersCache.get(cid) || [];
        const fromActor = members.find((m) => m && m.id === gm.from);
        if (fromActor && fromActor.interactive === true) {
          _lastInteractiveTurnAgent.set(cid, gm.from);
        }
      } else if (gm.from === 'commander' || gm.from === 'user') {
        // Commander or user spoke after the agent → release sticky so the
        // chip can move on (commander turn or user reply break the
        // tutor↔student loop).
        _lastInteractiveTurnAgent.delete(cid);
      }
      // Finalize THIS actor's placeholder in place — preserves the process
      // rail (tool calls, progress lines) accumulated during the turn so
      // it stays readable after the reply settles. If we don't have a
      // placeholder (history-replay race, or message arrived before any
      // state_changed), fall back to a fresh appendChatMessage.
      const ph = _consumeActorPlaceholder(cid, gm.from);
      if (ph && ph.parentElement) {
        _finalizeActorPlaceholder(ph, gm, cid, archive);
      } else {
        const legacy = _groupMsgToLegacy(gm);
        const bubble = appendChatMessage(legacy, true, { cid, archive });
        if (bubble) bubble.dataset.fromActor = String(gm.from || '');
        // Cache-refresh parity with `_mountCreatedAgentChip`: the placeholder
        // path goes through it (which calls loadAgents/loadSkills(true)),
        // but this fallback runs appendChatMessage directly which only
        // paints the chip — without this hop, fast turns that emit zero
        // process events leave _agentsCache / _skillsCache stale, so the
        // newly-created agent is missing from the agents tab and the @
        // picker until a manual refresh.
        if (_normalizeCreatedAgents(gm)) { try { loadAgents?.(true); } catch (_) {} }
        if (_normalizeCreatedSkills(gm)) { try { loadSkills?.(true); } catch (_) {} }
      }
    } else {
      // Mid-turn message — append a new bubble alongside, leave the
      // streaming placeholder alive for the rest of the actor's turn.
      const legacy = _groupMsgToLegacy(gm);
      const bubble = appendChatMessage(legacy, true, { cid, archive });
      if (bubble) bubble.dataset.fromActor = String(gm.from || '');
    }
    // (Removed pre-seed-recipient-placeholder logic.) Earlier I pre-created
    // placeholders for each `gm.to` agent on commander's dispatch message,
    // hoping to pin bubble order to dispatch sequence. But that interleaves
    // dispatch bubbles with placeholders in the DOM (`A_dispatch, A_ph,
    // B_dispatch, B_ph, ...`) — exactly the "messy realtime order" the user
    // complained about.
    //
    // Bus naturally serializes worker startup (sync ensureWorker + queue.push
    // + wake → microtask), and `markInFlight` is mutex-guarded. So
    // `state_changed` events arrive at renderer in dispatch order. The
    // `state_changed` handler creates each agent's placeholder at the end
    // of `chat-history` in turn, AFTER all dispatch bubbles. Final layout:
    // `[A_dispatch, B_dispatch, C_dispatch, A_ph, B_ph, C_ph]` — matches
    // the post-refresh / jsonl order.
  } else if (evData.type === 'process') {
    const actor = String(evData.actor || '');
    const data = evData.data || {};
    if (!actor) return;
    // A renderer can attach after the actor's initial `state_changed(running)`
    // event has already passed (refresh, tab switch, scheduled/remote run).
    // Process events are proof that work is still active, so recover the
    // composer state here instead of leaving the button in blue "send" mode
    // while a live placeholder is visibly thinking.
    if (!isGroupConversationBusy(cid)) {
      setGroupConversationBusy(cid, true);
      _updateConvSidebarBadge(cid, true);
      startPolling(cid);
      if (cid === currentCid) _updateConvSendUI(cid);
    }
    const target = _ensureActorPlaceholder(cid, actor, streamingMsg);
    if (!target) return;
    // Diagnostic — count how many deltas reach the renderer per actor.
    // If this number is much smaller than the bus emit count from the
    // turn-end log, the bottleneck is upstream (IPC batching). If it's
    // similar, the bottleneck is in the rAF flush / markdown render.
    if (typeof window !== 'undefined') {
      window._convDeltaCount = window._convDeltaCount || {};
      if (data.type === 'delta') {
        window._convDeltaCount[actor] = (window._convDeltaCount[actor] || 0) + 1;
      }
    }
    if (data.type === 'delta' && typeof data.text === 'string') {
      // Token-by-token streaming → write into the placeholder's final
      // body so the user sees the reply form character-by-character.
      _streamingAppendFinalDelta(target, data.text);
    } else if (data.type === 'progress' && data.text) {
      _streamingAppendProgress(target, String(data.text));
    } else if (data.type === 'event') {
      _renderAgentEvent(target, data.event);
    }
  } else if (evData.type === 'plan_changed') {
    // Plan step transitions are the trigger for the input-box auto-target:
    // when an interactive agent's step enters in_progress, the user's next
    // reply should default to that agent without them having to @-mention.
    _evaluateAutoRecipient(cid);
    if (window.PlanRail) window.PlanRail.refresh(cid, { force: true });
    if (window.ConversationInfo) window.ConversationInfo.refresh(cid, { silent: true });
  } else if (evData.type === 'state_changed') {
    // Each in_flight actor gets a placeholder so its delta tokens / tool
    // calls render in its own bubble even before its `message` arrives.
    // Adopt the controller's initial placeholder for the first actor.
    const st = evData.state || {};
    const inFlight = Array.isArray(st.in_flight) ? st.in_flight.slice() : [];
    setGroupConversationBusy(cid, st.status === 'running' || inFlight.length > 0);
    if (inFlight.length) {
      for (const actorId of inFlight) {
        if (!actorId) continue;
        _ensureActorPlaceholder(cid, actorId, streamingMsg);
      }
    }
    // Mirror in_flight so _evaluateAutoRecipient knows when commander is
    // mid-turn (release the chip back to commander even if plan still has
    // an interactive agent's done step as the most-recent terminal).
    _latestInFlight.set(cid, inFlight);
    // state_changed also fires on plan reconcile boundaries — re-evaluate
    // the auto-target so the chip matches the current dispatch state even
    // when a plan_changed event was missed (e.g. on first connect).
    _evaluateAutoRecipient(cid);
    // Plan rail hides retry/skip/abort buttons whenever any worker is in
    // flight (avoids racing user actions against an in-progress turn).
    if (window.PlanRail) {
      window.PlanRail.setInFlight(cid, inFlight);
    }
    if (window.ConversationInfo) window.ConversationInfo.refresh(cid, { silent: true });
    _updateConvSidebarBadge(cid, false);
    if (cid === currentCid) _updateConvSendUI(cid);
  } else if (evData.type === 'aborted') {
    setGroupConversationBusy(cid, false);
    _latestInFlight.set(cid, []);
    // Only drop EMPTY placeholders here (queued-but-not-yet-running workers
    // whose queue got cleared by bus.abort never fire runTurn → no follow-up
    // message/turn_silent → their dancing-dot placeholder would be orphaned
    // forever without this sweep).
    //
    // Placeholders that already accumulated process content (tool calls,
    // progress lines, deltas) belong to a worker whose `runTurn` IS in
    // flight — its abort path will emit a `message` (persist with process
    // info attached) or `turn_silent` event right after this; let those
    // handlers consume the same DOM node so the user sees a single
    // continuous bubble (process rail rendered during streaming → text body
    // finalized in place) instead of the original "process info disappears,
    // then reappears in a new bubble" jump caused by aggressive removal.
    for (const k of Array.from(_groupPlaceholders.keys())) {
      if (!k.startsWith(`${cid}:`)) continue;
      const ph = _groupPlaceholders.get(k);
      const processBody = ph?.querySelector('[data-role="process"]');
      const hasProcess = !!processBody && processBody.children.length > 0;
      const finalBody = ph?.querySelector('[data-role="final"]');
      const hasFinalText = !!finalBody && (finalBody.textContent || '').trim().length > 0;
      if (hasProcess || hasFinalText) continue; // owned by a running worker — leave for message/turn_silent
      _groupPlaceholders.delete(k);
      if (ph && ph.parentElement) ph.remove();
    }
    _updateConvSidebarBadge(cid, false);
    if (cid === currentCid) _updateConvSendUI(cid);
  } else if (evData.type === 'turn_silent') {
    // The actor's turn ended without producing a persisted message
    // (executor returned outcome=silent). Two sub-cases:
    //   (a) Placeholder accumulated process info (tool calls, progress
    //       lines, deltas) — FREEZE it as a finalized "thinking trail"
    //       bubble. Don't delete: user wants to see what the actor did
    //       during the silent turn (e.g. commander wrote a plan via
    //       plan_set; the process trail shows the tool call + reasoning).
    //   (b) Placeholder is empty (no process events) — DELETE it. Nothing
    //       useful to preserve; an empty zombie bubble is just noise.
    const actorId = String(evData.actor || '');
    if (actorId) {
      const k = _phKey(cid, actorId);
      const ph = _groupPlaceholders.get(k);
      if (ph) {
        _groupPlaceholders.delete(k);
        const processBody = ph.querySelector('[data-role="process"]');
        const hasProcess = !!processBody && processBody.children.length > 0;
        if (hasProcess) {
          // Freeze the bubble: hide thinking dots, leave process rail as
          // a folded "completed thinking" bubble. Empty final body = no main text.
          if (typeof _streamingSetFinal === 'function') {
            _streamingSetFinal(ph, '', { archive: false });
          }
          ph.dataset.finalized = '1';
          _convLog.info('turn_silent received (frozen)', { cid, actor: actorId });
        } else if (ph.parentElement) {
          ph.remove();
          _convLog.info('turn_silent received (removed)', { cid, actor: actorId });
        }
      }
    }
  } else if (evData.type === 'member_joined') {
    // Refresh the cache so subsequent bubbles and already-mounted
    // placeholders can render the agent's real name/avatar instead of the
    // neutral streaming shell.
    _rememberGroupActor(cid, evData.actor);
    _refreshGroupMembers(cid);
  }
}

// Append a "view details" chip into a streaming bubble. Idempotent per
// agent_id — repeat calls for the same id no-op; calls for different ids
// accumulate into the same `.chat-msg-created-agent` row.
function _mountCreatedAgentChip(msg, payload) {
  if (!msg || !payload || !payload.agent_id) return;
  let actionsRow = msg.querySelector('[data-role="msg-actions"]');
  if (!actionsRow) {
    actionsRow = document.createElement('div');
    actionsRow.className = 'chat-msg-actions';
    actionsRow.dataset.role = 'msg-actions';
    msg.appendChild(actionsRow);
  }
  const aid = payload.agent_id;
  if (actionsRow.querySelector(`.chat-msg-created-agent-chip[data-agent-id="${CSS.escape(aid)}"]`)) return;
  let wrap = actionsRow.querySelector('.chat-msg-created-agent');
  if (!wrap) {
    wrap = document.createElement('div');
    wrap.className = 'chat-msg-created-agent';
    actionsRow.appendChild(wrap);
  }
  // Render an array of one + extract the inner chip(s) so we append into
  // the existing wrap rather than nesting `.chat-msg-created-agent` rows.
  const tmp = document.createElement('div');
  tmp.innerHTML = _renderMessageCreatedAgentHtml([payload]);
  const newChips = tmp.querySelectorAll('.chat-msg-created-agent-chip');
  for (const chip of newChips) wrap.appendChild(chip);
  _hydrateMessageCreatedAgentChip(msg);
  // Refresh the agents-cache lazily so the user sees the new agent in the
  // sidebar list when they jump over. Non-fatal if it fails.
  try { if (typeof loadAgents === 'function') loadAgents(true); } catch (_) {}
}

// Skill mirror of `_mountCreatedAgentChip`. Idempotent per skill_id;
// repeat calls for the same id no-op, calls for different ids accumulate
// into the same chip row. Skill chips and agent chips share CSS but are
// distinguished by `data-agent-id` vs `data-skill-id`, so they coexist in
// separate `.chat-msg-created-agent` wrappers.
function _mountCreatedSkillChip(msg, payload) {
  if (!msg || !payload || !payload.skill_id) return;
  let actionsRow = msg.querySelector('[data-role="msg-actions"]');
  if (!actionsRow) {
    actionsRow = document.createElement('div');
    actionsRow.className = 'chat-msg-actions';
    actionsRow.dataset.role = 'msg-actions';
    msg.appendChild(actionsRow);
  }
  const sid = payload.skill_id;
  if (actionsRow.querySelector(`.chat-msg-created-agent-chip[data-skill-id="${CSS.escape(sid)}"]`)) return;
  // Find or create a wrapper that already holds skill chips. `:has(...)`
  // keeps us from accidentally appending into the agent-chip wrapper.
  let wrap = actionsRow.querySelector('.chat-msg-created-agent:has(.chat-msg-created-agent-chip[data-skill-id])');
  if (!wrap) {
    wrap = document.createElement('div');
    wrap.className = 'chat-msg-created-agent';
    actionsRow.appendChild(wrap);
  }
  const tmp = document.createElement('div');
  tmp.innerHTML = _renderMessageCreatedSkillHtml([payload]);
  const newChips = tmp.querySelectorAll('.chat-msg-created-agent-chip');
  for (const chip of newChips) wrap.appendChild(chip);
  _hydrateMessageCreatedSkillChip(msg);
  try { if (typeof loadSkills === 'function') loadSkills(true); } catch (_) {}
}

// Hide the `<agent-input-submission form_id=... agent_id=...>{json}
// </agent-input-submission>` XML tag from a user message body at render
// time. The tag is required in the stored raw text so the LLM can parse
// back the submitted values, but it's noise for the human reader — the
// bulleted summary above it already tells them what they confirmed.
function _stripSubmissionTagForDisplay(text) {
  if (!text || text.indexOf('<agent-input-submission') < 0) return text;
  // Atomic-container strip with prose/code guard via strip-structural-blocks.js.
  // Same class of fragmentation / set-B leak as `<agent>` — see that
  // file's header for the invariant matrix.
  const out = _stripOuterTagBlocks(text, 'agent-input-submission');
  if (out === text) return text;
  return out.replace(/\n{3,}/g, '\n\n').trimEnd();
}

// Hide the `<artifact-result artifact_id=... agent_id=...>{json}
// </artifact-result>` tag from a user message body at render time. The tag
// is the machine payload an interactive artifact posted back (the LLM parses
// it); the human reader only needs the one-line summary above it. Same
// atomic-container strip + prose/code guard as the submission tag.
function _stripArtifactResultTagForDisplay(text) {
  if (!text || text.indexOf('<artifact-result') < 0) return text;
  const out = _stripOuterTagBlocks(text, 'artifact-result');
  if (out === text) return text;
  return out.replace(/\n{3,}/g, '\n\n').trimEnd();
}

// Hide the `<marketplace-install-result>` machine payload that gets replayed
// after the user clicks a marketplace install/skip card. The visible summary
// line remains, while the commander still receives the raw structured tag in
// message history and can continue the task.
function _stripMarketplaceInstallResultTagForDisplay(text) {
  if (!text || text.indexOf('<marketplace-install-result') < 0) return text;
  const out = _stripOuterTagBlocks(text, 'marketplace-install-result');
  if (out === text) return text;
  return out.replace(/\n{3,}/g, '\n\n').trimEnd();
}

// `_splitMarkdownProseCode`, `_findOuterAgentRanges`, `_stripSurvivingAgentBlocks`,
// `_replaceOuterAgentBlocks` are defined in `./strip-structural-blocks.js` (loaded earlier
// in `index.html`). They live in their own file so vitest can pin the set-A /
// set-B fixtures (`test/renderer/strip-structural-blocks.test.ts`) — see that file for
// the invariant matrix. Wrap the i18n-aware placeholder here and delegate.
//
// Wrap placeholder text in an HTML `<em>` instead of markdown `_text_`:
// standard markdown requires word-boundary chars on each side of `_` for
// italic emphasis, and CJK glyphs don't count as word boundaries, so
// `_<CJK placeholder>_` renders with the underscores visible. `<em>` passes through
// renderMarkdownFull as-is (HTML inline tags are preserved by the markdown
// pipeline) and actually italicises the CJK text.
function _streamPlaceholderHtml(key) {
  return `\n<em class="stream-placeholder">${escapeHtml(t(key))}</em>\n`;
}

function _stripAgentCreateBlocksForStream(buf) {
  return _replaceOuterAgentBlocks(buf, _streamPlaceholderHtml('chat.create_agent_streaming_placeholder'));
}

// `<<<skill-file path=X ... >>>` blocks (skill edit chat). Different fence
// shape from `<agent>` (see strip-structural-blocks.js header) but same user-facing
// contract: streaming placeholder hides the raw block + reveals the file
// being written. The path attribute (when present) flows into the
// localised "Writing X…" label so the placeholder is informative;
// unattributed blocks fall back to a generic "Writing file…" label.
function _stripSkillFileBlocksForStream(buf) {
  return _replaceOuterSkillFileBlocks(buf, (path) => {
    const label = path
      ? t('chat.skill_file_streaming_placeholder', { path })
      : t('chat.skill_file_streaming_placeholder_unknown');
    return `\n<em class="stream-placeholder">${escapeHtml(label)}</em>\n`;
  });
}

// `<skill>` container (commander create / edit). Pure logic lives in
// `strip-structural-blocks.js::_stripSkillCreateContainer` — see that header for the
// closed-vs-unclosed mode rules. This wrapper only builds the i18n-aware
// fallback placeholder and delegates so DOM / i18n / escapeHtml stay out
// of the pure-function module (parallel to how `_stripAgentCreateBlocksForStream`
// composes `_replaceOuterAgentBlocks`). Set A / set B fixtures pinned in
// `test/renderer/strip-structural-blocks.test.ts`.
function _stripSkillCreateBlocksForStream(buf) {
  return _stripSkillCreateContainer(
    buf,
    _streamPlaceholderHtml('chat.create_skill_streaming_placeholder'),
  );
}

function _stripAgentFormBlockForStream(buf) {
  // Primary: XML `<agent-input-form>...</agent-input-form>` (symmetric
  // with submission reply tag, token-stable). Legacy: fenced
  // ```agent-input-form block — tolerated with `[\s\-]*` inside the
  // header to also catch "```agent\n-input-form" token-split outputs.
  // Both stream to the same placeholder; main's final pass mounts the
  // actual form widget.
  if (!buf) return buf;
  const placeholder = _streamPlaceholderHtml('chat.form.streaming_placeholder');
  // XML branch: atomic-container handling via strip-structural-blocks.js — same
  // prose/code guard as `<agent>` so a fenced ```xml example or inline
  // backtick mention of `<agent-input-form>` survives instead of being
  // eaten as a real form.
  let out = _replaceOuterTagBlocks(buf, 'agent-input-form', placeholder);
  // Legacy fenced-block branch — kept for old-protocol compatibility.
  // No prose/code guard here: the legacy fence IS itself a code fence,
  // and outer fenced quoting of legacy form blocks is implausible.
  if (/```\s*agent[\s\-]*input[\s\-]*form/.test(out)) {
    out = out.replace(
      /(?:^|\n)```\s*agent[\s\-]*input[\s\-]*form[ \t]*\r?\n[\s\S]*?\n```(?=\n|$)/g,
      placeholder,
    );
    out = out.replace(/(?:^|\n)```\s*agent[\s\-]*input[\s\-]*form[\s\S]*$/, placeholder);
  }
  return out;
}

// Progressive renderer — append an assistant text delta into the final
// bubble and re-render markdown. The first delta reveals the `[data-role=final]`
// container; the "thinking" row stays visible BELOW the body until the terminal
// `final` / error / aborted event lands (so the user sees "partial reply +
// still typing" instead of "partial reply + nothing happening"; the row is
// rendered after `.stream-final` in `_createStreamingAssistantMessage`).
// `_streamingSetFinal` is still called at the terminal `final` event to
// guarantee a clean final render.
//
// Render throttling: every delta accumulates into `dataset.streamBuf`
// synchronously, but the actual `renderMarkdownFull` + DOM swap only runs
// once per animation frame (via `requestAnimationFrame`). Each delta in
// the wild is ~2-4 chars and they can arrive ~50/sec; without throttling
// we'd run renderMarkdown × 500 in one event loop turn (each O(n) on the
// growing buffer = O(n²) total ≈ multi-second sync stall) and the user
// would see nothing until the stall ended. With rAF throttling the
// reader loop stays cheap and the browser paints between frames.
function _streamingAppendFinalDelta(msg, piece) {
  if (!piece) return;
  const finalEl = msg.querySelector('[data-role="final"]');
  if (!finalEl) return;
  const prev = msg.dataset.streamBuf || '';
  const next = prev + piece;
  msg.dataset.streamBuf = next;
  msg.dataset.finalText = next;
  if (finalEl.style.display === 'none') finalEl.style.display = '';
  if (msg._streamRafScheduled) return;
  msg._streamRafScheduled = true;
  const flush = () => {
    msg._streamRafScheduled = false;
    msg._streamRafHandle = null;
    const buf = msg.dataset.streamBuf || '';
    const display = _stripSkillCreateBlocksForStream(
      _stripAgentCreateBlocksForStream(
        _stripAgentFormBlockForStream(
          _stripSkillFileBlocksForStream(buf),
        ),
      ),
    );
    finalEl.innerHTML = `<div class="markdown-body">${_renderMessageMarkdown(display)}</div>`;
    // Token deltas grow the bubble; keep the user pinned to the latest
    // text if they were following along (no-op once they scroll up).
    _stickBottomFromMsg(msg);
  };
  if (typeof requestAnimationFrame === 'function') {
    msg._streamRafHandle = requestAnimationFrame(flush);
  } else {
    setTimeout(flush, 0);
  }
}

// Format a raw openclaw event into one process-pane line. Returns null for
// events that shouldn't have their own line (assistant deltas — handled by
// the live-generating row; tool/function/message items — redundant with
// their dedicated streams).
//
// Icon palette (Unicode Geometric Shapes per CLAUDE.md §8). Each glyph has
// exactly one semantic role — stick to this table when adding new streams:
//
//   ▶   reasoning start      ●   reasoning done
// Process-pane text is plain content; _eventProcessKind maps events to SVG
// icons and semantic CSS classes.
function _formatEventLine(evt) {
  if (!evt || typeof evt !== 'object') return null;
  const { stream, data } = evt;
  if (!stream || stream === 'assistant') return null;

  const phaseCn = (p) => (p === 'start' ? t('chat.stream.phase_start') : p === 'end' ? t('chat.stream.phase_end') : (p || ''));

  if (stream === 'lifecycle') {
    const p = data?.phase;
    if (p === 'start') return t('chat.stream.reasoning_start');
    if (p === 'end') return t('chat.stream.reasoning_done');
    if (p === 'error') {
      const errObj = data?.error;
      const msg = typeof errObj === 'string' ? errObj
                : (errObj?.message || data?.message || '');
      return msg ? t('chat.stream.reasoning_error_with', { msg }) : t('chat.stream.reasoning_error');
    }
    return t('chat.stream.lifecycle', { p: p || '' }).trim();
  }

  if (stream === 'item') {
    const itemType = String(data?.itemType || data?.type || '').toLowerCase();
    // Tool / function / message items duplicate what the dedicated streams
    // emit with much richer detail — skip them here to keep the log scannable.
    if (itemType.includes('tool') || itemType.includes('function') ||
        itemType.includes('message')) return null;
    const prefix = itemType.includes('reasoning') ? t('chat.stream.thinking') :
                   (itemType || t('chat.stream.thinking'));
    const detail = data?.text || data?.summary || data?.name || '';
    const detailStr = detail ? ` — ${String(detail).replace(/\s+/g, ' ')}` : '';
    return `${prefix} ${phaseCn(data?.phase)}${detailStr}`.trim();
  }

  if (stream === 'plan') {
    const steps = data?.steps;
    if (Array.isArray(steps) && steps.length) {
      const titles = steps.map(s => s?.title || s?.description || '').filter(Boolean);
      return t('chat.stream.plan_with_steps', { n: steps.length, titles: titles.join(' → ') });
    }
    return t('chat.stream.plan', { p: phaseCn(data?.phase) }).trim();
  }

  if (stream === 'tool') {
    const name = data?.name || data?.toolName || 'tool';
    const phase = data?.phase || data?.status;
    const p = phaseCn(phase);
    const isError = !!data?.isError;
    // On start → show arguments (bash command / file path / JSON fallback).
    // On end   → prefer result_preview so users see what the call returned.
    let detail = '';
    if (phase === 'end') {
      const rp = data?.result_preview;
      if (rp) detail = typeof rp === 'string' ? rp : JSON.stringify(rp);
    }
    if (!detail) {
      const args = data?.arguments || data?.args;
      if (args != null) {
        if (typeof args === 'string') {
          detail = args;
        } else if (typeof args === 'object') {
          detail = args.command || args.path || '';
          if (!detail) { try { detail = JSON.stringify(args); } catch { detail = ''; } }
        } else {
          detail = String(args);
        }
      }
    }
    detail = detail.replace(/\s+/g, ' ').trim();
    if (detail.length > 160) detail = detail.slice(0, 160) + '…';
    const detailStr = detail ? ' · ' + detail : '';
    return `${name}${p ? ' · ' + p : ''}${detailStr}`;
  }

  if (stream === 'command_output') {
    // Distinguish stderr from stdout so CLI agents (claude code / codex /
    // openclaw / opencode / hermes) don't render their entire spool in a
    // single muted slate. Stderr maps to kind-warn; stdout maps to kind-out.
    // Falls back to stdout styling if the event doesn't disambiguate via
    // separate stdout/stderr fields.
    const stdout = data?.stdout;
    const stderr = data?.stderr;
    const text = data?.text || stdout || stderr || '';
    if (!text) return t('chat.stream.command_empty');
    return String(text);
  }

  if (stream === 'patch') {
    const p = data?.path || data?.file || '';
    const summary = data?.summary || data?.action || '';
    return `${t('chat.stream.patch')}${p ? ' ' + p : ''}${summary ? '（' + summary + '）' : ''}`.trim();
  }

  if (stream === 'approval') {
    const prompt = data?.prompt || data?.message;
    return prompt ? t('chat.stream.approval_with', { p: String(prompt) }) : t('chat.stream.approval');
  }

  if (stream === 'error') {
    return t('chat.stream.error', { msg: data?.message || data?.text || JSON.stringify(data || {}) });
  }

  if (stream === 'attachment') {
    if (data?.phase === 'skipped') {
      const items = Array.isArray(data?.items) ? data.items : [];
      if (!items.length) return null;
      const detail = items.map((it) => {
        const nm = it?.name || '';
        const reason = it?.reason || '';
        return reason ? `${nm} — ${reason}` : nm;
      }).filter(Boolean).join('; ');
      return detail ? t('chat.stream.attachment_skipped', { items: detail }) : null;
    }
    return null;
  }

  // CLI-backed agents (claude code / codex / openclaw / opencode / hermes)
  // emit `LocalEvent`s that bus.ts wraps verbatim as `{stream:'cli', data:e}`.
  // Without this branch the catch-all below dumped them as
  // `cli {json}` which is (a) unreadable JSON and (b) lands in
  // kind-meta — exactly the "all gray" symptom users see for CLI runs.
  // Field shapes mirror `local_agents/backends/base.ts::LocalEvent`.
  if (stream === 'cli') {
    const cliType = String(data?.type || '').toLowerCase();
    if (cliType === 'tool-event') {
      const name = String(data?.tool || 'tool');
      const isResult = data?.phase === 'result';
      const phase = phaseCn(isResult ? 'end' : 'start');
      let detail = '';
      if (isResult && data?.output != null) {
        detail = typeof data.output === 'string' ? data.output : JSON.stringify(data.output);
      } else if (data?.input != null) {
        detail = typeof data.input === 'string' ? data.input : JSON.stringify(data.input);
      }
      detail = detail.replace(/\s+/g, ' ').trim();
      if (detail.length > 160) detail = detail.slice(0, 160) + '…';
      const detailStr = detail ? ' · ' + detail : '';
      return `${name}${phase ? ' · ' + phase : ''}${detailStr}`;
    }
    if (cliType === 'process-info') {
      // Fired once at CLI spawn; surface as a milestone so the user sees
      // the run starting. cmd/args is enough — full cwd is noisy.
      const cmd = String(data?.cmd || '').trim();
      return cmd || null;
    }
    if (cliType === 'status') {
      // Bucket statuses into milestone, warn and error so they pick up the
      // right kind class downstream.
      const st = String(data?.status || '').toLowerCase();
      if (!st) return null;
      // Format usage suffix when present (any status can carry it; we
      // attach it to claude's `result` status so users see token count
      // on every turn). Order: model · in/out/total · cache(read/write)
      // · cost — keeps the eye-magnets (total tokens) center-left and
      // the slow-changing model name first. Helper inlined to avoid
      // scope leakage.
      const usageSuffix = (() => {
        const u = data?.usage;
        if (!u || typeof u !== 'object') return '';
        const parts = [];
        if (typeof u.model === 'string' && u.model) parts.push(u.model);
        const tokParts = [];
        if (typeof u.input === 'number') tokParts.push('in=' + u.input);
        if (typeof u.output === 'number') tokParts.push('out=' + u.output);
        // Show total only when both halves are present, otherwise the
        // number is misleading (we don't know what's missing).
        if (typeof u.input === 'number' && typeof u.output === 'number') {
          tokParts.push('total=' + (u.input + u.output));
        }
        if (tokParts.length) parts.push(tokParts.join(' '));
        const cacheParts = [];
        // Spell out read/write explicitly; compact cache glyphs were
        // too cryptic. cache_read = hit on prior prompt
        // prefix (1/10x price); cache_write = first-time write to the
        // cache (1.25x price). Long claude turns are mostly cache_read.
        if (typeof u.cacheRead === 'number') cacheParts.push('cache_read=' + u.cacheRead);
        if (typeof u.cacheCreate === 'number') cacheParts.push('cache_write=' + u.cacheCreate);
        if (cacheParts.length) parts.push(cacheParts.join(' '));
        if (typeof u.cost === 'number') {
          // 4 decimals catches sub-cent calls; rstrip trailing zeros
          // to keep $0.5 from rendering as $0.5000.
          const cents = u.cost.toFixed(4).replace(/0+$/, '').replace(/\.$/, '');
          parts.push('$' + cents);
        }
        return parts.length ? ' · ' + parts.join(' · ') : '';
      })();
      if (st === 'usage') {
        // Streaming token-counter pulse (codex / opencode). Render as
        // a milestone-style row so the rail's last-line coalescing
        // can update it in place when the numbers advance, rather
        // than appending one row per pulse. See _renderAgentEvent
        // for the in-place update logic.
        if (!usageSuffix) return null;
        return 'tokens' + usageSuffix;
      }
      if (st === 'session_ready' || st === 'running') return st;
      if (st === 'result' || st === 'completed') return `${st}${usageSuffix}`;
      if (st === 'error' || st === 'failed' || st === 'timeout') return `${st}${usageSuffix}`;
      if (st === 'cancelled' || st === 'aborted') return st;
      return st;
    }
    if (cliType === 'stderr-line') {
      // CLIs route progress + diagnostics to stderr — treat as soft warn
      // rather than a hard error, matching the heuristic we use for
      // `command_output` stderr above.
      const line = String(data?.line || '').replace(/\s+/g, ' ').trim();
      if (!line) return null;
      const trimmed = line.length > 160 ? line.slice(0, 160) + '…' : line;
      return trimmed;
    }
    // Unknown CLI event types: hide rather than dump JSON.
    if (cliType === 'log') {
      // Structured CLI log records. claude --verbose / codex unknown
      // notifications / opencode step_finish / acp commands_update all
      // funnel here. Level decides the kind class so warn lands amber,
      // error red, debug/info gray.
      const level = String(data?.level || 'info').toLowerCase();
      const msg = String(data?.message || '').replace(/\s+/g, ' ').trim();
      if (!msg) return null;
      const trimmed = msg.length > 200 ? msg.slice(0, 200) + '…' : msg;
      return `[${level}] ${trimmed}`;
    }
    if (cliType === 'raw-line') {
      // Non-JSON stdout that the backend couldn't parse as its protocol
      // (banner, debug noise, mid-run print). Render as kind-meta so it
      // doesn't pretend to be a structured event.
      const line = String(data?.line || '').replace(/\s+/g, ' ').trim();
      if (!line) return null;
      const trimmed = line.length > 200 ? line.slice(0, 200) + '…' : line;
      return trimmed;
    }
    if (cliType === 'permission-request') {
      // Auto-approved tool-use request the CLI gated through
      // control_request. Surface as kind-info so users can audit
      // which tools the daemon allowed without prompting.
      const tool = String(data?.tool || '').trim() || 'tool';
      const decision = data?.autoDecided === 'deny' ? 'denied' : 'allowed';
      let inputSummary = '';
      if (data?.input != null) {
        const s = typeof data.input === 'string' ? data.input : JSON.stringify(data.input);
        inputSummary = s.replace(/\s+/g, ' ').trim();
        if (inputSummary.length > 120) inputSummary = inputSummary.slice(0, 120) + '…';
      }
      return `${decision}: ${tool}${inputSummary ? ' · ' + inputSummary : ''}`;
    }
    if (cliType === 'idle') {
      // Runner-emitted heartbeat on prolonged silence — kind-warn so the
      // user sees the row stand out from the regular stderr noise.
      const ms = Number(data?.stalledMs || 0);
      const secs = Math.max(1, Math.round(ms / 1000));
      return `no output for ${secs}s`;
    }
    // Unknown CLI event types: hide rather than dump JSON. Devtools archive
    // still records them verbatim under `<uid>/local/test/` for debugging.
    return null;
  }

  return `${stream} ${JSON.stringify(data || {})}`;
}

// Render a live openclaw agent event into the streaming bubble. Assistant
// text deltas update the single "live" line; everything else becomes a new
// process-pane line (via _formatEventLine).
function _renderAgentEvent(msg, evt) {
  if (!evt || typeof evt !== 'object') return;
  const { stream, data } = evt;
  if (!stream) return;

  if (stream === 'assistant') {
    const text = data?.text;
    const delta = data?.delta;
    if (typeof text === 'string' && text.length) {
      _streamingUpdateLive(msg, t('chat.stream_generating'), text);
    } else if (typeof delta === 'string' && delta.length) {
      _streamingUpdateLive(msg, t('chat.stream_generating'), (msg._liveBuf || '') + delta, true);
    }
    return;
  }

  // CLI status:'usage' pulses update the LAST '● tokens · …' row in
  // place rather than appending one row per pulse — long turns can
  // emit hundreds of these and the rail would balloon otherwise. The
  // ↓-deeper row is the canonical "running counter".
  if (stream === 'cli'
      && String(data?.type || '').toLowerCase() === 'status'
      && String(data?.status || '').toLowerCase() === 'usage') {
    const newLine = _formatEventLine(evt);
    if (!newLine) return;
    const body = msg.querySelector('[data-role="process"]');
    if (body) {
      // Find the last existing usage row by its '● tokens · ' prefix
      // and overwrite. If none exists yet, fall through to append.
      const rows = body.querySelectorAll('.stream-process-line');
      for (let i = rows.length - 1; i >= 0; i--) {
        if (rows[i].dataset.streamUsage === '1') {
          _setProcessLineContent(rows[i], newLine, 'bound');
          return;
        }
      }
    }
    _streamingAppendProgress(msg, newLine, 'bound');
    return;
  }

  const line = _formatEventLine(evt);
  if (!line) return;
  const lineKind = _eventProcessKind(evt, line);
  // All tool result rows — CLI-backed AND in-process — are
  // click-to-expand. Two storage paths for the full body, decided per
  // event shape:
  //   path present     → spilled to disk (≥50 KB); click reads via
  //                      localAgents.readToolResult IPC.
  //   output present   → live event already carries the complete body
  //                      (<50 KB); stash on the row's JS prop and the
  //                      click handler renders directly without IO.
  // Renderer-side memory cost is bounded by the in-process tool-result
  // cap (50 KB worst-case per row, swept with the bubble on conv close).
  //
  // Two event shapes flow through here:
  //   stream='cli'  + data.type='tool-event' phase='result'   (CLI backends)
  //                  → outputPath / output
  //   stream='tool' + data.phase='end'                         (in-process tools)
  //                  → result_path / output
  // Same UI affordance for both — the "symmetry is the entire point"
  // call-out in cli-richer-output plan.
  const cliResult = stream === 'cli'
      && String(data?.type || '').toLowerCase() === 'tool-event'
      && data?.phase === 'result';
  const toolResult = stream === 'tool' && data?.phase === 'end';
  if (cliResult || toolResult) {
    const path = cliResult
      ? (typeof data?.outputPath === 'string' && data.outputPath ? data.outputPath : '')
      : (typeof data?.result_path === 'string' && data.result_path ? data.result_path : '');
    const fullOutput = typeof data?.output === 'string' ? data.output : '';
    // Only offer expand when there's actually more than what the
    // preview already shows (avoids a click that reveals the same
    // text). 160 mirrors _formatEventLine's `detailStr` cap on the
    // CLI side; in-process side uses 300 (`resultPreview` default)
    // but a single shared 160 threshold is fine — anything larger
    // reads better expanded anyway.
    const truncated = path || (fullOutput && fullOutput.replace(/\s+/g, ' ').trim().length > 160);
    if (truncated) {
      _streamingAppendToolResultRow(msg, line, path, fullOutput, lineKind);
      return;
    }
  }
  _streamingAppendProgress(msg, line, lineKind);
}

/** Append a tool-event result row that can expand its full output. Two
 *  storage paths for the full body, decided at append time:
 *    - `outputPath` (string)   → runner spilled to disk; click reads via IPC.
 *    - `fullOutput` (string)   → live event body (<50KB), stash on the
 *                                 row's JS prop; click renders directly.
 *  Exactly one of the two is required — caller (_renderAgentEvent) gates.
 *
 *  Path is stored in a data attribute; the in-memory fullOutput hangs
 *  off `row._fullOutput` (raw JS prop, not dataset — dataset stringifies
 *  and would double the memory). A delegated click handler set up once
 *  per bubble does the lookup so we don't bind a closure per row.
 */
function _streamingAppendToolResultRow(msg, previewText, outputPath, fullOutput, kindHint) {
  const container = msg.querySelector('[data-role="process-container"]');
  if (container) container.style.display = '';
  const body = msg.querySelector('[data-role="process"]');
  if (!body) return;
  const innerWasAtBottom = _isNearBottom(body, 10);

  const line = document.createElement('div');
  const kind = kindHint || _processKindOf(previewText);
  line.className = 'stream-process-line is-expandable' + (kind ? ' kind-' + kind : '');
  _setProcessLineContent(line, previewText, kind);
  if (outputPath) line.dataset.toolResultPath = outputPath;
  if (fullOutput) line._fullOutput = fullOutput;
  line.title = t('chat.tool_result_expand_hint');
  body.appendChild(line);

  // One delegated handler per bubble — cheaper than binding per row.
  if (!body._toolResultClickBound) {
    body._toolResultClickBound = true;
    body.addEventListener('click', _onToolResultRowClick);
  }

  if (innerWasAtBottom) body.scrollTop = body.scrollHeight;
  _stickBottomFromMsg(msg);
}

async function _onToolResultRowClick(ev) {
  const row = ev.target.closest('.stream-process-line.is-expandable');
  if (!row) return;
  // Toggle existing expansion.
  const next = row.nextElementSibling;
  if (next && next.classList.contains('stream-process-line-full')) {
    next.remove();
    return;
  }
  const path = row.dataset.toolResultPath;
  const inline = row._fullOutput;
  const pre = document.createElement('pre');
  pre.className = 'stream-process-line-full';

  if (path) {
    // window.orkas.invoke is the canonical IPC entry (matches every
    // other feature's pattern — saved-apps / chat-artifact / workspace).
    const inv = window.orkas && window.orkas.invoke;
    if (typeof inv !== 'function') return;
    let res;
    try {
      res = await inv('localAgents.readToolResult', { path });
    } catch (err) {
      res = { ok: false, error: String(err?.message || err) };
    }
    if (res && res.ok) {
      pre.textContent = res.content + (res.truncated ? '\n\n[…truncated for display, open file for full content]' : '');
    } else {
      pre.textContent = '[failed to read: ' + (res?.error || 'unknown') + ']';
    }
  } else if (typeof inline === 'string' && inline) {
    pre.textContent = inline;
  } else {
    pre.textContent = '[no content recorded for this row]';
  }
  row.insertAdjacentElement('afterend', pre);
}

// Update or create a single "live" line in the process pane.
// Used for streaming text (assistant deltas) that grows over time.
function _streamingUpdateLive(msg, prefix, text, appendDelta) {
  // Assistant deltas are still "in progress" from the user's perspective —
  // leave the "thinking" row alone; it's cleared by _streamingSetFinal.
  const container = msg.querySelector('[data-role="process-container"]');
  if (container) container.style.display = '';
  const body = msg.querySelector('[data-role="process"]');
  if (!body) return;

  // Decide auto-scroll BEFORE mutating the live row — text growth changes
  // scrollHeight and would otherwise misread "near bottom" as false even
  // when the user was tracking the latest output. 10 px tolerance treats
  // any manual scroll-up as "user wants to read older entries".
  const innerWasAtBottom = _isNearBottom(body, 10);
  let line = body.querySelector('.stream-process-live');
  if (!line) {
    line = document.createElement('div');
    line.className = 'stream-process-line stream-process-live kind-live';
    body.appendChild(line);
    msg._liveBuf = '';
  }
  if (appendDelta) msg._liveBuf = text; // already concatenated outside
  else msg._liveBuf = text;
  // Show last ~200 chars to keep the row compact
  const preview = msg._liveBuf.length > 200 ? '…' + msg._liveBuf.slice(-200) : msg._liveBuf;
  _setProcessLineContent(line, prefix + preview, 'live');
  if (innerWasAtBottom) body.scrollTop = body.scrollHeight;
  _stickBottomFromMsg(msg);
}

// Update the loading element (wherever it currently lives in DOM) with the reply.
function _resolveConvReply(cid, text, isError) {
  const state = pendingConvs.get(cid);
  pendingConvs.delete(cid);
  setGroupConversationBusy(cid, false);
  stopPolling(cid);
  _updateConvSidebarBadge(cid, false);

  const el = state?.loadingEl;
  if (el && el.isConnected) {
    el.querySelector('.chat-bubble').innerHTML = isError
      ? `<span style="color:var(--danger)">${escapeHtml(t('chat.send_failed', { msg: text }))}</span>`
      : `<div class="markdown-body">${renderMarkdown(text)}</div>`;
    const metaTime = el.querySelector('.chat-meta-time');
    if (metaTime) metaTime.textContent = formatTime(new Date().toISOString());
    if (!isError) {
      _attachBubbleArchiveBtn(el, () => text);
      if (typeof typesetMath === 'function') {
        const md = el.querySelector('.chat-bubble .markdown-body');
        if (md) typesetMath(md);
      }
    }
    el.scrollIntoView({ behavior: 'smooth', block: 'end' });
  } else if (cid === currentCid) {
    // loadingEl was replaced (user navigated away and back); reload history to show result
    loadConversationHistory(cid);
  }

  if (cid === currentCid) _updateConvSendUI(cid);
}

// Toggle send/stop button appearance. While a reply is streaming the button
// shows the stop icon and a click aborts — regardless of the queue. New
// messages typed in during the stream go to the queue via Enter / Cmd+Enter.
function _updateConvSendUI(cid) {
  if (cid !== currentCid) return;
  const sendBtn = document.getElementById('chat-send-btn');
  const input = document.getElementById('chat-input');
  if (!sendBtn) return;
  const pending = isConvPending(cid);
  // While `.aborting` is set, pin the button as send-style + disabled. The
  // class self-clears once the stream truly terminates (pending flips false).
  if (sendBtn.classList.contains('aborting')) {
    if (pending) return;
    sendBtn.classList.remove('aborting');
  }
  // Conv-bound agent disabled → input + send button locked. Backend also
  // refuses the send (defense-in-depth), but we lock the UI so the user
  // can't even queue a message that's guaranteed to fail.
  const agentEnabled = convAgentEnabledByCid.get(cid) !== false;
  if (!agentEnabled) {
    sendBtn.classList.remove('streaming');
    sendBtn.disabled = true;
    sendBtn.title = t('component.send_blocked_disabled');
    if (input) {
      input.disabled = true;
      input.placeholder = t('component.send_blocked_disabled');
    }
    return;
  }
  if (input) input.disabled = false;
  sendBtn.classList.toggle('streaming', pending);
  sendBtn.disabled = false;
  sendBtn.title = pending ? t('chat.stop_reply') : t('chat.send_title');
  if (input) {
    input.placeholder = pending ? t('chat.input_placeholder_queue') : t('chat.input_placeholder');
  }
  if (!pending) input?.focus();
}

/** Show / hide a banner above the chat input warning the user that the
 *  bound agent is disabled. Idempotent — can be called on every history load. */
function _renderConvDisabledBanner(cid) {
  const wrap = document.querySelector('#panel-conversation .chat-input-wrapper');
  if (!wrap) return;
  const existing = wrap.querySelector('.detail-disabled-banner');
  const enabled = convAgentEnabledByCid.get(cid) !== false;
  if (enabled) {
    if (existing) existing.remove();
    return;
  }
  if (!existing) {
    const banner = document.createElement('div');
    banner.className = 'detail-disabled-banner';
    banner.textContent = t('component.conv_agent_disabled_banner');
    wrap.insertBefore(banner, wrap.firstChild);
  }
  // Always re-call _updateConvSendUI so the input lock is in sync with the banner.
  if (cid === currentCid) _updateConvSendUI(cid);
}

function abortConvStream(cid) {
  const state = pendingConvs.get(cid);
  setGroupConversationBusy(cid, false);
  // Group chat: also tell the bus to abort all in-flight worker turns + clear
  // queues. Cancelling just the IPC stream would leave agents running in the
  // background. Fire-and-forget — no need to block the UI on the response.
  try { apiFetch(`/api/conversations/${cid}/abort`, { method: 'POST' }); } catch (_) {}
  if (!state) {
    _updateConvSidebarBadge(cid, false);
    if (cid === currentCid) _updateConvSendUI(cid);
    return;
  }
  // No-controller case: the pendingConvs entry was minted by
  // `loadConversationHistory`'s polling-rescue branch (user opened a conv
  // whose worker was started from outside this renderer — scheduled-task
  // fire, or a refresh mid-turn). There's no in-process stream to cancel;
  // the bus.abort POST above does the actual work. Clear the placeholder
  // and the pending entry so the send button flips back to "send" and the
  // sidebar badge drops. Without this, the button stayed pinned as "stop"
  // and re-clicks were no-ops.
  if (!state.controller) {
    pendingConvs.delete(cid);
    stopPolling(cid);
    if (state.loadingEl && state.loadingEl.isConnected) state.loadingEl.remove();
    _updateConvSidebarBadge(cid, false);
    if (cid === currentCid) _updateConvSendUI(cid);
    return;
  }
  state.aborted = true;
  try { state.controller.abort(); } catch (_) {}
  // Repaint the sidebar badge now — `_updateConvSidebarBadge` reads
  // `state.aborted` and drops the streaming indicator immediately, rather
  // than waiting for _finishStreamingMsg (which runs only when main emits
  // `done`, often seconds later).
  _updateConvSidebarBadge(cid, false);
  if (cid === currentCid) {
    const btn = document.getElementById('chat-send-btn');
    if (btn) {
      btn.classList.remove('streaming');
      btn.classList.add('aborting');
      btn.disabled = true;
    }
  }
}

// Paint a prominent status badge on the sidebar conversation item that
// reflects *both* streaming state and queued-but-unsent messages. The second
// arg is ignored (kept for call-site compatibility) — state is computed from
// pendingConvs / messageQueues directly so callers don't have to stay in sync.
function _updateConvSidebarBadge(cid, _unused) {
  const item = document.querySelector(`.conv-item[data-cid="${cid}"]`);
  if (!item) return;
  item.querySelector('.conv-status-badge')?.remove();
  // Treat aborted-but-still-draining as not streaming. `pendingConvs` only
  // clears when main emits `done`, which can trail the stop click; until then
  // the bubble already shows the "stopped" state so the streaming badge would lie.
  const state = pendingConvs.get(cid);
  const pending = isConvPending(cid) && !(state && state.aborted);
  // Use _getQueue so a queue persisted in localStorage is picked up even if
  // the conversation hasn't been opened in this session yet.
  const queued = _getQueue(cid).length;
  if (!pending && !queued) return;

  const badge = document.createElement('span');
  badge.className = 'conv-status-badge';
  if (pending) badge.classList.add('is-streaming');
  else badge.classList.add('is-queued');

  let html = '';
  if (pending) {
    html += '<span class="conv-status-dot"></span>';
    // html += '<span class="conv-status-text">replying</span>';
    if (queued > 0) html += `<span class="conv-status-count">+${queued}</span>`;
  } else {
    html += `<span class="conv-status-text">${escapeHtml(t('chat.status.pending_short'))}</span>`;
    html += `<span class="conv-status-count">${queued}</span>`;
  }
  badge.innerHTML = html;
  item.prepend(badge);
}

// Repaint badges on every visible conversation item. Called after re-render
// of the sidebar list so previously-known pending/queued state is reapplied.
function _refreshAllConvBadges() {
  document.querySelectorAll('.conv-item').forEach(el => {
    const cid = el.dataset.cid;
    if (cid) _updateConvSidebarBadge(cid);
  });
}
