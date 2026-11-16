

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { BEAT_SEC, driftingCuts, makeBeatMontage, onBeatCuts } from '../../fixtures/beat-montage';

import * as studio from '../../../src/main/features/video_studio';

import {
  assessCutsOffBeat,
  assessDeliveredNarration,
  assessDeliveredSpec,
  cutsOffBeatIssues,
  parseAspectRatio,
  parseIntegratedLufs,
  parseDeliveredAudioMeasurement,
  measureDeliveredAudio,
  measureVoicedSpan,
  parseVoicedSpan,
  type DeliveryNarrationLine,
} from '../../../src/main/features/video_studio_delivery';

afterEach(() => vi.restoreAllMocks());

describe('narration measurement completion', () => {
  it.each(['probe-failed', 'decode-failed', 'decode-aborted', 'decode-timedOut'])('keeps %s evidence unknown', async (state) => {
    const run = vi.spyOn(studio, 'runVideoProcessForTest');
    run.mockResolvedValueOnce({
      code: state === 'probe-failed' ? 1 : 0, stdout: '1.000000', stderr: '', timedOut: false, aborted: false,
    });
    run.mockResolvedValueOnce({
      code: state === 'decode-failed' ? 1 : 0, stdout: 'lavfi.silence_start=0.5', stderr: '',
      timedOut: state === 'decode-timedOut', aborted: state === 'decode-aborted',
    });
    expect(await measureVoicedSpan('/unused/synthetic.wav')).toBeNull();
    expect(run).toHaveBeenCalledTimes(state === 'probe-failed' ? 1 : 2);
  });

  it.each(['Infinity', 'NaN', '0', '-1', ''])('rejects an invalid probed duration %j', async (stdout) => {
    const run = vi.spyOn(studio, 'runVideoProcessForTest').mockResolvedValue({
      code: 0, stdout, stderr: '', timedOut: false, aborted: false,
    });
    expect(await measureVoicedSpan('/unused/synthetic.wav')).toBeNull();
    expect(run).toHaveBeenCalledTimes(1);
  });
});

describe('complete digital-silence evidence', () => {
  const summary = (id: string, peak: string, samples = '48000') => [
    `[Parsed_astats_0 @ ${id}] Overall`,
    `[Parsed_astats_0 @ ${id}] Peak level dB: ${peak}`,
    `[Parsed_astats_0 @ ${id}] Number of samples: ${samples}`,
  ].join('\n');
  const silent = summary('0x123', '-inf');
  const lufs = '\n[Parsed_ebur128_1 @ 0x456] Summary:\n Integrated loudness:\n I: -70.0 LUFS';

  it('distinguishes exact zeros from a quiet signal at the same loudness gate floor', () => {
    expect(parseDeliveredAudioMeasurement(silent + lufs, 1)).toEqual({ digitalSilence: true, integratedLufs: -70 });
    expect(parseDeliveredAudioMeasurement(summary('0x123', '-110.123') + lufs, 1))
      .toEqual({ digitalSilence: false, integratedLufs: -70 });
  });

  it.each([
    ['', 1], [silent, 2], [silent, 0], [summary('0x123', '-inf', '0'), 1],
    [summary('0x123', 'nan'), 1], [silent.replace('Number of samples: 48000', ''), 1],
  ])('leaves missing, empty or incomplete evidence unknown (%#)', (stderr, streams) => {
    expect(parseDeliveredAudioMeasurement(String(stderr), Number(streams)).digitalSilence).toBeNull();
  });

  it('requires complete summaries for every stream, and never adds programs into one loudness claim', () => {
    expect(parseDeliveredAudioMeasurement(silent + '\n' + summary('0x789', '-10') + lufs, 2))
      .toEqual({ digitalSilence: false, integratedLufs: null });
    expect(parseDeliveredAudioMeasurement(silent + '\n' + summary('0x789', '-inf') + lufs, 2))
      .toEqual({ digitalSilence: true, integratedLufs: null });
  });

  it.each(['failed', 'timedOut', 'aborted'] as const)('does not trust a silent summary from a %s process', async (state) => {
    const run = vi.spyOn(studio, 'runVideoProcessForTest').mockResolvedValue({
      code: state === 'failed' ? 1 : 0, stdout: '', stderr: silent + lufs,
      timedOut: state === 'timedOut', aborted: state === 'aborted',
    });
    const signal = new AbortController().signal;
    expect(await measureDeliveredAudio('/unused/video.mp4', 1, signal))
      .toEqual({ digitalSilence: null, integratedLufs: null });
    expect(run).toHaveBeenCalledTimes(1);
    expect(run.mock.calls[0][1]).toEqual(expect.arrayContaining(['-xerror', '-map', '0:a', '-vn']));
    expect(run.mock.calls[0][2]).toMatchObject({ signal, timeoutMs: 600_000 });
  });
});

// The 2026-08-10 hand-assembled delivery, measured off the shipped file. The
// run wrote its own ffmpeg instead of the assembly ops — a legitimate fallback
// — and every check those ops carry vanished with them. These are the numbers
// that verification has to reach whatever route produced the file.
const SHIPPED: DeliveryNarrationLine[] = [
  { index: 0, startSec: 0, targetSec: 5.875, voicedStartSec: 0, voicedEndSec: 4.26, textHead: '目标一说出口' },
  { index: 1, startSec: 5.875, targetSec: 9.125, voicedStartSec: 5.875, voicedEndSec: 12.54, textHead: 'Orkas 是' },
  { index: 2, startSec: 15, targetSec: 12, voicedStartSec: 15, voicedEndSec: 25.19, textHead: '调研、写作' },
  { index: 3, startSec: 27, targetSec: 12, voicedStartSec: 27, voicedEndSec: 37.76, textHead: '模糊需求会' },
  { index: 4, startSec: 39, targetSec: 9, voicedStartSec: 39, voicedEndSec: 48.12, textHead: '这条片子就是' },
  { index: 5, startSec: 48, targetSec: 7, voicedStartSec: 48, voicedEndSec: 55.44, textHead: '下载即用' },
  { index: 6, startSec: 55, targetSec: 5, voicedStartSec: 55, voicedEndSec: 59.52, textHead: '去 orkas.ai' },
];

describe('assessDeliveredNarration', () => {
  it('catches the overlaps the hand-assembled mix shipped', () => {
    const issues = assessDeliveredNarration(SHIPPED, 60);
    const overlaps = issues.filter((issue) => issue.code === 'DELIVERY_NARRATION_OVERLAP');
    expect(overlaps).toHaveLength(2);
    // Line 4 runs to 48.12s into line 5's 48s start, and line 5 runs to 55.44s
    // into line 6's 55s start. Two voices, twice, in a delivered promo.
    expect(overlaps[0].message).toContain('lines 4 and 5');
    expect(overlaps[0].message).toContain('0.12s');
    expect(overlaps[1].message).toContain('lines 5 and 6');
    expect(overlaps[1].message).toContain('0.44s');
    for (const issue of overlaps) expect(issue.severity).toBe('error');
  });

  it('catches a last line still speaking after the video ends', () => {
    // The 2026-08-10 app run: mix truncated the closing line by 0.72s. A
    // hand-built mix drops it just as silently, so the delivered artifact has
    // to be judged for it too.
    const truncating = SHIPPED.map((line) => (
      line.index === 6 ? { ...line, voicedEndSec: 60.72 } : line
    ));
    const issues = assessDeliveredNarration(truncating, 60);
    const cut = issues.find((issue) => issue.code === 'DELIVERY_NARRATION_TRUNCATED');
    expect(cut?.severity).toBe('error');
    expect(cut?.message).toContain('0.72s');
    expect(cut?.message).toMatch(/re-synthesize|extend the video/);
  });

  it('leaves held silence alone', () => {
    // Gaps were measured across 13 older productions and no usable threshold
    // separated a designed pause from a mis-authored window, so silence is the
    // author's call and only collisions and losses are defects.
    const gapped: DeliveryNarrationLine[] = [
      { index: 0, startSec: 0, targetSec: 10, voicedStartSec: 0, voicedEndSec: 2, textHead: 'a' },
      { index: 1, startSec: 30, targetSec: 10, voicedStartSec: 30, voicedEndSec: 33, textHead: 'b' },
    ];
    expect(assessDeliveredNarration(gapped, 60)).toEqual([]);
  });

  it('does not call touching lines an overlap', () => {
    const touching: DeliveryNarrationLine[] = [
      { index: 0, startSec: 0, targetSec: 5, voicedStartSec: 0, voicedEndSec: 5.02, textHead: 'a' },
      { index: 1, startSec: 5, targetSec: 5, voicedStartSec: 5, voicedEndSec: 9, textHead: 'b' },
    ];
    expect(assessDeliveredNarration(touching, 60)).toEqual([]);
  });
});

describe('assessDeliveredSpec', () => {
  const base = {
    spec: {
      durationSec: 60, width: 1920, height: 1080, fps: 30, hasAudio: true, subtitleStreams: 0,
    },
    expectedDurationSec: 60,
    expectedAspect: '16:9',
    expectsAudio: true,
    expectsCaptions: false,
    integratedLufs: -14.2,
    sidecarSubtitleFound: false,
  };

  it('passes the delivered spec when it matches what was expected', () => {
    expect(assessDeliveredSpec(base)).toEqual([]);
  });

  it('catches the loudness nobody normalized', () => {
    // The shipped file measured -18.3 LUFS because normalize_loudness was
    // never run on the hand-built route.
    const issues = assessDeliveredSpec({ ...base, integratedLufs: -18.3 });
    const loud = issues.find((issue) => issue.code === 'DELIVERY_LOUDNESS_OFF_TARGET');
    expect(loud?.message).toContain('-18.3 LUFS');
    expect(loud?.message).toContain('quieter by 4.3 LU');
  });

  it('catches captions that were asked for and the file does not carry', () => {
    const issues = assessDeliveredSpec({ ...base, expectsCaptions: true });
    const captions = issues.find((issue) => issue.code === 'DELIVERY_CAPTIONS_MISSING');
    expect(captions?.message).toContain('Captions were asked for');
    // Burned-in captions are pixels; the check says so instead of accusing.
    expect(captions?.message).toContain('Burned-in captions cannot be detected');
    // A sidecar counts as produced.
    expect(assessDeliveredSpec({ ...base, expectsCaptions: true, sidecarSubtitleFound: true })
      .some((issue) => issue.code === 'DELIVERY_CAPTIONS_MISSING')).toBe(false);
    // So does a real subtitle stream.
    expect(assessDeliveredSpec({
      ...base, expectsCaptions: true, spec: { ...base.spec, subtitleStreams: 1 },
    }).some((issue) => issue.code === 'DELIVERY_CAPTIONS_MISSING')).toBe(false);
  });

  it('catches a delivery that is not the length or shape the user approved', () => {
    const drifted = assessDeliveredSpec({ ...base, spec: { ...base.spec, durationSec: 75.04 } });
    expect(drifted.find((issue) => issue.code === 'DELIVERY_DURATION_DRIFT')?.message)
      .toContain('75.04s');
    // The length the Agent passed for its own cut asks for the real length back, never a
    // stretched file (2026-11-14: a 14.4 s montage was slowed to the 15 s it had passed).
    const requested = assessDeliveredSpec({ ...base, durationSource: 'requested', spec: { ...base.spec, durationSec: 75.04 } })
      .find((issue) => issue.code === 'DELIVERY_DURATION_DRIFT')?.message ?? '';
    expect(requested).toContain('expect_duration_sec says');
    expect(requested).toContain('real length as expect_duration_sec');
    expect(requested).toContain('Do not speed up, slow down or pad');
    expect(requested).not.toContain('Narration and captions');
    expect(drifted.find((issue) => issue.code === 'DELIVERY_DURATION_DRIFT')?.message).toContain('Narration and captions');
    const wrongCanvas = assessDeliveredSpec({
      ...base, spec: { ...base.spec, width: 1080, height: 1920 },
    });
    expect(wrongCanvas.find((issue) => issue.code === 'DELIVERY_ASPECT_MISMATCH')?.message)
      .toContain('1080x1920');
    // 1918x1080 is the odd width one source clip carries; it is still 16:9
    // within tolerance and must not be reported as a wrong canvas.
    expect(assessDeliveredSpec({ ...base, spec: { ...base.spec, width: 1918 } })
      .some((issue) => issue.code === 'DELIVERY_ASPECT_MISMATCH')).toBe(false);
  });

  it('catches a narrated video delivered with no audio at all', () => {
    const issues = assessDeliveredSpec({ ...base, spec: { ...base.spec, hasAudio: false } });
    expect(issues.find((issue) => issue.code === 'DELIVERY_NO_AUDIO')?.severity).toBe('error');
    // No audio means no loudness verdict to add on top of it.
    expect(issues.some((issue) => issue.code === 'DELIVERY_LOUDNESS_OFF_TARGET')).toBe(false);
  });

  it('blocks proven zeros only when sound is required, without telling the caller to normalize silence', () => {
    expect(assessDeliveredSpec({ ...base, digitalSilence: true, integratedLufs: -70 }))
      .toMatchObject([{ code: 'DELIVERY_AUDIO_SILENT', severity: 'error' }]);
    expect(assessDeliveredSpec({ ...base, expectsAudio: false, digitalSilence: true, integratedLufs: -70 })).toEqual([]);
  });

  it('reports unavailable measurement as a warning rather than proven silence or a clean audio verdict', () => {
    expect(assessDeliveredSpec({ ...base, digitalSilence: null, integratedLufs: null }))
      .toMatchObject([{ code: 'DELIVERY_AUDIO_UNVERIFIABLE', severity: 'warning' }]);
    expect(assessDeliveredSpec({ ...base, digitalSilence: false, integratedLufs: -70 }))
      .toMatchObject([{ code: 'DELIVERY_LOUDNESS_OFF_TARGET', severity: 'warning' }]);
  });
});

describe('parseVoicedSpan', () => {
  // Real ffmpeg output for narration_01.mp3 (4.26s): ONE mid-sentence pause
  // that closes. Reading the last silence_start as the end of speech reports
  // this 4.26s line as 1.47s and turns every real overlap into a miss.
  const MID_PAUSE = [
    '[silencedetect @ 0x6000] silence_start: 1.4737',
    '[silencedetect @ 0x6000] silence_end: 1.78449 | silence_duration: 0.310794',
  ].join('\n');

  it('does not mistake a mid-sentence pause for the end of speech', () => {
    expect(parseVoicedSpan(MID_PAUSE, 4.26)).toEqual({ startSec: 0, endSec: 4.26 });
  });

  it('trims a real trailing silence — an unclosed final silence_start', () => {
    const padded = `${MID_PAUSE}\n[silencedetect @ 0x6000] silence_start: 5.5`;
    expect(parseVoicedSpan(padded, 8)).toEqual({ startSec: 0, endSec: 5.5 });
  });

  it('trims a leading silence', () => {
    const lead = [
      '[silencedetect @ 0x6000] silence_start: 0',
      '[silencedetect @ 0x6000] silence_end: 0.9 | silence_duration: 0.9',
    ].join('\n');
    expect(parseVoicedSpan(lead, 5)).toEqual({ startSec: 0.9, endSec: 5 });
  });

  it('treats a file with no detected silence as fully voiced', () => {
    expect(parseVoicedSpan('', 3.5)).toEqual({ startSec: 0, endSec: 3.5 });
  });
});

describe('parseIntegratedLufs', () => {
  it('reads the summary, not the running log', () => {
    const stderr = [
      '[Parsed_ebur128_0 @ 0x6000] t: 0.0999  TARGET:-23 LUFS    M:-120.7 S:-120.7     I: -70.0 LUFS       LRA: 0.0 LU',
      '[Parsed_ebur128_0 @ 0x6000] Summary:',
      '',
      '  Integrated loudness:',
      '    I:         -18.3 LUFS',
      '    Threshold: -28.5 LUFS',
    ].join('\n');
    expect(parseIntegratedLufs(stderr)).toBe(-18.3);
  });

  it('returns null with no summary rather than reporting the gate floor', () => {
    expect(parseIntegratedLufs('[Parsed_ebur128_0] t: 0.1 I: -70.0 LUFS')).toBeNull();
    expect(parseIntegratedLufs('')).toBeNull();
  });

  it('maps a silent -inf program to null', () => {
    expect(parseIntegratedLufs('Summary:\n  Integrated loudness:\n    I:  -inf LUFS')).toBeNull();
  });
});

describe('parseAspectRatio', () => {
  it('parses the shapes in use', () => {
    expect(parseAspectRatio('16:9')).toBeCloseTo(16 / 9, 6);
    expect(parseAspectRatio('9:16')).toBeCloseTo(9 / 16, 6);
    expect(parseAspectRatio('1920x1080')).toBeCloseTo(16 / 9, 6);
  });

  it('makes no aspect claim when there is nothing to parse', () => {
    for (const value of ['', 'wide', null, undefined, '16:0']) {
      expect(parseAspectRatio(value as string)).toBeNull();
    }
  });
});

describe('cuts against the beat of a video cut to its music', () => {
  const beats = Array.from({ length: 40 }, (_unused, index) => Math.round((index + 1) * BEAT_SEC * 1000) / 1000);

  it('passes cuts within a frame of a beat and names the ones further off, the way the beat check counts them', () => {
    // At 30 fps a frame is 33 ms: 1.89 s sits a frame from the 1.875 s beat, 9.30 s two frames
    // before 9.375 s and 11.17 s two before 11.25 s.
    expect(assessCutsOffBeat([0.933, 1.89, 2.8], beats, 30)).toEqual([]);
    const issues = assessCutsOffBeat([1.875, 9.3, 11.17], beats, 30);
    expect(issues).toEqual([{
      code: 'DELIVERY_CUTS_OFF_BEAT',
      severity: 'warning',
      message: "2 of 3 cuts are more than a frame off the beat: 9.30s (beat 9.38s), 11.17s (beat 11.25s). Take each cut's frame from the beat list rather than adding up a beat length, then render and deliver again.",
    }]);
  });

  it('names four cuts and counts the rest', () => {
    const late = [3, 5, 7, 9, 11, 13].map((beat) => Math.round((beat * BEAT_SEC + 0.1) * 1000) / 1000);
    expect(assessCutsOffBeat(late, beats, 30)[0].message).toMatch(/^6 of 6 cuts .*, and 2 more\. Take each cut/);
  });

  it('says nothing without cuts, beats or a frame rate', () => {
    expect(assessCutsOffBeat([], beats, 30)).toEqual([]);
    expect(assessCutsOffBeat([9.33], [], 30)).toEqual([]);
    expect(assessCutsOffBeat([9.33], beats, 0)).toEqual([]);
  });

  it('reads the cuts and the beat from the delivered file: a montage on the beat passes, one that adds up a rounded beat fails', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-beat-check-'));
    try {
      const onBeat = path.join(dir, 'on-beat.mp4');
      const drifting = path.join(dir, 'drifting.mp4');
      const toneOnly = path.join(dir, 'tone.mp4');
      makeBeatMontage(onBeat, 16, onBeatCuts(16));
      makeBeatMontage(drifting, 16, driftingCuts(16));
      makeBeatMontage(toneOnly, 16, driftingCuts(16), 'tone');
      expect(await cutsOffBeatIssues(onBeat, 30)).toEqual([]);
      const off = await cutsOffBeatIssues(drifting, 30);
      expect(off.map((issue) => issue.code)).toEqual(['DELIVERY_CUTS_OFF_BEAT']);
      // Every one of the sixteen joins is read as a cut; the later ones have drifted off.
      expect(off[0].message).toMatch(/^[1-9]\d* of 16 cuts are more than a frame off the beat: /);
      // A soundtrack with no steady beat has nothing to cut on, so nothing is reported.
      expect(await cutsOffBeatIssues(toneOnly, 30)).toEqual([]);
      expect(await cutsOffBeatIssues(drifting, null)).toEqual([]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);
});
