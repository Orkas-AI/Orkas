import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// Executable coverage for the automatable parts of the old PC core regression
// checklist. Browser-only OAuth, real provider calls, native update checks, and
// full UI affordances remain better suited to integration/e2e tests.

const TEST_UID = 'u1';

let tmpDir: string;
let prevWs: string | undefined;

vi.mock('../../src/main/model/client', () => ({
  async *streamChatWithModel() {
    yield { type: 'final', text: '' };
    yield { type: 'done' };
  },
  async chatWithModel() {
    return { ok: true, text: 'ok', error: '', aborted: false };
  },
}));

const kbEnqueueCalls: Array<{ userId: string; relPath: string; op: string }> = [];
vi.mock('../../src/main/features/kb_indexer', () => ({
  enqueue: (userId: string, relPath: string, op = 'upsert') => {
    kbEnqueueCalls.push({ userId, relPath, op });
  },
  kbEvents: { on: () => {}, off: () => {}, emit: () => {} },
}));

const searchCalls: Array<{ action: string; userId: string; path: string }> = [];
vi.mock('../../src/main/features/search', () => ({
  upsertContext: (userId: string, path: string) => {
    searchCalls.push({ action: 'upsert', userId, path });
  },
  dropContext: (userId: string, path: string) => {
    searchCalls.push({ action: 'drop', userId, path });
  },
  dropChatConversation: vi.fn(),
}));

vi.mock('../../src/main/features/sync', () => ({
  markDirty: vi.fn(),
}));

vi.mock('../../src/main/features/file_indexer', () => ({
  invalidateFileCache: vi.fn(),
  purgeFileCacheByCid: vi.fn(async () => 0),
  statFile: vi.fn(async () => ({ ok: true })),
  getCachedMeta: vi.fn(() => null),
}));

vi.mock('../../src/main/util/image-transform', () => ({
  toCompressedGrayJpeg: vi.fn(async () => Buffer.from('jpeg')),
}));

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-core-regression-'));
  prevWs = process.env.ORKAS_WORKSPACE_ROOT;
  process.env.ORKAS_WORKSPACE_ROOT = tmpDir;
  kbEnqueueCalls.length = 0;
  searchCalls.length = 0;
  vi.resetModules();
  const users = await import('../../src/main/features/users');
  users.activateUser(TEST_UID);
});

afterEach(() => {
  process.env.ORKAS_WORKSPACE_ROOT = prevWs;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function userPath(...parts: string[]): string {
  return path.join(tmpDir, TEST_UID, ...parts);
}

describe('PC core regression unit coverage', () => {
  it('[PC-AUTH-003] switches between account and anonymous local users with isolated roots', async () => {
    const users = await import('../../src/main/features/users');

    users.switchToAnonymousLocalId();
    expect(users.getActiveUserId()).toBe(users.ANONYMOUS_LOCAL_ID);
    const anonymousMarker = path.join(tmpDir, users.ANONYMOUS_LOCAL_ID, 'cloud', 'marker.txt');
    fs.mkdirSync(path.dirname(anonymousMarker), { recursive: true });
    fs.writeFileSync(anonymousMarker, 'anonymous data');

    users.switchToAccountLocalId('account_regression');
    expect(users.getActiveUserId()).toBe('account_regression');
    expect(fs.existsSync(path.join(tmpDir, 'account_regression', 'cloud', 'marker.txt'))).toBe(true);

    users.switchToAnonymousLocalId();
    expect(users.getActiveUserId()).toBe(users.ANONYMOUS_LOCAL_ID);
    expect(fs.existsSync(path.join(tmpDir, users.ANONYMOUS_LOCAL_ID, 'cloud'))).toBe(true);
  });

  it('[PC-MODEL-001][PC-MODEL-003][PC-MODEL-004] persists credentials, priority, and key stores without plaintext leaks', async () => {
    const auth = await import('../../src/main/features/auth');
    const searchAuth = await import('../../src/main/features/search_auth');
    const imageAuth = await import('../../src/main/features/image_auth');
    const paths = await import('../../src/main/paths');

    const primary = await auth.addApiKey('openai', 'sk-primary-regression-xxxxxxxx', 'Primary');
    const backup = await auth.addApiKey('openai', 'sk-backup-regression-xxxxxxxx', 'Backup');
    const first = await auth.addEntry({
      provider: 'openai',
      model: 'gpt-5.5',
      profileId: primary.profileId,
    });
    const second = await auth.addEntry({
      provider: 'openai',
      model: 'gpt-5.4',
      profileId: backup.profileId,
    });

    let entries = (await auth.listEntries()).entries;
    expect(entries.map((entry) => entry.profileId)).toEqual([backup.profileId, primary.profileId]);
    await auth.reorderEntries([second.entryId, first.entryId]);
    entries = (await auth.listEntries()).entries;
    expect(entries.map((entry) => entry.entryId)).toEqual([second.entryId, first.entryId]);
    await auth.updateEntryModel(second.entryId, 'gpt-5.5-pro');
    expect((await auth.listEntries()).entries[0].model).toBe('gpt-5.5-pro');

    const search = searchAuth.addSearchProfile({
      provider: 'tavily',
      apiKey: 'tvly-regression-secret',
      label: 'search',
    });
    const image = imageAuth.addImageProfile({
      provider: 'openai',
      apiKey: 'img-regression-secret',
      label: 'image',
    });
    expect(search.ok).toBe(true);
    expect(image.ok).toBe(true);
    expect(searchAuth.pickActiveSearchProfile()?.provider).toBe('tavily');
    expect(imageAuth.listImageProfiles().map((profile) => profile.provider)).toEqual(['openai']);

    expect(await auth.removeCredential(primary.profileId)).toEqual({ removed: true });
    expect((await auth.listEntries()).entries.map((entry) => entry.profileId)).toEqual([backup.profileId]);

    const raw = fs.readFileSync(paths.userAuthProfilesFile(TEST_UID), 'utf8');
    const localSecrets = await import('../../src/main/util/local-secret-store');
    expect(localSecrets.isEncryptedSecret(raw)).toBe(true);
    expect(raw).not.toContain('sk-primary-regression-xxxxxxxx');
    expect(raw).not.toContain('sk-backup-regression-xxxxxxxx');
    expect(raw).not.toContain('tvly-regression-secret');
    expect(raw).not.toContain('img-regression-secret');
  });

  it('[PC-CHAT-001][PC-CHAT-004] persists, pins, and deletes conversations with cascade files', async () => {
    const chats = await import('../../src/main/features/chats');

    const first = await chats.createConversation(TEST_UID, { title: 'first task' });
    const second = await chats.createConversation(TEST_UID, { title: 'second task' });

    expect(first.conversation_id).toMatch(/^[0-9a-f]{12}$/);
    expect(first.session_id).toBe(`gconv-${first.conversation_id}`);
    expect(fs.existsSync(userPath('cloud', 'chats', `${first.conversation_id}.jsonl`))).toBe(true);

    await chats.setConversationPinned(TEST_UID, first.conversation_id, true);
    expect((await chats.listConversations(TEST_UID))[0].conversation_id).toBe(first.conversation_id);

    const groupDir = userPath('cloud', 'chats', second.conversation_id);
    fs.mkdirSync(path.join(groupDir, 'visibility'), { recursive: true });
    fs.writeFileSync(path.join(groupDir, 'state.json'), '{"version":1,"status":"idle"}');
    expect(await chats.deleteConversation(TEST_UID, second.conversation_id)).toBe(true);
    expect(fs.existsSync(userPath('cloud', 'chats', `${second.conversation_id}.jsonl`))).toBe(false);
    expect(fs.existsSync(groupDir)).toBe(false);
  });

  it('[PC-FILE-001][PC-FILE-003] enforces attachment whitelist, dedupes, lists, and deletes files', async () => {
    const attachments = await import('../../src/main/features/chat_attachments');
    const cid = 'cid_regression';

    const text = await attachments.uploadAttachment(TEST_UID, cid, 'note.md', Buffer.from('# note'));
    expect(text.ok).toBe(true);
    if (text.ok) expect(text.info.kind).toBe('text');

    const duplicate = await attachments.uploadAttachment(TEST_UID, cid, 'copy.md', Buffer.from('# note'));
    expect(duplicate.ok).toBe(true);
    if (duplicate.ok) expect(duplicate.reused).toBe(true);

    const rejected = await attachments.uploadAttachment(TEST_UID, cid, 'malware.exe', Buffer.from('x'));
    expect(rejected.ok).toBe(false);

    expect(attachments.listAttachments(TEST_UID, cid).map((x) => x.name)).toEqual(['note.md']);
    expect(attachments.deleteAttachment(TEST_UID, cid, 'note.md').ok).toBe(true);
    expect(attachments.listAttachments(TEST_UID, cid)).toEqual([]);
  });

  it('[PC-FILE-004] creates, serves, saves, edits, and deletes interactive app artifacts', async () => {
    const artifacts = await import('../../src/main/features/chat_artifacts');
    const savedApps = await import('../../src/main/features/saved_apps');
    const cid = 'cid_artifact_regression';

    const created = artifacts.createArtifact(TEST_UID, cid, 'RegressionAgent', {
      title: 'Regression App',
      files: [
        { path: 'index.html', content: '<!doctype html><script src="assets/app.js"></script><h1>Regression</h1>' },
        { path: 'assets/app.js', content: 'window.result = 42;' },
      ],
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const resolved = artifacts.resolveArtifactFilePath(TEST_UID, cid, created.artifactId, 'index.html');
    expect(resolved.ok).toBe(true);
    if (resolved.ok) {
      expect(resolved.mime).toBe('text/html; charset=utf-8');
      expect(fs.readFileSync(resolved.absPath, 'utf8')).toContain('Regression');
    }
    expect(artifacts.resolveArtifactFilePath(TEST_UID, cid, created.artifactId, '../secrets.txt').ok).toBe(false);

    const saved = savedApps.saveFromArtifact(TEST_UID, cid, created.artifactId);
    expect(saved.ok).toBe(true);
    if (!saved.ok) return;
    expect(savedApps.listSavedApps(TEST_UID).map((app) => app.title)).toEqual(['Regression App']);
    expect(savedApps.renameSavedApp(TEST_UID, saved.id, 'Renamed App')).toEqual({
      ok: true,
      title: 'Renamed App',
    });

    const edit = await savedApps.openForEditing(TEST_UID, saved.id);
    expect(edit.ok).toBe(true);
    if (edit.ok) {
      const conversation = edit.conversation as { conversation_id: string };
      const source = fs.readFileSync(
        userPath('cloud', 'chat_attachments', conversation.conversation_id, edit.sourceFileName),
        'utf8',
      );
      expect(source).toContain('========== FILE: index.html ==========');
      expect(source).toContain('========== FILE: assets/app.js ==========');
    }

    expect(savedApps.deleteSavedApp(TEST_UID, saved.id).ok).toBe(true);
    expect(savedApps.listSavedApps(TEST_UID)).toEqual([]);
  });

  it('[PC-AGENT-001][PC-AGENT-002][PC-AGENT-003][PC-AGENT-004][PC-COLLAB-004] creates, toggles, configures, and deletes agents', async () => {
    const agents = await import('../../src/main/features/agents');
    const enabled = await import('../../src/main/features/component_enabled');

    const agent = await agents.createCustomAgent({
      name: 'RegressionAgent',
      description_en: 'Regression agent',
      workflow: 'Answer briefly.',
      output_format: 'text',
      runtime: { kind: 'cli', cli: 'codex' },
    });
    expect(agent?.agent_id).toBeTruthy();
    expect(agent?.output_format).toBe('text');
    expect(agent?.runtime).toEqual({ kind: 'cli', cli: 'codex' });

    const agentId = agent!.agent_id;
    expect(enabled.isAgentEnabled(TEST_UID, agentId)).toBe(true);
    enabled.setAgentEnabled(TEST_UID, agentId, false);
    expect(enabled.isAgentEnabled(TEST_UID, agentId)).toBe(false);
    enabled.setAgentEnabled(TEST_UID, agentId, true);
    expect(enabled.isAgentEnabled(TEST_UID, agentId)).toBe(true);

    const customDir = path.join(tmpDir, 'repo');
    fs.mkdirSync(customDir);
    const dirInfo = await agents.setAgentCliProjectDir(TEST_UID, agentId, customDir);
    expect(dirInfo.effective_path).toBe(customDir);
    expect(dirInfo.exists).toBe(true);

    expect(await agents.deleteCustomAgent(agentId)).toBe(true);
    expect(fs.existsSync(userPath('cloud', 'agents', agentId))).toBe(false);
  });

  it('[PC-SKILL-001][PC-SKILL-002][PC-SKILL-003] creates, updates, toggles, and deletes custom skills', async () => {
    const skills = await import('../../src/main/features/skills');
    const enabled = await import('../../src/main/features/component_enabled');

    const created = await skills.createCustomSkill('RegressionSkill', 'Regression skill');
    expect(created?.id).toBe('RegressionSkill');
    expect(fs.existsSync(userPath('cloud', 'skills', 'RegressionSkill', 'SKILL.md'))).toBe(true);

    const updated = await skills.updateCustomSkill('RegressionSkill', {
      description_en: 'Updated description',
      category: 'general',
    });
    expect(updated?.description_en).toBe('Updated description');

    expect(enabled.isSkillEnabled(TEST_UID, 'RegressionSkill')).toBe(true);
    enabled.setSkillEnabled(TEST_UID, 'RegressionSkill', false);
    expect(enabled.isSkillEnabled(TEST_UID, 'RegressionSkill')).toBe(false);

    expect(await skills.deleteCustomSkill('RegressionSkill')).toBe(true);
    expect(fs.existsSync(userPath('cloud', 'skills', 'RegressionSkill'))).toBe(false);
  });

  it('[PC-KB-001][PC-KB-002][PC-KB-004] validates library paths, uploads allowed files, rejects unsafe files, and deletes cleanly', async () => {
    const contexts = await import('../../src/main/features/contexts');

    expect(contexts.createContextDir('regression').ok).toBe(true);
    const write = contexts.writeContextFile('regression/note.md', '# Regression');
    expect(write.ok).toBe(true);
    expect(kbEnqueueCalls).toContainEqual({ userId: TEST_UID, relPath: 'regression/note.md', op: 'upsert' });
    expect(searchCalls).toContainEqual({ action: 'upsert', userId: TEST_UID, path: 'regression/note.md' });

    const upload = contexts.uploadContextFile('regression/doc.pdf', Buffer.from('%PDF-1.4\n'));
    expect(upload.ok).toBe(true);
    expect(contexts.uploadContextFile('regression/app.exe', Buffer.from('x')).ok).toBe(false);
    expect(contexts.renameContextEntry('regression/note.md', 'regression/renamed.md').ok).toBe(true);
    expect(contexts.writeContextFile('../evil.md', 'x').ok).toBe(false);

    expect(contexts.deleteContextTarget('regression/renamed.md').ok).toBe(true);
    expect(kbEnqueueCalls).toContainEqual({ userId: TEST_UID, relPath: 'regression/renamed.md', op: 'delete' });
  });

  it('[PC-PROJ-001][PC-PROJ-002][PC-WORK-001][PC-COLLAB-004] keeps project conversations and bindings scoped on disk', async () => {
    const projects = await import('../../src/main/features/projects');
    const chats = await import('../../src/main/features/chats');

    const projectRes = await projects.createProject(TEST_UID, 'Regression Project');
    expect(projectRes.ok).toBe(true);
    const project = projectRes.ok ? projectRes.project : null;
    expect(project?.project_id).toMatch(/^p_[0-9a-f]{12}$/);

    const conv = await chats.createConversation(TEST_UID, {
      title: 'project task',
      projectId: project!.project_id,
    });
    expect(conv.project_id).toBe(project!.project_id);

    await projects.addAgentBinding(TEST_UID, project!.project_id, 'agent_a');
    await projects.addSkillBinding(TEST_UID, project!.project_id, 'skill_a');
    expect(await projects.resolveProjectScope(TEST_UID, project!.project_id)).toEqual({
      agents: ['agent_a'],
      skills: ['skill_a'],
    });

    await projects.removeAgentBinding(TEST_UID, project!.project_id, 'agent_a');
    expect((await projects.getBindings(TEST_UID, project!.project_id)).agents).toEqual([]);
  });

  it('[PC-MODEL-004][PC-PERM-001] persists local execution permission changes', async () => {
    const permissions = await import('../../src/main/features/permissions');

    expect(permissions.getLocalExecGranted()).toBe(true);
    const revoked = permissions.revokeLocalExec();
    expect(revoked.granted).toBe(false);
    expect(permissions.getLocalExecGranted()).toBe(false);

    const granted = permissions.grantLocalExec();
    expect(granted.granted).toBe(true);
    expect(permissions.getLocalExecGranted()).toBe(true);

    const file = userPath('local', 'config', 'permissions.json');
    // Persisted shape is now the three-mode model; grantLocalExec → allow_all.
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).localExec.mode).toBe('allow_all');
  });

  it('[PC-CONN-002] stores connector soft-disable separately from disconnect state', async () => {
    const enabled = await import('../../src/main/features/component_enabled');

    expect(enabled.isConnectorEnabled(TEST_UID, 'google-calendar')).toBe(true);
    enabled.setConnectorEnabled(TEST_UID, 'google-calendar', false);
    expect(enabled.isConnectorEnabled(TEST_UID, 'google-calendar')).toBe(false);
    expect(enabled.readDisabledSets(TEST_UID).connectors.has('google-calendar')).toBe(true);
    enabled.setConnectorEnabled(TEST_UID, 'google-calendar', true);
    expect(enabled.isConnectorEnabled(TEST_UID, 'google-calendar')).toBe(true);
  });

  it('[PC-AUTO-001][PC-AUTO-002][PC-AUTO-003] evaluates one-time and recurring schedules against real boundaries', async () => {
    const auto = await import('../../src/main/features/auto_tasks');
    const base = {
      id: 'auto_regression',
      enabled: true,
      content: 'run',
      created_at: '2026-05-01T00:00:00.000Z',
      updated_at: '2026-05-01T00:00:00.000Z',
    };

    expect(auto.isDue(
      { ...base, schedule: { type: 'one_time', at: '2026-05-29T09:00:00.000Z' } },
      new Date('2026-05-29T09:00:00.000Z'),
      null,
    )).toBe(true);
    expect(auto.isDue(
      { ...base, schedule: { type: 'daily', hour: 9, minute: 0 } },
      new Date(2026, 4, 29, 8, 59, 0),
      null,
    )).toBe(false);
    expect(auto.isDue(
      { ...base, schedule: { type: 'monthly', day: 31, hour: 9, minute: 0 } },
      new Date(2026, 3, 30, 9, 0, 0),
      null,
    )).toBe(true);
    expect(auto.isDue(
      { ...base, enabled: false, schedule: { type: 'daily', hour: 9, minute: 0 } },
      new Date(2026, 4, 29, 9, 0, 0),
      null,
    )).toBe(false);
  });

  it('[PC-AUTO-001][PC-AUTO-002][PC-AUTO-003][PC-AUTO-004] persists automation CRUD, attachments, project scope, and disabled state', async () => {
    const auto = await import('../../src/main/features/auto_tasks');
    const taskId = auto.allocateDraftTaskId();

    expect((await auto.uploadAttachment(TEST_UID, taskId, 'seed.md', Buffer.from('# seed'))).ok).toBe(true);
    expect(await auto.listAttachments(TEST_UID, taskId)).toEqual(['seed.md']);

    const created = await auto.createTask(TEST_UID, {
      id: taskId,
      title: 'Regression automation',
      content: 'Run the regression report',
      project_id: 'p_auto_regression',
      attachments: ['seed.md'],
      recipient: { kind: 'agent', id: 'agent_a', name: 'Agent A' },
      skill: { id: 'skill_a', name: 'Skill A' },
      connector: { id: 'connector_a', name: 'Connector A' },
      schedule: { type: 'weekly', weekday: 5, hour: 9, minute: 30 },
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    expect((await auto.createTask(TEST_UID, {
      content: '',
      schedule: { type: 'daily', hour: 9, minute: 0 },
    })).ok).toBe(false);
    expect((await auto.createTask(TEST_UID, {
      content: 'bad time',
      schedule: { type: 'daily', hour: 25, minute: 0 },
    })).ok).toBe(false);

    const configFile = userPath('cloud', 'auto_tasks', taskId, 'config.json');
    const config = JSON.parse(fs.readFileSync(configFile, 'utf8'));
    expect(config.project_id).toBe('p_auto_regression');
    expect(config.attachments).toEqual(['seed.md']);
    expect(config.schedule).toEqual({ type: 'weekly', weekday: 5, hour: 9, minute: 30 });

    expect((await auto.listTasks(TEST_UID, { projectId: 'p_auto_regression' })).map((task) => task.id)).toEqual([taskId]);
    expect(await auto.listTasks(TEST_UID, { projectId: null })).toEqual([]);

    const updated = await auto.updateTask(TEST_UID, taskId, {
      content: 'Updated report',
      schedule: { type: 'monthly', day: 31, hour: 10, minute: 0 },
      skill: null as any,
      connector: null as any,
    });
    expect(updated.ok).toBe(true);
    if (updated.ok) {
      expect(updated.task.content).toBe('Updated report');
      expect(updated.task.schedule).toEqual({ type: 'monthly', day: 31, hour: 10, minute: 0 });
      expect(updated.task.skill).toBeUndefined();
      expect(updated.task.connector).toBeUndefined();
    }

    const disabled = await auto.setTaskEnabled(TEST_UID, taskId, false);
    expect(disabled.ok).toBe(true);
    if (disabled.ok) expect(disabled.task.enabled).toBe(false);
    expect((await auto.deleteTask(TEST_UID, taskId)).ok).toBe(true);
    expect(fs.existsSync(userPath('cloud', 'auto_tasks', taskId))).toBe(false);
    auto.stopScheduler();
  });
});
