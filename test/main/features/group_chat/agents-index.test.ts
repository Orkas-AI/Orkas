// Pin the `agents_index` block format used by `buildCommanderSystemPrompt`.
//
// Format (one entry per agent, ordered by insertion):
//   `\`read_files({"paths":[{"path":"<ROOT>/<id>/agent.json"}]})\` — ROOT by Source:`
//   `- builtin: <abs path>`
//   `- platform: <abs path>`
//   `- custom:  <abs path>`
//   `Use these ROOT values verbatim. \`id:\` is tool-call input only — prose mentions agents as @<name>.`
//   ``
//   `- @<name> (Source: builtin|platform|custom, id: <agent_id>) — desc`
//   `  interactive: true`                         ← optional, only when interactive=true
//
// Why these fixtures matter (added 2026-05): the prior format hid agent_id
// (to discourage hex-id leak in user prose) and put paths in a separate
// `## Resource locations` section, forcing commander to do a 2-step
// search_files + read_file dance to load any existing agent's spec. The
// new format inlines `id:` per entry + ROOT values right next to the
// entries, so commander goes 1 round-trip. Shipping this regression once
// would mean either (a) ROOT values gone → LLM falls back on training-prior
// `/data/custom/agents/<id>/` paths and trips E_PATH_OUT_OF_SCOPE, or
// (b) `id:` gone → commander can't find agent.json without the dance.
// The "@<name> in prose" hint relies on the existing `@<id>→@<name>`
// rewrite chain in router.ts; both layers together keep hex IDs out of
// user-visible bubbles.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

let tmpDir: string;
let prevWs: string | undefined;
const TEST_UID = 'u-agents-idx';

function customAgentsDir(): string {
  return path.join(tmpDir, TEST_UID, 'cloud', 'agents');
}
function builtinAgentsDir(): string {
  return path.join(tmpDir, TEST_UID, 'local', 'marketplace', 'agents');
}

function writeAgent(root: string, agent_id: string, body: Record<string, unknown>, installMeta?: Record<string, unknown>) {
  const dir = path.join(root, agent_id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'agent.json'),
    JSON.stringify({ agent_id, created_at: '2026-01-01', updated_at: '2026-01-01', ...body }),
  );
  if (installMeta) {
    fs.writeFileSync(path.join(dir, '_install.json'), JSON.stringify(installMeta));
  }
}

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-agentsidx-'));
  prevWs = process.env.ORKAS_WORKSPACE_ROOT;
  process.env.ORKAS_WORKSPACE_ROOT = tmpDir;
  // Force fresh module loads so per-uid roots (resolved at paths.ts import time
  // for module-level constants) align with the test ORKAS_WORKSPACE_ROOT.
  vi.resetModules();
  const users = await import('../../../../src/main/features/users');
  users.activateUser(TEST_UID);
});

afterEach(() => {
  process.env.ORKAS_WORKSPACE_ROOT = prevWs;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

async function buildBlock(uid: string): Promise<string> {
  const bus = await import('../../../../src/main/features/group_chat/bus');
  return bus._buildAgentsIndexBlockForTest(uid);
}

describe('agents_index block — header + per-entry shape', () => {
  it('header carries Read pattern, resolved ROOT values, and anti-prior warning', async () => {
    writeAgent(customAgentsDir(), 'a1b2c3d4', { name: 'Alpha', description_zh: 'A', description_en: 'A' });
    writeAgent(builtinAgentsDir(), 'e5f6a7b8', { name: 'Beta', description_zh: 'B', description_en: 'B' });
    const text = await buildBlock(TEST_UID);
    expect(text).toContain('`read_files({"paths":[{"path":"<ROOT>/<id>/agent.json"}]})`');
    expect(text).toContain(`- builtin: ${path.resolve(builtinAgentsDir())}`);
    expect(text).toContain(`- platform: ${path.resolve(builtinAgentsDir())}`);
    expect(text).toContain(`- custom:  ${path.resolve(customAgentsDir())}`);
    expect(text).toContain('Use these ROOT values verbatim');
    expect(text).toContain('@<name>');
  });

  it('labels marketplace and packaged-seed agents distinctly', async () => {
    writeAgent(builtinAgentsDir(), 'platform-agent', { name: 'PlatformAgent', description_zh: 'P', description_en: 'P' });
    writeAgent(builtinAgentsDir(), 'builtin-agent', { name: 'BuiltinAgent', description_zh: 'B', description_en: 'B' }, { seed_source: 'builtin' });
    const text = await buildBlock(TEST_UID);
    expect(text).toContain('@PlatformAgent (Source: platform, id: platform-agent) — P');
    expect(text).toContain('@BuiltinAgent (Source: builtin, id: builtin-agent) — B');
  });

  it('entry includes id: <agent_id> next to Source — commander needs it for read_file + <agent_id> sub-tag', async () => {
    writeAgent(customAgentsDir(), 'a1b2c3d4e5f6', { name: 'Reviewer', description_zh: 'R', description_en: 'R' });
    const text = await buildBlock(TEST_UID);
    expect(text).toContain('@Reviewer (Source: custom, id: a1b2c3d4e5f6)');
  });

  it('keeps declared inputs private to the target agent instead of requiring a commander pre-read', async () => {
    writeAgent(customAgentsDir(), 'agent-with-inputs', {
      name: 'WithInputs',
      description_zh: 'I',
      description_en: 'I',
      inputs: [{
        id: 'topic',
        type: 'text',
        required: true,
        default: '',
        label: 'Topic',
        description: 'should be stripped',
        options: [{ value: 'a', label: 'A' }],
        min: 1,
        max: 3,
      }],
    });
    const text = await buildBlock(TEST_UID);
    expect(text).toContain('@WithInputs (Source: custom, id: agent-with-inputs) — I');
    expect(text).not.toContain('inputs: read agent.json before dispatch');
    expect(text).not.toContain('inputs_schema:');
    expect(text).not.toContain('"topic"');
    expect(text).not.toContain('"should be stripped"');
    expect(text).not.toContain('"Topic"');
    expect(text).not.toContain('"options"');
    expect(text).not.toContain('"default"');
    expect(text).not.toContain('"min"');
    expect(text).not.toContain('"max"');
  });

  it('allows agents without inputs to use the same direct-dispatch roster shape', async () => {
    writeAgent(customAgentsDir(), 'agent-no-inputs', {
      name: 'NoInputs',
      description_zh: 'N',
      description_en: 'N',
      inputs: [],
    });
    const text = await buildBlock(TEST_UID);
    expect(text).toContain('@NoInputs (Source: custom, id: agent-no-inputs) — N');
    expect(text).not.toContain('inputs: read agent.json before dispatch');
  });

  it('marks interactive agents so commander can plan human-in-loop steps', async () => {
    writeAgent(customAgentsDir(), 'interactive-agent', {
      name: 'InteractiveTutor',
      description_zh: 'I',
      description_en: 'I',
      interactive: true,
    });
    const text = await buildBlock(TEST_UID);
    expect(text).toContain('@InteractiveTutor (Source: custom, id: interactive-agent) — I');
    expect(text).toContain('interactive: true');
  });

  it('renders no marker lines for a plain agent (no inputs, non-interactive)', async () => {
    writeAgent(customAgentsDir(), 'plain-agent', {
      name: 'PlainAgent',
      description_zh: 'P',
      description_en: 'P',
    });
    const text = await buildBlock(TEST_UID);
    expect(text).toContain('@PlainAgent (Source: custom, id: plain-agent) — P');
    expect(text).not.toContain('interactive:');
    expect(text).not.toContain('inputs: read agent.json');
  });

  it('preserves Chinese routing clauses that fit the roster budget', async () => {
    writeAgent(customAgentsDir(), 'long-desc', {
      name: 'LongDesc',
      description_zh: '整理市场资料并输出摘要；适合竞品分析；触发词：市场、竞品',
      description_en: '',
    });
    const text = await buildBlock(TEST_UID);
    expect(text).toContain(
      '@LongDesc (Source: custom, id: long-desc) — 整理市场资料并输出摘要；适合竞品分析；触发词：市场、竞品',
    );
  });

  it('preserves English routing clauses that fit the roster budget', async () => {
    writeAgent(customAgentsDir(), 'english-desc', {
      name: 'EnglishDesc',
      description_zh: '',
      description_en: 'Review pull requests. Suitable for static analysis and regression checks. Triggers: PR, review.',
    });
    const text = await buildBlock(TEST_UID);
    expect(text).toContain(
      '@EnglishDesc (Source: custom, id: english-desc) — Review pull requests. Suitable for static analysis and regression checks. Triggers: PR, review.',
    );
  });

  it('keeps a full authored routing description that exceeds the Skill roster ceiling', async () => {
    // Built-in agent descriptions carry phrasings plus a trailing trigger list
    // and run past 512 characters; the Skill ceiling used to cut exactly the
    // trigger terms the Commander routes on.
    const triggers = 'Triggers: deep research, evidence analysis, literature review, trend report, industry research, source verification, citation check, research plan.';
    const description = `${'Run multi-source research and deliver a cited report. '.repeat(10)}${triggers}`;
    expect(description.length).toBeGreaterThan(512);
    expect(description.length).toBeLessThanOrEqual(800);
    writeAgent(customAgentsDir(), 'long-routing', {
      name: 'LongRouting',
      description_zh: '',
      description_en: description,
    });
    const text = await buildBlock(TEST_UID);
    expect(text).toContain(`@LongRouting (Source: custom, id: long-routing) — ${description}`);
    expect(text).not.toContain('…');
  });

  it('still bounds a runaway description at the agent roster ceiling', async () => {
    const description = `${'Do everything for every request. '.repeat(30)}Triggers: tail-marker`;
    expect(description.length).toBeGreaterThan(800);
    writeAgent(customAgentsDir(), 'runaway', {
      name: 'Runaway',
      description_zh: '',
      description_en: description,
    });
    const text = await buildBlock(TEST_UID);
    const line = text.split('\n').find((row) => row.startsWith('- @Runaway')) ?? '';
    expect(line).toContain('(Source: custom, id: runaway) — Do everything');
    expect(line.endsWith('…')).toBe(true);
    expect(line).not.toContain('tail-marker');
    expect(line.length).toBeLessThan(description.length);
  });

  it('uses English for the internal roster under a Chinese UI and falls back to Chinese', async () => {
    writeAgent(customAgentsDir(), 'bilingual-desc', {
      name: 'BilingualDesc',
      description_zh: '中文路由说明不应进入内部索引',
      description_en: 'English routing description.',
    });
    writeAgent(customAgentsDir(), 'zh-fallback', {
      name: 'ZhFallback',
      description_zh: '只有中文时保留此说明',
      description_en: '',
    });
    const bus = await import('../../../../src/main/features/group_chat/bus');
    const text = await bus._buildAgentsIndexBlockForTest(TEST_UID, 'zh');

    expect(text).toContain('@BilingualDesc (Source: custom, id: bilingual-desc) — English routing description.');
    expect(text).not.toContain('中文路由说明不应进入内部索引');
    expect(text).toContain('@ZhFallback (Source: custom, id: zh-fallback) — 只有中文时保留此说明');
  });

  it('returns header + (no agents) when no agents are present', async () => {
    const text = await buildBlock(TEST_UID);
    expect(text).toContain('`read_files({"paths":[{"path":"<ROOT>/<id>/agent.json"}]})`');
    expect(text).toContain('(no agents)');
  });
});

describe('Commander project-task prompt gating', () => {
  it('keeps project rules static and omits them entirely outside a project', async () => {
    const bus = await import('../../../../src/main/features/group_chat/bus');
    const chats = await import('../../../../src/main/features/chats');
    const projects = await import('../../../../src/main/features/projects');
    const createdProject = await projects.createProject(TEST_UID, 'Prompt contract');
    if (!createdProject.ok) throw new Error('Project fixture creation failed');
    const projectId = createdProject.project.project_id;
    await chats.createConversation(TEST_UID, { conversationId: 'non-project-conversation', title: 'Direct work' });
    await chats.createConversation(TEST_UID, { conversationId: 'project-conversation', projectId, title: 'Project work' });
    const nonProject = await bus._buildCommanderSystemPromptForTest(
      TEST_UID,
      'non-project-conversation',
      undefined,
      'en',
    );
    const project = await bus._buildCommanderSystemPromptForTest(
      TEST_UID,
      'project-conversation',
      projectId,
      'en',
    );

    expect(nonProject).not.toContain('### Project tasks (the work backlog)');
    expect(nonProject).not.toContain('$project_tasks_rules');
    expect(project).toContain('### Project tasks (the work backlog)');
    expect(project).not.toContain('$project_tasks_rules');
    expect(project.indexOf('### Project tasks (the work backlog)'))
      .toBeLessThan(project.indexOf('## Runtime injection'));
    expect(nonProject).not.toContain('## Orchestration continuity');
    expect(project).not.toContain('## Orchestration continuity');
    for (const prompt of [nonProject, project]) {
      // Both Commander variants must support useful execution-time prose;
      // neither requires a preamble before the first tool.
      expect(prompt).toContain('one or two sentences when appropriate');
      expect(prompt.match(/These updates are not final replies/g)).toHaveLength(1);
      expect(prompt.indexOf('These updates are not final replies')).toBeLessThan(prompt.indexOf('## Runtime injection'));
      expect(prompt.includes('before the first tool call')).toBe(false);
    }
  });
});
