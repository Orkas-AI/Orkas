import { describe, expect, it, vi, beforeEach } from 'vitest';

// Mock the OCR runtime and the ffmpeg helpers so the video OCR flow is
// testable without Python/ffmpeg. The batch contract (ONE ocrImagesText call
// per clip, index-aligned results, per-frame error tolerance) is the behavior
// under test.
vi.mock('../../../resources/builtin/marketplace/agents/79df9cc89f5f/skills/_shared/scripts/src/ocr_runtime', () => ({
  ocrImageText: vi.fn(),
  ocrImagesText: vi.fn(),
}));
vi.mock('../../../resources/builtin/marketplace/agents/79df9cc89f5f/skills/_shared/scripts/src/video_edit', () => ({
  measureSilenceCoverage: vi.fn(),
  assessVoiceoverCoverage: vi.fn(),
  extractFrameAt: vi.fn(async () => ({ ok: true })),
  probeMediaDurationSec: vi.fn(async () => 10),
  detectSceneChanges: vi.fn(),
  detectQuality: vi.fn(),
}));

import { sampleTimecodes, collapseOcrSegments, analyzeMedia } from '../../../resources/builtin/marketplace/agents/79df9cc89f5f/skills/_shared/scripts/src/video_analyze';
import { ocrImagesText } from '../../../resources/builtin/marketplace/agents/79df9cc89f5f/skills/_shared/scripts/src/ocr_runtime';

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

describe('analyzeMedia › video ocr › batch contract', () => {
  const mockedBatch = vi.mocked(ocrImagesText);
  let fakeVideo: string;

  beforeEach(async () => {
    mockedBatch.mockReset();
    const fs = await import('node:fs');
    const os = await import('node:os');
    const path = await import('node:path');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-ocr-batch-test-'));
    fakeVideo = path.join(dir, 'clip.mp4');
    fs.writeFileSync(fakeVideo, 'not-a-real-video'); // probe/extract are mocked
  });

  it('runs ONE batch OCR call for all sampled frames and maps results by index', async () => {
    const expectedFrames = sampleTimecodes(10, 2.5, 16).length;
    mockedBatch.mockImplementationOnce(async ({ absPaths }) => ({
      ok: true as const,
      results: absPaths.map((_, i) => ({
        text: i < absPaths.length / 2 ? 'Slide A' : 'Slide B',
        items: [],
      })),
    }));

    const r = await analyzeMedia({ op: 'ocr', inputAbsPath: fakeVideo });
    expect(r.ok, JSON.stringify(r)).toBe(true);
    expect(mockedBatch).toHaveBeenCalledTimes(1);
    expect(mockedBatch.mock.calls[0][0].absPaths).toHaveLength(expectedFrames);
    if (r.ok === true) {
      const summary = r.summary as { sampledFrames: number; segments: Array<{ text: string }> };
      expect(summary.sampledFrames).toBe(expectedFrames);
      expect(summary.segments.map((s) => s.text)).toEqual(['Slide A', 'Slide B']);
    }
  });

  it('skips per-frame errors without failing the clip', async () => {
    mockedBatch.mockImplementationOnce(async ({ absPaths }) => ({
      ok: true as const,
      results: absPaths.map((_, i) => (i === 0
        ? { text: '', items: [], error: 'unreadable frame' }
        : { text: 'Slide B', items: [] })),
    }));

    const r = await analyzeMedia({ op: 'ocr', inputAbsPath: fakeVideo });
    expect(r.ok, JSON.stringify(r)).toBe(true);
    if (r.ok === true) {
      const summary = r.summary as { sampledFrames: number; segments: Array<{ text: string }> };
      expect(summary.sampledFrames).toBe(sampleTimecodes(10, 2.5, 16).length - 1);
      expect(summary.segments.map((s) => s.text)).toEqual(['Slide B']);
    }
  });

  it('surfaces a runtime install failure as the op error', async () => {
    mockedBatch.mockResolvedValueOnce({
      ok: false as const,
      errorCode: 'E_OCR_INSTALL_FAILED',
      message: 'install failed',
    });

    const r = await analyzeMedia({ op: 'ocr', inputAbsPath: fakeVideo });
    expect(r.ok).toBe(false);
    if (r.ok === false) expect(r.errorCode).toBe('E_OCR_INSTALL_FAILED');
  });

  it('real ocrImagesText validates inputs before touching the runtime', async () => {
    const actual = await vi.importActual<typeof import('../../../resources/builtin/marketplace/agents/79df9cc89f5f/skills/_shared/scripts/src/ocr_runtime')>(
      '../../../resources/builtin/marketplace/agents/79df9cc89f5f/skills/_shared/scripts/src/ocr_runtime',
    );
    // Empty input → trivially ok with no python spawn.
    await expect(actual.ocrImagesText({ absPaths: [] })).resolves.toEqual({ ok: true, results: [] });
    // A non-image path is rejected before ensureRuntime.
    const r = await actual.ocrImagesText({ absPaths: ['/tmp/a.png', '/tmp/not-an-image.mp4'] });
    expect(r.ok).toBe(false);
    if (r.ok === false) expect(r.errorCode).toBe('E_OCR_UNSUPPORTED_FILE');
  });
});
