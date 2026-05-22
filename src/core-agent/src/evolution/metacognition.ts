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

// ── Review prompt generation ────────────────────────────────────────────

/**
 * Build the reflection LLM prompt for one agent over a recent activity
 * transcript.
 *
 * Single open-ended prompt (no `primaryFocus` branching) per
 * `docs/plans/reflection-redesign.md` §2.3 — the LLM reads the transcript
 * and decides what's worth saving. Eliminating the 7-case switch removes
 * a window-aggregation ambiguity (multi-focus runs would need contradictory
 * directives) and keeps the system prompt cache-stable across calls.
 *
 * @param competence    Current COMPETENCE.md content (capped 3000 chars by the meta tool)
 * @param strategies    Current LEARNING_STRATEGIES.md content (capped 4000 chars)
 * @param transcript    Activity transcript from `reflection-transcript.buildTranscript`
 */
export function buildReviewPrompt(
  competence: string,
  strategies: string,
  transcript: string,
): string {
  const base = 'Based on the activity transcript below, review and update your self-understanding.\n\n'
    + '**Important: transient errors (network timeouts, dropped connections, rate limits) are environmental issues, not skill or capability deficits. '
    + 'Do not mark them as weaknesses in COMPETENCE.md, do not modify or delete the related skills, '
    + 'and do not advise avoiding the tool in LEARNING_STRATEGIES.md.**\n\n';

  const focus = 'Look at COMPETENCE.md and LEARNING_STRATEGIES.md: '
    + 'merge similar entries, drop content that no longer applies or is duplicated, '
    + 'and distill recently-recurring stable patterns into new skills. '
    + 'Identify user preferences and domain constraints surfaced in this window — '
    + 'red lines the user revealed, edits made to your draft, repeated corrections, '
    + 'workflow preferences. '
    + 'If there is nothing new worth saving, just say "nothing to save" — '
    + 'do not reflect for the sake of reflecting.';

  // Imperative writing guidance — prose injection of COMPETENCE/STRATEGIES
  // into the runtime system prompt is a weak nudge unless entries are written
  // as actionable rules anchored to trigger conditions. Without this section
  // reflection tends to produce vague descriptions ("agent should be careful
  // about X") that the agent reliably ignores. See docs/plans/reflection-redesign.md §9.
  const writingStyle = 'When you update COMPETENCE.md / LEARNING_STRATEGIES.md or '
    + 'author a skill, write actionable imperatives — not descriptions.\n'
    + '  ✗ "Agent should be careful about overly verbose output."\n'
    + '  ✓ "NEVER exceed 5 bullet points in family-office context replies."\n'
    + '  ✗ "User seems to prefer concise output."\n'
    + '  ✓ "WHEN replying to family-office context, ALWAYS lead with the '
    + 'bottom-line answer before rationale."\n'
    + 'Use NEVER / ALWAYS / WHEN-THEN structures with concrete trigger conditions.\n'
    + 'For a new skill\'s `description` field specifically: one imperative line '
    + 'stating WHEN to use the skill, not what it is about (the description is '
    + 'the only thing the next turn\'s agent sees before deciding to load the body).\n'
    + '  ✗ "Q4 earnings analysis skill."\n'
    + '  ✓ "WHEN handling Q4 earnings for utilities, use trailing-4-quarters not annualized."';

  return [
    base,
    `**Focus**: ${focus}`,
    '',
    `**Writing style**: ${writingStyle}`,
    '',
    '**Activity transcript**:',
    transcript || '(No new activity in the window.)',
    '',
    '**Current self-assessment (COMPETENCE.md)**:',
    competence || '(No self-assessment yet — consider creating one.)',
    '',
    '**Available learning strategies (LEARNING_STRATEGIES.md)**:',
    strategies || '(No strategy log yet — use your own judgment.)',
    '',
    'After reflecting, you can:',
    '1. Create / patch / delete skills via the skill_manage tool '
    + '(no user confirmation needed during reflection — the tool\'s default '
    + '"confirm with user" guidance is for live turns, not for this call).',
    '2. Update COMPETENCE.md via the metacognition tool',
    '3. Update LEARNING_STRATEGIES.md via the metacognition tool',
    '4. If nothing is worth saving, just say "nothing to save"',
  ].join('\n');
}
