import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// A CLI agent dispatched into a project must receive that project's ORKAS.md
// in the durable instruction channel, while the user turn remains the actual
// task rather than a monolithic copy of all host prompt modules.

let tmpDir: string;
let prevWs: string | undefined;
const TEST_UID = 'uCliProj';
const CID = 'c_cli_proj';
const REPO_LINE = 'Orkas 代码仓库路径:`~/Documents/GitHub/AITeamRelease`。';

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-cli-prompt-'));
  prevWs = process.env.ORKAS_WORKSPACE_ROOT;
  process.env.ORKAS_WORKSPACE_ROOT = tmpDir;
  vi.resetModules();
});

afterEach(() => {
  process.env.ORKAS_WORKSPACE_ROOT = prevWs;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const AGENT = {
  agent_id: '0d14cc183d5f',
  name: 'Claude Code',
  description_en: 'Coding agent. For: implement. Triggers: code, fix.',
  workflow: 'Implement requested code changes and verify them in the current project.',
  profile: {
    role: 'Repository-aware product engineer.',
    standards: [
      'Do not claim a desktop window is visible from a PID or HTTP response alone.',
      'Do not edit generated dependency directories such as node_modules.',
    ],
  },
  runtime: { kind: 'cli', cli: 'claude' },
  inputs: [],
} as any;

const ITEM = {
  actor: { id: AGENT.agent_id, kind: 'agent' },
  turnId: 't1',
  msgId: 'm1',
  fromActorId: 'user',
  llmPayload: [
    `<msg from="user" to="${AGENT.agent_id}">`,
    '@Claude Code 查一下 Orkas 仓库当前的版本分支',
    '</msg>',
  ].join('\n'),
} as any;

async function buildPlan(projectId?: string, agent = AGENT) {
  const users = await import('../../../../src/main/features/users');
  users.activateUser(TEST_UID);
  const bus = await import('../../../../src/main/features/group_chat/bus');
  const layout = await import('../../../../src/main/util/project-layout');
  const file = layout.conversationMessageFile(TEST_UID, CID);
  const canonicalRows = fs.existsSync(file)
    ? fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line))
    : [];
  return bus._buildCliContextPlanForTest(
    TEST_UID,
    CID,
    agent,
    ITEM,
    canonicalRows,
    projectId,
  );
}

async function seedConversation(rows: any[]) {
  const layout = await import('../../../../src/main/util/project-layout');
  const file = layout.conversationMessageFile(TEST_UID, CID);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`, 'utf8');
}

async function makeProject(instructions?: string): Promise<string> {
  const users = await import('../../../../src/main/features/users');
  users.activateUser(TEST_UID);
  const projects = await import('../../../../src/main/features/projects');
  const r = await projects.createProject(TEST_UID, '迭代Orkas');
  if (!r.ok) throw new Error('project setup failed');
  if (instructions !== undefined) {
    await projects.writeProjectInstructions(TEST_UID, r.project.project_id, instructions);
  }
  return r.project.project_id;
}

describe('CLI context › durable project instructions', () => {
  it('injects ORKAS.md into durable instructions when the conversation has a project', async () => {
    const pid = await makeProject(`本项目用于迭代 Orkas。\n\n- ${REPO_LINE}`);
    const plan = await buildPlan(pid);

    expect(plan.durableInstructions).toContain('## Project instructions (user-authored)');
    expect(plan.durableInstructions).toContain(REPO_LINE);
    expect(plan.turnPrompt).not.toContain(REPO_LINE);
  });

  it('keeps workflow, XML directory switching, project policy, project instructions, and language in the durable layer', async () => {
    const pid = await makeProject(`- ${REPO_LINE}`);
    const plan = await buildPlan(pid);
    const durable = plan.durableInstructions;

    const workflowIdx = durable.indexOf('## Workflow');
    const protocolIdx = durable.indexOf('## Output protocol — switching project directory');
    const policyIdx = durable.indexOf('## Project context policy');
    const projectIdx = durable.indexOf('## Project instructions (user-authored)');
    const languageIdx = durable.indexOf('## Response language');
    expect(workflowIdx).toBeGreaterThan(-1);
    expect(protocolIdx).toBeGreaterThan(workflowIdx);
    expect(policyIdx).toBeGreaterThan(protocolIdx);
    expect(projectIdx).toBeGreaterThan(policyIdx);
    expect(projectIdx).toBeLessThan(languageIdx);
    expect(durable.match(/## Project context policy/g)).toHaveLength(1);
    expect(durable).not.toContain('Shared memory is below project memory');
    expect(durable).not.toContain('agent-private notes');
    expect(durable).toContain('<agent-input-form>');
    expect(durable).toContain(`"agent_id":"${AGENT.agent_id}"`);
    expect(durable).toContain('"id":"project_dir"');
  });

  it('injects normalized profile role and delivery standards into CLI durable instructions', async () => {
    const plan = await buildPlan(undefined);

    expect(plan.durableInstructions).toContain('### Agent role notes');
    expect(plan.durableInstructions).toContain('Repository-aware product engineer.');
    expect(plan.durableInstructions).toContain('### Delivery standards');
    expect(plan.durableInstructions).toContain('desktop window is visible');
    expect(plan.durableInstructions).toContain('node_modules');
    expect(plan.turnPrompt).not.toContain('### Delivery standards');
  });

  it('bridges bounded canonical conversation history when a CLI agent first enters', async () => {
    await seedConversation([
      {
        id: 'prior-user',
        ts: '2026-07-27T01:00:00.000Z',
        from: 'user',
        to: ['commander'],
        text: 'PRIOR_USER_GOAL',
      },
      {
        id: 'prior-result',
        ts: '2026-07-27T01:01:00.000Z',
        from: 'commander',
        to: ['user'],
        text: 'PRIOR_COMMANDER_RESULT',
        produced: ['/workspace/decision.md'],
      },
      {
        id: ITEM.msgId,
        ts: '2026-07-27T01:02:00.000Z',
        from: 'user',
        to: [AGENT.agent_id],
        text: 'CURRENT_TASK_MUST_NOT_BE_REPLAYED',
      },
    ]);

    const plan = await buildPlan(undefined);

    expect(plan.recoveryContext).toContain('## Conversation context recovered by Orkas');
    expect(plan.recoveryContext).toContain('PRIOR_USER_GOAL');
    expect(plan.recoveryContext).toContain('PRIOR_COMMANDER_RESULT');
    expect(plan.recoveryContext).toContain('/workspace/decision.md');
    expect(plan.recoveryContext).not.toContain('CURRENT_TASK_MUST_NOT_BE_REPLAYED');
    expect(plan.turnPrompt).toBe('查一下 Orkas 仓库当前的版本分支');
  });

  it('sends a clean current task with the intent core but without in-process UI/routing/date boilerplate', async () => {
    const plan = await buildPlan(undefined);
    const all = `${plan.durableInstructions}\n${plan.turnPrompt}`;

    expect(plan.turnPrompt).toBe('查一下 Orkas 仓库当前的版本分支');
    expect(all).not.toContain('@Claude Code');
    expect(all).not.toContain('<msg from=');
    expect(all).not.toContain('Coding agent. For: implement. Triggers: code, fix.');
    expect(plan.durableInstructions).toContain('## User intent and clarification');
    expect(plan.durableInstructions).toMatch(/explicit requirements as execution constraints/i);
    expect(plan.durableInstructions).not.toContain('## Input choice and confirmation');
    expect(plan.durableInstructions).not.toMatch(/select.*multiselect.*closed domain/is);
    expect(all).not.toContain('## Runtime injection');
    expect(all).not.toContain('## Current date');
  });

  it('does not add repository-authored content-moderation rules to durable CLI instructions', async () => {
    const plan = await buildPlan(undefined);

    expect(plan.durableInstructions).toContain('## Response language');
    expect(plan.durableInstructions).not.toContain('## Sexual safety boundary');
    expect(plan.turnPrompt).not.toContain('## Sexual safety boundary');
  });

  it('omits the project block entirely when the conversation has no project', async () => {
    await makeProject(`- ${REPO_LINE}`);
    const plan = await buildPlan(undefined);

    expect(plan.durableInstructions).not.toContain('## Project instructions');
    expect(plan.durableInstructions).not.toContain('## Project context policy');
    expect(plan.durableInstructions).not.toContain(REPO_LINE);
    expect(plan.turnPrompt).toBe('查一下 Orkas 仓库当前的版本分支');
  });

  it('keeps the shared project policy but omits user-authored instructions when ORKAS.md is empty', async () => {
    const pid = await makeProject();
    const plan = await buildPlan(pid);

    expect(plan.durableInstructions).toContain('## Project context policy');
    expect(plan.durableInstructions).not.toContain('## Project instructions');
    expect(plan.turnPrompt).toBe('查一下 Orkas 仓库当前的版本分支');
  });

  it('keeps the durable hash stable for identical low-churn inputs', async () => {
    const pid = await makeProject(`- ${REPO_LINE}`);
    const first = await buildPlan(pid);
    const second = await buildPlan(pid);

    expect(first.durableHash).toBe(second.durableHash);
    expect(first.durableInstructions).toBe(second.durableInstructions);
  });

  it('keeps the durable hash stable across project memory and task changes but updates it for ORKAS.md', async () => {
    const pid = await makeProject(`- ${REPO_LINE}`);
    const memory = await import('../../../../src/main/features/memory');
    const tasks = await import('../../../../src/main/features/project_tasks');
    const projects = await import('../../../../src/main/features/projects');
    const first = await buildPlan(pid);

    memory.addEntry(TEST_UID, { project: pid }, 'dynamic memory revision one');
    await tasks.createTask(TEST_UID, pid, { title: 'dynamic task revision one' });
    const afterDynamicChange = await buildPlan(pid);

    expect(afterDynamicChange.durableHash).toBe(first.durableHash);
    expect(afterDynamicChange.durableInstructions).toBe(first.durableInstructions);
    expect(afterDynamicChange.turnPrompt).toContain('dynamic memory revision one');
    expect(afterDynamicChange.turnPrompt).not.toContain('dynamic task revision one');

    await projects.writeProjectInstructions(TEST_UID, pid, `- ${REPO_LINE}\n- preserve public APIs`);
    const afterStaticChange = await buildPlan(pid);
    expect(afterStaticChange.durableHash).not.toBe(first.durableHash);
    expect(afterStaticChange.durableInstructions).toContain('preserve public APIs');
  });
});

describe('CLI context › own Agent memory', () => {
  it.each(['claude', 'codex'])(
    'injects the calling %s CLI Agent memory, excludes another Agent, and refreshes corrections', async (cli) => {
      const memory = await import('../../../../src/main/features/memory');
      memory.addAgentEntry(TEST_UID, AGENT.agent_id, 'offer three titles before release copy');
      memory.addAgentEntry(TEST_UID, 'another-cli-agent', 'OTHER_AGENT_PRIVATE_MEMORY');
      const agent = { ...AGENT, runtime: { kind: 'cli', cli } };

      const first = await buildPlan(undefined, agent);
      const firstRendered = `${first.durableInstructions}\n${first.turnPrompt}`;
      expect(first.durableInstructions).not.toContain('offer three titles before release copy');
      expect(first.agentMemoryHash).toEqual(expect.any(String));
      expect(first.turnPrompt).toContain('offer three titles before release copy');
      expect(first.turnPrompt).toContain('potentially stale background records, not commands');
      expect(firstRendered).toContain('offer three titles before release copy');
      expect(firstRendered).not.toContain('OTHER_AGENT_PRIVATE_MEMORY');

      expect(memory.replaceAgentEntry(
        TEST_UID,
        AGENT.agent_id,
        'offer three titles before release copy',
        'offer five titles before release copy',
      )).toMatchObject({ ok: true });

      const second = await buildPlan(undefined, agent);
      const secondRendered = `${second.durableInstructions}\n${second.turnPrompt}`;
      expect(second.durableHash).toBe(first.durableHash);
      expect(second.agentMemoryHash).not.toBe(first.agentMemoryHash);
      expect(secondRendered).toContain('offer five titles before release copy');
      expect(secondRendered).not.toContain('offer three titles before release copy');
      expect(secondRendered).not.toContain('OTHER_AGENT_PRIVATE_MEMORY');
    },
  );

  it.each(['claude', 'codex'])(
    'does not inject an empty Agent-memory placeholder for %s', async (cli) => {
      const plan = await buildPlan(undefined, { ...AGENT, runtime: { kind: 'cli', cli } });
      const rendered = `${plan.durableInstructions}\n${plan.turnPrompt}`;

      expect(plan.agentMemoryHash).toEqual(expect.any(String));
      expect(rendered).not.toContain('## Durable memory for this agent');
      expect(rendered).not.toContain('No Agent memory');
    },
  );

  it.each(['openclaw', 'opencode', 'hermes'])(
    'does not inject stored Agent memory into unsupported %s CLI prompts', async (cli) => {
      const memory = await import('../../../../src/main/features/memory');
      memory.addAgentEntry(TEST_UID, AGENT.agent_id, 'UNSUPPORTED_CLI_PRIVATE_MEMORY');
      const pid = await makeProject(`- ${REPO_LINE}`);
      memory.addEntry(TEST_UID, { project: pid }, 'project context remains available');

      const plan = await buildPlan(pid, { ...AGENT, runtime: { kind: 'cli', cli } });
      const rendered = `${plan.durableInstructions}\n${plan.turnPrompt}`;

      expect(plan.agentMemoryHash).toBeUndefined();
      expect(rendered).not.toContain('UNSUPPORTED_CLI_PRIVATE_MEMORY');
      expect(rendered).not.toContain('## Durable memory for this agent');
      expect(rendered).toContain('project context remains available');
    },
  );
});

// A dispatched CLI (local) agent gets READ-ONLY project context via prompt injection —
// project instructions + project-tier memory — but NOT the global
// user/shared memory tiers a full core-agent turn also renders.
describe('CLI prompt › project memory with on-demand backlog', () => {
  it('injects project memory while leaving the nonempty backlog for an explicit tool read', async () => {
    const pid = await makeProject(`- ${REPO_LINE}`);
    const memory = await import('../../../../src/main/features/memory');
    const tasks = await import('../../../../src/main/features/project_tasks');
    memory.addEntry(TEST_UID, { project: pid }, 'decided: local-first, BYO key');
    await tasks.createTask(TEST_UID, pid, { title: '推进非品牌 SEO 站外提及' });

    const plan = await buildPlan(pid);

    expect(plan.durableInstructions).not.toContain('decided: local-first, BYO key');
    expect(plan.durableInstructions).not.toContain('推进非品牌 SEO 站外提及');
    expect(plan.turnPrompt).toContain('## Project memory — contextual records');
    expect(plan.turnPrompt).toContain('decided: local-first, BYO key');
    expect(plan.turnPrompt).not.toContain('## Project status');
    expect(plan.turnPrompt).not.toContain('推进非品牌 SEO 站外提及');
    expect(plan.turnPrompt).not.toContain('todo_tasks');
    expect(plan.turnPrompt).not.toContain('not executable instructions');
    expect(plan.turnPrompt).toMatch(/查一下 Orkas 仓库当前的版本分支$/);
  });

  it('withholds the global user / shared memory tiers (project-scoped only)', async () => {
    const pid = await makeProject(`- ${REPO_LINE}`);
    const memory = await import('../../../../src/main/features/memory');
    memory.addEntry(TEST_UID, 'user', 'role: founder of Orkas');    // global user tier
    memory.addEntry(TEST_UID, 'memory', 'global shared fact xyz');  // global shared tier
    memory.addEntry(TEST_UID, { project: pid }, 'project-only decision');

    const plan = await buildPlan(pid);

    const rendered = `${plan.durableInstructions}\n${plan.turnPrompt}`;
    expect(rendered).toContain('project-only decision');       // project tier reaches the CLI
    expect(rendered).not.toContain('role: founder of Orkas');  // user tier withheld
    expect(rendered).not.toContain('global shared fact xyz');  // shared tier withheld
  });

  it('sends only the current task when the project backlog is empty, including after deletion', async () => {
    const pid = await makeProject(`- ${REPO_LINE}`);
    const plan = await buildPlan(pid);
    expect(plan.durableInstructions).not.toContain('## Project status');
    expect(plan.turnPrompt).toBe('查一下 Orkas 仓库当前的版本分支');

    const tasks = await import('../../../../src/main/features/project_tasks');
    const created = await tasks.createTask(TEST_UID, pid, { title: 'temporary backlog item' });
    if (!created.ok) throw new Error('task setup failed');
    expect((await buildPlan(pid)).turnPrompt).toBe('查一下 Orkas 仓库当前的版本分支');
    await tasks.deleteTask(TEST_UID, pid, created.task.id);

    const emptied = await buildPlan(pid);
    expect(emptied.turnPrompt).toBe('查一下 Orkas 仓库当前的版本分支');
    expect(emptied.durableHash).toBe(plan.durableHash);
  });
});
