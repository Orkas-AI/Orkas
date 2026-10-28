import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { afterEach, expect, it, vi } from 'vitest';
import { createStderrReceipt, combineStderrReceipts } from '../../../scripts/test-stderr-receipt.mjs';
import { inputFingerprint } from '../../../scripts/test-checkpoint.mjs';

const pcRoot = path.resolve(__dirname, '../../..');
const node = process.env.ORKAS_TEST_NODE || process.execPath;
const roots: string[] = [];
afterEach(() => roots.splice(0).forEach(root => fs.rmSync(root, { recursive: true, force: true })));

it('checkpoint input scanning yields for cancellation and bounds concurrent metadata work', async () => {
  const f = fixture();
  for (let i = 0; i < 100; i++) f.write(`node_modules/fixture/${i}.js`, 'fixture');
  const original = fs.promises.lstat.bind(fs.promises);
  let active = 0;
  let peak = 0;
  let yielded = false;
  const pending = new Promise<void>(resolve => setImmediate(() => { yielded = true; resolve(); }));
  const spy = vi.spyOn(fs.promises, 'lstat').mockImplementation(async (...args) => {
    peak = Math.max(peak, ++active);
    try { return await original(...args); } finally { active--; }
  });
  try {
    const result = await inputFingerprint(f.root, {}, {}, [], node);
    expect(result).toMatch(/^[a-f0-9]{64}$/);
    expect(yielded).toBe(true);
    expect(peak).toBeGreaterThan(1);
    expect(peak).toBeLessThanOrEqual(32);
    expect(active).toBe(0);
  } finally { spy.mockRestore(); await pending; }
});

it('checkpoint input scanning detects linked dependency edits, additions and deletions without reading bodies', async () => {
  const f = fixture();
  const library = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-checkpoint-library-'));
  roots.push(library);
  const source = path.join(library, 'dependency.js');
  fs.writeFileSync(source, 'first');
  const link = path.join(f.root, 'node_modules/linked');
  fs.symlinkSync(library, link, process.platform === 'win32' ? 'junction' : 'dir');
  const scan = () => inputFingerprint(f.root, {}, {}, [], node, [library]);
  try {
    const first = await scan();
    expect(await scan()).toBe(first);
    const stat = fs.statSync(source);
    fs.writeFileSync(source, 'other');
    fs.utimesSync(source, stat.atime, stat.mtime);
    const edited = await scan();
    expect(edited).not.toBe(first);
    const added = path.join(library, 'new.js');
    fs.writeFileSync(added, 'new dependency');
    const expanded = await scan();
    expect(expanded).not.toBe(edited);
    fs.unlinkSync(added);
    const deleted = await scan();
    expect(deleted).not.toBe(expanded);
    const read = vi.spyOn(fs.promises, 'readFile').mockRejectedValue(new Error('File bodies are private'));
    const readSync = vi.spyOn(fs, 'readFileSync').mockImplementation(() => { throw new Error('File bodies are private'); });
    try { expect(await scan()).toBe(deleted); }
    finally { read.mockRestore(); readSync.mockRestore(); }
  } finally { fs.unlinkSync(link); }
});

it('checkpoint input scanning fails closed on inaccessible metadata and settles pending IO', async () => {
  const f = fixture();
  const denied = path.join(f.root, 'test/a.test.ts');
  const original = fs.promises.lstat.bind(fs.promises);
  let active = 0;
  const spy = vi.spyOn(fs.promises, 'lstat').mockImplementation(async (...args) => {
    active++;
    try {
      if (String(args[0]) === denied) throw Object.assign(new Error('denied'), { code: 'EACCES' });
      return await original(...args);
    } finally { active--; }
  });
  try {
    await expect(inputFingerprint(f.root, {}, {}, [], node)).rejects.toThrow('Cannot inspect a required checkpoint input');
    expect(active).toBe(0);
  } finally { spy.mockRestore(); }
});

it('attributes the exact stderr bytes across chunk boundaries and concurrent worker line ordering', () => {
  const first = createStderrReceipt();
  first.ingest('progress α\n');
  const second = createStderrReceipt();
  second.ingest('recoverable\n');
  const processOutput = createStderrReceipt();
  const bytes = Buffer.from('recoverable\nprogress α\n');
  for (const byte of bytes) processOutput.ingest(Buffer.from([byte]));
  const combined = combineStderrReceipts([first.finish(), second.finish()]);
  expect(combined).toEqual(processOutput.finish());
  expect(combined).toMatchObject({ valid: true, bytes: 24, lines: 2 });
});

it('rejects missing, duplicated, changed or oversized stderr evidence', () => {
  const expected = createStderrReceipt();
  expected.ingest('a\nb\n');
  const reference = expected.finish();
  for (const text of ['a\n', 'a\nb\nb\n', 'a\nc\n', 'a\nb']) {
    const changed = createStderrReceipt();
    changed.ingest(text);
    expect(changed.finish()).not.toEqual(reference);
  }
  const oversized = createStderrReceipt();
  oversized.ingest(Buffer.alloc(1024 * 1024 + 1));
  expect(oversized.finish().valid).toBe(false);
  expect(combineStderrReceipts([undefined]).valid).toBe(false);
});

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-checkpoint-'));
  roots.push(root);
  const write = (file: string, content: string) => {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), content);
  };
  write('.gitignore', 'node_modules/\ntest-results/\n');
  write('package.json', '{"type":"module"}');
  for (const script of ['run-tests.mjs', 'test-runtime-env.mjs', 'check-installed-dependencies.mjs', 'test-checkpoint.mjs', 'test-stderr-receipt.mjs']) {
    const source = path.join(pcRoot, 'scripts', script);
    if (fs.existsSync(source)) write(`scripts/${script}`, fs.readFileSync(source, 'utf8'));
  }
  write('node_modules/electron/index.js', `module.exports = ${JSON.stringify(node)};`);
  write('scripts/run-python-tests.mjs', "import fs from 'node:fs'; fs.writeFileSync('test-results/resources-ran', '1');");
  write('test/a.test.ts', 'a');
  write('test/data/b.test.ts', 'b');
  write('test/build/c.test.ts', 'c');
  // Only the test engine is a controlled dependency. Real launcher, discovery
  // subprocess, source snapshot, report validation and persisted recovery run.
  write('node_modules/vitest/vitest.mjs', `
    import fs from 'node:fs';
    import path from 'node:path';
    const args = process.argv.slice(2);
    const files = fs.readdirSync('test', { recursive: true }).filter(f => f.endsWith('.test.ts')).sort().map(f => 'test/' + f.replaceAll('\\\\', '/'));
    if (args[0] === 'list') {
      fs.writeFileSync(args.find(a => a.startsWith('--json=')).slice(7), JSON.stringify(files.map(f => ({file:path.resolve(f)}))));
    } else {
      const shard = args.find(a => a.startsWith('--shard='))?.slice(8).split('/').map(Number) || [1,1];
      const selected = files.filter((_, i) => i % shard[1] === shard[0] - 1);
      const report = process.env.ORKAS_TEST_BATCH_REPORT;
      const logFailure = process.env.FIXTURE_LOG_GAP === '1' && selected.includes('test/data/b.test.ts');
      const failure = (selected.includes('test/data/b.test.ts') && !fs.existsSync('test-results/failed-once')) || selected.some(file => fs.readFileSync(file, 'utf8') === 'FAIL');
      fs.mkdirSync('test-results', {recursive:true});
      if (failure) fs.writeFileSync('test-results/failed-once', '1');
      fs.appendFileSync('test-results/executed.jsonl', JSON.stringify(selected) + '\\n');
      if (report && !(process.env.FIXTURE_NO_REPORT === '1' && selected.includes('test/data/b.test.ts'))) fs.writeFileSync(report, JSON.stringify({schema:1, reason:failure?'failed':'passed', unhandledErrors:0,
        stderr:{valid:true,bytes:0,lines:0,digest:'0'.repeat(64)},
        inventory:selected, files:selected.map(file => ({file,state:failure?'failed':'passed',passed:failure?0:1,failed:failure?1:0,skipped:0,durationMs:20})),
        logs:{status:logFailure?'FAIL':'WARN',files:selected.length,cases:selected.length,lines:1,unexpected:0,unmetExpectations:0,coverageGaps:logFailure?['missing tap']:[],signatures:[]}
      }));
      console.log('engine stdout');
      if (failure || process.env.FIXTURE_STDERR === '1') console.error('engine stderr retained for inspection');
      if (process.env.FIXTURE_HOLD === '1' && selected.includes('test/data/b.test.ts') && !fs.existsSync('test-results/hold-ready')) {
        fs.writeFileSync('test-results/hold-ready', '1');
        setTimeout(() => {}, 30000);
      }
      process.exitCode = failure ? 1 : 0;
    }
  `);
  const git = spawnSync('git', ['init', '-q'], { cwd: root, encoding: 'utf8' });
  expect(git.status, git.stderr).toBe(0);
  const run = (resume = false, extraEnv: Record<string, string> = {}, suite = false) => spawnSync(node, [
    'scripts/run-tests.mjs', suite ? 'suite' : 'run', '--checkpoint-dir=test-results/checkpoint', '--batch-count=3', ...(resume ? ['--resume'] : []),
  ], { cwd: root, encoding: 'utf8', timeout: 30_000,
    env: { ...process.env, ...extraEnv, ORKAS_TEST_BATCH_REPORT: '' } });
  const executed = () => fs.readFileSync(path.join(root, 'test-results/executed.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
  return { root, write, run, executed };
}

it('resumes only completed, log-certified batches and keeps the original failure and both log streams', () => {
  const f = fixture();
  const first = f.run();
  expect(first.status, first.stderr).toBe(1);
  expect(f.executed()).toEqual([['test/a.test.ts'], ['test/data/b.test.ts'], ['test/build/c.test.ts']].sort((a,b) => a[0].localeCompare(b[0])));
  const second = f.run(true);
  expect(second.status, second.stderr).toBe(0);
  expect(f.executed()).toHaveLength(4);
  expect(f.executed().at(-1)).toEqual(['test/data/b.test.ts']);
  expect(second.stdout).toContain('reused=2');
  expect(second.stdout).toContain('WARN');
  const dir = path.join(f.root, 'test-results/checkpoint');
  const artifacts = fs.readdirSync(dir, { recursive: true }).map(String);
  const stderrLogs = artifacts.filter(file => file.endsWith('stderr.log'));
  expect(stderrLogs).toHaveLength(6); // Two discoveries and four batches.
  expect(stderrLogs.some(file => fs.readFileSync(path.join(dir,file), 'utf8').includes('engine stderr retained'))).toBe(true);
  const attempts = artifacts.filter(file => file.endsWith('attempt.json')).map(file => JSON.parse(fs.readFileSync(path.join(dir,file), 'utf8')));
  expect(attempts.some(item => item.exitCode === 1)).toBe(true);
});

it('retains the builtin Python suite after a successful checkpoint resume through npm test', () => {
  const f = fixture();
  const marker = path.join(f.root, 'test-results/resources-ran');
  expect(f.run(false, {}, true).status).toBe(1);
  expect(fs.existsSync(marker)).toBe(false);
  expect(f.run(true, {}, true).status).toBe(0);
  expect(fs.existsSync(marker)).toBe(true);
});

it.each(['--coverage', '--watch', '--reporter=json', '--shard=1/2', '--batch-count=0'])(
  'rejects unsupported checkpoint selection %s before dispatch', flag => {
    const f = fixture();
    const result = spawnSync(node, ['scripts/run-tests.mjs', 'run', '--checkpoint-dir=test-results/checkpoint', flag], {
      cwd: f.root, env: process.env, encoding: 'utf8', timeout: 10_000,
    });
    expect(result.status).toBe(2);
    expect(fs.existsSync(path.join(f.root, 'test-results/executed.jsonl'))).toBe(false);
  },
);

it.each(['--resume', '--batch-count=8'])('rejects %s without a checkpoint directory before dispatch', flag => {
  const f = fixture();
  const result = spawnSync(node, ['scripts/run-tests.mjs', 'run', flag], {
    cwd: f.root, env: process.env, encoding: 'utf8', timeout: 10_000,
  });
  expect(result.status).toBe(2);
  expect(fs.existsSync(path.join(f.root, 'test-results/executed.jsonl'))).toBe(false);
});

it('invalidates recovery for new generic directories, source, installed dependency and environment changes', () => {
  const f = fixture();
  f.run();
  expect(f.run(true).status).toBe(0);
  for (const [file, value] of [
    ['test/new/data/new.test.ts', 'new'],
    ['test/a.test.ts', 'changed'],
    ['node_modules/extra/index.js', 'changed dependency'],
  ]) {
    const before = f.executed().length;
    f.write(file, value);
    const result = f.run(true);
    expect(result.status, result.stderr).toBe(0);
    expect(f.executed().length - before).toBe(3);
  }
  const before = f.executed().length;
  expect(f.run(true, { FIXTURE_CHANGED_ENV: '1' }).status).toBe(0);
  expect(f.executed().length - before).toBe(3);
  expect(f.executed().flat()).toContain('test/new/data/new.test.ts');
});

it('reruns a batch whose log artifact was lost instead of inheriting its passing exit code', () => {
  const f = fixture();
  f.run();
  expect(f.run(true).status).toBe(0);
  const dir = path.join(f.root, 'test-results/checkpoint');
  const state = JSON.parse(fs.readFileSync(path.join(dir, 'checkpoint.json'), 'utf8'));
  fs.unlinkSync(path.join(dir, state.completed['1'].stdout));
  const before = f.executed().length;
  expect(f.run(true).status).toBe(0);
  expect(f.executed().length - before).toBe(1);
});

it.each(['FIXTURE_LOG_GAP', 'FIXTURE_NO_REPORT'])('never certifies missing log evidence (%s) even when the engine exits zero', key => {
  const f = fixture();
  const env = { [key]: '1' };
  f.run(false, env);
  const result = f.run(true, env);
  expect(result.status).toBe(1);
  expect(result.stdout).toContain('reused=2');
  expect(f.executed()).toHaveLength(4);
  expect(result.stdout).toContain('log analysis');
});

it('fails an otherwise green engine for unattributed process stderr', () => {
  const f = fixture();
  f.run(false, { FIXTURE_STDERR: '1' });
  const result = f.run(true, { FIXTURE_STDERR: '1' });
  expect(result.status).toBe(1);
  expect(result.stdout).toContain('reused=0');
  expect(result.stdout).toContain('unclassified stderr');
});

it('discovers a newly added failing file after a previously complete run', () => {
  const f = fixture();
  f.run();
  expect(f.run(true).status).toBe(0);
  f.write('test/new/data/new.test.ts', 'FAIL');
  expect(f.run(true).status).toBe(1);
  expect(f.executed().flat()).toContain('test/new/data/new.test.ts');
});

it.skipIf(process.platform === 'win32')('cancels the active batch, releases the lock and resumes only terminal evidence', async () => {
  const f = fixture();
  const child = spawn(node, ['scripts/run-tests.mjs', 'run', '--checkpoint-dir=test-results/checkpoint', '--batch-count=3'], {
    cwd: f.root, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, FIXTURE_HOLD: '1', ORKAS_TEST_BATCH_REPORT: '' },
  });
  let stderr = '';
  child.stdout.resume();
  child.stderr.on('data', data => { stderr += data.toString(); });
  const closed = new Promise(resolve => child.once('close', (code, signal) => resolve({ code, signal })));
  try {
    const ready = path.join(f.root, 'test-results/hold-ready');
    const deadline = Date.now() + 10_000;
    while (!fs.existsSync(ready) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
    expect(fs.existsSync(ready), stderr).toBe(true);
    const conflicting = f.run(true, { FIXTURE_HOLD: '1' });
    expect(conflicting.status).toBe(1);
    expect(conflicting.stderr).toContain('Checkpoint is locked');
    child.kill('SIGTERM');
    expect(await closed).toEqual({ code: null, signal: 'SIGTERM' });
    expect(stderr).toBe('');
    const resumed = f.run(true, { FIXTURE_HOLD: '1' });
    expect(resumed.status, resumed.stderr).toBe(0);
    expect(resumed.stdout).toContain('reused=2');
    expect(f.executed()).toHaveLength(4);
  } finally { if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM'); await closed; }
});
