import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import type { VoiceEvidence } from './voice-studio-fixtures.js';
import type { VoiceTrace as ProductionRegressionTrace } from './voice-studio-fixtures.js';
import { publishedVoiceCandidates } from './voice-output-evidence.js';

const require = createRequire(import.meta.url);
export const revisionCase = 'voice-revise-multisegment';
const hash = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');
const lines = ['Opening.', 'The first point.', 'Please speak softly here.', 'The second point.', 'Take a short break.', 'The third point.', 'A final example.', 'Thank you.'];
const starts = [0, 1.2, 2.4, 3.6, 4.8, 6.15, 7.35, 8.55];
function tone(hz: number) {
  const b = Buffer.alloc(32044);
  b.write('RIFF'); b.writeUInt32LE(b.length - 8, 4); b.write('WAVEfmt ', 8); b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(16000, 24); b.writeUInt32LE(32000, 28);
  b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(32000, 40);
  for (let i = 0; i < 16000; i++) b.writeInt16LE(Math.round(3277 * Math.sin(2 * Math.PI * hz * i / 16000)), 44 + i * 2);
  return b;
}
// Frozen, already paid recordings. No generation operation constructs this state.
export function revisionInputs(): Record<string, Buffer | string> {
  const roles = { n: { route_ref: 'prior-route', voice_ref: 'prior-voice', language: 'en', speed: 1 } };
  const segments = lines.map((text, i) => ({ id: `line${i + 1}`, text, role: 'n', gap_after_sec: i === 7 ? 0 : .2 }));
  const attempts: Record<string, unknown> = {};
  const files: Record<string, Buffer | string> = { 'export-previous/audio.wav': tone(1000) };
  for (const [i, segment] of segments.entries()) {
    const key = hash(JSON.stringify({ text: segment.text, ...roles.n, format: 'wav', take: 0 }));
    const file = `speech-${key}.wav`, bytes = tone(300 + i * 80);
    files[file] = bytes;
    attempts[key] = { status: 'ready', path: file, sha256: hash(bytes), duration_sec: 1, sample_rate: 16000, channels: 1 };
  }
  files['voice-project.json'] = JSON.stringify({ schema_version: 3, roles, segments, export: { format: 'wav', channels: 1, sample_rate: 16000, normalize_loudness: false } });
  files['.voice-state.json'] = JSON.stringify({ schema_version: 1, attempts });
  return files;
}
export function inspectRevision(root: string, published?: readonly string[]): VoiceEvidence {
  const base = path.join(root, 'audio'), inputs = revisionInputs();
  const same = (name: string) => { try { return hash(fs.readFileSync(path.join(base, name))) === hash(inputs[name]); } catch { return false; } };
  const e: VoiceEvidence = { sourcesPreserved: true, previousPreserved: same('export-previous/audio.wav'), recordingsPreserved: Object.keys(inputs).filter(k => k.startsWith('speech-')).every(same), projectValid: false, recovered: false, exportCount: 0, decoded: false, contentMatched: false, transcriptCount: 0, narrationPersisted: false, narrationSubtitles: false };
  try {
    const p = JSON.parse(fs.readFileSync(path.join(base, 'voice-project.json'), 'utf8'));
    const state = JSON.parse(fs.readFileSync(path.join(base, '.voice-state.json'), 'utf8'));
    const original = JSON.parse(String(inputs['voice-project.json']));
    e.projectValid = [1, 2, 3].includes(p.schema_version) && p.segments.length === 8
      && !p.processing?.length && !p.music && !p.tracks?.length && p.export?.normalize_loudness === false
      && p.segments.every((s: any, i: number) => s.id === original.segments[i].id && s.text === lines[i]
        && (s.speed ?? 1) === 1 && (s.volume ?? 1) === (i === 2 ? .5 : 1)
        && (s.gap_after_sec ?? 0) === (i === 4 ? .35 : i === 7 ? 0 : .2)
        && !s.start_sec && s.end_sec === undefined && !s.denoise && !s.word_edit && !s.fade_in_sec && !s.fade_out_sec);
    e.narrationPersisted = p.segments.length === 8 && p.segments.every((s: any, i: number) => {
      const role = p.roles[s.role];
      const key = hash(JSON.stringify({ text: s.text, route_ref: role.route_ref, voice_ref: role.voice_ref, language: role.language, speed: role.speed ?? 1, format: 'wav', take: s.take ?? 0 }));
      const record = state.attempts[key];
      return s.text === lines[i] && Object.hasOwn(inputs, record?.path) && same(record.path) && record.status === 'ready' && record.sha256 === hash(inputs[record.path]);
    });
  } catch { /* Missing state or a wrong recording identity cannot establish reuse. */ }
  const candidates: string[] = [], subtitles: string[] = [];
  function visit(dir: string, depth = 0) {
    if (depth > 6 || !fs.existsSync(dir)) return;
    for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
      if (item.isSymbolicLink() || item.name.startsWith('.')) continue;
      const file = path.join(dir, item.name), rel = path.relative(base, file).split(path.sep).join('/');
      if (item.isDirectory()) visit(file, depth + 1);
      else if (/\.wav$/i.test(item.name) && !Object.hasOwn(inputs, rel)) candidates.push(file);
      else if (/\.srt$/i.test(item.name) && !Object.hasOwn(inputs, rel)) subtitles.push(file);
    }
  }
  visit(base); e.exportCount = candidates.length;
  const selected = publishedVoiceCandidates(candidates, published); e.deliveredAudioCount = selected.length;
  if (selected.length !== 1) return e;
  try {
    const env = require('../../../src/main/util/bundled-runtime.ts').bundledRuntimeEnv();
    const r = spawnSync(env.ORKAS_BUNDLED_FFMPEG, ['-v', 'error', '-nostdin', '-i', selected[0], '-ac', '1', '-ar', '16000', '-f', 'f32le', '-'], { timeout: 60000, maxBuffer: 1024 * 1024 });
    if (r.status !== 0 || r.error || r.stderr.length) return e;
    const b = r.stdout; e.decoded = true; e.duration = b.length / 64000;
    const amplitude = (at: number, hz: number) => {
      const offset = Math.round(at * 16000), n = 1600;
      if ((offset + n) * 4 > b.length) return NaN;
      let re = 0, im = 0;
      for (let i = 0; i < n; i++) { const v = b.readFloatLE((offset + i) * 4); re += v * Math.cos(2 * Math.PI * hz * i / 16000); im += v * Math.sin(2 * Math.PI * hz * i / 16000); }
      return Math.hypot(re, im) * 2 / n;
    };
    e.contentMatched = Math.abs(e.duration - 9.55) < .005 && starts.every((start, i) => [.1, .4, .8].every(offset =>
      Math.abs(amplitude(start + offset, 300 + i * 80) - (i === 2 ? .05 : .1)) < .002));
    // Check actual silent gaps too: right frequencies alone can hide overlays.
    e.contentMatched &&= starts.slice(1).every(start => {
      for (let i = Math.round((start - .15) * 16000); i < Math.round((start - .05) * 16000); i++) if (Math.abs(b.readFloatLE(i * 4)) > .0001) return false;
      return true;
    });
    const seconds = (values: string[]) => Number(values[0]) * 3600 + Number(values[1]) * 60 + Number(values[2]) + Number(values[3]) / 1000;
    e.narrationSubtitles = publishedVoiceCandidates(subtitles, published).some(file => {
      if (fs.statSync(file).size > 65536) return false;
      const srt = fs.readFileSync(file, 'utf8');
      const cues = [...srt.matchAll(/(\d{2}):(\d{2}):(\d{2}),(\d{3}) --> (\d{2}):(\d{2}):(\d{2}),(\d{3})\r?\n([^]*?)(?=\r?\n\r?\n|$)/g)];
      return cues.length === 8 && cues.every((c, i) => c[9].trim() === lines[i]
        && Math.abs(seconds(c.slice(1, 5)) - starts[i]) < .005 && Math.abs(seconds(c.slice(5, 9)) - starts[i] - 1) < .005);
    });
  } catch { /* Incomplete artifact evidence stays false; do not infer it from prose. */ }
  return e;
}
export function revisionChecks(trace: ProductionRegressionTrace) {
  const e = trace.voiceStudio;
  const check = (name: string, pass: boolean) => ({ id: `acceptance:voice-${name}`, pass, critical: true, detail: 'Independent eight-recording identities, waveform levels/order, gap clock and subtitle evidence.' });
  return [check('preservation', !!e?.recordingsPreserved && e.previousPreserved && e.projectValid),
    check('local-only', !trace.toolCalls.some(c => c.name === 'generate_speech' && c.op !== 'capabilities')),
    check('observed-execution', trace.toolCalls.some(c => c.name === 'bash' && c.isError === false)),
    check('outcome', !!e?.decoded && e.contentMatched && e.deliveredAudioCount === 1),
    check('narration-persisted', !!e?.narrationPersisted), check('narration-subtitles', !!e?.narrationSubtitles)];
}
