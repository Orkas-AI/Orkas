#!/usr/bin/env node
/**
 * Vendor the OfficeCLI binary into `PC/resources/officecli/`.
 *
 * OfficeCLI (https://github.com/iOfficeAI/OfficeCLI, Apache-2.0) is a single
 * self-contained native binary (embedded .NET runtime, no Office/LibreOffice
 * needed) that we bundle as the built-in engine for reading/creating/editing/
 * rendering docx/xlsx/pptx. Release assets are RAW binaries (not archives), so
 * this just downloads, sha256-verifies against a PINNED map, and chmods.
 *
 * Supply-chain guard: the expected hashes below are pinned in-repo. A download
 * whose hash does not match is deleted and the run fails — upstream tampering or
 * a moved tag cannot silently land a different binary. To bump the version,
 * change VERSION + SHA256 together (copy the release's SHA256SUMS).
 *
 * Layout: `resources/officecli/<assetName>` (e.g. `officecli-mac-arm64`,
 * `officecli-win-x64.exe`). The engine layer resolves the asset for the running
 * platform via `ASSETS['${process.platform}-${process.arch}']`.
 *
 * Selection: by default fetches the CURRENT platform/arch. Multi-arch release
 * builds pass explicit --platform targets, just like ensure-runtime. Flags:
 *   --all                 every shippable target (mac + win, both arches)
 *   --root=<dir>          destination root (default: PC/resources/officecli)
 *   --platform=<key>      a specific `${platform}-${arch}` (repeatable)
 *   --force               re-download even if a valid copy exists
 *   --check               verify the selected asset(s) exist + match pinned
 *                         hashes, but do not download
 *   --optional            exit 0 on download failure; manual dev escape hatch
 *   --prune               after fetching, delete any officecli-* asset NOT in
 *                         the selected set (LICENSE kept). Used by the release
 *                         pipeline so each platform's build source carries only
 *                         its own target binary, never sibling-OS binaries that
 *                         build-source-cache copied in.
 *
 * Binaries are gitignored (~33MB each); the installer picks them up via
 * electron-builder `extraResources`. Idempotent + offline-tolerant: a present,
 * hash-valid copy is left untouched and a failed download with a valid copy
 * already on disk is not an error.
 */
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const https = require('node:https');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

const VERSION = 'v1.0.131';
const REPO = 'iOfficeAI/OfficeCLI';
const RELEASE_BASE_URL = process.env.OFFICECLI_RELEASE_BASE_URL || `https://github.com/${REPO}/releases/download/${VERSION}`;
const LICENSE_URL = process.env.OFFICECLI_LICENSE_URL || `https://raw.githubusercontent.com/${REPO}/${VERSION}/LICENSE`;
const DOWNLOAD_RETRIES = Number(process.env.OFFICECLI_FETCH_RETRIES || 3);
const STALL_TIMEOUT_MS = Number(process.env.OFFICECLI_FETCH_STALL_MS || 120_000);
const pcRoot = path.resolve(__dirname, '..');
let destDir = path.join(pcRoot, 'resources', 'officecli');

// `${process.platform}-${process.arch}` -> release asset name. Desktop targets
// only (mac + win); linux assets exist upstream but we do not ship them.
const ASSETS = {
  'darwin-arm64': 'officecli-mac-arm64',
  'darwin-x64': 'officecli-mac-x64',
  'win32-x64': 'officecli-win-x64.exe',
  'win32-arm64': 'officecli-win-arm64.exe',
};

// Pinned sha256 for VERSION (from the release SHA256SUMS). Update with VERSION.
const SHA256 = {
  'officecli-mac-arm64': '1a10e73e73e1a3aa278d75af8e966ce932691bbf9958a06578638c42181894fb',
  'officecli-mac-x64': 'daa90b846c85a2ca61eec743fd41da6d02f74c7c68560ccecfdab2e977737730',
  'officecli-win-x64.exe': 'b67e6f95c309707fad51fad2da26a87aa8d967774cde9f7b47bb452811164e73',
  'officecli-win-arm64.exe': 'f4224772a7d450053fcacaa54175704e89d99ca23535e7d24fc340bc6dcef43e',
};

function parseArgs(argv) {
  const opts = { all: false, check: false, force: false, optional: false, prune: false, root: destDir, platforms: [] };
  for (const a of argv) {
    if (a === '--all') opts.all = true;
    else if (a === '--check') opts.check = true;
    else if (a === '--force') opts.force = true;
    else if (a === '--optional') opts.optional = true;
    else if (a === '--prune') opts.prune = true;
    else if (a.startsWith('--root=')) opts.root = path.resolve(a.slice('--root='.length));
    else if (a.startsWith('--platform=')) opts.platforms.push(a.slice('--platform='.length));
    else throw new Error(`unknown argument: ${a}`);
  }
  return opts;
}

function selectAssets(opts) {
  let keys;
  if (opts.platforms.length) keys = opts.platforms;
  else if (opts.all) keys = Object.keys(ASSETS);
  else keys = [`${process.platform}-${process.arch}`];
  const names = [];
  for (const k of keys) {
    const name = ASSETS[k];
    if (!name) throw new Error(`no OfficeCLI asset for platform key "${k}" (known: ${Object.keys(ASSETS).join(', ')})`);
    if (!names.includes(name)) names.push(name);
  }
  if (!names.length) throw new Error(`no shippable OfficeCLI asset for ${process.platform}-${process.arch}`);
  return names;
}

function sha256File(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const s = fs.createReadStream(filePath);
    s.on('error', reject);
    s.on('data', (c) => hash.update(c));
    s.on('end', () => resolve(hash.digest('hex')));
  });
}

function requestClient(url) {
  const parsed = new URL(url);
  if (parsed.protocol === 'http:') return http;
  if (parsed.protocol === 'https:') return https;
  throw new Error(`unsupported URL protocol for ${url}`);
}

function partialSize(filePath) {
  try {
    return fs.statSync(filePath).size;
  } catch {
    return 0;
  }
}

function downloadOnce(url, outPath, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 5) {
      reject(new Error(`too many redirects for ${url}`));
      return;
    }
    let file = null;
    let stallTimer = null;
    const resumeFrom = partialSize(outPath);
    const headers = { 'User-Agent': 'orkas-fetch-officecli' };
    if (resumeFrom > 0) headers.Range = `bytes=${resumeFrom}-`;

    const cleanup = () => {
      if (stallTimer) clearTimeout(stallTimer);
      if (file) file.close();
    };
    const fail = (err) => {
      cleanup();
      reject(err);
    };

    const req = requestClient(url).get(url, { headers }, (res) => {
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        cleanup();
        downloadOnce(res.headers.location, outPath, redirects + 1).then(resolve, reject);
        return;
      }

      let append = false;
      let initialDone = 0;
      if (resumeFrom > 0 && res.statusCode === 206) {
        append = true;
        initialDone = resumeFrom;
      } else if (resumeFrom > 0 && res.statusCode === 200) {
        console.warn(`[officecli] server ignored Range for ${path.basename(outPath)}; restarting download`);
        fs.rmSync(outPath, { force: true });
      } else if (res.statusCode !== 200) {
        res.resume();
        fail(new Error(`HTTP ${res.statusCode} fetching ${url}`));
        return;
      }

      file = fs.createWriteStream(outPath, { flags: append ? 'a' : 'w' });
      const contentLength = Number(res.headers['content-length'] || 0);
      const total = contentLength ? initialDone + contentLength : 0;
      let done = initialDone;
      let lastPct = -1;
      const armStallTimer = () => {
        if (stallTimer) clearTimeout(stallTimer);
        stallTimer = setTimeout(() => {
          req.destroy(new Error(`timeout after ${STALL_TIMEOUT_MS}ms with no download progress`));
        }, STALL_TIMEOUT_MS);
      };
      armStallTimer();
      res.on('data', (chunk) => {
        done += chunk.length;
        armStallTimer();
        if (total) {
          const pct = Math.floor((done / total) * 100);
          if (pct !== lastPct && pct % 10 === 0) {
            process.stdout.write(`\r  ${(done / 1048576).toFixed(1)}MB / ${(total / 1048576).toFixed(1)}MB (${pct}%)`);
            lastPct = pct;
          }
        }
      });
      res.pipe(file);
      file.on('finish', () => {
        cleanup();
        if (total) process.stdout.write('\n');
        resolve();
      });
      file.on('error', fail);
    });
    req.on('error', fail);
    req.setTimeout(STALL_TIMEOUT_MS, () => req.destroy(new Error('timeout')));
  });
}

async function download(url, outPath) {
  let lastError = null;
  for (let attempt = 1; attempt <= DOWNLOAD_RETRIES + 1; attempt += 1) {
    try {
      await downloadOnce(url, outPath);
      return;
    } catch (err) {
      lastError = err;
      if (attempt <= DOWNLOAD_RETRIES) {
        console.warn(`[officecli] download failed (${err.message}); retrying ${attempt}/${DOWNLOAD_RETRIES}`);
      }
    }
  }
  throw lastError;
}

function doctorAsset(name, finalPath) {
  if (!name.endsWith('.exe')) {
    try { fs.chmodSync(finalPath, 0o755); } catch { /* best-effort on readonly filesystems */ }
  }
  if (process.platform === 'darwin') {
    spawnSync('xattr', ['-d', 'com.apple.quarantine', finalPath], { timeout: 30_000, stdio: 'ignore' });
  }
}

async function verifyAsset(name) {
  const expected = SHA256[name];
  if (!expected) throw new Error(`no pinned sha256 for asset "${name}" — refusing to fetch unverifiable binary`);
  const finalPath = path.join(destDir, name);
  if (!fs.existsSync(finalPath)) throw new Error(`${name} missing at ${finalPath}`);
  const have = await sha256File(finalPath);
  if (have !== expected) {
    throw new Error(`sha256 mismatch for ${name}\n  expected ${expected}\n  got      ${have}`);
  }
  doctorAsset(name, finalPath);
  return finalPath;
}

async function fetchAsset(name, force) {
  const expected = SHA256[name];
  if (!expected) throw new Error(`no pinned sha256 for asset "${name}" — refusing to fetch unverifiable binary`);
  const finalPath = path.join(destDir, name);
  const isExe = name.endsWith('.exe');

  if (!force && fs.existsSync(finalPath)) {
    try {
      await verifyAsset(name);
      console.log(`[officecli] ${name} present and verified, skipping`);
      return;
    } catch (err) {
      console.warn(`[officecli] ${name} on disk is not verified (${err.message}), re-fetching`);
    }
  }

  const url = `${RELEASE_BASE_URL}/${name}`;
  const partPath = `${finalPath}.part`;
  if (force) fs.rmSync(partPath, { force: true });
  const resumeFrom = partialSize(partPath);
  if (resumeFrom > 0) console.log(`[officecli] resuming ${name} from ${resumeFrom} bytes`);
  console.log(`[officecli] fetching ${url}`);
  await download(url, partPath);

  const got = await sha256File(partPath);
  if (got !== expected) {
    fs.rmSync(partPath, { force: true });
    throw new Error(`sha256 mismatch for ${name}\n  expected ${expected}\n  got      ${got}`);
  }
  fs.renameSync(partPath, finalPath);
  if (!isExe) fs.chmodSync(finalPath, 0o755);
  doctorAsset(name, finalPath);
  console.log(`[officecli] ${name} verified -> ${finalPath}`);
}

// Drop sibling-OS binaries the source copy may have carried in, so a packaged
// build ships only the asset(s) it just fetched. Scoped strictly to KNOWN
// officecli asset names (never LICENSE or unrelated files); .part temporaries
// are left for the next run / electron-builder filter to ignore.
function pruneAssets(keep) {
  const keepSet = new Set(keep);
  const known = new Set(Object.values(ASSETS));
  if (!fs.existsSync(destDir)) return;
  for (const name of fs.readdirSync(destDir)) {
    if (known.has(name) && !keepSet.has(name)) {
      fs.rmSync(path.join(destDir, name), { force: true });
      console.log(`[officecli] pruned non-target asset ${name}`);
    }
  }
}

// Apache-2.0 requires shipping the license; best-effort, never fails the run.
async function fetchLicense() {
  const out = path.join(destDir, 'LICENSE');
  if (fs.existsSync(out)) return;
  try {
    await download(LICENSE_URL, out);
    console.log('[officecli] LICENSE fetched');
  } catch (err) {
    console.warn(`[officecli] could not fetch LICENSE (${err.message}) — add it manually before release`);
  }
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  destDir = opts.root;
  fs.mkdirSync(destDir, { recursive: true });
  const assets = selectAssets(opts);
  console.log(`[officecli] ${VERSION} -> ${destDir} (${assets.join(', ')})`);

  let firstError = null;
  for (const name of assets) {
    try {
      if (opts.check) {
        const finalPath = await verifyAsset(name);
        console.log(`[officecli] ${name} verified -> ${finalPath}`);
      } else {
        await fetchAsset(name, opts.force);
      }
    } catch (err) {
      const finalPath = path.join(destDir, name);
      if (fs.existsSync(finalPath) && (await sha256File(finalPath)) === SHA256[name]) {
        doctorAsset(name, finalPath);
        console.warn(`[officecli] fetch of ${name} failed but a valid copy exists: ${err.message}`);
      } else {
        firstError = firstError || err;
        console.error(`[officecli] ${name}: ${err.message}`);
      }
    }
  }
  if (opts.prune) pruneAssets(assets);
  if (opts.check) {
    const license = path.join(destDir, 'LICENSE');
    if (!fs.existsSync(license)) firstError = firstError || new Error(`LICENSE missing at ${license}`);
  } else {
    await fetchLicense();
  }
  if (firstError) {
    if (opts.optional) {
      console.warn(`[officecli] optional fetch failed; Office document tools may be unavailable until this succeeds: ${firstError.message}`);
      return;
    }
    throw firstError;
  }
}

main().catch((err) => {
  console.error(`[officecli] ERROR: ${err.message}`);
  process.exit(1);
});
