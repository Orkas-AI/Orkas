import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { describe, expect, it } from 'vitest';

import { bundledFfmpegPaths } from '../../../src/main/util/bundled-runtime';

import {
  assessDeliveredNarration,
  assessDeliveredSpec,
  parseAspectRatio,
  parseIntegratedLufs,
  parseVoicedSpan,
  verifyProductionDelivery,
  type DeliveryNarrationLine,
} from '../../../src/main/features/video_studio_delivery';

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
    // Gaps were measured across 13 historical plans and no usable threshold
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
    planTotalTargetSec: 60,
    planAspect: '16:9',
    narrationLineCount: 7,
    captionLineCount: 0,
    integratedLufs: -14.2,
    sidecarSubtitleFound: false,
  };

  it('passes the delivered spec when it matches the signed plan', () => {
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

  it('catches captions the plan declared and the file does not carry', () => {
    const issues = assessDeliveredSpec({ ...base, captionLineCount: 8 });
    const captions = issues.find((issue) => issue.code === 'DELIVERY_CAPTIONS_MISSING');
    expect(captions?.message).toContain('8 caption line(s)');
    // Burned-in captions are pixels; the check says so instead of accusing.
    expect(captions?.message).toContain('Burned-in captions cannot be detected');
    // A sidecar counts as produced.
    expect(assessDeliveredSpec({ ...base, captionLineCount: 8, sidecarSubtitleFound: true })
      .some((issue) => issue.code === 'DELIVERY_CAPTIONS_MISSING')).toBe(false);
    // So does a real subtitle stream.
    expect(assessDeliveredSpec({
      ...base, captionLineCount: 8, spec: { ...base.spec, subtitleStreams: 1 },
    }).some((issue) => issue.code === 'DELIVERY_CAPTIONS_MISSING')).toBe(false);
  });

  it('catches a delivery that is not the length or shape the user approved', () => {
    const drifted = assessDeliveredSpec({ ...base, spec: { ...base.spec, durationSec: 75.04 } });
    expect(drifted.find((issue) => issue.code === 'DELIVERY_DURATION_DRIFT')?.message)
      .toContain('75.04s');
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

  it('catches a narrated plan delivered with no audio at all', () => {
    const issues = assessDeliveredSpec({ ...base, spec: { ...base.spec, hasAudio: false } });
    expect(issues.find((issue) => issue.code === 'DELIVERY_NO_AUDIO')?.severity).toBe('error');
    // No audio means no loudness verdict to add on top of it.
    expect(issues.some((issue) => issue.code === 'DELIVERY_LOUDNESS_OFF_TARGET')).toBe(false);
  });
});

describe('verifyProductionDelivery unverifiable narration', () => {
  // Run against the real 2026-08-10 hand-assembled deliverable, the first
  // artifact this checker ever saw: it reported ok:true. Every narration
  // produced_path was null, because that route mixes the audio files directly
  // and never writes the paths back — so the one check built for that route
  // passed the very delivery that shipped two overlapping lines. A declared
  // narration track that cannot be judged is unverified, not clean.
  it('refuses to call a delivery clean when it judged no narration line', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-unverifiable-'));
    try {
      const planAbsPath = path.join(dir, 'plan.json');
      const plan = {
        aspect: '16:9',
        total_target_sec: 10,
        tracks: {
          narration: {
            segments: [
              { text: 'a', start_sec: 0, target_sec: 5 },
              { text: 'b', start_sec: 5, target_sec: 5 },
            ],
          },
        },
      };
      fs.writeFileSync(planAbsPath, JSON.stringify(plan));
      const video = path.join(dir, 'final.mp4');
      fs.writeFileSync(video, 'not a video');

      const verdict = await verifyProductionDelivery({
        planAbsPath,
        plan: plan as unknown as Record<string, unknown>,
        videoAbsPath: video,
      });

      expect(verdict.ok).toBe(false);
      expect(verdict.narration_lines_measured).toBe(0);
      const unverifiable = verdict.issues.find((i) => i.code === 'DELIVERY_NARRATION_UNVERIFIABLE');
      expect(unverifiable?.severity).toBe('error');
      // Says what is missing and what to do, not just that it failed.
      expect(unverifiable?.message).toContain('2 of 2 narration line(s)');
      // Names the field each line actually lacks. 2026-08-10: the message said
      // "no readable produced_path" for lines that HAD produced_path and were
      // missing start_sec, and the model rewrote correct paths seven times.
      expect(unverifiable?.message).toContain('line 0 — no produced_path');
      // And says why the artifact alone cannot answer it, so nobody "fixes"
      // this by trying to read overlap off the mixed track.
      expect(unverifiable?.message).toContain('mixed track cannot supply');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);

  it('names start_sec when that is the field a line is missing', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-no-start-'));
    try {
      // The plan lives at <video>/project/plan.json and produced_path reads
      // `project/audio/...` — relative to the VIDEO dir, not the plan's own
      // folder. Resolving one level deep made every line unreadable and the
      // refusal blamed the path.
      const projectDir = path.join(dir, 'project');
      const audioDir = path.join(projectDir, 'audio');
      fs.mkdirSync(audioDir, { recursive: true });
      const bins = bundledFfmpegPaths();
      if (!bins.ffmpeg) return;
      const r = spawnSync(bins.ffmpeg, [
        '-y', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2',
        '-c:a', 'libmp3lame', path.join(audioDir, 'line-0.mp3'),
      ], { encoding: 'utf8' });
      expect(r.status, r.stderr).toBe(0);

      const planAbsPath = path.join(projectDir, 'plan.json');
      const plan = {
        aspect: '16:9',
        total_target_sec: 10,
        tracks: {
          narration: {
            // produced_path is present and correct; start_sec is not.
            segments: [{ text: 'a', target_sec: 5, produced_path: 'project/audio/line-0.mp3' }],
          },
        },
      };
      fs.writeFileSync(planAbsPath, JSON.stringify(plan));
      const video = path.join(projectDir, 'final.mp4');
      fs.writeFileSync(video, 'not a video');

      const verdict = await verifyProductionDelivery({
        planAbsPath,
        plan: plan as unknown as Record<string, unknown>,
        videoAbsPath: video,
      });
      const unverifiable = verdict.issues.find((i) => i.code === 'DELIVERY_NARRATION_UNVERIFIABLE');
      expect(unverifiable?.message).toContain('line 0 — no start_sec');
      expect(unverifiable?.message).not.toContain('no produced_path');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);

  it('says nothing about narration when the plan declares none', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-no-narration-'));
    try {
      const planAbsPath = path.join(dir, 'plan.json');
      const plan = { aspect: '16:9', total_target_sec: 10, tracks: {} };
      fs.writeFileSync(planAbsPath, JSON.stringify(plan));
      const video = path.join(dir, 'final.mp4');
      fs.writeFileSync(video, 'not a video');
      const verdict = await verifyProductionDelivery({
        planAbsPath,
        plan: plan as unknown as Record<string, unknown>,
        videoAbsPath: video,
      });
      expect(verdict.issues.some((i) => i.code === 'DELIVERY_NARRATION_UNVERIFIABLE')).toBe(false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);
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
  it('parses the shapes plans use', () => {
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

describe('verifyProductionDelivery', () => {
  const bins = bundledFfmpegPaths();

  it.skipIf(!bins.ffmpeg || !bins.ffprobe)('finds real collisions in a hand-assembled file', async () => {
    // End to end against real media, because the whole point is that the check
    // reads the artifact rather than trusting the route that made it. Two
    // narration lines whose speech collides by ~1s, mixed into a silent 10s
    // clip the way a hand-written ffmpeg pipeline would.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-delivery-'));
    try {
      // Real layout: the plan lives at <video>/project/plan.json and its paths
      // read `project/audio/...`. The first version of this test put both in
      // one flat directory, which matched the resolution bug rather than
      // production and so stayed green while every real run measured 0 lines.
      const projectDir = path.join(dir, 'project');
      const audioDir = path.join(projectDir, 'audio');
      fs.mkdirSync(audioDir, { recursive: true });
      const tone = (name: string, seconds: number): string => {
        const out = path.join(audioDir, name);
        const r = spawnSync(bins.ffmpeg!, [
          '-y', '-f', 'lavfi', '-i', `sine=frequency=440:duration=${seconds}`,
          '-c:a', 'libmp3lame', out,
        ], { encoding: 'utf8' });
        expect(r.status, r.stderr).toBe(0);
        return out;
      };
      tone('line-0.mp3', 4);
      tone('line-1.mp3', 2);
      const video = path.join(projectDir, 'final.mp4');
      const mk = spawnSync(bins.ffmpeg!, [
        '-y', '-f', 'lavfi', '-i', 'color=c=black:s=320x180:r=15:d=10',
        '-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=48000',
        '-shortest', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', video,
      ], { encoding: 'utf8' });
      expect(mk.status, mk.stderr).toBe(0);

      const planPath = path.join(projectDir, 'plan.json');
      const plan = {
        aspect: '16:9',
        total_target_sec: 10,
        language: 'en',
        tracks: {
          narration: {
            segments: [
              { text: 'first', start_sec: 0, target_sec: 3, produced_path: 'project/audio/line-0.mp3' },
              { text: 'second', start_sec: 3, target_sec: 4, produced_path: 'project/audio/line-1.mp3' },
            ],
          },
          captions: { lines: [{ text: 'a', start_sec: 0, target_sec: 3 }] },
        },
      };
      fs.writeFileSync(planPath, JSON.stringify(plan));

      const verdict = await verifyProductionDelivery({
        planAbsPath: planPath,
        plan: plan as unknown as Record<string, unknown>,
        videoAbsPath: video,
      });

      expect(verdict.ok).toBe(false);
      expect(verdict.narration_lines_measured).toBe(2);
      expect(verdict.duration_sec).toBeGreaterThan(9.5);
      expect(verdict.canvas).toBe('320x180');
      const codes = verdict.issues.map((issue) => issue.code);
      // Line 0 speaks 0–4s, line 1 starts at 3s: one second of two voices in a
      // file no assembly operation ever saw.
      expect(codes).toContain('DELIVERY_NARRATION_OVERLAP');
      // The plan declared a caption line and nothing carries it.
      expect(codes).toContain('DELIVERY_CAPTIONS_MISSING');
      // 320x180 is 16:9 and 10s matches the plan, so neither is reported.
      expect(codes).not.toContain('DELIVERY_ASPECT_MISMATCH');
      expect(codes).not.toContain('DELIVERY_DURATION_DRIFT');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 120_000);
});
