import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

const { bridgeToolInput } = require('../../../../bin/bridge-tool-input.cjs');

function register(shape: z.ZodRawShape, handler: (...args: any[]) => any) {
  const [config, execute] = bridgeToolInput(z, 'Read fixture', shape, handler);
  return async (input: unknown) => {
    // Use the same Standard Schema path as the installed MCP SDK.
    const parsed = await config.inputSchema['~standard'].validate(input);
    if (parsed.issues) throw new Error('SDK rejected before the owned formatter');
    return execute(parsed.value, {});
  };
}

describe('tolerant MCP argument receipts', () => {
  it('preserves owning custom numeric and enum constraint messages', async () => {
    const handler = vi.fn();
    const reply = await register({ limit: z.number().min(1, 'Choose at least one result.'),
      scope: z.enum(['local', 'cloud'], { error: 'Choose local or cloud.' }) }, handler)({ limit: 0, scope: 'foreign' });
    expect(JSON.parse(reply.content[0].text).issues).toEqual([
      { field: 'limit', reason: 'too_small', expected: 'Choose at least one result.' },
      { field: 'scope', reason: 'invalid_value', expected: 'Choose local or cloud.' },
    ]);
    expect(handler).not.toHaveBeenCalled();
  });
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
      const reply = await call({ ...args, extra_note: 'irrelevant' });
      expect(reply.isError).toBe(true);
      expect(JSON.parse(reply.content[0].text)).toMatchObject({ code: 'E_BAD_INPUT', issues: [expect.objectContaining({ field: expect.any(String), reason: expect.any(String), expected: expect.any(String) })] });
    }
    expect(handler).not.toHaveBeenCalled();
    expect((await call({ id: 'item', page: { count: 1 } })).content[0].text).toBe('read');
    expect(handler).toHaveBeenCalledOnce();
  });

  it('reports multiple actual fields, preserves compatibility transforms once and never dispatches invalid input', async () => {
    const normalize = vi.fn((value: unknown) => value === 0 ? 10 : value);
    const handler = vi.fn(async (input) => ({ content: [{ type: 'text', text: JSON.stringify(input) }] }));
    const call = register({ id: z.string(), limit: z.preprocess(normalize, z.number().default(10)),
      unused: z.string().optional().catch(ctx => ctx.input) }, handler);
    const bad = await call({ id: 4, limit: 'bad', extra: 'PRIVATE_VALUE' });
    expect(JSON.parse(bad.content[0].text)).toMatchObject({ code: 'E_BAD_INPUT', issues: [
      { field: 'id', reason: 'invalid_type', expected: expect.any(String) },
      { field: 'limit', reason: 'invalid_type', expected: expect.any(String) },
    ] });
    expect(handler).not.toHaveBeenCalled();
    expect(JSON.stringify(bad)).not.toContain('PRIVATE_VALUE');
    normalize.mockClear();
    await call({ id: 'ok', limit: 0, unused: 4 });
    expect(normalize).toHaveBeenCalledOnce();
    expect(handler).toHaveBeenCalledExactlyOnceWith({ id: 'ok', limit: 10, unused: 4 }, {});
  });

  it('formats an owning compatibility catch that rethrows Zod issues without calling the host', async () => {
    const handler = vi.fn(async () => ({ content: [] }));
    const shape = require('../../../../bin/connector-discovery-contract.cjs').shape(z);
    const call = register(shape, handler);
    const reply = await call({ limit: 1.5 });
    expect(JSON.parse(reply.content[0].text)).toMatchObject({ code: 'E_BAD_INPUT', issues: [
      { field: 'limit', reason: 'invalid_type', expected: 'Expected integer, received float' },
    ] });
    expect(handler).not.toHaveBeenCalled();
    await call({ limit: 51 }); // Existing numeric compatibility remains host-owned.
    expect(handler).toHaveBeenCalledExactlyOnceWith({ limit: 51 }, {});
  });
});
