/**
 * Detect repeated or cut-off narration in the delivered mix. Fingerprints
 * locate a line by sound, then waveform correlation checks the amount played.
 */
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { createLogger } from '../logger';
import { isPathAllowed } from '../util/path-sandbox';
import { runVideoProcessForTest } from './video_studio';

const log = createLogger('video-narration-playback');

type Pcm = { rate: number; samples: Float32Array };
type AlignedSegment = { outStart: number; outEnd: number; offset: number };
type AudioAlignment = { segments: AlignedSegment[]; heard: Uint8Array; sourceSpeech: Uint8Array };
type Issue = { code: string; severity: 'error' | 'warning'; message: string };

// Fingerprints: 16 log-spaced bands from 200 Hz to 3.8 kHz over 32 ms frames every 8 ms;
// bit b is the sign of the change in the energy difference between bands b and b+1.
const FP_RATE = 8000;
const FP_FRAME = 256;
const FP_HOP = 64;
const FP_BANDS = 16;
const BLOCK = 48;
const BLOCK_HOP = 8;
const WINDOW_SECONDS = 0.01;
const POPCOUNT = (() => {
  const table = new Uint8Array(1 << 15);
  for (let value = 1; value < table.length; value += 1) table[value] = (value & 1) + table[value >> 1];
  return table;
})();

/** Delivery is bounded like the evaluation: up to 180 s of delivered sound, 32 lines of at most
 *  60 s, and a total amount of matching that stays within a few seconds of work. */
const MAX_DELIVERY_SEC = 180;
const MAX_LINES = 32;
const MAX_LINE_SEC = 60;
const MAX_WORK = 6000; // delivered seconds × seconds of narration matched against them
const DECODE_TIMEOUT_MS = 2 * 60_000;
/** A line counts as played where at least half of its spoken windows are heard at one offset. */
const PLAYED_SHARE = 0.5;
/** Below this a line was a draft that never reached the video. */
const DRAFT_SHARE = 0.02;
/** A line stops early when its heard words end this long before its own last word. */
const CUT_MIN_SEC = 0.3;
const MAX_ORIGINAL_CLIPS = 8;
const MAX_ORIGINAL_CLIP_SEC = 12;
const MAX_ORIGINAL_AUDIO_SEC = 36;
const ORIGINAL_CHECK_TIMEOUT_MS = 4000;
const ORIGINAL_SYNC_TOLERANCE_SEC = 0.2;
const ORIGINAL_MATCH_SHARE = 0.6;

function fft(re: Float64Array, im: Float64Array): void {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i += 1) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; }
  }
  for (let size = 2; size <= n; size <<= 1) {
    const angle = -2 * Math.PI / size;
    for (let start = 0; start < n; start += size) {
      for (let k = 0; k < size / 2; k += 1) {
        const wr = Math.cos(angle * k); const wi = Math.sin(angle * k);
        const a = start + k; const b = a + size / 2;
        const tr = re[b] * wr - im[b] * wi; const ti = re[b] * wi + im[b] * wr;
        re[b] = re[a] - tr; im[b] = im[a] - ti; re[a] += tr; im[a] += ti;
      }
    }
  }
}

type Fingerprint = { bits: Uint16Array; energyDb: Float32Array };

function fingerprint(pcm: Pcm): Fingerprint {
  const frames = Math.max(0, Math.floor((pcm.samples.length - FP_FRAME) / FP_HOP) + 1);
  const edges = Array.from({ length: FP_BANDS + 1 }, (_v, index) => 200 * (3800 / 200) ** (index / FP_BANDS));
  const binOf = (hz: number) => Math.round(hz * FP_FRAME / FP_RATE);
  const window = Float64Array.from({ length: FP_FRAME }, (_v, index) => 0.5 - 0.5 * Math.cos(2 * Math.PI * index / FP_FRAME));
  const bands = new Float64Array(frames * FP_BANDS);
  const energyDb = new Float32Array(frames);
  const re = new Float64Array(FP_FRAME); const im = new Float64Array(FP_FRAME);
  for (let frame = 0; frame < frames; frame += 1) {
    let total = 0;
    for (let index = 0; index < FP_FRAME; index += 1) {
      const sample = pcm.samples[frame * FP_HOP + index];
      re[index] = sample * window[index]; im[index] = 0; total += sample * sample;
    }
    energyDb[frame] = 10 * Math.log10(total / FP_FRAME + 1e-12);
    fft(re, im);
    for (let band = 0; band < FP_BANDS; band += 1) {
      let energy = 0;
      for (let bin = binOf(edges[band]); bin < Math.max(binOf(edges[band]) + 1, binOf(edges[band + 1])); bin += 1) energy += re[bin] ** 2 + im[bin] ** 2;
      bands[frame * FP_BANDS + band] = Math.log(energy + 1e-12);
    }
  }
  const bits = new Uint16Array(frames);
  for (let frame = 1; frame < frames; frame += 1) {
    let value = 0;
    for (let band = 0; band < FP_BANDS - 1; band += 1) {
      const now = bands[frame * FP_BANDS + band] - bands[frame * FP_BANDS + band + 1];
      const before = bands[(frame - 1) * FP_BANDS + band] - bands[(frame - 1) * FP_BANDS + band + 1];
      if (now - before > 0) value |= 1 << band;
    }
    bits[frame] = value;
  }
  return { bits, energyDb };
}

/** Fingerprint matches for each loud output block: up to four distinct source positions. */
function blockCandidates(out: Fingerprint, src: Fingerprint): Array<{ frame: number; options: Array<{ offsetFrames: number; ber: number }> }> {
  const total = BLOCK * (FP_BANDS - 1);
  const blocks: Array<{ frame: number; options: Array<{ offsetFrames: number; ber: number }> }> = [];
  const errors = new Uint16Array(Math.max(0, src.bits.length - BLOCK));
  for (let start = 1; start + BLOCK <= out.bits.length; start += BLOCK_HOP) {
    let loud = 0;
    for (let index = start; index < start + BLOCK; index += 1) if (out.energyDb[index] > -45) loud += 1;
    if (loud < BLOCK / 3) continue;
    for (let candidate = 1; candidate + BLOCK <= src.bits.length; candidate += 1) {
      let count = 0;
      for (let index = 0; index < BLOCK; index += 1) count += POPCOUNT[out.bits[start + index] ^ src.bits[candidate + index]];
      errors[candidate] = count;
    }
    const options: Array<{ offsetFrames: number; ber: number }> = [];
    const taken: number[] = [];
    for (let pick = 0; pick < 4; pick += 1) {
      let best = Infinity; let bestAt = -1;
      for (let candidate = 1; candidate + BLOCK <= src.bits.length; candidate += 1) {
        if (errors[candidate] < best && taken.every((at) => Math.abs(at - candidate) > BLOCK / 2)) { best = errors[candidate]; bestAt = candidate; }
      }
      if (bestAt < 0 || best / total >= 0.3) break;
      taken.push(bestAt);
      options.push({ offsetFrames: bestAt - start, ber: best / total });
    }
    if (options.length) blocks.push({ frame: start, options });
  }
  return blocks;
}

/** One offset per block, preferring continuity: a phrase spoken twice matches two places
 *  equally well, and its neighbours decide which one is playing. */
function chooseOffsets(blocks: ReturnType<typeof blockCandidates>): Array<{ frame: number; offsetFrames: number }> {
  if (!blocks.length) return [];
  const SWITCH = 0.08;
  const costs = blocks.map((block) => block.options.map((option) => option.ber));
  const back: number[][] = blocks.map((block) => block.options.map(() => -1));
  for (let index = 1; index < blocks.length; index += 1) {
    const contiguous = blocks[index].frame - blocks[index - 1].frame <= BLOCK_HOP * 3;
    blocks[index].options.forEach((option, current) => {
      let best = Infinity; let from = -1;
      blocks[index - 1].options.forEach((previous, prior) => {
        const same = contiguous && Math.abs(previous.offsetFrames - option.offsetFrames) <= 2;
        const cost = costs[index - 1][prior] + (same ? 0 : SWITCH);
        if (cost < best) { best = cost; from = prior; }
      });
      costs[index][current] = best + option.ber;
      back[index][current] = from;
    });
  }
  const chosen: Array<{ frame: number; offsetFrames: number }> = [];
  let state = costs[blocks.length - 1].indexOf(Math.min(...costs[blocks.length - 1]));
  for (let index = blocks.length - 1; index >= 0; index -= 1) {
    chosen.unshift({ frame: blocks[index].frame, offsetFrames: blocks[index].options[state].offsetFrames });
    state = back[index][state];
  }
  return chosen;
}

/** The output read from four starting points a quarter step apart; the reading that hears the
 *  most is kept, so a line placed between two fingerprint steps still matches. */
function alignPcm(output: Pcm, source: Pcm): AudioAlignment {
  let best: AudioAlignment | null = null;
  let bestHeard = -1;
  for (const phase of [0, FP_HOP / 4, FP_HOP / 2, (3 * FP_HOP) / 4]) {
    const aligned = alignAtPhase({ rate: output.rate, samples: output.samples.subarray(phase) }, source);
    const shift = phase / FP_RATE;
    const segments = aligned.segments.map((segment) => ({ outStart: segment.outStart + shift, outEnd: segment.outEnd + shift, offset: segment.offset - shift }));
    const heard = segments.reduce((sum, segment) => sum + segment.outEnd - segment.outStart, 0);
    if (heard > bestHeard + 0.05) { best = { ...aligned, segments }; bestHeard = heard; }
  }
  return best!;
}

function alignAtPhase(output: Pcm, source: Pcm): AudioAlignment {
  const out = fingerprint(output);
  const src = fingerprint(source);
  const matches = chooseOffsets(blockCandidates(out, src));
  const coarse: Array<{ first: number; last: number; offsetFrames: number }> = [];
  for (const match of matches) {
    const last = coarse[coarse.length - 1];
    if (last && Math.abs(match.offsetFrames - last.offsetFrames) <= 2 && match.frame - last.last <= BLOCK_HOP * 3) {
      last.last = match.frame;
    } else {
      coarse.push({ first: match.frame, last: match.frame, offsetFrames: match.offsetFrames });
    }
  }
  const segments: AlignedSegment[] = [];
  const windowSamples = Math.round(WINDOW_SECONDS * FP_RATE);
  const sourceWindows = Math.floor(source.samples.length / windowSamples);
  const heard = new Uint8Array(sourceWindows);
  const sourceSpeech = new Uint8Array(sourceWindows);
  for (let window = 0; window < sourceWindows; window += 1) {
    sourceSpeech[window] = rms(source.samples, window * windowSamples, windowSamples) > 0.02 ? 1 : 0;
  }
  // A stretch needs three agreeing blocks: one or two can land on a phrase the source says twice.
  for (const stretch of coarse.filter((item) => item.last - item.first >= 2 * BLOCK_HOP)) {
    const outFrom = Math.max(0, (stretch.first - BLOCK) * FP_HOP);
    const outTo = Math.min(output.samples.length, (stretch.last + 2 * BLOCK) * FP_HOP);
    const coarseOffset = stretch.offsetFrames * FP_HOP;
    let bestOffset = coarseOffset; let bestScore = -Infinity;
    for (let delta = -FP_HOP; delta <= FP_HOP; delta += 1) {
      const score = correlation(output.samples, source.samples, (stretch.first + BLOCK / 2) * FP_HOP, BLOCK * FP_HOP, coarseOffset + delta);
      if (score > bestScore) { bestScore = score; bestOffset = coarseOffset + delta; }
    }
    let runStart = -1;
    const flush = (endSample: number) => {
      if (runStart >= 0 && endSample - runStart >= windowSamples * 5) {
        segments.push({ outStart: runStart / FP_RATE, outEnd: endSample / FP_RATE, offset: bestOffset / FP_RATE });
      }
      runStart = -1;
    };
    for (let at = outFrom; at + windowSamples <= outTo; at += windowSamples) {
      const sourceAt = at + bestOffset;
      if (sourceAt < 0 || sourceAt + windowSamples > source.samples.length) { flush(at); continue; }
      const sourceWindow = Math.floor(sourceAt / windowSamples);
      const quiet = rms(source.samples, sourceAt, windowSamples) < 0.02;
      const matched = !quiet && correlation(output.samples, source.samples, at, windowSamples, bestOffset) > 0.5;
      if (matched) {
        heard[sourceWindow] = 1;
        if (runStart < 0) runStart = at;
      } else if (!quiet) {
        flush(at);
      }
    }
    flush(outTo);
  }
  return { segments: mergeSegments(segments), heard, sourceSpeech };
}

function mergeSegments(segments: AlignedSegment[]): AlignedSegment[] {
  const sorted = [...segments].sort((a, b) => a.outStart - b.outStart);
  const merged: AlignedSegment[] = [];
  for (const segment of sorted) {
    const last = merged[merged.length - 1];
    if (last && Math.abs(last.offset - segment.offset) < 0.004 && segment.outStart - last.outEnd < 0.6) last.outEnd = Math.max(last.outEnd, segment.outEnd);
    else merged.push({ ...segment });
  }
  return merged;
}

function rms(samples: Float32Array, start: number, length: number): number {
  let energy = 0;
  for (let index = start; index < start + length; index += 1) energy += samples[index] ** 2;
  return Math.sqrt(energy / length);
}

function correlation(output: Float32Array, source: Float32Array, start: number, length: number, offset: number): number {
  let dot = 0; let outEnergy = 0; let srcEnergy = 0;
  for (let index = start; index < start + length; index += 1) {
    const sourceIndex = index + offset;
    if (index < 0 || index >= output.length || sourceIndex < 0 || sourceIndex >= source.length) return 0;
    dot += output[index] * source[sourceIndex];
    outEnergy += output[index] ** 2;
    srcEnergy += source[sourceIndex] ** 2;
  }
  return outEnergy && srcEnergy ? dot / Math.sqrt(outEnergy * srcEnergy) : 0;
}

/** Share of the source's spoken 10 ms windows marked heard. */
function spokenShare(heard: Uint8Array, speech: Uint8Array): number {
  let spoken = 0; let found = 0;
  for (let window = 0; window < speech.length; window += 1) {
    if (!speech[window]) continue;
    spoken += 1;
    if (heard[window]) found += 1;
  }
  return spoken ? found / spoken : 0;
}

/** One playback of a line: the delivered stretch at one offset, and which of its words it plays. */
export type LinePlayback = {
  share: number;
  /** Seconds of the line's own speech heard in this playback. */
  heardSec: number;
  outStart: number;
  outEnd: number;
  /** Source timestamp minus output timestamp for the matching sound. */
  offsetSec: number;
  /** Seconds of the line's own speech after the last word heard in this playback. */
  missingTailSec: number;
  windows: Uint8Array;
};

/**
 * The places one line plays in the delivered sound. A playback is one constant offset: a line
 * placed twice is two playbacks, never one union that would hide the repeat.
 */
export function linePlaybacks(output: Pcm, source: Pcm): LinePlayback[] {
  const alignment = alignPcm(output, source);
  if (spokenShare(alignment.heard, alignment.sourceSpeech) <= DRAFT_SHARE || !alignment.segments.length) return [];
  const groups: AlignedSegment[][] = [];
  for (const segment of alignment.segments) {
    const group = groups.find((g) => Math.abs(g[0].offset - segment.offset) < 0.03);
    if (group) group.push(segment); else groups.push([segment]);
  }
  const outWindows = Math.ceil(output.samples.length / output.rate / WINDOW_SECONDS);
  let lastSpeech = -1;
  for (let window = alignment.sourceSpeech.length - 1; window >= 0; window -= 1) if (alignment.sourceSpeech[window]) { lastSpeech = window; break; }
  return groups.map((group) => {
    const heard = new Uint8Array(alignment.heard.length);
    for (const segment of group) {
      const start = Math.max(0, Math.floor((segment.outStart + segment.offset) / WINDOW_SECONDS));
      const end = Math.min(heard.length, Math.ceil((segment.outEnd + segment.offset) / WINDOW_SECONDS));
      for (let window = start; window < end; window += 1) heard[window] = alignment.heard[window];
    }
    let lastHeard = -1;
    for (let window = heard.length - 1; window >= 0; window -= 1) if (heard[window]) { lastHeard = window; break; }
    const windows = new Uint8Array(outWindows);
    for (const segment of group) {
      // Correlation omits quiet consonants and edges; a little either side covers them.
      windows.fill(1, Math.max(0, Math.floor((segment.outStart - 0.12) / WINDOW_SECONDS)), Math.min(outWindows, Math.ceil((segment.outEnd + 0.12) / WINDOW_SECONDS)));
    }
    let heardWindows = 0;
    for (let window = 0; window < heard.length; window += 1) if (heard[window] && alignment.sourceSpeech[window]) heardWindows += 1;
    return {
      share: spokenShare(heard, alignment.sourceSpeech),
      heardSec: heardWindows * WINDOW_SECONDS,
      outStart: Math.min(...group.map((segment) => segment.outStart)),
      outEnd: Math.max(...group.map((segment) => segment.outEnd)),
      offsetSec: group[0].offset,
      missingTailSec: lastSpeech >= 0 && lastHeard >= 0 ? Math.max(0, (lastSpeech - lastHeard) * WINDOW_SECONDS) : 0,
      windows,
    };
  });
}

function quoted(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > 40 ? `${flat.slice(0, 40)}…` : flat;
}

const seconds = (value: number) => `${(Math.round(value * 10) / 10).toFixed(1)} s`;

/**
 * Lines played twice or cut off before their end. A stretch that two lines both match, as a
 * revised draft matches the opening of its final take, belongs to the line heard longer there
 * (the newer line on a tie), so a draft never reads as cut off inside another line's playback.
 */
export function narrationPlaybackFindings(lines: Array<{ text: string; playbacks: LinePlayback[] }>): Issue[] {
  const all = lines.flatMap((line, index) => line.playbacks
    .filter((playback) => playback.share >= PLAYED_SHARE)
    .map((playback) => ({ playback, index })));
  const stronger = (a: { playback: LinePlayback; index: number }, b: { playback: LinePlayback; index: number }) =>
    a.playback.heardSec > b.playback.heardSec + 0.05
    || (Math.abs(a.playback.heardSec - b.playback.heardSec) <= 0.05 && a.index > b.index);
  const ownWindows = (entry: { playback: LinePlayback; index: number }) => {
    let count = 0;
    for (let window = 0; window < entry.playback.windows.length; window += 1) {
      if (entry.playback.windows[window] && !all.some((other) => other.index !== entry.index && other.playback.windows[window] && stronger(other, entry))) count += 1;
    }
    return count;
  };
  const kept = new Set(all.filter((entry) => ownWindows(entry) >= 15).map((entry) => entry.playback));
  const issues: Issue[] = [];
  // Two files of the same words are one line to the user: say it once.
  const said = new Set<string>();
  for (const line of lines) {
    const add = (issue: Issue) => {
      const key = `${issue.code}\0${line.text.replace(/\s+/g, ' ').trim()}`;
      if (!said.has(key)) { said.add(key); issues.push(issue); }
    };
    const played = line.playbacks.filter((playback) => kept.has(playback)).sort((a, b) => a.outStart - b.outStart);
    if (played.length >= 2) {
      const times = played.map((playback) => `from ${seconds(playback.outStart)}`);
      const listed = times.length === 2 ? `${times[0]} and ${times[1]}` : `${times.slice(0, -1).join(', ')} and ${times.at(-1)}`;
      add({
        code: 'DELIVERY_NARRATION_REPEATED',
        severity: 'error',
        message: `The narration line "${quoted(line.text)}" plays ${played.length === 2 ? 'twice' : `${played.length} times`}, ${listed}. Keep it once, then deliver again.`,
      });
      continue;
    }
    const cut = played.find((playback) => playback.missingTailSec >= CUT_MIN_SEC);
    if (cut) {
      add({
        code: 'DELIVERY_NARRATION_CUT_OFF',
        severity: 'error',
        message: `The narration line "${quoted(line.text)}" stops at ${seconds(cut.outEnd)} before its end; about ${seconds(cut.missingTailSec)} of it is not heard. Let it finish or shorten the line, then deliver again.`,
      });
    }
  }
  return issues;
}

async function decodeMono(ffmpeg: string, file: string, maxSec: number, signal?: AbortSignal, startSec?: number): Promise<Pcm | null> {
  const pcmAbs = path.join(os.tmpdir(), `orkas-narration-playback-${randomUUID()}.f32`);
  try {
    const range = startSec === undefined ? ['-t', String(maxSec + 1), '-i', file]
      : ['-ss', String(startSec), '-i', file, '-t', String(maxSec)];
    const decoded = await runVideoProcessForTest(ffmpeg, ['-v', 'error', '-nostdin', '-y', ...range,
      '-vn', '-ac', '1', '-ar', String(FP_RATE), '-f', 'f32le', pcmAbs], { signal, timeoutMs: DECODE_TIMEOUT_MS });
    if (decoded.code !== 0 || decoded.timedOut || decoded.aborted) return null;
    const bytes = await fs.readFile(pcmAbs);
    const samples = new Float32Array(Math.floor(bytes.length / 4));
    for (let index = 0; index < samples.length; index += 1) samples[index] = bytes.readFloatLE(index * 4);
    return { rate: FP_RATE, samples };
  } catch {
    return null;
  } finally {
    await fs.rm(pcmAbs, { force: true }).catch(() => undefined);
  }
}

export type KeptClipAudio = { sourceAbs: string; sourceStartSec: number; startSec: number; durationSec: number };

/** Verify original sound at the source and output ranges the timeline actually uses. */
export async function originalClipAudioWarnings(input: {
  ffmpeg: string;
  videoAbs: string;
  clips: readonly KeptClipAudio[];
  allowedRoots: readonly string[];
  signal?: AbortSignal;
}): Promise<Issue[]> {
  const deadline = AbortSignal.timeout(ORIGINAL_CHECK_TIMEOUT_MS);
  const signal = input.signal ? AbortSignal.any([input.signal, deadline]) : deadline;
  const warnings: Issue[] = [];
  let workSec = 0;
  for (const clip of input.clips.slice(0, MAX_ORIGINAL_CLIPS)) {
    if (signal.aborted) break;
    const { durationSec, sourceAbs, sourceStartSec, startSec } = clip;
    // The matcher needs several agreeing blocks. A very short or long selection
    // has no reliable whole-clip result within this check's budget.
    if (durationSec < 0.75 || durationSec > MAX_ORIGINAL_CLIP_SEC || workSec + durationSec > MAX_ORIGINAL_AUDIO_SEC
      || !isPathAllowed(sourceAbs, input.allowedRoots)) continue;
    workSec += durationSec;
    const source = await decodeMono(input.ffmpeg, sourceAbs, durationSec, signal, sourceStartSec);
    // A clip with no comparable source sound provides no evidence about preservation.
    if (!source || source.samples.length < FP_RATE * 0.75 || rms(source.samples, 0, source.samples.length) < 0.01) continue;
    const output = await decodeMono(input.ffmpeg, input.videoAbs, durationSec, signal, startSec);
    if (signal.aborted) break;
    const matches = output ? linePlaybacks(output, source) : [];
    if (matches.some((match) => Math.abs(match.offsetSec) <= ORIGINAL_SYNC_TOLERANCE_SEC && match.share >= ORIGINAL_MATCH_SHARE)) continue;
    warnings.push({
      code: 'DELIVERY_ORIGINAL_AUDIO_UNVERIFIED', severity: 'warning',
      message: `Could not verify the original sound marked to keep at ${startSec.toFixed(2)}s–${(startSec + durationSec).toFixed(2)}s in the delivered file. Review that section to decide whether the original sound needs restoring or the mix needs adjusting.`,
    });
  }
  return warnings;
}

/** The words each narration file was made from, as assets.json records them. */
async function lineTexts(productionDirAbs: string): Promise<Map<string, string>> {
  const texts = new Map<string, string>();
  try {
    const raw = JSON.parse(await fs.readFile(path.join(productionDirAbs, 'assets.json'), 'utf8')) as { assets?: unknown };
    for (const asset of Array.isArray(raw.assets) ? raw.assets : []) {
      const record = (asset ?? {}) as Record<string, unknown>;
      if (typeof record.path === 'string' && typeof record.prompt === 'string' && record.prompt.trim()) {
        texts.set(path.normalize(record.path), record.prompt);
      }
    }
  } catch { /* no recorded words: the file name stands in */ }
  return texts;
}

/**
 * Narration made since the last delivery that plays twice or stops before its end in the
 * delivered file. Says nothing when the sound cannot be read or the work would be too large:
 * an unchecked delivery is not stopped.
 */
export async function narrationPlaybackIssues(input: {
  ffmpeg: string;
  videoAbs: string;
  productionDirAbs: string;
  voices: ReadonlyArray<{ path: string; seconds?: number }>;
  signal?: AbortSignal;
}): Promise<Issue[]> {
  const voices = input.voices.slice(-MAX_LINES).flatMap((voice) => {
    const fileAbs = path.resolve(input.productionDirAbs, voice.path);
    return isPathAllowed(fileAbs, [input.productionDirAbs]) ? [{ ...voice, fileAbs }] : [];
  });
  if (!voices.length) return [];
  const output = await decodeMono(input.ffmpeg, input.videoAbs, MAX_DELIVERY_SEC, input.signal);
  if (!output || !output.samples.length) return [];
  const outputSec = output.samples.length / FP_RATE;
  // The extra decoded second detects overlong soundtracks. It is not part of
  // the analysis budget, since a truncated prefix cannot establish delivery.
  if (outputSec > MAX_DELIVERY_SEC) return [];
  const texts = await lineTexts(input.productionDirAbs);
  const lines: Array<{ text: string; playbacks: LinePlayback[] }> = [];
  let work = 0;
  for (const voice of voices) {
    if (input.signal?.aborted) return [];
    const source = await decodeMono(input.ffmpeg, voice.fileAbs, MAX_LINE_SEC, input.signal);
    if (!source || !source.samples.length) continue;
    const sourceSec = source.samples.length / FP_RATE;
    if (sourceSec > MAX_LINE_SEC) continue;
    work += outputSec * sourceSec;
    if (work > MAX_WORK) {
      log.info('narration playback check skipped', { reason: 'work', lines: voices.length, output_sec: Math.round(outputSec) });
      return [];
    }
    // Each line is a few hundred ms of matching; yield between them so the app keeps answering.
    await new Promise<void>((resolve) => setImmediate(resolve));
    lines.push({
      text: texts.get(path.normalize(voice.path)) ?? path.basename(voice.path),
      playbacks: linePlaybacks(output, source),
    });
  }
  return narrationPlaybackFindings(lines);
}
