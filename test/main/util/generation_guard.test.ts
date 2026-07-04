import { afterEach, describe, expect, it } from 'vitest';

import {
  noteGeneration,
  regenerationWarning,
  __resetGenerationGuard,
  REGEN_WARN_AT,
} from '../../../src/main/util/generation-guard';

afterEach(() => __resetGenerationGuard());

describe('noteGeneration', () => {
  it('counts repeated generations of the same deliverable in one conversation', () => {
    expect(noteGeneration('cid-1', '/ws/draft.mp4')).toBe(1);
    expect(noteGeneration('cid-1', '/ws/draft.mp4')).toBe(2);
    expect(noteGeneration('cid-1', '/ws/draft.mp4')).toBe(3);
  });

  it('keeps counts separate per path and per conversation', () => {
    noteGeneration('cid-1', '/ws/a.mp4');
    expect(noteGeneration('cid-1', '/ws/b.mp4')).toBe(1); // different path resets
    expect(noteGeneration('cid-2', '/ws/a.mp4')).toBe(1); // different cid resets
    expect(noteGeneration('cid-1', '/ws/a.mp4')).toBe(2); // same path+cid accumulates
  });

  it('treats a missing conversation id as its own scope without throwing', () => {
    expect(noteGeneration(undefined, '/ws/x.mp4')).toBe(1);
    expect(noteGeneration(undefined, '/ws/x.mp4')).toBe(2);
  });
});

describe('regenerationWarning', () => {
  it('stays silent below the threshold (a one-shot fix is normal)', () => {
    expect(regenerationWarning(1, 'video')).toBeNull();
    expect(regenerationWarning(REGEN_WARN_AT - 1, 'video')).toBeNull();
  });

  it('warns at and beyond the threshold, naming the count and the kind', () => {
    const w = regenerationWarning(REGEN_WARN_AT, 'image');
    expect(w).not.toBeNull();
    expect(w).toContain(`#${REGEN_WARN_AT}`);
    expect(w).toMatch(/image/);
    expect(w).toMatch(/billable/i);
  });

  it('escalates the number as regenerations pile up', () => {
    expect(regenerationWarning(7, 'video')).toContain('#7');
  });
});
