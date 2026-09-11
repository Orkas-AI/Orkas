import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { makeMinimalPdf } from '../../../fixtures/make-minimal-pdf';
import { makeMinimalDocx } from '../../../fixtures/make-minimal-docx';
import { makeMinimalXlsx, makeMinimalPptx } from '../../../fixtures/make-minimal-office';

const nodeRequire = createRequire(import.meta.url);

vi.mock('../../../../src/main/logger', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

const UID = 'u-ftools-001';
const CID = 'conv-x';
const PROJECT_ID = 'projfiletools';
const PROJECT_CID = 'conv-project-x';

let tmpDir: string;
let prevWs: string | undefined;
let prevHome: string | undefined;
let prevGuard: string | undefined;

function faultStatForPath(targetPath: string, code: 'EACCES' | 'EPERM'): {
  statAttempts: string[];
  parentReaddirAttempts: string[];
  restore(): void;
} {
  const mutableFs = nodeRequire('node:fs') as Record<string, any>;
  const originalStatSync = mutableFs.statSync;
  const originalReaddirSync = mutableFs.readdirSync;
  const target = path.resolve(targetPath);
  const parent = path.dirname(target);
  const statAttempts: string[] = [];
  const parentReaddirAttempts: string[] = [];
  const resolveArg = (value: unknown): string => {
    if (typeof value === 'string') return path.resolve(value);
    if (Buffer.isBuffer(value)) return path.resolve(value.toString());
    return '';
  };

  mutableFs.statSync = function injectedStatFailure(this: unknown, ...args: any[]) {
    const requested = resolveArg(args[0]);
    if (requested === target) {
      statAttempts.push(requested);
      throw Object.assign(new Error(`${code}: permission denied, stat '${target}'`), {
        code,
        errno: code === 'EACCES' ? -13 : -1,
        path: target,
        syscall: 'stat',
      });
    }
    return Reflect.apply(originalStatSync, this, args);
  };
  mutableFs.readdirSync = function recordParentRead(this: unknown, ...args: any[]) {
    const requested = resolveArg(args[0]);
    if (requested === parent) parentReaddirAttempts.push(requested);
    return Reflect.apply(originalReaddirSync, this, args);
  };
  syncBuiltinESMExports();

  return {
    statAttempts,
    parentReaddirAttempts,
    restore() {
      mutableFs.statSync = originalStatSync;
      mutableFs.readdirSync = originalReaddirSync;
      syncBuiltinESMExports();
    },
  };
}

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
  vi.doUnmock('../../../../src/main/features/ocr_runtime');
  vi.doUnmock('../../../../src/main/features/file_indexer');
  vi.restoreAllMocks();
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

async function buildTools(options: {
  includeOcrFile?: boolean;
  visionFallbackAvailable?: boolean;
  rawTextMaxBytes?: number;
} = {}) {
  const mod = await import('../../../../src/main/model/core-agent/file-tools');
  const ws = await import('../../../../src/main/features/user_workspace');
  const wsDir = path.join(tmpDir, 'ws');
  fs.mkdirSync(wsDir, { recursive: true });
  const r = ws.setWorkspacePath(UID, wsDir);
  if (!r.ok) throw new Error(`setWorkspacePath failed: ${r.error}`);
  const tools = mod.createFileTools({ userId: UID, cid: CID, ...options });
  fs.mkdirSync(attachmentDir(), { recursive: true });
  return { tools, wsDir, attDir: attachmentDir() };
}

async function buildProjectTools() {
  const mod = await import('../../../../src/main/model/core-agent/file-tools');
  const ws = await import('../../../../src/main/features/user_workspace');
  const paths = await import('../../../../src/main/paths');
  const wsDir = path.join(tmpDir, 'project-ws');
  fs.mkdirSync(wsDir, { recursive: true });
  const r = ws.setWorkspacePath(UID, wsDir);
  if (!r.ok) throw new Error(`setWorkspacePath failed: ${r.error}`);

  fs.mkdirSync(path.dirname(paths.projectMetaFile(UID, PROJECT_ID)), { recursive: true });
  fs.writeFileSync(paths.projectMetaFile(UID, PROJECT_ID), JSON.stringify({
    project_id: PROJECT_ID,
    name: 'Project File Tools',
  }), 'utf8');
  fs.mkdirSync(path.dirname(paths.projectChatIndexFile(UID, PROJECT_ID)), { recursive: true });
  fs.writeFileSync(paths.projectChatIndexFile(UID, PROJECT_ID), JSON.stringify([{
    conversation_id: PROJECT_CID,
    project_id: PROJECT_ID,
    title: 'Project conversation',
    created_at: '2026-07-09T00:00:00.000Z',
    updated_at: '2026-07-09T00:00:00.000Z',
  }]), 'utf8');

  const attDir = paths.projectChatAttachmentDir(UID, PROJECT_ID, PROJECT_CID);
  fs.mkdirSync(attDir, { recursive: true });
  const tools = mod.createFileTools({ userId: UID, cid: PROJECT_CID, projectId: PROJECT_ID });
  return { tools, wsDir, attDir };
}

function getTool(tools: any[], name: string) {
  const t = tools.find((x) => x.name === name);
  if (t) return t;
  // Keep the older behavior assertions below focused on the shared item
  // executor while the explicit surface tests verify that these aliases are
  // no longer registered for the model.
  const readFiles = tools.find((x) => x.name === 'read_files');
  if (name === 'read_file' && readFiles) {
    return {
      inputSchema: (readFiles.inputSchema as any).properties.paths.items,
      execute: (input: Record<string, unknown>, ctx: unknown) => (
        readFiles.execute({ paths: [input] }, ctx)
      ),
    };
  }
  if (name === 'stat_file' && readFiles) {
    return {
      execute: (input: Record<string, unknown>, ctx: unknown) => (
        readFiles.execute({ paths: [input], metadata_only: true }, ctx)
      ),
    };
  }
  throw new Error(`tool ${name} not found`);
}

describe('file-tools › run_program source loader', () => {
  it('loads exact UTF-8 source through the ordinary workspace scope', async () => {
    const perm = await import('../../../../src/main/features/permissions');
    perm.setLocalExecMode('workspace_approval');
    const { wsDir } = await buildTools();
    const sourcePath = path.join(wsDir, 'consolidate-corrections.js');
    const source = "const rows = [1, 2, 3]; json({ count: rows.length });\n";
    fs.writeFileSync(sourcePath, source, 'utf8');
    const mod = await import('../../../../src/main/model/core-agent/file-tools');
    const loader = mod.createProgramSourceLoader({ userId: UID, cid: CID });

    await expect(loader('consolidate-corrections.js', {
      workingDir: wsDir,
      state: {},
    }, 64_000)).resolves.toEqual({
      status: 'completed',
      source,
      resolvedPath: sourcePath,
    });
  });

  it('rejects out-of-scope and symlink-escaped program sources', async () => {
    const perm = await import('../../../../src/main/features/permissions');
    perm.setLocalExecMode('workspace_approval');
    const { wsDir } = await buildTools();
    const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-program-source-outside-'));
    const outside = path.join(outsideDir, 'secret.js');
    fs.writeFileSync(outside, "text('secret');\n", 'utf8');
    const link = path.join(wsDir, 'escape.js');
    let symlinkCreated = true;
    try { fs.symlinkSync(outside, link); }
    catch { symlinkCreated = false; }
    const mod = await import('../../../../src/main/model/core-agent/file-tools');
    const loader = mod.createProgramSourceLoader({ userId: UID, cid: CID });
    try {
      const outsideResult = await loader(outside, { workingDir: wsDir, state: {} }, 64_000);
      expect(outsideResult).toMatchObject({ status: 'denied', code: 'E_PROGRAM_SOURCE_DENIED' });
      if (symlinkCreated) {
        const escaped = await loader(link, { workingDir: wsDir, state: {} }, 64_000);
        expect(escaped).toMatchObject({ status: 'denied', code: 'E_PROGRAM_SOURCE_DENIED' });
      }
    } finally {
      fs.rmSync(outsideDir, { recursive: true, force: true });
    }
  });

  it('rejects non-UTF-8 and oversized saved sources before execution', async () => {
    const { wsDir } = await buildTools();
    const invalid = path.join(wsDir, 'invalid.js');
    const oversized = path.join(wsDir, 'oversized.js');
    fs.writeFileSync(invalid, Buffer.from([0xff, 0xfe, 0xfd]));
    fs.writeFileSync(oversized, 'x'.repeat(33), 'utf8');
    const mod = await import('../../../../src/main/model/core-agent/file-tools');
    const loader = mod.createProgramSourceLoader({ userId: UID, cid: CID });

    await expect(loader(invalid, { workingDir: wsDir, state: {} }, 64_000))
      .resolves.toMatchObject({ status: 'denied', code: 'E_PROGRAM_SOURCE_ENCODING' });
    await expect(loader(oversized, { workingDir: wsDir, state: {} }, 32))
      .resolves.toMatchObject({ status: 'denied', code: 'E_PROGRAM_SOURCE_LIMIT' });
  });
});

describe('file-tools › working-directory-relative paths', () => {
  it('advertises and resolves relative locations consistently across workspace readers', async () => {
    const mockOcr = vi.fn(async ({ absPath }: { absPath: string }) => ({
      ok: true,
      content: `<ocr-file path="${absPath}" kind="image">recognized</ocr-file>`,
      pages: [1],
      cached: false,
      engine: 'test',
    }));
    vi.doMock('../../../../src/main/features/ocr_runtime', () => ({ ocrFile: mockOcr }));
    const { tools, wsDir } = await buildTools({ includeOcrFile: true });
    const recordsDir = path.join(wsDir, 'inputs', 'records');
    const notePath = path.join(recordsDir, 'note.txt');
    const scanPath = path.join(wsDir, 'inputs', 'scan.png');
    fs.mkdirSync(recordsDir, { recursive: true });
    fs.writeFileSync(notePath, 'relative-path-marker\n', 'utf8');
    fs.writeFileSync(scanPath, 'image fixture', 'utf8');

    const readFiles = getTool(tools, 'read_files');
    const listFiles = getTool(tools, 'list_files');
    const searchFiles = getTool(tools, 'search_files');
    const grepFiles = getTool(tools, 'grep_files');
    const ocrFile = getTool(tools, 'ocr_file');
    const pathDescriptions = [
      (readFiles.inputSchema as any).properties.paths.items.properties.path.description,
      (listFiles.inputSchema as any).properties.path.description,
      (searchFiles.inputSchema as any).properties.root.description,
      (grepFiles.inputSchema as any).properties.root.description,
      (ocrFile.inputSchema as any).properties.path.description,
    ];
    for (const description of pathDescriptions) {
      expect(description.toLowerCase()).toContain('relative to the working directory');
      expect(description.toLowerCase()).toContain('visible absolute');
    }

    const ctx = { workingDir: wsDir, signal: undefined } as any;
    const read = await readFiles.execute({
      paths: [{ path: 'inputs/records/note.txt' }],
    }, ctx);
    const list = await listFiles.execute({ path: 'inputs' }, ctx);
    const search = await searchFiles.execute({ root: 'inputs', query: 'note.txt' }, ctx);
    const grep = await grepFiles.execute({ root: 'inputs', pattern: 'relative-path-marker' }, ctx);
    const ocr = await ocrFile.execute({ path: 'inputs/scan.png' }, ctx);

    expect(read.isError).toBeFalsy();
    expect(read.content).toContain('relative-path-marker');
    expect(list.isError).toBeFalsy();
    expect(list.content).toContain('d records');
    expect(search.isError).toBeFalsy();
    expect(search.content).toContain('note.txt');
    expect(grep.isError).toBeFalsy();
    expect(grep.content).toContain('relative-path-marker');
    expect(ocr.isError).toBeFalsy();
    expect(mockOcr).toHaveBeenCalledWith(expect.objectContaining({ absPath: scanPath }));
  });
});

describe('file-tools › list_files', () => {
  it('treats a lazy, not-yet-created conversation cwd as an empty directory', async () => {
    const { tools, wsDir } = await buildTools();
    const lazyCwd = path.join(wsDir, 'new-conversation');
    const result = await getTool(tools, 'list_files').execute(
      { path: lazyCwd },
      { workingDir: lazyCwd, signal: undefined } as any,
    );

    expect(result.isError).toBeFalsy();
    expect(result.content).toBe('(empty directory)');
    expect(fs.existsSync(lazyCwd)).toBe(false);
  });

  it('keeps a missing child path as a real error', async () => {
    const { tools, wsDir } = await buildTools();
    const result = await getTool(tools, 'list_files').execute(
      { path: path.join(wsDir, 'missing-child') },
      { workingDir: wsDir, signal: undefined } as any,
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain('E_LIST_FAILED');
  });
});

async function run(tool: any, input: Record<string, any>) {
  const ctx = { workingDir: '.', signal: undefined } as any;
  return await tool.execute(input, ctx);
}

describe('file-tools › read_file (text)', () => {
  it('advertises one tagged range object instead of mutually exclusive flat fields', async () => {
    const { tools } = await buildTools();
    const schema = getTool(tools, 'read_file').inputSchema as any;
    expect(schema.properties).not.toHaveProperty('charStart');
    expect(schema.properties).not.toHaveProperty('charEnd');
    expect(schema.properties).not.toHaveProperty('lineStart');
    expect(schema.properties).not.toHaveProperty('lineEnd');
    expect(schema.properties.range).toMatchObject({
      type: 'object',
      additionalProperties: false,
      required: ['unit', 'start', 'end'],
      properties: {
        unit: { type: 'string', enum: ['line', 'char'] },
        start: { type: 'integer' },
        end: { type: 'integer' },
      },
    });
  });

  it('reads whole file when no range given and reports total_chars + covered + lines', async () => {
    const { tools, wsDir } = await buildTools();
    const body = 'A\nB\nC\nD\nE';
    const p = path.join(wsDir, 'note.md');
    fs.writeFileSync(p, body);
    const r = await run(getTool(tools, 'read_file'), { path: p });
    expect(r.isError).toBeFalsy();
    expect(r.content).toContain(`total_chars="${body.length}"`);
    expect(r.content).toContain(`covered="0-${body.length}"`);
    expect(r.content).toContain('lines="1-5"');
    expect(r.content).toMatch(/revision="file_rev_[A-Za-z0-9_-]{16}"/);
    // Lines are shown with absolute 1-based number + tab prefixes (G5).
    expect(r.content).toContain('1\tA\n2\tB\n3\tC\n4\tD\n5\tE');
  });

  it('returns one stable revision for parallel reads and a new revision after the file changes', async () => {
    const { tools, wsDir } = await buildTools();
    const p = path.join(wsDir, 'parallel-revision.txt');
    fs.writeFileSync(p, '初始内容🙂\n', 'utf8');
    const read = getTool(tools, 'read_file');
    const ctx = { workingDir: wsDir, signal: undefined, state: {} } as any;
    const [first, second] = await Promise.all([
      read.execute({ path: p }, ctx),
      read.execute({ path: p }, ctx),
    ]);
    const firstRevision = /revision="(file_rev_[A-Za-z0-9_-]{16})"/.exec(first.content)?.[1];
    const secondRevision = /revision="(file_rev_[A-Za-z0-9_-]{16})"/.exec(second.content)?.[1];
    expect(firstRevision).toBeTruthy();
    expect(secondRevision).toBe(firstRevision);

    fs.appendFileSync(p, '新内容\n', 'utf8');
    const changed = await read.execute({ path: p }, ctx);
    const changedRevision = /revision="(file_rev_[A-Za-z0-9_-]{16})"/.exec(changed.content)?.[1];
    expect(changedRevision).toBeTruthy();
    expect(changedRevision).not.toBe(firstRevision);
  });

  it('numbers lines from the absolute line of a mid-file char slice', async () => {
    const { tools, wsDir } = await buildTools();
    const p = path.join(wsDir, 'code.txt');
    fs.writeFileSync(p, 'L1\nL2\nL3\nL4\nL5');
    // char 6 is the start of "L3" ("L1\n"=0-2, "L2\n"=3-5).
    const r = await run(getTool(tools, 'read_file'), { path: p, charStart: 6 });
    expect(r.isError).toBeFalsy();
    expect(r.content).toContain('lines="3-5"');
    expect(r.content).toContain('3\tL3\n4\tL4\n5\tL5');
    // The number+tab is a display prefix, not the raw file bytes.
    expect(r.content).not.toContain('1\tL3');
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

  it('reads a 1-based inclusive line range and records the exact observation', async () => {
    const { tools, wsDir } = await buildTools();
    const p = path.join(wsDir, 'range.ts');
    fs.writeFileSync(p, 'one\ntwo\nthree\nfour\nfive\n');
    const r = await run(getTool(tools, 'read_file'), { path: p, lineStart: 2, lineEnd: 4 });
    expect(r.isError).toBeFalsy();
    expect(r.content).toContain('lines="2-4"');
    expect(r.content).toContain('2\ttwo\n3\tthree\n4\tfour');
    expect(r.content).not.toContain('1\tone');
    expect(r.content).not.toContain('5\tfive');
    expect(r.observations?.fileReads?.[0]).toMatchObject({
      path: p,
      lineRange: [2, 4],
    });
  });

  it('reads line and character slices through the tagged range contract', async () => {
    const { tools, wsDir } = await buildTools();
    const p = path.join(wsDir, 'tagged-range.txt');
    fs.writeFileSync(p, 'one\ntwo\nthree\nfour\n');

    const lines = await run(getTool(tools, 'read_file'), {
      path: p,
      range: { unit: 'line', start: 2, end: 3 },
    });
    expect(lines.isError).toBeFalsy();
    expect(lines.content).toContain('2\ttwo\n3\tthree');
    expect(lines.content).not.toContain('1\tone');

    const chars = await run(getTool(tools, 'read_file'), {
      path: p,
      range: { unit: 'char', start: 4, end: 7 },
    });
    expect(chars.isError).toBeFalsy();
    expect(chars.content).toContain('two');
    expect(chars.content).toContain('covered="4-7"');
  });

  it.each([
    { range: { unit: 'line', start: 'private value', end: 4 }, reason: 'range_integer', facts: { start_type: 'string', start_integer: false, end_integer: true } },
    { range: { unit: 'line', start: 2, end: 1 }, reason: 'range_order', facts: { start_in_bounds: true, ordered: false } },
    { range: { unit: 'line', start: 0, end: 2 }, reason: 'range_order', facts: { start_in_bounds: false, ordered: true } },
    { range: { unit: 'line', start: 1 }, reason: 'range_integer', facts: { end_present: false, end_type: 'undefined' } },
  ])('preserves batch range diagnostic facts for $reason', async ({ range, reason, facts }) => {
    const { tools, wsDir } = await buildTools();
    const target = path.join(wsDir, 'private-target.txt');
    fs.writeFileSync(target, 'private body');
    const result = await run(getTool(tools, 'read_files'), { paths: [{ path: target }, { path: target, range }] });
    expect(result.isError).toBe(true);
    expect(result.observations?.fileFailure).toMatchObject({ code: 'E_BAD_INPUT', reason, stage: 'input', item_index: 1, ...facts });
    expect(JSON.stringify(result.observations)).not.toContain('private');
    expect(fs.readFileSync(target, 'utf8')).toBe('private body');
  });

  it('rejects malformed tagged ranges and mixed tagged/legacy addressing', async () => {
    const { tools, wsDir } = await buildTools();
    const p = path.join(wsDir, 'invalid-range.txt');
    fs.writeFileSync(p, 'one\ntwo\n');
    const read = getTool(tools, 'read_file');

    const malformed = await run(read, {
      path: p,
      range: { unit: 'line', start: 2, end: 1 },
    });
    expect(malformed.isError).toBe(true);
    expect(malformed.content).toContain('E_BAD_INPUT');

    const mixed = await run(read, {
      path: p,
      range: { unit: 'line', start: 1, end: 1 },
      charStart: 0,
    });
    expect(mixed.isError).toBe(true);
    expect(mixed.content).toContain('E_BAD_INPUT');
  });

  it('rejects mixed line and character addressing', async () => {
    const { tools, wsDir } = await buildTools();
    const p = path.join(wsDir, 'range.txt');
    fs.writeFileSync(p, 'one\ntwo\n');
    const r = await run(getTool(tools, 'read_file'), { path: p, lineStart: 1, charStart: 0 });
    expect(r.isError).toBe(true);
    expect(r.content).toContain('E_BAD_INPUT');
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

describe('file-tools › portable skill documents', () => {
  it('gives every file-based skill source the same verbatim-document semantics', async () => {
    process.env.HOME = path.join(tmpDir, 'home');
    const paths = await import('../../../../src/main/paths');
    const mod = await import('../../../../src/main/model/core-agent/file-tools');
    const [claudeGlobal, codexGlobal] = paths.globalSkillRoots();
    const roots = [
      ['custom', paths.userSkillsDir(UID)],
      ['marketplace', paths.userMarketplaceSkillsDir(UID)],
      ['system', paths.userSystemSkillsDir(UID)],
      ['agent-private', paths.agentPrivateSkillsDir(UID, 'agent-one')],
      ['agent-evolved', paths.agentEvolvedSkillsDir(UID, 'agent-one')],
      ['marketplace-agent', paths.userMarketplaceAgentSkillsDir(UID, 'agent-two')],
      ['package-companion', paths.userPackageSkillsDir(UID)],
      ['external-package-dot-root', paths.userPackagesDir(UID)],
      ['external-package-nested-root', path.join(paths.userPackageDir(UID, 'toolkit'), 'skills')],
      ['global-claude', claudeGlobal],
      ['global-codex', codexGlobal],
    ] as const;

    const files = roots.map(([source, root]) => {
      const skillFile = path.join(root, `skill-${source}`, 'SKILL.md');
      fs.mkdirSync(path.dirname(skillFile), { recursive: true });
      fs.writeFileSync(skillFile, `---\nname: ${source}\n---\nFollow the ${source} procedure.\n`);
      return { source, skillFile };
    });
    const tools = mod.createFileTools({
      userId: UID,
      readOnlyExtraRoots: roots.map(([, root]) => root),
    });

    for (const { source, skillFile } of files) {
      const result = await run(getTool(tools, 'read_file'), { path: skillFile });
      expect({ source, isError: !!result.isError, verbatimDocument: result.verbatimDocument })
        .toEqual({ source, isError: false, verbatimDocument: true });
    }
  });

  it('covers nested references without promoting sibling or unrelated files', async () => {
    const mod = await import('../../../../src/main/model/core-agent/file-tools');
    const root = path.join(tmpDir, 'portable-skills');
    const skillDir = path.join(root, 'design-skill');
    const skillBody = path.join(skillDir, 'SKILL.md');
    const nestedReference = path.join(skillDir, 'references', 'design-styles', 'framer.md');
    const siblingNote = path.join(skillDir, 'notes.md');
    const script = path.join(skillDir, 'scripts', 'render.ts');
    const unrelatedReference = path.join(root, 'ordinary', 'references', 'notes.md');
    for (const [file, body] of [
      [skillBody, '---\nname: Design skill\n---\nBody'],
      [nestedReference, 'Nested reference'],
      [siblingNote, 'Sibling note'],
      [script, 'console.log("script")'],
      [unrelatedReference, 'Not a skill reference'],
    ]) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, body);
    }
    const tools = mod.createFileTools({ userId: UID, readOnlyExtraRoots: [root] });
    const read = (file: string) => run(getTool(tools, 'read_file'), { path: file });

    expect((await read(skillBody)).verbatimDocument).toBe(true);
    expect((await read(nestedReference)).verbatimDocument).toBe(true);
    expect((await read(siblingNote)).verbatimDocument).toBeUndefined();
    expect((await read(script)).verbatimDocument).toBeUndefined();
    expect((await read(unrelatedReference)).verbatimDocument).toBeUndefined();
  });
});

describe('file-tools › read_files (rich documents prepare on first read)', () => {
  it('extracts and reads a fresh pdf in one call', async () => {
    const { tools, wsDir } = await buildTools();
    const p = path.join(wsDir, 'fresh.pdf');
    fs.writeFileSync(p, makeMinimalPdf(['Alpha', 'Bravo']));
    const r = await run(getTool(tools, 'read_file'), { path: p });
    expect(r.isError).toBeFalsy();
    expect(r.content).toContain('Alpha');
    expect(r.content).toContain('Bravo');
  });

  it('extracts and reads a fresh xlsx in one call', async () => {
    const { tools, wsDir } = await buildTools();
    const p = path.join(wsDir, 'fresh.xlsx');
    fs.writeFileSync(p, makeMinimalXlsx({ rows: [['Name'], ['Ada']] }));
    const r = await run(getTool(tools, 'read_file'), { path: p });
    expect(r.isError).toBeFalsy();
    expect(r.content).toContain('Row 2: Ada');
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

describe('file-tools › ocr_file', () => {
  it('is omitted by default and available only when explicitly enabled', async () => {
    const defaultTools = await buildTools();
    expect(defaultTools.tools.some((tool) => tool.name === 'ocr_file')).toBe(false);

    const enabledTools = await buildTools({ includeOcrFile: true });
    expect(enabledTools.tools.some((tool) => tool.name === 'ocr_file')).toBe(true);
  });

  it('runs local OCR for images and returns OCR markdown', async () => {
    const mockOcr = vi.fn(async () => ({
      ok: true,
      content: '<ocr-file path="/x" kind="image" pages="1" engine="local:rapidocr-onnxruntime" cached="false">\nhello\n</ocr-file>',
      pages: [1],
      cached: false,
      engine: 'local:rapidocr-onnxruntime',
    }));
    vi.doMock('../../../../src/main/features/ocr_runtime', () => ({ ocrFile: mockOcr }));
    const { tools, wsDir } = await buildTools({ includeOcrFile: true });
    const p = path.join(wsDir, 'scan.png');
    const { Jimp } = await import('jimp' as any);
    const img: any = new Jimp({ width: 20, height: 20, color: 0xFFFFFFFF });
    fs.writeFileSync(p, await img.getBuffer('image/png'));

    const r = await run(getTool(tools, 'ocr_file'), { path: p });

    expect(r.isError).toBeFalsy();
    expect(r.content).toContain('hello');
    expect(mockOcr).toHaveBeenCalledWith(expect.objectContaining({
      userId: UID,
      absPath: p,
    }));
  });

  it('passes PDF page ranges to the local OCR runtime', async () => {
    const mockOcr = vi.fn(async () => ({
      ok: true,
      content: '<ocr-file path="/x" kind="pdf" pages="1,3" engine="local:rapidocr-onnxruntime" cached="false">\npage text\n</ocr-file>',
      pages: [1, 3],
      cached: false,
      engine: 'local:rapidocr-onnxruntime',
    }));
    vi.doMock('../../../../src/main/features/ocr_runtime', () => ({ ocrFile: mockOcr }));
    const { tools, wsDir } = await buildTools({ includeOcrFile: true });
    const p = path.join(wsDir, 'scan.pdf');
    fs.writeFileSync(p, makeMinimalPdf(['']));

    const r = await run(getTool(tools, 'ocr_file'), { path: p, pages: '1,3' });

    expect(r.isError).toBeFalsy();
    expect(mockOcr).toHaveBeenCalledWith(expect.objectContaining({ absPath: p, pages: '1,3' }));
  });

  it('surfaces local OCR runtime errors with process info', async () => {
    vi.doMock('../../../../src/main/features/ocr_runtime', () => ({
      ocrFile: vi.fn(async () => ({
        ok: false,
        errorCode: 'E_OCR_INSTALL_FAILED',
        message: 'Local OCR runtime install failed.',
        processLog: [
          'Preparing local OCR runtime',
          'Checking local OCR runtime',
          'Downloading and installing local OCR packages',
        ],
      })),
    }));
    const { tools, wsDir } = await buildTools({
      includeOcrFile: true,
      visionFallbackAvailable: true,
    });
    const p = path.join(wsDir, 'scan.pdf');
    fs.writeFileSync(p, makeMinimalPdf(['']));

    const r = await run(getTool(tools, 'ocr_file'), { path: p });

    expect(r.isError).toBe(true);
    expect(r.content).toContain('E_OCR_INSTALL_FAILED');
    expect(r.content).toContain('Local OCR runtime install failed');
    expect(r.content).toContain('<ocr-process>');
    expect(r.content).toContain('Downloading and installing local OCR packages');
    expect(r.content).toContain('<ocr-vision-fallback action="pdf_render"');
    expect(r.content).toContain('Do not retry ocr_file');
  });

  it('automatically returns the image to a vision model when local OCR fails', async () => {
    vi.doMock('../../../../src/main/features/ocr_runtime', () => ({
      ocrFile: vi.fn(async () => ({
        ok: false,
        errorCode: 'E_OCR_INSTALL_FAILED',
        message: 'Local OCR runtime install failed.',
        processLog: [],
      })),
    }));
    const { tools, wsDir } = await buildTools({
      includeOcrFile: true,
      visionFallbackAvailable: true,
    });
    const p = path.join(wsDir, 'scan.png');
    const { Jimp } = await import('jimp' as any);
    const img: any = new Jimp({ width: 20, height: 20, color: 0xFFFFFFFF });
    fs.writeFileSync(p, await img.getBuffer('image/png'));

    const r = await run(getTool(tools, 'ocr_file'), { path: p });

    expect(r.isError).toBeFalsy();
    expect(r.content).toContain('<ocr-vision-fallback');
    expect(r.content).toContain('action="inspect_attached_image"');
    expect(r.images).toHaveLength(1);
    expect(r.images[0].mediaType).toBe('image/jpeg');
  });

  it('reports the OCR failure without claiming a visual fallback on a text-only model', async () => {
    vi.doMock('../../../../src/main/features/ocr_runtime', () => ({
      ocrFile: vi.fn(async () => ({
        ok: false,
        errorCode: 'E_OCR_INSTALL_FAILED',
        message: 'Local OCR runtime install failed.',
        processLog: [],
      })),
    }));
    const { tools, wsDir } = await buildTools({
      includeOcrFile: true,
      visionFallbackAvailable: false,
    });
    const p = path.join(wsDir, 'scan.png');
    const { Jimp } = await import('jimp' as any);
    const img: any = new Jimp({ width: 20, height: 20, color: 0xFFFFFFFF });
    fs.writeFileSync(p, await img.getBuffer('image/png'));

    const r = await run(getTool(tools, 'ocr_file'), { path: p });

    expect(r.isError).toBe(true);
    expect(r.images).toBeUndefined();
    expect(r.content).toContain('E_OCR_INSTALL_FAILED');
    expect(r.content).not.toContain('<ocr-vision-fallback');
  });

  it('rejects unsupported file kinds before invoking OCR runtime', async () => {
    const mockOcr = vi.fn();
    vi.doMock('../../../../src/main/features/ocr_runtime', () => ({ ocrFile: mockOcr }));
    const { tools, wsDir } = await buildTools({ includeOcrFile: true });
    const p = path.join(wsDir, 'notes.docx');
    fs.writeFileSync(p, makeMinimalDocx({ paragraphs: ['not visual'] }));

    const r = await run(getTool(tools, 'ocr_file'), { path: p });

    expect(r.isError).toBe(true);
    expect(r.content).toContain('E_OCR_UNSUPPORTED_FILE');
    expect(mockOcr).not.toHaveBeenCalled();
  });
});

describe('file-tools › read_file scope guards', () => {
  it('rejects generic reads from the persisted tool-result root', async () => {
    const mod = await import('../../../../src/main/model/core-agent/file-tools');
    const resultRoot = path.join(tmpDir, 'tool-results');
    fs.mkdirSync(resultRoot, { recursive: true });
    const stored = path.join(resultRoot, 'web_fetch.0123456789abcdef.txt');
    fs.writeFileSync(stored, 'large stored result');
    const tools = mod.createFileTools({
      userId: UID,
      readOnlyExtraRoots: [resultRoot],
      toolResultsRoot: resultRoot,
    });
    const result = await run(getTool(tools, 'read_file'), { path: stored });
    expect(result.isError).toBe(true);
    expect(result.content).toContain('E_TOOL_RESULT_REF_REQUIRED');
    expect(result.content).toContain('tool_result');
  });

  it('rejects paths outside the scope with E_PATH_OUT_OF_SCOPE', async () => {
    const perm = await import('../../../../src/main/features/permissions');
    perm.setLocalExecMode('workspace_approval');
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

  it('allows direct paths outside the workspace in all_files_approval mode', async () => {
    const perm = await import('../../../../src/main/features/permissions');
    perm.setLocalExecMode('all_files_approval');
    const { tools } = await buildTools();
    const outside = path.join(tmpDir, '..', 'outside-allowed', 'note.md');
    fs.mkdirSync(path.dirname(outside), { recursive: true });
    fs.writeFileSync(outside, 'outside ok');
    try {
      const r = await run(getTool(tools, 'read_file'), { path: outside });
      expect(r.isError).toBeFalsy();
      expect(r.content).toContain('outside ok');
    } finally { fs.rmSync(path.dirname(outside), { recursive: true, force: true }); }
  });

  it('prompts and blocks sensitive outside paths in all_files_approval mode when denied', async () => {
    const perm = await import('../../../../src/main/features/permissions');
    const bashPerms = await import('../../../../src/main/model/core-agent/bash-permissions');
    perm.setLocalExecMode('all_files_approval');
    const { tools } = await buildTools();
    const outside = path.join(tmpDir, '..', 'outside-sensitive', 'id_rsa');
    fs.mkdirSync(path.dirname(outside), { recursive: true });
    fs.writeFileSync(outside, 'SECRET-FILE-TOOLS');
    let payload: any = null;
    bashPerms._setBroadcastForTest((_ch: string, info: any) => {
      payload = info;
      bashPerms.respond(info.request_id, 'deny');
    });
    try {
      const r = await run(getTool(tools, 'read_file'), { path: outside });
      expect(r.isError).toBe(true);
      expect(r.content).toContain('E_SENSITIVE_PATH_DENIED');
      expect(r.content).not.toContain('SECRET-FILE-TOOLS');
      expect(payload.operation).toBe('read_files');
      expect(payload.reasons).toEqual(['sensitive_path']);
    } finally {
      bashPerms._setBroadcastForTest(null);
      bashPerms._resetForTest();
      fs.rmSync(path.dirname(outside), { recursive: true, force: true });
    }
  });

  it('does not prompt for sensitive paths in all_files_auto mode', async () => {
    const perm = await import('../../../../src/main/features/permissions');
    const bashPerms = await import('../../../../src/main/model/core-agent/bash-permissions');
    perm.setLocalExecMode('all_files_auto');
    const { tools } = await buildTools();
    const outside = path.join(tmpDir, '..', 'outside-auto', 'id_rsa');
    fs.mkdirSync(path.dirname(outside), { recursive: true });
    fs.writeFileSync(outside, 'AUTO-SECRET');
    let prompted = false;
    bashPerms._setBroadcastForTest(() => { prompted = true; });
    try {
      const r = await run(getTool(tools, 'read_file'), { path: outside });
      expect(r.isError).toBeFalsy();
      expect(r.content).toContain('AUTO-SECRET');
      expect(prompted).toBe(false);
    } finally {
      bashPerms._setBroadcastForTest(null);
      fs.rmSync(path.dirname(outside), { recursive: true, force: true });
    }
  });

  it('reports E_NOT_FOUND for missing files inside scope', async () => {
    const { tools, wsDir } = await buildTools();
    const r = await run(getTool(tools, 'read_file'), { path: path.join(wsDir, 'ghost.md') });
    expect(r.isError).toBe(true);
    expect(r.content).toContain('E_NOT_FOUND');
    expect(r.content).toContain('<missing-file-recovery>');
    expect(r.content).toContain('ask for the correct accessible path or an attachment');
    expect(r.content).toContain('use search_files to locate the source');
  });

  it('allows project-scoped conversation attachments', async () => {
    const { tools, attDir } = await buildProjectTools();
    const p = path.join(attDir, 'project-note.md');
    fs.writeFileSync(p, 'project attachment body');

    const read = await run(getTool(tools, 'read_file'), { path: p });
    expect(read.isError).toBeFalsy();
    expect(read.content).toContain('project attachment body');

    const search = await run(getTool(tools, 'search_files'), { query: 'project-note' });
    expect(search.isError).toBeFalsy();
    expect(search.content).toContain('project-note.md');
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

  it('observes read-only roots appended after tool construction', async () => {
    const perm = await import('../../../../src/main/features/permissions');
    const ws = await import('../../../../src/main/features/user_workspace');
    const mod = await import('../../../../src/main/model/core-agent/file-tools');
    perm.setLocalExecMode('workspace_approval');
    const wsDir = path.join(tmpDir, 'ws');
    fs.mkdirSync(wsDir, { recursive: true });
    const workspace = ws.setWorkspacePath(UID, wsDir);
    if (!workspace.ok) throw new Error(`setWorkspacePath failed: ${workspace.error}`);

    const runtimeRoots: string[] = [];
    const tools = mod.createFileTools({
      userId: UID,
      cid: CID,
      runtimeReadOnlyRoots: runtimeRoots,
    });
    const referencedRoot = path.join(tmpDir, 'referenced-conversation');
    const referencedFile = path.join(referencedRoot, 'evidence.md');
    fs.mkdirSync(referencedRoot, { recursive: true });
    fs.writeFileSync(referencedFile, 'runtime reference body');

    const beforeAdmission = await run(getTool(tools, 'read_file'), { path: referencedFile });
    expect(beforeAdmission.isError).toBe(true);
    expect(beforeAdmission.content).toContain('E_PATH_OUT_OF_SCOPE');

    runtimeRoots.push(referencedRoot);
    const afterAdmission = await run(getTool(tools, 'read_file'), { path: referencedFile });
    expect(afterAdmission.isError).toBeFalsy();
    expect(afterAdmission.content).toContain('runtime reference body');
  });

  it('loads a run-scoped Skill entry, references, templates, assets, images, and scripts without rescanning paths', async () => {
    const ws = await import('../../../../src/main/features/user_workspace');
    const wsDir = path.join(tmpDir, 'ws');
    fs.mkdirSync(wsDir, { recursive: true });
    const workspace = ws.setWorkspacePath(UID, wsDir);
    if (!workspace.ok) throw new Error(`setWorkspacePath failed: ${workspace.error}`);

    const skillRoot = path.join(tmpDir, 'bound-skills', 'deep-research');
    const skillEntry = path.join(skillRoot, 'SKILL.md');
    const reference = path.join(skillRoot, 'references', 'workflow.md');
    const template = path.join(skillRoot, 'templates', 'report.md');
    const config = path.join(skillRoot, 'assets', 'settings.json');
    const image = path.join(skillRoot, 'assets', 'badge.png');
    const script = path.join(skillRoot, 'scripts', 'caps.py');
    fs.mkdirSync(path.dirname(reference), { recursive: true });
    fs.mkdirSync(path.dirname(template), { recursive: true });
    fs.mkdirSync(path.dirname(config), { recursive: true });
    fs.mkdirSync(path.dirname(script), { recursive: true });
    fs.writeFileSync(skillEntry, '---\nname: deep-research\n---\nmain workflow');
    fs.writeFileSync(reference, 'reference workflow');
    fs.writeFileSync(template, '# Report template\n{{findings}}\n');
    fs.writeFileSync(config, JSON.stringify({ mode: 'strict', limit: 2 }));
    const { Jimp } = await import('jimp' as any);
    const badge: any = new Jimp({ width: 12, height: 12, color: 0x336699FF });
    fs.writeFileSync(image, await badge.getBuffer('image/png'));
    fs.writeFileSync(script, 'print("caps")\n');
    const binding = {
      id: 'ee99fbb42964',
      name: 'deep-research',
      root: skillRoot,
      entry: skillEntry,
      source: 'platform',
    };
    const invoked: string[] = [];
    const mod = await import('../../../../src/main/model/core-agent/file-tools');
    const tools = mod.createFileTools({
      userId: UID,
      skillRuntimeBindings: new Map([
        ['deep-research', binding],
        ['ee99fbb42964', binding],
      ]),
      onSkillInvoked: (id) => invoked.push(id),
    });

    const entryResult = await run(getTool(tools, 'read_file'), { path: '@skill/deep-research' });
    const referenceResult = await run(getTool(tools, 'read_file'), {
      path: '@skill/deep-research/references/workflow.md',
    });
    const templateResult = await run(getTool(tools, 'read_file'), {
      path: '@skill/deep-research/templates/report.md',
    });
    const configResult = await run(getTool(tools, 'read_file'), {
      path: '@skill/ee99fbb42964/assets/settings.json',
    });
    const imageResult = await run(getTool(tools, 'read_file'), {
      path: '@skill/deep-research/assets/badge.png',
    });
    const scriptResult = await run(getTool(tools, 'read_file'), {
      path: '@skill/deep-research/scripts/caps.py',
    });

    expect(entryResult.isError).toBeFalsy();
    expect(entryResult.content).toContain('<skill-runtime execution_ref="deep-research">');
    expect(entryResult.content).toContain('already bound it to this Skill');
    expect(entryResult.content).toContain('path="@skill/deep-research"');
    expect(entryResult.content).toContain('main workflow');
    expect(referenceResult.isError).toBeFalsy();
    expect(referenceResult.content).toContain('reference workflow');
    expect(referenceResult.verbatimDocument).toBe(true);
    expect(templateResult.isError).toBeFalsy();
    expect(templateResult.content).toContain('{{findings}}');
    expect(configResult.isError).toBeFalsy();
    expect(configResult.content).toContain('"mode":"strict"');
    expect(imageResult.isError).toBeFalsy();
    expect(imageResult.content).toContain('path="@skill/deep-research/assets/badge.png"');
    expect(imageResult.images).toHaveLength(1);
    expect(imageResult.images[0].mediaType).toBe('image/jpeg');
    expect(scriptResult.isError).toBeFalsy();
    expect(scriptResult.content).toContain('print("caps")');
    for (const result of [referenceResult, templateResult, configResult, imageResult, scriptResult]) {
      expect(result.content).not.toContain('<skill-runtime execution_ref=');
    }
    for (const result of [entryResult, referenceResult, templateResult, configResult, imageResult, scriptResult]) {
      expect(result.content).not.toContain(skillRoot);
    }
    expect(invoked).toEqual(['ee99fbb42964']);
  });

  it('supports logical Skill refs in read_files, stat_file, list_files, search_files, and grep_files', async () => {
    const skillRoot = path.join(tmpDir, 'bound-skills', 'bundle');
    const skillEntry = path.join(skillRoot, 'SKILL.md');
    const reference = path.join(skillRoot, 'references', 'facts.md');
    fs.mkdirSync(path.dirname(reference), { recursive: true });
    fs.writeFileSync(skillEntry, '---\nname: bundle\n---\nentry body');
    fs.writeFileSync(reference, 'needle fact');
    const binding = { id: 'bundle-id', name: 'bundle', root: skillRoot, entry: skillEntry, source: 'custom' };
    const mod = await import('../../../../src/main/model/core-agent/file-tools');
    const tools = mod.createFileTools({
      userId: UID,
      skillRuntimeBindings: new Map([['bundle', binding]]),
    });
    const readFilesSchema = getTool(tools, 'read_files').inputSchema as any;
    expect(readFilesSchema.properties.paths.items.properties.path.description).toContain('@skill/<read-ref>');

    const batch = await run(getTool(tools, 'read_files'), {
      paths: [
        { path: '@skill/bundle' },
        { path: '@skill/bundle/references/facts.md' },
      ],
    });
    const stat = await run(getTool(tools, 'stat_file'), { path: '@skill/bundle/references/facts.md' });
    const list = await run(getTool(tools, 'list_files'), { path: '@skill/bundle/references' });
    const bareList = await run(getTool(tools, 'list_files'), { path: '@skill/bundle' });
    const search = await run(getTool(tools, 'search_files'), { root: '@skill/bundle/references', query: 'facts' });
    const bareSearch = await run(getTool(tools, 'search_files'), { root: '@skill/bundle', query: 'facts' });
    const grepTool = getTool(tools, 'grep_files');
    const grep = await run(grepTool, { root: '@skill/bundle/references', pattern: 'needle' });
    const bareGrep = await run(grepTool, { root: '@skill/bundle', pattern: 'needle' });
    const grepFiles = await run(grepTool, {
      root: '@skill/bundle/references',
      pattern: 'needle',
      output_mode: 'files',
    });
    const grepCount = await run(grepTool, {
      root: '@skill/bundle/references',
      pattern: 'needle',
      output_mode: 'count',
    });

    expect(batch.isError).toBeFalsy();
    expect(batch.content).toContain('entry body');
    expect(batch.content).toContain('needle fact');
    expect(stat.isError).toBeFalsy();
    expect(stat.content).toContain('path="@skill/bundle/references/facts.md"');
    expect(list.content).toContain('f facts.md');
    expect(bareList.isError).toBeFalsy();
    expect(bareList.content).toContain('f SKILL.md');
    expect(bareList.content).toContain('d references');
    expect(search.content).toContain('path=@skill/bundle/references/facts.md');
    expect(search.content).not.toContain(skillRoot);
    expect(bareSearch.content).toContain('path=@skill/bundle/references/facts.md');
    expect(bareSearch.content).not.toContain(skillRoot);
    for (const result of [grep, bareGrep, grepFiles, grepCount]) {
      expect(result.content).toContain('@skill/bundle/references/facts.md');
      expect(result.content).not.toContain(skillRoot);
    }
    expect(grep.content).toContain('needle fact');
  });

  it('prepends run-scoped entry context without changing other Skill reads', async () => {
    const skillRoot = path.join(tmpDir, 'bound-skills', 'contextual-skill');
    const skillEntry = path.join(skillRoot, 'SKILL.md');
    const reference = path.join(skillRoot, 'references', 'details.md');
    fs.mkdirSync(path.dirname(reference), { recursive: true });
    fs.writeFileSync(skillEntry, '---\nname: contextual-skill\n---\nentry instructions');
    fs.writeFileSync(reference, 'reference details');
    const binding = {
      id: 'contextual-skill',
      name: 'contextual-skill',
      root: skillRoot,
      entry: skillEntry,
      source: 'system',
      entryReadPrelude: '## Host-generated context\n\n- exact runtime fact',
    };
    const mod = await import('../../../../src/main/model/core-agent/file-tools');
    const tools = mod.createFileTools({
      userId: UID,
      skillRuntimeBindings: new Map([['contextual-skill', binding]]),
    });
    const readFile = getTool(tools, 'read_file');

    const entry = await run(readFile, { path: '@skill/contextual-skill' });
    const explicitEntry = await run(readFile, { path: '@skill/contextual-skill/SKILL.md' });
    const referenceResult = await run(readFile, { path: '@skill/contextual-skill/references/details.md' });
    const batch = await run(getTool(tools, 'read_files'), {
      paths: [
        { path: '@skill/contextual-skill' },
        { path: '@skill/contextual-skill/references/details.md' },
      ],
    });

    for (const result of [entry, explicitEntry]) {
      expect(result.isError).toBeFalsy();
      expect(result.content.indexOf('## Host-generated context')).toBeGreaterThanOrEqual(0);
      expect(result.content.indexOf('## Host-generated context'))
        .toBeLessThan(result.content.indexOf('<file '));
      expect(result.content).toContain('entry instructions');
    }
    expect(referenceResult.content).toContain('reference details');
    expect(referenceResult.content).not.toContain('## Host-generated context');
    expect(batch.content.match(/## Host-generated context/g)).toHaveLength(1);
    expect(fs.readFileSync(skillEntry, 'utf8')).not.toContain('Host-generated context');
  });

  it('keeps logical Skill refs in missing-path and OCR results without leaking installation roots', async () => {
    const skillRoot = path.join(tmpDir, 'bound-skills', 'private-layout');
    const skillEntry = path.join(skillRoot, 'SKILL.md');
    const image = path.join(skillRoot, 'assets', 'scan.png');
    fs.mkdirSync(path.dirname(image), { recursive: true });
    fs.writeFileSync(skillEntry, '---\nname: private-layout\n---\nentry body');
    const { Jimp } = await import('jimp' as any);
    const scan: any = new Jimp({ width: 12, height: 12, color: 0xFFFFFFFF });
    fs.writeFileSync(image, await scan.getBuffer('image/png'));
    const mockOcr = vi.fn(async ({ absPath }: { absPath: string }) => ({
      ok: true,
      content: `<ocr-file path="${absPath}" kind="image">recognized</ocr-file>`,
      pages: [1],
      cached: false,
      engine: 'test',
    }));
    vi.doMock('../../../../src/main/features/ocr_runtime', () => ({ ocrFile: mockOcr }));
    const binding = {
      id: 'private-layout-id',
      name: 'private-layout',
      root: skillRoot,
      entry: skillEntry,
      source: 'custom',
    };
    const mod = await import('../../../../src/main/model/core-agent/file-tools');
    const tools = mod.createFileTools({
      userId: UID,
      includeOcrFile: true,
      skillRuntimeBindings: new Map([['private-layout', binding]]),
    });

    const missingFile = await run(getTool(tools, 'read_file'), {
      path: '@skill/private-layout/assets/missing.json',
    });
    const missingStat = await run(getTool(tools, 'stat_file'), {
      path: '@skill/private-layout/assets/missing.json',
    });
    const missingList = await run(getTool(tools, 'list_files'), {
      path: '@skill/private-layout/missing',
    });
    const missingSearch = await run(getTool(tools, 'search_files'), {
      root: '@skill/private-layout/missing',
      query: 'anything',
    });
    const missingGrep = await run(getTool(tools, 'grep_files'), {
      root: '@skill/private-layout/missing',
      pattern: 'anything',
    });
    const ocr = await run(getTool(tools, 'ocr_file'), {
      path: '@skill/private-layout/assets/scan.png',
    });

    for (const result of [missingFile, missingStat, missingList, missingSearch, missingGrep]) {
      expect(result.isError).toBe(true);
      expect(result.content).toContain('@skill/private-layout/');
      expect(result.content).not.toContain(skillRoot);
    }
    expect(ocr.isError).toBeFalsy();
    expect(ocr.content).toContain('path="@skill/private-layout/assets/scan.png"');
    expect(ocr.content).toContain('recognized');
    expect(ocr.content).not.toContain(skillRoot);
    expect(mockOcr).toHaveBeenCalledWith(expect.objectContaining({ absPath: image }));
  });

  it('rejects unknown, traversal, and symlink-escape Skill refs before reading', async () => {
    const skillRoot = path.join(tmpDir, 'bound-skills', 'safe-skill');
    const skillEntry = path.join(skillRoot, 'SKILL.md');
    const outside = path.join(tmpDir, 'outside-secret.md');
    fs.mkdirSync(skillRoot, { recursive: true });
    fs.writeFileSync(skillEntry, 'safe skill');
    fs.writeFileSync(outside, 'outside secret');
    let symlinkCreated = true;
    try { fs.symlinkSync(outside, path.join(skillRoot, 'escape.md')); }
    catch { symlinkCreated = false; }
    const binding = { id: 'safe-id', name: 'safe-skill', root: skillRoot, entry: skillEntry, source: 'custom' };
    const mod = await import('../../../../src/main/model/core-agent/file-tools');
    const tools = mod.createFileTools({
      userId: UID,
      skillRuntimeBindings: new Map([['safe-skill', binding]]),
    });
    const readFile = getTool(tools, 'read_file');

    const unknown = await run(readFile, { path: '@skill/not-bound' });
    const traversal = await run(readFile, { path: '@skill/safe-skill/../outside-secret.md' });
    const escaped = symlinkCreated
      ? await run(readFile, { path: '@skill/safe-skill/escape.md' })
      : null;

    expect(unknown.content).toContain('E_SKILL_NOT_AVAILABLE');
    expect(traversal.content).toContain('E_SKILL_REF_INVALID');
    if (escaped) {
      expect(escaped.content).toContain('E_SKILL_PATH_OUT_OF_SCOPE');
      expect(escaped.content).not.toContain('outside secret');
    }
  });

  it('re-checks disabled state when a logical Skill ref is read', async () => {
    const paths = await import('../../../../src/main/paths');
    const enabled = await import('../../../../src/main/features/component_enabled');
    const skillRoot = path.join(paths.userSkillsDir(UID), 'disabled-logical');
    const skillEntry = path.join(skillRoot, 'SKILL.md');
    fs.mkdirSync(skillRoot, { recursive: true });
    fs.writeFileSync(skillEntry, 'secret logical workflow');
    enabled.setSkillEnabled(UID, 'disabled-logical', false);
    const binding = {
      id: 'disabled-logical',
      name: 'disabled-logical',
      root: skillRoot,
      entry: skillEntry,
      source: 'custom',
    };
    const mod = await import('../../../../src/main/model/core-agent/file-tools');
    const tools = mod.createFileTools({
      userId: UID,
      skillRuntimeBindings: new Map([['disabled-logical', binding]]),
    });

    const result = await run(getTool(tools, 'read_file'), { path: '@skill/disabled-logical' });
    expect(result.content).toContain('E_SKILL_DISABLED');
    expect(result.content).not.toContain('secret logical workflow');
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

  it('blocks read_file from loading a disabled external-package Skill', async () => {
    const ws = await import('../../../../src/main/features/user_workspace');
    const paths = await import('../../../../src/main/paths');
    const enabled = await import('../../../../src/main/features/component_enabled');
    const wsDir = path.join(tmpDir, 'ws');
    fs.mkdirSync(wsDir, { recursive: true });
    const r0 = ws.setWorkspacePath(UID, wsDir);
    if (!r0.ok) throw new Error(`setWorkspacePath failed: ${r0.error}`);

    const packagesRoot = paths.userPackagesDir(UID);
    const skillRoot = path.join(packagesRoot, 'pkg-tools', 'skills');
    const skillPath = path.join(skillRoot, 'external-disabled', 'SKILL.md');
    fs.mkdirSync(path.dirname(skillPath), { recursive: true });
    fs.writeFileSync(skillPath, '---\nname: External disabled\n---\nsecret external workflow');
    fs.writeFileSync(paths.userPackagesRegistryFile(UID), JSON.stringify({
      version: 1,
      packages: [{
        name: 'pkg-tools',
        kind: 'skill',
        skill_roots: ['skills'],
        bin_entries: [],
        enabled: true,
      }],
    }));
    enabled.setSkillEnabled(UID, 'external-disabled', false);

    const mod = await import('../../../../src/main/model/core-agent/file-tools');
    const tools = mod.createFileTools({ userId: UID, readOnlyExtraRoots: [skillRoot] });
    const r = await run(getTool(tools, 'read_file'), { path: skillPath });
    expect(r.isError).toBe(true);
    expect(r.content).toContain('E_SKILL_DISABLED');
    expect(r.content).not.toContain('secret external workflow');
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

describe('file-tools › read_files', () => {
  it('is the only model-visible file content/metadata reader', async () => {
    const { tools } = await buildTools();
    const names = tools.map((tool) => tool.name);
    expect(names).toContain('read_files');
    expect(names).not.toContain('read_file');
    expect(names).not.toContain('stat_file');
  });

  it('advertises and executes the same tagged range contract for every batch item', async () => {
    const { tools, wsDir } = await buildTools();
    const readFiles = getTool(tools, 'read_files');
    const schema = readFiles.inputSchema as any;
    const itemSchema = schema.properties.paths.items;
    expect(schema.required).toEqual(['paths']);
    expect(schema.properties.metadata_only.type).toBe('boolean');
    expect(schema.properties.raw_text).toMatchObject({
      type: 'boolean',
      description: expect.stringContaining('exact UTF-8 text'),
    });
    expect(schema.properties.raw_text.description).not.toContain('run_program only');
    expect(itemSchema.properties).not.toHaveProperty('charStart');
    expect(itemSchema.properties).not.toHaveProperty('lineStart');
    expect(itemSchema.properties.range).toMatchObject({
      type: 'object',
      additionalProperties: false,
      required: ['unit', 'start', 'end'],
    });

    const p = path.join(wsDir, 'batch-range.txt');
    fs.writeFileSync(p, 'one\ntwo\nthree\n');
    const result = await run(readFiles, {
      paths: [{ path: p, range: { unit: 'line', start: 2, end: 2 } }],
    });
    expect(result.isError).toBeFalsy();
    expect(result.content).toContain('2\ttwo');
    expect(result.content).not.toContain('1\tone');
    expect(result.observations?.fileReadBatch).toEqual({
      attempted: 1,
      succeeded: 1,
      failed: 0,
      failures: [],
    });
  });

  it('reads related slices together and keeps partial successes usable', async () => {
    const { tools, wsDir } = await buildTools();
    const first = path.join(wsDir, 'first.ts');
    const second = path.join(wsDir, 'second.ts');
    const missing = path.join(wsDir, 'missing.ts');
    fs.writeFileSync(first, 'export const first = 1;\n');
    fs.writeFileSync(second, 'export const second = 2;\n');

    const r = await run(getTool(tools, 'read_files'), {
      paths: [
        { path: first },
        { path: second, range: { unit: 'char', start: 7, end: 19 } },
        { path: missing },
      ],
    });

    expect(r.isError).toBeFalsy();
    expect(r.content).toContain('<read-files count="3" errors="1"');
    expect(r.content).toContain('export const first = 1');
    expect(r.content).toContain('const second');
    expect(r.content).toContain('E_NOT_FOUND');
    expect(r.observations?.fileReadBatch).toEqual({
      attempted: 3,
      succeeded: 2,
      failed: 1,
      failures: [{ index: 2, code: 'E_NOT_FOUND' }],
    });
  });

  it.each(['EACCES', 'EPERM'] as const)(
    'reports %s as permission denied without scanning the parent directory for renamed siblings',
    async (osCode) => {
      const { tools, wsDir } = await buildTools();
      const denied = path.join(wsDir, 'permission-denied.txt');
      fs.writeFileSync(denied, 'must not be read');
      const fault = faultStatForPath(denied, osCode);

      try {
        const result = await run(getTool(tools, 'read_files'), {
          paths: [{ path: denied }],
        });

        expect(result.isError).toBe(true);
        expect(result.content).toContain('E_PERMISSION_DENIED');
        expect(result.content).toContain(`os_code=${osCode}`);
        expect(result.content).not.toContain('E_NOT_FOUND');
        expect(result.content).not.toContain('<missing-file-recovery>');
        expect(result.content).not.toContain('<file-renamed-earlier>');
        expect(result.observations?.fileReadBatch).toEqual({
          attempted: 1,
          succeeded: 0,
          failed: 1,
          failures: [{ index: 0, code: 'E_PERMISSION_DENIED' }],
        });
        expect(fault.statAttempts).toEqual([denied]);
        expect(fault.parentReaddirAttempts).toEqual([]);
      } finally {
        fault.restore();
      }
    },
  );

  it('bounds omitted ranges to a 24K-character slice', async () => {
    const { tools, wsDir } = await buildTools();
    const large = path.join(wsDir, 'large.txt');
    fs.writeFileSync(large, 'x'.repeat(30_000));
    const r = await run(getTool(tools, 'read_files'), { paths: [{ path: large }] });
    expect(r.isError).toBeFalsy();
    expect(r.content).toContain('covered="0-24000"');
    expect(r.content.length).toBeLessThan(30_000);
  });

  it('returns the same exact machine-readable bulk text directly and inside run_program', async () => {
    const { tools, wsDir } = await buildTools({
      rawTextMaxBytes: 2 * 1024 * 1024,
    });
    const first = path.join(wsDir, 'day-01.jsonl');
    const second = path.join(wsDir, 'day-02.jsonl');
    const firstBody = `${Array.from({ length: 1200 }, (_, index) => JSON.stringify({ id: index, value: `第一批-${index}` })).join('\n')}\n`;
    const secondBody = `${Array.from({ length: 1200 }, (_, index) => JSON.stringify({ id: index + 1200, value: `第二批-${index}` })).join('\n')}\n`;
    expect(firstBody.length).toBeGreaterThan(24_000);
    fs.writeFileSync(first, firstBody, 'utf8');
    fs.writeFileSync(second, secondBody, 'utf8');
    const readFiles = getTool(tools, 'read_files');

    const direct = await readFiles.execute({
      paths: [{ path: first }, { path: second }],
      raw_text: true,
    }, { workingDir: wsDir, state: {} } as any);
    expect(direct.isError).toBeFalsy();

    const programmatic = await readFiles.execute({
      paths: [{ path: first }, { path: second }],
      raw_text: true,
    }, { workingDir: wsDir, state: { programmatic: true } } as any);
    expect(programmatic.isError).toBeFalsy();
    expect(programmatic.content).toBe(direct.content);
    const payload = JSON.parse(programmatic.content);
    expect(payload.files).toHaveLength(2);
    expect(payload.files[0]).toMatchObject({
      requested_path: first,
      ok: true,
      path: first,
      content: firstBody,
      total_chars: firstBody.length,
      file_hash: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
    });
    expect(payload.files[1].content).toBe(secondBody);
    expect(programmatic.content).not.toContain('<read-files');
    expect(programmatic.content).not.toContain('1\\t');
    expect(programmatic.observations?.fileReads).toHaveLength(2);
    expect(programmatic.observations?.fileReadBatch).toEqual({
      attempted: 2,
      succeeded: 2,
      failed: 0,
      failures: [],
    });

    const cap = await import('../../../../src/main/util/tool-result-cap');
    const toolResultsDir = path.join(tmpDir, 'tool-results');
    const final = cap.capToolResult('read_files', direct, {
      workingDir: wsDir,
      state: {
        [cap.TOOL_RESULT_INLINE_LEDGER_STATE_KEY]: {
          initialTokens: 1_000,
          remainingTokens: 1_000,
          perResultTokens: 1_000,
          verbatimDocumentTokens: 1_000,
        },
      },
    } as any, {
      maxInlineTokens: 1_000,
      toolResultsDir,
    });
    expect(final.persistedOutput?.ref).toMatch(/^read_files\.[a-f0-9]{64}$/);
    expect(final.content).toContain('chars omitted; full result is stored');
    expect(final.content.length).toBeLessThan(direct.content.length);
    expect(fs.readFileSync(final.persistedOutput!.path, 'utf8')).toBe(direct.content);
  });

  it('keeps raw_text input and result limits explicit and recoverable', async () => {
    const { tools, wsDir } = await buildTools({
      rawTextMaxBytes: 180,
    });
    const source = path.join(wsDir, 'source.txt');
    fs.writeFileSync(source, 'private-value-'.repeat(20), 'utf8');
    const readFiles = getTool(tools, 'read_files');

    const incompatible = await readFiles.execute({
      paths: [{ path: source, range: { unit: 'char', start: 0, end: 10 } }],
      raw_text: true,
    }, { workingDir: wsDir, state: {} } as any);
    expect(incompatible.isError).toBe(true);
    expect(incompatible.content).toContain('E_BAD_INPUT');

    const oversized = await readFiles.execute({
      paths: [{ path: source }],
      raw_text: true,
    }, { workingDir: wsDir, state: {} } as any);
    expect(oversized.isError).toBe(true);
    expect(oversized.content).toContain('E_RAW_TEXT_LIMIT');
    expect(oversized.content).not.toContain('private-value');
  });

  it('returns partial raw_text errors without dropping valid files', async () => {
    const { tools, wsDir } = await buildTools();
    const present = path.join(wsDir, 'present.txt');
    const missing = path.join(wsDir, 'missing.txt');
    fs.writeFileSync(present, 'usable source\n', 'utf8');

    const result = await getTool(tools, 'read_files').execute({
      paths: [{ path: present }, { path: missing }],
      raw_text: true,
    }, { workingDir: wsDir, state: {} } as any);
    expect(result.isError).toBeFalsy();
    const payload = JSON.parse(result.content);
    expect(payload.files[0]).toMatchObject({ ok: true, content: 'usable source\n' });
    expect(payload.files[1]).toMatchObject({ ok: false });
    expect(payload.files[1].error).toContain('E_NOT_FOUND');
    expect(result.observations?.fileReadBatch).toEqual({
      attempted: 2,
      succeeded: 1,
      failed: 1,
      failures: [{ index: 1, code: 'E_NOT_FOUND' }],
    });
  });

  it('pages and resumes a real >4 MiB UTF-8 file through the model-visible contract', async () => {
    const { tools, wsDir } = await buildTools();
    const readFiles = getTool(tools, 'read_files');
    const large = path.join(wsDir, 'large-streamed.log');
    const firstPage = `${'a'.repeat(23_990)}0123456789`;
    const secondPageMarker = '第二页开始🙂';
    const targetLine = '需要按行读取的目标';
    const body = `${firstPage}${secondPageMarker}\n${targetLine}\n${'z'.repeat(4_500_000)}`;
    fs.writeFileSync(large, body, 'utf8');
    expect(fs.statSync(large).size).toBeGreaterThan(4 * 1024 * 1024);

    const first = await run(readFiles, { paths: [{ path: large }] });
    expect(first.isError).toBeFalsy();
    expect(first.content).toContain('covered="0-24000"');
    expect(first.content).toContain('has_more="true"');
    expect(first.content).toContain('next_range="char:24000-48000"');
    expect(first.content).not.toContain(secondPageMarker);
    expect(first.content.length).toBeLessThan(30_000);

    const firstHash = /file_hash="([^"]+)"/.exec(first.content)?.[1];
    expect(firstHash).toMatch(/^sha256:[a-f0-9]{64}$/);
    const second = await run(readFiles, {
      paths: [{ path: large, range: { unit: 'char', start: 24_000, end: 48_000 } }],
    });
    expect(second.isError).toBeFalsy();
    expect(second.content).toContain('covered="24000-48000"');
    expect(second.content).toContain(secondPageMarker);
    expect(second.content).toContain(`file_hash="${firstHash}"`);
    expect(second.content.length).toBeLessThan(30_000);

    const line = await run(readFiles, {
      paths: [{ path: large, range: { unit: 'line', start: 2, end: 2 } }],
    });
    expect(line.isError).toBeFalsy();
    expect(line.content).toContain(`2\t${targetLine}`);
    expect(line.content).not.toContain('zzzzz');
    expect(line.content.length).toBeLessThan(2_000);
  });

  it('uses the current round token budget and returns a resumable prefix without Result Store spill', async () => {
    const { tools, wsDir } = await buildTools();
    const large = path.join(wsDir, 'large-cjk.txt');
    fs.writeFileSync(large, '需要继续读取的大文件内容。'.repeat(4_000));
    const cap = await import('../../../../src/main/util/tool-result-cap');
    const ledger = {
      initialTokens: 900,
      remainingTokens: 900,
      perResultTokens: 900,
      verbatimDocumentTokens: 900,
    };
    const ctx = {
      workingDir: wsDir,
      signal: undefined,
      state: { [cap.TOOL_RESULT_INLINE_LEDGER_STATE_KEY]: ledger },
    } as any;

    const raw = await getTool(tools, 'read_files').execute({ paths: [{ path: large }] }, ctx);
    expect(raw.content).toContain('has_more="true"');
    expect(raw.content).toMatch(/next_range="char:\d+-\d+"/);
    const final = cap.capToolResult('read_files', raw, ctx, {
      maxInlineTokens: cap.DEFAULT_INLINE_RESULT_TOKENS,
      toolResultsDir: path.join(tmpDir, 'tool-results'),
    });
    expect(final.persistedOutput).toBeUndefined();
    expect(final.content).toBe(raw.content);

    const continuation = /next_range="char:(\d+)-(\d+)"/.exec(raw.content);
    expect(continuation).toBeTruthy();
    const continuationStart = Number(continuation![1]);
    const continuationEnd = Number(continuation![2]);
    const nextCtx = {
      ...ctx,
      state: {
        [cap.TOOL_RESULT_INLINE_LEDGER_STATE_KEY]: {
          initialTokens: 900,
          remainingTokens: 900,
          perResultTokens: 900,
          verbatimDocumentTokens: 900,
        },
      },
    } as any;
    const next = await getTool(tools, 'read_files').execute({
      paths: [{
        path: large,
        range: { unit: 'char', start: continuationStart, end: continuationEnd },
      }],
    }, nextCtx);
    expect(next.isError).toBeFalsy();
    expect(next.content).toContain(`covered="${continuationStart}-`);
  });

  it('pages dense numeric data within budget and reconstructs the original without gaps', async () => {
    const { tools, wsDir } = await buildTools();
    const file = path.join(wsDir, 'records.csv');
    const body = 'record_id,quantity,price\n' + Array.from({ length: 300 }, (_, i) => (
      `REC-${String(i).padStart(5, '0')},${i % 10},12.75\n`
    )).join('');
    fs.writeFileSync(file, body);
    const cap = await import('../../../../src/main/util/tool-result-cap');
    const readFiles = getTool(tools, 'read_files');
    let offset = 0;
    let reconstructed = '';
    for (let page = 0; offset < body.length && page < 20; page++) {
      const ctx = { workingDir: wsDir, state: {
        [cap.TOOL_RESULT_INLINE_LEDGER_STATE_KEY]: {
          initialTokens: 1600, remainingTokens: 1600, perResultTokens: 1600,
        },
      } } as any;
      const raw = await readFiles.execute({ paths: [{
        path: file,
        ...(offset ? { range: { unit: 'char', start: offset, end: body.length } } : {}),
      }] }, ctx);
      expect(raw.isError).toBeFalsy();
      const covered = /covered="(\d+)-(\d+)"/.exec(raw.content)!;
      expect(Number(covered[1])).toBe(offset);
      const end = Number(covered[2]);
      expect(end).toBeGreaterThan(offset);
      const numbered = /<file [^\n]*>\n([\s\S]*?)\n<\/file>/.exec(raw.content)![1];
      const slice = numbered.replace(/^\d+\t/gm, '');
      expect(slice).toBe(body.slice(offset, end));
      // Independent o200k calibration: each complete data row costs 11 tokens
      // before the reader adds line numbers and metadata. A 1600-token page
      // must not contain hundreds of such rows under a chars/4 estimate.
      expect(slice.split('\n').length - 1).toBeLessThanOrEqual(Math.floor(1600 / 11));
      const bounded = cap.capToolResult('read_files', raw, ctx, {
        maxInlineTokens: 1600, toolResultsDir: path.join(tmpDir, 'tool-results'),
      });
      expect(bounded.persistedOutput).toBeUndefined();
      expect(bounded.content).toBe(raw.content);
      reconstructed += slice;
      offset = end;
      if (end < body.length) expect(raw.content).toContain(`next_range="char:${end}-`);
      else expect(raw.content).toContain('has_more="false"');
    }
    expect(reconstructed).toBe(body);
    expect(fs.readFileSync(file, 'utf8')).toBe(body);
  });

  it('reads skill documents whole and preserves their semantics across batch aggregation', async () => {
    const { tools, wsDir } = await buildTools();
    const ordinaryFile = path.join(wsDir, 'ordinary.md');
    fs.writeFileSync(ordinaryFile, 'ordinary notes\n');
    const readFiles = getTool(tools, 'read_files');
    const skillFiles = Array.from({ length: 5 }, (_, index) => {
      const file = path.join(wsDir, `batch-skill-${index}`, 'SKILL.md');
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, `---\nname: Batch ${index}\n---\n${'x'.repeat(30_000)}\nEND-SKILL-${index}\n`);
      return file;
    });
    const referenceFile = path.join(wsDir, 'reference-skill', 'references', 'nested', 'details.md');
    fs.mkdirSync(path.dirname(referenceFile), { recursive: true });
    fs.writeFileSync(path.join(wsDir, 'reference-skill', 'SKILL.md'), '---\nname: Reference skill\n---\nBody\n');
    fs.writeFileSync(referenceFile, `${'r'.repeat(30_000)}\nEND-NESTED-REFERENCE\n`);

    const withSkill = await run(readFiles, {
      paths: [...skillFiles.map((path) => ({ path })), { path: referenceFile }],
    });
    expect(withSkill.verbatimDocument).toBe(true);
    expect(withSkill.content.length).toBeGreaterThan(160_000);
    expect(withSkill.content).toContain('END-SKILL-4');
    expect(withSkill.content).toContain('END-NESTED-REFERENCE');

    const ordinaryOnly = await run(readFiles, { paths: [{ path: ordinaryFile }] });
    expect(ordinaryOnly.verbatimDocument).toBeUndefined();
  });
});

describe('file-tools › read_files metadata_only', () => {
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

  it('returns image metadata without loading an image body', async () => {
    const { tools, wsDir } = await buildTools();
    const p = path.join(wsDir, 'chart.png');
    const { Jimp } = await import('jimp' as any);
    const img: any = new Jimp({ width: 30, height: 30, color: 0xFF00FFFF });
    fs.writeFileSync(p, await img.getBuffer('image/png'));
    const r = await run(getTool(tools, 'stat_file'), { path: p });
    expect(r.isError).toBeFalsy();
    expect(r.content).toContain('kind="image"');
    expect(r.content).toMatch(/bytes="\d+"/);
    expect(r.images).toBeUndefined();
  });

  it('prepares and reports metadata for several rich documents in one call', async () => {
    const { tools, wsDir } = await buildTools();
    const pdf = path.join(wsDir, 'metadata.pdf');
    const sheet = path.join(wsDir, 'metadata.xlsx');
    fs.writeFileSync(pdf, makeMinimalPdf(['Prepared PDF']));
    fs.writeFileSync(sheet, makeMinimalXlsx({ rows: [['Name'], ['Ada']] }));

    const result = await run(getTool(tools, 'read_files'), {
      paths: [{ path: pdf }, { path: sheet }],
      metadata_only: true,
    });

    expect(result.isError).toBeFalsy();
    expect(result.content).toContain('metadata_only="true"');
    expect(result.content).toContain('kind="pdf"');
    expect(result.content).toContain('kind="spreadsheet"');
    expect(result.content.match(/total_chars="\d+"/g)).toHaveLength(2);
    expect(result.content).not.toContain('Prepared PDF');
    expect(result.content).not.toContain('Row 2: Ada');
  });

  it('limits rich-document extraction to two concurrent jobs across one batch', async () => {
    let active = 0;
    let peak = 0;
    vi.doMock('../../../../src/main/features/file_indexer', async (importOriginal) => {
      const actual = await importOriginal<typeof import('../../../../src/main/features/file_indexer')>();
      return {
        ...actual,
        statFile: async (_userId: string, absPath: string) => {
          active++;
          peak = Math.max(peak, active);
          await new Promise<void>((resolve) => setTimeout(resolve, 8));
          active--;
          const source = fs.statSync(absPath);
          return {
            kind: actual.kindOf(absPath),
            absPath,
            bytes: source.size,
            mtime: source.mtimeMs,
            source: 'workspace',
            totalChars: 42,
          };
        },
      };
    });

    const ws = await import('../../../../src/main/features/user_workspace');
    const wsDir = path.join(tmpDir, 'concurrency-ws');
    fs.mkdirSync(wsDir, { recursive: true });
    const selected = ws.setWorkspacePath(UID, wsDir);
    if (!selected.ok) throw new Error(`setWorkspacePath failed: ${selected.error}`);
    const mod = await import('../../../../src/main/model/core-agent/file-tools');
    const readFiles = getTool(mod.createFileTools({ userId: UID }), 'read_files');
    const files = Array.from({ length: 6 }, (_, index) => {
      const file = path.join(wsDir, `rich-${index}.pdf`);
      fs.writeFileSync(file, `%PDF-${index}`);
      return file;
    });

    const result = await run(readFiles, {
      paths: files.map((path) => ({ path })),
      metadata_only: true,
    });
    expect(result.isError).toBeFalsy();
    expect(result.content.match(/total_chars="42"/g)).toHaveLength(files.length);
    expect(peak).toBe(2);
  });

  it('rejects paths outside scope', async () => {
    const perm = await import('../../../../src/main/features/permissions');
    perm.setLocalExecMode('workspace_approval');
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
  it('respects repository ignore files while retaining tracked-style hidden source paths', async () => {
    const { tools, wsDir } = await buildTools();
    fs.mkdirSync(path.join(wsDir, '.git'), { recursive: true });
    fs.mkdirSync(path.join(wsDir, 'ignored'), { recursive: true });
    fs.mkdirSync(path.join(wsDir, '.github', 'workflows'), { recursive: true });
    fs.writeFileSync(path.join(wsDir, '.gitignore'), 'ignored/\n');
    fs.writeFileSync(path.join(wsDir, 'ignored', 'hidden-source.ts'), 'ignored needle\n');
    fs.writeFileSync(path.join(wsDir, '.github', 'workflows', 'check.yml'), 'name: check\n');

    const ignored = await run(getTool(tools, 'search_files'), { query: 'hidden-source' });
    expect(ignored.content).toContain('No matches');
    const hidden = await run(getTool(tools, 'search_files'), { query: 'check.yml' });
    expect(hidden.content).toContain(path.join('.github', 'workflows', 'check.yml'));
    const explicit = await run(getTool(tools, 'search_files'), {
      query: 'hidden-source',
      include_ignored: true,
    });
    expect(explicit.content).toContain('hidden-source.ts');
  });

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

  it.runIf(process.platform === 'darwin')('keeps a legacy privacy-protected workspace active without recursively scanning it', async () => {
    process.env.ORKAS_TCC_GUARD_FORCE = '1';
    const home = path.join(tmpDir, 'home');
    const downloads = path.join(home, 'Downloads');
    fs.mkdirSync(downloads, { recursive: true });
    fs.writeFileSync(path.join(downloads, 'secret-contract.md'), 'private');
    process.env.HOME = home;
    vi.resetModules();
    const users = await import('../../../../src/main/features/users');
    users.activateUser(UID);
    const paths = await import('../../../../src/main/paths');
    const cfgFile = paths.userWorkspaceConfigFile(UID);
    fs.mkdirSync(path.dirname(cfgFile), { recursive: true });
    fs.writeFileSync(cfgFile, JSON.stringify({
      selectedPath: downloads,
      updatedAt: '2026-07-03T00:00:00.000Z',
      recentPaths: [],
    }), 'utf8');
    const ws = await import('../../../../src/main/features/user_workspace');
    expect(ws.getWorkspacePath(UID)).toBe(downloads);
    fs.mkdirSync(attachmentDir(), { recursive: true });
    const mod = await import('../../../../src/main/model/core-agent/file-tools');
    const tools = mod.createFileTools({ userId: UID, cid: CID });

    const r = await run(getTool(tools, 'search_files'), { query: '' });

    expect(r.isError).toBeFalsy();
    expect(r.content).toContain('No files were scanned in the privacy-protected workspace');
    expect(r.content).not.toContain('secret-contract.md');
  });

  it('lists results most-recently-modified first', async () => {
    const { tools, wsDir } = await buildTools();
    for (const f of ['old.md', 'mid.md', 'new.md']) fs.writeFileSync(path.join(wsDir, f), 'x');
    const base = 1_700_000_000; // seconds
    fs.utimesSync(path.join(wsDir, 'old.md'), base, base);
    fs.utimesSync(path.join(wsDir, 'mid.md'), base + 100, base + 100);
    fs.utimesSync(path.join(wsDir, 'new.md'), base + 200, base + 200);
    const r = await run(getTool(tools, 'search_files'), { query: '*.md' });
    expect(r.isError).toBeFalsy();
    const iNew = r.content.indexOf('new.md');
    const iMid = r.content.indexOf('mid.md');
    const iOld = r.content.indexOf('old.md');
    expect(iNew).toBeGreaterThanOrEqual(0);
    expect(iNew).toBeLessThan(iMid);    // newest first
    expect(iMid).toBeLessThan(iOld);
  });
});

describe('file-tools › search_files root shape', () => {
  it('names the two usable calls when root is a file', async () => {
    // Widening to the parent would read siblings this call never gated, so the
    // refusal stands; what changes is that the message says what to do next.
    const { tools, wsDir } = await buildTools();
    const file = path.join(wsDir, 'app.js');
    fs.writeFileSync(file, 'console.log(1)');
    const r = await run(getTool(tools, 'search_files'), { pattern: 'app', root: file });
    expect(r.isError).toBe(true);
    expect(r.content).toContain('E_NOT_DIRECTORY');
    expect(r.content).toContain('grep_files');
    expect(r.content).toContain(path.dirname(file));
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

  // The model reaches for `root: <a file>` often enough that refusing it cost a
  // round trip every time, and the two cases in production both retried the
  // same shape before recovering.
  it('records the observed target type without reading a special file', async () => {
    const { tools, wsDir } = await buildTools();
    const target = path.join(wsDir, 'special.txt');
    fs.writeFileSync(target, 'private body');
    const mutableFs = nodeRequire('node:fs') as typeof fs;
    const original = mutableFs.statSync;
    const stat = original(target);
    const spy = vi.spyOn(mutableFs, 'statSync').mockImplementation(((value: any, ...args: any[]) => {
      if (String(value) === target) return Object.assign(Object.create(stat), { isFile: () => false, isDirectory: () => false });
      return (original as any)(value, ...args);
    }) as any);
    syncBuiltinESMExports();
    try {
      const result = await run(getTool(tools, 'grep_files'), { root: target, pattern: 'private' });
      expect(result.isError).toBe(true);
      expect(result.observations?.fileFailure).toEqual({ code: 'E_NOT_DIRECTORY', reason: 'target_type', stage: 'stat', target_type: 'other' });
      expect(result.content).not.toContain('private body');
      expect(JSON.stringify(result.observations)).not.toContain(target);
    } finally { spy.mockRestore(); syncBuiltinESMExports(); }
    expect(fs.readFileSync(target, 'utf8')).toBe('private body');
  });

  it('searches inside a single file when root names one', async () => {
    const { tools, wsDir } = await buildTools();
    fs.writeFileSync(path.join(wsDir, 'a.md'), 'line with banana\nother line');
    fs.writeFileSync(path.join(wsDir, 'b.md'), 'banana lives here too');
    const r = await run(getTool(tools, 'grep_files'), {
      pattern: 'banana',
      root: path.join(wsDir, 'a.md'),
    });
    expect(r.isError).toBeFalsy();
    expect(r.content).toContain('a.md:1');
    // Naming a file must narrow the scan, never widen it to the directory.
    expect(r.content).not.toContain('b.md');
  });

  it('reports no match inside a single file without claiming an error', async () => {
    const { tools, wsDir } = await buildTools();
    fs.writeFileSync(path.join(wsDir, 'a.md'), 'nothing relevant');
    const r = await run(getTool(tools, 'grep_files'), {
      pattern: 'banana',
      root: path.join(wsDir, 'a.md'),
    });
    expect(r.isError).toBeFalsy();
    expect(r.content).not.toContain('E_NOT_DIRECTORY');
  });

  it('rejects invalid regex under regex=true', async () => {
    const { tools } = await buildTools();
    const r = await run(getTool(tools, 'grep_files'), { pattern: '(', regex: true });
    expect(r.isError).toBe(true);
    expect(r.content).toContain('E_BAD_INPUT');
  });

  it('glob without "/" scopes by basename at any depth', async () => {
    const { tools, wsDir } = await buildTools();
    fs.writeFileSync(path.join(wsDir, 'a.md'), 'banana');
    fs.writeFileSync(path.join(wsDir, 'a.txt'), 'banana');
    const r = await run(getTool(tools, 'grep_files'), { pattern: 'banana', glob: '*.md' });
    expect(r.isError).toBeFalsy();
    expect(r.content).toContain('a.md');
    expect(r.content).not.toContain('a.txt');
  });

  it('glob with "/" matches the root-relative path', async () => {
    const { tools, wsDir } = await buildTools();
    fs.mkdirSync(path.join(wsDir, 'sub'), { recursive: true });
    fs.writeFileSync(path.join(wsDir, 'sub', 'x.md'), 'banana');
    fs.writeFileSync(path.join(wsDir, 'top.md'), 'banana');
    const r = await run(getTool(tools, 'grep_files'), { pattern: 'banana', glob: 'sub/**' });
    expect(r.isError).toBeFalsy();
    expect(r.content).toContain(path.join('sub', 'x.md'));
    expect(r.content).not.toContain('top.md');
  });

  it('output_mode "files" returns file paths only (no line snippets)', async () => {
    const { tools, wsDir } = await buildTools();
    fs.writeFileSync(path.join(wsDir, 'a.md'), 'banana\nbanana again');
    fs.writeFileSync(path.join(wsDir, 'b.md'), 'banana');
    const r = await run(getTool(tools, 'grep_files'), { pattern: 'banana', output_mode: 'files' });
    expect(r.isError).toBeFalsy();
    expect(r.content).toContain('a.md');
    expect(r.content).toContain('b.md');
    expect(r.content).toContain('file(s) with matches');
    expect(r.content).not.toMatch(/a\.md:\d/);   // no per-line snippet form
  });

  it('output_mode "count" reports matches per file', async () => {
    const { tools, wsDir } = await buildTools();
    fs.writeFileSync(path.join(wsDir, 'a.md'), 'banana\nbanana again\nno');
    const r = await run(getTool(tools, 'grep_files'), { pattern: 'banana', output_mode: 'count' });
    expect(r.isError).toBeFalsy();
    expect(r.content).toMatch(/a\.md: 2/);
  });

  it('reports no glob match distinctly', async () => {
    const { tools, wsDir } = await buildTools();
    fs.writeFileSync(path.join(wsDir, 'a.md'), 'banana');
    const r = await run(getTool(tools, 'grep_files'), { pattern: 'banana', glob: '*.nope' });
    expect(r.isError).toBeFalsy();
    expect(r.content).toContain('No files matched glob');
  });

  it('supports include/exclude globs, case sensitivity, line columns, and context', async () => {
    const { tools, wsDir } = await buildTools();
    fs.mkdirSync(path.join(wsDir, 'src'), { recursive: true });
    fs.mkdirSync(path.join(wsDir, 'vendor'), { recursive: true });
    fs.writeFileSync(path.join(wsDir, 'src', 'main.ts'), 'before\nNeedle here\nafter\nneedle lower\n');
    fs.writeFileSync(path.join(wsDir, 'vendor', 'skip.ts'), 'Needle vendor\n');
    const r = await run(getTool(tools, 'grep_files'), {
      pattern: 'Needle',
      case_sensitive: true,
      include_glob: ['**/*.ts'],
      exclude_glob: ['vendor/**'],
      context_lines: 1,
      max_results: 1,
    });
    expect(r.isError).toBeFalsy();
    expect(r.content).toContain(`${path.join('src', 'main.ts')}:2:1`);
    expect(r.content).toContain('before');
    expect(r.content).toContain('after');
    expect(r.content).not.toContain('needle lower');
    expect(r.content).not.toContain('vendor');
    expect(r.content).toContain('capped at 1');
  });
});
