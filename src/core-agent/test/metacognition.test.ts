import { describe, it, expect } from 'vitest';
import {
  detectUserCorrection,
  emptyRunMetrics,
  shouldReflect,
  buildAdaptiveReviewPrompt,
} from '../src/evolution/metacognition.js';
import type { RunMetrics, MetacognitionConfig } from '../src/evolution/types.js';

const defaultConfig: MetacognitionConfig = {
  enabled: true,
  reflectThreshold: 0.7,
  competenceCharLimit: 3000,
  strategiesCharLimit: 2500,
};

// ── detectUserCorrection ────────────────────────────────────────────────

describe('detectUserCorrection', () => {
  it('detects Chinese corrections', () => {
    expect(detectUserCorrection('不是这样的')).toBe(true);
    expect(detectUserCorrection('你搞错了')).toBe(true);
    expect(detectUserCorrection('不要这样做')).toBe(true);
    expect(detectUserCorrection('应该是另一种方式')).toBe(true);
    expect(detectUserCorrection('不对，重新来')).toBe(true);
    expect(detectUserCorrection('改一下格式')).toBe(true);
  });

  it('detects English corrections', () => {
    expect(detectUserCorrection('No, that is wrong')).toBe(true);
    expect(detectUserCorrection('Actually, I meant something else')).toBe(true);
    expect(detectUserCorrection('Use X instead')).toBe(true);
    expect(detectUserCorrection("Don't do that"  )).toBe(true);
    expect(detectUserCorrection('Please fix the layout')).toBe(true);
    expect(detectUserCorrection('Stop doing that')).toBe(true);
  });

  it('returns false for normal messages', () => {
    expect(detectUserCorrection('请帮我写一段代码')).toBe(false);
    expect(detectUserCorrection('谢谢你的帮助')).toBe(false);
    expect(detectUserCorrection('Can you help me with this?')).toBe(false);
    expect(detectUserCorrection('Great work!')).toBe(false);
    expect(detectUserCorrection('Tell me about Docker')).toBe(false);
  });
});

// ── emptyRunMetrics ─────────────────────────────────────────────────────

describe('emptyRunMetrics', () => {
  it('creates zeroed metrics including error classification fields', () => {
    const m = emptyRunMetrics();
    expect(m.toolCalls).toBe(0);
    expect(m.toolNames).toEqual([]);
    expect(m.skillsLoaded).toEqual([]);
    expect(m.hadErrors).toBe(false);
    expect(m.recovered).toBe(false);
    expect(m.errorCount).toBe(0);
    expect(m.userCorrections).toBe(0);
    expect(m.errorKind).toBe('none');
    expect(m.transientErrorCount).toBe(0);
  });
});

// ── shouldReflect ───────────────────────────────────────────────────────

describe('shouldReflect', () => {
  it('does not trigger for simple tasks', () => {
    const metrics = emptyRunMetrics();
    metrics.toolCalls = 2;
    const result = shouldReflect(metrics, defaultConfig);
    expect(result.shouldReflect).toBe(false);
    expect(result.signals).toEqual([]);
    expect(result.score).toBe(0);
  });

  it('triggers on error recovery (weight 0.8 >= 0.7) for permanent errors', () => {
    const metrics = emptyRunMetrics();
    metrics.hadErrors = true;
    metrics.recovered = true;
    metrics.errorCount = 1;
    metrics.errorKind = 'permanent';
    const result = shouldReflect(metrics, defaultConfig);
    expect(result.shouldReflect).toBe(true);
    expect(result.primaryFocus).toBe('error_recovery');
    expect(result.score).toBe(0.8);
  });

  it('triggers on user correction (weight 0.9 >= 0.7)', () => {
    const metrics = emptyRunMetrics();
    metrics.userCorrections = 1;
    const result = shouldReflect(metrics, defaultConfig);
    expect(result.shouldReflect).toBe(true);
    expect(result.primaryFocus).toBe('user_correction');
    expect(result.score).toBe(0.9);
  });

  it('does not trigger on complexity alone (weight 0.5 < 0.7)', () => {
    const metrics = emptyRunMetrics();
    metrics.toolCalls = 10;
    const result = shouldReflect(metrics, defaultConfig);
    expect(result.shouldReflect).toBe(false);
    expect(result.signals.length).toBe(1);
    expect(result.signals[0].name).toBe('complexity');
  });

  it('triggers on complexity + error recovery combined', () => {
    const metrics = emptyRunMetrics();
    metrics.toolCalls = 10;
    metrics.hadErrors = true;
    metrics.recovered = true;
    metrics.errorCount = 2;
    metrics.errorKind = 'permanent';
    const result = shouldReflect(metrics, defaultConfig);
    expect(result.shouldReflect).toBe(true);
    // 0.5 (complexity) + 0.8 (error_recovery) = 1.3
    expect(result.score).toBe(1.3);
  });

  it('triggers on skill_ineffective (weight 0.85) for permanent errors', () => {
    const metrics = emptyRunMetrics();
    metrics.skillsLoaded = ['docker-debug'];
    metrics.hadErrors = true;
    metrics.errorCount = 1;
    metrics.errorKind = 'permanent';
    const result = shouldReflect(metrics, defaultConfig);
    expect(result.shouldReflect).toBe(true);
    expect(result.primaryFocus).toBe('skill_ineffective');
  });

  it('respects custom threshold', () => {
    const config = { ...defaultConfig, reflectThreshold: 1.5 };
    const metrics = emptyRunMetrics();
    metrics.userCorrections = 1; // weight 0.9 < 1.5
    const result = shouldReflect(metrics, config);
    expect(result.shouldReflect).toBe(false);
  });

  it('detects known weakness from COMPETENCE.md when errors occurred', () => {
    const metrics = emptyRunMetrics();
    metrics.toolCalls = 3;
    metrics.toolNames = ['bash'];
    metrics.hadErrors = true;
    metrics.errorKind = 'permanent';
    const competence = '## 已知弱点\n- bash 脚本调试能力不足';
    const result = shouldReflect(metrics, defaultConfig, competence);
    expect(result.signals.some(s => s.name === 'known_weakness')).toBe(true);
  });

  it('does not match weakness when competence has no weakness section', () => {
    const metrics = emptyRunMetrics();
    metrics.toolNames = ['bash'];
    const competence = '## 擅长的领域\n- Python 开发';
    const result = shouldReflect(metrics, defaultConfig, competence);
    expect(result.signals.some(s => s.name === 'known_weakness')).toBe(false);
  });

  it('user_correction is highest priority signal', () => {
    const metrics: RunMetrics = {
      toolCalls: 10,
      toolNames: ['bash'],
      skillsLoaded: ['some-skill'],
      hadErrors: true,
      recovered: true,
      errorCount: 1,
      userCorrections: 2,
      errorKind: 'permanent',
      transientErrorCount: 0,
    };
    const result = shouldReflect(metrics, defaultConfig);
    expect(result.primaryFocus).toBe('user_correction');
  });

  it('returns all applicable signals', () => {
    const metrics: RunMetrics = {
      toolCalls: 10,
      toolNames: [],
      skillsLoaded: ['some-skill'],
      hadErrors: true,
      recovered: true,
      errorCount: 1,
      userCorrections: 1,
      errorKind: 'permanent',
      transientErrorCount: 0,
    };
    const result = shouldReflect(metrics, defaultConfig);
    const names = result.signals.map(s => s.name);
    expect(names).toContain('error_recovery');
    expect(names).toContain('user_correction');
    expect(names).toContain('complexity');
    expect(names).toContain('skill_ineffective');
  });

  // ── Transient error gating ──────────────────────────────────────────

  it('does not trigger skill_ineffective on purely transient errors', () => {
    const metrics: RunMetrics = {
      toolCalls: 3,
      toolNames: ['web_search'],
      skillsLoaded: ['search-helper'],
      hadErrors: true,
      recovered: true,
      errorCount: 2,
      userCorrections: 0,
      errorKind: 'transient',
      transientErrorCount: 2,
    };
    const result = shouldReflect(metrics, defaultConfig);
    expect(result.signals.some(s => s.name === 'skill_ineffective')).toBe(false);
  });

  it('does not trigger error_recovery on purely transient errors', () => {
    const metrics: RunMetrics = {
      toolCalls: 3,
      toolNames: ['web_search'],
      skillsLoaded: [],
      hadErrors: true,
      recovered: true,
      errorCount: 1,
      userCorrections: 0,
      errorKind: 'transient',
      transientErrorCount: 1,
    };
    const result = shouldReflect(metrics, defaultConfig);
    expect(result.signals.some(s => s.name === 'error_recovery')).toBe(false);
  });

  it('reduces weight to 0.3 for skill_ineffective on mixed errors', () => {
    const metrics: RunMetrics = {
      toolCalls: 3,
      toolNames: ['web_search'],
      skillsLoaded: ['search-helper'],
      hadErrors: true,
      recovered: true,
      errorCount: 3,
      userCorrections: 0,
      errorKind: 'mixed',
      transientErrorCount: 2,
    };
    const result = shouldReflect(metrics, defaultConfig);
    const si = result.signals.find(s => s.name === 'skill_ineffective');
    expect(si).toBeDefined();
    expect(si!.weight).toBe(0.3);
  });

  it('reduces weight to 0.3 for error_recovery on mixed errors', () => {
    const metrics: RunMetrics = {
      toolCalls: 3,
      toolNames: ['web_search'],
      skillsLoaded: [],
      hadErrors: true,
      recovered: true,
      errorCount: 3,
      userCorrections: 0,
      errorKind: 'mixed',
      transientErrorCount: 2,
    };
    const result = shouldReflect(metrics, defaultConfig);
    const er = result.signals.find(s => s.name === 'error_recovery');
    expect(er).toBeDefined();
    expect(er!.weight).toBe(0.3);
  });

  // ── weakness_succeeded (positive recovery) ────��────────────────────

  it('triggers weakness_succeeded when known weakness hit but no errors', () => {
    const metrics = emptyRunMetrics();
    metrics.toolCalls = 3;
    metrics.toolNames = ['bash'];
    const competence = '## 已知弱点\n- bash 脚本调试能力不足';
    const result = shouldReflect(metrics, defaultConfig, competence);
    expect(result.signals.some(s => s.name === 'weakness_succeeded')).toBe(true);
    expect(result.signals.some(s => s.name === 'known_weakness')).toBe(false);
    expect(result.shouldReflect).toBe(true);
    expect(result.primaryFocus).toBe('weakness_succeeded');
  });

  it('does not trigger weakness_succeeded when errors occurred', () => {
    const metrics = emptyRunMetrics();
    metrics.toolCalls = 3;
    metrics.toolNames = ['bash'];
    metrics.hadErrors = true;
    metrics.errorKind = 'permanent';
    const competence = '## 已知弱点\n- bash 脚本调试能力不足';
    const result = shouldReflect(metrics, defaultConfig, competence);
    expect(result.signals.some(s => s.name === 'known_weakness')).toBe(true);
    expect(result.signals.some(s => s.name === 'weakness_succeeded')).toBe(false);
  });
});

// ── buildAdaptiveReviewPrompt ───────────────────────────────────────────

describe('buildAdaptiveReviewPrompt', () => {
  it('builds error_recovery focused prompt', () => {
    const prompt = buildAdaptiveReviewPrompt('error_recovery', '', '');
    expect(prompt).toContain('从错误中恢复');
    expect(prompt).toContain('skill_manage');
    expect(prompt).toContain('metacognition');
  });

  it('builds user_correction focused prompt', () => {
    const prompt = buildAdaptiveReviewPrompt('user_correction', '', '');
    expect(prompt).toContain('纠正');
    expect(prompt).toContain('COMPETENCE');
  });

  it('builds skill_ineffective focused prompt', () => {
    const prompt = buildAdaptiveReviewPrompt('skill_ineffective', '', '');
    expect(prompt).toContain('没有帮到');
    expect(prompt).toContain('修补或删除');
  });

  it('builds known_weakness focused prompt', () => {
    const prompt = buildAdaptiveReviewPrompt('known_weakness', '', '');
    expect(prompt).toContain('已知弱点');
    expect(prompt).toContain('加强');
  });

  it('builds complexity default prompt', () => {
    const prompt = buildAdaptiveReviewPrompt('complexity', '', '');
    expect(prompt).toContain('复杂');
  });

  it('includes competence content', () => {
    const prompt = buildAdaptiveReviewPrompt('complexity', '我擅长 Python', '');
    expect(prompt).toContain('我擅长 Python');
    expect(prompt).not.toContain('尚无自我评估');
  });

  it('shows placeholder when no competence', () => {
    const prompt = buildAdaptiveReviewPrompt('complexity', '', '');
    expect(prompt).toContain('尚无自我评估');
  });

  it('includes strategies content', () => {
    const prompt = buildAdaptiveReviewPrompt('complexity', '', '错误提取法');
    expect(prompt).toContain('错误提取法');
    expect(prompt).not.toContain('尚无策略记录');
  });

  it('includes skill health report when provided', () => {
    const report = '- docker-debug: effectiveness 0.83, healthy';
    const prompt = buildAdaptiveReviewPrompt('complexity', '', '', report);
    expect(prompt).toContain('技能健康度报告');
    expect(prompt).toContain('docker-debug');
  });

  it('omits skill health section when not provided', () => {
    const prompt = buildAdaptiveReviewPrompt('complexity', '', '');
    expect(prompt).not.toContain('技能健康度报告');
  });

  it('includes conversation digest when provided', () => {
    const digest = '使用的工具: bash, read_file\n加载的技能: docker-debug\n--- 对话最终回复 ---\n修复了 Docker 容器无法启动的问题';
    const prompt = buildAdaptiveReviewPrompt('error_recovery', '', '', undefined, digest);
    expect(prompt).toContain('docker-debug');
    expect(prompt).toContain('Docker 容器');
    expect(prompt).toContain('对话最终回复');
  });

  it('omits conversation digest content when not provided', () => {
    const prompt = buildAdaptiveReviewPrompt('complexity', '', '');
    expect(prompt).not.toContain('对话最终回复');
  });

  it('builds weakness_succeeded focused prompt', () => {
    const prompt = buildAdaptiveReviewPrompt('weakness_succeeded', '', '');
    expect(prompt).toContain('表现正常');
    expect(prompt).toContain('移除或降级');
    expect(prompt).toContain('不要修改或删除相关技能');
  });

  it('includes transient error guidance in all prompts', () => {
    const prompt = buildAdaptiveReviewPrompt('complexity', '', '');
    expect(prompt).toContain('瞬态错误是环境问题');
    expect(prompt).toContain('不要在 COMPETENCE.md 标记为弱点');
  });
});
