import { describe, it, expect } from 'vitest';
import { TOOL_DESCRIPTION_SOFT_BUDGET_CHARS, toToolDefinition } from '../src/tools/base.js';
import { createProjectInstructionsTool, type ProjectInstructionsToolHandler } from '../src/tools/project-instructions-tool';

const ctx = {} as any;

function stubHandler(): { handler: ProjectInstructionsToolHandler; saved: string[] } {
  const saved: string[] = [];
  const handler: ProjectInstructionsToolHandler = {
    set: async (instructions) => { saved.push(instructions); return { ok: true }; },
  };
  return { handler, saved };
}

describe('project_instructions tool', () => {
  it('is a well-formed AgentTool requiring `instructions`', () => {
    const tool = createProjectInstructionsTool(stubHandler().handler);
    expect(tool.name).toBe('project_instructions');
    expect((tool.inputSchema as any).properties.instructions).toBeDefined();
    expect((tool.inputSchema as any).required).toEqual(['instructions']);
  });

  it('keeps replacement and adjacent-state selection boundaries in the right contract layers', () => {
    const def = toToolDefinition(createProjectInstructionsTool(stubHandler().handler));
    const instructions = (def.inputSchema.properties as any).instructions;
    expect(def.description.length).toBeLessThanOrEqual(TOOL_DESCRIPTION_SOFT_BUDGET_CHARS);
    expect(def.description).toContain('standing goal and rules');
    expect(def.description).toContain('project_tasks');
    expect(def.description).toContain('project memory');
    expect(instructions.description).toContain('Complete replacement');
    expect(instructions.description).toContain('existing content that still applies');
  });

  it('dispatches to handler.set with the full content', async () => {
    const { handler, saved } = stubHandler();
    const res = await createProjectInstructionsTool(handler).execute({ instructions: 'Goal: ship v1. Rule: no www.' }, ctx);
    expect(res.isError).toBeFalsy();
    expect(saved).toEqual(['Goal: ship v1. Rule: no www.']);
  });

  it('requires non-empty instructions', async () => {
    const { handler, saved } = stubHandler();
    for (const input of [{}, { instructions: '' }, { instructions: '   ' }]) {
      const res = await createProjectInstructionsTool(handler).execute(input, ctx);
      expect(res.isError).toBe(true);
      expect(JSON.parse(res.content).error).toMatch(/instructions/);
    }
    expect(saved).toEqual([]); // never reached the handler
  });

  it('propagates a handler failure', async () => {
    const handler: ProjectInstructionsToolHandler = {
      set: async () => ({ ok: false, error: 'too_long' }),
    };
    const res = await createProjectInstructionsTool(handler).execute({ instructions: 'x'.repeat(10) }, ctx);
    expect(res.isError).toBe(true);
    expect(JSON.parse(res.content).error).toBe('too_long');
  });
});
