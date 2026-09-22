/** One host-bound automation executor shared by Commander, named Agents, and CLI. */
import { z } from 'zod';
import type { AgentTool } from '../../core-agent/src/tools/base';
import * as autoTasks from './auto_tasks';
import { projectExists } from './projects';
import { taskSummaryPage } from './task_query';
import { createLogger } from '../logger';
import { logErrorSummary } from '../util/log-redact';

const log = createLogger('auto-tasks-tool');

const contract = require('../../../bin/auto-tasks-contract.cjs');
const EDIT_FIELDS = ['title', 'content', 'schedule', 'enabled', 'end_condition', 'recipient', 'skill', 'connector', 'attachments', 'project_id'];

function taskView(task: autoTasks.AutoTask) {
  const { device_id: _deviceId, ...view } = task;
  return view;
}

function taskSummary(task: autoTasks.AutoTask) {
  return {
    id: task.id, title: task.title, content_preview: task.content.slice(0, 200), enabled: task.enabled, schedule: task.schedule,
    ...(task.project_id ? { project_id: task.project_id } : {}),
    recipient: task.recipient,
    ...(task.end_condition ? { end_condition: task.end_condition } : {}),
    ...(task.end_condition?.type === 'count' ? { scheduled_run_count: task.scheduled_run_count || 0 } : {}),
    created_at: task.created_at, updated_at: task.updated_at,
    ...(task.last_run_at ? { last_run_at: task.last_run_at } : {}),
  };
}

export function createAutoTasksTool(opts: {
  userId: string;
  cid?: string;
  projectId?: string | null;
  /** Saved automation id, for the host's click-through offer. Not called for a
   *  delete: there is nothing left to open. */
  onSaved?: (taskId: string) => void;
}): AgentTool {
  const schema = z.object(contract.shape(z, opts.projectId !== undefined)).strict();
  return {
    name: 'auto_tasks',
    description: contract.description,
    inputSchema: contract.inputSchema(z, opts.projectId !== undefined),
    async execute(input) {
      const fail = (error: string) => ({ content: JSON.stringify({ ok: false, error }), isError: true });
      const parsed = schema.safeParse(input);
      if (!parsed.success) return fail(parsed.error.issues.map((issue) => `${issue.path.join('.') || 'input'}: ${issue.message}`).join('; '));
      const data = parsed.data as Record<string, any>;
      const { action, task_id: taskId } = data;
      const fields = action === 'list' ? ['action', 'project_id', 'offset', 'limit', 'enabled']
        : action === 'create' ? ['action', ...EDIT_FIELDS]
          : action === 'update' ? ['action', 'task_id', ...EDIT_FIELDS] : ['action', 'task_id'];
      if (Object.keys(data).some((key) => !fields.includes(key))) return fail(`Unrelated fields; allowed for ${action}: ${fields.join(', ')}`);
      if (action !== 'list' && action !== 'create' && !taskId) return fail('task_id is required; list automations to find it');
      if (action === 'create' && (!data.content?.trim() || !data.schedule)) return fail('create requires content and schedule');
      if (action === 'update' && !EDIT_FIELDS.some((key) => data[key] !== undefined)) return fail('update requires at least one changed field');
      try {
        if (opts.projectId && !await projectExists(opts.userId, opts.projectId)) return fail('project_not_found');
        if (action === 'list') {
          const selected = opts.projectId !== undefined ? opts.projectId : data.project_id;
          const tasks = await autoTasks.listTasks(opts.userId, selected !== undefined ? { projectId: selected } : undefined);
          const summaries = tasks.filter((task) => data.enabled === undefined || task.enabled === data.enabled)
            .sort((a, b) => b.created_at.localeCompare(a.created_at) || a.id.localeCompare(b.id)).map(taskSummary);
          return { content: JSON.stringify({ ok: true, ...taskSummaryPage(summaries, data.offset, data.limit) }) };
        }
        if (action === 'get') {
          const task = await autoTasks.getTask(opts.userId, taskId);
          if (!task || (opts.projectId !== undefined && (task.project_id ?? null) !== opts.projectId)) return fail('task_not_found');
          return { content: JSON.stringify({ ok: true, task: taskView(task) }) };
        }
        const updates = Object.fromEntries(EDIT_FIELDS.filter((key) => data[key] !== undefined).map((key) => [key, data[key]]));
        const result = await autoTasks.applyAutoTaskMutation(opts.userId, {
          action, taskId, updates,
        }, { sourceAttachmentCid: opts.cid, projectId: opts.projectId });
        if (!result.ok && result.error && !/^[a-z][a-z0-9_]*$/.test(result.error)) return fail('automation operation failed');
        if (result.ok && result.taskId && result.kind !== 'deleted') {
          try { opts.onSaved?.(result.taskId); } catch { /* navigation is an offer, never a failure */ }
        }
        return { content: JSON.stringify({ ...result, ...(result.task ? { task: taskView(result.task) } : {}) }), isError: !result.ok };
      } catch (err) {
        log.warn('automation tool operation failed', { error: logErrorSummary(err) });
        return fail('automation operation failed');
      }
    },
  };
}
