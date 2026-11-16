import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../resources/builtin/marketplace/agents/79df9cc89f5f/skills/_shared/scripts/src/video_edit', () => ({
  measureRegionActivity: vi.fn(),
  measureSilenceCoverage: vi.fn(),
  assessVoiceoverCoverage: vi.fn(),
  detectSceneChanges: vi.fn(),
  detectQuality: vi.fn(),
}));
import { analyzeMedia } from '../../../resources/builtin/marketplace/agents/79df9cc89f5f/skills/_shared/scripts/src/video_analyze';
import { measureRegionActivity, measureSilenceCoverage, assessVoiceoverCoverage, detectSceneChanges, detectQuality } from '../../../resources/builtin/marketplace/agents/79df9cc89f5f/skills/_shared/scripts/src/video_edit';

describe('video analysis without a recognition runtime', () => {
  let root: string;
  let input: string;
  beforeEach(() => {
    vi.resetAllMocks();
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-video-analysis-'));
    input = path.join(root, 'clip.mp4');
    fs.writeFileSync(input, 'controlled media input');
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  it('preserves measured scene times and quality findings for edit decisions', async () => {
    vi.mocked(detectSceneChanges).mockResolvedValue({
      ok: true, durationSec: 10, threshold: 0.3,
      candidates: [{ tSec: 3.25, score: 0.8 }],
    });
    const scenes = await analyzeMedia({ op: 'scenes', inputAbsPath: input, threshold: 0.3 });
    expect(scenes).toMatchObject({ ok: true, summary: {
      durationSec: 10, threshold: 0.3, count: 1, candidates: [{ tSec: 3.25, score: 0.8 }],
    } });
    const report = { durationSec: 10, darkSegments: [{ startSec: 2, endSec: 4 }] };
    vi.mocked(detectQuality).mockResolvedValue({ ok: true, report } as any);
    expect(await analyzeMedia({ op: 'quality', inputAbsPath: input }))
      .toEqual({ ok: true, op: 'quality', summary: { op: 'quality', ...report } });
  });

  it('retains silence and voice coverage evidence for audio QA', async () => {
    vi.mocked(measureSilenceCoverage).mockResolvedValue({ ok: true, timing: {
      durationSec: 10, voicedStartSec: 1, voicedEndSec: 9, voicedDurationSec: 8,
      leadingSilenceSec: 1, trailingSilenceSec: 1,
      silences: [{ startSec: 0, endSec: 1 }, { startSec: 9, endSec: 10 }],
    } } as any);
    vi.mocked(assessVoiceoverCoverage).mockReturnValue({ coverageRatio: 0.8 } as any);
    expect(await analyzeMedia({ op: 'silence', inputAbsPath: input })).toMatchObject({
      ok: true, summary: { durationSec: 10, voicedDurationSec: 8,
        leadingSilenceSec: 1, trailingSilenceSec: 1, coverage: { coverageRatio: 0.8 } },
    });
  });

  it.each(['silence', 'scenes', 'quality'] as const)('preserves %s backend failures without claiming analysis', async (op) => {
    const error = { ok: false as const, errorCode: 'E_EDIT_ABORTED', message: 'analysis aborted' };
    vi.mocked(measureSilenceCoverage).mockResolvedValue(error);
    vi.mocked(detectSceneChanges).mockResolvedValue(error);
    vi.mocked(detectQuality).mockResolvedValue(error);
    expect(await analyzeMedia({ op, inputAbsPath: input })).toEqual(error);
  });

  it.each([Number.MIN_VALUE, 0, -1, NaN, Infinity])('rejects an activity window %s that cannot be computed before decode', async (windowSec) => {
    vi.mocked(measureRegionActivity).mockResolvedValue({ ok: false, errorCode: 'E_TEST_DECODE', message: 'decoder must not run' });
    expect(await analyzeMedia({ op: 'activity', inputAbsPath: input, regions: [{ id: 'speaker', box: [0, 0, 1, 1] }], windowSec }))
      .toMatchObject({ ok: false, errorCode: 'E_ANALYZE_ARG' });
    expect(measureRegionActivity).not.toHaveBeenCalled();
  });

  it('preserves requested 50ms windows, including empty windows between 10Hz samples', async () => {
    vi.mocked(measureRegionActivity).mockResolvedValue({ ok: true, durationSec: 0.2,
      series: { speaker: [{ tSec: 0, value: 3 }, { tSec: 0.1, value: 5 }] } });
    expect(await analyzeMedia({ op: 'activity', inputAbsPath: input,
      regions: [{ id: 'speaker', box: [0, 0, 1, 1] }], windowSec: 0.05 }))
      .toMatchObject({ ok: true, summary: { windowCount: 4, windows: [
        { start: 0, end: 0.05, levels: { speaker: 3 } },
        { start: 0.05, end: 0.1, levels: { speaker: 0 } },
        { start: 0.1, end: 0.15, levels: { speaker: 5 } },
        { start: 0.15, end: 0.2, levels: { speaker: 0 } },
      ], turns: [{ start: 0, end: 0.2, region: 'speaker' }] } });
    expect(fs.readFileSync(input, 'utf8')).toBe('controlled media input');
  });

  it.each([10, 0])('returns a recoverable error for excessive work with probed duration %s', async (durationSec) => {
    vi.mocked(measureRegionActivity).mockResolvedValue({ ok: true, durationSec, series: { speaker: [{ tSec: 9, value: 3 }] } });
    const result = await analyzeMedia({ op: 'activity', inputAbsPath: input,
      regions: [{ id: 'speaker', box: [0, 0, 1, 1] }], windowSec: 1e-200 });
    expect(result).toMatchObject({ ok: false, errorCode: 'E_ANALYZE_ARG' });
    expect((result as any).message).toContain('larger window');
    expect(fs.readFileSync(input, 'utf8')).toBe('controlled media input');
  });

  it('accepts the activity sampling interval without empty zero-width windows', async () => {
    vi.mocked(measureRegionActivity).mockResolvedValue({ ok: true, durationSec: 0.2,
      series: { speaker: [{ tSec: 0, value: 3 }, { tSec: 0.1, value: 5 }] } });
    const result = await analyzeMedia({ op: 'activity', inputAbsPath: input, regions: [{ id: 'speaker', box: [0, 0, 1, 1] }], windowSec: 0.1 });
    expect(result).toMatchObject({ ok: true, summary: { windowCount: 2,
      windows: [{ start: 0, end: 0.1, levels: { speaker: 3 } }, { start: 0.1, end: 0.2, levels: { speaker: 5 } }] } });
    expect(measureRegionActivity).toHaveBeenCalledOnce();
  });

  it('reads a transcript as lines split at the pauses measured in the same file', async () => {
    vi.mocked(measureSilenceCoverage).mockResolvedValue({ ok: true, timing: {
      durationSec: 3, voicedStartSec: 0, voicedEndSec: 3, voicedDurationSec: 2.4,
      leadingSilenceSec: 0, trailingSilenceSec: 0,
      silences: [{ startSec: 1.0, endSec: 1.6 }],
    } } as any);
    const transcript = path.join(root, 'clip.transcript.json');
    fs.writeFileSync(transcript, JSON.stringify({ text: '这款 呃 很亮', words: [
      { text: '这款', startSec: 0.1, endSec: 0.9 },
      { text: '呃', startSec: 0.9, endSec: 1.7 },
      { text: '很亮', startSec: 1.7, endSec: 2.5 },
    ] }));
    const result = await analyzeMedia({ op: 'phrases', inputAbsPath: input, transcriptAbsPath: transcript, noiseDb: -35 });
    expect(vi.mocked(measureSilenceCoverage).mock.calls[0][1]).toMatchObject({ noiseDb: -35, minSilenceSec: 0.15 });
    expect(result).toMatchObject({ ok: true, op: 'phrases', summary: { timing: 'word', lines: 2, measuredPauses: 1 } });
    // 呃 spans the silence, so it is taken to end where the silence starts.
    expect((result as any).summary.text).toBe('[0.10–1.00] 这款呃\n  — 0.60s —\n[1.60–2.50] 很亮');
  });

  it('uses segment times when the transcript has no word timings', async () => {
    vi.mocked(measureSilenceCoverage).mockResolvedValue({ ok: true, timing: {
      durationSec: 6, voicedStartSec: 0, voicedEndSec: 6, voicedDurationSec: 5,
      leadingSilenceSec: 0, trailingSilenceSec: 0, silences: [],
    } } as any);
    const transcript = path.join(root, 'clip.transcript.json');
    fs.writeFileSync(transcript, JSON.stringify({ segments: [
      { text: 'First line.', startSec: 0, endSec: 2 }, { text: 'Second line.', startSec: 3, endSec: 6 },
    ], words: [] }));
    const result = await analyzeMedia({ op: 'phrases', inputAbsPath: input, transcriptAbsPath: transcript });
    expect(result).toMatchObject({ ok: true, summary: { timing: 'segment', lines: 2 } });
  });

  it('refuses phrases without a usable transcript before measuring anything', async () => {
    expect(await analyzeMedia({ op: 'phrases', inputAbsPath: input })).toMatchObject({ ok: false, errorCode: 'E_ANALYZE_ARG' });
    const broken = path.join(root, 'broken.json');
    fs.writeFileSync(broken, '{not json');
    expect(await analyzeMedia({ op: 'phrases', inputAbsPath: input, transcriptAbsPath: broken })).toMatchObject({ ok: false, errorCode: 'E_ANALYZE_TRANSCRIPT' });
    const empty = path.join(root, 'empty.json');
    fs.writeFileSync(empty, JSON.stringify({ text: '', segments: [], words: [] }));
    expect(await analyzeMedia({ op: 'phrases', inputAbsPath: input, transcriptAbsPath: empty })).toMatchObject({ ok: false, errorCode: 'E_ANALYZE_TRANSCRIPT' });
    expect(measureSilenceCoverage).not.toHaveBeenCalled();
  });

  it('rejects missing input and retired operations without media work', async () => {
    expect(await analyzeMedia({ op: 'scenes', inputAbsPath: path.join(root, 'missing.mp4') }))
      .toMatchObject({ ok: false, errorCode: 'E_ANALYZE_NO_INPUT' });
    expect(await analyzeMedia({ op: 'ocr' as any, inputAbsPath: input }))
      .toMatchObject({ ok: false, errorCode: 'E_ANALYZE_ARG' });
    expect(detectSceneChanges).not.toHaveBeenCalled();
    expect(detectQuality).not.toHaveBeenCalled();
    expect(measureSilenceCoverage).not.toHaveBeenCalled();
  });
});
