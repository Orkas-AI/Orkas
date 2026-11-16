#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const AdmZip = require('adm-zip');
const contract = require('../vendor/libraw/0.22.3/contract.json');
const { WINDOWS_VC_RUNTIME_CONTRACT } = require('../bin/runtime-gate.cjs');
const { installWindowsVcRuntime } = require('./fetch-win-vc-runtime.cjs');
const { replaceDirectoryTransactional } = require('./fetch-whisper.cjs');
const pcRoot = path.resolve(__dirname, '..');
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const NOTICE = `Bundled LibRaw ${contract.version}\n\nOrkas invokes the unmodified dcraw_emu program as a separate process.\nSource: https://www.libraw.org/download\nCorresponding source is included in LibRaw-${contract.version}.tar.gz.\nLibRaw is available under LGPL 2.1 or CDDL 1.0; see both licenses and COPYRIGHT.\nWindows application-local Microsoft VC runtime files use the existing Orkas\nVC runtime distribution, https://visualstudio.microsoft.com/license-terms/.\n`;

function expectedFiles(target, spec = contract) {
  return { ...target.files, ...spec.licenses,
    [spec.source.name]: spec.source,
    ...Object.fromEntries((target.vcFiles || []).map(name => [`bin/${name}`, WINDOWS_VC_RUNTIME_CONTRACT.files[name]])) };
}
function matches(file, spec) {
  try { const bytes = fs.readFileSync(file); return bytes.length === spec.bytes && hash(bytes) === spec.sha256; }
  catch { return false; }
}
async function cachedDownload(spec, cacheDir) {
  const file = path.join(cacheDir, spec.name);
  if (matches(file, spec)) return file;
  fs.mkdirSync(cacheDir, { recursive: true });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 600_000);
  const chunks = []; let size = 0;
  try {
    const response = await fetch(spec.url, { signal: controller.signal });
    if (!response.ok) throw new Error(`LibRaw download failed: HTTP ${response.status}`);
    for await (const chunk of response.body) {
      size += chunk.length; if (size > spec.bytes) throw new Error('LibRaw download exceeds pinned size'); chunks.push(chunk);
    }
    const bytes = Buffer.concat(chunks);
    if (size !== spec.bytes || hash(bytes) !== spec.sha256) throw new Error('LibRaw archive integrity mismatch');
    const part = `${file}.${process.pid}.part`;
    try { fs.writeFileSync(part, bytes); fs.rmSync(file, { force: true }); fs.renameSync(part, file); }
    finally { fs.rmSync(part, { force: true }); }
    return file;
  } finally { clearTimeout(timer); }
}

async function installLibRaw(options = {}) {
  const platform = options.platform || process.platform, arch = options.arch || process.arch;
  const key = `${platform}-${arch}`, spec = options.contract || contract, target = spec.targets[key];
  if (!target) throw new Error(`LibRaw runtime is not configured for ${key}`);
  const root = options.root || path.join(pcRoot, 'resources/runtime');
  const dir = path.join(root, 'libraw', key), files = expectedFiles(target, spec);
  try {
    const marker = JSON.parse(fs.readFileSync(path.join(dir, '.orkas-libraw-ready.json')));
    if (!options.force && marker.schema === spec.schema && marker.platformKey === key && marker.version === spec.version
      && fs.readFileSync(path.join(dir, 'NOTICE.txt'), 'utf8') === NOTICE
      && Object.entries(files).every(([name, expected]) => matches(path.join(dir, name), expected)
        && marker.files?.[name]?.sha256 === expected.sha256 && marker.files?.[name]?.bytes === expected.bytes)) return dir;
  } catch { /* A missing or corrupt payload is rebuilt before use. */ }
  const cache = options.cacheDir || process.env.ORKAS_RUNTIME_CACHE_DIR || path.join(os.homedir(), '.cache/orkas-runtime/libraw');
  const download = options.download || (value => cachedDownload(value, cache));
  const zip = new AdmZip(await download(target.archive));
  const source = await download(spec.source);
  const vcDir = platform === 'win32' ? await installWindowsVcRuntime({ platform, arch }) : undefined;
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  const temporary = fs.mkdtempSync(path.join(path.dirname(dir), `.${key}-`));
  try {
    for (const [name, expected] of Object.entries(files)) {
      const bytes = expected.archivePath ? zip.getEntry(expected.archivePath)?.getData()
        : name === spec.source.name ? fs.readFileSync(source) : fs.readFileSync(path.join(vcDir, path.basename(name)));
      if (!bytes || bytes.length !== expected.bytes || hash(bytes) !== expected.sha256) throw new Error(`LibRaw file integrity mismatch: ${name}`);
      const output = path.join(temporary, name); fs.mkdirSync(path.dirname(output), { recursive: true }); fs.writeFileSync(output, bytes);
      if (expected.executable) fs.chmodSync(output, 0o755);
    }
    fs.writeFileSync(path.join(temporary, 'NOTICE.txt'), NOTICE);
    fs.writeFileSync(path.join(temporary, '.orkas-libraw-ready.json'), JSON.stringify({ schema: spec.schema, version: spec.version,
      platformKey: key, files: Object.fromEntries(Object.entries(files).map(([name, value]) => [name, { bytes: value.bytes, sha256: value.sha256 }])) }, null, 2));
    if (platform === process.platform && arch === process.arch) {
      const smoke = spawnSync(path.join(temporary, 'bin', platform === 'win32' ? 'dcraw_emu.exe' : 'dcraw_emu'), [], { encoding: 'utf8', timeout: 10_000, windowsHide: true });
      // LibRaw's usage request intentionally exits 1.
      if (smoke.error || smoke.status !== 1 || !`${smoke.stdout}${smoke.stderr}`.includes('-aexpo')) throw new Error('LibRaw CLI capability smoke failed');
    }
    replaceDirectoryTransactional(temporary, dir);
    console.log(`[fetch-libraw] ready ${spec.version} ${key}`);
    return dir;
  } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
}
if (require.main === module) {
  const value = flag => { const at = process.argv.indexOf(flag); return at < 0 ? undefined : process.argv[at + 1]; };
  installLibRaw({ platform: value('--platform'), arch: value('--arch'), force: process.argv.includes('--force') })
    .catch(error => { console.error(`[fetch-libraw] failed: ${error.message}`); process.exitCode = 1; });
}
module.exports = { installLibRaw, expectedFiles, matches, NOTICE, cachedDownload };
