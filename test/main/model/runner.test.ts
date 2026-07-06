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
