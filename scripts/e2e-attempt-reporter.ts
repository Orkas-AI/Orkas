import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import type { Reporter, FullConfig, Suite, FullResult } from '@playwright/test/reporter';

/** Use runner-owned outcomes; omit titles, paths, error bodies and attachments. */
export function summarizeAttempts(suite: Suite, result: FullResult) {
  const cases = suite.allTests().map(test => {
    const attempts = test.results.map(attempt => ({ retry: attempt.retry, status: attempt.status,
      expected: attempt.status === test.expectedStatus && attempt.status !== 'skipped', durationMs: attempt.duration }));
    const first = attempts[0], last = attempts.at(-1);
    const state = !first ? 'not-run' : attempts.every(attempt => attempt.status === 'skipped') ? 'skipped'
      : !last.expected ? 'failed' : !first.expected ? 'recovered' : 'first-pass';
    return { id: createHash('sha256').update(test.id).digest('hex'), state, attempts };
  });
  const count = (state: string) => cases.filter(row => row.state === state).length;
  const skipped = count('skipped'), notRun = count('not-run');
  const executed = cases.length - skipped - notRun;
  const firstAttemptPassed = cases.filter(row => row.attempts[0]?.expected).length;
  const retryRecovered = count('recovered');
  const firstFailed = cases.filter(row => row.attempts[0] && !row.attempts[0].expected
    && row.attempts[0].status !== 'skipped').length;
  return { schemaVersion: 1, status: result.status, durationMs: result.duration, selected: cases.length,
    executed, firstAttemptPassed, retryRecovered, finalFailed: count('failed'), skipped, notRun,
    firstAttemptPassRate: executed ? firstAttemptPassed / executed : null,
    retryRecoveryRate: firstFailed ? retryRecovered / firstFailed : null, cases };
}

export default class AttemptReporter implements Reporter {
  private suite: Suite;
  private output: string;
  onBegin(config: FullConfig, suite: Suite) {
    this.suite = suite;
    this.output = config.projects[0].outputDir;
  }
  onEnd(result: FullResult) {
    if (!this.suite) return;
    const report = summarizeAttempts(this.suite, result);
    fs.mkdirSync(this.output, { recursive: true });
    fs.writeFileSync(path.join(this.output, 'attempt-summary.json'), JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
    console.log(`[e2e-attempts] first-pass=${report.firstAttemptPassed}/${report.executed} recovered=${report.retryRecovered}`
      + ` final-failed=${report.finalFailed} skipped=${report.skipped} not-run=${report.notRun}`);
  }
}
