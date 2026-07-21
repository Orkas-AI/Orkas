import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { drainMainRuntimeForTest } from '../../helpers/drain-main-runtime';

vi.mock('../../../src/main/logger', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

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

afterEach(async () => {
  await drainMainRuntimeForTest();
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

  // Project membership wiring. Project conversations live in the project's
  // contained chats tree while session_id remains independent of project_id.
  // When projectId is omitted the global record must not carry an empty field.
  it('persists project_id when supplied; omits the field when absent', async () => {
    const chats = await loadChats();
    const projects = await import('../../../src/main/features/projects');
    const createdProject = await projects.createProject(TEST_UID, 'Contained project');
    if (!createdProject.ok) throw new Error(`project setup failed: ${createdProject.error}`);
    const pid = createdProject.project.project_id;
    const c1 = await chats.createConversation(TEST_UID, { projectId: pid });
    expect(c1.project_id).toBe(pid);
    // session_id MUST stay independent of project_id.
    expect(c1.session_id).toBe(`gconv-${c1.conversation_id}`);
    const c2 = await chats.createConversation(TEST_UID);
    expect(c2.project_id).toBeUndefined();

    const globalIdx = JSON.parse(fs.readFileSync(
      path.join(tmpDir, TEST_UID, 'cloud', 'chats', '_index.json'), 'utf-8'));
    const projectIdx = JSON.parse(fs.readFileSync(
      path.join(tmpDir, TEST_UID, 'cloud', 'projects', pid, 'chats', '_index.json'), 'utf-8'));
    const persistedC1 = projectIdx.find((c: any) => c.conversation_id === c1.conversation_id);
    const persistedC2 = globalIdx.find((c: any) => c.conversation_id === c2.conversation_id);
    expect(persistedC1.project_id).toBe(pid);
    expect(persistedC2.project_id).toBeUndefined();

    const meta = JSON.parse(fs.readFileSync(
      path.join(tmpDir, TEST_UID, 'cloud', 'projects', pid, 'chats', c1.conversation_id, 'meta.json'), 'utf-8'));
    expect(meta.conversation_id).toBe(c1.conversation_id);
    expect(meta.project_id).toBe(pid);
  });
});

describe('chats › message history tombstones', () => {
  it('fills each page with visible messages while skipping deleted rows', async () => {
    const chats = await loadChats();
    const conv = await chats.createConversation(TEST_UID, { title: 'history' });
    const file = path.join(tmpDir, TEST_UID, 'cloud', 'chats', `${conv.conversation_id}.jsonl`);
    const rows = [
      { id: 'm1', ts: '2026-07-10T10:00:00', from: 'user', to: ['commander'], text: 'one' },
      { id: 'm2', ts: '2026-07-10T10:01:00', from: 'commander', to: ['user'], text: '', deleted_at: '2026-07-10T11:00:00' },
      { id: 'm3', ts: '2026-07-10T10:02:00', from: 'user', to: ['commander'], text: 'three' },
      { id: 'm4', ts: '2026-07-10T10:03:00', from: 'commander', to: ['user'], text: '', deleted_at: '2026-07-10T11:00:00' },
      { id: 'm5', ts: '2026-07-10T10:04:00', from: 'commander', to: ['user'], text: 'five' },
    ];
    fs.writeFileSync(file, rows.map((row) => JSON.stringify(row)).join('\n') + '\n');

    const latest = await chats.getMessagesPage(TEST_UID, conv.conversation_id, 2);
    expect(latest.history.map((row) => row.id)).toEqual(['m3', 'm5']);
    expect(latest.nextCursor).not.toBeNull();

    const earlier = await chats.getMessagesPage(TEST_UID, conv.conversation_id, 2, latest.nextCursor);
    expect(earlier.history.map((row) => row.id)).toEqual(['m1']);
    expect(earlier.nextCursor).toBeNull();
  });

  it('loads from the search target page through the newest message', async () => {
    const chats = await loadChats();
    const conv = await chats.createConversation(TEST_UID, { title: 'search target' });
    const file = path.join(tmpDir, TEST_UID, 'cloud', 'chats', `${conv.conversation_id}.jsonl`);
    const rows = Array.from({ length: 35 }, (_, i) => ({
      id: `m${i}`,
      ts: `2026-07-10T10:${String(i).padStart(2, '0')}:00`,
      from: i % 2 ? 'commander' : 'user',
      to: i % 2 ? ['user'] : ['commander'],
      text: `message ${i}`,
    }));
    fs.writeFileSync(file, rows.map((row) => JSON.stringify(row)).join('\n') + '\n');

    const page = await chats.getMessagesPageAtIndex(TEST_UID, conv.conversation_id, 23, 10);

    expect(page.pageStart).toBe(20);
    expect(page.history.map((row) => row.id)).toEqual([
      'm20', 'm21', 'm22', 'm23', 'm24', 'm25', 'm26', 'm27', 'm28', 'm29',
      'm30', 'm31', 'm32', 'm33', 'm34',
    ]);
    expect(page.historyIndexes).toEqual([
      20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32, 33, 34,
    ]);
    expect(page.nextCursor).not.toBeNull();
  });

  it('keeps source indexes aligned when an anchored page contains tombstones or legacy rows', async () => {
    const chats = await loadChats();
    const conv = await chats.createConversation(TEST_UID, { title: 'legacy search target' });
    const file = path.join(tmpDir, TEST_UID, 'cloud', 'chats', `${conv.conversation_id}.jsonl`);
    const rows = Array.from({ length: 35 }, (_, i) => {
      if (i === 21) {
        return { id: 'm21', from: 'user', text: 'deleted', deleted_at: '2026-07-10T11:00:00' };
      }
      if (i === 23) return { from: 'commander', text: 'legacy target without identity' };
      return { id: `m${i}`, from: i % 2 ? 'commander' : 'user', text: `message ${i}` };
    });
    fs.writeFileSync(file, rows.map((row) => JSON.stringify(row)).join('\n') + '\n');

    const page = await chats.getMessagesPageAtIndex(TEST_UID, conv.conversation_id, 23, 10);

    expect(page.pageStart).toBe(20);
    expect(page.history.map((row) => row.text)).toContain('legacy target without identity');
    expect(page.historyIndexes).toEqual([
      20, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32, 33, 34,
    ]);
  });

  it('keeps an explicit global history read out of a duplicate project root', async () => {
    const chats = await loadChats();
    const projects = await import('../../../src/main/features/projects');
    const project = await projects.createProject(TEST_UID, 'Unrelated history');
    if (!project.ok) throw new Error(`project setup failed: ${project.error}`);
    const conv = await chats.createConversation(TEST_UID, { title: 'global history' });
    const globalFile = path.join(
      tmpDir, TEST_UID, 'cloud', 'chats', `${conv.conversation_id}.jsonl`);
    fs.writeFileSync(globalFile, `${JSON.stringify({
      id: 'global-msg', ts: '2026-07-10T10:00:00Z', from: 'user', to: ['commander'], text: 'global',
    })}\n`);
    const projectFile = path.join(
      tmpDir, TEST_UID, 'cloud', 'projects', project.project.project_id,
      'chats', `${conv.conversation_id}.jsonl`);
    fs.mkdirSync(path.dirname(projectFile), { recursive: true });
    fs.writeFileSync(projectFile, `${JSON.stringify({
      id: 'project-msg', ts: '2026-07-10T10:00:00Z', from: 'user', to: ['commander'], text: 'project',
    })}\n`);

    const page = await chats.getMessagesPage(
      TEST_UID, conv.conversation_id, 10, undefined, null);

    expect(page.history.map((row) => row.id)).toEqual(['global-msg']);
  });
});

describe('chats › automation execution history', () => {
  it('paginates runs across global and project roots and reports exact totals', async () => {
    const chats = await loadChats();
    const projects = await import('../../../src/main/features/projects');
    const createdProject = await projects.createProject(TEST_UID, 'Automation runs');
    if (!createdProject.ok) throw new Error(`project setup failed: ${createdProject.error}`);
    const taskId = 'at_history';
    const createdIds: string[] = [];

    for (let i = 0; i < 13; i += 1) {
      const conv = await chats.createConversation(TEST_UID, {
        title: `run ${i}`,
        projectId: i >= 7 ? createdProject.project.project_id : undefined,
        originAutoTaskId: taskId,
      });
      createdIds.push(conv.conversation_id);
    }
    await chats.createConversation(TEST_UID, {
      title: 'other automation',
      originAutoTaskId: 'at_other',
    });

    const counts = await chats.countAutoTaskConversations(
      TEST_UID,
      [taskId, 'at_other', 'at_empty'],
    );
    expect(counts).toEqual({ at_history: 13, at_other: 1, at_empty: 0 });

    const first = await chats.listAutoTaskConversationPage(TEST_UID, taskId, 0);
    expect(first.total).toBe(13);
    expect(first.conversations).toHaveLength(10);
    expect(first.next_offset).toBe(10);

    const second = await chats.listAutoTaskConversationPage(TEST_UID, taskId, first.next_offset!);
    expect(second.total).toBe(13);
    expect(second.conversations).toHaveLength(3);
    expect(second.next_offset).toBeNull();
    expect(new Set([...first.conversations, ...second.conversations]
      .map((conv) => conv.conversation_id))).toEqual(new Set(createdIds));
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
    expect(pinned?.pin_state_updated_at).toBeTruthy();
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
    expect(idx[0].pin_state_updated_at).toBeTruthy();
    const meta = JSON.parse(fs.readFileSync(
      path.join(tmpDir, TEST_UID, 'cloud', 'chats', conv.conversation_id, 'meta.json'), 'utf-8'));
    expect(meta.pinned_at).toBeUndefined();
    expect(meta.pin_state_updated_at).toBeTruthy();
  });
});

describe('chats › targeted conversation lookup', () => {
  it('uses a validated project/global hint without opening unrelated indexes', async () => {
    const chats = await loadChats();
    const projects = await import('../../../src/main/features/projects');
    const first = await projects.createProject(TEST_UID, 'Lookup target');
    const second = await projects.createProject(TEST_UID, 'Lookup unrelated');
    if (!first.ok || !second.ok) throw new Error('project setup failed');
    const target = await chats.createConversation(TEST_UID, {
      title: 'target',
      projectId: first.project.project_id,
    });
    const unrelated = await chats.createConversation(TEST_UID, {
      title: 'unrelated',
      projectId: second.project.project_id,
    });
    const global = await chats.createConversation(TEST_UID, { title: 'global' });
    const unrelatedIndex = path.join(
      tmpDir, TEST_UID, 'cloud', 'projects', second.project.project_id, 'chats', '_index.json');
    const unrelatedRows = JSON.parse(fs.readFileSync(unrelatedIndex, 'utf8'));
    unrelatedRows.push({
      ...target,
      title: 'newer duplicate from unrelated root',
      project_id: second.project.project_id,
      updated_at: '2099-01-01T00:00:00.000Z',
      _sync_rev: 999,
    });
    fs.writeFileSync(unrelatedIndex, JSON.stringify(unrelatedRows, null, 2));
    chats.invalidateConversationCaches(TEST_UID);

    const projectFound = await chats.getConversation(
      TEST_UID, target.conversation_id, first.project.project_id);
    const globalFound = await chats.getConversation(TEST_UID, global.conversation_id, null);

    expect(projectFound?.title).toBe('target');
    expect(projectFound?.project_id).toBe(first.project.project_id);
    expect(globalFound?.project_id).toBeUndefined();
    expect(unrelated.conversation_id).not.toBe(target.conversation_id);

    // The shared startup snapshot contains both duplicate rows. A hinted
    // lookup must retain the same physical-root isolation on the warm path.
    await chats.getProjectConversationCounts(TEST_UID);
    const warmFound = await chats.getConversation(
      TEST_UID, target.conversation_id, first.project.project_id);
    expect(warmFound?.title).toBe('target');
    expect(warmFound?.project_id).toBe(first.project.project_id);
  });

  it('falls back to the shared all-root lookup when a project hint is stale', async () => {
    const chats = await loadChats();
    const projects = await import('../../../src/main/features/projects');
    const owner = await projects.createProject(TEST_UID, 'Actual owner');
    const stale = await projects.createProject(TEST_UID, 'Stale hint');
    if (!owner.ok || !stale.ok) throw new Error('project setup failed');
    const target = await chats.createConversation(TEST_UID, {
      title: 'moved by sync',
      projectId: owner.project.project_id,
    });
    chats.invalidateConversationCaches(TEST_UID);

    const found = await chats.getConversation(TEST_UID, target.conversation_id, stale.project.project_id);

    expect(found?.conversation_id).toBe(target.conversation_id);
    expect(found?.project_id).toBe(owner.project.project_id);
  });
});

describe('chats › root-scoped mutation store', () => {
  it('keeps normal create/activity/rename/pin/delete work inside the hinted root', async () => {
    const chats = await loadChats();
    const projects = await import('../../../src/main/features/projects');
    const owner = await projects.createProject(TEST_UID, 'Mutation owner');
    const unrelatedProject = await projects.createProject(TEST_UID, 'Mutation unrelated');
    if (!owner.ok || !unrelatedProject.ok) throw new Error('project setup failed');
    await chats.createConversation(TEST_UID, {
      title: 'unrelated row',
      projectId: unrelatedProject.project.project_id,
    });
    const unrelatedIndex = path.join(
      tmpDir, TEST_UID, 'cloud', 'projects', unrelatedProject.project.project_id,
      'chats', '_index.json');
    const beforeCreate = fs.readFileSync(unrelatedIndex, 'utf8');
    const beforeCreateInode = fs.statSync(unrelatedIndex).ino;

    const target = await chats.createConversation(TEST_UID, {
      title: 'mutation target',
      projectId: owner.project.project_id,
    });
    expect(fs.readFileSync(unrelatedIndex, 'utf8')).toBe(beforeCreate);
    expect(fs.statSync(unrelatedIndex).ino).toBe(beforeCreateInode);

    const unrelatedRows = JSON.parse(beforeCreate);
    unrelatedRows.push({
      ...target,
      title: 'newer duplicate in wrong root',
      project_id: unrelatedProject.project.project_id,
      updated_at: '2099-01-01T00:00:00.000Z',
      _sync_rev: 999,
    });
    fs.writeFileSync(unrelatedIndex, JSON.stringify(unrelatedRows, null, 2));
    const unrelatedSentinel = fs.readFileSync(unrelatedIndex, 'utf8');
    const unrelatedInode = fs.statSync(unrelatedIndex).ino;

    await chats.bumpConversationActivity(
      TEST_UID,
      target.conversation_id,
      '2027-01-01T00:00:00.000Z',
      { senderKind: 'commander', senderId: 'commander' },
      owner.project.project_id,
    );
    await chats.renameConversation(
      TEST_UID, target.conversation_id, 'renamed in owner', owner.project.project_id);
    await chats.setConversationPinned(
      TEST_UID, target.conversation_id, true, owner.project.project_id);

    const ownerIndex = path.join(
      tmpDir, TEST_UID, 'cloud', 'projects', owner.project.project_id, 'chats', '_index.json');
    const ownerRows = JSON.parse(fs.readFileSync(ownerIndex, 'utf8'));
    const ownerRow = ownerRows.find((row: any) => row.conversation_id === target.conversation_id);
    expect(ownerRow.title).toBe('renamed in owner');
    expect(ownerRow.commander_in_chat).toBe(true);
    expect(ownerRow.pinned_at).toBeTruthy();
    expect(fs.readFileSync(unrelatedIndex, 'utf8')).toBe(unrelatedSentinel);
    expect(fs.statSync(unrelatedIndex).ino).toBe(unrelatedInode);

    expect(await chats.deleteConversation(
      TEST_UID, target.conversation_id, owner.project.project_id)).toBe(true);
    expect(fs.readFileSync(unrelatedIndex, 'utf8')).toBe(unrelatedSentinel);
    expect(fs.statSync(unrelatedIndex).ino).toBe(unrelatedInode);
  });

  it('serialises read-modify-write so concurrent field updates are not lost', async () => {
    const chats = await loadChats();
    const conv = await chats.createConversation(TEST_UID, { title: 'concurrent' });

    await Promise.all([
      chats.updateConversation(TEST_UID, conv.conversation_id, { title: 'updated title' }, null),
      chats.updateConversation(TEST_UID, conv.conversation_id, { origin_auto_task_id: 'at_parallel' }, null),
    ]);

    const after = await chats.getConversation(TEST_UID, conv.conversation_id, null);
    expect(after?.title).toBe('updated title');
    expect(after?.origin_auto_task_id).toBe('at_parallel');
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

  it('persists only the changed metadata and affected project index', async () => {
    const chats = await loadChats();
    const projects = await import('../../../src/main/features/projects');
    const first = await projects.createProject(TEST_UID, 'First project');
    const second = await projects.createProject(TEST_UID, 'Second project');
    if (!first.ok || !second.ok) throw new Error('project setup failed');
    const changed = await chats.createConversation(TEST_UID, {
      title: 'changed', projectId: first.project.project_id,
    });
    const untouched = await chats.createConversation(TEST_UID, {
      title: 'untouched', projectId: second.project.project_id,
    });
    const projectRoot = path.join(tmpDir, TEST_UID, 'cloud', 'projects');
    const changedMeta = path.join(
      projectRoot, first.project.project_id, 'chats', changed.conversation_id, 'meta.json',
    );
    const untouchedMeta = path.join(
      projectRoot, second.project.project_id, 'chats', untouched.conversation_id, 'meta.json',
    );
    const changedIndex = path.join(projectRoot, first.project.project_id, 'chats', '_index.json');
    const untouchedIndex = path.join(projectRoot, second.project.project_id, 'chats', '_index.json');
    // A full metadata sweep would treat this malformed recovery file as
    // unreadable and overwrite it. Incremental persistence must never open
    // it as part of the changed conversation's save path.
    fs.writeFileSync(untouchedMeta, 'untouched-sentinel');
    const changedIndexInode = fs.statSync(changedIndex).ino;
    const untouchedIndexInode = fs.statSync(untouchedIndex).ino;

    const renamed = await chats.renameConversation(TEST_UID, changed.conversation_id, 'renamed');
    expect(renamed?.title).toBe('renamed');

    expect(JSON.parse(fs.readFileSync(changedMeta, 'utf-8')).title).toBe('renamed');
    expect(fs.readFileSync(untouchedMeta, 'utf-8')).toBe('untouched-sentinel');
    // writeJson is atomic (temp + rename), so an affected index gets a new
    // inode while an unrelated project's index remains exactly untouched.
    expect(fs.statSync(changedIndex).ino).not.toBe(changedIndexInode);
    expect(fs.statSync(untouchedIndex).ino).toBe(untouchedIndexInode);
  });

  it('rewrites both aggregate roots when project membership changes', async () => {
    const chats = await loadChats();
    const projects = await import('../../../src/main/features/projects');
    const first = await projects.createProject(TEST_UID, 'Old root');
    const second = await projects.createProject(TEST_UID, 'New root');
    if (!first.ok || !second.ok) throw new Error('project setup failed');
    const conv = await chats.createConversation(TEST_UID, {
      title: 'move me', projectId: first.project.project_id,
    });

    const moved = await chats.updateConversation(TEST_UID, conv.conversation_id, {
      project_id: second.project.project_id,
    });
    expect(moved?.project_id).toBe(second.project.project_id);

    const projectRoot = path.join(tmpDir, TEST_UID, 'cloud', 'projects');
    const oldIndex = JSON.parse(fs.readFileSync(
      path.join(projectRoot, first.project.project_id, 'chats', '_index.json'), 'utf-8',
    ));
    const newIndex = JSON.parse(fs.readFileSync(
      path.join(projectRoot, second.project.project_id, 'chats', '_index.json'), 'utf-8',
    ));
    expect(oldIndex.some((row: any) => row.conversation_id === conv.conversation_id)).toBe(false);
    expect(newIndex.some((row: any) => row.conversation_id === conv.conversation_id)).toBe(true);
  });
});

describe('chats › index repair', () => {
  it('limits startup enrichment to visible age buckets and expanded projects', async () => {
    const chats = await loadChats();
    const projects = await import('../../../src/main/features/projects');
    const expanded = await projects.createProject(TEST_UID, 'Expanded');
    const collapsed = await projects.createProject(TEST_UID, 'Collapsed');
    if (!expanded.ok || !collapsed.ok) throw new Error('project setup failed');

    const recent = await chats.createConversation(TEST_UID, { title: 'recent' });
    const old = await chats.createConversation(TEST_UID, { title: 'old' });
    const expandedConv = await chats.createConversation(TEST_UID, {
      title: 'expanded project',
      projectId: expanded.project.project_id,
    });
    const collapsedConv = await chats.createConversation(TEST_UID, {
      title: 'collapsed project',
      projectId: collapsed.project.project_id,
    });
    const globalIndex = path.join(tmpDir, TEST_UID, 'cloud', 'chats', '_index.json');
    const rows = JSON.parse(fs.readFileSync(globalIndex, 'utf8'));
    const oldRow = rows.find((row: any) => row.conversation_id === old.conversation_id);
    oldRow.created_at = '2020-01-01T00:00:00.000Z';
    oldRow.updated_at = '2020-01-01T00:00:00.000Z';
    oldRow.participant_summary_updated_at = oldRow.updated_at;
    fs.writeFileSync(globalIndex, JSON.stringify(rows, null, 2));

    const startup = await chats.listStartupConversations(TEST_UID, {
      expandedProjectIds: [expanded.project.project_id],
    });
    const startupIds = startup.conversations.map((c) => c.conversation_id);
    expect(startupIds).toContain(recent.conversation_id);
    expect(startupIds).toContain(expandedConv.conversation_id);
    expect(startupIds).not.toContain(old.conversation_id);
    expect(startupIds).not.toContain(collapsedConv.conversation_id);
    expect(startup.deferred_unprojected.older).toBe(1);
    expect(startup.loaded_project_ids).toEqual([expanded.project.project_id]);

    expect((await chats.listOldUnprojectedConversations(TEST_UID)).map((c) => c.conversation_id))
      .toEqual([old.conversation_id]);
    expect((await chats.listProjectConversations(TEST_UID, collapsed.project.project_id))
      .map((c) => c.conversation_id)).toEqual([collapsedConv.conversation_id]);
  });

  it('pages expanded projects and old buckets in independent 10-row slices', async () => {
    const chats = await loadChats();
    const projects = await import('../../../src/main/features/projects');
    const project = await projects.createProject(TEST_UID, 'Paged project');
    if (!project.ok) throw new Error('project setup failed');
    const pid = project.project.project_id;
    const now = Date.now();
    const row = (cid: string, title: string, at: Date, projectId?: string) => ({
      conversation_id: cid,
      title,
      kind: 'normal',
      ...(projectId ? { project_id: projectId } : {}),
      created_at: at.toISOString(),
      updated_at: at.toISOString(),
      participant_summary_updated_at: at.toISOString(),
      agent_ids: [],
      commander_in_chat: false,
      _sync_rev: 1,
      _sync_device_id: 'test',
    });
    const projectRows = Array.from({ length: 15 }, (_, i) => row(
      (i + 1).toString(16).padStart(12, '0'),
      `project-${i}`,
      new Date(now - i * 60_000),
      pid,
    ));
    const projectIndex = path.join(
      tmpDir, TEST_UID, 'cloud', 'projects', pid, 'chats', '_index.json');
    fs.mkdirSync(path.dirname(projectIndex), { recursive: true });
    fs.writeFileSync(projectIndex, JSON.stringify(projectRows, null, 2));

    const last30Rows = Array.from({ length: 12 }, (_, i) => row(
      (100 + i).toString(16).padStart(12, '0'),
      `last30-${i}`,
      new Date(now - 10 * 24 * 60 * 60 * 1000 - i * 60_000),
    ));
    const olderRows = Array.from({ length: 13 }, (_, i) => row(
      (200 + i).toString(16).padStart(12, '0'),
      `older-${i}`,
      new Date(now - 40 * 24 * 60 * 60 * 1000 - i * 60_000),
    ));
    const globalIndex = path.join(tmpDir, TEST_UID, 'cloud', 'chats', '_index.json');
    fs.mkdirSync(path.dirname(globalIndex), { recursive: true });
    fs.writeFileSync(globalIndex, JSON.stringify([...last30Rows, ...olderRows], null, 2));
    chats.invalidateConversationCaches(TEST_UID);

    const startup = await chats.listStartupConversations(TEST_UID, {
      expandedProjectIds: [pid],
    });
    expect(startup.conversations.filter((c) => c.project_id === pid)).toHaveLength(10);
    expect(startup.project_pagination[pid]).toEqual({ total: 15, next_offset: 10 });
    expect(startup.deferred_unprojected).toEqual({ last30: 12, older: 13 });

    const restored = await chats.listStartupConversations(TEST_UID, {
      activeConversationId: projectRows[14].conversation_id,
      expandedProjectIds: [pid],
    });
    expect(restored.conversations.filter((c) => c.project_id === pid)).toHaveLength(11);
    expect(restored.conversations.some((c) => c.conversation_id === projectRows[14].conversation_id)).toBe(true);

    const projectFirst = await chats.listProjectConversationPage(TEST_UID, pid, 0);
    const projectSecond = await chats.listProjectConversationPage(TEST_UID, pid, 10);
    expect(projectFirst).toMatchObject({ total: 15, next_offset: 10 });
    expect(projectFirst.conversations).toHaveLength(10);
    expect(projectSecond).toMatchObject({ total: 15, next_offset: null });
    expect(projectSecond.conversations).toHaveLength(5);
    expect(new Set([...projectFirst.conversations, ...projectSecond.conversations]
      .map((c) => c.conversation_id)).size).toBe(15);

    const last30 = await chats.listOldUnprojectedConversationPage(TEST_UID, 'last30', 0);
    const older = await chats.listOldUnprojectedConversationPage(TEST_UID, 'older', 0);
    expect(last30).toMatchObject({ total: 12, next_offset: 10 });
    expect(last30.conversations).toHaveLength(10);
    expect(last30.conversations.every((c) => c.title.startsWith('last30-'))).toBe(true);
    expect(older).toMatchObject({ total: 13, next_offset: 10 });
    expect(older.conversations).toHaveLength(10);
    expect(older.conversations.every((c) => c.title.startsWith('older-'))).toBe(true);
  });

  it('loads the owning project slice when restoring its active conversation', async () => {
    const chats = await loadChats();
    const projects = await import('../../../src/main/features/projects');
    const project = await projects.createProject(TEST_UID, 'Active project');
    if (!project.ok) throw new Error('project setup failed');
    const first = await chats.createConversation(TEST_UID, { projectId: project.project.project_id });
    const second = await chats.createConversation(TEST_UID, { projectId: project.project.project_id });

    const startup = await chats.listStartupConversations(TEST_UID, {
      activeConversationId: first.conversation_id,
    });
    expect(new Set(startup.conversations.map((c) => c.conversation_id)))
      .toEqual(new Set([first.conversation_id, second.conversation_id]));
    expect(startup.loaded_project_ids).toEqual([project.project.project_id]);
  });

  it('keeps scoped expansion isolated from duplicate rows in unrelated roots', async () => {
    const chats = await loadChats();
    const projects = await import('../../../src/main/features/projects');
    const first = await projects.createProject(TEST_UID, 'First root');
    const second = await projects.createProject(TEST_UID, 'Second root');
    if (!first.ok || !second.ok) throw new Error('project setup failed');
    const projected = await chats.createConversation(TEST_UID, {
      title: 'first-root row',
      projectId: first.project.project_id,
    });
    const oldGlobal = await chats.createConversation(TEST_UID, { title: 'old global row' });

    const globalIndex = path.join(tmpDir, TEST_UID, 'cloud', 'chats', '_index.json');
    const globalRows = JSON.parse(fs.readFileSync(globalIndex, 'utf8'));
    const globalRow = globalRows.find((row: any) => row.conversation_id === oldGlobal.conversation_id);
    globalRow.created_at = '2020-01-01T00:00:00.000Z';
    globalRow.updated_at = '2020-01-01T00:00:00.000Z';
    globalRow.participant_summary_updated_at = globalRow.updated_at;
    fs.writeFileSync(globalIndex, JSON.stringify(globalRows, null, 2));

    // Put newer duplicate cids in an unrelated project root. A global
    // read-then-filter implementation lets these rows win the merge and can
    // make the requested root disappear. A physical-root reader never opens
    // or merges the unrelated index.
    const unrelatedIndex = path.join(
      tmpDir, TEST_UID, 'cloud', 'projects', second.project.project_id, 'chats', '_index.json');
    fs.mkdirSync(path.dirname(unrelatedIndex), { recursive: true });
    const future = '2099-01-01T00:00:00.000Z';
    fs.writeFileSync(unrelatedIndex, JSON.stringify([
      { ...projected, project_id: second.project.project_id, title: 'wrong root', updated_at: future },
      { ...oldGlobal, project_id: second.project.project_id, title: 'wrong global', updated_at: future },
    ], null, 2));
    chats.invalidateConversationCaches(TEST_UID);

    expect((await chats.listProjectConversations(TEST_UID, first.project.project_id))
      .map((row) => row.conversation_id)).toEqual([projected.conversation_id]);
    expect((await chats.listOldUnprojectedConversations(TEST_UID))
      .map((row) => row.conversation_id)).toEqual([oldGlobal.conversation_id]);
  });

  it('uses a fresh persisted participant summary without rescanning the message log', async () => {
    const chats = await loadChats();
    const conv = await chats.createConversation(TEST_UID, { title: 'summary source' });
    const chatsDir = path.join(tmpDir, TEST_UID, 'cloud', 'chats');
    const jsonl = path.join(chatsDir, `${conv.conversation_id}.jsonl`);

    // Deliberately make the message log disagree with the fresh index summary.
    // A fresh summary is authoritative, so listConversations must not reopen
    // the JSONL just to derive commander participation again.
    fs.writeFileSync(jsonl, `${JSON.stringify({
      id: 'legacy-only',
      ts: conv.updated_at,
      from: 'commander',
      to: ['user'],
      text: 'should not be scanned',
    })}\n`);

    const listed = await chats.listConversations(TEST_UID);
    expect(listed[0].commander_in_chat).toBe(false);
    expect(listed[0].agent_ids).toEqual([]);
    expect(listed[0].participant_summary_updated_at).toBe(conv.updated_at);
  });

  it('reuses the short-lived list snapshot across duplicate startup requests', async () => {
    const chats = await loadChats();
    const conv = await chats.createConversation(TEST_UID, { title: 'startup snapshot' });
    const first = await chats.listConversations(TEST_UID);
    expect(first.map((c) => c.conversation_id)).toContain(conv.conversation_id);

    const chatsDir = path.join(tmpDir, TEST_UID, 'cloud', 'chats');
    fs.rmSync(path.join(chatsDir, '_index.json'), { force: true });
    fs.rmSync(path.join(chatsDir, conv.conversation_id, 'meta.json'), { force: true });
    fs.rmSync(path.join(chatsDir, `${conv.conversation_id}.jsonl`), { force: true });

    const second = await chats.listConversations(TEST_UID);
    expect(second.map((c) => c.conversation_id)).toContain(conv.conversation_id);
  });

  it('backfills participant summaries for legacy records', async () => {
    const cid = 'abc123def456';
    const chatsDir = path.join(tmpDir, TEST_UID, 'cloud', 'chats');
    fs.mkdirSync(path.join(chatsDir, cid), { recursive: true });
    fs.writeFileSync(path.join(chatsDir, cid, 'members.json'), JSON.stringify({
      version: 1,
      actors: [
        { kind: 'commander', id: 'commander', joined_at: '2026-01-01T00:00:00Z' },
        { kind: 'agent', id: 'agent-one', joined_at: '2026-01-01T00:00:00Z' },
      ],
    }));
    fs.writeFileSync(path.join(chatsDir, `${cid}.jsonl`), `${JSON.stringify({
      id: 'm1',
      ts: '2026-05-28T01:02:03.000Z',
      from: 'commander',
      to: ['user'],
      text: 'legacy reply',
    })}\n`);
    fs.writeFileSync(path.join(chatsDir, '_index.json'), JSON.stringify([{
      conversation_id: cid,
      title: 'legacy summary',
      kind: 'normal',
      agent_id: '',
      skill_id: '',
      session_id: `gconv-${cid}`,
      created_at: '2026-05-28T01:02:03.000Z',
      updated_at: '2026-05-28T01:02:03.000Z',
    }], null, 2));

    const chats = await loadChats();
    const listed = await chats.listConversations(TEST_UID);
    expect(listed[0].commander_in_chat).toBe(true);
    expect(listed[0].agent_ids).toEqual(['agent-one']);

    const index = JSON.parse(fs.readFileSync(path.join(chatsDir, '_index.json'), 'utf8'));
    expect(index[0].commander_in_chat).toBe(true);
    expect(index[0].agent_ids).toEqual(['agent-one']);
    expect(index[0].participant_summary_updated_at).toBe(index[0].updated_at);
  });

  it('updates a fresh participant summary incrementally with message activity', async () => {
    const chats = await loadChats();
    const conv = await chats.createConversation(TEST_UID, { agentId: 'agent-start' });
    await chats.bumpConversationActivity(
      TEST_UID,
      conv.conversation_id,
      '2026-06-01T00:01:00.000Z',
      { senderKind: 'agent', senderId: 'agent-reply', agentIds: ['agent-target'] },
    );
    await chats.bumpConversationActivity(
      TEST_UID,
      conv.conversation_id,
      '2026-06-01T00:02:00.000Z',
      { senderKind: 'commander', senderId: 'commander' },
    );

    const index = JSON.parse(fs.readFileSync(
      path.join(tmpDir, TEST_UID, 'cloud', 'chats', '_index.json'), 'utf8'));
    expect(index[0].agent_ids).toEqual(['agent-start', 'agent-target', 'agent-reply']);
    expect(index[0].commander_in_chat).toBe(true);
    expect(index[0].participant_summary_updated_at).toBe('2026-06-01T00:02:00.000Z');
  });

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
    const projectDir = path.join(tmpDir, TEST_UID, 'cloud', 'projects', 'p_project1');
    fs.mkdirSync(projectDir, { recursive: true });
    fs.writeFileSync(path.join(projectDir, 'project.json'), JSON.stringify({
      project_id: 'p_project1',
      name: 'Recovered project',
      owner_uid: TEST_UID,
      created_at: '2026-05-28T01:00:00.000Z',
      updated_at: '2026-05-28T01:00:00.000Z',
    }));
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
    await chats.repairConversationIndex(TEST_UID);
    const listed = await chats.listConversations(TEST_UID);
    const repaired = listed.find((c) => c.conversation_id === cid);

    expect(repaired?.title).toBe('项目任务');
    expect(repaired?.project_id).toBe('p_project1');
    expect(repaired?.session_id).toBe(`gconv-${cid}`);
  });

  it('treats a sync-stamped index row as authoritative over duplicate meta', async () => {
    const cid = 'abc123def456';
    const chatsDir = path.join(tmpDir, TEST_UID, 'cloud', 'chats');
    fs.mkdirSync(path.join(chatsDir, cid), { recursive: true });
    fs.writeFileSync(path.join(chatsDir, `${cid}.jsonl`), '');
    fs.writeFileSync(path.join(chatsDir, '_index.json'), JSON.stringify([
      {
        conversation_id: cid,
        title: 'synced task',
        kind: 'normal',
        agent_id: '',
        skill_id: '',
        session_id: `gconv-${cid}`,
        created_at: '2026-06-10T01:00:00.000Z',
        updated_at: '2026-06-10T01:00:00.000Z',
        _sync_rev: 4,
        _sync_device_id: 'device-remote',
      },
    ], null, 2));
    fs.writeFileSync(path.join(chatsDir, cid, 'meta.json'), JSON.stringify({
      conversation_id: cid,
      title: 'divergent duplicate meta',
      kind: 'normal',
      agent_id: '',
      skill_id: '',
      session_id: `gconv-${cid}`,
      pinned_at: '2026-06-09T23:00:00.000Z',
      created_at: '2026-06-10T01:00:00.000Z',
      // Even a misleading later timestamp must not make routine list loading
      // reopen and promote the duplicate recovery file over a versioned row.
      updated_at: '2099-06-10T01:00:00.000Z',
    }, null, 2));

    const metaFile = path.join(chatsDir, cid, 'meta.json');
    const readFileSpy = vi.spyOn(fs.promises, 'readFile');
    const readdirSpy = vi.spyOn(fs.promises, 'readdir');
    const chats = await loadChats();
    try {
      const listed = await chats.listConversations(TEST_UID);
      expect(listed).toHaveLength(1);
      expect(listed[0].conversation_id).toBe(cid);
      expect(listed[0].title).toBe('synced task');
      expect(listed[0].pinned_at).toBeUndefined();
    } finally {
      const openedMeta = readFileSpy.mock.calls.some(([file]) => String(file) === metaFile);
      expect(openedMeta).toBe(false);
      const enumeratedChatRoot = readdirSpy.mock.calls.some(([dir]) => String(dir) === chatsDir);
      expect(enumeratedChatRoot).toBe(false);
      readFileSpy.mockRestore();
      readdirSpy.mockRestore();
    }
  });

  it('still merges newer per-conversation meta for revisionless legacy rows', async () => {
    const cid = 'abc123def456';
    const chatsDir = path.join(tmpDir, TEST_UID, 'cloud', 'chats');
    fs.mkdirSync(path.join(chatsDir, cid), { recursive: true });
    fs.writeFileSync(path.join(chatsDir, `${cid}.jsonl`), '');
    fs.writeFileSync(path.join(chatsDir, '_index.json'), JSON.stringify([{
      conversation_id: cid,
      title: 'legacy index title',
      kind: 'normal',
      agent_id: '',
      skill_id: '',
      session_id: `gconv-${cid}`,
      created_at: '2026-06-10T01:00:00.000Z',
      updated_at: '2026-06-10T01:00:00.000Z',
    }], null, 2));
    fs.writeFileSync(path.join(chatsDir, cid, 'meta.json'), JSON.stringify({
      conversation_id: cid,
      title: 'newer legacy meta title',
      kind: 'normal',
      agent_id: '',
      skill_id: '',
      session_id: `gconv-${cid}`,
      created_at: '2026-06-10T01:00:00.000Z',
      updated_at: '2026-06-10T02:00:00.000Z',
    }, null, 2));

    const chats = await loadChats();
    const listed = await chats.listConversations(TEST_UID);

    expect(listed).toHaveLength(1);
    expect(listed[0].title).toBe('newer legacy meta title');
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
    await chats.repairConversationIndex(TEST_UID);
    const listed = await chats.listConversations(TEST_UID);
    const repaired = listed.find((c) => c.conversation_id === cid);

    expect(repaired?.title).toBe('同步过来的任务内容');
    expect(repaired?.session_id).toBe(`gconv-${cid}`);
    const idx = JSON.parse(fs.readFileSync(path.join(chatsDir, '_index.json'), 'utf-8'));
    expect(idx.some((c: any) => c.conversation_id === cid)).toBe(true);
  });

  it('does not recover unindexed JSONL files after repair admission is cancelled', async () => {
    const cid = 'abc123def456';
    const chatsDir = path.join(tmpDir, TEST_UID, 'cloud', 'chats');
    fs.mkdirSync(chatsDir, { recursive: true });
    fs.writeFileSync(path.join(chatsDir, `${cid}.jsonl`), `${JSON.stringify({
      id: 'm1',
      ts: '2026-05-28T01:02:03.000Z',
      from: 'user',
      text: 'should wait for the next repair',
    })}\n`);
    const controller = new AbortController();
    controller.abort();

    const chats = await loadChats();
    const cancelled = await chats.repairConversationIndex(TEST_UID, controller.signal);
    expect(cancelled.cancelled).toBe(true);
    expect(await chats.listConversations(TEST_UID)).toEqual([]);

    const completed = await chats.repairConversationIndex(TEST_UID);
    expect(completed.cancelled).toBeUndefined();
    expect((await chats.listConversations(TEST_UID)).map((row) => row.conversation_id)).toContain(cid);
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
    await chats.repairConversationIndex(TEST_UID);
    expect(await chats.listConversations(TEST_UID)).toEqual([]);
    expect(fs.existsSync(path.join(chatsDir, cid, 'meta.json'))).toBe(false);
  });

  it('prunes expired tombstones during deferred index repair', async () => {
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
    await chats.repairConversationIndex(TEST_UID);
    expect(await chats.listConversations(TEST_UID)).toEqual([]);
    const idx = JSON.parse(fs.readFileSync(path.join(chatsDir, '_index.json'), 'utf-8'));
    expect(idx).toEqual([]);
    expect(fs.existsSync(path.join(chatsDir, cid, 'meta.json'))).toBe(false);
    expect(fs.existsSync(jsonl)).toBe(false);
  });
});

describe('chats › deleteConversation', () => {
  it('exposes compact active ids for maintenance without tombstoned rows', async () => {
    const chats = await loadChats();
    const live = await chats.createConversation(TEST_UID);
    const deleted = await chats.createConversation(TEST_UID);
    await chats.deleteConversation(TEST_UID, deleted.conversation_id);

    expect(await chats.listActiveConversationIds(TEST_UID)).toEqual([live.conversation_id]);
  });

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
    await dropConv(TEST_UID, conv.conversation_id);
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
    await dropConv(TEST_UID, conv.conversation_id);
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
    await dropConv(TEST_UID, conv.conversation_id);
  });
});

describe('chats › sweepStaleProcessing', () => {
  const staleActiveAt = () => new Date(Date.now() - 60_000).toISOString();

  it('does not interrupt a conversation that started in the current process before the deferred sweep', async () => {
    const chats = await loadChats();
    const conv = await chats.createConversation(TEST_UID);
    const stateFile = path.join(
      tmpDir, TEST_UID, 'cloud', 'chats', conv.conversation_id, 'state.json');
    fs.mkdirSync(path.dirname(stateFile), { recursive: true });
    fs.writeFileSync(stateFile, JSON.stringify({
      version: 1,
      status: 'running',
      last_active_at: new Date().toISOString(),
      in_flight: ['79df9cc89f5f'],
    }));

    expect((await chats.sweepStaleProcessing()).swept).toBe(0);
    expect(JSON.parse(fs.readFileSync(stateFile, 'utf8')).status).toBe('running');
    expect(fs.readFileSync(
      path.join(tmpDir, TEST_UID, 'cloud', 'chats', `${conv.conversation_id}.jsonl`),
      'utf8',
    )).toBe('');
  });

  it('uses the indexed active-user fallback once when the journal is missing', async () => {
    const chats = await loadChats();
    const active = await chats.createConversation(TEST_UID);
    const otherUid = 'other-user';
    const users = await import('../../../src/main/features/users');
    users.activateUser(otherUid);
    const other = await chats.createConversation(otherUid);
    users.activateUser(TEST_UID);
    for (const [uid, cid] of [[TEST_UID, active.conversation_id], [otherUid, other.conversation_id]]) {
      const file = path.join(tmpDir, uid, 'cloud', 'chats', cid, 'state.json');
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify({
        version: 1, status: 'running', last_active_at: staleActiveAt(), in_flight: ['commander'],
      }));
    }

    expect((await chats.sweepStaleProcessing(TEST_UID)).swept).toBe(1);
    const activeState = JSON.parse(fs.readFileSync(
      path.join(tmpDir, TEST_UID, 'cloud', 'chats', active.conversation_id, 'state.json'), 'utf8'));
    const otherState = JSON.parse(fs.readFileSync(
      path.join(tmpDir, otherUid, 'cloud', 'chats', other.conversation_id, 'state.json'), 'utf8'));
    expect(activeState.status).toBe('idle');
    expect(otherState.status).toBe('running');
    const paths = await import('../../../src/main/paths');
    expect(JSON.parse(fs.readFileSync(
      paths.userRunningConversationsFile(TEST_UID), 'utf8')))
      .toEqual({ version: 1, items: [] });
  });

  it('normally reads only state files named by the compact running journal', async () => {
    const chats = await loadChats();
    const tracked = await chats.createConversation(TEST_UID);
    const unrelated = await chats.createConversation(TEST_UID);
    for (const cid of [tracked.conversation_id, unrelated.conversation_id]) {
      const file = path.join(tmpDir, TEST_UID, 'cloud', 'chats', cid, 'state.json');
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify({
        version: 1, status: 'running', last_active_at: staleActiveAt(), in_flight: [],
      }));
    }
    const paths = await import('../../../src/main/paths');
    const journal = paths.userRunningConversationsFile(TEST_UID);
    fs.mkdirSync(path.dirname(journal), { recursive: true });
    fs.writeFileSync(journal, JSON.stringify({
      version: 1,
      items: [{ conversation_id: tracked.conversation_id }],
    }));

    expect((await chats.sweepStaleProcessing(TEST_UID)).swept).toBe(1);
    expect(JSON.parse(fs.readFileSync(
      path.join(tmpDir, TEST_UID, 'cloud', 'chats', tracked.conversation_id, 'state.json'),
      'utf8')).status).toBe('idle');
    expect(JSON.parse(fs.readFileSync(
      path.join(tmpDir, TEST_UID, 'cloud', 'chats', unrelated.conversation_id, 'state.json'),
      'utf8')).status).toBe('running');
    expect(JSON.parse(fs.readFileSync(journal, 'utf8')))
      .toEqual({ version: 1, items: [] });
  });

  it('repairs a corrupt journal through the indexed migration fallback', async () => {
    const chats = await loadChats();
    const conv = await chats.createConversation(TEST_UID);
    const stateFile = path.join(
      tmpDir, TEST_UID, 'cloud', 'chats', conv.conversation_id, 'state.json');
    fs.mkdirSync(path.dirname(stateFile), { recursive: true });
    fs.writeFileSync(stateFile, JSON.stringify({
      version: 1, status: 'running', last_active_at: staleActiveAt(), in_flight: [],
    }));
    const paths = await import('../../../src/main/paths');
    const journal = paths.userRunningConversationsFile(TEST_UID);
    fs.mkdirSync(path.dirname(journal), { recursive: true });
    fs.writeFileSync(journal, JSON.stringify({
      version: 1, items: [{ conversation_id: '../invalid' }],
    }));

    expect((await chats.sweepStaleProcessing(TEST_UID)).swept).toBe(1);
    expect(JSON.parse(fs.readFileSync(stateFile, 'utf8')).status).toBe('idle');
    expect(JSON.parse(fs.readFileSync(journal, 'utf8')))
      .toEqual({ version: 1, items: [] });
  });

  it('flips running state.json back to idle on boot', async () => {
    const chats = await loadChats();
    const conv = await chats.createConversation(TEST_UID);
    const stateFile = path.join(tmpDir, TEST_UID, 'cloud', 'chats', conv.conversation_id, 'state.json');
    fs.mkdirSync(path.dirname(stateFile), { recursive: true });
    fs.writeFileSync(stateFile, JSON.stringify({
      version: 1, status: 'running', last_active_at: staleActiveAt(), in_flight: ['79df9cc89f5f'],
    }));
    fs.writeFileSync(path.join(path.dirname(stateFile), 'members.json'), JSON.stringify({
      version: 1,
      actors: [{ kind: 'agent', id: '79df9cc89f5f', name: 'VideoStudio', joined_at: new Date().toISOString() }],
    }));
    // The state sweep is intentionally independent from conversation index,
    // meta, and history loading. Leave only the state-bearing directory.
    const chatsDir = path.join(tmpDir, TEST_UID, 'cloud', 'chats');
    fs.rmSync(path.join(chatsDir, '_index.json'), { force: true });
    fs.rmSync(path.join(chatsDir, conv.conversation_id, 'meta.json'), { force: true });
    fs.rmSync(path.join(chatsDir, `${conv.conversation_id}.jsonl`), { force: true });

    const res = await chats.sweepStaleProcessing();
    expect(res.swept).toBe(1);
    const after = JSON.parse(fs.readFileSync(stateFile, 'utf-8'));
    expect(after.status).toBe('idle');
    const recoveredMessages = fs.readFileSync(
      path.join(tmpDir, TEST_UID, 'cloud', 'chats', `${conv.conversation_id}.jsonl`),
      'utf8',
    ).trim().split('\n').map((line) => JSON.parse(line));
    expect(recoveredMessages).toEqual([
      expect.objectContaining({
        from: '79df9cc89f5f',
        to: ['user'],
        system_kind: 'reply_interrupted',
        text: expect.any(String),
        model_text: expect.stringContaining('interrupted'),
      }),
    ]);
    expect((await chats.sweepStaleProcessing()).swept).toBe(0);
    expect(fs.readFileSync(
      path.join(tmpDir, TEST_UID, 'cloud', 'chats', `${conv.conversation_id}.jsonl`),
      'utf8',
    ).trim().split('\n')).toHaveLength(1);
  });
});
