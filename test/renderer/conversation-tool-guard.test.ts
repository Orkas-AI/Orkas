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

function loadEventProcessKind(): (evt: Record<string, unknown>, text?: string) => string {
  return vm.runInNewContext(`
    function _processKindOf() { return 'meta'; }
    (${extractFunction('_eventProcessKind')});
  `, {});
}

describe('conversation tool guard rendering', () => {
  it('renders compacted-history placeholder guard as recoverable tool info', () => {
    const eventProcessKind = loadEventProcessKind();

    expect(eventProcessKind({
      stream: 'tool',
      data: {
        phase: 'end',
        name: 'bash',
        isError: true,
        errorCode: 'E_COMPACTED_HISTORY_PLACEHOLDER',
        errorSeverity: 'recoverable',
      },
    })).toBe('tool');

    expect(eventProcessKind({
      stream: 'tool',
      data: {
        phase: 'end',
        name: 'bash',
        isError: true,
      },
    })).toBe('err');
  });
});
