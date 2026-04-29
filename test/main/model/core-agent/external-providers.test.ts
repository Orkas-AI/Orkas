import { describe, it, expect } from 'vitest';
import {
  buildMoonshotModel,
  createMoonshotProvider,
} from '../../../../src/main/model/core-agent/external-providers';

describe('external-providers › buildMoonshotModel', () => {
  it('build 出的 Model 指向 https://api.moonshot.cn/v1 且用 openai-completions 协议', () => {
    const model = buildMoonshotModel('kimi-k2.5');
    expect(model.api).toBe('openai-completions');
    expect(model.baseUrl).toBe('https://api.moonshot.cn/v1');
    expect(model.id).toBe('kimi-k2.5');
    // provider 字段 pi-ai 只用来打 log，类型签名接受任意字符串。
    expect(model.provider).toBe('moonshot');
  });

  it('contextWindow 对已知 id 用正确值，未知 id 回落到 131072 兜底', () => {
    expect(buildMoonshotModel('kimi-k2.6').contextWindow).toBe(262144);
    expect(buildMoonshotModel('kimi-k2.5').contextWindow).toBe(262144);
    // 未来 Moonshot 加新模型但 Orkas 没跟上时的兜底（131072 = 128k 下限）。
    // legacy preview ids（catalog 已下架）也走这条兜底,仍可用直到 Moonshot 停服。
    expect(buildMoonshotModel('brand-new-model').contextWindow).toBe(131072);
    expect(buildMoonshotModel('kimi-k2-0905-preview').contextWindow).toBe(131072);
  });

  it('name 优先用 CURATED_MODELS 里的 label，缺失时回落 id', () => {
    expect(buildMoonshotModel('kimi-k2.6').name).toBe('Kimi K2.6');
    expect(buildMoonshotModel('kimi-k2.5').name).toBe('Kimi K2.5');
    // 未进 curated 的 id 直接回落 —— 不会报错。
    expect(buildMoonshotModel('random-id').name).toBe('random-id');
  });
});

describe('external-providers › createMoonshotProvider', () => {
  it('缺 apiKey 直接抛错（避免带着空 auth 发出请求被 pi-ai 的 auth 错误吞掉）', async () => {
    await expect(createMoonshotProvider({ apiKey: '', modelId: 'kimi-k2.5' }))
      .rejects.toThrow(/apiKey required/);
  });

  it('缺 modelId 直接抛错（让调用方显式选模型，不走 Moonshot 的默认 fallback）', async () => {
    await expect(createMoonshotProvider({ apiKey: 'sk-xxx', modelId: '' }))
      .rejects.toThrow(/modelId required/);
  });

  it('返回的 LLMProvider 带正确 id + 具备 complete/stream/validateAuth 三个方法', async () => {
    const p = await createMoonshotProvider({ apiKey: 'sk-xxx', modelId: 'kimi-k2.5' });
    expect(p.id).toBe('moonshot');
    expect(typeof p.complete).toBe('function');
    expect(typeof p.stream).toBe('function');
    expect(typeof p.validateAuth).toBe('function');
  });
});
