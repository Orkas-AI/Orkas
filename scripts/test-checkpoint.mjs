/** Resumable Vitest batches. No application/test module state crosses batches. */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { createStderrReceipt } from './test-stderr-receipt.mjs';

const MAX_REPORT_BYTES = 16 * 1024 * 1024;
const MAX_AGE_MS = 12 * 60 * 60 * 1000;
const slash = value => value.replaceAll('\\', '/');

export function checkpointOptions(argv, lane = 'vitest') {
  const args = [];
  const options = { directory: '', resume: false, batches: 8 };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--resume') options.resume = true;
    else if (arg === '--checkpoint-dir' || arg.startsWith('--checkpoint-dir=')) {
      options.directory = arg === '--checkpoint-dir' ? argv[++i] : arg.slice('--checkpoint-dir='.length);
      if (!options.directory || options.directory.startsWith('--')) throw new Error('--checkpoint-dir needs a directory');
    } else if (arg === '--batch-count' || arg.startsWith('--batch-count=')) {
      options.batches = Number(arg === '--batch-count' ? argv[++i] : arg.slice('--batch-count='.length));
    } else args.push(arg);
  }
  if (!Number.isInteger(options.batches) || options.batches < 1 || options.batches > 32) throw new Error('--batch-count must be between 1 and 32');
  if (!options.directory && (options.resume || argv.some(arg => arg === '--batch-count' || arg.startsWith('--batch-count=')))) {
    throw new Error('Checkpoint options require --checkpoint-dir');
  }
  // Keep collection and execution equivalent. Watch, coverage, custom reporters,
  // alternate projects/configs and test-name filters need their own evidence.
  if (options.directory && lane === 'vitest' && args.some(arg => arg.startsWith('-') && !/^--maxWorkers=[1-9]\d*$/.test(arg))) {
    throw new Error('Checkpoint mode accepts file filters and --maxWorkers=N only; use the ordinary runner for other options');
  }
  return { args, ...options };
}

function readJson(file) {
  try {
    if (fs.statSync(file).size > MAX_REPORT_BYTES) return null;
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch { return null; }
}

function writeJson(file, value) {
  const temporary = `${file}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, file);
}

async function hashFile(file) {
  const hash = createHash('sha256');
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

async function stderrMatches(file, expected) {
  if (!expected?.valid) return false;
  const receipt = createStderrReceipt();
  for await (const chunk of fs.createReadStream(file)) receipt.ingest(chunk);
  const actual = receipt.finish();
  return actual.valid && actual.bytes === expected.bytes && actual.lines === expected.lines && actual.digest === expected.digest;
}

// Metadata, not file bodies: tracked private configuration must never be read.
// ctime also invalidates restored timestamps. Scan once at each batch boundary,
// never per case; output directories are outside the source inventory.
export async function inputFingerprint(repoRoot, env, selection, inventory, executable, extraRoots = []) {
  const git = spawnSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard', '--deduplicate'], {
    cwd: repoRoot, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
  });
  if (git.status !== 0) throw new Error('Cannot establish the repository input inventory');
  const hash = createHash('sha256');
  const add = value => hash.update(JSON.stringify(value) + '\n');
  add({ schema: 1, host: os.hostname(), release: os.release(), platform: process.platform, arch: process.arch,
    versions: process.versions, executable, cwd: repoRoot, selection, inventory,
    env: Object.entries(env).sort(([a], [b]) => a.localeCompare(b)) });
  let entries = 0;
  // Bound both outstanding IO and retained results. Preserve sorted visitation
  // order so completion order cannot change the fingerprint. Settle the whole
  // window before reporting a failure or starting recursive directory work.
  const inspect = async (files, visit) => {
    for (let offset = 0; offset < files.length; offset += 32) {
      const window = files.slice(offset, offset + 32);
      const results = await Promise.allSettled(window.map(file => fs.promises.lstat(file, { bigint: true })));
      if (results.some(result => result.status === 'rejected' && result.reason.code !== 'ENOENT')) {
        throw new Error('Cannot inspect a required checkpoint input');
      }
      for (let i = 0; i < window.length; i++) {
        const result = results[i];
        await visit(window[i], result.status === 'fulfilled' ? result.value : null);
      }
    }
  };
  const record = async (file, stat) => {
    if (++entries > 500_000) throw new Error('Input inventory exceeds the checkpoint safety limit');
    try {
      if (!stat) { add([file, 'missing']); return; }
      add([file, stat.mode.toString(), stat.size.toString(), stat.mtimeNs.toString(), stat.ctimeNs.toString(), stat.ino.toString()]);
      if (stat.isSymbolicLink()) {
        const target = await fs.promises.realpath(file);
        const resolved = await fs.promises.stat(target, { bigint: true });
        add([target, resolved.size.toString(), resolved.mtimeNs.toString(), resolved.ctimeNs.toString()]);
      }
    } catch (error) {
      if (error.code !== 'ENOENT') throw new Error('Cannot inspect a required checkpoint input');
      add([file, 'missing']);
    }
  };
  await inspect(git.stdout.split('\0').filter(Boolean).sort().map(file => path.join(repoRoot, file)), record);
  const visited = new Set();
  const walk = async (file, stat) => {
    if (!stat) { await record(file, stat); return; }
    if (stat.isSymbolicLink()) {
      await record(file, stat);
      // Follow dependency links as well as recording the link itself.
      let target;
      try { target = await fs.promises.realpath(file); }
      catch (error) {
        if (error.code === 'ENOENT') return;
        throw new Error('Cannot inspect a required checkpoint input');
      }
      await inspect([target], walk);
      return;
    }
    if (!stat.isDirectory()) { await record(file, stat); return; }
    if (visited.has(file)) return;
    visited.add(file);
    let children;
    try { children = await fs.promises.readdir(file); }
    catch { throw new Error('Cannot inspect a required checkpoint input'); }
    await inspect(children.sort().filter(entry => {
      // Vitest writes these caches while collecting/executing unchanged inputs.
      return !(path.basename(file) === 'node_modules' && ['.vite', '.vite-temp', '.cache'].includes(entry));
    }).map(entry => path.join(file, entry)), walk);
  };
  for (const root of ['node_modules', 'src/core-agent/node_modules', 'venv',
    'resources/runtime', 'resources/embedding-model', 'resources/officecli', 'src/main/native/build', 'out', ...extraRoots]) {
    await inspect([path.resolve(repoRoot, root)], walk);
  }
  await inspect([process.execPath, executable,
    ...(env.ORKAS_TEST_PYTHON && path.isAbsolute(env.ORKAS_TEST_PYTHON) ? [env.ORKAS_TEST_PYTHON] : [])], record);
  return hash.digest('hex');
}

function validReport(report) {
  return report?.schema === 1 && report.reason === 'passed' && report.unhandledErrors === 0
    && report.stderr?.valid === true
    && Array.isArray(report.inventory) && Array.isArray(report.files)
    && new Set(report.inventory).size === report.inventory.length
    && JSON.stringify([...report.inventory].sort()) === JSON.stringify(report.files.map(file => file.file).sort())
    && report.files.every(file => ['passed', 'skipped'].includes(file.state) && file.failed === 0
      && [file.passed, file.failed, file.skipped].every(count => Number.isInteger(count) && count >= 0))
    && report.logs?.cases === report.files.reduce((count, file) => count + file.passed + file.failed, 0)
    && report.logs?.files === report.files.filter(file => file.passed + file.failed > 0).length
    && ['PASS', 'WARN'].includes(report.logs?.status) && report.logs.unexpected === 0
    && report.logs.unmetExpectations === 0 && report.logs.coverageGaps?.length === 0;
}

export async function runCheckpoint({ directory, resume, batches, args, executable, vitestBin, env, onChild, cancelled = () => null, adapter }) {
  const started = performance.now();
  let inputScanMs = 0;
  const pcRoot = adapter?.cwd || path.resolve(path.dirname(vitestBin), '../..');
  const git = spawnSync('git', ['rev-parse', '--show-toplevel'], { cwd: pcRoot, encoding: 'utf8' });
  if (git.status !== 0) throw new Error('Checkpoint mode requires a Git checkout');
  const repoRoot = git.stdout.trim();
  directory = path.resolve(directory);
  const relative = path.relative(repoRoot, directory);
  if (!relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)) {
    const ignored = spawnSync('git', ['check-ignore', '-q', path.join(directory, 'checkpoint.json')], { cwd: repoRoot });
    if (ignored.status !== 0) throw new Error('Checkpoint directory must be Git-ignored or outside the checkout');
  }
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const lock = path.join(directory, 'run.lock');
  let lockFd;
  try { lockFd = fs.openSync(lock, 'wx', 0o600); }
  catch { throw new Error('Checkpoint is locked; stop the other run before removing a stale run.lock'); }
  fs.writeSync(lockFd, String(process.pid));
  const session = randomUUID();
  const sessionDir = path.join(directory, session);
  fs.mkdirSync(sessionDir, { mode: 0o700 });
  const run = async (label, commandArgs, report) => {
    const started = performance.now();
    const stdout = path.join(session, `${label}.stdout.log`);
    const stderr = path.join(session, `${label}.stderr.log`);
    const out = fs.openSync(path.join(directory, stdout), 'wx', 0o600);
    const err = fs.openSync(path.join(directory, stderr), 'wx', 0o600);
    let result;
    try {
      result = await new Promise((resolve, reject) => {
        const child = spawn(executable, [...(adapter?.prefix || [vitestBin]), ...commandArgs], {
          cwd: pcRoot, env: { ...env, ORKAS_TEST_BATCH_REPORT: report || '' }, stdio: ['inherit', out, err],
        });
        onChild?.(child);
        child.once('error', () => reject(new Error('Cannot start the checkpoint test runtime')));
        child.once('close', (exitCode, signal) => resolve({ exitCode, signal }));
      });
    } finally { fs.closeSync(out); fs.closeSync(err); }
    const attempt = { ...result, durationMs: Math.round(performance.now() - started), stdout, stderr,
      stdoutHash: await hashFile(path.join(directory, stdout)), stderrHash: await hashFile(path.join(directory, stderr)) };
    writeJson(path.join(sessionDir, `${label}.attempt.json`), attempt);
    if (result.signal) throw Object.assign(new Error('Checkpoint run interrupted'), { signal: result.signal });
    return attempt;
  };
  try {
    const discoveryPath = path.join(sessionDir, 'inventory.json');
    const discovery = await run('discovery', adapter
      ? adapter.discoveryArgs(args, discoveryPath)
      : ['list', '--filesOnly', `--json=${discoveryPath}`, ...args], adapter ? discoveryPath : undefined);
    if (adapter) await adapter.finish(discoveryPath, discovery, directory, true);
    const discoveryReport = readJson(discoveryPath);
    const discovered = adapter ? adapter.inventory(discoveryReport) : discoveryReport;
    if (discovery.exitCode !== 0 || (adapter ? !discoveryReport?.discoveryPassed : fs.statSync(path.join(directory, discovery.stderr)).size !== 0)
      || !Array.isArray(discovered) || !discovered.length
      || discovered.some(item => typeof item.file !== 'string' || item.projectName)) {
      throw new Error('Test discovery failed or returned an unsupported inventory; inspect discovery logs');
    }
    if (adapter) console.log(`[test-checkpoint] discovery log analysis ${discoveryReport.logs.status}`);
    const inventory = discovered.map(item => adapter ? item.file : slash(path.relative(pcRoot, item.file))).sort();
    if (new Set(inventory).size !== inventory.length) throw new Error('Duplicate test discovery entries');
    batches = Math.min(batches, adapter ? discoveryReport.batchUnits : inventory.length);
    if (!Number.isInteger(batches) || batches < 1) throw new Error('Invalid checkpoint batch inventory');
    const fingerprint = async () => {
      const scanStarted = performance.now();
      const result = await inputFingerprint(repoRoot, env, { args, batches, ...(adapter ? { lane: adapter.lane } : {}) }, inventory, executable, adapter?.extraRoots);
      inputScanMs += performance.now() - scanStarted;
      return result;
    };
    const initial = await fingerprint();
    const statePath = path.join(directory, 'checkpoint.json');
    const previous = resume ? readJson(statePath) : null;
    const reusable = previous?.schema === 1 && previous.fingerprint === initial
      && Date.now() - previous.createdAt < MAX_AGE_MS && Date.now() >= previous.createdAt;
    const state = reusable ? previous : { schema: 1, fingerprint: initial, createdAt: Date.now(), inventory, completed: {} };
    writeJson(statePath, state);
    console.log(`[test-checkpoint] discovered=${inventory.length} batches=${batches}; ${reusable ? 'checking saved evidence' : 'fresh execution'}`);
    const results = [];
    let changed = false;
    for (let batch = 1; batch <= batches; batch++) {
      if (cancelled()) throw Object.assign(new Error('Checkpoint run interrupted'), { signal: cancelled() });
      let entry = state.completed[batch];
      let report;
      if (entry) {
        try {
          const safe = file => typeof file === 'string' && !path.isAbsolute(file) && !file.split(/[\\/]/).includes('..');
          if (![entry.report, entry.stdout, entry.stderr].every(safe)) throw new Error('Invalid artifact location');
          report = readJson(path.join(directory, entry.report));
          if (entry.certified !== true || entry.stderrGap || !validReport(report) || await hashFile(path.join(directory, entry.report)) !== entry.reportHash
            || await hashFile(path.join(directory, entry.stdout)) !== entry.stdoutHash
            || await hashFile(path.join(directory, entry.stderr)) !== entry.stderrHash) entry = null;
          if (entry && adapter) {
            if (!Array.isArray(report.artifacts)) entry = null;
            else for (const artifact of report.artifacts) {
              if (!safe(artifact.file) || await hashFile(path.join(directory, artifact.file)) !== artifact.hash) entry = null;
            }
          }
        } catch { entry = null; }
      }
      if (entry) {
        results.push({ batch, reused: true, ...entry, files: report.files, logs: report.logs });
        console.log(`[test-checkpoint] batch ${batch}/${batches} reused; log analysis ${report.logs.status}`);
        continue;
      }
      delete state.completed[batch];
      writeJson(statePath, state);
      console.log(`[test-checkpoint] batch ${batch}/${batches} starting`);
      const reportFile = path.join(session, `batch-${batch}.json`);
      // The worker tap still analyzes every case log and surfaces warnings in
      // the report. Suppress only the duplicate successful-case console replay
      // so any remaining process stderr has no ambiguous attribution.
      const attempt = await run(`batch-${batch}`, adapter
        ? adapter.batchArgs(batch, batches, args, path.join(directory, reportFile))
        : ['run', '--silent=passed-only', `--shard=${batch}/${batches}`, ...args], path.join(directory, reportFile));
      if (adapter) await adapter.finish(path.join(directory, reportFile), attempt, directory, false);
      report = readJson(path.join(directory, reportFile));
      const stderrGap = attempt.exitCode === 0 && !await stderrMatches(path.join(directory, attempt.stderr), report?.stderr);
      const certified = attempt.exitCode === 0 && validReport(report) && !stderrGap;
      if (await fingerprint() !== initial) changed = true;
      entry = { ...attempt, report: reportFile, reportHash: report ? await hashFile(path.join(directory, reportFile)) : '', certified, stderrGap };
      if (certified && !changed) state.completed[batch] = entry;
      if (changed) state.completed = {};
      writeJson(statePath, state);
      results.push({ batch, reused: false, ...entry, files: report?.files || [], logs: report?.logs });
      console.log(`[test-checkpoint] batch ${batch}/${batches} ${certified ? 'completed' : 'FAILED'} ${attempt.durationMs}ms; log analysis ${report?.logs?.status || 'MISSING'}`);
      if (stderrGap) console.log('[test-checkpoint] unclassified stderr: inspect this batch stderr artifact before rerunning');
    }
    // A cached or newly executed shard may never hide an omitted/new file.
    const executed = results.flatMap(result => result.files.map(file => file.file)).sort();
    const complete = JSON.stringify(executed) === JSON.stringify(inventory);
    changed ||= await fingerprint() !== initial;
    const exitCode = !complete || changed || results.some(result => !result.certified) ? 1 : 0;
    // Missing evidence for one batch must not discard independently certified
    // siblings. A fully certified but inconsistent union invalidates all shards.
    if (changed || (!complete && results.every(result => result.certified))) {
      state.completed = {}; writeJson(statePath, state);
    }
    const summary = { schema: 1, inventory, complete, inputsChanged: changed, exitCode,
      wallDurationMs: Math.round(performance.now() - started), inputScanMs: Math.round(inputScanMs),
      reused: results.filter(result => result.reused).length,
      savedDurationMs: results.filter(result => result.reused).reduce((sum, result) => sum + result.durationMs, 0), results };
    writeJson(path.join(sessionDir, 'summary.json'), summary);
    console.log(`[test-checkpoint] executed=${batches - summary.reused} reused=${summary.reused} saved=${summary.savedDurationMs}ms inventory=${complete ? 'complete' : 'INCOMPLETE'} inputs=${changed ? 'CHANGED' : 'stable'}`);
    console.log(`[test-checkpoint] reports: ${path.join(sessionDir, 'summary.json')}`);
    return exitCode;
  } finally {
    fs.closeSync(lockFd);
    fs.unlinkSync(lock);
  }
}
