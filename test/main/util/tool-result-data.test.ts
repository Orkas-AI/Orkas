import { describe, expect, it } from 'vitest';
import {
  aggregateToolResultData,
  describeToolResultData,
} from '../../../src/main/util/tool-result-data';

describe('tool-result deterministic data queries', () => {
  it.each(['json', 'ndjson', 'csv', 'tsv'] as const)(
    'computes the same full-data aggregate when %s business fields move outside the schema preview',
    (format) => {
      const noise = Object.fromEntries(Array.from({ length: 32 }, (_, index) => [`extra_${index}`, index]));
      const facts = [
        { status: 'paid', region: 'PH', amount: 7 },
        { status: 'refunded', region: 'PH', amount: 900 },
        { status: 'paid', region: 'SG', amount: 11 },
      ];
      const serialize = (rows: Record<string, unknown>[]) => {
        if (format === 'json') return JSON.stringify(rows);
        if (format === 'ndjson') return rows.map((row) => JSON.stringify(row)).join('\n');
        const delimiter = format === 'csv' ? ',' : '\t';
        const fields = Object.keys(rows[0]);
        return [fields.join(delimiter), ...rows.map((row) => fields.map((field) => row[field]).join(delimiter))].join('\n');
      };
      // Same user facts and independent totals; only unrelated column order changes.
      for (const businessFirst of [true, false]) {
        const content = serialize(facts.map((fact) => businessFirst ? { ...fact, ...noise } : { ...noise, ...fact }));
        expect(describeToolResultData(content).datasets[0].fields.length).toBeLessThanOrEqual(24);
        const result = aggregateToolResultData(content, {
          operation: 'sum', field: 'amount',
          filters: [{ field: 'status', op: 'eq', value: 'paid' }], groupBy: ['region'],
        });
        expect(result).toMatchObject({
          ok: true, scanned: 3, matched: 2, truncated: false,
          rows: [{ group: { region: 'SG' }, value: 11 }, { group: { region: 'PH' }, value: 7 }],
        });
      }
    },
  );

  it('queries omitted parent and item fields after explicit array expansion', () => {
    const noise = Object.fromEntries(Array.from({ length: 32 }, (_, index) => [`extra_${index}`, index]));
    const source = JSON.stringify([
      { ...noise, region: 'PH', items: [{ ...noise, state: 'paid', amount: 7 }, { ...noise, state: 'refunded', amount: 900 }] },
      { ...noise, region: 'SG', items: [{ ...noise, state: 'paid', amount: 11 }] },
    ]);
    expect(aggregateToolResultData(source, {
      operation: 'sum', explode: 'items', field: '$item.amount',
      filters: [{ field: '$item.state', op: 'eq', value: 'paid' }], groupBy: ['$parent.region'],
    })).toMatchObject({
      ok: true, scanned: 3, matched: 2,
      rows: [{ group: { '$parent.region': 'SG' }, value: 11 }, { group: { '$parent.region': 'PH' }, value: 7 }],
    });
  });

  it('validates requested nested fields beyond preview depth without crossing arrays', () => {
    const source = JSON.stringify([
      { report: { daily: { totals: { amount: 7 } } } },
      { report: { daily: { totals: { amount: 11 } } } },
    ]);
    expect(aggregateToolResultData(source, { operation: 'sum', field: 'report.daily.totals.amount' }))
      .toMatchObject({ ok: true, scanned: 2, rows: [{ value: 18 }] });
    const arraySource = JSON.stringify([{ report: { daily: { totals: [{ amount: 7 }] } } }]);
    expect(aggregateToolResultData(arraySource, { operation: 'sum', field: 'report.daily.totals.amount' }))
      .toMatchObject({ ok: false, code: 'E_RESULT_QUERY_ARRAY_FIELD' });
    const heterogeneous = JSON.stringify([
      { report: { daily: { totals: [{ amount: 7 }] } } },
      { report: { daily: { totals: { amount: 11 } } } },
    ]);
    expect(aggregateToolResultData(heterogeneous, { operation: 'sum', field: 'report.daily.totals.amount' }))
      .toMatchObject({ ok: false, code: 'E_RESULT_QUERY_ARRAY_FIELD' });
  });

  it('does not turn unknown, unsafe, or late-invalid omitted fields into a partial success', () => {
    const noise = Object.fromEntries(Array.from({ length: 32 }, (_, index) => [`extra_${index}`, index]));
    const clean = JSON.stringify([{ ...noise, amount: 7 }, { ...noise, amount: null }, { ...noise, amount: 11 }]);
    expect(aggregateToolResultData(clean, { operation: 'sum', field: 'amount' }))
      .toMatchObject({ ok: true, rows: [{ value: 18 }] });
    for (const field of ['missing', '__proto__.amount', 'constructor.name']) {
      expect(aggregateToolResultData(clean, { operation: 'sum', field }))
        .toMatchObject({ ok: false, code: 'E_RESULT_QUERY_FIELD' });
    }
    const dirty = JSON.stringify([{ ...noise, amount: 7 }, { ...noise, amount: '11' }]);
    expect(aggregateToolResultData(dirty, { operation: 'sum', field: 'amount' }))
      .toMatchObject({ ok: false, code: 'E_RESULT_QUERY_FIELD' });
  });

  it('recognizes CSV scalars and applies filters before numeric aggregation', () => {
    const source = [
      'region,status,spend',
      'PH,active,10.5',
      'SG,paused,7',
      'PH,active,2.5',
    ].join('\n');

    expect(describeToolResultData(source)).toMatchObject({
      kind: 'csv',
      queryable: true,
      datasets: [{
        name: 'data',
        records: 3,
        fields: expect.arrayContaining([
          { name: 'region', type: 'string' },
          { name: 'spend', type: 'number' },
        ]),
      }],
    });
    expect(aggregateToolResultData(source, {
      operation: 'average',
      field: 'spend',
      filters: [{ field: 'status', op: 'eq', value: 'active' }],
      groupBy: ['region'],
    })).toMatchObject({
      ok: true,
      kind: 'csv',
      unit: 'values',
      scanned: 3,
      matched: 2,
      rows: [{ group: { region: 'PH' }, value: 6.5 }],
    });
  });

  it('recognizes NDJSON and supports nested fields without string matching', () => {
    const source = [
      JSON.stringify({ campaign: { state: 'active' }, spend: 3 }),
      JSON.stringify({ campaign: { state: 'paused' }, spend: 8 }),
      JSON.stringify({ campaign: { state: 'active' }, spend: 5 }),
    ].join('\n');

    expect(describeToolResultData(source)).toMatchObject({
      kind: 'ndjson',
      datasets: [{ fields: expect.arrayContaining([
        { name: 'campaign.state', type: 'string' },
      ]) }],
    });
    expect(aggregateToolResultData(source, {
      operation: 'maximum',
      field: 'spend',
      filters: [{ field: 'campaign.state', op: 'eq', value: 'active' }],
    })).toMatchObject({ ok: true, rows: [{ value: 5 }] });
  });

  it('expands nested metric arrays without confusing parent and item fields', () => {
    // Historical Q-05 shape: one campaign record owns a metrics_list array.
    // The expected total is derived independently from the fixture values and
    // proves that the query neither sums the parent decoy nor drops a day.
    const source = JSON.stringify([
      {
        campaign_id: 'c-1',
        expense: 900,
        metrics_list: [
          { date: '2026-08-01', expense: 2 },
          { date: '2026-08-02', expense: 4 },
        ],
      },
      {
        campaign_id: 'c-2',
        expense: 800,
        metrics_list: [
          { date: '2026-08-01', expense: 7 },
          { date: '2026-08-02', expense: 3 },
        ],
      },
    ]);

    expect(describeToolResultData(source)).toMatchObject({
      datasets: [{
        name: 'data',
        arrays: [{
          name: 'metrics_list',
          items: 4,
          fields: expect.arrayContaining([
            { name: '$item.date', type: 'string' },
            { name: '$item.expense', type: 'number' },
          ]),
        }],
      }],
    });
    expect(aggregateToolResultData(source, {
      operation: 'sum',
      explode: 'metrics_list',
      field: '$item.expense',
      filters: [{ field: '$item.date', op: 'eq', value: '2026-08-01' }],
      groupBy: ['$parent.campaign_id'],
    })).toMatchObject({
      ok: true,
      scanned: 4,
      matched: 2,
      rows: [
        { group: { '$parent.campaign_id': 'c-2' }, value: 7 },
        { group: { '$parent.campaign_id': 'c-1' }, value: 2 },
      ],
    });
  });

  it('expands an array reached through a nested source-record path', () => {
    const source = JSON.stringify([{
      region: 'PH',
      report: {
        metrics_list: [
          { expense: 3 },
          { expense: 5 },
        ],
      },
    }]);

    expect(describeToolResultData(source)).toMatchObject({
      datasets: [{
        arrays: [{
          name: 'report.metrics_list',
          items: 2,
          fields: expect.arrayContaining([{ name: '$item.expense', type: 'number' }]),
        }],
      }],
    });
    expect(aggregateToolResultData(source, {
      operation: 'sum',
      explode: 'report.metrics_list',
      field: '$item.expense',
      groupBy: ['$parent.region'],
    })).toMatchObject({
      ok: true,
      scanned: 2,
      matched: 2,
      rows: [{ group: { '$parent.region': 'PH' }, value: 8 }],
    });
  });

  it('explains how to replace an invalid array dotted path with explode', () => {
    const source = JSON.stringify([{
      campaign_id: 'c-1',
      metrics_list: [{ expense: 2 }],
    }]);

    const result = aggregateToolResultData(source, {
      operation: 'sum',
      field: 'metrics_list.expense',
    });

    expect(result).toMatchObject({ ok: false, code: 'E_RESULT_QUERY_ARRAY_FIELD' });
    expect(result.ok === false ? result.message : '').toContain('explode="metrics_list"');
    expect(result.ok === false ? result.message : '').toContain('field="$item.expense"');
    expect(result.ok === false ? result.message : '').toContain('$item.expense');
  });

  it('handles empty or absent arrays as zero expanded records', () => {
    const source = JSON.stringify([
      { id: 1, values: [] },
      { id: 2 },
      { id: 3, values: null },
    ]);

    expect(aggregateToolResultData(source, {
      operation: 'count',
      explode: 'values',
    })).toMatchObject({
      ok: true,
      scanned: 0,
      matched: 0,
      rows: [{ value: 0 }],
    });
  });

  it('fails instead of returning a partial aggregate when explode is not consistently an array', () => {
    const source = JSON.stringify([
      { items: [{ amount: 4 }] },
      { items: 'not-an-array' },
    ]);

    const result = aggregateToolResultData(source, {
      operation: 'sum',
      explode: 'items',
      field: '$item.amount',
    });

    expect(result).toMatchObject({ ok: false, code: 'E_RESULT_QUERY_EXPLODE' });
    expect(result.ok === false ? result.message : '').toContain('no partial result was returned');
  });

  it('validates every exploded value even when a late type change is outside the schema sample', () => {
    const source = JSON.stringify([{
      items: [
        ...Array.from({ length: 10_000 }, () => ({ amount: 1 })),
        { amount: 'late-invalid-value' },
      ],
    }]);

    expect(describeToolResultData(source)).toMatchObject({
      datasets: [{ arrays: [{ fields: expect.arrayContaining([
        { name: '$item.amount', type: 'number' },
      ]) }] }],
    });
    const result = aggregateToolResultData(source, {
      operation: 'sum',
      explode: 'items',
      field: '$item.amount',
    });
    expect(result).toMatchObject({ ok: false, code: 'E_RESULT_QUERY_FIELD' });
    expect(result.ok === false ? result.message : '').toContain('every non-null');
  });

  it('lists discoverable arrays when explode names an unknown path', () => {
    const source = JSON.stringify([{
      campaign_id: 'c-1',
      metrics_list: [{ expense: 2 }],
      labels: ['priority'],
    }]);

    const result = aggregateToolResultData(source, {
      operation: 'count',
      explode: 'missing_items',
    });

    expect(result).toMatchObject({ ok: false, code: 'E_RESULT_QUERY_EXPLODE' });
    expect(result.ok === false ? result.message : '').toContain('metrics_list');
    expect(result.ok === false ? result.message : '').toContain('labels');
    expect(result.ok === false ? result.message : '').toContain('run_program');
  });

  it('supports scalar arrays and enforces the expanded-record safety limit', () => {
    expect(aggregateToolResultData(JSON.stringify([{ values: [3, 5, 7] }]), {
      operation: 'sum',
      explode: 'values',
      field: '$item',
    })).toMatchObject({ ok: true, scanned: 3, rows: [{ value: 15 }] });

    const overLimit = JSON.stringify([{
      values: Array.from({ length: 250_001 }, () => 1),
    }]);
    expect(aggregateToolResultData(overLimit, {
      operation: 'count',
      explode: 'values',
    })).toMatchObject({ ok: false, code: 'E_RESULT_QUERY_RECORD_LIMIT' });
  });

  it('routes a second nested array to programmatic fallback instead of guessing', () => {
    const source = JSON.stringify([{
      groups: [{ values: [{ amount: 4 }] }],
    }]);

    const result = aggregateToolResultData(source, {
      operation: 'sum',
      explode: 'groups',
      field: '$item.values.amount',
    });

    expect(result).toMatchObject({ ok: false, code: 'E_RESULT_QUERY_ARRAY_FIELD' });
    expect(result.ok === false ? result.message : '').toContain('one array level');
    expect(result.ok === false ? result.message : '').toContain('run_program');
  });

  it('keeps parent and index namespaces queryable when array items fill the field catalog', () => {
    const wideItem = Object.fromEntries(
      Array.from({ length: 30 }, (_, index) => [`metric_${index}`, index]),
    );
    const source = JSON.stringify([{
      campaign_id: 'c-1',
      metrics_list: [wideItem, wideItem],
    }]);

    expect(aggregateToolResultData(source, {
      operation: 'count',
      explode: 'metrics_list',
      filters: [{ field: '$index', op: 'eq', value: 1 }],
      groupBy: ['$parent.campaign_id'],
    })).toMatchObject({
      ok: true,
      scanned: 2,
      matched: 1,
      rows: [{ group: { '$parent.campaign_id': 'c-1' }, value: 1 }],
    });
  });

  it('requires an explicit dataset when JSON exposes more than one record set', () => {
    const source = JSON.stringify({
      current: [{ amount: 4 }],
      archived: [{ amount: 100 }],
    });

    expect(aggregateToolResultData(source, { operation: 'sum', field: 'amount' }))
      .toMatchObject({ ok: false, code: 'E_RESULT_QUERY_DATASET' });
    expect(aggregateToolResultData(source, {
      operation: 'sum',
      dataset: 'current',
      field: 'amount',
    })).toMatchObject({ ok: true, rows: [{ value: 4 }] });
  });

  it('rejects malformed delimited input and mixed numeric fields instead of returning a partial total', () => {
    const malformed = 'region,spend\n"PH,10\nSG,20';
    expect(describeToolResultData(malformed)).toMatchObject({ kind: 'text', queryable: false });

    const mixed = JSON.stringify([
      { spend: 4 },
      { spend: null },
      { spend: 'not-a-number' },
    ]);
    expect(aggregateToolResultData(mixed, { operation: 'sum', field: 'spend' }))
      .toMatchObject({ ok: false, code: 'E_RESULT_QUERY_FIELD' });
  });

  it('returns null instead of a fabricated zero for empty minimum/average/maximum sets', () => {
    const source = JSON.stringify([{ amount: 4, state: 'active' }]);
    const filters = [{ field: 'state', op: 'eq' as const, value: 'missing' }];

    for (const operation of ['minimum', 'average', 'maximum'] as const) {
      expect(aggregateToolResultData(source, { operation, field: 'amount', filters }))
        .toMatchObject({ ok: true, matched: 0, rows: [{ value: null }] });
    }
  });

  it('detects a late mixed type even after the bounded field catalog is full', () => {
    const first = Object.fromEntries(
      Array.from({ length: 24 }, (_, index) => [`field_${String(index).padStart(2, '0')}`, index]),
    );
    const second = { ...first, field_23: 'dirty' };

    expect(aggregateToolResultData(JSON.stringify([first, second]), {
      operation: 'sum',
      field: 'field_23',
    })).toMatchObject({ ok: false, code: 'E_RESULT_QUERY_FIELD' });
  });

  it('reports grouped-result truncation instead of implying the limited rows are complete', () => {
    const source = JSON.stringify([
      { region: 'PH', amount: 9 },
      { region: 'SG', amount: 7 },
      { region: 'MY', amount: 3 },
    ]);

    expect(aggregateToolResultData(source, {
      operation: 'sum',
      field: 'amount',
      groupBy: ['region'],
      limit: 1,
    })).toMatchObject({
      ok: true,
      groups: 3,
      truncated: true,
      rows: [{ group: { region: 'PH' }, value: 9 }],
    });
  });
});
