/** Public local-CLI acceptance host. No private case catalog or hosted services. */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  attachProcessLogAnalysis, attachProcessTermination, createModelEvalLogCollector,
  formatProcessLogSummary, mergeModelEvalLogAnalyses,
} from './model-eval-log-policy.mjs';

function runCaptured(command, args, options, collector) {
  return new Promise(resolve => {
    const child = spawn(command, args, { ...options, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let spawnError;
    for (const [stream, output] of [['stdout', process.stdout], ['stderr', process.stderr]]) {
      child[stream].on('data', chunk => {
        collector.ingest(stream, chunk);
        try { output.write(chunk); } catch (error) { if (error?.code !== 'EPIPE') throw error; }
      });
    }
    child.once('error', error => { spawnError = error; collector.addFinding('error', 'launcher-failure', 'launcher'); });
    child.once('close', (code, signal) => resolve({ code: code ?? 1, signal, spawnError }));
  });
}

// A diagnostic report cannot escape the acceptance output directory, including
// through symlinks, and native CLI log health cannot be erased by a clean host.
export function attachLocalAgentReports({ analysis, cwd, reportsDir, signal }) {
  let passed = true;
  const root = path.resolve(reportsDir);
  for (const reported of analysis.reportPaths) {
    const target = path.resolve(cwd, reported);
    const relative = path.relative(root, target);
    if (relative.startsWith('..') || path.isAbsolute(relative) || !relative.endsWith('.json')
      || !fs.existsSync(target) || fs.lstatSync(target).isSymbolicLink()) continue;
    const actual = path.relative(fs.realpathSync(root), fs.realpathSync(target));
    if (actual.startsWith('..') || path.isAbsolute(actual)) continue;
    const report = JSON.parse(fs.readFileSync(target, 'utf8'));
    const native = (report.results ?? []).filter(row => Object.hasOwn(row, 'cliLogAnalysis')).map(row => row.cliLogAnalysis);
    const nativePassed = native.every(logs => logs?.passed === true && logs.coveragePassed === true
      && logs.levelCounts?.error === 0 && Number.isSafeInteger(logs.levelCounts?.warn) && logs.levelCounts.warn >= 0);
    passed &&= nativePassed;
    const requiresReview = analysis.requiresReview || !nativePassed || native.some(logs => logs.requiresReview || logs.levelCounts.warn > 0);
    report.logAcceptance = { passed: analysis.passed && nativePassed, requiresReview,
      clean: analysis.passed && nativePassed && !requiresReview };
    fs.writeFileSync(target, JSON.stringify(report, null, 2) + '\n');
    attachProcessLogAnalysis(target, { ...analysis, reportPaths: [] });
    if (signal) attachProcessTermination(target, { signal });
  }
  return passed;
}

export async function runLocalAgentLauncher({ argv, childEnv, electronBin, electronEntry, runner, cwd,
  disableGpu = true, reportsDir, run = runCaptured }) {
  const container = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-local-agent-live-'));
  const userData = path.join(container, 'electron');
  const data = path.join(container, 'data');
  fs.mkdirSync(data, { recursive: true });
  fs.mkdirSync(userData);
  const env = { ...childEnv, ORKAS_WORKSPACE_ROOT: data };
  // Electron treats an empty variable as enabled; explicit Node mode still fails.
  for (const key of Object.keys(env)) {
    if (key.toUpperCase() === 'ELECTRON_RUN_AS_NODE' && env[key] === '') delete env[key];
  }
  try {
    const preparation = createModelEvalLogCollector('environment');
    const prepared = await run(process.execPath, [path.join(cwd, 'scripts', 'ensure-dev-dependencies.cjs')],
      { cwd, env }, preparation);
    if (prepared.code !== 0 || prepared.signal || prepared.spawnError) preparation.addFinding('error', 'environment-preflight-failure', 'dev-dependencies');
    const environmentAnalysis = preparation.finish();
    if (!environmentAnalysis.passed) {
      process.stdout.write(formatProcessLogSummary(mergeModelEvalLogAnalyses([environmentAnalysis])) + '\n');
      return 78;
    }
    const runtime = createModelEvalLogCollector('runtime');
    const result = await run(electronBin, [...(disableGpu ? ['--disable-gpu'] : []), electronEntry, ...argv], {
      cwd, env: { ...env, ORKAS_LOCAL_AGENT_RUNNER: runner, ORKAS_LOCAL_AGENT_USER_DATA_DIR: userData },
    }, runtime);
    if (result.signal) runtime.addFinding('error', 'electron-runner-signaled', 'launcher');
    const analysis = mergeModelEvalLogAnalyses([environmentAnalysis, runtime.finish()]);
    const reportsPassed = attachLocalAgentReports({ analysis, cwd, reportsDir, signal: result.signal });
    process.stdout.write(formatProcessLogSummary(analysis) + '\n');
    return analysis.passed && reportsPassed && !result.signal ? result.code : 1;
  } finally {
    if (!argv.includes('--keep')) fs.rmSync(container, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}
