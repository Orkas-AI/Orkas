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
const SHARED_RULES = path.join(PROMPTS_DIR, 'chat_shared_rules.md');
const USER_INTENT_RULES = path.join(PROMPTS_DIR, 'chat_user_intent_rules.md');

const WHOLE_PROMPT_CEILING = 12_500;
const COMBINED_STATIC_CEILING = 21_000;
// Review alarm, not a semantic limit: raise deliberately when a proven
// resident decision is added. The ceiling must not force system-level routing
// or recovery rules into a Skill, tool schema, or lower-priority runtime data.
const ROUTING_SECTION_CEILING = 6_500;

function readSurfaces(): { whole: string; routing: string } {
  const template = fs.readFileSync(COMMANDER_PROMPT, 'utf8');
  const projectTasksRules = fs.readFileSync(PROJECT_TASK_RULES, 'utf8').trim();
  // Budget the largest resident variant. A conditional static fragment must
  // not disappear from the review surface merely because it moved files.
  const whole = template.replace('$project_tasks_rules', projectTasksRules);
  expect(whole).not.toContain('$project_tasks_rules');
  const start = whole.indexOf('## Routing-first algorithm');
  const end = whole.indexOf('\n---\n\n## Creating or editing an agent / skill', start);
  expect(start, 'routing section heading must remain present').toBeGreaterThanOrEqual(0);
  expect(end, 'resource-change section must remain after routing').toBeGreaterThan(start);
  return { whole, routing: whole.slice(start, end) };
}

describe('Commander resident prompt surface', () => {
  it('distinguishes callable connections from support without imposing setup discovery on ordinary use', () => {
    const { whole } = readSurfaces();
    const connectorRule = whole.split('### Connectors (third-party services)')[1].split('### Attachments and files')[0];
    expect(connectorRule).toContain('currently callable connections, not every supported service');
    expect(connectorRule).toContain('meta-tool schemas own discovery and invocation');
    expect(connectorRule).toContain('Do not fake unavailable connector actions');
    expect(connectorRule).toContain('explicitly requested custom configuration');
    expect(connectorRule).not.toMatch(/connector_setup|inspect|search|guide|browser/i);
  });

  it('keeps the whole source prompt under its post-compaction budget', () => {
    const { whole } = readSurfaces();
    expect(
      whole.length,
      'audit growth for duplication and conditional procedures; do not move necessary resident decisions merely to satisfy this review ceiling',
    ).toBeLessThanOrEqual(WHOLE_PROMPT_CEILING);
  });

  it('budgets the combined static resident surface instead of one template', () => {
    const { whole } = readSurfaces();
    const combined = whole
      + fs.readFileSync(SHARED_RULES, 'utf8')
      + fs.readFileSync(USER_INTENT_RULES, 'utf8');
    expect(combined.length).toBeLessThanOrEqual(COMBINED_STATIC_CEILING);
  });

  it('keeps routing and delegation in one compact decision kernel', () => {
    const { routing } = readSurfaces();
    expect(routing.length).toBeLessThanOrEqual(ROUTING_SECTION_CEILING);
    expect(routing).not.toContain('## Dispatch tools');
    expect(routing).toContain('`hand_off_to`');
    expect(routing).toContain('`dispatch_to`');
    expect(routing).toContain('`run_worker`');
    expect(routing).not.toMatch(/(?:hand_off_to|dispatch_to|run_worker)\(\{/);
  });

  it('keeps the complete route-and-recovery journey inside the resident kernel', () => {
    const { routing } = readSurfaces();

    // A compact prompt still has to take Commander from current intent through
    // ownership, execution, and recovery. Scoping these assertions to this
    // section catches clauses being moved to a lazy or lower-priority surface.
    expect(routing).toMatch(/resolve the current intent[\s\S]{0,100}before choosing an owner/i);
    expect(routing).toMatch(/light outcome[\s\S]{0,300}Complete it directly/i);
    expect(routing).toMatch(/Prefer a high-confidence enabled Agent match/i);
    expect(routing).toMatch(/Do not read a regular Skill for Agent-owned work/i);
    expect(routing).toMatch(/one Agent owns the remaining user-visible outcome/i);
    expect(routing).toMatch(/consume the result[\s\S]{0,100}synthesize at least two distinct results/i);
    expect(routing).toMatch(/owns input sufficiency and execution/i);
    expect(routing).not.toMatch(/Commander Plan|execution Plan|Use a Plan/i);
    expect(routing).toMatch(/Tool schemas own parameters and lifecycle details/i);
    expect(routing).toMatch(/bounded, self-contained, anonymous scan/i);
    expect(routing).toMatch(/independent outcomes[\s\S]{0,120}parallel `dispatch_to`/i);
    expect(routing).toMatch(/dependent outcomes one at a time/i);
    expect(routing).toMatch(/<blocked-on-form \.\.\.\/>/i);
    expect(routing).toMatch(/<worker-error \.\.\.>/i);
  });

  it('keeps routing decisions ordered and recovery gates single-sourced', () => {
    const { routing } = readSurfaces();
    const orderedMarkers = [
      'Resolve the current intent',
      '2. **Route after intent, before drafting.**',
      '### Delegation shapes',
      '### Sequencing and boundaries',
      '### Delegation loop discipline',
      '### Common routes',
    ];
    const positions = orderedMarkers.map((marker) => routing.indexOf(marker));

    expect(positions.every((position) => position >= 0)).toBe(true);
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
    expect(routing.match(/host or workspace blocker/g)).toHaveLength(1);
    expect(routing.match(/Fresh user evidence/g)).toHaveLength(1);
  });

  it('would reject re-adding the removed duplicate delegation block', () => {
    const { routing } = readSurfaces();
    const duplicated = `${routing}\n\n${routing}`;
    expect(duplicated.length).toBeGreaterThan(ROUTING_SECTION_CEILING);
  });
});
