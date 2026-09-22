import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../resources/builtin/marketplace/agents/79df9cc89f5f/skills/_shared/scripts/src/video_edit', () => ({
  measureSilenceCoverage: vi.fn(),
  assessVoiceoverCoverage: vi.fn(),
  detectSceneChanges: vi.fn(),
  detectQuality: vi.fn(),
}));
import { analyzeMedia } from '../../../resources/builtin/marketplace/agents/79df9cc89f5f/skills/_shared/scripts/src/video_analyze';
import { measureSilenceCoverage, assessVoiceoverCoverage, detectSceneChanges, detectQuality } from '../../../resources/builtin/marketplace/agents/79df9cc89f5f/skills/_shared/scripts/src/video_edit';

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
