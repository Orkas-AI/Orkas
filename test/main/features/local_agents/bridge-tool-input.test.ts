import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

const { bridgeToolInput } = require('../../../../bin/bridge-tool-input.cjs');

function register(shape: z.ZodRawShape, handler: (...args: any[]) => any) {
  const [config, execute] = bridgeToolInput(z, 'Read fixture', shape, handler);
  return (input: unknown) => execute(config.inputSchema.parse(input), {});
}

describe('tolerant MCP argument receipts', () => {
  it('advertises required fields, numeric bounds and nested maps without requiring defaulted inputs', () => {
    const [config] = bridgeToolInput(z, 'Read fixture', {
      id: z.string().min(1),
      scope: z.enum(['local', 'cloud']).default('local'),
      limit: z.preprocess(value => value, z.number().int().min(1).max(50).optional()),
      args: z.record(z.string(), z.unknown()).optional(),
      task_id: z.string().min(1).optional().catch(ctx => ctx.input),
    }, async () => ({ content: [] }));
    for (const direction of ['input', 'output']) {
      const schema = config.inputSchema['~standard'].jsonSchema[direction]();
      expect(schema).toMatchObject({ type: 'object', required: ['id'], properties: {
        id: { type: 'string', minLength: 1 },
        scope: { type: 'string', enum: ['local', 'cloud'], default: 'local' },
        limit: { type: 'integer', minimum: 1, maximum: 50 },
        args: { type: 'object', additionalProperties: {} },
        task_id: { type: 'string', minLength: 1 },
      } });
    }
    expect(config.inputSchema.parse({ id: 'item', args: { nested: { enabled: true } } }))
      .toEqual({ id: 'item', scope: 'local', args: { nested: { enabled: true } } });
    expect(() => config.inputSchema.parse({ id: 'item', limit: 51 })).toThrow();
    // A malformed unused selector reaches its owning action guard unchanged.
    expect(config.inputSchema.parse({ id: 'item', task_id: 4 }).task_id).toBe(4);
  });

  it('ignores undeclared fields on writes and executes once with the declared content', async () => {
    const handler = vi.fn(async () => ({ content: [{ type: 'text', text: 'saved' }] }));
    const call = register({ content: z.string() }, handler);
    const result = await call({ content: 'new', future_option: 'PRIVATE_VALUE' });
    expect(handler).toHaveBeenCalledExactlyOnceWith({ content: 'new' }, {});
    expect(result.content[0].text).toBe('saved');
    expect(JSON.parse(result.content[1].text)).toEqual({ ignored_fields: ['future_option'] });
    expect(JSON.stringify(result)).not.toContain('PRIVATE_VALUE');
  });

  it('preserves valid JSON, content blocks and a single execution while disclosing only extra names', async () => {
    const result = { content: [{ type: 'text', text: '{"found":true}' },
      { type: 'image', data: 'fixture', mimeType: 'image/png' }], structuredContent: { found: true } };
    const handler = vi.fn(async () => result);
    const call = register({ id: z.string(), args: z.record(z.string(), z.unknown()) }, handler);
    const reply = await call({ id: 'item', args: { provider_extension: 42 }, extra_note: { secret: 'PRIVATE_VALUE' } });
    expect(handler).toHaveBeenCalledExactlyOnceWith({ id: 'item', args: { provider_extension: 42 } }, {});
    expect(reply.content.slice(0, 2)).toEqual(result.content);
    expect(JSON.parse(reply.content[0].text)).toEqual({ found: true });
    expect(reply.structuredContent).toEqual({ found: true });
    expect(JSON.parse(reply.content[2].text)).toEqual({ ignored_fields: ['extra_note'] });
    expect(JSON.stringify(reply)).not.toContain('PRIVATE_VALUE');
    expect(result.content).toHaveLength(2);
  });

  it('adds no envelope when no fields were ignored', async () => {
    const result = { content: [{ type: 'text', text: 'unchanged' }] };
    const handler = vi.fn(async () => result);
    expect(await register({ id: z.string() }, handler)({ id: 'item' })).toBe(result);
    expect(handler).toHaveBeenCalledOnce();
  });

  it.each(['returned', 'thrown'])('retains %s failure status and the ignored-field receipt without retrying', async (mode) => {
    const handler = vi.fn(async () => {
      if (mode === 'thrown') throw new Error('fixture unavailable');
      return { content: [{ type: 'text', text: 'fixture unavailable' }], isError: true };
    });
    const reply = await register({}, handler)({ extra_note: 'PRIVATE_VALUE' });
    expect(reply.isError).toBe(true);
    expect(reply.content[0].text).toBe('fixture unavailable');
    expect(JSON.parse(reply.content[1].text)).toEqual({ ignored_fields: ['extra_note'] });
    expect(JSON.stringify(reply)).not.toContain('PRIVATE_VALUE');
    expect(handler).toHaveBeenCalledOnce();
  });

  it('bounds large feedback and reports truncation without returning ignored values', async () => {
    const fields = Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`${i}_${'x'.repeat(100)}`, 'PRIVATE_VALUE']));
    const handler = vi.fn(async () => ({ content: [{ type: 'text', text: 'read' }] }));
    const reply = await register({}, handler)(fields);
    const receipt = JSON.parse(reply.content[1].text);
    expect(receipt).toMatchObject({ ignored_field_count: 12, ignored_fields_truncated: true });
    expect(receipt.ignored_fields).toHaveLength(10);
    expect(receipt.ignored_fields.every((field: string) => field.length <= 81)).toBe(true);
    expect(reply.content[1].text.length).toBeLessThan(1000);
    expect(JSON.stringify(reply)).not.toContain('PRIVATE_VALUE');
    expect(handler).toHaveBeenCalledExactlyOnceWith({}, {});
  });

  it('rejects malformed effective fields and nested closed objects before execution, then accepts a valid call', async () => {
    const handler = vi.fn(async () => ({ content: [{ type: 'text', text: 'read' }] }));
    const call = register({ id: z.string(), page: z.object({ count: z.number().int().min(1) }).strict() }, handler);
    for (const args of [{ id: 4, page: { count: 1 } }, { id: 'item', page: { count: 0 } },
      { id: 'item', page: { count: 1, alternate_scope: 'foreign' } }]) {
      expect(() => call({ ...args, extra_note: 'irrelevant' })).toThrow();
    }
    expect(handler).not.toHaveBeenCalled();
    expect((await call({ id: 'item', page: { count: 1 } })).content[0].text).toBe('read');
    expect(handler).toHaveBeenCalledOnce();
  });
});
