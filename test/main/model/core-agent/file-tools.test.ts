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

function searchResults(content: string): {
  roots: string[];
  files: Array<{ root: number; path: string; name: string; size: number; mtime: string; source: string; total_chars?: number }>;
} {
  return JSON.parse(content.slice(content.indexOf('{')));
}

async function buildTools(options: {
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

describe('file-tools › Skill reference validation', () => {
  it.each([false, true])('distinguishes malformed and unavailable refs without changing valid reads (raw=%s)', async (rawText) => {
    const root = path.join(tmpDir, 'ref-fixture');
    fs.mkdirSync(root);
    fs.writeFileSync(path.join(root, 'SKILL.md'), 'protocol sentinel');
    fs.writeFileSync(path.join(root, 'part},{.txt'), 'child sentinel');
    const { bindRuntimeSkillTarget } = await import('../../../../src/main/model/core-agent/skill-registry');
    const bindings = new Map();
    const ref = bindRuntimeSkillTarget({ id: 'ref-fixture', name: 'system:skill-creator.v1_2+test@host', root, entry: path.join(root, 'SKILL.md'), source: 'system' }, bindings);
    expect(ref).toBe('system:skill-creator.v1_2+test@host');
    const { createFileTools } = await import('../../../../src/main/model/core-agent/file-tools');
    const tool = createFileTools({ userId: UID, skillRuntimeBindings: bindings }).find(t => t.name === 'read_files')!;
    const ctx = { workingDir: tmpDir, state: {} } as any;
    for (const requested of [`@skill/${ref}`, `@skill/${ref}/part},{.txt`]) {
      const result = await tool.execute({ paths: [{ path: requested }], raw_text: rawText }, ctx);
      expect(result.isError).toBeFalsy();
      expect(result.content).toContain('sentinel');
    }
    for (const suffix of ['},{', ' extra', '%7D', '\"', '<ref>', '']) {
      const requested = suffix ? `@skill/${ref}${suffix}` : '@skill/';
      const input = { paths: [{ path: requested }], raw_text: rawText };
      const result = await tool.execute(input, ctx);
      expect(result.isError).toBe(true);
      expect(result.content).toContain('E_SKILL_REF_INVALID');
      expect(result.content).not.toContain('sentinel');
      expect(result.observations?.fileFailure).toEqual({ code: 'E_SKILL_REF_INVALID', reason: 'skill_ref_format', stage: 'input', skill_ref_valid: false, item_index: 0 });
      expect(input.paths[0].path).toBe(requested);
    }
    const missing = await tool.execute({ paths: [{ path: '@skill/missing' }], raw_text: rawText }, ctx);
    expect(missing.content).toContain('E_SKILL_NOT_AVAILABLE');
    expect(missing.observations?.fileFailure).toMatchObject({ skill_ref_valid: true, skill_binding_found: false });
    // Partial success still preserves the failed item's classification and index.
    const mixed = await tool.execute({ paths: [{ path: `@skill/${ref}` }, { path: '@skill/skill-creator},{' }], raw_text: rawText }, ctx);
    expect(mixed.isError).toBeFalsy();
    expect(mixed.content).toContain('protocol sentinel');
    expect(mixed.observations?.fileFailure).toMatchObject({ code: 'E_SKILL_REF_INVALID', item_index: 1 });
  });

  it('rejects malformed references consistently at directory, search and source-loading boundaries', async () => {
    const { createFileTools, createProgramSourceLoader } = await import('../../../../src/main/model/core-agent/file-tools');
    const opts = { userId: UID, skillRuntimeBindings: new Map() };
    const tools = createFileTools(opts);
    const ctx = { workingDir: tmpDir, state: {} } as any;
    for (const name of ['list_files', 'search_files', 'grep_files']) {
      const result = await tools.find(t => t.name === name)!.execute({ path: '@skill/skill-creator},{', root: '@skill/skill-creator},{', query: 'sample', pattern: 'sample' }, ctx);
      expect(result.content).toContain('E_SKILL_REF_INVALID');
      expect(result.isError).toBe(true);
      expect(result.observations?.fileFailure).toMatchObject({ skill_ref_valid: false });
    }
    const source = await createProgramSourceLoader(opts)('@skill/skill-creator},{', ctx, 100);
    expect(source).toMatchObject({ status: 'denied', code: 'E_PROGRAM_SOURCE_PATH', reason: expect.stringContaining('E_SKILL_REF_INVALID') });
  });
});

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
    const { tools, wsDir } = await buildTools();
    const recordsDir = path.join(wsDir, 'inputs', 'records');
    const notePath = path.join(recordsDir, 'note.txt');
    const scanPath = path.join(wsDir, 'inputs', 'scan.png');
    fs.mkdirSync(recordsDir, { recursive: true });
    fs.writeFileSync(notePath, 'relative-path-marker\n', 'utf8');
    const { Jimp } = await import('jimp' as any);
    const image: any = new Jimp({ width: 12, height: 12, color: 0xFFFFFFFF });
    fs.writeFileSync(scanPath, await image.getBuffer('image/png'));

    const readFiles = getTool(tools, 'read_files');
    const listFiles = getTool(tools, 'list_files');
    const searchFiles = getTool(tools, 'search_files');
    const grepFiles = getTool(tools, 'grep_files');
    const pathDescriptions = [
      (readFiles.inputSchema as any).properties.paths.items.properties.path.description,
      (listFiles.inputSchema as any).properties.path.description,
      (searchFiles.inputSchema as any).properties.root.description,
      (grepFiles.inputSchema as any).properties.root.description,
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
    const preview = await readFiles.execute({ paths: [{ path: 'inputs/scan.png' }] }, ctx);

    expect(read.isError).toBeFalsy();
    expect(read.content).toContain('relative-path-marker');
    expect(list.isError).toBeFalsy();
    expect(list.content).toContain('d records');
    expect(search.isError).toBeFalsy();
    expect(search.content).toContain('note.txt');
    expect(grep.isError).toBeFalsy();
    expect(grep.content).toContain('relative-path-marker');
    expect(preview.isError).toBeFalsy();
    expect(preview.images).toHaveLength(1);
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
    expect(result.isError).toBeFalsy();
    expect(result.content).toContain('<read-files count="2" errors="1"');
    expect(result.content).toContain('private body');
    expect(result.observations?.fileReadBatch).toEqual({
      attempted: 2, succeeded: 1, failed: 1, failures: [{ index: 1, code: 'E_BAD_INPUT' }],
    });
    expect(result.observations?.fileFailure).toMatchObject({ code: 'E_BAD_INPUT', reason, stage: 'input', item_index: 1, ...facts });
    expect(JSON.stringify(result.observations?.fileFailure)).not.toContain('private');
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
  it('renders image-only PDF pages for vision after reporting empty extraction, without an OCR tool', async () => {
    const { tools, wsDir } = await buildTools();
    const { PDFDocument } = await import('pdf-lib');
    const { Jimp } = await import('jimp' as any);
    const scan: any = new Jimp({ width: 30, height: 30, color: 0xFF0000FF });
    const document = await PDFDocument.create();
    const image = await document.embedPng(await scan.getBuffer('image/png'));
    document.addPage([30, 30]).drawImage(image, { x: 0, y: 0, width: 30, height: 30 });
    const file = path.join(wsDir, 'scan.pdf');
    const original = await document.save();
    fs.writeFileSync(file, original);

    const read = await run(getTool(tools, 'read_file'), { path: file });
    expect(read.isError).toBeFalsy();
    expect(read.content).toContain('extraction="empty_pages"');
    expect(tools.some((tool) => tool.name === 'ocr_file')).toBe(false);
    const { createPdfTools } = await import('../../../../src/main/model/core-agent/pdf-tools');
    const render = getTool(createPdfTools({ userId: UID, cid: CID }), 'pdf_render');
    const result = await render.execute({ path: file, page: 1 }, { workingDir: wsDir } as any);
    expect(result.isError).toBeFalsy();
    expect(result.images).toHaveLength(1);
    const pixels = await Jimp.read(Buffer.from(result.images![0].data, 'base64'));
    expect(pixels.getPixelColor(15, 15)).toBe(0xFF0000FF);
    expect(fs.readFileSync(file)).toEqual(Buffer.from(original));
  });
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

  it('reads a real XLS through read_files with complete sheet content', async () => {
    const { tools, wsDir } = await buildTools();
    const bytes = fs.readFileSync(path.join(__dirname, '../../../fixtures/xls/inventory.xls'));
    const file = path.join(wsDir, 'inventory.xls');
    fs.writeFileSync(file, bytes);
    const result = await run(getTool(tools, 'read_files'), { paths: [{ path: file }] });
    expect(result.isError).toBeFalsy();
    expect(result.content).toContain('00123');
    expect(result.content).toContain('冷却泵');
    expect(result.content).toContain('Inventory sentinel 8384');
    expect(fs.readFileSync(file)).toEqual(bytes);
  });

  it('returns E_UNSUPPORTED_FILE for legacy Office formats', async () => {
    const { tools, wsDir } = await buildTools();
    const p = path.join(wsDir, 'legacy.doc');
    fs.writeFileSync(p, Buffer.from('legacy'));
    const r = await run(getTool(tools, 'stat_file'), { path: p });
    expect(r.isError).toBe(true);
    expect(r.content).toContain('E_UNSUPPORTED_FILE');
  });
});

describe('file-tools › reference media reads', () => {
  it('reports video metadata but never treats a referenced MP4 as observed text', async () => {
    const { wsDir } = await buildTools();
    const referenceDir = path.join(tmpDir, 'referenced-chat');
    fs.mkdirSync(referenceDir);
    const video = path.join(referenceDir, 'reference.mp4');
    const bytes = Buffer.from('\0\0ftypisom\0binary-media-sentinel');
    fs.writeFileSync(video, bytes);
    const note = path.join(wsDir, 'brief.md');
    fs.writeFileSync(note, 'Target product facts');
    const mod = await import('../../../../src/main/model/core-agent/file-tools');
    const tools = mod.createFileTools({ userId: UID, cid: CID, readOnlyExtraRoots: [referenceDir] });
    const read = getTool(tools, 'read_files');
    const metadata = await run(read, { paths: [{ path: video }], metadata_only: true });
    expect(metadata.isError).toBeFalsy();
    expect(metadata.content).toContain('kind="video"');
    expect(metadata.content).not.toContain('total_chars=');
    const mixed = await run(read, { paths: [{ path: video }, { path: note }] });
    expect(mixed.content).toContain('errors="1"');
    expect(mixed.content).toContain('E_NO_TEXT');
    expect(mixed.content).toContain('Target product facts');
    expect(mixed.content).not.toContain('binary-media-sentinel');
    expect(mixed.observations?.fileReads?.some((item: any) => item.path === video)).toBeFalsy();
    const raw = await run(read, { paths: [{ path: video }], raw_text: true });
    expect(raw.content).toContain('E_RAW_TEXT_UNSUPPORTED');
    expect(raw.content).not.toContain('binary-media-sentinel');
    expect(fs.readFileSync(video)).toEqual(bytes);
  });
});

describe('file-tools › read_file (image)', () => {
  it('preserves reference colors in the model-facing image bytes', async () => {
    const { tools, wsDir } = await buildTools();
    const p = path.join(wsDir, 'chart.png');
    const { Jimp } = await import('jimp' as any);
    const img: any = new Jimp({ width: 50, height: 50, color: 0x336699FF });
    fs.writeFileSync(p, await img.getBuffer('image/png'));
    const original = fs.readFileSync(p);
    const r = await run(getTool(tools, 'read_files'), { paths: [{ path: p }] });
    expect(r.isError).toBeFalsy();
    expect(Array.isArray(r.images)).toBe(true);
    expect(r.images.length).toBe(1);
    expect(r.images[0].mediaType).toBe('image/jpeg');
    const decoded = await Jimp.read(Buffer.from(r.images[0].data, 'base64'));
    const { r: red, g: green, b: blue } = (await import('jimp' as any)).intToRGBA(decoded.getPixelColor(25, 25));
    expect(blue - red).toBeGreaterThan(70);
    expect(green - red).toBeGreaterThan(30);
    expect(r.content).not.toMatch(/gray/i);
    expect(fs.readFileSync(p)).toEqual(original);
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

  it.each(['darwin', 'linux', 'win32'] as const)('provides a platform-correct Skill command without exposing installation paths: %s', async platform => {
    const { renderSkillExecutionReadPrelude } = await import('../../../../src/main/model/core-agent/file-tools');
    const hint = renderSkillExecutionReadPrelude('bound-reader', platform);
    const command = platform === 'win32'
      ? '& "$env:ORKAS_NODE" "$env:ORKAS_PC_DIR/bin/run-skill.cjs"'
      : '"$ORKAS_NODE" "$ORKAS_PC_DIR/bin/run-skill.cjs"';
    expect(hint).toContain(command + " 'bound-reader' <script-basename> -- <args...>");
    expect(hint).toContain('execution_ref="bound-reader"');
    expect(hint.length).toBeLessThan(450);
    const quoted = renderSkillExecutionReadPrelude("reader's & notes", platform);
    expect(quoted).toContain(platform === 'win32' ? "'reader''s & notes'" : "'reader'\"'\"'s & notes'");
    expect(quoted).toContain('execution_ref="reader\'s &amp; notes"');
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
    expect(batch.content).not.toContain('<skill-runtime execution_ref=');
    expect(batch.content).toContain('needle fact');
    expect(stat.isError).toBeFalsy();
    expect(stat.content).toContain('path="@skill/bundle/references/facts.md"');
    expect(list.content).toContain('f facts.md');
    expect(bareList.isError).toBeFalsy();
    expect(bareList.content).toContain('f SKILL.md');
    expect(bareList.content).toContain('d references');
    for (const result of [search, bareSearch]) {
      const { roots, files } = searchResults(result.content);
      const address = path.posix.join(roots[files[0].root], files[0].path);
      expect(address).toBe('@skill/bundle/references/facts.md');
      const read = await run(getTool(tools, 'read_files'), { paths: [{ path: address }] });
      expect(read.isError, read.content).toBeFalsy();
      expect(read.content).toContain('needle fact');
    }
    expect(search.content).not.toContain(skillRoot);
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

  it('keeps logical Skill refs in missing-path and image results without leaking installation roots', async () => {
    const skillRoot = path.join(tmpDir, 'bound-skills', 'private-layout');
    const skillEntry = path.join(skillRoot, 'SKILL.md');
    const image = path.join(skillRoot, 'assets', 'scan.png');
    fs.mkdirSync(path.dirname(image), { recursive: true });
    fs.writeFileSync(skillEntry, '---\nname: private-layout\n---\nentry body');
    const { Jimp } = await import('jimp' as any);
    const scan: any = new Jimp({ width: 12, height: 12, color: 0xFFFFFFFF });
    fs.writeFileSync(image, await scan.getBuffer('image/png'));
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
    const preview = await run(getTool(tools, 'read_file'), {
      path: '@skill/private-layout/assets/scan.png',
    });

    for (const result of [missingFile, missingStat, missingList, missingSearch, missingGrep]) {
      expect(result.isError).toBe(true);
      expect(result.content).toContain('@skill/private-layout/');
      expect(result.content).not.toContain(skillRoot);
    }
    expect(preview.isError).toBeFalsy();
    expect(preview.content).toContain('path="@skill/private-layout/assets/scan.png"');
    expect(preview.images).toHaveLength(1);
    expect(preview.content).not.toContain(skillRoot);
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

  it('re-checks Skill enablement on each public batch read without rebuilding bindings', async () => {
    const paths = await import('../../../../src/main/paths');
    const enabled = await import('../../../../src/main/features/component_enabled');
    const skillRoot = path.join(paths.userSkillsDir(UID), 'disabled-logical');
    const skillEntry = path.join(skillRoot, 'SKILL.md');
    fs.mkdirSync(skillRoot, { recursive: true });
    fs.writeFileSync(skillEntry, 'secret logical workflow');
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

    const readFiles = getTool(tools, 'read_files');
    const input = { paths: [{ path: '@skill/disabled-logical' }] };
    const initial = await run(readFiles, input);
    expect(initial.isError).toBeFalsy();
    expect(initial.content).toContain('secret logical workflow');

    enabled.setSkillEnabled(UID, 'disabled-logical', false);
    const blocked = await run(readFiles, input);
    expect(blocked.isError).toBe(true);
    expect(blocked.content).toContain('E_SKILL_DISABLED');
    expect(blocked.content).not.toContain('secret logical workflow');
    expect(blocked.observations?.fileReadBatch).toMatchObject({ attempted: 1, succeeded: 0, failed: 1 });

    enabled.setSkillEnabled(UID, 'disabled-logical', true);
    const restored = await run(readFiles, input);
    expect(restored.isError).toBeFalsy();
    expect(restored.content).toContain('secret logical workflow');
    expect(restored.observations?.fileReadBatch).toMatchObject({ attempted: 1, succeeded: 1, failed: 0 });
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
  it.each(['text', 'metadata', 'raw'] as const)('keeps valid %s items before and after invalid inputs and missing files', async (mode) => {
    const { tools, wsDir } = await buildTools();
    const first = path.join(wsDir, 'first.txt');
    const last = path.join(wsDir, 'last.txt');
    const invalid = path.join(wsDir, 'invalid.txt');
    fs.writeFileSync(first, 'FIRST-PRESERVED\n');
    fs.writeFileSync(last, 'LAST-PRESERVED\n');
    fs.writeFileSync(invalid, 'MUST-NOT-READ\n');
    const fault = faultStatForPath(invalid, 'EACCES');
    try {
      const result = await run(getTool(tools, 'read_files'), {
        paths: [
          { path: first },
          { path: invalid, range: { unit: 'line', start: 9, end: 2 } },
          { path: 123 },
          { path: path.join(wsDir, 'missing.txt') },
          { path: last },
        ],
        ...(mode === 'metadata' ? { metadata_only: true } : {}),
        ...(mode === 'raw' ? { raw_text: true } : {}),
      });
      expect(result.isError).toBeFalsy();
      expect(result.observations?.fileReadBatch).toEqual({
        attempted: 5, succeeded: 2, failed: 3,
        failures: [{ index: 1, code: 'E_BAD_INPUT' }, { index: 2, code: 'E_BAD_INPUT' }, { index: 3, code: 'E_NOT_FOUND' }],
      });
      expect(fault.statAttempts).toEqual([]);
      expect(result.content).not.toContain('MUST-NOT-READ');
      if (mode === 'raw') {
        const files = JSON.parse(result.content).files;
        expect(files.map((file: any) => file.ok)).toEqual([true, false, false, false, true]);
        expect(files[0]).toMatchObject({ requested_path: first, content: 'FIRST-PRESERVED\n' });
        expect(files[4]).toMatchObject({ requested_path: last, content: 'LAST-PRESERVED\n' });
        expect(files[1].error).toContain('E_BAD_INPUT');
      } else {
        expect(result.content).toContain('<read-files count="5" errors="3"');
        const blocks = [...result.content.matchAll(/<read-result index="(\d+)" ok="(true|false)">([\s\S]*?)<\/read-result>/g)];
        expect(blocks.map((match) => [match[1], match[2]])).toEqual([
          ['0', 'true'], ['1', 'false'], ['2', 'false'], ['3', 'false'], ['4', 'true'],
        ]);
        expect(blocks[1][3]).toContain('start=9');
        expect(blocks[1][3]).toContain('end=2');
        if (mode === 'text') {
          expect(blocks[0][3]).toContain('FIRST-PRESERVED');
          expect(blocks[4][3]).toContain('LAST-PRESERVED');
        } else {
          expect(blocks[0][3]).toContain('total_chars="16"');
          expect(blocks[4][3]).toContain('total_chars="15"');
          expect(result.content).not.toContain('FIRST-PRESERVED');
        }
      }
      expect(result.observations?.fileReads.map((read: any) => read.path)).toEqual(mode === 'metadata' ? [] : [first, last]);
    } finally { fault.restore(); }
  });

  it.each([false, true])('reports every invalid item when the whole batch fails (raw_text=%s)', async (rawText) => {
    const { tools, wsDir } = await buildTools();
    const target = path.join(wsDir, 'invalid.txt');
    fs.writeFileSync(target, 'MUST-NOT-READ');
    const fault = faultStatForPath(target, 'EACCES');
    try {
      const result = await run(getTool(tools, 'read_files'), {
        paths: [
          { path: target, range: { unit: 'line', start: 8, end: 2 } },
          { path: target, range: null },
          {},
          null,
        ],
        raw_text: rawText,
      });
      expect(result.isError).toBe(true);
      expect(result.observations?.fileReadBatch).toEqual({
        attempted: 4, succeeded: 0, failed: 4,
        failures: [0, 1, 2, 3].map((index) => ({ index, code: 'E_BAD_INPUT' })),
      });
      expect(result.observations?.fileReads).toEqual([]);
      expect(fault.statAttempts).toEqual([]);
      if (rawText) {
        expect(JSON.parse(result.content).files.map((file: any) => file.ok)).toEqual([false, false, false, false]);
      } else {
        expect(result.content).toContain('<read-files count="4" errors="4"');
        expect(result.content.match(/ok="false"/g)).toHaveLength(4);
      }
    } finally { fault.restore(); }
  });

  it('keeps scope rejection isolated without granting access to an invalid or outside item', async () => {
    const perm = await import('../../../../src/main/features/permissions');
    perm.setLocalExecMode('workspace_approval');
    const { tools, wsDir } = await buildTools();
    const allowed = path.join(wsDir, 'allowed.txt');
    const outside = path.join(tmpDir, 'outside.txt');
    fs.writeFileSync(allowed, 'ALLOWED-CONTENT');
    fs.writeFileSync(outside, 'OUTSIDE-CONTENT');
    const result = await run(getTool(tools, 'read_files'), {
      paths: [
        { path: allowed, range: { unit: 'line', start: 2, end: 1 } },
        { path: outside },
        { path: allowed },
      ],
    });
    expect(result.isError).toBeFalsy();
    expect(result.content).toContain('ALLOWED-CONTENT');
    expect(result.content).not.toContain('OUTSIDE-CONTENT');
    expect(result.observations?.fileReads.map((read: any) => read.path)).toEqual([allowed]);
    expect(result.observations?.fileReadBatch).toEqual({
      attempted: 3, succeeded: 1, failed: 2,
      failures: [{ index: 0, code: 'E_BAD_INPUT' }, { index: 1, code: 'E_PATH_OUT_OF_SCOPE' }],
    });
  });

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
    const { toToolDefinition } = await import('../../../../src/core-agent/src/tools');
    const schema = toToolDefinition(readFiles).inputSchema as any;
    const itemSchema = schema.properties.paths.items;
    expect(schema.required).toEqual(['paths']);
    expect(schema.properties.metadata_only.type).toBe('boolean');
    expect(schema.properties.raw_text).toMatchObject({
      type: 'boolean',
      description: expect.stringContaining('complete UTF-8 text'),
    });
    expect(readFiles.description).toMatch(/ranges.*structure or samples/);
    expect(readFiles.description).toMatch(/raw_text when complete original text is needed/);
    expect(schema.properties.raw_text.description).not.toContain('run_program only');
    expect(itemSchema.properties).not.toHaveProperty('charStart');
    expect(itemSchema.properties).not.toHaveProperty('lineStart');
    expect(itemSchema.properties.path).toMatchObject({ type: 'string', minLength: 1 });
    expect(itemSchema.properties.range).toMatchObject({
      type: 'object',
      additionalProperties: false,
      required: ['unit', 'start', 'end'],
      properties: {
        start: { type: 'integer', minimum: 0 },
        end: { type: 'integer', minimum: 0 },
      },
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

  it.each(['line', 'char'] as const)('marks a complete %s request complete even when the file continues', async (unit) => {
    const { tools, wsDir } = await buildTools();
    const file = path.join(wsDir, 'section.txt');
    fs.writeFileSync(file, 'first\nsecond\nthird');
    const range = unit === 'line' ? { unit, start: 1, end: 2 } : { unit, start: 0, end: 12 };
    const result = await run(getTool(tools, 'read_files'), { paths: [{ path: file, range }] });
    expect(result.isError).toBeFalsy();
    expect(result.content).toContain('request_complete="true"');
    expect(result.content).toContain('has_more="true"');
    expect(result.content).not.toContain('remaining_request_range=');
    expect(result.content).toContain('second');
    expect(result.content).not.toContain('third');
  });

  it.each([
    { body: '', range: { unit: 'line', start: 1, end: 35 } },
    { body: 'last', range: { unit: 'line', start: 1, end: 35 } },
    { body: 'last', range: { unit: 'char', start: 1, end: 100 } },
    { body: 'last', range: { unit: 'line', start: 20, end: 35 } },
  ])('treats EOF as completion rather than budget truncation: $range', async ({ body, range }) => {
    const { tools, wsDir } = await buildTools();
    const file = path.join(wsDir, 'end.txt');
    fs.writeFileSync(file, body);
    const result = await run(getTool(tools, 'read_files'), { paths: [{ path: file, range }] });
    expect(result.isError).toBeFalsy();
    expect(result.content).toContain('request_complete="true"');
    expect(result.content).toContain('has_more="false"');
    expect(result.content).not.toContain('remaining_request_range=');
  });

  it.each(['line', 'char'] as const)('resumes a budget-clipped %s request exactly without reading beyond it', async (unit) => {
    const { tools, wsDir } = await buildTools();
    const file = path.join(wsDir, 'clipped.txt');
    const wanted = '请求内容'.repeat(300);
    const body = `before\n${wanted}\nAFTER-REQUEST`;
    fs.writeFileSync(file, body);
    const cap = await import('../../../../src/main/util/tool-result-cap');
    const ctx = { workingDir: wsDir, state: {
      [cap.TOOL_RESULT_INLINE_LEDGER_STATE_KEY]: {
        initialTokens: 900, remainingTokens: 900, perResultTokens: 900,
      },
    } } as any;
    const readFiles = getTool(tools, 'read_files');
    const range = unit === 'line' ? { unit, start: 2, end: 2 } : { unit, start: 7, end: 1207 };
    const first = await readFiles.execute({ paths: [{ path: file, range }] }, ctx);
    expect(first.isError).toBeFalsy();
    expect(first.content).toContain('request_complete="false"');
    const remainder = /remaining_request_range="char:(\d+)-(\d+)"/.exec(first.content);
    expect(remainder).not.toBeNull();
    const start = Number(remainder![1]);
    expect(start).toBeGreaterThan(7);
    expect(start).toBeLessThan(1207);
    expect(Number(remainder![2])).toBe(1207);
    const bounded = cap.capToolResult('read_files', first, ctx, {
      maxInlineTokens: 900, toolResultsDir: path.join(tmpDir, 'tool-results'),
    });
    expect(bounded.content).toBe(first.content);
    expect(bounded.persistedOutput).toBeUndefined();
    const next = await run(readFiles, { paths: [{ path: file, range: { unit: 'char', start, end: 1207 } }] });
    expect(next.content).toContain('request_complete="true"');
    expect(next.content).not.toContain('remaining_request_range=');
    const plain = (content: string) => /<file [^\n]*>\n([\s\S]*?)\n<\/file>/.exec(content)![1].replace(/^\d+\t/gm, '');
    expect(plain(first.content) + plain(next.content)).toBe(wanted);
    expect(first.content + next.content).not.toContain('AFTER-REQUEST');
    expect(fs.readFileSync(file, 'utf8')).toBe(body);
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
    expect(first.content).toContain('request_complete="true"');
    expect(first.content).not.toContain('remaining_request_range=');
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
    expect(raw.content).toContain('request_complete="false"');
    expect(raw.content).toMatch(/remaining_request_range="char:\d+-24000"/);
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

  it.each([false, true])('keeps parallel read pages independent with ample headroom (Skill: %s)', async (skill) => {
    const { tools, wsDir } = await buildTools();
    const cap = await import('../../../../src/main/util/tool-result-cap');
    const { calculateToolResultInlineBudget } = await import('../../../../src/core-agent/src/agent/runner');
    const count = skill ? 2 : 3;
    const bodies = Array.from({ length: count }, (_, i) => String.fromCharCode(97 + i).repeat(skill ? 80_000 : 28_000));
    const files = bodies.map((body, i) => {
      const file = path.join(wsDir, `source-${i}`, skill ? 'SKILL.md' : 'report.txt');
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, body);
      return file;
    });
    const headroom = calculateToolResultInlineBudget({
      requestTokensBeforeResults: 2_000, usableInputTokens: 120_000, toolCallCount: count,
    });
    const ctx = { workingDir: wsDir, state: {
      [cap.TOOL_RESULT_INLINE_LEDGER_STATE_KEY]: {
        initialTokens: headroom, remainingTokens: headroom,
        perResultTokens: 10_000, verbatimDocumentTokens: 25_000,
      },
    } };
    const readFiles = getTool(tools, 'read_files');
    const results = await Promise.all(files.map(async (file, i) => {
      const raw = await readFiles.execute({ paths: [{
        path: file, range: { unit: 'char', start: 0, end: bodies[i].length },
      }] }, ctx);
      return cap.capToolResult('read_files', raw, ctx, {
        maxInlineTokens: 10_000, toolResultsDir: path.join(tmpDir, 'parallel-results'),
      });
    }));
    for (let i = 0; i < count; i++) {
      expect(results[i].persistedOutput).toBeUndefined();
      expect(results[i].isError).toBeFalsy();
      expect(results[i].content).toContain(bodies[i]);
      expect(results[i].content).toContain('request_complete="true"');
      expect(cap.estimateToolResultTokens(results[i].content)).toBeLessThanOrEqual(skill ? 25_000 : 10_000);
    }
  });

  it.each(['SKILL.md', 'references/guide.md'])(
    'keeps a 16K Skill document complete through read and final admission (%s)', async (relativePath) => {
      const { tools, wsDir } = await buildTools();
      const root = path.join(wsDir, 'large-skill');
      const file = path.join(root, relativePath);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(path.join(root, 'SKILL.md'), '---\nname: Large Skill\n---\nRead references/guide.md.\n');
      const body = `---\nname: Large Skill\n---\n${'x'.repeat(64_000)}\nCRITICAL-END-RULE\n`;
      fs.writeFileSync(file, body);
      const cap = await import('../../../../src/main/util/tool-result-cap');
      const policy = await import('../../../../src/core-agent/src/agent/context-budget');
      const ctx = { workingDir: wsDir, state: {
        [cap.TOOL_RESULT_INLINE_LEDGER_STATE_KEY]: {
          initialTokens: 60_000, remainingTokens: 60_000,
          perResultTokens: policy.MAX_PER_RESULT_INLINE_TOKENS,
          verbatimDocumentTokens: policy.MAX_VERBATIM_DOCUMENT_INLINE_TOKENS,
        },
      } };
      const raw = await getTool(tools, 'read_files').execute({ paths: [{ path: file }] }, ctx);
      expect(raw.verbatimDocument).toBe(true);
      expect(cap.estimateToolResultTokens(raw.content)).toBeGreaterThan(12_500);
      const result = cap.capToolResult('read_files', raw, ctx, {
        maxInlineTokens: cap.DEFAULT_INLINE_RESULT_TOKENS,
        toolResultsDir: path.join(tmpDir, 'fixed-budget-results'),
      });
      expect(result.persistedOutput).toBeUndefined();
      expect(result.content).toBe(raw.content);
      expect(result.content).toContain('CRITICAL-END-RULE');
      expect(result.content).toContain('x'.repeat(64_000));
    },
  );

  it.each([
    ['50K-token ASCII long line', 'x'.repeat(200_000)],
    ['CJK and emoji', '读完🙂ab\n'.repeat(5_000)],
  ])('pages an oversized Skill without losing content: %s', async (_label, body) => {
    const { tools, wsDir } = await buildTools();
    const file = path.join(wsDir, 'paged', 'SKILL.md');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, body);
    const cap = await import('../../../../src/main/util/tool-result-cap');
    let offset = 0;
    let reconstructed = '';
    let range: { unit: string; start: number; end: number } | undefined;
    for (let page = 0; offset < body.length && page < 30; page++) {
      const ctx = { workingDir: wsDir, state: {
        [cap.TOOL_RESULT_INLINE_LEDGER_STATE_KEY]: {
          initialTokens: 60_000, remainingTokens: 60_000,
          perResultTokens: 10_000, verbatimDocumentTokens: 25_000,
        },
      } };
      const raw = await getTool(tools, 'read_files').execute({ paths: [{ path: file, ...(range ? { range } : {}) }] }, ctx);
      expect(raw.isError, raw.content).toBeFalsy();
      expect(raw.verbatimDocument).toBe(true);
      expect(cap.estimateToolResultTokens(raw.content)).toBeLessThanOrEqual(25_000);
      const covered = /covered="(\d+)-(\d+)"/.exec(raw.content)!;
      const end = Number(covered[2]);
      expect(Number(covered[1])).toBe(offset);
      expect(end).toBeGreaterThan(offset);
      const slice = /<file [^\n]*>\n([\s\S]*?)\n<\/file>/.exec(raw.content)![1].replace(/^\d+\t/gm, '');
      expect(slice).toBe(body.slice(offset, end));
      expect(Buffer.from(slice).toString('utf8')).toBe(slice);
      expect(raw.observations.fileReads[0].charRange).toEqual([offset, end]);
      const requestedEnd = range?.end ?? body.length;
      expect(raw.content).toContain(`request_complete="${end === requestedEnd}"`);
      if (end < requestedEnd) expect(raw.content).toContain(`remaining_request_range="char:${end}-${requestedEnd}"`);
      const admitted = cap.capToolResult('read_files', raw, ctx, {
        maxInlineTokens: 10_000, toolResultsDir: path.join(tmpDir, 'paged-results'),
      });
      expect(admitted.persistedOutput).toBeUndefined();
      expect(admitted.content).toBe(raw.content);
      reconstructed += slice;
      offset = end;
      if (end < body.length) {
        const next = /next_range="char:(\d+)-(\d+)"/.exec(raw.content)!;
        range = { unit: 'char', start: Number(next[1]), end: Number(next[2]) };
      } else expect(raw.content).toContain('has_more="false"');
    }
    expect(reconstructed).toBe(body);
    expect(fs.readFileSync(file, 'utf8')).toBe(body);
  });

  it.each([['Skill', false], ['Skill', true], ['ordinary', true]] as const)(
    'bounds %s preparation for million-character input (line request=%s)', async (kind, lineRequest) => {
    const prepared: Array<{ chars: number; requestedEnd?: number }> = [];
    vi.doMock('../../../../src/main/features/file_indexer', async (importOriginal) => {
      const actual = await importOriginal<typeof import('../../../../src/main/features/file_indexer')>();
      return { ...actual, readRange: async (...args: Parameters<typeof actual.readRange>) => {
        const result = await actual.readRange(...args);
        prepared.push({ chars: result.content.length, requestedEnd: result.requestedCharEnd });
        return result;
      } };
    });
    const { tools, wsDir } = await buildTools();
    const file = path.join(wsDir, kind === 'Skill' ? 'SKILL.md' : 'ordinary.txt');
    const line = 'x'.repeat(1_000_000);
    const body = `head\n${line}\nTAIL`;
    fs.writeFileSync(file, body);
    const cap = await import('../../../../src/main/util/tool-result-cap');
    const ceiling = kind === 'Skill' ? 25_000 : 10_000;
    const ctx = { workingDir: wsDir, state: {
      [cap.TOOL_RESULT_INLINE_LEDGER_STATE_KEY]: {
        initialTokens: 60_000, remainingTokens: 60_000,
        perResultTokens: 10_000, verbatimDocumentTokens: 25_000,
      },
    } };
    const raw = await getTool(tools, 'read_files').execute({ paths: [{
      path: file, ...(lineRequest ? { range: { unit: 'line', start: 2, end: 2 } } : {}),
    }] }, ctx);
    expect(prepared).toHaveLength(1);
    expect(prepared[0].chars).toBeLessThanOrEqual(kind === 'Skill' ? 100_000 : 40_000);
    const start = lineRequest ? 5 : 0;
    const requestedEnd = lineRequest ? 1_000_005 : body.length;
    expect(prepared[0].requestedEnd).toBe(requestedEnd);
    const covered = /covered="(\d+)-(\d+)"/.exec(raw.content)!;
    expect(Number(covered[1])).toBe(start);
    const end = Number(covered[2]);
    expect(end).toBeGreaterThan(start);
    expect(raw.content).toContain('request_complete="false"');
    expect(raw.content).toContain(`remaining_request_range="char:${end}-${requestedEnd}"`);
    const returned = /<file [^\n]*>\n([\s\S]*?)\n<\/file>/.exec(raw.content)![1].replace(/^\d+\t/gm, '');
    expect(returned).toBe(body.slice(start, end));
    expect(cap.estimateToolResultTokens(raw.content)).toBeLessThanOrEqual(ceiling);
    const admitted = cap.capToolResult('read_files', raw, ctx, {
      maxInlineTokens: 10_000, toolResultsDir: path.join(tmpDir, 'bounded-line-results'),
    });
    expect(admitted.persistedOutput).toBeUndefined();
    expect(admitted.content).toBe(raw.content);
  });

  it.each([3_000, 400, 0])('includes bound Skill preludes in the remaining %i-token allowance', async (remainingTokens) => {
    const { wsDir } = await buildTools();
    const root = path.join(wsDir, 'bounded-skill');
    fs.mkdirSync(path.join(root, 'scripts'), { recursive: true });
    const entry = path.join(root, 'SKILL.md');
    const body = 'header\n' + '🙂'.repeat(20_000) + '\nlast rule';
    fs.writeFileSync(entry, body);
    const prelude = 'Host context. '.repeat(300);
    const mod = await import('../../../../src/main/model/core-agent/file-tools');
    const onSkillInvoked = vi.fn();
    const tools = mod.createFileTools({ userId: UID, onSkillInvoked,
      skillRuntimeBindings: new Map([['bounded', {
        id: 'bounded', name: 'bounded', source: 'custom', root, entry, entryReadPrelude: prelude,
      }]]),
    });
    const cap = await import('../../../../src/main/util/tool-result-cap');
    const ctx = { workingDir: wsDir, state: {
      readFileState: new Map(),
      [cap.TOOL_RESULT_INLINE_LEDGER_STATE_KEY]: {
        initialTokens: 60_000, remainingTokens, perResultTokens: 10_000, verbatimDocumentTokens: 25_000,
      },
    } };
    const raw = await getTool(tools, 'read_files').execute({ paths: [{
      path: '@skill/bounded', range: { unit: 'line', start: 2, end: 2 },
    }] }, ctx);
    if (remainingTokens === 0) {
      expect(raw.isError).toBe(true);
      expect(raw.content).toContain('E_READ_BUDGET');
      expect(raw.content).not.toContain('<file ');
      expect(raw.observations.fileReads).toEqual([]);
      expect(onSkillInvoked).not.toHaveBeenCalled();
    } else if (remainingTokens === 400) {
      expect(raw.isError).toBeFalsy();
      expect(raw.content).toContain('covered="7-7"');
      expect(raw.content).toContain('request_complete="false"');
      expect(raw.content).toContain(`remaining_request_range="char:7-${body.indexOf('\nlast')}"`);
      expect(raw.content).not.toContain(prelude.trim());
      expect(raw.observations.fileReads).toEqual([]);
      expect(onSkillInvoked).not.toHaveBeenCalled();
    } else {
      expect(raw.isError).toBeFalsy();
      expect(raw.content).toContain(prelude.trim());
      expect(cap.estimateToolResultTokens(raw.content)).toBeLessThanOrEqual(remainingTokens);
      const [start, end] = raw.observations.fileReads[0].charRange;
      expect(start).toBe('header\n'.length);
      expect(end).toBeGreaterThan(start);
      expect((end - start) % 2).toBe(0);
      expect(raw.content).toContain('request_complete="false"');
      expect(raw.content).toContain(`remaining_request_range="char:${end}-${body.indexOf('\nlast')}"`);
      expect(onSkillInvoked).toHaveBeenCalledWith('bounded', 'A.custom', 'read_file');
    }
    expect(ctx.state.readFileState.has(entry)).toBe(remainingTokens >= 1_000);
    const admitted = cap.capToolResult('read_files', raw, ctx, {
      maxInlineTokens: 10_000, toolResultsDir: path.join(tmpDir, 'bounded-results'),
    });
    expect(admitted.persistedOutput).toBeUndefined();
    expect(admitted.content).toBe(raw.content);
  });

  it('preserves exact raw Skill text and lets final admission persist the complete JSON', async () => {
    const { tools, wsDir } = await buildTools();
    const file = path.join(wsDir, 'raw-skill', 'SKILL.md');
    const body = 'Skill instructions\n' + 'x'.repeat(120_000) + '\nEND-RULE';
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, body);
    const cap = await import('../../../../src/main/util/tool-result-cap');
    const ctx = { workingDir: wsDir, state: {
      [cap.TOOL_RESULT_INLINE_LEDGER_STATE_KEY]: {
        initialTokens: 60_000, remainingTokens: 60_000,
        perResultTokens: 10_000, verbatimDocumentTokens: 25_000,
      },
    } };
    const raw = await getTool(tools, 'read_files').execute({ paths: [{ path: file }], raw_text: true }, ctx);
    expect(JSON.parse(raw.content).files[0].content).toBe(body);
    const admitted = cap.capToolResult('read_files', raw, ctx, {
      maxInlineTokens: 10_000, toolResultsDir: path.join(tmpDir, 'raw-skill-results'),
    });
    expect(admitted.persistedOutput).toBeDefined();
    expect(fs.readFileSync(admitted.persistedOutput!.path, 'utf8')).toBe(raw.content);
  });

  it.each([
    ['Skill', false, 25_000],
    ['Skill', true, 25_000],
    ['ordinary', false, 10_000],
    ['ordinary', true, 10_000],
  ] as const)('spends the %s batch allowance in request order (overflow=%s)', async (kind, overflow, ceiling) => {
    // Complete the second read first: preparation must stay concurrent while
    // delivery priority follows the request, not I/O completion order.
    let started = 0;
    const completed: number[] = [];
    let releaseFirst!: () => void;
    const secondFinished = new Promise<void>(resolve => { releaseFirst = resolve; });
    vi.doMock('../../../../src/main/features/file_indexer', async (importOriginal) => {
      const actual = await importOriginal<typeof import('../../../../src/main/features/file_indexer')>();
      return { ...actual, readRange: async (...args: Parameters<typeof actual.readRange>) => {
        const index = started++;
        if (index === 0) await secondFinished;
        const result = await actual.readRange(...args);
        completed.push(index);
        if (index === 1) releaseFirst();
        return result;
      } };
    });
    const { tools, wsDir } = await buildTools();
    const bodies = [kind === 'Skill' ? 'a'.repeat(80_000) : '中'.repeat(5_200),
      'b'.repeat(overflow ? 24_000 : 4_000)];
    const files = bodies.map((body, index) => {
      const file = kind === 'Skill'
        ? path.join(wsDir, `ordered-${index}`, 'SKILL.md')
        : path.join(wsDir, `ordered-${index}.txt`);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, body);
      return file;
    });
    const cap = await import('../../../../src/main/util/tool-result-cap');
    const makeContext = () => ({ workingDir: wsDir, state: {
      [cap.TOOL_RESULT_INLINE_LEDGER_STATE_KEY]: {
        initialTokens: 60_000, remainingTokens: 60_000,
        perResultTokens: 10_000, verbatimDocumentTokens: 25_000,
      },
    } });
    const ctx = makeContext();
    const reader = getTool(tools, 'read_files');
    const raw = await reader.execute({ paths: files.map(path => ({ path })) }, ctx);
    expect(started).toBe(2);
    expect(completed).toEqual([1, 0]);
    const pages = [...raw.content.matchAll(/<file ([^\n]*)>\n([\s\S]*?)\n<\/file>/g)];
    expect(pages).toHaveLength(2);
    // A 20K Skill followed by 1K fits the 25K batch. The first page must
    // remain whole, even though it exceeds half the batch allowance.
    expect(pages[0][2].replace(/^\d+\t/gm, '').length).toBe(bodies[0].length);
    expect(pages[0][2].replace(/^\d+\t/gm, '')).toBe(bodies[0]);
    expect(pages[0][1]).toContain('request_complete="true"');
    const secondSlice = pages[1][2].replace(/^\d+\t/gm, '');
    expect(secondSlice).toBe(bodies[1].slice(0, secondSlice.length));
    expect(secondSlice.length).toBeGreaterThan(0);
    expect(pages[1][1]).toContain(`request_complete="${!overflow}"`);
    expect(raw.observations.fileReads.map((read: { charRange: number[] }) => read.charRange))
      .toEqual([[0, bodies[0].length], [0, secondSlice.length]]);
    expect(cap.estimateToolResultTokens(raw.content)).toBeLessThanOrEqual(ceiling);
    const admitted = cap.capToolResult('read_files', raw, ctx, {
      maxInlineTokens: 10_000, toolResultsDir: path.join(tmpDir, 'ordered-results'),
    });
    expect(admitted.persistedOutput).toBeUndefined();
    expect(admitted.content).toBe(raw.content);
    if (overflow) {
      expect(cap.estimateToolResultTokens(raw.content)).toBeGreaterThan(ceiling * 0.95);
      expect(secondSlice.length).toBeLessThan(bodies[1].length);
      const remaining = /remaining_request_range="char:(\d+)-(\d+)"/.exec(pages[1][1])!;
      expect(remaining.slice(1).map(Number)).toEqual([secondSlice.length, bodies[1].length]);
      const resumed = await reader.execute({ paths: [{ path: files[1], range: {
        unit: 'char', start: Number(remaining[1]), end: Number(remaining[2]),
      } }] }, makeContext());
      const resumedBody = /<file [^\n]*>\n([\s\S]*?)\n<\/file>/.exec(resumed.content)![1].replace(/^\d+\t/gm, '');
      expect(secondSlice + resumedBody).toBe(bodies[1]);
      expect(resumed.content).toContain('request_complete="true"');
    } else {
      expect(secondSlice).toBe(bodies[1]);
      expect(raw.content).not.toContain('remaining_request_range=');
    }
  });

  it('shares one bounded allowance across Skill and ordinary files in a batch', async () => {
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

    const cap = await import('../../../../src/main/util/tool-result-cap');
    const readFileState = new Map();
    const ctx = { workingDir: wsDir, state: {
      readFileState,
      [cap.TOOL_RESULT_INLINE_LEDGER_STATE_KEY]: {
        initialTokens: 60_000, remainingTokens: 60_000,
        perResultTokens: 10_000, verbatimDocumentTokens: 25_000,
      },
    } };
    const withSkill = await readFiles.execute({
      paths: [...skillFiles.map((path) => ({ path })), { path: referenceFile }, { path: ordinaryFile }],
    }, ctx);
    expect(withSkill.verbatimDocument).toBe(true);
    for (let index = 0; index < 3; index++) expect(withSkill.content).toContain(`END-SKILL-${index}`);
    expect(withSkill.content).not.toContain('END-SKILL-3');
    expect(withSkill.content.match(/request_complete="false"/g)).toHaveLength(3);
    expect(withSkill.content.match(/covered="0-0"/g)).toHaveLength(2);
    expect(withSkill.observations.fileReads.map((read: { path: string }) => read.path))
      .toEqual([...skillFiles.slice(0, 4), ordinaryFile]);
    expect([...readFileState.keys()]).toEqual([...skillFiles.slice(0, 4), ordinaryFile]);
    expect(withSkill.content).toContain('ordinary notes');
    expect(withSkill.content).not.toContain('END-SKILL-4');
    expect(withSkill.content).not.toContain('END-NESTED-REFERENCE');
    expect(cap.estimateToolResultTokens(withSkill.content)).toBeLessThanOrEqual(25_000);
    const admitted = cap.capToolResult('read_files', withSkill, ctx, {
      maxInlineTokens: 10_000, toolResultsDir: path.join(tmpDir, 'batch-results'),
    });
    expect(admitted.persistedOutput).toBeUndefined();
    expect(admitted.content).toBe(withSkill.content);

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
  it.each(['native', 'fallback'])('finds a selective filename beyond the old enumeration cap (%s)', async (backend) => {
    const { tools, wsDir } = await buildTools();
    for (let i = 0; i < 2100; i++) fs.writeFileSync(path.join(wsDir, `source-${i}.ts`), 'needle\n');
    const repository = await import('../../../../src/main/model/core-agent/repository-search');
    const first = await repository.listRepositoryFiles(wsDir, 2000);
    const target = backend === 'fallback'
      ? fs.readdirSync(wsDir, { withFileTypes: true })[2000].name
      : fs.readdirSync(wsDir).find(name => !first.files.includes(path.join(wsDir, name)))!;
    const originalPath = process.env.PATH;
    if (backend === 'fallback') process.env.PATH = tmpDir;
    try {
      const result = await run(getTool(tools, 'search_files'), { root: wsDir, query: target });
      expect(result.isError).toBeFalsy();
      expect(searchResults(result.content).files.map(file => file.name)).toEqual([target]);
      expect(result.content).toContain('complete=true');
    } finally { process.env.PATH = originalPath; }
  });

  it('reports cancellation as incomplete without scanning or claiming no matches', async () => {
    const { tools, wsDir } = await buildTools();
    fs.writeFileSync(path.join(wsDir, 'present.ts'), 'needle');
    for (const name of ['search_files', 'grep_files']) {
      const result = await getTool(tools, name).execute({ root: wsDir, query: 'present', pattern: 'needle' }, {
        workingDir: wsDir, state: {}, signal: AbortSignal.abort(),
      });
      expect(result.content).toContain('complete=false');
      expect(result.content).toContain('cancelled');
      expect(result.content).not.toContain('No matches');
    }
  });

  it('shares one deadline across roots and reports timeout without a false absence', async () => {
    const { tools, wsDir, attDir } = await buildTools();
    fs.writeFileSync(path.join(wsDir, 'present.ts'), 'needle');
    fs.writeFileSync(path.join(attDir, 'later.ts'), 'needle');
    const repository = await import('../../../../src/main/model/core-agent/repository-search');
    const makeBudget = repository.createRepositorySearchBudget;
    vi.spyOn(repository, 'createRepositorySearchBudget').mockImplementation(signal => makeBudget(signal, 20));
    const waitForAbort = (signal: AbortSignal) => signal.aborted ? Promise.resolve()
      : new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }));
    const visit = vi.spyOn(repository, 'visitRepositoryFiles').mockImplementation(async (_root, _visit, opts) => {
      await waitForAbort(opts!.signal!);
      return { backend: 'rg', capped: false, interrupted: true };
    });
    const grep = vi.spyOn(repository, 'grepRepository').mockImplementation(async (_root, input) => {
      await waitForAbort(input.signal!);
      return { available: true, hits: [], scannedBackend: 'rg', capped: false, interrupted: true };
    });
    for (const name of ['search_files', 'grep_files']) {
      const result = await run(getTool(tools, name), { query: 'present', pattern: 'needle' });
      expect(result.content).toContain('complete=false reasons=time_budget');
      expect(result.content).not.toContain('No matches');
      expect(result.content).toContain('narrow root');
    }
    expect(visit).toHaveBeenCalledTimes(1);
    expect(grep).toHaveBeenCalledTimes(1);
  });

  it('retains useful filename results when cancellation interrupts enumeration', async () => {
    const { tools, wsDir } = await buildTools();
    const file = path.join(wsDir, 'kept.ts');
    fs.writeFileSync(file, 'needle');
    const controller = new AbortController();
    const repository = await import('../../../../src/main/model/core-agent/repository-search');
    vi.spyOn(repository, 'visitRepositoryFiles').mockImplementation(async (_root, visit) => {
      await visit(file);
      controller.abort();
      return { backend: 'rg', capped: false, interrupted: true };
    });
    const result = await getTool(tools, 'search_files').execute({ root: wsDir }, {
      workingDir: wsDir, state: {}, signal: controller.signal,
    });
    expect(searchResults(result.content).files.map(file => file.name)).toEqual(['kept.ts']);
    expect(result.content).toContain('complete=false reasons=cancelled');
  });

  it('reports an unreadable directory as incomplete instead of complete absence', async () => {
    const { tools, wsDir } = await buildTools();
    const repository = await import('../../../../src/main/model/core-agent/repository-search');
    vi.spyOn(repository, 'visitRepositoryFiles').mockResolvedValue({ backend: 'rg', capped: false, error: 'injected read failure' });
    const result = await run(getTool(tools, 'search_files'), { root: wsDir, query: 'missing' });
    expect(result.content).toContain('complete=false reasons=io_error');
    expect(result.content).not.toContain('No matches');
  });

  it('returns root-qualified paths that read_files can consume across roots', async () => {
    const { tools, wsDir, attDir } = await buildTools();
    const paths = [path.join(wsDir, 'nested', 'report.txt'), path.join(attDir, 'report.txt')];
    for (const [i, file] of paths.entries()) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, `distinct report ${i}`);
      fs.utimesSync(file, 1_700_000_000 + i, 1_700_000_000 + i);
    }
    const result = await run(getTool(tools, 'search_files'), { query: 'report.txt' });
    const { roots, files } = searchResults(result.content);
    expect(files.map((f) => path.join(roots[f.root], f.path))).toEqual([...paths].reverse());
    expect(files.map((f) => f.source)).toEqual(['attachment', 'workspace']);
    for (const f of files) {
      const resolved = path.join(roots[f.root], f.path);
      expect(f.size).toBe(fs.statSync(resolved).size);
      expect(f.mtime).toBe(fs.statSync(resolved).mtime.toISOString());
      const read = await run(getTool(tools, 'read_files'), { paths: [{ path: resolved }] });
      expect(read.isError, read.content).toBeFalsy();
      expect(read.content).toContain(fs.readFileSync(resolved, 'utf8'));
    }
  });

  it('preserves newest-first caps and the exact requested subdirectory', async () => {
    const { tools, wsDir } = await buildTools();
    const root = path.join(wsDir, 'selected');
    fs.mkdirSync(root);
    fs.writeFileSync(path.join(wsDir, 'outside.txt'), 'not selected');
    for (let i = 0; i < 2105; i++) {
      const file = path.join(root, `${i}.txt`);
      fs.writeFileSync(file, String(i));
      fs.utimesSync(file, 1_700_000_000 + i, 1_700_000_000 + i);
    }
    for (const max of [2, 200]) {
      const result = await run(getTool(tools, 'search_files'), { root, max_results: max });
      expect(result.content).toContain(`2105 match(es), showing ${max}; backend=`);
      expect(result.content).toContain('complete=false reasons=result_limit');
      const { roots, files } = searchResults(result.content);
      expect(roots).toEqual([root]);
      expect(files.map((f) => f.path)).toEqual(Array.from({ length: max }, (_, i) => `${2104 - i}.txt`));
      expect(result.content.split(JSON.stringify(root))).toHaveLength(2);
      expect(result.content).not.toContain('outside.txt');
    }
    const empty = await run(getTool(tools, 'search_files'), { root, query: 'missing' });
    expect(empty.content).toContain('No matches for "missing".');
    expect(empty.content).toContain('complete=true');
  });

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
    expect(searchResults(hidden.content).files.map(file => file.path))
      .toEqual([path.join('.github', 'workflows', 'check.yml')]);
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
    expect(searchResults(r.content).files.find((f) => f.name === 'contract_signed.pdf')).not.toHaveProperty('total_chars');
  });

  it('includes total_chars for files already in cache', async () => {
    const { tools, wsDir } = await buildTools();
    const p = path.join(wsDir, 'cached.pdf');
    fs.writeFileSync(p, makeMinimalPdf(['X']));
    // Pre-stat so the cache exists before the search runs.
    await run(getTool(tools, 'stat_file'), { path: p });

    const r = await run(getTool(tools, 'search_files'), { query: 'cached' });
    expect(searchResults(r.content).files[0].total_chars).toEqual(expect.any(Number));
  });

  it('supports glob patterns', async () => {
    const { tools, wsDir } = await buildTools();
    fs.writeFileSync(path.join(wsDir, 'a.pdf'), makeMinimalPdf(['x']));
    fs.writeFileSync(path.join(wsDir, 'b.md'), 'md');
    const r = await run(getTool(tools, 'search_files'), { query: '*.pdf' });
    expect(r.content).toContain('a.pdf');
    expect(r.content).not.toContain('b.md');
  });

  it.each(['default', 'fallback'])('matches query paths relative to the selected root (%s)', async backend => {
    const { tools, wsDir } = await buildTools();
    const root = path.join(wsDir, 'packages', 'demo');
    for (const relative of ['src/a.ts', 'src/nested/b.ts', 'src/nested/bb.ts', 'src/deep/nested/c.ts',
      'src/a.js', 'src/nested/b.tsx', 'tests/a.ts', 'other/src/a.ts']) {
      const file = path.join(root, relative);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, 'source');
    }
    const originalPath = process.env.PATH;
    if (backend === 'fallback') process.env.PATH = tmpDir;
    try {
      const cases = [
        { query: 'src/*.ts', expected: ['src/a.ts'] },
        { query: 'src/**/*.ts', expected: ['src/a.ts', 'src/nested/b.ts', 'src/nested/bb.ts', 'src/deep/nested/c.ts'] },
        { query: 'src/**/?.ts', expected: ['src/a.ts', 'src/nested/b.ts', 'src/deep/nested/c.ts'] },
        { query: 'src/a.ts', expected: ['src/a.ts'] },
        { query: '**/a.ts', expected: ['src/a.ts', 'tests/a.ts', 'other/src/a.ts'] },
        { query: 'src/**/*.ts', include_glob: ['**/b*.ts'], exclude_glob: ['**/bb.ts'], expected: ['src/nested/b.ts'] },
      ];
      for (const { expected, ...input } of cases) {
        const result = await getTool(tools, 'search_files').execute({ root: 'packages/demo', ...input }, {
          workingDir: wsDir, signal: undefined,
        });
        expect(result.isError, input.query).toBeFalsy();
        expect(result.content, input.query).toContain('complete=true');
        const listing = searchResults(result.content);
        expect(listing.files.map(file => path.join(listing.roots[file.root], file.path)).sort(), input.query)
          .toEqual(expected.map(relative => path.join(root, relative)).sort());
        if (backend === 'fallback') expect(result.content).toContain('backend=walk');
      }
    } finally { process.env.PATH = originalPath; }
  });

  it('keeps basename queries compatible and anchors path queries separately in each visible root', async () => {
    const { tools, wsDir, attDir } = await buildTools();
    for (const root of [wsDir, attDir]) {
      for (const relative of ['src/a.ts', 'src/nested/b.ts', 'adapter/other.txt', 'docs/Adapter.TS']) {
        const file = path.join(root, relative);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, 'source');
      }
    }
    for (const { query, expected } of [
      { query: 'src/**/*.ts', expected: ['src/a.ts', 'src/nested/b.ts'] },
      { query: '*.ts', expected: ['src/a.ts', 'src/nested/b.ts', 'docs/Adapter.TS'] },
      { query: '[ab].ts', expected: ['src/a.ts', 'src/nested/b.ts'] },
      { query: 'ADAPTER', expected: ['docs/Adapter.TS'] },
    ]) {
      const result = await run(getTool(tools, 'search_files'), { query });
      const listing = searchResults(result.content);
      expect(listing.files.map(file => path.join(listing.roots[file.root], file.path)).sort(), query)
        .toEqual([wsDir, attDir].flatMap(root => expected.map(relative => path.join(root, relative))).sort());
    }
    const missing = await run(getTool(tools, 'search_files'), { query: 'missing/**/*.ts' });
    expect(missing.content).toContain('No matches');
    expect(missing.content).toContain('complete=true');
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
  it('reports incomplete extraction when the rich-document budget is exhausted', async () => {
    const { tools, wsDir } = await buildTools();
    for (let i = 0; i < 2001; i++) fs.writeFileSync(path.join(wsDir, `doc-${i}.docx`), 'unrelated');
    const indexer = await import('../../../../src/main/features/file_indexer');
    const extract = vi.spyOn(indexer, 'getExtractedText').mockImplementation(async (_uid, file) => ({ text: fs.readFileSync(file, 'utf8') }) as any);
    const result = await run(getTool(tools, 'grep_files'), { root: wsDir, pattern: 'needle' });
    expect(result.content).toContain('complete=false reasons=extraction_limit');
    expect(result.content).not.toContain('No matches');
    expect(extract).toHaveBeenCalledTimes(2000);
  });

  it('searches a later permitted root after a large workspace with no matches', async () => {
    const { tools, wsDir, attDir } = await buildTools();
    for (let i = 0; i < 2000; i++) fs.writeFileSync(path.join(wsDir, `file-${i}.md`), 'unrelated');
    fs.writeFileSync(path.join(attDir, 'later.md'), 'banana beyond scan budget');
    const result = await run(getTool(tools, 'grep_files'), { pattern: 'banana' });
    expect(result.isError).toBeFalsy();
    expect(result.content).toContain('later.md');
    expect(result.content).toContain('complete=true');
  });

  it.each(['native', 'fallback'])('searches a glob target beyond the old enumeration cap (%s)', async (backend) => {
    const { tools, wsDir } = await buildTools();
    for (let i = 0; i < 2100; i++) fs.writeFileSync(path.join(wsDir, `source-${i}.ts`), 'needle\n');
    const repository = await import('../../../../src/main/model/core-agent/repository-search');
    const first = await repository.listRepositoryFiles(wsDir, 2000);
    const target = backend === 'fallback'
      ? fs.readdirSync(wsDir, { withFileTypes: true })[2000].name
      : fs.readdirSync(wsDir).find(name => !first.files.includes(path.join(wsDir, name)))!;
    const originalPath = process.env.PATH;
    if (backend === 'fallback') process.env.PATH = tmpDir;
    try {
      const result = await run(getTool(tools, 'grep_files'), { root: wsDir, glob: target, pattern: 'needle' });
      expect(result.isError).toBeFalsy();
      expect(result.content).toContain(`file: ${JSON.stringify(path.join(wsDir, target))}\n  :1:1  needle`);
      expect(result.content).toContain('complete=true');
    } finally { process.env.PATH = originalPath; }
  });

  it('searches attachments without reopening a privacy-protected workspace', async () => {
    const { tools, wsDir, attDir } = await buildTools();
    fs.writeFileSync(path.join(wsDir, 'private.md'), 'banana private workspace');
    fs.writeFileSync(path.join(attDir, 'attached.md'), 'banana supplied attachment');
    const tcc = await import('../../../../src/main/util/macos-tcc');
    const original = tcc.macosTccSensitivePath;
    vi.spyOn(tcc, 'macosTccSensitivePath').mockImplementation((target, options) => (
      options?.recursive && path.resolve(target) === path.resolve(wsDir)
        ? { blocked: true, reason: 'downloads', protectedRoot: wsDir }
        : original(target, options)
    ));
    const result = await run(getTool(tools, 'grep_files'), { pattern: 'banana' });
    expect(result.isError).toBeFalsy();
    expect(result.content).toContain('attached.md');
    expect(result.content).not.toContain('private.md');
    expect(result.content).not.toContain('private workspace');
  });

  it('matches text files directly on source', async () => {
    const { tools, wsDir } = await buildTools();
    fs.writeFileSync(path.join(wsDir, 'a.md'), 'line with banana\nother line');
    fs.writeFileSync(path.join(wsDir, 'b.md'), 'no match here');
    const r = await run(getTool(tools, 'grep_files'), { pattern: 'banana' });
    expect(r.isError).toBeFalsy();
    expect(r.content).toContain(`file: ${JSON.stringify(path.join(wsDir, 'a.md'))}\n  :1:11  line with banana`);
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
    expect(r.content).toContain(`file: ${JSON.stringify(path.join(wsDir, 'a.md'))}\n  :1:11  line with banana`);
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
    expect(r.content).toContain(`file: ${JSON.stringify(path.join(wsDir, 'sub', 'x.md'))}`);
    expect(r.content).not.toContain('top.md');
  });

  it('output_mode "files" returns file paths only (no line snippets)', async () => {
    const { tools, wsDir } = await buildTools();
    // Repeated lines in one file must not consume the other file's slot.
    fs.writeFileSync(path.join(wsDir, 'a.md'), 'banana\n'.repeat(500));
    fs.writeFileSync(path.join(wsDir, 'b.md'), 'banana\n'.repeat(500));
    const r = await run(getTool(tools, 'grep_files'), {
      pattern: 'banana', output_mode: 'files', max_results: 2, context_lines: 3,
    });
    expect(r.isError).toBeFalsy();
    expect(r.content).toContain('a.md');
    expect(r.content).toContain('b.md');
    expect(r.content).toContain('file(s) with matches');
    expect(r.content).not.toMatch(/a\.md:\d/);   // no per-line snippet form
  });

  it.each(['text', 'docx'])('preserves content, file and count results for one %s source', async (kind) => {
    const { tools, wsDir } = await buildTools();
    const root = path.join(wsDir, kind === 'text' ? 'notes.md' : 'notes.docx');
    const paragraphs = ['before', 'Banana first', 'middle', 'Banana second', 'after'];
    fs.writeFileSync(root, kind === 'text'
      ? paragraphs.join('\n')
      : makeMinimalDocx({ paragraphs }));
    const grep = getTool(tools, 'grep_files');
    for (const output_mode of ['content', 'files', 'count']) {
      const result = await run(grep, { root, pattern: 'Banana', output_mode, context_lines: 3 });
      expect(result.isError).toBeFalsy();
      expect(result.content).toContain(output_mode === 'content' ? `file: ${JSON.stringify(root)}` : root);
      if (output_mode === 'content') {
        expect(result.content).toContain('2 match(es)');
        for (const paragraph of paragraphs) expect(result.content).toContain(paragraph);
      } else {
        for (const paragraph of paragraphs) expect(result.content).not.toContain(paragraph);
        expect(result.content).toContain(output_mode === 'files' ? '1 file(s) with matches' : `${root}: 2`);
      }
    }
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
    expect(r.content).toContain(`file: ${JSON.stringify(path.join(wsDir, 'src', 'main.ts'))}\n  -1-  before\n  :2:1  Needle`);
    expect(r.content).toContain('before');
    expect(r.content).toContain('after');
    expect(r.content).not.toContain('needle lower');
    expect(r.content).not.toContain('vendor');
    expect(r.content).toContain('capped at 1');
  });
});
