import { afterAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createStderrReceipt } from '../../../scripts/test-stderr-receipt.mjs';

// Scenario: a maintainer runs any PC Vitest entry (`npm test`, `npm run
// test:apps`, `run-tests.mjs suite <files>`). Emitted logs must be attributed
// to their case or setup/cleanup phase, unexpected errors and unclassified
// stderr must fail even when assertions pass, declared output must pass but stay
// visible, and a missing tap must fail as a coverage gap. The fixtures run
// through the real runner and the real PC config (tap + reporter); only the
// inventory is narrowed.
const pcRoot = path.resolve(__dirname, '../../..');
const node = process.env.ORKAS_TEST_NODE || process.execPath;
const fixtureDir = 'test/fixtures/test-log-analysis';
const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-log-analysis-'));

afterAll(() => fs.rmSync(outDir, { recursive: true, force: true }));

function runFixtures(files: string[], env: Record<string, string> = {}, args: string[] = []) {
  const json = path.join(outDir, `${files.join('-').replace(/\W+/g, '_')}-${Object.keys(env).join('_')}.json`);
  const childEnv: NodeJS.ProcessEnv = Object.fromEntries(Object.entries(process.env)
    .filter(([key]) => !key.startsWith('VITEST')));
  const result = spawnSync(node, ['scripts/run-tests.mjs', 'suite', '--config', `${fixtureDir}/vitest.config.ts`,
    ...files.map(file => `${fixtureDir}/${file}`), ...args], {
    cwd: pcRoot, encoding: 'utf8', timeout: 90_000,
    env: { ...childEnv, ORKAS_LOG_FIXTURE_JSON: json, ORKAS_LOG_FIXTURE_BATCH_REPORT: `${json}.batch.json`, NO_COLOR: '1', ...env },
  });
  expect(result.error).toBeUndefined();
  // The reporter block starts at its status line and is the last stdout output.
  const lines = result.stdout.split(/\r?\n/);
  const start = lines.findIndex(line => /^\[test-log-analysis\] (?:PASS|WARN|FAIL) /.test(line));
  const summary = start < 0 ? [] : lines.slice(start);
  const report = fs.existsSync(json) ? JSON.parse(fs.readFileSync(json, 'utf8')) : { testResults: [] };
  const cases = new Map<string, { status: string; failure: string }>();
  for (const file of report.testResults) {
    for (const item of file.assertionResults) cases.set(item.title, { status: item.status, failure: (item.failureMessages || []).join('\n') });
  }
  const outcomes = [...cases].map(([name, item]) => ({ name, status: item.status }));
  console.info('Nested test log analysis result', {
    fixtures: files, exit_code: result.status, analysis: summary[0] || 'missing',
    cases: outcomes.slice(0, 20), omitted_cases: Math.max(0, outcomes.length - 20),
  });
  const batchPath = `${json}.batch.json`;
  const batch = fs.existsSync(batchPath) ? JSON.parse(fs.readFileSync(batchPath, 'utf8')) : null;
  return { status: result.status, summary: summary.join('\n'), head: summary[0] || '', cases, stderr: result.stderr, batch };
}

describe('default Vitest log analysis', () => {
  it('keeps warning and error analysis when checkpoint mode suppresses successful console replay', () => {
    const expected = runFixtures(['expected.fixture.ts'], {}, ['--silent=passed-only']);
    expect(expected.status).toBe(0);
    expect(JSON.parse(expected.stderr.trim())).toEqual({ type: 'progress', source: 'video_edit', op: 'mix', status: 'running', elapsed_sec: 0.5 });
    const receipt = createStderrReceipt();
    receipt.ingest(expected.stderr);
    expect(expected.batch.stderr).toEqual(receipt.finish());
    expect(expected.batch.inventory).toEqual([`${fixtureDir}/expected.fixture.ts`]);
    expect(expected.batch.files[0]).toMatchObject({ passed: 4, failed: 0, skipped: 0 });
    expect(expected.batch.files[0].durationMs).toBeGreaterThanOrEqual(0);
    expect(expected.head).toMatch(/^\[test-log-analysis\] WARN files=1 cases=4 .* unexpected=0 expected=2 unmet=0 gaps=0$/);
    const unexpected = runFixtures(['unexpected.fixture.ts'], {}, ['--silent=passed-only']);
    expect(unexpected.status).toBe(1);
    expect(unexpected.head).toMatch(/^\[test-log-analysis\] FAIL .* unexpected=4 expected=0 unmet=1 gaps=0$/);
  }, 120_000);
  it('passes declared output but surfaces it, and surfaces an undeclared warning with its owning case', () => {
    const run = runFixtures(['expected.fixture.ts']);
    expect(run.status).toBe(0);
    expect([...run.cases.values()].map(item => item.status)).toEqual(['passed', 'passed', 'passed', 'passed']);
    expect(run.head).toMatch(/^\[test-log-analysis\] WARN files=1 cases=4 .* warn=2 error=1 unexpected=0 expected=2 unmet=0 gaps=0$/);
    expect(run.summary).not.toContain('script-progress');
    expect(run.summary).toContain('warning (expected) x1 runtime-warning [console] fixture recoverable retry { attempt: # } <- '
      + `${fixtureDir}/expected.fixture.ts > passes a declared recoverable warning`);
    expect(run.summary).toContain(`warning x1 runtime-warning [console] fixture undeclared warning <- ${fixtureDir}/expected.fixture.ts > passes but surfaces an undeclared warning`);
    expect(run.summary).toContain('error (expected) x1 runtime-error [console] fixture asserted failure');
  }, 120_000);

  it('fails the owning case for an unexpected error, unclassified stderr or an unmet declaration, without leaking raw content', () => {
    const run = runFixtures(['unexpected.fixture.ts']);
    expect(run.status).toBe(1);
    expect(run.head).toMatch(/^\[test-log-analysis\] FAIL .* unexpected=4 expected=0 unmet=1 gaps=0$/);
    expect(run.cases.get('rejects progress look-alikes on stderr')?.failure).toContain('2 unexpected error-level/unclassified stderr record(s)');
    expect(run.cases.get('fails on an unexpected error')?.failure).toMatch(/case output failed: 1 unexpected .*runtime-error \[console\]/);
    expect(run.cases.get('fails on unclassified stderr')?.failure).toMatch(/unclassified-stderr \[stderr\] x1: fixture raw unexplained diagnostic/);
    expect(run.cases.get('fails when a declared expected log never occurs')?.failure).toContain('1 declared expected log(s) did not occur');
    expect(run.cases.get('keeps an unrelated clean case passing')?.status).toBe('passed');
    expect(run.summary).toContain(`<- ${fixtureDir}/unexpected.fixture.ts > fails on an unexpected error`);
    // The attributed summary and the failure text carry only redacted signatures.
    for (const text of [run.summary, run.cases.get('fails on an unexpected error')?.failure ?? '']) {
      expect(text).not.toContain('fixture-secret-value');
      expect(text).not.toContain('/Users/test/private-notes.txt');
    }
    expect(run.summary).toMatch(/token=\*\*\* <abs-path:[a-f0-9]{12}>/);
  }, 120_000);

  it('attributes stderr outside any case to the file setup and cleanup phases and fails the file', () => {
    const run = runFixtures(['phase.fixture.ts']);
    expect(run.status).toBe(1);
    expect(run.cases.get('passes inside the case')?.status).toBe('passed');
    expect(run.summary).toContain(`unclassified-stderr [stderr] fixture setup-phase noise <- ${fixtureDir}/phase.fixture.ts [setup]`);
    expect(run.summary).toContain(`unclassified-stderr [stderr] fixture cleanup-phase noise <- ${fixtureDir}/phase.fixture.ts [cleanup]`);
    expect(run.stderr).toContain('[test-log-analysis] setup output failed');
  }, 120_000);

  it('fails the run as a coverage gap when executed cases carry no log analysis', () => {
    const run = runFixtures(['expected.fixture.ts'], { ORKAS_LOG_FIXTURE_NO_TAP: '1' });
    expect(run.status).toBe(1);
    expect(run.head).toMatch(/^\[test-log-analysis\] FAIL .* gaps=5$/);
    expect(run.summary).toContain(`coverage gap: ${fixtureDir}/expected.fixture.ts [setup/cleanup] (no analysis)`);
  }, 120_000);

  it('matches global and sticky declarations independently while still rejecting a different error', () => {
    const run = runFixtures(['stateful.fixture.ts']);
    expect(run.status).toBe(1); // The independent unexpected-error control must fail.
    expect(run.cases.get('matches every repeated global declaration')?.status).toBe('passed');
    expect(run.cases.get('matches every repeated sticky declaration')?.status).toBe('passed');
    expect(run.cases.get('matches every repeated frozen-global declaration')?.status).toBe('passed');
    expect(run.cases.get('matches every repeated frozen-sticky declaration')?.status).toBe('passed');
    expect(run.cases.get('still rejects a different error after repeated declared output')?.status).toBe('failed');
    expect(run.head).toMatch(/^\[test-log-analysis\] FAIL files=1 cases=5 .* warn=0 error=11 unexpected=1 expected=10 unmet=0 gaps=0$/);
    expect(run.summary).toContain('fixture different unexpected diagnostic');
  }, 120_000);
});
