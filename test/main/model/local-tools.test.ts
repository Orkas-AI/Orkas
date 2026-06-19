import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

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
  it('exposes exactly six tools, named bash / write_file / edit_file / delete_file / markdown_to_pdf / html_to_pdf', async () => {
    const { lt } = await loadModules();
    const tools = lt.createLocalTools({});
    expect(tools.map((t) => t.name).sort()).toEqual(
      ['bash', 'delete_file', 'edit_file', 'html_to_pdf', 'markdown_to_pdf', 'write_file'],
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
});

// ── Permission gate: bash ────────────────────────────────────────────────

describe('local-tools › bash permission gate', () => {
  it('returns isError with the deny sentinel when permission is not granted', async () => {
    const { lt, perm } = await loadModules();
    perm.revokeLocalExec();
    const bash = lt.createLocalTools({}).find((t) => t.name === 'bash')!;
    const res = await bash.execute({ command: 'echo hi' }, makeCtx());
    expect(res.isError).toBe(true);
    expect(res.content).toBe(lt.DENY_MESSAGE);
  });

  it('delegates to core-agent bash when granted (real shell runs)', async () => {
    const { lt, perm } = await loadModules();
    perm.grantLocalExec();
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

  it('re-checks permission per-call (revoke mid-run blocks the next call)', async () => {
    const { lt, perm } = await loadModules();
    perm.grantLocalExec();
    const bash = lt.createLocalTools({}).find((t) => t.name === 'bash')!;
    const ok = await bash.execute({ command: 'echo first', timeoutMs: 5000 }, makeCtx());
    expect(ok.isError).toBeFalsy();
    perm.revokeLocalExec();
    const denied = await bash.execute({ command: 'echo second', timeoutMs: 5000 }, makeCtx());
    expect(denied.isError).toBe(true);
    expect(denied.content).toBe(lt.DENY_MESSAGE);
  });
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
          ORKAS_NODE: process.execPath,
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
    expect(parsed.body).toBe(body);
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

// ── End-to-end: risk_prompt mode drives the real bash tool ────────────────

describe('local-tools › bash risk_prompt mode (e2e)', () => {
  async function loadWithBashPerms() {
    const lt = await import('../../../src/main/model/core-agent/local-tools');
    const perm = await import('../../../src/main/features/permissions');
    const bashPerms = await import('../../../src/main/model/core-agent/bash-permissions');
    return { lt, perm, bashPerms };
  }
  const OPTS = { userId: 'u1', cid: 'c1', agentId: 'a1' };

  it('runs a non-risky command without prompting under risk_prompt', async () => {
    const { lt, perm, bashPerms } = await loadWithBashPerms();
    perm.setLocalExecMode('risk_prompt');
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

  // A risky-but-harmless command: reading a file literally named `id_rsa`
  // trips the sensitive_path category, while the underlying `cat` is allowed
  // by core-agent's own bash sandbox and its output proves whether it ran.
  const SECRET = 'SECRET-sentinel-7f3';
  function makeKeyFile(): string {
    const p = path.join(tmpDir, 'id_rsa');
    fs.writeFileSync(p, SECRET);
    return p;
  }

  it('blocks a risky command on deny → E_BASH_RISK_DENIED and does NOT run it', async () => {
    const { lt, perm, bashPerms } = await loadWithBashPerms();
    perm.setLocalExecMode('risk_prompt');
    const key = makeKeyFile();
    bashPerms._setBroadcastForTest((_ch: string, info: any) => { bashPerms.respond(info.request_id, 'deny'); });
    try {
      const bash = lt.createLocalTools(OPTS).find((t) => t.name === 'bash')!;
      const res = await bash.execute({ command: `cat ${key}`, timeoutMs: 5000 }, makeCtx());
      expect(res.isError).toBe(true);
      expect(res.content).toContain('E_BASH_RISK_DENIED');
      expect(res.content).not.toContain(SECRET); // cat never ran
    } finally { bashPerms._setBroadcastForTest(null); }
  });

  it('runs a risky command after the user allows it (allow_once)', async () => {
    const { lt, perm, bashPerms } = await loadWithBashPerms();
    perm.setLocalExecMode('risk_prompt');
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

  it('allow_all runs a risky command with no prompt at all', async () => {
    const { lt, perm, bashPerms } = await loadWithBashPerms();
    perm.setLocalExecMode('allow_all');
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

  it('does not surface cloned repo scaffolding as produced chips, but keeps the real deliverable', async () => {
    const { lt, perm } = await loadModules();
    perm.grantLocalExec();
    const onFileWritten = vi.fn();
    const bash = lt.createLocalTools({ agentId: 'agent-a', onFileWritten }).find((t) => t.name === 'bash')!;

    // Simulate a skill unpacking its source tree into the workspace alongside
    // the one file the user actually wanted (slides.pptx).
    const res = await bash.execute({
      command:
        'node -e "const fs=require(\'fs\');const d=process.env.ORKAS_OUTPUT_DIR;' +
        'fs.mkdirSync(d + \'/.github\', { recursive: true });' +
        'fs.writeFileSync(d + \'/README.md\', \'r\');' +
        'fs.writeFileSync(d + \'/README_CN.md\', \'r\');' +
        'fs.writeFileSync(d + \'/LICENSE\', \'l\');' +
        'fs.writeFileSync(d + \'/CONTRIBUTING.md\', \'c\');' +
        'fs.writeFileSync(d + \'/.gitignore\', \'g\');' +
        'fs.writeFileSync(d + \'/.env.example\', \'e\');' +
        'fs.writeFileSync(d + \'/.github/config.yml\', \'y\');' +
        'fs.writeFileSync(d + \'/slides.pptx\', \'p\');"',
      timeoutMs: 5000,
    }, makeCtx());

    expect(res.isError).toBeFalsy();
    const produced = new Set(onFileWritten.mock.calls.map(([p]) => p));
    expect(produced).toContain(path.join(tmpDir, 'slides.pptx'));
    expect(produced).not.toContain(path.join(tmpDir, 'README.md'));
    expect(produced).not.toContain(path.join(tmpDir, 'README_CN.md'));
    expect(produced).not.toContain(path.join(tmpDir, 'LICENSE'));
    expect(produced).not.toContain(path.join(tmpDir, 'CONTRIBUTING.md'));
    expect(produced).not.toContain(path.join(tmpDir, '.gitignore'));
    expect(produced).not.toContain(path.join(tmpDir, '.env.example'));
    expect(produced).not.toContain(path.join(tmpDir, '.github', 'config.yml'));
  });
});

// ── Permission gate + onFileWritten: write_file ──────────────────────────

describe('local-tools › write_file', () => {
  it('refuses and does NOT create the file when permission is not granted', async () => {
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
    const onFileWritten = vi.fn();
    const wf = lt.createLocalTools({ onFileWritten }).find((t) => t.name === 'write_file')!;
    const res = await wf.execute({ path: 'out/note.txt', content: 'hello' }, makeCtx());
    expect(res.isError).toBeFalsy();
    const abs = path.join(tmpDir, 'out', 'note.txt');
    expect(fs.existsSync(abs)).toBe(true);
    expect(fs.readFileSync(abs, 'utf8')).toBe('hello');
    expect(onFileWritten).toHaveBeenCalledTimes(1);
    expect(onFileWritten).toHaveBeenCalledWith(abs);
  });

  it('does NOT fire onFileWritten when the underlying write fails', async () => {
    const { lt, perm } = await loadModules();
    perm.grantLocalExec();
    const onFileWritten = vi.fn();
    const wf = lt.createLocalTools({ onFileWritten }).find((t) => t.name === 'write_file')!;
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
  it('refuses when permission is not granted', async () => {
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
    const onFileWritten = vi.fn();
    const mdpdf = lt.createLocalTools({ onFileWritten }).find((t) => t.name === 'markdown_to_pdf')!;
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
    const mdpdf = lt.createLocalTools({}).find((t) => t.name === 'markdown_to_pdf')!;
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
    const onFileWritten = vi.fn();
    const mdpdf = lt.createLocalTools({ onFileWritten }).find((t) => t.name === 'markdown_to_pdf')!;
    const res = await mdpdf.execute({ path: 'bad.pdf', markdown: '# x' }, makeCtx());
    expect(res.isError).toBe(true);
    expect(res.content).toContain('kapow');
    expect(onFileWritten).not.toHaveBeenCalled();
  });
});

describe('local-tools › html_to_pdf', () => {
  it('refuses when permission is not granted', async () => {
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
    const hp = lt.createLocalTools({}).find((t) => t.name === 'html_to_pdf')!;
    const html = '<!DOCTYPE html><html><body><table><tr><td>X</td></tr></table></body></html>';
    await hp.execute({ path: 'table.pdf', html }, makeCtx());
    const url = loadURL.mock.calls[0][0];
    const b64 = url.split('base64,')[1];
    const decoded = Buffer.from(b64, 'base64').toString('utf8');
    expect(decoded).toBe(html);
  });
});
