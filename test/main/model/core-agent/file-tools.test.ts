import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { makeMinimalPdf } from '../../../fixtures/make-minimal-pdf';
import { makeMinimalDocx } from '../../../fixtures/make-minimal-docx';
import { makeMinimalXlsx, makeMinimalPptx } from '../../../fixtures/make-minimal-office';

const UID = 'u-ftools-001';
const CID = 'conv-x';

let tmpDir: string;
let prevWs: string | undefined;
let prevHome: string | undefined;
let prevGuard: string | undefined;

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-filetools-'));
  prevWs = process.env.ORKAS_WORKSPACE_ROOT;
  prevHome = process.env.HOME;
  prevGuard = process.env.ORKAS_TCC_GUARD_FORCE;
  process.env.ORKAS_WORKSPACE_ROOT = tmpDir;
  delete process.env.ORKAS_TCC_GUARD_FORCE;
  vi.resetModules();
  const users = await import('../../../../src/main/features/users');
  users.activateUser(UID);
});

afterEach(() => {
  process.env.ORKAS_WORKSPACE_ROOT = prevWs;
  if (prevHome === undefined) delete process.env.HOME;
  else process.env.HOME = prevHome;
  if (prevGuard === undefined) delete process.env.ORKAS_TCC_GUARD_FORCE;
  else process.env.ORKAS_TCC_GUARD_FORCE = prevGuard;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function attachmentDir(): string {
  return path.join(tmpDir, UID, 'cloud', 'chat_attachments', CID);
}

async function buildTools() {
  const mod = await import('../../../../src/main/model/core-agent/file-tools');
  const ws = await import('../../../../src/main/features/user_workspace');
  const wsDir = path.join(tmpDir, 'ws');
  fs.mkdirSync(wsDir, { recursive: true });
  const r = ws.setWorkspacePath(UID, wsDir);
  if (!r.ok) throw new Error(`setWorkspacePath failed: ${r.error}`);
  const tools = mod.createFileTools({ userId: UID, cid: CID });
  fs.mkdirSync(attachmentDir(), { recursive: true });
  return { tools, wsDir, attDir: attachmentDir() };
}

function getTool(tools: any[], name: string) {
  const t = tools.find((x) => x.name === name);
  if (!t) throw new Error(`tool ${name} not found`);
  return t;
}

async function run(tool: any, input: Record<string, any>) {
  const ctx = { workingDir: '.', signal: undefined } as any;
  return await tool.execute(input, ctx);
}

describe('file-tools › read_file (text)', () => {
  it('reads whole file when no range given and reports total_chars + covered', async () => {
    const { tools, wsDir } = await buildTools();
    const body = 'A\nB\nC\nD\nE';
    const p = path.join(wsDir, 'note.md');
    fs.writeFileSync(p, body);
    const r = await run(getTool(tools, 'read_file'), { path: p });
    expect(r.isError).toBeFalsy();
    expect(r.content).toContain(`total_chars="${body.length}"`);
    expect(r.content).toContain(`covered="0-${body.length}"`);
    expect(r.content).toContain(body);
  });

  it('slices by charStart/charEnd', async () => {
    const { tools, wsDir } = await buildTools();
    const p = path.join(wsDir, 'note.md');
    fs.writeFileSync(p, 'abcdefghij');
    const r = await run(getTool(tools, 'read_file'), { path: p, charStart: 2, charEnd: 7 });
    expect(r.isError).toBeFalsy();
    expect(r.content).toContain('covered="2-7"');
    expect(r.content).toContain('cdefg');
  });

  it('clamps charEnd past total_chars without error', async () => {
    const { tools, wsDir } = await buildTools();
    const p = path.join(wsDir, 'tiny.txt');
    fs.writeFileSync(p, 'xy');
    const r = await run(getTool(tools, 'read_file'), { path: p, charEnd: 999 });
    expect(r.isError).toBeFalsy();
    expect(r.content).toContain('covered="0-2"');
  });
});

describe('file-tools › read_file (rich documents require stat_file first)', () => {
  it('returns E_NEED_STAT when pdf has never been stated', async () => {
    const { tools, wsDir } = await buildTools();
    const p = path.join(wsDir, 'fresh.pdf');
    fs.writeFileSync(p, makeMinimalPdf(['Alpha', 'Bravo']));
    const r = await run(getTool(tools, 'read_file'), { path: p });
    expect(r.isError).toBe(true);
    expect(r.content).toContain('E_NEED_STAT');
  });

  it('returns E_NEED_STAT when xlsx has never been stated', async () => {
    const { tools, wsDir } = await buildTools();
    const p = path.join(wsDir, 'fresh.xlsx');
    fs.writeFileSync(p, makeMinimalXlsx({ rows: [['Name'], ['Ada']] }));
    const r = await run(getTool(tools, 'read_file'), { path: p });
    expect(r.isError).toBe(true);
    expect(r.content).toContain('E_NEED_STAT');
  });

  it('reads pdf after stat_file', async () => {
    const { tools, wsDir } = await buildTools();
    const p = path.join(wsDir, 'deck.pdf');
    fs.writeFileSync(p, makeMinimalPdf(['Alpha', 'Bravo']));
    const s = await run(getTool(tools, 'stat_file'), { path: p });
    expect(s.isError).toBeFalsy();
    const totalMatch = s.content.match(/total_chars="(\d+)"/);
    expect(totalMatch).not.toBeNull();
    const total = parseInt(totalMatch![1]);

    const r = await run(getTool(tools, 'read_file'), { path: p });
    expect(r.isError).toBeFalsy();
    expect(r.content).toContain(`total_chars="${total}"`);
    expect(r.content).toContain(`covered="0-${total}"`);
    expect(r.content).toContain('Alpha');
    expect(r.content).toContain('Bravo');
  });

  it('reads docx after stat_file', async () => {
    const { tools, wsDir } = await buildTools();
    const p = path.join(wsDir, 'notes.docx');
    fs.writeFileSync(p, makeMinimalDocx({ heading: 'HEAD', paragraphs: ['Body.'] }));
    await run(getTool(tools, 'stat_file'), { path: p });
    const r = await run(getTool(tools, 'read_file'), { path: p, charStart: 0, charEnd: 4 });
    expect(r.isError).toBeFalsy();
    expect(r.content).toContain('covered="0-4"');
  });

  it('reads xlsx after stat_file', async () => {
    const { tools, wsDir } = await buildTools();
    const p = path.join(wsDir, 'scores.xlsx');
    fs.writeFileSync(p, makeMinimalXlsx({ sheetName: 'Scores', rows: [['Name', 'Score'], ['Ada', '99']] }));
    const s = await run(getTool(tools, 'stat_file'), { path: p });
    expect(s.isError).toBeFalsy();
    expect(s.content).toContain('kind="spreadsheet"');

    const r = await run(getTool(tools, 'read_file'), { path: p });
    expect(r.isError).toBeFalsy();
    expect(r.content).toContain('Row 1: Name\tScore');
    expect(r.content).toContain('Row 2: Ada\t99');
  });

  it('reads pptx after stat_file', async () => {
    const { tools, wsDir } = await buildTools();
    const p = path.join(wsDir, 'slides.pptx');
    fs.writeFileSync(p, makeMinimalPptx({ slides: [['Roadmap', 'Launch in June']] }));
    const s = await run(getTool(tools, 'stat_file'), { path: p });
    expect(s.isError).toBeFalsy();
    expect(s.content).toContain('kind="presentation"');

    const r = await run(getTool(tools, 'read_file'), { path: p });
    expect(r.isError).toBeFalsy();
    expect(r.content).toContain('- Roadmap');
    expect(r.content).toContain('- Launch in June');
  });

  it('returns E_UNSUPPORTED_FILE for legacy Office formats', async () => {
    const { tools, wsDir } = await buildTools();
    const p = path.join(wsDir, 'legacy.xls');
    fs.writeFileSync(p, Buffer.from('legacy'));
    const r = await run(getTool(tools, 'stat_file'), { path: p });
    expect(r.isError).toBe(true);
    expect(r.content).toContain('E_UNSUPPORTED_FILE');
  });
});

describe('file-tools › read_file (image)', () => {
  it('returns image inline with ToolResult.images[]', async () => {
    const { tools, wsDir } = await buildTools();
    const p = path.join(wsDir, 'chart.png');
    const { Jimp } = await import('jimp' as any);
    const img: any = new Jimp({ width: 50, height: 50, color: 0x336699FF });
    fs.writeFileSync(p, await img.getBuffer('image/png'));
    const r = await run(getTool(tools, 'read_file'), { path: p });
    expect(r.isError).toBeFalsy();
    expect(Array.isArray(r.images)).toBe(true);
    expect(r.images.length).toBe(1);
    expect(r.images[0].mediaType).toBe('image/jpeg');
  });
});

describe('file-tools › read_file scope guards', () => {
  it('rejects paths outside the scope with E_PATH_OUT_OF_SCOPE', async () => {
    const { tools } = await buildTools();
    const outside = path.join(tmpDir, '..', 'outside', 'secret.md');
    fs.mkdirSync(path.dirname(outside), { recursive: true });
    fs.writeFileSync(outside, 'secret');
    try {
      const r = await run(getTool(tools, 'read_file'), { path: outside });
      expect(r.isError).toBe(true);
      expect(r.content).toContain('E_PATH_OUT_OF_SCOPE');
    } finally { fs.rmSync(path.dirname(outside), { recursive: true, force: true }); }
  });

  it('reports E_NOT_FOUND for missing files inside scope', async () => {
    const { tools, wsDir } = await buildTools();
    const r = await run(getTool(tools, 'read_file'), { path: path.join(wsDir, 'ghost.md') });
    expect(r.isError).toBe(true);
    expect(r.content).toContain('E_NOT_FOUND');
  });

  it('honours extraRoots — paths under an extra root are allowed', async () => {
    const ws = await import('../../../../src/main/features/user_workspace');
    const wsDir = path.join(tmpDir, 'ws');
    fs.mkdirSync(wsDir, { recursive: true });
    const r0 = ws.setWorkspacePath(UID, wsDir);
    if (!r0.ok) throw new Error(`setWorkspacePath failed: ${r0.error}`);

    const extra = path.join(tmpDir, 'extra-root');
    fs.mkdirSync(extra, { recursive: true });
    const f = path.join(extra, 'note.md');
    fs.writeFileSync(f, 'hi from extra');

    const mod = await import('../../../../src/main/model/core-agent/file-tools');
    const tools = mod.createFileTools({ userId: UID, extraRoots: [extra] });
    const r = await run(getTool(tools, 'read_file'), { path: f });
    expect(r.isError).toBeFalsy();
    expect(r.content).toContain('hi from extra');
  });

  it('blocks read_file from loading a disabled skill SKILL.md', async () => {
    const ws = await import('../../../../src/main/features/user_workspace');
    const paths = await import('../../../../src/main/paths');
    const enabled = await import('../../../../src/main/features/component_enabled');
    const wsDir = path.join(tmpDir, 'ws');
    fs.mkdirSync(wsDir, { recursive: true });
    const r0 = ws.setWorkspacePath(UID, wsDir);
    if (!r0.ok) throw new Error(`setWorkspacePath failed: ${r0.error}`);

    const skillRoot = paths.userSkillsDir(UID);
    const skillPath = path.join(skillRoot, 'disabled-skill', 'SKILL.md');
    fs.mkdirSync(path.dirname(skillPath), { recursive: true });
    fs.writeFileSync(skillPath, '---\nname: Disabled\n---\nsecret workflow');
    enabled.setSkillEnabled(UID, 'disabled-skill', false);

    const mod = await import('../../../../src/main/model/core-agent/file-tools');
    const tools = mod.createFileTools({ userId: UID, readOnlyExtraRoots: [skillRoot] });
    const r = await run(getTool(tools, 'read_file'), { path: skillPath });
    expect(r.isError).toBe(true);
    expect(r.content).toContain('E_SKILL_DISABLED');
    expect(r.content).not.toContain('secret workflow');
  });

  it('blocks stat_file from touching files inside a disabled skill', async () => {
    const ws = await import('../../../../src/main/features/user_workspace');
    const paths = await import('../../../../src/main/paths');
    const enabled = await import('../../../../src/main/features/component_enabled');
    const wsDir = path.join(tmpDir, 'ws');
    fs.mkdirSync(wsDir, { recursive: true });
    const r0 = ws.setWorkspacePath(UID, wsDir);
    if (!r0.ok) throw new Error(`setWorkspacePath failed: ${r0.error}`);

    const skillRoot = paths.userSkillsDir(UID);
    const scriptPath = path.join(skillRoot, 'disabled-skill', 'scripts', 'search.py');
    fs.mkdirSync(path.dirname(scriptPath), { recursive: true });
    fs.writeFileSync(scriptPath, 'print("secret")\n');
    enabled.setSkillEnabled(UID, 'disabled-skill', false);

    const mod = await import('../../../../src/main/model/core-agent/file-tools');
    const tools = mod.createFileTools({ userId: UID, readOnlyExtraRoots: [skillRoot] });
    const r = await run(getTool(tools, 'stat_file'), { path: scriptPath });
    expect(r.isError).toBe(true);
    expect(r.content).toContain('E_SKILL_DISABLED');
  });
});

describe('file-tools › stat_file', () => {
  it('returns total_chars for text without extra extraction work', async () => {
    const { tools, wsDir } = await buildTools();
    const p = path.join(wsDir, 'hello.txt');
    fs.writeFileSync(p, 'hello');
    const r = await run(getTool(tools, 'stat_file'), { path: p });
    expect(r.isError).toBeFalsy();
    expect(r.content).toContain('kind="text"');
    expect(r.content).toContain('total_chars="5"');
  });

  it('extracts pdf and returns total_chars', async () => {
    const { tools, wsDir } = await buildTools();
    const p = path.join(wsDir, 'deck.pdf');
    fs.writeFileSync(p, makeMinimalPdf(['One']));
    const r = await run(getTool(tools, 'stat_file'), { path: p });
    expect(r.isError).toBeFalsy();
    expect(r.content).toContain('kind="pdf"');
    expect(r.content).toMatch(/total_chars="\d+"/);
  });

  it('extracts xlsx and pptx and returns total_chars', async () => {
    const { tools, wsDir } = await buildTools();
    const sheet = path.join(wsDir, 'scores.xlsx');
    const deck = path.join(wsDir, 'slides.pptx');
    fs.writeFileSync(sheet, makeMinimalXlsx({ rows: [['Name'], ['Ada']] }));
    fs.writeFileSync(deck, makeMinimalPptx({ slides: [['Roadmap']] }));

    const s1 = await run(getTool(tools, 'stat_file'), { path: sheet });
    const s2 = await run(getTool(tools, 'stat_file'), { path: deck });

    expect(s1.isError).toBeFalsy();
    expect(s1.content).toContain('kind="spreadsheet"');
    expect(s1.content).toMatch(/total_chars="\d+"/);
    expect(s2.isError).toBeFalsy();
    expect(s2.content).toContain('kind="presentation"');
    expect(s2.content).toMatch(/total_chars="\d+"/);
  });

  it('returns E_NO_TEXT for image kind', async () => {
    const { tools, wsDir } = await buildTools();
    const p = path.join(wsDir, 'chart.png');
    const { Jimp } = await import('jimp' as any);
    const img: any = new Jimp({ width: 30, height: 30, color: 0xFF00FFFF });
    fs.writeFileSync(p, await img.getBuffer('image/png'));
    const r = await run(getTool(tools, 'stat_file'), { path: p });
    expect(r.isError).toBe(true);
    expect(r.content).toContain('E_NO_TEXT');
  });

  it('rejects paths outside scope', async () => {
    const { tools } = await buildTools();
    const outside = path.join(tmpDir, '..', 'outside2', 'x.md');
    fs.mkdirSync(path.dirname(outside), { recursive: true });
    fs.writeFileSync(outside, 's');
    try {
      const r = await run(getTool(tools, 'stat_file'), { path: outside });
      expect(r.isError).toBe(true);
      expect(r.content).toContain('E_PATH_OUT_OF_SCOPE');
    } finally { fs.rmSync(path.dirname(outside), { recursive: true, force: true }); }
  });
});

describe('file-tools › search_files', () => {
  it('finds by substring across workspace + attachment dir', async () => {
    const { tools, wsDir, attDir } = await buildTools();
    fs.writeFileSync(path.join(wsDir, 'contract_v2.md'), 'x');
    fs.writeFileSync(path.join(wsDir, 'unrelated.md'), 'x');
    fs.writeFileSync(path.join(attDir, 'contract_signed.pdf'), makeMinimalPdf(['p']));
    const r = await run(getTool(tools, 'search_files'), { query: 'contract' });
    expect(r.isError).toBeFalsy();
    expect(r.content).toContain('contract_v2.md');
    expect(r.content).toContain('contract_signed.pdf');
    expect(r.content).not.toContain('unrelated.md');
    // search_files must NOT report pages= anymore, and must NOT trigger
    // extract — a never-stated pdf has no total_chars in the hit.
    expect(r.content).not.toContain('pages=');
    expect(r.content).not.toMatch(/contract_signed\.pdf.*total_chars=/);
  });

  it('includes total_chars for files already in cache', async () => {
    const { tools, wsDir } = await buildTools();
    const p = path.join(wsDir, 'cached.pdf');
    fs.writeFileSync(p, makeMinimalPdf(['X']));
    // Pre-stat so the cache exists before the search runs.
    await run(getTool(tools, 'stat_file'), { path: p });

    const r = await run(getTool(tools, 'search_files'), { query: 'cached' });
    expect(r.content).toMatch(/cached\.pdf.*total_chars=\d+/);
  });

  it('supports glob patterns', async () => {
    const { tools, wsDir } = await buildTools();
    fs.writeFileSync(path.join(wsDir, 'a.pdf'), makeMinimalPdf(['x']));
    fs.writeFileSync(path.join(wsDir, 'b.md'), 'md');
    const r = await run(getTool(tools, 'search_files'), { query: '*.pdf' });
    expect(r.content).toContain('a.pdf');
    expect(r.content).not.toContain('b.md');
  });

  it('scans extraRoots in addition to workspace + attachment dir', async () => {
    const ws = await import('../../../../src/main/features/user_workspace');
    const wsDir = path.join(tmpDir, 'ws');
    fs.mkdirSync(wsDir, { recursive: true });
    const r0 = ws.setWorkspacePath(UID, wsDir);
    if (!r0.ok) throw new Error(`setWorkspacePath failed: ${r0.error}`);
    const extra = path.join(tmpDir, 'sync-conflict-target');
    fs.mkdirSync(extra, { recursive: true });
    fs.writeFileSync(path.join(extra, 'MOCK_SYNC_CONFLICT.md'), 'conflict target');

    const mod = await import('../../../../src/main/model/core-agent/file-tools');
    const tools = mod.createFileTools({ userId: UID, extraRoots: [extra] });
    const r = await run(getTool(tools, 'search_files'), { query: 'MOCK_SYNC_CONFLICT.md' });

    expect(r.isError).toBeFalsy();
    expect(r.content).toContain('MOCK_SYNC_CONFLICT.md');
  });

  it('does not recursively scan a privacy-protected workspace root', async () => {
    process.env.ORKAS_TCC_GUARD_FORCE = '1';
    const home = path.join(tmpDir, 'home');
    const downloads = path.join(home, 'Downloads');
    fs.mkdirSync(downloads, { recursive: true });
    fs.writeFileSync(path.join(downloads, 'secret-contract.md'), 'private');
    process.env.HOME = home;
    vi.resetModules();
    const users = await import('../../../../src/main/features/users');
    users.activateUser(UID);
    const ws = await import('../../../../src/main/features/user_workspace');
    const set = ws.setWorkspacePath(UID, downloads);
    expect(set.ok).toBe(true);
    fs.mkdirSync(attachmentDir(), { recursive: true });
    const mod = await import('../../../../src/main/model/core-agent/file-tools');
    const tools = mod.createFileTools({ userId: UID, cid: CID });

    const r = await run(getTool(tools, 'search_files'), { query: 'secret' });

    expect(r.isError).toBeFalsy();
    expect(r.content).toContain('privacy-protected workspace');
    expect(r.content).not.toContain('secret-contract.md');
  });
});

describe('file-tools › grep_files', () => {
  it('matches text files directly on source', async () => {
    const { tools, wsDir } = await buildTools();
    fs.writeFileSync(path.join(wsDir, 'a.md'), 'line with banana\nother line');
    fs.writeFileSync(path.join(wsDir, 'b.md'), 'no match here');
    const r = await run(getTool(tools, 'grep_files'), { pattern: 'banana' });
    expect(r.isError).toBeFalsy();
    expect(r.content).toContain('a.md:1');
    expect(r.content).not.toContain('b.md');
  });

  it('extracts pdf/docx on cache-miss then greps', async () => {
    const { tools, wsDir } = await buildTools();
    fs.writeFileSync(path.join(wsDir, 'clause.pdf'), makeMinimalPdf(['Termination of Agreement']));
    const r = await run(getTool(tools, 'grep_files'), { pattern: 'Termination' });
    expect(r.isError).toBeFalsy();
    expect(r.content).toContain('clause.pdf');
    expect(r.content).toContain('Termination');
  });

  it('extracts xlsx/pptx on cache-miss then greps', async () => {
    const { tools, wsDir } = await buildTools();
    fs.writeFileSync(path.join(wsDir, 'scores.xlsx'), makeMinimalXlsx({ rows: [['Name'], ['Banana KPI']] }));
    fs.writeFileSync(path.join(wsDir, 'slides.pptx'), makeMinimalPptx({ slides: [['Roadmap Banana']] }));
    const r = await run(getTool(tools, 'grep_files'), { pattern: 'Banana' });
    expect(r.isError).toBeFalsy();
    expect(r.content).toContain('scores.xlsx');
    expect(r.content).toContain('slides.pptx');
    expect(r.content).toContain('Banana');
  });

  it('rejects invalid regex under regex=true', async () => {
    const { tools } = await buildTools();
    const r = await run(getTool(tools, 'grep_files'), { pattern: '(', regex: true });
    expect(r.isError).toBe(true);
    expect(r.content).toContain('E_BAD_INPUT');
  });
});
