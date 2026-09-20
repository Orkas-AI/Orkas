'use strict';

// Offline project mechanics. The host supplies all executable/model paths.
// No package installation, network client, provider credential or shell command.
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { createReadStream } = require('node:fs');

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
async function json(file) {
  if ((await fs.stat(file)).size > 4 * 1024 * 1024) fail('E_SIZE', 'Project metadata exceeds 4 MB.');
  return JSON.parse(await fs.readFile(file, 'utf8'));
}
async function atomic(file, value) {
  const temp = `${file}.${crypto.randomUUID()}.tmp`;
  try { await fs.writeFile(temp, JSON.stringify(value, null, 2) + '\n', { flag: 'wx' }); await fs.rename(temp, file); }
  finally { await fs.rm(temp, { force: true }); }
}
async function digest(file) {
  const hash = crypto.createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
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
async function probe(file, signal) {
  const result = await run(await binary('ORKAS_BUNDLED_FFPROBE'), ['-v', 'error', '-show_entries', 'format=duration:stream=codec_type,sample_rate,channels', '-of', 'json', file], signal, 60000);
  const data = JSON.parse(result.stdout);
  const audio = data.streams?.find(stream => stream.codec_type === 'audio');
  const duration = Number(data.format?.duration);
  if (!audio || !(duration > 0) || !Number.isFinite(duration)) fail('E_NO_AUDIO', 'The file has no readable audio with a finite duration.');
  return { duration_sec: duration, sample_rate: Number(audio.sample_rate), channels: Number(audio.channels) };
}
function validate(plan) {
  if (plan.schema_version !== 1 || !Array.isArray(plan.segments) || plan.segments.length > 200) fail('E_PLAN', 'Use schema_version 1 and at most 200 segments; split longer work into chapters.');
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
  }
  if (plan.music) { if (typeof plan.music.path !== 'string') fail('E_PLAN', 'Music needs a local path.'); num(plan.music.volume, 0.15, 0, 2); }
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
    if (!probes.has(file)) probes.set(file, await probe(file, signal));
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
  if (!Array.isArray(data.transcription)) fail('E_TRANSCRIPT', 'Whisper returned no segment array.');
  return data.transcription.filter(s => typeof s.text === 'string' && s.text.trim()).map(s => {
    const start = Number(s.offsets?.from) / 1000, end = Number(s.offsets?.to) / 1000;
    if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end < start) fail('E_TRANSCRIPT', 'Whisper returned invalid segment timing.');
    return { start_sec: start, end_sec: end, text: s.text.trim() };
  });
}
async function transcribe(root, input, signal) {
  const source = await local(root, input.input_path);
  await probe(source, signal);
  const ffmpeg = await binary('ORKAS_BUNDLED_FFMPEG'), whisper = await binary('ORKAS_WHISPER_CPP'), model = await binary('ORKAS_WHISPER_MODEL');
  const dir = await fs.mkdtemp(path.join(root, 'transcript-'));
  try {
    await run(ffmpeg, ['-v', 'error', '-nostdin', '-i', source, '-vn', '-ac', '1', '-ar', '16000', path.join(dir, 'input.wav')], signal);
    await run(whisper, ['-m', model, '-f', path.join(dir, 'input.wav'), '-l', input.language || 'auto', '-oj', '-of', path.join(dir, 'raw'), '-np',
      // The bundled Intel macOS Metal backend can return corrupt recognition.
      ...(process.platform === 'darwin' && process.arch === 'x64' ? ['-ng'] : [])], signal);
    const segments = whisperSegments(await json(path.join(dir, 'raw.json')));
    const text = segments.map(s => s.text).join('\n');
    await fs.writeFile(path.join(dir, 'transcript.txt'), text + '\n');
    await fs.writeFile(path.join(dir, 'transcript.srt'), subtitles(segments));
    await atomic(path.join(dir, 'transcript.json'), { schema_version: 1, segments, text, source_sha256: await digest(source) });
    await declareAudioText(dir, ['transcript.txt']);
    await fs.rm(path.join(dir, 'input.wav')); await fs.rm(path.join(dir, 'raw.json'));
    return { ok: true, segments: segments.length, files: ['transcript.txt', 'transcript.srt', 'transcript.json'].map(f => path.relative(root, path.join(dir, f))), empty: segments.length === 0 };
  } catch (err) { await fs.rm(dir, { recursive: true, force: true }); throw err; }
}
async function render(root, plan, state, input, signal) {
  if (!plan.segments.length) fail('E_PLAN', 'Add at least one segment before rendering.');
  const rows = await rowsFor(root, plan, state, signal);
  if (rows.some(r => r.status !== 'ready')) fail('E_NOT_READY', 'Some speech segments are pending, uncertain or stale. Inspect status and preserve completed recordings.');
  const format = input.format ?? 'mp3';
  if (!['mp3', 'wav'].includes(format)) fail('E_FORMAT', 'Export format must be mp3 or wav.');
  const ffmpeg = await binary('ORKAS_BUNDLED_FFMPEG');
  const music = plan.music ? await local(root, plan.music.path) : undefined;
  if (music) await probe(music, signal);
  const temp = await fs.mkdtemp(path.join(root, '.voice-render-'));
  const cues = []; let cursor = 0;
  try {
    for (let i = 0; i < rows.length; i++) {
      const s = plan.segments[i], source = await local(root, rows[i].path);
      const meta = rows[i];
      const start = s.start_sec ?? 0, end = s.end_sec ?? meta.duration_sec;
      if (start >= meta.duration_sec || end > meta.duration_sec + 0.05) fail('E_TRIM', 'A trim lies outside its source audio.');
      const speed = s.speed ?? 1, duration = (end - start) / speed;
      if (duration <= 0 || cursor + duration + (s.gap_after_sec ?? 0) > 14400) fail('E_DURATION', 'Use positive segments and at most four hours per chapter.');
      const filters = [`atrim=start=${start}:end=${end}`, 'asetpts=PTS-STARTPTS', `atempo=${speed}`, `volume=${s.volume ?? 1}`];
      if (s.denoise) filters.push('afftdn');
      if (s.fade_in_sec) filters.push(`afade=t=in:d=${Math.min(duration, s.fade_in_sec)}`);
      if (s.fade_out_sec) { const fade = Math.min(duration, s.fade_out_sec); filters.push(`afade=t=out:st=${Math.max(0, duration - fade)}:d=${fade}`); }
      if (s.gap_after_sec) filters.push(`apad=pad_dur=${s.gap_after_sec}`);
      const clip = path.join(temp, `${i}.wav`);
      await run(ffmpeg, ['-v', 'error', '-nostdin', '-i', source, '-vn', '-af', filters.join(','), '-ar', '48000', '-ac', '2', '-c:a', 'pcm_s16le', clip], signal);
      const measured = await probe(clip, signal);
      if (s.text) cues.push({ start_sec: cursor, end_sec: cursor + duration, text: s.text });
      cursor += measured.duration_sec;
    }
    await fs.writeFile(path.join(temp, 'concat.txt'), rows.map((_, i) => `file '${i}.wav'`).join('\n'));
    await run(ffmpeg, ['-v', 'error', '-nostdin', '-f', 'concat', '-safe', '1', '-i', path.join(temp, 'concat.txt'), '-c:a', 'copy', path.join(temp, 'joined.wav')], signal);
    const args = ['-v', 'error', '-nostdin', '-i', path.join(temp, 'joined.wav')];
    if (music) {
      // Drain the looping source separately. Mixing a looping mono input with
      // stereo narration can stall FFmpeg's filter graph even with input -t.
      const musicClip = path.join(temp, 'music.wav');
      await run(ffmpeg, ['-v', 'error', '-nostdin', '-stream_loop', '-1', '-i', music,
        '-t', String(cursor), '-ar', '48000', '-ac', '2', '-c:a', 'pcm_s16le', musicClip], signal);
      args.push('-i', musicClip, '-filter_complex', `[1:a]volume=${plan.music.volume ?? 0.15}[music];[0:a][music]amix=inputs=2:duration=first:normalize=0,loudnorm=I=-16:TP=-1.5:LRA=11[out]`, '-map', '[out]');
    } else args.push('-af', 'loudnorm=I=-16:TP=-1.5:LRA=11');
    args.push('-ar', '48000', '-ac', '2', '-c:a', format === 'wav' ? 'pcm_s16le' : 'libmp3lame');
    if (format === 'mp3') args.push('-b:a', '192k');
    args.push(path.join(temp, `audio.${format}`));
    await run(ffmpeg, args, signal);
    const meta = await probe(path.join(temp, `audio.${format}`), signal);
    if (Math.abs(meta.duration_sec - cursor) > 0.15) fail('E_EXPORT', 'Export duration does not match the assembled segments.');
    await run(ffmpeg, ['-v', 'error', '-nostdin', '-i', path.join(temp, `audio.${format}`), '-f', 'null', '-'], signal);
    const completeCaptions = plan.segments.every(s => s.text && !s.start_sec && s.end_sec === undefined);
    if (cues.length) {
      await fs.writeFile(path.join(temp, 'script.txt'), cues.map(c => c.text).join('\n') + '\n');
    }
    if (completeCaptions) {
      await fs.writeFile(path.join(temp, 'captions.srt'), subtitles(cues));
    }
    await atomic(path.join(temp, 'plan-snapshot.json'), plan);
    await atomic(path.join(temp, 'receipt.json'), { schema_version: 1, ...meta, cues, captions_complete: completeCaptions, sha256: await digest(path.join(temp, `audio.${format}`)), verification: 'decoded; segment duration checked; perceptual quality not verified' });
    if (cues.length) await declareAudioText(temp, ['script.txt']);
    const output = path.join(root, `export-${crypto.randomUUID()}`);
    // Publish the complete candidate directory atomically, preserving every prior export.
    for (const name of ['joined.wav', 'concat.txt', ...(music ? ['music.wav'] : []), ...rows.map((_, i) => `${i}.wav`)]) await fs.rm(path.join(temp, name));
    await fs.rename(temp, output);
    return { ok: true, ...meta, captions_complete: completeCaptions, files: [`audio.${format}`, ...(cues.length ? ['script.txt'] : []), ...(completeCaptions ? ['captions.srt'] : []), 'receipt.json', 'plan-snapshot.json'].map(f => path.relative(root, path.join(output, f))) };
  } finally { await fs.rm(temp, { recursive: true, force: true }); }
}
async function execute(operation, request, signal) {
  if (operation === 'preflight') {
    const ready = {};
    for (const env of ['ORKAS_BUNDLED_FFMPEG', 'ORKAS_BUNDLED_FFPROBE', 'ORKAS_WHISPER_CPP', 'ORKAS_WHISPER_MODEL']) {
      try { await binary(env); ready[env] = true; } catch { ready[env] = false; }
    }
    return { ok: Object.values(ready).every(Boolean), ready };
  }
  if (!request || typeof request !== 'object' || Array.isArray(request)
    || typeof request.project !== 'string' || !request.project.trim()) {
    fail('E_INPUT', 'The request JSON must contain a non-empty project file path.');
  }
  const projectFile = path.resolve(request.project);
  const root = await fs.realpath(path.dirname(projectFile));
  const plan = validate(await json(await local(root, path.basename(projectFile))));
  if (operation === 'probe') return { ok: true, ...await probe(await local(root, request.input_path), signal) };
  if (operation === 'transcribe') return transcribe(root, request, signal);
  const lockPath = await local(root, '.voice-lock', true);
  let lock;
  try { lock = await fs.open(lockPath, 'wx'); } catch (err) { if (err.code === 'EEXIST') fail('E_BUSY', 'Audio project is busy. After a crash, verify no task is active before removing .voice-lock.'); throw err; }
  try {
    const state = await stateFor(root);
    if (operation === 'status') return { ok: true, segments: await rowsFor(root, plan, state, signal) };
    if (operation === 'render') return await render(root, plan, state, request, signal);
    const s = plan.segments.find(segment => segment.id === request.segment_id && segment.text !== undefined);
    if (!s) fail('E_SEGMENT', 'Choose a speech segment id from this project.');
    const key = keyFor(plan, s);
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
    fail('E_OPERATION', 'Use preflight, probe, transcribe, status, begin, record or render.');
  } finally { await lock.close(); await fs.rm(lockPath, { force: true }); }
}
async function entry(args) {
  const abort = new AbortController();
  const cancel = () => abort.abort();
  process.once('SIGTERM', cancel); process.once('SIGINT', cancel);
  try {
    const [operation, requestFile] = args;
    const request = requestFile ? await json(path.resolve(requestFile)) : {};
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
