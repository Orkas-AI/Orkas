import fs from 'node:fs';
import { VOICE_RECORDED_CASE_IDS } from '../../benchmark/scenarios/voice-studio.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import type { VoiceEvidence } from './voice-studio-fixtures.js';
import type { VoiceTrace as ProductionRegressionTrace } from './voice-studio-fixtures.js';
import { decodeEnhancement } from './voice-enhancement-fixtures.js';
import { publishedVoiceCandidates } from './voice-output-evidence.js';
import { inspectProjectReplay } from './voice-project-replay.js';

export const recordedCases: readonly string[] = VOICE_RECORDED_CASE_IDS;
export type RecordedKind = 'noise' | 'rumble' | 'dynamics' | 'preserve' | 'deess';
export type RecordedLanguage = 'en' | 'zh';
const rate = 48000, hash = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');
const sources = new Map<string, Float32Array>();
export function pcmWav(samples: ArrayLike<number>, channels = 1) {
  const b = Buffer.alloc(44 + samples.length * 2); b.write('RIFF'); b.writeUInt32LE(b.length - 8, 4); b.write('WAVEfmt ', 8);
  b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(channels, 22); b.writeUInt32LE(rate, 24);
  b.writeUInt32LE(rate * channels * 2, 28); b.writeUInt16LE(channels * 2, 32); b.writeUInt16LE(16, 34);
  b.write('data', 36); b.writeUInt32LE(samples.length * 2, 40);
  for (let i = 0; i < samples.length; i++) b.writeInt16LE(Math.round(Math.max(-1, Math.min(.99996, samples[i])) * 32768), 44 + i * 2);
  return b;
}
function speech(language: RecordedLanguage) {
  if (!sources.has(language)) {
    const file = fileURLToPath(new URL(`../../../test/fixtures/voice/${language === 'en' ? 'jfk.wav' : 'thchs30-D11_750.wav'}`, import.meta.url));
    const b = decodeEnhancement(file), samples = Float32Array.from({ length: b.length / 4 }, (_, i) => b.readFloatLE(i * 4));
    let peak = 0; for (const v of samples) peak = Math.max(peak, Math.abs(v));
    sources.set(language, samples.map(v => v / peak * .35));
  }
  return sources.get(language)!;
}
// Real human speech with independent, deterministic degradations. Clean reference
// stays evaluator-only; actors receive only the resulting WAV and saved project.
export function recordedAudio(kind: RecordedKind, language: RecordedLanguage) {
  const original = speech(language), clean = new Float32Array(rate * 8), input = new Float32Array(clean.length);
  let seed = 19;
  for (let i = 0; i < input.length; i++) {
    const t = i / rate;
    if (kind === 'dynamics') {
      if (t >= 1 && t < 3) clean[i] = original[i - rate] * .1;
      if (t >= 4 && t < 6) clean[i] = original[i - rate * 4];
    } else if (t >= 1 && t < 7) clean[i] = original[(i - rate) % original.length];
    input[i] = clean[i]; seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    if (kind === 'noise') input[i] += (seed / 0xffffffff * 2 - 1) * .018;
    if ((kind === 'rumble' || kind === 'preserve') && t >= 1 && t < 7) input[i] += .1 * Math.sin(2 * Math.PI * 40 * t);
    if (kind === 'deess' && t >= 2 && t < 3) input[i] += .22 * Math.sin(2 * Math.PI * 9000 * t);
    if (kind === 'deess' && t >= 6 && t < 7) input[i] += .003 * Math.sin(2 * Math.PI * 9000 * t);
  }
  return { wav: pcmWav(input), clean, input };
}
function floats(b: Buffer) { return Float32Array.from({ length: b.length / 4 }, (_, i) => b.readFloatLE(i * 4)); }
function rms(b: ArrayLike<number>, start: number, duration: number) {
  let energy = 0; const lo = Math.round(start * rate), hi = Math.round((start + duration) * rate);
  if (hi > b.length) return NaN;
  for (let i = lo; i < hi; i++) energy += b[i] ** 2;
  return Math.sqrt(energy / (hi - lo));
}
function tone(b: ArrayLike<number>, hz: number, start: number, duration: number) {
  let a = 0, c = 0; const lo = Math.round(start * rate), hi = Math.round((start + duration) * rate);
  if (hi > b.length) return NaN;
  for (let i = lo; i < hi; i++) { a += b[i] * Math.cos(i * 2 * Math.PI * hz / rate); c += b[i] * Math.sin(i * 2 * Math.PI * hz / rate); }
  return Math.hypot(a, c) * 2 / (hi - lo);
}
export function correlation(a: ArrayLike<number>, b: ArrayLike<number>, start = 1.2, duration = 5.5) {
  let cross = 0, aa = 0, bb = 0; const lo = Math.round(start * rate), hi = Math.round((start + duration) * rate);
  if (hi > a.length || hi > b.length) return 0;
  for (let i = lo; i < hi; i++) { cross += a[i] * b[i]; aa += a[i] ** 2; bb += b[i] ** 2; }
  return cross / Math.sqrt(aa * bb) || 0;
}
function voiceBand(b: Float32Array) {
  // Independent analysis FIR, not the production de-esser: remove the injected
  // 9 kHz probe before testing preservation of lower-frequency speech.
  const out = new Float32Array(b.length); let sum = 0;
  for (let i = 0; i < b.length; i++) { sum += b[i]; if (i >= 16) sum -= b[i - 16]; out[i] = sum / 16; }
  return out;
}
function alignedNoiseCorrelation(clean: Float32Array, output: Float32Array) {
  // FFT denoising has a bounded analysis delay; establish alignment from the
  // waveform, independently of FFmpeg's implementation or chosen coefficients.
  let best = -1, lag = 0;
  const score = (shift: number) => {
    let a = 0, b = 0, cross = 0;
    for (let i = 2 * rate; i < 5 * rate; i += 48) { const x = clean[i], y = output[i + shift] ?? 0; a += x * x; b += y * y; cross += x * y; }
    return cross / Math.sqrt(a * b) || 0;
  };
  for (let shift = -2400; shift <= 2400; shift += 16) { const r = score(shift); if (r > best) { best = r; lag = shift; } }
  const coarse = lag;
  for (let shift = Math.max(-2400, coarse - 15); shift <= Math.min(2400, coarse + 15); shift++) { const r = score(shift); if (r > best) { best = r; lag = shift; } }
  const aligned = Float32Array.from({ length: output.length }, (_, i) => output[i + lag] ?? 0);
  return { correlation: correlation(clean, aligned), delay_sec: lag / rate };
}
export function recordedMeasures(kind: RecordedKind, language: RecordedLanguage, pcm: Buffer) {
  const output = floats(pcm), fixture = recordedAudio(kind, language);
  const cleanBand = voiceBand(fixture.clean), outputBand = voiceBand(output);
  const noiseAlignment = kind === 'noise' ? alignedNoiseCorrelation(cleanBand, outputBand) : undefined;
  const measure = (b: ArrayLike<number>) => ({ duration_sec: b.length / rate,
    noise_to_speech: rms(b, .1, .7) / rms(b, 1.2, 5.5),
    rumble_to_speech: tone(b, 40, 1.2, 5.5) / rms(b, 1.2, 5.5),
    loud_to_quiet: rms(b, 4.2, 1.5) / rms(b, 1.2, 1.5),
    sibilance_to_speech: tone(b, 9000, 2.2, .5) / rms(b, 1.2, .5),
    detail_to_speech: tone(b, 9000, 6.2, .5) / rms(b, 1.2, .5) });
  return { source: measure(fixture.input), output: measure(output),
    speech_correlation: noiseAlignment?.correlation ?? (kind === 'dynamics' ? Math.min(correlation(cleanBand, outputBand, 1.2, 1.5), correlation(cleanBand, outputBand, 4.2, 1.5)) : correlation(cleanBand, outputBand)),
    unchanged_correlation: correlation(fixture.input, output),
    local_unchanged_correlation: Math.min(...Array.from({ length: 11 }, (_, i) => correlation(fixture.input, output, 1.2 + i * .5, .25))),
    analysis_delay_sec: noiseAlignment?.delay_sec ?? 0,
    speech_reference: kind === 'preserve'
      ? 'speech_correlation compares the clean speech without the deliberately injected 40 Hz rumble. Low correlation with that reference is expected when preserving the supplied noisy recording; preservation is measured by local_unchanged_correlation against the actual input and its unchanged rumble_to_speech ratio.'
      : 'speech_correlation compares against clean speech before the controlled degradation, using the independently measured fixed delay only for denoising.',
    units: 'Ratios are dimensionless amplitude or RMS ratios. Speech correlation uses an independent voice-band FIR; denoising alignment permits at most 50 ms fixed analysis delay. Preservation compares local waveform shape because the existing export always normalizes loudness. Source/output ratios are independently measured; no perceptual listening claim.' };
}
export type RecordedMeasures = ReturnType<typeof recordedMeasures>;
export function recordedMatches(kind: RecordedKind, m: RecordedMeasures) {
  if (Math.abs(m.output.duration_sec - 8) > .001 || (kind !== 'preserve' && m.speech_correlation < .8)) return false;
  if (kind === 'noise') return m.output.noise_to_speech < m.source.noise_to_speech * .75;
  if (kind === 'rumble') return m.output.rumble_to_speech < m.source.rumble_to_speech * .5;
  if (kind === 'dynamics') return Math.max(m.output.loud_to_quiet, 1 / m.output.loud_to_quiet) < 8;
  if (kind === 'deess') return m.output.sibilance_to_speech < m.source.sibilance_to_speech * .75 && m.output.detail_to_speech > m.source.detail_to_speech * .75;
  return m.local_unchanged_correlation > .99 && Math.abs(m.output.rumble_to_speech / m.source.rumble_to_speech - 1) < .05;
}
function config(id: string): { kind: RecordedKind; language: RecordedLanguage } {
  return { kind: id === recordedCases[0] ? 'noise' : id === recordedCases[2] ? 'dynamics' : id === recordedCases[3] || id.endsWith('-undo') ? 'preserve' : 'rumble', language: id === recordedCases[0] || id === recordedCases[2] ? 'en' : 'zh' };
}
export function recordedInputs(id: string): Record<string, Buffer | string> {
  const { kind, language } = config(id), b = recordedAudio(kind, language).wav;
  return { 'sources/recording.wav': b, 'export-previous/audio.wav': b,
    'voice-project.json': JSON.stringify({ schema_version: 1, roles: {}, segments: [{ id: 'recording', path: 'sources/recording.wav' }] }) };
}
export function inspectRecorded(id: string, root: string, published?: readonly string[]): VoiceEvidence {
  const { kind, language } = config(id), base = path.join(root, 'audio'), inputs = recordedInputs(id);
  const same = (rel: string) => { try { return hash(fs.readFileSync(path.join(base, rel))) === hash(inputs[rel]); } catch { return false; } };
  const e: VoiceEvidence = { sourcesPreserved: same('sources/recording.wav'), previousPreserved: same('export-previous/audio.wav'), projectValid: false, recordingsPreserved: true, recovered: false, exportCount: 0, decoded: false, contentMatched: false, transcriptCount: 0 };
  const expected = kind === 'noise' ? 'denoise' : kind === 'rumble' ? 'highpass' : kind === 'dynamics' ? 'compressor' : undefined;
  const projects: string[] = [];
  try {
    for (const name of fs.readdirSync(base).filter(n => n.endsWith('.json')).slice(0, 32)) try {
      const file = path.join(base, name); if (!fs.lstatSync(file).isFile() || fs.lstatSync(file).isSymbolicLink() || fs.statSync(file).size > 4 * 1024 * 1024) continue;
      const p = JSON.parse(fs.readFileSync(file, 'utf8'));
      const valid = [1, 2, 3].includes(p.schema_version) && p.segments?.length === 1 && p.segments[0].path === 'sources/recording.wav'
        && !p.music && !p.segments[0].denoise && (expected ? p.schema_version === 2 && p.processing?.length === 1 && p.processing[0].type === expected
          && (expected !== 'denoise' || (p.processing[0].strength ?? 'standard') === 'standard')
          && (expected !== 'highpass' || (p.processing[0].frequency_hz ?? 80) === 80) : !p.processing?.length);
      if (valid) { e.projectValid = true; projects.push(file); }
    } catch { /* Unrelated malformed JSON cannot hide a valid saved project. */ }
  } catch {}
  const exports: string[] = [];
  function visit(dir: string, depth = 0) {
    if (depth > 6 || !fs.existsSync(dir)) return;
    for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
      if (f.isSymbolicLink() || f.name.startsWith('.') || ['sources', 'export-previous'].includes(f.name)) continue;
      const file = path.join(dir, f.name); if (f.isDirectory()) visit(file, depth + 1); else if (f.name.endsWith('.wav')) exports.push(file);
    }
  }
  visit(base); e.exportCount = exports.length; let priorRumble = false, matchedFile: string | undefined;
  const selected=new Set(publishedVoiceCandidates(exports,published));
  if(published!==undefined)e.deliveredAudioCount=selected.size;
  for (const file of exports) try {
    const pcm = decodeEnhancement(file), m = recordedMeasures(kind, language, pcm); e.decoded = true;
    if (selected.has(file)&&recordedMatches(kind, m)) { e.contentMatched = true; e.recorded = m; matchedFile = file; }
    if (id.endsWith('-undo')) priorRumble ||= recordedMatches('rumble', recordedMeasures('rumble', language, pcm));
  } catch {}
  if (id.endsWith('-undo')) e.contentMatched &&= priorRumble;
  if (e.contentMatched && matchedFile) e.projectReplay = inspectProjectReplay(base, projects, matchedFile);
  return e;
}
export function recordedChecks(id: string, t: ProductionRegressionTrace) {
  const e = t.voiceStudio, check = (name: string, pass: boolean) => ({ id: `acceptance:voice-${name}`, pass, critical: true, detail: `Independent human-recording evidence: ${JSON.stringify(e ?? null)}` });
  return [check('preservation', !!e?.sourcesPreserved && e.previousPreserved && e.projectValid),
    check('project-replay', e?.projectReplay?.matched === true),
    check('local-only', !t.toolCalls.some(c => c.name === 'generate_speech')),
    check('observed-execution', t.toolCalls.some(c => c.name === 'bash' && c.isError === false)),
    check('outcome', !!e?.decoded && e.contentMatched && (e.deliveredAudioCount!==undefined?e.deliveredAudioCount===1:e.exportCount===(id.endsWith('-undo') ? 2 : 1)))];
}
