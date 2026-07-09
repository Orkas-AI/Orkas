import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import {
  draftComposition,
  isCompositionRequestUrlAllowed,
  renderComposition,
  shouldNormalizeLoudness,
  transcribeSpeech,
  withVideoStudioTimeout,
} from '../../../src/main/features/video_studio';
import {
  loadDesignContract,
  loadNarrationMap,
  loadSceneMap,
  runAudioTimingQa,
  summarizeDraftInspectDisposition,
  summarizeVideoFrameQa,
  type CompositionMeta,
} from '../../../src/main/features/video_studio_qa';

function tmpProject(label: string) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `orkas-native-video-${label}-`));
  const compositionDir = path.join(root, 'project', 'composition');
  fs.mkdirSync(compositionDir, { recursive: true });
  return {
    root,
    compositionDir,
    renderDir: path.join(root, 'project', 'render'),
    reportPath: path.join(root, 'project', 'render', 'draft-report.json'),
    outputPath: path.join(root, 'project', 'render', 'draft.mp4'),
  };
}

function writeHtml(compositionDir: string, text: string, attrs: { width?: number; height?: number; duration?: number } = {}) {
  const width = attrs.width ?? 1920;
  const height = attrs.height ?? 1080;
  const duration = attrs.duration ?? 10;
  fs.writeFileSync(path.join(compositionDir, 'index.html'), [
    '<!doctype html>',
    '<html><body>',
    `<main data-composition-id="main" data-width="${width}" data-height="${height}" data-duration="${duration}">`,
    `<section class="clip" data-start="0" data-duration="${duration}"><h1>${text}</h1></section>`,
    '</main>',
    '</body></html>',
  ].join('\n'), 'utf8');
}

function writeHtmlWithAudio(compositionDir: string, text: string, attrs: { width?: number; height?: number; duration?: number } = {}) {
  const width = attrs.width ?? 1920;
  const height = attrs.height ?? 1080;
  const duration = attrs.duration ?? 10;
  fs.writeFileSync(path.join(compositionDir, 'index.html'), [
    '<!doctype html>',
    '<html><body>',
    `<main data-composition-id="main" data-width="${width}" data-height="${height}" data-duration="${duration}">`,
    `<audio src="./assets/narration.mp3" data-start="0" data-duration="${duration}"></audio>`,
    `<section class="clip" data-start="0" data-duration="${duration}"><h1>${text}</h1></section>`,
    '</main>',
    '</body></html>',
  ].join('\n'), 'utf8');
}

function writeContract(compositionDir: string, overrides: Record<string, unknown> = {}) {
  fs.writeFileSync(path.join(compositionDir, 'design-contract.json'), JSON.stringify({
    canvas: { width: 1920, height: 1080, duration: 10, fps: 30 },
    scenes: [{ id: 'cover', start: 0, duration: 10, headline: 'Launch' }],
    ...overrides,
  }, null, 2), 'utf8');
}

function writeSceneMap(compositionDir: string, overrides: Record<string, unknown> = {}) {
  fs.writeFileSync(path.join(compositionDir, 'scene-map.json'), JSON.stringify({
    canvas: { width: 1920, height: 1080, duration: 10, fps: 30 },
    scenes: [{ id: 'cover', start: 0, duration: 10, headline: 'Launch', narration: 'Launch narration.' }],
    ...overrides,
  }, null, 2), 'utf8');
}

const ENV_KEYS = [
  'ORKAS_BUNDLED_FFMPEG',
  'ORKAS_RUNTIME_DIR',
  'ORKAS_WHISPER_CPP',
  'ORKAS_WHISPER_CLI',
  'ORKAS_WHISPER_MODEL',
] as const;
const originalEnv = new Map<string, string | undefined>();
for (const key of ENV_KEYS) originalEnv.set(key, process.env[key]);

afterEach(() => {
  for (const key of ENV_KEYS) {
    const original = originalEnv.get(key);
    if (original === undefined) delete process.env[key];
    else process.env[key] = original;
  }
});

function writeExecutable(file: string, body: string) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body, 'utf8');
  fs.chmodSync(file, 0o755);
}

describe('native VideoStudio draft QA parity', () => {
  it('S1 blocks composition BrowserWindow file:// requests outside composition_dir', async () => {
    const p = tmpProject('file-sandbox');
    const inside = path.join(p.compositionDir, 'assets', 'ok.png');
    fs.mkdirSync(path.dirname(inside), { recursive: true });
    fs.writeFileSync(inside, 'ok');
    const outside = path.join(p.root, 'secret.txt');
    fs.writeFileSync(outside, 'secret');

    expect(isCompositionRequestUrlAllowed(pathToFileURL(inside).toString(), p.compositionDir)).toBe(true);
    expect(isCompositionRequestUrlAllowed('data:image/png;base64,AA==', p.compositionDir)).toBe(true);
    expect(isCompositionRequestUrlAllowed('about:blank', p.compositionDir)).toBe(true);
    expect(isCompositionRequestUrlAllowed(pathToFileURL(outside).toString(), p.compositionDir)).toBe(false);
    expect(isCompositionRequestUrlAllowed('https://example.test/asset.png', p.compositionDir)).toBe(false);

    const link = path.join(p.compositionDir, 'assets', 'secret-link.txt');
    try {
      fs.symlinkSync(outside, link);
      expect(isCompositionRequestUrlAllowed(pathToFileURL(link).toString(), p.compositionDir)).toBe(false);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EPERM') throw err;
    }
  });

  it('S1 rejects stalled native renderer work through the watchdog', async () => {
    await expect(withVideoStudioTimeout(
      new Promise(() => {}),
      1,
      'E_TEST_TIMEOUT',
      'test timeout',
    )).rejects.toMatchObject({ errorCode: 'E_TEST_TIMEOUT', message: 'test timeout' });
  });

  it('S1 enforces the draft repair budget and blocks attempts after two repairs', async () => {
    const p = tmpProject('repair-budget');

    const attempts = [];
    for (let i = 0; i < 4; i += 1) {
      attempts.push(await draftComposition({
        compositionDirAbs: p.compositionDir,
        outputAbsPath: p.outputPath,
        reportAbsPath: p.reportPath,
      }));
    }

    expect(attempts[0]).toMatchObject({ ok: false, errorCode: 'E_LINT_BLOCKED' });
    expect(attempts[1]).toMatchObject({ ok: false, errorCode: 'E_LINT_BLOCKED' });
    expect(attempts[2]).toMatchObject({
      ok: false,
      errorCode: 'E_LINT_BLOCKED',
      repair_budget: expect.objectContaining({ budget_exhausted: true, repair_passes_used: 2 }),
    });
    expect(attempts[3]).toMatchObject({ ok: false, errorCode: 'E_REPAIR_BUDGET_EXCEEDED' });
    expect(fs.existsSync(path.join(p.compositionDir, 'qa', 'draft-repair-state.json'))).toBe(true);
  });

  it('S2 blocks contract_html mismatches before rendering', async () => {
    const p = tmpProject('contract-html');
    writeHtml(p.compositionDir, 'Launch', { width: 1280, height: 720, duration: 10 });
    writeContract(p.compositionDir);
    writeSceneMap(p.compositionDir);

    const res = await draftComposition({
      compositionDirAbs: p.compositionDir,
      outputAbsPath: p.outputPath,
      reportAbsPath: p.reportPath,
    });

    expect(res).toMatchObject({
      ok: false,
      errorCode: 'E_CONTRACT_HTML_BLOCKED',
      contract_html: expect.objectContaining({
        ok: false,
        issues: expect.arrayContaining([expect.objectContaining({ code: 'CANVAS_CONTRACT_MISMATCH' })]),
      }),
    });
    expect(fs.existsSync(p.outputPath)).toBe(false);
  });

  it('S2 blocks shotlist/source alignment drift before rendering', async () => {
    const p = tmpProject('source-alignment');
    writeHtml(p.compositionDir, 'Launch');
    writeContract(p.compositionDir);
    writeSceneMap(p.compositionDir);
    fs.writeFileSync(path.join(p.root, 'project', 'shotlist.json'), JSON.stringify({
      shots: [
        { id: 's1', headline: 'Launch' },
        { id: 's2', headline: 'Second approved beat' },
      ],
    }, null, 2), 'utf8');

    const res = await draftComposition({
      compositionDirAbs: p.compositionDir,
      outputAbsPath: p.outputPath,
      reportAbsPath: p.reportPath,
    });

    expect(res).toMatchObject({
      ok: false,
      errorCode: 'E_SOURCE_ALIGNMENT_BLOCKED',
      source_alignment: expect.objectContaining({
        issues: expect.arrayContaining([expect.objectContaining({ code: 'SHOTLIST_SCENE_MAP_MISMATCH' })]),
      }),
    });
  });

  it('S1/S2 blocks declared composition narration that would render silent', async () => {
    const p = tmpProject('silent-narration');
    writeHtml(p.compositionDir, 'Launch');
    writeContract(p.compositionDir, {
      audio: { owner: 'composition', narration_path: './assets/narration.mp3', target_sec: 10 },
    });
    writeSceneMap(p.compositionDir);

    const res = await draftComposition({
      compositionDirAbs: p.compositionDir,
      outputAbsPath: p.outputPath,
      reportAbsPath: p.reportPath,
    });

    expect(res).toMatchObject({
      ok: false,
      errorCode: 'E_AUDIO_TIMING_BLOCKED',
      audio_timing: expect.objectContaining({
        issues: expect.arrayContaining([expect.objectContaining({ code: 'NARRATION_DECLARED_BUT_SILENT' })]),
      }),
    });
    expect(fs.existsSync(p.outputPath)).toBe(false);
  });

  it('S2 blocks narration-map timing drift before rendering', async () => {
    const p = tmpProject('narration-drift');
    fs.mkdirSync(path.join(p.compositionDir, 'assets'), { recursive: true });
    fs.writeFileSync(path.join(p.compositionDir, 'assets', 'narration.mp3'), 'fake narration');
    writeHtmlWithAudio(p.compositionDir, 'Line one');
    writeContract(p.compositionDir, {
      audio: { owner: 'composition', narration_path: './assets/narration.mp3', target_sec: 10 },
    });
    writeSceneMap(p.compositionDir, {
      audio: { narration: './assets/narration.mp3' },
      scenes: [{ id: 'cover', start: 5, duration: 2, headline: 'Line one', narration_ref: 'n1' }],
    });
    fs.writeFileSync(path.join(p.compositionDir, 'narration-map.json'), JSON.stringify({
      lines: [{ id: 'n1', start: 0, duration: 2, text: 'Line one.' }],
    }, null, 2), 'utf8');

    const res = await draftComposition({
      compositionDirAbs: p.compositionDir,
      outputAbsPath: p.outputPath,
      reportAbsPath: p.reportPath,
    });

    expect(res).toMatchObject({
      ok: false,
      errorCode: 'E_AUDIO_TIMING_BLOCKED',
      audio_timing: expect.objectContaining({
        issues: expect.arrayContaining([expect.objectContaining({ code: 'NARRATION_LINE_START_DRIFT' })]),
      }),
    });
    expect(fs.existsSync(p.outputPath)).toBe(false);
  });

  it('S2 blocks ref-only narrated scenes when narration-map is missing', async () => {
    const p = tmpProject('missing-narration-map');
    fs.mkdirSync(path.join(p.compositionDir, 'assets'), { recursive: true });
    fs.writeFileSync(path.join(p.compositionDir, 'assets', 'narration.mp3'), 'fake narration');
    writeHtmlWithAudio(p.compositionDir, 'Line one Line two');
    writeContract(p.compositionDir, {
      audio: { owner: 'composition', narration_path: './assets/narration.mp3', target_sec: 10 },
    });
    writeSceneMap(p.compositionDir, {
      audio: { narration: './assets/narration.mp3', narration_duration_seconds: 10 },
      scenes: [
        { id: 's01', start: 0, duration: 5, headline: 'Line one', narration_ref: 'n01' },
        { id: 's02', start: 5, duration: 5, headline: 'Line two', narration_ref: 'n02' },
      ],
    });

    const res = await draftComposition({
      compositionDirAbs: p.compositionDir,
      outputAbsPath: p.outputPath,
      reportAbsPath: p.reportPath,
    });

    expect(res).toMatchObject({
      ok: false,
      errorCode: 'E_AUDIO_TIMING_BLOCKED',
      audio_timing: expect.objectContaining({
        issues: expect.arrayContaining([expect.objectContaining({ code: 'NARRATION_MAP_MISSING', severity: 'error' })]),
      }),
    });
    expect(fs.existsSync(p.outputPath)).toBe(false);
  });

  it('S2 accepts scene_id narration-map lines with end times for timed audio refs', async () => {
    const p = tmpProject('scene-id-narration-map');
    fs.mkdirSync(path.join(p.compositionDir, 'assets'), { recursive: true });
    const narrationPath = path.join(p.compositionDir, 'assets', 'narration.mp3');
    fs.writeFileSync(narrationPath, 'fake narration');
    writeContract(p.compositionDir, {
      audio: { owner: 'composition', narration_path: './assets/narration.mp3', target_sec: 8 },
    });
    writeSceneMap(p.compositionDir, {
      audio: { narration: './assets/narration.mp3', narration_duration_seconds: 8 },
      scenes: [
        { id: 's01', start: 0, end: 4, headline: 'Line one', narration_ref: 'assets/narration.mp3#t=0.00,4.00' },
        { id: 's02', start: 4, end: 8, headline: 'Line two', narration_ref: 'assets/narration.mp3#t=4.00,8.00' },
      ],
    });
    fs.writeFileSync(path.join(p.compositionDir, 'narration-map.json'), JSON.stringify({
      lines: [
        { scene_id: 's01', start: 0, end: 4, text: 'Line one.' },
        { scene_id: 's02', start: 4, end: 8, text: 'Line two.' },
      ],
    }, null, 2), 'utf8');

    const meta: CompositionMeta = {
      htmlPath: path.join(p.compositionDir, 'index.html'),
      html: '',
      rootAttrs: {},
      id: 'main',
      width: 1920,
      height: 1080,
      durationSec: 8,
      audioTracks: [{ absPath: narrationPath, startSec: 0, declaredDurationSec: 8, volume: 1 }],
    };
    const audioTiming = await runAudioTimingQa(
      meta,
      await loadDesignContract(p.compositionDir),
      await loadSceneMap(p.compositionDir),
      await loadNarrationMap(p.compositionDir),
      p.compositionDir,
    );

    expect(audioTiming).toMatchObject({
      ok: true,
      narration_line_count: 2,
      error_count: 0,
    });
  });

  it('S2 estimates inline narration_text timing against actual narration duration', async () => {
    const p = tmpProject('inline-narration-text-drift');
    fs.mkdirSync(path.join(p.compositionDir, 'assets'), { recursive: true });
    const narrationPath = path.join(p.compositionDir, 'assets', 'narration.mp3');
    fs.writeFileSync(narrationPath, 'fake narration');
    writeContract(p.compositionDir, {
      audio: { owner: 'composition', narration_path: './assets/narration.mp3', target_sec: 10 },
    });
    writeSceneMap(p.compositionDir, {
      audio: { narration: './assets/narration.mp3', narration_duration_seconds: 5 },
      scenes: [
        { id: 's01', start: 0, duration: 2, headline: 'Line one', narration_text: 'Line one.' },
        { id: 's02', start: 8, duration: 2, headline: 'Line two', narration_text: 'Line two.' },
      ],
    });

    const meta: CompositionMeta = {
      htmlPath: path.join(p.compositionDir, 'index.html'),
      html: '',
      rootAttrs: {},
      id: 'main',
      width: 1920,
      height: 1080,
      durationSec: 10,
      audioTracks: [{ absPath: narrationPath, startSec: 0, declaredDurationSec: 5, volume: 1 }],
    };
    const audioTiming = await runAudioTimingQa(
      meta,
      await loadDesignContract(p.compositionDir),
      await loadSceneMap(p.compositionDir),
      await loadNarrationMap(p.compositionDir),
      p.compositionDir,
    );

    expect(audioTiming).toMatchObject({
      ok: false,
      issues: expect.arrayContaining([expect.objectContaining({ code: 'AUDIO_TIMING_DRIFT' })]),
    });
  });

  it('S2 discovers bundled whisper runtime for speech.transcribe without env-only setup', async () => {
    const p = tmpProject('bundled-whisper');
    const input = path.join(p.root, 'raw.mp4');
    const transcript = path.join(p.root, 'project', 'transcript.json');
    fs.writeFileSync(input, 'fake media');

    const fakeFfmpeg = path.join(p.root, 'ffmpeg');
    writeExecutable(fakeFfmpeg, [
      '#!/usr/bin/env node',
      "const fs = require('node:fs');",
      "fs.writeFileSync(process.argv[process.argv.length - 1], 'wav');",
      '',
    ].join('\n'));

    const runtimeRoot = path.join(p.root, 'runtime');
    const fakeWhisper = path.join(runtimeRoot, 'whisper', 'current', 'bin', 'whisper-cli');
    writeExecutable(fakeWhisper, [
      '#!/usr/bin/env node',
      "const fs = require('node:fs');",
      "const outIndex = process.argv.indexOf('-of');",
      "const outBase = outIndex >= 0 ? process.argv[outIndex + 1] : 'transcript';",
      "fs.writeFileSync(`${outBase}.json`, JSON.stringify({ text: 'hello world', segments: [] }));",
      '',
    ].join('\n'));
    const model = path.join(runtimeRoot, 'whisper', 'current', 'models', 'ggml-base.bin');
    fs.mkdirSync(path.dirname(model), { recursive: true });
    fs.writeFileSync(model, 'model');

    process.env.ORKAS_BUNDLED_FFMPEG = fakeFfmpeg;
    process.env.ORKAS_RUNTIME_DIR = runtimeRoot;
    delete process.env.ORKAS_WHISPER_CPP;
    delete process.env.ORKAS_WHISPER_CLI;
    delete process.env.ORKAS_WHISPER_MODEL;

    const res = await transcribeSpeech({ inputAbsPath: input, transcriptAbsPath: transcript });

    expect(res).toMatchObject({
      ok: true,
      op: 'speech.transcribe',
      backend: 'orkas-native:whisper.cpp',
      backend_source: 'bundled',
    });
    expect(fs.existsSync(transcript)).toBe(true);
  });

  it('S2 blocks incompatible local GSAP vendor files before rendering', async () => {
    const p = tmpProject('gsap-vendor-incompatible');
    fs.mkdirSync(path.join(p.compositionDir, 'assets', 'vendor'), { recursive: true });
    fs.writeFileSync(path.join(p.compositionDir, 'assets', 'vendor', 'gsap.min.js'), 'window.gsap = {};', 'utf8');
    writeHtml(p.compositionDir, 'Launch');
    fs.appendFileSync(path.join(p.compositionDir, 'index.html'), [
      '<script src="./assets/vendor/gsap.min.js"></script>',
      '<script>window.__timelines = {}; window.__timelines.main = gsap.timeline({ paused: true });</script>',
    ].join('\n'), 'utf8');
    writeContract(p.compositionDir);
    writeSceneMap(p.compositionDir);

    const res = await draftComposition({
      compositionDirAbs: p.compositionDir,
      outputAbsPath: p.outputPath,
      reportAbsPath: p.reportPath,
    });

    expect(res).toMatchObject({
      ok: false,
      errorCode: 'E_LINT_BLOCKED',
      lint_summary: expect.objectContaining({
        issues: expect.arrayContaining([expect.objectContaining({ code: 'VENDOR_GSAP_INCOMPATIBLE' })]),
      }),
    });
    expect(fs.existsSync(p.outputPath)).toBe(false);
  });

  it('S1 fails heavy high-quality renders fast on constrained machines', async () => {
    const p = tmpProject('heavy-render');
    writeHtml(p.compositionDir, 'Launch', { width: 1920, height: 1080, duration: 60 });
    const previous = process.env.ORKAS_MOCK_RAM_GB;
    process.env.ORKAS_MOCK_RAM_GB = '8';
    try {
      const res = await renderComposition({
        compositionDirAbs: p.compositionDir,
        outputAbsPath: p.outputPath,
        quality: 'high',
      });
      expect(res).toMatchObject({
        ok: false,
        errorCode: 'E_RENDER_TOO_HEAVY',
        render_profile: expect.objectContaining({ constrained: true, decision: 'fail_fast' }),
      });
      expect(fs.existsSync(p.outputPath)).toBe(false);
    } finally {
      if (previous === undefined) delete process.env.ORKAS_MOCK_RAM_GB;
      else process.env.ORKAS_MOCK_RAM_GB = previous;
    }
  });

  it('S3 classifies visual inspect issues as advisories and structural issues as blockers', () => {
    const findings = JSON.stringify({
      ok: false,
      errorCount: 2,
      warningCount: 1,
      issues: [
        { code: 'TEXT_OVERFLOW', severity: 'error', message: 'visual overflow' },
        { code: 'timeline_runtime_missing', severity: 'error', message: 'no runtime' },
        { code: 'FONT_TOO_SMALL', severity: 'warning', message: 'small text' },
      ],
    });

    expect(summarizeDraftInspectDisposition(findings)).toMatchObject({
      blocking_error_count: 1,
      advisory_count: 2,
      blocking_issues: [expect.objectContaining({ code: 'timeline_runtime_missing' })],
    });
  });

  it('S3 reports blank/frozen sampled frames with contact-sheet evidence fields', () => {
    const qa = summarizeVideoFrameQa({
      evidence_dir: '/tmp/evidence',
      contact_sheet: '/tmp/evidence/contact-sheet.svg',
      frame_paths: ['/tmp/evidence/01.png', '/tmp/evidence/02.png', '/tmp/evidence/03.png'],
      samples: [
        { label: 'first-frame', time_seconds: 0, frame_index: 0, path: '/tmp/evidence/01.png', hash: 'same', brightness: 0, contrast: 0, width: 1920, height: 1080 },
        { label: 'midpoint', time_seconds: 5, frame_index: 75, path: '/tmp/evidence/02.png', hash: 'same', brightness: 0, contrast: 0, width: 1920, height: 1080 },
        { label: 'payoff-frame', time_seconds: 10, frame_index: 150, path: '/tmp/evidence/03.png', hash: 'same', brightness: 0, contrast: 0, width: 1920, height: 1080 },
      ],
    }, 10);

    expect(qa).toMatchObject({
      ok: false,
      contact_sheet: '/tmp/evidence/contact-sheet.svg',
      frame_paths: expect.arrayContaining(['/tmp/evidence/01.png']),
      issues: expect.arrayContaining([
        expect.objectContaining({ code: 'EMPTY_HOOK_FRAME' }),
        expect.objectContaining({ code: 'FROZEN_FRAME_RUN' }),
      ]),
    });
  });

  it('P1 normalizes loudness only for high exports or clearly off-target drafts', () => {
    const nearTarget = {
      ok: true,
      input_i: -15,
      input_tp: -1.2,
      input_lra: 6,
      target_i: -14,
      target_tp: -1,
      target_lra: 11,
    };
    const quietDraft = {
      ...nearTarget,
      input_i: -22,
    };

    expect(shouldNormalizeLoudness(nearTarget, 'draft')).toMatchObject({
      normalize: false,
      reason: 'within draft loudness tolerance',
    });
    expect(shouldNormalizeLoudness(nearTarget, 'high')).toMatchObject({
      normalize: true,
      reason: 'high quality export',
    });
    expect(shouldNormalizeLoudness(quietDraft, 'draft')).toMatchObject({
      normalize: true,
    });
  });
});
