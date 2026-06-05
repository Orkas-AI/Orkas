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
    expect(conv.session_id).toBe(`gconv-${conv.conversation_id}`);
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

  it('caps the initial title by display width', async () => {
    const chats = await loadChats();
    const english = await chats.createConversation(TEST_UID, { title: 'a'.repeat(70) });
    const chinese = await chats.createConversation(TEST_UID, { title: '长'.repeat(40) });

    expect(english.title).toBe('a'.repeat(60));
    expect(chinese.title).toBe('长'.repeat(30));
  });

  // Project membership wiring (added with the projects feature). The field
  // is persisted on the conv record only — `<cid>.jsonl` / session_id /
  // groupChatDir paths are unchanged (CLAUDE.md §5 invariant). When a
  // projectId is omitted the record must NOT carry a stale empty string.
  it('persists project_id when supplied; omits the field when absent', async () => {
    const chats = await loadChats();
    const c1 = await chats.createConversation(TEST_UID, { projectId: 'p_aabbccdd' });
    expect(c1.project_id).toBe('p_aabbccdd');
    // session_id MUST stay independent of project_id.
    expect(c1.session_id).toBe(`gconv-${c1.conversation_id}`);
    const c2 = await chats.createConversation(TEST_UID);
    expect(c2.project_id).toBeUndefined();

    const idx = JSON.parse(fs.readFileSync(
      path.join(tmpDir, TEST_UID, 'cloud', 'chats', '_index.json'), 'utf-8'));
    const persistedC1 = idx.find((c: any) => c.conversation_id === c1.conversation_id);
    const persistedC2 = idx.find((c: any) => c.conversation_id === c2.conversation_id);
    expect(persistedC1.project_id).toBe('p_aabbccdd');
    expect(persistedC2.project_id).toBeUndefined();

    const meta = JSON.parse(fs.readFileSync(
      path.join(tmpDir, TEST_UID, 'cloud', 'chats', c1.conversation_id, 'meta.json'), 'utf-8'));
    expect(meta.conversation_id).toBe(c1.conversation_id);
    expect(meta.project_id).toBe('p_aabbccdd');
  });
});

describe('chats › setConversationPinned', () => {
  it('pins a conversation above newer unpinned rows without changing activity time', async () => {
    const chats = await loadChats();
    const older = await chats.createConversation(TEST_UID, { title: 'older' });
    const newer = await chats.createConversation(TEST_UID, { title: 'newer' });
    const before = await chats.getConversation(TEST_UID, older.conversation_id);

    const pinned = await chats.setConversationPinned(TEST_UID, older.conversation_id, true);
    expect(pinned?.pinned_at).toBeTruthy();
    expect(pinned?.updated_at).toBe(before?.updated_at);

    const listed = await chats.listConversations(TEST_UID);
    expect(listed.map((c) => c.conversation_id)).toEqual([
      older.conversation_id,
      newer.conversation_id,
    ]);
  });

  it('unpins a conversation and removes pinned_at from the persisted index', async () => {
    const chats = await loadChats();
    const conv = await chats.createConversation(TEST_UID, { title: 'pin me' });
    await chats.setConversationPinned(TEST_UID, conv.conversation_id, true);

    const unpinned = await chats.setConversationPinned(TEST_UID, conv.conversation_id, false);
    expect(unpinned?.pinned_at).toBeUndefined();

    const idx = JSON.parse(fs.readFileSync(
      path.join(tmpDir, TEST_UID, 'cloud', 'chats', '_index.json'), 'utf-8'));
    expect(idx[0].pinned_at).toBeUndefined();
  });
});

describe('chats › renameConversation', () => {
  it('trims and caps the final submitted title', async () => {
    const chats = await loadChats();
    const conv = await chats.createConversation(TEST_UID, { title: 'old' });
    const raw = `  ${'长'.repeat(90)}  `;

    const renamed = await chats.renameConversation(TEST_UID, conv.conversation_id, raw);

    expect(renamed?.title).toBe('长'.repeat(30));
    expect(renamed?.title_manually_set).toBe(true);
  });
});

describe('chats › index repair', () => {
  it('ignores chat subdirectories without a real meta.json instead of replacing index rows with defaults', async () => {
    const cid = 'abc123def456';
    const orphanCid = 'aa73494e9212';
    const chatsDir = path.join(tmpDir, TEST_UID, 'cloud', 'chats');
    fs.mkdirSync(path.join(chatsDir, cid), { recursive: true });
    fs.writeFileSync(path.join(chatsDir, cid, 'members.json'), '{"version":1,"actors":[]}');
    fs.mkdirSync(path.join(chatsDir, orphanCid), { recursive: true });
    fs.writeFileSync(path.join(chatsDir, orphanCid, 'members.json'), '{"version":1,"actors":[]}');
    for (const reserved of ['agent', 'skill', 'subagents']) {
      fs.mkdirSync(path.join(chatsDir, reserved), { recursive: true });
    }
    fs.writeFileSync(path.join(chatsDir, `${cid}.jsonl`), '');
    fs.writeFileSync(path.join(chatsDir, '_index.json'), JSON.stringify([
      {
        conversation_id: cid,
        title: '真实标题',
        kind: 'normal',
        agent_id: '',
        skill_id: '',
        session_id: `gconv-${cid}`,
        project_id: 'p_project1',
        created_at: '2026-05-28T01:02:03.000Z',
        updated_at: '2026-05-28T01:02:03.000Z',
      },
    ], null, 2));

    const chats = await loadChats();
    const listed = await chats.listConversations(TEST_UID);

    expect(listed).toHaveLength(1);
    expect(listed[0].conversation_id).toBe(cid);
    expect(listed[0].title).toBe('真实标题');
    expect(listed[0].project_id).toBe('p_project1');
  });

  it('uses per-conversation meta to recover project membership when _index.json lost the row', async () => {
    const cid = 'abc123def456';
    const chatsDir = path.join(tmpDir, TEST_UID, 'cloud', 'chats');
    fs.mkdirSync(path.join(chatsDir, cid), { recursive: true });
    fs.writeFileSync(path.join(chatsDir, `${cid}.jsonl`), `${JSON.stringify({
      id: 'm1',
      ts: '2026-05-28T01:02:03.000Z',
      from: 'user',
      to: ['commander'],
      text: '项目任务内容',
    })}\n`);
    fs.writeFileSync(path.join(chatsDir, cid, 'meta.json'), JSON.stringify({
      conversation_id: cid,
      title: '项目任务',
      kind: 'normal',
      agent_id: '',
      skill_id: '',
      session_id: `gconv-${cid}`,
      project_id: 'p_project1',
      created_at: '2026-05-28T01:02:03.000Z',
      updated_at: '2026-05-28T01:02:03.000Z',
    }, null, 2));
    fs.writeFileSync(path.join(chatsDir, '_index.json'), '[]');

    const chats = await loadChats();
    const listed = await chats.listConversations(TEST_UID);
    const repaired = listed.find((c) => c.conversation_id === cid);

    expect(repaired?.title).toBe('项目任务');
    expect(repaired?.project_id).toBe('p_project1');
    expect(repaired?.session_id).toBe(`gconv-${cid}`);
  });

  it('recovers a synced top-level jsonl that is missing from _index.json', async () => {
    const cid = 'abc123def456';
    const chatsDir = path.join(tmpDir, TEST_UID, 'cloud', 'chats');
    fs.mkdirSync(chatsDir, { recursive: true });
    fs.writeFileSync(path.join(chatsDir, `${cid}.jsonl`), `${JSON.stringify({
      id: 'm1',
      ts: '2026-05-28T01:02:03.000Z',
      from: 'user',
      to: ['commander'],
      text: '同步过来的任务内容',
    })}\n`);

    const chats = await loadChats();
    const listed = await chats.listConversations(TEST_UID);
    const repaired = listed.find((c) => c.conversation_id === cid);

    expect(repaired?.title).toBe('同步过来的任务内容');
    expect(repaired?.session_id).toBe(`gconv-${cid}`);
    const idx = JSON.parse(fs.readFileSync(path.join(chatsDir, '_index.json'), 'utf-8'));
    expect(idx.some((c: any) => c.conversation_id === cid)).toBe(true);
  });

  it('does not let stale meta resurrect a newer index tombstone', async () => {
    const cid = 'abc123def456';
    const chatsDir = path.join(tmpDir, TEST_UID, 'cloud', 'chats');
    fs.mkdirSync(path.join(chatsDir, cid), { recursive: true });
    fs.writeFileSync(path.join(chatsDir, '_index.json'), JSON.stringify([
      {
        conversation_id: cid,
        title: 'deleted task',
        kind: 'normal',
        agent_id: '',
        skill_id: '',
        session_id: `gconv-${cid}`,
        project_id: 'p_project1',
        created_at: '2026-05-28T01:02:03.000Z',
        updated_at: '2026-05-29T01:02:03.000Z',
        deleted_at: '2026-05-29T01:02:03.000Z',
      },
    ], null, 2));
    fs.writeFileSync(path.join(chatsDir, cid, 'meta.json'), JSON.stringify({
      conversation_id: cid,
      title: 'old active task',
      kind: 'normal',
      agent_id: '',
      skill_id: '',
      session_id: `gconv-${cid}`,
      project_id: 'p_project1',
      created_at: '2026-05-28T01:02:03.000Z',
      updated_at: '2026-05-28T01:02:03.000Z',
    }, null, 2));

    const chats = await loadChats();
    expect(await chats.listConversations(TEST_UID)).toEqual([]);
    expect(fs.existsSync(path.join(chatsDir, cid, 'meta.json'))).toBe(false);
  });

  it('prunes expired tombstones during list repair', async () => {
    const cid = 'abc123def456';
    const chatsDir = path.join(tmpDir, TEST_UID, 'cloud', 'chats');
    fs.mkdirSync(path.join(chatsDir, cid), { recursive: true });
    fs.writeFileSync(path.join(chatsDir, cid, 'meta.json'), JSON.stringify({ conversation_id: cid }));
    const jsonl = path.join(chatsDir, `${cid}.jsonl`);
    fs.writeFileSync(jsonl, '');
    const oldDate = new Date('2000-01-01T00:00:00Z');
    fs.utimesSync(jsonl, oldDate, oldDate);
    fs.writeFileSync(path.join(chatsDir, '_index.json'), JSON.stringify([
      {
        conversation_id: cid,
        title: 'old deleted',
        kind: 'normal',
        agent_id: '',
        skill_id: '',
        session_id: `gconv-${cid}`,
        created_at: '2000-01-01T00:00:00Z',
        updated_at: '2000-01-01T00:00:00Z',
        deleted_at: '2000-01-01T00:00:00Z',
      },
    ], null, 2));

    const chats = await loadChats();
    expect(await chats.listConversations(TEST_UID)).toEqual([]);
    const idx = JSON.parse(fs.readFileSync(path.join(chatsDir, '_index.json'), 'utf-8'));
    expect(idx).toEqual([]);
    expect(fs.existsSync(path.join(chatsDir, cid, 'meta.json'))).toBe(false);
    expect(fs.existsSync(jsonl)).toBe(false);
  });
});

describe('chats › deleteConversation', () => {
  it('tombstones the conv in index + drops <cid>.jsonl + group dir', async () => {
    const chats = await loadChats();
    const conv = await chats.createConversation(TEST_UID);
    const groupDir = path.join(tmpDir, TEST_UID, 'cloud', 'chats', conv.conversation_id);
    fs.mkdirSync(path.join(groupDir, 'visibility'), { recursive: true });
    fs.writeFileSync(path.join(groupDir, 'members.json'), '{"version":1,"actors":[]}');

    const ok = await chats.deleteConversation(TEST_UID, conv.conversation_id);
    expect(ok).toBe(true);

    const idx = JSON.parse(fs.readFileSync(
      path.join(tmpDir, TEST_UID, 'cloud', 'chats', '_index.json'), 'utf-8'));
    expect(idx).toHaveLength(1);
    expect(idx[0].conversation_id).toBe(conv.conversation_id);
    expect(idx[0].deleted_at).toBeTruthy();
    expect(await chats.getConversation(TEST_UID, conv.conversation_id)).toBeNull();
    expect(await chats.listConversations(TEST_UID)).toEqual([]);
    expect(fs.existsSync(path.join(tmpDir, TEST_UID, 'cloud', 'chats', `${conv.conversation_id}.jsonl`)))
      .toBe(false);
    expect(fs.existsSync(groupDir)).toBe(false);
    expect(fs.existsSync(path.join(groupDir, 'meta.json'))).toBe(false);
  });

  it('treats deleting an already-tombstoned conversation as successful cleanup', async () => {
    const chats = await loadChats();
    const conv = await chats.createConversation(TEST_UID, { title: 'delete me' });
    const groupDir = path.join(tmpDir, TEST_UID, 'cloud', 'chats', conv.conversation_id);

    expect(await chats.deleteConversation(TEST_UID, conv.conversation_id)).toBe(true);
    fs.mkdirSync(path.join(groupDir, 'visibility'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, TEST_UID, 'cloud', 'chats', `${conv.conversation_id}.jsonl`), '');

    expect(await chats.deleteConversation(TEST_UID, conv.conversation_id)).toBe(true);
    expect(await chats.listConversations(TEST_UID)).toEqual([]);
    expect(fs.existsSync(groupDir)).toBe(false);
    expect(fs.existsSync(path.join(tmpDir, TEST_UID, 'cloud', 'chats', `${conv.conversation_id}.jsonl`)))
      .toBe(false);

    const idx = JSON.parse(fs.readFileSync(
      path.join(tmpDir, TEST_UID, 'cloud', 'chats', '_index.json'), 'utf-8'));
    expect(idx).toHaveLength(1);
    expect(idx[0].conversation_id).toBe(conv.conversation_id);
    expect(idx[0].deleted_at).toBeTruthy();
  });

  it('keeps tombstoned rows when later writes update the active index', async () => {
    const chats = await loadChats();
    const deleted = await chats.createConversation(TEST_UID, { title: 'deleted' });
    expect(await chats.deleteConversation(TEST_UID, deleted.conversation_id)).toBe(true);

    const active = await chats.createConversation(TEST_UID, { title: 'active' });
    await chats.updateConversation(TEST_UID, active.conversation_id, { title: 'active v2' });

    const listed = await chats.listConversations(TEST_UID);
    expect(listed.map((c) => c.conversation_id)).toEqual([active.conversation_id]);

    const idx = JSON.parse(fs.readFileSync(
      path.join(tmpDir, TEST_UID, 'cloud', 'chats', '_index.json'), 'utf-8'));
    const byId = Object.fromEntries(idx.map((c: any) => [c.conversation_id, c]));
    expect(byId[deleted.conversation_id].deleted_at).toBeTruthy();
    expect(byId[active.conversation_id].title).toBe('active v2');
  });

  it('stamps conversation index records with a record-level sync revision', async () => {
    const chats = await loadChats();
    const conv = await chats.createConversation(TEST_UID, { title: 'rev 1' });
    await chats.updateConversation(TEST_UID, conv.conversation_id, { title: 'rev 2' });

    const idx = JSON.parse(fs.readFileSync(
      path.join(tmpDir, TEST_UID, 'cloud', 'chats', '_index.json'), 'utf-8'));
    expect(idx[0]._sync_rev).toBe(2);
    expect(typeof idx[0]._sync_device_id).toBe('string');
    expect(idx[0]._sync_device_id.length).toBeGreaterThan(0);
  });

  it('prunes tombstoned rows older than 30 days when writing the index', async () => {
    const chats = await loadChats();
    const oldMetaDir = path.join(tmpDir, TEST_UID, 'cloud', 'chats', 'olddead12345');
    fs.mkdirSync(oldMetaDir, { recursive: true });
    fs.writeFileSync(path.join(oldMetaDir, 'meta.json'), '{"conversation_id":"olddead12345"}');

    await chats.saveConversations(TEST_UID, [
      {
        conversation_id: 'olddead12345',
        title: 'old tombstone',
        kind: 'normal',
        agent_id: '',
        skill_id: '',
        session_id: 'gconv-olddead12345',
        created_at: '2000-01-01T00:00:00Z',
        updated_at: '2000-01-01T00:00:00Z',
        deleted_at: '2000-01-01T00:00:00Z',
      },
      {
        conversation_id: 'active123456',
        title: 'active',
        kind: 'normal',
        agent_id: '',
        skill_id: '',
        session_id: 'gconv-active123456',
        created_at: '2026-05-29T00:00:00Z',
        updated_at: '2026-05-29T00:00:00Z',
      },
    ]);

    const idx = JSON.parse(fs.readFileSync(
      path.join(tmpDir, TEST_UID, 'cloud', 'chats', '_index.json'), 'utf-8'));
    expect(idx.map((c: any) => c.conversation_id)).toEqual(['active123456']);
    expect(fs.existsSync(path.join(oldMetaDir, 'meta.json'))).toBe(false);
  });
});

describe('chats › autoTitle on first send', () => {
  it('groupChat.send updates the placeholder title to message text on first user msg', async () => {
    vi.resetModules();
    const groupChat = await import('../../../src/main/features/group_chat');
    const chats = await loadChats();
    // Pass the zh placeholder explicitly so the test exercises the
    // multilingual `isPlaceholderTitle` detection path regardless of the
    // test process's i18n default.
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

  it('does NOT overwrite a manually renamed placeholder title', async () => {
    vi.resetModules();
    const groupChat = await import('../../../src/main/features/group_chat');
    const chats = await loadChats();
    const conv = await chats.createConversation(TEST_UID, { title: '临时' });
    await chats.renameConversation(TEST_UID, conv.conversation_id, '新对话');

    await groupChat.send({
      userId: TEST_UID, cid: conv.conversation_id, text: '这条消息不应该改标题',
    });

    const after = await chats.getConversation(TEST_UID, conv.conversation_id);
    expect(after?.title).toBe('新对话');
    expect(after?.title_manually_set).toBe(true);

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
