import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  READ_FILE_STATE_KEY,
  getReadState,
  recordRead,
  checkEditFreshness,
} from '../../../../src/main/model/core-agent/read-tracker';

let tmpDir: string;
let file: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-readtracker-'));
  file = path.join(tmpDir, 'a.txt');
  fs.writeFileSync(file, 'hello world', 'utf8');
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

/** ctx WITH a run-scoped read-state map (enforcement on). */
function ctxWithMap(): any {
  return { workingDir: tmpDir, state: { [READ_FILE_STATE_KEY]: new Map() } };
}
/** ctx WITHOUT the map (host opted out — enforcement off). */
function ctxNoMap(): any {
  return { workingDir: tmpDir, state: {} };
}

describe('read-tracker › getReadState', () => {
  it('returns the injected map, or null when absent / wrong type', () => {
    const ctx = ctxWithMap();
    expect(getReadState(ctx)).toBeInstanceOf(Map);
    expect(getReadState(ctxNoMap())).toBeNull();
    // A non-Map value under the key is treated as absent (defensive).
    expect(getReadState({ state: { [READ_FILE_STATE_KEY]: 'nope' } } as any)).toBeNull();
  });
});

describe('read-tracker › checkEditFreshness', () => {
  it('allows the edit (returns null) when no map is injected — host opted out', () => {
    const st = fs.statSync(file);
    expect(checkEditFreshness(ctxNoMap(), file, st)).toBeNull();
  });

  it('blocks with E_NOT_READ when the file was never read this run', () => {
    const ctx = ctxWithMap();
    const st = fs.statSync(file);
    const block = checkEditFreshness(ctx, file, st);
    expect(block?.code).toBe('E_NOT_READ');
  });

  it('allows the edit after a read records the baseline', () => {
    const ctx = ctxWithMap();
    recordRead(ctx, file);
    expect(checkEditFreshness(ctx, file, fs.statSync(file))).toBeNull();
  });

  it('accepts an explicit matching hash and rejects a stale hash', () => {
    const ctx = ctxWithMap();
    const st = fs.statSync(file);
    expect(checkEditFreshness(ctx, file, st, {
      expectedHash: 'sha256:current',
      currentHash: 'sha256:current',
    })).toBeNull();
    expect(checkEditFreshness(ctx, file, st, {
      expectedHash: 'sha256:old',
      currentHash: 'sha256:current',
    })?.code).toBe('E_STALE');
  });

  it('blocks with E_STALE when the file changed (size differs) since the read', () => {
    const ctx = ctxWithMap();
    recordRead(ctx, file);
    fs.writeFileSync(file, 'a much longer body than before', 'utf8'); // size changes
    const block = checkEditFreshness(ctx, file, fs.statSync(file));
    expect(block?.code).toBe('E_STALE');
  });

  it('blocks with E_STALE when only mtime changed (same size)', () => {
    const ctx = ctxWithMap();
    recordRead(ctx, file);
    const seen = getReadState(ctx)!.get(file)!;
    // Same byte length, but a later mtime — a rewrite with identical-length content.
    const later = new Date(seen.mtimeMs + 5000);
    fs.utimesSync(file, later, later);
    const block = checkEditFreshness(ctx, file, fs.statSync(file));
    expect(block?.code).toBe('E_STALE');
  });

  it('blocks when content hash changed even if filesystem metadata is unchanged', () => {
    const ctx = ctxWithMap();
    const st = fs.statSync(file);
    recordRead(ctx, file, st, 'sha256:old');
    const block = checkEditFreshness(ctx, file, st, { currentHash: 'sha256:new' });
    expect(block?.code).toBe('E_STALE');
  });
});

describe('read-tracker › recordRead', () => {
  it('stamps mtimeMs + size from the current file', () => {
    const ctx = ctxWithMap();
    recordRead(ctx, file);
    const st = fs.statSync(file);
    expect(getReadState(ctx)!.get(file)).toEqual({ mtimeMs: st.mtimeMs, size: st.size });
  });

  it('reuses a provided stat instead of re-statting', () => {
    const ctx = ctxWithMap();
    const st = fs.statSync(file);
    recordRead(ctx, file, st);
    expect(getReadState(ctx)!.get(file)).toEqual({ mtimeMs: st.mtimeMs, size: st.size });
  });

  it('stores an optional content hash with the filesystem stamp', () => {
    const ctx = ctxWithMap();
    const st = fs.statSync(file);
    recordRead(ctx, file, st, 'sha256:abc');
    expect(getReadState(ctx)!.get(file)).toEqual({ mtimeMs: st.mtimeMs, size: st.size, hash: 'sha256:abc' });
  });

  it('is a no-op when no map is injected (never throws)', () => {
    expect(() => recordRead(ctxNoMap(), file)).not.toThrow();
  });

  it('swallows a stat failure on a missing file (leaves it unstamped)', () => {
    const ctx = ctxWithMap();
    const missing = path.join(tmpDir, 'nope.txt');
    expect(() => recordRead(ctx, missing)).not.toThrow();
    expect(getReadState(ctx)!.has(missing)).toBe(false);
  });
});
