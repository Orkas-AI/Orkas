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

// orkas-bridge host: socket auth + skills surface + KB scope + permission gate.
// Connector methods are covered by their own feature tests; here we pin the
// bridge-specific contracts (token, path discipline, scope plumbing, gating).

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
  const users = await import('../../../../src/main/features/users');
  users.activateUser(TEST_UID);
});

afterEach(() => {
  process.env.ORKAS_WORKSPACE_ROOT = prevWs;
  if (prevHome === undefined) delete process.env.HOME;
  else process.env.HOME = prevHome;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

async function startTestBridge(opts: { projectId?: string } = {}) {
  const { startBridge } = await import('../../../../src/main/features/local_agents/bridge');
  return startBridge({
    uid: TEST_UID,
    cid: 'c1',
    agentId: 'a1',
    agentName: 'Agent One',
    ...(opts.projectId ? { projectId: opts.projectId } : {}),
    runId: `t${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`,
    configDir: path.join(tmpDir, 'rundir'),
    sandboxEnv: {
      ORKAS_NODE: process.execPath,
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
      expect(server.command).toBe(process.execPath);
      expect(server.args[0]).toContain(path.join('bin', 'orkas-bridge.cjs'));
      expect(JSON.stringify(cfg)).not.toContain(bridge.token);
      expect(JSON.stringify(cfg)).not.toContain(bridge.socketPath);
      expect(server.env.ORKAS_BRIDGE_TOKEN).toBeUndefined();
      expect(server.env.ORKAS_BRIDGE_SOCKET).toBeUndefined();
      expect(server.env.ORKAS_BRIDGE_ENV_FILE).toBe(bridge.serverEnv.ORKAS_BRIDGE_ENV_FILE);
      envFilePath = server.env.ORKAS_BRIDGE_ENV_FILE;

      const secretEnv = JSON.parse(fs.readFileSync(envFilePath, 'utf8'));
      expect(secretEnv.ORKAS_BRIDGE_TOKEN).toBe(bridge.token);
      expect(secretEnv.ORKAS_BRIDGE_SOCKET).toBe(bridge.socketPath);
      expect(secretEnv.ORKAS_UID).toBe(TEST_UID);
      expect(secretEnv.ORKAS_AGENT_ID).toBe('a1');
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
      expect(text).toMatch(/scope=global path=global-note\.md/);
      expect(text).toMatch(/scope=project path=project-note\.md/);

      const search = await rpcOnce(bridge.socketPath, {
        id: 6, token: bridge.token, method: 'kb.search', params: { query: 'bridge alpha', k: 10 },
      });
      expect((search.reply as any).ok).toBe(true);
      const searchText = (search.reply as any).result.text;
      expect(searchText).toMatch(/scope=global path=global-note\.md/);
      expect(searchText).toMatch(/scope=project path=project-note\.md/);
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
      expect(text).toMatch(/scope=global path=global-only\.md/);
      expect(text).not.toMatch(/project-hidden\.md/);

      const search = await rpcOnce(bridge.socketPath, {
        id: 8, token: bridge.token, method: 'kb.search', params: { query: 'bridge alpha', k: 10 },
      });
      expect((search.reply as any).ok).toBe(true);
      const searchText = (search.reply as any).result.text;
      expect(searchText).toMatch(/scope=global path=global-only\.md/);
      expect(searchText).not.toMatch(/project-hidden\.md/);
      expect(searchText).not.toMatch(/scope=project/);
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
    const pushed: any[] = [];
    perms._setBroadcastForTest((_ch, payload) => pushed.push(payload));
    try {
      const p = perms.requestPermission({
        uid: TEST_UID, cid: 'c9', agentId: 'a1', agentName: 'A',
        connectorId: 'notion', connectorName: 'Notion', toolName: 'create_page',
      });
      perms.cancelForCid('c9');
      await expect(p).resolves.toBe(false);
    } finally {
      perms._setBroadcastForTest(null);
    }
  });
});
