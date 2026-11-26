/** Commander backlog scope outside a project: the global backlog and a
 *  newly-created project awaiting conversation filing are writable; any other
 *  project of the account is readable when the user asks about it (plan
 *  Common/docs/plans/commander-project-continuity.md §6, second phase R1-R4). */
import { createProjectTasksTool, type ProjectTasksToolHandler } from '../../core-agent/src/tools/project-tasks-tool';
import { pendingCreatedProjectId } from './conversation_filing';
import { createProjectTasksHandler } from './project_tasks_tool_handler';
import { getProject, listProjectNameRows } from './projects';
import { getActiveUserId } from './users';
import { projectGoalAndRecapEnabled } from '../util/project-feature-flags';

const READ_ACTIONS = new Set(['list', 'get']);
const READ_ONLY = {
  ok: false as const, error: 'project_read_only',
  message: "Another project's to-dos are read-only here; changing them requires a conversation in that project.",
};

/** Reads only: a write that slipped past the scope check still cannot run. */
function readOnlyHandler(handler: ProjectTasksToolHandler): ProjectTasksToolHandler {
  const refuse = async () => READ_ONLY;
  return { list: handler.list, get: handler.get, create: refuse, update: refuse,
    complete: refuse, delete: refuse, addAttachment: refuse };
}

export function createConversationTasksTool(
  userId: string, cid: string, names: ReadonlyMap<string, string>,
  onSaved?: (taskId: string, projectId: string, content: string) => void,
  onDeleted?: (taskId: string, projectId: string) => void,
) {
  const goalsEnabled = projectGoalAndRecapEnabled();
  /** Another project of this account, by id or exact name, for list and get only. */
  const readOtherProject = async (reference: string, action: string | undefined,
                                  signal: AbortSignal | undefined, active: () => void) => {
    const rows = await listProjectNameRows(userId);
    active();
    const matches = rows.filter((row) => row.project_id === reference || row.name === reference);
    if (!matches.length) return { ok: false as const, error: 'project_not_found' };
    if (matches.length > 1) return { ok: false as const, error: 'project_ambiguous' };
    if (!READ_ACTIONS.has(action || '')) return READ_ONLY;
    const pid = matches[0].project_id;
    const project = await getProject(userId, pid);
    active();
    if (!project) return { ok: false as const, error: 'project_not_found' };
    const { readProjectGoal } = await import('./project_goal');
    const goal = goalsEnabled ? await readProjectGoal(userId, pid) : null;
    active();
    return { ok: true as const,
      project: { project_id: pid, name: project.name,
        ...(goalsEnabled ? { goal: goal ? { goal: goal.goal, success_criteria: goal.success_criteria, status: goal.status } : null } : {}) },
      handler: readOnlyHandler(createProjectTasksHandler(userId, pid, cid, names, { actorId: 'commander' },
        { sourceProjectId: '' }, undefined, undefined, signal, active)) };
  };
  let selectedCreatedProject: string | undefined;
  const handler = (pid: string, signal?: AbortSignal, guard?: () => void) =>
    createProjectTasksHandler(userId, pid, cid, names, { actorId: 'commander' },
      { sourceProjectId: '' }, onSaved, onDeleted, signal, guard);
  return createProjectTasksTool(handler(''), {
    globalScope: true,
    includeProjectGoal: goalsEnabled,
    listProjects: async () => {
      if (getActiveUserId() !== userId) throw new Error('account_changed');
      const rows = await listProjectNameRows(userId);
      if (getActiveUserId() !== userId) throw new Error('account_changed');
      return rows.map(({ project_id, name }) => ({ project_id, name }));
    },
    resolveScope: async (reference, signal, action) => {
      const active = () => {
        if (signal?.aborted) throw new Error('task_operation_cancelled');
        if (getActiveUserId() !== userId) throw new Error('account_changed');
      };
      active();
      const pending = pendingCreatedProjectId(userId, cid);
      // Naming another project reads it; every write there is refused.
      if (reference !== undefined && reference !== '__global__' && reference !== pending) {
        return readOtherProject(reference.trim(), action, signal, active);
      }
      // An old tool must not silently redirect work after its selected creation
      // was cancelled, replaced or drained, including a failed conversation move.
      if (reference !== '__global__' && selectedCreatedProject && pending !== selectedCreatedProject) {
        return { ok: false, error: 'project_scope_changed' };
      }
      const pid = reference === '__global__' ? '' : pending || '';
      const guard = () => {
        active();
        if (pid && pendingCreatedProjectId(userId, cid) !== pid) throw new Error('project_scope_changed');
      };
      let name = '';
      if (pid) {
        selectedCreatedProject = pid;
        const project = await getProject(userId, pid);
        guard();
        if (!project || project.owner_uid !== userId) {
          return { ok: false, error: 'project_scope_unavailable' };
        }
        name = project.name;
      }
      return { ok: true, project: { project_id: pid || '__global__', name }, handler: handler(pid, signal, guard) };
    },
  });
}
