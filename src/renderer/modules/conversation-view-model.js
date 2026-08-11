/* Orkas Frontend — conversation view model
 *
 * A pure reducer over group-chat bus events. It exists because the renderer
 * used to keep conversation state in the DOM itself: message identity lived in
 * `data-msg-id` / `data-group-msg-sig` / `data-placeholder` / `data-finalized`
 * dataset fields written from ~17 places, and "is this reply already on screen"
 * was answered by querying the document. Any writer that missed a field made
 * every downstream dedupe fail at once, which is how one commander segment
 * could render as two identical bubbles.
 *
 * The model here is the single source of truth for what a conversation looks
 * like right now; the DOM becomes a rendering of it.
 *
 * ── Identity ──────────────────────────────────────────────────────────────
 * Every rendered row has a `key` that is stable from its first byte:
 *
 *   persisted message      → `m:<msg.id>`
 *   commander/agent stream → `s:<turn_id>:<seg>`
 *   optimistic user send   → `u:<client_msg_id>`
 *
 * A streaming segment keeps its `s:` key when the bus persists it: the
 * `message` event carries the same `turn_id` + `seg` as the deltas that
 * preceded it, so persistence UPDATES the row instead of creating a second
 * one. This is the property the old placeholder-claiming logic had to
 * reconstruct by guessing, and the reason `seg` was added to `process` events
 * (see bus.ts `GroupEvent`).
 *
 * ── Contract ──────────────────────────────────────────────────────────────
 * `reduceConversationView(view, event)` returns a NEW view when anything
 * changed and the SAME view object when nothing did (so callers can skip
 * repaints by identity). It never touches the DOM, never reads globals, and is
 * deterministic — the same event sequence always yields the same view, which
 * is what makes replay/out-of-order/duplicate-delivery testable without a
 * browser.
 */

(function initConversationViewModel(global) {
  'use strict';

  const USER_ACTOR = 'user';

  function emptyView() {
    return { rows: new Map(), activeTurns: new Map() };
  }

  function cloneView(view) {
    return { rows: new Map(view.rows), activeTurns: new Map(view.activeTurns) };
  }

  function segmentKey(turnId, seg) {
    return `s:${turnId}:${seg}`;
  }

  function messageKey(msgId) {
    return `m:${msgId}`;
  }

  function optimisticKey(clientMsgId) {
    return `u:${clientMsgId}`;
  }

  /** Key a persisted record would occupy. Segment-bearing actor replies keep
   * the identity their stream already established; everything else is keyed by
   * its persisted id. User rows prefer the echoed client id so the optimistic
   * row is updated rather than duplicated. */
  function keyForMessage(msg) {
    if (!msg) return '';
    if (msg.from === USER_ACTOR && msg.client_msg_id) return optimisticKey(msg.client_msg_id);
    if (msg.from !== USER_ACTOR && msg.turn_id && msg.seg !== undefined && msg.seg !== null) {
      return segmentKey(msg.turn_id, msg.seg);
    }
    return msg.id ? messageKey(msg.id) : '';
  }

  function tsMs(value) {
    if (value == null) return 0;
    if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
    const parsed = Date.parse(String(value));
    return Number.isFinite(parsed) ? parsed : 0;
  }

  function newRow(key, patch) {
    return {
      key,
      actor: '',
      turnId: '',
      seg: undefined,
      msgId: '',
      clientMsgId: '',
      text: '',
      ts: '',
      order: 0,
      process: [],
      persisted: false,
      artifacts: [],
      ...patch,
    };
  }

  /** Rows render in arrival order, never by timestamp. A live turn must not
   * reshuffle when a reply is persisted: in long plan runs the user reads the
   * transcript in execution-start order, and re-sorting by completion time
   * makes parallel or resumed steps appear to jump. History is normalised into
   * arrival order up front by `viewFromHistory`, so both paths agree. */
  function orderedRows(view) {
    return Array.from(view.rows.values()).sort((a, b) => a.order - b.order);
  }

  function nextOrder(view) {
    let max = 0;
    for (const row of view.rows.values()) if (row.order > max) max = row.order;
    return max + 1;
  }

  function processItemsEqual(a, b) {
    if (a === b) return true;
    if (!a || !b) return false;
    try { return JSON.stringify(a) === JSON.stringify(b); } catch (_) { return false; }
  }

  /** Process items are appended by the live stream and also arrive in bulk on
   * the persisted record. Re-delivering the same event (two subscribers, a
   * replayed history page) must not double the rail. */
  function mergeProcess(existing, incoming) {
    if (!Array.isArray(incoming) || !incoming.length) return existing;
    const out = existing.slice();
    for (const item of incoming) {
      if (out.some((seen) => processItemsEqual(seen, item))) continue;
      out.push(item);
    }
    return out;
  }

  const SIDECAR_FIELDS = [
    'attachments', 'produced', 'references', 'form', 'created_agents', 'created_skills',
    'artifacts', 'marketplace_requests', 'plan_announcement', 'failure_kind', 'failure_code',
    'model_text', 'source_message_id', 'unknown_mentions', 'mentions', 'to',
  ];

  function applyMessage(view, event) {
    const msg = event && event.msg;
    if (!msg) return view;
    // Internal commander → agent dispatch rows are context for the recipient,
    // never part of the user's transcript.
    if (msg.dispatch) return view;
    if (msg.deleted_at) {
      const key = keyForMessage(msg);
      if (!key || !view.rows.has(key)) return view;
      const next = cloneView(view);
      next.rows.delete(key);
      return next;
    }
    const key = keyForMessage(msg);
    if (!key) return view;

    const prev = view.rows.get(key);
    const next = cloneView(view);
    const base = prev || newRow(key, { order: nextOrder(view) });
    const merged = {
      ...base,
      actor: String(msg.from || base.actor || ''),
      turnId: String(msg.turn_id || base.turnId || ''),
      seg: msg.seg !== undefined && msg.seg !== null ? msg.seg : base.seg,
      msgId: String(msg.id || base.msgId || ''),
      clientMsgId: String(msg.client_msg_id || base.clientMsgId || ''),
      // The persisted record is canonical text: the bus strips structural
      // blocks the live stream may still have been carrying.
      text: typeof msg.text === 'string' ? msg.text : base.text,
      ts: msg.ts || base.ts,
      process: mergeProcess(base.process, msg.process),
      persisted: true,
      turnEnd: !!event.turn_end || base.turnEnd,
    };
    for (const field of SIDECAR_FIELDS) {
      if (msg[field] !== undefined) merged[field] = msg[field];
    }
    next.rows.set(key, merged);
    return next;
  }

  /** A process event belongs to `${turn_id}:${seg}`. Events that predate the
   * field (or come from a path that cannot know the segment) fall back to
   * segment 0, which is where the turn starts. */
  function processRowKey(event) {
    const turnId = String(event.turn_id || event.turnId || '');
    if (!turnId) return '';
    const seg = event.seg !== undefined && event.seg !== null ? event.seg : 0;
    return segmentKey(turnId, seg);
  }

  function applyProcess(view, event) {
    const key = processRowKey(event);
    if (!key) return view;
    const data = event.data || {};
    const actor = String(event.actor || '');
    const turnId = String(event.turn_id || event.turnId || '');
    const seg = event.seg !== undefined && event.seg !== null ? event.seg : 0;
    const prev = view.rows.get(key);

    if (data.type === 'delta') {
      const text = typeof data.text === 'string' ? data.text : '';
      if (!text) return view;
      // Once the bus has persisted this segment its text is canonical; a late
      // delta for the same segment must not append to it.
      if (prev && prev.persisted) return view;
      const next = cloneView(view);
      const base = prev || newRow(key, { order: nextOrder(view), actor, turnId, seg });
      next.rows.set(key, { ...base, actor: base.actor || actor, turnId, seg, text: base.text + text });
      return next;
    }

    if (data.type === 'event' || data.type === 'progress') {
      const item = data.type === 'event'
        ? { type: 'event', event: data.event }
        : { type: 'progress', text: data.text, ...(data.event ? { event: data.event } : {}) };
      const base = prev || newRow(key, { order: nextOrder(view), actor, turnId, seg });
      const process = mergeProcess(base.process, [item]);
      if (prev && process === prev.process) return view;
      const next = cloneView(view);
      next.rows.set(key, { ...base, actor: base.actor || actor, turnId, seg, process });
      return next;
    }

    return view;
  }

  function applyTurnSilent(view, event) {
    const actor = String(event.actor || '');
    const turnId = String(event.turn_id || event.turnId || '');
    if (!turnId) return view;
    let changed = false;
    const next = cloneView(view);
    for (const [key, row] of view.rows) {
      if (row.turnId !== turnId) continue;
      if (actor && row.actor && row.actor !== actor) continue;
      // A silent turn produced no end-of-turn record. Anything still unpersisted
      // for it is renderer-only residue — the same rows `settleDangling…` used
      // to sweep out of the DOM after the fact.
      if (row.persisted) continue;
      next.rows.delete(key);
      changed = true;
    }
    if (!changed) return view;
    return next;
  }

  function applyStateChanged(view, event) {
    const turns = Array.isArray(event.active_turns) ? event.active_turns : [];
    const nextTurns = new Map();
    for (const turn of turns) {
      const actor = String(turn && turn.actor || '');
      const turnId = String(turn && (turn.turn_id || turn.turnId) || '');
      if (!actor || !turnId) continue;
      nextTurns.set(turnId, {
        actor,
        turnId,
        startedAtMs: Number(turn.started_at_ms) || 0,
        msgId: String(turn.msg_id || ''),
      });
    }
    let same = nextTurns.size === view.activeTurns.size;
    if (same) {
      for (const [turnId, turn] of nextTurns) {
        const prev = view.activeTurns.get(turnId);
        if (!prev || prev.actor !== turn.actor || prev.startedAtMs !== turn.startedAtMs) {
          same = false;
          break;
        }
      }
    }
    if (same) return view;
    const next = cloneView(view);
    next.activeTurns = nextTurns;
    return next;
  }

  function applyArtifactCreated(view, event) {
    const key = processRowKey(event);
    const artifact = event.artifact;
    if (!key || !artifact || !artifact.id) return view;
    const prev = view.rows.get(key);
    const base = prev || newRow(key, {
      order: nextOrder(view),
      actor: String(event.actor || ''),
      turnId: String(event.turn_id || event.turnId || ''),
    });
    if ((base.artifacts || []).some((item) => item && item.id === artifact.id)) return view;
    const next = cloneView(view);
    next.rows.set(key, { ...base, artifacts: [...(base.artifacts || []), artifact] });
    return next;
  }

  function reduceConversationView(view, event) {
    const current = view || emptyView();
    if (!event || typeof event !== 'object') return current;
    switch (event.type) {
      case 'message': return applyMessage(current, event);
      case 'process': return applyProcess(current, event);
      case 'turn_silent': return applyTurnSilent(current, event);
      case 'state_changed': return applyStateChanged(current, event);
      case 'artifact_created': return applyArtifactCreated(current, event);
      default: return current;
    }
  }

  /** Build a view from persisted history (cold open, conversation switch,
   * reconcile). Uses the same reducer as the live path so both agree on
   * identity — divergence between "what history renders" and "what the stream
   * renders" is what reconciliation passes existed to paper over. */
  function viewFromHistory(records) {
    let view = emptyView();
    // jsonl is append-ordered and therefore already chronological; the stable
    // sort is a guard against any future writer landing a record out of order,
    // and it is what lets `orderedRows` ignore timestamps entirely.
    const ordered = (Array.isArray(records) ? records.slice() : [])
      .map((msg, index) => ({ msg, index }))
      .sort((a, b) => {
        const delta = tsMs(a.msg && a.msg.ts) - tsMs(b.msg && b.msg.ts);
        return delta !== 0 ? delta : a.index - b.index;
      });
    for (const { msg } of ordered) {
      view = reduceConversationView(view, { type: 'message', msg, turn_end: !!(msg && msg.turn_end) });
    }
    return view;
  }

  function reduceAll(view, events) {
    let next = view || emptyView();
    for (const event of Array.isArray(events) ? events : []) {
      next = reduceConversationView(next, event);
    }
    return next;
  }

  global.ConversationViewModel = {
    emptyView,
    reduceConversationView,
    reduceAll,
    viewFromHistory,
    orderedRows,
    keyForMessage,
    segmentKey,
    messageKey,
    optimisticKey,
  };

  // Test bridge: pure functions only, no DOM/i18n/IPC (see PC/CLAUDE.md).
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = global.ConversationViewModel;
  }
}(typeof window !== 'undefined' ? window : globalThis));
