import * as fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SUPPORTED_LANGS } from '../../../src/main/i18n';
import { interruptedVideoDeliveryNotice } from '../../../src/main/features/video_delivery_notice';
import { markTimelineDelivered } from '../../../src/main/features/video_timeline_render';

const warning = vi.hoisted(() => vi.fn());
vi.mock('../../../src/main/logger', () => ({ createLogger: () => ({ warn: warning, info: vi.fn(), error: vi.fn(), debug: vi.fn() }) }));
let root: string;
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'video-delivery-notice-')); warning.mockClear(); });
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); syncBuiltinESMExports(); fs.rmSync(root, { recursive: true, force: true }); });

async function delivered(id = 'main', versionId = 'v1') {
  const production = path.join(root, 'film'), video = path.join(production, 'videos', id);
  const file = path.join(production, 'versions', `${id}-${versionId}.mp4`);
  const ledgerPath = path.join(production, 'versions.json');
  const manifestPath = path.join(video, 'manifest.json');
  const recordPath = path.join(video, '.last-render.json');
  fs.mkdirSync(video, { recursive: true }); fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, 'published footage must stay intact');
  fs.writeFileSync(manifestPath, JSON.stringify({ schema_version: 3, id, label: 'Before',
    canvas: { width: 160, height: 284, fps: 30 }, scenes: [{ id: 'one', clips: [] }] }));
  const versions = fs.existsSync(ledgerPath) ? JSON.parse(fs.readFileSync(ledgerPath, 'utf8')).versions : [];
  fs.writeFileSync(ledgerPath, JSON.stringify({ versions: [...versions,
    { id: versionId, video_id: id, path: `versions/${id}-${versionId}.mp4` }] }));
  await markTimelineDelivered({ productionDirAbs: production, videoDirAbs: video }, versionId);
  return { production, video, file, ledgerPath, manifestPath, recordPath,
    edit: () => {
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      fs.writeFileSync(manifestPath, JSON.stringify({ ...manifest, label: 'After' }));
    },
  };
}
const notice = (produced: string[]) => interruptedVideoDeliveryNotice({ produced, allowedRoots: [root], lang: 'en' });

describe('interrupted video delivery explanation', () => {
  it('reports the retained attachment and later edits without reading or changing footage', async () => {
    const p = await delivered(); p.edit();
    const before = fs.readFileSync(p.file);
    const open = vi.spyOn(fsPromises, 'open'); syncBuiltinESMExports();
    const text = await notice([p.file]);
    expect(text).toContain('Attachment 1: delivered version v1 is retained.');
    expect(text).toContain('Later edits are not included in this version.');
    expect(text).not.toContain(root);
    expect(open.mock.calls.some(([file]) => file === p.file)).toBe(false);
    expect(fs.readFileSync(p.file)).toEqual(before);
    expect(warning).not.toHaveBeenCalled();
  });

  it('does not call an unchanged or deliberately accepted old result unfinished', async () => {
    const p = await delivered(); p.edit();
    // This is the same acceptance boundary used when ship keeps an older file by user choice.
    await markTimelineDelivered({ productionDirAbs: p.production, videoDirAbs: p.video }, 'v1');
    expect(await notice([p.file])).toBe('Attachment 1: delivered version v1 is retained.');
    p.edit(); // Applying the same content again is still unchanged.
    expect(await notice([p.file])).not.toContain('Later edits');
  });

  it('isolates two videos sharing a production and numbers the existing attachments', async () => {
    const a = await delivered('a', 'v1'), b = await delivered('b', 'v2'); a.edit();
    const text = await notice([a.file, b.file]);
    const [first, second] = text.split('\n\n');
    expect(first).toContain('Attachment 1: delivered version v1');
    expect(first).toContain('Later edits');
    expect(second).toBe('Attachment 2: delivered version v2 is retained.');
  });

  // `unwritten-form`: a delivery hash in a form only development builds wrote (review 2026-11-16 S4-8).
  it.each(['legacy', 'unwritten-form', 'wrong-version', 'missing-record', 'broken-record', 'missing-source', 'broken-source'])(
    'retains only established version information with %s evidence', async mode => {
      const p = await delivered(); p.edit();
      const record = JSON.parse(fs.readFileSync(p.recordPath, 'utf8'));
      if (mode === 'legacy') { delete record.delivered_version_id; fs.writeFileSync(p.recordPath, JSON.stringify(record)); }
      if (mode === 'unwritten-form') fs.writeFileSync(p.recordPath, JSON.stringify({ ...record, delivered_source_sha256: `facts:${'0'.repeat(64)}` }));
      if (mode === 'wrong-version') fs.writeFileSync(p.recordPath, JSON.stringify({ ...record, delivered_version_id: 'v999' }));
      if (mode === 'missing-record') fs.rmSync(p.recordPath);
      if (mode === 'broken-record') fs.writeFileSync(p.recordPath, '{');
      if (mode === 'missing-source') fs.rmSync(p.manifestPath);
      if (mode === 'broken-source') fs.writeFileSync(p.manifestPath, '{');
      expect(await notice([p.file])).toBe('Attachment 1: delivered version v1 is retained.');
      if (['broken-record', 'missing-source', 'broken-source'].includes(mode)) {
        expect(warning).toHaveBeenCalledWith('delivery notice incomplete', { reasons: ['metadata'] });
      } else expect(warning).not.toHaveBeenCalled();
    },
  );

  it.each(['unrelated', 'missing-video', 'missing-ledger', 'broken-ledger', 'oversized-ledger'])(
    'omits unsupported claims for %s without throwing', async mode => {
      const p = await delivered();
      if (mode === 'unrelated') fs.writeFileSync(p.ledgerPath, JSON.stringify({ versions: [] }));
      if (mode === 'missing-video') fs.rmSync(p.file);
      if (mode === 'missing-ledger') fs.rmSync(p.ledgerPath);
      if (mode === 'broken-ledger') fs.writeFileSync(p.ledgerPath, '{');
      if (mode === 'oversized-ledger') fs.writeFileSync(p.ledgerPath, 'x'.repeat(1024 * 1024 + 1));
      await expect(notice([p.file])).resolves.toBe('');
      if (['missing-video', 'broken-ledger', 'oversized-ledger'].includes(mode)) expect(warning).toHaveBeenCalledTimes(1);
    },
  );

  it('does not compare an older attached version against a newer version\'s source', async () => {
    const old = await delivered('main', 'v1'); await delivered('main', 'v2'); old.edit();
    expect(await notice([old.file])).toBe('Attachment 1: delivered version v1 is retained.');
  });

  it('reports a delivered standalone video without inventing a timeline or later edits', async () => {
    const p = await delivered();
    const ledger = JSON.parse(fs.readFileSync(p.ledgerPath, 'utf8'));
    delete ledger.versions[0].video_id;
    fs.writeFileSync(p.ledgerPath, JSON.stringify(ledger));
    p.edit();
    expect(await notice([p.file])).toBe('Attachment 1: delivered version v1 is retained.');
    expect(warning).not.toHaveBeenCalled();
  });

  it.each(['<img src=x>', 'v' + '1'.repeat(25)])('omits an invalid version label instead of copying it into the reply (%s)', async id => {
    const p = await delivered();
    const ledger = JSON.parse(fs.readFileSync(p.ledgerPath, 'utf8'));
    ledger.versions[0].id = id;
    fs.writeFileSync(p.ledgerPath, JSON.stringify(ledger));
    expect(await notice([p.file])).toBe('');
  });

  it('does not follow metadata symlinks outside the production', async () => {
    const p = await delivered();
    const foreign = path.join(root, 'foreign.json'); fs.writeFileSync(foreign, 'private');
    fs.rmSync(p.recordPath); fs.symlinkSync(foreign, p.recordPath);
    const open = vi.spyOn(fsPromises, 'open'); syncBuiltinESMExports();
    expect(await notice([p.file])).toBe('Attachment 1: delivered version v1 is retained.');
    expect(open.mock.calls.some(([file]) => file === foreign || file === p.recordPath)).toBe(false);
    expect(warning).toHaveBeenCalledWith('delivery notice incomplete', { reasons: ['metadata'] });
  });

  it('skips out-of-scope files and ordinary outputs without opening metadata', async () => {
    const p = await delivered();
    const open = vi.spyOn(fsPromises, 'open'); syncBuiltinESMExports();
    expect(await interruptedVideoDeliveryNotice({ produced: [p.file], allowedRoots: [path.join(root, 'other')] })).toBe('');
    expect(await notice([path.join(root, 'report.docx')])).toBe('');
    expect(open).not.toHaveBeenCalled();
  });

  it('caps optional work and emits one content-free diagnostic', async () => {
    const files: string[] = [];
    for (let n = 1; n <= 5; n++) files.push((await delivered(`video-${n}`, `v${n}`)).file);
    const text = await notice(files);
    expect(text.split('\n\n')).toHaveLength(4);
    expect(text).not.toContain('Attachment 5');
    expect(warning).toHaveBeenCalledExactlyOnceWith('delivery notice incomplete', { reasons: ['limit'] });
  });

  it('settles on slow metadata and closes a late file handle without resuming work', async () => {
    const p = await delivered();
    const handle = await fsPromises.open(p.ledgerPath, 'r');
    const close = vi.spyOn(handle, 'close');
    let release!: (value: typeof handle) => void;
    const pending = new Promise<typeof handle>(resolve => { release = resolve; });
    let opened!: () => void;
    const opening = new Promise<void>(resolve => { opened = resolve; });
    vi.spyOn(fsPromises, 'open').mockImplementationOnce(() => { opened(); return pending; }); syncBuiltinESMExports();
    vi.useFakeTimers();
    const result = notice([p.file]);
    await opening;
    await vi.advanceTimersByTimeAsync(501);
    expect(await result).toBe('');
    expect(warning).toHaveBeenCalledExactlyOnceWith('delivery notice incomplete', { reasons: ['timeout'] });
    release(handle);
    await vi.advanceTimersByTimeAsync(0);
    expect(close).toHaveBeenCalledOnce();
  });

  it('has complete localized copy and placeholders for every registered locale', () => {
    for (const lang of SUPPORTED_LANGS) {
      const table = JSON.parse(fs.readFileSync(path.join(__dirname, '../../../src/main/locales', `${lang}.json`), 'utf8'));
      expect(table['video.delivery_retained'], lang).toMatch(/\{index\}/);
      expect(table['video.delivery_retained'], lang).toMatch(/\{version\}/);
      expect(table['video.delivery_later_edits'], lang).toBeTruthy();
    }
  });
});
