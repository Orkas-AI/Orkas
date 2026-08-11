#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { isMachArch } = require('./native-prepare-cache.cjs');

const pcRoot = path.resolve(__dirname, '..');
const source = path.join(pcRoot, 'src', 'main', 'native', 'notification_permissions.mm');
const outputDir = path.join(pcRoot, 'src', 'main', 'native', 'build');
const NOTIFICATION_ADDON_BUILD_TIMEOUT_MS = 2 * 60_000;

function readArg(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

function outputPath(arch, root = outputDir) {
  return path.join(root, `notification_permissions-darwin-${arch}.node`);
}

function removeDarwinOutputs(exceptArch = null, root = outputDir) {
  if (!fs.existsSync(root)) return;
  for (const entry of fs.readdirSync(root)) {
    const match = /^notification_permissions-darwin-(.+)\.node$/.exec(entry);
    if (match && match[1] !== exceptArch) {
      fs.rmSync(path.join(root, entry), { force: true });
    }
  }
}

/**
 * The addon is pure N-API (`-DNAPI_VERSION=8`), so any N-API headers build a
 * binary that loads in Electron. `process.execPath` is the only source that
 * fails under the mandated `npm test` runner: it points at the Electron
 * binary, whose dist ships no headers. `npm_node_execpath` is the Node that
 * launched the npm script, which is where a nvm/fnm install keeps its headers
 * — without it, a machine with no Homebrew or system Node cannot build at all.
 */
function findNodeHeaders({
  env = process.env,
  execPath = process.execPath,
  exists = fs.existsSync,
} = {}) {
  const includeDirOf = (binary) => path.resolve(path.dirname(binary), '..', 'include', 'node');
  const candidates = [
    env.npm_config_nodedir && path.resolve(env.npm_config_nodedir, 'include', 'node'),
    includeDirOf(execPath),
    env.npm_node_execpath && includeDirOf(env.npm_node_execpath),
    '/opt/homebrew/include/node',
    '/usr/local/include/node',
    '/usr/include/node',
  ].filter(Boolean);
  const found = candidates.find((candidate) => exists(path.join(candidate, 'node_api.h')));
  if (!found) {
    throw new Error(
      `node_api.h not found (checked: ${candidates.join(', ')}). `
      + 'Set npm_config_nodedir to a Node install that ships headers.',
    );
  }
  return found;
}

function build({
  platform,
  arch,
  force = false,
  keepOtherArches = false,
  buildScript = __filename,
  log = console.log,
  nodeHeaders = null,
  outputRoot = outputDir,
  root = pcRoot,
  sourceFile = source,
  spawn = spawnSync,
}) {
  if (platform !== 'darwin') {
    removeDarwinOutputs(null, outputRoot);
    log(`[notification-permission-addon] not required for ${platform}-${arch}`);
    return null;
  }
  if (!['arm64', 'x64'].includes(arch)) {
    throw new Error(`unsupported macOS architecture: ${arch}`);
  }
  if (!keepOtherArches) removeDarwinOutputs(arch, outputRoot);

  fs.mkdirSync(outputRoot, { recursive: true });
  const output = outputPath(arch, outputRoot);
  const newestInput = Math.max(fs.statSync(sourceFile).mtimeMs, fs.statSync(buildScript).mtimeMs);
  if (
    !force
    && fs.existsSync(output)
    && fs.statSync(output).mtimeMs >= newestInput
    && isMachArch(output, arch)
  ) {
    log(`[notification-permission-addon] ready: ${path.relative(root, output)}`);
    return output;
  }

  const tempOutput = `${output}.${process.pid}.tmp`;
  const compilerArch = arch === 'x64' ? 'x86_64' : 'arm64';
  let result;
  try {
    result = spawn('xcrun', [
      'clang++',
      '-std=c++20',
      '-bundle',
      '-undefined', 'dynamic_lookup',
      '-fblocks',
      '-fobjc-arc',
      '-fobjc-exceptions',
      '-mmacosx-version-min=13.0',
      '-DNAPI_VERSION=8',
      '-arch', compilerArch,
      '-framework', 'Foundation',
      '-framework', 'UserNotifications',
      '-I', nodeHeaders || findNodeHeaders(),
      sourceFile,
      '-o', tempOutput,
    ], {
      cwd: root,
      encoding: 'utf8',
      timeout: NOTIFICATION_ADDON_BUILD_TIMEOUT_MS,
    });
  } catch (err) {
    fs.rmSync(tempOutput, { force: true });
    throw err;
  }
  if (result.error) {
    fs.rmSync(tempOutput, { force: true });
    throw result.error;
  }
  if (result.status !== 0) {
    fs.rmSync(tempOutput, { force: true });
    throw new Error((result.stderr || result.stdout || `clang++ exited ${result.status}`).trim());
  }
  if (!isMachArch(tempOutput, arch)) {
    fs.rmSync(tempOutput, { force: true });
    throw new Error(`compiler produced an invalid ${arch} Mach-O addon`);
  }
  fs.renameSync(tempOutput, output);
  log(`[notification-permission-addon] built: ${path.relative(root, output)}`);
  return output;
}

module.exports = {
  NOTIFICATION_ADDON_BUILD_TIMEOUT_MS,
  build,
  findNodeHeaders,
  outputPath,
  removeDarwinOutputs,
};

if (require.main === module) {
  try {
    build({
      platform: readArg('--platform', process.platform),
      arch: readArg('--arch', process.arch),
      force: process.argv.includes('--force'),
      keepOtherArches: process.argv.includes('--keep-other-arches'),
    });
  } catch (err) {
    console.error(`[notification-permission-addon] failed: ${err.message}`);
    process.exit(1);
  }
}
