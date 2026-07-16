import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// A CLI agent dispatched into a project must receive that project's
// ORKAS.md. Before this was wired, `_buildCliPrompt` never took a projectId,
// so standing instructions (e.g. "the repo is at ~/Documents/GitHub/X")
// silently never reached the CLI and it guessed the repo from cwd instead.

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
  description_en: 'Coding agent.',
  runtime: { kind: 'cli', cli: 'claude' },
  inputs: [],
} as any;

const ITEM = {
  actor: { id: AGENT.agent_id, kind: 'agent' },
  turnId: 't1',
  msgId: 'm1',
  fromActorId: 'user',
  llmPayload: '<msg from="user">查一下 Orkas 仓库当前的版本分支</msg>',
} as any;

async function buildPrompt(projectId?: string): Promise<string> {
  const users = await import('../../../../src/main/features/users');
  users.activateUser(TEST_UID);
  const bus = await import('../../../../src/main/features/group_chat/bus');
  return bus._buildCliPromptForTest(TEST_UID, CID, AGENT, ITEM, [], false, projectId);
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

describe('CLI prompt › project instructions', () => {
  it('injects ORKAS.md when the conversation is scoped to a project', async () => {
    const pid = await makeProject(`本项目用于迭代 Orkas。\n\n- ${REPO_LINE}`);
    const prompt = await buildPrompt(pid);

    expect(prompt).toContain('## Project instructions (user-authored)');
    // The whole point: the user's repo path actually reaches the CLI.
    expect(prompt).toContain(REPO_LINE);
  });

  it('places the project block in the stable prefix, ahead of the runtime region', async () => {
    const pid = await makeProject(`- ${REPO_LINE}`);
    const prompt = await buildPrompt(pid);

    const projectIdx = prompt.indexOf('## Project instructions (user-authored)');
    const runtimeIdx = prompt.indexOf('## Runtime injection');
    const taskIdx = prompt.indexOf('## Your task');
    expect(projectIdx).toBeGreaterThan(-1);
    expect(runtimeIdx).toBeGreaterThan(-1);
    // Low-churn config sits before the per-turn region so the CLI's prompt
    // cache stays stable across turns.
    expect(projectIdx).toBeLessThan(runtimeIdx);
    expect(projectIdx).toBeLessThan(taskIdx);
  });

  it('omits the block entirely for a conversation with no project', async () => {
    await makeProject(`- ${REPO_LINE}`);
    const prompt = await buildPrompt(undefined);

    expect(prompt).not.toContain('## Project instructions');
    expect(prompt).not.toContain(REPO_LINE);
    // The frame itself is intact — only the project slot is empty.
    expect(prompt).toContain('## Your task');
    expect(prompt).toContain('## Runtime injection');
  });

  it('omits the block when the project has no ORKAS.md yet', async () => {
    const pid = await makeProject();
    const prompt = await buildPrompt(pid);

    expect(prompt).not.toContain('## Project instructions');
    expect(prompt).toContain('## Your task');
  });

  it('leaves no unsubstituted $project_block placeholder in any case', async () => {
    const withPid = await buildPrompt(await makeProject(`- ${REPO_LINE}`));
    const withoutPid = await buildPrompt(undefined);
    expect(withPid).not.toContain('$project_block');
    expect(withoutPid).not.toContain('$project_block');
  });
});
