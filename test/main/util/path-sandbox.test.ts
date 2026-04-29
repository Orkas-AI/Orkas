import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { isPathAllowed } from '../../../src/main/util/path-sandbox';

let tmpRoot: string;
let workspace: string;
let attachments: string;
let workspaceFile: string;
let attachmentFile: string;
let outsideFile: string;

beforeAll(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-sandbox-'));
  workspace = path.join(tmpRoot, 'ws');
  attachments = path.join(tmpRoot, 'attach');
  const outside = path.join(tmpRoot, 'outside');
  fs.mkdirSync(workspace, { recursive: true });
  fs.mkdirSync(attachments, { recursive: true });
  fs.mkdirSync(outside, { recursive: true });

  workspaceFile = path.join(workspace, 'doc.md');
  attachmentFile = path.join(attachments, 'a.pdf');
  outsideFile = path.join(outside, 'secret.md');
  fs.writeFileSync(workspaceFile, 'hello');
  fs.writeFileSync(attachmentFile, 'pdf bytes');
  fs.writeFileSync(outsideFile, 'secret');
});

afterAll(() => {
  try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* best-effort */ }
});

describe('path-sandbox › isPathAllowed', () => {
  it('accepts files inside a root', () => {
    expect(isPathAllowed(workspaceFile, [workspace, attachments])).toBe(true);
    expect(isPathAllowed(attachmentFile, [workspace, attachments])).toBe(true);
  });

  it('accepts the root dir itself', () => {
    expect(isPathAllowed(workspace, [workspace])).toBe(true);
  });

  it('rejects files outside all roots', () => {
    expect(isPathAllowed(outsideFile, [workspace, attachments])).toBe(false);
  });

  it('rejects ../ traversal back into a sibling dir', () => {
    const escape = path.join(workspace, '..', 'outside', 'secret.md');
    expect(isPathAllowed(escape, [workspace])).toBe(false);
  });

  it('rejects sibling prefixes (no false-positive on startsWith)', () => {
    // /tmp/.../ws vs /tmp/.../ws_other — must NOT match.
    const sibling = path.join(tmpRoot, 'ws_other');
    fs.mkdirSync(sibling, { recursive: true });
    const siblingFile = path.join(sibling, 'x.md');
    fs.writeFileSync(siblingFile, 'x');
    try { expect(isPathAllowed(siblingFile, [workspace])).toBe(false); }
    finally { fs.rmSync(sibling, { recursive: true, force: true }); }
  });

  it('resolves symlinks on both sides (block escape)', () => {
    // Plant a symlink inside workspace that points at outsideFile.
    const link = path.join(workspace, 'link-to-secret.md');
    try { fs.symlinkSync(outsideFile, link); }
    catch { return; /* platform without symlink perms — skip */ }
    try {
      // Realpath resolves to outside, so this must be rejected.
      expect(isPathAllowed(link, [workspace])).toBe(false);
    } finally {
      try { fs.unlinkSync(link); } catch { /* best-effort */ }
    }
  });

  it('rejects relative paths', () => {
    expect(isPathAllowed('relative/path.md', [workspace])).toBe(false);
  });

  it('rejects empty inputs', () => {
    expect(isPathAllowed('', [workspace])).toBe(false);
    expect(isPathAllowed(workspaceFile, [])).toBe(false);
  });

  it('treats missing candidate as lexical resolve (still honors roots)', () => {
    const ghost = path.join(workspace, 'does-not-exist.md');
    expect(isPathAllowed(ghost, [workspace])).toBe(true);
    const ghostOutside = path.join(tmpRoot, 'outside', 'never.md');
    expect(isPathAllowed(ghostOutside, [workspace])).toBe(false);
  });

  it('switching allowed roots enforces isolation between workspaces', () => {
    const wsB = path.join(tmpRoot, 'ws-b');
    fs.mkdirSync(wsB, { recursive: true });
    const fileB = path.join(wsB, 'b.md');
    fs.writeFileSync(fileB, 'b');
    try {
      // Under ws-a's scope, ws-b is invisible
      expect(isPathAllowed(fileB, [workspace, attachments])).toBe(false);
      // Under ws-b's scope, ws-a is invisible
      expect(isPathAllowed(workspaceFile, [wsB])).toBe(false);
    } finally {
      fs.rmSync(wsB, { recursive: true, force: true });
    }
  });
});
