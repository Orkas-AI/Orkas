'use strict';

const fs = require('node:fs');
const path = require('node:path');

const OPS = new Set(['render', 'lint', 'inspect']);
const QUALITY = new Set(['draft', 'standard', 'high']);
const FORMAT = new Set(['mp4', 'webm']);

function fail(code, message, extra = {}) {
  process.stderr.write(JSON.stringify({ ok: false, code, message, ...extra }) + '\n');
  process.exit(1);
}

function help() {
  return {
    ok: true,
    script: 'render_composition',
    ops: [...OPS],
    usage: 'stage-compose render_composition -- --op <inspect|lint|render> --composition-dir <dir> [--output <video>]',
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

function parseJson(raw, label) {
  const text = String(raw || '').trim();
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch (err) {
    fail('E_ARGS', `${label} is not valid JSON: ${err.message}`);
  }
}

function parseArgs(args) {
  const out = { op: 'render', compositionDir: '', outputPath: '', help: false };
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i];
    if (a === '--help' || a === '-h') out.help = true;
    else if (a === '--op' || a === '-o') { out.op = nextValue(args, i, a); i += 1; }
    else if (a.startsWith('--op=')) out.op = a.slice('--op='.length);
    else if (a === '--composition-dir' || a === '--dir' || a === '-d') { out.compositionDir = nextValue(args, i, a); i += 1; }
    else if (a.startsWith('--composition-dir=')) out.compositionDir = a.slice('--composition-dir='.length);
    else if (a.startsWith('--dir=')) out.compositionDir = a.slice('--dir='.length);
    else if (a === '--output' || a === '--output-path') { out.outputPath = nextValue(args, i, a); i += 1; }
    else if (a.startsWith('--output=')) out.outputPath = a.slice('--output='.length);
    else if (a.startsWith('--output-path=')) out.outputPath = a.slice('--output-path='.length);
    else if (a === '--quality') { out.quality = nextValue(args, i, a); i += 1; }
    else if (a.startsWith('--quality=')) out.quality = a.slice('--quality='.length);
    else if (a === '--format') { out.format = nextValue(args, i, a); i += 1; }
    else if (a.startsWith('--format=')) out.format = a.slice('--format='.length);
    else if (a === '--fps') { out.fps = parseNumber(nextValue(args, i, a), a); i += 1; }
    else if (a.startsWith('--fps=')) out.fps = parseNumber(a.slice('--fps='.length), '--fps');
    else if (a === '--variables') { out.variables = parseJson(nextValue(args, i, a), a); i += 1; }
    else if (a.startsWith('--variables=')) out.variables = parseJson(a.slice('--variables='.length), '--variables');
    else if (!out.compositionDir) out.compositionDir = a;
    else if (!out.outputPath) out.outputPath = a;
    else fail('E_ARGS', `unexpected argument: ${a}`);
  }
  return out;
}

function resolveDir(raw) {
  const abs = path.resolve(process.cwd(), String(raw || '').trim());
  const st = fs.existsSync(abs) ? fs.statSync(abs) : null;
  if (!st || !st.isDirectory()) fail('E_INPUT', `composition_dir is not a directory: ${abs}`, { path: abs });
  return abs;
}

function withFormatExtension(rawAbs, format) {
  return path.extname(rawAbs) ? rawAbs : `${rawAbs}.${format}`;
}

function uniquifyOutputPath(requested) {
  if (!fs.existsSync(requested)) return { finalPath: requested, renamed: false };

  const { dir, name, ext } = path.parse(requested);
  for (let n = 2; n < 10000; n += 1) {
    const candidate = path.join(dir, `${name}-${n}${ext}`);
    if (!fs.existsSync(candidate)) return { finalPath: candidate, renamed: true };
  }
  fail('E_OUTPUT', `could not find a non-conflicting output path under ${dir}`, { path: requested });
}

async function outputFile(raw, format) {
  if (!raw) fail('E_ARGS', '--output is required for op=render');
  const requested = withFormatExtension(path.resolve(process.cwd(), String(raw).trim()), format);
  const { finalPath, renamed } = uniquifyOutputPath(requested);
  return { requested, finalPath, renamed };
}

module.exports = async function renderCompositionScript({ args }) {
  const opts = parseArgs(args || []);
  if (opts.help) return help();
  if (!OPS.has(opts.op)) fail('E_ARGS', `op must be one of: ${[...OPS].join(', ')}`);
  if (!opts.compositionDir) fail('E_ARGS', '--composition-dir is required');

  const compositionDirAbs = resolveDir(opts.compositionDir);
  const { renderComposition, qaComposition } = require('./lib/video_render_core.cjs');

  if (opts.op === 'lint' || opts.op === 'inspect') {
    const result = await qaComposition(opts.op, { projectDirAbs: compositionDirAbs });
    if (result.ok === false) fail(result.errorCode, result.message);
    return {
      ok: true,
      op: opts.op,
      findings: result.findings,
      text: `${opts.op} findings are available in findings.`,
    };
  }

  const format = FORMAT.has(opts.format) ? opts.format : 'mp4';
  const quality = QUALITY.has(opts.quality) ? opts.quality : undefined;
  const out = await outputFile(opts.outputPath, format);
  const result = await renderComposition({
    projectDirAbs: compositionDirAbs,
    outputAbsPath: out.finalPath,
    ...(quality ? { quality } : {}),
    ...(typeof opts.fps === 'number' ? { fps: opts.fps } : {}),
    format,
    ...(opts.variables && typeof opts.variables === 'object' && !Array.isArray(opts.variables) ? { variables: opts.variables } : {}),
  });
  if (result.ok === false) fail(result.errorCode, result.message);
  return {
    ok: true,
    op: opts.op,
    path: result.path,
    bytes: result.bytes,
    media: `chat-media://local/${result.path}`,
    renamed: out.renamed,
    requested_path: out.requested,
    text: `Video rendered to ${result.path}.`,
  };
};
