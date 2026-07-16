import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { resolveContainedProtocolFile } from '../../../src/main/util/protocol-path';

let tmpDir: string;
let root: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-protocol-path-'));
  root = path.join(tmpDir, 'contexts');
  fs.mkdirSync(root);
  fs.writeFileSync(path.join(root, 'doc.md'), 'ok');
});

afterEach(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

describe('custom protocol path containment', () => {
  it('resolves only regular files below the active root', () => {
    const result = resolveContainedProtocolFile('kb-file://kb/doc.md', 'kb-file', root);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.absPath).toBe(path.join(root, 'doc.md'));

    expect(resolveContainedProtocolFile('kb-file://kb/', 'kb-file', root)).toMatchObject({
      ok: false, status: 400,
    });
    expect(resolveContainedProtocolFile('kb-file://kb/missing.md', 'kb-file', root)).toMatchObject({
      ok: false, status: 404,
    });
  });

  it('rejects lexical traversal and sibling-prefix lookalikes', () => {
    fs.mkdirSync(path.join(tmpDir, 'contexts-other'));
    fs.writeFileSync(path.join(tmpDir, 'contexts-other', 'secret.md'), 'secret');
    expect(resolveContainedProtocolFile('kb-file://kb/../contexts-other/secret.md', 'kb-file', root).ok).toBe(false);
    expect(resolveContainedProtocolFile('kb-file://kb/%2e%2e/contexts-other/secret.md', 'kb-file', root).ok).toBe(false);
  });

  it('rejects a symlink planted under the root', () => {
    const outside = path.join(tmpDir, 'secret.md');
    const link = path.join(root, 'linked.md');
    fs.writeFileSync(outside, 'secret');
    try { fs.symlinkSync(outside, link); }
    catch { return; }
    expect(resolveContainedProtocolFile('kb-file://kb/linked.md', 'kb-file', root)).toMatchObject({
      ok: false, status: 403,
    });
  });

  it('fails closed on malformed encodings and the wrong scheme', () => {
    expect(resolveContainedProtocolFile('kb-file://kb/%ZZ', 'kb-file', root)).toMatchObject({
      ok: false, status: 400,
    });
    expect(resolveContainedProtocolFile('file:///doc.md', 'kb-file', root)).toMatchObject({
      ok: false, status: 400,
    });
  });
});
