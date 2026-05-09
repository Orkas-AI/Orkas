import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// Mock the model client so cascade-delete (which calls
// `chats.deleteConversation`, which clears CLI sessions etc.) doesn't
// accidentally try real LLM calls. Same stub pattern as chats.test.ts.
vi.mock('../../../src/main/model/client', () => ({
  async *streamChatWithModel(_opts: any) {
    yield { type: 'final', text: '' };
    yield { type: 'done' };
  },
  async chatWithModel() { return { ok: true, text: '', error: '', aborted: false }; },
}));

let tmpDir: string;
let prevWs: string | undefined;
const TEST_UID = 'uProj';

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-projects-'));
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

async function loadProjects() {
  return import('../../../src/main/features/projects');
}
async function loadChats() {
  return import('../../../src/main/features/chats');
}

describe('projects › createProject', () => {
  it('persists `_index.json` with name + project_id starting with p_', async () => {
    const projects = await loadProjects();
    const r = await projects.createProject(TEST_UID, '  My Project  ');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.project.project_id).toMatch(/^p_[0-9a-f]{8}$/);
    expect(r.project.name).toBe('My Project');                 // trimmed
    expect(r.project.created_at).toBeTruthy();
    expect(r.project.updated_at).toBe(r.project.created_at);
    const idxFile = path.join(tmpDir, TEST_UID, 'cloud', 'projects', '_index.json');
    const idx = JSON.parse(fs.readFileSync(idxFile, 'utf-8'));
    expect(idx).toHaveLength(1);
    expect(idx[0].project_id).toBe(r.project.project_id);
  });

  it('rejects empty / whitespace-only names with name_empty', async () => {
    const projects = await loadProjects();
    const r1 = await projects.createProject(TEST_UID, '');
    expect(r1.ok).toBe(false);
    if (!r1.ok) expect(r1.error).toBe('name_empty');
    const r2 = await projects.createProject(TEST_UID, '   ');
    expect(r2.ok).toBe(false);
    if (!r2.ok) expect(r2.error).toBe('name_empty');
  });

  it('rejects case-insensitive duplicate names with name_dup', async () => {
    const projects = await loadProjects();
    const ok = await projects.createProject(TEST_UID, 'Alpha');
    expect(ok.ok).toBe(true);

    // Exact dup.
    const dup1 = await projects.createProject(TEST_UID, 'Alpha');
    expect(dup1.ok).toBe(false);
    if (!dup1.ok) expect(dup1.error).toBe('name_dup');

    // Case-insensitive dup.
    const dup2 = await projects.createProject(TEST_UID, 'ALPHA');
    expect(dup2.ok).toBe(false);
    if (!dup2.ok) expect(dup2.error).toBe('name_dup');

    // Whitespace-trimmed dup.
    const dup3 = await projects.createProject(TEST_UID, '   alpha  ');
    expect(dup3.ok).toBe(false);
    if (!dup3.ok) expect(dup3.error).toBe('name_dup');
  });

  it('per-user isolation: same name allowed across users', async () => {
    const projects = await loadProjects();
    const users = await import('../../../src/main/features/users');
    users.activateUser('userA');
    const a = await projects.createProject('userA', 'Shared');
    expect(a.ok).toBe(true);
    users.activateUser('userB');
    const b = await projects.createProject('userB', 'Shared');
    expect(b.ok).toBe(true);
  });
});

describe('projects › listProjects', () => {
  it('returns conv_count derived from chats index', async () => {
    const projects = await loadProjects();
    const chats = await loadChats();
    const p = await projects.createProject(TEST_UID, 'Proj');
    if (!p.ok) throw new Error('precondition');
    const pid = p.project.project_id;

    await chats.createConversation(TEST_UID, { title: 'c1', projectId: pid });
    await chats.createConversation(TEST_UID, { title: 'c2', projectId: pid });
    await chats.createConversation(TEST_UID, { title: 'unprojected' });

    const list = await projects.listProjects(TEST_UID);
    expect(list).toHaveLength(1);
    expect(list[0].project_id).toBe(pid);
    expect(list[0].conv_count).toBe(2);
  });

  it('returns [] when no projects exist (does not crash on missing _index.json)', async () => {
    const projects = await loadProjects();
    const list = await projects.listProjects(TEST_UID);
    expect(list).toEqual([]);
  });
});

describe('projects › renameProject', () => {
  it('updates name + bumps updated_at', async () => {
    const projects = await loadProjects();
    const p = await projects.createProject(TEST_UID, 'Old');
    if (!p.ok) throw new Error('precondition');
    // updated_at granularity is seconds — sleep one tick so the bump is observable.
    await new Promise((r) => setTimeout(r, 1100));
    const r = await projects.renameProject(TEST_UID, p.project.project_id, 'New');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.project.name).toBe('New');
    expect(r.project.updated_at >= p.project.updated_at).toBe(true);
  });

  it('rejects rename to existing other project name (case-insensitive) with name_dup', async () => {
    const projects = await loadProjects();
    const a = await projects.createProject(TEST_UID, 'Alpha');
    const b = await projects.createProject(TEST_UID, 'Beta');
    if (!a.ok || !b.ok) throw new Error('precondition');
    const r = await projects.renameProject(TEST_UID, b.project.project_id, 'alpha');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe('name_dup');
  });

  it('renaming to the SAME name (no change) is a no-op success, not name_dup', async () => {
    const projects = await loadProjects();
    const p = await projects.createProject(TEST_UID, 'Same');
    if (!p.ok) throw new Error('precondition');
    const r = await projects.renameProject(TEST_UID, p.project.project_id, 'Same');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.project.name).toBe('Same');
  });

  it('rejects with not_found when projectId does not exist', async () => {
    const projects = await loadProjects();
    const r = await projects.renameProject(TEST_UID, 'p_deadbeef', 'X');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe('not_found');
  });
});

describe('projects › deleteProject', () => {
  it('cascades: every conv with project_id is dropped + project record removed', async () => {
    const projects = await loadProjects();
    const chats = await loadChats();
    const p = await projects.createProject(TEST_UID, 'Cascade');
    if (!p.ok) throw new Error('precondition');
    const pid = p.project.project_id;
    const c1 = await chats.createConversation(TEST_UID, { projectId: pid });
    const c2 = await chats.createConversation(TEST_UID, { projectId: pid });
    const cOuter = await chats.createConversation(TEST_UID);  // unprojected — must NOT be dropped

    const r = await projects.deleteProject(TEST_UID, pid);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.deleted_convs).toBe(2);

    const remaining = await chats.listConversations(TEST_UID);
    const ids = remaining.map((c) => c.conversation_id).sort();
    expect(ids).toEqual([cOuter.conversation_id]);

    // Project record gone.
    const list = await projects.listProjects(TEST_UID);
    expect(list).toEqual([]);

    // Per-conv jsonl files for c1/c2 dropped (cascade actually deletes).
    expect(fs.existsSync(path.join(tmpDir, TEST_UID, 'cloud', 'chats', `${c1.conversation_id}.jsonl`))).toBe(false);
    expect(fs.existsSync(path.join(tmpDir, TEST_UID, 'cloud', 'chats', `${c2.conversation_id}.jsonl`))).toBe(false);
  });

  it('refuses with has_running_conv when any owned conv is `running`', async () => {
    const projects = await loadProjects();
    const chats = await loadChats();
    const { setStatus } = await import('../../../src/main/features/group_chat/state');
    const p = await projects.createProject(TEST_UID, 'Busy');
    if (!p.ok) throw new Error('precondition');
    const pid = p.project.project_id;
    const c = await chats.createConversation(TEST_UID, { projectId: pid });
    await setStatus(TEST_UID, c.conversation_id, 'running');

    const r = await projects.deleteProject(TEST_UID, pid);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe('has_running_conv');

    // Project + conv must still be present (refusal should not partially delete).
    const list = await projects.listProjects(TEST_UID);
    expect(list).toHaveLength(1);
    const convs = await chats.listConversations(TEST_UID);
    expect(convs.find((x) => x.conversation_id === c.conversation_id)).toBeDefined();
  });

  it('purges per-project workspace selection from workspace.json', async () => {
    const projects = await loadProjects();
    const ws = await import('../../../src/main/features/user_workspace');
    const p = await projects.createProject(TEST_UID, 'WithWs');
    if (!p.ok) throw new Error('precondition');
    const pid = p.project.project_id;

    const dir = path.join(tmpDir, 'project-ws');
    fs.mkdirSync(dir, { recursive: true });
    const setRes = ws.setWorkspacePath(TEST_UID, dir, pid);
    expect(setRes.ok).toBe(true);

    // Sanity: workspace.json now has the project bucket.
    const cfgFile = path.join(tmpDir, TEST_UID, 'local', 'workspace.json');
    const before = JSON.parse(fs.readFileSync(cfgFile, 'utf-8'));
    expect(before.projects?.[pid]?.selectedPath).toBe(dir);

    const r = await projects.deleteProject(TEST_UID, pid);
    expect(r.ok).toBe(true);

    const after = JSON.parse(fs.readFileSync(cfgFile, 'utf-8'));
    expect(after.projects?.[pid]).toBeUndefined();
  });

  it('returns not_found for unknown projectId without touching anything', async () => {
    const projects = await loadProjects();
    const chats = await loadChats();
    await chats.createConversation(TEST_UID, { title: 'untouched' });

    const r = await projects.deleteProject(TEST_UID, 'p_deadbeef');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe('not_found');

    const convs = await chats.listConversations(TEST_UID);
    expect(convs).toHaveLength(1);
  });
});

describe('projects › projectExists', () => {
  it('true for known pid, false for unknown / empty', async () => {
    const projects = await loadProjects();
    const p = await projects.createProject(TEST_UID, 'X');
    if (!p.ok) throw new Error('precondition');
    expect(await projects.projectExists(TEST_UID, p.project.project_id)).toBe(true);
    expect(await projects.projectExists(TEST_UID, 'p_nosuch00')).toBe(false);
    expect(await projects.projectExists(TEST_UID, '')).toBe(false);
  });
});
