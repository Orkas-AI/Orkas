import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  granted: true,
  generateImage: vi.fn(),
  workspace: '',
}));

vi.mock('../../../../src/main/features/permissions', () => ({
  getLocalExecGranted: () => h.granted,
}));
vi.mock('../../../../src/main/features/image_gen', () => ({
  generateImage: h.generateImage,
}));
vi.mock('../../../../src/main/features/user_workspace', () => ({
  getWorkspacePath: () => h.workspace,
}));
vi.mock('../../../../src/main/paths', () => ({
  chatAttachmentDir: () => path.join(h.workspace, 'attachments'),
}));
vi.mock('../../../../src/main/logger', () => ({
  createLogger: () => ({ warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

import { createImageGenTool } from '../../../../src/main/model/core-agent/image-gen-tool';

let root = '';

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-open-image-tool-'));
  h.workspace = root;
  h.granted = true;
  h.generateImage.mockReset().mockImplementation(async ({ outputAbsPath }) => ({
    ok: true,
    path: outputAbsPath,
    width: 1024,
    height: 1024,
    bytes: 128,
    provider: 'test-provider',
    model: 'test-model',
  }));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('generate_image tool in the open build', () => {
  it('dispatches a configured BYO provider and publishes the generated path', async () => {
    const published: string[] = [];
    const tool = createImageGenTool({ userId: 'user-a', onFileWritten: (file) => published.push(file) });
    const result = await tool.execute(
      { prompt: 'a small red dot', output_path: 'image.png', size: '1024x1024' },
      { workingDir: root } as any,
    );

    expect(result.isError).not.toBe(true);
    expect(h.generateImage).toHaveBeenCalledWith(expect.objectContaining({
      prompt: 'a small red dot',
      outputAbsPath: path.join(root, 'image.png'),
      size: '1024x1024',
    }));
    expect(published).toEqual([path.join(root, 'image.png')]);
    expect(String(result.content)).toContain('test-provider/test-model');
  });

  it('blocks provider dispatch when tool execution access is disabled', async () => {
    h.granted = false;
    const tool = createImageGenTool({ userId: 'user-a' });
    const result = await tool.execute(
      { prompt: 'a dot', output_path: 'image.png' },
      { workingDir: root } as any,
    );

    expect(result.isError).toBe(true);
    expect(String(result.content)).toContain('E_TOOL_EXECUTION_ACCESS_DISABLED');
    expect(h.generateImage).not.toHaveBeenCalled();
  });

  it('rejects outputs and references outside the workspace before dispatch', async () => {
    const tool = createImageGenTool({ userId: 'user-a' });
    const outputResult = await tool.execute(
      { prompt: 'a dot', output_path: path.join(root, '..', 'outside.png') },
      { workingDir: root } as any,
    );
    const referenceResult = await tool.execute(
      {
        prompt: 'a dot',
        output_path: 'inside.png',
        reference_images: [path.join(root, '..', 'outside-reference.png')],
      },
      { workingDir: root } as any,
    );

    expect(outputResult.isError).toBe(true);
    expect(referenceResult.isError).toBe(true);
    expect(String(outputResult.content)).toContain('E_PATH_OUT_OF_SCOPE');
    expect(String(referenceResult.content)).toContain('E_PATH_OUT_OF_SCOPE');
    expect(h.generateImage).not.toHaveBeenCalled();
  });

  it('passes existing in-workspace reference images to the provider', async () => {
    const reference = path.join(root, 'reference.png');
    fs.writeFileSync(reference, 'reference');
    const tool = createImageGenTool({ userId: 'user-a' });
    await tool.execute(
      { prompt: 'variation', output_path: 'result.png', reference_images: [reference] },
      { workingDir: root } as any,
    );

    expect(h.generateImage).toHaveBeenCalledWith(expect.objectContaining({
      referenceImagePaths: [reference],
    }));
  });
});
