
import * as fs from 'node:fs';
import { createHash } from 'node:crypto';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';

import { afterEach, describe, expect, it, vi } from 'vitest';


import {
  acquireCompositionRenderSlot,
  loadCompositionMeta,
  selectSafeFinalRenderFps,
  buildSpeechTranscribeArgs,
  buildInspectScript,
  buildFrameEncoderArgs,
  buildVideoTrackRemuxArgs,
  isCompositionRequestUrlAllowed,
  isWindowsNativeRuntimeIncompatible,
  pruneSegmentCache,
  normalizeWhisperTranscript,
  normalizeCapturedFrame,
  resolveSpeechTranscribeBackend,
  runVideoProcessForTest,
  shouldNormalizeLoudness,
  transcribeSpeech,
  videoStudioReferencedVisualAssetSignature,
  withVideoStudioTimeout,
} from '../../../src/main/features/video_studio';
import {
  analyzeNativeImage,
  dedupeInspectIssues,
  writeFrameContactSheet,
} from '../../../src/main/features/video_studio_qa';
import {
  extractHtmlResourceRefs,
  parseHtmlStructure,
} from '../../../src/main/features/video_studio_html_check';
import { registerProducedOutputHooks } from '../../../src/main/features/produced_output_hooks';
import { bundledFfmpegPaths } from '../../../src/main/util/bundled-runtime';

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

const ENV_KEYS = [
  'ORKAS_BUNDLED_FFMPEG',
  'ORKAS_BUNDLED_FFPROBE',
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

describe('native VideoStudio rendering', () => {

  it.each([
    { name: 'red', pixels: [0, 0, 255, 255, 0, 0, 255, 255], brightness: 54.21, contrast: 0 },
    { name: 'blue', pixels: [255, 0, 0, 255, 255, 0, 0, 255], brightness: 18.41, contrast: 0 },
    { name: 'green', pixels: [0, 255, 0, 255, 0, 255, 0, 255], brightness: 182.38, contrast: 0 },
    { name: 'white', pixels: [255, 255, 255, 255, 255, 255, 255, 255], brightness: 255, contrast: 0 },
    { name: 'black', pixels: [0, 0, 0, 255, 0, 0, 0, 255], brightness: 0, contrast: 0 },
    { name: 'red and black', pixels: [0, 0, 255, 255, 0, 0, 0, 255], brightness: 27.11, contrast: 27.11 },
    { name: 'blue and black', pixels: [255, 0, 0, 255, 0, 0, 0, 255], brightness: 9.21, contrast: 9.21 },
  ])('measures $name BGRA pixels without changing their identity', ({ pixels, brightness, contrast }) => {
    // Known colour patches calibrate the diagnostic values independently from
    // the implementation. Red/blue distinguish channel order; neutral colours
    // alone would miss it, and split patches also exercise spatial contrast.
    const bitmap = Buffer.from(pixels);
    const original = Buffer.from(bitmap);
    const image = {
      getSize: () => ({ width: 2, height: 1 }),
      toBitmap: () => bitmap,
    } as unknown as Parameters<typeof analyzeNativeImage>[0];

    expect(analyzeNativeImage(image)).toMatchObject({
      width: 2, height: 1, brightness, contrast,
      hash: createHash('sha256').update(original).digest('hex'),
    });
    expect(bitmap).toEqual(original);
  });

  it('publishes a raster contact sheet while retaining self-contained SVG evidence', async () => {
    const p = tmpProject('contact-sheet');
    const evidenceDir = path.join(p.compositionDir, 'preview');
    fs.mkdirSync(evidenceDir, { recursive: true });
    const framePath = path.join(evidenceDir, '01-first-frame.png');
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
    fs.writeFileSync(framePath, png);

    const out = await writeFrameContactSheet(evidenceDir, [{
      label: 'first-frame',
      time_seconds: 0,
      frame_index: 0,
      path: framePath,
      hash: 'hash',
      brightness: 1,
      contrast: 1,
      width: 1,
      height: 1,
    }]);

    const svgPath = path.join(evidenceDir, 'contact-sheet.svg');
    const svg = fs.readFileSync(svgPath, 'utf8');
    expect(out).toBe(path.join(evidenceDir, 'contact-sheet.png'));
    expect(fs.readFileSync(out).subarray(0, 8)).toEqual(
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    );
    expect(svg).toContain('href="data:image/png;base64,');
    expect(svg).not.toContain('href="01-first-frame.png"');
  });

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

  it('normalizes uniform high-DPI captures and rejects distorted geometry', () => {
    const normalizedImage = {
      getSize: () => ({ width: 1920, height: 1080 }),
    };
    const resize = vi.fn(() => normalizedImage);
    const retinaImage = {
      getSize: () => ({ width: 3840, height: 2160 }),
      resize,
    } as unknown as Parameters<typeof normalizeCapturedFrame>[0];

    expect(normalizeCapturedFrame(retinaImage, 1920, 1080)).toMatchObject({
      image: normalizedImage,
      sourceWidth: 3840,
      sourceHeight: 2160,
      scaleFactor: 2,
      normalized: true,
    });
    expect(resize).toHaveBeenCalledWith({ width: 1920, height: 1080, quality: 'best' });

    const distortedImage = {
      getSize: () => ({ width: 3840, height: 2000 }),
      resize: vi.fn(),
    } as unknown as Parameters<typeof normalizeCapturedFrame>[0];
    expect(() => normalizeCapturedFrame(distortedImage, 1920, 1080)).toThrow(
      expect.objectContaining({ errorCode: 'E_CAPTURE_GEOMETRY_INVALID' }),
    );
  });

  it('S2 scans HTML/CSS resources structurally without treating script text as markup', () => {
    const structure = parseHtmlStructure([
      '<!doctype html>',
      '<html><head>',
      '<style>.hero { background: url("./assets/hero image.png"); }</style>',
      '<script>const fake = `<img src="https://example.test/fake.png">`;</script>',
      '</head><body>',
      '<main data-composition-id="main" data-width="1920" data-height="1080" data-duration="10" title="A > B">',
      '<img src="./assets/real.png">',
      '</main></body></html>',
    ].join('\n'));

    expect(structure.tags.find((tag) => tag.attrs['data-composition-id'])?.attrs.title).toBe('A > B');
    expect(extractHtmlResourceRefs(structure)).toEqual(expect.arrayContaining([
      { attr: 'style-url', ref: './assets/hero image.png' },
      { attr: 'src', ref: './assets/real.png' },
    ]));
    expect(extractHtmlResourceRefs(structure).some((item) => item.ref.includes('example.test'))).toBe(false);
  });

  it('builds inspect probes that require effective ancestor visibility and the expected scene', () => {
    const script = buildInspectScript({
      htmlPath: '/tmp/index.html', html: '', rootAttrs: {}, id: 'main',
      width: 1920, height: 1080, durationSec: 10, audioTracks: [],
    } as any, 5, 'active-scene');

    expect(script).toContain('while (cur && cur.nodeType === Node.ELEMENT_NODE)');
    expect(script).toContain('sceneId !== expectedSceneId');
    expect(script).toContain('"active-scene"');
  });

  it('P1 bounds native-process output and settles timeout without waiting for close', async () => {
    const node = process.env.ORKAS_TEST_NODE || process.execPath;
    const noisy = await runVideoProcessForTest(node, [
      '-e',
      "process.stdout.write('x'.repeat(256)); setInterval(() => {}, 1000)",
    ], { timeoutMs: 10_000, maxOutputBytes: 32 });
    expect(noisy).toMatchObject({ code: -1, timedOut: false, aborted: false });
    expect(noisy.stderr).toContain('process output exceeded 32 bytes');

    const startedAt = Date.now();
    const timedOut = await runVideoProcessForTest(node, [
      '-e',
      'setInterval(() => {}, 1000)',
    ], { timeoutMs: 50 });
    expect(timedOut).toMatchObject({ code: -1, timedOut: true, aborted: false });
    expect(Date.now() - startedAt).toBeLessThan(5_000);
  });

  it.runIf(process.platform === 'win32')('P1 terminates a real Windows video subprocess tree', async () => {
    const p = tmpProject('video-process-tree');
    const sentinel = path.join(p.root, 'orphan-wrote.txt');
    const node = process.env.ORKAS_TEST_NODE || process.execPath;
    const grandchildScript = [
      "const fs = require('node:fs');",
      `setTimeout(() => fs.writeFileSync(${JSON.stringify(sentinel)}, 'orphaned'), 700);`,
      'setInterval(() => {}, 1000);',
    ].join('');
    const parentScript = [
      "const { spawn } = require('node:child_process');",
      `spawn(process.execPath, ['-e', ${JSON.stringify(grandchildScript)}], { stdio: 'ignore' });`,
      'setInterval(() => {}, 1000);',
    ].join('');

    await expect(runVideoProcessForTest(node, ['-e', parentScript], { timeoutMs: 75 }))
      .resolves.toMatchObject({ code: -1, timedOut: true });
    await new Promise((resolve) => setTimeout(resolve, 900));
    expect(fs.existsSync(sentinel)).toBe(false);
  });

  it('P1 streams raw BGRA frames into ffmpeg instead of compressing PNGs on the main thread', () => {
    const args = buildFrameEncoderArgs({
      outputAbsPath: '/tmp/out.mp4',
      width: 1920,
      height: 1080,
      fps: 30,
      format: 'mp4',
      quality: 'draft',
      audioTracks: [],
      durationSec: 10,
    });

    expect(args).toEqual(expect.arrayContaining([
      '-f', 'rawvideo', '-pixel_format', 'bgra', '-video_size', '1920x1080', '-i', 'pipe:0',
    ]));
    expect(args).not.toContain('png');
    expect(args.some((arg) => arg.includes('frame-%'))).toBe(false);
  });

  it('S2 resolves the bundled whisper runtime without env-only setup', () => {
    const p = tmpProject('bundled-whisper-resolution');
    const runtimeRoot = path.join(p.root, 'runtime');
    const targetDir = path.join(runtimeRoot, 'whisper', `${process.platform}-${process.arch}`);
    const cli = path.join(targetDir, 'bin', process.platform === 'win32' ? 'whisper-cli.exe' : 'whisper-cli');
    const model = path.join(targetDir, 'models', 'ggml-base-q5_1.bin');
    fs.mkdirSync(path.dirname(cli), { recursive: true });
    fs.mkdirSync(path.dirname(model), { recursive: true });
    fs.writeFileSync(cli, 'test runtime');
    fs.writeFileSync(model, 'test model');

    process.env.ORKAS_RUNTIME_DIR = runtimeRoot;
    delete process.env.ORKAS_WHISPER_CPP;
    delete process.env.ORKAS_WHISPER_CLI;
    delete process.env.ORKAS_WHISPER_MODEL;

    expect(resolveSpeechTranscribeBackend()).toEqual({ cli, model, source: 'bundled' });
  });

  it.runIf(process.platform === 'win32' && process.env.ORKAS_REAL_WHISPER_TEST === '1')(
    'Windows real bundled whisper transcribes within the performance budget', async () => {
      const p = tmpProject('bundled-whisper');
      const input = path.join(p.root, 'raw.mp4');
      const transcript = path.join(p.root, 'project', 'transcript.json');
      const runtimeRoot = path.resolve(process.cwd(), 'resources', 'runtime');
      const ffmpeg = path.join(runtimeRoot, 'ffmpeg', 'win32-x64', 'ffmpeg.exe');
      const generated = spawnSync(ffmpeg, [
        '-hide_banner', '-loglevel', 'error', '-y',
        '-f', 'lavfi', '-i', 'anullsrc=r=16000:cl=mono:d=0.2', input,
      ], { encoding: 'utf8' });
      expect(generated.status, generated.stderr).toBe(0);

      process.env.ORKAS_BUNDLED_FFMPEG = ffmpeg;
      process.env.ORKAS_RUNTIME_DIR = runtimeRoot;
      delete process.env.ORKAS_WHISPER_CPP;
      delete process.env.ORKAS_WHISPER_CLI;
      delete process.env.ORKAS_WHISPER_MODEL;

      const startedAt = Date.now();
      const res = await transcribeSpeech({ inputAbsPath: input, transcriptAbsPath: transcript });
      const elapsedMs = Date.now() - startedAt;

      expect(res, JSON.stringify(res)).toMatchObject({
        ok: true,
        op: 'speech.transcribe',
        backend: 'orkas-native:whisper.cpp',
        backend_source: 'bundled',
      });
      expect(fs.existsSync(transcript)).toBe(true);
      expect(elapsedMs).toBeLessThan(60_000);
    }, 90_000,
  );

  it('classifies signed and unsigned Windows native-runtime failures without masking normal exits', () => {
    if (process.platform === 'win32') {
      expect(isWindowsNativeRuntimeIncompatible(-1073741795)).toBe(true);
      expect(isWindowsNativeRuntimeIncompatible(0xC000001D)).toBe(true);
      expect(isWindowsNativeRuntimeIncompatible(-1073741515)).toBe(true);
      expect(isWindowsNativeRuntimeIncompatible(0xC0000135)).toBe(true);
      expect(isWindowsNativeRuntimeIncompatible(-1073741701)).toBe(true);
      expect(isWindowsNativeRuntimeIncompatible(0xC000007B)).toBe(true);
    }
    expect(isWindowsNativeRuntimeIncompatible(1)).toBe(false);
    expect(isWindowsNativeRuntimeIncompatible(null)).toBe(false);
  });

  it('uses multilingual auto-detection and DTW word timestamps for the q5 model', () => {
    const args = buildSpeechTranscribeArgs(
      '/runtime/models/ggml-base-q5_1.bin',
      '/tmp/audio.wav',
      '/tmp/transcript',
      { timestamps: 'word' },
    );

    expect(args).toEqual(expect.arrayContaining(['-ojf', '-l', 'auto', '-dtw', 'base', '-np']));
    expect(args).not.toContain('-oj');
    expect(buildSpeechTranscribeArgs('ggml-base-q5_1.bin', 'audio.wav', 'out', {
      language: 'zh',
      timestamps: 'segment',
    })).toEqual(expect.arrayContaining(['-oj', '-l', 'zh']));
  });

  it('passes whisper.cpp the base language of a locale tag', () => {
    // whisper.cpp rejects region and script tags: `-l zh-CN` prints its usage
    // and exits 0 with no transcript. speech.capabilities takes exactly such a
    // tag in the same `language` field, and a 2026-10-31 Luna run reused it.
    const languageArg = (language: string | undefined) => {
      const args = buildSpeechTranscribeArgs('ggml-base-q5_1.bin', 'audio.wav', 'out', { language, timestamps: 'segment' });
      return args[args.indexOf('-l') + 1];
    };
    const cases: Array<[string | undefined, string]> = [
      ['zh-CN', 'zh'], ['zh_CN', 'zh'], ['ZH-cn', 'zh'], ['zh-Hans-CN', 'zh'], ['en-US', 'en'], ['yue-HK', 'yue'],
      ['zh', 'zh'], ['Chinese', 'chinese'], ['AUTO', 'auto'], ['  ', 'auto'], [undefined, 'auto'],
    ];
    for (const [given, passed] of cases) expect(languageArg(given), String(given)).toBe(passed);
  });

  describe('speech.transcribe language outcomes', () => {
    function fakeTranscriber(label: string, whisperBody: string[]) {
      const p = tmpProject(label);
      const input = path.join(p.root, 'raw.mp4');
      fs.writeFileSync(input, 'fake media');
      const ffprobe = path.join(p.root, 'ffprobe');
      writeExecutable(ffprobe, [
        '#!/usr/bin/env node',
        'process.stdout.write(JSON.stringify({ format: { duration: "5" }, streams: [{ codec_type: "audio", codec_name: "aac" }] }));',
        '',
      ].join('\n'));
      const ffmpeg = path.join(p.root, 'ffmpeg');
      writeExecutable(ffmpeg, [
        '#!/usr/bin/env node',
        "require('node:fs').writeFileSync(process.argv[process.argv.length - 1], 'wav');",
        '',
      ].join('\n'));
      const runtimeRoot = path.join(p.root, 'runtime');
      writeExecutable(path.join(runtimeRoot, 'whisper', 'current', 'bin', 'whisper-cli'), ['#!/usr/bin/env node', ...whisperBody, '']
        .join('\n'));
      const model = path.join(runtimeRoot, 'whisper', 'current', 'models', 'ggml-base.bin');
      fs.mkdirSync(path.dirname(model), { recursive: true });
      fs.writeFileSync(model, 'model');
      process.env.ORKAS_BUNDLED_FFMPEG = ffmpeg;
      process.env.ORKAS_BUNDLED_FFPROBE = ffprobe;
      process.env.ORKAS_RUNTIME_DIR = runtimeRoot;
      delete process.env.ORKAS_WHISPER_CPP;
      delete process.env.ORKAS_WHISPER_CLI;
      delete process.env.ORKAS_WHISPER_MODEL;
      return { root: p.root, input };
    }

    it('transcribes a locale-tagged request with the base language', async () => {
      if (process.platform === 'win32') return;
      const { root, input } = fakeTranscriber('transcribe-locale', [
        "const fs = require('node:fs');",
        "const args = process.argv.slice(2);",
        "fs.writeFileSync(require('node:path').join(__dirname, 'argv.json'), JSON.stringify(args));",
        "const base = args[args.indexOf('-of') + 1];",
        "fs.writeFileSync(base + '.json', JSON.stringify({ result: { language: 'zh' }, transcription: [{ offsets: { from: 0, to: 1200 }, text: ' 你好' }] }));",
      ]);
      const transcript = path.join(root, 'project', 'transcripts', 'raw.json');
      const res = await transcribeSpeech({ inputAbsPath: input, transcriptAbsPath: transcript, language: 'zh-CN', timestamps: 'segment' });
      expect(res, JSON.stringify(res)).toMatchObject({ ok: true, transcript_path: transcript });
      const argv = JSON.parse(fs.readFileSync(path.join(root, 'runtime', 'whisper', 'current', 'bin', 'argv.json'), 'utf8'));
      expect(argv[argv.indexOf('-l') + 1]).toBe('zh');
      expect(JSON.parse(fs.readFileSync(transcript, 'utf8')).text).toBe('你好');
    });

    it('names an unsupported language instead of reporting a missing transcript', async () => {
      if (process.platform === 'win32') return;
      const { input } = fakeTranscriber('transcribe-unknown-language', [
        "console.error(\"whisper_lang_id: unknown language 'xx'\");",
        "console.error(\"error: unknown language 'xx'\");",
        "console.error('usage: whisper-cli [options] file0 file1 ...');",
        'process.exit(0);',
      ]);
      const res = await transcribeSpeech({ inputAbsPath: input, language: 'xx-YY' });
      expect(res).toMatchObject({ ok: false, op: 'speech.transcribe', errorCode: 'E_TRANSCRIBE_LANGUAGE_UNSUPPORTED' });
      expect(res.message).toBe('Speech transcription does not support the language "xx-YY". '
        + 'Use a two-letter language code such as zh or en, or auto.');
    });

    it('still reports a missing transcript when the language was accepted', async () => {
      if (process.platform === 'win32') return;
      const { input } = fakeTranscriber('transcribe-no-output', ["console.error('whisper_init: loaded');", 'process.exit(0);']);
      const res = await transcribeSpeech({ inputAbsPath: input, language: 'zh' });
      expect(res).toMatchObject({ ok: false, errorCode: 'E_TRANSCRIBE_NO_OUTPUT' });
    });

    it.each([
      '{"transcription":[', 'null', '[]', '{}', '{"transcription":{}}',
      '{"transcription":[null]}',
      '{"transcription":[{"text":"Lost words","offsets":{"from":0,"to":null}}]}',
    ])(
      'rejects invalid speech.transcribe output %s without replacing an existing transcript', async raw => {
        if (process.platform === 'win32') return;
        const { root, input } = fakeTranscriber('transcribe-invalid-output', [
          "const fs = require('node:fs'), args = process.argv.slice(2);",
          `fs.writeFileSync(args[args.indexOf('-of') + 1] + '.json', ${JSON.stringify(raw)});`,
        ]);
        const transcript = path.join(root, 'existing.json');
        const previous = '{"text":"Existing usable transcript"}\n';
        fs.writeFileSync(transcript, previous);
        const source = fs.readFileSync(input);

        const rejected = await transcribeSpeech({ inputAbsPath: input, transcriptAbsPath: transcript });
        expect(rejected).toMatchObject({ ok: false, errorCode: 'E_TRANSCRIBE_INVALID_OUTPUT' });
        if (raw.includes('Lost words')) {
          expect(rejected).toMatchObject({ timing_valid: false, text: 'Lost words', text_path: expect.any(String) });
          expect(fs.readFileSync(String(rejected.text_path), 'utf8')).toBe('Lost words\n');
        } else expect(String(rejected.message)).toContain('Try transcribing');
        expect(String(rejected.message)).not.toContain(root);
        expect(fs.readFileSync(transcript, 'utf8')).toBe(previous);
        expect(fs.readFileSync(input)).toEqual(source);

        // An explicit healthy retry can replace the preserved old result.
        writeExecutable(path.join(root, 'runtime', 'whisper', 'current', 'bin', 'whisper-cli'), [
          '#!/usr/bin/env node',
          "const fs = require('node:fs'), args = process.argv.slice(2);",
          "fs.writeFileSync(args[args.indexOf('-of') + 1] + '.json', JSON.stringify({ result: { language: 'en' }, transcription: [{ offsets: { from: 0, to: 1200 }, text: ' Pickup at the east entrance.' }] }));",
          '',
        ].join('\n'));
        const recovered = await transcribeSpeech({ inputAbsPath: input, transcriptAbsPath: transcript });
        expect(recovered).toMatchObject({ ok: true });
        expect(JSON.parse(fs.readFileSync(transcript, 'utf8')).text).toBe('Pickup at the east entrance.');
        expect(fs.readFileSync(input)).toEqual(source);
      },
    );

    it('accepts a valid empty speech.transcribe result for silent audio', async () => {
      if (process.platform === 'win32') return;
      const { root, input } = fakeTranscriber('transcribe-silence', [
        "const fs = require('node:fs'), args = process.argv.slice(2);",
        "fs.writeFileSync(args[args.indexOf('-of') + 1] + '.json', JSON.stringify({ result: { language: 'en' }, transcription: [] }));",
      ]);
      const transcript = path.join(root, 'silence.json');
      expect(await transcribeSpeech({ inputAbsPath: input, transcriptAbsPath: transcript })).toMatchObject({ ok: true });
      expect(JSON.parse(fs.readFileSync(transcript, 'utf8'))).toMatchObject({ text: '', segments: [] });
    });

    it('preserves the prior speech.transcribe result after a partial write and supports an explicit retry', async () => {
      if (process.platform === 'win32') return;
      const { root, input } = fakeTranscriber('transcribe-write-failure', [
        "const fs = require('node:fs'), args = process.argv.slice(2);",
        "fs.writeFileSync(args[args.indexOf('-of') + 1] + '.json', JSON.stringify({ transcription: [{ offsets: { from: 0, to: 1200 }, text: ' New accurate result' }] }));",
      ]);
      const transcript = path.join(root, 'existing.json');
      const previous = '{"text":"Previous usable result"}\n';
      fs.writeFileSync(transcript, previous);
      const source = fs.readFileSync(input);
      const nativeFs = (await import('node:fs/promises')).default;
      const writeFile = nativeFs.writeFile;
      let injected = false;
      const fault = vi.spyOn(nativeFs, 'writeFile').mockImplementation((async (file: any, data: any, ...args: any[]) => {
        if (String(file) === transcript || String(file).startsWith(transcript + '.')) {
          injected = true;
          await (writeFile as any)(file, Buffer.from(data).subarray(0, 8), ...args);
          throw Object.assign(new Error('Controlled write interruption'), { code: 'EIO' });
        }
        return (writeFile as any)(file, data, ...args);
      }) as any);
      syncBuiltinESMExports();
      try {
        await expect(transcribeSpeech({ inputAbsPath: input, transcriptAbsPath: transcript })).rejects.toMatchObject({ code: 'EIO' });
      } finally {
        fault.mockRestore();
        syncBuiltinESMExports();
      }
      expect(injected).toBe(true);
      expect(fs.readFileSync(transcript, 'utf8')).toBe(previous);
      expect(fs.readFileSync(input)).toEqual(source);
      expect(fs.readdirSync(root).filter(name => name.startsWith('existing.json.'))).toEqual([]);
      expect(await transcribeSpeech({ inputAbsPath: input, transcriptAbsPath: transcript })).toMatchObject({ ok: true });
      expect(JSON.parse(fs.readFileSync(transcript, 'utf8')).text).toBe('New accurate result');
    });
  });

  it('normalizes whisper.cpp full JSON into stable segment and word timestamps', () => {
    const normalized = normalizeWhisperTranscript({
      result: { language: 'zh' },
      transcription: [{
        offsets: { from: 0, to: 1200 },
        text: ' Hello world!',
        tokens: [
          { text: ' Hello', offsets: { from: 100, to: 500 } },
          { text: ' world', offsets: { from: 500, to: 1000 } },
          { text: '!', offsets: { from: 1000, to: 1100 } },
        ],
      }],
    }, 'word');

    expect(normalized).toMatchObject({
      schema_version: 1,
      backend: 'whisper.cpp',
      language: 'zh',
      timestamp_detail: 'word',
      text: 'Hello world!',
      segments: [{ text: 'Hello world!', startSec: 0, endSec: 1.2 }],
      words: [
        { text: 'Hello', startSec: 0.1, endSec: 0.5 },
        { text: 'world!', startSec: 0.5, endSec: 1.1 },
      ],
    });
  });

  it('redacts local paths from speech.transcribe subprocess failures', async () => {
    const p = tmpProject('transcribe-redaction');
    const input = path.join(p.root, 'private', 'raw.mp4');
    fs.mkdirSync(path.dirname(input), { recursive: true });
    fs.writeFileSync(input, 'fake media');

    let runtimeRoot: string;
    let ffmpeg: string;
    if (process.platform === 'win32') {
      runtimeRoot = path.resolve(process.cwd(), 'resources', 'runtime');
      ffmpeg = path.join(runtimeRoot, 'ffmpeg', 'win32-x64', 'ffmpeg.exe');
    } else {
      ffmpeg = path.join(p.root, 'ffmpeg');
      writeExecutable(ffmpeg, [
        '#!/usr/bin/env node',
        "console.error('failed to open /Users/test/private/raw.mp4');",
        'process.exit(1);',
        '',
      ].join('\n'));
      runtimeRoot = path.join(p.root, 'runtime');
      const fakeWhisper = path.join(runtimeRoot, 'whisper', 'current', 'bin', 'whisper-cli');
      writeExecutable(fakeWhisper, ['#!/usr/bin/env node', 'process.exit(0);', ''].join('\n'));
      const model = path.join(runtimeRoot, 'whisper', 'current', 'models', 'ggml-base.bin');
      fs.mkdirSync(path.dirname(model), { recursive: true });
      fs.writeFileSync(model, 'model');
    }

    process.env.ORKAS_BUNDLED_FFMPEG = ffmpeg;
    process.env.ORKAS_RUNTIME_DIR = runtimeRoot;
    delete process.env.ORKAS_WHISPER_CPP;
    delete process.env.ORKAS_WHISPER_CLI;
    delete process.env.ORKAS_WHISPER_MODEL;

    const res = await transcribeSpeech({ inputAbsPath: input });

    expect(res).toMatchObject({
      ok: false,
      errorCode: 'E_TRANSCRIBE_AUDIO_EXTRACT_FAILED',
    });
    // The message is the caller's answer; the tool's own words are bounded
    // diagnostic detail beside it, still redacted.
    expect(String(res.message)).toContain('could not be decoded');
    expect(String(res.message)).not.toContain('<path>');
    expect(String(res.extract_diagnostic)).toContain('<path>');
    expect(String(res.extract_diagnostic)).not.toContain(process.platform === 'win32' ? p.root : '/Users/test');
    expect(String(res.extract_diagnostic).length).toBeLessThanOrEqual(400);
  });

  it('answers a video with no audio track instead of quoting the ffmpeg banner', async () => {
    // 2026-08-08 driven run: the source clip had one stream, h264 video. Asked
    // to transcribe it, ffmpeg printed its version banner and the whole input
    // metadata dump, then one final line saying the output would contain no
    // stream — and the host returned the last 1200 characters of that as the
    // message. 2135 chars of stderr, the cause at offset 2107: the answer was
    // 97% banner. It is not a failed extraction either; there is nothing to
    // extract, and the recovery is a different tool, not a retry.
    if (process.platform === 'win32') return;
    const p = tmpProject('transcribe-no-audio');
    const input = path.join(p.root, 'raw.mp4');
    fs.writeFileSync(input, 'fake media');

    const ffprobe = path.join(p.root, 'ffprobe');
    writeExecutable(ffprobe, [
      '#!/usr/bin/env node',
      'process.stdout.write(JSON.stringify({',
      '  format: { duration: "5.875", size: "5914180" },',
      '  streams: [{ codec_type: "video", codec_name: "h264", width: 1918, height: 1080 }],',
      '}));',
      '',
    ].join('\n'));
    const ffmpeg = path.join(p.root, 'ffmpeg');
    writeExecutable(ffmpeg, [
      '#!/usr/bin/env node',
      "console.error('ffmpeg must not run for a file with no audio track');",
      'process.exit(1);',
      '',
    ].join('\n'));
    const runtimeRoot = path.join(p.root, 'runtime');
    const fakeWhisper = path.join(runtimeRoot, 'whisper', 'current', 'bin', 'whisper-cli');
    writeExecutable(fakeWhisper, ['#!/usr/bin/env node', 'process.exit(0);', ''].join('\n'));
    const model = path.join(runtimeRoot, 'whisper', 'current', 'models', 'ggml-base.bin');
    fs.mkdirSync(path.dirname(model), { recursive: true });
    fs.writeFileSync(model, 'model');

    process.env.ORKAS_BUNDLED_FFMPEG = ffmpeg;
    process.env.ORKAS_BUNDLED_FFPROBE = ffprobe;
    process.env.ORKAS_RUNTIME_DIR = runtimeRoot;
    delete process.env.ORKAS_WHISPER_CPP;
    delete process.env.ORKAS_WHISPER_CLI;
    delete process.env.ORKAS_WHISPER_MODEL;

    const res = await transcribeSpeech({ inputAbsPath: input });

    expect(res).toMatchObject({
      ok: false,
      errorCode: 'E_TRANSCRIBE_NO_AUDIO_TRACK',
      next_action: 'read_visual_content_instead_of_transcribing',
      media: { has_audio: false, video_codec: 'h264' },
    });
    expect(String(res.message)).toContain('no audio track');
    expect(String(res.message)).toContain('extract frames');
    // No banner, no metadata dump, no paths.
    expect(String(res.message)).not.toMatch(/libav|Stream #|Input #0/);
    expect(String(res.message).length).toBeLessThan(220);
    // And it costs no extraction run: the fake ffmpeg fails if invoked.
    expect(res.errorCode).not.toBe('E_TRANSCRIBE_AUDIO_EXTRACT_FAILED');
  });

  it('deduplicates identical native findings without merging distinct element paths', () => {
    const base = {
      code: 'SAFE_AREA_VIOLATION', severity: 'warning' as const, sceneId: 'scene-1',
      selector: '[data-scene-id="scene-1"] > p:nth-of-type(1)', sampleTimeSec: 5,
      message: '[5.00s] readable text sits near the safe area.',
    };
    expect(dedupeInspectIssues([
      base,
      { ...base },
      { ...base, selector: '[data-scene-id="scene-1"] > p:nth-of-type(2)' },
    ])).toHaveLength(2);
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

  it.each(['draft', 'high'] as const)('never calls unmeasurable loudness normal or normalizes it (%s)', (quality) => {
    for (const value of [null, Number.NaN, Number.NEGATIVE_INFINITY]) {
      expect(shouldNormalizeLoudness({
        ok: true, input_i: value, input_tp: value, input_lra: 0,
        target_i: -14, target_tp: -1, target_lra: 11,
      }, quality)).toEqual({ normalize: false, reason: 'loudness analysis unavailable' });
    }
  });
});

describe('video track reuse', () => {
  const BASE_KEY_INPUT = {
    visualSignature: 'a'.repeat(64),
    windows: [
      { id: 's1', start: 0, duration: 4 },
      { id: 's2', start: 4, duration: 6 },
    ],
    width: 1920,
    height: 1080,
    fps: 30,
    quality: 'standard' as const,
    format: 'mp4' as const,
  };

  it('keeps the remux audio graph identical to the frame encoder and copies the video stream', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-remux-args-'));
    const narration = path.join(root, 'narration.mp3');
    const music = path.join(root, 'music.mp3');
    fs.writeFileSync(narration, 'x');
    fs.writeFileSync(music, 'x');
    const tracks = [
      { absPath: narration, startSec: 0, volume: 1 },
      { absPath: music, startSec: 2.5, volume: 0.6 },
    ];

    const encoderArgs = buildFrameEncoderArgs({
      outputAbsPath: path.join(root, 'full.mp4'),
      width: 1920,
      height: 1080,
      fps: 30,
      format: 'mp4',
      quality: 'standard',
      audioTracks: tracks,
      durationSec: 10,
    });
    const remuxArgs = buildVideoTrackRemuxArgs({
      priorVideoAbsPath: path.join(root, 'prior.mp4'),
      outputAbsPath: path.join(root, 'remux.mp4'),
      durationSec: 10,
      format: 'mp4',
      audioTracks: tracks,
    });

    const filterOf = (args: string[]) => args[args.indexOf('-filter_complex') + 1];
    expect(filterOf(remuxArgs)).toBe(filterOf(encoderArgs));
    expect(remuxArgs).toEqual(expect.arrayContaining(['-c:v', 'copy', '-c:a', 'aac', '-movflags', '+faststart']));
    expect(remuxArgs).not.toContain('-preset');
    expect(remuxArgs).not.toContain('libx264');

    const silent = buildVideoTrackRemuxArgs({
      priorVideoAbsPath: path.join(root, 'prior.mp4'),
      outputAbsPath: path.join(root, 'remux-silent.mp4'),
      durationSec: 10,
      audioTracks: [],
    });
    expect(silent).toEqual(expect.arrayContaining(['-map', '0:v:0', '-an', '-c:v', 'copy']));
    expect(silent).not.toContain('-filter_complex');

    const webm = buildVideoTrackRemuxArgs({
      priorVideoAbsPath: path.join(root, 'prior.webm'),
      outputAbsPath: path.join(root, 'remux.webm'),
      durationSec: 10,
      format: 'webm',
      audioTracks: tracks,
    });
    expect(webm).toEqual(expect.arrayContaining(['-c:a', 'libopus']));
    expect(webm).not.toContain('+faststart');
  });

  const ffmpegBins = bundledFfmpegPaths();
});

describe('composition render slot', () => {
  const tick = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  it('serializes renders FIFO and lets an aborted waiter abandon its place', async () => {
    // Two concurrent renders halve each other's throughput (2026-08-22); the
    // gate must hold one render at a time, in arrival order, and an aborted
    // waiter must not wedge the queue behind it.
    const order: string[] = [];
    const first = await acquireCompositionRenderSlot();
    let secondAcquired = false;
    const secondPromise = acquireCompositionRenderSlot().then((release) => {
      secondAcquired = true;
      order.push('second');
      return release;
    });
    await tick(20);
    expect(secondAcquired).toBe(false);

    const aborter = new AbortController();
    const abortedPromise = acquireCompositionRenderSlot({ signal: aborter.signal });
    aborter.abort();
    await expect(abortedPromise).rejects.toThrow(/aborted/);

    let thirdAcquired = false;
    const thirdPromise = acquireCompositionRenderSlot().then((release) => {
      thirdAcquired = true;
      order.push('third');
      return release;
    });
    await tick(20);
    expect(secondAcquired).toBe(false);
    expect(thirdAcquired).toBe(false);

    first();
    const secondRelease = await secondPromise;
    expect(order).toEqual(['second']);
    secondRelease();
    const thirdRelease = await thirdPromise;
    expect(order).toEqual(['second', 'third']);
    thirdRelease();
  });

  it('reports queue waits through onWait so the wait stays visible', async () => {
    const first = await acquireCompositionRenderSlot();
    const waits: number[] = [];
    const pending = acquireCompositionRenderSlot({
      onWait: (waitedMs) => waits.push(waitedMs),
      waitProgressIntervalMs: 10,
    });
    await tick(60);
    first();
    (await pending)();
    expect(waits.length).toBeGreaterThanOrEqual(2);
    expect(waits.at(-1)!).toBeGreaterThanOrEqual(waits[0]);
  });
});

describe('scene segment cache', () => {
  it('attributes referenced asset changes to the owning visual surface', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-segment-assets-'));
    const assetsDir = path.join(root, 'assets');
    fs.mkdirSync(assetsDir, { recursive: true });
    fs.writeFileSync(path.join(assetsDir, 'cover.png'), 'cover-v1');
    fs.writeFileSync(path.join(assetsDir, 'shared.png'), 'shared-v1');
    fs.writeFileSync(path.join(assetsDir, 'narration.mp3'), 'audio-v1');
    fs.writeFileSync(path.join(assetsDir, 'shared.css'), '.stage{background:url("./shared.png")}');
    const coverSurface = '<section><img src="./assets/cover.png"><audio src="./assets/narration.mp3"></section>';
    const bodySurface = '<section><p>No local visual asset</p></section>';
    const sharedSurface = '<head><link rel="stylesheet" href="./assets/shared.css"></head>';

    try {
      const coverV1 = await videoStudioReferencedVisualAssetSignature(root, coverSurface);
      const bodyV1 = await videoStudioReferencedVisualAssetSignature(root, bodySurface);
      const sharedV1 = await videoStudioReferencedVisualAssetSignature(root, sharedSurface);

      // Same reference and path, different bytes: only the scene that owns the
      // image changes identity. This guards both stale reuse and global cache
      // invalidation without relying on implementation call counts.
      fs.writeFileSync(path.join(assetsDir, 'cover.png'), 'cover-v2');
      const coverV2 = await videoStudioReferencedVisualAssetSignature(root, coverSurface);
      expect(coverV2).not.toBe(coverV1);
      expect(await videoStudioReferencedVisualAssetSignature(root, bodySurface)).toBe(bodyV1);
      expect(await videoStudioReferencedVisualAssetSignature(root, sharedSurface)).toBe(sharedV1);

      // A resource reached through shared CSS belongs to the shared surface,
      // so it invalidates that dimension while scene-local dimensions stay put.
      fs.writeFileSync(path.join(assetsDir, 'shared.png'), 'shared-v2');
      expect(await videoStudioReferencedVisualAssetSignature(root, sharedSurface)).not.toBe(sharedV1);
      expect(await videoStudioReferencedVisualAssetSignature(root, coverSurface)).toBe(coverV2);

      // Audio is remuxed after visual segment assembly and must not dirty the
      // video-frame cache.
      fs.writeFileSync(path.join(assetsDir, 'narration.mp3'), 'audio-v2');
      expect(await videoStudioReferencedVisualAssetSignature(root, coverSurface)).toBe(coverV2);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('continues cache eviction when deleting the oldest entry fails', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-segment-cache-prune-'));
    const entries = ['oldest', 'middle', 'newest'].map((name, index) => {
      const dir = path.join(root, name);
      const file = path.join(dir, 'segment.mp4');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(file, '');
      fs.truncateSync(file, 1024 ** 3);
      const timestamp = new Date(1_700_000_000_000 + (index * 1_000));
      fs.utimesSync(file, timestamp, timestamp);
      return dir;
    });
    const removeEntry = async (target: string) => {
      if (path.resolve(target) === entries[0]) throw new Error('cache entry locked');
      await fs.promises.rm(target, { recursive: true, force: true });
    };

    try {
      await pruneSegmentCache(root, removeEntry);

      expect(fs.existsSync(entries[0])).toBe(true);
      expect(fs.existsSync(entries[1])).toBe(false);
      expect(fs.existsSync(entries[2])).toBe(true);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('does not evict an in-flight assembly workspace as a completed cache entry', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-segment-cache-active-'));
    const workspace = path.join(root, '.segment-assembly-active');
    const cached = path.join(root, 'completed');
    for (const dir of [workspace, cached]) {
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, 'segment.mp4');
      fs.writeFileSync(file, '');
      fs.truncateSync(file, 2 * 1024 ** 3);
    }
    const removed: string[] = [];
    try {
      await pruneSegmentCache(root, async (dir) => { removed.push(dir); });
      expect(removed).toEqual([]);
      expect(fs.existsSync(workspace)).toBe(true);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  const ffmpegBins2 = bundledFfmpegPaths();
});

// These safeguards still apply to the timeline kernel after the old approval
// protocol is retired. Exercise the owning input boundary directly.
describe('retained composition input guarantees', () => {
  function html(dir: string, extra = '') {
    const file = path.join(dir, 'index.html');
    fs.writeFileSync(file, '<html><head>' + extra + '</head><body><main data-composition-id="main" data-width="320" data-height="180" data-duration="1">Launch</main></body></html>');
    return file;
  }

  it('prepares produced HTML before the composition reader consumes it', async () => {
    const p = tmpProject('input-hook');
    const file = html(p.compositionDir);
    fs.appendFileSync(file, '\n<!-- stale-output-mark -->');
    const prepared: string[] = [];
    const unregister = registerProducedOutputHooks({ prepareFileInput: async (file) => {
      prepared.push(file);
      fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('<!-- stale-output-mark -->', ''));
    } });
    try {
      const result = await loadCompositionMeta(p.compositionDir);
      expect(result.issues).toEqual([]);
      expect(prepared).toEqual([file]);
      expect(result.meta?.html).not.toContain('stale-output-mark');
    } finally { unregister(); fs.rmSync(p.root, { recursive: true, force: true }); }
  });

  it('finds nested CSS network resources while rejecting local traversal', async () => {
    const p = tmpProject('nested-css');
    try {
      html(p.compositionDir, '<link rel="stylesheet" href="./styles/root.css"><img src="../secret.png">');
      fs.mkdirSync(path.join(p.compositionDir, 'styles'));
      fs.writeFileSync(path.join(p.compositionDir, 'styles/root.css'), '@import "nested.css";');
      fs.writeFileSync(path.join(p.compositionDir, 'styles/nested.css'), '@import url("https://example.test/remote.css");');
      fs.writeFileSync(path.join(p.compositionDir, '../secret.png'), 'private');
      const result = await loadCompositionMeta(p.compositionDir);
      expect(result.issues.map(issue => issue.code)).toEqual(expect.arrayContaining(['REMOTE_RESOURCE_BLOCKED', 'RESOURCE_OUT_OF_SCOPE']));
      expect(fs.readFileSync(path.join(p.compositionDir, '../secret.png'), 'utf8')).toBe('private');
    } finally { fs.rmSync(p.root, { recursive: true, force: true }); }
  });

  it('rejects an incompatible local vendor without replacing its bytes', async () => {
    const p = tmpProject('invalid-vendor');
    try {
      html(p.compositionDir, '<script src="./assets/vendor/gsap.min.js"></script>');
      const file = path.join(p.compositionDir, 'assets/vendor/gsap.min.js');
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, 'window.gsap = {};');
      const result = await loadCompositionMeta(p.compositionDir);
      expect(result.issues.map(issue => issue.code)).toContain('VENDOR_GSAP_INCOMPATIBLE');
      expect(fs.readFileSync(file, 'utf8')).toBe('window.gsap = {};');
    } finally { fs.rmSync(p.root, { recursive: true, force: true }); }
  });

  it('keeps the highest bounded automatic export rate and refuses an oversized canvas', () => {
    expect(selectSafeFinalRenderFps({ width: 1920, height: 1080, durationSec: 60, requestedFps: 30 })).toBe(24);
    expect(selectSafeFinalRenderFps({ width: 3840, height: 2160, durationSec: 60, requestedFps: 30 })).toBeNull();
  });

  it('keeps in-flight staging outside completed-cache eviction', async () => {
    const p = tmpProject('staging-eviction');
    try {
      const entry = path.join(p.root, 'cache/entry');
      const staging = path.join(p.root, 'cache/.staging/in-flight');
      for (const [dir, size] of [[entry, 1024 ** 3], [staging, 2 * 1024 ** 3]] as const) {
        fs.mkdirSync(dir, { recursive: true });
        const file = path.join(dir, 'segment.mp4');
        fs.writeFileSync(file, ''); fs.truncateSync(file, size);
      }
      await pruneSegmentCache(path.join(p.root, 'cache'));
      expect(fs.existsSync(entry)).toBe(true);
      expect(fs.existsSync(staging)).toBe(true);
    } finally { fs.rmSync(p.root, { recursive: true, force: true }); }
  });
});
