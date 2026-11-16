import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const script = fileURLToPath(new URL('../../../resources/builtin/marketplace/agents/5f890bd72ac4/skills/voice-project/scripts/audio.js', import.meta.url));
const mediaInput = ['-protocol_whitelist', 'file,pipe', '-format_whitelist', 'wav,mp3,flac,ogg,mov,matroska,webm,aac,avi,mpegts,asf,aiff'];
export interface ProjectReplayEvidence {
  matched: boolean;
  candidates: number;
  attempted: number;
  reason: 'matched' | 'unavailable' | 'no-match' | 'budget';
  // Encoding is a one-off lossless export; saved edits/treatment are unchanged.
  encoding: 'wav';
  maxSampleError?: number;
}
class ReplayBudget extends Error {}

/** Evaluator-only render in a fresh directory/process. Never executes workspace
 * scripts, synthesis or queries; no actor export, source or cache is mutated. */
export function inspectProjectReplay(base: string, projects: readonly string[], delivered: string): ProjectReplayEvidence {
  const evidence: ProjectReplayEvidence = { matched: false, candidates: projects.length, attempted: 0, reason: 'unavailable', encoding: 'wav' };
  if (!projects.length) return evidence;
  // These short recorded/composition fixtures need no unbounded project runner.
  if (projects.length > 8) return { ...evidence, reason: 'budget' };
  const start = performance.now();
  const timeout = () => { const ms = 15000 - (performance.now() - start); if (ms < 1) throw new ReplayBudget(); return Math.ceil(ms); };
  const { bundledRuntimeEnv, bundledNodeExecutable } = require('../../../src/main/util/bundled-runtime.ts');
  const env = { ...process.env, ...bundledRuntimeEnv() }, node = bundledNodeExecutable();
  const call = (exe: string, args: string[], maxBuffer = 65536) => {
    const result = spawnSync(exe, args, { env, timeout: timeout(), maxBuffer, stdio: ['ignore', 'pipe', 'pipe'] });
    // A successful exit cannot hide warnings or unclassified direct-child stderr.
    // Never persist the raw diagnostic, which can contain private input paths.
    if (result.error || result.status !== 0 || result.stderr?.length) throw new Error('Replay subprocess did not verify cleanly.');
    return result.stdout;
  };
  let scope: string;
  try { scope = fs.realpathSync(base); } catch { return evidence; }
  function scoped(root: string, relative: unknown) {
    if (typeof relative !== 'string' || !relative || path.isAbsolute(relative) || relative.includes('\0')) throw new Error('scope');
    const file = path.resolve(root, relative), real = fs.realpathSync(file);
    if (!file.startsWith(root + path.sep) || !real.startsWith(root + path.sep) || !fs.statSync(file).isFile()) throw new Error('scope');
    return file;
  }
  function probe(file: string) {
    const m = JSON.parse(call(env.ORKAS_BUNDLED_FFPROBE, ['-v', 'error', ...mediaInput, '-show_streams', '-show_format', '-of', 'json', file]).toString());
    const streams = m.streams?.filter((s: any) => s.codec_type === 'audio'), duration = Number(m.format?.duration);
    if (streams?.length !== 1 || ![1, 2].includes(streams[0].channels) || !Number.isFinite(duration) || duration <= 0 || duration > 30) throw new ReplayBudget();
    return { channels: streams[0].channels, rate: Number(streams[0].sample_rate), duration };
  }
  const decode = (file: string) => call(env.ORKAS_BUNDLED_FFMPEG, ['-v', 'error', '-nostdin', ...mediaInput, '-i', file, '-map', '0:a:0', '-f', 'f32le', '-'], 32 * 1024 * 1024);
  let outputMeta: ReturnType<typeof probe>, expected: Buffer;
  try {
    if (!node || !fs.realpathSync(delivered).startsWith(scope + path.sep)) return evidence;
    outputMeta = probe(delivered); expected = decode(delivered);
  } catch (err) { return { ...evidence, reason: err instanceof ReplayBudget ? 'budget' : 'unavailable' }; }
  for (const file of projects) {
    let temp: string | undefined;
    try {
      timeout();
      if (!fs.realpathSync(file).startsWith(scope + path.sep) || !fs.lstatSync(file).isFile()) continue;
      if (fs.statSync(file).size > 4 * 1024 * 1024) throw new ReplayBudget();
      const p = JSON.parse(fs.readFileSync(file, 'utf8')), owner = fs.realpathSync(path.dirname(file));
      if (!Array.isArray(p.segments) || !p.segments.length || p.segments.some((s: any) => typeof s.path !== 'string')) continue;
      if (p.segments.length > 64 || (p.tracks?.length ?? 0) > 32) throw new ReplayBudget();
      const refs = new Set<string>(), durations = new Map<string, number>(); let bytes = 0, work = 0, duration = 0;
      const admit = (relative: string, media: boolean) => {
        if (!refs.has(relative)) {
          const source = scoped(owner, relative); bytes += fs.statSync(source).size;
          if (bytes > 32 * 1024 * 1024 || refs.size >= 128) throw new ReplayBudget();
          refs.add(relative);
        }
        if (media && !durations.has(relative)) durations.set(relative, probe(scoped(owner, relative)).duration);
      };
      for (const s of p.segments) {
        admit(s.path, true); if (s.word_edit) admit(s.word_edit.transcript_path, false);
        const seconds = ((s.end_sec ?? durations.get(s.path)!) - (s.start_sec ?? 0)) / (s.speed ?? 1) + (s.gap_after_sec ?? 0);
        duration += seconds; work += durations.get(s.path)!;
      }
      for (const t of [...(p.music ? [p.music] : []), ...(p.tracks ?? [])]) {
        admit(t.path, true);
        const seconds = t.duration_sec ?? (t === p.music ? duration : (t.end_sec ?? durations.get(t.path)!) - (t.start_sec ?? 0));
        duration = Math.max(duration, (t.at_sec ?? 0) + seconds); work += seconds * 2 + durations.get(t.path)!;
      }
      if (!Number.isFinite(duration) || duration > 30 || !Number.isFinite(work) || work > 120) throw new ReplayBudget();
      temp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'voice-project-replay-')));
      for (const relative of refs) {
        const dest = path.join(temp, relative); fs.mkdirSync(path.dirname(dest), { recursive: true }); fs.copyFileSync(scoped(owner, relative), dest);
      }
      // A format-only re-export is permitted by the existing operation contract.
      // Strip lossy bitrate solely for the lossless probe, never edit treatment.
      if (p.export) { p.export.format = 'wav'; delete p.export.bitrate_kbps; }
      const project = path.join(temp, '.replay-project.json'), request = path.join(temp, '.replay-request.json');
      fs.writeFileSync(project, JSON.stringify(p)); fs.writeFileSync(request, JSON.stringify({ project, format: 'wav' }));
      evidence.attempted++;
      const result = JSON.parse(call(node!, [script, 'render', request]).toString());
      if (result.ok !== true) continue;
      const replay = scoped(temp, result.files?.[0]), meta = probe(replay);
      if (meta.channels !== outputMeta.channels || meta.rate !== outputMeta.rate) continue;
      const actual = decode(replay); if (actual.length !== expected.length) continue;
      let max = 0;
      for (let i = 0; i < actual.length; i += 4) {
        const difference = Math.abs(actual.readFloatLE(i) - expected.readFloatLE(i));
        if (!Number.isFinite(difference)) { max = Infinity; break; } max = Math.max(max, difference);
      }
      if (Number.isFinite(max)) evidence.maxSampleError = max;
      if (max <= 1 / 32768) return { ...evidence, matched: true, reason: 'matched' };
    } catch (err) { if (err instanceof ReplayBudget) evidence.reason = 'budget'; }
    finally { if (temp) fs.rmSync(temp, { recursive: true, force: true }); }
  }
  return { ...evidence, reason: evidence.reason === 'budget' ? 'budget' : 'no-match' };
}
