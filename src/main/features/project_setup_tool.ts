/** One Commander-bound executor for giving this conversation's work a project. */
import { z } from 'zod';
import type { AgentTool } from '../../core-agent/src/tools/base';
import * as filing from './conversation_filing';
import * as projects from './projects';
import * as projectTasks from './project_tasks';
import { createLogger } from '../logger';
import { logErrorSummary, maskId } from '../util/log-redact';

const log = createLogger('project-setup-tool');

/** Enough to open a backlog, not a planning surface: `todo_tasks` owns the rest. */
const MAX_INITIAL_TODOS = 10;
/** Matches the `todo_tasks` content bound. */
const MAX_TODO_CHARS = 4000;
const MAX_PROJECT_NAME_CHARS = 80;
/** A goal is a few sentences, not a brief: it enters every project
 *  conversation's stable prefix, so every character is paid on every turn. */
const MAX_GOAL_CHARS = 400;

const schema = z.object({
  action: z.enum(['create', 'unfile', 'rename']),
  name: z.string().min(1).max(MAX_PROJECT_NAME_CHARS).optional(),
  todos: z.array(z.string().min(1).max(MAX_TODO_CHARS)).max(MAX_INITIAL_TODOS).optional(),
  goal: z.string().min(1).max(MAX_GOAL_CHARS).optional(),
}).strict();

export function createProjectSetupTool(opts: {
  userId: string;
  cid: string;
  /** The project this conversation already belongs to, when it has one. */
  projectId?: string | null;
}): AgentTool {
  return {
    name: 'project_setup',
    description: 'Create or rename the project for this conversation, or undo its filing. '
      + '`create` makes the project, opens it with the to-dos you pass, saves the goal you pass as its instructions, '
      + 'and files this conversation under it when the turn ends; `unfile` returns the conversation to the unprojected list. '
      + '`rename` saves a new name for its existing or just-created project immediately. '
      + 'Use `todo_tasks` for a backlog that already has a project.',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['create', 'unfile', 'rename'],
          description: 'create: a new project. unfile: undo filing. rename: rename this conversation\'s project.',
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
        goal: {
          type: 'string',
          minLength: 1,
          maxLength: MAX_GOAL_CHARS,
          description: 'create only: what the project is for, in one to three sentences in the user\'s language, '
            + 'taken from what the user said. Saved as the project instructions that every conversation in the '
            + 'project receives; the user can edit them in the project. Omit when the user stated no goal.',
        },
      },
      required: ['action'],
      additionalProperties: false,
    },
    async execute(input) {
      const fail = (error: string, extra: Record<string, unknown> = {}) =>
        ({ content: JSON.stringify({ ok: false, error, ...extra }), isError: true });
      const parsed = schema.safeParse(input);
      if (!parsed.success) {
        return fail(parsed.error.issues.map((issue) => `${issue.path.join('.') || 'input'}: ${issue.message}`).join('; '));
      }
      const { action } = parsed.data;
      const ignored = action === 'create'
        ? []
        : (action === 'rename' ? ['todos', 'goal'] : ['name', 'todos', 'goal'])
          .filter((field) => (parsed.data as Record<string, unknown>)[field] !== undefined);

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

      if (action === 'unfile') {
        // Undoing moves the same bytes, so it waits for the same boundary the
        // filing does.
        const result = await filing.unfileConversation(opts.userId, opts.cid, { moveNow: false });
        if (!result.ok) {
          return fail((result as { error: string }).error, {
            ...(ignored.length ? { ignored_fields: ignored } : {}),
          });
        }
        log.info(`project unfile queued uid=${maskId(opts.userId)} cid=${maskId(opts.cid)}`);
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

      // The goal becomes the project's instructions: the rules rail shows it
      // and every conversation in the project receives it. A failed save is
      // reported, not retried; the user can still write it in the project.
      let goalSaved: boolean | undefined;
      if (parsed.data.goal) {
        const saved = await projects.writeProjectInstructions(opts.userId, project.project_id, parsed.data.goal.trim());
        goalSaved = saved.ok;
        if (!saved.ok) {
          log.warn(`project goal save failed uid=${maskId(opts.userId)} pid=${maskId(project.project_id)} error=${(saved as { error: string }).error}`);
        }
      }

      const created: string[] = [];
      const rejected: string[] = [];
      for (const content of parsed.data.todos ?? []) {
        try {
          const task = await projectTasks.createTask(opts.userId, project.project_id, { content, created_by: 'agent' });
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
        }),
      };
    },
  };
}
