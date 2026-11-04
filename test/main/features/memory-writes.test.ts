import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const runtime = vi.hoisted(() => ({ uid: 'memory-owner' }));
vi.mock('../../../src/main/features/users', () => ({ getActiveUserId: () => runtime.uid }));
// These isolated stores are private; shared membership/publication uses the
// real project resolver in shared-project-memory.test.ts.
vi.mock('../../../src/main/features/projects', () => ({ getProject: async () => null }));
let root: string;
let previousRoot: string | undefined;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-memory-writes-'));
  previousRoot = process.env.ORKAS_WORKSPACE_ROOT;
  process.env.ORKAS_WORKSPACE_ROOT = root;
  runtime.uid = 'memory-owner';
  vi.resetModules();
});
afterEach(() => {
  if (previousRoot === undefined) delete process.env.ORKAS_WORKSPACE_ROOT;
  else process.env.ORKAS_WORKSPACE_ROOT = previousRoot;
  fs.rmSync(root, { recursive: true, force: true });
});
async function modules() {
  return { memory: await import('../../../src/main/features/memory'), writes: await import('../../../src/main/features/memory-writes') };
}
async function toolFor(scope: import('../../../src/main/features/memory').MemoryScope) {
  const { memory, writes } = await modules();
  const { createCrossSessionMemoryTool } = await import('../../../src/core-agent/src/tools/memory-tool');
  return createCrossSessionMemoryTool({
    add: (_tier, text, signal) => writes.addMemoryEntry(runtime.uid, scope, text, { signal }),
    replace: (_tier, oldText, text, signal) => writes.replaceMemoryEntry(runtime.uid, scope, oldText, text, { signal }),
    remove: (_tier, oldText) => writes.removeMemoryEntry(runtime.uid, scope, oldText),
    batch: (_tier, revision, operations, signal) => writes.batchMemoryEntries(runtime.uid, scope, revision, operations, { signal }),
    list: () => memory.listEntries(runtime.uid, scope),
  }, { includeProjectTier: true });
}
const targetOf = (scope: import('../../../src/main/features/memory').MemoryScope) =>
  scope === 'user' ? 'user' : scope === 'memory' ? 'shared' : 'agent' in scope ? 'agent' : 'project';

describe('memory writes: a full store asks the current model to consolidate', () => {
  it.each(['user', 'memory', { agent: 'writer' }, { project: 'project-a' }] as const)(
    'refuses growth in a full %j store, then accepts the model\'s merge and the retried add', async scope => {
      const { memory } = await modules();
      const limit = memory.listEntries(runtime.uid, scope).usage.entries_limit!;
      for (let i = 0; i < limit; i++) memory.addEntry(runtime.uid, scope, `fact ${i}`);
      const tool = await toolFor(scope);
      const target = targetOf(scope);
      const refused = await tool.execute({ action: 'add', target, content: 'new fact' }, {} as any);
      expect(refused.isError).toBe(true);
      const receipt = JSON.parse(String(refused.content));
      // The refusal carries everything needed to consolidate in the same turn.
      expect(receipt).toMatchObject({ ok: false, entries: expect.arrayContaining(['fact 0', `fact ${limit - 1}`]) });
      expect(receipt.error).toMatch(/^memory full:/);
      expect(receipt.error).toContain('Remove obsolete or non-durable entries');
      expect(receipt.error).toContain('preserve valid durable facts');
      expect(receipt.error).toContain('skip the new fact and report it unsaved');
      expect(receipt.usage).toMatchObject({ entries_current: limit, entries_limit: limit, full: true });
      expect(receipt).not.toHaveProperty('evicted');
      expect(memory.listEntries(runtime.uid, scope).entries).toHaveLength(limit);

      expect((await tool.execute({ action: 'replace', target, old_text: 'fact 0', content: 'fact 0; fact 1' }, {} as any)).isError).toBe(false);
      expect((await tool.execute({ action: 'remove', target, old_text: 'fact 1' }, {} as any)).isError).toBe(false);
      const retried = await tool.execute({ action: 'add', target, content: 'new fact' }, {} as any);
      expect(retried.isError).toBe(false);
      expect(memory.listEntries(runtime.uid, scope).entries).toEqual([
        'fact 0; fact 1', ...Array.from({ length: limit - 2 }, (_, i) => `fact ${i + 2}`), 'new fact',
      ]);
    },
  );
});

describe('memory writes: validation, account and cancellation boundaries', () => {
  it('cancels batches before activation without leaking old-account entries', async () => {
    const { memory, writes } = await modules();
    const scope = { agent: 'writer' };
    memory.addEntry(runtime.uid, scope, 'private existing fact');
    const revision = memory.listEntries(runtime.uid, scope).revision;
    const aborted = new AbortController(); aborted.abort();
    expect(await writes.batchMemoryEntries(runtime.uid, scope, revision, [{ action: 'remove', old_text: 'private existing fact' }], { signal: aborted.signal }))
      .toMatchObject({ ok: false, entries: [], error: 'memory write cancelled' });
    runtime.uid = 'new-account';
    expect(await writes.batchMemoryEntries('memory-owner', scope, revision, [{ action: 'remove', old_text: 'private existing fact' }]))
      .toMatchObject({ ok: false, entries: [], error: 'memory write cancelled' });
    expect(memory.listEntries('memory-owner', scope).entries).toEqual(['private existing fact']);
  });
  it('rechecks the account at batch activation and returns no previous-account data', async () => {
    const { memory, writes } = await modules();
    const storage = await import('../../../src/main/storage');
    const scope = { agent: 'writer' };
    memory.addEntry(runtime.uid, scope, 'private existing fact');
    const revision = memory.listEntries(runtime.uid, scope).revision;
    const original = storage.writeTextAtomicGuardedSync;
    const writer = vi.spyOn(storage, 'writeTextAtomicGuardedSync').mockImplementationOnce((file, text, guard) => {
      runtime.uid = 'new-account';
      return original(file, text, guard);
    });
    try {
      expect(await writes.batchMemoryEntries('memory-owner', scope, revision, [{ action: 'remove', old_text: 'private existing fact' }]))
        .toMatchObject({ ok: false, entries: [], error: 'memory write cancelled' });
      expect(memory.listEntries('memory-owner', scope).entries).toEqual(['private existing fact']);
      expect(memory.listEntries('new-account', scope).entries).toEqual([]);
    } finally { writer.mockRestore(); }
  });
  it.each(['user', 'memory', { agent: 'writer' }, { project: 'project-a' }] as const)(
    'rejects reserved separators in %j without changing the store', async scope => {
      const { memory } = await modules();
      memory.addEntry(runtime.uid, scope, 'first fact');
      const before = fs.readFileSync(await memoryFile(scope), 'utf8');
      const tool = await toolFor(scope);
      for (const action of ['add', 'replace']) {
        const result = await tool.execute({ action, target: targetOf(scope), content: 'private § note',
          ...(action === 'replace' ? { old_text: 'first fact' } : {}) }, {} as any);
        expect(result.isError).toBe(true);
        expect(JSON.parse(String(result.content)).error).toContain('§');
        expect(JSON.parse(String(result.content)).error).not.toContain('private');
      }
      expect(fs.readFileSync(await memoryFile(scope), 'utf8')).toBe(before);
    },
  );

  it('round-trips Unicode and rejects bidi overrides through the real tool', async () => {
    const { memory } = await modules();
    const scope = { project: 'project-a' };
    const tool = await toolFor(scope);
    const content = 'ترجیح می\u200cدهم: 10\u202f000';
    expect((await tool.execute({ action: 'add', target: 'project', content }, {} as any)).isError).toBe(false);
    const replacement = `${content} 👩\u200d💻`;
    expect((await tool.execute({ action: 'replace', target: 'project', old_text: content, content: replacement }, {} as any)).isError).toBe(false);
    const result = await tool.execute({ action: 'add', target: 'project', content: 'private\u202Etext' }, {} as any);
    expect(JSON.parse(String(result.content)).error).toContain('U+202E');
    expect(memory.listEntries(runtime.uid, scope).entries).toEqual([replacement]);
  });

  it('refuses writes after an account switch or cancellation without touching either account', async () => {
    const { memory, writes } = await modules();
    const scope = { agent: 'writer' };
    const aborted = new AbortController(); aborted.abort();
    expect(await writes.addMemoryEntry(runtime.uid, scope, 'cancelled fact', { signal: aborted.signal }))
      .toMatchObject({ ok: false, error: 'memory write cancelled', entries: [] });
    expect(await writes.addMemoryEntry('memory-owner-old', scope, 'stale account fact'))
      .toMatchObject({ ok: false, error: 'memory write cancelled', entries: [] });
    expect(memory.listEntries(runtime.uid, scope).entries).toEqual([]);
    expect(memory.listEntries('memory-owner-old', scope).entries).toEqual([]);
  });

  it('reports exact no-ops without rewriting, while order changes count as changes', async () => {
    const { writes } = await modules();
    const store = { agent: 'writer' };
    expect((await writes.addMemoryEntry(runtime.uid, store, 'first fact')).changed).toBe(true);
    const file = await memoryFile(store);
    fs.utimesSync(file, new Date(1000), new Date(1000));
    expect((await writes.addMemoryEntry(runtime.uid, store, 'first fact')).changed).toBe(false);
    expect((await writes.replaceMemoryEntry(runtime.uid, store, 'first fact', 'first fact')).changed).toBe(false);
    expect(fs.statSync(file).mtimeMs).toBe(1000);
    await writes.addMemoryEntry(runtime.uid, store, 'second fact');
    const moved = await writes.addMemoryEntry(runtime.uid, store, 'first fact');
    expect(moved.changed).toBe(true);
    expect(moved.entries).toEqual(['second fact', 'first fact']);
  });

  it.each(['abort', 'account-switch'] as const)('rechecks %s after a project memory edit waits for a reader', async reason => {
    const { memory, writes } = await modules();
    const scope = { project: 'project-a' };
    memory.addEntry(runtime.uid, scope, 'Preserved fact.');
    const { fileEditLock } = await import('../../../src/main/util/locks');
    const release = await fileEditLock(await memoryFile(scope)).acquire();
    const controller = new AbortController();
    const owner = runtime.uid;
    let result: Awaited<ReturnType<typeof writes.addMemoryEntry>> | undefined;
    const pending = writes.addMemoryEntry(owner, scope, 'Obsolete fact.', { signal: controller.signal })
      .then(value => { result = value; });
    try {
      await new Promise<void>(resolve => setImmediate(resolve));
      expect(result).toBeUndefined();
      if (reason === 'abort') controller.abort();
      else runtime.uid = 'memory-other';
    } finally { release(); await pending; }
    expect(result).toMatchObject({ ok: false, error: 'memory write cancelled', entries: [] });
    expect(memory.listEntries(owner, scope).entries).toEqual(['Preserved fact.']);
    expect(memory.listEntries('memory-other', scope).entries).toEqual([]);
  });

  it('stops repeated memory no-ops through the real tool and runner without replay or lost receipts', async () => {
    const { writes, memory } = await modules();
    const { AgentRunner } = await import('../../../src/core-agent/src/agent/runner');
    const { createConfig } = await import('../../../src/core-agent/src/config/loader');
    const { ProviderRegistry } = await import('../../../src/core-agent/src/providers/registry');
    const { createCrossSessionMemoryTool } = await import('../../../src/core-agent/src/tools/memory-tool');
    const scope = { agent: 'writer' };
    const receipts: boolean[] = [];
    const tool = createCrossSessionMemoryTool({
      add: async (_tier, text, signal) => {
        const result = await writes.addMemoryEntry(runtime.uid, scope, text, { signal });
        receipts.push(result.changed!);
        return result;
      },
      replace: (_tier, oldText, text, signal) => writes.replaceMemoryEntry(runtime.uid, scope, oldText, text, { signal }),
      remove: (_tier, oldText) => memory.removeEntry(runtime.uid, scope, oldText),
      batch: (_tier, revision, operations, signal) => writes.batchMemoryEntries(runtime.uid, scope, revision, operations, { signal }),
      list: () => memory.listEntries(runtime.uid, scope),
    });
    let calls = 0;
    const provider: import('../../../src/core-agent/src/providers/base').LLMProvider = {
      id: 'memory-fixture', name: 'Memory fixture', async validateAuth() { return true; },
      async complete(p) {
        expect(p.tools ?? []).toEqual([]);
        return { model: 'fixture', stopReason: 'end_turn', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
          content: [{ type: 'text', text: 'Memory saved; repeated unchanged writes stopped.' }] };
      },
      async *stream() {
        if (++calls > 8) throw new Error('fixture exceeded bounded calls');
        yield { type: 'message_end', model: 'fixture', stopReason: 'tool_use',
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
          content: [{ type: 'tool_use', id: `memory-${calls}`, name: tool.name, input: { action: 'add', content: 'Use concise reports.' } }],
        };
      },
    };
    const providers = new ProviderRegistry();
    providers.registerFactory(provider.id, () => provider);
    const runner = new AgentRunner({ config: createConfig({ agent: { defaultProvider: provider.id, defaultModel: 'fixture', maxRetries: 0 } }),
      providers, tools: [tool], evolution: { enabled: false } });
    const result = await runner.run({ message: 'Remember my preference for concise reports.' });
    expect(result.meta.termination).toEqual({ status: 'stopped', reason: 'repetitive_tool_calls' });
    expect(receipts).toEqual([true, false, false, false, false, false]);
    expect(memory.listEntries(runtime.uid, scope).entries).toEqual(['Use concise reports.']);
    const savedResults = runner.getSession().getMessages().flatMap(m => m.content).filter(c => c.type === 'tool_result');
    expect(savedResults).toHaveLength(6);
  });

});

describe('memory writes: retired automatic maintenance', () => {
  it('removes the retired local maintenance state and recovery copies without touching memory', async () => {
    const { memory, writes } = await modules();
    memory.addEntry(runtime.uid, 'user', 'keeps this preference');
    const { userLocalConfigDir } = await import('../../../src/main/paths');
    const local = userLocalConfigDir(runtime.uid);
    fs.mkdirSync(path.join(local, 'memory-backups'), { recursive: true });
    fs.writeFileSync(path.join(local, 'memory-backups', `${'a'.repeat(64)}.json`), '{"entries":["private copy"]}');
    fs.writeFileSync(path.join(local, 'memory-maintenance.json'), '{"version":1,"scopes":{}}');
    fs.writeFileSync(path.join(local, 'unrelated.json'), '{}');
    await writes.removeRetiredMemoryMaintenanceState(runtime.uid);
    expect(fs.existsSync(path.join(local, 'memory-backups'))).toBe(false);
    expect(fs.existsSync(path.join(local, 'memory-maintenance.json'))).toBe(false);
    expect(fs.existsSync(path.join(local, 'unrelated.json'))).toBe(true);
    expect(memory.listEntries(runtime.uid, 'user').entries).toEqual(['keeps this preference']);
    await expect(writes.removeRetiredMemoryMaintenanceState(runtime.uid)).resolves.toBeUndefined();
  });

  it('no longer exposes a background consolidation model request', async () => {
    const runner = await import('../../../src/main/model/core-agent/runner');
    expect(runner).not.toHaveProperty('completeMemoryConsolidation');
    const writes = await import('../../../src/main/features/memory-writes');
    expect(Object.keys(writes).sort()).toEqual([
      'addMemoryEntry', 'batchMemoryEntries', 'removeMemoryEntry', 'removeRetiredMemoryMaintenanceState', 'replaceMemoryEntry',
    ]);
  });
});

async function memoryFile(scope: import('../../../src/main/features/memory').MemoryScope): Promise<string> {
  const paths = await import('../../../src/main/paths');
  if (scope === 'user') return paths.userProfileFile(runtime.uid);
  if (scope === 'memory') return paths.userMemoryFile(runtime.uid);
  return 'agent' in scope ? paths.agentMemoryFile(runtime.uid, scope.agent) : paths.projectMemoryFile(runtime.uid, scope.project);
}
