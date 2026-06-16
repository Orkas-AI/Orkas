import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

let tmpDir: string;
let prevWs: string | undefined;
const TEST_UID = '99999999';

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'video-auth-'));
  prevWs = process.env.ORKAS_WORKSPACE_ROOT;
  process.env.ORKAS_WORKSPACE_ROOT = tmpDir;
  vi.resetModules();
  const users = await import('../../../src/main/features/users');
  users.activateUser(TEST_UID);
});

afterEach(() => {
  process.env.ORKAS_WORKSPACE_ROOT = prevWs;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('video_auth', () => {
  it('exposes only BYO video provider options', async () => {
    const videoAuth = await import('../../../src/main/features/video_auth');
    const providers = videoAuth.listVideoProviderOptions();

    expect(providers.map((p) => p.id)).toEqual(['doubao']);
    expect(JSON.stringify(providers)).not.toContain(['orkas', 'video'].join('-'));
    expect(videoAuth.listVideoModelOptions('doubao').map((m) => m.id)).toEqual(['doubao-seedance-2-0-260128']);
  });

  it('stores, reorders, and removes local video API key profiles', async () => {
    const videoAuth = await import('../../../src/main/features/video_auth');
    const first = videoAuth.addVideoProfile({
      provider: 'doubao',
      apiKey: 'video-secret-one',
      label: 'one',
    });
    const second = videoAuth.addVideoProfile({
      provider: 'doubao',
      apiKey: 'video-secret-two',
      label: 'two',
    });

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    const firstId = first.ok ? first.id : '';
    const secondId = second.ok ? second.id : '';
    expect(videoAuth.listVideoProfiles().map((p) => p.label)).toEqual(['two', 'one']);
    expect(videoAuth.listVideoProfiles().map((p) => p.model)).toEqual([
      'doubao-seedance-2-0-260128',
      'doubao-seedance-2-0-260128',
    ]);

    expect(videoAuth.reorderVideoProfiles([secondId, firstId])).toEqual({ ok: true });
    expect(videoAuth.listVideoProfiles().map((p) => p.id)).toEqual([secondId, firstId]);

    expect(videoAuth.removeVideoProfile(secondId)).toEqual({ ok: true });
    expect(videoAuth.listVideoProfiles().map((p) => p.id)).toEqual([firstId]);
  });

  it('rejects unsupported video providers and models', async () => {
    const videoAuth = await import('../../../src/main/features/video_auth');

    expect(videoAuth.addVideoProfile({
      provider: 'unknown',
      model: 'doubao-seedance-2-0-260128',
      apiKey: 'video-secret',
    }).ok).toBe(false);
    expect(videoAuth.addVideoProfile({
      provider: 'doubao',
      model: 'not-a-video-model',
      apiKey: 'video-secret',
    }).ok).toBe(false);
  });

  it('labels the BYO DouBao video provider with the Seedance product name', async () => {
    const videoAuth = await import('../../../src/main/features/video_auth');

    expect(videoAuth.listVideoProviderOptions()).toEqual([
      expect.objectContaining({ id: 'doubao', label: 'DouBao · Seedance' }),
    ]);
  });
});
