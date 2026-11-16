'use strict';

// Local media transfer and encoding. No speech generation or implicit treatment.
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const FORMATS = { mp3: 'libmp3lame', wav: 'pcm_s16le', flac: 'flac', m4a: 'aac', aac: 'aac', ogg: 'libvorbis', opus: 'libopus' };
const RATES = [8000, 11025, 12000, 16000, 22050, 24000, 32000, 44100, 48000, 88200, 96000];
const MAX_BYTES = 2 * 1024 * 1024 * 1024;
function fail(code, message) { throw Object.assign(new Error(message), { code }); }
function number(value, min, max) { return typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max; }
function settings(raw = {}, rendering = true, format) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) fail('E_FORMAT', 'Export settings must be an object.');
  const allowed = ['format', 'sample_rate', 'channels', 'bitrate_kbps', 'bit_depth', 'normalize_loudness', 'target_lufs', 'true_peak_db'];
  if (Object.keys(raw).some(key => !allowed.includes(key))) fail('E_FORMAT', 'Unknown export setting.');
  const out = { ...raw, format: format ?? raw.format ?? (rendering ? 'mp3' : undefined) };
  if (out.format === 'copy') {
    if (rendering || Object.keys(raw).some(key => key !== 'format' && !(key === 'normalize_loudness' && raw[key] === false))) fail('E_FORMAT', 'Copy extraction cannot change encoding or audio settings.');
    return out;
  }
  if (!Object.hasOwn(FORMATS, out.format)) fail('E_FORMAT', 'Choose mp3, wav, flac, m4a, aac, ogg or opus.');
  if (out.sample_rate !== undefined && (!RATES.includes(out.sample_rate)
    || out.format === 'mp3' && out.sample_rate > 48000
    || out.format === 'opus' && ![8000, 12000, 16000, 24000, 48000].includes(out.sample_rate))) fail('E_FORMAT', 'The sample rate is unsupported for this format.');
  if (out.channels !== undefined && ![1, 2].includes(out.channels)) fail('E_FORMAT', 'Choose one or two output channels.');
  if (out.bit_depth !== undefined && (!['wav', 'flac'].includes(out.format) || ![16, 24, ...(out.format === 'wav' ? [32] : [])].includes(out.bit_depth))) fail('E_FORMAT', 'Bit depth applies only to WAV (16/24/32) or FLAC (16/24).');
  if (out.bitrate_kbps !== undefined && (['wav', 'flac'].includes(out.format) || !Number.isInteger(out.bitrate_kbps)
    || !number(out.bitrate_kbps, out.format === 'opus' ? 6 : 32, out.format === 'mp3' ? 320 : 512))) fail('E_FORMAT', 'Choose a supported lossy output bitrate in kbps.');
  if (out.format === 'mp3' && out.bitrate_kbps !== undefined && (![32,40,48,56,64,80,96,112,128,160,192,224,256,320].includes(out.bitrate_kbps)
    || out.sample_rate < 32000 && out.bitrate_kbps > 160)) fail('E_FORMAT', 'Choose a supported MP3 bitrate for the selected sample rate.');
  if (out.normalize_loudness !== undefined && typeof out.normalize_loudness !== 'boolean') fail('E_FORMAT', 'normalize_loudness must be boolean.');
  out.normalize_loudness ??= rendering;
  if (!rendering && (out.normalize_loudness || out.target_lufs !== undefined || out.true_peak_db !== undefined)) fail('E_FORMAT', 'Extraction and conversion preserve levels; use render for loudness treatment.');
  if (out.target_lufs !== undefined && (!out.normalize_loudness || !number(out.target_lufs, -70, -5))) fail('E_FORMAT', 'A loudness target requires normalization and must be between -70 and -5 LUFS.');
  if (out.true_peak_db !== undefined && (!out.normalize_loudness || !number(out.true_peak_db, -9, 0))) fail('E_FORMAT', 'A true peak target requires normalization and must be between -9 and 0 dB.');
  return out;
}
function encoding(options, rendering = true, sourceBits, sourceCodec) {
  const out = [], format = options.format;
  let codec = FORMATS[format];
  if (format === 'wav') codec = `pcm_s${options.bit_depth ?? (!rendering && [16, 24, 32].includes(sourceBits) ? sourceBits : 16)}le`;
  if (format === 'wav' && !rendering && options.bit_depth === undefined && ['pcm_f32le', 'pcm_f64le'].includes(sourceCodec)) codec = sourceCodec;
  out.push('-c:a', codec);
  if (format === 'flac' && options.bit_depth) out.push('-sample_fmt', options.bit_depth === 16 ? 's16' : 's32', '-bits_per_raw_sample', String(options.bit_depth));
  const rate = options.sample_rate ?? (rendering ? 48000 : undefined);
  const channels = options.channels ?? (rendering ? 2 : undefined);
  if (rate) out.push('-ar', String(rate));
  if (channels) out.push('-ac', String(channels));
  if (!['wav', 'flac'].includes(format)) out.push('-b:a', String(options.bitrate_kbps ?? (format === 'opus' ? 128 : 192)) + 'k');
  return out;
}
const loudness = options => options.normalize_loudness ? `loudnorm=I=${options.target_lufs ?? -16}:TP=${options.true_peak_db ?? -1.5}:LRA=11` : 'anull';
function duck(value) {
  if (value === undefined || value === false) return false;
  if (value === true) return { threshold_db: -34, ratio: 10, attack_ms: 20, release_ms: 400 };
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some(key => !['threshold_db', 'ratio', 'attack_ms', 'release_ms'].includes(key))) fail('E_PLAN', 'Use a boolean or typed music ducking settings.');
  const out = { threshold_db: -34, ratio: 10, attack_ms: 20, release_ms: 400, ...value };
  if (!number(out.threshold_db, -60, 0) || !number(out.ratio, 1, 20) || !number(out.attack_ms, .01, 2000) || !number(out.release_ms, .01, 9000)) fail('E_PLAN', 'Music ducking settings are outside their supported range.');
  return out;
}

async function transferOwned(root, request, operation, signal, helpers) {
  const { local, run, binary, digest, atomic } = helpers;
  const options = settings(request.export, false, request.format ?? request.export?.format ?? (operation === 'extract' ? 'copy' : undefined));
  if (operation === 'convert' && options.format === 'copy') fail('E_FORMAT', 'Use extract for a stream copy, or choose a conversion format.');
  signal?.throwIfAborted();
  const source = await local(root, request.input_path);
  const info = await fs.stat(source);
  if (!info.isFile() || info.size > 8 * 1024 * 1024 * 1024) fail('E_SIZE', 'Use a regular media file up to 8 GiB.');
  const protocols = ['-protocol_whitelist', 'file,pipe', '-format_whitelist', 'wav,mp3,flac,ogg,mov,matroska,webm,aac,avi,mpegts,asf,aiff'];
  const metadata = JSON.parse((await run(await binary('ORKAS_BUNDLED_FFPROBE'), ['-v', 'error', ...protocols, '-show_streams', '-show_format', '-of', 'json', source], signal, 60000)).stdout);
  const tracks = metadata.streams?.filter(stream => stream.codec_type === 'audio') || [];
  if (!tracks.length) fail('E_NO_AUDIO', 'The supplied media has no audio track.');
  const track = request.audio_stream ?? (tracks.length === 1 ? 0 : undefined);
  if (!Number.isInteger(track) || track < 0 || track >= tracks.length) fail('E_AUDIO_TRACK', 'Select audio_stream using its zero-based audio track index.');
  const selected = tracks[track], duration = Number(selected.duration || metadata.format?.duration);
  if (!Number.isFinite(duration) || duration <= 0 || duration > 14400) fail('E_DURATION', 'Use readable audio up to four hours.');
  if (options.format === 'mp3' && options.bitrate_kbps > 160 && (options.sample_rate ?? Number(selected.sample_rate)) < 32000) fail('E_FORMAT', 'The source sample rate needs a lower MP3 bitrate or an explicit supported output sample rate.');
  const sourceHash = await digest(source, signal);
  const copyFormat = { aac: 'm4a', mp3: 'mp3', flac: 'flac', opus: 'opus', vorbis: 'ogg', pcm_s16le: 'wav', pcm_s24le: 'wav', pcm_s32le: 'wav', pcm_f32le: 'wav' }[selected.codec_name];
  const format = options.format === 'copy' ? copyFormat : options.format;
  if (!format) fail('E_FORMAT', 'This audio codec needs an explicit conversion format for extraction.');
  const ffmpeg = await binary('ORKAS_BUNDLED_FFMPEG');
  const temp = await fs.mkdtemp(path.join(root, '.voice-transfer-'));
  try {
    const file = path.join(temp, `audio.${format}`);
    await run(ffmpeg, ['-v', 'error', '-xerror', '-nostdin', ...protocols, '-i', source, '-map', `0:a:${track}`, '-vn', '-sn', '-dn',
      ...(options.format === 'copy' ? ['-c:a', 'copy'] : encoding(options, false, Number(selected.bits_per_raw_sample || selected.bits_per_sample), selected.codec_name)),
      '-fs', String(MAX_BYTES), '-n', file], signal);
    if ((await fs.stat(file)).size >= MAX_BYTES) fail('E_SIZE', 'The converted audio exceeds 2 GiB; split it into shorter parts.');
    const output = JSON.parse((await run(await binary('ORKAS_BUNDLED_FFPROBE'), ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', file], signal, 60000)).stdout);
    const stream = output.streams?.[0], seconds = Number(output.format?.duration);
    if (output.streams?.length !== 1 || stream?.codec_type !== 'audio' || !Number.isFinite(seconds) || !(seconds > 0)
      || options.sample_rate !== undefined && Number(stream.sample_rate) !== options.sample_rate
      || options.channels !== undefined && stream.channels !== options.channels
      || Number(selected.duration) > 0 && Math.abs(seconds - Number(selected.duration)) > .3) fail('E_EXPORT', 'Converted audio does not match the selected source track.');
    await run(ffmpeg, ['-v', 'error', '-xerror', '-nostdin', '-i', file, '-f', 'null', '-'], signal);
    if (await digest(source, signal) !== sourceHash) fail('E_INPUT_CHANGED', 'Source media changed during processing; retry from the preserved source.');
    signal?.throwIfAborted();
    const result = { duration_sec: seconds, sample_rate: Number(stream.sample_rate), channels: stream.channels, codec: stream.codec_name };
    await atomic(path.join(temp, 'receipt.json'), { schema_version: 1, operation, ...result, source_sha256: sourceHash, sha256: await digest(file, signal), audio_stream: track, export: options });
    signal?.throwIfAborted();
    const destination = path.join(root, `export-${crypto.randomUUID()}`);
    await fs.rename(temp, destination);
    return { ok: true, ...result, files: [`audio.${format}`, 'receipt.json'].map(name => path.relative(root, path.join(destination, name))) };
  } finally { await fs.rm(temp, { recursive: true, force: true }); }
}
async function transfer(root, request, operation, parent, helpers) {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, 30 * 60 * 1000);
  timer.unref?.();
  const abort = () => controller.abort(parent.reason);
  parent?.addEventListener('abort', abort, { once: true });
  if (parent?.aborted) abort();
  try { return await transferOwned(root, request, operation, controller.signal, helpers); }
  catch (error) {
    if (parent?.aborted) fail('E_CANCELLED', 'Audio operation cancelled.');
    if (timedOut) fail('E_TIMEOUT', 'Audio extraction or conversion timed out; source and completed results were preserved.');
    throw error;
  } finally { clearTimeout(timer); parent?.removeEventListener('abort', abort); }
}
module.exports = { settings, encoding, loudness, duck, transfer };
