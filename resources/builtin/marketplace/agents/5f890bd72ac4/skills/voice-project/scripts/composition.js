'use strict';

// Opt-in file-track composition. The caller supplies scoped I/O and codecs.
const fs = require('node:fs/promises');
const path = require('node:path');
const { duck } = require('./transfer.js');
const RATE = 48000, MAX_SECONDS = 14400, MAX_BYTES = 2 * 1024 ** 3;
const MEDIA_INPUT = ['-protocol_whitelist', 'file,pipe', '-format_whitelist', 'wav,mp3,flac,ogg,mov,matroska,webm,aac,avi,mpegts,asf,aiff'];
const fail = message => { throw Object.assign(new Error(message), { code: 'E_COMPOSITION' }); };
function number(v, fallback, min, max) {
  const n = v === undefined ? fallback : v;
  if (typeof n !== 'number' || !Number.isFinite(n) || n < min || n > max) fail('Track timing or gain is outside its supported range.');
  return n;
}
function settings(raw, legacy = false) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) fail('A track must be an object.');
  const allowed = legacy ? ['path', 'volume', 'duck', 'loop_crossfade_sec', 'fade_in_sec', 'fade_out_sec']
    : ['id', 'kind', 'path', 'at_sec', 'start_sec', 'end_sec', 'duration_sec', 'volume', 'loop', 'loop_crossfade_sec', 'fade_in_sec', 'fade_out_sec', 'duck'];
  if (Object.keys(raw).some(k => !allowed.includes(k))) fail('Unknown track setting.');
  if (!legacy && (typeof raw.id !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(raw.id) || !['music', 'effect'].includes(raw.kind))) fail('Tracks need a stable id and music/effect kind.');
  if (typeof raw.path !== 'string' || !raw.path) fail('A track needs a project-relative source path.');
  const out = { ...raw, kind: legacy ? 'music' : raw.kind, at_sec: number(raw.at_sec, 0, 0, MAX_SECONDS),
    start_sec: number(raw.start_sec, 0, 0, MAX_SECONDS), volume: number(raw.volume, legacy || raw.kind === 'music' ? .15 : 1, 0, 4),
    loop: legacy || (raw.loop ?? false), loop_crossfade_sec: number(raw.loop_crossfade_sec, 0, 0, 60),
    fade_in_sec: number(raw.fade_in_sec, 0, 0, 60), fade_out_sec: number(raw.fade_out_sec, 0, 0, 60), duck: duck(raw.duck) };
  if (typeof out.loop !== 'boolean' || out.loop_crossfade_sec && !out.loop || out.kind !== 'music' && out.duck) fail('Only music can duck; loop crossfade requires looping.');
  if (out.loop_crossfade_sec > 0 && out.loop_crossfade_sec < 1 / RATE) fail('Loop crossfade must span at least one sample.');
  if (raw.end_sec !== undefined && number(raw.end_sec, 0, 0, MAX_SECONDS) <= out.start_sec) fail('Track end must follow its source start.');
  if (raw.duration_sec !== undefined) number(raw.duration_sec, 0, 1 / RATE, MAX_SECONDS);
  return out;
}
function validate(plan) {
  if (plan.tracks !== undefined) {
    if (plan.schema_version !== 3 || !Array.isArray(plan.tracks) || plan.tracks.length > 32) fail('Use schema 3 with at most 32 file tracks.');
    const ids = new Set();
    for (const track of plan.tracks) { const t = settings(track); if (ids.has(t.id)) fail('Track ids must be unique.'); ids.add(t.id); }
  }
  if (plan.music && ['loop_crossfade_sec', 'fade_in_sec', 'fade_out_sec'].some(k => plan.music[k] !== undefined)) {
    if (plan.schema_version !== 3) fail('Music transitions require schema 3.');
    settings(plan.music, true);
  }
}
const enabled = plan => plan.tracks?.length || plan.music && ['loop_crossfade_sec', 'fade_in_sec', 'fade_out_sec'].some(k => plan.music[k] !== undefined);
async function compose(root, temp, voice, voiceDuration, plan, signal, h) {
  const { local, probe, binary, run, digest, channels } = h, ff = await binary('ORKAS_BUNDLED_FFMPEG');
  const tracks = [...(plan.music ? [{ ...settings(plan.music, true), id: 'legacy-music', duration_sec: voiceDuration }] : []), ...(plan.tracks || []).map(t => settings(t))];
  if (tracks.length > 32) fail('Use at most 32 tracks including the legacy music track.');
  let total = 0, sourceBytes = 0, duration = voiceDuration;
  const sources = new Map();
  // Resolve all dynamic limits before decoding any new track.
  for (const t of tracks) {
    signal?.throwIfAborted(); t.file = await local(root, t.path);
    if (!sources.has(t.file)) {
      const info = await fs.stat(t.file);
      if (!info.isFile() || info.size > 8 * 1024 ** 3) fail('Use regular track files up to 8 GiB.');
      sourceBytes += info.size;
      if (sourceBytes > 8 * 1024 ** 3) fail('Track sources exceed the aggregate 8 GiB limit; split the project.');
      const meta = await probe(t.file, signal, true);
      if (meta.audio_streams.length !== 1) fail('Extract the desired audio stream before using a multistream track.');
      sources.set(t.file, { meta, sha256: await digest(t.file, signal) });
    }
    const { meta, sha256 } = sources.get(t.file);
    t.end_sec ??= meta.duration_sec;
    if (t.start_sec >= meta.duration_sec || t.end_sec > meta.duration_sec + .001) fail('A track trim lies outside its source.');
    t.source_duration = t.end_sec - t.start_sec;
    t.duration_sec ??= t.source_duration;
    if (t.source_duration <= 0 || !t.loop && t.duration_sec > t.source_duration + 1 / RATE) fail('A longer track needs explicit looping.');
    if (t.loop_crossfade_sec >= t.source_duration / 2) fail('Loop crossfade must be shorter than half the source window.');
    total += t.duration_sec * 2 + t.source_duration * (t.loop_crossfade_sec ? 3 : 1);
    duration = Math.max(duration, t.at_sec + t.duration_sec);
    if (total > MAX_SECONDS || duration > MAX_SECONDS || duration * RATE * 8 >= MAX_BYTES) fail('Composition exceeds the four-hour decoded-work or 2 GiB PCM limit; split it into chapters.');
    t.sha256 = sha256;
  }
  const generated = [];
  // Retain over-unity mix peaks until the final export normalization/encoding.
  const codec = ['-ar', String(RATE), '-ac', String(channels), '-c:a', 'pcm_f32le', '-fs', String(MAX_BYTES)];
  async function write(name, args) {
    const file = path.join(temp, name); generated.push(name);
    await run(ff, ['-v', 'error', '-xerror', '-nostdin', ...args, ...codec, file], signal);
    if ((await fs.stat(file)).size >= MAX_BYTES) fail('A composition intermediate exceeds 2 GiB.');
    return file;
  }
  for (let i = 0; i < tracks.length; i++) {
    const t = tracks[i], x = t.loop_crossfade_sec;
    // Materialize finite PCM inputs before mixing; an infinite input inside amix
    // can stall FFmpeg. Crossfade one periodic unit, then stream-loop on disk.
    // Float intermediates otherwise use a different stereo downmix gain than
    // integer narration. Keep channel mapping consistent before applying gain.
    const source = await write(`track-source-${i}.wav`, [...MEDIA_INPUT, '-i', t.file, '-af', `atrim=start=${t.start_sec}:end=${t.end_sec},asetpts=PTS-STARTPTS${channels === 1 ? ',aresample=ochl=mono:rematrix_maxval=1' : ''}`]);
    let playable = source;
    if (x && t.duration_sec > t.source_duration) {
      // Independent inputs retain the overlap on bundled Windows FFmpeg;
      // sharing an asplit source can end the crossfade before it is emitted.
      const cycle = await write(`track-cycle-${i}.wav`, ['-i', source, '-i', source, '-filter_complex',
        `[0:a][1:a]acrossfade=d=${x}:c1=tri:c2=tri,atrim=start=${x}:end=${t.source_duration},asetpts=PTS-STARTPTS[out]`, '-map', '[out]']);
      const head = await write(`track-head-${i}.wav`, ['-i', source, '-t', String(x)]);
      const tail = await write(`track-tail-${i}.wav`, ['-stream_loop', '-1', '-i', cycle, '-t', String(t.duration_sec - x)]);
      playable = await write(`track-loop-${i}.wav`, ['-i', head, '-i', tail, '-filter_complex', '[0:a][1:a]concat=n=2:v=0:a=1[out]', '-map', '[out]']);
    }
    const filters = [`atrim=duration=${t.duration_sec}`, 'asetpts=PTS-STARTPTS', `volume=${t.volume}`];
    if (t.fade_in_sec) filters.push(`afade=t=in:d=${Math.min(t.fade_in_sec, t.duration_sec)}`);
    if (t.fade_out_sec) { const d = Math.min(t.fade_out_sec, t.duration_sec); filters.push(`afade=t=out:st=${t.duration_sec - d}:d=${d}`); }
    t.clip = await write(`track-${i}.wav`, [...(t.loop && playable === source ? ['-stream_loop', '-1'] : []), '-i', playable, '-t', String(t.duration_sec), '-af', filters.join(',')]);
    if (Math.abs((await probe(t.clip, signal)).duration_sec - t.duration_sec) > .002) fail('A rendered track has an unexpected duration.');
  }
  const args = ['-i', voice], graph = [], labels = ['[voice]'];
  tracks.forEach(t => args.push('-i', t.clip));
  const ducked = tracks.filter(t => t.duck);
  // Align before splitting so the mixer and compressor drain the same frames.
  // The final timeline trim removes only final-frame padding.
  if (ducked.length) graph.push(`[0:a]apad=whole_dur=${duration},asetnsamples=n=1024:p=1,asplit=${ducked.length + 1}[voice]${ducked.map((_, i) => `[key${i}]`).join('')}`);
  else graph.push(`[0:a]apad=whole_dur=${duration}[voice]`);
  let k = 0;
  tracks.forEach((t, i) => {
    graph.push(`[${i + 1}:a]adelay=${Math.round(t.at_sec * RATE)}S:all=1,apad=whole_dur=${duration}[placed${i}]`);
    if (t.duck) { const d = t.duck; graph.push(`[placed${i}]asetnsamples=n=1024:p=1[duckMusic${i}];[duckMusic${i}][key${k++}]sidechaincompress=threshold=${10 ** (d.threshold_db / 20)}:ratio=${d.ratio}:attack=${d.attack_ms}:release=${d.release_ms}[mixed${i}]`); labels.push(`[mixed${i}]`); }
    else labels.push(`[placed${i}]`);
  });
  graph.push(`${labels.join('')}amix=inputs=${labels.length}:duration=first:normalize=0,atrim=duration=${duration}[out]`);
  const file = await write('composed.wav', [...args, '-filter_complex', graph.join(';'), '-map', '[out]']);
  // Source identity is checked again before this candidate can be published.
  for (const [file, data] of sources) if (await digest(file, signal) !== data.sha256) fail('A track changed during rendering; retry from the preserved sources.');
  return { path: file, duration, generated, tracks: tracks.map(({ file, clip, ...t }) => t) };
}
module.exports = { validate, enabled, settings, compose, MEDIA_INPUT };
