/** One host-bound automation executor shared by Commander, named Agents, and CLI. */
import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import type { AgentTool } from '../../core-agent/src/tools/base';
import * as autoTasks from './auto_tasks';
import { projectExists } from './projects';

const contract = require('../../../bin/auto-tasks-contract.cjs');
const EDIT_FIELDS = ['title', 'content', 'schedule', 'enabled', 'end_condition', 'recipient', 'skill', 'connector', 'attachments', 'project_id'];

function taskView(task: autoTasks.AutoTask) {
  const { device_id: _deviceId, ...view } = task;
  return view;
}

export function createAutoTasksTool(opts: { userId: string; cid?: string; projectId?: string }): AgentTool {
  const schema = z.object(contract.shape(z, !!opts.projectId)).strict();
  return {
    name: 'auto_tasks',
    description: contract.description,
    inputSchema: zodToJsonSchema(schema) as any,
    async execute(input) {
      const fail = (error: string) => ({ content: JSON.stringify({ ok: false, error }), isError: true });
      const parsed = schema.safeParse(input);
      if (!parsed.success) return fail(parsed.error.issues.map((issue) => `${issue.path.join('.') || 'input'}: ${issue.message}`).join('; '));
      const data = parsed.data as Record<string, any>;
      const { action, task_id: taskId } = data;
      const fields = action === 'list' ? ['action', 'project_id', 'offset', 'limit']
        : action === 'create' ? ['action', ...EDIT_FIELDS]
          : action === 'update' ? ['action', 'task_id', ...EDIT_FIELDS] : ['action', 'task_id'];
      if (Object.keys(data).some((key) => !fields.includes(key))) return fail(`Unrelated fields; allowed for ${action}: ${fields.join(', ')}`);
      if (action !== 'list' && action !== 'create' && !taskId) return fail('task_id is required; list automations to find it');
      if (action === 'create' && (!data.content?.trim() || !data.schedule)) return fail('create requires content and schedule');
      if (action === 'update' && !EDIT_FIELDS.some((key) => data[key] !== undefined)) return fail('update requires at least one changed field');
      try {
        if (opts.projectId && !await projectExists(opts.userId, opts.projectId)) return fail('project_not_found');
        if (action === 'list') {
          const selected = opts.projectId ?? data.project_id;
          const tasks = await autoTasks.listTasks(opts.userId, selected !== undefined ? { projectId: selected } : undefined);
          const offset = data.offset ?? 0;
          const page: ReturnType<typeof taskView>[] = [];
          let bytes = 0;
          for (const task of tasks.slice(offset, offset + (data.limit ?? 20))) {
            const view = taskView(task);
            const size = Buffer.byteLength(JSON.stringify(view), 'utf8');
            if (bytes + size > 32000) break;
            page.push(view); bytes += size;
          }
          if (!page.length && offset < tasks.length) return fail('task record exceeds read limit');
          return { content: JSON.stringify({ ok: true, tasks: page, next_offset: offset + page.length < tasks.length ? offset + page.length : null }) };
        }
        const updates = Object.fromEntries(EDIT_FIELDS.filter((key) => data[key] !== undefined).map((key) => [key, data[key]]));
        const result = await autoTasks.applyAutoTaskContainerFromCommander(opts.userId, {
          action, taskId, updates,
        }, { sourceAttachmentCid: opts.cid, projectId: opts.projectId });
        if (!result.ok && result.error && !/^[a-z][a-z0-9_]*$/.test(result.error)) return fail('automation operation failed');
        return { content: JSON.stringify({ ...result, ...(result.task ? { task: taskView(result.task) } : {}) }), isError: !result.ok };
      } catch { return fail('automation operation failed'); }
    },
  };
}
