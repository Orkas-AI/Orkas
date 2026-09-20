import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const runtime = vi.hoisted(() => ({ uid: 'memory-owner', idle: true }));
vi.mock('../../../src/main/features/users', () => ({ getActiveUserId: () => runtime.uid }));
vi.mock('../../../src/main/util/boot_init', async (original) => ({
  ...await original<typeof import('../../../src/main/util/boot_init')>(),
  isBootAdmissionIdle: () => runtime.idle,
}));
// A maintenance run has no business creating/running ordinary automations.
vi.mock('../../../src/main/features/auto_tasks', () => { throw new Error('maintenance reached automations'); });
vi.mock('../../../src/main/features/group_chat', () => { throw new Error('maintenance reached chat dispatch'); });
let root: string;
let previousRoot: string | undefined;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-maintenance-'));
  previousRoot = process.env.ORKAS_WORKSPACE_ROOT;
  process.env.ORKAS_WORKSPACE_ROOT = root;
  runtime.uid = 'memory-owner'; runtime.idle = true;
  vi.resetModules();
});
afterEach(() => {
  vi.useRealTimers();
  if (previousRoot === undefined) delete process.env.ORKAS_WORKSPACE_ROOT;
  else process.env.ORKAS_WORKSPACE_ROOT = previousRoot;
  fs.rmSync(root, { recursive: true, force: true });
});
async function modules() {
  return { memory: await import('../../../src/main/features/memory'), maintenance: await import('../../../src/main/features/memory-maintenance') };
}
function unchanged(entries: readonly string[]) {
  return { groups: entries.map((text, index) => ({ sources: [index], text })) };
}
function mergeFirst(entries: readonly string[]) {
  return { groups: [
    { sources: [0, 1], text: 'Reports: English; PDF only on Fridays.' },
    ...entries.slice(2).map((text, index) => ({ sources: [index + 2], text })),
  ] };
}
function seed(memory: Awaited<ReturnType<typeof modules>>['memory'], scope: import('../../../src/main/features/memory').MemoryScope = { agent: 'writer' }) {
  const entries = ['Write every report in English.', 'Provide reports as PDF only on Fridays.', ...Array.from({ length: 14 }, (_, i) => `independent fact ${i}`)];
  for (const text of entries) memory.addEntry(runtime.uid, scope, text);
  return entries;
}

describe('memory maintenance: durable writes', () => {
  it('stops repeated memory no-ops through the real tool and runner without replay or lost receipts', async () => {
    const { maintenance, memory } = await modules();
    const { AgentRunner } = await import('../../../src/core-agent/src/agent/runner');
    const { createConfig } = await import('../../../src/core-agent/src/config/loader');
    const { ProviderRegistry } = await import('../../../src/core-agent/src/providers/registry');
    const { createCrossSessionMemoryTool } = await import('../../../src/core-agent/src/tools/memory-tool');
    const scope = { agent: 'writer' };
    const receipts: boolean[] = [];
    const tool = createCrossSessionMemoryTool({
      add: async (_tier, text, signal) => {
        const result = await maintenance.addEntryWithMaintenance(runtime.uid, scope, text, { signal });
        receipts.push(result.changed!);
        return result;
      },
      replace: (_tier, oldText, text, signal) => maintenance.replaceEntryWithMaintenance(runtime.uid, scope, oldText, text, { signal }),
      remove: (_tier, oldText) => memory.removeEntry(runtime.uid, scope, oldText),
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

  it('reports exact no-ops without rewriting, while preserving order changes and stale-write rejection', async () => {
    const { memory, maintenance } = await modules();
    const consolidate = vi.fn();
    const store = { agent: 'writer' };
    expect((await maintenance.addEntryWithMaintenance(runtime.uid, store, 'first fact', { consolidate })).changed).toBe(true);
    const { agentMemoryFile } = await import('../../../src/main/paths');
    const file = agentMemoryFile(runtime.uid, store.agent);
    // A sentinel timestamp independently detects a rewrite of identical bytes.
    fs.utimesSync(file, new Date(1000), new Date(1000));
    const before = memory.snapshotMemory(runtime.uid, store);
    expect((await maintenance.addEntryWithMaintenance(runtime.uid, store, 'first fact', { consolidate })).changed).toBe(false);
    expect((await maintenance.replaceEntryWithMaintenance(runtime.uid, store, 'first fact', 'first fact', { consolidate })).changed).toBe(false);
    expect(fs.statSync(file).mtimeMs).toBe(1000);
    await maintenance.addEntryWithMaintenance(runtime.uid, store, 'second fact', { consolidate });
    expect(memory.saveMemorySnapshot(runtime.uid, store, before, before.entries)).toBeNull();
    const moved = await maintenance.addEntryWithMaintenance(runtime.uid, store, 'first fact', { consolidate });
    expect(moved.changed).toBe(true);
    expect(moved.entries).toEqual(['second fact', 'first fact']);
    expect(consolidate).not.toHaveBeenCalled();
  });

  it('merges before the seventeenth Agent entry would evict a preference; stores a recovery snapshot', async () => {
    const { memory, maintenance } = await modules();
    const prior = seed(memory);
    const consolidate = vi.fn(async (_uid, entries) => mergeFirst(entries));
    const result = await maintenance.addEntryWithMaintenance(runtime.uid, { agent: 'writer' }, 'new durable fact', { consolidate });
    expect(result.ok).toBe(true);
    expect(result.evicted).toBeUndefined();
    expect(result.entries).toEqual(['Reports: English; PDF only on Fridays.', ...prior.slice(2), 'new durable fact']);
    expect(result.usage).toMatchObject({ limit: 2000, entries_limit: 16, entries_current: 16 });
    const { userLocalConfigDir } = await import('../../../src/main/paths');
    const backups = fs.readdirSync(path.join(userLocalConfigDir(runtime.uid), 'memory-backups'));
    const backup = JSON.parse(fs.readFileSync(path.join(userLocalConfigDir(runtime.uid), 'memory-backups', backups[0]), 'utf8'));
    expect(backup.entries).toEqual([...prior, 'new durable fact']);
    memory.clearMemory(runtime.uid, { agent: 'writer' });
    expect(fs.readdirSync(path.join(userLocalConfigDir(runtime.uid), 'memory-backups'))).toEqual([]);
  });

  it('keeps ordinary writes fast and does not invoke a model below either cap', async () => {
    const { maintenance } = await modules();
    const consolidate = vi.fn();
    const result = await maintenance.addEntryWithMaintenance(runtime.uid, 'user', 'Likes concise answers.', { consolidate });
    expect(result.entries).toEqual(['Likes concise answers.']);
    expect(consolidate).not.toHaveBeenCalled();
  });

  it('still evicts the oldest entry when no safe merge exists', async () => {
    const { memory, maintenance } = await modules();
    const prior = seed(memory);
    const result = await maintenance.addEntryWithMaintenance(runtime.uid, { agent: 'writer' }, 'new fact', {
      consolidate: async (_uid, entries) => unchanged(entries),
    });
    expect(result.entries).toEqual([...prior.slice(1), 'new fact']);
    expect(result.evicted).toEqual({ dropped_entries: 1 });
  });

  it('falls back on invalid output without accepting omitted facts or invented singleton rewrites', async () => {
    const { memory, maintenance } = await modules();
    const prior = seed(memory);
    const result = await maintenance.addEntryWithMaintenance(runtime.uid, { agent: 'writer' }, 'new fact', {
      consolidate: async () => ({ groups: [{ sources: [0], text: 'invented preference' }] }),
    });
    expect(result.entries).toEqual([...prior.slice(1), 'new fact']);
    expect(result.evicted).toEqual({ dropped_entries: 1 });
  });

  it('does not overwrite a concurrent edit or restore records after clear', async () => {
    const { memory, maintenance } = await modules();
    seed(memory);
    let finish!: (value: unknown) => void;
    let input: readonly string[] = [];
    const write = maintenance.addEntryWithMaintenance(runtime.uid, { agent: 'writer' }, 'new fact', {
      consolidate: async (_uid, entries) => { input = entries; return new Promise(resolve => { finish = resolve; }); },
    });
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
    memory.clearMemory(runtime.uid, { agent: 'writer' });
    memory.addEntry(runtime.uid, { agent: 'writer' }, 'user replacement');
    finish(mergeFirst(input));
    expect(await write).toMatchObject({ ok: false, entries: ['user replacement'] });
    expect(memory.listAgentEntries(runtime.uid, 'writer').entries).toEqual(['user replacement']);
  });

  it('cancels an in-flight write on account switch and ignores its late response', async () => {
    const { memory, maintenance } = await modules();
    seed(memory);
    let finish!: (value: unknown) => void;
    let input: readonly string[] = [];
    let signal: AbortSignal | undefined;
    const write = maintenance.addEntryWithMaintenance(runtime.uid, { agent: 'writer' }, 'new fact', {
      consolidate: async (_uid, entries, s) => { input = entries; signal = s; return new Promise(resolve => { finish = resolve; }); },
    });
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
    const { notifyUserSwitch } = await import('../../../src/main/features/user-switch-hooks');
    notifyUserSwitch(runtime.uid, 'other-owner'); runtime.uid = 'other-owner';
    expect(signal?.aborted).toBe(true);
    expect(await write).toMatchObject({ ok: false, entries: [] });
    finish(mergeFirst(input));
    await Promise.resolve();
    expect(memory.listAgentEntries('memory-owner', 'writer').entries).not.toContain('new fact');
    expect(memory.listAgentEntries('other-owner', 'writer').entries).toEqual([]);
  });

  it('bounds a stalled model and ignores completion after fallback eviction', async () => {
    const { memory, maintenance } = await modules();
    seed(memory);
    vi.useFakeTimers();
    let finish!: (value: unknown) => void;
    let input: readonly string[] = [];
    const write = maintenance.addEntryWithMaintenance(runtime.uid, { agent: 'writer' }, 'new fact', {
      consolidate: async (_uid, entries) => { input = entries; return new Promise(resolve => { finish = resolve; }); },
    });
    await vi.advanceTimersByTimeAsync(maintenance.CONSOLIDATION_TIMEOUT_MS);
    const result = await write;
    expect(result.evicted).toEqual({ dropped_entries: 1 });
    finish(mergeFirst(input));
    await Promise.resolve();
    expect(memory.listAgentEntries(runtime.uid, 'writer').entries).toEqual(result.entries);
  });

  it('consolidates replacements that exceed the character cap without touching another scope', async () => {
    const { memory, maintenance } = await modules();
    memory.addEntry(runtime.uid, 'user', 'Write every report in English.');
    memory.addEntry(runtime.uid, 'user', 'Provide reports as PDF only on Fridays.');
    memory.addEntry(runtime.uid, 'user', 'old note');
    memory.addEntry(runtime.uid, { agent: 'writer' }, 'private agent fact');
    const newText = 'x'.repeat(1435);
    const result = await maintenance.replaceEntryWithMaintenance(runtime.uid, 'user', 'old note', newText, {
      consolidate: async (_uid, entries) => mergeFirst(entries),
    });
    expect(result.evicted).toBeUndefined();
    expect(result.entries).toEqual(['Reports: English; PDF only on Fridays.', newText]);
    expect(memory.listAgentEntries(runtime.uid, 'writer').entries).toEqual(['private agent fact']);
  });
});

describe('memory maintenance: daily work', () => {
  it('processes dirty scopes independently, survives restart, and skips unchanged memory on later days', async () => {
    let { memory, maintenance } = await modules();
    seed(memory, 'user'); seed(memory, { agent: 'writer' }); seed(memory, { project: 'p_alpha' });
    const consolidate = vi.fn(async (_uid, entries) => mergeFirst(entries));
    const now = Date.now();
    await maintenance.runMemoryMaintenanceCycle(runtime.uid, { consolidate, now: () => now });
    expect(consolidate).toHaveBeenCalledTimes(3);
    expect(memory.listEntries(runtime.uid, 'user').entries[0]).toBe('Reports: English; PDF only on Fridays.');
    vi.resetModules();
    ({ memory, maintenance } = await modules());
    await maintenance.runMemoryMaintenanceCycle(runtime.uid, { consolidate, now: () => now + 2 * maintenance.DAILY_INTERVAL_MS });
    expect(consolidate).toHaveBeenCalledTimes(3);
    memory.addEntry(runtime.uid, { agent: 'writer' }, 'another fact');
    await maintenance.runMemoryMaintenanceCycle(runtime.uid, {
      consolidate: async (_uid, entries) => { consolidate(_uid, entries); return unchanged(entries); },
      now: () => now + 2 * maintenance.DAILY_INTERVAL_MS,
    });
    expect(consolidate).toHaveBeenCalledTimes(4);
  });

  it('yields while the user is busy and never calls another account\'s model', async () => {
    const { memory, maintenance } = await modules();
    seed(memory);
    const consolidate = vi.fn(async (_uid, entries) => mergeFirst(entries));
    runtime.idle = false;
    await maintenance.runMemoryMaintenanceCycle(runtime.uid, { consolidate });
    runtime.idle = true;
    await maintenance.runMemoryMaintenanceCycle('other-owner', { consolidate });
    expect(consolidate).not.toHaveBeenCalled();
  });

  it('leaves daily source data intact on model failure and backs off rather than looping', async () => {
    const { memory, maintenance } = await modules();
    const prior = seed(memory);
    const consolidate = vi.fn(async () => { throw new Error('fixture unavailable'); });
    const now = Date.now();
    await maintenance.runMemoryMaintenanceCycle(runtime.uid, { consolidate, now: () => now });
    await maintenance.runMemoryMaintenanceCycle(runtime.uid, { consolidate, now: () => now + 1000 });
    expect(consolidate).toHaveBeenCalledTimes(1);
    expect(memory.listAgentEntries(runtime.uid, 'writer').entries).toEqual(prior);
  });

  it('caps each cycle and eventually visits deferred scopes', async () => {
    const { memory, maintenance } = await modules();
    for (let i = 0; i < 7; i++) seed(memory, { agent: `writer${i}` });
    const consolidate = vi.fn(async (_uid, entries) => mergeFirst(entries));
    const now = Date.now();
    await maintenance.runMemoryMaintenanceCycle(runtime.uid, { consolidate, now: () => now });
    expect(consolidate).toHaveBeenCalledTimes(5);
    await maintenance.runMemoryMaintenanceCycle(runtime.uid, { consolidate, now: () => now + 3600_001 });
    expect(consolidate).toHaveBeenCalledTimes(7);
  });
});

describe('memory consolidation protocol', () => {
  it('preserves source coverage and age, including conflicts left as singleton entries', async () => {
    const { maintenance } = await modules();
    const source = ['Use English.', 'Use Chinese for legal reports.', 'English for routine reports.'];
    const value = { groups: [
      { sources: [1], text: source[1] },
      { sources: [0, 2], text: 'Use English for routine reports.' },
    ] };
    expect(maintenance.validateConsolidation(value, source)).toEqual([
      'Use English for routine reports.', 'Use Chinese for legal reports.',
    ]);
    for (const bad of [
      { groups: [{ sources: [0, 0, 1, 2], text: 'duplicate index' }] },
      { groups: [{ sources: [0, 1], text: 'missing source' }] },
      { groups: [{ sources: [0, 1, 9], text: 'foreign source' }] },
      { groups: [{ sources: [0, 1, 2], text: 'injected § entry' }] },
      { groups: [{ sources: [0], text: 'Use French.' }, { sources: [1, 2], text: 'other' }] },
    ]) expect(maintenance.validateConsolidation(bad, source)).toBeNull();
  });
});


describe('memory maintenance loop lifecycle', () => {
  it('follows rapid account switches, and stopping its original handle stops the replacement cycle', async () => {
    const boot = await import('../../../src/main/util/boot_init');
    const scheduled: { name: string; cancelled: boolean; options: any }[] = [];
    const spy = vi.spyOn(boot, 'scheduleBootBackground').mockImplementation((name, _fn, _delay, options) => {
      const row = { name, cancelled: false, options }; scheduled.push(row);
      let finish!: () => void;
      const promise = new Promise<void>(resolve => { finish = resolve; });
      return { promise, cancel() { row.cancelled = true; finish(); } };
    });
    const { maintenance } = await modules();
    const { notifyUserSwitch } = await import('../../../src/main/features/user-switch-hooks');
    const handle = maintenance.startMemoryMaintenanceLoop(runtime.uid);
    notifyUserSwitch(runtime.uid, 'account-b'); runtime.uid = 'account-b';
    notifyUserSwitch(runtime.uid, 'account-c'); runtime.uid = 'account-c';
    await Promise.resolve(); await Promise.resolve();
    expect(scheduled).toHaveLength(2);
    expect(scheduled[0].cancelled).toBe(true);
    expect(scheduled[1]).toMatchObject({ name: 'memory:maintenance', cancelled: false,
      options: { resourceClass: 'model', preferIdle: true } });
    handle.stop();
    await Promise.resolve();
    expect(scheduled[1].cancelled).toBe(true);
    expect(scheduled).toHaveLength(2);
    spy.mockRestore();
  });

  it('does not let repeatedly failing stores starve stores deferred by the daily batch cap', async () => {
    const { memory, maintenance } = await modules();
    for (let i = 0; i < 7; i++) seed(memory, { agent: `writer${i}` });
    const first = vi.fn(async () => { throw new Error('fixture unavailable'); });
    const now = Date.now();
    await maintenance.runMemoryMaintenanceCycle(runtime.uid, { consolidate: first, now: () => now });
    expect(first).toHaveBeenCalledTimes(5);
    const second = vi.fn(async (_uid, entries) => unchanged(entries));
    await maintenance.runMemoryMaintenanceCycle(runtime.uid, { consolidate: second, now: () => now + 3600_001 });
    expect(second).toHaveBeenCalledTimes(5);
    const { userLocalConfigDir } = await import('../../../src/main/paths');
    const state = JSON.parse(fs.readFileSync(path.join(userLocalConfigDir(runtime.uid), 'memory-maintenance.json'), 'utf8'));
    expect(Object.keys(state.scopes)).toHaveLength(7);
  });
});

describe('memory maintenance resource and recovery bounds', () => {
  it('caps model attempts across batches and restart while still accepting ordinary memory writes', async () => {
    let { memory, maintenance } = await modules();
    for (let i = 0; i < 24; i++) seed(memory, { agent: `writer${i}` });
    const consolidate = vi.fn(async (_uid, entries) => unchanged(entries));
    const now = Date.now();
    for (let hour = 0; hour < 5; hour++) {
      await maintenance.runMemoryMaintenanceCycle(runtime.uid, { consolidate, now: () => now + hour * 3600_001 });
    }
    expect(consolidate).toHaveBeenCalledTimes(maintenance.MAX_ATTEMPTS_PER_DAY);
    vi.resetModules(); ({ memory, maintenance } = await modules());
    await maintenance.runMemoryMaintenanceCycle(runtime.uid, { consolidate, now: () => now + 6 * 3600_001 });
    expect(consolidate).toHaveBeenCalledTimes(maintenance.MAX_ATTEMPTS_PER_DAY);
    const normal = await maintenance.addEntryWithMaintenance(runtime.uid, 'user', 'a new user preference', { consolidate });
    expect(normal.entries).toEqual(['a new user preference']);
    expect(consolidate).toHaveBeenCalledTimes(maintenance.MAX_ATTEMPTS_PER_DAY);
  });

  it('expires old recovery copies but preserves recent copies and canonical memory', async () => {
    const { memory, maintenance } = await modules();
    seed(memory);
    await maintenance.addEntryWithMaintenance(runtime.uid, { agent: 'writer' }, 'new fact', {
      consolidate: async (_uid, entries) => mergeFirst(entries),
    });
    const canonical = memory.listAgentEntries(runtime.uid, 'writer').entries;
    const { userLocalConfigDir } = await import('../../../src/main/paths');
    const dir = path.join(userLocalConfigDir(runtime.uid), 'memory-backups');
    const file = path.join(dir, fs.readdirSync(dir)[0]);
    const now = Date.now();
    await memory.pruneMemoryBackups(runtime.uid, now, () => true);
    expect(fs.existsSync(file)).toBe(true);
    await memory.pruneMemoryBackups(runtime.uid, now + 8 * maintenance.DAILY_INTERVAL_MS, () => true);
    expect(fs.existsSync(file)).toBe(false);
    expect(memory.listAgentEntries(runtime.uid, 'writer').entries).toEqual(canonical);
  });

  it('keeps the original memory if writing the recovery copy fails before commit', async () => {
    const { memory, maintenance } = await modules();
    const original = seed(memory);
    const { userLocalConfigDir } = await import('../../../src/main/paths');
    fs.mkdirSync(userLocalConfigDir(runtime.uid), { recursive: true });
    fs.writeFileSync(path.join(userLocalConfigDir(runtime.uid), 'memory-backups'), 'fixture blocks directory');
    await expect(maintenance.addEntryWithMaintenance(runtime.uid, { agent: 'writer' }, 'new fact', {
      consolidate: async (_uid, entries) => mergeFirst(entries),
    })).rejects.toThrow();
    expect(memory.listAgentEntries(runtime.uid, 'writer').entries).toEqual(original);
  });
});
