import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// Mock the model client so the autoTitle integration test below can
// exercise `groupChat.send` (which spawns a commander worker that
// would otherwise try to do a real LLM call against pi-ai). Returns
// a stub stream that yields `final ''` + `done` immediately, which
// the bus interprets as "done with no reply".
vi.mock('../../../src/main/model/client', () => ({
  async *streamChatWithModel(_opts: any) {
    yield { type: 'final', text: '' };
    yield { type: 'done' };
  },
  async chatWithModel() { return { ok: true, text: '', error: '', aborted: false }; },
}));

// chats.ts is a thin CRUD wrapper now (group_chat owns the send paths).
// These tests exercise create / list / delete / cascade cleanup AND
// the auto-title hook in `groupChat.send`.

let tmpDir: string;
let prevWs: string | undefined;
const TEST_UID = 'u1';

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-chats-'));
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

async function loadChats() {
  return import('../../../src/main/features/chats');
}

describe('chats › createConversation', () => {
  it('generates a 12-hex cid and writes it to _index.json', async () => {
    const chats = await loadChats();
    const conv = await chats.createConversation(TEST_UID, { title: 't1' });
    expect(conv.conversation_id).toMatch(/^[0-9a-f]{12}$/);
    expect(conv.session_id).toBe(`${TEST_UID}-gconv-${conv.conversation_id}`);
    const idx = JSON.parse(fs.readFileSync(
      path.join(tmpDir, TEST_UID, 'cloud', 'chats', '_index.json'), 'utf-8'));
    expect(idx[0].conversation_id).toBe(conv.conversation_id);
    expect(idx[0].title).toBe('t1');
  });

  it('touches the per-cid jsonl on create', async () => {
    const chats = await loadChats();
    const conv = await chats.createConversation(TEST_UID);
    expect(fs.existsSync(path.join(tmpDir, TEST_UID, 'cloud', 'chats', `${conv.conversation_id}.jsonl`)))
      .toBe(true);
  });
});

describe('chats › deleteConversation', () => {
  it('removes the conv from index + drops <cid>.jsonl + group dir', async () => {
    const chats = await loadChats();
    const conv = await chats.createConversation(TEST_UID);
    const groupDir = path.join(tmpDir, TEST_UID, 'cloud', 'chats', conv.conversation_id);
    fs.mkdirSync(path.join(groupDir, 'visibility'), { recursive: true });
    fs.writeFileSync(path.join(groupDir, 'members.json'), '{"version":1,"actors":[]}');

    const ok = await chats.deleteConversation(TEST_UID, conv.conversation_id);
    expect(ok).toBe(true);

    const idx = JSON.parse(fs.readFileSync(
      path.join(tmpDir, TEST_UID, 'cloud', 'chats', '_index.json'), 'utf-8'));
    expect(idx).toEqual([]);
    expect(fs.existsSync(path.join(tmpDir, TEST_UID, 'cloud', 'chats', `${conv.conversation_id}.jsonl`)))
      .toBe(false);
    expect(fs.existsSync(groupDir)).toBe(false);
  });
});

describe('chats › autoTitle on first send', () => {
  it('groupChat.send updates 新对话 title to message text on first user msg', async () => {
    vi.resetModules();
    const groupChat = await import('../../../src/main/features/group_chat');
    const chats = await loadChats();
    const conv = await chats.createConversation(TEST_UID, { title: '新对话' });
    expect(conv.title).toBe('新对话');

    const res = await groupChat.send({
      userId: TEST_UID, cid: conv.conversation_id, text: '这是用户的第一条消息',
    });
    expect(res.ok).toBe(true);

    const after = await chats.getConversation(TEST_UID, conv.conversation_id);
    expect(after?.title).toBe('这是用户的第一条消息');
    // Cleanup so the worker doesn't leak; chat send fires a commander
    // worker that tries to do an LLM call (no model configured here →
    // turn errors immediately, but the worker is still spawned).
    const { dropConv } = await import('../../../src/main/features/group_chat/bus');
    dropConv(TEST_UID, conv.conversation_id);
  });

  it('does NOT overwrite an existing user-set title', async () => {
    vi.resetModules();
    const groupChat = await import('../../../src/main/features/group_chat');
    const chats = await loadChats();
    const conv = await chats.createConversation(TEST_UID, { title: '我的项目' });

    await groupChat.send({
      userId: TEST_UID, cid: conv.conversation_id, text: '随便写点啥',
    });
    const after = await chats.getConversation(TEST_UID, conv.conversation_id);
    expect(after?.title).toBe('我的项目'); // unchanged

    const { dropConv } = await import('../../../src/main/features/group_chat/bus');
    dropConv(TEST_UID, conv.conversation_id);
  });
});

describe('chats › sweepStaleProcessing', () => {
  it('flips running state.json back to idle on boot', async () => {
    const chats = await loadChats();
    const conv = await chats.createConversation(TEST_UID);
    const stateFile = path.join(tmpDir, TEST_UID, 'cloud', 'chats', conv.conversation_id, 'state.json');
    fs.mkdirSync(path.dirname(stateFile), { recursive: true });
    fs.writeFileSync(stateFile, JSON.stringify({
      version: 1, status: 'running', last_active_at: new Date().toISOString(), in_flight: ['commander'],
    }));

    const res = await chats.sweepStaleProcessing();
    expect(res.swept).toBe(1);
    const after = JSON.parse(fs.readFileSync(stateFile, 'utf-8'));
    expect(after.status).toBe('idle');
  });
});
