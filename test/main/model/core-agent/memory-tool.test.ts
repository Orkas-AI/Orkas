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
  it('non-project sessions: legacy three-tier schema, no project mention in the description', () => {
    const tool = createCrossSessionMemoryTool(stubHandler());
    expect(enumOf(tool)).toEqual(['agent', 'shared', 'user']);
    expect(tool.description).not.toContain('project:');
    expect(tool.description).toContain('repo/project conventions -> shared'); // legacy routing line intact
  });

  it('project sessions: four-tier schema and the belongs-where routing rule', () => {
    const tool = createCrossSessionMemoryTool(stubHandler(), { includeProjectTier: true });
    expect(enumOf(tool)).toEqual(['agent', 'project', 'shared', 'user']);
    expect(tool.description).toContain('project: durable facts, decisions, outcomes, milestones, and conventions that belong to THIS project only');
    expect(tool.description).toContain('would this still hold in another project?');
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
});
