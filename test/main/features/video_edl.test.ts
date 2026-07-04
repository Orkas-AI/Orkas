import { describe, expect, it } from 'vitest';

import { validateEdl, summarizeEdl, assessDelivery, type VideoEdl } from '../../../resources/builtin/marketplace/agents/79df9cc89f5f/skills/_shared/scripts/src/video_edl';

/** A minimal but fully valid hybrid plan: one trimmed source clip on primary,
 *  a composed title card overlay, narration + ducked music. This is the M0
 *  "hybrid minimal loop" shape. */
function validPlan(): VideoEdl {
  return {
    aspect: '9:16',
    total_target_sec: 20,
    language: 'zh',
    delivery_promise: {
      type: 'hybrid',
      source_required: true,
      motion_min_ratio: 0.6,
      quality_floor: 'captions legible at arm length',
    },
    style_kit: { palette: ['#111', '#fff'], fonts: ['Inter'], motion: { ease: 'ease-out', default_in_sec: 0.4 }, audio: { target_lufs: -14, music_duck_db: -12 } },
    segments: [
      { id: 'hook', order: 1, role: 'hook', layer: 'primary', source: 'edit', target_sec: 8, spec: { input_id: 'clipA', in_sec: 12, out_sec: 20 } },
      { id: 'body', order: 2, role: 'body', layer: 'primary', source: 'compose', target_sec: 12, spec: { kind: 'stat-card', title: 'Why it matters' } },
      { id: 'title', order: 3, role: 'hook', layer: 'overlay', source: 'compose', target_sec: 3, over: 'hook', spec: { kind: 'lower-third', title: 'New' } },
    ],
    tracks: {
      narration: { voice: 'zh_male_jieshuoxiaoming_uranus_bigtts', segments: [{ text: 'hello', start_sec: 0, target_sec: 8 }] },
      music: { path: 'assets/bed.mp3', duck: true },
      captions: { from: 'narration', style: 'bold-bottom' },
    },
    cost_estimate: { billable_generations: 0, note: 'no AI footage' },
  };
}

const codes = (obj: unknown) => {
  const r = validateEdl(obj);
  return { ok: r.ok, errors: r.errors.map((e) => e.code), warnings: r.warnings.map((w) => w.code) };
};

describe('validateEdl — accepts a well-formed plan', () => {
  it('passes the minimal hybrid plan with no errors', () => {
    const r = validateEdl(validPlan());
    expect(r.ok).toBe(true);
    expect(r.errors).toEqual([]);
  });

  it('does not warn about cost when there are no generate segments', () => {
    expect(codes(validPlan()).warnings).not.toContain('W_COST_MISSING');
  });
});

describe('validateEdl — structural rejects', () => {
  it('rejects a non-object', () => {
    expect(codes('nope').errors).toContain('E_NOT_OBJECT');
    expect(codes(null).errors).toContain('E_NOT_OBJECT');
  });

  it('rejects missing top-level fields', () => {
    const r = codes({ segments: [] });
    expect(r.errors).toContain('E_ASPECT_MISSING');
    expect(r.errors).toContain('E_TOTAL_SEC');
    expect(r.errors).toContain('E_LANGUAGE_MISSING');
    expect(r.errors).toContain('E_PROMISE_MISSING');
    expect(r.errors).toContain('E_SEGMENTS_EMPTY');
  });

  it('rejects an unknown promise type and bad enums', () => {
    const p = validPlan();
    (p.delivery_promise as { type: string }).type = 'vibes_led';
    p.segments[0].role = 'banger' as never;
    p.segments[0].layer = 'middle' as never;
    p.segments[0].source = 'summon' as never;
    const r = codes(p);
    expect(r.errors).toContain('E_PROMISE_TYPE');
    expect(r.errors).toContain('E_SEG_ROLE');
    expect(r.errors).toContain('E_SEG_LAYER');
    expect(r.errors).toContain('E_SEG_SOURCE');
  });

  it('rejects duplicate segment ids and a missing primary layer', () => {
    const p = validPlan();
    p.segments = [
      { id: 'x', order: 1, role: 'hook', layer: 'overlay', source: 'compose', target_sec: 5, over: 'x', spec: { kind: 'card' } },
      { id: 'x', order: 2, role: 'body', layer: 'overlay', source: 'compose', target_sec: 5, spec: { kind: 'card' } },
    ];
    const r = codes(p);
    expect(r.errors).toContain('E_SEG_ID_DUP');
    expect(r.errors).toContain('E_NO_PRIMARY');
  });

  it('rejects an `over` that references an unknown segment', () => {
    const p = validPlan();
    p.segments[2].over = 'ghost';
    expect(codes(p).errors).toContain('E_OVER_UNKNOWN');
  });

  it('warns (does not block) on a malformed style_kit', () => {
    const p = validPlan();
    (p as { style_kit: unknown }).style_kit = { palette: 'red', fonts: 'Inter' };
    const r = codes(p);
    expect(r.ok).toBe(true);
    expect(r.warnings).toContain('W_STYLE_KIT');
  });
});

describe('validateEdl — per-source spec requirements', () => {
  it('rejects an edit segment with an inverted trim range', () => {
    const p = validPlan();
    p.segments[0].spec = { input_id: 'clipA', in_sec: 20, out_sec: 12 };
    expect(codes(p).errors).toContain('E_SPEC_EDIT_RANGE');
  });

  it('rejects an edit segment missing input_id', () => {
    const p = validPlan();
    p.segments[0].spec = { in_sec: 0, out_sec: 5 };
    expect(codes(p).errors).toContain('E_SPEC_EDIT_FIELDS');
  });

  it('rejects a generate segment with no prompt', () => {
    const p = validPlan();
    p.segments[1] = { id: 'gen', order: 2, role: 'body', layer: 'primary', source: 'generate', target_sec: 6, spec: {} };
    expect(codes(p).errors).toContain('E_SPEC_GENERATE_PROMPT');
  });

  it('accepts a generate segment with valid consistency/cost intent', () => {
    const p = validPlan();
    p.segments[1] = { id: 'gen', order: 2, role: 'body', layer: 'primary', source: 'generate', target_sec: 12, spec: { prompt: 'hero walks in', variation_type: 'small', characters: ['hero'], refs: ['frames/prev.png'] } };
    p.cost_estimate = { billable_generations: 1 };
    const r = codes(p);
    expect(r.errors).toEqual([]);
    expect(r.warnings).not.toContain('W_VARIATION_TYPE');
  });

  it('warns (does not block) on a malformed variation_type or non-array characters/refs', () => {
    const p = validPlan();
    p.segments[1] = { id: 'gen', order: 2, role: 'body', layer: 'primary', source: 'generate', target_sec: 12, spec: { prompt: 'x', variation_type: 'huge', characters: 'hero', refs: 'one' } as never };
    p.cost_estimate = { billable_generations: 1 };
    const r = codes(p);
    expect(r.ok).toBe(true);
    expect(r.warnings).toContain('W_VARIATION_TYPE');
    expect(r.warnings).toContain('W_GENERATE_CHARACTERS');
    expect(r.warnings).toContain('W_GENERATE_REFS');
  });
});

describe('validateEdl — promise consistency', () => {
  it('errors when source is required but no source footage is present', () => {
    const p = validPlan();
    p.segments = [
      { id: 'a', order: 1, role: 'hook', layer: 'primary', source: 'compose', target_sec: 10, spec: { kind: 'card' } },
      { id: 'b', order: 2, role: 'body', layer: 'primary', source: 'compose', target_sec: 10, spec: { kind: 'card' } },
    ];
    expect(codes(p).errors).toContain('E_PROMISE_NO_SOURCE');
  });

  it('warns (does not block) on large duration drift', () => {
    const p = validPlan();
    p.total_target_sec = 100; // primaries sum to 20 → 80% off
    const r = codes(p);
    expect(r.ok).toBe(true);
    expect(r.warnings).toContain('W_DURATION_DRIFT');
  });

  it('warns when generate segments exist but cost is not estimated', () => {
    const p = validPlan();
    p.segments[1] = { id: 'gen', order: 2, role: 'body', layer: 'primary', source: 'generate', target_sec: 12, spec: { prompt: 'a cat' } };
    p.cost_estimate = { billable_generations: 0 };
    const r = codes(p);
    expect(r.ok).toBe(true);
    expect(r.warnings).toContain('W_COST_MISSING');
  });
});

describe('assessDelivery — promise preservation / anti-slideshow', () => {
  it('passes a hybrid plan whose motion clears the floor', () => {
    // primary: 8s edit (motion) + 12s compose (static) = 20s; motion 8/20 = 40% ≥ 60%? no.
    // raise edit so motion clears 60%.
    const p = validPlan();
    p.segments[0].target_sec = 14; // edit
    p.segments[1].target_sec = 6; // compose
    const a = assessDelivery(p);
    expect(a.source_present).toBe(true);
    expect(a.motion_ratio).toBe(0.7);
    expect(a.motion_ok).toBe(true);
    expect(a.verdict).toBe('pass');
  });

  it('fails a plan that collapsed into a slideshow (motion well under floor)', () => {
    const p = validPlan();
    p.segments[0].target_sec = 2; // edit (motion)
    p.segments[1].target_sec = 18; // compose (static) → motion 10%
    const a = assessDelivery(p);
    expect(a.motion_ratio).toBe(0.1);
    expect(a.verdict).toBe('fail');
    expect(a.issues.join(' ')).toMatch(/slideshow/);
  });

  it('warns (not fails) when motion is just under the floor', () => {
    const p = validPlan();
    p.segments[0].target_sec = 11; // edit → motion 55% vs 60% floor (within 0.1 band)
    p.segments[1].target_sec = 9; // compose
    const a = assessDelivery(p);
    expect(a.motion_ratio).toBe(0.55);
    expect(a.verdict).toBe('warn');
  });

  it('fails when the promise requires source footage but none is present', () => {
    const p = validPlan();
    p.delivery_promise.motion_min_ratio = 0; // isolate the source check
    p.segments = [
      { id: 'a', order: 1, role: 'hook', layer: 'primary', source: 'compose', target_sec: 10, spec: { kind: 'card' } },
      { id: 'b', order: 2, role: 'body', layer: 'primary', source: 'generate', target_sec: 10, spec: { prompt: 'x' } },
    ];
    const a = assessDelivery(p);
    expect(a.source_present).toBe(false);
    expect(a.source_ok).toBe(false);
    expect(a.verdict).toBe('fail');
  });

  it('uses actual produced durations when supplied (gate-D against the real cut)', () => {
    const p = validPlan();
    p.segments[0].target_sec = 14; // planned motion 70%
    p.segments[1].target_sec = 6;
    // but the edit clip actually came out short (2s) and compose ran long (18s) → 10%
    const a = assessDelivery(p, { producedSec: { hook: 2, body: 18 } });
    expect(a.motion_ratio).toBe(0.1);
    expect(a.verdict).toBe('fail');
  });

  it('does NOT count a provided STILL image as motion (slide grammar), but DOES count a provided video', () => {
    const base = (kind: string): VideoEdl => ({
      ...validPlan(),
      delivery_promise: { type: 'hybrid', source_required: false, motion_min_ratio: 0 },
      segments: [
        { id: 'a', order: 1, role: 'hook', layer: 'primary', source: 'provided', target_sec: 10, spec: { asset_id: 'x', kind } },
        { id: 'b', order: 2, role: 'body', layer: 'primary', source: 'compose', target_sec: 10, spec: { kind: 'card' } },
      ],
    });
    expect(assessDelivery(base('image')).motion_ratio).toBe(0); // still image is not motion
    expect(assessDelivery(base('video')).motion_ratio).toBe(0.5); // provided video is motion
  });

  it('applies the per-type default motion floor when the plan sets none (motion_led → 0.7)', () => {
    const p = validPlan();
    p.delivery_promise = { type: 'motion_led', source_required: false } as never; // no motion_min_ratio
    p.segments[0].target_sec = 3; // edit (motion)
    p.segments[1].target_sec = 17; // compose → motion 15% < default 0.7
    const a = assessDelivery(p);
    expect(a.motion_min_ratio).toBe(0.7);
    expect(a.verdict).toBe('fail');
  });

  it('warns on a long run of the same source on the primary track (one-note slideshow)', () => {
    const p: VideoEdl = {
      ...validPlan(),
      delivery_promise: { type: 'compose_led', source_required: false, motion_min_ratio: 0 },
      segments: [
        { id: 'a', order: 1, role: 'hook', layer: 'primary', source: 'compose', target_sec: 5, spec: { kind: 'card' } },
        { id: 'b', order: 2, role: 'body', layer: 'primary', source: 'compose', target_sec: 5, spec: { kind: 'card' } },
        { id: 'c', order: 3, role: 'cta', layer: 'primary', source: 'compose', target_sec: 5, spec: { kind: 'card' } },
      ],
    };
    const a = assessDelivery(p);
    expect(a.verdict).toBe('warn');
    expect(a.issues.join(' ')).toMatch(/consecutive compose/);
  });
});

describe('validateEdl — editable caption/narration data (language-driven separability)', () => {
  it('accepts inline caption lines and per-line narration produced_path', () => {
    const p = validPlan();
    p.tracks!.captions = { style: 'bold-bottom', lines: [
      { text: '你的 AI 团队', start_sec: 0, target_sec: 3.8 },
      { text: '浮出水面', start_sec: 3.8, target_sec: 3.8 },
    ] };
    p.tracks!.narration = { voice: 'zh_male_jieshuoxiaoming_uranus_bigtts', segments: [
      { text: 'hello', start_sec: 0, target_sec: 8, produced_path: 'assets/narration/line0.mp3' },
    ] };
    const r = codes(p);
    expect(r.ok).toBe(true);
    expect(r.errors).toEqual([]);
  });

  it('rejects captions.lines that is not an array (look-alike: a single object)', () => {
    const p = validPlan() as unknown as { tracks: { captions: unknown } };
    p.tracks.captions = { lines: { text: 'oops' } };
    expect(codes(p).errors).toContain('E_CAPTIONS_LINES');
  });

  it('rejects a caption line with no text', () => {
    const p = validPlan() as unknown as { tracks: { captions: unknown } };
    p.tracks.captions = { lines: [{ start_sec: 0, target_sec: 2 }] };
    expect(codes(p).errors).toContain('E_CAPTION_LINE_TEXT');
  });

  it('warns (does not block) on a caption line with non-numeric timing', () => {
    const p = validPlan() as unknown as { tracks: { captions: unknown } };
    p.tracks.captions = { lines: [{ text: 'hi', start_sec: '0', target_sec: 2 }] };
    const r = codes(p);
    expect(r.ok).toBe(true);
    expect(r.warnings).toContain('W_CAPTION_TIMING');
  });

  it('warns when a captions track has neither inline lines nor a `from` source', () => {
    const p = validPlan() as unknown as { tracks: { captions: unknown } };
    p.tracks.captions = { style: 'bold-bottom' };
    const r = codes(p);
    expect(r.ok).toBe(true);
    expect(r.warnings).toContain('W_CAPTIONS_EMPTY');
  });

  it('rejects narration.segments that is not an array, and a line with no text', () => {
    const p1 = validPlan() as unknown as { tracks: { narration: unknown } };
    p1.tracks.narration = { voice: 'v', segments: { text: 'x' } };
    expect(codes(p1).errors).toContain('E_NARRATION_SEGMENTS');
    const p2 = validPlan() as unknown as { tracks: { narration: unknown } };
    p2.tracks.narration = { voice: 'v', segments: [{ start_sec: 0 }] };
    expect(codes(p2).errors).toContain('E_NARRATION_LINE_TEXT');
  });

  it('warns (does not block) on a non-string narration produced_path', () => {
    const p = validPlan() as unknown as { tracks: { narration: unknown } };
    p.tracks.narration = { voice: 'v', segments: [{ text: 'hi', produced_path: 123 }] };
    const r = codes(p);
    expect(r.ok).toBe(true);
    expect(r.warnings).toContain('W_NARRATION_PRODUCED');
  });
});

describe('summarizeEdl', () => {
  it('renders a timeline with promise, ordered primaries, nested overlays, tracks, and cost', () => {
    const out = summarizeEdl(validPlan());
    expect(out).toContain('promise=hybrid');
    expect(out).toContain('source-required');
    expect(out).toContain('motion≥60%');
    // the visual system (style_kit) is surfaced so the user approves the look at gate B
    expect(out).toContain('Look: palette #111 #fff · fonts Inter');
    // ordered primaries appear as numbered lines
    expect(out).toMatch(/1\. \[hook\] edit clipA \[12–20s\]/);
    expect(out).toMatch(/2\. \[body\] compose stat-card/);
    // overlay nested under its `over` target
    expect(out).toContain('└ overlay: compose lower-third');
    expect(out).toContain('Narration: voice=zh_male_jieshuoxiaoming_uranus_bigtts');
    expect(out).toContain('ducked under narration');
    expect(out).toContain('Cost: 0 billable generation(s)');
  });
});

describe('decision-layer audit fields (reason / evidence / confidence)', () => {
  it('validateEdl tolerates a segment carrying evidence/reason/confidence', () => {
    const plan = validPlan();
    const hook = plan.segments[0]!;
    hook.reason = 'kept the clearest take';
    hook.confidence = 0.9;
    hook.evidence = { removed_spans: [{ startSec: 2, endSec: 4 }], removed_sec: 2 };
    const r = validateEdl(plan);
    expect(r.ok).toBe(true);
    expect(r.errors).toEqual([]);
  });

  it('summarizeEdl surfaces a segment reason on its timeline line', () => {
    const plan = validPlan();
    plan.segments[0]!.reason = 'removed 2 silent spans (1.8s)';
    const out = summarizeEdl(plan);
    expect(out).toMatch(/1\. \[hook\] .*· removed 2 silent spans \(1\.8s\)/);
  });
});
