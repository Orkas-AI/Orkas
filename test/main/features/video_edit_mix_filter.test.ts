import { describe, expect, it } from 'vitest';

import { buildMixFilter, escapeFfmpegFilterValue } from '../../../resources/builtin/marketplace/agents/79df9cc89f5f/skills/_shared/scripts/src/video_edit';

const SR = 48000;
const LN = 'loudnorm=I=-14:TP=-1:LRA=11';

describe('buildMixFilter — single segment', () => {
  it('lays a no-offset voiceover over a SILENT base (no adelay, base audio untouched)', () => {
    const f = buildMixFilter({ sr: SR, segmentStartSec: [0], baseHasAudio: false, mode: 'mix', padWholeDurSec: 30, loudnorm: LN });
    expect(f).toContain('[1:a]aresample=48000[seg0]');
    expect(f).toContain('[seg0]apad=whole_dur=30.000,loudnorm=I=-14:TP=-1:LRA=11,aresample=48000[aout]');
    expect(f).not.toContain('adelay');   // 0s start ⇒ no delay
    expect(f).not.toContain('[0:a]');     // silent base ⇒ base audio never referenced
    expect(f).not.toContain('amix');      // single segment ⇒ no amix
  });

  it('delays a single line by its start (lead-in offset → adelay)', () => {
    const f = buildMixFilter({ sr: SR, segmentStartSec: [4], baseHasAudio: false, mode: 'mix', padWholeDurSec: 30, loudnorm: LN });
    expect(f).toContain('[1:a]aresample=48000,adelay=4000:all=1[seg0]');
  });

  it('omits apad when the clip duration is unknown (null) — avoids the -shortest hang path', () => {
    const f = buildMixFilter({ sr: SR, segmentStartSec: [0], baseHasAudio: false, mode: 'mix', padWholeDurSec: null, loudnorm: LN });
    expect(f).not.toContain('apad');
    expect(f).toContain('[seg0]loudnorm=I=-14:TP=-1:LRA=11,aresample=48000[aout]');
  });
});

describe('escapeFfmpegFilterValue', () => {
  it('escapes path characters that are meaningful inside ffmpeg filter options', () => {
    expect(escapeFfmpegFilterValue("/tmp/a:b,c;d[1]it\\'s.srt")).toBe("/tmp/a\\:b\\,c\\;d\\[1\\]it\\\\\\'s.srt");
  });
});

describe('buildMixFilter — per-line placement (the desync fix)', () => {
  it('places each line at its own start_sec (multi-adelay) and amixes them into one bed', () => {
    const f = buildMixFilter({ sr: SR, segmentStartSec: [0, 4.2, 10], baseHasAudio: false, mode: 'mix', padWholeDurSec: 30, loudnorm: LN });
    expect(f).toContain('[1:a]aresample=48000[seg0]');
    expect(f).toContain('[2:a]aresample=48000,adelay=4200:all=1[seg1]');
    expect(f).toContain('[3:a]aresample=48000,adelay=10000:all=1[seg2]');
    expect(f).toContain('[seg0][seg1][seg2]amix=inputs=3:duration=longest:normalize=0[vobed]');
    expect(f).toContain('[vobed]apad=whole_dur=30.000,loudnorm=I=-14:TP=-1:LRA=11,aresample=48000[aout]');
    expect(f).not.toContain('[0:a]'); // silent base
  });

  it('rounds fractional starts to whole milliseconds', () => {
    const f = buildMixFilter({ sr: SR, segmentStartSec: [0, 25.7589], baseHasAudio: false, mode: 'mix', padWholeDurSec: 30, loudnorm: LN });
    expect(f).toContain('adelay=25759:all=1[seg1]');
  });
});

describe('buildMixFilter — existing base audio (the "two voices" guard outcomes)', () => {
  it("mode 'mix' layers the bed over the base audio (talking-head / music-under-voice)", () => {
    const f = buildMixFilter({ sr: SR, segmentStartSec: [0], baseHasAudio: true, mode: 'mix', padWholeDurSec: 12, loudnorm: LN });
    expect(f).toContain('[0:a]aresample=48000[base]');
    expect(f).toContain('[base][seg0]amix=inputs=2:duration=longest:normalize=0,apad=whole_dur=12.000,loudnorm=I=-14:TP=-1:LRA=11,aresample=48000[aout]');
  });

  it("mode 'replace' drops the base audio entirely (no [0:a] in the graph)", () => {
    const f = buildMixFilter({ sr: SR, segmentStartSec: [0], baseHasAudio: true, mode: 'replace', padWholeDurSec: 12, loudnorm: LN });
    expect(f).not.toContain('[0:a]');
    expect(f).not.toContain('[base]');
    expect(f).toContain('[seg0]apad=whole_dur=12.000,loudnorm=I=-14:TP=-1:LRA=11,aresample=48000[aout]');
  });

  it("mode 'mix' with multiple lines amixes the placed bed, then amixes that over the base", () => {
    const f = buildMixFilter({ sr: SR, segmentStartSec: [0, 5], baseHasAudio: true, mode: 'mix', padWholeDurSec: 30, loudnorm: LN });
    expect(f).toContain('[seg0][seg1]amix=inputs=2:duration=longest:normalize=0[vobed]');
    expect(f).toContain('[0:a]aresample=48000[base]');
    expect(f).toContain('[base][vobed]amix=inputs=2:duration=longest:normalize=0,');
  });
});
