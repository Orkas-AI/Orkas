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

// ── create_artifact ──────────────────────────────────────────────────────
// Deep input validation lives in `chat_artifacts.test.ts`; here we pin the
// runner-side wiring: the gate, the cid+sink presence condition, the
// onArtifactCreated callback, and that backend rejections surface as isError.

async function buildCreateArtifactTool(opts: { cid?: string | null; onArtifactCreated?: (a: { id: string; title: string }) => void; agentId?: string } = {}) {
  const localTools = await import('../../../../src/main/model/core-agent/local-tools');
  const tools = localTools.createLocalTools({
    userId: UID,
    ...(opts.cid === undefined ? { cid: CID } : opts.cid ? { cid: opts.cid } : {}),
    ...(opts.agentId ? { agentId: opts.agentId } : {}),
    ...(opts.onArtifactCreated ? { onArtifactCreated: opts.onArtifactCreated } : {}),
  });
  return tools.find((t) => t.name === 'create_artifact') || null;
}

const MIN_FILES = [{ path: 'index.html', content: '<!doctype html><h1>hi</h1>' }];

describe('local-tools › create_artifact › availability', () => {
  it('is offered only when both cid and onArtifactCreated are present', async () => {
    expect(await buildCreateArtifactTool({ cid: CID, onArtifactCreated: () => {} })).toBeTruthy();
    // no sink → not offered (edit chats / ad-hoc runs)
    expect(await buildCreateArtifactTool({ cid: CID })).toBeNull();
    // no cid → not offered
    expect(await buildCreateArtifactTool({ cid: null, onArtifactCreated: () => {} })).toBeNull();
  });
});

describe('local-tools › create_artifact › permission gate', () => {
  it('rejects when localExec not granted', async () => {
    const tool = await buildCreateArtifactTool({ onArtifactCreated: () => {} });
    expect(tool).toBeTruthy();
    const r = await run(tool, { title: 'X', files: MIN_FILES });
    expect(r.isError).toBe(true);
    expect(r.content).toMatch(/Local execution is not authorised/i);
  });
});

describe('local-tools › create_artifact › success + callback', () => {
  it('writes the bundle, fires onArtifactCreated, and tells the model not to paste HTML', async () => {
    await grant();
    const created: Array<{ id: string; title: string }> = [];
    const tool = await buildCreateArtifactTool({ agentId: 'helper', onArtifactCreated: (a) => created.push(a) });
    const r = await run(tool, { title: 'Tip calc', files: MIN_FILES });
    expect(r.isError).toBeFalsy();
    expect(created.length).toBe(1);
    expect(created[0].title).toBe('Tip calc');
    expect(created[0].id).toMatch(/^[A-Za-z0-9_-]{8,}$/);
    expect(r.content).toMatch(/do NOT paste/i);
    const dir = path.join(tmpDir, UID, 'cloud', 'chat_artifacts', CID, created[0].id);
    expect(fs.readFileSync(path.join(dir, 'index.html'), 'utf8')).toContain('<h1>hi</h1>');
    expect(JSON.parse(fs.readFileSync(path.join(dir, '__orkas-meta.json'), 'utf8')).agentId).toBe('helper');
  });
});

describe('local-tools › create_artifact › backend rejection surfaces as isError', () => {
  it('missing index.html → isError, no callback', async () => {
    await grant();
    const created: unknown[] = [];
    const tool = await buildCreateArtifactTool({ onArtifactCreated: (a) => created.push(a) });
    const r = await run(tool, { files: [{ path: 'main.html', content: 'x' }] });
    expect(r.isError).toBe(true);
    expect(r.content).toMatch(/index\.html/);
    expect(created).toEqual([]);
  });
});
