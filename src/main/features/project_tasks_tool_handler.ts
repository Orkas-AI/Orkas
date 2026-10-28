/** Host-bound backlog operations shared by the in-process runtime and CLI bridge. */
import * as projectTasks from './project_tasks';
import type { ProjectTasksToolHandler } from '../../core-agent/src/tools/project-tasks-tool';
import { backlogExecutionSnapshot, type BacklogRunIdentity } from './group_chat/task_board';
import { taskSummaryPage } from './task_query';
import { getActiveUserId } from './users';
import { isCommanderTaskOwner } from './project_task_record';

export function createProjectTasksHandler(
  uid: string, pid: string, cid: string, agentDisplayNameById: ReadonlyMap<string, string>,
  execution: BacklogRunIdentity = {},
  files: { sourceProjectId?: string; workingDir?: string } = {},
  onSaved?: (taskId: string, projectId: string, content: string) => void,
  // A successful delete withdraws any offer staged for that task this turn.
  onDeleted?: (taskId: string, projectId: string) => void,
  // Aborts once the caller stopped waiting; a later write would contradict the
  // failure it already reported and invite a duplicate retry.
  signal?: AbortSignal,
): ProjectTasksToolHandler {
  const beforeWrite = () => {
    if (signal?.aborted) throw new Error('E_BRIDGE_CALL_CANCELLED: the caller stopped waiting for this task operation');
  };
  const toView = (task: projectTasks.ProjectTask) => ({
    ...projectTasks.taskView(task),
    ...(backlogExecutionSnapshot(uid, pid, cid, execution).get(task.id)
      || { is_running: null, is_current_run: false }),
  });
  const savedView = (task: projectTasks.ProjectTask) => {
    try { onSaved?.(task.id, pid, task.content); } catch { /* A navigation offer cannot fail a saved operation. */ }
    return toView(task);
  };
  // Same normalization as the group-chat dispatch-target resolver
  // (bus.ts::resolveDispatchTarget): lowercase + strip whitespace, name
  // first, raw bound agent_id as fallback. Populating `owner_agent_id`
  // keeps ownership stable across agent rename.
  const normalizeOwnerKey = (s: string) => s.toLowerCase().replace(/\s+/g, '');
  const resolveTaskOwner = async (
    ownerRaw: string,
  ): Promise<{ fields?: { owner_agent: string; owner_agent_id: string }; error?: string }> => {
    // Commander is a reserved actor, not a roster entry. Use the store's
    // identity rule while retaining the active-account boundary.
    if (isCommanderTaskOwner({ owner_agent: ownerRaw })) {
      return getActiveUserId() === uid
        ? { fields: { owner_agent: 'Commander', owner_agent_id: 'commander' } }
        : { error: 'account_changed' };
    }
    if (!pid) {
      // Global owners come from this account's enabled registry, just as in
      // the backlog store. Project handlers keep their bound-agent scope.
      if (getActiveUserId() !== uid) return { error: 'owner_not_bound' };
      const { listAgentSummaries } = await import('./agents');
      const available = (await listAgentSummaries()).filter((agent) => agent.enabled !== false);
      if (getActiveUserId() !== uid) return { error: 'owner_not_bound' };
      const key = normalizeOwnerKey(ownerRaw);
      const owner = available.find((agent) => agent.agent_id === ownerRaw
        || normalizeOwnerKey(agent.name) === key);
      return owner
        ? { fields: { owner_agent: owner.name, owner_agent_id: owner.agent_id } }
        : { error: `unknown owner "${ownerRaw}" — no matching enabled agent in this account` };
    }
    const { getBindings } = await import('./projects');
    let bound: string[];
    const names = new Map(agentDisplayNameById);
    if (pid) bound = (await getBindings(uid, pid)).agents;
    else {
      const { getActiveUserId } = await import('./users');
      if (getActiveUserId() !== uid) return { error: 'account_changed' };
      const { listAgentSummaries } = await import('./agents');
      const available = (await listAgentSummaries()).filter(agent => agent.enabled !== false);
      if (getActiveUserId() !== uid) return { error: 'account_changed' };
      bound = available.map(agent => agent.agent_id);
      for (const agent of available) names.set(agent.agent_id, agent.name || agent.agent_id);
    }
    const key = normalizeOwnerKey(ownerRaw);
    const match = bound.find((id) => {
      const name = names.get(id) || '';
      return id === ownerRaw || (!!name && normalizeOwnerKey(name) === key);
    });
    if (!match) {
      const validOwners = bound.map((id) => names.get(id) || id);
      return {
        error: validOwners.length
          ? `unknown owner "${ownerRaw}" — available agent display names in this scope: ${validOwners.join(', ')}`
          : `unknown owner "${ownerRaw}" — this scope has no available agents to own tasks`,
      };
    }
    return {
      fields: { owner_agent: names.get(match) || ownerRaw, owner_agent_id: match },
    };
  };
  return {
    delete: async (taskId) => {
      if (getActiveUserId() !== uid) return { ok: false, error: 'account_changed' };
      beforeWrite();
      const result = await projectTasks.deleteTask(uid, pid, taskId);
      if (!result.ok) return result;
      try { onDeleted?.(taskId, pid); } catch { /* withdrawing an offer never fails the delete */ }
      return { ok: true, task_id: taskId, deleted: true };
    },
    addAttachment: async (taskId, sourcePath) => {
      const { addTaskAttachmentFromPath } = await import('./project_task_attachment_tool');
      beforeWrite();
      const result = await addTaskAttachmentFromPath(uid, pid, cid, taskId, sourcePath, files);
      return result.ok ? { ok: true, task: savedView(result.task) } : result;
    },
    list: async (query = {}) => {
      const tasks = await projectTasks.listTasks(uid, pid);
      const executions = backlogExecutionSnapshot(uid, pid, cid, execution);
      const summaries = tasks.filter((task) => query.status === undefined || task.status === query.status).map((task) => {
        const summary = projectTasks.taskView(task);
        return { ...summary, ...(executions.get(task.id) || { is_running: null, is_current_run: false }) };
      });
      return {
        ok: true,
        ...taskSummaryPage(summaries, query.offset, query.limit),
        progress: projectTasks.computeProgress(tasks),
      };
    },
    get: async (taskId) => {
      const task = await projectTasks.getTask(uid, pid, taskId);
      return task ? { ok: true, task: toView(task) } : { ok: false, error: 'task_not_found' };
    },
    create: async (input: projectTasks.TaskContentInput & { owner?: string; status?: projectTasks.TaskStatus; due_at?: string }) => {
      let ownerFields: { owner_agent?: string; owner_agent_id?: string } = {};
      if (input.owner && input.owner.trim()) {
        const resolved = await resolveTaskOwner(input.owner.trim());
        if (resolved.error) return { ok: false, error: resolved.error };
        ownerFields = resolved.fields;
      }
      beforeWrite();
      const r = await projectTasks.createTask(uid, pid, {
        ...(input.content !== undefined ? { content: input.content } : {}),
        ...(input.title !== undefined ? { title: input.title } : {}),
        ...(input.detail !== undefined ? { detail: input.detail } : {}),
        ...(input.status !== undefined ? { status: input.status } : {}),
        ...ownerFields,
        ...(input.due_at !== undefined ? { due_at: input.due_at } : {}),
        created_by: 'agent',
      });
      if (!r.ok) return { ok: false, error: (r as { error: string }).error };
      // Reused global to-dos retain their original conversation association.
      let task = r.task;
      if (!task.origin_cid && cid && !pid) {
        await projectTasks.recordTaskExecution(uid, pid, task.id, cid);
        task = (await projectTasks.getTask(uid, pid, task.id)) || task;
      }
      return { ok: true, task: savedView(task), alreadyExists: r.alreadyExists };
    },
    update: async (taskId: string, patch: projectTasks.TaskContentInput & { status?: projectTasks.TaskStatus; owner?: string; due_at?: string }) => {
      let ownerPatch: { owner_agent?: string; owner_agent_id?: string } = {};
      if (patch.owner !== undefined) {
        if (patch.owner.trim()) {
          const resolved = await resolveTaskOwner(patch.owner.trim());
          if (resolved.error) return { ok: false, error: resolved.error };
          ownerPatch = resolved.fields;
        } else {
          // Empty owner clears both fields (store deletes on empty name).
          ownerPatch = { owner_agent: '' };
        }
      }
      beforeWrite();
      const r = await projectTasks.updateTask(uid, pid, taskId, {
        ...(patch.content !== undefined ? { content: patch.content } : {}),
        ...(patch.title !== undefined ? { title: patch.title } : {}),
        ...(patch.detail !== undefined ? { detail: patch.detail } : {}),
        ...(patch.status !== undefined ? { status: patch.status } : {}),
        ...ownerPatch,
        // An empty string clears, like `owner`.
        ...(patch.due_at !== undefined ? { due_at: patch.due_at === '' ? null : patch.due_at } : {}),
      });
      return r.ok === true ? { ok: true, task: savedView(r.task) } : {
        ok: false,
        error: r.error === 'content_required_for_update'
          ? 'This task uses content; title/detail updates are not supported. The content field requires the complete replacement.'
          : r.error,
      };
    },
    complete: async (taskId: string) => {
      beforeWrite();
      const r = await projectTasks.updateTask(uid, pid, taskId, {
        status: 'done',
      });
      return r.ok ? { ok: true, task: savedView(r.task) } : { ok: false, error: (r as { error: string }).error };
    },
  };
}
