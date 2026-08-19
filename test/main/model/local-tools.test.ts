import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const TEST_NODE = process.env.ORKAS_TEST_NODE || process.execPath;
const SHELL_SUCCESS_TIMEOUT_MS = process.platform === 'win32' ? 15_000 : 5_000;

function testNodeCommand(script: string): string {
  if (process.platform === 'win32') {
    const quote = (value: string) => `'${value.replace(/'/g, "''")}'`;
    return `& ${quote(TEST_NODE)} -e ${quote(script)}`;
  }
  return `${JSON.stringify(TEST_NODE)} -e ${JSON.stringify(script)}`;
}

// ── Electron mock (for html_to_pdf / markdown_to_pdf paths) ─────────────

const printToPDF = vi.fn(async () => Buffer.from('%PDF-1.4 test', 'utf8'));
const insertCSS = vi.fn(async () => 'pdf-color-css');
const loadURL = vi.fn(async () => {});
const once = vi.fn((evt: string, cb: (...args: any[]) => void) => {
  if (evt === 'did-finish-load') setImmediate(cb);
});
const destroy = vi.fn();

class FakeBrowserWindow {
  webContents = { once, printToPDF, insertCSS, loadURL };
  constructor(public opts: any) {}
  async loadURL(url: string) { return loadURL(url); }
  destroy() { destroy(); }
}

vi.mock('electron', () => ({
  BrowserWindow: FakeBrowserWindow,
}));

vi.mock('../../../src/main/logger', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

let tmpDir: string;
let prevWs: string | undefined;

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-localtools-'));
  prevWs = process.env.ORKAS_WORKSPACE_ROOT;
  process.env.ORKAS_WORKSPACE_ROOT = tmpDir;
  printToPDF.mockClear();
  insertCSS.mockClear();
  loadURL.mockClear();
  destroy.mockClear();
  vi.resetModules();
  // local-tools go through features/permissions which now routes via the
  // active user's <uid>/local/config/. Activate a deterministic test uid.
  const users = await import('../../../src/main/features/users');
  users.activateUser('u1');
});

afterEach(async () => {
  try {
    const sessions = await import('../../../src/main/model/core-agent/interactive-cli-sessions');
    sessions._resetInteractiveCliSessionsForTest();
    // Windows taskkill is asynchronous; let the shell/tree release its cwd
    // before removing the case workspace.
    if (process.platform === 'win32') await new Promise(resolve => setTimeout(resolve, 150));
  } catch { /* no interactive module in this case */ }
  process.env.ORKAS_WORKSPACE_ROOT = prevWs;
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch (err) {
    // Electron's Windows worker can retain the root-directory handle after a
    // shell-backed interactive child exits. Accept only an otherwise empty
    // tree; files, databases, or process artifacts must still fail cleanup.
    if (process.platform !== 'win32' || !fs.existsSync(tmpDir) || fs.readdirSync(tmpDir).length > 0) throw err;
  }
});

async function loadModules() {
  const lt = await import('../../../src/main/model/core-agent/local-tools');
  const perm = await import('../../../src/main/features/permissions');
  return { lt, perm };
}

async function setTmpWorkspace() {
  const ws = await import('../../../src/main/features/user_workspace');
  const res = ws.setWorkspacePath('u1', tmpDir);
  if (!res.ok) throw new Error(`setWorkspacePath failed: ${res.error}`);
}

function makeCtx(sandboxEnv: Record<string, string> = {}): any {
  // Production turns always receive buildSkillSandboxEnv(), whose bundled
  // runtime directory makes bare `node` commands resolvable. The native-host
  // test runner itself is launched by absolute path, so mirror that contract
  // explicitly instead of depending on the developer's Windows PATH.
  return {
    workingDir: tmpDir,
    state: {
      sandboxEnv: {
        ORKAS_NODE: TEST_NODE,
        ORKAS_PATH_PREPEND: path.dirname(TEST_NODE),
        ...sandboxEnv,
      },
    },
  };
}

function writeFakeCommand(dir: string, name: string, source: string): void {
  fs.mkdirSync(dir, { recursive: true });
  const scriptName = `${name}.js`;
  fs.writeFileSync(path.join(dir, scriptName), source);
  if (process.platform === 'win32') {
    fs.writeFileSync(path.join(dir, `${name}.cmd`), `@echo off\r\n"${TEST_NODE}" "%~dp0${scriptName}" %*\r\n`);
    return;
  }
  const safeNode = TEST_NODE.replace(/'/g, `'\\''`);
  const launcher = path.join(dir, name);
  fs.writeFileSync(launcher, `#!/bin/sh\nexec '${safeNode}' "$(dirname "$0")/${scriptName}" "$@"\n`);
  fs.chmodSync(launcher, 0o755);
}

// ── Tool identity ─────────────────────────────────────────────────────────

describe('local-tools › identity', () => {
  it('exposes local shell/file/pdf tools plus persistent and interactive session tools', async () => {
    const { lt } = await loadModules();
    const tools = lt.createLocalTools({});
    expect(tools.map((t) => t.name).sort()).toEqual(
      [
        'append_file',
        'apply_patch',
        'bash',
        'delete_file',
        'edit_file',
        'html_preview',
        'html_to_pdf',
        'interactive_cli_close',
        'interactive_cli_read',
        'interactive_cli_send',
        'interactive_cli_start',
        'markdown_to_pdf',
        'process_read',
        'process_start',
        'process_stop',
        'process_write',
        'write_file',
      ],
    );
  });

  it('bash tool description drops the "sandbox" wording', async () => {
    const { lt } = await loadModules();
    const bash = lt.createLocalTools({}).find((t) => t.name === 'bash')!;
    expect(bash.description.toLowerCase()).not.toContain('sandbox');
    expect(bash.description).toMatch(/local machine|host/i);
  });

  it('resolves documented POSIX, PowerShell, and cmd environment path forms', async () => {
    const { lt } = await loadModules();
    const env = { ORKAS_OUTPUT_DIR: path.join(tmpDir, 'outputs') };
    const expected = path.join(tmpDir, 'outputs', 'report.json');

    expect(lt.expandKnownShellPathVars('$ORKAS_OUTPUT_DIR/report.json', env)).toEqual({
      value: expected,
      dynamic: false,
    });
    expect(lt.expandKnownShellPathVars('$env:orkas_output_dir/report.json', env)).toEqual({
      value: expected,
      dynamic: false,
    });
    expect(lt.expandKnownShellPathVars('${env:ORKAS_OUTPUT_DIR}/report.json', env)).toEqual({
      value: expected,
      dynamic: false,
    });
    expect(lt.expandKnownShellPathVars('%ORKAS_OUTPUT_DIR%/report.json', env)).toEqual({
      value: expected,
      dynamic: false,
    });
    expect(lt.expandKnownShellPathVars('$env:UNKNOWN/report.json', env).dynamic).toBe(true);
    expect(lt.expandKnownShellPathVars('%UNKNOWN%/report.json', env).dynamic).toBe(true);
  });

  it('write_file tool description mentions the workspace directory', async () => {
    const { lt } = await loadModules();
    const wf = lt.createLocalTools({}).find((t) => t.name === 'write_file')!;
    expect(wf.description.toLowerCase()).toContain('workspace');
  });

  it('blocks unmanaged QA runtimes for the built-in studio agents only', async () => {
    const { lt } = await loadModules();
    const videoBash = lt.createLocalTools({ agentId: '79df9cc89f5f' }).find((t) => t.name === 'bash')!;
    const imageBash = lt.createLocalTools({ agentId: '814b61b027f0' }).find((t) => t.name === 'bash')!;
    const otherBash = lt.createLocalTools({ agentId: 'another-agent' }).find((t) => t.name === 'bash')!;

    const blocked = await videoBash.execute({
      command: 'python3 -m http.server 8765',
      timeoutMs: 5000,
    }, makeCtx());
    expect(blocked.isError).toBe(true);
    expect(blocked.content).toContain('E_VIDEO_STUDIO_UNMANAGED_RUNTIME_FORBIDDEN');

    const imageBlocked = await imageBash.execute({
      command: 'npx playwright test',
      timeoutMs: 5000,
    }, makeCtx());
    expect(imageBlocked.isError).toBe(true);
    expect(imageBlocked.content).toContain('E_IMAGE_STUDIO_UNMANAGED_RUNTIME_FORBIDDEN');

    const allowed = await otherBash.execute({
      command: 'echo safe',
      timeoutMs: SHELL_SUCCESS_TIMEOUT_MS,
    }, makeCtx());
    expect(allowed.isError).toBeFalsy();
  });

  it('exposes publish_outputs only when the conversation supplies a validator', async () => {
    const { lt } = await loadModules();
    expect(lt.createLocalTools({}).some((t) => t.name === 'publish_outputs')).toBe(false);
    expect(lt.createLocalTools({ onOutputsPublished: (paths) => paths })
      .some((t) => t.name === 'publish_outputs')).toBe(true);
  });
});

describe('local-tools › publish_outputs', () => {
  it('accepts an explicit empty final-deliverable list', async () => {
    const { lt } = await loadModules();
    const onOutputsPublished = vi.fn(async (paths: string[]) => paths);
    const publish = lt.createLocalTools({ onOutputsPublished })
      .find((t) => t.name === 'publish_outputs')!;

    const res = await publish.execute({ paths: [] }, makeCtx());

    expect(res.isError).toBeFalsy();
    expect(onOutputsPublished).toHaveBeenCalledWith([]);
    expect(JSON.parse(res.content)).toEqual({ published: 0, requested: 0 });
  });

  it('does not treat a malformed non-empty list as an empty declaration', async () => {
    const { lt } = await loadModules();
    const onOutputsPublished = vi.fn(async (paths: string[]) => paths);
    const publish = lt.createLocalTools({ onOutputsPublished })
      .find((t) => t.name === 'publish_outputs')!;

    const res = await publish.execute({ paths: ['  ', null] }, makeCtx());

    expect(res.isError).toBe(true);
    expect(res.content).toContain('E_BAD_INPUT');
    expect(onOutputsPublished).not.toHaveBeenCalled();
  });

  it('normalizes and deduplicates paths before publishing', async () => {
    const { lt } = await loadModules();
    const onOutputsPublished = vi.fn(async (paths: string[]) => paths);
    const publish = lt.createLocalTools({ onOutputsPublished })
      .find((t) => t.name === 'publish_outputs')!;

    const res = await publish.execute({
      paths: ['out/report.pdf', 'out/report.pdf', path.join(tmpDir, 'deck.pptx')],
    }, makeCtx());

    expect(res.isError).toBeFalsy();
    expect(onOutputsPublished).toHaveBeenCalledWith([
      path.join(tmpDir, 'out', 'report.pdf'),
      path.join(tmpDir, 'deck.pptx'),
    ]);
    expect(JSON.parse(res.content)).toEqual({ published: 2, requested: 2 });
  });

  it('rejects a declaration when the turn accepts none of its paths', async () => {
    const { lt } = await loadModules();
    const publish = lt.createLocalTools({ onOutputsPublished: () => [] })
      .find((t) => t.name === 'publish_outputs')!;

    const res = await publish.execute({ paths: ['not-produced.pdf'] }, makeCtx());

    expect(res.isError).toBe(true);
    expect(res.content).toContain('E_OUTPUT_NOT_PRODUCED');
  });
});

// ── Permission gate: bash ────────────────────────────────────────────────

describe('local-tools › bash permission gate', () => {
  it('delegates to core-agent bash after legacy revoke maps to workspace_approval (real shell runs)', async () => {
    const { lt, perm } = await loadModules();
    perm.revokeLocalExec();
    const bash = lt.createLocalTools({}).find((t) => t.name === 'bash')!;
    const res = await bash.execute(
      { command: 'echo orkas-test-sentinel-42', timeoutMs: SHELL_SUCCESS_TIMEOUT_MS },
      makeCtx(),
    );
    expect(res.isError).toBeFalsy();
    expect(res.content).toContain('orkas-test-sentinel-42');
  });

  it('localizes fixed bash errors with the current UI language', async () => {
    const { lt, perm } = await loadModules();
    const i18n = await import('../../../src/main/i18n');
    perm.grantLocalExec();
    i18n.setCurrentLang('zh');
    try {
      const bash = lt.createLocalTools({}).find((t) => t.name === 'bash')!;
      const res = await bash.execute({ command: 'exit 7', timeoutMs: SHELL_SUCCESS_TIMEOUT_MS }, makeCtx());
      expect(res.isError).toBe(true);
      expect(res.content).toBe('退出码：7');
    } finally {
      i18n.setCurrentLang('en');
    }
  });

  it('blocks auth login flows that require pasting verification codes into chat', async () => {
    const { lt, perm } = await loadModules();
    perm.grantLocalExec();
    const bash = lt.createLocalTools({}).find((t) => t.name === 'bash')!;
    const res = await bash.execute({
      command: 'gcloud auth login --no-launch-browser',
      timeoutMs: 5000,
    }, makeCtx());

    expect(res.isError).toBe(true);
    expect(res.content).toContain('E_INTERACTIVE_AUTH_CODE_UNSUPPORTED');
    expect(res.content).toContain('Do not ask the user to paste verification codes');
  });

  it('blocks synthesized Google OAuth URLs that reuse the Cloud SDK client for Workspace scopes', async () => {
    const { lt, perm } = await loadModules();
    perm.grantLocalExec();
    const bash = lt.createLocalTools({}).find((t) => t.name === 'bash')!;
    const res = await bash.execute({
      command: 'open "https://accounts.google.com/o/oauth2/auth?client_id=32555940559.apps.googleusercontent.com&scope=https%3A%2F%2Fwww.googleapis.com%2Fauth%2Fgmail.readonly"',
      timeoutMs: 5000,
    }, makeCtx());

    expect(res.isError).toBe(true);
    expect(res.content).toContain('E_GOOGLE_OAUTH_CLIENT_SCOPE_MISMATCH');
    expect(res.content).toContain('Do not synthesize Google OAuth URLs');
  });

  it('blocks running scripts that reuse the Cloud SDK client for Workspace scopes', async () => {
    const { lt, perm } = await loadModules();
    perm.grantLocalExec();
    const bash = lt.createLocalTools({}).find((t) => t.name === 'bash')!;
    const scriptPath = path.join(tmpDir, 'bad-oauth.py');
    fs.writeFileSync(
      scriptPath,
      'CLIENT_ID = "32555940559.apps.googleusercontent.com"\nSCOPES = "https://www.googleapis.com/auth/gmail.readonly"\n',
    );
    const res = await bash.execute({
      command: `python3 ${JSON.stringify(scriptPath)}`,
      timeoutMs: 5000,
    }, makeCtx());

    expect(res.isError).toBe(true);
    expect(res.content).toContain('E_GOOGLE_OAUTH_CLIENT_SCOPE_MISMATCH');
  });

  it('re-checks mode per-call (legacy revoke moves back to workspace_approval)', async () => {
    const { lt, perm } = await loadModules();
    perm.grantLocalExec();
    const bash = lt.createLocalTools({}).find((t) => t.name === 'bash')!;
    const ok = await bash.execute({
      command: 'echo first',
      timeoutMs: SHELL_SUCCESS_TIMEOUT_MS,
    }, makeCtx());
    expect(ok.isError).toBeFalsy();
    perm.revokeLocalExec();
    const stillAllowed = await bash.execute({
      command: 'echo second',
      timeoutMs: SHELL_SUCCESS_TIMEOUT_MS,
    }, makeCtx());
    expect(stillAllowed.isError).toBeFalsy();
    expect(stillAllowed.content).toContain('second');
  });
});

describe('local-tools › bash filesystem mutation scope', () => {
  it('allows explicit write targets inside the workspace', async () => {
    const { lt, perm } = await loadModules();
    perm.grantLocalExec();
    await setTmpWorkspace();
    const bash = lt.createLocalTools({ userId: 'u1', cid: 'c1' }).find((t) => t.name === 'bash')!;
    const target = path.join(tmpDir, 'bash-ok.txt');
    const res = await bash.execute({
      command: `node -e "require('fs').writeFileSync(process.argv[1], 'ok')" ${JSON.stringify(target)}`,
      timeoutMs: SHELL_SUCCESS_TIMEOUT_MS,
    }, makeCtx());
    expect(res.isError, `content=${res.content}`).toBeFalsy();
    expect(fs.readFileSync(target, 'utf8')).toBe('ok');
  });

  it('blocks explicit write targets outside the writable scope in workspace_approval mode', async () => {
    const { lt, perm } = await loadModules();
    perm.setLocalExecMode('workspace_approval');
    await setTmpWorkspace();
    const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-bash-outside-'));
    const outside = path.join(outsideDir, 'blocked.txt');
    try {
      const bash = lt.createLocalTools({ userId: 'u1', cid: 'c1', agentId: 'a1' }).find((t) => t.name === 'bash')!;
      const res = await bash.execute({
        command: `printf nope > ${JSON.stringify(outside)}`,
        timeoutMs: 5000,
      }, makeCtx());
      expect(res.isError).toBe(true);
      expect(res.content).toContain('E_BASH_PATH_OUT_OF_SCOPE');
      expect(res.content).toContain('E_PATH_OUT_OF_SCOPE');
      expect(fs.existsSync(outside)).toBe(false);
    } finally {
      fs.rmSync(outsideDir, { recursive: true, force: true });
    }
  });

  it('allows explicit write targets outside the workspace in all_files_approval mode', async () => {
    const { lt, perm } = await loadModules();
    perm.setLocalExecMode('all_files_approval');
    await setTmpWorkspace();
    const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-bash-allow-'));
    const outside = path.join(outsideDir, 'allowed.txt');
    try {
      const bash = lt.createLocalTools({ userId: 'u1', cid: 'c1', agentId: 'a1' }).find((t) => t.name === 'bash')!;
      const res = await bash.execute({
        command: `node -e "require('fs').writeFileSync(process.argv[1], 'ok')" ${JSON.stringify(outside)}`,
        timeoutMs: SHELL_SUCCESS_TIMEOUT_MS,
      }, makeCtx());
      expect(res.isError, `content=${res.content}`).toBeFalsy();
      expect(fs.readFileSync(outside, 'utf8')).toBe('ok');
    } finally {
      fs.rmSync(outsideDir, { recursive: true, force: true });
    }
  });

  it('blocks explicit read targets outside the readable scope in workspace_approval mode', async () => {
    const { lt, perm } = await loadModules();
    perm.setLocalExecMode('workspace_approval');
    await setTmpWorkspace();
    const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-bash-read-outside-'));
    const outside = path.join(outsideDir, 'secret.txt');
    fs.writeFileSync(outside, 'OUTSIDE-SECRET');
    try {
      const bash = lt.createLocalTools({ userId: 'u1', cid: 'c1', agentId: 'a1' }).find((t) => t.name === 'bash')!;
      const res = await bash.execute({
        command: `cat ${JSON.stringify(outside)}`,
        timeoutMs: 5000,
      }, makeCtx());
      expect(res.isError).toBe(true);
      expect(res.content).toContain('E_BASH_READ_PATH_OUT_OF_SCOPE');
      expect(res.content).toContain('E_PATH_OUT_OF_SCOPE');
      expect(res.content).not.toContain('OUTSIDE-SECRET');
    } finally {
      fs.rmSync(outsideDir, { recursive: true, force: true });
    }
  });

  it('allows explicit read targets outside the workspace in all_files_approval mode', async () => {
    const { lt, perm } = await loadModules();
    perm.setLocalExecMode('all_files_approval');
    await setTmpWorkspace();
    const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-bash-read-allow-'));
    const outside = path.join(outsideDir, 'note.txt');
    fs.writeFileSync(outside, 'outside read ok');
    try {
      const bash = lt.createLocalTools({ userId: 'u1', cid: 'c1', agentId: 'a1' }).find((t) => t.name === 'bash')!;
      const res = await bash.execute({
        command: `cat ${JSON.stringify(outside)}`,
        timeoutMs: SHELL_SUCCESS_TIMEOUT_MS,
      }, makeCtx());
      expect(res.isError, `content=${res.content}`).toBeFalsy();
      expect(res.content).toContain('outside read ok');
    } finally {
      fs.rmSync(outsideDir, { recursive: true, force: true });
    }
  });

  it('prompts before reading a sensitive path in all_files_approval mode and blocks on deny', async () => {
    const { lt, perm } = await loadModules();
    const bashPerms = await import('../../../src/main/model/core-agent/bash-permissions');
    perm.setLocalExecMode('all_files_approval');
    await setTmpWorkspace();
    const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-bash-read-sensitive-'));
    const outside = path.join(outsideDir, 'id_rsa');
    fs.writeFileSync(outside, 'SENSITIVE-BASH-READ');
    let payload: any = null;
    bashPerms._setBroadcastForTest((_ch: string, info: any) => {
      payload = info;
      bashPerms.respond(info.request_id, 'deny');
    });
    try {
      const bash = lt.createLocalTools({ userId: 'u1', cid: 'c1', agentId: 'a1' }).find((t) => t.name === 'bash')!;
      const res = await bash.execute({
        command: `cat ${JSON.stringify(outside)}`,
        timeoutMs: 5000,
      }, makeCtx());
      expect(res.isError).toBe(true);
      expect(res.content).toContain('E_BASH_READ_PATH_OUT_OF_SCOPE');
      expect(res.content).toContain('E_SENSITIVE_PATH_DENIED');
      expect(res.content).not.toContain('SENSITIVE-BASH-READ');
      expect(payload.operation).toBe('bash');
      expect(payload.subject).toBe(outside);
      expect(payload.reasons).toEqual(['sensitive_path']);
    } finally {
      bashPerms._setBroadcastForTest(null);
      bashPerms._resetForTest();
      fs.rmSync(outsideDir, { recursive: true, force: true });
    }
  });

  it('does not prompt twice for an allowed sensitive bash path', async () => {
    const { lt, perm } = await loadModules();
    const bashPerms = await import('../../../src/main/model/core-agent/bash-permissions');
    perm.setLocalExecMode('all_files_approval');
    await setTmpWorkspace();
    const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-bash-read-sensitive-ok-'));
    const outside = path.join(outsideDir, 'id_rsa');
    fs.writeFileSync(outside, 'SENSITIVE-BASH-ALLOW');
    let prompts = 0;
    bashPerms._setBroadcastForTest((_ch: string, info: any) => {
      prompts += 1;
      bashPerms.respond(info.request_id, 'allow_once');
    });
    try {
      const bash = lt.createLocalTools({ userId: 'u1', cid: 'c1', agentId: 'a1' }).find((t) => t.name === 'bash')!;
      const res = await bash.execute({
        command: `cat ${JSON.stringify(outside)}`,
        timeoutMs: SHELL_SUCCESS_TIMEOUT_MS,
      }, makeCtx());
      expect(res.isError, `content=${res.content}`).toBeFalsy();
      expect(res.content).toContain('SENSITIVE-BASH-ALLOW');
      expect(prompts).toBe(1);
    } finally {
      bashPerms._setBroadcastForTest(null);
      bashPerms._resetForTest();
      fs.rmSync(outsideDir, { recursive: true, force: true });
    }
  });

  it('prompts before mutating a sensitive path in all_files_approval mode', async () => {
    const { lt, perm } = await loadModules();
    const bashPerms = await import('../../../src/main/model/core-agent/bash-permissions');
    perm.setLocalExecMode('all_files_approval');
    await setTmpWorkspace();
    const readOnlyDir = fs.mkdtempSync(path.join(os.homedir(), '.ssh-test-'));
    const target = path.join(readOnlyDir, 'id_rsa');
    fs.writeFileSync(target, 'keep');
    let prompted = false;
    bashPerms._setBroadcastForTest((_ch: string, payload: any) => {
      prompted = true;
      bashPerms.respond(payload.request_id, 'deny');
    });
    try {
      const bash = lt.createLocalTools({ userId: 'u1', cid: 'c1', agentId: 'a1' }).find((t) => t.name === 'bash')!;
      const res = await bash.execute({
        command: `printf changed > ${JSON.stringify(target)}`,
        timeoutMs: 5000,
      }, makeCtx());
      expect(res.isError).toBe(true);
      expect(res.content).toContain('E_BASH_PATH_OUT_OF_SCOPE');
      expect(res.content).toContain('E_SENSITIVE_PATH_DENIED');
      expect(prompted).toBe(true);
      expect(fs.readFileSync(target, 'utf8')).toBe('keep');
    } finally {
      bashPerms._setBroadcastForTest(null);
      bashPerms._resetForTest();
      fs.rmSync(readOnlyDir, { recursive: true, force: true });
    }
  });

  it('blocks unresolved dynamic bash write targets instead of guessing their scope', async () => {
    const { lt, perm } = await loadModules();
    perm.grantLocalExec();
    await setTmpWorkspace();
    const bash = lt.createLocalTools({ userId: 'u1', cid: 'c1' }).find((t) => t.name === 'bash')!;
    const res = await bash.execute({
      command: 'printf no > "$UNKNOWN_BASH_TARGET"',
      timeoutMs: 5000,
    }, makeCtx());
    expect(res.isError).toBe(true);
    expect(res.content).toContain('E_BASH_DYNAMIC_PATH_UNSUPPORTED');
  });

  it('invalidates a prior literal when a later assignment becomes dynamic', async () => {
    const { lt, perm } = await loadModules();
    perm.grantLocalExec();
    await setTmpWorkspace();
    const bash = lt.createLocalTools({ userId: 'u1', cid: 'c1' }).find((t) => t.name === 'bash')!;
    const command = process.platform === 'win32'
      ? `$TARGET = ${JSON.stringify(path.join(tmpDir, 'safe.txt'))}; $TARGET = Join-Path $env:TEMP 'dynamic.txt'; Get-Content "$TARGET"`
      : `TARGET=${JSON.stringify(path.join(tmpDir, 'safe.txt'))}; TARGET="$UNKNOWN_BASH_TARGET"; cat "$TARGET"`;
    const res = await bash.execute({ command, timeoutMs: 5000 }, makeCtx());
    expect(res.isError).toBe(true);
    expect(res.content).toContain('E_BASH_DYNAMIC_PATH_UNSUPPORTED');

    if (process.platform !== 'win32') {
      const loopCommand = `TARGET=${JSON.stringify(path.join(tmpDir, 'safe.txt'))}; for TARGET in "$UNKNOWN_BASH_TARGET"; do true; done && cat "$TARGET"`;
      const loopRes = await bash.execute({ command: loopCommand, timeoutMs: 5000 }, makeCtx());
      expect(loopRes.isError).toBe(true);
      expect(loopRes.content).toContain('E_BASH_DYNAMIC_PATH_UNSUPPORTED');
    }
  });

  it('does not parse JavaScript inside a POSIX heredoc as shell redirections', async () => {
    if (process.platform === 'win32') return;
    const { lt, perm } = await loadModules();
    perm.grantLocalExec();
    await setTmpWorkspace();
    const bash = lt.createLocalTools({ userId: 'u1', cid: 'c1' }).find((t) => t.name === 'bash')!;
    const command = `${JSON.stringify(TEST_NODE)} <<'EOF'\nconst stem = s => s.replace(/\\.md$/, '');\nconsole.log(stem('note.md'));\nEOF`;
    const res = await bash.execute({ command, timeoutMs: SHELL_SUCCESS_TIMEOUT_MS }, makeCtx());
    expect(res.isError, `content=${res.content}`).toBeFalsy();
    expect(res.content).toContain('note');
    expect(res.content).not.toContain('E_BASH_DYNAMIC_PATH_UNSUPPORTED');
  });

  it('masks quoted, unquoted, tab-stripped, and multiple POSIX heredoc payloads', async () => {
    if (process.platform === 'win32') return;
    const { lt, perm } = await loadModules();
    perm.grantLocalExec();
    await setTmpWorkspace();
    const bash = lt.createLocalTools({ userId: 'u1', cid: 'c1' }).find((t) => t.name === 'bash')!;
    const command = "cat <<FIRST <<-'SECOND'\nconst one = s => s.replace(/\\.md$/, '');\nFIRST\n\tconst two = s => s.replace(/\\.md$/, '');\n\tSECOND";
    const res = await bash.execute({ command, timeoutMs: SHELL_SUCCESS_TIMEOUT_MS }, makeCtx());
    expect(res.isError, `content=${res.content}`).toBeFalsy();
    expect(res.content).toContain('const two');
    expect(res.content).not.toContain('E_BASH_DYNAMIC_PATH_UNSUPPORTED');
  });

  it('resolves literal path assignments completed before a later command', async () => {
    const { lt, perm } = await loadModules();
    perm.grantLocalExec();
    await setTmpWorkspace();
    const file = path.join(tmpDir, 'assigned-path.txt');
    fs.writeFileSync(file, 'literal assignment ok');
    const bash = lt.createLocalTools({ userId: 'u1', cid: 'c1' }).find((t) => t.name === 'bash')!;
    const command = process.platform === 'win32'
      ? `$ROOT = ${JSON.stringify(tmpDir)}; Get-Content -LiteralPath "$ROOT\\assigned-path.txt"`
      : `ROOT=${JSON.stringify(tmpDir)}; cat "$ROOT/assigned-path.txt"`;
    const res = await bash.execute({ command, timeoutMs: SHELL_SUCCESS_TIMEOUT_MS }, makeCtx());
    expect(res.isError, `content=${res.content}`).toBeFalsy();
    expect(res.content).toContain('literal assignment ok');
  });

  it('still blocks a literal-assigned path when its resolved target is outside scope', async () => {
    const { lt, perm } = await loadModules();
    perm.setLocalExecMode('workspace_approval');
    await setTmpWorkspace();
    const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-bash-assigned-outside-'));
    const outside = path.join(outsideDir, 'blocked.txt');
    try {
      const bash = lt.createLocalTools({ userId: 'u1', cid: 'c1' }).find((t) => t.name === 'bash')!;
      const command = process.platform === 'win32'
        ? `$TARGET = ${JSON.stringify(outside)}; Set-Content -LiteralPath "$TARGET" -Value nope`
        : `TARGET=${JSON.stringify(outside)}; printf nope > "$TARGET"`;
      const res = await bash.execute({ command, timeoutMs: 5000 }, makeCtx());
      expect(res.isError).toBe(true);
      expect(res.content).toContain('E_BASH_PATH_OUT_OF_SCOPE');
      expect(fs.existsSync(outside)).toBe(false);
    } finally {
      fs.rmSync(outsideDir, { recursive: true, force: true });
    }
  });

  it('recognizes the PowerShell null sink and known profile environment paths', async () => {
    if (process.platform !== 'win32') return;
    const { lt, perm } = await loadModules();
    perm.grantLocalExec();
    await setTmpWorkspace();
    const bash = lt.createLocalTools({ userId: 'u1', cid: 'c1' }).find((t) => t.name === 'bash')!;
    const res = await bash.execute({
      command: 'Write-Output ignored > $null; Get-ChildItem "$env:USERPROFILE" | Out-Null; Write-Output ok',
      timeoutMs: SHELL_SUCCESS_TIMEOUT_MS,
    }, makeCtx({ USERPROFILE: tmpDir }));
    expect(res.isError, `content=${res.content}`).toBeFalsy();
    expect(res.content).toContain('ok');
    expect(res.content).not.toContain('E_BASH_DYNAMIC_PATH_UNSUPPORTED');
  });

  it('resolves the Orkas output manifest before the execution wrapper injects it', async () => {
    if (process.platform === 'win32') return;
    const { lt, perm } = await loadModules();
    perm.grantLocalExec();
    await setTmpWorkspace();
    const bash = lt.createLocalTools({ userId: 'u1', cid: 'c1' }).find((t) => t.name === 'bash')!;
    const res = await bash.execute({
      command: 'printf "%s\\n" "missing-output.txt" >> "$ORKAS_OUTPUT_MANIFEST"',
      timeoutMs: SHELL_SUCCESS_TIMEOUT_MS,
    }, makeCtx());
    expect(res.isError, `content=${res.content}`).toBeFalsy();
    expect(res.content).not.toContain('E_BASH_DYNAMIC_PATH_UNSUPPORTED');
    expect(fs.existsSync(path.join(tmpDir, '.orkas-output-manifest'))).toBe(false);
  });

  it('still guards a real redirection attached to a heredoc command', async () => {
    if (process.platform === 'win32') return;
    const { lt, perm } = await loadModules();
    perm.setLocalExecMode('workspace_approval');
    await setTmpWorkspace();
    const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-bash-heredoc-outside-'));
    const outside = path.join(outsideDir, 'blocked.txt');
    try {
      const bash = lt.createLocalTools({ userId: 'u1', cid: 'c1' }).find((t) => t.name === 'bash')!;
      const command = `${JSON.stringify(TEST_NODE)} > ${JSON.stringify(outside)} <<'EOF'\nconsole.log('blocked');\nEOF`;
      const res = await bash.execute({ command, timeoutMs: 5000 }, makeCtx());
      expect(res.isError).toBe(true);
      expect(res.content).toContain('E_BASH_PATH_OUT_OF_SCOPE');
      expect(fs.existsSync(outside)).toBe(false);

      const shellPayload = `bash <<'EOF'\nprintf nope > ${JSON.stringify(outside)}\nEOF`;
      const shellRes = await bash.execute({ command: shellPayload, timeoutMs: 5000 }, makeCtx());
      expect(shellRes.isError).toBe(true);
      expect(shellRes.content).toContain('E_BASH_PATH_OUT_OF_SCOPE');
      expect(fs.existsSync(outside)).toBe(false);
    } finally {
      fs.rmSync(outsideDir, { recursive: true, force: true });
    }
  });

  it('does not confuse arithmetic shifts with heredoc openers', async () => {
    if (process.platform === 'win32') return;
    const { lt, perm } = await loadModules();
    perm.setLocalExecMode('workspace_approval');
    await setTmpWorkspace();
    const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-bash-arithmetic-outside-'));
    const outside = path.join(outsideDir, 'blocked.txt');
    try {
      const bash = lt.createLocalTools({ userId: 'u1', cid: 'c1' }).find((t) => t.name === 'bash')!;
      const command = `echo $((1 << 2))\nprintf nope > ${JSON.stringify(outside)}`;
      const res = await bash.execute({ command, timeoutMs: 5000 }, makeCtx());
      expect(res.isError).toBe(true);
      expect(res.content).toContain('E_BASH_PATH_OUT_OF_SCOPE');
      expect(fs.existsSync(outside)).toBe(false);
    } finally {
      fs.rmSync(outsideDir, { recursive: true, force: true });
    }
  });

  it('blocks interpreter-internal writes outside the writable scope on macOS', async () => {
    if (process.platform !== 'darwin' || !fs.existsSync('/usr/bin/sandbox-exec')) return;
    const { lt, perm } = await loadModules();
    perm.setLocalExecMode('workspace_approval');
    await setTmpWorkspace();
    const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-bash-internal-outside-'));
    const outside = path.join(outsideDir, 'blocked.txt');
    try {
      const bash = lt.createLocalTools({ userId: 'u1', cid: 'c1', agentId: 'a1' }).find((t) => t.name === 'bash')!;
      const script = `require('node:fs').writeFileSync(${JSON.stringify(outside)}, 'blocked')`;
      const commands = [
        testNodeCommand(script),
        `${JSON.stringify(TEST_NODE)} <<'EOF'\n${script}\nEOF`,
      ];
      for (const command of commands) {
        const res = await bash.execute({ command, timeoutMs: 5000 }, makeCtx());
        expect(res.isError).toBe(true);
        expect(fs.existsSync(outside)).toBe(false);
      }
    } finally {
      fs.rmSync(outsideDir, { recursive: true, force: true });
    }
  });
});

describe('local-tools › interactive_cli tools', () => {
  function toolByName(tools: any[], name: string): any {
    const tool = tools.find((t) => t.name === name);
    if (!tool) throw new Error(`${name} tool missing`);
    return tool;
  }

  function parseToolJson(res: any): any {
    if (res.isError) throw new Error(String(res.content || 'tool failed'));
    return JSON.parse(String(res.content || '{}'));
  }

  it('starts a live session, sends stdin, and reads child output', async () => {
    const { lt, perm } = await loadModules();
    perm.grantLocalExec();
    const tools = lt.createLocalTools({ userId: 'u1', cid: 'c1', agentId: 'a1' });
    const start = toolByName(tools, 'interactive_cli_start');
    const send = toolByName(tools, 'interactive_cli_send');
    const read = toolByName(tools, 'interactive_cli_read');
    const close = toolByName(tools, 'interactive_cli_close');
    const script = "process.stdout.write('Enter verification code: '); process.stdin.once('data', d => { process.stdout.write('got:' + d.toString().trim()); process.exit(0); });";
    const command = testNodeCommand(script);

    const startResult = await start.execute({
      command,
      max_lifetime_ms: 30000,
    }, makeCtx());
    const started = parseToolJson(startResult);
    expect(started.session_id).toMatch(/[0-9a-f-]{20,}/i);
    expect(String(started.output)).toContain('verification code');
    expect(started.prompt_kind).toBe('auth_code');
    expect(startResult.endTurn).toBe(true);

    const sent = parseToolJson(await send.execute({
      session_id: started.session_id,
      input: 'abc-123',
    }, makeCtx()));
    expect(sent.sent).toBe(true);

    let latest: any = null;
    for (let i = 0; i < 20; i++) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      latest = parseToolJson(await read.execute({ session_id: started.session_id }, makeCtx()));
      if (String(latest.output || '').includes('got:abc-123')) break;
    }
    expect(String(latest.output)).toContain('got:abc-123');
    expect(['running', 'exited']).toContain(latest.status);

    await close.execute({ session_id: started.session_id, force: true, reason: 'test cleanup' }, makeCtx());
  }, 10000);

  it('legacy revoke keeps interactive CLI available in workspace_approval mode', async () => {
    const { lt, perm } = await loadModules();
    perm.revokeLocalExec();
    const start = toolByName(lt.createLocalTools({ userId: 'u1' }), 'interactive_cli_start');
    const res = await start.execute({ command: 'echo ok' }, makeCtx());
    expect(res.isError).toBeFalsy();
  });

  it('rejects no-browser OAuth login in interactive sessions by default', async () => {
    const { lt, perm } = await loadModules();
    perm.grantLocalExec();
    const start = toolByName(lt.createLocalTools({ userId: 'u1' }), 'interactive_cli_start');

    const res = await start.execute({
      command: 'gcloud auth login --no-browser',
      purpose: 'Authorize Google access',
      max_lifetime_ms: 30000,
    }, makeCtx());

    expect(res.isError).toBe(true);
    expect(res.content).toContain('E_INTERACTIVE_AUTH_NO_BROWSER_UNSUPPORTED');
    expect(res.content).toContain('without --no-browser/--no-launch-browser');
  });

  it('surfaces an error to the agent when an interactive command exits before input', async () => {
    const { lt, perm } = await loadModules();
    perm.grantLocalExec();
    const tools = lt.createLocalTools({ userId: 'u1' });
    const start = toolByName(tools, 'interactive_cli_start');
    const read = toolByName(tools, 'interactive_cli_read');
    const script = "process.stderr.write('Missing provider auth configuration.'); process.exit(2);";
    const command = testNodeCommand(script);

    const started = JSON.parse(String((await start.execute({
      command,
      purpose: 'Configure provider access',
      max_lifetime_ms: 30000,
    }, makeCtx())).content));

    let parsed = started;
    for (let i = 0; i < 20 && parsed.status !== 'error'; i++) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      parsed = parseToolJson(await read.execute({ session_id: started.session_id }, makeCtx()));
    }
    expect(parsed.status).toBe('error');
    expect(parsed.exit_code).toBe(2);
    expect(parsed.output).toContain('Missing provider auth configuration.');
    expect(parsed.prompt_kind).toBeUndefined();
    expect(parsed.next_step).toContain('Explain');
  }, 10000);

  it('tells the agent to stop when a CLI has already opened browser authorization', async () => {
    const { lt, perm } = await loadModules();
    perm.grantLocalExec();
    const tools = lt.createLocalTools({ userId: 'u1' });
    const start = toolByName(tools, 'interactive_cli_start');
    const read = toolByName(tools, 'interactive_cli_read');
    const close = toolByName(tools, 'interactive_cli_close');
    const authUrl = 'https://accounts.google.com/o/oauth2/auth?redirect_uri=http%3A%2F%2Flocalhost%3A8085%2F&code_challenge=abc';
    const script = `process.stdout.write('Your browser has been opened to visit:\\n\\n ${authUrl}\\n'); setInterval(() => {}, 1000);`;
    const command = testNodeCommand(script);

    const startResult = await start.execute({
      command,
      purpose: 'Authorize in browser',
      max_lifetime_ms: 30000,
    }, makeCtx());
    const started = parseToolJson(startResult);

    let latest = started;
    for (let i = 0; i < 20 && latest.user_action_required !== true; i++) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      latest = parseToolJson(await read.execute({ session_id: started.session_id }, makeCtx()));
    }
    expect(latest.user_action_required).toBe(true);
    expect(latest.agent_should_stop).toBe(true);
    expect(latest.user_action_reason).toBe('browser_auth');
    expect(startResult.endTurn).toBe(true);
    expect(latest.next_step).toContain('Do not call open');
    expect(latest.next_step).toContain('do not restart or close');
    expect(latest.next_step).toContain('do not switch to another OAuth method');
    expect(latest.next_step).toContain('Stop tool use now');

    const blockedClose = await close.execute({ session_id: started.session_id }, makeCtx());
    expect(blockedClose.isError).toBe(true);
    expect(blockedClose.content).toContain('E_INTERACTIVE_CLI_WAITING_FOR_USER');

    const closed = parseToolJson(await close.execute({
      session_id: started.session_id,
      force: true,
      reason: 'test cleanup',
    }, makeCtx()));
    expect(closed.status).toBe('closed');
  }, 10000);

  it('redacts sensitive UI-provided input if a CLI echoes it', async () => {
    const mgr = await import('../../../src/main/model/core-agent/interactive-cli-sessions');
    const script = "process.stdin.once('data', d => { process.stdout.write('echo:' + d.toString().trim()); process.exit(0); });";
    const command = testNodeCommand(script);
    const started = mgr.startInteractiveCliSession({
      uid: 'u1',
      command,
      cwd: tmpDir,
      maxLifetimeMs: 30000,
    });
    try {
      mgr.sendInteractiveCliInput('u1', started.session_id, 'secret-code-42', { sensitive: true });
      let latest: any = null;
      const deadline = performance.now() + 10_000;
      while (performance.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 50));
        latest = mgr.readInteractiveCliSession('u1', started.session_id);
        if (String(latest.output || '').includes('[redacted]')) break;
      }
      expect(String(latest.output)).toContain('[redacted]');
      expect(String(latest.output)).not.toContain('secret-code-42');
    } finally {
      mgr.closeInteractiveCliSession('u1', started.session_id);
    }
  }, 15000);
});

describe('local-tools › Orkas CLI direct execution', () => {
  function writeFakePcScript(name: 'run-skill.cjs' | 'orkas-pkg.cjs', source: string): string {
    const binDir = path.join(tmpDir, 'fake-pc', 'bin');
    fs.mkdirSync(binDir, { recursive: true });
    const script = path.join(binDir, name);
    fs.writeFileSync(script, source, 'utf8');
    return path.join(tmpDir, 'fake-pc');
  }

  function makeOrkasCtx(pcDir: string): any {
    return {
      workingDir: tmpDir,
      state: {
        sandboxEnv: {
          ORKAS_NODE: TEST_NODE,
          ORKAS_PC_DIR: pcDir,
          ELECTRON_RUN_AS_NODE: '1',
        },
      },
    };
  }

  it('runs the standard run-skill.cjs command without requiring shell expansion', async () => {
    const { lt, perm } = await loadModules();
    perm.grantLocalExec();
    const pcDir = writeFakePcScript(
      'run-skill.cjs',
      "process.stdout.write(JSON.stringify({ argv: process.argv.slice(2), out: process.env.ORKAS_OUTPUT_DIR }));",
    );
    const bash = lt.createLocalTools({}).find((t) => t.name === 'bash')!;

    const res = await bash.execute({
      command: '"$ORKAS_NODE" "$ORKAS_PC_DIR/bin/run-skill.cjs" calculator eval -- 1+1',
      timeoutMs: SHELL_SUCCESS_TIMEOUT_MS,
    }, makeOrkasCtx(pcDir));

    expect(res.isError).toBeFalsy();
    const parsed = JSON.parse(String(res.content));
    expect(parsed.argv).toEqual(['calculator', 'eval', '--', '1+1']);
    expect(parsed.out).toBe(tmpDir);
  });

  it('runs the PowerShell form of a standard Orkas CLI command directly', async () => {
    const { lt, perm } = await loadModules();
    perm.grantLocalExec();
    const pcDir = writeFakePcScript(
      'run-skill.cjs',
      "process.stdout.write(JSON.stringify({ argv: process.argv.slice(2) }));",
    );
    const bash = lt.createLocalTools({}).find((t) => t.name === 'bash')!;

    const res = await bash.execute({
      command: '& "$env:ORKAS_NODE" "$env:ORKAS_PC_DIR/bin/run-skill.cjs" calculator eval -- 1+1',
      timeoutMs: SHELL_SUCCESS_TIMEOUT_MS,
    }, makeOrkasCtx(pcDir));

    expect(res.isError).toBeFalsy();
    expect(JSON.parse(String(res.content)).argv).toEqual(['calculator', 'eval', '--', '1+1']);
  });

  it('contains a synchronous direct CLI spawn failure as a non-executed command result', async () => {
    const { lt, perm } = await loadModules();
    perm.grantLocalExec();
    const pcDir = writeFakePcScript('run-skill.cjs', "process.stdout.write('must-not-run');");
    const bash = lt.createLocalTools({}).find((t) => t.name === 'bash')!;
    const context = makeOrkasCtx(pcDir);
    const invalidNodePath = `invalid\0node`;
    context.state.sandboxEnv.ORKAS_NODE = invalidNodePath;

    const res = await bash.execute({
      command: '"$ORKAS_NODE" "$ORKAS_PC_DIR/bin/run-skill.cjs" calculator eval',
      timeoutMs: SHELL_SUCCESS_TIMEOUT_MS,
    }, context);

    expect(res.isError).toBe(true);
    expect(res.content).toContain('Failed to start shell process');
    expect(res.content).toContain('The command was not executed');
    expect(res.content).not.toContain(invalidNodePath);
    expect(res.observations?.execution).toMatchObject({
      status: 'start_failed',
      exitCode: null,
      timedOut: false,
      outputLimitExceeded: false,
      stdout: { bytes: 0, truncated: false },
    });
  });

  it('streams large direct Orkas CLI stdout to the Result Store handoff file', async () => {
    const { lt, perm } = await loadModules();
    perm.grantLocalExec();
    const outputBytes = 1024 * 1024 + 257;
    const pcDir = writeFakePcScript(
      'run-skill.cjs',
      `process.stdout.write('x'.repeat(${outputBytes}));`,
    );
    const bash = lt.createLocalTools({}).find((t) => t.name === 'bash')!;
    const context = makeOrkasCtx(pcDir);
    context.state.toolResultSpoolDir = path.join(tmpDir, 'tool-results');

    const res = await bash.execute({
      command: '"$ORKAS_NODE" "$ORKAS_PC_DIR/bin/run-skill.cjs" calculator eval',
      timeoutMs: SHELL_SUCCESS_TIMEOUT_MS,
    }, context);

    expect(res.isError).toBeFalsy();
    expect(res.content).toContain('full output streamed to Result Store');
    expect(res.streamedOutput).toMatchObject({ size: outputBytes });
    expect(fs.statSync(res.streamedOutput!.path).size).toBe(outputBytes);
    expect(fs.readFileSync(res.streamedOutput!.path, 'utf8')).toBe('x'.repeat(outputBytes));
  });

  it('pipes heredoc stdin into the standard orkas-pkg.cjs command', async () => {
    const { lt, perm } = await loadModules();
    perm.grantLocalExec();
    const pcDir = writeFakePcScript(
      'orkas-pkg.cjs',
      "let body=''; process.stdin.on('data', d => body += d); process.stdin.on('end', () => process.stdout.write(JSON.stringify({ argv: process.argv.slice(2), body })));",
    );
    const bash = lt.createLocalTools({}).find((t) => t.name === 'bash')!;
    const body = "---\nname: Demo\n---\n\n# Demo";

    const res = await bash.execute({
      command: `"$ORKAS_NODE" "$ORKAS_PC_DIR/bin/orkas-pkg.cjs" skill-write demo <<'SKILL'\n${body}\nSKILL`,
      timeoutMs: SHELL_SUCCESS_TIMEOUT_MS,
    }, makeOrkasCtx(pcDir));

    expect(res.isError).toBeFalsy();
    const parsed = JSON.parse(String(res.content));
    expect(parsed.argv).toEqual(['skill-write', 'demo']);
    expect(parsed.body.replace(/\n$/, '')).toBe(body);
  });

  it('lets the host shell handle redirection for standard Orkas CLI commands', async () => {
    const { lt, perm } = await loadModules();
    perm.grantLocalExec();
    const pcDir = writeFakePcScript(
      'run-skill.cjs',
      "process.stdout.write(JSON.stringify({ argv: process.argv.slice(2) }));",
    );
    const bash = lt.createLocalTools({}).find((t) => t.name === 'bash')!;
    const outPath = path.join(tmpDir, 'run-skill-output.json');
    const errPath = path.join(tmpDir, 'run-skill-stderr.txt');

    const res = await bash.execute({
      command: process.platform === 'win32'
        ? `& "$env:ORKAS_NODE" "$env:ORKAS_PC_DIR/bin/run-skill.cjs" calculator eval -- 1+1 2> "${errPath}" > "${outPath}"`
        : `"$ORKAS_NODE" "$ORKAS_PC_DIR/bin/run-skill.cjs" calculator eval -- 1+1 2> "${errPath}" > "${outPath}"`,
      timeoutMs: SHELL_SUCCESS_TIMEOUT_MS,
    }, makeOrkasCtx(pcDir));

    expect(res.isError).toBeFalsy();
    expect(String(res.content)).toBe('');
    const redirected = fs.readFileSync(outPath, process.platform === 'win32' ? 'utf16le' : 'utf8')
      .replace(/^\uFEFF/, '');
    const parsed = JSON.parse(redirected);
    expect(parsed.argv).toEqual(['calculator', 'eval', '--', '1+1']);
    expect(fs.readFileSync(errPath, 'utf8')).toBe('');
  });

  it('times out direct Orkas CLI commands whose child keeps stdout open', async () => {
    const { lt, perm } = await loadModules();
    perm.grantLocalExec();
    const pcDir = writeFakePcScript(
      'run-skill.cjs',
      [
        "const { spawn } = require('node:child_process');",
        "spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'inherit' });",
        "console.log('parent done');",
      ].join(''),
    );
    const bash = lt.createLocalTools({}).find((t) => t.name === 'bash')!;

    const started = Date.now();
    const res = await bash.execute({
      command: '"$ORKAS_NODE" "$ORKAS_PC_DIR/bin/run-skill.cjs" calculator eval -- 1+1',
      timeoutMs: 500,
    }, makeOrkasCtx(pcDir));

    expect(res.isError).toBe(true);
    expect(String(res.content)).toMatch(/timed out|超时/i);
    expect(Date.now() - started).toBeLessThan(7000);
  }, 10000);
});

// ── End-to-end: approval modes drive the real bash tool ────────────────

describe('local-tools › bash sensitive approval modes (e2e)', () => {
  async function loadWithBashPerms() {
    const lt = await import('../../../src/main/model/core-agent/local-tools');
    const perm = await import('../../../src/main/features/permissions');
    const bashPerms = await import('../../../src/main/model/core-agent/bash-permissions');
    return { lt, perm, bashPerms };
  }
  const OPTS = { userId: 'u1', cid: 'c1', agentId: 'a1' };
  const deleteCommand = (targets: string[], recursive = false): string => (
    process.platform === 'win32'
      ? targets.map((target) => (
        `Remove-Item ${recursive ? '-Recurse ' : ''}-Force -LiteralPath ${JSON.stringify(target)}`
      )).join('; ')
      : `rm ${recursive ? '-rf' : '-f'} ${targets.map((target) => JSON.stringify(target)).join(' ')}`
  );

  it('runs a non-risky command without prompting under workspace_approval', async () => {
    const { lt, perm, bashPerms } = await loadWithBashPerms();
    perm.setLocalExecMode('workspace_approval');
    let prompted = false;
    bashPerms._setBroadcastForTest(() => { prompted = true; });
    try {
      const bash = lt.createLocalTools(OPTS).find((t) => t.name === 'bash')!;
      const res = await bash.execute({ command: 'echo safe-run-ok', timeoutMs: SHELL_SUCCESS_TIMEOUT_MS }, makeCtx());
      expect(prompted).toBe(false);
      expect(res.isError).toBeFalsy();
      expect(res.content).toContain('safe-run-ok');
    } finally { bashPerms._setBroadcastForTest(null); }
  });

  it('prompts before running a shell delete command, even for an outside temp path', async () => {
    const { lt, perm, bashPerms } = await loadWithBashPerms();
    perm.setLocalExecMode('all_files_approval');
    await setTmpWorkspace();
    const target = path.join(os.tmpdir(), `orkas-rm-prompt-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    fs.writeFileSync(target, 'keep-me');
    let prompted: any = null;
    bashPerms._setBroadcastForTest((_ch: string, info: any) => {
      prompted = info;
      bashPerms.respond(info.request_id, 'deny');
    });
    try {
      const bash = lt.createLocalTools(OPTS).find((t) => t.name === 'bash')!;
      const res = await bash.execute({ command: `rm ${JSON.stringify(target)}`, timeoutMs: 5000 }, makeCtx());
      expect(res.isError).toBe(true);
      expect(res.content).toContain('E_BASH_RISK_DENIED');
      expect(prompted?.reasons).toEqual(['destructive']);
      expect(fs.existsSync(target)).toBe(true);
    } finally {
      bashPerms._setBroadcastForTest(null);
      fs.rmSync(target, { force: true });
    }
  });

  it('prompts before terminating a user process and leaves later shell segments unexecuted on denial', async () => {
    const { lt, perm, bashPerms } = await loadWithBashPerms();
    perm.setLocalExecMode('all_files_approval');
    await setTmpWorkspace();
    const sentinel = path.join(tmpDir, 'process-termination-command-ran.txt');
    let prompted: any = null;
    bashPerms._setBroadcastForTest((_ch: string, info: any) => {
      prompted = info;
      bashPerms.respond(info.request_id, 'deny');
    });
    try {
      const bash = lt.createLocalTools(OPTS).find((t) => t.name === 'bash')!;
      const writeSentinel = `${JSON.stringify(process.execPath)} -e "require('fs').writeFileSync(process.argv[1], 'ran')" ${JSON.stringify(sentinel)}`;
      const command = `taskkill /F /IM orkas-risk-sentinel-process.exe & ${writeSentinel}`;
      const res = await bash.execute({ command, timeoutMs: 5000 }, makeCtx());
      expect(res.isError).toBe(true);
      expect(res.content).toContain('E_BASH_RISK_DENIED');
      expect(prompted?.reasons).toEqual(['destructive']);
      expect(fs.existsSync(sentinel)).toBe(false);
    } finally {
      bashPerms._setBroadcastForTest(null);
      fs.rmSync(sentinel, { force: true });
    }
  });

  it('checks the target after force flags and blocks deletion outside workspace scope', async () => {
    const { lt, perm, bashPerms } = await loadWithBashPerms();
    perm.setLocalExecMode('workspace_approval');
    await setTmpWorkspace();
    const target = path.join(os.tmpdir(), `orkas-rm-force-scope-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    fs.writeFileSync(target, 'outside workspace');
    let prompted = false;
    bashPerms._setBroadcastForTest(() => { prompted = true; });
    try {
      const bash = lt.createLocalTools(OPTS).find((tool) => tool.name === 'bash')!;
      const res = await bash.execute({ command: deleteCommand([target]), timeoutMs: 5000 }, makeCtx());
      expect(res.isError).toBe(true);
      expect(res.content).toContain('E_BASH_PATH_OUT_OF_SCOPE');
      expect(res.content).toContain('E_PATH_OUT_OF_SCOPE');
      expect(prompted).toBe(false);
      expect(fs.readFileSync(target, 'utf8')).toBe('outside workspace');
    } finally {
      bashPerms._setBroadcastForTest(null);
      fs.rmSync(target, { force: true });
    }
  });

  it('deletes a conversation-produced file without a destructive prompt', async () => {
    const { lt, perm, bashPerms } = await loadWithBashPerms();
    perm.setLocalExecMode('workspace_approval');
    await setTmpWorkspace();
    const target = path.join(tmpDir, 'generated-cleanup.txt');
    fs.writeFileSync(target, 'temporary output');
    let prompted = false;
    bashPerms._setBroadcastForTest(() => { prompted = true; });
    try {
      const bash = lt.createLocalTools({
        ...OPTS,
        hasProducedPath: (candidate) => candidate === target,
      }).find((tool) => tool.name === 'bash')!;
      const command = deleteCommand([target]);
      const res = await bash.execute({ command, timeoutMs: SHELL_SUCCESS_TIMEOUT_MS }, makeCtx());
      expect(res.isError, `content=${res.content}`).toBeFalsy();
      expect(prompted).toBe(false);
      expect(fs.existsSync(target)).toBe(false);
    } finally {
      bashPerms._setBroadcastForTest(null);
      fs.rmSync(target, { force: true });
    }
  });

  it('prompts and preserves a same-workspace file that the conversation did not produce', async () => {
    const { lt, perm, bashPerms } = await loadWithBashPerms();
    perm.setLocalExecMode('workspace_approval');
    await setTmpWorkspace();
    const target = path.join(tmpDir, 'user-owned.txt');
    fs.writeFileSync(target, 'must remain');
    let prompted: any = null;
    bashPerms._setBroadcastForTest((_channel: string, info: any) => {
      prompted = info;
      bashPerms.respond(info.request_id, 'deny');
    });
    try {
      const bash = lt.createLocalTools({
        ...OPTS,
        hasProducedPath: () => false,
      }).find((tool) => tool.name === 'bash')!;
      const res = await bash.execute({ command: deleteCommand([target]), timeoutMs: 5000 }, makeCtx());
      expect(res.isError).toBe(true);
      expect(res.content).toContain('E_BASH_RISK_DENIED');
      expect(prompted?.reasons).toEqual(['destructive']);
      expect(fs.readFileSync(target, 'utf8')).toBe('must remain');
    } finally {
      bashPerms._setBroadcastForTest(null);
      fs.rmSync(target, { force: true });
    }
  });

  it('prompts once and preserves every target when produced and foreign files are mixed', async () => {
    const { lt, perm, bashPerms } = await loadWithBashPerms();
    perm.setLocalExecMode('workspace_approval');
    await setTmpWorkspace();
    const produced = path.join(tmpDir, 'generated-mixed.txt');
    const foreign = path.join(tmpDir, 'user-mixed.txt');
    fs.writeFileSync(produced, 'generated');
    fs.writeFileSync(foreign, 'user');
    let prompts = 0;
    bashPerms._setBroadcastForTest((_channel: string, info: any) => {
      prompts += 1;
      bashPerms.respond(info.request_id, 'deny');
    });
    try {
      const bash = lt.createLocalTools({
        ...OPTS,
        hasProducedPath: (candidate) => candidate === produced,
      }).find((tool) => tool.name === 'bash')!;
      const res = await bash.execute({
        command: deleteCommand([produced, foreign]),
        timeoutMs: 5000,
      }, makeCtx());
      expect(res.isError).toBe(true);
      expect(res.content).toContain('E_BASH_RISK_DENIED');
      expect(prompts).toBe(1);
      expect(fs.readFileSync(produced, 'utf8')).toBe('generated');
      expect(fs.readFileSync(foreign, 'utf8')).toBe('user');
    } finally {
      bashPerms._setBroadcastForTest(null);
      fs.rmSync(produced, { force: true });
      fs.rmSync(foreign, { force: true });
    }
  });

  it('keeps recursive deletion of a produced path behind approval', async () => {
    const { lt, perm, bashPerms } = await loadWithBashPerms();
    perm.setLocalExecMode('workspace_approval');
    await setTmpWorkspace();
    const target = path.join(tmpDir, 'generated-recursive.txt');
    fs.writeFileSync(target, 'must survive denial');
    let prompted: any = null;
    bashPerms._setBroadcastForTest((_channel: string, info: any) => {
      prompted = info;
      bashPerms.respond(info.request_id, 'deny');
    });
    try {
      const bash = lt.createLocalTools({
        ...OPTS,
        hasProducedPath: (candidate) => candidate === target,
      }).find((tool) => tool.name === 'bash')!;
      const res = await bash.execute({
        command: deleteCommand([target], true),
        timeoutMs: 5000,
      }, makeCtx());
      expect(res.isError).toBe(true);
      expect(res.content).toContain('E_BASH_RISK_DENIED');
      expect(prompted?.reasons).toEqual(['destructive']);
      expect(fs.readFileSync(target, 'utf8')).toBe('must survive denial');
    } finally {
      bashPerms._setBroadcastForTest(null);
      fs.rmSync(target, { force: true });
    }
  });

  it('keeps sensitive-path approval even when the conversation produced the file', async () => {
    const { lt, perm, bashPerms } = await loadWithBashPerms();
    perm.setLocalExecMode('workspace_approval');
    await setTmpWorkspace();
    const target = path.join(tmpDir, 'id_rsa');
    fs.writeFileSync(target, 'sensitive generated output');
    let prompted: any = null;
    bashPerms._setBroadcastForTest((_channel: string, info: any) => {
      prompted = info;
      bashPerms.respond(info.request_id, 'deny');
    });
    try {
      const bash = lt.createLocalTools({
        ...OPTS,
        hasProducedPath: (candidate) => candidate === target,
      }).find((tool) => tool.name === 'bash')!;
      const res = await bash.execute({ command: deleteCommand([target]), timeoutMs: 5000 }, makeCtx());
      expect(res.isError).toBe(true);
      expect(res.content).toContain('E_SENSITIVE_PATH_DENIED');
      expect(prompted?.reasons).toEqual(['sensitive_path']);
      expect(fs.readFileSync(target, 'utf8')).toBe('sensitive generated output');
    } finally {
      bashPerms._setBroadcastForTest(null);
      fs.rmSync(target, { force: true });
    }
  });

  it.each([
    ['literal PowerShell cleanup', (produced: string) => (
      `Remove-Item -LiteralPath ${JSON.stringify(produced)} -Force`
    )],
    ['the production-shaped cleanup followed by output and verification', (produced: string) => (
      `cd ${JSON.stringify(tmpDir)}; Remove-Item ${JSON.stringify(produced)} -Force; `
      + `Write-Output "cleanup complete"; node -e "require('fs').existsSync(process.argv[1])" ${JSON.stringify(produced)}`
    )],
  ])('recognizes %s as owned-file-only deletion', async (_label, buildCommand) => {
    const { lt } = await loadWithBashPerms();
    const produced = path.join(tmpDir, 'generated.png');
    const owns = (candidate: string) => candidate === produced;

    expect(lt.bashDestructiveRiskIsOnlyProducedFileDeletion(
      buildCommand(produced), tmpDir, {}, owns,
    )).toBe(true);
  });

  it.each([
    ['a foreign target', (produced: string, foreign: string) => (
      `Remove-Item -LiteralPath ${JSON.stringify(foreign)} -Force`
    )],
    ['mixed produced and foreign targets', (produced: string, foreign: string) => (
      `rm -f ${JSON.stringify(produced)} ${JSON.stringify(foreign)}`
    )],
    ['recursive deletion', (produced: string) => `rm -rf ${JSON.stringify(produced)}`],
    ['a dynamic environment target', () => 'Remove-Item -Force $env:TEMP_FILE'],
    ['a wildcard target', () => 'Remove-Item -Force *.png'],
    ['pipeline-fed PowerShell deletion', () => 'Get-ChildItem *.png | Remove-Item -Force'],
  ])('rejects owned-file bypass for %s', async (_label, buildCommand) => {
    const { lt } = await loadWithBashPerms();
    const produced = path.join(tmpDir, 'generated.png');
    const foreign = path.join(tmpDir, 'user.png');
    const owns = (candidate: string) => candidate === produced;

    expect(lt.bashDestructiveRiskIsOnlyProducedFileDeletion(
      buildCommand(produced, foreign), tmpDir, {}, owns,
    )).toBe(false);
  });

  it('prompts for an opaque PowerShell command before attempting to spawn it', async () => {
    const { lt, perm, bashPerms } = await loadWithBashPerms();
    perm.setLocalExecMode('all_files_approval');
    let prompted: any = null;
    bashPerms._setBroadcastForTest((_ch: string, info: any) => {
      prompted = info;
      bashPerms.respond(info.request_id, 'deny');
    });
    try {
      const bash = lt.createLocalTools(OPTS).find((t) => t.name === 'bash')!;
      const res = await bash.execute({
        command: 'powershell -EncodedCommand UwB0AGEAcgB0AC0AUAByAG8AYwBlAHMAcwA=',
        timeoutMs: 5000,
      }, makeCtx());
      expect(res.isError).toBe(true);
      expect(res.content).toContain('E_BASH_RISK_DENIED');
      expect(prompted?.reasons).toEqual(['destructive']);
      expect(String(res.content)).not.toMatch(/ENOENT|not found|not recognized/i);
    } finally {
      bashPerms._setBroadcastForTest(null);
    }
  });

  // A risky-but-harmless command: reading a file literally named `id_rsa`
  // trips the sensitive_path category, while the underlying `cat` is allowed
  // by core-agent's own bash sandbox and its output proves whether it ran.
  const SECRET = 'SECRET-sentinel-7f3';
  function makeKeyFile(): string {
    const p = path.join(tmpDir, 'id_rsa');
    fs.writeFileSync(p, SECRET);
    return p;
  }

  it('blocks a sensitive-path command on deny and does NOT run it', async () => {
    const { lt, perm, bashPerms } = await loadWithBashPerms();
    perm.setLocalExecMode('workspace_approval');
    await setTmpWorkspace();
    const key = makeKeyFile();
    bashPerms._setBroadcastForTest((_ch: string, info: any) => { bashPerms.respond(info.request_id, 'deny'); });
    try {
      const bash = lt.createLocalTools(OPTS).find((t) => t.name === 'bash')!;
      const res = await bash.execute({ command: `cat ${key}`, timeoutMs: 5000 }, makeCtx());
      expect(res.isError).toBe(true);
      expect(res.content).toContain('E_BASH_READ_PATH_OUT_OF_SCOPE');
      expect(res.content).toContain('E_SENSITIVE_PATH_DENIED');
      expect(res.content).not.toContain(SECRET); // cat never ran
    } finally { bashPerms._setBroadcastForTest(null); }
  });

  it('runs a risky command after the user allows it (allow_once)', async () => {
    const { lt, perm, bashPerms } = await loadWithBashPerms();
    perm.setLocalExecMode('workspace_approval');
    await setTmpWorkspace();
    const key = makeKeyFile();
    let prompts = 0;
    bashPerms._setBroadcastForTest((_ch: string, info: any) => { prompts++; bashPerms.respond(info.request_id, 'allow_once'); });
    try {
      const bash = lt.createLocalTools(OPTS).find((t) => t.name === 'bash')!;
      const res = await bash.execute({ command: `cat ${key}`, timeoutMs: SHELL_SUCCESS_TIMEOUT_MS }, makeCtx());
      expect(res.isError, `content=${res.content}`).toBeFalsy();
      expect(res.content).toContain(SECRET); // cat ran
      expect(prompts).toBe(1);
    } finally { bashPerms._setBroadcastForTest(null); }
  });

  it('all_files_auto runs a risky command with no prompt at all', async () => {
    const { lt, perm, bashPerms } = await loadWithBashPerms();
    perm.setLocalExecMode('all_files_auto');
    let prompted = false;
    bashPerms._setBroadcastForTest(() => { prompted = true; });
    const key = makeKeyFile();
    try {
      const bash = lt.createLocalTools(OPTS).find((t) => t.name === 'bash')!;
      const res = await bash.execute({ command: `cat ${key}`, timeoutMs: SHELL_SUCCESS_TIMEOUT_MS }, makeCtx());
      expect(prompted).toBe(false);
      expect(res.isError, `content=${res.content}`).toBeFalsy();
      expect(res.content).toContain(SECRET);
    } finally { bashPerms._setBroadcastForTest(null); }
  });
});

describe('local-tools › bash produced files', () => {
  it('fires onFileWritten for files created in the conversation workspace', async () => {
    const { lt, perm } = await loadModules();
    perm.grantLocalExec();
    const onFileWritten = vi.fn();
    const bash = lt.createLocalTools({ agentId: 'agent-a', onFileWritten }).find((t) => t.name === 'bash')!;

    const res = await bash.execute({
      command:
        'node -e "const fs=require(\'fs\');' +
        'fs.mkdirSync(process.env.ORKAS_OUTPUT_DIR, { recursive: true });' +
        'fs.writeFileSync(process.env.ORKAS_OUTPUT_DIR + \'/report.docx\', \'doc\');' +
        'fs.writeFileSync(process.env.ORKAS_OUTPUT_DIR + \'/notes.md\', \'notes\');"',
      timeoutMs: SHELL_SUCCESS_TIMEOUT_MS,
    }, makeCtx());

    expect(res.isError).toBeFalsy();
    const produced = new Set(onFileWritten.mock.calls.map(([p]) => p));
    expect(produced).toContain(path.join(tmpDir, 'report.docx'));
    expect(produced).toContain(path.join(tmpDir, 'notes.md'));
  });

  it('fires onFileWritten for files modified in the conversation workspace', async () => {
    const { lt, perm } = await loadModules();
    perm.grantLocalExec();
    const target = path.join(tmpDir, 'draft.txt');
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, 'v1');
    const onFileWritten = vi.fn();
    const bash = lt.createLocalTools({ agentId: 'agent-a', onFileWritten }).find((t) => t.name === 'bash')!;

    const res = await bash.execute({
      command: 'node -e "require(\'fs\').writeFileSync(process.env.ORKAS_OUTPUT_DIR + \'/draft.txt\', \'v2\')"',
      timeoutMs: SHELL_SUCCESS_TIMEOUT_MS,
    }, makeCtx());

    expect(res.isError).toBeFalsy();
    expect(fs.readFileSync(target, 'utf8')).toBe('v2');
    expect(onFileWritten).toHaveBeenCalledWith(target);
  });

  it('does not surface files written outside the conversation workspace as produced chips', async () => {
    const { lt, perm } = await loadModules();
    perm.grantLocalExec();
    const onFileWritten = vi.fn();
    const bash = lt.createLocalTools({ agentId: 'agent-a', onFileWritten }).find((t) => t.name === 'bash')!;
    const outsideTarget = path.join(os.tmpdir(), `orkas-localtools-outside-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
    const outsideForSingleQuotedJs = outsideTarget.replace(/\\/g, '\\\\').replace(/'/g, "\\'");

    try {
      const res = await bash.execute({
        command:
          'node -e "const fs=require(\'fs\');' +
          `fs.writeFileSync('${outsideForSingleQuotedJs}', '{}');` +
          'fs.writeFileSync(process.env.ORKAS_OUTPUT_DIR + \'/visible.json\', \'{}\');"',
        timeoutMs: SHELL_SUCCESS_TIMEOUT_MS,
      }, makeCtx());

      expect(res.isError).toBeFalsy();
      const produced = new Set(onFileWritten.mock.calls.map(([p]) => p));
      expect(produced).toContain(path.join(tmpDir, 'visible.json'));
      expect(produced).not.toContain(outsideTarget);
    } finally {
      fs.rmSync(outsideTarget, { force: true });
    }
  });

  it('does not surface files from explicit git clone commands, but keeps generated outputs', async () => {
    const { lt, perm } = await loadModules();
    perm.grantLocalExec();
    const onFileWritten = vi.fn();
    const bash = lt.createLocalTools({ agentId: 'agent-a', onFileWritten }).find((t) => t.name === 'bash')!;
    const fakeBin = path.join(tmpDir, 'fake-git-bin');
    writeFakeCommand(fakeBin, 'git', `
const fs = require('node:fs');
fs.mkdirSync('vendor/src', { recursive: true });
fs.writeFileSync('vendor/package.json', '{}');
fs.writeFileSync('vendor/src/index.ts', 'x');
`);

    const res = await bash.execute({
      command:
        'git clone https://example.com/vendor.git\n' +
        'node -e "require(\'fs\').writeFileSync(process.env.ORKAS_OUTPUT_DIR + \'/summary.csv\', \'ok\')"',
      timeoutMs: SHELL_SUCCESS_TIMEOUT_MS,
    }, makeCtx({ PATH: `${fakeBin}${path.delimiter}${process.env.PATH || ''}` }));

    expect(res.isError, `content=${res.content}`).toBeFalsy();
    const produced = new Set(onFileWritten.mock.calls.map(([p]) => p));
    expect(produced).toContain(path.join(tmpDir, 'summary.csv'));
    expect(produced).not.toContain(path.join(tmpDir, 'vendor', 'package.json'));
    expect(produced).not.toContain(path.join(tmpDir, 'vendor', 'src', 'index.ts'));
  });

  it('does not surface explicit curl or wget downloads, but keeps generated outputs', async () => {
    const { lt, perm } = await loadModules();
    perm.grantLocalExec();
    const onFileWritten = vi.fn();
    const bash = lt.createLocalTools({ agentId: 'agent-a', onFileWritten }).find((t) => t.name === 'bash')!;
    const fakeBin = path.join(tmpDir, 'fake-bin');
    const downloadScript = `
const fs = require('node:fs');
const args = process.argv.slice(2);
const at = Math.max(args.indexOf('-o'), args.indexOf('-O'));
if (at < 0 || !args[at + 1]) process.exit(2);
fs.writeFileSync(args[at + 1], 'downloaded');
`;
    writeFakeCommand(fakeBin, 'curl', downloadScript);
    writeFakeCommand(fakeBin, 'wget', downloadScript);

    const res = await bash.execute({
      command:
        'curl -o downloaded.txt https://example.com/downloaded.txt\n' +
        'wget -O fetched.json https://example.com/fetched.json\n' +
        'node -e "require(\'fs\').writeFileSync(process.env.ORKAS_OUTPUT_DIR + \'/generated.md\', \'# ok\')"',
      timeoutMs: SHELL_SUCCESS_TIMEOUT_MS,
    }, makeCtx({ PATH: `${fakeBin}${path.delimiter}${process.env.PATH || ''}` }));

    expect(res.isError, `content=${res.content}`).toBeFalsy();
    const produced = new Set(onFileWritten.mock.calls.map(([p]) => p));
    expect(produced).toContain(path.join(tmpDir, 'generated.md'));
    expect(produced).not.toContain(path.join(tmpDir, 'downloaded.txt'));
    expect(produced).not.toContain(path.join(tmpDir, 'fetched.json'));
  });

  it('tracks explicitly manifested outputs even inside a scan-skipped directory', async () => {
    const { lt, perm } = await loadModules();
    perm.grantLocalExec();
    const onFileWritten = vi.fn();
    const bash = lt.createLocalTools({ agentId: 'agent-a', onFileWritten })
      .find((t) => t.name === 'bash')!;

    const res = await bash.execute({
      command:
        'node -e "const fs=require(\'fs\');' +
        'fs.mkdirSync(\'.cache\',{recursive:true});' +
        'fs.writeFileSync(\'.cache/final.pdf\',\'pdf\');' +
        'fs.appendFileSync(process.env.ORKAS_OUTPUT_MANIFEST,\'.cache/final.pdf\\n\')"',
      timeoutMs: SHELL_SUCCESS_TIMEOUT_MS,
    }, makeCtx());

    expect(res.isError, `content=${res.content}`).toBeFalsy();
    expect(onFileWritten).toHaveBeenCalledWith(path.join(tmpDir, '.cache', 'final.pdf'));
    expect(fs.existsSync(path.join(tmpDir, '.orkas-output-manifest'))).toBe(false);
  });
});

// ── Permission gate + onFileWritten: write_file ──────────────────────────

describe('local-tools › write_file', () => {
  it('refuses and does NOT create the file when no workspace scope is available', async () => {
    const { lt, perm } = await loadModules();
    perm.revokeLocalExec();
    const onFileWritten = vi.fn();
    const wf = lt.createLocalTools({ onFileWritten }).find((t) => t.name === 'write_file')!;
    const target = 'should-not-exist.txt';
    const res = await wf.execute({ path: target, content: 'x' }, makeCtx());
    expect(res.isError).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, target))).toBe(false);
    expect(onFileWritten).not.toHaveBeenCalled();
  });

  it('creates the file and fires onFileWritten with the absolute path when granted', async () => {
    const { lt, perm } = await loadModules();
    perm.grantLocalExec();
    await setTmpWorkspace();
    const onFileWritten = vi.fn();
    const wf = lt.createLocalTools({ userId: 'u1', onFileWritten }).find((t) => t.name === 'write_file')!;
    const res = await wf.execute({ path: 'out/note.txt', content: 'hello' }, makeCtx());
    expect(res.isError).toBeFalsy();
    const abs = path.join(tmpDir, 'out', 'note.txt');
    expect(fs.existsSync(abs)).toBe(true);
    expect(fs.readFileSync(abs, 'utf8')).toBe('hello');
    expect(onFileWritten).toHaveBeenCalledTimes(1);
    expect(onFileWritten).toHaveBeenCalledWith(abs);
  });

  it('persists one complete large UTF-8 payload without applying the output-retry budget to storage', async () => {
    const { lt, perm } = await loadModules();
    perm.grantLocalExec();
    await setTmpWorkspace();
    const onFileWritten = vi.fn();
    const write = lt.createLocalTools({ userId: 'u1', onFileWritten })
      .find((tool) => tool.name === 'write_file')!;
    const contentSchema = (write.inputSchema.properties as Record<string, any>).content;
    const body = `<!doctype html>\n${'登录·🙂'.repeat(5_000)}`;
    const target = path.join(tmpDir, 'out', 'complete-large.html');

    expect(body.length).toBeGreaterThan(12_000);
    expect(contentSchema.maxLength).toBeUndefined();
    const result = await write.execute({ path: target, content: body }, makeCtx());

    const expectedBytes = Buffer.byteLength(body, 'utf8');
    const expectedHash = createHash('sha256').update(Buffer.from(body, 'utf8')).digest('hex');
    expect(result.isError).toBeFalsy();
    expect(result.content).toContain(`total_bytes="${expectedBytes}"`);
    expect(result.content).toContain(`file_hash="sha256:${expectedHash}"`);
    expect(result.content).toMatch(/revision="file_rev_[A-Za-z0-9_-]{16}"/);
    expect(result.content.length).toBeLessThan(body.length);
    expect(result.content).not.toContain(body.slice(0, 256));
    expect(fs.readFileSync(target, 'utf8')).toBe(body);
    expect(onFileWritten).toHaveBeenCalledTimes(1);
  });

  it('rejects write_file when no uid or explicit writable roots define a scope', async () => {
    const { lt, perm } = await loadModules();
    perm.setLocalExecMode('workspace_approval');
    const wf = lt.createLocalTools({}).find((t) => t.name === 'write_file')!;
    const res = await wf.execute({ path: 'out/no-scope.txt', content: 'x' }, makeCtx());
    expect(res.isError).toBe(true);
    expect(res.content).toContain('E_NO_SCOPE');
    expect(fs.existsSync(path.join(tmpDir, 'out', 'no-scope.txt'))).toBe(false);
  });

  it('refuses scripts that reuse the Cloud SDK OAuth client for Workspace scopes', async () => {
    const { lt, perm } = await loadModules();
    perm.grantLocalExec();
    const onFileWritten = vi.fn();
    const wf = lt.createLocalTools({ onFileWritten }).find((t) => t.name === 'write_file')!;
    const res = await wf.execute({
      path: 'bad-oauth.py',
      content: 'CLIENT_ID = "32555940559.apps.googleusercontent.com"\nSCOPES = "https://www.googleapis.com/auth/drive.readonly"\n',
    }, makeCtx());

    expect(res.isError).toBe(true);
    expect(res.content).toContain('E_GOOGLE_OAUTH_CLIENT_SCOPE_MISMATCH');
    expect(fs.existsSync(path.join(tmpDir, 'bad-oauth.py'))).toBe(false);
    expect(onFileWritten).not.toHaveBeenCalled();
  });

  it('does NOT fire onFileWritten when the underlying write fails', async () => {
    const { lt, perm } = await loadModules();
    perm.grantLocalExec();
    await setTmpWorkspace();
    const onFileWritten = vi.fn();
    const wf = lt.createLocalTools({ userId: 'u1', onFileWritten }).find((t) => t.name === 'write_file')!;
    // Writing to a path whose parent is a regular file forces mkdir to fail.
    const blocker = path.join(tmpDir, 'blocker');
    fs.writeFileSync(blocker, 'file not dir');
    const res = await wf.execute({ path: 'blocker/child.txt', content: 'x' }, makeCtx());
    expect(res.isError).toBe(true);
    expect(onFileWritten).not.toHaveBeenCalled();
  });

  it('writes to the model-given path verbatim when no collision exists', async () => {
    const { lt, perm } = await loadModules();
    perm.grantLocalExec();
    await setTmpWorkspace();
    const onFileWritten = vi.fn();
    const wf = lt.createLocalTools({ userId: 'u1', onFileWritten })
      .find((t) => t.name === 'write_file')!;
    const target = path.join(tmpDir, 'note.md');
    const res = await wf.execute({ path: target, content: 'hi' }, makeCtx());
    expect(res.isError).toBeFalsy();
    expect(fs.existsSync(target)).toBe(true);
    expect(res.content).not.toContain('<file-renamed>');
    expect(onFileWritten).toHaveBeenCalledWith(target);
  });

  it('uniquifies basename and emits <file-renamed> when target exists and is not ours', async () => {
    const { lt, perm } = await loadModules();
    perm.grantLocalExec();
    await setTmpWorkspace();
    const target = path.join(tmpDir, 'note.md');
    fs.writeFileSync(target, 'foreign');
    const onFileWritten = vi.fn();
    const wf = lt.createLocalTools({ userId: 'u1', onFileWritten })
      .find((t) => t.name === 'write_file')!;
    const res = await wf.execute({ path: target, content: 'mine' }, makeCtx());
    expect(res.isError).toBeFalsy();
    const renamed = path.join(tmpDir, 'note-2.md');
    expect(fs.existsSync(renamed)).toBe(true);
    expect(fs.readFileSync(renamed, 'utf8')).toBe('mine');
    expect(fs.readFileSync(target, 'utf8')).toBe('foreign'); // original untouched
    expect(res.content).toContain('<file-renamed>');
    expect(res.content).toContain('You requested: note.md');
    expect(res.content).toContain('Saved as:      note-2.md');
    expect(onFileWritten).toHaveBeenCalledWith(renamed);
  });

  it('overwrites in place (no rename) when hasProducedPath claims the target', async () => {
    const { lt, perm } = await loadModules();
    perm.grantLocalExec();
    await setTmpWorkspace();
    const target = path.join(tmpDir, 'draft.md');
    fs.writeFileSync(target, 'v1');
    const produced = new Set<string>([target]);
    const onFileWritten = vi.fn((p: string) => { produced.add(p); });
    const wf = lt.createLocalTools({
      userId: 'u1',
      onFileWritten,
      hasProducedPath: (p) => produced.has(p),
    }).find((t) => t.name === 'write_file')!;
    const res = await wf.execute({ path: target, content: 'v2' }, makeCtx());
    expect(res.isError).toBeFalsy();
    expect(fs.readFileSync(target, 'utf8')).toBe('v2'); // overwritten, no -2
    expect(fs.existsSync(path.join(tmpDir, 'draft-2.md'))).toBe(false);
    expect(res.content).not.toContain('<file-renamed>');
    expect(onFileWritten).toHaveBeenCalledWith(target);
  });
});

describe('local-tools › append_file', () => {
  it('carries a read_file revision across the model round that must separate the two calls', async () => {
    // 2026-08-11 research-resume-durable-ledger: the agent read fetch_ledger.jsonl
    // and evidence_ledger.jsonl, quoted the revisions the host had issued for
    // them, and every append came back E_REVISION_UNKNOWN — four times, then the
    // no-progress nudge. The tokens were genuine; the store was not.
    // AgentRunner rebuilds ToolContext.state after every model round, and the
    // model cannot form an append until it has seen the read result, so the two
    // calls never share a round. Keeping the revisions on `state` made this
    // handoff impossible in production while passing a test that reused one
    // context — which is exactly what the previous regression here did.
    const { lt, perm } = await loadModules();
    const ft = await import('../../../src/main/model/core-agent/file-tools');
    perm.grantLocalExec();
    await setTmpWorkspace();
    const tools = lt.createLocalTools({ userId: 'u1' });
    const append = tools.find((tool) => tool.name === 'append_file')!;
    const read = ft.createFileTools({ userId: 'u1', cid: 'c1' }).find((t) => t.name === 'read_file')!;

    // The runner injects this one map by reference into every round's state.
    const runScopedLedger = new Map<string, unknown>();
    const round = () => {
      const ctx = makeCtx();
      ctx.state.runScopedLedger = runScopedLedger;
      return ctx;
    };

    const absolutePath = path.join(tmpDir, 'fetch_ledger.jsonl');
    fs.writeFileSync(absolutePath, '{"kind":"fetch","n":1}\n', 'utf8');

    const readBack = await read.execute({ path: absolutePath }, round());
    const revision = /revision="(file_rev_[A-Za-z0-9_-]{16})"/.exec(readBack.content)?.[1];
    expect(revision, 'read_file must hand back a revision').toBeTruthy();

    // A different round object, as production always gives it.
    const appended = await append.execute({
      path: 'fetch_ledger.jsonl',
      content: '{"kind":"fetch","n":2}\n',
      base_revision: revision,
    }, round());
    expect(appended.isError, appended.content).toBeFalsy();
    expect(fs.readFileSync(absolutePath, 'utf8'))
      .toBe('{"kind":"fetch","n":1}\n{"kind":"fetch","n":2}\n');

    // The refusal's own revision must survive the next round too: that is the
    // recovery path the message tells the caller to take.
    const other = path.join(tmpDir, 'evidence_ledger.jsonl');
    fs.writeFileSync(other, 'x\n', 'utf8');
    const refused = await append.execute({
      path: 'evidence_ledger.jsonl',
      content: 'y\n',
      base_revision: 'file_rev_neverIssuedAAAA',
    }, round());
    expect(refused.isError).toBe(true);
    expect(refused.content).toContain('E_REVISION_UNKNOWN');
    const offered = /revision="(file_rev_[A-Za-z0-9_-]{16})"/.exec(refused.content)?.[1];
    expect(offered).toBeTruthy();
    const retried = await append.execute({
      path: 'evidence_ledger.jsonl',
      content: 'y\n',
      base_revision: offered,
    }, round());
    expect(retried.isError, retried.content).toBeFalsy();
    expect(fs.readFileSync(other, 'utf8')).toBe('x\ny\n');

    // A token from one run must not resolve in another.
    const foreign = await append.execute({
      path: 'evidence_ledger.jsonl',
      content: 'z\n',
      base_revision: revision,
    }, makeCtx());
    expect(foreign.isError).toBe(true);
    expect(foreign.content).toContain('E_REVISION_UNKNOWN');
  });

  it('rejects empty content or a missing concurrency baseline without changing the file', async () => {
    const { lt, perm } = await loadModules();
    perm.grantLocalExec();
    await setTmpWorkspace();
    const onFileWritten = vi.fn();
    const tools = lt.createLocalTools({ userId: 'u1', onFileWritten });
    const write = tools.find((tool) => tool.name === 'write_file')!;
    const append = tools.find((tool) => tool.name === 'append_file')!;
    const relativePath = 'out/invalid-append.txt';
    const absolutePath = path.join(tmpDir, relativePath);
    const ctx = makeCtx();
    const initial = await write.execute({ path: relativePath, content: 'kept' }, ctx);
    const revision = /revision="(file_rev_[A-Za-z0-9_-]{16})"/.exec(initial.content)?.[1];
    expect(revision).toBeTruthy();

    const empty = await append.execute({
      path: relativePath,
      content: '',
      base_revision: revision,
    }, ctx);
    expect(empty.isError).toBe(true);
    expect(empty.content).toContain('E_BAD_INPUT');

    const missingBaseline = await append.execute({
      path: relativePath,
      content: 'must not be appended',
    }, ctx);
    expect(missingBaseline.isError).toBe(true);
    expect(missingBaseline.content).toContain('E_BAD_INPUT');
    expect(fs.readFileSync(absolutePath, 'utf8')).toBe('kept');
    expect(onFileWritten).toHaveBeenCalledTimes(1);
  });

  it('appends exact UTF-8 bytes once, accepts an identical replay, and rejects a stale different chunk', async () => {
    const { lt, perm } = await loadModules();
    perm.grantLocalExec();
    await setTmpWorkspace();
    const produced = new Set<string>();
    const onFileWritten = vi.fn((p: string) => { produced.add(p); });
    const tools = lt.createLocalTools({
      userId: 'u1',
      onFileWritten,
      hasProducedPath: (p) => produced.has(p),
    });
    const write = tools.find((t) => t.name === 'write_file')!;
    const append = tools.find((t) => t.name === 'append_file')!;
    const abs = path.join(tmpDir, 'out', 'large.md');
    const first = 'alpha\n';
    const next = '第二块\n';

    const written = await write.execute({ path: 'out/large.md', content: first }, makeCtx());
    expect(written.isError).toBeFalsy();
    const sizeMatch = written.content.match(/total_bytes="(\d+)"/);
    expect(sizeMatch).not.toBeNull();
    const expectedSize = Number(sizeMatch?.[1]);
    const appended = await append.execute({
      path: 'out/large.md',
      content: next,
      expected_size: expectedSize,
    }, makeCtx());
    expect(appended.isError).toBeFalsy();
    expect(appended.content).toContain('replayed="false"');
    expect(appended.content).toContain(`total_bytes="${Buffer.byteLength(first + next, 'utf8')}"`);

    const replayed = await append.execute({
      path: 'out/large.md',
      content: next,
      expected_size: expectedSize,
    }, makeCtx());
    expect(replayed.isError).toBeFalsy();
    expect(replayed.content).toContain('replayed="true"');
    expect(fs.readFileSync(abs, 'utf8')).toBe(first + next);

    const stale = await append.execute({
      path: 'out/large.md',
      content: 'different',
      expected_size: expectedSize,
    }, makeCtx());
    expect(stale.isError).toBe(true);
    expect(stale.content).toContain('E_STALE');
    expect(fs.readFileSync(abs, 'utf8')).toBe(first + next);
    expect(onFileWritten).toHaveBeenCalledTimes(2);
  });

  it('uses opaque revisions across read/write/append for multibyte text, replays safely, and returns a fresh revision after an external change', async () => {
    const { lt, perm } = await loadModules();
    const fileTools = await import('../../../src/main/model/core-agent/file-tools');
    perm.grantLocalExec();
    await setTmpWorkspace();
    const produced = new Set<string>();
    const onFileWritten = vi.fn((p: string) => { produced.add(p); });
    const tools = lt.createLocalTools({
      userId: 'u1',
      onFileWritten,
      hasProducedPath: (p) => produced.has(p),
    });
    const write = tools.find((tool) => tool.name === 'write_file')!;
    const append = tools.find((tool) => tool.name === 'append_file')!;
    const read = fileTools.createFileTools({ userId: 'u1' })
      .find((tool) => tool.name === 'read_file')!;
    const ctx = makeCtx();
    const relativePath = 'out/revision-handoff.txt';
    const absolutePath = path.join(tmpDir, relativePath);
    const firstChunk = '登录与注册\n';
    const secondChunk = '找回密码🙂\n';

    const written = await write.execute({ path: relativePath, content: firstChunk }, ctx);
    expect(written.isError).toBeFalsy();
    const writtenRevision = /revision="(file_rev_[A-Za-z0-9_-]{16})"/.exec(written.content)?.[1];
    expect(writtenRevision).toBeTruthy();

    const inspected = await read.execute({ path: relativePath }, ctx);
    expect(inspected.isError).toBeFalsy();
    expect(inspected.content).toContain(`revision="${writtenRevision}"`);
    expect(inspected.content).toContain(`total_chars="${firstChunk.length}"`);

    const appended = await append.execute({
      path: relativePath,
      content: secondChunk,
      base_revision: writtenRevision,
      // Deliberately repeat the case bug: this is a UTF-16 character count,
      // not the UTF-8 byte size. The opaque revision must be authoritative.
      expected_size: firstChunk.length,
    }, ctx);
    expect(appended.isError).toBeFalsy();
    expect(appended.content).toContain('replayed="false"');
    const appendedRevision = /revision="(file_rev_[A-Za-z0-9_-]{16})"/.exec(appended.content)?.[1];
    expect(appendedRevision).toBeTruthy();
    expect(appendedRevision).not.toBe(writtenRevision);
    expect(fs.readFileSync(absolutePath, 'utf8')).toBe(firstChunk + secondChunk);

    const replayed = await append.execute({
      path: relativePath,
      content: secondChunk,
      base_revision: writtenRevision,
    }, ctx);
    expect(replayed.isError).toBeFalsy();
    expect(replayed.content).toContain('replayed="true"');
    expect(replayed.content).toContain(`revision="${appendedRevision}"`);
    expect(fs.readFileSync(absolutePath, 'utf8')).toBe(firstChunk + secondChunk);

    fs.appendFileSync(absolutePath, '外部修改\n', 'utf8');
    const beforeRejectedAppend = fs.readFileSync(absolutePath, 'utf8');
    const stale = await append.execute({
      path: relativePath,
      content: '不应写入\n',
      base_revision: appendedRevision,
    }, ctx);
    expect(stale.isError).toBe(true);
    expect(stale.content).toContain('E_STALE');
    const currentRevision = /revision="(file_rev_[A-Za-z0-9_-]{16})"/.exec(stale.content)?.[1];
    expect(currentRevision).toBeTruthy();
    expect(currentRevision).not.toBe(appendedRevision);
    expect(fs.readFileSync(absolutePath, 'utf8')).toBe(beforeRejectedAppend);

    const recovered = await append.execute({
      path: relativePath,
      content: '确认后的追加\n',
      base_revision: currentRevision,
    }, ctx);
    expect(recovered.isError).toBeFalsy();
    expect(fs.readFileSync(absolutePath, 'utf8')).toBe(beforeRejectedAppend + '确认后的追加\n');
    expect(onFileWritten).toHaveBeenCalledTimes(3);
  });

  it('binds revisions to one path and reports the current revision for unknown run-scoped tokens', async () => {
    const { lt, perm } = await loadModules();
    perm.grantLocalExec();
    await setTmpWorkspace();
    const tools = lt.createLocalTools({ userId: 'u1' });
    const write = tools.find((tool) => tool.name === 'write_file')!;
    const append = tools.find((tool) => tool.name === 'append_file')!;
    const ctx = makeCtx();
    const first = await write.execute({ path: 'out/first.txt', content: 'first' }, ctx);
    const second = await write.execute({ path: 'out/second.txt', content: 'second' }, ctx);
    const firstRevision = /revision="(file_rev_[A-Za-z0-9_-]{16})"/.exec(first.content)?.[1];
    expect(firstRevision).toBeTruthy();
    expect(second.isError).toBeFalsy();

    const wrongPath = await append.execute({
      path: 'out/second.txt',
      content: 'nope',
      base_revision: firstRevision,
    }, ctx);
    expect(wrongPath.isError).toBe(true);
    expect(wrongPath.content).toContain('E_REVISION_PATH_MISMATCH');
    expect(fs.readFileSync(path.join(tmpDir, 'out/second.txt'), 'utf8')).toBe('second');

    const unknown = await append.execute({
      path: 'out/first.txt',
      content: 'nope',
      base_revision: 'file_rev_AAAAAAAAAAAAAAAA',
    }, makeCtx());
    expect(unknown.isError).toBe(true);
    expect(unknown.content).toContain('E_REVISION_UNKNOWN');
    expect(unknown.content).toMatch(/revision="file_rev_[A-Za-z0-9_-]{16}"/);
    expect(fs.readFileSync(path.join(tmpDir, 'out/first.txt'), 'utf8')).toBe('first');
  });

  it('persists complete UTF-8 appends across the former boundary with exact, compact receipts', async () => {
    const { lt, perm } = await loadModules();
    perm.grantLocalExec();
    await setTmpWorkspace();
    const onFileWritten = vi.fn();
    const tools = lt.createLocalTools({ userId: 'u1', onFileWritten });
    const write = tools.find((tool) => tool.name === 'write_file')!;
    const append = tools.find((tool) => tool.name === 'append_file')!;
    const contentSchema = (append.inputSchema.properties as Record<string, any>).content;
    expect(contentSchema.maxLength).toBeUndefined();
    expect((append.inputSchema.properties as Record<string, any>).base_revision).toMatchObject({
      type: 'string',
      pattern: '^file_rev_[A-Za-z0-9_-]{16}$',
    });
    expect(append.inputSchema.required).toEqual(['path', 'content']);

    const firstChunk = 'header\n';
    const appendCases = [
      { name: 'former boundary', content: 'A'.repeat(12_000) },
      { name: 'one over former boundary', content: 'B'.repeat(12_001) },
      // Exact size from the historical failed tool call.
      { name: 'historical complete call', content: 'C'.repeat(13_395) },
      { name: 'larger multibyte call', content: '界🙂'.repeat(10_000) },
    ];
    const expectedBody = firstChunk + appendCases.map((entry) => entry.content).join('');
    const relativePath = 'out/super-large.txt';
    const absolutePath = path.join(tmpDir, relativePath);
    const ctx = makeCtx();

    const first = await write.execute({ path: relativePath, content: firstChunk }, ctx);
    expect(first.isError).toBeFalsy();
    let expectedBytes = Buffer.byteLength(firstChunk, 'utf8');
    expect(first.content).toContain(`total_bytes="${expectedBytes}"`);
    let revision = /revision="(file_rev_[A-Za-z0-9_-]{16})"/.exec(first.content)?.[1];
    expect(revision).toBeTruthy();
    const originalRevision = revision;

    for (const [index, appendCase] of appendCases.entries()) {
      const { content: chunk } = appendCase;
      expect(chunk.length, appendCase.name).toBeGreaterThanOrEqual(12_000);
      const result = await append.execute({
        path: relativePath,
        content: chunk,
        base_revision: revision,
        // base_revision is authoritative even when a caller repeats the old
        // character-count/byte-count mistake from the historical case.
        ...(index === 2 ? { expected_size: 1 } : {}),
      }, ctx);
      expect(result.isError, appendCase.name).toBeFalsy();
      expectedBytes += Buffer.byteLength(chunk, 'utf8');
      expect(result.content).toContain(`total_bytes="${expectedBytes}"`);
      expect(result.content).toContain('replayed="false"');
      expect(result.content.length).toBeLessThan(chunk.length);
      expect(result.content).not.toContain(chunk.slice(0, 256));
      revision = /revision="(file_rev_[A-Za-z0-9_-]{16})"/.exec(result.content)?.[1];
      expect(revision).toBeTruthy();
    }

    const expectedHash = createHash('sha256').update(Buffer.from(expectedBody, 'utf8')).digest('hex');
    expect(fs.readFileSync(absolutePath, 'utf8')).toBe(expectedBody);
    expect(fs.statSync(absolutePath).size).toBe(expectedBytes);
    expect(createHash('sha256').update(fs.readFileSync(absolutePath)).digest('hex')).toBe(expectedHash);
    expect(onFileWritten).toHaveBeenCalledTimes(1 + appendCases.length);

    const replayed = await append.execute({
      path: relativePath,
      content: appendCases[0].content,
      base_revision: originalRevision,
    }, ctx);
    expect(replayed.isError).toBeFalsy();
    expect(replayed.content).toContain('replayed="true"');
    expect(fs.readFileSync(absolutePath, 'utf8')).toBe(expectedBody);
    expect(onFileWritten).toHaveBeenCalledTimes(1 + appendCases.length);

    const staleLargeChunk = 'different'.repeat(2_000);
    const stale = await append.execute({
      path: relativePath,
      content: staleLargeChunk,
      base_revision: originalRevision,
    }, ctx);
    expect(staleLargeChunk.length).toBeGreaterThan(12_000);
    expect(stale.isError).toBe(true);
    expect(stale.content).toContain('E_STALE');
    expect(fs.readFileSync(absolutePath, 'utf8')).toBe(expectedBody);
    expect(createHash('sha256').update(fs.readFileSync(absolutePath)).digest('hex')).toBe(expectedHash);
    expect(onFileWritten).toHaveBeenCalledTimes(1 + appendCases.length);
  });

  it('keeps legacy expected_size compatible for large appends, including replay and stale recovery', async () => {
    const { lt, perm } = await loadModules();
    perm.grantLocalExec();
    await setTmpWorkspace();
    const onFileWritten = vi.fn();
    const tools = lt.createLocalTools({ userId: 'u1', onFileWritten });
    const write = tools.find((tool) => tool.name === 'write_file')!;
    const append = tools.find((tool) => tool.name === 'append_file')!;
    const relativePath = 'out/legacy-large.txt';
    const absolutePath = path.join(tmpDir, relativePath);
    const firstChunk = '初始\n';
    const largeChunk = '界🙂'.repeat(5_000);
    const ctx = makeCtx();

    const first = await write.execute({ path: relativePath, content: firstChunk }, ctx);
    const expectedSize = Buffer.byteLength(firstChunk, 'utf8');
    expect(first.isError).toBeFalsy();
    expect(largeChunk.length).toBeGreaterThan(12_000);

    const appended = await append.execute({
      path: relativePath,
      content: largeChunk,
      expected_size: expectedSize,
    }, ctx);
    expect(appended.isError).toBeFalsy();
    expect(appended.content).toContain('replayed="false"');
    const expectedBody = firstChunk + largeChunk;
    expect(fs.readFileSync(absolutePath, 'utf8')).toBe(expectedBody);

    const replayed = await append.execute({
      path: relativePath,
      content: largeChunk,
      expected_size: expectedSize,
    }, ctx);
    expect(replayed.isError).toBeFalsy();
    expect(replayed.content).toContain('replayed="true"');
    expect(fs.readFileSync(absolutePath, 'utf8')).toBe(expectedBody);

    const stale = await append.execute({
      path: relativePath,
      content: 'stale'.repeat(3_000),
      expected_size: expectedSize,
    }, ctx);
    expect(stale.isError).toBe(true);
    expect(stale.content).toContain('E_STALE');
    expect(fs.readFileSync(absolutePath, 'utf8')).toBe(expectedBody);
    expect(onFileWritten).toHaveBeenCalledTimes(2);
  });
});

// ── Permission gate + PDF tools ──────────────────────────────────────────

describe('local-tools › markdown_to_pdf', () => {
  it('refuses when no workspace scope is available', async () => {
    const { lt, perm } = await loadModules();
    perm.revokeLocalExec();
    const onFileWritten = vi.fn();
    const mdpdf = lt.createLocalTools({ onFileWritten }).find((t) => t.name === 'markdown_to_pdf')!;
    const res = await mdpdf.execute({ path: 'x.pdf', markdown: '# hi' }, makeCtx());
    expect(res.isError).toBe(true);
    expect(printToPDF).not.toHaveBeenCalled();
    expect(onFileWritten).not.toHaveBeenCalled();
  });

  it('renders, writes to disk, and fires onFileWritten when granted', async () => {
    const { lt, perm } = await loadModules();
    perm.grantLocalExec();
    await setTmpWorkspace();
    const onFileWritten = vi.fn();
    const mdpdf = lt.createLocalTools({ userId: 'u1', onFileWritten }).find((t) => t.name === 'markdown_to_pdf')!;
    const rel = 'reports/weekly.pdf';
    const res = await mdpdf.execute(
      { path: rel, markdown: '# Title\n\nbody', title: 'Weekly' },
      makeCtx(),
    );
    expect(res.isError).toBeFalsy();
    expect(printToPDF).toHaveBeenCalledTimes(1);
    const abs = path.join(tmpDir, rel);
    expect(fs.existsSync(abs)).toBe(true);
    expect(onFileWritten).toHaveBeenCalledWith(abs);
    expect(res.content).toContain(abs);
  });

  it('passes pageSize and landscape through to printToPDF', async () => {
    const { lt, perm } = await loadModules();
    perm.grantLocalExec();
    await setTmpWorkspace();
    const mdpdf = lt.createLocalTools({ userId: 'u1' }).find((t) => t.name === 'markdown_to_pdf')!;
    await mdpdf.execute(
      { path: 'x.pdf', markdown: '# x', pageSize: 'Letter', landscape: true },
      makeCtx(),
    );
    const args = printToPDF.mock.calls[0][0];
    expect(args).toMatchObject({ pageSize: 'Letter', landscape: true });
  });

  it('returns isError when the underlying renderer throws', async () => {
    printToPDF.mockRejectedValueOnce(new Error('kapow'));
    const { lt, perm } = await loadModules();
    perm.grantLocalExec();
    await setTmpWorkspace();
    const onFileWritten = vi.fn();
    const mdpdf = lt.createLocalTools({ userId: 'u1', onFileWritten }).find((t) => t.name === 'markdown_to_pdf')!;
    const res = await mdpdf.execute({ path: 'bad.pdf', markdown: '# x' }, makeCtx());
    expect(res.isError).toBe(true);
    expect(res.content).toContain('kapow');
    expect(onFileWritten).not.toHaveBeenCalled();
  });

  it('rejects output paths outside the writable scope before rendering', async () => {
    const { lt, perm } = await loadModules();
    perm.setLocalExecMode('workspace_approval');
    await setTmpWorkspace();
    const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-pdf-outside-'));
    const outside = path.join(outsideDir, 'outside.pdf');
    try {
      const mdpdf = lt.createLocalTools({ userId: 'u1', cid: 'c1' }).find((t) => t.name === 'markdown_to_pdf')!;
      const res = await mdpdf.execute({ path: outside, markdown: '# nope' }, makeCtx());
      expect(res.isError).toBe(true);
      expect(res.content).toContain('E_PATH_OUT_OF_SCOPE');
      expect(printToPDF).not.toHaveBeenCalled();
      expect(fs.existsSync(outside)).toBe(false);
    } finally {
      fs.rmSync(outsideDir, { recursive: true, force: true });
    }
  });
});

describe('local-tools › html_to_pdf', () => {
  it('refuses when no workspace scope is available', async () => {
    const { lt, perm } = await loadModules();
    perm.revokeLocalExec();
    const hp = lt.createLocalTools({}).find((t) => t.name === 'html_to_pdf')!;
    const res = await hp.execute({ path: 'x.pdf', html: '<html></html>' }, makeCtx());
    expect(res.isError).toBe(true);
    expect(printToPDF).not.toHaveBeenCalled();
  });

  it('loads the HTML verbatim as a data: URL when granted', async () => {
    const { lt, perm } = await loadModules();
    perm.grantLocalExec();
    await setTmpWorkspace();
    const hp = lt.createLocalTools({ userId: 'u1' }).find((t) => t.name === 'html_to_pdf')!;
    const html = '<!DOCTYPE html><html><body><table><tr><td>X</td></tr></table></body></html>';
    await hp.execute({ path: 'table.pdf', html }, makeCtx());
    const url = loadURL.mock.calls[0][0];
    const b64 = url.split('base64,')[1];
    const decoded = Buffer.from(b64, 'base64').toString('utf8');
    expect(decoded).toBe(html);
  });

  it('rejects output paths outside the writable scope before rendering', async () => {
    const { lt, perm } = await loadModules();
    perm.setLocalExecMode('workspace_approval');
    await setTmpWorkspace();
    const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-htmlpdf-outside-'));
    const outside = path.join(outsideDir, 'outside.pdf');
    try {
      const hp = lt.createLocalTools({ userId: 'u1', cid: 'c1' }).find((t) => t.name === 'html_to_pdf')!;
      const res = await hp.execute({ path: outside, html: '<html></html>' }, makeCtx());
      expect(res.isError).toBe(true);
      expect(res.content).toContain('E_PATH_OUT_OF_SCOPE');
      expect(printToPDF).not.toHaveBeenCalled();
      expect(fs.existsSync(outside)).toBe(false);
    } finally {
      fs.rmSync(outsideDir, { recursive: true, force: true });
    }
  });
});
