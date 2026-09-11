import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import type { AgentSummary } from '../../../src/main/features/agents';
import { TOOL_CATALOG_REVISION } from '../../../src/main/model/core-agent/tool-catalog-revision';

// runner.ts dynamically imports core-agent when building a real runner, but
// the auth gate fires BEFORE that import — so these tests can exercise the
// missing-credential path without core-agent being resolvable/installed.

let tmpDir: string;
let prevWs: string | undefined;
let prevAnthropicKey: string | undefined;
let prevToolLoadingMode: string | undefined;

const CONTENT_WRITER_AGENT_ID = '173d4235a431';
const CITATION_VERIFY_AGENT_IDS = [
  '78900d8758bc',
  '5dd962efb425',
  '17c0a2e95df3',
  '7083ff63b398',
] as const;
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
  vi.doUnmock('../../../src/main/features/project_library_indexer');
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
  it('injects the originating account assessment read-only after the active account changes', async () => {
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
    expect(built.toolDefs.some((tool) => tool.name === 'metacognition')).toBe(false);
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
    expect(built.turnEphemeral).not.toContain('## Active tool groups');
    expect(runnerToolNames).toEqual(expect.arrayContaining(publicToolNames));
    expect(runnerToolNames).toEqual(expect.arrayContaining([
      'library', 'create_pptx', 'edit_file', 'process_session', 'tool_load',
    ]));
    expect(runnerToolNames).not.toContain('read_file');
    expect(runnerToolNames).not.toContain('stat_file');
  });
});

describe('runner › scoped tool loading', () => {
  it.each(['gconv', 'gmember'])('allows %s to update current-project context and create bound tasks', async (kind) => {
    process.env.ORKAS_TOOL_LOADING_MODE = 'scoped';
    const uid = 'project-context-parity';
    await configureUser(uid);
    const projects = await import('../../../src/main/features/projects');
    const memory = await import('../../../src/main/features/memory');
    const created = await projects.createProject(uid, 'Context parity');
    if (!created.ok) throw new Error('project fixture failed');
    const projectId = created.project.project_id;
    const { buildRunner } = await loadRunner();
    const built = await buildRunner({ sessionId: `${kind}-context-parity`, userId: uid,
      projectId, ...(kind === 'gmember' ? { agentId: 'named-agent', toolList: [] } : {}) });
    const tools = (built.runner as unknown as { tools: Map<string, any> }).tools;
    expect(built.toolDefs.map((tool) => tool.name)).toContain('project_instructions');
    const ctx = { workingDir: tmpDir, state: {} } as any;
    expect((await tools.get('project_instructions').execute({ instructions: 'Use accessible controls.' }, ctx)).isError).toBe(false);
    expect((await tools.get('cross_session_memory').execute({ action: 'add', target: 'project', content: 'The audience uses keyboard navigation.' }, ctx)).isError).toBe(false);
    expect(memory.listEntries(uid, { project: projectId }).entries).toEqual(['The audience uses keyboard navigation.']);
    await projects.writeProjectInstructions(uid, projectId, 'Newer user rule.');
    expect((await tools.get('project_instructions').execute({ instructions: 'Stale replacement.' }, ctx)).isError).toBe(true);
    expect(await projects.readProjectInstructions(uid, projectId)).toMatchObject({ content: 'Newer user rule.' });
    if (kind === 'gmember') {
      const added = await tools.get('todo_tasks').execute({ action: 'create', title: 'Authorized project item' }, ctx);
      expect(added.isError).toBeFalsy();
      const tasks = await import('../../../src/main/features/project_tasks');
      expect((await tasks.listTasks(uid, projectId)).map((task) => task.title)).toContain('Authorized project item');
      expect((await tools.get('todo_tasks').execute({ action: 'create', title: 'Wrong scope', project: '__global__' }, ctx)).isError).toBe(true);
    }
  });

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

  async function projectActor(uid: string, projectId: string, agentId: string, kind = 'gmember') {
    const { buildRunner } = await loadRunner();
    const built = await buildRunner({
      sessionId: `${kind}-${agentId}`, userId: uid, projectId,
      ...(kind === 'gmember' ? { agentId, toolList: ['workspace.write.output'] } : {}),
    });
    const runner = built.runner as unknown as {
      activeTools(): Array<{
        name: string;
        execute(input: Record<string, unknown>, ctx: unknown): Promise<{ content: string; isError?: boolean }>;
      }>;
    };
    // Execute only provider-visible tools, not dormant executors in the runner map.
    return async (name: string, input: Record<string, unknown>) => {
      const tool = runner.activeTools().find((entry) => entry.name === name);
      expect(tool, `${kind}/${agentId} must expose ${name}`).toBeDefined();
      return tool!.execute(input, { workingDir: tmpDir, state: {} });
    };
  }

  it.each(['gconv', 'gmember'])('lets %s correct another Agent project memory without changing private or other-project records', async (kind) => {
    process.env.ORKAS_TOOL_LOADING_MODE = 'scoped';
    const uid = 'memory-edit-actors';
    await configureUser(uid);
    const projects = await import('../../../src/main/features/projects');
    const memory = await import('../../../src/main/features/memory');
    const project = await projects.createProject(uid, 'Shared project');
    const other = await projects.createProject(uid, 'Unrelated project');
    if (!project.ok || !other.ok) throw new Error('project fixture failed');
    const original = 'The release channel is preview.';
    const corrected = 'The release channel is stable.';
    const retained = 'The interface supports keyboard navigation.';
    memory.addEntry(uid, { project: other.project.project_id }, original);
    memory.addAgentEntry(uid, 'author', 'Private author preference.');
    memory.addEntry(uid, 'user', 'User prefers concise explanations.');
    memory.addEntry(uid, 'memory', 'Shared organization convention.');
    const author = await projectActor(uid, project.project.project_id, 'author');
    const editor = await projectActor(uid, project.project.project_id, 'editor', kind);
    for (const content of [original, retained]) {
      expect((await author('cross_session_memory', { action: 'add', target: 'project', content })).isError).toBe(false);
    }
    expect(JSON.parse((await editor('cross_session_memory', { action: 'list', target: 'project' })).content).entries)
      .toEqual([original, retained]);
    expect((await editor('cross_session_memory', { action: 'replace', target: 'project', old_text: original, content: corrected })).isError).toBe(false);
    expect(memory.listEntries(uid, { project: project.project.project_id }).entries).toEqual([corrected, retained]);
    // A stale removal must neither erase the correction nor report false success.
    const stale = await author('cross_session_memory', { action: 'remove', target: 'project', old_text: original });
    expect(stale.isError).toBe(true);
    expect(JSON.parse(stale.content).error).toContain('old_text not found');
    expect(memory.listEntries(uid, { project: project.project.project_id }).entries).toEqual([corrected, retained]);
    expect((await editor('cross_session_memory', { action: 'remove', target: 'project', old_text: corrected })).isError).toBe(false);
    expect(JSON.parse((await author('cross_session_memory', { action: 'list', target: 'project' })).content).entries).toEqual([retained]);
    expect(memory.listEntries(uid, { project: other.project.project_id }).entries).toEqual([original]);
    expect(memory.listAgentEntries(uid, 'author').entries).toEqual(['Private author preference.']);
    expect(memory.listAgentEntries(uid, kind === 'gconv' ? 'commander' : 'editor').entries).toEqual([]);
    expect(memory.listEntries(uid, 'user').entries).toEqual(['User prefers concise explanations.']);
    expect(memory.listEntries(uid, 'memory').entries).toEqual(['Shared organization convention.']);
  });

  it('allows a second named Agent to recover from stale project instructions in a fresh turn', async () => {
    process.env.ORKAS_TOOL_LOADING_MODE = 'scoped';
    const uid = 'instructions-edit-actors';
    await configureUser(uid);
    const projects = await import('../../../src/main/features/projects');
    const project = await projects.createProject(uid, 'Shared instructions');
    if (!project.ok) throw new Error('project fixture failed');
    const pid = project.project.project_id;
    const original = 'Preserve accessible controls.';
    await projects.writeProjectInstructions(uid, pid, original);
    const author = await projectActor(uid, pid, 'author');
    const staleEditor = await projectActor(uid, pid, 'editor');
    const first = `${original}\nSupport keyboard shortcuts.`;
    expect((await author('project_instructions', { instructions: first })).isError).toBe(false);
    const rejected = await staleEditor('project_instructions', { instructions: 'Outdated replacement.' });
    expect(rejected.isError).toBe(true);
    expect(JSON.parse(rejected.content).error).toContain('new turn');
    expect(await projects.readProjectInstructions(uid, pid)).toMatchObject({ content: first });
    const freshEditor = await projectActor(uid, pid, 'editor-new-turn');
    const second = `${first}\nDocument focus order.`;
    expect((await freshEditor('project_instructions', { instructions: second })).isError).toBe(false);
    expect(await projects.readProjectInstructions(uid, pid)).toMatchObject({ content: second });
    // The successful editor can make another authorized edit in the same turn.
    const third = `${second}\nUse descriptive labels.`;
    expect((await freshEditor('project_instructions', { instructions: third })).isError).toBe(false);
    expect(await projects.readProjectInstructions(uid, pid)).toMatchObject({ content: third });
  });

  it.each(['gconv', 'gmember'])('lets %s publish a Library file that another Agent edits with conflict recovery', async (kind) => {
    process.env.ORKAS_TOOL_LOADING_MODE = 'scoped';
    // This case owns actor wiring and real file persistence. Embedding has its
    // own indexer suite; only its scheduling boundary belongs in this journey.
    const indexUpdates: unknown[][] = [];
    vi.doMock('../../../src/main/features/project_library_indexer', () => ({
      enqueue: (...args: unknown[]) => { indexUpdates.push(args); },
    }));
    const uid = 'library-edit-actors';
    await configureUser(uid);
    const projects = await import('../../../src/main/features/projects');
    const workspace = await import('../../../src/main/features/user_workspace');
    const files = await import('../../../src/main/features/project_files');
    const project = await projects.createProject(uid, 'Shared deliverable');
    const other = await projects.createProject(uid, 'Unrelated deliverable');
    if (!project.ok || !other.ok) throw new Error('project fixture failed');
    const pid = project.project.project_id;
    expect(workspace.setWorkspacePath(uid, tmpDir, pid).ok).toBe(true);
    await files.uploadProjectFile(uid, other.project.project_id, 'report.md', Buffer.from('Other project content.'));
    const author = await projectActor(uid, pid, 'author', kind);
    if (kind === 'gconv') expect((await author('tool_load', { groups: ['workspace.write.output'] })).isError).toBeFalsy();
    const editor = await projectActor(uid, pid, 'editor');
    fs.writeFileSync(path.join(tmpDir, 'report.md'), 'Original deliverable.');
    expect((await author('library_save', { source_path: 'report.md' })).isError).toBeFalsy();
    const checkout = async (call: typeof editor, source_path: string) => {
      const result = await call('library_save', { action: 'checkout', name: 'report.md', source_path });
      expect(result.isError).toBe(false);
      expect(fs.readFileSync(path.join(tmpDir, source_path), 'utf8')).toBe('Original deliverable.');
      return JSON.parse(result.content).revision as string;
    };
    const authorRevision = await checkout(author, 'author-edit.md');
    const editorRevision = await checkout(editor, 'editor-edit.md');
    fs.writeFileSync(path.join(tmpDir, 'author-edit.md'), 'First correction.');
    expect((await author('library_save', { source_path: 'author-edit.md', name: 'report.md', expected_revision: authorRevision })).isError).toBe(false);
    fs.writeFileSync(path.join(tmpDir, 'editor-edit.md'), 'Stale second correction.');
    const rejected = await editor('library_save', { source_path: 'editor-edit.md', name: 'report.md', expected_revision: editorRevision });
    expect(rejected.isError).toBe(true);
    expect(JSON.parse(rejected.content).error).toContain('checkout again');
    expect(await files.readProjectTextFile(uid, pid, 'report.md')).toMatchObject({ content: 'First correction.' });
    expect((await editor('library_save', { source_path: 'editor-edit.md', name: 'report.md' })).isError).toBe(true);
    const fresh = await editor('library_save', { action: 'checkout', name: 'report.md', source_path: 'fresh-edit.md' });
    expect(fresh.isError).toBe(false);
    expect(fs.readFileSync(path.join(tmpDir, 'fresh-edit.md'), 'utf8')).toBe('First correction.');
    fs.writeFileSync(path.join(tmpDir, 'fresh-edit.md'), 'First correction.\nSecond Agent addition.');
    expect((await editor('library_save', { source_path: 'fresh-edit.md', name: 'report.md', expected_revision: JSON.parse(fresh.content).revision })).isError).toBe(false);
    expect(await files.readProjectTextFile(uid, pid, 'report.md')).toMatchObject({ content: 'First correction.\nSecond Agent addition.' });
    expect(await files.readProjectTextFile(uid, other.project.project_id, 'report.md')).toMatchObject({ content: 'Other project content.' });
    expect(indexUpdates).toEqual([
      [uid, other.project.project_id, 'report.md', 'upsert'],
      [uid, pid, 'report.md', 'upsert'],
      [uid, pid, 'report.md', 'upsert'],
      [uid, pid, 'report.md', 'upsert'],
    ]);
  });

  it.each([
    { agentId: CONTENT_WRITER_AGENT_ID, maximal: false },
    { agentId: VIDEO_STUDIO_AGENT_ID, maximal: true },
  ])('keeps progress guidance in the assembled Agent surface ($agentId, maximal=$maximal)', async ({ agentId, maximal }) => {
    const uid = `runner-progress-surface-${agentId}`;
    await configureUser(uid);
    const paths = await import('../../../src/main/paths');
    const { normalizeAgent } = await import('../../../src/main/features/agents');
    const { _buildAgentInGroupSystemPromptForTest } = await import('../../../src/main/features/group_chat/bus');
    const { AGENT_FALLBACK_TOOL_GROUP_IDS } = await import('../../../src/main/model/core-agent/tool-catalog');
    const systemSkills = await import('../../../src/main/features/system_skills');
    await systemSkills.reconcileAllForUser(uid);
    const root = path.resolve(__dirname, '../../../resources/builtin/marketplace/agents', agentId);
    const agent = normalizeAgent(JSON.parse(fs.readFileSync(path.join(root, 'agent.json'), 'utf8')), 'builtin')!;
    const sourceSkills = path.join(root, 'skills');
    // Only the manifests enter this surface; no scripts/assets need installing.
    for (const skill of fs.existsSync(sourceSkills) ? fs.readdirSync(sourceSkills) : []) {
      const manifest = path.join(sourceSkills, skill, 'SKILL.md');
      if (!fs.existsSync(manifest)) continue;
      const dest = path.join(paths.userMarketplaceAgentSkillsDir(uid, agentId), skill);
      fs.mkdirSync(dest, { recursive: true });
      fs.copyFileSync(manifest, path.join(dest, 'SKILL.md'));
    }
    const base = await _buildAgentInGroupSystemPromptForTest(agent, tmpDir, 'en');
    const { buildRunner } = await loadRunner();
    const built = await buildRunner({
      sessionId: `gmember-progress-surface-${agentId}`, userId: uid, agentId,
      systemPrompt: base, skillList: agent.skill_list,
      // Largest resident built-in workflow + every eligible fallback group.
      toolList: maximal ? [...AGENT_FALLBACK_TOOL_GROUP_IDS] : agent.tool_list,
    });
    const prompt = built.resolvedSystemPrompt;
    expect(prompt.match(/These updates are not final replies/g)).toHaveLength(1);
    expect(prompt).not.toContain('before the first tool call');
    expect(prompt).not.toContain('Once you output, your turn is done.');
    expect(prompt).toContain('Resolve inputs before dependent work');
    expect(prompt).toContain('<handback reason="completed_handoff" />');
    if (maximal) expect(prompt).toContain('## Available skills (skills)');
    expect(prompt.indexOf('These updates are not final replies')).toBeLessThan(prompt.indexOf('## Runtime injection'));
    expect(prompt.lastIndexOf('## User language')).toBeGreaterThan(prompt.indexOf('## Runtime injection'));
    expect(prompt).not.toMatch(/\$(?:workflow|inputs_schema|input_channel_protocol|plan_interaction_hint)/);
    const toolChars = JSON.stringify(built.toolDefs).length;
    const combined = prompt.length + built.turnEphemeral.length + toolChars;
    console.log(`[agent-effective-progress-surface] ${agent.name}: system=${prompt.length}, ephemeral=${built.turnEphemeral.length}, tools=${toolChars}, combined=${combined}`);
    // The merged action-specific tool contracts add 5,539 / 6,995 schema
    // chars, while removing the active-group tail saves 162 / 382 chars.
    // With the same OfficeCLI fixture, resident prompts remain unchanged:
    // totals move from 38,370 / 91,255 to 43,747 / 97,868. Keep comparable
    // headroom; the independent tool and resident-prompt budgets still apply.
    expect(combined).toBeLessThanOrEqual(maximal ? 100_000 : 45_500);
  });

  it('defers unbound Commander project tasks and exposes bound reads without injecting backlog records', async () => {
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
    const projects = await import('../../../src/main/features/projects');
    const tasks = await import('../../../src/main/features/project_tasks');
    const created = await projects.createProject(uid, 'On-demand backlog');
    if (!created.ok) throw new Error('project fixture failed');
    await tasks.createTask(uid, created.project.project_id, { title: 'BACKLOG_NOT_IN_PROMPT' });
    const project = await buildRunner({
      sessionId: 'gconv-project-task-gate-project',
      userId: uid,
      cid: 'conversation-in-project',
      projectId: created.project.project_id,
    });

    expect(nonProject.resolvedSystemPrompt).not.toContain('**todo-tasks**');
    expect(nonProject.toolDefs.map((tool) => tool.name)).not.toContain('todo_tasks');
    expect(nonProject.resolvedSystemPrompt).toContain('`management.projects`');
    expect(nonProject.resolvedSystemPrompt).toContain('`todo_tasks` —');
    expect(nonProject.turnEphemeral).not.toContain('## Project status');

    expect(project.resolvedSystemPrompt).not.toContain('**todo-tasks**');
    expect(project.toolDefs.map((tool) => tool.name)).toContain('todo_tasks');
    expect(project.toolDefs.map((tool) => tool.name)).not.toContain('project_tasks');
    expect((project.runner as any).tools.has('project_tasks')).toBe(false);
    expect(project.resolvedSystemPrompt).not.toContain('## Project status');
    expect(project.turnEphemeral).not.toContain('## Project status');
    expect(project.resolvedSystemPrompt + project.turnEphemeral).not.toContain('BACKLOG_NOT_IN_PROMPT');
    const listed = await (project.runner as any).tools.get('todo_tasks').execute({ action: 'list' }, { state: {} });
    expect(JSON.parse(listed.content).tasks).toContainEqual(expect.objectContaining({ title: 'BACKLOG_NOT_IN_PROMPT' }));
  });

  it('loads tasks outside a project and writes only to an explicitly resolved project or global scope', async () => {
    process.env.ORKAS_TOOL_LOADING_MODE = 'scoped';
    const uid = 'runner-unbound-project-tasks';
    await configureUser(uid);
    const projects = await import('../../../src/main/features/projects');
    const tasks = await import('../../../src/main/features/project_tasks');
    const target = await projects.createProject(uid, '测试项目');
    const other = await projects.createProject(uid, 'Other');
    const foreign = await projects.createProject('different-account', 'Foreign');
    if (!target.ok || !other.ok || !foreign.ok) throw new Error('project fixture failed');
    const names = vi.spyOn(projects, 'listProjectNameRows');
    const { buildRunner } = await loadRunner();
    const built = await buildRunner({ sessionId: 'gconv-unbound-project-tasks', userId: uid, cid: 'outside-project' });
    const runner = built.runner as any;
    const initialPrompt = built.resolvedSystemPrompt;
    const initialTail = built.turnEphemeral;
    expect(names).not.toHaveBeenCalled();
    expect(built.runner.getActiveToolDefinitions().map((tool) => tool.name)).not.toContain('todo_tasks');
    const context = { workingDir: tmpDir, state: {} };
    const load = await runner.tools.get('tool_load').execute({ groups: ['management.projects'] }, context);
    expect(JSON.parse(load.content)).toMatchObject({ ok: true, newly_activated_tools: ['todo_tasks'] });
    expect(names).not.toHaveBeenCalled();
    expect(built.runner.getActiveToolDefinitions().map((tool) => tool.name)).toContain('todo_tasks');
    const tool = runner.tools.get('todo_tasks');
    const discovery = JSON.parse((await tool.execute({ action: 'list_projects' }, context)).content);
    expect(discovery.projects.map((project: any) => project.project_id).sort())
      .toEqual(['__global__', target.project.project_id, other.project.project_id].sort());
    const globalCreated = await tool.execute({ action: 'create', project: '__global__', title: '全局待办' }, context);
    expect(JSON.parse(globalCreated.content)).toMatchObject({
      ok: true,
      outcome: 'task_created',
      project: { project_id: '__global__', name: 'Global' },
    });
    expect(await tasks.listTasks(uid, '')).toEqual([
      expect.objectContaining({ title: '全局待办', origin_cid: 'outside-project', status: 'todo' }),
    ]);
    const request = { action: 'create', project: '测试项目', title: '这是一条测试待办' };
    const created = await tool.execute(request, context);
    expect(JSON.parse(created.content)).toMatchObject({
      ok: true, outcome: 'task_created', project: { project_id: target.project.project_id },
    });
    const repeated = await tool.execute(request, context);
    expect(JSON.parse(repeated.content)).toMatchObject({ ok: true, outcome: 'existing_task_reused' });
    const persisted = await tasks.listTasks(uid, target.project.project_id);
    expect(persisted).toHaveLength(1);
    expect(persisted[0]).toMatchObject({ title: request.title, origin_cid: 'outside-project', status: 'todo' });
    const userCreated = await tasks.createTask(uid, target.project.project_id, { title: 'Status-linked task' });
    if (!userCreated.ok) throw new Error('user-created task fixture failed');
    const statusUpdate = await tool.execute({
      action: 'update',
      project: target.project.project_id,
      task_id: userCreated.task.id,
      status: 'progress',
    }, context);
    expect(statusUpdate.isError).not.toBe(true);
    expect(await tasks.getTask(uid, target.project.project_id, userCreated.task.id)).toMatchObject({
      status: 'progress',
      origin_cid: 'outside-project',
    });
    const completedByConversation = await tasks.createTask(uid, target.project.project_id, { title: 'Complete-linked task' });
    if (!completedByConversation.ok) throw new Error('complete-linked task fixture failed');
    const completed = await tool.execute({
      action: 'complete',
      project: target.project.project_id,
      task_id: completedByConversation.task.id,
    }, context);
    expect(completed.isError).not.toBe(true);
    expect(await tasks.getTask(uid, target.project.project_id, completedByConversation.task.id)).toMatchObject({
      status: 'done',
      origin_cid: 'outside-project',
    });
    const titleOnly = await tasks.createTask(uid, target.project.project_id, { title: 'Title-only task' });
    if (!titleOnly.ok) throw new Error('title-only task fixture failed');
    await tool.execute({
      action: 'update',
      project: target.project.project_id,
      task_id: titleOnly.task.id,
      title: 'Title-only edit',
    }, context);
    expect((await tasks.getTask(uid, target.project.project_id, titleOnly.task.id))?.origin_cid).toBeUndefined();
    expect(await tasks.listTasks(uid, other.project.project_id)).toEqual([]);
    for (const project of ['missing', '../different-account', foreign.project.project_id]) {
      const rejected = await tool.execute({ ...request, project }, context);
      expect(rejected.isError).toBe(true);
      expect(JSON.parse(rejected.content).error).toContain('project_not_found');
    }
    expect(await tasks.listTasks('different-account', foreign.project.project_id)).toEqual([]);
    expect(built.resolvedSystemPrompt).toBe(initialPrompt);
    expect(built.turnEphemeral).toBe(initialTail);
    const next = await buildRunner({ sessionId: 'gconv-unbound-project-tasks', userId: uid, cid: 'outside-project' });
    expect(next.runner.getActiveToolDefinitions().map((entry) => entry.name)).not.toContain('todo_tasks');
    names.mockRestore();
  });

  it('rejects ambiguous or stale unbound project targets and preserves bound Agent isolation', async () => {
    process.env.ORKAS_TOOL_LOADING_MODE = 'scoped';
    const uid = 'runner-project-target-boundaries';
    await configureUser(uid);
    const projects = await import('../../../src/main/features/projects');
    const tasks = await import('../../../src/main/features/project_tasks');
    const first = await projects.createProject(uid, 'A');
    const second = await projects.createProject(uid, 'B');
    if (!first.ok || !second.ok) throw new Error('project fixture failed');
    const { buildRunner } = await loadRunner();
    // Synced/legacy duplicate names are possible even though create rejects them.
    const duplicateNames = vi.spyOn(projects, 'listProjectNameRows').mockResolvedValue([
      { project_id: first.project.project_id, name: 'Same' },
      { project_id: second.project.project_id, name: 'Same' },
    ]);
    const built = await buildRunner({ sessionId: 'gconv-project-target-boundaries', userId: uid });
    const runner = built.runner as any;
    const context = { state: {} };
    await runner.tools.get('tool_load').execute({ groups: ['management.projects'] }, context);
    const rejected = await runner.tools.get('todo_tasks').execute({ action: 'create', project: 'Same', title: 'Do it' }, context);
    expect(rejected.isError).toBe(true);
    expect(JSON.parse(rejected.content).candidates).toHaveLength(2);
    expect(await tasks.listTasks(uid, first.project.project_id)).toEqual([]);
    expect(await tasks.listTasks(uid, second.project.project_id)).toEqual([]);
    duplicateNames.mockResolvedValue([{ project_id: first.project.project_id, name: 'A' }]);
    await projects.deleteProject(uid, second.project.project_id);
    expect((await runner.tools.get('todo_tasks').execute({ action: 'list', project: second.project.project_id }, context)).isError).toBe(true);

    const agentTask = await tasks.createTask(uid, first.project.project_id, { title: 'AGENT_BACKLOG_ON_DEMAND' });
    if (!agentTask.ok) throw new Error('agent task fixture failed');
    const agent = await buildRunner({
      sessionId: 'gmember-project-target-agent', userId: uid, agentId: 'reader', cid: 'agent-result',
      projectId: first.project.project_id, toolList: [],
    });
    const agentRunner = agent.runner as any;
    const bound = agentRunner.tools.get('todo_tasks');
    const automation = agentRunner.tools.get('auto_tasks');
    expect(agent.runner.getActiveToolDefinitions().map((tool) => tool.name)).toContain('auto_tasks');
    const scheduled = await automation.execute({ action: 'create', content: 'Daily report', schedule: { type: 'daily', hour: 9, minute: 0 }, enabled: false }, context);
    expect(scheduled.isError).toBe(false);
    const autoTasks = await import('../../../src/main/features/auto_tasks');
    expect(await autoTasks.getTask(uid, JSON.parse(scheduled.content).taskId)).toMatchObject({ project_id: first.project.project_id, enabled: false });
    expect((await automation.execute({ action: 'list', project_id: '__global__' }, context)).isError).toBe(true);
    expect(agent.resolvedSystemPrompt + agent.turnEphemeral).not.toContain('AGENT_BACKLOG_ON_DEMAND');
    expect(JSON.parse((await bound.execute({ action: 'list' }, context)).content).tasks)
      .toContainEqual(expect.objectContaining({ title: 'AGENT_BACKLOG_ON_DEMAND' }));
    expect(agent.runner.getActiveToolDefinitions().map((tool) => tool.name)).toContain('todo_tasks');
    expect(bound.inputSchema.properties.action.enum).toEqual(['list', 'create', 'update', 'complete']);
    expect((await bound.execute({ action: 'update', task_id: agentTask.task.id, status: 'review', result_ref: 'artifact-1' }, context)).isError).toBeFalsy();
    expect(await tasks.getTask(uid, first.project.project_id, agentTask.task.id)).toMatchObject({ status: 'review', result_ref: 'artifact-1', origin_cid: 'agent-result' });
    expect((await bound.execute({ action: 'complete', task_id: agentTask.task.id }, context)).isError).toBeFalsy();
    expect((await tasks.getTask(uid, first.project.project_id, agentTask.task.id))?.status).toBe('done');
    expect((await bound.execute({ action: 'update', task_id: agentTask.task.id, status: 'todo', owner: 'other' }, context)).isError).toBe(true);
    expect((await bound.execute({ action: 'update', task_id: agentTask.task.id, status: 'todo', project: second.project.project_id }, context)).isError).toBe(true);
    expect((await tasks.getTask(uid, first.project.project_id, agentTask.task.id))?.status).toBe('done');
    expect(bound.inputSchema.properties.project).toBeUndefined();
    const added = await bound.execute({ action: 'create', title: 'Agent-created item' }, context);
    expect(added.isError).toBeFalsy();
    const addedId = JSON.parse(added.content).task.id;
    expect(await tasks.getTask(uid, first.project.project_id, addedId)).toMatchObject({ title: 'Agent-created item', origin_cid: 'agent-result' });
    expect((await bound.execute({ action: 'update', task_id: addedId, title: 'Edited by Agent', detail: 'New detail' }, context)).isError).toBeFalsy();
    expect(await tasks.getTask(uid, first.project.project_id, addedId)).toMatchObject({ title: 'Edited by Agent', detail: 'New detail' });
    for (const project of [second.project.project_id, '__global__']) {
      expect((await bound.execute({ action: 'create', title: 'forbidden', project }, context)).isError).toBe(true);
    }
    expect((await agentRunner.tools.get('tool_load').execute({ groups: ['management.projects'] }, context)).isError).toBe(true);
    const unboundAgent = await buildRunner({ sessionId: 'gmember-unbound-reader', userId: uid, agentId: 'reader', toolList: [] });
    expect((unboundAgent.runner as any).tools.has('todo_tasks')).toBe(false);
    expect((unboundAgent.runner as any).tools.has('auto_tasks')).toBe(false);
    duplicateNames.mockRestore();
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
    expect(namedActiveNames).not.toContain('run_program');
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
    expect(defaultActiveNames).not.toContain('run_program');
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

  it('exposes citation verification on the real runner surface only to its four web owners', async () => {
    process.env.ORKAS_TOOL_LOADING_MODE = 'scoped';
    const uid = 'runner-citation-verifier-owners';
    await configureUser(uid);
    const { buildRunner } = await loadRunner();

    for (const agentId of CITATION_VERIFY_AGENT_IDS) {
      const built = await buildRunner({
        sessionId: `gmember-citation-verifier-${agentId}`,
        userId: uid,
        agentId,
        toolList: ['web'],
      });
      const runner = built.runner as unknown as {
        tools: Map<string, unknown>;
        getActiveToolDefinitions(): Array<{ name: string }>;
      };
      const providerNames = runner.getActiveToolDefinitions()
        .map((tool) => tool.name)
        .sort();

      expect(providerNames, agentId).toEqual(expect.arrayContaining([
        'web_fetch',
        'research_verify_citations',
      ]));
      expect(runner.tools.has('research_verify_citations'), agentId).toBe(true);
      expect(built.toolDefs.map((tool) => tool.name).sort(), agentId).toEqual(providerNames);
    }

    const nonOwner = await buildRunner({
      sessionId: 'gmember-citation-verifier-non-owner',
      userId: uid,
      agentId: CONTENT_WRITER_AGENT_ID,
      toolList: ['web'],
    });
    const nonOwnerRunner = nonOwner.runner as unknown as {
      tools: Map<string, unknown>;
      getActiveToolDefinitions(): Array<{ name: string }>;
    };
    expect(nonOwnerRunner.getActiveToolDefinitions().map((tool) => tool.name))
      .toContain('web_fetch');
    expect(nonOwnerRunner.getActiveToolDefinitions().map((tool) => tool.name))
      .not.toContain('research_verify_citations');
    expect(nonOwnerRunner.tools.has('research_verify_citations')).toBe(false);

    const commander = await buildRunner({
      sessionId: 'gconv-citation-verifier-owner-gate',
      userId: uid,
    });
    expect(commander.toolDefs.map((tool) => tool.name)).toContain('web_fetch');
    expect(commander.toolDefs.map((tool) => tool.name))
      .not.toContain('research_verify_citations');
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

  it('preloads Commander command, web, Skill search, and app navigation while mutation tools stay dormant', async () => {
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
        {
          name: 'open_app_view',
          description: 'Stage app navigation.',
          inputSchema: { type: 'object', properties: {}, additionalProperties: false },
          async execute() { return { content: JSON.stringify({ ok: true }) }; },
        },
        {
          name: 'app_health',
          description: 'Inspect sanitized app health.',
          inputSchema: { type: 'object', properties: {}, additionalProperties: false },
          async execute() { return { content: JSON.stringify({ ok: true }) }; },
        },
      ],
    });

    const toolNames = commander.toolDefs.map((tool) => tool.name);
    expect(toolNames).toContain('skill_search');
    expect(toolNames).toContain('open_app_view');
    expect(toolNames).not.toContain('app_health');
    expect(toolNames).toEqual(expect.arrayContaining(['web_search', 'web_fetch']));
    expect(toolNames).toContain('bash');
    expect(toolNames).toContain('tool_load');
    expect(toolNames).toContain('run_program');
    expect(toolNames).not.toContain('manage_execution_plan');
    expect(toolNames).not.toContain('marketplace_search');
    expect(toolNames).toEqual(
      commander.runner.getActiveToolDefinitions().map((tool) => tool.name).sort(),
    );
    expect(commander.resolvedSystemPrompt).toContain('## Loadable tool groups');
    expect(commander.resolvedSystemPrompt).not.toContain('Tools:');
    expect(commander.resolvedSystemPrompt).toContain('`marketplace_search` — Search the marketplace.');
    expect(commander.resolvedSystemPrompt).not.toContain('`manage_execution_plan`');
    expect(commander.resolvedSystemPrompt).not.toMatch(/execution Plan/i);
    expect(commander.resolvedSystemPrompt).toContain('`management.app`');
    expect(commander.resolvedSystemPrompt).toContain('`management.skills`');
    expect(commander.resolvedSystemPrompt).toContain('runtime only; not an Agent dependency');
    const directory = commander.resolvedSystemPrompt.split('## Loadable tool groups')[1].split('\n## ')[0];
    for (const name of ['bash', 'read_files', 'web_search', 'web_fetch', 'open_app_view']) {
      expect(directory).not.toContain(`- \`${name}\` —`);
    }
    expect(directory).toContain('`app_health` —');
    expect(directory).not.toContain('`skill_search` —');
    expect(directory).not.toContain('Fallback only');
    expect(commander.toolDefs.find((tool) => tool.name === 'tool_load')?.description)
      .not.toContain('Fallback only');
    const initialPrompt = commander.resolvedSystemPrompt;
    expect(commander.turnEphemeral).not.toContain('## Active tool groups');
    expect(commander.toolSurfaceTelemetry(['bash', 'web_search'])).toMatchObject({
      loadCallCount: 0,
      loadedGroupCount: 0,
      loadedSchemaChars: 0,
      webToolUsed: true,
    });
    const runner = commander.runner as unknown as {
      tools: Map<string, {
        execute: (input: unknown, ctx: unknown) => Promise<{ content: string }>;
      }>;
      getActiveToolDefinitions(): Array<{ name: string }>;
    };
    const loadResult = await runner.tools.get('tool_load')?.execute(
      { groups: ['management.skills'] },
      { workingDir: tmpDir, state: {}, signal: undefined },
    );
    expect(JSON.parse(loadResult?.content || '{}')).toMatchObject({
      ok: true,
      newly_loaded: ['management.skills'],
    });
    const loadedNames = runner.getActiveToolDefinitions().map((tool) => tool.name);
    expect(loadedNames).toContain('skill_search');
    expect(loadedNames).not.toContain('marketplace_search');
    expect(loadedNames).not.toContain('app_health');
    expect(commander.toolSurfaceTelemetry(['tool_load', 'skill_search'])).toMatchObject({
      loadCallCount: 1,
      loadedGroupCount: 1,
      loadedUnusedGroupCount: 0,
    });

    const appLoadResult = await runner.tools.get('tool_load')?.execute(
      { groups: ['management.app'] },
      { workingDir: tmpDir, state: {}, signal: undefined },
    );
    expect(JSON.parse(appLoadResult?.content || '{}')).toMatchObject({
      ok: true,
      newly_loaded: ['management.app'],
    });
    const appLoadedNames = runner.getActiveToolDefinitions().map((tool) => tool.name);
    expect(appLoadedNames).toContain('open_app_view');
    expect(appLoadedNames).toContain('app_health');
    expect(appLoadedNames).toContain('skill_search');
    expect(appLoadedNames).not.toContain('marketplace_search');
    expect(commander.resolvedSystemPrompt).toBe(initialPrompt);
    expect(commander.toolSurfaceTelemetry(['tool_load', 'skill_search', 'app_health'])).toMatchObject({
      loadCallCount: 2,
      loadedGroupCount: 2,
      loadedUnusedGroupCount: 0,
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
    expect(built.resolvedSystemPrompt).toContain('`marketplace_search` — Search the marketplace.');
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
    writeSystemSkill('orkas-guide', 'product usage guide');

    const { buildRunner } = await loadRunner();
    const commander = await buildRunner({
      sessionId: 'gconv-agent-creator-on-demand-directory',
      userId: uid,
      cid: 'agent-creator-on-demand-directory',
      richSteerEnabled: true,
      systemSkillList: ['agent-creator', 'orkas-guide'],
    });
    const readFile = (commander.runner as unknown as { tools: Map<string, any> }).tools.get('read_files');
    const toolContext = { workingDir: tmpDir, state: new Map(), signal: undefined } as any;

    const agentCreator = await readFile.execute({ paths: [{ path: '@skill/agent-creator' }] }, toolContext);
    const otherCreator = await readFile.execute({ paths: [{ path: '@skill/orkas-guide' }] }, toolContext);

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
    expect(otherCreator.content).toContain('product usage guide');
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
    expect(llmEditor.toolDefs.map((tool) => tool.name)).not.toContain('run_program');
    expect(llmEditor.toolDefs.map((tool) => tool.name)).not.toContain('skill_search');
    expect(llmEditor.resolvedSystemPrompt).toContain('## Agent tool dependencies');
    expect(llmEditor.resolvedSystemPrompt).toContain('Tools: `read_files`');
    expect(llmEditor.resolvedSystemPrompt).not.toContain('`management`');
    expect(llmEditor.turnEphemeral).not.toContain('## Active tool groups');
    expect(cliEditor.toolDefs.map((tool) => tool.name)).toContain('read_files');
    expect(cliEditor.toolDefs.map((tool) => tool.name)).not.toContain('skill_search');
    expect(cliEditor.toolDefs.map((tool) => tool.name)).not.toContain('bash');
    expect(cliEditor.toolDefs.map((tool) => tool.name)).not.toContain('tool_load');
    expect(cliEditor.toolDefs.map((tool) => tool.name)).not.toContain('run_program');
    expect(cliEditor.resolvedSystemPrompt).not.toContain('## Loadable tool groups');
  });

  it('advertises lazy shared Skills only to Commander and named-Agent task sessions', async () => {
    const { skillSearchExposureFromSessionId } = await loadRunner();

    expect(skillSearchExposureFromSessionId('gconv-open-skills')).toBe(true);
    expect(skillSearchExposureFromSessionId('gmember-open-skills')).toBe(true);
    expect(skillSearchExposureFromSessionId('gworker-open-skills')).toBe(false);
    expect(skillSearchExposureFromSessionId('agent-open-skills')).toBe(false);
    expect(skillSearchExposureFromSessionId('skill-open-skills')).toBe(false);
  });

  it('keeps read-only Skill search directly active for a named Agent without granting Skill management', async () => {
    process.env.ORKAS_TOOL_LOADING_MODE = 'scoped';
    const uid = 'runner-agent-skill-search';
    await configureUser(uid);
    const { buildRunner } = await loadRunner();
    const built = await buildRunner({
      sessionId: 'gmember-agent-skill-search-agent-a',
      userId: uid,
      agentId: 'agent-a',
      toolList: [],
      extraTools: [{
        name: 'skill_search',
        description: 'Search shared Skills.',
        inputSchema: { type: 'object', properties: {}, additionalProperties: false },
        async execute() { return { content: JSON.stringify({ ok: true, results: [] }) }; },
      }],
    });
    const names = built.toolDefs.map((tool) => tool.name);

    expect(names).toContain('skill_search');
    expect(names).not.toContain('import_skill_package');
    expect(built.resolvedSystemPrompt).toContain('skill_search');
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
    expect(names).toContain('run_program');
    expect(names).not.toContain('manage_execution_plan');
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
    expect(built.turnEphemeral).not.toContain('## Active tool groups');
    expect(built.resolvedSystemPrompt).not.toContain('**bash**');
    expect(built.resolvedSystemPrompt).not.toMatch(/execution Plan/i);
    const runnerToolNames = [
      ...((built.runner as unknown as { tools: Map<string, unknown> }).tools.keys()),
    ];
    expect(runnerToolNames).toEqual(expect.arrayContaining(['bash', 'create_pdf', 'tool_load']));
    expect(runnerToolNames).not.toContain('manage_execution_plan');
    const refusal = (built.runner as unknown as { toolUnavailableMessage(name: string): string })
      .toolUnavailableMessage('bash');
    expect(refusal).toContain('E_TOOL_NOT_LOADED: bash is available but not active.');
    expect(refusal).toContain('workspace.execute.command');
  });

  it('keeps run_program independent of the directly active tool surface', async () => {
    process.env.ORKAS_TOOL_LOADING_MODE = 'scoped';
    const uid = 'runner-programmatic-workspace-tools';
    await configureUser(uid);
    const userWorkspace = await import('../../../src/main/features/user_workspace');
    const workspace = path.join(tmpDir, 'programmatic-workspace');
    fs.mkdirSync(workspace, { recursive: true });
    expect(userWorkspace.setWorkspacePath(uid, workspace)).toMatchObject({ ok: true });
    const savedSource = "json({ executed_saved_program: true });\n";
    fs.writeFileSync(path.join(workspace, 'saved-program.js'), savedSource, 'utf8');
    const bulkBody = `${Array.from({ length: 2000 }, (_, index) => JSON.stringify({
      id: index,
      correction: `修订-${index}`,
      accepted: index % 3 !== 0,
    })).join('\n')}\n`;
    expect(Buffer.byteLength(bulkBody, 'utf8')).toBeGreaterThan(24 * 1024);
    fs.writeFileSync(path.join(workspace, 'bulk.jsonl'), bulkBody, 'utf8');
    const bulkProgramSource = [
      "const result = await tools.read_files({ paths: [{ path: 'bulk.jsonl' }], raw_text: true });",
      "if (!result.ok) throw new Error(result.content);",
      "const payload = JSON.parse(result.content);",
      "const file = payload.files[0];",
      "if (!file.ok) throw new Error(file.error);",
      "const rows = file.content.trim().split('\\n').map((line) => JSON.parse(line));",
      "json({ count: rows.length, last_id: rows[rows.length - 1].id, file_hash: file.file_hash });",
      '',
    ].join('\n');
    fs.writeFileSync(path.join(workspace, 'bulk-program.js'), bulkProgramSource, 'utf8');
    const sideEffectProgramSource = [
      "const result = await tools.write_file({ path: 'side-effect.txt', content: 'side effect complete' });",
      "if (!result.ok) throw new Error(result.content);",
      '',
    ].join('\n');
    fs.writeFileSync(path.join(workspace, 'side-effect-program.js'), sideEffectProgramSource, 'utf8');
    const { buildRunner } = await loadRunner();
    const built = await buildRunner({
      sessionId: 'gconv-programmatic-workspace-tools',
      userId: uid,
    });
    const runner = built.runner as unknown as {
      tools: Map<string, { execute: (input: unknown, ctx: unknown) => Promise<{
        content: string;
        observations?: {
          programExecution?: {
            sourceKind: string;
            sourceSha256: string;
            childCalls: {
              attempted: number;
              succeeded: number;
              failed: number;
              failedTools: Array<{ name: string; count: number }>;
            };
          };
        };
      }> }>;
      getActiveToolDefinitions(): Array<{
        name: string;
        description: string;
        inputSchema: {
          properties?: Record<string, { description?: string }>;
          oneOf?: Array<{ required: string[] }>;
        };
      }>;
    };
    const programDefinition = () => runner.getActiveToolDefinitions()
      .find((tool) => tool.name === 'run_program')!;
    const initialProgramDefinition = programDefinition();

    expect(initialProgramDefinition.description)
      .toContain('tools.<exact_snake_case_name>(direct args)');
    expect(initialProgramDefinition.description)
      .toContain('tool_load reveals schemas, not permission');
    expect(initialProgramDefinition.description)
      .toContain('child policy/concurrency apply');
    expect(programDefinition().inputSchema.properties?.code?.description)
      .toContain('text(value) or json(value)');
    expect(programDefinition().inputSchema.properties?.code?.description)
      .toContain('{ok,content}');
    expect(programDefinition().inputSchema.properties?.path?.description)
      .toContain('execute exactly as saved');
    expect(programDefinition().description).not.toContain('read_files raw_text:true');
    expect(programDefinition().inputSchema.oneOf).toEqual([
      { required: ['code'] },
      { required: ['path'] },
    ]);
    const savedResult = await runner.tools.get('run_program')?.execute(
      { path: 'saved-program.js' },
      { workingDir: workspace, state: {}, signal: undefined },
    );
    expect(savedResult?.content).toContain('{"executed_saved_program":true}');
    expect(savedResult?.observations?.programExecution).toEqual({
      sourceKind: 'file',
      sourceSha256: `sha256:${createHash('sha256').update(savedSource).digest('hex')}`,
      childCalls: { attempted: 0, succeeded: 0, failed: 0, failedTools: [] },
    });
    const bulkResult = await runner.tools.get('run_program')?.execute(
      { path: 'bulk-program.js' },
      { workingDir: workspace, state: {}, signal: undefined },
    );
    expect(bulkResult?.content).toContain('"count":2000');
    expect(bulkResult?.content).toContain('"last_id":1999');
    expect(bulkResult?.content).toContain(
      `"file_hash":"sha256:${createHash('sha256').update(bulkBody).digest('hex')}"`,
    );
    expect(bulkResult?.observations?.programExecution).toEqual({
      sourceKind: 'file',
      sourceSha256: `sha256:${createHash('sha256').update(bulkProgramSource).digest('hex')}`,
      childCalls: { attempted: 1, succeeded: 1, failed: 0, failedTools: [] },
    });

    expect(runner.getActiveToolDefinitions().map((tool) => tool.name)).not.toContain('write_file');
    const hiddenSideEffectResult = await runner.tools.get('run_program')?.execute(
      { path: 'side-effect-program.js' },
      { workingDir: workspace, state: {}, signal: undefined },
    );
    expect(hiddenSideEffectResult?.content)
      .toContain('Program completed after 1 tool call with no emitted output.');
    expect(hiddenSideEffectResult?.content).toContain('Execution receipt:');
    expect(hiddenSideEffectResult?.content).toContain('"changed_files":{"total":1');
    expect(hiddenSideEffectResult?.observations?.programExecution).toEqual({
      sourceKind: 'file',
      sourceSha256: `sha256:${createHash('sha256').update(sideEffectProgramSource).digest('hex')}`,
      childCalls: { attempted: 1, succeeded: 1, failed: 0, failedTools: [] },
    });
    expect(fs.readFileSync(path.join(workspace, 'side-effect.txt'), 'utf8'))
      .toBe('side effect complete');

    const loadResult = await runner.tools.get('tool_load')?.execute(
      { groups: ['workspace.write.output', 'workspace.write.edit', 'workspace.execute.command'] },
      { workingDir: tmpDir, state: {}, signal: undefined },
    );
    expect(JSON.parse(loadResult?.content || '{}')).toMatchObject({ ok: true });

    const refreshed = programDefinition();
    expect(refreshed).toBe(initialProgramDefinition);
    expect(refreshed.inputSchema.properties?.code?.description)
      .toContain('{ok,content}');
    expect(runner.getActiveToolDefinitions().map((tool) => tool.name)).toContain('write_file');
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
    expect(runner.activeTools().map((tool) => tool.name)).toContain('run_program');
    expect(built.resolvedSystemPrompt)
      .toContain('`management.marketplace` (runtime only; not an Agent dependency)');
    expect(built.resolvedSystemPrompt)
      .toContain('`management.automation` (runtime only; not an Agent dependency)');
    expect(managementCalls).toEqual([]);

    const loadResult = await runner.tools.get('tool_load')?.execute(
      { groups: ['management.marketplace'] },
      { workingDir: tmpDir, state: {}, signal: undefined },
    );
    expect(JSON.parse(loadResult?.content || '{}')).toMatchObject({
      ok: true,
      newly_loaded: ['management.marketplace'],
    });
    expect(runner.activeTools().map((tool) => tool.name)).toContain('marketplace_search');
    expect(runner.activeTools().map((tool) => tool.name)).not.toContain('auto_tasks_list');
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
        catalogRevision: TOOL_CATALOG_REVISION,
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
    expect(before.turnEphemeral).not.toContain('## Active tool groups');
    expect(before.turnEphemeral).not.toContain('`web`');

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
      .toMatchObject({ version: 3, loadedGroups: [], catalogRevision: TOOL_CATALOG_REVISION });
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
      'web_search', 'web_fetch', 'library', 'run_program',
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
        source: `group-main-v4:${summaryCid}`,
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
  // The ledger and its event-specific handling rules are emitted only when a
  // suspended orchestration exists. Keep the whole conditional block out of
  // the cached resident prefix.
  it('moves the conditional orchestration rules and ledger out of the stable prefix', async () => {
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

    // The event-specific rules and volatile ledger leave the stable prefix.
    expect(orchestrationBlock).toContain('## Orchestration state');
    expect(orchestrationBlock).toContain('orchestration-ledger');
    expect(orchestrationBlock).toContain('## Orchestration continuity');
    expect(orchestrationBlock).toContain('Do not re-ask for information already supplied by the agent or form.');
    expect(stable).not.toContain('orchestration-ledger');
    expect(stable).not.toContain('## Orchestration state');
    expect(stable).not.toContain('## Orchestration continuity');
    expect(stable).not.toContain('Do not re-ask for information already supplied by the agent or form.');
    // Unrelated rules on either side remain stable.
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

describe('runner › conversation task board turn block (D8/P3)', () => {
  it('passes setup guidance only through Commander turn context without loading connector tools or changing the system prefix', async () => {
    const uid = 'setup-context-runner';
    const users = await import('../../../src/main/features/users');
    const auth = await import('../../../src/main/features/auth');
    users.activateUser(uid);
    const profile = await auth.addApiKey('anthropic', `k-${uid}`, 'Anthropic');
    await auth.addEntry({ provider: 'anthropic', model: 'claude-opus-4-8', profileId: profile.profileId });
    const chats = await import('../../../src/main/features/chats');
    const setup = await import('../../../src/main/features/connector_setup_context');
    const conv = await chats.createConversation(uid);
    const cid = conv.conversation_id;
    const { buildConnectorSetupTool } = await import('../../../src/main/features/group_chat/connector_setup_tool');
    const extraTools = [buildConnectorSetupTool({ uid, language: 'en', stageConfigure: () => ({ ok: true }) })];
    const { buildRunner } = await loadRunner();
    const plain = await buildRunner({ sessionId: `gconv-${cid}`, userId: uid, cid, extraTools });
    expect(plain.turnEphemeral).not.toContain('## Connector setup assistance');
    await setup.bindConnectorSetupAssistance(uid, cid, 'xiaohongshu-seller');
    const bound = await buildRunner({ sessionId: `gconv-${cid}`, userId: uid, cid, extraTools });
    expect(bound.turnEphemeral).toContain(setup.connectorSetupGuidance());
    expect(bound.turnEphemeral).toContain('xiaohongshu-seller');
    expect(bound.turnEphemeral).toContain('"setup_guide_id":"xiaohongshu-ark"');
    expect(bound.turnEphemeral).not.toContain('## Credentials');
    expect(bound.resolvedSystemPrompt).toBe(plain.resolvedSystemPrompt);
    expect(bound.resolvedSystemPrompt).not.toContain(setup.connectorSetupGuidance());
    expect(bound.resolvedSystemPrompt).toContain('`connector_setup`');
    const active = (bound.runner as any).getActiveToolDefinitions().map((tool: any) => tool.name);
    expect(active).not.toContain('connector_setup');
    const member = await buildRunner({ sessionId: `gmember-${cid}-agent-x`, userId: uid, cid });
    expect(member.turnEphemeral).not.toContain('## Connector setup assistance');
    expect(fs.readFileSync(path.join(tmpDir, uid, 'cloud', 'chats', `${cid}.jsonl`), 'utf8')).toBe('');
  });

  it('rides the conversation task board on commander turn-ephemeral only while live rows exist', async () => {
    const uid = 'runner-conversation-board-gate';
    const users = await import('../../../src/main/features/users');
    const auth = await import('../../../src/main/features/auth');
    users.activateUser(uid);
    const profile = await auth.addApiKey('anthropic', `k-${uid}`, 'Anthropic');
    await auth.addEntry({
      provider: 'anthropic',
      model: 'claude-opus-4-8',
      profileId: profile.profileId,
    });
    const tb = await import('../../../src/main/features/group_chat/task_board');
    tb._resetForTest();
    const { buildRunner } = await loadRunner();
    const cid = 'conversation-board-cid';

    // Empty board → no block at all: the lightweight chat path pays nothing.
    const empty = await buildRunner({ sessionId: `gconv-${cid}`, userId: uid, cid });
    expect(empty.turnEphemeral).not.toContain('## Conversation task board');

    const running = await tb.createTask(uid, cid, {
      assignee: 'agent-x', instruction: 'draft the launch plan for tomorrow', createdBy: 'user',
    });
    await tb.claimTask(uid, cid, running.task_id);
    await tb.createTask(uid, cid, {
      assignee: 'agent-y', instruction: 'research the market first', createdBy: 'commander',
    });

    // Commander sees the live board on the uncached turn tail, never in the
    // cached system prefix; a member (agent) session never sees it.
    const withBoard = await buildRunner({ sessionId: `gconv-${cid}`, userId: uid, cid });
    expect(withBoard.turnEphemeral).toContain('## Conversation task board');
    expect(withBoard.turnEphemeral).toContain('[running]');
    expect(withBoard.turnEphemeral).toContain('draft the launch plan');
    expect(withBoard.turnEphemeral).toContain('(dispatched)');
    expect(withBoard.resolvedSystemPrompt).not.toContain('## Conversation task board');
    const member = await buildRunner({ sessionId: `gmember-${cid}-agent-x`, userId: uid, cid });
    expect(member.turnEphemeral).not.toContain('## Conversation task board');
  });
});
