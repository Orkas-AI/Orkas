/** pytest and Playwright adapters for the shared checkpoint lifecycle. */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import { checkpointOptions, runCheckpoint } from './test-checkpoint.mjs';
import { createStderrReceipt } from './test-stderr-receipt.mjs';
import { createModelEvalLogCollector, mergeModelEvalLogAnalyses } from './model-eval-log-policy.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const maxBytes = 16 * 1024 * 1024;
const readJson = file => {
  if (fs.statSync(file).size > maxBytes) throw new Error('Checkpoint report exceeds its size limit');
  return JSON.parse(fs.readFileSync(file, 'utf8'));
};
const digest = async file => {
  const hash = createHash('sha256');
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
};

async function finish(reportPath, attempt, directory, discovery) {
  if (!fs.existsSync(reportPath)) return;
  const report = readJson(reportPath);
  const analyses = [];
  const receipt = createStderrReceipt();
  for (const stream of ['stdout', 'stderr']) {
    const collector = createModelEvalLogCollector(`process-${stream}`);
    for await (const chunk of fs.createReadStream(path.join(directory, attempt[stream]), { encoding: 'utf8' })) {
      collector.ingest(stream, chunk);
      if (stream === 'stderr') receipt.ingest(chunk);
    }
    analyses.push(collector.finish());
  }
  const eventsPath = reportPath.replace(/\.json$/, '.events.jsonl');
  const scopes = new Map();
  const input = fs.createReadStream(eventsPath, { encoding: 'utf8' });
  try {
    for await (const line of createInterface({ input, crlfDelay: Infinity })) {
      if (line.length > maxBytes) throw new Error('Checkpoint event exceeds its size limit');
      const event = JSON.parse(line);
      if (!['stdout', 'stderr'].includes(event.stream) || typeof event.text !== 'string') throw new Error('Invalid checkpoint event');
      const key = JSON.stringify([event.case, event.phase]);
      if (!scopes.has(key)) {
        if (scopes.size >= 100_000) throw new Error('Checkpoint event inventory exceeds its size limit');
        scopes.set(key, createModelEvalLogCollector(key));
      }
      scopes.get(key).ingest(event.stream, event.text);
    }
  } finally { input.destroy(); }
  analyses.push(...[...scopes.values()].map(scope => scope.finish()), ...(report.appAnalyses || []));
  const analysis = mergeModelEvalLogAnalyses(analyses);
  report.logs = { status: !analysis.passed ? 'FAIL' : analysis.requiresReview ? 'WARN' : 'PASS',
    cases: report.files.reduce((sum, file) => sum + file.passed + file.failed, 0),
    files: report.files.filter(file => file.passed + file.failed > 0).length,
    unexpected: analysis.findings.filter(item => item.severity === 'error').reduce((sum, item) => sum + item.count, 0),
    unmetExpectations: 0, coverageGaps: analysis.coveragePassed ? [] : ['capture'], analysis };
  report.stderr = receipt.finish();
  report.discoveryPassed = discovery && report.reason === 'passed' && report.unhandledErrors === 0 && analysis.passed;
  const artifactPaths = [eventsPath, ...(report.artifactPaths || [])];
  // Playwright owns attachments, traces and its last-run metadata. Each batch
  // has a unique output directory so a later batch cannot erase failed evidence.
  if (!discovery && report.outputDir && fs.existsSync(report.outputDir)) {
    for (const file of fs.readdirSync(report.outputDir, { recursive: true, withFileTypes: true })) {
      if (file.isFile()) artifactPaths.push(path.join(file.parentPath || file.path, file.name));
    }
  }
  report.artifacts = [];
  for (const file of new Set(artifactPaths)) {
    const relative = path.relative(directory, file);
    if (path.isAbsolute(relative) || relative.split(path.sep).includes('..')) throw new Error('Checkpoint artifact escaped its output directory');
    report.artifacts.push({ file: relative, hash: await digest(file) });
  }
  delete report.artifactPaths;
  delete report.outputDir;
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2), { mode: 0o600 });
}

export async function runRunnerCheckpoint(lane, argv, { cwd, env, python } = {}) {
  const options = checkpointOptions(argv, lane);
  let args = options.args;
  if (lane === 'python' && args.length === 0) args = ['resources/builtin'];
  env = { ...env };
  delete env.ORKAS_TEST_BATCH_REPORT;
  let executable = process.execPath;
  let prefix;
  let extraRoots = [];
  let discoveryArgs;
  let batchArgs;
  let testFiles;
  const inventory = report => { testFiles = report?.testFiles; return report?.inventory?.map(file => ({ file })); };
  if (lane === 'python') {
    if (args.some(arg => arg.startsWith('-') && !['-q', '-v'].includes(arg))) throw new Error('Python checkpoints accept paths and -q/-v only');
    env.PYTHONDONTWRITEBYTECODE = '1';
    env.PYTHONPATH = [here, env.PYTHONPATH].filter(Boolean).join(path.delimiter);
    const probe = spawnSync(python, ['-c', 'import sys, json, sysconfig, pytest; print(json.dumps({"executable":sys.executable,"prefix":sys.prefix,"stdlib":sysconfig.get_path("stdlib"),"version":sys.version,"pytest":pytest.__version__,"paths":sys.path}))'],
      { cwd, env, encoding: 'utf8', timeout: 15_000 });
    if (probe.status !== 0) throw new Error('Cannot verify the project Python interpreter and pytest');
    const runtime = JSON.parse(probe.stdout);
    executable = runtime.executable;
    const repository = path.resolve(here, '..');
    extraRoots = [...new Set([runtime.prefix, runtime.stdlib, ...runtime.paths.filter(Boolean)])]
      .filter(root => { const relative = path.relative(repository, path.resolve(root));
        return relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative); });
    env.ORKAS_CHECKPOINT_PYTHON_RUNTIME = JSON.stringify(runtime);
    prefix = ['-m', 'pytest', '-p', 'pytest_checkpoint'];
    discoveryArgs = selection => [...selection, '--collect-only'];
    batchArgs = (batch, batches, selection) => [...selection, `--orkas-checkpoint-shard=${batch}/${batches}`];
  } else {
    if (args[0] === 'test') args = args.slice(1);
    // Keep the normal product config, reporter and output ownership explicit.
    if (args[0] === '--config' && args[1] === 'playwright.config.ts') args = args.slice(2);
    if (args.some(arg => arg.startsWith('-'))) throw new Error('E2E checkpoints accept file filters only with the default config');
    env.ORKAS_E2E_KEEP_LOGS = '1';
    prefix = [path.join(path.dirname(require.resolve('playwright/package.json')), 'cli.js')];
    const reporter = path.join(here, 'checkpoint-reporter.ts');
    discoveryArgs = (selection, report) => ['test', '--config', 'playwright.config.ts', '--list', `--reporter=${reporter}`, ...selection];
    batchArgs = (batch, batches, selection, report) => ['test', '--config', 'playwright.config.ts',
      `--reporter=line,${reporter}`, `--output=${report}.artifacts`,
      ...testFiles.filter((_, index) => index % batches === batch - 1)
        .map(file => `^${file.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`)];
  }
  // A Python lane is keyed by cwd and selected suites, not by a caller label.
  // Thus root suites and builtin resources cannot overwrite each other's state.
  const key = createHash('sha256').update(JSON.stringify([lane, cwd, args])).digest('hex').slice(0, 16);
  const directory = path.join(path.resolve(options.directory), `${lane}-${key}`);
  let child;
  let signal;
  const handlers = new Map();
  for (const name of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGQUIT']) {
    const handler = () => { signal ||= name; if (child && !child.killed) child.kill(name); };
    handlers.set(name, handler); process.on(name, handler);
  }
  let code;
  try {
    code = await runCheckpoint({ ...options, args, directory, executable, env,
      onChild: value => { child = value; }, cancelled: () => signal,
      adapter: { lane, cwd, prefix, extraRoots, discoveryArgs, batchArgs, finish,
        inventory } });
  } catch (error) {
    if (error.signal) signal ||= error.signal;
    else throw error;
  } finally {
    for (const [name, handler] of handlers) process.off(name, handler);
  }
  if (signal) { process.kill(process.pid, signal); return 1; }
  return code;
}
