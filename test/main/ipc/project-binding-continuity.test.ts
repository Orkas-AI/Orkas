import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { syncBuiltinESMExports } from 'node:module';
import { trustedIpcSender } from '../../helpers/trusted-ipc-sender';

vi.mock('electron', () => ({
  app: { isPackaged: false },
  ipcMain: { handle: vi.fn(), on: vi.fn() },
  dialog: { showOpenDialog: vi.fn(async () => ({ canceled: true, filePaths: [] })) },
  BrowserWindow: { getAllWindows: vi.fn(() => []), getFocusedWindow: vi.fn(() => null) },
  shell: { showItemInFolder: vi.fn(), openPath: vi.fn(async () => '') },
  systemPreferences: {
    getMediaAccessStatus: vi.fn(() => 'granted'),
    askForMediaAccess: vi.fn(async () => true),
  },
}));

vi.mock('../../../src/main/features/kb_indexer', () => ({
  enqueue: vi.fn(),
  kbEvents: { on: vi.fn(), off: vi.fn(), emit: vi.fn() },
}));

vi.mock('../../../src/main/features/search', () => ({
  upsertContext: vi.fn(),
  dropContext: vi.fn(),
  dropChatConversation: vi.fn(),
  invalidateChatDisplayCatalog: vi.fn(),
}));

let tmpDir: string;
let previousWorkspace: string | undefined;
const TEST_UID = 'member';

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-project-binding-continuity-'));
  previousWorkspace = process.env.ORKAS_WORKSPACE_ROOT;
  process.env.ORKAS_WORKSPACE_ROOT = tmpDir;
  vi.resetModules();
  vi.clearAllMocks();
  const users = await import('../../../src/main/features/users');
  users.activateUser(TEST_UID);
});

afterEach(async () => {
  vi.restoreAllMocks();
  syncBuiltinESMExports();
  await (await import('../../../src/main/quality/report')).drainReportWrites();
  (await import('../../../src/main/features/vec_store')).closeAllVecStores();
  process.env.ORKAS_WORKSPACE_ROOT = previousWorkspace;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

async function invoke(channel: string, payload: Record<string, unknown>): Promise<any> {
  const electron = await import('electron') as any;
  const { register } = await import('../../../src/main/ipc/index');
  register();
  const call = electron.ipcMain.handle.mock.calls.find(([name]: [string]) => name === 'orkas.invoke');
  expect(call).toBeTruthy();
  return call[1]({ sender: trustedIpcSender() }, { channel, payload });
}

describe('local project binding continuity', () => {
  async function fixture() {
    const agents = await import('../../../src/main/features/agents');
    const projects = await import('../../../src/main/features/projects');
    const paths = await import('../../../src/main/paths');
    const created = await projects.createProject('member', 'Binding continuity');
    if (!created.ok) throw new Error('fixture project creation failed');
    const pid = created.project.project_id;
    const aid = 'bound-agent';
    const target = paths.userMarketplaceAgentDir('member', aid);
    const body = JSON.stringify({ agent_id: aid, name: 'Bound', workflow: 'Help' });
    fs.mkdirSync(target, { recursive: true });
    fs.writeFileSync(path.join(target, 'agent.json'), body);
    expect((await projects.addAgentBinding('member', pid, aid)).ok).toBe(true);
    expect(await invoke('projects.bindings.list', { projectId: pid })).toMatchObject({
      ok: true, bindings: { agents: [aid] },
      agentDetails: [{ agent_id: aid }],
    });
    const bindingsFile = paths.projectBindingsFile('member', pid);
    return { agents, projects, paths, pid, aid, target, body, bindingsFile };
  }

  it.each(['commit', 'rollback'])('keeps bindings and recovers details after an Agent update %s', async outcome => {
    const { agents, pid, aid, target, body, bindingsFile } = await fixture();
    const before = fs.readFileSync(bindingsFile, 'utf8');
    const { replaceDirectoryAtomically } = await import('../../../src/main/util/atomic-directory-replace');
    let release!: () => void;
    let moved!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    const reached = new Promise<void>(resolve => { moved = resolve; });
    const rename = fs.promises.rename.bind(fs.promises);
    const spy = vi.spyOn(fs.promises, 'rename').mockImplementation(async (from, to) => {
      await rename(from, to);
      if (String(from) === target && String(to).endsWith('.previous')) {
        moved();
        await held;
      }
    });
    syncBuiltinESMExports();
    // Use the real install helper, pausing only the gap between its two renames.
    const replacement = replaceDirectoryAtomically(target, async staged => {
      fs.writeFileSync(path.join(staged, 'agent.json'), body);
    }, async () => {
      if (outcome === 'rollback') throw new Error('injected commit failure');
    }).then(() => null, error => error);
    try {
      await reached;
      expect(fs.existsSync(target)).toBe(false);
      expect(await invoke('projects.bindings.list', { projectId: pid })).toMatchObject({
        ok: true, bindings: { agents: [aid] },
        agentDetails: [{ agent_id: aid, name: '', enabled: false, unavailable: true }],
      });
      expect(fs.readFileSync(bindingsFile, 'utf8')).toBe(before);
    } finally {
      release();
      await replacement;
      spy.mockRestore();
      syncBuiltinESMExports();
    }
    const error = await replacement;
    if (outcome === 'rollback') expect(error?.message).toBe('injected commit failure');
    else expect(error).toBeNull();
    agents.clearAgentListCache();
    expect(await invoke('projects.bindings.list', { projectId: pid })).toMatchObject({
      ok: true, bindings: { agents: [aid] }, agentDetails: [{ agent_id: aid }],
    });
    expect(fs.readFileSync(bindingsFile, 'utf8')).toBe(before);
  });

  it('keeps an Agent added after a resource-list scan and shows it on the next read', async () => {
    const { agents, projects, paths, pid, aid, bindingsFile } = await fixture();
    const metadata = bindingsFile;
    const read = fs.promises.readFile.bind(fs.promises);
    let release!: () => void;
    let scanned!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    const reached = new Promise<void>(resolve => { scanned = resolve; });
    let paused = false;
    const spy = vi.spyOn(fs.promises, 'readFile').mockImplementation(async (...args: any[]) => {
      // The local IPC handler reads bindings after obtaining its catalog.
      if (!paused && String(args[0]) === metadata) {
        paused = true;
        scanned();
        await held;
      }
      return (read as any)(...args);
    });
    syncBuiltinESMExports();
    const pending = invoke('projects.bindings.list', { projectId: pid });
    let newId = '';
    let bound = '';
    try {
      await reached;
      const created = await agents.createCustomAgent({ name: 'New', description: 'desc' });
      if (!created) throw new Error('fixture Agent creation failed');
      newId = created.agent_id;
      expect((await projects.addAgentBinding('member', pid, newId)).ok).toBe(true);
      bound = fs.readFileSync(bindingsFile, 'utf8');
    } finally {
      release();
      await pending;
      spy.mockRestore();
      syncBuiltinESMExports();
      await (await import('../../../src/main/quality/report')).drainReportWrites();
    }
    expect((await pending).ok).toBe(true);
    expect(fs.readFileSync(bindingsFile, 'utf8')).toBe(bound);
    const refreshed = await invoke('projects.bindings.list', { projectId: pid });
    expect(refreshed.ok).toBe(true);
    expect(refreshed.bindings.agents.sort()).toEqual([aid, newId].sort());
    expect(refreshed.agentDetails.map((agent: any) => agent.agent_id).sort()).toEqual([aid, newId].sort());
  });

  it('allows explicit removal while the definition is missing and does not rebind it on recovery', async () => {
    const { agents, projects, pid, aid, target, body } = await fixture();
    const definition = path.join(target, 'agent.json');
    fs.unlinkSync(definition);
    agents.clearAgentListCache();
    expect(await invoke('projects.bindings.list', { projectId: pid })).toMatchObject({
      ok: true, bindings: { agents: [aid] },
        agentDetails: [{ agent_id: aid, name: '', enabled: false, unavailable: true }],
    });
    expect(await invoke('projects.bindings.remove', { projectId: pid, kind: 'agent', id: aid }))
      .toMatchObject({ ok: true, bindings: { agents: [] } });
    fs.writeFileSync(definition, body);
    agents.clearAgentListCache();
    expect((await agents.listAgentSummaries()).map(agent => agent.agent_id)).toContain(aid);
    expect(await invoke('projects.bindings.list', { projectId: pid }))
      .toMatchObject({ ok: true, bindings: { agents: [] }, agentDetails: [] });
    expect((await projects.getBindings('member', pid)).agents).toEqual([]);
  });

  it('marks a deleted custom Agent unavailable until the user removes it', async () => {
    const { agents, projects, pid, aid } = await fixture();
    const created = await agents.createCustomAgent({ name: 'Deleted-later', description: 'desc' });
    if (!created) throw new Error('fixture Agent creation failed');
    const id = created.agent_id;
    expect((await projects.addAgentBinding('member', pid, id)).ok).toBe(true);
    expect(await agents.deleteCustomAgent(id)).toBe(true);
    const listed = await invoke('projects.bindings.list', { projectId: pid });
    expect(listed.ok).toBe(true);
    expect(listed.bindings.agents.sort()).toEqual([aid, id].sort());
    // An ordinary project carries no sharing metadata on the placeholder.
    expect(listed.agentDetails.find((agent: any) => agent.agent_id === id))
      .toEqual({ agent_id: id, name: '', enabled: false, unavailable: true });
    expect(listed.agentDetails.find((agent: any) => agent.agent_id === aid)).toMatchObject({ name: 'Bound' });
    expect(await invoke('projects.bindings.remove', { projectId: pid, kind: 'agent', id }))
      .toMatchObject({ ok: true, bindings: { agents: [aid] } });
    expect((await invoke('projects.bindings.list', { projectId: pid })).agentDetails
      .map((agent: any) => agent.agent_id)).toEqual([aid]);
  });
});
