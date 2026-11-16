'use strict';

// Structured audio settings only. User-language interpretation belongs to the Agent.
const fs = require('node:fs/promises');
const { createWriteStream } = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const VERSION = 2;
const MAX_RANGES = 10000;
function fail(code, message) { throw Object.assign(new Error(message), { code }); }
function value(n, fallback, lo, hi) {
  n ??= fallback;
  if (typeof n !== 'number' || !Number.isFinite(n) || n < lo || n > hi) fail('E_PROCESSING', 'Audio processing parameters are outside their supported range.');
  return n;
}
function settings(steps) {
  if (!Array.isArray(steps) || steps.length > 16) fail('E_PROCESSING', 'Use at most 16 ordered audio processing steps.');
  return steps.map(s => {
    if (!s || typeof s !== 'object' || Array.isArray(s)) fail('E_PROCESSING', 'Each processing step must be an object.');
    const allowed = {
      denoise: ['type', 'strength'], deesser: ['type', 'strength'],
      highpass: ['type', 'frequency_hz'],
      compressor: ['type', 'threshold_db', 'ratio', 'attack_ms', 'release_ms'],
      silence: ['type', 'mode', 'threshold_db', 'min_silence_sec', 'padding_sec', 'keep_sec'],
    }[s.type];
    if (!Array.isArray(allowed)) fail('E_PROCESSING', 'Choose a supported audio processing type.');
    if (Object.keys(s).some(k => !allowed.includes(k))) fail('E_PROCESSING', 'Unknown audio processing parameter.');
    if (s.type === 'denoise' && ['light', 'standard', 'strong'].includes(s.strength ?? 'light')) return { type: 'denoise', strength: s.strength ?? 'light' };
    if (s.type === 'deesser' && ['light', 'standard', 'strong'].includes(s.strength ?? 'light')) return { type: 'deesser', strength: s.strength ?? 'light' };
    if (s.type === 'highpass') return { type: 'highpass', frequency_hz: value(s.frequency_hz, 80, 20, 300) };
    if (s.type === 'compressor') return { type: 'compressor', threshold_db: value(s.threshold_db, -18, -60, 0), ratio: value(s.ratio, 3, 1, 20), attack_ms: value(s.attack_ms, 10, .01, 2000), release_ms: value(s.release_ms, 100, .01, 9000) };
    if (s.type !== 'silence' || !['edges', 'compress', 'remove'].includes(s.mode ?? 'edges')) fail('E_PROCESSING', 'Choose a supported processing strength or silence mode.');
    const out = { type: 'silence', mode: s.mode ?? 'edges', threshold_db: value(s.threshold_db, -45, -80, -15), min_silence_sec: value(s.min_silence_sec, .8, .05, 60), padding_sec: value(s.padding_sec, .05, 0, 1), keep_sec: value(s.keep_sec, s.mode === 'remove' ? 0 : .3, 0, 10) };
    if (out.mode !== 'edges' && out.keep_sec >= out.min_silence_sec) fail('E_PROCESSING', 'Retained silence must be shorter than the detection duration.');
    return out;
  });
}
function intervals(metadata, duration) {
  const silence = []; let start;
  // Parse FFmpeg ametadata protocol, not free-form logs or user/model text.
  for (const line of metadata.split('\n')) {
    const m = /^lavfi\.silence_(start|end)=([0-9]+(?:\.[0-9]+)?)\s*$/.exec(line);
    if (!m) continue;
    const t = Number(m[2]);
    if (!Number.isFinite(t) || t < 0 || t > duration + .1) fail('E_AUDIO_ANALYSIS', 'Invalid silence-analysis timing.');
    if (m[1] === 'start') { if (start !== undefined) fail('E_AUDIO_ANALYSIS', 'Overlapping silence-analysis events.'); start = t; }
    else { if (start === undefined || t < start) fail('E_AUDIO_ANALYSIS', 'Incomplete silence-analysis events.'); silence.push([start, Math.min(t, duration)]); start = undefined; }
    if (silence.length > MAX_RANGES) fail('E_AUDIO_COMPLEXITY', 'Too many silence intervals; split the recording into chapters.');
  }
  if (start !== undefined) silence.push([start, duration]);
  return silence;
}
function retained(silence, duration, s) {
  const cuts = [];
  for (const [start, end] of silence) {
    const leading = start < .002, trailing = end >= duration - .002;
    if (leading && trailing) fail('E_ALL_SILENT', 'The whole recording is below the selected silence threshold. Keep the source and lower the threshold.');
    if (s.mode === 'edges' && !leading && !trailing || s.mode === 'compress' && (leading || trailing)) continue;
    const a = leading ? 0 : start + (trailing ? s.padding_sec : s.keep_sec / 2);
    const b = trailing ? duration : end - (leading ? s.padding_sec : s.keep_sec / 2);
    if (b > a) cuts.push([Math.max(0, a), Math.min(duration, b)]);
  }
  let cursor = 0, output = 0; const map = [];
  const add = (a, b) => {
    // Integer frame boundaries make the saved map agree with the actual cut.
    const first = Math.round(a * 48000), last = Math.round(b * 48000);
    if (last <= first) return;
    const start = first / 48000, end = last / 48000;
    map.push({ input_start_sec: start, input_end_sec: end, output_start_sec: output, output_end_sec: output + end - start }); output += end - start;
  };
  for (const [a, b] of cuts) { add(cursor, a); cursor = b; } add(cursor, duration);
  if (!map.length) fail('E_ALL_SILENT', 'No audio remains with these silence settings. Keep the source and lower the threshold.');
  return map;
}
function wavHeader(bytes, channels) {
  if (bytes > 0xffffffff - 36) fail('E_DURATION', 'The processed WAV exceeds its supported size. Split the recording into chapters.');
  const stride = channels * 2;
  const b = Buffer.alloc(44); b.write('RIFF'); b.writeUInt32LE(bytes + 36, 4); b.write('WAVEfmt ', 8); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(channels, 22); b.writeUInt32LE(48000, 24); b.writeUInt32LE(48000 * stride, 28); b.writeUInt16LE(stride, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(bytes, 40); return b;
}
async function cutPcm(ffmpeg, input, output, map, signal, channels) {
  const stride = channels * 2;
  const ranges = map.map(m => [Math.round(m.input_start_sec * 48000) * stride, Math.round(m.input_end_sec * 48000) * stride]);
  const total = ranges.reduce((n, [a, b]) => n + b - a, 0);
  const child = spawn(ffmpeg, ['-v', 'error', '-nostdin', '-i', input, '-ar', '48000', '-ac', String(channels), '-f', 's16le', '-'], { shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let diagnosticBytes = 0, offset = 0, index = 0, written = 0, timedOut = false;
  child.stderr.on('data', b => { diagnosticBytes += b.length; });
  const stop = () => child.kill('SIGKILL');
  const timer = setTimeout(() => { timedOut = true; stop(); }, 30 * 60 * 1000);
  signal?.addEventListener('abort', stop, { once: true });
  const done = new Promise((resolve, reject) => { child.once('error', reject); child.once('close', code => code === 0 ? resolve() : reject(new Error('decode'))); });
  // Observe rejection immediately, including while pipeline is still draining.
  done.catch(() => {});
  const filter = new Transform({ transform(chunk, _, cb) {
    const end = offset + chunk.length;
    while (index < ranges.length && ranges[index][0] < end) {
      const [a, b] = ranges[index], lo = Math.max(a, offset), hi = Math.min(b, end);
      if (hi > lo) { this.push(chunk.subarray(lo - offset, hi - offset)); written += hi - lo; }
      if (b <= end) index++; else break;
    }
    offset = end; cb();
  } });
  const file = createWriteStream(output, { flags: 'wx' }); file.write(wavHeader(total, channels));
  try {
    if (signal?.aborted) { stop(); fail('E_CANCELLED', 'Audio operation cancelled.'); }
    await pipeline(child.stdout, filter, file, { signal }); await done;
    if (written !== total || diagnosticBytes) fail('E_AUDIO_ANALYSIS', 'The recording could not be decoded completely for cutting.');
  } catch (err) {
    stop(); await done.catch(() => {});
    fail(signal?.aborted ? 'E_CANCELLED' : timedOut ? 'E_TIMEOUT' : err.code === 'E_AUDIO_ANALYSIS' ? err.code : 'E_PROCESS', signal?.aborted ? 'Audio operation cancelled.' : 'Audio cutting failed; source and completed results were preserved.');
  } finally { clearTimeout(timer); signal?.removeEventListener('abort', stop); file.destroy(); }
}
async function processAudio(root, input, steps, signal, helpers) {
  const { run, binary, digest, probe, local, json, atomic } = helpers;
  const ffmpeg = await binary('ORKAS_BUNDLED_FFMPEG');
  const engine = (await run(ffmpeg, ['-version'], signal, 60000)).stdout.split('\n')[0];
  const cache = await local(root, '.voice-cache', true); await fs.mkdir(cache, { recursive: true });
  const results = []; let file = input, timingChanged = false;
  for (const s of settings(steps)) {
    const sourceHash = await digest(file), meta = await probe(file, signal);
    const key = crypto.createHash('sha256').update(JSON.stringify({ sourceHash, settings: s, engine, version: VERSION })).digest('hex');
    const dir = await local(root, `.voice-cache/${key}`, true), resultPath = path.join(dir, 'audio.wav');
    let receipt;
    try {
      const saved = await json(await local(root, `.voice-cache/${key}/receipt.json`));
      const cachedFile = await local(root, `.voice-cache/${key}/audio.wav`);
      if (saved.key === key && saved.sha256 === await digest(cachedFile)) { await probe(cachedFile, signal); receipt = { ...saved, reused: true }; }
    } catch (err) { if (signal?.aborted) throw err; }
    if (!receipt) {
      const temp = await fs.mkdtemp(path.join(cache, '.candidate-'));
      try {
        const out = path.join(temp, 'audio.wav'); let map = [{ input_start_sec: 0, input_end_sec: meta.duration_sec, output_start_sec: 0, output_end_sec: meta.duration_sec }], silentCount = 0;
        if (s.type === 'denoise') {
          const [strength, floor] = { light: [6, -45], standard: [12, -35], strong: [18, -30] }[s.strength];
          await run(ffmpeg, ['-v', 'error', '-nostdin', '-i', file, '-af', `afftdn=nr=${strength}:nf=${floor}:tn=0`, '-ar', '48000', '-ac', String(meta.channels), '-c:a', 'pcm_s16le', out], signal);
        } else if (['highpass', 'deesser', 'compressor'].includes(s.type)) {
          let filter;
          if (s.type === 'highpass') filter = `highpass=f=${s.frequency_hz}:p=2`;
          if (s.type === 'deesser') {
            // FFmpeg's max parameter runs backwards: .875/.75/.625 cap
            // reduction at 6/12/18 dB. Intensity zero would be a no-op.
            const [intensity, max] = { light: [.3, .875], standard: [.4, .75], strong: [.5, .625] }[s.strength];
            filter = `deesser=i=${intensity}:m=${max}:f=0.5:s=o`;
          }
          if (s.type === 'compressor') filter = `acompressor=threshold=${10 ** (s.threshold_db / 20)}:ratio=${s.ratio}:attack=${s.attack_ms}:release=${s.release_ms}:makeup=1`;
          await run(ffmpeg, ['-v', 'error', '-nostdin', '-i', file, '-af', filter, '-ar', '48000', '-ac', String(meta.channels), '-c:a', 'pcm_s16le', out], signal);
        } else {
          const measured = await run(ffmpeg, ['-v', 'error', '-nostdin', '-i', file, '-af', `silencedetect=n=${s.threshold_db}dB:d=${s.min_silence_sec},ametadata=mode=print:file=-`, '-f', 'null', '-'], signal);
          const silence = intervals(measured.stdout, meta.duration_sec); silentCount = silence.length;
          map = retained(silence, meta.duration_sec, s); await cutPcm(ffmpeg, file, out, map, signal, meta.channels);
        }
        const outputMeta = await probe(out, signal);
        await run(ffmpeg, ['-v', 'error', '-nostdin', '-i', out, '-f', 'null', '-'], signal);
        receipt = { schema_version: 1, key, settings: s, engine, source_sha256: sourceHash, sha256: await digest(out), duration_sec: outputMeta.duration_sec, removed_sec: Math.max(0, meta.duration_sec - outputMeta.duration_sec), silent_intervals: silentCount, time_map: map, output_path: path.relative(root, resultPath), reused: false };
        await atomic(path.join(temp, 'receipt.json'), receipt);
        // Only replace a corrupt derived cache, never source or a prior export.
        await fs.rm(dir, { recursive: true, force: true }); await fs.rename(temp, dir);
      } finally { await fs.rm(temp, { recursive: true, force: true }); }
    }
    results.push(receipt); timingChanged ||= receipt.removed_sec > 1 / 48000; file = resultPath;
  }
  return { path: file, processing: results, timingChanged };
}
module.exports = { settings, intervals, retained, processAudio };
