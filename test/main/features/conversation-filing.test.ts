/**
 * Filing a loose conversation under a new project — the composition itself.
 *
 * `chats-move-to-project.test.ts` already owns the relocation: which bytes
 * move, what happens when one location cannot, and how recovery settles. What
 * is untested is the composition a caller with no picker performs — create the
 * project, carry the conversation in, bind its member agents — and the two
 * outcomes that composition can get wrong: leaving a stray project behind when
 * the conversation was never eligible, and relocating a conversation whose turn
 * is still running because the caller cannot wait for quiescence.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

vi.mock('../../../src/main/logger', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

const registry = new Map<string, { agent_id: string; enabled?: boolean }>();
vi.mock('../../../src/main/features/agents', () => ({
  getAgent: async (id: string) => registry.get(id),
}));

let tmpDir: string;
let prevWs: string | undefined;
const UID = 'u-filing';

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-conv-filing-'));
  prevWs = process.env.ORKAS_WORKSPACE_ROOT;
  process.env.ORKAS_WORKSPACE_ROOT = tmpDir;
  registry.clear();
  vi.resetModules();
  const users = await import('../../../src/main/features/users');
  users.activateUser(UID);
});

afterEach(async () => {
  await (await import('../../../src/main/features/search/indexer')).flushAll();
  vi.restoreAllMocks();
  process.env.ORKAS_WORKSPACE_ROOT = prevWs;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const cloud = (...parts: string[]) => path.join(tmpDir, UID, 'cloud', ...parts);

function readIndex(file: string): any[] {
  try { return JSON.parse(fs.readFileSync(file, 'utf-8')); } catch { return []; }
}

/** The durable roster an agent's first turn writes. */
function seedAgentMember(cid: string, agentId: string): void {
  registry.set(agentId, { agent_id: agentId, enabled: true });
  const file = cloud('chats', cid, 'members.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({
    version: 1,
    actors: [
      { kind: 'commander', id: 'commander', name: 'Commander' },
      { kind: 'agent', id: agentId, name: 'Analyst' },
    ],
  }));
}

describe('conversation filing › fileConversationUnderNewProject', () => {
  it('carries the conversation into a project it creates and binds its member agents', async () => {
    const chats = await import('../../../src/main/features/chats');
    const projects = await import('../../../src/main/features/projects');
    const filing = await import('../../../src/main/features/conversation_filing');
    const conv = await chats.createConversation(UID, { title: 'competitor releases' });
    const cid = conv.conversation_id;
    seedAgentMember(cid, 'agent-analyst');

    const filed = await filing.fileConversationUnderNewProject(UID, cid, 'Competitor tracking');
    expect(filed.ok).toBe(true);
    const result = (filed as { result: any }).result;
    expect(result.filed).toBe('moved');

    // The conversation's own record moved, not just the returned object.
    const pid = result.project.project_id;
    expect(readIndex(cloud('chats', '_index.json')).some((r) => r.conversation_id === cid)).toBe(false);
    expect(readIndex(cloud('projects', pid, 'chats', '_index.json'))
      .find((r) => r.conversation_id === cid)?.project_id).toBe(pid);

    // The member agent came along; the commander is not an agent binding.
    const bindings = await projects.getBindings(UID, pid);
    expect(bindings.agents).toEqual(['agent-analyst']);
    expect(result.bound).toEqual(['agent-analyst']);
    expect(result.unbound).toEqual([]);
  });

  it('refuses a conversation that already belongs to a project without leaving a new one behind', async () => {
    const chats = await import('../../../src/main/features/chats');
    const projects = await import('../../../src/main/features/projects');
    const filing = await import('../../../src/main/features/conversation_filing');
    const first = await projects.createProject(UID, 'Existing');
    const pid = (first as { project: any }).project.project_id;
    const conv = await chats.createConversation(UID, { title: 'already filed' });
    expect((await chats.moveConversationToProject(UID, conv.conversation_id, pid)).ok).toBe(true);

    const filed = await filing.fileConversationUnderNewProject(UID, conv.conversation_id, 'Second home');
    expect(filed).toEqual({ ok: false, error: 'already_in_project' });
    // The eligibility check has to run before the project is created, or the
    // user is left with an empty project they never asked for.
    expect((await projects.listProjects(UID)).map((p) => p.name)).toEqual(['Existing']);
  });

  it('creates the project but leaves the relocation to the host when the caller defers', async () => {
    const chats = await import('../../../src/main/features/chats');
    const projects = await import('../../../src/main/features/projects');
    const filing = await import('../../../src/main/features/conversation_filing');
    const conv = await chats.createConversation(UID, { title: 'mid-turn' });
    const cid = conv.conversation_id;
    seedAgentMember(cid, 'agent-writer');

    const filed = await filing.fileConversationUnderNewProject(UID, cid, 'Deferred', { moveNow: false });
    expect(filed.ok).toBe(true);
    const result = (filed as { result: any }).result;
    expect(result.filed).toBe('deferred');
    expect(result.conversation).toBeUndefined();

    // Project and bindings are ready; the conversation has not moved, because a
    // caller inside the conversation's own turn cannot satisfy the quiescence
    // guard the relocation requires.
    const pid = result.project.project_id;
    expect((await projects.getBindings(UID, pid)).agents).toEqual(['agent-writer']);
    expect(readIndex(cloud('chats', '_index.json')).some((r) => r.conversation_id === cid)).toBe(true);
    expect(fs.existsSync(cloud('projects', pid, 'chats', `${cid}.jsonl`))).toBe(false);
  });

  it('suffixes a duplicate project name instead of failing a caller that cannot ask again', async () => {
    const chats = await import('../../../src/main/features/chats');
    const projects = await import('../../../src/main/features/projects');
    const filing = await import('../../../src/main/features/conversation_filing');
    await projects.createProject(UID, 'Weekly report');
    const conv = await chats.createConversation(UID, { title: 'another weekly' });

    const filed = await filing.fileConversationUnderNewProject(
      UID, conv.conversation_id, 'Weekly report', { uniquifyName: true },
    );
    expect(filed.ok).toBe(true);
    expect((filed as { result: any }).result.project.name).toBe('Weekly report 2');
  });

  it('reports a duplicate name to a caller that can ask again', async () => {
    const chats = await import('../../../src/main/features/chats');
    const projects = await import('../../../src/main/features/projects');
    const filing = await import('../../../src/main/features/conversation_filing');
    await projects.createProject(UID, 'Weekly report');
    const conv = await chats.createConversation(UID, { title: 'another weekly' });

    const filed = await filing.fileConversationUnderNewProject(UID, conv.conversation_id, 'Weekly report');
    expect(filed).toEqual({ ok: false, error: 'name_dup' });
    expect((await projects.listProjects(UID)).length).toBe(1);
    // A rejected name must not reserve the conversation forever: the caller
    // can correct it and complete setup for the same work.
    expect((await filing.fileConversationUnderNewProject(UID, conv.conversation_id, 'Corrected name')).ok).toBe(true);

  });

  it('still files the work when a member agent cannot be bound', async () => {
    const chats = await import('../../../src/main/features/chats');
    const projects = await import('../../../src/main/features/projects');
    const filing = await import('../../../src/main/features/conversation_filing');
    const conv = await chats.createConversation(UID, { title: 'disabled member' });
    const cid = conv.conversation_id;
    seedAgentMember(cid, 'agent-live');
    // Present in the roster, refused by the account: the same gate the picker's
    // IPC handler applies. Losing a binding is not a reason to leave the work
    // where it was.
    registry.set('agent-retired', { agent_id: 'agent-retired', enabled: false });
    const file = cloud('chats', cid, 'members.json');
    const roster = JSON.parse(fs.readFileSync(file, 'utf-8'));
    roster.actors.push({ kind: 'agent', id: 'agent-retired', name: 'Retired' });
    fs.writeFileSync(file, JSON.stringify(roster));

    const filed = await filing.fileConversationUnderNewProject(UID, cid, 'Partial bindings');
    expect(filed.ok).toBe(true);
    const result = (filed as { result: any }).result;
    expect(result.filed).toBe('moved');
    expect(result.bound).toEqual(['agent-live']);
    expect(result.unbound).toEqual(['agent-retired']);
    expect((await projects.getBindings(UID, result.project.project_id)).agents).toEqual(['agent-live']);
  });

  it('files nothing when no filing was pending', async () => {
    const chats = await import('../../../src/main/features/chats');
    const projects = await import('../../../src/main/features/projects');
    const filing = await import('../../../src/main/features/conversation_filing');
    // The bus drains at every run's terminal boundary, for every conversation.
    // A drain that picked up someone else's project would move work silently.
    const created = await projects.createProject(UID, 'Unrelated');
    const conv = await chats.createConversation(UID, { title: 'no pending filing' });

    expect(filing.hasPendingConversationFiling(UID, conv.conversation_id)).toBe(false);
    await filing.drainConversationFiling(UID, conv.conversation_id);

    expect((await chats.getConversationMetadata(UID, conv.conversation_id))?.project_id).toBeFalsy();
    expect(readIndex(cloud('projects', (created as { project: any }).project.project_id, 'chats', '_index.json')))
      .toEqual([]);
  });
});


describe('conversation filing › repeated deferred setup', () => {
  it.each(['collision', 'exception'] as const)('reports a deferred unfile %s once and preserves its project', async failure => {
    const chats = await import('../../../src/main/features/chats');
    const filing = await import('../../../src/main/features/conversation_filing');
    const conv = await chats.createConversation(UID, { title: 'Filed task' });
    const created = await filing.fileConversationUnderNewProject(UID, conv.conversation_id, 'Keep project');
    expect(created.ok).toBe(true);
    const pid = (created as { result: any }).result.project.project_id;
    const failed = vi.fn(), moved = vi.fn();
    filing.onConversationFilingFailed(failed);
    filing.onConversationFiled(moved);
    expect((await filing.unfileConversation(UID, conv.conversation_id, { moveNow: false })).ok).toBe(true);
    if (failure === 'collision') {
      fs.writeFileSync(cloud('chats', `${conv.conversation_id}.jsonl`), 'collision must remain');
    } else {
      vi.spyOn(chats, 'moveConversationOutOfProject').mockRejectedValueOnce(new Error('synthetic storage failure'));
    }
    await filing.drainConversationFiling(UID, conv.conversation_id);
    await filing.drainConversationFiling(UID, conv.conversation_id);
    expect(failed).toHaveBeenCalledExactlyOnceWith({ userId: UID, cid: conv.conversation_id, kind: 'unfile' });
    expect(moved).not.toHaveBeenCalled();
    expect(filing.hasPendingConversationFiling(UID, conv.conversation_id)).toBe(false);
    expect((await chats.getConversationMetadata(UID, conv.conversation_id))?.project_id).toBe(pid);
    if (failure === 'collision') expect(fs.readFileSync(cloud('chats', `${conv.conversation_id}.jsonl`), 'utf8')).toBe('collision must remain');
  });

  it.each(['serial', 'concurrent'] as const)('rejects a %s second setup without creating another project', async mode => {
    const chats = await import('../../../src/main/features/chats');
    const projects = await import('../../../src/main/features/projects');
    const filing = await import('../../../src/main/features/conversation_filing');
    const conv = await chats.createConversation(UID, { title: 'one ongoing goal' });
    const first = filing.fileConversationUnderNewProject(UID, conv.conversation_id, 'Tracking', { moveNow: false, uniquifyName: true });
    if (mode === 'serial') await first;
    const second = filing.fileConversationUnderNewProject(UID, conv.conversation_id, 'Tracking', { moveNow: false, uniquifyName: true });
    const [accepted, refused] = await Promise.all([first, second]);
    expect(accepted.ok).toBe(true);
    expect(refused).toEqual({ ok: false, error: 'already_in_project' });
    expect((await projects.listProjects(UID)).map(p => p.name)).toEqual(['Tracking']);
    await filing.drainConversationFiling(UID, conv.conversation_id);
    expect((await chats.getConversationMetadata(UID, conv.conversation_id))?.project_id)
      .toBe((accepted as { result: any }).result.project.project_id);
  });
});
