import { describe, it, expect } from 'vitest';
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

function loadDedupeKey(): (evData: Record<string, unknown>) => string {
  const fnSource = extractFunction('_groupEventDedupeKey');
  return vm.runInNewContext(`(${fnSource})`, {});
}

function toolProgress(message: string, data: Record<string, unknown> = {}) {
  return {
    type: 'process',
    actor: 'commander',
    turn_id: 'turn-1',
    data: {
      type: 'event',
      event: {
        stream: 'tool',
        data: {
          phase: 'progress',
          id: 'call-video',
          name: 'generate_image',
          message,
          progress_phase: 'poll',
          progress_data: data,
        },
      },
    },
  };
}

function processEvent(stream: string, data: Record<string, unknown>) {
  return {
    type: 'process',
    actor: 'commander',
    turn_id: 'turn-1',
    data: {
      type: 'event',
      event: { stream, data },
    },
  };
}

describe('conversation process event dedupe', () => {
  it('keeps distinct progress messages for the same tool call renderable', () => {
    const key = loadDedupeKey();

    expect(key(toolProgress('waiting 10s before poll 1'))).not.toBe(
      key(toolProgress('waiting 10s before poll 2')),
    );
  });

  it('still dedupes identical progress events from duplicate live streams', () => {
    const key = loadDedupeKey();

    expect(key(toolProgress('waiting 10s before poll 1', { elapsedMs: 10000 }))).toBe(
      key(toolProgress('waiting 10s before poll 1', { elapsedMs: 10000 })),
    );
  });

  it('dedupes context compaction and runtime metadata events by stable payload', () => {
    const key = loadDedupeKey();

    expect(key(processEvent('compaction', { tokensBefore: 20000, tokensAfter: 3000 }))).toBe(
      key(processEvent('compaction', { tokensBefore: 20000, tokensAfter: 3000 })),
    );
    expect(key(processEvent('runtime', { duration_ms: 65000, status: 'success' }))).toBe(
      key(processEvent('runtime', { duration_ms: 65000, status: 'success' })),
    );
  });
});
