import { describe, expect, it } from 'vitest';

import {
  assessEstimatedNarrationFit,
  assessNarrationFit,
  estimateNarrationDuration,
  measureNarrationUnits,
  narrationDurationCalibrationScale,
} from '../../../src/main/features/tts';

describe('assessNarrationFit', () => {
  it('flags a narration that is too short for the clip (the draft scenario)', () => {
    // 41 words synthesized to 16.25s, dropped into a 23.9s clip.
    const fit = assessNarrationFit({ measuredSec: 16.25, targetSec: 23.9, wordCount: 41 });
    expect(fit).not.toBeNull();
    expect(fit!.status).toBe('under');
    // Observed rate ~2.52 wps → ~60 words would fill 23.9s.
    expect(fit!.suggestedWords).toBeGreaterThan(41);
    expect(fit!.message).toMatch(/shorter|no narration|add/i);
  });

  it('flags a narration that overshoots the clip', () => {
    const fit = assessNarrationFit({ measuredSec: 30, targetSec: 23.9, wordCount: 60 });
    expect(fit!.status).toBe('over');
    expect(fit!.deltaSec).toBeCloseTo(6.1, 1);
    // To hit the target it must speak faster, or use fewer words.
    expect(fit!.suggestedSpeed).toBeGreaterThan(1);
    expect(fit!.suggestedWords).toBeLessThan(60);
    expect(fit!.message).toMatch(/longer|trim|raise speed/i);
  });

  it('passes a narration within the tolerance band', () => {
    const fit = assessNarrationFit({ measuredSec: 23, targetSec: 23.9, wordCount: 58 });
    expect(fit!.status).toBe('fits');
  });

  it('clamps the suggested speed to a sane range', () => {
    const fit = assessNarrationFit({ measuredSec: 60, targetSec: 10, wordCount: 100 });
    expect(fit!.status).toBe('over');
    expect(fit!.suggestedSpeed).toBeLessThanOrEqual(2.0);
  });

  it('returns null when a duration is unusable (no measurement)', () => {
    expect(assessNarrationFit({ measuredSec: 0, targetSec: 23.9, wordCount: 41 })).toBeNull();
    expect(assessNarrationFit({ measuredSec: 16, targetSec: 0, wordCount: 41 })).toBeNull();
  });

  it('still gives a fit verdict when word count is unknown (no word advice)', () => {
    const fit = assessNarrationFit({ measuredSec: 30, targetSec: 20, wordCount: 0 });
    expect(fit!.status).toBe('over');
    expect(fit!.suggestedWords).toBe(0); // no rate → no word suggestion
    expect(fit!.suggestedSpeed).toBeGreaterThan(1);
  });

  it('labels the trim budget in characters for a CJK script and leads with trimming', () => {
    // The real draft: a Chinese script that takes ~38.6s at a natural pace was
    // crammed into a 23.9s clip by raising speed. The fix is a shorter script.
    const fit = assessNarrationFit({ measuredSec: 38.6, targetSec: 23.9, wordCount: 116, unit: 'characters' });
    expect(fit!.status).toBe('over');
    expect(fit!.message).toMatch(/characters/);
    expect(fit!.message).not.toMatch(/words/);
    // Leads with trimming, and frames speed only as the thing NOT to do.
    expect(fit!.message).toMatch(/trim/i);
    expect(fit!.message).toMatch(/rather than raising speed/i);
    expect(fit!.suggestedWords).toBeLessThan(116); // a real, usable character budget
  });
});

describe('estimateNarrationDuration', () => {
  it('estimates Latin narration at a conservative natural speaking rate', () => {
    const estimate = estimateNarrationDuration(Array.from({ length: 150 }, () => 'word').join(' '));

    expect(estimate).toMatchObject({ unit: 'words', units: 150, unitsPerSec: 2.5 });
    expect(estimate.estimatedSec).toBe(60);
  });

  it('adds CJK, Latin names, versions, numbers, and pauses for a mixed-language script', () => {
    // Regression: the old either/or counter saw only the 375 CJK characters,
    // estimated 93.75s, then a paid synthesis measured 140.9s for a 117s target.
    const text = '2017年，Attention Is All You Need——Transformer 架构诞生，改写 AI 历史。'
      + '自注意力机制让模型同时看见整个序列，成为所有大模型的共同起点。'
      + '2018年，GPT-1 与 BERT 确立预训练范式，BERT 双向理解横扫 11 项基准。'
      + '2019年，GPT-2 用 15 亿参数证明：规模越大，能力越强。'
      + '2020年，GPT-3 的 1750 亿参数带来涌现能力：上下文学习、代码生成。'
      + 'DALL·E、Codex、CLIP——AI 开始看懂图像、写代码、融合多感官。'
      + '2022年，ChatGPT 上线，两月一亿用户，史上最快增长，AI 走入每个人生活。'
      + '2023年，GPT-4 多模态理解，律师考试超 90% 人类，从聊天到理解世界。'
      + 'Llama 2、Mistral 开源崛起，大模型不再是巨头专利。'
      + '2024年，Sora 用文字生成 60 秒视频，模型开始理解物理世界。'
      + 'Gemini 1.5 Pro 突破百万上下文，模型从读完就忘到记住整本书。'
      + 'GPT-4o 原生多模态，o1 推理模型开辟思考时间越长答案越好的新方向。'
      + 'DeepSeek-V2 和 Mixtral 证明 MoE 效率——更少激活参数，更低成本。'
      + '2025年，DeepSeek-R1 开源推理链，o3-mini 证明高密度推理可在小模型实现。'
      + 'AI 从回答问题进化为完成任务——MCP 协议、Computer Use、Agent 自主工作。'
      + 'GPT-5 和 Claude 4 将推理 Scaling 推向新高度，思考过程可见可控。'
      + '2026年，GPT-5.5 和 5.6 Sol 以更少激活参数定义推理密度新标杆。'
      + 'DeepSeek-V4 开源对标顶级闭源，Gemini 3.5 Flash 百万上下文实时速度。'
      + 'Claude Opus 4.8 安全与能力平衡，Grok 4.5 实时社交风格独树一帜。'
      + 'Agent AI 自主编码企业落地。密度法则取代参数竞赛——大模型成为基础设施。';

    const estimate = estimateNarrationDuration(text);

    expect(estimate.breakdown).toMatchObject({
      cjkCharacters: 375,
      latinWords: 55,
      numericDigits: 73,
    });
    expect(estimate.estimatedSec).toBeGreaterThan(117 * 1.05);
    expect(estimate.estimatedSec).toBeGreaterThanOrEqual(138);
    expect(estimate.estimatedSec).toBeLessThanOrEqual(148);
  });

  it('accounts for requested speech speed without allowing invalid values', () => {
    const text = '这是一个用于时长预估的中文旁白文本';

    expect(estimateNarrationDuration(text, 2).estimatedSec)
      .toBeCloseTo(estimateNarrationDuration(text, 1).estimatedSec / 2, 2);
    expect(estimateNarrationDuration(text, 0).estimatedSec)
      .toBe(estimateNarrationDuration(text, 1).estimatedSec);
  });
});

describe('calibrated narration duration preflight', () => {
  it('uses measured voice pace to make the next revision converge', () => {
    // Production regression: 118 words estimated at 56.96s but synthesized to
    // 68.568s. The 98-word revision was then incorrectly rejected as "short"
    // by the uncalibrated estimate even though this voice would read it in ~58s.
    const durationScale = narrationDurationCalibrationScale({
      genericEstimatedSec: 56.96,
      measuredSec: 68.568,
    });
    expect(durationScale).toBeCloseTo(1.2038, 4);

    const revised = assessEstimatedNarrationFit({
      estimate: {
        estimatedSec: 48.06,
        unit: 'words',
        units: 98,
        unitsPerSec: 2.5,
        breakdown: {
          cjkCharacters: 0,
          latinWords: 98,
          numericDigits: 0,
          numericSeparators: 0,
          majorPauses: 0,
          minorPauses: 0,
          longPauses: 0,
          speechSec: 48.06,
          pauseSec: 0,
        },
      },
      targetSec: 60,
      durationScale: durationScale!,
    });

    expect(revised).toMatchObject({
      status: 'fits',
      genericEstimatedSec: 48.06,
      estimatedSec: 57.85,
      targetSec: 60,
      suggestedUnits: 102,
    });
  });

  it('uses the same delivery band before and after synthesis', () => {
    const estimate = estimateNarrationDuration(Array.from({ length: 150 }, () => 'word').join(' '));
    expect(assessEstimatedNarrationFit({ estimate, targetSec: 60 })?.status).toBe('fits');
    expect(assessEstimatedNarrationFit({
      estimate: { ...estimate, estimatedSec: 60.16 },
      targetSec: 60,
    })?.status).toBe('over');
    expect(assessEstimatedNarrationFit({
      estimate: { ...estimate, estimatedSec: 53.99 },
      targetSec: 60,
    })?.status).toBe('under');
  });
});

describe('measureNarrationUnits', () => {
  it('counts characters for a Chinese line', () => {
    const m = measureNarrationUnits('想要一支会配合的小队吗');
    expect(m.unit).toBe('characters');
    expect(m.units).toBe(11);
  });

  it('counts words for an English line', () => {
    const m = measureNarrationUnits('want a team that actually cooperates');
    expect(m.unit).toBe('words');
    expect(m.units).toBe(6);
  });

  it('treats a Chinese line with AI/agent loanwords as character-counted', () => {
    const m = measureNarrationUnits('你只要跟主 agent 说需求，它就会把子 agent 拉进来');
    expect(m.unit).toBe('characters');
    expect(m.units).toBeGreaterThan(12);
  });
});
