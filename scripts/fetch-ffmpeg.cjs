#!/usr/bin/env node
/**
 * Vendor ffmpeg + ffprobe into `PC/resources/runtime/ffmpeg/<platform>-<arch>/`.
 *
 * VideoStudio's native render path and deterministic media scripts require
 * ffmpeg + ffprobe. Rather than depend on whatever the user's machine happens
 * to have, we ship our own and point the app at them via util/bundled-runtime.ts
 * `bundledFfmpegPaths`. The `extraResources: resources/runtime` rule picks up
 * whatever lands here; binaries are gitignored like the other runtime payloads.
 *
 * Two modes, selected by whether the requested target equals the build host:
 *
 *   HOST target (default, or --platform/--arch == this machine): source the
 *   binaries from the `ffmpeg-static` and `@ffprobe-installer/ffprobe`
 *   devDependencies (their install scripts fetch the host-platform binary), copy
 *   them in, and capability-check by EXECUTING ffmpeg (verifies --enable-libass +
 *   the ass/subtitles filters burnsubs needs). NB: `ffprobe-static` is
 *   deliberately NOT used — its darwin/arm64 asset is mislabeled (x86_64), which
 *   fails "bad CPU type" on Apple Silicon.
 *
 *   CROSS target (e.g. a win32-x64 installer built + signed on macOS): npm will
 *   not install a foreign-platform package (EBADPLATFORM), so we download the
 *   SAME upstream build families used for the host, pinned by sha256:
 *     - ffmpeg  ← the `ffmpeg-static` GitHub release asset for the target
 *                 (`ffmpeg-<platform>-<arch>.gz`, gunzipped) — same BtbN GPL
 *                 build family as the host, so libass is present.
 *     - ffprobe ← the `@ffprobe-installer/<platform>-<arch>` npm tarball
 *                 (extracted via system `tar`), pinned to the version the
 *                 installed `@ffprobe-installer/ffprobe` declares.
 *   The vendored binary can't be executed on the build host, so sha256 pins
 *   (CROSS_PINS) ARE the integrity check; a version bump changes the hash and
 *   fails the build loudly, forcing a conscious re-pin. A real run-on-Windows
 *   smoke test still belongs in release QA.
 *
 * License: ffmpeg/ffprobe are invoked as a separate process (not linked). The
 * `ffmpeg-static` binaries are GPL builds — the in-repo NOTICE lists their
 * source. This is "mere aggregation" of a separate program, not a derivative
 * link, so it does not impose copyleft on Orkas itself.
 *
 * Idempotent: skips work when a ready copy already matches (source bytes for the
 * host path, the pinned sha256 for the cross path), unless `--force`.
 *
 * Flags:
 *   --platform <darwin|win32|linux>   target platform (default: this machine)
 *   --arch <x64|arm64|...>            target arch (default: this machine)
 *   --force                           re-vendor even if a ready copy exists
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { FFMPEG_CAPABILITIES } = require('../bin/runtime-gate.cjs');

const pcRoot = path.resolve(__dirname, '..');

function argValue(flag) {
  const i = process.argv.indexOf(flag);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : undefined;
}
const FORCE = process.argv.includes('--force');
const TARGET_PLATFORM = argValue('--platform') || process.platform;
const TARGET_ARCH = argValue('--arch') || process.arch;
const IS_HOST_TARGET = TARGET_PLATFORM === process.platform && TARGET_ARCH === process.arch;

const platformKey = `${TARGET_PLATFORM}-${TARGET_ARCH}`;
const destDir = path.join(pcRoot, 'resources', 'runtime', 'ffmpeg', platformKey);
const exe = TARGET_PLATFORM === 'win32' ? '.exe' : '';
const READY_FILE = path.join(destDir, '.orkas-ffmpeg-ready.json');
const DOWNLOAD_TIMEOUT_MS = 5 * 60 * 1000;
const REQUIRED_CAPABILITIES = FFMPEG_CAPABILITIES;

// sha256 of the cross-downloaded binaries per target. Update deliberately when
// bumping ffmpeg-static / @ffprobe-installer (a mismatch fails the build and
// prints the observed hash so the new value can be pasted in).
const CROSS_PINS = {
  // ffmpeg = ffmpeg-static release b6.1.1 asset; ffprobe = @ffprobe-installer
  // tarball binary at the version @ffprobe-installer/ffprobe pins for the target.
  'win32-x64': {
    ffmpeg: '04e1307997530f9cf2fe35cba2ca7e8875ca91da02f89d6c7243df819c94ad00',
    ffprobe: 'f28c4751e7367205267025aaf0fcfc921e34d9b7edaa46bd9c8abaf367fc9051',
  },
  // The mac build emits both arm64 and x64; on an arm64 host the x64 slice is a
  // cross target (and vice-versa), so both mac arches are pinned here too.
  'darwin-x64': {
    ffmpeg: 'ebdddc936f61e14049a2d4b549a412b8a40deeff6540e58a9f2a2da9e6b18894',
    ffprobe: '424ce5e9271085240e90bd27f9e3f0ce280d388ea4379a211f76b64fcc07ce33',
  },
  'darwin-arm64': {
    ffmpeg: 'a90e3db6a3fd35f6074b013f948b1aa45b31c6375489d39e572bea3f18336584',
    ffprobe: 'c846d5db9d3b5bc33f987725e21f3ea14953931221c191575918e907ad6c18ff',
  },
};

// ---------------------------------------------------------------------------
// Host-platform sources (unchanged behavior)
// ---------------------------------------------------------------------------
function resolveSources() {
  // ffmpeg-static default export = absolute path to the ffmpeg binary.
  // @ffprobe-installer/ffprobe `.path` = current platform/arch ffprobe.
  const ffmpegSrc = require('ffmpeg-static');
  const ffprobeSrc = require('@ffprobe-installer/ffprobe').path;
  if (!ffmpegSrc || !fs.existsSync(ffmpegSrc)) {
    throw new Error(`ffmpeg-static binary missing (${ffmpegSrc}); run npm install`);
  }
  if (!ffprobeSrc || !fs.existsSync(ffprobeSrc)) {
    throw new Error(`@ffprobe-installer/ffprobe binary missing (${ffprobeSrc}); run npm install`);
  }
  return { ffmpegSrc, ffprobeSrc };
}

function isCurrentBinary(src, dest) {
  try {
    const source = fs.statSync(src);
    const target = fs.statSync(dest);
    return target.isFile() && target.size === source.size && target.mtimeMs >= source.mtimeMs;
  } catch {
    return false;
  }
}

function copyBinary(src, destName, force) {
  const dest = path.join(destDir, destName);
  if (!force && isCurrentBinary(src, dest)) return false;
  fs.copyFileSync(src, dest);
  fs.chmodSync(dest, 0o755);
  const bytes = fs.statSync(dest).size;
  console.log(`[fetch-ffmpeg] ${destName} -> ${dest} (${(bytes / 1e6).toFixed(1)} MB)`);
  return true;
}

// Ships alongside the binaries (the dir is gitignored / build-produced, so the
// notice is emitted here rather than committed). Satisfies the "document the
// bundled ffmpeg source" compliance item. ffmpeg/ffprobe are invoked as a
// separate process, not linked, so this is mere aggregation of a separately
// licensed program.
const NOTICE = `Bundled FFmpeg binaries
=======================

This directory contains prebuilt ffmpeg and ffprobe binaries that Orkas invokes
as separate processes for local video rendering and deterministic media editing.
They are NOT linked into Orkas; Orkas merely aggregates and runs them.

ffmpeg
  Source binary: the npm package "ffmpeg-static"
    https://github.com/eugeneware/ffmpeg-static
  Upstream: FFmpeg — https://ffmpeg.org  (source: https://github.com/FFmpeg/FFmpeg)
  License: the bundled build is distributed under the GNU GPL. FFmpeg source is
  available from the FFmpeg project at the URL above.

ffprobe
  Source binary: the npm package "@ffprobe-installer/ffprobe"
    https://github.com/SavageCore/node-ffprobe-installer
  Upstream: FFmpeg — https://ffmpeg.org  (source: https://github.com/FFmpeg/FFmpeg)
  License: GNU GPL / LGPL per the FFmpeg build; source available from FFmpeg.

To obtain the corresponding source for these binaries, see the FFmpeg project
and the packaging repositories linked above.
`;

function writeNotice() {
  const dest = path.join(destDir, 'NOTICE.txt');
  try {
    if (fs.readFileSync(dest, 'utf8') === NOTICE) return false;
  } catch { /* write below */ }
  fs.writeFileSync(dest, NOTICE);
  console.log(`[fetch-ffmpeg] NOTICE.txt -> ${dest}`);
  return true;
}

function readyForSourcesHost({ ffmpegSrc, ffprobeSrc }) {
  try {
    const marker = JSON.parse(fs.readFileSync(READY_FILE, 'utf8'));
    return markerMatchesVendoredFiles(marker, 'executed-capabilities')
      && isCurrentBinary(ffmpegSrc, path.join(destDir, `ffmpeg${exe}`))
      && isCurrentBinary(ffprobeSrc, path.join(destDir, `ffprobe${exe}`));
  } catch {
    return false;
  }
}

function binaryRecord(file) {
  const bytes = fs.statSync(file).size;
  return { bytes, sha256: sha256(fs.readFileSync(file)) };
}

function markerMatchesVendoredFiles(marker, verification, expectedHashes = {}) {
  if (marker?.schema !== 1 || marker.platformKey !== platformKey || marker.verification !== verification) return false;
  const capabilities = new Set(Array.isArray(marker.capabilities) ? marker.capabilities : []);
  if (!REQUIRED_CAPABILITIES.every(capability => capabilities.has(capability))) return false;
  for (const name of ['ffmpeg', 'ffprobe']) {
    const file = path.join(destDir, `${name}${exe}`);
    const record = marker.binaries?.[name];
    if (!record || !fs.existsSync(file)) return false;
    const actual = binaryRecord(file);
    if (record.bytes !== actual.bytes || record.sha256 !== actual.sha256) return false;
    if (expectedHashes[name] && actual.sha256 !== expectedHashes[name]) return false;
  }
  return true;
}

function writeReadyMarker(verification) {
  const marker = {
    schema: 1,
    platformKey,
    verification,
    capabilities: REQUIRED_CAPABILITIES,
    binaries: {
      ffmpeg: binaryRecord(path.join(destDir, `ffmpeg${exe}`)),
      ffprobe: binaryRecord(path.join(destDir, `ffprobe${exe}`)),
    },
  };
  fs.writeFileSync(READY_FILE, `${JSON.stringify(marker, null, 2)}\n`);
}

function runBinary(bin, args) {
  const r = spawnSync(bin, args, {
    encoding: 'utf8',
    maxBuffer: 8 * 1024 * 1024,
    timeout: 20_000,
  });
  if (r.error) throw new Error(`${path.basename(bin)} ${args.join(' ')} failed: ${r.error.message}`);
  if (r.status !== 0) {
    const err = `${r.stderr || ''}${r.stdout || ''}`.trim().slice(-1000);
    throw new Error(`${path.basename(bin)} ${args.join(' ')} exited ${r.status}${err ? `: ${err}` : ''}`);
  }
  return `${r.stdout || ''}\n${r.stderr || ''}`;
}

function assertRequiredCapabilities() {
  const ffmpeg = path.join(destDir, `ffmpeg${exe}`);
  const ffprobe = path.join(destDir, `ffprobe${exe}`);
  const version = runBinary(ffmpeg, ['-hide_banner', '-version']);
  const filters = runBinary(ffmpeg, ['-hide_banner', '-filters']);
  runBinary(ffprobe, ['-hide_banner', '-version']);

  if (!version.includes('--enable-libass')) {
    throw new Error('vendored ffmpeg is missing --enable-libass; subtitle burn-in would fail');
  }
  for (const filter of ['ass', 'subtitles']) {
    const re = new RegExp(`\\b${filter}\\s+V->V\\b`);
    if (!re.test(filters)) {
      throw new Error(`vendored ffmpeg is missing the "${filter}" video filter; subtitle burn-in would fail`);
    }
  }
  console.log('[fetch-ffmpeg] verified ffmpeg libass subtitle filters');
}

// ---------------------------------------------------------------------------
// Cross-platform sources (build host != target): pinned download + sha256
// ---------------------------------------------------------------------------
const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

async function httpGetBuffer(url) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), DOWNLOAD_TIMEOUT_MS);
  try {
    const resp = await fetch(url, { redirect: 'follow', signal: ac.signal });
    if (!resp.ok) throw new Error(`download ${url} -> HTTP ${resp.status}`);
    return Buffer.from(await resp.arrayBuffer());
  } catch (err) {
    if (err && err.name === 'AbortError') throw new Error(`download timed out after ${DOWNLOAD_TIMEOUT_MS / 1000}s: ${url}`);
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

function verifySha(buf, expected, label) {
  const actual = sha256(buf);
  if (actual !== expected) {
    throw new Error(`${label} sha256 mismatch: expected ${expected}, got ${actual}. `
      + 'If the upstream version was bumped intentionally, update CROSS_PINS with the new hash.');
  }
}

async function downloadCrossFfmpeg(expectedSha) {
  const release = require('ffmpeg-static/package.json')['ffmpeg-static']['binary-release-tag'];
  const url = `https://github.com/eugeneware/ffmpeg-static/releases/download/${release}/ffmpeg-${platformKey}.gz`;
  const bin = zlib.gunzipSync(await httpGetBuffer(url));
  verifySha(bin, expectedSha, `ffmpeg ${platformKey} (${release})`);
  return bin;
}

async function downloadCrossFfprobe(expectedSha) {
  const optionalDeps = require('@ffprobe-installer/ffprobe/package.json').optionalDependencies || {};
  const version = optionalDeps[`@ffprobe-installer/${platformKey}`];
  if (!version) throw new Error(`@ffprobe-installer has no pinned version for ${platformKey}`);
  const url = `https://registry.npmjs.org/@ffprobe-installer/${platformKey}/-/${platformKey}-${version}.tgz`;
  const tgz = await httpGetBuffer(url);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-ffprobe-'));
  try {
    const tgzPath = path.join(tmp, 'pkg.tgz');
    fs.writeFileSync(tgzPath, tgz);
    const r = spawnSync('tar', ['-xzf', tgzPath, '-C', tmp], { encoding: 'utf8', timeout: 60_000 });
    if (r.error) throw new Error(`tar extract failed: ${r.error.message}`);
    if (r.status !== 0) throw new Error(`tar extract exited ${r.status}: ${(r.stderr || '').slice(-500)}`);
    const bin = fs.readFileSync(path.join(tmp, 'package', `ffprobe${exe}`));
    verifySha(bin, expectedSha, `ffprobe ${platformKey} (${version})`);
    return bin;
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

function writeBinaryBuffer(destName, buf) {
  const dest = path.join(destDir, destName);
  fs.writeFileSync(dest, buf);
  fs.chmodSync(dest, 0o755);
  console.log(`[fetch-ffmpeg] ${destName} -> ${dest} (${(buf.length / 1e6).toFixed(1)} MB)`);
}

function readyCross(pin) {
  try {
    const marker = JSON.parse(fs.readFileSync(READY_FILE, 'utf8'));
    return markerMatchesVendoredFiles(marker, 'pinned-sha256', pin);
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
async function mainHost() {
  const { ffmpegSrc, ffprobeSrc } = resolveSources();
  fs.mkdirSync(destDir, { recursive: true });
  const ffmpegChanged = copyBinary(ffmpegSrc, `ffmpeg${exe}`, FORCE);
  const ffprobeChanged = copyBinary(ffprobeSrc, `ffprobe${exe}`, FORCE);
  const changed = ffmpegChanged || ffprobeChanged;
  writeNotice();
  if (changed || FORCE || !readyForSourcesHost({ ffmpegSrc, ffprobeSrc })) {
    assertRequiredCapabilities();
    writeReadyMarker('executed-capabilities');
    console.log(`[fetch-ffmpeg] vendored ffmpeg + ffprobe for ${platformKey}`);
  } else {
    console.log(`[fetch-ffmpeg] ffmpeg + ffprobe already ready for ${platformKey}`);
  }
}

async function mainCross() {
  const pin = CROSS_PINS[platformKey];
  if (!pin) {
    throw new Error(`cross-vendoring not configured for ${platformKey}: add a CROSS_PINS entry `
      + '(sha256 of the ffmpeg-static release asset + the @ffprobe-installer tarball binary).');
  }
  fs.mkdirSync(destDir, { recursive: true });
  if (!FORCE && readyCross(pin)) {
    console.log(`[fetch-ffmpeg] ffmpeg + ffprobe already ready for ${platformKey} (cross, sha256-pinned)`);
    return;
  }
  console.log(`[fetch-ffmpeg] cross-vendoring ${platformKey} on ${process.platform}-${process.arch} (download + sha256)`);
  const [ffmpegBin, ffprobeBin] = await Promise.all([
    downloadCrossFfmpeg(pin.ffmpeg),
    downloadCrossFfprobe(pin.ffprobe),
  ]);
  writeBinaryBuffer(`ffmpeg${exe}`, ffmpegBin);
  writeBinaryBuffer(`ffprobe${exe}`, ffprobeBin);
  writeNotice();
  writeReadyMarker('pinned-sha256');
  // A foreign-platform binary can't be executed here, so sha256 IS the check —
  // the libass capability check runs only for host-target builds above.
  console.log(`[fetch-ffmpeg] cross-vendored ffmpeg + ffprobe for ${platformKey} (sha256-verified; run-on-target smoke test belongs in release QA)`);
}

async function main() {
  if (IS_HOST_TARGET) await mainHost();
  else await mainCross();
}

main().catch((err) => {
  console.error(`[fetch-ffmpeg] failed: ${err.message}`);
  process.exit(1);
});
