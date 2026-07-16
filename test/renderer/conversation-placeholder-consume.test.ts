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
  parentElement = {};

  constructor(dataset: Record<string, string>) {
    this.dataset = { ...dataset };
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
  consume: (cid: string, actorId: string, turnId?: string) => FakePlaceholder | null;
  key: (cid: string, actorId: string, turnId?: string) => string;
} {
  const fns = [
    'const _groupPlaceholders = new Map();',
    extractFunction('_normaliseTurnId'),
    extractFunction('_phKey'),
    extractFunction('_consumeActorPlaceholder'),
    '({ placeholders: _groupPlaceholders, consume: _consumeActorPlaceholder, key: _phKey });',
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
