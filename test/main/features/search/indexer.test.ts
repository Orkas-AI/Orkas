import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// indexer.ts pulls path constants from paths.ts at module load. Each test sets
// ORKAS_WORKSPACE_ROOT before resetting the module graph so a fresh tmp WS
// is in effect. Module-level `_cache` / `_locks` / `_flushTimers` are also
// reset because vi.resetModules() re-imports indexer fresh.

let tmpDir: string;
let prevWs: string | undefined;
const TEST_UID = 'u1';

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-indexer-'));
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

async function loadIndexer() {
  return import('../../../../src/main/features/search/indexer');
}

function writeContext(rel: string, body: string): void {
  const full = path.join(tmpDir, TEST_UID, 'cloud', 'contexts', rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, body);
}

function writeChat(uid: string, cid: string, messages: unknown[]): void {
  const dir = path.join(tmpDir, uid, 'cloud', 'chats');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${cid}.jsonl`);
  fs.writeFileSync(file, messages.map((m) => JSON.stringify(m)).join('\n') + '\n');
}

describe('search/indexer › reconcileContextsIndex', () => {
  it('returns silently when CONTEXTS_DIR is missing', async () => {
    const ix = await loadIndexer();
    await expect(ix.reconcileContextsIndex()).resolves.toBeUndefined();
  });

  it('indexes files by relPath (directory + filename), not body content', async () => {
    writeContext('notes.md', '# Hello World\n\nSome body text with keyword foobar.');
    writeContext('sub/recipe.md', '# Second\n\nmore content');
    const ix = await loadIndexer();
    await ix.reconcileContextsIndex();

    const paths = await import('../../../../src/main/paths');
    const entry = await ix.getEntry(paths.userContextsIndexPath(TEST_UID), 'context');
    expect(Object.keys(entry.idx.files).sort()).toEqual(['notes.md', 'sub/recipe.md']);
    // title is basename — no body read, no first-heading lookup
    expect(entry.idx.docs['notes.md']?.title).toBe('notes.md');
    expect(entry.idx.docs['sub/recipe.md']?.title).toBe('recipe.md');
    // path tokens are indexed (directory + filename stem)
    expect(entry.idx.postings['notes']).toBeDefined();
    expect(entry.idx.postings['sub']).toBeDefined();
    expect(entry.idx.postings['recipe']).toBeDefined();
    // body tokens are NOT indexed
    expect(entry.idx.postings['foobar']).toBeUndefined();
    expect(entry.idx.postings['hello']).toBeUndefined();
  });

  it('includes non-markdown files (pdf/docx/images) by filename', async () => {
    writeContext('annual-report.pdf', 'BINARY');
    writeContext('slides/q4.docx', 'BINARY');
    writeContext('photo.jpg', 'BINARY');
    const ix = await loadIndexer();
    await ix.reconcileContextsIndex();
    const paths = await import('../../../../src/main/paths');
    const entry = await ix.getEntry(paths.userContextsIndexPath(TEST_UID), 'context');
    expect(Object.keys(entry.idx.files).sort()).toEqual(['annual-report.pdf', 'photo.jpg', 'slides/q4.docx']);
    expect(entry.idx.postings['annual']).toBeDefined();
    expect(entry.idx.postings['report']).toBeDefined();
    expect(entry.idx.postings['slides']).toBeDefined();
    expect(entry.idx.postings['photo']).toBeDefined();
  });

  it('drops docs whose source file disappeared', async () => {
    writeContext('a.md', '# A\nbody alpha');
    writeContext('b.md', '# B\nbody beta');
    const ix = await loadIndexer();
    await ix.reconcileContextsIndex();
    fs.rmSync(path.join(tmpDir, TEST_UID, 'cloud', 'contexts', 'b.md'));
    await ix.reconcileContextsIndex();
    const paths = await import('../../../../src/main/paths');
    const entry = await ix.getEntry(paths.userContextsIndexPath(TEST_UID), 'context');
    expect(entry.idx.files['b.md']).toBeUndefined();
    expect(entry.idx.docs['b.md']).toBeUndefined();
  });

  it('skips files whose mtime+size matches a prior run', async () => {
    writeContext('a.md', '# A\nunchanged');
    const ix = await loadIndexer();
    await ix.reconcileContextsIndex();
    const paths = await import('../../../../src/main/paths');
    const entry = await ix.getEntry(paths.userContextsIndexPath(TEST_UID), 'context');
    const firstTokens = Object.keys(entry.idx.postings).length;
    // Second reconcile shouldn't duplicate postings
    await ix.reconcileContextsIndex();
    const secondTokens = Object.keys(entry.idx.postings).length;
    expect(secondTokens).toBe(firstTokens);
    // posting list for any token should still only have one entry for this doc
    for (const list of Object.values(entry.idx.postings)) {
      expect(list.filter((e) => e[0] === 'a.md').length).toBeLessThanOrEqual(1);
    }
  });

  it('ignores dotfiles and _INDEX.md', async () => {
    writeContext('_INDEX.md', '# index');
    writeContext('.hidden.md', '# hidden');
    writeContext('visible.md', '# visible');
    const ix = await loadIndexer();
    await ix.reconcileContextsIndex();
    const paths = await import('../../../../src/main/paths');
    const entry = await ix.getEntry(paths.userContextsIndexPath(TEST_UID), 'context');
    expect(Object.keys(entry.idx.files)).toEqual(['visible.md']);
  });
});

describe('search/indexer › reconcileChatsIndex', () => {
  it('returns silently when user has no chats dir', async () => {
    const ix = await loadIndexer();
    await expect(ix.reconcileChatsIndex('u1')).resolves.toBeUndefined();
  });

  it('indexes each jsonl message as a separate doc', async () => {
    writeChat('u1', 'c1', [
      { role: 'user', content: 'tell me about foobar', time: 't1' },
      { role: 'assistant', content: 'foobar is great', time: 't2' },
    ]);
    const ix = await loadIndexer();
    await ix.reconcileChatsIndex('u1');
    const paths = await import('../../../../src/main/paths');
    const entry = await ix.getEntry(paths.userChatsIndexPath('u1'), 'chat');
    expect(Object.keys(entry.idx.docs).sort()).toEqual(['chat:c1:0', 'chat:c1:1']);
    expect(entry.idx.postings['foobar']).toBeDefined();
    expect(entry.idx.postings['foobar'].length).toBe(2);  // two docs contain it
  });

  it('skips messages with empty or non-string content', async () => {
    writeChat('u1', 'c1', [
      { role: 'user', content: '', time: 't1' },
      { role: 'system', content: 42, time: 't2' },
      { role: 'user', content: 'real text here', time: 't3' },
    ]);
    const ix = await loadIndexer();
    await ix.reconcileChatsIndex('u1');
    const paths = await import('../../../../src/main/paths');
    const entry = await ix.getEntry(paths.userChatsIndexPath('u1'), 'chat');
    expect(Object.keys(entry.idx.docs)).toEqual(['chat:c1:2']);
  });
});

describe('search/indexer › indexChatMessage (hot path)', () => {
  it('adds a doc for the appended message without re-reading the jsonl', async () => {
    writeChat('u1', 'c1', [{ role: 'user', content: 'existing', time: 't1' }]);
    const ix = await loadIndexer();
    await ix.reconcileChatsIndex('u1');

    // Append index 1 directly — simulates the chats.appendMessage hook
    ix.indexChatMessage('u1', 'c1', 1, { role: 'assistant', content: 'fresh keyword', time: 't2' });

    // Work is scheduled asynchronously; give the promise chain a tick
    await new Promise((resolve) => setTimeout(resolve, 50));
    const paths = await import('../../../../src/main/paths');
    const entry = await ix.getEntry(paths.userChatsIndexPath('u1'), 'chat');
    expect(entry.idx.docs['chat:c1:1']).toBeDefined();
    expect(entry.idx.postings['fresh']).toBeDefined();
  });

  it('is a no-op for empty content', async () => {
    const ix = await loadIndexer();
    ix.indexChatMessage('u1', 'c1', 0, { role: 'user', content: '', time: 't' });
    await new Promise((resolve) => setTimeout(resolve, 20));
    const paths = await import('../../../../src/main/paths');
    const entry = await ix.getEntry(paths.userChatsIndexPath('u1'), 'chat');
    expect(entry.idx.docs).toEqual({});
  });
});

describe('search/indexer › dropChatConversation', () => {
  it('removes every doc under the conversation id', async () => {
    writeChat('u1', 'c1', [
      { role: 'user', content: 'alpha', time: 't1' },
      { role: 'assistant', content: 'beta', time: 't2' },
    ]);
    const ix = await loadIndexer();
    await ix.reconcileChatsIndex('u1');
    ix.dropChatConversation('u1', 'c1');
    await new Promise((resolve) => setTimeout(resolve, 50));
    const paths = await import('../../../../src/main/paths');
    const entry = await ix.getEntry(paths.userChatsIndexPath('u1'), 'chat');
    expect(entry.idx.files['c1']).toBeUndefined();
    expect(entry.idx.docs['chat:c1:0']).toBeUndefined();
  });
});

describe('search/indexer › upsertContext / dropContext', () => {
  it('upsert indexes path tokens, not body tokens', async () => {
    writeContext('notes/squirrel.md', '# A\nkeyword unrelatedbodyword');
    const ix = await loadIndexer();
    ix.upsertContext(TEST_UID, 'notes/squirrel.md');
    await new Promise((resolve) => setTimeout(resolve, 50));
    const paths = await import('../../../../src/main/paths');
    const entry = await ix.getEntry(paths.userContextsIndexPath(TEST_UID), 'context');
    expect(entry.idx.files['notes/squirrel.md']).toBeDefined();
    expect(entry.idx.postings['squirrel']).toBeDefined();
    expect(entry.idx.postings['notes']).toBeDefined();
    expect(entry.idx.postings['unrelatedbodyword']).toBeUndefined();
  });

  it('drop removes the doc', async () => {
    writeContext('a.md', '# A\nsome body');
    const ix = await loadIndexer();
    await ix.reconcileContextsIndex();
    ix.dropContext(TEST_UID, 'a.md');
    await new Promise((resolve) => setTimeout(resolve, 50));
    const paths = await import('../../../../src/main/paths');
    const entry = await ix.getEntry(paths.userContextsIndexPath(TEST_UID), 'context');
    expect(entry.idx.files['a.md']).toBeUndefined();
  });
});

// 锁住 `9529d52c` 改的 spec:技能编辑 / 智能体编辑会话**不**进 search 索引。
// 之前老版本有 reconcileSkillChatsIndex / reconcileAgentChatsIndex 会按 skill_id
// 建索引,现在被剔除——search 只索引 contexts + 主对话 + agent/skill 本体规格。
// 下次如有人把这两条索引函数复活,或者新人改 reconcileAll 时不小心把 skill_chats
// 加回扫描列表,这里负责拦截。
describe('search/indexer › skill / agent edit chats are out of search scope', () => {
  it('does not expose `reconcileSkillChatsIndex` / `reconcileAgentChatsIndex`', async () => {
    const ix = await loadIndexer();
    expect((ix as Record<string, unknown>).reconcileSkillChatsIndex).toBeUndefined();
    expect((ix as Record<string, unknown>).reconcileAgentChatsIndex).toBeUndefined();
    expect((ix as Record<string, unknown>).indexSkillChatMessage).toBeUndefined();
    expect((ix as Record<string, unknown>).indexAgentChatMessage).toBeUndefined();
  });
});

describe('search/indexer › flushAll', () => {
  it('persists dirty indexes to disk', async () => {
    writeContext('a.md', '# A\nbody');
    const ix = await loadIndexer();
    await ix.reconcileContextsIndex();
    await ix.flushAll();
    const paths = await import('../../../../src/main/paths');
    const idxPath = paths.userContextsIndexPath(TEST_UID);
    expect(fs.existsSync(idxPath)).toBe(true);
    const raw = JSON.parse(fs.readFileSync(idxPath, 'utf8'));
    expect(raw.kind).toBe('context');
    expect(raw.files['a.md']).toBeDefined();
  });
});
