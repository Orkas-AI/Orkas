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
  });

  it('omits the limit block when no limits are supplied', () => {
    const tool = createMetacognitionTool(mockHandler());
    expect(tool.description).not.toMatch(/Limits \(oversize writes are rejected\)/);
  });

  it('embeds char limits in description when supplied', () => {
    const tool = createMetacognitionTool(mockHandler(), { competence: 3000, strategies: 2500 });
    expect(tool.description).toMatch(/CONTENT LIMITS \(oversize writes are rejected\)/);
    expect(tool.description).toMatch(/competence: 3000 characters/);
    expect(tool.description).toMatch(/strategies: 2500 characters/);
    expect(tool.description).toMatch(/CONDENSE these files into living summaries/);
  });

  it('keeps language and content-limit guardrails visible in the provider definition', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const tool = createMetacognitionTool(mockHandler(), { competence: 3000, strategies: 2500 });
      const def = toToolDefinition(tool);
      expect(def.description).toContain('Use the user\'s current language');
      expect(def.description).toContain('preserve code, paths, commands, and quoted wording');
      expect(def.description).toContain('CONTENT LIMITS');
      expect(def.description).toContain('competence: 3000 characters');
      expect(def.description).toContain('strategies: 2500 characters');
      expect(def.description).toContain('REJECTED');
      expect(def.description).toContain('CONDENSE');
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
