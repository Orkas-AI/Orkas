import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const AGENT_PROMPT = path.join(
  __dirname,
  '..',
  '..',
  '..',
  'src',
  'main',
  'prompts',
  'chat_agent_in_group.md',
);

// Measured below 6.8K after history, dependency, path, tool-catalog, and memory procedures
// moved to their production owners and the actor-authored result markers were
// retired (host-observed execution outcomes own status). Keep the explicit
// handback decision boundary resident: model regressions show that merging it
// into a terse branch table confuses capability, recoverable-failure, and
// missing-input outcomes. Execution-time communication now has one resident
// owner in shared rules, so its removed role-local copy releases this budget.
// 2026-09-08: the memory "when to write" rule moved to the tool contract
// (single owner), releasing ~250 characters; the ceiling follows the surface.
const WHOLE_PROMPT_CEILING = 6_600;
// Destinations, hand-off, and the success claim stay resident; the durability
// decision is owned by the `cross_session_memory` description (2026-09-08).
const MEMORY_SECTION_CEILING = 560;

function section(body: string, heading: string): string {
  const start = body.indexOf(`## ${heading}`);
  expect(start, `${heading} must remain present`).toBeGreaterThanOrEqual(0);
  const end = body.indexOf('\n---', start);
  return body.slice(start, end < 0 ? body.length : end);
}

describe('group Agent resident role prompt surface', () => {
  it('stays within the post-compaction budget', () => {
    const body = fs.readFileSync(AGENT_PROMPT, 'utf8');
    expect(body.length).toBeLessThanOrEqual(WHOLE_PROMPT_CEILING);
  });

  it('rejects re-adding the removed history lookup procedure', () => {
    const body = fs.readFileSync(AGENT_PROMPT, 'utf8');
    const regrown = `${body}\nUse chat_history search only with a discriminative phrase; otherwise read page mode latest with count 10, then follow the returned before hint until the relevant record is found.`;
    expect(regrown.length).toBeGreaterThan(WHOLE_PROMPT_CEILING);
  });

  it('keeps only pre-tool memory decisions resident', () => {
    const body = fs.readFileSync(AGENT_PROMPT, 'utf8');
    const memory = section(body, 'Cross-session memory');
    expect(memory.length).toBeLessThanOrEqual(MEMORY_SECTION_CEILING);
    expect(memory).toMatch(/Use `agent` for a convention limited to this Agent/i);
    expect(memory).toMatch(/use `user` for a preference meant across Agents/i);
    expect(memory).toMatch(/choose other destinations from the tool contract/i);
    expect(memory).not.toMatch(/`target: "(?:agent|user|shared|project)"`\s*=/i);
  });

  it('rejects re-adding the removed target-selection manual', () => {
    const body = fs.readFileSync(AGENT_PROMPT, 'utf8');
    const memory = section(body, 'Cross-session memory');
    const regrown = `${memory}\n${[
      '`target: "agent"` = this Agent\'s reusable lessons and workflow corrections.',
      '`target: "user"` = stable global user profile, communication style, and preferences.',
      '`target: "shared"` = stable global non-user facts and shared conventions.',
      '`target: "project"` = project facts, decisions, outcomes, milestones, and conventions.',
    ].join('\n')}`;
    expect(regrown.length).toBeGreaterThan(MEMORY_SECTION_CEILING);
  });
});
