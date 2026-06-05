import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// activateUser fires sweepSessions fire-and-forget; in real boot it races
// safely with subsequent writes, but in unit tests the sweep can wipe the
// gmember-*.jsonl files we just created (cid not yet in _index.json when
// the sweep snapshots cids). Stub it out for the whole file.
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
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-transcript-'));
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
  return import('../../../src/main/features/reflection-transcript');
}

// ── Test helpers ────────────────────────────────────────────────────────

interface ConvSpec {
  cid: string;
  agentId: string;
  title?: string;
  createdAt?: string;
}

function writeConv(uid: string, spec: ConvSpec): { sessionId: string; gmemberSessionId: string } {
  const idxPath = path.join(tmpDir, uid, 'cloud', 'chats', '_index.json');
  fs.mkdirSync(path.dirname(idxPath), { recursive: true });
  let list: any[] = [];
  if (fs.existsSync(idxPath)) list = JSON.parse(fs.readFileSync(idxPath, 'utf8'));
  const sessionId = `gconv-${spec.cid}`;
  list.unshift({
    conversation_id: spec.cid,
    title: spec.title || `t-${spec.cid}`,
    kind: spec.agentId ? 'agent_run' : 'normal',
    agent_id: spec.agentId,
    skill_id: '',
    session_id: sessionId,
    created_at: spec.createdAt || new Date().toISOString(),
    updated_at: new Date().toISOString(),
  });
  fs.writeFileSync(idxPath, JSON.stringify(list));
  return {
    sessionId,
    gmemberSessionId: `gmember-${spec.cid}-${spec.agentId}`,
  };
}

function writeSessionJsonl(uid: string, sessionId: string, lines: any[]): void {
  const file = path.join(tmpDir, uid, 'cloud', 'sessions', `${sessionId}.jsonl`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
}

function userMsg(text: string, ts: number, from = 'user', to = 'commander'): any {
  return {
    role: 'user',
    content: [{ type: 'text', text: `<msg from="${from}" to="${to}">\n${text}\n</msg>` }],
    ts,
  };
}

function agentMsg(text: string, ts: number): any {
  return {
    role: 'assistant',
    content: [{ type: 'text', text }],
    ts,
  };
}

function writeSignalsJsonl(uid: string, signals: any[], date?: Date): void {
  // Match source: signalsDailyFile() uses local YMD, not UTC.
  const d = date || new Date();
  const ymd = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const file = path.join(tmpDir, uid, 'local', 'signals', `${ymd}.jsonl`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, signals.map((s) => JSON.stringify(s)).join('\n') + '\n');
}

function sig(overrides: any): any {
  return {
    id: `sig_${Math.random().toString(36).slice(2)}`,
    ts: new Date().toISOString(),
    source: 'event',
    cid: 'c1',
    aid: 'agent-x',
    turn_id: 't1',
    context_ref: { msg_ids: [] },
    extractor_version: 'event@1.0',
    ...overrides,
  };
}

// ── estimateTokens ──────────────────────────────────────────────────────

describe('reflection-transcript › estimateTokens', () => {
  it('uses ~4 chars/token for English text', async () => {
    const mod = await loadModule();
    // "hello world" = 11 chars / 4 ≈ 3 tokens
    expect(mod.estimateTokens('hello world')).toBe(3);
  });

  it('uses ~0.7 token/char for CJK text', async () => {
    const mod = await loadModule();
    // "你好世界" 4 chars * 0.7 = 2.8 → 3
    expect(mod.estimateTokens('你好世界')).toBe(3);
  });

  it('handles mixed Chinese / English correctly', async () => {
    const mod = await loadModule();
    // "hello 世界" = 6 ASCII chars / 4 + 2 CJK * 0.7 = 1.5 + 1.4 = 2.9 → 3
    expect(mod.estimateTokens('hello 世界')).toBe(3);
  });

  it('returns 0 for empty string', async () => {
    const mod = await loadModule();
    expect(mod.estimateTokens('')).toBe(0);
  });
});

// ── parseMsgWrapper / extractors (pure) ─────────────────────────────────

describe('reflection-transcript › parseMsgWrapper', () => {
  it('extracts from + inner text from a well-formed wrapper', async () => {
    const { _internals } = await loadModule();
    const r = _internals.parseMsgWrapper('<msg from="user" to="commander">\nhello\n</msg>');
    expect(r).toEqual({ from: 'user', inner: 'hello' });
  });

  it('treats unwrapped text as user (defensive default)', async () => {
    const { _internals } = await loadModule();
    const r = _internals.parseMsgWrapper('raw legacy text');
    expect(r.from).toBe('user');
    expect(r.inner).toBe('raw legacy text');
  });

  it('extracts non-user from (e.g. commander dispatch)', async () => {
    const { _internals } = await loadModule();
    const r = _internals.parseMsgWrapper('<msg from="commander" to="agent-x">dispatch payload</msg>');
    expect(r.from).toBe('commander');
  });
});

describe('reflection-transcript › extractUserEntries', () => {
  it('keeps role=user text messages where from=user', async () => {
    const { _internals } = await loadModule();
    const entries = _internals.extractUserEntries([
      userMsg('hello', 100, 'user', 'commander'),
      userMsg('dispatched payload', 200, 'commander', 'agent-x'),  // not user
    ]);
    expect(entries.length).toBe(1);
    expect(entries[0].text).toBe('hello');
    expect(entries[0].kind).toBe('user');
  });

  it('skips messages without ts', async () => {
    const { _internals } = await loadModule();
    const entries = _internals.extractUserEntries([
      { role: 'user', content: [{ type: 'text', text: '<msg from="user" to="commander">x</msg>' }] },
    ]);
    expect(entries.length).toBe(0);
  });

  it('drops tool_result content blocks (no false positives)', async () => {
    const { _internals } = await loadModule();
    const entries = _internals.extractUserEntries([
      {
        role: 'user',
        content: [{ type: 'tool_result', toolUseId: 'a', content: 'output', isError: false }],
        ts: 100,
      },
    ]);
    expect(entries.length).toBe(0);
  });
});

describe('reflection-transcript › extractAgentEntries', () => {
  it('keeps role=assistant text only, skipping thinking/tool_use', async () => {
    const { _internals } = await loadModule();
    const entries = _internals.extractAgentEntries([
      {
        role: 'assistant',
        ts: 100,
        content: [
          { type: 'thinking', thinking: 'noise' },
          { type: 'tool_use', name: 'bash', input: {} },
          { type: 'text', text: 'the actual reply' },
        ],
      },
    ]);
    expect(entries.length).toBe(1);
    expect(entries[0].text).toBe('the actual reply');
  });

  it('truncates agent reply to MAX_AGENT_REPLY_CHARS', async () => {
    const mod = await loadModule();
    const long = 'X'.repeat(2000);
    const entries = mod._internals.extractAgentEntries([
      { role: 'assistant', ts: 100, content: [{ type: 'text', text: long }] },
    ]);
    expect(entries.length).toBe(1);
    expect(entries[0].text.length).toBeLessThanOrEqual(mod.MAX_AGENT_REPLY_CHARS + 20);
    expect(entries[0].text).toContain('truncated');
  });

  it('skips messages with only tool_use / thinking (no text)', async () => {
    const { _internals } = await loadModule();
    const entries = _internals.extractAgentEntries([
      { role: 'assistant', ts: 100, content: [{ type: 'tool_use', name: 'bash' }] },
    ]);
    expect(entries.length).toBe(0);
  });
});

// ── renderSignalEntry ───────────────────────────────────────────────────

describe('reflection-transcript › renderSignalEntry', () => {
  it('renders retry with step_index', async () => {
    const { _internals } = await loadModule();
    const e = _internals.renderSignalEntry(sig({ type: 'retry', metadata: { step_index: 3 } }));
    expect(e?.kind).toBe('system');
    expect(e?.text).toContain('retry');
    expect(e?.text).toContain('step #3');
  });

  it('renders form_left_blank distinguishing required field', async () => {
    const { _internals } = await loadModule();
    const required = _internals.renderSignalEntry(sig({
      type: 'form_left_blank',
      metadata: { input_id: 'budget', was_required: true },
    }));
    expect(required?.text).toContain('required field');
    expect(required?.text).toContain('budget');

    const optional = _internals.renderSignalEntry(sig({
      type: 'form_left_blank',
      metadata: { input_id: 'note', was_required: false },
    }));
    expect(optional?.text).not.toContain('required');
  });

  it('returns null for non-system signal types', async () => {
    const { _internals } = await loadModule();
    expect(_internals.renderSignalEntry(sig({ type: 'correction' as any }))).toBeNull();
    expect(_internals.renderSignalEntry(sig({ type: 'tool_failure' as any }))).toBeNull();
  });
});

// ── buildTranscript (I/O) ───────────────────────────────────────────────

describe('reflection-transcript › buildTranscript', () => {
  it('returns empty when no matching conversations exist', async () => {
    const mod = await loadModule();
    const r = await mod.buildTranscript(TEST_UID, '_default', Date.now() - 86400000);
    expect(r.text).toBe('');
    expect(r.stats.convsIncluded).toBe(0);
  });

  it('joins gconv user msgs with gmember agent replies in time order', async () => {
    const { sessionId, gmemberSessionId } = writeConv(TEST_UID, { cid: 'c1', agentId: 'agent-x' });
    writeSessionJsonl(TEST_UID, sessionId, [
      userMsg('first question', 100, 'user', 'commander'),
      userMsg('follow up', 300, 'user', 'commander'),
    ]);
    writeSessionJsonl(TEST_UID, gmemberSessionId, [
      agentMsg('first answer', 200),
      agentMsg('second answer', 400),
    ]);

    const mod = await loadModule();
    const r = await mod.buildTranscript(TEST_UID, 'agent-x', 0);

    expect(r.stats.convsIncluded).toBe(1);
    // Order: 100 user, 200 agent, 300 user, 400 agent
    const i1 = r.text.indexOf('first question');
    const i2 = r.text.indexOf('first answer');
    const i3 = r.text.indexOf('follow up');
    const i4 = r.text.indexOf('second answer');
    expect(i1).toBeGreaterThan(0);
    expect(i1).toBeLessThan(i2);
    expect(i2).toBeLessThan(i3);
    expect(i3).toBeLessThan(i4);
  });

  it('uses gconv assistant for _default agent (no gmember)', async () => {
    const { sessionId } = writeConv(TEST_UID, { cid: 'c-default', agentId: '' });
    writeSessionJsonl(TEST_UID, sessionId, [
      userMsg('q', 100, 'user', 'commander'),
      agentMsg('commander reply (no gmember)', 200),
    ]);
    // Deliberately do NOT write a gmember file.

    const mod = await loadModule();
    const r = await mod.buildTranscript(TEST_UID, '_default', 0);

    expect(r.stats.convsIncluded).toBe(1);
    expect(r.text).toContain('commander reply');
  });

  it('drops conversations whose newest msg predates sinceMs', async () => {
    const { sessionId, gmemberSessionId } = writeConv(TEST_UID, { cid: 'c-old', agentId: 'agent-x' });
    writeSessionJsonl(TEST_UID, sessionId, [
      userMsg('old', 100, 'user', 'commander'),
    ]);
    writeSessionJsonl(TEST_UID, gmemberSessionId, [
      agentMsg('old reply', 200),
    ]);

    const mod = await loadModule();
    const r = await mod.buildTranscript(TEST_UID, 'agent-x', 10_000); // sinceMs > all msg ts

    expect(r.stats.convsIncluded).toBe(0);
  });

  it('caps at MAX_CONVS and drops older convs first', async () => {
    const mod = await loadModule();
    // Create 7 convs all for agent-x
    for (let i = 0; i < 7; i++) {
      const cid = `c${i}`;
      const { sessionId, gmemberSessionId } = writeConv(TEST_UID, { cid, agentId: 'agent-x' });
      const baseTs = 1_000 + i * 1_000;  // ascending by index
      writeSessionJsonl(TEST_UID, sessionId, [userMsg(`q${i}`, baseTs, 'user', 'commander')]);
      writeSessionJsonl(TEST_UID, gmemberSessionId, [agentMsg(`a${i}`, baseTs + 100)]);
    }

    const r = await mod.buildTranscript(TEST_UID, 'agent-x', 0);
    expect(r.stats.convsConsidered).toBe(7);
    expect(r.stats.convsIncluded).toBe(mod.MAX_CONVS);
    expect(r.stats.convsTruncated).toBeGreaterThanOrEqual(2);

    // Should have the most recent 5 (c2..c6), drop c0/c1
    expect(r.text).not.toContain('q0');
    expect(r.text).not.toContain('q1');
    expect(r.text).toContain('q6');
  });

  it('injects retry / skip system events at the right cid + ts', async () => {
    const { sessionId, gmemberSessionId } = writeConv(TEST_UID, { cid: 'c1', agentId: 'agent-x' });
    writeSessionJsonl(TEST_UID, sessionId, [userMsg('q', 100, 'user', 'commander')]);
    writeSessionJsonl(TEST_UID, gmemberSessionId, [agentMsg('a', 200)]);

    const retryTs = new Date(150).toISOString();
    const skipTs = new Date(250).toISOString();
    writeSignalsJsonl(TEST_UID, [
      sig({ type: 'retry', cid: 'c1', aid: 'agent-x', ts: retryTs, metadata: { step_index: 2 } }),
      sig({ type: 'skip',  cid: 'c1', aid: 'agent-x', ts: skipTs,  metadata: { step_index: 3 } }),
      sig({ type: 'correction', cid: 'c1', aid: 'agent-x', ts: retryTs }), // NOT inlined
    ]);

    const mod = await loadModule();
    const r = await mod.buildTranscript(TEST_UID, 'agent-x', 0);

    expect(r.text).toContain('retry on step #2');
    expect(r.text).toContain('skip on step #3');
    // Correction signal must NOT be inlined (deferred to future critic / weekly review).
    expect(r.text).not.toMatch(/system event.*correction/);
    // Time order: q(100) → retry(150) → a(200) → skip(250)
    const iQ = r.text.indexOf('q\n') >= 0 ? r.text.indexOf('q\n') : r.text.indexOf('q');
    const iRetry = r.text.indexOf('retry');
    const iA = r.text.indexOf('a\n') >= 0 ? r.text.indexOf('a\n') : r.text.indexOf(']\na');
    const iSkip = r.text.indexOf('skip');
    expect(iQ).toBeLessThan(iRetry);
    expect(iRetry).toBeLessThan(iA);
    expect(iA).toBeLessThan(iSkip);
  });

  it('filters convs by agent_id (different agent gets nothing)', async () => {
    const a = writeConv(TEST_UID, { cid: 'c1', agentId: 'agent-x' });
    const b = writeConv(TEST_UID, { cid: 'c2', agentId: 'agent-y' });
    writeSessionJsonl(TEST_UID, a.sessionId, [userMsg('for x', 100, 'user', 'commander')]);
    writeSessionJsonl(TEST_UID, a.gmemberSessionId, [agentMsg('x reply', 200)]);
    writeSessionJsonl(TEST_UID, b.sessionId, [userMsg('for y', 300, 'user', 'commander')]);
    writeSessionJsonl(TEST_UID, b.gmemberSessionId, [agentMsg('y reply', 400)]);

    const mod = await loadModule();
    const rx = await mod.buildTranscript(TEST_UID, 'agent-x', 0);
    expect(rx.text).toContain('for x');
    expect(rx.text).not.toContain('for y');

    const ry = await mod.buildTranscript(TEST_UID, 'agent-y', 0);
    expect(ry.text).toContain('for y');
    expect(ry.text).not.toContain('for x');
  });

  it('tolerates missing gmember session file (defensive)', async () => {
    const { sessionId } = writeConv(TEST_UID, { cid: 'c1', agentId: 'agent-x' });
    writeSessionJsonl(TEST_UID, sessionId, [userMsg('lone q', 100, 'user', 'commander')]);
    // No gmember file written — agent never responded yet.

    const mod = await loadModule();
    const r = await mod.buildTranscript(TEST_UID, 'agent-x', 0);

    // Filesystem scan finds no gmember-c1-agent-x.jsonl → conv excluded.
    // (Plan §9.2 fix: ground-truth-based discovery, not conv.agent_id hint.)
    expect(r.stats.convsIncluded).toBe(0);
  });

  it('includes convs where agent was dispatched into another agent\'s conv', async () => {
    // c1 was started by "other-agent" but commander dispatched "target"
    // via plan_set, so gmember-c1-target.jsonl exists even though
    // conv.agent_id === "other-agent".
    const a = writeConv(TEST_UID, { cid: 'c1', agentId: 'other-agent' });
    writeSessionJsonl(TEST_UID, a.sessionId, [
      userMsg('find me a target agent for analysis', 100, 'user', 'commander'),
    ]);
    // Write target's gmember file directly (mimics plan_set dispatch).
    writeSessionJsonl(TEST_UID, 'gmember-c1-target', [
      agentMsg('here is the analysis from target', 200),
    ]);

    const mod = await loadModule();
    const r = await mod.buildTranscript(TEST_UID, 'target', 0);

    expect(r.stats.convsIncluded).toBe(1);
    expect(r.text).toContain('here is the analysis from target');
    // gconv user voice is included regardless of which agent the msg addressed.
    expect(r.text).toContain('find me a target agent');
  });
});

// ── listAgentGmemberFiles (filesystem-driven discovery) ─────────────────

describe('reflection-transcript › listAgentGmemberFiles', () => {
  it('returns empty when sessions directory does not exist', async () => {
    const mod = await loadModule();
    // No conv / session files written → sessions dir may not exist yet.
    expect(mod.listAgentGmemberFiles(TEST_UID, 'whatever')).toEqual([]);
  });

  it('matches gmember-<cid>-<aid>.jsonl by suffix (cid may contain dashes)', async () => {
    writeSessionJsonl(TEST_UID, 'gmember-abc-def-agent-x', [agentMsg('hi', 100)]);
    writeSessionJsonl(TEST_UID, 'gmember-uuid-with-many-dashes-agent-x', [agentMsg('hi', 100)]);
    writeSessionJsonl(TEST_UID, 'gmember-other-agent-y', [agentMsg('hi', 100)]);

    const mod = await loadModule();
    const found = mod.listAgentGmemberFiles(TEST_UID, 'agent-x');
    const cids = found.map((x) => x.cid).sort();
    expect(cids).toEqual(['abc-def', 'uuid-with-many-dashes']);
  });

  it('ignores non-matching files (gconv, ephemeral, etc.)', async () => {
    writeSessionJsonl(TEST_UID, 'gconv-c1', [userMsg('q', 100)]);
    writeSessionJsonl(TEST_UID, 'reflect-abc', [agentMsg('r', 100)]);
    writeSessionJsonl(TEST_UID, 'gmember-c1-target', [agentMsg('a', 100)]);

    const mod = await loadModule();
    const found = mod.listAgentGmemberFiles(TEST_UID, 'target');
    expect(found.length).toBe(1);
    expect(found[0].cid).toBe('c1');
  });

  it('returns empty for empty agentId (defensive)', async () => {
    const mod = await loadModule();
    expect(mod.listAgentGmemberFiles(TEST_UID, '')).toEqual([]);
  });
});
