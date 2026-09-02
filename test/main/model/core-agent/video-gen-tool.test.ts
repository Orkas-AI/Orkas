import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  generateVideo: vi.fn(),
  workspace: '',
}));

vi.mock('../../../../src/main/features/video_gen', () => ({
  generateVideo: h.generateVideo,
}));
vi.mock('../../../../src/main/features/user_workspace', () => ({
  getWorkspacePath: () => h.workspace,
}));
vi.mock('../../../../src/main/logger', () => ({
  createLogger: () => ({ warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

import { createVideoGenTool } from '../../../../src/main/model/core-agent/video-gen-tool';

let root = '';

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-open-video-tool-'));
  h.workspace = root;
  h.generateVideo.mockReset().mockImplementation(async ({ outputAbsPath }) => ({
    ok: true,
    path: outputAbsPath,
    bytes: 256,
    provider: 'orkas-api',
    model: 'orkas-video',
    taskId: 'video-test-task',
    videoUrl: 'https://cdn.example.test/video.mp4',
    status: 'succeeded',
  }));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('generate_video tool in the open build', () => {
  it('dispatches the configured public provider and publishes an MP4 path', async () => {
    const published: string[] = [];
    const progress = vi.fn();
    const tool = createVideoGenTool({
      userId: 'user-a',
      cid: 'conv_123',
      turnId: 'turn-456',
      onFileWritten: (file) => published.push(file),
    });
    const result = await tool.execute(
      {
        prompt: 'a paper boat crosses a pond',
        output_path: 'clip.mov',
        duration: 6,
        quality: 'quality',
        generate_audio: false,
      },
      { workingDir: root, emitProgress: progress } as any,
    );

    expect(result.isError).not.toBe(true);
    expect(h.generateVideo).toHaveBeenCalledWith(expect.objectContaining({
      prompt: 'a paper boat crosses a pond',
      outputAbsPath: path.join(root, 'clip.mp4'),
      duration: 6,
      quality: 'quality',
      generateAudio: false,
      usageContext: { conversationId: 'conv_123', turnId: 'turn-456' },
    }));
    expect(published).toEqual([path.join(root, 'clip.mp4')]);
    expect(String(result.content)).toContain('orkas-api/orkas-video');
    expect(String(result.content)).toContain('[video](');
  });

  it('rejects out-of-scope outputs and invalid edit requests before dispatch', async () => {
    const tool = createVideoGenTool({ userId: 'user-a' });
    const outside = await tool.execute(
      { prompt: 'a dot', output_path: path.join(root, '..', 'outside.mp4') },
      { workingDir: root } as any,
    );
    const missingReference = await tool.execute(
      { prompt: 'change the ending', output_path: 'edit.mp4', operation: 'edit' },
      { workingDir: root } as any,
    );

    expect(outside.isError).toBe(true);
    expect(String(outside.content)).toContain('E_PATH_OUT_OF_SCOPE');
    expect(missingReference.isError).toBe(true);
    expect(String(missingReference.content)).toContain('requires at least one reference video');
    expect(h.generateVideo).not.toHaveBeenCalled();
  });

  it('turns exhausted public API credits into a non-retry instruction', async () => {
    h.generateVideo.mockResolvedValueOnce({
      ok: false,
      errorCode: 'CREDITS_EXHAUSTED',
      message: 'quota exhausted',
    });
    const tool = createVideoGenTool({ userId: 'user-a' });
    const result = await tool.execute(
      { prompt: 'a quiet landscape', output_path: 'clip.mp4' },
      { workingDir: root } as any,
    );

    expect(result.isError).toBe(true);
    expect(String(result.content)).toContain('E_CREDITS_EXHAUSTED');
    expect(String(result.content)).toContain('Do not retry');
  });
});
