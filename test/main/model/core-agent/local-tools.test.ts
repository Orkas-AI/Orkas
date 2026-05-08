import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { makeMinimalPdf } from '../../../fixtures/make-minimal-pdf';

const UID = 'u-localtools-001';
const CID = 'conv-edit';

let tmpDir: string;
let prevWs: string | undefined;

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-localtools-'));
  prevWs = process.env.ORKAS_WORKSPACE_ROOT;
  process.env.ORKAS_WORKSPACE_ROOT = tmpDir;
  vi.resetModules();
  const users = await import('../../../../src/main/features/users');
  users.activateUser(UID);
});

afterEach(() => {
  process.env.ORKAS_WORKSPACE_ROOT = prevWs;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

async function buildEditTool(opts: { onFileWritten?: (p: string) => void; extraRoots?: string[] } = {}) {
  const localTools = await import('../../../../src/main/model/core-agent/local-tools');
  const ws = await import('../../../../src/main/features/user_workspace');
  const wsDir = path.join(tmpDir, 'ws');
  fs.mkdirSync(wsDir, { recursive: true });
  const r = ws.setWorkspacePath(UID, wsDir);
  if (!r.ok) throw new Error(`setWorkspacePath failed: ${r.error}`);
  const tools = localTools.createLocalTools({
    userId: UID,
    cid: CID,
    ...(opts.onFileWritten ? { onFileWritten: opts.onFileWritten } : {}),
    ...(opts.extraRoots ? { extraRoots: opts.extraRoots } : {}),
  });
  const edit = tools.find((t) => t.name === 'edit_file');
  if (!edit) throw new Error('edit_file tool missing');
  return { edit, wsDir };
}

async function grant() {
  const perm = await import('../../../../src/main/features/permissions');
  perm.grantLocalExec();
}

async function run(tool: any, input: Record<string, any>) {
  const ctx = { workingDir: '.', signal: undefined } as any;
  return await tool.execute(input, ctx);
}

describe('local-tools › edit_file › permission gate', () => {
  it('rejects when localExec not granted', async () => {
    const { edit, wsDir } = await buildEditTool();
    const p = path.join(wsDir, 'a.txt');
    fs.writeFileSync(p, 'hello world');
    const r = await run(edit, { path: p, old_string: 'hello', new_string: 'hi' });
    expect(r.isError).toBe(true);
    expect(r.content).toMatch(/Local execution is not authorised/i);
    // file untouched
    expect(fs.readFileSync(p, 'utf8')).toBe('hello world');
  });
});

describe('local-tools › edit_file › sandbox', () => {
  it('rejects path outside workspace + attachment + extraRoots', async () => {
    await grant();
    const { edit } = await buildEditTool();
    const outside = path.join(tmpDir, 'outside.txt');
    fs.writeFileSync(outside, 'hello');
    const r = await run(edit, { path: outside, old_string: 'hello', new_string: 'hi' });
    expect(r.isError).toBe(true);
    expect(r.content).toContain('E_PATH_OUT_OF_SCOPE');
    // file untouched
    expect(fs.readFileSync(outside, 'utf8')).toBe('hello');
  });

  it('accepts a path inside extraRoots', async () => {
    await grant();
    const skillDir = path.join(tmpDir, 'skill-x');
    fs.mkdirSync(skillDir, { recursive: true });
    const p = path.join(skillDir, 'SKILL.md');
    fs.writeFileSync(p, 'foo bar');
    const { edit } = await buildEditTool({ extraRoots: [skillDir] });
    const r = await run(edit, { path: p, old_string: 'foo', new_string: 'baz' });
    expect(r.isError).toBeFalsy();
    expect(fs.readFileSync(p, 'utf8')).toBe('baz bar');
  });
});

describe('local-tools › edit_file › input validation', () => {
  it('rejects missing path / old / new', async () => {
    await grant();
    const { edit } = await buildEditTool();
    expect((await run(edit, { old_string: 'a', new_string: 'b' })).isError).toBe(true);
    expect((await run(edit, { path: 'x', new_string: 'b' })).isError).toBe(true);
    expect((await run(edit, { path: 'x', old_string: 'a' })).isError).toBe(true);
  });

  it('rejects empty old_string', async () => {
    await grant();
    const { edit, wsDir } = await buildEditTool();
    const p = path.join(wsDir, 'a.txt');
    fs.writeFileSync(p, 'x');
    const r = await run(edit, { path: p, old_string: '', new_string: 'b' });
    expect(r.isError).toBe(true);
    expect(r.content).toContain('E_BAD_INPUT');
  });

  it('rejects no-op when old === new', async () => {
    await grant();
    const { edit, wsDir } = await buildEditTool();
    const p = path.join(wsDir, 'a.txt');
    fs.writeFileSync(p, 'foo');
    const r = await run(edit, { path: p, old_string: 'foo', new_string: 'foo' });
    expect(r.isError).toBe(true);
    expect(r.content).toContain('E_BAD_INPUT');
  });
});

describe('local-tools › edit_file › file kind / existence', () => {
  it('rejects when file does not exist (no auto-create)', async () => {
    await grant();
    const { edit, wsDir } = await buildEditTool();
    const p = path.join(wsDir, 'missing.txt');
    const r = await run(edit, { path: p, old_string: 'a', new_string: 'b' });
    expect(r.isError).toBe(true);
    expect(r.content).toContain('E_NOT_FOUND');
    expect(fs.existsSync(p)).toBe(false);
  });

  it('rejects PDF kind with E_NOT_EDITABLE', async () => {
    await grant();
    const { edit, wsDir } = await buildEditTool();
    const p = path.join(wsDir, 'doc.pdf');
    fs.writeFileSync(p, makeMinimalPdf(['some pdf text']));
    const r = await run(edit, { path: p, old_string: 'a', new_string: 'b' });
    expect(r.isError).toBe(true);
    expect(r.content).toContain('E_NOT_EDITABLE');
  });
});

describe('local-tools › edit_file › matching semantics', () => {
  it('replaces a unique occurrence and returns char-counted result tag', async () => {
    await grant();
    const { edit, wsDir } = await buildEditTool();
    const p = path.join(wsDir, 'a.md');
    fs.writeFileSync(p, '# Title\n\nhello world\n');
    const r = await run(edit, { path: p, old_string: 'hello world', new_string: 'goodbye world' });
    expect(r.isError).toBeFalsy();
    expect(r.content).toContain('edited="1"');
    expect(fs.readFileSync(p, 'utf8')).toBe('# Title\n\ngoodbye world\n');
  });

  it('rejects when old_string not found', async () => {
    await grant();
    const { edit, wsDir } = await buildEditTool();
    const p = path.join(wsDir, 'a.md');
    fs.writeFileSync(p, 'abc');
    const r = await run(edit, { path: p, old_string: 'xyz', new_string: '?' });
    expect(r.isError).toBe(true);
    expect(r.content).toContain('E_NO_MATCH');
  });

  it('rejects multiple matches when replace_all=false', async () => {
    await grant();
    const { edit, wsDir } = await buildEditTool();
    const p = path.join(wsDir, 'a.md');
    fs.writeFileSync(p, 'foo bar foo');
    const r = await run(edit, { path: p, old_string: 'foo', new_string: 'baz' });
    expect(r.isError).toBe(true);
    expect(r.content).toContain('E_MULTIPLE_MATCHES');
    // file untouched
    expect(fs.readFileSync(p, 'utf8')).toBe('foo bar foo');
  });

  it('replaces all when replace_all=true', async () => {
    await grant();
    const { edit, wsDir } = await buildEditTool();
    const p = path.join(wsDir, 'a.md');
    fs.writeFileSync(p, 'foo bar foo');
    const r = await run(edit, { path: p, old_string: 'foo', new_string: 'baz', replace_all: true });
    expect(r.isError).toBeFalsy();
    expect(r.content).toContain('edited="2"');
    expect(fs.readFileSync(p, 'utf8')).toBe('baz bar baz');
  });

  it('preserves CRLF line endings (no normalization)', async () => {
    await grant();
    const { edit, wsDir } = await buildEditTool();
    const p = path.join(wsDir, 'a.md');
    fs.writeFileSync(p, 'line1\r\nALPHA\r\nline3\r\n');
    const r = await run(edit, { path: p, old_string: 'ALPHA', new_string: 'BETA' });
    expect(r.isError).toBeFalsy();
    expect(fs.readFileSync(p, 'utf8')).toBe('line1\r\nBETA\r\nline3\r\n');
  });
});

describe('local-tools › edit_file › onFileWritten', () => {
  it('fires onFileWritten with the absolute path on success', async () => {
    await grant();
    const written: string[] = [];
    const { edit, wsDir } = await buildEditTool({ onFileWritten: (p) => written.push(p) });
    const p = path.join(wsDir, 'a.md');
    fs.writeFileSync(p, 'hello');
    const r = await run(edit, { path: p, old_string: 'hello', new_string: 'hi' });
    expect(r.isError).toBeFalsy();
    expect(written).toEqual([p]);
  });

  it('does NOT fire onFileWritten on error', async () => {
    await grant();
    const written: string[] = [];
    const { edit, wsDir } = await buildEditTool({ onFileWritten: (p) => written.push(p) });
    const p = path.join(wsDir, 'a.md');
    fs.writeFileSync(p, 'hello');
    await run(edit, { path: p, old_string: 'NOT-PRESENT', new_string: 'x' });
    expect(written).toEqual([]);
  });
});
