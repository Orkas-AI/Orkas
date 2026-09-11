// A conversation task must settle on the board even when the user is looking
// at a DIFFERENT conversation while it finishes.
//
// Observed 2026-08-27. A 5.6-minute external-CLI turn ran in cid A; at 21:19
// the user sent a message in cid B, so cid B became the visible conversation.
// At 21:23:39 cid A's turn settled: `finishTask` wrote `done` to tasks.json
// and both event streams relayed the terminal `task_state` (their relay
// counts are identical in the log, so nothing was dropped in transport). The
// renderer threw it away at `_handleGroupBusEvent`'s cross-cid view guard,
// and twelve minutes later the board still read 运行中 while disk read `done`.
//
// The guard exists for DOM leakage — all cids share one `chat-history`, so a
// background conv's process/message events would mint bubbles inside the
// visible conv. Task-board events carry no DOM: they land in a cid-keyed Map
// that repaints only for the visible cid. Dropping them is not cosmetic —
// task states are absorbing, the `/tasks` seed is once per cid per session,
// and the board's only repair path runs on a stream (re)connect. So the row
// stays "running" until the user's next send.

import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vm from 'node:vm';

const boardSource = fs.readFileSync(
  path.join(__dirname, '../../src/renderer/modules/task-board.js'),
  'utf8',
);
const conversationSource = fs.readFileSync(
  path.join(__dirname, '../../src/renderer/modules/conversation.js'),
  'utf8',
);

function extractFunction(source: string, name: string): string {
  const start = source.indexOf(`function ${name}`);
  if (start < 0) throw new Error(`missing ${name}`);
  const braceStart = source.indexOf('{', start);
  let depth = 0;
  for (let i = braceStart; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1;
    else if (source[i] === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  throw new Error(`unterminated ${name}`);
}

type BoardContext = {
  _taskBoardTasks: Map<string, Map<string, { status: string }>>;
  renders: string[];
};

/** Drive the real `_taskBoardOnEvent` with `visibleCid` on screen. */
function applyEvents(
  visibleCid: string,
  events: Array<[string, unknown]>,
): BoardContext {
  const ctx: Record<string, unknown> = {
    _taskBoardTasks: new Map(),
    _taskBoardBatchIds: new Map(),
    _taskBoardSendingNow: new Set(),
    _TASK_BOARD_TERMINAL: new Set(['done', 'stopped', 'failed', 'cancelled']),
    currentCid: visibleCid,
    renders: [] as string[],
  };
  ctx._taskBoardRender = (cid: string) => { (ctx.renders as string[]).push(cid); };
  vm.createContext(ctx);
  const src = [
    extractFunction(boardSource, '_taskBoardMapFor'),
    extractFunction(boardSource, '_taskBoardLiveRows'),
    extractFunction(boardSource, '_taskBoardBatchAfterCreate'),
    extractFunction(boardSource, '_taskBoardOnEvent'),
  ].join('\n');
  vm.runInContext(
    `${src}\nfor (const [cid, ev] of ${JSON.stringify(events)}) _taskBoardOnEvent(cid, ev);`,
    ctx,
  );
  return ctx as unknown as BoardContext;
}

const RUNNING = { type: 'task_created', task: { task_id: 't1', status: 'running' } };
const DONE = { type: 'task_state', task: { task_id: 't1', status: 'done' } };

describe('task board › a background conversation still settles', () => {
  it('applies a terminal for a conversation that is not on screen', () => {
    const ctx = applyEvents('visible-cid', [['bg-cid', RUNNING], ['bg-cid', DONE]]);
    expect(ctx._taskBoardTasks.get('bg-cid')?.get('t1')?.status).toBe('done');
  });

  it('does not repaint while that conversation is off screen', () => {
    const ctx = applyEvents('visible-cid', [['bg-cid', RUNNING], ['bg-cid', DONE]]);
    expect(ctx.renders).toEqual([]);
  });

  it('still repaints for the conversation the user is looking at', () => {
    const ctx = applyEvents('visible-cid', [['visible-cid', RUNNING], ['visible-cid', DONE]]);
    expect(ctx.renders).toEqual(['visible-cid', 'visible-cid']);
    expect(ctx._taskBoardTasks.get('visible-cid')?.get('t1')?.status).toBe('done');
  });

  it('settles the background board without disturbing the visible one', () => {
    const ctx = applyEvents('visible-cid', [
      ['visible-cid', { type: 'task_created', task: { task_id: 'v1', status: 'running' } }],
      ['bg-cid', RUNNING],
      ['bg-cid', DONE],
    ]);
    expect(ctx._taskBoardTasks.get('bg-cid')?.get('t1')?.status).toBe('done');
    expect(ctx._taskBoardTasks.get('visible-cid')?.get('v1')?.status).toBe('running');
    expect(ctx.renders).toEqual(['visible-cid']);
  });
});

describe('task board › events are settled above the cross-cid view guard', () => {
  // An ordering invariant inside a DOM-coupled function, so it is pinned on
  // the source: putting the board branch back below `cid !== currentCid`
  // silently restores the stuck-running row and nothing else would fail.
  const body = (() => {
    const start = conversationSource.indexOf('function _handleGroupBusEvent');
    if (start < 0) throw new Error('missing _handleGroupBusEvent');
    const end = conversationSource.indexOf('\nfunction ', start + 1);
    return conversationSource.slice(start, end > 0 ? end : undefined);
  })();
  const guard = body.indexOf('if (cid !== currentCid) return;');

  it('handles task_created / task_state before the guard runs', () => {
    const bypass = body.indexOf('_taskBoardEventBypassesViewGuard(evData)');
    expect(bypass).toBeGreaterThan(-1);
    expect(guard).toBeGreaterThan(-1);
    expect(bypass).toBeLessThan(guard);
  });

  it('leaves no second board delivery below the guard', () => {
    expect(body.indexOf('TaskBoard.onEvent', guard)).toBe(-1);
  });

  it('routes exactly the two board event types past the guard', () => {
    const predicate = extractFunction(conversationSource, '_taskBoardEventBypassesViewGuard');
    const decide = (ev: unknown) => vm.runInNewContext(
      `${predicate}; _taskBoardEventBypassesViewGuard(${JSON.stringify(ev)});`,
      {},
    );
    expect(decide({ type: 'task_created' })).toBe(true);
    expect(decide({ type: 'task_state' })).toBe(true);
    // Everything else must keep obeying the guard — these are the DOM-minting
    // events it was written for.
    expect(decide({ type: 'process' })).toBe(false);
    expect(decide({ type: 'message' })).toBe(false);
    expect(decide({ type: 'state_changed' })).toBe(false);
    expect(decide(null)).toBe(false);
  });
});
