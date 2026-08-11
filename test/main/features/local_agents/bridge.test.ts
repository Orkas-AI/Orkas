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
}));
vi.mock('../../../../src/main/features/connectors', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../../src/main/features/connectors')>();
  return {
    ...actual,
    resolveVisibleConnectors: bridgeConnectorMock.resolveVisibleConnectors,
  };
});

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
  const users = await import('../../../../src/main/features/users');
  users.activateUser(TEST_UID);
});

afterEach(async () => {
  const kb = await import('../../../../src/main/features/kb_vector');
  kb.closeAllKb();
  process.env.ORKAS_WORKSPACE_ROOT = prevWs;
  if (prevHome === undefined) delete process.env.HOME;
  else process.env.HOME = prevHome;
  fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

async function startTestBridge(opts: { projectId?: string } = {}) {
  const { startBridge } = await import('../../../../src/main/features/local_agents/bridge');
  return startBridge({
    uid: TEST_UID,
    cid: 'c1',
    agentId: 'a1',
    agentName: 'Agent One',
    currentMessageId: 'current-message',
    ...(opts.projectId ? { projectId: opts.projectId } : {}),
    runId: `t${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`,
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

  it('removes connector RPC methods when ordinary group-chat visibility has no connectors', async () => {
    const bridge = await startTestBridge();
    try {
      expect(bridge.capabilities).not.toContain('connectors');
      const denied = await rpcOnce(bridge.socketPath, {
        id: 41, token: bridge.token, method: 'connectors.list', params: {},
      });
      expect((denied.reply as any).ok).toBe(false);
      expect((denied.reply as any).error).toContain('unknown method');
      expect(bridgeConnectorMock.resolveVisibleConnectors).toHaveBeenCalledWith(TEST_UID, undefined);
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
      expect(bridgeConnectorMock.resolveVisibleConnectors).toHaveBeenCalledWith(TEST_UID, undefined);
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

describe('local_agents/bridge › KB project scope', () => {
  it('serves kb.list across global and current project libraries when projectId is supplied', async () => {
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
        id: 5, token: bridge.token, method: 'kb.list', params: {},
      });
      expect((r.reply as any).ok).toBe(true);
      const text = (r.reply as any).result.text;
      expect(text).toMatch(/global total=1 ready=1/);
      expect(text).toMatch(/project total=1 ready=1/);
      expect(text).toContain('scope=global path="global-note.md"');
      expect(text).toContain('scope=project path="project-note.md"');

      const search = await rpcOnce(bridge.socketPath, {
        id: 6, token: bridge.token, method: 'kb.search', params: { query: 'bridge alpha', k: 10 },
      });
      expect((search.reply as any).ok).toBe(true);
      const searchText = (search.reply as any).result.text;
      expect(searchText).toContain('scope=global path="global-note.md"');
      expect(searchText).toContain('scope=project path="project-note.md"');
    } finally {
      await bridge.close();
    }
  });

  it('serves only global kb.list when no projectId is supplied', async () => {
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
        id: 7, token: bridge.token, method: 'kb.list', params: {},
      });
      expect((r.reply as any).ok).toBe(true);
      const text = (r.reply as any).result.text;
      expect(text).toMatch(/global total=1 ready=1/);
      expect(text).not.toContain('project total=');
      expect(text).toContain('scope=global path="global-only.md"');
      expect(text).not.toMatch(/project-hidden\.md/);

      const search = await rpcOnce(bridge.socketPath, {
        id: 8, token: bridge.token, method: 'kb.search', params: { query: 'bridge alpha', k: 10 },
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
        method: 'chat.read',
        params: { scope: 'current', limit: 20 },
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
        method: 'chat.read',
        params: { scope: 'current', before_msg_index: 1, limit: 20 },
      });
      expect((paged.reply as any).ok).toBe(true);
      expect((paged.reply as any).result.text).toContain('PUBLIC_PRIOR_CONTEXT');

      const denied = await rpcOnce(bridge.socketPath, {
        id: 42,
        token: bridge.token,
        method: 'chat.read',
        params: { scope: 'all', cid: 'c1' },
      });
      expect((denied.reply as any).ok).toBe(false);
      expect((denied.reply as any).error).toContain('not allowed for this agent');
    } finally {
      await bridge.close();
    }
  });
});

describe('local_agents/bridge_permissions', () => {
  it('always-allow store grants without a dialog and respond() persists it', async () => {
    const perms = await import('../../../../src/main/features/local_agents/bridge_permissions');
    const pushed: any[] = [];
    perms._setBroadcastForTest((_ch, payload) => pushed.push(payload));
    try {
      // First call: no store entry → a push goes out; user allows + remembers.
      const p1 = perms.requestPermission({
        uid: TEST_UID, cid: 'c1', agentId: 'a1', agentName: 'A',
        connectorId: 'slack', connectorName: 'Slack', toolName: 'send_message',
      });
      expect(pushed).toHaveLength(1);
      expect(perms.respond(pushed[0].request_id, true, true)).toBe(true);
      await expect(p1).resolves.toBe(true);
      expect(perms.hasAlwaysAllow(TEST_UID, 'a1', 'slack')).toBe(true);

      // Second call: silent grant, no new push.
      const p2 = perms.requestPermission({
        uid: TEST_UID, cid: 'c1', agentId: 'a1', agentName: 'A',
        connectorId: 'slack', connectorName: 'Slack', toolName: 'send_message',
      });
      await expect(p2).resolves.toBe(true);
      expect(pushed).toHaveLength(1);

      // Different agent: not covered by a1's grant.
      const p3 = perms.requestPermission({
        uid: TEST_UID, cid: 'c1', agentId: 'a2', agentName: 'B',
        connectorId: 'slack', connectorName: 'Slack', toolName: 'send_message',
      });
      expect(pushed).toHaveLength(2);
      perms.respond(pushed[1].request_id, false, false);
      await expect(p3).resolves.toBe(false);
      expect(perms.hasAlwaysAllow(TEST_UID, 'a2', 'slack')).toBe(false);
    } finally {
      perms._setBroadcastForTest(null);
    }
  });

  it('denies are never persisted and stale responds are ignored', async () => {
    const perms = await import('../../../../src/main/features/local_agents/bridge_permissions');
    expect(perms.respond('does-not-exist', true, true)).toBe(false);
  });

  it('cancelForCid denies every pending request of that conversation', async () => {
    const perms = await import('../../../../src/main/features/local_agents/bridge_permissions');
    const pushed: Array<{ channel: string; payload: any }> = [];
    perms._setBroadcastForTest((channel, payload) => pushed.push({ channel, payload }));
    try {
      const p = perms.requestPermission({
        uid: TEST_UID, cid: 'c9', agentId: 'a1', agentName: 'A',
        connectorId: 'notion', connectorName: 'Notion', toolName: 'create_page',
      });
      perms.cancelForCid('c9');
      await expect(p).resolves.toBe(false);
      expect(pushed).toHaveLength(2);
      expect(pushed[1]).toEqual({
        channel: 'bridge:permission_cancelled',
        payload: expect.objectContaining({ request_ids: [expect.any(String)], cid: 'c9' }),
      });
    } finally {
      perms._setBroadcastForTest(null);
    }
  });

  it('fails closed immediately when no renderer can receive the approval prompt', async () => {
    const perms = await import('../../../../src/main/features/local_agents/bridge_permissions');
    let requestId = '';
    perms._setBroadcastForTest((_channel, payload) => {
      requestId = (payload as { request_id: string }).request_id;
      return false;
    });
    try {
      const decision = perms.requestPermission({
        uid: TEST_UID, cid: 'c-no-window', agentId: 'a1', agentName: 'A',
        connectorId: 'notion', connectorName: 'Notion', toolName: 'create_page',
      });

      await expect(decision).resolves.toBe(false);
      expect(perms.respond(requestId, true, true)).toBe(false);
    } finally {
      perms._setBroadcastForTest(null);
    }
  });
});
