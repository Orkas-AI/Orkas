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
  bodies: Record<string, { children: unknown[]; textContent: string; replaceChildren(): void }> = {
    process: { children: [], textContent: '', replaceChildren() { this.children = []; this.textContent = ''; } },
    final: { children: [], textContent: '', replaceChildren() { this.children = []; this.textContent = ''; } },
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
  dataset: Record<string, string> = {};
  classList = { remove() {} };
  style = { removeProperty() {} };

  set innerHTML(_value: string) {
    for (const row of this.rows) row.parentElement = null;
    this.rows = [];
  }

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
    if (!selector.startsWith('.chat-message')) return [];
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
    appendChatMessage = function(legacy, _scroll, opts = {}) {
      // Mirrors production's dedupe entry: identity first, create only when the
      // record has no row yet. Uses the REAL matcher so these tests exercise
      // render-key identity rather than a simplified stand-in.
      var existing = opts.historyHydration ? null : _findRenderedGroupMessage(__container, legacy);
      if (existing) {
        _syncRenderedGroupMessageIdentity(existing, legacy);
        return existing;
      }
      __appended.push(legacy);
      var node = __makeNode();
      node.dataset.msgId = String(legacy._msg_id || '');
      if (legacy._render_key) node.dataset.renderKey = String(legacy._render_key);
      if (legacy._from) node.dataset.fromActor = String(legacy._from);
      // Production sets this too; cross-page absorb finds a turn's bubble by it.
      if (legacy._turn_id) node.dataset.turnId = String(legacy._turn_id);
      node.bodies.final.textContent = legacy.content || '';
      node.message = legacy;
      // Mirror production's narration hydration (conversation.js, assistant
      // branch) so a merged record's earlier segments reach the row.
      if (legacy._narration && legacy._narration.length) {
        for (var i = 0; i < legacy._narration.length; i++) {
          _appendNarrationBlock(node, legacy._narration[i].seg, legacy._narration[i].text, { deferFold: true });
        }
        _applyNarrationFold(node);
      }
      (opts.container || __container).appendChild(node);
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

describe('keyed rendering › reconnect history', () => {
  it('recovers missing replies once without merging same-text replies from different turns', async () => {
    const { context, container, appended, finalized } = loadRenderer(CID);
    const first = { id: 'saved-1', from: 'commander', to: ['user'], text: 'Saved answer',
      ts: '2026-09-10T12:00:00Z', turn_id: 'first-turn', seg: 0 };
    const second = { ...first, id: 'saved-2', turn_id: 'second-turn' };
    const live = new FakeNode();
    live.dataset.renderKey = 's:first-turn:0';
    live.dataset.placeholder = '1';
    container.appendChild(live);

    await context._recoverPolledVisibleMessages(CID, [first]);
    await context._recoverPolledVisibleMessages(CID, [first, second]);
    await context._recoverPolledVisibleMessages(CID, [first, second]);

    expect(container.rows.map(row => row.dataset.msgId)).toEqual(['saved-1', 'saved-2']);
    expect(container.rows[0]).toBe(live);
    expect(appended).toHaveLength(1);
    expect(finalized.map(item => item.gm.text)).toEqual(['Saved answer']);
  });
});

describe('history refresh overlapping a Codex handback', () => {
  it.each([
    { included: false, superseded: false },
    { included: true, superseded: false },
    { included: true, superseded: true },
  ])('keeps the completed reply through stale active history and stream cleanup ($included, $superseded)', async ({ included, superseded }) => {
    const { context, container } = loadRenderer(CID);
    const warnings: unknown[] = [];
    context.__warnings = warnings;
    vm.runInContext('_convLog.warn = (...args) => __warnings.push(args)', context);
    context.performance = performance;
    context.convAgentEnabledByCid = new Map();
    context.pollMsgCounts = new Map();
    context._agentsCache = [];
    context.document.createDocumentFragment = () => new FakeContainer();
    const append = container.appendChild.bind(container);
    container.appendChild = (node: any) => {
      if (node instanceof FakeContainer) {
        for (const row of [...node.rows]) append(row);
        return node;
      }
      return append(node);
    };
    for (const name of ['_setChatScrollOffset', '_ensureCreateAgentInlineObserver',
      '_ensureConvCreateAgentInline', '_syncFailedFromHistory',
      '_setLoadEarlierHistory', '_scheduleConversationTurnNavigation', '_renderConvDisabledBanner',
      '_scrollToBottomNoAnim', '_observeConversationRunFromPlanAction', '_startRuntimeActorRecovery']) {
      context[name] = () => {};
    }
    let resolveHistory!: (value: any) => void;
    context.apiFetch = () => new Promise(resolve => { resolveHistory = resolve; });
    const loading = context.loadConversationHistory(CID);
    const reply = { id: 'codex-result', from: 'codex-agent', to: ['user'], turn_id: TURN,
      seg: 0, text: 'Changes saved; Commander will update the automation.',
      ts: new Date().toISOString(), produced: ['result.md'] };
    context._handleGroupBusEvent(CID, null, { type: 'message', turn_end: true, msg: reply });
    const finishOlder = resolveHistory;
    const replacement = superseded ? context.loadConversationHistory(CID) : null;
    // The history request began before Codex settled; its snapshot still lists
    // that turn as active even though the terminal event has already arrived.
    resolveHistory({ json: async () => ({ ok: true, history: included ? [reply] : [],
      conversation: { processing: true, processing_since: new Date().toISOString() },
      live_display: { sequence: 1, active_turns: [{ actor: reply.from, turn_id: TURN },
        { actor: 'commander', turn_id: 'commander-turn' }],
        turns: [{ actor: reply.from, turn_id: TURN,
          records: [{ ...reply, id: '', text: 'Working...', produced: [] }] }] },
    }) });
    if (replacement) {
      await replacement;
      finishOlder({ json: async () => ({ ok: true, history: [] }) });
    }
    await loading;
    expect(warnings.filter(args => String(args).includes('history load failed'))).toEqual([]);
    const codex = container.rows.find(row => row.dataset.msgId === reply.id);
    expect(codex, 'history refresh must retain the canonical Codex reply').toBeDefined();
    expect(codex!.bodies.final.textContent).toBe(reply.text);
    expect((codex as any).message.produced).toEqual(['result.md']);
    context._handleGroupBusEvent(CID, null, { ...delta(0, 'Stale Codex delta', reply.from), display_seq: 2 });
    context._handleGroupBusEvent(CID, null, {
      type: 'process', actor: 'commander', turn_id: 'commander-turn', seg: 0,
      data: { type: 'delta', text: 'Updating automation...' },
    });
    expect(container.rows.find(row => row.dataset.fromActor === 'commander')?.bodies.final.textContent)
      .toBe('Updating automation...');
    expect(codex!.bodies.final.textContent).toBe(reply.text);
    context._handleGroupBusEvent(CID, null, {
      type: 'message', turn_end: true,
      msg: { id: 'commander-result', from: 'commander', turn_id: 'commander-turn', seg: 0,
        text: 'Automation updated.', ts: new Date().toISOString() },
    });
    context._settleDanglingActorPlaceholders(CID);
    expect(container.rows.map(row => row.dataset.msgId)).toEqual(['codex-result', 'commander-result']);
  });
});

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

describe('keyed rendering › native assistant messages', () => {
  // 2026-09-17 (requester decision): a turn's native messages stay separate
  // records, but the transcript shows ONE bubble per turn. The live row
  // advances from segment to segment; earlier segments become narration
  // blocks above the body and their records are absorbed, never rows.
  it('keeps one row per turn even when persistence trails the next live message', async () => {
    const { context, container, finalized, appended } = loadRenderer(CID);
    const first = { ...segMessage(0, 'Report', 'native-0'), turn_end: false };
    first.msg.from = 'agent-1';
    const last = { ...segMessage(1, 'Saved', 'native-1'), turn_end: true };
    last.msg.from = 'agent-1';
    context._handleGroupBusEvent(CID, null, delta(0, 'Report', 'agent-1'));
    context._handleGroupBusEvent(CID, null, delta(1, 'Saved', 'agent-1'));
    expect(container.rows, 'the second segment continues in the same row').toHaveLength(1);
    expect(container.rows[0].dataset.renderKey).toBe('s:turn-1:1');
    expect(container.rows[0]._narration.map((item: any) => item.text)).toEqual(['Report']);
    context._handleGroupBusEvent(CID, null, first);
    context._handleGroupBusEvent(CID, null, first);
    context._handleGroupBusEvent(CID, null, last);
    await context._recoverPolledVisibleMessages(CID, [first.msg, last.msg]);
    expect(container.rows.map(row => row.dataset.msgId)).toEqual(['native-1']);
    expect(finalized.map(entry => entry.gm.text)).toEqual(['Saved']);
    expect(finalized[0].gm._narration.map((item: any) => item.text)).toEqual(['Report']);
    expect(appended).toHaveLength(0);
  });
});

describe('keyed rendering › a turn that settles before its records arrive', () => {
  // 2026-09-19, from the logs of conversation 68cb889e225e: an external-CLI
  // turn hit `cli_idle_timeout` after 72 minutes. The bus emitted the terminal
  // record, closed both streams, and only THEN flushed segments 31..37 — one
  // at a time, down the single-record path. `_liveTurnRow` skips settled rows,
  // so every late record appended a bubble of its own: seven extra bubbles
  // that only a reload folded back, because the fold lived in the batch merge
  // the reload runs and not in the path that delivered them.
  const ACTOR = 'agent-1';

  function seg(index: number, text: string, id: string, turnEnd = false) {
    const event = segMessage(index, text, id);
    event.msg.from = ACTOR;
    return { ...event, turn_end: turnEnd };
  }

  /** Stream the turn, then settle it on its terminal record. */
  function settleTurn(context: any) {
    context._handleGroupBusEvent(CID, null, delta(0, 'first', ACTOR));
    context._handleGroupBusEvent(CID, null, delta(1, 'second', ACTOR));
    context._handleGroupBusEvent(CID, null, delta(2, 'done', ACTOR));
    context._handleGroupBusEvent(CID, null, seg(2, 'done', 'rec-2', true));
  }

  it('folds a late segment record into the row its terminal record settled', () => {
    const { context, container, appended } = loadRenderer(CID);
    settleTurn(context);
    expect(container.rows, 'the turn settles into one bubble').toHaveLength(1);
    expect(container.rows[0].dataset.msgId).toBe('rec-2');

    context._handleGroupBusEvent(CID, null, seg(0, 'first', 'rec-0'));
    context._handleGroupBusEvent(CID, null, seg(1, 'second', 'rec-1'));

    expect(container.rows, 'a late record must not open a bubble of its own').toHaveLength(1);
    expect(appended, 'appending is the duplicate-bubble class this closes').toHaveLength(0);
    expect(container.rows[0]._narration.map((item: any) => [item.seg, item.text]))
      .toEqual([[0, 'first'], [1, 'second']]);
  });

  it('stays idempotent when the same late record is delivered twice', () => {
    // The trace shows two flushes: seg 31 five seconds after turn-end, then
    // 32..37 twenty-one minutes later when the window regained focus.
    const { context, container } = loadRenderer(CID);
    settleTurn(context);
    // Streaming already demoted segments 0 and 1 into narration slots; a late
    // record fills its slot canonically rather than adding a second one.
    const before = container.rows[0]._narration.map((item: any) => item.seg);
    context._handleGroupBusEvent(CID, null, seg(0, 'first', 'rec-0'));
    context._handleGroupBusEvent(CID, null, seg(0, 'first', 'rec-0'));
    expect(container.rows).toHaveLength(1);
    expect(container.rows[0]._narration.map((item: any) => item.seg)).toEqual(before);
    expect(container.rows[0]._narration.filter((item: any) => item.seg === 0))
      .toHaveLength(1);
  });

  it('keeps a settled long turn folded when earlier records arrive without a history request', () => {
    const { context, container } = loadRenderer(CID);
    for (let index = 0; index <= 6; index++) {
      context._handleGroupBusEvent(CID, null, delta(index, `part ${index}`, ACTOR));
    }
    context._handleGroupBusEvent(CID, null, seg(6, 'part 6', 'rec-6', true));
    const row = container.rows[0];
    // The DOM fold suite covers the default presentation of six blocks.
    // A passive record delivery must not switch that presentation to open.
    row.dataset.narrationExpanded = '0';
    context._handleGroupBusEvent(CID, null, seg(0, 'part 0', 'rec-0'));
    expect(container.rows).toHaveLength(1);
    expect(row._narration).toHaveLength(6);
    expect(row.dataset.narrationExpanded).toBe('0');
    expect(row.dataset.msgId).toBe('rec-6');
  });

  it('still appends when no settled row owns the turn', () => {
    // The fallback must stay a fallback: a record whose turn was never
    // rendered has nothing to fold into and still needs its own bubble.
    const { context, container } = loadRenderer(CID);
    context._handleGroupBusEvent(CID, null, seg(0, 'orphan', 'rec-0'));
    expect(container.rows).toHaveLength(1);
    expect(container.rows[0].dataset.msgId).toBe('rec-0');
  });
});

describe('keyed rendering › a turn split across history pages', () => {
  // 2026-09-18: history pages are HISTORY_PAGE_SIZE (10) records, and the
  // merge ran per page, so a 62-segment external-CLI turn rendered as seven
  // bubbles whose boundaries were the PAGE boundaries. Older segments belong
  // to the bubble their later segments already occupy.
  //
  // Absorption lives inside _mergeNativeSegmentRecords, the merger every
  // history path runs, so these drive that rather than a private helper.
  function record(turnId: string, seg: number, text: string, actor = 'agent-1') {
    return {
      id: `${turnId}-${seg}`, from: actor, to: ['user'], text,
      ts: '2026-09-18T14:20:00', turn_id: turnId, seg,
    };
  }

  /** Mint the settled bubble the way the newest page really does: merge, then
   * append what the merge did not absorb. */
  function settle(context: any, turnId: string, seg: number, actor = 'agent-1') {
    const merged = context._mergeNativeSegmentRecords(
      [record(turnId, seg, `step ${seg}`, actor)], CID,
    );
    for (const gm of merged) {
      context.appendChatMessage(context._groupMsgToLegacy(gm), false, { cid: CID });
    }
  }

  it('folds an older page into the bubble the turn already owns', () => {
    const { context, container } = loadRenderer(CID);
    settle(context, 'T1', 9);
    expect(container.rows).toHaveLength(1);
    const remaining = context._mergeNativeSegmentRecords([record('T1', 0, 'first')], CID);
    expect(remaining, 'an absorbed record must not mint a second bubble').toEqual([]);
    expect(container.rows).toHaveLength(1);
    expect(container.rows[0]._narration.map((item: any) => [item.seg, item.text]))
      .toEqual([[0, 'first']]);
  });

  it('expands the bubble it absorbed into, so auto-load cannot fire back to back', () => {
    // A folded narration block adds no height. If absorbing left the bubble
    // folded, `scrollHeight` would not move, `scrollTop` would stay under
    // HISTORY_AUTO_LOAD_THRESHOLD, and the next scroll event would load
    // another page immediately — pages firing back to back to the start of the
    // conversation. That is what "scrolling stutters" was (2026-09-18).
    const { context, container } = loadRenderer(CID);
    settle(context, 'T1', 9);
    container.rows[0].dataset.narrationExpanded = '0';
    context._mergeNativeSegmentRecords([record('T1', 5, 'fifth')], CID);
    expect(container.rows[0].dataset.narrationExpanded,
      'older segments are what the reader scrolled up for').toBe('1');
  });

  it('does not override a fold the reader chose', () => {
    // Absorbing expands so auto-load cannot fire back to back, but that must
    // not undo an explicit collapse (2026-09-18: switching conversations and
    // back re-opened it).
    const { context, container } = loadRenderer(CID);
    settle(context, 'T-chosen', 9);
    context._rememberNarrationFoldChoice('T-chosen', false);
    container.rows[0].dataset.narrationExpanded = '0';
    context._mergeNativeSegmentRecords([record('T-chosen', 5, 'fifth')], CID);
    expect(container.rows[0].dataset.narrationExpanded,
      'the reader decided this one').toBe('0');
  });

  it('leaves a record alone when no rendered bubble owns its turn', () => {
    const { context } = loadRenderer(CID);
    settle(context, 'T1', 9);
    const remaining = context._mergeNativeSegmentRecords([record('T2', 3, 'other turn')], CID);
    expect(remaining, 'a different turn still needs its own bubble').toHaveLength(1);
    expect(remaining[0].id).toBe('T2-3');
  });

  it('does not absorb across actors or into commander bubbles', () => {
    const { context } = loadRenderer(CID);
    settle(context, 'T1', 9, 'agent-2');
    const remaining = context._mergeNativeSegmentRecords([
      record('T1', 1, 'mine', 'agent-1'),
      record('T1', 1, 'cmd', 'commander'),
    ], CID);
    expect(remaining.map((gm: any) => gm.from).sort())
      .toEqual(['agent-1', 'commander']);
  });

  it('keeps records without a turn or segment untouched', () => {
    const { context } = loadRenderer(CID);
    settle(context, 'T1', 9);
    const remaining = context._mergeNativeSegmentRecords([
      { id: 'u-1', from: 'user', to: ['agent-1'], text: 'ask' },
      { id: 'x-1', from: 'agent-1', to: ['user'], text: 'no seg', turn_id: 'T1' },
    ], CID);
    expect(remaining.map((gm: any) => gm.id)).toEqual(['u-1', 'x-1']);
  });
});

describe('keyed rendering › paging a long turn end to end', () => {
  // The reported failure, at full size: a 62-segment turn arriving the way
  // `loadConversationHistory` really delivers it — newest page first, ten
  // records at a time, each page merged on its own. Before cross-page absorb
  // this produced ceil(62/10) = 7 bubbles.
  const PAGE = 10;

  function recordsFor(turnId: string, count: number) {
    return Array.from({ length: count }, (_, i) => ({
      id: `${turnId}-${i}`, from: 'agent-1', to: ['user'],
      text: `step ${i}`, ts: '2026-09-18T14:20:00', turn_id: turnId, seg: i,
    }));
  }

  it('collapses a turn that spans seven pages into one bubble', () => {
    const { context, container } = loadRenderer(CID);
    const all = recordsFor('T-long', 62);
    let pagesLoaded = 0;
    // Newest page first, then successively older ones — the scroll-up order.
    for (let end = all.length; end > 0; end -= PAGE) {
      const raw = all.slice(Math.max(0, end - PAGE), end);
      // The merger absorbs what an already-rendered bubble owns and returns
      // only what still needs one, which is exactly what the page-load path
      // then appends.
      const merged = context._mergeNativeSegmentRecords(raw, CID);
      for (const gm of merged) {
        context.appendChatMessage(context._groupMsgToLegacy(gm), false, { cid: CID });
      }
      pagesLoaded += 1;
    }
    expect(pagesLoaded, 'the turn really did span seven pages').toBe(7);
    expect(container.rows, 'one turn, one bubble').toHaveLength(1);
    const segs = container.rows[0]._narration.map((item: any) => Number(item.seg)).sort((a, b) => a - b);
    // 61 narration blocks + the body the bubble already showed = 62 segments.
    expect(segs).toHaveLength(61);
    expect(segs[0]).toBe(0);
    expect(segs[segs.length - 1]).toBe(60);
  });

  it('still separates two different turns arriving in the same page', () => {
    const { context, container } = loadRenderer(CID);
    const page = [...recordsFor('T-a', 2), ...recordsFor('T-b', 2)];
    const merged = context._mergeNativeSegmentRecords(page, CID);
    for (const gm of merged) {
      context.appendChatMessage(context._groupMsgToLegacy(gm), false, { cid: CID });
    }
    expect(container.rows.map((r: any) => r.dataset.turnId)).toEqual(['T-a', 'T-b']);
  });
});

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
  it.each([true, false])('shows a capability-handback Commander with an Agent selected (snapshot=%s)', (snapshot) => {
    const { context, container } = loadRenderer(CID);
    const state = {
      status: 'running', in_flight: ['commander'], active_recipient: 'agent-a',
      active_recipient_source: 'user_selection', active_recipient_revision: 3,
    };
    // Re-entry seeds from runtime; a live subscription can instead receive
    // progress before its next snapshot. Both must show the actual worker.
    context._rememberServerFloor(CID, state);
    if (snapshot) context._handleGroupBusEvent(CID, null, {
      type: 'state_changed', cid: CID, state,
      active_turns: [{ actor: 'commander', turn_id: TURN }],
    });
    context._handleGroupBusEvent(CID, null, {
      type: 'process', cid: CID, actor: 'commander', turn_id: TURN, seg: 0,
      data: { type: 'event', event: { stream: 'tool', data: { phase: 'start', id: 'read', name: 'read_files' } } },
    });
    context._handleGroupBusEvent(CID, null, delta(0, 'Checking the requested change.'));

    expect(commanderRows(container)).toHaveLength(1);
    const row = commanderRows(container)[0];
    expect(row.bodies.final.textContent).toBe('Checking the requested change.');
    expect(row.bodies.process.children).toHaveLength(1);
    expect(vm.runInContext('_serverFloorByCid.get("c1")', context)).toBe('agent-a');

    const terminal = { ...segMessage(0, 'Checked.', 'commander-result'), turn_end: true };
    context._handleGroupBusEvent(CID, null, terminal);
    context._handleGroupBusEvent(CID, null, terminal);
    context._handleGroupBusEvent(CID, null, delta(1, 'late output'));
    expect(commanderRows(container)).toEqual([row]);
    expect(row.dataset.msgId).toBe('commander-result');
    expect(row.bodies.final.textContent).not.toContain('late output');
  });

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

  it.each([
    ['earlier delta', 0, { type: 'delta', text: 'Late text' }],
    ['same-segment delta', 1, { type: 'delta', text: 'Late text' }],
    ['missing-segment tool event', undefined, { type: 'event', event: { stream: 'tool', data: { phase: 'end', id: 't1', name: 'hand_off_to' } } }],
    ['later orchestration event', 2, { type: 'event', event: { stream: 'tool', data: { phase: 'end', id: 't1', name: 'hand_off_to' } } }],
  ])('ignores %s after the turn ends without restarting idle UI', (_label, seg, data) => {
    const { context, container } = loadRenderer(CID);
    handoffPrelude(context);
    context.setGroupConversationBusy(CID, false);
    context.__warnings = [];
    context.__pollStarts = 0;
    context.__busyBadges = 0;
    vm.runInContext(`
      _convLog.warn = (...args) => __warnings.push(args);
      startPolling = () => { __pollStarts += 1; };
      _updateConvSidebarBadge = () => { __busyBadges += 1; };
    `, context);
    const rowsBefore = container.rows.slice();
    const savedBefore = JSON.stringify(rowsBefore.map(row => ({ dataset: row.dataset, bodies: row.bodies })));

    context._handleGroupBusEvent(CID, null, {
      type: 'process', cid: CID, actor: 'commander', turn_id: TURN, seg, data,
    });

    expect(context.__warnings).toEqual([]);
    expect(context.isGroupConversationBusy(CID)).toBe(false);
    expect(context.__pollStarts).toBe(0);
    expect(context.__busyBadges).toBe(0);
    expect(container.rows).toEqual(rowsBefore);
    expect(JSON.stringify(container.rows.map(row => ({ dataset: row.dataset, bodies: row.bodies })))).toBe(savedBefore);

    // The ended Commander must not block a distinct turn's real output.
    context._handleGroupBusEvent(CID, null, {
      type: 'process', cid: CID, actor: 'commander', turn_id: 'next-turn', seg: 0,
      data: { type: 'delta', text: 'New answer' },
    });
    expect(context.isGroupConversationBusy(CID)).toBe(true);
    expect(context.__pollStarts).toBe(1);
    expect(container.rows.at(-1)?.bodies.final.textContent).toBe('New answer');
    expect(context.__warnings).toEqual([]);
  });

  it('keeps a delegate live while dropping late Commander output', () => {
    const { context, container } = loadRenderer(CID);
    handoffPrelude(context);
    context._handleGroupBusEvent(CID, null, {
      ...delta(0, 'Delegate answer', 'agent-a'), turn_id: 'delegate-turn',
    });
    context.__warnings = [];
    vm.runInContext('_convLog.warn = (...args) => __warnings.push(args);', context);
    context._handleGroupBusEvent(CID, null, delta(0, 'Late Commander text'));
    expect(context.__warnings).toEqual([]);
    expect(context.isGroupConversationBusy(CID)).toBe(true);
    expect(container.rows.filter(row => row.dataset.fromActor === 'agent-a'))
      .toHaveLength(1);
    expect(container.rows.at(-1)?.bodies.final.textContent).toBe('Delegate answer');
    expect(commanderRows(container).map(row => row.dataset.msgId)).toEqual(['msg-end']);
  });

  it('still reports a genuinely missing live target', () => {
    const { context } = loadRenderer(CID);
    context.__warnings = [];
    vm.runInContext(`
      _ensureActorPlaceholder = () => null;
      _convLog.warn = (...args) => __warnings.push(args);
    `, context);
    context._handleGroupBusEvent(CID, null, delta(0, 'Live answer'));
    expect(context.__warnings.map((args: any[]) => args[0]))
      .toEqual(['group process target missing']);
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


describe('keyed rendering › one bubble per external-CLI turn', () => {
  const ACTOR = 'agent-1';

  function nativeMessage(seg: number, text: string, id: string, turnEnd: boolean) {
    const event = { ...segMessage(seg, text, id), turn_end: turnEnd };
    event.msg.from = ACTOR;
    return event;
  }

  it('advances the same row across three segments and merges their rails and narration', () => {
    const { context, container, finalized, appended } = loadRenderer(CID);
    const toolEvent = (seg: number, name: string) => ({
      type: 'process', cid: CID, actor: ACTOR, turn_id: TURN, seg,
      data: { type: 'event', event: { stream: 'tool', data: { phase: 'start', id: `t${seg}`, name } } },
    });
    context._handleGroupBusEvent(CID, null, delta(0, '开始改。', ACTOR));
    context._handleGroupBusEvent(CID, null, toolEvent(0, 'read_file'));
    context._handleGroupBusEvent(CID, null, delta(1, '我在核对。', ACTOR));
    context._handleGroupBusEvent(CID, null, toolEvent(1, 'bash'));
    const record0 = nativeMessage(0, '开始改。', 'native-0', false);
    record0.msg.process = [{ type: 'event', event: { stream: 'tool', data: { phase: 'start', id: 't0', name: 'read_file' } } }];
    context._handleGroupBusEvent(CID, null, record0);
    context._handleGroupBusEvent(CID, null, delta(2, '改完了。', ACTOR));
    const record1 = nativeMessage(1, '我在核对。', 'native-1', false);
    record1.msg.process = [{ type: 'event', event: { stream: 'tool', data: { phase: 'start', id: 't1', name: 'bash' } } }];
    context._handleGroupBusEvent(CID, null, record1);
    const record2 = nativeMessage(2, '改完了。', 'native-2', true);
    record2.msg.process = [{ type: 'event', event: { stream: 'tool', data: { phase: 'end', id: 't1', name: 'bash' } } }];
    context._handleGroupBusEvent(CID, null, record2);

    expect(container.rows.map(row => row.dataset.msgId)).toEqual(['native-2']);
    expect(container.rows[0].dataset.narrationSegs).toBe('0,1');
    expect(container.rows[0]._narration.map((item: any) => item.text)).toEqual(['开始改。', '我在核对。']);
    expect(container.rows[0].dataset.turnEnd).toBe('1');
    expect(finalized).toHaveLength(1);
    expect(finalized[0].gm.text).toBe('改完了。');
    expect(finalized[0].gm._narration.map((item: any) => item.seg)).toEqual([0, 1]);
    expect(finalized[0].gm.process.map((item: any) => item.event.data.name + ':' + item.event.data.phase))
      .toEqual(['read_file:start', 'bash:start', 'bash:end']);
    expect(appended).toHaveLength(0);
  });

  it('merges recovered history records into the last segment before rendering', async () => {
    const { context, container, appended } = loadRenderer(CID);
    const records = [
      nativeMessage(0, '开始改。', 'native-0', false).msg,
      nativeMessage(1, '我在核对。', 'native-1', false).msg,
      nativeMessage(2, '改完了。', 'native-2', true).msg,
    ];
    await context._recoverPolledVisibleMessages(CID, records);
    expect(container.rows.map(row => row.dataset.msgId)).toEqual(['native-2']);
    expect(appended).toHaveLength(1);
    expect(appended[0]._narration.map((item: any) => item.text)).toEqual(['开始改。', '我在核对。']);
    expect(appended[0].content).toBe('改完了。');
  });

  it('joins earlier history pages to the already rendered final turn without duplicate bubbles', async () => {
    const { context, container, appended } = loadRenderer(CID);
    const final = nativeMessage(3, '改完了。', 'native-3', true).msg;
    await context._recoverPolledVisibleMessages(CID, [final]);
    const row = container.rows[0];
    // DOM construction is outside this identity harness; retain the actual
    // persisted-process collector while testing its cross-page input order.
    row.querySelector = () => null;
    (row as any)._persistedProcessItems = [{ type: 'event', event: { stream: 'runtime', data: { duration_ms: 30 } } }];
    for (const seg of [2, 1, 0]) {
      const record = nativeMessage(seg, `过程 ${seg}`, `native-${seg}`, false).msg;
      (record as any).process = [{ type: 'event', event: { stream: 'runtime', data: { duration_ms: seg } } }];
      // Older-history loading calls this same page merger before appending.
      expect(context._mergeNativeSegmentRecords([record], CID)).toEqual([]);
      expect(context._mergeNativeSegmentRecords([record], CID)).toEqual([]);
    }
    expect(container.rows).toEqual([row]);
    expect(appended).toHaveLength(1);
    expect(row.dataset.msgId).toBe('native-3');
    expect((row as any)._narration.map((item: any) => item.seg).sort()).toEqual([0, 1, 2]);
    expect((row as any)._persistedProcessItems.map((item: any) => item.event.data.duration_ms)).toEqual([0, 1, 2, 30]);
    const otherActor = nativeMessage(0, '另一位成员', 'other-actor', false).msg;
    otherActor.from = 'agent-other';
    expect(context._mergeNativeSegmentRecords([otherActor], CID)).toHaveLength(1);
    const otherTurn = { ...nativeMessage(0, '另一轮', 'other-turn', false).msg, turn_id: 'different-turn' };
    expect(context._mergeNativeSegmentRecords([otherTurn], CID)).toHaveLength(1);
    expect(context._mergeNativeSegmentRecords([nativeMessage(0, '另一会话', 'other-cid', false).msg], 'other-cid')).toHaveLength(1);
  });

  it('does not let a recovery poll re-add segments a live row already owns', async () => {
    const { context, container, appended } = loadRenderer(CID);
    context._handleGroupBusEvent(CID, null, delta(0, '开始改。', ACTOR));
    context._handleGroupBusEvent(CID, null, delta(1, '我在核对。', ACTOR));
    await context._recoverPolledVisibleMessages(CID, [nativeMessage(0, '开始改。', 'native-0', false).msg]);
    expect(container.rows).toHaveLength(1);
    expect(container.rows[0].dataset.msgId).toBeUndefined();
    expect(appended).toHaveLength(0);
  });

  // 2026-09-17 live report: the runtime snapshot (state_changed, the 1 s
  // recovery tick) names no segment. Once the row had advanced to segment 1
  // the snapshot's segment-0 key found nothing and minted an empty sibling
  // bubble that only the end-of-turn record swept away.
  it('keeps the turn row when a runtime snapshot names no segment', () => {
    const { context, container } = loadRenderer(CID);
    const snapshot = () => context._handleGroupBusEvent(CID, null, {
      type: 'state_changed', cid: CID, state: { status: 'running', in_flight: [ACTOR] },
      active_turns: [{ actor: ACTOR, turn_id: TURN, started_at_ms: 1000 }],
    });
    snapshot();
    context._handleGroupBusEvent(CID, null, delta(0, '开始改。', ACTOR));
    snapshot();
    context._handleGroupBusEvent(CID, null, delta(1, '我在核对。', ACTOR));
    snapshot();
    context._handleGroupBusEvent(CID, null, nativeMessage(0, '开始改。', 'native-0', false));
    snapshot();
    expect(container.rows.map(row => row.dataset.renderKey)).toEqual(['s:turn-1:1']);
    expect(container.rows[0]._narration.map((item: any) => item.text)).toEqual(['开始改。']);
  });

  it('routes a late bookkeeping event for an absorbed segment into the turn row', () => {
    const { context, container } = loadRenderer(CID);
    context._handleGroupBusEvent(CID, null, delta(0, '开始改。', ACTOR));
    context._handleGroupBusEvent(CID, null, delta(1, '我在核对。', ACTOR));
    context._handleGroupBusEvent(CID, null, {
      type: 'process', cid: CID, actor: ACTOR, turn_id: TURN, seg: 0,
      data: { type: 'event', event: { stream: 'tool', data: { phase: 'end', id: 't0', name: 'read_file' } } },
    });
    expect(container.rows.map(row => row.dataset.renderKey)).toEqual(['s:turn-1:1']);
    expect(container.rows[0].bodies.process.children).toHaveLength(1);
  });

  it('moves the row on when a mid-turn record lands before the next segment\'s first token', () => {
    const { context, container, finalized } = loadRenderer(CID);
    context._handleGroupBusEvent(CID, null, delta(0, '开始改。', ACTOR));
    context._handleGroupBusEvent(CID, null, nativeMessage(0, '开始改。', 'native-0', false));
    expect(container.rows.map(row => row.dataset.renderKey)).toEqual(['s:turn-1:1']);
    expect(container.rows[0].dataset.msgId).toBeUndefined();
    context._handleGroupBusEvent(CID, null, delta(1, '改完了。', ACTOR));
    context._handleGroupBusEvent(CID, null, nativeMessage(1, '改完了。', 'native-1', true));
    expect(container.rows.map(row => row.dataset.msgId)).toEqual(['native-1']);
    expect(finalized).toHaveLength(1);
    expect(finalized[0].gm._narration.map((item: any) => item.text)).toEqual(['开始改。']);
  });

  it('lets the record fill narration the stream never painted', () => {
    const { context, container } = loadRenderer(CID);
    // Attached after segment 0 streamed: the row opens on segment 1 directly.
    context._handleGroupBusEvent(CID, null, {
      type: 'state_changed', cid: CID, state: { status: 'running', in_flight: [ACTOR] },
      active_turns: [{ actor: ACTOR, turn_id: TURN, started_at_ms: 1000 }],
    });
    context._handleGroupBusEvent(CID, null, delta(1, '我在核对。', ACTOR));
    expect(container.rows[0]._narration).toEqual([{ seg: 0, text: '' }]);
    context._handleGroupBusEvent(CID, null, nativeMessage(0, '开始改。', 'native-0', false));
    expect(container.rows).toHaveLength(1);
    expect(container.rows[0]._narration).toEqual([{ seg: 0, text: '开始改。' }]);
  });

  it('absorbs earlier records a recovery poll brings to a live row', async () => {
    const { context, container, appended } = loadRenderer(CID);
    context._handleGroupBusEvent(CID, null, delta(1, '我在核对。', ACTOR));
    const record0 = nativeMessage(0, '开始改。', 'native-0', false).msg;
    await context._recoverPolledVisibleMessages(CID, [record0]);
    await context._recoverPolledVisibleMessages(CID, [record0]);
    expect(container.rows).toHaveLength(1);
    expect(container.rows[0].dataset.renderKey).toBe('s:turn-1:1');
    expect(container.rows[0]._narration).toEqual([{ seg: 0, text: '开始改。' }]);
    expect(appended).toHaveLength(0);
  });

  it('restores a running turn\'s persisted segments into a live row on rebuild', () => {
    const { context, container, finalized, appended } = loadRenderer(CID);
    const record0 = nativeMessage(0, '开始改。', 'native-0', false).msg;
    record0.process = [{ type: 'progress', text: '读取文件' }];
    const record1 = nativeMessage(1, '我在核对。', 'native-1', false).msg;
    record1.process = [{ type: 'progress', text: '运行测试' }];
    const liveTurnGroups: any[] = [];
    const history = context._mergeNativeSegmentRecords([record0, record1], CID, {
      rebuild: true, activeTurnIds: new Set([TURN]), liveTurnGroups,
    });
    expect(history).toEqual([]);
    expect(liveTurnGroups.map((g: any) => [g.actor, g.turnId, g.records.length])).toEqual([[ACTOR, TURN, 2]]);
    context._restoreLiveTurnRows(CID, liveTurnGroups, [{ actor: ACTOR, turn_id: TURN, started_at_ms: 1000 }]);
    expect(container.rows.map(row => row.dataset.renderKey)).toEqual(['s:turn-1:2']);
    expect(container.rows[0].dataset.msgId).toBeUndefined();
    expect(container.rows[0]._narration.map((item: any) => item.text)).toEqual(['开始改。', '我在核对。']);
    // The turn continues in that row and settles as one bubble.
    context._handleGroupBusEvent(CID, null, {
      type: 'state_changed', cid: CID, state: { status: 'running', in_flight: [ACTOR] },
      active_turns: [{ actor: ACTOR, turn_id: TURN, started_at_ms: 1000 }],
    });
    context._handleGroupBusEvent(CID, null, delta(2, '改完了。', ACTOR));
    const record2 = nativeMessage(2, '改完了。', 'native-2', true);
    record2.msg.process = [{ type: 'progress', text: '收尾' }];
    context._handleGroupBusEvent(CID, null, record2);
    expect(container.rows.map(row => row.dataset.msgId)).toEqual(['native-2']);
    expect(finalized).toHaveLength(1);
    expect(finalized[0].gm._narration.map((item: any) => item.seg)).toEqual([0, 1]);
    expect(finalized[0].gm.process.map((item: any) => item.text)).toEqual(['读取文件', '运行测试', '收尾']);
    expect(appended).toHaveLength(0);
  });

  it('reuses the re-attached live row on rebuild instead of minting another', () => {
    const { context, container } = loadRenderer(CID);
    context._handleGroupBusEvent(CID, null, delta(1, '我在核对。', ACTOR));
    const record0 = nativeMessage(0, '开始改。', 'native-0', false).msg;
    context._restoreLiveTurnRows(CID, [{ actor: ACTOR, turnId: TURN, records: [record0] }], []);
    expect(container.rows.map(row => row.dataset.renderKey)).toEqual(['s:turn-1:1']);
    expect(container.rows[0]._narration).toEqual([{ seg: 0, text: '开始改。' }]);
  });

  it('leaves Commander dispatch segments alone', () => {
    const { context, container } = loadRenderer(CID);
    context._handleGroupBusEvent(CID, null, delta(0, 'Handing this to the researcher.'));
    context._handleGroupBusEvent(CID, null, { ...segMessage(0, 'Handing this to the researcher.', 'msg-0'), turn_end: false });
    context._handleGroupBusEvent(CID, null, delta(1, 'Synthesis.'));
    expect(commanderRows(container)).toHaveLength(2);
    expect(commanderRows(container).map(row => row.dataset.narrationSegs)).toEqual([undefined, undefined]);
  });
});


describe('active transcript recovery after task switching', () => {
  it('joins events received during the history request without replaying the snapshot prefix', () => {
    const { context, container } = loadRenderer(CID);
    const actor = 'codex-agent';
    context.__load = { cid: CID, container, collectingProcess: true, processEvents: [] };
    vm.runInContext('_conversationHistoryLoad = __load', context);
    context._handleGroupBusEvent(CID, null, { ...delta(0, 'Beginning ', actor), display_seq: 1 });
    context._handleGroupBusEvent(CID, null, { ...delta(0, 'middle ', actor), display_seq: 2 });
    context._handleGroupBusEvent(CID, null, { ...delta(0, 'end', actor), display_seq: 3 });
    expect(container.rows).toHaveLength(0);
    context._restoreLiveDisplaySnapshot(CID, { sequence: 2, turns: [{ actor, turn_id: TURN, records: [{
      id: '', from: actor, turn_id: TURN, seg: 0, text: 'Beginning middle ', process: [],
    }] }] });
    context._finishHistoryLoadProcess(context.__load);
    expect(container.rows).toHaveLength(1);
    expect(container.rows[0].bodies.final.textContent).toBe('Beginning middle end');
    expect(context.__load.processEvents).toEqual([]);
  });

  it('keeps a terminal reply that arrives before the active snapshot can be restored', () => {
    const { context, container, finalized } = loadRenderer(CID);
    const actor = 'codex-agent';
    context._handleGroupBusEvent(CID, null, delta(0, 'In progress', actor));
    context._handleGroupBusEvent(CID, null, {
      type: 'message', turn_end: true, turn_id: TURN,
      msg: { id: 'terminal', from: actor, to: ['user'], turn_id: TURN, seg: 0, text: 'Done' },
    });
    context._restoreLiveDisplaySnapshot(CID, { sequence: 1, turns: [{ actor, turn_id: TURN, records: [{
      id: '', from: actor, turn_id: TURN, seg: 0, text: 'In progress', process: [],
    }] }] });
    context._handleGroupBusEvent(CID, null, { ...delta(0, 'In progress', actor), display_seq: 1 });
    expect(container.rows.map(row => row.dataset.msgId)).toEqual(['terminal']);
    expect(finalized.map(item => item.gm.text)).toEqual(['Done']);
  });

  it('does not restore a stale snapshot into the other task after another switch', () => {
    const { context, container } = loadRenderer(CID);
    context.currentCid = 'other';
    context._restoreLiveDisplaySnapshot(CID, { sequence: 1, turns: [{ actor: 'codex-agent', turn_id: TURN, records: [{
      id: '', from: 'codex-agent', turn_id: TURN, seg: 0, text: 'Private task content', process: [],
    }] }] });
    expect(container.rows).toHaveLength(0);
  });

  it('merges recovered native segments once when their final reply arrives', () => {
    const { context, container, finalized } = loadRenderer(CID);
    const actor = 'claude-agent';
    const first = { id: 'first', from: actor, turn_id: TURN, seg: 0, text: 'First message',
      process: [{ type: 'progress', text: 'Read' }] };
    const snapshot = { sequence: 3, turns: [{ actor, turn_id: TURN, records: [first,
      { id: '', from: actor, turn_id: TURN, seg: 1, text: 'Second message', process: [{ type: 'progress', text: 'Check' }] },
    ] }] };
    context._restoreLiveDisplaySnapshot(CID, snapshot);
    context._restoreLiveDisplaySnapshot(CID, snapshot);
    context._handleGroupBusEvent(CID, null, { type: 'message', turn_end: true, turn_id: TURN,
      msg: { id: 'last', from: actor, turn_id: TURN, seg: 1, text: 'Done', process: [{ type: 'progress', text: 'Check' }] },
    });
    expect(container.rows).toHaveLength(1);
    expect(finalized[0].gm._narration.map((item: any) => item.text)).toEqual(['First message']);
    expect(finalized[0].gm.process.map((item: any) => item.text)).toEqual(['Read', 'Check']);
  });

  it('restores more than 300 operations and continues a partial reply once', () => {
    const { context, container } = loadRenderer(CID);
    const actor = 'codex-agent';
    const process = Array.from({ length: 350 }, (_, i) => ({ type: 'progress', text: `Operation ${i}` }));
    context._appendProjectedProcessRow = (node: any, row: any) => node.bodies.process.children.push(row.text);
    const snapshot = { sequence: 351, turns: [{ actor, turn_id: TURN, started_at_ms: 1000, records: [{
      id: '', from: actor, to: ['user'], turn_id: TURN, seg: 0, ts: '2026-09-18T00:00:00Z',
      process, text: 'Partial ',
    }] }] };
    context._handleGroupBusEvent(CID, null, delta(0, 'Old partial', actor));
    context._restoreLiveDisplaySnapshot(CID, snapshot);
    // A delayed IPC delivery already represented by the snapshot must not append twice.
    context._handleGroupBusEvent(CID, null, { ...delta(0, 'Partial ', actor), display_seq: 351 });
    context._handleGroupBusEvent(CID, null, { ...delta(0, 'reply', actor), display_seq: 352 });
    expect(container.rows).toHaveLength(1);
    expect(container.rows[0].bodies.final.textContent).toBe('Partial reply');
    expect(container.rows[0].bodies.process.children).toEqual(process.map(item => item.text));
    // Reopening from a newer complete snapshot remains idempotent.
    snapshot.sequence = 352;
    snapshot.turns[0].records[0].text = 'Partial reply';
    context._restoreLiveDisplaySnapshot(CID, snapshot);
    expect(container.rows).toHaveLength(1);
    expect(container.rows[0].bodies.final.textContent).toBe('Partial reply');
    expect(container.rows[0].bodies.process.children).toHaveLength(350);
  });
});
