import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { VOICE_ENHANCEMENT_CASE_IDS } from '../../benchmark/scenarios/voice-studio.js';
import type { VoiceEvidence } from './voice-studio-fixtures.js';
import type { VoiceTrace as ProductionRegressionTrace } from './voice-studio-fixtures.js';
const require = createRequire(import.meta.url);
export const enhancementCases: readonly string[] = VOICE_ENHANCEMENT_CASE_IDS;
const hash = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');

// Authored signal, independent of the filters: rumble, voiced tone, sibilant burst,
// quiet/loud phrases and a low-level high-frequency detail that must survive.
export function enhancementWav() {
  const rate = 48000, n = 6 * rate, b = Buffer.alloc(44 + n * 4);
  b.write('RIFF'); b.writeUInt32LE(b.length - 8, 4); b.write('WAVEfmt ', 8); b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20); b.writeUInt16LE(2, 22); b.writeUInt32LE(rate, 24); b.writeUInt32LE(rate * 4, 28);
  b.writeUInt16LE(4, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(n * 4, 40);
  for (let i = 0; i < n; i++) {
    const t = i / rate, tone = (hz: number, gain: number) => gain * Math.sin(2 * Math.PI * hz * t);
    let v = 0;
    if (t >= .4 && t < 1.4) v = tone(40, .12) + tone(440, .15);
    if (t >= 1.4 && t < 2.4) v = tone(440, .12) + tone(8000, .25);
    if (t >= 2.8 && t < 3.8) v = tone(440, .04);
    if (t >= 3.8 && t < 4.8) v = tone(440, .5);
    if (t >= 4.8 && t < 5.6) v = tone(440, .12) + tone(8000, .008);
    const sample = Math.round(v * 32767); b.writeInt16LE(sample, 44 + i * 4); b.writeInt16LE(sample, 46 + i * 4);
  }
  return b;
}
export function enhancementInputs(): Record<string, Buffer | string> {
  const b = enhancementWav();
  return { 'sources/recording.wav': b, 'export-previous/audio.wav': b,
    'voice-project.json': JSON.stringify({ schema_version: 1, roles: {}, segments: [{ id: 'recording', path: 'sources/recording.wav' }] }) };
}
export function decodeEnhancement(file: string) {
  const env = require('../../../src/main/util/bundled-runtime.ts').bundledRuntimeEnv();
  return execFileSync(env.ORKAS_BUNDLED_FFMPEG, ['-v', 'error', '-nostdin', '-i', file, '-ac', '1', '-ar', '48000', '-f', 'f32le', '-'], { timeout: 60000, maxBuffer: 8 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
}
function energy(b: Buffer, start: number, hz = 0) {
  const off = Math.round(start * 48000), n = 9600; let a = 0, c = 0;
  if ((off + n) * 4 > b.length) return NaN;
  for (let i = 0; i < n; i++) {
    const v = b.readFloatLE((off + i) * 4);
    a += hz ? v * Math.cos(2 * Math.PI * hz * i / 48000) : v * v;
    if (hz) c += v * Math.sin(2 * Math.PI * hz * i / 48000);
  }
  return hz ? Math.hypot(a, c) / n : Math.sqrt(a / n);
}
export function enhancementMeasures(b: Buffer) {
  return { duration: b.length / 4 / 48000,
    rumble: energy(b, .8, 40) / energy(b, .8, 440),
    sibilance: energy(b, 1.8, 8000) / energy(b, 1.8, 440),
    detail: energy(b, 5.3, 8000) / energy(b, 5.3, 440),
    dynamics: energy(b, 4.3, 440) / energy(b, 3.3, 440),
    voiced: Math.min(...[.8, 1.8, 3.3, 4.3, 5.3].map(t => energy(b, t, 440))),
    silence: Math.max(...[.1, 2.5, 5.7].map(t => energy(b, t))) };
}
export type EnhancementMeasurements = ReturnType<typeof enhancementMeasures>;
// Thresholds express signal outcomes, not filter coefficients or expected hashes.
export function enhancementMatches(id: string, b: Buffer) {
  const m = enhancementMeasures(b), all = id === 'voice-enhance-combined';
  return Math.abs(m.duration - 6) < .001 && m.voiced > .003 && m.silence < .0001
    && (all || id === 'voice-filter-rumble' ? m.rumble < .35 : Math.abs(m.rumble - .8) < .08)
    && (all || id === 'voice-deess' ? m.sibilance < 1.5 && m.sibilance > .1 : Math.abs(m.sibilance - 2.083) < .15)
    && m.detail > .045 && m.detail < .09
    && (all || id === 'voice-level-dynamics' ? m.dynamics < 8 && m.dynamics > 1.2 : Math.abs(m.dynamics - 12.5) < 1);
}
export function inspectEnhancement(id: string, root: string): VoiceEvidence {
  const base = path.join(root, 'audio'), inputs = enhancementInputs();
  const same = (rel: string) => { try { return hash(fs.readFileSync(path.join(base, rel))) === hash(inputs[rel]); } catch { return false; } };
  const e: VoiceEvidence = { sourcesPreserved: same('sources/recording.wav'), previousPreserved: same('export-previous/audio.wav'), projectValid: false, recordingsPreserved: true, recovered: false, exportCount: 0, decoded: false, contentMatched: false, transcriptCount: 0 };
  // Ratios need their source baseline and units. An absolute .0667 ratio is
  // not evidence of 93% loss: the supplied quiet detail starts at .0667 too.
  try { e.enhancementSource = enhancementMeasures(decodeEnhancement(path.join(base, 'sources/recording.wav'))); } catch {}
  e.enhancementUnits = 'duration: seconds; rumble: 40/440 Hz amplitude ratio at 0.8 s; sibilance: 8000/440 Hz ratio at 1.8 s; detail: 8000/440 Hz ratio at 5.3 s; dynamics: loud/quiet 440 Hz amplitude ratio; voiced: minimum voiced amplitude; silence: maximum pause RMS. Compare enhancement output against enhancementSource input, not against 1.';
  // write_file can preserve an existing project by allocating a suffixed name.
  // Judge a saved revision's data, not whether it overwrote one exact filename.
  const projects = fs.existsSync(base) ? fs.readdirSync(base, { withFileTypes: true }).filter(f => f.isFile() && f.name.endsWith('.json')).slice(0, 32) : [];
  for (const candidate of projects) try {
    const file = path.join(base, candidate.name);
    if (fs.statSync(file).size > 4 * 1024 * 1024) continue;
    const p = JSON.parse(fs.readFileSync(file, 'utf8'));
    const types = p.processing?.map((s: any) => s.type);
    const expected = id === 'voice-filter-rumble' ? ['highpass'] : id === 'voice-deess' ? ['deesser'] : id === 'voice-level-dynamics' ? ['compressor'] : ['highpass', 'deesser', 'compressor'];
    e.projectValid ||= p.schema_version === 2 && p.segments?.length === 1 && p.segments[0].path === 'sources/recording.wav'
      && !p.music && !p.segments[0].denoise && JSON.stringify(types) === JSON.stringify(expected)
      && p.processing.every((s: any) => s.type !== 'deesser' || s.strength === 'standard')
      && p.processing.every((s: any) => s.type !== 'highpass' || (s.frequency_hz ?? 80) === 80);
  } catch {}
  const files: string[] = [];
  function visit(dir: string, depth = 0) {
    if (depth > 6 || !fs.existsSync(dir)) return;
    for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
      if (f.isSymbolicLink() || f.name.startsWith('.') || ['sources', 'export-previous'].includes(f.name)) continue;
      const file = path.join(dir, f.name);
      if (f.isDirectory()) visit(file, depth + 1); else if (f.name.endsWith('.wav')) files.push(file);
    }
  }
  visit(base); e.exportCount = files.length;
  for (const file of files) {
    try {
      const b = decodeEnhancement(file); e.decoded = true; e.duration = b.length / 4 / 48000;
      e.enhancement = enhancementMeasures(b); e.contentMatched ||= enhancementMatches(id, b);
    } catch {}
  }
  return e;
}
export function enhancementChecks(_id: string, t: ProductionRegressionTrace) {
  const e = t.voiceStudio;
  const check = (n: string, pass: boolean) => ({ id: `acceptance:voice-${n}`, pass, critical: true, detail: `Independent enhancement evidence: ${JSON.stringify(e ?? null)}.` });
  return [check('preservation', !!e?.sourcesPreserved && e.previousPreserved && e.projectValid),
    check('local-only', !t.toolCalls.some(c => c.name === 'generate_speech')),
    check('observed-execution', t.toolCalls.some(c => c.isError === false && c.name === 'bash')),
    check('outcome', !!e?.decoded && e.contentMatched && e.exportCount === 1)];
}
