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

function loadPlaceholderHelpers(): {
  placeholders: Map<string, FakePlaceholder>;
  consume: (
    cid: string,
    actorId: string,
    turnId?: string,
    opts?: { allowActorFallback?: boolean },
  ) => FakePlaceholder | null;
  consumeHistory: (cid: string, gm: Record<string, unknown>) => FakePlaceholder | null;
  deferHistory: (cid: string, gm: Record<string, unknown>) => boolean;
  key: (cid: string, actorId: string, turnId?: string) => string;
} {
  const fns = [
    'const _groupPlaceholders = new Map();',
    extractFunction('_normaliseTurnId'),
    extractFunction('_phKey'),
    extractFunction('_groupMessageSystemKind'),
    extractFunctionUntil('_consumeActorPlaceholder', '_consumePlaceholderForHistoryRecord'),
    extractFunctionUntil('_consumePlaceholderForHistoryRecord', '_finalizeActorPlaceholder'),
    '({ placeholders: _groupPlaceholders, consume: _consumeActorPlaceholder, consumeHistory: _consumePlaceholderForHistoryRecord, deferHistory: _shouldDeferInterruptedHistoryRecord, key: _phKey });',
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

describe('conversation actor placeholder consume', () => {
  it('falls back to the same live actor when a segment event misses the exact turn id', () => {
    const { placeholders, consume, key } = loadPlaceholderHelpers();
    const ph = new FakePlaceholder({
      fromActor: 'commander',
      turnId: 'old-turn',
      streamBuf: '查看已有的页面文件，然后交给 @UIDesigner 进行优化。',
      activityStart: '1000',
    });
    placeholders.set(key('cid-1', 'commander', 'old-turn'), ph);

    expect(consume('cid-1', 'commander', 'new-turn')).toBe(ph);
    expect(ph.dataset.finalized).toBe('1');
    expect(placeholders.size).toBe(0);
  });

  it('does not consume finalized or different-actor placeholders during fallback', () => {
    const { placeholders, consume, key } = loadPlaceholderHelpers();
    const done = new FakePlaceholder({ fromActor: 'commander', finalized: '1' });
    const agent = new FakePlaceholder({ fromActor: 'agent-1' });
    placeholders.set(key('cid-1', 'commander', 'old-turn'), done);
    placeholders.set(key('cid-1', 'agent-1', 'turn-2'), agent);

    expect(consume('cid-1', 'commander', 'new-turn')).toBeNull();
    expect(placeholders.get(key('cid-1', 'commander', 'old-turn'))).toBe(done);
    expect(placeholders.get(key('cid-1', 'agent-1', 'turn-2'))).toBe(agent);
  });

  it('does not let an uncorrelated polled row consume a live same-actor turn', () => {
    const { placeholders, consumeHistory, deferHistory, key } = loadPlaceholderHelpers();
    const active = new FakePlaceholder({ fromActor: 'video-studio', turnId: 'turn-live' });
    placeholders.set(key('cid-1', 'video-studio', 'turn-live'), active);

    expect(consumeHistory('cid-1', {
      id: 'interruption-row',
      from: 'video-studio',
      system_kind: 'reply_interrupted',
    })).toBeNull();
    expect(deferHistory('cid-1', {
      id: 'interruption-row',
      from: 'video-studio',
      system_kind: 'reply_interrupted',
    })).toBe(true);
    expect(consumeHistory('cid-1', {
      id: 'legacy-row-without-turn',
      from: 'video-studio',
    })).toBeNull();
    expect(active.dataset.finalized).toBeUndefined();
    expect(placeholders.get(key('cid-1', 'video-studio', 'turn-live'))).toBe(active);
  });

  it('claims a genuine boot interruption only from its actor-only legacy placeholder', () => {
    const { placeholders, consumeHistory, key } = loadPlaceholderHelpers();
    const interrupted = new FakePlaceholder({ fromActor: 'video-studio' });
    const resumed = new FakePlaceholder({ fromActor: 'video-studio', turnId: 'turn-live' });
    placeholders.set(key('cid-old', 'video-studio'), interrupted);
    placeholders.set(key('cid-live', 'video-studio', 'turn-live'), resumed);
    const status = {
      id: 'interruption-row',
      from: 'video-studio',
      system_kind: 'reply_interrupted',
    };

    expect(consumeHistory('cid-old', status)).toBe(interrupted);
    expect(interrupted.dataset.finalized).toBe('1');
    expect(consumeHistory('cid-live', status)).toBeNull();
    expect(resumed.dataset.finalized).toBeUndefined();
    expect(placeholders.get(key('cid-live', 'video-studio', 'turn-live'))).toBe(resumed);
  });

  it('claims a polled terminal row only for its exact persisted turn id', () => {
    const { placeholders, consumeHistory, key } = loadPlaceholderHelpers();
    const old = new FakePlaceholder({ fromActor: 'video-studio', turnId: 'turn-old' });
    const active = new FakePlaceholder({ fromActor: 'video-studio', turnId: 'turn-live' });
    placeholders.set(key('cid-1', 'video-studio', 'turn-old'), old);
    placeholders.set(key('cid-1', 'video-studio', 'turn-live'), active);

    expect(consumeHistory('cid-1', {
      id: 'terminal-row',
      from: 'video-studio',
      turn_id: 'turn-old',
    })).toBe(old);
    expect(old.dataset.finalized).toBe('1');
    expect(active.dataset.finalized).toBeUndefined();
    expect(placeholders.get(key('cid-1', 'video-studio', 'turn-live'))).toBe(active);
  });

  it('keeps process-bearing abort placeholders until the persisted message consumes them', () => {
    const processPlaceholder = new FakeDanglingPlaceholder(2);
    const emptyPlaceholder = new FakeDanglingPlaceholder(0);
    const placeholders = new Map<string, FakeDanglingPlaceholder>([
      ['cid-1:agent-1:turn-1', processPlaceholder],
      ['cid-1:agent-2:turn-2', emptyPlaceholder],
    ]);
    const { settle, purges } = loadSettleHelper(placeholders, [processPlaceholder, emptyPlaceholder]);

    settle('cid-1', { preserveProcess: true });

    expect(processPlaceholder.removed).toBe(false);
    expect(placeholders.get('cid-1:agent-1:turn-1')).toBe(processPlaceholder);
    expect(emptyPlaceholder.removed).toBe(true);
    expect(placeholders.has('cid-1:agent-2:turn-2')).toBe(false);
    expect(purges).toEqual([{ cid: 'cid-1', count: 1, preserved: 1 }]);
  });

  it('purges the same process placeholder after a normal stream completion', () => {
    const processPlaceholder = new FakeDanglingPlaceholder(1, 'partial reply');
    const placeholders = new Map<string, FakeDanglingPlaceholder>([
      ['cid-1:agent-1:turn-1', processPlaceholder],
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

  it('keeps exactly one VideoStudio bubble through stale polling, resumed progress, and terminal persistence', () => {
    const { placeholders, consumeHistory, key } = loadPlaceholderHelpers();
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
    placeholders.set(key('cid-video', 'video-studio', 'video-turn-live'), live);

    // Startup polling can replay one or several interruption rows written by
    // earlier app exits. None may finalize the currently resumed actor turn.
    for (const interruption of staleInterruptions) {
      expect(consumeHistory('cid-video', {
        id: interruption.dataset.msgId,
        from: 'video-studio',
        system_kind: 'reply_interrupted',
      })).toBeNull();
    }
    expect(live.dataset.finalized).toBeUndefined();
    expect(placeholders.get(key('cid-video', 'video-studio', 'video-turn-live'))).toBe(live);

    // Learning the resumed placeholder's actor identity performs the same DOM
    // cleanup as the production renderer. Even repeated crashes must not leave
    // a stack of assistant bubbles above the continuing progress rail.
    removeBubbles(history);
    expect(history.messages).toEqual([live]);
    expect(staleInterruptions.every((message) => message.removed)).toBe(true);
    expect(live.processLines).toEqual(progressLines);

    live.processLines.push('Captured frame 4921/4950.');
    expect(consumeHistory('cid-video', {
      id: 'video-final',
      from: 'video-studio',
      turn_id: 'video-turn-live',
    })).toBe(live);
    expect(live.dataset.finalized).toBe('1');
    expect(live.processLines.at(-1)).toBe('Captured frame 4921/4950.');
    expect(history.messages).toHaveLength(1);
  });

  it('does not append a false interruption below a currently running VideoStudio bubble', () => {
    const { placeholders, consumeHistory, deferHistory, key } = loadPlaceholderHelpers();
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
    placeholders.set(key('cid-video', 'video-studio', 'turn-that-kept-running'), live);
    const falseInterruption = {
      id: 'false-boot-status',
      from: 'video-studio',
      system_kind: 'reply_interrupted',
    };

    // This is the exact screenshot order: the live bubble already exists,
    // then deferred boot maintenance writes an uncorrelated interruption.
    const claimed = consumeHistory('cid-video', falseInterruption);
    expect(claimed).toBeNull();
    expect(deferHistory('cid-video', falseInterruption)).toBe(true);
    if (!claimed && !deferHistory('cid-video', falseInterruption)) {
      history.append(new FakeChatMessage(
        ['chat-message', 'assistant'],
        { fromActor: 'video-studio', systemKind: 'reply_interrupted' },
      ));
    }

    expect(live.dataset.finalized).toBeUndefined();
    expect(history.messages).toEqual([live]);

    // Also repair a row mounted by an older renderer before this guard ran.
    const alreadyMounted = new FakeChatMessage(
      ['chat-message', 'assistant'],
      { fromActor: 'video-studio', systemKind: 'reply_interrupted' },
    );
    history.append(alreadyMounted);
    expect(removeBubbles(history)).toBe(1);
    expect(alreadyMounted.removed).toBe(true);
    expect(history.messages).toEqual([live]);
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
      started_at_ms: 10_000,
    }]);
    const replacement = { dataset: {} as Record<string, string> };

    seed(replacement, turn.started_at_ms as number);
    expect(replacement.dataset.activityStart).toBe('10000');

    // A later recovery signal for the same DOM node must not move the origin
    // forward and make elapsed time jump backwards.
    seed(replacement, 20_000);
    expect(replacement.dataset.activityStart).toBe('10000');
  });

  it('keeps advancing monotonically when the wall clock moves backwards', () => {
    const { paint, setTimes } = loadActivityHelpers();
    const meta = { textContent: '' };
    const msg: Record<string, any> = {
      dataset: { activityStart: '10000', activityTools: '2' },
      querySelector: () => meta,
    };

    paint(msg);
    expect(meta.textContent).toBe('2 tools · 1:40');

    setTimes(30_000, 2_000);
    paint(msg);
    expect(meta.textContent).toBe('2 tools · 1:41');
  });
});
