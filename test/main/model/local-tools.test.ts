import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const TEST_NODE = process.env.ORKAS_TEST_NODE || process.execPath;

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

afterEach(() => {
  process.env.ORKAS_WORKSPACE_ROOT = prevWs;
  fs.rmSync(tmpDir, { recursive: true, force: true });
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

function makeCtx(): any {
  return { workingDir: tmpDir, state: {} };
}

// ── Tool identity ─────────────────────────────────────────────────────────

describe('local-tools › identity', () => {
  it('exposes local shell/file/pdf tools plus interactive CLI session tools', async () => {
    const { lt } = await loadModules();
    const tools = lt.createLocalTools({});
    expect(tools.map((t) => t.name).sort()).toEqual(
      [
        'bash',
        'delete_file',
        'edit_file',
        'html_to_pdf',
        'interactive_cli_close',
        'interactive_cli_read',
        'interactive_cli_send',
        'interactive_cli_start',
        'markdown_to_pdf',
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

  it('write_file tool description mentions the workspace directory', async () => {
    const { lt } = await loadModules();
    const wf = lt.createLocalTools({}).find((t) => t.name === 'write_file')!;
    expect(wf.description.toLowerCase()).toContain('workspace');
  });

  it('blocks unmanaged QA runtimes only for VideoStudio', async () => {
    const { lt } = await loadModules();
    const videoBash = lt.createLocalTools({ agentId: '79df9cc89f5f' }).find((t) => t.name === 'bash')!;
    const otherBash = lt.createLocalTools({ agentId: 'another-agent' }).find((t) => t.name === 'bash')!;

    const blocked = await videoBash.execute({
      command: 'python3 -m http.server 8765',
      timeoutMs: 5000,
    }, makeCtx());
    expect(blocked.isError).toBe(true);
    expect(blocked.content).toContain('E_VIDEO_STUDIO_UNMANAGED_RUNTIME_FORBIDDEN');

    const allowed = await otherBash.execute({ command: 'echo safe', timeoutMs: 5000 }, makeCtx());
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
      { command: 'echo orkas-test-sentinel-42', timeoutMs: 5000 },
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
      const res = await bash.execute({ command: 'exit 7', timeoutMs: 5000 }, makeCtx());
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
    const ok = await bash.execute({ command: 'echo first', timeoutMs: 5000 }, makeCtx());
    expect(ok.isError).toBeFalsy();
    perm.revokeLocalExec();
    const stillAllowed = await bash.execute({ command: 'echo second', timeoutMs: 5000 }, makeCtx());
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
      command: `printf ok > ${JSON.stringify(target)}`,
      timeoutMs: 5000,
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
        command: `printf ok > ${JSON.stringify(outside)}`,
        timeoutMs: 5000,
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
        timeoutMs: 5000,
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
        timeoutMs: 5000,
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
      const res = await bash.execute({
        command: `${JSON.stringify(TEST_NODE)} -e ${JSON.stringify(script)}`,
        timeoutMs: 5000,
      }, makeCtx());
      expect(res.isError).toBe(true);
      expect(fs.existsSync(outside)).toBe(false);
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
    const command = `${JSON.stringify(TEST_NODE)} -e ${JSON.stringify(script)}`;

    const started = parseToolJson(await start.execute({
      command,
      max_lifetime_ms: 30000,
    }, makeCtx()));
    expect(started.session_id).toMatch(/[0-9a-f-]{20,}/i);
    expect(String(started.output)).toContain('verification code');
    expect(started.prompt_kind).toBe('auth_code');

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
    const command = `${JSON.stringify(TEST_NODE)} -e ${JSON.stringify(script)}`;

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
    const command = `${JSON.stringify(TEST_NODE)} -e ${JSON.stringify(script)}`;

    const started = parseToolJson(await start.execute({
      command,
      purpose: 'Authorize in browser',
      max_lifetime_ms: 30000,
    }, makeCtx()));

    let latest = started;
    for (let i = 0; i < 20 && latest.user_action_required !== true; i++) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      latest = parseToolJson(await read.execute({ session_id: started.session_id }, makeCtx()));
    }
    expect(latest.user_action_required).toBe(true);
    expect(latest.agent_should_stop).toBe(true);
    expect(latest.user_action_reason).toBe('browser_auth');
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
    const command = `${JSON.stringify(TEST_NODE)} -e ${JSON.stringify(script)}`;
    const started = mgr.startInteractiveCliSession({
      uid: 'u1',
      command,
      cwd: tmpDir,
      maxLifetimeMs: 30000,
    });
    try {
      mgr.sendInteractiveCliInput('u1', started.session_id, 'secret-code-42', { sensitive: true });
      let latest: any = null;
      for (let i = 0; i < 20; i++) {
        await new Promise((resolve) => setTimeout(resolve, 50));
        latest = mgr.readInteractiveCliSession('u1', started.session_id);
        if (String(latest.output || '').includes('[redacted]')) break;
      }
      expect(String(latest.output)).toContain('[redacted]');
      expect(String(latest.output)).not.toContain('secret-code-42');
    } finally {
      mgr.closeInteractiveCliSession('u1', started.session_id);
    }
  }, 10000);
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
      timeoutMs: 5000,
    }, makeOrkasCtx(pcDir));

    expect(res.isError).toBeFalsy();
    const parsed = JSON.parse(String(res.content));
    expect(parsed.argv).toEqual(['calculator', 'eval', '--', '1+1']);
    expect(parsed.out).toBe(tmpDir);
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
      timeoutMs: 5000,
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
      timeoutMs: 5000,
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
      command: `"$ORKAS_NODE" "$ORKAS_PC_DIR/bin/run-skill.cjs" calculator eval -- 1+1 2> "${errPath}" > "${outPath}"`,
      timeoutMs: 5000,
    }, makeOrkasCtx(pcDir));

    expect(res.isError).toBeFalsy();
    expect(String(res.content)).toBe('');
    const parsed = JSON.parse(fs.readFileSync(outPath, 'utf8'));
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

  it('runs a non-risky command without prompting under workspace_approval', async () => {
    const { lt, perm, bashPerms } = await loadWithBashPerms();
    perm.setLocalExecMode('workspace_approval');
    let prompted = false;
    bashPerms._setBroadcastForTest(() => { prompted = true; });
    try {
      const bash = lt.createLocalTools(OPTS).find((t) => t.name === 'bash')!;
      const res = await bash.execute({ command: 'echo safe-run-ok', timeoutMs: 5000 }, makeCtx());
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
      const res = await bash.execute({ command: `cat ${key}`, timeoutMs: 5000 }, makeCtx());
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
      const res = await bash.execute({ command: `cat ${key}`, timeoutMs: 5000 }, makeCtx());
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
      timeoutMs: 5000,
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
      timeoutMs: 5000,
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
        timeoutMs: 5000,
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

    const res = await bash.execute({
      command:
        'git() { mkdir -p vendor/src; printf "{}" > vendor/package.json; printf "x" > vendor/src/index.ts; }\n' +
        'git clone https://example.com/vendor.git\n' +
        'node -e "require(\'fs\').writeFileSync(process.env.ORKAS_OUTPUT_DIR + \'/summary.csv\', \'ok\')"',
      timeoutMs: 5000,
    }, makeCtx());

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
    fs.mkdirSync(fakeBin);
    fs.writeFileSync(path.join(fakeBin, 'curl'), '#!/bin/sh\nprintf downloaded > "$2"\n');
    fs.writeFileSync(path.join(fakeBin, 'wget'), '#!/bin/sh\nprintf downloaded > "$2"\n');
    fs.chmodSync(path.join(fakeBin, 'curl'), 0o755);
    fs.chmodSync(path.join(fakeBin, 'wget'), 0o755);

    const res = await bash.execute({
      command:
        `export PATH=${JSON.stringify(fakeBin)}:$PATH\n` +
        'curl -o downloaded.txt https://example.com/downloaded.txt\n' +
        'wget -O fetched.json https://example.com/fetched.json\n' +
        'node -e "require(\'fs\').writeFileSync(process.env.ORKAS_OUTPUT_DIR + \'/generated.md\', \'# ok\')"',
      timeoutMs: 5000,
    }, makeCtx());

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
      timeoutMs: 5000,
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
