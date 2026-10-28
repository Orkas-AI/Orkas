/**
 * Default per-case log analysis for every Vitest file (installed by
 * `test/setup-env.ts`; summarized by `test/log-analysis-reporter.ts`).
 *
 * Inside a test worker the tap observes console calls (level known at the call)
 * and raw `process.stdout/stderr` writes (direct writes, Node warnings and
 * Worker-thread output such as the log-delivery console mirror). Each record is
 * classified by the shared `model-eval-log-policy.mjs` collector and attributed
 * to the active case, or to the file's `setup` (before the first case) or
 * `cleanup` (outside a case afterwards) phase. Console records are attributed
 * at the call; raw writes at arrival, so a Worker-thread line delayed past its
 * case boundary lands in the following scope.
 *
 * A case fails on unexpected error-level output, unclassified stderr, a log
 * coverage gap, or a declared expectation that never occurred. Warnings are
 * surfaced, never failed. Only bounded, redacted signatures leave the worker.
 * Blind spot: bytes written straight to the file descriptors by child
 * processes spawned with inherited stdio bypass this tap.
 */
import { formatWithOptions } from 'node:util';
import { afterAll, afterEach, beforeEach } from 'vitest';
import { createModelEvalLogCollector } from '../../scripts/model-eval-log-policy.mjs';
import { sanitizeLogTextForUpload } from '../../src/main/util/log-sanitize';
import { TEST_LOG_META_KEY } from '../log-analysis-reporter';
import { createStderrReceipt } from '../../scripts/test-stderr-receipt.mjs';

export type TestLogLevel = 'warn' | 'error';
export type TestLogPhase = 'case' | 'setup' | 'cleanup';

/** A case's explicit statement that it asserts this output and its recovery. */
export interface ExpectedTestLog {
  level: TestLogLevel;
  /** Logger scope, `console`, `stderr`, `node`, ... as classified by the policy. */
  source?: string;
  /** Matched against the unredacted message inside the worker only. */
  message: RegExp;
}

export interface TestLogSignature {
  severity: 'warning' | 'error';
  code: string;
  source: string;
  phase: TestLogPhase;
  signature: string;
  count: number;
  expected: boolean;
}

export interface TestLogScopeSummary {
  phase: TestLogPhase;
  capturedLineCount: number;
  analyzedLineCount: number;
  levelCounts: { debug: number; info: number; warn: number; error: number };
  streamLineCounts: { stdout: number; stderr: number };
  unexpectedErrorCount: number;
  expectedCount: number;
  unmetExpectations: number;
  coveragePassed: boolean;
  signatures: TestLogSignature[];
  omittedSignatureCount: number;
}

const MAX_SIGNATURES = 20;
const MAX_SIGNATURE_CHARS = 160;
const RUNTIME_PREFIX_RE = /^\[\d{2}:\d{2}:\d{2}\.\d{3}\]\s+\[(?:debug|info|warn|error)\]\s+\[\s*\([^)]*\)\s*\]\s*/i;
const ANSI_RE = /\x1b\[[0-9;]*m/g;
const CONSOLE_LEVELS = { debug: 'debug', log: 'info', info: 'info', dir: 'info', warn: 'warn', error: 'error' } as const;

/** Redacted, de-numbered message template; never the raw line. */
export function testLogSignature(line: string | undefined): string {
  const message = String(line ?? '').replace(RUNTIME_PREFIX_RE, '');
  const text = sanitizeLogTextForUpload(message)
    .replace(/<(?:abs|cloud|file-url)-path:[a-f0-9]{12}>|\d+/g, match => (match.startsWith('<') ? match : '#'))
    .replace(/\s+/g, ' ')
    .trim();
  return text.length > MAX_SIGNATURE_CHARS ? `${text.slice(0, MAX_SIGNATURE_CHARS - 1)}…` : text || '<empty>';
}

interface Scope {
  phase: TestLogPhase;
  collector: ReturnType<typeof createModelEvalLogCollector>;
  signatures: Map<string, TestLogSignature>;
  omitted: number;
  expectations: { spec: ExpectedTestLog; hits: number }[];
  expectedCount: number;
  unexpectedErrorCount: number;
}

interface TapState {
  current: Scope;
  fileExpectations: { spec: ExpectedTestLog; hits: number }[];
  setup: Scope;
  cleanup?: Scope;
  stderrReceipt?: ReturnType<typeof createStderrReceipt>;
}

const STATE_KEY = Symbol.for('orkas.test.log-analysis');

function newScope(phase: TestLogPhase, expectations: Scope['expectations']): Scope {
  const scope: Scope = {
    phase, signatures: new Map(), omitted: 0, expectations, expectedCount: 0, unexpectedErrorCount: 0,
    collector: undefined as never,
  };
  scope.collector = createModelEvalLogCollector(phase, {
    maxLineChars: 1024 * 1024,
    onFinding: (finding: { severity: 'warning' | 'error'; code: string; source?: string }, line?: string) => {
      const source = finding.source || 'unknown';
      const message = String(line ?? '').replace(RUNTIME_PREFIX_RE, '');
      const level: TestLogLevel = finding.severity === 'error' ? 'error' : 'warn';
      const match = scope.expectations.find(({ spec }) => spec.level === level
        && (spec.source === undefined || spec.source === source) && matchesExpectedMessage(spec.message, message));
      if (match) { match.hits += 1; scope.expectedCount += 1; }
      else if (finding.severity === 'error') scope.unexpectedErrorCount += 1;
      const signature = testLogSignature(line);
      const key = [finding.severity, finding.code, source, signature, Boolean(match)].join('\0');
      const existing = scope.signatures.get(key);
      if (existing) existing.count += 1;
      else if (scope.signatures.size < MAX_SIGNATURES) {
        scope.signatures.set(key, {
          severity: finding.severity, code: finding.code, source, phase, signature, count: 1, expected: Boolean(match),
        });
      } else scope.omitted += 1;
    },
  });
  return scope;
}

function matchesExpectedMessage(pattern: RegExp, message: string): boolean {
  // Stateful declarations still match each record independently.
  if (pattern.global || pattern.sticky) pattern.lastIndex = 0;
  return pattern.test(message);
}

function summarize(scope: Scope): TestLogScopeSummary {
  const analysis = scope.collector.finish();
  const unmetExpectations = scope.expectations.filter(item => item.hits === 0).length;
  return {
    phase: scope.phase,
    capturedLineCount: analysis.capturedLineCount,
    analyzedLineCount: analysis.analyzedLineCount,
    levelCounts: { debug: 0, info: 0, warn: 0, error: 0, ...analysis.levelCounts },
    streamLineCounts: { stdout: 0, stderr: 0, ...analysis.streamLineCounts },
    unexpectedErrorCount: scope.unexpectedErrorCount,
    expectedCount: scope.expectedCount,
    unmetExpectations,
    coveragePassed: analysis.coveragePassed,
    signatures: [...scope.signatures.values()],
    omittedSignatureCount: scope.omitted,
  };
}

/** Failure text names classes and redacted signatures only. */
export function testLogFailure(summary: TestLogScopeSummary): string | null {
  const reasons: string[] = [];
  if (!summary.coveragePassed) reasons.push(`log coverage ${summary.analyzedLineCount}/${summary.capturedLineCount}`);
  if (summary.unexpectedErrorCount) {
    const shown = summary.signatures.filter(item => item.severity === 'error' && !item.expected).slice(0, 5)
      .map(item => `${item.code} [${item.source}] x${item.count}: ${item.signature}`);
    reasons.push(`${summary.unexpectedErrorCount} unexpected error-level/unclassified stderr record(s): ${shown.join('; ')}`);
  }
  if (summary.unmetExpectations) reasons.push(`${summary.unmetExpectations} declared expected log(s) did not occur`);
  return reasons.length
    ? `[test-log-analysis] ${summary.phase} output failed: ${reasons.join(' | ')}. Fix the cause, or assert the path and declare it with expectTestLog().`
    : null;
}

function tapState(): TapState | undefined {
  return (globalThis as Record<symbol, TapState | undefined>)[STATE_KEY];
}

/**
 * Declare output that the current case (or, outside a case, this file's
 * setup/cleanup phases) deliberately produces and asserts. Matching records are
 * surfaced as expected instead of failing; a declaration that never matches
 * fails, so stale declarations cannot hide later regressions.
 */
export function expectTestLog(spec: ExpectedTestLog): void {
  const state = tapState();
  if (!state) throw new Error('test log analysis is not installed');
  // Own mutable match state without changing (or writing into a frozen)
  // caller-owned RegExp. Ordinary stateless declarations retain their path.
  const owned = spec.message.global || spec.message.sticky
    ? { ...spec, message: new RegExp(spec.message.source, spec.message.flags) } : spec;
  const entry = { spec: owned, hits: 0 };
  if (state.current.phase === 'case') state.current.expectations.push(entry);
  else state.fileExpectations.push(entry);
}

function formatConsoleRecord(level: string, args: unknown[]): string {
  let text: string;
  try { text = formatWithOptions({ colors: false }, ...args); } catch { text = '[unformattable console arguments]'; }
  return `[00:00:00.000] [${level}] [(console)] ${text.replace(ANSI_RE, '').replace(/\r?\n/g, ' \\n ')}\n`;
}

/** Skill scripts report progress as one JSON object per stderr line; the
 * product consumer (`model/core-agent/local-tools.ts` progress parser) accepts
 * exactly `{"type":"progress",...}` lines up to 64 KiB. */
export function isScriptProgressLine(line: string): boolean {
  if (line.length > 64 * 1024 || !line.startsWith('{')) return false;
  try {
    const parsed = JSON.parse(line) as unknown;
    return !!parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      && (parsed as Record<string, unknown>).type === 'progress';
  } catch { return false; }
}

function installStreamTaps(state: TapState): void {
  const ingest = (stream: 'stdout' | 'stderr', chunk: unknown, encoding?: unknown) => {
    try {
      let text = typeof chunk === 'string' ? chunk
        : chunk instanceof Uint8Array ? Buffer.from(chunk).toString(typeof encoding === 'string' ? encoding as BufferEncoding : 'utf8')
          : String(chunk);
      text = text.replace(ANSI_RE, '');
      // Classify only whole-line writes; a split record stays unclassified.
      if (stream === 'stderr' && text.endsWith('\n') && text.includes('"progress"')) {
        text = text.slice(0, -1).split('\n').map(line => (isScriptProgressLine(line.replace(/\r$/, ''))
          ? '[00:00:00.000] [info] [(script-progress)] progress record' : line)).join('\n') + '\n';
      }
      state.current.collector.ingest(stream, text);
    } catch { /* Analysis must not break the test's own output. */ }
  };
  for (const stream of ['stdout', 'stderr'] as const) {
    const target = process[stream];
    const original = target.write;
    target.write = function tappedWrite(this: typeof target, chunk: unknown, ...rest: unknown[]) {
      ingest(stream, chunk, rest[0]);
      if (stream === 'stderr' && state.stderrReceipt) {
        state.stderrReceipt.ingest(chunk, typeof rest[0] === 'string' ? rest[0] : undefined);
      }
      return (original as (...args: unknown[]) => boolean).call(this, chunk, ...rest);
    } as typeof target.write;
  }
  for (const [method, level] of Object.entries(CONSOLE_LEVELS)) {
    const original = (console as unknown as Record<string, (...args: unknown[]) => void>)[method];
    if (typeof original !== 'function') continue;
    const stream = level === 'warn' || level === 'error' ? 'stderr' : 'stdout';
    (console as unknown as Record<string, unknown>)[method] = function tappedConsole(...args: unknown[]) {
      try { state.current.collector.ingest(stream, formatConsoleRecord(level, args)); } catch { /* keep logging */ }
      return original.apply(console, args);
    };
  }
}

/**
 * Called by `test/setup-env.ts` for every test file. Stream taps install once
 * per worker global (a reused worker keeps them); scopes and hooks are per file.
 */
export function installTestLogAnalysis(): void {
  let state = tapState();
  const fileExpectations: Scope['expectations'] = [];
  const setup = newScope('setup', fileExpectations);
  if (state) Object.assign(state, { current: setup, fileExpectations, setup, cleanup: undefined });
  else {
    state = { current: setup, fileExpectations, setup };
    (globalThis as Record<symbol, TapState | undefined>)[STATE_KEY] = state;
    installStreamTaps(state);
  }
  const fileState = state;
  fileState.stderrReceipt = process.env.ORKAS_TEST_BATCH_REPORT ? createStderrReceipt() : undefined;

  beforeEach(() => {
    fileState.current = newScope('case', []);
  });
  afterEach(({ task }) => {
    const scope = fileState.current;
    fileState.cleanup ??= newScope('cleanup', fileState.fileExpectations);
    fileState.current = fileState.cleanup;
    if (scope.phase !== 'case') return;
    const summary = summarize(scope);
    (task.meta as Record<string, unknown>)[TEST_LOG_META_KEY] = summary;
    const failure = testLogFailure(summary);
    // A case that already failed keeps its own failure; its log findings stay
    // in the summary without adding a second, less relevant error.
    if (failure && !task.result?.errors?.length) throw new Error(failure);
  });
  // eslint-disable-next-line no-empty-pattern -- Vitest requires a destructured context.
  afterAll(({}, suite) => {
    const phases = [summarize(fileState.setup), ...(fileState.cleanup ? [summarize(fileState.cleanup)] : [])];
    // File-level declarations may be satisfied in either phase.
    const unmet = fileState.fileExpectations.filter(item => item.hits === 0).length;
    for (const phase of phases) phase.unmetExpectations = 0;
    phases[phases.length - 1].unmetExpectations = unmet;
    (suite.meta as Record<string, unknown>)[TEST_LOG_META_KEY] = phases;
    if (fileState.stderrReceipt) (suite.meta as Record<string, unknown>).orkasStderrReceipt = fileState.stderrReceipt.finish();
    // Output after the last hook (worker teardown) has no reporting channel.
    fileState.setup = newScope('setup', []);
    fileState.cleanup = undefined;
    fileState.current = fileState.setup;
    const failures = phases.map(testLogFailure).filter(Boolean);
    if (failures.length) throw new Error(failures.join('\n'));
  });
}
