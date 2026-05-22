import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

let tmpDir: string;
let prevWs: string | undefined;
const TEST_UID = 'chattools';

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-chattools-'));
  prevWs = process.env.ORKAS_WORKSPACE_ROOT;
  process.env.ORKAS_WORKSPACE_ROOT = tmpDir;
  vi.resetModules();
  const users = await import('../../../../src/main/features/users');
  users.activateUser(TEST_UID);
});

afterEach(() => {
  process.env.ORKAS_WORKSPACE_ROOT = prevWs;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function ctxFor(state: Record<string, unknown> = {}) {
  return { state } as unknown as { state: Record<string, unknown> };
}

function writeConversation(cid: string, title: string, messages: unknown[]): void {
  const dir = path.join(tmpDir, TEST_UID, 'cloud', 'chats');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${cid}.jsonl`), messages.map((m) => JSON.stringify(m)).join('\n') + '\n');
  const indexFile = path.join(dir, '_index.json');
  let existing: any[] = [];
  try {
    const parsed = JSON.parse(fs.readFileSync(indexFile, 'utf8'));
    existing = Array.isArray(parsed) ? parsed : [];
  } catch { /* first conversation */ }
  const next = existing.filter((c) => c?.conversation_id !== cid);
  next.push({
    conversation_id: cid,
    title,
    kind: 'normal',
    agent_id: '',
    skill_id: '',
    session_id: `gconv-${cid}`,
    created_at: '2026-01-01T00:00:00',
    updated_at: '2026-01-01T00:00:00',
  });
  fs.writeFileSync(indexFile, JSON.stringify(next));
}

function firstHitCid(content: string): string {
  const match = content.match(/- cid=([^ ]+)/);
  return match ? match[1] : '';
}

describe('chat-history-tools › chat_search', () => {
  it('finds current group-chat message text and returns cid/msg metadata', async () => {
    writeConversation('cgroup', 'Planning chat', [
      { id: 'm0', ts: '2026-01-01T00:00:00Z', from: 'user', to: ['commander'], mentions: [], text: 'remember the nebula migration decision' },
    ]);
    const { createChatHistoryTools } = await import('../../../../src/main/model/core-agent/chat-history-tools');
    const [chatSearch] = createChatHistoryTools({ userId: TEST_UID });
    const result = await chatSearch.execute({ query: 'nebula', k: 3 }, ctxFor());
    expect(result.isError).toBeFalsy();
    expect(result.content).toMatch(/cid=cgroup/);
    expect(result.content).toMatch(/msg=0/);
    expect(result.content).toMatch(/Planning chat/);
    expect(result.content).toMatch(/nebula migration/);
  });

  it('rejects empty query', async () => {
    const { createChatHistoryTools } = await import('../../../../src/main/model/core-agent/chat-history-tools');
    const [chatSearch] = createChatHistoryTools({ userId: TEST_UID });
    const result = await chatSearch.execute({ query: '   ' }, ctxFor());
    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/required/);
  });

  it('prefers the current conversation when relevance ties', async () => {
    writeConversation('cold', 'Older current chat', [
      { id: 'm0', ts: '2026-01-01T00:00:00Z', from: 'user', to: ['commander'], mentions: [], text: 'priorityword same body' },
    ]);
    writeConversation('hot', 'Newer other chat', [
      { id: 'm0', ts: '2026-02-01T00:00:00Z', from: 'user', to: ['commander'], mentions: [], text: 'priorityword same body' },
    ]);
    const { createChatHistoryTools } = await import('../../../../src/main/model/core-agent/chat-history-tools');
    const [chatSearch] = createChatHistoryTools({ userId: TEST_UID, currentCid: 'cold' });
    const result = await chatSearch.execute({ query: 'priorityword', k: 2 }, ctxFor());
    expect(result.isError).toBeFalsy();
    expect(firstHitCid(result.content)).toBe('cold');
    expect(result.content).toMatch(/cid=cold .*current=true/);
  });

  it('prefers the current conversation when relevance is within 0.1', async () => {
    const { rankChatHitsForTest } = await import('../../../../src/main/model/core-agent/chat-history-tools');
    const ranked = rankChatHitsForTest([
      { kind: 'chat', cid: 'other', msg_index: 0, conv_title: 'Other', role: 'user', time: '2026-02-01T00:00:00Z', snippet: 'slightly higher', score: 1.05 },
      { kind: 'chat', cid: 'current', msg_index: 0, conv_title: 'Current', role: 'user', time: '2026-01-01T00:00:00Z', snippet: 'slightly lower', score: 1.0 },
    ], 'current');
    expect(ranked[0].cid).toBe('current');
  });

  it('uses recency as the tie-breaker after relevance and current conversation', async () => {
    writeConversation('old', 'Old chat', [
      { id: 'm0', ts: '2026-01-01T00:00:00Z', from: 'user', to: ['commander'], mentions: [], text: 'recencyword same body' },
    ]);
    writeConversation('new', 'New chat', [
      { id: 'm0', ts: '2026-02-01T00:00:00Z', from: 'user', to: ['commander'], mentions: [], text: 'recencyword same body' },
    ]);
    const { createChatHistoryTools } = await import('../../../../src/main/model/core-agent/chat-history-tools');
    const [chatSearch] = createChatHistoryTools({ userId: TEST_UID });
    const result = await chatSearch.execute({ query: 'recencyword', k: 2 }, ctxFor());
    expect(result.isError).toBeFalsy();
    expect(firstHitCid(result.content)).toBe('new');
  });
});

describe('chat-history-tools › chat_read', () => {
  it('returns a window around the requested message index', async () => {
    writeConversation('cread', 'Read chat', [
      { id: 'm0', ts: '2026-01-01T00:00:00Z', from: 'user', to: ['commander'], mentions: [], text: 'first note' },
      { id: 'm1', ts: '2026-01-01T00:01:00Z', from: 'commander', to: ['user'], mentions: [], text: 'middle answer' },
      { id: 'm2', ts: '2026-01-01T00:02:00Z', from: 'user', to: ['commander'], mentions: [], text: 'last followup' },
    ]);
    const { createChatHistoryTools } = await import('../../../../src/main/model/core-agent/chat-history-tools');
    const [, chatRead] = createChatHistoryTools({ userId: TEST_UID });
    const result = await chatRead.execute({ cid: 'cread', msg_index: 1, window: 1 }, ctxFor());
    expect(result.isError).toBeFalsy();
    expect(result.content).toMatch(/<chat-history cid="cread"/);
    expect(result.content).toMatch(/msgs 0\.\.2 \(hit=1\)/);
    expect(result.content).toMatch(/first note/);
    expect(result.content).toMatch(/middle answer/);
    expect(result.content).toMatch(/last followup/);
  });

  it('returns latest messages when msg_index is omitted', async () => {
    writeConversation('clatest', 'Latest chat', [
      { id: 'm0', ts: '2026-01-01T00:00:00Z', from: 'user', to: ['commander'], mentions: [], text: 'old' },
      { id: 'm1', ts: '2026-01-01T00:01:00Z', from: 'commander', to: ['user'], mentions: [], text: 'newer' },
    ]);
    const { createChatHistoryTools } = await import('../../../../src/main/model/core-agent/chat-history-tools');
    const [, chatRead] = createChatHistoryTools({ userId: TEST_UID });
    const result = await chatRead.execute({ cid: 'clatest', limit: 1 }, ctxFor());
    expect(result.isError).toBeFalsy();
    expect(result.content).not.toMatch(/old/);
    expect(result.content).toMatch(/newer/);
  });

  it('rejects unsafe conversation ids', async () => {
    const { createChatHistoryTools } = await import('../../../../src/main/model/core-agent/chat-history-tools');
    const [, chatRead] = createChatHistoryTools({ userId: TEST_UID });
    const result = await chatRead.execute({ cid: '../nope' }, ctxFor());
    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/valid `cid`/);
  });

  it('rejects out-of-range message indexes', async () => {
    writeConversation('crange', 'Range chat', [
      { id: 'm0', ts: '2026-01-01T00:00:00Z', from: 'user', to: ['commander'], mentions: [], text: 'only message' },
    ]);
    const { createChatHistoryTools } = await import('../../../../src/main/model/core-agent/chat-history-tools');
    const [, chatRead] = createChatHistoryTools({ userId: TEST_UID });
    const result = await chatRead.execute({ cid: 'crange', msg_index: 4 }, ctxFor());
    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/out of range/);
  });
});

describe('chat-history-tools › shape', () => {
  it('createChatHistoryTools returns search + read tools', async () => {
    const { createChatHistoryTools } = await import('../../../../src/main/model/core-agent/chat-history-tools');
    const tools = createChatHistoryTools({ userId: TEST_UID });
    expect(tools.map((t) => t.name)).toEqual(['chat_search', 'chat_read']);
  });
});
