import { describe, expect, it, vi } from 'vitest';
import { createPiProvider } from '../../../../src/core-agent/src/providers/pi-provider';
import { toToolDefinition } from '../../../../src/core-agent/src/tools/base';
import { createRunProgramTool } from '../../../../src/core-agent/src/tools/run-program';
import { createProjectTasksTool } from '../../../../src/core-agent/src/tools/project-tasks-tool';
import { createToolResultTools } from '../../../../src/main/model/core-agent/tool-result-tools';
import { buildCustomOpenAICompatibleModel } from '../../../../src/main/model/core-agent/external-providers';
import { enumerateAllInjectedTools } from './injected-tool-fixture';

function definitions() {
  const names = new Set(['cross_session_memory', 'metacognition', 'process_session', 'interactive_cli', 'chat_history', 'library']);
  const fail = async () => { throw new Error('Schema probe must not execute tools'); };
  return [
    ...enumerateAllInjectedTools().filter(tool => names.has(tool.name)),
    createProjectTasksTool({ list: fail, get: fail, create: fail, update: fail, complete: fail }),
    createRunProgramTool({ listToolNames: () => [], invokeTool: fail, loadSourceFile: fail }),
    ...createToolResultTools({ toolResultsDir: '/unused', materializeDir: '/unused', isProgrammaticToolCallContext: () => false }),
  ].map(toToolDefinition);
}

describe('custom endpoint root-schema compatibility through the real SDK', () => {
  it.each(['complete', 'stream'] as const)('admits all nine tools on %s and rejects the historical root union', async mode => {
    // Simulate the precise admission rule observed in global samples 8393/8395/8397.
    const requestFetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
      const payload = JSON.parse(String(init?.body));
      expect(payload.tools).toHaveLength(9);
      const invalid = payload.tools.some((tool: any) => {
        const schema = tool.function.parameters;
        return schema.type !== 'object' || ['oneOf', 'anyOf', 'allOf', 'enum', 'const', 'not'].some(key => Object.hasOwn(schema, key));
      });
      if (invalid) return new Response(JSON.stringify({ error: { message: 'Tool root must be an object without composition keywords', type: 'invalid_request_error' } }), { status: 400, headers: { 'content-type': 'application/json' } });
      const chunk = (delta: object, finish_reason: string | null) => ({ id: 'fixture', object: 'chat.completion.chunk', created: 1, model: 'schema-test', choices: [{ index: 0, delta, finish_reason }] });
      return new Response([chunk({ role: 'assistant', content: 'hello' }, null), chunk({}, 'stop')].map(value => `data: ${JSON.stringify(value)}\n\n`).join('') + 'data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } });
    });
    try {
      const provider = createPiProvider({ provider: 'custom', apiKey: 'synthetic', customModel: buildCustomOpenAICompatibleModel('schema-test', { baseUrl: 'https://schema.example.test/v1', contextWindow: 128000, maxTokens: 1024 }) });
      for (const legacy of [false, true]) {
        const tools = definitions();
        if (legacy) tools[0].inputSchema = { ...tools[0].inputSchema, oneOf: [{ required: ['action'] }] };
        const request = { model: 'schema-test', messages: [{ role: 'user' as const, content: [{ type: 'text' as const, text: 'hello' }] }], tools };
        if (mode === 'complete') {
          if (legacy) await expect(provider.complete(request)).rejects.toMatchObject({ statusCode: 400 });
          else expect((await provider.complete(request)).content).toContainEqual({ type: 'text', text: 'hello' });
        } else {
          const events = [];
          for await (const event of provider.stream(request)) events.push(event);
          expect(events.some(event => event.type === 'error')).toBe(legacy);
          if (!legacy) expect(events.some(event => event.type === 'message_end')).toBe(true);
        }
      }
      expect(requestFetch).toHaveBeenCalledTimes(2);
    } finally { requestFetch.mockRestore(); }
  });
});
