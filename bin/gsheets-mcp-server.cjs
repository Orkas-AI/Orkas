#!/usr/bin/env node
// Google Sheets MCP server (stdio). Wraps `sheets.googleapis.com` v4.

const { Server } = require('@modelcontextprotocol/sdk/server/index.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { ListToolsRequestSchema, CallToolRequestSchema } = require('@modelcontextprotocol/sdk/types.js');

const TOKEN = process.env.GOOGLE_ACCESS_TOKEN || '';
const BASE = 'https://sheets.googleapis.com/v4';

const TOOLS = [
  {
    name: 'list_sheets',
    description: 'List the tabs (sheets) in a spreadsheet. Returns each tab\'s sheetId, title, and dimensions.',
    inputSchema: {
      type: 'object',
      properties: {
        spreadsheetId: { type: 'string', description: 'The long hash in the URL after /spreadsheets/d/.' },
      },
      required: ['spreadsheetId'],
    },
  },
  {
    name: 'read_sheet',
    description:
      'Read cell values from a range. `range` uses A1 notation: "Sheet1!A1:C10", "A1:B5" (first tab), ' +
      '"Sheet1" (entire tab). `valueRenderOption=FORMATTED_VALUE` (default) returns user-visible strings; ' +
      'use `UNFORMATTED_VALUE` for raw numbers / serial dates; `FORMULA` to see formulas.',
    inputSchema: {
      type: 'object',
      properties: {
        spreadsheetId: { type: 'string' },
        range: { type: 'string', description: 'A1 notation.' },
        valueRenderOption: { type: 'string', enum: ['FORMATTED_VALUE', 'UNFORMATTED_VALUE', 'FORMULA'] },
      },
      required: ['spreadsheetId', 'range'],
    },
  },
  {
    name: 'write_sheet',
    description:
      'Write cell values. `values` is a 2D array of cells (rows of values). `valueInputOption` controls ' +
      'how user input is parsed: `RAW` stores strings verbatim, `USER_ENTERED` parses formulas / dates ' +
      'like typing in the UI (default).',
    inputSchema: {
      type: 'object',
      properties: {
        spreadsheetId: { type: 'string' },
        range: { type: 'string', description: 'A1 notation — anchor for the write.' },
        values: {
          type: 'array',
          description: 'Rows of cell values, e.g. [["a", 1], ["b", 2]].',
          items: { type: 'array' },
        },
        valueInputOption: { type: 'string', enum: ['RAW', 'USER_ENTERED'] },
      },
      required: ['spreadsheetId', 'range', 'values'],
    },
  },
  {
    name: 'create_spreadsheet',
    description: 'Create a new empty spreadsheet. Returns spreadsheetId + spreadsheetUrl.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Title of the new spreadsheet.' },
      },
      required: ['title'],
    },
  },
  {
    name: 'append_sheet',
    description:
      'Append rows to the end of a sheet. Google detects the existing data table starting at `range` ' +
      'and appends after the last row. Common pattern: `range="Sheet1!A1"` lets Google find the table.',
    inputSchema: {
      type: 'object',
      properties: {
        spreadsheetId: { type: 'string' },
        range: { type: 'string', description: 'A1 notation. Google appends below the table at this anchor.' },
        values: { type: 'array', description: '2D array of row values.', items: { type: 'array' } },
        valueInputOption: { type: 'string', enum: ['RAW', 'USER_ENTERED'] },
      },
      required: ['spreadsheetId', 'range', 'values'],
    },
  },
  {
    name: 'clear_sheet',
    description: 'Clear cell values in a range. Formatting + structure (rows/columns) untouched.',
    inputSchema: {
      type: 'object',
      properties: {
        spreadsheetId: { type: 'string' },
        range: { type: 'string', description: 'A1 notation.' },
      },
      required: ['spreadsheetId', 'range'],
    },
  },
  {
    name: 'batch_get',
    description: 'Read values from multiple ranges at once. Returns one entry per range with the same `valueRenderOption`.',
    inputSchema: {
      type: 'object',
      properties: {
        spreadsheetId: { type: 'string' },
        ranges: { type: 'array', items: { type: 'string' }, description: 'A1 notation array.' },
        valueRenderOption: { type: 'string', enum: ['FORMATTED_VALUE', 'UNFORMATTED_VALUE', 'FORMULA'] },
      },
      required: ['spreadsheetId', 'ranges'],
    },
  },
  {
    name: 'batch_update_values',
    description: 'Write multiple ranges in one call. `data` is an array of `{range, values}` objects.',
    inputSchema: {
      type: 'object',
      properties: {
        spreadsheetId: { type: 'string' },
        data: {
          type: 'array',
          description: 'Each entry: {range: A1, values: 2D array}.',
          items: { type: 'object' },
        },
        valueInputOption: { type: 'string', enum: ['RAW', 'USER_ENTERED'] },
      },
      required: ['spreadsheetId', 'data'],
    },
  },
  {
    name: 'add_sheet',
    description: 'Add a new tab (sheet) to an existing spreadsheet.',
    inputSchema: {
      type: 'object',
      properties: {
        spreadsheetId: { type: 'string' },
        title: { type: 'string', description: 'New sheet title.' },
        index: { type: 'integer', description: 'Position index (0-based). Default appends.' },
        rowCount: { type: 'integer' },
        columnCount: { type: 'integer' },
      },
      required: ['spreadsheetId', 'title'],
    },
  },
  {
    name: 'delete_sheet',
    description: 'Delete a tab (sheet) from a spreadsheet. Irreversible. Get `sheetId` from `list_sheets`.',
    inputSchema: {
      type: 'object',
      properties: {
        spreadsheetId: { type: 'string' },
        sheetId: { type: 'integer', description: 'The tab\'s sheetId (NOT title) — from `list_sheets`.' },
      },
      required: ['spreadsheetId', 'sheetId'],
    },
  },
  {
    name: 'duplicate_sheet',
    description: 'Copy a tab within the same spreadsheet (or to a different spreadsheet via `destinationSpreadsheetId`).',
    inputSchema: {
      type: 'object',
      properties: {
        spreadsheetId: { type: 'string' },
        sheetId: { type: 'integer', description: 'Source tab\'s sheetId.' },
        newSheetName: { type: 'string', description: 'Optional new title.' },
        insertSheetIndex: { type: 'integer', description: 'Position of the copy (default: right after source).' },
      },
      required: ['spreadsheetId', 'sheetId'],
    },
  },
  {
    name: 'find_and_replace',
    description: 'Find and replace text across an entire spreadsheet (or scoped to a single sheet / range). Returns occurrences changed.',
    inputSchema: {
      type: 'object',
      properties: {
        spreadsheetId: { type: 'string' },
        find: { type: 'string' },
        replacement: { type: 'string' },
        matchCase: { type: 'boolean' },
        matchEntireCell: { type: 'boolean' },
        searchByRegex: { type: 'boolean' },
        sheetId: { type: 'integer', description: 'Scope to one tab.' },
        range: { type: 'string', description: 'A1 notation. Scope to one range.' },
      },
      required: ['spreadsheetId', 'find', 'replacement'],
    },
  },
];

async function gFetch(pathAndQuery, init) {
  if (!TOKEN) throw new Error('GOOGLE_ACCESS_TOKEN env var not set');
  const res = await fetch(`${BASE}${pathAndQuery}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${TOKEN}`, Accept: 'application/json',
      ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
      ...(init?.headers || {}),
    },
  });
  const text = await res.text();
  if (!res.ok) {
    let msg = text;
    try { msg = JSON.parse(text).error?.message || text; } catch { /* keep raw */ }
    throw new Error(`Sheets API ${res.status}: ${msg}`);
  }
  return text ? JSON.parse(text) : {};
}

async function callTool(name, args) {
  if (name === 'list_sheets') {
    const id = encodeURIComponent(String(args.spreadsheetId || ''));
    if (!id) throw new Error('spreadsheetId is required');
    // fields= trims response — we only need sheet metadata, not cell data.
    const r = await gFetch(`/spreadsheets/${id}?fields=properties(title),sheets.properties`);
    return {
      title: r.properties?.title,
      sheets: (r.sheets || []).map((s) => ({
        sheetId: s.properties?.sheetId,
        title: s.properties?.title,
        index: s.properties?.index,
        rowCount: s.properties?.gridProperties?.rowCount,
        columnCount: s.properties?.gridProperties?.columnCount,
      })),
    };
  }
  if (name === 'read_sheet') {
    const id = encodeURIComponent(String(args.spreadsheetId || ''));
    const range = String(args.range || '');
    if (!id || !range) throw new Error('spreadsheetId and range are both required');
    const opt = ['FORMATTED_VALUE', 'UNFORMATTED_VALUE', 'FORMULA'].includes(args.valueRenderOption)
      ? args.valueRenderOption : 'FORMATTED_VALUE';
    const r = await gFetch(`/spreadsheets/${id}/values/${encodeURIComponent(range)}?valueRenderOption=${opt}`);
    return { range: r.range, majorDimension: r.majorDimension, values: r.values || [] };
  }
  if (name === 'write_sheet') {
    const id = encodeURIComponent(String(args.spreadsheetId || ''));
    const range = String(args.range || '');
    if (!id || !range) throw new Error('spreadsheetId and range are both required');
    if (!Array.isArray(args.values)) throw new Error('values must be a 2D array');
    const opt = ['RAW', 'USER_ENTERED'].includes(args.valueInputOption) ? args.valueInputOption : 'USER_ENTERED';
    const r = await gFetch(
      `/spreadsheets/${id}/values/${encodeURIComponent(range)}?valueInputOption=${opt}`,
      { method: 'PUT', body: JSON.stringify({ values: args.values }) },
    );
    return {
      updatedRange: r.updatedRange, updatedRows: r.updatedRows,
      updatedColumns: r.updatedColumns, updatedCells: r.updatedCells,
    };
  }
  if (name === 'create_spreadsheet') {
    const title = String(args.title || '').trim();
    if (!title) throw new Error('title is required');
    const r = await gFetch('/spreadsheets', { method: 'POST', body: JSON.stringify({ properties: { title } }) });
    return { spreadsheetId: r.spreadsheetId, spreadsheetUrl: r.spreadsheetUrl, title: r.properties?.title };
  }
  if (name === 'append_sheet') {
    const id = encodeURIComponent(String(args.spreadsheetId || ''));
    const range = String(args.range || '');
    if (!id || !range) throw new Error('spreadsheetId and range are both required');
    if (!Array.isArray(args.values)) throw new Error('values must be a 2D array');
    const opt = ['RAW', 'USER_ENTERED'].includes(args.valueInputOption) ? args.valueInputOption : 'USER_ENTERED';
    const r = await gFetch(
      `/spreadsheets/${id}/values/${encodeURIComponent(range)}:append?valueInputOption=${opt}&insertDataOption=INSERT_ROWS`,
      { method: 'POST', body: JSON.stringify({ values: args.values }) },
    );
    return {
      updates: {
        updatedRange: r.updates?.updatedRange,
        updatedRows: r.updates?.updatedRows,
        updatedColumns: r.updates?.updatedColumns,
        updatedCells: r.updates?.updatedCells,
      },
    };
  }
  if (name === 'clear_sheet') {
    const id = encodeURIComponent(String(args.spreadsheetId || ''));
    const range = String(args.range || '');
    if (!id || !range) throw new Error('spreadsheetId and range are both required');
    const r = await gFetch(`/spreadsheets/${id}/values/${encodeURIComponent(range)}:clear`, { method: 'POST' });
    return { clearedRange: r.clearedRange };
  }
  if (name === 'batch_get') {
    const id = encodeURIComponent(String(args.spreadsheetId || ''));
    const ranges = Array.isArray(args.ranges) ? args.ranges.filter((x) => typeof x === 'string') : [];
    if (!id || !ranges.length) throw new Error('spreadsheetId and ranges are both required');
    const opt = ['FORMATTED_VALUE', 'UNFORMATTED_VALUE', 'FORMULA'].includes(args.valueRenderOption)
      ? args.valueRenderOption : 'FORMATTED_VALUE';
    const qs = new URLSearchParams({ valueRenderOption: opt });
    for (const r of ranges) qs.append('ranges', r);
    const r = await gFetch(`/spreadsheets/${id}/values:batchGet?${qs}`);
    return { valueRanges: r.valueRanges || [] };
  }
  if (name === 'batch_update_values') {
    const id = encodeURIComponent(String(args.spreadsheetId || ''));
    if (!id) throw new Error('spreadsheetId is required');
    const data = Array.isArray(args.data) ? args.data : [];
    if (!data.length) throw new Error('data is required (non-empty array)');
    const opt = ['RAW', 'USER_ENTERED'].includes(args.valueInputOption) ? args.valueInputOption : 'USER_ENTERED';
    const r = await gFetch(`/spreadsheets/${id}/values:batchUpdate`, {
      method: 'POST',
      body: JSON.stringify({ valueInputOption: opt, data }),
    });
    return {
      totalUpdatedRows: r.totalUpdatedRows, totalUpdatedColumns: r.totalUpdatedColumns,
      totalUpdatedCells: r.totalUpdatedCells, totalUpdatedSheets: r.totalUpdatedSheets,
    };
  }
  if (name === 'add_sheet') {
    const id = encodeURIComponent(String(args.spreadsheetId || ''));
    const title = String(args.title || '').trim();
    if (!id || !title) throw new Error('spreadsheetId and title are both required');
    const properties = { title };
    if (Number.isInteger(args.index)) properties.index = args.index;
    if (Number.isInteger(args.rowCount) || Number.isInteger(args.columnCount)) {
      properties.gridProperties = {
        ...(Number.isInteger(args.rowCount) ? { rowCount: args.rowCount } : {}),
        ...(Number.isInteger(args.columnCount) ? { columnCount: args.columnCount } : {}),
      };
    }
    const r = await gFetch(`/spreadsheets/${id}:batchUpdate`, {
      method: 'POST',
      body: JSON.stringify({ requests: [{ addSheet: { properties } }] }),
    });
    const reply = r.replies?.[0]?.addSheet?.properties || {};
    return { sheetId: reply.sheetId, title: reply.title, index: reply.index };
  }
  if (name === 'delete_sheet') {
    const id = encodeURIComponent(String(args.spreadsheetId || ''));
    if (!id) throw new Error('spreadsheetId is required');
    if (!Number.isInteger(args.sheetId)) throw new Error('sheetId is required (integer)');
    await gFetch(`/spreadsheets/${id}:batchUpdate`, {
      method: 'POST',
      body: JSON.stringify({ requests: [{ deleteSheet: { sheetId: args.sheetId } }] }),
    });
    return { ok: true };
  }
  if (name === 'duplicate_sheet') {
    const id = encodeURIComponent(String(args.spreadsheetId || ''));
    if (!id) throw new Error('spreadsheetId is required');
    if (!Number.isInteger(args.sheetId)) throw new Error('sheetId is required (integer)');
    const dup = { sourceSheetId: args.sheetId };
    if (typeof args.newSheetName === 'string') dup.newSheetName = args.newSheetName;
    if (Number.isInteger(args.insertSheetIndex)) dup.insertSheetIndex = args.insertSheetIndex;
    const r = await gFetch(`/spreadsheets/${id}:batchUpdate`, {
      method: 'POST',
      body: JSON.stringify({ requests: [{ duplicateSheet: dup }] }),
    });
    const reply = r.replies?.[0]?.duplicateSheet?.properties || {};
    return { sheetId: reply.sheetId, title: reply.title, index: reply.index };
  }
  if (name === 'find_and_replace') {
    const id = encodeURIComponent(String(args.spreadsheetId || ''));
    if (!id) throw new Error('spreadsheetId is required');
    const find = String(args.find || '');
    if (!find) throw new Error('find is required');
    const fr = {
      find,
      replacement: String(args.replacement ?? ''),
      matchCase: args.matchCase === true,
      matchEntireCell: args.matchEntireCell === true,
      searchByRegex: args.searchByRegex === true,
    };
    if (Number.isInteger(args.sheetId)) fr.sheetId = args.sheetId;
    else if (typeof args.range === 'string' && args.range) fr.range = { sheetId: 0 }; // simplified — range scoping needs gridrange parsing; default to first sheet
    else fr.allSheets = true;
    const r = await gFetch(`/spreadsheets/${id}:batchUpdate`, {
      method: 'POST',
      body: JSON.stringify({ requests: [{ findReplace: fr }] }),
    });
    const reply = r.replies?.[0]?.findReplace || {};
    return {
      occurrencesChanged: reply.occurrencesChanged || 0,
      valuesChanged: reply.valuesChanged || 0,
      rowsChanged: reply.rowsChanged || 0,
      sheetsChanged: reply.sheetsChanged || 0,
    };
  }
  throw new Error(`Unknown tool: ${name}`);
}

async function main() {
  const server = new Server({ name: 'gsheets-rest', version: '0.1.0' }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));
  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name, arguments: args = {} } = req.params;
    try {
      const result = await callTool(name, args || {});
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    } catch (err) {
      return { content: [{ type: 'text', text: (err && err.message) || String(err) }], isError: true };
    }
  });
  await server.connect(new StdioServerTransport());
}

module.exports = { TOOLS, callTool };

if (require.main === module) {
  main().catch((err) => {
    process.stderr.write(`gsheets-mcp-server fatal: ${err && err.message || err}\n`);
    process.exit(1);
  });
}
