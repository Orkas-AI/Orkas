'use strict';

// Offline project mechanics. The host supplies all executable/model paths.
// No package installation, network client, provider credential or shell command.
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { createReadStream } = require('node:fs');
const processing = require('./processing.js');
const transfer = require('./transfer.js');
const composition = require('./composition.js');
const wordEdits = require('./word-edits.js');
const OPERATIONS = ['preflight', 'probe', 'transcribe', 'status', 'begin', 'prepare-record', 'record', 'render', 'extract', 'convert'];
const USAGE = 'Use the host command template: voice-project audio -- <operation> "<absolute-request.json>". Help: voice-project audio -- --help. Preflight: voice-project audio -- preflight.';

function fail(code, message) { throw Object.assign(new Error(message), { code }); }
function num(value, fallback, min, max) {
  const n = value === undefined ? fallback : value;
  if (typeof n !== 'number' || !Number.isFinite(n) || n < min || n > max) fail('E_INPUT', `Expected a number between ${min} and ${max}.`);
  return n;
}
function inside(root, file) {
  const rel = path.relative(root, file);
  return rel === '' || (!rel.startsWith(`..${path.sep}`) && rel !== '..' && !path.isAbsolute(rel));
}
async function local(root, name, output = false) {
  if (typeof name !== 'string' || !name || name.includes('\0')) fail('E_PATH', 'A project-relative file path is required.');
  const file = path.resolve(root, name);
  let ancestor = file;
  while (true) {
    try {
      const real = await fs.realpath(ancestor);
      // Compare physical paths so directory aliases also produce reusable state paths.
      const resolved = path.resolve(real, path.relative(ancestor, file));
      if (!inside(root, real) || !inside(root, resolved) || resolved === root) fail('E_PATH', 'A path resolves outside the audio project.');
      return resolved;
    } catch (err) {
      if (err.code !== 'ENOENT' || !output) throw err;
      ancestor = path.dirname(ancestor);
    }
  }
}
async function source(root, name, field = 'input_path') {
  try { return await local(root, name); }
  catch (err) {
    if (err.code === 'ENOENT') fail('E_SOURCE_NOT_FOUND', `${field} does not name an existing project file. Check that field against the source files; prefer a project-relative path.`);
    throw err;
  }
}
async function json(file, withIdentity = false) {
  const maxBytes = 4 * 1024 * 1024;
  if ((await fs.stat(file)).size > maxBytes) fail('E_SIZE', 'Project metadata exceeds 4 MB.');
  const bytes = await fs.readFile(file);
  if (bytes.length > maxBytes) fail('E_SIZE', 'Project metadata exceeds 4 MB.');
  const data = JSON.parse(bytes.toString('utf8'));
  // Parse and attest one revision, including when a legal replacement arrives
  // after the read. Word editing rechecks this identity before publication.
  return withIdentity ? { data, sha256: crypto.createHash('sha256').update(bytes).digest('hex') } : data;
}
async function atomic(file, value) {
  const temp = `${file}.${crypto.randomUUID()}.tmp`;
  try { await fs.writeFile(temp, JSON.stringify(value, null, 2) + '\n', { flag: 'wx' }); await fs.rename(temp, file); }
  finally { await fs.rm(temp, { force: true }); }
}
async function digest(file, signal) {
  const hash = crypto.createHash('sha256');
  for await (const chunk of createReadStream(file)) { signal?.throwIfAborted(); hash.update(chunk); }
  return hash.digest('hex');
}
async function declareAudioText(dir, files) {
  await atomic(path.join(dir, '.orkas-output-types.json'), {
    schema_version: 1,
    outputs: await Promise.all(files.map(async file => ({
      path: file, content_type: 'audio-text', sha256: await digest(path.join(dir, file)),
    }))),
  });
}
async function binary(env) {
  const file = process.env[env];
  if (!file || !path.isAbsolute(file)) fail('E_RUNTIME_MISSING', `Bundled ${env.replace('ORKAS_', '')} is unavailable. Repair or update the application; do not download dependencies during this task.`);
  await fs.access(file);
  return file;
}
function run(executable, args, signal, timeout = 30 * 60 * 1000) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(Object.assign(new Error('Audio operation cancelled.'), { code: 'E_CANCELLED' }));
    const child = spawn(executable, args, { shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '', overflow = false, timedOut = false;
    const stop = () => child.kill('SIGKILL');
    const timer = setTimeout(() => { timedOut = true; stop(); }, timeout);
    signal?.addEventListener('abort', stop, { once: true });
    child.stdout.on('data', data => {
      if (stdout.length + data.length > 4 * 1024 * 1024) { overflow = true; stop(); }
      else stdout += data.toString();
    });
    child.stderr.on('data', data => { stderr = (stderr + data.toString()).slice(-8192); });
    child.on('error', err => { clearTimeout(timer); signal?.removeEventListener('abort', stop); reject(err); });
    child.on('close', code => {
      clearTimeout(timer); signal?.removeEventListener('abort', stop);
      if (signal?.aborted || timedOut || overflow || code !== 0) {
        // Raw codec/ASR diagnostics include private paths and transcript text.
        reject(Object.assign(new Error(signal?.aborted ? 'Audio operation cancelled.' : timedOut ? 'Audio operation timed out; completed files were preserved.' : 'Audio processing failed; check the input and bundled runtime.'), {
          code: signal?.aborted ? 'E_CANCELLED' : timedOut ? 'E_TIMEOUT' : 'E_PROCESS', exit_code: code,
        }));
      } else resolve({ stdout, diagnostic_bytes: Buffer.byteLength(stderr) });
    });
  });
}
async function probe(file, signal, restricted = false) {
  const result = await run(await binary('ORKAS_BUNDLED_FFPROBE'), ['-v', 'error', ...(restricted ? composition.MEDIA_INPUT : []), '-show_entries', 'format=duration:stream=index,codec_type,codec_name,sample_rate,channels,duration:stream_tags=language', '-of', 'json', file], signal, 60000);
  const data = JSON.parse(result.stdout);
  const audio = data.streams?.find(stream => stream.codec_type === 'audio');
  const duration = Number(data.format?.duration);
  if (!audio || !(duration > 0) || !Number.isFinite(duration)) fail('E_NO_AUDIO', 'The file has no readable audio with a finite duration.');
  return { duration_sec: duration, sample_rate: Number(audio.sample_rate), channels: Number(audio.channels),
    audio_streams: data.streams.filter(stream => stream.codec_type === 'audio').map((stream, audio_stream) => ({
      audio_stream, codec: stream.codec_name, sample_rate: Number(stream.sample_rate), channels: Number(stream.channels), ...(stream.tags?.language ? { language: stream.tags.language } : {}),
    })) };
}
function validate(plan) {
  if (![1, 2, 3].includes(plan.schema_version) || !Array.isArray(plan.segments) || plan.segments.length > 200) fail('E_PLAN', 'Use schema_version 1, 2 or 3 and at most 200 segments; split longer work into chapters.');
  if (plan.processing !== undefined) {
    if (plan.schema_version < 2) fail('E_PLAN', 'Processing steps require schema_version 2 or 3; preserve the original project when upgrading.');
    processing.settings(plan.processing);
  }
  if (plan.export !== undefined) transfer.settings(plan.export);
  const ids = new Set();
  for (const s of plan.segments) {
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(s.id || '') || ids.has(s.id)) fail('E_PLAN', 'Each segment needs a unique alphanumeric id.');
    ids.add(s.id);
    if ((typeof s.text === 'string') === (typeof s.path === 'string')) fail('E_PLAN', 'Each segment needs either speech text or a local audio path.');
    if (typeof s.text === 'string') {
      const role = plan.roles?.[s.role];
      if (!s.text.trim() || s.text.length > 1500 || !role?.route_ref || !role?.voice_ref || !role?.language) fail('E_PLAN', 'Speech needs 1–1500 characters and a role with capability-listed route_ref, voice_ref and language.');
      num(role.speed, 1, 0.5, 2);
      const take = num(s.take, 0, 0, 10000);
      if (!Number.isInteger(take)) fail('E_PLAN', 'take must be an integer.');
    }
    num(s.speed, 1, 0.5, 2); num(s.volume, 1, 0, 4); num(s.gap_after_sec, 0, 0, 60);
    num(s.start_sec, 0, 0, 14400);
    if (s.end_sec !== undefined && num(s.end_sec, 0, 0, 14400) <= (s.start_sec ?? 0)) fail('E_PLAN', 'end_sec must be after start_sec.');
    num(s.fade_in_sec, 0, 0, 60); num(s.fade_out_sec, 0, 0, 60);
    if (s.denoise !== undefined && typeof s.denoise !== 'boolean') fail('E_PLAN', 'denoise must be boolean.');
    if (s.word_edit !== undefined) {
      if (plan.schema_version !== 3 || typeof s.path !== 'string') fail('E_WORD_EDIT', 'Word edits require schema 3 and a recorded source segment.');
      wordEdits.settings(s.word_edit);
    }
  }
  if (plan.music) { if (typeof plan.music.path !== 'string') fail('E_PLAN', 'Music needs a local path.'); num(plan.music.volume, 0.15, 0, 2); transfer.duck(plan.music.duck); }
  composition.validate(plan);
  return plan;
}
function speechIdentity(plan, s) {
  const role = plan.roles[s.role];
  return { text: s.text, route_ref: role.route_ref, voice_ref: role.voice_ref, language: role.language, speed: role.speed ?? 1, format: 'wav' };
}
function keyFor(plan, s) { return crypto.createHash('sha256').update(JSON.stringify({ ...speechIdentity(plan, s), take: s.take ?? 0 })).digest('hex'); }
async function stateFor(root) {
  const file = await local(root, '.voice-state.json', true);
  try {
    const state = await json(file);
    if (state.schema_version !== 1 || !state.attempts || typeof state.attempts !== 'object') fail('E_STATE', 'Unsupported audio state; preserve it and inspect before proceeding.');
    return state;
  } catch (err) { if (err.code !== 'ENOENT') throw err; return { schema_version: 1, attempts: {} }; }
}
async function rowsFor(root, plan, state, signal) {
  const rows = [];
  const probes = new Map(), digests = new Map();
  const measured = async file => {
    if (!probes.has(file)) probes.set(file, await probe(file, signal, plan.schema_version === 3));
    return probes.get(file);
  };
  for (const s of plan.segments) {
    if (s.path !== undefined) {
      const file = await local(root, s.path);
      rows.push({ id: s.id, status: 'ready', path: s.path, ...await measured(file) });
      continue;
    }
    const key = keyFor(plan, s), record = state.attempts[key];
    let status = record?.status || 'pending';
    let meta = {};
    if (status === 'ready') {
      try {
        const file = await local(root, record.path);
        if (!digests.has(file)) digests.set(file, await digest(file));
        if (digests.get(file) !== record.sha256) status = 'stale';
        else meta = await measured(file);
      }
      catch { status = 'stale'; }
    }
    rows.push({ id: s.id, key, status, ...(record ? { path: record.path } : {}), ...meta });
  }
  return rows;
}
function stamp(seconds) {
  const ms = Math.round(seconds * 1000);
  return `${String(Math.floor(ms / 3600000)).padStart(2, '0')}:${String(Math.floor(ms / 60000) % 60).padStart(2, '0')}:${String(Math.floor(ms / 1000) % 60).padStart(2, '0')},${String(ms % 1000).padStart(3, '0')}`;
}
function subtitles(segments) { return segments.map((s, i) => `${i + 1}\n${stamp(s.start_sec)} --> ${stamp(s.end_sec)}\n${s.text.trim()}\n`).join('\n'); }
function whisperSegments(data) {
  if (!data || !Array.isArray(data.transcription)) fail('E_TRANSCRIPT', 'Whisper returned no segment array.');
  if (data.transcription.some(s => !s || typeof s !== 'object' || typeof s.text !== 'string')) fail('E_TRANSCRIPT', 'Whisper returned invalid segment timing.');
  const seconds = value => typeof value === 'number' || typeof value === 'string' && value.trim() ? Number(value) / 1000 : NaN;
  return data.transcription.filter(s => typeof s.text === 'string' && s.text.trim()).map(s => {
    const start = seconds(s.offsets?.from), end = seconds(s.offsets?.to);
    if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end < start) fail('E_TRANSCRIPT', 'Whisper returned invalid segment timing.');
    return { start_sec: start, end_sec: end, text: s.text.trim() };
  });
}
function segmentTiming(segments, duration) {
  let previous = 0;
  for (const s of segments) {
    // Match the existing word-timing millisecond precision allowance.
    if (s.start_sec < previous || s.end_sec <= s.start_sec || s.end_sec > duration + .001) fail('E_TRANSCRIPT', 'Whisper returned invalid segment timing.');
    previous = s.end_sec;
  }
  return segments;
}
async function transcribe(root, input, signal) {
  if (input.granularity !== undefined && !['segment', 'word'].includes(input.granularity)) fail('E_INPUT', 'Choose segment or word transcription granularity.');
  const sourceFile = await source(root, input.input_path);
  if (input.granularity === 'word') {
    const info = await fs.stat(sourceFile);
    if (!info.isFile() || info.size > 8 * 1024 ** 3) fail('E_SIZE', 'Use a regular recording up to 8 GiB for word transcription.');
  }
  const meta = await probe(sourceFile, signal, input.granularity === 'word');
  if (input.granularity === 'word' && meta.audio_streams.length !== 1) fail('E_AUDIO_TRACK', 'Extract the desired audio stream before word transcription.');
  if (input.granularity === 'word' && meta.duration_sec > 14400) fail('E_DURATION', 'Split word transcription into chapters up to four hours.');
  const sourceHash = await digest(sourceFile, signal);
  const ffmpeg = await binary('ORKAS_BUNDLED_FFMPEG'), whisper = await binary('ORKAS_WHISPER_CPP'), model = await binary('ORKAS_WHISPER_MODEL');
  const dir = await fs.mkdtemp(path.join(root, 'transcript-'));
  try {
    await run(ffmpeg, ['-v', 'error', '-nostdin', ...(input.granularity === 'word' ? composition.MEDIA_INPUT : []), '-i', sourceFile, '-vn', '-ac', '1', '-ar', '16000', path.join(dir, 'input.wav')], signal);
    // Bind the decoded input before recognition. Later source edits belong to
    // another version and must neither relabel nor discard this attempt.
    if (await digest(sourceFile, signal) !== sourceHash) fail('E_TRANSCRIPT_STALE', 'The recording changed during transcription; transcribe the preserved current source.');
    // Container duration can follow a longer video track. Validate against the
    // exact decoded audio sent to recognition, not the container's end time.
    const decoded = await probe(path.join(dir, 'input.wav'), signal);
    await run(whisper, ['-m', model, '-f', path.join(dir, 'input.wav'), '-l', input.language || 'auto', '-oj', '-of', path.join(dir, 'raw'), '-np',
      ...(input.granularity === 'word' ? ['-ml', '1'] : []),
      // The bundled Intel macOS Metal backend can return corrupt recognition.
      ...(process.platform === 'darwin' && process.arch === 'x64' ? ['-ng'] : [])], signal);
    const raw = await json(path.join(dir, 'raw.json'));
    let segments;
    try {
      segments = whisperSegments(raw);
      segments = input.granularity === 'word'
        ? wordEdits.fromSegments(segments, decoded.duration_sec)
        : segmentTiming(segments, decoded.duration_sec);
    } catch (err) {
      if (!['E_TRANSCRIPT', 'E_WORD_EDIT'].includes(err.code) || !Array.isArray(raw.transcription)) throw err;
      const text = raw.transcription.filter(s => s && typeof s.text === 'string' && s.text.trim()).map(s => s.text.trim()).join('\n');
      if (!text) throw err;
      // Preserve wording without publishing an invalid timed JSON/SRT or
      // silently trimming words, reordering cues, or replaying recognition.
      await fs.writeFile(path.join(dir, 'transcript.txt'), text + '\n');
      await declareAudioText(dir, ['transcript.txt']);
      await fs.rm(path.join(dir, 'input.wav')); await fs.rm(path.join(dir, 'raw.json'));
      signal?.throwIfAborted();
      return { ok: false, code: err.code, message: err.message, files: [path.relative(root, path.join(dir, 'transcript.txt'))] };
    }
    const text = segments.map(s => s.text).join('\n');
    await fs.writeFile(path.join(dir, 'transcript.txt'), text + '\n');
    await fs.writeFile(path.join(dir, 'transcript.srt'), subtitles(segments));
    await atomic(path.join(dir, 'transcript.json'), { schema_version: 1, segments, text, source_sha256: sourceHash,
      ...(input.granularity === 'word' ? { granularity: 'word', timing: 'estimated', unit: 'word-or-subword' } : {}) });
    await declareAudioText(dir, ['transcript.txt']);
    await fs.rm(path.join(dir, 'input.wav')); await fs.rm(path.join(dir, 'raw.json'));
    return { ok: true, segments: segments.length, files: ['transcript.txt', 'transcript.srt', 'transcript.json'].map(f => path.relative(root, path.join(dir, f))), empty: segments.length === 0 };
  } catch (err) { await fs.rm(dir, { recursive: true, force: true }); throw err; }
}
// Only independent clip preparation runs concurrently. A pair owns its children
// until both settle, including after one fails; cleanup/lock release cannot race
// a sibling still writing. Batches also bound speculative work at chapter limits.
async function preparePair(indices, prepare, signal) {
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) abort();
  let failure;
  try {
    const results = await Promise.all(indices.map(async index => {
      try { return await prepare(index, controller.signal); }
      catch (err) { failure ??= err; controller.abort(); }
    }));
    if (failure) throw failure;
    return results;
  } finally { signal?.removeEventListener('abort', abort); }
}
async function render(root, plan, state, input, signal) {
  if (!plan.segments.length) fail('E_PLAN', 'Add at least one segment before rendering.');
  if (input.export !== undefined && (!input.export || typeof input.export !== 'object' || Array.isArray(input.export))) fail('E_FORMAT', 'Export settings must be an object.');
  const rows = await rowsFor(root, plan, state, signal);
  if (rows.some(r => r.status !== 'ready')) fail('E_NOT_READY', 'Some speech segments are pending, uncertain or stale. Inspect status and preserve completed recordings.');
  const settings = { ...plan.export, ...input.export };
  const [source] = rows;
  if (settings.channels === undefined && rows.length === 1 && typeof plan.segments[0].path === 'string'
    && !plan.music && !plan.tracks?.length && source.audio_streams.length === 1 && [1, 2].includes(source.channels)) {
    settings.channels = source.channels;
  }
  if (settings.normalize_loudness === undefined && settings.target_lufs === undefined && settings.true_peak_db === undefined) {
    settings.normalize_loudness = plan.segments.every(s => typeof s.text === 'string') && !plan.music && !plan.tracks?.length;
  }
  const options = transfer.settings(settings, true, input.format ?? input.export?.format ?? plan.export?.format);
  const format = options.format;
  // Keep one channel layout throughout the render. An implicit mono -> stereo
  // -> mono round trip attenuates the retained samples even at unity gain.
  const channels = options.channels ?? 2;
  const ffmpeg = await binary('ORKAS_BUNDLED_FFMPEG');
  const newMix = composition.enabled(plan);
  // A plain PCM cut with matching export properties needs no format round trip.
  // Resampling through 48 kHz or narrowing to 16 bits alters retained samples.
  const sampleRate = options.sample_rate ?? 48000;
  const pcmCodec = `pcm_s${options.bit_depth ?? 16}le`;
  const preservePcm = format === 'wav' && !newMix && !plan.music && !plan.processing?.length && !options.normalize_loudness
    && rows.every((row, i) => {
      const segment = plan.segments[i];
      return typeof segment.path === 'string' && row.audio_streams.length === 1
        && row.audio_streams[0].codec === pcmCodec && row.sample_rate === sampleRate && row.channels === channels
        && (segment.speed ?? 1) === 1 && (segment.volume ?? 1) === 1 && !segment.word_edit && !segment.denoise
        && !segment.fade_in_sec && !segment.fade_out_sec && !segment.gap_after_sec;
    });
  const clipRate = preservePcm ? sampleRate : 48000;
  const clipCodec = preservePcm ? pcmCodec : 'pcm_s16le';
  const music = plan.music && !newMix ? await local(root, plan.music.path) : undefined;
  if (music) await probe(music, signal);
  const temp = await fs.mkdtemp(path.join(root, '.voice-render-'));
  const cues = [], generated = [], wordReceipts = []; let cursor = 0;
  try {
    const prepare = async (i, current) => {
      const s = plan.segments[i]; let source = await local(root, rows[i].path);
      const meta = rows[i];
      let cut;
      let start = s.start_sec ?? 0, end = s.end_sec ?? meta.duration_sec;
      if (start >= meta.duration_sec || end > meta.duration_sec + 0.05) fail('E_TRIM', 'A trim lies outside its source audio.');
      if (s.word_edit) {
        if (meta.audio_streams.length !== 1) fail('E_AUDIO_TRACK', 'Extract the desired audio stream before word editing.');
        cut = await wordEdits.cut(root, temp, i, source, s, meta.duration_sec, current, { local, json, digest, run, binary, channels });
        source = cut.path; start = 0; end = cut.duration;
      }
      const speed = s.speed ?? 1, duration = (end - start) / speed;
      if (duration <= 0 || cursor + duration + (s.gap_after_sec ?? 0) > 14400) fail('E_DURATION', 'Use positive segments and at most four hours per chapter.');
      const filters = [`atrim=start=${start}:end=${end}`, 'asetpts=PTS-STARTPTS'];
      // Even at unity, atempo can discard a final partial analysis window.
      // Preserve unretimed recordings sample-for-sample through this stage.
      if (speed !== 1) filters.push(`atempo=${speed}`);
      if (!preservePcm) filters.push(`volume=${s.volume ?? 1}`);
      if (s.denoise) filters.push('afftdn');
      if (s.fade_in_sec) filters.push(`afade=t=in:d=${Math.min(duration, s.fade_in_sec)}`);
      if (s.fade_out_sec) { const fade = Math.min(duration, s.fade_out_sec); filters.push(`afade=t=out:st=${Math.max(0, duration - fade)}:d=${fade}`); }
      if (s.gap_after_sec) filters.push(`apad=pad_dur=${s.gap_after_sec}`);
      const clip = path.join(temp, `${i}.wav`);
      await run(ffmpeg, ['-v', 'error', '-nostdin', ...(plan.schema_version === 3 ? composition.MEDIA_INPUT : []), '-i', source, '-vn', '-af', filters.join(','), '-ar', String(clipRate), '-ac', String(channels), '-c:a', clipCodec, clip], current);
      return { duration, measured: await probe(clip, current), cut };
    };
    for (let offset = 0; offset < rows.length; offset += 2) {
      const indices = rows.slice(offset, offset + 2).map((_, i) => offset + i);
      const prepared = await preparePair(indices, prepare, signal);
      for (const [index, result] of prepared.entries()) {
        const s = plan.segments[indices[index]];
        if (cursor + result.duration + (s.gap_after_sec ?? 0) > 14400) fail('E_DURATION', 'Use positive segments and at most four hours per chapter.');
        if (result.cut) { generated.push(result.cut.name); wordReceipts.push(result.cut.receipt); }
        if (s.text) cues.push({ start_sec: cursor, end_sec: cursor + result.duration, text: s.text });
        cursor += result.measured.duration_sec;
      }
    }
    await fs.writeFile(path.join(temp, 'concat.txt'), rows.map((_, i) => `file '${i}.wav'`).join('\n'));
    await run(ffmpeg, ['-v', 'error', '-nostdin', '-f', 'concat', '-safe', '1', '-i', path.join(temp, 'concat.txt'), '-c:a', 'copy', path.join(temp, 'joined.wav')], signal);
    const processed = plan.processing?.length ? await processing.processAudio(root, path.join(temp, 'joined.wav'), plan.processing, signal, { run, binary, digest, probe, local, json, atomic }) : undefined;
    if (processed) cursor = (await probe(processed.path, signal)).duration_sec;
    const mixed = newMix ? await composition.compose(root, temp, processed?.path || path.join(temp, 'joined.wav'), cursor, plan, signal, { local, probe, binary, run, digest, channels }) : undefined;
    if (mixed) { cursor = mixed.duration; generated.push(...mixed.generated); }
    const args = ['-v', 'error', '-nostdin', '-i', mixed?.path || processed?.path || path.join(temp, 'joined.wav')];
    if (music) {
      // Drain the looping source separately. Mixing a looping mono input with
      // stereo narration can stall FFmpeg's filter graph even with input -t.
      const musicClip = path.join(temp, 'music.wav');
      await run(ffmpeg, ['-v', 'error', '-nostdin', '-stream_loop', '-1', '-i', music,
        '-t', String(cursor), '-ar', '48000', '-ac', String(channels), '-c:a', 'pcm_s16le', musicClip], signal);
      const duck = transfer.duck(plan.music.duck);
      // Align the split source and music before either branch can reach EOF.
      // Trim only the bounded final-frame padding after mixing.
      const graph = duck
        ? `[0:a]asetnsamples=n=1024:p=1,asplit=2[voice][key];[1:a]volume=${plan.music.volume ?? 0.15},asetnsamples=n=1024:p=1[music];[music][key]sidechaincompress=threshold=${10 ** (duck.threshold_db / 20)}:ratio=${duck.ratio}:attack=${duck.attack_ms}:release=${duck.release_ms}[background];[voice][background]amix=inputs=2:duration=first:normalize=0,atrim=duration=${cursor}`
        : `[1:a]volume=${plan.music.volume ?? 0.15}[music];[0:a][music]amix=inputs=2:duration=first:normalize=0`;
      args.push('-i', musicClip, '-filter_complex', `${graph},${transfer.loudness(options)}[out]`, '-map', '[out]');
    } else args.push('-af', transfer.loudness(options));
    args.push(...transfer.encoding(options));
    args.push(path.join(temp, `audio.${format}`));
    await run(ffmpeg, args, signal);
    const meta = await probe(path.join(temp, `audio.${format}`), signal);
    if (Math.abs(meta.duration_sec - cursor) > 0.15) fail('E_EXPORT', 'Export duration does not match the assembled segments.');
    await run(ffmpeg, ['-v', 'error', '-nostdin', '-i', path.join(temp, `audio.${format}`), '-f', 'null', '-'], signal);
    const completeCaptions = !processed?.timingChanged && plan.segments.every(s => s.text && !s.start_sec && s.end_sec === undefined);
    if (cues.length) {
      await fs.writeFile(path.join(temp, 'script.txt'), cues.map(c => c.text).join('\n') + '\n');
    }
    if (completeCaptions) {
      await fs.writeFile(path.join(temp, 'captions.srt'), subtitles(cues));
    }
    await atomic(path.join(temp, 'plan-snapshot.json'), plan);
    await atomic(path.join(temp, 'receipt.json'), { schema_version: 1, ...meta, cues, captions_complete: completeCaptions, export: options,
      ...(mixed ? { tracks: mixed.tracks } : {}), ...(wordReceipts.length ? { word_edits: wordReceipts } : {}),
      ...(processed ? { processing: processed.processing } : {}), sha256: await digest(path.join(temp, `audio.${format}`)), verification: 'decoded; segment duration checked; perceptual quality not verified' });
    if (cues.length) await declareAudioText(temp, ['script.txt']);
    const output = path.join(root, `export-${crypto.randomUUID()}`);
    // Publish the complete candidate directory atomically, preserving every prior export.
    for (const name of ['joined.wav', 'concat.txt', ...generated, ...(music ? ['music.wav'] : []), ...rows.map((_, i) => `${i}.wav`)]) await fs.rm(path.join(temp, name));
    signal?.throwIfAborted();
    await fs.rename(temp, output);
    return { ok: true, ...meta, captions_complete: completeCaptions, files: [`audio.${format}`, ...(cues.length ? ['script.txt'] : []), ...(completeCaptions ? ['captions.srt'] : []), 'receipt.json', 'plan-snapshot.json'].map(f => path.relative(root, path.join(output, f))) };
  } finally { await fs.rm(temp, { recursive: true, force: true }); }
}
async function withAudioDeadline(parent, work, message) {
  const controller = new AbortController(); let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, 30 * 60 * 1000);
  timer.unref?.();
  const abort = () => controller.abort();
  parent?.addEventListener('abort', abort, { once: true });
  if (parent?.aborted) abort();
  try { return await work(controller.signal); }
  catch (err) {
    if (parent?.aborted) fail('E_CANCELLED', 'Audio operation cancelled.');
    if (timedOut) fail('E_TIMEOUT', message);
    throw err;
  } finally { clearTimeout(timer); parent?.removeEventListener('abort', abort); }
}
function withAbsoluteFiles(root, result) {
  return { ...result, absolute_files: result.files.map(file => path.join(root, file)) };
}
async function execute(operation, request, signal) {
  if (!OPERATIONS.includes(operation)) fail('E_OPERATION', USAGE);
  if (operation === 'preflight') {
    const ready = {};
    for (const env of ['ORKAS_BUNDLED_FFMPEG', 'ORKAS_BUNDLED_FFPROBE', 'ORKAS_WHISPER_CPP', 'ORKAS_WHISPER_MODEL']) {
      try { await binary(env); ready[env] = true; } catch { ready[env] = false; }
    }
    const codecs = ready.ORKAS_BUNDLED_FFMPEG && ready.ORKAS_BUNDLED_FFPROBE;
    return { ok: codecs, ready, capabilities: { editing: codecs, processing: codecs, transcription: codecs && ready.ORKAS_WHISPER_CPP && ready.ORKAS_WHISPER_MODEL } };
  }
  if (!request || typeof request !== 'object' || Array.isArray(request)
    || typeof request.project !== 'string' || !request.project.trim()) {
    fail('E_INPUT', 'The request JSON must contain a non-empty project file path.');
  }
  const projectFile = path.resolve(request.project);
  const root = await fs.realpath(path.dirname(projectFile));
  const projectPath = await local(root, path.basename(projectFile));
  const plan = validate(await json(projectPath));
  if (operation === 'probe') return { ok: true, ...await probe(await source(root, request.input_path), signal) };
  if (operation === 'transcribe') {
    const result = await (request.granularity === 'word'
      ? withAudioDeadline(signal, current => transcribe(root, request, current), 'Word transcription timed out; the original recording was preserved.')
      : transcribe(root, request, signal));
    return withAbsoluteFiles(root, result);
  }
  const lockPath = await local(root, '.voice-lock', true);
  let lock;
  try { lock = await fs.open(lockPath, 'wx'); } catch (err) { if (err.code === 'EEXIST') fail('E_BUSY', 'Audio project is busy. After a crash, verify no task is active before removing .voice-lock.'); throw err; }
  try {
    if (operation === 'extract' || operation === 'convert') {
      if (signal?.aborted) fail('E_CANCELLED', 'Audio operation cancelled.');
      try {
        const result = await transfer.transfer(root, request, operation, signal, { local: source, run, binary, digest, atomic });
        return withAbsoluteFiles(root, result);
      }
      catch (err) { if (signal?.aborted) fail('E_CANCELLED', 'Audio operation cancelled.'); throw err; }
    }
    const state = await stateFor(root);
    if (operation === 'status') return { ok: true, segments: await rowsFor(root, plan, state, signal) };
    if (operation === 'render') {
      const result = await (plan.schema_version === 3
        ? withAudioDeadline(signal, current => render(root, plan, state, request, current), 'Audio rendering timed out; sources and completed exports were preserved.')
        : render(root, plan, state, request, signal));
      return { ...withAbsoluteFiles(root, result), project_path: projectPath };
    }
    const s = plan.segments.find(segment => segment.id === request.segment_id && segment.text !== undefined);
    if (!s) fail('E_SEGMENT', 'Choose a speech segment id from this project.');
    const key = keyFor(plan, s);
    if (operation === 'prepare-record') {
      if (signal?.aborted) fail('E_CANCELLED', 'Audio operation cancelled.');
      const attempt = state.attempts[key];
      if (attempt?.status !== 'uncertain') fail('E_ATTEMPT_STATE', 'Prepare recovery only for an existing uncertain attempt in the current segment. Inspect status; preserve ready or stale recordings.');
      const file = await source(root, request.output_path ?? attempt.path, 'output_path');
      if (!(await fs.stat(file)).isFile()) fail('E_PATH', 'output_path must name a regular project file.');
      const prepared = { project: path.join(root, path.basename(projectFile)), segment_id: s.id, key, output_path: path.relative(root, file) };
      const bytes = JSON.stringify(prepared, null, 2) + '\n';
      const name = `record-${crypto.createHash('sha256').update(bytes).digest('hex').slice(0, 16)}.json`;
      const requestFile = await local(root, name, true);
      if (signal?.aborted) fail('E_CANCELLED', 'Audio operation cancelled.');
      // One immutable, bounded request per distinct preparation. Identical calls
      // reuse it; neither existing user files nor earlier requests are replaced.
      try { await fs.writeFile(requestFile, bytes, { flag: 'wx' }); }
      catch (err) {
        if (err.code !== 'EEXIST') throw err;
        const same = await json(requestFile).then(saved => JSON.stringify(saved) === JSON.stringify(prepared)).catch(() => false);
        if (!same) fail('E_REQUEST_CONFLICT', 'The prepared request file already exists with different content. Preserve it and inspect the conflict before preparing recovery.');
      }
      // Preparation is not verification or a state transition. record still
      // checks the current identity and probes/hashes the completed recording.
      return { ok: true, operation: 'record', request_file: requestFile };
    }
    if (operation === 'begin') {
      if (state.attempts[key]) fail('E_ATTEMPT_EXISTS', 'This speech already has an attempt. Reuse or recover its recording; do not automatically repeat a potentially billed request.');
      const output = `speech-${key}.wav`;
      await local(root, output, true);
      state.attempts[key] = { status: 'uncertain', path: output };
      await atomic(await local(root, '.voice-state.json', true), state);
      return { ok: true, key, request: { ...speechIdentity(plan, s), output_path: path.join(root, output) } };
    }
    if (operation === 'record') {
      if (!state.attempts[key] || request.key !== key) fail('E_STALE', 'Record only the current segment attempt; its speech settings may have changed.');
      const file = await local(root, request.output_path || state.attempts[key].path);
      const meta = await probe(file, signal);
      state.attempts[key] = { status: 'ready', path: path.relative(root, file), sha256: await digest(file), ...meta };
      await atomic(await local(root, '.voice-state.json', true), state);
      return { ok: true, key, ...meta };
    }
  } finally { await lock.close(); await fs.rm(lockPath, { force: true }); }
}
async function entry(args) {
  const abort = new AbortController();
  const cancel = () => abort.abort();
  process.once('SIGTERM', cancel); process.once('SIGINT', cancel);
  try {
    const [operation, requestFile] = args;
    if (args.length === 1 && operation === '--help'
      || args.length === 2 && OPERATIONS.includes(operation) && requestFile === '--help') {
      return { ok: true, usage: USAGE, operations: OPERATIONS,
        request: 'Write a workspace JSON request file before invoking the script. It must contain an absolute project path; operation-specific fields are documented in this Skill references/.',
        preflight: 'audio -- preflight checks bundled capabilities without a request file.' };
    }
    if (operation !== undefined && !OPERATIONS.includes(operation)) fail('E_OPERATION', USAGE);
    if (args.length !== (operation === 'preflight' ? 1 : 2) || !operation
      || operation !== 'preflight' && (typeof requestFile !== 'string' || !requestFile.trim())) fail('E_USAGE', USAGE);
    let request = {};
    if (requestFile) {
      try { request = await json(path.resolve(requestFile)); }
      catch (error) {
        if (error.code === 'ENOENT') fail('E_REQUEST', 'The request JSON file was not found. Write it with workspace file tools before invoking the operation.');
        if (error instanceof SyntaxError) fail('E_REQUEST', 'The request file must contain valid JSON. Correct it before invoking the operation.');
        throw error;
      }
    }
    return await execute(operation, request, abort.signal);
  } catch (err) {
    return { ok: false, code: err.code || 'E_AUDIO', message: /^E_[A-Z_]+$/.test(err.code || '') ? err.message : 'Audio operation failed. Check the project files and available disk space.' };
  } finally {
    process.removeListener('SIGTERM', cancel); process.removeListener('SIGINT', cancel);
  }
}
// The shared Skill runner loads .js modules through this default export.
module.exports = { execute, validate, keyFor, whisperSegments, subtitles, default: ({ args }) => entry(args) };
if (require.main === module) {
  entry(process.argv.slice(2)).then(result => {
    process.stdout.write(JSON.stringify(result) + '\n');
    if (!result.ok) process.exitCode = 1;
  });
}
