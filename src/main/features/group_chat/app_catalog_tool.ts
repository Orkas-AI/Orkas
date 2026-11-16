import type { AgentTool } from '#core-agent';
import { listAppCatalog, type AppCatalogLifetime } from '../app_catalog';

export function buildListAppsTool(userId: string, lifetime: AppCatalogLifetime): AgentTool {
  return {
    name: 'list_apps',
    description: 'List the current account\'s built-in and saved applications with names, purposes, availability, and exact navigation arguments for open_app_view. This lookup does not stage cards or launch applications.',
    inputSchema: {
      type: 'object',
      properties: {
        source: { type: 'string', enum: ['all', 'builtin', 'custom'], default: 'all' },
        limit: { type: 'integer', minimum: 1, maximum: 50, default: 20 },
        offset: { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER, default: 0,
          description: 'Zero-based offset; continue with next_offset when present. Pages reflect current local metadata, not a frozen snapshot.' },
      },
      additionalProperties: false,
    },
    executionMode: 'parallel',
    async execute(input, context) {
      const result = await listAppCatalog(userId, input, {
        isActive: () => !lifetime.signal?.aborted && lifetime.isActive(),
        signal: context?.signal || lifetime.signal,
      });
      return { content: JSON.stringify(result), ...(!result.ok ? { isError: true } : {}) };
    },
  };
}
