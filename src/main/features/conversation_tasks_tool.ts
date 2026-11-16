/** Commander backlog scope while a newly-created project awaits conversation filing. */
import { createProjectTasksTool } from '../../core-agent/src/tools/project-tasks-tool';
import { pendingCreatedProjectId } from './conversation_filing';
import { createProjectTasksHandler } from './project_tasks_tool_handler';
import { getProject } from './projects';
import { getActiveUserId } from './users';

export function createConversationTasksTool(
  userId: string, cid: string, names: ReadonlyMap<string, string>,
  onSaved?: (taskId: string, projectId: string, content: string) => void,
  onDeleted?: (taskId: string, projectId: string) => void,
) {
  let selectedCreatedProject: string | undefined;
  const handler = (pid: string, signal?: AbortSignal, guard?: () => void) =>
    createProjectTasksHandler(userId, pid, cid, names, { actorId: 'commander' },
      { sourceProjectId: '' }, onSaved, onDeleted, signal, guard);
  return createProjectTasksTool(handler(''), {
    globalScope: true,
    resolveScope: async (reference, signal) => {
      const active = () => {
        if (signal?.aborted) throw new Error('task_operation_cancelled');
        if (getActiveUserId() !== userId) throw new Error('account_changed');
      };
      active();
      const pending = pendingCreatedProjectId(userId, cid);
      // An old tool must not silently redirect work after its selected creation
      // was cancelled, replaced or drained, including a failed conversation move.
      if (reference !== '__global__' && selectedCreatedProject && pending !== selectedCreatedProject) {
        return { ok: false, error: 'project_scope_changed' };
      }
      if (reference !== undefined && reference !== '__global__' && reference !== pending) {
        return { ok: false, error: 'project_scope_mismatch' };
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
