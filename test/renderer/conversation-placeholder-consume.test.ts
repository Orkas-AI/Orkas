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

class FakePlaceholder {
  dataset: Record<string, string>;
  parentElement = {};

  constructor(dataset: Record<string, string>) {
    this.dataset = { ...dataset };
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
});
