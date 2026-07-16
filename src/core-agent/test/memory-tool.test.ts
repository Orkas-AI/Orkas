import { describe, it, expect, vi } from 'vitest';
import { toToolDefinition } from '../src/tools/base.js';
import { createCrossSessionMemoryTool, type MemoryToolHandler } from '../src/tools/memory-tool.js';

function mockHandler(): MemoryToolHandler {
  return {
    add: vi.fn().mockReturnValue({
      ok: true, entries: ['existing', 'new entry'], usage: { current: 100, limit: 2200 },
    }),
    replace: vi.fn().mockReturnValue({
      ok: true, entries: ['replaced entry'], usage: { current: 80, limit: 2200 },
    }),
    remove: vi.fn().mockReturnValue({
      ok: true, entries: ['remaining'], usage: { current: 50, limit: 2200 },
    }),
    list: vi.fn().mockReturnValue({
      ok: true, entries: ['entry1', 'entry2'], usage: { current: 60, limit: 2200 },
    }),
  };
}

const dummyCtx = { state: {} };

describe('createCrossSessionMemoryTool', () => {
  it('returns a well-formed AgentTool', () => {
    const tool = createCrossSessionMemoryTool(mockHandler());
    expect(tool.name).toBe('cross_session_memory');
    expect(tool.description).toBeTruthy();
    expect(tool.inputSchema).toBeDefined();
    expect(tool.inputSchema.type).toBe('object');
    expect((tool.inputSchema as any).properties.action).toBeDefined();
    expect((tool.inputSchema as any).properties.target).toBeDefined();
    expect((tool.inputSchema as any).properties.target.enum).toEqual(['agent', 'shared', 'user']);
    // target is optional (defaults to the caller's own "agent" store)
    expect((tool.inputSchema as any).required).toEqual(['action']);
  });

  it('keeps routing and language guardrails visible in the provider definition', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const def = toToolDefinition(createCrossSessionMemoryTool(mockHandler()));
      expect(def.description).toContain('Three scopes (default "agent")');
      expect(def.description).toContain('"agent" (DEFAULT): YOUR OWN durable agent memory');
      expect(def.description).toContain('"shared": durable facts that EVERY agent should know');
      expect(def.description).toContain('"user": the user\'s global profile/preferences');
      expect(def.description).toContain('Routing:');
      expect(def.description).toContain('LANGUAGE:');
      expect(def.description).toContain('Preserve proper nouns, commands, file paths');
    } finally {
      warn.mockRestore();
    }
  });
});

describe('cross_session_memory › add', () => {
  it('calls handler.add and returns result', async () => {
    const handler = mockHandler();
    const tool = createCrossSessionMemoryTool(handler);

    const result = await tool.execute(
      { action: 'add', target: 'shared', content: 'new fact' },
      dummyCtx,
    );

    expect(handler.add).toHaveBeenCalledWith('shared', 'new fact');
    const parsed = JSON.parse(result.content);
    expect(parsed.ok).toBe(true);
    expect(parsed.entries).toContain('new entry');
    expect(result.isError).toBe(false);
  });

  it('returns error when content is missing', async () => {
    const tool = createCrossSessionMemoryTool(mockHandler());
    const result = await tool.execute({ action: 'add', target: 'shared' }, dummyCtx);
    const parsed = JSON.parse(result.content);
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toMatch(/content.*required/);
    expect(result.isError).toBe(true);
  });

  it('works with user target', async () => {
    const handler = mockHandler();
    const tool = createCrossSessionMemoryTool(handler);
    await tool.execute(
      { action: 'add', target: 'user', content: 'prefers dark mode' },
      dummyCtx,
    );
    expect(handler.add).toHaveBeenCalledWith('user', 'prefers dark mode');
  });

  it('defaults to the "agent" tier when target is omitted', async () => {
    const handler = mockHandler();
    const tool = createCrossSessionMemoryTool(handler);
    await tool.execute({ action: 'add', content: 'plan.json is the EDL' }, dummyCtx);
    expect(handler.add).toHaveBeenCalledWith('agent', 'plan.json is the EDL');
  });
});

describe('cross_session_memory › replace', () => {
  it('calls handler.replace with old_text and content', async () => {
    const handler = mockHandler();
    const tool = createCrossSessionMemoryTool(handler);

    const result = await tool.execute(
      { action: 'replace', target: 'shared', old_text: 'old', content: 'new' },
      dummyCtx,
    );

    expect(handler.replace).toHaveBeenCalledWith('shared', 'old', 'new');
    expect(JSON.parse(result.content).ok).toBe(true);
  });

  it('returns error when old_text is missing', async () => {
    const tool = createCrossSessionMemoryTool(mockHandler());
    const result = await tool.execute(
      { action: 'replace', target: 'shared', content: 'new' },
      dummyCtx,
    );
    expect(JSON.parse(result.content).error).toMatch(/old_text.*required/);
    expect(result.isError).toBe(true);
  });

  it('returns error when content is missing', async () => {
    const tool = createCrossSessionMemoryTool(mockHandler());
    const result = await tool.execute(
      { action: 'replace', target: 'shared', old_text: 'old' },
      dummyCtx,
    );
    expect(JSON.parse(result.content).error).toMatch(/content.*required/);
    expect(result.isError).toBe(true);
  });
});

describe('cross_session_memory › remove', () => {
  it('calls handler.remove', async () => {
    const handler = mockHandler();
    const tool = createCrossSessionMemoryTool(handler);

    await tool.execute(
      { action: 'remove', target: 'shared', old_text: 'delete me' },
      dummyCtx,
    );

    expect(handler.remove).toHaveBeenCalledWith('shared', 'delete me');
  });

  it('returns error when old_text is missing', async () => {
    const tool = createCrossSessionMemoryTool(mockHandler());
    const result = await tool.execute(
      { action: 'remove', target: 'shared' },
      dummyCtx,
    );
    expect(JSON.parse(result.content).error).toMatch(/old_text.*required/);
  });
});

describe('cross_session_memory › list', () => {
  it('calls handler.list', async () => {
    const handler = mockHandler();
    const tool = createCrossSessionMemoryTool(handler);

    const result = await tool.execute(
      { action: 'list', target: 'user' },
      dummyCtx,
    );

    expect(handler.list).toHaveBeenCalledWith('user');
    const parsed = JSON.parse(result.content);
    expect(parsed.ok).toBe(true);
    expect(parsed.entries).toEqual(['entry1', 'entry2']);
  });
});

describe('cross_session_memory › error handling', () => {
  it('rejects invalid target', async () => {
    const tool = createCrossSessionMemoryTool(mockHandler());
    const result = await tool.execute(
      { action: 'list', target: 'invalid' },
      dummyCtx,
    );
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content).error).toMatch(/target/);
  });

  it('rejects unknown action', async () => {
    const tool = createCrossSessionMemoryTool(mockHandler());
    const result = await tool.execute(
      { action: 'destroy', target: 'shared' },
      dummyCtx,
    );
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content).error).toMatch(/unknown action/);
  });

  it('propagates handler failure', async () => {
    const handler = mockHandler();
    (handler.add as any).mockReturnValue({
      ok: false, error: 'blocked: suspicious content', entries: [], usage: { current: 0, limit: 2200 },
    });

    const tool = createCrossSessionMemoryTool(handler);
    const result = await tool.execute(
      { action: 'add', target: 'shared', content: 'bad stuff' },
      dummyCtx,
    );

    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content).error).toMatch(/blocked/);
  });
});

describe('cross_session_memory › project tier', () => {
  it('adds the "project" target and a routing block only when includeProjectTier', () => {
    const withProject = createCrossSessionMemoryTool(mockHandler(), { includeProjectTier: true });
    expect((withProject.inputSchema as any).properties.target.enum).toEqual(['agent', 'project', 'shared', 'user']);
    expect(withProject.description).toContain('project:');

    const without = createCrossSessionMemoryTool(mockHandler());
    expect((without.inputSchema as any).properties.target.enum).not.toContain('project');
  });

  it('commander (read+write) can write the project tier', async () => {
    const handler = mockHandler();
    const tool = createCrossSessionMemoryTool(handler, { includeProjectTier: true });
    const result = await tool.execute({ action: 'add', target: 'project', content: 'decided X' }, dummyCtx);
    expect(result.isError).toBeFalsy();
    expect(handler.add).toHaveBeenCalledWith('project', 'decided X');
  });

  it('read-only sub-agent may list the project tier but not add/replace/remove', async () => {
    const handler = mockHandler();
    const tool = createCrossSessionMemoryTool(handler, { includeProjectTier: true, projectTierReadOnly: true });

    // Description tells the model the project tier is read-only for it.
    expect(tool.description).toContain('READ-ONLY');
    expect(tool.description).toContain('already present in your system context');
    expect(tool.description).toContain('Do not list it merely to reload context');

    // list is allowed (read).
    const listed = await tool.execute({ action: 'list', target: 'project' }, dummyCtx);
    expect(listed.isError).toBeFalsy();
    expect(handler.list).toHaveBeenCalledWith('project');

    // writes are rejected before reaching the handler.
    for (const input of [
      { action: 'add', target: 'project', content: 'x' },
      { action: 'replace', target: 'project', old_text: 'a', content: 'b' },
      { action: 'remove', target: 'project', old_text: 'a' },
    ]) {
      const res = await tool.execute(input, dummyCtx);
      expect(res.isError).toBe(true);
      expect(JSON.parse(res.content).error).toMatch(/read-only/);
    }
    expect(handler.add).not.toHaveBeenCalled();
    expect(handler.replace).not.toHaveBeenCalled();
    expect(handler.remove).not.toHaveBeenCalled();

    // read-only applies to the project tier only — the agent's own tier still writes.
    const ownAdd = await tool.execute({ action: 'add', target: 'agent', content: 'lesson' }, dummyCtx);
    expect(ownAdd.isError).toBeFalsy();
    expect(handler.add).toHaveBeenCalledWith('agent', 'lesson');
  });
});
