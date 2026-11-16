import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  granted: true,
  generateImage: vi.fn(),
  workspace: '',
  quote: vi.fn(),
}));

vi.mock('../../../../src/main/features/video_production_services', () => ({ checkVideoProductionServices: h.quote }));
vi.mock('../../../../src/main/features/app_media_route', () => ({ appTaskMediaRoute: async () => undefined }));
vi.mock('../../../../src/main/paths', async original => ({ ...await original(), userLocalRoot: (uid: string) => path.join(h.workspace, '.local', uid) }));
vi.mock('../../../../src/main/features/permissions', () => ({
  getLocalExecGranted: () => h.granted,
}));
vi.mock('../../../../src/main/features/image_gen', () => ({
  generateImage: h.generateImage,
}));
vi.mock('../../../../src/main/features/user_workspace', () => ({
  getWorkspacePath: () => h.workspace,
}));
vi.mock('../../../../src/main/util/project-layout', () => ({
  chatAttachmentDirForConversation: () => path.join(h.workspace, 'attachments'),
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
  h.quote.mockReset().mockResolvedValue({ sufficient: true, externally_billed_segment_ids: ['request'], unavailable_segment_ids: [], external_billing_estimate_available: false, segments: [] });
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
    const tool = createImageGenTool({
      userId: 'user-a',
      cid: 'conv_123',
      turnId: 'turn-456',
      onFileWritten: (file) => published.push(file),
    });
    const result = await tool.execute(
      { prompt: 'a small red dot', output_path: 'image.png', size: '1024x1024' },
      { workingDir: root } as any,
    );

    expect(result.isError).not.toBe(true);
    expect(h.generateImage).toHaveBeenCalledWith(expect.objectContaining({
      prompt: 'a small red dot',
      outputAbsPath: path.join(root, 'image.png'),
      size: '1024x1024',
      usageContext: { conversationId: 'conv_123', turnId: 'turn-456' },
    }));
    expect(published).toEqual([path.join(root, 'image.png')]);
    expect(String(result.content)).toContain('test-provider/test-model');
  });

  it('does not apply the retired global execution gate inside provider dispatch', async () => {
    h.granted = false;
    const tool = createImageGenTool({ userId: 'user-a' });
    const result = await tool.execute(
      { prompt: 'a dot', output_path: 'image.png' },
      { workingDir: root } as any,
    );

    expect(result.isError).not.toBe(true);
    expect(h.generateImage).toHaveBeenCalledTimes(1);
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

describe('timeline still generation admission', () => {
  const input = () => ({ prompt: 'a still', output_path: 'ad/still.png', production_dir: 'ad', shot: 'hero', label: 'Hero still' });
  const ctx = () => ({ workingDir: root } as any);
  const tool = () => createImageGenTool({ userId: 'studio-owner', cid: 'c-studio', agentId: '79df9cc89f5f' });
  it.each([false, true, undefined])('releases only an explicitly undispatched still (dispatched=%s)', async dispatched => {
    h.generateImage.mockResolvedValue({ ok: false, errorCode: 'PROVIDER_API_ERROR', message: 'fixture refusal', ...(dispatched === undefined ? {} : { dispatched }) });
    const t = tool(); expect((await t.execute(input(), ctx())).content).toBe('[PROVIDER_API_ERROR] fixture refusal');
    const again = await t.execute(input(), ctx());
    if (dispatched === false) { expect(h.generateImage).toHaveBeenCalledTimes(2); expect(again.content).toBe('[PROVIDER_API_ERROR] fixture refusal'); }
    else { expect(h.generateImage).toHaveBeenCalledTimes(1); expect(again.content).toContain('E_GENERATION_PENDING'); }
  });
  it('records and reuses the exact still without buying another after a local result was saved', async () => {
    h.generateImage.mockImplementation(async ({ outputAbsPath }) => { fs.mkdirSync(path.dirname(outputAbsPath), { recursive: true }); fs.writeFileSync(outputAbsPath, 'saved-still'); return { ok: true, path: outputAbsPath, width: 10, height: 20, bytes: 11, provider: 'test', model: 'image' }; });
    const t = tool(), first = await t.execute(input(), ctx()); expect(first.isError).not.toBe(true);
    expect(JSON.parse(fs.readFileSync(path.join(root, 'ad/assets.json'), 'utf8')).assets).toEqual([expect.objectContaining({ kind: 'image', path: 'still.png', shot: 'hero', label: 'Hero still', origin: 'generated' })]);
    const again = await t.execute(input(), ctx()); expect(again.content).toContain('already finished'); expect(again.content).not.toContain('paid for'); expect(h.generateImage).toHaveBeenCalledTimes(1);
  });
  it('requires a production and refuses one outside the workspace before generation', async () => {
    const { production_dir, ...missing } = input();
    const absent = await tool().execute(missing, ctx()); expect(absent.isError).toBe(true); expect(absent.content).toContain('E_PRODUCTION_DIR');
    const outside = await tool().execute({ ...input(), production_dir: path.join(root, '..', 'foreign') }, ctx()); expect(outside.isError).toBe(true); expect(outside.content).toContain('E_PATH_OUT_OF_SCOPE');
    expect(h.generateImage).not.toHaveBeenCalled();
  });
});

it.each(['png','jpg','webp'])('refuses an extensionless output whose eventual %s file escapes through a link',async extension=>{
 const foreign=fs.mkdtempSync(path.join(os.tmpdir(),'image-suffix-foreign-'));
 try{
  const sentinel=path.join(foreign,'keep.'+extension);fs.writeFileSync(sentinel,'foreign-owned');
  fs.symlinkSync(sentinel,path.join(root,'image.'+extension));
  const result=await createImageGenTool({userId:'u'}).execute({prompt:'a dot',output_path:'image'},{workingDir:root}as any);
  expect(result.isError).toBe(true);expect(result.content).toContain('E_PATH_OUT_OF_SCOPE');expect(h.generateImage).not.toHaveBeenCalled();expect(fs.readFileSync(sentinel,'utf8')).toBe('foreign-owned');
 }finally{fs.rmSync(foreign,{recursive:true,force:true});}
});


it.each(['png', 'jpg', 'webp'])('keeps earlier extensionless timeline stills when a new request returns %s', async extension => {
  const published: string[] = [];
  const output = path.join(root, 'ad', 'still');
  let generated = 0;
  h.generateImage.mockImplementation(async ({ outputAbsPath }) => {
    generated++;
    const saved = `${outputAbsPath}.${extension}`;
    fs.mkdirSync(path.dirname(saved), { recursive: true });
    fs.writeFileSync(saved, `generation-${generated}`);
    return { ok: true, path: saved, width: 10, height: 20, bytes: 12, provider: 'test', model: 'image' };
  });
  const t = createImageGenTool({ userId: 'studio-owner', cid: 'c-studio', agentId: '79df9cc89f5f', onFileWritten: file => { published.push(file); } });
  const input = { prompt: 'First composition', output_path: 'ad/still', production_dir: 'ad', shot: 'hero' };
  const first = await t.execute(input, { workingDir: root } as any);
  expect(first.isError).not.toBe(true);
  const second = await t.execute({ ...input, prompt: 'Second composition' }, { workingDir: root } as any);
  expect(second.isError).not.toBe(true);
  expect(h.generateImage.mock.calls.map(([call]) => call.outputAbsPath)).toEqual([output, output + '-2']);
  expect(fs.readFileSync(output + '.' + extension, 'utf8')).toBe('generation-1');
  expect(fs.readFileSync(output + '-2.' + extension, 'utf8')).toBe('generation-2');
  const reused = await t.execute(input, { workingDir: root } as any);
  expect(reused.isError).not.toBe(true);
  expect(reused.content).toContain('already finished');
  expect(h.generateImage).toHaveBeenCalledTimes(2);
  expect(published).toEqual([output + '.' + extension, output + '-2.' + extension, output + '.' + extension]);
  const assets = JSON.parse(fs.readFileSync(path.join(root, 'ad/assets.json'), 'utf8')).assets;
  expect(assets.map((asset: any) => asset.path)).toEqual(['still.' + extension, 'still-2.' + extension]);
});
