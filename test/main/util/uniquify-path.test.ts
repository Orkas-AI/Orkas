import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { uniquifyPath, uniquifyPathForWrite, renderRenameSignal } from '../../../src/main/util/uniquify-path';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-uniquify-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const NEVER_MINE = () => false;

describe('uniquifyPath › passthrough', () => {
  it('returns the input unchanged when the target does not exist', async () => {
    const target = path.join(tmpDir, 'fresh.py');
    const r = await uniquifyPath(target, NEVER_MINE);
    expect(r).toEqual({ finalPath: target, renamed: false });
  });

  it('returns the input unchanged when isMine(input) is true (refinement)', async () => {
    const target = path.join(tmpDir, 'draft.md');
    fs.writeFileSync(target, 'v1');
    const r = await uniquifyPath(target, (p) => p === target);
    expect(r).toEqual({ finalPath: target, renamed: false });
  });
});

describe('uniquifyPath › collision', () => {
  it('inserts -2 before the extension on first collision', async () => {
    const target = path.join(tmpDir, 'app.py');
    fs.writeFileSync(target, 'someone else');
    const r = await uniquifyPath(target, NEVER_MINE);
    expect(r).toEqual({ finalPath: path.join(tmpDir, 'app-2.py'), renamed: true });
  });

  it('walks past existing -2 / -3 to find the next free slot', async () => {
    fs.writeFileSync(path.join(tmpDir, 'app.py'), 'a');
    fs.writeFileSync(path.join(tmpDir, 'app-2.py'), 'b');
    fs.writeFileSync(path.join(tmpDir, 'app-3.py'), 'c');
    const r = await uniquifyPath(path.join(tmpDir, 'app.py'), NEVER_MINE);
    expect(r.finalPath).toBe(path.join(tmpDir, 'app-4.py'));
    expect(r.renamed).toBe(true);
  });

  it('returns a candidate as soon as isMine claims it (overwrite-own)', async () => {
    fs.writeFileSync(path.join(tmpDir, 'app.py'), 'foreign');
    fs.writeFileSync(path.join(tmpDir, 'app-2.py'), 'mine v1');
    const mine = path.join(tmpDir, 'app-2.py');
    const r = await uniquifyPath(path.join(tmpDir, 'app.py'), (p) => p === mine);
    expect(r).toEqual({ finalPath: mine, renamed: true });
  });
});

describe('uniquifyPath › extension handling', () => {
  it('preserves single extensions', async () => {
    fs.writeFileSync(path.join(tmpDir, 'note.md'), '');
    const r = await uniquifyPath(path.join(tmpDir, 'note.md'), NEVER_MINE);
    expect(r.finalPath).toBe(path.join(tmpDir, 'note-2.md'));
  });

  it('handles ext-less basenames (Makefile)', async () => {
    fs.writeFileSync(path.join(tmpDir, 'Makefile'), '');
    const r = await uniquifyPath(path.join(tmpDir, 'Makefile'), NEVER_MINE);
    expect(r.finalPath).toBe(path.join(tmpDir, 'Makefile-2'));
  });

  it('treats dotfiles as ext-less (path.parse semantics for .env)', async () => {
    fs.writeFileSync(path.join(tmpDir, '.env'), '');
    const r = await uniquifyPath(path.join(tmpDir, '.env'), NEVER_MINE);
    expect(r.finalPath).toBe(path.join(tmpDir, '.env-2'));
  });

  it('only splits on the last dot — app.tar.gz becomes app.tar-2.gz (cosmetic)', async () => {
    fs.writeFileSync(path.join(tmpDir, 'bundle.tar.gz'), '');
    const r = await uniquifyPath(path.join(tmpDir, 'bundle.tar.gz'), NEVER_MINE);
    expect(r.finalPath).toBe(path.join(tmpDir, 'bundle.tar-2.gz'));
  });
});

describe('renderRenameSignal', () => {
  it('emits a basename-only <file-renamed> block', () => {
    const out = renderRenameSignal('/abs/dir/app.py', '/abs/dir/app-2.py');
    expect(out).toContain('<file-renamed>');
    expect(out).toContain('</file-renamed>');
    expect(out).toContain('You requested: app.py');
    expect(out).toContain('Saved as:      app-2.py');
    expect(out).not.toContain('/abs/dir/');
  });
});

// Two parallel agent turns sharing one conversation workspace both deliver a
// file under the same requested name. The contract is that neither delivery is
// silently lost: probe+write are serialized per requested path, so the loser's
// probe sees the winner's file and suffixes. Plain uniquifyPath is
// check-then-act and deterministically fails this scenario (both probes run
// before either write) — verified as the mutation control for this case.
describe('uniquifyPathForWrite › concurrent same-target writers', () => {
  it('keeps both concurrent deliveries: one original, one suffixed, no clobber', async () => {
    const target = path.join(tmpDir, 'plan.md');
    const writeVia = (content: string) => uniquifyPathForWrite(
      target, NEVER_MINE,
      async (decision) => {
        fs.writeFileSync(decision.finalPath, content);
        return decision;
      },
    );
    const [a, b] = await Promise.all([writeVia('from-agent-A'), writeVia('from-agent-B')]);
    const finals = [a.finalPath, b.finalPath].sort();
    expect(finals).toEqual([path.join(tmpDir, 'plan-2.md'), target].sort());
    expect([a.renamed, b.renamed].filter(Boolean)).toHaveLength(1);
    const contents = finals.map((f) => fs.readFileSync(f, 'utf8')).sort();
    expect(contents).toEqual(['from-agent-A', 'from-agent-B']);
  });

  it('releases the lock when the write throws, so the path recovers for the next writer', async () => {
    const target = path.join(tmpDir, 'report.md');
    await expect(uniquifyPathForWrite(target, NEVER_MINE, async () => {
      throw new Error('render blew up');
    })).rejects.toThrow('render blew up');
    // The failed attempt left nothing on disk and holds nothing: the retry
    // gets the ORIGINAL path back, not a stale suffix or a hang.
    const retry = await uniquifyPathForWrite(target, NEVER_MINE, async (decision) => {
      fs.writeFileSync(decision.finalPath, 'second try');
      return decision;
    });
    expect(retry).toEqual({ finalPath: target, renamed: false });
    expect(fs.readFileSync(target, 'utf8')).toBe('second try');
  });
});

it('keeps both files when a renamed destination is another concurrent writer\'s requested name', async () => {
  const original = path.join(tmpDir, 'speech.mp3'), suffix = path.join(tmpDir, 'speech-2.mp3');
  fs.writeFileSync(original, 'user audio');
  let entered!: () => void, finish!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const first = uniquifyPathForWrite(original, NEVER_MINE, async decision => {
    entered();
    await new Promise<void>(resolve => { finish = resolve; });
    fs.writeFileSync(decision.finalPath, 'first new voice');
    return decision.finalPath;
  });
  await started;
  const second = await uniquifyPathForWrite(suffix, NEVER_MINE, async decision => {
    fs.writeFileSync(decision.finalPath, 'second new voice');
    return decision.finalPath;
  });
  finish();
  const one = await first;
  expect(one).not.toBe(second);
  expect(fs.readFileSync(original, 'utf8')).toBe('user audio');
  expect(fs.readFileSync(one, 'utf8')).toBe('first new voice');
  expect(fs.readFileSync(second, 'utf8')).toBe('second new voice');
});

it('cancels only the waiting writer without dispatching it or releasing the active writer', async () => {
  const target = path.join(tmpDir, 'held.mp3');
  let entered!: () => void, finish!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const first = uniquifyPathForWrite(target, NEVER_MINE, async decision => {
    entered(); await new Promise<void>(resolve => { finish = resolve; });
    fs.writeFileSync(decision.finalPath, 'first');
  });
  await started;
  const stop = new AbortController(); let dispatched = false;
  const second = uniquifyPathForWrite(target, NEVER_MINE, async () => { dispatched = true; }, stop.signal);
  const rejected = expect(second).rejects.toThrow();
  stop.abort(); await rejected;
  expect(dispatched).toBe(false); expect(fs.existsSync(target)).toBe(false);
  finish(); await first;
  const next = await uniquifyPathForWrite(target, NEVER_MINE, async decision => {
    fs.writeFileSync(decision.finalPath, 'next'); return decision.finalPath;
  });
  expect(fs.readFileSync(target, 'utf8')).toBe('first');
  expect(fs.readFileSync(next, 'utf8')).toBe('next');
});
