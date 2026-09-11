import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vm from 'node:vm';

/**
 * Pure decision logic of the renderer task board (task-board.js):
 * which rows render, in what order, and when the bar surfaces at all.
 *
 * Scenario value: the board must lead with actually-running work, retain only
 * the current batch's useful terminal context, and stay invisible for an
 * ordinary single running/waiting turn. Lone queued/blocked rows remain as
 * task-trace and recovery surfaces (plan conversation-task-board.md §3/§4.9).
 */

const source = fs.readFileSync(
  path.join(__dirname, '../../src/renderer/modules/task-board.js'),
  'utf8',
);

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

function runLiveRows(tasks: unknown): any[] {
  return vm.runInNewContext(
    `${extractFunction('_taskBoardLiveRows')}; _taskBoardLiveRows(${JSON.stringify(tasks)});`,
    {},
  );
}

function runVisibility(liveRows: unknown, deferFreshLoneQueued = false): { visible: boolean } {
  return vm.runInNewContext(
    `${extractFunction('_taskBoardVisibility')}; _taskBoardVisibility(${JSON.stringify(liveRows)}, ${deferFreshLoneQueued});`,
    {},
  );
}

/** Paint one conversation's board through the real renderer against an inert
 *  panel/list pair and return the row markup the user would see. */
function renderBoardRows(tasks: Array<Record<string, unknown>>): string {
  const list: any = { dataset: {}, style: {}, innerHTML: '', querySelectorAll: () => [], addEventListener() {} };
  const panel: any = { style: {}, querySelector: () => null, addEventListener() {} };
  const context: any = {
    console, Map, Set, Array, String, Object, JSON, Date, setTimeout, clearTimeout,
    document: {
      addEventListener() {},
      getElementById: (id: string) => (id === 'chat-task-board' ? panel : id === 'chat-task-board-list' ? list : null),
    },
    window: {},
    t: (key: string, params?: Record<string, unknown>) => (params && 'name' in params ? `${key}:${params.name}` : key),
    escapeHtml: (value: unknown) => String(value ?? ''),
    uiIconHtml: () => '',
  };
  vm.createContext(context);
  vm.runInContext(source, context, { filename: 'task-board.js' });
  context.__tasks = tasks;
  vm.runInContext("for (const task of __tasks) _taskBoardMapFor('c1').set(task.task_id, task);", context);
  context._taskBoardRender('c1');
  return list.innerHTML;
}

function runStatusLabel(status: string, labels: Record<string, string>): string {
  return vm.runInNewContext(
    `${extractFunction('_taskBoardStatusLabel')}; _taskBoardStatusLabel(${JSON.stringify(status)});`,
    { t: (key: string) => labels[key] || key },
  );
}

describe('renderer task board › live rows', () => {
  it('filters terminal rows and orders running > waiting_input > blocked > queued', () => {
    const rows = runLiveRows([
      { task_id: 'q1', status: 'queued', created_at: '2026-01-01T00:00:01Z' },
      { task_id: 'd1', status: 'done', created_at: '2026-01-01T00:00:00Z' },
      { task_id: 'r1', status: 'running', created_at: '2026-01-01T00:00:05Z' },
      { task_id: 'c1', status: 'cancelled', created_at: '2026-01-01T00:00:00Z' },
      { task_id: 'w1', status: 'waiting_input', created_at: '2026-01-01T00:00:02Z' },
      { task_id: 'b1', status: 'blocked', created_at: '2026-01-01T00:00:03Z' },
      { task_id: 'f1', status: 'failed', created_at: '2026-01-01T00:00:00Z' },
    ]);
    expect(rows.map((r) => r.task_id)).toEqual(['r1', 'w1', 'b1', 'q1']);
  });

  it('orders same-status rows by creation time so the queue reads top-down', () => {
    const rows = runLiveRows([
      { task_id: 'q-late', status: 'queued', created_at: '2026-01-01T00:00:09Z' },
      { task_id: 'q-early', status: 'queued', created_at: '2026-01-01T00:00:01Z' },
    ]);
    expect(rows.map((r) => r.task_id)).toEqual(['q-early', 'q-late']);
  });

  it('orders queued rows by their explicit scan position before creation time (P4 reorder)', () => {
    // Events can deliver rewritten `order` values in any arrival order; the
    // panel must show the real admission scan order or the user reorders
    // against a lie. Legacy rows without `order` fall back behind ordered
    // ones only via creation time among themselves.
    const rows = runLiveRows([
      { task_id: 'q-old-first', status: 'queued', order: 3, created_at: '2026-01-01T00:00:01Z' },
      { task_id: 'q-moved-up', status: 'queued', order: 1, created_at: '2026-01-01T00:00:09Z' },
      { task_id: 'q-middle', status: 'queued', order: 2, created_at: '2026-01-01T00:00:05Z' },
      { task_id: 'r1', status: 'running', created_at: '2026-01-01T00:00:00Z' },
    ]);
    expect(rows.map((r) => r.task_id)).toEqual(['r1', 'q-moved-up', 'q-middle', 'q-old-first']);
  });

  it('drops rows with unknown status instead of rendering them', () => {
    const rows = runLiveRows([
      { task_id: 'x', status: 'sprinting', created_at: 't' },
      { task_id: 'r', status: 'running', created_at: 't' },
    ]);
    expect(rows.map((r) => r.task_id)).toEqual(['r']);
  });

  it('does not render a queue task absorbed into an existing live turn as a second execution', () => {
    const rows = runLiveRows([
      { task_id: 'primary', status: 'running', created_at: 't1' },
      {
        task_id: 'absorbed', status: 'running', created_at: 't2',
        absorbed_into_turn_id: 'live-turn',
      },
    ]);
    expect(rows.map((r) => r.task_id)).toEqual(['primary']);
  });
});
describe('renderer task board › Send now eligibility', () => {
  function canSend(task: unknown, activeTurns: unknown[]): boolean {
    return vm.runInNewContext(
      `const _latestActiveTurns = new Map([['c1', ${JSON.stringify(activeTurns)}]]);
       ${extractFunction('_taskBoardCanSendNow')};
       _taskBoardCanSendNow('c1', ${JSON.stringify(task)});`,
      { Map },
    );
  }

  it('offers Send now only for a user queued task with matching steerable live actor', () => {
    const task = { task_id: 'q1', status: 'queued', created_by: 'user', assignee: 'agentA' };
    expect(canSend(task, [{ actor: 'agentA', steerable: true }])).toBe(true);
    expect(canSend(task, [{ actor: 'agentB', steerable: true }])).toBe(false);
    expect(canSend(task, [{ actor: 'agentA', steerable: false }])).toBe(false);
    expect(canSend({ ...task, created_by: 'commander' }, [{ actor: 'agentA', steerable: true }])).toBe(false);
    expect(canSend({ ...task, status: 'running' }, [{ actor: 'agentA', steerable: true }])).toBe(false);
    // A chained row keeps its start order (§4.8) — folding would jump it.
    expect(canSend({ ...task, after: 't0' }, [{ actor: 'agentA', steerable: true }])).toBe(false);
  });

  it('wires the eligible row action to the backend task promotion endpoint', () => {
    const index = fs.readFileSync(path.join(__dirname, '../../src/renderer/index.html'), 'utf8');
    expect(index).not.toContain('id="chat-steer-btn"');
    expect(source).toContain('data-act="task-send-now"');
    expect(source).toContain('/tasks/send-now`');
    expect(source).toContain("'chat.queue_send_now'");
  });

  it('keeps the row locked after acceptance, but restores it when promotion fails', async () => {
    const sendNow = `async ${extractFunction('_taskBoardSendNow')}`;
    const run = async (result: any) => {
      const sending = new Set<string>();
      const renders: string[] = [];
      const alerts: string[] = [];
      await vm.runInNewContext(
        `${sendNow}; _taskBoardSendNow('c1', 'q1');`,
        {
          _taskBoardSendingNow: sending,
          _taskBoardRender: (cid: string) => renders.push(cid),
          apiFetch: async () => ({ status: 409, json: async () => result }),
          t: (_key: string, params: any) => `failed: ${params?.msg || ''}`,
          uiAlert: (message: string) => alerts.push(message),
          encodeURIComponent,
        },
      );
      const draggable = vm.runInNewContext(
        `${extractFunction('_taskBoardCanDrag')}; _taskBoardCanDrag('c1', 'q1');`,
        {
          _taskBoardMapFor: () => new Map([['q1', { task_id: 'q1', status: 'queued' }]]),
          _taskBoardSendingNow: sending,
        },
      );
      return { sending, renders, alerts, draggable };
    };

    const accepted = await run({ ok: true, turn_id: 'live-turn' });
    expect([...accepted.sending]).toEqual(['c1:q1']);
    expect(accepted.renders).toEqual(['c1']);
    expect(accepted.alerts).toEqual([]);
    expect(accepted.draggable).toBe(false);

    const rejected = await run({ ok: false, error: 'turn_not_steerable' });
    expect([...rejected.sending]).toEqual([]);
    expect(rejected.renders).toEqual(['c1', 'c1']);
    expect(rejected.alerts).toEqual(['failed: turn_not_steerable']);
    expect(rejected.draggable).toBe(true);
  });
});

describe('renderer task board › assignee label', () => {
  function runLabel(task: unknown, memberNames: Array<[string, string]>, allAgents: unknown[] = []): string {
    return vm.runInNewContext(
      `${extractFunction('_taskBoardAssigneeLabel')}; _taskBoardAssigneeLabel('c1', ${JSON.stringify(task)});`,
      {
        _taskBoardMemberNames: new Map([['c1', new Map(memberNames)]]),
        _taskBoardAllAgents: allAgents,
        t: (k: string) => k,
      },
    );
  }

  it('uses the member or Agent catalog name, with stable commander and raw-id fallbacks', () => {
    const agents = [{ id: 'agent02', name: 'Agent Two' }];
    expect(runLabel({ assignee: 'agent01' }, [['agent01', 'Agent One']])).toBe('Agent One');
    expect(runLabel({ assignee: 'agent02' }, [], agents)).toBe('Agent Two');
    expect(runLabel({ assignee: 'ghost01' }, [])).toBe('ghost01');
    expect(runLabel({ assignee: 'commander' }, [])).toBe('chat.recipient_commander');
  });

  it('keeps queued assignment and dependency read-only after admission', () => {
    // Assignment/order choices belong to the composer before send. The board
    // must still explain a dependency without wiring mutation controls.
    const html = renderBoardRows([
      { task_id: 'run1', status: 'running', assignee: 'agentA', instruction: 'first', created_at: '2026-01-01T00:00:00Z' },
      { task_id: 'q1', status: 'queued', assignee: 'agentB', instruction: 'second', after: 'run1', created_at: '2026-01-01T00:00:01Z' },
    ]);
    expect(html).toContain('data-task-id="q1"');
    expect(html).toContain('chat.task_waiting_on:agentA');
    // The row keeps its legitimate control, so the absence below is not vacuous.
    expect(html).toContain('data-act="task-cancel"');
    expect(html).not.toMatch(/data-act="task-(reassign|after)"/);
    expect(html).not.toMatch(/<select|<input|contenteditable/);
  });
});

describe('renderer task board › agent groups and queued drag order', () => {
  // Grouping is by recipient, including dispatched work. Each agent retains
  // its visible status/scan order without stealing another agent's rows.
  it('groups interleaved work by agent id, preserving every row and its per-agent order', () => {
    const tasks = [
      { task_id: 'cmd', assignee: 'commander', status: 'running' },
      { task_id: 'a-run', assignee: 'a', status: 'running', parent_task_id: 'cmd' },
      { task_id: 'b-run', assignee: 'b', status: 'running' },
      { task_id: 'a-next', assignee: 'a', status: 'queued', parent_task_id: 'gone' },
      { task_id: 'b-next', assignee: 'b', status: 'queued' },
      { task_id: 'cmd-next', assignee: 'commander', status: 'queued' },
    ];
    const groups = vm.runInNewContext(
      `${extractFunction('_taskBoardAgentGroups')}; _taskBoardAgentGroups(${JSON.stringify(tasks)});`,
      {},
    );
    expect(groups.map((group: any) => [group.assignee, group.tasks.map((task: any) => task.task_id)]))
      .toEqual([
        ['commander', ['cmd', 'cmd-next']],
        ['a', ['a-run', 'a-next']],
        ['b', ['b-run', 'b-next']],
      ]);
  });

  const tasks = [
    { task_id: 'a-run', assignee: 'a', status: 'running' },
    { task_id: 'a1', assignee: 'a', status: 'queued', order: 1 },
    { task_id: 'b1', assignee: 'b', status: 'queued', order: 2 },
    { task_id: 'a2', assignee: 'a', status: 'queued', order: 3 },
    { task_id: 'a3', assignee: 'a', status: 'queued', order: 4 },
    { task_id: 'a-blocked', assignee: 'a', status: 'blocked' },
    { task_id: 'a-cancelled', assignee: 'a', status: 'cancelled' },
    { task_id: 'absorbed', assignee: 'a', status: 'queued', absorbed_into_turn_id: 'live' },
  ];
  function drop(sourceId: string, targetId: string, after: boolean, rows: unknown = tasks) {
    return vm.runInNewContext(
      `${extractFunction('_taskBoardLiveRows')};
       ${extractFunction('_taskBoardDropOrder')};
       _taskBoardDropOrder(${JSON.stringify(rows)}, ${JSON.stringify(sourceId)}, ${JSON.stringify(targetId)}, ${after});`,
      {},
    );
  }

  it('supports dropping before, between, and after queued peers in either direction', () => {
    expect(drop('a3', 'a1', false)).toEqual({ task_id: 'a3', before_task_id: 'a1' });
    expect(drop('a3', 'a1', true)).toEqual({ task_id: 'a3', before_task_id: 'a2' });
    expect(drop('a1', 'a2', true)).toEqual({ task_id: 'a1', before_task_id: 'a3' });
    expect(drop('a1', 'a3', true)).toEqual({ task_id: 'a1', before_task_id: '' });
  });

  it('rejects cross-agent, non-queued, missing, self and unchanged drops without a command', () => {
    for (const [sourceId, targetId] of [
      ['a1', 'b1'], ['a-run', 'a1'], ['a1', 'a-run'], ['missing', 'a1'],
      ['a1', 'missing'], ['a1', 'a1'], ['a-blocked', 'a1'],
      ['a1', 'a-cancelled'], ['absorbed', 'a1'],
    ]) expect(drop(sourceId, targetId, false)).toBeNull();
    expect(drop('a1', 'a2', false)).toBeNull();
    expect(drop('a3', 'a2', true)).toBeNull();

    // Admission between dragstart and drop invalidates the gesture.
    expect(drop('a3', 'a1', false, tasks.map((task) => (
      task.task_id === 'a3' ? { ...task, status: 'running' } : task
    )))).toBeNull();
  });
});

describe('renderer task board › seed/resync merge (terminal-wins)', () => {
  // Scenario value: a terminal `task_state` emitted while no events stream
  // was attached is lost, and the once-per-conversation seed never re-read —
  // a cancelled task stayed painted "running" with a dead Stop button
  // (on-device 2026-08-23). The resync re-seed must let disk terminals
  // overwrite stale live-looking snapshots WITHOUT clobbering a fresher
  // running/waiting snapshot a concurrent event already wrote.
  function runMerge(mapEntries: Array<[string, any]>, rows: unknown): Array<[string, any]> {
    return vm.runInNewContext(
      `const _TASK_BOARD_TERMINAL = new Set(['done', 'stopped', 'failed', 'cancelled']);
       ${extractFunction('_taskBoardMergeSeedRows')};
       const map = new Map(${JSON.stringify(mapEntries)});
       _taskBoardMergeSeedRows(map, ${JSON.stringify(rows)});
       [...map.entries()];`,
      {},
    );
  }

  it('a disk terminal overwrites a stale running snapshot (the ghost-row fix)', () => {
    const merged = new Map(runMerge(
      [['t1', { task_id: 't1', status: 'running' }]],
      [{ task_id: 't1', status: 'cancelled' }],
    ));
    expect(merged.get('t1').status).toBe('cancelled');
  });

  it('treats stopped as an absorbing disk terminal', () => {
    const merged = new Map(runMerge(
      [['t1', { task_id: 't1', status: 'running' }]],
      [{ task_id: 't1', status: 'stopped' }],
    ));
    expect(merged.get('t1').status).toBe('stopped');
  });

  it('a non-terminal disk row never clobbers an existing snapshot but fills gaps', () => {
    const merged = new Map(runMerge(
      [['t1', { task_id: 't1', status: 'waiting_input' }]],
      [
        { task_id: 't1', status: 'running' },   // event snapshot is fresher — keep
        { task_id: 't2', status: 'queued' },    // unseen row — insert
      ],
    ));
    expect(merged.get('t1').status).toBe('waiting_input');
    expect(merged.get('t2').status).toBe('queued');
  });

  it('ignores malformed rows and non-array input', () => {
    const merged = new Map(runMerge(
      [['t1', { task_id: 't1', status: 'running' }]],
      [null, { status: 'done' }, 'junk'],
    ));
    expect([...merged.keys()]).toEqual(['t1']);
    expect(new Map(runMerge([], null)).size).toBe(0);
  });
});

describe('renderer task board › visibility (multi-task only, adjudicated 2026-09-04)', () => {
  it('stays hidden for no work and ordinary single running or waiting-input turns', () => {
    expect(runVisibility([])).toEqual({ visible: false });
    expect(runVisibility([{ status: 'running' }])).toEqual({ visible: false });
    expect(runVisibility([{ status: 'waiting_input' }])).toEqual({ visible: false });
  });

  it('surfaces once a second live task exists', () => {
    expect(runVisibility([{ status: 'running' }, { status: 'waiting_input' }]))
      .toEqual({ visible: true });
  });

  it('retracts when a multi-task run drains to one ordinary task or becomes idle, then resurfaces', () => {
    const states = [
      [{ status: 'running' }, { status: 'running' }],
      [{ status: 'running' }],
      [],
      [{ status: 'running' }, { status: 'waiting_input' }],
    ];
    expect(states.map(runVisibility)).toEqual([
      { visible: true },
      { visible: false },
      { visible: false },
      { visible: true },
    ]);
  });

  it('keeps a lone queued or blocked task visible only until admission or terminal settlement', () => {
    // These are user journeys, not just a status truth table: queued is the
    // only trace before its bubble is persisted; blocked owns recovery. Once
    // either task starts, the ordinary live bubble takes over, and terminal
    // settlement must not leave an empty control surface behind.
    const lifecycleTasks = [
      [{ task_id: 'queued-flow', status: 'queued' }],
      [{ task_id: 'queued-flow', status: 'running' }],
      [{ task_id: 'queued-flow', status: 'done' }],
      [{ task_id: 'blocked-flow', status: 'blocked' }],
      [{ task_id: 'blocked-flow', status: 'queued' }],
      [{ task_id: 'blocked-flow', status: 'running' }],
      [{ task_id: 'blocked-flow', status: 'cancelled' }],
    ];
    expect(lifecycleTasks.map((tasks) => runVisibility(runLiveRows(tasks)))).toEqual([
      { visible: true },
      { visible: false },
      { visible: false },
      { visible: true },
      { visible: true },
      { visible: false },
      { visible: false },
    ]);
  });

  it('suppresses the queued-to-running admission blip but reveals work that remains queued', () => {
    // Scenario value: an ordinary send is created as queued before the same
    // admission pass claims it. That host-only transition must not flash a
    // queue panel, while a genuinely parked message must still gain its only
    // visible/cancellable surface after the short stabilization window.
    const queued = [{ task_id: 'ordinary-send', status: 'queued' }];
    expect(runVisibility(queued, true)).toEqual({ visible: false });
    expect(runVisibility(queued, false)).toEqual({ visible: true });

    // The delay is narrowly scoped: recovery controls and real multi-task
    // work surface immediately, and a restored queue with no fresh deadline
    // remains visible without an extra wait.
    expect(runVisibility([{ task_id: 'blocked', status: 'blocked' }], true))
      .toEqual({ visible: true });
    expect(runVisibility([
      { task_id: 'running', status: 'running' },
      { task_id: 'queued', status: 'queued' },
    ], true)).toEqual({ visible: true });
  });

  it('counts only filtered live work, so terminal or absorbed batch rows cannot pin the board', () => {
    const taskSets = [
      [
        { task_id: 'done', status: 'done' },
        { task_id: 'failed', status: 'failed' },
      ],
      [
        { task_id: 'live', status: 'running' },
        { task_id: 'done', status: 'done' },
        { task_id: 'stopped', status: 'stopped' },
      ],
      [
        { task_id: 'live', status: 'running' },
        { task_id: 'absorbed', status: 'running', absorbed_into_turn_id: 'live-turn' },
      ],
      [
        { task_id: 'queued', status: 'queued' },
        { task_id: 'done', status: 'done' },
      ],
    ];
    expect(taskSets.map((tasks) => runVisibility(runLiveRows(tasks)))).toEqual([
      { visible: false },
      { visible: false },
      { visible: false },
      { visible: true },
    ]);
  });

  it('surfaces the default 4+1 capacity case as “运行中 4 · 排队 1” and labels the fifth row “排队中”', () => {
    const rows = runLiveRows([
      { task_id: 'r1', status: 'running', created_at: 't1' },
      { task_id: 'r2', status: 'running', created_at: 't2' },
      { task_id: 'r3', status: 'running', created_at: 't3' },
      { task_id: 'r4', status: 'running', created_at: 't4' },
      { task_id: 'q5', status: 'queued', created_at: 't5' },
    ]);
    const running = rows.filter((task) => task.status === 'running').length;
    const queued = rows.filter((task) => task.status === 'queued').length;
    expect(runVisibility(rows)).toEqual({ visible: true });
    expect(rows.map((task) => task.task_id)).toEqual(['r1', 'r2', 'r3', 'r4', 'q5']);

    const zh = JSON.parse(fs.readFileSync(
      path.join(__dirname, '../../src/renderer/locales/zh.json'),
      'utf8',
    ));
    const summary = String(zh['chat.task_board_counts'])
      .replace('{running}', String(running))
      .replace('{queued}', String(queued));
    expect(summary).toBe('运行中 4 · 排队 1');
    expect(runStatusLabel('queued', zh)).toBe('排队中');
  });
});

describe('renderer task board › latest-batch display while the multi-task board is visible', () => {
  function runBatchAfterCreate(
    batchIds: string[],
    tasks: Array<Record<string, unknown>>,
    createdId: string,
  ): string[] {
    return vm.runInNewContext(
      `const _TASK_BOARD_TERMINAL = new Set(['done', 'stopped', 'failed', 'cancelled']);
       ${extractFunction('_taskBoardBatchAfterCreate')};
       const byId = new Map(${JSON.stringify(tasks)}.map((t) => [t.task_id, t]));
       [..._taskBoardBatchAfterCreate(new Set(${JSON.stringify(batchIds)}), byId, ${JSON.stringify(createdId)})];`,
      {},
    );
  }

  function runDisplayRows(tasks: unknown, batchIds: string[]): string[] {
    return vm.runInNewContext(
      `const _TASK_BOARD_TERMINAL = new Set(['done', 'stopped', 'failed', 'cancelled']);
       ${extractFunction('_taskBoardLiveRows')};
       ${extractFunction('_taskBoardDisplayRows')};
       _taskBoardDisplayRows(${JSON.stringify(tasks)}, new Set(${JSON.stringify(batchIds)})).map((t) => t.task_id);`,
      {},
    );
  }

  it('a create while the tracked batch is still live JOINS the batch; all-terminal starts a fresh one', () => {
    const tasks = [
      { task_id: 'a', status: 'running' },
      { task_id: 'b', status: 'done' },
    ];
    expect(runBatchAfterCreate(['a', 'b'], tasks, 'c').sort()).toEqual(['a', 'b', 'c']);
    const finished = [
      { task_id: 'a', status: 'done' },
      { task_id: 'b', status: 'cancelled' },
    ];
    expect(runBatchAfterCreate(['a', 'b'], finished, 'c')).toEqual(['c']);
  });

  it('removes completed and cancelled messages while retaining the batch failure context', () => {
    const rows = runDisplayRows([
      { task_id: 'old-done', status: 'done', created_at: '2026-01-01T00:00:00Z' },
      { task_id: 'step1', status: 'done', created_at: '2026-01-01T00:01:00Z' },
      { task_id: 'step2', status: 'cancelled', created_at: '2026-01-01T00:02:00Z' },
      { task_id: 'step3', status: 'running', created_at: '2026-01-01T00:03:00Z' },
      { task_id: 'step4', status: 'queued', created_at: '2026-01-01T00:04:00Z' },
      { task_id: 'failure', status: 'failed', created_at: '2026-01-01T00:05:00Z' },
    ], ['step1', 'step2', 'step3', 'step4', 'failure']);
    expect(rows).toEqual(['failure', 'step3', 'step4']);
  });

  it('keeps an absorbed task out of the pinned terminal batch after the shared turn settles', () => {
    const rows = runDisplayRows([
      { task_id: 'primary', status: 'failed', created_at: 't1' },
      {
        task_id: 'absorbed', status: 'failed', created_at: 't2',
        absorbed_into_turn_id: 'live-turn',
      },
    ], ['primary', 'absorbed']);
    expect(rows).toEqual(['primary']);
  });
});
