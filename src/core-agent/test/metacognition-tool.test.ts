import { describe, it, expect, vi } from 'vitest';
import { toToolDefinition } from '../src/tools/base.js';
import { createMetacognitionTool, type MetacognitionToolHandler } from '../src/tools/metacognition-tool.js';

function mockHandler(): MetacognitionToolHandler {
  return {
    read: vi.fn().mockReturnValue({
      ok: true, content: '## 擅长\n- Docker', usage: { current: 20, limit: 3000 },
    }),
    write: vi.fn().mockReturnValue({
      ok: true, usage: { current: 50, limit: 3000 },
    }),
  };
}

const dummyCtx = { state: {} };

describe('createMetacognitionTool', () => {
  it('returns a well-formed AgentTool', () => {
    const tool = createMetacognitionTool(mockHandler());
    expect(tool.name).toBe('metacognition');
    expect(tool.description).toBeTruthy();
    expect(tool.inputSchema).toBeDefined();
    expect((tool.inputSchema as any).properties.action).toBeDefined();
    expect((tool.inputSchema as any).properties.target).toBeDefined();
    expect((tool.inputSchema as any).required).toEqual(['action', 'target']);
    expect((tool.inputSchema as any).additionalProperties).toBe(false);
    expect((tool.inputSchema as any).oneOf).toHaveLength(2);
    expect((tool.inputSchema as any).properties.action.description)
      .toContain('Omit unrelated fields');
  });

  it('omits the limit block when no limits are supplied', () => {
    const tool = createMetacognitionTool(mockHandler());
    expect((tool.inputSchema as any).properties.content.description).not.toContain('Maximum');
  });

  it('places target-dependent character limits on the content parameter', () => {
    const tool = createMetacognitionTool(mockHandler(), { competence: 3000, strategies: 2500 });
    const contentDescription = (tool.inputSchema as any).properties.content.description;
    expect(contentDescription).toContain('complete replacement');
    expect(contentDescription).toContain('living summary');
    expect(contentDescription).toContain('Maximum 3000 characters for competence');
    expect(contentDescription).toContain('2500 for strategies');
  });

  it('keeps selection and content constraints visible in the provider definition', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const tool = createMetacognitionTool(mockHandler(), { competence: 3000, strategies: 2500 });
      const def = toToolDefinition(tool);
      const properties = def.inputSchema.properties as Record<string, Record<string, unknown>>;
      expect(def.description).toContain('persistent competence or strategy notes');
      expect(def.description).toContain('rather than current task progress');
      expect(properties.content.description).toContain('Maximum 3000 characters for competence');
      expect(properties.content.description).toContain('2500 for strategies');
    } finally {
      warn.mockRestore();
    }
  });
});

describe('metacognition › read', () => {
  it('calls handler.read and returns content', async () => {
    const handler = mockHandler();
    const tool = createMetacognitionTool(handler);
    const result = await tool.execute(
      { action: 'read', target: 'competence' },
      dummyCtx,
    );
    expect(handler.read).toHaveBeenCalledWith('competence');
    const parsed = JSON.parse(result.content);
    expect(parsed.ok).toBe(true);
    expect(parsed.content).toContain('Docker');
    expect(result.isError).toBe(false);
  });

  it('works with strategies target', async () => {
    const handler = mockHandler();
    const tool = createMetacognitionTool(handler);
    await tool.execute({ action: 'read', target: 'strategies' }, dummyCtx);
    expect(handler.read).toHaveBeenCalledWith('strategies');
  });

  it('rejects write-only content instead of silently ignoring it', async () => {
    const handler = mockHandler();
    const result = await createMetacognitionTool(handler).execute(
      { action: 'read', target: 'strategies', content: 'unrelated' },
      dummyCtx,
    );
    expect(result).toMatchObject({ isError: true });
    expect(JSON.parse(result.content).error).toContain('not allowed for read');
    expect(handler.read).not.toHaveBeenCalled();
  });
});

describe('metacognition › write', () => {
  it('calls handler.write with content', async () => {
    const handler = mockHandler();
    const tool = createMetacognitionTool(handler);
    const result = await tool.execute(
      { action: 'write', target: 'competence', content: '## New\n- Updated' },
      dummyCtx,
    );
    expect(handler.write).toHaveBeenCalledWith('competence', '## New\n- Updated');
    expect(JSON.parse(result.content).ok).toBe(true);
    expect(result.isError).toBe(false);
  });

  it('returns error when content is empty', async () => {
    const tool = createMetacognitionTool(mockHandler());
    const result = await tool.execute(
      { action: 'write', target: 'competence', content: '  ' },
      dummyCtx,
    );
    const parsed = JSON.parse(result.content);
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toMatch(/content.*required/);
    expect(result.isError).toBe(true);
  });

  it('returns error when content is missing', async () => {
    const tool = createMetacognitionTool(mockHandler());
    const result = await tool.execute(
      { action: 'write', target: 'strategies' },
      dummyCtx,
    );
    expect(result.isError).toBe(true);
  });
});

describe('metacognition › error handling', () => {
  it('rejects invalid target', async () => {
    const tool = createMetacognitionTool(mockHandler());
    const result = await tool.execute(
      { action: 'read', target: 'invalid' },
      dummyCtx,
    );
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content).error).toMatch(/target/);
  });

  it('rejects unknown action', async () => {
    const tool = createMetacognitionTool(mockHandler());
    const result = await tool.execute(
      { action: 'delete', target: 'competence' },
      dummyCtx,
    );
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content).error).toMatch(/unknown action/);
  });

  it('propagates handler write failure', async () => {
    const handler = mockHandler();
    (handler.write as any).mockReturnValue({
      ok: false, error: 'blocked: suspicious content', usage: { current: 0, limit: 3000 },
    });
    const tool = createMetacognitionTool(handler);
    const result = await tool.execute(
      { action: 'write', target: 'competence', content: 'bad content' },
      dummyCtx,
    );
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content).error).toMatch(/blocked/);
  });
});
