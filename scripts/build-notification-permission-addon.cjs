#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const pcRoot = path.resolve(__dirname, '..');
const source = path.join(pcRoot, 'src', 'main', 'native', 'notification_permissions.mm');
const outputDir = path.join(pcRoot, 'src', 'main', 'native', 'build');

function readArg(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

function outputPath(arch) {
  return path.join(outputDir, `notification_permissions-darwin-${arch}.node`);
}

function removeDarwinOutputs(exceptArch = null) {
  if (!fs.existsSync(outputDir)) return;
  for (const entry of fs.readdirSync(outputDir)) {
    const match = /^notification_permissions-darwin-(.+)\.node$/.exec(entry);
    if (match && match[1] !== exceptArch) {
      fs.rmSync(path.join(outputDir, entry), { force: true });
    }
  }
}

function findNodeHeaders() {
  const candidates = [
    process.env.npm_config_nodedir && path.join(process.env.npm_config_nodedir, 'include', 'node'),
    path.resolve(path.dirname(process.execPath), '..', 'include', 'node'),
    '/opt/homebrew/include/node',
    '/usr/local/include/node',
    '/usr/include/node',
  ].filter(Boolean);
  const found = candidates.find((candidate) => fs.existsSync(path.join(candidate, 'node_api.h')));
  if (!found) {
    throw new Error(`node_api.h not found (checked: ${candidates.join(', ')})`);
  }
  return found;
}

function build({ platform, arch, force = false, keepOtherArches = false }) {
  if (platform !== 'darwin') {
    removeDarwinOutputs();
    console.log(`[notification-permission-addon] not required for ${platform}-${arch}`);
    return null;
  }
  if (!['arm64', 'x64'].includes(arch)) {
    throw new Error(`unsupported macOS architecture: ${arch}`);
  }
  if (!keepOtherArches) removeDarwinOutputs(arch);

  fs.mkdirSync(outputDir, { recursive: true });
  const output = outputPath(arch);
  const newestInput = Math.max(fs.statSync(source).mtimeMs, fs.statSync(__filename).mtimeMs);
  if (!force && fs.existsSync(output) && fs.statSync(output).mtimeMs >= newestInput) {
    console.log(`[notification-permission-addon] ready: ${path.relative(pcRoot, output)}`);
    return output;
  }

  const tempOutput = `${output}.${process.pid}.tmp`;
  const compilerArch = arch === 'x64' ? 'x86_64' : 'arm64';
  const result = spawnSync('xcrun', [
    'clang++',
    '-std=c++17',
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
    '-I', findNodeHeaders(),
    source,
    '-o', tempOutput,
  ], {
    cwd: pcRoot,
    encoding: 'utf8',
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    fs.rmSync(tempOutput, { force: true });
    throw new Error((result.stderr || result.stdout || `clang++ exited ${result.status}`).trim());
  }
  fs.renameSync(tempOutput, output);
  console.log(`[notification-permission-addon] built: ${path.relative(pcRoot, output)}`);
  return output;
}

module.exports = { build, findNodeHeaders, outputPath, removeDarwinOutputs };

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
