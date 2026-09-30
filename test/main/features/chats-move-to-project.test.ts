/**
 * Moving an existing conversation into a project.
 *
 * `project_id` used to be frozen at create time, and it is not just a field:
 * it decides where the messages, group companion dir, commander and per-agent
 * sessions, attachments and artifacts live. A move that flips the row without
 * carrying the bytes leaves the user with a conversation that opens empty, so
 * these cases check the filesystem on both sides rather than the returned
 * record.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';

vi.mock('../../../src/main/logger', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

let tmpDir: string;
let prevWs: string | undefined;
const UID = 'u1';
const PID = 'p_move_target';

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-conv-move-'));
  prevWs = process.env.ORKAS_WORKSPACE_ROOT;
  process.env.ORKAS_WORKSPACE_ROOT = tmpDir;
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

function write(file: string, body: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body);
}

/** Give a conversation one file of every kind a move has to carry. */
function seedConversationBytes(cid: string): void {
  write(cloud('chats', `${cid}.jsonl`), '{"from":"user","text":"hello"}\n');
  write(cloud('chats', cid, 'members.json'), '{"version":1,"actors":[]}');
  write(cloud('chats', cid, 'state.json'), '{"status":"idle"}');
  write(cloud('sessions', `gconv-${cid}.jsonl`), 'commander\n');
  write(cloud('sessions', `gconv-${cid}.jsonl.context.json`), '{}');
  write(cloud('sessions', `gconv-${cid}.tool-results`, 'r1.json'), '{}');
  write(cloud('sessions', `gmember-${cid}-agent1.jsonl`), 'member\n');
  write(cloud('sessions', `gmember-${cid}-agent1.tool-results`, 'r2.json'), '{}');
  write(cloud('chat_attachments', cid, 'note.txt'), 'attached');
  write(cloud('chat_artifacts', cid, 'art1', 'index.html'), '<p>art</p>');
  // Another conversation's bytes sit in the same flat directories and must be
  // left alone; the session sweep matches by prefix.
  write(cloud('sessions', 'gconv-other.jsonl'), 'other\n');
  write(cloud('sessions', `gmember-other-${cid}.jsonl`), 'not mine\n');
}

function projectPaths(cid: string): string[] {
  return [
    cloud('projects', PID, 'chats', `${cid}.jsonl`),
    cloud('projects', PID, 'chats', cid, 'members.json'),
    cloud('projects', PID, 'chats', cid, 'state.json'),
    cloud('projects', PID, 'sessions', `gconv-${cid}.jsonl`),
    cloud('projects', PID, 'sessions', `gconv-${cid}.jsonl.context.json`),
    cloud('projects', PID, 'sessions', `gconv-${cid}.tool-results`, 'r1.json'),
    cloud('projects', PID, 'sessions', `gmember-${cid}-agent1.jsonl`),
    cloud('projects', PID, 'sessions', `gmember-${cid}-agent1.tool-results`, 'r2.json'),
    cloud('projects', PID, 'chat_attachments', cid, 'note.txt'),
    cloud('projects', PID, 'chat_artifacts', cid, 'art1', 'index.html'),
  ];
}

function globalPaths(cid: string): string[] {
  return [
    cloud('chats', `${cid}.jsonl`),
    cloud('chats', cid),
    cloud('sessions', `gconv-${cid}.jsonl`),
    cloud('sessions', `gconv-${cid}.jsonl.context.json`),
    cloud('sessions', `gconv-${cid}.tool-results`),
    cloud('sessions', `gmember-${cid}-agent1.jsonl`),
    cloud('sessions', `gmember-${cid}-agent1.tool-results`),
    cloud('chat_attachments', cid),
    cloud('chat_artifacts', cid),
  ];
}

function readIndex(file: string): any[] {
  try { return JSON.parse(fs.readFileSync(file, 'utf-8')); } catch { return []; }
}

async function seedProject(): Promise<void> {
  write(cloud('projects', PID, 'project.json'),
    JSON.stringify({ project_id: PID, name: 'Target', created_at: new Date().toISOString() }));
}

describe('chats › moveConversationToProject', () => {
  it('carries every location into the project and leaves nothing behind', async () => {
    const chats = await import('../../../src/main/features/chats');
    await seedProject();
    const conv = await chats.createConversation(UID, { title: 'loose task' });
    const cid = conv.conversation_id;
    seedConversationBytes(cid);

    const result = await chats.moveConversationToProject(UID, cid, PID);
    expect(result.ok).toBe(true);

    for (const file of projectPaths(cid)) expect({ file, exists: fs.existsSync(file) }).toEqual({ file, exists: true });
    for (const file of globalPaths(cid)) expect({ file, exists: fs.existsSync(file) }).toEqual({ file, exists: false });
    // Content, not just presence: a move that truncated a file would pass an
    // existence check.
    expect(fs.readFileSync(cloud('projects', PID, 'chats', `${cid}.jsonl`), 'utf-8'))
      .toBe('{"from":"user","text":"hello"}\n');
    expect(fs.readFileSync(cloud('projects', PID, 'chat_attachments', cid, 'note.txt'), 'utf-8'))
      .toBe('attached');

    // Someone else's sessions stayed put.
    expect(fs.existsSync(cloud('sessions', 'gconv-other.jsonl'))).toBe(true);
    expect(fs.existsSync(cloud('sessions', `gmember-other-${cid}.jsonl`))).toBe(true);

    // The row lives in exactly one index.
    expect(readIndex(cloud('chats', '_index.json')).some((r) => r.conversation_id === cid)).toBe(false);
    const projectRow = readIndex(cloud('projects', PID, 'chats', '_index.json'))
      .find((r) => r.conversation_id === cid);
    expect(projectRow?.project_id).toBe(PID);
    expect(projectRow?.title).toBe('loose task');
  });

  it.each([false, true])('rejects admission during a move and resumes after commit or rollback (rollback: %s)', async (rollback) => {
    const chats = await import('../../../src/main/features/chats');
    const storage = await import('../../../src/main/storage');
    const bus = await import('../../../src/main/features/group_chat/bus');
    const layout = await import('../../../src/main/util/project-layout');
    await seedProject();
    const conv = await chats.createConversation(UID, { title: 'Move admission' });
    const cid = conv.conversation_id;
    seedConversationBytes(cid);
    expect(layout.findProjectIdForConversation(UID, cid)).toBeNull();
    let entered!: () => void;
    let release!: () => void;
    const atCommit = new Promise<void>(resolve => { entered = resolve; });
    const resume = new Promise<void>(resolve => { release = resolve; });
    const original = storage.writeJson;
    let sideEffect!: () => void;
    const oldRootWrite = new Promise<'old-root-write'>(resolve => { sideEffect = () => resolve('old-root-write'); });
    let paused = false;
    vi.spyOn(storage, 'writeJson').mockImplementation(async (file, data) => {
      if (!paused && file === cloud('chats', '_index.json')) {
        paused = true;
        entered();
        await resume;
        if (rollback) throw new Error('injected move commit failure');
      }
      if (file.startsWith(cloud('chats', cid) + path.sep)) sideEffect();
      return original(file, data);
    });
    const moving = chats.moveConversationToProject(UID, cid, PID);
    let admission: Promise<unknown> | undefined;
    try {
      await atCommit;
      // This enqueue has no model recipient; admission itself must be rejected
      // before roster/state/message writers can recreate the old source tree.
      admission = bus.enqueue({ uid: UID, cid, fromActorId: 'commander',
        forceTo: ['user'], text: 'must not land during relocation' })
        .then(() => 'accepted', () => 'rejected');
      expect(await Promise.race([admission, oldRootWrite])).toBe('rejected');
      expect(fs.existsSync(cloud('chats', cid))).toBe(false);
      expect(fs.existsSync(cloud('chats', `${cid}.jsonl`))).toBe(false);
    } finally { release(); await moving; await admission; }
    expect(await moving).toMatchObject({ ok: !rollback });
    const delivered = await bus.enqueue({ uid: UID, cid, fromActorId: 'commander',
      forceTo: ['user'], text: 'sent after settled move' });
    expect(delivered.text).toBe('sent after settled move');
    const file = layout.conversationMessageReadFile(UID, cid);
    expect(file).toBe(rollback ? cloud('chats', `${cid}.jsonl`)
      : cloud('projects', PID, 'chats', `${cid}.jsonl`));
    expect(fs.readFileSync(file, 'utf8')).toContain('sent after settled move');
    expect(fs.readFileSync(file, 'utf8')).not.toContain('must not land');
    await bus.dropConv(UID, cid);
  });

  it('resolves later reads against the new root', async () => {
    // Ownership is cached per process and a positive answer never expires, so
    // a lookup taken before the move would otherwise pin the old root for the
    // rest of the session and every path derived from it would be wrong.
    const chats = await import('../../../src/main/features/chats');
    const layout = await import('../../../src/main/util/project-layout');
    await seedProject();
    const conv = await chats.createConversation(UID, { title: 'loose task' });
    const cid = conv.conversation_id;
    seedConversationBytes(cid);

    expect(layout.findProjectIdForConversation(UID, cid)).toBe(null);
    await chats.moveConversationToProject(UID, cid, PID);

    expect(layout.findProjectIdForConversation(UID, cid)).toBe(PID);
    expect(layout.conversationMessageReadFile(UID, cid))
      .toBe(cloud('projects', PID, 'chats', `${cid}.jsonl`));
  });

  it.each([{ status: 'running' }, { status: 'aborted', in_flight: ['agent1'] }])('refuses while a turn is active or draining (%j) and moves nothing', async (state) => {
    const chats = await import('../../../src/main/features/chats');
    await seedProject();
    const conv = await chats.createConversation(UID, { title: 'busy task' });
    const cid = conv.conversation_id;
    seedConversationBytes(cid);
    write(cloud('chats', cid, 'state.json'), JSON.stringify(state));

    const result = await chats.moveConversationToProject(UID, cid, PID);
    expect(result).toEqual({ ok: false, error: 'has_running_conv' });
    expect(fs.existsSync(cloud('chats', `${cid}.jsonl`))).toBe(true);
    expect(fs.existsSync(cloud('projects', PID, 'chats', `${cid}.jsonl`))).toBe(false);
    expect(readIndex(cloud('chats', '_index.json')).some((r) => r.conversation_id === cid)).toBe(true);
  });

  it('tells the search index its source layout changed', async () => {
    // The move must revoke search trust and schedule repair before returning.
    // The worker persists the invalidation asynchronously, so a synchronous
    // database assertion would mistake a queued write for a missing repair.
    const chats = await import('../../../src/main/features/chats');
    const search = await import('../../../src/main/features/search');
    const indexer = await import('../../../src/main/features/search/indexer');
    const chatStore = await import('../../../src/main/features/search/chat_store');
    await seedProject();
    const conv = await chats.createConversation(UID, { title: 'loose task' });
    const cid = conv.conversation_id;
    seedConversationBytes(cid);
    expect((await indexer.reconcileChatsIndex(UID)).complete).toBe(true);
    expect((await search.searchIndexStatus(UID)).chat_index_complete).toBe(true);

    expect((await chats.moveConversationToProject(UID, cid, PID)).ok).toBe(true);
    expect((await search.searchIndexStatus(UID)).chat_index_complete).toBe(false);
    expect(search.__searchTestHooks.hasPendingChatRepair(UID)).toBe(true);
    await indexer.drainDeferredChatWrites(UID);
    expect(chatStore.readSourceStamp(UID)).toBeUndefined();
  });

  it('refuses a conversation that already belongs to a project', async () => {
    const chats = await import('../../../src/main/features/chats');
    await seedProject();
    write(cloud('projects', 'p_origin', 'project.json'),
      JSON.stringify({ project_id: 'p_origin', name: 'Origin' }));
    const conv = await chats.createConversation(UID, { title: 'owned', projectId: 'p_origin' });

    const result = await chats.moveConversationToProject(UID, conv.conversation_id, PID);
    expect(result).toEqual({ ok: false, error: 'already_in_project' });
  });

  it('restores every location when one of them cannot move', async () => {
    // A destination collision must leave every source untouched and preserve
    // the existing destination rather than merging unrelated bytes.
    const chats = await import('../../../src/main/features/chats');
    await seedProject();
    const conv = await chats.createConversation(UID, { title: 'loose task' });
    const cid = conv.conversation_id;
    seedConversationBytes(cid);
    write(cloud('projects', PID, 'chat_attachments', cid, 'squatter.txt'), 'in the way');

    const result = await chats.moveConversationToProject(UID, cid, PID);
    expect(result).toEqual({ ok: false, error: 'move_failed' });

    for (const file of globalPaths(cid)) expect({ file, exists: fs.existsSync(file) }).toEqual({ file, exists: true });
    expect(fs.readFileSync(cloud('chats', `${cid}.jsonl`), 'utf-8'))
      .toBe('{"from":"user","text":"hello"}\n');
    expect(fs.existsSync(cloud('projects', PID, 'chats', `${cid}.jsonl`))).toBe(false);
    expect(fs.existsSync(cloud('projects', PID, 'sessions', `gconv-${cid}.jsonl`))).toBe(false);
    expect(readIndex(cloud('chats', '_index.json')).some((r) => r.conversation_id === cid)).toBe(true);
    expect(readIndex(cloud('projects', PID, 'chats', '_index.json')).some((r) => r.conversation_id === cid))
      .toBe(false);
  });
  it.each(['source-index', 'target-index', 'meta'])('restores indexes and bytes after a failed %s commit', async (stage) => {
    const chats = await import('../../../src/main/features/chats');
    const storage = await import('../../../src/main/storage');
    await seedProject();
    const conv = await chats.createConversation(UID, { title: 'retained history' });
    const unrelated = await chats.createConversation(UID, { title: 'other task', projectId: PID });
    const cid = conv.conversation_id;
    seedConversationBytes(cid);
    const failedPath = stage === 'source-index' ? cloud('chats', '_index.json')
      : stage === 'target-index' ? cloud('projects', PID, 'chats', '_index.json')
      : cloud('projects', PID, 'chats', cid, 'meta.json');
    const original = storage.writeJson;
    let failed = false;
    vi.spyOn(storage, 'writeJson').mockImplementation(async (file, data) => {
      if (file === failedPath && !failed) { failed = true; throw new Error('injected write failure'); }
      // A sibling index may still be in flight after Promise.all rejects.
      if (!failed && file === cloud('chats', '_index.json')) await new Promise(resolve => setTimeout(resolve, 20));
      return original(file, data);
    });
    expect(await chats.moveConversationToProject(UID, cid, PID)).toEqual({ ok: false, error: 'move_failed' });
    expect(failed).toBe(true);
    await new Promise(resolve => setTimeout(resolve, 60));
    expect(readIndex(cloud('chats', '_index.json')).find(r => r.conversation_id === cid)?.title).toBe('retained history');
    const targetRows = readIndex(cloud('projects', PID, 'chats', '_index.json'));
    expect(targetRows.some(r => r.conversation_id === cid)).toBe(false);
    expect(targetRows.some(r => r.conversation_id === unrelated.conversation_id)).toBe(true);
    for (const file of globalPaths(cid)) expect(fs.existsSync(file)).toBe(true);
    expect((await chats.listConversations(UID)).find(r => r.conversation_id === cid)?.project_id).toBeFalsy();
    expect((await chats.moveConversationToProject(UID, cid, PID)).ok).toBe(true);
  });

  // Kill the actual writer process, so catch/finally and in-memory rollback
  // cannot conceal a missing durable recovery step.
  it.each(['rename', 'source-index', 'target-index', 'meta', 'committed'])(
    'recovers history and ownership after process exit at %s', async (stage) => {
      const chats = await import('../../../src/main/features/chats');
      await seedProject();
      const conv = await chats.createConversation(UID, { title: 'survives restart' });
      const other = await chats.createConversation(UID, { title: 'unrelated', projectId: PID });
      const cid = conv.conversation_id;
      seedConversationBytes(cid);
      const result = spawnSync(process.execPath, ['-r', 'tsx/cjs', '-e', `
        const fs = require('node:fs');
        const slash = file => file.split(require('node:path').sep).join('/');
        const uid = ${JSON.stringify(UID)}, cid = ${JSON.stringify(cid)}, pid = ${JSON.stringify(PID)};
        const stage = ${JSON.stringify(stage)};
        require('./src/main/features/users.ts').activateUser(uid);
        const chats = require('./src/main/features/chats.ts');
        const rename = fs.renameSync;
        fs.renameSync = function(from, to) {
          const out = rename(from, to);
          if (stage === 'rename' && slash(from).endsWith('/chats/' + cid + '.jsonl')) process.exit(73);
          if (stage === 'committed' && slash(to).endsWith('/conversation-moves/' + cid + '.json')
            && JSON.parse(fs.readFileSync(to, 'utf8')).phase === 'committed') process.exit(73);
          return out;
        };
        const fsp = require('node:fs/promises');
        const renameAsync = fsp.rename;
        fsp.rename = async function(from, to) {
          const out = await renameAsync(from, to);
          const suffix = stage === 'source-index' ? '/cloud/chats/_index.json'
            : stage === 'target-index' ? '/projects/' + pid + '/chats/_index.json'
            : stage === 'meta' ? '/projects/' + pid + '/chats/' + cid + '/meta.json' : '';
          if (suffix && slash(to).endsWith(suffix)) process.exit(73);
          return out;
        };
        chats.moveConversationToProject(uid, cid, pid).then(() => process.exit(74));
      `], {
        cwd: path.resolve(__dirname, '../../..'),
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', ORKAS_WORKSPACE_ROOT: tmpDir },
        encoding: 'utf8', timeout: 30_000,
      });
      expect({ status: result.status, stdout: result.stdout, stderr: result.stderr, error: result.error?.message })
        .toEqual({ status: 73, stdout: '', stderr: '', error: undefined });
      // Persisted bytes moved before interruption, with a real recovery record.
      expect(fs.existsSync(cloud('projects', PID, 'chats', `${cid}.jsonl`))).toBe(true);
      expect(fs.existsSync(path.join(tmpDir, UID, 'local', 'conversation-moves', `${cid}.json`))).toBe(true);
      vi.resetModules();
      const users = await import('../../../src/main/features/users');
      users.activateUser(UID);
      users.activateUser(UID); // A second activation cannot undo committed work.
      const restarted = await import('../../../src/main/features/chats');
      const layout = await import('../../../src/main/util/project-layout');
      const owner = stage === 'committed' ? PID : null;
      expect(layout.findProjectIdForConversation(UID, cid)).toBe(owner);
      expect(fs.readFileSync(layout.conversationMessageReadFile(UID, cid), 'utf8'))
        .toBe('{"from":"user","text":"hello"}\n');
      const attachments = layout.chatAttachmentDirForConversation(UID, cid);
      expect(fs.readFileSync(path.join(attachments, 'note.txt'), 'utf8')).toBe('attached');
      const rows = await restarted.listConversations(UID);
      expect(rows.filter(row => row.conversation_id === cid)).toHaveLength(1);
      expect(rows.find(row => row.conversation_id === cid)?.project_id || null).toBe(owner);
      expect(rows.find(row => row.conversation_id === other.conversation_id)?.project_id).toBe(PID);
      for (const file of stage === 'committed' ? projectPaths(cid) : globalPaths(cid)) expect(fs.existsSync(file)).toBe(true);
      if (stage !== 'committed') expect((await restarted.moveConversationToProject(UID, cid, PID)).ok).toBe(true);
    }, 40_000,
  );

  it('preserves conflicting copies and retains recovery evidence until the conflict is resolved', async () => {
    const chats = await import('../../../src/main/features/chats');
    const relocation = await import('../../../src/main/util/conversation-relocate');
    await seedProject();
    const conv = await chats.createConversation(UID, { title: 'conflict' });
    const cid = conv.conversation_id;
    const other = await chats.createConversation(UID, { title: 'unrelated task' });
    seedConversationBytes(cid);
    relocation.relocateConversationIntoProject(UID, cid, PID, { ...conv });
    write(cloud('chats', `${cid}.jsonl`), 'new source bytes');
    expect(relocation.recoverConversationRelocations(UID)).toBe(1);
    const layout = await import('../../../src/main/util/project-layout');
    expect(() => layout.conversationMessageFile(UID, cid, null)).toThrow();
    expect(() => layout.conversationMessageFile(UID, 'unrelated', null)).not.toThrow();
    const users = await import('../../../src/main/features/users');
    expect(() => users.activateUser(UID)).not.toThrow();
    // One blocked conversation in the running journal must not abort the
    // stale-state sweep for the rest of the account: the unrelated
    // interrupted run still gets settled.
    const paths = await import('../../../src/main/paths');
    write(paths.userRunningConversationsFile(UID), JSON.stringify({
      version: 1, items: [{ conversation_id: cid }, { conversation_id: other.conversation_id }],
    }));
    const otherState = cloud('chats', other.conversation_id, 'state.json');
    write(otherState, JSON.stringify({
      version: 1, status: 'running', in_flight: ['commander'],
      last_active_at: new Date(Date.now() - 60_000).toISOString(),
    }));
    const indexer = await import('../../../src/main/features/search/indexer');
    try {
      expect((await chats.sweepStaleProcessing(UID)).swept).toBe(1);
      expect(JSON.parse(fs.readFileSync(otherState, 'utf8')).status).toBe('idle');
    } finally { await indexer.flushAll(); }
    expect((await chats.listConversations(UID)).some(row => row.conversation_id === other.conversation_id)).toBe(true);
    expect(await chats.renameConversation(UID, other.conversation_id, 'still usable')).toMatchObject({ title: 'still usable' });

    expect(fs.readFileSync(cloud('chats', `${cid}.jsonl`), 'utf8')).toBe('new source bytes');
    expect(fs.readFileSync(cloud('projects', PID, 'chats', `${cid}.jsonl`), 'utf8')).toContain('hello');
    expect(fs.existsSync(path.join(tmpDir, UID, 'local', 'conversation-moves', `${cid}.json`))).toBe(true);

    // Journal inspection stays available: the conflicted conversation is
    // reported with both of its trees, a record this version cannot read is
    // reported by its file name, and neither counts as a committed intent.
    const broken = await chats.createConversation(UID, { title: 'broken record' });
    write(path.join(tmpDir, UID, 'local', 'conversation-moves', `${broken.conversation_id}.json`), '{"version":99,"pid":"p_x"}');
    const journals = relocation.readConversationRelocationJournals(UID);
    expect(journals.committed).toEqual([]);
    expect(journals.unresolved.map((item) => item.cid).sort()).toEqual([cid, broken.conversation_id].sort());
    for (const rel of [
      `cloud/chats/${cid}.jsonl`, `cloud/chats/${cid}/state.json`, `cloud/sessions/gconv-${cid}.jsonl`,
      `cloud/chat_attachments/${cid}/note.txt`, `cloud/projects/${PID}/chats/${cid}.jsonl`,
      `cloud/projects/${PID}/chat_artifacts/${cid}/art1/index.html`,
      `cloud/chats/${broken.conversation_id}.jsonl`, `cloud/projects/p_x/sessions/gmember-${broken.conversation_id}-agent1.jsonl`,
    ]) expect(relocation.matchesUnresolvedRelocation(journals.unresolved, rel), rel).toBe(true);
    for (const rel of [
      `cloud/chats/${other.conversation_id}.jsonl`, 'cloud/sessions/gconv-other.jsonl',
      `cloud/sessions/gmember-other-${cid}.jsonl`, 'cloud/contexts/notes.md',
    ]) expect(relocation.matchesUnresolvedRelocation(journals.unresolved, rel), rel).toBe(false);
    expect(relocation.committedConversationRelocations(UID)).toEqual([]);
  });

});
