#!/usr/bin/env node
// Google Calendar MCP server (stdio). Same pattern as bin/gmail-mcp-server.cjs — wraps the public
// Google Calendar REST API (`calendar.googleapis.com`, GA since 2014) to bypass the Workspace MCP
// Developer Preview allowlist on `calendarmcp.googleapis.com`. OAuth scope `calendar` granted by
// Server's `google.py::_SCOPES_BY_CATALOG_ID['gcal']`; token injected via `GOOGLE_ACCESS_TOKEN`.

const { Server } = require('@modelcontextprotocol/sdk/server/index.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { ListToolsRequestSchema, CallToolRequestSchema } = require('@modelcontextprotocol/sdk/types.js');

const TOKEN = process.env.GOOGLE_ACCESS_TOKEN || '';
const BASE = 'https://www.googleapis.com/calendar/v3';
const MAX_LIST = 50;

const TOOLS = [
  {
    name: 'list_calendars',
    description: 'List the user\'s calendars (the calendarId values feed `list_events` / `create_event`). `primary` is the user\'s default.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'list_events',
    description:
      'List events on a calendar within a time window. Defaults: calendarId=primary, timeMin=now, ' +
      'timeMax=now+7d, maxResults=20 (max 50). `q` does free-text search across summary / description / ' +
      'attendees / location.',
    inputSchema: {
      type: 'object',
      properties: {
        calendarId: { type: 'string', description: 'Calendar id from `list_calendars` (default "primary").' },
        timeMin: { type: 'string', description: 'RFC3339 lower bound (default now).' },
        timeMax: { type: 'string', description: 'RFC3339 upper bound (default now + 7d).' },
        q: { type: 'string', description: 'Free-text query.' },
        maxResults: { type: 'integer', minimum: 1, maximum: 50 },
      },
    },
  },
  {
    name: 'get_event',
    description: 'Fetch a single event by id.',
    inputSchema: {
      type: 'object',
      properties: {
        calendarId: { type: 'string', description: 'Default "primary".' },
        eventId: { type: 'string' },
      },
      required: ['eventId'],
    },
  },
  {
    name: 'create_event',
    description:
      'Create a calendar event. `start` / `end` accept either { dateTime: RFC3339, timeZone? } for ' +
      'timed events or { date: YYYY-MM-DD } for all-day. `attendees` is a list of email strings.',
    inputSchema: {
      type: 'object',
      properties: {
        calendarId: { type: 'string', description: 'Default "primary".' },
        summary: { type: 'string', description: 'Event title.' },
        start: { type: 'object', description: '{dateTime, timeZone?} OR {date}.' },
        end: { type: 'object', description: 'Same shape as start.' },
        attendees: { type: 'array', items: { type: 'string' }, description: 'Email list.' },
        description: { type: 'string' },
        location: { type: 'string' },
      },
      required: ['summary', 'start', 'end'],
    },
  },
  {
    name: 'quick_add_event',
    description:
      'Create an event from a natural-language string ("Lunch with Sam tomorrow at noon"). Google parses ' +
      'date/time/attendees itself. Faster than `create_event` for one-shot inputs; less control over fields.',
    inputSchema: {
      type: 'object',
      properties: {
        calendarId: { type: 'string', description: 'Default "primary".' },
        text: { type: 'string', description: 'Natural-language event description.' },
      },
      required: ['text'],
    },
  },
  {
    name: 'update_event',
    description:
      'Patch an event. Only fields you pass are touched (PATCH semantics). Use `move_event` to ' +
      'change the calendar.',
    inputSchema: {
      type: 'object',
      properties: {
        calendarId: { type: 'string', description: 'Default "primary".' },
        eventId: { type: 'string' },
        summary: { type: 'string' },
        start: { type: 'object', description: '{dateTime, timeZone?} OR {date}.' },
        end: { type: 'object' },
        attendees: { type: 'array', items: { type: 'string' } },
        description: { type: 'string' },
        location: { type: 'string' },
      },
      required: ['eventId'],
    },
  },
  {
    name: 'delete_event',
    description: 'Delete an event. Irreversible.',
    inputSchema: {
      type: 'object',
      properties: {
        calendarId: { type: 'string', description: 'Default "primary".' },
        eventId: { type: 'string' },
      },
      required: ['eventId'],
    },
  },
  {
    name: 'move_event',
    description: 'Move an event from one calendar to another (same time, different calendar).',
    inputSchema: {
      type: 'object',
      properties: {
        calendarId: { type: 'string', description: 'Source calendar id.' },
        eventId: { type: 'string' },
        destinationCalendarId: { type: 'string', description: 'Where to move the event.' },
      },
      required: ['eventId', 'destinationCalendarId'],
    },
  },
  {
    name: 'list_event_instances',
    description: 'Expand a recurring event into its individual instances within a time window.',
    inputSchema: {
      type: 'object',
      properties: {
        calendarId: { type: 'string', description: 'Default "primary".' },
        eventId: { type: 'string', description: 'The recurring event\'s base id.' },
        timeMin: { type: 'string', description: 'RFC3339.' },
        timeMax: { type: 'string', description: 'RFC3339.' },
        maxResults: { type: 'integer', minimum: 1, maximum: 100 },
      },
      required: ['eventId'],
    },
  },
  {
    name: 'freebusy_query',
    description:
      'Check free/busy slots for a set of calendars over a time window. Returns blocked time ranges per ' +
      'calendar — useful for "find a slot when everyone\'s free".',
    inputSchema: {
      type: 'object',
      properties: {
        timeMin: { type: 'string', description: 'RFC3339 start.' },
        timeMax: { type: 'string', description: 'RFC3339 end.' },
        calendarIds: {
          type: 'array',
          items: { type: 'string' },
          description: 'Calendars or attendee emails to check.',
        },
        timeZone: { type: 'string', description: 'Optional IANA tz (e.g. "Asia/Shanghai").' },
      },
      required: ['timeMin', 'timeMax', 'calendarIds'],
    },
  },
  {
    name: 'create_calendar',
    description: 'Create a new secondary calendar. Returns the new calendarId.',
    inputSchema: {
      type: 'object',
      properties: {
        summary: { type: 'string', description: 'Calendar name.' },
        description: { type: 'string' },
        timeZone: { type: 'string', description: 'IANA tz (default user\'s).' },
      },
      required: ['summary'],
    },
  },
  {
    name: 'delete_calendar',
    description: 'Delete a secondary calendar (you can\'t delete `primary`). All events on it are removed.',
    inputSchema: {
      type: 'object',
      properties: {
        calendarId: { type: 'string' },
      },
      required: ['calendarId'],
    },
  },
];

async function gFetch(pathAndQuery, init) {
  if (!TOKEN) throw new Error('GOOGLE_ACCESS_TOKEN env var not set');
  const res = await fetch(`${BASE}${pathAndQuery}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      Accept: 'application/json',
      ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
      ...(init?.headers || {}),
    },
  });
  const text = await res.text();
  if (!res.ok) {
    let msg = text;
    try { msg = JSON.parse(text).error?.message || text; } catch { /* keep raw */ }
    throw new Error(`Calendar API ${res.status}: ${msg}`);
  }
  return text ? JSON.parse(text) : {};
}

async function callTool(name, args) {
  if (name === 'list_calendars') {
    const r = await gFetch('/users/me/calendarList');
    return {
      calendars: (r.items || []).map((c) => ({
        id: c.id, summary: c.summary, primary: !!c.primary, accessRole: c.accessRole, timeZone: c.timeZone,
      })),
    };
  }
  if (name === 'list_events') {
    const cid = encodeURIComponent(args.calendarId || 'primary');
    const now = new Date();
    const timeMin = args.timeMin || now.toISOString();
    const timeMax = args.timeMax || new Date(now.getTime() + 7 * 86400 * 1000).toISOString();
    const max = Math.min(MAX_LIST, Math.max(1, parseInt(args.maxResults, 10) || 20));
    const qs = new URLSearchParams({
      timeMin, timeMax, maxResults: String(max), singleEvents: 'true', orderBy: 'startTime',
    });
    if (args.q) qs.set('q', String(args.q));
    const r = await gFetch(`/calendars/${cid}/events?${qs}`);
    return {
      events: (r.items || []).map((e) => ({
        id: e.id,
        summary: e.summary,
        start: e.start,
        end: e.end,
        location: e.location,
        attendees: (e.attendees || []).map((a) => ({ email: a.email, responseStatus: a.responseStatus })),
        htmlLink: e.htmlLink,
        status: e.status,
      })),
      nextPageToken: r.nextPageToken,
    };
  }
  if (name === 'get_event') {
    const cid = encodeURIComponent(args.calendarId || 'primary');
    const eid = encodeURIComponent(String(args.eventId || ''));
    if (!eid) throw new Error('eventId is required');
    return await gFetch(`/calendars/${cid}/events/${eid}`);
  }
  if (name === 'create_event') {
    const cid = encodeURIComponent(args.calendarId || 'primary');
    const body = {
      summary: args.summary, start: args.start, end: args.end,
      ...(args.description ? { description: args.description } : {}),
      ...(args.location ? { location: args.location } : {}),
      ...(Array.isArray(args.attendees) && args.attendees.length
        ? { attendees: args.attendees.map((e) => ({ email: String(e) })) }
        : {}),
    };
    const r = await gFetch(`/calendars/${cid}/events`, { method: 'POST', body: JSON.stringify(body) });
    return { id: r.id, htmlLink: r.htmlLink, status: r.status, summary: r.summary, start: r.start, end: r.end };
  }
  if (name === 'quick_add_event') {
    const cid = encodeURIComponent(args.calendarId || 'primary');
    const text = String(args.text || '').trim();
    if (!text) throw new Error('text is required');
    const r = await gFetch(`/calendars/${cid}/events/quickAdd?text=${encodeURIComponent(text)}`, { method: 'POST' });
    return { id: r.id, htmlLink: r.htmlLink, summary: r.summary, start: r.start, end: r.end };
  }
  if (name === 'update_event') {
    const cid = encodeURIComponent(args.calendarId || 'primary');
    const eid = encodeURIComponent(String(args.eventId || ''));
    if (!eid) throw new Error('eventId is required');
    const body = {};
    if (typeof args.summary === 'string') body.summary = args.summary;
    if (args.start) body.start = args.start;
    if (args.end) body.end = args.end;
    if (typeof args.description === 'string') body.description = args.description;
    if (typeof args.location === 'string') body.location = args.location;
    if (Array.isArray(args.attendees)) body.attendees = args.attendees.map((e) => ({ email: String(e) }));
    const r = await gFetch(`/calendars/${cid}/events/${eid}`, { method: 'PATCH', body: JSON.stringify(body) });
    return { id: r.id, htmlLink: r.htmlLink, summary: r.summary, start: r.start, end: r.end };
  }
  if (name === 'delete_event') {
    const cid = encodeURIComponent(args.calendarId || 'primary');
    const eid = encodeURIComponent(String(args.eventId || ''));
    if (!eid) throw new Error('eventId is required');
    await gFetch(`/calendars/${cid}/events/${eid}`, { method: 'DELETE' });
    return { ok: true };
  }
  if (name === 'move_event') {
    const cid = encodeURIComponent(args.calendarId || 'primary');
    const eid = encodeURIComponent(String(args.eventId || ''));
    const dest = encodeURIComponent(String(args.destinationCalendarId || ''));
    if (!eid || !dest) throw new Error('eventId and destinationCalendarId are both required');
    const r = await gFetch(`/calendars/${cid}/events/${eid}/move?destination=${dest}`, { method: 'POST' });
    return { id: r.id, htmlLink: r.htmlLink, summary: r.summary };
  }
  if (name === 'list_event_instances') {
    const cid = encodeURIComponent(args.calendarId || 'primary');
    const eid = encodeURIComponent(String(args.eventId || ''));
    if (!eid) throw new Error('eventId is required');
    const max = Math.min(100, Math.max(1, parseInt(args.maxResults, 10) || 25));
    const qs = new URLSearchParams({ maxResults: String(max) });
    if (args.timeMin) qs.set('timeMin', String(args.timeMin));
    if (args.timeMax) qs.set('timeMax', String(args.timeMax));
    const r = await gFetch(`/calendars/${cid}/events/${eid}/instances?${qs}`);
    return {
      instances: (r.items || []).map((e) => ({
        id: e.id, originalStartTime: e.originalStartTime, start: e.start, end: e.end, status: e.status,
      })),
    };
  }
  if (name === 'freebusy_query') {
    if (!args.timeMin || !args.timeMax) throw new Error('timeMin and timeMax are required');
    const ids = Array.isArray(args.calendarIds) ? args.calendarIds.filter((x) => typeof x === 'string') : [];
    if (!ids.length) throw new Error('calendarIds is required (non-empty array)');
    const body = {
      timeMin: String(args.timeMin),
      timeMax: String(args.timeMax),
      items: ids.map((id) => ({ id })),
      ...(args.timeZone ? { timeZone: String(args.timeZone) } : {}),
    };
    const r = await gFetch('/freeBusy', { method: 'POST', body: JSON.stringify(body) });
    return { calendars: r.calendars || {}, timeMin: r.timeMin, timeMax: r.timeMax };
  }
  if (name === 'create_calendar') {
    const summary = String(args.summary || '').trim();
    if (!summary) throw new Error('summary is required');
    const body = {
      summary,
      ...(args.description ? { description: String(args.description) } : {}),
      ...(args.timeZone ? { timeZone: String(args.timeZone) } : {}),
    };
    const r = await gFetch('/calendars', { method: 'POST', body: JSON.stringify(body) });
    return { id: r.id, summary: r.summary, timeZone: r.timeZone };
  }
  if (name === 'delete_calendar') {
    const cid = encodeURIComponent(String(args.calendarId || ''));
    if (!cid) throw new Error('calendarId is required');
    await gFetch(`/calendars/${cid}`, { method: 'DELETE' });
    return { ok: true };
  }
  throw new Error(`Unknown tool: ${name}`);
}

async function main() {
  const server = new Server({ name: 'gcal-rest', version: '0.1.0' }, { capabilities: { tools: {} } });
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

main().catch((err) => {
  process.stderr.write(`gcal-mcp-server fatal: ${err && err.message || err}\n`);
  process.exit(1);
});
