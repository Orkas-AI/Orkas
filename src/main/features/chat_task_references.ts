import { safeId } from '../storage';
import * as projectTasks from './project_tasks';
import * as autoTasks from './auto_tasks';

interface TaskReference {
  kind: 'todo' | 'automation';
  task_id: string;
  project_id: string;
  fallback_global?: boolean;
}

export type ConversationTaskLink = Omit<TaskReference, 'fallback_global'> & { title: string };

/** Read-only sidebar/header projection. One cached task inventory per displayed
 * scope, never one scan per conversation or a new persisted association. */
export async function conversationTaskLinks(uid: string, rows: Array<{
  conversation_id: string; project_id?: string; origin_auto_task_id?: string;
}>): Promise<Map<string, ConversationTaskLink[]>> {
  const links = new Map(rows.map(row => [row.conversation_id, [] as ConversationTaskLink[]]));
  if (!rows.length) return links;
  const automationIds = new Map(rows.map(row => [row.conversation_id,
    autoTasks.activeRunTaskId(uid, row.conversation_id) || row.origin_auto_task_id || '']));
  const automations = [...automationIds.values()].some(Boolean) ? await autoTasks.listTaskSearchRows(uid) : [];
  const byId = new Map(automations.map(task => [task.id, task]));
  const scopes = new Map<string, Set<string>>();
  for (const row of rows) {
    const pid = row.project_id || '';
    const cids = scopes.get(pid) || new Set<string>();
    cids.add(row.conversation_id);
    scopes.set(pid, cids);
    // A saved future target is not a fired task. Reused ordinary conversations
    // belong to an automation only while that run is actually in progress.
    const task = byId.get(automationIds.get(row.conversation_id) || '');
    if (task) links.get(row.conversation_id)!.push({ kind: 'automation', task_id: task.id,
      project_id: task.project_id || '', title: (task.title || task.content || '').slice(0, 160) });
  }
  for (const [pid, cids] of scopes) {
    for (const task of await projectTasks.listTaskSearchRows(uid, pid)) {
      if (task.origin_cid && cids.has(task.origin_cid)) {
        links.get(task.origin_cid)!.push({ kind: 'todo', task_id: task.id,
          project_id: pid, title: task.content.slice(0, 160) });
      }
    }
  }
  return links;
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
