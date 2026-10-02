import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

// Mock named and default exports together: the store imports namespace APIs,
// while fixture helpers use default imports. Both must see the same fault seam.
vi.mock('node:fs', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs')>();
  const createReadStream = vi.fn(actual.createReadStream);
  return { ...actual, createReadStream, default: { ...actual, createReadStream } };
});
vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  const rename = vi.fn(actual.rename);
  return { ...actual, rename, default: { ...actual, rename } };
});
const logs = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }));
vi.mock('../../../src/main/logger', () => ({ createLogger: () => logs }));
let root: string;
let previous: string | undefined;
let store: typeof import('../../../src/main/features/conversation-turn-index');
let indexPath: (uid: string, cid: string) => string;
beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-turn-index-'));
  previous = process.env.ORKAS_WORKSPACE_ROOT;
  process.env.ORKAS_WORKSPACE_ROOT = root;
  vi.resetModules();
  vi.clearAllMocks();
  vi.mocked(fs.createReadStream).mockImplementation((await vi.importActual<typeof import('node:fs')>('node:fs')).createReadStream);
  vi.mocked(fsp.rename).mockImplementation((await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')).rename);
  store = await import('../../../src/main/features/conversation-turn-index');
  indexPath = (await import('../../../src/main/paths')).userConversationTurnIndexPath;
});
afterEach(() => {
  vi.restoreAllMocks();
  if (previous === undefined) delete process.env.ORKAS_WORKSPACE_ROOT;
  else process.env.ORKAS_WORKSPACE_ROOT = previous;
  fs.rmSync(root, { recursive: true, force: true });
});
const user = (id: string, text = id) => ({ id, from: 'user', text });
const reply = (text: string) => ({ from: 'commander', text });
function write(name: string, records: unknown[], newline = true) {
  const file = path.join(root, name);
  fs.writeFileSync(file, records.map(r => JSON.stringify(r)).join('\n') + (newline ? '\n' : ''));
  return file;
}
const read = (file: string, cid = 'chat', before?: number) => store.readConversationTurnPage('user', cid, file, before);

// Frozen pre-migration algorithm: this is a compatibility differential, not
// an alternative expected value derived from the optimized implementation.
function legacyPreview(raw: string, maximum: number) {
  const text = raw.replace(/!\[([^\]]*)\]\([^\s)]+(?:\s+[^)]*)?\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^\s)]+(?:\s+[^)]*)?\)/g, '$1')
    .replace(/<[^>\n]+>/g, ' ').replace(/(^|\s)(?:#{1,6}|>|[-+*]|\d+[.)])\s+/gm, '$1')
    .replace(/[`*_~]+/g, '').replace(/\s+/g, ' ').trim();
  const chars = Array.from(text);
  return chars.length <= maximum ? chars.join('') : `${chars.slice(0, maximum - 1).join('')}…`;
}
it('preserves exact preview text across Unicode, math, Markdown and truncation boundaries', async () => {
  const texts = ['', 'plain', '中文🌟e\u0301👨‍👩‍👧‍👦', '\\(x^2+y^2=z^2\\)\n$$\\frac{a}{b}$$',
    '## [Useful link](https://example.com) ![image](image.png) <b>bold</b>',
    '> quoted\n1. numbered\n- list\n```js\nconst n = 1;\n```', '[unclosed](\n<unfinished',
    ' \r\n\t ', ...[39, 40, 41, 79, 80, 81].flatMap(n => ['中', '🌟'].map(c => c.repeat(n))),
    'word '.repeat(400_000)];
  const file = write('previews', texts.flatMap((text, i) => [user(`u${i}`, text), reply(text)]));
  const turns: any[] = [];
  let before: number | undefined;
  do {
    const page = await read(file, 'chat', before);
    turns.unshift(...page.turns);
    before = page.nextCursor ?? undefined;
  } while (before !== undefined);
  expect(turns.map(t => t.messageId)).toEqual(texts.map((_, i) => `u${i}`));
  turns.forEach((turn, i) => {
    expect(turn.userPreview).toBe(legacyPreview(texts[i], 40));
    expect(turn.assistantPreview).toBe(legacyPreview(texts[i], 80));
    expect(turn.messageIndex).toBe(i * 2);
  });
});

it('retains source addresses and redacts malformed rows while skipping deleted and dispatch previews', async () => {
  const file = write('legacy', [{ role: 'user', content: [{ text: 'Hello' }, '世界'] },
    reply('kept'), { ...reply('internal'), dispatch: true }, { ...user('deleted'), deleted_at: 'today' },
    null, { role: 'assistant', content: [{ text: '🌟 more' }] }, user('next')]);
  fs.appendFileSync(file, '{private malformed content\n');
  const page = await read(file);
  expect(page.turns).toEqual([
    { turnNo: 1, messageId: '', clientMessageId: '', messageIndex: 0, userPreview: 'Hello 世界', assistantPreview: 'kept · 🌟 more' },
    { turnNo: 2, messageId: 'next', clientMessageId: '', messageIndex: 6, userPreview: 'next', assistantPreview: '' },
  ]);
  expect(logs.warn).toHaveBeenCalledTimes(1);
  expect(logs.warn).toHaveBeenCalledWith('conversation turn index skipped malformed records', {
    file: expect.objectContaining({ path_hash: expect.any(String) }),
    error: expect.objectContaining({ name: 'SyntaxError', message_hash: expect.any(String) }),
  });
  expect(JSON.stringify(logs.warn.mock.calls)).not.toContain('private malformed content');
  expect(JSON.stringify(logs.warn.mock.calls)).not.toContain(file);
});

it('reuses memory and persisted indexes, then scans only the appended tail of the last turn', async () => {
  const file = write('append', [user('u1'), reply('First')]);
  const first = await read(file);
  const boundary = fs.statSync(file).size;
  const stream = vi.mocked(fs.createReadStream).mockClear();
  expect(await read(file)).toEqual(first);
  expect(stream).not.toHaveBeenCalled();
  vi.resetModules();
  store = await import('../../../src/main/features/conversation-turn-index');
  expect(await read(file)).toEqual(first);
  expect(stream).not.toHaveBeenCalled();
  fs.appendFileSync(file, JSON.stringify(reply('continuation')) + '\n' + JSON.stringify(user('u2')) + '\n');
  const extended = await read(file);
  expect(extended.turns.map(t => [t.messageId, t.assistantPreview, t.messageIndex]))
    .toEqual([['u1', 'First · continuation', 0], ['u2', '', 3]]);
  expect(stream).toHaveBeenCalledTimes(1);
  expect(stream).toHaveBeenCalledWith(file, expect.objectContaining({ start: boundary, end: fs.statSync(file).size - 1 }));
  expect(logs.info).toHaveBeenLastCalledWith('conversation turn index extended', expect.objectContaining({ records: 2 }));
});

it.each(['replace', 'truncate', 'unterminated', 'corrupt-index', 'old-version'] as const)
('recovers a %s source/index without reusing old previews', async mode => {
  const file = write('rewrite', [user('old'), reply('old reply')], mode !== 'unterminated');
  await read(file);
  if (mode === 'replace') {
    fs.renameSync(write('new', [user('new')]), file);
  } else if (mode === 'truncate') {
    fs.writeFileSync(file, JSON.stringify(user('new')) + '\n');
  } else if (mode === 'unterminated') {
    fs.appendFileSync(file, '\n' + JSON.stringify(user('new')) + '\n');
  } else {
    const persisted = JSON.parse(fs.readFileSync(indexPath('user', 'chat'), 'utf8'));
    fs.writeFileSync(indexPath('user', 'chat'), mode === 'corrupt-index' ? '{broken' : JSON.stringify({ ...persisted, version: 0 }));
    vi.resetModules(); store = await import('../../../src/main/features/conversation-turn-index');
  }
  const page = await read(file);
  expect(page.turns.map(t => t.messageId)).toEqual(mode === 'unterminated' ? ['old', 'new']
    : mode === 'replace' || mode === 'truncate' ? ['new'] : ['old']);
  expect(JSON.parse(fs.readFileSync(indexPath('user', 'chat'), 'utf8')).version).toBe(2);
});

it('retries a moving source once and never publishes a repeatedly unstable scan', async () => {
  const file = write('moving', [user('first')]);
  const create = (await vi.importActual<typeof import('node:fs')>('node:fs')).createReadStream;
  let changes = 0;
  const stream = vi.mocked(fs.createReadStream).mockImplementation((...args: any[]) => {
    const result = (create as any)(...args);
    result.once('end', () => {
      if (++changes === 1) fs.appendFileSync(file, JSON.stringify(user('second')) + '\n');
    });
    return result;
  });
  expect((await read(file)).turns.map(t => t.messageId)).toEqual(['first', 'second']);
  expect(stream).toHaveBeenCalledTimes(2);
  const saved = fs.readFileSync(indexPath('user', 'chat'), 'utf8');
  fs.writeFileSync(file, JSON.stringify(user('replacement')) + '\n');
  stream.mockImplementation((...args: any[]) => {
    const result = (create as any)(...args);
    result.once('end', () => fs.appendFileSync(file, JSON.stringify(user(`moving-${++changes}`)) + '\n'));
    return result;
  });
  await expect(read(file)).rejects.toThrow('did not stabilize');
  expect(fs.readFileSync(indexPath('user', 'chat'), 'utf8')).toBe(saved);
  stream.mockImplementation(create);
  expect((await read(file)).turns[0].messageId).toBe('replacement');
});

it('does not publish an empty cache if the source disappears during the scan', async () => {
  const file = write('deleted', [user('old')]);
  const create = (await vi.importActual<typeof import('node:fs')>('node:fs')).createReadStream;
  vi.mocked(fs.createReadStream).mockImplementationOnce((...args: any[]) => {
    const result = (create as any)(...args);
    result.once('end', () => fs.unlinkSync(file));
    return result;
  });
  expect((await read(file)).turns).toEqual([]);
  expect(fs.existsSync(indexPath('user', 'chat'))).toBe(false);
});

it('rejects a failed atomic cache publication and recovers without changing history', async () => {
  const file = write('write-failure', [user('saved')]);
  const original = fs.readFileSync(file, 'utf8');
  const rename = vi.mocked(fsp.rename).mockRejectedValueOnce(Object.assign(new Error('Injected I/O failure'), { code: 'EIO' }));
  await expect(read(file)).rejects.toThrow('Injected I/O failure');
  expect(fs.existsSync(indexPath('user', 'chat'))).toBe(false);
  expect(fs.readdirSync(path.dirname(indexPath('user', 'chat')))).toEqual([]);
  rename.mockImplementation((await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')).rename);
  expect((await read(file)).turns[0].messageId).toBe('saved');
  expect(fs.readFileSync(file, 'utf8')).toBe(original);
});

it('bounds the cache to 64 visited indexes and reloads an evicted conversation', async () => {
  for (let i = 0; i < 66; i++) await read(write(`file${i}`, [user(`u${i}`)]), `c${i}`);
  expect(store._conversationTurnIndexMemorySizeForTest()).toBe(64);
  const source = vi.mocked(fs.createReadStream).mockClear();
  expect((await read(path.join(root, 'file0'), 'c0')).turns[0].messageId).toBe('u0');
  expect(source).not.toHaveBeenCalled(); // persisted index, no cold re-scan
  expect(store._conversationTurnIndexMemorySizeForTest()).toBe(64);
});
