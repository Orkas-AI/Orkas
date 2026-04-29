#!/usr/bin/env node
/**
 * Ensure the bge-small-zh-v1.5 ONNX embedding model is present at
 * `PC/resources/embedding-model/fast-bge-small-zh-v1.5/`. Downloads from
 * Qdrant's fastembed GCS mirror (same source fastembed uses internally) and
 * extracts in place. Idempotent: if the expected files already exist, exit 0.
 *
 * Runs as a postinstall hook so clone → `npm install` → dev-ready. Binary
 * is gitignored (95MB, too big for git), but the installer picks it up via
 * electron-builder's `extraResources` → shipped to users with zero download
 * at first run.
 *
 * Offline-tolerant: if the download fails AND the files are already present,
 * success. Only fails if files are missing and fetch fails.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as https from 'node:https';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const here = path.dirname(fileURLToPath(import.meta.url));
const pcRoot = path.resolve(here, '..');
const destDir = path.join(pcRoot, 'resources', 'embedding-model');
const MODEL = 'fast-bge-small-zh-v1.5';
const modelDir = path.join(destDir, MODEL);
const tarballUrl = `https://storage.googleapis.com/qdrant-fastembed/${MODEL}.tar.gz`;
const tarballPath = path.join(destDir, `${MODEL}.tar.gz`);

// Required files inside the extracted model dir — fastembed's FlagEmbedding.init
// checks for these at load time. If any are missing the download is redone.
const REQUIRED = ['config.json', 'tokenizer.json', 'model_optimized.onnx'];

function allFilesPresent() {
  if (!fs.existsSync(modelDir)) return false;
  return REQUIRED.every((f) => fs.existsSync(path.join(modelDir, f)));
}

function download(url, outPath) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(outPath);
    const req = https.get(url, { headers: { 'User-Agent': 'orkas-postinstall' } }, (res) => {
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        file.close();
        fs.rmSync(outPath, { force: true });
        download(res.headers.location, outPath).then(resolve, reject);
        return;
      }
      if (res.statusCode !== 200) {
        res.resume();
        file.close();
        fs.rmSync(outPath, { force: true });
        reject(new Error(`HTTP ${res.statusCode} fetching ${url}`));
        return;
      }
      const total = Number(res.headers['content-length'] || 0);
      let done = 0;
      let lastPct = -1;
      res.on('data', (chunk) => {
        done += chunk.length;
        if (total) {
          const pct = Math.floor((done / total) * 100);
          if (pct !== lastPct && pct % 5 === 0) {
            process.stdout.write(`\r  ${MODEL}: ${pct}% (${(done / 1024 / 1024).toFixed(1)}MB / ${(total / 1024 / 1024).toFixed(1)}MB)`);
            lastPct = pct;
          }
        }
      });
      res.pipe(file);
      file.on('finish', () => { file.close(); process.stdout.write('\n'); resolve(); });
      file.on('error', (err) => { file.close(); fs.rmSync(outPath, { force: true }); reject(err); });
    });
    req.on('error', (err) => {
      file.close();
      fs.rmSync(outPath, { force: true });
      reject(err);
    });
    req.setTimeout(60_000, () => { req.destroy(new Error('timeout')); });
  });
}

async function extract(tgzPath, dstDir) {
  // Use the `tar` npm package if available (transitive dep of fastembed);
  // fall back to the system `tar` CLI if not (pre-install phase).
  try {
    const require = createRequire(import.meta.url);
    const tar = require('tar');
    await tar.x({ file: tgzPath, cwd: dstDir });
    return;
  } catch (err) {
    if (err.code !== 'MODULE_NOT_FOUND') throw err;
  }
  // System tar fallback (macOS / Linux / modern Windows all have it).
  const { spawnSync } = await import('node:child_process');
  const r = spawnSync('tar', ['-xzf', tgzPath, '-C', dstDir], { stdio: 'inherit' });
  if (r.status !== 0) throw new Error(`tar extraction failed (exit ${r.status})`);
}

async function main() {
  fs.mkdirSync(destDir, { recursive: true });

  if (allFilesPresent()) {
    console.log(`[embedding-model] already present at ${modelDir}, skipping`);
    return;
  }

  console.log(`[embedding-model] fetching ${tarballUrl}`);
  try {
    await download(tarballUrl, tarballPath);
    await extract(tarballPath, destDir);
    fs.rmSync(tarballPath, { force: true });
  } catch (err) {
    fs.rmSync(tarballPath, { force: true });
    if (allFilesPresent()) {
      console.warn(`[embedding-model] download failed but files already present: ${err.message}`);
      return;
    }
    throw err;
  }

  if (!allFilesPresent()) {
    throw new Error(`[embedding-model] extraction completed but required files missing in ${modelDir}`);
  }
  console.log(`[embedding-model] ready at ${modelDir}`);
}

main().catch((err) => {
  console.error(`[embedding-model] ERROR: ${err.message}`);
  process.exit(1);
});
