import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vm from 'node:vm';

const source = fs.readFileSync(path.join(__dirname, '../../src/renderer/modules/conversation.js'), 'utf8');

function extractFunction(name: string): string {
  const marker = `function ${name}`;
  const start = source.indexOf(marker);
  if (start < 0) throw new Error(`missing ${name}`);
  const braceStart = source.indexOf('{', start);
  if (braceStart < 0) throw new Error(`missing body for ${name}`);
  let depth = 0;
  for (let i = braceStart; i < source.length; i += 1) {
    const ch = source[i];
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  throw new Error(`unterminated ${name}`);
}

function extractFunctionUntil(name: string, nextName: string): string {
  const start = source.indexOf(`function ${name}`);
  const end = source.indexOf(`\nfunction ${nextName}`, start);
  if (start < 0 || end < 0) throw new Error(`missing ${name} or ${nextName}`);
  return source.slice(start, end).trim();
}

class FakePlaceholder {
  dataset: Record<string, string>;
  parentElement: any = {};

  constructor(dataset: Record<string, string>) {
    this.dataset = { ...dataset };
  }
}

class FakeChatMessage extends FakePlaceholder {
  readonly classList: { contains: (name: string) => boolean };
  readonly processLines: string[];
  removed = false;

  constructor(
    classes: string[],
    dataset: Record<string, string>,
    processLines: string[] = [],
  ) {
    super(dataset);
    const names = new Set(classes);
    this.classList = { contains: (name: string) => names.has(name) };
    this.processLines = processLines;
  }

  remove() {
    this.removed = true;
    this.parentElement?.removeChild(this);
    this.parentElement = null;
  }
}

class FakeHistoryContainer {
  messages: FakeChatMessage[] = [];

  append(...messages: FakeChatMessage[]) {
    for (const message of messages) {
      message.parentElement = this;
      this.messages.push(message);
    }
  }

  prepend(message: FakeChatMessage) {
    message.parentElement = this;
    this.messages.unshift(message);
  }

  removeChild(message: FakeChatMessage) {
    this.messages = this.messages.filter((candidate) => candidate !== message);
  }

  querySelectorAll(selector: string) {
    if (selector !== ':scope > .chat-message') throw new Error(`unexpected selector: ${selector}`);
    return this.messages.slice();
  }
}

class FakeDanglingPlaceholder {
  parentElement: Record<string, never> | null = {};
  removed = false;

  constructor(
    private processCount: number,
    private finalText = '',
  ) {}

  querySelector(selector: string) {
    if (selector === '[data-role="process"]') {
      return { children: Array.from({ length: this.processCount }) };
    }
    if (selector === '[data-role="final"]') {
      return { textContent: this.finalText };
    }
    return null;
  }

  remove() {
    this.removed = true;
    this.parentElement = null;
  }
}

/** A record is claimed by its own render key, so the harness needs the same key
 * helpers production uses plus a container that resolves `data-render-key`. */
function loadClaimHelpers(nodes: FakePlaceholder[] = []): {
  placeholders: Map<string, FakePlaceholder>;
  claim: (cid: string, gm: Record<string, unknown>) => FakePlaceholder | null;
  key: (cid: string, renderKey: string) => string;
} {
  const container = {
    querySelector(selector: string) {
      const renderKey = selector.match(/data-render-key="([^"]+)"/)?.[1];
      if (!renderKey) return null;
      return nodes.find((node) => node.dataset.renderKey === renderKey) || null;
    },
  };
  const sandbox: any = {
    document: { getElementById: () => container },
    CSS: { escape: (value: string) => value },
    window: {},
  };
  const fns = [
    'const _groupPlaceholders = new Map();',
    extractFunction('_normaliseTurnId'),
    extractFunction('_conversationViewModel'),
    extractFunction('_segmentRenderKey'),
    extractFunction('_messageRenderKey'),
    extractFunction('_phKey'),
    extractFunction('_findRenderNode'),
    extractFunction('_claimRenderNodeForMessage'),
    '({ placeholders: _groupPlaceholders, claim: _claimRenderNodeForMessage, key: _phKey });',
  ].join('\n');
  return vm.runInNewContext(fns, sandbox);
}

function loadPlaceholderHelpers(): {
  placeholders: Map<string, FakePlaceholder>;
  key: (cid: string, renderKey: string) => string;
} {
  const fns = [
    'const _groupPlaceholders = new Map();',
    extractFunction('_normaliseTurnId'),
    extractFunction('_phKey'),
    '({ placeholders: _groupPlaceholders, key: _phKey });',
  ].join('\n');
  return vm.runInNewContext(fns, {});
}

function loadActivityHelpers() {
  let wallNow = 110_000;
  let monotonicNow = 1_000;
  const sandbox = {
    performance: { now: () => monotonicNow },
    Date: { now: () => wallNow },
    t: (key: string, vars?: { n?: number }) => key === 'chat.activity_tools' ? `${vars?.n} tools` : key,
  };
  const helpers = vm.runInNewContext([
    extractFunction('_normaliseTurnId'),
    extractFunction('_normaliseActiveTurns'),
    extractFunction('_seedPlaceholderActivityStart'),
    extractFunction('_activityMonotonicNow'),
    'const _updateStreamingRuntimeSummary = (msg, _evt, elapsedMs) => { msg.runtimeElapsedMs = elapsedMs; };',
    extractFunction('_streamingPaintActivityMeta'),
    '({ normalise: _normaliseActiveTurns, seed: _seedPlaceholderActivityStart, paint: _streamingPaintActivityMeta });',
  ].join('\n'), sandbox) as {
    normalise: (raw: unknown[]) => Array<Record<string, unknown>>;
    seed: (ph: { dataset: Record<string, string> }, startedAtMs: number) => void;
    paint: (msg: Record<string, any>) => void;
  };
  return {
    ...helpers,
    setTimes: (wall: number, monotonic: number) => {
      wallNow = wall;
      monotonicNow = monotonic;
    },
  };
}

function loadInterruptionHelpers() {
  return vm.runInNewContext([
    extractFunctionUntil('_groupMessageSystemKind', '_collapseSupersededInterruptionRecords'),
    extractFunctionUntil('_collapseSupersededInterruptionRecords', '_groupMsgToLegacy'),
    extractFunction('_isChatMessageEl'),
    extractFunction('_hasChatMessageClass'),
    extractFunction('_removeSupersededInterruptionBubbles'),
    '({ systemKind: _groupMessageSystemKind, collapse: _collapseSupersededInterruptionRecords, removeBubbles: _removeSupersededInterruptionBubbles });',
  ].join('\n'), { Map }) as {
    systemKind: (message: Record<string, unknown>) => string;
    collapse: (messages: Array<Record<string, unknown>>) => Array<Record<string, unknown>>;
    removeBubbles: (container: FakeHistoryContainer) => number;
  };
}

function loadSettleHelper(
  placeholders: Map<string, FakeDanglingPlaceholder>,
  orphans: FakeDanglingPlaceholder[],
) {
  const sandbox = {
    placeholders,
    orphans,
    purges: [] as Array<Record<string, unknown>>,
  };
  return vm.runInNewContext([
    'const _groupPlaceholders = placeholders;',
    'const document = { getElementById: () => ({ querySelectorAll: () => orphans }) };',
    'const _convLog = { info: (_message, data) => purges.push(data) };',
    extractFunctionUntil('_settleDanglingActorPlaceholders', '_nowForStreamYield'),
    '({ settle: _settleDanglingActorPlaceholders, purges });',
  ].join('\n'), sandbox) as {
    settle: (cid: string, opts?: { preserveProcess?: boolean }) => void;
    purges: Array<Record<string, unknown>>;
  };
}

describe('conversation record claim by render key', () => {
  // The segment a record persists is the segment its stream wrote to. Claiming
  // it is a lookup, not a search: the previous implementation walked a
  // three-level fallback (exact turn key → actor-only legacy key → any
  // unfinalized row of the same actor) and a miss at every level appended a
  // second bubble beside the live one — the duplicate the user saw.
  it('claims the live row whose render key the record carries', () => {
    const live = new FakePlaceholder({ fromActor: 'commander', renderKey: 's:turn-1:0' });
    const { claim } = loadClaimHelpers([live]);

    const claimed = claim('cid-1', { id: 'm1', from: 'commander', turn_id: 'turn-1', seg: 0 });

    expect(claimed).toBe(live);
    expect(live.dataset.finalized).toBe('1');
  });

  it('does not claim a row from a different segment or turn', () => {
    const otherSegment = new FakePlaceholder({ fromActor: 'commander', renderKey: 's:turn-1:0' });
    const otherTurn = new FakePlaceholder({ fromActor: 'commander', renderKey: 's:turn-2:1' });
    const { claim } = loadClaimHelpers([otherSegment, otherTurn]);

    expect(claim('cid-1', { id: 'm1', from: 'commander', turn_id: 'turn-1', seg: 1 })).toBeNull();
    expect(otherSegment.dataset.finalized).toBeUndefined();
    expect(otherTurn.dataset.finalized).toBeUndefined();
  });

  // Re-delivery of a record must not re-claim a row that already settled;
  // otherwise the next turn's deltas would stream into a finished bubble.
  it('does not re-claim a row that already settled', () => {
    const settled = new FakePlaceholder({
      fromActor: 'commander', renderKey: 's:turn-1:0', finalized: '1',
    });
    const { claim } = loadClaimHelpers([settled]);

    expect(claim('cid-1', { id: 'm1', from: 'commander', turn_id: 'turn-1', seg: 0 })).toBeNull();
  });

  it('claims an optimistic user bubble by its echoed client id', () => {
    const optimistic = new FakePlaceholder({ renderKey: 'u:c-aaa' });
    const { claim } = loadClaimHelpers([optimistic]);

    expect(claim('cid-1', { id: 'u1', from: 'user', client_msg_id: 'c-aaa' })).toBe(optimistic);
  });

  it('keeps process-bearing abort placeholders until the persisted message consumes them', () => {
    const processPlaceholder = new FakeDanglingPlaceholder(2);
    const emptyPlaceholder = new FakeDanglingPlaceholder(0);
    const placeholders = new Map<string, FakeDanglingPlaceholder>([
      ['cid-1|s:turn-1:0', processPlaceholder],
      ['cid-1|s:turn-2:0', emptyPlaceholder],
    ]);
    const { settle, purges } = loadSettleHelper(placeholders, [processPlaceholder, emptyPlaceholder]);

    settle('cid-1', { preserveProcess: true });

    expect(processPlaceholder.removed).toBe(false);
    expect(placeholders.get('cid-1|s:turn-1:0')).toBe(processPlaceholder);
    expect(emptyPlaceholder.removed).toBe(true);
    expect(placeholders.has('cid-1|s:turn-2:0')).toBe(false);
    expect(purges).toEqual([{ cid: 'cid-1', count: 1, preserved: 1 }]);
  });

  it('purges the same process placeholder after a normal stream completion', () => {
    const processPlaceholder = new FakeDanglingPlaceholder(1, 'partial reply');
    const placeholders = new Map<string, FakeDanglingPlaceholder>([
      ['cid-1|s:turn-1:0', processPlaceholder],
    ]);
    const { settle } = loadSettleHelper(placeholders, [processPlaceholder]);

    settle('cid-1');

    expect(processPlaceholder.removed).toBe(true);
    expect(placeholders.size).toBe(0);
  });
});

describe('conversation interruption bubble collapse', () => {
  it('recognizes legacy host-authored interruption rows', () => {
    const { systemKind } = loadInterruptionHelpers();
    expect(systemKind({
      model_text: 'The previous assistant run was interrupted by an application exit or crash before it produced a complete reply.',
    })).toBe('reply_interrupted');
  });

  it('removes a superseded same-actor interruption without crossing a user message', () => {
    const { collapse } = loadInterruptionHelpers();
    const interruption = { id: 'status', from: 'video-studio', system_kind: 'reply_interrupted' };
    const resumed = { id: 'answer', from: 'video-studio', turn_id: 'turn-2' };

    expect(collapse([interruption, resumed]).map((row) => row.id)).toEqual(['answer']);
    expect(collapse([
      interruption,
      { ...interruption, id: 'status-new' },
      resumed,
    ]).map((row) => row.id)).toEqual(['answer']);
    expect(collapse([
      interruption,
      { id: 'user-2', from: 'user' },
      resumed,
    ]).map((row) => row.id)).toEqual(['status', 'user-2', 'answer']);
  });

  it('hides a legacy false interruption appended after the same actor completed', () => {
    const { collapse } = loadInterruptionHelpers();
    const terminal = {
      id: 'terminal',
      from: 'video-studio',
      turn_id: 'turn-1',
      source_message_id: 'user-1',
    };
    const interruption = {
      id: 'false-status',
      from: 'video-studio',
      system_kind: 'reply_interrupted',
    };

    expect(collapse([terminal, interruption]).map((row) => row.id))
      .toEqual(['terminal']);
    expect(collapse([
      terminal,
      { id: 'user-2', from: 'user' },
      interruption,
    ]).map((row) => row.id)).toEqual(['terminal', 'user-2', 'false-status']);
  });

  // Polling no longer renders while runtime is busy (the bus observer is the
  // sole event producer), so the old "polled row must not claim the live turn"
  // arm of this case is gone with that path. What still has to hold is the DOM
  // repair: however many interruption rows earlier crashes left above the
  // resumed actor bubble, the user must end up with one bubble and an intact
  // progress rail.
  it('collapses stale interruption rows above a resumed VideoStudio bubble without disturbing its progress rail', () => {
    const { placeholders, key } = loadPlaceholderHelpers();
    const { removeBubbles } = loadInterruptionHelpers();
    const history = new FakeHistoryContainer();
    const staleInterruptions = Array.from({ length: 6 }, (_, index) => new FakeChatMessage(
      ['chat-message', 'assistant'],
      {
        fromActor: 'video-studio',
        msgId: `interruption-${index + 1}`,
        systemKind: 'reply_interrupted',
      },
    ));
    const progressLines = [
      'Captured frame 841/4950.',
      'Captured frame 901/4950.',
      'Captured frame 1681/4950.',
    ];
    const live = new FakeChatMessage(
      ['chat-message', 'assistant'],
      {
        fromActor: 'video-studio',
        placeholder: '1',
        turnId: 'video-turn-live',
      },
      progressLines,
    );
    history.append(...staleInterruptions, live);
    placeholders.set(key('cid-video', 's:video-turn-live:0'), live);

    // Learning the resumed placeholder's actor identity performs the same DOM
    // cleanup as the production renderer. Even repeated crashes must not leave
    // a stack of assistant bubbles above the continuing progress rail.
    removeBubbles(history);
    expect(history.messages).toEqual([live]);
    expect(staleInterruptions.every((message) => message.removed)).toBe(true);
    expect(live.processLines).toEqual(progressLines);
    // The live turn stays claimable — repair must not finalize it out from
    // under the stream that is still writing to it.
    expect(live.dataset.finalized).toBeUndefined();
    expect(placeholders.get(key('cid-video', 's:video-turn-live:0'))).toBe(live);

    // Progress continues after the repair, on the same bubble.
    live.processLines.push('Captured frame 4921/4950.');
    expect(live.processLines.at(-1)).toBe('Captured frame 4921/4950.');
    expect(history.messages).toHaveLength(1);
  });

  it('repairs a false interruption row mounted beside a currently running VideoStudio bubble', () => {
    const { placeholders, key } = loadPlaceholderHelpers();
    const { removeBubbles } = loadInterruptionHelpers();
    const history = new FakeHistoryContainer();
    const live = new FakeChatMessage(
      ['chat-message', 'assistant'],
      {
        fromActor: 'video-studio',
        placeholder: '1',
        turnId: 'turn-that-kept-running',
      },
      ['read_file · 完成', 'video_studio · 完成', '正在整理当前轮工具上下文'],
    );
    history.append(live);
    placeholders.set(key('cid-video', 's:turn-that-kept-running:0'), live);

    // This is the exact screenshot order: the live bubble already exists, then
    // deferred boot maintenance writes an uncorrelated interruption row for the
    // same actor. It must be repaired away rather than left below the bubble
    // the user is still watching.
    const falseInterruption = new FakeChatMessage(
      ['chat-message', 'assistant'],
      { fromActor: 'video-studio', msgId: 'false-boot-status', systemKind: 'reply_interrupted' },
    );
    history.append(falseInterruption);

    expect(removeBubbles(history)).toBe(1);
    expect(falseInterruption.removed).toBe(true);
    expect(history.messages).toEqual([live]);
    // The running turn must survive the repair unclaimed and still streaming.
    expect(live.dataset.finalized).toBeUndefined();
    expect(placeholders.get(key('cid-video', 's:turn-that-kept-running:0'))).toBe(live);
  });

  it('collapses an interruption loaded from an older page against a newer same-actor bubble', () => {
    const { removeBubbles } = loadInterruptionHelpers();
    const history = new FakeHistoryContainer();
    const resumed = new FakeChatMessage(
      ['chat-message', 'assistant'],
      { fromActor: 'video-studio', msgId: 'resumed-answer', turnId: 'turn-2' },
    );
    history.append(resumed);

    // Older-history paging prepends records after the newer page is already
    // mounted. The record-only collapse cannot see across that page boundary,
    // so the DOM pass must remove the stale bubble.
    const olderInterruption = new FakeChatMessage(
      ['chat-message', 'assistant'],
      { fromActor: 'video-studio', msgId: 'old-status', systemKind: 'reply_interrupted' },
    );
    history.prepend(olderInterruption);
    removeBubbles(history);

    expect(olderInterruption.removed).toBe(true);
    expect(history.messages).toEqual([resumed]);
  });

  it('preserves a genuine prior-turn interruption when a user message starts the resumed turn', () => {
    const { removeBubbles } = loadInterruptionHelpers();
    const history = new FakeHistoryContainer();
    const interrupted = new FakeChatMessage(
      ['chat-message', 'assistant'],
      { fromActor: 'video-studio', msgId: 'prior-status', systemKind: 'reply_interrupted' },
    );
    const user = new FakeChatMessage(
      ['chat-message', 'user'],
      { msgId: 'continue-request' },
    );
    const resumed = new FakeChatMessage(
      ['chat-message', 'assistant'],
      { fromActor: 'video-studio', msgId: 'next-answer', turnId: 'turn-next' },
    );
    history.append(interrupted, user, resumed);

    removeBubbles(history);

    expect(interrupted.removed).toBe(false);
    expect(history.messages).toEqual([interrupted, user, resumed]);
  });
});

describe('conversation activity elapsed clock', () => {
  it('hydrates a replacement placeholder from the stable backend turn start', () => {
    const { normalise, seed } = loadActivityHelpers();
    const [turn] = normalise([{
      actor: 'agent-1',
      turn_id: 'turn-1',
      steerable: true,
      started_at_ms: 10_000,
    }]);
    const replacement = { dataset: {} as Record<string, string> };

    seed(replacement, turn.started_at_ms as number);
    expect(replacement.dataset.activityStart).toBe('10000');
    expect(turn.steerable).toBe(true);

    // A later recovery signal for the same DOM node must not move the origin
    // forward and make elapsed time jump backwards.
    seed(replacement, 20_000);
    expect(replacement.dataset.activityStart).toBe('10000');
  });

  it('keeps the summary elapsed clock advancing when the wall clock moves backwards', () => {
    const { paint, setTimes } = loadActivityHelpers();
    const msg: Record<string, any> = {
      dataset: { activityStart: '10000', activityTools: '2' },
      querySelector: () => null,
    };

    paint(msg);
    expect(msg.runtimeElapsedMs).toBe(100_000);

    setTimes(30_000, 2_000);
    paint(msg);
    expect(msg.runtimeElapsedMs).toBe(101_000);
  });
});
