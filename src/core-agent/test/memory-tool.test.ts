import { estimateTextTokens } from '../src/shared/token-estimate.js';
import { describe, it, expect, vi } from 'vitest';
import { SCHEMA_DESCRIPTION_SOFT_BUDGET_TOKENS, TOOL_DESCRIPTION_SOFT_BUDGET_TOKENS, toToolDefinition } from '../src/tools/base.js';
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

const dummyCtx = { state: {}, signal: new AbortController().signal };

describe('createCrossSessionMemoryTool', () => {
  it('publishes measured state effects without leaking host evidence in the receipt', async () => {
    const handler = mockHandler();
    handler.add = () => ({ ok: true, changed: false, entries: ['stable fact'], usage: { current: 11, limit: 2000 } });
    const tool = createCrossSessionMemoryTool(handler);
    const result = await tool.execute({ action: 'add', content: 'stable fact' }, { state: {} });
    expect(JSON.parse(result.content)).toMatchObject({ ok: true, changed: false });
    expect(result.content).not.toContain('stateMutation');
    expect(result.observations?.stateMutation).toMatchObject({ scope: 'agent', changed: false });
    expect(result.observations?.stateMutation?.version).toMatch(/^[a-f0-9]{64}$/);
    handler.add = () => ({ ok: true, entries: ['stable fact'], usage: { current: 11, limit: 2000 } });
    expect((await tool.execute({ action: 'add', content: 'stable fact' }, { state: {} })).observations).toBeUndefined();
  });
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

  it('keeps selection in the tool description and scope/list semantics on their parameters', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const def = toToolDefinition(createCrossSessionMemoryTool(mockHandler()));
      const properties = def.inputSchema.properties as Record<string, Record<string, unknown>>;
      expect(def.description).toContain('Manage durable agent, shared, or user memory');
      expect(def.description).toContain('Call this tool before replying whenever');
      expect(def.description).toContain('establishes, corrects, or invalidates');
      expect(def.description).toContain('stable, reusable information');
      expect(def.description).toContain('should affect future conversations');
      expect(def.description).toContain('even without an explicit save request');
      expect(def.description).toContain('Decide from meaning, never trigger words');
      expect(def.description).toContain('Do not store current-task progress');
      expect(estimateTextTokens(def.description)).toBeLessThanOrEqual(TOOL_DESCRIPTION_SOFT_BUDGET_TOKENS);
      expect(properties.target.description).toContain('Defaults to agent');
      expect(properties.target.description).toContain('shared: rare cross-project facts');
      expect(properties.target.description).toContain('user: stable user-wide profile/preferences');
      expect(properties.action.description).toContain('already injected');
      expect(properties.action.description).toContain('use list only');
      expect(properties.action.description).toContain('Omit unrelated fields');
      expect(def.inputSchema.additionalProperties).toBe(false);
      expect(def.inputSchema.oneOf).toBeUndefined();
      expect(warn).not.toHaveBeenCalled();
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

    expect(handler.add).toHaveBeenCalledWith('shared', 'new fact', dummyCtx.signal);
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
    expect(handler.add).toHaveBeenCalledWith('user', 'prefers dark mode', dummyCtx.signal);
  });

  it('defaults to the "agent" tier when target is omitted', async () => {
    const handler = mockHandler();
    const tool = createCrossSessionMemoryTool(handler);
    await tool.execute({ action: 'add', content: 'plan.json is the EDL' }, dummyCtx);
    expect(handler.add).toHaveBeenCalledWith('agent', 'plan.json is the EDL', dummyCtx.signal);
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

    expect(handler.replace).toHaveBeenCalledWith('shared', 'old', 'new', dummyCtx.signal);
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

  it('ignores write-only fields on list without writing', async () => {
    const handler = mockHandler();
    const result = await createCrossSessionMemoryTool(handler).execute(
      { action: 'list', target: 'user', content: 'unrelated' },
      dummyCtx,
    );
    expect(result.isError).toBeFalsy();
    expect(handler.list).toHaveBeenCalledWith('user');
    expect(handler.add).not.toHaveBeenCalled();
    expect(handler.replace).not.toHaveBeenCalled();
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
  it('adds project selection semantics only when includeProjectTier', () => {
    const withProject = createCrossSessionMemoryTool(mockHandler(), { includeProjectTier: true });
    expect(withProject.description).toContain('Call this tool before replying whenever');
    expect(withProject.description).toContain('even without an explicit save request');
    expect(withProject.description).toContain('Decide from meaning, never trigger words');
    expect(withProject.description).toContain('Use todo_tasks for task progress');
    expect(estimateTextTokens(withProject.description)).toBeLessThanOrEqual(TOOL_DESCRIPTION_SOFT_BUDGET_TOKENS);
    expect((withProject.inputSchema as any).properties.target.enum).toEqual(['agent', 'project', 'shared', 'user']);
    expect((withProject.inputSchema as any).properties.target.description)
      .toContain('project: project-specific facts and decisions');

    const without = createCrossSessionMemoryTool(mockHandler());
    expect((without.inputSchema as any).properties.target.enum).not.toContain('project');
    expect((without.inputSchema as any).properties.target.description).not.toContain('project:');
  });

  it('commander (read+write) can write the project tier', async () => {
    const handler = mockHandler();
    const tool = createCrossSessionMemoryTool(handler, { includeProjectTier: true });
    const result = await tool.execute({ action: 'add', target: 'project', content: 'decided X' }, dummyCtx);
    expect(result.isError).toBeFalsy();
    expect(handler.add).toHaveBeenCalledWith('project', 'decided X', dummyCtx.signal);
  });

  it('read-only sub-agent may list the project tier but not add/replace/remove', async () => {
    const handler = mockHandler();
    const tool = createCrossSessionMemoryTool(handler, { includeProjectTier: true, projectTierReadOnly: true });

    expect(tool.description).toContain('Project memory is read-only in this session; Commander can change it.');
    expect(estimateTextTokens(tool.description)).toBeLessThanOrEqual(TOOL_DESCRIPTION_SOFT_BUDGET_TOKENS);

    // The relevant target parameter tells this actor it cannot write project memory.
    expect((tool.inputSchema as any).properties.target.description).toContain('Project is read-only');
    expect(estimateTextTokens((tool.inputSchema as any).properties.target.description)).toBeLessThanOrEqual(SCHEMA_DESCRIPTION_SOFT_BUDGET_TOKENS);

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
    expect(handler.add).toHaveBeenCalledWith('agent', 'lesson', dummyCtx.signal);
  });
});

// The provider schema is advisory; malformed effective values must not reach storage.
it.each([
  { action: 'add', content: 123 },
  { action: 'add', content: 'new', old_text: 'old' },
  { action: 'replace', old_text: {}, content: 'new' },
  { action: 'remove', old_text: false },
  { action: 'add', target: '', content: 'new' },
])('rejects malformed effective memory arguments without writes: %j', async (args) => {
  const handler = mockHandler();
  const result = await createCrossSessionMemoryTool(handler).execute(args, dummyCtx);
  expect(result.isError).toBe(true);
  expect(handler.add).not.toHaveBeenCalled();
  expect(handler.replace).not.toHaveBeenCalled();
  expect(handler.remove).not.toHaveBeenCalled();
});
