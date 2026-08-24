import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { createExecutionPlanTool, toToolDefinition } from '#core-agent';

const PROJECT_ROOT = path.resolve(__dirname, '../../..');
const SHARED_PROMPT = path.join(PROJECT_ROOT, 'src/main/prompts/chat_shared_rules.md');
const RESIDENT_SURFACE_CEILING = 3_200;

function planningPolicy(body: string, expectedLineCount = 2): string {
  const lines = body.split(/\r?\n/).filter(
    (line) => line.startsWith('- Use an execution plan') || line.startsWith('- Make plan steps'),
  );
  expect(lines, 'the budget must keep measuring every resident planning-policy line')
    .toHaveLength(expectedLineCount);
  return lines.join('\n');
}

function serializedToolDefinition(): string {
  const tool = createExecutionPlanTool({
    get: () => undefined,
    update: () => { throw new Error('unused in serialization test'); },
    clear: () => undefined,
  });
  return JSON.stringify(toToolDefinition(tool));
}

function residentPlanningChars(body: string, expectedLineCount = 2): number {
  return planningPolicy(body, expectedLineCount).length + serializedToolDefinition().length;
}

describe('execution-plan resident request surface', () => {
  it('uses one general necessity rule instead of business-category heuristics', () => {
    const body = fs.readFileSync(SHARED_PROMPT, 'utf8');
    const policy = planningPolicy(body);
    expect(policy).toContain('user asks or this actor needs durable milestones');
    expect(policy).toContain('across extended execution, tool loops, compaction, or interruption');
    expect(policy).toContain('unresolved evidence');
    expect(policy).toContain('substantial phases emerge');
    expect(policy).toContain('Skip simple work or work clear in live context');
    expect(policy).toContain('tool, file, and step counts never decide');
    expect(policy).toContain('stale Plan state could mislead execution or recovery');
    expect(policy).toContain('not for routine progress');
    expect(policy).toContain('Prefer co-emitting necessary Plan changes');
    expect(policy).toContain('defer while execution is clear');
    expect(policy).toContain('standalone Plan call only when the anchor is needed');
    expect(policy).toContain('working memory, not a completion gate');
    expect(policy).toContain('after tools, reply without another Plan call');
    expect(policy).not.toMatch(/office|research|travel|content|software|spreadsheet/i);
  });

  it('keeps the model-facing policy and production tool definition within the compacted budget', () => {
    const body = fs.readFileSync(SHARED_PROMPT, 'utf8');
    expect(residentPlanningChars(body)).toBeLessThanOrEqual(RESIDENT_SURFACE_CEILING);
  });

  it('fails the budget if the resident decision policy is duplicated', () => {
    const body = fs.readFileSync(SHARED_PROMPT, 'utf8');
    const duplicated = `${body}\n${planningPolicy(body)}`;
    expect(residentPlanningChars(duplicated, 4)).toBeGreaterThan(RESIDENT_SURFACE_CEILING);
  });
});
