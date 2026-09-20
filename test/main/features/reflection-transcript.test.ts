import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

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

  it('uses the conservative 1.5 token/char capacity unit', async () => {
    const mod = await loadModule();
    // Four CJK characters consume six estimated capacity tokens.
    expect(mod.estimateTokens('你好世界')).toBe(6);
  });

  it('handles mixed Chinese / English correctly', async () => {
    const mod = await loadModule();
    // Six ASCII characters / 4 + two CJK characters * 1.5 = 4.5 → 5.
    expect(mod.estimateTokens('hello 世界')).toBe(5);
  });

  it('returns 0 for empty string', async () => {
    const mod = await loadModule();
    expect(mod.estimateTokens('')).toBe(0);
  });

  it('charges CJK punctuation at the CJK rate, not the Latin one', async () => {
    const mod = await loadModule();
    // 。、「」 are as common as the ideographs around them in real Chinese
    // text; the previous local classifier missed that range and billed them
    // at 4-chars-per-token, under-counting every Chinese transcript.
    expect(mod.estimateTokens('。、「」')).toBe(mod.estimateTokens('你好世界'));
  });

  it('uses the same unit as the context budget', async () => {
    const mod = await loadModule();
    const { estimateToolResultTokens } = await import('../../../src/main/util/tool-result-cap');
    const chinese = '这是一段用于反思的中文记录。';
    expect(mod.estimateTokens(chinese)).toBe(estimateToolResultTokens(chinese));
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

  it('preserves complete agent replies beyond 800 characters', async () => {
    const mod = await loadModule();
    const long = 'X'.repeat(2000);
    const entries = mod._internals.extractAgentEntries([
      { role: 'assistant', ts: 100, content: [{ type: 'text', text: long }] },
    ]);
    expect(entries.length).toBe(1);
    expect(entries[0].text).toBe(long);
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
  it('renders silence as a system entry', async () => {
    const { _internals } = await loadModule();
    const e = _internals.renderSignalEntry(sig({ type: 'silence' }));
    expect(e?.kind).toBe('system');
    expect(e?.text).toContain('no user response');
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

  it('flags an unreadable source instead of reporting an empty window', async () => {
    // An empty transcript drives a terminal decision upstream (the window is
    // consumed and the baseline advances), so a failed read must be
    // distinguishable from a genuinely quiet window — otherwise one bad read
    // silently discards whatever activity it was hiding.
    vi.doMock('../../../src/main/features/chats', () => ({
      listConversations: async () => { throw new Error('index unreadable'); },
    }));
    const mod = await loadModule();
    const r = await mod.buildTranscript(TEST_UID, '_default', 0);

    expect(r.text).toBe('');
    expect(r.unavailable).toBe(true);
    vi.doUnmock('../../../src/main/features/chats');
  });

  it('reports a genuinely quiet window as available and empty', async () => {
    const mod = await loadModule();
    const r = await mod.buildTranscript(TEST_UID, '_default', Date.now() - 86400000);

    expect(r.text).toBe('');
    expect(r.unavailable).toBeUndefined();
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

  it('injects whitelisted system events at the right cid + ts', async () => {
    const { sessionId, gmemberSessionId } = writeConv(TEST_UID, { cid: 'c1', agentId: 'agent-x' });
    writeSessionJsonl(TEST_UID, sessionId, [userMsg('q', 100, 'user', 'commander')]);
    writeSessionJsonl(TEST_UID, gmemberSessionId, [agentMsg('a', 200)]);

    const blankTs = new Date(150).toISOString();
    const silenceTs = new Date(250).toISOString();
    writeSignalsJsonl(TEST_UID, [
      sig({ type: 'form_left_blank', cid: 'c1', aid: 'agent-x', ts: blankTs, metadata: { input_id: 'budget', was_required: true } }),
      sig({ type: 'silence', cid: 'c1', aid: 'agent-x', ts: silenceTs }),
      sig({ type: 'correction', cid: 'c1', aid: 'agent-x', ts: blankTs }), // NOT inlined
    ]);

    const mod = await loadModule();
    const r = await mod.buildTranscript(TEST_UID, 'agent-x', 0);

    expect(r.text).toContain('required field "budget" blank');
    expect(r.text).toContain('no user response');
    // Correction signal must NOT be inlined (deferred to future critic / weekly review).
    expect(r.text).not.toMatch(/system event.*correction/);
    // Time order: q(100) → form_left_blank(150) → a(200) → silence(250)
    const iQ = r.text.indexOf('q\n') >= 0 ? r.text.indexOf('q\n') : r.text.indexOf('q');
    const iBlank = r.text.indexOf('blank');
    const iA = r.text.indexOf('a\n') >= 0 ? r.text.indexOf('a\n') : r.text.indexOf(']\na');
    const iSilence = r.text.indexOf('no user response');
    expect(iQ).toBeLessThan(iBlank);
    expect(iBlank).toBeLessThan(iA);
    expect(iA).toBeLessThan(iSilence);
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


describe('reflection evidence budget and complete conversation', () => {
  const section = (id: string, created: number, messages: Array<[number, string]>) => ({
    conv: { conversation_id: id, title: id, created_at: new Date(created).toISOString() } as any,
    entries: messages.map(([ts, text]) => ({ ts, text, kind: 'user' as const })),
  });

  it('removes oldest messages from the oldest task, even if its last activity is newest', async () => {
    const { _internals, estimateTokens } = await loadModule();
    const result = _internals.fitTranscript([
      section('new-task', 200, [[210, 'new task message']]),
      section('old-task', 100, [[110, 'FIRST ' + 'x'.repeat(1000)], [900, 'old task latest message']]),
    ], 2, 'agent-x', 0, 180);
    expect(result.text).not.toContain('FIRST');
    expect(result.text).toContain('old task latest message');
    expect(result.text).toContain('new task message');
    expect(result.text.indexOf('old task latest')).toBeLessThan(result.text.indexOf('new task message'));
    expect(result.text).toContain('Earlier messages omitted');
    expect(estimateTokens(result.text)).toBeLessThanOrEqual(180);
    expect(result.stats.convsIncluded).toBe(2);
  });

  it('continues to the next task only after exhausting messages in the oldest task', async () => {
    const { _internals } = await loadModule();
    const result = _internals.fitTranscript([
      section('old', 100, [[101, 'old ' + 'x'.repeat(1000)], [102, 'old tail ' + 'x'.repeat(1000)]]),
      section('new', 200, [[201, 'new first ' + 'x'.repeat(1000)], [202, 'new tail']]),
    ], 2, '_default', 0, 150);
    expect(result.text).not.toContain('old tail');
    expect(result.text).not.toContain('new first');
    expect(result.text).toContain('new tail');
    expect(result.stats.convsIncluded).toBe(1);
  });

  it('preserves a whole answer even when its question was removed; no protected first interaction', async () => {
    const { _internals } = await loadModule();
    const task = section('task', 100, [[101, 'question ' + 'x'.repeat(2000)], [102, 'answer']]);
    task.entries[1].kind = 'agent' as any;
    const result = _internals.fitTranscript([task], 1, '_default', 0, 160);
    expect(result.text).not.toContain('question');
    expect(result.text).toContain('answer');
  });

  it.each([0, 100, Number.NaN])('does not emit an oversized last message with budget %s', async (budget) => {
    const { _internals } = await loadModule();
    const result = _internals.fitTranscript([section('task', 100, [[101, 'x'.repeat(10000)]])], 1, '_default', 0, budget);
    expect(result.text).toBe('');
    expect(result.capacityExceeded).toBe(true);
    expect(result.stats.convsConsidered).toBe(1);
  });

  it('enforces the fixed 150K ceiling across all tasks, including CJK and annotation costs', async () => {
    const { _internals, estimateTokens } = await loadModule();
    const sections = Array.from({ length: 5 }, (_, i) => section(`task-${i}`, 100 + i,
      [[200 + i * 2, `FIRST-${i} ` + '中'.repeat(21000)], [201 + i * 2, `LAST-${i} ` + 'x'.repeat(12000)]]));
    const result = _internals.fitTranscript(sections, 5, '_default', 0, 999999);
    expect(result.text).not.toContain('FIRST-0');
    expect(result.text).toContain('LAST-0');
    expect(result.text).toContain('FIRST-1');
    expect(result.text).toContain('LAST-4');
    expect(estimateTokens(result.text)).toBeLessThanOrEqual(150000);
    expect(result.stats.convsIncluded).toBe(5);
  });

  it('keeps every complete message and omits no content when exactly within budget', async () => {
    const { _internals, estimateTokens } = await loadModule();
    const make = () => [section('task', 100, [[101, 'full answer ' + 'x'.repeat(4000)]])];
    const first = _internals.fitTranscript(make(), 1, '_default', 0, 10000);
    const exact = _internals.fitTranscript(make(), 1, '_default', 0, estimateTokens(first.text));
    expect(exact.text).toBe(first.text);
    expect(exact.text).not.toContain('omitted');
  });

  it('includes all legacy actors and pre-window messages without truncating their replies', async () => {
    const { sessionId, gmemberSessionId } = writeConv(TEST_UID, { cid: 'legacy-all', agentId: 'agent-x' });
    writeSessionJsonl(TEST_UID, sessionId, [userMsg('initial requirement', 100), agentMsg('commander reply', 200)]);
    writeSessionJsonl(TEST_UID, gmemberSessionId, [agentMsg('agent x reply', 400)]);
    writeSessionJsonl(TEST_UID, 'gmember-legacy-all-agent-y', [agentMsg('Y'.repeat(2000), 300)]);
    const result = await (await loadModule()).buildTranscript(TEST_UID, 'agent-x', 350);
    expect(result.text).toContain('initial requirement');
    expect(result.text).toContain('commander reply');
    expect(result.text).toContain('agent-y]');
    expect(result.text).toContain('Y'.repeat(2000));
    expect(result.text).toContain('agent x reply');
  });

  it('does not revive deleted canonical dialogue from an old member session', async () => {
    const { gmemberSessionId } = writeConv(TEST_UID, { cid: 'deleted', agentId: 'agent-x' });
    writeSessionJsonl(TEST_UID, gmemberSessionId, [agentMsg('MUST STAY DELETED', 300)]);
    const { conversationMessageReadFile } = await import('../../../src/main/util/project-layout');
    const file = conversationMessageReadFile(TEST_UID, 'deleted');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ id: 'gone', ts: new Date(300).toISOString(), from: 'agent-x', to: ['user'],
      text: '', deleted_at: new Date(400).toISOString() }) + '\n');
    const result = await (await loadModule()).buildTranscript(TEST_UID, 'agent-x', 200);
    expect(result.text).toBe('');
    expect(result.capacityExceeded).toBeUndefined();
  });

  it('reads full canonical dialogue before the activity window, including every actor, without private process', async () => {
    const { gmemberSessionId } = writeConv(TEST_UID, { cid: 'full', agentId: 'agent-x' });
    writeSessionJsonl(TEST_UID, gmemberSessionId, [agentMsg('STALE PRIVATE COPY', 300)]);
    const { conversationMessageReadFile } = await import('../../../src/main/util/project-layout');
    const file = conversationMessageReadFile(TEST_UID, 'full');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const records = [
      { id: 'a', ts: new Date(100).toISOString(), from: 'user', to: ['commander'], text: 'original request' },
      { id: 'b', ts: new Date(200).toISOString(), from: 'agent-y', to: ['user'], text: 'other agent ' + 'Y'.repeat(2000),
        process: [{ type: 'event', event: { stream: 'thinking', data: { text: 'PRIVATE THOUGHT' } } }] },
      { id: 'c', ts: new Date(300).toISOString(), from: 'agent-x', to: ['user'], text: 'current reply' },
      { id: 'd', ts: new Date(400).toISOString(), from: 'user', to: ['commander'], text: 'DELETED', deleted_at: new Date().toISOString() },
    ];
    fs.writeFileSync(file, records.map((row) => JSON.stringify(row)).join('\n') + '\n');
    const mod = await loadModule();
    const result = await mod.buildTranscript(TEST_UID, 'agent-x', 250);
    expect(result.text).toContain('original request');
    expect(result.text).toContain('agent-y]');
    expect(result.text).toContain('Y'.repeat(2000));
    expect(result.text).toContain('agent-x]');
    expect(result.text).not.toMatch(/PRIVATE|DELETED/);
    expect(fs.readFileSync(file, 'utf8')).toContain('DELETED');
    const trimmed = await mod.buildTranscript(TEST_UID, 'agent-x', 250, 180);
    expect(trimmed.text).not.toContain('original request');
    expect(trimmed.text).not.toContain('other agent');
    expect(trimmed.text).toContain('current reply');
  });
});
