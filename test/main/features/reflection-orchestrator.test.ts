import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// Same race as in reflection-transcript.test.ts: activateUser fires
// sweepSessions fire-and-forget and would wipe our test session files.
vi.mock('../../../src/main/features/sessions_sweep', () => ({
  sweepSessions: vi.fn(async () => ({
    scanned: 0, orphan_cid: 0, ephemeral_on_cloud: 0, legacy: 0,
    local_aged_out: 0, errors: 0,
  })),
}));

let tmpDir: string;
let prevWs: string | undefined;
const TEST_UID = 'u1';

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-orchestrator-'));
  prevWs = process.env.ORKAS_WORKSPACE_ROOT;
  process.env.ORKAS_WORKSPACE_ROOT = tmpDir;
  vi.resetModules();
  const users = await import('../../../src/main/features/users');
  users.activateUser(TEST_UID);
});

afterEach(() => {
  process.env.ORKAS_WORKSPACE_ROOT = prevWs;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

async function loadModule() {
  return import('../../../src/main/features/reflection-orchestrator');
}

function writeReflectionState(uid: string, lastReflectedAt: Record<string, string>): void {
  const dir = path.join(tmpDir, uid, 'local', 'config');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'reflection-state.json'), JSON.stringify({ lastReflectedAt }));
}

// ── pickAgentsForCycle ──────────────────────────────────────────────────

describe('reflection-orchestrator › pickAgentsForCycle', () => {
  const NOW = Date.parse('2026-05-21T12:00:00Z');

  it('skips agents within cooldown (< 4h since lastReflectedAt)', async () => {
    const mod = await loadModule();
    const state = { lastReflectedAt: { 'agent-x': new Date(NOW - 2 * 3600 * 1000).toISOString() } };
    const picked = await mod.pickAgentsForCycle(TEST_UID, ['agent-x'], state, NOW, async () => true);
    expect(picked.length).toBe(0);
  });

  it('picks dirty agents past cooldown', async () => {
    const mod = await loadModule();
    const state = { lastReflectedAt: { 'agent-x': new Date(NOW - 6 * 3600 * 1000).toISOString() } };
    const picked = await mod.pickAgentsForCycle(TEST_UID, ['agent-x'], state, NOW, async () => true);
    expect(picked.length).toBe(1);
    expect(picked[0].reason).toBe('dirty');
  });

  it('forces reflection when past 7-day max gap regardless of dirty', async () => {
    const mod = await loadModule();
    const stale = new Date(NOW - 10 * 24 * 3600 * 1000).toISOString();
    const state = { lastReflectedAt: { 'agent-x': stale } };
    const picked = await mod.pickAgentsForCycle(TEST_UID, ['agent-x'], state, NOW, async () => false);
    expect(picked.length).toBe(1);
    expect(picked[0].reason).toBe('max_gap');
  });

  it('treats never-reflected agents as eligible when dirty (default lookback)', async () => {
    const mod = await loadModule();
    const state = { lastReflectedAt: {} };
    const picked = await mod.pickAgentsForCycle(TEST_UID, ['agent-x'], state, NOW, async () => true);
    expect(picked.length).toBe(1);
    expect(picked[0].reason).toBe('never_reflected');
    // sinceMs should be ~48h before now (DEFAULT_LOOKBACK_MS)
    expect(NOW - picked[0].sinceMs).toBeCloseTo(48 * 3600 * 1000, -5);
  });

  it('skips never-reflected agents when not dirty', async () => {
    const mod = await loadModule();
    const state = { lastReflectedAt: {} };
    const picked = await mod.pickAgentsForCycle(TEST_UID, ['agent-x'], state, NOW, async () => false);
    expect(picked.length).toBe(0);
  });

  it('caps at MAX_AGENTS_PER_CYCLE, picking earliest lastReflectedAt first', async () => {
    const mod = await loadModule();
    const lastReflectedAt: Record<string, string> = {};
    for (let i = 0; i < 8; i++) {
      // agent-0 oldest (NOW - 8h), agent-7 newest just past cooldown (NOW - 4.1h)
      lastReflectedAt[`agent-${i}`] = new Date(NOW - (8 - i * 0.5) * 3600 * 1000).toISOString();
    }
    const ids = Object.keys(lastReflectedAt);
    const picked = await mod.pickAgentsForCycle(TEST_UID, ids, { lastReflectedAt }, NOW, async () => true);
    expect(picked.length).toBe(mod.MAX_AGENTS_PER_CYCLE);
    // First in result should be the oldest (agent-0)
    expect(picked[0].agentId).toBe('agent-0');
  });

  it('processes a mix: cooldown / dirty / max_gap correctly', async () => {
    const mod = await loadModule();
    const state = {
      lastReflectedAt: {
        'cool':    new Date(NOW - 1 * 3600 * 1000).toISOString(),   // within cooldown
        'dirty':   new Date(NOW - 6 * 3600 * 1000).toISOString(),   // past cooldown, dirty
        'stale':   new Date(NOW - 10 * 24 * 3600 * 1000).toISOString(), // max_gap
        'idle':    new Date(NOW - 6 * 3600 * 1000).toISOString(),   // past cooldown, not dirty
      },
    };
    const isDirty = async (_u: string, id: string) => id === 'dirty';
    const picked = await mod.pickAgentsForCycle(TEST_UID, ['cool', 'dirty', 'stale', 'idle'], state, NOW, isDirty);
    const ids = picked.map((p) => p.agentId).sort();
    expect(ids).toEqual(['dirty', 'stale']);
  });
});

// ── runOneCycle ──────────────────────────────────────────────────────────

describe('reflection-orchestrator › runOneCycle', () => {
  const NOW = Date.parse('2026-05-21T12:00:00Z');

  it('returns 0 when no agents are eligible', async () => {
    const mod = await loadModule();
    const reflect = vi.fn(async () => { /* never called */ });
    const completed = await mod.runOneCycle(TEST_UID, {
      now: () => NOW,
      reflect,
      isDirty: async () => false,
    });
    expect(completed).toBe(0);
    expect(reflect).not.toHaveBeenCalled();
  });

  it('failed reflection does not stamp lastReflectedAt (retry next cycle)', async () => {
    const mod = await loadModule();
    const reflect = vi.fn(async () => { throw new Error('provider down'); });
    const completed = await mod.runOneCycle(TEST_UID, {
      now: () => NOW,
      reflect,
      isDirty: async () => true,
    });
    expect(reflect).toHaveBeenCalled();
    expect(completed).toBe(0);
    const state = mod.readReflectionState(TEST_UID);
    expect(state.lastReflectedAt).toEqual({});  // no stamp on failure
  });

  it('successful reflection stamps lastReflectedAt with `now`', async () => {
    const mod = await loadModule();
    const reflect = vi.fn(async () => { /* succeed */ });
    const completed = await mod.runOneCycle(TEST_UID, {
      now: () => NOW,
      reflect,
      isDirty: async () => true,
    });
    expect(completed).toBeGreaterThanOrEqual(1);
    const state = mod.readReflectionState(TEST_UID);
    expect(state.lastReflectedAt[mod.DEFAULT_AGENT_ID]).toBe(new Date(NOW).toISOString());
  });

  it('skips with debug log when feature flag is off', async () => {
    process.env.ORKAS_METACOGNITION = '0';
    try {
      const mod = await loadModule();
      const reflect = vi.fn();
      const completed = await mod.runOneCycle(TEST_UID, { now: () => NOW, reflect, isDirty: async () => true });
      expect(completed).toBe(0);
      expect(reflect).not.toHaveBeenCalled();
    } finally {
      delete process.env.ORKAS_METACOGNITION;
    }
  });

  it('skips with debug log when uid is empty', async () => {
    const mod = await loadModule();
    const reflect = vi.fn();
    const completed = await mod.runOneCycle('', { now: () => NOW, reflect, isDirty: async () => true });
    expect(completed).toBe(0);
    expect(reflect).not.toHaveBeenCalled();
  });
});

// ── isAgentDirty (cross-agent dispatch fix) ─────────────────────────────

describe('reflection-orchestrator › isAgentDirty', () => {
  function writeConvIndex(uid: string, conv: { cid: string; agent_id: string }): void {
    const idxPath = path.join(tmpDir, uid, 'cloud', 'chats', '_index.json');
    fs.mkdirSync(path.dirname(idxPath), { recursive: true });
    const list = fs.existsSync(idxPath) ? JSON.parse(fs.readFileSync(idxPath, 'utf8')) : [];
    list.unshift({
      conversation_id: conv.cid,
      title: `t-${conv.cid}`,
      kind: conv.agent_id ? 'agent_run' : 'normal',
      agent_id: conv.agent_id,
      skill_id: '',
      session_id: `gconv-${conv.cid}`,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });
    fs.writeFileSync(idxPath, JSON.stringify(list));
  }

  function writeSessionFile(uid: string, sessionId: string, lines: any[]): void {
    const file = path.join(tmpDir, uid, 'cloud', 'sessions', `${sessionId}.jsonl`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  }

  it('detects dispatched-in agent by gmember mtime even when conv.agent_id differs', async () => {
    // c1 started by "other", commander dispatched "target" via plan_set.
    // No signals.jsonl entries. Old design's listConversations+filter would
    // miss this; the new filesystem-scan path catches it.
    writeConvIndex(TEST_UID, { cid: 'c1', agent_id: 'other' });
    writeSessionFile(TEST_UID, 'gmember-c1-target', [
      { role: 'assistant', content: [{ type: 'text', text: 'hi from target' }], ts: 100 },
    ]);

    const mod = await loadModule();
    expect(await mod.isAgentDirty(TEST_UID, 'target', 0)).toBe(true);
  });

  it('returns false when gmember file mtime is older than sinceMs', async () => {
    writeConvIndex(TEST_UID, { cid: 'c1', agent_id: 'other' });
    const file = path.join(tmpDir, TEST_UID, 'cloud', 'sessions', 'gmember-c1-target.jsonl');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '{"role":"assistant","content":[{"type":"text","text":"old"}],"ts":1}\n');
    const ancient = Date.now() - 30 * 86400 * 1000;
    fs.utimesSync(file, ancient / 1000, ancient / 1000);

    const mod = await loadModule();
    const since = Date.now() - 86400 * 1000;  // 1 day ago
    expect(await mod.isAgentDirty(TEST_UID, 'target', since)).toBe(false);
  });

  it('returns false when no gmember file exists for the agent', async () => {
    writeConvIndex(TEST_UID, { cid: 'c1', agent_id: 'other' });
    writeSessionFile(TEST_UID, 'gmember-c1-other', [
      { role: 'assistant', content: [{ type: 'text', text: 'other' }], ts: 100 },
    ]);

    const mod = await loadModule();
    // 'target' has no gmember file → not dirty (regardless of c1's existence)
    expect(await mod.isAgentDirty(TEST_UID, 'target', 0)).toBe(false);
  });
});

// ── readReflectionState / writeReflectionState round-trip ───────────────

describe('reflection-orchestrator › state persistence', () => {
  it('round-trips lastReflectedAt through disk', async () => {
    const mod = await loadModule();
    fs.mkdirSync(path.join(tmpDir, TEST_UID, 'local', 'config'), { recursive: true });
    mod.writeReflectionState(TEST_UID, { lastReflectedAt: { 'agent-x': '2026-05-21T10:00:00Z' } });
    const read = mod.readReflectionState(TEST_UID);
    expect(read.lastReflectedAt['agent-x']).toBe('2026-05-21T10:00:00Z');
  });

  it('returns empty state when file is missing', async () => {
    const mod = await loadModule();
    expect(mod.readReflectionState(TEST_UID)).toEqual({ lastReflectedAt: {} });
  });

  it('returns empty state when file is malformed (defensive)', async () => {
    const mod = await loadModule();
    const dir = path.join(tmpDir, TEST_UID, 'local', 'config');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'reflection-state.json'), '{not json');
    expect(mod.readReflectionState(TEST_UID)).toEqual({ lastReflectedAt: {} });
  });

  it('filters out non-string values defensively', async () => {
    const mod = await loadModule();
    writeReflectionState(TEST_UID, { 'a': 'iso', /* @ts-expect-error */ 'b': 123 as any });
    const read = mod.readReflectionState(TEST_UID);
    expect(read.lastReflectedAt).toEqual({ a: 'iso' });
  });
});
