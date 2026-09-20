import { describe, expect, it, vi } from 'vitest';
import { createToolSurfaceController } from '../../../../src/main/model/core-agent/tool-surface';
import { TOOL_CATALOG } from '../../../../src/main/model/core-agent/tool-catalog';

import {
  buildBrowserTool,
  type BrowserToolCallbacks,
} from '../../../../src/main/features/group_chat/browser_tool';

const logger = vi.hoisted(() => ({ warn: vi.fn() }));
vi.mock('../../../../src/main/logger', () => ({ createLogger: () => logger }));

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
  it('defaults observe to full scope and passes meta through', async () => {
    const observe = vi.fn(async () => ({ ok: true, page_id: 'page-1', untrusted_content: true }));
    const tool = buildBrowserTool(callbacks({ observe }));
    await run(tool, { operation: 'observe' });
    expect(observe).toHaveBeenLastCalledWith(undefined, 'full', {});
    await run(tool, { operation: 'observe', tab_id: '0123456789ab', scope: 'meta' });
    expect(observe).toHaveBeenLastCalledWith('0123456789ab', 'meta', {});
  });

  it('passes observe offsets through and refuses ones that are not real positions', async () => {
    const observe = vi.fn(async () => ({ ok: true }));
    const tool = buildBrowserTool(callbacks({ observe }));

    await run(tool, { operation: 'observe' });
    expect(observe).toHaveBeenLastCalledWith(undefined, 'full', {});

    await run(tool, { operation: 'observe', text_offset: 6000, element_offset: 80 });
    expect(observe).toHaveBeenLastCalledWith(undefined, 'full', { textOffset: 6000, elementOffset: 80 });

    // Zero is a position; it must survive rather than read as "unset".
    await run(tool, { operation: 'observe', text_offset: 0 });
    expect(observe).toHaveBeenLastCalledWith(undefined, 'full', { textOffset: 0 });

    observe.mockClear();
    for (const key of ['text_offset', 'element_offset']) {
      for (const bad of [-1, 1.5, 'later']) {
        const { result } = await run(tool, { operation: 'observe', [key]: bad });
        expect(result.isError, `${key}=${bad}`).toBe(true);
      }
    }
    expect(observe).not.toHaveBeenCalled();
  });

  it('rejects an unknown observe scope instead of silently reading the whole page', async () => {
    const observe = vi.fn(async () => ({ ok: true }));
    const tool = buildBrowserTool(callbacks({ observe }));
    const { result, body } = await run(tool, { operation: 'observe', scope: 'summary' });
    expect(result.isError).toBe(true);
    expect(body.error).toContain('scope');
    expect(observe).not.toHaveBeenCalled();
  });

  it('loads inner_browser through the existing web group without reviving the reserved old name', async () => {
    const tool = buildBrowserTool(callbacks());
    const options = {
      availableToolNames: [tool.name],
      scopedEligible: true,
      dynamicLoadPolicy: 'agent-dependency' as const,
    };
    const surface = createToolSurfaceController(options);
    expect(surface.isActive('inner_browser')).toBe(false);
    expect(JSON.parse(surface.load(['web']).content)).toMatchObject({
      ok: true, newly_activated_tools: ['inner_browser'],
    });
    expect(surface.activeToolNames()).toEqual(['inner_browser']);
    expect(surface.isActive('browser')).toBe(false);
    expect(TOOL_CATALOG.find(entry => entry.name === 'inner_browser')?.programmatic).toBeUndefined();
    await expect(run(tool, { operation: 'tabs' })).resolves.toMatchObject({ body: { ok: true, tabs: [] } });
    expect(JSON.parse(surface.load(['web']).content).newly_activated_tools).toEqual([]);
    expect(createToolSurfaceController(options).isActive('inner_browser')).toBe(false);
  });

  it('passes the executing call signal to protected page actions', async () => {
    const deps = callbacks();
    const controller = new AbortController();
    await buildBrowserTool(deps).execute({ operation: 'act', page_id: 'page-1',
      element_ref: 'e1', page_action: 'click' }, { signal: controller.signal } as never);
    expect(deps.act).toHaveBeenCalledWith({ pageId: 'page-1', elementRef: 'e1', action: 'click' }, controller.signal);
  });

  it('publishes one closed multi-operation contract with explicit trust and safety boundaries', () => {
    const tool = buildBrowserTool(callbacks());
    expect(tool.name).toBe('inner_browser');
    expect(tool.description).toContain('visible Browser tabs shared with the user');
    expect(tool.description).toContain('untrusted data');
    expect(tool.description).toContain('high-impact actions');
    expect(tool.description).toContain('Automate non-sensitive form submissions');
    expect(tool.description).toMatch(/high-impact actions.*host approval or Trusted/);
    expect(tool.description).toMatch(/Credentials, OTP, card entry, uploads, CAPTCHA and submissions carrying secrets stay user-operated/);
    expect(tool.description).not.toContain('high-impact actions and sensitive form submissions remain user-operated');
    expect(tool.inputSchema).toMatchObject({ properties: {
      page_action: { description: expect.stringContaining('host approval or Trusted') },
    } });
    expect(tool.description).not.toContain('final submission/authorization');
    // This is a calling/selection contract, not evidence of model execution.
    expect(tool.description).toContain('dynamic pages that web_fetch cannot render');
    expect(tool.description).toContain('smallest user action at an observed blocker');
    expect(tool.inputSchema).toMatchObject({ properties: {
      operation: { description: expect.stringContaining('At most 30 tabs per task. Prefer navigate to reuse tabs') },
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
    }, undefined);
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
    logger.warn.mockClear();
    const observe = vi.fn()
      .mockRejectedValueOnce(new Error('secret provider detail /private/browser/profile'))
      .mockResolvedValue({ ok: true, page_id: 'page-recovered', untrusted_content: true });
    const tool = buildBrowserTool(callbacks({ observe }));
    const { result, body } = await run(tool, { operation: 'observe' });
    expect(result.isError).toBe(true);
    expect(body).toEqual({ ok: false, error: 'The task browser operation failed' });
    expect(result.content).not.toContain('secret provider detail');
    expect(logger.warn).toHaveBeenCalledExactlyOnceWith('browser operation failed', { operation: 'observe' });
    expect(JSON.stringify(logger.warn.mock.calls)).not.toMatch(/secret provider detail|private|profile/);
    expect(await run(tool, { operation: 'observe' })).toMatchObject({
      body: { ok: true, page_id: 'page-recovered', untrusted_content: true },
    });
    expect(observe).toHaveBeenCalledTimes(2);
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });
});
