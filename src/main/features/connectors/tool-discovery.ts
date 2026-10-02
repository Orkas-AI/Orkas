/** Local, scope-filtered discovery shared by Agent, Web SDK and CLI runtimes. */
import { createHash } from 'node:crypto';
import { tokenize } from '../search/tokenize';
import { scorePostings, type PostingRow } from '../search/bm25';
import type { resolveVisibleConnectors } from './tools-adapter';
import { findCatalogEntry } from './catalog';
import type { ToolSchema } from './types';
const { emptySearchGuidance } = require('../../../../bin/connector-discovery-contract.cjs');

export const MAX_INLINE_DISCOVERY_BYTES = 30_000;
export const MAX_INLINE_DISCOVERY_TOOLS = 20;
type Visible = Awaited<ReturnType<typeof resolveVisibleConnectors>>;
interface Params { connector_id?: string; tool_name?: string; query?: string; limit?: number; offset?: number }
export interface DiscoveredTool {
  connector_id: string;
  name: string;
  description: string;
  input_schema?: Record<string, unknown>;
  argument_names?: string[];
}
export interface DiscoveryResult {
  mode: 'inventory' | 'full' | 'schema' | 'search' | 'compact';
  total: number;
  offset: number;
  next_offset: number | null;
  schemas_included?: boolean;
  search?: {
    scope: 'connector' | 'all_visible';
    connector_id?: string;
    searched_connectors: number;
    searched_tools: number;
    coverage: 'all_visible_actions_in_scope';
  };
  guidance?: string;
  tools?: DiscoveredTool[];
  connectors?: { id: string; name: string; tool_count: number }[];
}
export class ConnectorDiscoveryError extends Error {
  constructor(public readonly code: string, message: string) { super(message); }
}

export function validateDiscoveryParams(raw: Record<string, unknown>): Params {
  const bad = (message: string): never => { throw new ConnectorDiscoveryError('E_BAD_INPUT', message); };
  const fields = ['connector_id', 'tool_name', 'query', 'limit', 'offset'];
  const unknown = Object.keys(raw).find(key => !fields.includes(key));
  if (unknown !== undefined) {
    const field = unknown.length > 80 ? `${unknown.slice(0, 80)}…` : unknown;
    bad(`unsupported discovery field ${JSON.stringify(field)}; allowed fields: ${fields.join(', ')}`);
  }
  const params: Params = {};
  for (const key of ['connector_id', 'tool_name', 'query'] as const) {
    if (raw[key] === undefined) continue;
    if (typeof raw[key] !== 'string' || !raw[key].trim()) bad(`${key} must be a non-empty string`);
    params[key] = (raw[key] as string).trim();
  }
  if (params.query && params.query.length > 1024) bad('query must be at most 1024 characters');
  for (const key of ['limit', 'offset'] as const) {
    if (raw[key] === undefined) continue;
    const value = raw[key];
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < (key === 'limit' ? 1 : 0) || (key === 'limit' && value > 50)) {
      bad(key === 'limit' ? 'limit must be an integer from 1 to 50' : `offset must be an integer from 0 to ${Number.MAX_SAFE_INTEGER}`);
    }
    params[key] = value as number;
  }
  if (params.tool_name && !params.connector_id) bad('`connector_id` is required when `tool_name` is provided');
  if (params.tool_name && (params.query !== undefined || params.limit !== undefined || params.offset !== undefined)) bad('tool_name cannot be combined with query, limit or offset');
  return params;
}

function fields(tool: ToolSchema): string[] {
  const props = tool.input_schema?.properties;
  return props && typeof props === 'object' && !Array.isArray(props) ? Object.keys(props) : [];
}
// Keep numeric identifier suffixes attached: VID-72 and metric_72 do not
// become a shared "72" capability term. Standalone numbers remain searchable.
function preserveNumericBoundaries(text: string): string {
  return text.replace(/[_./:-]+(?=[0-9])/g, '_');
}
function identifierWords(text: string): string {
  const expanded = text.replace(/([a-z])([A-Z])/g, '$1 $2');
  return expanded.replace(/[_./:-]+/g, (separator, offset) =>
    /[0-9]/.test(expanded[offset + separator.length] || '') ? '_' : ' ');
}
function searchText(id: string, connectorName: string, tool: ToolSchema): string {
  // Split snake_case/camelCase identifiers as well as preserving exact names.
  const identifiers = [id, connectorName, tool.name, tool.annotations?.title || '', ...fields(tool)].join(' ');
  const catalog = findCatalogEntry(id);
  return [identifiers, identifierWords(identifiers),
    tool.description, catalog?.description_en, catalog?.description_zh].filter(Boolean).join(' ');
}
function action(id: string, tool: ToolSchema, full: boolean): DiscoveredTool {
  return { connector_id: id, name: tool.name,
    description: full ? tool.description : tool.description.replace(/\s+/g, ' ').slice(0, 220),
    ...(full ? { input_schema: tool.input_schema } : { argument_names: fields(tool).slice(0, 12) }) };
}
function renderedActionBytes(value: DiscoveredTool): number {
  const text = JSON.stringify(value, null, 2);
  // Array nesting adds four spaces to every line. Reserve framing bytes too.
  return Buffer.byteLength(text) + 4 * (text.split('\n').length - 1) + 128;
}
function fitsFull(rows: { id: string; tool: ToolSchema }[], framingBytes = 256): boolean {
  if (rows.length > MAX_INLINE_DISCOVERY_TOOLS) return false;
  let bytes = framingBytes;
  for (const row of rows) {
    // Stop at the budget; don't serialize the remainder of a large catalog.
    bytes += renderedActionBytes(action(row.id, row.tool, true));
    if (bytes > MAX_INLINE_DISCOVERY_BYTES) return false;
  }
  return true;
}

/** One cache per runtime lifetime, retaining only tokens/postings, never schemas
 * or credentials. Every call supplies a fresh authoritative visibility snapshot. */
export function createConnectorToolDiscovery() {
  let cached: { fingerprint: string; postings: Map<string, PostingRow<number>[]>; count: number; avgLen: number } | undefined;
  return (visible: Visible, params: Params): DiscoveryResult => {
    const selected = params.connector_id ? visible.filter(v => v.instance.id === params.connector_id) : visible;
    if (params.connector_id && !selected.length) throw new ConnectorDiscoveryError('E_CONNECTOR_NOT_VISIBLE', 'connector is not currently available; refresh the connector inventory');
    const offset = params.offset ?? 0;
    const limit = params.limit ?? (params.query ? 8 : 20);
    if (!params.connector_id && !params.query) {
      const page = selected.slice(offset, offset + limit);
      return { mode: 'inventory', total: selected.length, offset,
        next_offset: offset + page.length < selected.length ? offset + page.length : null,
        connectors: page.map(({ instance, tools }) => ({ id: instance.id, name: instance.display_name, tool_count: tools.length })) };
    }
    const rows = selected.flatMap(({ instance, tools }) => tools.map(tool => ({ id: instance.id, connectorName: instance.display_name, tool })));
    if (params.tool_name) {
      const row = rows.find(row => row.tool.name === params.tool_name);
      if (!row) throw new ConnectorDiscoveryError('E_TOOL_NOT_AVAILABLE', 'action is not available; search or list current actions to choose an exact name');
      return { mode: 'schema', total: 1, offset: 0, next_offset: null, schemas_included: true, tools: [action(row.id, row.tool, true)] };
    }
    let ranked = rows;
    if (params.query) {
      const texts = rows.map(row => searchText(row.id, row.connectorName, row.tool));
      const hash = createHash('sha256');
      for (const text of texts) hash.update(String(Buffer.byteLength(text))).update(':').update(text);
      const fingerprint = hash.digest('hex');
      if (!cached || cached.fingerprint !== fingerprint) {
        const postings = new Map<string, PostingRow<number>[]>();
        let totalLen = 0;
        texts.forEach((text, key) => {
          const tokens = tokenize(preserveNumericBoundaries(text));
          totalLen += tokens.length;
          const frequencies = new Map<string, number>();
          for (const token of tokens) frequencies.set(token, (frequencies.get(token) || 0) + 1);
          for (const [term, tf] of frequencies) {
            const list = postings.get(term) || [];
            list.push({ key, tf, len: tokens.length }); postings.set(term, list);
          }
        });
        cached = { fingerprint, postings, count: rows.length, avgLen: totalLen / (rows.length || 1) || 1 };
      }
      const scores = scorePostings(cached.count, cached.avgLen, [...new Set(tokenize(identifierWords(params.query)))], term => cached!.postings.get(term) || [], { allowNonCjkMatches: true });
      ranked = [...scores].sort(([a, sa], [b, sb]) => sb.score - sa.score || rows[a].id.localeCompare(rows[b].id) || rows[a].tool.name.localeCompare(rows[b].tool.name)).map(([key]) => rows[key]);
    }
    const allFull = !params.query && offset === 0 && limit >= rows.length && fitsFull(rows);
    let page = allFull ? rows : ranked.slice(offset, offset + limit);
    // Reserve the exact search envelope, including arbitrarily long custom ids.
    const searchEnvelope = params.query ? {
      search: { scope: params.connector_id ? 'connector' as const : 'all_visible' as const,
        ...(params.connector_id ? { connector_id: params.connector_id } : {}),
        searched_connectors: selected.length, searched_tools: rows.length,
        coverage: 'all_visible_actions_in_scope' as const },
      ...(ranked.length === 0 ? { guidance: emptySearchGuidance as string } : {}),
    } : {};
    const framingBytes = 256 + Buffer.byteLength(JSON.stringify(searchEnvelope, null, 2));
    const full = allFull || !!params.query && fitsFull(page, framingBytes);
    if (!full) {
      let bytes = framingBytes;
      const count = page.findIndex(row => {
        bytes += renderedActionBytes(action(row.id, row.tool, false));
        return bytes > MAX_INLINE_DISCOVERY_BYTES;
      });
      if (count === 0) throw new ConnectorDiscoveryError('E_DISCOVERY_ITEM_TOO_LARGE', 'action summary exceeds the discovery budget; expand one exact tool_name');
      if (count > 0) page = page.slice(0, count);
    }
    return { mode: params.query ? 'search' : allFull ? 'full' : 'compact', total: ranked.length,
      offset, next_offset: offset + page.length < ranked.length ? offset + page.length : null,
      schemas_included: full, ...searchEnvelope, tools: page.map(row => action(row.id, row.tool, full)) };
  };
}
