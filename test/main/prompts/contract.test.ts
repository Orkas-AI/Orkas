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

  it('agent authoring and execution prompts distinguish skills from tools', () => {
    const agentPrompt = fs.readFileSync(path.join(PROMPTS_DIR, 'chat_agent_in_group.md'), 'utf-8');

    expect(agentPrompt).toContain('Skills are not tools');
    expect(agentPrompt).toContain('do NOT attempt a tool call with the skill');
  });

  it('agent profile standards are runtime handoff criteria, not display-only metadata', () => {
    const bus = readFile('src/main/features/group_chat/bus.ts');
    const agentPrompt = fs.readFileSync(path.join(PROMPTS_DIR, 'chat_agent_in_group.md'), 'utf-8');
    const commanderPrompt = fs.readFileSync(path.join(PROMPTS_DIR, 'chat_commander.md'), 'utf-8');
    const creatorSkill = readFile('resources/builtin/system/skills/agent-creator/SKILL.md');

    expect(bus).toContain('buildAgentRuntimeGuidance');
    expect(bus).toContain('extractActorResultFromFinal');
    expect(bus).toContain('### Delivery standards');
    expect(bus).toContain('Mandatory handoff criteria');
    expect(bus).toContain('Before your final reply, silently compare the result against every item');
    expect(agentPrompt).toContain('`### Delivery standards` block');
    expect(agentPrompt).toContain('mandatory handoff criteria');
    expect(agentPrompt).toContain('silently check the result against every listed standard');
    expect(agentPrompt).toContain('`### Agent strengths` block');
    expect(agentPrompt).toContain('<agent-result status="success" />');
    expect(agentPrompt).toContain('<agent-result status="failure" />');
    expect(commanderPrompt).toContain('<commander-result status="success" />');
    expect(commanderPrompt).toContain('<commander-result status="failure" />');
    expect(agentPrompt).not.toContain('capability_context');
    expect(bus).not.toContain('src.memory');
    expect(bus).not.toContain('agent_memory');
    expect(creatorSkill).toContain('runtime guidance fields');
    expect(creatorSkill).toContain('definition of done');
    expect(creatorSkill).toContain('Do not emit JSON here');
  });

  it('cross-session memory scopes are routed explicitly and written in the UI language', () => {
    const agentPrompt = fs.readFileSync(path.join(PROMPTS_DIR, 'chat_agent_in_group.md'), 'utf-8');
    const commanderPrompt = fs.readFileSync(path.join(PROMPTS_DIR, 'chat_commander.md'), 'utf-8');
    const sharedPrompt = fs.readFileSync(path.join(PROMPTS_DIR, 'chat_shared_rules.md'), 'utf-8');
    const memoryTool = readFile('src/core-agent/src/tools/memory-tool.ts');

    // Tool description ships in two shapes: the legacy three-tier one and the
    // project-session one that adds the `project` tier plus the belongs-where
    // routing rule ("would this still hold in another project?").
    expect(memoryTool).toContain("- agent (default): this agent's private lessons");
    expect(memoryTool).toContain('- shared: stable facts that hold across projects and matter to every agent');
    expect(memoryTool).toContain('- user: stable user-wide profile/preferences every agent should know');
    expect(memoryTool).toContain('- project: durable facts, decisions, outcomes, milestones, and conventions that belong to THIS project only');
    expect(memoryTool).toContain('Live progress and todo status belong in project_tasks');
    expect(memoryTool).toContain('would this still hold in another project?');
    // The project tier is schema-gated: offered only when the host marks the
    // session as belonging to a project.
    expect(memoryTool).toContain('includeProjectTier');
    // Language rule: write in the user's current language, preserving literals.
    expect(memoryTool).toContain("Write in the user's current language while preserving code, paths, commands, URLs");

    expect(agentPrompt).toContain('`target: "agent"` = your own agent memory');
    expect(agentPrompt).toContain('`target: "user"` = global user profile/preferences');
    expect(agentPrompt).toContain('`target: "shared"` = global facts');
    expect(agentPrompt).not.toContain('current response/UI language');

    expect(commanderPrompt).toContain('`target: "agent"` = commander\'s own orchestration memory');
    expect(commanderPrompt).toContain('commander-specific routing lessons');
    expect(commanderPrompt).not.toContain('current response/UI language');
    expect(sharedPrompt).toContain('current response/UI language');
    expect(sharedPrompt).toContain('Preserve proper nouns, commands, file paths, code identifiers, URLs');
    expect(readFile('src/main/features/group_chat/bus.ts')).toContain("prompts.load('chat_shared_rules'");
  });

  it('group-chat system prompts inject the current User UI language directive', () => {
    const bus = readFile('src/main/features/group_chat/bus.ts');
    const i18n = readFile('src/main/i18n.ts');

    expect(i18n).toContain('User UI language: **${name}**');
    expect(i18n).toContain('Write all human-readable prose in ${name}');
    expect(bus).toContain('appendLanguageDirective');
    expect(bus).toContain('buildLanguageDirective(getLanguage())');
    expect(bus).toContain('chat_commander');
    expect(bus).toContain('chat_agent_in_group');
  });

  it('agent runtime prompt includes localized descriptions, not only legacy description', () => {
    const bus = readFile('src/main/features/group_chat/bus.ts');

    expect(bus).toContain('pickAgentRuntimeDescription');
    expect(bus).toContain('description_zh?: string');
    expect(bus).toContain('description_en?: string');
    expect(bus).toMatch(/description:\s*pickAgentRuntimeDescription\(agent\)/);
    expect(bus).toMatch(/descriptionLang\(getLanguage\(\)\).*=== 'zh'/s);
  });

  it('authoring prompt shells leave category field rules to creator skills', () => {
    const authoringPrompts = [
      'chat_commander.md',
      'chat_agent_setup.md',
      'chat_agent_setup_cli.md',
      'chat_skill_setup.md',
    ].map((name) => fs.readFileSync(path.join(PROMPTS_DIR, name), 'utf-8'));
    for (const prompt of authoringPrompts) {
      expect(prompt).not.toContain('Required category');
      expect(prompt).not.toContain('$category_field_definition');
      expect(prompt).not.toMatch(/education.*ecommerce.*rnd.*writing.*data.*general/s);
    }
  });

  it('commander prompt anchors create-agent requests to prior concrete content', () => {
    const commanderPrompt = fs.readFileSync(path.join(PROMPTS_DIR, 'chat_commander.md'), 'utf-8');

    expect(commanderPrompt).toContain('ground the agent in the concrete prior content before the current request');
    expect(commanderPrompt).toContain('not in the act of creating agents');
    expect(commanderPrompt).toContain('ask one concise clarification');
  });

  it('commander prompt reads attachments before creating agents or skills from them', () => {
    const commanderPrompt = fs.readFileSync(path.join(PROMPTS_DIR, 'chat_commander.md'), 'utf-8');

    expect(commanderPrompt).toMatch(/create an agent or skill from uploaded attachments/i);
    expect(commanderPrompt).toMatch(/read the relevant attachment contents/i);
    expect(commanderPrompt).toContain('agent-creator');
    expect(commanderPrompt).toContain('skill-creator');
  });

  it('skill edit prompt completes imported-file skills without proactive clarification', () => {
    const skillPrompt = fs.readFileSync(path.join(PROMPTS_DIR, 'chat_skill_setup.md'), 'utf-8');

    expect(skillPrompt).toContain('treat those files as source material and complete the skill from them directly');
    expect(skillPrompt).toContain('Make the first emitted source skill become this current draft skill');
    expect(skillPrompt).toContain('If imported docs, references, scripts, or examples are present, inspect them and write the best skill you can without asking for confirmation');
  });

  it('commander prompt routes automation CRUD through autotask-creator', () => {
    const commanderPrompt = fs.readFileSync(path.join(PROMPTS_DIR, 'chat_commander.md'), 'utf-8');

    expect(commanderPrompt).toContain('autotask-creator');
    expect(commanderPrompt).toContain('<auto-task>');
    expect(commanderPrompt).toContain('auto_tasks_list');
  });

  it('commander prompt uses routing-first quality priority before direct self-service', () => {
    const commanderPrompt = fs.readFileSync(path.join(PROMPTS_DIR, 'chat_commander.md'), 'utf-8');

    // Cost-saving must be a tie-breaker, not the routing objective. Installed
    // agents are product capabilities; direct commander work is the fallback
    // after capability routing.
    expect(commanderPrompt).toMatch(/Routing-first algorithm/i);
    expect(commanderPrompt).toMatch(/Quality, correctness, and task completion come first/i);
    expect(commanderPrompt).toMatch(/Cost, latency, and coordination overhead are tie-breakers/i);
    expect(commanderPrompt).toMatch(/Do not start from "can I do this myself\?"/i);
    expect(commanderPrompt).toMatch(/best owner for each user-visible outcome/i);
    expect(commanderPrompt).toMatch(/installed agents are first-class capabilities/i);
    expect(commanderPrompt).toMatch(/not expensive fallbacks/i);
    expect(commanderPrompt).toMatch(/Direct commander self-service[\s\S]+only after the current agent pool has no stronger owner/i);
    expect(commanderPrompt).toMatch(/builtin > platform > custom > external > global/i);
    expect(commanderPrompt).toMatch(/builtin > platform > custom/i);
    expect(commanderPrompt).toMatch(/learning diagnosis/i);
  });

  it('commander prompt fans out multi-outcome specialist bundles before direct drafting', () => {
    const commanderPrompt = fs.readFileSync(path.join(PROMPTS_DIR, 'chat_commander.md'), 'utf-8');

    // A normal user request for distinct materials can map to several specialist
    // agents; multi-agent routing is triggered by outcome diversity, not just
    // task size.
    expect(commanderPrompt).toMatch(/Keep outcomes separate/i);
    expect(commanderPrompt).toMatch(/Multiple independent outcomes with different high-confidence owners/i);
    expect(commanderPrompt).toMatch(/named `run_worker\(\{ to, task \}\)`/i);
    expect(commanderPrompt).toMatch(/SINGLE response/i);
    expect(commanderPrompt).toMatch(/run concurrently/i);
    expect(commanderPrompt).toMatch(/outcome diversity, not just task size/i);
    expect(commanderPrompt).toMatch(/Do not collapse these into one direct response/i);
    expect(commanderPrompt).toMatch(/research\/framework \+ tutoring\/diagnostic questions \+ parent\/user-facing copy/i);
  });

  it('commander prompt covers both dependent-serial and independent-parallel delegation', () => {
    const commanderPrompt = fs.readFileSync(path.join(PROMPTS_DIR, 'chat_commander.md'), 'utf-8');

    // Dependent chains: one step at a time, deciding the next from the last.
    expect(commanderPrompt).toMatch(/one at a time/i);
    expect(commanderPrompt).toMatch(/decide and run the next/i);
    // Independent sub-tasks fan out by emitting all run_worker calls in a single
    // response so they run concurrently (G4 partitioner; the executionMode fix
    // makes plain run_worker actually parallelize).
    expect(commanderPrompt).toMatch(/single response/i);
    expect(commanderPrompt).toMatch(/concurrently/i);
    // Decoupling is the delegation gate: only cleanly-separable work is delegated;
    // tightly-coupled work stays inline.
    expect(commanderPrompt).toMatch(/cleanly separable/i);
    expect(commanderPrompt).toMatch(/coupled/i);
    // Plan-DAG concepts must not creep back into the in-loop model.
    expect(commanderPrompt).not.toContain('parallel_group');
  });

  it('anonymous workers remain isolated helpers rather than commander or unavailable-agent substitutes', () => {
    const commanderPrompt = fs.readFileSync(path.join(PROMPTS_DIR, 'chat_commander.md'), 'utf-8');
    const bus = readFile('src/main/features/group_chat/bus.ts');

    expect(commanderPrompt).toMatch(/Calling an anonymous worker is delegation, not self-execution/i);
    expect(commanderPrompt).toMatch(/does not inherit your skills or evolving context/i);
    expect(commanderPrompt).toMatch(/user explicitly requires you to do the work yourself/i);
    expect(commanderPrompt).toMatch(/fallback for an unavailable agent/i);
    expect(commanderPrompt).toMatch(/coupled milestone chain/i);

    expect(bus).toMatch(/ONE isolated auxiliary sub-task/);
    expect(bus).toMatch(/separate helper, not the commander itself/i);
    expect(bus).toMatch(/stop without changing files and return a concise scope-mismatch result/i);
    expect(bus).toMatch(/complete result for this delegated sub-task/i);
    expect(bus).toMatch(/explicit boundary and expected result/i);
    expect(bus).not.toMatch(/your own hands|commander(?:\\'|')s hands/i);
  });

  it('commander prompt makes hand_off_to the default for a single deliverable, dispatch_to the next-action exception', () => {
    const commanderPrompt = fs.readFileSync(path.join(PROMPTS_DIR, 'chat_commander.md'), 'utf-8');

    // hand_off_to is taught as a distinct tool that ends the turn without re-summary.
    expect(commanderPrompt).toMatch(/hand_off_to\(\{ to, message, resume\? \}\)/);
    expect(commanderPrompt).toMatch(/no re-summary|stop after the narration/i);
    // dispatch_to is scoped by a PROCEDURAL test: it commits the commander to a
    // concrete NEXT action in the same turn (another dispatch / tool call /
    // multi-result synthesis) — NOT to present/bless a reply that already stands.
    expect(commanderPrompt).toMatch(/commits you to a concrete NEXT action|another dispatch, a tool call, or a synthesis/i);
    // hand_off_to is the DEFAULT for a single agent's finished deliverable.
    expect(commanderPrompt).toMatch(/default for a single agent's finished deliverable/i);
    // The decision is a pre-dispatch procedural litmus: name the next action; if
    // there is none (only deliver/restate the reply) → hand_off.
    expect(commanderPrompt).toMatch(/Name that next action before you dispatch/i);
    expect(commanderPrompt).toMatch(/redundant re-summary to avoid/i);
    // The teach/coach/guide-with-me case must point at hand_off, not dispatch.
    expect(commanderPrompt).toMatch(/teach|coach|guide|walk me through/i);
    expect(commanderPrompt).toMatch(/blocking part of a broader commander-owned task/i);
    expect(commanderPrompt).toMatch(/A good `resume` says exactly what remains/i);
  });

  it('commander prompt separates conversation floor from suspended orchestration resume', () => {
    const commanderPrompt = fs.readFileSync(path.join(PROMPTS_DIR, 'chat_commander.md'), 'utf-8');

    expect(commanderPrompt).toMatch(/Orchestration state/i);
    expect(commanderPrompt).toMatch(/active_recipient[\s\S]+conversation floor/i);
    expect(commanderPrompt).toMatch(/orchestration_ledger[\s\S]+suspended task/i);
    expect(commanderPrompt).toMatch(/agent handoff or on an agent form/i);
    expect(commanderPrompt).toMatch(/\$orchestration_state/);
    expect(commanderPrompt).toMatch(/<orchestration-resume>/);
    expect(commanderPrompt).toMatch(/Do not re-ask for information already supplied by the agent or form/i);
    expect(commanderPrompt).toMatch(/ledger status is `interrupted`/i);
    expect(commanderPrompt).toMatch(/User-input blocking outcome inside a broader task/i);
    expect(commanderPrompt).toMatch(/<blocked-on-form/i);
    expect(commanderPrompt).toMatch(/do not keep routing dependent work/i);
  });

  it('agent prompt teaches <handback /> to return the floor when done / out of scope', () => {
    const agentPrompt = fs.readFileSync(path.join(PROMPTS_DIR, 'chat_agent_in_group.md'), 'utf-8');

    expect(agentPrompt).toMatch(/<handback \/>/);
    expect(agentPrompt).toMatch(/handed off to you/i);
    expect(agentPrompt).toMatch(/outside your scope|complete/i);
    // Must warn against emitting it on an ordinary one-shot reply.
    expect(agentPrompt).toMatch(/one-shot reply/i);
    expect(agentPrompt).toMatch(/concrete result the commander needs to continue/i);
  });

  it('commander prompt blocks fabricated inputs while keeping milestone plans adaptive', () => {
    const commanderPrompt = fs.readFileSync(path.join(PROMPTS_DIR, 'chat_commander.md'), 'utf-8');

    expect(commanderPrompt).toMatch(/required inputs, files, context, or user decisions/i);
    expect(commanderPrompt).toMatch(/must not be fabricated/i);
    // Long-running work may keep a durable milestone plan, but dependent dispatches
    // must still adapt to the actual result of the preceding step.
    expect(commanderPrompt).toMatch(/milestone plan may preserve the goal\/progress/i);
    expect(commanderPrompt).toMatch(/not a rigid dispatch schedule/i);
    expect(commanderPrompt).toMatch(/revise the next step from what the previous result returned/i);
  });

  it('agent prompt keeps generated input forms minimal', () => {
    const agentPrompt = fs.readFileSync(path.join(PROMPTS_DIR, 'chat_agent_in_group.md'), 'utf-8');

    expect(agentPrompt).toMatch(/Keep forms minimal/i);
    expect(agentPrompt).toMatch(/ask at most 2-3 focused questions per turn/i);
    expect(agentPrompt).toMatch(/prefer a plain question/i);
    expect(agentPrompt).toMatch(/multiple fields only when distinct typed values are truly required/i);
    expect(agentPrompt).toMatch(/ask the next 2-3 focused questions/i);
  });

  it('agent prompt checks information sufficiency before final answers', () => {
    const agentPrompt = fs.readFileSync(path.join(PROMPTS_DIR, 'chat_agent_in_group.md'), 'utf-8');

    expect(agentPrompt).toMatch(/Information sufficiency/i);
    expect(agentPrompt).toMatch(/Before producing a final answer/i);
    expect(agentPrompt).toMatch(/missing user-specific context, constraints, examples\/files, goals, or decisions/i);
    expect(agentPrompt).toMatch(/do not fill gaps with generic assumptions/i);
    expect(agentPrompt).toMatch(/smallest useful missing set/i);
    expect(agentPrompt).toMatch(/<agent-input-form>/i);
    expect(agentPrompt).toMatch(/fixed execution rule for every inbound task/i);
    expect(agentPrompt).toMatch(/does not depend on the commander mentioning missing information/i);
    expect(agentPrompt).toMatch(/Do not replace a form with a "need these details" section/i);
    expect(agentPrompt).toMatch(/quick assumption-based answer/i);
  });

  it('agent authoring prompts keep created agent inputs sparse', () => {
    const setupPrompt = fs.readFileSync(path.join(PROMPTS_DIR, 'chat_agent_setup.md'), 'utf-8');
    const cliSetupPrompt = fs.readFileSync(path.join(PROMPTS_DIR, 'chat_agent_setup_cli.md'), 'utf-8');
    const creatorSkill = readFile('resources/builtin/system/skills/agent-creator/SKILL.md');

    expect(setupPrompt).not.toMatch(/Keep inputs sparse/i);
    expect(creatorSkill).toMatch(/Keep inputs sparse/i);
    expect(creatorSkill).toMatch(/Prefer zero inputs/i);
    expect(creatorSkill).toMatch(/one required task \/ material field/i);
    expect(cliSetupPrompt).toMatch(/zero\/few inputs/i);
    expect(cliSetupPrompt).toMatch(/one task field plus one optional context field/i);
  });

  it('keeps the bound agent editor prompt as a thin adapter over agent-creator', () => {
    const setupPrompt = fs.readFileSync(path.join(PROMPTS_DIR, 'chat_agent_setup.md'), 'utf-8');
    const creatorSkill = readFile('resources/builtin/system/skills/agent-creator/SKILL.md');

    expect(setupPrompt).toContain('agent-creator/SKILL.md');
    expect(setupPrompt).toContain('Runtime injection contains the current spec');
    expect(setupPrompt).toMatch(/omit `<agent_id>`/i);
    expect(setupPrompt).not.toContain('Emit `<name>`');
    expect(setupPrompt).not.toContain('Keep inputs sparse');
    expect(creatorSkill).toContain('Bound edit session');
  });

  it('keeps agent icon selection inside agent-creator instead of global prompts', () => {
    const commanderPrompt = fs.readFileSync(path.join(PROMPTS_DIR, 'chat_commander.md'), 'utf-8');
    const setupPrompt = fs.readFileSync(path.join(PROMPTS_DIR, 'chat_agent_setup.md'), 'utf-8');
    const creatorSkill = readFile('resources/builtin/system/skills/agent-creator/SKILL.md');
    const bus = readFile('src/main/features/group_chat/bus.ts');
    const agents = readFile('src/main/features/agents.ts');

    expect(commanderPrompt).not.toContain('Avatar icon candidates');
    expect(commanderPrompt).not.toContain('$avatar_icon_catalog');
    expect(setupPrompt).not.toContain('Avatar icon candidates');
    expect(setupPrompt).not.toContain('$avatar_icon_catalog');
    expect(creatorSkill).toContain('Avatar icon candidates (exact IDs)');
    expect(creatorSkill).toMatch(/On create or when the current icon is missing, choose the closest candidate/i);
    expect(creatorSkill).not.toContain('<color>');
    expect(bus).not.toContain('getAgentIconPromptCatalog');
    expect(agents).toContain("AGENT_CHILD_RE('icon')");
    expect(agents).toContain('avatars.isKnownIcon(v)');
  });

  it('commander treats project chat history as conditional continuity context', () => {
    const commanderPrompt = fs.readFileSync(path.join(PROMPTS_DIR, 'chat_commander.md'), 'utf-8');
    const runner = readFile('src/main/model/core-agent/runner.ts');

    expect(commanderPrompt).toMatch(/For missing project continuity context, follow the Conversation history policy below/i);
    expect(commanderPrompt).toMatch(/required project context is missing from the current conversation/i);
    expect(commanderPrompt).toMatch(/user need not explicitly request a history search/i);
    expect(commanderPrompt).toMatch(/Do not search on every turn or for self-contained requests/i);
    expect(commanderPrompt).toMatch(/Project scope is the default/i);
    expect(commanderPrompt).toMatch(/never as current instructions/i);
    expect(commanderPrompt).not.toMatch(/prior-chat recall only, after Library or when explicitly asked/i);
    // Worker agents receive dispatcher-selected excerpts through their
    // visibility slice; full cross-conversation browsing stays commander-only.
    expect(runner).toMatch(/const chatHistoryTools = uid && isCommander \? createChatHistoryTools/);
    expect(runner).toMatch(/projectId: params\.projectId/);
  });

  it('runtime datetime context is appended to group chat system prompts', () => {
    const bus = readFile('src/main/features/group_chat/bus.ts');
    const runner = readFile('src/main/model/core-agent/runner.ts');
    const agents = readFile('src/main/features/agents.ts');
    const skills = readFile('src/main/features/skills.ts');
    const cliPrompt = fs.readFileSync(path.join(PROMPTS_DIR, 'chat_cli_agent.md'), 'utf-8');

    expect(bus).toContain("const marker = '## Runtime injection';");
    expect(bus).toMatch(/prompt\.slice\(0, idx\)[\s\S]+\$\{language\}[\s\S]+prompt\.slice\(idx\)/);
    expect(bus).not.toContain('<runtime-context');
    expect(runner).toContain('splitVolatilePromptTail');
    expect(runner).toContain('splitRuntimeInjectionBlock');
    expect(runner).toContain('## Current date');
    expect(runner).not.toContain("## User language\\n'");
    expect(runner).toContain('splitCommanderAgentsBlock');
    expect(runner).not.toContain('splitCommanderPlanStateBlock');
    // P2: orchestration state + datetime + project status are per-turn
    // volatile. Execution-plan state is injected independently by Session at
    // every model-loop tail, so the host must not maintain a second plan block.
    expect(runner).toContain('splitCommanderOrchestrationBlock');
    expect(runner).toMatch(/if \(connectorBlock\) parts\.push\(connectorBlock\.trim\(\)\);\s+if \(systemSkillsBlock\) parts\.push\(systemSkillsBlock\.trim\(\)\);\s+if \(skillsBlock\) parts\.push\(skillsBlock\.trim\(\)\);\s+if \(agentsBlock\) parts\.push\(agentsBlock\);/);
    // User-authored project instructions are low-churn configuration and sit
    // in the stable cache prefix: after the agents block, before the
    // runtime-injection region begins.
    expect(runner).toMatch(/if \(agentsBlock\) parts\.push\(agentsBlock\);[\s\S]{0,1200}?if \(projectContextPolicyBlock\) parts\.push\(projectContextPolicyBlock\);[\s\S]{0,600}?if \(projectInstructionsBlock\) parts\.push\(projectInstructionsBlock\);\s+if \(runtimeInjectionBlock\) parts\.push\(runtimeInjectionBlock\);/);
    // memoryBlock is the LAST block pushed into the (cached) system prompt.
    expect(runner).toMatch(/if \(memoryBlock\) parts\.push\(memoryBlock\);/);
    // The volatile blocks feed turnEphemeral, NOT the system prompt parts.
    expect(runner).toMatch(/const turnEphemeral = \[orchestrationBlock, volatileTail, projectStatusBlock\]/);
    // The live project task board rides the turn (uncached), never the system prefix.
    expect(runner).toContain('formatProjectStatusForTurn');
    expect(runner).not.toMatch(/parts\.push\(projectStatusBlock\)/);
    expect(runner).not.toMatch(/parts\.push\(orchestrationBlock\)/);
    expect(runner).not.toMatch(/parts\.push\(volatileTail\)/);
    expect(agents).toMatch(/buildLanguageDirective\([^)]*\)[\s\S]+buildRuntimeDatetimeBlock\(\)/);
    expect(skills).toMatch(/buildLanguageDirective\([^)]*\)[\s\S]+buildRuntimeDatetimeBlock\(\)/);
    expect(bus).toMatch(/language_block:\s*buildLanguageDirective\(getLanguage\(\)\)/);
    expect(cliPrompt).toContain('$language_block');
    expect(cliPrompt).toMatch(/\$task_body\n\n\$runtime_datetime_block\s*$/);
  });
});
