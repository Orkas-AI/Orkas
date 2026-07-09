'use strict';

const fs = require('node:fs');
const path = require('node:path');

const OPS = new Set(['silence', 'ocr', 'scenes', 'quality']);

function fail(code, message, extra = {}) {
  process.stderr.write(JSON.stringify({ ok: false, code, message, ...extra }) + '\n');
  process.exit(1);
}

function help() {
  return {
    ok: true,
    script: 'analyze_media',
    ops: [...OPS],
    usage: 'stage-edit analyze_media -- --op <silence|ocr|scenes|quality> --input <media>. Use video_studio op "speech.transcribe" for transcription.',
  };
}

function nextValue(args, i, name) {
  if (i + 1 >= args.length) fail('E_ARGS', `${name} requires a value`);
  return args[i + 1];
}

function parseNumber(raw, label) {
  const n = Number(raw);
  if (!Number.isFinite(n)) fail('E_ARGS', `${label} must be a number`);
  return n;
}

function parseArgs(args) {
  const out = { op: '', inputPath: '', help: false, qualityThresholds: {} };
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i];
    if (a === '--help' || a === '-h') out.help = true;
    else if (a === '--op' || a === '-o') { out.op = nextValue(args, i, a); i += 1; }
    else if (a.startsWith('--op=')) out.op = a.slice('--op='.length);
    else if (a === '--input' || a === '--input-path' || a === '-i') { out.inputPath = nextValue(args, i, a); i += 1; }
    else if (a.startsWith('--input=')) out.inputPath = a.slice('--input='.length);
    else if (a.startsWith('--input-path=')) out.inputPath = a.slice('--input-path='.length);
    else if (a === '--interval-sec') { out.intervalSec = parseNumber(nextValue(args, i, a), a); i += 1; }
    else if (a.startsWith('--interval-sec=')) out.intervalSec = parseNumber(a.slice('--interval-sec='.length), '--interval-sec');
    else if (a === '--max-frames') { out.maxFrames = parseNumber(nextValue(args, i, a), a); i += 1; }
    else if (a.startsWith('--max-frames=')) out.maxFrames = parseNumber(a.slice('--max-frames='.length), '--max-frames');
    else if (a === '--threshold') { out.threshold = parseNumber(nextValue(args, i, a), a); i += 1; }
    else if (a.startsWith('--threshold=')) out.threshold = parseNumber(a.slice('--threshold='.length), '--threshold');
    else if (a === '--blur-threshold') { out.qualityThresholds.blur = parseNumber(nextValue(args, i, a), a); i += 1; }
    else if (a.startsWith('--blur-threshold=')) out.qualityThresholds.blur = parseNumber(a.slice('--blur-threshold='.length), '--blur-threshold');
    else if (a === '--dark-below') { out.qualityThresholds.darkBelow = parseNumber(nextValue(args, i, a), a); i += 1; }
    else if (a.startsWith('--dark-below=')) out.qualityThresholds.darkBelow = parseNumber(a.slice('--dark-below='.length), '--dark-below');
    else if (a === '--bright-above') { out.qualityThresholds.brightAbove = parseNumber(nextValue(args, i, a), a); i += 1; }
    else if (a.startsWith('--bright-above=')) out.qualityThresholds.brightAbove = parseNumber(a.slice('--bright-above='.length), '--bright-above');
    else if (!out.op) out.op = a;
    else if (!out.inputPath) out.inputPath = a;
    else fail('E_ARGS', `unexpected argument: ${a}`);
  }
  return out;
}

function resolveInput(raw) {
  const abs = path.resolve(process.cwd(), String(raw || '').trim());
  const st = fs.existsSync(abs) ? fs.statSync(abs) : null;
  if (!st || !st.isFile()) fail('E_INPUT', `input is not a file: ${abs}`, { path: abs });
  return abs;
}

module.exports = async function analyzeMediaScript({ args }) {
  const opts = parseArgs(args || []);
  if (opts.help) return help();
  if (!OPS.has(opts.op)) fail('E_ARGS', `op must be one of: ${[...OPS].join(', ')}`);
  if (!opts.inputPath) fail('E_ARGS', '--input is required');

  const { analyzeMedia } = require('./lib/video_analyze_core.cjs');
  const qualityThresholds = Object.keys(opts.qualityThresholds).length ? opts.qualityThresholds : undefined;
  const result = await analyzeMedia({
    op: opts.op,
    inputAbsPath: resolveInput(opts.inputPath),
    ...(typeof opts.intervalSec === 'number' ? { intervalSec: opts.intervalSec } : {}),
    ...(typeof opts.maxFrames === 'number' ? { maxFrames: opts.maxFrames } : {}),
    ...(typeof opts.threshold === 'number' ? { threshold: opts.threshold } : {}),
    ...(qualityThresholds ? { qualityThresholds } : {}),
  });

  if (result.ok === false) fail(result.errorCode, result.message);
  return {
    ok: true,
    op: opts.op,
    summary: result.summary,
    text: `${opts.op} summary is available in summary.`,
  };
};
