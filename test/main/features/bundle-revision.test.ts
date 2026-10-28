import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { bundleRevision } from '../../../src/main/features/web_apps/bundle-revision';
import { freezeFileMetadata } from '../../helpers/frozen-file-metadata';

let root: string, entry: string;
let restoreMetadata: (() => void) | undefined;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-bundle-revision-'));
  entry = path.join(root, 'index.html');
  fs.writeFileSync(entry, '<h1>Before</h1>');
});
afterEach(() => { restoreMetadata?.(); restoreMetadata = undefined; fs.rmSync(root, { recursive: true, force: true }); });

describe('application source revision', () => {
  it('rejects a same-length edit even when every filesystem metadata field is unchanged, and stays revoked after restoration', async () => {
    restoreMetadata = freezeFileMetadata([entry]);
    const revision = await bundleRevision(root, [entry]);
    expect(await revision.valid()).toBe(true);
    fs.writeFileSync(entry, '<h1>After!</h1>');
    expect(fs.readFileSync(entry, 'utf8')).toBe('<h1>After!</h1>');
    expect(await revision.valid()).toBe(false);
    fs.writeFileSync(entry, '<h1>Before</h1>');
    expect(await revision.valid()).toBe(false);
    expect(revision.accept(entry)).toBe(false);
  });

  it('checks a newly requested asset against its launch contents before it can be served', async () => {
    const asset = path.join(root, 'script.js');
    fs.writeFileSync(asset, 'window.value=1;');
    restoreMetadata = freezeFileMetadata([entry, asset]);
    const revision = await bundleRevision(root, [entry]);
    expect(await revision.valid()).toBe(true);
    fs.writeFileSync(asset, 'window.value=2;');
    revision.accept(asset);
    expect(await revision.valid()).toBe(false);
  });

  it('allows unchanged source and declared assets but rejects additions and deletion', async () => {
    const asset = path.join(root, 'style.css'); fs.writeFileSync(asset, 'body{}');
    const revision = await bundleRevision(root, [entry]);
    expect(revision.accept(asset)).toBe(true);
    expect(await revision.valid()).toBe(true);
    const added = path.join(root, 'late.js'); fs.writeFileSync(added, 'late');
    expect(revision.accept(added)).toBe(false);
    expect(await revision.valid()).toBe(false);
    const reopened = await bundleRevision(root, [entry]);
    fs.unlinkSync(entry);
    expect(await reopened.valid()).toBe(false);
  });

  it('binds already parsed authority bytes and does not poison an unchanged revision when a queued check is cancelled', async () => {
    restoreMetadata = freezeFileMetadata([entry]);
    fs.writeFileSync(entry, '<h1>After!</h1>');
    await expect(bundleRevision(root, [entry], new Map([[entry, Buffer.from('<h1>Before</h1>')]])))
      .rejects.toThrow('bundle changed during launch');
    const revision = await bundleRevision(root, [entry]);
    const controller = new AbortController(); controller.abort();
    expect(await revision.valid(controller.signal)).toBe(false);
    expect(await revision.valid()).toBe(true);
  });

  it('does not reuse a check that began before a later caller changed the source', async () => {
    let entered!: () => void, release!: () => void;
    const closing = new Promise<void>(resolve => { entered = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    let holdNext = false;
    restoreMetadata = freezeFileMetadata([entry], async file => {
      if (file === entry && holdNext) {
        holdNext = false; entered(); await gate;
      }
    });
    const revision = await bundleRevision(root, [entry]);
    holdNext = true;
    let first: Promise<boolean> | undefined, second: Promise<boolean> | undefined;
    try {
      first = revision.valid(); await closing;
      fs.writeFileSync(entry, '<h1>After!</h1>');
      second = revision.valid(); release();
      await first;
      expect(await second).toBe(false);
      expect(await revision.valid()).toBe(false);
    } finally { release(); await Promise.allSettled([first, second]); }
  });

  it('reads the end of a large source asynchronously without accepting unchanged metadata as content proof', async () => {
    const bytes = Buffer.alloc(8 * 1024 * 1024, 65); fs.writeFileSync(entry, bytes);
    restoreMetadata = freezeFileMetadata([entry]);
    const revision = await bundleRevision(root, [entry]);
    const file = fs.openSync(entry, 'r+');
    try { fs.writeSync(file, Buffer.from('B'), 0, 1, bytes.length - 1); }
    finally { fs.closeSync(file); }
    let yielded = false;
    const heartbeat = new Promise<void>(resolve => setImmediate(() => { yielded = true; resolve(); }));
    const valid = await revision.valid();
    expect(yielded).toBe(true);
    expect(valid).toBe(false);
    await heartbeat;
  });
});
