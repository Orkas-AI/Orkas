/**
 * Default Vitest reporter half of the test log policy (Common/docs/
 * test-case-design.md §3.1). The worker tap (`helpers/test-log-analysis.ts`)
 * fails the owning case/file on unexpected errors; this reporter prints the
 * attributed, redacted summary after every run and fails the run when any
 * executed case or file lacks analysis (coverage gap), so a missing tap cannot
 * pass silently. Printed text is bounded and built only from redacted
 * signatures, repository-relative test files and test names.
 */
import { Console } from 'node:console';
import { relative, resolve } from 'node:path';
import { writeFileSync } from 'node:fs';
import { Writable } from 'node:stream';
import { DefaultReporter, parseCLI, type TestModule, type TestSpecification, type Vitest } from 'vitest/node';
import type { TestLogScopeSummary, TestLogSignature } from './helpers/test-log-analysis';
import { combineStderrReceipts, createStderrReceipt } from '../scripts/test-stderr-receipt.mjs';

/** Task-meta key shared with the worker tap; this module must not load Vitest's runtime. */
export const TEST_LOG_META_KEY = 'orkasLogAnalysis';

const MAX_SIGNATURE_LINES = 40;
const MAX_FILE_LINES = 30;
const MAX_OWNERS = 3;

interface Owned extends TestLogSignature { owners: string[]; ownerCount: number }

export interface TestLogRunSummary {
  status: 'PASS' | 'WARN' | 'FAIL';
  files: number;
  cases: number;
  lines: number;
  levels: { debug: number; info: number; warn: number; error: number };
  unexpected: number;
  expected: number;
  unmetExpectations: number;
  coverageGaps: string[];
  signatures: Owned[];
  fileLevels: { file: string; warn: number; error: number; casesWithFindings: number }[];
  omittedSignatures: number;
}

export function summarizeTestLogs(modules: readonly TestModule[], root: string): TestLogRunSummary {
  const summary: TestLogRunSummary = {
    status: 'PASS', files: 0, cases: 0, lines: 0, levels: { debug: 0, info: 0, warn: 0, error: 0 },
    unexpected: 0, expected: 0, unmetExpectations: 0, coverageGaps: [], signatures: [], fileLevels: [], omittedSignatures: 0,
  };
  const signatures = new Map<string, Owned>();
  const add = (scope: TestLogScopeSummary, owner: string) => {
    summary.lines += scope.capturedLineCount;
    for (const level of ['debug', 'info', 'warn', 'error'] as const) summary.levels[level] += scope.levelCounts[level] || 0;
    summary.unexpected += scope.unexpectedErrorCount;
    summary.expected += scope.expectedCount;
    summary.unmetExpectations += scope.unmetExpectations;
    summary.omittedSignatures += scope.omittedSignatureCount;
    if (!scope.coveragePassed) summary.coverageGaps.push(`${owner} (${scope.analyzedLineCount}/${scope.capturedLineCount})`);
    for (const item of scope.signatures) {
      const key = [item.severity, item.code, item.source, item.signature, item.expected].join('\0');
      const existing = signatures.get(key);
      if (!existing) signatures.set(key, { ...item, owners: [owner], ownerCount: 1 });
      else {
        existing.count += item.count;
        existing.ownerCount += 1;
        if (existing.owners.length < MAX_OWNERS) existing.owners.push(owner);
      }
    }
    return (scope.levelCounts.warn || 0) + (scope.levelCounts.error || 0) + scope.unexpectedErrorCount > 0;
  };
  for (const module of modules) {
    const file = relative(root, module.moduleId).replace(/\\/g, '/');
    let executed = 0;
    let withFindings = 0;
    const before = { ...summary.levels };
    for (const testCase of module.children.allTests()) {
      const state = testCase.result().state;
      if (state !== 'passed' && state !== 'failed') continue;
      executed += 1;
      const scope = testCase.meta()[TEST_LOG_META_KEY as keyof ReturnType<typeof testCase.meta>] as TestLogScopeSummary | undefined;
      const owner = `${file} > ${testCase.fullName}`;
      if (!scope) { summary.coverageGaps.push(`${owner} (no analysis)`); continue; }
      if (add(scope, owner)) withFindings += 1;
    }
    if (!executed) continue;
    summary.files += 1;
    summary.cases += executed;
    const phases = module.meta()[TEST_LOG_META_KEY as keyof ReturnType<typeof module.meta>] as TestLogScopeSummary[] | undefined;
    if (!Array.isArray(phases)) summary.coverageGaps.push(`${file} [setup/cleanup] (no analysis)`);
    else for (const phase of phases) add(phase, `${file} [${phase.phase}]`);
    const warn = summary.levels.warn - before.warn;
    const error = summary.levels.error - before.error;
    if (warn || error) summary.fileLevels.push({ file, warn, error, casesWithFindings: withFindings });
  }
  summary.signatures = [...signatures.values()].sort((a, b) => (a.severity === b.severity ? b.count - a.count : a.severity === 'error' ? -1 : 1));
  summary.status = summary.unexpected || summary.unmetExpectations || summary.coverageGaps.length ? 'FAIL'
    : summary.signatures.length ? 'WARN' : 'PASS';
  return summary;
}

export function formatTestLogSummary(summary: TestLogRunSummary): string {
  const out = [`[test-log-analysis] ${summary.status} files=${summary.files} cases=${summary.cases} lines=${summary.lines}`
    + ` debug=${summary.levels.debug} info=${summary.levels.info} warn=${summary.levels.warn} error=${summary.levels.error}`
    + ` unexpected=${summary.unexpected} expected=${summary.expected} unmet=${summary.unmetExpectations} gaps=${summary.coverageGaps.length}`];
  if (summary.signatures.length) {
    out.push('[test-log-analysis] distinct signatures (severity, count, code [source], owner):');
    for (const item of summary.signatures.slice(0, MAX_SIGNATURE_LINES)) {
      const owners = item.owners.join(' | ') + (item.ownerCount > item.owners.length ? ` | +${item.ownerCount - item.owners.length} more` : '');
      out.push(`  ${item.severity}${item.expected ? ' (expected)' : ''} x${item.count} ${item.code} [${item.source}] ${item.signature} <- ${owners}`);
    }
    if (summary.signatures.length > MAX_SIGNATURE_LINES) out.push(`  +${summary.signatures.length - MAX_SIGNATURE_LINES} more signatures`);
  }
  if (summary.omittedSignatures) out.push(`[test-log-analysis] ${summary.omittedSignatures} record(s) beyond the per-scope signature cap are counted but not listed`);
  if (summary.fileLevels.length) {
    out.push('[test-log-analysis] files with warn/error output:');
    for (const item of summary.fileLevels.slice(0, MAX_FILE_LINES)) {
      out.push(`  ${item.file} warn=${item.warn} error=${item.error} cases=${item.casesWithFindings}`);
    }
    if (summary.fileLevels.length > MAX_FILE_LINES) out.push(`  +${summary.fileLevels.length - MAX_FILE_LINES} more files`);
  }
  for (const gap of summary.coverageGaps.slice(0, MAX_FILE_LINES)) out.push(`[test-log-analysis] coverage gap: ${gap}`);
  return `${out.join('\n')}\n`;
}

export function reconcileTestFileSelection(filters: readonly string[], moduleIds: readonly string[], root: string, incremental = false) {
  const discovered = moduleIds.map(file => resolve(file).replace(/\\/g, '/'));
  const missing = incremental ? [] : filters.flatMap((filter, index) => {
    const file = filter.replace(/:\d+(?:-\d+)?$/, '').replace(/\\/g, '/').replace(/^\.\//, '');
    return discovered.some(candidate => candidate === resolve(root, file).replace(/\\/g, '/')
      || candidate.endsWith(`/${file}`)) ? [] : [index];
  });
  return { requested: filters.length, missing, incremental };
}

export class TestLogAnalysisReporter extends DefaultReporter {
  private root = process.cwd();
  private inventory: string[] = [];
  private requestedFiles: string[] = [];
  private incremental = false;
  private selection = { requested: 0, missing: [] as number[], incremental: false };

  override onInit(vitest: Vitest): void {
    super.onInit(vitest);
    this.root = vitest.config.root;
    this.incremental = vitest.config.watch === true;
    // Use the owning CLI parser, so option values and commands cannot become
    // positional selections. Partial/directory filters keep Vitest semantics.
    this.requestedFiles = parseCLI(['vitest', ...process.argv.slice(2)]).filter
      .filter(file => /\.[cm]?[jt]sx?(?::\d+(?:-\d+)?)?$/.test(file) && !/[?*{}]/.test(file));
  }

  override onTestRunStart(specifications: readonly TestSpecification[]): void {
    super.onTestRunStart(specifications);
    this.inventory = [];
    // The pre-shard inventory is deliberate: later shards own the remaining
    // files, while an excluded/nonexistent requested file is never discovered.
    // Watch reruns intentionally contain only invalidated files, not a full
    // selection. They cannot certify a terminal whole-selection result.
    this.selection = reconcileTestFileSelection(this.requestedFiles,
      specifications.map(spec => spec.moduleId), this.root, this.incremental);
  }

  override onTestModuleQueued(module: TestModule): void {
    super.onTestModuleQueued(module);
    // onTestRunStart receives the pre-shard inventory in Vitest 4. Queue events
    // identify the selected shard, including files that fail during collection.
    this.inventory.push(relative(this.root, module.moduleId).replace(/\\/g, '/'));
  }

  override onTestRunEnd(...args: Parameters<DefaultReporter['onTestRunEnd']>): void {
    const [modules, errors, reason] = args;
    const processReport = process.env.ORKAS_TEST_PROCESS_REPORT;
    const batchReport = process.env.ORKAS_TEST_BATCH_REPORT;
    const reportingStderr = createStderrReceipt();
    if (processReport || batchReport) {
      // Attribute bytes at the framework's synchronous result formatter.
      // Worker stderr, direct FD writes, and other reporters still go through
      // the ordinary stream without inheriting this receipt.
      const logger = this.ctx.logger;
      const originalConsole = logger.console;
      const stderr = new Writable({
        write(chunk, _encoding, done) {
          reportingStderr.ingest(chunk);
          logger.errorStream.write(chunk);
          done();
        },
      });
      logger.console = new Console({ stdout: logger.outputStream, stderr });
      try { super.onTestRunEnd(...args); }
      finally { logger.console = originalConsole; }
    } else {
      super.onTestRunEnd(...args);
    }

    const summary = summarizeTestLogs(modules, this.root);
    if (this.selection.missing.length) {
      summary.coverageGaps.push(`Requested files not discovered (filter indices: ${this.selection.missing.slice(0, 40).join(',')})`);
      summary.status = 'FAIL';
    }
    process.stdout.write(formatTestLogSummary(summary));
    if (this.selection.missing.length) {
      process.stdout.write(`[test-selection] FAIL requested file was not discovered; filter indices=${this.selection.missing.slice(0, 40).join(',')}`
        + ` missing=${this.selection.missing.length}\n`);
      process.exitCode = 1;
    }
    if (summary.status === 'FAIL') process.exitCode = 1;
    if (!processReport && !batchReport) return;
    const stderr = combineStderrReceipts([
      reportingStderr.finish(),
      ...modules.filter(module => module.state() !== 'skipped')
        .map(module => (module.meta() as Record<string, unknown>).orkasStderrReceipt),
    ]);
    if (processReport) {
      // Only the bounded receipt crosses this launcher boundary, never raw text.
      writeFileSync(processReport, JSON.stringify({ schema: 1, stderr }), { mode: 0o600 });
    }
    if (batchReport) {
      const files = modules.map(module => {
        const counts = { passed: 0, failed: 0, skipped: 0 };
        for (const test of module.children.allTests()) {
          const state = test.result().state;
          if (state in counts) counts[state as keyof typeof counts] += 1;
        }
        const diagnostic = module.diagnostic();
        return { file: relative(this.root, module.moduleId).replace(/\\/g, '/'), state: module.state(), ...counts,
          durationMs: diagnostic.duration, collectMs: diagnostic.collectDuration, setupMs: diagnostic.setupDuration,
          prepareMs: diagnostic.prepareDuration, environmentMs: diagnostic.environmentSetupDuration };
      });
      // No raw logs, environment values or test payloads in structured reports.
      // The launcher retains stdout/stderr separately with restricted permissions.
      writeFileSync(batchReport, JSON.stringify({ schema: 1, reason, selection: this.selection,
        unhandledErrors: errors.length, inventory: this.inventory, files, logs: summary, stderr,
      }), { mode: 0o600 });
    }
  }
}
