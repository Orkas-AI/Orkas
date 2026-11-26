import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({}));

import {
  REFERENCE_MOTION_CODE,
  assessMotionAgainstReference,
  compareWithReference,
  findFollowedReference,
  parseMotionSamples,
  quarterMedians,
  referenceMoments,
  referenceMotionIssue,
  writeReferenceComparisonSheet,
} from '../../../src/main/features/video_reference_compare';
import { bundledFfmpegPaths } from '../../../src/main/util/bundled-runtime';

describe('referenceMoments', () => {
  it('takes the middle of each quarter of each video, whatever their lengths', () => {
    expect(referenceMoments(12, 20)).toEqual([
      { row: 1, share: 0.125, referenceSec: 1.5, videoSec: 2.5 },
      { row: 2, share: 0.375, referenceSec: 4.5, videoSec: 7.5 },
      { row: 3, share: 0.625, referenceSec: 7.5, videoSec: 12.5 },
      { row: 4, share: 0.875, referenceSec: 10.5, videoSec: 17.5 },
    ]);
  });

  it('measures a long video over its first five minutes only', () => {
    expect(referenceMoments(1200, 10).at(-1)?.referenceSec).toBe(262.5);
  });
});

describe('motion samples', () => {
  it('pairs each frame time with the change that follows it', () => {
    const stderr = [
      '[Parsed_metadata_4 @ 0x1] frame:0    pts:1      pts_time:0.125',
      '[Parsed_metadata_4 @ 0x1] lavfi.signalstats.YAVG=4.5',
      '[Parsed_metadata_4 @ 0x1] frame:1    pts:2      pts_time:0.25',
      '[Parsed_metadata_4 @ 0x1] lavfi.signalstats.YAVG=0',
    ].join('\r\n');
    expect(parseMotionSamples(stderr)).toEqual([{ atSec: 0.125, change: 4.5 }, { atSec: 0.25, change: 0 }]);
  });

  it('takes each quarter\'s median, so one cut does not count as movement', () => {
    const samples = [0.1, 0.2, 0.3, 1.1, 1.2, 1.3, 2.1, 2.2, 3.1, 3.2, 3.3, 3.9]
      .map((atSec, index) => ({ atSec, change: index === 4 ? 60 : atSec < 2 ? 3 : 0 }));
    expect(quarterMedians(samples, 4)).toEqual([3, 3, 0, 0]);
  });

  it('leaves a quarter with fewer than two samples unmeasured', () => {
    expect(quarterMedians([{ atSec: 0.1, change: 2 }, { atSec: 0.2, change: 2 }, { atSec: 3.5, change: 2 }], 4))
      .toEqual([2, null, null, null]);
  });
});

describe('assessMotionAgainstReference', () => {
  it('names a video much stiller than its reference in half or more of the compared quarters', () => {
    const assessment = assessMotionAgainstReference([6, 8, 7, 6], [5, 0.5, 0.2, 6]);
    expect(assessment.stiller).toBe(true);
    expect(assessment.weakRows).toEqual([2, 3]);
    expect(assessment.score).toBeCloseTo((5 / 6 + 0.5 / 8 + 0.2 / 7 + 1) / 4, 5);
  });

  it('lets one held quarter of four pass: a held shot is a choice, not a still video', () => {
    expect(assessMotionAgainstReference([6, 8, 7, 6], [6, 8, 0, 6]).stiller).toBe(false);
  });

  it('does not compare quarters the reference itself barely moves in, such as its end card', () => {
    const assessment = assessMotionAgainstReference([6.8, 9, 5.9, 0], [0.5, 9, 6, 0]);
    expect(assessment.rows[3].ratio).toBeNull();
    // One of three compared quarters is stiller: not half.
    expect(assessment.stiller).toBe(false);
  });

  it('says nothing when the reference never moves enough to compare', () => {
    const assessment = assessMotionAgainstReference([0.04, 0.1, 0.6, 0], [0, 0, 0, 0]);
    expect(assessment).toMatchObject({ stiller: false, weakRows: [], score: null });
  });
});

describe('referenceMotionIssue', () => {
  it('names the rows of the comparison, how far through, and how much less they move', () => {
    const moments = referenceMoments(12, 20);
    const issue = referenceMotionIssue(assessMotionAgainstReference([6, 8, 7, 6], [5, 1.6, 0.7, 6]), moments);
    expect(issue).toEqual({
      code: REFERENCE_MOTION_CODE,
      severity: 'warning',
      message: 'Beside the reference at the same point of each, this video moves much less in row 2 (38% through: 20% of the reference\'s movement)'
        + ' and row 3 (63% through: 10% of the reference\'s movement) of the reference comparison.'
        + ' Make those parts move the way the reference does there, with footage, a camera move or animation instead of a held picture, then render.',
    });
  });

  it('is absent when the video moves enough', () => {
    expect(referenceMotionIssue(assessMotionAgainstReference([6, 8, 7, 6], [6, 8, 7, 6]), referenceMoments(4, 4))).toBeNull();
  });
});

describe('findFollowedReference', () => {
  let dir: string;
  beforeAll(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-reference-find-')); });
  afterAll(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  const freeze = (production: string, video: string, inspection: string, bytes: number) => {
    const file = path.join(dir, production, 'videos', video, 'assets', 'references', `inspect-${inspection}`, 'source.mp4');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, Buffer.alloc(bytes, 1));
    return file;
  };

  it('uses the source this run inspected last', async () => {
    const older = freeze('a', 'main', 'one', 10);
    const newer = path.join(dir, 'references', 'source.mp4');
    fs.mkdirSync(path.dirname(newer), { recursive: true });
    fs.writeFileSync(newer, 'x');
    expect(await findFollowedReference({ productionDirAbs: path.join(dir, 'a'), allowedRoots: [dir], inspectedThisRun: [older, newer] })).toBe(newer);
    // One that has since gone is passed over.
    fs.rmSync(newer);
    expect(await findFollowedReference({ productionDirAbs: path.join(dir, 'a'), allowedRoots: [dir], inspectedThisRun: [older, newer] })).toBe(older);
  });

  it('otherwise uses the one source frozen under the production, inspected once or twice', async () => {
    freeze('b', 'main', 'one', 20);
    freeze('b', 'main', 'two', 20);
    expect(await findFollowedReference({ productionDirAbs: path.join(dir, 'b'), allowedRoots: [dir] })).toMatch(/source\.mp4$/);
  });

  it('does not guess between two different sources', async () => {
    freeze('c', 'main', 'one', 30);
    freeze('c', 'english', 'one', 31);
    expect(await findFollowedReference({ productionDirAbs: path.join(dir, 'c'), allowedRoots: [dir] })).toBeNull();
  });

  it('distinguishes different reference contents of the same size', async () => {
    const first = freeze('same-size', 'main', 'one', 16);
    const second = freeze('same-size', 'english', 'two', 16);
    fs.writeFileSync(second, Buffer.alloc(16, 2));
    const selection = { productionDirAbs: path.join(dir, 'same-size'), allowedRoots: [dir] };
    expect(await findFollowedReference(selection)).toBeNull();
    expect(await findFollowedReference({ ...selection, inspectedThisRun: [first, second] })).toBe(second);
  });

  it('does not read oversized duplicates or select a fallback after cancellation', async () => {
    const first = freeze('budget', 'main', 'one', 16);
    const second = freeze('budget', 'main', 'two', 16);
    const selection = { productionDirAbs: path.join(dir, 'budget'), allowedRoots: [dir] };
    expect(await findFollowedReference({ ...selection, signal: AbortSignal.abort() })).toBeNull();
    for (const candidate of [first, second]) fs.truncateSync(candidate, 256 * 1024 * 1024 + 1);
    expect(await findFollowedReference(selection)).toBeNull();
  });

  it('ignores a source outside the files the task may read', async () => {
    const file = freeze('d', 'main', 'one', 40);
    expect(await findFollowedReference({ productionDirAbs: path.join(dir, 'd'), allowedRoots: [path.join(dir, 'other')], inspectedThisRun: [file] })).toBeNull();
  });
});

describe('on real files', () => {
  const ffmpeg = bundledFfmpegPaths().ffmpeg as string;
  let dir: string;
  const make = (name: string, inputs: string[], filter?: string) => {
    const file = path.join(dir, name);
    const args = ['-y', '-hide_banner', '-loglevel', 'error'];
    for (const input of inputs) args.push('-f', 'lavfi', '-i', input);
    if (filter) args.push('-filter_complex', filter, '-map', '[v]');
    args.push('-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', file);
    const run = spawnSync(ffmpeg, args, { encoding: 'utf8' });
    if (run.status !== 0) throw new Error(run.stderr);
    return file;
  };
  let moving: string;
  let still: string;
  let halfStill: string;
  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-reference-files-'));
    moving = make('moving.mp4', ['testsrc2=s=360x640:r=30:d=4']);
    still = make('still.mp4', ['color=c=0x335577:s=360x640:r=30:d=4']);
    halfStill = make('half.mp4', ['testsrc2=s=360x640:r=30:d=2', 'color=c=0x335577:s=360x640:r=30:d=2'], '[0:v][1:v]concat=n=2:v=1:a=0[v]');
  });
  afterAll(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it('names a still video made from a moving reference, and passes one that moves like it', async () => {
    const stiller = await compareWithReference({ ffmpeg, referenceAbs: moving, videoAbs: still, videoSec: 4 });
    expect(stiller?.issue?.code).toBe(REFERENCE_MOTION_CODE);
    expect(stiller?.report.motion_score).toBe(0);
    expect(stiller?.report.rows.map((row) => row.motion_vs_reference)).toEqual([0, 0, 0, 0]);
    const alike = await compareWithReference({ ffmpeg, referenceAbs: moving, videoAbs: moving, videoSec: 4 });
    expect(alike?.issue).toBeNull();
    expect(alike?.report.motion_score).toBe(1);
  });

  it('names only the quarters that stop moving', async () => {
    const result = await compareWithReference({ ffmpeg, referenceAbs: moving, videoAbs: halfStill, videoSec: 4 });
    expect(result?.issue?.message).toContain('row 3 (63% through: 0% of the reference\'s movement) and row 4 (88% through: 0%');
    expect(result?.issue?.message).not.toContain('row 1');
  });

  it('compares nothing against a reference that is not a video or is too short', async () => {
    const text = path.join(dir, 'notes.txt');
    fs.writeFileSync(text, 'not a video');
    expect(await compareWithReference({ ffmpeg, referenceAbs: text, videoAbs: still, videoSec: 4 })).toBeNull();
    const short = make('short.mp4', ['testsrc2=s=360x640:r=30:d=1']);
    expect(await compareWithReference({ ffmpeg, referenceAbs: short, videoAbs: still, videoSec: 4 })).toBeNull();
  });

  it('keeps the reference inspection container boundary when comparing and sampling known local bytes', async () => {
    const unsupported = path.join(dir, 'unsupported.txt');
    fs.copyFileSync(moving, unsupported);
    const comparison = await compareWithReference({ ffmpeg, referenceAbs: unsupported, videoAbs: still, videoSec: 4 });
    const out = fs.mkdtempSync(path.join(dir, 'unsupported-'));
    const sheet = await writeReferenceComparisonSheet({
      ffmpeg, referenceAbs: unsupported, videoAbs: still, moments: referenceMoments(4, 4), outputDirAbs: out,
    });
    expect.soft(comparison).toBeNull();
    expect.soft(sheet).toBeNull();
    expect(fs.readdirSync(out)).toEqual([]);
  });

  it('draws the reference beside the video, one row per quarter', async () => {
    const out = fs.mkdtempSync(path.join(dir, 'sheet-'));
    const sheet = await writeReferenceComparisonSheet({ ffmpeg, referenceAbs: moving, videoAbs: still, moments: referenceMoments(4, 4), outputDirAbs: out });
    expect(sheet).toMatch(/contact-sheet\.png$/);
    const svg = fs.readFileSync(path.join(out, 'contact-sheet.svg'), 'utf8');
    expect(svg.match(/<image /g)).toHaveLength(8);
    expect(svg).toContain('1 · reference 0.5s');
    expect(svg).toContain('4 · this video 3.5s');
  });
});
