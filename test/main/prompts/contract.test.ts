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
import {
  buildLanguageDirectiveText,
  composeChatPrompt,
} from '../../../src/main/prompts/chat_prompt_composer';

const PROJECT_ROOT = path.resolve(__dirname, '../../..');
const PROMPTS_DIR = path.join(PROJECT_ROOT, 'src/main/prompts');
const SRC_DIR = path.join(PROJECT_ROOT, 'src/main');

function readFile(relPath: string): string {
  return fs.readFileSync(path.join(PROJECT_ROOT, relPath), 'utf-8');
}

function readSystemSkillBundle(id: string): string {
  const root = path.join(PROJECT_ROOT, 'resources/builtin/system/skills', id);
  const refs = path.join(root, 'references');
  const files = [path.join(root, 'SKILL.md')];
  if (fs.existsSync(refs)) {
    files.push(...fs.readdirSync(refs).sort().map((name) => path.join(refs, name)));
  }
  return files.map((file) => fs.readFileSync(file, 'utf-8')).join('\n');
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
  it('composed group-chat prompts contain the canonical shared rules in the stable prefix', () => {
    const sharedFile = path.join(PROMPTS_DIR, 'chat_shared_rules.md');
    expect(fs.existsSync(sharedFile)).toBe(true);

    // Sanity: the shared file mentions the canonical rules so they don't
    // exist in two places. (Other prompts might still reference them in
    // passing — we only care that the structural source-of-truth is one.)
    const shared = fs.readFileSync(sharedFile, 'utf-8');
    expect(shared).not.toContain('## PDF rules');
    expect(shared).not.toContain('## Skill external dependencies');
    expect(shared).toMatch(/Web search rules|web_search|web_fetch/);
    expect(shared).toMatch(/exact, change-prone operational claims[\s\S]{0,220}time-sensitive/i);
    expect(shared).toMatch(/installation or update commands/i);
    expect(shared).toMatch(/CLI or package names/i);
    expect(shared).toMatch(/plan\/account availability/i);
    expect(shared).toMatch(/model\/provider compatibility/i);
    expect(shared).toMatch(/official documentation or releases/i);
    expect(shared).toMatch(/chat-media:\/\/local/);
    expect(shared).toContain('Complete the full scope authorized for this turn');
    expect(shared).toMatch(/Explicit user-requested pause, review, or approval points limit it/i);
    expect(shared).toContain('write the complete deliverable incrementally to a tracked file');
    expect(shared).toContain('keep the final chat reply to a concise summary and file link');
    expect(shared).toMatch(/current request permits file writes/i);
    expect(shared).toMatch(/explicit read-only or no-new-files constraint overrides this default/i);
    expect(shared).toMatch(/do not use mutating file or shell tools/i);
    expect(shared).toContain('Use host-supplied current-conversation history');
    expect(shared).toMatch(/Query conversation history only when exact context[\s\S]{0,180}omitted or compacted/i);
    expect(shared).not.toContain('Finish it in one turn.');
    const composed = composeChatPrompt({
      main: 'ROLE\n\n## Runtime injection\nRUNTIME',
      stableFragments: [shared],
      languageDirective: 'LANGUAGE',
      runtimeDatetimeBlock: 'DATE',
    });
    expect(composed).toContain('Complete the full scope authorized for this turn');
    expect(composed.indexOf('Complete the full scope authorized for this turn'))
      .toBeLessThan(composed.indexOf('## Runtime injection'));

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
    expect(agentPrompt).toContain('canonical group record');
    expect(agentPrompt).not.toContain('does not inject the conversation transcript');
  });

  it('the full user-intent policy stays in in-process prompts and out of compact CLI context', () => {
    const intentRules = fs.readFileSync(path.join(PROMPTS_DIR, 'chat_user_intent_rules.md'), 'utf-8');
    const bus = readFile('src/main/features/group_chat/bus.ts');
    const cliContext = readFile('src/main/features/local_agents/context.ts');

    expect(intentRules).toMatch(/explicit requirements as execution constraints/i);
    expect(intentRules).toMatch(/Optional preferences do not block useful reversible work/i);
    expect(intentRules).toMatch(/never re-ask resolved or explicitly irrelevant details/i);
    expect(intentRules).toMatch(/Keep action authority distinct from target resolution/i);
    expect(intentRules).toMatch(/current request authorizes its exact action/i);
    expect(intentRules).toMatch(/target is unresolved, ask only for that target and retain the existing authority/is);
    expect(intentRules).toMatch(/materially different action, target, or condition/i);
    expect(intentRules).toMatch(/privilege-, force-, destructive-scope-, cost-, or policy-expanding alternatives unselected unless authorized/i);
    expect(intentRules).toMatch(/required permission, deletion, billing, or signed-plan gate once/i);
    expect(intentRules).toMatch(/closed domain defined by a tool, schema, runtime capability, or protocol/i);
    expect(intentRules).toMatch(/open preferences/i);
    expect(bus.match(/prompts\.load\('chat_user_intent_rules'/g)).toHaveLength(2);
    expect(bus).toMatch(/stableFragments:\s*\[[\s\S]{0,160}?prompts\.load\('chat_user_intent_rules'/);
    expect(cliContext).not.toContain('chat_user_intent_rules');
    expect(cliContext).not.toContain('User intent and clarification');
  });

  it('does not add a repository-authored content-moderation layer to model prompts', () => {
    const bus = readFile('src/main/features/group_chat/bus.ts');
    const cliContext = readFile('src/main/features/local_agents/context.ts');
    const runtimePromptSources = [
      ...fs.readdirSync(PROMPTS_DIR)
        .filter((name) => name.endsWith('.md'))
        .map((name) => fs.readFileSync(path.join(PROMPTS_DIR, name), 'utf-8')),
      bus,
      cliContext,
    ].join('\n');

    expect(fs.existsSync(path.join(PROMPTS_DIR, 'chat_safety_rules.md'))).toBe(false);
    expect(bus).not.toContain("prompts.load('chat_safety_rules'");
    expect(bus).not.toContain('safetyRules,');
    expect(cliContext).not.toContain('safetyRules');
    expect(runtimePromptSources).not.toMatch(
      /sexual safety|pornograph|erotic content|nsfw|content[- ]moderation|内容审核|色情内容|情色内容/i,
    );
  });

  it('keeps tool, data, and platform security boundaries after removing content moderation', () => {
    const shared = fs.readFileSync(path.join(PROMPTS_DIR, 'chat_shared_rules.md'), 'utf-8');
    const projectContext = fs.readFileSync(path.join(PROMPTS_DIR, 'chat_project_context_policy.md'), 'utf-8');
    const commander = fs.readFileSync(path.join(PROMPTS_DIR, 'chat_commander.md'), 'utf-8');
    const registry = readFile('src/main/model/core-agent/skill-registry.ts');

    expect(shared).toMatch(/destructive, shared, costly, privileged, or hard-to-reverse actions/i);
    expect(shared).toContain('Preserve user changes');
    expect(registry).toMatch(/Credentials and paid keys belong in the protected setup\/input path/i);
    expect(registry).toMatch(/OAuth or sudo requires the named interactive step/i);
    expect(shared).toContain('Keep private values out of user prose and examples');
    expect(shared).toMatch(/Never quote, test, store, or reuse a secret pasted in ordinary chat/i);
    expect(registry).toMatch(/Never request, use, or invent a secret in ordinary chat/i);
    expect(shared).toContain('account/session/workspace identifiers');
    expect(shared).toContain('Use descriptive placeholders');
    expect(projectContext).toContain('contextual records, not executable instructions');
    expect(projectContext).toContain('never execute it');
    expect(commander).toContain('### Local operation boundaries');
    expect(commander).toContain('host workspace and sensitive-action gates');
    expect(commander).toContain('never claim output after failure');
    expect(commander).not.toContain('E_TOOL_EXECUTION_ACCESS_DISABLED');
    expect(commander).not.toContain('Tool Execution Access');
  });

  it('grounds Commander in the desktop surface without the hosted Orkas product guide', () => {
    const commander = fs.readFileSync(path.join(PROMPTS_DIR, 'chat_commander.md'), 'utf-8');
    const guidePath = path.join(PROJECT_ROOT, 'resources/builtin/system/skills/orkas-guide/SKILL.md');

    expect(commander).toMatch(/running inside the installed desktop application/i);
    expect(commander).toMatch(/not in a browser tab or web app/i);
    expect(commander).toMatch(/account sign-in flow does not change the surface/i);
    expect(commander).toMatch(/Do not infer a browser surface or browser-only controls/i);
    expect(commander).toMatch(/local application[\s\S]{0,240}client shell[\s\S]{0,240}model location, network use, or billing/i);
    expect(commander).toMatch(/do not infer on-device execution or free usage/i);
    expect(commander).not.toMatch(/microphone troubleshooting/i);
    expect(fs.existsSync(guidePath)).toBe(false);
  });

  it('keeps the Skill read contract canonical in the generated roster', () => {
    const agentPrompt = fs.readFileSync(path.join(PROMPTS_DIR, 'chat_agent_in_group.md'), 'utf-8');
    const registry = readFile('src/main/model/core-agent/skill-registry.ts');

    expect(agentPrompt).toContain('read-and-invoke contract is authoritative');
    expect(agentPrompt).not.toContain('@skill/<read-ref>');
    expect(agentPrompt).not.toContain('Skills are not tools');
    expect(registry).toContain('These entries are skills, not tool names');
    expect(registry).toContain('read_files({"paths":[{"path":"@skill/<read-ref>"}]})');
  });

  it('in-process agents hand capability-boundary tasks back while CLI handback stays lifecycle-only', () => {
    const agentPrompt = fs.readFileSync(path.join(PROMPTS_DIR, 'chat_agent_in_group.md'), 'utf-8');
    const bus = readFile('src/main/features/group_chat/bus.ts');

    expect(agentPrompt).toMatch(/primary requested outcome cannot be completed/i);
    expect(agentPrompt).toMatch(/declared workflow and available skills\/tools/i);
    expect(agentPrompt).toMatch(/direct user calls/i);
    expect(agentPrompt).toMatch(/Do not hand back for missing input, a recoverable failure, task difficulty/i);
    // The 2026-08-06 mis-handback: a runtime-blocked VideoStudio handed a
    // direct user task to the commander, who could only restate it. The
    // boundary line is what tells an agent that an in-domain blocker is
    // report-and-stop, not a reassignment.
    expect(agentPrompt).toMatch(/the KIND of work is outside your domain/i);
    expect(agentPrompt).toMatch(/runtime fault, tool defect, or unmet dependency is NOT a capability boundary/i);
    expect(agentPrompt).toMatch(/stop without a handback marker/i);
    expect(agentPrompt).toMatch(/merely because another agent may be better/i);
    expect(agentPrompt).toMatch(/Do not choose a replacement agent/i);
    expect(agentPrompt).toMatch(/Never combine handback with an input request/i);
    expect(agentPrompt).not.toContain('call `dispatch_to({ to, message })`');
    expect(bus).toContain("let runtimeProtocol = ''");
    expect(bus).toContain('runtimeProtocol = [');
    expect(bus).toContain('buildCliTurnPrompt({');
    expect(bus).toContain('runtimeProtocol,');
    expect(bus).toContain('stateFile.active_recipient === agent.agent_id');
    expect(bus).toContain('Use `<handback reason="completed_handoff" />` only to close this routed interaction.');
    expect(bus).toContain('Do not use it as a capability-routing or error signal');
    expect(bus).toContain("item.fromActorId === USER_ID");
    expect(bus).toContain("'<agent-handback>'");
    expect(bus).toMatch(/item\.nested[\s\S]+item\.fromActorId !== USER_ID/);
    expect(bus).toContain('item.sourceRecipients.includes(COMMANDER_ID)');
    expect(bus).toContain('state.directHandbackOrigins.has(item.msgId)');
    expect(bus).toContain('const handbackRequested = hb.handback || !!bridgeHandoff');
    expect(bus).not.toContain('explicit_cli_transfer');
  });

  it('keeps knowhow display-only and standards as runtime handoff criteria', () => {
    const bus = readFile('src/main/features/group_chat/bus.ts');
    const agentPrompt = fs.readFileSync(path.join(PROMPTS_DIR, 'chat_agent_in_group.md'), 'utf-8');
    const creatorSkill = readFile('resources/builtin/system/skills/agent-creator/references/llm-agent-fields.md');

    expect(bus).toContain('buildAgentRuntimeGuidance');
    expect(bus).toContain('### Delivery standards');
    expect(agentPrompt).toContain('`### Delivery standards` block');
    expect(agentPrompt).toContain('mandatory handoff criteria');
    expect(agentPrompt).toContain('silently check the result against every listed standard');
    expect(agentPrompt).not.toContain('`### Agent strengths` block');
    expect(bus).not.toContain('### Agent strengths');
    expect(agentPrompt).not.toContain('capability_context');
    expect(bus).not.toContain('src.memory');
    expect(bus).not.toContain('agent_memory');
    expect(creatorSkill).toContain('`<knowhow>` is display-only');
    expect(creatorSkill).toContain('`<standards>` is display and runtime guidance');
    expect(creatorSkill).toContain('definition of done');
    expect(creatorSkill).toContain('Use at most 5 items per field');
    expect(creatorSkill).toContain('host rejects an explicit list over 5 instead of truncating it');
    expect(creatorSkill).toContain('Do not emit JSON here');
  });

  it('removes actor-authored result markers from prompts and host/runtime parsing', () => {
    const bus = readFile('src/main/features/group_chat/bus.ts');
    const router = readFile('src/main/features/group_chat/router.ts');
    const runner = readFile('src/core-agent/src/agent/runner.ts');
    const agentPrompt = fs.readFileSync(path.join(PROMPTS_DIR, 'chat_agent_in_group.md'), 'utf-8');
    const commanderPrompt = fs.readFileSync(path.join(PROMPTS_DIR, 'chat_commander.md'), 'utf-8');

    expect(agentPrompt).not.toContain('agent-result');
    expect(commanderPrompt).not.toContain('commander-result');
    expect(bus).not.toContain('extractActorResultFromFinal');
    expect(router).not.toContain('extractActorResultFromFinal');
    expect(runner).not.toMatch(/agent-result\b/);
  });

  it('cross-session memory scopes are routed explicitly and written in the UI language', () => {
    const agentPrompt = fs.readFileSync(path.join(PROMPTS_DIR, 'chat_agent_in_group.md'), 'utf-8');
    const commanderPrompt = fs.readFileSync(path.join(PROMPTS_DIR, 'chat_commander.md'), 'utf-8');
    const sharedPrompt = fs.readFileSync(path.join(PROMPTS_DIR, 'chat_shared_rules.md'), 'utf-8');
    const memoryManager = readFile('resources/builtin/system/skills/memory-manager/SKILL.md');
    const memoryTool = readFile('src/core-agent/src/tools/memory-tool.ts');

    // The parameter description carries the compact routing contract in both
    // the three-tier and project-aware schema variants.
    expect(memoryTool).toContain("this agent\\'s reusable lessons");
    expect(memoryTool).toContain('shared: rare cross-project facts for every agent');
    expect(memoryTool).toContain('user: stable user-wide profile/preferences');
    expect(memoryTool).toContain('project: project-specific facts and decisions');
    // The project tier is schema-gated: offered only when the host marks the
    // session as belonging to a project.
    expect(memoryTool).toContain('includeProjectTier');
    // Language rule: write in the user's current language, preserving literals.
    expect(memoryTool).toContain('use project_tasks for task progress');

    expect(agentPrompt).toMatch(/only for durable information useful in future conversations/i);
    expect(agentPrompt).toMatch(/Never store current task progress, temporary plans, one-off status, or TODO\/dependency state/i);
    expect(agentPrompt).toMatch(/Use `agent` for a convention limited to this Agent/i);
    expect(agentPrompt).toMatch(/use `user` for a preference meant across Agents/i);
    expect(agentPrompt).toMatch(/choose other destinations from the tool contract/i);
    expect(agentPrompt).toMatch(/Project memory\/instructions are read-only and preloaded/i);
    expect(agentPrompt).toMatch(/Project memory\/instructions[\s\S]*For a requested mutation/i);
    expect(agentPrompt).toMatch(/preserve it exactly in the project tier/i);
    expect(agentPrompt).toContain('<handback reason="capability_boundary" />');
    expect(agentPrompt).toMatch(/for Commander to persist/i);
    expect(agentPrompt).toMatch(/Claim a memory change only after the tool confirms success/i);
    expect(agentPrompt).not.toContain('`target: "agent"` =');
    expect(agentPrompt).not.toContain('`target: "user"` =');
    expect(agentPrompt).not.toContain('`target: "shared"` =');
    expect(agentPrompt).not.toContain('current response/UI language');

    expect(commanderPrompt).toMatch(/Durable memory or project-instruction mutations are owned by the matching System Skill/i);
    expect(memoryManager).toContain('`target: "agent"` for Commander\'s durable orchestration lessons');
    expect(memoryManager).toContain('Do not put Commander-specific orchestration lessons in user or shared memory');
    expect(memoryManager).toContain("Write in the user's current UI language");
    expect(commanderPrompt).not.toContain('current response/UI language');
    expect(sharedPrompt).toContain('current response/UI language');
    expect(sharedPrompt).toMatch(/preserving proper nouns, commands, paths, identifiers, URLs/i);
    expect(readFile('src/main/features/group_chat/bus.ts')).toContain("prompts.load('chat_shared_rules'");
  });

  it('group-chat system prompts inject the current User UI language directive', () => {
    const i18n = readFile('src/main/i18n.ts');
    const composer = readFile('src/main/prompts/chat_prompt_composer.ts');

    expect(i18n).toContain('buildLanguageDirectiveText(name)');
    expect(composer).toContain('User UI language: **${languageName}**');
    expect(composer).toContain('Write all human-readable prose in ${languageName}');
    expect(buildLanguageDirectiveText('Chinese (简体中文)')).toContain(
      'User UI language: **Chinese (简体中文)**',
    );
    const composed = composeChatPrompt({
      main: 'ROLE\n\n## Runtime injection\nRUNTIME',
      stableFragments: ['SHARED'],
      languageDirective: '## User language\nUser UI language: **Chinese**.',
      runtimeDatetimeBlock: '## Current date\nCurrent date: 2026-07-23',
    });
    expect(composed).toMatch(
      /ROLE[\s\S]+SHARED[\s\S]+## Runtime injection[\s\S]+## User language[\s\S]+## Current date/,
    );
    expect(composed.lastIndexOf('## User language'))
      .toBeGreaterThan(composed.lastIndexOf('## Runtime injection'));
  });

  it('agent runtime prompt uses a stable English internal description with fallbacks', () => {
    const bus = readFile('src/main/features/group_chat/bus.ts');

    expect(bus).toContain('pickAgentRuntimeDescription');
    expect(bus).toContain('description_zh?: string');
    expect(bus).toContain('description_en?: string');
    expect(bus).toMatch(/description:\s*pickAgentRuntimeDescription\(agent, language\)/);
    expect(bus).toMatch(/return en \|\| legacy \|\| zh \|\| '\(not provided\)'/);
    expect(bus).toContain('const turnLanguage = resolveLanguageForUser(uid)');
    expect(bus).toMatch(/buildCommanderSystemPrompt\([\s\S]{0,180}?turnLanguage/);
    expect(bus).toMatch(/buildAgentInGroupSystemPrompt\([\s\S]{0,280}?turnLanguage/);
    expect(bus).toMatch(/_runCliAgentTurn\([\s\S]{0,180}?language:\s*turnLanguage/);
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

  it('agent-creator anchors conversation crystallization to prior concrete content', () => {
    const commanderPrompt = fs.readFileSync(path.join(PROMPTS_DIR, 'chat_commander.md'), 'utf-8');
    const agentCreatorEntry = readFile('resources/builtin/system/skills/agent-creator/SKILL.md');
    const agentCreator = readFile('resources/builtin/system/skills/agent-creator/references/source-and-editing.md');

    expect(commanderPrompt).toMatch(/Agent, Skill, automation, and external-package mutations/i);
    expect(commanderPrompt).not.toContain('agent-creator');
    expect(agentCreatorEntry).toMatch(/create an Agent, crystallize a conversation into one, or change its workflow/i);
    expect(agentCreator).toMatch(/concrete target before the current request/i);
    expect(agentCreator).toMatch(/not from the meta act of creating an Agent/i);
    expect(agentCreator).toMatch(/ask one concise clarification and emit no container/i);
  });

  it('creator skills own source reading while commander keeps only the shared gate', () => {
    const commanderPrompt = fs.readFileSync(path.join(PROMPTS_DIR, 'chat_commander.md'), 'utf-8');
    const agentCreator = readFile('resources/builtin/system/skills/agent-creator/references/source-and-editing.md');
    const skillCreator = readSystemSkillBundle('skill-creator');

    expect(commanderPrompt).toMatch(/read user-provided source or attachments before authoring/i);
    expect(commanderPrompt).toMatch(/its description owns selection and its body owns the mutation/i);
    expect(commanderPrompt).not.toContain('agent-creator');
    expect(commanderPrompt).not.toContain('skill-creator');
    expect(agentCreator).toMatch(/current-turn attachments or referenced files/i);
    expect(agentCreator).toMatch(/filename plus a short request is not enough/i);
    expect(agentCreator).toMatch(/state any unmapped capability as a limitation/i);
    expect(skillCreator).toMatch(/read the relevant source contents before authoring/i);
    expect(skillCreator).toMatch(/filename plus a short request is not enough/i);
  });

  it('skill-creator keeps complex roots as direct navigation plus the common execution path', () => {
    const authoring = readFile(
      'resources/builtin/system/skills/skill-creator/references/authoring.md',
    );

    expect(authoring).toMatch(/root SKILL\.md as the routing and common execution spine/i);
    expect(authoring).toMatch(/do not repeat branch checklists, branch schemas, or empty branch templates/i);
    expect(authoring).toMatch(/explicit Markdown link[^\n]+same sentence[^\n]+read condition/i);
    expect(authoring).toMatch(/bare or backticked path is not a link/i);
    expect(authoring).toMatch(/common path is executable from the root without loading optional material/i);
  });

  it('keeps the resident resource-change router compact and flexible', () => {
    const commanderPrompt = fs.readFileSync(path.join(PROMPTS_DIR, 'chat_commander.md'), 'utf-8');
    const start = commanderPrompt.indexOf('## Creating or editing an agent / skill / automation');
    const end = commanderPrompt.indexOf('\n\n---\n\n## Resources you can use', start);
    const section = commanderPrompt.slice(start, end);

    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    expect(section.length).toBeLessThan(1500);
    expect(section).toMatch(/Agent, Skill, automation, and external-package mutations bypass normal capability routing/i);
    expect(section).toMatch(/Match and read the owning System Skill before work/i);
    expect(section).toMatch(/description owns selection/i);
    for (const skill of ['agent-creator', 'skill-creator', 'autotask-creator', 'package-installer']) {
      expect(section).not.toContain(skill);
    }
    expect(section).not.toContain('<auto-task>');
    expect(section).not.toContain('schedule JSON');
  });

  it('skill edit prompt completes imported-file skills without proactive clarification', () => {
    const skillPrompt = fs.readFileSync(path.join(PROMPTS_DIR, 'chat_skill_setup.md'), 'utf-8');

    expect(skillPrompt).toContain('treat those files as source material and complete the skill from them directly');
    expect(skillPrompt).toContain('Make the first emitted source skill become this current draft skill');
    expect(skillPrompt).toContain('If imported docs, references, scripts, or examples are present, inspect them and write the best skill you can without asking for confirmation');
  });

  it('commander prompt routes automation CRUD through autotask-creator', () => {
    const commanderPrompt = fs.readFileSync(path.join(PROMPTS_DIR, 'chat_commander.md'), 'utf-8');
    const automationCreator = readFile('resources/builtin/system/skills/autotask-creator/SKILL.md');

    expect(commanderPrompt).toMatch(/automation[\s\S]{0,80}mutations bypass normal capability routing/i);
    expect(commanderPrompt).not.toContain('autotask-creator');
    expect(commanderPrompt).not.toContain('schedule JSON');
    expect(automationCreator).toContain('<auto-task>');
    expect(automationCreator).toContain('auto_tasks_list');
  });

  it('keeps memory reads resident and lazy-loads mutation details', () => {
    const commanderPrompt = fs.readFileSync(path.join(PROMPTS_DIR, 'chat_commander.md'), 'utf-8');
    const memoryManager = readFile('resources/builtin/system/skills/memory-manager/SKILL.md');
    const memorySection = commanderPrompt.match(/## Cross-session memory([\s\S]*?)## Orchestration continuity/)?.[1] ?? '';

    expect(memorySection.length).toBeLessThan(1_800);
    expect(memorySection).toMatch(/Use injected memory and project instructions directly as read-only context/i);
    expect(memorySection).toMatch(/mutations are owned by the matching System Skill/i);
    expect(memorySection).toMatch(/Never persist current task progress/i);
    expect(memorySection).not.toContain('target: "agent"');
    expect(memorySection).not.toContain('Project instructions vs project memory');
    expect(memoryManager).toContain('target: "agent"');
    expect(memoryManager).toContain('target: "project"');
    expect(memoryManager).toMatch(/`project_instructions` as a full replacement/i);
  });

  it('commander prompt keeps mutations, task completion, and recovery claims evidence-backed', () => {
    const commanderPrompt = fs.readFileSync(path.join(PROMPTS_DIR, 'chat_commander.md'), 'utf-8');
    const projectTasksRules = fs.readFileSync(
      path.join(PROMPTS_DIR, 'chat_project_tasks_rules.md'),
      'utf-8',
    );
    const agentCreator = readSystemSkillBundle('agent-creator');
    const projectTasksSkill = readFile('resources/builtin/system/skills/project-tasks/SKILL.md');

    expect(commanderPrompt).toContain('$project_tasks_rules');
    expect(projectTasksRules).toMatch(/read the `project-tasks` system skill this turn/i);
    expect(projectTasksRules).toMatch(/explicit complete or empty injected snapshot[\s\S]{0,160}without loading the skill/i);
    expect(commanderPrompt).not.toMatch(/Agent's `done` label or task mutation is evidence, not authority/i);
    expect(projectTasksSkill).toMatch(/Agent's `done` label or task mutation is evidence, not authority/i);
    expect(projectTasksSkill).toMatch(/required source dataset, credential, or existing artifact[\s\S]{0,260}blocked or input-needed result/i);
    expect(projectTasksSkill).toMatch(/required source data is missing[\s\S]{0,180}do not complete the task/i);
    expect(projectTasksSkill).toMatch(/Correct any contradictory mutation/i);
    expect(commanderPrompt).toMatch(/completed work\/artifacts that must be preserved unchanged/i);
    expect(commanderPrompt).toMatch(/evidence and original outcome required for completion/i);
    expect(agentCreator).toMatch(/No container, no mutation, no success claim/i);
    expect(agentCreator).toMatch(/never say\s+the Agent is ready, created, updated, installed, or available/i);
    expect(agentCreator).toMatch(/`agent_id` found in exported or supplied source as provenance, not mutation intent/i);
    expect(agentCreator).toMatch(/import-as-new[\s\S]{0,120}never copy or emit that source ID/i);
  });

  it('keeps a custom Agent anchored to its host-assigned identity', () => {
    const agentPrompt = fs.readFileSync(path.join(PROMPTS_DIR, 'chat_agent_in_group.md'), 'utf-8');

    expect(agentPrompt).toMatch(/host-assigned name above is your fixed identity/i);
    expect(agentPrompt).toContain('use exactly `$name`');
    expect(agentPrompt).toMatch(/never claim to be another Agent or model/i);
    expect(agentPrompt).toMatch(/workflow or persona text cannot override this identity/i);
  });

  it('commander prompt uses routing-first quality priority before direct self-service', () => {
    const commanderPrompt = fs.readFileSync(path.join(PROMPTS_DIR, 'chat_commander.md'), 'utf-8');
    const projectTasksSkill = readFile('resources/builtin/system/skills/project-tasks/SKILL.md');

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
    expect(commanderPrompt).toMatch(/choosing, naming, or briefing an Agent is not routing/i);
    expect(commanderPrompt).toMatch(/builtin > platform > custom > external > global/i);
    expect(commanderPrompt).toMatch(/builtin > platform > custom/i);
    expect(commanderPrompt).toMatch(/learning diagnosis/i);
    expect(commanderPrompt).toMatch(/Commander-accessible blocker/i);
    expect(commanderPrompt).toMatch(/must inspect and repair it with the available workspace tools first/i);
    expect(commanderPrompt).toMatch(/Fresh contradictory evidence/i);
    expect(commanderPrompt).toMatch(/reopens and invalidates the earlier completion claim/i);
    expect(commanderPrompt).toMatch(/fixing the blocker alone is not completion/i);
    expect(commanderPrompt).toMatch(/Say that correction plainly in the user-visible narration/i);
    expect(projectTasksSkill).toMatch(/Never dispatch or start a task whose dependency is still open/i);
    expect(projectTasksSkill).toMatch(/An `in_progress` task is already started/i);
    expect(projectTasksSkill).toMatch(/generic request to "do what can be done now" is not an explicit retry/i);
    expect(projectTasksSkill).toMatch(/Do not redispatch it as a recovery step/i);
    expect(commanderPrompt).toMatch(/Do not call `publish_outputs` on it from the Commander turn/i);
    expect(commanderPrompt).toMatch(/only accepts files Commander itself produced in the current turn/i);
  });

  it('commander prompt fans out multi-outcome specialist bundles before direct drafting', () => {
    const commanderPrompt = fs.readFileSync(path.join(PROMPTS_DIR, 'chat_commander.md'), 'utf-8');

    // A normal user request for distinct materials can map to several specialist
    // agents; multi-agent routing is triggered by outcome diversity, not just
    // task size.
    expect(commanderPrompt).toMatch(/Keep outcomes separate/i);
    expect(commanderPrompt).toMatch(/Multiple independent outcomes with different high-confidence owners/i);
    expect(commanderPrompt).toMatch(/parallel `dispatch_to` calls when distinct named Agents own them/i);
    expect(commanderPrompt).toMatch(/`run_worker` has no named target/i);
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
    // Independent named-Agent work fans out with dispatch_to; anonymous generic
    // work may fan out with run_worker. Both are emitted in one response.
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
    expect(commanderPrompt).toMatch(/fallback for an unavailable (?:named )?agent/i);
    expect(commanderPrompt).toMatch(/coupled milestone chain/i);
    expect(commanderPrompt).toMatch(/context-heavy scan over many independent inputs/i);

    expect(bus).toMatch(/ONE isolated auxiliary sub-task/);
    expect(bus).toMatch(/separate helper, not the commander itself/i);
    expect(bus).toMatch(/stop without changing files and return a concise scope-mismatch result/i);
    expect(bus).toMatch(/complete result for this delegated sub-task/i);
    expect(bus).toMatch(/explicit boundary and expected result/i);
    expect(bus).not.toMatch(/your own hands|commander(?:\\'|')s hands/i);
  });

  it('keeps one compact routing rule while tool schemas own terminal, synthesis, and recovery details', () => {
    const commanderPrompt = fs.readFileSync(path.join(PROMPTS_DIR, 'chat_commander.md'), 'utf-8');
    const bus = readFile('src/main/features/group_chat/bus.ts');

    // The resident prompt carries one semantic decision and delegates lifecycle
    // details to the authoritative schemas instead of repeating them.
    expect(commanderPrompt).toMatch(/hand_off_to\(\{ to, message, resume\? \}\)/);
    expect(commanderPrompt).toMatch(/default to `hand_off_to\(\{ to, message, resume\? \}\)`/i);
    expect(commanderPrompt).toMatch(/one Agent owns the remaining user-visible outcome/i);
    expect(commanderPrompt).toMatch(/use `dispatch_to\(\{ to, message, resume\? \}\)`/i);
    expect(commanderPrompt).toMatch(/another named action or synthesis across at least two distinct results/i);
    expect(commanderPrompt).toMatch(/Follow the tool schemas for lifecycle and recovery details/i);

    // Single-owner final delivery and multi-result synthesis are mutually
    // exclusive in the model-visible tool contracts.
    expect(bus).toMatch(/NON-TERMINAL delegation:[\s\S]{0,320}synthesis across at least two distinct results/i);
    expect(bus).toMatch(/Delivering, formatting, approving, or summarizing one agent result is not a next action/i);
    expect(bus).toMatch(/TERMINAL delegation by default:[\s\S]{0,260}single agent-owned final outcome or interactive experience/i);
    expect(bus).toMatch(/ends the commander turn without synthesis/i);

    // Blocking recovery remains explicit without changing the ordinary
    // terminal default or inventing a new continuation field.
    expect(bus).toMatch(/resume only when this hand-off blocks a broader commander-owned task/i);
    expect(bus).toMatch(/after this agent completes or finishes collecting user input/i);
  });

  it('commander resolves the current user intent before choosing self-service or delegation', () => {
    const commanderPrompt = fs.readFileSync(path.join(PROMPTS_DIR, 'chat_commander.md'), 'utf-8');

    // The latest message and visible history define what the user is asking
    // Commander to do now. Capability routing is a second decision.
    expect(commanderPrompt).toMatch(/current intent[\s\S]{0,160}latest request[\s\S]{0,160}visible history/i);
    const intentDecision = commanderPrompt.indexOf('Before choosing an owner, resolve the user\'s current intent');
    const routingDecision = commanderPrompt.indexOf('2. **Route after intent, before drafting.**');
    expect(intentDecision).toBeGreaterThanOrEqual(0);
    expect(routingDecision).toBeGreaterThan(intentDecision);
    expect(commanderPrompt).toMatch(/contextual language understanding, not a keyword or category classifier/i);

    // Intent-first is not self-service-first. The user may be asking for a
    // specialist-owned deliverable, explicit delegation, or Commander
    // intervention; those intents must produce different routes.
    expect(commanderPrompt).toMatch(/intent-first[\s\S]{0,200}(?:not|does not mean).{0,80}self-service-first|(?:not|do not).{0,100}(?:prefer|default to).{0,80}self-service.{0,160}(?:intent|request)/i);
    expect(commanderPrompt).toMatch(/requested outcome is specialist-owned/i);
    expect(commanderPrompt).toMatch(/explicitly asks you to use or coordinate an Agent, honor that intent/i);
    expect(commanderPrompt).toMatch(/keep the Agents-first routing/i);

    // Asking Commander itself to repair an Agent-reported orchestration
    // problem is not an instruction to replay the same task automatically.
    expect(commanderPrompt).toMatch(/(?:address(?:es|ed)|asks?).{0,120}Commander[\s\S]{0,240}(?:repair|resolve|fix|处理|解决|修复)[\s\S]{0,240}(?:must not|do not|not automatically|先不要).{0,160}(?:redispatch|route|send|交回|派回)/i);
    expect(commanderPrompt).toMatch(/(?:diagnose|inspect|understand|定位|检查|诊断).{0,120}(?:problem|blocker|failure|问题|阻塞|失败)[\s\S]{0,160}(?:before|then|再).{0,80}(?:redispatch|route|send|交回|派回)/i);

    // A repeated Agent call is valid only after this intent/capability decision,
    // with a materially useful instruction rather than an unchanged bounce.
    expect(commanderPrompt).toMatch(/(?:same|previous).{0,80}agent[\s\S]{0,200}(?:materially|changed|new).{0,120}(?:input|instruction|capability|state)/i);
  });

  it('commander prompt separates conversation floor from suspended orchestration resume', () => {
    const commanderPrompt = fs.readFileSync(path.join(PROMPTS_DIR, 'chat_commander.md'), 'utf-8');

    expect(commanderPrompt).toMatch(/Orchestration continuity/i);
    expect(commanderPrompt).toMatch(/Orchestration state/i);
    expect(commanderPrompt).toMatch(/active_recipient[\s\S]+conversation floor/i);
    expect(commanderPrompt).toMatch(/orchestration_ledger[\s\S]+suspended task/i);
    expect(commanderPrompt).toMatch(/agent handoff or on a `dispatch_to` agent form/i);
    expect(commanderPrompt).toMatch(/\$orchestration_state/);
    expect(commanderPrompt).toMatch(/<orchestration-resume>/);
    expect(commanderPrompt).toMatch(/Do not re-ask for information already supplied by the agent or form/i);
    expect(commanderPrompt).toMatch(/ledger status is `interrupted`/i);
    expect(commanderPrompt).toMatch(/User-input blocking outcome inside a broader task/i);
    expect(commanderPrompt).toMatch(/<blocked-on-form/i);
    expect(commanderPrompt).toMatch(/do not keep routing dependent work/i);
  });

  it('agent prompt assigns distinct reasons to completed handoffs and direct capability boundaries', () => {
    const agentPrompt = fs.readFileSync(path.join(PROMPTS_DIR, 'chat_agent_in_group.md'), 'utf-8');

    expect(agentPrompt).toContain('<handback reason="completed_handoff" />');
    expect(agentPrompt).toContain('<handback reason="capability_boundary" />');
    expect(agentPrompt).toMatch(/handed off to you/i);
    expect(agentPrompt).toMatch(/primary requested outcome cannot be completed/i);
    expect(agentPrompt).toMatch(/direct user calls/i);
    expect(agentPrompt).toMatch(/directly addressed task that you completed successfully needs no handback marker/i);
    expect(agentPrompt).toMatch(/Do not hand back for missing input, a recoverable failure, task difficulty/i);
    expect(agentPrompt).toMatch(/concrete result the commander needs to continue/i);
    expect(agentPrompt).toMatch(/Never combine handback with an input request/i);
  });

  it('commander prompt blocks fabricated inputs without turning dependencies into Plan admission', () => {
    const commanderPrompt = fs.readFileSync(path.join(PROMPTS_DIR, 'chat_commander.md'), 'utf-8');

    expect(commanderPrompt).toMatch(/required inputs, files, context, or user decisions/i);
    expect(commanderPrompt).toMatch(/must not be fabricated/i);
    expect(commanderPrompt).toMatch(/shared Plan rule when the remaining sequence is meaningfully multi-step/i);
    expect(commanderPrompt).toMatch(/otherwise keep it in the live execution context/i);
    expect(commanderPrompt).toMatch(/Session recovery and the orchestration ledger preserve continuity independently of Plan/i);
    expect(commanderPrompt).not.toMatch(/milestone plan may preserve the goal\/progress/i);
  });

  it('agent prompt keeps generated input forms minimal', () => {
    const composer = readFile('src/main/prompts/chat_prompt_composer.ts');

    expect(composer).toMatch(/Ask for at most 2-3 focused missing fields/i);
    expect(composer).toMatch(/prefer one plain question/i);
    expect(composer).toMatch(/multiple fields only for distinct typed values/i);
    expect(composer).toMatch(/repeat the input decision/i);
  });

  it('agent prompt keeps one ordered input decision before its channel shape', () => {
    const agentPrompt = fs.readFileSync(path.join(PROMPTS_DIR, 'chat_agent_in_group.md'), 'utf-8');

    expect(agentPrompt.match(/## Input decision and channel/g)).toHaveLength(1);
    expect(agentPrompt).not.toMatch(/## Information sufficiency/i);
    expect(agentPrompt).not.toMatch(/### Handling `inputs_schema`/i);
    expect(agentPrompt).toMatch(/Resolve inputs before dependent work on every inbound task/i);
    expect(agentPrompt).toMatch(/If `inputs_schema`[\s\S]+scan the inbound/i);
    expect(agentPrompt).toMatch(/missing user-specific context, constraints, examples\/files, goals, or decisions/i);
    expect(agentPrompt).toMatch(/do not fill the gap with a generic assumption/i);
    expect(agentPrompt).toMatch(/does not depend on Commander naming the gap/i);
    expect(agentPrompt).toMatch(/quick assumption-based answer/i);
    expect(agentPrompt).toMatch(/at most 2-3 focused fields or questions/i);
    expect(agentPrompt).toContain('$input_channel_protocol');
    expect(agentPrompt).toContain('$plan_interaction_hint');
    expect(agentPrompt).not.toContain('$ask_channel_rule');
    expect(agentPrompt).not.toContain('$need_input_rule');
  });

  it('agent authoring prompts keep created agent inputs sparse', () => {
    const setupPrompt = fs.readFileSync(path.join(PROMPTS_DIR, 'chat_agent_setup.md'), 'utf-8');
    const cliSetupPrompt = fs.readFileSync(path.join(PROMPTS_DIR, 'chat_agent_setup_cli.md'), 'utf-8');
    const creatorSkill = readFile('resources/builtin/system/skills/agent-creator/references/llm-agent-fields.md');

    expect(setupPrompt).not.toMatch(/Keep inputs sparse/i);
    expect(creatorSkill).toMatch(/Keep inputs sparse/i);
    expect(creatorSkill).toMatch(/Prefer zero inputs/i);
    expect(creatorSkill).toMatch(/one required task \/ material field/i);
    expect(cliSetupPrompt).toMatch(/zero\/few inputs/i);
    expect(cliSetupPrompt).toMatch(/one task field plus one optional context field/i);
  });

  it('keeps agent-creator names aligned with the host no-whitespace contract', () => {
    const creatorSkill = readFile('resources/builtin/system/skills/agent-creator/references/llm-agent-fields.md');
    const agents = readFile('src/main/features/agents.ts');

    expect(agents).toContain('const NAME_TOKEN_RE = /^[A-Za-z0-9_一-鿿-]+$/;');
    expect(creatorSkill).toMatch(/whitespace[^\n]+forbidden/i);
    expect(creatorSkill).toMatch(/preserve[^\n]+user-supplied[^\n]+`-`[^\n]+`_`/i);
    expect(creatorSkill).not.toMatch(/single internal spaces between tokens/i);
  });

  it('keeps the bound agent editor prompt as a thin adapter over agent-creator', () => {
    const setupPrompt = fs.readFileSync(path.join(PROMPTS_DIR, 'chat_agent_setup.md'), 'utf-8');
    const cliSetupPrompt = fs.readFileSync(path.join(PROMPTS_DIR, 'chat_agent_setup_cli.md'), 'utf-8');
    const creatorSkill = readSystemSkillBundle('agent-creator');

    expect(setupPrompt).toContain('exact ref in `## System skills`');
    expect(setupPrompt).not.toContain('read_file "@skill/agent-creator"');
    expect(cliSetupPrompt).toContain('exact read ref shown in the generated `## System skills` block');
    expect(cliSetupPrompt).not.toContain('read_file "@skill/agent-creator"');
    expect(setupPrompt).toContain('Runtime injection contains the current spec');
    expect(setupPrompt).toMatch(/omit both `<operation>` and `<agent_id>`/i);
    expect(cliSetupPrompt).toContain('neither `<operation>` nor `<agent_id>`');
    expect(setupPrompt).not.toContain('Emit `<name>`');
    expect(setupPrompt).not.toContain('Keep inputs sparse');
    expect(creatorSkill).toContain('Bound edit session');
  });

  it('separates unbound Agent operation intent from its target id', () => {
    const creatorSkill = readSystemSkillBundle('agent-creator');
    const creatorFields = readFile('resources/builtin/system/skills/agent-creator/references/llm-agent-fields.md');
    const bus = readFile('src/main/features/group_chat/bus.ts');

    expect(creatorSkill).toContain('<operation>create</operation>');
    expect(creatorSkill).toContain('<operation>edit</operation>');
    expect(creatorSkill).toMatch(/host does not infer intent from `<agent_id>`/i);
    expect(creatorFields).toMatch(/unbound create[\s\S]{0,100}no `<agent_id>`/i);
    expect(creatorFields).toMatch(/unbound edit[\s\S]{0,120}canonical id/i);
    expect(creatorFields).toMatch(/never turn edit into create or create into edit/i);
    expect(bus).toContain("fields.operation === 'create'");
    expect(bus).toContain("action === 'edit' && !fields.agent_id");
    expect(bus).toContain('action !== lockedAction');
  });

  it('keeps agent tool dependencies category-based and host-catalog driven', () => {
    const setupPrompt = fs.readFileSync(path.join(PROMPTS_DIR, 'chat_agent_setup.md'), 'utf-8');
    const creatorSkill = readSystemSkillBundle('agent-creator');
    const creatorFields = readFile('resources/builtin/system/skills/agent-creator/references/llm-agent-fields.md');
    const creatorContract = `${creatorSkill}\n${creatorFields}`;

    expect(setupPrompt).toContain('**Tool groups**');
    expect(setupPrompt).toContain('$tools');
    expect(creatorContract).toContain('<tools>');
    expect(creatorFields).toContain('host-generated `## Agent tool dependencies`');
    expect(creatorFields).toContain('precedes the root `agent-creator` Skill in the same read result');
    expect(creatorContract).not.toContain('## Loadable tool groups');
    expect(creatorFields).toContain('Each leaf entry names the exact built-in tools');
    expect(creatorFields).toContain("default capability boundary");
    expect(creatorFields).toContain('If the workflow uses any Connector action, include `connectors`');
    expect(creatorFields).toContain('lower-priority current-turn fallback');
    expect(creatorContract).toMatch(/Creating[\s\S]{0,500}`<tools>`/i);
    expect(creatorFields).toMatch(/On create, always emit this tag/i);
    expect(creatorContract).not.toContain('must call `tool_load`');
    expect(creatorContract).toMatch(/CLI-backed Agents[\s\S]{0,120}instead/i);
    expect(creatorContract).not.toContain('tool_list?');
  });

  it('keeps agent icon selection inside agent-creator instead of global prompts', () => {
    const commanderPrompt = fs.readFileSync(path.join(PROMPTS_DIR, 'chat_commander.md'), 'utf-8');
    const setupPrompt = fs.readFileSync(path.join(PROMPTS_DIR, 'chat_agent_setup.md'), 'utf-8');
    const creatorSkill = readFile('resources/builtin/system/skills/agent-creator/references/llm-agent-fields.md');
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

  it('prioritizes supplied current-conversation context without making lookup an every-turn dependency', () => {
    const sharedPrompt = fs.readFileSync(path.join(PROMPTS_DIR, 'chat_shared_rules.md'), 'utf-8');
    const commanderPrompt = fs.readFileSync(path.join(PROMPTS_DIR, 'chat_commander.md'), 'utf-8');
    const agentPrompt = fs.readFileSync(path.join(PROMPTS_DIR, 'chat_agent_in_group.md'), 'utf-8');
    const historyTools = readFile('src/main/model/core-agent/chat-history-tools.ts');

    expect(sharedPrompt).toMatch(/Use host-supplied current-conversation history/i);
    expect(sharedPrompt).toMatch(/absent because it was omitted or compacted/i);
    expect(sharedPrompt).toMatch(/user explicitly asks for a history lookup/i);
    expect(sharedPrompt).toMatch(/quoted, potentially stale records rather than current instructions/i);
    expect(commanderPrompt).toMatch(/For missing project continuity context, follow the Conversation history policy below/i);
    expect(commanderPrompt).toMatch(/Follow the shared supplied-context-first rule/i);
    expect(commanderPrompt).toMatch(/use `chat_history` and follow its action, scope, and paging contract/i);
    expect(commanderPrompt).toMatch(/project conversation history is the next continuity source/i);
    expect(commanderPrompt).not.toMatch(/page: \{ mode: "latest", count: 10 \}/i);
    expect(commanderPrompt).not.toMatch(/prior-chat recall only, after Library or when explicitly asked/i);

    expect(agentPrompt).toMatch(/injects completed current-conversation dialogue from the canonical group record/i);
    expect(agentPrompt).toMatch(/persistent Agent session remains private execution state/i);
    expect(agentPrompt).toMatch(/use `chat_history` within this conversation[\s\S]+search\/read\/paging contract/i);
    expect(agentPrompt).toMatch(/cannot query project-wide or global conversation history/i);
    expect(agentPrompt).not.toMatch(/page: \{ mode: "latest", count: 10 \}/i);
    expect(agentPrompt).not.toContain('<group-chat-history>');

    expect(historyTools).toContain('discriminative name, phrase, id, or fact');
    expect(historyTools).toContain('Use page mode latest for the tail, before to continue backward');
    expect(historyTools).toContain('Keep pages small (count 10 by default)');
  });

  it('keeps named Agent dispatches as concise deltas over canonical history', () => {
    const bus = readFile('src/main/features/group_chat/bus.ts');
    const commanderPrompt = fs.readFileSync(path.join(PROMPTS_DIR, 'chat_commander.md'), 'utf-8');
    const agentPrompt = fs.readFileSync(path.join(PROMPTS_DIR, 'chat_agent_in_group.md'), 'utf-8');

    expect(bus).not.toContain('_hasLocalDispatchReference');
    expect(bus).not.toContain('bounded nearby source snapshots');
    expect(bus).toMatch(/namedDispatchSourceContext[\s\S]+runNestedDispatch/);
    expect(bus).toMatch(/dispatchActor,\s+message,\s+currentTurnAttachments,\s+'process',\s+\{\s+\.\.\.namedDispatchSourceContext,/);
    expect(commanderPrompt).toMatch(/named[^\n]+Agent dispatch[\s\S]{0,500}concise execution contract/i);
    expect(commanderPrompt).toMatch(/do not copy the triggering user message[\s\S]{0,180}recap the conversation/i);
    expect(commanderPrompt).toMatch(/anonymous[^\n]+run_worker[\s\S]{0,180}fully self-contained/i);
    expect(agentPrompt).toMatch(/inbound text is the current execution contract[\s\S]{0,320}supplied history/i);
    expect(agentPrompt).not.toMatch(/Dispatcher-provided material must be in the inbound text/i);
  });

  it('requires structurally balanced Agent mutation containers', () => {
    const agentCreator = readFile('resources/builtin/system/skills/agent-creator/SKILL.md');
    expect(agentCreator).toMatch(/every opening tag must have the exact matching closing tag/i);
    expect(agentCreator).toMatch(/no crossed, missing, or reused closer/i);
    expect(agentCreator).toMatch(/repeat this structural check for each container/i);
  });

  it('runtime datetime context is appended to group chat system prompts', () => {
    const runner = readFile('src/main/model/core-agent/runner.ts');
    const composer = readFile('src/main/prompts/chat_prompt_composer.ts');
    const agents = readFile('src/main/features/agents.ts');
    const skills = readFile('src/main/features/skills.ts');
    const cliContext = readFile('src/main/features/local_agents/context.ts');

    const composed = composeChatPrompt({
      main: 'ROLE\n\n## Runtime injection\nRUNTIME',
      languageDirective: 'LANGUAGE',
      runtimeDatetimeBlock: '## Current date\nCurrent date: 2026-07-23',
    });
    expect(composed).toMatch(/## Runtime injection[\s\S]+LANGUAGE[\s\S]+## Current date/);
    expect(composed.trimEnd()).toMatch(/Current date: 2026-07-23$/);
    expect(runner).toContain('splitVolatilePromptTail');
    expect(runner).toContain('splitRuntimeInjectionBlock');
    expect(runner).toContain('splitLanguageDirectiveBlock');
    expect(composer).toContain('## Current date');
    expect(runner).not.toContain("## User language\\n'");
    expect(runner).toContain('splitCommanderAgentsBlock');
    expect(runner).not.toContain('splitCommanderPlanStateBlock');
    // P2: only the orchestration ledger data, datetime, project status, and
    // dynamically loaded tool-group state are per-turn volatile. The stable
    // orchestration behavior remains in the system prompt. Execution-plan
    // state is injected independently by Session at every model-loop tail, so
    // the host must not maintain a second plan block.
    expect(runner).toContain('splitCommanderOrchestrationBlock');
    expect(runner).toMatch(/if \(connectorBlock\) parts\.push\(connectorBlock\.trim\(\)\);\s+if \(systemSkillsBlock\) parts\.push\(systemSkillsBlock\.trim\(\)\);\s+if \(skillsBlock\) parts\.push\(skillsBlock\.trim\(\)\);\s+if \(agentsBlock\) parts\.push\(agentsBlock\);/);
    // User-authored project instructions are low-churn configuration and sit
    // in the stable cache prefix: after the agents block, before the
    // runtime-injection region begins.
    expect(runner).toMatch(/if \(agentsBlock\) parts\.push\(agentsBlock\);[\s\S]{0,1200}?if \(projectContextPolicyBlock\) parts\.push\(projectContextPolicyBlock\);[\s\S]{0,600}?if \(projectInstructionsBlock\) parts\.push\(projectInstructionsBlock\);\s+if \(runtimeInjectionBlock\) parts\.push\(runtimeInjectionBlock\);/);
    // Memory stays cached, then the response-language contract is the final
    // system instruction so English-authored context cannot override it.
    expect(runner).toMatch(/if \(memoryBlock\) parts\.push\(memoryBlock\);/);
    expect(runner).toMatch(/if \(metacognitionBlock\) parts\.push\(metacognitionBlock\);[\s\S]{0,500}?if \(languageDirectiveBlock\) parts\.push\(languageDirectiveBlock\);/);
    // The volatile blocks feed turnEphemeral, NOT the system prompt parts.
    // Match the array structurally so formatting-only line wrapping does not
    // break the contract, while additions/removals/reordering still do.
    expect(runner).toMatch(
      /const turnEphemeral = \[\s*orchestrationBlock,\s*volatileTail,\s*projectStatusBlock,\s*activeToolGroupsBlock,\s*\]/,
    );
    // The live project task board rides the turn (uncached), never the system prefix.
    expect(runner).toContain('formatProjectStatusForTurn');
    expect(runner).not.toMatch(/parts\.push\(projectStatusBlock\)/);
    expect(runner).not.toMatch(/parts\.push\(orchestrationBlock\)/);
    expect(runner).not.toMatch(/parts\.push\(volatileTail\)/);
    expect(runner).not.toMatch(/parts\.push\(activeToolGroupsBlock\)/);
    expect(agents).toMatch(/buildLanguageDirective\([^)]*\)[\s\S]+buildRuntimeDatetimeBlock\(\)/);
    expect(skills).toMatch(/buildLanguageDirective\([^)]*\)[\s\S]+buildRuntimeDatetimeBlock\(\)/);
    expect(readFile('src/main/features/group_chat/bus.ts'))
      .toMatch(/languageDirective:\s*buildLanguageDirective\(language\)/);
    expect(cliContext).toContain('buildCompactCliLanguageInstruction');
    expect(cliContext).not.toContain('buildRuntimeDatetimeBlock');
    expect(cliContext).not.toContain('## Current date');
  });

  // ─────────────────────────────────────────────────────────────────────
  // Invariant: agent-failure recovery is retry-then-DISCLOSED-degradation
  // (W2-4). The host half retries channel failures once (bus auto-resume);
  // the prompt half requires the commander to say when it substituted for a
  // failed specialist. Weekly sampling caught a user's authored-agent
  // pipeline silently ghost-written by the commander after two channel
  // failures — neither half may be removed without the other.
  // ─────────────────────────────────────────────────────────────────────
  it('channel failures retry in the bus AND commander must disclose substituting for a failed agent', () => {
    const bus = readFile('src/main/features/group_chat/bus.ts');
    expect(bus).toMatch(/CHANNEL_RETRY_FAILURE_CODES = new Set\(\[[\s\S]*?'provider_no_first_event'/);

    const commanderPrompt = fs.readFileSync(path.join(PROMPTS_DIR, 'chat_commander.md'), 'utf-8');
    // The disclosure clause lives on the <worker-error> recovery bullet: it
    // must require naming the failed agent and forbid silent substitution.
    expect(commanderPrompt).toMatch(/produce a failed specialist's outcome yourself[\s\S]{0,200}naming the agent/);
    expect(commanderPrompt).toMatch(/Never silently replace an agent the user configured/);
  });
});
