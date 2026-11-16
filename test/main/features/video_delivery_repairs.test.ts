import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  assessNarrationOverSpeech,
  assessSilentStretches,
  narrationOverSpeechIssues,
  speechSpansFromWords,
} from '../../../src/main/features/video_studio_delivery';
import { shipVideoFile } from '../../../src/main/features/video_timeline_ship';
import { bundledFfmpegPaths } from '../../../src/main/util/bundled-runtime';
import {
  editVideo,
  narrationRecordPath,
} from '../../../resources/builtin/marketplace/agents/79df9cc89f5f/skills/_shared/scripts/src/video_edit';

// Two defects a delivery could not see (2026-11-12 recap runs): narration that ended
// 33 s before the video did, and narration laid over the characters' own dialogue.

describe('assessSilentStretches', () => {
  it('names each long silence in a video that should have sound', () => {
    const [issue] = assessSilentStretches([{ startSec: 19.2, endSec: 52.1 }, { startSec: 3, endSec: 4 }], true);
    expect(issue).toMatchObject({ code: 'DELIVERY_SILENT_STRETCH', severity: 'warning' });
    expect(issue.message).toContain('19.2–52.1s (32.9s)');
    expect(issue.message).not.toContain('3.0–4.0s');
    expect(issue.message).not.toMatch(/Fill it|music|shorten the video/);
  });

  it('says nothing when the video is meant to be silent or nothing was measured', () => {
    expect(assessSilentStretches([{ startSec: 0, endSec: 30 }], false)).toEqual([]);
    expect(assessSilentStretches(null, true)).toEqual([]);
    expect(assessSilentStretches([{ startSec: 2, endSec: 4 }], true)).toEqual([]);
  });
});

describe('assessNarrationOverSpeech', () => {
  it('reports a line that speaks over the clip\'s own speech', () => {
    const speech = speechSpansFromWords([
      { startSec: 1.0, endSec: 1.4 }, { startSec: 1.5, endSec: 2.2 }, { startSec: 6, endSec: 7 },
    ]);
    expect(speech).toEqual([{ startSec: 1, endSec: 2.2 }, { startSec: 6, endSec: 7 }]);
    const [issue] = assessNarrationOverSpeech([{ index: 1, start: 0.5, end: 3 }, { index: 2, start: 3.5, end: 5.8 }], speech);
    expect(issue).toMatchObject({ code: 'DELIVERY_NARRATION_OVER_SPEECH', severity: 'warning' });
    expect(issue.message).toContain('line 1 (0.5–3.0s) over speech at 1.0–2.2s');
    expect(issue.message).not.toContain('line 2');
  });

  it('lets a line brush past speech by less than half a second', () => {
    expect(assessNarrationOverSpeech([{ index: 1, start: 2.0, end: 4 }], [{ startSec: 1, endSec: 2.3 }])).toEqual([]);
  });
});

const bins = bundledFfmpegPaths();
const haveFfmpeg = !!bins.ffmpeg && !!bins.ffprobe;
const roots: string[] = [];
const envKeys = ['ORKAS_WHISPER_CPP', 'ORKAS_WHISPER_CLI', 'ORKAS_WHISPER_MODEL'] as const;
const savedEnv = new Map<string, string | undefined>();
beforeEach(() => { for (const key of envKeys) savedEnv.set(key, process.env[key]); });
afterEach(() => {
  for (const key of envKeys) {
    const value = savedEnv.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function production(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-delivery-repairs-'));
  roots.push(root);
  fs.writeFileSync(path.join(root, 'assets.json'), JSON.stringify({ assets: [] }));
  fs.mkdirSync(path.join(root, 'render'), { recursive: true });
  return root;
}

function ffmpeg(args: string[]): void {
  const run = spawnSync(bins.ffmpeg!, ['-y', '-hide_banner', '-loglevel', 'error', ...args], { encoding: 'utf8' });
  if (run.status !== 0) throw new Error(run.stderr);
}

/** A stand-in recognizer that hears one person speaking from 0.5 s to 2.5 s. */
function fakeWhisper(root: string): void {
  const cli = path.join(root, 'whisper-cli');
  fs.writeFileSync(cli, [
    '#!/usr/bin/env node',
    "const args = process.argv.slice(2);",
    "const base = args[args.indexOf('-of') + 1];",
    "const tok = (text, from, to) => ({ text, offsets: { from, to } });",
    "require('node:fs').writeFileSync(base + '.json', JSON.stringify({ result: { language: 'zh' }, transcription: [{ offsets: { from: 500, to: 2500 }, text: ' 合同呢？', tokens: [tok(' 合同', 500, 1400), tok('呢？', 1400, 2500)] }] }));",
  ].join('\n'));
  fs.chmodSync(cli, 0o755);
  const model = path.join(root, 'ggml-base.bin');
  fs.writeFileSync(model, 'model');
  process.env.ORKAS_WHISPER_CPP = cli;
  process.env.ORKAS_WHISPER_MODEL = model;
  delete process.env.ORKAS_WHISPER_CLI;
}

describe.skipIf(!haveFfmpeg)('delivery reports sound the video lacks', () => {
  it('finds the silence after narration ends early', async () => {
    const root = production();
    const file = path.join(root, 'render', 'final.mp4');
    ffmpeg([
      '-f', 'lavfi', '-i', 'testsrc2=s=360x640:r=30:d=10',
      '-f', 'lavfi', '-i', 'sine=f=300:r=48000:d=4,apad=whole_dur=10',
      '-map', '0:v', '-map', '1:a', '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-t', '10', file,
    ]);
    const result: any = await shipVideoFile({
      productionDirAbs: root, allowedRoots: [root], videoPathAbs: file,
      expect: { durationSec: 10, aspect: '9:16', hasAudio: true },
    });
    expect(result.ok, JSON.stringify(result)).toBe(true);
    const silent = result.warnings.find((w: any) => w.code === 'DELIVERY_SILENT_STRETCH');
    expect(silent?.message).toMatch(/silent at 4\.\d–10\.0s/);
  }, 120_000);
});

describe.skipIf(!haveFfmpeg || process.platform === 'win32')('narration laid over the clip\'s own speech', () => {
  async function narrated(root: string): Promise<{ base: string; mixed: string; final: string }> {
    const base = path.join(root, 'render', 'scene.mp4');
    ffmpeg([
      '-f', 'lavfi', '-i', 'testsrc2=s=360x640:r=30:d=6',
      '-f', 'lavfi', '-i', 'sine=f=220:r=48000:d=6,volume=0.3',
      '-map', '0:v', '-map', '1:a', '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', '-c:a', 'aac',
      '-metadata', 'comment=Original production note', base,
    ]);
    const line = path.join(root, 'render', 'line-01.wav');
    ffmpeg(['-f', 'lavfi', '-i', 'sine=f=900:r=48000:d=2,volume=0.5', line]);
    const mixed = path.join(root, 'render', 'mixed.mp4');
    const mix = await editVideo({ op: 'mix', inputAbsPath: base, audioSegments: [{ audioAbsPath: line, startSec: 1 }], onExistingAudio: 'mix', duck: true, outputAbsPath: mixed });
    expect(mix.ok, JSON.stringify(mix)).toBe(true);
    const final = path.join(root, 'render', 'final.mp4');
    const norm = await editVideo({ op: 'normalize_loudness', inputAbsPath: mixed, outputAbsPath: final });
    expect(norm.ok, JSON.stringify(norm)).toBe(true);
    return { base, mixed, final };
  }

  it('records where each line speaks and carries the record through a loudness pass', async () => {
    const root = production();
    const { base, final } = await narrated(root);
    const record = JSON.parse(fs.readFileSync(narrationRecordPath(final), 'utf8'));
    expect(record).toMatchObject({ kind: 'orkas-mix-narration', base: { path: base } });
    expect(record.lines).toHaveLength(1);
    expect(record.lines[0].start).toBeCloseTo(1, 1);
    expect(record.lines[0].end).toBeCloseTo(3, 1);
    const metadata = spawnSync(bins.ffprobe!, ['-v', 'error', '-show_entries', 'format_tags=comment', '-of', 'json', final], { encoding: 'utf8' });
    expect(metadata.status).toBe(0);
    expect(JSON.parse(metadata.stdout).format.tags.comment).toBe('Original production note\nORKAS_NARRATION_MIX_V1');
  }, 120_000);

  it('marks lost narration evidence after an external video transform without guessing an overlap', async () => {
    const root = production(); const { final } = await narrated(root); fakeWhisper(root);
    const transformed = path.join(root, 'render', 'external.mp4');
    ffmpeg(['-i', final, '-vf', 'tpad=stop_mode=clone:stop_duration=0.2', '-c:v', 'libx264', '-preset', 'veryfast', '-c:a', 'aac', transformed]);
    expect(fs.existsSync(narrationRecordPath(transformed))).toBe(false);
    expect(await narrationOverSpeechIssues(transformed, root)).toMatchObject([
      { code: 'DELIVERY_NARRATION_UNVERIFIABLE', severity: 'warning' },
    ]);
    const shipped: any = await shipVideoFile({ productionDirAbs: root, allowedRoots: [root], videoPathAbs: transformed,
      expect: { durationSec: 6.2, aspect: '9:16', hasAudio: true } });
    expect(shipped.ok).toBe(true);
    expect(shipped.warnings).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'DELIVERY_NARRATION_UNVERIFIABLE' })]));
    expect(shipped.warnings.some((w: any) => w.code === 'DELIVERY_NARRATION_OVER_SPEECH')).toBe(false);
  }, 120000);

  it('does not turn malformed or stale mix evidence into a clean speech check', async () => {
    const root = production(); const { final } = await narrated(root); fakeWhisper(root);
    const file = narrationRecordPath(final), original = JSON.parse(fs.readFileSync(file, 'utf8'));
    for (const record of [null, { ...original, version: 2 }, { ...original, output: { sha256: '0'.repeat(64) } },
      { ...original, lines: [] }, { ...original, lines: [{ index: 1, start: 2, end: 1 }] },
      { ...original, lines: [null] }]) {
      fs.writeFileSync(file, JSON.stringify(record));
      expect(await narrationOverSpeechIssues(final, root)).toMatchObject([{ code: 'DELIVERY_NARRATION_UNVERIFIABLE' }]);
    }
    fs.writeFileSync(file, '{');
    expect(await narrationOverSpeechIssues(final, root)).toMatchObject([{ code: 'DELIVERY_NARRATION_UNVERIFIABLE' }]);
  }, 120000);

  it('reports the line at delivery, and marks the check unverified once its base has changed', async () => {
    const root = production();
    const { base, final } = await narrated(root);
    fakeWhisper(root);
    const [issue] = await narrationOverSpeechIssues(final, root);
    expect(issue?.code).toBe('DELIVERY_NARRATION_OVER_SPEECH');
    expect(issue.message).toContain('line 1');

    const shipped: any = await shipVideoFile({
      productionDirAbs: root, allowedRoots: [root], videoPathAbs: final,
      expect: { durationSec: 6, aspect: '9:16', hasAudio: true },
    });
    expect(shipped.ok, JSON.stringify(shipped)).toBe(true);
    expect(shipped.warnings.map((w: any) => w.code)).toContain('DELIVERY_NARRATION_OVER_SPEECH');

    fs.appendFileSync(base, 'changed');
    expect(await narrationOverSpeechIssues(final, root)).toMatchObject([{ code: 'DELIVERY_NARRATION_UNVERIFIABLE' }]);
  }, 120_000);

  it('warns when timing prevents overlap analysis without blocking an otherwise valid delivery', async () => {
    const root = production(); const { final } = await narrated(root); fakeWhisper(root);
    const cli = path.join(root, 'whisper-cli');
    fs.writeFileSync(cli, fs.readFileSync(cli, 'utf8').replace(/2500/g, '7000'));
    expect(await narrationOverSpeechIssues(final, root)).toMatchObject([{ code: 'DELIVERY_NARRATION_UNVERIFIABLE', severity: 'warning' }]);
    const delivered: any = await shipVideoFile({ productionDirAbs: root, allowedRoots: [root], videoPathAbs: final,
      expect: { durationSec: 6, aspect: '9:16', hasAudio: true } });
    expect(delivered.ok).toBe(true);
    expect(delivered.warnings).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'DELIVERY_NARRATION_UNVERIFIABLE' })]));
    expect(delivered.warnings.some((w: any) => w.code === 'DELIVERY_NARRATION_OVER_SPEECH')).toBe(false);
  }, 120000);

  it('ignores narration evidence after either the delivered file or its source was overwritten', async () => {
    const root = production();
    const { base, mixed, final } = await narrated(root);
    fakeWhisper(root);
    expect(await narrationOverSpeechIssues(final, root)).toMatchObject([{ code: 'DELIVERY_NARRATION_OVER_SPEECH' }]);

    // A later render can reuse the output name while the old sidecar remains.
    fs.copyFileSync(base, final);
    expect(await narrationOverSpeechIssues(final, root)).toEqual([]);

    // Nor may a timing-preserving pass carry obsolete evidence from its input.
    fs.copyFileSync(base, mixed);
    const normalized = await editVideo({ op: 'normalize_loudness', inputAbsPath: mixed, outputAbsPath: final });
    expect(normalized.ok, JSON.stringify(normalized)).toBe(true);
    expect(await narrationOverSpeechIssues(final, root)).toEqual([]);
  }, 120000);

  it('records nothing when the clip\'s own sound is replaced', async () => {
    const root = production();
    const { final: base } = await narrated(root);
    const line = path.join(root, 'render', 'line.wav');
    ffmpeg(['-f', 'lavfi', '-i', 'sine=f=900:r=48000:d=2', line]);
    const out = path.join(root, 'render', 'dub.mp4');
    const mix = await editVideo({ op: 'mix', inputAbsPath: base, audioSegments: [{ audioAbsPath: line, startSec: 0.5 }], onExistingAudio: 'replace', outputAbsPath: out });
    expect(mix.ok, JSON.stringify(mix)).toBe(true);
    expect(fs.existsSync(narrationRecordPath(out))).toBe(false);
    const metadata = spawnSync(bins.ffprobe!, ['-v', 'error', '-show_entries', 'format_tags=comment', '-of', 'json', out], { encoding: 'utf8' });
    expect(metadata.status).toBe(0);
    expect(JSON.parse(metadata.stdout).format.tags.comment).toBe('Original production note');
    expect(await narrationOverSpeechIssues(out, root)).toEqual([]);
  }, 120_000);
});
