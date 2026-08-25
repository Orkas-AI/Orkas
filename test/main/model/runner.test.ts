import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import type { AgentSummary } from '../../../src/main/features/agents';

// runner.ts dynamically imports core-agent when building a real runner, but
// the auth gate fires BEFORE that import — so these tests can exercise the
// missing-credential path without core-agent being resolvable/installed.

let tmpDir: string;
let prevWs: string | undefined;
let prevAnthropicKey: string | undefined;
let prevToolLoadingMode: string | undefined;

const CONTENT_WRITER_AGENT_ID = '173d4235a431';
const OFFICE_WORKER_AGENT_ID = 'a19101ba698a';
const IMAGE_STUDIO_AGENT_ID = '814b61b027f0';
const VIDEO_STUDIO_AGENT_ID = '79df9cc89f5f';

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-runner-'));
  prevWs = process.env.ORKAS_WORKSPACE_ROOT;
  prevAnthropicKey = process.env.ANTHROPIC_API_KEY;
  prevToolLoadingMode = process.env.ORKAS_TOOL_LOADING_MODE;
  process.env.ORKAS_WORKSPACE_ROOT = tmpDir;
  delete process.env.ANTHROPIC_API_KEY;
  vi.resetModules();
});

afterEach(() => {
  vi.doUnmock('@earendil-works/pi-ai/oauth');
  vi.doUnmock('#core-agent');
  vi.doUnmock('../../../src/main/model/core-agent/video-studio-tool');
  vi.doUnmock('../../../src/main/model/core-agent/image-studio-tool');
  vi.doUnmock('../../../src/main/model/core-agent/connector-meta-tools');
  process.env.ORKAS_WORKSPACE_ROOT = prevWs;
  if (prevAnthropicKey === undefined) delete process.env.ANTHROPIC_API_KEY;
  else process.env.ANTHROPIC_API_KEY = prevAnthropicKey;
  if (prevToolLoadingMode === undefined) delete process.env.ORKAS_TOOL_LOADING_MODE;
  else process.env.ORKAS_TOOL_LOADING_MODE = prevToolLoadingMode;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

async function loadRunner() {
  return import('../../../src/main/model/core-agent/runner');
}

describe('runner › buildRunner auth gate', () => {
  it('throws a clear "no model configured" error when no entries exist and no env fallback', async () => {
    // Fresh tmpDir → no workspace/auth/auth-profiles.json → pickChatEntry
    // returns null. ANTHROPIC_API_KEY cleared in beforeEach.
    const { buildRunner } = await loadRunner();
    await expect(buildRunner({ sessionId: 'u1-gconv-x' })).rejects.toThrow(
      /No model configured/,
    );
  });

  it('includes a hint pointing the user to the settings page', async () => {
    const { buildRunner } = await loadRunner();
    await expect(buildRunner({ sessionId: 'u1-gconv-x' })).rejects.toThrow(
      /API key.*Settings|Settings.*API key/i,
    );
  });

  it('skips the auth gate when ANTHROPIC_API_KEY is set (dev fallback)', async () => {
    // With the env var set, the gate passes through to core-agent init.
    // We only need to verify the gate's error is NOT raised — any later
    // failure (e.g. core-agent module resolution, session file IO) means
    // the gate already let this request through.
    process.env.ANTHROPIC_API_KEY = 'sk-ant-test-placeholder';
    const { buildRunner } = await loadRunner();
    let err: unknown;
    try {
      await buildRunner({ sessionId: 'u1-gconv-x' });
    } catch (e) {
      err = e;
    }
    // Either it succeeded (unlikely in unit test) or failed for a reason
    // OTHER than the auth gate.
    if (err) expect((err as Error).message).not.toMatch(/No model configured/);
  });

  it('throws the "no model configured" error when auth-profiles.json has empty entries', async () => {
    // Simulate a user who opened settings, saved nothing, ended up with an
    // empty profiles file — pickChatEntry still returns null.
    const authDir = path.join(tmpDir, 'auth');
    fs.mkdirSync(authDir, { recursive: true });
    fs.writeFileSync(
      path.join(authDir, 'auth-profiles.json'),
      JSON.stringify({ profiles: {}, entries: [] }),
    );
    const { buildRunner } = await loadRunner();
    await expect(buildRunner({ sessionId: 'u1-gconv-x' })).rejects.toThrow(
      /No model configured/,
    );
  });

  it('reports a temporary model pause when the only configured entry has credential cooldown', async () => {
    const users = await import('../../../src/main/features/users');
    users.activateUser('runnercooldown');
    const i18n = await import('../../../src/main/i18n');
    i18n.setCurrentLang('en');
    const auth = await import('../../../src/main/features/auth');
    const cooldown = await import('../../../src/main/model/core-agent/profile-cooldown');

    const profile = await auth.addApiKey('anthropic', 'k-cooldown-xxxxxxxx');
    await auth.addEntry({
      provider: 'anthropic',
      model: 'claude-opus-4-8',
      profileId: profile.profileId,
    });
    cooldown.markCooldown(profile.profileId, 'auth', 'invalid key', 30_000);

    const { buildRunner } = await loadRunner();
    let message = '';
    try {
      await buildRunner({ sessionId: 'u1-gconv-x' });
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toMatch(/configured model is temporarily unavailable/i);
    expect(message).not.toMatch(/30s|30 seconds|seconds?/i);
  });

  it('snapshots one turn model while a later runner build reads the reordered selection', async () => {
    const uid = 'runner-model-switch';
    const users = await import('../../../src/main/features/users');
    const auth = await import('../../../src/main/features/auth');
    users.activateUser(uid);

    const anthropic = await auth.addApiKey('anthropic', 'k-anthropic-model-switch', 'Anthropic');
    const openai = await auth.addApiKey('openai', 'k-openai-model-switch', 'OpenAI');
    const modelA = await auth.addEntry({
      provider: 'anthropic',
      model: 'claude-opus-5',
      profileId: anthropic.profileId,
    });
    const modelB = await auth.addEntry({
      provider: 'openai',
      model: 'gpt-5.6-sol',
      profileId: openai.profileId,
    });
    await auth.reorderEntries([modelA.entryId, modelB.entryId]);

    const { buildRunner } = await loadRunner();
    const activeTurn = await buildRunner({
      sessionId: 'gconv-model-switch-active',
      userId: uid,
    });
    expect(activeTurn).toMatchObject({
      entryId: modelA.entryId,
      providerId: 'anthropic',
      modelId: 'claude-opus-5',
    });

    await auth.reorderEntries([modelB.entryId, modelA.entryId]);
    expect(activeTurn).toMatchObject({
      entryId: modelA.entryId,
      providerId: 'anthropic',
      modelId: 'claude-opus-5',
    });

    const nextTurn = await buildRunner({
      sessionId: 'gconv-model-switch-next',
      userId: uid,
    });
    expect(nextTurn).toMatchObject({
      entryId: modelB.entryId,
      providerId: 'openai',
      modelId: 'gpt-5.6-sol',
    });
  });

  it('reuses transient failure guidance scope only for the same persisted model session', async () => {
    // Repeated guidance must survive normal turns in one session, while a
    // different conversation starts clean. Object identity is the contract
    // consumed by event-mapper; session-store's existing uid+session cache
    // cases independently protect cross-account identity.
    const uid = 'runner-failure-guidance-scope';
    const users = await import('../../../src/main/features/users');
    const auth = await import('../../../src/main/features/auth');
    users.activateUser(uid);
    const profile = await auth.addApiKey('anthropic', 'k-failure-guidance-scope', 'Anthropic');
    await auth.addEntry({
      provider: 'anthropic',
      model: 'claude-opus-5',
      profileId: profile.profileId,
    });

    const { buildRunner } = await loadRunner();
    const firstTurn = await buildRunner({
      sessionId: 'gconv-failure-guidance-a',
      userId: uid,
    });
    const nextTurn = await buildRunner({
      sessionId: 'gconv-failure-guidance-a',
      userId: uid,
    });
    const otherConversation = await buildRunner({
      sessionId: 'gconv-failure-guidance-b',
      userId: uid,
    });

    expect(nextTurn.failureTrackingScope).toBe(firstTurn.failureTrackingScope);
    expect(otherConversation.failureTrackingScope).not.toBe(firstTurn.failureTrackingScope);
  });

  it('builds one run-scoped Skill ref table and reuses it in read_files', async () => {
    const uid = 'runner-skill-ref';
    const users = await import('../../../src/main/features/users');
    const auth = await import('../../../src/main/features/auth');
    const paths = await import('../../../src/main/paths');
    users.activateUser(uid);
    const profile = await auth.addApiKey('anthropic', 'k-runner-skill-ref', 'Anthropic');
    await auth.addEntry({
      provider: 'anthropic',
      model: 'claude-opus-5',
      profileId: profile.profileId,
    });

    const skillRoot = path.join(paths.userSkillsDir(uid), 'internal-skill-id');
    fs.mkdirSync(path.join(skillRoot, 'references'), { recursive: true });
    fs.writeFileSync(
      path.join(skillRoot, 'SKILL.md'),
      '---\nname: readable-skill\ndescription: Runtime binding test\n---\nmain body',
    );
    fs.writeFileSync(path.join(skillRoot, 'references', 'guide.md'), 'nested guide');

    const { buildRunner } = await loadRunner();
    const built = await buildRunner({
      sessionId: 'gconv-runner-skill-ref',
      userId: uid,
      skillList: ['internal-skill-id'],
    });

    expect(built.resolvedSystemPrompt).toContain('read ref: @skill/readable-skill');
    expect(built.resolvedSystemPrompt).not.toContain(paths.userSkillsDir(uid));
    expect(built.skillMetadataByReadRef.get('readable-skill')).toEqual({
      id: 'internal-skill-id',
      name: 'readable-skill',
      source: 'custom',
    });
    expect(built.skillMetadataByReadRef.get('internal-skill-id')).toEqual({
      id: 'internal-skill-id',
      name: 'readable-skill',
      source: 'custom',
    });
    expect(JSON.stringify([...built.skillMetadataByReadRef]))
      .not.toContain(skillRoot);
    const readFile = (built.runner as unknown as { tools: Map<string, any> }).tools.get('read_files');
    const entry = await readFile.execute(
      { paths: [{ path: '@skill/readable-skill' }] },
      { workingDir: tmpDir, state: new Map(), signal: undefined } as any,
    );
    const reference = await readFile.execute(
      { paths: [{ path: '@skill/readable-skill/references/guide.md' }] },
      { workingDir: tmpDir, state: new Map(), signal: undefined } as any,
    );
    expect(entry.isError).toBeFalsy();
    expect(built.resolvedSystemPrompt).not.toContain('## Skill runtime requirements');
    expect(entry.content.indexOf('## Skill runtime requirements')).toBeGreaterThanOrEqual(0);
    expect(entry.content).toContain('never install or upgrade those runtimes');
    expect(entry.content).toContain('creator protocol still applies');
    expect(entry.content).toContain('main body');
    expect(reference.isError).toBeFalsy();
    expect(reference.content).toContain('nested guide');
    expect(reference.content).not.toContain('## Skill runtime requirements');
  });

  it('loads a Skill through its run-scoped ref and executes its resource-dependent script through the standard runner', async () => {
    const uid = 'runner-skill-execution';
    const users = await import('../../../src/main/features/users');
    const auth = await import('../../../src/main/features/auth');
    const paths = await import('../../../src/main/paths');
    const permissions = await import('../../../src/main/features/permissions');
    users.activateUser(uid);
    permissions.setLocalExecMode('all_files_auto');
    const profile = await auth.addApiKey('anthropic', 'k-runner-skill-execution', 'Anthropic');
    await auth.addEntry({
      provider: 'anthropic',
      model: 'claude-opus-5',
      profileId: profile.profileId,
    });

    const skillRoot = path.join(paths.userSkillsDir(uid), 'internal-executable-id');
    fs.mkdirSync(path.join(skillRoot, 'scripts'), { recursive: true });
    fs.mkdirSync(path.join(skillRoot, 'templates'), { recursive: true });
    fs.mkdirSync(path.join(skillRoot, 'assets'), { recursive: true });
    fs.writeFileSync(
      path.join(skillRoot, 'SKILL.md'),
      [
        '---',
        'name: executable-skill',
        'description: Runtime read and execution integration test',
        '---',
        'Read templates/report.md, then run:',
        '"$ORKAS_NODE" "$ORKAS_PC_DIR/bin/run-skill.cjs" executable-skill render -- --topic <topic>',
      ].join('\n'),
    );
    fs.writeFileSync(path.join(skillRoot, 'templates', 'report.md'), 'Report: {{topic}}\n');
    fs.writeFileSync(path.join(skillRoot, 'assets', 'settings.json'), JSON.stringify({ mode: 'strict' }));
    fs.writeFileSync(
      path.join(skillRoot, 'scripts', 'render.js'),
      [
        'const fs = require("node:fs");',
        'const path = require("node:path");',
        'module.exports = async ({ args, skillId, skillDir }) => ({',
        '  topic: args.at(-1),',
        '  skillId,',
        '  template: fs.readFileSync(path.join(skillDir, "templates", "report.md"), "utf8").trim(),',
        '  mode: JSON.parse(fs.readFileSync(path.join(skillDir, "assets", "settings.json"), "utf8")).mode,',
        '});',
      ].join('\n'),
    );

    const { buildRunner } = await loadRunner();
    const built = await buildRunner({
      sessionId: 'gconv-runner-skill-execution',
      userId: uid,
      skillList: ['internal-executable-id'],
    });
    const tools = (built.runner as unknown as { tools: Map<string, any> }).tools;
    const readFile = tools.get('read_files');
    const bash = tools.get('bash');
    const toolContext = {
      workingDir: path.join(tmpDir, 'execution-workspace'),
      state: {
        sandboxEnv: (await import('../../../src/main/model/core-agent/client')).buildSkillSandboxEnv(uid),
      },
      signal: undefined,
    } as any;
    fs.mkdirSync(toolContext.workingDir, { recursive: true });

    const entry = await readFile.execute({ paths: [{ path: '@skill/executable-skill' }] }, toolContext);
    const template = await readFile.execute(
      { paths: [{ path: '@skill/executable-skill/templates/report.md' }] },
      toolContext,
    );
    const script = await readFile.execute(
      { paths: [{ path: '@skill/executable-skill/scripts/render.js' }] },
      toolContext,
    );
    const command = process.platform === 'win32'
      ? '& "$env:ORKAS_NODE" "$env:ORKAS_PC_DIR/bin/run-skill.cjs" executable-skill render -- --topic regression'
      : '"$ORKAS_NODE" "$ORKAS_PC_DIR/bin/run-skill.cjs" executable-skill render -- --topic regression';
    const execution = await bash.execute({ command }, toolContext);

    expect(built.resolvedSystemPrompt).toContain('read ref: @skill/executable-skill');
    expect(built.resolvedSystemPrompt).not.toContain(skillRoot);
    expect(entry.isError).toBeFalsy();
    expect(entry.content).toContain('run-skill.cjs');
    expect(template.isError).toBeFalsy();
    expect(template.content).toContain('Report: {{topic}}');
    expect(script.isError).toBeFalsy();
    expect(script.content).toContain('templates');
    expect(execution.isError).toBeFalsy();
    expect(execution.content).toContain('"topic":"regression"');
    expect(execution.content).toContain('"skillId":"executable-skill"');
    expect(execution.content).toContain('"template":"Report: {{topic}}"');
    expect(execution.content).toContain('"mode":"strict"');
  });

  it('passes an arbitrary OpenRouter ID to pi-ai as the resolved custom model', async () => {
    const createPiProvider = vi.fn(() => ({
      id: 'openrouter',
      name: 'OpenRouter',
      async *stream() {
        yield { type: 'text_delta' as const, text: 'ok' };
      },
      async complete() {
        throw new Error('not used');
      },
      async validateAuth() {
        return true;
      },
    }));
    vi.doMock('#core-agent', async () => ({
      ...(await vi.importActual<any>('#core-agent')),
      createPiProvider,
    }));

    const uid = 'runner-openrouter-custom-id';
    const users = await import('../../../src/main/features/users');
    const auth = await import('../../../src/main/features/auth');
    users.activateUser(uid);
    const profile = await auth.addApiKey('openrouter', 'sk-or-runtime-test', 'Relay');
    await auth.addEntry({
      provider: 'openrouter',
      model: 'future-lab/frontier-2:free',
      profileId: profile.profileId,
    });

    const { buildRunner } = await loadRunner();
    const built = await buildRunner({ sessionId: 'gconv-openrouter-custom-id', userId: uid });
    const provider = (built.runner as any).providers.get('openrouter');
    const iterator = provider.stream({
      model: built.modelId,
      messages: [{ role: 'user', content: [{ type: 'text', text: 'ping' }] }],
    })[Symbol.asyncIterator]();
    await iterator.next();
    await iterator.return?.();

    expect(createPiProvider).toHaveBeenCalledTimes(1);
    expect(createPiProvider).toHaveBeenCalledWith(expect.objectContaining({
      provider: 'openrouter',
      apiKey: 'sk-or-runtime-test',
      customModel: expect.objectContaining({
        id: 'future-lab/frontier-2:free',
        api: 'openai-completions',
        baseUrl: 'https://openrouter.ai/api/v1',
      }),
    }));
  });

});

describe('runner › metacognition closed loop', () => {
  it('injects the originating account assessment into its next turn after the active account changes', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-test-placeholder';
    const users = await import('../../../src/main/features/users');
    const metacognition = await import('../../../src/main/features/metacognition');
    users.activateUser('reflection-owner');
    metacognition.writeContentForUser(
      'reflection-owner',
      '',
      'competence',
      'WHEN summarizing incidents, ALWAYS lead with customer impact.',
    );
    users.activateUser('other-account');
    metacognition.writeContent(
      '',
      'competence',
      'WHEN summarizing incidents, ALWAYS lead with internal ticket IDs.',
    );

    const { buildRunner } = await loadRunner();
    const built = await buildRunner({
      sessionId: 'gconv-metacognition-scope',
      userId: 'reflection-owner',
      systemPrompt: 'You are Commander.',
    });

    expect(built.resolvedSystemPrompt).toContain('lead with customer impact');
    expect(built.resolvedSystemPrompt).not.toContain('lead with internal ticket IDs');
    expect(built.toolDefs.some((tool) => tool.name === 'metacognition')).toBe(true);
  });
});

describe('runner › conditional OCR tool exposure', () => {
  it('keeps OfficeWorker Office tools while routing OCR by capability and intent', async () => {
    const uid = 'runner-ocr-policy';
    const users = await import('../../../src/main/features/users');
    const auth = await import('../../../src/main/features/auth');
    users.activateUser(uid);
    const profile = await auth.addApiKey('anthropic', 'k-anthropic-ocr-policy', 'Anthropic');
    await auth.addEntry({
      provider: 'anthropic',
      model: 'claude-opus-4-8',
      profileId: profile.profileId,
    });

    const { buildRunner } = await loadRunner();
    const imageTurn = await buildRunner({
      sessionId: `gmember-ocr-image-${OFFICE_WORKER_AGENT_ID}`,
      userId: uid,
      agentId: OFFICE_WORKER_AGENT_ID,
      toolList: ['workspace.read', 'office'],
      userMessage: '这张图有什么区别？',
      attachmentMetadata: { hasAttachments: true, attachmentTypes: ['image'] },
    });
    expect(imageTurn.toolDefs.some((tool) => tool.name === 'ocr_file')).toBe(false);
    expect(imageTurn.toolDefs.map((tool) => tool.name)).toEqual(expect.arrayContaining([
      'create_docx',
      'create_xlsx',
      'create_pptx',
      'office_read',
      'edit_office',
      'office_review',
      'create_pdf',
      'edit_pdf',
      'pdf_render',
    ]));

    const pdfTurn = await buildRunner({
      sessionId: `gmember-ocr-pdf-${OFFICE_WORKER_AGENT_ID}`,
      userId: uid,
      agentId: OFFICE_WORKER_AGENT_ID,
      toolList: ['workspace.read', 'office'],
      userMessage: '读取这个文件',
      attachmentMetadata: { hasAttachments: true, attachmentTypes: ['pdf'] },
    });
    expect(pdfTurn.toolDefs.some((tool) => tool.name === 'ocr_file')).toBe(true);

    const explicitOcrTurn = await buildRunner({
      sessionId: `gmember-ocr-explicit-${OFFICE_WORKER_AGENT_ID}`,
      userId: uid,
      agentId: OFFICE_WORKER_AGENT_ID,
      toolList: ['workspace.read', 'office'],
      userMessage: '请从这张截图中提取表格文字',
      attachmentMetadata: { hasAttachments: true, attachmentTypes: ['image'] },
    });
    expect(explicitOcrTurn.toolDefs.some((tool) => tool.name === 'ocr_file')).toBe(true);

    const richSteerTurn = await buildRunner({
      sessionId: `gmember-ocr-rich-steer-${OFFICE_WORKER_AGENT_ID}`,
      userId: uid,
      agentId: OFFICE_WORKER_AGENT_ID,
      toolList: ['workspace.read', 'office'],
      userMessage: '先处理当前任务',
      attachmentMetadata: { hasAttachments: false, attachmentTypes: [] },
      richSteerEnabled: true,
    });
    expect(richSteerTurn.toolDefs.some((tool) => tool.name === 'ocr_file')).toBe(true);
  });
});

describe('runner › generic host capabilities for built-in Agents', () => {
  it('gives ContentWriter its authored initial surface plus a low-priority fallback', async () => {
    const uid = 'runner-content-writer-host-tools';
    const users = await import('../../../src/main/features/users');
    const auth = await import('../../../src/main/features/auth');
    users.activateUser(uid);
    const profile = await auth.addApiKey(
      'anthropic',
      'k-anthropic-content-writer-host-tools',
      'Anthropic',
    );
    await auth.addEntry({
      provider: 'anthropic',
      model: 'claude-opus-4-8',
      profileId: profile.profileId,
    });

    const { buildRunner } = await loadRunner();
    const built = await buildRunner({
      sessionId: `gmember-content-writer-host-tools-${CONTENT_WRITER_AGENT_ID}`,
      userId: uid,
      agentId: CONTENT_WRITER_AGENT_ID,
      toolList: ['workspace.read', 'workspace.write.output', 'workspace.execute.command', 'web'],
      userMessage: '写一篇有来源约束的文章',
    });
    const publicToolNames = built.toolDefs.map((tool) => tool.name);
    const runnerToolNames = [
      ...((built.runner as unknown as { tools: Map<string, unknown> }).tools.keys()),
    ];

    expect(publicToolNames).toEqual(expect.arrayContaining([
      'read_files', 'write_file', 'bash', 'web_search', 'web_fetch',
    ]));
    expect(publicToolNames).toContain('tool_load');
    expect(publicToolNames).not.toContain('read_file');
    expect(publicToolNames).not.toContain('stat_file');
    expect(publicToolNames).not.toContain('library');
    expect(publicToolNames).not.toContain('create_pptx');
    expect(publicToolNames).not.toContain('edit_file');
    expect(publicToolNames).not.toContain('process_session');
    expect(built.resolvedSystemPrompt).toContain('## Loadable tool groups');
    expect(built.resolvedSystemPrompt).toContain('Fallback only');
    expect(built.turnEphemeral).toContain('## Active tool groups');
    expect(runnerToolNames).toEqual(expect.arrayContaining(publicToolNames));
    expect(runnerToolNames).toEqual(expect.arrayContaining([
      'library', 'create_pptx', 'edit_file', 'process_session', 'tool_load',
    ]));
    expect(runnerToolNames).not.toContain('read_file');
    expect(runnerToolNames).not.toContain('stat_file');
  });
});

describe('runner › scoped tool loading', () => {
  async function configureUser(uid: string): Promise<void> {
    const users = await import('../../../src/main/features/users');
    const auth = await import('../../../src/main/features/auth');
    users.activateUser(uid);
    const profile = await auth.addApiKey('anthropic', `k-${uid}-tool-loading`, 'Anthropic');
    await auth.addEntry({
      provider: 'anthropic',
      model: 'claude-opus-4-8',
      profileId: profile.profileId,
    });
  }

  it('exposes project-task protocol, tool, and volatile status only in project conversations', async () => {
    const uid = 'runner-project-task-context-gate';
    await configureUser(uid);
    const systemSkills = await import('../../../src/main/features/system_skills');
    await systemSkills.reconcileAllForUser(uid);
    const { buildRunner } = await loadRunner();

    const nonProject = await buildRunner({
      sessionId: 'gconv-project-task-gate-none',
      userId: uid,
      cid: 'conversation-without-project',
    });
    const project = await buildRunner({
      sessionId: 'gconv-project-task-gate-project',
      userId: uid,
      cid: 'conversation-in-project',
      projectId: 'project-a',
    });

    expect(nonProject.resolvedSystemPrompt).not.toContain('**project-tasks**');
    expect(nonProject.toolDefs.map((tool) => tool.name)).not.toContain('project_tasks');
    expect(nonProject.turnEphemeral).not.toContain('## Project status');

    expect(project.resolvedSystemPrompt).toContain('**project-tasks**');
    expect(project.toolDefs.map((tool) => tool.name)).toContain('project_tasks');
    expect(project.resolvedSystemPrompt).not.toContain('## Project status');
    expect(project.turnEphemeral).toContain('## Project status');
  });

  it('keeps reflection on its fixed tools and skips ordinary Skills even under legacy rollback', async () => {
    process.env.ORKAS_TOOL_LOADING_MODE = 'legacy';
    const uid = 'runner-reflection-fixed-surface';
    await configureUser(uid);
    const paths = await import('../../../src/main/paths');
    const ordinarySkillRoot = path.join(paths.userSkillsDir(uid), 'ordinary-reflection-skill');
    fs.mkdirSync(ordinarySkillRoot, { recursive: true });
    fs.writeFileSync(
      path.join(ordinarySkillRoot, 'SKILL.md'),
      [
        '---',
        'name: ordinary-reflection-skill',
        'description: This ordinary Skill must not load in reflection.',
        '---',
        'Use read_files and bash to perform ordinary task work.',
      ].join('\n'),
    );
    const advertised = vi.fn();
    const { buildRunner } = await loadRunner();

    const namedAgent = await buildRunner({
      sessionId: 'reflect-fixed-named-agent',
      userId: uid,
      agentId: 'reflection-agent',
      skillList: ['ordinary-reflection-skill'],
      onSkillAdvertised: advertised,
    });
    const namedRunner = namedAgent.runner as unknown as {
      tools: Map<string, unknown>;
      getActiveToolDefinitions(): Array<{ name: string }>;
    };
    const namedActiveNames = namedRunner.getActiveToolDefinitions().map((tool) => tool.name).sort();

    expect(namedAgent.toolSurfaceMode).toBe('scoped');
    expect(namedActiveNames).toEqual(['metacognition', 'skill_manage']);
    expect(namedAgent.toolDefs.map((tool) => tool.name)).toEqual(namedActiveNames);
    expect([...namedRunner.tools.keys()].sort()).toEqual(namedActiveNames);
    expect(namedAgent.resolvedSystemPrompt).not.toContain('ordinary-reflection-skill');
    expect(namedAgent.skillDisplayNameById.size).toBe(0);
    expect(namedAgent.skillMetadataByReadRef.size).toBe(0);
    expect(advertised).not.toHaveBeenCalled();

    const defaultAgent = await buildRunner({
      sessionId: 'reflect-fixed-default-agent',
      userId: uid,
    });
    const defaultActiveNames = (
      defaultAgent.runner as unknown as { getActiveToolDefinitions(): Array<{ name: string }> }
    ).getActiveToolDefinitions().map((tool) => tool.name);
    expect(defaultAgent.toolSurfaceMode).toBe('scoped');
    expect(defaultActiveNames).toEqual(['metacognition']);
    expect(defaultAgent.toolDefs.map((tool) => tool.name)).toEqual(defaultActiveNames);
  });

  it('imports owner-only Studio runtimes only for their matching Agent', async () => {
    const uid = 'runner-owner-studio-imports';
    await configureUser(uid);
    const videoModuleLoads = vi.fn();
    const imageModuleLoads = vi.fn();
    vi.doMock('../../../src/main/model/core-agent/video-studio-tool', () => {
      videoModuleLoads();
      return {
        createVideoStudioTool: () => ({
          name: 'video_studio',
          description: 'Test owner-only VideoStudio runtime.',
          inputSchema: { type: 'object', properties: {}, additionalProperties: false },
          async execute() { return { content: 'ok' }; },
        }),
      };
    });
    vi.doMock('../../../src/main/model/core-agent/image-studio-tool', () => {
      imageModuleLoads();
      return {
        createImageStudioTool: () => ({
          name: 'image_studio',
          description: 'Test owner-only ImageStudio runtime.',
          inputSchema: { type: 'object', properties: {}, additionalProperties: false },
          async execute() { return { content: 'ok' }; },
        }),
      };
    });

    const { buildRunner } = await loadRunner();
    const ordinary = await buildRunner({
      sessionId: 'gmember-owner-studio-ordinary',
      userId: uid,
      agentId: CONTENT_WRITER_AGENT_ID,
      toolList: ['media'],
    });
    expect(videoModuleLoads).not.toHaveBeenCalled();
    expect(imageModuleLoads).not.toHaveBeenCalled();
    expect(ordinary.toolDefs.map((tool) => tool.name)).not.toContain('video_studio');
    expect(ordinary.toolDefs.map((tool) => tool.name)).not.toContain('image_studio');

    const image = await buildRunner({
      sessionId: 'gmember-owner-studio-image',
      userId: uid,
      agentId: IMAGE_STUDIO_AGENT_ID,
      toolList: ['media.image'],
    });
    expect(imageModuleLoads).toHaveBeenCalledTimes(1);
    expect(videoModuleLoads).not.toHaveBeenCalled();
    expect(image.toolDefs.map((tool) => tool.name)).toContain('image_studio');

    const video = await buildRunner({
      sessionId: 'gmember-owner-studio-video',
      userId: uid,
      agentId: VIDEO_STUDIO_AGENT_ID,
      toolList: ['media.video'],
    });
    expect(videoModuleLoads).toHaveBeenCalledTimes(1);
    expect(video.toolDefs.map((tool) => tool.name)).toContain('video_studio');
  });

  it('lets a host-selected Connector expand a fixed Agent only for the current run', async () => {
    const uid = 'runner-runtime-connector-grant';
    await configureUser(uid);
    vi.doMock('../../../src/main/model/core-agent/connector-meta-tools', () => ({
      buildConnectorSurface: async (_opts: unknown, mode: 'full' | 'discover') => ({
        promptBlock: '## Connectors\n- notion: Notion',
        connectorDisplayNameById: new Map([['notion', 'Notion']]),
        tools: (mode === 'discover'
          ? ['list_connector_tools']
          : ['list_connector_tools', 'call_connector_tool']).map((name) => ({
          name,
          description: `Test ${name}.`,
          inputSchema: { type: 'object', properties: {}, additionalProperties: false },
          async execute() { return { content: 'ok' }; },
        })),
      }),
    }));
    const runtimeGrantedToolGroups: string[] = [];
    const { buildRunner } = await loadRunner();
    const built = await buildRunner({
      sessionId: 'gmember-runtime-connector-grant',
      userId: uid,
      agentId: CONTENT_WRITER_AGENT_ID,
      toolList: ['web'],
      richSteerEnabled: true,
      runtimeGrantedToolGroups,
    });
    const runner = built.runner as unknown as {
      activeTools(): Array<{ name: string }>;
      tools: Map<string, unknown>;
    };

    expect(built.connectorDisplayNameById.get('notion')).toBe('Notion');
    expect(built.resolvedSystemPrompt).not.toContain('## Connectors');
    expect(built.toolDefs.map((tool) => tool.name)).not.toContain('list_connector_tools');
    expect(runner.tools.has('list_connector_tools')).toBe(true);
    expect(runner.activeTools().map((tool) => tool.name)).not.toContain('list_connector_tools');
    expect(runner.tools.has('tool_load')).toBe(true);

    const lazy = await buildRunner({
      sessionId: 'gmember-runtime-connector-lazy-fallback',
      userId: uid,
      agentId: CONTENT_WRITER_AGENT_ID,
      toolList: ['web'],
      richSteerEnabled: true,
    });
    const lazyRunner = lazy.runner as unknown as {
      activeTools(): Array<{ name: string }>;
      tools: Map<string, {
        execute(input: Record<string, unknown>, ctx: { state: Record<string, unknown> }): Promise<{
          content: string;
          isError?: boolean;
        }>;
      }>;
    };
    expect(lazy.resolvedSystemPrompt).not.toContain('## Connectors');
    expect(lazy.resolvedSystemPrompt).toContain('`connectors` — Connectors');
    const lazyLoad = await lazyRunner.tools.get('tool_load')!.execute(
      { groups: ['connectors'] },
      { state: {} },
    );
    expect(JSON.parse(lazyLoad.content)).toMatchObject({
      ok: true,
      newly_loaded: ['connectors'],
      loaded_group_context: {
        connectors: '## Connectors\n- notion: Notion',
      },
    });
    expect(lazyRunner.activeTools().map((tool) => tool.name)).toEqual(expect.arrayContaining([
      'list_connector_tools',
      'call_connector_tool',
    ]));
    expect(await lazyRunner.tools.get('list_connector_tools')!.execute(
      { connector_id: 'notion' },
      { state: {} },
    ))
      .toMatchObject({ content: 'ok' });
    expect(lazy.toolSurfaceTelemetry(['list_connector_tools'])).toMatchObject({
      loadCallCount: 1,
      loadedGroupCount: 1,
      loadedUnusedGroupCount: 0,
    });
    expect(lazy.toolSurfaceTelemetry().loadedSchemaChars).toBeGreaterThan(0);

    runtimeGrantedToolGroups.push('connectors');

    expect(runner.activeTools().map((tool) => tool.name)).toEqual(expect.arrayContaining([
      'list_connector_tools',
      'call_connector_tool',
    ]));
    expect(built.toolSurfaceTelemetry()).toMatchObject({
      loadCallCount: 0,
      loadedGroupCount: 0,
      loadedSchemaChars: 0,
      loadedUnusedGroupCount: 0,
    });
    expect(built.toolSurfaceTelemetry().peakToolCount).toBeGreaterThan(built.toolDefs.length);

    const selectedAtStart = await buildRunner({
      sessionId: 'gmember-runtime-connector-selected-at-start',
      userId: uid,
      agentId: CONTENT_WRITER_AGENT_ID,
      toolList: ['web'],
      runtimeGrantedToolGroups: ['connectors'],
    });
    expect(selectedAtStart.resolvedSystemPrompt).toContain('## Connectors');
    expect(selectedAtStart.toolDefs.map((tool) => tool.name)).toEqual(expect.arrayContaining([
      'list_connector_tools',
      'call_connector_tool',
    ]));
    expect(selectedAtStart.toolDefs.map((tool) => tool.name)).toContain('tool_load');

    const editor = await buildRunner({
      sessionId: 'agent-runtime-connector-authoring',
      userId: uid,
      agentId: CONTENT_WRITER_AGENT_ID,
    });
    expect(editor.resolvedSystemPrompt).toContain('## Connectors');
    expect(editor.toolDefs.map((tool) => tool.name)).toContain('list_connector_tools');
    expect(editor.toolDefs.map((tool) => tool.name)).not.toContain('call_connector_tool');
  });

  it('keeps Connector fallback hidden when a rich-steer Agent starts with no visible connectors', async () => {
    const uid = 'runner-no-visible-connectors';
    await configureUser(uid);
    vi.doMock('../../../src/main/model/core-agent/connector-meta-tools', () => ({
      buildConnectorSurface: async () => ({
        promptBlock: '',
        connectorDisplayNameById: new Map(),
        // Rich steer retains these executors so a later explicit host
        // selection can activate a Connector without rebuilding the runner.
        tools: ['list_connector_tools', 'call_connector_tool'].map((name) => ({
          name,
          description: `Test ${name}.`,
          inputSchema: { type: 'object', properties: {}, additionalProperties: false },
          async execute() { return { content: 'ok' }; },
        })),
      }),
    }));
    const runtimeGrantedToolGroups: string[] = [];
    const { buildRunner } = await loadRunner();
    const built = await buildRunner({
      sessionId: 'gmember-no-visible-connectors',
      userId: uid,
      agentId: CONTENT_WRITER_AGENT_ID,
      // An authored dependency is still unavailable when there is no usable
      // Connector; it must not turn a dormant refresh executor model-visible.
      toolList: ['web', 'connectors'],
      richSteerEnabled: true,
      runtimeGrantedToolGroups,
    });
    const runner = built.runner as unknown as {
      activeTools(): Array<{ name: string }>;
      tools: Map<string, {
        inputSchema: {
          properties: { groups: { items: { enum: string[] } } };
        };
        execute(input: Record<string, unknown>, ctx: { state: Record<string, unknown> }): Promise<{
          content: string;
          isError?: boolean;
        }>;
      }>;
    };
    const toolLoad = runner.tools.get('tool_load')!;

    expect(built.resolvedSystemPrompt).not.toContain('`connectors` — Connectors');
    expect(toolLoad.inputSchema.properties.groups.items.enum).not.toContain('connectors');
    expect(built.toolDefs.map((tool) => tool.name)).not.toContain('list_connector_tools');
    expect(built.toolDefs.map((tool) => tool.name)).not.toContain('call_connector_tool');
    expect(runner.activeTools().map((tool) => tool.name)).not.toContain('list_connector_tools');
    expect(JSON.parse((await toolLoad.execute(
      { groups: ['connectors'] },
      { state: {} },
    )).content)).toMatchObject({
      ok: false,
      error: 'E_TOOL_GROUP_INVALID',
    });

    runtimeGrantedToolGroups.push('connectors');
    expect(runner.activeTools().map((tool) => tool.name)).toEqual(expect.arrayContaining([
      'list_connector_tools',
      'call_connector_tool',
    ]));
  });

  it('lets a named Agent load and execute a missing Agent-dependency tool as a fallback', async () => {
    const uid = 'runner-agent-fallback-execution';
    await configureUser(uid);
    const permissions = await import('../../../src/main/features/permissions');
    const workspace = await import('../../../src/main/features/user_workspace');
    permissions.setLocalExecMode('all_files_auto');
    const workspaceDir = path.join(tmpDir, 'fallback-workspace');
    fs.mkdirSync(workspaceDir, { recursive: true });
    expect(workspace.setWorkspacePath(uid, workspaceDir).ok).toBe(true);

    const { buildRunner } = await loadRunner();
    const built = await buildRunner({
      sessionId: 'gmember-agent-fallback-execution',
      userId: uid,
      agentId: CONTENT_WRITER_AGENT_ID,
      toolList: ['workspace.read'],
      userMessage: 'Use the selected Skill and save its result.',
    });
    const runner = built.runner as unknown as {
      activeTools(): Array<{ name: string }>;
      tools: Map<string, {
        execute: (input: unknown, ctx: unknown) => Promise<{ content: string; isError?: boolean }>;
      }>;
    };
    const ctx = { workingDir: workspaceDir, state: {}, signal: undefined };

    expect(built.toolDefs.map((tool) => tool.name)).toContain('tool_load');
    expect(built.toolDefs.map((tool) => tool.name)).not.toContain('write_file');
    expect(JSON.parse((await runner.tools.get('tool_load')!.execute(
      { groups: ['management'] },
      ctx,
    )).content)).toMatchObject({ ok: false, unavailable: ['management'] });
    expect(runner.activeTools().map((tool) => tool.name)).not.toContain('write_file');

    expect(JSON.parse((await runner.tools.get('tool_load')!.execute(
      { groups: ['workspace.write.output'] },
      ctx,
    )).content)).toMatchObject({
      ok: true,
      newly_loaded: ['workspace.write.output'],
    });
    expect(runner.activeTools().map((tool) => tool.name)).toContain('write_file');

    const write = await runner.tools.get('write_file')!.execute({
      path: 'out/fallback.txt',
      content: 'fallback executed',
    }, ctx);
    expect(write.isError).toBeFalsy();
    expect(fs.readFileSync(path.join(workspaceDir, 'out', 'fallback.txt'), 'utf8'))
      .toBe('fallback executed');

    const nextTurn = await buildRunner({
      sessionId: 'gmember-agent-fallback-execution',
      userId: uid,
      agentId: CONTENT_WRITER_AGENT_ID,
      toolList: ['workspace.read'],
      userMessage: 'Start the next user turn.',
    });
    expect(nextTurn.toolDefs.map((tool) => tool.name)).not.toContain('write_file');
    expect((nextTurn.runner as unknown as { activeTools(): Array<{ name: string }> })
      .activeTools().map((tool) => tool.name)).not.toContain('write_file');
  });

  it('lets an accepted rich-steer Skill binding become readable in the existing fixed Agent run', async () => {
    const uid = 'runner-runtime-skill-binding';
    await configureUser(uid);
    const runtimeSkillBindings = new Map<string, any>();
    const skillRoot = path.join(tmpDir, 'runtime-selected-skill');
    const skillEntry = path.join(skillRoot, 'SKILL.md');
    fs.mkdirSync(skillRoot, { recursive: true });
    fs.writeFileSync(skillEntry, '# Runtime selected\nUse this exact Skill.\n');
    const { buildRunner } = await loadRunner();
    const built = await buildRunner({
      sessionId: 'gmember-runtime-skill-binding',
      userId: uid,
      agentId: CONTENT_WRITER_AGENT_ID,
      toolList: ['workspace.read'],
      runtimeSkillBindings,
    });
    const readFile = (built.runner as unknown as { tools: Map<string, any> }).tools.get('read_files');

    const before = await readFile.execute(
      { paths: [{ path: '@skill/runtime-review' }] },
      { workingDir: tmpDir, state: {} } as any,
    );
    expect(before).toMatchObject({ isError: true });
    expect(before.content).toContain('E_SKILL_NOT_AVAILABLE');

    runtimeSkillBindings.set('runtime-review', {
      id: 'runtime-review',
      name: 'Runtime review',
      root: skillRoot,
      entry: skillEntry,
      source: 'global',
    });

    const after = await readFile.execute(
      { paths: [{ path: '@skill/runtime-review' }] },
      { workingDir: tmpDir, state: {} } as any,
    );
    expect(after.isError).toBeFalsy();
    expect(after.content).toContain('## Skill runtime requirements');
    expect(after.content).toContain('Use this exact Skill.');
  });

  it('preloads Commander web and global-Skill discovery, not the whole management group', async () => {
    process.env.ORKAS_TOOL_LOADING_MODE = 'scoped';
    const uid = 'runner-scoped-global-skill-discovery';
    await configureUser(uid);
    const { buildRunner } = await loadRunner();
    const commander = await buildRunner({
      sessionId: 'gconv-scoped-global-skill-discovery',
      userId: uid,
      extraTools: [
        {
          name: 'skill_search',
          description: 'Discover global Skills.',
          inputSchema: { type: 'object', properties: {}, additionalProperties: false },
          async execute() { return { content: JSON.stringify({ ok: true, rows: [] }) }; },
        },
        {
          name: 'marketplace_search',
          description: 'Search marketplace resources.',
          inputSchema: { type: 'object', properties: {}, additionalProperties: false },
          async execute() { return { content: JSON.stringify({ ok: true, rows: [] }) }; },
        },
      ],
    });

    const toolNames = commander.toolDefs.map((tool) => tool.name);
    expect(toolNames).toContain('skill_search');
    expect(toolNames).toEqual(expect.arrayContaining(['web_search', 'web_fetch']));
    expect(toolNames).toContain('tool_load');
    expect(toolNames).toContain('manage_execution_plan');
    expect(toolNames).not.toContain('marketplace_search');
    expect(toolNames).toEqual(
      commander.runner.getActiveToolDefinitions().map((tool) => tool.name).sort(),
    );
    expect(commander.resolvedSystemPrompt).toContain('## Loadable tool groups');
    expect(commander.resolvedSystemPrompt).not.toContain('Tools:');
    expect(commander.resolvedSystemPrompt).not.toContain('`marketplace_search`');
    expect(commander.resolvedSystemPrompt).toContain('runtime only; not an Agent dependency');
    expect(commander.toolSurfaceTelemetry(['web_search'])).toMatchObject({
      loadCallCount: 0,
      loadedGroupCount: 0,
      loadedSchemaChars: 0,
      webToolUsed: true,
    });
  });

  it('does not serialize a deferred tool schema until its group is loaded', async () => {
    process.env.ORKAS_TOOL_LOADING_MODE = 'scoped';
    const uid = 'runner-deferred-tool-definition';
    await configureUser(uid);
    let schemaReads = 0;
    const deferredTool = {
      name: 'marketplace_search',
      description: 'Search marketplace resources.',
      get inputSchema() {
        schemaReads += 1;
        return { type: 'object', properties: {}, additionalProperties: false };
      },
      async execute() { return { content: JSON.stringify({ ok: true }) }; },
    };
    const { buildRunner } = await loadRunner();

    const built = await buildRunner({
      sessionId: 'gconv-deferred-tool-definition',
      userId: uid,
      extraTools: [deferredTool],
    });

    expect(built.toolDefs.map((tool) => tool.name)).not.toContain('marketplace_search');
    expect(schemaReads).toBe(0);

    const runner = built.runner as unknown as {
      tools: Map<string, {
        execute: (input: unknown, ctx: unknown) => Promise<{ content: string }>;
      }>;
      getActiveToolDefinitions(): Array<{ name: string }>;
    };
    await runner.tools.get('tool_load')?.execute(
      { groups: ['management'] },
      { workingDir: tmpDir, state: {}, signal: undefined },
    );
    expect(schemaReads).toBe(0);
    const telemetry = built.toolSurfaceTelemetry();
    expect(telemetry.loadedSchemaChars).toBeGreaterThan(0);
    expect(schemaReads).toBe(1);
    const activeNames = runner.getActiveToolDefinitions().map((tool) => tool.name);
    expect(activeNames).toContain('marketplace_search');
    expect(telemetry.peakToolCount).toBe(activeNames.length);
  });

  it('builds process labels from lightweight Agent summaries without full enrichment', async () => {
    process.env.ORKAS_TOOL_LOADING_MODE = 'scoped';
    const uid = 'runner-lightweight-agent-labels';
    await configureUser(uid);
    const agents = await import('../../../src/main/features/agents');
    const summary: AgentSummary = {
      agent_id: 'summary-agent',
      name: 'Summary Agent',
      source: 'custom',
      category: 'other',
      runtime: { kind: 'in_process' },
      enabled: true,
    };
    const summaries = vi.spyOn(agents, 'listAgentSummaries').mockResolvedValue([summary]);
    const enriched = vi.spyOn(agents, 'listAgents').mockResolvedValue([]);
    const { buildRunner } = await loadRunner();

    const built = await buildRunner({
      sessionId: 'gconv-lightweight-agent-labels',
      userId: uid,
    });

    expect(built.agentDisplayNameById.get('summary-agent')).toBe('Summary Agent');
    expect(summaries).toHaveBeenCalledOnce();
    expect(enriched).not.toHaveBeenCalled();
  });

  it('keeps legacy Commander compact and the dedicated Agent editor dependency-aware', async () => {
    process.env.ORKAS_TOOL_LOADING_MODE = 'legacy';
    const uid = 'runner-legacy-agent-authoring';
    await configureUser(uid);
    const { buildRunner } = await loadRunner();

    const commander = await buildRunner({
      sessionId: 'gconv-legacy-agent-authoring',
      userId: uid,
    });
    const editor = await buildRunner({
      sessionId: 'agent-legacy-agent-authoring',
      userId: uid,
      agentId: 'custom-agent',
      agentToolDependencyAuthoring: true,
    });
    const ordinaryAgent = await buildRunner({
      sessionId: 'gmember-legacy-agent-authoring-custom-agent',
      userId: uid,
      agentId: 'custom-agent',
    });

    expect(commander.toolDefs.map((tool) => tool.name)).toContain('bash');
    expect(commander.toolDefs.map((tool) => tool.name)).not.toContain('tool_load');
    expect(commander.resolvedSystemPrompt).not.toContain('## Agent tool dependencies');
    expect(commander.resolvedSystemPrompt).not.toContain('## Loadable tool groups');
    expect(editor.toolDefs.map((tool) => tool.name)).not.toContain('bash');
    expect(editor.toolDefs.map((tool) => tool.name)).not.toContain('tool_load');
    expect(editor.resolvedSystemPrompt).toContain('## Agent tool dependencies');
    expect(editor.resolvedSystemPrompt).toContain('exact group ids');
    expect(editor.resolvedSystemPrompt).not.toContain('`management`');
    expect(ordinaryAgent.toolDefs.map((tool) => tool.name)).toContain('bash');
    expect(ordinaryAgent.toolDefs.map((tool) => tool.name)).toContain('tool_load');
    expect(ordinaryAgent.resolvedSystemPrompt).toContain('## Loadable tool groups');
  });

  it('returns the exact Agent dependency directory only when Commander reads agent-creator', async () => {
    process.env.ORKAS_TOOL_LOADING_MODE = 'scoped';
    const uid = 'runner-agent-creator-on-demand-directory';
    await configureUser(uid);
    const paths = await import('../../../src/main/paths');
    const writeSystemSkill = (id: string, body: string) => {
      const dir = paths.userSystemSkillDir(uid, id);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(
        path.join(dir, 'SKILL.md'),
        `---\nname: ${id}\ndescription: test protocol\n---\n${body}`,
      );
    };
    writeSystemSkill('agent-creator', 'agent authoring protocol');
    writeSystemSkill('autotask-creator', 'automation authoring protocol');

    const { buildRunner } = await loadRunner();
    const commander = await buildRunner({
      sessionId: 'gconv-agent-creator-on-demand-directory',
      userId: uid,
      cid: 'agent-creator-on-demand-directory',
      richSteerEnabled: true,
      systemSkillList: ['agent-creator', 'autotask-creator'],
    });
    const readFile = (commander.runner as unknown as { tools: Map<string, any> }).tools.get('read_files');
    const toolContext = { workingDir: tmpDir, state: new Map(), signal: undefined } as any;

    const agentCreator = await readFile.execute({ paths: [{ path: '@skill/agent-creator' }] }, toolContext);
    const otherCreator = await readFile.execute({ paths: [{ path: '@skill/autotask-creator' }] }, toolContext);

    expect(commander.resolvedSystemPrompt).toContain('## Loadable tool groups');
    expect(commander.resolvedSystemPrompt).not.toContain('## Agent tool dependencies');
    expect(commander.resolvedSystemPrompt).not.toContain('Tools:');
    expect(agentCreator.isError).toBeFalsy();
    expect(agentCreator.content.indexOf('## Agent tool dependencies')).toBeGreaterThanOrEqual(0);
    expect(agentCreator.content.indexOf('## Agent tool dependencies'))
      .toBeLessThan(agentCreator.content.indexOf('<file '));
    expect(agentCreator.content).toContain('Tools: `read_files`');
    expect(agentCreator.content).toContain('Tools: `web_search`');
    expect(agentCreator.content).toContain('Tools: `list_connector_tools`, `call_connector_tool`.');
    expect(agentCreator.content).not.toContain('`add_custom_connector`');
    expect(agentCreator.content).not.toContain('`management`');
    expect(agentCreator.content).not.toContain('runtime only');
    expect(agentCreator.content).toContain('agent authoring protocol');
    expect(otherCreator.isError).toBeFalsy();
    expect(otherCreator.content).toContain('automation authoring protocol');
    expect(otherCreator.content).not.toContain('## Agent tool dependencies');
    expect(otherCreator.content).not.toContain('## Skill runtime requirements');
  });

  it('keeps both LLM and CLI Agent editors on a fixed host-only surface', async () => {
    process.env.ORKAS_TOOL_LOADING_MODE = 'scoped';
    const uid = 'runner-scoped-agent-editor-boundary';
    await configureUser(uid);
    const { buildRunner } = await loadRunner();

    const llmEditor = await buildRunner({
      sessionId: 'agent-scoped-agent-editor',
      userId: uid,
      agentId: 'llm-agent',
      agentToolDependencyAuthoring: true,
      extraTools: [{
        name: 'skill_search',
        description: 'Test Agent Creator skill discovery boundary.',
        inputSchema: { type: 'object', properties: {}, additionalProperties: false },
        async execute() { return { content: JSON.stringify({ ok: true, skills: [] }) }; },
      }],
    });
    const cliEditor = await buildRunner({
      sessionId: 'agent-cli-agent-editor',
      userId: uid,
      agentId: 'cli-agent',
      extraTools: [{
        name: 'skill_search',
        description: 'Test CLI Agent editor skill discovery boundary.',
        inputSchema: { type: 'object', properties: {}, additionalProperties: false },
        async execute() { return { content: JSON.stringify({ ok: true, skills: [] }) }; },
      }],
    });

    expect(llmEditor.toolDefs.map((tool) => tool.name)).not.toContain('tool_load');
    expect(llmEditor.toolDefs.map((tool) => tool.name)).not.toContain('skill_search');
    expect(llmEditor.resolvedSystemPrompt).toContain('## Agent tool dependencies');
    expect(llmEditor.resolvedSystemPrompt).toContain('Tools: `read_files`');
    expect(llmEditor.resolvedSystemPrompt).not.toContain('`management`');
    expect(llmEditor.turnEphemeral).not.toContain('## Active tool groups');
    expect(cliEditor.toolDefs.map((tool) => tool.name)).toContain('read_files');
    expect(cliEditor.toolDefs.map((tool) => tool.name)).not.toContain('skill_search');
    expect(cliEditor.toolDefs.map((tool) => tool.name)).not.toContain('bash');
    expect(cliEditor.toolDefs.map((tool) => tool.name)).not.toContain('tool_load');
    expect(cliEditor.resolvedSystemPrompt).not.toContain('## Loadable tool groups');
  });

  it('exposes open Skill sources only to Commander sessions', async () => {
    const { openSkillSourcesExposureFromSessionId } = await loadRunner();

    expect(openSkillSourcesExposureFromSessionId('gconv-open-skills')).toBe(true);
    expect(openSkillSourcesExposureFromSessionId('agent-open-skills')).toBe(false);
    expect(openSkillSourcesExposureFromSessionId('gmember-open-skills')).toBe(false);
    expect(openSkillSourcesExposureFromSessionId('skill-open-skills')).toBe(false);
  });

  it('uses Agent tool_list as the initial provider boundary and keeps fallback executors inactive', async () => {
    process.env.ORKAS_TOOL_LOADING_MODE = 'scoped';
    const uid = 'runner-scoped-tools';
    await configureUser(uid);
    const { buildRunner } = await loadRunner();

    const built = await buildRunner({
      sessionId: 'gmember-scoped-tools-agent-a',
      userId: uid,
      agentId: 'agent-a',
      toolList: ['web'],
      userMessage: 'research this',
    });
    const names = built.toolDefs.map((tool) => tool.name);

    expect(names).toEqual(expect.arrayContaining([
      'read_files',
      'web_search',
      'web_fetch',
    ]));
    expect(names).toContain('tool_load');
    expect(names).toContain('manage_execution_plan');
    expect(names).toContain('skill_manage');
    expect(names).not.toContain('bash');
    expect(names).not.toContain('create_pdf');
    const activeRunnerTools = (
      built.runner as unknown as { getActiveToolDefinitions(): Array<{ name: string }> }
    )
      .getActiveToolDefinitions()
      .map((tool) => tool.name);
    expect(activeRunnerTools).toContain('skill_manage');
    expect([...names].sort()).toEqual([...activeRunnerTools].sort());
    expect(built.toolSurfaceTelemetry().peakToolCount).toBe(activeRunnerTools.length);
    expect(built.resolvedSystemPrompt).toContain('## Loadable tool groups');
    expect(built.turnEphemeral).toContain('## Active tool groups');
    expect(built.resolvedSystemPrompt).not.toContain('**bash**');
    const runnerToolNames = [
      ...((built.runner as unknown as { tools: Map<string, unknown> }).tools.keys()),
    ];
    expect(runnerToolNames).toEqual(expect.arrayContaining(['bash', 'create_pdf', 'tool_load']));
    const refusal = (built.runner as unknown as { toolUnavailableMessage(name: string): string })
      .toolUnavailableMessage('bash');
    expect(refusal).toContain('E_TOOL_NOT_LOADED: bash is available but not active.');
    expect(refusal).toContain('workspace.execute.command');
  });

  it('keeps Commander Management schemas deferred until tool_load activates them', async () => {
    process.env.ORKAS_TOOL_LOADING_MODE = 'scoped';
    const uid = 'runner-scoped-management';
    await configureUser(uid);
    const { buildRunner } = await loadRunner();
    const managementCalls: string[] = [];
    const managementTools = ['marketplace_search', 'auto_tasks_list'].map((name) => ({
      name,
      description: `Test ${name} boundary.`,
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      async execute() {
        managementCalls.push(name);
        return { content: JSON.stringify({ ok: true, name }) };
      },
    }));

    const built = await buildRunner({
      sessionId: 'gconv-scoped-management',
      userId: uid,
      extraTools: managementTools,
    });
    const runner = built.runner as unknown as {
      tools: Map<string, { execute: (input: unknown, ctx: unknown) => Promise<{ content: string }> }>;
      activeTools(): Array<{ name: string }>;
    };

    expect(runner.activeTools().map((tool) => tool.name)).not.toContain('marketplace_search');
    expect(built.resolvedSystemPrompt)
      .toContain('`management` (runtime only; not an Agent dependency)');
    expect(managementCalls).toEqual([]);

    const loadResult = await runner.tools.get('tool_load')?.execute(
      { groups: ['management'] },
      { workingDir: tmpDir, state: {}, signal: undefined },
    );
    expect(JSON.parse(loadResult?.content || '{}')).toMatchObject({
      ok: true,
      newly_loaded: ['management'],
    });
    expect(runner.activeTools().map((tool) => tool.name)).toEqual(expect.arrayContaining([
      'marketplace_search',
      'auto_tasks_list',
    ]));
    expect(managementCalls).toEqual([]);

    const searchResult = await runner.tools.get('marketplace_search')?.execute(
      {},
      { workingDir: tmpDir, state: {}, signal: undefined },
    );
    expect(JSON.parse(searchResult?.content || '{}')).toMatchObject({
      ok: true,
      name: 'marketplace_search',
    });
    expect(managementCalls).toEqual(['marketplace_search']);
    expect(built.toolSurfaceTelemetry(['tool_load', 'marketplace_search'])).toMatchObject({
      mode: 'scoped',
      loadCallCount: 1,
      loadedGroupCount: 1,
      loadedUnusedGroupCount: 0,
      webToolUsed: false,
    });
    expect(built.toolSurfaceTelemetry()).toMatchObject({
      loadedUnusedGroupCount: 1,
      webToolUsed: false,
    });
    expect(built.toolSurfaceTelemetry().loadedSchemaChars).toBeGreaterThan(0);

    const sessions = await import('../../../src/main/model/core-agent/session-store');
    expect((await sessions.getSessionForUser(uid, 'gconv-scoped-management'))
      .getToolSurfaceState()).toMatchObject({
        version: 3,
        loadedGroups: [],
        catalogRevision: '10',
      });

    const nextTurn = await buildRunner({
      sessionId: 'gconv-scoped-management',
      userId: uid,
      extraTools: managementTools,
    });
    expect(nextTurn.toolDefs.map((tool) => tool.name)).not.toContain('marketplace_search');
    expect(nextTurn.toolSurfaceTelemetry()).toMatchObject({
      loadCallCount: 0,
      loadedGroupCount: 0,
      loadedSchemaChars: 0,
    });
  });

  it('recomputes configured groups each turn without retaining removed Agent dependencies', async () => {
    process.env.ORKAS_TOOL_LOADING_MODE = 'scoped';
    const uid = 'runner-reconfigured-tools';
    const sessionId = 'gmember-reconfigured-tools-agent-a';
    await configureUser(uid);
    const { buildRunner } = await loadRunner();

    const before = await buildRunner({
      sessionId,
      userId: uid,
      agentId: 'agent-a',
      toolList: ['web'],
    });
    expect(before.toolDefs.map((tool) => tool.name)).toEqual(expect.arrayContaining([
      'read_files',
      'web_search',
    ]));
    expect(before.resolvedSystemPrompt).toContain('## Loadable tool groups');
    expect(before.resolvedSystemPrompt).not.toContain('(loaded)');
    expect(before.turnEphemeral).toContain('## Active tool groups');
    expect(before.turnEphemeral).toContain('`web`');

    const sessions = await import('../../../src/main/model/core-agent/session-store');
    const persistedBefore = (await sessions.getSessionForUser(uid, sessionId)).getToolSurfaceState();
    expect(persistedBefore?.loadedGroups).toEqual([]);

    const after = await buildRunner({
      sessionId,
      userId: uid,
      agentId: 'agent-a',
      toolList: [],
    });
    const afterNames = after.toolDefs.map((tool) => tool.name);
    expect(afterNames).toContain('read_files');
    expect(afterNames).not.toContain('web_search');
    expect(after.resolvedSystemPrompt).toContain('## Loadable tool groups');
    expect(after.resolvedSystemPrompt).toBe(before.resolvedSystemPrompt);
    expect(after.turnEphemeral).not.toContain('## Active tool groups');
    expect((await sessions.getSessionForUser(uid, sessionId)).getToolSurfaceState()?.loadedGroups)
      .toEqual([]);
  });

  it('drops an ambiguous v1 union after restart when an Agent dependency was removed', async () => {
    process.env.ORKAS_TOOL_LOADING_MODE = 'scoped';
    const uid = 'runner-migrate-v1-tools';
    const sessionId = 'gmember-migrate-v1-tools-agent-a';
    await configureUser(uid);
    const { buildRunner } = await loadRunner();
    const sessions = await import('../../../src/main/model/core-agent/session-store');

    const legacySession = await sessions.getSessionForUser(uid, sessionId);
    legacySession.setToolSurfaceState({
      version: 1,
      mode: 'scoped',
      loadedGroups: ['workspace.read', 'web'],
      catalogRevision: '1',
    });
    sessions.evictSession(sessionId);

    const migrated = await buildRunner({
      sessionId,
      userId: uid,
      agentId: 'agent-a',
      toolList: [],
    });
    const names = migrated.toolDefs.map((tool) => tool.name);
    expect(names).toContain('read_files');
    expect(names).not.toContain('web_search');
    expect(migrated.resolvedSystemPrompt).not.toContain('(loaded)');
    expect(migrated.turnEphemeral).not.toContain('`web`');
    expect((await sessions.getSessionForUser(uid, sessionId)).getToolSurfaceState())
      .toMatchObject({ version: 3, loadedGroups: [], catalogRevision: '10' });
  });

  it('drops restored dynamic groups when an Agent uses a fixed dependency list', async () => {
    process.env.ORKAS_TOOL_LOADING_MODE = 'scoped';
    const uid = 'runner-dynamic-tools';
    const sessionId = 'gmember-dynamic-tools-agent-a';
    await configureUser(uid);
    const { buildRunner } = await loadRunner();

    const sessions = await import('../../../src/main/model/core-agent/session-store');
    const prior = await sessions.getSessionForUser(uid, sessionId);
    prior.setToolSurfaceState({
      version: 2,
      mode: 'scoped',
      loadedGroups: ['web'],
      catalogRevision: '4',
    });

    const after = await buildRunner({
      sessionId,
      userId: uid,
      agentId: 'agent-a',
      toolList: ['library'],
    });
    const afterNames = after.toolDefs.map((tool) => tool.name);
    expect(afterNames).toEqual(expect.arrayContaining([
      'read_files',
      'library',
    ]));
    expect(afterNames).not.toContain('web_search');
    expect(afterNames).toContain('tool_load');
    expect(afterNames).not.toContain('create_pdf');
    expect((await sessions.getSessionForUser(uid, sessionId)).getToolSurfaceState()?.loadedGroups)
      .toEqual([]);
  });

  it('does not let pre-feature history restore legacy-all for an Agent', async () => {
    const uid = 'runner-old-tool-session';
    await configureUser(uid);
    const { buildRunner } = await loadRunner();
    const sessionId = 'gmember-old-tool-session-agent-a';

    delete process.env.ORKAS_TOOL_LOADING_MODE;
    await buildRunner({
      sessionId,
      userId: uid,
      agentId: 'agent-a',
      conversationHistory: {
        source: 'group-main-v2:old-tool-session',
        messages: [
          { role: 'user', turnId: 1, content: [{ type: 'text', text: 'old request' }] },
          { role: 'assistant', turnId: 1, content: [{ type: 'text', text: 'old reply' }] },
        ],
      },
    });

    process.env.ORKAS_TOOL_LOADING_MODE = 'scoped';
    const restored = await buildRunner({
      sessionId,
      userId: uid,
      agentId: 'agent-a',
      toolList: ['web'],
    });
    const names = restored.toolDefs.map((tool) => tool.name);
    expect(names).toContain('web_search');
    expect(names).not.toContain('bash');
    expect(names).not.toContain('create_pdf');
    expect(names).toContain('tool_load');
    expect(restored.resolvedSystemPrompt).toContain('## Loadable tool groups');
  });

  it('gives an anonymous worker one fixed generic profile without specialist groups', async () => {
    process.env.ORKAS_TOOL_LOADING_MODE = 'legacy';
    const uid = 'runner-fixed-gworker';
    await configureUser(uid);
    const { buildRunner } = await loadRunner();

    const built = await buildRunner({
      sessionId: 'gworker-fixed-profile-worker-a',
      userId: uid,
    });
    const names = built.toolDefs.map((tool) => tool.name);
    expect(names).toEqual(expect.arrayContaining([
      'read_files', 'write_file', 'bash', 'html_preview',
      'web_search', 'web_fetch', 'library',
    ]));
    expect(names).not.toContain('tool_load');
    expect(names).not.toContain('create_xlsx');
    expect(names).not.toContain('generate_image');
    expect(names).not.toContain('list_connector_tools');
  });
});

describe('runner › ImageStudio turn-scoped generation accounting', () => {
  it('threads the host turn id into the private ImageStudio recovery tool', async () => {
    const uid = 'runner-image-studio-turn';
    const users = await import('../../../src/main/features/users');
    const auth = await import('../../../src/main/features/auth');
    const permissions = await import('../../../src/main/features/permissions');
    const workspace = await import('../../../src/main/features/user_workspace');
    const generation = await import('../../../src/main/features/image_production_control');
    users.activateUser(uid);
    permissions.setLocalExecMode('all_files_auto');
    const profile = await auth.addApiKey('anthropic', 'k-image-studio-turn', 'Anthropic');
    await auth.addEntry({
      provider: 'anthropic',
      model: 'claude-opus-4-8',
      profileId: profile.profileId,
    });

    const projectDir = path.join(workspace.getWorkspacePath(uid), 'turn-budget-project');
    fs.mkdirSync(projectDir, { recursive: true });
    fs.writeFileSync(path.join(projectDir, 'image-manifest.json'), JSON.stringify({
      schema_version: 1,
      route: 'generate',
      canvas: { width: 1024, height: 1024 },
      brief: {
        purpose: 'Turn-scoped generation regression',
        audience: 'Test users',
        required_copy: [],
        must_include: ['one subject'],
        must_avoid: ['unbounded retries'],
      },
      art_direction: {
        subject_world: 'A simple daylight scene',
        one_job: 'Show one clear subject',
        visual_tradition: 'Natural editorial photography',
        composition: 'Centered subject with negative space',
        signature_device: 'A single warm reflection',
        typography: 'No text',
        color_light_material: 'Soft daylight and natural materials',
      },
      generation_budget: { max_calls: 1 },
    }));
    const generationStatePath = generation.imageGenerationControlStatePath(uid, projectDir);
    await generation.beginImageStudioGeneration({
      stateAbsPath: generationStatePath,
      projectDirAbs: projectDir,
      requestId: 'previous-turn-attempt',
      outputAbsPath: path.join(projectDir, 'previous.png'),
      turnId: 'previous-turn',
    });

    const { buildRunner } = await loadRunner();
    const built = await buildRunner({
      sessionId: 'gmember-runner-image-studio-turn',
      userId: uid,
      agentId: IMAGE_STUDIO_AGENT_ID,
      turnId: 'current-turn',
    });
    const imageStudio = (built.runner as unknown as { tools: Map<string, any> }).tools.get('image_studio');
    expect(imageStudio).toBeDefined();
    const inspected = await imageStudio.execute(
      { op: 'project.inspect', project_dir: projectDir },
      { workingDir: projectDir, state: new Map(), signal: undefined } as any,
    );
    expect(JSON.parse(inspected.content)).toMatchObject({
      recovery_context: {
        generation: {
          attempts_recorded: 0,
          calls_started: 0,
          calls_remaining: 1,
          budget_exhausted: false,
        },
      },
    });
  });
});

describe('runner › conversation-history scope exposure', () => {
  it('exposes only scopes available to each Agent and Commander conversation', async () => {
    const uid = 'runner-chat-history-scopes';
    const users = await import('../../../src/main/features/users');
    const auth = await import('../../../src/main/features/auth');
    users.activateUser(uid);
    const profile = await auth.addApiKey(
      'anthropic',
      'k-anthropic-chat-history-scopes',
      'Anthropic',
    );
    await auth.addEntry({
      provider: 'anthropic',
      model: 'claude-opus-4-8',
      profileId: profile.profileId,
    });

    const { buildRunner } = await loadRunner();
    const agent = await buildRunner({
      sessionId: 'gmember-current-chat-agent-a',
      userId: uid,
      agentId: 'agent-a',
      cid: 'current-chat',
      historyBoundaryMessageId: 'trigger-message',
      userMessage: 'continue',
    });
    const nonProjectCommander = await buildRunner({
      sessionId: 'gconv-current-chat-non-project',
      userId: uid,
      cid: 'current-chat-non-project',
      historyBoundaryMessageId: 'trigger-message-non-project',
      userMessage: 'continue',
    });
    const projectCommander = await buildRunner({
      sessionId: 'gconv-current-chat',
      userId: uid,
      cid: 'current-chat',
      projectId: 'project-a',
      historyBoundaryMessageId: 'trigger-message',
      userMessage: 'continue',
    });
    const summaryCid = 'shared-summary-chat';
    await buildRunner({
      sessionId: `gmember-${summaryCid}-agent-a`,
      userId: uid,
      agentId: 'agent-a',
      cid: summaryCid,
      conversationHistory: {
        source: `group-main-v2:${summaryCid}`,
        messages: [
          { role: 'user', turnId: 1, content: [{ type: 'text', text: 'canonical request' }] },
          { role: 'assistant', turnId: 1, content: [{ type: 'text', text: 'canonical response' }] },
        ],
      },
      userMessage: 'continue',
    });

    const agentHistory = agent.toolDefs.find((tool) => tool.name === 'chat_history');
    const nonProjectCommanderHistory = nonProjectCommander.toolDefs.find(
      (tool) => tool.name === 'chat_history',
    );
    const projectCommanderHistory = projectCommander.toolDefs.find(
      (tool) => tool.name === 'chat_history',
    );
    expect(agentHistory).toBeTruthy();
    expect((agentHistory?.inputSchema as any).properties.action.enum).toEqual(['search', 'read']);
    expect((agentHistory?.inputSchema as any).properties.scope.enum).toEqual(['current']);
    expect((agentHistory?.inputSchema as any).properties.page).toMatchObject({
      type: 'object',
      additionalProperties: false,
      properties: {
        mode: { type: 'string', enum: ['latest', 'around', 'before'] },
        index: { type: 'integer', minimum: 0 },
        count: { type: 'integer', minimum: 0 },
      },
      required: ['mode'],
    });
    expect((agentHistory?.inputSchema as any).properties.include_current).toBeUndefined();
    expect((nonProjectCommanderHistory?.inputSchema as any).properties.scope.enum)
      .toEqual(['current', 'all']);
    expect(nonProjectCommanderHistory?.description)
      .not.toContain('project stays in this project');
    expect((projectCommanderHistory?.inputSchema as any).properties.scope.enum)
      .toEqual(['current', 'project', 'all']);
  });

  it('lets a non-project Commander recover an older decision through current-history pages', async () => {
    const uid = 'runner-chat-history-recovery';
    const cid = 'current-chat-recovery';
    const boundaryMessageId = 'trigger-message-recovery';
    const decision = '固定组合、主体、客体、动作、场景；每面 1–5 个；短链 [[词根]]，不加面前缀。';
    const users = await import('../../../src/main/features/users');
    const auth = await import('../../../src/main/features/auth');
    users.activateUser(uid);
    const profile = await auth.addApiKey(
      'anthropic',
      'k-anthropic-chat-history-recovery',
      'Anthropic',
    );
    await auth.addEntry({
      provider: 'anthropic',
      model: 'claude-opus-4-8',
      profileId: profile.profileId,
    });

    const prior = Array.from({ length: 34 }, (_, index) => ({
      id: `history-${index}`,
      ts: new Date(Date.parse('2026-08-05T00:00:00Z') + index * 1_000).toISOString(),
      from: index % 2 === 0 ? 'user' : 'commander',
      to: index % 2 === 0 ? ['commander'] : ['user'],
      text: index === 0 ? decision : `history filler ${index}`,
    }));
    const messages = [
      ...prior,
      {
        id: boundaryMessageId,
        ts: '2026-08-05T00:10:00Z',
        from: 'user',
        to: ['commander'],
        text: '这个问题之前已经回答过',
      },
    ];
    const historyDir = path.join(tmpDir, uid, 'cloud', 'chats');
    fs.mkdirSync(historyDir, { recursive: true });
    fs.writeFileSync(
      path.join(historyDir, `${cid}.jsonl`),
      `${messages.map((message) => JSON.stringify(message)).join('\n')}\n`,
    );
    fs.writeFileSync(path.join(historyDir, '_index.json'), JSON.stringify([{
      conversation_id: cid,
      title: 'Current history recovery',
      kind: 'normal',
      agent_id: '',
      skill_id: '',
      session_id: `gconv-${cid}`,
      created_at: '2026-08-05T00:00:00Z',
      updated_at: '2026-08-05T00:10:00Z',
    }]));

    const { buildRunner } = await loadRunner();
    const built = await buildRunner({
      sessionId: `gconv-${cid}`,
      userId: uid,
      cid,
      historyBoundaryMessageId: boundaryMessageId,
      userMessage: '这个问题之前已经回答过',
    });
    const chatHistoryDefinition = built.toolDefs.find((tool) => tool.name === 'chat_history');
    const chatHistory = (built.runner as unknown as { tools: Map<string, any> }).tools.get('chat_history');
    expect(chatHistoryDefinition).toBeTruthy();
    expect(chatHistory).toBeTruthy();
    expect((chatHistoryDefinition?.inputSchema as any).properties.scope.enum)
      .toEqual(['current', 'all']);

    const invalidProject = await chatHistory.execute(
      { action: 'read', scope: 'project' },
      { state: {} } as any,
    );
    expect(invalidProject.isError).toBe(true);
    expect(invalidProject.content).toContain('scope "project" is not allowed');

    const pages: string[] = [];
    let beforeMsgIndex: number | undefined;
    for (let page = 0; page < 4; page += 1) {
      const result = await chatHistory.execute({
        action: 'read',
        scope: 'current',
        page: beforeMsgIndex === undefined
          ? { mode: 'latest', count: 10 }
          : { mode: 'before', index: beforeMsgIndex, count: 10 },
      }, { state: {} } as any);
      expect(result.isError).toBeFalsy();
      pages.push(result.content);
      const next = result.content.match(/"mode":"before","index":(\d+)/);
      beforeMsgIndex = next ? Number(next[1]) : undefined;
    }

    expect(pages).toHaveLength(4);
    expect(pages.slice(0, 3).join('\n')).not.toContain(decision);
    expect(pages[3]).toContain(decision);
    expect(pages.join('\n')).not.toContain('这个问题之前已经回答过');
  });
});

describe('splitCommanderOrchestrationBlock (cache-prefix hygiene)', () => {
  it('moves the volatile orchestration ledger out of the stable prefix, keeping surrounding rules', async () => {
    const { _splitCommanderOrchestrationBlock } = await loadRunner();
    const prompt = [
      '# Commander',
      'Stable rules here.',
      '',
      '---',
      '',
      '## Orchestration continuity',
      '',
      'Do not re-ask for information already supplied by the agent or form.',
      '',
      '---',
      '',
      '## Orchestration state',
      '',
      '<orchestration-ledger>{"status":"interrupted","updated_at":123}</orchestration-ledger>',
      '',
      '---',
      '',
      '## Routing-first algorithm',
      '',
      'More stable rules.',
    ].join('\n');

    const { stable, orchestrationBlock } = _splitCommanderOrchestrationBlock(prompt);

    expect(orchestrationBlock).toContain('## Orchestration state');
    expect(orchestrationBlock).toContain('orchestration-ledger');
    expect(stable).not.toContain('orchestration-ledger');
    expect(stable).not.toContain('## Orchestration state');
    expect(stable).toContain('Stable rules here.');
    expect(stable).toContain('## Routing-first algorithm');
    expect(stable).toContain('More stable rules.');
  });

  it('is a no-op for a prompt without an orchestration block', async () => {
    const { _splitCommanderOrchestrationBlock } = await loadRunner();
    const prompt = 'You are an agent.\n\n## Runtime injection\n\nfoo';
    const { stable, orchestrationBlock } = _splitCommanderOrchestrationBlock(prompt);
    expect(orchestrationBlock).toBe('');
    expect(stable).toBe(prompt);
  });
});
