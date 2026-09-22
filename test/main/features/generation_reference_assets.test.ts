import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/main/features/machine_device_id', () => ({
  getDeviceId: () => 'open-device-id',
}));

vi.mock('../../../src/main/util/image-transform', () => ({
  prepareFeedbackUploadImage: async (
    buf: Buffer,
    opts: { fileName: string; mimeType: string },
  ) => ({
    buf,
    fileName: opts.fileName,
    mimeType: opts.mimeType,
  }),
}));

let tmpDir = '';

async function writeTinyMp4(fileName = 'reference.mp4', suffix = ''): Promise<string> {
  const filePath = path.join(tmpDir, fileName);
  const bytes = Buffer.from(`0000ftypisom${suffix}`, 'ascii');
  await fs.writeFile(filePath, bytes);
  return filePath;
}

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'orkas-generation-reference-'));
  vi.resetModules();
});

afterEach(async () => {
  const proxy = await import('../../../src/main/util/proxy-dispatcher');
  proxy._resetProxyRoutingForTests();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe('generation reference assets', () => {
  it.each(['empty', 'local', 'remote', 'mixed'])('preserves reference identity and progress for %s image inputs', async (mode) => {
    const localBytes = [Buffer.from('local identity'), Buffer.from('local composition')];
    const remoteBytes = [Buffer.from('remote style'), Buffer.from('remote content')];
    const paths = localBytes.map((_, i) => path.join(tmpDir, `reference-${i}.png`));
    await Promise.all(paths.map((file, i) => fs.writeFile(file, localBytes[i])));
    const urls = ['https://cdn.example/style.png', 'https://cdn.example/content.png'];
    const fetchMock = vi.fn(async (url: string) => {
      const index = urls.indexOf(String(url));
      if (index < 0) throw new Error('unexpected reference download');
      return new Response(remoteBytes[index], { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);
    const referenceAssets = await import('../../../src/main/features/generation_reference_assets');
    const hasLocal = mode === 'local' || mode === 'mixed';
    const hasRemote = mode === 'remote' || mode === 'mixed';
    const progress: Array<{ phase: string; data?: Record<string, unknown> }> = [];
    const buffers = await referenceAssets.loadImageReferenceBuffersWithProgress(
      hasRemote ? urls : [], hasLocal ? paths : [], { onProgress: event => progress.push(event) },
    );

    const expected = [...(hasLocal ? localBytes : []), ...(hasRemote ? remoteBytes : [])];
    expect(buffers).toEqual(expected);
    expect(fetchMock).toHaveBeenCalledTimes(hasRemote ? 2 : 0);
    expect(progress.map(event => event.data)).toEqual(expected.map((_, i) => ({
      kind: 'image', index: i + 1, total: expected.length,
    })));
    expect(progress.map(event => event.phase)).toEqual([
      ...(hasLocal ? ['reference_load', 'reference_load'] : []),
      ...(hasRemote ? ['reference_download', 'reference_download'] : []),
    ]);
  });

  it.each(['cancel', 'missing', 'download'])('rejects %s during mixed reference preparation without returning a partial list', async (failure) => {
    const localPath = path.join(tmpDir, 'reference.png');
    if (failure !== 'missing') await fs.writeFile(localPath, Buffer.from('local identity'));
    const fetchMock = vi.fn(async () => new Response('reference unavailable', { status: 403 }));
    vi.stubGlobal('fetch', fetchMock);
    const referenceAssets = await import('../../../src/main/features/generation_reference_assets');
    const controller = new AbortController();
    const loading = referenceAssets.loadImageReferenceBuffersWithProgress(
      ['https://cdn.example/style.png'], [localPath], {
        signal: controller.signal,
        onProgress: event => {
          if (failure === 'cancel' && event.phase === 'reference_load') controller.abort();
        },
      },
    );
    if (failure === 'missing') await expect(loading).rejects.toMatchObject({ code: 'ENOENT' });
    else await expect(loading).rejects.toThrow(failure === 'cancel' ? /aborted/i : /403/);
    expect(fetchMock).toHaveBeenCalledTimes(failure === 'download' ? 1 : 0);
  });

  it('reuses a generated public URL for the unchanged local output', async () => {
    const localPath = await writeTinyMp4();
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const referenceAssets = await import('../../../src/main/features/generation_reference_assets');

    referenceAssets.registerGeneratedMediaUrl(localPath, 'https://cdn.example/account-a.mp4');
    expect(referenceAssets.generatedMediaUrlForPath(localPath))
      .toBe('https://cdn.example/account-a.mp4');
    await expect(referenceAssets.prepareReferenceUrls({
      kind: 'video',
      paths: [localPath],
      maxItems: 1,
    })).resolves.toEqual(['https://cdn.example/account-a.mp4']);
    expect(fetchMock).not.toHaveBeenCalled();

  });

  it('invalidates a generated URL when the local file has been replaced', async () => {
    const localPath = await writeTinyMp4();
    const referenceAssets = await import('../../../src/main/features/generation_reference_assets');

    referenceAssets.registerGeneratedMediaUrl(localPath, 'https://cdn.example/original.mp4');
    await fs.writeFile(localPath, Buffer.from('0000ftypisom-replaced-and-longer', 'ascii'));

    expect(referenceAssets.generatedMediaUrlForPath(localPath)).toBe('');
  });

  it('keeps public URLs but fails closed for a local URL-based reference', async () => {
    const localPath = await writeTinyMp4('upload.mp4', '-current');
    const progress: string[] = [];
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const referenceAssets = await import('../../../src/main/features/generation_reference_assets');

    await expect(referenceAssets.prepareReferenceUrls({
      kind: 'video',
      urls: ['https://cdn.example/existing.mp4'],
      paths: [localPath],
      maxItems: 2,
      onProgress: ({ phase }) => progress.push(phase),
    })).rejects.toThrow('E_REFERENCE_PUBLIC_URL_REQUIRED');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(progress).toEqual(['reference_prepare']);
  });

  it('rejects insecure, private-host, and malformed URL references instead of silently dropping them', async () => {
    const referenceAssets = await import('../../../src/main/features/generation_reference_assets');

    for (const url of [
      'http://cdn.example/reference.png',
      'https://127.0.0.1/reference.png',
      'https://localhost/reference.png',
      'asset:not-a-provider-asset',
      'not a URL',
    ]) {
      await expect(referenceAssets.prepareReferenceUrls({
        kind: 'image',
        urls: [url],
        maxItems: 1,
      }), url).rejects.toThrow(/HTTPS public URL or asset:\/\//);
    }
  });

  it('fails closed on unavailable upload and on cancellation without returning a partial local reference', async () => {
    const localPath = await writeTinyMp4();
    const referenceAssets = await import('../../../src/main/features/generation_reference_assets');
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await expect(referenceAssets.prepareReferenceUrls({
      kind: 'video',
      paths: [localPath],
      maxItems: 1,
    })).rejects.toThrow('E_REFERENCE_PUBLIC_URL_REQUIRED');

    const controller = new AbortController();
    controller.abort();
    await expect(referenceAssets.prepareReferenceUrls({
      kind: 'video',
      paths: [localPath],
      maxItems: 1,
      signal: controller.signal,
    })).rejects.toThrow(/aborted/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects asset URLs for byte-based image adapters before any network request', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const referenceAssets = await import('../../../src/main/features/generation_reference_assets');

    await expect(referenceAssets.loadImageReferenceBuffers([
      'asset://provider/reference-image',
    ])).rejects.toThrow(/only supported by URL-based video generation/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('bounds FFmpeg diagnostics and settles timeouts promptly', async () => {
    const referenceAssets = await import('../../../src/main/features/generation_reference_assets');
    const node = process.env.ORKAS_TEST_NODE || process.execPath;

    await expect(referenceAssets.runReferenceFfmpegForTest(node, [
      '-e',
      "process.stderr.write('x'.repeat(256)); setInterval(() => {}, 1000)",
    ], { timeoutMs: 10_000, maxStderrBytes: 32 }))
      .rejects.toThrow('ffmpeg stderr exceeded 32 bytes');

    const startedAt = Date.now();
    await expect(referenceAssets.runReferenceFfmpegForTest(node, [
      '-e',
      'setInterval(() => {}, 1000)',
    ], { timeoutMs: 50 })).rejects.toThrow('ffmpeg timed out');
    expect(Date.now() - startedAt).toBeLessThan(5_000);
  });

  it.runIf(process.platform === 'win32')('terminates the complete Windows FFmpeg process tree', async () => {
    const processTmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'orkas-reference-ffmpeg-tree-'));
    const sentinel = path.join(processTmpDir, 'orphan-wrote.txt');
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

    try {
      const referenceAssets = await import('../../../src/main/features/generation_reference_assets');
      await expect(referenceAssets.runReferenceFfmpegForTest(
        node,
        ['-e', parentScript],
        { timeoutMs: 75 },
      )).rejects.toThrow('ffmpeg timed out');
      await new Promise((resolve) => setTimeout(resolve, 900));
      await expect(fs.access(sentinel)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await fs.rm(processTmpDir, {
        recursive: true,
        force: true,
        maxRetries: 5,
        retryDelay: 50,
      });
    }
  });

  it('does not expose local reference paths in validation and FFmpeg errors', async () => {
    const emptyImage = path.join(tmpDir, 'client-private-empty.png');
    const largeVideo = path.join(tmpDir, 'client-private-video.mp4');
    const previousFfmpegPath = process.env.FFMPEG_PATH;

    try {
      await fs.writeFile(emptyImage, Buffer.alloc(0));
      const fakeMp4 = Buffer.alloc(20 * 1024 * 1024 + 1);
      fakeMp4.write('ftyp', 4, 'ascii');
      await fs.writeFile(largeVideo, fakeMp4);
      process.env.FFMPEG_PATH = path.join(tmpDir, 'missing-ffmpeg');

      const referenceAssets = await import('../../../src/main/features/generation_reference_assets');
      let imageMessage = '';
      try {
        await referenceAssets.prepareReferenceUrls({
          kind: 'image',
          paths: [emptyImage],
          maxItems: 1,
        });
      } catch (error) {
        imageMessage = (error as Error).message;
      }
      expect(imageMessage).toContain('reference image 1/1 is empty');
      expect(imageMessage).not.toContain(tmpDir);
      expect(imageMessage).not.toContain('client-private-empty.png');

      let videoMessage = '';
      try {
        await referenceAssets.prepareReferenceUrls({
          kind: 'video',
          paths: [largeVideo],
          maxItems: 1,
        });
      } catch (error) {
        videoMessage = (error as Error).message;
      }
      expect(videoMessage).toContain('reference video 1/1 needs compression');
      expect(videoMessage).not.toContain(tmpDir);
      expect(videoMessage).not.toContain('client-private-video.mp4');
      expect(videoMessage).not.toContain('missing-ffmpeg');
    } finally {
      if (previousFfmpegPath === undefined) delete process.env.FFMPEG_PATH;
      else process.env.FFMPEG_PATH = previousFfmpegPath;
    }
  });
});

describe('reference image transfer guards', () => {
  it('rejects an empty successful response', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(new Uint8Array(0))));
    const { loadImageReferenceBuffersWithProgress } = await import('../../../src/main/features/generation_reference_assets');
    await expect(loadImageReferenceBuffersWithProgress(['https://cdn.example/empty.png'], [], {})).rejects.toThrow(/empty body/);
  });
});
