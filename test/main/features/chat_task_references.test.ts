import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/main/features/project_tasks', () => ({ getTask: vi.fn() }));
vi.mock('../../../src/main/features/auto_tasks', () => ({ listTasks: vi.fn() }));

import { getTask } from '../../../src/main/features/project_tasks';
import { listTasks } from '../../../src/main/features/auto_tasks';
import { resolveChatTaskReferences } from '../../../src/main/features/chat_task_references';

const todo = { kind: 'todo', task_id: 't_e4fe5478466d', project_id: 'p_one' };
const auto = { kind: 'automation', task_id: 'at_1234abcd', project_id: '' };

beforeEach(() => { vi.resetAllMocks(); });

describe('chat task reference resolution', () => {
  it('uses the active account and exact scope, including completed tasks', async () => {
    vi.mocked(getTask).mockResolvedValue({ content: 'Review the completed release', status: 'done' } as any);
    expect(await resolveChatTaskReferences('account-a', [todo, todo])).toEqual([
      { ...todo, title: 'Review the completed release' },
    ]);
    expect(getTask).toHaveBeenCalledExactlyOnceWith('account-a', 'p_one', todo.task_id);
    expect(listTasks).not.toHaveBeenCalled();
  });

  it('allows global fallback only for references without an authoritative source scope', async () => {
    vi.mocked(getTask).mockImplementation(async (_uid, pid) => pid ? null : { content: 'Global review' } as any);
    expect(await resolveChatTaskReferences('account-a', [todo])).toEqual([]);
    expect(await resolveChatTaskReferences('account-a', [{ ...todo, fallback_global: true }])).toEqual([
      { ...todo, project_id: '', title: 'Global review' },
    ]);
  });

  it('reads automations once per batch and keeps the actual destination project', async () => {
    vi.mocked(listTasks).mockResolvedValue([
      { id: auto.task_id, title: 'Daily digest', content: 'Collect news', project_id: 'p_two' },
      { id: 'at_abcdef12', title: '', content: 'Unnamed automation content' },
    ] as any);
    expect(await resolveChatTaskReferences('account-a', [auto, { ...auto, task_id: 'at_abcdef12' }])).toEqual([
      { ...auto, project_id: 'p_two', title: 'Daily digest' },
      { ...auto, task_id: 'at_abcdef12', title: 'Unnamed automation content' },
    ]);
    expect(listTasks).toHaveBeenCalledExactlyOnceWith('account-a');
  });

  it.each([
    null, {}, Array(51).fill(todo), [{ ...todo, task_id: '../task' }],
    [{ ...todo, project_id: '../other' }], [{ ...auto, task_id: todo.task_id }],
    [{ ...todo, kind: 'unknown' }], [{ ...todo, fallback_global: 'yes' }],
  ])('rejects malformed or oversized batches before reading private data (%#)', async input => {
    await expect(resolveChatTaskReferences('account-a', input)).rejects.toThrow('invalid task references');
    expect(getTask).not.toHaveBeenCalled();
    expect(listTasks).not.toHaveBeenCalled();
  });

  it('does not invent a label or destination when the task is missing or deleted', async () => {
    vi.mocked(getTask).mockResolvedValue(null);
    vi.mocked(listTasks).mockResolvedValue([]);
    expect(await resolveChatTaskReferences('account-a', [todo, auto])).toEqual([]);
  });
});
