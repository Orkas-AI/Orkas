import type { AgentTool } from '#core-agent';
import { saveApplication, type AppSaveScope } from '../app_save';

export function buildSaveAppTool(resolveScope: () => AppSaveScope | Promise<AppSaveScope>): AgentTool {
  return {
    name: 'save_app',
    description: 'Inspect or save an application from this task. Updates preserve the bound application identity and compatible data; saving does not publish it.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['inspect', 'save'], default: 'save',
          description: 'Both actions require exactly one source: artifact_id or path. Inspect returns the bound saved destination and its revision without saving.' },
        artifact_id: { type: 'string', pattern: '^[A-Za-z0-9_-]+$',
          description: 'Exact recorded application artifact ID in this conversation. If you only know its title, retrieve the ID with chat_history first.' },
        path: { type: 'string', description: 'Application folder or HTML entry, absolute or relative to this task workspace. Use a dedicated app folder.' },
        mode: { type: 'string', enum: ['auto', 'new', 'update'], default: 'auto',
          description: 'Auto creates if unbound and otherwise updates. New explicitly saves an independent copy. Update requires an available bound destination.' },
        app_id: { type: 'string', description: 'For updates, the bound app_id returned by inspect; this verifies the destination and cannot select another application.' },
        expected_revision: { type: 'string', description: 'For updates, the opaque revision returned by inspect. Changed destinations are rejected.' },
      },
      additionalProperties: false,
    },
    async execute(input, context) {
      try {
        const scope = await resolveScope();
        const result = await saveApplication({ ...scope, isActive: () => !context?.signal?.aborted && scope.isActive() }, input);
        return { content: JSON.stringify(result), ...(!result.ok ? { isError: true } : {}) };
      } catch {
        return { content: JSON.stringify({ ok: false, status: 'blocked', code: 'app_save_failed',
          message: 'The application could not be saved. Try again from its source task.' }), isError: true };
      }
    },
  };
}
