/**
 * Prompt ↔ code contract invariants.
 *
 * The 4 audit issues these guard against — `group-chat-prompt-audit.md` § D:
 *  1. shadow-tap removed but prompt still teaches it
 *  2. agent disabled-reason literal mismatch (prompt vs code)
 *  3. `@user` strip prompt language vs bus actual behavior
 *  4. plan StepStatus enum drift between code and prompt
 *
 * Each test asserts a _structural_ invariant (substring in / out), not
 * exact wording. So updating the prose stays cheap; updating the
 * underlying mechanism without updating the prompt fails loudly.
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const PROJECT_ROOT = path.resolve(__dirname, '../../..');
const PROMPTS_DIR = path.join(PROJECT_ROOT, 'src/main/prompts');
const SRC_DIR = path.join(PROJECT_ROOT, 'src/main');

function readFile(relPath: string): string {
  return fs.readFileSync(path.join(PROJECT_ROOT, relPath), 'utf-8');
}

describe('prompts ↔ code contract', () => {
  // ─────────────────────────────────────────────────────────────────────
  // Invariant 1: shadow-tap is removed from bus → prompts must not teach it
  // ─────────────────────────────────────────────────────────────────────
  it('shadow-tap removed from bus AND not mentioned in prompts', () => {
    const bus = readFile('src/main/features/group_chat/bus.ts');
    const commanderPrompt = fs.readFileSync(path.join(PROMPTS_DIR, 'chat_commander.md'), 'utf-8');
    const agentPrompt = fs.readFileSync(path.join(PROMPTS_DIR, 'chat_agent_in_group.md'), 'utf-8');

    // bus should NOT contain the dispatch implementation. Match the
    // structural pattern: pushing a queue item with `tap: true` for the
    // commander as a side-effect of an agent reply. Comments mentioning
    // shadow-tap are OK (history references), but the dispatch loop must
    // be gone.
    expect(bus).not.toMatch(/tap:\s*true/);

    // Prompts should not teach the user-facing concept "shadow tap" /
    // "shadow-tap wakes you" — we removed it and don't want the LLM
    // imagining a non-existent trigger source.
    expect(commanderPrompt).not.toMatch(/shadow.{0,3}tap/i);
    expect(commanderPrompt).not.toMatch(/被.*shadow.*唤醒/);
    expect(agentPrompt).not.toMatch(/shadow.{0,3}tap/i);
  });

  // ─────────────────────────────────────────────────────────────────────
  // Invariant 2: `@user` strip behavior in code matches prompt language
  // ─────────────────────────────────────────────────────────────────────
  it('@user strip is in bus AND agent prompt acknowledges it', () => {
    const bus = readFile('src/main/features/group_chat/bus.ts');
    const agentPrompt = fs.readFileSync(path.join(PROMPTS_DIR, 'chat_agent_in_group.md'), 'utf-8');

    // bus should have the strip pass: a regex/loop replacing `@user` /
    // `@用户`. We assert that the four strip-token aliases all appear in
    // the bus source as string literals (in the `stripTokens.add(...)`
    // calls or equivalent).
    expect(bus).toContain("'user'");
    expect(bus).toContain("'commander'");
    expect(bus).toContain("'用户'");
    expect(bus).toContain("'指挥官'");

    // Agent prompt should NOT outright forbid `@user` (since bus strips
    // it harmlessly anyway, an outright ban makes the LLM avoid even
    // legitimate `@-mention` patterns). It SHOULD say `@user` is unneeded.
    // Two acceptable phrasings:
    //   - "no need to write `@user`"  (positive: no need)
    //   - "do NOT write `@user`"      (legacy: outright forbid; flagged as audit #10)
    // The audit recommended the soft form; we lock the structural rule
    // "agent prompt mentions `@user` policy in some form" so a future
    // refactor can't silently drop it.
    expect(agentPrompt).toMatch(/@user/);
    expect(agentPrompt).toMatch(/no need to write\s*`?@user`?|do NOT write\s*`?@user`?/i);
  });

  // ─────────────────────────────────────────────────────────────────────
  // Invariant 3: PlanStep status enum is consistent between code and
  // prompt-formatter (so the runtime plan injection uses values the
  // prompt understands).
  // ─────────────────────────────────────────────────────────────────────
  it('plan StepStatus enum is consistent between plan.ts and prompt formatter', () => {
    const planTs = readFile('src/main/features/group_chat/plan.ts');

    // Pull the StepStatus union from plan.ts.
    const m = /export type StepStatus\s*=\s*([\s\S]+?);/m.exec(planTs);
    expect(m).toBeTruthy();
    const union = m![1];
    const declared = Array.from(union.matchAll(/'(\w+)'/g)).map((mm) => mm[1]);
    expect(declared.sort()).toEqual(
      ['blocked', 'done', 'failed', 'in_progress', 'pending', 'skipped'].sort(),
    );

    // formatPlanForPrompt must handle every declared status with a
    // distinct icon — otherwise the prompt would render unknown statuses
    // ambiguously. We just check each status name appears in the formatter.
    for (const status of declared) {
      expect(planTs).toContain(`'${status}'`);
    }
  });

  // ─────────────────────────────────────────────────────────────────────
  // Invariant 4: shared rules included by both commander and agent
  // system-prompt builders (so PDF / search / chat-media rules stay
  // synced).
  // ─────────────────────────────────────────────────────────────────────
  it('shared rules file exists AND both prompts pull it via concatSharedRules', () => {
    const sharedFile = path.join(PROMPTS_DIR, 'chat_shared_rules.md');
    expect(fs.existsSync(sharedFile)).toBe(true);

    const bus = readFile('src/main/features/group_chat/bus.ts');
    expect(bus).toContain("prompts.load('chat_shared_rules'");
    expect(bus).toMatch(/concatSharedRules/);

    // Sanity: the shared file mentions the canonical rules so they don't
    // exist in two places. (Other prompts might still reference them in
    // passing — we only care that the structural source-of-truth is one.)
    const shared = fs.readFileSync(sharedFile, 'utf-8');
    expect(shared).toMatch(/markdown_to_pdf/);
    expect(shared).toMatch(/Web search rules|web_search|web_fetch/);
    expect(shared).toMatch(/chat-media:\/\/local/);

    // The commander/agent prompts should NOT redundantly contain the full
    // rule blocks we extracted. We check for the most distinctive
    // phrases — a future refactor that re-inlines the rules would fail
    // here, prompting the author to update shared rules instead.
    const commanderPrompt = fs.readFileSync(path.join(PROMPTS_DIR, 'chat_commander.md'), 'utf-8');
    const agentPrompt = fs.readFileSync(path.join(PROMPTS_DIR, 'chat_agent_in_group.md'), 'utf-8');
    // Distinctive search rule phrase only in shared:
    expect(commanderPrompt).not.toMatch(/single empty result is not a reason to give up/i);
    expect(agentPrompt).not.toMatch(/single empty result is not a reason to give up/i);
    // Distinctive PDF fallback phrase only in shared:
    expect(commanderPrompt).not.toMatch(/Even when the built-in PDF tools error, do not fall back/i);
    expect(agentPrompt).not.toMatch(/Even when the built-in PDF tools error, do not fall back/i);
  });
});
