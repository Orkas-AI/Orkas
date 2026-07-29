import { describe, expect, it } from 'vitest';

import {
  LIBRARY_CONTENT_MIN_SCORE,
  LIBRARY_CONTENT_STRONG_SCORE,
  hasLibraryContentLexicalAnchor,
  isRelevantLibraryContentHit,
  isRelevantLibraryContentScore,
  libraryContentDisplayScore,
} from '../../../../src/main/features/search/library_content_ranking';

describe('Library content ranking', () => {
  it('accepts the configured threshold and rejects lower or invalid scores', () => {
    expect(isRelevantLibraryContentScore(LIBRARY_CONTENT_MIN_SCORE)).toBe(true);
    expect(isRelevantLibraryContentScore(LIBRARY_CONTENT_MIN_SCORE - Number.EPSILON)).toBe(false);
    expect(isRelevantLibraryContentScore(Number.NaN)).toBe(false);
    expect(isRelevantLibraryContentScore(undefined)).toBe(false);
  });

  it('requires a lexical anchor for medium-confidence hits', () => {
    expect(isRelevantLibraryContentHit('social launch schedule', {
      score: LIBRARY_CONTENT_MIN_SCORE,
      content: 'The social launch schedule starts Tuesday.',
    })).toBe(true);
    expect(isRelevantLibraryContentHit('museum planetarium parking', {
      score: LIBRARY_CONTENT_STRONG_SCORE - 0.001,
      content: 'An unrelated customer support escalation policy.',
    })).toBe(false);
  });

  it('allows strong semantic hits without literal overlap', () => {
    expect(isRelevantLibraryContentHit('德语手机按钮溢出怎么办', {
      score: LIBRARY_CONTENT_STRONG_SCORE,
      content: 'The approved repair stacks long German mobile actions.',
    })).toBe(true);
  });

  it('finds meaningful Latin and CJK phrase anchors without stop-word-only matches', () => {
    expect(hasLibraryContentLexicalAnchor(
      'budget',
      ['The approved campaign budget is recorded here.'],
    )).toBe(true);
    expect(hasLibraryContentLexicalAnchor(
      'Which source mentions operation-based CRDT?',
      ['Offline edits use an operation-based CRDT.'],
    )).toBe(true);
    expect(hasLibraryContentLexicalAnchor(
      '社媒渠道排期',
      ['社媒渠道排期安排在周二和周四。'],
    )).toBe(true);
    expect(hasLibraryContentLexicalAnchor(
      'Which museum is open on Sunday?',
      ['The support policy explains which queue is open.'],
    )).toBe(false);
  });

  it('maps cosine similarity into a bounded display-ranking interval', () => {
    expect(libraryContentDisplayScore(-1)).toBe(20);
    expect(libraryContentDisplayScore(0.5)).toBe(30);
    expect(libraryContentDisplayScore(1)).toBe(40);
    expect(libraryContentDisplayScore(2)).toBe(40);
    expect(libraryContentDisplayScore(Number.NaN)).toBe(20);
  });
});
