import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// index.ts wraps indexer + BM25 scoring + snippet extraction. Each test sets
// ORKAS_WORKSPACE_ROOT then resetModules so the module graph (paths +
// indexer's _cache) is re-created per test.

let tmpDir: string;
let prevWs: string | undefined;
const TEST_UID = 'u1';

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-search-'));
  prevWs = process.env.ORKAS_WORKSPACE_ROOT;
  process.env.ORKAS_WORKSPACE_ROOT = tmpDir;
  vi.resetModules();
  const users = await import('../../../../src/main/features/users');
  users.activateUser(TEST_UID);
});

afterEach(() => {
  process.env.ORKAS_WORKSPACE_ROOT = prevWs;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

async function loadSearch() {
  return import('../../../../src/main/features/search');
}

function writeContext(rel: string, body: string): void {
  const full = path.join(tmpDir, TEST_UID, 'cloud', 'contexts', rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, body);
}

function writeChat(uid: string, cid: string, messages: unknown[]): void {
  const dir = path.join(tmpDir, uid, 'cloud', 'chats');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${cid}.jsonl`), messages.map((m) => JSON.stringify(m)).join('\n') + '\n');
}

describe('search › searchAll', () => {
  it('returns empty for blank query', async () => {
    const s = await loadSearch();
    const result = await s.searchAll('u1', '');
    expect(result).toEqual({ results: [] });
  });

  it('surfaces a context doc by filename', async () => {
    writeContext('pangolins.md', '# Guide\nThis document discusses pangolins in depth.');
    const s = await loadSearch();
    const ix = await import('../../../../src/main/features/search/indexer');
    await ix.reconcileContextsIndex();
    const { results } = await s.searchAll('u1', 'pangolins');
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].kind).toBe('context');
    expect(results[0].path).toBe('pangolins.md');
    expect(results[0].snippet).toBe('pangolins.md');
  });

  it('does not match on body content (filename-only search)', async () => {
    writeContext('guide.md', '# Guide\npangolins everywhere in the body');
    const s = await loadSearch();
    const ix = await import('../../../../src/main/features/search/indexer');
    await ix.reconcileContextsIndex();
    const { results } = await s.searchAll('u1', 'pangolins', { scope: 'context' });
    expect(results.length).toBe(0);
  });

  it('respects scope=chat (no context results)', async () => {
    writeContext('pangolins.md', '# Guide\nunrelated body');
    writeChat('u1', 'c1', [{ role: 'user', content: 'pangolins everywhere', time: 't' }]);
    const s = await loadSearch();
    const ix = await import('../../../../src/main/features/search/indexer');
    await ix.reconcileContextsIndex();
    await ix.reconcileChatsIndex('u1');
    const { results } = await s.searchAll('u1', 'pangolins', { scope: 'chat' });
    expect(results.every((r) => r.kind === 'chat')).toBe(true);
    expect(results.length).toBeGreaterThan(0);
  });

  it('limits results to the given limit', async () => {
    for (let i = 0; i < 5; i++) writeContext(`keyword-${i}.md`, `# D${i}\nbody`);
    const s = await loadSearch();
    const ix = await import('../../../../src/main/features/search/indexer');
    await ix.reconcileContextsIndex();
    const { results } = await s.searchAll('u1', 'keyword', { limit: 2 });
    expect(results.length).toBe(2);
  });
});

describe('search › searchContexts', () => {
  it('returns empty when no contexts indexed', async () => {
    const s = await loadSearch();
    const r = await s.searchContexts('anything');
    expect(r).toEqual([]);
  });

  it('ranks a direct filename match (body no longer matters)', async () => {
    writeContext('rhubarb.md', '# Tight\nunrelated body');
    writeContext('noisy.md', '# Noisy\n' + 'lorem '.repeat(500) + 'rhubarb ' + 'ipsum '.repeat(500));
    const s = await loadSearch();
    const ix = await import('../../../../src/main/features/search/indexer');
    await ix.reconcileContextsIndex();
    const results = await s.searchContexts('rhubarb');
    // Only the file whose name contains "rhubarb" should surface.
    expect(results.length).toBe(1);
    expect(results[0].path).toBe('rhubarb.md');
  });

  it('matches on directory segment', async () => {
    writeContext('notes/2024/meeting.md', 'body');
    const s = await loadSearch();
    const ix = await import('../../../../src/main/features/search/indexer');
    await ix.reconcileContextsIndex();
    const results = await s.searchContexts('notes');
    expect(results[0].path).toBe('notes/2024/meeting.md');
  });

  it('reuses the reconciled context snapshot across query keystrokes', async () => {
    writeContext('stable-name.md', 'body');
    const s = await loadSearch();
    const ix = await import('../../../../src/main/features/search/indexer');
    await ix.reconcileContextsIndex();
    fs.rmSync(path.join(tmpDir, TEST_UID, 'cloud', 'contexts', 'stable-name.md'));

    expect((await s.searchContexts('stable')).length).toBe(1);
    ix.invalidateContextsIndex(TEST_UID);
    expect(await s.searchContexts('stable')).toEqual([]);
  });
});

describe('search › searchChats — group-chat shape end-to-end', () => {
  it('finds a query token in current group-chat jsonl shape and returns a snippet', async () => {
    // Pin the bug-fix path: bus refactor changed `<cid>.jsonl` from
    // `{role, content, time}` to `{id, ts, from, to, mentions, text}`.
    // `searchChats` must (a) read text via `text` field for snippet, and
    // (b) `searchAll` with scope=chat must surface the result.
    writeChat('u1', 'cgroup', [
      { id: 'm0', ts: '2026-01-01T00:00:00Z', from: 'user', to: ['commander'], mentions: [], text: 'discussing pangolin habitat' },
    ]);
    const s = await loadSearch();
    const ix = await import('../../../../src/main/features/search/indexer');
    await ix.reconcileChatsIndex('u1');
    const results = await s.searchChats('u1', 'pangolin');
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].cid).toBe('cgroup');
    expect(results[0].role).toBe('user');
    // Snippet must include the matched token (proves `text` field is being
    // read, not the absent `content`).
    expect(results[0].snippet).toMatch(/pangolin/);
  });
});

describe('search › searchChats', () => {
  it('fills conv_title from _index.json when present', async () => {
    writeChat('u1', 'c1', [{ role: 'user', content: 'widget question', time: 't' }]);
    const indexFile = path.join(tmpDir, 'u1', 'cloud', 'chats', '_index.json');
    fs.writeFileSync(indexFile, JSON.stringify([
      { conversation_id: 'c1', title: 'About widgets' },
    ]));
    const s = await loadSearch();
    const ix = await import('../../../../src/main/features/search/indexer');
    await ix.reconcileChatsIndex('u1');
    const results = await s.searchChats('u1', 'widget');
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].conv_title).toBe('About widgets');
  });

  it('falls back to default title when _index.json is missing', async () => {
    writeChat('u1', 'c1', [{ role: 'user', content: 'thingamajig', time: 't' }]);
    const s = await loadSearch();
    const ix = await import('../../../../src/main/features/search/indexer');
    await ix.reconcileChatsIndex('u1');
    const results = await s.searchChats('u1', 'thingamajig');
    expect(results[0].conv_title).toBe('New conversation');
  });

  it('serves a usable invalidated snapshot and schedules one idle repair', async () => {
    writeChat(TEST_UID, 'c1', [{ role: 'user', content: 'stale snapshot token', time: 't' }]);
    const s = await loadSearch();
    const ix = await import('../../../../src/main/features/search/indexer');
    await ix.reconcileChatsIndex(TEST_UID);
    const compactIndex = path.join(tmpDir, TEST_UID, 'cloud', 'chats', '_index.json');
    fs.writeFileSync(compactIndex, JSON.stringify([
      { conversation_id: 'c1', title: 'Synced title' },
    ]));
    ix.invalidateChatsIndex(TEST_UID);

    const results = await s.searchChats(TEST_UID, 'snapshot token');
    expect(results.some((result) => result.cid === 'c1')).toBe(true);
    expect(s.__searchTestHooks.hasPendingChatRepair(TEST_UID)).toBe(true);

    await s.searchChats(TEST_UID, 'snapshot token');
    expect(s.__searchTestHooks.hasPendingChatRepair(TEST_UID)).toBe(true);
    s.__searchTestHooks.cancelChatRepair(TEST_UID);
  });

  it('caches display metadata and invalidates it on conversation/project rename', async () => {
    const projects = await import('../../../../src/main/features/projects');
    const chats = await import('../../../../src/main/features/chats');
    const createdProject = await projects.createProject(TEST_UID, 'Original project');
    expect(createdProject.ok).toBe(true);
    if (!createdProject.ok) return;
    const projectId = createdProject.project.project_id;
    const conversation = await chats.createConversation(TEST_UID, {
      title: 'Original conversation',
      projectId,
    });
    const jsonl = path.join(
      tmpDir, TEST_UID, 'cloud', 'projects', projectId, 'chats',
      `${conversation.conversation_id}.jsonl`,
    );
    fs.writeFileSync(jsonl, `${JSON.stringify({
      role: 'user', content: 'display catalog keyword', time: 't',
    })}\n`);
    const s = await loadSearch();
    const ix = await import('../../../../src/main/features/search/indexer');
    await ix.reconcileChatsIndex(TEST_UID);

    let results = await s.searchChats(TEST_UID, 'catalog keyword');
    expect(results[0]).toMatchObject({
      conv_title: 'Original conversation',
      project_name: 'Original project',
    });

    await chats.renameConversation(
      TEST_UID, conversation.conversation_id, 'Renamed conversation', projectId);
    await projects.renameProject(TEST_UID, projectId, 'Renamed project');
    results = await s.searchChats(TEST_UID, 'catalog keyword');
    expect(results[0]).toMatchObject({
      conv_title: 'Renamed conversation',
      project_name: 'Renamed project',
    });

    const readSpy = vi.spyOn(fs.promises, 'readFile');
    try {
      await s.searchChats(TEST_UID, 'catalog keyword');
      const metadataReads = readSpy.mock.calls.filter(([file]) => (
        String(file).endsWith('_index.json') || String(file).endsWith('project.json')
      ));
      expect(metadataReads).toEqual([]);
    } finally {
      readSpy.mockRestore();
    }
  });
});

describe('search › context snippet', () => {
  it('uses the relPath as snippet (body is not read)', async () => {
    writeContext('deep/sub/distinctivemarker.md', 'body has a different word');
    const s = await loadSearch();
    const ix = await import('../../../../src/main/features/search/indexer');
    await ix.reconcileContextsIndex();
    const results = await s.searchContexts('distinctivemarker');
    expect(results[0].snippet).toBe('deep/sub/distinctivemarker.md');
  });
});

describe('search › CJK bigram anchor (noise-doc rejection)', () => {
  // The bug shape that motivated the anchor filter: a user searches
  // `苏格拉底` (a 4-char term whose individual chars `苏`/`格`/`拉`/`底`
  // appear all over the corpus). Without anchoring, BM25 accumulates
  // unigram contributions for every doc that contains any of those chars
  // — and the noise docs flood the result list while the actual term
  // appears nowhere. With anchoring, the result list is empty whenever
  // no doc contains an adjacent-pair anchor (`苏格` / `格拉` / `拉底`).
  it('rejects docs that contain only individual CJK chars from a multi-char query', async () => {
    // None of these chats contains the full bigram `苏格` / `格拉` / `拉底`,
    // but every one contains at least one of `拉` / `底` (very common chars).
    writeChat('u1', 'noise1', [
      { id: 'm0', ts: 't', from: 'user', to: ['commander'], mentions: [], text: '把这些候选拉成清单' },
    ]);
    writeChat('u1', 'noise2', [
      { id: 'm0', ts: 't', from: 'user', to: ['commander'], mentions: [], text: '底层日志已经写好了' },
    ]);
    writeChat('u1', 'noise3', [
      { id: 'm0', ts: 't', from: 'user', to: ['commander'], mentions: [], text: '关于学习教育的整理' },
    ]);
    const s = await loadSearch();
    const ix = await import('../../../../src/main/features/search/indexer');
    await ix.reconcileChatsIndex('u1');
    const results = await s.searchChats('u1', '苏格拉底');
    expect(results).toEqual([]);
  });

  it('keeps a doc that contains an adjacent-pair anchor from the query', async () => {
    writeChat('u1', 'hit', [
      { id: 'm0', ts: 't', from: 'user', to: ['commander'], mentions: [], text: '苏格拉底的对话风格' },
    ]);
    writeChat('u1', 'noise', [
      { id: 'm0', ts: 't', from: 'user', to: ['commander'], mentions: [], text: '把候选拉到底层' },
    ]);
    const s = await loadSearch();
    const ix = await import('../../../../src/main/features/search/indexer');
    await ix.reconcileChatsIndex('u1');
    const results = await s.searchChats('u1', '苏格拉底');
    expect(results.length).toBe(1);
    expect(results[0].cid).toBe('hit');
  });

  it('single-char CJK query still works (no bigram in tokens → no anchor filter)', async () => {
    writeChat('u1', 'c1', [
      { id: 'm0', ts: 't', from: 'user', to: ['commander'], mentions: [], text: '今天聊水的处理' },
    ]);
    const s = await loadSearch();
    const ix = await import('../../../../src/main/features/search/indexer');
    await ix.reconcileChatsIndex('u1');
    const results = await s.searchChats('u1', '水');
    expect(results.length).toBe(1);
    expect(results[0].cid).toBe('c1');
  });
});

describe('search › reconcileAll', () => {
  it('runs without throwing on an empty workspace', async () => {
    const s = await loadSearch();
    await expect(s.reconcileAll()).resolves.toBeUndefined();
  });

  it('skips reserved top-level dirs (users/, logs/, shared/, search/, openclaw/)', async () => {
    // Create one real user dir with chats, plus some reserved dirs
    writeChat('real_user', 'c1', [{ role: 'user', content: 'target', time: 't' }]);
    fs.mkdirSync(path.join(tmpDir, 'users'), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, 'logs'), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, 'openclaw'), { recursive: true });

    const s = await loadSearch();
    await s.reconcileAll();

    const paths = await import('../../../../src/main/paths');
    // Index for real_user exists, but none for the reserved dirs
    const ix = await import('../../../../src/main/features/search/indexer');
    const entry = await ix.getEntry(paths.userChatsIndexPath('real_user'), 'chat');
    expect(Object.keys(entry.idx.files)).toContain('c1');
  });
});

describe('search › startup reconcile', () => {
  it('reuses an existing active-user snapshot and defers validation until the first query', async () => {
    writeChat(TEST_UID, 'active-chat', [
      { role: 'user', content: 'startup fallback token', time: 't' },
    ]);
    writeChat('inactive-user', 'inactive-chat', [
      { role: 'user', content: 'should not be scanned at startup', time: 't' },
    ]);
    const paths = await import('../../../../src/main/paths');
    const activeIndex = paths.userChatsIndexPath(TEST_UID);
    const inactiveIndex = paths.userChatsIndexPath('inactive-user');
    fs.mkdirSync(path.dirname(activeIndex), { recursive: true });
    // Deliberately invalid but non-empty: startup must not parse a large
    // persisted snapshot. Query-time reconcile remains the repair boundary.
    fs.writeFileSync(activeIndex, 'persisted-snapshot');

    const s = await loadSearch();
    await s.reconcileActive();

    expect(fs.readFileSync(activeIndex, 'utf-8')).toBe('persisted-snapshot');
    expect(fs.existsSync(inactiveIndex)).toBe(false);
    const results = await s.searchChats(TEST_UID, 'fallback token');
    expect(results.some((result) => result.cid === 'active-chat')).toBe(true);
  });

  it('bounds chat source stats instead of awaiting every JSONL serially', async () => {
    for (let i = 0; i < 96; i++) {
      writeChat(TEST_UID, `chat-${i}`, [{ role: 'user', content: `message ${i}`, time: 't' }]);
    }
    const indexer = await import('../../../../src/main/features/search/indexer');
    let active = 0;
    let maxActive = 0;
    const files = await indexer.__searchIndexerTestHooks.listUserChats(TEST_UID, async () => {
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise<void>((resolve) => setImmediate(resolve));
      active--;
      return { mtimeMs: 1, size: 1 };
    });

    expect(files).toHaveLength(96);
    expect(maxActive).toBeGreaterThan(1);
    expect(maxActive).toBeLessThanOrEqual(indexer.__searchIndexerTestHooks.chatStatConcurrency);
  });
});

describe('search › re-exports from indexer', () => {
  it('re-exports the mutator hooks so callers can use one module', async () => {
    const s = await loadSearch();
    expect(typeof s.upsertContext).toBe('function');
    expect(typeof s.dropContext).toBe('function');
    expect(typeof s.indexChatMessage).toBe('function');
    expect(typeof s.dropChatConversation).toBe('function');
    expect(typeof s.flushAll).toBe('function');
    // skill / agent chat-message indexers were removed alongside the
    // skill_chats / agent_chats search scopes (see `_unlinkLegacyIndexes`).
    // Don't add assertions for them back — those scopes are intentionally
    // out of search.
  });
});
