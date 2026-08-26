import { describe, it, expect, vi } from 'vitest';
import { createCrossSessionMemoryTool, type MemoryToolHandler, type MemoryTier } from '../../../../src/core-agent/src/tools/memory-tool';

function stubHandler(): MemoryToolHandler & { calls: Array<{ op: string; tier: MemoryTier }> } {
  const calls: Array<{ op: string; tier: MemoryTier }> = [];
  const res = { ok: true, entries: [], usage: { current: 0, limit: 100 } };
  return {
    calls,
    add: vi.fn((tier: MemoryTier) => { calls.push({ op: 'add', tier }); return res; }),
    replace: vi.fn((tier: MemoryTier) => { calls.push({ op: 'replace', tier }); return res; }),
    remove: vi.fn((tier: MemoryTier) => { calls.push({ op: 'remove', tier }); return res; }),
    list: vi.fn((tier: MemoryTier) => { calls.push({ op: 'list', tier }); return res; }),
  };
}

const enumOf = (tool: ReturnType<typeof createCrossSessionMemoryTool>): string[] =>
  ((tool.inputSchema as any).properties.target.enum as string[]);

describe('cross_session_memory tool › project tier exposure', () => {
  it('non-project sessions expose three stores and keep routing in the target parameter', () => {
    const tool = createCrossSessionMemoryTool(stubHandler());
    const target = (tool.inputSchema as any).properties.target;
    const action = (tool.inputSchema as any).properties.action;
    expect(enumOf(tool)).toEqual(['agent', 'shared', 'user']);
    expect(tool.description).toContain('durable cross-session memory');
    expect(action.description).toContain('entries are already injected');
    expect(target.description).toContain('Defaults to agent');
    expect(target.description).toContain('user-wide profile/preferences');
    expect(target.description).toContain('rare cross-project facts');
  });

  it('project sessions expose four stores with project routing and exact mutation guidance', () => {
    const tool = createCrossSessionMemoryTool(stubHandler(), { includeProjectTier: true });
    const target = (tool.inputSchema as any).properties.target;
    expect(enumOf(tool)).toEqual(['agent', 'project', 'shared', 'user']);
    expect(tool.description).toContain('use project_tasks for task progress');
    expect(target.description).toContain('project-specific facts and decisions');
    expect(target.description).toContain('this agent\'s reusable lessons');
    expect((tool.inputSchema as any).properties.old_text.description).toContain('must match exactly one entry');
  });

  it('marks project memory read-only in both selection and parameter guidance', () => {
    const tool = createCrossSessionMemoryTool(stubHandler(), {
      includeProjectTier: true,
      projectTierReadOnly: true,
    });
    expect(tool.description).toContain('Project memory is read-only');
    expect((tool.inputSchema as any).properties.target.description)
      .toContain('Project is read-only');
  });

  it('project target executes against the handler only when the tier is offered', async () => {
    const withProject = stubHandler();
    const t1 = createCrossSessionMemoryTool(withProject, { includeProjectTier: true });
    const okRes = await t1.execute({ action: 'add', target: 'project', content: 'x' }, {} as any);
    expect(okRes.isError).toBeFalsy();
    expect(withProject.calls).toEqual([{ op: 'add', tier: 'project' }]);

    const without = stubHandler();
    const t2 = createCrossSessionMemoryTool(without);
    const errRes = await t2.execute({ action: 'add', target: 'project', content: 'x' }, {} as any);
    expect(errRes.isError).toBe(true);
    expect(String(errRes.content)).toContain('target must be one of');
    expect(without.calls).toEqual([]); // never reached the handler
  });

  it('default target stays "agent" in both shapes', async () => {
    const h = stubHandler();
    const tool = createCrossSessionMemoryTool(h, { includeProjectTier: true });
    await tool.execute({ action: 'list' }, {} as any);
    expect(h.calls).toEqual([{ op: 'list', tier: 'agent' }]);
  });

  it('surfaces a rejected ambiguous mutation as a tool error instead of success', async () => {
    const h = stubHandler();
    h.remove = vi.fn(() => ({
      ok: false,
      error: 'old_text is ambiguous; provide the complete unique entry text',
      entries: ['release owner is Alice', 'release cadence is weekly'],
      usage: { current: 51, limit: 100 },
    }));
    const tool = createCrossSessionMemoryTool(h, { includeProjectTier: true });
    const result = await tool.execute({ action: 'remove', target: 'project', old_text: 'release' }, {} as any);
    expect(result.isError).toBe(true);
    expect(JSON.parse(String(result.content))).toMatchObject({
      ok: false,
      error: expect.stringMatching(/ambiguous/),
      entries: ['release owner is Alice', 'release cadence is weekly'],
    });
  });
});
