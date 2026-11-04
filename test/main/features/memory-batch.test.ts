import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import nativeFs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import * as os from 'node:os';
import * as path from 'node:path';

let root: string;
let previousRoot: string | undefined;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-memory-batch-'));
  previousRoot = process.env.ORKAS_WORKSPACE_ROOT;
  process.env.ORKAS_WORKSPACE_ROOT = root;
  vi.resetModules();
});
afterEach(() => {
  vi.restoreAllMocks();
  syncBuiltinESMExports();
  if (previousRoot === undefined) delete process.env.ORKAS_WORKSPACE_ROOT;
  else process.env.ORKAS_WORKSPACE_ROOT = previousRoot;
  fs.rmSync(root, { recursive: true, force: true });
});

async function fixture(scope: any = { project: 'batch-project' }) {
  const mem = await import('../../../src/main/features/memory');
  const paths = await import('../../../src/main/paths');
  const uid = 'batch-owner';
  const file = scope === 'user' ? paths.userProfileFile(uid)
    : scope === 'memory' ? paths.userMemoryFile(uid)
    : 'agent' in scope ? paths.agentMemoryFile(uid, scope.agent) : paths.projectMemoryFile(uid, scope.project);
  const read = () => mem.listEntries(uid, scope);
  // A missing export is a readiness failure, not evidence of batch behavior.
  const apply = (operations: unknown, revision = (read() as any).revision, guard?: () => boolean) => {
    expect(typeof (mem as any).applyMemoryBatch).toBe('function');
    return (mem as any).applyMemoryBatch(uid, scope, revision, operations, guard);
  };
  return { mem, uid, file, read, apply, scope };
}

describe('atomic memory batches', () => {
  it.each(['user', 'memory', { agent: 'batch-agent' }, { project: 'batch-project' }])(
    'merges and adds at a full entry/character boundary in %j with one activation', async scope => {
      const f = await fixture(scope);
      const limit = f.read().usage.limit;
      const first = 'Release day: Thursday.';
      const second = 'Release owner: Mei.';
      const rest = Array.from({ length: 14 }, (_, i) => `Other decision ${i}: retained`);
      // Fill the character budget too: lengthening the first entry alone cannot fit.
      rest[13] += 'x'.repeat(limit - [first, second, ...rest].join(f.mem.ENTRY_SEPARATOR).length);
      const before = [first, second, ...rest];
      f.mem.saveEntries(f.file, before.map(text => ({ text })));
      const originalRename = nativeFs.renameSync;
      const seen: string[] = [];
      vi.spyOn(nativeFs, 'renameSync').mockImplementation((from, to) => {
        if (String(to) === f.file) seen.push(fs.readFileSync(f.file, 'utf8'));
        originalRename(from, to);
      });
      syncBuiltinESMExports();
      const result = f.apply([
        { action: 'replace', old_text: first, content: 'Thursday releases: Mei.' },
        { action: 'add', content: 'TZ: UTC.' },
        { action: 'remove', old_text: second },
      ]);
      expect(result).toMatchObject({ ok: true, changed: true });
      expect(result.entries).toEqual(['Thursday releases: Mei.', ...rest, 'TZ: UTC.']);
      expect(seen).toEqual([before.join(f.mem.ENTRY_SEPARATOR)]);
      expect(f.mem.loadEntries(f.file).map(e => e.text)).toEqual(result.entries);
      expect(result.revision).toMatch(/^[a-f0-9]{64}$/);
    },
  );

  it('resolves edits against the original snapshot regardless of operation order', async () => {
    const f = await fixture();
    const operations = [{ action: 'replace', old_text: 'a', content: 'b' }, { action: 'remove', old_text: 'b' }];
    for (const order of [operations, [...operations].reverse()]) {
      f.mem.saveEntries(f.file, [{ text: 'a' }, { text: 'b' }]);
      expect(f.apply(order).entries).toEqual(['b']);
    }
  });

  it.each([
    [], Array.from({ length: 33 }, () => ({ action: 'add', content: 'x' })),
    [{ action: 'remove', old_text: 'first' }, { action: 'replace', old_text: 'missing', content: 'new' }],
    [{ action: 'remove', old_text: 'first' }, { action: 'add', content: 'private § text' }],
    [{ action: 'remove', old_text: 'first' }, { action: 'add', content: 'private\u202Etext' }],
    [{ action: 'replace', old_text: 'fir', content: 'new' }],
    [{ action: 'replace', old_text: 'first', 'Merged release agreement': '' }],
    [{ action: 'remove', old_text: 'first' }, { action: 'replace', old_text: 'first', content: 'new' }],
    [{ action: 'add', content: 'new', target: 'user' }],
    [{ action: 'add', content: 'new', old_text: 'first' }],
    [{ action: 'remove', old_text: 'first' }, { action: 'add', content: 'x'.repeat(2501) }],
    [{ action: 'list' }], null,
  ].map(operations => ({ operations })))('rejects an invalid batch without changing any stored bytes: %#', async ({ operations }) => {
    const f = await fixture(); f.mem.addEntry(f.uid, f.scope, 'first');
    const before = fs.readFileSync(f.file, 'utf8');
    expect(f.apply(operations)).toMatchObject({ ok: false });
    expect(fs.readFileSync(f.file, 'utf8')).toBe(before);
  });

  it('refuses a final overflow even after valid removals', async () => {
    const f = await fixture(); f.mem.addEntry(f.uid, f.scope, 'first');
    const before = fs.readFileSync(f.file, 'utf8');
    expect(f.apply([{ action: 'remove', old_text: 'first' }, ...Array.from({ length: 17 }, (_, i) => ({ action: 'add', content: `fact ${i}` }))]))
      .toMatchObject({ ok: false, error: expect.stringContaining('memory full:') });
    expect(fs.readFileSync(f.file, 'utf8')).toBe(before);
  });

  it('binds revisions to the account, scope and snapshot; rejects stale replay', async () => {
    const f = await fixture();
    const revision = (f.read() as any).revision;
    expect(revision).toMatch(/^[a-f0-9]{64}$/);
    const other = await fixture('user');
    expect(other.apply([{ action: 'add', content: 'wrong scope' }], revision).ok).toBe(false);
    const otherUid = f.mem.listEntries('other-owner', f.scope) as any;
    expect(f.apply([{ action: 'add', content: 'wrong account' }], otherUid.revision).ok).toBe(false);
    const operations = [{ action: 'add', content: 'retained' }];
    expect(f.apply(operations, revision).ok).toBe(true);
    expect(f.apply(operations, revision)).toMatchObject({ ok: false, error: expect.stringContaining('conflict') });
    for (const invalid of ['', undefined, 123, 'x'.repeat(64)]) {
      expect((f.mem as any).applyMemoryBatch(f.uid, f.scope, invalid, operations).ok).toBe(false);
    }
    expect(f.read().entries).toEqual(['retained']);
  });

  it('does not rewrite a no-op and leaves the revision stable', async () => {
    const f = await fixture(); f.mem.addEntry(f.uid, f.scope, 'first');
    const revision = (f.read() as any).revision;
    const write = vi.spyOn(nativeFs, 'writeFileSync'); syncBuiltinESMExports();
    expect(f.apply([{ action: 'replace', old_text: 'first', content: 'first' }], revision))
      .toMatchObject({ ok: true, changed: false, revision });
    expect(write).not.toHaveBeenCalled();
  });

  it('rechecks a Windows rename retry instead of overwriting a concurrent edit', async () => {
    const f = await fixture(); f.mem.addEntry(f.uid, f.scope, 'first');
    const originalRename = nativeFs.renameSync;
    const rename = vi.spyOn(nativeFs, 'renameSync').mockImplementationOnce(() => {
      fs.writeFileSync(f.file, 'concurrent fact');
      throw Object.assign(new Error('file locked'), { code: 'EPERM' });
    }).mockImplementation(originalRename);
    syncBuiltinESMExports();
    expect(f.apply([{ action: 'replace', old_text: 'first', content: 'replacement' }])).toMatchObject({ ok: false, error: expect.stringContaining('conflict'), entries: ['concurrent fact'] });
    expect(rename).toHaveBeenCalledTimes(1);
    expect(fs.readFileSync(f.file, 'utf8')).toBe('concurrent fact');
    expect(fs.readdirSync(path.dirname(f.file))).toEqual([path.basename(f.file)]);
  });

  it.each(['cancel', 'concurrent', 'write-error', 'rename-error', 'read-error'])(
    'preserves authoritative data and removes staging files after %s', async failure => {
      const f = await fixture(); f.mem.addEntry(f.uid, f.scope, 'first');
      const revision = (f.read() as any).revision;
      const originalWrite = nativeFs.writeFileSync;
      const originalRead = nativeFs.readFileSync;
      let allowed = true;
      if (failure === 'read-error') {
        vi.spyOn(nativeFs, 'readFileSync').mockImplementation((...args: any[]) => {
          if (String(args[0]) === f.file) throw new Error('private path error');
          return (originalRead as any)(...args);
        });
      } else if (failure === 'rename-error') {
        vi.spyOn(nativeFs, 'renameSync').mockImplementation(() => { throw new Error('private path error'); });
      } else {
        vi.spyOn(nativeFs, 'writeFileSync').mockImplementation((...args: any[]) => {
          if (String(args[0]) !== f.file) {
            if (failure === 'write-error') throw new Error('private path error');
            if (failure === 'cancel') allowed = false;
            if (failure === 'concurrent') originalWrite(f.file, 'concurrent fact');
          }
          return (originalWrite as any)(...args);
        });
      }
      syncBuiltinESMExports();
      const result = f.apply([{ action: 'remove', old_text: 'first' }, { action: 'add', content: 'replacement' }], revision, () => allowed);
      expect(result.ok).toBe(false);
      expect(result.error).not.toContain('private path');
      vi.restoreAllMocks(); syncBuiltinESMExports();
      expect(fs.readFileSync(f.file, 'utf8')).toBe(failure === 'concurrent' ? 'concurrent fact' : 'first');
      expect(fs.readdirSync(path.dirname(f.file))).toEqual([path.basename(f.file)]);
    },
  );
});
