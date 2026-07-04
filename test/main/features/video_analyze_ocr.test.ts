import { describe, expect, it } from 'vitest';

import { sampleTimecodes, collapseOcrSegments } from '../../../resources/builtin/marketplace/agents/79df9cc89f5f/skills/_shared/scripts/src/video_analyze';

describe('sampleTimecodes', () => {
  it('samples mid-step across the clip, strictly increasing and inside duration', () => {
    const ts = sampleTimecodes(23.9, 2.5, 16);
    expect(ts[0]).toBeCloseTo(1.25, 2); // half a step in, not on the opening transition
    expect(ts.length).toBeLessThanOrEqual(16);
    for (let i = 1; i < ts.length; i++) expect(ts[i]).toBeGreaterThan(ts[i - 1]);
    for (const t of ts) expect(t).toBeLessThan(23.9);
  });

  it('respects the frame cap and still reaches near the end', () => {
    const ts = sampleTimecodes(120, 2.5, 8);
    expect(ts.length).toBe(8);
    // capped before reaching the tail → a near-end sample is appended so the
    // final slide is never missed
    expect(ts[ts.length - 1]).toBeGreaterThan(100);
  });

  it('handles a zero / unknown duration without throwing', () => {
    expect(sampleTimecodes(0, 2.5, 16)).toEqual([0]);
  });
});

describe('collapseOcrSegments', () => {
  it('merges consecutive identical reads into per-slide segments covering the timeline', () => {
    const frames = [
      { tSec: 1.25, text: 'Slide A' },
      { tSec: 3.75, text: 'Slide A' },
      { tSec: 6.25, text: 'Slide B' },
      { tSec: 8.75, text: 'Slide B' },
      { tSec: 11.25, text: 'Slide C' },
    ];
    const segs = collapseOcrSegments(frames, 14);
    expect(segs.map((s) => s.text)).toEqual(['Slide A', 'Slide B', 'Slide C']);
    expect(segs[0].startSec).toBe(0); // first slide is on screen from the clip start
    expect(segs[0].endSec).toBe(6.25); // stretched to the next slide's start
    expect(segs[2].endSec).toBe(14); // last slide stretched to clip end
  });

  it('treats whitespace-only differences as the same slide', () => {
    const segs = collapseOcrSegments(
      [
        { tSec: 1, text: 'Hello  World' },
        { tSec: 2, text: 'Hello World' },
      ],
      4,
    );
    expect(segs).toHaveLength(1);
    expect(segs[0].endSec).toBe(4);
  });
});
