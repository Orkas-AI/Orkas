import { describe, expect, it } from 'vitest';
import {
  aggregateToolResultData,
  describeToolResultData,
} from '../../../src/main/util/tool-result-data';

describe('tool-result deterministic data queries', () => {
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
