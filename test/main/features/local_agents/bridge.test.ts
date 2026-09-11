import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';

vi.mock('../../../../src/main/features/kb_embed', () => ({
  embedTexts: async (texts: string[]) => texts.map(() => {
    const v = new Array(512).fill(0);
    v[0] = 1;
    return v;
  }),
  embedQuery: async () => {
    const v = new Array(512).fill(0);
    v[0] = 1;
    return v;
  },
  closeEmbedder: () => {},
}));

// Re-importing the production logger for every isolated workspace leaves an
// electron-log file transport alive until the worker exits. On Windows that
// permanently locks the previous case's temp tree, so bridge behavior tests
// use a handle-free logger double.
vi.mock('../../../../src/main/logger', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

const bridgeConnectorMock = vi.hoisted(() => ({
  resolveVisibleConnectors: vi.fn(async () => [] as any[]),
  callTool: vi.fn(async () => ({ content: [{ type: 'text', text: 'connector result' }] })),
}));
const bridgeActionConfirmMock = vi.hoisted(() => ({
  request: vi.fn(async () => true),
}));
vi.mock('../../../../src/main/features/connectors', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../../src/main/features/connectors')>();
  return {
    ...actual,
    resolveVisibleConnectors: bridgeConnectorMock.resolveVisibleConnectors,
    callTool: bridgeConnectorMock.callTool,
  };
});
vi.mock('../../../../src/main/features/connectors/action_confirm', () => ({
  requestActionConfirm: bridgeActionConfirmMock.request,
}));

const browserHost = vi.hoisted(() => ({
  openModelWebAssist: vi.fn(async (..._args: any[]): Promise<Record<string, unknown>> => ({ ok: true })),
}));
vi.mock('../../../../src/main/features/web_assist', () => browserHost);

// orkas-bridge host: socket auth + skills surface + KB scope + permission gate.
// Connector methods are covered by their own feature tests; here we pin the
// bridge-specific contracts (token, path discipline, scope plumbing, gating).

const TEST_NODE = process.env.ORKAS_TEST_NODE || process.execPath;

const TEST_UID = 'u-bridge';
let tmpDir: string;
let prevWs: string | undefined;
let prevHome: string | undefined;

function customSkillsDir(): string {
  return path.join(tmpDir, TEST_UID, 'cloud', 'skills');
}

function writeSkill(root: string, id: string, name: string, body = 'follow these steps') {
  const dir = path.join(root, id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: d\n---\n${body}`);
}

/** Minimal NDJSON client against the bridge socket. */
function rpcOnce(socketPath: string, payload: Record<string, unknown>, timeoutMs = 4000): Promise<{ reply: unknown | null; closed: boolean }> {
  return new Promise((resolve) => {
    const socket = net.createConnection(socketPath);
    socket.setEncoding('utf8');
    let buf = '';
    let settled = false;
    const finish = (reply: unknown | null, closed: boolean) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve({ reply, closed });
    };
    const timer = setTimeout(() => finish(null, false), timeoutMs);
    socket.on('connect', () => socket.write(JSON.stringify(payload) + '\n'));
    socket.on('data', (chunk: string) => {
      buf += chunk;
      const idx = buf.indexOf('\n');
      if (idx >= 0) {
        clearTimeout(timer);
        finish(JSON.parse(buf.slice(0, idx)), false);
      }
    });
    socket.on('close', () => { clearTimeout(timer); finish(null, true); });
    socket.on('error', () => { clearTimeout(timer); finish(null, true); });
  });
}

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-bridge-'));
  prevWs = process.env.ORKAS_WORKSPACE_ROOT;
  prevHome = process.env.HOME;
  process.env.ORKAS_WORKSPACE_ROOT = tmpDir;
  process.env.HOME = path.join(tmpDir, 'home');
  fs.mkdirSync(path.join(tmpDir, 'home'), { recursive: true });
  vi.resetModules();
  bridgeConnectorMock.resolveVisibleConnectors.mockReset();
  bridgeConnectorMock.resolveVisibleConnectors.mockResolvedValue([]);
  bridgeConnectorMock.callTool.mockReset();
  bridgeConnectorMock.callTool.mockResolvedValue({
    content: [{ type: 'text', text: 'connector result' }],
  });
  bridgeActionConfirmMock.request.mockReset();
  bridgeActionConfirmMock.request.mockResolvedValue(true);
  const users = await import('../../../../src/main/features/users');
  users.activateUser(TEST_UID);
});

afterEach(async () => {
  const kb = await import('../../../../src/main/features/kb_vector');
  const cliPermissions = await import('../../../../src/main/features/local_agents/cli_permissions');
  kb.closeAllKb();
  cliPermissions._resetForTest();
  process.env.ORKAS_WORKSPACE_ROOT = prevWs;
  if (prevHome === undefined) delete process.env.HOME;
  else process.env.HOME = prevHome;
  fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

async function startTestBridge(opts: {
  projectId?: string;
  workingDir?: string;
  runId?: string;
  conversationTitle?: string;
  onPermissionWaitStart?: () => () => void;
  permissionPolicy?: 'inherit' | 'ask' | 'full_access';
  cli?: 'claude' | 'codex' | 'openclaw' | 'opencode' | 'hermes';
} = {}) {
  const { startBridge } = await import('../../../../src/main/features/local_agents/bridge');
  return startBridge({
    uid: TEST_UID,
    cid: 'c1',
    agentId: 'a1',
    agentName: 'Agent One',
    conversationTitle: opts.conversationTitle,
    onPermissionWaitStart: opts.onPermissionWaitStart,
    cli: opts.cli || 'codex',
    permissionPolicy: opts.permissionPolicy || 'ask',
    currentMessageId: 'current-message',
    ...(opts.projectId ? { projectId: opts.projectId } : {}),
    workingDir: opts.workingDir,
    runId: opts.runId || `t${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`,
    configDir: path.join(tmpDir, 'rundir'),
    sandboxEnv: {
      ORKAS_NODE: TEST_NODE,
      ORKAS_BUNDLED_NODE: TEST_NODE,
      ORKAS_PC_DIR: process.cwd(),
      ORKAS_WORKSPACE_ROOT: tmpDir,
      ELECTRON_RUN_AS_NODE: '1',
    },
  });
}

async function seedGlobalKbFile(relPath: string, content = `${relPath} body`): Promise<void> {
  const kb = await import('../../../../src/main/features/kb_vector');
  const embedding = new Array(512).fill(0);
  embedding[0] = 1;
  await kb.upsertFile(TEST_UID, {
    relPath,
    kind: 'text',
    bytes: Buffer.byteLength(content, 'utf8'),
    mtime: 1,
    sha1: `sha-${relPath}`,
    chunks: [{ title: relPath, content, embedding }],
  });
}

async function seedCurrentConversation(): Promise<void> {
  const chats = await import('../../../../src/main/features/chats');
  const layout = await import('../../../../src/main/util/project-layout');
  await chats.createConversation(TEST_UID, {
    conversationId: 'c1',
    title: 'Current bridge chat',
  });
  const file = layout.conversationMessageFile(TEST_UID, 'c1');
  fs.writeFileSync(file, [
    {
      id: 'prior',
      ts: '2026-07-30T01:00:00.000Z',
      from: 'user',
      to: ['a1'],
      text: 'PUBLIC_PRIOR_CONTEXT',
      model_text: 'PRIVATE_MODEL_TEXT',
      process: [{ type: 'progress', text: 'PRIVATE_PROCESS_TEXT' }],
    },
    {
      id: 'hidden-dispatch',
      ts: '2026-07-30T01:01:00.000Z',
      from: 'commander',
      to: ['a1'],
      text: 'PRIVATE_DISPATCH_TEXT',
      dispatch: true,
    },
    {
      id: 'current-message',
      ts: '2026-07-30T01:02:00.000Z',
      from: 'user',
      to: ['a1'],
      text: 'CURRENT_TRIGGER_TEXT',
    },
    {
      id: 'later',
      ts: '2026-07-30T01:03:00.000Z',
      from: 'commander',
      to: ['user'],
      text: 'LATER_CONCURRENT_TEXT',
    },
  ].map((row) => JSON.stringify(row)).join('\n') + '\n');
}

describe('local_agents/bridge › auth + skills', () => {
  it('reads live tasks and persists executor status updates while rejecting scope overrides and invalid writes', async () => {
    const projects = await import('../../../../src/main/features/projects');
    const tasks = await import('../../../../src/main/features/project_tasks');
    const project = await projects.createProject(TEST_UID, 'Backlog');
    const other = await projects.createProject(TEST_UID, 'Other');
    if (!project.ok || !other.ok) throw new Error('project fixture failed');
    const pid = project.project.project_id;
    const foreign = await tasks.createTask(TEST_UID, other.project.project_id, { title: 'foreign task' });
    const foreignAccount = await projects.createProject('other-account', 'Private');
    if (!foreign.ok || !foreignAccount.ok) throw new Error('foreign fixture failed');
    const privateTask = await tasks.createTask('other-account', foreignAccount.project.project_id, { title: 'private' });
    if (!privateTask.ok) throw new Error('private task fixture failed');
    const bridge = await startTestBridge({ projectId: pid });
    let id = 0;
    const read = async (params: Record<string, unknown>) => (await rpcOnce(bridge.socketPath, {
      id: ++id, token: bridge.token, method: 'todo_tasks', params,
    })).reply as any;
    try {
      expect(bridge.capabilities).toEqual(expect.arrayContaining(['tasks.read', 'tasks.write']));
      expect((await read({ action: 'list' })).result).toMatchObject({ tasks: [], next_offset: null });
      const creation = await read({ action: 'create', title: 'first', detail: 'full detail' });
      expect(creation.ok).toBe(true);
      const created = creation.result;
      expect(await tasks.getTask(TEST_UID, pid, created.task.id)).toMatchObject({ title: 'first', origin_cid: 'c1' });
      const duplicate = await read({ action: 'create', title: 'first', detail: 'do not replace' });
      expect(duplicate.result).toMatchObject({ alreadyExists: true, task: { id: created.task.id, detail: 'full detail' } });
      if (!created.ok) throw new Error('task fixture failed');
      await tasks.createTask(TEST_UID, pid, { title: 'second', depends_on: [created.task.id] });
      const first = await read({ action: 'list', limit: 1 });
      expect(first.ok).toBe(true);
      expect(first.result.tasks).toHaveLength(1);
      expect(first.result.next_offset).toBe(1);
      const second = await read({ action: 'list', offset: first.result.next_offset, limit: 1 });
      expect(second.result.next_offset).toBeNull();
      const all = [...first.result.tasks, ...second.result.tasks];
      expect(all).toEqual(expect.arrayContaining([
        expect.objectContaining({ title: 'first' }),
        expect.objectContaining({ title: 'second', depends_on: [created.task.id] }),
      ]));
      expect((await read({ action: 'update', task_id: created.task.id, status: 'review', result_ref: 'artifact-1' })).ok).toBe(true);
      expect((await read({ action: 'list' })).result.tasks).toContainEqual(expect.objectContaining({ id: created.task.id, status: 'review' }));
      const filtered = (await read({ action: 'list', status: 'review', limit: 1 })).result;
      expect(filtered).toMatchObject({ total: 1, next_offset: null, tasks: [{ id: created.task.id }], progress: { total: 2 } });
      expect(filtered.tasks[0]).not.toHaveProperty('detail');
      expect((await read({ action: 'get', task_id: created.task.id })).result.task).toMatchObject({ detail: 'full detail', result_ref: 'artifact-1' });
      for (const params of [
        { action: 'create', title: 'forbidden', project: other.project.project_id },
        { action: 'create', title: 'forbidden', userId: 'other-account' },
        { action: 'create', title: 'forbidden', project: '__global__' },
        { action: 'update', task_id: created.task.id, status: 'done', title: '' },
        { action: 'update', task_id: created.task.id, owner: 'another-agent' },
        { action: 'update', task_id: created.task.id, status: 'invalid' },
        ...['blocked', 'cancelled', 'in_progress', 'in_review'].flatMap(status => [
          { action: 'update', task_id: created.task.id, status },
          { action: 'create', title: 'Removed state', status },
        ]),
        { action: 'complete', task_id: created.task.id, project: other.project.project_id },
        { action: 'complete', task_id: created.task.id, userId: 'other-account' },
        { action: 'complete', task_id: foreign.task.id },
        { action: 'complete', task_id: privateTask.task.id },
        { action: 'get', task_id: foreign.task.id },
        { action: 'get', task_id: privateTask.task.id },
        { action: 'get', task_id: created.task.id, project: other.project.project_id },
        { action: 'list', project: other.project.project_id },
        { action: 'list', userId: 'another-user' },
        { action: 'list', offset: -1 },
        { action: 'list', limit: 51 },
      ]) expect((await read(params)).ok).toBe(false);
      expect(await tasks.getTask(TEST_UID, pid, created.task.id)).toMatchObject({ status: 'review', title: 'first', result_ref: 'artifact-1' });
      expect((await tasks.getTask(TEST_UID, other.project.project_id, foreign.task.id))?.status).toBe('todo');
      expect((await tasks.getTask('other-account', foreignAccount.project.project_id, privateTask.task.id))?.status).toBe('todo');
      expect((await read({ action: 'complete', task_id: created.task.id, result_ref: 'verified-1' })).ok).toBe(true);
      expect(await tasks.getTask(TEST_UID, pid, created.task.id)).toMatchObject({ status: 'done', result_ref: 'verified-1', origin_cid: 'c1' });
      expect((await read({ action: 'update', task_id: created.task.id, title: 'Edited in CLI', detail: 'Updated detail', owner: '' })).ok).toBe(true);
      expect(await tasks.getTask(TEST_UID, pid, created.task.id)).toMatchObject({ title: 'Edited in CLI', detail: 'Updated detail', origin_cid: 'c1', status: 'done' });
      expect(await tasks.listTasks(TEST_UID, '')).toEqual([]);
      await projects.deleteProject(TEST_UID, pid);
      expect((await read({ action: 'list' })).ok).toBe(false);
      expect((await read({ action: 'complete', task_id: created.task.id })).ok).toBe(false);
    } finally { await bridge.close(); }
    const unbound = await startTestBridge();
    try {
      expect(unbound.capabilities).not.toContain('tasks.read');
      const denied = await rpcOnce(unbound.socketPath, {
        id: 1, token: unbound.token, method: 'todo_tasks', params: { action: 'list' },
      });
      expect((denied.reply as any).ok).toBe(false);
    } finally { await unbound.close(); }
  });

  it('returns the same host execution facts to native Agents and the CLI without treating progress or a shared conversation as activity', async () => {
    const projects = await import('../../../../src/main/features/projects');
    const tasks = await import('../../../../src/main/features/project_tasks');
    const tb = await import('../../../../src/main/features/group_chat/task_board');
    const { createProjectTasksHandler } = await import('../../../../src/main/features/project_tasks_tool_handler');
    tb._resetForTest();
    const project = await projects.createProject(TEST_UID, 'Execution visibility');
    if (!project.ok) throw new Error('project fixture failed');
    const pid = project.project.project_id;
    const first = await tasks.createTask(TEST_UID, pid, { title: 'Active item', status: 'progress', origin_cid: 'c1' });
    const other = await tasks.createTask(TEST_UID, pid, { title: 'Unlinked item', status: 'progress', origin_cid: 'c1' });
    if (!first.ok || !other.ok) throw new Error('task fixture failed');
    const native = createProjectTasksHandler(TEST_UID, pid, 'c1', new Map(), { actorId: 'a1' });
    const bridge = await startTestBridge({ projectId: pid });
    let id = 0;
    const call = async (params: Record<string, unknown>) => (await rpcOnce(bridge.socketPath, {
      id: ++id, token: bridge.token, method: 'todo_tasks', params,
    })).reply as any;
    try {
      expect((await call({ action: 'list' })).result.tasks.every((task: any) => task.is_running === null)).toBe(true);
      const run = await tb.createTask(TEST_UID, 'c1', {
        assignee: 'a1', instruction: 'Execute', createdBy: 'commander', running: true,
        backlogTask: { project_id: pid, task_id: first.task.id },
      });
      const cli = (await call({ action: 'list' })).result.tasks;
      expect(cli).toEqual((await native.list()).tasks);
      expect(cli.find((task: any) => task.id === first.task.id)).toMatchObject({ is_running: true, is_current_run: true });
      expect(cli.find((task: any) => task.id === other.task.id)).toMatchObject({ is_running: null, is_current_run: false });
      const forged = await call({ action: 'update', task_id: other.task.id, is_running: true, status: 'done' });
      expect(forged.ok).toBe(false);
      expect((await tasks.getTask(TEST_UID, pid, other.task.id))?.status).toBe('progress');
      await tb.finishTask(TEST_UID, 'c1', run.task_id, 'failed');
      expect((await call({ action: 'list' })).result.tasks.find((task: any) => task.id === first.task.id))
        .toMatchObject({ status: 'progress', is_running: false, is_current_run: false });
      expect((await native.list()).tasks).toEqual((await call({ action: 'list' })).result.tasks);
    } finally {
      await bridge.close();
      tb._resetForTest();
    }
  });

  it('resolves CLI task owners inside the bound project and rejects owner lookup after an account switch', async () => {
    const projects = await import('../../../../src/main/features/projects');
    const tasks = await import('../../../../src/main/features/project_tasks');
    const paths = await import('../../../../src/main/paths');
    const users = await import('../../../../src/main/features/users');
    for (const [id, name] of [['aaa111bbb222', 'Backend Dev'], ['ccc333ddd444', 'Reviewer']]) {
      const dir = paths.agentDir(TEST_UID, id);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'agent.json'), JSON.stringify({ agent_id: id, name, description: 'agent', workflow: 'work', created_at: 't', updated_at: 't' }));
    }
    const project = await projects.createProject(TEST_UID, 'CLI owners');
    if (!project.ok) throw new Error('project fixture failed');
    const pid = project.project.project_id;
    await projects.addAgentBinding(TEST_UID, pid, 'aaa111bbb222');
    const bridge = await startTestBridge({ projectId: pid });
    let id = 0;
    const call = async (params: Record<string, unknown>) => (await rpcOnce(bridge.socketPath, {
      id: ++id, token: bridge.token, method: 'todo_tasks', params,
    })).reply as any;
    try {
      const created = await call({ action: 'create', title: 'Assigned work', owner: 'backenddev' });
      expect(created.ok).toBe(true);
      const tid = created.result.task.id;
      expect(await tasks.getTask(TEST_UID, pid, tid)).toMatchObject({ owner_agent: 'Backend Dev', owner_agent_id: 'aaa111bbb222', origin_cid: 'c1' });
      expect((await call({ action: 'update', task_id: tid, owner: 'Reviewer', title: 'Must not apply' })).ok).toBe(false);
      expect((await tasks.getTask(TEST_UID, pid, tid))?.title).toBe('Assigned work');
      expect((await call({ action: 'update', task_id: tid, owner: '' })).ok).toBe(true);
      expect(await tasks.getTask(TEST_UID, pid, tid)).not.toHaveProperty('owner_agent_id');
      users.activateUser('other-account');
      expect((await call({ action: 'update', task_id: tid, owner: 'Backend Dev' })).ok).toBe(false);
      expect(await tasks.getTask(TEST_UID, pid, tid)).not.toHaveProperty('owner_agent_id');
    } finally { await bridge.close(); }
  });

  it('shares native summary pagination and retrieves full multilingual details through get', async () => {
    const projects = await import('../../../../src/main/features/projects');
    const tasks = await import('../../../../src/main/features/project_tasks');
    const project = await projects.createProject(TEST_UID, 'Large backlog');
    if (!project.ok) throw new Error('project fixture failed');
    const pid = project.project.project_id;
    const detail = '待办内容'.repeat(500);
    for (let index = 0; index < 55; index++) {
      expect((await tasks.createTask(TEST_UID, pid, { title: `task ${index}-${'长'.repeat(180)}`, detail, status: index % 2 ? 'todo' : 'done' })).ok).toBe(true);
    }
    const bridge = await startTestBridge({ projectId: pid });
    try {
      const received: any[] = [];
      let offset: number | null = 0;
      let pages = 0;
      do {
        const { reply } = await rpcOnce(bridge.socketPath, {
          id: ++pages, token: bridge.token, method: 'todo_tasks',
          params: { action: 'list', offset, limit: 50 },
        });
        expect((reply as any).ok).toBe(true);
        const page = (reply as any).result;
        expect(Buffer.byteLength(JSON.stringify(page), 'utf8')).toBeLessThan(33_000);
        expect(page.progress.total).toBe(55);
        expect(page.tasks.length).toBeGreaterThan(0);
        for (const task of page.tasks) {
          expect(task).not.toHaveProperty('detail');
          expect(task).not.toHaveProperty('owner_agent_id');
        }
        received.push(...page.tasks);
        expect(pages).toBeLessThanOrEqual(55);
        if (page.next_offset !== null) expect(page.next_offset).toBe(offset! + page.tasks.length);
        offset = page.next_offset;
      } while (offset !== null);
      expect(pages).toBeGreaterThan(1);
      const { createProjectTasksHandler } = await import('../../../../src/main/features/project_tasks_tool_handler');
      const native = createProjectTasksHandler(TEST_UID, pid, 'c1', new Map());
      expect(await native.list()).toMatchObject({ total: 55, next_offset: 20 });
      expect((await native.list()).tasks).toHaveLength(20);
      expect(await native.list({ status: 'review' })).toMatchObject({ tasks: [], total: 0, next_offset: null, progress: { total: 55 } });
      expect(await native.list({ status: 'done', offset: 28 })).toMatchObject({ tasks: [], total: 28, next_offset: null });
      expect(await native.list({ offset: 999 })).toMatchObject({ tasks: [], total: 55, next_offset: null });
      const nativePage = await native.list({ offset: 50, limit: 50 });
      expect(nativePage.tasks.map(task => task.id)).toEqual(received.slice(50).map(task => task.id));
      const full = await rpcOnce(bridge.socketPath, {
        id: 100, token: bridge.token, method: 'todo_tasks', params: { action: 'get', task_id: received[0].id },
      });
      expect((full.reply as any).result.task.detail).toBe(detail);
      expect((full.reply as any).result).toEqual(await native.get(received[0].id));
      expect(received).toHaveLength(55);
      expect(new Set(received.map((task) => task.id)).size).toBe(55);
    } finally { await bridge.close(); }
  });

  it.each([
    ['claude', true],
    ['codex', true],
    ['openclaw', false],
    ['opencode', false],
    ['hermes', false],
  ] as const)('grants Agent memory according to the %s capability', async (cli, supported) => {
    const bridge = await startTestBridge({ cli });
    try {
      expect(bridge.capabilities.includes('memory.agent')).toBe(supported);
      if (!supported) {
        const result = await rpcOnce(bridge.socketPath, {
          id: 1,
          token: bridge.token,
          method: 'memory.agent',
          params: { action: 'add', content: 'must not persist' },
        });
        expect((result.reply as any).ok).toBe(false);
        expect((result.reply as any).error).toContain('unknown method');
      }
    } finally {
      await bridge.close();
    }
  });

  it('rejects a wrong token by destroying the connection (no error oracle)', async () => {
    const bridge = await startTestBridge();
    try {
      const r = await rpcOnce(bridge.socketPath, { id: 1, token: 'x'.repeat(48), method: 'skills.list', params: {} });
      expect(r.reply).toBeNull();
      expect(r.closed).toBe(true);
    } finally {
      await bridge.close();
    }
  });

  it('serves skills.list and skills.read for a listed skill', async () => {
    writeSkill(customSkillsDir(), 'my-skill', 'my-skill', 'the body');
    const bridge = await startTestBridge();
    try {
      const list = await rpcOnce(bridge.socketPath, { id: 1, token: bridge.token, method: 'skills.list', params: {} });
      const skills = (list.reply as any).result.skills;
      expect(skills.map((s: any) => s.id)).toContain('my-skill');

      const read = await rpcOnce(bridge.socketPath, { id: 2, token: bridge.token, method: 'skills.read', params: { id: 'my-skill' } });
      expect((read.reply as any).ok).toBe(true);
      expect((read.reply as any).result.skill_md).toContain('the body');
    } finally {
      await bridge.close();
    }
  });

  it('repairs a legacy disabled name before exposing canonical marketplace skills', async () => {
    const marketplaceRoot = path.join(tmpDir, TEST_UID, 'local', 'marketplace', 'skills');
    writeSkill(marketplaceRoot, '74e05fe08cc5', 'agent-browser');
    const enabled = await import('../../../../src/main/features/component_enabled');
    enabled.setSkillEnabled(TEST_UID, 'agent-browser', false);

    const bridge = await startTestBridge();
    try {
      const list = await rpcOnce(bridge.socketPath, {
        id: 21, token: bridge.token, method: 'skills.list', params: {},
      });

      expect((list.reply as any).result.skills.map((skill: any) => skill.id)).not.toContain('74e05fe08cc5');
      expect(bridge.getSkillDisplayName('74e05fe08cc5')).toBeNull();
      expect(enabled.readEnabledMap(TEST_UID).skills).toEqual({ '74e05fe08cc5': false });
    } finally {
      await bridge.close();
    }
  });

  it('skills.read refuses ids that are not in the listing (no generic file reads)', async () => {
    writeSkill(customSkillsDir(), 'real', 'real');
    const bridge = await startTestBridge();
    try {
      const r = await rpcOnce(bridge.socketPath, {
        id: 3, token: bridge.token, method: 'skills.read', params: { id: '../../users.json' },
      });
      expect((r.reply as any).ok).toBe(false);
      expect((r.reply as any).error).toContain('unknown skill');
    } finally {
      await bridge.close();
    }
  });

  it('skills.run_info is scoped to the same listing and refuses global roots', async () => {
    writeSkill(customSkillsDir(), 'trusted', 'trusted');
    writeSkill(path.join(tmpDir, 'home', '.codex', 'skills'), 'global-only', 'global-only');
    const bridge = await startTestBridge();
    try {
      const ok = await rpcOnce(bridge.socketPath, {
        id: 31, token: bridge.token, method: 'skills.run_info', params: { id: 'trusted' },
      });
      expect((ok.reply as any).ok).toBe(true);
      expect((ok.reply as any).result.dir).toContain(path.join('cloud', 'skills', 'trusted'));

      const denied = await rpcOnce(bridge.socketPath, {
        id: 32, token: bridge.token, method: 'skills.run_info', params: { id: 'global-only' },
      });
      expect((denied.reply as any).ok).toBe(false);
      expect((denied.reply as any).error).toContain('unknown skill');
    } finally {
      await bridge.close();
    }
  });

  it('writes the per-run MCP config with command/env wiring', async () => {
    const bridge = await startTestBridge();
    let envFilePath = '';
    try {
      const cfg = JSON.parse(fs.readFileSync(bridge.mcpConfigPath, 'utf8'));
      const server = cfg.mcpServers.orkas;
      expect(server.command).toBe(TEST_NODE);
      expect(server.args[0]).toContain(path.join('bin', 'orkas-bridge.cjs'));
      expect(JSON.stringify(cfg)).not.toContain(bridge.token);
      expect(JSON.stringify(cfg)).not.toContain(bridge.socketPath);
      expect(server.env.ORKAS_BRIDGE_TOKEN).toBeUndefined();
      expect(server.env.ORKAS_BRIDGE_SOCKET).toBeUndefined();
      expect(server.env.ORKAS_BRIDGE_ENV_FILE).toBe(bridge.serverEnv.ORKAS_BRIDGE_ENV_FILE);
      expect(server.env.ORKAS_NODE).toBe(TEST_NODE);
      expect(server.env.ORKAS_BUNDLED_NODE).toBe(TEST_NODE);
      expect(server.env.ELECTRON_RUN_AS_NODE).toBeUndefined();
      envFilePath = server.env.ORKAS_BRIDGE_ENV_FILE;

      const secretEnv = JSON.parse(fs.readFileSync(envFilePath, 'utf8'));
      expect(secretEnv.ORKAS_BRIDGE_TOKEN).toBe(bridge.token);
      expect(secretEnv.ORKAS_BRIDGE_SOCKET).toBe(bridge.socketPath);
      expect(secretEnv.ORKAS_UID).toBe(TEST_UID);
      expect(secretEnv.ORKAS_AGENT_ID).toBe('a1');
      expect(secretEnv.ORKAS_BRIDGE_CAPABILITIES).toContain('memory.agent');
      expect(secretEnv.ORKAS_BRIDGE_CAPABILITIES).toContain('commander.handoff');
      expect(secretEnv.ORKAS_BRIDGE_CAPABILITIES).not.toContain('connectors');
      expect(secretEnv.ORKAS_NODE).toBe(TEST_NODE);
      expect(secretEnv.ORKAS_BUNDLED_NODE).toBe(TEST_NODE);
      expect(secretEnv.ELECTRON_RUN_AS_NODE).toBeUndefined();
      expect(bridge.serverEnv.ORKAS_BRIDGE_TOKEN).toBeUndefined();
      expect(bridge.serverEnv.ORKAS_BRIDGE_SOCKET).toBeUndefined();
    } finally {
      await bridge.close();
    }
    expect(fs.existsSync(envFilePath)).toBe(false);
  });

  it('unknown methods return a structured error', async () => {
    const bridge = await startTestBridge();
    try {
      const r = await rpcOnce(bridge.socketPath, { id: 4, token: bridge.token, method: 'nope', params: {} });
      expect((r.reply as any).ok).toBe(false);
      expect((r.reply as any).error).toContain('unknown method');
    } finally {
      await bridge.close();
    }
  });

  it.each(['claude', 'codex'] as const)('lets %s persist current-project context and files without changing other scopes', async (cli) => {
    const projects = await import('../../../../src/main/features/projects');
    const files = await import('../../../../src/main/features/project_files');
    const memory = await import('../../../../src/main/features/memory');
    const created = await projects.createProject(TEST_UID, 'Project write parity');
    if (!created.ok) throw new Error('fixture failed');
    const pid = created.project.project_id;
    await projects.writeProjectInstructions(TEST_UID, pid, 'Original rule.');
    const workingDir = path.join(tmpDir, 'working');
    fs.mkdirSync(workingDir);
    fs.writeFileSync(path.join(workingDir, 'report.md'), 'First deliverable');
    const bridge = await startTestBridge({ cli, projectId: pid, workingDir });
    let id = 0;
    const call = async (method: string, params: Record<string, unknown>) => (await rpcOnce(bridge.socketPath, {
      id: ++id, token: bridge.token, method, params,
    })).reply as any;
    try {
      expect(bridge.capabilities).toContain('project.context.write');
      expect((await call('project_instructions', { instructions: 'New rule.' })).result.ok).toBe(true);
      expect(await projects.readProjectInstructions(TEST_UID, pid)).toMatchObject({ content: 'New rule.' });
      await projects.writeProjectInstructions(TEST_UID, pid, 'User changed it.');
      expect((await call('project_instructions', { instructions: 'Old overwrite.' })).result)
        .toMatchObject({ ok: false, error: 'conflict' });
      expect((await call('memory.agent', { action: 'add', target: 'project', content: 'Stable decision.' })).result.ok).toBe(true);
      expect((await call('memory.agent', { action: 'replace', target: 'project', old_text: 'Stable decision.', content: 'Corrected decision.' })).result.ok).toBe(true);
      expect(memory.listEntries(TEST_UID, { project: pid }).entries).toEqual(['Corrected decision.']);
      expect(memory.listAgentEntries(TEST_UID, 'a1').entries).toEqual([]);
      for (const target of ['user', 'shared']) expect((await call('memory.agent', { action: 'add', target, content: 'Wrong scope' })).ok).toBe(false);
      expect((await call('memory.agent', { action: 'add', target: 'project', projectId: 'other', content: 'Wrong scope' })).ok).toBe(false);
      expect((await call('project_instructions', { instructions: 'Wrong scope', projectId: 'other' })).ok).toBe(false);
      expect((await call('library_save', { source_path: 'report.md' })).result).toMatchObject({ ok: true, path: 'report.md' });
      expect((await call('library_save', { source_path: 'report.md' })).result).toMatchObject({ ok: false, error: 'target_exists' });
      const checkout = (await call('library_save', { action: 'checkout', name: 'report.md', source_path: 'edit.md' })).result;
      expect(checkout.ok).toBe(true);
      expect(fs.readFileSync(path.join(workingDir, 'edit.md'), 'utf8')).toBe('First deliverable');
      fs.writeFileSync(path.join(workingDir, 'edit.md'), 'Revised deliverable');
      expect((await call('library_save', { name: 'report.md', source_path: 'edit.md', expected_revision: checkout.revision })).result.ok).toBe(true);
      expect(await files.readProjectTextFile(TEST_UID, pid, 'report.md')).toMatchObject({ content: 'Revised deliverable' });
      expect((await call('library_save', { source_path: '../outside.md' })).ok).toBe(false);
      const outside = path.join(tmpDir, 'outside');
      fs.mkdirSync(outside);
      fs.writeFileSync(path.join(outside, 'private.md'), 'Not in the CLI workspace');
      fs.symlinkSync(outside, path.join(workingDir, 'escape'), process.platform === 'win32' ? 'junction' : 'dir');
      expect((await call('library_save', { source_path: 'escape/private.md' })).ok).toBe(false);
      expect((await call('library_save', { action: 'checkout', name: 'report.md', source_path: 'escape/copy.md' })).ok).toBe(false);
      expect(fs.existsSync(path.join(outside, 'copy.md'))).toBe(false);
      expect((await call('library_save', { source_path: 'report.md', projectId: 'other' })).ok).toBe(false);
      const createdTask = await call('todo_tasks', { action: 'create', title: 'Current project work' });
      expect(createdTask.ok).toBe(true);
      const tasks = await import('../../../../src/main/features/project_tasks');
      expect(await tasks.getTask(TEST_UID, pid, createdTask.result.task.id)).toMatchObject({ title: 'Current project work', origin_cid: 'c1' });
      expect((await call('todo_tasks', { action: 'create', title: 'Wrong scope', project: 'other' })).ok).toBe(false);
      expect((await call('memory.agent', { action: 'remove', target: 'project', old_text: 'Corrected decision.' })).result.ok).toBe(true);
      expect(memory.listEntries(TEST_UID, { project: pid }).entries).toEqual([]);
    } finally { await bridge.close(); }
  });

  it.each(['openclaw', 'opencode', 'hermes'] as const)('does not grant project writes to an unsupported %s runtime', async (cli) => {
    const projects = await import('../../../../src/main/features/projects');
    const created = await projects.createProject(TEST_UID, 'Read-only runtime');
    if (!created.ok) throw new Error('fixture failed');
    const bridge = await startTestBridge({ cli, projectId: created.project.project_id });
    try {
      expect(bridge.capabilities).not.toContain('project.context.write');
      for (const method of ['project_instructions', 'library_save']) {
        const { reply } = await rpcOnce(bridge.socketPath, { id: 1, token: bridge.token, method, params: {} });
        expect((reply as any).error).toContain('unknown method');
      }
    } finally { await bridge.close(); }
  });

  it('binds memory RPC to the current Agent and rejects broader or forged scopes', async () => {
    const bridge = await startTestBridge();
    try {
      expect(bridge.capabilities).toContain('memory.agent');
      const added = await rpcOnce(bridge.socketPath, {
        id: 401,
        token: bridge.token,
        method: 'memory.agent',
        params: { action: 'add', content: 'remember only for a1' },
      });
      expect((added.reply as any)).toMatchObject({
        ok: true,
        result: { ok: true, entries: ['remember only for a1'] },
      });

      const broader = await rpcOnce(bridge.socketPath, {
        id: 402,
        token: bridge.token,
        method: 'memory.agent',
        params: { action: 'add', target: 'user', content: 'must not persist' },
      });
      expect((broader.reply as any).ok).toBe(false);
      expect((broader.reply as any).error).toContain('target must be "agent"');

      const forged = await rpcOnce(bridge.socketPath, {
        id: 403,
        token: bridge.token,
        method: 'memory.agent',
        params: {
          action: 'add',
          target: 'agent',
          agent_id: 'another-agent',
          content: 'must not persist',
        },
      });
      expect((forged.reply as any).ok).toBe(false);
      expect((forged.reply as any).error).toContain('fields not allowed for add: agent_id');

      const memory = await import('../../../../src/main/features/memory');
      expect(memory.listAgentEntries(TEST_UID, 'a1').entries).toEqual(['remember only for a1']);
      expect(memory.listAgentEntries(TEST_UID, 'another-agent').entries).toEqual([]);
    } finally {
      await bridge.close();
    }
  });

  it('removes connector RPC methods when ordinary group-chat visibility has no connectors', async () => {
    const bridge = await startTestBridge();
    try {
      expect(bridge.capabilities).not.toContain('connectors');
      const denied = await rpcOnce(bridge.socketPath, {
        id: 41, token: bridge.token, method: 'connectors.list', params: {},
      });
      expect((denied.reply as any).ok).toBe(false);
      expect((denied.reply as any).error).toContain('unknown method');
      expect(bridgeConnectorMock.resolveVisibleConnectors).toHaveBeenCalledWith(TEST_UID);
    } finally {
      await bridge.close();
    }
  });

  it('registers connector methods from ordinary group-chat Agent visibility', async () => {
    bridgeConnectorMock.resolveVisibleConnectors.mockResolvedValue([{
      instance: { id: 'slack', display_name: 'Slack' },
      tools: [{ name: 'search', description: 'Search', input_schema: {} }],
    }] as any);
    const bridge = await startTestBridge();
    try {
      expect(bridge.capabilities).toContain('connectors');
      const listed = await rpcOnce(bridge.socketPath, {
        id: 42, token: bridge.token, method: 'connectors.list', params: {},
      });
      expect((listed.reply as any).ok).toBe(true);
      expect((listed.reply as any).result.connectors[0].id).toBe('slack');
      expect(bridge.getConnectorDisplayName('slack')).toBe('Slack');
      expect(bridge.getConnectorDisplayName('unknown-connector')).toBeNull();
      expect(bridgeConnectorMock.resolveVisibleConnectors).toHaveBeenCalledWith(TEST_UID);
    } finally {
      await bridge.close();
    }
  });

  it('connectors.call normalizes schema field names and preserves explicit provider arguments', async () => {
    // A Gmail fetch from an external CLI must reach the provider with the same
    // request shape a built-in Agent produces: schema-declared snake_case keys.
    // The public adapter preserves explicit values and leaves omitted provider
    // options to the provider's own defaults.
    bridgeConnectorMock.resolveVisibleConnectors.mockResolvedValue([{
      instance: { id: 'gmail', display_name: 'Gmail' },
      tools: [{
        name: 'GMAIL_FETCH_EMAILS', description: 'Fetch emails',
        input_schema: { type: 'object', properties: {
          user_id: { type: 'string' }, max_results: { type: 'integer' },
          verbose: { type: 'boolean' }, include_payload: { type: 'boolean' },
        } },
      }],
    }] as any);
    bridgeConnectorMock.callTool.mockClear();
    const bridge = await startTestBridge({ runId: 'connector-arg-defaults' });
    try {
      const first = await rpcOnce(bridge.socketPath, {
        id: 61, token: bridge.token, method: 'connectors.call',
        params: { connector_id: 'gmail', tool_name: 'GMAIL_FETCH_EMAILS', args: { maxResults: 5 } },
      });
      expect(first.reply).toMatchObject({ ok: true });
      expect(bridgeConnectorMock.callTool.mock.calls[0][3]).toEqual({
        max_results: 5,
      });
      const second = await rpcOnce(bridge.socketPath, {
        id: 62, token: bridge.token, method: 'connectors.call',
        params: { connector_id: 'gmail', tool_name: 'GMAIL_FETCH_EMAILS', args: { max_results: 2, verbose: true } },
      });
      expect(second.reply).toMatchObject({ ok: true });
      expect(bridgeConnectorMock.callTool.mock.calls[1][3]).toEqual({
        max_results: 2, verbose: true,
      });
    } finally {
      await bridge.close();
    }
  });

  it('approves sensitive connector actions individually without granting native CLI access', async () => {
    bridgeConnectorMock.resolveVisibleConnectors.mockResolvedValue([{
      instance: { id: 'gmail', display_name: 'Gmail' },
      tools: [{ name: 'GMAIL_SEND_EMAIL', description: 'Send email', input_schema: {} }],
    }] as any);
    const cliPermissions = await import('../../../../src/main/features/local_agents/cli_permissions');
    const prompts: any[] = [];
    cliPermissions._setBroadcastForTest((channel, payload) => {
      if (channel !== 'local-agent:permission') return;
      prompts.push(payload);
      queueMicrotask(() => cliPermissions.respond((payload as any).request_id, 'deny'));
    });
    const bridge = await startTestBridge({ runId: 'connector-task-grant' });
    try {
      for (const id of [43, 44]) {
        const result = await rpcOnce(bridge.socketPath, {
          id, token: bridge.token, method: 'connectors.call',
          params: { connector_id: 'gmail', tool_name: 'GMAIL_SEND_EMAIL', args: { to: 'test@example.com' } },
        });
        expect(result.reply).toMatchObject({ ok: true });
      }
      expect(prompts).toHaveLength(0);
      expect(bridgeActionConfirmMock.request).toHaveBeenCalledTimes(2);
      await expect(cliPermissions.requestPermission({
        uid: TEST_UID, cid: 'c1', runId: 'connector-task-grant', agentId: 'a1', agentName: 'Agent One',
        cli: 'codex', permissionPolicy: 'ask', request: { tool: 'command', command: 'npm test' },
      })).resolves.toBe('deny');
      expect(prompts).toHaveLength(1);
      expect(bridgeConnectorMock.callTool).toHaveBeenCalledTimes(2);
    } finally {
      await bridge.close();
    }
  });

  // One socket, several frames: the real bridge client keeps a single
  // connection per run, and `connectors.cancel` must target the call made on
  // that same connection.
  function rpcSession(socketPath: string) {
    const socket = net.createConnection(socketPath);
    socket.setEncoding('utf8');
    const replies = new Map<string | number, unknown>();
    const waiters = new Map<string | number, (reply: unknown) => void>();
    let buf = '';
    socket.on('data', (chunk: string) => {
      buf += chunk;
      let idx: number;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const reply = JSON.parse(buf.slice(0, idx)) as { id: string | number };
        buf = buf.slice(idx + 1);
        const waiter = waiters.get(reply.id);
        if (waiter) { waiters.delete(reply.id); waiter(reply); }
        else replies.set(reply.id, reply);
      }
    });
    const connected = new Promise<void>((resolve) => socket.on('connect', () => resolve()));
    return {
      async send(payload: Record<string, unknown>) {
        await connected;
        socket.write(JSON.stringify(payload) + '\n');
      },
      reply(id: string | number, timeoutMs = 4000): Promise<any> {
        if (replies.has(id)) { const r = replies.get(id); replies.delete(id); return Promise.resolve(r); }
        return new Promise((resolve, reject) => {
          const timer = setTimeout(() => { waiters.delete(id); reject(new Error(`no reply for ${id}`)); }, timeoutMs);
          waiters.set(id, (reply) => { clearTimeout(timer); resolve(reply); });
        });
      },
      destroy() { socket.destroy(); },
    };
  }

  async function waitFor(predicate: () => boolean, timeoutMs = 4000): Promise<void> {
    const started = Date.now();
    while (!predicate()) {
      if (Date.now() - started > timeoutMs) throw new Error('condition not met in time');
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }

  it('withdraws a pending connector approval when the client cancels the call', async () => {
    // The CLI-side MCP call timed out (or was cancelled) while the user had not
    // answered yet. The model was told the call failed, so a later "allow" must
    // not send the email behind its back.
    bridgeConnectorMock.resolveVisibleConnectors.mockResolvedValue([{
      instance: { id: 'gmail', display_name: 'Gmail' },
      tools: [{ name: 'GMAIL_SEND_EMAIL', description: 'Send email', input_schema: {} }],
    }] as any);
    const actionConfirm = await vi.importActual<typeof import('../../../../src/main/features/connectors/action_confirm')>('../../../../src/main/features/connectors/action_confirm');
    bridgeActionConfirmMock.request.mockImplementation(actionConfirm.requestActionConfirm as any);
    const deliveries: Array<{ channel: string; payload: any }> = [];
    actionConfirm._setBroadcastForTest((channel, payload) => { deliveries.push({ channel, payload }); });
    const bridge = await startTestBridge({ runId: 'connector-cancel' });
    const session = rpcSession(bridge.socketPath);
    try {
      await session.send({
        id: 71, token: bridge.token, method: 'connectors.call',
        params: { connector_id: 'gmail', tool_name: 'GMAIL_SEND_EMAIL', args: { to: 'test@example.com' } },
      });
      await waitFor(() => deliveries.some((entry) => entry.channel === 'connectors:action-confirm'));
      const requestId = deliveries.find((entry) => entry.channel === 'connectors:action-confirm')!.payload.request_id;

      await session.send({ id: 72, token: bridge.token, method: 'connectors.cancel', params: { call_id: 71 } });
      expect(await session.reply(72)).toMatchObject({ ok: true, result: { cancelled: true } });
      const callReply = await session.reply(71);
      expect(callReply).toMatchObject({ ok: false });
      expect(String(callReply.error)).toContain('E_BRIDGE_CALL_CANCELLED');
      expect(deliveries).toContainEqual({
        channel: 'connectors:action-confirm-cancelled',
        payload: { request_ids: [requestId], cid: 'c1' },
      });
      // The user's late click lands on a withdrawn prompt and runs nothing.
      expect(actionConfirm.respond(requestId, true)).toBe(false);
      expect(bridgeConnectorMock.callTool).not.toHaveBeenCalled();
      // Cancelling an unknown or already finished call is a no-op, not an error.
      await session.send({ id: 73, token: bridge.token, method: 'connectors.cancel', params: { call_id: 71 } });
      expect(await session.reply(73)).toMatchObject({ ok: true, result: { cancelled: false } });
    } finally {
      session.destroy();
      await bridge.close();
      actionConfirm._setBroadcastForTest(null);
    }
  });

  it('withdraws a pending connector approval when the client connection closes', async () => {
    // A CLI process that died mid-wait can never receive the result; the
    // approval it was waiting for must not run the side effect either.
    bridgeConnectorMock.resolveVisibleConnectors.mockResolvedValue([{
      instance: { id: 'gmail', display_name: 'Gmail' },
      tools: [{ name: 'GMAIL_SEND_EMAIL', description: 'Send email', input_schema: {} }],
    }] as any);
    const actionConfirm = await vi.importActual<typeof import('../../../../src/main/features/connectors/action_confirm')>('../../../../src/main/features/connectors/action_confirm');
    bridgeActionConfirmMock.request.mockImplementation(actionConfirm.requestActionConfirm as any);
    const deliveries: Array<{ channel: string; payload: any }> = [];
    actionConfirm._setBroadcastForTest((channel, payload) => { deliveries.push({ channel, payload }); });
    const bridge = await startTestBridge({ runId: 'connector-client-gone' });
    const session = rpcSession(bridge.socketPath);
    try {
      await session.send({
        id: 81, token: bridge.token, method: 'connectors.call',
        params: { connector_id: 'gmail', tool_name: 'GMAIL_SEND_EMAIL', args: {} },
      });
      await waitFor(() => deliveries.some((entry) => entry.channel === 'connectors:action-confirm'));
      const requestId = deliveries.find((entry) => entry.channel === 'connectors:action-confirm')!.payload.request_id;

      session.destroy();
      await waitFor(() => deliveries.some((entry) => entry.channel === 'connectors:action-confirm-cancelled'));
      expect(deliveries).toContainEqual({
        channel: 'connectors:action-confirm-cancelled',
        payload: { request_ids: [requestId], cid: 'c1' },
      });
      expect(actionConfirm.respond(requestId, true)).toBe(false);
      expect(bridgeConnectorMock.callTool).not.toHaveBeenCalled();
    } finally {
      await bridge.close();
      actionConfirm._setBroadcastForTest(null);
    }
  });

  it.each(['confirmation', 'execution'])('cancels the connector %s stage through the bridge socket', async (stage) => {
    bridgeConnectorMock.resolveVisibleConnectors.mockResolvedValue([{
      instance: { id: 'shippo', display_name: 'Shippo' },
      tools: [{
        name: 'SHIPPO_CREATE_REFUND', description: 'Refund', input_schema: {},
        orkas_action_policy: { risk: 'H', confirmation: 'fresh', sensitive_operation: 'money', max_batch_size: 25 },
      }],
    }] as any);
    const cliPermissions = await import('../../../../src/main/features/local_agents/cli_permissions');
    cliPermissions._setBroadcastForTest((channel, payload) => {
      if (channel === 'local-agent:permission') {
        queueMicrotask(() => cliPermissions.respond((payload as any).request_id, 'allow_once'));
      }
    });
    const actionConfirm = await vi.importActual<typeof import('../../../../src/main/features/connectors/action_confirm')>(
      '../../../../src/main/features/connectors/action_confirm',
    );
    const deliveries: Array<{ channel: string; payload: any }> = [];
    actionConfirm._setBroadcastForTest((channel, payload) => deliveries.push({ channel, payload }));
    let releaseRequest = () => {};
    let requestStarted = false;
    let sideEffects = 0;
    if (stage === 'confirmation') {
      bridgeActionConfirmMock.request.mockImplementation(actionConfirm.requestActionConfirm as any);
    } else {
      // Represent the manager's asynchronous preflight/reconnection boundary:
      // dispatch may begin only if the caller still owns an active request.
      bridgeConnectorMock.callTool.mockImplementation((async (...args: any[]) => {
        requestStarted = true;
        await new Promise<void>((resolve) => { releaseRequest = resolve; });
        if (args[4]?.signal?.aborted) throw new Error('E_TOOL_CALL_CANCELLED');
        sideEffects += 1;
        return { content: [{ type: 'text', text: 'refund created' }] };
      }) as any);
    }
    const resumeIdle = vi.fn();
    const pauseIdle = vi.fn(() => resumeIdle);
    const bridge = await startTestBridge({ onPermissionWaitStart: pauseIdle });
    const session = rpcSession(bridge.socketPath);
    try {
      await session.send({
        id: 91, token: bridge.token, method: 'connectors.call',
        params: { connector_id: 'shippo', tool_name: 'SHIPPO_CREATE_REFUND', args: { order_id: 'order-1' } },
      });
      await waitFor(() => stage === 'confirmation'
        ? deliveries.some((entry) => entry.channel === 'connectors:action-confirm')
        : requestStarted);
      await session.send({ id: 92, token: bridge.token, method: 'connectors.cancel', params: { call_id: 91 } });
      expect(await session.reply(92)).toMatchObject({ ok: true, result: { cancelled: true } });
      if (stage === 'confirmation') {
        expect(pauseIdle).toHaveBeenCalledOnce();
        await waitFor(() => deliveries.some((entry) => entry.channel === 'connectors:action-confirm-cancelled'), 300);
        const prompt = deliveries.find((entry) => entry.channel === 'connectors:action-confirm')!.payload;
        expect(actionConfirm.respond(prompt.request_id, true)).toBe(false);
        expect(bridgeConnectorMock.callTool).not.toHaveBeenCalled();
      } else {
        releaseRequest();
      }
      expect(await session.reply(91)).toMatchObject({ ok: false });
      expect(resumeIdle).toHaveBeenCalledOnce();
      expect(sideEffects).toBe(0);
    } finally {
      releaseRequest();
      actionConfirm.cancelForCid('c1');
      actionConfirm._setBroadcastForTest(null);
      session.destroy();
      await bridge.close();
    }
  });

  it.each(['workspace_approval', 'all_files_approval', 'all_files_auto'] as const)(
    'uses %s operation permissions for sensitive actions under full native CLI access', async (mode) => {
      const permissions = await import('../../../../src/main/features/permissions');
      permissions.setLocalExecMode(mode);
      const actionConfirm = await vi.importActual<typeof import('../../../../src/main/features/connectors/action_confirm')>('../../../../src/main/features/connectors/action_confirm');
      bridgeActionConfirmMock.request.mockImplementation(actionConfirm.requestActionConfirm as any);
      const dialogs: any[] = [];
      actionConfirm._setBroadcastForTest((channel, payload) => {
        if (channel !== 'connectors:action-confirm') return;
        dialogs.push(payload);
        queueMicrotask(() => actionConfirm.respond((payload as any).request_id, true));
      });
      bridgeConnectorMock.resolveVisibleConnectors.mockResolvedValue([{
        instance: { id: 'gmail', display_name: 'Gmail' },
        tools: [{ name: 'GMAIL_SEND_EMAIL', description: 'Send email', input_schema: {} }],
      }] as any);
      const nativePrompt = vi.fn();
      const cliPermissions = await import('../../../../src/main/features/local_agents/cli_permissions');
      cliPermissions._setBroadcastForTest(nativePrompt);
      const bridge = await startTestBridge({ permissionPolicy: 'full_access' });
      try {
        const result = await rpcOnce(bridge.socketPath, {
          id: 1, token: bridge.token, method: 'connectors.call',
          params: { connector_id: 'gmail', tool_name: 'GMAIL_SEND_EMAIL', args: { to: 'test@example.com' } },
        });
        expect(result.reply).toMatchObject({ ok: true });
        expect(dialogs).toHaveLength(mode === 'all_files_auto' ? 0 : 1);
        expect(nativePrompt).not.toHaveBeenCalled();
        expect(bridgeConnectorMock.callTool).toHaveBeenCalledOnce();
      } finally {
        await bridge.close();
        actionConfirm._setBroadcastForTest(null);
      }
    },
  );

  it('keeps sensitive action confirmation independent from full CLI execution access', async () => {
    bridgeConnectorMock.resolveVisibleConnectors.mockResolvedValue([{
      instance: {
        id: 'shippo',
        display_name: 'Shippo',
        composio_grant: {
          connection_id: 'connection-1', toolkit: 'shippo', auth_config_id: 'auth-1',
          account_label: 'Store A',
        },
      },
      tools: [{
        name: 'SHIPPO_CREATE_REFUND',
        description: 'Refund a shipment.',
        input_schema: {},
        orkas_action_policy: {
          risk: 'H', confirmation: 'fresh', sensitive_operation: 'money', max_batch_size: 25,
        },
      }],
    }] as any);
    const cliPermissions = await import('../../../../src/main/features/local_agents/cli_permissions');
    // Native full access does not decide the account's operation permission.
    const prompts: any[] = [];
    cliPermissions._setBroadcastForTest((channel, payload) => {
      if (channel !== 'local-agent:permission') return;
      prompts.push(payload);
      queueMicrotask(() => cliPermissions.respond((payload as any).request_id, 'allow_once'));
    });
    const bridge = await startTestBridge({ permissionPolicy: 'full_access' });
    try {
      const result = await rpcOnce(bridge.socketPath, {
        id: 46,
        token: bridge.token,
        method: 'connectors.call',
        params: {
          connector_id: 'shippo',
          tool_name: 'SHIPPO_CREATE_REFUND',
          args: { order_id: 'order-1', amount: 12.5 },
        },
      });

      expect(result.reply).toMatchObject({ ok: true });
      expect(prompts).toHaveLength(0);
      expect(bridgeActionConfirmMock.request).toHaveBeenCalledWith(expect.objectContaining({
        cid: 'c1',
        connectorId: 'shippo',
        displayName: 'Shippo',
        accountLabel: 'Store A',
        toolName: 'SHIPPO_CREATE_REFUND',
        risk: 'H',
        sensitiveOperation: 'money',
        args: { order_id: 'order-1', amount: 12.5 },
      }));
      expect(bridgeConnectorMock.callTool).toHaveBeenCalledWith(
        TEST_UID,
        'shippo',
        'SHIPPO_CREATE_REFUND',
        {
          order_id: 'order-1',
          amount: 12.5,
        },
        { signal: expect.any(AbortSignal) },
      );
    } finally {
      await bridge.close();
    }
  });

  it('does not call a sensitive connector when the independent action confirmation is denied', async () => {
    bridgeActionConfirmMock.request.mockResolvedValue(false);
    const cliPermissions = await import('../../../../src/main/features/local_agents/cli_permissions');
    cliPermissions._setBroadcastForTest((channel, payload) => {
      if (channel !== 'local-agent:permission') return;
      queueMicrotask(() => cliPermissions.respond((payload as any).request_id, 'allow_once'));
    });
    bridgeConnectorMock.resolveVisibleConnectors.mockResolvedValue([{
      instance: { id: 'shippo', display_name: 'Shippo' },
      tools: [{
        name: 'SHIPPO_DELETE_ORDER',
        description: 'Delete an order.',
        input_schema: {},
        orkas_action_policy: {
          risk: 'D', confirmation: 'destructive', sensitive_operation: 'delete', max_batch_size: 25,
        },
      }],
    }] as any);
    const bridge = await startTestBridge({ permissionPolicy: 'full_access' });
    try {
      const result = await rpcOnce(bridge.socketPath, {
        id: 47,
        token: bridge.token,
        method: 'connectors.call',
        params: { connector_id: 'shippo', tool_name: 'SHIPPO_DELETE_ORDER', args: { id: 'order-1' } },
      });

      expect(result.reply).toMatchObject({
        ok: false,
        error: expect.stringContaining('E_CONNECTOR_CONFIRMATION_DENIED'),
      });
      expect(bridgeConnectorMock.callTool).not.toHaveBeenCalled();
    } finally {
      await bridge.close();
    }
  });

  it('ignores a legacy permanent grant and never calls the service after denial', async () => {
    bridgeConnectorMock.resolveVisibleConnectors.mockResolvedValue([{
      instance: { id: 'gmail', display_name: 'Gmail' },
      tools: [{ name: 'GMAIL_SEND_EMAIL', description: 'Send email', input_schema: {} }],
    }] as any);
    const paths = await import('../../../../src/main/paths');
    const legacyConfigDir = paths.userLocalConfigDir(TEST_UID);
    fs.mkdirSync(legacyConfigDir, { recursive: true });
    fs.writeFileSync(path.join(legacyConfigDir, 'bridge-permissions.json'), JSON.stringify({
      version: 1,
      agents: { a1: { connectors: { gmail: 'allow' } } },
    }));
    bridgeActionConfirmMock.request.mockResolvedValue(false);
    const bridge = await startTestBridge({ runId: 'connector-denied' });
    try {
      const denied = await rpcOnce(bridge.socketPath, {
        id: 44,
        token: bridge.token,
        method: 'connectors.call',
        params: { connector_id: 'gmail', tool_name: 'GMAIL_SEND_EMAIL', args: {} },
      });
      expect(denied.reply).toMatchObject({
        ok: false,
        error: expect.stringContaining('E_CONNECTOR_CONFIRMATION_DENIED'),
      });
      expect(bridgeActionConfirmMock.request).toHaveBeenCalledOnce();
      expect(bridgeConnectorMock.callTool).not.toHaveBeenCalled();
    } finally {
      await bridge.close();
    }
  });

  it('runs a catalog-declared read without any connector or native CLI approval', async () => {
    bridgeConnectorMock.resolveVisibleConnectors.mockResolvedValue([{
      instance: { id: 'slack', display_name: 'Slack' },
      tools: [{ name: 'search', description: 'Search', input_schema: {}, annotations: { readOnlyHint: true } }],
    }] as any);
    const cliPermissions = await import('../../../../src/main/features/local_agents/cli_permissions');
    const prompts: any[] = [];
    cliPermissions._setBroadcastForTest((channel, payload) => {
      if (channel !== 'local-agent:permission') return;
      prompts.push(payload);
      queueMicrotask(() => cliPermissions.respond((payload as any).request_id, 'allow_once'));
    });
    const bridge = await startTestBridge({ permissionPolicy: 'full_access' });
    try {
      const allowed = await rpcOnce(bridge.socketPath, {
        id: 45,
        token: bridge.token,
        method: 'connectors.call',
        params: { connector_id: 'slack', tool_name: 'search', args: {} },
      });
      expect(allowed.reply).toMatchObject({ ok: true });
      expect(prompts).toHaveLength(0);
      expect(bridgeActionConfirmMock.request).not.toHaveBeenCalled();
      expect(bridgeConnectorMock.callTool).toHaveBeenCalledOnce();
    } finally {
      await bridge.close();
    }
  });

  it('records only the first bounded Commander handoff request', async () => {
    const bridge = await startTestBridge();
    try {
      const first = await rpcOnce(bridge.socketPath, {
        id: 43,
        token: bridge.token,
        method: 'commander.handoff',
        params: { reason: 'Automation mutation is Commander-only.', context: 'Create a daily 08:00 task.' },
      });
      expect((first.reply as any).result).toEqual({ accepted: true });
      expect(bridge.getCommanderHandoff()).toEqual({
        reason: 'Automation mutation is Commander-only.',
        context: 'Create a daily 08:00 task.',
      });

      const duplicate = await rpcOnce(bridge.socketPath, {
        id: 44,
        token: bridge.token,
        method: 'commander.handoff',
        params: { reason: 'Replace the first request.' },
      });
      expect((duplicate.reply as any).result).toEqual({ accepted: false, already_requested: true });
      expect(bridge.getCommanderHandoff()?.reason).toBe('Automation mutation is Commander-only.');

      const invalid = await rpcOnce(bridge.socketPath, {
        id: 45,
        token: bridge.token,
        method: 'commander.handoff',
        params: { reason: '' },
      });
      expect((invalid.reply as any).ok).toBe(false);
      expect((invalid.reply as any).error).toContain('reason required');
    } finally {
      await bridge.close();
    }
  });
});

describe('local_agents/bridge › Library project scope', () => {
  it('serves library list/search actions across global and current project scopes', async () => {
    await seedGlobalKbFile('global-note.md', 'global bridge alpha');
    const projects = await import('../../../../src/main/features/projects');
    const projectFiles = await import('../../../../src/main/features/project_files');
    const projectLibrary = await import('../../../../src/main/features/project_library_indexer');
    const created = await projects.createProject(TEST_UID, 'Bridge Project');
    expect(created.ok).toBe(true);
    const projectId = created.ok ? created.project.project_id : '';
    const uploaded = await projectFiles.uploadProjectFile(TEST_UID, projectId, 'project-note.md', Buffer.from('project bridge alpha', 'utf8'));
    expect(uploaded.ok).toBe(true);
    await projectLibrary.drain(TEST_UID);

    const bridge = await startTestBridge({ projectId });
    try {
      const r = await rpcOnce(bridge.socketPath, {
        id: 5, token: bridge.token, method: 'library', params: { action: 'list' },
      });
      expect((r.reply as any).ok).toBe(true);
      const text = (r.reply as any).result.text;
      expect(text).toMatch(/global total=1 ready=1/);
      expect(text).toMatch(/project total=1 ready=1/);
      expect(text).toContain('scope=global path="global-note.md"');
      expect(text).toContain('scope=project path="project-note.md"');

      const search = await rpcOnce(bridge.socketPath, {
        id: 6, token: bridge.token, method: 'library', params: { action: 'search', query: 'bridge alpha', k: 10 },
      });
      expect((search.reply as any).ok).toBe(true);
      const searchText = (search.reply as any).result.text;
      expect(searchText).toContain('scope=global path="global-note.md"');
      expect(searchText).toContain('scope=project path="project-note.md"');
    } finally {
      await bridge.close();
    }
  });

  it('serves only global Library actions when no projectId is supplied', async () => {
    await seedGlobalKbFile('global-only.md', 'global only bridge alpha');
    const projects = await import('../../../../src/main/features/projects');
    const projectFiles = await import('../../../../src/main/features/project_files');
    const projectLibrary = await import('../../../../src/main/features/project_library_indexer');
    const created = await projects.createProject(TEST_UID, 'Detached Project');
    expect(created.ok).toBe(true);
    const projectId = created.ok ? created.project.project_id : '';
    const uploaded = await projectFiles.uploadProjectFile(TEST_UID, projectId, 'project-hidden.md', Buffer.from('project hidden bridge alpha', 'utf8'));
    expect(uploaded.ok).toBe(true);
    await projectLibrary.drain(TEST_UID);

    const bridge = await startTestBridge();
    try {
      const r = await rpcOnce(bridge.socketPath, {
        id: 7, token: bridge.token, method: 'library', params: { action: 'list' },
      });
      expect((r.reply as any).ok).toBe(true);
      const text = (r.reply as any).result.text;
      expect(text).toMatch(/global total=1 ready=1/);
      expect(text).not.toContain('project total=');
      expect(text).toContain('scope=global path="global-only.md"');
      expect(text).not.toMatch(/project-hidden\.md/);

      const search = await rpcOnce(bridge.socketPath, {
        id: 8, token: bridge.token, method: 'library', params: { action: 'search', query: 'bridge alpha', k: 10 },
      });
      expect((search.reply as any).ok).toBe(true);
      const searchText = (search.reply as any).result.text;
      expect(searchText).toContain('scope=global path="global-only.md"');
      expect(searchText).not.toMatch(/project-hidden\.md/);
      expect(searchText).not.toMatch(/scope=project/);
    } finally {
      await bridge.close();
    }
  });
});

describe('local_agents/bridge › current conversation history', () => {
  it('binds reads to the current chat and stops before the triggering message', async () => {
    await seedCurrentConversation();
    const bridge = await startTestBridge();
    try {
      const read = await rpcOnce(bridge.socketPath, {
        id: 40,
        token: bridge.token,
        method: 'chat_history',
        params: { action: 'read', scope: 'current', page: { mode: 'latest', count: 20 } },
      });
      expect((read.reply as any).ok).toBe(true);
      const text = (read.reply as any).result.text;
      expect(text).toContain('PUBLIC_PRIOR_CONTEXT');
      expect(text).not.toContain('PRIVATE_MODEL_TEXT');
      expect(text).not.toContain('PRIVATE_PROCESS_TEXT');
      expect(text).not.toContain('PRIVATE_DISPATCH_TEXT');
      expect(text).not.toContain('CURRENT_TRIGGER_TEXT');
      expect(text).not.toContain('LATER_CONCURRENT_TEXT');

      const paged = await rpcOnce(bridge.socketPath, {
        id: 41,
        token: bridge.token,
        method: 'chat_history',
        params: { action: 'read', scope: 'current', page: { mode: 'before', index: 1, count: 20 } },
      });
      expect((paged.reply as any).ok).toBe(true);
      expect((paged.reply as any).result.text).toContain('PUBLIC_PRIOR_CONTEXT');

      const denied = await rpcOnce(bridge.socketPath, {
        id: 42,
        token: bridge.token,
        method: 'chat_history',
        params: { action: 'read', scope: 'all', cid: 'c1' },
      });
      expect((denied.reply as any).ok).toBe(false);
      expect((denied.reply as any).error).toContain('not allowed for this agent');
    } finally {
      await bridge.close();
    }
  });
});


describe('CLI browser lifetime and isolation', () => {
  it.each(['openclaw', 'hermes'] as const)('does not grant browser to unsupported %s transport even in a task', async (cli) => {
    const life = await import('../../../../src/main/features/web_assist_lifecycle');
    life.beginBrowserTaskRun(TEST_UID, 'c1', 'browser-denied');
    const bridge = await startTestBridge({ cli });
    try {
      expect(bridge.capabilities).not.toContain('browser');
      const result = await rpcOnce(bridge.socketPath, { id: 1, token: bridge.token, method: 'browser', params: { operation: 'tabs' } });
      expect(result.reply).toMatchObject({ ok: false, error: 'unknown method: browser' });
    } finally {
      await bridge.close();
      life.finishBrowserTaskRun(TEST_UID, 'c1', 'browser-denied');
    }
  });

  it.each(['task-end', 'account-change', 'bridge-close', 'call-cancel'] as const)('serializes browser work and rejects queued mutations after %s', async (change) => {
    const life = await import('../../../../src/main/features/web_assist_lifecycle');
    const users = await import('../../../../src/main/features/users');
    life.beginBrowserTaskRun(TEST_UID, 'c1', 'browser-queue');
    const bridge = await startTestBridge();
    let started!: () => void;
    let release!: () => void;
    const entered = new Promise<void>(resolve => { started = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    browserHost.openModelWebAssist.mockReset().mockImplementation(async () => {
      started();
      await gate;
      return { ok: true };
    });
    const socket = net.createConnection(bridge.socketPath);
    socket.setEncoding('utf8');
    let buffer = '';
    const waiters = new Map<number, (value: any) => void>();
    const request = (id: number, method: string, params: Record<string, unknown>) => new Promise<any>(resolve => {
      waiters.set(id, resolve);
      socket.write(JSON.stringify({ id, token: bridge.token, method, params }) + '\n');
    });
    socket.on('data', chunk => {
      buffer += chunk;
      let index: number;
      while ((index = buffer.indexOf('\n')) >= 0) {
        const reply = JSON.parse(buffer.slice(0, index));
        buffer = buffer.slice(index + 1);
        waiters.get(reply.id)?.(reply);
        waiters.delete(reply.id);
      }
    });
    socket.on('close', () => { for (const done of waiters.values()) done(null); waiters.clear(); });
    socket.on('error', () => {});
    await new Promise<void>(resolve => socket.once('connect', resolve));
    const first = request(1, 'browser', { operation: 'open', url: 'https://example.com/first' });
    await entered;
    const second = request(2, 'browser', { operation: 'open', url: 'https://example.com/second' });
    // A later frame on the same socket proves the second action was admitted
    // while the first is pending; it must not run before that action settles.
    await request(3, 'unknown-read-barrier', {});
    expect(browserHost.openModelWebAssist).toHaveBeenCalledTimes(1);
    try {
      if (change === 'task-end') life.finishBrowserTaskRun(TEST_UID, 'c1', 'browser-queue');
      if (change === 'account-change') users.activateUser('other-account');
      if (change === 'bridge-close') await bridge.close();
      if (change === 'call-cancel') expect(await request(4, 'connectors.cancel', { call_id: 2 })).toMatchObject({ result: { cancelled: true } });
      release();
      const [, queued] = await Promise.all([first, second]);
      if (change === 'bridge-close') expect(queued).toBeNull();
      else {
        expect(queued).toMatchObject({ ok: true, result: { isError: true } });
        expect(JSON.parse(queued.result.content).code).toBe('task_run_ended');
      }
      expect(browserHost.openModelWebAssist).toHaveBeenCalledTimes(1);
    } finally {
      release();
      socket.destroy();
      if (change !== 'bridge-close') await bridge.close();
      life.finishBrowserTaskRun(TEST_UID, 'c1', 'browser-queue');
    }
  });
});
