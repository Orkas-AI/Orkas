// Actual public tools, request identities and extension-selected image outputs.
// Availability and provider results are controlled; no external request is sent.
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ localRoot: '', workspace: '', unavailable: false,
  image: vi.fn(), video: vi.fn() }));
vi.mock('../../../src/main/features/video_production_services', () => ({
  checkVideoProductionServices: async () => {
    if (h.unavailable) throw new Error('Controlled service-check failure');
    return { sufficient: true, externally_billed_segment_ids: ['request'],
      unavailable_segment_ids: [], segments: [], external_billing_estimate_available: false };
  },
}));
vi.mock('../../../src/main/paths', async original => ({
  ...await original<object>(), userLocalRoot: () => h.localRoot,
}));
vi.mock('../../../src/main/features/user_workspace', () => ({ getWorkspacePath: () => h.workspace }));
vi.mock('../../../src/main/util/project-layout', () => ({
  chatAttachmentDirForConversation: () => path.join(h.workspace, '.attachments'),
}));
vi.mock('../../../src/main/features/image_gen', async original => ({
  ...await original<object>(), generateImage: (...args: unknown[]) => h.image(...args),
}));
vi.mock('../../../src/main/features/video_gen', async original => ({
  ...await original<object>(), generateVideo: (...args: unknown[]) => h.video(...args),
}));

import { productionRequestStatus } from '../../../src/main/features/video_production_budget';
import { createImageGenTool } from '../../../src/main/model/core-agent/image-gen-tool';
import { createVideoGenTool } from '../../../src/main/model/core-agent/video-gen-tool';

const opts = { userId: 'u_1', cid: 'c1', agentId: '79df9cc89f5f', agentName: 'VideoStudio' };
const production = () => path.join(h.workspace, 'ad');
const status = () => productionRequestStatus({ userId: opts.userId, scope: opts.cid });
const context = () => ({ workingDir: h.workspace, state: {} }) as never;
const args = (prompt = 'A product shot', file = 'hero') => ({
  prompt, output_path: path.join(production(), file), production_dir: production(),
});
const savesPng = async (input: { outputAbsPath: string; prompt: string }) => {
  const finalPath = /\.(png|jpe?g|webp)$/i.test(input.outputAbsPath) ? input.outputAbsPath : `${input.outputAbsPath}.png`;
  fs.mkdirSync(path.dirname(finalPath), { recursive: true });
  fs.writeFileSync(finalPath, input.prompt);
  return { ok: true, path: finalPath, width: 10, height: 10, bytes: 9, provider: 'openai', model: 'fixture' };
};
beforeEach(() => {
  h.localRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'image-request-local-'));
  h.workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'image-request-work-'));
  vi.stubEnv('ORKAS_WORKSPACE_ROOT', h.localRoot);
  fs.mkdirSync(production(), { recursive: true });
  h.unavailable = false;
  h.image.mockReset(); h.video.mockReset();
});
afterEach(() => {
  fs.rmSync(h.localRoot, { recursive: true, force: true });
  fs.rmSync(h.workspace, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

describe('extension-selected image output identity', () => {
  it('reuses the completed file instead of sending the same generation again', async () => {
    h.image.mockImplementation(savesPng);
    const tool = createImageGenTool(opts);
    await tool.execute!(args(), context());
    const second = await tool.execute!(args(), context());
    expect(second.content).toContain(`already finished: ${path.join(production(), 'hero.png')}`);
    expect(h.image).toHaveBeenCalledOnce();
    expect(await status()).toEqual({ completed: 1, pending: 0 });
  });
  it('preserves the old image when another prompt asks for the same extensionless path', async () => {
    h.image.mockImplementation(savesPng);
    const tool = createImageGenTool(opts);
    await tool.execute!(args('First idea'), context());
    await tool.execute!(args('Second idea'), context());
    expect(fs.readFileSync(path.join(production(), 'hero.png'), 'utf8')).toBe('First idea');
    expect(fs.readFileSync(path.join(production(), 'hero-2.png'), 'utf8')).toBe('Second idea');
  });
});

it.each(['image', 'video'])('releases a new %s reservation only after a structured pre-dispatch failure', async kind => {
  const generate = kind === 'image' ? h.image : h.video;
  generate.mockResolvedValue({ ok: false, errorCode: 'NO_CAPABLE_MODEL', message: 'Controlled refusal', dispatched: false });
  const tool = kind === 'image' ? createImageGenTool(opts) : createVideoGenTool(opts);
  expect((await tool.execute!(args('One', kind === 'image' ? 'one.png' : 'one.mp4'), context())).isError).toBe(true);
  expect(await status()).toEqual({ completed: 0, pending: 0 });
});

it.each(['image', 'video'])('keeps an uncertain %s request pending and blocks another provider call', async kind => {
  const generate = kind === 'image' ? h.image : h.video;
  generate.mockResolvedValue({ ok: false, errorCode: 'TIMEOUT', message: 'Controlled uncertain result', postDispatch: true });
  const tool = kind === 'image' ? createImageGenTool(opts) : createVideoGenTool(opts);
  const request = args('One', kind === 'image' ? 'one.png' : 'one.mp4');
  expect((await tool.execute!(request, context())).isError).toBe(true);
  generate.mockResolvedValue({ ok: false, errorCode: 'BAD_INPUT', message: 'Must not be called', dispatched: false });
  const repeat = await tool.execute!(request, context());
  expect(JSON.parse(String(repeat.content))).toMatchObject({ errorCode: 'E_GENERATION_PENDING' });
  expect(generate).toHaveBeenCalledOnce();
  expect(await status()).toEqual({ completed: 0, pending: 1 });
});

it.each(['image', 'video'])('sends nothing when the configured %s service cannot be checked', async kind => {
  h.unavailable = true;
  const tool = kind === 'image' ? createImageGenTool(opts) : createVideoGenTool(opts);
  const result = await tool.execute!(args('One', kind === 'image' ? 'one.png' : 'one.mp4'), context());
  expect(JSON.parse(String(result.content))).toMatchObject({ ok: false, errorCode: 'E_UNAVAILABLE' });
  expect(result.isError).toBe(true);
  expect(result.synthesizeAndEndTurn).toBeUndefined();
  expect(h.image).not.toHaveBeenCalled(); expect(h.video).not.toHaveBeenCalled();
  expect(await status()).toEqual({ completed: 0, pending: 0 });
  expect(fs.readdirSync(production())).toEqual([]);
});
