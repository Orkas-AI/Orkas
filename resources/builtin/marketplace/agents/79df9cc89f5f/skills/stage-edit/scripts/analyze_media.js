'use strict';

const fs = require('node:fs');
const path = require('node:path');

const OPS = new Set(['silence', 'scenes', 'quality', 'phrases', 'activity', 'beats']);

function fail(code, message, extra = {}) {
  process.stderr.write(JSON.stringify({ ok: false, code, message, ...extra }) + '\n');
  process.exit(1);
}

function help() {
  return {
    ok: true,
    script: 'analyze_media',
    ops: [...OPS],
    usage: 'stage-edit analyze_media -- --op <silence|scenes|quality> --input <media>; --op phrases --input <media> --transcript <speech.transcribe JSON> [--output phrases.txt] [--break 0.5] [--noise-db -40]; --op activity --input <media> --regions <JSON list of {id, box: [left, top, right, bottom]}> (fractions of the frame) [--window 0.5 (positive seconds; at most 100000 summary windows per clip)] [--lead-ratio 1.5] [--min-turn 1]; --op beats --input <music, or a cut video to check> [--fps 30]. Use video_studio op "speech.transcribe" for transcription.',
  };
}

function nextValue(args, i, name) {
  if (i + 1 >= args.length) fail('E_ARGS', `${name} requires a value`);
  return args[i + 1];
}

function parseJsonOrFile(raw, label) {
  const text = String(raw || '').trim();
  const jsonText = text.startsWith('@') ? fs.readFileSync(path.resolve(process.cwd(), text.slice(1)), 'utf8') : text;
  try {
    return JSON.parse(jsonText);
  } catch (err) {
    return fail('E_ARGS', `${label} is not valid JSON: ${err.message}`);
  }
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
    else if (a === '--transcript' || a === '--transcript-path') { out.transcriptPath = nextValue(args, i, a); i += 1; }
    else if (a.startsWith('--transcript=')) out.transcriptPath = a.slice('--transcript='.length);
    else if (a === '--output' || a === '--output-path') { out.outputPath = nextValue(args, i, a); i += 1; }
    else if (a.startsWith('--output=')) out.outputPath = a.slice('--output='.length);
    else if (a === '--regions') { out.regions = parseJsonOrFile(nextValue(args, i, a), a); i += 1; }
    else if (a.startsWith('--regions=')) out.regions = parseJsonOrFile(a.slice('--regions='.length), '--regions');
    else if (a === '--window') { out.windowSec = parseNumber(nextValue(args, i, a), a); i += 1; }
    else if (a === '--lead-ratio') { out.leadRatio = parseNumber(nextValue(args, i, a), a); i += 1; }
    else if (a === '--fps') { out.fps = parseNumber(nextValue(args, i, a), a); i += 1; }
    else if (a.startsWith('--fps=')) out.fps = parseNumber(a.slice('--fps='.length), '--fps');
    else if (a === '--min-turn') { out.minTurnSec = parseNumber(nextValue(args, i, a), a); i += 1; }
    else if (a === '--break') { out.breakSec = parseNumber(nextValue(args, i, a), a); i += 1; }
    else if (a.startsWith('--break=')) out.breakSec = parseNumber(a.slice('--break='.length), '--break');
    else if (a === '--noise-db') { out.noiseDb = parseNumber(nextValue(args, i, a), a); i += 1; }
    else if (a.startsWith('--noise-db=')) out.noiseDb = parseNumber(a.slice('--noise-db='.length), '--noise-db');
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

/** The phrase view goes into the reply when short; a long one is saved to
 *  --output and read in parts, so a 40-minute recording does not flood the turn. */
function phrasesResult(summary, abs, maxInline) {
  const { text, ...counts } = summary;
  if (abs) {
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, `${text}\n`, 'utf8');
    return { ok: true, op: 'phrases', summary: counts, path: abs, text: `Phrase view saved to ${abs} (${counts.lines} lines).` };
  }
  const rows = text.split('\n');
  const lineRows = rows.filter((r) => r.startsWith('['));
  if (lineRows.length <= maxInline) return { ok: true, op: 'phrases', summary: counts, text };
  let seen = 0;
  const head = [];
  for (const r of rows) {
    if (r.startsWith('[')) { seen += 1; if (seen > maxInline) break; }
    head.push(r);
  }
  return {
    ok: true,
    op: 'phrases',
    summary: { ...counts, truncated: true },
    text: `${head.join('\n')}\n… ${counts.lines - maxInline} more lines. Run again with --output phrases.txt and read the file in parts.`,
  };
}

module.exports = async function analyzeMediaScript({ args }) {
  const opts = parseArgs(args || []);
  if (opts.help) return help();
  if (!OPS.has(opts.op)) fail('E_ARGS', `op must be one of: ${[...OPS].join(', ')}`);
  if (!opts.inputPath) fail('E_ARGS', '--input is required');

  const { analyzeMedia, PHRASES_INLINE_MAX_LINES } = require('./lib/video_analyze_core.cjs');
  const qualityThresholds = Object.keys(opts.qualityThresholds).length ? opts.qualityThresholds : undefined;
  const inputAbsPath = resolveInput(opts.inputPath);
  if (opts.op === 'activity' && opts.regions === undefined) fail('E_ARGS', 'activity requires --regions: a box around each speaker\'s mouth, as fractions of the frame');
  if (opts.op === 'phrases' && !opts.transcriptPath) fail('E_ARGS', 'phrases requires --transcript (the speech.transcribe JSON for this media)');
  const transcriptAbsPath = opts.op === 'phrases' ? resolveInput(opts.transcriptPath) : undefined;
  const outputAbsPath = opts.op === 'phrases' && opts.outputPath ? path.resolve(process.cwd(), String(opts.outputPath).trim()) : undefined;
  if (outputAbsPath && (outputAbsPath === inputAbsPath || outputAbsPath === transcriptAbsPath)) {
    fail('E_ARGS', '--output must not be the media or the transcript');
  }
  const result = await analyzeMedia({
    op: opts.op,
    inputAbsPath,
    ...(typeof opts.threshold === 'number' ? { threshold: opts.threshold } : {}),
    ...(qualityThresholds ? { qualityThresholds } : {}),
    ...(transcriptAbsPath ? { transcriptAbsPath } : {}),
    ...(typeof opts.breakSec === 'number' ? { breakSec: opts.breakSec } : {}),
    ...(typeof opts.noiseDb === 'number' ? { noiseDb: opts.noiseDb } : {}),
    ...(opts.regions !== undefined ? { regions: opts.regions } : {}),
    ...(typeof opts.windowSec === 'number' ? { windowSec: opts.windowSec } : {}),
    ...(typeof opts.leadRatio === 'number' ? { leadRatio: opts.leadRatio } : {}),
    ...(typeof opts.minTurnSec === 'number' ? { minTurnSec: opts.minTurnSec } : {}),
    ...(typeof opts.fps === 'number' ? { fps: opts.fps } : {}),
  });

  if (result.ok === false) fail(result.errorCode, result.message);
  if (opts.op === 'phrases') return phrasesResult(result.summary, outputAbsPath, PHRASES_INLINE_MAX_LINES);
  return {
    ok: true,
    op: opts.op,
    summary: result.summary,
    text: `${opts.op} summary is available in summary.`,
  };
};
