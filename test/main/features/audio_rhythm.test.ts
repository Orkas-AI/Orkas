import * as fs from 'node:fs';
import * as path from 'node:path';

import { describe, expect, it } from 'vitest';

import { rhythm, tempoOf, STEADY_BEAT_CONFIDENCE } from '../../../resources/builtin/marketplace/agents/79df9cc89f5f/skills/_shared/scripts/src/audio_rhythm';
import { beatStrengths, cutsAgainstBeats } from '../../../resources/builtin/marketplace/agents/79df9cc89f5f/skills/_shared/scripts/src/video_analyze';

// The tracker is HyperFrames' (Apache-2.0), ported unchanged; these pin that the
// port reads beats where they are and refuses music without a steady one.
const RATE = 22050;

/** A kick on every beat, a softer hat between, a chord that changes every `bar` beats. */
function drumTrack(bpm: number, seconds: number, bar = 4, hats = true): Float32Array {
  const out = new Float32Array(Math.round(seconds * RATE));
  const beat = 60 / bpm;
  for (let i = 0; i < out.length; i += 1) {
    const t = i / RATE;
    const inBeat = t % beat;
    const kick = 0.8 * Math.sin(2 * Math.PI * 60 * inBeat) * Math.exp(-inBeat * 18);
    const offbeat = (t + beat / 2) % beat;
    const hat = !hats ? 0 : 0.2 * (((i * 2654435761) % 1000) / 1000 - 0.5) * Math.exp(-offbeat * 60);
    const chord = 0.15 * Math.sin(2 * Math.PI * (220 + 110 * (Math.floor(t / (bar * beat)) % 2)) * t);
    out[i] = kick + hat + chord;
  }
  return out;
}

describe('ported beat tracker', () => {
  it('finds a 128 BPM beat within a few milliseconds and the bar from the chord changes', () => {
    const found = rhythm({ sampleRate: RATE, channels: [drumTrack(128, 20)] });
    const beat = 60 / 128;
    expect(found.beats.confidence ?? 0).toBeGreaterThan(0.5);
    expect(tempoOf(found.beats.times).value).toBeCloseTo(128, 0);
    for (const t of found.beats.times) expect(Math.abs(t - Math.round(t / beat) * beat)).toBeLessThan(0.02);
    expect(found.downbeats.meter).toBe(4);
    for (const t of found.downbeats.times) expect(Math.abs(t / (4 * beat) - Math.round(t / (4 * beat)))).toBeLessThan(0.05);
  });

  it('finds a slow 64 BPM beat', () => {
    const found = rhythm({ sampleRate: RATE, channels: [drumTrack(64, 24, 4, false)] });
    expect(tempoOf(found.beats.times).value).toBeCloseTo(64, 0);
  });

  it('may read a slow beat with off-beat hats at double speed, which cutting on every second beat absorbs', () => {
    const found = rhythm({ sampleRate: RATE, channels: [drumTrack(64, 24)] });
    expect([64, 128]).toContain(Math.round(tempoOf(found.beats.times).value ?? 0));
  });

  it('reports no steady beat for noise and for a clip too short to tell', () => {
    let seed = 1;
    const noise = Float32Array.from({ length: 20 * RATE }, () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296 - 0.5; });
    const quiet = rhythm({ sampleRate: RATE, channels: [noise] });
    expect(quiet.beats.times).toEqual([]);
    expect(quiet.beats.confidence ?? 0).toBeLessThan(STEADY_BEAT_CONFIDENCE);
    expect(rhythm({ sampleRate: RATE, channels: [drumTrack(120, 4)] }).beats.reason).toMatch(/too short/);
  });
});

describe('beat helpers', () => {
  it('scores each beat by its loudness against the loudest', () => {
    const samples = new Float32Array(RATE * 2);
    for (let i = 0; i < 2205; i += 1) samples[RATE / 2 + i] = 0.8;
    for (let i = 0; i < 2205; i += 1) samples[RATE + RATE / 2 + i] = 0.2;
    expect(beatStrengths(samples, RATE, [0.5, 1.5, 0.05])).toEqual([1, 0.25, 0]);
  });

  it('measures each cut against its nearest beat, in seconds and frames', () => {
    expect(cutsAgainstBeats([1.0, 2.1], [0.9375, 1.875, 2.8125], 30)).toEqual([
      { t: 1.0, beat: 0.9375, offsetSec: 0.063, offsetFrames: 2 },
      { t: 2.1, beat: 1.875, offsetSec: 0.225, offsetFrames: 7 },
    ]);
  });
});

describe('the host copy of the tracker', () => {
  it('matches the skill bundle below its header', () => {
    const repo = path.resolve(__dirname, '../../..');
    const body = (file: string) => fs.readFileSync(path.join(repo, file), 'utf8').replace(/^\/\*![\s\S]*?\*\/\n/, '');
    const host = body('src/main/features/audio_rhythm.ts');
    expect(host.length).toBeGreaterThan(10_000);
    expect(host).toBe(body('resources/builtin/marketplace/agents/79df9cc89f5f/skills/_shared/scripts/src/audio_rhythm.ts'));
  });
});
