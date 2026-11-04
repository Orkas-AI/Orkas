import { safeId } from '../storage';
import * as projectTasks from './project_tasks';
import * as autoTasks from './auto_tasks';

interface TaskReference {
  kind: 'todo' | 'automation';
  task_id: string;
  project_id: string;
  fallback_global?: boolean;
}

/** Compact read projection for chat links. Never executes a task. */
export async function resolveChatTaskReferences(
  uid: string, input: unknown,
): Promise<Array<Omit<TaskReference, 'fallback_global'> & { title: string }>> {
  if (!Array.isArray(input) || input.length > 50 || input.some(ref => (
    !ref || !['todo', 'automation'].includes(ref.kind)
    || typeof ref.task_id !== 'string'
    || !(ref.kind === 'todo' ? /^t_[a-f0-9]{12}$/ : /^at_[a-f0-9]{8}$/).test(ref.task_id)
    || typeof ref.project_id !== 'string' || (ref.project_id !== '' && !safeId(ref.project_id))
    || (ref.fallback_global !== undefined && typeof ref.fallback_global !== 'boolean')
  ))) throw new Error('invalid task references');
  const refs = [...new Map((input as TaskReference[]).map(ref => [
    JSON.stringify([ref.kind, ref.project_id, ref.task_id]), ref,
  ])).values()];
  // Automations already have a hard per-account cap of 200. Read their shared
  // inventory once, rather than repeating location discovery for each ID.
  const automations = new Map(refs.some(ref => ref.kind === 'automation')
    ? (await autoTasks.listTasks(uid)).map(task => [task.id, task]) : []);
  const result: Array<Omit<TaskReference, 'fallback_global'> & { title: string }> = [];
  for (const ref of refs) {
    if (ref.kind === 'automation') {
      const task = automations.get(ref.task_id);
      if (task) result.push({ kind: ref.kind, task_id: task.id, project_id: task.project_id || '',
        title: (task.title || task.content).slice(0, 8000) });
      continue;
    }
    let pid = ref.project_id;
    let task = await projectTasks.getTask(uid, pid, ref.task_id);
    if (!task && pid && ref.fallback_global) {
      pid = '';
      task = await projectTasks.getTask(uid, pid, ref.task_id);
    }
    if (task) result.push({ kind: ref.kind, task_id: ref.task_id,
      project_id: pid, title: task.content.slice(0, 8000) });
  }
  return result;
}
