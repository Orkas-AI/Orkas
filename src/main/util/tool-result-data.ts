/**
 * Deterministic inspection and bounded aggregation for persisted tool output.
 *
 * This module deliberately does not try to infer business meaning. It turns
 * common interchange shapes (JSON records, NDJSON, CSV/TSV) into named record
 * sets and exposes a small aggregation contract. Unknown text remains text;
 * the only supported calculation there is an explicitly labelled line or
 * occurrence count. No model call, database engine, native dependency, or
 * backing path is involved.
 */

export const TOOL_RESULT_QUERY_MAX_INPUT_BYTES = 32 * 1024 * 1024;
export const TOOL_RESULT_QUERY_MAX_RECORDS = 250_000;
export const TOOL_RESULT_QUERY_MAX_GROUPS = 10_000;
export const TOOL_RESULT_QUERY_MAX_FIELDS = 24;
export const TOOL_RESULT_QUERY_MAX_RESULTS = 100;

export type ToolResultScalar = string | number | boolean | null;

export type ToolResultDataField = {
  name: string;
  type: 'string' | 'number' | 'boolean' | 'null' | 'object' | 'array' | 'mixed';
};

export type ToolResultDataSet = {
  name: string;
  records: number;
  fields: ToolResultDataField[];
};

export type ToolResultDataDescriptor = {
  kind: 'json' | 'ndjson' | 'csv' | 'tsv' | 'text';
  queryable: boolean;
  queryOperations: Array<'count' | 'sum' | 'average' | 'minimum' | 'maximum'>;
  datasets: ToolResultDataSet[];
  textLines?: number;
  reason?: 'input_too_large' | 'unstructured';
};

export type ToolResultQueryFilter = {
  field: string;
  op: 'eq' | 'ne' | 'gt' | 'gte' | 'lt' | 'lte' | 'contains' | 'exists';
  value?: ToolResultScalar;
};

export type ToolResultAggregateRequest = {
  operation: 'count' | 'sum' | 'average' | 'minimum' | 'maximum';
  dataset?: string;
  field?: string;
  filters?: ToolResultQueryFilter[];
  groupBy?: string[];
  order?: 'asc' | 'desc';
  limit?: number;
  match?: string;
  countUnit?: 'matching_lines' | 'occurrences';
};

export type ToolResultAggregateRow = {
  group?: Record<string, ToolResultScalar>;
  value: number | null;
};

export type ToolResultAggregateResult = {
  ok: true;
  kind: ToolResultDataDescriptor['kind'];
  dataset: string;
  unit: 'records' | 'values' | 'matching_lines' | 'occurrences';
  scanned: number;
  matched: number;
  groups: number;
  truncated: boolean;
  rows: ToolResultAggregateRow[];
} | {
  ok: false;
  code: string;
  message: string;
  descriptor?: ToolResultDataDescriptor;
};

type RecordValue = Record<string, unknown>;
type MaterializedData = {
  descriptor: ToolResultDataDescriptor;
  datasets: Map<string, RecordValue[]>;
  text: string;
};

export function describeToolResultData(content: string): ToolResultDataDescriptor {
  return materializeToolResultData(content, false).descriptor;
}

export function aggregateToolResultData(
  content: string,
  request: ToolResultAggregateRequest,
): ToolResultAggregateResult {
  const materialized = materializeToolResultData(content, true);
  const descriptor = materialized.descriptor;
  const operation = request.operation;
  if (!['count', 'sum', 'average', 'minimum', 'maximum'].includes(operation)) {
    return failure('E_RESULT_QUERY_OPERATION', 'Unsupported aggregate operation.', descriptor);
  }
  if (descriptor.reason === 'input_too_large') {
    return failure(
      'E_RESULT_QUERY_TOO_LARGE',
      `This result exceeds the ${TOOL_RESULT_QUERY_MAX_INPUT_BYTES}-byte deterministic query limit. Use search or paged read instead.`,
      descriptor,
    );
  }

  if (!descriptor.queryable) {
    if (operation !== 'count') {
      return failure(
        'E_RESULT_NOT_QUERYABLE',
        'This result is unstructured text. Only exact count with match and count_unit is available; use search or read for content.',
        descriptor,
      );
    }
    const match = String(request.match ?? '');
    if (!match) {
      return failure(
        'E_RESULT_COUNT_UNIT_REQUIRED',
        'Unstructured text count requires a non-empty match and count_unit of matching_lines or occurrences.',
        descriptor,
      );
    }
    const countUnit = request.countUnit;
    if (countUnit !== 'matching_lines' && countUnit !== 'occurrences') {
      return failure(
        'E_RESULT_COUNT_UNIT_REQUIRED',
        'Unstructured text count requires count_unit of matching_lines or occurrences.',
        descriptor,
      );
    }
    const needle = match.toLocaleLowerCase();
    const lower = materialized.text.toLocaleLowerCase();
    if (countUnit === 'matching_lines') {
      const lines = splitLogicalLines(materialized.text);
      const count = lines.reduce(
        (total, line) => total + (line.toLocaleLowerCase().includes(needle) ? 1 : 0),
        0,
      );
      return {
        ok: true,
        kind: descriptor.kind,
        dataset: 'text',
        unit: 'matching_lines',
        scanned: lines.length,
        matched: count,
        groups: 1,
        truncated: false,
        rows: [{ value: count }],
      };
    }
    let count = 0;
    let cursor = 0;
    while (cursor <= lower.length - needle.length) {
      const found = lower.indexOf(needle, cursor);
      if (found < 0) break;
      count++;
      cursor = found + Math.max(1, needle.length);
    }
    return {
      ok: true,
      kind: descriptor.kind,
      dataset: 'text',
      unit: 'occurrences',
      scanned: materialized.text.length,
      matched: count,
      groups: 1,
      truncated: false,
      rows: [{ value: count }],
    };
  }

  if (request.match || request.countUnit) {
    return failure(
      'E_RESULT_QUERY_SHAPE',
      'match and count_unit are only valid for unstructured text count.',
      descriptor,
    );
  }
  const datasetName = resolveDatasetName(descriptor, request.dataset);
  if (datasetName.ok === false) return failure(datasetName.code, datasetName.message, descriptor);
  const records = materialized.datasets.get(datasetName.name) ?? [];
  const dataset = descriptor.datasets.find((entry) => entry.name === datasetName.name)!;
  const availableFields = new Set(dataset.fields.map((field) => field.name));
  const groupBy = Array.isArray(request.groupBy) ? request.groupBy : [];
  if (groupBy.length > 3 || groupBy.some((field) => !isSafeFieldName(field))) {
    return failure('E_RESULT_QUERY_SHAPE', 'group_by accepts at most three valid field paths.', descriptor);
  }
  const filters = Array.isArray(request.filters) ? request.filters : [];
  if (filters.length > 8) {
    return failure('E_RESULT_QUERY_SHAPE', 'filters accepts at most eight predicates.', descriptor);
  }
  const referencedFields = new Set<string>([
    ...groupBy,
    ...filters.map((filter) => filter.field),
    ...(request.field ? [request.field] : []),
  ]);
  for (const field of referencedFields) {
    if (!isSafeFieldName(field) || !availableFields.has(field)) {
      return failure(
        'E_RESULT_QUERY_FIELD',
        `Unknown field ${JSON.stringify(field)}. Available fields: ${[...availableFields].slice(0, TOOL_RESULT_QUERY_MAX_FIELDS).join(', ') || '(none)'}.`,
        descriptor,
      );
    }
  }
  if (operation !== 'count' && !request.field) {
    return failure('E_RESULT_QUERY_FIELD', `${operation} requires field.`, descriptor);
  }
  if (request.field && operation !== 'count') {
    const field = dataset.fields.find((entry) => entry.name === request.field);
    if (!field || field.type !== 'number') {
      return failure(
        'E_RESULT_QUERY_FIELD',
        `${operation} requires a numeric field; ${JSON.stringify(request.field)} is ${field?.type || 'unknown'}.`,
        descriptor,
      );
    }
  }
  for (const filter of filters) {
    if (!isValidFilter(filter)) {
      return failure('E_RESULT_QUERY_FILTER', 'Each filter requires a valid field, op, and compatible value.', descriptor);
    }
  }

  type Accumulator = { count: number; numericCount: number; sum: number; min: number; max: number; group?: Record<string, ToolResultScalar> };
  const groups = new Map<string, Accumulator>();
  if (!groupBy.length) groups.set('__all__', emptyAccumulator());
  let matched = 0;
  for (const record of records) {
    if (!filters.every((filter) => matchesFilter(record, filter))) continue;
    matched++;
    const group: Record<string, ToolResultScalar> | undefined = groupBy.length ? {} : undefined;
    if (group) {
      for (const field of groupBy) {
        const scalar = scalarValue(readField(record, field));
        if (scalar.ok === false) {
          return failure(
            'E_RESULT_QUERY_GROUP_VALUE',
            `group_by field ${JSON.stringify(field)} must contain scalar values no longer than 512 characters.`,
            descriptor,
          );
        }
        group[field] = scalar.value;
      }
    }
    const groupKey = group ? JSON.stringify(group) : '__all__';
    let accumulator = groups.get(groupKey);
    if (!accumulator) {
      if (groups.size >= TOOL_RESULT_QUERY_MAX_GROUPS) {
        return failure(
          'E_RESULT_QUERY_GROUP_LIMIT',
          `The query exceeded ${TOOL_RESULT_QUERY_MAX_GROUPS} groups. Add filters or reduce group_by cardinality.`,
          descriptor,
        );
      }
      accumulator = emptyAccumulator(group);
      groups.set(groupKey, accumulator);
    }
    const raw = request.field ? readField(record, request.field) : undefined;
    if (operation === 'count') {
      if (!request.field || (raw !== null && raw !== undefined)) accumulator.count++;
      continue;
    }
    if (raw === null || raw === undefined) continue;
    if (typeof raw !== 'number' || !Number.isFinite(raw)) {
      return failure(
        'E_RESULT_QUERY_FIELD',
        `${operation} requires every non-null ${JSON.stringify(request.field)} value to be a finite number.`,
        descriptor,
      );
    }
    accumulator.numericCount++;
    accumulator.sum += raw;
    accumulator.min = Math.min(accumulator.min, raw);
    accumulator.max = Math.max(accumulator.max, raw);
  }

  let rows = [...groups.values()].map((accumulator): ToolResultAggregateRow => {
    let value: number | null = accumulator.count;
    if (operation === 'sum') value = accumulator.sum;
    if (operation === 'average') value = accumulator.numericCount ? accumulator.sum / accumulator.numericCount : null;
    if (operation === 'minimum') value = accumulator.numericCount ? accumulator.min : null;
    if (operation === 'maximum') value = accumulator.numericCount ? accumulator.max : null;
    return { ...(accumulator.group ? { group: accumulator.group } : {}), value };
  });
  const order = request.order === 'asc' ? 'asc' : 'desc';
  rows.sort((a, b) => {
    if (a.value === null) return b.value === null ? 0 : 1;
    if (b.value === null) return -1;
    return order === 'asc' ? a.value - b.value : b.value - a.value;
  });
  const groupsCount = rows.length;
  const limit = clampInteger(request.limit, 1, TOOL_RESULT_QUERY_MAX_RESULTS, 20);
  rows = rows.slice(0, limit);
  return {
    ok: true,
    kind: descriptor.kind,
    dataset: datasetName.name,
    unit: operation === 'count' ? 'records' : 'values',
    scanned: records.length,
    matched,
    groups: groupsCount,
    truncated: groupsCount > limit,
    rows,
  };
}

function emptyAccumulator(group?: Record<string, ToolResultScalar>): {
  count: number;
  numericCount: number;
  sum: number;
  min: number;
  max: number;
  group?: Record<string, ToolResultScalar>;
} {
  return {
    count: 0,
    numericCount: 0,
    sum: 0,
    min: Number.POSITIVE_INFINITY,
    max: Number.NEGATIVE_INFINITY,
    ...(group ? { group } : {}),
  };
}

function materializeToolResultData(content: string, keepRecords: boolean): MaterializedData {
  const bytes = content.length > TOOL_RESULT_QUERY_MAX_INPUT_BYTES
    ? TOOL_RESULT_QUERY_MAX_INPUT_BYTES + 1
    : Buffer.byteLength(content, 'utf8');
  if (bytes > TOOL_RESULT_QUERY_MAX_INPUT_BYTES) {
    return {
      descriptor: {
        kind: 'text',
        queryable: false,
        queryOperations: ['count'],
        datasets: [],
        reason: 'input_too_large',
      },
      datasets: new Map(),
      text: content,
    };
  }
  const source = unwrapCodeFence(content);
  const json = tryJson(source);
  if (json.ok) {
    const datasets = collectJsonDatasets(json.value);
    if (datasets.size) return materialized('json', datasets, source, keepRecords);
  }
  const lines = splitLogicalLines(source).filter((line) => line.trim());
  const ndjson = tryNdjson(lines);
  if (ndjson) return materialized('ndjson', new Map([['data', ndjson]]), source, keepRecords);
  const delimited = tryDelimited(lines);
  if (delimited) return materialized(delimited.kind, new Map([['data', delimited.records]]), source, keepRecords);
  return {
    descriptor: {
      kind: 'text',
      queryable: false,
      queryOperations: ['count'],
      datasets: [],
      textLines: countLogicalLines(source),
      reason: 'unstructured',
    },
    datasets: new Map(),
    text: source,
  };
}

function materialized(
  kind: 'json' | 'ndjson' | 'csv' | 'tsv',
  datasets: Map<string, RecordValue[]>,
  text: string,
  keepRecords: boolean,
): MaterializedData {
  const descriptor: ToolResultDataDescriptor = {
    kind,
    queryable: true,
    queryOperations: ['count', 'sum', 'average', 'minimum', 'maximum'],
    datasets: [...datasets].map(([name, records]) => ({
      name,
      records: records.length,
      fields: inferFields(records),
    })),
  };
  return {
    descriptor,
    datasets: keepRecords ? datasets : new Map(),
    text,
  };
}

function collectJsonDatasets(value: unknown): Map<string, RecordValue[]> {
  const datasets = new Map<string, RecordValue[]>();
  const add = (name: string, raw: unknown[]) => {
    if (!isSafeFieldName(name)) return;
    if (raw.length > TOOL_RESULT_QUERY_MAX_RECORDS) return;
    if (!raw.every((item) => item === null || ['object', 'string', 'number', 'boolean'].includes(typeof item))) return;
    const records = raw.map((item) => {
      if (item && typeof item === 'object' && !Array.isArray(item)) return item as RecordValue;
      return { value: item };
    });
    datasets.set(name, records);
  };
  if (Array.isArray(value)) {
    add('data', value);
    return datasets;
  }
  if (!value || typeof value !== 'object') return datasets;
  const root = value as RecordValue;
  const visit = (node: RecordValue, prefix: string, depth: number) => {
    for (const [key, child] of Object.entries(node)) {
      const name = prefix ? `${prefix}.${key}` : key;
      if (Array.isArray(child)) add(name, child);
      else if (child && typeof child === 'object' && depth < 2) visit(child as RecordValue, name, depth + 1);
      if (datasets.size >= 8) return;
    }
  };
  visit(root, '', 0);
  if (!datasets.size) datasets.set('data', [root]);
  return datasets;
}

function tryNdjson(lines: string[]): RecordValue[] | null {
  if (lines.length < 2 || lines.length > TOOL_RESULT_QUERY_MAX_RECORDS) return null;
  const records: RecordValue[] = [];
  for (const line of lines) {
    const parsed = tryJson(line);
    if (!parsed.ok || !parsed.value || typeof parsed.value !== 'object' || Array.isArray(parsed.value)) return null;
    records.push(parsed.value as RecordValue);
  }
  return records;
}

function tryDelimited(lines: string[]): { kind: 'csv' | 'tsv'; records: RecordValue[] } | null {
  if (lines.length < 2 || lines.length > TOOL_RESULT_QUERY_MAX_RECORDS) return null;
  for (const delimiter of ['\t', ','] as const) {
    const parsedHeader = parseDelimitedLine(lines[0], delimiter);
    if (!parsedHeader.ok) continue;
    const header = parsedHeader.values;
    if (header.length < 2 || new Set(header).size !== header.length || header.some((field) => !field.trim())) continue;
    const rows: RecordValue[] = [];
    let valid = true;
    for (let index = 1; index < lines.length; index++) {
      const parsed = parseDelimitedLine(lines[index], delimiter);
      if (!parsed.ok) { valid = false; break; }
      const values = parsed.values;
      if (values.length !== header.length) { valid = false; break; }
      rows.push(Object.fromEntries(header.map((field, fieldIndex) => [field.trim(), parseScalar(values[fieldIndex])])));
    }
    if (valid) return { kind: delimiter === '\t' ? 'tsv' : 'csv', records: rows };
  }
  return null;
}

function parseDelimitedLine(
  line: string,
  delimiter: '\t' | ',',
): { ok: true; values: string[] } | { ok: false } {
  const values: string[] = [];
  let value = '';
  let quoted = false;
  for (let index = 0; index < line.length; index++) {
    const char = line[index];
    if (char === '"') {
      if (quoted && line[index + 1] === '"') { value += '"'; index++; }
      else quoted = !quoted;
    } else if (char === delimiter && !quoted) {
      values.push(value);
      value = '';
    } else {
      value += char;
    }
  }
  values.push(value);
  return quoted ? { ok: false } : { ok: true, values };
}

function inferFields(records: RecordValue[]): ToolResultDataField[] {
  const types = new Map<string, Set<ToolResultDataField['type']>>();
  for (const record of records) collectFields(record, '', types, 0);
  return [...types]
    .slice(0, TOOL_RESULT_QUERY_MAX_FIELDS)
    .map(([name, values]) => ({
      name,
      type: inferredFieldType(values),
    }));
}

function inferredFieldType(
  values: Set<ToolResultDataField['type']>,
): ToolResultDataField['type'] {
  const nonNull = [...values].filter((type) => type !== 'null');
  if (!nonNull.length) return 'null';
  return new Set(nonNull).size === 1 ? nonNull[0] : 'mixed';
}

function collectFields(
  record: RecordValue,
  prefix: string,
  target: Map<string, Set<ToolResultDataField['type']>>,
  depth: number,
): void {
  for (const [key, value] of Object.entries(record)) {
    const name = prefix ? `${prefix}.${key}` : key;
    if (!isSafeFieldName(name)) continue;
    const type = value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;
    const normalized = ['string', 'number', 'boolean', 'null'].includes(type)
      ? type as ToolResultDataField['type']
      : type === 'array' ? 'array' : 'object';
    const existing = target.get(name);
    if (existing) existing.add(normalized);
    else if (target.size < TOOL_RESULT_QUERY_MAX_FIELDS) target.set(name, new Set([normalized]));
    if (value && typeof value === 'object' && !Array.isArray(value) && depth < 2) {
      collectFields(value as RecordValue, name, target, depth + 1);
    }
  }
}

function resolveDatasetName(
  descriptor: ToolResultDataDescriptor,
  requested: string | undefined,
): { ok: true; name: string } | { ok: false; code: string; message: string } {
  const name = String(requested ?? '').trim();
  if (name) {
    if (descriptor.datasets.some((dataset) => dataset.name === name)) return { ok: true, name };
    return {
      ok: false,
      code: 'E_RESULT_QUERY_DATASET',
      message: `Unknown dataset ${JSON.stringify(name)}. Available datasets: ${descriptor.datasets.map((item) => item.name).join(', ')}.`,
    };
  }
  if (descriptor.datasets.length === 1) return { ok: true, name: descriptor.datasets[0].name };
  return {
    ok: false,
    code: 'E_RESULT_QUERY_DATASET',
    message: `dataset is required. Available datasets: ${descriptor.datasets.map((item) => item.name).join(', ')}.`,
  };
}

function isValidFilter(filter: ToolResultQueryFilter): boolean {
  if (!filter || !isSafeFieldName(filter.field)) return false;
  if (!['eq', 'ne', 'gt', 'gte', 'lt', 'lte', 'contains', 'exists'].includes(filter.op)) return false;
  if (filter.op === 'exists') return filter.value === undefined || typeof filter.value === 'boolean';
  return filter.value === null || ['string', 'number', 'boolean'].includes(typeof filter.value);
}

function matchesFilter(record: RecordValue, filter: ToolResultQueryFilter): boolean {
  const actual = readField(record, filter.field);
  if (filter.op === 'exists') {
    const exists = actual !== undefined && actual !== null;
    return filter.value === false ? !exists : exists;
  }
  if (filter.op === 'contains') {
    return String(actual ?? '').toLocaleLowerCase().includes(String(filter.value ?? '').toLocaleLowerCase());
  }
  if (filter.op === 'eq') return actual === filter.value;
  if (filter.op === 'ne') return actual !== filter.value;
  if (typeof actual !== 'number' || typeof filter.value !== 'number') return false;
  if (filter.op === 'gt') return actual > filter.value;
  if (filter.op === 'gte') return actual >= filter.value;
  if (filter.op === 'lt') return actual < filter.value;
  return actual <= filter.value;
}

function readField(record: RecordValue, field: string): unknown {
  let value: unknown = record;
  for (const segment of field.split('.')) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
    value = (value as RecordValue)[segment];
  }
  return value;
}

function isSafeFieldName(value: string): boolean {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= 200
    && !/[\u0000-\u001f\u007f]/.test(value)
    && value.split('.').every((segment) => segment.length > 0 && segment !== '__proto__' && segment !== 'prototype' && segment !== 'constructor');
}

function scalarValue(
  value: unknown,
): { ok: true; value: ToolResultScalar } | { ok: false } {
  if (value === undefined || value === null) return { ok: true, value: null };
  if (typeof value === 'string') {
    return value.length <= 512 ? { ok: true, value } : { ok: false };
  }
  if (typeof value === 'number') {
    return Number.isFinite(value) ? { ok: true, value } : { ok: false };
  }
  if (typeof value === 'boolean') return { ok: true, value };
  return { ok: false };
}

function parseScalar(value: string): ToolResultScalar {
  const trimmed = value.trim();
  if (/^-?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i.test(trimmed)) {
    const number = Number(trimmed);
    if (Number.isFinite(number)) return number;
  }
  if (/^true$/i.test(trimmed)) return true;
  if (/^false$/i.test(trimmed)) return false;
  if (/^null$/i.test(trimmed)) return null;
  return value;
}

function tryJson(value: string): { ok: true; value: unknown } | { ok: false } {
  try { return { ok: true, value: JSON.parse(value) }; }
  catch { return { ok: false }; }
}

function unwrapCodeFence(value: string): string {
  const trimmed = value.trim();
  const match = /^```(?:json|jsonl|ndjson|csv|tsv)?\s*\n([\s\S]*?)\n```$/i.exec(trimmed);
  return match ? match[1] : value;
}

function splitLogicalLines(value: string): string[] {
  if (!value) return [];
  const lines = value.split(/\r?\n/);
  if (lines.at(-1) === '') lines.pop();
  return lines;
}

function countLogicalLines(value: string): number {
  if (!value) return 0;
  let count = 1;
  for (let index = 0; index < value.length; index++) {
    if (value.charCodeAt(index) === 10 && index < value.length - 1) count++;
  }
  return count;
}

function clampInteger(value: unknown, min: number, max: number, fallback: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(parsed)));
}

function failure(
  code: string,
  message: string,
  descriptor?: ToolResultDataDescriptor,
): Extract<ToolResultAggregateResult, { ok: false }> {
  return { ok: false, code, message, ...(descriptor ? { descriptor } : {}) };
}
