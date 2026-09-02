import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const mocks = vi.hoisted(() => ({
  profiles: [] as Array<{
    id: string;
    provider: string;
    model: string;
    apiKey: string;
    label: string;
    createdAt: number;
  }>,
  registerGeneratedMediaUrl: vi.fn(),
  downloadBinaryWithProxyPolicy: vi.fn(),
}));

vi.mock('../../../src/main/features/auth', () => ({
  loadVideoProfiles: () => mocks.profiles.map((profile) => ({ ...profile })),
}));

vi.mock('../../../src/main/features/generation_reference_assets', () => ({
  prepareReferenceUrls: vi.fn(async ({ urls }: { urls?: string[] }) => [...(urls || [])]),
  registerGeneratedMediaUrl: mocks.registerGeneratedMediaUrl,
}));

vi.mock('../../../src/main/util/proxy-dispatcher', () => ({
  downloadBinaryWithProxyPolicy: mocks.downloadBinaryWithProxyPolicy,
}));

vi.mock('../../../src/main/logger', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

import { generateVideo, validateDownloadedVideo } from '../../../src/main/features/video_gen';

let tmpDir: string;

function mp4Fixture(): Buffer {
  const out = Buffer.alloc(24);
  out.writeUInt32BE(24, 0);
  out.write('ftyp', 4, 'ascii');
  out.write('isom', 8, 'ascii');
  out.writeUInt32BE(0, 12);
  out.write('isom', 16, 'ascii');
  out.write('mp42', 20, 'ascii');
  return out;
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-video-gen-'));
  mocks.profiles = [{
    id: 'vid-orkas',
    provider: 'orkas-api',
    model: 'orkas-video',
    apiKey: 'orkas-user-key',
    label: 'Orkas',
    createdAt: 1,
  }];
  mocks.registerGeneratedMediaUrl.mockReset();
  mocks.downloadBinaryWithProxyPolicy.mockReset();
  mocks.downloadBinaryWithProxyPolicy.mockImplementation(async (_url, options) => {
    const body = mp4Fixture();
    options?.validate?.(body);
    return { body, finalUrl: 'https://cdn.example.test/video.mp4' };
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('video_gen › Orkas public API', () => {
  it('creates, downloads, and saves a public API video without sending a model', async () => {
    const fetchStub = vi.fn(async () => new Response(JSON.stringify({
      id: 'video_public_test',
      status: 'succeeded',
      url: 'https://cdn.example.test/video.mp4',
      duration: 5,
      ratio: '16:9',
      resolution: '720p',
    }), { status: 202 }));
    vi.stubGlobal('fetch', fetchStub);
    const requestedPath = path.join(tmpDir, 'result.mov');

    const result = await generateVideo({
      prompt: 'a paper boat crosses a pond',
      outputAbsPath: requestedPath,
      quality: 'economy',
      generateAudio: false,
      usageContext: { conversationId: 'conv_123', turnId: 'turn-456' },
    });

    expect(result).toMatchObject({
      ok: true,
      path: path.join(tmpDir, 'result.mp4'),
      provider: 'orkas-api',
      model: 'orkas-video',
      taskId: 'video_public_test',
    });
    expect(fs.readFileSync(path.join(tmpDir, 'result.mp4'))).toEqual(mp4Fixture());
    expect(fetchStub).toHaveBeenCalledTimes(1);
    expect(fetchStub).toHaveBeenCalledWith(
      'https://orkas.ai/v1/videos',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          'X-Orkas-Conversation-Id': 'conv_123',
          'X-Orkas-Turn-Id': 'turn-456',
        }),
      }),
    );
    const body = JSON.parse(String(fetchStub.mock.calls[0]?.[1]?.body));
    expect(body).toMatchObject({
      prompt: 'a paper boat crosses a pond',
      quality: 'balanced',
      generate_audio: false,
    });
    expect(body).not.toHaveProperty('model');
    expect(mocks.registerGeneratedMediaUrl).toHaveBeenCalledWith(
      path.join(tmpDir, 'result.mp4'),
      'https://cdn.example.test/video.mp4',
    );
  });

  it('fails before dispatch when edit mode has no reference video', async () => {
    const fetchStub = vi.fn();
    vi.stubGlobal('fetch', fetchStub);

    await expect(generateVideo({
      prompt: 'change the ending',
      outputAbsPath: path.join(tmpDir, 'edit.mp4'),
      operation: 'edit',
    })).resolves.toMatchObject({
      ok: false,
      errorCode: 'BAD_INPUT',
      message: expect.stringContaining('requires at least one reference video'),
    });
    expect(fetchStub).not.toHaveBeenCalled();
  });

  it('returns NO_CAPABLE_MODEL when no Orkas public video profile exists', async () => {
    mocks.profiles = [];
    await expect(generateVideo({
      prompt: 'a quiet landscape',
      outputAbsPath: path.join(tmpDir, 'missing.mp4'),
    })).resolves.toMatchObject({ ok: false, errorCode: 'NO_CAPABLE_MODEL' });
  });

  it('rejects non-MP4 downloads', () => {
    expect(() => validateDownloadedVideo(Buffer.from('not a video'))).toThrow(/invalid or unsupported MP4/);
  });
});
