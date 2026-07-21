import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  buildSpeechTranscribeArgs,
  buildInspectScript,
  buildFrameEncoderArgs,
  compositionFileUrlForTest,
  draftComposition,
  inspectComposition,
  isCompositionRequestUrlAllowed,
  isWindowsNativeRuntimeIncompatible,
  lintComposition,
  preflightComposition,
  prepareComposition,
  previewArtifactPaths,
  previewEvidenceRunDir,
  normalizeWhisperTranscript,
  normalizeCapturedFrame,
  renderComposition,
  resolveSpeechTranscribeBackend,
  runVideoProcessForTest,
  selectSafeFinalRenderFps,
  shouldNormalizeLoudness,
  transcribeSpeech,
  withVideoStudioTimeout,
} from '../../../src/main/features/video_studio';
import {
  buildCompositionNarrationMap,
  CompositionManifestSchema,
  compositionNarrationText,
  ensureCompositionManifest,
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
import {
  buildDesignReviewInputs,
  buildInspectFrameSamplePlan,
  buildPreviewFrameSamplePlan,
  compareVisualBaseline,
  dedupeInspectIssues,
  isEnvironmentalDraftFailure,
  isSuspiciousCrossSceneDuplicate,
  loadDesignContract,
  loadNarrationMap,
  loadSceneMap,
  normalizeDraftInspectIssueSeverities,
  runContractHtmlQa,
  runAudioTimingQa,
  runSourceAlignmentQa,
  summarizeDraftInspectDisposition,
  summarizeVideoFrameQa,
  writeFrameContactSheet,
  writeVisualBaseline,
  type CompositionMeta,
  type FrameEvidence,
} from '../../../src/main/features/video_studio_qa';
import { extractCssImports, extractHtmlResourceRefs, parseHtmlStructure } from '../../../src/main/features/video_studio_html_check';
import {
  createVideoStudioTool,
  approveVideoStudioGate,
  recordVideoStudioGate,
  resultConsumesFullRenderTurnBudget,
  validateVideoStudioGate,
  videoStudioCompositionSignature,
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
    scenes: sceneIds.map((id) => ({
      id,
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
    expect(ops).toContain('composition.approve_preview');
    expect(ops).toContain('composition.approve_draft');
    expect(ops).toContain('composition.export');
    expect(ops).not.toContain('composition.render');
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
    expect(pendingOps).not.toContain('composition.snapshot');
    expect(pendingOps).not.toContain('composition.draft');
    expect(pendingOps).not.toContain('composition.begin_visual_revision');
    expect(nextVideoProductionOps(state)).toContain('composition.materialize_narration');
    state.stage = 'draft_approved';
    expect(isVideoProductionOpAllowed(state, 'composition.inspect', {
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

    const lineWeighted = retimeCompositionManifestForNarration(planned, 20, [1, 3]);
    expect(lineWeighted.scenes).toEqual([
      expect.objectContaining({ id: 'hook', start: 0, duration: 5 }),
      expect.objectContaining({ id: 'proof', start: 5, duration: 15 }),
    ]);
    expect(buildCompositionNarrationMap(lineWeighted, {
      textSha256: 'text-hash',
      audioSha256: 'audio-hash',
      method: 'scene_estimate_scaled',
    })).toMatchObject({
      alignment_method: 'scene_estimate_scaled',
      total_duration: 20,
      lines: [
        expect.objectContaining({ scene_id: 'hook', start: 0, duration: 5 }),
        expect.objectContaining({ scene_id: 'proof', start: 5, duration: 15 }),
      ],
    });
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

  it('enforces explicit preview and Gate D approvals and invalidates changed inputs', async () => {
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

    expect(await videoStudioPreviewRequired(p.compositionDir)).toBe(true);
    await expect(recordVideoStudioGate(gatePath, 'preview', p.compositionDir, 'turn-preview', {
      preview_ready: true,
      preview_qa: { ok: true, error_count: 0 },
      preflight: { status: 'passed', blocking_error_count: 0 },
      contact_sheet: path.join(p.compositionDir, 'preview', 'contact-sheet.svg'),
    })).resolves.toBe(true);
    await expect(validateVideoStudioGate(gatePath, 'preview', p.compositionDir, 'turn-preview')).resolves.toMatchObject({
      ok: false,
      errorCode: 'E_HTML_PREVIEW_APPROVAL_REQUIRED',
    });
    await expect(validateVideoStudioGate(gatePath, 'preview', p.compositionDir, 'turn-draft')).resolves.toMatchObject({
      ok: false,
      errorCode: 'E_HTML_PREVIEW_APPROVAL_REQUIRED',
    });
    await expect(approveVideoStudioGate(gatePath, 'preview', p.compositionDir, 'turn-preview', true)).resolves.toMatchObject({
      ok: false,
      errorCode: 'E_HTML_PREVIEW_APPROVAL_REQUIRED',
    });
    await expect(approveVideoStudioGate(gatePath, 'preview', p.compositionDir, 'turn-draft', false)).resolves.toMatchObject({
      ok: false,
      errorCode: 'E_HTML_PREVIEW_EXPLICIT_APPROVAL_REQUIRED',
    });
    await expect(approveVideoStudioGate(gatePath, 'preview', p.compositionDir, 'turn-draft', true)).resolves.toMatchObject({ ok: true });
    await expect(validateVideoStudioGate(gatePath, 'preview', p.compositionDir, 'turn-draft')).resolves.toMatchObject({ ok: true });
    fs.writeFileSync(path.join(p.compositionDir, 'draft-qa.json'), JSON.stringify({ attempt: 1 }), 'utf8');
    await expect(validateVideoStudioGate(gatePath, 'preview', p.compositionDir, 'turn-draft')).resolves.toMatchObject({ ok: true });
    fs.writeFileSync(path.join(p.compositionDir, 'draft-qa.json'), JSON.stringify({ attempt: 2 }), 'utf8');
    await expect(validateVideoStudioGate(gatePath, 'preview', p.compositionDir, 'turn-draft')).resolves.toMatchObject({ ok: true });

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

    await expect(validateVideoStudioGate(gatePath, 'preview', p.compositionDir, 'turn-draft'))
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

    await expect(validateVideoStudioGate(gatePath, 'preview', p.compositionDir, 'turn-draft'))
      .resolves.toMatchObject({ ok: false, errorCode: 'E_HTML_PREVIEW_STALE' });
    expect((await readVideoProductionState(gatePath, p.compositionDir)).preview?.validation_version).toBe(2);
  });

  it('migrates a legacy-tagged approval whose signature exactly matches current v3 inputs', async () => {
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

    await expect(validateVideoStudioGate(gatePath, 'preview', p.compositionDir, 'turn-draft'))
      .resolves.toMatchObject({ ok: true, entry: { status: 'approved', validation_version: 3 } });
    expect((await readVideoProductionState(gatePath, p.compositionDir)).preview).toMatchObject({
      signature,
      validation_version: 3,
    });
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
    await expect(approveVideoStudioGate(gatePath, 'preview', p.compositionDir, 'turn-approve', true)).resolves.toMatchObject({ ok: true });
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
    await expect(validateVideoStudioGate(gatePath, 'preview', p.compositionDir, 'turn-next')).resolves.toMatchObject({
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

  it('writes self-contained contact sheets that work as SVG images', async () => {
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

    const svg = fs.readFileSync(out, 'utf8');
    expect(out).toBe(path.join(evidenceDir, 'contact-sheet.svg'));
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
    expect(attempts[3]).toMatchObject({ ok: false, errorCode: 'E_REPAIR_BUDGET_EXCEEDED' });
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
    expect(blocked).toMatchObject({ ok: false, errorCode: 'E_REPAIR_BUDGET_EXCEEDED' });

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

    const res = await draftComposition({
      compositionDirAbs: p.compositionDir,
      outputAbsPath: p.outputPath,
      reportAbsPath: p.reportPath,
    });

    expect(res).toMatchObject({
      ok: false,
      errorCode: 'E_PREFLIGHT_BLOCKED',
      preflight: expect.objectContaining({
        issues: expect.arrayContaining([expect.objectContaining({
          code: 'NARRATION_REQUIRED_BUT_NOT_MATERIALIZED',
          severity: 'error',
        })]),
      }),
    });
    expect(fs.existsSync(p.outputPath)).toBe(false);
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
    expect(String(res.message)).toContain('<path>');
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
        expect.objectContaining({ code: 'FROZEN_FRAME_RUN' }),
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
