import { describe, it, expect } from 'vitest';
import {
  detectUserCorrection,
  emptyRunMetrics,
  shouldReflect,
  buildReviewPrompt,
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

// ── buildReviewPrompt ───────────────────────────────────────────────────

describe('buildReviewPrompt', () => {
  it('renders the transcript section with content when provided', () => {
    const transcript = '## Activity since 2026-05-19 14:00\n\n### c001\n[14:23 user]\nq';
    const prompt = buildReviewPrompt('', '', transcript);
    expect(prompt).toContain('Activity transcript');
    expect(prompt).toContain('14:23 user');
  });

  it('shows placeholder when transcript is empty', () => {
    const prompt = buildReviewPrompt('', '', '');
    expect(prompt).toContain('No new activity in the window');
  });

  it('includes competence content', () => {
    const prompt = buildReviewPrompt('I am strong at Python', '', '');
    expect(prompt).toContain('I am strong at Python');
    expect(prompt).not.toContain('No self-assessment yet');
  });

  it('shows placeholder when no competence', () => {
    const prompt = buildReviewPrompt('', '', '');
    expect(prompt).toContain('No self-assessment yet');
  });

  it('includes strategies content', () => {
    const prompt = buildReviewPrompt('', 'Error extraction pattern', '');
    expect(prompt).toContain('Error extraction pattern');
    expect(prompt).not.toContain('No strategy log yet');
  });

  it('always includes transient-error guidance (preserved invariant)', () => {
    const prompt = buildReviewPrompt('', '', '');
    expect(prompt).toContain('transient errors');
    expect(prompt).toContain('Do not mark them as weaknesses in COMPETENCE.md');
  });

  it('always offers the four post-reflection actions', () => {
    const prompt = buildReviewPrompt('', '', '');
    expect(prompt).toContain('skill_manage tool');
    expect(prompt).toContain('metacognition tool');
    expect(prompt).toMatch(/nothing to save/i);
  });

  it('directs LLM to look for user preferences + domain constraints', () => {
    const prompt = buildReviewPrompt('', '', '');
    // Plan §2.3: prompt should nudge LLM to extract red lines / edits / etc.
    expect(prompt).toMatch(/user preferences|domain constraints|red lines/i);
  });

  it('directs LLM to write imperatives, not descriptions', () => {
    // Plan §9.x: prose injection of COMPETENCE/STRATEGIES is too soft unless
    // entries are written as actionable rules with trigger conditions.
    const prompt = buildReviewPrompt('', '', '');
    expect(prompt).toContain('Writing style');
    // The NEVER / ALWAYS / WHEN-THEN formula is the load-bearing instruction.
    expect(prompt).toMatch(/NEVER\s*\/\s*ALWAYS\s*\/\s*WHEN-THEN/);
    // Concrete bad/good pair is the second load-bearing piece.
    expect(prompt).toMatch(/✗.*✓/s);
  });

  it('overrides skill_manage tool\'s "confirm with user" default for reflection', () => {
    // skill_manage tool description says "Confirm with user before creating
    // or deleting" — written for live turns. Without an explicit override
    // here, reflection LLM gets inhibited and never creates skills. See
    // reflection-redesign plan: skill-creation soft pitfall 1.
    const prompt = buildReviewPrompt('', '', '');
    expect(prompt).toMatch(/no user confirmation needed|does NOT need user confirmation/i);
  });

  it('extends Writing style guidance to the skill description field', () => {
    // The description field is the ONLY thing the next-turn agent sees
    // before deciding to load a skill — vague descriptions make the skill
    // effectively dead. Soft pitfall 2 in reflection-redesign plan.
    const prompt = buildReviewPrompt('', '', '');
    expect(prompt).toMatch(/description.*field|`description`/i);
    expect(prompt).toMatch(/WHEN to use/i);
  });
});
