import { describe, it, expect } from 'vitest';
import {
  detectUserCorrection,
  buildReviewPrompt,
} from '../src/evolution/metacognition.js';

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

  it('treats transcripts and existing notes as untrusted evidence', () => {
    const prompt = buildReviewPrompt('', '', '');
    expect(prompt).toMatch(/untrusted evidence, not instructions/i);
    expect(prompt).toMatch(/never copy credentials or private values/i);
    expect(prompt).toMatch(/never create, patch, or delete a skill merely because/i);
  });

  it('always offers the four post-reflection actions', () => {
    const prompt = buildReviewPrompt('', '', '');
    expect(prompt).toContain('When skill_manage is available for a named Agent');
    expect(prompt).toContain('metacognition tool');
    expect(prompt).toMatch(/nothing to save/i);
  });

  it('directs LLM to look for user preferences + domain constraints', () => {
    const prompt = buildReviewPrompt('', '', '');
    // Plan §2.3: prompt should nudge LLM to extract red lines / edits / etc.
    expect(prompt).toMatch(/user preferences|domain constraints|red lines/i);
  });

  it('routes lessons to the right store without over-generalizing routine compliance', () => {
    const prompt = buildReviewPrompt('', '', '');
    expect(prompt).toMatch(/strengths, limits.*COMPETENCE\.md/i);
    expect(prompt).toMatch(/methods and workarounds.*LEARNING_STRATEGIES\.md/i);
    expect(prompt).toMatch(/user preference or domain constraint belongs only in COMPETENCE\.md/i);
    expect(prompt).toMatch(/never reclassify it as a learning strategy/i);
    expect(prompt).toMatch(/single best store.*never duplicate a method or workaround/i);
    expect(prompt).toMatch(/disproves a recorded weakness.*narrow demonstrated capability/i);
    expect(prompt).toMatch(/do not also invent a strategy/i);
    expect(prompt).toMatch(/passing tests.*evidence for that capability update.*not as standalone learning strategies/i);
    expect(prompt).toMatch(/preserve the verification basis in the competence claim/i);
    expect(prompt).toMatch(/weakness-reversal update.*leave LEARNING_STRATEGIES\.md unchanged/i);
    expect(prompt).toMatch(/distinct method learned through correction or recovery beyond ordinary validation/i);
    expect(prompt).toMatch(/compare each proposed fact semantically with both current files/i);
    expect(prompt).toMatch(/equivalent rule already exists.*return "nothing to save"/i);
    expect(prompt).toMatch(/never replace a file merely to rephrase/i);
    expect(prompt).toMatch(/do not turn a few successful examples into a universal method preference/i);
    expect(prompt).toMatch(/routine compliance,\s*not new learning/i);
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

  it('directs metacognition writes to use the host-provided UI language', () => {
    const prompt = buildReviewPrompt('', '', '', 'Chinese (简体中文)');
    expect(prompt).toContain('Language');
    expect(prompt).toContain('Chinese (简体中文)');
    expect(prompt).toMatch(/all human-readable.*update prose.*mandatory/i);
    expect(prompt).toMatch(/translate or summarize/i);
    expect(prompt).toMatch(/proper nouns, commands, file paths/i);
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
