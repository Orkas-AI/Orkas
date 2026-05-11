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
