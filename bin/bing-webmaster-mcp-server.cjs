#!/usr/bin/env node
// Bing Webmaster Tools MCP server (stdio) — wraps the Bing Webmaster JSON REST API behind the MCP
// tool-use protocol. Spawned as a child process by `features/connectors/mcp-client.ts`; the OAuth
// access_token is injected through `BING_ACCESS_TOKEN` env (see `apply-template.ts`). Mirrors
// `bin/gsearch-console-mcp-server.cjs`. Scope `webmaster.read` is granted by Server's
// `biz/connectors/oauth/bing.py`.
//
// API: OAuth Bearer per https://learn.microsoft.com/bingwebmaster/oauth2 step 6 — the JSON API at
// `https://www.bing.com/webmaster/api.svc/json/<Method>` accepts `Authorization: Bearer <token>`
// in place of the `?apikey=` query param. Responses are WCF-JSON: the payload is wrapped in a `d`
// property and dates are `/Date(ms)/` strings — `_unwrap` + `_normalizeDates` handle both.
//
// Tool surface (4 read-only tools, v1; parallels the GSC adapter's sites/queries/pages/traffic):
//   - list_sites()                         → GetUserSites          (the BWT properties the user owns)
//   - query_keyword_stats(siteUrl)         → GetQueryStats         (per-query clicks/impressions/position)
//   - query_page_stats(siteUrl)            → GetPageStats          (per-page clicks/impressions)
//   - query_traffic_stats(siteUrl)         → GetRankAndTrafficStats (daily clicks/impressions trend)

const { Server } = require('@modelcontextprotocol/sdk/server/index.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} = require('@modelcontextprotocol/sdk/types.js');

const TOKEN = process.env.BING_ACCESS_TOKEN || '';
// `www.bing.com` is the host the OAuth docs pair with Bearer auth; `ssl.bing.com` serves the same
// JSON API. Methods are GET with a `siteUrl` query param (GetUserSites takes none).
const API_BASE = 'https://www.bing.com/webmaster/api.svc/json';
const REQUEST_TIMEOUT_MS = 30000;  // explicit — node global fetch has no default timeout

// ── Tool definitions ──────────────────────────────────────────────────

const TOOLS = [
  {
    name: 'list_sites',
    description:
      'List the Bing Webmaster Tools sites (properties) the authenticated user has verified, with ' +
      'each siteUrl. Use a returned siteUrl with the other tools. Bing site verification is ' +
      'separate from Google Search Console — a site may be in one and not the other.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'query_keyword_stats',
    description:
      'Per-query search performance for a Bing property: clicks, impressions, and average position. ' +
      'Bing returns AvgImpressionPosition / AvgClickPosition as it computes them (1-based-ish; a ' +
      'lower number is better). Use for "which queries does Bing rank this site for" — the Bing ' +
      'analogue of GSC query_search_analytics grouped by query.',
    inputSchema: {
      type: 'object',
      properties: {
        siteUrl: { type: 'string', description: 'A property from list_sites (e.g. "https://example.com/"). Required.' },
      },
      required: ['siteUrl'],
    },
  },
  {
    name: 'query_page_stats',
    description:
      'Per-page search performance for a Bing property: clicks and impressions per URL. Use to find ' +
      'which pages earn Bing traffic (the Bing analogue of GSC grouped by page).',
    inputSchema: {
      type: 'object',
      properties: {
        siteUrl: { type: 'string', description: 'A property from list_sites. Required.' },
      },
      required: ['siteUrl'],
    },
  },
  {
    name: 'query_traffic_stats',
    description:
      'Daily rank-and-traffic trend for a Bing property: clicks and impressions per day. Use to see ' +
      'the traffic trend over time (good for monitoring drift).',
    inputSchema: {
      type: 'object',
      properties: {
        siteUrl: { type: 'string', description: 'A property from list_sites. Required.' },
      },
      required: ['siteUrl'],
    },
  },
];

// ── WCF-JSON helpers ──────────────────────────────────────────────────

const _DATE_RE = /^\/Date\((\d+)(?:[-+]\d+)?\)\/$/;

/** Recursively convert Bing `/Date(ms)/` strings to YYYY-MM-DD and drop noisy `__type` keys. */
function _normalizeDates(value) {
  if (Array.isArray(value)) return value.map(_normalizeDates);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (k === '__type') continue;
      out[k] = _normalizeDates(v);
    }
    return out;
  }
  if (typeof value === 'string') {
    const m = _DATE_RE.exec(value);
    if (m) return new Date(Number(m[1])).toISOString().slice(0, 10);
  }
  return value;
}

/** Unwrap the WCF `{ d: ... }` envelope, tolerating `{d:[...]}`, a bare array, or
 *  `{d:{<something>:[...]}}`. Always returns an array of row objects. */
function _unwrapRows(payload) {
  let d = payload && typeof payload === 'object' && 'd' in payload ? payload.d : payload;
  if (Array.isArray(d)) return d;
  if (d && typeof d === 'object') {
    const arr = Object.values(d).find((v) => Array.isArray(v));
    if (arr) return arr;
    return [d];
  }
  return [];
}

async function bingFetch(method, siteUrl) {
  if (!TOKEN) throw new Error('BING_ACCESS_TOKEN env var not set');
  const qs = siteUrl ? `?siteUrl=${encodeURIComponent(siteUrl)}` : '';
  const res = await fetch(`${API_BASE}/${method}${qs}`, {
    method: 'GET',
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    headers: { Authorization: `Bearer ${TOKEN}`, Accept: 'application/json' },
  });
  const text = await res.text();
  if (!res.ok) {
    // Bing surfaces errors as JSON ({Message} / {Errors:[...]}) or an HTML page. Pass a trimmed
    // detail so the model can react (401 → reconnect, 403 → not a verified owner, 429 → backoff).
    let detail = text.slice(0, 300);
    try {
      const j = JSON.parse(text);
      detail = j.Message || (j.Errors && JSON.stringify(j.Errors)) || detail;
    } catch { /* keep raw */ }
    throw new Error(`Bing Webmaster API ${method} ${res.status}: ${detail}`);
  }
  const rows = _normalizeDates(_unwrapRows(text ? JSON.parse(text) : {}));
  return Array.isArray(rows) ? rows : [];
}

// ── Tool dispatch ─────────────────────────────────────────────────────

async function callTool(name, args) {
  if (name === 'list_sites') {
    const rows = await bingFetch('GetUserSites', '');
    return { sites: rows.map((s) => ({ siteUrl: s.Url || s.SiteUrl || s.url, raw: s })), rowCount: rows.length };
  }

  const siteUrl = String(args.siteUrl || '');
  if (!siteUrl) throw new Error('siteUrl is required (from list_sites)');

  if (name === 'query_keyword_stats') {
    const rows = await bingFetch('GetQueryStats', siteUrl);
    return { siteUrl, rowCount: rows.length, rows };
  }
  if (name === 'query_page_stats') {
    const rows = await bingFetch('GetPageStats', siteUrl);
    return { siteUrl, rowCount: rows.length, rows };
  }
  if (name === 'query_traffic_stats') {
    const rows = await bingFetch('GetRankAndTrafficStats', siteUrl);
    return { siteUrl, rowCount: rows.length, rows };
  }

  throw new Error(`Unknown tool: ${name}`);
}

// ── MCP server wiring ─────────────────────────────────────────────────

async function main() {
  const server = new Server({ name: 'bing-webmaster-rest', version: '0.1.0' }, { capabilities: { tools: {} } });

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
    process.stderr.write(`bing-webmaster-mcp-server fatal: ${err && err.message || err}\n`);
    process.exit(1);
  });
}
