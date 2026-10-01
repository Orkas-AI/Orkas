import { describe, expect, it, vi } from 'vitest';
import { createConnectorToolDiscovery, validateDiscoveryParams, MAX_INLINE_DISCOVERY_BYTES } from '../../../../src/main/features/connectors/tool-discovery';
import type { ToolSchema } from '../../../../src/main/features/connectors/types';
vi.mock('../../../../src/main/features/connectors/catalog', () => ({ findCatalogEntry: () => undefined }));

const tool = (name: string, description = 'Read a fixture'): ToolSchema => ({ name, description, input_schema: { type: 'object', properties: { id: { type: 'string' } } } });
const visible = (tools: ToolSchema[], id = 'custom-fixture', name = 'Fixture') => [{ instance: { id, display_name: name } as any, tools }];

describe('bounded connector discovery', () => {
  it('reports full search coverage and permits recovery without treating an empty page as no matches', () => {
    const discover = createConnectorToolDiscovery();
    const scoped = [...visible([tool('read_invoice', 'Read invoice amount')], 'first'),
      ...visible([tool('read_metric_72', 'Read a metric')], 'second')];
    const empty = discover(scoped, { connector_id: 'first', query: '发票 金额' });
    expect(empty).toMatchObject({ total: 0, tools: [], next_offset: null,
      search: { scope: 'connector', connector_id: 'first', searched_connectors: 1, searched_tools: 1, coverage: 'all_visible_actions_in_scope' } });
    expect(empty.guidance).toBe(require('../../../../bin/connector-discovery-contract.cjs').emptySearchGuidance);
    const recovered = discover(scoped, { connector_id: 'first', query: 'invoice amount' });
    expect(recovered.tools![0].name).toBe('read_invoice');
    expect(recovered.guidance).toBeUndefined();
    const exhausted = discover(scoped, { query: 'invoice', offset: 1 });
    expect(exhausted).toMatchObject({ total: 1, tools: [], next_offset: null,
      search: { scope: 'all_visible', searched_connectors: 2, searched_tools: 2 } });
    expect(exhausted.guidance).toBeUndefined();
    expect(exhausted.search).not.toHaveProperty('connector_id');
    expect(discover([], { query: 'invoice' }).search).toMatchObject({ searched_connectors: 0, searched_tools: 0 });
    expect(discover(visible([tool('read_metric_72')]), { query: 'invoice' }).search?.searched_tools).toBe(1);
    expect(discover(scoped, {}).search).toBeUndefined();
  });
  it('returns every schema at the small-catalog boundary; large catalogs have lossless continuation', () => {
    const discover = createConnectorToolDiscovery();
    const tools = Array.from({ length: 21 }, (_, i) => tool(`action_${i}`));
    expect(discover(visible(tools.slice(0, 20)), { connector_id: 'custom-fixture' })).toMatchObject({ mode: 'full', total: 20, schemas_included: true, next_offset: null });
    const first = discover(visible(tools), { connector_id: 'custom-fixture' });
    expect(first).toMatchObject({ mode: 'compact', total: 21, schemas_included: false, next_offset: 20 });
    const next = discover(visible(tools), { connector_id: 'custom-fixture', offset: first.next_offset! });
    expect([...first.tools!, ...next.tools!].map(t => t.name)).toEqual(tools.map(t => t.name));
    expect(next.next_offset).toBeNull();
    expect(first.tools!.every(t => !t.input_schema)).toBe(true);
  });

  it('finds English metadata in mixed-language queries without admitting CJK unigram noise', () => {
    const tools = [tool('read_invoice', 'Read invoice amount by invoice number.'), tool('read_metric_204', 'Read an operational metric.'), tool('noise', '发出通知 金银市场')];
    const discover = createConnectorToolDiscovery();
    for (const query of ['invoice INV amount 发票 金额', 'invoice INV-204 amount 发票 金额']) {
      const result = discover(visible(tools), { query });
      expect(result.tools![0].name).toBe('read_invoice');
      expect(result.tools!.some(t => t.name === 'noise')).toBe(false);
    }
    expect(discover(visible(tools), { query: '发票 金额' }).tools).toEqual([]);
    expect(discover(visible(tools), { query: '字幕 subtitle SRT' }).tools).toEqual([]);
  });

  it('does not treat shared numeric suffixes as capability matches while retaining exact actions and versioned APIs', () => {
    const entries = [tool('read_metric_72', 'Read archived metrics.'), tool('read_metric_204', 'Read archived metrics.'),
      tool('read_invoice', 'Read invoice amount.'), tool('read_api_v2', 'Read API version information.'),
      tool('iso_reference', 'Read ISO-9001 documentation.'), tool('tax_form', 'Read tax form 1099.')];
    const discover = createConnectorToolDiscovery();
    const scoped = visible(entries, 'custom-fixture-72', 'Fixture-204');
    for (const query of ['VID-72', 'INV-204', '72', '204', '字幕 SRT VID-72']) {
      expect(discover(scoped, { query }).tools, query).toEqual([]);
    }
    expect(discover(scoped, { query: 'invoice INV-204' }).tools!.map(t => t.name)).toEqual(['read_invoice']);
    for (const [query, name] of [['read_metric_72', 'read_metric_72'], ['API v2', 'read_api_v2'],
      ['ISO-9001', 'iso_reference'], ['1099', 'tax_form']]) {
      expect(discover(scoped, { query }).tools![0].name, query).toBe(name);
    }
    expect(discover(scoped, { connector_id: 'custom-fixture-72', tool_name: 'read_metric_72' }).tools![0].name).toBe('read_metric_72');
    expect(discover(scoped, { connector_id: 'custom-fixture-72' }).total).toBe(entries.length);
  });

  it('keeps small catalogs complete when an explicit page covers the catalog', () => {
    const tools = [tool('list_reports'), tool('read_report')];
    const discover = createConnectorToolDiscovery();
    for (const params of [{ limit: 50 }, { limit: 2, offset: 0 }, { offset: 0 }]) {
      const result = discover(visible(tools), { connector_id: 'custom-fixture', ...params });
      expect(result).toMatchObject({ mode: 'full', total: 2, schemas_included: true, next_offset: null });
      expect(result.tools!.map(t => t.input_schema)).toEqual(tools.map(t => t.input_schema));
    }
    expect(discover(visible(tools), { connector_id: 'custom-fixture', limit: 1 })).toMatchObject({ mode: 'compact', next_offset: 1 });
    expect(discover(visible(tools), { connector_id: 'custom-fixture', offset: 1 })).toMatchObject({ mode: 'compact', offset: 1 });
  });

  it('bounds even one huge schema without losing exact schema expansion', () => {
    const huge = tool('read_large');
    huge.input_schema.description = 'large '.repeat(10_000);
    const discover = createConnectorToolDiscovery();
    const scoped = visible([huge]);
    const result = discover(scoped, { connector_id: 'custom-fixture' });
    expect(result).toMatchObject({ mode: 'compact', schemas_included: false, next_offset: null });
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThan(MAX_INLINE_DISCOVERY_BYTES);
    expect(discover(scoped, { connector_id: 'custom-fixture', tool_name: huge.name }).tools![0].input_schema).toEqual(huge.input_schema);
    expect(discover(scoped, { query: 'read_large' }).schemas_included).toBe(false);
  });

  it('uses UTF-8 bytes for multilingual schemas and returns eight search matches by default', () => {
    const huge = tool('read_report', 'Read report');
    huge.input_schema.description = '审批'.repeat(6_000);
    expect(JSON.stringify(huge).length).toBeLessThan(MAX_INLINE_DISCOVERY_BYTES);
    expect(createConnectorToolDiscovery()(visible([huge]), { connector_id: 'custom-fixture' }).schemas_included).toBe(false);
    const entries = Array.from({ length: 30 }, (_, i) => tool(`report_${i}`, 'Read report'));
    const discover = createConnectorToolDiscovery();
    const result = discover(visible(entries), { query: 'report' });
    expect(result).toMatchObject({ total: 30, next_offset: 8 }); expect(result.tools).toHaveLength(8);
    const next = discover(visible(entries), { query: 'report', offset: result.next_offset! });
    expect(new Set([...result.tools!, ...next.tools!].map(t => t.name)).size).toBe(16);
  });

  it('accounts for JSON nesting/framing when schemas contain many short properties', () => {
    const discover = createConnectorToolDiscovery();
    for (const count of [200, 250, 300, 350, 400]) {
      const item = tool('read_many_fields');
      item.input_schema.properties = Object.fromEntries(Array.from({ length: count }, (_, i) => [`field_${i}`, { type: 'string' }]));
      const result = discover(visible([item]), { query: 'read many fields' });
      expect(Buffer.byteLength(JSON.stringify(result, null, 2))).toBeLessThanOrEqual(MAX_INLINE_DISCOVERY_BYTES);
    }
  });

  it('finds a late action in 10,000 tools directly and only serializes selected schemas', () => {
    const tools = Array.from({ length: 10_000 }, (_, i) => tool(`operation_${i}`, 'Manage standard entries'));
    tools[9_999] = tool('archive_invoice', 'Find archived invoices');
    // Non-matching schemas must not be eagerly serialized to decide output size.
    for (const item of tools.slice(0, -1)) item.input_schema.toJSON = () => { throw new Error('unselected schema serialized'); };
    const result = createConnectorToolDiscovery()(visible(tools), { query: 'invoice', limit: 1 });
    expect(result).toMatchObject({ mode: 'search', total: 1, next_offset: null, schemas_included: true });
    expect(result.tools![0]).toMatchObject({ name: 'archive_invoice', input_schema: tools[9_999].input_schema });
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThan(2_000);
  });

  it('searches action/title/argument/connector metadata with identifier splitting and CJK phrases', () => {
    const entries = [tool('GMAIL_FETCH_EMAILS', 'Read inbox'), tool('lookup', '查询审批状态')];
    entries[0].annotations = { title: 'Mail retrieval' };
    entries[0].input_schema.properties = { recipientEmail: { type: 'string' } };
    const discover = createConnectorToolDiscovery();
    for (const query of ['fetch emails', 'retrieval', 'recipientEmail', 'recipient email']) {
      expect(discover(visible(entries), { query, limit: 1 }).tools![0].name).toBe('GMAIL_FETCH_EMAILS');
    }
    expect(discover(visible(entries), { query: '审批' }).tools!.map(t => t.name)).toEqual(['lookup']);
    expect(discover(visible(entries), { query: 'Fixture' }).total).toBe(2);
    expect(discover(visible(entries), { query: 'missingphrase' }).tools).toEqual([]);
  });

  it('invalidates changed metadata and visibility, and returns fresh schemas even when tokens stay unchanged', () => {
    const discover = createConnectorToolDiscovery();
    const entries = [tool('alpha', 'Invoice'), tool('beta', 'Calendar')];
    const scoped = visible(entries);
    expect(discover(scoped, { query: 'invoice' }).tools![0].name).toBe('alpha');
    entries[0] = tool('alpha', 'Calendar'); entries[1] = tool('beta', 'Invoice');
    expect(discover(scoped, { query: 'invoice' }).tools![0].name).toBe('beta');
    entries[1].input_schema.required = ['id'];
    expect(discover(scoped, { query: 'invoice' }).tools![0].input_schema!.required).toEqual(['id']);
    expect(discover(visible([entries[0]]), { query: 'invoice' }).tools).toEqual([]);
    expect(discover([], { query: 'invoice' }).tools).toEqual([]);
    expect(() => discover([], { connector_id: 'custom-fixture', query: 'invoice' })).toThrow('not currently available');
  });

  it('supports cross-connector search, connector scope and inventory without copying all schemas', () => {
    const scoped = [...visible([tool('read_a', 'Invoice')], 'first'), ...visible([tool('read_b', 'Invoice')], 'second')];
    const discover = createConnectorToolDiscovery();
    expect(discover(scoped, {}).connectors).toEqual([{ id: 'first', name: 'Fixture', tool_count: 1 }, { id: 'second', name: 'Fixture', tool_count: 1 }]);
    expect(discover(scoped, { query: 'invoice' }).tools!.map(t => t.connector_id)).toEqual(['first', 'second']);
    expect(discover(scoped, { connector_id: 'second', query: 'invoice' }).tools!.map(t => t.connector_id)).toEqual(['second']);
    expect(discover(scoped, { limit: 1 }).next_offset).toBe(1);
  });

  it.each([
    [{ query: '' }, 'query must be a non-empty string'],
    [{ query: ' ' }, 'query must be a non-empty string'],
    [{ query: 3 }, 'query must be a non-empty string'],
    [{ query: 'x'.repeat(1025) }, 'query must be at most 1024 characters'],
    [{ limit: 0 }, 'limit must be an integer from 1 to 50'],
    [{ limit: 51 }, 'limit must be an integer from 1 to 50'],
    [{ limit: 1.5 }, 'limit must be an integer from 1 to 50'],
    [{ offset: -1 }, 'offset must be an integer from 0 to 9007199254740991'],
    [{ offset: Infinity }, 'offset must be an integer from 0 to 9007199254740991'],
    [{ offset: '1' }, 'offset must be an integer from 0 to 9007199254740991'],
    [{ offset: Number.MAX_SAFE_INTEGER + 1 }, 'offset must be an integer from 0 to 9007199254740991'],
    [{ tool_name: 'read' }, '`connector_id` is required'],
    [{ connector_id: 'x', tool_name: 'read', query: 'read' }, 'tool_name cannot be combined'],
    [{ unknown: 'private value' }, 'unsupported discovery field "unknown"; allowed fields: connector_id, tool_name, query, limit, offset'],
  ] as const)('rejects malformed parameters with field constraints: %j', (raw, message) => {
    expect(() => validateDiscoveryParams(raw)).toThrow(message);
  });

  it('bounds and escapes unsupported field names without echoing values', () => {
    const key = 'bad\n"' + 'x'.repeat(1000);
    expect(() => validateDiscoveryParams({ [key]: 'PRIVATE_VALUE' })).toThrowError(expect.objectContaining({
      code: 'E_BAD_INPUT',
      message: `unsupported discovery field ${JSON.stringify(key.slice(0, 80) + '…')}; allowed fields: connector_id, tool_name, query, limit, offset`,
    }));
  });

  it('preserves accepted integer boundaries', () => {
    for (const limit of [1, 50]) {
      for (const offset of [0, Number.MAX_SAFE_INTEGER]) {
        expect(validateDiscoveryParams({ limit, offset })).toEqual({ limit, offset });
      }
    }
  });
});
