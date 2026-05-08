import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// ── Electron mock (for html_to_pdf / markdown_to_pdf paths) ─────────────

const printToPDF = vi.fn(async () => Buffer.from('%PDF-1.4 test', 'utf8'));
const loadURL = vi.fn(async () => {});
const once = vi.fn((evt: string, cb: (...args: any[]) => void) => {
  if (evt === 'did-finish-load') setImmediate(cb);
});
const destroy = vi.fn();

class FakeBrowserWindow {
  webContents = { once, printToPDF, loadURL };
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

function makeCtx(): any {
  return { workingDir: tmpDir, state: {} };
}

// ── Tool identity ─────────────────────────────────────────────────────────

describe('local-tools › identity', () => {
  it('exposes exactly five tools, named bash / write_file / edit_file / markdown_to_pdf / html_to_pdf', async () => {
    const { lt } = await loadModules();
    const tools = lt.createLocalTools({});
    expect(tools.map((t) => t.name).sort()).toEqual(
      ['bash', 'edit_file', 'html_to_pdf', 'markdown_to_pdf', 'write_file'],
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
    const { lt } = await loadModules();
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

// ── Permission gate + onFileWritten: write_file ──────────────────────────

describe('local-tools › write_file', () => {
  it('refuses and does NOT create the file when permission is not granted', async () => {
    const { lt } = await loadModules();
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
    const { lt } = await loadModules();
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
    const { lt } = await loadModules();
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
