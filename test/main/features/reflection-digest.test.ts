import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

let tmpDir: string;
let prevWs: string | undefined;
let prevBuiltinRoot: string | undefined;
const TEST_UID = 'u1';

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-digest-'));
  prevWs = process.env.ORKAS_WORKSPACE_ROOT;
  prevBuiltinRoot = process.env.ORKAS_BUILTIN_ROOT;
  process.env.ORKAS_WORKSPACE_ROOT = tmpDir;
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
  return import('../../../src/main/features/reflection-digest');
}

// ── aggregateSession (pure) ─────────────────────────────────────────────

describe('reflection-digest › aggregateSession', () => {
  it('counts tool_use blocks by name', async () => {
    const mod = await loadModule();
    const m = mod.emptyMetrics();
    mod.aggregateSession([
      { role: 'assistant', content: [{ type: 'tool_use', name: 'web_search', input: {} }], ts: 1 },
      { role: 'assistant', content: [{ type: 'tool_use', name: 'web_search', input: {} }], ts: 2 },
      { role: 'assistant', content: [{ type: 'tool_use', name: 'bash', input: {} }], ts: 3 },
    ], m);
    expect(m.toolCalls).toEqual({ web_search: 2, bash: 1 });
    expect(m.sessionsAnalyzed).toBe(1);
  });

  it('counts tool_result errors and captures up to 3 samples', async () => {
    const mod = await loadModule();
    const m = mod.emptyMetrics();
    mod.aggregateSession([
      { role: 'user', content: [{ type: 'tool_result', toolUseId: 'a', content: 'ENETUNREACH connection refused', isError: true }] },
      { role: 'user', content: [{ type: 'tool_result', toolUseId: 'b', content: 'rate limit', isError: true }] },
      { role: 'user', content: [{ type: 'tool_result', toolUseId: 'c', content: 'timeout', isError: true }] },
      { role: 'user', content: [{ type: 'tool_result', toolUseId: 'd', content: 'fourth — should be capped', isError: true }] },
      { role: 'user', content: [{ type: 'tool_result', toolUseId: 'e', content: 'success', isError: false }] },
    ], m);
    expect(m.errorCount).toBe(4);
    expect(m.errorSamples.length).toBe(3); // capped at 3
    expect(m.errorSamples[0]).toContain('ENETUNREACH');
  });

  it('truncates long error samples', async () => {
    const mod = await loadModule();
    const m = mod.emptyMetrics();
    const longErr = 'X'.repeat(500);
    mod.aggregateSession([
      { role: 'user', content: [{ type: 'tool_result', toolUseId: 'a', content: longErr, isError: true }] },
    ], m);
    expect(m.errorSamples[0].length).toBeLessThanOrEqual(160);
  });

  it('tracks skill_manage(read) skill ids in skillsLoaded', async () => {
    const mod = await loadModule();
    const m = mod.emptyMetrics();
    mod.aggregateSession([
      { role: 'assistant', content: [{ type: 'tool_use', name: 'skill_manage', input: { action: 'read', id: 'foo' } }] },
      { role: 'assistant', content: [{ type: 'tool_use', name: 'skill_manage', input: { action: 'read', id: 'foo' } }] },
      { role: 'assistant', content: [{ type: 'tool_use', name: 'skill_manage', input: { action: 'create', id: 'bar' } }] },
    ], m);
    expect(m.skillsLoaded).toEqual({ foo: 2 }); // create not tracked, only read
    expect(m.toolCalls.skill_manage).toBe(3);
  });

  it('tracks earliestTs and latestTs from message ts fields', async () => {
    const mod = await loadModule();
    const m = mod.emptyMetrics();
    mod.aggregateSession([
      { role: 'user', content: [{ type: 'text', text: 'a' }], ts: 100 },
      { role: 'assistant', content: [{ type: 'text', text: 'b' }], ts: 200 },
      { role: 'user', content: [{ type: 'text', text: 'c' }], ts: 50 },
    ], m);
    expect(m.earliestTs).toBe(50);
    expect(m.latestTs).toBe(200);
  });

  it('does not increment sessionsAnalyzed for empty messages array', async () => {
    const mod = await loadModule();
    const m = mod.emptyMetrics();
    mod.aggregateSession([], m);
    expect(m.sessionsAnalyzed).toBe(0);
  });

  it('accumulates across multiple aggregate calls (multi-session)', async () => {
    const mod = await loadModule();
    const m = mod.emptyMetrics();
    mod.aggregateSession([{ role: 'assistant', content: [{ type: 'tool_use', name: 'bash' }] }], m);
    mod.aggregateSession([{ role: 'assistant', content: [{ type: 'tool_use', name: 'bash' }] }], m);
    expect(m.sessionsAnalyzed).toBe(2);
    expect(m.toolCalls.bash).toBe(2);
  });

  it('handles malformed content blocks defensively', async () => {
    const mod = await loadModule();
    const m = mod.emptyMetrics();
    mod.aggregateSession([
      { role: 'assistant' }, // missing content
      { role: 'assistant', content: 'not an array' },
      { role: 'assistant', content: [null, undefined, { type: 'tool_use' /* no name */ }] },
    ], m);
    expect(m.sessionsAnalyzed).toBe(1);
    expect(m.toolCalls).toEqual({});
  });
});

// ── formatDigest (pure) ─────────────────────────────────────────────────

describe('reflection-digest › formatDigest', () => {
  it('returns "no activity" when nothing was analyzed', async () => {
    const mod = await loadModule();
    const out = mod.formatDigest(mod.emptyMetrics(), Date.parse('2026-04-21'), Date.parse('2026-04-23'));
    expect(out).toMatch(/无新增对话活动/);
  });

  it('formats a populated digest with all sections', async () => {
    const mod = await loadModule();
    const m = mod.emptyMetrics();
    m.sessionsAnalyzed = 3;
    m.toolCalls = { bash: 5, web_search: 2 };
    m.errorCount = 2;
    m.errorSamples = ['rate limit', 'timeout'];
    m.skillsLoaded = { 'recover-foo': 3 };
    m.earliestTs = Date.parse('2026-04-21T10:00:00Z');
    m.latestTs = Date.parse('2026-04-23T10:00:00Z');

    const out = mod.formatDigest(m, m.earliestTs, Date.now());
    expect(out).toContain('3 个会话');
    expect(out).toContain('bash: 5 次');
    expect(out).toContain('web_search: 2 次');
    expect(out).toContain('错误总数**: 2');
    expect(out).toContain('rate limit');
    expect(out).toContain('recover-foo (3x)');
  });

  it('omits error section when no errors', async () => {
    const mod = await loadModule();
    const m = mod.emptyMetrics();
    m.sessionsAnalyzed = 1;
    m.toolCalls = { bash: 1 };
    const out = mod.formatDigest(m, Date.now() - 1000, Date.now());
    expect(out).not.toContain('错误总数');
    expect(out).not.toContain('错误样本');
  });

  it('caps tool list at top-N most-called', async () => {
    const mod = await loadModule();
    const m = mod.emptyMetrics();
    m.sessionsAnalyzed = 1;
    // 12 different tools — should only show top 8
    for (let i = 0; i < 12; i++) m.toolCalls[`tool${i}`] = 100 - i;
    const out = mod.formatDigest(m, Date.now() - 1000, Date.now());
    expect(out).toContain('tool0');
    expect(out).toContain('tool7');
    expect(out).not.toContain('tool8');
  });
});

// ── buildAgentReflectionDigest (I/O) ────────────────────────────────────

describe('reflection-digest › buildAgentReflectionDigest', () => {
  function writeConv(uid: string, cid: string, agentId: string): string {
    // Write to chats/_index.json (newest-first list).
    const idxPath = path.join(tmpDir, uid, 'cloud', 'chats', '_index.json');
    fs.mkdirSync(path.dirname(idxPath), { recursive: true });
    let list: any[] = [];
    if (fs.existsSync(idxPath)) list = JSON.parse(fs.readFileSync(idxPath, 'utf8'));
    const sessionId = `${uid}-gconv-${cid}`;
    list.unshift({
      conversation_id: cid,
      title: `t-${cid}`,
      kind: agentId ? 'agent_run' : 'normal',
      agent_id: agentId,
      skill_id: '',
      session_id: sessionId,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });
    fs.writeFileSync(idxPath, JSON.stringify(list));
    return sessionId;
  }

  function writeSessionJsonl(uid: string, sessionId: string, lines: any[], mtime?: number): void {
    const file = path.join(tmpDir, uid, 'cloud', 'sessions', `${sessionId}.jsonl`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
    if (mtime !== undefined) fs.utimesSync(file, mtime / 1000, mtime / 1000);
  }

  it('returns "no activity" when no matching conversations exist', async () => {
    const mod = await loadModule();
    const out = await mod.buildAgentReflectionDigest(TEST_UID, '_default', Date.now() - 86400000);
    expect(out).toMatch(/无新增对话活动/);
  });

  it('aggregates only conversations matching the target agent_id', async () => {
    const sid1 = writeConv(TEST_UID, 'c1', '');           // normal → _default
    const sid2 = writeConv(TEST_UID, 'c2', 'agent-x');    // agent-x
    writeSessionJsonl(TEST_UID, sid1, [
      { role: 'assistant', content: [{ type: 'tool_use', name: 'bash' }], ts: Date.now() },
    ]);
    writeSessionJsonl(TEST_UID, sid2, [
      { role: 'assistant', content: [{ type: 'tool_use', name: 'web_search' }], ts: Date.now() },
    ]);

    const mod = await loadModule();
    const since = Date.now() - 86400000;

    const defaultDigest = await mod.buildAgentReflectionDigest(TEST_UID, '_default', since);
    expect(defaultDigest).toContain('bash');
    expect(defaultDigest).not.toContain('web_search');

    const xDigest = await mod.buildAgentReflectionDigest(TEST_UID, 'agent-x', since);
    expect(xDigest).toContain('web_search');
    expect(xDigest).not.toContain('bash');
  });

  it('skips session jsonls with mtime older than sinceMs', async () => {
    const sid = writeConv(TEST_UID, 'cold', '');
    const ancient = Date.now() - 30 * 86400000; // 30 days ago
    writeSessionJsonl(TEST_UID, sid, [
      { role: 'assistant', content: [{ type: 'tool_use', name: 'bash' }] },
    ], ancient);

    const mod = await loadModule();
    const since = Date.now() - 86400000; // last 24h
    const digest = await mod.buildAgentReflectionDigest(TEST_UID, '_default', since);
    expect(digest).toMatch(/无新增对话活动/);
  });

  it('tolerates malformed jsonl lines and missing files', async () => {
    const sid = writeConv(TEST_UID, 'malformed', '');
    const file = path.join(tmpDir, TEST_UID, 'cloud', 'sessions', `${sid}.jsonl`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, 'not json\n{"role":"assistant","content":[{"type":"tool_use","name":"ok"}]}\n}}}\n');

    // Also reference a conversation whose session file doesn't exist
    writeConv(TEST_UID, 'ghost', '');

    const mod = await loadModule();
    const digest = await mod.buildAgentReflectionDigest(TEST_UID, '_default', 0);
    expect(digest).toContain('ok'); // valid line still parsed
    // Ghost session simply skipped — no throw, and the malformed-but-valid one accounted for.
  });
});
