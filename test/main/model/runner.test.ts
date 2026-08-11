import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// runner.ts dynamically imports core-agent when building a real runner, but
// the auth gate fires BEFORE that import — so these tests can exercise the
// missing-credential path without core-agent being resolvable/installed.

let tmpDir: string;
let prevWs: string | undefined;
let prevAnthropicKey: string | undefined;

const CONTENT_WRITER_AGENT_ID = '173d4235a431';
const OFFICE_WORKER_AGENT_ID = 'a19101ba698a';
const IMAGE_STUDIO_AGENT_ID = '814b61b027f0';

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-runner-'));
  prevWs = process.env.ORKAS_WORKSPACE_ROOT;
  prevAnthropicKey = process.env.ANTHROPIC_API_KEY;
  process.env.ORKAS_WORKSPACE_ROOT = tmpDir;
  delete process.env.ANTHROPIC_API_KEY;
  vi.resetModules();
});

afterEach(() => {
  vi.doUnmock('@earendil-works/pi-ai/oauth');
  vi.doUnmock('#core-agent');
  vi.doUnmock('../../../src/main/features/group_chat/history-summary-cache');
  process.env.ORKAS_WORKSPACE_ROOT = prevWs;
  if (prevAnthropicKey === undefined) delete process.env.ANTHROPIC_API_KEY;
  else process.env.ANTHROPIC_API_KEY = prevAnthropicKey;
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

  it('builds one run-scoped Skill ref table and reuses it in read_file', async () => {
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
    const readFile = (built.runner as unknown as { tools: Map<string, any> }).tools.get('read_file');
    const entry = await readFile.execute(
      { path: '@skill/readable-skill' },
      { workingDir: tmpDir, state: new Map(), signal: undefined } as any,
    );
    const reference = await readFile.execute(
      { path: '@skill/readable-skill/references/guide.md' },
      { workingDir: tmpDir, state: new Map(), signal: undefined } as any,
    );
    expect(entry.isError).toBeFalsy();
    expect(entry.content).toContain('main body');
    expect(reference.isError).toBeFalsy();
    expect(reference.content).toContain('nested guide');
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
    const readFile = tools.get('read_file');
    const bash = tools.get('bash');
    const toolContext = {
      workingDir: path.join(tmpDir, 'execution-workspace'),
      state: {
        sandboxEnv: (await import('../../../src/main/model/core-agent/client')).buildSkillSandboxEnv(uid),
      },
      signal: undefined,
    } as any;
    fs.mkdirSync(toolContext.workingDir, { recursive: true });

    const entry = await readFile.execute({ path: '@skill/executable-skill' }, toolContext);
    const template = await readFile.execute(
      { path: '@skill/executable-skill/templates/report.md' },
      toolContext,
    );
    const script = await readFile.execute(
      { path: '@skill/executable-skill/scripts/render.js' },
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
      sessionId: 'gconv-ocr-image',
      userId: uid,
      agentId: OFFICE_WORKER_AGENT_ID,
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
      'office_check',
      'office_render',
      'edit_pdf',
      'pdf_render',
    ]));

    const pdfTurn = await buildRunner({
      sessionId: 'gconv-ocr-pdf',
      userId: uid,
      agentId: OFFICE_WORKER_AGENT_ID,
      userMessage: '读取这个文件',
      attachmentMetadata: { hasAttachments: true, attachmentTypes: ['pdf'] },
    });
    expect(pdfTurn.toolDefs.some((tool) => tool.name === 'ocr_file')).toBe(true);

    const explicitOcrTurn = await buildRunner({
      sessionId: 'gconv-ocr-explicit',
      userId: uid,
      agentId: OFFICE_WORKER_AGENT_ID,
      userMessage: '请从这张截图中提取表格文字',
      attachmentMetadata: { hasAttachments: true, attachmentTypes: ['image'] },
    });
    expect(explicitOcrTurn.toolDefs.some((tool) => tool.name === 'ocr_file')).toBe(true);

    const richSteerTurn = await buildRunner({
      sessionId: 'gconv-ocr-rich-steer',
      userId: uid,
      agentId: OFFICE_WORKER_AGENT_ID,
      userMessage: '先处理当前任务',
      attachmentMetadata: { hasAttachments: false, attachmentTypes: [] },
      richSteerEnabled: true,
    });
    expect(richSteerTurn.toolDefs.some((tool) => tool.name === 'ocr_file')).toBe(true);
  });
});

describe('runner › generic host capabilities for built-in Agents', () => {
  it('does not remove generic host tools from ContentWriter by Agent identity', async () => {
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
      sessionId: 'gconv-content-writer-host-tools',
      userId: uid,
      agentId: CONTENT_WRITER_AGENT_ID,
      userMessage: '写一篇有来源约束的文章',
    });
    const publicToolNames = built.toolDefs.map((tool) => tool.name);
    const runnerToolNames = [
      ...((built.runner as unknown as { tools: Map<string, unknown> }).tools.keys()),
    ];

    expect(publicToolNames).toEqual(expect.arrayContaining([
      'bash',
      'web_search',
      'web_fetch',
    ]));
    expect(runnerToolNames).toContain('manage_execution_plan');
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

    const createHistorySummaryCache = vi.fn(() => null);
    vi.doMock('../../../src/main/features/group_chat/history-summary-cache', () => ({
      createConversationHistorySummaryCache: createHistorySummaryCache,
    }));

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
        source: `group-main-v1:${summaryCid}`,
        messages: [
          { role: 'user', turnId: 1, content: [{ type: 'text', text: 'canonical request' }] },
          { role: 'assistant', turnId: 1, content: [{ type: 'text', text: 'canonical response' }] },
        ],
      },
      userMessage: 'continue',
    });

    const agentSearch = agent.toolDefs.find((tool) => tool.name === 'chat_search');
    const agentRead = agent.toolDefs.find((tool) => tool.name === 'chat_read');
    const nonProjectCommanderSearch = nonProjectCommander.toolDefs.find(
      (tool) => tool.name === 'chat_search',
    );
    const nonProjectCommanderRead = nonProjectCommander.toolDefs.find(
      (tool) => tool.name === 'chat_read',
    );
    const projectCommanderSearch = projectCommander.toolDefs.find(
      (tool) => tool.name === 'chat_search',
    );
    expect(agentSearch).toBeTruthy();
    expect(agentRead).toBeTruthy();
    expect((agentSearch?.inputSchema as any).properties.scope.enum).toEqual(['current']);
    expect((agentRead?.inputSchema as any).properties.scope.enum).toEqual(['current']);
    expect((agentRead?.inputSchema as any).properties.page).toMatchObject({
      type: 'object',
      additionalProperties: false,
      properties: {
        mode: { type: 'string', enum: ['latest', 'around', 'before'] },
        index: { type: 'integer', minimum: 0 },
        count: { type: 'integer', minimum: 0 },
      },
      required: ['mode'],
    });
    expect((agentSearch?.inputSchema as any).properties.include_current).toBeUndefined();
    expect((nonProjectCommanderSearch?.inputSchema as any).properties.scope.enum)
      .toEqual(['current', 'all']);
    expect((nonProjectCommanderRead?.inputSchema as any).properties.scope.enum)
      .toEqual(['current', 'all']);
    expect(nonProjectCommanderSearch?.description)
      .not.toContain('Project scope');
    expect((projectCommanderSearch?.inputSchema as any).properties.scope.enum)
      .toEqual(['current', 'project', 'all']);
    expect((projectCommander.runner as unknown as { requirePlanForRepeatedMutations: boolean })
      .requirePlanForRepeatedMutations).toBe(true);
    expect((agent.runner as unknown as { requirePlanForRepeatedMutations: boolean })
      .requirePlanForRepeatedMutations).toBe(false);
    expect(createHistorySummaryCache).toHaveBeenCalledOnce();
    expect(createHistorySummaryCache).toHaveBeenCalledWith({
      uid,
      cid: summaryCid,
      source: `group-main-v1:${summaryCid}`,
    });
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
    const chatReadDefinition = built.toolDefs.find((tool) => tool.name === 'chat_read');
    const chatRead = (built.runner as unknown as { tools: Map<string, any> }).tools.get('chat_read');
    expect(chatReadDefinition).toBeTruthy();
    expect(chatRead).toBeTruthy();
    expect((chatReadDefinition?.inputSchema as any).properties.scope.enum)
      .toEqual(['current', 'all']);

    const invalidProject = await chatRead.execute({ scope: 'project' }, { state: {} } as any);
    expect(invalidProject.isError).toBe(true);
    expect(invalidProject.content).toContain('scope "project" is not allowed');

    const pages: string[] = [];
    let beforeMsgIndex: number | undefined;
    for (let page = 0; page < 4; page += 1) {
      const result = await chatRead.execute({
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
      '## Orchestration state',
      '',
      'Ledger explanation (static).',
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
