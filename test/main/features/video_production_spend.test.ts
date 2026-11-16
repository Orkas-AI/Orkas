import * as fs from 'node:fs';
import * as fsAsync from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, copyFile: vi.fn(actual.copyFile) };
});
const quote = vi.hoisted(() => ({ available: true, calls: 0 }));
vi.mock('../../../src/main/features/video_production_services', () => ({ checkVideoProductionServices: async (intents: any[]) => { quote.calls++; return { sufficient: quote.available, external_billing_estimate_available: false, externally_billed_segment_ids: quote.available ? intents.map(i => i.segment_id) : [], unavailable_segment_ids: quote.available ? [] : intents.map(i => i.segment_id), segments: [] }; } }));
let beginTimelineGeneration: typeof import('../../../src/main/features/video_production_spend').beginTimelineGeneration;
let finishTimelineGeneration: typeof import('../../../src/main/features/video_production_spend').finishTimelineGeneration;
let importProductionFile: typeof import('../../../src/main/features/video_production_spend').importProductionFile;
let productionRequestFingerprint: typeof import('../../../src/main/features/video_production_spend').productionRequestFingerprint;
let importProductionAttachments: typeof import('../../../src/main/features/video_production_spend').importProductionAttachments;
let recordProductionAsset: typeof import('../../../src/main/features/video_production_spend').recordProductionAsset;
let releaseProductionSpend: typeof import('../../../src/main/features/video_production_spend').releaseProductionSpend;
let productionRequestHold: typeof import('../../../src/main/features/video_production_budget').productionRequestHold;
let root: string, previous: string | undefined;
const userId = 'video-local-user', scope = 'conversation-1';
const intent = { segment_id: 'request', kind: 'video' as const, prompt: 'A lamp', duration: 8 };
function begin(request: Record<string, unknown> = { prompt: 'A lamp' }, extra: Record<string, unknown> = {}) { return beginTimelineGeneration({ userId, scope, productionDirAbs: path.join(root, 'ad'), allowedRoots: [root], kind: 'video', intent, requestedAbs: path.join(root, 'ad', 'shots', 'one.mp4'), request, ...extra }); }
beforeEach(async () => {  
root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'video-public-production-'))); previous = process.env.ORKAS_WORKSPACE_ROOT; process.env.ORKAS_WORKSPACE_ROOT = root; quote.available = true; quote.calls = 0; vi.resetModules();
  ({ beginTimelineGeneration, finishTimelineGeneration, importProductionFile, productionRequestFingerprint, importProductionAttachments, recordProductionAsset, releaseProductionSpend } = await import('../../../src/main/features/video_production_spend'));
  ({ productionRequestHold } = await import('../../../src/main/features/video_production_budget'));
});
afterEach(() => { if (previous === undefined) delete process.env.ORKAS_WORKSPACE_ROOT; else process.env.ORKAS_WORKSPACE_ROOT = previous; fs.rmSync(root, { recursive: true, force: true }); });
describe('productionRequestFingerprint', () => {
  it('is stable for the same request and differs when it changes', () => {
    expect(productionRequestFingerprint({ a: 1 })).toBe(productionRequestFingerprint({ a: 1 }));
    expect(productionRequestFingerprint({ a: 1 })).not.toBe(productionRequestFingerprint({ a: 2 }));
  });
});

describe('importProductionAttachments', () => {
  const setup = () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-import-'));
    const attachments = path.join(root, 'attachments');
    const production = path.join(root, 'lamp-ad');
    fs.mkdirSync(attachments);
    fs.mkdirSync(path.join(attachments, 'a-folder'));
    return { root, attachments, production };
  };

  it('copies each file once, keeps its row on a second run, and leaves the original alone', async () => {
    const { root, attachments, production } = setup();
    try {
      fs.writeFileSync(path.join(attachments, 'voice.mp3'), 'first');
      const first = await importProductionAttachments({ productionDirAbs: production, attachmentDirAbs: attachments });
      expect(first.imported).toEqual([{ asset_id: expect.any(String), kind: 'audio', label: 'voice.mp3', path: 'media/voice.mp3' }]);
      const copy = path.join(production, 'media', 'voice.mp3');
      const copied = fs.statSync(copy).mtimeMs;
      const second = await importProductionAttachments({ productionDirAbs: production, attachmentDirAbs: attachments });
      expect(second.imported[0].asset_id).toBe(first.imported[0].asset_id);
      expect(fs.statSync(copy).mtimeMs).toBe(copied);
      expect(JSON.parse(fs.readFileSync(path.join(production, 'assets.json'), 'utf8')).assets).toHaveLength(1);
      const originalTimes = fs.statSync(path.join(attachments, 'voice.mp3'));
      fs.writeFileSync(path.join(attachments, 'voice.mp3'), 'other');
      fs.utimesSync(path.join(attachments, 'voice.mp3'), originalTimes.atime, originalTimes.mtime);
      const replaced = await importProductionAttachments({ productionDirAbs: production, attachmentDirAbs: attachments });
      expect(fs.readFileSync(copy, 'utf8')).toBe('other');
      expect(replaced.imported[0].asset_id).toBe(first.imported[0].asset_id);
      expect(fs.readFileSync(path.join(attachments, 'voice.mp3'), 'utf8')).toBe('other');
      fs.writeFileSync(path.join(attachments, 'voice.mp3'), 'a longer replacement');
      await importProductionAttachments({ productionDirAbs: production, attachmentDirAbs: attachments });
      expect(fs.readFileSync(copy, 'utf8')).toBe('a longer replacement');
      expect(fs.readFileSync(path.join(attachments, 'voice.mp3'), 'utf8')).toBe('a longer replacement');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('takes only the names asked for, and reports what it could not bring', async () => {
    const { root, attachments, production } = setup();
    try {
      fs.writeFileSync(path.join(attachments, 'a.mp3'), 'a');
      fs.writeFileSync(path.join(attachments, 'b.mp3'), 'b');
      fs.writeFileSync(path.join(attachments, 'c.txt'), 'c');
      const result = await importProductionAttachments({ productionDirAbs: production, attachmentDirAbs: attachments, names: ['b.mp3', 'c.txt', 'gone.mp4'] });
      expect(result.imported.map((item) => item.label)).toEqual(['b.mp3']);
      expect(result.skipped.sort()).toEqual(['c.txt', 'gone.mp4']);
      expect(fs.existsSync(path.join(production, 'media', 'a.mp3'))).toBe(false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('finds nothing in a conversation without attachments, and does not create the folder', async () => {
    const { root, production } = setup();
    try {
      expect(await importProductionAttachments({ productionDirAbs: production, attachmentDirAbs: path.join(root, 'missing') }))
        .toEqual({ imported: [], skipped: [] });
      expect(fs.existsSync(production)).toBe(false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('what a finished result remembers', () => {
  it('keeps the call that made it, and which assets it was made from', async () => {
    const dir = path.join(root, 'ad');
    const photo = path.join(dir, 'media', 'photo.png');
    fs.mkdirSync(path.dirname(photo), { recursive: true });
    fs.writeFileSync(photo, 'x');
    const photoId = await recordProductionAsset({ productionDirAbs: dir, fileAbs: photo, record: { kind: 'image', label: 'Photo', origin: 'upload' } });
    const first = await begin() as { spend: Parameters<typeof finishTimelineGeneration>[0]['spend'] };
    const file = path.join(dir, 'shots', 'one.mp4');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, 'x');

    const request = { prompt: 'a lamp', duration: 8 };
    await finishTimelineGeneration({
      spend: first.spend,
      userId,
      kind: 'video',
      fileAbs: file,
      prompt: 'a lamp',
      request,
      referenceFiles: [photo, path.join(root, 'elsewhere.png')],
    });

    const stored = JSON.parse(fs.readFileSync(path.join(dir, 'assets.json'), 'utf8'));
    expect(stored.assets[1]).toMatchObject({ request, refs: [{ asset: photoId, role: 'reference' }] });
  });
});

describe('importProductionFile', () => {
  function source(name: string, content = 'x'): string {
    const file = path.join(root, 'downloads', name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
    return file;
  }

  it('copies a picture in and lists it', async () => {
    const dir = path.join(root, 'ad');
    const imported = await importProductionFile({ productionDirAbs: dir, sourceAbs: source('box.png'), name: 'box.png' });
    expect(imported).toMatchObject({ asset_id: 'box', kind: 'image', label: 'box.png', path: 'media/box.png' });
    expect(fs.readFileSync(path.join(dir, 'media', 'box.png'), 'utf8')).toBe('x');
  });

  it('gives no path in the name a way out of the production', async () => {
    const dir = path.join(root, 'ad');
    const imported = await importProductionFile({ productionDirAbs: dir, sourceAbs: source('box.png'), name: '../../box.png' });
    expect(imported?.path).toBe('media/box.png');
    expect(fs.existsSync(path.join(root, 'box.png'))).toBe(false);
  });

  it('ignores what no video can use', async () => {
    const dir = path.join(root, 'ad');
    expect(await importProductionFile({ productionDirAbs: dir, sourceAbs: source('notes.pdf'), name: 'notes.pdf' })).toBeNull();
    expect(fs.existsSync(path.join(dir, 'assets.json'))).toBe(false);
  });
});

describe('recordProductionAsset', () => {
  const record = { kind: 'video' as const, label: 'Shot', origin: 'generated' as const };

  it('adds a row with a portable path and a usable id', async () => {
    const dir = path.join(root, 'ad');
    const id = await recordProductionAsset({ productionDirAbs: dir, fileAbs: path.join(dir, 'shots', 'My Shot!.mp4'), record });
    expect(id).toMatch(/^[A-Za-z0-9][A-Za-z0-9_-]*$/);
    const stored = JSON.parse(fs.readFileSync(path.join(dir, 'assets.json'), 'utf8'));
    expect(stored.assets[0]).toMatchObject({ id, path: 'shots/My Shot!.mp4', origin: 'generated' });
  });

  it('updates the row for a path it already has, and keeps two files with one name apart', async () => {
    const dir = path.join(root, 'ad');
    const file = path.join(dir, 'a', 'one.mp4');
    const first = await recordProductionAsset({ productionDirAbs: dir, fileAbs: file, record });
    expect(await recordProductionAsset({ productionDirAbs: dir, fileAbs: file, record: { ...record, label: 'New' } })).toBe(first);
    const second = await recordProductionAsset({ productionDirAbs: dir, fileAbs: path.join(dir, 'b', 'one.mp4'), record });
    expect(second).not.toBe(first);
    const stored = JSON.parse(fs.readFileSync(path.join(dir, 'assets.json'), 'utf8'));
    expect(stored.assets).toHaveLength(2);
    expect(stored.assets[0].label).toBe('New');
  });

  it('keeps every row when several results land at once', async () => {
    const dir = path.join(root, 'ad');
    await Promise.all(['a', 'b', 'c', 'd'].map((name) => recordProductionAsset({ productionDirAbs: dir, fileAbs: path.join(dir, `${name}.mp4`), record })));
    expect(JSON.parse(fs.readFileSync(path.join(dir, 'assets.json'), 'utf8')).assets).toHaveLength(4);
  });

  it('never overwrites a ledger it cannot read', async () => {
    const dir = path.join(root, 'ad');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'assets.json'), '{ half written');
    await expect(recordProductionAsset({ productionDirAbs: dir, fileAbs: path.join(dir, 'a.mp4'), record })).rejects.toThrow(/assets\.json/);
    expect(fs.readFileSync(path.join(dir, 'assets.json'), 'utf8')).toBe('{ half written');
  });
});


describe('production import filesystem boundary', () => {
  it.each(['media-directory', 'attachment-leaf', 'ledger-leaf', 'picker-dangling-leaf'])(
    'preserves foreign files when the %s is a symlink', async (boundary) => {
      const production = path.join(root, 'ad');
      const media = path.join(production, 'media');
      const attachments = path.join(root, 'attachments');
      const foreign = path.join(root, 'foreign');
      fs.mkdirSync(media, { recursive: true });
      fs.mkdirSync(attachments);
      fs.mkdirSync(foreign);
      const source = path.join(attachments, 'voice.mp3');
      const target = path.join(foreign, 'voice.mp3');
      const ledger = path.join(foreign, 'assets.json');
      fs.writeFileSync(source, 'new');
      fs.writeFileSync(target, 'old');
      fs.writeFileSync(ledger, '{"assets":[]}');
      if (boundary === 'media-directory') {
        fs.rmdirSync(media);
        fs.symlinkSync(foreign, media, 'junction');
      } else if (boundary === 'attachment-leaf') fs.symlinkSync(target, path.join(media, 'voice.mp3'));
      else if (boundary === 'ledger-leaf') fs.symlinkSync(ledger, path.join(production, 'assets.json'));
      else fs.symlinkSync(path.join(foreign, 'new.mp3'), path.join(media, 'voice.mp3'));
      const action = boundary === 'picker-dangling-leaf'
        ? importProductionFile({ productionDirAbs: production, sourceAbs: source, name: 'voice.mp3' })
        : importProductionAttachments({ productionDirAbs: production, attachmentDirAbs: attachments });
      await expect(action).rejects.toThrow();
      expect(fs.readFileSync(target, 'utf8')).toBe('old');
      expect(fs.readFileSync(ledger, 'utf8')).toBe('{"assets":[]}');
      expect(fs.existsSync(path.join(foreign, 'new.mp3'))).toBe(false);
      expect(fs.readFileSync(source, 'utf8')).toBe('new');
    });
});

describe('public generation lifecycle and no replay', () => {
  it('admits one identity and refuses a concurrent or uncertain duplicate before any new generation', async () => {
    const result = await Promise.all([begin(), begin()]); expect(result.filter(item => 'spend' in item)).toHaveLength(1); expect(result.filter(item => 'refusal' in item)).toHaveLength(1);
    const refused = result.find(item => 'refusal' in item) as { refusal: { content: string } }; expect(refused.refusal.content).toContain('E_GENERATION_PENDING');
  });
  it('releases a definite pre-dispatch failure for an explicit retry', async () => {
    const first = await begin(); if (!('spend' in first)) throw new Error('request not admitted'); await releaseProductionSpend({ userId, scope, fingerprint: first.spend.fingerprint }); expect(await begin()).toHaveProperty('spend');
  });
  it('refuses unavailable services without a private price card or a request hold', async () => {
    quote.available = false; const result = await begin(); expect(result).toHaveProperty('refusal'); expect(JSON.stringify(result)).toContain('E_UNAVAILABLE'); expect(JSON.stringify(result)).not.toMatch(/budget_request|available_credits|purchase|sign.in/);
  });
  it('keeps a completed local result when configuration later becomes unavailable', async () => {
    const first = await begin(); if (!('spend' in first)) throw new Error('request not admitted'); const file = path.join(root, 'ad', 'shots', 'one.mp4'); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, 'completed-result');
    await finishTimelineGeneration({ spend: first.spend, userId, kind: 'image', fileAbs: file, prompt: 'A lamp' }); quote.available = false; const calls = quote.calls;
    expect(await begin()).toMatchObject({ reusedPath: file }); expect(quote.calls).toBe(calls); expect(fs.readFileSync(file, 'utf8')).toBe('completed-result');
  });
  it('does not confuse a same-size replacement reference with the old request, even after its mtime is restored', async () => {
    const reference = path.join(root, 'reference.png'); fs.writeFileSync(reference, 'before'); fs.utimesSync(reference, new Date(1800000000000), new Date(1800000000000)); const old = fs.statSync(reference);
    const first = await begin({ prompt: 'A lamp' }, { referenceFiles: [reference] }); if (!('spend' in first)) throw new Error('request not admitted'); fs.writeFileSync(reference, 'after!'); fs.utimesSync(reference, old.atime, old.mtime); expect(fs.statSync(reference).size).toBe(old.size); expect(fs.statSync(reference).mtimeMs).toBe(old.mtimeMs);
    const second = await begin({ prompt: 'A lamp' }, { referenceFiles: [reference] }); if (!('spend' in second)) throw new Error('replacement not admitted'); expect(second.spend.fingerprint).not.toBe(first.spend.fingerprint);
  });
  it('preserves a generated file and its settled request when a damaged asset ledger needs explicit repair', async () => {
    const first = await begin(); if (!('spend' in first)) throw new Error('request not admitted'); const file = path.join(root, 'ad', 'one.png'); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, 'generated'); fs.writeFileSync(path.join(root, 'ad', 'assets.json'), '{broken');
    const finished = await finishTimelineGeneration({ spend: first.spend, userId, kind: 'image', fileAbs: file, prompt: 'A lamp' }); expect(finished.note).toContain('assets.json'); expect(fs.readFileSync(file, 'utf8')).toBe('generated'); expect(fs.readFileSync(path.join(root, 'ad', 'assets.json'), 'utf8')).toBe('{broken'); expect(await productionRequestHold({ userId, scope, fingerprint: first.spend.fingerprint })).toMatchObject({ state: 'settled', output: file });
  });
  it('does not touch a production outside the permitted workspace', async () => {
    const result = await begin(undefined, { productionDirAbs: path.join(root, '..', 'foreign-production') }); expect(result).toHaveProperty('refusal'); expect(JSON.stringify(result)).toContain('E_PATH_OUT_OF_SCOPE'); expect(quote.calls).toBe(0);
  });
});

it('keeps both differently sourced dropped files when concurrent imports share a display name', async () => {
  const production = path.join(root, 'ad'); const first = path.join(root, 'first.mp3'), second = path.join(root, 'second.mp3'); fs.writeFileSync(first, 'first-bytes'); fs.writeFileSync(second, 'other-bytes');
  const rows = await Promise.all([importProductionFile({ productionDirAbs: production, sourceAbs: first, name: 'voice.mp3' }), importProductionFile({ productionDirAbs: production, sourceAbs: second, name: 'voice.mp3' })]);
  expect(new Set(rows.map(row => row?.asset_id)).size).toBe(2); expect(rows.map(row => fs.readFileSync(path.resolve(production, row!.path), 'utf8')).sort()).toEqual(['first-bytes', 'other-bytes']);
});


describe('production import publication against competing filesystem writers', () => {
  it.each(['different', 'identical'])('preserves a %s revision published after the absent-name check', async mode => {
    const production = path.join(root, 'ad');
    const source = path.join(root, 'voice.mp3');
    const destination = path.join(production, 'media', 'voice.mp3');
    const competing = mode === 'identical' ? 'source revision' : 'competing revision';
    fs.writeFileSync(source, 'source revision');
    const realCopy = fsAsync.copyFile;
    const copy = vi.spyOn(fsAsync, 'copyFile').mockImplementationOnce(async (from, to, flags) => {
      // A different process can publish after our real absent-file observation.
      fs.writeFileSync(destination, competing, { flag: 'wx' });
      return realCopy(from, to, flags);
    });
    try {
      const row = await importProductionFile({ productionDirAbs: production, sourceAbs: source, name: 'voice.mp3' });
      expect(fs.readFileSync(destination, 'utf8')).toBe(competing);
      expect(fs.readFileSync(path.join(production, row!.path), 'utf8')).toBe('source revision');
      expect(row!.path).toBe(mode === 'identical' ? 'media/voice.mp3' : 'media/voice-2.mp3');
      expect(fs.readdirSync(path.dirname(destination)).sort()).toEqual(mode === 'identical' ? ['voice.mp3'] : ['voice-2.mp3', 'voice.mp3']);
    } finally { copy.mockRestore(); }
  });

  it('leaves no final asset or partial file when copying fails before publication', async () => {
    const production = path.join(root, 'ad');
    const source = path.join(root, 'voice.mp3');
    fs.writeFileSync(source, 'source revision');
    const copy = vi.spyOn(fsAsync, 'copyFile').mockImplementationOnce(async (_from, to) => {
      fs.writeFileSync(to, 'partial');
      throw Object.assign(new Error('injected disk write failure'), { code: 'ENOSPC' });
    });
    try {
      await expect(importProductionFile({ productionDirAbs: production, sourceAbs: source, name: 'voice.mp3' })).rejects.toThrow('injected disk write failure');
      expect(fs.readdirSync(path.join(production, 'media'))).toEqual([]);
      expect(fs.existsSync(path.join(production, 'assets.json'))).toBe(false);
      expect(fs.readFileSync(source, 'utf8')).toBe('source revision');
    } finally { copy.mockRestore(); }
  });
});


describe('portable completed generation identities', () => {
  async function completed(name: string) {
    const first = await begin();
    if (!('spend' in first)) throw new Error('request not admitted');
    const file = path.join(root, 'ad', 'shots', name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, 'completed media');
    const facts = await finishTimelineGeneration({ spend: first.spend, userId, kind: 'image', fileAbs: file, prompt: 'A lamp' });
    return { file, facts, first };
  }
  it('reuses the actual saved output name and marks direct provider billing first', async () => {
    const { file, facts } = await completed('one-2.png');
    expect(await begin()).toMatchObject({ reusedPath: file, spend: { heldNow: false } });
    expect(JSON.stringify(facts).startsWith('{"billed_to_own_key":true')).toBe(true);
    expect(fs.readFileSync(file, 'utf8')).toBe('completed media');
  });
  it('checks availability and reserves a replacement only when the completed output is gone', async () => {
    const { file, first } = await completed('one-2.png');
    fs.unlinkSync(file);
    quote.available = false;
    expect(await begin()).toHaveProperty('refusal');
    expect(await productionRequestHold({ userId, scope, fingerprint: first.spend.fingerprint })).toMatchObject({ state: 'settled', output: file });
    quote.available = true;
    expect(await begin()).toMatchObject({ spend: { heldNow: true } });
    expect(fs.existsSync(file)).toBe(false);
  });
});
