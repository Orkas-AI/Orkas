import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { profileSyncCosts } from '../../../helpers/sync-cost.cjs';
import { measureWorkload as measure } from '../../../helpers/workload-metrics.cjs';
import { checkLatencyBudget, BULK_MAIN_GAP_LIMIT_MS, LATENCY_LIMIT_MS, LARGE_REPOSITORY_SEARCH_LIMIT_MS } from '../../../helpers/latency-budget';
import { syncBuiltinESMExports } from 'node:module';
import { spawnSync } from 'node:child_process';
import { drainMainRuntimeForTest } from '../../../helpers/drain-main-runtime';
import { extractOffice, closeOfficeExtraction } from '../../../../src/main/util/office-extract';
import { makeMinimalXlsx } from '../../../fixtures/make-minimal-office';
import { grepRepository } from '../../../../src/main/model/core-agent/repository-search';

const ATTRIBUTION = process.env.ORKAS_PERFORMANCE_ATTRIBUTION === '1';
const RG_AVAILABLE = spawnSync('rg', ['--version']).status === 0;

// Actual host tools/files/worker/rg; logger is captured, not a production sink benchmark.
const warnings = vi.hoisted(() => [] as string[]);
const logs = vi.hoisted(() => ({ debug: 0, info: 0, warn: 0, error: 0 }));
vi.mock('../../../../src/main/logger', () => ({ createLogger: () => Object.fromEntries(
  Object.keys(logs).map(level => [level, (message: string) => { logs[level as keyof typeof logs]++; if (level === 'warn') warnings.push(message); }]),
) }));
let root: string, previous: string | undefined, dir: string;
const uid = 'synthetic-performance';
beforeEach(async () => {
  previous = process.env.ORKAS_WORKSPACE_ROOT;
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-file-performance-'));
  process.env.ORKAS_WORKSPACE_ROOT = root;
  vi.resetModules(); warnings.length = 0;
  for (const level of Object.keys(logs)) logs[level as keyof typeof logs] = 0;
  (await import('../../../../src/main/features/users')).activateUser(uid);
  dir = path.join(root, 'workspace'); fs.mkdirSync(dir);
  expect((await import('../../../../src/main/features/user_workspace')).setWorkspacePath(uid, dir).ok).toBe(true);
  (await import('../../../../src/main/features/permissions')).setLocalExecMode('all_files_auto');
});
afterEach(async () => {
  vi.restoreAllMocks(); syncBuiltinESMExports();
  await closeOfficeExtraction(); await drainMainRuntimeForTest();
  if (previous === undefined) delete process.env.ORKAS_WORKSPACE_ROOT;
  else process.env.ORKAS_WORKSPACE_ROOT = previous;
  // Large repository fixtures can contain thousands of Windows directory entries.
  await fs.promises.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
}, 120_000);
async function tools() {
  const local = (await import('../../../../src/main/model/core-agent/local-tools')).createLocalTools({ userId: uid, cid: 'fixture' });
  const ctx = { workingDir: dir, state: { readFileState: new Map() } } as any;
  return (name: string, input: Record<string, unknown>) => local.find(t => t.name === name)!.execute(input, ctx);
}
function revision(content: string): string {
  const value = /revision="([^"]+)"/.exec(content)?.[1];
  expect(value, 'Saved results must expose a usable revision').toBeTruthy(); return value!;
}
function complete(actual: Buffer, expected: Buffer) {
  if (!actual.equals(expected)) throw new Error('Incomplete or duplicated file bytes');
}
// Keep counts only. Mock call histories retain every megabyte read and
// written during the loop and can create GC pauses in the measured workload.
function countFileTraffic(readsFile: (file: fs.PathOrFileDescriptor) => boolean,
  writesFile?: (file: fs.PathOrFileDescriptor) => boolean, replacementTarget?: string) {
  const traffic = { reads: 0, readBytes: 0, writes: 0, writtenBytes: 0, replacements: 0 };
  const read = fs.readFileSync, write = fs.writeFileSync, rename = fs.renameSync;
  fs.readFileSync = ((file: fs.PathOrFileDescriptor, ...args: unknown[]) => {
    const result = (read as Function)(file, ...args) as string | Buffer;
    if (readsFile(file)) { traffic.reads++; traffic.readBytes += Buffer.byteLength(result); }
    return result;
  }) as typeof read;
  if (writesFile) {
    fs.writeFileSync = ((file: fs.PathOrFileDescriptor, data: string | Buffer, ...args: unknown[]) => {
      const result = (write as Function)(file, data, ...args);
      if (writesFile(file)) { traffic.writes++; traffic.writtenBytes += Buffer.byteLength(data); }
      return result;
    }) as typeof write;
  }
  if (replacementTarget) {
    fs.renameSync = (from, to) => {
      rename(from, to);
      if (to === replacementTarget) traffic.replacements++;
    };
  }
  syncBuiltinESMExports();
  return { traffic, stop() {
    fs.readFileSync = read;
    if (writesFile) fs.writeFileSync = write;
    if (replacementTarget) fs.renameSync = rename;
    syncBuiltinESMExports();
  } };
}
it('PF-03 measures fixed final bytes across chunk counts without accepting truncation or replay', async () => {
  const call = await tools(), measurements = [];
  for (const finalBytes of [256 * 1024, 1024 * 1024, 8 * 1024 * 1024]) {
    // Same independently constructed Unicode payload at every chunk count.
    const expected = Buffer.from('界x'.repeat(finalBytes / 4));
    for (const arrival of ['burst', 'paced'] as const) for (const chunks of [4, 16, 32]) {
      const target = path.join(dir, `source-${finalBytes}-${arrival}-${chunks}.txt`);
      const chunk = expected.subarray(0, finalBytes / chunks).toString('utf8');
      const first = await call('write_file', { path: target, content: chunk });
      expect(first.isError).not.toBe(true); let base = revision(first.content);
      const costs = ATTRIBUTION ? profileSyncCosts(file => String(file) === target) : null;
      const { traffic, stop } = countFileTraffic(file => String(file) === target);
      let maxAppendMs = 0;
      let measured;
      try {
        measured = await measure(async () => {
          for (let n = 1; n < chunks; n++) {
            const operationStart = performance.now();
            const result = await call('append_file', { path: target, content: chunk, base_revision: base });
            maxAppendMs = Math.max(maxAppendMs, performance.now() - operationStart);
            expect(result.isError).not.toBe(true); base = revision(result.content);
            if (arrival === 'paced') await new Promise(resolve => setImmediate(resolve));
          }
        });
      } finally { stop(); costs?.stop(); }
      complete(fs.readFileSync(target), expected);
      // Tap validity only, NOT a requirement to preserve the inefficient number of reads.
      const { reads: sourceReads, readBytes: sourceReadBytes } = traffic;
      expect(sourceReads).toBeGreaterThan(0); expect(sourceReadBytes).toBeGreaterThan(0);
      measurements.push({ arrival, finalBytes, chunks, sourceReads, sourceReadBytes, readAmplification: sourceReadBytes / finalBytes, maxAppendMs, ...(costs ? { callerCosts: costs.report } : {}), ...measured.metrics });
    }
  }
  expect(logs.warn).toBe(0); expect(logs.error).toBe(0);
  console.log('[PF-03 fixed-payload append]', JSON.stringify({ measurements, capturedLogs: logs,
    scope: 'one sample per workload; API traffic, warm OS cache; endpoint memory, not peak; existing bulk event-loop budget' }));
  for (const sample of measurements) checkLatencyBudget(`append ${sample.arrival} ${sample.finalBytes} bytes/${sample.chunks} chunks caller delay`,
    { elapsedMs: sample.eventLoopDelayMs }, BULK_MAIN_GAP_LIMIT_MS);
}, 30000);

function isPatchStage(target: string, value: unknown): boolean {
  const file = String(value);
  return path.dirname(file) === path.dirname(target)
    && path.basename(file).startsWith(`.${path.basename(target)}.core-agent-patch-`)
    && file.endsWith('.tmp');
}

it.each(['burst', 'paced'] as const)('PF-03 preserves replay and stale-write protection after a long %s append/edit sequence', async arrival => {
  const call = await tools(), target = path.join(dir, 'editable.txt');
  const source = 'HEAD_0000\n' + '界x'.repeat(256 * 1024) + '\nTAIL';
  const first = await call('write_file', { path: target, content: source });
  const append = { path: target, content: '\nNEW', base_revision: revision(first.content) };
  expect((await call('append_file', append)).isError).not.toBe(true);
  expect((await call('append_file', append)).isError).not.toBe(true);
  complete(fs.readFileSync(target), Buffer.from(source + '\nNEW'));
  // The isolated workspace contains the target and any sibling staging writes.
  const inWorkspace = (file: unknown) => typeof file === 'string' && path.dirname(file) === dir;
  const costs = ATTRIBUTION ? profileSyncCosts(inWorkspace) : null;
  let maxEditMs = 0;
  let committedBytes = 0;
  const { traffic, stop } = countFileTraffic(file => file === target, inWorkspace, target);
  let measured;
  try { measured = await measure(async () => {
    for (let n = 0; n < 100; n++) {
      const operationStart = performance.now();
      const result = await call('edit_file', { path: target, old_string: `HEAD_${String(n).padStart(4, '0')}`,
        new_string: `HEAD_${String(n + 1).padStart(4, '0')}` });
      maxEditMs = Math.max(maxEditMs, performance.now() - operationStart);
      expect(result.isError, `edit ${n}`).not.toBe(true);
      committedBytes += result.observations?.fileChanges?.[0]?.afterBytes ?? 0;
      if (arrival === 'paced') await new Promise(resolve => setImmediate(resolve));
    }
  }); } finally { stop(); costs?.stop(); }
  const expected = Buffer.from(source.replace('HEAD_0000', 'HEAD_0100') + '\nNEW');
  complete(fs.readFileSync(target), expected);
  const external = Buffer.concat([expected, Buffer.from('\nEXTERNAL')]); fs.writeFileSync(target, external);
  const stale = await call('edit_file', { path: target, old_string: 'HEAD_0100', new_string: 'WRONG' });
  expect(stale.isError).toBe(true); expect(stale.content).toContain('E_STALE');
  complete(fs.readFileSync(target), external);
  expect(warnings).toEqual(['edit_file freshness reject']); expect(logs.error).toBe(0);
  console.log('[PF-03 repeated edit]', JSON.stringify({ arrival, edits: 100, traffic: { ...traffic, committedBytes }, maxEditMs, ...(costs ? { callerCosts: costs.report } : {}), finalBytes: expected.length, ...measured.metrics, capturedLogs: logs, expectedWarnings: warnings }));
  expect(traffic.readBytes).toBeGreaterThan(0); expect(traffic.writtenBytes).toBeGreaterThan(0);
  expect(traffic.replacements).toBe(100);
  expect(committedBytes).toBe(100 * expected.length);
  checkLatencyBudget(`100 ${arrival} edits caller delay`, { elapsedMs: measured.metrics.eventLoopDelayMs }, BULK_MAIN_GAP_LIMIT_MS);
}, 30000);

it.skipIf(!RG_AVAILABLE).each(['burst', 'paced'] as const)('PF-19 completes repository search and Office extraction during eight %s code-writing tasks', async arrival => {
  const call = await tools();
  const rows = Array.from({ length: 40000 }, (_, n) => [`row-${n}`, `value-${n}`]);
  const workbook = makeMinimalXlsx({ rows }), originalWorkbook = Buffer.from(workbook);
  const repository = path.join(dir, 'repository'); fs.mkdirSync(repository);
  const expectedHits = Array.from({ length: 100 }, (_, n) => `file-${n}.ts`).sort();
  for (const name of expectedHits) fs.writeFileSync(path.join(repository, name), 'first\nPF_NEEDLE\nlast\n');
  const chunk = '界x'.repeat(16384), expected = Buffer.from(chunk.repeat(16));
  const inputs = await Promise.all(Array.from({ length: 8 }, async (_, task) => {
    const target = path.join(dir, `task-${task}.txt`);
    const first = await call('write_file', { path: target, content: chunk });
    expect(first.isError).not.toBe(true); return { target, base: revision(first.content) };
  }));
  const finishes = { officeMs: 0, searchMs: 0, fileTasksMs: [] as number[] };
  const measured = await measure(async () => {
    const start = performance.now();
    return Promise.all([
      extractOffice('xlsx-markdown', workbook).then(value => { finishes.officeMs = performance.now() - start; return value; }),
      grepRepository(repository, { pattern: 'PF_NEEDLE', regex: false, caseSensitive: true, contextLines: 0,
      maxResults: 200, includeGlobs: [], excludeGlobs: [] }).then(value => { finishes.searchMs = performance.now() - start; return value; }),
      Promise.all(inputs.map(async input => {
      for (let n = 1; n < 16; n++) {
        const result = await call('append_file', { path: input.target, content: chunk, base_revision: input.base });
        expect(result.isError).not.toBe(true); input.base = revision(result.content);
        if (arrival === 'paced') await new Promise(resolve => setImmediate(resolve));
      }
      finishes.fileTasksMs.push(performance.now() - start);
    })),
    ]);
  });
  const [text, search] = measured.value;
  const extracted = text.split('\n').filter(line => /^Row \d+:/.test(line));
  expect(extracted).toEqual(rows.map((row, n) => `Row ${n + 1}: ${row.join('\t')}`));
  expect(workbook).toEqual(originalWorkbook);
  expect(search.available).toBe(true); expect(search.error).toBeUndefined(); expect(search.capped).toBe(false);
  expect(search.hits.map(hit => path.basename(hit.path)).sort()).toEqual(expectedHits);
  expect(search.hits.every(hit => hit.line === 2 && hit.text === 'PF_NEEDLE')).toBe(true);
  for (const { target } of inputs) complete(fs.readFileSync(target), expected);
  expect(logs.warn).toBe(0); expect(logs.error).toBe(0);
  console.log('[PF-19 code-search-office]', JSON.stringify({ arrival, tasks: 8, appends: 120, finishes, fileBytes: expected.length,
    officeRows: rows.length, searchHits: expectedHits.length, ...measured.metrics, capturedLogs: logs,
    scope: 'actual local dependencies, caller event loop; mixed completion includes queued service/startup; no UI/physical disk/model' }));
  checkLatencyBudget(`mixed ${arrival} workload caller delay`, { elapsedMs: measured.metrics.eventLoopDelayMs }, BULK_MAIN_GAP_LIMIT_MS);
}, 30000);

// PF-06: defaults exercise 10K files; the explicitly selected large tier also runs 100K.
for (const files of [10000, 100000]) {
  it.skipIf(!RG_AVAILABLE || (files === 100000 && process.env.ORKAS_PERFORMANCE_LARGE !== '1'))(`PF-06 searches ${files} files and empty directories with native and fallback traversal`, async () => {
    const repository = path.join(dir, 'repository'); fs.mkdirSync(repository);
    fs.mkdirSync(path.join(repository, '.git')); // scale fixture is a Git repository
    const expected: string[] = [];
    for (let bucket = 0; bucket < 100; bucket++) {
      const folder = path.join(repository, `bucket-${bucket}`); fs.mkdirSync(folder);
      fs.mkdirSync(path.join(repository, `empty-${bucket}`));
      for (let n = 0; n < files / 100; n++) {
        const name = n === 0 && bucket < 17 ? `match-${bucket}.ts` : `other-${n}.ts`;
        fs.writeFileSync(path.join(folder, name), 'value\n');
        if (name.startsWith('match-')) expected.push(path.join(folder, name));
      }
    }
    fs.mkdirSync(path.join(repository, 'ignored'));
    fs.writeFileSync(path.join(repository, 'ignored', 'match-hidden.ts'), 'excluded\n');
    fs.writeFileSync(path.join(repository, '.gitignore'), 'ignored/\n');
    const { createFileTools } = await import('../../../../src/main/model/core-agent/file-tools');
    const search = createFileTools({ userId: uid, cid: 'fixture' }).find(tool => tool.name === 'search_files')!;
    const priorPath = process.env.PATH, measurements = [];
    try {
      for (const rules of ['directory-only', 'mixed']) for (const backend of ['native', 'fallback']) {
        fs.writeFileSync(path.join(repository, '.gitignore'), rules === 'directory-only'
          ? 'ignored/\n' : 'ignored/\n*.log\n*.map\n!keep.log\n');
        if (backend === 'fallback') process.env.PATH = root; // no rg, actual traversal remains real
        else if (priorPath === undefined) delete process.env.PATH;
        else process.env.PATH = priorPath;
        const costs = ATTRIBUTION ? profileSyncCosts(file => typeof file === 'string' && file.startsWith(repository)) : null;
        let measured;
        try { measured = await measure(() => search.execute({ root: repository, query: 'match-' }, { workingDir: dir, state: {} })); }
        finally { costs?.stop(); }
        const result = measured.value;
        expect(result.isError).not.toBe(true); expect(result.content).toContain('complete=true');
        expect(result.content).toContain(`backend=${backend === 'native' ? 'rg' : 'walk'}`);
        const listing = JSON.parse(result.content.slice(result.content.indexOf('{')));
        expect(listing.files.map((file: { root: number; path: string }) => path.join(listing.roots[file.root], file.path)).sort()).toEqual([...expected].sort());
        measurements.push({ rules, backend, ...(costs ? { callerCosts: costs.report } : {}), ...measured.metrics });
      }
    } finally { if (priorPath === undefined) delete process.env.PATH; else process.env.PATH = priorPath; }
    expect(logs.warn).toBe(0); expect(logs.error).toBe(0);
    console.log('[PF-06 repository scale]', JSON.stringify({ files, emptyDirectories: 100, matches: expected.length, measurements,
      capturedLogs: logs, scope: 'real directory traversal and rg; file creation excluded; no cold physical disk/p95 claim' }));
    for (const sample of measurements) checkLatencyBudget(`${sample.backend} filename search ${files}/${sample.rules}`,
      { elapsedMs: sample.elapsedMs }, files === 100000 ? LARGE_REPOSITORY_SEARCH_LIMIT_MS : LATENCY_LIMIT_MS);
  }, 60000);
}

it.skipIf(!RG_AVAILABLE)('PF-06 searches a deep repository with inherited file rules without losing negated or nested matches', async () => {
  const repository = path.join(dir, 'deep-repository'); fs.mkdirSync(repository);
  fs.mkdirSync(path.join(repository, '.git'));
  const expected: string[] = [];
  // Same 10K ordinary-file scale as the daily case, spread over 1K nested
  // directories. Each level adds rules, ignored descendants and an empty folder.
  for (let branch = 0; branch < 100; branch++) {
    let folder = path.join(repository, `branch-${branch}`);
    for (let depth = 0; depth < 10; depth++) {
      fs.mkdirSync(folder, { recursive: true });
      fs.writeFileSync(path.join(folder, '.gitignore'), '*.tmp\n!needle-keep.tmp\nexcluded/\n');
      fs.mkdirSync(path.join(folder, 'empty'));
      fs.mkdirSync(path.join(folder, 'excluded'));
      fs.writeFileSync(path.join(folder, 'excluded', 'needle-hidden.txt'), 'must stay ignored');
      fs.writeFileSync(path.join(folder, 'needle-hidden.tmp'), 'must stay ignored');
      for (let n = 0; n < 10; n++) fs.writeFileSync(path.join(folder, `other-${n}.ts`), 'value');
      if (branch < 6 && (depth === 0 || depth === 9)) {
        for (const name of ['needle-visible.ts', 'needle-keep.tmp']) {
          const target = path.join(folder, name); fs.writeFileSync(target, 'expected'); expected.push(target);
        }
      }
      folder = path.join(folder, 'nested');
    }
  }
  const { createFileTools } = await import('../../../../src/main/model/core-agent/file-tools');
  const search = createFileTools({ userId: uid, cid: 'fixture' }).find(tool => tool.name === 'search_files')!;
  const priorPath = process.env.PATH, measurements = [];
  try {
    for (const backend of ['native', 'fallback']) {
      if (backend === 'fallback') process.env.PATH = root;
      else if (priorPath === undefined) delete process.env.PATH;
      else process.env.PATH = priorPath;
      const costs = ATTRIBUTION ? profileSyncCosts(file => typeof file === 'string' && file.startsWith(repository)) : null;
      let measured;
      try { measured = await measure(() => search.execute({ root: repository, query: 'needle' }, { workingDir: dir, state: {} })); }
      finally { costs?.stop(); }
      expect(measured.value.isError).not.toBe(true);
      expect(measured.value.content).toContain('complete=true');
      expect(measured.value.content).toContain(`backend=${backend === 'native' ? 'rg' : 'walk'}`);
      const listing = JSON.parse(measured.value.content.slice(measured.value.content.indexOf('{')));
      expect(listing.files.map((file: { root: number; path: string }) => path.join(listing.roots[file.root], file.path)).sort()).toEqual([...expected].sort());
      measurements.push({ backend, ...(costs ? { callerCosts: costs.report } : {}), ...measured.metrics });
    }
  } finally { if (priorPath === undefined) delete process.env.PATH; else process.env.PATH = priorPath; }
  expect(logs.warn).toBe(0); expect(logs.error).toBe(0);
  console.log('[PF-06 deep repository]', JSON.stringify({ branches: 100, depth: 10, ordinaryFiles: 10000, storedFiles: 13024, matches: 24,
    measurements, capturedLogs: logs, scope: 'native and fallback; warm local FS; setup excluded; endpoint RSS, not peak or historical incident reproduction' }));
  for (const sample of measurements) checkLatencyBudget(`${sample.backend} deep filename search`, { elapsedMs: sample.elapsedMs });
}, 60000);

it('PF-19 rejects a truncated/replayed result and detects a deliberately blocking caller', async () => {
  const expected = Buffer.from('complete-界-end');
  expect(() => complete(expected.subarray(0, -1), expected)).toThrow('Incomplete');
  expect(() => complete(Buffer.concat([expected, expected]), expected)).toThrow('duplicated');
  const measured = await measure(async () => {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, BULK_MAIN_GAP_LIMIT_MS + 100);
  });
  // Known stall detection, not a new production latency threshold.
  expect(measured.metrics.maxGapMs).toBeGreaterThanOrEqual(BULK_MAIN_GAP_LIMIT_MS + 100);
  expect(() => checkLatencyBudget('headless caller stall calibration', { elapsedMs: measured.metrics.eventLoopDelayMs }, BULK_MAIN_GAP_LIMIT_MS)).toThrow('budget');
  const idle = await measure(async () => {});
  expect(() => checkLatencyBudget('headless idle calibration', { elapsedMs: idle.metrics.eventLoopDelayMs }, BULK_MAIN_GAP_LIMIT_MS)).not.toThrow();
  console.log('[PF-19 pulse negative control]', JSON.stringify(measured.metrics));
});

// Validate the diagnostic tap itself, including nested append/write and failure cleanup.
it('PF-19 attributes scoped synchronous API bytes without double counting and restores after failure', () => {
  const target = path.join(dir, 'attribution.txt'), originalRead = fs.readFileSync;
  const costs = profileSyncCosts(file => file === target);
  try {
    fs.writeFileSync(target, '界');
    fs.appendFileSync(target, '🙂');
    expect(fs.readFileSync(target)).toEqual(Buffer.from('界🙂'));
    const { createHash } = require('node:crypto');
    const hash = createHash('sha256').update(Buffer.from('界'));
    expect(hash.copy().digest('hex')).toBe('e89b8e5fa2ab010e2bf4d9245b9e0fc2dbd5213500605240ec8a768cbdbd96f2');
    expect(hash.update(Buffer.from('🙂')).digest('hex')).toBe(
      'a05ac2fb5a021ff671db73a10f15e163a0c88541e03c1750ee83974097e31085');
    expect(() => fs.readFileSync(path.join(target, 'missing'))).toThrow(); // outside scope
    fs.unlinkSync(target);
    expect(() => fs.readFileSync(target)).toThrow();
  } finally { costs.stop(); }
  expect(fs.readFileSync).toBe(originalRead);
  expect(costs.report.fs.writeFileSync).toMatchObject({ calls: 1, bytes: 3, failures: 0 });
  expect(costs.report.fs.appendFileSync).toMatchObject({ calls: 1, bytes: 4, failures: 0 });
  expect(costs.report.fs.readFileSync).toMatchObject({ calls: 2, bytes: 7, failures: 1 });
  expect(costs.report.hashBytes).toBe(7);
  expect(costs.report.hashCalls).toBe(1);
  expect(costs.report.hashCopies).toBe(1);
  costs.stop(); // idempotent; never restore an obsolete wrapper twice
});

// File edits must leave the caller responsive without moving their synchronous
// freshness/write transaction across an await. These real-file scenarios also
// protect cancellation, competing callers and committed receipt delivery.
const mutationNames = ['append_file', 'edit_file'] as const;
async function mutationFixture(name: typeof mutationNames[number], suffix = '') {
  const notice = { calls: 0, after: undefined as (() => void) | undefined };
  const local = (await import('../../../../src/main/model/core-agent/local-tools')).createLocalTools({
    userId: uid, cid: 'fixture', onFileWritten: async () => { notice.calls++; notice.after?.(); },
  });
  const ctx = { workingDir: dir, state: { readFileState: new Map(), runScopedLedger: new Map() },
    signal: undefined as AbortSignal | undefined };
  const file = path.join(dir, `fair-${name}${suffix}.txt`), before = 'HEAD_0000\n界🙂\r\nTAIL\n';
  const first = await local.find(tool => tool.name === 'write_file')!.execute({ path: file, content: before }, ctx as any);
  expect(first.isError).not.toBe(true); notice.calls = 0;
  const input = name === 'append_file'
    ? { path: file, content: '追加🙂\r\n', base_revision: revision(first.content) }
    : { path: file, old_string: 'HEAD_0000', new_string: 'HEAD_0001' };
  const expected = name === 'append_file' ? before + '追加🙂\r\n' : before.replace('HEAD_0000', 'HEAD_0001');
  const tool = local.find(tool => tool.name === name)!;
  const invoke = (context = ctx, value = input) => tool.execute(value, context as any);
  return { file, before, expected, input, ctx, notice, invoke };
}
function expectMutationLogs(warningsExpected: string[] = []) {
  expect(warnings).toEqual(warningsExpected); expect(logs.error).toBe(0);
}
const immediateTurn = () => new Promise<void>(resolve => setImmediate(resolve));

it.each(mutationNames)('PF-03 admits an event-loop pulse before %s changes the file and returns committed bytes', async name => {
  const f = await mutationFixture(name);
  let atPulse: string | undefined;
  const pulse = new Promise<void>(resolve => setImmediate(() => { atPulse = fs.readFileSync(f.file, 'utf8'); resolve(); }));
  try {
    const result = await f.invoke();
    expect(atPulse, 'A pending caller event must run before the next mutation').toBe(f.before);
    expect(result.isError).not.toBe(true);
    complete(fs.readFileSync(f.file), Buffer.from(f.expected));
    expect(result.observations?.fileChanges?.[0].afterBytes).toBe(Buffer.byteLength(f.expected));
  } finally { await pulse; }
  expect(f.notice.calls).toBe(1); expectMutationLogs();
});

for (const when of ['already-aborted', 'during-yield'] as const) it.each(mutationNames)(
  `PF-03 prevents a ${when} %s from writing or consuming its valid revision`, async name => {
    const f = await mutationFixture(name), controller = new AbortController();
    f.ctx.signal = controller.signal;
    const reason = new Error('fixture mutation cancelled');
    const pulse = when === 'during-yield'
      ? new Promise<void>(resolve => setImmediate(() => { controller.abort(reason); resolve(); }))
      : Promise.resolve(controller.abort(reason));
    try {
      await expect(f.invoke()).rejects.toThrow('fixture mutation cancelled');
      complete(fs.readFileSync(f.file), Buffer.from(f.before)); expect(f.notice.calls).toBe(0);
    } finally { await pulse; }
    f.ctx.signal = undefined;
    expect((await f.invoke()).isError).not.toBe(true);
    complete(fs.readFileSync(f.file), Buffer.from(f.expected));
    expect(f.notice.calls).toBe(1); expectMutationLogs();
  },
);

it.each(mutationNames)('PF-03 settles cancelled %s lock waiters without a delayed write or leaked lease', async name => {
  const f = await mutationFixture(name), controller = new AbortController();
  const { fileEditLock, _keyedLockCountsForTest } = await import('../../../../src/main/util/locks');
  const release = await fileEditLock(f.file).acquire(); f.ctx.signal = controller.signal;
  const pending = f.invoke().then(value => ({ kind: 'completed', value }), error => ({ kind: 'cancelled', error }));
  let watchdog: ReturnType<typeof setTimeout> | undefined;
  try {
    await immediateTurn(); await immediateTurn(); controller.abort(new Error('fixture lock wait cancelled'));
    // A deadlock watchdog, not a product latency allowance. The held lease
    // must not need release for this individual cancelled caller to settle.
    const outcome = await Promise.race([pending, new Promise<{ kind: string }>(resolve => {
      watchdog = setTimeout(() => resolve({ kind: 'still-waiting' }), 1000);
    })]);
    expect(outcome.kind).toBe('cancelled');
    complete(fs.readFileSync(f.file), Buffer.from(f.before)); expect(f.notice.calls).toBe(0);
  } finally { if (watchdog) clearTimeout(watchdog); release(); await pending; }
  await immediateTurn(); expect(_keyedLockCountsForTest().files).toBe(0);
  complete(fs.readFileSync(f.file), Buffer.from(f.before));
  f.ctx.signal = undefined; expect((await f.invoke()).isError).not.toBe(true);
  complete(fs.readFileSync(f.file), Buffer.from(f.expected)); expectMutationLogs();
});

it.each(mutationNames)('PF-03 checks %s against an external edit delivered by the admitted caller pulse', async name => {
  const f = await mutationFixture(name), external = f.before.replace('HEAD_0000', 'HEAD_9999');
  const pulse = new Promise<void>(resolve => setImmediate(() => { fs.writeFileSync(f.file, external); resolve(); }));
  try {
    const rejected = await f.invoke();
    expect(rejected.isError).toBe(true); expect(rejected.content).toContain('E_STALE');
    complete(fs.readFileSync(f.file), Buffer.from(external)); expect(f.notice.calls).toBe(0);
    const retry = name === 'append_file'
      ? { ...f.input, base_revision: revision(rejected.content) }
      : { ...f.input, old_string: 'HEAD_9999' };
    const recovered = await f.invoke(f.ctx, retry);
    expect(recovered.isError).not.toBe(true);
    complete(fs.readFileSync(f.file), Buffer.from(name === 'append_file' ? external + '追加🙂\r\n' : f.expected));
    expect(f.notice.calls).toBe(1);
  } finally { await pulse; }
  expectMutationLogs(name === 'edit_file' ? ['edit_file freshness reject'] : []);
});

it.each(mutationNames)('PF-03 keeps the completed %s receipt when cancellation arrives from its write notification', async name => {
  const f = await mutationFixture(name), controller = new AbortController();
  f.ctx.signal = controller.signal; f.notice.after = () => controller.abort(new Error('fixture cancelled after commit'));
  const result = await f.invoke();
  expect(controller.signal.aborted).toBe(true); expect(result.isError).not.toBe(true);
  complete(fs.readFileSync(f.file), Buffer.from(f.expected));
  expect(result.observations?.fileChanges?.[0].afterBytes).toBe(Buffer.byteLength(f.expected));
  expect(f.notice.calls).toBe(1);
  f.ctx.signal = undefined; f.notice.after = undefined;
  const repeated = await f.invoke();
  if (name === 'append_file') {
    expect(repeated.isError).not.toBe(true); expect(repeated.content).toContain('replayed="true"');
  } else { expect(repeated.isError).toBe(true); expect(repeated.content).toContain('E_NO_MATCH'); }
  complete(fs.readFileSync(f.file), Buffer.from(f.expected));
  expect(f.notice.calls).toBe(1); expectMutationLogs();
});

it('PF-03 reports partial append_file failure and preserves the damaged bytes for explicit recovery', async () => {
  const f = await mutationFixture('append_file');
  const original = fs.appendFileSync;
  let attempts = 0;
  const spy = vi.spyOn(fs, 'appendFileSync').mockImplementation((file, value, options) => {
    if (file !== f.file) return original(file, value, options);
    attempts++;
    const bytes = typeof value === 'string' ? Buffer.from(value) : value;
    original(file, bytes.subarray(0, 2), options);
    throw Object.assign(new Error('fixture partial append'), { code: 'EIO' });
  });
  syncBuiltinESMExports();
  try {
    const failed = await f.invoke();
    expect(failed.isError).toBe(true); expect(failed.content).toContain('E_APPEND_FAILED');
    expect(attempts).toBe(1); expect(f.notice.calls).toBe(0);
    complete(fs.readFileSync(f.file), Buffer.concat([Buffer.from(f.before), Buffer.from('追加🙂\r\n').subarray(0, 2)]));
  } finally { spy.mockRestore(); syncBuiltinESMExports(); }
  const partial = fs.readFileSync(f.file);
  // The injected two-byte append bisects a UTF-8 character. A retry must
  // preserve those bytes and refuse the invalid file before revision checks.
  const stale = await f.invoke(); expect(stale.isError).toBe(true);
  expect(stale.content).toContain('E_NOT_EDITABLE');
  complete(fs.readFileSync(f.file), partial); expect(f.notice.calls).toBe(0);
  const other = await mutationFixture('append_file', '-recovery');
  expect((await other.invoke()).isError).not.toBe(true); complete(fs.readFileSync(other.file), Buffer.from(other.expected));
  expectMutationLogs();
});

it('PF-03 discards a partial staged edit and allows an explicit retry', async () => {
  const f = await mutationFixture('edit_file');
  const original = fs.writeFileSync;
  let attempts = 0;
  const spy = vi.spyOn(fs, 'writeFileSync').mockImplementation((file, value, options) => {
    const writesFixture = typeof file === 'string' && path.dirname(file) === dir && String(value) === f.expected;
    if (!writesFixture) return original(file, value, options);
    attempts++;
    original(file, Buffer.from(value).subarray(0, 2), options);
    throw Object.assign(new Error('fixture partial staged write'), { code: 'EIO' });
  });
  syncBuiltinESMExports();
  try {
    const failed = await f.invoke();
    expect(failed.isError).toBe(true);
    expect(failed.content).toContain('E_EDIT_FAILED');
    expect(failed.observations?.fileChanges).toBeUndefined();
    expect(attempts).toBe(1);
    expect(f.notice.calls).toBe(0);
    complete(fs.readFileSync(f.file), Buffer.from(f.before));
    expect(fs.readdirSync(dir)).toEqual([path.basename(f.file)]);
  } finally { spy.mockRestore(); syncBuiltinESMExports(); }
  expect((await f.invoke()).isError).not.toBe(true);
  complete(fs.readFileSync(f.file), Buffer.from(f.expected));
  expect(f.notice.calls).toBe(1);
  expectMutationLogs(['edit_file write failed']);
});

it('PF-03 preserves the original file after edit publication fails and allows an explicit retry', async () => {
  const f = await mutationFixture('edit_file');
  const original = fs.renameSync;
  let attempts = 0;
  let stagedBytes: Buffer | undefined;
  let originalBytes: Buffer | undefined;
  const spy = vi.spyOn(fs, 'renameSync').mockImplementation((staged, destination) => {
    if (destination !== f.file) return original(staged, destination);
    attempts++;
    stagedBytes = fs.readFileSync(staged);
    originalBytes = fs.readFileSync(f.file);
    throw Object.assign(new Error('fixture edit publication failure'), { code: 'EIO' });
  });
  syncBuiltinESMExports();
  try {
    const failed = await f.invoke();
    expect(failed.isError).toBe(true);
    expect(failed.content).toContain('E_EDIT_FAILED');
    expect(failed.observations?.fileChanges).toBeUndefined();
    expect(attempts).toBe(1);
    expect(f.notice.calls).toBe(0);
    expect(stagedBytes).toEqual(Buffer.from(f.expected));
    expect(originalBytes).toEqual(Buffer.from(f.before));
    complete(fs.readFileSync(f.file), Buffer.from(f.before));
    expect(fs.readdirSync(dir)).toEqual([path.basename(f.file)]);
  } finally { spy.mockRestore(); syncBuiltinESMExports(); }
  expect((await f.invoke()).isError).not.toBe(true);
  complete(fs.readFileSync(f.file), Buffer.from(f.expected));
  expect(f.notice.calls).toBe(1);
  expectMutationLogs(['edit_file write failed']);
});

it.each(mutationNames)('PF-03 serializes competing %s callers without losing either accepted bytes or stale-write rejection', async name => {
  const f = await mutationFixture(name);
  const secondContext = { ...f.ctx, state: { ...f.ctx.state, readFileState: new Map(f.ctx.state.readFileState) } };
  const secondInput = name === 'append_file' ? { ...f.input, content: 'SECOND' } : { ...f.input, new_string: 'HEAD_0002' };
  const results = await Promise.all([f.invoke(), f.invoke(secondContext, secondInput)]);
  expect(results.filter(value => !value.isError)).toHaveLength(1);
  expect(results.find(value => value.isError)?.content).toContain('E_STALE');
  const winner = !results[0].isError ? f.expected : name === 'append_file' ? f.before + 'SECOND' : f.before.replace('HEAD_0000', 'HEAD_0002');
  complete(fs.readFileSync(f.file), Buffer.from(winner)); expect(f.notice.calls).toBe(1);
  expectMutationLogs(name === 'edit_file' ? ['edit_file freshness reject'] : []);
});

it.each(mutationNames)('PF-03 allows a distinct-file %s to finish while another path is locked', async name => {
  const first = await mutationFixture(name), other = await mutationFixture(name, '-independent');
  const { fileEditLock } = await import('../../../../src/main/util/locks');
  const release = await fileEditLock(first.file).acquire();
  const queued = first.invoke();
  try {
    expect((await other.invoke()).isError).not.toBe(true);
    complete(fs.readFileSync(other.file), Buffer.from(other.expected));
    complete(fs.readFileSync(first.file), Buffer.from(first.before));
  } finally { release(); await queued; }
  complete(fs.readFileSync(first.file), Buffer.from(first.expected)); expectMutationLogs();
});


it.each(mutationNames)('PF-03 completes the %s read-check-write section before admitting a competing microtask', async name => {
  const f = await mutationFixture(name), original = fs.readFileSync;
  let scheduled = false, observed: string | undefined;
  const spy = vi.spyOn(fs, 'readFileSync').mockImplementation(((file: any, ...args: any[]) => {
    const value = (original as Function)(file, ...args);
    if (String(file) === f.file && !scheduled) {
      scheduled = true;
      queueMicrotask(() => { observed = original(f.file, 'utf8'); });
    }
    return value;
  }) as any);
  syncBuiltinESMExports();
  try {
    const result = await f.invoke();
    expect(result.isError).not.toBe(true); expect(scheduled).toBe(true);
    expect(observed).toBe(f.expected); complete(original(f.file), Buffer.from(f.expected));
    expect(f.notice.calls).toBe(1); expectMutationLogs();
  } finally { spy.mockRestore(); syncBuiltinESMExports(); }
});
