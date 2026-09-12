#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const pcRoot = path.resolve(__dirname, '..');
const modelRoot = path.join(
  pcRoot,
  'resources',
  'embedding-model',
  'fast-bge-small-zh-v1.5',
);

function requireCondition(condition, message) {
  if (!condition) throw new Error(message);
}

const native = require('./native-dependency-probe.cjs');
const probeSqlite = () => native.probeSqlite(require);
const probeSharp = () => native.probeSharp(require);

async function probeCanvas() {
  const { createCanvas } = require('@napi-rs/canvas');
  const canvas = createCanvas(2, 2);
  const context = canvas.getContext('2d');
  context.fillStyle = '#123456';
  context.fillRect(0, 0, 2, 2);
  const png = canvas.toBuffer('image/png');
  requireCondition(Buffer.isBuffer(png) && png.length > 8, '@napi-rs/canvas did not produce a PNG');
}

async function probeEmbedding(fullEmbedding) {
  const tokenizers = require('@anush008/tokenizers');
  const tokenizerFile = path.join(modelRoot, 'tokenizer.json');
  requireCondition(fs.existsSync(tokenizerFile), 'embedding tokenizer is missing');
  const tokenizer = tokenizers.Tokenizer.fromFile(tokenizerFile);
  const encoded = await tokenizer.encode('Orkas Linux dependency probe');
  requireCondition(encoded.getIds().length > 0, 'tokenizer returned no token ids');

  // fastembed eagerly loads onnxruntime-node as well as tokenizers. Requiring
  // the public entrypoint catches missing shared libraries even in the fast
  // startup probe. CI additionally creates a real ONNX session and inference.
  const fastembed = require('fastembed');
  requireCondition(typeof fastembed.FlagEmbedding?.init === 'function', 'fastembed entrypoint is incomplete');
  if (!fullEmbedding) return;

  const embedder = await fastembed.FlagEmbedding.init({
    model: fastembed.EmbeddingModel.BGESmallZH,
    cacheDir: path.dirname(modelRoot),
    showDownloadProgress: false,
  });
  const batches = embedder.embed(['Orkas Linux dependency probe'], 1);
  let vector = null;
  for await (const batch of batches) {
    vector = batch?.[0] || null;
    break;
  }
  requireCondition(vector && vector.length === 512, 'embedding inference did not return a 512-dimensional vector');
  requireCondition(Array.from(vector).every(Number.isFinite), 'embedding inference returned a non-finite value');
}

async function main() {
  if (process.platform !== 'linux') {
    console.log(`[linux-native-probe] skipped on ${process.platform}-${process.arch}`);
    return;
  }
  const fullEmbedding = process.argv.includes('--full-embedding');
  await probeSqlite();
  await probeSharp();
  await probeCanvas();
  await probeEmbedding(fullEmbedding);
  console.log(
    `[linux-native-probe] verified better-sqlite3, sqlite-vec, sharp, canvas, tokenizers, onnxruntime`
      + `${fullEmbedding ? ', embedding-inference' : ''}`,
  );
}

if (require.main === module) {
  main().catch((err) => {
    console.error(`[linux-native-probe] failed: ${err.message}`);
    process.exit(1);
  });
}

module.exports = { probeCanvas, probeEmbedding, probeSharp, probeSqlite };
