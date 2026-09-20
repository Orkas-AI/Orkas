/** Host-bound backlog operations shared by the in-process runtime and CLI bridge. */
import * as projectTasks from './project_tasks';
import type { ProjectTasksToolHandler } from '../../core-agent/src/tools/project-tasks-tool';
import { backlogExecutionSnapshot, type BacklogRunIdentity } from './group_chat/task_board';
import { taskSummaryPage } from './task_query';
import { getActiveUserId } from './users';

export function createProjectTasksHandler(
  uid: string, pid: string, cid: string, agentDisplayNameById: ReadonlyMap<string, string>,
  execution: BacklogRunIdentity = {},
): ProjectTasksToolHandler {
  const toView = (task: projectTasks.ProjectTask) => ({
    ...projectTasks.taskView(task),
    ...(backlogExecutionSnapshot(uid, pid, cid, execution).get(task.id)
      || { is_running: null, is_current_run: false }),
  });
  // Same normalization as the group-chat dispatch-target resolver
  // (bus.ts::resolveDispatchTarget): lowercase + strip whitespace, name
  // first, raw bound agent_id as fallback. Populating `owner_agent_id`
  // keeps ownership stable across agent rename.
  const normalizeOwnerKey = (s: string) => s.toLowerCase().replace(/\s+/g, '');
  const resolveTaskOwner = async (
    ownerRaw: string,
  ): Promise<{ fields?: { owner_agent: string; owner_agent_id: string }; error?: string }> => {
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
        : { error: `unknown owner "${ownerRaw}" — assign an enabled agent in this account` };
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
          ? `unknown owner "${ownerRaw}" — assign one of the scope's available agents by display name: ${validOwners.join(', ')}`
          : `unknown owner "${ownerRaw}" — this scope has no available agents to own tasks`,
      };
    }
    return {
      fields: { owner_agent: names.get(match) || ownerRaw, owner_agent_id: match },
    };
  };
  return {
    list: async (query = {}) => {
      const tasks = await projectTasks.listTasks(uid, pid);
      const executions = backlogExecutionSnapshot(uid, pid, cid, execution);
      const summaries = tasks.filter((task) => query.status === undefined || task.status === query.status).map((task) => {
        const { result_ref: _resultRef, ...summary } = projectTasks.taskView(task);
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
    create: async (input: projectTasks.TaskContentInput & { owner?: string; status?: projectTasks.TaskStatus }) => {
      let ownerFields: { owner_agent?: string; owner_agent_id?: string } = {};
      if (input.owner && input.owner.trim()) {
        const resolved = await resolveTaskOwner(input.owner.trim());
        if (resolved.error) return { ok: false, error: resolved.error };
        ownerFields = resolved.fields;
      }
      const r = await projectTasks.createTask(uid, pid, {
        ...(input.content !== undefined ? { content: input.content } : {}),
        ...(input.title !== undefined ? { title: input.title } : {}),
        ...(input.detail !== undefined ? { detail: input.detail } : {}),
        ...(input.status !== undefined ? { status: input.status } : {}),
        ...ownerFields,
        created_by: 'agent',
      });
      return r.ok
        ? { ok: true, task: toView(r.task), alreadyExists: r.alreadyExists }
        : { ok: false, error: (r as { error: string }).error };
    },
    update: async (taskId: string, patch: projectTasks.TaskContentInput & { status?: projectTasks.TaskStatus; owner?: string; result_ref?: string }) => {
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
      const r = await projectTasks.updateTask(uid, pid, taskId, {
        ...(patch.content !== undefined ? { content: patch.content } : {}),
        ...(patch.title !== undefined ? { title: patch.title } : {}),
        ...(patch.detail !== undefined ? { detail: patch.detail } : {}),
        ...(patch.status !== undefined ? { status: patch.status } : {}),
        ...ownerPatch,
        ...(patch.result_ref !== undefined ? { result_ref: patch.result_ref } : {}),
      });
      return r.ok === true ? { ok: true, task: toView(r.task) } : {
        ok: false,
        error: r.error === 'content_required_for_update'
          ? 'This task uses content; read it with get and send the complete replacement in content.'
          : r.error,
      };
    },
    complete: async (taskId: string, resultRef?: string) => {
      const r = await projectTasks.updateTask(uid, pid, taskId, {
        status: 'done',
        ...(resultRef ? { result_ref: resultRef } : {}),
      });
      return r.ok ? { ok: true, task: toView(r.task) } : { ok: false, error: (r as { error: string }).error };
    },
  };
}
