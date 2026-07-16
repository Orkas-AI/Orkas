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

function extractConst(name: string): string {
  const re = new RegExp(`const ${name} = [^;]*;`);
  const m = source.match(re);
  if (!m) throw new Error(`missing const ${name}`);
  return m[0];
}

// `_isRoutingOnlyEventNames` closes over the two routing tool-name Sets, so eval
// them in the same script scope as the function.
function loadRoutingOnly(): (names: string[]) => boolean {
  const combined = [
    extractConst('_ROUTING_TOOL_NAMES'),
    extractConst('_ROUTING_SUPPORT_TOOL_NAMES'),
    `(${extractFunction('_isRoutingOnlyEventNames')})`,
  ].join('\n');
  return vm.runInNewContext(combined, {});
}

// `_isRoutingOnlyProcessItems` classifies a persisted `process` array (the jsonl
// shape) by resolving each item's tool name via `_processEventName`. Eval it
// with its whole dependency chain in one scope.
function loadRoutingOnlyItems(): (items: unknown[]) => boolean {
  const combined = [
    extractConst('_ROUTING_TOOL_NAMES'),
    extractConst('_ROUTING_SUPPORT_TOOL_NAMES'),
    extractFunction('_processEventName'),
    extractFunction('_isRoutingOnlyEventNames'),
    `(${extractFunction('_isRoutingOnlyProcessItems')})`,
  ].join('\n');
  return vm.runInNewContext(combined, {});
}

function loadSuccessfulTerminalHandoff(): (items: unknown[]) => boolean {
  const combined = [
    extractFunction('_processEventName'),
    `(${extractFunction('_processItemsContainSuccessfulTerminalHandoff')})`,
  ].join('\n');
  return vm.runInNewContext(combined, {});
}

function loadShouldDiscardSilentPlaceholder(): (reason: string, names: string[]) => boolean {
  const combined = [
    extractConst('_ROUTING_TOOL_NAMES'),
    extractConst('_ROUTING_SUPPORT_TOOL_NAMES'),
    extractFunction('_isRoutingOnlyEventNames'),
    `(${extractFunction('_shouldDiscardSilentPlaceholder')})`,
  ].join('\n');
  return vm.runInNewContext(combined, {});
}

function loadRedundantCommanderRecord(): (record: unknown) => boolean {
  const combined = [
    extractConst('_ROUTING_TOOL_NAMES'),
    extractConst('_ROUTING_SUPPORT_TOOL_NAMES'),
    'const _normalizeCreatedAgents = () => null;',
    'const _normalizeCreatedSkills = () => null;',
    extractFunction('_processEventName'),
    extractFunction('_isRoutingOnlyEventNames'),
    extractFunction('_isRoutingOnlyProcessItems'),
    extractFunction('_processItemsContainSuccessfulTerminalHandoff'),
    `(${extractFunction('_isRedundantRoutingOnlyCommanderRecord')})`,
  ].join('\n');
  return vm.runInNewContext(combined, {});
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

// The turn_silent handler drops a commander placeholder when its process trail
// "only routed". `_isRoutingOnlyEventNames` is that classifier over the per-line
// `dataset.eventName` tags. It must drop the real-world trigger (a prep
// `read_file <agent>/agent.json` before `hand_off_to`) while still freezing any
// trail that did real work.
describe('_isRoutingOnlyEventNames (turn_silent routing-only drop)', () => {
  it('drops a prep-read + hand_off_to trail (the DeepResearcher bug)', () => {
    const routingOnly = loadRoutingOnly();
    // read agent.json ×2, then hand_off_to — the screenshot's second bubble.
    expect(routingOnly(['read_file', 'read_file', 'hand_off_to'])).toBe(true);
  });

  it('drops a pure hand_off_to / dispatch_to trail', () => {
    const routingOnly = loadRoutingOnly();
    expect(routingOnly(['hand_off_to'])).toBe(true);
    expect(routingOnly(['dispatch_to'])).toBe(true);
    expect(routingOnly(['run_worker'])).toBe(true);
  });

  it('ignores non-tool lines (progress / thinking / runtime tag as "")', () => {
    const routingOnly = loadRoutingOnly();
    // A progress line (no eventName) before hand_off_to must not keep the bubble.
    expect(routingOnly(['', 'search_files', 'hand_off_to', ''])).toBe(true);
  });

  it('keeps a trail with real work (plan_set / write_file / bash) alongside routing', () => {
    const routingOnly = loadRoutingOnly();
    expect(routingOnly(['plan_set', 'hand_off_to'])).toBe(false);
    expect(routingOnly(['read_file', 'write_file', 'hand_off_to'])).toBe(false);
    expect(routingOnly(['bash', 'hand_off_to'])).toBe(false);
  });

  it('keeps a silent turn that read but never delegated (no routing tool → not routing-only)', () => {
    const routingOnly = loadRoutingOnly();
    expect(routingOnly(['read_file', 'read_file'])).toBe(false);
    expect(routingOnly(['', ''])).toBe(false);
  });

  it('is empty/null-safe', () => {
    const routingOnly = loadRoutingOnly();
    expect(routingOnly([])).toBe(false);
    expect(routingOnly(undefined as unknown as string[])).toBe(false);
  });
});

// `_isRoutingOnlyProcessItems` runs the same rule over a PERSISTED `process`
// array (jsonl shape), used to filter the redundant routing-only commander
// record on history reload / session switch-back — the path that still showed
// the second bubble after the live turn_silent fix.
describe('_isRoutingOnlyProcessItems (history-reload commander record filter)', () => {
  const toolItem = (name: string) => ({ type: 'event', event: { stream: 'tool', data: { name } } });
  const cliItem = (tool: string) => ({ type: 'event', event: { stream: 'cli', data: { type: 'tool-event', tool } } });
  const runtimeItem = { type: 'event', event: { stream: 'runtime', data: { phase: 'end', duration_ms: 205000 } } };

  it('matches the real persisted d9cbec9e037b trail (read_file×2 + hand_off_to + runtime)', () => {
    const isRoutingOnly = loadRoutingOnlyItems();
    expect(isRoutingOnly([toolItem('read_file'), toolItem('read_file'), toolItem('hand_off_to'), runtimeItem]))
      .toBe(true);
  });

  it('ignores progress items (no event) and names CLI-backed dispatch', () => {
    const isRoutingOnly = loadRoutingOnlyItems();
    expect(isRoutingOnly([{ type: 'progress', text: '正在整理…' }, cliItem('dispatch_to'), runtimeItem])).toBe(true);
  });

  it('keeps a trail with real work (write_file / bash)', () => {
    const isRoutingOnly = loadRoutingOnlyItems();
    expect(isRoutingOnly([toolItem('read_file'), toolItem('write_file'), toolItem('hand_off_to')])).toBe(false);
    expect(isRoutingOnly([toolItem('bash'), toolItem('hand_off_to')])).toBe(false);
  });

  it('is false without a delegation tool or when empty/invalid', () => {
    const isRoutingOnly = loadRoutingOnlyItems();
    expect(isRoutingOnly([toolItem('read_file'), runtimeItem])).toBe(false);
    expect(isRoutingOnly([])).toBe(false);
    expect(isRoutingOnly(undefined as unknown as unknown[])).toBe(false);
  });
});

// Exact regression from the screenshot: the commander made several invalid
// manage_execution_plan attempts, then successfully handed the final delivery
// to VideoStudio. The old routing-only whitelist treated the failed planning
// calls as "real work" and kept an empty commander record with a runtime rail.
describe('terminal hand-off commander-tail compatibility filter', () => {
  const toolItem = (id: string, name: string, phase: 'start' | 'end', isError?: boolean) => ({
    type: 'event',
    event: {
      stream: 'tool',
      data: { id, name, phase, ...(isError === undefined ? {} : { isError }) },
    },
  });
  const runtimeItem = { type: 'event', event: { stream: 'runtime', data: { phase: 'end', duration_ms: 259000 } } };
  const screenshotProcess = [
    {
      type: 'progress',
      text: '正在整理当前轮工具上下文...',
      event: { stream: 'context', data: { phase: 'active_process_compaction_start' } },
    },
    {
      type: 'progress',
      text: 'compacted 19480→2442 tokens',
      event: { stream: 'compaction', data: { tokensBefore: 19480, tokensAfter: 2442 } },
    },
    toolItem('plan-1', 'manage_execution_plan', 'start'),
    toolItem('plan-1', 'manage_execution_plan', 'end', true),
    toolItem('plan-2', 'manage_execution_plan', 'start'),
    toolItem('plan-2', 'manage_execution_plan', 'end', true),
    toolItem('plan-3', 'manage_execution_plan', 'start'),
    toolItem('plan-3', 'manage_execution_plan', 'end', true),
    toolItem('handoff-1', 'hand_off_to', 'start'),
    toolItem('handoff-1', 'hand_off_to', 'end', false),
    runtimeItem,
  ];

  it('recognizes successful hand_off_to despite failed planning attempts', () => {
    expect(loadSuccessfulTerminalHandoff()(screenshotProcess)).toBe(true);
  });

  it('explicit terminal-handoff semantics remove the live process placeholder', () => {
    const shouldDiscard = loadShouldDiscardSilentPlaceholder();
    const names = screenshotProcess.map((item: any) => item.event?.data?.name || '');
    // The old heuristic alone rejects this mixed trail because
    // manage_execution_plan is not a routing-support tool.
    expect(shouldDiscard('', names)).toBe(false);
    expect(shouldDiscard('terminal_handoff', names)).toBe(true);
  });

  it('drops the exact empty persisted commander tail on history reload', () => {
    const isRedundant = loadRedundantCommanderRecord();
    expect(isRedundant({ from: 'commander', text: '', process: screenshotProcess })).toBe(true);
  });

  it('preserves real commander prose and a failed hand-off', () => {
    const isRedundant = loadRedundantCommanderRecord();
    expect(isRedundant({ from: 'commander', text: 'Useful commander note', process: screenshotProcess })).toBe(false);
    const failed = screenshotProcess.map((item: any) => {
      if (item.event?.data?.id !== 'handoff-1' || item.event?.data?.phase !== 'end') return item;
      return toolItem('handoff-1', 'hand_off_to', 'end', true);
    });
    expect(isRedundant({ from: 'commander', text: '', process: failed })).toBe(false);
  });
});
