import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { readPage, resolveAttachment } = vi.hoisted(() => ({
  readPage: vi.fn(), resolveAttachment: vi.fn(),
}));
vi.mock('../../../../src/main/storage', () => ({ readJsonlPage: readPage }));
vi.mock('../../../../src/main/util/project-layout', () => ({
  conversationMessageReadFile: (uid: string, cid: string) => `${uid}/${cid}`,
}));
vi.mock('../../../../src/main/features/chat_attachments', () => ({ resolveAttachmentAbsPath: resolveAttachment }));

import {
  historicalSkillImportAuthorization, importSourceUnchangedSince, literalImportPaths,
} from '../../../../src/main/features/group_chat/skill_import_sources';

describe('literal user source syntax', () => {
  it.each([
    ['Import `/tmp/My Skill (v2)`.', ['/tmp/My Skill (v2)']],
    ['Use "/tmp/包.zip" or </tmp/another.zip>', ['/tmp/包.zip', '/tmp/another.zip']],
    ['路径：`C:\\Users\\me\\My Skill.zip`', ['C:\\Users\\me\\My Skill.zip']],
    ['Use /tmp/skill.zip, please.', ['/tmp/skill.zip']],
    ['Use C:\\Skills\\one.zip', ['C:\\Skills\\one.zip']],
    ['Use `/tmp/one.zip` and /tmp/one.zip.', ['/tmp/one.zip']],
    ['https://example.org/tmp/skill.zip file:///tmp/skill.zip sandbox:/tmp/skill.zip', []],
    ['../skill.zip ./skill.zip ~/skill.zip //server/share.zip', []],
    ['"not /tmp/a.zip" `echo /tmp/a.zip`', []],
    ['`/tmp/a\u0000.zip`', []],
  ])('reads only explicit absolute paths: %s', (text, expected) => {
    expect(literalImportPaths(text)).toEqual(expected);
  });
});

describe('historical import source authorization', () => {
  const receivedAfter = async (...entries: string[]) => {
    const latest = Math.max(...entries.map((entry) => {
      const st = fs.statSync(entry);
      return Math.ceil(Math.max(st.mtimeMs, st.ctimeMs, st.birthtimeMs));
    }));
    // Windows filesystem timestamps can lead Date.now() slightly. Establish
    // that the user reference occurs after setup without weakening freshness.
    await vi.waitFor(() => expect(Date.now()).toBeGreaterThanOrEqual(latest), { interval: 5 });
    return Date.now();
  };
  let root: string;
  let source: string;
  let receivedAt: number;
  const current = { id: 'current', from: 'user', ts: '2026-01-01T00:00:00', text: 'Import it now.' };
  beforeEach(async () => {
    vi.clearAllMocks();
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-source-auth-'));
    source = path.join(root, 'skill');
    fs.mkdirSync(source);
    fs.writeFileSync(path.join(source, 'SKILL.md'), '# Fixture');
    receivedAt = await receivedAfter(source, path.join(source, 'SKILL.md'));
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));
  const authorize = () => historicalSkillImportAuthorization('account', 'task', 'current', source);
  const history = (records: any[]) => readPage.mockResolvedValue({ records, nextCursor: null });
  const userSource = (text: string, time: number) => ({
    id: 'earlier', from: 'user', ts: new Date(time).toISOString(), received_at_ms: time, text,
  });

  it('accepts repeated references to one unchanged source across history pages', async () => {
    const message = userSource(`Keep \`${source}\``, receivedAt);
    readPage.mockResolvedValueOnce({ records: [{ ...message, id: 'repeat' }, current], nextCursor: 44 })
      .mockResolvedValueOnce({ records: [message], nextCursor: null });
    expect(await authorize()).toBe('authorized');
    expect(readPage.mock.calls.map((call) => call.slice(0, 3))).toEqual([
      ['account/task', 128, undefined], ['account/task', 128, 44],
    ]);
  });

  it.each(['assistant', 'deleted', 'future', 'quoted-reference', 'missing-current'])
    ('does not grant permission from %s records', async (kind) => {
      const earlier: any = userSource(`Keep \`${source}\``, receivedAt);
      if (kind === 'assistant') earlier.from = 'commander';
      if (kind === 'deleted') earlier.deleted_at = new Date().toISOString();
      if (kind === 'quoted-reference') {
        earlier.references = [{ text: earlier.text, source_cid: 'another-task' }];
        earlier.text = 'Here is a quote.';
      }
      history(kind === 'future' ? [current, earlier] : kind === 'missing-current' ? [earlier] : [earlier, current]);
      expect(await authorize()).toBe('missing');
    });

  it('keeps legacy timestamp readers compatible without rounding up old times', async () => {
    const earlier: any = userSource(`\`${source}\``, receivedAt);
    delete earlier.received_at_ms;
    history([earlier, current]);
    expect(await authorize()).toBe('authorized');
    earlier.ts = new Date(receivedAt - 2000).toISOString();
    expect(await authorize()).toBe('changed');
  });

  it('does not widen a historical source to its parent, child or sibling directory', async () => {
    const child = path.join(source, 'nested');
    const sibling = path.join(root, 'skill-copy');
    fs.mkdirSync(child);
    fs.mkdirSync(sibling);
    history([userSource(`Keep \`${source}\``, await receivedAfter(source, child)), current]);
    expect(await authorize()).toBe('authorized');
    for (const requested of [root, child, sibling]) {
      expect(await historicalSkillImportAuthorization('account', 'task', 'current', requested)).toBe('missing');
    }
  });

  it('does not let a later user source make the current import ambiguous', async () => {
    const secondSource = path.join(root, 'later-skill');
    fs.mkdirSync(secondSource);
    history([
      userSource(`\`${source}\``, receivedAt), current,
      { ...userSource(`\`${secondSource}\``, Date.now()), id: 'later-user' },
    ]);
    expect(await authorize()).toBe('authorized');
  });

  it('allows reading a source but rejects later edits even if its modification time is restored', async () => {
    const file = path.join(source, 'SKILL.md');
    const before = fs.statSync(file);
    fs.readFileSync(file);
    expect(importSourceUnchangedSince(source, receivedAt)).toBe(true);
    // Wait for a distinct filesystem timestamp, not an arbitrary minimum
    // execution duration. Restoring mtime must not hide a real content edit.
    await vi.waitFor(() => expect(Date.now()).toBeGreaterThan(receivedAt + 2), { interval: 5 });
    fs.appendFileSync(file, '\nChanged instructions.');
    fs.utimesSync(file, before.atime, before.mtime);
    expect(importSourceUnchangedSince(source, receivedAt)).toBe(false);
  });

  it('uses host milliseconds even when the display timestamp is seconds-only', async () => {
    const earlier = userSource(`\`${source}\``, receivedAt);
    earlier.ts = new Date(receivedAt - 2000).toISOString();
    history([earlier, current]);
    expect(await authorize()).toBe('authorized');
  });

  it('resolves ZIP attachments only in the active account and conversation', async () => {
    const zip = path.join(root, 'source.zip');
    fs.writeFileSync(zip, 'Fixture bytes; package validation belongs to the importer.');
    resolveAttachment.mockReturnValue({ ok: true, absPath: zip });
    history([{ ...userSource('', await receivedAfter(zip)), attachments: ['source.zip', 'notes.txt'] }, current]);
    expect(await historicalSkillImportAuthorization('account', 'task', 'current', zip)).toBe('authorized');
    expect(resolveAttachment.mock.calls).toEqual([['account', 'task', 'source.zip']]);
  });

  it('requires selection when an earlier attachment can no longer be resolved', async () => {
    resolveAttachment.mockReturnValue({ ok: false });
    history([{ ...userSource(`\`${source}\``, receivedAt), attachments: ['missing.zip'] }, current]);
    expect(await authorize()).toBe('missing');
  });

  it('rejects incomplete history instead of assuming its remaining source is unique', async () => {
    history([...Array.from({ length: 1024 }, (_, n) => ({ id: String(n), from: 'user', text: '' })), current]);
    expect(await authorize()).toBe('missing');
    history([userSource(`\`${source}\` ${'x'.repeat(2 * 1024 * 1024)}`, receivedAt), current]);
    expect(await authorize()).toBe('missing');
  });

  it('detects nested changes even when the selected directory itself is untouched', () => {
    const child = path.join(source, 'SKILL.md');
    const future = new Date(receivedAt + 1000);
    fs.utimesSync(child, future, future);
    expect(importSourceUnchangedSince(source, receivedAt)).toBe(false);
    expect(importSourceUnchangedSince(source, Number.NaN)).toBe(false);
    expect(importSourceUnchangedSince(path.join(root, 'missing'), receivedAt)).toBe(false);
  });

  it('requires fresh selection for linked or oversized package trees', () => {
    const linked = path.join(source, 'linked');
    fs.symlinkSync(path.join(source, 'SKILL.md'), linked);
    expect(importSourceUnchangedSince(source, Date.now())).toBe(false);
    fs.unlinkSync(linked);
    for (let i = 0; i < 1024; i++) fs.writeFileSync(path.join(source, `${i}.txt`), '');
    expect(importSourceUnchangedSince(source, Date.now())).toBe(false);
  });
});
