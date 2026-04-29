import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { makeMinimalPdf } from '../../fixtures/make-minimal-pdf';
import { makeMinimalDocx } from '../../fixtures/make-minimal-docx';

const UID = 'u-fi-001';

let tmpDir: string;
let prevWs: string | undefined;

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-file-indexer-'));
  prevWs = process.env.ORKAS_WORKSPACE_ROOT;
  process.env.ORKAS_WORKSPACE_ROOT = tmpDir;
  vi.resetModules();
  const users = await import('../../../src/main/features/users');
  users.activateUser(UID);
});

afterEach(() => {
  process.env.ORKAS_WORKSPACE_ROOT = prevWs;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

async function loadMod() {
  return import('../../../src/main/features/file_indexer');
}

function userFileCacheRoot(): string {
  return path.join(tmpDir, UID, 'local', 'file_cache');
}

function writeWorkspaceFile(name: string, body: Buffer | string): string {
  const abs = path.join(tmpDir, name);
  fs.writeFileSync(abs, typeof body === 'string' ? Buffer.from(body, 'utf8') : body);
  return abs;
}

function attachmentFile(cid: string, name: string, body: Buffer | string): string {
  const dir = path.join(tmpDir, UID, 'cloud', 'chat_attachments', cid);
  fs.mkdirSync(dir, { recursive: true });
  const abs = path.join(dir, name);
  fs.writeFileSync(abs, typeof body === 'string' ? Buffer.from(body, 'utf8') : body);
  return abs;
}

async function makePng(): Promise<Buffer> {
  const { Jimp } = await import('jimp' as any);
  const img: any = new Jimp({ width: 120, height: 120, color: 0xAACCEEFF });
  return await img.getBuffer('image/png');
}

describe('file_indexer › statFile', () => {
  it('returns totalChars for text', async () => {
    const m = await loadMod();
    const body = 'line one\nline two\nline three';
    const abs = writeWorkspaceFile('notes.md', body);
    const meta = await m.statFile(UID, abs);
    expect(meta.kind).toBe('text');
    expect(meta.totalChars).toBe(body.length);
    expect(meta.source).toBe('workspace');
  });

  it('returns source=attachment + cid for paths under chat_attachments', async () => {
    const m = await loadMod();
    const abs = attachmentFile('conv-abc', 'a.md', 'hello');
    const meta = await m.statFile(UID, abs);
    expect(meta.source).toBe('attachment');
    expect(meta.cid).toBe('conv-abc');
  });

  it('extracts pdf and records totalChars', async () => {
    const m = await loadMod();
    const abs = writeWorkspaceFile('deck.pdf', makeMinimalPdf(['Alpha', 'Bravo']));
    const meta = await m.statFile(UID, abs);
    expect(meta.kind).toBe('pdf');
    expect(meta.totalChars).toBeGreaterThan(0);
  });

  it('throws NoTextError for image kind', async () => {
    const m = await loadMod();
    const png = await makePng();
    const abs = writeWorkspaceFile('chart.png', png);
    await expect(m.statFile(UID, abs)).rejects.toThrowError(m.NoTextError);
  });
});

describe('file_indexer › getCachedMeta (peek)', () => {
  it('returns null when no cache exists', async () => {
    const m = await loadMod();
    const abs = writeWorkspaceFile('fresh.pdf', makeMinimalPdf(['X']));
    expect(m.getCachedMeta(UID, abs)).toBeNull();
  });

  it('returns totalChars after stat/extract', async () => {
    const m = await loadMod();
    const abs = writeWorkspaceFile('cached.pdf', makeMinimalPdf(['One', 'Two']));
    await m.statFile(UID, abs);
    const cached = m.getCachedMeta(UID, abs);
    expect(cached).not.toBeNull();
    expect(cached!.totalChars).toBeGreaterThan(0);
  });

  it('returns null for image (never cached)', async () => {
    const m = await loadMod();
    const png = await makePng();
    const abs = writeWorkspaceFile('chart.png', png);
    expect(m.getCachedMeta(UID, abs)).toBeNull();
  });

  it('returns null when source mtime has drifted', async () => {
    const m = await loadMod();
    const abs = writeWorkspaceFile('shifting.pdf', makeMinimalPdf(['A']));
    await m.statFile(UID, abs);
    await new Promise((r) => setTimeout(r, 10));
    fs.writeFileSync(abs, makeMinimalPdf(['B']));
    expect(m.getCachedMeta(UID, abs)).toBeNull();
  });
});

describe('file_indexer › readRange on text', () => {
  it('returns whole file when range omitted', async () => {
    const m = await loadMod();
    const body = 'alpha\nbeta\ngamma';
    const abs = writeWorkspaceFile('a.txt', body);
    const r = await m.readRange(UID, abs);
    expect(r.content).toBe(body);
    expect(r.range).toEqual({ charStart: 0, charEnd: body.length });
    expect(r.meta.totalChars).toBe(body.length);
  });

  it('slices by charStart/charEnd', async () => {
    const m = await loadMod();
    const abs = writeWorkspaceFile('b.txt', 'abcdefghij');
    const r = await m.readRange(UID, abs, { charStart: 2, charEnd: 7 });
    expect(r.content).toBe('cdefg');
    expect(r.range).toEqual({ charStart: 2, charEnd: 7 });
  });

  it('clamps charEnd to total_chars without error', async () => {
    const m = await loadMod();
    const abs = writeWorkspaceFile('c.txt', 'xy');
    const r = await m.readRange(UID, abs, { charEnd: 999 });
    expect(r.content).toBe('xy');
    expect(r.range).toEqual({ charStart: 0, charEnd: 2 });
  });

  it('returns empty slice when charStart >= total_chars', async () => {
    const m = await loadMod();
    const abs = writeWorkspaceFile('d.txt', 'short');
    const r = await m.readRange(UID, abs, { charStart: 10 });
    expect(r.content).toBe('');
    expect(r.range).toEqual({ charStart: 5, charEnd: 5 });
  });
});

describe('file_indexer › readRange on pdf/docx', () => {
  it('throws NeedStatError when pdf cache is missing', async () => {
    const m = await loadMod();
    const abs = writeWorkspaceFile('fresh.pdf', makeMinimalPdf(['Alpha']));
    await expect(m.readRange(UID, abs)).rejects.toThrowError(m.NeedStatError);
  });

  it('reads pdf slice after stat_file', async () => {
    const m = await loadMod();
    const abs = writeWorkspaceFile('deck.pdf', makeMinimalPdf(['Alpha', 'Bravo']));
    const meta = await m.statFile(UID, abs);
    const r = await m.readRange(UID, abs);
    expect(r.content).toContain('Alpha');
    expect(r.content).toContain('Bravo');
    expect(r.meta.totalChars).toBe(meta.totalChars);
    expect(r.range.charEnd).toBe(meta.totalChars);
  });

  it('reads docx slice after stat_file', async () => {
    const m = await loadMod();
    const abs = writeWorkspaceFile(
      'notes.docx',
      makeMinimalDocx({ heading: 'Title', paragraphs: ['Paragraph A.', 'Paragraph B.'] }),
    );
    await m.statFile(UID, abs);
    const full = await m.readRange(UID, abs);
    expect(full.meta.totalChars).toBe(full.content.length);
    const head = await m.readRange(UID, abs, { charStart: 0, charEnd: Math.min(20, full.content.length) });
    expect(full.content.startsWith(head.content)).toBe(true);
  });

  it('rebuilds cache when source mtime changes (stat_file then readRange)', async () => {
    const m = await loadMod();
    const abs = writeWorkspaceFile('doc.pdf', makeMinimalPdf(['Old']));
    await m.statFile(UID, abs);
    const r1 = await m.readRange(UID, abs);
    expect(r1.content).toContain('Old');

    await new Promise((r) => setTimeout(r, 10));
    fs.writeFileSync(abs, makeMinimalPdf(['New']));
    // After mtime drift the peek returns null → readRange throws NeedStatError again.
    await expect(m.readRange(UID, abs)).rejects.toThrowError(m.NeedStatError);
    await m.statFile(UID, abs);
    const r2 = await m.readRange(UID, abs);
    expect(r2.content).toContain('New');
    expect(r2.content).not.toContain('Old');
  });

  it('reuses pdf cache on second readRange (no rematerialise)', async () => {
    const m = await loadMod();
    const abs = writeWorkspaceFile('reuse.pdf', makeMinimalPdf(['Alpha']));
    await m.statFile(UID, abs);
    const cacheDirs = fs.readdirSync(userFileCacheRoot());
    const textMd = path.join(userFileCacheRoot(), cacheDirs[0], 'text.md');
    const firstMtime = fs.statSync(textMd).mtimeMs;
    await new Promise((r) => setTimeout(r, 10));
    await m.readRange(UID, abs);
    expect(fs.statSync(textMd).mtimeMs).toBe(firstMtime);
  });
});

describe('file_indexer › readImageAsGrayJpeg', () => {
  it('returns grayscale JPEG with no disk cache', async () => {
    const m = await loadMod();
    const png = await makePng();
    const abs = writeWorkspaceFile('chart.png', png);
    const r = await m.readImageAsGrayJpeg(UID, abs);
    expect(r.mediaType).toBe('image/jpeg');
    expect(r.base64.length).toBeGreaterThan(50);
    expect(r.bytes).toBe(png.length);
    const entries = fs.existsSync(userFileCacheRoot())
      ? fs.readdirSync(userFileCacheRoot())
      : [];
    expect(entries).toEqual([]);
  });
});

describe('file_indexer › invalidate + purge + prune', () => {
  it('invalidateFileCache drops the hash dir for one path', async () => {
    const m = await loadMod();
    const abs = writeWorkspaceFile('x.pdf', makeMinimalPdf(['X']));
    await m.statFile(UID, abs);
    expect(fs.readdirSync(userFileCacheRoot()).length).toBe(1);
    m.invalidateFileCache(UID, abs);
    expect(fs.readdirSync(userFileCacheRoot()).length).toBe(0);
  });

  it('purgeFileCacheByCid drops all entries matching a cid', async () => {
    const m = await loadMod();
    const a1 = attachmentFile('c1', 'a.pdf', makeMinimalPdf(['A']));
    const a2 = attachmentFile('c1', 'b.pdf', makeMinimalPdf(['B']));
    const a3 = attachmentFile('c2', 'c.pdf', makeMinimalPdf(['C']));
    await m.statFile(UID, a1);
    await m.statFile(UID, a2);
    await m.statFile(UID, a3);
    expect(fs.readdirSync(userFileCacheRoot()).length).toBe(3);

    const r = await m.purgeFileCacheByCid(UID, 'c1');
    expect(r.deleted).toBe(2);
    expect(fs.readdirSync(userFileCacheRoot()).length).toBe(1);
  });

  it('pruneOrphans drops entries whose source is gone', async () => {
    const m = await loadMod();
    const abs = writeWorkspaceFile('gone.pdf', makeMinimalPdf(['G']));
    await m.statFile(UID, abs);
    expect(fs.readdirSync(userFileCacheRoot()).length).toBe(1);
    fs.unlinkSync(abs);
    const r = await m.pruneOrphans(UID);
    expect(r.deleted).toBe(1);
    expect(fs.readdirSync(userFileCacheRoot()).length).toBe(0);
  });
});
