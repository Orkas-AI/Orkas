/**
 * Metacognitive self-improvement — experience-driven adaptive evolution.
 *
 * Replaces the fixed counter-based nudge mechanism with a multi-signal
 * trigger that considers error recovery, user corrections, task complexity,
 * known weaknesses, and skill effectiveness.
 *
 * The review prompt is dynamically generated based on the trigger reason,
 * the agent's self-assessment (COMPETENCE.md), and available learning
 * strategies (LEARNING_STRATEGIES.md).
 */

import type {
  RunMetrics,
  TriggerSignal,
  MetacognitiveReflection,
  MetacognitionConfig,
} from "./types.js";
import { createLogger } from "../shared/logger.js";

const log = createLogger("metacognition");

// ── User correction detection (heuristic, no LLM cost) ─────────────────

const CORRECTION_PATTERNS_ZH = [
  /不[是对要]/, /错了/, /不要这样/, /应该是/, /你搞错/,
  /不对/, /改一下/, /重新/, /别这样/, /换个/,
];

const CORRECTION_PATTERNS_EN = [
  /\bno[,.]?\s+(it|that|the|this|you)\b/i,
  /\bwrong\b/i,
  /\bactually\b/i,
  /\binstead\b/i,
  /\bdon'?t\s+do\b/i,
  /\bstop\s+(doing|that)\b/i,
  /\bnot\s+what\s+I\b/i,
  /\bplease\s+(fix|change|redo)\b/i,
];

const ALL_CORRECTION_PATTERNS = [...CORRECTION_PATTERNS_ZH, ...CORRECTION_PATTERNS_EN];

/**
 * Heuristic detection of user corrections in a message.
 * Returns true if the message likely contains a correction or complaint.
 * False positives are acceptable — this is a signal, not a classifier.
 */
export function detectUserCorrection(userMessage: string): boolean {
  return ALL_CORRECTION_PATTERNS.some(re => re.test(userMessage));
}

// ── RunMetrics factory ──────────────────────────────────────────────────

/** Create a fresh RunMetrics with all counters zeroed. */
export function emptyRunMetrics(): RunMetrics {
  return {
    toolCalls: 0,
    toolNames: [],
    skillsLoaded: [],
    hadErrors: false,
    recovered: false,
    errorCount: 0,
    userCorrections: 0,
    errorKind: 'none',
    transientErrorCount: 0,
  };
}

// ── Multi-signal trigger ────────────────────────────────────────────────

/**
 * Evaluate whether a completed run warrants metacognitive reflection.
 *
 * Uses weighted signals instead of a fixed counter threshold.
 * When COMPETENCE.md content is provided, additional signals
 * (known weakness matching) become available.
 *
 * @param metrics  Collected run metrics
 * @param config   Metacognition config (threshold, etc.)
 * @param competence  Current COMPETENCE.md content (optional)
 */
export function shouldReflect(
  metrics: RunMetrics,
  config: MetacognitionConfig,
  competence?: string,
): MetacognitiveReflection {
  const signals: TriggerSignal[] = [];

  // Signal 1: Error recovery (failure = best learning opportunity)
  // Gate: recovering from purely transient errors is normal, not worth reflecting on.
  if (metrics.hadErrors && metrics.recovered && metrics.errorKind !== 'transient') {
    signals.push({
      name: 'error_recovery',
      weight: metrics.errorKind === 'mixed' ? 0.3 : 0.8,
      reason: `Recovered from ${metrics.errorCount} error(s)`,
    });
  }

  // Signal 2: User corrections (direct feedback, highest priority)
  if (metrics.userCorrections > 0) {
    signals.push({
      name: 'user_correction',
      weight: 0.9,
      reason: `User corrected approach ${metrics.userCorrections} time(s)`,
    });
  }

  // Signal 3: Task complexity (many tool calls = worth capturing)
  if (metrics.toolCalls > 8) {
    signals.push({
      name: 'complexity',
      weight: 0.5,
      reason: `Complex task with ${metrics.toolCalls} tool calls`,
    });
  }

  // Signal 4: Known weakness hit (from COMPETENCE.md)
  if (competence && hitsKnownWeakness(metrics, competence)) {
    if (metrics.hadErrors) {
      signals.push({
        name: 'known_weakness',
        weight: 0.7,
        reason: 'Task overlaps with a known weakness area',
      });
    } else {
      // Signal 6: Previously marked weakness succeeded — trigger positive update.
      signals.push({
        name: 'weakness_succeeded',
        weight: 0.75,
        reason: 'Task overlaps with a known weakness but completed without errors',
      });
    }
  }

  // Signal 5: Skill used but ineffective
  // Gate: transient errors (network, rate-limit) are not the skill's fault.
  if (metrics.skillsLoaded.length > 0 && metrics.hadErrors && metrics.errorKind !== 'transient') {
    signals.push({
      name: 'skill_ineffective',
      weight: metrics.errorKind === 'mixed' ? 0.3 : 0.85,
      reason: `Skill(s) loaded but task had errors: ${metrics.skillsLoaded.join(', ')}`,
    });
  }

  const score = signals.reduce((sum, s) => sum + s.weight, 0);
  const trigger = signals.length > 0 && score >= config.reflectThreshold;
  const primaryFocus = signals.length > 0
    ? signals.sort((a, b) => b.weight - a.weight)[0].name
    : '';

  if (signals.length > 0) {
    const signalSummary = signals.map(s => `${s.name}(${s.weight})`).join(', ');
    if (trigger) {
      log.info(`reflect=YES score=${score.toFixed(2)} threshold=${config.reflectThreshold} focus=${primaryFocus} signals=[${signalSummary}] errorKind=${metrics.errorKind}`);
    } else {
      log.debug(`reflect=NO score=${score.toFixed(2)} threshold=${config.reflectThreshold} signals=[${signalSummary}] errorKind=${metrics.errorKind}`);
    }
  }

  return { shouldReflect: trigger, signals, primaryFocus, score };
}

/**
 * Check if the current run's tool usage overlaps with known weaknesses
 * listed in COMPETENCE.md. Simple keyword matching.
 */
function hitsKnownWeakness(metrics: RunMetrics, competence: string): boolean {
  // Look for a "已知弱点" or "weaknesses" section in competence
  const weaknessSection = extractSection(competence, ['已知弱点', 'weaknesses', 'weak']);
  if (!weaknessSection) return false;

  // Check if any tool names or error context overlaps
  const lower = weaknessSection.toLowerCase();
  for (const toolName of metrics.toolNames) {
    // Simplistic: if competence mentions the tool name as a weakness area
    if (lower.includes(toolName.toLowerCase())) return true;
  }
  return false;
}

/** Extract a markdown section by heading keyword. */
function extractSection(text: string, headingKeywords: string[]): string | null {
  const lines = text.split('\n');
  let capture = false;
  const captured: string[] = [];

  for (const line of lines) {
    if (line.startsWith('#')) {
      if (capture) break; // Next heading → stop
      const lower = line.toLowerCase();
      if (headingKeywords.some(k => lower.includes(k))) {
        capture = true;
        continue;
      }
    }
    if (capture) captured.push(line);
  }

  return captured.length > 0 ? captured.join('\n').trim() : null;
}

// ── Adaptive review prompt generation ───────────────────────────────────

/**
 * Build a review prompt tailored to the trigger reason, the agent's
 * self-assessment, and available learning strategies.
 *
 * @param primaryFocus     Trigger reason (error_recovery, user_correction, etc.)
 * @param competence       Current COMPETENCE.md content
 * @param strategies       Current LEARNING_STRATEGIES.md content
 * @param skillHealthReport  Optional skill health report
 * @param conversationDigest  Summary of what happened in the conversation
 */
export function buildAdaptiveReviewPrompt(
  primaryFocus: string,
  competence: string,
  strategies: string,
  skillHealthReport?: string,
  conversationDigest?: string,
): string {
  const base = '根据以下对话摘要，考虑改进你的技能和自我认知。\n\n'
    + '**重要：网络超时、连接中断、速率限制等瞬态错误是环境问题，不是技能或能力缺陷。'
    + '遇到这类错误时不要在 COMPETENCE.md 标记为弱点，不要修改或删除相关技能，'
    + '不要在 LEARNING_STRATEGIES.md 建议回避该工具。**\n\n';

  let focus: string;
  switch (primaryFocus) {
    case 'error_recovery':
      focus = '你在这个任务中从错误中恢复了。'
            + '请把解决方法提取为可复用的技能，重点记录让恢复成功的非显而易见的步骤。';
      break;
    case 'user_correction':
      focus = '用户纠正了你的做法。'
            + '请识别你做错了什么，创建/更新技能来记录正确的做法。'
            + '同时更新 COMPETENCE.md 记录这个弱点。';
      break;
    case 'skill_ineffective':
      focus = '你加载的技能没有帮到这个任务。'
            + '分析原因：技能过时了？太泛化？还是不匹配？'
            + '请修补或删除无效的技能。';
      break;
    case 'known_weakness':
      focus = '这个任务命中了你的已知弱点。'
            + '重点加强这个领域。如果你成功了，更新 COMPETENCE.md 反映进步。';
      break;
    case 'weakness_succeeded':
      focus = '你之前标记为弱点的能力在这次任务中表现正常。'
            + '请更新 COMPETENCE.md：移除或降级该弱点条目。'
            + '不要修改或删除相关技能——它们工作正常。';
      break;
    case 'periodic_review':
      focus = '距离上次反思已经过了一段时间，做一次定期回顾。'
            + '查看 COMPETENCE.md 和 LEARNING_STRATEGIES.md：'
            + '合并相近条目、删除已经不再适用或重复的内容、'
            + '把近期反复出现的稳定模式提炼成新技能。'
            + '如果近期没有新的可保存内容，直接说"无需保存"，不要为了反思而反思。';
      break;
    case 'complexity':
    default:
      focus = '这是一个复杂的任务。'
            + '考虑是否有值得保存为技能的方法或模式。';
      break;
  }

  const parts = [
    base,
    `**重点**: ${focus}`,
  ];

  if (conversationDigest) {
    parts.push(
      '',
      '**对话摘要**:',
      conversationDigest,
    );
  }

  parts.push(
    '',
    '**当前自我评估 (COMPETENCE.md)**:',
    competence || '（尚无自我评估 — 请考虑创建一份。）',
    '',
    '**可用学习策略 (LEARNING_STRATEGIES.md)**:',
    strategies || '（尚无策略记录 — 请自行判断。）',
  );

  if (skillHealthReport) {
    parts.push('', '**技能健康度报告**:', skillHealthReport);
  }

  parts.push(
    '',
    '反思完成后，你可以：',
    '1. 通过 skill_manage 工具创建/修补/删除技能',
    '2. 通过 metacognition 工具更新 COMPETENCE.md',
    '3. 通过 metacognition 工具更新 LEARNING_STRATEGIES.md',
    '4. 如果没有值得保存的内容，直接说"无需保存"',
  );

  return parts.join('\n');
}
