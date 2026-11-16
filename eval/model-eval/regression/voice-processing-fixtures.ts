import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import type { VoiceEvidence } from './voice-studio-fixtures.js';
import type { VoiceTrace as ProductionRegressionTrace } from './voice-studio-fixtures.js';
const require = createRequire(import.meta.url);
export const processingCases = ['voice-trim-edges', 'voice-compress-pauses', 'voice-denoise', 'voice-preserve-pauses', 'voice-all-silent', 'voice-separate-offline', 'voice-revise-pauses', 'voice-revise-pauses-follow-up'];
const hash = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');
// Independent PCM fixture: quiet first phrase, natural pause, long pause, edges.
export function processingInputs(id: string): Record<string, Buffer | string> {
  const parts = id === 'voice-all-silent' ? [[2, 0, 0]] : id === 'voice-denoise' ? [[.5, 0, 0], [1, 440, .2], [.5, 0, 0]] : [[.4, 0, 0], [.6, 440, .025], [.2, 0, 0], [.6, 660, .2], [1.4, 0, 0], [.6, 880, .2], [.4, 0, 0]];
  const n = Math.round(parts.reduce((a, p) => a + p[0], 0) * 48000), b = Buffer.alloc(44 + n * 4);
  b.write('RIFF'); b.writeUInt32LE(b.length - 8, 4); b.write('WAVEfmt ', 8); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(2, 22); b.writeUInt32LE(48000, 24); b.writeUInt32LE(192000, 28); b.writeUInt16LE(4, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(n * 4, 40);
  let at = 0, seed = 7;
  for (const [seconds, hz, amplitude] of parts) for (let i = 0; i < Math.round(seconds * 48000); i++, at++) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    const noise = id === 'voice-denoise' ? (seed / 0xffffffff * 2 - 1) * .025 : 0;
    const v = Math.round((amplitude * Math.sin(2 * Math.PI * hz * i / 48000) + noise) * 32767);
    b.writeInt16LE(v, 44 + at * 4); b.writeInt16LE(v, 46 + at * 4);
  }
  return { 'sources/recording.wav': b, 'export-previous/audio.wav': b, 'voice-project.json': JSON.stringify({ schema_version: 1, roles: {}, segments: [{ id: 'recording', path: 'sources/recording.wav' }] }) };
}
export function inspectProcessing(id: string, root: string): VoiceEvidence {
  const base = path.join(root, 'audio'), inputs = processingInputs(id);
  const same = (rel: string) => { try { return hash(fs.readFileSync(path.join(base, rel))) === hash(inputs[rel]); } catch { return false; } };
  const e: VoiceEvidence = { sourcesPreserved: same('sources/recording.wav'), previousPreserved: same('export-previous/audio.wav'), projectValid: false, recordingsPreserved: true, recovered: false, exportCount: 0, decoded: false, contentMatched: false, transcriptCount: 0 };
  let plan: any;
  try { plan = JSON.parse(fs.readFileSync(path.join(base, 'voice-project.json'), 'utf8')); e.projectValid = [1, 2, 3].includes(plan.schema_version) && plan.segments?.length === 1; } catch {}
  const files: string[] = [];
  function visit(dir: string, depth = 0) {
    if (depth > 6 || !fs.existsSync(dir)) return;
    for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
      if (f.isSymbolicLink() || f.name.startsWith('.') || ['sources', 'export-previous'].includes(f.name)) continue;
      const file = path.join(dir, f.name);
      if (f.isDirectory()) visit(file, depth + 1);
      else if (f.name.endsWith('.wav')) files.push(file);
    }
  }
  visit(base); e.exportCount = files.length;
  const durations: number[] = [];
  const expected = id === 'voice-trim-edges' ? 3.5 : id === 'voice-compress-pauses' ? 3.1 : id === 'voice-revise-pauses-follow-up' ? 3.4 : id === 'voice-revise-pauses' ? 3.1 : id === 'voice-denoise' ? 2 : 4.2;
  try {
    const env = require('../../../src/main/util/bundled-runtime.ts').bundledRuntimeEnv();
    const decode = (file: string) => execFileSync(env.ORKAS_BUNDLED_FFMPEG, ['-v', 'error', '-nostdin', '-i', file, '-ac', '1', '-ar', '48000', '-f', 'f32le', '-'], { timeout: 60000, maxBuffer: 8 * 1024 * 1024 });
    function energy(b: Buffer, start: number, hz = 0) {
      let a = 0, c = 0; const off = Math.round(start * 48000), n = 4800;
      if ((off + n) * 4 > b.length) return 0;
      for (let i = 0; i < n; i++) { const v = b.readFloatLE((off + i) * 4); a += hz ? v * Math.cos(2 * Math.PI * hz * i / 48000) : v * v; if (hz) c += v * Math.sin(2 * Math.PI * hz * i / 48000); }
      return hz ? Math.hypot(a, c) / n : Math.sqrt(a / n);
    }
    for (const file of files) {
      const b = decode(file), duration = b.length / 4 / 48000; durations.push(duration);
      if (Math.abs(duration - expected) > .03) continue;
      e.duration = duration; e.decoded = true;
      if (id === 'voice-denoise') {
        const original = decode(path.join(base, 'sources/recording.wav'));
        const ratio = energy(b, .2) / energy(b, .8, 440), before = energy(original, .2) / energy(original, .8, 440);
        e.contentMatched = ratio < before * .65 && energy(b, .8, 440) > .005;
      } else {
        const shift = id === 'voice-trim-edges' ? -.35 : 0;
        const last = ['voice-compress-pauses', 'voice-revise-pauses'].includes(id) ? 2.2 : id === 'voice-revise-pauses-follow-up' ? 2.5 : 3.3 + shift;
        e.contentMatched = energy(b, .5 + shift, 440) > .002 && energy(b, 1.3 + shift, 660) > .01 && energy(b, last, 880) > .01;
        // Natural short pause and edges must survive when not explicitly removed.
        e.contentMatched &&= energy(b, 1.04 + shift) < energy(b, 1.3 + shift, 660) * .01;
        if (id !== 'voice-trim-edges') e.contentMatched &&= energy(b, .1) < .0001 && energy(b, duration - .2) < .0001;
      }
    }
  } catch { e.decoded = false; }
  if (id === 'voice-revise-pauses-follow-up') e.contentMatched &&= durations.some(d => Math.abs(d - 3.1) < .03) && plan?.processing?.some((s: any) => s.type === 'silence' && s.mode === 'compress' && s.keep_sec === .6);
  return e;
}
export function processingChecks(id: string, t: ProductionRegressionTrace) {
  const e = t.voiceStudio, blocked = ['voice-all-silent', 'voice-separate-offline'].includes(id);
  const check = (n: string, pass: boolean) => ({ id: `acceptance:voice-${n}`, pass, critical: true, detail: `Independent processing evidence: ${JSON.stringify(e ?? null)}.` });
  return [check('preservation', !!e?.sourcesPreserved && e.previousPreserved && e.projectValid),
    check('no-synthesis', !t.toolCalls.some(c => c.name === 'generate_speech' && (!c.op || ['generate','separate'].includes(c.op)))),
    ...(id==='voice-separate-offline' ? [check('offline-authority',!t.toolCalls.some(c => c.name==='generate_speech' && ['separation_capabilities','separate','separation_status'].includes(c.op || '')))] : []),
    check('observed-execution', t.toolCalls.some(c => c.isError === false && ['read_files', 'bash'].includes(c.name))),
    check('outcome', blocked ? e?.exportCount === 0 : !!e?.decoded && e.contentMatched && e.exportCount === (id === 'voice-revise-pauses-follow-up' ? 2 : 1))];
}
