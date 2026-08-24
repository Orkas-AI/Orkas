import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const PROMPTS_DIR = path.join(
  __dirname,
  '..',
  '..',
  '..',
  'src',
  'main',
  'prompts',
);
const COMMANDER_PROMPT = path.join(PROMPTS_DIR, 'chat_commander.md');
const PROJECT_TASK_RULES = path.join(PROMPTS_DIR, 'chat_project_tasks_rules.md');

const WHOLE_PROMPT_CEILING = 21_000;
// Review alarm, not a semantic limit: raise deliberately when a proven
// resident decision is added. The ceiling must not force system-level routing
// or recovery rules into a Skill, tool schema, or lower-priority runtime data.
const ROUTING_SECTION_CEILING = 9_500;

function readSurfaces(): { whole: string; routing: string } {
  const template = fs.readFileSync(COMMANDER_PROMPT, 'utf8');
  const projectTasksRules = fs.readFileSync(PROJECT_TASK_RULES, 'utf8').trim();
  // Budget the largest resident variant. A conditional static fragment must
  // not disappear from the review surface merely because it moved files.
  const whole = template.replace('$project_tasks_rules', projectTasksRules);
  expect(whole).not.toContain('$project_tasks_rules');
  const start = whole.indexOf('## Routing-first algorithm');
  const end = whole.indexOf('\n---\n\n## Creating or editing an agent / skill / automation', start);
  expect(start, 'routing section heading must remain present').toBeGreaterThanOrEqual(0);
  expect(end, 'resource-change section must remain after routing').toBeGreaterThan(start);
  return { whole, routing: whole.slice(start, end) };
}

describe('Commander resident prompt surface', () => {
  it('keeps the whole source prompt under its post-compaction budget', () => {
    const { whole } = readSurfaces();
    expect(
      whole.length,
      'audit growth for duplication and conditional procedures; do not move necessary resident decisions merely to satisfy this review ceiling',
    ).toBeLessThanOrEqual(WHOLE_PROMPT_CEILING);
  });

  it('keeps routing and delegation in one compact decision kernel', () => {
    const { routing } = readSurfaces();
    expect(routing.length).toBeLessThanOrEqual(ROUTING_SECTION_CEILING);
    expect(routing).not.toContain('## Dispatch tools');
    expect(routing.match(/hand_off_to\(\{ to, message, resume\? \}\)/g)).toHaveLength(1);
    expect(routing.match(/dispatch_to\(\{ to, message, resume\? \}\)/g)).toHaveLength(1);
    expect(routing.match(/run_worker\(\{ task \}\)/g)).toHaveLength(1);
  });

  it('keeps the complete route-and-recovery journey inside the resident kernel', () => {
    const { routing } = readSurfaces();

    // A compact prompt still has to take Commander from current intent through
    // ownership, execution, and recovery. Scoping these assertions to this
    // section catches clauses being moved to a lazy or lower-priority surface.
    expect(routing).toMatch(/Before choosing an owner, resolve the user's current intent/i);
    expect(routing).toMatch(/Installed agents are first-class capabilities, not expensive fallbacks/i);
    expect(routing).toMatch(/only after this owner decision, read a matching listed regular Skill/i);
    expect(routing).toMatch(/Do not read a regular Skill for work assigned to a named Agent/i);
    expect(routing).toMatch(/that Agent uses its own authorized Skill surface/i);
    expect(routing).toMatch(/default to `hand_off_to\(\{ to, message, resume\? \}\)`/i);
    expect(routing).toMatch(/one Agent owns the remaining user-visible outcome/i);
    expect(routing).toMatch(/use `dispatch_to\(\{ to, message, resume\? \}\)`/i);
    expect(routing).toMatch(/synthesis across at least two distinct results/i);
    expect(routing).toMatch(/Follow the tool schemas for lifecycle and recovery details/i);
    expect(routing).toMatch(/Calling an anonymous worker is delegation, not self-execution/i);
    expect(routing).toMatch(/Multiple independent outcomes with different high-confidence owners/i);
    expect(routing).toMatch(/Dependent outcomes[^\n]+one at a time/i);
    expect(routing).toMatch(/<blocked-on-form \.\.\.\/>/i);
    expect(routing).toMatch(/<worker-error \.\.\.>/i);
  });

  it('keeps routing decisions ordered and recovery gates single-sourced', () => {
    const { routing } = readSurfaces();
    const orderedMarkers = [
      'Before choosing an owner, resolve the user\'s current intent',
      '2. **Route after intent, before drafting.**',
      '### Delegation shapes',
      '### Sequencing and boundaries',
      '### Delegation loop discipline',
      '### Common routes',
    ];
    const positions = orderedMarkers.map((marker) => routing.indexOf(marker));

    expect(positions.every((position) => position >= 0)).toBe(true);
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
    expect(routing.match(/\*\*Commander-accessible blocker\*\*/g)).toHaveLength(1);
    expect(routing.match(/\*\*Fresh contradictory evidence\*\*/g)).toHaveLength(1);
  });

  it('would reject re-adding the removed duplicate delegation block', () => {
    const { routing } = readSurfaces();
    const duplicated = `${routing}\n\n${routing}`;
    expect(duplicated.length).toBeGreaterThan(ROUTING_SECTION_CEILING);
  });
});
