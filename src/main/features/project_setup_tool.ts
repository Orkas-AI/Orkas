/** One Commander-bound executor for giving this conversation's work a project. */
import { z } from 'zod';
import type { AgentTool } from '../../core-agent/src/tools/base';
import * as filing from './conversation_filing';
import * as projectGoal from './project_goal';
import * as projectTasks from './project_tasks';
import * as projects from './projects';
import { getActiveUserId } from './users';
import { createLogger } from '../logger';
import { logErrorSummary, maskId } from '../util/log-redact';
import { projectGoalAndRecapEnabled } from '../util/project-feature-flags';

const log = createLogger('project-setup-tool');

/** Enough to open a backlog, not a planning surface: `todo_tasks` owns the rest. */
const MAX_INITIAL_TODOS = 10;
/** Matches the `todo_tasks` content bound. */
const MAX_TODO_CHARS = 4000;
const MAX_PROJECT_NAME_CHARS = 80;
const MAX_AGENTS = 20;
/** A goal is a few sentences, not a brief: it enters every project
 *  conversation's stable prefix, so every character is paid on every turn. */
const MAX_GOAL_CHARS = projectGoal.GOAL_MAX_CHARS;
const ACTIONS = ['create', 'rename', 'set_goal', 'move_conversation', 'remove_conversation', 'add_agents'] as const;
/** Fields each action reads; the rest are reported as ignored. */
const ACTION_FIELDS: Readonly<Record<typeof ACTIONS[number], readonly string[]>> = {
  create: ['name', 'todos', 'goal', 'success_criteria'],
  rename: ['name'],
  set_goal: ['goal', 'success_criteria', 'status'],
  move_conversation: ['target_project'],
  remove_conversation: [],
  add_agents: ['agents', 'target_project'],
};

const schema = z.object({
  action: z.enum(ACTIONS),
  target_project: z.string().trim().min(1).max(128).optional(),
  agents: z.array(z.string().trim().min(1).max(128)).min(1).max(MAX_AGENTS).optional(),
  name: z.string().min(1).max(MAX_PROJECT_NAME_CHARS).optional(),
  todos: z.array(z.string().min(1).max(MAX_TODO_CHARS)).max(MAX_INITIAL_TODOS).optional(),
  // Empty is allowed: set_goal clears with it, create treats it as no goal.
  goal: z.string().max(MAX_GOAL_CHARS).optional(),
  success_criteria: z.array(z.string().trim().min(1).max(projectGoal.SUCCESS_CRITERION_MAX_CHARS))
    .max(projectGoal.SUCCESS_CRITERIA_MAX).optional(),
  // Pausing waits for auto-advance to follow the goal, so it is not offered.
  status: z.enum(projectGoal.GOAL_STATUSES).optional(),
}).strict();

type AgentAddResult = (
  | { status: 'added' | 'already_present'; agent_id: string }
  | { status: 'failed' | 'unconfirmed'; agent_id?: string; error: string }
) & { agent: string };

async function addExistingAgents(
  userId: string,
  project: projects.Project,
  refs: readonly string[],
  signal?: AbortSignal,
): Promise<AgentAddResult[]> {
  const pid = project.project_id;
  const agents = await import('./agents');
  const roster = await agents.listAgentSummaries();
  const initial = await projects.getBindings(userId, pid);
  const bound = new Set(initial.agents);
  const results: AgentAddResult[] = [];
  for (const ref of refs) {
    if (signal?.aborted || getActiveUserId() !== userId) {
      results.push({ agent: ref, status: 'failed', error: signal?.aborted ? 'cancelled' : 'account_changed' });
      continue;
    }
    const exactId = roster.find(entry => entry.agent_id === ref);
    const matches = exactId ? [exactId] : roster.filter(entry => entry.name === ref);
    if (matches.length !== 1) {
      results.push(!matches.length && bound.has(ref)
        ? { agent: ref, agent_id: ref, status: 'already_present' }
        : { agent: ref, status: 'failed', error: matches.length ? 'agent_ambiguous' : 'agent_not_found' });
      continue;
    }
    const agent = matches[0];
    const identity = { agent: ref, agent_id: agent.agent_id };
    if (!agent.enabled) {
      results.push({ ...identity, status: 'failed', error: 'agent_disabled' });
      continue;
    }
    // Built-in Agents are available in every project without being added.
    if (bound.has(agent.agent_id)
        || agents.agentPrioritySource(agent) === 'builtin') {
      results.push({ ...identity, status: 'already_present' });
      continue;
    }
    try {
      const saved = await projects.addAgentBinding(userId, pid, agent.agent_id);
      if (saved.ok === false) {
        results.push({ ...identity, status: 'failed', error: saved.error });
        continue;
      }
      bound.add(agent.agent_id);
      results.push({ ...identity, status: 'added' });
    } catch {
      if (await projects.isProjectAgentBound(userId, pid, agent.agent_id)) {
        bound.add(agent.agent_id);
        results.push({ ...identity, status: 'added' });
      } else {
        results.push({ ...identity, status: 'unconfirmed', error: 'binding_unconfirmed' });
      }
    }
  }
  return results;
}

export function createProjectSetupTool(opts: {
  userId: string;
  cid: string;
  /** The project this conversation already belongs to, when it has one. */
  projectId?: string | null;
}): AgentTool {
  const goalsEnabled = projectGoalAndRecapEnabled();
  return {
    name: 'project_setup',
    description: `Create or rename a project, ${goalsEnabled ? 'set its goal, ' : ''}add existing Agents, or move the current conversation into or out of a project. `
      + 'Conversation moves apply at turn end. Use `todo_tasks` for backlog changes.',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: goalsEnabled ? [...ACTIONS] : ACTIONS.filter(action => action !== 'set_goal'),
          description: `create: new project and file this conversation when the turn ends. ${goalsEnabled ? 'rename/set_goal' : 'rename'}: current or new project. `
            + 'move_conversation/remove_conversation: change conversation membership only. add_agents: add existing Agents, keep the conversation where it is.',
        },
        target_project: {
          type: 'string', minLength: 1, maxLength: 128,
          description: 'Existing project ID or exact name. Required for move_conversation. With add_agents, omit to use the current project. Omit for all other actions.',
        },
        agents: {
          type: 'array', items: { type: 'string', minLength: 1, maxLength: 128 }, minItems: 1, maxItems: MAX_AGENTS,
          description: 'add_agents only. Use existing Agent IDs or exact names, including an array for a single Agent.',
        },
        name: {
          type: 'string',
          minLength: 1,
          maxLength: MAX_PROJECT_NAME_CHARS,
          description: 'Required for create and rename: the project name, in the user\'s language. '
            + 'Create suffixes duplicates; rename rejects them.',
        },
        todos: {
          type: 'array',
          items: { type: 'string', minLength: 1, maxLength: MAX_TODO_CHARS },
          maxItems: MAX_INITIAL_TODOS,
          description: 'create only: the work to open the backlog with, one item per entry. '
            + 'They land in the new project, not the account-wide backlog.',
        },
        ...(goalsEnabled ? {
          goal: {
            type: 'string',
            maxLength: MAX_GOAL_CHARS,
            description: 'create/set_goal: what the project is for, in one to three sentences in the user\'s language, '
              + 'from what the user said or agreed to. Every conversation in the project receives it. '
              + 'Omit when they stated none; set_goal keeps it when omitted and clears it when empty.',
          },
          success_criteria: {
            type: 'array',
            items: { type: 'string', minLength: 1, maxLength: projectGoal.SUCCESS_CRITERION_MAX_CHARS },
            maxItems: projectGoal.SUCCESS_CRITERIA_MAX,
            description: 'create/set_goal: how the user will know the goal is reached, one checkable statement each, '
              + 'only as the user stated or agreed to; omit when they gave none. set_goal replaces the list; [] removes it.',
          },
          status: {
            type: 'string',
            enum: [...projectGoal.GOAL_STATUSES],
            description: 'set_goal only: achieved once the user agrees the goal is reached; active reopens it. Omitted keeps it.',
          },
        } : {}),
      },
      required: ['action'],
      additionalProperties: false,
    },
    async execute(input, ctx) {
      const fail = (error: string, extra: Record<string, unknown> = {}) =>
        ({ content: JSON.stringify({ ok: false, error, ...extra }), isError: true });
      // An unused destination on create is a conflict even when blank or null.
      // Report the action-specific correction before generic value validation.
      if (input && typeof input === 'object' && 'action' in input && input.action === 'create'
        && 'target_project' in input && input.target_project !== undefined) {
        return fail(
          'Omit target_project to create a new project and file this conversation in it. '
          + 'To file this conversation in an existing project, use move_conversation with target_project.',
          { code: 'E_PROJECT_SETUP_TARGET_ON_CREATE', action: 'create', field: 'target_project' },
        );
      }
      const parsed = schema.safeParse(input);
      if (!parsed.success) {
        return fail(parsed.error.issues.map((issue) => `${issue.path.join('.') || 'input'}: ${issue.message}`).join('; '));
      }
      const action = parsed.data.action;
      if (!goalsEnabled && (action === 'set_goal' || (action === 'create'
        && (parsed.data.goal !== undefined || parsed.data.success_criteria !== undefined || parsed.data.status !== undefined)))) {
        const recovery = action === 'create' ? ' Omit goal, success_criteria and status to create the project.' : '';
        return fail(`Saved project goals are unavailable while the Goal tab is off.${recovery}`, { code: 'E_PROJECT_GOAL_DISABLED' });
      }
      // Never silently discard an explicit destination and execute a different mutation.
      if (!ACTION_FIELDS[action].includes('target_project') && parsed.data.target_project !== undefined) {
        return fail('target_project is only valid for move_conversation and add_agents');
      }
      if (action !== 'add_agents' && parsed.data.agents !== undefined) {
        return fail('agents is only valid for add_agents', { field: 'agents', action });
      }
      const ignored = ['name', 'todos', 'goal', 'success_criteria', 'status']
        .filter((field) => !ACTION_FIELDS[action].includes(field) && (parsed.data as Record<string, unknown>)[field] !== undefined);
      const goalText = parsed.data.goal?.trim() || '';
      if (action === 'create' && parsed.data.success_criteria?.length && !goalText) {
        return fail('success_criteria needs a goal');
      }

      if (action === 'add_agents') {
        if (!parsed.data.agents) return fail('agents is required for add_agents', { field: 'agents', action });
        if (ignored.length) return fail('add_agents accepts only agents and target_project', { ignored_fields: ignored, action });
        if (getActiveUserId() !== opts.userId) return fail('account_changed');
        const current = await filing.conversationProjectId(opts.userId, opts.cid);
        if (current.ok === false && current.error === 'not_found') return fail(current.error);
        let pid = current.ok ? current.projectId : undefined;
        if (parsed.data.target_project) {
          const ref = parsed.data.target_project;
          const matches = (await projects.listProjectNameRows(opts.userId))
            .filter(row => row.project_id === ref || row.name === ref);
          if (matches.length !== 1) return fail(matches.length ? 'project_ambiguous' : 'project_not_found');
          pid = matches[0].project_id;
        }
        if (!pid) return fail('target_project is required outside a project', { field: 'target_project', action });
        const project = await projects.getProject(opts.userId, pid);
        if (!project) return fail('project_not_found');
        if (project.owner_uid !== opts.userId) return fail('forbidden');
        try {
          const results = await addExistingAgents(opts.userId, project, parsed.data.agents, ctx?.signal);
          const successes = results.filter(row => row.status === 'added' || row.status === 'already_present').length;
          const ok = successes === results.length;
          return {
            content: JSON.stringify({
              ok, action, project_id: pid, project_name: project.name,
              status: ok ? 'completed' : successes ? 'partial' : 'failed', results,
            }),
            ...(successes === 0 ? { isError: true } : {}),
          };
        } catch (error) {
          log.warn('project Agent lookup unavailable', logErrorSummary(error));
          return fail('project_agent_lookup_unavailable');
        }
      }

      if (action === 'set_goal') {
        if (parsed.data.goal === undefined && parsed.data.success_criteria === undefined && parsed.data.status === undefined) {
          return fail('set_goal needs goal, success_criteria or status');
        }
        const scope = await filing.conversationProjectId(opts.userId, opts.cid);
        if (!scope.ok) return fail((scope as { error: string }).error);
        const saved = await projectGoal.saveProjectGoal(opts.userId, scope.projectId, {
          ...(parsed.data.goal !== undefined ? { goal: parsed.data.goal } : {}),
          ...(parsed.data.success_criteria !== undefined ? { success_criteria: parsed.data.success_criteria } : {}),
          ...(parsed.data.status !== undefined ? { status: parsed.data.status } : {}),
        }, 'agent');
        if (!saved.ok) return fail((saved as { error: string }).error);
        const goal = (saved as { goal: projectGoal.ProjectGoal | null }).goal;
        return {
          content: JSON.stringify({
            ok: true, action, project_id: scope.projectId, applies: 'now',
            goal_status: goal ? goal.status : 'none',
            success_criteria_count: goal ? goal.success_criteria.length : 0,
            ...(ignored.length ? { ignored_fields: ignored } : {}),
          }),
        };
      }

      if (action === 'move_conversation') {
        if (!parsed.data.target_project) return fail('target_project is required for move_conversation');
        const result = await filing.moveConversationToExistingProject(opts.userId, opts.cid, parsed.data.target_project);
        if (!result.ok) return fail((result as { error: string }).error);
        return { content: JSON.stringify({
          ok: true, action, project_id: result.project.project_id, project_name: result.project.name,
          applies: result.applies, ...(ignored.length ? { ignored_fields: ignored } : {}),
        }) };
      }

      if (action === 'rename') {
        if (!parsed.data.name) return fail('name is required to rename a project');
        const result = await filing.renameConversationProject(opts.userId, opts.cid, parsed.data.name);
        if (!result.ok) return fail((result as { error: string }).error);
        return {
          content: JSON.stringify({
            ok: true, action, project_id: result.project.project_id,
            project_name: result.project.name, applies: 'now',
            ...(ignored.length ? { ignored_fields: ignored } : {}),
          }),
        };
      }

      if (action === 'remove_conversation') {
        // Undoing moves the same bytes, so it waits for the same boundary the
        // filing does.
        const result = await filing.unfileConversation(opts.userId, opts.cid, { moveNow: false });
        if (!result.ok) {
          return fail((result as { error: string }).error, {
            ...(ignored.length ? { ignored_fields: ignored } : {}),
          });
        }
        log.info(`conversation removal queued uid=${maskId(opts.userId)} cid=${maskId(opts.cid)}`);
        return {
          content: JSON.stringify({
            ok: true,
            action,
            left_project_id: opts.projectId || (result as { conversation: { project_id?: string } }).conversation.project_id || '',
            applies: 'when_this_turn_ends',
            ...(ignored.length ? { ignored_fields: ignored } : {}),
          }),
        };
      }

      if (!parsed.data.name) return fail('name is required to create a project');
      const filed = await filing.fileConversationUnderNewProject(
        opts.userId, opts.cid, parsed.data.name,
        // A model turn cannot relocate its own conversation: the relocation
        // refuses while this turn holds the session files open. The host
        // completes it once the conversation goes quiescent.
        { moveNow: false, uniquifyName: true },
      );
      if (!filed.ok) {
        const error = (filed as { error: string }).error;

        return fail(error);
      }
      const { project, bound, unbound } = (filed as { result: filing.ConversationFilingResult }).result;

      // The goal is the project's own record, not its rules: the goal tab shows
      // it and every conversation in the project receives it. A failed save is
      // reported, not retried; the user can still set it in the project.
      let goalSaved: boolean | undefined;
      if (goalText) {
        const saved = await projectGoal.saveProjectGoal(opts.userId, project.project_id, {
          goal: goalText, success_criteria: parsed.data.success_criteria ?? [],
        }, 'agent');
        goalSaved = saved.ok;
        if (!saved.ok) {
          log.warn(`project goal save failed uid=${maskId(opts.userId)} pid=${maskId(project.project_id)} error=${(saved as { error: string }).error}`);
        }
      }

      const created: string[] = [];
      const rejected: string[] = [];
      for (const content of parsed.data.todos ?? []) {
        try {
          const task = await projectTasks.createTask(opts.userId, project.project_id, { content, created_by: 'agent', change_cid: opts.cid });
          if (task.ok) created.push((task as { task: { id: string } }).task.id);
          else rejected.push((task as { error: string }).error);
        } catch (err) {
          log.warn(`initial todo failed uid=${maskId(opts.userId)} pid=${maskId(project.project_id)}`, logErrorSummary(err));
          rejected.push('write_failed');
        }
      }

      filing.setPendingConversationFilingTodoCount(opts.userId, opts.cid, project.project_id, created.length);

      log.info(`project set up uid=${maskId(opts.userId)} cid=${maskId(opts.cid)} pid=${maskId(project.project_id)}`
        + ` todos=${created.length} rejected=${rejected.length} bound=${bound.length}`);
      return {
        content: JSON.stringify({
          ok: true,
          action,
          project_id: project.project_id,
          // The host may have suffixed a duplicate name, so tell the user what
          // the project is actually called.
          project_name: project.name,
          // Not moved yet: the relocation runs when this turn ends.
          applies: 'when_this_turn_ends',
          todos_created: created.length,
          ...(rejected.length ? { todos_rejected: rejected } : {}),
          ...(goalSaved !== undefined ? { goal_saved: goalSaved } : {}),
          agents_carried_over: bound.length,
          ...(unbound.length ? { agents_not_carried_over: unbound.length } : {}),
          ...(ignored.length ? { ignored_fields: ignored } : {}),
        }),
      };
    },
  };
}
