import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { VOICE_CASE_IDS, VOICE_LINES } from '../../benchmark/scenarios/voice-studio.js';
import { fileURLToPath } from 'node:url';
import { startVoiceSpeechProvider } from './voice-speech-provider.js';
export interface VoiceTrace { voiceStudio?: VoiceEvidence; toolCalls: Array<{ name: string; op?: string; isError?: boolean }> }
type ProductionRegressionTrace = VoiceTrace;
import { recordedCases, recordedInputs, inspectRecorded, recordedChecks, type RecordedMeasures } from './voice-recorded-fixtures.js';
import { enhancementCases, enhancementInputs, inspectEnhancement, enhancementChecks, type EnhancementMeasurements } from './voice-enhancement-fixtures.js';
import { processingCases, processingInputs, inspectProcessing, processingChecks } from './voice-processing-fixtures.js';
import {deliveryCases,deliveryInputs,inspectDelivery,deliveryChecks,startLocalDeliveryBoundary} from './voice-delivery-fixtures.js';
import {compositionCases,compositionInputs,inspectComposition,compositionChecks} from './voice-composition-fixtures.js';
import { revisionCase, revisionInputs, inspectRevision, revisionChecks } from './voice-revision-fixture.js';
import { publishedVoiceCandidates, scopedPublishedVoiceFiles } from './voice-output-evidence.js';
import type { ProjectReplayEvidence } from './voice-project-replay.js';
const require = createRequire(import.meta.url);
export const speechFixtureFile = fileURLToPath(new URL('../../../test/fixtures/voice/jfk.wav', import.meta.url));
const speechReference = fs.readFileSync(fileURLToPath(new URL('../../../test/fixtures/voice/jfk.txt', import.meta.url)), 'utf8');
export const narrationCase = (id: string) => ['voice-narration-create', 'voice-revise-text'].includes(id);
export async function prepareVoiceProvider(id: string, root?:string, userId?:string) {
  if (!isVoiceCase(id)) return undefined;
  // Install the deny boundary underneath the explicit fixture routes. A mistaken
  // cloud action must not spend before the trace oracle can reject it.
  const boundary = startLocalDeliveryBoundary();
  try {
    const service = narrationCase(id) ? await startVoiceSpeechProvider(id === 'voice-narration-create'
        ? { [VOICE_LINES[0]]: voiceTone(1,440), [VOICE_LINES[1]]: voiceTone(1,660) }
        : { [VOICE_LINES[2]]: voiceTone(1,880) }) : undefined;
    if (!service) return boundary;
    return {
      ...service,
      snapshot: () => { const snapshot = service.snapshot(); return { ...snapshot, fulfilled: snapshot.fulfilled && boundary.snapshot().fulfilled }; },
      close: async () => { try { await service.close(); } finally { await boundary.close(); } },
    };
  } catch (error) { await boundary.close(); throw error; }
}
const hash = (data: Buffer | string) => createHash('sha256').update(data).digest('hex');
export const isVoiceCase = (id: string) => (VOICE_CASE_IDS as readonly string[]).includes(id) || id === 'voice-revise-pauses-follow-up' || id === 'voice-recorded-rumble-zh-undo';
export const voiceAcceptsLinkedAudio = (id: string) => deliveryCases.includes(id)
  || recordedCases.includes(id)
  || ['voice-recorded-rumble-zh-undo', 'voice-revise-cached', 'voice-preserve-pauses', 'voice-trim-edges', 'voice-all-silent'].includes(id);
export function voiceTone(seconds: number, hz = 440): Buffer {
  const n = Math.round(seconds * 16000), b = Buffer.alloc(44 + n * 2);
  b.write('RIFF'); b.writeUInt32LE(b.length - 8, 4); b.write('WAVEfmt ', 8); b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(16000, 24); b.writeUInt32LE(32000, 28);
  b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) b.writeInt16LE(Math.round(6000 * Math.sin(i * 2 * Math.PI * hz / 16000)), 44 + i * 2);
  return b;
}
// Independent pre-existing project fixture; never calls the implementation under test.
export function voiceInputs(id: string): Record<string, Buffer | string> {
  if (!isVoiceCase(id)) return {};
  if (id === revisionCase) return revisionInputs();
  if (compositionCases.includes(id)) return compositionInputs(id);
  if (deliveryCases.includes(id)) return deliveryInputs(id);
  if (recordedCases.includes(id) || id === 'voice-recorded-rumble-zh-undo') return recordedInputs(id);
  if (enhancementCases.includes(id)) return enhancementInputs();
  if (processingCases.includes(id)) return processingInputs(id);
  const files: Record<string, Buffer | string> = {
    'sources/first.wav': voiceTone(id === 'voice-local-mix' ? 2 : 1),
    'sources/second.wav': voiceTone(1, 660), 'sources/music.wav': voiceTone(0.5, 220),
    'export-previous/audio.wav': voiceTone(0.5, 330),
  };
  let plan: any = { schema_version: 1, roles: {}, segments: [] };
  if (id === 'voice-transcribe-speech') { files['sources/meeting.wav'] = fs.readFileSync(speechFixtureFile); }
  if (id === 'voice-narration-create') { files['script.txt'] = VOICE_LINES.slice(0, 2).join('\n\n'); }
  if (id === 'voice-missing-source') {
    plan.segments = [{ id: 'meeting', path: 'sources/meeting.wav' }];
  } else if (!['voice-local-mix', 'voice-narration-create', 'voice-transcribe-speech'].includes(id)) {
    plan.roles = { a: { route_ref: 'prior-route', voice_ref: 'prior-a', language: 'en', speed: 1 }, b: { route_ref: 'prior-route', voice_ref: 'prior-b', language: 'en', speed: 1 } };
    plan.segments = [{ id: 'first', role: 'a', text: 'First recorded line.', gap_after_sec: 0.2 }, { id: 'second', role: 'b', text: 'Second recorded line.' }];
    if (id === 'voice-revise-text') {
      const ref = 'env:tts:voice:' + hash('env:tts\0en_fixture_reader').slice(0, 20);
      plan.roles = { a: { route_ref: 'env:tts', voice_ref: ref, language: 'en-US', speed: 1 }, b: { route_ref: 'env:tts', voice_ref: ref, language: 'en-US', speed: 1 } };
      plan.segments.forEach((s: any, i: number) => { s.text = VOICE_LINES[i]; });
    }
    const attempts: Record<string, unknown> = {};
    for (const [i, s] of plan.segments.entries()) {
      const r = plan.roles[s.role];
      const key = hash(JSON.stringify({ text: s.text, route_ref: r.route_ref, voice_ref: r.voice_ref, language: r.language, speed: 1, format: 'wav', take: 0 }));
      const file = `speech-${key}.wav`, bytes = voiceTone(1, i ? 660 : 440);
      files[file] = bytes;
      attempts[key] = id === 'voice-recover-recording' && i === 1
        ? { status: 'uncertain', path: file }
        : { status: 'ready', path: file, sha256: hash(bytes), duration_sec: 1, sample_rate: 16000, channels: 1 };
    }
    files['.voice-state.json'] = JSON.stringify({ schema_version: 1, attempts });
  }
  files['voice-project.json'] = JSON.stringify(plan, null, 2);
  return files;
}
export function seedVoiceFixture(id: string, root: string): string | null {
  if (!isVoiceCase(id)) return null;
  for (const [relative, content] of Object.entries(voiceInputs(id))) {
    const file = path.join(root, 'audio', relative);
    fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, content);
  }
  return root;
}
export interface VoiceEvidence { sourcesPreserved: boolean; previousPreserved: boolean; projectValid: boolean; projectReplay?: ProjectReplayEvidence; recordingsPreserved: boolean; recovered: boolean; exportCount: number; deliveredAudioCount?: number; decoded: boolean; contentMatched: boolean; transcriptCount: number; narrationPersisted?: boolean; narrationSubtitles?: boolean; transcript?: { wer: number; timed: boolean; sourceMatched: boolean; consistent: boolean; sourceBinding?: 'output-digest'|'preserved-input-and-content' }; recorded?: RecordedMeasures; enhancement?: EnhancementMeasurements; enhancementSource?: EnhancementMeasurements; enhancementUnits?: string; speech?: { local: boolean; requests: number; fulfilled: boolean; billingRoute?: 'configured-own-account-fixture' }; duration?: number; composition?: Record<string, number>; deliveryMedia?: { codec: string; sampleRate: number; channels: number; bitDepth?: number; sourceSamplesMatch?: boolean }; allSilentSource?: boolean; levelsPreserved?: boolean; }
export function inspectVoiceFixture(id: string, root: string, published?:readonly string[]): VoiceEvidence | undefined {
  if (!isVoiceCase(id)) return undefined;
  if (id === revisionCase) return inspectRevision(root,published);
  if (compositionCases.includes(id)) return inspectComposition(id,root,published);
  if (deliveryCases.includes(id)) return inspectDelivery(id, root, published);
  if (recordedCases.includes(id) || id === 'voice-recorded-rumble-zh-undo') return inspectRecorded(id, root,published);
  if (enhancementCases.includes(id)) return inspectEnhancement(id, root);
  if (processingCases.includes(id)) return inspectProcessing(id, root, published);
  const inputBase = path.join(root, 'audio'), inputs = voiceInputs(id);
  let base = inputBase;
  // New productions may use a topic-named project; only revision tasks bind the existing project.
  if (['voice-local-mix', 'voice-narration-create'].includes(id)) {
    const candidates: string[] = [];
    const findProjects = (dir: string, depth = 0) => {
      if (depth > 6 || !fs.existsSync(dir)) return;
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.isSymbolicLink() || entry.name.startsWith('.')) continue;
        const file = path.join(dir, entry.name);
        if (entry.isDirectory()) findProjects(file, depth + 1);
        else if (entry.name === 'voice-project.json') {
          try { const p = JSON.parse(fs.readFileSync(file, 'utf8')); if ([1, 2, 3].includes(p.schema_version) && p.segments?.length) candidates.push(dir); } catch {}
        }
      }
    };
    findProjects(root);
    if (candidates.length === 1) base = candidates[0];
  }
  const same = (name: string) => { try { return hash(fs.readFileSync(path.join(inputBase, name))) === hash(inputs[name]); } catch { return false; } };
  let projectValid = false, recovered = false;
  const recordedPaths = new Set<string>();
  try {
    const state = JSON.parse(fs.readFileSync(path.join(base, ".voice-state.json"), "utf8"));
    for (const attempt of Object.values(state.attempts || {}) as any[]) if (typeof attempt.path === "string") recordedPaths.add(attempt.path.split(path.sep).join("/"));
  } catch {}
  try { const p = JSON.parse(fs.readFileSync(path.join(base, 'voice-project.json'), 'utf8')); projectValid = [1, 2, 3].includes(p.schema_version) && Array.isArray(p.segments); } catch {}
  try { const s = JSON.parse(fs.readFileSync(path.join(base, '.voice-state.json'), 'utf8')); const expected = JSON.parse(String(inputs['.voice-state.json'])).attempts; recovered = Object.keys(s.attempts).length === 2 && Object.keys(expected).every(k => s.attempts[k]?.status === 'ready' && s.attempts[k]?.sha256 === hash(inputs[expected[k].path]) && s.attempts[k]?.path === expected[k].path); } catch {}
  // Accept any new WAV deliverable under the project; directory naming is not a user requirement.
  const exports: string[] = [], transcripts: string[] = [], texts: string[] = [], srts: string[] = []; let transcriptCount = 0;
  const visit = (dir: string, depth = 0) => {
    if (depth > 8 || !fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name), rel = path.relative(base, file).split(path.sep).join('/');
      if (entry.isSymbolicLink() || rel.startsWith('sources/') || rel.startsWith('export-previous/') || rel.startsWith('.')) continue;
      if (entry.isDirectory()) visit(file, depth + 1);
      else if (/\.wav$/i.test(entry.name) && !Object.hasOwn(inputs, rel) && !recordedPaths.has(rel)) exports.push(file);
      else if (/\.(txt|srt|vtt)$/i.test(entry.name) && !Object.hasOwn(inputs, rel)) transcriptCount++;
      if (entry.isFile() && entry.name === 'transcript.json') transcripts.push(file);
      if (entry.isFile() && !Object.hasOwn(inputs, rel) && /\.txt$/i.test(entry.name)) texts.push(file);
      if (entry.isFile() && /\.srt$/i.test(entry.name)) srts.push(file);
    }
  };
  visit(base);
  const result: VoiceEvidence = { sourcesPreserved: Object.keys(inputs).filter(n => n.startsWith('sources/')).every(same), previousPreserved: same('export-previous/audio.wav'), projectValid, recordingsPreserved: Object.keys(inputs).filter(n => n.startsWith('speech-')).every(same), recovered, exportCount: exports.length, decoded: false, contentMatched: false, transcriptCount };
  const audio = id === 'voice-revise-cached' && published !== undefined
    ? scopedPublishedVoiceFiles(root, published).filter(file => {
      const relative = path.relative(base, file).split(path.sep).join('/');
      return /\.wav$/i.test(file) && !Object.hasOwn(inputs, relative) && !recordedPaths.has(relative);
    })
    : exports;
  if (audio !== exports) result.deliveredAudioCount = audio.length;
  if (narrationCase(id)) {
    result.narrationPersisted = false;
    result.narrationSubtitles = false;
    if (srts.length === 1) {
      const cues = srtSegments(fs.readFileSync(srts[0], 'utf8'));
      const expectedTexts = [VOICE_LINES[0], VOICE_LINES[id === 'voice-revise-text' ? 2 : 1]];
      result.narrationSubtitles = cues.length === 2 && cues.every((cue, index) =>
        wordErrorRate(expectedTexts[index], cue.text) === 0 &&
        Math.abs(cue.start_sec - index * 1.2) < .08 && Math.abs(cue.end_sec - (index * 1.2 + 1)) < .08);
    }
    try {
      const plan = JSON.parse(fs.readFileSync(path.join(base, 'voice-project.json'), 'utf8'));
      const state = JSON.parse(fs.readFileSync(path.join(base, '.voice-state.json'), 'utf8'));
      const expectedTexts = [VOICE_LINES[0], VOICE_LINES[id === 'voice-revise-text' ? 2 : 1]];
      result.narrationPersisted = plan.segments.length === 2 && plan.segments.every((segment: any, index: number) => {
        if (segment.text !== expectedTexts[index]) return false;
        const role = plan.roles[segment.role];
        const key = hash(JSON.stringify({ text: segment.text, route_ref: role.route_ref, voice_ref: role.voice_ref, language: role.language, speed: role.speed ?? 1, format: 'wav', take: segment.take ?? 0 }));
        const record = state.attempts[key];
        return record?.status === 'ready' && recordedPaths.has(record.path) && record.sha256 === hash(fs.readFileSync(path.join(base, record.path)));
      });
    } catch {}
  }
  if (id === 'voice-transcribe-speech') {
    try {
      // Judge the host-delivered pair. Retained drafts are not additional final
      // transcripts; byte-equivalent copies must not invalidate valid delivery.
      const unique = (files: string[]): string[] => {
        if (files.length > 32) return [];
        const found = new Map<string, string>();
        for (const file of files) {
          if (fs.statSync(file).size > 65536) return [];
          const bytes = fs.readFileSync(file, 'utf8').trim();
          if (!found.has(bytes)) found.set(bytes, file);
        }
        return [...found.values()];
      };
      const deliveredTexts = unique(publishedVoiceCandidates(texts, published));
      const deliveredSrts = unique(publishedVoiceCandidates(srts, published));
      if (deliveredTexts.length !== 1 || deliveredSrts.length !== 1) return result;
      const text = fs.readFileSync(deliveredTexts[0], 'utf8'), srt = fs.readFileSync(deliveredSrts[0], 'utf8');
      // A sidecar binds its own subtitle export, not unrelated retained drafts.
      const sidecars = transcripts.filter(file => path.dirname(file) === path.dirname(deliveredSrts[0]));
      if (sidecars.length > 1) return result;
      const hasDigest = sidecars.length === 1;
      const t = hasDigest ? JSON.parse(fs.readFileSync(sidecars[0], 'utf8')) : { text, segments: srtSegments(srt) };
      const measured=inspectTranscript(t,text,srt,hash(inputs['sources/meeting.wav']));
      // TXT/SRT delivery is valid without a JSON receipt. Report its actual
      // evidence basis instead of fabricating a source digest in the output.
      result.transcript={...measured,sourceMatched:hasDigest?measured.sourceMatched:result.sourcesPreserved,
        sourceBinding:hasDigest?'output-digest':'preserved-input-and-content'};
    } catch { /* Missing or malformed transcript remains a failing observation. */ }
  }
  if (audio.length === 1) {
    try {
      const { bundledRuntimeEnv } = require('../../../src/main/util/bundled-runtime.ts');
      const env = bundledRuntimeEnv(), file = audio[0];
      const opts = { encoding: 'utf8' as const, timeout: 60000, maxBuffer: 1024 * 1024 };
      const p = JSON.parse(execFileSync(env.ORKAS_BUNDLED_FFPROBE, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'json', file], opts));
      execFileSync(env.ORKAS_BUNDLED_FFMPEG, ['-v', 'error', '-nostdin', '-i', file, '-f', 'null', '-'], opts);
      result.duration = Number(p.format.duration); result.decoded = true;
      const pcm = execFileSync(env.ORKAS_BUNDLED_FFMPEG, ['-v', 'error', '-nostdin', '-i', file, '-ac', '1', '-ar', '16000', '-f', 'f32le', '-'], { timeout: 60000, maxBuffer: 4 * 1024 * 1024 });
      // Independent spectral oracle: rejects silence, swapped clips and missing music.
      const energy = (start: number, hz: number) => {
        let real = 0, imag = 0; const n = 3200, offset = Math.round(start * 16000);
        if ((offset + n) * 4 > pcm.length) return 0;
        for (let i = 0; i < n; i++) { const v = pcm.readFloatLE((offset + i) * 4), a = 2 * Math.PI * hz * i / 16000; real += v * Math.cos(a); imag += v * Math.sin(a); }
        return Math.hypot(real, imag) / n;
      };
      const secondHz = id === 'voice-revise-text' ? 880 : 660;
      const second = id === 'voice-local-mix' ? 1.6 : 1.5;
      result.contentMatched = energy(0.3, 440) > 0.005 && energy(0.3, 440) > energy(0.3, 660) * 5 && energy(second, secondHz) > 0.005 && energy(second, secondHz) > energy(second, 440) * 5;
      if (id === 'voice-local-mix') result.contentMatched &&= energy(1.1, 220) > 0.0001 && energy(0.3, 220) < energy(0.3, 440) * 0.5;

    } catch { result.decoded = false; }
  }
  return result;
}
export function voiceChecks(id: string, trace: ProductionRegressionTrace) {
  if (!isVoiceCase(id)) return [];
  if (id === revisionCase) return revisionChecks(trace);
  if (compositionCases.includes(id)) return compositionChecks(id,trace);
  if (deliveryCases.includes(id)) return deliveryChecks(id,trace);
  if (recordedCases.includes(id) || id === 'voice-recorded-rumble-zh-undo') return recordedChecks(id, trace);
  if (enhancementCases.includes(id)) return enhancementChecks(id, trace);
  if (processingCases.includes(id)) return processingChecks(id, trace);
  const e = trace.voiceStudio;
  const check = (name: string, pass: boolean) => ({ id: `acceptance:voice-${name}`, pass, critical: true, detail: `Independent audio/file evidence: ${JSON.stringify(e ?? null)}; generated prose is not execution proof.` });
  const expected = id === 'voice-local-mix' ? 2.4 : id === 'voice-revise-cached' ? 3.2 : 2.2;
  return [
    check('preservation', !!e?.sourcesPreserved && e.previousPreserved && e.recordingsPreserved && e.projectValid),
    check('no-synthesis', narrationCase(id) ? !!e?.speech?.fulfilled && trace.toolCalls.filter(c => c.name === 'generate_speech' && c.op !== 'capabilities' && c.isError === false).length === e.speech.requests : !trace.toolCalls.some(c => c.name === 'generate_speech' && c.op !== 'capabilities')),
    check('observed-execution', trace.toolCalls.some(c => c.isError === false && ['read_files', 'bash'].includes(c.name))),
    check('outcome', id === 'voice-transcribe-speech' ? !!e?.transcript && e.transcript.wer <= 0.15 && e.transcript.timed && e.transcript.sourceMatched && e.transcript.consistent : id === 'voice-missing-source' ? e?.exportCount === 0 && e.transcriptCount === 0 : !!e?.decoded && e.contentMatched && (e.deliveredAudioCount ?? e.exportCount) === 1 && Math.abs((e.duration ?? -1) - expected) < 0.08),
    ...(narrationCase(id) ? [check('narration-persisted', !!e?.narrationPersisted), check('narration-subtitles', !!e?.narrationSubtitles)] : []),
    ...(id === 'voice-recover-recording' ? [check('recording-recovered', !!e?.recovered)] : []),
  ];
}

export function wordErrorRate(reference: string, actual: string): number {
  const words = (text: string) => text.toLowerCase().match(/[a-z0-9]+/g) || [];
  const a = words(reference), b = words(actual);
  if (b.length > 5000) return Infinity;
  let row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const next = [i];
    for (let j = 1; j <= b.length; j++) next[j] = Math.min(next[j - 1] + 1, row[j] + 1, row[j - 1] + Number(a[i - 1] !== b[j - 1]));
    row = next;
  }
  return row[b.length] / Math.max(a.length, 1);
}
function srtSegments(srt: string) {
  return [...srt.matchAll(/(\d{2}):(\d{2}):(\d{2}),(\d{3}) --> (\d{2}):(\d{2}):(\d{2}),(\d{3})\r?\n([^]*?)(?=\r?\n\r?\n|$)/g)].map(c => ({
    start_sec: Number(c[1]) * 3600 + Number(c[2]) * 60 + Number(c[3]) + Number(c[4]) / 1000,
    end_sec: Number(c[5]) * 3600 + Number(c[6]) * 60 + Number(c[7]) + Number(c[8]) / 1000, text: c[9],
  }));
}
export function inspectTranscript(json: any, text: string, srt: string, sourceHash: string) {
  const cues = [...srt.matchAll(/(\d{2}):(\d{2}):(\d{2}),(\d{3}) --> (\d{2}):(\d{2}):(\d{2}),(\d{3})\r?\n([^]*?)(?=\r?\n\r?\n|$)/g)];
  const clock = (a: string[]) => Number(a[0]) * 3600 + Number(a[1]) * 60 + Number(a[2]) + Number(a[3]) / 1000;
  const segments = json.segments;
  const timed = Array.isArray(segments) && segments.length > 0 && segments.length === cues.length && segments.every((s: any, i: number) =>
    Number.isFinite(s.start_sec) && Number.isFinite(s.end_sec) && s.start_sec >= (i ? segments[i - 1].end_sec : 0) && s.end_sec > s.start_sec && s.end_sec <= 11.5 &&
    Math.abs(s.start_sec - clock(cues[i].slice(1, 5))) < .005 && Math.abs(s.end_sec - clock(cues[i].slice(5, 9))) < .005);
  const normalize = (value: string) => (value.toLowerCase().match(/[\p{L}\p{N}]+/gu) || []).join(' ');
  const consistent = normalize(text) === normalize(String(json.text || '')) && normalize(text) === normalize(cues.map(c => c[9]).join(' '));
  return { consistent, wer: Math.max(wordErrorRate(speechReference, text), wordErrorRate(speechReference, cues.map(c => c[9]).join(' ')), wordErrorRate(speechReference, String(json.text || ''))), timed, sourceMatched: json.source_sha256 === sourceHash };
}
