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

function loadEventName(): (evt: unknown) => string {
  const fnSource = extractFunction('_processEventName');
  return vm.runInNewContext(`(${fnSource})`, {});
}

// `_processEventName` is the tag that drives the `turn_silent` handoff-only
// drop: a process line inherits it as `dataset.eventName`, and the handler
// removes a silent placeholder only when EVERY line is `hand_off_to`. So the
// only-hand_off_to bubble goes away iff this reliably names hand_off_to across
// the two event shapes and stays '' for everything else (which keeps the
// freeze path for real work like plan_set / reads).
describe('_processEventName (turn_silent handoff-only tagging)', () => {
  it('names an in-process hand_off_to tool event', () => {
    const nameOf = loadEventName();
    expect(nameOf({ stream: 'tool', data: { phase: 'end', name: 'hand_off_to' } })).toBe('hand_off_to');
    // toolName fallback shape
    expect(nameOf({ stream: 'tool', data: { toolName: 'hand_off_to' } })).toBe('hand_off_to');
  });

  it('names a CLI-backed hand_off_to tool-event', () => {
    const nameOf = loadEventName();
    expect(nameOf({ stream: 'cli', data: { type: 'tool-event', tool: 'hand_off_to', phase: 'result' } }))
      .toBe('hand_off_to');
  });

  it('names other tools by their real name (so a mixed trail is NOT handoff-only)', () => {
    const nameOf = loadEventName();
    expect(nameOf({ stream: 'tool', data: { name: 'read_file' } })).toBe('read_file');
    expect(nameOf({ stream: 'cli', data: { type: 'tool-event', tool: 'read_file' } })).toBe('read_file');
  });

  it('returns "" for non-tool events (plan_set / thinking / deltas keep the freeze path)', () => {
    const nameOf = loadEventName();
    expect(nameOf({ stream: 'plan', data: { steps: [] } })).toBe('');
    expect(nameOf({ stream: 'item', data: {} })).toBe('');
    expect(nameOf({ stream: 'assistant', data: { delta: 'hi' } })).toBe('');
    expect(nameOf({ stream: 'cli', data: { type: 'status', status: 'running' } })).toBe('');
  });

  it('is null-safe', () => {
    const nameOf = loadEventName();
    expect(nameOf(null)).toBe('');
    expect(nameOf(undefined)).toBe('');
    expect(nameOf({})).toBe('');
  });
});
