import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
import * as path from 'node:path';

const requireCjs = createRequire(import.meta.url);

type Adapter = {
  TOOLS: Array<{ name: string }>;
  callTool: (name: string, args: Record<string, unknown>) => Promise<unknown>;
};

function loadAdapter(file: string): Adapter {
  const full = path.join(process.cwd(), 'bin', file);
  delete requireCjs.cache[full];
  return requireCjs(full) as Adapter;
}

function jsonResponse(body: unknown, status = 200): { ok: boolean; status: number; text: () => Promise<string> } {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body),
  };
}

function mockFetchOnce(body: unknown, status = 200): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(async () => jsonResponse(body, status));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

describe('Google stdio REST adapters', () => {
  beforeEach(() => {
    process.env.GOOGLE_ACCESS_TOKEN = 'test-access-token';
  });

  afterEach(() => {
    delete process.env.GOOGLE_ACCESS_TOKEN;
    vi.unstubAllGlobals();
  });

  it('exports tool metadata without starting the stdio server', () => {
    for (const file of [
      'gmail-mcp-server.cjs',
      'gcal-mcp-server.cjs',
      'gdocs-mcp-server.cjs',
      'gsheets-mcp-server.cjs',
      'gtasks-mcp-server.cjs',
      'google-workspace-mcp-server.cjs',
    ]) {
      const adapter = loadAdapter(file);
      expect(adapter.TOOLS.length).toBeGreaterThan(0);
      expect(typeof adapter.callTool).toBe('function');
    }
  });

  it('google workspace adapter aggregates service tools without starting the stdio server', () => {
    const adapter = loadAdapter('google-workspace-mcp-server.cjs');
    const names = adapter.TOOLS.map((t) => t.name);

    expect(new Set(names).size).toBe(names.length);
    expect(names).toContain('send_message');
    expect(names).toContain('list_events');
    expect(names).toContain('get_document');
    expect(names).toContain('read_sheet');
    expect(names).toContain('list_tasks');
  });

  it('gmail list_labels maps labels and sends the bearer token', async () => {
    const fetchMock = mockFetchOnce({ labels: [{ id: 'INBOX', name: 'Inbox', type: 'system' }] });
    const adapter = loadAdapter('gmail-mcp-server.cjs');

    await expect(adapter.callTool('list_labels', {})).resolves.toEqual({
      labels: [{ id: 'INBOX', name: 'Inbox', type: 'system' }],
    });
    expect(fetchMock).toHaveBeenCalledWith(
      'https://gmail.googleapis.com/gmail/v1/users/me/labels',
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: 'Bearer test-access-token' }),
      }),
    );
  });

  it('calendar list_calendars maps calendarList items', async () => {
    mockFetchOnce({ items: [{ id: 'primary', summary: 'Work', primary: true, accessRole: 'owner', timeZone: 'UTC' }] });
    const adapter = loadAdapter('gcal-mcp-server.cjs');

    await expect(adapter.callTool('list_calendars', {})).resolves.toEqual({
      calendars: [{ id: 'primary', summary: 'Work', primary: true, accessRole: 'owner', timeZone: 'UTC' }],
    });
  });

  it('docs create_document posts a title and returns document metadata', async () => {
    const fetchMock = mockFetchOnce({ documentId: 'doc-1', title: 'Spec' });
    const adapter = loadAdapter('gdocs-mcp-server.cjs');

    await expect(adapter.callTool('create_document', { title: 'Spec' })).resolves.toEqual({
      documentId: 'doc-1',
      title: 'Spec',
    });
    expect(fetchMock).toHaveBeenCalledWith(
      'https://docs.googleapis.com/v1/documents',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ title: 'Spec' }),
      }),
    );
  });

  it('sheets read_sheet encodes range and preserves values', async () => {
    const fetchMock = mockFetchOnce({ range: 'Sheet1!A1:B2', majorDimension: 'ROWS', values: [['A', 'B']] });
    const adapter = loadAdapter('gsheets-mcp-server.cjs');

    await expect(adapter.callTool('read_sheet', { spreadsheetId: 'sheet 1', range: 'Sheet1!A1:B2' })).resolves.toEqual({
      range: 'Sheet1!A1:B2',
      majorDimension: 'ROWS',
      values: [['A', 'B']],
    });
    expect(fetchMock.mock.calls[0][0]).toBe(
      'https://sheets.googleapis.com/v4/spreadsheets/sheet%201/values/Sheet1!A1%3AB2?valueRenderOption=FORMATTED_VALUE',
    );
  });

  it('tasks list_tasklists maps task list summaries', async () => {
    mockFetchOnce({ items: [{ id: 'tl-1', title: 'Today', updated: '2026-05-15T00:00:00Z' }] });
    const adapter = loadAdapter('gtasks-mcp-server.cjs');

    await expect(adapter.callTool('list_tasklists', {})).resolves.toEqual({
      tasklists: [{ id: 'tl-1', title: 'Today', updated: '2026-05-15T00:00:00Z' }],
    });
  });

  it('surfaces provider error messages with service and status', async () => {
    const cases: Array<[string, string, string, Record<string, unknown>]> = [
      ['gmail-mcp-server.cjs', 'Gmail API 403: denied', 'list_labels', {}],
      ['gcal-mcp-server.cjs', 'Calendar API 403: denied', 'list_calendars', {}],
      ['gdocs-mcp-server.cjs', 'Docs API 403: denied', 'create_document', { title: 'Spec' }],
      ['gsheets-mcp-server.cjs', 'Sheets API 403: denied', 'read_sheet', { spreadsheetId: 's1', range: 'A1' }],
      ['gtasks-mcp-server.cjs', 'Tasks API 403: denied', 'list_tasklists', {}],
    ];

    for (const [file, message, tool, args] of cases) {
      mockFetchOnce({ error: { message: 'denied' } }, 403);
      const adapter = loadAdapter(file);
      await expect(adapter.callTool(tool, args)).rejects.toThrow(message);
      vi.unstubAllGlobals();
    }
  });
});
