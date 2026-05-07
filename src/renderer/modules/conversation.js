const _convLog = createLogger('conversation');

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
// The new-chat ("指挥官") landing resets to commander only when its input
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
      nameEl.textContent = (typeof t === 'function') ? t('chat.recipient_commander') : '指挥官';
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
}
function onEnterConversationView() {
  _renderRecipientChip('conversation');
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
}

// Called by queue-draft.js::_forgetConvLocal when a conv is deleted so we
// don't accumulate dead entries in localStorage forever.
function _forgetCidRecipient(cid) {
  if (!cid || !_recipientByCid[cid]) return;
  delete _recipientByCid[cid];
  _saveRecipientMap();
  _latestInFlight.delete(cid);
  _lastInteractiveTurnAgent.delete(cid);
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
  return tag + ' ' + text;
}

if (typeof window !== 'undefined') {
  const initChip = () => _renderRecipientChip();
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initChip, { once: true });
  } else {
    initChip();
  }
  window.addEventListener('i18n-change', () => _renderRecipientChip());
}

// ─── Group-chat translation layer ─────────────────────────────────────────
// Backend now stores GroupMessage{ id, ts, from, to, mentions?, text, ... }.
// Renderer's existing bubble code expects MessageRecord{ role, content, time }.
// Translate at read/stream boundary so we don't have to rewrite every render
// path. `from === 'user'` → role=user; otherwise role=assistant with a
// "from-name" label rendered as a header chip on the bubble.
const GROUP_RESERVED = new Set(['user', 'commander']);

// 指挥官头像偏好，懒加载缓存。聊天行渲染要用到 —— 第一次渲染前发一次 IPC，
// 之后任何更新都同步刷这里。`null` = 未加载 / 取不到，渲染层自己回退到默认。
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
  } catch (_) { /* 走默认 */ }
  return _commanderAvatarCache || COMMANDER_DEFAULT;
}
function setCommanderAvatarCache(avatar) {
  if (avatar && avatar.icon && avatar.color) {
    _commanderAvatarCache = { icon: avatar.icon, color: avatar.color };
  }
}
/** 渲染消息行头像。fromId 已知非 'user'。 */
function _renderActorAvatarHtml(fromId) {
  if (fromId === 'commander') {
    const a = _commanderAvatar();
    return renderAvatarHtml(a.icon, a.color, { size: 28, seed: 'commander' });
  }
  // 全局 agents registry 优先 —— 它始终是当前真相;群成员缓存只是入会时
  // 的快照,改名 / 改头像后不会跟着动,作为兜底覆盖"agent 已被删除、
  // registry 查不到"的旧会话场景。
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
  if (fromId === 'commander') return t('chat.from_commander') || '指挥官';
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
  return t('chat.from_agent_unknown') || '智能体';
}
const _groupMembersCache = new Map(); // cid → Actor[]
async function _refreshGroupMembers(cid) {
  if (!cid) return [];
  try {
    const res = await apiFetch(`/api/conversations/${cid}/members`);
    const data = await res.json();
    if (data?.ok && Array.isArray(data.actors)) {
      _groupMembersCache.set(cid, data.actors);
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
    ...(gm.created_agent ? { created_agent: gm.created_agent } : {}),
    ...(gm.plan_announcement ? { _plan_announcement: true } : {}),
    ...(Array.isArray(gm.process) && gm.process.length ? { process: gm.process } : {}),
  };
  return out;
}

// ─── Chat attachments (pending-send pool per cid) ─────────────────────────
// User picks files via "+" → we upload them to `<cid>/` and remember them in
// this Map. On send we hand the filenames to the server; on success the list
// for that cid is cleared (消息粒度). Each entry is {name, kind, bytes, dataUrl?}.

const _chatAttachments = new Map();   // cid → Array<{name, kind, bytes, dataUrl?}>

// Draft cid used by 总指挥 (new-chat) tab — files land under
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
}

function _chatAttachClear(cid) {
  _chatAttachments.delete(cid);
  _chatAttachRenderChips(cid);
}

// cid → DOM host id for the chip row. Draft cid (总指挥) renders into the
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
      ? (it.dataUrl ? `<img class="chat-attach-thumb" src="${it.dataUrl}" alt="">` : '🖼')
      : it.kind === 'video'
      ? '🎬'
      : it.kind === 'pdf' ? '📄'
      : it.kind === 'docx' ? '📝'
      : '📃';
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
    const icon = kind === 'pdf' ? '📄'
               : kind === 'docx' ? '📝'
               : kind === 'image' ? '🖼'
               : kind === 'video' ? '🎬'
               : '📃';
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
// Chips use the same visual language as attachments; clicking invokes
// `workspace.revealPath` which calls shell.showItemInFolder in main.

function _iconForProduced(name) {
  const ext = (name.split('.').pop() || '').toLowerCase();
  if (ext === 'pdf') return '📄';
  if (ext === 'docx' || ext === 'doc') return '📝';
  if (['png', 'jpg', 'jpeg', 'webp', 'gif', 'svg', 'bmp', 'ico'].includes(ext)) return '🖼';
  if (['mp4', 'webm', 'mov', 'm4v', 'ogv', 'avi', 'mkv'].includes(ext)) return '🎬';
  if (['mp3', 'wav', 'ogg', 'flac', 'm4a', 'aac'].includes(ext)) return '🎵';
  if (['md', 'markdown', 'txt', 'log', 'rst', 'tex'].includes(ext)) return '📃';
  if (['json', 'yaml', 'yml', 'toml', 'csv', 'tsv', 'xlsx', 'xls', 'xml', 'ini', 'conf'].includes(ext)) return '📊';
  if (['zip', 'tar', 'gz', 'tgz', 'bz2', 'xz', '7z', 'rar'].includes(ext)) return '📦';
  // Source code / scripts — covers .py / .ts / web / shell / mainstream langs.
  // Anything else falls through to the generic "file" icon below.
  if ([
    'py', 'pyi', 'ipynb',
    'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs',
    'html', 'htm', 'css', 'scss', 'sass', 'less',
    'sh', 'bash', 'zsh', 'fish', 'ps1', 'bat', 'cmd',
    'rb', 'go', 'rs', 'java', 'kt', 'kts', 'scala',
    'c', 'cpp', 'cc', 'cxx', 'h', 'hpp', 'hxx',
    'php', 'swift', 'lua', 'pl', 'pm', 'r', 'dart',
    'sql', 'graphql', 'gql', 'proto',
  ].includes(ext)) return '📜';
  return '📄';
}

function _renderMessageProducedHtml(absPaths) {
  // Chip shows just the filename. The full absolute path lives only in
  // `data-produced-path` for the click handler; tooltip is a static
  // localised "在文件夹中显示" hint instead of the raw OS path (which
  // exposes the user's home dir and is hostile UX in Chinese mixed-case).
  const hint = t('chat.produced_reveal_title') || '在文件夹中显示';
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

// Render a "查看详情" chip on an assistant bubble when a new agent was
// quick-created from that turn. Click → jump to agents tab + select the new
// agent. Same visual slot as produced chips (inside the bubble, below
// content), but in .is-custom green to signal "new custom artifact created".
function _renderMessageCreatedAgentHtml(payload) {
  if (!payload || !payload.agent_id) return '';
  const name = payload.name || payload.agent_id;
  // Label is intentionally neutral ("查看详情 / Open: …") — works for both
  // `kind: 'created'` and `kind: 'updated'`; the commander's surrounding
  // prose tells the user which one happened. Don't split the i18n key just
  // to track the verb — the chip is a CTA into the agent panel, not a
  // status badge.
  return `<div class="chat-msg-created-agent">
    <span class="chat-msg-created-agent-chip" data-agent-id="${escapeHtml(payload.agent_id)}" title="${escapeHtml(name)}">
      <span class="chat-msg-created-agent-icon">◆</span>
      <span class="chat-msg-created-agent-label">${escapeHtml(t('chat.created_agent_chip', { name }))}</span>
    </span>
  </div>`;
}

function _hydrateMessageCreatedAgentChip(msgDiv) {
  const chip = msgDiv.querySelector('.chat-msg-created-agent-chip');
  if (!chip) return;
  chip.addEventListener('click', () => {
    const aid = chip.dataset.agentId;
    if (!aid) return;
    setView('agents');
    if (typeof _showAgentsDetailView === 'function') _showAgentsDetailView(aid);
    else if (typeof selectAgent === 'function') selectAgent(aid);
  });
}

function _hydrateMessageProducedChips(msgDiv) {
  const chips = msgDiv.querySelectorAll('.chat-msg-produced-item');
  chips.forEach((chip) => {
    chip.addEventListener('click', async (e) => {
      e.stopPropagation();
      const p = chip.dataset.producedPath;
      if (!p) return;
      // Opens the OS file manager focused on the file (Finder on macOS,
      // Explorer on Windows). The main-process handler validates the
      // path is inside the active workspace and refuses outside paths.
      try {
        const res = await window.orkas.invoke('workspace.revealPath', { path: p });
        if (!res || !res.ok) {
          _convLog.warn('reveal failed', { path: p, error: res && res.error });
        }
      } catch (err) {
        _convLog.warn('reveal threw', { path: p, error: String(err && err.message || err) });
      }
    });
  });
}

function _hydrateMessageAttachmentThumbs(msgDiv, _cid) {
  // Wire click-to-enlarge on image chips. Image bytes are served by the
  // `chat-media://` protocol directly (no IPC fetch here). If the underlying
  // file was deleted, the <img> will fail silently and the chip shows the
  // broken-image placeholder — not worth hiding, the user chose to delete it.
  const images = msgDiv.querySelectorAll('.chat-msg-attach.is-image');
  images.forEach((chip) => {
    const img = chip.querySelector('img.chat-msg-attach-thumb');
    if (!img) return;
    chip.addEventListener('click', (e) => {
      e.stopPropagation();
      if (typeof openChatImageLightbox === 'function') {
        openChatImageLightbox(img.src, chip.dataset.attachName || '');
      }
    });
  });
}

// Wire `paste` on a textarea to the same upload pipeline as the "+" button.
// Triggers when the clipboard contains any File entries — screenshots from
// the OS clipboard (Cmd/Ctrl+Shift+screenshot) and files copied from Finder
// / Explorer both land in `clipboardData.files`. Plain-text pastes have an
// empty FileList and fall through to the textarea's native paste handler.
function _bindChatPasteAttach(inputElId, getCid) {
  const el = document.getElementById(inputElId);
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
  _bindChatPasteAttach('chat-input', () => currentCid);
  btn.dataset.bound = '1';
}

// 总指挥 (new-chat) tab 的 "+" 按钮走同一套上传链路，只是传 DRAFT_CID 而不
// 是某个会话的 cid。用户点发送后 handleNewChatSubmit 会调 adopt 把整个
// `main_chat/` 目录改名成新会话的 cid，预处理缓存原地跟随无需重跑。

function _initNewChatAttachInput() {
  const btn = document.getElementById('new-chat-attach-btn');
  const input = document.getElementById('new-chat-attach-input');
  if (!btn || !input || btn.dataset.bound === '1') return;
  btn.addEventListener('click', () => input.click());
  input.addEventListener('change', async () => {
    await _chatAttachUpload(DRAFT_CID, input.files);
    input.value = '';
  });
  _bindChatPasteAttach('new-chat-input', () => DRAFT_CID);
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
  if (!conversations.length) {
    container.innerHTML = `<div class="conv-empty" data-i18n="sidebar.conv_empty">${escapeHtml(t('sidebar.conv_empty'))}</div>`;
    return;
  }
  const delTitle = escapeHtml(t('chat.conv_del_title'));
  container.innerHTML = conversations.map(c => {
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

  // Reapply pending / queued status badges after the DOM was re-rendered.
  _refreshAllConvBadges();
}

// ─── Conversation history render ───

// Inline "创建智能体" entry that lives at the very end of the conversation
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
  // 一旦有非 commander/user 的 agent 进入对话就隐藏入口 —— 多 agent 流里
  // "沉淀单一 agent" 的语义已不成立。两路证据都算：
  //   1) 群成员名册里出现 kind==='agent'（最权威：包含被 @ 但还没回话的）；
  //   2) DOM 里出现过 _from / fromActor 既非空也非 commander/user 的发言
  //      （兜底：成员缓存还没拉到时也能触发）。
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
    // "智能体" placeholders on first paint and repaint on refresh, ugly.
    await _refreshGroupMembers(cid);
    // Conversation switch: drop any stale per-actor placeholders from a
    // previous conv so they don't leak into this view (their DOM nodes
    // are also gone since we're about to clear chat-history below).
    for (const k of Array.from(_groupPlaceholders.keys())) {
      if (k.startsWith(`${cid}:`)) continue; // keep this cid's; clear others
      _groupPlaceholders.delete(k);
    }
    // Drop internal plan-step dispatch messages (commander → agent
    // hand-off). The user already saw the plan announcement; surfacing
    // these adds noise like "@需求挖掘师 我要开发一个应用" in the user's view.
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
    // Only show the "思考中…" bubble if the server *really* still has this
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
    if (lastMsg?.role === 'user' && !isConvPending(cid) && processingFresh) {
      pollMsgCounts.set(cid, history.length);
      const loadingEl = appendChatMessage({
        role: 'assistant',
        content: `<span class="chat-replying">${escapeHtml(t('chat.thinking'))}</span>`,
        time: nowIsoLocal(),
      });
      pendingConvs.set(cid, { loadingEl, needsIndicator: false });
      _updateConvSendUI(cid);
      _updateConvSidebarBadge(cid, true);
      startPolling(cid);
    } else if (isConvPending(cid)) {
      // User navigated away and back during an in-flight request. The stream
      // reader loop in createChatController.send() holds the original msgEl
      // in closure and keeps dispatching deltas/final to that *specific* node
      // — so we must re-attach the original node, not mint a fresh bubble.
      // Minting a new one here (as before) stranded the stream: events kept
      // landing on the orphaned node and the new bubble stayed at "思考中…"
      // until stream end / polling rescue.
      const state = pendingConvs.get(cid);
      pollMsgCounts.set(cid, history.length);
      if (state.loadingEl) {
        const emptyEl = container.querySelector('.empty');
        if (emptyEl) emptyEl.remove();
        _appendBeforeSpacer(container, state.loadingEl);
      } else {
        const loadingEl = appendChatMessage({
          role: 'assistant',
          content: `<span class="chat-replying">${escapeHtml(t('chat.thinking'))}</span>`,
          time: nowIsoLocal(),
        });
        state.loadingEl = loadingEl;
      }
      state.needsIndicator = false;
      startPolling(cid); // ensure polling is running as backup
    }

    // Re-add the inline "创建智能体" entry BEFORE scrolling so it's part of
    // scrollHeight when we jump to the bottom — otherwise the MutationObserver
    // adds it post-scroll and it ends up below the visible area.
    _ensureConvCreateAgentInline();
    _scrollToBottomNoAnim(container);
  } catch (e) {
    container.innerHTML = `<div class="empty">${escapeHtml(t('chat.load_failed', { msg: e.message || '' }))}</div>`;
  }
}

// Jump to bottom without smooth animation. Use when opening a conversation —
// the last message should appear immediately, no scrolling effect.
function _scrollToBottomNoAnim(container) {
  if (!container) return;
  const prev = container.style.scrollBehavior;
  container.style.scrollBehavior = 'auto';
  container.scrollTop = container.scrollHeight;
  requestAnimationFrame(() => {
    container.style.scrollBehavior = prev || '';
  });
}

function appendChatMessage(message, autoScroll = true, opts = {}) {
  const container = opts.container
    ? (typeof opts.container === 'string' ? document.getElementById(opts.container) : opts.container)
    : document.getElementById('chat-history');
  if (!container) return null;
  const archive = opts.archive !== false;   // default on for backwards compat

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
  // stored raw text. Assistant messages get the defensive agent-block
  // strip in case the backend's extractor missed a format variant (see
  // `_stripSurvivingAgentBlocks`).
  let displayContent = rawContent;
  if (!isHtmlSnippet) {
    if (role === 'user') displayContent = _stripSubmissionTagForDisplay(rawContent);
    else if (role === 'assistant') displayContent = _stripSurvivingAgentBlocks(rawContent);
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
  const createdAgentHtml = (role === 'assistant' && message.created_agent)
    ? _renderMessageCreatedAgentHtml(message.created_agent)
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
      || (t('chat.from_agent_unknown') || '智能体');
  const avatarHtml = role === 'user' ? '' : _renderActorAvatarHtml(message._from);
  const headerHtml = role === 'user'
    ? `<div class="chat-msg-header chat-msg-header-user"><span class="chat-msg-time">${formatTime(message.time || new Date().toISOString())}</span></div>`
    : `<div class="chat-msg-header">${avatarHtml}<span class="chat-msg-from">${escapeHtml(headerName)}</span><span class="chat-msg-time">${formatTime(message.time || new Date().toISOString())}</span></div>`;
  const planAnnHtml = message._plan_announcement
    ? `<div class="chat-plan-announce">📋 ${escapeHtml(t('chat.plan_announce') || '执行计划')}</div>` : '';
  // Below-bubble action row holds produced-file chips + created-agent chip
  // + archive button (the legacy `.chat-meta` slot). Lives OUTSIDE the
  // bubble so chips read as a footer, not as inline body content.
  msgDiv.innerHTML = `
    ${headerHtml}
    <div class="chat-bubble">${planAnnHtml}${contentHtml}${attachmentsHtml}</div>
    <div class="chat-msg-actions" data-role="msg-actions">${producedHtml}${createdAgentHtml}</div>
  `;
  if (typeof opts.msgIndex === 'number') msgDiv.dataset.msgIndex = String(opts.msgIndex);
  if (message._msg_id) msgDiv.dataset.msgId = String(message._msg_id);
  if (message._from) msgDiv.dataset.fromActor = String(message._from);
  msgDiv.dataset.ts = String(_msTs(message.time));
  _insertByTimestamp(container, msgDiv);
  if (!isHtmlSnippet && typeof typesetMath === 'function') {
    const md = msgDiv.querySelector('.markdown-body');
    if (md) typesetMath(md);
  }
  if (attachmentsHtml) _hydrateMessageAttachmentThumbs(msgDiv, opts.cid || currentCid);
  if (producedHtml) _hydrateMessageProducedChips(msgDiv);
  if (createdAgentHtml) _hydrateMessageCreatedAgentChip(msgDiv);
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
  // Archive button + persisted-process block only make sense for finalised
  // assistant replies (raw markdown, not an HTML placeholder like "思考中...").
  if (role === 'assistant' && !isHtmlSnippet) {
    if (archive) _attachBubbleArchiveBtn(msgDiv, () => rawContent);
    if (Array.isArray(message.process) && message.process.length) {
      // Auto-expand when the body is just an abort placeholder: the process
      // trail IS the content the user already saw, hiding it behind a fold
      // makes refresh look like "everything I watched stream is gone".
      const bodyText = String(displayContent || '').trim();
      const isAbortStub = bodyText === '（已中断）' || bodyText === '';
      _renderPersistedProcess(msgDiv, message.process, { expanded: isAbortStub });
    }
  }

  if (autoScroll) container.scrollTop = container.scrollHeight;
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

// Insert a "过程信息" block above the assistant bubble content using the
// items we stored at stream time. Collapsed by default so old threads
// stay tidy; user can click ▶ to expand. Exception: when the bubble's
// text body has no real reply (only "（已中断）" / empty abort placeholder
// for a turn that never produced final text), the process trail IS the
// content — auto-open it so refreshing doesn't appear to erase what the
// user already watched stream in (tool calls / progress lines).
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
    const kind = _processKindOf(text);
    line.className = 'stream-process-line' + (kind ? ' kind-' + kind : '');
    line.textContent = text;
    body.appendChild(line);
  }
  if (body.childElementCount === 0) return;  // nothing renderable
  bubble.insertBefore(details, bubble.firstChild);
}

// Attach a small "存档" button next to the time in the chat-meta row. Kept
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
  `;
  const btn = actions.querySelector('.bubble-archive-btn');
  const copyBtn = actions.querySelector('.bubble-copy-btn');
  copyBtn.addEventListener('click', async (e) => {
    e.stopPropagation();
    const text = typeof getContent === 'function' ? (getContent() || '') : '';
    if (!text.trim() || copyBtn.disabled) return;
    copyBtn.disabled = true;
    const orig = copyBtn.textContent;
    try {
      await navigator.clipboard.writeText(text);
      copyBtn.textContent = t('chat.copy_done');
    } catch (err) {
      copyBtn.textContent = t('chat.copy_failed');
    }
    setTimeout(() => { copyBtn.textContent = orig; copyBtn.disabled = false; }, 1500);
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
    const orig = btn.textContent;
    try {
      const res = await apiFetch('/api/contexts/write', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: pick.path, content: text }),
      });
      const data = await res.json();
      if (data.ok) {
        btn.textContent = t('chat.archive_done');
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
    setTimeout(() => { btn.textContent = orig; btn.disabled = false; }, 2000);
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
    const res = await apiFetch('/api/conversations/create', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind: 'normal' }),
    });
    const data = await res.json();
    if (!data.ok) throw new Error(data.error || t('chat.create_conv_failed'));
    const conv = data.conversation;
    convId = conv.conversation_id;
    // Optimistic title from the user-visible text (raw, not the transformed form)
    const optimistic = raw.replace(/\s+/g, ' ').trim();
    conv.title = optimistic.length > 40 ? optimistic.slice(0, 40) + '…' : optimistic;
    conversations.unshift(conv);
    renderConversationList();
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
  if (!raw || !currentCid) return;
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
  if (isConvPending(cid) || (messageQueues.get(cid) || []).length) {
    if (attachments.length) {
      await uiAlert(t('chat.attach_queue_blocked'));
      return;
    }
    enqueueMessage(cid, raw, skill);
    input.value = '';
    autoGrow(input, 200);
    _clearDraft(cid);
    return;
  }

  const content = applyRecipientPrefix(transformWithSkill(raw, skill), 'conversation');
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
        _finishStreamingMsg(id);
        _setChatScrollOffset(false);
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
  // 只补足"让最后一条 user 消息能滚到顶部"所需的高度——视口高度减去
  // (user 消息及其下方已有兄弟节点)。一律给一整屏会在回复尚短时留下
  // 大片空白；这里精算所需余量，回复短时就只剩一点点空白。-24 与
  // _scrollToMessageTop 的偏移对齐，给 floating 删除按钮留出位置。
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

function _createStreamingAssistantMessage(container) {
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
  // agent depending on resolution; hard-coding "指挥官" misled the user
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

// Map the leading glyph of a formatted line to a semantic CSS class so the
// stylesheet can tone errors red, approvals amber, etc.
function _processKindOf(text) {
  const g = (text || '').trimStart().charAt(0);
  if (g === '◯') return 'err';
  if (g === '○') return 'warn';
  if (g === '◉') return 'patch';
  if (g === '■') return 'tool';
  if (g === '▷') return 'out';
  if (g === '◆' || g === '◇') return 'think';
  if (g === '▶' || g === '●') return 'bound';
  return '';
}

function _streamingAppendProgress(msg, text) {
  // Keep the "思考中…" row visible alongside the process trace — hiding it
  // while only process info shows makes long tool runs look stuck. The row
  // is cleared when the final reply (or an error) arrives.
  const container = msg.querySelector('[data-role="process-container"]');
  if (container) container.style.display = '';
  const body = msg.querySelector('[data-role="process"]');
  if (!body) return;
  const line = document.createElement('div');
  const kind = _processKindOf(text);
  line.className = 'stream-process-line' + (kind ? ' kind-' + kind : '');
  line.textContent = text;
  body.appendChild(line);
  // Auto-scroll only within the process area
  body.scrollTop = body.scrollHeight;
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
// to attach the 存档 button afterwards (not all scenes want it — skill and
// agent edit chats skip it by design).
function _streamingSetFinal(msg, text, { archive = false } = {}) {
  _hideThinking(msg);
  const finalEl = msg.querySelector('[data-role="final"]');
  if (!finalEl) return;
  _cancelPendingStreamRaf(msg);
  // Always repaint on final: during streaming the DOM may contain
  // placeholder markers (from `_stripAgentCreateBlocksForStream` etc.)
  // that need to be replaced with the backend-cleaned prose. A previous
  // flash-prevention "skip repaint if buf === text" optimisation made
  // placeholders stick when the stream buffer was not exactly equal to
  // the final text for reasons unrelated to cleanliness — the safer
  // default is to always paint the final text (same DOM node, minor
  // reflow, no visible flash in practice).
  const display = _stripSurvivingAgentBlocks(text);
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

  // Auto-collapse the process section so the finalised reply reads cleanly；
  // 但若整轮流式从未产生过 progress 行（比如模型直接一句回答，无推理 / 工具调
  // 用），保留起始的 display:none，不在气泡里显示空的「过程信息」起泡。
  // **例外**：如果 final body 只是 "（已中断）" 这种无实质内容的中断占位符，
  // 过程信息就是用户实际看到的全部输出——保持展开，否则 finalize 后视觉上
  // 等同于"流式时看的过程都没了"（用户原话），刷新更看不到。
  const details = msg.querySelector('.stream-process');
  if (details) {
    const body = details.querySelector('.stream-process-body');
    const hasProcess = !!body && body.children.length > 0;
    const bodyText = String(display || '').trim();
    const isAbortStub = bodyText === '（已中断）' || bodyText === '';
    if (hasProcess && isAbortStub) {
      details.open = true;
      details.style.display = '';
    } else if (hasProcess) {
      details.removeAttribute('open');
      details.style.display = '';
    } else {
      details.removeAttribute('open');
      // else: 保留 display:none（_createStreamingAssistantMessage 的初始值）
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
  // 出错时也要保留已累积的过程信息：若 body 非空就显示（与 _streamingSetFinal /
  // _streamingMarkAborted 一致），不再等用户重进对话才从持久化 message.process
  // 补画出来。
  const details = msg.querySelector('.stream-process');
  if (details) {
    const body = details.querySelector('.stream-process-body');
    const hasProcess = !!body && body.children.length > 0;
    if (hasProcess) details.style.display = '';
  }
  const finalEl = msg.querySelector('[data-role="final"]');
  if (!finalEl) return;
  finalEl.innerHTML = `<span style="color:var(--danger)">${escapeHtml(t('chat.send_failed', { msg: text }))}</span>`;
  finalEl.style.display = '';
}

// Mark the assistant bubble as user-interrupted. Preserves whatever partial
// content streamed into the process pane; just stamps a "已中断" note.
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
  stopPolling(cid);
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
  // Instant scroll to avoid the animation getting clobbered by streaming DOM
  // mutations that land during the send. Use rAF twice to make sure layout
  // has settled (style recalc after appendChild, then paint).
  requestAnimationFrame(() => requestAnimationFrame(() => {
    const containerRect = container.getBoundingClientRect();
    const msgRect = msgEl.getBoundingClientRect();
    // 仅预留能让 floating 删除按钮（top:20px + ~33px 高）不贴住消息的最小
    // 间距；留白太大时容易看到上一条消息产生干扰。24px = 贴着删除按钮底沿。
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
//     archive:    bool  // attach 存档 button on final
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

    const msgEl = _createStreamingAssistantMessage(historyEl);
    if (hooks.onAssistantStart) hooks.onAssistantStart(msgEl, id);

    // 发送时把用户消息顶到可视区顶部就行；流式过程中和结束后都不要再主动
    // 滚动，否则会把用户中途上滑查看的位置强行拽回初始位置。
    // 配合 `has-scroll-offset` 预留 100vh 底部空间，保证短消息也能滚到顶部；
    // 由 controller 统一负责开关，避免各 scene 各自抄一份。
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
            // its buffer — drop them so the bubble stays frozen at "已中断"
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
      // 不再在流式结束时 re-pin — 尊重用户中途上滑后的阅读位置。
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
    // (called from the catch block) runs late and the "思考中…" row stays
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
    // Created-agent chip also arrives on the final event payload — attach
    // here in case the relay event was missed (e.g. on reconnect / replay).
    if (ev.created_agent && ev.created_agent.agent_id) {
      _mountCreatedAgentChip(msg, ev.created_agent);
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

function _setPlaceholderActor(ph, actorId) {
  if (!ph) return;
  ph.dataset.fromActor = actorId || '';
  const chip = ph.querySelector('[data-role="from-chip"]');
  if (chip && !chip.textContent) {
    const label = actorId === 'commander'
      ? (t('chat.from_commander') || '指挥官')
      : (_groupActorLabel(actorId) || (t('chat.from_agent_unknown') || '智能体'));
    chip.textContent = label;
  }
  const avatarSlot = ph.querySelector('[data-role="from-avatar"]');
  if (avatarSlot && !avatarSlot.firstChild && actorId) {
    avatarSlot.innerHTML = _renderActorAvatarHtml(actorId);
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
    _setPlaceholderActor(fallbackPh, actorId);
    _groupPlaceholders.set(k, fallbackPh);
    return fallbackPh;
  }
  const container = document.getElementById('chat-history');
  if (!container) return null;
  ph = _createStreamingAssistantMessage(container);
  _setPlaceholderActor(ph, actorId);
  _groupPlaceholders.set(k, ph);
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
  _setPlaceholderActor(ph, gm.from);

  // Plan-announcement label (commander first plan_set).
  if (gm.plan_announcement) {
    const bubble = ph.querySelector('.chat-bubble');
    if (bubble && !bubble.querySelector('.chat-plan-announce')) {
      const lbl = document.createElement('div');
      lbl.className = 'chat-plan-announce';
      lbl.textContent = `📋 ${t('chat.plan_announce') || '执行计划'}`;
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
  }

  // Created-agent chip (commander quick-create) — same actions row.
  if (gm.created_agent && gm.created_agent.agent_id) {
    _mountCreatedAgentChip(ph, gm.created_agent);
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
    if (window.PlanRail) window.PlanRail.refresh(cid);
  } else if (evData.type === 'state_changed') {
    // Each in_flight actor gets a placeholder so its delta tokens / tool
    // calls render in its own bubble even before its `message` arrives.
    // Adopt the controller's initial placeholder for the first actor.
    const st = evData.state || {};
    if (Array.isArray(st.in_flight)) {
      for (const actorId of st.in_flight) {
        if (!actorId) continue;
        _ensureActorPlaceholder(cid, actorId, streamingMsg);
      }
    }
    // Mirror in_flight so _evaluateAutoRecipient knows when commander is
    // mid-turn (release the chip back to commander even if plan still has
    // an interactive agent's done step as the most-recent terminal).
    _latestInFlight.set(cid, Array.isArray(st.in_flight) ? st.in_flight.slice() : []);
    // state_changed also fires on plan reconcile boundaries — re-evaluate
    // the auto-target so the chip matches the current dispatch state even
    // when a plan_changed event was missed (e.g. on first connect).
    _evaluateAutoRecipient(cid);
    // Plan rail hides retry/skip/abort buttons whenever any worker is in
    // flight (avoids racing user actions against an in-progress turn).
    if (window.PlanRail) {
      window.PlanRail.setInFlight(cid, Array.isArray(st.in_flight) ? st.in_flight : []);
    }
  } else if (evData.type === 'aborted') {
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
          // a folded "已完成思考" bubble. Empty final body = no main text.
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
    // Refresh the cache so subsequent bubbles can render the agent's name.
    _refreshGroupMembers(cid);
  }
}

// Append the "查看详情" chip into a streaming bubble. Idempotent: duplicate
// calls (relay event + final-event payload) are de-duped by checking for an
// existing `.chat-msg-created-agent` child.
function _mountCreatedAgentChip(msg, payload) {
  if (!msg || !payload || !payload.agent_id) return;
  // Chip lives in the below-bubble action row alongside produced files +
  // archive button (same visual footer slot). Lazily allocate the row
  // for streaming placeholders that didn't get one at creation.
  let actionsRow = msg.querySelector('[data-role="msg-actions"]');
  if (!actionsRow) {
    actionsRow = document.createElement('div');
    actionsRow.className = 'chat-msg-actions';
    actionsRow.dataset.role = 'msg-actions';
    msg.appendChild(actionsRow);
  }
  if (actionsRow.querySelector('.chat-msg-created-agent')) return;
  const wrap = document.createElement('div');
  wrap.innerHTML = _renderMessageCreatedAgentHtml(payload);
  const node = wrap.firstElementChild;
  if (!node) return;
  actionsRow.appendChild(node);
  _hydrateMessageCreatedAgentChip(msg);
  // Refresh the agents-cache lazily so the user sees the new agent in the
  // sidebar list when they jump over. Non-fatal if it fails.
  try { if (typeof loadAgents === 'function') loadAgents(true); } catch (_) {}
}

// Hide the `<agent-input-submission form_id=... agent_id=...>{json}
// </agent-input-submission>` XML tag from a user message body at render
// time. The tag is required in the stored raw text so the LLM can parse
// back the submitted values, but it's noise for the human reader — the
// bulleted summary above it already tells them what they confirmed.
function _stripSubmissionTagForDisplay(text) {
  if (!text || text.indexOf('<agent-input-submission') < 0) return text;
  return text
    .replace(/\n*<agent-input-submission\b[^>]*>[\s\S]*?<\/agent-input-submission>\s*/gi, '')
    .replace(/\n{3,}/g, '\n\n')
    .trimEnd();
}

// Collapse any ```agent-input-form fenced block in a streaming buffer to a
// single-line placeholder so the user never sees the raw JSON being typed
// char-by-char. Closed blocks get the placeholder inline; unclosed blocks
// (we're still mid-stream inside one) get everything from the fence onward
// replaced with the placeholder. When `final` arrives main has already
// stripped the block and mounts the real form widget.
// Final-time safety strip: drop any surviving `<agent>...</agent>` update
// container from a message body entirely (no placeholder) before it's
// rendered into the bubble. Used by `_streamingSetFinal` and the
// persisted-message renderer to guard against (a) backend extractor missing
// a format variant and (b) streaming-time placeholders accidentally sticking
// around. Both closed and unclosed containers get removed; consecutive blank
// lines collapse to one.
function _stripSurvivingAgentBlocks(text) {
  if (!text || text.indexOf('<agent>') < 0) return text;
  return text
    .replace(/<agent>[\s\S]*?<\/agent>/g, '')
    .replace(/<agent>[\s\S]*$/, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// Collapse the `<agent>...</agent>` update container (closed or mid-stream)
// in a streaming buffer into **exactly one** italicized placeholder — so the
// user never sees raw XML-ish tags / workflow JSON / inputs JSON typed
// char-by-char. Container layout (see `chat_agent_setup.md` / `chat_commander.md`
// § 创建智能体) is `<agent>...children...</agent>`; the whole container is
// one unit, so we just replace the closed form with a placeholder and collapse
// any unclosed trailing container the same way. `_streamingSetFinal` strips
// the container for real at final time, so no placeholder survives.
// Wrap placeholder text in an HTML `<em>` instead of markdown `_text_`:
// standard markdown requires word-boundary chars on each side of `_` for
// italic emphasis, and CJK glyphs don't count as word boundaries, so
// `_中文占位_` renders with the underscores visible. `<em>` passes through
// renderMarkdownFull as-is (HTML inline tags are preserved by the markdown
// pipeline) and actually italicises the CJK text.
function _streamPlaceholderHtml(key) {
  return `\n<em class="stream-placeholder">${escapeHtml(t(key))}</em>\n`;
}

function _stripAgentCreateBlocksForStream(buf) {
  if (!buf || buf.indexOf('<agent>') < 0) return buf;
  const placeholder = _streamPlaceholderHtml('chat.create_agent_streaming_placeholder');
  let out = buf.replace(/<agent>[\s\S]*?<\/agent>/g, placeholder);
  out = out.replace(/<agent>[\s\S]*$/, placeholder);
  return out;
}

function _stripAgentFormBlockForStream(buf) {
  // Primary: XML `<agent-input-form>...</agent-input-form>` (symmetric
  // with submission reply tag, token-stable). Legacy: fenced
  // ```agent-input-form block — tolerated with `[\s\-]*` inside the
  // header to also catch "```agent\n-input-form" token-split outputs.
  // Both are stripped to the same streaming placeholder; main's final
  // pass mounts the actual form widget.
  if (!buf) return buf;
  const hasXml = buf.indexOf('<agent-input-form>') >= 0;
  const hasLegacy = /```\s*agent[\s\-]*input[\s\-]*form/.test(buf);
  if (!hasXml && !hasLegacy) return buf;
  const placeholder = _streamPlaceholderHtml('chat.form.streaming_placeholder');
  let out = buf;
  if (hasXml) {
    out = out.replace(
      /(?:^|\n)[ \t]*<agent-input-form>[ \t]*\r?\n[\s\S]*?\r?\n[ \t]*<\/agent-input-form>[ \t]*(?=\n|$)/g,
      placeholder,
    );
    out = out.replace(/(?:^|\n)[ \t]*<agent-input-form>[\s\S]*$/, placeholder);
  }
  if (hasLegacy) {
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
// container; the "思考中" row stays visible BELOW the body until the terminal
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
    const display = _stripAgentCreateBlocksForStream(_stripAgentFormBlockForStream(buf));
    finalEl.innerHTML = `<div class="markdown-body">${_renderMessageMarkdown(display)}</div>`;
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
//   ▶   推理开始          ●   推理完成
//   ◆   思考              ◇   回复（最终）
//   ◐   正在生成（live）
//   ■   工具调用          ▣   计划
//   ▷   命令输出          ◉   文件改动
//   ○   等待确认          ◯   错误
//   ▪   其他/兜底
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
                   (itemType ? `◆ ${itemType}` : '◆');
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
    const marker = phase === 'end' ? (isError ? '✗' : '■') : '■';
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
    return `${marker} ${name}${p ? ' · ' + p : ''}${detailStr}`;
  }

  if (stream === 'command_output') {
    const text = data?.text || data?.stdout || data?.stderr || '';
    return text ? `▷ ${text}` : t('chat.stream.command_empty');
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

  return `▪ ${stream} ${JSON.stringify(data || {})}`;
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
  const line = _formatEventLine(evt);
  if (line) _streamingAppendProgress(msg, line);
}

// Update or create a single "live" line in the process pane.
// Used for streaming text (assistant deltas) that grows over time.
function _streamingUpdateLive(msg, prefix, text, appendDelta) {
  // Assistant deltas are still "in progress" from the user's perspective —
  // leave the 思考中 row alone; it's cleared by _streamingSetFinal.
  const container = msg.querySelector('[data-role="process-container"]');
  if (container) container.style.display = '';
  const body = msg.querySelector('[data-role="process"]');
  if (!body) return;

  let line = body.querySelector('.stream-process-live');
  if (!line) {
    line = document.createElement('div');
    line.className = 'stream-process-line stream-process-live';
    body.appendChild(line);
    msg._liveBuf = '';
  }
  if (appendDelta) msg._liveBuf = text; // already concatenated outside
  else msg._liveBuf = text;
  // Show last ~200 chars to keep the row compact
  const preview = msg._liveBuf.length > 200 ? '…' + msg._liveBuf.slice(-200) : msg._liveBuf;
  line.textContent = prefix + preview;
  body.scrollTop = body.scrollHeight;
}

// Update the loading element (wherever it currently lives in DOM) with the reply.
function _resolveConvReply(cid, text, isError) {
  const state = pendingConvs.get(cid);
  pendingConvs.delete(cid);
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
  // Group chat: also tell the bus to abort all in-flight worker turns + clear
  // queues. Cancelling just the IPC stream would leave agents running in the
  // background. Fire-and-forget — no need to block the UI on the response.
  try { apiFetch(`/api/conversations/${cid}/abort`, { method: 'POST' }); } catch (_) {}
  if (!state || !state.controller) return;
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
  // the bubble already shows "已中断" so the streaming badge would lie.
  const state = pendingConvs.get(cid);
  const pending = !!state && !state.aborted;
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
    // html += '<span class="conv-status-text">回复中</span>';
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

