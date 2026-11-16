import { describe, expect, it } from 'vitest';

import { buildMixFilter, burnsubsForceStyle, VERTICAL_CAPTION_MARGIN_V } from '../../../resources/builtin/marketplace/agents/79df9cc89f5f/skills/_shared/scripts/src/video_edit';

const SR = 48000;
// Every tail pins `aformat=channel_layouts=stereo` after the resample: a
// TTS-only mix is all-mono, and without a known stereo layout the draft it
// writes dies later in normalize_loudness's layout negotiation (the
// 2026-08-05 delivery blocker).
const LN = 'loudnorm=I=-14:TP=-1:LRA=11';

describe('buildMixFilter — single segment', () => {
  it('lays a no-offset voiceover over a SILENT base (no adelay, base audio untouched)', () => {
    const f = buildMixFilter({ sr: SR, segmentStartSec: [0], baseHasAudio: false, mode: 'mix', padWholeDurSec: 30, loudnorm: LN });
    expect(f).toContain('[1:a]aresample=48000[seg0]');
    expect(f).toContain('[seg0]apad=whole_dur=30.000,loudnorm=I=-14:TP=-1:LRA=11,aresample=48000,aformat=channel_layouts=stereo[aout]');
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
    expect(f).toContain('[seg0]loudnorm=I=-14:TP=-1:LRA=11,aresample=48000,aformat=channel_layouts=stereo[aout]');
  });
});

describe('buildMixFilter — per-line placement (the desync fix)', () => {
  it('places each line at its own start_sec (multi-adelay) and amixes them into one bed', () => {
    const f = buildMixFilter({ sr: SR, segmentStartSec: [0, 4.2, 10], baseHasAudio: false, mode: 'mix', padWholeDurSec: 30, loudnorm: LN });
    expect(f).toContain('[1:a]aresample=48000[seg0]');
    expect(f).toContain('[2:a]aresample=48000,adelay=4200:all=1[seg1]');
    expect(f).toContain('[3:a]aresample=48000,adelay=10000:all=1[seg2]');
    expect(f).toContain('[seg0][seg1][seg2]amix=inputs=3:duration=longest:normalize=0[vobed]');
    expect(f).toContain('[vobed]apad=whole_dur=30.000,loudnorm=I=-14:TP=-1:LRA=11,aresample=48000,aformat=channel_layouts=stereo[aout]');
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
    expect(f).toContain('[base][seg0]amix=inputs=2:duration=longest:normalize=0,apad=whole_dur=12.000,loudnorm=I=-14:TP=-1:LRA=11,aresample=48000,aformat=channel_layouts=stereo[aout]');
  });

  it("mode 'replace' drops the base audio entirely (no [0:a] in the graph)", () => {
    const f = buildMixFilter({ sr: SR, segmentStartSec: [0], baseHasAudio: true, mode: 'replace', padWholeDurSec: 12, loudnorm: LN });
    expect(f).not.toContain('[0:a]');
    expect(f).not.toContain('[base]');
    expect(f).toContain('[seg0]apad=whole_dur=12.000,loudnorm=I=-14:TP=-1:LRA=11,aresample=48000,aformat=channel_layouts=stereo[aout]');
  });

  it("mode 'mix' with multiple lines amixes the placed bed, then amixes that over the base", () => {
    const f = buildMixFilter({ sr: SR, segmentStartSec: [0, 5], baseHasAudio: true, mode: 'mix', padWholeDurSec: 30, loudnorm: LN });
    expect(f).toContain('[seg0][seg1]amix=inputs=2:duration=longest:normalize=0[vobed]');
    expect(f).toContain('[0:a]aresample=48000[base]');
    expect(f).toContain('[base][vobed]amix=inputs=2:duration=longest:normalize=0,');
  });
});

describe('buildMixFilter — ducking the base under the added sound', () => {
  it('keys a sidechain compressor on the base with the added bed, matching the timeline duck', () => {
    const f = buildMixFilter({ sr: SR, segmentStartSec: [2], baseHasAudio: true, mode: 'mix', padWholeDurSec: 6, loudnorm: LN, duck: true });
    expect(f).toContain('[1:a]aresample=48000,adelay=2000:all=1[seg0]');
    expect(f).toContain('[seg0]asplit=2[bedmix][bedkey0]');
    expect(f).toContain('[0:a]aresample=48000[base0]');
    expect(f).toContain('[base0][bedkey]sidechaincompress=threshold=0.02:ratio=10:attack=20:release=400[base]');
    expect(f).toContain('[base][bedmix]amix=inputs=2:duration=longest:normalize=0,apad=whole_dur=6.000,');
  });

  it('pads the key to the clip so the base is not cut off where the added sound ends', () => {
    // sidechaincompress stops with whichever input ends first; an unpadded key
    // left everything after the last line silent (measured 2026-11-12).
    const f = buildMixFilter({ sr: SR, segmentStartSec: [2], baseHasAudio: true, mode: 'mix', padWholeDurSec: 6, loudnorm: LN, duck: true });
    expect(f).toContain('[bedkey0]apad=whole_dur=6.000[bedkey]');
    const unknown = buildMixFilter({ sr: SR, segmentStartSec: [2], baseHasAudio: true, mode: 'mix', padWholeDurSec: null, loudnorm: LN, duck: true });
    expect(unknown).toContain('[bedkey0]apad[bedkey]');
  });

  it('ducks under the combined bed when several lines are placed', () => {
    const f = buildMixFilter({ sr: SR, segmentStartSec: [0, 5], baseHasAudio: true, mode: 'mix', padWholeDurSec: 30, loudnorm: LN, duck: true });
    expect(f).toContain('[seg0][seg1]amix=inputs=2:duration=longest:normalize=0[vobed]');
    expect(f).toContain('[vobed]asplit=2[bedmix][bedkey0]');
  });

  it('ignores duck when there is no base sound to lower', () => {
    const silent = buildMixFilter({ sr: SR, segmentStartSec: [0], baseHasAudio: false, mode: 'mix', padWholeDurSec: 12, loudnorm: LN, duck: true });
    const replaced = buildMixFilter({ sr: SR, segmentStartSec: [0], baseHasAudio: true, mode: 'replace', padWholeDurSec: 12, loudnorm: LN, duck: true });
    for (const f of [silent, replaced]) {
      expect(f).not.toContain('sidechaincompress');
      expect(f).not.toContain('asplit');
    }
  });

  it('leaves the plain layer unchanged without duck', () => {
    const f = buildMixFilter({ sr: SR, segmentStartSec: [0], baseHasAudio: true, mode: 'mix', padWholeDurSec: 12, loudnorm: LN });
    expect(f).not.toContain('sidechaincompress');
    expect(f).toContain('[0:a]aresample=48000[base];[base][seg0]amix=inputs=2');
  });
});

describe('burnsubsForceStyle — caption height by frame shape', () => {
  it('raises plain captions on a vertical frame above the platform buttons', () => {
    expect(burnsubsForceStyle('', { width: 1080, height: 1920 }, '/a/captions.srt'))
      .toBe(`:force_style='MarginV=${VERTICAL_CAPTION_MARGIN_V}'`);
    expect(burnsubsForceStyle('PingFang SC', { width: 1080, height: 1920 }, '/a/captions.vtt'))
      .toBe(`:force_style='FontName=PingFang SC,MarginV=${VERTICAL_CAPTION_MARGIN_V}'`);
  });

  it('keeps the default height on landscape and square frames', () => {
    expect(burnsubsForceStyle('', { width: 1920, height: 1080 }, '/a/captions.srt')).toBe('');
    expect(burnsubsForceStyle('', { width: 1080, height: 1080 }, '/a/captions.srt')).toBe('');
    expect(burnsubsForceStyle('Arial', { width: 1920, height: 1080 }, '/a/captions.srt')).toBe(":force_style='FontName=Arial'");
  });

  it('leaves an authored .ass file where its author placed it', () => {
    expect(burnsubsForceStyle('', { width: 1080, height: 1920 }, '/a/styled.ASS')).toBe('');
    expect(burnsubsForceStyle('', { width: 1080, height: 1920 }, '/a/styled.ssa')).toBe('');
  });

  it('keeps the default when the frame size could not be read', () => {
    expect(burnsubsForceStyle('', null, '/a/captions.srt')).toBe('');
  });
});
