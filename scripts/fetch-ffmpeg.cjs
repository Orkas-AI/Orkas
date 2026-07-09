#!/usr/bin/env node
/**
 * Vendor ffmpeg + ffprobe into `PC/resources/runtime/ffmpeg/<platform>-<arch>/`.
 *
 * VideoStudio's native render path and deterministic media scripts require
 * ffmpeg + ffprobe. Rather than depend on whatever the user's machine happens
 * to have, we ship our own and point the app at them via util/bundled-runtime.ts
 * `bundledFfmpegPaths`.
 *
 * Source of the binaries: the `ffmpeg-static` and `@ffprobe-installer/ffprobe`
 * devDependencies (their install scripts fetch the prebuilt binary for the
 * current platform). NB: `ffprobe-static` is deliberately NOT used — its
 * darwin/arm64 asset is mislabeled (ships an x86_64 binary), which fails with
 * "bad CPU type" on Apple Silicon. `@ffprobe-installer/ffprobe` ships a correct
 * per-arch binary. Those packages are NOT shipped — only the copied binaries under
 * `resources/runtime/ffmpeg/` land in the installer (the existing
 * `extraResources: resources/runtime` rule picks them up; no electron-builder
 * change needed). Binaries are gitignored like the other runtime payloads.
 *
 * License: ffmpeg/ffprobe are invoked as a separate process (not linked). The
 * `ffmpeg-static` binaries are GPL builds — the in-repo NOTICE must list their
 * source. This is "mere aggregation" of a separate program, not a derivative
 * link, so it does not impose copyleft on Orkas itself.
 *
 * Idempotent: re-copies on each run (cheap); dev startup and the build pipeline
 * run it before boot/packaging. Run `npm run ffmpeg:fetch` to vendor for the
 * current machine.
 *
 * Flags:
 *   --force   re-copy even if a valid copy already exists (default: copy always)
 */
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const pcRoot = path.resolve(__dirname, '..');
const platformKey = `${process.platform}-${process.arch}`;
const destDir = path.join(pcRoot, 'resources', 'runtime', 'ffmpeg', platformKey);
const exe = process.platform === 'win32' ? '.exe' : '';

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

function copyBinary(src, destName) {
  const dest = path.join(destDir, destName);
  fs.copyFileSync(src, dest);
  fs.chmodSync(dest, 0o755);
  const bytes = fs.statSync(dest).size;
  console.log(`[fetch-ffmpeg] ${destName} -> ${dest} (${(bytes / 1e6).toFixed(1)} MB)`);
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
  fs.writeFileSync(dest, NOTICE);
  console.log(`[fetch-ffmpeg] NOTICE.txt -> ${dest}`);
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

function main() {
  const { ffmpegSrc, ffprobeSrc } = resolveSources();
  fs.mkdirSync(destDir, { recursive: true });
  copyBinary(ffmpegSrc, `ffmpeg${exe}`);
  copyBinary(ffprobeSrc, `ffprobe${exe}`);
  writeNotice();
  assertRequiredCapabilities();
  console.log(`[fetch-ffmpeg] vendored ffmpeg + ffprobe for ${platformKey}`);
  // NOTE: vendors only the build-machine arch. A cross-arch release (e.g. an
  // x64 dmg built on arm64, or mac universal) needs the other arch's binaries
  // too — that is a release-pipeline follow-up (multi-arch fetch), tracked in
  // the design plan §12. Same-arch dev + build is fully covered here.
}

try {
  main();
} catch (err) {
  console.error(`[fetch-ffmpeg] failed: ${err.message}`);
  process.exit(1);
}
