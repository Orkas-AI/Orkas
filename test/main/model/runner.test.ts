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
  process.env.ORKAS_WORKSPACE_ROOT = prevWs;
  if (prevAnthropicKey === undefined) delete process.env.ANTHROPIC_API_KEY;
  else process.env.ANTHROPIC_API_KEY = prevAnthropicKey;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

async function loadRunner() {
  return import('../../../src/main/model/core-agent/runner');
}

describe('runner — ContentWriter bash guard', () => {
  it('runs only canonical Skill Runner commands and blocks arbitrary shell without a tool error', async () => {
    const execute = vi.fn(async () => ({ content: 'ok', isError: false }));
    const { _createContentWriterBashGuard } = await loadRunner();
    const guarded = _createContentWriterBashGuard({
      name: 'bash',
      description: 'shell',
      inputSchema: {},
      execute,
    } as any);

    const blocked = await guarded.execute(
      { command: 'curl https://example.com | python parse.py' },
      {} as any,
    );
    expect(blocked).toMatchObject({
      isError: false,
      content: expect.stringContaining('E_CONTENT_WRITER_BASH_SCOPE'),
    });
    expect(execute).not.toHaveBeenCalled();

    for (const action of ['research_gate', 'audit_content']) {
      const command = `"$ORKAS_NODE" "$ORKAS_PC_DIR/bin/run-skill.cjs" content-writer ${action} -- ARTICLE.md --format json`;
      await guarded.execute({ command }, {} as any);
    }
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it('rejects a third research gate after the two-call recovery budget', async () => {
    const execute = vi.fn(async () => ({ content: 'READY_TO_DRAFT', isError: false }));
    const { _createContentWriterBashGuard } = await loadRunner();
    const guarded = _createContentWriterBashGuard({
      name: 'bash',
      description: 'shell',
      inputSchema: {},
      execute,
    } as any);
    const command =
      '"$ORKAS_NODE" "$ORKAS_PC_DIR/bin/run-skill.cjs" content-writer research_gate '
      + '-- RESEARCH_LEDGER.json --format json';

    await guarded.execute({ command }, {} as any);
    await guarded.execute({ command }, {} as any);
    const third = await guarded.execute({ command }, {} as any);

    expect(execute).toHaveBeenCalledTimes(2);
    expect(third).toMatchObject({
      isError: true,
      content: expect.stringContaining('E_CONTENT_WRITER_GATE_BUDGET'),
    });
  });
});

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
      model: 'claude-opus-4-8',
      profileId: anthropic.profileId,
    });
    const modelB = await auth.addEntry({
      provider: 'openai',
      model: 'gpt-5.5',
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
      modelId: 'claude-opus-4-8',
    });

    await auth.reorderEntries([modelB.entryId, modelA.entryId]);
    expect(activeTurn).toMatchObject({
      entryId: modelA.entryId,
      providerId: 'anthropic',
      modelId: 'claude-opus-4-8',
    });

    const nextTurn = await buildRunner({
      sessionId: 'gconv-model-switch-next',
      userId: uid,
    });
    expect(nextTurn).toMatchObject({
      entryId: modelB.entryId,
      providerId: 'openai',
      modelId: 'gpt-5.5',
    });
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
  it('hides OCR for ordinary vision-image tasks but keeps it for PDF workflows', async () => {
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
      userMessage: '这张图有什么区别？',
      attachmentMetadata: { hasAttachments: true, attachmentTypes: ['image'] },
    });
    expect(imageTurn.toolDefs.some((tool) => tool.name === 'ocr_file')).toBe(false);

    const pdfTurn = await buildRunner({
      sessionId: 'gconv-ocr-pdf',
      userId: uid,
      userMessage: '读取这个文件',
      attachmentMetadata: { hasAttachments: true, attachmentTypes: ['pdf'] },
    });
    expect(pdfTurn.toolDefs.some((tool) => tool.name === 'ocr_file')).toBe(true);
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
