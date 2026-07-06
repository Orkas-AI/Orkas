'use strict';

const fs = require('node:fs');
const path = require('node:path');

const OPS = new Set(['probe', 'trim', 'concat', 'burnsubs', 'overlay', 'extract_frame', 'loudness', 'mix', 'trim_silence', 'remove_fillers']);
const OUTPUT_OPS = new Set(['trim', 'concat', 'burnsubs', 'overlay', 'extract_frame', 'mix', 'trim_silence', 'remove_fillers']);

function fail(code, message, extra = {}) {
  process.stderr.write(JSON.stringify({ ok: false, code, message, ...extra }) + '\n');
  process.exit(1);
}

function help() {
  return {
    ok: true,
    script: 'edit_video',
    ops: [...OPS],
    usage: 'stage-edit edit_video -- --op <op> --input <media> [--output <path>]',
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

function parseList(raw, label) {
  const text = String(raw || '').trim();
  if (!text) return [];
  if (text.startsWith('[')) {
    try {
      const value = JSON.parse(text);
      if (!Array.isArray(value)) fail('E_ARGS', `${label} JSON must be an array`);
      return value.map(String).map((x) => x.trim()).filter(Boolean);
    } catch (err) {
      fail('E_ARGS', `${label} is not valid JSON: ${err.message}`);
    }
  }
  return text.split(',').map((x) => x.trim()).filter(Boolean);
}

function parseJsonOrFile(raw, label) {
  const text = String(raw || '').trim();
  if (!text) return undefined;
  const jsonText = text.startsWith('@')
    ? fs.readFileSync(path.resolve(process.cwd(), text.slice(1)), 'utf8')
    : text;
  try {
    return JSON.parse(jsonText);
  } catch (err) {
    fail('E_ARGS', `${label} is not valid JSON: ${err.message}`);
  }
}

function parseArgs(args) {
  const out = { op: '', inputPath: '', inputPaths: [], outputPath: '', help: false, fillers: [] };
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i];
    if (a === '--help' || a === '-h') out.help = true;
    else if (a === '--op' || a === '-o') { out.op = nextValue(args, i, a); i += 1; }
    else if (a.startsWith('--op=')) out.op = a.slice('--op='.length);
    else if (a === '--input' || a === '--input-path' || a === '-i') { out.inputPath = nextValue(args, i, a); i += 1; }
    else if (a.startsWith('--input=')) out.inputPath = a.slice('--input='.length);
    else if (a.startsWith('--input-path=')) out.inputPath = a.slice('--input-path='.length);
    else if (a === '--inputs' || a === '--input-paths') { out.inputPaths.push(...parseList(nextValue(args, i, a), a)); i += 1; }
    else if (a.startsWith('--inputs=')) out.inputPaths.push(...parseList(a.slice('--inputs='.length), '--inputs'));
    else if (a.startsWith('--input-paths=')) out.inputPaths.push(...parseList(a.slice('--input-paths='.length), '--input-paths'));
    else if (a === '--output' || a === '--output-path') { out.outputPath = nextValue(args, i, a); i += 1; }
    else if (a.startsWith('--output=')) out.outputPath = a.slice('--output='.length);
    else if (a.startsWith('--output-path=')) out.outputPath = a.slice('--output-path='.length);
    else if (a === '--audio' || a === '--audio-path') { out.audioPath = nextValue(args, i, a); i += 1; }
    else if (a.startsWith('--audio=')) out.audioPath = a.slice('--audio='.length);
    else if (a.startsWith('--audio-path=')) out.audioPath = a.slice('--audio-path='.length);
    else if (a === '--audio-segments') { out.audioSegments = parseJsonOrFile(nextValue(args, i, a), a); i += 1; }
    else if (a.startsWith('--audio-segments=')) out.audioSegments = parseJsonOrFile(a.slice('--audio-segments='.length), '--audio-segments');
    else if (a === '--subtitles' || a === '--subtitles-path') { out.subtitlesPath = nextValue(args, i, a); i += 1; }
    else if (a.startsWith('--subtitles=')) out.subtitlesPath = a.slice('--subtitles='.length);
    else if (a.startsWith('--subtitles-path=')) out.subtitlesPath = a.slice('--subtitles-path='.length);
    else if (a === '--overlay' || a === '--overlay-path') { out.overlayPath = nextValue(args, i, a); i += 1; }
    else if (a.startsWith('--overlay=')) out.overlayPath = a.slice('--overlay='.length);
    else if (a.startsWith('--overlay-path=')) out.overlayPath = a.slice('--overlay-path='.length);
    else if (a === '--transcript' || a === '--transcript-path') { out.transcriptPath = nextValue(args, i, a); i += 1; }
    else if (a.startsWith('--transcript=')) out.transcriptPath = a.slice('--transcript='.length);
    else if (a.startsWith('--transcript-path=')) out.transcriptPath = a.slice('--transcript-path='.length);
    else if (a === '--on-existing-audio') { out.onExistingAudio = nextValue(args, i, a); i += 1; }
    else if (a.startsWith('--on-existing-audio=')) out.onExistingAudio = a.slice('--on-existing-audio='.length);
    else if (a === '--start') { out.start = parseNumber(nextValue(args, i, a), a); i += 1; }
    else if (a.startsWith('--start=')) out.start = parseNumber(a.slice('--start='.length), '--start');
    else if (a === '--duration') { out.duration = parseNumber(nextValue(args, i, a), a); i += 1; }
    else if (a.startsWith('--duration=')) out.duration = parseNumber(a.slice('--duration='.length), '--duration');
    else if (a === '--x') { out.x = parseNumber(nextValue(args, i, a), a); i += 1; }
    else if (a.startsWith('--x=')) out.x = parseNumber(a.slice('--x='.length), '--x');
    else if (a === '--y') { out.y = parseNumber(nextValue(args, i, a), a); i += 1; }
    else if (a.startsWith('--y=')) out.y = parseNumber(a.slice('--y='.length), '--y');
    else if (a === '--noise-db') { out.noiseDb = parseNumber(nextValue(args, i, a), a); i += 1; }
    else if (a.startsWith('--noise-db=')) out.noiseDb = parseNumber(a.slice('--noise-db='.length), '--noise-db');
    else if (a === '--min-silence-sec') { out.minSilenceSec = parseNumber(nextValue(args, i, a), a); i += 1; }
    else if (a.startsWith('--min-silence-sec=')) out.minSilenceSec = parseNumber(a.slice('--min-silence-sec='.length), '--min-silence-sec');
    else if (a === '--pad-sec') { out.padSec = parseNumber(nextValue(args, i, a), a); i += 1; }
    else if (a.startsWith('--pad-sec=')) out.padSec = parseNumber(a.slice('--pad-sec='.length), '--pad-sec');
    else if (a === '--min-keep-sec') { out.minKeepSec = parseNumber(nextValue(args, i, a), a); i += 1; }
    else if (a.startsWith('--min-keep-sec=')) out.minKeepSec = parseNumber(a.slice('--min-keep-sec='.length), '--min-keep-sec');
    else if (a === '--fillers') { out.fillers.push(...parseList(nextValue(args, i, a), a)); i += 1; }
    else if (a.startsWith('--fillers=')) out.fillers.push(...parseList(a.slice('--fillers='.length), '--fillers'));
    else if (!out.op) out.op = a;
    else if (!out.inputPath) out.inputPath = a;
    else fail('E_ARGS', `unexpected argument: ${a}`);
  }
  return out;
}

function resolvePath(raw) {
  return path.resolve(process.cwd(), String(raw || '').trim());
}

function inputFile(raw, label) {
  const abs = resolvePath(raw);
  const st = fs.existsSync(abs) ? fs.statSync(abs) : null;
  if (!st || !st.isFile()) fail('E_INPUT', `${label} is not a file: ${abs}`, { path: abs });
  return abs;
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

async function outputFile(raw) {
  if (!raw) fail('E_ARGS', '--output is required for this op');
  const requested = resolvePath(raw);
  const { finalPath, renamed } = uniquifyOutputPath(requested);
  return { requested, finalPath, renamed };
}

function normalizeAudioSegments(raw) {
  if (!raw) return undefined;
  if (!Array.isArray(raw)) fail('E_ARGS', '--audio-segments must be a JSON array');
  return raw.map((entry, index) => {
    const item = entry && typeof entry === 'object' && !Array.isArray(entry) ? entry : {};
    const rawPath = item.audio_path || item.audioPath || item.path;
    if (!rawPath) fail('E_ARGS', `audio_segments[${index}] requires audio_path`);
    const segment = { audioAbsPath: inputFile(rawPath, `audio_segments[${index}].audio_path`) };
    if (typeof item.start === 'number') segment.startSec = item.start;
    if (typeof item.start_sec === 'number') segment.startSec = item.start_sec;
    if (typeof item.startSec === 'number') segment.startSec = item.startSec;
    return segment;
  });
}

function normalizeEditFailure(opts, result) {
  const message = String(result && result.message || '');
  if (
    opts.op === 'burnsubs'
    && /No such filter:\s*'subtitles'|No such filter:\s*"subtitles"|not found.*subtitles|subtitles.*not found/i.test(message)
  ) {
    return {
      ...result,
      errorCode: 'E_EDIT_BURNSUBS_UNSUPPORTED',
      message: 'burnsubs is unavailable because the active ffmpeg runtime does not provide the subtitles filter. Do not hand-write a ffmpeg fallback; report this runtime blocker or use a packaged runtime with subtitle filter support.',
    };
  }
  return result;
}

module.exports = async function editVideoScript({ args }) {
  const opts = parseArgs(args || []);
  if (opts.help) return help();
  if (!OPS.has(opts.op)) fail('E_ARGS', `op must be one of: ${[...OPS].join(', ')}`);

  const params = { op: opts.op };

  if (opts.op === 'concat') {
    if (opts.inputPaths.length < 2) fail('E_ARGS', 'concat requires --inputs with at least 2 files');
    params.inputAbsPaths = opts.inputPaths.map((p) => inputFile(p, 'input_paths entry'));
  } else {
    if (!opts.inputPath) fail('E_ARGS', `${opts.op} requires --input`);
    params.inputAbsPath = inputFile(opts.inputPath, 'input');
  }

  if (opts.op === 'burnsubs') {
    if (!opts.subtitlesPath) fail('E_ARGS', 'burnsubs requires --subtitles');
    params.subtitlesAbsPath = inputFile(opts.subtitlesPath, 'subtitles');
  }
  if (opts.op === 'overlay') {
    if (!opts.overlayPath) fail('E_ARGS', 'overlay requires --overlay');
    params.overlayAbsPath = inputFile(opts.overlayPath, 'overlay');
  }
  if (opts.op === 'remove_fillers') {
    if (!opts.transcriptPath) fail('E_ARGS', 'remove_fillers requires --transcript');
    params.transcriptAbsPath = inputFile(opts.transcriptPath, 'transcript');
  }
  if (opts.op === 'mix') {
    const segments = normalizeAudioSegments(opts.audioSegments);
    if (segments && segments.length) params.audioSegments = segments;
    else {
      if (!opts.audioPath) fail('E_ARGS', 'mix requires --audio or --audio-segments');
      params.audioAbsPath = inputFile(opts.audioPath, 'audio');
    }
    if (['reject', 'mix', 'replace'].includes(opts.onExistingAudio)) params.onExistingAudio = opts.onExistingAudio;
  }

  if (OUTPUT_OPS.has(opts.op)) {
    const out = await outputFile(opts.outputPath);
    params.outputAbsPath = out.finalPath;
    params.requestedOutputAbsPath = out.requested;
    params.outputRenamed = out.renamed;
  }

  for (const [from, to] of [
    ['start', 'start'],
    ['duration', 'duration'],
    ['x', 'x'],
    ['y', 'y'],
    ['noiseDb', 'noiseDb'],
    ['minSilenceSec', 'minSilenceSec'],
    ['padSec', 'padSec'],
    ['minKeepSec', 'minKeepSec'],
  ]) {
    if (typeof opts[from] === 'number') params[to] = opts[from];
  }
  if (opts.fillers.length) params.fillers = opts.fillers;

  const { requestedOutputAbsPath, outputRenamed, ...editParams } = params;
  const { editVideo } = require('./lib/video_edit_core.cjs');
  const result = normalizeEditFailure(opts, await editVideo(editParams));
  if (result.ok === false) fail(result.errorCode, result.message);

  const payload = { ok: true, op: opts.op, ...result };
  if (opts.op === 'probe') payload.text = 'probe metadata is available in probe.';
  else if (opts.op === 'loudness') payload.text = 'loudness measurement is available in loudness.';
  else if (result.path) {
    payload.media = `chat-media://local/${result.path}`;
    payload.text = `${opts.op} wrote ${result.path}${outputRenamed ? ` (renamed from ${requestedOutputAbsPath})` : ''}.`;
  }
  return payload;
};
