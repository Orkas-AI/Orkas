import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

let tmpDir: string;
let prevWs: string | undefined;
let prevBuiltinRoot: string | undefined;
const TEST_UID = 'u1';

function stateFile(uid: string): string {
  return path.join(tmpDir, uid, 'local', 'config', 'reflection-state.json');
}

function customAgentsDir(uid: string): string {
  return path.join(tmpDir, uid, 'cloud', 'agents');
}

function writeAgent(uid: string, agentId: string): void {
  // Agent 目录形态:agents/<aid>/agent.json (详见 docs/plans/agent-as-directory.md)
  const aDir = path.join(customAgentsDir(uid), agentId);
  fs.mkdirSync(aDir, { recursive: true });
  fs.writeFileSync(
    path.join(aDir, 'agent.json'),
    JSON.stringify({ agent_id: agentId, name: agentId, description: '', workflow: '', updated_at: new Date().toISOString() }),
  );
}

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-reflect-'));
  prevWs = process.env.ORKAS_WORKSPACE_ROOT;
  prevBuiltinRoot = process.env.ORKAS_BUILTIN_ROOT;
  process.env.ORKAS_WORKSPACE_ROOT = tmpDir;
  // Empty tmpDir as builtin root → no builtin agents picked up.
  process.env.ORKAS_BUILTIN_ROOT = tmpDir;
  vi.resetModules();
  const users = await import('../../../src/main/features/users');
  users.activateUser(TEST_UID);
});

afterEach(() => {
  process.env.ORKAS_WORKSPACE_ROOT = prevWs;
  process.env.ORKAS_BUILTIN_ROOT = prevBuiltinRoot;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

async function loadModule() {
  return import('../../../src/main/features/reflection-trigger');
}

// ── pickEligibleAgents (pure) ──────────────────────────────────────────

describe('reflection-trigger › pickEligibleAgents', () => {
  it('returns all agents when state is empty', async () => {
    const mod = await loadModule();
    const eligible = mod.pickEligibleAgents(['a', 'b', '_default'], { lastReflectedAt: {} }, Date.now());
    expect(eligible).toEqual(['a', 'b', '_default']);
  });

  it('filters out agents within cooldown', async () => {
    const mod = await loadModule();
    const now = new Date('2026-04-23T12:00:00Z').getTime();
    const oneHourAgo = new Date('2026-04-23T11:00:00Z').toISOString();
    const eligible = mod.pickEligibleAgents(
      ['recent', 'old'],
      { lastReflectedAt: { recent: oneHourAgo } },
      now,
    );
    expect(eligible).toEqual(['old']);
  });

  it('keeps agents past cooldown', async () => {
    const mod = await loadModule();
    const now = new Date('2026-04-23T12:00:00Z').getTime();
    const fiftyHoursAgo = new Date('2026-04-21T10:00:00Z').toISOString();
    const eligible = mod.pickEligibleAgents(
      ['ancient'],
      { lastReflectedAt: { ancient: fiftyHoursAgo } },
      now,
    );
    expect(eligible).toEqual(['ancient']);
  });

  it('treats invalid timestamps as "never reflected" (defensive)', async () => {
    const mod = await loadModule();
    const eligible = mod.pickEligibleAgents(
      ['broken'],
      { lastReflectedAt: { broken: 'not-a-date' } },
      Date.now(),
    );
    expect(eligible).toEqual(['broken']);
  });

  it('honors custom cooldownHours', async () => {
    const mod = await loadModule();
    const now = new Date('2026-04-23T12:00:00Z').getTime();
    const twoHoursAgo = new Date('2026-04-23T10:00:00Z').toISOString();
    // 1-hour cooldown → eligible; 3-hour cooldown → not eligible
    expect(mod.pickEligibleAgents(['x'], { lastReflectedAt: { x: twoHoursAgo } }, now, 1)).toEqual(['x']);
    expect(mod.pickEligibleAgents(['x'], { lastReflectedAt: { x: twoHoursAgo } }, now, 3)).toEqual([]);
  });

  it('exact boundary: now - lastReflectedAt === cooldown is eligible', async () => {
    const mod = await loadModule();
    const now = new Date('2026-04-23T12:00:00Z').getTime();
    const exactlyAtCooldown = new Date(now - 48 * 3600 * 1000).toISOString();
    expect(mod.pickEligibleAgents(['x'], { lastReflectedAt: { x: exactlyAtCooldown } }, now)).toEqual(['x']);
  });
});

// ── readReflectionState / writeReflectionState ─────────────────────────

describe('reflection-trigger › state IO', () => {
  it('reads empty state when file missing', async () => {
    const mod = await loadModule();
    const state = mod.readReflectionState(TEST_UID);
    expect(state).toEqual({ lastReflectedAt: {} });
  });

  it('round-trips state through write+read', async () => {
    const mod = await loadModule();
    mod.writeReflectionState(TEST_UID, { lastReflectedAt: { foo: '2026-04-23T00:00:00Z' } });
    expect(fs.existsSync(stateFile(TEST_UID))).toBe(true);
    const state = mod.readReflectionState(TEST_UID);
    expect(state).toEqual({ lastReflectedAt: { foo: '2026-04-23T00:00:00Z' } });
  });

  it('treats malformed JSON as empty state (no throw)', async () => {
    const mod = await loadModule();
    // Pre-create the dir then write garbage.
    fs.mkdirSync(path.dirname(stateFile(TEST_UID)), { recursive: true });
    fs.writeFileSync(stateFile(TEST_UID), 'not json {{{');
    const state = mod.readReflectionState(TEST_UID);
    expect(state).toEqual({ lastReflectedAt: {} });
  });

  it('treats valid JSON without lastReflectedAt as empty state', async () => {
    const mod = await loadModule();
    fs.mkdirSync(path.dirname(stateFile(TEST_UID)), { recursive: true });
    fs.writeFileSync(stateFile(TEST_UID), JSON.stringify({ random: true }));
    const state = mod.readReflectionState(TEST_UID);
    expect(state).toEqual({ lastReflectedAt: {} });
  });

  it('filters non-string timestamp values', async () => {
    const mod = await loadModule();
    fs.mkdirSync(path.dirname(stateFile(TEST_UID)), { recursive: true });
    fs.writeFileSync(stateFile(TEST_UID), JSON.stringify({
      lastReflectedAt: { good: '2026-04-23T00:00:00Z', bad: 12345, also_bad: null },
    }));
    const state = mod.readReflectionState(TEST_UID);
    expect(state.lastReflectedAt).toEqual({ good: '2026-04-23T00:00:00Z' });
  });
});

// ── runStartupReflections (orchestrator with mocked reflect) ───────────

describe('reflection-trigger › runStartupReflections', () => {
  it('no-ops when uid is empty', async () => {
    const mod = await loadModule();
    const reflect = vi.fn().mockResolvedValue(undefined);
    await mod.runStartupReflections('', { reflect });
    expect(reflect).not.toHaveBeenCalled();
  });

  it('reflects for _default plus every custom agent and stamps state', async () => {
    writeAgent(TEST_UID, 'agent-foo');
    writeAgent(TEST_UID, 'agent-bar');
    const mod = await loadModule();
    const reflect = vi.fn().mockResolvedValue(undefined);
    const now = new Date('2026-04-23T12:00:00Z').getTime();
    await mod.runStartupReflections(TEST_UID, { reflect, now: () => now });

    // Called for each agent (order: _default first, then customs sorted).
    const calls = reflect.mock.calls.map((c) => c[1] as string);
    expect(calls).toContain('_default');
    expect(calls).toContain('agent-foo');
    expect(calls).toContain('agent-bar');
    expect(calls.length).toBe(3);

    // State file stamped for each.
    const state = mod.readReflectionState(TEST_UID);
    expect(state.lastReflectedAt['_default']).toBe(new Date(now).toISOString());
    expect(state.lastReflectedAt['agent-foo']).toBe(new Date(now).toISOString());
    expect(state.lastReflectedAt['agent-bar']).toBe(new Date(now).toISOString());
  });

  it('skips agents within cooldown', async () => {
    writeAgent(TEST_UID, 'agent-recent');
    writeAgent(TEST_UID, 'agent-old');
    const mod = await loadModule();
    const now = new Date('2026-04-23T12:00:00Z').getTime();
    // Pre-stamp agent-recent within cooldown, agent-old long ago, _default never.
    mod.writeReflectionState(TEST_UID, {
      lastReflectedAt: {
        'agent-recent': new Date(now - 1 * 3600 * 1000).toISOString(),
        'agent-old': new Date(now - 100 * 3600 * 1000).toISOString(),
      },
    });

    const reflect = vi.fn().mockResolvedValue(undefined);
    await mod.runStartupReflections(TEST_UID, { reflect, now: () => now });

    const calls = reflect.mock.calls.map((c) => c[1]).sort();
    expect(calls).toEqual(['_default', 'agent-old']);
    // recent's timestamp untouched
    const state = mod.readReflectionState(TEST_UID);
    expect(state.lastReflectedAt['agent-recent']).toBe(new Date(now - 1 * 3600 * 1000).toISOString());
    expect(state.lastReflectedAt['agent-old']).toBe(new Date(now).toISOString());
  });

  it('does NOT stamp state when reflection throws', async () => {
    writeAgent(TEST_UID, 'agent-fail');
    const mod = await loadModule();
    const reflect = vi.fn(async (_uid: string, agentId: string) => {
      if (agentId === 'agent-fail') throw new Error('llm down');
    });
    const now = new Date('2026-04-23T12:00:00Z').getTime();
    await mod.runStartupReflections(TEST_UID, { reflect, now: () => now });

    const state = mod.readReflectionState(TEST_UID);
    expect(state.lastReflectedAt['_default']).toBe(new Date(now).toISOString());
    // Failure → not stamped → eligible again next time.
    expect(state.lastReflectedAt['agent-fail']).toBeUndefined();
  });

  it('does not abort the batch when one agent fails', async () => {
    writeAgent(TEST_UID, 'agent-1');
    writeAgent(TEST_UID, 'agent-fail');
    writeAgent(TEST_UID, 'agent-2');
    const mod = await loadModule();
    const reflect = vi.fn(async (_uid: string, agentId: string) => {
      if (agentId === 'agent-fail') throw new Error('boom');
    });
    await mod.runStartupReflections(TEST_UID, { reflect });
    const calls = reflect.mock.calls.map((c) => c[1] as string);
    // All four (including the failing one) attempted.
    expect(calls.length).toBe(4);
    expect(calls).toContain('agent-1');
    expect(calls).toContain('agent-2');
    expect(calls).toContain('agent-fail');
  });

  it('per-uid state isolation', async () => {
    const otherUid = 'u2';
    writeAgent(TEST_UID, 'agent-shared-name');
    const mod = await loadModule();
    const now = new Date('2026-04-23T12:00:00Z').getTime();
    // Stamp uid u2 (would skip everything if state were shared).
    mod.writeReflectionState(otherUid, {
      lastReflectedAt: { '_default': new Date(now).toISOString(), 'agent-shared-name': new Date(now).toISOString() },
    });

    const reflect = vi.fn().mockResolvedValue(undefined);
    await mod.runStartupReflections(TEST_UID, { reflect, now: () => now });
    // u1 never reflected → all eligible regardless of u2 state.
    expect(reflect.mock.calls.map((c) => c[1])).toContain('_default');
    expect(reflect.mock.calls.map((c) => c[1])).toContain('agent-shared-name');

    // u1 state stamped, u2 state untouched at 12:00:00Z (we wrote it ourselves above).
    const u1State = mod.readReflectionState(TEST_UID);
    const u2State = mod.readReflectionState(otherUid);
    expect(u1State.lastReflectedAt['_default']).toBe(new Date(now).toISOString());
    expect(u2State.lastReflectedAt['_default']).toBe(new Date(now).toISOString());
    expect(stateFile(TEST_UID)).not.toBe(stateFile(otherUid));
  });

  it('passes sinceMs from prior lastReflectedAt to reflect()', async () => {
    writeAgent(TEST_UID, 'agent-x');
    const mod = await loadModule();
    const now = new Date('2026-04-23T12:00:00Z').getTime();
    const lastIso = new Date(now - 100 * 3600 * 1000).toISOString(); // outside cooldown
    mod.writeReflectionState(TEST_UID, { lastReflectedAt: { 'agent-x': lastIso } });

    const reflect = vi.fn().mockResolvedValue(undefined);
    await mod.runStartupReflections(TEST_UID, { reflect, now: () => now });

    const agentXCall = reflect.mock.calls.find((c) => c[1] === 'agent-x');
    expect(agentXCall).toBeDefined();
    // Third arg should be the parsed lastIso, NOT the default lookback.
    expect(agentXCall![2]).toBe(Date.parse(lastIso));
  });

  it('falls back to default lookback when no prior lastReflectedAt', async () => {
    const mod = await loadModule();
    const now = new Date('2026-04-23T12:00:00Z').getTime();
    const reflect = vi.fn().mockResolvedValue(undefined);
    await mod.runStartupReflections(TEST_UID, { reflect, now: () => now });

    const defaultCall = reflect.mock.calls.find((c) => c[1] === '_default');
    expect(defaultCall).toBeDefined();
    // First-ever reflection → 7 day lookback.
    const expectedSince = now - 7 * 24 * 3600 * 1000;
    expect(defaultCall![2]).toBe(expectedSince);
  });

  it('runs sequentially (next reflect awaited before previous returns)', async () => {
    writeAgent(TEST_UID, 'a1');
    writeAgent(TEST_UID, 'a2');
    const mod = await loadModule();

    const order: string[] = [];
    const reflect = vi.fn(async (_uid: string, agentId: string) => {
      order.push(`start:${agentId}`);
      await new Promise((r) => setTimeout(r, 10));
      order.push(`end:${agentId}`);
    });

    await mod.runStartupReflections(TEST_UID, { reflect });
    // Each agent's start/end pair must not interleave with another agent's pair.
    for (let i = 0; i < order.length; i += 2) {
      expect(order[i].replace('start:', '')).toBe(order[i + 1].replace('end:', ''));
    }
  });
});
