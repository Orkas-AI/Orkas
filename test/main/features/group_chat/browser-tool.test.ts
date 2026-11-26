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
    readValue: vi.fn(async () => ({ ok: true, value: '', untrusted_content: true })),
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
  it('passes a complete long article and rejects oversized input before page mutation', async () => {
    const deps = callbacks();
    const tool = buildBrowserTool(deps);
    const action = { operation: 'act', page_id: 'page-1', element_ref: 'e1', page_action: 'fill' };
    const text = '# 中文文章\n\n```js\nconst value = "完整";\n```\n'.repeat(3000).slice(0, 100000);
    expect(text.length).toBe(100000);
    expect(tool.inputSchema).toMatchObject({ properties: { text: { maxLength: 100000 } } });
    expect((await run(tool, { ...action, text })).body.ok).toBe(true);
    expect(deps.act).toHaveBeenCalledExactlyOnceWith({
      pageId: 'page-1', elementRef: 'e1', action: 'fill', text,
    }, undefined);
    expect((await run(tool, { ...action, text: text + 'x' })).result.isError).toBe(true);
    expect(deps.act).toHaveBeenCalledTimes(1);
    expect((await run(tool, { operation: 'wait', wait_condition: 'text', text: 'x'.repeat(241) })).result.isError).toBe(true);
    expect(deps.wait).not.toHaveBeenCalled();
  });

  it('validates drag vectors before dispatch and forwards CSS pixel movement', async () => {
    const deps = callbacks();
    const tool = buildBrowserTool(deps);
    const action = { operation: 'act', page_id: 'page-1', element_ref: 'e1', page_action: 'drag' };
    for (const vector of [{}, { drag_delta_x: 20 }, { drag_delta_x: 0, drag_delta_y: 0 },
      { drag_delta_x: 4097, drag_delta_y: 0 }, { drag_delta_x: '20', drag_delta_y: 0 },
      { drag_delta_x: NaN, drag_delta_y: 0 }]) {
      expect((await run(tool, { ...action, ...vector })).result.isError).toBe(true);
    }
    expect(deps.act).not.toHaveBeenCalled();
    expect((await run(tool, { ...action, drag_delta_x: -160, drag_delta_y: 20 })).body.ok).toBe(true);
    expect(deps.act).toHaveBeenCalledWith({ pageId: 'page-1', elementRef: 'e1', action: 'drag', dragDeltaX: -160, dragDeltaY: 20 }, undefined);
  });

  it('defaults observe to full scope and passes meta through', async () => {
    const observe = vi.fn(async () => ({ ok: true, page_id: 'page-1', untrusted_content: true }));
    const tool = buildBrowserTool(callbacks({ observe }));
    await run(tool, { operation: 'observe' });
    expect(observe).toHaveBeenLastCalledWith(undefined, 'full', { tokenBudget: 10_000 }, expect.any(Function));
    await run(tool, { operation: 'observe', tab_id: '0123456789ab', scope: 'meta' });
    expect(observe).toHaveBeenLastCalledWith('0123456789ab', 'meta', {});
  });

  // A full page is sized like a read_files page: what the round has left, at
  // most the ordinary per-result ceiling. meta carries no page payload.
  it('sizes a full observation by the inline allowance the tool round has left', async () => {
    const observe = vi.fn(async () => ({ ok: true }));
    const tool = buildBrowserTool(callbacks({ observe }));
    const context = (remainingTokens: number) => ({
      state: { toolResultInlineLedger: { initialTokens: 40_000, remainingTokens, perResultTokens: 10_000 } },
    }) as never;
    await tool.execute({ operation: 'observe' }, context(2_500));
    expect(observe).toHaveBeenLastCalledWith(undefined, 'full', { tokenBudget: 2_500 }, expect.any(Function));
    await tool.execute({ operation: 'observe' }, context(40_000));
    expect(observe).toHaveBeenLastCalledWith(undefined, 'full', { tokenBudget: 10_000 }, expect.any(Function));
    await tool.execute({ operation: 'observe', scope: 'meta' }, context(2_500));
    expect(observe).toHaveBeenLastCalledWith(undefined, 'meta', {});
  });

  it('keeps page refs and exact text continuation inline when argument feedback fills the boundary', async () => {
    const { fitWebAssistObservation } = await import('../../../../src/main/features/web_assist');
    const { estimateToolResultTokens } = await import('../../../../src/main/util/tool-result-cap');
    const { appendInputReceipt } = require('../../../../bin/tool-input-compat.cjs');
    const inputReceipt = { ignored_fields: Array.from({ length: 10 }, (_, i) => `${i}${'x'.repeat(79)}`) };
    const raw = { ok: true, page_id: 'page-1', text: '界'.repeat(6000), text_offset: 0,
      elements: Array.from({ length: 80 }, (_, i) => ({ ref: `e${i}`, tag: 'button', label: '格'.repeat(40) })) };
    const tool = buildBrowserTool(callbacks({ observe: vi.fn(async (_tab, _scope, window) =>
      fitWebAssistObservation(raw, window!.tokenBudget!)) }));
    const result = await tool.execute({ operation: 'observe' }, { inputReceipt,
      state: { toolResultInlineLedger: { initialTokens: 10_000, remainingTokens: 10_000, perResultTokens: 10_000 } } });
    const delivered = result.appliedInputReceipt === inputReceipt ? result.content : appendInputReceipt(result.content, inputReceipt);
    expect(estimateToolResultTokens(delivered)).toBeLessThanOrEqual(10_000);
    const body = JSON.parse(delivered);
    expect(body.elements).toHaveLength(80);
    expect(body.ignored_fields).toEqual(inputReceipt.ignored_fields);
    expect(body.text_next_offset).toBe(body.text.length);
    expect(body.text_next_offset).toBeGreaterThan(0);
    expect(body.text_next_offset).toBeLessThan(raw.text.length);
  });

  it('passes observe offsets through and refuses ones that are not real positions', async () => {
    const observe = vi.fn(async () => ({ ok: true }));
    const tool = buildBrowserTool(callbacks({ observe }));

    await run(tool, { operation: 'observe' });
    expect(observe).toHaveBeenLastCalledWith(undefined, 'full', { tokenBudget: 10_000 }, expect.any(Function));

    await run(tool, { operation: 'observe', text_offset: 6000, element_offset: 80 });
    expect(observe).toHaveBeenLastCalledWith(undefined, 'full', { textOffset: 6000, elementOffset: 80, tokenBudget: 10_000 }, expect.any(Function));

    // Zero is a position; it must survive rather than read as "unset".
    await run(tool, { operation: 'observe', text_offset: 0 });
    expect(observe).toHaveBeenLastCalledWith(undefined, 'full', { textOffset: 0, tokenBudget: 10_000 }, expect.any(Function));

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

  it.each(['act', 'wait'] as const)('passes the executing call signal to %s', async operation => {
    const deps = callbacks();
    const controller = new AbortController();
    await buildBrowserTool(deps).execute({ operation, page_id: 'page-1',
      element_ref: 'e1', page_action: 'click' }, { signal: controller.signal } as never);
    if (operation === 'act') expect(deps.act).toHaveBeenCalledWith({ pageId: 'page-1', elementRef: 'e1', action: 'click' }, controller.signal);
    else expect(deps.wait).toHaveBeenCalledWith({ condition: 'loaded' }, controller.signal, expect.any(Function));
  });

  it('publishes one closed multi-operation contract with explicit trust and safety boundaries', () => {
    const tool = buildBrowserTool(callbacks());
    expect(tool.name).toBe('inner_browser');
    expect(tool.description).toContain('task Browser tabs shared with user');
    expect(tool.description).toContain('untrusted data');
    expect(tool.description).toContain('sensitive values are never returned');
    expect(tool.description).toContain('no browser count/size quotas');
    expect(tool.description).not.toContain('stay user-operated');
    expect(JSON.stringify(tool.inputSchema)).not.toContain('choose_files grants external paths');
    expect(tool.inputSchema).toMatchObject({
      type: 'object',
      required: ['operation'],
      additionalProperties: false,
      properties: {
        operation: { enum: ['tabs', 'open', 'navigate', 'observe', 'read_value', 'options', 'screenshot', 'choose_files', 'act', 'wait', 'close', 'retain'] },
        retention: { enum: ['deliverable', 'handoff', 'temporary'] },
        navigation: { enum: ['goto', 'back', 'forward', 'reload'] },
        page_action: { enum: ['click', 'fill', 'select', 'check', 'uncheck', 'scroll', 'drag', 'upload', 'press', 'hover', 'double_click', 'right_click'] },
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

  it.each(['temporary', 'deliverable', 'handoff'] as const)('preserves the explicit %s policy on open', async retention => {
    const deps = callbacks();
    const { body } = await run(buildBrowserTool(deps), { operation: 'open', url: 'https://example.com/', retention });
    expect(body.ok).toBe(true);
    expect(deps.open).toHaveBeenCalledExactlyOnceWith({ url: 'https://example.com/', retention });
    expect(deps.retain).not.toHaveBeenCalled();
  });

  it.each([
    ['tab_id', ['bad', '0123456789AB', '0123456789abc'], { operation: 'observe' }, 'must contain exactly 12 lowercase hexadecimal characters'],
    ['element_ref', ['bad', 'e0', 'e01'], { operation: 'act', page_id: 'page-1', page_action: 'click' }, 'must be "e" followed by a positive integer without leading zeros'],
  ] as const)('reports the %s format before dispatch', async (field, values, input, message) => {
    const deps = callbacks();
    const tool = buildBrowserTool(deps);
    for (const value of values) {
      const { result, body } = await run(tool, { ...input, [field]: value });
      expect(result.isError).toBe(true);
      expect(body).toEqual({ ok: false, error: `${field}: ${message}` });
    }
    for (const callback of Object.values(deps)) expect(callback).not.toHaveBeenCalled();
  });

  it('rejects missing conditional inputs before a browser callback runs', async () => {
    const deps = callbacks();
    const tool = buildBrowserTool(deps);
    for (const input of [
      { operation: 'read_value' },
      { operation: 'read_value', page_id: 'p1' },
      { operation: 'read_value', page_id: 'p1', element_ref: 'e1', text_offset: -1 },
      { operation: 'act', page_id: 'p1', element_ref: 'e1', page_action: 'upload' },
      { operation: 'open' },
      { operation: 'open', url: 'https://example.com/', retention: 'forever' },
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
    expect(deps.readValue).not.toHaveBeenCalled();
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
    expect(deps.wait).toHaveBeenCalledWith({ condition: 'loaded', timeoutMs: 1200 }, undefined, expect.any(Function));
    await run(tool, { operation: 'close', tab_id: '0123456789ab' });
    expect(deps.close).toHaveBeenCalledWith('0123456789ab');
    await run(tool, { operation: 'retain', tab_id: '0123456789ab', retention: 'deliverable' });
    expect(deps.retain).toHaveBeenCalledWith('0123456789ab', 'deliverable');
    await run(tool, { operation: 'retain', tab_id: '0123456789ab', retention: 'handoff' });
    expect(deps.retain).toHaveBeenLastCalledWith('0123456789ab', 'handoff');
    await run(tool, { operation: 'retain', tab_id: '0123456789ab', retention: 'temporary' });
    expect(deps.retain).toHaveBeenLastCalledWith('0123456789ab', 'temporary');
  });

  it('uses the ordinary browser wait default for out-of-range integers and rejects malformed waits', async () => {
    const deps = callbacks();
    const tool = buildBrowserTool(deps);
    for (const timeout_ms of [-1, 0, 249, 15001, 60000]) {
      expect((await run(tool, { operation: 'wait', timeout_ms })).result.isError).toBeFalsy();
    }
    expect(deps.wait.mock.calls).toEqual(Array.from({ length: 5 }, () => [{ condition: 'loaded' }, undefined, expect.any(Function)]));
    for (const timeout_ms of [1.5, '1000', null]) {
      expect((await run(tool, { operation: 'wait', timeout_ms })).result.isError).toBe(true);
    }
    expect(deps.wait).toHaveBeenCalledTimes(5);
  });

  it('reads one field window and forwards explicit upload files', async () => {
    const deps = callbacks();
    const tool = buildBrowserTool(deps);
    await run(tool, { operation: 'read_value', page_id: 'p1', element_ref: 'e2', text_offset: 6000 });
    expect(deps.readValue).toHaveBeenCalledWith({ pageId: 'p1', elementRef: 'e2', textOffset: 6000 }, undefined);
    await run(tool, { operation: 'act', page_id: 'p1', element_ref: 'e3', page_action: 'upload', file_paths: ['/workspace/logo.webp'] });
    expect(deps.act).toHaveBeenCalledWith({ pageId: 'p1', elementRef: 'e3', action: 'upload', filePaths: ['/workspace/logo.webp'] }, undefined);
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

it('forwards screenshot clips and coordinate input without accepting conflicting targets', async () => {
  const screenshot = vi.fn(async () => ({ content: '{"ok":true}', images: [{ data: 'png', mediaType: 'image/png' as const }] }));
  const deps = callbacks({ screenshot }); const tool = buildBrowserTool(deps);
  const input = { operation: 'act', page_id: 'shot-1', page_action: 'click', point: [24.5, 60] };
  expect((await run(tool, input)).body.ok).toBe(true);
  expect(deps.act).toHaveBeenCalledExactlyOnceWith({ pageId: 'shot-1', action: 'click', point: [24.5, 60] }, undefined);
  for (const extras of [{ element_ref: 'e1' }, { page_action: 'fill', text: 'x' }, { point: [1] }, { point: [-1, 3] }, { point: [1, Infinity] }]) {
    expect((await run(tool, { ...input, ...extras })).result.isError).toBe(true);
  }
  expect(deps.act).toHaveBeenCalledTimes(1);
  const result = await tool.execute({ operation: 'screenshot', clip: [10, 20, 300, 200] }, {} as never);
  expect(screenshot).toHaveBeenCalledExactlyOnceWith({ clip: [10, 20, 300, 200] }, undefined);
  expect(result.images).toEqual([{ data: 'png', mediaType: 'image/png' }]);
});
