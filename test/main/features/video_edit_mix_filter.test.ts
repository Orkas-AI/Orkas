import { describe, expect, it } from 'vitest';

import { breakCaptionLine, buildMixFilter, burnsubsForceStyle, captionEm, captionLineEm, VERTICAL_CAPTION_FONT_SIZE, VERTICAL_CAPTION_MARGIN_V, wrapCaptionText } from '../../../resources/builtin/marketplace/agents/79df9cc89f5f/skills/_shared/scripts/src/video_edit';

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
    expect(f).toContain('[seg0]asetnsamples=n=1024:p=1,asplit=2[bedmix][bedkey0]');
    expect(f).toContain('[0:a]aresample=48000,asetnsamples=n=1024:p=1[base0]');
    expect(f).toContain('[base0][bedkey]sidechaincompress=threshold=0.02:ratio=10:attack=20:release=400[base]');
    expect(f).toContain('[base][bedmix]amix=inputs=2:duration=longest:normalize=0,apad=whole_dur=6.000,');
  });

  it('pads the key to the clip so the base is not cut off where the added sound ends', () => {
    // sidechaincompress stops with whichever input ends first; an unpadded key
    // left everything after the last line silent (measured 2026-11-12).
    const f = buildMixFilter({ sr: SR, segmentStartSec: [2], baseHasAudio: true, mode: 'mix', padWholeDurSec: 6, loudnorm: LN, duck: true });
    expect(f).toContain('[bedkey0]apad=whole_dur=6.000,asetnsamples=n=1024:p=1[bedkey]');
    const unknown = buildMixFilter({ sr: SR, segmentStartSec: [2], baseHasAudio: true, mode: 'mix', padWholeDurSec: null, loudnorm: LN, duck: true });
    expect(unknown).toContain('[bedkey0]apad,asetnsamples=n=1024:p=1[bedkey]');
  });

  it('ducks under the combined bed when several lines are placed', () => {
    const f = buildMixFilter({ sr: SR, segmentStartSec: [0, 5], baseHasAudio: true, mode: 'mix', padWholeDurSec: 30, loudnorm: LN, duck: true });
    expect(f).toContain('[seg0][seg1]amix=inputs=2:duration=longest:normalize=0[vobed]');
    expect(f).toContain('[vobed]asetnsamples=n=1024:p=1,asplit=2[bedmix][bedkey0]');
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
      .toBe(`:force_style='FontSize=${VERTICAL_CAPTION_FONT_SIZE},MarginV=${VERTICAL_CAPTION_MARGIN_V}'`);
    expect(burnsubsForceStyle('PingFang SC', { width: 1080, height: 1920 }, '/a/captions.vtt'))
      .toBe(`:force_style='FontName=PingFang SC,FontSize=${VERTICAL_CAPTION_FONT_SIZE},MarginV=${VERTICAL_CAPTION_MARGIN_V}'`);
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


// 2026-11-23: on 1080x1920, plain captions at libass's default size fit about ten Chinese
// characters per line, and libass breaks only at spaces, so a 15-character line ran off both edges.
describe('caption lines fit the frame', () => {
  it('measures wide characters as a whole em and the rest as about half, markup as none', () => {
    expect(captionEm('想吃的朋友')).toBe(5);
    expect(captionEm('Hello')).toBeCloseTo(3);
    expect(captionEm('<i>好</i>{\\b1}吧')).toBe(2);
  });

  it('gives a vertical frame at the vertical size about thirteen characters, a wide one about twenty-eight', () => {
    expect(captionLineEm({ width: 1080, height: 1920 }, VERTICAL_CAPTION_FONT_SIZE)).toBe(13);
    expect(captionLineEm({ width: 1080, height: 1920 }, 16)).toBe(9);
    expect(captionLineEm({ width: 1920, height: 1080 }, 16)).toBe(28);
  });

  it('breaks a long line in even parts at punctuation, else between wide characters, and never before a closing mark', () => {
    const parts = breakCaptionLine('想吃的朋友，可以提前在群里跟我说，帮你留着。', 13);
    expect(parts.join('')).toBe('想吃的朋友，可以提前在群里跟我说，帮你留着。');
    for (const part of parts) expect(captionEm(part)).toBeLessThanOrEqual(13);
    expect(parts.length).toBe(2);
    // A comma near the middle is taken over a break between two characters.
    expect(breakCaptionLine('今天说三个坑，第一个是规则太复杂', 13)).toEqual(['今天说三个坑，', '第一个是规则太复杂']);
    expect(breakCaptionLine('大家好这周我们店上了一款新品抹茶红豆卷', 13).map(captionEm).every((em) => em <= 13)).toBe(true);
    expect(breakCaptionLine('一二三四五六七八九十十一。', 12).some((part) => part.startsWith('。'))).toBe(false);
    expect(breakCaptionLine('The quick brown fox jumps over the lazy dog', 10)).toEqual(['The quick brown', 'fox jumps over', 'the lazy dog']);
    expect(breakCaptionLine('短句', 13)).toEqual(['短句']);
  });

  it('preserves VTT blocks, cue identifiers and CRLF while wrapping numeric and keyword-leading dialogue', () => {
    const header = ['WEBVTT', 'Language: a-long-header-value', '', 'STYLE', '::cue { color: lime; }', '',
      'NOTE a multi-line annotation', '00:00.000 --> 00:05.000', 'comment text remains intact', '',
      'REGION', 'id:a-very-long-region-name', '', 'cue-identifier-with-long-name',
      '00:00.000 --> 00:05.000 align:start'].join('\r\n');
    const result = wrapCaptionText(header + '\r\n12345678901234567890\r\nNOTE this is dialogue\r\n', 6);
    expect(result.startsWith(header + '\r\n')).toBe(true);
    const lines = result.slice(header.length + 2).trimEnd().split('\r\n');
    expect(lines.join('').replace(/ /g, '')).toBe('12345678901234567890NOTEthisisdialogue');
    expect(lines.every((line) => captionEm(line) <= 6)).toBe(true);
    expect(wrapCaptionText(header + '\r\n短\r\n', 6)).toBe(header + '\r\n短\r\n');
    const nextCue = 'STYLE example identifier\n00:01.000 --> 00:03.000\n';
    expect(wrapCaptionText('WEBVTT\n\n' + nextCue + '12345678901234567890', 6))
      .toBe('WEBVTT\n\n' + nextCue + '1234567890\n1234567890');
  });

  it('retains every character of a long unbroken cue', () => {
    const line = '长'.repeat(10_000);
    const parts = breakCaptionLine(line, 13);
    expect(parts.join('')).toBe(line);
    expect(parts.every((part) => part.length <= 13)).toBe(true);
  });

  it('wraps only the text lines of a caption file and leaves short ones as they are', () => {
    const srt = '1\n00:00:00,000 --> 00:00:05,000\n想吃的朋友，可以提前在群里跟我说，帮你留着。\n\n2\n00:00:05,000 --> 00:00:07,000\n甜度调低了\n';
    const wrapped = wrapCaptionText(srt, 13);
    expect(wrapped.split('\n').slice(0, 2)).toEqual(['1', '00:00:00,000 --> 00:00:05,000']);
    expect(wrapped).toContain('甜度调低了');
    expect(wrapped.split('\n').filter((line) => line && !/-->|^\d+$/.test(line)).every((line) => captionEm(line) <= 13)).toBe(true);
    expect(wrapCaptionText('WEBVTT\n\n00:00.000 --> 00:01.000\n短\n', 13)).toBe('WEBVTT\n\n00:00.000 --> 00:01.000\n短\n');
  });
});
