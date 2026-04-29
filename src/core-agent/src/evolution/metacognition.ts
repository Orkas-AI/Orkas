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
  // Look for a "weaknesses" section (or its Chinese equivalent "已知弱点",
  // kept so user-authored COMPETENCE.md from earlier zh-default builds still
  // matches without a migration pass).
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
  const base = 'Based on the conversation digest below, consider improving your skills and self-awareness.\n\n'
    + '**Important: transient errors (network timeouts, dropped connections, rate limits) are environmental issues, not skill or capability deficits. '
    + 'Do not mark them as weaknesses in COMPETENCE.md, do not modify or delete the related skills, '
    + 'and do not advise avoiding the tool in LEARNING_STRATEGIES.md.**\n\n';

  let focus: string;
  switch (primaryFocus) {
    case 'error_recovery':
      focus = 'You recovered from an error during this task. '
            + 'Extract the resolution into a reusable skill, focusing on the non-obvious steps that made recovery succeed.';
      break;
    case 'user_correction':
      focus = 'The user corrected your approach. '
            + 'Identify what you got wrong, then create or update a skill that captures the correct way. '
            + 'Also update COMPETENCE.md to record this weakness.';
      break;
    case 'skill_ineffective':
      focus = 'A skill you loaded did not help on this task. '
            + 'Diagnose why: outdated? too generic? mismatched? '
            + 'Patch or delete the ineffective skill.';
      break;
    case 'known_weakness':
      focus = 'This task hit one of your known weaknesses. '
            + 'Strengthen this area. If you succeeded, update COMPETENCE.md to reflect the progress.';
      break;
    case 'weakness_succeeded':
      focus = 'A capability you previously flagged as a weakness performed normally on this task. '
            + 'Update COMPETENCE.md: remove or downgrade that weakness entry. '
            + 'Do not modify or delete the related skills — they are working as expected.';
      break;
    case 'periodic_review':
      focus = 'Some time has passed since the last reflection — do a periodic review. '
            + 'Look at COMPETENCE.md and LEARNING_STRATEGIES.md: '
            + 'merge similar entries, drop content that no longer applies or is duplicated, '
            + 'and distill recently-recurring stable patterns into new skills. '
            + 'If there is nothing new worth saving, just say "nothing to save" — do not reflect for the sake of reflecting.';
      break;
    case 'complexity':
    default:
      focus = 'This is a complex task. '
            + 'Consider whether any approach or pattern is worth saving as a skill.';
      break;
  }

  const parts = [
    base,
    `**Focus**: ${focus}`,
  ];

  if (conversationDigest) {
    parts.push(
      '',
      '**Conversation digest**:',
      conversationDigest,
    );
  }

  parts.push(
    '',
    '**Current self-assessment (COMPETENCE.md)**:',
    competence || '(No self-assessment yet — consider creating one.)',
    '',
    '**Available learning strategies (LEARNING_STRATEGIES.md)**:',
    strategies || '(No strategy log yet — use your own judgment.)',
  );

  if (skillHealthReport) {
    parts.push('', '**Skill health report**:', skillHealthReport);
  }

  parts.push(
    '',
    'After reflecting, you can:',
    '1. Create / patch / delete skills via the skill_manage tool',
    '2. Update COMPETENCE.md via the metacognition tool',
    '3. Update LEARNING_STRATEGIES.md via the metacognition tool',
    '4. If nothing is worth saving, just say "nothing to save"',
  );

  return parts.join('\n');
}
