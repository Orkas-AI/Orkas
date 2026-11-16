import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { estimateNarrationDuration } from '../../../src/main/util/narration-timing';

const pc = process.cwd();
const source = path.join(pc, 'resources/builtin/marketplace/agents/79df9cc89f5f/skills/video-studio');

type RunOptions = { project?: string; request?: string; rawRequest?: string; cwd?: string; args?: string[] };
async function fixture(check: (dir: string, run: (script: string, input: unknown, options?: RunOptions) => any) => Promise<void>) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-video-preflight-'));
  const installed = path.join(dir, 'installed');
  fs.cpSync(source, installed, { recursive: true });
  const run = (script: string, input: unknown, options: RunOptions = {}) => {
    fs.writeFileSync(path.join(dir, 'request.json'), options.rawRequest ?? JSON.stringify(input));
    const args = options.args ?? (script === 'image_asset'
      ? ['--project', options.project ?? dir, '--request', options.request ?? 'request.json'] : ['--input', 'request.json']);
    const result = spawnSync(process.env.ORKAS_TEST_NODE || process.execPath,
      [path.join(pc, 'bin/run-skill.cjs'), 'video-studio', script, '--', ...args], {
        cwd: options.cwd ?? dir, encoding: 'utf8', timeout: 30_000,
        env: { ...process.env, ORKAS_PC_DIR: pc, ORKAS_WORKSPACE_ROOT: dir,
          ORKAS_RUN_SKILL_DIR: installed, ORKAS_UID: 'fixture', ORKAS_GLOBAL_SKILL_ROOTS_ENABLED: '0' },
      });
    expect(result.stderr).toBe('');
    const body = JSON.parse(result.stdout);
    expect(result.status, result.stdout).toBe(body.ok ? 0 : 1);
    return body;
  };
  try { await check(dir, run); } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

describe('VideoStudio private preparation through the installed runner', () => {
  it('accepts explicit file and inline JSON inputs with identical processing and bounded, unambiguous arguments', async () => {
    await fixture(async (dir, run) => {
      await sharp({ create: { width: 20, height: 30, channels: 3, background: 'red' } }).png().toFile(path.join(dir, 'source.png'));
      const request = { op: 'inspect', input_path: 'source.png' };
      const expected = run('image_asset', request);
      for (const [flag, value] of [['--request-file', 'request.json'], ['--request-json', JSON.stringify(request)]]) {
        expect(run('image_asset', request, { args: ['--project', dir, flag, value], cwd: os.tmpdir() })).toEqual(expected);
      }
      const process = { op: 'process', input_path: 'source.png', output_path: 'inline.png', resize: { width: 10 } };
      expect(run('image_asset', process, { args: ['--project', dir, '--request-json', JSON.stringify(process)] }))
        .toMatchObject({ ok: true, width: 10, height: 15, model_calls: 0 });
      for (const args of [
        ['--request-file', 'request.json', '--request-json', '{}'],
        ['--request-json', '{}', '--request-json', '{}'],
        ['--request-json'], ['--other', '{}'],
      ]) expect(run('image_asset', request, { args: ['--project', dir, ...args] }))
        .toMatchObject({ ok: false, errorCode: 'E_IMAGE_ASSET_ARGS' });
      const exact = JSON.stringify(request).padEnd(65536, ' ');
      expect(run('image_asset', request, { args: ['--project', dir, '--request-json', exact] })).toEqual(expected);
      // UTF-8 bytes, not JavaScript character count, determine the common limit.
      const large = `{"op":"inspect","input_path":"${'图'.repeat(22000)}"}`;
      for (const flag of ['--request-file', '--request-json']) {
        expect(run('image_asset', request, { rawRequest: large,
          args: ['--project', dir, flag, flag === '--request-file' ? 'request.json' : large] }))
          .toMatchObject({ ok: false, errorCode: 'E_IMAGE_ASSET_LIMIT' });
      }
      expect(run('image_asset', request, { args: ['--project', dir, '--request-json', '{'] }))
        .toMatchObject({ ok: false, errorCode: 'E_IMAGE_ASSET_REQUEST', message: 'Request JSON is not valid JSON.' });
      expect(run('image_asset', request, { args: ['--project', dir, '--request-json', JSON.stringify({ ...process, output_path: '../escape.png' })] }))
        .toMatchObject({ ok: false, errorCode: 'E_IMAGE_ASSET_PATH' });
      expect(fs.existsSync(path.join(dir, '..', 'escape.png'))).toBe(false);
    });
  });
  it('runs the documented image requests from different working directories and after moving the production', async () => {
    await fixture(async (dir, run) => {
      const guide = fs.readFileSync(path.join(source, 'references/image-preparation.md'), 'utf8');
      const command = /```bash\n([\s\S]*?)\n```/.exec(guide)![1];
      expect(command).toContain('--project "$production_root"');
      const requestName = /--request-file (\S+)/.exec(command)![1];
      const [inspectRequest, processRequest] = [...guide.matchAll(/```json\n([\s\S]*?)\n```/g)]
        .map((block) => JSON.parse(block[1]));
      let production = path.join(dir, 'lamp-ad');
      fs.mkdirSync(path.join(production, 'media'), { recursive: true });
      await sharp({ create: { width: 720, height: 1280, channels: 3, background: 'red' } })
        .jpeg().toFile(path.join(production, inspectRequest.input_path));
      const before = fs.readFileSync(path.join(production, inspectRequest.input_path));
      fs.writeFileSync(path.join(production, requestName), JSON.stringify(inspectRequest));
      for (const cwd of [dir, production, os.tmpdir()]) {
        expect(run('image_asset', null, { project: production, request: requestName, cwd }))
          .toMatchObject({ ok: true, width: 720, height: 1280, model_calls: 0 });
      }
      fs.writeFileSync(path.join(production, 'process.json'), JSON.stringify(processRequest));
      expect(run('image_asset', null, { project: production, request: 'process.json', cwd: os.tmpdir() }))
        .toMatchObject({ ok: true, width: 720, height: 1015, model_calls: 0 });
      const prepared = fs.readFileSync(path.join(production, processRequest.output_path));
      const relocated = path.join(dir, 'relocated');
      fs.renameSync(production, relocated);
      production = relocated;
      expect(run('image_asset', null, { project: production, request: requestName, cwd: dir }))
        .toMatchObject({ ok: true, width: 720, height: 1280 });
      // Relative request/media references survive relocation; an existing result is never overwritten.
      expect(run('image_asset', null, { project: production, request: 'process.json', cwd: dir }))
        .toMatchObject({ ok: false, errorCode: 'E_IMAGE_ASSET_EXISTS' });
      expect(fs.readFileSync(path.join(production, inspectRequest.input_path))).toEqual(before);
      expect(fs.readFileSync(path.join(production, processRequest.output_path))).toEqual(prepared);
    });
  });

  it('reports the actual failed input without suggesting unrelated repairs or changing files', async () => {
    await fixture(async (dir, run) => {
      await sharp({ create: { width: 20, height: 20, channels: 3, background: 'red' } }).png().toFile(path.join(dir, 'source.png'));
      const before = fs.readFileSync(path.join(dir, 'source.png'));
      const request = { op: 'process', input_path: 'source.png', output_path: 'new.png' };
      fs.writeFileSync(path.join(dir, 'corrupt.png'), 'not an image');
      fs.writeFileSync(path.join(dir, 'blocked'), 'existing output parent');
      const failures = [
        [request, { project: path.join(dir, 'missing') }, 'E_IMAGE_ASSET_PROJECT', 'Production directory does not exist.'],
        [request, { project: path.join(dir, 'source.png') }, 'E_IMAGE_ASSET_PROJECT', 'Production path is not a directory.'],
        [request, { project: path.join(dir, 'source.png', 'nested') }, 'E_IMAGE_ASSET_PROJECT', 'Production path is not a directory.'],
        [request, { request: 'missing.json' }, 'E_IMAGE_ASSET_REQUEST', 'Request file does not exist.'],
        [request, { request: '.' }, 'E_IMAGE_ASSET_REQUEST', 'Request path is not a file.'],
        [request, { rawRequest: '{' }, 'E_IMAGE_ASSET_REQUEST', 'Request file is not valid JSON.'],
        [{ ...request, input_path: 'missing.png' }, {}, 'E_IMAGE_ASSET_INPUT', 'Input image does not exist.'],
        [{ ...request, input_path: '.' }, {}, 'E_IMAGE_ASSET_INPUT', 'Input image path is not a file.'],
        [{ ...request, input_path: 'corrupt.png' }, {}, 'E_IMAGE_ASSET_INPUT', 'Input image metadata could not be decoded.'],
        [{ ...request, output_path: 'blocked/new.png' }, {}, 'E_IMAGE_ASSET_OUTPUT', 'Output parent is not a directory.'],
        [{ ...request, output_path: 'source.png' }, {}, 'E_IMAGE_ASSET_PATH', 'Input and output resolve to the same file.'],
        [request, { request: '../outside.json' }, 'E_IMAGE_ASSET_PATH', '--request resolves outside the production directory.'],
      ] as const;
      for (const [input, options, errorCode, message] of failures) {
        expect(run('image_asset', input, options)).toEqual({ ok: false, errorCode, message });
        expect(fs.existsSync(path.join(dir, 'new.png'))).toBe(false);
        expect(fs.readFileSync(path.join(dir, 'source.png'))).toEqual(before);
        expect(fs.readFileSync(path.join(dir, 'blocked'), 'utf8')).toBe('existing output parent');
      }
      expect(fs.readdirSync(dir).sort()).toEqual(['blocked', 'corrupt.png', 'installed', 'request.json', 'source.png']);
    });
  });

  it('keeps publication failures private and preserves concurrent output while removing temporary images', async () => {
    await fixture(async (dir, run) => {
      await sharp({ create: { width: 20, height: 20, channels: 3, background: 'red' } }).png().toFile(path.join(dir, 'source.png'));
      const before = fs.readFileSync(path.join(dir, 'source.png'));
      // Inject faults at the filesystem publication boundary in the isolated child.
      fs.writeFileSync(path.join(dir, 'installed/scripts/publication_failure.js'), `
        const fs = require('node:fs');
        const imageAsset = require('./image_asset');
        module.exports = async () => {
          const request = JSON.parse(fs.readFileSync('request.json', 'utf8'));
          const original = fs.linkSync;
          fs.linkSync = (source, target) => {
            if (request.output_path === 'race.png') {
              fs.writeFileSync(target, 'concurrent output');
              return original(source, target);
            }
            throw Object.assign(new Error('private-path-and-codec-detail'), { code: 'EPERM' });
          };
          try { return await imageAsset({ args: ['--project', process.cwd(), '--request', 'request.json'] }); }
          finally { fs.linkSync = original; }
        };
      `);
      const request = { op: 'process', input_path: 'source.png', output_path: 'denied.png' };
      expect(run('publication_failure', request)).toEqual({ ok: false, errorCode: 'E_IMAGE_ASSET_OUTPUT',
        message: 'Output publication access was denied.' });
      expect(fs.existsSync(path.join(dir, 'denied.png'))).toBe(false);
      expect(run('publication_failure', { ...request, output_path: 'race.png' })).toEqual({
        ok: false, errorCode: 'E_IMAGE_ASSET_EXISTS', message: 'Output file already exists.' });
      expect(fs.readFileSync(path.join(dir, 'race.png'), 'utf8')).toBe('concurrent output');
      expect(fs.readFileSync(path.join(dir, 'source.png'))).toEqual(before);
      expect(fs.readdirSync(dir).sort()).toEqual(['installed', 'race.png', 'request.json', 'source.png']);
    });
  });

  it('crops original pixels including both edge labels, preserving the source bytes', async () => {
    await fixture(async (dir, run) => {
      const input = path.join(dir, 'package.png');
      // Colored edge labels make a preview-coordinate crop visibly wrong.
      await sharp({ create: { width: 720, height: 1280, channels: 3, background: 'white' } })
        .composite([{ input: Buffer.from('<svg width="390" height="550"><rect width="390" height="550" fill="red"/><rect x="0" width="10" height="550" fill="blue"/><rect x="380" width="10" height="550" fill="green"/></svg>'), left: 165, top: 350 }])
        .png().toFile(input);
      const before = fs.readFileSync(input);
      expect(run('image_asset', { op: 'inspect', input_path: 'package.png' })).toMatchObject({ ok: true, width: 720, height: 1280, coordinate_space: 'oriented_original_pixels', model_calls: 0 });
      const request = { op: 'process', input_path: 'package.png', output_path: 'detail.png',
        source_size: { width: 720, height: 1280 }, crop: { left: 165, top: 350, width: 390, height: 550 } };
      expect(run('image_asset', request)).toMatchObject({ ok: true, width: 390, height: 550, model_calls: 0 });
      const { data, info } = await sharp(path.join(dir, 'detail.png')).removeAlpha().raw().toBuffer({ resolveWithObject: true });
      const pixel = (x: number, y: number) => [...data.subarray((y * info.width + x) * 3, (y * info.width + x) * 3 + 3)];
      expect(pixel(0, 200)).toEqual([0, 0, 255]);
      expect(pixel(389, 200)).toEqual([0, 128, 0]);
      expect(pixel(200, 200)).toEqual([255, 0, 0]);
      expect(fs.readFileSync(input)).toEqual(before);
      expect(run('image_asset', request)).toMatchObject({ ok: false, errorCode: 'E_IMAGE_ASSET_EXISTS' });
      expect(run('image_asset', { ...request, output_path: 'bad.png', source_size: { width: 576, height: 1024 } }))
        .toMatchObject({ ok: false, errorCode: 'E_IMAGE_ASSET_COORDINATES' });
      expect(fs.existsSync(path.join(dir, 'bad.png'))).toBe(false);
    });
  });

  it('handles orientation, proportional resize and padding without distorting the subject', async () => {
    await fixture(async (dir, run) => {
      await sharp({ create: { width: 40, height: 20, channels: 3, background: 'red' } })
        .withMetadata({ orientation: 6 }).jpeg().toFile(path.join(dir, 'source.jpg'));
      expect(run('image_asset', { op: 'inspect', input_path: 'source.jpg' }))
        .toMatchObject({ width: 20, height: 40, encoded_width: 40, encoded_height: 20, orientation: 6 });
      expect(run('image_asset', { op: 'process', input_path: 'source.jpg', output_path: 'padded.png',
        resize: { width: 40, height: 40, fit: 'inside' }, padding: { left: 10, right: 10, background: '#ffffff' } }))
        .toMatchObject({ ok: true, width: 40, height: 40 });
      const { data } = await sharp(path.join(dir, 'padded.png')).removeAlpha().raw().toBuffer({ resolveWithObject: true });
      expect([...data.subarray(0, 3)]).toEqual([255, 255, 255]);
      expect(data[(20 * 40 + 20) * 3]).toBeGreaterThan(240);
    });
  });

  it('rejects destructive, escaped, malformed and oversized work without publishing output', async () => {
    await fixture(async (dir, run) => {
      await sharp({ create: { width: 20, height: 20, channels: 3, background: 'red' } }).png().toFile(path.join(dir, 'source.png'));
      const before = fs.readFileSync(path.join(dir, 'source.png'));
      const request = { op: 'process', input_path: 'source.png', output_path: 'new.png' };
      for (const delta of [
        { output_path: 'source.png' }, { output_path: '../escape.png' },
        { crop: { left: 19, top: 0, width: 2, height: 20 }, source_size: { width: 20, height: 20 } },
        { crop: { left: 0, top: 0, width: 10, height: 10 } },
        { resize: { width: 16384, height: 16384 } }, { resize: { width: 20, fit: 'invented' } },
        { resize: { width: '20' } }, { padding: { left: -1 } }, { unsupported: true },
      ]) expect(run('image_asset', { ...request, ...delta }).ok).toBe(false);
      fs.writeFileSync(path.join(dir, 'corrupt.png'), 'not an image');
      expect(run('image_asset', { ...request, input_path: 'corrupt.png' }).ok).toBe(false);
      fs.symlinkSync(path.join(dir, 'source.png'), path.join(dir, 'alias.png'));
      expect(run('image_asset', { ...request, output_path: 'alias.png' }).ok).toBe(false);
      expect(fs.existsSync(path.join(dir, 'new.png'))).toBe(false);
      expect(fs.readFileSync(path.join(dir, 'source.png'))).toEqual(before);
    });
  });

  it('detects a crowded four-second line even when total speech fits twenty seconds; revisions change the receipt', async () => {
    await fixture(async (dir, run) => {
      const input = { duration_sec: 20, segments: [
        { id: 'end', text: '一二三四五六七八九十一二三四五六七八九十一二三四五六七八九十一二三四五', start_sec: 16, target_sec: 4 },
      ] };
      const result = run('storyboard_timing', input);
      expect(result).toMatchObject({ ok: true, kind: 'estimate', planned_end_sec: 20, remaining_timeline_sec: 0 });
      expect(result.sum_estimated_speech_sec).toBeLessThan(20);
      expect(result.segments[0]).toMatchObject({ estimated_sec: 8.75, remaining_sec: -4.75 });
      expect(result.timing_review).toEqual({ advisory: true, status: 'has_findings',
        crowded_segments: [{ id: 'end', over_by_sec: 4.75 }], timeline_over_by_sec: 0 });
      const revised = run('storyboard_timing', { ...input, segments: [{ ...input.segments[0], text: '提起倒掉，冲洗收好。' }] });
      expect(revised.segments[0].remaining_sec).toBeGreaterThan(0);
      expect(revised.segments[0].text_sha256).not.toBe(result.segments[0].text_sha256);
      expect(revised.timing_review).toEqual({ advisory: true, status: 'no_findings',
        crowded_segments: [], timeline_over_by_sec: 0 });
      expect(fs.readdirSync(dir).sort()).toEqual(['installed', 'request.json']);
      expect(run('storyboard_timing', { ...input, segments: [...input.segments, input.segments[0]] }).ok).toBe(false);
    });
  });

  it('keeps exact, shorter and longer estimates advisory, including silent shots beyond the requested timeline', async () => {
    await fixture(async (_dir, run) => {
      // Four Han characters without pauses estimate one second at natural speed.
      for (const [duration, remainder, status] of [[1.01, 0.01, 'no_findings'], [1, 0, 'no_findings'], [0.99, -0.01, 'has_findings']] as const) {
        const result = run('storyboard_timing', { duration_sec: 20,
          segments: [{ id: 'line', text: '一二三四', start_sec: 4, target_sec: duration }] });
        expect(result).toMatchObject({ ok: true, kind: 'estimate', speed: 1 });
        expect(result.segments[0]).toMatchObject({ estimated_sec: 1, remaining_sec: remainder });
        expect(result.timing_review).toEqual({ advisory: true, status,
          crowded_segments: remainder < 0 ? [{ id: 'line', over_by_sec: 0.01 }] : [], timeline_over_by_sec: 0 });
      }
      const silent = run('storyboard_timing', { duration_sec: 20,
        segments: [{ id: 'hold', text: '', start_sec: 18, target_sec: 3 }] });
      expect(silent).toMatchObject({ ok: true, planned_end_sec: 21, remaining_timeline_sec: -1,
        timing_review: { advisory: true, status: 'has_findings', crowded_segments: [], timeline_over_by_sec: 1 } });
    });
  });

  it('locates timing input mistakes without guessing corrections or changing the request', async () => {
    await fixture(async (dir, run) => {
      const input = { duration_sec: 20, segments: [
        { id: 'build', text: '', start_sec: 4, target_sec: 8 },
        { id: 'action', text: '', start_sec: 8, target_sec: 5 },
      ] };
      const result = run('storyboard_timing', input);
      expect(result).toMatchObject({ ok: false, errorCode: 'E_STORYBOARD_TIMING_INPUT' });
      expect(result.message).toContain('action');
      expect(result.message).toContain('build');
      expect(result.message).toMatch(/target_sec.*duration.*not an end time/i);
      expect(JSON.parse(fs.readFileSync(path.join(dir, 'request.json'), 'utf8'))).toEqual(input);
      for (const [field, value] of [['target_sec', 0], ['start_sec', -1]] as const) {
        const invalid = run('storyboard_timing', { duration_sec: 20,
          segments: [{ ...input.segments[0], [field]: value }] });
        expect(invalid.ok).toBe(false);
        expect(invalid.message).toContain('build');
        expect(invalid.message).toContain(field);
      }
    });
  });

});

describe('VideoStudio packaged narration estimator', () => {
  it('matches the real shared calculation and a dependency-free fresh build', async () => {
    const requireCjs = createRequire(import.meta.url);
    const bundledPath = path.join(source, 'scripts/lib/narration-timing.cjs');
    const bundled = requireCjs(bundledPath);
    for (const text of ['', 'A fresh start.', '350 mL 陶瓷杯，适合咖啡和茶。', 'GPT-5.5: version 2.0!\nNext — now…', 'Não há complicação.', 'Ứng dụng mới của chúng tôi.', 'Наше новое приложение.', 'تطبيقنا الجديد، متاح الآن.', 'แอปใหม่ของเรา', '새로운 앱이 출시되었습니다.']) {
      for (const speed of [0, 0.5, 1, 1.5, 2, Number.NaN]) {
        expect(bundled.estimateNarrationDuration(text, speed)).toEqual(estimateNarrationDuration(text, speed));
      }
    }
    const esbuild = requireCjs('esbuild');
    const built = await esbuild.build({ entryPoints: [path.join(pc, 'src/main/util/narration-timing.ts')],
      bundle: true, platform: 'node', target: 'node20', format: 'cjs', legalComments: 'none',
      minifyWhitespace: true, sourcemap: false, metafile: true, write: false, logLevel: 'silent' });
    expect(Object.keys(built.metafile.inputs)).toHaveLength(1);
    for (const output of Object.values(built.metafile.outputs) as Array<{ imports: unknown[] }>) expect(output.imports).toEqual([]);
    expect(Buffer.from(built.outputFiles[0].contents).equals(fs.readFileSync(bundledPath))).toBe(true);
  });
});
