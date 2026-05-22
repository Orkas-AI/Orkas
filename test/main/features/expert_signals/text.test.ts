import { describe, it, expect } from 'vitest';
import { extractTextSignals } from '../../../../src/main/features/expert_signals/extractors/text';

// CLAUDE.md §9: text-processing extractor needs positive + negative fixtures.

function ctx() {
  return {
    cid: 'cid-1',
    aid: 'agent-x',
    turn_id: 'msg-prev',
    agent_last_text: 'Here is the Q3 profit: $5.2M',
    msg_ids: ['msg-prev', 'msg-cur'],
  };
}

describe('expert_signals.text › correction', () => {
  it('positive: 不对 / 应该是 triggers correction', () => {
    const out = extractTextSignals({
      ...ctx(), user_msg: '不对，应该是 5.7M',
      correction_detected: true,
    });
    expect(out.map((s) => s.type)).toContain('correction');
  });

  it('negative: "对不起" alone does NOT trigger correction', () => {
    // detectUserCorrection returns false on plain apology — caller passes
    // the boolean through. Asserts the extractor honours caller's verdict.
    const out = extractTextSignals({
      ...ctx(), user_msg: '对不起,我表达不清楚',
      correction_detected: false,
    });
    expect(out.map((s) => s.type)).not.toContain('correction');
  });
});

describe('expert_signals.text › reject', () => {
  it('positive: "重新做一遍" triggers reject', () => {
    const out = extractTextSignals({
      ...ctx(), user_msg: '重新做一遍这部分',
      correction_detected: false,
    });
    expect(out.map((s) => s.type)).toContain('reject');
  });

  it('negative: "重要的是" does NOT trigger reject', () => {
    // "重" appears but not as a reject keyword — pattern requires 重新+verb.
    const out = extractTextSignals({
      ...ctx(), user_msg: '重要的是要保证准确性',
      correction_detected: false,
    });
    expect(out.map((s) => s.type)).not.toContain('reject');
  });
});

describe('expert_signals.text › accept (explicit)', () => {
  it('positive: "好的" triggers accept', () => {
    const out = extractTextSignals({
      ...ctx(), user_msg: '好的，继续',
      correction_detected: false,
    });
    expect(out.map((s) => s.type)).toContain('accept');
  });

  it('negative: "好" alone does NOT trigger (too noisy)', () => {
    // Single 好 is ambiguous (could start a sentence). Pattern requires 好 + (的)?
    // + punctuation/EOL — bare "好" doesn't match the anchored regex.
    const out = extractTextSignals({
      ...ctx(), user_msg: '好像有点问题',
      correction_detected: false,
    });
    expect(out.map((s) => s.type)).not.toContain('accept');
  });

  it('does NOT emit accept when correction is detected (correction is stronger)', () => {
    const out = extractTextSignals({
      ...ctx(), user_msg: '好的,但实际上不对',
      correction_detected: true,
    });
    const types = out.map((s) => s.type);
    expect(types).toContain('correction');
    expect(types).not.toContain('accept');
  });
});

describe('expert_signals.text › edit', () => {
  it('positive: user rewrites agent text with substantial diff', () => {
    const out = extractTextSignals({
      ...ctx(),
      agent_last_text: 'Here is the Q3 profit summary written in formal style with all numbers',
      user_msg:         'Here is the Q3 profit summary written more concisely',
      correction_detected: false,
    });
    expect(out.map((s) => s.type)).toContain('edit');
  });

  it('negative: short question is not an edit', () => {
    const out = extractTextSignals({
      ...ctx(),
      agent_last_text: 'Here is the Q3 profit summary written in formal style with all numbers',
      user_msg: '什么时候出的?',
      correction_detected: false,
    });
    expect(out.map((s) => s.type)).not.toContain('edit');
  });

  it('negative: identical echo is not an edit', () => {
    const out = extractTextSignals({
      ...ctx(),
      agent_last_text: 'Here is the Q3 profit summary written in formal style with all numbers',
      user_msg:        'Here is the Q3 profit summary written in formal style with all numbers',
      correction_detected: false,
    });
    expect(out.map((s) => s.type)).not.toContain('edit');
  });
});

describe('expert_signals.text › meta', () => {
  it('returns empty array on empty user message', () => {
    const out = extractTextSignals({
      ...ctx(), user_msg: '   ', correction_detected: false,
    });
    expect(out).toEqual([]);
  });

  it('all emitted signals carry the same turn_id (group-by anchor)', () => {
    const out = extractTextSignals({
      ...ctx(), user_msg: '不对,重新做',
      correction_detected: true,
    });
    expect(out.length).toBeGreaterThan(1);
    const turnIds = new Set(out.map((s) => s.turn_id));
    expect(turnIds.size).toBe(1);
  });
});
