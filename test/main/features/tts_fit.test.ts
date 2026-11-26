import { describe, expect, it } from 'vitest';

import {
  assessEstimatedNarrationFit,
  assessNarrationFit,
  estimateNarrationDuration,
  measureNarrationUnits,
  narrationDurationCalibrationScale,
  narrationFitBlocksProduction,
} from '../../../src/main/features/tts';

/** A neutral estimate whose estimatedSec each case overrides, so a band case
 *  reads as the one duration under test rather than as a script to decode. */
const estimateStub = {
  estimatedSec: 1,
  unit: 'characters' as const,
  units: 24,
  unitsPerSec: 4,
  breakdown: {
    cjkCharacters: 24,
    thaiCharacters: 0,
    latinWords: 0,
    otherWords: 0,
    numericDigits: 0,
    numericSeparators: 0,
    majorPauses: 0,
    minorPauses: 0,
    longPauses: 0,
    speechSec: 6,
    pauseSec: 0,
  },
};

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

  it('asks for a longer line to the same file when a narration is short, not an early finish', () => {
    expect(assessNarrationFit({ measuredSec: 16.25, targetSec: 23.9, wordCount: 41 })!.message).toBe(
      'Narration is 16.25s, 7.65s shorter than the 23.9s clip — that much of the clip will have no narration. '
      + 'To fill it, add ~19 words and generate the line once more to the same output_path.',
    );
    // 40 characters read in 9.2s fill a 15s clip with about 25 more.
    expect(assessNarrationFit({ measuredSec: 9.2, targetSec: 15, wordCount: 40, unit: 'characters' })!.message)
      .toContain('To fill it, add ~25 characters and generate the line once more to the same output_path.');
  });

  it('stops asking for another take once a short line has been filled twice, and leaves long and fitting lines alone', () => {
    expect(assessNarrationFit({ measuredSec: 9.2, targetSec: 15, wordCount: 40, unit: 'characters', fillLimitReached: true })!.message).toBe(
      'Narration is 9.2s, 5.8s shorter than the 15s clip — that much of the clip will have no narration. '
      + 'This line has already been generated again twice this turn, the limit: keep this audio and let the scene finish early.',
    );
    for (const measuredSec of [30, 23.9]) {
      expect(assessNarrationFit({ measuredSec, targetSec: 23.9, wordCount: 60, fillLimitReached: true })!.message)
        .toBe(assessNarrationFit({ measuredSec, targetSec: 23.9, wordCount: 60 })!.message);
    }
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
    // Within 10% of the measured 140.9s, the error accepted for Chinese (2026-11-15).
    expect(estimate.estimatedSec / 140.9).toBeGreaterThan(0.9);
    expect(estimate.estimatedSec / 140.9).toBeLessThan(1.1);
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

  it('uses the symmetric five-second floor before classifying an early read', () => {
    const shortForTheClip = assessEstimatedNarrationFit({
      estimate: { ...estimateStub, estimatedSec: 1.99 },
      targetSec: 7,
    });

    expect(shortForTheClip?.status).toBe('under');
    expect(shortForTheClip?.suggestedUnits).toBeGreaterThan(estimateStub.units);
    expect(shortForTheClip).toMatchObject({
      toleranceRatio: 0.05,
      toleranceFloorSec: 5,
      toleranceSec: 5,
      minDurationSec: 2,
      maxDurationSec: 12,
    });
    expect(narrationFitBlocksProduction(shortForTheClip!.status)).toBe(true);
    expect(narrationFitBlocksProduction('fits')).toBe(false);
    expect(narrationFitBlocksProduction('over')).toBe(true);
  });

  it('uses plus-or-minus five percent with a minimum five-second tolerance', () => {
    const at = (estimatedSec: number, targetSec: number) => assessEstimatedNarrationFit({
      estimate: { ...estimateStub, estimatedSec },
      targetSec,
    });

    expect(at(40, 45)?.status).toBe('fits');
    expect(at(50, 45)?.status).toBe('fits');
    expect(at(39.99, 45)?.status).toBe('under');
    expect(at(50.01, 45)?.status).toBe('over');
    expect(at(190, 200)).toMatchObject({ status: 'fits', toleranceSec: 10 });
    expect(at(210, 200)).toMatchObject({ status: 'fits', toleranceSec: 10 });
    expect(at(210.01, 200)?.status).toBe('over');
  });

  it('keeps the calibrated estimate honest at the widened boundary', () => {
    // A measured-calibration scale must be applied before the band, or the
    // widened tolerance would silently absorb a voice that reads 20% slow.
    const scaled = assessEstimatedNarrationFit({
      estimate: { ...estimateStub, estimatedSec: 55 },
      targetSec: 60,
      durationScale: 1.2,
    });

    expect(scaled?.estimatedSec).toBe(66);
    expect(scaled?.maxDurationSec).toBe(65);
    expect(scaled?.status).toBe('over');
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

// Scripts and median durations are from live managed-voice synthesis across
// every voice of each language (2026-11-03). Latin-only word matching read a
// Vietnamese line as 2.97x its real length and Russian, Arabic and Thai as under
// 10%, and the delivery band blocks both sides before synthesis.
describe('estimateNarrationDuration across managed-voice languages', () => {
  const measured: Array<[string, string, number]> = [
    ['pt', 'Nosso novo aplicativo já está disponível. Organize suas finanças em um só lugar, acompanhe seus gastos e alcance suas metas com mais tranquilidade.', 10.25],
    ['fr', 'Notre nouvelle application est disponible. Gérez vos finances au même endroit, suivez vos dépenses et atteignez vos objectifs plus sereinement.', 8.42],
    ['es', 'Nuestra nueva aplicación ya está disponible. Gestiona tus finanzas en un solo lugar, controla tus gastos y alcanza tus objetivos con más tranquilidad.', 9.13],
    ['es-MX', 'Nuestra nueva aplicación ya está disponible. Administra tus finanzas en un solo lugar, revisa tus gastos y alcanza tus metas con más tranquilidad.', 10.03],
    ['de', 'Unsere neue App ist jetzt verfügbar. Verwalten Sie Ihre Finanzen an einem Ort, behalten Sie Ihre Ausgaben im Blick und erreichen Sie Ihre Ziele entspannter.', 11.56],
    ['it', 'La nostra nuova applicazione è ora disponibile. Gestisci le tue finanze in un unico posto, controlla le spese e raggiungi i tuoi obiettivi con più serenità.', 11.09],
    ['id', 'Aplikasi baru kami sudah tersedia. Kelola keuangan Anda di satu tempat, pantau pengeluaran, dan capai tujuan Anda dengan lebih tenang.', 8.83],
    ['vi', 'Ứng dụng mới của chúng tôi đã sẵn sàng. Hãy quản lý tài chính ở một nơi, theo dõi chi tiêu và đạt được mục tiêu một cách nhẹ nhàng hơn.', 6.96],
    ['ko', '새로운 앱이 출시되었습니다. 한곳에서 재정을 관리하고 지출을 확인하면서 목표를 더 편안하게 달성해 보세요.', 9.14],
    ['ja', '新しいアプリが登場しました。お金の管理を一か所にまとめて、支出を確認しながら、目標を無理なく達成しましょう。', 10.27],
    ['ru', 'Наше новое приложение уже доступно. Управляйте финансами в одном месте, следите за расходами и достигайте целей спокойнее.', 8.66],
    ['ar', 'تطبيقنا الجديد متاح الآن. أدر أموالك في مكان واحد، وتابع نفقاتك، وحقق أهدافك بكل سهولة وراحة.', 10.08],
    ['th', 'แอปใหม่ของเราพร้อมใช้งานแล้ว จัดการการเงินได้ในที่เดียว ติดตามค่าใช้จ่าย และบรรลุเป้าหมายได้อย่างสบายใจ', 8.74],
  ];

  it.each(measured)('stays within the estimator tolerance of measured %s audio', (_language, script, seconds) => {
    const ratio = estimateNarrationDuration(script).estimatedSec / seconds;
    expect(ratio).toBeGreaterThan(0.8);
    expect(ratio).toBeLessThan(1.2);
  });

  it.each(measured)('does not misjudge a %s line that fits its measured length', (_language, script, seconds) => {
    expect(assessEstimatedNarrationFit({
      estimate: estimateNarrationDuration(script),
      targetSec: seconds,
    })?.status).toBe('fits');
  });

  // Managed Chinese voices measured 2026-11-15: voice, script, seconds.
  const chinese: Array<[string, string, number]> = [
    ['zh_female_vv_uranus_bigtts', '调料瓶总是挤成一堆？试试这款旋转调料盒，轻轻一转，常用的那瓶就到手边，做饭再也不用翻来翻去。', 9.07],
    ['zh_female_vv_uranus_bigtts', '打开设置页面，先点右上角的头像，再选择账号与安全，就能看到修改密码的入口，按提示操作就行。', 9.22],
    ['zh_female_vv_uranus_bigtts', '那天晚上下着大雨，他一个人站在车站门口，手里攥着那张旧车票，犹豫了很久，始终没有走进去。', 8.66],
    ['zh_male_jieshuoxiaoming_uranus_bigtts', '很多人以为跑步伤膝盖，其实只要控制好步频和落地方式，适量跑步反而能让关节变得更加灵活。', 8.45],
    ['zh_male_cixingjieshuonan_uranus_bigtts', '这座大桥全长三十多公里，从开工到通车整整用了九年，它让两座城市之间的车程缩短到半小时。', 11.86],
    ['zh_male_xuanyijieshuo_uranus_bigtts', '三年后两人在医院重逢，她早已认不出他，而他只是笑了笑，把那封信悄悄放回了外套的口袋里。', 9.05],
    ['zh_female_liuchangnv_uranus_bigtts', '分格设计容量大，酱油、醋、盐和胡椒都能各归其位，台面一下子清爽了不少，承重也足够稳当。', 8.83],
    ['zh_female_shuangkuaisisi_uranus_bigtts', '现在下单只要39.9元，还送两个备用调料瓶，库存不多了，喜欢的朋友赶紧点击下方的链接下单吧。', 8.04],
    ['zh_male_m191_uranus_bigtts', '今天带大家看看这家开了二十年的老面馆，汤底每天凌晨四点开始熬，一碗面只要十五块钱就能吃饱。', 7.63],
    ['zh_female_kailangjiejie_uranus_bigtts', '周末我们来到海边的小镇，街上到处是卖海鲜的小摊，随便找一家坐下来，就能吃到当天的渔获。', 8.45],
  ];

  it('stays within 10% of measured managed Chinese voices, and closer for the default voice', () => {
    const ratios = chinese.map(([, script, seconds]) => estimateNarrationDuration(script).estimatedSec / seconds).sort((a, b) => a - b);
    const median = (ratios[4] + ratios[5]) / 2;
    expect(median).toBeGreaterThan(0.9);
    expect(median).toBeLessThan(1.1);
    for (const [voice, script, seconds] of chinese.filter(([voice]) => voice === 'zh_female_vv_uranus_bigtts')) {
      const ratio = estimateNarrationDuration(script).estimatedSec / seconds;
      expect(ratio, voice).toBeGreaterThan(0.9);
      expect(ratio, voice).toBeLessThan(1.15);
    }
  });

  it('keeps the Chinese and English rates', () => {
    // 18 Han characters at 4.5 per second, one comma (0.12s) and one full stop (0.28s).
    expect(estimateNarrationDuration('这是一条测试旁白，确认时长估算没有变化。')).toMatchObject({
      estimatedSec: 4.4,
      unit: 'characters',
      units: 18,
      unitsPerSec: 4.5,
    });
    expect(estimateNarrationDuration('White ceramic, a blue wave, and room for 350 mL of coffee or tea.')).toMatchObject({
      estimatedSec: 6.26,
      unit: 'words',
      unitsPerSec: 2.5,
    });
  });

  it('counts an accented word once however it is encoded', () => {
    const composed = estimateNarrationDuration('Não há complicação');
    const decomposed = estimateNarrationDuration('Não há complicação'.normalize('NFD'));
    expect(composed.breakdown.latinWords).toBe(3);
    expect(decomposed).toEqual(composed);
  });

  it('does not treat accented European Latin as Vietnamese', () => {
    const french = estimateNarrationDuration('Découvrez la création française dès aujourd’hui avec élégance');
    expect(french.unitsPerSec).toBe(2.5);
  });

  it('does not read emoji variation selectors or symbols as words', () => {
    expect(estimateNarrationDuration('Great news ❤️ 350 µm').breakdown.otherWords).toBe(0);
  });

  it('budgets a spaceless Thai line in characters', () => {
    const measuredUnits = measureNarrationUnits('แอปใหม่ของเราพร้อมใช้งานแล้ว');
    expect(measuredUnits.unit).toBe('characters');
    expect(measuredUnits.units).toBeGreaterThan(20);
  });
});
