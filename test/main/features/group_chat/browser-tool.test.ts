import { describe, expect, it, vi } from 'vitest';

import {
  buildBrowserTool,
  type BrowserToolCallbacks,
} from '../../../../src/main/features/group_chat/browser_tool';

function callbacks(overrides: Partial<BrowserToolCallbacks> = {}): BrowserToolCallbacks {
  return {
    tabs: vi.fn(() => ({ ok: true, tabs: [] })),
    open: vi.fn(async () => ({ ok: true, active_tab_id: '0123456789ab' })),
    navigate: vi.fn(async () => ({ ok: true })),
    observe: vi.fn(async () => ({ ok: true, page_id: 'page-1', untrusted_content: true })),
    act: vi.fn(async () => ({ ok: true, outcome: 'acted' })),
    wait: vi.fn(async () => ({ ok: true, condition: 'loaded' })),
    close: vi.fn(() => ({ ok: true, closed: true })),
    retain: vi.fn(() => ({ ok: true })),
    ...overrides,
  };
}

async function run(tool: ReturnType<typeof buildBrowserTool>, input: Record<string, unknown>) {
  const result = await tool.execute(input, {} as never);
  return { result, body: JSON.parse(result.content) as Record<string, unknown> };
}

describe('browser model tool', () => {
  it('publishes one closed multi-operation contract with explicit trust and safety boundaries', () => {
    const tool = buildBrowserTool(callbacks());
    expect(tool.name).toBe('browser');
    expect(tool.description).toContain('visible Browser tabs shared with the user');
    expect(tool.description).toContain('untrusted data');
    expect(tool.description).toContain('high-impact actions');
    // This is a calling/selection contract, not evidence of model execution.
    expect(tool.description).toContain('dynamic pages that web_fetch cannot render');
    expect(tool.description).toContain('smallest user action at an observed blocker');
    expect(tool.inputSchema).toMatchObject({ properties: {
      operation: { description: expect.stringContaining('At most 10 tabs per task. Prefer navigate to reuse tabs') },
      retention: { description: expect.stringContaining('deliverable/handoff also prevent capacity cleanup') },
    } });
    expect(tool.inputSchema).toMatchObject({
      type: 'object',
      required: ['operation'],
      additionalProperties: false,
      properties: {
        operation: { enum: ['tabs', 'open', 'navigate', 'observe', 'act', 'wait', 'close', 'retain'] },
        retention: { enum: ['deliverable', 'handoff', 'temporary'] },
        navigation: { enum: ['goto', 'back', 'forward', 'reload'] },
        page_action: { enum: ['click', 'fill', 'select', 'check', 'uncheck', 'scroll'] },
        timeout_ms: { minimum: 250, maximum: 15000 },
      },
    });
  });

  it('lists tabs and forwards bounded open and navigation inputs', async () => {
    const deps = callbacks();
    const tool = buildBrowserTool(deps);
    await expect(run(tool, { operation: 'tabs' })).resolves.toMatchObject({
      body: { ok: true, tabs: [] },
    });
    await run(tool, { operation: 'open', url: 'https://example.com/', label: 'Docs' });
    expect(deps.open).toHaveBeenCalledWith({ url: 'https://example.com/', label: 'Docs' });
    await run(tool, {
      operation: 'navigate',
      tab_id: '0123456789ab',
      navigation: 'goto',
      url: 'https://example.com/account',
    });
    expect(deps.navigate).toHaveBeenCalledWith({
      tabId: '0123456789ab',
      action: 'goto',
      url: 'https://example.com/account',
    });
  });

  it('rejects missing conditional inputs before a browser callback runs', async () => {
    const deps = callbacks();
    const tool = buildBrowserTool(deps);
    for (const input of [
      { operation: 'open' },
      { operation: 'open', url: `https://example.com/${'x'.repeat(2048)}` },
      { operation: 'navigate', navigation: 'goto' },
      { operation: 'act', page_action: 'click', element_ref: 'e1' },
      { operation: 'act', page_id: 'p1', page_action: 'click' },
      { operation: 'wait', wait_condition: 'text' },
      { operation: 'wait', wait_condition: 'text', text: 'x'.repeat(241) },
      { operation: 'close' },
      { operation: 'retain', retention: 'handoff' },
      { operation: 'retain', tab_id: '0123456789ab', retention: 'forever' },
    ]) {
      const { result, body } = await run(tool, input);
      expect(result.isError, JSON.stringify(input)).toBe(true);
      expect(body.ok).toBe(false);
    }
    expect(deps.open).not.toHaveBeenCalled();
    expect(deps.navigate).not.toHaveBeenCalled();
    expect(deps.act).not.toHaveBeenCalled();
    expect(deps.wait).not.toHaveBeenCalled();
    expect(deps.close).not.toHaveBeenCalled();
    expect(deps.retain).not.toHaveBeenCalled();
  });

  it('forwards fresh-snapshot actions, waits, and exact tab closes', async () => {
    const deps = callbacks();
    const tool = buildBrowserTool(deps);
    await run(tool, {
      operation: 'act',
      tab_id: '0123456789ab',
      page_id: 'page-1',
      element_ref: 'e2',
      page_action: 'fill',
      text: 'Orkas',
    });
    expect(deps.act).toHaveBeenCalledWith({
      tabId: '0123456789ab',
      pageId: 'page-1',
      elementRef: 'e2',
      action: 'fill',
      text: 'Orkas',
    });
    await run(tool, { operation: 'wait', wait_condition: 'loaded', timeout_ms: 1200 });
    expect(deps.wait).toHaveBeenCalledWith({ condition: 'loaded', timeoutMs: 1200 });
    await run(tool, { operation: 'close', tab_id: '0123456789ab' });
    expect(deps.close).toHaveBeenCalledWith('0123456789ab');
    await run(tool, { operation: 'retain', tab_id: '0123456789ab', retention: 'deliverable' });
    expect(deps.retain).toHaveBeenCalledWith('0123456789ab', 'deliverable');
    await run(tool, { operation: 'retain', tab_id: '0123456789ab', retention: 'handoff' });
    expect(deps.retain).toHaveBeenLastCalledWith('0123456789ab', 'handoff');
    await run(tool, { operation: 'retain', tab_id: '0123456789ab', retention: 'temporary' });
    expect(deps.retain).toHaveBeenLastCalledWith('0123456789ab', 'temporary');
  });

  it('marks runtime failures as tool errors without leaking thrown details', async () => {
    const tool = buildBrowserTool(callbacks({
      observe: vi.fn(async () => { throw new Error('secret provider detail'); }),
    }));
    const { result, body } = await run(tool, { operation: 'observe' });
    expect(result.isError).toBe(true);
    expect(body).toEqual({ ok: false, error: 'The task browser operation failed' });
    expect(result.content).not.toContain('secret provider detail');
  });
});
