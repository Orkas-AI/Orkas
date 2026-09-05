import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  pathAllowed: true,
  generateImage: vi.fn(),
  estimateImageCredits: vi.fn(),
  findReusableImageGeneration: vi.fn(),
  beginImageGeneration: vi.fn(),
  finishImageGeneration: vi.fn(),
  noteGeneration: vi.fn(),
  regenerationWarning: vi.fn(),
}));

vi.mock('../../../../src/main/features/image_gen', () => ({
  generateImage: (...args: unknown[]) => h.generateImage(...args),
}));
vi.mock('../../../../src/main/features/image_production_credits', () => ({
  estimateImageProductionCredits: (...args: unknown[]) => h.estimateImageCredits(...args),
}));
vi.mock('../../../../src/main/features/image_production_control', () => ({
  findReusableImageStudioGeneration: (...args: unknown[]) => h.findReusableImageGeneration(...args),
  beginImageStudioGeneration: (...args: unknown[]) => h.beginImageGeneration(...args),
  finishImageStudioGeneration: (...args: unknown[]) => h.finishImageGeneration(...args),
  imageGenerationControlStatePath: () => '/tmp/image-generation-state.json',
}));
vi.mock('../../../../src/main/util/path-sandbox', () => ({
  isPathAllowed: () => h.pathAllowed,
}));
vi.mock('../../../../src/main/util/uniquify-path', () => ({
  uniquifyPath: async (p: string) => ({ finalPath: p, renamed: false }),
  renderRenameSignal: () => '',
}));
vi.mock('../../../../src/main/util/generation-guard', () => ({
  noteGeneration: (...args: unknown[]) => h.noteGeneration(...args),
  regenerationWarning: (...args: unknown[]) => h.regenerationWarning(...args),
}));
vi.mock('../../../../src/main/features/user_workspace', () => ({
  getWorkspacePath: () => '/ws',
}));
vi.mock('../../../../src/main/util/project-layout', () => ({
  chatAttachmentDirForConversation: () => '/ws/attachments',
}));
vi.mock('../../../../src/main/util/chat-media-url', () => ({
  versionedChatMediaLocalUrl: (p: string) => `chat-media://test/${encodeURIComponent(p)}`,
}));
vi.mock('../../../../src/main/features/video_production_control', () => ({
  beginVideoProductionGeneration: vi.fn(),
  finishVideoProductionGeneration: vi.fn(),
  videoProductionControlStatePath: () => '/ws/production-state.json',
}));
vi.mock('../../../../src/main/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));
vi.mock('../../../../src/main/util/log-redact', () => ({
  logErrorRef: (e: unknown) => String(e),
  logPathRef: (p: unknown) => String(p),
  maskId: (s: unknown) => String(s),
}));

beforeEach(() => {
  h.pathAllowed = true;
  h.generateImage.mockReset();
  h.estimateImageCredits.mockReset();
  h.findReusableImageGeneration.mockReset();
  h.beginImageGeneration.mockReset();
  h.finishImageGeneration.mockReset();
  h.noteGeneration.mockReset().mockReturnValue(1);
  h.regenerationWarning.mockReset().mockReturnValue(null);
  h.estimateImageCredits.mockResolvedValue({
    in_app_credits_required_milli: 0,
    external_billing_estimate_available: false,
    sufficient: true,

    externally_billed_segment_ids: [],

    unavailable_segment_ids: [],
    segments: [{ segment_id: 'hero-initial', billing_mode: 'external' }],
  });
  h.findReusableImageGeneration.mockResolvedValue(null);
  h.beginImageGeneration.mockResolvedValue({
    status: 'started',
    transaction: {
      transaction_id: 'image-tx-1',
      request_id: 'hero-initial',
      status: 'pending',
    },
    callCount: 1,
    maxCalls: 2,
  });
  h.finishImageGeneration.mockResolvedValue({});
  h.generateImage.mockImplementation(async (request: any) => {
    request.onProgress?.({ phase: 'generating', message: 'halfway', data: { progress: 50 } });
    return {
      ok: true,
      path: request.outputAbsPath,
      width: 1024,
      height: 1024,
      bytes: 128,
      provider: 'test-provider',
      model: 'test-model',
    };
  });
});

function ctx() {
  return {
    workingDir: path.resolve('/ws'),
    emitProgress: vi.fn(),
  } as any;
}

describe('generate_image tool', () => {
  it('dispatches generation with the requested inputs and publishes the output', async () => {
    const { createImageGenTool } = await import('../../../../src/main/model/core-agent/image-gen-tool');
    const onFileWritten = vi.fn();
    const tool = createImageGenTool({
      userId: 'u1',
      cid: 'c1',
      turnId: 't1',
      agentId: 'a1',
      agentName: 'Designer',
      conversationTitle: 'Bird concept',
      conversationTitleUpdatedAt: 1_234,
      onFileWritten,
    });
    const context = ctx();
    const outputPath = path.resolve('/ws/out/image.png');

    const res = await tool.execute!({
      prompt: '  a blue bird  ',
      output_path: 'out/image.png',
      reference_image_urls: [' https://example.com/reference.png '],
      size: '1024x1024',
    }, context);

    expect(res.isError).toBeFalsy();
    expect(h.generateImage).toHaveBeenCalledWith(expect.objectContaining({
      prompt: 'a blue bird',
      outputAbsPath: outputPath,
      referenceImageUrls: ['https://example.com/reference.png'],
      size: '1024x1024',
      usageContext: { conversationId: 'c1', turnId: 't1' },
    }));
    expect(context.emitProgress).toHaveBeenCalledWith({
      phase: 'generating',
      message: 'halfway',
      data: { progress: 50 },
    });
    expect(onFileWritten).toHaveBeenCalledWith(outputPath);
    expect(String(res.content)).toContain(`Image written to ${outputPath}`);
    expect(String(res.content)).toContain('1024x1024, 128 bytes, test-provider/test-model');
    expect(h.estimateImageCredits).not.toHaveBeenCalled();
  });

  it('surfaces repeated billable-generation warnings in the successful tool result', async () => {
    h.noteGeneration.mockReturnValueOnce(3);
    h.regenerationWarning.mockReturnValueOnce('generation #3 is billable');
    const { createImageGenTool } = await import('../../../../src/main/model/core-agent/image-gen-tool');
    const tool = createImageGenTool({ userId: 'u1', cid: 'cost-aware-chat' });

    const res = await tool.execute!({
      prompt: 'a blue bird',
      output_path: 'out/image.png',
    }, ctx());

    expect(res.isError).toBeFalsy();
    expect(h.noteGeneration).toHaveBeenCalledWith(
      'cost-aware-chat',
      path.resolve('/ws/out/image.png'),
    );
    expect(h.regenerationWarning).toHaveBeenCalledWith(3, 'image');
    expect(String(res.content)).toContain('generation #3 is billable');
  });

  it('compiles structured reference roles and negative constraints for every provider', async () => {
    const { createImageGenTool } = await import('../../../../src/main/model/core-agent/image-gen-tool');
    const tool = createImageGenTool({ userId: 'u1', cid: 'c1' });

    const res = await tool.execute!({
      prompt: 'Editorial portrait',
      output_path: 'portrait.png',
      reference_image_urls: ['https://example.com/person.png'],
      reference_bindings: [{
        index: 0,
        role: 'identity',
        strength: 0.9,
        preserve: ['facial identity', 'hair shape'],
        may_change: ['background'],
        region: 'hero',
      }],
      negative_prompt: ['garbled text', 'duplicated face'],
    }, ctx());

    expect(res.isError).toBeFalsy();
    const request = h.generateImage.mock.calls[0][0];
    expect(request.prompt).toContain('Reference 1: role=identity; strength=0.90');
    expect(request.prompt).toContain('preserve=facial identity, hair shape');
    expect(request.prompt).toContain('Avoid: garbled text; duplicated face.');
    expect(request.referenceBindings).toEqual([expect.objectContaining({ role: 'identity', strength: 0.9, region: 'hero' })]);
    expect(request.negativePrompt).toEqual(['garbled text', 'duplicated face']);
  });

  it('requires durable project generation context for ImageStudio', async () => {
    const { createImageGenTool } = await import('../../../../src/main/model/core-agent/image-gen-tool');
    const tool = createImageGenTool({ userId: 'u1', cid: 'c1', agentId: '814b61b027f0' });

    const res = await tool.execute!({ prompt: 'a bird', output_path: 'bird.png' }, ctx());

    expect(res.isError).toBe(true);
    expect(String(res.content)).toContain('E_IMAGE_GENERATION_CONTEXT_REQUIRED');
    expect(h.generateImage).not.toHaveBeenCalled();
  });

  it('checks configured ImageStudio provider availability before starting its durable transaction', async () => {
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-image-gen-quote-'));
    try {
      const { createImageGenTool } = await import('../../../../src/main/model/core-agent/image-gen-tool');
      const tool = createImageGenTool({ userId: 'u1', cid: 'c1', turnId: 'turn-image-1', agentId: '814b61b027f0' });
      const outputPath = path.join(projectDir, 'hero.png');

      const res = await tool.execute!({
        prompt: 'a bird',
        output_path: outputPath,
        image_project_path: projectDir,
        image_request_id: 'hero-initial',
        reference_image_urls: ['https://example.com/guide.png'],
        size: '2048x2048',
      }, ctx());

      expect(res.isError).toBeFalsy();
      expect(h.estimateImageCredits).toHaveBeenCalledWith({
        requestId: 'hero-initial',
        size: '2048x2048',
        referenceCount: 1,
      }, undefined);
      expect(h.estimateImageCredits.mock.invocationCallOrder[0])
        .toBeLessThan(h.beginImageGeneration.mock.invocationCallOrder[0]);
      expect(h.beginImageGeneration.mock.invocationCallOrder[0])
        .toBeLessThan(h.generateImage.mock.invocationCallOrder[0]);
      expect(h.findReusableImageGeneration).toHaveBeenCalledWith(
        '/tmp/image-generation-state.json',
        'hero-initial',
        'turn-image-1',
      );
      expect(h.beginImageGeneration).toHaveBeenCalledWith(expect.objectContaining({
        requestId: 'hero-initial',
        turnId: 'turn-image-1',
      }));
      expect(String(res.content)).toContain('ImageStudio local provider availability before dispatch');
      expect(String(res.content)).toContain('"external_billing_estimate_available":false');
    } finally {
      fs.rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it('blocks an unavailable ImageStudio route before consuming a call slot', async () => {
    h.estimateImageCredits.mockResolvedValueOnce({
      expected_credits_milli: 0,
      required_credits_milli: 0,
      available_credits_milli: 100_000,
      sufficient: false,
      fallback_fully_covered: true,
      orkas_credit_estimate_exact: true,
      externally_billed_segment_ids: [],
  
      unavailable_segment_ids: ['hero-initial'],
      segments: [{ segment_id: 'hero-initial', billing_mode: 'unavailable' }],
    });
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-image-gen-unavailable-'));
    try {
      const { createImageGenTool } = await import('../../../../src/main/model/core-agent/image-gen-tool');
      const tool = createImageGenTool({ userId: 'u1', cid: 'c1', agentId: '814b61b027f0' });

      const res = await tool.execute!({
        prompt: 'a bird',
        output_path: path.join(projectDir, 'bird.png'),
        image_project_path: projectDir,
        image_request_id: 'hero-initial',
      }, ctx());

      expect(res.isError).toBe(true);
      expect(String(res.content)).toContain('E_IMAGE_PRODUCTION_PROVIDER_UNAVAILABLE');
      expect(h.beginImageGeneration).not.toHaveBeenCalled();
      expect(h.generateImage).not.toHaveBeenCalled();
    } finally {
      fs.rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it('reuses a completed ImageStudio request without a new quote or provider call', async () => {
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-image-gen-reuse-'));
    const outputPath = path.join(projectDir, 'bird.png');
    fs.writeFileSync(outputPath, 'existing');
    h.findReusableImageGeneration.mockResolvedValueOnce({
      transaction_id: 'old-tx',
      request_id: 'hero-initial',
      status: 'completed',
      output_path: outputPath,
    });
    try {
      const { createImageGenTool } = await import('../../../../src/main/model/core-agent/image-gen-tool');
      const tool = createImageGenTool({ userId: 'u1', cid: 'c1', agentId: '814b61b027f0' });

      const res = await tool.execute!({
        prompt: 'a bird',
        output_path: outputPath,
        image_project_path: projectDir,
        image_request_id: 'hero-initial',
      }, ctx());

      expect(res.isError).toBeFalsy();
      expect(String(res.content)).toContain('reused completed generation hero-initial');
      expect(h.estimateImageCredits).not.toHaveBeenCalled();
      expect(h.beginImageGeneration).not.toHaveBeenCalled();
      expect(h.generateImage).not.toHaveBeenCalled();
    } finally {
      fs.rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it('rejects an output outside the active workspace before provider dispatch', async () => {
    h.pathAllowed = false;
    const { createImageGenTool } = await import('../../../../src/main/model/core-agent/image-gen-tool');
    const tool = createImageGenTool({ userId: 'u1', cid: 'c1' });

    const res = await tool.execute!({ prompt: 'a bird', output_path: '../bird.png' }, ctx());

    expect(res.isError).toBe(true);
    expect(String(res.content)).toContain('E_PATH_OUT_OF_SCOPE');
    expect(h.generateImage).not.toHaveBeenCalled();
  });

  it('surfaces a thrown provider exception as a tool result', async () => {
    h.generateImage.mockRejectedValueOnce(new Error('connection closed'));
    const { createImageGenTool } = await import('../../../../src/main/model/core-agent/image-gen-tool');
    const tool = createImageGenTool({ userId: 'u1', cid: 'c1' });

    const res = await tool.execute!({ prompt: 'a bird', output_path: 'bird.png' }, ctx());

    expect(res.isError).toBe(true);
    expect(String(res.content)).toBe('[PROVIDER_EXCEPTION] connection closed');
  });

  it('keeps an ImageStudio transaction pending when delivery ends without a terminal result', async () => {
    h.generateImage.mockRejectedValueOnce(new Error('generated output delivery failed'));
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-image-gen-uncertain-'));
    try {
      const { createImageGenTool } = await import('../../../../src/main/model/core-agent/image-gen-tool');
      const tool = createImageGenTool({ userId: 'u1', cid: 'c1', agentId: '814b61b027f0' });

      const res = await tool.execute!({
        prompt: 'a bird',
        output_path: path.join(projectDir, 'bird.png'),
        image_project_path: projectDir,
        image_request_id: 'hero-initial',
      }, ctx());

      expect(res.isError).toBe(true);
      expect(String(res.content)).toContain('E_IMAGE_GENERATION_UNCERTAIN');
      expect(String(res.content)).toContain('request remains pending');
      expect(h.beginImageGeneration).toHaveBeenCalledOnce();
      expect(h.generateImage).toHaveBeenCalledOnce();
      expect(h.finishImageGeneration).not.toHaveBeenCalled();
    } finally {
      fs.rmSync(projectDir, { recursive: true, force: true });
    }
  });
});
