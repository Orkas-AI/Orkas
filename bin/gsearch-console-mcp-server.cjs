#!/usr/bin/env node
// Google Search Console MCP server (stdio) — wraps the Search Console REST API behind the MCP
// tool-use protocol. Spawned as a child process by `features/connectors/mcp-client.ts`; OAuth
// access_token is injected through `GOOGLE_ACCESS_TOKEN` env (see `apply-template.ts`). Mirrors
// `bin/gmail-mcp-server.cjs`. Scope `webmasters.readonly` is granted by Server's
// `biz/connectors/oauth/google.py::_SCOPES_BY_CATALOG_ID['gsearch-console']`.
//
// Tool surface (4 tools, v1):
//   - list_sites()                                              → GSC properties the user owns
//   - query_search_analytics(siteUrl, startDate?, endDate?, dimensions?, rowLimit?, ...) → rows of
//        clicks / impressions / ctr / position grouped by query|page|date|country|device
//   - list_sitemaps(siteUrl)                                    → submitted sitemaps + status
//   - inspect_url(siteUrl, inspectionUrl)                       → index status of one URL (URL Inspection API)

const { Server } = require('@modelcontextprotocol/sdk/server/index.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} = require('@modelcontextprotocol/sdk/types.js');

const TOKEN = process.env.GOOGLE_ACCESS_TOKEN || '';
const WM_BASE = 'https://www.googleapis.com/webmasters/v3';
const INSPECT_URL = 'https://searchconsole.googleapis.com/v1/urlInspection/index:inspect';
const VALID_DIMENSIONS = ['query', 'page', 'country', 'device', 'date', 'searchAppearance'];
const MAX_ROWS = 25000;
const REQUEST_TIMEOUT_MS = 30000;  // explicit — node global fetch has no default timeout

// ── Tool definitions ──────────────────────────────────────────────────

const TOOLS = [
  {
    name: 'list_sites',
    description:
      'List the Search Console properties (sites) the authenticated user has access to, with each ' +
      'siteUrl and permissionLevel. URL-prefix properties look like "https://example.com/"; domain ' +
      'properties look like "sc-domain:example.com". Use a returned siteUrl with the other tools.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'query_search_analytics',
    description:
      'Query Search Console search-analytics for a property: clicks, impressions, CTR, and average ' +
      'position, grouped by one or more dimensions. Defaults to the last 28 full days grouped by query. ' +
      'GSC data lags ~2-3 days. Position is 1-based (lower is better); a high-impression / low-CTR / ' +
      'position 8-20 row is a quick-win opportunity.',
    inputSchema: {
      type: 'object',
      properties: {
        siteUrl: { type: 'string', description: 'Property from list_sites (URL-prefix or sc-domain:). Required.' },
        startDate: { type: 'string', description: 'YYYY-MM-DD. Default: 28 days before endDate.' },
        endDate: { type: 'string', description: 'YYYY-MM-DD. Default: 3 days ago (data lag).' },
        dimensions: {
          type: 'array',
          items: { type: 'string', enum: VALID_DIMENSIONS },
          description: 'One or more of query|page|country|device|date|searchAppearance. Default ["query"].',
        },
        rowLimit: { type: 'integer', minimum: 1, maximum: MAX_ROWS, description: 'Default 25.' },
        type: { type: 'string', enum: ['web', 'image', 'video', 'news', 'discover', 'googleNews'], description: 'Search type. Default web.' },
        dimensionFilter: {
          type: 'object',
          description: 'Optional single filter, e.g. {"dimension":"page","operator":"contains","expression":"/blog/"}.',
        },
      },
      required: ['siteUrl'],
    },
  },
  {
    name: 'list_sitemaps',
    description: 'List sitemaps submitted for a property, with submission status, last download, and error/warning counts.',
    inputSchema: {
      type: 'object',
      properties: { siteUrl: { type: 'string', description: 'Property from list_sites. Required.' } },
      required: ['siteUrl'],
    },
  },
  {
    name: 'inspect_url',
    description:
      'Inspect one URL against a property (URL Inspection API): index status (verdict / coverageState), ' +
      'last crawl time, canonical (Google-chosen vs user-declared), robots/indexability, and rich-result / ' +
      'mobile-usability summaries. Use to check "is this page actually indexed".',
    inputSchema: {
      type: 'object',
      properties: {
        siteUrl: { type: 'string', description: 'The property (must own the inspectionUrl). Required.' },
        inspectionUrl: { type: 'string', description: 'The absolute URL to inspect. Required.' },
        languageCode: { type: 'string', description: 'BCP-47, e.g. "en-US". Optional.' },
      },
      required: ['siteUrl', 'inspectionUrl'],
    },
  },
];

// ── HTTP helper ───────────────────────────────────────────────────────

async function gscFetch(url, init) {
  if (!TOKEN) throw new Error('GOOGLE_ACCESS_TOKEN env var not set');
  const res = await fetch(url, {
    ...init,
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      Accept: 'application/json',
      ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
      ...(init?.headers || {}),
    },
  });
  const text = await res.text();
  if (!res.ok) {
    // Google error shape: { error: { code, message, status } }. Surface so the model can react
    // (401 → reconnect, 403 → not a verified owner / scope, 429 → backoff).
    let detail = text;
    try { detail = JSON.parse(text).error?.message || text; } catch { /* keep raw */ }
    throw new Error(`Search Console API ${res.status}: ${detail}`);
  }
  return text ? JSON.parse(text) : {};
}

function _ymd(d) {
  return d.toISOString().slice(0, 10);
}

// ── Tool dispatch ─────────────────────────────────────────────────────

async function callTool(name, args) {
  if (name === 'list_sites') {
    const r = await gscFetch(`${WM_BASE}/sites`);
    return { sites: (r.siteEntry || []).map((s) => ({ siteUrl: s.siteUrl, permissionLevel: s.permissionLevel })) };
  }

  if (name === 'query_search_analytics') {
    const siteUrl = String(args.siteUrl || '');
    if (!siteUrl) throw new Error('siteUrl is required (from list_sites)');
    let dims = Array.isArray(args.dimensions) ? args.dimensions.filter((d) => VALID_DIMENSIONS.includes(d)) : [];
    if (!dims.length) dims = ['query'];
    // Default window: last 28 full days, ending 3 days ago (GSC data lag).
    const end = args.endDate ? new Date(args.endDate) : new Date(Date.now() - 3 * 86400000);
    const start = args.startDate ? new Date(args.startDate) : new Date(end.getTime() - 28 * 86400000);
    const body = {
      startDate: _ymd(start),
      endDate: _ymd(end),
      dimensions: dims,
      rowLimit: Math.min(MAX_ROWS, Math.max(1, parseInt(args.rowLimit, 10) || 25)),
      ...(args.type ? { type: String(args.type) } : {}),
    };
    if (args.dimensionFilter && typeof args.dimensionFilter === 'object') {
      body.dimensionFilterGroups = [{ filters: [args.dimensionFilter] }];
    }
    const r = await gscFetch(`${WM_BASE}/sites/${encodeURIComponent(siteUrl)}/searchAnalytics/query`,
      { method: 'POST', body: JSON.stringify(body) });
    const rows = (r.rows || []).map((row) => ({
      keys: row.keys || [],
      clicks: row.clicks, impressions: row.impressions,
      ctr: row.ctr, position: row.position,
    }));
    return { siteUrl, startDate: body.startDate, endDate: body.endDate, dimensions: dims, rowCount: rows.length, rows };
  }

  if (name === 'list_sitemaps') {
    const siteUrl = String(args.siteUrl || '');
    if (!siteUrl) throw new Error('siteUrl is required');
    const r = await gscFetch(`${WM_BASE}/sites/${encodeURIComponent(siteUrl)}/sitemaps`);
    return {
      sitemaps: (r.sitemap || []).map((s) => ({
        path: s.path, lastSubmitted: s.lastSubmitted, lastDownloaded: s.lastDownloaded,
        isPending: s.isPending, isSitemapsIndex: s.isSitemapsIndex, type: s.type,
        warnings: s.warnings, errors: s.errors,
      })),
    };
  }

  if (name === 'inspect_url') {
    const siteUrl = String(args.siteUrl || '');
    const inspectionUrl = String(args.inspectionUrl || '');
    if (!siteUrl || !inspectionUrl) throw new Error('siteUrl and inspectionUrl are both required');
    const body = { siteUrl, inspectionUrl, ...(args.languageCode ? { languageCode: String(args.languageCode) } : {}) };
    const r = await gscFetch(INSPECT_URL, { method: 'POST', body: JSON.stringify(body) });
    const idx = (r.inspectionResult || {}).indexStatusResult || {};
    return {
      inspectionUrl,
      verdict: idx.verdict,
      coverageState: idx.coverageState,
      robotsTxtState: idx.robotsTxtState,
      indexingState: idx.indexingState,
      lastCrawlTime: idx.lastCrawlTime,
      googleCanonical: idx.googleCanonical,
      userCanonical: idx.userCanonical,
      pageFetchState: idx.pageFetchState,
      result: r.inspectionResult || {},
    };
  }

  throw new Error(`Unknown tool: ${name}`);
}

// ── MCP server wiring ─────────────────────────────────────────────────

async function main() {
  const server = new Server({ name: 'gsearch-console-rest', version: '0.1.0' }, { capabilities: { tools: {} } });

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name, arguments: args = {} } = req.params;
    try {
      const result = await callTool(name, args || {});
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    } catch (err) {
      const msg = (err && err.message) || String(err);
      return { content: [{ type: 'text', text: msg }], isError: true };
    }
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

module.exports = { TOOLS, callTool };

if (require.main === module) {
  main().catch((err) => {
    process.stderr.write(`gsearch-console-mcp-server fatal: ${err && err.message || err}\n`);
    process.exit(1);
  });
}
