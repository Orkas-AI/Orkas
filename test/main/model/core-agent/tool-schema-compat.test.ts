import { describe, expect, it, vi } from 'vitest';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv';
import { createPiProvider } from '../../../../src/core-agent/src/providers/pi-provider';
import { toToolDefinition } from '../../../../src/core-agent/src/tools/base';
import { buildCustomOpenAICompatibleModel } from '../../../../src/main/model/core-agent/external-providers';
import { enumerateAllInjectedTools, enumerateRuntimeSchemaTools } from './injected-tool-fixture';

function definitions() {
  return [
    ...enumerateAllInjectedTools(),
    ...enumerateRuntimeSchemaTools(),
  ].map(tool => ({ ...toToolDefinition(tool) }));
}

function containsUnion(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  return Object.entries(value).some(([key, child]) => ['oneOf', 'anyOf'].includes(key) || containsUnion(child));
}

function nestedSchema(tools: ReturnType<typeof definitions>, name: 'tool_result' | 'create_xlsx'): any {
  const schema = tools.find(tool => tool.name === name)!.inputSchema as any;
  return name === 'tool_result'
    ? schema.properties.requests.items
    : schema.properties.sheets.items.properties.rows.items.items;
}

describe('first-party tool schema portability through the real SDK', () => {
  it.each(['complete', 'stream'] as const)('admits common and runtime tools on %s and rejects root or nested unions', async mode => {
    const requestFetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
      const payload = JSON.parse(String(init?.body));
      expect(payload.tools.length).toBeGreaterThan(30);
      expect(payload.tools.map((tool: any) => tool.function.name)).toEqual(expect.arrayContaining([
        'skill_manage', 'tool_result', 'todo_tasks', 'run_program',
        'cross_session_memory', 'create_xlsx', 'auto_tasks',
      ]));
      const invalid = payload.tools.some((tool: any) => {
        const schema = tool.function.parameters;
        return schema.type !== 'object' || containsUnion(schema)
          || ['allOf', 'enum', 'const', 'not'].some(key => Object.hasOwn(schema, key));
      });
      if (invalid) {
        return new Response(JSON.stringify({
          error: { message: 'Unsupported root composition or union', type: 'invalid_request_error' },
        }), { status: 400, headers: { 'content-type': 'application/json' } });
      }
      const chunk = (delta: object, finish_reason: string | null) => ({
        id: 'fixture', object: 'chat.completion.chunk', created: 1, model: 'schema-test',
        choices: [{ index: 0, delta, finish_reason }],
      });
      return new Response(
        [chunk({ role: 'assistant', content: 'hello' }, null), chunk({}, 'stop')]
          .map(value => `data: ${JSON.stringify(value)}\n\n`).join('') + 'data: [DONE]\n\n',
        { headers: { 'content-type': 'text/event-stream' } },
      );
    });
    try {
      const provider = createPiProvider({
        provider: 'custom',
        apiKey: 'synthetic',
        customModel: buildCustomOpenAICompatibleModel('schema-test', {
          baseUrl: 'https://schema.example.test/v1', contextWindow: 128000, maxTokens: 1024,
        }),
      });
      for (const legacy of [null, 'root', 'tool_result', 'create_xlsx', 'auto_tasks'] as const) {
        const tools = definitions();
        if (legacy === 'root') {
          tools[0].inputSchema = { ...tools[0].inputSchema, oneOf: [{ required: ['action'] }] };
        } else if (legacy) {
          const tool = tools.find(candidate => candidate.name === legacy)!;
          tool.inputSchema = structuredClone(tool.inputSchema);
          const node = legacy === 'auto_tasks'
            ? (tool.inputSchema as any).properties.schedule
            : nestedSchema(tools, legacy);
          node.anyOf = [{ type: 'object' }, { type: 'string' }];
        }
        const request = {
          model: 'schema-test',
          messages: [{ role: 'user' as const, content: [{ type: 'text' as const, text: 'hello' }] }],
          tools,
        };
        if (mode === 'complete') {
          if (legacy) await expect(provider.complete(request)).rejects.toThrow(/Unsupported root composition or union/);
          else expect((await provider.complete(request)).content).toContainEqual({ type: 'text', text: 'hello' });
        } else {
          const events = [];
          for await (const event of provider.stream(request)) events.push(event);
          expect(events.some(event => event.type === 'error')).toBe(Boolean(legacy));
          if (!legacy) expect(events.some(event => event.type === 'message_end')).toBe(true);
        }
      }
      expect(requestFetch).toHaveBeenCalledTimes(5);
    } finally {
      requestFetch.mockRestore();
    }
  });
});

describe('portable field schemas', () => {
  const ref = 'grep_files.0123456789abcdef';

  it('retains tool-result field types, bounds, and closed properties', () => {
    const schema = nestedSchema(definitions(), 'tool_result');
    expect(containsUnion(schema)).toBe(false);
    const accepts = new AjvJsonSchemaValidator().getValidator(schema);
    for (const value of [
      { ref, query: 'needle' },
      { ref, operation: 'sum', field: 'amount' },
      { ref, operation: 'count', match: 'needle', count_unit: 'occurrences' },
      { ref, cursor: 0 },
      { ref },
    ]) expect(accepts(value).valid, JSON.stringify(value)).toBe(true);
    for (const value of [
      null, [], {}, { ref, cursor: -1 }, { ref, unexpected: true },
      { ref, operation: 'unknown' }, { ref, count_unit: 'unknown' }, { ref, max_tokens: 255 },
    ]) expect(accepts(value).valid, JSON.stringify(value)).toBe(false);
  });

  it('preserves XLSX cell acceptance exactly using type arrays', () => {
    const schema = nestedSchema(definitions(), 'create_xlsx');
    expect(containsUnion(schema)).toBe(false);
    expect(schema.type).toEqual(['string', 'number', 'boolean', 'object']);
    const validator = new AjvJsonSchemaValidator();
    const accepts = validator.getValidator(schema);
    const previous = validator.getValidator({ oneOf: [
      { type: 'string' }, { type: 'number' }, { type: 'boolean' },
      { type: 'object', properties: schema.properties },
    ] });
    const valid = ['text', '', 0, -1.5, false, true, {}, { value: 3, bold: true }, { formula: 'SUM(A1:A3)', format: '0.00' }];
    const invalid = [null, [], ['text'], { value: [] }, { formula: 3 }, { bold: 'yes' }, { type: 'unknown' }];
    for (const [values, expected] of [[valid, true], [invalid, false]] as const) {
      for (const value of values) {
        expect(accepts(value).valid, JSON.stringify(value)).toBe(expected);
        expect(previous(value).valid, JSON.stringify(value)).toBe(expected);
      }
    }
  });
});
