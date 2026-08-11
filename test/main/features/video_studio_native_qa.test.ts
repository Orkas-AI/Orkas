import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import sharp from 'sharp';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  buildSpeechTranscribeArgs,
  buildInspectScript,
  buildFrameEncoderArgs,
  buildRenderReuseKey,
  buildSceneIsolationProbeScript,
  buildSceneSegmentKey,
  buildVideoTrackRemuxArgs,
  compositionFileUrlForTest,
  computeSceneFrameRanges,
  draftComposition,
  evaluateVideoTrackReuse,
  readCompositionWindowVector,
  summarizeSceneIsolation,
  inspectComposition,
  isCompositionRequestUrlAllowed,
  isWindowsNativeRuntimeIncompatible,
  lintComposition,
  materializeVideoCover,
  preflightComposition,
  prepareComposition,
  pruneSegmentCache,
  previewArtifactPaths,
  previewEvidenceRunDir,
  normalizeWhisperTranscript,
  normalizeCapturedFrame,
  captureContradictsDom,
  renderComposition,
  resolveSpeechTranscribeBackend,
  runVideoProcessForTest,
  selectSafeFinalRenderFps,
  shouldNormalizeLoudness,
  transcribeSpeech,
  videoCoverArtifactPath,
  videoStudioReferencedVisualAssetSignature,
  withVideoStudioTimeout,
} from '../../../src/main/features/video_studio';
import {
  authoredAbsoluteTimelinePositions,
  buildCompositionNarrationMap,
  buildCompositionScaffold,
  CompositionManifestSchema,
  compositionNarrationText,
  decomposeCompositionSceneAttribution,
  ensureCompositionManifest,
  normalizeCompositionHtmlForVisualIdentity,
  reconcileCompositionHtml,
  retimeCompositionManifestForNarration,
} from '../../../src/main/features/video_studio_contract';
import {
  isVideoProductionOpAllowed,
  nextVideoProductionOps,
  readVideoProductionState,
  recordVideoProductionTransition,
  updateVideoProductionState,
} from '../../../src/main/features/video_studio_state';
import { registerProducedOutputHooks } from '../../../src/main/features/produced_output_hooks';
import {
  buildDesignReviewInputs,
  buildInspectFrameSamplePlan,
  buildPreviewFrameSamplePlan,
  compareVisualBaseline,
  compileVideoStudioDesignQualityScorecard,
  dedupeInspectIssues,
  isEnvironmentalDraftFailure,
  isSuspiciousCrossSceneDuplicate,
  loadDesignContract,
  loadNarrationMap,
  loadSceneMap,
  normalizeDraftInspectIssueSeverities,
  qaFindingIsWaivable,
  runContractHtmlQa,
  runAudioTimingQa,
  runSourceAlignmentQa,
  assertVideoStudioDesignQualityVerdict,
  summarizeDraftInspectDisposition,
  summarizeVideoFrameQa,
  writeFrameContactSheet,
  writeVisualBaseline,
  type CompositionMeta,
  type FrameEvidence,
} from '../../../src/main/features/video_studio_qa';
import { extractCssImports, extractHtmlResourceRefs, parseHtmlStructure } from '../../../src/main/features/video_studio_html_check';
import { bundledFfmpegPaths } from '../../../src/main/util/bundled-runtime';
import {
  createVideoStudioTool,
  approveVideoStudioGate,
  recordVideoStudioGate,
  resultConsumesFullRenderTurnBudget,
  validateCompositionFrameEvidence,
  validateVideoStudioGate,
  videoStudioCompositionSignature,
  videoStudioVisualCompositionSignature,
  videoStudioPreviewRequired,
} from '../../../src/main/model/core-agent/video-studio-tool';

function tmpProject(label: string) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `orkas-native-video-${label}-`));
  const compositionDir = path.join(root, 'project', 'composition');
  fs.mkdirSync(compositionDir, { recursive: true });
  return {
    root,
    compositionDir,
    renderDir: path.join(root, 'project', 'render'),
    reportPath: path.join(root, 'project', 'render', 'draft-report.json'),
    outputPath: path.join(root, 'project', 'render', 'draft.mp4'),
  };
}

function writeHtml(compositionDir: string, text: string, attrs: { width?: number; height?: number; duration?: number } = {}) {
  const width = attrs.width ?? 1920;
  const height = attrs.height ?? 1080;
  const duration = attrs.duration ?? 10;
  fs.writeFileSync(path.join(compositionDir, 'index.html'), [
    '<!doctype html>',
    '<html><body>',
    `<main data-composition-id="main" data-width="${width}" data-height="${height}" data-duration="${duration}">`,
    `<section class="clip" data-scene-id="cover" data-start="0" data-duration="${duration}"><h1 data-role="title">${text}</h1></section>`,
    '</main>',
    '</body></html>',
  ].join('\n'), 'utf8');
}

function writeHtmlWithAudio(compositionDir: string, text: string, attrs: { width?: number; height?: number; duration?: number } = {}) {
  const width = attrs.width ?? 1920;
  const height = attrs.height ?? 1080;
  const duration = attrs.duration ?? 10;
  fs.writeFileSync(path.join(compositionDir, 'index.html'), [
    '<!doctype html>',
    '<html><body>',
    `<main data-composition-id="main" data-width="${width}" data-height="${height}" data-duration="${duration}">`,
    `<audio src="./assets/narration.mp3" data-start="0" data-duration="${duration}"></audio>`,
    `<section class="clip" data-scene-id="cover" data-start="0" data-duration="${duration}"><h1 data-role="title">${text}</h1></section>`,
    '</main>',
    '</body></html>',
  ].join('\n'), 'utf8');
}

function writeContract(compositionDir: string, overrides: Record<string, unknown> = {}) {
  fs.writeFileSync(path.join(compositionDir, 'design-contract.json'), JSON.stringify({
    canvas: { width: 1920, height: 1080, duration: 10, fps: 30 },
    scenes: [{ id: 'cover', start: 0, duration: 10, headline: 'Launch' }],
    ...overrides,
  }, null, 2), 'utf8');
}

function writeSceneMap(compositionDir: string, overrides: Record<string, unknown> = {}) {
  fs.writeFileSync(path.join(compositionDir, 'scene-map.json'), JSON.stringify({
    canvas: { width: 1920, height: 1080, duration: 10, fps: 30 },
    scenes: [{ id: 'cover', start: 0, duration: 10, headline: 'Launch', narration: 'Launch narration.' }],
    ...overrides,
  }, null, 2), 'utf8');
}

function completeArtDirection(sceneIds: string[] = ['cover']): Record<string, unknown> {
  const sceneDuration = 10 / Math.max(sceneIds.length, 1);
  return {
    aesthetic: {
      subject_world: 'editorial launch surface with measured signal marks',
      one_job: 'make the launch promise readable at video scale',
      signature_device: 'a measured signal path that anchors each frame',
      aesthetic_risk: 'avoid generic cards by using one strong visual axis',
      anti_template_check: 'reject centered cards and decorative blobs; use a measured signal path and editorial scale',
    },
    visual_direction: {
      visual_tradition: 'Swiss Pulse precision grid',
      lazy_defaults_rejected: 'reject centered cards and decorative blobs; replace with editorial scale and a measured signal path',
      video_scale: { hero_title_min_px: 88, label_min_px: 28, safe_zone_px: { left: 120, right: 120, top: 90, bottom: 90 } },
      depth_layer_rule: 'quiet field, dominant signal/title layer, foreground measurement accents',
      motion_verb_rule: ['draw', 'align', 'resolve'],
      rhythm_pattern: 'quick hook, measured hold, clear payoff',
    },
    cover: {
      scene_id: sceneIds[0] || 'cover',
      headline: 'Launch',
      content_signals: ['launch subject', 'measured signal path'],
      hero_visual: 'the launch subject locked to a measured signal path',
      composition_strategy: 'large approved promise plus topic-specific hero in one readable thumbnail frame',
      frame_time_sec: 0,
    },
    scenes: sceneIds.map((id, index) => ({
      id,
      start: index * sceneDuration,
      duration: sceneDuration,
      scene_world: 'editorial signal field',
      hero_visual: 'large readable title anchored by a measured signal path',
      depth_layers: ['quiet field', 'signal/title layer', 'measurement accents'],
      motion_verbs: ['draw', 'resolve'],
    })),
    layout_boxes: { safe_margin: 96, visual_zone: 'full-field hero visual' },
    typography_tokens: { title: 'display >= 88px', body: 'supporting 32px', label: 'technical label >= 28px' },
    color_tokens: { bg: '#071018', ink: '#f3efe6', accent: '#f2a900' },
    motion_budget: { rule: 'resolved frame first, then purposeful entrance motion' },
    scene_variation: { rule: 'vary focal mass and framing when multiple scenes exist' },
  };
}

const coverQaHeadline = 'Execution is cheap. Attention is not.';
const coverQaSignals = ['compression queues', 'attention bottleneck'];

function summarizeCoverHardGateFixture(options: {
  headlineText?: string;
  headlineRole?: string;
  signals?: string[];
  hero?: Record<string, unknown> | null;
  extraElements?: Array<Record<string, unknown>>;
  includeVisibleElements?: boolean;
  language?: string;
  approvedCopy?: string[];
} = {}) {
  const {
    headlineText = coverQaHeadline,
    headlineRole = 'title',
    signals = coverQaSignals,
    hero = {
      role: 'visual',
      cover_hero: true,
      width_ratio: 0.4,
      height_ratio: 0.3,
      area_ratio: 0.12,
    },
    extraElements = [],
    includeVisibleElements = true,
    language = 'en',
    approvedCopy = [coverQaHeadline, 'BETA'],
  } = options;
  const visibleElements: Array<Record<string, unknown>> = [
    {
      role: headlineRole,
      text: headlineText,
    },
    ...signals.map((signal) => ({
      role: 'visual',
      cover_signal: signal,
      width_ratio: 0.3,
      height_ratio: 0.1,
      area_ratio: 0.03,
    })),
    ...(hero ? [hero] : []),
    ...extraElements,
  ];

  return summarizeVideoFrameQa({
    evidence_dir: '/tmp/evidence',
    contact_sheet: '/tmp/contact-sheet.svg',
    frame_paths: ['/tmp/cover.png'],
    samples: [
      {
        label: 'first-frame',
        time_seconds: 0,
        frame_index: 0,
        path: '/tmp/cover.png',
        hash: 'cover-hash',
        brightness: 64,
        contrast: 24,
        width: 1920,
        height: 1080,
        expected_scene_id: 'cover',
        visible_scene_ids: ['cover'],
        visible_roles: ['title', 'visual'],
        visible_text: headlineText,
        ...(includeVisibleElements
          ? {
              visible_elements: visibleElements,
            }
          : {}),
      },
    ],
  }, 10, {
    sceneCount: 1,
    expectedSceneIds: ['cover'],
    requireSemanticCoverage: true,
    designContract: {
      cover: {
        scene_id: 'cover',
        headline: coverQaHeadline,
        content_signals: coverQaSignals,
        hero_visual: 'a flow resolving around the attention bottleneck',
        composition_strategy: 'large promise plus explanatory flow',
        frame_time_sec: 0,
      },
    },
    sceneMap: {
      canvas: {
        language,
      },
      scenes: [
        {
          id: 'cover',
          approved_copy: approvedCopy,
        },
      ],
    },
  });
}

function writeManifest(compositionDir: string, overrides: Record<string, unknown> = {}) {
  fs.writeFileSync(path.join(compositionDir, 'composition-manifest.json'), JSON.stringify({
    schema_version: 1,
    composition: { id: 'main', width: 1920, height: 1080, duration: 10, fps: 30, language: 'en' },
    scenes: [{
      id: 'cover',
      start: 0,
      duration: 10,
      approved_copy: ['Launch'],
      narration_refs: [],
      source_shots: [],
      roles: ['title', 'visual'],
    }],
    audio: { owner: 'none', tracks: [] },
    art_direction: completeArtDirection(),
    ...overrides,
  }, null, 2), 'utf8');
}

const ENV_KEYS = [
  'ORKAS_BUNDLED_FFMPEG',
  'ORKAS_BUNDLED_FFPROBE',
  'ORKAS_RUNTIME_DIR',
  'ORKAS_WHISPER_CPP',
  'ORKAS_WHISPER_CLI',
  'ORKAS_WHISPER_MODEL',
] as const;
const originalEnv = new Map<string, string | undefined>();
for (const key of ENV_KEYS) originalEnv.set(key, process.env[key]);

afterEach(() => {
  for (const key of ENV_KEYS) {
    const original = originalEnv.get(key);
    if (original === undefined) delete process.env[key];
    else process.env[key] = original;
  }
});

function writeExecutable(file: string, body: string) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body, 'utf8');
  fs.chmodSync(file, 0o755);
}

describe('native VideoStudio draft QA parity', () => {
  it('exposes QA-gated export instead of raw render to the agent', () => {
    const tool = createVideoStudioTool({ userId: 'test-user', turnId: 'turn-1' });
    const ops = ((tool.inputSchema.properties as Record<string, { enum?: string[] }>).op.enum || []);
    expect(ops).toContain('composition.prepare');
    expect(ops).toContain('composition.status');
    expect(ops).toContain('composition.doctor');
    expect(ops).toContain('composition.reconcile');
    expect(ops).toContain('composition.approve_plan');
    expect(ops).toContain('composition.materialize_narration');
    expect(ops).toContain('composition.approve_draft');
    expect(ops).toContain('composition.export');
    expect(ops).not.toContain('composition.render');
    // The keyframe preview stop is prose-only: the host records no preview
    // approval, so the operation must not exist at all.
    expect(ops).not.toContain('composition.approve_preview');
    expect(ops).not.toContain('production.approve_preview');
  });

  it('describes the enforced keyframe stop using only operations the tool exposes', () => {
    // The runtime test later in this file proves that composition.draft is
    // refused until a subsequent real user reply. The public tool contract and
    // shipped agent metadata must tell the model the same thing; otherwise the
    // model follows the schema, retries the refused render, or invents a gate
    // operation that cannot be called.
    const tool = createVideoStudioTool({ userId: 'test-user', turnId: 'turn-1' });
    const opSchema = (tool.inputSchema.properties as Record<string, {
      enum?: string[];
      description?: string;
    }>).op;
    const description = String(opSchema.description || '');
    const ops = opSchema.enum || [];
    const root = process.cwd();
    const agent = JSON.parse(fs.readFileSync(path.join(
      root,
      'resources/builtin/marketplace/agents/79df9cc89f5f/agent.json',
    ), 'utf8')) as { knowhow?: string[] };
    const knowhow = (agent.knowhow || []).join('\n');

    expect.soft(description).not.toMatch(/preview frames[\s\S]{0,120}keep working/i);
    expect.soft(description).toMatch(/keyframe preview[\s\S]{0,160}end the current turn/i);
    expect.soft(description).toMatch(/(?:subsequent|later) real user (?:reply|turn)/i);
    expect.soft(ops).not.toContain('composition.approve_preview');
    expect.soft(knowhow).not.toContain('composition.approve_preview');
    expect.soft(knowhow).toMatch(/ends the current turn/i);
  });

  it('migrates legacy gates into VideoProductionStateV1 and persists stage revisions', async () => {
    const p = tmpProject('production-state-migration');
    const statePath = path.join(p.root, 'private-production-state.json');
    fs.writeFileSync(statePath, JSON.stringify({
      preview: {
        signature: 'legacy-signature',
        turn_id: 'turn-preview',
        created_at: new Date().toISOString(),
        status: 'approved',
        approved_turn_id: 'turn-approve',
        approved_at: new Date().toISOString(),
        validation_version: 1,
      },
    }), 'utf8');

    const migrated = await readVideoProductionState(statePath, p.compositionDir);
    expect(migrated).toMatchObject({ schema_version: 1, revision: 0, stage: 'preview_approved' });
    expect(nextVideoProductionOps(migrated)).toEqual(expect.arrayContaining(['composition.approve_plan', 'composition.status', 'composition.reconcile']));
    expect(nextVideoProductionOps(migrated)).not.toContain('composition.draft');

    const updated = await updateVideoProductionState(statePath, p.compositionDir, (state) => {
      state.stage = 'draft_ready';
      recordVideoProductionTransition(state, {
        op: 'composition.draft',
        status: 'passed',
        turnId: 'turn-draft',
        stage: 'draft_ready',
      });
    });
    expect(updated).toMatchObject({ schema_version: 1, revision: 1, stage: 'draft_ready' });
    expect(updated.last_operation).toMatchObject({ revision: 1, op: 'composition.draft', status: 'passed' });
    expect(nextVideoProductionOps(updated)).toEqual(expect.arrayContaining(['composition.approve_plan', 'composition.status', 'composition.reconcile']));
    expect(JSON.parse(fs.readFileSync(statePath, 'utf8'))).toMatchObject({ schema_version: 1, revision: 1 });
  });

  it('admits orthogonal visual work from current facts without consulting the compatibility stage', async () => {
    const p = tmpProject('narration-policy');
    const statePath = path.join(p.root, 'production-state.json');
    const state = await updateVideoProductionState(statePath, p.compositionDir, (next) => {
      next.plan_approval = {
        gate: 'B',
        signature: 'approved-plan',
        turn_id: 'turn-plan',
        approved_at: new Date().toISOString(),
        artifact_paths: [],
        validation_version: 1,
      };
      next.stage = 'scaffold_ready';
    });

    const pendingOps = nextVideoProductionOps(state, {
      narrationRequired: true,
      narrationMaterialized: false,
    });
    expect(pendingOps).toContain('composition.materialize_narration');
    expect(pendingOps).toContain('composition.lint');
    expect(pendingOps).toContain('composition.inspect');
    expect(pendingOps).toContain('composition.snapshot');
    expect(pendingOps).not.toContain('composition.draft');
    expect(pendingOps).not.toContain('composition.begin_visual_revision');
    expect(nextVideoProductionOps(state)).toContain('composition.materialize_narration');
    state.stage = 'draft_approved';
    expect(isVideoProductionOpAllowed(state, 'composition.inspect', {
      narrationRequired: true,
      narrationMaterialized: false,
    })).toBe(true);
    expect(isVideoProductionOpAllowed(state, 'composition.snapshot', {
      narrationRequired: true,
      narrationMaterialized: false,
    })).toBe(true);
    expect(isVideoProductionOpAllowed(state, 'composition.draft', {
      narrationRequired: true,
      narrationMaterialized: false,
    })).toBe(false);

    const silentOps = nextVideoProductionOps(state, {
      narrationRequired: false,
      narrationMaterialized: true,
    });
    expect(silentOps).toEqual(expect.arrayContaining(['composition.lint', 'composition.inspect']));
  });

  it('retimes the canonical manifest once from measured narration before visual authoring', () => {
    const planned = CompositionManifestSchema.parse({
      schema_version: 1,
      composition: { id: 'main', width: 1920, height: 1080, duration: 20, fps: 30, language: 'zh' },
      scenes: [
        { id: 'hook', start: 0, duration: 8, approved_copy: ['开场'], narration_text: '第一段。', narration_refs: [], source_shots: [], roles: ['title'] },
        { id: 'proof', start: 8, duration: 12, approved_copy: ['证明'], narration_text: '第二段。', narration_refs: [], source_shots: [], roles: ['visual'] },
      ],
      audio: { owner: 'none', tracks: [] },
    });

    expect(compositionNarrationText(planned)).toBe('第一段。\n\n第二段。');
    const materialized = retimeCompositionManifestForNarration(planned, 25);
    expect(materialized.composition.duration).toBe(25);
    expect(materialized.scenes).toEqual([
      expect.objectContaining({ id: 'hook', start: 0, duration: 10 }),
      expect.objectContaining({ id: 'proof', start: 10, duration: 15 }),
    ]);
    expect(materialized.audio).toEqual({
      owner: 'composition',
      tracks: [{ id: 'narration', kind: 'narration', src: 'assets/narration.mp3', start: 0, duration: 25, volume: 1 }],
    });
    expect(CompositionManifestSchema.safeParse(materialized).success).toBe(true);

    const fixedTarget = CompositionManifestSchema.parse({
      ...planned,
      composition: { ...planned.composition, target_duration: 20 },
    });
    const targetPreserved = retimeCompositionManifestForNarration(fixedTarget, 18);
    expect(targetPreserved.composition).toMatchObject({ duration: 20, target_duration: 20 });
    expect(targetPreserved.audio.tracks).toEqual([
      expect.objectContaining({ kind: 'narration', duration: 18 }),
    ]);
    expect(targetPreserved.scenes.at(-1)!.start + targetPreserved.scenes.at(-1)!.duration).toBe(20);

    const lineWeighted = retimeCompositionManifestForNarration(planned, 24, [1, 3]);
    expect(lineWeighted.scenes).toEqual([
      expect.objectContaining({ id: 'hook', start: 0, duration: 6 }),
      expect.objectContaining({ id: 'proof', start: 6, duration: 18 }),
    ]);
    expect(buildCompositionNarrationMap(lineWeighted, {
      textSha256: 'text-hash',
      audioSha256: 'audio-hash',
      method: 'scene_estimate_scaled',
    })).toMatchObject({
      alignment_method: 'scene_estimate_scaled',
      total_duration: 24,
      lines: [
        expect.objectContaining({ scene_id: 'hook', start: 0, duration: 6 }),
        expect.objectContaining({ scene_id: 'proof', start: 6, duration: 18 }),
      ],
    });

    const withSilentPayoff = CompositionManifestSchema.parse({
      ...planned,
      composition: { ...planned.composition, duration: 46, target_duration: 46 },
      scenes: [
        { ...planned.scenes[0], start: 0, duration: 15 },
        { ...planned.scenes[1], start: 15, duration: 15 },
        {
          id: 'payoff', start: 30, duration: 16, approved_copy: ['收尾'],
          narration_text: '', narration_refs: ['stale-payoff-ref'], source_shots: [], roles: ['title'],
        },
      ],
    });
    // Explicit silence clears stale implementation refs, but legacy ref-only
    // scenes (narration_text omitted) remain supported.
    expect(withSilentPayoff.scenes[2].narration_refs).toEqual([]);
    const refOnly = CompositionManifestSchema.parse({
      ...planned,
      scenes: [{ ...planned.scenes[0], narration_text: undefined, narration_refs: ['legacy-line'] }],
      composition: { ...planned.composition, duration: 8 },
    });
    expect(refOnly.scenes[0].narration_refs).toEqual(['legacy-line']);

    const longTake = retimeCompositionManifestForNarration(withSilentPayoff, 48, [1, 1, 16]);
    expect(longTake.composition).toMatchObject({ duration: 64, target_duration: 46 });
    expect(longTake.audio.tracks).toContainEqual(expect.objectContaining({
      kind: 'narration', start: 0, duration: 48,
    }));
    expect(longTake.scenes.find((scene) => scene.id === 'payoff')).toMatchObject({
      start: 48,
      duration: 16,
      narration_refs: [],
    });
    const longTakeMap = buildCompositionNarrationMap(longTake, {
      textSha256: 'long-text',
      audioSha256: 'long-audio',
      method: 'scene_estimate_scaled',
      audioDurationSec: 48,
    }) as any;
    expect(longTakeMap).toMatchObject({
      narration_audio_start: 0,
      narration_audio_duration: 48,
      narration_audio_end: 48,
      timing_evidence: {
        audio_duration: 'measured_media_probe',
        line_timing: 'scene_projection_over_measured_audio',
      },
    });
    expect(Math.max(...longTakeMap.lines.map((line: any) => line.start + line.duration))).toBe(48);

    // A short take keeps the authored silent payoff at exactly 16 seconds;
    // the delivery hold stays in the last narrated scene. Re-materializing
    // therefore cannot mistake an earlier hold for newly approved silence.
    const shortTake = retimeCompositionManifestForNarration(withSilentPayoff, 20, [1, 1, 16]);
    expect(shortTake.composition).toMatchObject({ duration: 46, target_duration: 46 });
    expect(shortTake.scenes.slice(0, 2)).toEqual([
      expect.objectContaining({ id: 'hook', start: 0, duration: 15 }),
      expect.objectContaining({ id: 'proof', start: 15, duration: 15 }),
    ]);
    expect(shortTake.scenes.find((scene) => scene.id === 'payoff')).toMatchObject({
      start: 30,
      duration: 16,
    });
    const shortTakeMap = buildCompositionNarrationMap(shortTake, {
      textSha256: 'short-text',
      audioSha256: 'short-audio',
      method: 'scene_estimate_scaled',
      audioDurationSec: 20,
    }) as any;
    expect(Math.max(...shortTakeMap.lines.map((line: any) => line.start + line.duration))).toBe(20);
    const rematerialized = retimeCompositionManifestForNarration(shortTake, 25, [1, 1, 16]);
    expect(rematerialized.scenes.find((scene) => scene.id === 'payoff')).toMatchObject({
      start: 30,
      duration: 16,
    });
  });

  it('accepts self-authored visual provenance only under art_direction', () => {
    const base = {
      schema_version: 1 as const,
      composition: {
        id: 'main', width: 1920, height: 1080, duration: 5, fps: 30, language: 'en',
      },
      scenes: [{
        id: 'cover', start: 0, duration: 5, approved_copy: ['Launch'],
        narration_refs: [], source_shots: [], roles: ['title', 'visual'],
      }],
      audio: { owner: 'none' as const, tracks: [] },
    };
    const provenance = {
      visuals: 'self-authored HTML/CSS/SVG',
      user_assets: [],
      third_party_assets: [],
    };

    expect(CompositionManifestSchema.safeParse({
      ...base,
      art_direction: { provenance },
    }).success).toBe(true);
    expect(CompositionManifestSchema.safeParse({
      ...base,
      provenance,
    }).success).toBe(false);
  });

  it('requires and preserves a Gate B narration intent for schema version 2', () => {
    const base = {
      schema_version: 2 as const,
      composition: { id: 'main', width: 1920, height: 1080, duration: 5, target_duration: 5, fps: 30, language: 'zh' },
      scenes: [{
        id: 'hook', start: 0, duration: 5, approved_copy: ['开场'], narration_text: '第一段。',
        narration_refs: [], source_shots: [], roles: ['title'],
      }],
      audio: { owner: 'none' as const, tracks: [] },
    };
    expect(CompositionManifestSchema.safeParse(base).success).toBe(false);
    const planned = CompositionManifestSchema.parse({
      ...base,
      audio: {
        ...base.audio,
        narration_intent: {
          route_ref: 'provider:doubao',
          voice_ref: 'provider:doubao:voice:test-vivi',
          display_name: 'Vivi',
          language: 'zh-CN',
          speed: 1,
        },
      },
    });
    expect(retimeCompositionManifestForNarration(planned, 4.8).audio.narration_intent).toEqual(
      planned.audio.narration_intent,
    );
  });

  it('serializes concurrent production-state revisions and preserves authored HTML while reconciling protected timing/audio', async () => {
    const p = tmpProject('production-state-lock-reconcile');
    const statePath = path.join(p.root, 'private-production-state.json');
    await Promise.all([
      updateVideoProductionState(statePath, p.compositionDir, (state) => {
        recordVideoProductionTransition(state, { op: 'one', status: 'passed' });
      }),
      updateVideoProductionState(statePath, p.compositionDir, (state) => {
        recordVideoProductionTransition(state, { op: 'two', status: 'passed' });
      }),
    ]);
    const state = await readVideoProductionState(statePath, p.compositionDir);
    expect(state.revision).toBe(2);
    expect(state.history).toHaveLength(2);
    expect(isVideoProductionOpAllowed(state, 'composition.draft')).toBe(false);
    await expect(updateVideoProductionState(statePath, p.compositionDir, () => {}, { expectedRevision: 1 }))
      .rejects.toThrow('E_VIDEO_PRODUCTION_STATE_CONFLICT');

    const manifest = CompositionManifestSchema.parse({
      schema_version: 1,
      composition: { id: 'main', width: 1920, height: 1080, duration: 12, fps: 30 },
      scenes: [{ id: 'cover', start: 0, duration: 12, approved_copy: ['Launch'], narration_refs: [], source_shots: [], roles: ['title'] }],
      audio: { owner: 'composition', tracks: [{ id: 'music', kind: 'music', src: 'assets/music.mp3', start: 0, duration: 12, volume: 0.2 }] },
    });
    const authored = '<main data-composition-id="old" data-duration="10" data-width="100" data-height="100"><section data-scene-id="cover" data-start="1" data-duration="9"><svg id="authored-art"></svg></section><audio src="./old.mp3" data-start="0" data-duration="10"></audio></main><script>tl.set("#scene-cover", { autoAlpha: 1 }, 1); const customMotion = true;</script>';
    const reconciled = reconcileCompositionHtml(authored, manifest);
    expect(reconciled).toMatchObject({ ok: true, changed: true });
    expect(reconciled.html).toContain('data-composition-id="main"');
    expect(reconciled.html).toContain('data-duration="12"');
    expect(reconciled.html).toContain('id="authored-art"');
    expect(reconciled.html).toContain('const customMotion = true');
    expect(reconciled.html).toContain('tl.set("#scene-cover", { autoAlpha: 1 }, 0);');
    expect(reconciled.html).toContain('src="./assets/music.mp3"');
    expect(reconciled.html).not.toContain('src="./old.mp3"');
  });

  it('requires current frames to render, and an explicit confirmation only for the final video', async () => {
    const p = tmpProject('hard-gates');
    writeHtml(p.compositionDir, 'Launch', { duration: 60 });
    writeSceneMap(p.compositionDir, {
      canvas: { width: 1920, height: 1080, duration: 60, fps: 30 },
      scenes: Array.from({ length: 7 }, (_, index) => ({
        id: `s${index + 1}`,
        start: index * 8,
        duration: index === 6 ? 12 : 8,
        headline: `Scene ${index + 1}`,
      })),
    });
    const gatePath = path.join(p.root, 'private-gate.json');

    // A long composition may not be rendered from HTML nobody captured, but the
    // evidence is the snapshot itself — the user is shown the frames and the
    // work continues, so no approval exists to wait for.
    expect(await videoStudioPreviewRequired(p.compositionDir)).toBe(true);
    await expect(validateCompositionFrameEvidence(gatePath, p.compositionDir)).resolves.toMatchObject({
      ok: false,
      errorCode: 'E_HTML_PREVIEW_REQUIRED',
    });
    await expect(recordVideoStudioGate(gatePath, 'preview', p.compositionDir, 'turn-preview', {
      preview_ready: true,
      preview_qa: { ok: true, error_count: 0 },
      preflight: { status: 'passed', blocking_error_count: 0 },
      contact_sheet: path.join(p.compositionDir, 'preview', 'contact-sheet.svg'),
    })).resolves.toBe(true);
    // Captured in this same turn is already enough: there is no "must come from
    // a later user turn" rule left, because nobody is being asked.
    await expect(validateCompositionFrameEvidence(gatePath, p.compositionDir)).resolves.toMatchObject({ ok: true });
    // A QA-output-only change keeps the visual identity, so the frames stand.
    fs.writeFileSync(path.join(p.compositionDir, 'draft-qa.json'), JSON.stringify({ attempt: 2 }), 'utf8');
    await expect(validateCompositionFrameEvidence(gatePath, p.compositionDir)).resolves.toMatchObject({ ok: true });

    await expect(recordVideoStudioGate(gatePath, 'draft', p.compositionDir, 'turn-draft', {
      draft_ready: true,
      path: p.outputPath,
      report_path: p.reportPath,
    })).resolves.toBe(true);
    await expect(validateVideoStudioGate(gatePath, 'draft', p.compositionDir, 'turn-draft')).resolves.toMatchObject({
      ok: false,
      errorCode: 'E_GATE_D_APPROVAL_REQUIRED',
    });
    await expect(validateVideoStudioGate(gatePath, 'draft', p.compositionDir, 'turn-export')).resolves.toMatchObject({
      ok: false,
      errorCode: 'E_GATE_D_APPROVAL_REQUIRED',
    });
    await expect(approveVideoStudioGate(gatePath, 'draft', p.compositionDir, 'turn-export', false)).resolves.toMatchObject({
      ok: false,
      errorCode: 'E_GATE_D_EXPLICIT_APPROVAL_REQUIRED',
    });
    await expect(approveVideoStudioGate(gatePath, 'draft', p.compositionDir, 'turn-export', true)).resolves.toMatchObject({ ok: true });
    await expect(validateVideoStudioGate(gatePath, 'draft', p.compositionDir, 'turn-export')).resolves.toMatchObject({ ok: true });

    fs.mkdirSync(path.join(p.compositionDir, 'assets'), { recursive: true });
    fs.writeFileSync(path.join(p.compositionDir, 'assets', 'changed.txt'), 'changed', 'utf8');
    await expect(validateVideoStudioGate(gatePath, 'draft', p.compositionDir, 'turn-export')).resolves.toMatchObject({
      ok: false,
      errorCode: 'E_DRAFT_FROZEN_INPUT_CHANGED',
    });
  });

  it('fails closed when a v2 approval cannot prove the current v3 inputs', async () => {
    const p = tmpProject('gate-v3-runtime-report-migration');
    writeHtml(p.compositionDir, 'Approved source', { duration: 60 });
    const gatePath = path.join(p.root, 'private-gate.json');
    fs.writeFileSync(path.join(p.compositionDir, 'draft-qa.json'), JSON.stringify({ attempt: 1 }), 'utf8');
    const approvedV2Signature = await videoStudioCompositionSignature(p.compositionDir, 2);
    await updateVideoProductionState(gatePath, p.compositionDir, (state) => {
      state.stage = 'preview_approved';
      state.preview = {
        signature: approvedV2Signature,
        turn_id: 'turn-preview',
        created_at: new Date().toISOString(),
        status: 'approved',
        approved_turn_id: 'turn-approve',
        approved_at: new Date().toISOString(),
        validation_version: 2,
      };
    });
    fs.writeFileSync(path.join(p.compositionDir, 'draft-qa.json'), JSON.stringify({ attempt: 2, error: 'runtime-only' }), 'utf8');

    await expect(validateCompositionFrameEvidence(gatePath, p.compositionDir))
      .resolves.toMatchObject({ ok: false, errorCode: 'E_HTML_PREVIEW_STALE' });
    const migrated = await readVideoProductionState(gatePath, p.compositionDir);
    expect(migrated.preview).toMatchObject({
      signature: approvedV2Signature,
      status: 'approved',
      validation_version: 2,
    });
  });

  it('does not trust a backdated mtime when a v2-approved input changes', async () => {
    const p = tmpProject('gate-v3-authored-change');
    writeHtml(p.compositionDir, 'Approved source', { duration: 60 });
    fs.writeFileSync(path.join(p.compositionDir, 'draft-qa.json'), JSON.stringify({ attempt: 1 }), 'utf8');
    const gatePath = path.join(p.root, 'private-gate.json');
    const signature = await videoStudioCompositionSignature(p.compositionDir, 2);
    const approvedAt = new Date();
    await updateVideoProductionState(gatePath, p.compositionDir, (state) => {
      state.stage = 'preview_approved';
      state.preview = {
        signature,
        turn_id: 'turn-preview',
        created_at: approvedAt.toISOString(),
        status: 'approved',
        approved_turn_id: 'turn-approve',
        approved_at: approvedAt.toISOString(),
        validation_version: 2,
      };
    });
    writeHtml(p.compositionDir, 'Changed after approval', { duration: 60 });
    const backdated = new Date(approvedAt.getTime() - 2_000);
    fs.utimesSync(path.join(p.compositionDir, 'index.html'), backdated, backdated);

    await expect(validateCompositionFrameEvidence(gatePath, p.compositionDir))
      .resolves.toMatchObject({ ok: false, errorCode: 'E_HTML_PREVIEW_STALE' });
    expect((await readVideoProductionState(gatePath, p.compositionDir)).preview?.validation_version).toBe(2);
  });

  it('migrates a legacy-tagged approval whose signature exactly matches current authored inputs', async () => {
    const p = tmpProject('gate-v3-exact-signature-migration');
    writeHtml(p.compositionDir, 'Approved source', { duration: 60 });
    const gatePath = path.join(p.root, 'private-gate.json');
    const signature = await videoStudioCompositionSignature(p.compositionDir, 3);
    await updateVideoProductionState(gatePath, p.compositionDir, (state) => {
      state.stage = 'preview_approved';
      state.preview = {
        signature,
        turn_id: 'turn-preview',
        created_at: new Date().toISOString(),
        status: 'approved',
        approved_turn_id: 'turn-approve',
        approved_at: new Date().toISOString(),
        validation_version: 2,
      };
    });

    await expect(validateCompositionFrameEvidence(gatePath, p.compositionDir))
      .resolves.toMatchObject({ ok: true, entry: { validation_version: 5 } });
    expect((await readVideoProductionState(gatePath, p.compositionDir)).preview).toMatchObject({
      signature,
      visual_signature: expect.stringMatching(/^[a-f0-9]{64}$/),
      validation_version: 5,
    });
  });

  it('migrates a current v4 preview before legacy outputs change during draft rendering', async () => {
    const p = tmpProject('gate-v5-legacy-outputs-migration');
    writeHtml(p.compositionDir, 'Approved source', { duration: 60 });
    const outputsDir = path.join(p.compositionDir, 'outputs');
    fs.mkdirSync(outputsDir, { recursive: true });
    fs.writeFileSync(path.join(outputsDir, 'draft.mp4'), 'old runtime output', 'utf8');
    const gatePath = path.join(p.root, 'private-gate.json');
    const v4Signature = await videoStudioCompositionSignature(p.compositionDir, 4);
    const v5Signature = await videoStudioCompositionSignature(p.compositionDir, 5);
    expect(v4Signature).not.toBe(v5Signature);
    await updateVideoProductionState(gatePath, p.compositionDir, (state) => {
      state.stage = 'preview_approved';
      state.preview = {
        signature: v4Signature,
        turn_id: 'turn-preview',
        created_at: new Date().toISOString(),
        status: 'approved',
        approved_turn_id: 'turn-approve',
        approved_at: new Date().toISOString(),
        validation_version: 4,
      };
    });

    await expect(validateCompositionFrameEvidence(gatePath, p.compositionDir))
      .resolves.toMatchObject({ ok: true, entry: { validation_version: 5 } });
    expect((await readVideoProductionState(gatePath, p.compositionDir)).preview).toMatchObject({
      signature: v5Signature,
      visual_signature: expect.stringMatching(/^[a-f0-9]{64}$/),
      validation_version: 5,
    });

    fs.writeFileSync(path.join(outputsDir, 'draft.mp4'), 'new runtime output', 'utf8');
    fs.mkdirSync(path.join(outputsDir, 'draft-evidence'), { recursive: true });
    fs.writeFileSync(path.join(outputsDir, 'draft-evidence', '01-first-frame.png'), 'frame');
    await expect(validateCompositionFrameEvidence(gatePath, p.compositionDir))
      .resolves.toMatchObject({ ok: true, entry: { validation_version: 5 } });
  });

  it('normalizes legacy start_s/duration_s once into the canonical manifest', async () => {
    const p = tmpProject('manifest-migration');
    writeContract(p.compositionDir, {
      canvas: { width: 1080, height: 1920, duration_s: 12, fps: 30 },
      scenes: [],
    });
    fs.writeFileSync(path.join(p.compositionDir, 'scene-map.json'), JSON.stringify({
      width: 1080,
      height: 1920,
      duration_s: 12,
      fps: 30,
      scenes: [
        { id: 'hook', start_s: 0, duration_s: 4, headline: 'The promise' },
        { id: 'body', start_s: 4, duration_s: 4, headline: 'The proof' },
        { id: 'payoff', start_s: 8, duration_s: 4, headline: 'The payoff' },
      ],
    }, null, 2), 'utf8');

    const loaded = await ensureCompositionManifest(p.compositionDir);

    expect(loaded).toMatchObject({ ok: true, source: 'legacy_migration', wroteManifest: true });
    expect(loaded.manifest?.composition).toMatchObject({ width: 1080, height: 1920, duration: 12, fps: 30 });
    expect(loaded.manifest?.scenes).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'hook', start: 0, duration: 4 }),
      expect.objectContaining({ id: 'payoff', start: 8, duration: 4 }),
    ]));
    expect(CompositionManifestSchema.safeParse(JSON.parse(
      fs.readFileSync(path.join(p.compositionDir, 'composition-manifest.json'), 'utf8'),
    )).success).toBe(true);
  });

  it('treats legacy contract files as non-authoritative after a canonical manifest exists', async () => {
    const p = tmpProject('manifest-single-source');
    writeManifest(p.compositionDir);
    writeHtml(p.compositionDir, 'Launch');
    fs.writeFileSync(path.join(p.compositionDir, 'design-contract.json'), '{broken legacy json', 'utf8');
    fs.writeFileSync(path.join(p.compositionDir, 'scene-map.json'), '{also broken', 'utf8');

    const preflight = await preflightComposition({ compositionDirAbs: p.compositionDir });
    expect(preflight).toMatchObject({ ok: true, report: expect.objectContaining({ status: 'passed' }) });

    const gatePath = path.join(p.root, 'private-gate.json');
    await expect(recordVideoStudioGate(gatePath, 'preview', p.compositionDir, 'turn-preview', {
      preview_ready: true,
      preview_qa: { ok: true, error_count: 0 },
      preflight: { status: 'passed', blocking_error_count: 0 },
      contact_sheet: path.join(p.compositionDir, 'preview', 'contact-sheet.svg'),
    })).resolves.toBe(true);
    fs.writeFileSync(path.join(p.compositionDir, 'scene-map.json'), '{changed ignored legacy json', 'utf8');
    await expect(validateCompositionFrameEvidence(gatePath, p.compositionDir)).resolves.toMatchObject({ ok: true });
  });

  it('rejects manifest timeline gaps and audio paths that escape the composition', async () => {
    const p = tmpProject('manifest-semantics');
    writeManifest(p.compositionDir, {
      scenes: [
        { id: 'hook', start: 0, duration: 4, approved_copy: ['Hook'], narration_refs: [], source_shots: [], roles: ['title'] },
        { id: 'payoff', start: 5, duration: 5, approved_copy: ['Payoff'], narration_refs: [], source_shots: [], roles: ['title'] },
      ],
      audio: {
        owner: 'composition',
        tracks: [{ id: 'music', kind: 'music', src: '../outside.mp3', start: 0, duration: 10, volume: 0.2 }],
      },
    });

    const loaded = await ensureCompositionManifest(p.compositionDir);

    expect(loaded).toMatchObject({ ok: false, source: 'manifest', manifest: null });
    expect(loaded.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'COMPOSITION_MANIFEST_SCENE_GAP' }),
      expect.objectContaining({ code: 'COMPOSITION_MANIFEST_AUDIO_PATH_INVALID' }),
    ]));
  });

  it('rejects English all-caps primary copy before plan approval while preserving one bounded metadata accent', async () => {
    const rejectedProject = tmpProject('manifest-uppercase-primary');
    writeManifest(rejectedProject.compositionDir, {
      scenes: [{
        id: 'cover',
        start: 0,
        duration: 10,
        approved_copy: ['EXECUTION IS CHEAP. ATTENTION IS NOT.'],
        narration_refs: [],
        source_shots: [],
        roles: ['title', 'visual'],
      }],
    });

    const rejected = await ensureCompositionManifest(rejectedProject.compositionDir);

    expect(rejected).toMatchObject({ ok: false, source: 'manifest', manifest: null });
    expect(rejected.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: 'COMPOSITION_MANIFEST_PRIMARY_COPY_ALL_CAPS',
        sceneId: 'cover',
      }),
    ]));

    const acceptedProject = tmpProject('manifest-uppercase-accent');
    writeManifest(acceptedProject.compositionDir, {
      scenes: [{
        id: 'cover',
        start: 0,
        duration: 10,
        approved_copy: ['Execution is cheap. Attention is not.', 'BETA'],
        narration_refs: [],
        source_shots: [],
        roles: ['title', 'label', 'visual'],
      }],
    });

    await expect(ensureCompositionManifest(acceptedProject.compositionDir))
      .resolves.toMatchObject({ ok: true, source: 'manifest' });
  });

  it.each([
    {
      name: 'single-word primary headline',
      language: 'en',
      approvedCopy: ['WRITE'],
      roles: ['title', 'visual'],
    },
    {
      name: 'multiple uppercase accents',
      language: 'en',
      approvedCopy: ['Execution is cheap. Attention is not.', 'BETA', 'ALPHA'],
      roles: ['title', 'label', 'visual'],
    },
    {
      name: 'regional English language code',
      language: 'en-US',
      approvedCopy: ['EXECUTION IS CHEAP. ATTENTION IS NOT.'],
      roles: ['title', 'visual'],
    },
  ])('rejects $name in the canonical English manifest', async ({
    name,
    language,
    approvedCopy,
    roles,
  }) => {
    const project = tmpProject(`manifest-casing-reject-${name.replace(/\W+/g, '-')}`);
    writeManifest(project.compositionDir, {
      composition: {
        id: 'main',
        width: 1920,
        height: 1080,
        duration: 10,
        fps: 30,
        language,
      },
      scenes: [{
        id: 'cover',
        start: 0,
        duration: 10,
        approved_copy: approvedCopy,
        narration_refs: [],
        source_shots: [],
        roles,
      }],
    });

    const result = await ensureCompositionManifest(project.compositionDir);

    expect(result).toMatchObject({
      ok: false,
      source: 'manifest',
      manifest: null,
    });
    expect(result.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: 'COMPOSITION_MANIFEST_PRIMARY_COPY_ALL_CAPS',
        sceneId: 'cover',
      }),
    ]));
  });

  it.each([
    {
      name: 'natural sentence case',
      language: 'en',
      approvedCopy: ['Execution is cheap. Attention is not.'],
      roles: ['title', 'visual'],
    },
    {
      name: 'short acronym in a primary role',
      language: 'en',
      approvedCopy: ['AI'],
      roles: ['title', 'visual'],
    },
    {
      name: 'short code in a primary role',
      language: 'en',
      approvedCopy: ['GPT-5'],
      roles: ['title', 'visual'],
    },
    {
      name: 'one bounded metadata accent',
      language: 'en',
      approvedCopy: ['Execution is cheap. Attention is not.', 'BETA'],
      roles: ['title', 'label', 'visual'],
    },
    {
      name: 'non-English copy containing a Latin acronym',
      language: 'zh-CN',
      approvedCopy: ['AI 驱动工作流'],
      roles: ['title', 'visual'],
    },
  ])('preserves the allowed casing boundary for $name', async ({
    name,
    language,
    approvedCopy,
    roles,
  }) => {
    const project = tmpProject(`manifest-casing-accept-${name.replace(/\W+/g, '-')}`);
    writeManifest(project.compositionDir, {
      composition: {
        id: 'main',
        width: 1920,
        height: 1080,
        duration: 10,
        fps: 30,
        language,
      },
      scenes: [{
        id: 'cover',
        start: 0,
        duration: 10,
        approved_copy: approvedCopy,
        narration_refs: [],
        source_shots: [],
        roles,
      }],
    });

    await expect(ensureCompositionManifest(project.compositionDir))
      .resolves.toMatchObject({
        ok: true,
        source: 'manifest',
      });
  });

  it('creates the protected seekable scaffold and prepares the local GSAP vendor', async () => {
    const p = tmpProject('native-scaffold');
    writeManifest(p.compositionDir, {
      composition: { id: 'main', width: 1920, height: 1080, duration: 10, fps: 30, language: 'en' },
      scenes: [
        { id: 'hook', start: 0, duration: 5, approved_copy: ['Start here'], narration_refs: [], source_shots: [], roles: ['title', 'visual'] },
        { id: 'payoff', start: 5, duration: 5, approved_copy: ['Finish here'], narration_refs: [], source_shots: [], roles: ['title', 'visual'] },
      ],
    });

    const result = await prepareComposition({ compositionDirAbs: p.compositionDir });
    const html = fs.readFileSync(path.join(p.compositionDir, 'index.html'), 'utf8');

    expect(result).toMatchObject({ ok: true, scaffold_created: true, blocking_error_count: 0 });
    expect(html).toContain('data-composition-id="main"');
    expect(html).toContain('data-scene-id="hook"');
    expect(html).toContain('data-role="title"');
    expect(html).toContain('gsap.timeline({ paused: true })');
    expect(html).toContain('window.__timelines');
    expect(html).not.toContain('.call(');
    expect(fs.statSync(path.join(p.compositionDir, 'assets', 'vendor', 'gsap.min.js')).size).toBeGreaterThan(10_000);
  });

  it('finds approved copy that was split across elements for a per-word reveal', async () => {
    // 2026-08-09 DeepSeek run: the model animated a Chinese headline word by
    // word — the standard way to author a reveal — so index.html's
    // textContent read "用ai 聊过 很多次" while the approved copy is
    // "用AI聊过很多次". The check collapses whitespace runs but keeps them, so
    // a line that carries no spaces of its own can never be found once split,
    // and the run burned rounds on copy that was on screen, in order, the
    // whole time. Latin copy has its own spaces and keeps the exact match.
    const qa = await import('../../../src/main/features/video_studio_qa');
    const p = tmpProject('split-scene-copy');
    writeManifest(p.compositionDir, {
      composition: { id: 'main', width: 1920, height: 1080, duration: 8, fps: 30, language: 'zh-CN' },
      scenes: [{
        id: 'pain', start: 0, duration: 8,
        approved_copy: ['用AI聊过很多次', 'Ship it faster'],
        narration_refs: [], source_shots: [], roles: ['title', 'visual'],
      }],
    });
    const htmlPath = path.join(p.compositionDir, 'index.html');
    fs.writeFileSync(htmlPath, [
      '<!doctype html><html><body>',
      '<main data-composition-id="main" data-width="1920" data-height="1080" data-duration="8">',
      '<section class="clip" data-scene-id="pain" data-start="0" data-duration="8">',
      // Per-word spans: exactly what a reveal animation needs.
      '<h1 data-role="title"><span>用AI</span> <span>聊过</span> <span>很多次</span></h1>',
      '<p data-role="body"><span>Ship it</span> <span>faster</span></p>',
      '</section></main></body></html>',
    ].join('\n'), 'utf8');

    const meta = { html: fs.readFileSync(htmlPath, 'utf8') } as never;
    const contract = { value: JSON.parse(fs.readFileSync(path.join(p.compositionDir, 'composition-manifest.json'), 'utf8')), path: 'composition-manifest.json', exists: true };
    const report = await qa.runContractHtmlQa(
      meta, [], contract as never, contract as never, p.compositionDir, {},
    );
    const codes = ((report.issues as Array<{ code: string; message: string }>) || [])
      .filter((issue) => issue.code === 'HTML_MISSING_SCENE_COPY');
    // The CJK line is found across the spans; the Latin phrase keeps its own
    // spaces and is found the exact way it always was.
    expect(codes).toEqual([]);

    // Negative control: copy that genuinely is not on the page still fails,
    // and a no-space needle is not matched by unrelated adjacent characters.
    writeManifest(p.compositionDir, {
      composition: { id: 'main', width: 1920, height: 1080, duration: 8, fps: 30, language: 'zh-CN' },
      scenes: [{
        id: 'pain', start: 0, duration: 8,
        approved_copy: ['完全没有出现过的文案'],
        narration_refs: [], source_shots: [], roles: ['title', 'visual'],
      }],
    });
    const contract2 = { value: JSON.parse(fs.readFileSync(path.join(p.compositionDir, 'composition-manifest.json'), 'utf8')), path: 'composition-manifest.json', exists: true };
    const missing = await qa.runContractHtmlQa(
      meta, [], contract2 as never, contract2 as never, p.compositionDir, {},
    );
    expect(((missing.issues as Array<{ code: string }>) || []).some((i) => i.code === 'HTML_MISSING_SCENE_COPY'))
      .toBe(true);
  });

  it('sends scene art direction to art_direction.scenes, never to the strict manifest scenes', async () => {
    // 2026-08-08 driven run: the model read "give each non-trivial scene a
    // depth_layers field", added depth_layers / motion_verbs /
    // motion_choreography to the only scenes it could see — the manifest's
    // own — and took E_GATE_B_ARTIFACT_INVALID five times for unrecognized
    // keys. One check demanded what another forbids in the only reachable
    // place. The selector said art_direction.scenes; the fixHint, which is
    // what the model acts on, did not.
    const qa = await import('../../../src/main/features/video_studio_qa');
    const readiness = qa.designContractReadiness({
      scenes: [{ id: 'hook', approved_copy: ['Start'] }],
      art_direction: { aesthetic: { subject_world: 'ink' } },
    });
    const hints = readiness.issues
      .filter((issue) => issue.code === 'SCENE_DEPTH_LAYERS_MISSING' || issue.code === 'SCENE_MOTION_VERBS_MISSING')
      .map((issue) => String(issue.fixHint || ''));
    expect(hints).toHaveLength(2);
    for (const hint of hints) {
      expect(hint).toContain('composition-manifest.json#art_direction.scenes[]');
      expect(hint).toContain("NOT on the manifest's own scenes[]");
    }
    // And the place it names is one the manifest schema actually accepts,
    // which is the whole point: art_direction is free-form, scenes are not.
    const p = tmpProject('scene-art-direction-home');
    writeManifest(p.compositionDir, {
      composition: { id: 'main', width: 1920, height: 1080, duration: 10, fps: 30, language: 'en' },
      scenes: [{ id: 'hook', start: 0, duration: 10, approved_copy: ['Start'], narration_refs: [], source_shots: [], roles: ['title', 'visual'] }],
    });
    const manifestPath = path.join(p.compositionDir, 'composition-manifest.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    manifest.art_direction.scenes = [{ id: 'hook', depth_layers: { background: 'grid', midground: 'hero', foreground: 'label' }, motion_verbs: ['draw'] }];
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');
    await expect(prepareComposition({ compositionDirAbs: p.compositionDir })).resolves.toMatchObject({ ok: true });
    const withScenes = qa.designContractReadiness(JSON.parse(fs.readFileSync(manifestPath, 'utf8')));
    expect(withScenes.issues.map((issue) => issue.code)).not.toContain('SCENE_DEPTH_LAYERS_MISSING');
  });

  it('tells prepare what the design contract still needs, while the HTML is still unwritten', async () => {
    // Every fixHint in the design-contract family says "before writing HTML",
    // and until now the first operation that could say any of them was
    // inspect — which runs after the HTML exists. 2026-08-08: five
    // host-derived child manifests (no art_direction) passed prepare, five
    // pages got written, and inspect blocked five times with instructions
    // addressed to a moment already gone. Prepare is the hand-off to HTML
    // authoring, so it now reports readiness — without blocking, because the
    // contract is authored INTO this manifest next.
    const p = tmpProject('design-readiness');
    writeManifest(p.compositionDir, {
      composition: { id: 'main', width: 1920, height: 1080, duration: 10, fps: 30, language: 'en' },
      scenes: [
        { id: 'hook', start: 0, duration: 10, approved_copy: ['Start'], narration_refs: [], source_shots: [], roles: ['title', 'visual'] },
      ],
    });
    // The fixture writes a complete contract by default; a freshly derived
    // AUTO child manifest has none — that is the incident state.
    const manifestPath = path.join(p.compositionDir, 'composition-manifest.json');
    const derived = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    delete derived.art_direction;
    fs.writeFileSync(manifestPath, JSON.stringify(derived, null, 2), 'utf8');
    const missing = await prepareComposition({ compositionDirAbs: p.compositionDir });
    expect(missing.ok).toBe(true);
    expect(missing.design_contract).toMatchObject({ status: 'missing' });
    const missingIssues = (missing.design_contract as { issues: Array<Record<string, unknown>> }).issues;
    expect(missingIssues[0]).toMatchObject({ code: 'DESIGN_CONTRACT_MISSING' });
    expect(String(missingIssues[0].fixHint)).toContain('BEFORE writing index.html');
    // The no-contract path is the COMMON one — a host-derived AUTO child has
    // no art_direction at all — so it carries the same full shape as the
    // incomplete path. Landing the field lists only on the incomplete message
    // left this entry point on the old two-round track, measured on
    // 2026-08-09 in the run that was verifying that very fix.
    expect(String(missingIssues[0].message)).toContain('aesthetic{subject_world');
    expect(String(missingIssues[0].message)).toContain('visual_direction{visual_tradition');
    expect(String(missingIssues[0].message)).toContain('cover{scene_id');
    expect(String(missingIssues[0].fixHint)).toContain('COMPLETE in one pass');

    // An empty contract shell teaches the WHOLE shape in one round: on
    // 2026-08-08 bare section names took two structurally guaranteed rounds
    // per segment ("add these sections" -> shells -> "each section is missing
    // these fields"), 8 failed calls across 4 segments, while every field
    // list sat in a host constant. The budget message now carries each
    // missing section's own required fields.
    const shellPath = path.join(p.compositionDir, 'composition-manifest.json');
    const shell = JSON.parse(fs.readFileSync(shellPath, 'utf8'));
    shell.art_direction = { note: 'present but empty of budget sections' };
    fs.writeFileSync(shellPath, JSON.stringify(shell, null, 2), 'utf8');
    const qa2 = await import('../../../src/main/features/video_studio_qa');
    const shellReadiness = qa2.designContractReadiness(JSON.parse(fs.readFileSync(shellPath, 'utf8')));
    const budget = shellReadiness.issues.find((issue) => issue.code === 'DESIGN_CONTRACT_BUDGET_INCOMPLETE');
    expect(budget).toBeTruthy();
    const budgetMessage = String(budget!.message);
    // Section names AND their fields, in the same sentence the model acts on.
    expect(budgetMessage).toContain('aesthetic{subject_world');
    expect(budgetMessage).toContain('signature_device');
    expect(budgetMessage).toContain('visual_direction{visual_tradition');
    expect(budgetMessage).toContain('cover{scene_id');
    expect(budgetMessage).toContain('frame_time_sec');
    expect(String(budget!.fixHint)).toContain('COMPLETE');
    expect(String(budget!.fixHint)).toContain('empty shell');

    // A partial contract names the exact fields, same implementation as
    // inspect — prepare and inspect can never disagree about completeness.
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    manifest.art_direction = { aesthetic: { subject_world: 'ledger lines and ink' } };
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');
    const partial = await prepareComposition({ compositionDirAbs: p.compositionDir });
    expect(partial.ok).toBe(true);
    expect(partial.design_contract).toMatchObject({ status: 'incomplete' });
    const codes = (partial.design_contract as { issues: Array<{ code: string }> }).issues.map((issue) => issue.code);
    expect(codes).toContain('DESIGN_CONTRACT_BUDGET_INCOMPLETE');
    expect(codes).toContain('AESTHETIC_THESIS_INCOMPLETE');
    // Cover-family checks stay with inspect: prepare has no delivered-opening
    // context, and demanding a poster from a mid-film segment is the exact
    // misdirection the opening-only rule prevents.
    expect(codes.every((code) => !code.startsWith('COVER_'))).toBe(true);
  });

  it('reports imperative media, seek-unsafe callbacks, and silent narration in one preflight', async () => {
    const p = tmpProject('imperative-audio');
    fs.mkdirSync(path.join(p.compositionDir, 'assets'), { recursive: true });
    fs.writeFileSync(path.join(p.compositionDir, 'assets', 'narration.mp3'), 'fake narration', 'utf8');
    writeManifest(p.compositionDir, {
      scenes: [{
        id: 'cover',
        start: 0,
        duration: 10,
        approved_copy: ['Launch'],
        narration_refs: [],
        narration_text: 'Launch narration.',
        source_shots: [],
        roles: ['title', 'visual'],
      }],
      audio: {
        owner: 'composition',
        tracks: [{ id: 'narration', kind: 'narration', src: 'assets/narration.mp3', start: 0, duration: 10, volume: 1 }],
      },
    });
    await expect(prepareComposition({ compositionDirAbs: p.compositionDir })).resolves.toMatchObject({ ok: true });
    const htmlPath = path.join(p.compositionDir, 'index.html');
    const html = fs.readFileSync(htmlPath, 'utf8').replace(/^\s*<audio[^>]+><\/audio>\s*$/m, '');
    fs.writeFileSync(htmlPath, `${html}\n${[
      '<script>',
      'const narration = new Audio("./assets/narration.mp3");',
      'narration.play();',
      'window.__ORKAS_COMPOSITION_TIMELINE__.call(() => document.body.classList.add("active"), null, 1);',
      '</script>',
    ].join('\n')}`, 'utf8');

    const result = await preflightComposition({ compositionDirAbs: p.compositionDir });

    expect(result).toMatchObject({
      ok: false,
      report: expect.objectContaining({ status: 'failed' }),
      issues: expect.arrayContaining([
        expect.objectContaining({ code: 'IMPERATIVE_MEDIA_CONTROL', severity: 'error' }),
        expect.objectContaining({ code: 'GSAP_CALLBACK_NOT_SEEKABLE', severity: 'error' }),
        expect.objectContaining({ code: 'NARRATION_REQUIRED_BUT_NOT_MATERIALIZED', severity: 'error' }),
      ]),
    });
    expect(fs.existsSync(p.outputPath)).toBe(false);
  });

  it('does not mint a preview gate token from a failed or incomplete snapshot result', async () => {
    const p = tmpProject('invalid-preview-token');
    writeHtml(p.compositionDir, 'Launch');
    const gatePath = path.join(p.root, 'private-gate.json');

    await expect(recordVideoStudioGate(gatePath, 'preview', p.compositionDir, 'turn-preview', {
      preview_ready: false,
      preview_qa: { ok: false, error_count: 1 },
      preflight: { status: 'failed', blocking_error_count: 1 },
    })).resolves.toBe(false);
    await expect(validateCompositionFrameEvidence(gatePath, p.compositionDir)).resolves.toMatchObject({
      ok: false,
      errorCode: 'E_HTML_PREVIEW_REQUIRED',
    });
  });

  it('samples every scene plus hook/payoff checkpoints from legacy scene timing aliases', () => {
    const meta: CompositionMeta = {
      htmlPath: '/tmp/index.html',
      html: '',
      rootAttrs: {},
      id: 'main',
      width: 1920,
      height: 1080,
      durationSec: 30,
      audioTracks: [],
    };
    const sceneMap = {
      scenes: Array.from({ length: 9 }, (_, index) => ({
        id: `scene-${index + 1}`,
        start_s: index * (30 / 9),
        duration_s: 30 / 9,
      })),
    };

    const plan = buildPreviewFrameSamplePlan(meta, sceneMap, 30);

    expect(plan).toHaveLength(11);
    expect(new Set(plan.map((sample) => sample.frameIndex)).size).toBe(11);
    expect(plan.every((sample) => !!sample.sceneId)).toBe(true);
    expect(plan.at(-1)?.sceneId).toBe('scene-9');
  });

  it('blocks semantic preview evidence that misses the expected scene or hook promise', () => {
    const samples = Array.from({ length: 6 }, (_, index) => ({
      label: index === 0 ? 'first-frame' : `sample-${index}`,
      time_seconds: index,
      frame_index: index * 30,
      path: `/tmp/${index}.png`,
      hash: `hash-${index}`,
      brightness: 128,
      contrast: 32,
      width: 1920,
      height: 1080,
      expected_scene_id: `scene-${index + 1}`,
      visible_scene_ids: index === 3 ? ['wrong-scene'] : [`scene-${index + 1}`],
      visible_roles: index === 0 ? ['visual'] : ['title', 'visual'],
      visible_text: index === 0 ? '' : `Scene ${index + 1}`,
    }));

    const result = summarizeVideoFrameQa({
      evidence_dir: '/tmp/evidence',
      contact_sheet: '/tmp/contact-sheet.svg',
      frame_paths: samples.map((sample) => sample.path),
      samples,
    }, 30, { sceneCount: 9, requireSemanticCoverage: true });

    expect(result).toMatchObject({
      ok: false,
      expected_minimum_samples: 9,
      issues: expect.arrayContaining([
        expect.objectContaining({ code: 'EXPECTED_SCENE_NOT_VISIBLE' }),
        expect.objectContaining({ code: 'HOOK_PROMISE_NOT_VISIBLE' }),
      ]),
    });
  });

  it('hands back the measured reason an expected scene or hook title did not render', () => {
    // 2026-08-07: EXPECTED_SCENE_NOT_VISIBLE cost 15.8 minutes of a
    // 29.5-minute production turn, and HOOK_PROMISE_NOT_VISIBLE another 1.6.
    // The probe measures the reason during its own visibility walk — ancestor
    // chain, computed style, cumulative opacity — and the finding threw it
    // away, so the model spent seven QA rounds grepping the HTML, opening
    // frames, and guessing at CSS specificity to rebuild it.
    const samples = [
      {
        label: 'first-frame',
        time_seconds: 0,
        frame_index: 0,
        path: '/tmp/0.png',
        hash: 'hash-0',
        brightness: 128,
        contrast: 32,
        width: 1920,
        height: 1080,
        expected_scene_id: 'hook',
        visible_scene_ids: ['hook'],
        visible_roles: ['visual'],
        visible_text: '',
        hidden_elements: [
          {
            selector: '#hook-title',
            scene_id: 'hook',
            role: 'title',
            reason: 'transparent' as const,
            computed_opacity: 0,
          },
        ],
      },
      {
        label: 'cta-mid',
        time_seconds: 57.5,
        frame_index: 1725,
        path: '/tmp/1.png',
        hash: 'hash-1',
        brightness: 128,
        contrast: 32,
        width: 1920,
        height: 1080,
        expected_scene_id: 'cta',
        visible_scene_ids: ['features'],
        visible_roles: ['title'],
        visible_text: 'Features',
        hidden_elements: [
          {
            selector: 'section[data-scene-id="cta"]',
            scene_id: 'cta',
            reason: 'visibility_hidden' as const,
            blocked_by: 'div.clip',
          },
        ],
      },
    ];

    const result = summarizeVideoFrameQa({
      evidence_dir: '/tmp/evidence',
      contact_sheet: '/tmp/contact-sheet.svg',
      frame_paths: samples.map((sample) => sample.path),
      samples,
    }, 30, { sceneCount: 2, requireSemanticCoverage: true });

    const scene = result.issues.find((issue) => issue.code === 'EXPECTED_SCENE_NOT_VISIBLE');
    expect(scene?.message).toContain('section[data-scene-id="cta"]');
    expect(scene?.message).toContain('visibility_hidden');
    // The ancestor is the whole point: the scene's own style is fine.
    expect(scene?.message).toContain('div.clip');

    const hook = result.issues.find((issue) => issue.code === 'HOOK_PROMISE_NOT_VISIBLE');
    expect(hook?.message).toContain('#hook-title');
    expect(hook?.message).toContain('cumulative opacity 0');

    // Negative control: a finding must not borrow another element's reason.
    // #hook-title belongs to the hook sample, not to the cta scene finding.
    expect(scene?.message).not.toContain('#hook-title');
    expect(hook?.message).not.toContain('div.clip');
  });

  it('says nothing extra when the probe recorded no hidden elements', () => {
    // Older evidence (and any capture where everything rendered) carries no
    // hidden_elements; the finding must stay exactly as it was rather than
    // trailing an empty clause.
    const samples = [{
      label: 'cta-mid',
      time_seconds: 57.5,
      frame_index: 1725,
      path: '/tmp/1.png',
      hash: 'hash-1',
      brightness: 128,
      contrast: 32,
      width: 1920,
      height: 1080,
      expected_scene_id: 'cta',
      visible_scene_ids: ['features'],
      visible_roles: ['title'],
      visible_text: 'Features',
    }];

    const result = summarizeVideoFrameQa({
      evidence_dir: '/tmp/evidence',
      contact_sheet: '/tmp/contact-sheet.svg',
      frame_paths: samples.map((sample) => sample.path),
      samples,
    }, 30, { sceneCount: 1, requireSemanticCoverage: true });

    const scene = result.issues.find((issue) => issue.code === 'EXPECTED_SCENE_NOT_VISIBLE');
    expect(scene?.message).toBe('Sample "cta-mid" at 57.5s does not show expected scene "cta".');
    expect(scene?.message).not.toContain('Measured at this frame');
  });

  it('blocks a scene visibly rendered outside its own window', () => {
    // 2026-08-07 live case: the model "repaired" a blank frame 0 (a since-
    // fixed renderer defect) with `#scene-s1_hook{opacity:1!important}`,
    // pinning the hook — full-bleed video plus title — over all 50s. The
    // sampler reads computed styles, so every sample listed s1_hook as
    // visible, yet QA passed with zero blockers: only the expected-scene
    // direction was checked, never the converse.
    const windows = [
      { id: 's1_hook', start: 0, duration: 0.224 },
      { id: 's2_body', start: 0.224, duration: 10.467 },
      { id: 's3_body', start: 10.691, duration: 8.454 },
    ];
    const sample = (label: string, t: number, expected: string, visible: string[]) => ({
      label,
      time_seconds: t,
      frame_index: Math.round(t * 30),
      path: `/tmp/${label}.png`,
      hash: `hash-${label}`,
      brightness: 128,
      contrast: 32,
      width: 1920,
      height: 1080,
      expected_scene_id: expected,
      visible_scene_ids: visible,
      visible_roles: ['title', 'visual'],
      visible_text: 'copy',
    });
    const leaking = [
      sample('first-frame', 0, 's1_hook', ['s1_hook']),
      sample('s2-mid', 5.43, 's2_body', ['s1_hook', 's2_body']),
      sample('s3-mid', 14.9, 's3_body', ['s1_hook', 's3_body']),
    ];
    const evidence = {
      evidence_dir: '/tmp/evidence',
      contact_sheet: '/tmp/contact-sheet.svg',
      frame_paths: leaking.map((item) => item.path),
      samples: leaking,
    };

    const qa = summarizeVideoFrameQa(evidence, 19.145, {
      sceneCount: 3,
      requireSemanticCoverage: true,
      sceneWindows: windows,
    });
    const leakIssues = (qa.issues as Array<Record<string, unknown>>)
      .filter((issue) => issue.code === 'INACTIVE_SCENE_VISIBLE');
    expect(qa.ok).toBe(false);
    // One issue per offending scene, naming it and the sample times.
    expect(leakIssues).toHaveLength(1);
    expect(leakIssues[0]).toMatchObject({ severity: 'error', sceneId: 's1_hook' });
    expect(String(leakIssues[0].message)).toContain('5.43s');
    expect(String(leakIssues[0].fixHint)).toContain('clip timing');

    // Negative controls: a scene visible in its own window never flags, a
    // neighbour within the cut tolerance never flags, and evidence without
    // declared windows keeps the pre-existing behavior.
    const clean = [
      sample('first-frame', 0, 's1_hook', ['s1_hook']),
      sample('near-cut', 10.6, 's2_body', ['s2_body', 's3_body']),
    ];
    const cleanQa = summarizeVideoFrameQa({ ...evidence, samples: clean, frame_paths: clean.map((item) => item.path) }, 19.145, {
      sceneCount: 2,
      requireSemanticCoverage: true,
      sceneWindows: windows,
    });
    expect((cleanQa.issues as Array<Record<string, unknown>>)
      .filter((issue) => issue.code === 'INACTIVE_SCENE_VISIBLE')).toHaveLength(0);
    const withoutWindows = summarizeVideoFrameQa(evidence, 19.145, {
      sceneCount: 3,
      requireSemanticCoverage: true,
    });
    expect((withoutWindows.issues as Array<Record<string, unknown>>)
      .filter((issue) => issue.code === 'INACTIVE_SCENE_VISIBLE')).toHaveLength(0);
  });

  it('blocks a nonblank frame-zero cover when declared topic signals or a video-scale hero are not visibly evidenced', () => {
    const samples = [{
      label: 'first-frame',
      time_seconds: 0,
      frame_index: 0,
      path: '/tmp/cover.png',
      hash: 'cover-hash',
      brightness: 64,
      contrast: 24,
      width: 1920,
      height: 1080,
      expected_scene_id: 'cover',
      visible_scene_ids: ['cover'],
      visible_roles: ['title', 'visual'],
      visible_text: 'Execution is cheap. Attention is not.',
      visible_elements: [
        {
          scene_id: 'cover',
          role: 'title',
          text: 'Execution is cheap. Attention is not.',
          text_transform: 'none',
          width_ratio: 0.54,
          height_ratio: 0.18,
          area_ratio: 0.09,
        },
        {
          scene_id: 'cover',
          role: 'visual',
          cover_signal: 'execution cost',
          width_ratio: 0.12,
          height_ratio: 0.08,
          area_ratio: 0.009,
        },
        {
          scene_id: 'cover',
          role: 'visual',
          cover_hero: true,
          width_ratio: 0.08,
          height_ratio: 0.08,
          area_ratio: 0.006,
        },
      ],
    }];

    const qa = summarizeVideoFrameQa({
      evidence_dir: '/tmp/evidence',
      contact_sheet: '/tmp/contact-sheet.svg',
      frame_paths: samples.map((sample) => sample.path),
      samples,
    }, 10, {
      sceneCount: 1,
      expectedSceneIds: ['cover'],
      requireSemanticCoverage: true,
      designContract: {
        cover: {
          scene_id: 'cover',
          headline: 'Execution is cheap. Attention is not.',
          content_signals: ['execution cost', 'attention bottleneck'],
          hero_visual: 'a flow resolving around the attention bottleneck',
          composition_strategy: 'large promise plus explanatory flow',
          frame_time_sec: 0,
        },
      },
      sceneMap: {
        scenes: [{
          id: 'cover',
          approved_copy: ['Execution is cheap. Attention is not.'],
        }],
      },
    });

    // Both are composition judgments on a frame the user reviews at the
    // keyframe preview stop (2026-08-06): still reported, no longer blocking.
    expect(qa).toMatchObject({ ok: true, error_count: 0 });
    expect(qa.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'COVER_CONTENT_SIGNALS_NOT_VISIBLE', severity: 'warning' }),
      expect.objectContaining({ code: 'COVER_HERO_NOT_VISIBLE', severity: 'warning' }),
    ]));
  });

  it('accepts a frame-zero cover only when the approved title, two distinct signals, and dominant visual are all evidenced', () => {
    const qa = summarizeCoverHardGateFixture();

    expect(qa).toMatchObject({
      ok: true,
      error_count: 0,
    });
    expect(qa.issues).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ code: expect.stringMatching(/^COVER_/) }),
    ]));
  });

  it('reads the cover the way a viewer does, not the way it is marked up', () => {
    // Frame-0 evidence from the 2026-08-04 s1 hook at 15:45, verbatim. Both
    // declared signals were on screen — the first as the headline, the second
    // word for word in a body line — and the headline was rendered as the
    // two-line treatment the design asked for. QA still returned "headline not
    // visible" and "0 of 2 signals", because the headline had to live inside a
    // single element and the markers had to repeat the declared strings. The
    // model had done the visual work and could only guess at the identifiers;
    // it burned both repair passes and stalled the whole video for two hours.
    const declaredHeadline = '一个目标，不该变成10个割裂的对话框';
    const qa = summarizeVideoFrameQa({
      evidence_dir: '/tmp/s1',
      contact_sheet: '/tmp/s1/contact-sheet.png',
      frame_paths: ['/tmp/s1/01-first-frame.png'],
      samples: [{
        label: 'first-frame',
        time_seconds: 0,
        frame_index: 0,
        path: '/tmp/s1/01-first-frame.png',
        hash: 'cover-hash',
        brightness: 64,
        contrast: 24,
        width: 1920,
        height: 1080,
        expected_scene_id: 's1_hook_copy',
        visible_scene_ids: ['s1_hook_copy'],
        visible_roles: ['title', 'visual', 'body'],
        visible_text: '一个目标，不该变成10个 割裂的对话框 Orkas，让 AI 真正像团队一样工作',
        visible_elements: [
          { role: 'visual', text: 'Orkas', cover_hero: true, width_ratio: 0.42, height_ratio: 0.24, area_ratio: 0.022 },
          { role: 'visual', cover_signal: 'agent-collaboration', width_ratio: 1, height_ratio: 1, area_ratio: 1 },
          { role: 'title', text: '一个目标，不该变成10个', cover_signal: 'hook-pain-point', area_ratio: 0.1035 },
          { role: 'title', text: '割裂的对话框', area_ratio: 0.0517 },
          { role: 'body', text: 'Orkas，让 AI 真正像团队一样工作', area_ratio: 0.0237 },
        ],
      }],
    }, 5.48, {
      sceneCount: 1,
      expectedSceneIds: ['s1_hook_copy'],
      requireSemanticCoverage: true,
      designContract: {
        cover: {
          scene_id: 's1_hook_copy',
          headline: declaredHeadline,
          content_signals: [declaredHeadline, 'Orkas，让 AI 真正像团队一样工作'],
          hero_visual: 'the pain point held against one orchestrated team',
          composition_strategy: 'large promise plus one product mark',
          frame_time_sec: 0,
        },
      },
      sceneMap: { canvas: { language: 'zh' }, scenes: [{ id: 's1_hook_copy', approved_copy: [declaredHeadline] }] },
    });

    // The headline is fully visible; it is simply set on two lines.
    expect(qa.issues).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'COVER_HEADLINE_NOT_VISIBLE' }),
    ]));
    // The cover is still short one signal, and that verdict is correct: the
    // model declared its own headline as a content signal, so the frame carries
    // the promise plus one tagline, not two concrete signals. What changed is
    // the diagnosis — QA now says which signal landed and which only restates
    // the headline, instead of "0 of 2, copy the exact strings".
    expect(qa).toMatchObject({ ok: true, error_count: 0 });
    const signals = (qa.issues as Array<Record<string, any>>)
      .find((issue) => issue.code === 'COVER_CONTENT_SIGNALS_NOT_VISIBLE');
    expect(signals).toBeDefined();
    expect(signals!.severity).toBe('warning');
    expect(signals!.message).toContain('1 of 2');
    expect(signals!.message).toMatch(/only as the headline/);
    expect(signals!.evidence).toMatchObject({
      matched_signals: ['Orkas，让 AI 真正像团队一样工作'],
      headline_only_signals: [declaredHeadline],
    });
  });

  it('counts a declared cover signal the frame renders as readable copy', () => {
    // Same fixture with the degenerate signal replaced by a real one: the model
    // never has to guess an attribute identifier for copy that is on screen.
    const declaredHeadline = '一个目标，不该变成10个割裂的对话框';
    const qa = summarizeVideoFrameQa({
      evidence_dir: '/tmp/s1',
      contact_sheet: '/tmp/s1/contact-sheet.png',
      frame_paths: ['/tmp/s1/01-first-frame.png'],
      samples: [{
        label: 'first-frame',
        time_seconds: 0,
        frame_index: 0,
        path: '/tmp/s1/01-first-frame.png',
        hash: 'cover-hash',
        brightness: 64,
        contrast: 24,
        width: 1920,
        height: 1080,
        expected_scene_id: 's1_hook_copy',
        visible_scene_ids: ['s1_hook_copy'],
        visible_roles: ['title', 'visual', 'body'],
        visible_text: '一个目标，不该变成10个 割裂的对话框 Commander 调度 6 位专家 Agent',
        visible_elements: [
          { role: 'visual', text: 'Orkas', cover_hero: true, width_ratio: 0.42, height_ratio: 0.24, area_ratio: 0.12 },
          { role: 'title', text: '一个目标，不该变成10个', cover_signal: 'hook-pain-point', area_ratio: 0.1035 },
          { role: 'title', text: '割裂的对话框', area_ratio: 0.0517 },
          { role: 'body', text: 'Commander 调度 6 位专家 Agent', area_ratio: 0.0237 },
          { role: 'body', text: '研究 · 代码 · 文档 · 视频', area_ratio: 0.0201 },
        ],
      }],
    }, 5.48, {
      sceneCount: 1,
      expectedSceneIds: ['s1_hook_copy'],
      requireSemanticCoverage: true,
      designContract: {
        cover: {
          scene_id: 's1_hook_copy',
          headline: declaredHeadline,
          content_signals: ['Commander 调度 6 位专家 Agent', '研究 · 代码 · 文档 · 视频'],
          hero_visual: 'the pain point held against one orchestrated team',
          composition_strategy: 'large promise plus one product mark',
          frame_time_sec: 0,
        },
      },
      sceneMap: { canvas: { language: 'zh' }, scenes: [{ id: 's1_hook_copy', approved_copy: [declaredHeadline] }] },
    });

    expect(qa).toMatchObject({ ok: true, error_count: 0 });
    expect(qa.issues).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ code: expect.stringMatching(/^COVER_/) }),
    ]));
  });

  it('does not stitch a cover signal together from separate elements', () => {
    // Rendered-copy matching is per element. Whitespace is stripped before
    // comparison (CJK has no word spaces), so matching against the JOINED
    // non-title copy would fabricate substrings across element boundaries —
    // here neither element renders the declared signal, but their
    // concatenation does. Only the intact second signal may count.
    const declaredHeadline = '一个目标，交给一支 AI 团队';
    const qa = summarizeVideoFrameQa({
      evidence_dir: '/tmp/sx',
      contact_sheet: '/tmp/sx/contact-sheet.png',
      frame_paths: ['/tmp/sx/01-first-frame.png'],
      samples: [{
        label: 'first-frame',
        time_seconds: 0,
        frame_index: 0,
        path: '/tmp/sx/01-first-frame.png',
        hash: 'cover-hash',
        brightness: 64,
        contrast: 24,
        width: 1920,
        height: 1080,
        expected_scene_id: 'sx_cover',
        visible_scene_ids: ['sx_cover'],
        visible_roles: ['title', 'visual', 'body'],
        visible_text: '一个目标，交给一支 AI 团队 Commander 调度 6 位专家 Agent',
        visible_elements: [
          { role: 'visual', text: 'Orkas', cover_hero: true, width_ratio: 0.42, height_ratio: 0.24, area_ratio: 0.12 },
          { role: 'title', text: declaredHeadline, area_ratio: 0.1 },
          // Split across two body elements: 'Commander 调度' + '6 位专家 Agent'.
          // Joined and whitespace-stripped they read as the declared signal;
          // neither element renders it.
          { role: 'body', text: 'Commander 调度', area_ratio: 0.02 },
          { role: 'body', text: '6 位专家 Agent', area_ratio: 0.02 },
          { role: 'body', text: '研究 · 代码 · 文档 · 视频', area_ratio: 0.02 },
        ],
      }],
    }, 5, {
      sceneCount: 1,
      expectedSceneIds: ['sx_cover'],
      requireSemanticCoverage: true,
      designContract: {
        cover: {
          scene_id: 'sx_cover',
          headline: declaredHeadline,
          content_signals: ['Commander 调度 6 位专家 Agent', '研究 · 代码 · 文档 · 视频'],
          hero_visual: 'the product mark over the orchestration path',
          composition_strategy: 'promise plus concrete team signals',
          frame_time_sec: 0,
        },
      },
      sceneMap: { canvas: { language: 'zh' }, scenes: [{ id: 'sx_cover', approved_copy: [declaredHeadline] }] },
    });

    expect(qa).toMatchObject({ ok: true, error_count: 0 });
    const finding = (qa.issues as Array<Record<string, any>>)
      .find((issue) => issue.code === 'COVER_CONTENT_SIGNALS_NOT_VISIBLE');
    expect(finding).toBeDefined();
    expect(finding!.severity).toBe('warning');
    expect(finding!.message).toContain('1 of 2');
    expect(finding!.evidence).toMatchObject({
      matched_signals: ['研究 · 代码 · 文档 · 视频'],
    });
  });

  it('scopes the opening-promise rule to the frame the viewer actually opens on', () => {
    // 2026-08-05 run: all eight AUTO segments failed preview QA at once, each
    // with EMPTY_HOOK_FRAME + EXPECTED_SCENE_NOT_VISIBLE + HOOK_PROMISE_NOT_VISIBLE,
    // because every scene tweened in from opacity 0. The blank frame is a real
    // defect at any position — it is a visible gap at the cut. The missing
    // opening title is not: segment five plays thirty seconds into the finished
    // video and owes no hook promise there.
    const midSegment = {
      evidence_dir: '/tmp/s5',
      contact_sheet: '/tmp/s5/contact-sheet.png',
      frame_paths: ['/tmp/s5/01-first-frame.png'],
      samples: [{
        label: 'first-frame',
        time_seconds: 0,
        frame_index: 0,
        path: '/tmp/s5/01-first-frame.png',
        hash: 'opening-hash',
        brightness: 96,
        contrast: 30,
        width: 1920,
        height: 1080,
        expected_scene_id: 's5_delivery',
        visible_scene_ids: ['s5_delivery'],
        visible_roles: ['visual'],
        visible_text: '',
        visible_elements: [
          { role: 'visual', text: '', cover_hero: true, width_ratio: 0.5, height_ratio: 0.4, area_ratio: 0.2 },
        ],
      }],
    };

    const asMiddleSegment = summarizeVideoFrameQa(midSegment, 8, {
      sceneCount: 1,
      expectedSceneIds: ['s5_delivery'],
      requireSemanticCoverage: true,
      isDeliveredOpening: false,
    });
    const advisory = (asMiddleSegment.issues as Array<Record<string, any>>)
      .find((issue) => issue.code === 'HOOK_PROMISE_NOT_VISIBLE');
    expect(advisory?.severity).toBe('warning');
    expect(advisory?.message).toMatch(/plays inside the assembled video/);

    // The delivered opening — a standalone composition, or the segment that
    // plays first — keeps the rule as an error. Omitting the flag means yes.
    const asOpening = summarizeVideoFrameQa(midSegment, 8, {
      sceneCount: 1,
      expectedSceneIds: ['s5_delivery'],
      requireSemanticCoverage: true,
    });
    expect((asOpening.issues as Array<Record<string, any>>)
      .find((issue) => issue.code === 'HOOK_PROMISE_NOT_VISIBLE')?.severity).toBe('error');
    expect(asOpening.ok).toBe(false);
  });

  it('keeps a blank first frame blocking wherever the segment plays', () => {
    // The half of the 2026-08-05 failure that must NOT be relaxed: a frame that
    // captures blank is a visible gap at the cut into that segment, so its
    // position in the finished video does not soften it.
    const blank = {
      evidence_dir: '/tmp/s5',
      contact_sheet: '/tmp/s5/contact-sheet.png',
      frame_paths: ['/tmp/s5/01-first-frame.png'],
      samples: [{
        label: 'first-frame',
        time_seconds: 0,
        frame_index: 0,
        path: '/tmp/s5/01-first-frame.png',
        hash: 'blank-hash',
        brightness: 237.59,
        contrast: 0,
        width: 1920,
        height: 1080,
        expected_scene_id: 's5_delivery',
        visible_scene_ids: [],
        visible_roles: [],
        visible_text: '',
        visible_elements: [],
      }],
    };
    const qa = summarizeVideoFrameQa(blank, 8, {
      sceneCount: 1,
      expectedSceneIds: ['s5_delivery'],
      requireSemanticCoverage: true,
      isDeliveredOpening: false,
    });
    expect(qa.ok).toBe(false);
    expect(qa.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'EMPTY_HOOK_FRAME', severity: 'error' }),
      expect.objectContaining({ code: 'EXPECTED_SCENE_NOT_VISIBLE', severity: 'error' }),
    ]));
  });

  it('reserves speech time while preserving authored silent scenes', async () => {
    // 2026-08-06: a silent scene was weighted at 3% of its authored duration,
    // so a 5.875s opening hook retimed to 0.224s — seven frames. Every sample
    // around it came back blank and the run read it as a rendering defect
    // instead of the timing decision it was. Speech is reserved first; the
    // authored silent durations are preserved independently of speech.
    const mod = await import('../../../src/main/model/core-agent/video-studio-tool');
    const weights = mod._narrationSceneWeightsForTest;
    const manifest = {
      composition: { id: 'main', width: 1920, height: 1080, duration: 50.875, fps: 30 },
      scenes: [
        { id: 's1_hook', start: 0, duration: 5.875, narration_text: '', approved_copy: [], narration_refs: [], source_shots: [], roles: [] },
        { id: 's2_body', start: 5.875, duration: 7, narration_text: '一段旁白', approved_copy: [], narration_refs: [], source_shots: [], roles: [] },
        { id: 's3_body', start: 12.875, duration: 8, narration_text: '第二段旁白', approved_copy: [], narration_refs: [], source_shots: [], roles: [] },
        { id: 's4_payoff', start: 20.875, duration: 4, narration_text: '', approved_copy: [], narration_refs: [], source_shots: [], roles: [] },
      ],
      audio: { owner: 'composition', tracks: [] },
    } as any;

    const target = 50.875;
    const computed = weights(manifest, target, 1);
    const [hook, narratedA, narratedB, payoff] = computed;

    // Narrated scenes keep their speech estimate as a floor.
    expect(narratedA).toBeGreaterThan(0.05);
    expect(narratedB).toBeGreaterThan(0.05);
    // The weighting helper still preserves their authored relationship and
    // gives both a real duration rather than the old 3% sliver.
    expect(hook).toBeGreaterThan(payoff);
    expect(hook).toBeGreaterThan(5);
    expect(payoff).toBeGreaterThan(3);
    // Weights sum to the target, so normalization reproduces them exactly.
    expect(computed.reduce((sum: number, value: number) => sum + value, 0)).toBeCloseTo(target, 3);

    // The end-to-end consequence: retiming preserves the hook instead of
    // collapsing it. This is the assertion that would have caught 0.224s.
    const contract = await import('../../../src/main/features/video_studio_contract');
    const retimed = contract.retimeCompositionManifestForNarration(
      { ...manifest, composition: { ...manifest.composition, target_duration: target } },
      30,
      computed,
    );
    const retimedHook = retimed.scenes.find((scene: any) => scene.id === 's1_hook');
    expect(retimedHook!.duration).toBeGreaterThan(5);

    // Degenerate case: speech alone exceeds the target, so there is nothing
    // left to share and silent scenes fall back to the floor rather than
    // stealing time the voice needs.
    const squeezed = weights(manifest, 2, 1);
    expect(squeezed[0]).toBe(0.05);
    expect(squeezed[3]).toBe(0.05);
    expect(squeezed[1]).toBeGreaterThan(0.05);
  });

  it('keeps the blocking set to defects the user cannot judge from the frames', () => {
    // 2026-08-06 disposition review. After the keyframe preview stop returned,
    // taste findings stopped blocking: the rules are taught before authoring
    // (frontend-design + stage-compose), the defect is visible on the frames
    // the user is about to review, and bouncing the run costs a repair cycle
    // to enforce an opinion. What still blocks is what the user CANNOT judge
    // from three thumbnails, or what violates something they already signed.
    // This list is the contract; changing a disposition must change it here.
    const advisoryNow = [
      'UPPERCASE_TRANSFORM_FORBIDDEN',
      'PRIMARY_COPY_ALL_CAPS',
      'UNAUTHORIZED_ALL_CAPS_ACCENT',
      'ALL_CAPS_ACCENT_OVERUSED',
      'COVER_CONTENT_SIGNALS_NOT_VISIBLE',
      'COVER_HERO_NOT_VISIBLE',
    ];
    const stillBlocking = [
      // Signed intent: the user approved this exact copy.
      'APPROVED_COPY_CASING_CHANGED',
      // The approved promise is not on the poster frame at all.
      'COVER_HEADLINE_NOT_VISIBLE',
      // Broken artifacts, not opinions.
      'EMPTY_HOOK_FRAME',
      'EXPECTED_SCENE_NOT_VISIBLE',
      'VIDEO_SAMPLE_FRAMES_MISSING',
    ];

    const partial = {
      evidence_dir: '/tmp/disp',
      contact_sheet: '/tmp/disp/contact-sheet.png',
      frame_paths: ['/tmp/disp/01-first-frame.png'],
      samples: [{
        label: 'first-frame',
        time_seconds: 0,
        frame_index: 0,
        path: '/tmp/disp/01-first-frame.png',
        hash: 'disp-hash',
        brightness: 90,
        contrast: 42,
        width: 1920,
        height: 1080,
        expected_scene_id: 'cover',
        visible_scene_ids: ['cover'],
        visible_roles: ['title'],
        visible_text: 'Launch day',
        // One element per finding: the casing checks are a single if/else
        // chain, so each element yields at most one verdict.
        visible_elements: [
          { scene_id: 'cover', role: 'title', text: 'Launch day' },
          { scene_id: 'cover', role: 'body', text: 'Move Fast', text_transform: 'none' },
          { scene_id: 'cover', role: 'caption', text: 'SHIP TODAY', text_transform: 'none' },
          { scene_id: 'cover', role: 'subtitle', text: 'Ship it', text_transform: 'uppercase' },
          { scene_id: 'cover', role: 'label', text: 'BETA', text_transform: 'none' },
        ],
      }],
    };
    const qa = summarizeVideoFrameQa(partial, 6, {
      sceneCount: 1,
      expectedSceneIds: ['cover'],
      requireSemanticCoverage: true,
      designContract: {
        cover: {
          scene_id: 'cover',
          headline: 'Launch day',
          content_signals: ['product teardown', 'setup path'],
          hero_visual: 'exploded product view',
          composition_strategy: 'headline over hero',
          frame_time_sec: 0,
        },
      },
      sceneMap: {
        canvas: { language: 'en' },
        scenes: [{ id: 'cover', approved_copy: ['Launch day', 'Move fast'] }],
      },
    });

    const bySeverity = new Map((qa.issues as Array<Record<string, any>>)
      .map((issue) => [String(issue.code), String(issue.severity)]));
    // The taste findings this frame trips are all present and all advisory.
    for (const code of ['UPPERCASE_TRANSFORM_FORBIDDEN', 'PRIMARY_COPY_ALL_CAPS',
      'UNAUTHORIZED_ALL_CAPS_ACCENT', 'COVER_CONTENT_SIGNALS_NOT_VISIBLE',
      'COVER_HERO_NOT_VISIBLE']) {
      expect(bySeverity.get(code), code).toBe('warning');
    }
    // Casing the user approved was changed (Move fast -> Move Fast): error.
    expect(bySeverity.get('APPROVED_COPY_CASING_CHANGED')).toBe('error');
    expect(qa.ok).toBe(false);
    // ...and it is the ONLY blocker on this frame: every other finding here
    // is taste.
    expect((qa.issues as Array<Record<string, any>>)
      .filter((issue) => issue.severity === 'error')
      .map((issue) => issue.code)).toEqual(['APPROVED_COPY_CASING_CHANGED']);

    // Guard the two lists against silent drift in either direction.
    expect(advisoryNow.every((code) => qaFindingIsWaivable(code))).toBe(true);
    expect(stillBlocking.filter((code) => code === 'VIDEO_SAMPLE_FRAMES_MISSING')
      .every((code) => qaFindingIsWaivable(code))).toBe(false);
  });

  it('skips the whole cover family on a mid-film segment', () => {
    // 2026-08-06: a middle compose segment was blocked by
    // COVER_CONTENT_SIGNALS_NOT_VISIBLE + COVER_HERO_NOT_VISIBLE — poster
    // standards applied to a frame that plays at a cut inside the video.
    // Cover semantics are a whole-video property; the same evidence keeps
    // failing when the segment IS the delivered opening (negative control).
    const partialFrame = {
      evidence_dir: '/tmp/s2',
      contact_sheet: '/tmp/s2/contact-sheet.png',
      frame_paths: ['/tmp/s2/01-first-frame.png'],
      samples: [{
        label: 'first-frame',
        time_seconds: 0,
        frame_index: 0,
        path: '/tmp/s2/01-first-frame.png',
        hash: 'partial-hash',
        brightness: 88,
        contrast: 40,
        width: 1080,
        height: 1920,
        expected_scene_id: 's2_pain',
        visible_scene_ids: ['s2_pain'],
        visible_roles: ['title'],
        visible_text: 'AI 的回答，越来越像样了',
        visible_elements: [
          { role: 'title', text: 'AI 的回答，越来越像样了' },
        ],
      }],
    };
    const coverOptions = {
      sceneCount: 1,
      expectedSceneIds: ['s2_pain'],
      requireSemanticCoverage: true,
      designContract: {
        cover: {
          scene_id: 's2_pain',
          headline: 'AI 的回答，越来越像样了',
          content_signals: ['交付缺口', '协作证据'],
          hero_visual: 'chat bubble stack',
          composition_strategy: 'headline over hero',
          frame_time_sec: 0,
        },
      },
      sceneMap: { scenes: [{ id: 's2_pain', approved_copy: ['AI 的回答，越来越像样了'] }] },
    };

    const asMiddleSegment = summarizeVideoFrameQa(partialFrame, 6, {
      ...coverOptions,
      isDeliveredOpening: false,
    });
    expect(asMiddleSegment.issues).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ code: expect.stringMatching(/^COVER_/) }),
    ]));

    // The opening still RUNS the family (advisory since 2026-08-06); the
    // mid-film segment does not run it at all, which is the distinction.
    const asOpening = summarizeVideoFrameQa(partialFrame, 6, coverOptions);
    expect(asOpening.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'COVER_CONTENT_SIGNALS_NOT_VISIBLE', severity: 'warning' }),
      expect.objectContaining({ code: 'COVER_HERO_NOT_VISIBLE', severity: 'warning' }),
    ]));
  });

  it('reports user-waived findings as informational without unblocking evidence integrity', () => {
    // The user chose to skip the opening-promise check after seeing the
    // frame. The finding stays in the report as informational; blocking
    // counts drop.
    const partialFrame = {
      evidence_dir: '/tmp/s1',
      contact_sheet: '/tmp/s1/contact-sheet.png',
      frame_paths: ['/tmp/s1/01-first-frame.png'],
      samples: [{
        label: 'first-frame',
        time_seconds: 0,
        frame_index: 0,
        path: '/tmp/s1/01-first-frame.png',
        hash: 'partial-hash',
        brightness: 88,
        contrast: 40,
        width: 1080,
        height: 1920,
        expected_scene_id: 'cover',
        visible_scene_ids: ['cover'],
        visible_roles: [],
        visible_text: '',
        visible_elements: [{ role: 'body', text: 'Launch day' }],
      }],
    };
    const options = {
      sceneCount: 1,
      expectedSceneIds: ['cover'],
      requireSemanticCoverage: true,
      designContract: {
        cover: {
          scene_id: 'cover',
          headline: 'Launch day',
          content_signals: ['产品拆解', '上手路径'],
          hero_visual: 'product exploded view',
          composition_strategy: 'headline over hero',
          frame_time_sec: 0,
        },
      },
      sceneMap: { scenes: [{ id: 'cover', approved_copy: ['Launch day'] }] },
    };

    const blocked = summarizeVideoFrameQa(partialFrame, 6, options);
    expect(blocked.ok).toBe(false);

    const waived = summarizeVideoFrameQa(partialFrame, 6, {
      ...options,
      // Both blocking findings this frame produces: the missing opening
      // promise and the approved headline it never rendered.
      waivedFindings: ['HOOK_PROMISE_NOT_VISIBLE', 'COVER_HEADLINE_NOT_VISIBLE'],
    });
    expect(waived.ok).toBe(true);
    expect(waived.error_count).toBe(0);
    const downgraded = (waived.issues as Array<Record<string, any>>)
      .filter((issue) => issue.waived_by_user === true);
    expect(downgraded.map((issue) => issue.code).sort()).toEqual([
      'COVER_HEADLINE_NOT_VISIBLE',
      'HOOK_PROMISE_NOT_VISIBLE',
    ]);
    expect(downgraded.every((issue) => issue.severity === 'info')).toBe(true);
    expect(downgraded.every((issue) => /skipped by user decision/.test(issue.message))).toBe(true);

    // Evidence-integrity findings cannot be waived away: no frames means QA
    // is blind, which is not a look the user accepted.
    expect(qaFindingIsWaivable('VIDEO_SAMPLE_FRAMES_MISSING')).toBe(false);
    expect(qaFindingIsWaivable('SCENE_MAP_PARSE_FAILED')).toBe(false);
    expect(qaFindingIsWaivable('HOOK_PROMISE_NOT_VISIBLE')).toBe(true);
    const noFrames = summarizeVideoFrameQa(
      { evidence_dir: '', contact_sheet: '', frame_paths: [], samples: [] },
      6,
      { sceneCount: 1, waivedFindings: ['VIDEO_SAMPLE_FRAMES_MISSING'] },
    );
    expect(noFrames.ok).toBe(false);
    expect((noFrames.issues as Array<Record<string, any>>)
      .find((issue) => issue.code === 'VIDEO_SAMPLE_FRAMES_MISSING')?.severity).toBe('error');
  });

  it('does not blame cover markers for a frame that renders nothing at all', () => {
    // The 2026-08-04 s7 CTA segment: its content animates in, so t=0 is empty
    // while 1.73s and 3.43s show the full frame. The cover contract answered
    // with three "you did not mark the hero/signals/headline" errors, which is
    // the wrong repair to attempt. The empty first frame is already reported by
    // its own finding, and that one is actionable.
    const qa = summarizeVideoFrameQa({
      evidence_dir: '/tmp/s7',
      contact_sheet: '/tmp/s7/contact-sheet.png',
      frame_paths: ['/tmp/s7/01-first-frame.png'],
      samples: [{
        label: 'first-frame',
        time_seconds: 0,
        frame_index: 0,
        path: '/tmp/s7/01-first-frame.png',
        hash: 'empty-hash',
        brightness: 8,
        contrast: 2,
        width: 1920,
        height: 1080,
        expected_scene_id: 's7_cta',
        visible_scene_ids: ['s7_cta'],
        visible_roles: [],
        visible_text: '',
        visible_elements: [],
      }],
    }, 3.5, {
      sceneCount: 1,
      expectedSceneIds: ['s7_cta'],
      requireSemanticCoverage: true,
      designContract: {
        cover: {
          scene_id: 's7_cta',
          headline: '把一个目标，交给一支 AI 团队',
          content_signals: ['把一个目标，交给一支 AI 团队', 'orkas.ai'],
          hero_visual: 'the product mark resolving over the call to action',
          composition_strategy: 'closing promise plus destination',
          frame_time_sec: 0,
        },
      },
      sceneMap: { canvas: { language: 'zh' }, scenes: [{ id: 's7_cta', approved_copy: ['把一个目标，交给一支 AI 团队'] }] },
    });

    expect(qa).toMatchObject({ ok: false });
    expect(qa.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'HOOK_PROMISE_NOT_VISIBLE', severity: 'error' }),
    ]));
    expect(qa.issues).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ code: expect.stringMatching(/^COVER_/) }),
    ]));
  });

  it('fails closed on legacy frame evidence that cannot prove the current cover contract', () => {
    const qa = summarizeCoverHardGateFixture({
      includeVisibleElements: false,
    });

    expect(qa).toMatchObject({
      ok: false,
      error_count: 1,
    });
    expect(qa.issues).toEqual([
      expect.objectContaining({
        code: 'COVER_SEMANTIC_EVIDENCE_MISSING',
        severity: 'error',
      }),
    ]);
  });

  it.each([
    {
      name: 'headline text exists only in a body role',
      fixture: {
        headlineRole: 'body',
      },
      code: 'COVER_HEADLINE_NOT_VISIBLE',
    },
    {
      name: 'one declared signal is duplicated instead of mapping two distinct signals',
      fixture: {
        signals: [coverQaSignals[0], coverQaSignals[0]],
      },
      code: 'COVER_CONTENT_SIGNALS_NOT_VISIBLE',
    },
    {
      name: 'one signal marker is a near-match rather than the declared topic signal',
      fixture: {
        signals: [coverQaSignals[0], 'attention bottlenecks'],
      },
      code: 'COVER_CONTENT_SIGNALS_NOT_VISIBLE',
    },
  ])('reports a superficially populated cover when $name', ({ fixture, code }) => {
    const qa = summarizeCoverHardGateFixture(fixture);

    // Detection is unchanged; only the disposition moved. A headline the
    // frame never renders stays blocking (the approved promise is missing);
    // the signal-composition judgments are advisory (2026-08-06).
    const blocking = code === 'COVER_HEADLINE_NOT_VISIBLE';
    expect(qa.ok).toBe(!blocking);
    expect(qa.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code,
        severity: blocking ? 'error' : 'warning',
      }),
    ]));
  });

  it.each([
    {
      name: 'accepts the documented hero threshold',
      hero: {
        role: 'visual',
        cover_hero: true,
        width_ratio: 0.2,
        height_ratio: 0.1,
        area_ratio: 0.015,
      },
      shouldPass: true,
    },
    {
      name: 'rejects a hero below the minimum axis ratio',
      hero: {
        role: 'visual',
        cover_hero: true,
        width_ratio: 0.199,
        height_ratio: 0.1,
        area_ratio: 0.02,
      },
      shouldPass: false,
    },
    {
      name: 'rejects a hero below the minimum visible area',
      hero: {
        role: 'visual',
        cover_hero: true,
        width_ratio: 0.3,
        height_ratio: 0.1,
        area_ratio: 0.0149,
      },
      shouldPass: false,
    },
    {
      name: 'rejects a large title incorrectly marked as the hero',
      hero: {
        role: 'title',
        cover_hero: true,
        width_ratio: 0.6,
        height_ratio: 0.3,
        area_ratio: 0.18,
      },
      shouldPass: false,
    },
    {
      name: 'rejects a large visual without the explicit hero marker',
      hero: {
        role: 'visual',
        width_ratio: 0.6,
        height_ratio: 0.3,
        area_ratio: 0.18,
      },
      shouldPass: false,
    },
  ])('$name', ({ hero, shouldPass }) => {
    const qa = summarizeCoverHardGateFixture({ hero });
    const heroIssues = (qa.issues as Array<{ code: string }>).filter(
      (issue) => issue.code === 'COVER_HERO_NOT_VISIBLE',
    );

    // The thresholds themselves are unchanged — a hero below them is still
    // detected — but a hero-size judgment no longer blocks the run.
    expect(qa).toMatchObject({ ok: true, error_count: 0 });
    if (shouldPass) {
      expect(heroIssues).toHaveLength(0);
    } else {
      expect(heroIssues).toEqual([
        expect.objectContaining({
          code: 'COVER_HERO_NOT_VISIBLE',
          severity: 'warning',
        }),
      ]);
    }
  });

  it('blocks primary all-caps and computed uppercase while accepting natural copy plus one approved uppercase accent', () => {
    const designContract = {
      cover: {
        scene_id: 'cover',
        headline: 'Execution is cheap. Attention is not.',
        content_signals: ['execution cost', 'attention bottleneck'],
        hero_visual: 'a flow resolving around the attention bottleneck',
        composition_strategy: 'large promise plus explanatory flow',
        frame_time_sec: 0,
      },
    };
    const sceneMap = {
      canvas: { language: 'en' },
      scenes: [{
        id: 'cover',
        approved_copy: [
          'Execution is cheap. Attention is not.',
          'MORE OPTIONS, SAME 24 HOURS.',
          'Move from uncertainty to action.',
          'BETA',
          'ALPHA',
        ],
      }],
    };
    const visibleCoverElements = [
      {
        scene_id: 'cover',
        role: 'visual',
        cover_signal: 'execution cost',
        width_ratio: 0.28,
        height_ratio: 0.24,
        area_ratio: 0.067,
      },
      {
        scene_id: 'cover',
        role: 'visual',
        cover_signal: 'attention bottleneck',
        width_ratio: 0.24,
        height_ratio: 0.22,
        area_ratio: 0.052,
      },
      {
        scene_id: 'cover',
        role: 'visual',
        cover_hero: true,
        width_ratio: 0.68,
        height_ratio: 0.46,
        area_ratio: 0.31,
      },
    ];
    const makeEvidence = (visibleElements: Array<Record<string, unknown>>) => ({
      evidence_dir: '/tmp/evidence',
      contact_sheet: '/tmp/contact-sheet.svg',
      frame_paths: ['/tmp/cover.png'],
      samples: [{
        label: 'first-frame',
        time_seconds: 0,
        frame_index: 0,
        path: '/tmp/cover.png',
        hash: 'cover-hash',
        brightness: 64,
        contrast: 24,
        width: 1920,
        height: 1080,
        expected_scene_id: 'cover',
        visible_scene_ids: ['cover'],
        visible_roles: ['title', 'body', 'label', 'visual'],
        visible_text: visibleElements.map((element) => String(element.text || '')).join(' '),
        visible_elements: [...visibleElements, ...visibleCoverElements],
      }],
    });
    const options = {
      sceneCount: 1,
      expectedSceneIds: ['cover'],
      requireSemanticCoverage: true,
      designContract,
      sceneMap,
    };

    const rejected = summarizeVideoFrameQa(makeEvidence([
      {
        scene_id: 'cover',
        role: 'title',
        text: 'EXECUTION IS CHEAP. ATTENTION IS NOT.',
        text_transform: 'none',
      },
      {
        scene_id: 'cover',
        role: 'title',
        text: 'MORE OPTIONS, SAME 24 HOURS.',
        text_transform: 'none',
      },
      {
        scene_id: 'cover',
        role: 'body',
        text: 'Move from uncertainty to action.',
        text_transform: 'uppercase',
      },
      {
        scene_id: 'cover',
        role: 'label',
        text: 'BETA',
        text_transform: 'none',
      },
    ]), 10, options);

    // The split that matters: changing the casing of copy the user APPROVED
    // violates signed intent and still blocks; the style judgments beside it
    // are reported as advisories (2026-08-06).
    expect(rejected).toMatchObject({ ok: false });
    expect(rejected.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'APPROVED_COPY_CASING_CHANGED', role: 'title', severity: 'error' }),
      expect.objectContaining({ code: 'PRIMARY_COPY_ALL_CAPS', role: 'title', severity: 'warning' }),
      expect.objectContaining({ code: 'UPPERCASE_TRANSFORM_FORBIDDEN', role: 'body', severity: 'warning' }),
    ]));
    expect(rejected.issues).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'UNAUTHORIZED_ALL_CAPS_ACCENT', role: 'label' }),
    ]));

    const overusedAccents = summarizeVideoFrameQa(makeEvidence([
      {
        scene_id: 'cover',
        role: 'title',
        text: 'Execution is cheap. Attention is not.',
        text_transform: 'none',
      },
      {
        scene_id: 'cover',
        role: 'label',
        text: 'BETA',
        text_transform: 'none',
      },
      {
        scene_id: 'cover',
        role: 'label',
        text: 'ALPHA',
        text_transform: 'none',
      },
    ]), 10, options);

    expect(overusedAccents.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'ALL_CAPS_ACCENT_OVERUSED', sceneId: 'cover' }),
    ]));

    const accepted = summarizeVideoFrameQa(makeEvidence([
      {
        scene_id: 'cover',
        role: 'title',
        text: 'Execution is cheap. Attention is not.',
        text_transform: 'none',
      },
      {
        scene_id: 'cover',
        role: 'body',
        text: 'Move from uncertainty to action.',
        text_transform: 'none',
      },
      {
        scene_id: 'cover',
        role: 'label',
        text: 'BETA',
        text_transform: 'none',
      },
    ]), 10, options);

    expect(accepted).toMatchObject({ ok: true, error_count: 0 });
  });

  it.each(['title', 'body', 'caption', 'subtitle', 'cta'])(
    'reports computed uppercase on the primary %s role without blocking',
    (role) => {
      const qa = summarizeCoverHardGateFixture({
        approvedCopy: [coverQaHeadline, 'Move from uncertainty to action.'],
        extraElements: [{
          role,
          text: 'Move from uncertainty to action.',
          text_transform: 'uppercase',
        }],
      });

      // Casing is taught before authoring and is plainly visible on the
      // frames the user reviews; the finding is reported, not enforced.
      expect(qa).toMatchObject({ ok: true, error_count: 0 });
      expect(qa.issues).toEqual(expect.arrayContaining([
        expect.objectContaining({
          code: 'UPPERCASE_TRANSFORM_FORBIDDEN',
          role,
          severity: 'warning',
        }),
      ]));
    },
  );

  it.each([
    {
      name: 'uppercase label is absent from approved copy',
      approvedCopy: [coverQaHeadline],
      element: {
        role: 'label',
        text: 'BETA',
        text_transform: 'none',
      },
    },
    {
      name: 'natural DOM text is forced uppercase by CSS',
      approvedCopy: [coverQaHeadline, 'BETA'],
      element: {
        role: 'label',
        text: 'Beta',
        text_transform: 'uppercase',
      },
    },
    {
      name: 'uppercase label changes the approved casing',
      approvedCopy: [coverQaHeadline, 'Beta'],
      element: {
        role: 'label',
        text: 'BETA',
        text_transform: 'none',
      },
    },
  ])('reports an unauthorized uppercase accent when $name', ({
    approvedCopy,
    element,
  }) => {
    const qa = summarizeCoverHardGateFixture({
      approvedCopy,
      extraElements: [element],
    });

    expect(qa).toMatchObject({ ok: true, error_count: 0 });
    expect(qa.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: 'UNAUTHORIZED_ALL_CAPS_ACCENT',
        role: 'label',
        severity: 'warning',
      }),
    ]));
  });

  it('allows a short approved acronym in primary copy without weakening the cover gate', () => {
    const qa = summarizeCoverHardGateFixture({
      approvedCopy: [coverQaHeadline, 'AI'],
      extraElements: [{
        role: 'body',
        text: 'AI',
        text_transform: 'none',
      }],
    });

    expect(qa).toMatchObject({
      ok: true,
      error_count: 0,
    });
    expect(qa.issues).not.toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: expect.stringMatching(/(?:ALL_CAPS|UPPERCASE)/),
      }),
    ]));
  });

  it('reports a second uppercase item even when the acronym and label are individually valid', () => {
    const qa = summarizeCoverHardGateFixture({
      approvedCopy: [coverQaHeadline, 'AI', 'BETA'],
      extraElements: [
        {
          role: 'body',
          text: 'AI',
          text_transform: 'none',
        },
        {
          role: 'label',
          text: 'BETA',
          text_transform: 'none',
        },
      ],
    });

    expect(qa).toMatchObject({ ok: true, error_count: 0 });
    expect(qa.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: 'ALL_CAPS_ACCENT_OVERUSED',
        sceneId: 'cover',
        severity: 'warning',
      }),
    ]));
  });

  it('does not apply English casing rules to non-English copy that contains a Latin acronym', () => {
    const samples = [{
      label: 'first-frame',
      time_seconds: 0,
      frame_index: 0,
      path: '/tmp/zh-cover.png',
      hash: 'zh-cover-hash',
      brightness: 64,
      contrast: 24,
      width: 1920,
      height: 1080,
      expected_scene_id: 'cover',
      visible_scene_ids: ['cover'],
      visible_roles: ['title'],
      visible_text: 'AI 驱动工作流',
      visible_elements: [{
        scene_id: 'cover',
        role: 'title',
        text: 'AI 驱动工作流',
        text_transform: 'none',
      }],
    }];

    const qa = summarizeVideoFrameQa({
      evidence_dir: '/tmp/evidence',
      contact_sheet: '/tmp/contact-sheet.svg',
      frame_paths: samples.map((sample) => sample.path),
      samples,
    }, 10, {
      sceneCount: 1,
      expectedSceneIds: ['cover'],
      requireSemanticCoverage: true,
      sceneMap: {
        canvas: { language: 'zh-CN' },
        scenes: [{ id: 'cover', approved_copy: ['AI 驱动工作流'] }],
      },
    });

    expect(qa).toMatchObject({ ok: true, error_count: 0 });
    expect(qa.issues).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'PRIMARY_COPY_ALL_CAPS' }),
    ]));
  });

  it('retries and blocks only when scene semantics contradict identical captured pixels', () => {
    const previous = {
      label: 'scene-one', time_seconds: 1, frame_index: 30, path: '/tmp/one.png', hash: 'same',
      brightness: 128, contrast: 32, width: 1920, height: 1080,
      expected_scene_id: 'scene-one', visible_scene_ids: ['scene-one'], visible_roles: ['title'], visible_text: 'One',
    };
    const current = {
      ...previous,
      label: 'scene-two', time_seconds: 3, frame_index: 90, path: '/tmp/two.png',
      expected_scene_id: 'scene-two', visible_scene_ids: ['scene-two'], visible_text: 'Two', capture_retry_count: 1,
    };
    expect(isSuspiciousCrossSceneDuplicate(previous, current)).toBe(true);
    expect(isSuspiciousCrossSceneDuplicate(previous, { ...current, hash: 'different' })).toBe(false);
    expect(isSuspiciousCrossSceneDuplicate(previous, { ...current, visible_text: 'One' })).toBe(false);

    const trailing = [2, 3, 4].map((index) => ({
      ...current,
      label: `scene-${index + 1}`,
      time_seconds: index * 2,
      frame_index: index * 60,
      path: `/tmp/${index + 1}.png`,
      hash: `hash-${index + 1}`,
      expected_scene_id: `scene-${index + 1}`,
      visible_scene_ids: [`scene-${index + 1}`],
      visible_text: `Scene ${index + 1}`,
    }));
    const qa = summarizeVideoFrameQa({
      evidence_dir: '/tmp/evidence',
      contact_sheet: '/tmp/evidence/contact-sheet.svg',
      frame_paths: [previous.path, current.path, ...trailing.map((sample) => sample.path)],
      samples: [previous, current, ...trailing],
    }, 10, { requireSemanticCoverage: true });
    expect(qa.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'SCENE_CAPTURE_SEMANTIC_PIXEL_MISMATCH', severity: 'error' }),
    ]));
  });

  it('isolates each preview capture in a source-revision run directory', () => {
    const previewPath = path.join(os.tmpdir(), 'preview.png');
    const expectedDir = path.join(os.tmpdir(), 'preview-frames');
    const first = previewEvidenceRunDir(previewPath, '<html>revision A</html>');
    const second = previewEvidenceRunDir(previewPath, '<html>revision A</html>');
    expect(path.dirname(first)).toBe(expectedDir);
    expect(path.dirname(second)).toBe(expectedDir);
    expect(path.basename(first)).toMatch(/^[a-f0-9]{12}-[a-f0-9]{8}$/);
    expect(second).not.toBe(first);
  });

  it('publishes the revisioned contact sheet while keeping the first frame explicit', () => {
    const artifacts = previewArtifactPaths('/tmp/legacy-preview.png', '/tmp/revision/contact-sheet.svg', [{
      label: 'first-frame',
      time_seconds: 0,
      frame_index: 0,
      path: '/tmp/revision/01-first-frame.png',
      hash: 'hash',
      brightness: 128,
      contrast: 32,
      width: 1920,
      height: 1080,
    }]);
    expect(artifacts).toEqual({
      path: '/tmp/revision/contact-sheet.svg',
      contact_sheet: '/tmp/revision/contact-sheet.svg',
      contact_sheet_path: '/tmp/revision/contact-sheet.svg',
      first_frame: '/tmp/revision/01-first-frame.png',
      first_frame_path: '/tmp/revision/01-first-frame.png',
      artifact_type: 'contact_sheet',
    });
  });

  it('prepares composition HTML as a downstream input before lint/render reads it', async () => {
    const p = tmpProject('prepare-composition-input');
    writeHtml(p.compositionDir, 'Launch');
    writeManifest(p.compositionDir);
    const htmlPath = path.join(p.compositionDir, 'index.html');
    fs.appendFileSync(htmlPath, '\n<!-- stale-output-mark -->', 'utf8');
    const prepared: string[] = [];
    const unregister = registerProducedOutputHooks({
      prepareFileInput: async (file) => {
        prepared.push(file);
        fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('<!-- stale-output-mark -->', ''), 'utf8');
      },
    });
    try {
      const result = await lintComposition({ compositionDirAbs: p.compositionDir });
      expect(result.ok).toBe(true);
      expect(prepared).toEqual([htmlPath]);
      expect(fs.readFileSync(htmlPath, 'utf8')).not.toContain('stale-output-mark');
    } finally {
      unregister();
    }
  });

  it('publishes a raster contact sheet while retaining self-contained SVG evidence', async () => {
    const p = tmpProject('contact-sheet');
    const evidenceDir = path.join(p.compositionDir, 'preview');
    fs.mkdirSync(evidenceDir, { recursive: true });
    const framePath = path.join(evidenceDir, '01-first-frame.png');
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
    fs.writeFileSync(framePath, png);

    const out = await writeFrameContactSheet(evidenceDir, [{
      label: 'first-frame',
      time_seconds: 0,
      frame_index: 0,
      path: framePath,
      hash: 'hash',
      brightness: 1,
      contrast: 1,
      width: 1,
      height: 1,
    }]);

    const svgPath = path.join(evidenceDir, 'contact-sheet.svg');
    const svg = fs.readFileSync(svgPath, 'utf8');
    expect(out).toBe(path.join(evidenceDir, 'contact-sheet.png'));
    expect(fs.readFileSync(out).subarray(0, 8)).toEqual(
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    );
    expect(svg).toContain('href="data:image/png;base64,');
    expect(svg).not.toContain('href="01-first-frame.png"');
  });

  it('S1 blocks composition BrowserWindow file:// requests outside composition_dir', async () => {
    const p = tmpProject('file-sandbox');
    const inside = path.join(p.compositionDir, 'assets', 'ok.png');
    fs.mkdirSync(path.dirname(inside), { recursive: true });
    fs.writeFileSync(inside, 'ok');
    const outside = path.join(p.root, 'secret.txt');
    fs.writeFileSync(outside, 'secret');

    expect(isCompositionRequestUrlAllowed(pathToFileURL(inside).toString(), p.compositionDir)).toBe(true);
    expect(isCompositionRequestUrlAllowed('data:image/png;base64,AA==', p.compositionDir)).toBe(true);
    expect(isCompositionRequestUrlAllowed('about:blank', p.compositionDir)).toBe(true);
    expect(isCompositionRequestUrlAllowed(pathToFileURL(outside).toString(), p.compositionDir)).toBe(false);
    expect(isCompositionRequestUrlAllowed('https://example.test/asset.png', p.compositionDir)).toBe(false);

    const link = path.join(p.compositionDir, 'assets', 'secret-link.txt');
    try {
      fs.symlinkSync(outside, link);
      expect(isCompositionRequestUrlAllowed(pathToFileURL(link).toString(), p.compositionDir)).toBe(false);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EPERM') throw err;
    }
  });

  it('S1 rejects stalled native renderer work through the watchdog', async () => {
    await expect(withVideoStudioTimeout(
      new Promise(() => {}),
      1,
      'E_TEST_TIMEOUT',
      'test timeout',
    )).rejects.toMatchObject({ errorCode: 'E_TEST_TIMEOUT', message: 'test timeout' });
  });

  it('S1 enforces the draft repair budget and blocks attempts after two repairs', async () => {
    const p = tmpProject('repair-budget');

    const attempts = [];
    for (let i = 0; i < 4; i += 1) {
      attempts.push(await draftComposition({
        compositionDirAbs: p.compositionDir,
        outputAbsPath: p.outputPath,
        reportAbsPath: p.reportPath,
      }));
    }

    expect(attempts[0]).toMatchObject({ ok: false, errorCode: 'E_PREFLIGHT_BLOCKED' });
    expect(attempts[1]).toMatchObject({ ok: false, errorCode: 'E_PREFLIGHT_BLOCKED' });
    expect(attempts[2]).toMatchObject({
      ok: false,
      errorCode: 'E_PREFLIGHT_BLOCKED',
      repair_budget: expect.objectContaining({ budget_exhausted: true, repair_passes_used: 2 }),
    });
    expect(attempts[3]).toMatchObject({
      ok: false,
      errorCode: 'E_REPAIR_BUDGET_EXCEEDED',
      blocked_operation: 'composition.draft',
      same_input_retry_allowed: false,
      requires_user_decision: false,
      next_action: 'repair_inputs_then_retry_draft',
      allowed_recovery_ops: expect.arrayContaining([
        'composition.reconcile',
        'composition.lint',
        'composition.inspect',
      ]),
    });
    expect(fs.existsSync(path.join(p.compositionDir, 'qa', 'draft-repair-state.json'))).toBe(true);
  });

  it('S1 keeps the repair budget when the agent deletes the workspace audit mirror', async () => {
    const p = tmpProject('repair-budget-private-ledger');
    const repairStateAbsPath = path.join(p.root, 'private', 'repair-state.json');
    const auditPath = path.join(p.compositionDir, 'qa', 'draft-repair-state.json');
    const attempts = [];

    for (let i = 0; i < 3; i += 1) {
      attempts.push(await draftComposition({
        compositionDirAbs: p.compositionDir,
        outputAbsPath: p.outputPath,
        reportAbsPath: p.reportPath,
        repairStateAbsPath,
      }));
      fs.rmSync(auditPath, { force: true });
    }
    attempts.push(await draftComposition({
      compositionDirAbs: p.compositionDir,
      outputAbsPath: p.outputPath,
      reportAbsPath: p.reportPath,
      repairStateAbsPath,
    }));

    expect(attempts[2]).toMatchObject({
      ok: false,
      errorCode: 'E_PREFLIGHT_BLOCKED',
      repair_budget: expect.objectContaining({ budget_exhausted: true, repair_passes_used: 2 }),
    });
    expect(attempts[3]).toMatchObject({ ok: false, errorCode: 'E_REPAIR_BUDGET_EXCEEDED' });
    expect(attempts[3].repair_budget).toMatchObject({ state_path: auditPath });
    expect(fs.existsSync(repairStateAbsPath)).toBe(true);
    expect(fs.existsSync(auditPath)).toBe(true);
  });

  it('S1 resets the exhausted repair budget when the composition content changes', async () => {
    const p = tmpProject('repair-budget-content-change');

    // Exhaust the budget on the (empty) composition: initial draft + 2 repairs.
    for (let i = 0; i < 3; i += 1) {
      await draftComposition({
        compositionDirAbs: p.compositionDir,
        outputAbsPath: p.outputPath,
        reportAbsPath: p.reportPath,
      });
    }
    const blocked = await draftComposition({
      compositionDirAbs: p.compositionDir,
      outputAbsPath: p.outputPath,
      reportAbsPath: p.reportPath,
    });
    expect(blocked).toMatchObject({
      ok: false,
      errorCode: 'E_REPAIR_BUDGET_EXCEEDED',
      requires_user_decision: false,
      same_input_retry_allowed: false,
      next_action: 'repair_inputs_then_retry_draft',
    });

    // The user edits the composition — its source signature changes, so the
    // prior failures are stale and the budget must reset instead of staying
    // permanently bricked.
    writeHtml(p.compositionDir, 'edited after the block');
    const afterEdit = await draftComposition({
      compositionDirAbs: p.compositionDir,
      outputAbsPath: p.outputPath,
      reportAbsPath: p.reportPath,
    });
    expect(afterEdit.errorCode).not.toBe('E_REPAIR_BUDGET_EXCEEDED');
    expect(afterEdit.repair_budget).toMatchObject({ budget_exhausted: false, repair_passes_used: 0 });
  });

  it('classifies only machine/runtime failures as environmental (not content-repairable ones)', () => {
    // These cannot be fixed by editing the composition, so failDraft must not
    // spend a repair pass on them (a constrained machine would otherwise brick).
    for (const code of [
      'E_RENDER_TOO_HEAVY', 'E_FFMPEG_MISSING', 'E_FFPROBE_MISSING',
      'E_RENDER_ABORTED', 'E_CAPTURE_GEOMETRY_INVALID',
    ]) {
      expect(isEnvironmentalDraftFailure(code)).toBe(true);
    }
    // Look-alike guard: content/QA failures and ambiguous timeouts stay
    // budget-consuming (fail-closed) — the model can repair those.
    for (const code of [
      'E_PREFLIGHT_BLOCKED', 'E_LINT_BLOCKED', 'E_INSPECT_BLOCKED',
      'E_MEDIA_QA_BLOCKED', 'E_VIDEO_QA_BLOCKED', 'E_RENDER_CAPTURE_TIMEOUT',
      'E_COMPOSITION_SCRIPT_TIMEOUT', 'E_RENDER_ENCODE_FAILED',
    ]) {
      expect(isEnvironmentalDraftFailure(code)).toBe(false);
    }
  });

  it('does not spend the per-turn full-render limit on environmental failures', () => {
    const attempted = { report: { steps: { render: { ok: false } } } };
    expect(resultConsumesFullRenderTurnBudget({
      ...attempted,
      errorCode: 'E_RENDER_TOO_HEAVY',
    })).toBe(false);
    expect(resultConsumesFullRenderTurnBudget({
      ...attempted,
      errorCode: 'E_CAPTURE_GEOMETRY_INVALID',
    })).toBe(false);
    expect(resultConsumesFullRenderTurnBudget({
      ...attempted,
      errorCode: 'E_VIDEO_QA_BLOCKED',
    })).toBe(true);
    expect(resultConsumesFullRenderTurnBudget({
      report: { steps: { preflight: { ok: false } } },
      errorCode: 'E_PREFLIGHT_BLOCKED',
    })).toBe(false);
  });

  it('normalizes uniform high-DPI captures and rejects distorted geometry', () => {
    const normalizedImage = {
      getSize: () => ({ width: 1920, height: 1080 }),
    };
    const resize = vi.fn(() => normalizedImage);
    const retinaImage = {
      getSize: () => ({ width: 3840, height: 2160 }),
      resize,
    } as unknown as Parameters<typeof normalizeCapturedFrame>[0];

    expect(normalizeCapturedFrame(retinaImage, 1920, 1080)).toMatchObject({
      image: normalizedImage,
      sourceWidth: 3840,
      sourceHeight: 2160,
      scaleFactor: 2,
      normalized: true,
    });
    expect(resize).toHaveBeenCalledWith({ width: 1920, height: 1080, quality: 'best' });

    const distortedImage = {
      getSize: () => ({ width: 3840, height: 2000 }),
      resize: vi.fn(),
    } as unknown as Parameters<typeof normalizeCapturedFrame>[0];
    expect(() => normalizeCapturedFrame(distortedImage, 1920, 1080)).toThrow(
      expect.objectContaining({ errorCode: 'E_CAPTURE_GEOMETRY_INVALID' }),
    );
  });

  it('S2 blocks contract_html mismatches before rendering', async () => {
    const p = tmpProject('contract-html');
    writeHtml(p.compositionDir, 'Launch', { width: 1280, height: 720, duration: 10 });
    writeContract(p.compositionDir);
    writeSceneMap(p.compositionDir);

    const res = await draftComposition({
      compositionDirAbs: p.compositionDir,
      outputAbsPath: p.outputPath,
      reportAbsPath: p.reportPath,
    });

    expect(res).toMatchObject({
      ok: false,
      errorCode: 'E_PREFLIGHT_BLOCKED',
      preflight: expect.objectContaining({
        issues: expect.arrayContaining([expect.objectContaining({ code: 'CANVAS_CONTRACT_MISMATCH' })]),
      }),
    });
    expect(fs.existsSync(p.outputPath)).toBe(false);
  });

  it('blocks an authored absolute timeline second and hands back its offset expression', async () => {
    const p = tmpProject('absolute-timeline-seconds');
    const scenes = [
      { id: 's1', start: 0, duration: 3, headline: 'One', layout_type: 'center-card' },
      { id: 's2', start: 3, duration: 7, headline: 'Two', layout_type: 'split' },
    ];
    const page = (motion: string) => [
      '<!doctype html><html><body>',
      '<main data-composition-id="main" data-width="1920" data-height="1080" data-duration="10">',
      ...scenes.map((scene) => `<section class="clip" data-scene-id="${scene.id}" data-start="${scene.start}" data-duration="${scene.duration}"><h1 data-role="title">${scene.headline}</h1></section>`),
      '</main>',
      `<script>(() => { const tl = gsap.timeline({ paused: true });\n${motion}\n})();</script>`,
      '</body></html>',
    ].join('\n');
    const runQa = async (motion: string) => {
      fs.writeFileSync(path.join(p.compositionDir, 'index.html'), page(motion), 'utf8');
      writeContract(p.compositionDir, { scenes });
      return runContractHtmlQa(
        {
          htmlPath: path.join(p.compositionDir, 'index.html'),
          html: fs.readFileSync(path.join(p.compositionDir, 'index.html'), 'utf8'),
          rootAttrs: {},
          id: 'main',
          width: 1920,
          height: 1080,
          durationSec: 10,
          audioTracks: [],
        } as CompositionMeta,
        [],
        await loadDesignContract(p.compositionDir),
        { path: path.join(p.compositionDir, 'scene-map.json'), exists: false, value: null },
        p.compositionDir,
      );
    };

    const flagged = await runQa('tl.from("h1", { y: 40, duration: 0.6 }, 5.5);');
    const finding = flagged.issues.find((issue) => issue.code === 'AUTHORED_ABSOLUTE_TIMELINE_SECONDS');
    expect(finding?.severity).toBe('error');
    // The host knows s2 starts at 3, so it hands over the rewrite rather than
    // only the complaint — the model applies it without re-deriving anything.
    expect(finding?.message).toContain('5.5 -> S("s2") + 2.5');

    const relative = await runQa('tl.from("h1", { y: 40, duration: 0.6 }, S("s2") + 2.5);');
    expect(relative.issues.map((issue) => issue.code))
      .not.toContain('AUTHORED_ABSOLUTE_TIMELINE_SECONDS');
  });

  it('S3 blocks thin aesthetic contracts before HTML preview', async () => {
    const p = tmpProject('aesthetic-contract-hard-gate');
    fs.writeFileSync(path.join(p.compositionDir, 'index.html'), [
      '<!doctype html><html><body>',
      '<main data-composition-id="main" data-width="1920" data-height="1080" data-duration="10">',
      '<section class="clip" data-scene-id="s1" data-start="0" data-duration="3"><h1 data-role="title">Launch</h1></section>',
      '<section class="clip" data-scene-id="s2" data-start="3" data-duration="3"><h1 data-role="title">Launch</h1></section>',
      '<section class="clip" data-scene-id="s3" data-start="6" data-duration="4"><h1 data-role="title">Launch</h1></section>',
      '</main></body></html>',
    ].join('\n'), 'utf8');
    writeContract(p.compositionDir, {
      scenes: [
        { id: 's1', start: 0, duration: 3, headline: 'Launch', layout_type: 'center-card' },
        { id: 's2', start: 3, duration: 3, headline: 'Launch', layout_type: 'center-card' },
        { id: 's3', start: 6, duration: 4, headline: 'Launch', layout_type: 'center-card' },
      ],
      color_tokens: {
        primary: '#2233ff',
        secondary: '#3344ee',
        accent: '#4455dd',
      },
    });
    const html = fs.readFileSync(path.join(p.compositionDir, 'index.html'), 'utf8');
    const meta: CompositionMeta = {
      htmlPath: path.join(p.compositionDir, 'index.html'),
      html,
      rootAttrs: {},
      id: 'main',
      width: 1920,
      height: 1080,
      durationSec: 10,
      audioTracks: [],
    };

    const qa = await runContractHtmlQa(
      meta,
      [],
      await loadDesignContract(p.compositionDir),
      { path: path.join(p.compositionDir, 'scene-map.json'), exists: false, value: null },
      p.compositionDir,
    );

    expect(qa).toMatchObject({ ok: false });
    expect(qa.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'DESIGN_CONTRACT_BUDGET_INCOMPLETE', severity: 'error' }),
      expect.objectContaining({ code: 'AESTHETIC_THESIS_INCOMPLETE', severity: 'error' }),
      expect.objectContaining({ code: 'SCENE_DEPTH_LAYERS_MISSING', severity: 'error' }),
      expect.objectContaining({ code: 'SCENE_MOTION_VERBS_MISSING', severity: 'error' }),
      expect.objectContaining({ code: 'SCENE_VARIATION_LOW', severity: 'warning' }),
      expect.objectContaining({ code: 'ONE_NOTE_PALETTE', severity: 'warning' }),
    ]));
  });

  it('accepts depth and motion by meaning, not by one key spelling (the 2026-08-06 six-segment stall)', async () => {
    // Six compose segments carried {background, midground, foreground,
    // motion, hero_visual} per scene — the exact shape the old fixHint
    // taught — and every lint failed SCENE_DEPTH_LAYERS_MISSING +
    // SCENE_MOTION_VERBS_MISSING three times until the model declared the
    // checker broken. The rule wants the depth design, not the key name.
    const p = tmpProject('depth-motion-semantic-acceptance');
    fs.writeFileSync(path.join(p.compositionDir, 'index.html'), [
      '<!doctype html><html><body>',
      '<main data-composition-id="main" data-width="1920" data-height="1080" data-duration="10">',
      '<section class="clip" data-scene-id="s2_pain" data-start="0" data-duration="10"><h1 data-role="title">Launch</h1></section>',
      '</main></body></html>',
    ].join('\n'), 'utf8');
    writeContract(p.compositionDir, {
      scenes: {
        s2_pain: {
          background: 'deep terminal #080C14',
          midground: 'chat bubbles fade sequence',
          foreground: 'red rejection list',
          motion: ['fadeIn bubble1', 'fadeIn bubble2', 'fadeUp danger-list'],
          hero_visual: 'center chat bubble stack',
        },
      },
    });
    const html = fs.readFileSync(path.join(p.compositionDir, 'index.html'), 'utf8');
    const meta: CompositionMeta = {
      htmlPath: path.join(p.compositionDir, 'index.html'),
      html,
      rootAttrs: {},
      id: 'main',
      width: 1920,
      height: 1080,
      durationSec: 10,
      audioTracks: [],
    };
    const qa = await runContractHtmlQa(
      meta,
      [],
      await loadDesignContract(p.compositionDir),
      { path: path.join(p.compositionDir, 'scene-map.json'), exists: false, value: null },
      p.compositionDir,
    );
    const codes = qa.issues.map((issue) => issue.code);
    expect(codes).not.toContain('SCENE_DEPTH_LAYERS_MISSING');
    expect(codes).not.toContain('SCENE_MOTION_VERBS_MISSING');

    // Negative control: one layer alone is not a depth design, and the
    // fixHints must now name the canonical keys so the loop cannot re-form.
    writeContract(p.compositionDir, {
      scenes: { s2_pain: { background: 'deep terminal', hero_visual: 'stack' } },
    });
    const partial = await runContractHtmlQa(
      meta,
      [],
      await loadDesignContract(p.compositionDir),
      { path: path.join(p.compositionDir, 'scene-map.json'), exists: false, value: null },
      p.compositionDir,
    );
    const depthIssue = partial.issues.find((issue) => issue.code === 'SCENE_DEPTH_LAYERS_MISSING');
    const motionIssue = partial.issues.find((issue) => issue.code === 'SCENE_MOTION_VERBS_MISSING');
    expect(depthIssue).toBeTruthy();
    expect(motionIssue).toBeTruthy();
    expect(depthIssue?.fixHint).toContain('`depth_layers`');
    expect(motionIssue?.fixHint).toContain('`motion_verbs`');
  });

  it('S3 blocks incomplete VisualDirectionV1 before front-loaded HTML preview', async () => {
    const p = tmpProject('visual-direction-hard-gate');
    fs.writeFileSync(path.join(p.compositionDir, 'index.html'), [
      '<!doctype html><html><body>',
      '<main data-composition-id="main" data-width="1920" data-height="1080" data-duration="10">',
      '<section class="clip" data-scene-id="cover" data-start="0" data-duration="10"><h1 data-role="title">Launch</h1></section>',
      '</main></body></html>',
    ].join('\n'), 'utf8');
    writeContract(p.compositionDir, {
      aesthetic: {
        subject_world: 'research desk, paper fragments, token streams',
        one_job: 'make the breakthrough sequence feel like evidence becoming motion',
        signature_device: 'an amber signal path that transforms between scenes',
        aesthetic_risk: 'avoid generic node diagrams by using topic materials',
        anti_template_check: 'reject centered cards and circles connected by lines',
      },
      visual_direction: {
        visual_tradition: 'Swiss Pulse precision grid',
      },
      scenes: [
        {
          id: 'cover',
          start: 0,
          duration: 10,
          headline: 'Launch',
          layout_type: 'research-atlas',
        },
      ],
      layout_boxes: { safe_margin: 96, visual_zone: 'full-field hero visual' },
      typography_tokens: { title: 'display', body: 'supporting', label: 'technical label' },
      color_tokens: { bg: '#071018', ink: '#f3efe6', accent: '#f2a900' },
      motion_budget: { rule: 'resolved frame first, then entrances' },
      scene_variation: { rule: 'vary scene grammar and focal mass' },
    });
    const html = fs.readFileSync(path.join(p.compositionDir, 'index.html'), 'utf8');
    const meta: CompositionMeta = {
      htmlPath: path.join(p.compositionDir, 'index.html'),
      html,
      rootAttrs: {},
      id: 'main',
      width: 1920,
      height: 1080,
      durationSec: 10,
      audioTracks: [],
    };

    const qa = await runContractHtmlQa(
      meta,
      [],
      await loadDesignContract(p.compositionDir),
      { path: path.join(p.compositionDir, 'scene-map.json'), exists: false, value: null },
      p.compositionDir,
    );

    expect(qa).toMatchObject({ ok: false });
    expect(qa.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'VISUAL_DIRECTION_INCOMPLETE', severity: 'error' }),
      expect.objectContaining({ code: 'SCENE_DEPTH_LAYERS_MISSING', severity: 'error' }),
      expect.objectContaining({ code: 'SCENE_MOTION_VERBS_MISSING', severity: 'error' }),
    ]));
  });

  it('S3 accepts legacy anti_template as anti_template_check for aesthetic QA', async () => {
    const p = tmpProject('aesthetic-anti-template-alias');
    fs.writeFileSync(path.join(p.compositionDir, 'index.html'), [
      '<!doctype html><html><body>',
      '<main data-composition-id="main" data-width="1920" data-height="1080" data-duration="10">',
      '<section class="clip" data-scene-id="cover" data-start="0" data-duration="10"><h1 data-role="title">Launch</h1></section>',
      '</main></body></html>',
    ].join('\n'), 'utf8');
    writeContract(p.compositionDir, {
      aesthetic: {
        subject_world: 'research desk, paper fragments, token streams',
        one_job: 'make the breakthrough sequence feel like evidence becoming motion',
        signature_device: 'an amber signal path that transforms between scenes',
        aesthetic_risk: 'avoid generic node diagrams by using topic materials',
        anti_template: 'reject centered cards and circles connected by lines',
      },
      visual_direction: {
        visual_tradition: 'Swiss Pulse precision grid',
        lazy_defaults_rejected: 'reject centered cards and circles connected by lines; replace with evidence fragments crossing a measured grid',
        video_scale: { hero_title_min_px: 88, label_min_px: 28 },
        depth_layer_rule: 'paper field, amber evidence path, foreground measurement ticks',
        motion_verb_rule: ['gather', 'align', 'resolve'],
        rhythm_pattern: 'quick evidence gather, measured hold, final resolve',
      },
      cover: {
        scene_id: 'cover',
        headline: 'Launch',
        content_signals: ['launch subject', 'amber signal path'],
        hero_visual: 'launch subject held against the signal path',
        composition_strategy: 'approved headline and launch hero share one dominant frame',
        frame_time_sec: 0,
      },
      scenes: [{
        id: 'cover',
        start: 0,
        duration: 10,
        headline: 'Launch',
        depth_layers: ['paper field', 'amber path', 'measurement ticks'],
        motion_verbs: ['gather', 'resolve'],
      }],
      layout_boxes: { safe_margin: 96, visual_zone: 'full-field hero visual' },
      typography_tokens: { title: 'display', body: 'supporting', label: 'technical label' },
      color_tokens: { bg: '#071018', ink: '#f3efe6', accent: '#f2a900' },
      motion_budget: { rule: 'resolved frame first, then entrances' },
      scene_variation: { rule: 'vary scene grammar and focal mass' },
    });
    const html = fs.readFileSync(path.join(p.compositionDir, 'index.html'), 'utf8');
    const meta: CompositionMeta = {
      htmlPath: path.join(p.compositionDir, 'index.html'),
      html,
      rootAttrs: {},
      id: 'main',
      width: 1920,
      height: 1080,
      durationSec: 10,
      audioTracks: [],
    };

    const qa = await runContractHtmlQa(
      meta,
      [],
      await loadDesignContract(p.compositionDir),
      { path: path.join(p.compositionDir, 'scene-map.json'), exists: false, value: null },
      p.compositionDir,
    );

    expect(qa).toMatchObject({ ok: true, error_count: 0 });
    expect(qa.issues).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'AESTHETIC_THESIS_INCOMPLETE' }),
    ]));
  });

  it('S3 blocks a composition whose frame-zero cover was never designed as a content contract', async () => {
    const p = tmpProject('cover-contract');
    writeHtml(p.compositionDir, 'Launch');
    const art = completeArtDirection();
    delete art.cover;
    writeContract(p.compositionDir, art);
    const qa = await runContractHtmlQa(
      {
        htmlPath: path.join(p.compositionDir, 'index.html'),
        html: fs.readFileSync(path.join(p.compositionDir, 'index.html'), 'utf8'),
        rootAttrs: {}, id: 'main', width: 1920, height: 1080, durationSec: 10, audioTracks: [],
      },
      [],
      await loadDesignContract(p.compositionDir),
      { path: path.join(p.compositionDir, 'scene-map.json'), exists: false, value: null },
      p.compositionDir,
    );
    expect(qa).toMatchObject({ ok: false });
    expect(qa.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'COVER_CONTRACT_INCOMPLETE', severity: 'error' }),
    ]));
  });

  it('S3 requires no cover contract at all from a mid-film segment', async () => {
    // The contract layer is where the cover demand is born: requiring the
    // fields at inspect makes the model author a poster frame for a segment
    // that plays at a cut, and the frame layer then enforces it. Both layers
    // read the same delivered-opening determination.
    const p = tmpProject('cover-contract-mid-film');
    writeHtml(p.compositionDir, 'Launch');
    const art = completeArtDirection();
    delete art.cover;
    writeContract(p.compositionDir, art);
    const qa = await runContractHtmlQa(
      {
        htmlPath: path.join(p.compositionDir, 'index.html'),
        html: fs.readFileSync(path.join(p.compositionDir, 'index.html'), 'utf8'),
        rootAttrs: {}, id: 'main', width: 1920, height: 1080, durationSec: 10, audioTracks: [],
      },
      [],
      await loadDesignContract(p.compositionDir),
      { path: path.join(p.compositionDir, 'scene-map.json'), exists: false, value: null },
      p.compositionDir,
      { isDeliveredOpening: false },
    );
    expect(qa.issues).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ code: expect.stringMatching(/^COVER_/) }),
    ]));
  });

  it('S3 requires reference images to remain local, intent-bound, anchored, and scored', async () => {
    const p = tmpProject('reference-fidelity-contract');
    writeHtml(p.compositionDir, 'Launch');
    const art = completeArtDirection();
    art.references = [{
      id: 'source-image',
      media_type: 'image',
      path: 'assets/references/source.png',
      intent: 'reproduce',
      intent_basis: 'user',
      roles: ['composition', 'content', 'style'],
      required: true,
      preserve: ['composition', 'typography', 'palette', 'geometry'],
      may_change: ['copy', 'timing'],
      target_scene_ids: ['cover'],
    }];
    writeContract(p.compositionDir, art);
    let qa = await runContractHtmlQa(
      {
        htmlPath: path.join(p.compositionDir, 'index.html'),
        html: fs.readFileSync(path.join(p.compositionDir, 'index.html'), 'utf8'),
        rootAttrs: {}, id: 'main', width: 1920, height: 1080, durationSec: 10, audioTracks: [],
      }, [], await loadDesignContract(p.compositionDir),
      { path: path.join(p.compositionDir, 'scene-map.json'), exists: false, value: null }, p.compositionDir,
    );
    // Advisory: these four fields set the bar the fidelity review scores
    // against and change nothing that renders, so an incomplete contract
    // reports without stopping preview or render. The reference list itself
    // (id, anchor, local path) stays blocking below.
    expect(qa.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'REFERENCE_FIDELITY_CONTRACT_INCOMPLETE', severity: 'warning' }),
    ]));

    fs.mkdirSync(path.join(p.compositionDir, 'assets', 'references'), { recursive: true });
    fs.writeFileSync(path.join(p.compositionDir, 'assets', 'references', 'source.png'), 'reference');
    art.reference_fidelity = {
      mode: 'exact',
      preserve: ['composition', 'typography', 'palette', 'geometry'],
      may_change: ['copy', 'timing'],
      layout_anchors: [{ id: 'hero', role: 'hero', bounds: { x: 0.08, y: 0.12, width: 0.5, height: 0.7 } }],
      verification: { minimum_score: 90, compare_frames: ['first-frame'] },
    };
    writeContract(p.compositionDir, art);
    qa = await runContractHtmlQa(
      {
        htmlPath: path.join(p.compositionDir, 'index.html'),
        html: fs.readFileSync(path.join(p.compositionDir, 'index.html'), 'utf8'),
        rootAttrs: {}, id: 'main', width: 1920, height: 1080, durationSec: 10, audioTracks: [],
      }, [], await loadDesignContract(p.compositionDir),
      { path: path.join(p.compositionDir, 'scene-map.json'), exists: false, value: null }, p.compositionDir,
    );
    expect(qa).toMatchObject({ ok: true, error_count: 0 });
    expect(qa.issues).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'REFERENCE_FIDELITY_CONTRACT_INCOMPLETE' }),
      expect.objectContaining({ code: 'REFERENCE_FIDELITY_ASSET_MISSING' }),
    ]));
  });

  it('S3 defaults an unspecified reference intent to guide and validates any declared basis', async () => {
    const p = tmpProject('reference-intent-default');
    writeHtml(p.compositionDir, 'Launch');
    fs.mkdirSync(path.join(p.compositionDir, 'assets', 'references'), { recursive: true });
    fs.writeFileSync(path.join(p.compositionDir, 'assets', 'references', 'look.png'), 'reference');
    const art = completeArtDirection();
    art.references = [{
      id: 'look',
      media_type: 'image',
      path: 'assets/references/look.png',
      roles: ['style'],
      required: false,
      preserve: ['palette'],
      may_change: ['content', 'layout'],
      target_scene_ids: ['cover'],
    }];
    art.reference_fidelity = {
      mode: 'close',
      preserve: ['palette'],
      may_change: ['content', 'layout'],
      layout_anchors: [],
      verification: { minimum_score: 75, compare_frames: ['first-frame'] },
    };
    writeContract(p.compositionDir, art);
    let qa = await runContractHtmlQa(
      {
        htmlPath: path.join(p.compositionDir, 'index.html'),
        html: fs.readFileSync(path.join(p.compositionDir, 'index.html'), 'utf8'),
        rootAttrs: {}, id: 'main', width: 1920, height: 1080, durationSec: 10, audioTracks: [],
      }, [], await loadDesignContract(p.compositionDir),
      { path: path.join(p.compositionDir, 'scene-map.json'), exists: false, value: null }, p.compositionDir,
    );
    expect(qa).toMatchObject({ ok: true, error_count: 0 });

    (art.references as Array<Record<string, unknown>>)[0].intent_basis = 'file-origin';
    writeContract(p.compositionDir, art);
    qa = await runContractHtmlQa(
      {
        htmlPath: path.join(p.compositionDir, 'index.html'),
        html: fs.readFileSync(path.join(p.compositionDir, 'index.html'), 'utf8'),
        rootAttrs: {}, id: 'main', width: 1920, height: 1080, durationSec: 10, audioTracks: [],
      }, [], await loadDesignContract(p.compositionDir),
      { path: path.join(p.compositionDir, 'scene-map.json'), exists: false, value: null }, p.compositionDir,
    );
    expect(qa.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'REFERENCE_MEDIA_CONTRACT_INVALID', severity: 'error' }),
    ]));
  });

  it('S3 gives reference video the same contract plus temporal anchors', async () => {
    const p = tmpProject('reference-video-contract');
    writeHtml(p.compositionDir, 'Launch');
    fs.mkdirSync(path.join(p.compositionDir, 'assets', 'references'), { recursive: true });
    fs.writeFileSync(path.join(p.compositionDir, 'assets', 'references', 'source.mp4'), 'reference-video');
    const art = completeArtDirection();
    art.references = [{
      id: 'source-video',
      media_type: 'video',
      path: 'assets/references/source.mp4',
      intent: 'edit',
      intent_basis: 'user',
      roles: ['content', 'motion', 'timing'],
      required: true,
      preserve: ['subject', 'camera path', 'beat timing'],
      may_change: ['copy'],
      target_scene_ids: ['cover'],
    }];
    art.reference_fidelity = {
      mode: 'close',
      preserve: ['subject', 'camera path', 'beat timing'],
      may_change: ['copy'],
      layout_anchors: [],
      verification: { minimum_score: 82, compare_frames: ['first-frame', 'payoff'] },
    };
    writeContract(p.compositionDir, art);
    let qa = await runContractHtmlQa(
      {
        htmlPath: path.join(p.compositionDir, 'index.html'),
        html: fs.readFileSync(path.join(p.compositionDir, 'index.html'), 'utf8'),
        rootAttrs: {}, id: 'main', width: 1920, height: 1080, durationSec: 10, audioTracks: [],
      }, [], await loadDesignContract(p.compositionDir),
      { path: path.join(p.compositionDir, 'scene-map.json'), exists: false, value: null }, p.compositionDir,
    );
    expect(qa.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'REFERENCE_VIDEO_TEMPORAL_ANCHORS_REQUIRED', severity: 'error' }),
    ]));

    (art.references as Array<Record<string, unknown>>)[0].temporal_anchors = [{
      source_start_sec: 0,
      source_end_sec: 4,
      target_scene_id: 'cover',
    }];
    writeContract(p.compositionDir, art);
    qa = await runContractHtmlQa(
      {
        htmlPath: path.join(p.compositionDir, 'index.html'),
        html: fs.readFileSync(path.join(p.compositionDir, 'index.html'), 'utf8'),
        rootAttrs: {}, id: 'main', width: 1920, height: 1080, durationSec: 10, audioTracks: [],
      }, [], await loadDesignContract(p.compositionDir),
      { path: path.join(p.compositionDir, 'scene-map.json'), exists: false, value: null }, p.compositionDir,
    );
    expect(qa).toMatchObject({ ok: true, error_count: 0 });
  });

  it('scores cover communication and enforces the declared reference-fidelity floor', () => {
    const scores = compileVideoStudioDesignQualityScorecard({
      content_alignment: 92,
      cover_communication: 90,
      hierarchy: 88,
      text_legibility: 94,
      motion_readiness: 86,
      specificity: 87,
      reference_fidelity: 82,
    }, true);
    expect(scores).toMatchObject({ cover_communication: 90, reference_fidelity: 82 });
    expect(() => assertVideoStudioDesignQualityVerdict('passed', [], scores, 90))
      .toThrow('E_REFERENCE_FIDELITY_BELOW_FLOOR');
    expect(() => assertVideoStudioDesignQualityVerdict('passed', [], { ...scores, reference_fidelity: 92 }, 90))
      .not.toThrow();
  });

  it('derives a stable dedicated cover path beside the rendered video', () => {
    expect(videoCoverArtifactPath('/tmp/project/final.mp4')).toBe(path.resolve('/tmp/project/final-cover.png'));
    expect(videoCoverArtifactPath('/tmp/project/final')).toBe(path.resolve('/tmp/project/final-cover.png'));
  });

  it('materializes the QA-approved first frame as the dedicated cover artifact', async () => {
    const p = tmpProject('cover-artifact');
    const renderedVideo = path.join(p.renderDir, 'final.mp4');
    const firstFrame = path.join(p.renderDir, 'evidence', 'first-frame.png');
    fs.mkdirSync(path.dirname(firstFrame), { recursive: true });
    fs.writeFileSync(firstFrame, 'approved-cover-frame');
    const cover = await materializeVideoCover(renderedVideo, {
      evidence_dir: path.dirname(firstFrame),
      contact_sheet: '',
      frame_paths: [firstFrame],
      samples: [{
        label: 'first-frame',
        time_seconds: 0,
        frame_index: 0,
        path: firstFrame,
        hash: 'frame-hash',
        brightness: 0.5,
        contrast: 0.5,
        width: 1920,
        height: 1080,
      }],
    });
    expect(cover).toMatchObject({ path: videoCoverArtifactPath(renderedVideo), source_frame: firstFrame, label: 'first-frame' });
    expect(fs.readFileSync(cover.path, 'utf8')).toBe('approved-cover-frame');
  });

  it('S3 reads scene art direction when scenes are keyed by id', async () => {
    const p = tmpProject('aesthetic-scenes-object-map');
    writeHtml(p.compositionDir, 'Launch');
    const art = completeArtDirection(['cover']);
    const [scene] = art.scenes as Array<Record<string, unknown>>;
    writeContract(p.compositionDir, {
      ...art,
      scenes: {
        cover: {
          ...scene,
          id: undefined,
        },
      },
    });
    const html = fs.readFileSync(path.join(p.compositionDir, 'index.html'), 'utf8');
    const meta: CompositionMeta = {
      htmlPath: path.join(p.compositionDir, 'index.html'),
      html,
      rootAttrs: {},
      id: 'main',
      width: 1920,
      height: 1080,
      durationSec: 10,
      audioTracks: [],
    };

    const qa = await runContractHtmlQa(
      meta,
      [],
      await loadDesignContract(p.compositionDir),
      { path: path.join(p.compositionDir, 'scene-map.json'), exists: false, value: null },
      p.compositionDir,
    );

    expect(qa.issues).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'SCENE_DEPTH_LAYERS_MISSING' }),
      expect.objectContaining({ code: 'SCENE_MOTION_VERBS_MISSING' }),
    ]));
  });

  it('S2 scans HTML/CSS resources structurally without treating script text as markup', () => {
    const structure = parseHtmlStructure([
      '<!doctype html>',
      '<html><head>',
      '<style>.hero { background: url("./assets/hero image.png"); }</style>',
      '<script>const fake = `<img src="https://example.test/fake.png">`;</script>',
      '</head><body>',
      '<main data-composition-id="main" data-width="1920" data-height="1080" data-duration="10" title="A > B">',
      '<img src="./assets/real.png">',
      '</main></body></html>',
    ].join('\n'));

    expect(structure.tags.find((tag) => tag.attrs['data-composition-id'])?.attrs.title).toBe('A > B');
    expect(extractHtmlResourceRefs(structure)).toEqual(expect.arrayContaining([
      { attr: 'style-url', ref: './assets/hero image.png' },
      { attr: 'src', ref: './assets/real.png' },
    ]));
    expect(extractHtmlResourceRefs(structure).some((item) => item.ref.includes('example.test'))).toBe(false);
  });

  it('S2 discovers recursive CSS imports and blocks nested remote resources', async () => {
    const p = tmpProject('nested-css-import');
    writeHtml(p.compositionDir, 'Launch');
    writeManifest(p.compositionDir);
    const htmlPath = path.join(p.compositionDir, 'index.html');
    fs.writeFileSync(htmlPath, fs.readFileSync(htmlPath, 'utf8').replace(
      '<html><body>',
      '<html><head><link rel="stylesheet" href="./styles/root.css"></head><body>',
    ));
    fs.mkdirSync(path.join(p.compositionDir, 'styles'), { recursive: true });
    fs.writeFileSync(path.join(p.compositionDir, 'styles', 'root.css'), '@import "nested.css";');
    fs.writeFileSync(path.join(p.compositionDir, 'styles', 'nested.css'), '@import url("https://example.test/remote.css");');

    expect(extractCssImports('@import "a.css"; @import url(\'b.css\');')).toEqual(['a.css', 'b.css']);
    const result = await preflightComposition({ compositionDirAbs: p.compositionDir });
    expect(result.ok).toBe(false);
    expect(result.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'REMOTE_RESOURCE_BLOCKED' }),
    ]));
  });

  it('S3 builds a complete per-scene preview plan from scene midpoints', () => {
    const meta: CompositionMeta = {
      htmlPath: '/tmp/index.html',
      html: '',
      rootAttrs: {},
      id: 'main',
      width: 1920,
      height: 1080,
      durationSec: 40,
      audioTracks: [],
    };
    const plan = buildPreviewFrameSamplePlan(meta, {
      scenes: Array.from({ length: 8 }, (_, index) => ({
        id: `s${index + 1}`,
        start: index * 5,
        duration: 5,
      })),
    });

    expect(plan).toHaveLength(10);
    expect(plan[0]).toMatchObject({ label: 'first-frame', timeSec: 0 });
    expect(plan.at(-1)?.label).toBe('payoff-frame');
    expect(plan.filter((sample) => sample.label.endsWith('-mid'))).toHaveLength(8);
  });

  it('samples stable scene midpoints for inspect instead of tween boundaries', () => {
    const meta: CompositionMeta = {
      htmlPath: '/tmp/index.html', html: '', rootAttrs: {}, id: 'main',
      width: 1920, height: 1080, durationSec: 60, audioTracks: [],
    };
    const plan = buildInspectFrameSamplePlan(meta, {
      scenes: [
        { id: 'hook', start: 0, duration: 14 },
        { id: 'proof', start: 14, duration: 8 },
        { id: 'outro', start: 56, duration: 4 },
      ],
    });

    expect(plan).toEqual([
      expect.objectContaining({ sceneId: 'hook', timeSec: 7 }),
      expect.objectContaining({ sceneId: 'proof', timeSec: 18 }),
      expect.objectContaining({ sceneId: 'outro', timeSec: 58 }),
    ]);
    expect(plan.map((sample) => sample.timeSec)).not.toContain(59.95);
  });

  it('builds inspect probes that require effective ancestor visibility and the expected scene', () => {
    const script = buildInspectScript({
      htmlPath: '/tmp/index.html', html: '', rootAttrs: {}, id: 'main',
      width: 1920, height: 1080, durationSec: 10, audioTracks: [],
    } as any, 5, 'active-scene');

    expect(script).toContain('while (cur && cur.nodeType === Node.ELEMENT_NODE)');
    expect(script).toContain('sceneId !== expectedSceneId');
    expect(script).toContain('"active-scene"');
  });

  it('S2 accepts complete semantic scene/role hook coverage', async () => {
    const p = tmpProject('semantic-hooks');
    const html = [
      '<!doctype html><html><body>',
      '<main data-composition-id="main" data-width="1920" data-height="1080" data-duration="10">',
      '<section class="clip" data-scene-id="s1" data-start="0" data-duration="5"><h1 data-role="title">Launch</h1></section>',
      '<section class="clip" data-scene-id="s2" data-start="5" data-duration="5"><h2 data-role="title">Payoff</h2></section>',
      '</main></body></html>',
    ].join('\n');
    fs.writeFileSync(path.join(p.compositionDir, 'index.html'), html, 'utf8');
    writeContract(p.compositionDir, {
      ...completeArtDirection(['s1', 's2']),
      scenes: [
        {
          id: 's1',
          start: 0,
          duration: 5,
          headline: 'Launch',
          depth_layers: ['quiet field', 'launch title', 'measurement accents'],
          motion_verbs: ['draw', 'resolve'],
        },
        {
          id: 's2',
          start: 5,
          duration: 5,
          headline: 'Payoff',
          depth_layers: ['quiet field', 'payoff title', 'measurement accents'],
          motion_verbs: ['align', 'resolve'],
        },
      ],
    });
    const meta: CompositionMeta = {
      htmlPath: path.join(p.compositionDir, 'index.html'),
      html,
      rootAttrs: {},
      id: 'main',
      width: 1920,
      height: 1080,
      durationSec: 10,
      audioTracks: [],
    };

    const qa = await runContractHtmlQa(
      meta,
      [],
      await loadDesignContract(p.compositionDir),
      { path: path.join(p.compositionDir, 'scene-map.json'), exists: false, value: null },
      p.compositionDir,
    );

    expect(qa).toMatchObject({
      ok: true,
      semantic_hooks: expect.objectContaining({ coverage: 1, matched_scene_count: 2, role_hook_count: 2 }),
    });
    expect((qa.issues as Array<{ code: string }>).some((issue) => issue.code === 'SEMANTIC_SCENE_HOOKS_MISSING')).toBe(false);
  });

  it('S2 blocks missing semantic scene/role hooks before rendering', async () => {
    const p = tmpProject('semantic-hooks-missing');
    const html = [
      '<!doctype html><html><body>',
      '<main data-composition-id="main" data-width="1920" data-height="1080" data-duration="10">',
      '<section class="clip" data-start="0" data-duration="10"><h1>Launch</h1></section>',
      '</main></body></html>',
    ].join('\n');
    fs.writeFileSync(path.join(p.compositionDir, 'index.html'), html, 'utf8');
    writeContract(p.compositionDir);
    const meta: CompositionMeta = {
      htmlPath: path.join(p.compositionDir, 'index.html'),
      html,
      rootAttrs: {},
      id: 'main',
      width: 1920,
      height: 1080,
      durationSec: 10,
      audioTracks: [],
    };

    const qa = await runContractHtmlQa(
      meta,
      [],
      await loadDesignContract(p.compositionDir),
      { path: path.join(p.compositionDir, 'scene-map.json'), exists: false, value: null },
      p.compositionDir,
    );

    expect(qa).toMatchObject({
      ok: false,
      issues: expect.arrayContaining([
        expect.objectContaining({ code: 'SEMANTIC_SCENE_HOOKS_MISSING', severity: 'error' }),
        expect.objectContaining({ code: 'SEMANTIC_ROLE_HOOKS_MISSING', severity: 'error' }),
      ]),
    });
  });

  it('S2 blocks seek-unsafe GSAP callbacks such as tl.call()', async () => {
    const p = tmpProject('gsap-callback');
    writeHtml(p.compositionDir, 'Launch');
    fs.appendFileSync(path.join(p.compositionDir, 'index.html'), [
      '<script src="./assets/vendor/gsap.min.js"></script>',
      '<script>',
      'window.__timelines = window.__timelines || {};',
      'const tl = gsap.timeline({ paused: true });',
      'window.__timelines.main = tl;',
      'tl.call(() => document.body.classList.add("active"), null, 1);',
      '</script>',
    ].join('\n'), 'utf8');
    writeContract(p.compositionDir);
    const html = fs.readFileSync(path.join(p.compositionDir, 'index.html'), 'utf8');
    const meta: CompositionMeta = {
      htmlPath: path.join(p.compositionDir, 'index.html'),
      html,
      rootAttrs: {},
      id: 'main',
      width: 1920,
      height: 1080,
      durationSec: 10,
      audioTracks: [],
    };

    const qa = await runContractHtmlQa(
      meta,
      [],
      await loadDesignContract(p.compositionDir),
      { path: path.join(p.compositionDir, 'scene-map.json'), exists: false, value: null },
      p.compositionDir,
    );

    expect(qa).toMatchObject({
      ok: false,
      issues: expect.arrayContaining([expect.objectContaining({ code: 'GSAP_CALLBACK_NOT_SEEKABLE', severity: 'error' })]),
    });
  });

  it('S2 blocks GSAP compositions that are not paused and registered for deterministic seeking', async () => {
    const p = tmpProject('gsap-seek-contract');
    writeContract(p.compositionDir);
    const baseHtml = [
      '<!doctype html><html><head><script src="./assets/vendor/gsap.min.js"></script></head><body>',
      '<main data-composition-id="main" data-width="1920" data-height="1080" data-duration="10">',
      '<section class="clip" data-start="0" data-duration="10">Launch</section>',
      '</main>',
      '<script>const tl = gsap.timeline(); tl.to(".clip", { opacity: 1 });</script>',
      '</body></html>',
    ].join('\n');
    const meta: CompositionMeta = {
      htmlPath: path.join(p.compositionDir, 'index.html'),
      html: baseHtml,
      rootAttrs: {},
      id: 'main',
      width: 1920,
      height: 1080,
      durationSec: 10,
      audioTracks: [],
    };

    const blocked = await runContractHtmlQa(
      meta,
      [],
      await loadDesignContract(p.compositionDir),
      { path: path.join(p.compositionDir, 'scene-map.json'), exists: false, value: null },
      p.compositionDir,
    );
    expect(blocked).toMatchObject({
      ok: false,
      issues: expect.arrayContaining([
        expect.objectContaining({ code: 'GSAP_TIMELINE_NOT_REGISTERED', severity: 'error' }),
        expect.objectContaining({ code: 'GSAP_TIMELINE_NOT_PAUSED', severity: 'error' }),
      ]),
    });

    const validHtml = baseHtml.replace(
      'const tl = gsap.timeline(); tl.to(".clip", { opacity: 1 });',
      'window.__timelines = window.__timelines || {}; const tl = gsap.timeline({ paused: true }); tl.to(".clip", { opacity: 1 }); window.__timelines["main"] = tl;',
    );
    const allowed = await runContractHtmlQa(
      { ...meta, html: validHtml },
      [],
      await loadDesignContract(p.compositionDir),
      { path: path.join(p.compositionDir, 'scene-map.json'), exists: false, value: null },
      p.compositionDir,
    );
    expect((allowed.issues as Array<{ code: string }>).some((issue) => issue.code.startsWith('GSAP_TIMELINE_'))).toBe(false);
  });

  it('S2 blocks all-hidden scene roots before spending time on a blank video render', async () => {
    const p = tmpProject('hidden-scene-roots');
    const html = [
      '<!doctype html><html><body>',
      '<main data-composition-id="main" data-width="1920" data-height="1080" data-duration="10">',
      '<section data-scene-id="s1" data-role="focal-visual" style="display:none">Launch</section>',
      '<section data-scene-id="s2" data-role="focal-visual" style="display:none">Payoff</section>',
      '</main>',
      '<script src="./assets/vendor/gsap.min.js"></script>',
      '<script>gsap.to("[data-scene-id]", { opacity: 1 });</script>',
      '</body></html>',
    ].join('\n');
    fs.writeFileSync(path.join(p.compositionDir, 'index.html'), html, 'utf8');
    writeContract(p.compositionDir, {
      scenes: [
        { id: 's1', start: 0, duration: 5, headline: 'Launch' },
        { id: 's2', start: 5, duration: 5, headline: 'Payoff' },
      ],
    });
    const meta: CompositionMeta = {
      htmlPath: path.join(p.compositionDir, 'index.html'),
      html,
      rootAttrs: {},
      id: 'main',
      width: 1920,
      height: 1080,
      durationSec: 10,
      audioTracks: [],
    };

    const qa = await runContractHtmlQa(
      meta,
      [],
      await loadDesignContract(p.compositionDir),
      { path: path.join(p.compositionDir, 'scene-map.json'), exists: false, value: null },
      p.compositionDir,
    );

    expect(qa).toMatchObject({
      ok: false,
      scene_visibility: expect.objectContaining({
        hidden_scene_count: 2,
        display_activation_detected: false,
      }),
      issues: expect.arrayContaining([
        expect.objectContaining({ code: 'SCENE_ROOTS_NEVER_DISPLAYED', severity: 'error' }),
      ]),
    });

    const activatedHtml = html.replace(
      'gsap.to("[data-scene-id]", { opacity: 1 });',
      'gsap.set("[data-scene-id]", { display: "block", opacity: 1 });',
    );
    const activatedQa = await runContractHtmlQa(
      { ...meta, html: activatedHtml },
      [],
      await loadDesignContract(p.compositionDir),
      { path: path.join(p.compositionDir, 'scene-map.json'), exists: false, value: null },
      p.compositionDir,
    );
    expect((activatedQa.issues as Array<{ code: string }>).some(
      (issue) => issue.code === 'SCENE_ROOTS_NEVER_DISPLAYED',
    )).toBe(false);
  });

  it('S3 keeps golden visual regression advisory and explicit', async () => {
    const p = tmpProject('visual-baseline');
    const baselinePath = path.join(p.compositionDir, 'qa', 'visual-baseline.json');
    const baseEvidence: FrameEvidence = {
      evidence_dir: path.join(p.compositionDir, 'preview'),
      contact_sheet: path.join(p.compositionDir, 'preview', 'contact-sheet.svg'),
      frame_paths: ['/tmp/first.png'],
      samples: [{
        label: 'first-frame',
        time_seconds: 0,
        frame_index: 0,
        path: '/tmp/first.png',
        hash: 'exact-a',
        perceptual_hash: '000000000000000000000000000000000000',
        brightness: 120,
        contrast: 42,
        width: 1920,
        height: 1080,
      }],
    };
    await writeVisualBaseline(baselinePath, baseEvidence);
    expect(await compareVisualBaseline(baselinePath, baseEvidence)).toMatchObject({ status: 'pass', changed: false });

    const changedEvidence: FrameEvidence = {
      ...baseEvidence,
      samples: [{
        ...baseEvidence.samples[0],
        hash: 'exact-b',
        perceptual_hash: 'ffffffffffffffffffffffffffffffffffff',
      }],
    };
    expect(await compareVisualBaseline(baselinePath, changedEvidence)).toMatchObject({
      ok: true,
      status: 'changed',
      changed: true,
      issues: expect.arrayContaining([expect.objectContaining({ code: 'VISUAL_BASELINE_CHANGED', severity: 'warning' })]),
    });
  });

  it('S3 summarizes design-review evidence without reopening the repair loop', () => {
    const summary = buildDesignReviewInputs({
      contractLoad: {
        path: '/tmp/design-contract.json',
        exists: true,
        value: { aesthetic: { signature_device: 'trace' }, scenes: [{ id: 's1', layout_type: 'diagram' }] },
      },
      sceneMapLoad: { path: '/tmp/scene-map.json', exists: false, value: null },
      contractHtml: {
        semantic_hooks: { coverage: 1 },
        issues: [{ code: 'ONE_NOTE_PALETTE', severity: 'warning', message: 'narrow hue range' }],
      },
      inspectDisposition: {
        advisory_issues: [{ code: 'LOW_CONTRAST', severity: 'warning', message: 'contrast' }],
      },
    });

    expect(summary).toMatchObject({
      advisory_count: 2,
      advisory_codes: expect.arrayContaining(['ONE_NOTE_PALETTE', 'LOW_CONTRAST']),
      review_focus: expect.arrayContaining(['contrast hierarchy', 'palette hierarchy']),
      scenes: expect.objectContaining({ count: 1, layout_sequence: ['diagram'] }),
    });
  });

  it('P1 bounds native-process output and settles timeout without waiting for close', async () => {
    const node = process.env.ORKAS_TEST_NODE || process.execPath;
    const noisy = await runVideoProcessForTest(node, [
      '-e',
      "process.stdout.write('x'.repeat(256)); setInterval(() => {}, 1000)",
    ], { timeoutMs: 10_000, maxOutputBytes: 32 });
    expect(noisy).toMatchObject({ code: -1, timedOut: false, aborted: false });
    expect(noisy.stderr).toContain('process output exceeded 32 bytes');

    const startedAt = Date.now();
    const timedOut = await runVideoProcessForTest(node, [
      '-e',
      'setInterval(() => {}, 1000)',
    ], { timeoutMs: 50 });
    expect(timedOut).toMatchObject({ code: -1, timedOut: true, aborted: false });
    expect(Date.now() - startedAt).toBeLessThan(5_000);
  });

  it.runIf(process.platform === 'win32')('P1 terminates a real Windows video subprocess tree', async () => {
    const p = tmpProject('video-process-tree');
    const sentinel = path.join(p.root, 'orphan-wrote.txt');
    const node = process.env.ORKAS_TEST_NODE || process.execPath;
    const grandchildScript = [
      "const fs = require('node:fs');",
      `setTimeout(() => fs.writeFileSync(${JSON.stringify(sentinel)}, 'orphaned'), 700);`,
      'setInterval(() => {}, 1000);',
    ].join('');
    const parentScript = [
      "const { spawn } = require('node:child_process');",
      `spawn(process.execPath, ['-e', ${JSON.stringify(grandchildScript)}], { stdio: 'ignore' });`,
      'setInterval(() => {}, 1000);',
    ].join('');

    await expect(runVideoProcessForTest(node, ['-e', parentScript], { timeoutMs: 75 }))
      .resolves.toMatchObject({ code: -1, timedOut: true });
    await new Promise((resolve) => setTimeout(resolve, 900));
    expect(fs.existsSync(sentinel)).toBe(false);
  });

  it('P1 streams raw BGRA frames into ffmpeg instead of compressing PNGs on the main thread', () => {
    const args = buildFrameEncoderArgs({
      outputAbsPath: '/tmp/out.mp4',
      width: 1920,
      height: 1080,
      fps: 30,
      format: 'mp4',
      quality: 'draft',
      audioTracks: [],
      durationSec: 10,
    });

    expect(args).toEqual(expect.arrayContaining([
      '-f', 'rawvideo', '-pixel_format', 'bgra', '-video_size', '1920x1080', '-i', 'pipe:0',
    ]));
    expect(args).not.toContain('png');
    expect(args.some((arg) => arg.includes('frame-%'))).toBe(false);
  });

  it('uses canonical file URLs for paths containing URL delimiters', () => {
    const file = path.join(os.tmpdir(), 'scene #1?final.html');
    expect(compositionFileUrlForTest(file)).toBe(pathToFileURL(file).toString());
  });

  it('S2 blocks shotlist/source alignment drift before rendering', async () => {
    const p = tmpProject('source-alignment');
    writeHtml(p.compositionDir, 'Launch');
    writeContract(p.compositionDir);
    writeSceneMap(p.compositionDir);
    fs.writeFileSync(path.join(p.root, 'project', 'shotlist.json'), JSON.stringify({
      shots: [
        { id: 's1', headline: 'Launch' },
        { id: 's2', headline: 'Second approved beat' },
      ],
    }, null, 2), 'utf8');

    const res = await draftComposition({
      compositionDirAbs: p.compositionDir,
      outputAbsPath: p.outputPath,
      reportAbsPath: p.reportPath,
    });

    expect(res).toMatchObject({
      ok: false,
      errorCode: 'E_PREFLIGHT_BLOCKED',
      preflight: expect.objectContaining({
        issues: expect.arrayContaining([expect.objectContaining({ code: 'SHOTLIST_SCENE_MAP_MISMATCH' })]),
      }),
    });
  });

  it('keeps a retired shotlist from coming back to life as a stray file', async () => {
    // 2026-08-07: a stale host message still told the model to "restore the
    // listed script, shotlist, or manifest", so it wrote a scratch
    // `{scenes:[...]}` file under that retired name. A layer that activates on
    // a FILENAME would then have judged the production against a contract
    // nobody signed. Legacy support keys on the artifact's shape — a real
    // shotlist has shots — so a stray file is simply inert.
    const sceneMap = {
      path: '/tmp/composition-manifest.json',
      exists: true,
      value: { scenes: [{ id: 's1', source_shots: ['s1'] }] },
    };
    const stray = await runSourceAlignmentQa(sceneMap, {
      path: '/tmp/shotlist.json',
      exists: true,
      value: { scenes: [{ id: 's01-hook', start: 0, duration: 6 }] },
    });
    expect(stray).toMatchObject({ ok: true, skipped: true, reason: 'no_legacy_shotlist' });

    // A plan signed while the file was still real keeps its checking.
    const legacy = await runSourceAlignmentQa(sceneMap, {
      path: '/tmp/shotlist.json',
      exists: true,
      value: { shots: [{ id: 's1' }, { id: 'orphan' }] },
    });
    expect(legacy.skipped).toBe(false);
  });

  it('S2 rejects a shotlist whose canonical scenes map zero approved shots', async () => {
    const result = await runSourceAlignmentQa({
      path: '/tmp/composition-manifest.json',
      exists: true,
      value: { scenes: [{ id: 's1', source_shots: [] }, { id: 's2', source_shots: [] }] },
    }, {
      path: '/tmp/shotlist.json',
      exists: true,
      value: { shots: [{ id: 's1' }, { id: 's2' }] },
    });
    expect(result).toMatchObject({
      ok: false,
      issues: expect.arrayContaining([expect.objectContaining({ code: 'SOURCE_SHOT_MAPPING_EMPTY' })]),
    });
  });

  it('S2 resolves uniquely owned source aliases to their approved semantic shot ids', async () => {
    const result = await runSourceAlignmentQa({
      path: '/tmp/composition-manifest.json',
      exists: true,
      value: {
        scenes: [
          { id: 'hook', source_shots: ['s01'] },
          { id: 'payoff', source_shots: ['s02'] },
        ],
      },
    }, {
      path: '/tmp/shotlist.json',
      exists: true,
      value: {
        shots: [
          { id: 'hook', source_shots: ['s01'] },
          { id: 'payoff', source_shots: ['s02'] },
        ],
        source_shots: [
          { id: 's01', provenance: 'self-authored HTML/CSS/SVG' },
          { id: 's02', provenance: 'self-authored HTML/CSS/SVG' },
        ],
      },
    });
    expect(result).toMatchObject({
      ok: true,
      mapped_source_ref_count: 2,
      mapped_source_shot_count: 2,
      resolved_source_alias_count: 2,
      resolved_source_aliases: {
        s01: 'hook',
        s02: 'payoff',
      },
      error_count: 0,
    });
  });

  it('S2 rejects source aliases that are unknown or owned by multiple approved shots', async () => {
    const shotlist = {
      path: '/tmp/shotlist.json',
      exists: true,
      value: {
        shots: [
          { id: 'hook', source_shots: ['shared'] },
          { id: 'payoff', source_shots: ['shared'] },
        ],
      },
    };
    const ambiguous = await runSourceAlignmentQa({
      path: '/tmp/composition-manifest.json',
      exists: true,
      value: { scenes: [{ id: 'hook', source_shots: ['shared'] }] },
    }, shotlist);
    expect(ambiguous).toMatchObject({
      ok: false,
      issues: expect.arrayContaining([
        expect.objectContaining({
          code: 'SOURCE_SHOT_REFERENCE_AMBIGUOUS',
          message: expect.stringContaining('shared -> hook|payoff'),
        }),
      ]),
    });

    const unknown = await runSourceAlignmentQa({
      path: '/tmp/composition-manifest.json',
      exists: true,
      value: { scenes: [{ id: 'hook', source_shots: ['missing-alias'] }] },
    }, shotlist);
    expect(unknown).toMatchObject({
      ok: false,
      issues: expect.arrayContaining([
        expect.objectContaining({
          code: 'SOURCE_SHOT_REFERENCE_UNKNOWN',
          message: expect.stringContaining('missing-alias'),
        }),
      ]),
    });
  });

  it('S1/S2 blocks declared composition narration that would render silent', async () => {
    const p = tmpProject('silent-narration');
    writeHtml(p.compositionDir, 'Launch');
    writeContract(p.compositionDir, {
      audio: { owner: 'composition', narration_path: './assets/narration.mp3', target_sec: 10 },
    });
    writeSceneMap(p.compositionDir);

    const res = await draftComposition({
      compositionDirAbs: p.compositionDir,
      outputAbsPath: p.outputPath,
      reportAbsPath: p.reportPath,
    });

    expect(res).toMatchObject({
      ok: false,
      errorCode: 'E_PREFLIGHT_BLOCKED',
      preflight: expect.objectContaining({
          issues: expect.arrayContaining([expect.objectContaining({ code: 'NARRATION_REQUIRED_BUT_NOT_MATERIALIZED' })]),
      }),
    });
    expect(fs.existsSync(p.outputPath)).toBe(false);
  });

  it('blocks pre-production narration intent before rendering instead of treating owner none as silence', async () => {
    const p = tmpProject('pending-narration');
    writeHtml(p.compositionDir, 'Launch');
    writeManifest(p.compositionDir, {
      scenes: [{
        id: 'cover',
        start: 0,
        duration: 10,
        approved_copy: ['Launch'],
        narration_refs: ['n1'],
        narration_text: 'Launch narration.',
        source_shots: [],
        roles: ['title', 'visual'],
      }],
      audio: { owner: 'none', tracks: [] },
    });
    fs.writeFileSync(path.join(p.compositionDir, '..', 'shotlist.json'), JSON.stringify({
      target_duration_seconds: 10,
      video_language: 'en',
      audio_mode: 'narration',
      caption_mode: 'none',
      music_mode: 'none',
      shots: [],
    }), 'utf8');

    const visualPreflight = await preflightComposition(
      { compositionDirAbs: p.compositionDir },
      'visual-preview',
    );
    expect(visualPreflight).toMatchObject({
      ok: true,
      report: {
        status: 'passed',
        profile: 'visual-preview',
        completeness: 'visual_only',
        blocking_error_count: 0,
        deferred_delivery_error_count: 1,
        next_allowed_ops: expect.arrayContaining([
          'composition.inspect',
          'composition.snapshot',
          'composition.materialize_narration',
        ]),
      },
      // The retired shotlist's `audio_mode requires a narration track` check
      // restated what NARRATION_REQUIRED_BUT_NOT_MATERIALIZED already says
      // from the manifest's own audio declaration (2026-08-07).
      issues: expect.arrayContaining([expect.objectContaining({
        code: 'NARRATION_REQUIRED_BUT_NOT_MATERIALIZED',
        severity: 'warning',
      })]),
    });
    const lint = await lintComposition({ compositionDirAbs: p.compositionDir });
    expect(lint).toMatchObject({
      ok: true,
      preview_completeness: 'visual_only',
      narration_pending: true,
      next_allowed_ops: expect.arrayContaining([
        'composition.inspect',
        'composition.snapshot',
        'composition.materialize_narration',
      ]),
    });
    expect(lint.next_allowed_ops).not.toContain('composition.draft');

    const res = await draftComposition({
      compositionDirAbs: p.compositionDir,
      outputAbsPath: p.outputPath,
      reportAbsPath: p.reportPath,
    });

    expect(res).toMatchObject({
      ok: false,
      errorCode: 'E_PREFLIGHT_BLOCKED',
      preflight: expect.objectContaining({
        completeness: 'visual_only',
        next_allowed_ops: expect.arrayContaining([
          'composition.materialize_narration',
          'composition.lint',
          'composition.inspect',
          'composition.snapshot',
        ]),
        issues: expect.arrayContaining([expect.objectContaining({
          code: 'NARRATION_REQUIRED_BUT_NOT_MATERIALIZED',
          severity: 'error',
        })]),
      }),
      next_allowed_ops: expect.arrayContaining([
        'composition.materialize_narration',
        'composition.lint',
        'composition.inspect',
        'composition.snapshot',
      ]),
    });
    expect(fs.existsSync(p.outputPath)).toBe(false);
  });

  it('keeps non-audio structural defects blocking in the visual-preview profile', async () => {
    const p = tmpProject('pending-narration-with-missing-copy');
    writeHtml(p.compositionDir, 'Wrong visible copy');
    writeManifest(p.compositionDir, {
      scenes: [{
        id: 'cover',
        start: 0,
        duration: 10,
        approved_copy: ['Launch'],
        narration_refs: ['n1'],
        narration_text: 'Launch narration.',
        source_shots: [],
        roles: ['title', 'visual'],
      }],
      audio: { owner: 'none', tracks: [] },
    });

    const visualPreflight = await preflightComposition(
      { compositionDirAbs: p.compositionDir },
      'visual-preview',
    );
    expect(visualPreflight).toMatchObject({
      ok: false,
      report: {
        status: 'failed',
        profile: 'visual-preview',
        blocking_error_count: 1,
        completeness: 'visual_only',
      },
      issues: expect.arrayContaining([
        expect.objectContaining({
          code: 'NARRATION_REQUIRED_BUT_NOT_MATERIALIZED',
          severity: 'warning',
        }),
        expect.objectContaining({
          code: 'HTML_MISSING_SCENE_COPY',
          severity: 'error',
        }),
      ]),
    });
    const lint = await lintComposition({ compositionDirAbs: p.compositionDir });
    expect(lint).toMatchObject({
      ok: false,
      errorCode: 'E_PREFLIGHT_BLOCKED',
      blocking_error_count: 1,
      next_allowed_ops: expect.arrayContaining([
        'composition.prepare',
        'composition.materialize_narration',
      ]),
    });
  });

  it('keeps explicitly silent compositions eligible for visual QA', async () => {
    const p = tmpProject('intentional-silence');
    writeHtml(p.compositionDir, 'Launch');
    writeManifest(p.compositionDir);

    const preflight = await preflightComposition({ compositionDirAbs: p.compositionDir });

    expect(preflight.ok).toBe(true);
    expect(preflight.steps.audio_timing).toMatchObject({
      ok: true,
      skipped: true,
      narration_required: false,
    });
  });

  it('S2 blocks narration-map timing drift before rendering', async () => {
    const p = tmpProject('narration-drift');
    fs.mkdirSync(path.join(p.compositionDir, 'assets'), { recursive: true });
    fs.writeFileSync(path.join(p.compositionDir, 'assets', 'narration.mp3'), 'fake narration');
    writeHtmlWithAudio(p.compositionDir, 'Line one');
    writeContract(p.compositionDir, {
      audio: { owner: 'composition', narration_path: './assets/narration.mp3', target_sec: 10 },
    });
    writeSceneMap(p.compositionDir, {
      audio: { narration: './assets/narration.mp3' },
      scenes: [
        { id: 'intro', start: 0, duration: 5, headline: 'Line one', narration: 'Line one.' },
        { id: 'cover', start: 5, duration: 5, headline: 'Line one', narration_ref: 'n1' },
      ],
    });
    fs.writeFileSync(path.join(p.compositionDir, 'narration-map.json'), JSON.stringify({
      lines: [{ id: 'n1', start: 0, duration: 2, text: 'Line one.' }],
    }, null, 2), 'utf8');

    const res = await draftComposition({
      compositionDirAbs: p.compositionDir,
      outputAbsPath: p.outputPath,
      reportAbsPath: p.reportPath,
    });

    expect(res).toMatchObject({
      ok: false,
      errorCode: 'E_PREFLIGHT_BLOCKED',
      preflight: expect.objectContaining({
        issues: expect.arrayContaining([expect.objectContaining({ code: 'NARRATION_LINE_START_DRIFT' })]),
      }),
    });
    expect(fs.existsSync(p.outputPath)).toBe(false);
  });

  it('S2 rejects an estimated narration map that leaves measured audio unmapped', async () => {
    const p = tmpProject('narration-measured-coverage-gap');
    fs.mkdirSync(path.join(p.compositionDir, 'assets'), { recursive: true });
    const narrationPath = path.join(p.compositionDir, 'assets', 'narration.mp3');
    fs.writeFileSync(narrationPath, 'fake narration');
    writeContract(p.compositionDir, {
      audio: { owner: 'composition', narration_path: './assets/narration.mp3', target_sec: 48 },
    });
    writeSceneMap(p.compositionDir, {
      audio: { narration: './assets/narration.mp3', narration_duration_seconds: 48 },
      scenes: [
        { id: 's01', start: 0, duration: 15, narration_text: '第一段', narration_ref: 'n01' },
        { id: 's02', start: 15, duration: 16, narration_text: '第二段', narration_ref: 'n02' },
        { id: 'payoff', start: 31, duration: 17, source_shots: ['payoff'] },
      ],
    });
    fs.writeFileSync(path.join(p.compositionDir, 'narration-map.json'), JSON.stringify({
      alignment_method: 'scene_estimate_scaled',
      narration_audio_start: 0,
      narration_audio_duration: 48,
      lines: [
        { id: 'n01', scene_id: 's01', start: 0, duration: 15, text: '第一段' },
        { id: 'n02', scene_id: 's02', start: 15, duration: 16, text: '第二段' },
      ],
    }), 'utf8');
    const meta: CompositionMeta = {
      htmlPath: path.join(p.compositionDir, 'index.html'),
      html: '',
      rootAttrs: {},
      id: 'main',
      width: 1920,
      height: 1080,
      durationSec: 48,
      audioTracks: [{ absPath: narrationPath, startSec: 0, declaredDurationSec: 48, volume: 1 }],
    };

    const audioTiming = await runAudioTimingQa(
      meta,
      await loadDesignContract(p.compositionDir),
      await loadSceneMap(p.compositionDir),
      await loadNarrationMap(p.compositionDir),
      p.compositionDir,
    );

    expect(audioTiming).toMatchObject({
      ok: false,
      alignment_method: 'scene_estimate_scaled',
      narration_audio_end: 48,
      issues: expect.arrayContaining([expect.objectContaining({
        code: 'NARRATION_MAP_AUDIO_COVERAGE_INCOMPLETE',
        severity: 'error',
      })]),
    });
  });

  it('S2 blocks ref-only narrated scenes when narration-map is missing', async () => {
    const p = tmpProject('missing-narration-map');
    fs.mkdirSync(path.join(p.compositionDir, 'assets'), { recursive: true });
    fs.writeFileSync(path.join(p.compositionDir, 'assets', 'narration.mp3'), 'fake narration');
    writeHtmlWithAudio(p.compositionDir, 'Line one Line two');
    writeContract(p.compositionDir, {
      audio: { owner: 'composition', narration_path: './assets/narration.mp3', target_sec: 10 },
    });
    writeSceneMap(p.compositionDir, {
      audio: { narration: './assets/narration.mp3', narration_duration_seconds: 10 },
      scenes: [
        { id: 's01', start: 0, duration: 5, headline: 'Line one', narration_ref: 'n01' },
        { id: 's02', start: 5, duration: 5, headline: 'Line two', narration_ref: 'n02' },
      ],
    });

    const res = await draftComposition({
      compositionDirAbs: p.compositionDir,
      outputAbsPath: p.outputPath,
      reportAbsPath: p.reportPath,
    });

    expect(res).toMatchObject({
      ok: false,
      errorCode: 'E_PREFLIGHT_BLOCKED',
      preflight: expect.objectContaining({
        issues: expect.arrayContaining([expect.objectContaining({ code: 'NARRATION_MAP_MISSING', severity: 'error' })]),
      }),
    });
    expect(fs.existsSync(p.outputPath)).toBe(false);
  });

  it('S2 accepts scene_id narration-map lines with end times for timed audio refs', async () => {
    const p = tmpProject('scene-id-narration-map');
    fs.mkdirSync(path.join(p.compositionDir, 'assets'), { recursive: true });
    const narrationPath = path.join(p.compositionDir, 'assets', 'narration.mp3');
    fs.writeFileSync(narrationPath, 'fake narration');
    writeContract(p.compositionDir, {
      audio: { owner: 'composition', narration_path: './assets/narration.mp3', target_sec: 8 },
    });
    writeSceneMap(p.compositionDir, {
      audio: { narration: './assets/narration.mp3', narration_duration_seconds: 8 },
      scenes: [
        { id: 's01', start: 0, end: 4, headline: 'Line one', narration_ref: 'assets/narration.mp3#t=0.00,4.00' },
        { id: 's02', start: 4, end: 8, headline: 'Line two', narration_ref: 'assets/narration.mp3#t=4.00,8.00' },
      ],
    });
    fs.writeFileSync(path.join(p.compositionDir, 'narration-map.json'), JSON.stringify({
      lines: [
        { scene_id: 's01', start: 0, end: 4, text: 'Line one.' },
        { scene_id: 's02', start: 4, end: 8, text: 'Line two.' },
      ],
    }, null, 2), 'utf8');

    const meta: CompositionMeta = {
      htmlPath: path.join(p.compositionDir, 'index.html'),
      html: '',
      rootAttrs: {},
      id: 'main',
      width: 1920,
      height: 1080,
      durationSec: 8,
      audioTracks: [{ absPath: narrationPath, startSec: 0, declaredDurationSec: 8, volume: 1 }],
    };
    const audioTiming = await runAudioTimingQa(
      meta,
      await loadDesignContract(p.compositionDir),
      await loadSceneMap(p.compositionDir),
      await loadNarrationMap(p.compositionDir),
      p.compositionDir,
    );

    expect(audioTiming).toMatchObject({
      ok: true,
      narration_line_count: 2,
      error_count: 0,
    });
  });

  it('S2 estimates inline narration_text timing against actual narration duration', async () => {
    const p = tmpProject('inline-narration-text-drift');
    fs.mkdirSync(path.join(p.compositionDir, 'assets'), { recursive: true });
    const narrationPath = path.join(p.compositionDir, 'assets', 'narration.mp3');
    fs.writeFileSync(narrationPath, 'fake narration');
    writeContract(p.compositionDir, {
      audio: { owner: 'composition', narration_path: './assets/narration.mp3', target_sec: 10 },
    });
    writeSceneMap(p.compositionDir, {
      audio: { narration: './assets/narration.mp3', narration_duration_seconds: 5 },
      scenes: [
        { id: 's01', start: 0, duration: 2, headline: 'Line one', narration_text: 'Line one.' },
        { id: 's02', start: 8, duration: 2, headline: 'Line two', narration_text: 'Line two.' },
      ],
    });

    const meta: CompositionMeta = {
      htmlPath: path.join(p.compositionDir, 'index.html'),
      html: '',
      rootAttrs: {},
      id: 'main',
      width: 1920,
      height: 1080,
      durationSec: 10,
      audioTracks: [{ absPath: narrationPath, startSec: 0, declaredDurationSec: 5, volume: 1 }],
    };
    const audioTiming = await runAudioTimingQa(
      meta,
      await loadDesignContract(p.compositionDir),
      await loadSceneMap(p.compositionDir),
      await loadNarrationMap(p.compositionDir),
      p.compositionDir,
    );

    expect(audioTiming).toMatchObject({
      ok: false,
      issues: expect.arrayContaining([expect.objectContaining({ code: 'AUDIO_TIMING_DRIFT' })]),
    });
  });

  it('S2 resolves the bundled whisper runtime without env-only setup', () => {
    const p = tmpProject('bundled-whisper-resolution');
    const runtimeRoot = path.join(p.root, 'runtime');
    const targetDir = path.join(runtimeRoot, 'whisper', `${process.platform}-${process.arch}`);
    const cli = path.join(targetDir, 'bin', process.platform === 'win32' ? 'whisper-cli.exe' : 'whisper-cli');
    const model = path.join(targetDir, 'models', 'ggml-base-q5_1.bin');
    fs.mkdirSync(path.dirname(cli), { recursive: true });
    fs.mkdirSync(path.dirname(model), { recursive: true });
    fs.writeFileSync(cli, 'test runtime');
    fs.writeFileSync(model, 'test model');

    process.env.ORKAS_RUNTIME_DIR = runtimeRoot;
    delete process.env.ORKAS_WHISPER_CPP;
    delete process.env.ORKAS_WHISPER_CLI;
    delete process.env.ORKAS_WHISPER_MODEL;

    expect(resolveSpeechTranscribeBackend()).toEqual({ cli, model, source: 'bundled' });
  });

  it.runIf(process.platform === 'win32' && process.env.ORKAS_REAL_WHISPER_TEST === '1')(
    'Windows real bundled whisper transcribes within the performance budget', async () => {
      const p = tmpProject('bundled-whisper');
      const input = path.join(p.root, 'raw.mp4');
      const transcript = path.join(p.root, 'project', 'transcript.json');
      const runtimeRoot = path.resolve(process.cwd(), 'resources', 'runtime');
      const ffmpeg = path.join(runtimeRoot, 'ffmpeg', 'win32-x64', 'ffmpeg.exe');
      const generated = spawnSync(ffmpeg, [
        '-hide_banner', '-loglevel', 'error', '-y',
        '-f', 'lavfi', '-i', 'anullsrc=r=16000:cl=mono:d=0.2', input,
      ], { encoding: 'utf8' });
      expect(generated.status, generated.stderr).toBe(0);

      process.env.ORKAS_BUNDLED_FFMPEG = ffmpeg;
      process.env.ORKAS_RUNTIME_DIR = runtimeRoot;
      delete process.env.ORKAS_WHISPER_CPP;
      delete process.env.ORKAS_WHISPER_CLI;
      delete process.env.ORKAS_WHISPER_MODEL;

      const startedAt = Date.now();
      const res = await transcribeSpeech({ inputAbsPath: input, transcriptAbsPath: transcript });
      const elapsedMs = Date.now() - startedAt;

      expect(res, JSON.stringify(res)).toMatchObject({
        ok: true,
        op: 'speech.transcribe',
        backend: 'orkas-native:whisper.cpp',
        backend_source: 'bundled',
      });
      expect(fs.existsSync(transcript)).toBe(true);
      expect(elapsedMs).toBeLessThan(60_000);
    }, 90_000,
  );

  it('classifies signed and unsigned Windows native-runtime failures without masking normal exits', () => {
    if (process.platform === 'win32') {
      expect(isWindowsNativeRuntimeIncompatible(-1073741795)).toBe(true);
      expect(isWindowsNativeRuntimeIncompatible(0xC000001D)).toBe(true);
      expect(isWindowsNativeRuntimeIncompatible(-1073741515)).toBe(true);
      expect(isWindowsNativeRuntimeIncompatible(0xC0000135)).toBe(true);
      expect(isWindowsNativeRuntimeIncompatible(-1073741701)).toBe(true);
      expect(isWindowsNativeRuntimeIncompatible(0xC000007B)).toBe(true);
    }
    expect(isWindowsNativeRuntimeIncompatible(1)).toBe(false);
    expect(isWindowsNativeRuntimeIncompatible(null)).toBe(false);
  });

  it('uses multilingual auto-detection and DTW word timestamps for the q5 model', () => {
    const args = buildSpeechTranscribeArgs(
      '/runtime/models/ggml-base-q5_1.bin',
      '/tmp/audio.wav',
      '/tmp/transcript',
      { timestamps: 'word' },
    );

    expect(args).toEqual(expect.arrayContaining(['-ojf', '-l', 'auto', '-dtw', 'base', '-np']));
    expect(args).not.toContain('-oj');
    expect(buildSpeechTranscribeArgs('ggml-base-q5_1.bin', 'audio.wav', 'out', {
      language: 'zh',
      timestamps: 'segment',
    })).toEqual(expect.arrayContaining(['-oj', '-l', 'zh']));
  });

  it('normalizes whisper.cpp full JSON into stable segment and word timestamps', () => {
    const normalized = normalizeWhisperTranscript({
      result: { language: 'zh' },
      transcription: [{
        offsets: { from: 0, to: 1200 },
        text: ' Hello world!',
        tokens: [
          { text: ' Hello', offsets: { from: 100, to: 500 } },
          { text: ' world', offsets: { from: 500, to: 1000 } },
          { text: '!', offsets: { from: 1000, to: 1100 } },
        ],
      }],
    }, 'word');

    expect(normalized).toMatchObject({
      schema_version: 1,
      backend: 'whisper.cpp',
      language: 'zh',
      timestamp_detail: 'word',
      text: 'Hello world!',
      segments: [{ text: 'Hello world!', startSec: 0, endSec: 1.2 }],
      words: [
        { text: 'Hello', startSec: 0.1, endSec: 0.5 },
        { text: 'world!', startSec: 0.5, endSec: 1.1 },
      ],
    });
  });

  it('redacts local paths from speech.transcribe subprocess failures', async () => {
    const p = tmpProject('transcribe-redaction');
    const input = path.join(p.root, 'private', 'raw.mp4');
    fs.mkdirSync(path.dirname(input), { recursive: true });
    fs.writeFileSync(input, 'fake media');

    const fakeFfmpeg = path.join(p.root, 'ffmpeg');
    writeExecutable(fakeFfmpeg, [
      '#!/usr/bin/env node',
      "console.error('failed to open /Users/test/private/raw.mp4');",
      'process.exit(1);',
      '',
    ].join('\n'));
    const runtimeRoot = path.join(p.root, 'runtime');
    const fakeWhisper = path.join(runtimeRoot, 'whisper', 'current', 'bin', 'whisper-cli');
    writeExecutable(fakeWhisper, ['#!/usr/bin/env node', 'process.exit(0);', ''].join('\n'));
    const model = path.join(runtimeRoot, 'whisper', 'current', 'models', 'ggml-base.bin');
    fs.mkdirSync(path.dirname(model), { recursive: true });
    fs.writeFileSync(model, 'model');

    process.env.ORKAS_BUNDLED_FFMPEG = fakeFfmpeg;
    process.env.ORKAS_RUNTIME_DIR = runtimeRoot;
    delete process.env.ORKAS_WHISPER_CPP;
    delete process.env.ORKAS_WHISPER_CLI;
    delete process.env.ORKAS_WHISPER_MODEL;

    const res = await transcribeSpeech({ inputAbsPath: input });

    expect(res).toMatchObject({
      ok: false,
      errorCode: 'E_TRANSCRIBE_AUDIO_EXTRACT_FAILED',
    });
    expect(String(res.message)).toContain('could not be decoded for transcription');
    expect(String(res.message)).not.toContain(process.platform === 'win32' ? p.root : '/Users/test');
  });

  it('S2 blocks incompatible local GSAP vendor files before rendering', async () => {
    const p = tmpProject('gsap-vendor-incompatible');
    fs.mkdirSync(path.join(p.compositionDir, 'assets', 'vendor'), { recursive: true });
    fs.writeFileSync(path.join(p.compositionDir, 'assets', 'vendor', 'gsap.min.js'), 'window.gsap = {};', 'utf8');
    writeHtml(p.compositionDir, 'Launch');
    fs.appendFileSync(path.join(p.compositionDir, 'index.html'), [
      '<script src="./assets/vendor/gsap.min.js"></script>',
      '<script>window.__timelines = {}; window.__timelines.main = gsap.timeline({ paused: true });</script>',
    ].join('\n'), 'utf8');
    writeContract(p.compositionDir);
    writeSceneMap(p.compositionDir);

    const res = await draftComposition({
      compositionDirAbs: p.compositionDir,
      outputAbsPath: p.outputPath,
      reportAbsPath: p.reportPath,
    });

    expect(res).toMatchObject({
      ok: false,
      errorCode: 'E_PREFLIGHT_BLOCKED',
      preflight: expect.objectContaining({
        issues: expect.arrayContaining([expect.objectContaining({ code: 'VENDOR_GSAP_INCOMPATIBLE' })]),
      }),
    });
    expect(fs.existsSync(p.outputPath)).toBe(false);
  });

  it('S1 selects the highest safe automatic final fps on constrained machines', () => {
    expect(selectSafeFinalRenderFps({
      width: 1920,
      height: 1080,
      durationSec: 60,
      requestedFps: 30,
    })).toBe(24);
    expect(selectSafeFinalRenderFps({
      width: 3840,
      height: 2160,
      durationSec: 60,
      requestedFps: 30,
    })).toBeNull();
  });

  it('S1 fails strict heavy high-quality renders fast on constrained machines', async () => {
    const p = tmpProject('heavy-render');
    writeHtml(p.compositionDir, 'Launch', { width: 1920, height: 1080, duration: 60 });
    const previous = process.env.ORKAS_MOCK_RAM_GB;
    process.env.ORKAS_MOCK_RAM_GB = '8';
    try {
      const res = await renderComposition({
        compositionDirAbs: p.compositionDir,
        outputAbsPath: p.outputPath,
        quality: 'high',
        allowFpsFallback: false,
      });
      expect(res).toMatchObject({
        ok: false,
        errorCode: 'E_RENDER_TOO_HEAVY',
        render_profile: expect.objectContaining({ constrained: true, decision: 'fail_fast' }),
      });
      expect(fs.existsSync(p.outputPath)).toBe(false);
    } finally {
      if (previous === undefined) delete process.env.ORKAS_MOCK_RAM_GB;
      else process.env.ORKAS_MOCK_RAM_GB = previous;
    }
  });

  it('S3 blocks semantic visual defects as well as structural inspect errors', () => {
    const findings = JSON.stringify({
      ok: false,
      errorCount: 2,
      warningCount: 1,
      issues: [
        { code: 'TEXT_OVERFLOW', severity: 'error', message: 'visual overflow' },
        { code: 'LOW_CONTRAST', severity: 'error', message: 'contrast' },
        { code: 'timeline_runtime_missing', severity: 'error', message: 'no runtime' },
        { code: 'FONT_TOO_SMALL', severity: 'warning', message: 'small text' },
      ],
    });

    expect(summarizeDraftInspectDisposition(findings)).toMatchObject({
      blocking_error_count: 3,
      fatal_error_count: 1,
      advisory_count: 1,
      blocking_issues: expect.arrayContaining([
        expect.objectContaining({ code: 'TEXT_OVERFLOW' }),
        expect.objectContaining({ code: 'LOW_CONTRAST' }),
        expect.objectContaining({ code: 'timeline_runtime_missing' }),
      ]),
      advisory_issues: expect.arrayContaining([
        expect.objectContaining({ code: 'FONT_TOO_SMALL' }),
      ]),
    });
  });

  it('blocks only high-confidence native visual findings with active-scene evidence', () => {
    expect(normalizeDraftInspectIssueSeverities([
      {
        code: 'TEXT_OVERFLOW', severity: 'warning', message: 'clipped', source: 'orkas-native-inspect',
        confidence: 'high', activeScene: true, evidence: { overflow_pixels: { x: 12, y: 0 } },
      },
      {
        code: 'LOW_CONTRAST', severity: 'warning', message: 'heuristic contrast', source: 'orkas-native-inspect',
        confidence: 'medium', activeScene: true, evidence: { contrast_ratio: 2.8 },
      },
      { code: 'PALETTE_LARGE', severity: 'warning', message: 'palette' },
    ])).toEqual([
      expect.objectContaining({ code: 'TEXT_OVERFLOW', severity: 'error', disposition: 'blocking' }),
      expect.objectContaining({ code: 'LOW_CONTRAST', severity: 'warning', disposition: 'advisory' }),
      expect.objectContaining({ code: 'PALETTE_LARGE', severity: 'warning', disposition: 'advisory' }),
    ]);
  });

  it('deduplicates identical native findings without merging distinct element paths', () => {
    const base = {
      code: 'SAFE_AREA_VIOLATION', severity: 'warning' as const, sceneId: 'scene-1',
      selector: '[data-scene-id="scene-1"] > p:nth-of-type(1)', sampleTimeSec: 5,
      message: '[5.00s] readable text sits near the safe area.',
    };
    expect(dedupeInspectIssues([
      base,
      { ...base },
      { ...base, selector: '[data-scene-id="scene-1"] > p:nth-of-type(2)' },
    ])).toHaveLength(2);
  });

  it('S1 atomically persists failed inspect findings and their next action', async () => {
    const p = tmpProject('inspect-findings');
    const findingsPath = path.join(p.compositionDir, 'qa', 'inspect.json');
    const result = await inspectComposition({
      compositionDirAbs: p.compositionDir,
      findingsAbsPath: findingsPath,
    });

    expect(result).toMatchObject({
      ok: false,
      errorCode: 'E_PREFLIGHT_BLOCKED',
      findings_path: findingsPath,
      next_allowed_ops: ['composition.prepare'],
    });
    expect(JSON.parse(fs.readFileSync(findingsPath, 'utf8'))).toMatchObject({
      errorCode: 'E_PREFLIGHT_BLOCKED',
      findings_path: findingsPath,
      next_allowed_ops: ['composition.prepare'],
    });
    expect(fs.readdirSync(path.dirname(findingsPath)).some((name) => name.endsWith('.tmp'))).toBe(false);
  });

  it('calls a blank capture a capture failure when the page says it had content', () => {
    // 2026-08-07: a delivered draft's frame 0 came back black (brightness 17.8,
    // contrast 0) while the SAME sample recorded visible_scene_ids ["hook"] and
    // a data-role="title" occupying 14% of the frame. Both facts are the
    // host's own measurements and they cannot both be true. QA blamed the HTML,
    // which the model then could not fix, and the run ended there.
    const flat = { brightness: 17.77, contrast: 0 };
    expect(captureContradictsDom(flat, {
      visible_text: '一个人做完所有事？不，你需要一支 AI 团队',
      visible_elements: [{ role: 'title', cover_hero: true, area_ratio: 0.1422 }],
    })).toBe(true);

    // A large element with no text is still content.
    expect(captureContradictsDom(flat, {
      visible_elements: [{ role: 'visual', area_ratio: 0.4 }],
    })).toBe(true);

    // Negative control 1: a genuinely empty frame has nothing in the DOM to
    // contradict, so it stays the composition's defect and reaches QA.
    expect(captureContradictsDom(flat, { visible_elements: [] })).toBe(false);
    expect(captureContradictsDom(flat, {})).toBe(false);

    // Negative control 2: a dark design is not a uniform field. Anything with
    // real pixel variation is a capture that worked, however dim.
    expect(captureContradictsDom({ brightness: 17.77, contrast: 6 }, {
      visible_text: 'Launch',
      visible_elements: [{ role: 'title', area_ratio: 0.2 }],
    })).toBe(false);

    // Negative control 3: a sliver below the area floor is rounding, not
    // content — without it every faint marker would trigger a re-shoot.
    expect(captureContradictsDom(flat, {
      visible_elements: [{ role: 'label', area_ratio: 0.003 }],
    })).toBe(false);
  });

  it('catches a capture that painted the background and dropped the headline', () => {
    // 2026-08-08, driving the real agent on gpt-5.5: a preview frame at 5s
    // measured contrast 9.03 — far past the blank threshold, because a gradient
    // background and a grid overlay supply plenty of variation — while the
    // 88px headline it declared visible was absent from the pixels. The same
    // composition rendered to video correctly, so the preview the user judges
    // was worse than the video they would have received. Whole-frame contrast
    // cannot see this; the element's own region can.
    const busyBackground = { brightness: 16.37, contrast: 9.03 };
    const headline = {
      role: 'title', text: 'Orkas 是你的 AI 员工团队',
      area_ratio: 0.14, width_ratio: 0.47, height_ratio: 0.16, left_ratio: 0.06, top_ratio: 0.13,
    };
    const uniformThere = () => 0.4;
    expect(captureContradictsDom(busyBackground, { visible_elements: [headline] }, uniformThere))
      .toBe(true);

    // Negative control 1: the same busy frame with the headline actually
    // painted. Its region varies, so the capture worked.
    expect(captureContradictsDom(busyBackground, { visible_elements: [headline] }, () => 41.2))
      .toBe(false);

    // Negative control 2: a decorative block legitimately renders as one flat
    // colour. Without text, a cover signal, or hero status it is not something
    // a viewer would miss, and re-shooting every panel would be endless.
    expect(captureContradictsDom(busyBackground, {
      visible_elements: [{ role: 'visual', area_ratio: 0.3, width_ratio: 0.5, height_ratio: 0.6, left_ratio: 0.4, top_ratio: 0.2 }],
    }, uniformThere)).toBe(false);

    // Negative control 3: an element the probe never located cannot be judged.
    expect(captureContradictsDom(busyBackground, {
      visible_elements: [{ role: 'title', text: 'Launch', area_ratio: 0.14 }],
    }, uniformThere)).toBe(false);

    // Negative control 4: without a region sampler the check keeps its old
    // whole-frame answer, so a caller that cannot sample never re-shoots.
    expect(captureContradictsDom(busyBackground, { visible_elements: [headline] })).toBe(false);
  });

  it('still probes the runtime when only the declarative art-direction contract blocks preflight', async () => {
    // 2026-08-07: an inspect blocked only by art-direction metadata returned
    // no layout evidence at all. The 13 advisory defects it would have
    // reported only surfaced the next cycle, after the metadata was fixed, so
    // they could not be repaired in the same pass. The blockers here are the
    // reference-list errors (no id/target_scene_ids, unreachable path); the
    // fidelity contract itself is advisory since it changes nothing that
    // renders, and it rides along as evidence that warnings travel too.
    const p = tmpProject('inspect-declarative-block');
    writeHtml(p.compositionDir, 'Launch');
    writeManifest(p.compositionDir, {
      art_direction: {
        ...completeArtDirection(),
        // A concrete reference declared with neither a usable media contract
        // nor a fidelity contract. Every resulting error is scoped inside
        // art_direction, so the page under review is still the real one.
        references: [{ kind: 'image', ref: './assets/ref.png', scene_id: 'cover' }],
        reference_fidelity: {},
      },
    });

    const result = await inspectComposition({ compositionDirAbs: p.compositionDir }) as Record<string, unknown>;
    // The verdict is deliberately unchanged — the contract still has to be
    // repaired first — but the probe ran, so its findings ride along.
    expect(result).toMatchObject({
      ok: false,
      errorCode: 'E_PREFLIGHT_BLOCKED',
      stage: 'runtime_probe',
      runtime_probe_ran: true,
      next_allowed_ops: ['composition.prepare'],
    });
    expect(String(result.findings)).toContain('REFERENCE_MEDIA_CONTRACT_INVALID');
    // The advisory contract finding rides along in the same result.
    expect(String(result.findings)).toContain('REFERENCE_FIDELITY_CONTRACT_INCOMPLETE');

    // Negative control: a blocker about what actually renders keeps the probe
    // closed, because probe output on the wrong page would mislead.
    const html = tmpProject('inspect-html-block');
    writeHtml(html.compositionDir, 'Launch');
    writeManifest(html.compositionDir, {
      composition: { id: 'main', width: 1920, height: 1080, duration: 10, fps: 30, language: 'en', caption_mode: 'burned_in' },
    });
    const htmlBlocked = await inspectComposition({ compositionDirAbs: html.compositionDir }) as Record<string, unknown>;
    expect(htmlBlocked).toMatchObject({
      ok: false,
      errorCode: 'E_PREFLIGHT_BLOCKED',
      stage: 'preflight',
      next_allowed_ops: ['composition.prepare'],
    });
    expect(htmlBlocked.runtime_probe_ran).toBeUndefined();
    // ...and it is closed by the selector rule, not because the page could
    // not be measured at all: the block is a real index.html finding.
    expect(String(htmlBlocked.findings)).toContain('DELIVERY_CAPTIONS_MISSING');
    expect(htmlBlocked.blocking_error_count).toBe(1);
  });

  it('S3 reports blank/frozen sampled frames with contact-sheet evidence fields', () => {
    const qa = summarizeVideoFrameQa({
      evidence_dir: '/tmp/evidence',
      contact_sheet: '/tmp/evidence/contact-sheet.svg',
      frame_paths: ['/tmp/evidence/01.png', '/tmp/evidence/02.png', '/tmp/evidence/03.png'],
      samples: [
        { label: 'first-frame', time_seconds: 0, frame_index: 0, path: '/tmp/evidence/01.png', hash: 'same', brightness: 0, contrast: 0, width: 1920, height: 1080 },
        { label: 'midpoint', time_seconds: 5, frame_index: 75, path: '/tmp/evidence/02.png', hash: 'same', brightness: 0, contrast: 0, width: 1920, height: 1080 },
        { label: 'payoff-frame', time_seconds: 10, frame_index: 150, path: '/tmp/evidence/03.png', hash: 'same', brightness: 0, contrast: 0, width: 1920, height: 1080 },
      ],
    }, 10);

    expect(qa).toMatchObject({
      ok: false,
      contact_sheet: '/tmp/evidence/contact-sheet.svg',
      frame_paths: expect.arrayContaining(['/tmp/evidence/01.png']),
      issues: expect.arrayContaining([
        expect.objectContaining({ code: 'EMPTY_HOOK_FRAME' }),
      ]),
    });
  });

  it('P1 normalizes loudness only for high exports or clearly off-target drafts', () => {
    const nearTarget = {
      ok: true,
      input_i: -15,
      input_tp: -1.2,
      input_lra: 6,
      target_i: -14,
      target_tp: -1,
      target_lra: 11,
    };
    const quietDraft = {
      ...nearTarget,
      input_i: -22,
    };

    expect(shouldNormalizeLoudness(nearTarget, 'draft')).toMatchObject({
      normalize: false,
      reason: 'within draft loudness tolerance',
    });
    expect(shouldNormalizeLoudness(nearTarget, 'high')).toMatchObject({
      normalize: true,
      reason: 'high quality export',
    });
    expect(shouldNormalizeLoudness(quietDraft, 'draft')).toMatchObject({
      normalize: true,
    });
  });
});

describe('P3c R0 video track reuse', () => {
  const BASE_KEY_INPUT = {
    visualSignature: 'a'.repeat(64),
    windows: [
      { id: 's1', start: 0, duration: 4 },
      { id: 's2', start: 4, duration: 6 },
    ],
    width: 1920,
    height: 1080,
    fps: 30,
    quality: 'standard' as const,
    format: 'mp4' as const,
  };

  it('changes the reuse key on every dimension that changes rendered frames', () => {
    const base = buildRenderReuseKey(BASE_KEY_INPUT);
    expect(buildRenderReuseKey({ ...BASE_KEY_INPUT, windows: BASE_KEY_INPUT.windows.map((w) => ({ ...w })) })).toBe(base);
    const variants = [
      buildRenderReuseKey({ ...BASE_KEY_INPUT, visualSignature: 'b'.repeat(64) }),
      buildRenderReuseKey({ ...BASE_KEY_INPUT, windows: [{ id: 's1', start: 0, duration: 4.5 }, { id: 's2', start: 4.5, duration: 5.5 }] }),
      buildRenderReuseKey({ ...BASE_KEY_INPUT, windows: [{ id: 's1', start: 0, duration: 4 }, { id: 's2', start: 5, duration: 6 }] }),
      buildRenderReuseKey({ ...BASE_KEY_INPUT, windows: [...BASE_KEY_INPUT.windows, { id: 's3', start: 10, duration: 2 }] }),
      buildRenderReuseKey({ ...BASE_KEY_INPUT, fps: 15 }),
      buildRenderReuseKey({ ...BASE_KEY_INPUT, width: 1280, height: 720 }),
      buildRenderReuseKey({ ...BASE_KEY_INPUT, quality: 'high' }),
      buildRenderReuseKey({ ...BASE_KEY_INPUT, format: 'webm' }),
    ];
    expect(new Set([base, ...variants]).size).toBe(variants.length + 1);
  });

  it('never folds undefined quality into a named tier (their encoder CRFs differ)', () => {
    expect(buildRenderReuseKey({ ...BASE_KEY_INPUT, quality: undefined }))
      .not.toBe(buildRenderReuseKey({ ...BASE_KEY_INPUT, quality: 'standard' }));
  });

  it('reuses only with provenance, identical prior video bytes, and evidence when required', () => {
    const entry = {
      key: 'k',
      visual_signature: 'a'.repeat(64),
      windows: [{ id: 's1', start: 0, duration: 4 }],
      width: 1920,
      height: 1080,
      fps: 30,
      quality: 'standard',
      format: 'mp4',
      video_path: '/tmp/prior.mp4',
      video_sha256: 'sha-prior',
      rendered_at: '2026-08-03T00:00:00.000Z',
    };
    expect(evaluateVideoTrackReuse({ entry: null, priorVideoSha256: 'sha-prior', evidenceRequired: false, priorSamplesPresent: false }))
      .toEqual({ reuse: false, reason: 'no_provenance' });
    expect(evaluateVideoTrackReuse({ entry, priorVideoSha256: null, evidenceRequired: false, priorSamplesPresent: false }))
      .toEqual({ reuse: false, reason: 'video_missing_or_changed' });
    expect(evaluateVideoTrackReuse({ entry, priorVideoSha256: 'sha-tampered', evidenceRequired: false, priorSamplesPresent: false }))
      .toEqual({ reuse: false, reason: 'video_missing_or_changed' });
    expect(evaluateVideoTrackReuse({ entry, priorVideoSha256: 'sha-prior', evidenceRequired: true, priorSamplesPresent: false }))
      .toEqual({ reuse: false, reason: 'evidence_missing' });
    expect(evaluateVideoTrackReuse({ entry, priorVideoSha256: 'sha-prior', evidenceRequired: true, priorSamplesPresent: true }))
      .toEqual({ reuse: true, reason: 'match' });
    expect(evaluateVideoTrackReuse({ entry, priorVideoSha256: 'sha-prior', evidenceRequired: false, priorSamplesPresent: false }))
      .toEqual({ reuse: true, reason: 'match' });
  });

  it('reads the canonical window vector and rejects malformed scene shapes', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-window-vector-'));
    const write = (value: unknown) => fs.writeFileSync(path.join(root, 'composition-manifest.json'), JSON.stringify(value), 'utf8');

    expect(await readCompositionWindowVector(root)).toBeNull();
    write({ scenes: [{ id: 'cover', start: 0, duration: 4 }, { id: 'body', start: 4, duration: 6 }] });
    expect(await readCompositionWindowVector(root)).toEqual([
      { id: 'cover', start: 0, duration: 4 },
      { id: 'body', start: 4, duration: 6 },
    ]);
    write({ scenes: [] });
    expect(await readCompositionWindowVector(root)).toBeNull();
    write({ scenes: [{ id: 1, start: 0, duration: 4 }] });
    expect(await readCompositionWindowVector(root)).toBeNull();
    write({ scenes: [{ id: 'cover', start: 0, duration: '4' }] });
    expect(await readCompositionWindowVector(root)).toBeNull();
    write({ scenes: [{ id: 'cover', start: Number.NaN, duration: 4 }] });
    expect(await readCompositionWindowVector(root)).toBeNull();
  });

  it('keeps the remux audio graph identical to the frame encoder and copies the video stream', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-remux-args-'));
    const narration = path.join(root, 'narration.mp3');
    const music = path.join(root, 'music.mp3');
    fs.writeFileSync(narration, 'x');
    fs.writeFileSync(music, 'x');
    const tracks = [
      { absPath: narration, startSec: 0, volume: 1 },
      { absPath: music, startSec: 2.5, volume: 0.6 },
    ];

    const encoderArgs = buildFrameEncoderArgs({
      outputAbsPath: path.join(root, 'full.mp4'),
      width: 1920,
      height: 1080,
      fps: 30,
      format: 'mp4',
      quality: 'standard',
      audioTracks: tracks,
      durationSec: 10,
    });
    const remuxArgs = buildVideoTrackRemuxArgs({
      priorVideoAbsPath: path.join(root, 'prior.mp4'),
      outputAbsPath: path.join(root, 'remux.mp4'),
      durationSec: 10,
      format: 'mp4',
      audioTracks: tracks,
    });

    const filterOf = (args: string[]) => args[args.indexOf('-filter_complex') + 1];
    expect(filterOf(remuxArgs)).toBe(filterOf(encoderArgs));
    expect(remuxArgs).toEqual(expect.arrayContaining(['-c:v', 'copy', '-c:a', 'aac', '-movflags', '+faststart']));
    expect(remuxArgs).not.toContain('-preset');
    expect(remuxArgs).not.toContain('libx264');

    const silent = buildVideoTrackRemuxArgs({
      priorVideoAbsPath: path.join(root, 'prior.mp4'),
      outputAbsPath: path.join(root, 'remux-silent.mp4'),
      durationSec: 10,
      audioTracks: [],
    });
    expect(silent).toEqual(expect.arrayContaining(['-map', '0:v:0', '-an', '-c:v', 'copy']));
    expect(silent).not.toContain('-filter_complex');

    const webm = buildVideoTrackRemuxArgs({
      priorVideoAbsPath: path.join(root, 'prior.webm'),
      outputAbsPath: path.join(root, 'remux.webm'),
      durationSec: 10,
      format: 'webm',
      audioTracks: tracks,
    });
    expect(webm).toEqual(expect.arrayContaining(['-c:a', 'libopus']));
    expect(webm).not.toContain('+faststart');
  });

  const ffmpegBins = bundledFfmpegPaths();
  it.skipIf(!ffmpegBins.ffmpeg || !ffmpegBins.ffprobe)(
    'renderComposition reuses an identical prior video track without opening a window, and only for the exact key',
    async () => {
      const p = tmpProject('r0-track-reuse');
      writeHtml(p.compositionDir, 'Reuse me', { width: 320, height: 180, duration: 2 });
      fs.writeFileSync(path.join(p.compositionDir, 'composition-manifest.json'), JSON.stringify({
        scenes: [{ id: 'cover', start: 0, duration: 2 }],
      }), 'utf8');
      fs.mkdirSync(p.renderDir, { recursive: true });
      const priorPath = path.join(p.renderDir, 'prior.mp4');
      const generate = await runVideoProcessForTest(ffmpegBins.ffmpeg!, [
        '-y', '-f', 'lavfi', '-i', 'color=c=red:s=320x180:d=2', '-r', '30',
        '-c:v', 'libx264', '-pix_fmt', 'yuv420p', priorPath,
      ], { timeoutMs: 60_000 });
      expect(generate.code).toBe(0);

      const visualSignature = 'c'.repeat(64);
      // Learn the fps the runtime resolves for this machine from a probe call,
      // so the handcrafted provenance keys exactly what a real render keyed.
      const probeRun = await renderComposition({
        compositionDirAbs: p.compositionDir,
        outputAbsPath: p.outputPath,
        fps: 30,
        visualSignature,
      });
      expect(probeRun.ok).toBe(false);
      const resolvedFps = Number((probeRun as { render_profile?: { render_fps?: number } }).render_profile?.render_fps);
      expect(Number.isFinite(resolvedFps)).toBe(true);

      const priorSha = crypto.createHash('sha256').update(fs.readFileSync(priorPath)).digest('hex');
      const qaDir = path.join(p.compositionDir, 'qa');
      fs.mkdirSync(qaDir, { recursive: true });
      fs.writeFileSync(path.join(qaDir, 'render-provenance.json'), JSON.stringify({
        version: 1,
        entries: [{
          key: buildRenderReuseKey({
            visualSignature,
            windows: [{ id: 'cover', start: 0, duration: 2 }],
            width: 320,
            height: 180,
            fps: resolvedFps,
            quality: undefined,
            format: undefined,
          }),
          visual_signature: visualSignature,
          windows: [{ id: 'cover', start: 0, duration: 2 }],
          width: 320,
          height: 180,
          fps: resolvedFps,
          quality: 'unset',
          format: 'mp4',
          video_path: priorPath,
          video_sha256: priorSha,
          rendered_at: '2026-08-03T00:00:00.000Z',
        }],
      }), 'utf8');

      const reused = await renderComposition({
        compositionDirAbs: p.compositionDir,
        outputAbsPath: p.outputPath,
        fps: 30,
        visualSignature,
      });
      expect(reused.ok, JSON.stringify(reused)).toBe(true);
      expect((reused as { reused_video_track?: boolean }).reused_video_track).toBe(true);
      expect((reused as { render_profile?: { frame_pipeline?: string } }).render_profile?.frame_pipeline).toBe('video_track_reuse');
      expect(fs.existsSync(p.outputPath)).toBe(true);
      const provenance = JSON.parse(fs.readFileSync(path.join(qaDir, 'render-provenance.json'), 'utf8')) as {
        entries: Array<{ video_path: string }>;
      };
      expect(provenance.entries[0].video_path).toBe(p.outputPath);

      // Negative control: a different visual identity must never hit the
      // reuse path; it falls through to the full render (which fails here
      // because unit tests cannot open a BrowserWindow).
      const missed = await renderComposition({
        compositionDirAbs: p.compositionDir,
        outputAbsPath: path.join(p.renderDir, 'missed.mp4'),
        fps: 30,
        visualSignature: 'd'.repeat(64),
      });
      expect(missed.ok).toBe(false);
      expect((missed as { reused_video_track?: boolean }).reused_video_track).toBeUndefined();
    },
  );
});

describe('retime survives without hand-editing the HTML', () => {
  // 2026-08-08: measured narration (51.24s) retimed every scene window, the
  // authored timeline still held the pre-measurement seconds, and the model
  // spent 11 minutes and 13 round trips transcribing 46 literals by hand
  // without finishing. Two scenes played one window off through all of it.
  const retimeManifest = () => CompositionManifestSchema.parse({
    schema_version: 1,
    composition: { id: 'main', width: 1920, height: 1080, duration: 60, fps: 30 },
    scenes: [
      { id: 'hook', start: 0, duration: 8, approved_copy: ['Hook'], narration_text: 'one' },
      { id: 'pain', start: 8, duration: 14, approved_copy: ['Pain'], narration_text: 'two' },
      { id: 'cta', start: 22, duration: 38, approved_copy: ['CTA'], narration_text: 'three' },
    ],
    audio: { owner: 'none', tracks: [] },
  });
  const scriptOf = (html: string): string => html.slice(html.indexOf('<script>', html.indexOf('</main>')));

  it('a shorter measured narration preserves scene attributes and timeline code', () => {
    const planned = retimeManifest();
    const scaffold = buildCompositionScaffold(planned);
    const measured = retimeCompositionManifestForNarration(planned, 51.24);
    const reconciled = reconcileCompositionHtml(scaffold, measured);

    expect(reconciled.ok).toBe(true);
    expect(reconciled.issues).toEqual([]);
    expect(reconciled.changed).toBe(true);
    // The narration fits inside the existing visual capacity, so the windows
    // stay byte-for-byte stable and the remaining time becomes a hold.
    expect(measured.scenes).toEqual(planned.scenes);
    expect(reconciled.html).toContain(`data-scene-id="pain" data-start="${measured.scenes[1].start}"`);
    expect(scriptOf(reconciled.html)).toBe(scriptOf(scaffold));
  });

  it('keeps the visual identity stable across a retime, so a rendered scene stays reusable', () => {
    const planned = retimeManifest();
    const scaffold = buildCompositionScaffold(planned);
    const reconciled = reconcileCompositionHtml(scaffold, retimeCompositionManifestForNarration(planned, 51.24));
    expect(normalizeCompositionHtmlForVisualIdentity(reconciled.html))
      .toBe(normalizeCompositionHtmlForVisualIdentity(scaffold));
  });

  it('the scaffold it hands the model contains no absolute timeline second', () => {
    const manifest = retimeManifest();
    expect(authoredAbsoluteTimelinePositions(buildCompositionScaffold(manifest), manifest.scenes)).toEqual([]);
  });

  it('reports an authored literal with the offset expression that replaces it', () => {
    const manifest = retimeManifest();
    const measured = retimeCompositionManifestForNarration(manifest, 51.24);
    const authored = buildCompositionScaffold(measured).replace(
      '// ORKAS-SCENE-MOTION-END:cta',
      'tl.fromTo("#cta-orca", { x: -180 }, { x: 120, duration: 4 }, 36);\n      // ORKAS-SCENE-MOTION-END:cta',
    );
    const [finding, ...rest] = authoredAbsoluteTimelinePositions(authored, measured.scenes);
    expect(rest).toEqual([]);
    expect(finding.seconds).toBe(36);
    expect(finding.scene_id).toBe('cta');
    // cta was measured to start at 22.208, so 36 is 13.792s into it.
    expect(finding.suggestion).toBe(`S("cta") + ${Math.round((36 - measured.scenes[2].start) * 1000) / 1000}`);
    expect(authored.split('\n')[finding.line - 1]).toContain('#cta-orca');
  });

  it('does not flag positions that already survive a retime', () => {
    const manifest = retimeManifest();
    const authored = buildCompositionScaffold(manifest).replace(
      '// ORKAS-SCENE-MOTION-END:pain',
      [
        'tl.from("#pain-title", { y: 40, duration: 0.6 }, S("pain") + 0.2);',    // the taught form
        'tl.to("#pain-bar", { x: 240, duration: D("pain") }, S("pain"));',       // scene-length motion
        'tl.set("#pain-mark", { autoAlpha: 1 }, 0);',                            // scene 0 starts at 0 always
        'tl.to("#pain-mark", { x: 10, duration: 4 });',                          // no position argument
        'tl.to("#pain-mark", { y: 10, duration: 0.5 }, "+=1");',                 // relative to the prior tween
        '      // ORKAS-SCENE-MOTION-END:pain',
      ].join('\n      '),
    );
    expect(authoredAbsoluteTimelinePositions(authored, manifest.scenes)).toEqual([]);
  });

  it('reads tl.call() position from its third argument, not the params array', () => {
    // GSAP v3: call(callback, params, position). Reading params as the
    // position flagged their values with a bogus S() replacement while the
    // real literal position escaped. (tl.call itself is separately blocked as
    // seek-unsafe; this detector must still not misattribute its arguments.)
    const manifest = retimeManifest();
    const authored = buildCompositionScaffold(manifest).replace(
      '// ORKAS-SCENE-MOTION-END:pain',
      'tl.call(function (n) { mark(n); }, [3], 9.8);\n      // ORKAS-SCENE-MOTION-END:pain',
    );
    const found = authoredAbsoluteTimelinePositions(authored, manifest.scenes);
    expect(found.map((entry) => entry.seconds)).toEqual([9.8]);
    const safe = buildCompositionScaffold(manifest).replace(
      '// ORKAS-SCENE-MOTION-END:pain',
      'tl.call(function (n) { mark(n); }, [3], S("pain") + 1.8);\n      // ORKAS-SCENE-MOTION-END:pain',
    );
    expect(authoredAbsoluteTimelinePositions(safe, manifest.scenes)).toEqual([]);
  });

  it('flags a literal hidden inside a position expression', () => {
    const manifest = retimeManifest();
    const authored = buildCompositionScaffold(manifest).replace(
      '// ORKAS-SCENE-MOTION-END:pain',
      'items.forEach(function (n, i) { tl.fromTo(n, { scale: 0 }, { scale: 1, duration: 0.5 }, 9.8 + i * 0.25); });\n      // ORKAS-SCENE-MOTION-END:pain',
    );
    const found = authoredAbsoluteTimelinePositions(authored, manifest.scenes);
    expect(found.map((entry) => entry.seconds)).toEqual([9.8]);
    expect(found[0].suggestion).toBe('S("pain") + 1.8');
  });

  it('reports a half-retimed legacy composition instead of returning it unchanged', () => {
    const planned = retimeManifest();
    const legacy = buildCompositionScaffold(planned).replace(
      '      // ORKAS-SCENE-MOTION-BEGIN:hook',
      [
        'tl.set("#scene-hook", { autoAlpha: 1 }, 0);',
        'tl.set("#scene-hook", { autoAlpha: 0 }, 8);',
        'tl.set("#scene-pain", { opacity: 1, visibility: "visible" }, 8);',
        '      // ORKAS-SCENE-MOTION-BEGIN:hook',
      ].join('\n      '),
    );
    const measured = retimeCompositionManifestForNarration(planned, 51.24);
    const reconciled = reconcileCompositionHtml(legacy, measured);

    expect(reconciled.html).toContain(`tl.set("#scene-hook", { autoAlpha: 0 }, ${measured.scenes[0].duration});`);
    const issue = reconciled.issues.find((entry) => entry.code === 'COMPOSITION_VISIBILITY_TIMING_UNRECONCILED');
    expect(issue?.severity).toBe('error');
    expect(issue?.message).toContain('pain, cta');
    expect(reconciled.ok).toBe(false);
  });

  it('stays quiet when a legacy composition retimes completely', () => {
    const planned = retimeManifest();
    const legacy = buildCompositionScaffold(planned).replace(
      '      // ORKAS-SCENE-MOTION-BEGIN:hook',
      [
        ...planned.scenes.flatMap((scene, index) => [
          `tl.set("#scene-${scene.id}", { autoAlpha: 1 }, ${scene.start});`,
          ...(index < planned.scenes.length - 1
            ? [`tl.set("#scene-${scene.id}", { autoAlpha: 0 }, ${scene.start + scene.duration});`]
            : []),
        ]),
        '      // ORKAS-SCENE-MOTION-BEGIN:hook',
      ].join('\n      '),
    );
    const reconciled = reconcileCompositionHtml(legacy, retimeCompositionManifestForNarration(planned, 51.24));
    expect(reconciled.issues).toEqual([]);
    expect(reconciled.ok).toBe(true);
  });
});

describe('P3c R1 scene attribution', () => {
  const attributionManifest = () => CompositionManifestSchema.parse({
    schema_version: 1,
    composition: { id: 'main', width: 1920, height: 1080, duration: 10, fps: 30 },
    scenes: [
      { id: 'cover', start: 0, duration: 4, approved_copy: ['Hello'] },
      { id: 'body', start: 4, duration: 6, approved_copy: ['World'] },
    ],
    audio: { owner: 'none', tracks: [] },
  });

  it('scaffold emits one motion region per scene and reconcile leaves them intact', () => {
    const manifest = attributionManifest();
    const scaffold = buildCompositionScaffold(manifest);
    for (const scene of manifest.scenes) {
      expect(scaffold).toContain(`// ORKAS-SCENE-MOTION-BEGIN:${scene.id}`);
      expect(scaffold).toContain(`// ORKAS-SCENE-MOTION-END:${scene.id}`);
    }
    const reconciled = reconcileCompositionHtml(scaffold, manifest);
    expect(reconciled.ok).toBe(true);
    for (const scene of manifest.scenes) {
      expect(reconciled.html).toContain(`// ORKAS-SCENE-MOTION-BEGIN:${scene.id}`);
      expect(reconciled.html).toContain(`// ORKAS-SCENE-MOTION-END:${scene.id}`);
    }
  });

  it('decomposes the scaffold into shared surface plus per-scene pairs', () => {
    const manifest = attributionManifest();
    const scaffold = buildCompositionScaffold(manifest);
    const decomposed = decomposeCompositionSceneAttribution(scaffold, manifest);
    expect(decomposed.attributable, decomposed.reasons.join('; ')).toBe(true);
    expect(Object.keys(decomposed.scene_subtrees).sort()).toEqual(['body', 'cover']);
    expect(decomposed.scene_subtrees.cover).toContain('Hello');
    expect(decomposed.shared_surface).not.toContain('Hello');
    expect(decomposed.shared_surface).toContain('<!--orkas-scene:cover-->');
    expect(decomposed.shared_surface).toContain('/*orkas-scene-motion:cover*/');
  });

  it('an edit inside one scene region changes only that scene pair', () => {
    const manifest = attributionManifest();
    const scaffold = buildCompositionScaffold(manifest);
    const edited = scaffold.replace(
      '// ORKAS-SCENE-MOTION-END:body',
      'tl.fromTo("#scene-body .scene-content", { autoAlpha: 0 }, { autoAlpha: 1, duration: 0.5 }, 4);\n      // ORKAS-SCENE-MOTION-END:body',
    );
    const before = decomposeCompositionSceneAttribution(scaffold, manifest);
    const after = decomposeCompositionSceneAttribution(edited, manifest);
    expect(after.attributable).toBe(true);
    expect(after.shared_surface).toBe(before.shared_surface);
    expect(after.scene_subtrees.cover).toBe(before.scene_subtrees.cover);
    expect(after.scene_motion_regions.cover).toBe(before.scene_motion_regions.cover);
    expect(after.scene_motion_regions.body).not.toBe(before.scene_motion_regions.body);
    expect(after.scene_motion_regions.body).toContain('fromTo');
  });

  it('rejects malformed attribution structure as non-attributable, never as an error', () => {
    const manifest = attributionManifest();
    const scaffold = buildCompositionScaffold(manifest);

    const missingEnd = decomposeCompositionSceneAttribution(
      scaffold.replace('// ORKAS-SCENE-MOTION-END:body', ''),
      manifest,
    );
    expect(missingEnd.attributable).toBe(false);
    expect(missingEnd.reasons.join(' ')).toContain('"body"');

    const duplicatedBegin = decomposeCompositionSceneAttribution(
      scaffold.replace('// ORKAS-SCENE-MOTION-BEGIN:cover', '// ORKAS-SCENE-MOTION-BEGIN:cover\n      // ORKAS-SCENE-MOTION-BEGIN:cover'),
      manifest,
    );
    expect(duplicatedBegin.attributable).toBe(false);

    const duplicatedSection = decomposeCompositionSceneAttribution(
      `${scaffold}\n<section data-scene-id="cover"></section>`,
      manifest,
    );
    expect(duplicatedSection.attributable).toBe(false);

    const missingSection = decomposeCompositionSceneAttribution(
      scaffold.replace('data-scene-id="body"', 'data-scene-id="body-renamed"'),
      manifest,
    );
    expect(missingSection.attributable).toBe(false);

    const outOfOrder = decomposeCompositionSceneAttribution(
      scaffold
        .replace('// ORKAS-SCENE-MOTION-BEGIN:cover', '// ORKAS-SCENE-MOTION-TMP')
        .replace('// ORKAS-SCENE-MOTION-END:cover', '// ORKAS-SCENE-MOTION-BEGIN:cover')
        .replace('// ORKAS-SCENE-MOTION-TMP', '// ORKAS-SCENE-MOTION-END:cover'),
      manifest,
    );
    expect(outOfOrder.attributable).toBe(false);
  });

  it('probe script walks the composition timeline against scene windows', () => {
    const manifest = attributionManifest();
    const script = buildSceneIsolationProbeScript(manifest);
    expect(script).toContain('"id":"cover"');
    expect(script).toContain('getChildren');
    expect(script).toContain('data-scene-id');
    expect(script).toContain('tween_spans_scene_windows');
    expect(script).toContain('target_in_other_scene');
    expect(script).toContain('no_composition_timeline');
  });

  it('summarizes isolation only when static attribution and the runtime probe both hold', () => {
    const manifest = attributionManifest();
    const scaffold = buildCompositionScaffold(manifest);
    const good = decomposeCompositionSceneAttribution(scaffold, manifest);
    const bad = decomposeCompositionSceneAttribution(scaffold.replace('// ORKAS-SCENE-MOTION-END:body', ''), manifest);

    expect(summarizeSceneIsolation({
      htmlSha256: 'h',
      decomposition: good,
      probe: { supported: true, isolation: true, violations: [] },
    })).toMatchObject({ attributable: true, runtime_supported: true, isolation: true });

    expect(summarizeSceneIsolation({
      htmlSha256: 'h',
      decomposition: bad,
      probe: { supported: true, isolation: true, violations: [] },
    })).toMatchObject({ attributable: false, isolation: false });

    expect(summarizeSceneIsolation({
      htmlSha256: 'h',
      decomposition: good,
      probe: null,
    })).toMatchObject({ runtime_supported: false, isolation: false });

    const capped = summarizeSceneIsolation({
      htmlSha256: 'h',
      decomposition: good,
      probe: {
        supported: true,
        isolation: false,
        violations: Array.from({ length: 25 }, (_v, i) => ({ reason: 'target_outside_scenes', index: i })),
      },
    });
    expect(capped.isolation).toBe(false);
    expect(capped.violations.length).toBe(20);
  });
});

describe('P3c R2 scene segment assembly', () => {
  const segmentManifest = () => CompositionManifestSchema.parse({
    schema_version: 1,
    composition: { id: 'main', width: 320, height: 180, duration: 2, fps: 30 },
    scenes: [
      { id: 'cover', start: 0, duration: 1, approved_copy: ['Hello'] },
      { id: 'body', start: 1, duration: 1, approved_copy: ['World'] },
    ],
    audio: { owner: 'none', tracks: [] },
  });

  it('partitions the global frame sequence at scene starts without gaps or overlaps', () => {
    const ranges = computeSceneFrameRanges([
      { id: 'cover', start: 0, duration: 1 },
      { id: 'body', start: 1, duration: 1 },
    ], 30, 60);
    expect(ranges).toEqual([
      { sceneId: 'cover', window: { start: 0, duration: 1 }, startFrame: 0, endFrame: 30 },
      { sceneId: 'body', window: { start: 1, duration: 1 }, startFrame: 30, endFrame: 60 },
    ]);

    const unaligned = computeSceneFrameRanges([
      { id: 'b', start: 1.51, duration: 1 },
      { id: 'a', start: 0, duration: 1.51 },
    ], 30, 76);
    expect(unaligned).toEqual([
      { sceneId: 'a', window: { start: 0, duration: 1.51 }, startFrame: 0, endFrame: 46 },
      { sceneId: 'b', window: { start: 1.51, duration: 1 }, startFrame: 46, endFrame: 76 },
    ]);

    expect(computeSceneFrameRanges([], 30, 60)).toBeNull();
    expect(computeSceneFrameRanges([{ id: 'a', start: 0, duration: 1 }], 0, 60)).toBeNull();
  });

  it('changes the segment key on every dimension the frames depend on', () => {
    const base = {
      sceneId: 'cover',
      window: { start: 0, duration: 1 },
      frameRange: [0, 30] as [number, number],
      subtreeSha256: 's'.repeat(64),
      motionRegionSha256: 'm'.repeat(64),
      sharedSurfaceSha256: 'g'.repeat(64),
      sceneAssetsSha256: 'a'.repeat(64),
      sharedAssetsSha256: 'h'.repeat(64),
      fps: 30,
      width: 320,
      height: 180,
      quality: 'standard' as string | undefined,
      format: 'mp4' as string | undefined,
    };
    const key = buildSceneSegmentKey(base);
    expect(buildSceneSegmentKey({ ...base })).toBe(key);
    const variants = [
      buildSceneSegmentKey({ ...base, subtreeSha256: 'x'.repeat(64) }),
      buildSceneSegmentKey({ ...base, motionRegionSha256: 'x'.repeat(64) }),
      buildSceneSegmentKey({ ...base, sharedSurfaceSha256: 'x'.repeat(64) }),
      buildSceneSegmentKey({ ...base, sceneAssetsSha256: 'x'.repeat(64) }),
      buildSceneSegmentKey({ ...base, sharedAssetsSha256: 'x'.repeat(64) }),
      buildSceneSegmentKey({ ...base, window: { start: 0.5, duration: 1 } }),
      buildSceneSegmentKey({ ...base, frameRange: [0, 31] as [number, number] }),
      buildSceneSegmentKey({ ...base, fps: 15 }),
      buildSceneSegmentKey({ ...base, quality: undefined }),
      buildSceneSegmentKey({ ...base, format: 'webm' }),
    ];
    expect(new Set([key, ...variants]).size).toBe(variants.length + 1);
  });

  it('attributes referenced asset changes to the owning visual surface', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-segment-assets-'));
    const assetsDir = path.join(root, 'assets');
    fs.mkdirSync(assetsDir, { recursive: true });
    fs.writeFileSync(path.join(assetsDir, 'cover.png'), 'cover-v1');
    fs.writeFileSync(path.join(assetsDir, 'shared.png'), 'shared-v1');
    fs.writeFileSync(path.join(assetsDir, 'narration.mp3'), 'audio-v1');
    fs.writeFileSync(path.join(assetsDir, 'shared.css'), '.stage{background:url("./shared.png")}');
    const coverSurface = '<section><img src="./assets/cover.png"><audio src="./assets/narration.mp3"></section>';
    const bodySurface = '<section><p>No local visual asset</p></section>';
    const sharedSurface = '<head><link rel="stylesheet" href="./assets/shared.css"></head>';

    try {
      const coverV1 = await videoStudioReferencedVisualAssetSignature(root, coverSurface);
      const bodyV1 = await videoStudioReferencedVisualAssetSignature(root, bodySurface);
      const sharedV1 = await videoStudioReferencedVisualAssetSignature(root, sharedSurface);

      // Same reference and path, different bytes: only the scene that owns the
      // image changes identity. This guards both stale reuse and global cache
      // invalidation without relying on implementation call counts.
      fs.writeFileSync(path.join(assetsDir, 'cover.png'), 'cover-v2');
      const coverV2 = await videoStudioReferencedVisualAssetSignature(root, coverSurface);
      expect(coverV2).not.toBe(coverV1);
      expect(await videoStudioReferencedVisualAssetSignature(root, bodySurface)).toBe(bodyV1);
      expect(await videoStudioReferencedVisualAssetSignature(root, sharedSurface)).toBe(sharedV1);

      // A resource reached through shared CSS belongs to the shared surface,
      // so it invalidates that dimension while scene-local dimensions stay put.
      fs.writeFileSync(path.join(assetsDir, 'shared.png'), 'shared-v2');
      expect(await videoStudioReferencedVisualAssetSignature(root, sharedSurface)).not.toBe(sharedV1);
      expect(await videoStudioReferencedVisualAssetSignature(root, coverSurface)).toBe(coverV2);

      // Audio is remuxed after visual segment assembly and must not dirty the
      // video-frame cache.
      fs.writeFileSync(path.join(assetsDir, 'narration.mp3'), 'audio-v2');
      expect(await videoStudioReferencedVisualAssetSignature(root, coverSurface)).toBe(coverV2);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('continues cache eviction when deleting the oldest entry fails', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-segment-cache-prune-'));
    const entries = ['oldest', 'middle', 'newest'].map((name, index) => {
      const dir = path.join(root, name);
      const file = path.join(dir, 'segment.mp4');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(file, '');
      fs.truncateSync(file, 1024 ** 3);
      const timestamp = new Date(1_700_000_000_000 + (index * 1_000));
      fs.utimesSync(file, timestamp, timestamp);
      return dir;
    });
    const removeEntry = async (target: string) => {
      if (path.resolve(target) === entries[0]) throw new Error('cache entry locked');
      await fs.promises.rm(target, { recursive: true, force: true });
    };

    try {
      await pruneSegmentCache(root, removeEntry);

      expect(fs.existsSync(entries[0])).toBe(true);
      expect(fs.existsSync(entries[1])).toBe(false);
      expect(fs.existsSync(entries[2])).toBe(true);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  const ffmpegBins2 = bundledFfmpegPaths();
  it.skipIf(!ffmpegBins2.ffmpeg || !ffmpegBins2.ffprobe)(
    'assembles fully cached segments without a window and re-renders only changed scenes',
    async () => {
      const manifest = segmentManifest();
      const p = tmpProject('r2-segment-assembly');
      const visualAssetPath = path.join(p.compositionDir, 'assets', 'product.png');
      fs.mkdirSync(path.dirname(visualAssetPath), { recursive: true });
      await sharp({
        create: { width: 320, height: 180, channels: 3, background: '#ff0000' },
      }).png().toFile(visualAssetPath);
      const html = buildCompositionScaffold(manifest).replace(
        '<div data-role="visual" aria-label="cover visual"></div>',
        '<img data-role="visual" src="./assets/product.png" alt="product" style="width:100%;height:100%;object-fit:cover">',
      );
      fs.writeFileSync(path.join(p.compositionDir, 'index.html'), html, 'utf8');
      fs.mkdirSync(path.join(p.compositionDir, 'assets', 'vendor'), { recursive: true });
      fs.writeFileSync(
        path.join(p.compositionDir, 'assets', 'vendor', 'gsap.min.js'),
        '/* stub with required timeline APIs: timeScale totalTime totalDuration getChildren */',
        'utf8',
      );
      fs.writeFileSync(path.join(p.compositionDir, 'composition-manifest.json'), JSON.stringify({
        schema_version: 1,
        composition: { id: 'main', width: 320, height: 180, duration: 2, fps: 30 },
        scenes: [
          { id: 'cover', start: 0, duration: 1, approved_copy: ['Hello'], narration_refs: [], source_shots: [], roles: [] },
          { id: 'body', start: 1, duration: 1, approved_copy: ['World'], narration_refs: [], source_shots: [], roles: [] },
        ],
        audio: { owner: 'none', tracks: [] },
      }), 'utf8');

      // Learn the fps the runtime resolves before handcrafting cache keys.
      const probeRun = await renderComposition({
        compositionDirAbs: p.compositionDir,
        outputAbsPath: p.outputPath,
        fps: 30,
      });
      expect(probeRun.ok).toBe(false);
      const resolvedFps = Number((probeRun as { render_profile?: { render_fps?: number } }).render_profile?.render_fps);
      expect(Number.isFinite(resolvedFps)).toBe(true);

      const qaDir = path.join(p.compositionDir, 'qa');
      fs.mkdirSync(qaDir, { recursive: true });
      fs.writeFileSync(path.join(qaDir, 'scene-isolation.json'), JSON.stringify({
        version: 1,
        html_sha256: crypto.createHash('sha256').update(html).digest('hex'),
        attributable: true,
        attribution_reasons: [],
        runtime_supported: true,
        isolation: true,
        violations: [],
        verified_at: '2026-08-03T00:00:00.000Z',
      }), 'utf8');

      const decomposed = decomposeCompositionSceneAttribution(html, manifest);
      expect(decomposed.attributable).toBe(true);
      const totalFrames = Math.max(1, Math.ceil(2 * resolvedFps));
      const ranges = computeSceneFrameRanges(
        manifest.scenes.map((scene) => ({ id: scene.id, start: scene.start, duration: scene.duration })),
        resolvedFps,
        totalFrames,
      );
      expect(ranges).not.toBeNull();

      const segmentKeyFor = async (
        decomposition: ReturnType<typeof decomposeCompositionSceneAttribution>,
        range: NonNullable<typeof ranges>[number],
      ) => {
        const subtree = decomposition.scene_subtrees[range.sceneId];
        const motionRegion = decomposition.scene_motion_regions[range.sceneId];
        return buildSceneSegmentKey({
          sceneId: range.sceneId,
          window: range.window,
          frameRange: [range.startFrame, range.endFrame],
          subtreeSha256: crypto.createHash('sha256').update(subtree).digest('hex'),
          motionRegionSha256: crypto.createHash('sha256').update(motionRegion).digest('hex'),
          sharedSurfaceSha256: crypto.createHash('sha256').update(decomposition.shared_surface).digest('hex'),
          sceneAssetsSha256: await videoStudioReferencedVisualAssetSignature(
            p.compositionDir,
            `${subtree}\n${motionRegion}`,
          ),
          sharedAssetsSha256: await videoStudioReferencedVisualAssetSignature(
            p.compositionDir,
            decomposition.shared_surface,
          ),
          fps: resolvedFps,
          width: 320,
          height: 180,
          quality: undefined,
          format: undefined,
        });
      };

      const cacheDir = path.join(p.root, 'segment-cache');
      const visualSignatureV1 = await videoStudioVisualCompositionSignature(p.compositionDir);
      const initialSegmentKeys = new Map<string, string>();
      for (const range of ranges!) {
        const key = await segmentKeyFor(decomposed, range);
        initialSegmentKeys.set(range.sceneId, key);
        const entryDir = path.join(cacheDir, key);
        fs.mkdirSync(entryDir, { recursive: true });
        const frames = range.endFrame - range.startFrame;
        const color = range.sceneId === 'cover' ? 'red' : 'blue';
        const generated = await runVideoProcessForTest(ffmpegBins2.ffmpeg!, [
          '-y', '-f', 'lavfi', '-i', `color=c=${color}:s=320x180:d=${(frames / resolvedFps).toFixed(3)}`,
          '-r', String(resolvedFps), '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
          path.join(entryDir, 'segment.mp4'),
        ], { timeoutMs: 60_000 });
        expect(generated.code).toBe(0);
        fs.writeFileSync(path.join(entryDir, 'meta.json'), JSON.stringify({
          version: 1,
          scene_id: range.sceneId,
          frame_range: [range.startFrame, range.endFrame],
          fps: resolvedFps,
          samples: [],
        }), 'utf8');
      }

      const assembled = await renderComposition({
        compositionDirAbs: p.compositionDir,
        outputAbsPath: p.outputPath,
        fps: 30,
        segmentCacheDirAbs: cacheDir,
        visualSignature: visualSignatureV1,
      });
      expect(assembled.ok, JSON.stringify(assembled)).toBe(true);
      expect((assembled as { render_profile?: { frame_pipeline?: string } }).render_profile?.frame_pipeline)
        .toBe('scene_segment_assembly');
      expect((assembled as { scene_segments?: { total: number; reused: number; rendered: number } }).scene_segments)
        .toEqual({ total: 2, reused: 2, rendered: 0 });
      expect(fs.existsSync(p.outputPath)).toBe(true);
      const probe = (assembled as { probe?: { duration_seconds?: number } }).probe;
      expect(Math.abs(Number(probe?.duration_seconds) - 2)).toBeLessThan(0.2);
      // Assembly also records R0 provenance so a later audio-only change can
      // reuse the assembled track wholesale.
      const provenance = JSON.parse(fs.readFileSync(path.join(qaDir, 'render-provenance.json'), 'utf8')) as {
        entries: Array<{ video_path: string }>;
      };
      expect(provenance.entries[0].video_path).toBe(p.outputPath);

      const renderedFrameDigest = async (videoPath: string, label: string) => {
        const framePath = path.join(p.renderDir, `${label}.png`);
        const extracted = await runVideoProcessForTest(ffmpegBins2.ffmpeg!, [
          '-y', '-ss', '0.5', '-i', videoPath, '-frames:v', '1', framePath,
        ], { timeoutMs: 60_000 });
        expect(extracted.code, extracted.stderr).toBe(0);
        const pixels = await sharp(framePath).removeAlpha().raw().toBuffer();
        return crypto.createHash('sha256').update(pixels).digest('hex');
      };
      const beforeAssetChange = await renderedFrameDigest(p.outputPath, 'asset-v1-frame');

      // The HTML and path stay identical while the referenced cover changes
      // visibly from red to blue. The implementation may re-render or fail
      // safely when no renderer is available; it must not successfully return
      // the same visible frame from the old cache.
      await sharp({
        create: { width: 320, height: 180, channels: 3, background: '#0000ff' },
      }).png().toFile(visualAssetPath);
      const visualSignatureV2 = await videoStudioVisualCompositionSignature(p.compositionDir);
      expect(visualSignatureV2).not.toBe(visualSignatureV1);
      const blueAssetKeys = new Map<string, string>();
      for (const range of ranges!) blueAssetKeys.set(range.sceneId, await segmentKeyFor(decomposed, range));
      expect(blueAssetKeys.get('cover')).not.toBe(initialSegmentKeys.get('cover'));
      expect(blueAssetKeys.get('body')).toBe(initialSegmentKeys.get('body'));
      const assetChanged = await renderComposition({
        compositionDirAbs: p.compositionDir,
        outputAbsPath: path.join(p.renderDir, 'asset-changed.mp4'),
        fps: 30,
        segmentCacheDirAbs: cacheDir,
        visualSignature: visualSignatureV2,
      });
      if (assetChanged.ok) {
        expect(await renderedFrameDigest(assetChanged.path, 'asset-v2-frame'))
          .not.toBe(beforeAssetChange);
      } else {
        expect((assetChanged as { scene_segments?: unknown }).scene_segments).toBeUndefined();
        expect(fs.existsSync(path.join(p.renderDir, 'asset-changed.mp4'))).toBe(false);
      }

      // Editing one scene's motion region dirties exactly that segment, which
      // demands a window in this environment — the path must fall back to the
      // full render rather than serving a stale cached segment.
      await sharp({
        create: { width: 320, height: 180, channels: 3, background: '#ff0000' },
      }).png().toFile(visualAssetPath);
      const editedHtml = html.replace(
        '// ORKAS-SCENE-MOTION-END:body',
        'tl.set("#scene-body .scene-content", { autoAlpha: 1 }, 1);\n      // ORKAS-SCENE-MOTION-END:body',
      );
      fs.writeFileSync(path.join(p.compositionDir, 'index.html'), editedHtml, 'utf8');
      fs.writeFileSync(path.join(qaDir, 'scene-isolation.json'), JSON.stringify({
        version: 1,
        html_sha256: crypto.createHash('sha256').update(editedHtml).digest('hex'),
        attributable: true,
        attribution_reasons: [],
        runtime_supported: true,
        isolation: true,
        violations: [],
        verified_at: '2026-08-03T00:00:00.000Z',
      }), 'utf8');
      const editedDecomposition = decomposeCompositionSceneAttribution(editedHtml, manifest);
      expect(editedDecomposition.attributable).toBe(true);
      const editedSegmentKeys = new Map<string, string>();
      for (const range of ranges!) editedSegmentKeys.set(
        range.sceneId,
        await segmentKeyFor(editedDecomposition, range),
      );
      expect(editedSegmentKeys.get('cover')).toBe(initialSegmentKeys.get('cover'));
      expect(editedSegmentKeys.get('body')).not.toBe(initialSegmentKeys.get('body'));
      const missed = await renderComposition({
        compositionDirAbs: p.compositionDir,
        outputAbsPath: path.join(p.renderDir, 'missed.mp4'),
        fps: 30,
        segmentCacheDirAbs: cacheDir,
        visualSignature: await videoStudioVisualCompositionSignature(p.compositionDir),
      });
      expect(missed.ok).toBe(false);
      expect((missed as { scene_segments?: unknown }).scene_segments).toBeUndefined();
    },
  );
});
