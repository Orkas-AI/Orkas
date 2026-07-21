import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

vi.mock('../../../../src/main/logger', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

import { makeMinimalPdf } from '../../../fixtures/make-minimal-pdf';

const UID = 'u-localtools-001';
const CID = 'conv-edit';

let tmpDir: string;
let prevWs: string | undefined;

describe('local-tools › Windows PowerShell compatibility preflight', () => {
  it('rejects high-confidence POSIX syntax before execution and leaves PowerShell syntax alone', async () => {
    const { windowsPowerShellCompatibilityError } = await import('../../../../src/main/model/core-agent/local-tools');
    expect(windowsPowerShellCompatibilityError('npm install && npm test', 'win32')).toContain('E_SHELL_SYNTAX_MISMATCH');
    expect(windowsPowerShellCompatibilityError('export TOKEN=x; head -n 3 a.txt > /dev/null', 'win32')).toContain('source/export');
    expect(windowsPowerShellCompatibilityError('$env:TOKEN = "x"; Get-Content a.txt | Select-Object -First 3', 'win32')).toBeNull();
    expect(windowsPowerShellCompatibilityError('npm install && npm test', 'darwin')).toBeNull();
  });

  it('blocks incompatible commands through bash and interactive_cli_start before spawning them', async () => {
    await grant();
    const localTools = await import('../../../../src/main/model/core-agent/local-tools');
    const tools = localTools.createLocalTools({ userId: UID, cid: CID, hostPlatform: 'win32' });
    const bash = tools.find((tool) => tool.name === 'bash')!;
    const interactive = tools.find((tool) => tool.name === 'interactive_cli_start')!;
    const marker = path.join(tmpDir, 'must-not-run.txt');
    const command = `node -e "require('fs').writeFileSync('${marker}', 'ran')" && echo done`;
    const ctx = { workingDir: tmpDir, signal: undefined, state: {} } as any;

    const bashResult = await bash.execute({ command }, ctx);
    const interactiveResult = await interactive.execute({ command }, ctx);

    expect(bashResult).toMatchObject({ isError: true });
    expect(interactiveResult).toMatchObject({ isError: true });
    expect(bashResult.content).toContain('E_SHELL_SYNTAX_MISMATCH');
    expect(interactiveResult.content).toContain('E_SHELL_SYNTAX_MISMATCH');
    expect(fs.existsSync(marker)).toBe(false);
  });

  it.runIf(process.platform === 'win32')('executes a real PowerShell command with inherited UTF-8 environment and a spaced cwd', async () => {
    await grant();
    const { createLocalTools } = await import('../../../../src/main/model/core-agent/local-tools');
    const bash = createLocalTools({ userId: UID }).find((tool) => tool.name === 'bash')!;
    const cwd = path.join(tmpDir, 'native cwd with spaces');
    fs.mkdirSync(cwd, { recursive: true });

    const result = await bash.execute({
      command: 'Write-Output $env:ORKAS_NATIVE_SMOKE',
      timeoutMs: 10_000,
    }, {
      workingDir: cwd,
      state: { sandboxEnv: { ORKAS_NATIVE_SMOKE: 'Windows-你好' } },
    } as any);

    expect(result.isError).toBeUndefined();
    expect(result.content.trim()).toBe('Windows-你好');
  });

  it.runIf(process.platform === 'win32')('executes an explicit cmd /c command without sending cmd syntax through PowerShell', async () => {
    await grant();
    const { createLocalTools } = await import('../../../../src/main/model/core-agent/local-tools');
    const bash = createLocalTools({ userId: UID }).find((tool) => tool.name === 'bash')!;
    const cwd = path.join(tmpDir, 'cmd cwd with spaces');
    fs.mkdirSync(cwd, { recursive: true });

    const result = await bash.execute({
      command: 'cmd /c echo %ORKAS_NATIVE_SMOKE%',
      timeoutMs: 10_000,
    }, {
      workingDir: cwd,
      state: { sandboxEnv: { ORKAS_NATIVE_SMOKE: 'cmd-ok' } },
    } as any);

    expect(result.isError).toBeUndefined();
    expect(result.content.trim()).toBe('cmd-ok');
  });

  it.runIf(process.platform === 'darwin')('executes a real POSIX command with inherited UTF-8 environment and a spaced cwd', async () => {
    await grant();
    const { createLocalTools } = await import('../../../../src/main/model/core-agent/local-tools');
    const bash = createLocalTools({ userId: UID }).find((tool) => tool.name === 'bash')!;
    const cwd = path.join(tmpDir, 'native cwd with spaces');
    fs.mkdirSync(cwd, { recursive: true });

    const result = await bash.execute({
      command: 'printf \'%s\' "$ORKAS_NATIVE_SMOKE"',
      timeoutMs: 10_000,
    }, {
      workingDir: cwd,
      state: { sandboxEnv: { ORKAS_NATIVE_SMOKE: 'macOS-你好' } },
    } as any);

    expect(result.isError).toBeUndefined();
    expect(result.content).toBe('macOS-你好');
  });
});

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

async function buildEditTool(opts: { onFileWritten?: (p: string) => void; extraRoots?: string[]; readOnlyExtraRoots?: string[] } = {}) {
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
    ...(opts.readOnlyExtraRoots ? { readOnlyExtraRoots: opts.readOnlyExtraRoots } : {}),
  });
  const edit = tools.find((t) => t.name === 'edit_file');
  if (!edit) throw new Error('edit_file tool missing');
  return { edit, wsDir };
}

async function buildWriteTool(opts: { onFileWritten?: (p: string) => void; extraRoots?: string[]; readOnlyExtraRoots?: string[] } = {}) {
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
    ...(opts.readOnlyExtraRoots ? { readOnlyExtraRoots: opts.readOnlyExtraRoots } : {}),
  });
  const write = tools.find((t) => t.name === 'write_file');
  if (!write) throw new Error('write_file tool missing');
  return { write, wsDir };
}

async function buildDeleteTool(opts: Record<string, any> = {}) {
  const localTools = await import('../../../../src/main/model/core-agent/local-tools');
  const ws = await import('../../../../src/main/features/user_workspace');
  const wsDir = path.join(tmpDir, 'ws');
  fs.mkdirSync(wsDir, { recursive: true });
  const r = ws.setWorkspacePath(UID, wsDir);
  if (!r.ok) throw new Error(`setWorkspacePath failed: ${r.error}`);
  const tools = localTools.createLocalTools({
    userId: UID,
    cid: CID,
    ...opts,
  } as any);
  const del = tools.find((t) => t.name === 'delete_file');
  if (!del) throw new Error('delete_file tool missing');
  return { del, wsDir };
}

async function grant() {
  const perm = await import('../../../../src/main/features/permissions');
  perm.grantLocalExec();
}

async function revoke() {
  const perm = await import('../../../../src/main/features/permissions');
  perm.revokeLocalExec();
}

async function workspaceOnly() {
  const perm = await import('../../../../src/main/features/permissions');
  perm.setLocalExecMode('workspace_approval');
}

async function allFilesApproval() {
  const perm = await import('../../../../src/main/features/permissions');
  perm.setLocalExecMode('all_files_approval');
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
      command: `cd "${skillDir}"${process.platform === 'win32' ? ';' : ' &&'} python3 scripts/search.py`,
    });

    expect(r.isError).toBe(true);
    expect(r.content).toContain('E_SKILL_DISABLED');
    expect(r.content).toContain('disabled-skill');
  });
});

describe('local-tools › edit_file › permission mode', () => {
  it('allows workspace edits after legacy revoke maps to workspace_approval', async () => {
    await revoke();
    const { edit, wsDir } = await buildEditTool();
    const p = path.join(wsDir, 'a.txt');
    fs.writeFileSync(p, 'hello world');
    const r = await run(edit, { path: p, old_string: 'hello', new_string: 'hi' });
    expect(r.isError).toBeFalsy();
    expect(fs.readFileSync(p, 'utf8')).toBe('hi world');
  });
});

describe('local-tools › edit_file › sandbox', () => {
  it('rejects path outside workspace + attachment + extraRoots', async () => {
    await workspaceOnly();
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
    await workspaceOnly();
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
    await workspaceOnly();
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

  it('does not allow delete_file under readOnlyExtraRoots, even in all-files mode', async () => {
    await allFilesApproval();
    const readOnlyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-ro-delete-'));
    const p = path.join(readOnlyDir, 'keep.md');
    fs.writeFileSync(p, 'do not delete');
    try {
      const { del } = await buildDeleteTool({ readOnlyExtraRoots: [readOnlyDir] });
      const r = await run(del, { path: p });
      expect(r.isError).toBe(true);
      expect(r.content).toContain('E_PROTECTED_PATH_READ_ONLY');
      expect(fs.readFileSync(p, 'utf8')).toBe('do not delete');
    } finally {
      fs.rmSync(readOnlyDir, { recursive: true, force: true });
    }
  });

  it('blocks direct local-tool mutation of marketplace installs in all-files mode', async () => {
    await allFilesApproval();
    const paths = await import('../../../../src/main/paths');
    const localTools = await import('../../../../src/main/model/core-agent/local-tools');
    const skillDir = paths.userMarketplaceSkillDir(UID, 'platform-skill');
    fs.mkdirSync(skillDir, { recursive: true });
    const skillFile = path.join(skillDir, 'SKILL.md');
    fs.writeFileSync(skillFile, 'original skill');

    const tools = localTools.createLocalTools({ userId: UID, cid: CID });
    const edit = tools.find((t) => t.name === 'edit_file');
    const write = tools.find((t) => t.name === 'write_file');
    const del = tools.find((t) => t.name === 'delete_file');
    const bash = tools.find((t) => t.name === 'bash');
    if (!edit || !write || !del || !bash) throw new Error('expected local tools missing');

    const editRes = await run(edit, { path: skillFile, old_string: 'original', new_string: 'mutated' });
    expect(editRes.isError).toBe(true);
    expect(editRes.content).toContain('E_PROTECTED_PATH_READ_ONLY');
    expect(fs.readFileSync(skillFile, 'utf8')).toBe('original skill');

    const newFile = path.join(skillDir, 'notes.md');
    const writeRes = await run(write, { path: newFile, content: 'new bytes' });
    expect(writeRes.isError).toBe(true);
    expect(writeRes.content).toContain('E_PROTECTED_PATH_READ_ONLY');
    expect(fs.existsSync(newFile)).toBe(false);

    const deleteRes = await run(del, { path: skillFile });
    expect(deleteRes.isError).toBe(true);
    expect(deleteRes.content).toContain('E_PROTECTED_PATH_READ_ONLY');
    expect(fs.existsSync(skillFile)).toBe(true);

    const bashRes = await run(bash, {
      command: process.platform === 'win32'
        ? `Set-Content -LiteralPath "${skillFile}" -Value hacked`
        : `printf hacked > "${skillFile}"`,
    });
    expect(bashRes.isError).toBe(true);
    expect(bashRes.content).toContain('E_PROTECTED_PATH_READ_ONLY');
    expect(fs.readFileSync(skillFile, 'utf8')).toBe('original skill');
  });

  it('allows provably read-only bash access to protected roots without weakening mutation guards', async () => {
    await allFilesApproval();
    const paths = await import('../../../../src/main/paths');
    const localTools = await import('../../../../src/main/model/core-agent/local-tools');
    const skillDir = paths.userMarketplaceSkillDir(UID, 'platform-read-only');
    fs.mkdirSync(skillDir, { recursive: true });
    const skillFile = path.join(skillDir, 'SKILL.md');
    fs.writeFileSync(skillFile, 'protected skill bytes');

    const bash = localTools.createLocalTools({ userId: UID, cid: CID })
      .find((tool) => tool.name === 'bash');
    if (!bash) throw new Error('bash tool missing');

    const catRes = await run(bash, {
      command: process.platform === 'win32'
        ? `Get-Content -LiteralPath "${skillFile}"`
        : `cat "${skillFile}"`,
    });
    expect(catRes.isError).toBeFalsy();
    expect(catRes.content).toContain('protected skill bytes');

    const findRes = await run(bash, {
      command: process.platform === 'win32'
        ? `Get-ChildItem -LiteralPath "${skillDir}" -File -Name`
        : `find "${skillDir}" -maxdepth 1 -type f -print`,
    });
    expect(findRes.isError).toBeFalsy();
    expect(findRes.content).toContain('SKILL.md');

    const deleteRes = await run(bash, {
      command: process.platform === 'win32'
        ? `Remove-Item -LiteralPath "${skillFile}"`
        : `find "${skillDir}" -type f -delete`,
    });
    expect(deleteRes.isError).toBe(true);
    expect(deleteRes.content).toContain('E_PROTECTED_PATH_READ_ONLY');
    expect(fs.readFileSync(skillFile, 'utf8')).toBe('protected skill bytes');

    const scriptRes = await run(bash, {
      command: `python3 -c 'print("${skillFile}")'`,
    });
    expect(scriptRes.isError).toBe(true);
    expect(scriptRes.content).toContain('E_PROTECTED_PATH_READ_ONLY');
  });
});

describe('local-tools › delete_file › confirmation scope', () => {
  it('deletes files inside the writable workspace scope without confirmation', async () => {
    await workspaceOnly();
    const { del, wsDir } = await buildDeleteTool();
    const p = path.join(wsDir, 'old-plan.json');
    fs.writeFileSync(p, '{"old":true}');

    const r = await run(del, { path: p });

    expect(r.isError).toBeFalsy();
    expect(r.content).toBe(`Deleted ${p}`);
    expect(r.content).not.toContain('confirmation_token');
    expect(fs.existsSync(p)).toBe(false);
  });

  it('keeps allowed outside-workspace deletes behind the confirmation card', async () => {
    await allFilesApproval();
    const broadcasts: Array<{ channel: string; payload: any }> = [];
    vi.doMock('../../../../src/main/ipc', () => ({
      broadcastToRenderer: (channel: string, payload: any) => {
        broadcasts.push({ channel, payload });
      },
    }));
    try {
      const { del } = await buildDeleteTool();
      const p = path.join(tmpDir, 'outside-plan.json');
      fs.writeFileSync(p, '{"outside":true}');

      const pending = run(del, { path: p });
      await vi.waitFor(() => expect(broadcasts).toHaveLength(1));
      const confirm = await import('../../../../src/main/model/core-agent/delete-file-confirm');
      expect(confirm.markConfirmationVisible(broadcasts[0].payload.confirm_id)).toBe(true);
      const r = await pending;

      expect(broadcasts[0].channel).toBe('delete_file.confirmation_required');
      expect(r.isError).toBeFalsy();
      expect(r.content).toContain('requires_user_confirmation');
      expect(r.content).toContain('confirmation_token:');
      expect(fs.readFileSync(p, 'utf8')).toBe('{"outside":true}');
    } finally {
      vi.doUnmock('../../../../src/main/ipc');
    }
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
    expect(r.content).toContain('<edit-recovery file_hash="sha256:');
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
    const hash = /file_hash="([^"]+)"/.exec(rr.content)?.[1];
    expect(hash).toMatch(/^sha256:[a-f0-9]{64}$/);
    const r = await edit.execute({ path: p, old_string: 'hello world', new_string: 'goodbye', expected_hash: hash }, ctx);
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
    expect(r.content).toContain('Retry with expected_hash=');
  });

  it('returns a current hash/context after stale expected_hash and accepts the corrected retry', async () => {
    await grant();
    const { edit, wsDir } = await buildEditTool();
    const read = await buildReadTool();
    const p = path.join(wsDir, 'a.md');
    fs.writeFileSync(p, 'alpha beta gamma');
    const ctx = runCtx();
    const rr = await read.execute({ path: p }, ctx);
    const oldHash = /file_hash="([^"]+)"/.exec(rr.content)?.[1];
    fs.writeFileSync(p, 'alpha BETA gamma');

    const stale = await edit.execute({
      path: p,
      old_string: 'beta',
      new_string: 'B',
      expected_hash: oldHash,
    }, ctx);
    expect(stale.isError).toBe(true);
    expect(stale.content).toContain('alpha BETA gamma');
    const currentHash = /file_hash="([^"]+)"/.exec(stale.content)?.[1];
    expect(currentHash).not.toBe(oldHash);

    const retry = await edit.execute({
      path: p,
      old_string: 'BETA',
      new_string: 'B',
      expected_hash: currentHash,
    }, ctx);
    expect(retry.isError).toBeFalsy();
    expect(fs.readFileSync(p, 'utf8')).toBe('alpha B gamma');
  });

  it('returns bounded current context and hash on E_NO_MATCH', async () => {
    await grant();
    const { edit, wsDir } = await buildEditTool();
    const read = await buildReadTool();
    const p = path.join(wsDir, 'a.md');
    fs.writeFileSync(p, 'current line\n' + 'x'.repeat(2_000));
    const ctx = runCtx();
    await read.execute({ path: p }, ctx);
    const result = await edit.execute({ path: p, old_string: 'missing line', new_string: 'new' }, ctx);
    expect(result.isError).toBe(true);
    expect(result.content).toContain('E_NO_MATCH');
    expect(result.content).toContain('current line');
    expect(result.content.length).toBeLessThan(1_800);
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
      const hash = `sha256:${createHash('sha256').update(original).digest('hex')}`;
      (ctx.state[READ_KEY] as Map<string, any>).set(p, { mtimeMs: st.mtimeMs, size: st.size, hash });
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

describe('local-tools › create_artifact › permission mode', () => {
  it('allows artifacts after legacy revoke maps to workspace_approval', async () => {
    await revoke();
    const tool = await buildCreateArtifactTool({ onArtifactCreated: () => {} });
    expect(tool).toBeTruthy();
    const r = await run(tool, { title: 'X', files: MIN_FILES });
    expect(r.isError).toBeFalsy();
    expect(r.content).toMatch(/do NOT paste/i);
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

describe('local-tools › direct CLI › script progress scanner', () => {
  async function scannerModule() {
    return import('../../../../src/main/model/core-agent/local-tools');
  }

  it('parses progress JSONL lines, including across chunk boundaries', async () => {
    const { createScriptProgressScanner } = await scannerModule();
    const scanner = createScriptProgressScanner();
    const first = scanner.feed('{"type":"progress","source":"video_edit","op":"trim","status":"encoding"}\n{"type":"prog');
    expect(first).toHaveLength(1);
    expect(first[0]).toMatchObject({ source: 'video_edit', op: 'trim', status: 'encoding' });
    // Second half of the split line arrives in the next chunk.
    const second = scanner.feed('ress","source":"video_analyze","op":"transcribe","status":"heartbeat"}\n');
    expect(second).toHaveLength(1);
    expect(second[0]).toMatchObject({ source: 'video_analyze', op: 'transcribe' });
  });

  it('ignores non-progress stderr content and look-alike lines', async () => {
    const { createScriptProgressScanner } = await scannerModule();
    const scanner = createScriptProgressScanner();
    const events = scanner.feed([
      'ffmpeg version 6.0 stderr noise',
      '{"ok":false,"code":"E_EDIT_FAILED","message":"boom"}',
      '{"type":"progressive","source":"look-alike"}',
      '{"type":"progress" broken json',
      '"type":"progress" not an object line',
      '{"type":"progress","source":"video_edit","status":"heartbeat"}',
      '',
    ].join('\n') + '\n');
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'progress', source: 'video_edit' });
  });

  it('formats a readable one-liner and prefers an explicit message', async () => {
    const { formatScriptProgress } = await scannerModule();
    expect(formatScriptProgress({ message: 'rendering scene 2/4' })).toBe('rendering scene 2/4');
    const line = formatScriptProgress({ source: 'video_edit', op: 'trim', status: 'encoding', percent: 42.4, out_time_sec: 12.6 });
    expect(line).toContain('video_edit');
    expect(line).toContain('trim');
    expect(line).toContain('42%');
    expect(line).toContain('t=13s');
    expect(formatScriptProgress({})).toBe('script progress');
  });
});
