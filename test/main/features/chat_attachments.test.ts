import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { makeMinimalPdf } from '../../fixtures/make-minimal-pdf';
import { makeMinimalDocx } from '../../fixtures/make-minimal-docx';
import { makeMinimalXlsx, makeMinimalPptx } from '../../fixtures/make-minimal-office';

const UID = 'u-attach-001';
const CID = 'conv-123';

let tmpDir: string;
let prevWs: string | undefined;

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-chatattach-'));
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

function attDir(): string {
  return path.join(tmpDir, UID, 'cloud', 'chat_attachments', CID);
}

function cloudAttDir(cid: string): string {
  return path.join(tmpDir, UID, 'cloud', 'chat_attachments', cid);
}

function draftAttDir(cid: string): string {
  return path.join(tmpDir, UID, 'local', 'chat_attachment_drafts', cid);
}

async function loadMod() {
  return import('../../../src/main/features/chat_attachments');
}

async function makePng(color = 0xAACCEEFF): Promise<Buffer> {
  const { Jimp } = await import('jimp' as any);
  const img: any = new Jimp({ width: 200, height: 200, color });
  return await img.getBuffer('image/png');
}

describe('chat_attachments › uploadAttachment', () => {
  it('accepts and stores a text file without any sibling cache', async () => {
    const m = await loadMod();
    const r = await m.uploadAttachment(UID, CID, 'hello.txt', Buffer.from('hi there', 'utf8'));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.info.name).toBe('hello.txt');
    expect(r.info.kind).toBe('text');
    expect(fs.existsSync(path.join(attDir(), 'hello.txt'))).toBe(true);
    const siblings = fs.readdirSync(attDir()).filter((n) => n.startsWith('.'));
    expect(siblings).toEqual([]);
  });

  it('stores commander draft attachments in local-only storage', async () => {
    const m = await loadMod();
    const r = await m.uploadAttachment(UID, 'main_chat', 'draft.txt', Buffer.from('hi', 'utf8'));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(fs.existsSync(path.join(draftAttDir('main_chat'), 'draft.txt'))).toBe(true);
    expect(fs.existsSync(path.join(cloudAttDir('main_chat'), 'draft.txt'))).toBe(false);
    expect(m.listPendingAttachments(UID, 'main_chat').map((i) => i.name)).toEqual(['draft.txt']);
  });

  it('stores PDF without pre-extracting (no sibling cache files)', async () => {
    const m = await loadMod();
    const r = await m.uploadAttachment(UID, CID, 'report.pdf', makeMinimalPdf(['Page One', 'Page Two']));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.info.kind).toBe('pdf');
    const siblings = fs.readdirSync(attDir()).filter((n) => n.startsWith('.'));
    expect(siblings).toEqual([]);
  });

  it('stores docx without pre-extracting', async () => {
    const m = await loadMod();
    const r = await m.uploadAttachment(UID, CID, 'notes.docx', makeMinimalDocx({ heading: 'Title', paragraphs: ['Body.'] }));
    expect(r.ok).toBe(true);
    const siblings = fs.readdirSync(attDir()).filter((n) => n.startsWith('.'));
    expect(siblings).toEqual([]);
  });

  it('stores modern Office files without pre-extracting', async () => {
    const m = await loadMod();
    const docm = await m.uploadAttachment(UID, CID, 'macro.docm', makeMinimalDocx({ heading: 'Macro', paragraphs: ['Docm body.'] }));
    const sheet = await m.uploadAttachment(UID, CID, 'scores.xlsx', makeMinimalXlsx());
    const deck = await m.uploadAttachment(UID, CID, 'slides.pptx', makeMinimalPptx());
    const macroSheet = await m.uploadAttachment(UID, CID, 'scores.xlsm', makeMinimalXlsx({ rows: [['Kind'], ['Macro sheet']] }));
    const macroDeck = await m.uploadAttachment(UID, CID, 'slides.pptm', makeMinimalPptx({ slides: [['Macro deck']] }));

    expect(docm.ok && sheet.ok && deck.ok && macroSheet.ok && macroDeck.ok).toBe(true);
    if (!(docm.ok && sheet.ok && deck.ok && macroSheet.ok && macroDeck.ok)) return;
    expect(docm.info.kind).toBe('docx');
    expect(sheet.info.kind).toBe('spreadsheet');
    expect(deck.info.kind).toBe('presentation');
    expect(macroSheet.info.kind).toBe('spreadsheet');
    expect(macroDeck.info.kind).toBe('presentation');
    const siblings = fs.readdirSync(attDir()).filter((n) => n.startsWith('.'));
    expect(siblings).toEqual([]);
  });

  it('rejects legacy Office binary formats before they enter the attachment pool', async () => {
    const m = await loadMod();
    const doc = await m.uploadAttachment(UID, CID, 'old.doc', Buffer.from('legacy'));
    const xls = await m.uploadAttachment(UID, CID, 'old.xls', Buffer.from('legacy'));
    const ppt = await m.uploadAttachment(UID, CID, 'old.ppt', Buffer.from('legacy'));

    expect(doc.ok).toBe(false);
    expect(xls.ok).toBe(false);
    expect(ppt.ok).toBe(false);
    expect(fs.existsSync(path.join(attDir(), 'old.doc'))).toBe(false);
    expect(fs.existsSync(path.join(attDir(), 'old.xls'))).toBe(false);
    expect(fs.existsSync(path.join(attDir(), 'old.ppt'))).toBe(false);
  });

  it('stores image without any sibling cache (preview generated on read)', async () => {
    const m = await loadMod();
    const png = await makePng();
    const r = await m.uploadAttachment(UID, CID, 'chart.png', png);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.info.kind).toBe('image');
    const siblings = fs.readdirSync(attDir()).filter((n) => n.startsWith('.'));
    expect(siblings).toEqual([]);
  });

  it('accepts a video file without preprocessing and no sibling caches', async () => {
    const m = await loadMod();
    // Bytes don't need to be a real mp4 — uploadAttachment doesn't decode
    // videos at all (no transcoding, no poster frame). Any buffer under the
    // size cap should land on disk as-is.
    const fakeMp4 = Buffer.from('not-really-an-mp4-but-thats-fine');
    const r = await m.uploadAttachment(UID, CID, 'clip.mp4', fakeMp4);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.info.kind).toBe('video');
    expect(r.info.bytes).toBe(fakeMp4.length);
    // Video path must NOT generate extract/preview siblings — those are
    // for text/pdf/docx/image. The only dotfile allowed is .cache_version.
    const siblings = fs.readdirSync(attDir()).filter((n) => n.startsWith('.'));
    expect(siblings.filter((n) => n.startsWith('.clip.mp4.'))).toEqual([]);
  });

  it('recognises every whitelisted video extension', async () => {
    const m = await loadMod();
    const exts = ['.mp4', '.webm', '.mov', '.m4v', '.ogv'];
    for (const ext of exts) {
      const name = `v${ext.replace('.', '_')}${ext}`;
      const r = await m.uploadAttachment(UID, CID, name, Buffer.from('x'));
      expect(r.ok, `expected ${ext} to be accepted`).toBe(true);
      if (r.ok) expect(r.info.kind).toBe('video');
    }
  });

  it('rejects videos exceeding the 200MB cap', async () => {
    const m = await loadMod();
    // Allocate just over the cap — Buffer.alloc is cheap (sparse zero bytes).
    const oversized = Buffer.alloc(200 * 1024 * 1024 + 1);
    const r = await m.uploadAttachment(UID, CID, 'huge.mp4', oversized);
    expect(r.ok).toBe(false);
    // Source file must not land on disk after a rejected upload.
    expect(fs.existsSync(path.join(attDir(), 'huge.mp4'))).toBe(false);
  });

  it('rejects non-UTF-8 content for text types', async () => {
    const m = await loadMod();
    const r = await m.uploadAttachment(UID, CID, 'bad.txt', Buffer.from([0xFF, 0xFE]));
    expect(r.ok).toBe(false);
  });

  it('rejects unknown extensions', async () => {
    const m = await loadMod();
    const r = await m.uploadAttachment(UID, CID, 'malware.exe', Buffer.from('x'));
    expect(r.ok).toBe(false);
  });

  it('keeps local-display SVG out of conversation attachment uploads', async () => {
    const m = await loadMod();
    const r = await m.uploadAttachment(
      UID,
      CID,
      'contact-sheet.svg',
      Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>'),
    );
    expect(r.ok).toBe(false);
    expect(m.ALLOWED_EXTENSIONS.has('.svg')).toBe(false);
    expect(fs.existsSync(path.join(attDir(), 'contact-sheet.svg'))).toBe(false);
  });

  it('renames on name collision rather than overwrite', async () => {
    const m = await loadMod();
    const r1 = await m.uploadAttachment(UID, CID, 'dup.txt', Buffer.from('v1'));
    const r2 = await m.uploadAttachment(UID, CID, 'dup.txt', Buffer.from('v2'));
    expect(r1.ok && r2.ok).toBe(true);
    if (!(r1.ok && r2.ok)) return;
    expect(r1.info.name).toBe('dup.txt');
    expect(r2.info.name).not.toBe('dup.txt');
    expect(r2.info.name.endsWith('.txt')).toBe(true);
  });

  it('reuses an existing attachment when upload content hash matches', async () => {
    const m = await loadMod();
    const r1 = await m.uploadAttachment(UID, CID, 'first.txt', Buffer.from('same bytes'));
    const r2 = await m.uploadAttachment(UID, CID, 'second.txt', Buffer.from('same bytes'));

    expect(r1.ok && r2.ok).toBe(true);
    if (!(r1.ok && r2.ok)) return;
    expect(r2.info.name).toBe(r1.info.name);
    expect(r2.reused).toBe(true);
    expect(fs.readdirSync(attDir()).filter((n) => !n.startsWith('.'))).toEqual(['first.txt']);
  });

  it('reuses a single attachment when matching uploads arrive concurrently', async () => {
    const m = await loadMod();
    const results = await Promise.all([
      m.uploadAttachment(UID, CID, 'parallel-a.txt', Buffer.from('same parallel bytes')),
      m.uploadAttachment(UID, CID, 'parallel-b.txt', Buffer.from('same parallel bytes')),
      m.uploadAttachment(UID, CID, 'parallel-c.txt', Buffer.from('same parallel bytes')),
    ]);

    expect(results.every((r) => r.ok)).toBe(true);
    if (!results.every((r) => r.ok)) return;
    expect(new Set(results.map((r) => r.info.name)).size).toBe(1);
    expect(results.filter((r) => r.reused).length).toBe(2);
    expect(fs.readdirSync(attDir()).filter((n) => !n.startsWith('.'))).toEqual(['parallel-a.txt']);
  });

  it('imports a workspace file by path into the attachment pool', async () => {
    const m = await loadMod();
    const source = path.join(tmpDir, 'workspace-note.md');
    fs.writeFileSync(source, '# hello\n', 'utf8');

    const r = await m.importAttachmentFromPath(UID, CID, source);

    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.info.name).toBe('workspace-note.md');
    expect(r.info.kind).toBe('text');
    expect(fs.readFileSync(path.join(attDir(), 'workspace-note.md'), 'utf8')).toBe('# hello\n');
  });

  it('reuses an existing attachment when imported file hash matches', async () => {
    const m = await loadMod();
    const r1 = await m.uploadAttachment(UID, CID, 'kept.md', Buffer.from('same body'));
    const source = path.join(tmpDir, 'copy.md');
    fs.writeFileSync(source, 'same body', 'utf8');

    const r2 = await m.importAttachmentFromPath(UID, CID, source);

    expect(r1.ok && r2.ok).toBe(true);
    if (!(r1.ok && r2.ok)) return;
    expect(r2.info.name).toBe('kept.md');
    expect(r2.reused).toBe(true);
    expect(fs.readdirSync(attDir()).filter((n) => !n.startsWith('.'))).toEqual(['kept.md']);
  });

  it('reuses a single attachment when matching imports arrive concurrently', async () => {
    const m = await loadMod();
    const sourceA = path.join(tmpDir, 'source-a.md');
    const sourceB = path.join(tmpDir, 'source-b.md');
    fs.writeFileSync(sourceA, 'same imported body', 'utf8');
    fs.writeFileSync(sourceB, 'same imported body', 'utf8');

    const results = await Promise.all([
      m.importAttachmentFromPath(UID, CID, sourceA),
      m.importAttachmentFromPath(UID, CID, sourceB),
    ]);

    expect(results.every((r) => r.ok)).toBe(true);
    if (!results.every((r) => r.ok)) return;
    expect(new Set(results.map((r) => r.info.name)).size).toBe(1);
    expect(results.filter((r) => r.reused).length).toBe(1);
    expect(fs.readdirSync(attDir()).filter((n) => !n.startsWith('.'))).toEqual(['source-a.md']);
  });

  it('validates text encoding when importing by path', async () => {
    const m = await loadMod();
    const source = path.join(tmpDir, 'bad.txt');
    fs.writeFileSync(source, Buffer.from([0xFF, 0xFE]));

    const r = await m.importAttachmentFromPath(UID, CID, source);

    expect(r.ok).toBe(false);
    expect(fs.existsSync(path.join(attDir(), 'bad.txt'))).toBe(false);
  });
});

describe('chat_attachments › listAttachments', () => {
  it('lists uploaded files', async () => {
    const m = await loadMod();
    await m.uploadAttachment(UID, CID, 'a.txt', Buffer.from('x'));
    await m.uploadAttachment(UID, CID, 'b.pdf', makeMinimalPdf(['P']));
    const items = m.listAttachments(UID, CID);
    expect(items.map((i) => i.name).sort()).toEqual(['a.txt', 'b.pdf']);
    expect(items.find((i) => i.name === 'a.txt')?.kind).toBe('text');
    expect(items.find((i) => i.name === 'b.pdf')?.kind).toBe('pdf');
  });

  it('returns [] for unknown cid', async () => {
    const m = await loadMod();
    expect(m.listAttachments(UID, 'nope')).toEqual([]);
  });
});

describe('chat_attachments › listPendingAttachments', () => {
  it('returns all files when the conversation has no jsonl yet (new conv)', async () => {
    const m = await loadMod();
    await m.uploadAttachment(UID, CID, 'a.txt', Buffer.from('x'));
    await m.uploadAttachment(UID, CID, 'b.pdf', makeMinimalPdf(['P']));
    const items = m.listPendingAttachments(UID, CID);
    expect(items.map((i) => i.name).sort()).toEqual(['a.txt', 'b.pdf']);
  });

  it('filters out files already referenced by any user message in the jsonl', async () => {
    const m = await loadMod();
    await m.uploadAttachment(UID, CID, 'sent.txt', Buffer.from('old'));
    await m.uploadAttachment(UID, CID, 'pending.pdf', makeMinimalPdf(['P']));

    // Simulate the chat jsonl left behind by a prior send: one user message
    // committed `sent.txt` to its attachments array.
    const chatsDir = path.join(tmpDir, UID, 'cloud', 'chats');
    fs.mkdirSync(chatsDir, { recursive: true });
    const rec = { time: '2026-04-24T00:00:00Z', role: 'user', content: 'hi', attachments: ['sent.txt'] };
    fs.writeFileSync(path.join(chatsDir, `${CID}.jsonl`), JSON.stringify(rec) + '\n');

    const items = m.listPendingAttachments(UID, CID);
    expect(items.map((i) => i.name)).toEqual(['pending.pdf']);
  });

  it('survives malformed jsonl lines — falls back to listAttachments-equivalent set minus parseable refs', async () => {
    const m = await loadMod();
    await m.uploadAttachment(UID, CID, 'a.txt', Buffer.from('x'));
    await m.uploadAttachment(UID, CID, 'b.txt', Buffer.from('y'));

    const chatsDir = path.join(tmpDir, UID, 'cloud', 'chats');
    fs.mkdirSync(chatsDir, { recursive: true });
    const mixed = [
      '{not valid json',
      JSON.stringify({ role: 'user', attachments: ['a.txt'] }),
      '',
      'garbage-again',
    ].join('\n');
    fs.writeFileSync(path.join(chatsDir, `${CID}.jsonl`), mixed);

    const items = m.listPendingAttachments(UID, CID);
    expect(items.map((i) => i.name)).toEqual(['b.txt']);
  });
});

describe('chat_attachments › deleteAttachment', () => {
  it('removes the original file', async () => {
    const m = await loadMod();
    await m.uploadAttachment(UID, CID, 'report.pdf', makeMinimalPdf(['P']));
    expect(fs.existsSync(path.join(attDir(), 'report.pdf'))).toBe(true);
    const r = m.deleteAttachment(UID, CID, 'report.pdf');
    expect(r.ok).toBe(true);
    expect(fs.existsSync(path.join(attDir(), 'report.pdf'))).toBe(false);
  });
});

describe('chat_attachments › purgeByCid', () => {
  it('wipes the entire <cid>/ dir', async () => {
    const m = await loadMod();
    await m.uploadAttachment(UID, CID, 'a.txt', Buffer.from('x'));
    await m.uploadAttachment(UID, CID, 'b.pdf', makeMinimalPdf(['P']));
    expect(fs.existsSync(attDir())).toBe(true);
    const n = await m.purgeByCid(UID, CID);
    expect(n).toBeGreaterThan(0);
    expect(fs.existsSync(attDir())).toBe(false);
  });

  it('does not touch other cids', async () => {
    const m = await loadMod();
    await m.uploadAttachment(UID, 'other-cid', 'x.txt', Buffer.from('x'));
    await m.uploadAttachment(UID, CID, 'a.txt', Buffer.from('y'));
    await m.purgeByCid(UID, CID);
    expect(fs.existsSync(path.join(tmpDir, UID, 'cloud', 'chat_attachments', 'other-cid', 'x.txt'))).toBe(true);
  });
});

describe('chat_attachments › adoptDraftAttachments', () => {
  const DRAFT = 'main_chat';

  it('renames draft dir to target cid when target does not exist', async () => {
    const m = await loadMod();
    await m.uploadAttachment(UID, DRAFT, 'note.txt', Buffer.from('hi'));
    await m.uploadAttachment(UID, DRAFT, 'doc.pdf', makeMinimalPdf(['p1']));
    expect(fs.existsSync(draftAttDir(DRAFT))).toBe(true);
    expect(fs.existsSync(cloudAttDir(DRAFT))).toBe(false);

    const r = m.adoptDraftAttachments(UID, DRAFT, CID);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.count).toBe(2);
    expect(fs.existsSync(draftAttDir(DRAFT))).toBe(false);
    expect(fs.existsSync(path.join(cloudAttDir(CID), 'note.txt'))).toBe(true);
    expect(fs.existsSync(path.join(cloudAttDir(CID), 'doc.pdf'))).toBe(true);
  });

  it('returns count=0 without error when draft dir is absent', async () => {
    const m = await loadMod();
    const r = m.adoptDraftAttachments(UID, DRAFT, CID);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.count).toBe(0);
  });

  it('rejects same src == dst', async () => {
    const m = await loadMod();
    await m.uploadAttachment(UID, DRAFT, 'a.txt', Buffer.from('x'));
    const r = m.adoptDraftAttachments(UID, DRAFT, DRAFT);
    expect(r.ok).toBe(false);
  });

  it('merges into existing target dir without overwriting unrelated files', async () => {
    const m = await loadMod();
    await m.uploadAttachment(UID, CID, 'kept.txt', Buffer.from('kept'));
    await m.uploadAttachment(UID, DRAFT, 'new.txt', Buffer.from('fresh'));
    const r = m.adoptDraftAttachments(UID, DRAFT, CID);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(fs.existsSync(path.join(cloudAttDir(CID), 'kept.txt'))).toBe(true);
    expect(fs.existsSync(path.join(cloudAttDir(CID), 'new.txt'))).toBe(true);
    expect(fs.existsSync(draftAttDir(DRAFT))).toBe(false);
  });

  it('migrates legacy cloud draft attachments back to local storage on access', async () => {
    const m = await loadMod();
    fs.mkdirSync(cloudAttDir(DRAFT), { recursive: true });
    fs.writeFileSync(path.join(cloudAttDir(DRAFT), 'legacy.txt'), 'old draft');

    const items = m.listPendingAttachments(UID, DRAFT);
    expect(items.map((i) => i.name)).toEqual(['legacy.txt']);
    expect(fs.existsSync(path.join(draftAttDir(DRAFT), 'legacy.txt'))).toBe(true);
    expect(fs.existsSync(cloudAttDir(DRAFT))).toBe(false);
  });
});

describe('chat_attachments › resolveAttachmentAbsPath', () => {
  it('returns absolute path + kind for a well-formed lookup', async () => {
    const m = await loadMod();
    await m.uploadAttachment(UID, CID, 'chart.png', await makePng());
    const r = m.resolveAttachmentAbsPath(UID, CID, 'chart.png');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.kind).toBe('image');
    // Absolute path must live under the <cid>/ dir. An attacker who
    // passed `../other/file.png` would slip above it; `path.relative`
    // below would start with `..`.
    expect(path.isAbsolute(r.absPath)).toBe(true);
    expect(r.absPath).toBe(path.join(attDir(), 'chart.png'));
  });

  it('blocks path separators in the name (surface layer catches traversal)', async () => {
    const m = await loadMod();
    const r = m.resolveAttachmentAbsPath(UID, CID, '../escape.png');
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe('bad_input');
  });

  it('rejects names that start with a dot (hides cache/preview siblings)', async () => {
    const m = await loadMod();
    const r = m.resolveAttachmentAbsPath(UID, CID, '.chart.png.preview.jpg');
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe('bad_input');
  });

  it('refuses non-whitelisted extensions', async () => {
    const m = await loadMod();
    const r = m.resolveAttachmentAbsPath(UID, CID, 'script.sh');
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe('bad_input');
  });

  it('returns not_found when the file is absent on disk', async () => {
    const m = await loadMod();
    const r = m.resolveAttachmentAbsPath(UID, CID, 'ghost.png');
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe('not_found');
  });

  it('refuses invalid cids', async () => {
    const m = await loadMod();
    const r = m.resolveAttachmentAbsPath(UID, '../other', 'a.png');
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe('bad_input');
  });
});

describe('chat_attachments › mediaMimeFor', () => {
  it('maps image + video + audio extensions to standard MIME types', async () => {
    const m = await loadMod();
    expect(m.mediaMimeFor('a.png')).toBe('image/png');
    expect(m.mediaMimeFor('a.jpg')).toBe('image/jpeg');
    expect(m.mediaMimeFor('a.jpeg')).toBe('image/jpeg');
    expect(m.mediaMimeFor('a.webp')).toBe('image/webp');
    expect(m.mediaMimeFor('a.gif')).toBe('image/gif');
    expect(m.mediaMimeFor('clip.mp4')).toBe('video/mp4');
    expect(m.mediaMimeFor('clip.webm')).toBe('video/webm');
    expect(m.mediaMimeFor('clip.mov')).toBe('video/quicktime');
    expect(m.mediaMimeFor('clip.m4v')).toBe('video/x-m4v');
    expect(m.mediaMimeFor('clip.ogv')).toBe('video/ogg');
    expect(m.mediaMimeFor('voice.mp3')).toBe('audio/mpeg');
    expect(m.mediaMimeFor('voice.wav')).toBe('audio/wav');
    expect(m.mediaMimeFor('voice.ogg')).toBe('audio/ogg');
    expect(m.mediaMimeFor('voice.opus')).toBe('audio/ogg');
    expect(m.mediaMimeFor('voice.m4a')).toBe('audio/mp4');
    expect(m.mediaMimeFor('voice.aac')).toBe('audio/aac');
    expect(m.mediaMimeFor('voice.flac')).toBe('audio/flac');
  });

  it('falls back to octet-stream for unknown extensions', async () => {
    const m = await loadMod();
    // NB: caller is expected to gate on the whitelist before calling — this
    // is the end-of-line safety net, not the first check.
    expect(m.mediaMimeFor('weird.bin')).toBe('application/octet-stream');
  });

  it('keeps SVG MIME support local-display-only', async () => {
    const m = await loadMod();
    expect(m.ALLOWED_EXTENSIONS.has('.svg')).toBe(false);
    expect(m.mediaMimeFor('contact-sheet.svg')).toBe('application/octet-stream');
    expect(m.localMediaMimeFor('contact-sheet.svg')).toBe('image/svg+xml');
  });
});

describe('chat_attachments › resolveLocalMediaPath', () => {
  // Unlike resolveAttachmentAbsPath (per-cid, strict filename validation),
  // this variant serves the `chat-media://local/…` route: any abs path on
  // the user's machine, gated only by extension whitelist + existence +
  // size. The threat model assumes the user trusts their own LLM — there
  // is no directory whitelist.
  async function setup() {
    const mod = await loadMod();
    const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-localmedia-'));
    return { mod, sandbox };
  }

  it('accepts an existing image at an arbitrary abs path', async () => {
    const { mod, sandbox } = await setup();
    const p = path.join(sandbox, 'shot.png');
    fs.writeFileSync(p, await makePng());
    const r = mod.resolveLocalMediaPath(p);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.kind).toBe('image');
    expect(r.absPath).toBe(path.resolve(p));
    fs.rmSync(sandbox, { recursive: true, force: true });
  });

  it('accepts a passive local SVG for display without adding SVG to attachment uploads', async () => {
    const { mod, sandbox } = await setup();
    const p = path.join(sandbox, 'contact-sheet.svg');
    fs.writeFileSync(p, '<svg xmlns="http://www.w3.org/2000/svg"><rect width="10" height="10"/><image href="01-frame.png"/></svg>');
    const r = mod.resolveLocalMediaPath(p);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.kind).toBe('image');
    expect(r.absPath).toBe(path.resolve(p));
    expect(mod.ALLOWED_EXTENSIONS.has('.svg')).toBe(false);
    fs.rmSync(sandbox, { recursive: true, force: true });
  });

  it('inlines relative raster references when serving a legacy local SVG', async () => {
    const { mod, sandbox } = await setup();
    const frame = path.join(sandbox, '01-frame.png');
    fs.writeFileSync(frame, await makePng());
    const p = path.join(sandbox, 'contact-sheet.svg');
    fs.writeFileSync(p, '<svg xmlns="http://www.w3.org/2000/svg"><image href="01-frame.png"/></svg>');
    const r = mod.materializeLocalDisplaySvg(p);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.body).toContain('href="data:image/png;base64,');
    expect(r.body).not.toContain('href="01-frame.png"');
    fs.rmSync(sandbox, { recursive: true, force: true });
  });

  it('does not let legacy SVG image references escape their directory', async () => {
    const { mod, sandbox } = await setup();
    const p = path.join(sandbox, 'contact-sheet.svg');
    fs.writeFileSync(p, '<svg xmlns="http://www.w3.org/2000/svg"><image href="../outside.png"/></svg>');
    const r = mod.materializeLocalDisplaySvg(p);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe('bad_input');
    expect(r.error).toBe('SVG image reference escapes its directory');
    fs.rmSync(sandbox, { recursive: true, force: true });
  });

  it.each([
    '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
    '<svg xmlns="http://www.w3.org/2000/svg"><foreignObject><div>unsafe</div></foreignObject></svg>',
    '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"></svg>',
    '<svg xmlns="http://www.w3.org/2000/svg"><image href="https://example.com/x.png"/></svg>',
  ])('rejects active or remote local SVG content', async (svg) => {
    const { mod, sandbox } = await setup();
    const p = path.join(sandbox, 'unsafe.svg');
    fs.writeFileSync(p, svg);
    const r = mod.resolveLocalMediaPath(p);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe('bad_input');
    expect(r.error).toBe('unsafe SVG content');
    fs.rmSync(sandbox, { recursive: true, force: true });
  });

  it('accepts a video file and reports kind="video"', async () => {
    const { mod, sandbox } = await setup();
    const p = path.join(sandbox, 'clip.mp4');
    fs.writeFileSync(p, Buffer.from('fake-bytes'));
    const r = mod.resolveLocalMediaPath(p);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.kind).toBe('video');
    fs.rmSync(sandbox, { recursive: true, force: true });
  });

  it('accepts an audio file and reports kind="audio"', async () => {
    const { mod, sandbox } = await setup();
    const p = path.join(sandbox, 'voice.mp3');
    fs.writeFileSync(p, Buffer.from('fake-bytes'));
    const r = mod.resolveLocalMediaPath(p);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.kind).toBe('audio');
    fs.rmSync(sandbox, { recursive: true, force: true });
  });

  it('rejects relative paths', async () => {
    const { mod } = await setup();
    const r = mod.resolveLocalMediaPath('./foo.png');
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe('bad_input');
  });

  it('rejects non-media extensions even when file exists', async () => {
    const { mod, sandbox } = await setup();
    const p = path.join(sandbox, 'secret.txt');
    fs.writeFileSync(p, 'hi');
    const r = mod.resolveLocalMediaPath(p);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    // Bad extension is resolved before the FS stat, so the error code is
    // bad_input rather than not_found.
    expect(r.code).toBe('bad_input');
    fs.rmSync(sandbox, { recursive: true, force: true });
  });

  it('returns not_found when the file is absent', async () => {
    const { mod, sandbox } = await setup();
    const r = mod.resolveLocalMediaPath(path.join(sandbox, 'ghost.png'));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe('not_found');
    fs.rmSync(sandbox, { recursive: true, force: true });
  });

  it('returns not_found when the path points at a directory', async () => {
    const { mod, sandbox } = await setup();
    // Name a directory so its extension is `.png` — otherwise extension
    // gating trips first; we specifically want to exercise the stat branch.
    const p = path.join(sandbox, 'dir.png');
    fs.mkdirSync(p);
    const r = mod.resolveLocalMediaPath(p);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe('not_found');
    fs.rmSync(sandbox, { recursive: true, force: true });
  });

  it('rejects files over the per-kind size cap', async () => {
    const { mod, sandbox } = await setup();
    // Image cap is 20MB. Allocate 1 byte over.
    const p = path.join(sandbox, 'huge.png');
    fs.writeFileSync(p, Buffer.alloc(20 * 1024 * 1024 + 1));
    const r = mod.resolveLocalMediaPath(p);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe('too_large');
    fs.rmSync(sandbox, { recursive: true, force: true });
  });

  it('rejects empty string', async () => {
    const { mod } = await setup();
    const r = mod.resolveLocalMediaPath('');
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe('bad_input');
  });
});

describe('chat_attachments › resolveLocalPreviewPath', () => {
  // Preview-doc sibling of resolveLocalMediaPath: accepts pdf / html / htm
  // at arbitrary abs paths so the renderer can render LLM-produced docs
  // inline. No size cap (Chromium streams through serveFileRange).
  async function setup() {
    const mod = await loadMod();
    const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-localpreview-'));
    return { mod, sandbox };
  }

  it('accepts an existing pdf at an arbitrary abs path', async () => {
    const { mod, sandbox } = await setup();
    const p = path.join(sandbox, 'doc.pdf');
    fs.writeFileSync(p, makeMinimalPdf(['hi']));
    const r = mod.resolveLocalPreviewPath(p);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.kind).toBe('pdf');
    expect(r.absPath).toBe(path.resolve(p));
    fs.rmSync(sandbox, { recursive: true, force: true });
  });

  it('accepts .html and reports kind="html"', async () => {
    const { mod, sandbox } = await setup();
    const p = path.join(sandbox, 'page.html');
    fs.writeFileSync(p, '<!doctype html><h1>ok</h1>');
    const r = mod.resolveLocalPreviewPath(p);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.kind).toBe('html');
    fs.rmSync(sandbox, { recursive: true, force: true });
  });

  it('also accepts the .htm spelling', async () => {
    const { mod, sandbox } = await setup();
    const p = path.join(sandbox, 'old.htm');
    fs.writeFileSync(p, '<html></html>');
    const r = mod.resolveLocalPreviewPath(p);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.kind).toBe('html');
    fs.rmSync(sandbox, { recursive: true, force: true });
  });

  it('rejects image / video extensions (those belong to resolveLocalMediaPath)', async () => {
    const { mod, sandbox } = await setup();
    const p = path.join(sandbox, 'photo.png');
    fs.writeFileSync(p, await makePng());
    const r = mod.resolveLocalPreviewPath(p);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe('bad_input');
    fs.rmSync(sandbox, { recursive: true, force: true });
  });

  it('rejects relative paths', async () => {
    const { mod } = await setup();
    const r = mod.resolveLocalPreviewPath('./foo.pdf');
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe('bad_input');
  });

  it('returns not_found when the file is absent', async () => {
    const { mod, sandbox } = await setup();
    const r = mod.resolveLocalPreviewPath(path.join(sandbox, 'ghost.pdf'));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe('not_found');
    fs.rmSync(sandbox, { recursive: true, force: true });
  });

  it('imposes no size cap (very-large pdfs accepted — Chromium streams)', async () => {
    const { mod, sandbox } = await setup();
    const p = path.join(sandbox, 'big.pdf');
    // 60 MB — above any existing image / docx cap. The preview path has
    // no cap by design; if a cap were silently reintroduced this would
    // start failing.
    fs.writeFileSync(p, Buffer.alloc(60 * 1024 * 1024));
    const r = mod.resolveLocalPreviewPath(p);
    expect(r.ok).toBe(true);
    fs.rmSync(sandbox, { recursive: true, force: true });
  });
});

describe('chat_attachments › mediaMimeFor (preview docs)', () => {
  // Existing media MIME coverage already exists earlier in the file; this
  // describe pins the preview-doc additions so a renamed handler doesn't
  // silently downgrade pdf / html to octet-stream.
  it('returns application/pdf for .pdf', async () => {
    const m = await loadMod();
    expect(m.mediaMimeFor('report.pdf')).toBe('application/pdf');
  });
  it('returns text/html for .html and .htm', async () => {
    const m = await loadMod();
    expect(m.mediaMimeFor('page.html')).toBe('text/html');
    expect(m.mediaMimeFor('old.htm')).toBe('text/html');
  });
});

describe('chat_attachments › buildAttachmentManifest', () => {
  it('emits text entry with total_chars (cheap stat, no body leak)', async () => {
    const m = await loadMod();
    const body = 'hello world';
    await m.uploadAttachment(UID, CID, 'notes.txt', Buffer.from(body, 'utf8'));
    const r = await m.buildAttachmentManifest(UID, CID, ['notes.txt']);
    expect(r.manifest).toContain('<attachments>');
    expect(r.manifest).toContain('name="notes.txt"');
    expect(r.manifest).toContain('kind="text"');
    expect(r.manifest).toContain(`total_chars="${body.length}"`);
    // bytes attribute removed — model only sees chars.
    expect(r.manifest).not.toMatch(/bytes="/);
    // No body / chunks / preview leakage.
    expect(r.manifest).toContain('/>');
    expect(r.manifest).not.toContain('chunks=');
    expect(r.manifest).not.toContain('preview=');
    expect(r.manifest).not.toContain(body);
    expect(r.images).toEqual([]);
    expect(r.skipped).toEqual([]);
    expect(r.metadata).toEqual({ hasAttachments: true, attachmentTypes: ['text'] });
  });

  it('emits PDF entry WITHOUT total_chars when never extracted (no eager work)', async () => {
    const m = await loadMod();
    await m.uploadAttachment(UID, CID, 'paper.pdf', makeMinimalPdf(['alpha', 'beta']));
    const r = await m.buildAttachmentManifest(UID, CID, ['paper.pdf']);
    expect(r.manifest).toContain('name="paper.pdf"');
    expect(r.manifest).toContain('kind="pdf"');
    expect(r.manifest).not.toMatch(/paper\.pdf[^>]*total_chars=/);
    expect(r.manifest).not.toMatch(/bytes="/);
    expect(r.manifest).not.toContain('chunks=');
    expect(r.metadata).toEqual({ hasAttachments: true, attachmentTypes: ['pdf'] });
  });

  it('emits modern Office entries WITHOUT total_chars when never extracted', async () => {
    const m = await loadMod();
    await m.uploadAttachment(UID, CID, 'scores.xlsx', makeMinimalXlsx({ rows: [['Name'], ['Ada']] }));
    await m.uploadAttachment(UID, CID, 'slides.pptx', makeMinimalPptx({ slides: [['Roadmap']] }));

    const r = await m.buildAttachmentManifest(UID, CID, ['scores.xlsx', 'slides.pptx']);

    expect(r.manifest).toContain('name="scores.xlsx"');
    expect(r.manifest).toContain('kind="spreadsheet"');
    expect(r.manifest).not.toMatch(/scores\.xlsx[^>]*total_chars=/);
    expect(r.manifest).toContain('name="slides.pptx"');
    expect(r.manifest).toContain('kind="presentation"');
    expect(r.manifest).not.toMatch(/slides\.pptx[^>]*total_chars=/);
    expect(r.skipped).toEqual([]);
    expect(r.metadata).toEqual({ hasAttachments: true, attachmentTypes: ['spreadsheet', 'presentation'] });
  });

  it('emits PDF entry WITH total_chars when cache already exists', async () => {
    const m = await loadMod();
    const indexer = await import('../../../src/main/features/file_indexer');
    const { chatAttachmentDir } = await import('../../../src/main/paths');
    await m.uploadAttachment(UID, CID, 'cached.pdf', makeMinimalPdf(['one', 'two']));
    const abs = path.join(chatAttachmentDir(UID, CID), 'cached.pdf');
    // Pre-stat so the manifest picks up total_chars from cache.
    await indexer.statFile(UID, abs);
    const r = await m.buildAttachmentManifest(UID, CID, ['cached.pdf']);
    expect(r.manifest).toMatch(/cached\.pdf[^>]*total_chars="\d+"/);
  });

  it('emits modern Office entries WITH total_chars when cache already exists', async () => {
    const m = await loadMod();
    const indexer = await import('../../../src/main/features/file_indexer');
    const { chatAttachmentDir } = await import('../../../src/main/paths');
    await m.uploadAttachment(UID, CID, 'cached.xlsx', makeMinimalXlsx({ rows: [['Name'], ['Ada']] }));
    await m.uploadAttachment(UID, CID, 'cached.pptx', makeMinimalPptx({ slides: [['Roadmap']] }));
    await indexer.statFile(UID, path.join(chatAttachmentDir(UID, CID), 'cached.xlsx'));
    await indexer.statFile(UID, path.join(chatAttachmentDir(UID, CID), 'cached.pptx'));

    const r = await m.buildAttachmentManifest(UID, CID, ['cached.xlsx', 'cached.pptx']);

    expect(r.manifest).toMatch(/cached\.xlsx[^>]*total_chars="\d+"/);
    expect(r.manifest).toMatch(/cached\.pptx[^>]*total_chars="\d+"/);
  });

  it('skips legacy Office names if a stale caller tries to build a manifest for them', async () => {
    const m = await loadMod();

    const r = await m.buildAttachmentManifest(UID, CID, ['old.xls']);

    expect(r.manifest).toBe('');
    expect(r.images).toEqual([]);
    expect(r.skipped).toHaveLength(1);
    expect(r.skipped[0].name).toBe('old.xls');
    expect(r.skipped[0].reason).toMatch(/unsupported|不支持|未対応/i);
  });

  it('surfaces a video attachment in the manifest by path with model_readable="false" (usable by media tools, not skipped)', async () => {
    const m = await loadMod();
    await m.uploadAttachment(UID, CID, 'clip.mp4', Buffer.from('fake-bytes'));
    const r = await m.buildAttachmentManifest(UID, CID, ['clip.mp4']);
    // Not vision input, but the path IS surfaced so an agent can probe /
    // transcribe / extract frames instead of giving up on the clip ([474]).
    expect(r.manifest).toMatch(/<file[^>]*name="clip\.mp4"[^>]*kind="video"[^>]*model_readable="false"/);
    expect(r.manifest).toMatch(/path="[^"]+"/);
    expect(r.manifest).toMatch(/media tools/i); // the how-to-read note is present
    // Not inline vision bytes, and NOT dropped to skipped anymore.
    expect(r.images).toEqual([]);
    expect(r.skipped).toEqual([]);
    expect(r.metadata).toEqual({ hasAttachments: true, attachmentTypes: ['video'] });
  });

  it('surfaces an audio attachment in the manifest by path with model_readable="false"', async () => {
    const m = await loadMod();
    await m.uploadAttachment(UID, CID, 'voice.mp3', Buffer.from('fake-bytes'));
    const r = await m.buildAttachmentManifest(UID, CID, ['voice.mp3']);
    expect(r.manifest).toMatch(/<file[^>]*name="voice\.mp3"[^>]*kind="audio"[^>]*model_readable="false"/);
    expect(r.manifest).toMatch(/path="[^"]+"/);
    expect(r.images).toEqual([]);
    expect(r.skipped).toEqual([]);
    expect(r.metadata).toEqual({ hasAttachments: true, attachmentTypes: ['audio'] });
  });

  it('packs images into images[] as real-time compressed JPEG AND lists them in the manifest with attached="inline"', async () => {
    const m = await loadMod();
    await m.uploadAttachment(UID, CID, 'chart.png', await makePng());
    const r = await m.buildAttachmentManifest(UID, CID, ['chart.png']);
    // Manifest entry — gives the LLM a text-side handle on the image
    // (filename + abs path) so it can answer "what did I upload" by name.
    expect(r.manifest).toMatch(/<attachments>/);
    expect(r.manifest).toMatch(/name="chart\.png"/);
    expect(r.manifest).toMatch(/kind="image"/);
    expect(r.manifest).toMatch(/attached="inline"/);
    // Look-alike negative: an image is inline vision input and must NOT be
    // marked model_readable="false" like a video/audio file.
    expect(r.manifest).not.toContain('model_readable');
    // Bytes — fed to vision via ChatOptions.images on the same user turn.
    expect(r.images.length).toBe(1);
    expect(r.images[0].mediaType).toBe('image/jpeg');
    expect(r.images[0].data.length).toBeGreaterThan(100);
    expect(r.metadata).toEqual({ hasAttachments: true, attachmentTypes: ['image'] });
  });

  it('caps images per message: inlined ones appear in manifest, over-cap ones go to skipped[] only', async () => {
    const m = await loadMod();
    for (let i = 0; i < 7; i++) {
      await m.uploadAttachment(UID, CID, `img${i}.png`, await makePng(0x11223300 + i));
    }
    const r = await m.buildAttachmentManifest(
      UID, CID,
      ['img0.png', 'img1.png', 'img2.png', 'img3.png', 'img4.png', 'img5.png', 'img6.png'],
      { maxImages: 3 },
    );
    expect(r.images).toHaveLength(3);
    // Exactly 3 image entries in the manifest — over-cap images are dropped
    // from BOTH images[] and entries[], surfaced only via skipped[].
    expect(r.manifest.match(/<file [^>]*kind="image"/g)?.length).toBe(3);
    expect(r.manifest).toMatch(/name="img0\.png"/);
    expect(r.manifest).not.toMatch(/name="img6\.png"/);
    expect(r.skipped.length).toBe(4);
    expect(r.skipped.every((s) => /image cap|图片上限/.test(s.reason))).toBe(true);
    expect(r.metadata).toEqual({ hasAttachments: true, attachmentTypes: ['image'] });
  });

  it('skips missing files gracefully', async () => {
    const m = await loadMod();
    const r = await m.buildAttachmentManifest(UID, CID, ['ghost.txt']);
    expect(r.manifest).toBe('');
    expect(r.skipped.length).toBe(1);
    expect(r.skipped[0].reason).toMatch(/no longer exists|不存在/);
  });
});

describe('chat_attachments › buildConversationAttachmentIndex', () => {
  it('lists persisted conversation attachments without leaking file bodies', async () => {
    const m = await loadMod();
    const body = '# Orkas 1.0.5\nRelease note: local attachment index stays lightweight.';
    await m.uploadAttachment(UID, CID, 'orkas-1.0.5-update.md', Buffer.from(body, 'utf8'));
    await m.uploadAttachment(UID, CID, 'intro.mp4', Buffer.from('fake-video'));
    await m.uploadAttachment(UID, CID, 'logo.png', Buffer.from('fake-image'));

    const index = await m.buildConversationAttachmentIndex(UID, CID);

    expect(index).toContain('<conversation-attachments');
    expect(index).toContain('name="orkas-1.0.5-update.md"');
    expect(index).toContain('kind="text"');
    expect(index).toContain(`total_chars="${body.length}"`);
    expect(index).toContain('name="intro.mp4"');
    expect(index).toContain('kind="video"');
    expect(index).toContain('model_readable="false"');
    expect(index).toContain('name="logo.png"');
    expect(index).toContain('kind="image"');
    expect(index).toContain('inline="false"');
    expect(index).not.toContain('local attachment index stays lightweight');
  });

  it('excludes current-turn attachment names already covered by the manifest', async () => {
    const m = await loadMod();
    await m.uploadAttachment(UID, CID, 'old.md', Buffer.from('old', 'utf8'));
    await m.uploadAttachment(UID, CID, 'current.md', Buffer.from('current', 'utf8'));

    const index = await m.buildConversationAttachmentIndex(UID, CID, {
      excludeNames: ['current.md'],
    });

    expect(index).toContain('name="old.md"');
    expect(index).not.toContain('name="current.md"');
  });
});
