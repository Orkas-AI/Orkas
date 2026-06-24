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

async function buildWriteTool(opts: { onFileWritten?: (p: string) => void; extraRoots?: string[] } = {}) {
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
  const write = tools.find((t) => t.name === 'write_file');
  if (!write) throw new Error('write_file tool missing');
  return { write, wsDir };
}

async function grant() {
  const perm = await import('../../../../src/main/features/permissions');
  perm.grantLocalExec();
}

async function revoke() {
  const perm = await import('../../../../src/main/features/permissions');
  perm.revokeLocalExec();
}

async function run(tool: any, input: Record<string, any>) {
  const ctx = { workingDir: '.', signal: undefined, state: {} } as any;
  return await tool.execute(input, ctx);
}

async function buildBashTool() {
  const localTools = await import('../../../../src/main/model/core-agent/local-tools');
  const tools = localTools.createLocalTools({ userId: UID });
  const bash = tools.find((t) => t.name === 'bash');
  if (!bash) throw new Error('bash tool missing');
  return bash;
}

describe('local-tools › bash › disabled skills', () => {
  it('rejects run-skill.cjs for a disabled skill id', async () => {
    await grant();
    const enabled = await import('../../../../src/main/features/component_enabled');
    enabled.setSkillEnabled(UID, 'disabled-skill', false);

    const bash = await buildBashTool();
    const r = await run(bash, {
      command: '"$ORKAS_NODE" "$ORKAS_PC_DIR/bin/run-skill.cjs" disabled-skill search -- query',
    });

    expect(r.isError).toBe(true);
    expect(r.content).toContain('E_SKILL_DISABLED');
    expect(r.content).toContain('disabled-skill');
  });

  it('rejects commands that directly enter a disabled skill directory', async () => {
    await grant();
    const enabled = await import('../../../../src/main/features/component_enabled');
    const paths = await import('../../../../src/main/paths');
    enabled.setSkillEnabled(UID, 'disabled-skill', false);

    const bash = await buildBashTool();
    const skillDir = path.join(paths.userSkillsDir(UID), 'disabled-skill');
    const r = await run(bash, {
      command: `cd "${skillDir}" && python3 scripts/search.py`,
    });

    expect(r.isError).toBe(true);
    expect(r.content).toContain('E_SKILL_DISABLED');
    expect(r.content).toContain('disabled-skill');
  });
});

describe('local-tools › edit_file › permission gate', () => {
  it('rejects when localExec not granted', async () => {
    await revoke();
    const { edit, wsDir } = await buildEditTool();
    const p = path.join(wsDir, 'a.txt');
    fs.writeFileSync(p, 'hello world');
    const r = await run(edit, { path: p, old_string: 'hello', new_string: 'hi' });
    expect(r.isError).toBe(true);
    expect(r.content).toContain('E_TOOL_EXECUTION_ACCESS_DISABLED');
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

  it('allows write_file inside extraRoots but rejects outside scope', async () => {
    await grant();
    const conflictDir = path.join(tmpDir, 'sync-conflict');
    fs.mkdirSync(conflictDir, { recursive: true });
    const target = path.join(conflictDir, 'merged.md');
    fs.writeFileSync(target, 'before');
    const outside = path.join(tmpDir, 'outside-write.txt');
    const { write } = await buildWriteTool({ extraRoots: [conflictDir] });

    const ok = await run(write, { path: target, content: 'merged' });
    expect(ok.isError).toBeFalsy();
    expect(ok.content).not.toContain('<file-renamed>');
    expect(fs.readFileSync(target, 'utf8')).toBe('merged');

    const denied = await run(write, { path: outside, content: 'nope' });
    expect(denied.isError).toBe(true);
    expect(denied.content).toContain('E_PATH_OUT_OF_SCOPE');
    expect(fs.existsSync(outside)).toBe(false);
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

// ── read-before-edit + optimistic concurrency control (G6) ────────────────
// Enforcement is gated on a run-scoped `readFileState` map the runner injects
// into ctx.state; the tests above run with `state: {}` (enforcement off), so
// they exercise the pure edit logic. Here we inject the map (mirroring the
// runner) and pin the read-before-edit + OCC behaviour.
describe('local-tools › edit_file › read-before-edit + OCC', () => {
  const READ_KEY = 'readFileState';

  // A ctx carrying the run-scoped read-state map → enforcement ON. The same
  // ctx is reused across calls in a test so the read baseline survives, exactly
  // as it does across LLM rounds in a real run.
  function runCtx(): any {
    return { workingDir: '.', signal: undefined, state: { [READ_KEY]: new Map() } };
  }

  async function buildReadTool() {
    const fileTools = await import('../../../../src/main/model/core-agent/file-tools');
    const tools = fileTools.createFileTools({ userId: UID, cid: CID });
    const read = tools.find((t) => t.name === 'read_file');
    if (!read) throw new Error('read_file tool missing');
    return read;
  }

  it('rejects an edit when the file was never read this run (E_NOT_READ)', async () => {
    await grant();
    const { edit, wsDir } = await buildEditTool();
    const p = path.join(wsDir, 'a.md');
    fs.writeFileSync(p, 'hello world');
    const r = await edit.execute({ path: p, old_string: 'hello', new_string: 'hi' }, runCtx());
    expect(r.isError).toBe(true);
    expect(r.content).toContain('E_NOT_READ');
    expect(fs.readFileSync(p, 'utf8')).toBe('hello world'); // untouched
  });

  it('allows the edit after read_file stamps the baseline, end to end', async () => {
    await grant();
    const { edit, wsDir } = await buildEditTool();
    const read = await buildReadTool();
    const p = path.join(wsDir, 'a.md');
    fs.writeFileSync(p, '# T\n\nhello world\n');
    const ctx = runCtx();
    const rr = await read.execute({ path: p }, ctx);
    expect(rr.isError).toBeFalsy();
    const r = await edit.execute({ path: p, old_string: 'hello world', new_string: 'goodbye' }, ctx);
    expect(r.isError).toBeFalsy();
    expect(fs.readFileSync(p, 'utf8')).toContain('goodbye');
  });

  it('rejects a stale edit when the file changed since the read (E_STALE)', async () => {
    await grant();
    const { edit, wsDir } = await buildEditTool();
    const read = await buildReadTool();
    const p = path.join(wsDir, 'a.md');
    fs.writeFileSync(p, 'hello world');
    const ctx = runCtx();
    await read.execute({ path: p }, ctx); // stamps baseline
    fs.writeFileSync(p, 'hello brave new world'); // another writer changes it (size differs)
    const r = await edit.execute({ path: p, old_string: 'hello', new_string: 'hi' }, ctx);
    expect(r.isError).toBe(true);
    expect(r.content).toContain('E_STALE');
  });

  it('allows a second consecutive edit without re-reading (post-edit stamp refresh)', async () => {
    await grant();
    const { edit, wsDir } = await buildEditTool();
    const read = await buildReadTool();
    const p = path.join(wsDir, 'a.md');
    fs.writeFileSync(p, 'one two three');
    const ctx = runCtx();
    await read.execute({ path: p }, ctx);
    const r1 = await edit.execute({ path: p, old_string: 'one', new_string: 'ONE' }, ctx);
    expect(r1.isError).toBeFalsy();
    const r2 = await edit.execute({ path: p, old_string: 'three', new_string: 'THREE' }, ctx);
    expect(r2.isError).toBeFalsy();
    expect(fs.readFileSync(p, 'utf8')).toBe('ONE two THREE');
  });

  it('write_file stamps, so a follow-up edit needs no intervening read', async () => {
    await grant();
    const { write, wsDir } = await buildWriteTool();
    const localTools = await import('../../../../src/main/model/core-agent/local-tools');
    const tools = localTools.createLocalTools({ userId: UID, cid: CID });
    const edit = tools.find((t) => t.name === 'edit_file')!;
    const p = path.join(wsDir, 'fresh.md');
    const ctx = runCtx();
    const w = await write.execute({ path: p, content: 'alpha beta' }, ctx);
    expect(w.isError).toBeFalsy();
    const r = await edit.execute({ path: p, old_string: 'alpha', new_string: 'ALPHA' }, ctx);
    expect(r.isError).toBeFalsy();
    expect(fs.readFileSync(p, 'utf8')).toBe('ALPHA beta');
  });

  it('serializes concurrent edits to the same file — the loser sees E_STALE, no lost update', async () => {
    await grant();
    const { edit, wsDir } = await buildEditTool();
    const p = path.join(wsDir, 'shared.md');
    const original = 'AAA and BBB';
    fs.writeFileSync(p, original);

    // Two SEPARATE runs (distinct maps) that both read the original, then race
    // to edit. The per-file lock serializes them; OCC makes the second observe
    // the first's write and bail, instead of clobbering it.
    const seed = () => {
      const ctx = runCtx();
      const st = fs.statSync(p);
      (ctx.state[READ_KEY] as Map<string, any>).set(p, { mtimeMs: st.mtimeMs, size: st.size });
      return ctx;
    };
    const [r1, r2] = await Promise.all([
      edit.execute({ path: p, old_string: 'AAA', new_string: 'aaa' }, seed()),
      edit.execute({ path: p, old_string: 'BBB', new_string: 'bbb' }, seed()),
    ]);

    const results = [r1, r2];
    const errs = results.filter((r) => r.isError);
    expect(errs.length).toBe(1);
    expect(errs[0].content).toContain('E_STALE');
    // Exactly one edit landed; the file is no longer the original and the loser's
    // change was NOT silently lost-updated over the winner's.
    const after = fs.readFileSync(p, 'utf8');
    expect(after).not.toBe(original);
    expect(after === 'aaa and BBB' || after === 'AAA and bbb').toBe(true);
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
    await revoke();
    const tool = await buildCreateArtifactTool({ onArtifactCreated: () => {} });
    expect(tool).toBeTruthy();
    const r = await run(tool, { title: 'X', files: MIN_FILES });
    expect(r.isError).toBe(true);
    expect(r.content).toContain('E_TOOL_EXECUTION_ACCESS_DISABLED');
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
