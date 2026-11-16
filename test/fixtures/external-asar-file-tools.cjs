// Run in a fresh Electron Node process so archive caches cannot hide a leak.
const assert = require('node:assert/strict');
const fs = require('original-fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const [pcRoot, root, sourceArchive, largeArchive, applicationArchive] = process.argv.slice(2);
require(path.join(pcRoot, 'node_modules/tsx/dist/cjs/index.cjs'));
const indexer = require(path.join(pcRoot, 'src/main/features/file_indexer.ts'));
const { createFileTools, createProgramSourceLoader } = require(path.join(pcRoot, 'src/main/model/core-agent/file-tools.ts'));
const { activateUser } = require(path.join(pcRoot, 'src/main/features/users.ts'));
const { setWorkspacePath } = require(path.join(pcRoot, 'src/main/features/user_workspace.ts'));
const { isPathAllowed } = require(path.join(pcRoot, 'src/main/util/path-sandbox.ts'));
const { setLocalExecMode } = require(path.join(pcRoot, 'src/main/features/permissions.ts'));
const uid = 'asar-fixture-user';
activateUser(uid);
assert.equal(setWorkspacePath(uid, root).ok, true);
setLocalExecMode('workspace_approval');
const tools = createFileTools({ userId: uid });
const context = { workingDir: root, state: { readFileState: new Map() } };
const call = (name, input, signal) => tools.find(tool => tool.name === name).execute(input, { ...context, signal });
const checks = [];
const packedFs = require(path.join(applicationArchive, 'user-file-fs.cjs'));
const ownEntry = path.join(applicationArchive, 'entry.txt');
const originalNoAsar = process.noAsar;

function openHandles(file) {
  if (process.platform === 'darwin') {
    const result = spawnSync('/usr/sbin/lsof', ['-p', String(process.pid), '-Fn'], { encoding: 'utf8', timeout: 5000 });
    assert.equal(result.status, 0, 'handle inventory must be available');
    return result.stdout.split('\n').filter(line => line === 'n' + file).length;
  }
  if (process.platform === 'linux') {
    return fs.readdirSync('/proc/self/fd').filter(fd => {
      try { return fs.readlinkSync('/proc/self/fd/' + fd) === file; } catch { return false; }
    }).length;
  }
  return null; // Native Windows replacement below is the platform oracle.
}

async function check(name, work, archive = sourceArchive) {
  const file = path.join(root, name + '.asar');
  fs.copyFileSync(archive, file);
  const originalBytes = fs.readFileSync(file);
  const before = openHandles(file);
  let outcome = true;
  try {
    await Promise.all([work(file), (async () => {
      for (let index = 0; index < 4; index++) {
        assert.equal(packedFs.fileSystemForPath(ownEntry).readFileSync(ownEntry, 'utf8'), 'application resource');
        await new Promise(resolve => setImmediate(resolve));
      }
    })()]);
    assert.equal(process.noAsar, originalNoAsar);
  } catch { outcome = false; }
  const handles = openHandles(file);
  let replaceable = true;
  try {
    assert.deepEqual(fs.readFileSync(file), originalBytes);
    fs.renameSync(file, file + '.old');
    fs.copyFileSync(archive, file);
    fs.unlinkSync(file + '.old');
  } catch { replaceable = false; }
  checks.push({ name, outcome, before, handles, replaceable });
}

(async () => {
  await check('indexer', async file => {
    const meta = await indexer.statFile(uid, file);
    assert.equal(meta.bytes, fs.statSync(file).size);
  });
  await check('read', async file => {
    const result = await call('read_files', { paths: [{ path: file }] });
    assert.ok(!result.isError);
    assert.ok(context.state.readFileState.has(file));
  });
  await check('metadata', async file => {
    const result = await call('read_files', { paths: [{ path: file }], metadata_only: true });
    assert.ok(!result.isError);
    assert.ok(result.content.includes('bytes="' + fs.statSync(file).size + '"'));
  });
  await check('search-metadata', async file => {
    const result = await call('search_files', { root, query: path.basename(file) });
    assert.ok(!result.isError);
    const body = JSON.parse(result.content.slice(result.content.indexOf('{')));
    assert.equal(body.files.length, 1);
    assert.equal(body.files[0].size, fs.statSync(file).size);
  });
  await check('directory-refusal', async file => {
    for (const name of ['list_files', 'search_files']) {
      const result = await call(name, name === 'list_files' ? { path: file } : { root: file });
      assert.equal(result.isError, true);
    }
  });
  await check('implicit-entry-refusal', async file => {
    const result = await call('read_files', { paths: [{ path: path.join(file, 'entry.txt') }] });
    assert.equal(result.isError, true);
    const grep = await call('grep_files', { root: path.join(file, 'entry.txt'), pattern: 'packed sentinel' });
    assert.equal(grep.isError, true);
  });
  await check('raw-encoding-refusal', async file => {
    const result = await call('read_files', { paths: [{ path: file }], raw_text: true });
    assert.equal(result.isError, true); // Binary package is not valid UTF-8.
    assert.ok(!context.state.readFileState.has(file));
  });
  await check('program-source-refusal', async file => {
    const result = await createProgramSourceLoader({ userId: uid })(file, context, 10000);
    assert.equal(result.code, 'E_PROGRAM_SOURCE_ENCODING');
  });
  await check('cancelled-search', async file => {
    const controller = new AbortController(); controller.abort();
    const result = await call('grep_files', { root: file, pattern: 'sentinel' }, controller.signal);
    assert.ok(result.content.includes('complete=false'));
  });
  await check('scope-denial', async file => {
    assert.equal(isPathAllowed(file, [path.join(root, 'narrow-scope')]), false);
    const outsideDir = path.join(path.dirname(root), 'outside'); fs.mkdirSync(outsideDir);
    const outside = path.join(outsideDir, 'outside.asar');
    fs.copyFileSync(sourceArchive, outside);
    const link = path.join(root, 'outside-alias');
    fs.symlinkSync(outsideDir, link, process.platform === 'win32' ? 'junction' : 'dir');
    const target = path.join(link, 'outside.asar');
    assert.equal(isPathAllowed(target, [root]), false);
    const result = await call('read_files', { paths: [{ path: target }] });
    assert.equal(result.isError, true);
    assert.ok(result.content.includes('E_PATH_OUT_OF_SCOPE'));
    assert.equal(openHandles(outside), process.platform === 'win32' ? null : 0);
  });
  await check('alias-read', async file => {
    const alias = path.join(root, 'archive-alias.txt');
    if (process.platform === 'win32') fs.linkSync(file, alias);
    else fs.symlinkSync(file, alias);
    const result = await call('read_files', { paths: [{ path: alias }] });
    assert.ok(!result.isError);
    assert.equal(context.state.readFileState.get(alias).size, fs.statSync(file).size);
    fs.unlinkSync(alias);
  });
  await check('cache-prune', async file => {
    await indexer.statFile(uid, file);
    await indexer.pruneOrphans(uid);
  });
  await check('raw-byte-limit', async file => {
    const limited = createFileTools({ userId: uid, rawTextMaxBytes: 1000 }).find(tool => tool.name === 'read_files');
    const result = await limited.execute({ paths: [{ path: file }], raw_text: true }, context);
    assert.equal(result.isError, true);
  }, largeArchive);
  await check('large-stream', async file => {
    const result = await call('read_files', { paths: [{ path: file, range: { unit: 'char', start: 0, end: 20 } }] });
    assert.ok(!result.isError);
    assert.equal(context.state.readFileState.get(file).size, fs.statSync(file).size);
  }, largeArchive);
  fs.mkdirSync(path.join(root, 'real-directory.asar'));
  fs.writeFileSync(path.join(root, 'real-directory.asar/plain.txt'), 'ordinary directory');
  assert.equal((await call('read_files', { paths: [{ path: 'real-directory.asar/plain.txt' }] })).isError, undefined);
  fs.writeFileSync(path.join(root, 'ordinary.txt'), 'ordinary sentinel');
  const ordinary = await call('read_files', { paths: [{ path: 'ordinary.txt' }], raw_text: true });
  assert.equal(JSON.parse(ordinary.content).files[0].content, 'ordinary sentinel');
  assert.equal(packedFs.fileSystemForPath(ownEntry).readFileSync(ownEntry, 'utf8'), 'application resource');
  assert.equal(packedFs.fileSystemForPath(path.join(root, 'read.asar')).statSync(path.join(root, 'read.asar')).isFile(), true);
  assert.equal(require('node:fs').readFileSync(ownEntry, 'utf8'), 'application resource');
  process.stdout.write('\nASAR_FILE_RESULT=' + JSON.stringify({ platform: process.platform, electron: process.versions.electron, checks }) + '\n');
})().catch(() => { process.stdout.write('\nASAR_FILE_FATAL\n'); process.exitCode = 1; });
