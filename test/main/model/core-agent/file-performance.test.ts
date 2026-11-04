import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { profileSyncCosts } from '../../../helpers/sync-cost.cjs';
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
  fs.rmSync(root, { recursive: true, force: true });
});
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
async function measure<T>(work: () => Promise<T>) {
  const cpu = process.cpuUsage(), memoryBefore = process.memoryUsage();
  let last = performance.now(), maxGapMs = 0, ticks = 0;
  const timer = setInterval(() => { const now = performance.now(); maxGapMs = Math.max(maxGapMs, now - last); last = now; ticks++; }, 2);
  try {
    await new Promise(resolve => setTimeout(resolve, 5));
    last = performance.now(); ticks = 0; maxGapMs = 0;
    const start = performance.now(); const value = await work(); const elapsedMs = performance.now() - start;
    await new Promise(resolve => setTimeout(resolve, 5));
    const used = process.cpuUsage(cpu), memoryAfter = process.memoryUsage();
    return { value, metrics: { elapsedMs, maxGapMs, ticks, cpuUserMs: used.user / 1000, cpuSystemMs: used.system / 1000,
      rssBefore: memoryBefore.rss, rssAfter: memoryAfter.rss, externalBefore: memoryBefore.external, externalAfter: memoryAfter.external } };
  } finally { clearInterval(timer); }
}

it('PF-03 measures fixed final bytes across chunk counts without accepting truncation or replay', async () => {
  const call = await tools(), measurements = [];
  for (const finalBytes of [256 * 1024, 1024 * 1024, 8 * 1024 * 1024]) {
    // Same independently constructed Unicode payload at every chunk count.
    const expected = Buffer.from('界x'.repeat(finalBytes / 4));
    for (const chunks of [4, 16, 32]) {
      const target = path.join(dir, `source-${finalBytes}-${chunks}.txt`);
      const chunk = expected.subarray(0, finalBytes / chunks).toString('utf8');
      const first = await call('write_file', { path: target, content: chunk });
      expect(first.isError).not.toBe(true); let base = revision(first.content);
      const costs = ATTRIBUTION ? profileSyncCosts(file => String(file) === target) : null;
      const original = fs.readFileSync;
      let sourceReads = 0, sourceReadBytes = 0, maxAppendMs = 0;
      const spy = vi.spyOn(fs, 'readFileSync').mockImplementation(((file: fs.PathOrFileDescriptor, ...args: unknown[]) => {
        const result = (original as Function)(file, ...args);
        if (String(file) === target) { sourceReads++; sourceReadBytes += Buffer.byteLength(result); }
        return result;
      }) as typeof fs.readFileSync);
      syncBuiltinESMExports();
      let measured;
      try {
        measured = await measure(async () => {
          for (let n = 1; n < chunks; n++) {
            const operationStart = performance.now();
            const result = await call('append_file', { path: target, content: chunk, base_revision: base });
            maxAppendMs = Math.max(maxAppendMs, performance.now() - operationStart);
            expect(result.isError).not.toBe(true); base = revision(result.content);
          }
        });
      } finally { spy.mockRestore(); syncBuiltinESMExports(); costs?.stop(); }
      complete(fs.readFileSync(target), expected);
      // Tap validity only, NOT a requirement to preserve the inefficient number of reads.
      expect(sourceReads).toBeGreaterThan(0); expect(sourceReadBytes).toBeGreaterThan(0);
      measurements.push({ finalBytes, chunks, sourceReads, sourceReadBytes, maxAppendMs, ...(costs ? { callerCosts: costs.report } : {}), ...measured.metrics });
    }
  }
  expect(logs.warn).toBe(0); expect(logs.error).toBe(0);
  console.log('[PF-03 fixed-payload append]', JSON.stringify({ measurements, capturedLogs: logs,
    scope: 'one sample per workload; API reads, warm OS cache; endpoint memory, not peak; no latency gate' }));
}, 30000);

it('PF-03 preserves replay and stale-write protection after a long append/edit sequence', async () => {
  const call = await tools(), target = path.join(dir, 'editable.txt');
  const source = 'HEAD_0000\n' + '界x'.repeat(256 * 1024) + '\nTAIL';
  const first = await call('write_file', { path: target, content: source });
  const append = { path: target, content: '\nNEW', base_revision: revision(first.content) };
  expect((await call('append_file', append)).isError).not.toBe(true);
  expect((await call('append_file', append)).isError).not.toBe(true);
  complete(fs.readFileSync(target), Buffer.from(source + '\nNEW'));
  const costs = ATTRIBUTION ? profileSyncCosts(file => String(file) === target) : null;
  let maxEditMs = 0;
  let measured;
  try { measured = await measure(async () => {
    for (let n = 0; n < 100; n++) {
      const operationStart = performance.now();
      const result = await call('edit_file', { path: target, old_string: `HEAD_${String(n).padStart(4, '0')}`,
        new_string: `HEAD_${String(n + 1).padStart(4, '0')}` });
      maxEditMs = Math.max(maxEditMs, performance.now() - operationStart);
      expect(result.isError, `edit ${n}`).not.toBe(true);
    }
  }); } finally { costs?.stop(); }
  const expected = Buffer.from(source.replace('HEAD_0000', 'HEAD_0100') + '\nNEW');
  complete(fs.readFileSync(target), expected);
  const external = Buffer.concat([expected, Buffer.from('\nEXTERNAL')]); fs.writeFileSync(target, external);
  const stale = await call('edit_file', { path: target, old_string: 'HEAD_0100', new_string: 'WRONG' });
  expect(stale.isError).toBe(true); expect(stale.content).toContain('E_STALE');
  complete(fs.readFileSync(target), external);
  expect(warnings).toEqual(['edit_file freshness reject']); expect(logs.error).toBe(0);
  console.log('[PF-03 repeated edit]', JSON.stringify({ edits: 100, maxEditMs, ...(costs ? { callerCosts: costs.report } : {}), finalBytes: expected.length, ...measured.metrics, capturedLogs: logs, expectedWarnings: warnings }));
}, 30000);

it.skipIf(!RG_AVAILABLE)('PF-19 completes repository search and Office extraction during eight code-writing tasks', async () => {
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
  const measured = await measure(async () => Promise.all([
    extractOffice('xlsx-markdown', workbook),
    grepRepository(repository, { pattern: 'PF_NEEDLE', regex: false, caseSensitive: true, contextLines: 0,
      maxResults: 200, includeGlobs: [], excludeGlobs: [] }),
    Promise.all(inputs.map(async input => {
      for (let n = 1; n < 16; n++) {
        const result = await call('append_file', { path: input.target, content: chunk, base_revision: input.base });
        expect(result.isError).not.toBe(true); input.base = revision(result.content);
      }
    })),
  ]));
  const [text, search] = measured.value;
  const extracted = text.split('\n').filter(line => /^Row \d+:/.test(line));
  expect(extracted).toEqual(rows.map((row, n) => `Row ${n + 1}: ${row.join('\t')}`));
  expect(workbook).toEqual(originalWorkbook);
  expect(search.available).toBe(true); expect(search.error).toBeUndefined(); expect(search.capped).toBe(false);
  expect(search.hits.map(hit => path.basename(hit.path)).sort()).toEqual(expectedHits);
  expect(search.hits.every(hit => hit.line === 2 && hit.text === 'PF_NEEDLE')).toBe(true);
  for (const { target } of inputs) complete(fs.readFileSync(target), expected);
  expect(logs.warn).toBe(0); expect(logs.error).toBe(0);
  console.log('[PF-19 code-search-office]', JSON.stringify({ tasks: 8, appends: 120, fileBytes: expected.length,
    officeRows: rows.length, searchHits: expectedHits.length, ...measured.metrics, capturedLogs: logs,
    scope: 'actual local dependencies, host event loop; not renderer input/physical disk/production model' }));
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
      for (const backend of ['native', 'fallback']) {
        if (backend === 'fallback') process.env.PATH = root; // no rg, actual traversal remains real
        const costs = ATTRIBUTION ? profileSyncCosts(file => typeof file === 'string' && file.startsWith(repository)) : null;
        let measured;
        try { measured = await measure(() => search.execute({ root: repository, query: 'match-' }, { workingDir: dir, state: {} })); }
        finally { costs?.stop(); }
        const result = measured.value;
        expect(result.isError).not.toBe(true); expect(result.content).toContain('complete=true');
        expect(result.content).toContain(`backend=${backend === 'native' ? 'rg' : 'walk'}`);
        const listing = JSON.parse(result.content.slice(result.content.indexOf('{')));
        expect(listing.files.map((file: { root: number; path: string }) => path.join(listing.roots[file.root], file.path)).sort()).toEqual([...expected].sort());
        measurements.push({ backend, ...(costs ? { callerCosts: costs.report } : {}), ...measured.metrics });
      }
    } finally { if (priorPath === undefined) delete process.env.PATH; else process.env.PATH = priorPath; }
    expect(logs.warn).toBe(0); expect(logs.error).toBe(0);
    console.log('[PF-06 repository scale]', JSON.stringify({ files, emptyDirectories: 100, matches: expected.length, measurements,
      capturedLogs: logs, scope: 'real directory traversal and rg; file creation excluded; no cold physical disk/p95 claim' }));
  }, 60000);
}

it('PF-19 rejects a truncated/replayed result and detects a deliberately blocking caller', async () => {
  const expected = Buffer.from('complete-界-end');
  expect(() => complete(expected.subarray(0, -1), expected)).toThrow('Incomplete');
  expect(() => complete(Buffer.concat([expected, expected]), expected)).toThrow('duplicated');
  const measured = await measure(async () => {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 40);
  });
  // Known stall detection, not a new production latency threshold.
  expect(measured.metrics.maxGapMs).toBeGreaterThanOrEqual(40);
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
    expect(createHash('sha256').update(Buffer.from('界🙂')).digest('hex')).toBe(
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
  costs.stop(); // idempotent; never restore an obsolete wrapper twice
});
