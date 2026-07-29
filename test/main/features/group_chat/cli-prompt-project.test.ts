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

async function buildPlan(projectId?: string, slice: any[] = []) {
  const users = await import('../../../../src/main/features/users');
  users.activateUser(TEST_UID);
  const bus = await import('../../../../src/main/features/group_chat/bus');
  return bus._buildCliContextPlanForTest(TEST_UID, CID, AGENT, ITEM, slice, projectId);
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

  it('keeps workflow, XML directory switching, project rules, and language in the durable layer', async () => {
    const pid = await makeProject(`- ${REPO_LINE}`);
    const plan = await buildPlan(pid);
    const durable = plan.durableInstructions;

    const workflowIdx = durable.indexOf('## Workflow');
    const protocolIdx = durable.indexOf('## Output protocol — switching project directory');
    const projectIdx = durable.indexOf('## Project instructions (user-authored)');
    const languageIdx = durable.indexOf('## Response language');
    expect(workflowIdx).toBeGreaterThan(-1);
    expect(protocolIdx).toBeGreaterThan(workflowIdx);
    expect(projectIdx).toBeGreaterThan(protocolIdx);
    expect(projectIdx).toBeLessThan(languageIdx);
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

  it('bridges a bounded static handoff when a CLI agent first enters an existing conversation', async () => {
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

    expect(plan.recoveryContext).toContain('<agent-handoff source="orkas-static">');
    expect(plan.recoveryContext).toContain('PRIOR_USER_GOAL');
    expect(plan.recoveryContext).toContain('PRIOR_COMMANDER_RESULT');
    expect(plan.recoveryContext).toContain('/workspace/decision.md');
    expect(plan.recoveryContext).not.toContain('CURRENT_TASK_MUST_NOT_BE_REPLAYED');
    expect(plan.turnPrompt).toBe('查一下 Orkas 仓库当前的版本分支');
  });

  it('prefers the agent visibility slice and does not duplicate a static handoff', async () => {
    await seedConversation([
      {
        id: 'prior-commander-only',
        ts: '2026-07-27T01:00:00.000Z',
        from: 'commander',
        to: ['user'],
        text: 'STATIC_CONTEXT_SHOULD_NOT_DUPLICATE',
      },
      {
        id: ITEM.msgId,
        ts: '2026-07-27T01:02:00.000Z',
        from: 'user',
        to: [AGENT.agent_id],
        text: 'current',
      },
    ]);
    const plan = await buildPlan(undefined, [{
      id: 'visible-agent-context',
      ts: '2026-07-27T01:01:00.000Z',
      from: 'user',
      to: [AGENT.agent_id],
      text: 'DIRECT_AGENT_CONTEXT',
    }]);

    expect(plan.recoveryContext).toContain('DIRECT_AGENT_CONTEXT');
    expect(plan.recoveryContext).not.toContain('<agent-handoff source="orkas-static">');
    expect(plan.recoveryContext).not.toContain('STATIC_CONTEXT_SHOULD_NOT_DUPLICATE');
  });

  it('sends a clean current task and excludes routing/catalog/date/intent boilerplate', async () => {
    const plan = await buildPlan(undefined);
    const all = `${plan.durableInstructions}\n${plan.turnPrompt}`;

    expect(plan.turnPrompt).toBe('查一下 Orkas 仓库当前的版本分支');
    expect(all).not.toContain('@Claude Code');
    expect(all).not.toContain('<msg from=');
    expect(all).not.toContain('Coding agent. For: implement. Triggers: code, fix.');
    expect(all).not.toContain('## User intent and clarification');
    expect(all).not.toContain('explicit user requirements as the primary execution constraints');
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
    expect(plan.durableInstructions).not.toContain(REPO_LINE);
    expect(plan.turnPrompt).toBe('查一下 Orkas 仓库当前的版本分支');
  });

  it('omits the project block when the project has no ORKAS.md yet', async () => {
    const pid = await makeProject();
    const plan = await buildPlan(pid);

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
});
