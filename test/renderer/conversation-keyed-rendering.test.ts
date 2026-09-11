import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vm from 'node:vm';

/**
 * Event-sequence tests for the group-chat renderer.
 *
 * The renderer's long-standing defect class — one reply rendered as two
 * bubbles, a "thinking" row that never settles, a segment that loses its
 * process rail — only reproduces across a SEQUENCE of bus events. The existing
 * renderer tests extract one function at a time, so no ordering bug could fail
 * them. These drive `_handleGroupBusEvent` end to end against a minimal DOM and
 * assert on the rows that survive.
 *
 * The 2026-07-30 report is the canonical case: Commander narrates, dispatches a
 * visible agent, and ends its turn silently. Exactly one Commander bubble must
 * remain for the narration segment.
 */

const SOURCE = fs.readFileSync(
  path.join(__dirname, '../../src/renderer/modules/conversation.js'),
  'utf8',
);
const VIEW_MODEL_SOURCE = fs.readFileSync(
  path.join(__dirname, '../../src/renderer/modules/conversation-view-model.js'),
  'utf8',
);

class FakeNode {
  dataset: Record<string, string> = {};
  parentElement: FakeContainer | null = null;
  style: Record<string, string> = {};
  className = 'chat-message assistant';
  children: FakeNode[] = [];
  bodies: Record<string, { children: unknown[]; textContent: string }> = {
    process: { children: [], textContent: '' },
    final: { children: [], textContent: '' },
  };

  querySelector(selector: string) {
    if (selector === '[data-role="process"]') return this.bodies.process;
    if (selector === '[data-role="final"]') return this.bodies.final;
    if (selector === '.chat-bubble') return { querySelector: () => null, appendChild() {} };
    return null;
  }

  querySelectorAll() { return []; }
  appendChild(child: FakeNode) { this.children.push(child); return child; }
  remove() { this.parentElement?.removeChild(this); }
  matches() { return false; }
}

class FakeContainer {
  rows: FakeNode[] = [];

  appendChild(node: FakeNode) {
    node.parentElement = this as any;
    this.rows.push(node);
    return node;
  }

  insertBefore(node: FakeNode, ref: FakeNode | null) {
    node.parentElement = this as any;
    const at = ref ? this.rows.indexOf(ref) : -1;
    if (at >= 0) this.rows.splice(at, 0, node);
    else this.rows.push(node);
    return node;
  }

  removeChild(node: FakeNode) {
    this.rows = this.rows.filter((row) => row !== node);
    node.parentElement = null;
  }

  querySelector(selector: string) {
    return this.matchRows(selector)[0] || null;
  }

  querySelectorAll(selector: string) {
    return this.matchRows(selector);
  }

  private matchRows(selector: string): FakeNode[] {
    const exactKey = selector.match(/data-render-key="([^"]+)"/)?.[1];
    const prefixKey = selector.match(/data-render-key\^="([^"]+)"/)?.[1];
    const msgId = selector.match(/data-msg-id="([^"]+)"/)?.[1];
    const actor = selector.match(/data-from-actor="([^"]+)"/)?.[1];
    const wantsNoMsgId = selector.includes(':not([data-msg-id])');
    return this.rows.filter((row) => {
      if (exactKey && row.dataset.renderKey !== exactKey) return false;
      if (prefixKey && !(row.dataset.renderKey || '').startsWith(prefixKey)) return false;
      if (msgId && row.dataset.msgId !== msgId) return false;
      if (actor && row.dataset.fromActor !== actor) return false;
      if (wantsNoMsgId && row.dataset.msgId) return false;
      if (selector.includes('[data-render-key]') && !exactKey && !prefixKey && !row.dataset.renderKey) return false;
      return true;
    });
  }
}

function loadRenderer(cid: string) {
  const container = new FakeContainer();
  const finalized: Array<{ node: FakeNode; gm: any }> = [];
  const appended: any[] = [];
  const pendingConvs = new Map<string, any>();
  const groupBusyConvs = new Map<string, boolean>();

  const context: any = {
    console, setTimeout, clearTimeout, setInterval, clearInterval,
    Date, JSON, Map, Set, Array, String, Number, RegExp, Math, Promise, Boolean, Object,
    encodeURIComponent, URLSearchParams,
    CSS: { escape: (s: string) => String(s).replace(/["\\]/g, '\\$&') },
    requestAnimationFrame: (fn: Function) => { fn(); return 1; },
    currentCid: cid,
    conversations: [],
    pendingConvs,
    groupBusyConvs,
    isGroupConversationBusy: (c: string) => groupBusyConvs.has(c),
    setGroupConversationBusy: (c: string, busy: boolean) => {
      if (busy) groupBusyConvs.set(c, true); else groupBusyConvs.delete(c);
    },
    isConvPending: (c: string) => pendingConvs.has(c) || groupBusyConvs.has(c),
    createLogger: () => ({ warn() {}, info() {}, error() {}, debug() {} }),
    escapeHtml: (s: string) => String(s),
    t: (key: string) => key,
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    document: {
      // 'loading' keeps module-level boot wiring from running during eval —
      // these tests drive the event handler directly.
      readyState: 'loading',
      addEventListener() {},
      querySelector: () => null,
      querySelectorAll: () => [],
      getElementById: (id: string) => (id === 'chat-history' ? container : null),
      createElement: () => new FakeNode(),
    },
    window: {
      addEventListener() {},
      uiIconHtml: () => '',
      ConversationRuntime: {},
    },
  };
  context.window.window = context.window;
  vm.createContext(context);
  // The view model owns render-key identity; the renderer resolves it through
  // `window.ConversationViewModel`.
  vm.runInContext(VIEW_MODEL_SOURCE, context);
  vm.runInContext(SOURCE, context);

  // Replace only the DOM-construction primitives. Identity, claiming and
  // lifecycle — what these tests are about — stay production code.
  vm.runInContext(`
    _createStreamingAssistantMessage = function(container) {
      var node = __makeNode();
      container.appendChild(node);
      return node;
    };
    appendChatMessage = function(legacy) {
      // Mirrors production's dedupe entry: identity first, create only when the
      // record has no row yet. Uses the REAL matcher so these tests exercise
      // render-key identity rather than a simplified stand-in.
      var existing = _findRenderedGroupMessage(__container, legacy);
      if (existing) {
        _syncRenderedGroupMessageIdentity(existing, legacy);
        return existing;
      }
      __appended.push(legacy);
      var node = __makeNode();
      node.dataset.msgId = String(legacy._msg_id || '');
      if (legacy._render_key) node.dataset.renderKey = String(legacy._render_key);
      if (legacy._from) node.dataset.fromActor = String(legacy._from);
      __container.appendChild(node);
      return node;
    };
    _finalizeActorPlaceholder = function(node, gm) {
      node.dataset.msgId = String(gm.id || '');
      node.dataset.fromActor = String(gm.from || '');
      __finalized.push({ node: node, gm: gm });
    };
    _setPlaceholderActor = function(node, actorId) { node.dataset.fromActor = actorId || ''; };
    _startPlaceholderActivity = function() {};
    _stampPlaceholderTriggerMsg = function() {};
    _streamingAppendFinalDelta = function(node, text) {
      node.bodies.final.textContent += text;
    };
    _streamingAppendProgress = function(node) { node.bodies.process.children.push(1); };
    _streamingUpdateActivity = function() {};
    _streamingUpdateActivityFromEvent = function() {};
    _streamingSetFinal = function() {};
    _renderAgentEvent = function(node) { node.bodies.process.children.push(1); };
    _updateStreamingRuntimeSummary = function() {};
    _refreshGroupMembers = function() { return Promise.resolve([]); };
    _knownGroupActorLabel = function(cid, actorId) { return actorId; };
    _removeSupersededInterruptionBubbles = function() { return 0; };
    _updateConvSidebarBadge = function() {};
    _updateConvSendUI = function() {};
    startPolling = function() {};
    _bumpConvToTop = function() {};
    _repaintConvRowStatus = function() {};
    _scheduleConversationInfoFileRefresh = function() {};
    _evaluateAutoRecipient = function() {};
    _renderOrClaimPersistedUserMessage = function() { return true; };
    _isRoutingOnlyEventNames = function() { return false; };
    _shouldDiscardSilentPlaceholder = function(reason) { return reason === 'terminal_handoff'; };
  `, context);
  context.__container = container;
  context.__finalized = finalized;
  context.__appended = appended;
  context.__makeNode = () => new FakeNode();

  return { context, container, finalized, appended };
}

const CID = 'c1';
const TURN = 'turn-1';

function delta(seg: number, text: string, actor = 'commander') {
  return { type: 'process', cid: CID, actor, turn_id: TURN, seg, data: { type: 'delta', text } };
}

function segMessage(seg: number, text: string, id: string) {
  return {
    type: 'message',
    cid: CID,
    turn_id: TURN,
    seg,
    msg: { id, from: 'commander', to: ['user'], text, ts: '2026-07-30T16:43:07', turn_id: TURN, seg },
  };
}

function commanderRows(container: FakeContainer) {
  return container.rows.filter((row) => row.dataset.fromActor === 'commander');
}

describe('keyed rendering › commander segment persisted after streaming', () => {
  // The exact reported failure. Before render keys, the persisted segment could
  // not find the row its own deltas had written to, fell back to appending, and
  // the user saw the same sentence twice until the whole turn ended.
  it('persists the streamed segment into its own row instead of appending a second one', () => {
    const { context, container, finalized, appended } = loadRenderer(CID);

    context._handleGroupBusEvent(CID, null, delta(0, 'Handing this to the researcher.'));
    expect(commanderRows(container)).toHaveLength(1);

    context._handleGroupBusEvent(CID, null, segMessage(0, 'Handing this to the researcher.', 'msg-0'));

    expect(commanderRows(container), 'one segment must occupy exactly one row').toHaveLength(1);
    expect(finalized).toHaveLength(1);
    expect(appended, 'the persisted record must claim its live row, never append').toHaveLength(0);
    expect(container.rows[0].dataset.msgId).toBe('msg-0');
  });

  it('keeps the process rail the segment accumulated while streaming', () => {
    const { context, container } = loadRenderer(CID);

    context._handleGroupBusEvent(CID, null, {
      type: 'process', cid: CID, actor: 'commander', turn_id: TURN, seg: 0,
      data: { type: 'event', event: { stream: 'tool', data: { phase: 'start', id: 't1', name: 'read_file' } } },
    });
    context._handleGroupBusEvent(CID, null, delta(0, 'narration'));
    context._handleGroupBusEvent(CID, null, segMessage(0, 'narration', 'msg-0'));

    const row = commanderRows(container)[0];
    expect(row.bodies.process.children.length).toBeGreaterThan(0);
    expect(row.dataset.msgId).toBe('msg-0');
  });

  it('gives each segment of one turn its own row', () => {
    const { context, container } = loadRenderer(CID);

    context._handleGroupBusEvent(CID, null, delta(0, 'narration'));
    context._handleGroupBusEvent(CID, null, segMessage(0, 'narration', 'msg-0'));
    context._handleGroupBusEvent(CID, null, delta(1, 'synthesis'));
    context._handleGroupBusEvent(CID, null, segMessage(1, 'synthesis', 'msg-1'));

    const rows = commanderRows(container);
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.dataset.msgId)).toEqual(['msg-0', 'msg-1']);
  });

  // Deltas that arrive after the segment settled must not reopen it; the
  // persisted text is canonical.
  it('does not stream into a segment that already settled', () => {
    const { context, container } = loadRenderer(CID);

    context._handleGroupBusEvent(CID, null, delta(0, 'narration'));
    context._handleGroupBusEvent(CID, null, segMessage(0, 'narration', 'msg-0'));
    context._handleGroupBusEvent(CID, null, delta(0, ' stray tail'));

    expect(commanderRows(container)).toHaveLength(1);
    expect(container.rows[0].bodies.final.textContent).toBe('narration');
  });
});

describe('keyed rendering › silent turns', () => {
  // Commander narrates, dispatches, then ends silently because the delegate
  // already answered. The narration row stays; the post-dispatch routing row
  // must not linger as a second Commander bubble.
  it('drops the unpersisted tail of a terminal hand-off and keeps the narration', () => {
    const { context, container } = loadRenderer(CID);

    context._handleGroupBusEvent(CID, null, delta(0, 'Handing this to the researcher.'));
    context._handleGroupBusEvent(CID, null, segMessage(0, 'Handing this to the researcher.', 'msg-0'));
    // Commander began a synthesis it never got to persist before handing off.
    context._handleGroupBusEvent(CID, null, delta(1, 'Summarizing what came ba'));
    expect(commanderRows(container)).toHaveLength(2);

    context._handleGroupBusEvent(CID, null, {
      type: 'turn_silent', cid: CID, actor: 'commander', turn_id: TURN, reason: 'terminal_handoff',
    });

    const rows = commanderRows(container);
    expect(rows, 'only the persisted narration survives a terminal hand-off').toHaveLength(1);
    expect(rows[0].dataset.msgId).toBe('msg-0');
  });

  // Tool progress after a dispatch is orchestration bookkeeping while the
  // delegated agent works. Opening a row for it would park an empty Commander
  // bubble beside the agent's reply for the whole hand-off.
  it('does not open a row for post-dispatch tool progress alone', () => {
    const { context, container } = loadRenderer(CID);

    context._handleGroupBusEvent(CID, null, delta(0, 'Handing this over.'));
    context._handleGroupBusEvent(CID, null, segMessage(0, 'Handing this over.', 'msg-0'));
    context._handleGroupBusEvent(CID, null, {
      type: 'process', cid: CID, actor: 'commander', turn_id: TURN, seg: 1,
      data: { type: 'event', event: { stream: 'tool', data: { phase: 'start', id: 't2', name: 'hand_off_to' } } },
    });

    expect(commanderRows(container), 'no row for bookkeeping alone').toHaveLength(1);

    // Real output still opens the synthesis row.
    context._handleGroupBusEvent(CID, null, delta(1, 'Here is the summary.'));
    expect(commanderRows(container)).toHaveLength(2);
  });

  // The dispatch boundary retires the row the turn already opened. Only main
  // knows that moment; the renderer cannot infer it from the event stream.
  it('retires an unpersisted row when the dispatch boundary is announced', () => {
    const { context, container } = loadRenderer(CID);

    context._handleGroupBusEvent(CID, null, {
      type: 'process', cid: CID, actor: 'commander', turn_id: TURN, seg: 0,
      data: { type: 'event', event: { stream: 'tool', data: { phase: 'start', id: 't1', name: 'hand_off_to' } } },
    });
    expect(commanderRows(container)).toHaveLength(1);

    context._handleGroupBusEvent(CID, null, {
      type: 'segment_boundary', cid: CID, actor: 'commander', turn_id: TURN,
    });
    expect(commanderRows(container), 'bookkeeping row retires at the boundary').toHaveLength(0);
  });

  it('leaves a persisted segment alone when a boundary is announced', () => {
    const { context, container } = loadRenderer(CID);

    context._handleGroupBusEvent(CID, null, delta(0, 'narration'));
    context._handleGroupBusEvent(CID, null, segMessage(0, 'narration', 'msg-0'));
    context._handleGroupBusEvent(CID, null, {
      type: 'segment_boundary', cid: CID, actor: 'commander', turn_id: TURN,
    });

    expect(commanderRows(container)).toHaveLength(1);
    expect(container.rows[0].dataset.msgId).toBe('msg-0');
  });

  it('never drops a persisted segment when its turn goes silent', () => {
    const { context, container } = loadRenderer(CID);

    context._handleGroupBusEvent(CID, null, delta(0, 'kept'));
    context._handleGroupBusEvent(CID, null, segMessage(0, 'kept', 'msg-0'));
    context._handleGroupBusEvent(CID, null, {
      type: 'turn_silent', cid: CID, actor: 'commander', turn_id: TURN,
    });

    expect(commanderRows(container)).toHaveLength(1);
    expect(container.rows[0].dataset.msgId).toBe('msg-0');
  });

  it('leaves another actor\'s live row untouched when one turn goes silent', () => {
    const { context, container } = loadRenderer(CID);

    context._handleGroupBusEvent(CID, null, delta(0, 'commander text'));
    context._handleGroupBusEvent(CID, null, {
      type: 'process', cid: CID, actor: 'agent-1', turn_id: 'turn-2', seg: 0,
      data: { type: 'delta', text: 'agent text' },
    });
    context._handleGroupBusEvent(CID, null, {
      type: 'turn_silent', cid: CID, actor: 'commander', turn_id: TURN, reason: 'terminal_handoff',
    });

    expect(commanderRows(container)).toHaveLength(0);
    expect(container.rows.filter((r) => r.dataset.fromActor === 'agent-1')).toHaveLength(1);
  });
});

describe('keyed rendering › level-triggered placeholder reconciliation', () => {
  it('moves pending recovery ownership to the actor in the latest active snapshot', () => {
    const { context, container } = loadRenderer(CID);
    const staleCommander = new FakeNode();
    staleCommander.dataset.fromActor = 'commander';
    staleCommander.dataset.turnId = TURN;
    staleCommander.dataset.renderKey = `s:${TURN}:0`;
    context.pendingConvs.set(CID, { loadingEl: staleCommander, aborted: false });

    context._handleGroupBusEvent(CID, staleCommander, {
      type: 'state_changed',
      cid: CID,
      state: { status: 'running', in_flight: ['agent-a'], active_recipient: 'agent-a' },
      active_turns: [{ actor: 'agent-a', turn_id: 'turn-a' }],
    });

    const agentRow = container.rows.find((row) => row.dataset.fromActor === 'agent-a');
    expect(agentRow).toBeTruthy();
    expect(context.pendingConvs.get(CID).loadingEl).toBe(agentRow);
  });

  it('removes an empty placeholder after its actor leaves the active snapshot', () => {
    const { context, container } = loadRenderer(CID);

    context._handleGroupBusEvent(CID, null, {
      type: 'state_changed',
      cid: CID,
      state: { status: 'running', in_flight: ['agent-a'], active_recipient: 'agent-a' },
      active_turns: [{ actor: 'agent-a', turn_id: 'turn-a' }],
    });
    expect(container.rows.filter((row) => row.dataset.fromActor === 'agent-a')).toHaveLength(1);

    context._handleGroupBusEvent(CID, null, {
      type: 'state_changed',
      cid: CID,
      state: { status: 'running', in_flight: ['agent-b'], active_recipient: 'agent-b' },
      active_turns: [{ actor: 'agent-b', turn_id: 'turn-b' }],
    });

    expect(container.rows.filter((row) => row.dataset.fromActor === 'agent-a')).toHaveLength(0);
    expect(container.rows.filter((row) => row.dataset.fromActor === 'agent-b')).toHaveLength(1);
  });

  it('never removes a persisted narration row cached during reconciliation', () => {
    const { context, container } = loadRenderer(CID);

    context._handleGroupBusEvent(CID, null, delta(0, 'Handing this over.'));
    context._handleGroupBusEvent(CID, null, segMessage(0, 'Handing this over.', 'msg-0'));
    context._handleGroupBusEvent(CID, null, {
      type: 'state_changed',
      cid: CID,
      state: { status: 'running', in_flight: ['agent-a'], active_recipient: 'agent-a' },
      active_turns: [{ actor: 'agent-a', turn_id: 'turn-a' }],
    });

    const narration = container.rows.filter((row) => row.dataset.msgId === 'msg-0');
    expect(narration, 'a state snapshot only owns unpersisted placeholders').toHaveLength(1);
  });
});

// The renderer now has two subscribers again (primary send stream + redundant
// observer), because a single asynchronous observer could be torn down mid-turn
// and silently drop a persisted reply. That is only safe while re-delivery is a
// no-op, which is what render keys buy. These cases pin exactly that.
describe('keyed rendering › duplicate delivery from two subscribers', () => {
  it('renders one row when a streamed segment and its record both arrive twice', () => {
    const { context, container, appended } = loadRenderer(CID);
    const events = [
      delta(0, 'Handing this over.'),
      segMessage(0, 'Handing this over.', 'msg-0'),
    ];
    // Same order the two subscribers would produce.
    for (const ev of events) context._handleGroupBusEvent(CID, null, ev);
    for (const ev of events) context._handleGroupBusEvent(CID, null, ev);

    expect(commanderRows(container), 'two subscribers must not double the row').toHaveLength(1);
    expect(container.rows[0].dataset.msgId).toBe('msg-0');
    expect(appended, 'the record claims its live row on both deliveries').toHaveLength(0);
  });

  it('renders one row when a record with no live row is delivered twice', () => {
    const { context, container } = loadRenderer(CID);
    const ev = segMessage(0, 'instant reply', 'msg-0');
    context._handleGroupBusEvent(CID, null, ev);
    context._handleGroupBusEvent(CID, null, ev);

    expect(commanderRows(container)).toHaveLength(1);
  });

  // Carries over the protection a source-text assertion used to encode: after a
  // narrated hand-off segment settles, a re-delivered `hand_off_to:start`
  // process event must not reopen that consumed Commander bubble while the
  // delegated agent is still busy. Expressed as behavior, so it keeps holding
  // however the guard is implemented.
  it('does not reopen a settled segment when its process event is re-delivered', () => {
    const { context, container } = loadRenderer(CID);
    const handoffEvent = {
      type: 'process', cid: CID, actor: 'commander', turn_id: TURN, seg: 0,
      data: { type: 'event', event: { stream: 'tool', data: { phase: 'start', id: 't-ho', name: 'hand_off_to' } } },
    };

    context._handleGroupBusEvent(CID, null, delta(0, 'Handing this over.'));
    context._handleGroupBusEvent(CID, null, handoffEvent);
    context._handleGroupBusEvent(CID, null, segMessage(0, 'Handing this over.', 'msg-0'));
    const settled = commanderRows(container);
    expect(settled).toHaveLength(1);
    expect(settled[0].dataset.msgId).toBe('msg-0');

    // The delegated agent is still working; the duplicate arrives now.
    context._handleGroupBusEvent(CID, null, handoffEvent);

    const after = commanderRows(container);
    expect(after, 'a replayed process event must not reopen the consumed bubble').toHaveLength(1);
    expect(after[0].dataset.msgId).toBe('msg-0');
  });

  it('keeps an agent reply distinct from the commander segment of the same turn', () => {
    const { context, container } = loadRenderer(CID);
    const agentMessage = {
      type: 'message',
      cid: CID,
      turn_id: 'turn-agent',
      seg: 0,
      msg: {
        id: 'msg-agent', from: 'agent-1', to: ['user'], text: 'agent reply',
        ts: '2026-07-30T16:44:00', turn_id: 'turn-agent', seg: 0,
      },
    };
    context._handleGroupBusEvent(CID, null, segMessage(0, 'narration', 'msg-0'));
    context._handleGroupBusEvent(CID, null, agentMessage);
    context._handleGroupBusEvent(CID, null, agentMessage);

    expect(commanderRows(container)).toHaveLength(1);
    expect(container.rows.filter((r) => r.dataset.fromActor === 'agent-1')).toHaveLength(1);
  });
});

describe('keyed rendering › cross-conversation isolation', () => {
  it('never renders another conversation\'s events into the open one', () => {
    const { context, container } = loadRenderer(CID);

    context._handleGroupBusEvent('other-cid', null, {
      type: 'process', cid: 'other-cid', actor: 'commander', turn_id: 'turn-x', seg: 0,
      data: { type: 'delta', text: 'background work' },
    });

    expect(container.rows).toHaveLength(0);
  });
});

describe('keyed rendering › records with no live row', () => {
  // A turn fast enough to emit no process events at all still has to render.
  it('renders a persisted segment that never streamed', () => {
    const { context, container, appended } = loadRenderer(CID);

    context._handleGroupBusEvent(CID, null, segMessage(0, 'instant reply', 'msg-0'));

    expect(appended).toHaveLength(1);
    expect(commanderRows(container)).toHaveLength(1);
    expect(container.rows[0].dataset.renderKey).toBe('s:turn-1:0');
  });

  // Re-delivering that record (history reconcile, reconnect) must update the
  // row it already created rather than adding a twin.
  it('does not duplicate a record that is delivered twice', () => {
    const { context, container } = loadRenderer(CID);

    context._handleGroupBusEvent(CID, null, segMessage(0, 'instant reply', 'msg-0'));
    context._handleGroupBusEvent(CID, null, segMessage(0, 'instant reply', 'msg-0'));

    expect(commanderRows(container)).toHaveLength(1);
  });
});

/**
 * The invariant the row-identity refactor (`648e61ed4`) set out to establish,
 * asserted directly instead of through a per-shape row count.
 *
 * Counting commander rows only catches the sequences someone thought to
 * enumerate. The 2026-08-19 duplicate came from a sequence nobody had: the
 * send path leaves a streaming row created before any turn id exists — so it
 * carries no render key — and a keyed record that cannot find its row appends
 * beside it rather than adopting it. Both bubbles then show the same text and
 * the same process rail, and both survive until reload.
 */
function assertRowIdentityInvariant(container: FakeContainer) {
  const keys = container.rows.map((row) => row.dataset.renderKey || '').filter(Boolean);
  expect(new Set(keys).size, 'two rows must never share one render key').toBe(keys.length);
  const orphans = container.rows.filter((row) => !row.dataset.renderKey && (
    row.dataset.msgId || row.dataset.fromActor || row.bodies.final.textContent
  ));
  expect(
    orphans.map((row) => row.bodies.final.textContent || row.dataset.msgId || row.dataset.fromActor),
    'a row carrying content must be reachable by its render key',
  ).toEqual([]);
}

/** What `createChatController` puts on screen the moment the user sends: a
 *  streaming row opened before any turn id or actor is known. */
function sendPathPlaceholder(container: FakeContainer, text: string) {
  const node = new FakeNode();
  node.bodies.final.textContent = text;
  container.appendChild(node);
  return node;
}

describe('keyed rendering › row identity invariant', () => {
  it('adopts the send-path row instead of appending its twin', () => {
    const { context, container, appended } = loadRenderer(CID);
    const placeholder = sendPathPlaceholder(container, 'Handing this to the researcher.');

    // The narration segment persists without its stream ever opening a keyed
    // row — the shape the hand-off floor guard produces when the commander
    // dispatches in the same turn it narrates.
    context._handleGroupBusEvent(
      CID, placeholder, segMessage(0, 'Handing this to the researcher.', 'msg-0'),
    );

    expect(container.rows, 'the record belongs in the row already on screen').toHaveLength(1);
    expect(appended, 'appending beside an unkeyed content row IS the duplicate').toHaveLength(0);
    assertRowIdentityInvariant(container);
  });

  it('holds across a streamed segment, its record, and a second segment', () => {
    const { context, container } = loadRenderer(CID);
    const placeholder = sendPathPlaceholder(container, '');

    context._handleGroupBusEvent(CID, placeholder, delta(0, 'narration'));
    context._handleGroupBusEvent(CID, placeholder, segMessage(0, 'narration', 'msg-0'));
    context._handleGroupBusEvent(CID, placeholder, delta(1, 'synthesis'));
    context._handleGroupBusEvent(CID, placeholder, segMessage(1, 'synthesis', 'msg-1'));

    assertRowIdentityInvariant(container);
    expect(commanderRows(container)).toHaveLength(2);
  });

  // Adoption must refuse a row that already carries a key. Once segment 0 has
  // adopted the controller's row, segment 1 has to open its own; stealing it
  // would re-key segment 0's live text as segment 1 and lose one of them. The
  // existing per-segment test passes no fallback row, so only this one has a
  // row available to steal.
  it('refuses to adopt a row that already carries a key', () => {
    const { context, container } = loadRenderer(CID);
    const placeholder = sendPathPlaceholder(container, '');

    context._handleGroupBusEvent(CID, placeholder, delta(0, 'narration'));
    expect(placeholder.dataset.renderKey, 'the first segment adopts it').toBe('s:turn-1:0');

    context._handleGroupBusEvent(CID, placeholder, delta(1, 'synthesis'));

    expect(placeholder.dataset.renderKey, 'segment 0 keeps the row it adopted').toBe('s:turn-1:0');
    expect(commanderRows(container), 'segment 1 opens its own row').toHaveLength(2);
    assertRowIdentityInvariant(container);
  });

  it('holds when a record arrives with no live row at all', () => {
    const { context, container } = loadRenderer(CID);

    context._handleGroupBusEvent(CID, null, segMessage(0, 'instant reply', 'msg-0'));

    assertRowIdentityInvariant(container);
  });
});

describe('keyed rendering › terminal hand-off with an end-of-turn record', () => {
  // 2026-09-09 production case: Commander narrates the hand-off as commentary
  // beside the hand_off_to call (no prose delta, so segment 0 is retired at the
  // boundary), persists its end-of-turn record as segment 1, and the agent
  // starts. The hand-off is not interactive, so the floor never moves to the
  // agent. A level-triggered snapshot that still lists the finished Commander
  // turn — and any late bookkeeping event — must not mint a second Commander
  // bubble beside the agent's live reply.
  function handoffPrelude(context: any) {
    context._handleGroupBusEvent(CID, null, {
      type: 'state_changed', cid: CID,
      state: { status: 'running', in_flight: ['commander'] },
      active_turns: [{ actor: 'commander', turn_id: TURN, started_at_ms: 1 }],
    });
    context._handleGroupBusEvent(CID, null, {
      type: 'process', cid: CID, actor: 'commander', turn_id: TURN, seg: 0,
      data: { type: 'event', event: { stream: 'tool', data: { phase: 'start', id: 't1', name: 'hand_off_to' } } },
    });
    context._handleGroupBusEvent(CID, null, {
      type: 'process', cid: CID, actor: 'commander', turn_id: TURN, seg: 0,
      data: { type: 'event', event: { stream: 'tool', data: { phase: 'end', id: 't1', name: 'hand_off_to', isError: false } } },
    });
    context._handleGroupBusEvent(CID, null, { type: 'segment_boundary', cid: CID, actor: 'commander', turn_id: TURN });
    context._handleGroupBusEvent(CID, null, {
      type: 'message', cid: CID, turn_id: TURN,
      msg: { id: 'dispatch-1', from: 'commander', to: ['agent-a'], text: 'Compare the strategies.', ts: '2026-09-09T19:22:49', dispatch: true },
    });
    context._handleGroupBusEvent(CID, null, {
      type: 'message', cid: CID, turn_id: TURN, seg: 1, turn_end: true,
      msg: {
        id: 'msg-end', from: 'commander', to: ['user'], text: 'I will hand this to @agent-a.',
        ts: '2026-09-09T19:22:49', turn_id: TURN, seg: 1, mentions: ['agent-a'],
        process: [{ type: 'progress', text: 'I will hand this to @agent-a.' }],
      },
    });
  }

  it('does not reopen a Commander row from a stale snapshot after the end-of-turn record', () => {
    const { context, container } = loadRenderer(CID);
    handoffPrelude(context);
    expect(commanderRows(container)).toHaveLength(1);

    // The snapshot emitted while the agent queue item was being admitted still
    // names the Commander turn; it can arrive after the record was rendered.
    context._handleGroupBusEvent(CID, null, {
      type: 'state_changed', cid: CID,
      state: { status: 'running', in_flight: ['commander'] },
      active_turns: [{ actor: 'commander', turn_id: TURN, started_at_ms: 1 }],
    });
    // Late bookkeeping for the finished turn (segment index unknown to the emitter).
    context._handleGroupBusEvent(CID, null, {
      type: 'process', cid: CID, actor: 'commander', turn_id: TURN,
      data: { type: 'event', event: { stream: 'tool', data: { phase: 'end', id: 't1', name: 'hand_off_to', isError: false } } },
    });
    context._handleGroupBusEvent(CID, null, {
      type: 'state_changed', cid: CID,
      state: { status: 'running', in_flight: ['agent-a'] },
      active_turns: [{ actor: 'agent-a', turn_id: 'turn-a', started_at_ms: 2 }],
    });
    context._handleGroupBusEvent(CID, null, delta(0, 'Working on it.', 'agent-a'));

    const rows = commanderRows(container);
    expect(rows.map((row) => row.dataset.msgId), 'only the persisted end-of-turn record').toEqual(['msg-end']);
    expect(container.rows.filter((row) => row.dataset.fromActor === 'agent-a')).toHaveLength(1);
  });

  it('still lets a later segment stream after a mid-turn segment record (negative control)', () => {
    const { context, container } = loadRenderer(CID);
    context._handleGroupBusEvent(CID, null, delta(0, 'Handing this over.'));
    context._handleGroupBusEvent(CID, null, segMessage(0, 'Handing this over.', 'msg-0'));
    context._handleGroupBusEvent(CID, null, {
      type: 'state_changed', cid: CID,
      state: { status: 'running', in_flight: ['commander'] },
      active_turns: [{ actor: 'commander', turn_id: TURN, started_at_ms: 1 }],
    });
    context._handleGroupBusEvent(CID, null, delta(1, 'Here is the synthesis.'));
    expect(commanderRows(container), 'a mid-turn record does not end the turn').toHaveLength(2);
  });
});
