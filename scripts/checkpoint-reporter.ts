import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import type { Reporter, FullConfig, Suite, TestCase, TestResult, FullResult } from '@playwright/test/reporter';
import { analyzeWebAppLogs } from '../test/e2e/fixtures/web-app-log-analysis';

/** Structured outcomes, not console text, determine completion. */
export default class CheckpointReporter implements Reporter {
  private report = process.env.ORKAS_TEST_BATCH_REPORT!;
  private events = this.report.replace(/\.json$/, '.events.jsonl');
  private inventory: string[] = [];
  private files: Array<{ file: string; state: string; passed: number; failed: number; skipped: number; durationMs: number }> = [];
  private testFiles: string[] = [];
  private errors = 0;
  private appAnalyses: Array<ReturnType<typeof analyzeWebAppLogs> & { case: string }> = [];
  private artifacts: string[] = [];
  private outputDir = '';

  onBegin(config: FullConfig, suite: Suite) {
    this.outputDir = config.projects[0].outputDir;
    this.inventory = suite.allTests().map(test => test.id);
    this.testFiles = [...new Set(suite.allTests().map(test => test.location.file))].sort();
    fs.writeFileSync(this.events, '', { mode: 0o600 });
  }
  onStdOut(chunk: string | Buffer, test?: TestCase) { this.event('stdout', chunk, test); }
  onStdErr(chunk: string | Buffer, test?: TestCase) { this.event('stderr', chunk, test); }
  private event(stream: string, chunk: string | Buffer, test?: TestCase) {
    fs.appendFileSync(this.events, JSON.stringify({ case: test?.id || 'setup', phase: 'worker', stream, text: chunk.toString() }) + '\n');
  }
  onError() { this.errors++; }
  onTestEnd(test: TestCase, result: TestResult) {
    const failed = result.status !== test.expectedStatus && result.status !== 'skipped';
    // A retry is preserved as a finding and never certified for reuse.
    const state = failed || result.retry > 0 ? 'failed' : result.status === 'skipped' ? 'skipped' : 'passed';
    this.files = this.files.filter(file => file.file !== test.id);
    this.files.push({ file: test.id, state, passed: Number(state === 'passed'), failed: Number(state === 'failed'),
      skipped: Number(state === 'skipped'), durationMs: result.duration });
    const requiredLogs = result.attachments.filter(item => item.name === 'electron-log-required').length;
    if (requiredLogs !== result.attachments.filter(item => item.name === 'electron-logs').length) this.errors++;
    let recovered: Parameters<typeof analyzeWebAppLogs>[1] = [];
    for (const [index, original] of result.attachments.entries()) {
      const attachment = { ...original };
      if (!attachment.path && attachment.body) {
        const id = createHash('sha256').update(`${test.id}/${result.retry}/${index}`).digest('hex');
        attachment.path = path.join(this.outputDir, 'checkpoint-attachments', id);
        fs.mkdirSync(path.dirname(attachment.path), { recursive: true });
        fs.writeFileSync(attachment.path, attachment.body, { mode: 0o600 });
      }
      if (!attachment.path) continue;
      this.artifacts.push(attachment.path);
      if (attachment.name === 'electron-log-required') {
        try { recovered = JSON.parse(fs.readFileSync(attachment.path, 'utf8')); }
        catch { this.errors++; }
      }
      if (attachment.name === 'electron-logs') {
        try {
          const analysis = analyzeWebAppLogs(fs.readFileSync(attachment.path, 'utf8'), recovered);
          this.appAnalyses.push({ ...analysis, case: test.id });
          recovered = [];
        } catch { this.errors++; }
      }
    }
  }
  onEnd(result: FullResult) {
    fs.writeFileSync(this.report, JSON.stringify({ schema: 1, reason: result.status === 'passed' ? 'passed' : 'failed',
      batchUnits: this.testFiles.length, testFiles: this.testFiles, unhandledErrors: this.errors, inventory: this.inventory, files: this.files, appAnalyses: this.appAnalyses,
      artifactPaths: this.artifacts, outputDir: this.outputDir }), { mode: 0o600 });
  }
}
