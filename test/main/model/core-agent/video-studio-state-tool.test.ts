import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const ttsMock = vi.hoisted(() => ({
  estimateNarrationDuration: vi.fn(),
  generateSpeech: vi.fn(),
}));

const mediaProbeMock = vi.hoisted(() => ({
  duration: vi.fn(),
}));

vi.mock('../../../../src/main/features/permissions', () => ({
  getLocalExecGranted: () => true,
}));

vi.mock('../../../../src/main/logger', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

vi.mock('../../../../src/main/util/media_probe', () => ({
  probeMediaDurationSec: mediaProbeMock.duration,
}));

vi.mock('../../../../src/main/features/tts', () => ({
  hasConfiguredTtsProvider: () => true,
  configuredTtsBackendId: () => 'mock-voice',
  estimateNarrationDuration: ttsMock.estimateNarrationDuration,
  assessEstimatedNarrationFit: (input: any) => {
    const scale = input.durationScale || 1;
    const estimatedSec = Math.round(input.estimate.estimatedSec * scale * 100) / 100;
    return {
      status: estimatedSec > input.targetSec + 0.15
        ? 'over'
        : estimatedSec < input.targetSec * 0.9 ? 'under' : 'fits',
      genericEstimatedSec: input.estimate.estimatedSec,
      estimatedSec,
      targetSec: input.targetSec,
      durationScale: scale,
      unit: input.estimate.unit,
      units: input.estimate.units,
      suggestedUnits: Math.max(1, Math.round(input.estimate.units * input.targetSec / estimatedSec)),
    };
  },
  narrationDurationCalibrationScale: (input: any) => Math.round(
    Math.min(2, Math.max(0.5, input.measuredSec / input.genericEstimatedSec)) * 10_000,
  ) / 10_000,
  generateSpeech: ttsMock.generateSpeech,
}));

vi.mock('../../../../src/main/features/tts_capabilities', () => {
  const voice = {
    voiceRef: 'provider:doubao:voice:test-vivi',
    displayName: 'Vivi',
    locale: 'zh-CN',
    nativeLocale: 'zh-CN',
    supportedLocales: ['zh-CN', 'en'],
    mixedLanguageSupport: true,
    languageConfidence: 'verified',
    styleTags: ['natural'],
    useCases: ['general'],
    isDefault: true,
    providerVoiceId: 'zh_female_vv_uranus_bigtts',
  };
  const route = {
    routeRef: 'provider:doubao',
    provider: 'doubao',
    model: 'doubao-seed-tts-2-0',
    displayName: 'Doubao',
    catalogStatus: 'complete',
    defaultVoiceRef: voice.voiceRef,
    voices: [voice],
    supports: { speed: true, formats: ['mp3'], languageContract: true },
  };
  return {
    listTtsCapabilities: async () => [route],
    publicTtsCapabilities: (routes: any[]) => routes.map((item) => ({
      ...item,
      voices: item.voices.map(({ providerVoiceId: _providerVoiceId, ...entry }: any) => entry),
    })),
    resolveTtsSelection: async (input: any = {}) => {
      if (input.routeRef && input.routeRef !== route.routeRef) {
        return { ok: false, errorCode: 'E_TTS_ROUTE_UNRESOLVED', message: 'missing route' };
      }
      if (input.voiceRef && input.voiceRef !== voice.voiceRef) {
        return { ok: false, errorCode: 'E_TTS_VOICE_UNRESOLVED', message: 'missing voice' };
      }
      if (input.legacyVoice && input.legacyVoice !== voice.providerVoiceId) {
        return { ok: false, errorCode: 'E_TTS_VOICE_UNRESOLVED', message: 'missing voice' };
      }
      const language = input.language || voice.nativeLocale;
      if (!voice.supportedLocales.some((item) => item.split('-')[0] === language.split('-')[0])) {
        return { ok: false, errorCode: 'E_TTS_LANGUAGE_UNSUPPORTED', message: 'unsupported language' };
      }
      return {
        ok: true,
        selection: {
          routeRef: route.routeRef,
          voiceRef: voice.voiceRef,
          providerVoiceId: voice.providerVoiceId,
          displayName: voice.displayName,
          provider: route.provider,
          model: route.model,
          catalogStatus: route.catalogStatus,
          language,
        },
      };
    },
  };
});

vi.mock('../../../../src/main/util/bundled-runtime', () => ({
  bundledFfmpegPaths: () => ({ ffmpeg: process.execPath, ffprobe: process.execPath }),
  bundledWhisperPaths: () => ({ cli: process.execPath, model: process.execPath }),
}));

vi.mock('electron', () => ({
  BrowserWindow: function BrowserWindow() {},
  session: {},
}));

const UID = 'u-video-state-tool';
const VIDEO_STUDIO_AGENT_ID = '79df9cc89f5f';
let root = '';
let workspace = '';
let compositionDir = '';
let previousWorkspaceRoot: string | undefined;

function writePlan(): void {
  const projectDir = path.join(workspace, 'project');
  compositionDir = path.join(projectDir, 'composition');
  fs.mkdirSync(compositionDir, { recursive: true });
  fs.writeFileSync(path.join(projectDir, 'script.md'), '# Approved script\n\nSpeak once.', 'utf8');
  fs.writeFileSync(path.join(projectDir, 'shotlist.json'), JSON.stringify({
    target_duration_seconds: 5,
    video_language: 'en',
    audio_mode: 'narration',
    caption_mode: 'none',
    music_mode: 'none',
    shots: [{ id: 'cover', narration: 'Speak once.' }],
  }), 'utf8');
  fs.writeFileSync(path.join(compositionDir, 'composition-manifest.json'), JSON.stringify({
    schema_version: 1,
    composition: { id: 'main', width: 1920, height: 1080, duration: 5, fps: 30, language: 'en' },
    scenes: [{
      id: 'cover',
      start: 0,
      duration: 5,
      approved_copy: ['Approved'],
      narration_text: 'Speak once.',
      narration_refs: [],
      source_shots: ['cover'],
      roles: ['title', 'visual'],
    }],
    audio: { owner: 'none', tracks: [] },
  }, null, 2), 'utf8');
  fs.writeFileSync(path.join(compositionDir, 'index.html'), [
    '<!doctype html><html><body>',
    '<main data-composition-id="main" data-width="1920" data-height="1080" data-duration="5">',
    '<section class="clip" data-scene-id="cover" data-start="0" data-duration="5">',
    '<h1 data-role="title">Approved</h1>',
    '</section>',
    '</main>',
    '</body></html>',
  ].join('\n'), 'utf8');
}

function completePreviewArtDirection(): Record<string, unknown> {
  return {
    aesthetic: {
      subject_world: 'editorial launch surface with measured signal marks',
      one_job: 'make the approved promise readable at video scale',
      signature_device: 'a measured signal path that anchors the frame',
      aesthetic_risk: 'avoid generic cards by using one strong visual axis',
      anti_template_check: 'reject centered cards and decorative blobs; use editorial scale and a measured signal path',
    },
    visual_direction: {
      visual_tradition: 'Swiss Pulse precision grid',
      lazy_defaults_rejected: 'replace centered cards and decorative blobs with editorial scale and a measured signal path',
      video_scale: {
        hero_title_min_px: 88,
        label_min_px: 28,
        safe_zone_px: { left: 120, right: 120, top: 90, bottom: 90 },
      },
      depth_layer_rule: 'quiet field, dominant title/signal layer, foreground measurement accents',
      motion_verb_rule: ['draw', 'align', 'resolve'],
      rhythm_pattern: 'quick hook, measured hold, clear payoff',
    },
    cover: {
      scene_id: 'cover',
      headline: 'Approved',
      content_signals: ['approved promise', 'measured signal path'],
      hero_visual: 'the approved promise locked to a measured signal path',
      composition_strategy: 'large approved promise plus a topic-specific hero in one readable thumbnail frame',
      frame_time_sec: 0,
    },
    scenes: [{
      id: 'cover',
      start: 0,
      duration: 5,
      scene_world: 'editorial signal field',
      hero_visual: 'large readable title anchored by a measured signal path',
      depth_layers: ['quiet field', 'title/signal layer', 'measurement accents'],
      motion_verbs: ['draw', 'resolve'],
    }],
    layout_boxes: { safe_margin: 96, visual_zone: 'full-field hero visual' },
    typography_tokens: { title: 'display >= 88px', body: 'supporting 32px', label: 'technical label >= 28px' },
    color_tokens: { bg: '#071018', ink: '#f3efe6', accent: '#f2a900' },
    motion_budget: { rule: 'resolved frame first, then purposeful entrance motion' },
    scene_variation: { rule: 'vary focal mass and framing when multiple scenes exist' },
  };
}

function makePlanVisualOnly(): void {
  const projectDir = path.join(workspace, 'project');
  fs.writeFileSync(path.join(projectDir, 'script.md'), '# Approved script\n\nVisual only.', 'utf8');

  const shotlistPath = path.join(projectDir, 'shotlist.json');
  const shotlist = JSON.parse(fs.readFileSync(shotlistPath, 'utf8'));
  shotlist.audio_mode = 'visual-only';
  shotlist.shots = shotlist.shots.map(({ narration: _narration, ...shot }: Record<string, unknown>) => shot);
  fs.writeFileSync(shotlistPath, JSON.stringify(shotlist), 'utf8');

  const manifestPath = path.join(compositionDir, 'composition-manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  manifest.scenes = manifest.scenes.map((scene: Record<string, unknown>) => {
    const { narration_text: _narrationText, ...visualScene } = scene;
    return visualScene;
  });
  manifest.audio = { owner: 'none', tracks: [] };
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');
}

function useSchema2Narration(displayName = 'Vivi'): void {
  const manifestPath = path.join(compositionDir, 'composition-manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  manifest.schema_version = 2;
  manifest.audio.narration_intent = {
    route_ref: 'provider:doubao',
    voice_ref: 'provider:doubao:voice:test-vivi',
    display_name: displayName,
    language: 'en',
    speed: 1,
  };
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');
}

function materializeNarrationFixture(): { textSha256: string; audioSha256: string; durationSec: number } {
  const durationSec = 4.8;
  const manifestPath = path.join(compositionDir, 'composition-manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const narrationText = manifest.scenes
    .map((scene: Record<string, unknown>) => String(scene.narration_text || '').trim())
    .filter(Boolean)
    .join('\n\n');
  const textSha256 = crypto.createHash('sha256').update(narrationText).digest('hex');
  const audio = Buffer.from('materialized narration fixture');
  const audioSha256 = crypto.createHash('sha256').update(audio).digest('hex');
  const assetsDir = path.join(compositionDir, 'assets');
  fs.mkdirSync(assetsDir, { recursive: true });
  fs.writeFileSync(path.join(assetsDir, 'narration.mp3'), audio);

  manifest.audio = {
    owner: 'composition',
    tracks: [{
      id: 'narration',
      kind: 'narration',
      src: 'assets/narration.mp3',
      start: 0,
      duration: durationSec,
      volume: 1,
    }],
  };
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');
  fs.writeFileSync(path.join(compositionDir, 'narration-map.json'), JSON.stringify({
    schema_version: 1,
    source: 'test-fixture',
    alignment_method: 'scene_estimate_scaled',
    narration_text_sha256: textSha256,
    narration_audio_sha256: audioSha256,
    total_duration: manifest.composition.duration,
    lines: manifest.scenes.flatMap((scene: Record<string, any>) => scene.narration_text
      ? [{
        id: `narration-${scene.id}`,
        scene_id: scene.id,
        start: scene.start,
        duration: scene.duration,
        text: scene.narration_text,
      }]
      : []),
  }, null, 2), 'utf8');

  const htmlPath = path.join(compositionDir, 'index.html');
  const html = fs.readFileSync(htmlPath, 'utf8').replace(
    '</main>',
    `  <audio id="audio-narration" src="./assets/narration.mp3" data-start="0" data-duration="${durationSec}" data-track-index="10" data-volume="1"></audio>\n</main>`,
  );
  fs.writeFileSync(htmlPath, html, 'utf8');
  return { textSha256, audioSha256, durationSec };
}

function markNarrationMapAsRuntimeReceipt(): void {
  const narrationMapPath = path.join(compositionDir, 'narration-map.json');
  const narrationMap = JSON.parse(fs.readFileSync(narrationMapPath, 'utf8'));
  narrationMap.source = 'composition.materialize_narration';
  fs.writeFileSync(narrationMapPath, JSON.stringify(narrationMap, null, 2), 'utf8');
}

function legacyCompositionPlanSignature(): string {
  const script = fs.readFileSync(path.join(workspace, 'project', 'script.md'));
  const shotlistRaw = fs.readFileSync(path.join(workspace, 'project', 'shotlist.json'));
  const shotlist = JSON.parse(shotlistRaw.toString('utf8'));
  const manifest = JSON.parse(fs.readFileSync(
    path.join(compositionDir, 'composition-manifest.json'),
    'utf8',
  ));
  const targetDuration = Number(shotlist.target_duration_seconds);
  const payload = JSON.stringify({
    schema_version: manifest.schema_version,
    composition: {
      id: manifest.composition.id,
      width: manifest.composition.width,
      height: manifest.composition.height,
      target_duration: manifest.composition.target_duration
        ?? (Number.isFinite(targetDuration) && targetDuration > 0
          ? targetDuration
          : manifest.composition.duration),
      language: manifest.composition.language || '',
    },
    scenes: manifest.scenes.map((scene: Record<string, unknown>) => ({
      id: scene.id,
      approved_copy: scene.approved_copy,
      narration_text: scene.narration_text || '',
      narration_refs: scene.narration_refs,
      source_shots: scene.source_shots,
      roles: scene.roles,
    })),
    audio: {
      narration_intent: manifest.audio.narration_intent || null,
    },
  });
  return crypto.createHash('sha256')
    .update(script)
    .update('\0')
    .update(shotlistRaw)
    .update('\0')
    .update(payload)
    .digest('hex');
}

function writeAutoParentPlan(): string {
  const planPath = path.join(workspace, 'project', 'plan.json');
  fs.writeFileSync(planPath, JSON.stringify({
    aspect: '16:9',
    total_target_sec: 5,
    language: 'en',
    delivery_promise: { type: 'compose_led', source_required: false, motion_min_ratio: 0 },
    segments: [{
      id: 'intro',
      order: 1,
      role: 'hook',
      layer: 'primary',
      source: 'compose',
      target_sec: 5,
      spec: {
        kind: 'title-card',
        composition_plan: {
          scenes: [{
            id: 'intro',
            approved_copy: ['Approved intro'],
            narration_text: '',
            roles: ['title', 'visual'],
          }],
        },
      },
    }],
    cost_estimate: { billable_generations: 0 },
  }, null, 2), 'utf8');
  return planPath;
}

function writeAutoChildComposition(): string {
  const child = path.join(workspace, 'project', 'compositions', 'intro');
  fs.mkdirSync(child, { recursive: true });
  fs.writeFileSync(path.join(child, 'script.md'), '# Approved intro', 'utf8');
  fs.writeFileSync(path.join(child, 'shotlist.json'), JSON.stringify({
    target_duration_seconds: 5,
    video_language: 'en',
    audio_mode: 'visual-only',
    caption_mode: 'none',
    music_mode: 'none',
    shots: [{ id: 'intro' }],
  }), 'utf8');
  fs.writeFileSync(path.join(child, 'composition-manifest.json'), JSON.stringify({
    schema_version: 1,
    composition: { id: 'intro', width: 1920, height: 1080, duration: 5, target_duration: 5, fps: 30, language: 'en' },
    scenes: [{
      id: 'intro',
      start: 0,
      duration: 5,
      approved_copy: ['Approved intro'],
      narration_text: '',
      narration_refs: [],
      source_shots: ['intro'],
      roles: ['title', 'visual'],
    }],
    audio: { owner: 'none', tracks: [] },
  }, null, 2), 'utf8');
  return child;
}

function parseResult(content: string): Record<string, any> {
  return JSON.parse(content.split('\n\n<file-renamed>')[0]);
}

const passingDesignScores = {
  content_alignment: 92,
  cover_communication: 90,
  hierarchy: 88,
  text_legibility: 94,
  motion_readiness: 86,
  specificity: 87,
};

function approvalSubmission(
  fieldId: string,
  value: unknown,
  agentId = VIDEO_STUDIO_AGENT_ID,
  extra: Record<string, unknown> = {},
): string {
  return [
    `<msg from="user" to="${VIDEO_STUDIO_AGENT_ID}">`,
    '@VideoStudio',
    '- Confirmed selection',
    '',
    `<agent-input-submission form_id="12345678" agent_id="${agentId}">`,
    JSON.stringify({ [fieldId]: value, ...extra }),
    '</agent-input-submission>',
    '</msg>',
  ].join('\n');
}

function decisionEvidence(
  gate: 'plan' | 'generation' | 'narration_retry' | 'preview' | 'draft',
  decision: 'approve' | 'revise' | 'reject',
  quote: string,
): Record<string, string> {
  return { source: 'user_message', gate, decision, quote };
}

function compositionInput(op: string, quote = '确认'): Record<string, unknown> {
  return {
    op,
    composition_dir: 'project/composition',
    ...(op === 'composition.approve_plan'
      ? { decision_evidence: decisionEvidence('plan', 'approve', quote) }
      : {}),
  };
}

beforeEach(async () => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-video-state-tool-')));
  workspace = path.join(root, 'workspace');
  fs.mkdirSync(workspace, { recursive: true });
  previousWorkspaceRoot = process.env.ORKAS_WORKSPACE_ROOT;
  process.env.ORKAS_WORKSPACE_ROOT = path.join(root, 'data');
  vi.resetModules();
  ttsMock.estimateNarrationDuration.mockReset();
  ttsMock.estimateNarrationDuration.mockImplementation((text: string) => ({
    estimatedSec: 5,
    unit: 'words',
    units: text.split(/\s+/).filter(Boolean).length,
    unitsPerSec: 1,
  }));
  ttsMock.generateSpeech.mockReset();
  mediaProbeMock.duration.mockReset();
  mediaProbeMock.duration.mockResolvedValue(4.8);
  const users = await import('../../../../src/main/features/users');
  users.activateUser(UID);
  const userWorkspace = await import('../../../../src/main/features/user_workspace');
  const configured = userWorkspace.setWorkspacePath(UID, workspace);
  if (!configured.ok) throw new Error(configured.error);
  writePlan();
});

afterEach(() => {
  if (previousWorkspaceRoot === undefined) delete process.env.ORKAS_WORKSPACE_ROOT;
  else process.env.ORKAS_WORKSPACE_ROOT = previousWorkspaceRoot;
  vi.restoreAllMocks();
  fs.rmSync(root, { recursive: true, force: true });
});

describe('VideoStudio production-state tool protocol', () => {
  it('decodes current-turn production forms without coupling approval to one field id', async () => {
    const mod = await import('../../../../src/main/model/core-agent/video-studio-tool');

    for (const fieldId of ['gate_b_decision', 'gate_b_reconfirm', 'gate_b_runtime_approval']) {
      expect(mod.explicitVideoStudioGateDecision(
        approvalSubmission(fieldId, 'approve'),
        'plan',
      )).toBe('approve');
    }
    expect(mod.explicitVideoStudioGateDecision(
      approvalSubmission('preview_decision', 'approve'),
      'preview',
    )).toBe('approve');
    const boundPreviewSignature = 'a'.repeat(64);
    expect(mod.resolveVideoStudioCurrentTurnDecision(
      approvalSubmission('preview_decision', `approve::${boundPreviewSignature}`),
      'preview',
      undefined,
    )).toMatchObject({
      decision: 'approve',
      source: 'form',
      artifact_signature: boundPreviewSignature,
    });
    expect(mod.explicitVideoStudioGateDecision(
      approvalSubmission('gate_d_decision', 'approve'),
      'draft',
    )).toBe('approve');
    expect(mod.explicitVideoStudioGateDecision(
      approvalSubmission('gate_c_decision', 'approve'),
      'generation',
    )).toBe('approve');
    expect(mod.explicitVideoStudioGateDecision(
      approvalSubmission('narration_retry_decision', 'approve'),
      'narration_retry',
    )).toBe('approve');
    expect(mod.explicitVideoStudioGateDecision(
      approvalSubmission('gate_c_decision', 'approve'),
      'narration_retry',
    )).toBe('unknown');
    expect(mod.explicitVideoStudioGateDecision(
      approvalSubmission('gate_b_decision', 'approve'),
      'generation',
    )).toBe('unknown');
    expect(mod.explicitVideoStudioGateDecision(
      '<msg from="user">确认</msg>',
      'generation',
    )).toBe('unknown');
    expect(mod.explicitVideoStudioGateDecision(
      '<msg from="user">确认付费生成这 2 个镜头</msg>',
      'generation',
    )).toBe('unknown');
    expect(mod.resolveVideoStudioCurrentTurnDecision(
      '<msg from="user">确认付费生成这 2 个镜头</msg>',
      'generation',
      decisionEvidence('generation', 'approve', '确认付费生成这 2 个镜头'),
    )).toMatchObject({
      decision: 'approve',
      source: 'model_interpreted_user_message',
    });
    expect(mod.explicitVideoStudioGateDecision(
      approvalSubmission('gate_b_decision', 'revise'),
      'plan',
    )).toBe('reject');
    expect(mod.explicitVideoStudioGateDecision(
      approvalSubmission('adjustments', 'approve'),
      'plan',
    )).toBe('unknown');
    expect(mod.explicitVideoStudioGateDecision(
      approvalSubmission('decision', 'approve'),
      'plan',
    )).toBe('unknown');
    expect(mod.explicitVideoStudioGateDecision(
      approvalSubmission('gate_b_decision', 'approve'),
      'draft',
    )).toBe('unknown');
    expect(mod.explicitVideoStudioGateDecision(
      approvalSubmission('gate_b_decision', 'approve', 'another-agent'),
      'plan',
    )).toBe('unknown');
    expect(mod.explicitVideoStudioGateDecision(
      '<msg from="user" to="79df9cc89f5f">@VideoStudio\n确认，继续制作。</msg>',
      'plan',
    )).toBe('unknown');
    expect(mod.resolveVideoStudioCurrentTurnDecision(
      '<msg from="user" to="79df9cc89f5f">@VideoStudio\n确认，继续制作。</msg>',
      'plan',
      decisionEvidence('plan', 'approve', '确认，继续制作。'),
    )).toMatchObject({
      decision: 'approve',
      source: 'model_interpreted_user_message',
    });
    expect(mod.resolveVideoStudioCurrentTurnDecision(
      '<msg from="user" to="79df9cc89f5f">@VideoStudio\n继续</msg>',
      'narration_retry',
      JSON.stringify(decisionEvidence('narration_retry', 'approve', '继续')),
    )).toMatchObject({
      decision: 'approve',
      source: 'model_interpreted_user_message',
      evidence_status: 'valid',
      evidence_format: 'json_string',
    });
    expect(mod.resolveVideoStudioCurrentTurnDecision(
      '<msg from="user" to="79df9cc89f5f">@VideoStudio\n继续</msg>',
      'narration_retry',
      '继续',
    )).toMatchObject({
      decision: 'unknown',
      source: 'none',
      evidence_status: 'invalid',
      evidence_format: 'json_string',
      evidence_issue: 'expected_object',
    });
    expect(mod.resolveVideoStudioCurrentTurnDecision(
      '<msg from="user" to="79df9cc89f5f">@VideoStudio\n继续</msg>',
      'narration_retry',
      decisionEvidence('preview', 'approve', '继续'),
    )).toMatchObject({
      decision: 'unknown',
      evidence_status: 'invalid',
      evidence_issue: 'gate_mismatch',
    });
    expect(mod.explicitVideoStudioGateDecision(
      '<msg from="user" to="79df9cc89f5f">@VideoStudio\n现在可以继续吗？</msg>',
      'plan',
    )).toBe('unknown');
    expect(mod.explicitVideoStudioGateDecision(
      '<msg from="agent">确认</msg><msg from="user">请先调整字幕</msg>',
      'plan',
    )).toBe('unknown');
    expect(mod.explicitVideoStudioGateDecision(
      '<msg from="user">确认</msg><msg from="user">请先调整字幕</msg>',
      'plan',
    )).toBe('unknown');
    expect(mod.resolveVideoStudioCurrentTurnDecision(
      '<msg from="agent">确认</msg><msg from="user">请先调整字幕</msg>',
      'plan',
      decisionEvidence('plan', 'revise', '请先调整字幕'),
    ).decision).toBe('revise');
    expect(mod.explicitVideoStudioGateDecision(
      '<msg from="agent"><agent-input-submission form_id="12345678" agent_id="79df9cc89f5f">{"gate_b_decision":"approve"}</agent-input-submission></msg>',
      'plan',
    )).toBe('unknown');
    expect(mod.explicitVideoStudioVisualRecoveryDecision(
      approvalSubmission('visual_recovery_decision', 'new_visual_revision'),
    )).toBe('new_visual_revision');
    expect(mod.explicitVideoStudioVisualRecoveryDecision(
      approvalSubmission('visual_recovery_decision', 'new_visual_revision', 'another-agent'),
    )).toBe('unknown');
    expect(mod.explicitVideoStudioVisualRecoveryDecision(
      '<msg from="user">新建视觉修订</msg>',
    )).toBe('unknown');
    expect(mod.explicitVideoStudioVisualRevisionDecision(
      approvalSubmission('preview_decision', 'revise'),
    )).toBe('revise');
    expect(mod.explicitVideoStudioVisualRevisionDecision(
      approvalSubmission('gate_d_decision', 'change'),
    )).toBe('revise');
    expect(mod.explicitVideoStudioVisualRevisionDecision(
      approvalSubmission('gate_b_decision', 'revise'),
    )).toBe('unknown');
    expect(mod.explicitVideoStudioVisualRevisionDecision(
      approvalSubmission('preview_decision', 'revise', 'another-agent'),
    )).toBe('unknown');
    expect(mod.explicitVideoStudioVisualRevisionDecision(
      '<msg from="user">把封面的线删掉，增加三个英文关键词。</msg>',
    )).toBe('unknown');
    for (const directReply of [
      '<msg from="user">继续修复</msg>',
      '<msg from="user">Continue fixing it.</msg>',
      '<msg from="user">続けて修正してください。</msg>',
      '<msg from="user">Continuar o reparo.</msg>',
    ]) {
      const quote = directReply.replace(/^.*?<msg from="user">|<\/msg>.*$/g, '');
      expect(mod.resolveVideoStudioCurrentTurnDecision(
        directReply,
        'preview',
        decisionEvidence('preview', 'revise', quote),
      )).toMatchObject({
        decision: 'revise',
        source: 'model_interpreted_user_message',
      });
    }
    for (const directApproval of [
      '这个画面可以，继续做草稿。',
      'The preview looks good. Continue to the draft.',
      'このプレビューで問題ありません。草稿に進んでください。',
      'A prévia está aprovada. Continue para o rascunho.',
    ]) {
      expect(mod.resolveVideoStudioCurrentTurnDecision(
        `<msg from="user">${directApproval}</msg>`,
        'preview',
        decisionEvidence('preview', 'approve', directApproval),
      )).toMatchObject({
        decision: 'approve',
        source: 'model_interpreted_user_message',
      });
    }
    expect(mod.resolveVideoStudioCurrentTurnDecision(
      '<msg from="user">确认当前预览</msg>',
      'preview',
      decisionEvidence('draft', 'approve', '确认当前预览'),
    ).decision).toBe('unknown');
    expect(mod.resolveVideoStudioCurrentTurnDecision(
      '<msg from="user">确认当前预览</msg>',
      'preview',
      decisionEvidence('preview', 'approve', '不存在的原文'),
    ).decision).toBe('unknown');
    expect(mod.explicitVideoStudioVisualRevisionDecision(
      '<msg from="user">先暂停。</msg>',
    )).toBe('unknown');
  });

  it('keeps non-billable edit and recovery operations available for every fact-level blocker', async () => {
    const stateMod = await import('../../../../src/main/features/video_studio_state');
    const initial = await stateMod.readVideoProductionState(
      path.join(root, 'missing-policy-state.json'),
      compositionDir,
    );
    const approved = {
      ...initial,
      plan_approval: {
        gate: 'B' as const,
        signature: 'approved-plan-signature',
        turn_id: 'turn-approved',
        approved_at: new Date().toISOString(),
        artifact_paths: [],
        validation_version: 2 as const,
      },
    };
    const alwaysAvailableRecoveryOps = [
      'composition.status',
      'composition.doctor',
      'composition.reconcile',
      'composition.check_narration_fit',
    ];
    const planProtectedOps = [
      'composition.prepare',
      'composition.materialize_narration',
      'composition.lint',
      'composition.inspect',
      'composition.begin_visual_revision',
      'composition.snapshot',
      'composition.approve_preview',
      'composition.submit_design_review',
      'composition.draft',
      'composition.approve_draft',
      'composition.export',
    ];
    const narrationProtectedOps = [
      'composition.draft',
      'composition.approve_draft',
      'composition.export',
    ];

    const missingApprovalFacts = {
      narrationRequired: true,
      narrationMaterialized: false,
    };
    for (const op of planProtectedOps) {
      expect(stateMod.evaluateVideoProductionOperation(initial, op, missingApprovalFacts))
        .toMatchObject({
          ok: false,
          errorCode: 'E_GATE_B_APPROVAL_REQUIRED',
          nextAction: 'composition.approve_plan',
        });
    }
    for (const op of alwaysAvailableRecoveryOps) {
      expect(stateMod.evaluateVideoProductionOperation(initial, op, missingApprovalFacts))
        .toEqual({ ok: true });
    }
    expect(stateMod.nextVideoProductionOps(initial, missingApprovalFacts)).toEqual(
      expect.arrayContaining([
        'composition.approve_plan',
        ...alwaysAvailableRecoveryOps,
      ]),
    );

    const missingNarrationFacts = {
      narrationRequired: true,
      narrationMaterialized: false,
    };
    for (const op of narrationProtectedOps) {
      expect(stateMod.evaluateVideoProductionOperation(approved, op, missingNarrationFacts))
        .toMatchObject({
          ok: false,
          errorCode: 'E_NARRATION_MATERIALIZATION_REQUIRED',
          nextAction: 'composition.materialize_narration',
        });
    }
    const editableIntermediateOps = [
      'composition.prepare',
      'composition.materialize_narration',
      'composition.lint',
      'composition.inspect',
      'composition.begin_visual_revision',
      'composition.snapshot',
      'composition.approve_preview',
      'composition.submit_design_review',
    ];
    for (const op of [...alwaysAvailableRecoveryOps, ...editableIntermediateOps]) {
      expect(stateMod.evaluateVideoProductionOperation(approved, op, missingNarrationFacts))
        .toEqual({ ok: true });
    }
    expect(stateMod.nextVideoProductionOps(approved, missingNarrationFacts)).toEqual(
      expect.arrayContaining([
        ...alwaysAvailableRecoveryOps,
        'composition.prepare',
        'composition.materialize_narration',
        'composition.lint',
        'composition.inspect',
        'composition.snapshot',
      ]),
    );

    const completeFacts = {
      narrationRequired: true,
      narrationMaterialized: true,
    };
    for (const op of narrationProtectedOps) {
      expect(stateMod.evaluateVideoProductionOperation(approved, op, completeFacts))
        .toEqual({ ok: true });
    }
  });

  it('derives recovery from current facts across every compatibility stage instead of deadlocking on stage', async () => {
    const stateMod = await import('../../../../src/main/features/video_studio_state');
    const base = await stateMod.readVideoProductionState(
      path.join(root, 'stage-invariant-state.json'),
      compositionDir,
    );
    const stages = [
      'initialized',
      'manifest_ready',
      'scaffold_ready',
      'narration_ready',
      'visuals_ready',
      'preview_ready',
      'preview_approved',
      'draft_ready',
      'draft_approved',
      'exported',
    ] as const;
    const recoveryOps = [
      'composition.status',
      'composition.doctor',
      'composition.reconcile',
      'composition.check_narration_fit',
    ];
    const approved = {
      gate: 'B' as const,
      signature: 'approved-plan-signature',
      turn_id: 'turn-approved',
      approved_at: new Date().toISOString(),
      artifact_paths: [],
      validation_version: 2 as const,
    };
    const faultProfiles = [
      {
        name: 'missing plan approval',
        state: base,
        facts: { narrationRequired: true, narrationMaterialized: false },
        expected: ['composition.approve_plan', ...recoveryOps],
      },
      {
        name: 'missing narration with stale completion facts',
        state: {
          ...base,
          plan_approval: approved,
          draft: {
            gate: 'D' as const,
            status: 'approved' as const,
            signature: 'stale-draft',
            turn_id: 'turn-stale-draft',
            created_at: new Date().toISOString(),
            validation_version: 5 as const,
          },
        },
        facts: { narrationRequired: true, narrationMaterialized: false },
        expected: [
          ...recoveryOps,
          'composition.materialize_narration',
          'composition.lint',
          'composition.inspect',
          'composition.snapshot',
        ],
      },
      {
        name: 'orphaned operation and exhausted visual QA',
        state: {
          ...base,
          plan_approval: approved,
          active_operation: {
            operation_id: 'orphaned-operation',
            op: 'composition.snapshot',
            stage: 'preview_ready' as const,
            revision: 7,
            started_at: new Date(0).toISOString(),
          },
          visual_qa: {
            cycle: {
              inspector_version: 3,
              cycle_id: 'exhausted-cycle',
              visual_revision: 1,
              status: 'exhausted' as const,
              max_repair_passes: 2,
              failed_signatures: ['first', 'repair-1', 'repair-2'],
              passed_signatures: {},
              started_at: new Date(0).toISOString(),
              updated_at: new Date(0).toISOString(),
            },
          },
        },
        facts: { narrationRequired: false, narrationMaterialized: true },
        expected: [
          ...recoveryOps,
          'composition.begin_visual_revision',
          'composition.lint',
          'composition.inspect',
        ],
      },
    ];

    for (const profile of faultProfiles) {
      const baseline = stateMod.nextVideoProductionOps(
        profile.state as any,
        profile.facts,
      );
      expect(baseline, profile.name).toEqual(expect.arrayContaining(profile.expected));
      expect(baseline.length, profile.name).toBeGreaterThan(0);
      for (const stage of stages) {
        const mutated = { ...profile.state, stage };
        const next = stateMod.nextVideoProductionOps(mutated as any, profile.facts);
        expect(next, `${profile.name} at ${stage}`).toEqual(baseline);
        for (const op of recoveryOps) {
          expect(
            stateMod.evaluateVideoProductionOperation(mutated as any, op, profile.facts),
            `${profile.name} must retain ${op} at ${stage}`,
          ).toEqual({ ok: true });
        }
      }
    }
  });

  it('exposes non-secret runtime speech capabilities without requiring a composition path', async () => {
    const toolMod = await import('../../../../src/main/model/core-agent/video-studio-tool');
    const tool = toolMod.createVideoStudioTool({ userId: UID, agentId: VIDEO_STUDIO_AGENT_ID });
    const result = await tool.execute({ op: 'speech.capabilities' }, { state: {} } as any);
    expect(result.isError).toBe(false);
    const payload = parseResult(result.content);
    expect(payload).toMatchObject({
      ok: true,
      routes: [{
        route_ref: 'provider:doubao',
        default_voice_ref: 'provider:doubao:voice:test-vivi',
        voices: [{
          voice_ref: 'provider:doubao:voice:test-vivi',
          display_name: 'Vivi',
          native_locale: 'zh-CN',
          supported_locales: ['zh-CN', 'en'],
          language_confidence: 'verified',
        }],
      }],
    });
    expect(result.content).not.toContain('zh_female_vv_uranus_bigtts');
  });

  it('binds schema v2 narration selection to Gate B and rejects an unresolved voice before synthesis', async () => {
    const manifestPath = path.join(compositionDir, 'composition-manifest.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    manifest.schema_version = 2;
    manifest.audio.narration_intent = {
      route_ref: 'provider:doubao',
      voice_ref: 'provider:doubao:voice:invented',
      display_name: 'Invented',
      language: 'zh-CN',
      speed: 1,
    };
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

    const toolMod = await import('../../../../src/main/model/core-agent/video-studio-tool');
    const tool = toolMod.createVideoStudioTool({
      userId: UID,
      turnId: 'turn-v2-selection',
      agentId: VIDEO_STUDIO_AGENT_ID,
      userMessage: '确认',
    });
    const result = await tool.execute({
      op: 'composition.check_narration_fit',
      composition_dir: 'project/composition',
    }, { workingDir: workspace, state: {} } as any);
    expect(result.isError).toBe(true);
    expect(result.content).toContain('E_TTS_VOICE_UNRESOLVED');
    expect(ttsMock.generateSpeech).not.toHaveBeenCalled();
  });

  it('recovers a legacy conversation-scoped ledger from a different resumed conversation', async () => {
    const toolMod = await import('../../../../src/main/model/core-agent/video-studio-tool');
    const paths = await import('../../../../src/main/paths');
    const legacyCid = 'cid-before-resume';
    const legacyKey = crypto.createHash('sha256').update([
      UID,
      '',
      legacyCid,
      path.resolve(compositionDir),
    ].join('\0')).digest('hex').slice(0, 32);
    const gateDir = path.join(paths.userLocalRoot(UID), 'video_studio', 'gates');
    fs.mkdirSync(gateDir, { recursive: true });
    fs.writeFileSync(path.join(gateDir, `${legacyKey}.json`), JSON.stringify({
      schema_version: 1,
      revision: 4,
      composition_dir: compositionDir,
      stage: 'scaffold_ready',
      artifacts: {},
      history: [],
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }), 'utf8');

    const resumedOpts = {
      userId: UID,
      cid: 'cid-after-resume',
      turnId: 'turn-after-resume',
      agentId: VIDEO_STUDIO_AGENT_ID,
      agentName: 'VideoStudio',
      userMessage: '继续',
    };
    const result = await toolMod.createVideoStudioTool(resumedOpts).execute({
      op: 'composition.status',
      composition_dir: 'project/composition',
    }, { workingDir: workspace, state: {} } as any);
    expect(result.isError).toBe(false);
    expect(parseResult(result.content).production_state.stage).toBe('scaffold_ready');
    expect(fs.existsSync(toolMod.videoStudioProductionStatePath(resumedOpts, compositionDir))).toBe(true);
  });

  it('recovers the latest durable facts from the mirrored ledger when the primary state is corrupt', async () => {
    makePlanVisualOnly();
    const toolMod = await import('../../../../src/main/model/core-agent/video-studio-tool');
    const stateMod = await import('../../../../src/main/features/video_studio_state');
    const opts = {
      userId: UID,
      cid: 'cid-corrupt-primary-state',
      turnId: 'turn-corrupt-primary-state',
      agentId: VIDEO_STUDIO_AGENT_ID,
      agentName: 'VideoStudio',
      userMessage: '确认',
    };
    const tool = toolMod.createVideoStudioTool(opts);
    const ctx = { workingDir: workspace, state: {} } as any;
    expect((await tool.execute({
      op: 'composition.approve_plan',
      composition_dir: 'project/composition',
      decision_evidence: decisionEvidence('plan', 'approve', '确认'),
    }, ctx)).isError).toBe(false);
    const statePath = toolMod.videoStudioProductionStatePath(opts, compositionDir);
    await stateMod.updateVideoProductionState(statePath, compositionDir, (state) => {
      const startedAt = new Date(0).toISOString();
      state.active_operation = {
        operation_id: 'recover-from-mirror',
        op: 'composition.snapshot',
        stage: state.stage,
        revision: state.revision + 1,
        started_at: startedAt,
      };
      state.operation_journal = [{
        operation_id: 'recover-from-mirror',
        op: 'composition.snapshot',
        status: 'started',
        started_at: startedAt,
      }];
    });
    expect(fs.existsSync(`${statePath}.bak`)).toBe(true);

    const stalePrimary = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    stalePrimary.revision -= 1;
    delete stalePrimary.active_operation;
    fs.writeFileSync(statePath, JSON.stringify(stalePrimary), 'utf8');
    const newestRevision = await stateMod.readVideoProductionState(statePath, compositionDir);
    expect(newestRevision.active_operation).toMatchObject({
      operation_id: 'recover-from-mirror',
    });

    fs.writeFileSync(statePath, '{"schema_version":1,"revision":', 'utf8');
    const recoveredState = await stateMod.readVideoProductionState(statePath, compositionDir);
    expect(recoveredState.plan_approval).toMatchObject({
      gate: 'B',
      signature: expect.any(String),
    });
    expect(recoveredState.active_operation).toMatchObject({
      operation_id: 'recover-from-mirror',
    });

    const status = parseResult((await tool.execute({
      op: 'composition.status',
      composition_dir: 'project/composition',
    }, ctx)).content);
    expect(status).toMatchObject({
      reconciliation_required: true,
      production_state: {
        plan_approval: { gate: 'B' },
        active_operation: { operation_id: 'recover-from-mirror' },
      },
    });
    expect(status.production_state.next_allowed_ops).toEqual(expect.arrayContaining([
      'composition.reconcile',
      'composition.lint',
      'composition.inspect',
    ]));

    const reconciled = await tool.execute({
      op: 'composition.reconcile',
      composition_dir: 'project/composition',
    }, ctx);
    expect(reconciled.isError).toBe(false);
    const result = parseResult(reconciled.content);
    expect(result.production_state).not.toHaveProperty('active_operation');
    expect(result.production_state.operation_journal).toEqual([
      expect.objectContaining({
        operation_id: 'recover-from-mirror',
        status: 'interrupted',
        consumes_same_input_attempt: false,
      }),
    ]);
    const primary = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    const mirror = JSON.parse(fs.readFileSync(`${statePath}.bak`, 'utf8'));
    expect(primary.revision).toBe(mirror.revision);
    expect(primary.plan_approval.signature).toBe(mirror.plan_approval.signature);
    expect(ttsMock.generateSpeech).not.toHaveBeenCalled();
  });

  it('does not fork composition state when only project routing metadata changes', async () => {
    const toolMod = await import('../../../../src/main/model/core-agent/video-studio-tool');
    const base = { userId: UID, cid: 'cid-one', projectId: 'project-one' };
    const resumed = { userId: UID, cid: 'cid-two', projectId: 'project-two' };
    expect(toolMod.videoStudioProductionStatePath(base, compositionDir))
      .toBe(toolMod.videoStudioProductionStatePath(resumed, compositionDir));
  });

  it('rejects semantic manifest defects before recording production-plan approval', async () => {
    makePlanVisualOnly();
    const manifestPath = path.join(compositionDir, 'composition-manifest.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    manifest.scenes[0].approved_copy = ['EXECUTION IS CHEAP. ATTENTION IS NOT.'];
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');

    const mod = await import('../../../../src/main/model/core-agent/video-studio-tool');
    const opts = {
      userId: UID,
      cid: 'cid-semantic-plan-validation',
      turnId: 'turn-plan-approval',
      agentId: VIDEO_STUDIO_AGENT_ID,
      agentName: 'VideoStudio',
      userMessage: approvalSubmission('gate_b_decision', 'approve'),
    };
    const tool = mod.createVideoStudioTool(opts);
    const approval = await tool.execute({
      op: 'composition.approve_plan',
      composition_dir: 'project/composition',
    }, { workingDir: workspace, state: {} } as any);

    expect(approval.isError).toBe(true);
    expect(approval.content).toContain('E_GATE_B_REQUIREMENTS_INCOMPLETE');
    expect(approval.content).toContain('COMPOSITION_MANIFEST_PRIMARY_COPY_ALL_CAPS');
    const state = await (await import('../../../../src/main/features/video_studio_state'))
      .readVideoProductionState(mod.videoStudioProductionStatePath(opts, compositionDir), compositionDir);
    expect(state.plan_approval).toBeUndefined();
  });

  it.each([
    {
      label: 'invalid shotlist JSON',
      expectedRole: 'shotlist',
      expectedCode: 'invalid_json',
      mutate: () => {
        fs.writeFileSync(
          path.join(workspace, 'project', 'shotlist.json'),
          '{"target_duration_seconds": 40,',
          'utf8',
        );
      },
    },
    {
      label: 'invalid composition manifest structure',
      expectedRole: 'manifest',
      expectedCode: 'invalid_manifest',
      mutate: () => {
        const manifestPath = path.join(compositionDir, 'composition-manifest.json');
        const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
        delete manifest.composition;
        fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');
      },
    },
  ])('distinguishes $label from a missing approval artifact and preserves the current confirmation', async ({
    expectedRole,
    expectedCode,
    mutate,
  }) => {
    makePlanVisualOnly();
    mutate();
    const published: string[][] = [];
    const mod = await import('../../../../src/main/model/core-agent/video-studio-tool');
    const opts = {
      userId: UID,
      cid: `cid-plan-artifact-invalid-${expectedRole}`,
      turnId: `turn-plan-artifact-invalid-${expectedRole}`,
      agentId: VIDEO_STUDIO_AGENT_ID,
      agentName: 'VideoStudio',
      userMessage: approvalSubmission('gate_b_decision', 'approve'),
      onOutputsPublished: async (paths: string[]) => {
        published.push(paths);
        return paths;
      },
    };
    const result = await mod.createVideoStudioTool(opts).execute({
      op: 'composition.approve_plan',
      composition_dir: 'project/composition',
    }, { workingDir: workspace, state: {} } as any);

    expect(result.isError).toBe(true);
    const payload = parseResult(result.content);
    expect(payload).toMatchObject({
      errorCode: 'E_GATE_B_ARTIFACT_INVALID',
      approval_received: true,
      user_reconfirmation_required: false,
      requires_user_decision: false,
      next_action: 'repair_invalid_plan_artifacts_then_retry_composition.approve_plan',
      artifact_issues: [{
        role: expectedRole,
        code: expectedCode,
        path: expect.any(String),
        message: expect.any(String),
        details: [expect.objectContaining({
          path: expect.any(String),
          message: expect.any(String),
        })],
      }],
      review_package: {
        presentation_required: true,
        conclusion: {
          outcome: 'blocked',
          error_code: 'E_GATE_B_ARTIFACT_INVALID',
          next_action: 'repair_invalid_plan_artifacts_then_retry_composition.approve_plan',
          requires_user_decision: false,
          next_step_owner: 'agent',
          automatic_recovery_expected: true,
        },
        primary_artifact: {
          role: 'script',
          review_status: 'current_input',
        },
        artifacts: expect.arrayContaining([
          expect.objectContaining({ role: 'script' }),
          expect.objectContaining({ role: 'shotlist' }),
          expect.objectContaining({ role: 'plan_manifest' }),
        ]),
      },
    });
    expect(payload.message).toContain('confirmation is still valid');
    expect(published.flat()).toEqual(expect.arrayContaining([
      path.join(workspace, 'project', 'script.md'),
      path.join(workspace, 'project', 'shotlist.json'),
      path.join(compositionDir, 'composition-manifest.json'),
    ]));
  });

  it('keeps a genuinely missing plan file distinct from invalid content', async () => {
    makePlanVisualOnly();
    const shotlistPath = path.join(workspace, 'project', 'shotlist.json');
    fs.unlinkSync(shotlistPath);
    const mod = await import('../../../../src/main/model/core-agent/video-studio-tool');
    const result = await mod.createVideoStudioTool({
      userId: UID,
      cid: 'cid-plan-artifact-missing',
      turnId: 'turn-plan-artifact-missing',
      agentId: VIDEO_STUDIO_AGENT_ID,
      agentName: 'VideoStudio',
      userMessage: approvalSubmission('gate_b_decision', 'approve'),
    }).execute({
      op: 'composition.approve_plan',
      composition_dir: 'project/composition',
    }, { workingDir: workspace, state: {} } as any);

    expect(result.isError).toBe(true);
    expect(parseResult(result.content)).toMatchObject({
      errorCode: 'E_GATE_B_ARTIFACTS_INCOMPLETE',
      approval_received: true,
      user_reconfirmation_required: false,
      artifact_issues: [],
      next_action: 'restore_missing_plan_artifacts_then_retry_composition.approve_plan',
      evidence: {
        observations: expect.arrayContaining([
          expect.objectContaining({ role: 'shotlist', status: 'missing' }),
        ]),
      },
    });
  });

  it('keeps registered and legacy runtime-output directories outside the authored-input signature', async () => {
    const mod = await import('../../../../src/main/model/core-agent/video-studio-tool');
    const beforeV4 = await mod.videoStudioCompositionSignature(compositionDir, 4);
    const beforeV5 = await mod.videoStudioCompositionSignature(compositionDir, 5);

    for (const [relativePath, content] of [
      ['previews/current/contact-sheet.svg', '<svg/>'],
      ['drafts/draft.mp4', 'rendered draft'],
      ['drafts/draft-evidence/01-first-frame.png', 'frame'],
      ['reports/draft-qa.json', '{"ok":true}'],
      ['outputs/legacy-draft.mp4', 'legacy rendered draft'],
      ['outputs/draft-evidence/01-first-frame.png', 'legacy frame'],
      ['outputs/legacy-draft-qa.json', '{"ok":true}'],
    ]) {
      const target = path.join(compositionDir, relativePath);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, content);
    }

    expect(await mod.videoStudioCompositionSignature(compositionDir, 5)).toBe(beforeV5);
    expect(await mod.videoStudioCompositionSignature(compositionDir, 4)).not.toBe(beforeV4);
    expect(await mod.videoStudioCompositionSignature(compositionDir, 3)).not.toBe(beforeV5);
  });

  it('rejects draft and export artifacts inside the authored composition tree', async () => {
    const mod = await import('../../../../src/main/model/core-agent/video-studio-tool');
    const tool = mod.createVideoStudioTool({
      userId: UID,
      cid: 'cid-runtime-output-boundary',
      turnId: 'turn-runtime-output-boundary',
      agentId: VIDEO_STUDIO_AGENT_ID,
      agentName: 'VideoStudio',
      userMessage: '继续',
    });
    const ctx = { workingDir: workspace, state: {} } as any;

    const draftOutput = await tool.execute({
      op: 'composition.draft',
      composition_dir: 'project/composition',
      output_path: 'project/composition/outputs/draft.mp4',
    }, ctx);
    expect(draftOutput.isError).toBe(true);
    expect(parseResult(draftOutput.content)).toMatchObject({
      errorCode: 'E_COMPOSITION_RUNTIME_OUTPUT_IN_SOURCE',
      next_action: 'retry_with_project_render_output',
    });

    const draftReport = await tool.execute({
      op: 'composition.draft',
      composition_dir: 'project/composition',
      output_path: 'project/render/draft.mp4',
      report_path: 'project/composition/outputs/draft-qa.json',
    }, ctx);
    expect(draftReport.isError).toBe(true);
    expect(parseResult(draftReport.content)).toMatchObject({
      errorCode: 'E_COMPOSITION_RUNTIME_OUTPUT_IN_SOURCE',
      next_action: 'retry_with_project_render_report',
    });
    expect(fs.existsSync(path.join(compositionDir, 'outputs', 'draft.mp4'))).toBe(false);
  });

  it('requires gate-specific approval content, not merely a later turn', async () => {
    makePlanVisualOnly();
    const mod = await import('../../../../src/main/model/core-agent/video-studio-tool');
    const stateMod = await import('../../../../src/main/features/video_studio_state');
    const ctx = { workingDir: workspace, state: {} } as any;
    const planTool = mod.createVideoStudioTool({
      userId: UID,
      cid: 'cid-explicit-gates',
      turnId: 'turn-plan-approval',
      agentId: VIDEO_STUDIO_AGENT_ID,
      agentName: 'VideoStudio',
      userMessage: approvalSubmission('gate_b_reconfirm', 'approve'),
    });
    expect((await planTool.execute({
      op: 'composition.approve_plan',
      composition_dir: 'project/composition',
    }, ctx)).isError).toBe(false);

    const statePath = mod.videoStudioProductionStatePath({
      userId: UID,
      cid: 'cid-explicit-gates',
    }, compositionDir);
    expect(await mod.recordVideoStudioGate(
      statePath,
      'preview',
      compositionDir,
      'turn-preview',
      {
        preview_ready: true,
        preview_qa: { ok: true, error_count: 0 },
        preflight: { status: 'passed', blocking_error_count: 0 },
        contact_sheet: path.join(compositionDir, 'preview', 'contact-sheet.png'),
      },
    )).toBe(true);

    const unrelatedTurnTool = mod.createVideoStudioTool({
      userId: UID,
      cid: 'cid-explicit-gates',
      turnId: 'turn-unrelated',
      agentId: VIDEO_STUDIO_AGENT_ID,
      agentName: 'VideoStudio',
      userMessage: '<msg from="user" to="79df9cc89f5f">@VideoStudio\n这个预览里用了什么字体？</msg>',
    });
    const unrelatedPreviewApproval = await unrelatedTurnTool.execute({
      op: 'composition.approve_preview',
      composition_dir: 'project/composition',
    }, ctx);
    expect(unrelatedPreviewApproval.isError).toBe(true);
    expect(unrelatedPreviewApproval.content).toContain('E_HTML_PREVIEW_EXPLICIT_APPROVAL_REQUIRED');

    const malformedPreviewApprovalTool = mod.createVideoStudioTool({
      userId: UID,
      cid: 'cid-explicit-gates',
      turnId: 'turn-preview-malformed-evidence',
      agentId: VIDEO_STUDIO_AGENT_ID,
      agentName: 'VideoStudio',
      userMessage: '继续',
    });
    const malformedPreviewApproval = await malformedPreviewApprovalTool.execute({
      op: 'composition.approve_preview',
      composition_dir: 'project/composition',
      decision_evidence: '继续',
    }, ctx);
    expect(malformedPreviewApproval.isError).toBe(true);
    expect(parseResult(malformedPreviewApproval.content)).toMatchObject({
      errorCode: 'E_DECISION_EVIDENCE_INVALID',
      decision_evidence_valid: false,
      decision_evidence_issue: 'expected_object',
      requires_user_decision: false,
      user_reconfirmation_required: false,
      automatic_recovery_expected: true,
      billable_request_sent: false,
      next_action: 'retry_same_operation_with_structured_decision_evidence',
      expected_decision_evidence: {
        source: 'user_message',
        gate: 'preview',
      },
    });
    expect((await stateMod.readVideoProductionState(statePath, compositionDir)).preview)
      .toMatchObject({ status: 'ready' });

    const previewApprovalTool = mod.createVideoStudioTool({
      userId: UID,
      cid: 'cid-explicit-gates',
      turnId: 'turn-preview-approval',
      agentId: VIDEO_STUDIO_AGENT_ID,
      agentName: 'VideoStudio',
      userMessage: '继续',
    });
    expect((await previewApprovalTool.execute({
      op: 'composition.approve_preview',
      composition_dir: 'project/composition',
      decision_evidence: JSON.stringify(decisionEvidence('preview', 'approve', '继续')),
    }, ctx)).isError).toBe(false);

    expect(await mod.recordVideoStudioGate(
      statePath,
      'draft',
      compositionDir,
      'turn-draft',
      { draft_ready: true, path: path.join(workspace, 'project', 'render', 'draft.mp4') },
    )).toBe(true);
    const wrongGateTool = mod.createVideoStudioTool({
      userId: UID,
      cid: 'cid-explicit-gates',
      turnId: 'turn-wrong-gate',
      agentId: VIDEO_STUDIO_AGENT_ID,
      agentName: 'VideoStudio',
      userMessage: approvalSubmission('gate_b_decision', 'approve'),
    });
    const wrongGateApproval = await wrongGateTool.execute({
      op: 'composition.approve_draft',
      composition_dir: 'project/composition',
    }, ctx);
    expect(wrongGateApproval.isError).toBe(true);
    expect(wrongGateApproval.content).toContain('E_GATE_D_EXPLICIT_APPROVAL_REQUIRED');

    const draftApprovalTool = mod.createVideoStudioTool({
      userId: UID,
      cid: 'cid-explicit-gates',
      turnId: 'turn-draft-approval',
      agentId: VIDEO_STUDIO_AGENT_ID,
      agentName: 'VideoStudio',
      userMessage: approvalSubmission('gate_d_decision', 'approve'),
    });
    expect((await draftApprovalTool.execute({
      op: 'composition.approve_draft',
      composition_dir: 'project/composition',
    }, ctx)).isError).toBe(false);
  });

  it('binds preview forms to the displayed artifact and rejects stale or ambiguous legacy submissions', async () => {
    makePlanVisualOnly();
    const toolMod = await import('../../../../src/main/model/core-agent/video-studio-tool');
    const stateMod = await import('../../../../src/main/features/video_studio_state');
    const ctx = { workingDir: workspace, state: {} } as any;
    const baseOpts = {
      userId: UID,
      cid: 'cid-preview-form-artifact-binding',
      agentId: VIDEO_STUDIO_AGENT_ID,
      agentName: 'VideoStudio',
    };
    const planTool = toolMod.createVideoStudioTool({
      ...baseOpts,
      turnId: 'turn-plan',
      userMessage: '确认',
    });
    expect((await planTool.execute({
      op: 'composition.approve_plan',
      composition_dir: 'project/composition',
      decision_evidence: decisionEvidence('plan', 'approve', '确认'),
    }, ctx)).isError).toBe(false);

    const statePath = toolMod.videoStudioProductionStatePath(baseOpts, compositionDir);
    const firstSignature = await toolMod.videoStudioCompositionSignature(compositionDir);
    const htmlPath = path.join(compositionDir, 'index.html');
    fs.appendFileSync(htmlPath, '\n<style>.scene-title{letter-spacing:.01em}</style>\n');
    const currentSignature = await toolMod.videoStudioCompositionSignature(compositionDir);
    expect(currentSignature).not.toBe(firstSignature);

    const contactSheet = path.join(compositionDir, 'preview', 'contact-sheet-current.png');
    const framePath = path.join(compositionDir, 'preview', 'frame-current.png');
    fs.mkdirSync(path.dirname(contactSheet), { recursive: true });
    fs.writeFileSync(contactSheet, 'current contact sheet');
    fs.writeFileSync(framePath, 'current frame');
    expect(await toolMod.recordVideoStudioGate(
      statePath,
      'preview',
      compositionDir,
      'turn-current-preview',
      {
        preview_ready: true,
        preview_qa: { ok: true, error_count: 0 },
        preflight: { status: 'passed', blocking_error_count: 0 },
        contact_sheet: contactSheet,
        frame_paths: [framePath],
      },
    )).toBe(true);
    await stateMod.updateVideoProductionState(statePath, compositionDir, (state) => {
      const now = new Date().toISOString();
      state.current_candidate = {
        revision_id: `candidate-${currentSignature.slice(0, 16)}`,
        parent_revision_id: `candidate-${firstSignature.slice(0, 16)}`,
        content_hash: currentSignature,
        artifacts: { composition_signature: currentSignature },
        locators: {
          html_path: htmlPath,
          manifest_path: path.join(compositionDir, 'composition-manifest.json'),
          preview_path: contactSheet,
          frame_paths: [framePath],
        },
        runtime_fingerprint: 'test-current-preview',
        created_at: now,
        last_observed_at: now,
        last_observed_op: 'composition.snapshot',
      };
      state.candidate_history = [{
        revision_id: `candidate-${firstSignature.slice(0, 16)}`,
        content_hash: firstSignature,
        artifacts: { composition_signature: firstSignature },
        locators: {
          html_path: htmlPath,
          manifest_path: path.join(compositionDir, 'composition-manifest.json'),
        },
        runtime_fingerprint: 'test-old-preview',
        created_at: now,
        last_observed_at: now,
        last_observed_op: 'composition.snapshot',
      }];
    });

    const staleTool = toolMod.createVideoStudioTool({
      ...baseOpts,
      turnId: 'turn-stale-form',
      userMessage: approvalSubmission(
        'preview_decision',
        `approve::${firstSignature}`,
      ),
    });
    const stale = await staleTool.execute({
      op: 'composition.approve_preview',
      composition_dir: 'project/composition',
    }, ctx);
    expect(stale.isError).toBe(true);
    expect(parseResult(stale.content)).toMatchObject({
      errorCode: 'E_VIDEO_REVIEW_SUBMISSION_SUPERSEDED',
      submitted_decision_status: 'superseded',
      submitted_artifact_signature: firstSignature,
      current_artifact_signature: currentSignature,
      current_review_status: 'pending',
      user_reconfirmation_required: false,
      billable_request_sent: false,
      next_action: 'show_current_artifact_and_keep_existing_review_pending',
      current_candidate: {
        content_hash: currentSignature,
        locators: {
          preview_path: contactSheet,
          frame_paths: [framePath],
        },
      },
    });
    expect(parseResult(stale.content)).not.toHaveProperty('recovery_form');
    expect((await stateMod.readVideoProductionState(statePath, compositionDir)).preview)
      .toMatchObject({ status: 'ready', signature: currentSignature });

    const unboundLegacyTool = toolMod.createVideoStudioTool({
      ...baseOpts,
      turnId: 'turn-unbound-legacy-form',
      userMessage: approvalSubmission('preview_decision', 'approve'),
    });
    const unbound = await unboundLegacyTool.execute({
      op: 'composition.approve_preview',
      composition_dir: 'project/composition',
    }, ctx);
    expect(unbound.isError).toBe(true);
    expect(parseResult(unbound.content)).toMatchObject({
      errorCode: 'E_VIDEO_REVIEW_SUBMISSION_SUPERSEDED',
      submitted_decision_status: 'unbound_after_revision',
      submitted_artifact_signature: null,
      current_artifact_signature: currentSignature,
    });

    const currentTool = toolMod.createVideoStudioTool({
      ...baseOpts,
      turnId: 'turn-current-bound-form',
      userMessage: approvalSubmission(
        'preview_decision',
        `approve::${currentSignature}`,
      ),
    });
    const approved = await currentTool.execute({
      op: 'composition.approve_preview',
      composition_dir: 'project/composition',
    }, ctx);
    expect(approved.isError).toBe(false);
    expect(parseResult(approved.content)).toMatchObject({
      status: 'approved',
      artifact_signature: currentSignature,
      decision_source: 'form',
    });

    const draftPath = path.join(workspace, 'project', 'render', 'draft-current.mp4');
    fs.mkdirSync(path.dirname(draftPath), { recursive: true });
    fs.writeFileSync(draftPath, 'current complete draft');
    expect(await toolMod.recordVideoStudioGate(
      statePath,
      'draft',
      compositionDir,
      'turn-current-draft',
      { draft_ready: true, path: draftPath },
    )).toBe(true);
    await stateMod.updateVideoProductionState(statePath, compositionDir, (state) => {
      if (state.current_candidate) state.current_candidate.locators.draft_path = draftPath;
    });

    const staleDraftTool = toolMod.createVideoStudioTool({
      ...baseOpts,
      turnId: 'turn-stale-draft-form',
      userMessage: approvalSubmission(
        'gate_d_decision',
        `approve::${firstSignature}`,
      ),
    });
    const staleDraft = await staleDraftTool.execute({
      op: 'composition.approve_draft',
      composition_dir: 'project/composition',
    }, ctx);
    expect(staleDraft.isError).toBe(true);
    expect(parseResult(staleDraft.content)).toMatchObject({
      errorCode: 'E_VIDEO_REVIEW_SUBMISSION_SUPERSEDED',
      submitted_decision_status: 'superseded',
      submitted_artifact_signature: firstSignature,
      current_artifact_signature: currentSignature,
      current_candidate: {
        locators: { draft_path: draftPath },
      },
    });
    expect((await stateMod.readVideoProductionState(statePath, compositionDir)).draft)
      .toMatchObject({ status: 'ready', signature: currentSignature });

    const currentDraftTool = toolMod.createVideoStudioTool({
      ...baseOpts,
      turnId: 'turn-current-bound-draft-form',
      userMessage: approvalSubmission(
        'gate_d_decision',
        `approve::${currentSignature}`,
      ),
    });
    const approvedDraft = await currentDraftTool.execute({
      op: 'composition.approve_draft',
      composition_dir: 'project/composition',
    }, ctx);
    expect(approvedDraft.isError).toBe(false);
    expect(parseResult(approvedDraft.content)).toMatchObject({
      status: 'approved',
      artifact_signature: currentSignature,
      decision_source: 'form',
    });
  });

  it('reviews every current preview frame before publishing or enabling preview approval', async () => {
    makePlanVisualOnly();
    const videoStudio = await import('../../../../src/main/features/video_studio');
    const toolMod = await import('../../../../src/main/model/core-agent/video-studio-tool');
    const stateMod = await import('../../../../src/main/features/video_studio_state');
    const ctx = { workingDir: workspace, state: {} } as any;
    const published: string[][] = [];
    const opts = {
      userId: UID,
      cid: 'cid-preview-design-review',
      turnId: 'turn-preview-review',
      agentId: VIDEO_STUDIO_AGENT_ID,
      agentName: 'VideoStudio',
      userMessage: '确认',
      onOutputsPublished: async (paths: string[]) => { published.push(paths); },
    };
    const tool = toolMod.createVideoStudioTool(opts);
    expect((await tool.execute({
      op: 'composition.approve_plan',
      composition_dir: 'project/composition',
      decision_evidence: decisionEvidence('plan', 'approve', '确认'),
    }, ctx)).isError).toBe(false);

    const statePath = toolMod.videoStudioProductionStatePath(opts, compositionDir);
    const contactSheet = path.join(compositionDir, 'preview-contact-sheet.png');
    const framePaths = [
      path.join(compositionDir, 'preview-contact-sheet-frames', '01-first-frame.png'),
      path.join(compositionDir, 'preview-contact-sheet-frames', '02-scene-mid.png'),
    ];
    await stateMod.updateVideoProductionState(statePath, compositionDir, (state) => {
      state.stage = 'visuals_ready';
    });
    vi.spyOn(videoStudio, 'snapshotComposition').mockResolvedValue({
      ok: true,
      op: 'composition.snapshot',
      preview_ready: true,
      preview_qa: { ok: true, error_count: 0 },
      preflight: { status: 'passed', blocking_error_count: 0 },
      contact_sheet: contactSheet,
      frame_paths: framePaths,
    } as any);
    const snapshot = await tool.execute({
      op: 'composition.snapshot',
      composition_dir: 'project/composition',
      output_path: 'project/composition/preview-contact-sheet.png',
    }, ctx);
    expect(snapshot.isError).toBe(false);
    expect(parseResult(snapshot.content)).toMatchObject({
      preview_design_review_required: true,
      preview_gate_ready: false,
      next_action: 'composition.submit_design_review',
    });
    expect(published).toEqual([]);

    const pending = await stateMod.readVideoProductionState(statePath, compositionDir);
    expect(stateMod.nextVideoProductionOps(pending)).toContain('composition.submit_design_review');
    expect(stateMod.nextVideoProductionOps(pending)).not.toContain('composition.approve_preview');
    expect((await toolMod.approveVideoStudioGate(
      statePath,
      'preview',
      compositionDir,
      'turn-user-approval',
      true,
    ))).toMatchObject({ ok: false, errorCode: 'E_PREVIEW_DESIGN_REVIEW_REQUIRED' });

    const incomplete = await tool.execute({
      op: 'composition.submit_design_review',
      composition_dir: 'project/composition',
      review_verdict: 'passed',
      review_scope: 'all preview frames',
      review_findings: [],
      reviewed_frame_paths: [framePaths[0]],
    }, ctx);
    expect(incomplete.isError).toBe(true);
    expect(parseResult(incomplete.content)).toMatchObject({
      errorCode: 'E_PREVIEW_DESIGN_REVIEW_COVERAGE_REQUIRED',
      reviewed_frame_count: 1,
      expected_frame_count: 2,
    });
    expect(published).toEqual([]);

    const passed = await tool.execute({
      op: 'composition.submit_design_review',
      composition_dir: 'project/composition',
      review_verdict: 'passed',
      review_scope: 'first frame and every returned scene sample; typography, hierarchy, safe area, and overlap',
      review_findings: [],
      quality_scores: passingDesignScores,
      reviewed_frame_paths: framePaths,
    }, ctx);
    expect(passed.isError).toBe(false);
    expect(parseResult(passed.content)).toMatchObject({
      review_target: 'preview',
      preview_gate_ready: true,
      reviewed_frame_count: 2,
      expected_frame_count: 2,
      next_action: 'show_preview_then_wait_for_user_approval',
    });
    expect(published).toEqual([[path.resolve(contactSheet)]]);

    const reviewed = await stateMod.readVideoProductionState(statePath, compositionDir);
    expect(stateMod.nextVideoProductionOps(reviewed)).toContain('composition.approve_preview');
    expect(reviewed.preview?.design_review).toMatchObject({
      status: 'passed',
      reviewed_frame_paths: framePaths.map((value) => path.resolve(value)),
    });
    expect((await toolMod.approveVideoStudioGate(
      statePath,
      'preview',
      compositionDir,
      'turn-user-approval',
      true,
    )).ok).toBe(true);
  });

  it('publishes the current preview and conclusion when design review requires repair', async () => {
    makePlanVisualOnly();
    const videoStudio = await import('../../../../src/main/features/video_studio');
    const toolMod = await import('../../../../src/main/model/core-agent/video-studio-tool');
    const stateMod = await import('../../../../src/main/features/video_studio_state');
    const ctx = { workingDir: workspace, state: {} } as any;
    const published: string[][] = [];
    const opts = {
      userId: UID,
      cid: 'cid-preview-design-repair-package',
      turnId: 'turn-preview-design-repair-package',
      agentId: VIDEO_STUDIO_AGENT_ID,
      agentName: 'VideoStudio',
      userMessage: '确认',
      onOutputsPublished: async (paths: string[]) => {
        published.push(paths);
        return paths;
      },
    };
    const tool = toolMod.createVideoStudioTool(opts);
    expect((await tool.execute({
      op: 'composition.approve_plan',
      composition_dir: 'project/composition',
      decision_evidence: decisionEvidence('plan', 'approve', '确认'),
    }, ctx)).isError).toBe(false);

    const statePath = toolMod.videoStudioProductionStatePath(opts, compositionDir);
    await stateMod.updateVideoProductionState(statePath, compositionDir, (state) => {
      state.stage = 'visuals_ready';
    });
    const contactSheet = path.join(compositionDir, 'repair-preview-contact-sheet.png');
    const framesDir = path.join(compositionDir, 'repair-preview-frames');
    const framePaths = [
      path.join(framesDir, '01-first-frame.png'),
      path.join(framesDir, '02-payoff.png'),
    ];
    fs.mkdirSync(framesDir, { recursive: true });
    fs.writeFileSync(contactSheet, 'current preview', 'utf8');
    for (const framePath of framePaths) fs.writeFileSync(framePath, 'current frame', 'utf8');
    vi.spyOn(videoStudio, 'snapshotComposition').mockResolvedValue({
      ok: true,
      op: 'composition.snapshot',
      preview_ready: true,
      preview_qa: { ok: true, error_count: 0 },
      preflight: { status: 'passed', blocking_error_count: 0 },
      contact_sheet: contactSheet,
      frame_paths: framePaths,
    } as any);
    expect((await tool.execute({
      op: 'composition.snapshot',
      composition_dir: 'project/composition',
      output_path: 'project/composition/repair-preview-contact-sheet.png',
    }, ctx)).isError).toBe(false);
    expect(published).toEqual([]);

    const repair = await tool.execute({
      op: 'composition.submit_design_review',
      composition_dir: 'project/composition',
      review_verdict: 'repair',
      review_scope: 'first frame and payoff at usable scale',
      review_findings: [
        'The title hierarchy is too weak at thumbnail size.',
        'The payoff visual does not clearly communicate the approved conclusion.',
      ],
      quality_scores: {
        content_alignment: 66,
        cover_communication: 54,
        hierarchy: 58,
        text_legibility: 74,
        motion_readiness: 70,
        specificity: 60,
      },
      reviewed_frame_paths: framePaths,
    }, ctx);
    expect(repair.isError).toBe(false);
    const result = parseResult(repair.content);
    expect(result).toMatchObject({
      status: 'repair',
      next_action: 'repair_visuals_then_composition.reconcile',
      requires_user_decision: false,
      review_package: {
        presentation_required: true,
        status: 'current_unapproved',
        conclusion: {
          outcome: 'quality_not_accepted',
          error_code: 'E_PREVIEW_DESIGN_REVIEW_NOT_ACCEPTED',
          requires_user_decision: false,
        },
        primary_artifact: {
          role: 'preview',
          review_status: 'current_unapproved',
        },
        artifacts: expect.arrayContaining([
          expect.objectContaining({ role: 'preview' }),
          expect.objectContaining({ role: 'frame' }),
        ]),
      },
    });
    expect(result.review_package.conclusion.summary).toContain('title hierarchy');
    expect(published.flat()).toContain(result.review_package.primary_artifact.path);
  });

  it('inherits a passed approved-preview review instead of repeating static design review after draft render', async () => {
    makePlanVisualOnly();
    const videoStudio = await import('../../../../src/main/features/video_studio');
    const toolMod = await import('../../../../src/main/model/core-agent/video-studio-tool');
    const stateMod = await import('../../../../src/main/features/video_studio_state');
    const ctx = { workingDir: workspace, state: {} } as any;
    const opts = {
      userId: UID,
      cid: 'cid-preview-review-inheritance',
      turnId: 'turn-draft',
      agentId: VIDEO_STUDIO_AGENT_ID,
      agentName: 'VideoStudio',
      userMessage: '确认',
    };
    const tool = toolMod.createVideoStudioTool(opts);
    expect((await tool.execute({
      op: 'composition.approve_plan',
      composition_dir: 'project/composition',
      decision_evidence: decisionEvidence('plan', 'approve', '确认'),
    }, ctx)).isError).toBe(false);

    const statePath = toolMod.videoStudioProductionStatePath(opts, compositionDir);
    const framePath = path.join(compositionDir, 'preview-contact-sheet-frames', '01-first-frame.png');
    expect(await toolMod.recordVideoStudioGate(statePath, 'preview', compositionDir, 'turn-snapshot', {
      preview_ready: true,
      preview_qa: { ok: true, error_count: 0 },
      preflight: { status: 'passed', blocking_error_count: 0 },
      contact_sheet: path.join(compositionDir, 'preview-contact-sheet.png'),
      frame_paths: [framePath],
      design_review_required: true,
    })).toBe(true);
    await stateMod.updateVideoProductionState(statePath, compositionDir, (state) => {
      if (!state.preview) throw new Error('preview missing');
      state.preview.design_review = {
        required: true,
        status: 'passed',
        reviewed_at: new Date().toISOString(),
        verdict: 'passed',
        scope: 'all preview frames',
        findings: [],
        reviewed_frame_paths: [framePath],
      };
    });
    expect((await toolMod.approveVideoStudioGate(
      statePath,
      'preview',
      compositionDir,
      'turn-preview-approval',
      true,
    )).ok).toBe(true);

    const renderDir = path.join(workspace, 'project', 'render');
    const draftPath = path.join(renderDir, 'draft.mp4');
    vi.spyOn(videoStudio, 'draftComposition').mockImplementation(async (options: any) => {
      fs.mkdirSync(path.dirname(options.outputAbsPath), { recursive: true });
      fs.writeFileSync(options.outputAbsPath, 'rendered draft');
      fs.writeFileSync(path.join(renderDir, 'draft-cover.png'), 'cover');
      fs.writeFileSync(path.join(renderDir, 'draft-qa.json'), '{"ok":true}');
      fs.mkdirSync(path.join(renderDir, 'draft-evidence'), { recursive: true });
      fs.writeFileSync(path.join(renderDir, 'draft-evidence', '01-first-frame.png'), 'frame');
      return {
        ok: true,
        op: 'composition.draft',
        path: draftPath,
        cover_path: path.join(renderDir, 'draft-cover.png'),
        draft_ready: true,
        report: { steps: { render: { status: 'passed' } } },
      } as any;
    });
    const draft = await tool.execute({
      op: 'composition.draft',
      composition_dir: 'project/composition',
      output_path: 'project/render/draft.mp4',
      report_path: 'project/render/draft-qa.json',
    }, ctx);
    expect(draft.isError).toBe(false);
    expect(parseResult(draft.content)).toMatchObject({
      design_review_required: false,
      design_review_inherited_from_preview: true,
      gate_d_ready: true,
      next_action: 'open_gate_d',
      production_state: {
        stage: 'draft_ready',
        draft_design_review: {
          required: false,
          status: 'passed',
          verdict: 'preview_review_inherited',
        },
      },
    });
    expect(parseResult(draft.content).next_allowed_ops).toContain('composition.approve_draft');
    expect(parseResult(draft.content).next_allowed_ops).not.toContain('composition.submit_design_review');

    const status = parseResult((await tool.execute({
      op: 'composition.status',
      composition_dir: 'project/composition',
    }, ctx)).content);
    expect(status).toMatchObject({
      artifact_drift: false,
      reconciliation_required: false,
      production_state: {
        stage: 'draft_ready',
        draft_status: 'ready',
      },
    });
  });

  it('records one parent EDL Gate B and lets a matching AUTO child inherit it without another user gate', async () => {
    writeAutoParentPlan();
    const child = writeAutoChildComposition();
    const mod = await import('../../../../src/main/model/core-agent/video-studio-tool');
    const ctx = { workingDir: workspace, state: {} } as any;

    const parentApprovalTool = mod.createVideoStudioTool({
      userId: UID,
      cid: 'cid-auto-parent',
      turnId: 'turn-auto-gate-b',
      agentId: VIDEO_STUDIO_AGENT_ID,
      agentName: 'VideoStudio',
      userMessage: approvalSubmission('gate_b_decision', 'approve'),
    });
    const parentApproval = await parentApprovalTool.execute({
      op: 'production.approve_plan',
      plan_path: 'project/plan.json',
    }, ctx);
    expect(parentApproval.isError).toBe(false);

    const resumedTool = mod.createVideoStudioTool({
      userId: UID,
      cid: 'cid-auto-resumed',
      turnId: 'turn-auto-compose',
      agentId: VIDEO_STUDIO_AGENT_ID,
      agentName: 'VideoStudio',
      userMessage: '<msg from="user">unrelated later turn</msg>',
    });
    const inherited = await resumedTool.execute({
      op: 'composition.approve_plan',
      composition_dir: 'project/compositions/intro',
      plan_path: 'project/plan.json',
      segment_id: 'intro',
    }, ctx);
    expect(inherited.isError).toBe(false);
    const payload = parseResult(String(inherited.content));
    expect(payload.approval_inherited).toBe(true);
    expect(payload.parent_segment_id).toBe('intro');

    const childState = await import('../../../../src/main/features/video_studio_state');
    const state = await childState.readVideoProductionState(
      mod.videoStudioProductionStatePath({
        userId: UID,
        cid: 'a-third-task',
      }, child),
      child,
    );
    expect(state.plan_approval?.inheritance_reason).toBe('parent_edl_segment');
    expect(state.plan_approval?.parent_segment_id).toBe('intro');
  });

  it('rejects an unresolved EDL synthesis selection before recording Gate B', async () => {
    const planPath = writeAutoParentPlan();
    const plan = JSON.parse(fs.readFileSync(planPath, 'utf8'));
    plan.tracks = {
      narration: {
        synthesis: {
          route_ref: 'provider:doubao',
          voice_ref: 'provider:doubao:voice:invented',
          display_name: 'Invented',
          language: 'zh-CN',
          speed: 1,
        },
        segments: [{ text: 'approved line', start_sec: 0, target_sec: 5 }],
      },
    };
    fs.writeFileSync(planPath, JSON.stringify(plan, null, 2));
    const mod = await import('../../../../src/main/model/core-agent/video-studio-tool');
    const tool = mod.createVideoStudioTool({
      userId: UID,
      turnId: 'turn-edl-invalid-voice',
      agentId: VIDEO_STUDIO_AGENT_ID,
      userMessage: approvalSubmission('gate_b_decision', 'approve'),
    });
    const result = await tool.execute({
      op: 'production.approve_plan',
      plan_path: 'project/plan.json',
    }, { workingDir: workspace, state: {} } as any);
    expect(result.isError).toBe(true);
    expect(result.content).toContain('E_TTS_VOICE_UNRESOLVED');
  });

  it('records native Gate C only from a generation-specific current-turn approval', async () => {
    const planPath = path.join(workspace, 'project', 'plan.json');
    fs.writeFileSync(planPath, JSON.stringify({
      aspect: '16:9',
      total_target_sec: 5,
      language: 'en',
      delivery_promise: { type: 'motion_led', source_required: false, motion_min_ratio: 1 },
      segments: [{
        id: 'shot-1',
        order: 1,
        role: 'hook',
        layer: 'primary',
        source: 'generate',
        target_sec: 5,
        spec: { media_kind: 'video', prompt: 'A red sphere rotates', generate_audio: false },
      }],
      cost_estimate: { billable_generations: 1 },
    }), 'utf8');
    const mod = await import('../../../../src/main/model/core-agent/video-studio-tool');
    const ctx = { workingDir: workspace, state: {} } as any;
    const gateB = mod.createVideoStudioTool({
      userId: UID,
      cid: 'cid-generate-plan',
      turnId: 'turn-gate-b',
      agentId: VIDEO_STUDIO_AGENT_ID,
      agentName: 'VideoStudio',
      userMessage: approvalSubmission('gate_b_decision', 'approve'),
    });
    expect((await gateB.execute({ op: 'production.approve_plan', plan_path: 'project/plan.json' }, ctx)).isError)
      .toBe(false);

    const wrongGate = mod.createVideoStudioTool({
      userId: UID,
      cid: 'cid-generate-plan',
      turnId: 'turn-wrong-gate',
      agentId: VIDEO_STUDIO_AGENT_ID,
      agentName: 'VideoStudio',
      userMessage: approvalSubmission('gate_b_decision', 'approve'),
    });
    expect((await wrongGate.execute({ op: 'production.approve_generation', plan_path: 'project/plan.json' }, ctx)).content)
      .toContain('E_VIDEO_PRODUCTION_GATE_C_EXPLICIT_APPROVAL_REQUIRED');

    const gateC = mod.createVideoStudioTool({
      userId: UID,
      cid: 'cid-generate-plan',
      turnId: 'turn-gate-c',
      agentId: VIDEO_STUDIO_AGENT_ID,
      agentName: 'VideoStudio',
      userMessage: approvalSubmission('gate_c_decision', 'approve'),
    });
    const approved = await gateC.execute({ op: 'production.approve_generation', plan_path: 'project/plan.json' }, ctx);
    expect(approved.isError).toBe(false);
    expect(parseResult(approved.content)).toMatchObject({
      gate: 'C',
      production_control: {
        generation_approval_current: true,
        generation_segment_ids: ['shot-1'],
      },
    });
  });

  it('rejects AUTO child inheritance when its approved copy drifts from the parent EDL', async () => {
    writeAutoParentPlan();
    const child = writeAutoChildComposition();
    const manifestPath = path.join(child, 'composition-manifest.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    manifest.scenes[0].approved_copy = ['Unapproved replacement'];
    fs.writeFileSync(manifestPath, JSON.stringify(manifest), 'utf8');
    const mod = await import('../../../../src/main/model/core-agent/video-studio-tool');
    const ctx = { workingDir: workspace, state: {} } as any;
    const parentTool = mod.createVideoStudioTool({
      userId: UID,
      cid: 'cid-auto-drift',
      turnId: 'turn-auto-gate-b',
      agentId: VIDEO_STUDIO_AGENT_ID,
      userMessage: approvalSubmission('gate_b_decision', 'approve'),
    });
    expect((await parentTool.execute({
      op: 'production.approve_plan',
      plan_path: 'project/plan.json',
    }, ctx)).isError).toBe(false);
    const inherited = await parentTool.execute({
      op: 'composition.approve_plan',
      composition_dir: 'project/compositions/intro',
      plan_path: 'project/plan.json',
      segment_id: 'intro',
    }, ctx);
    expect(inherited.isError).toBe(true);
    expect(String(inherited.content)).toContain('E_PARENT_COMPOSITION_CONTENT_MISMATCH');
  });

  it('keeps Gate B requirements mandatory and auto-runs doctor when caller identity is absent', async () => {
    const mod = await import('../../../../src/main/model/core-agent/video-studio-tool');
    const shotlistPath = path.join(workspace, 'project', 'shotlist.json');
    const shotlist = JSON.parse(fs.readFileSync(shotlistPath, 'utf8'));
    delete shotlist.music_mode;
    fs.writeFileSync(shotlistPath, JSON.stringify(shotlist), 'utf8');

    const ctx = { workingDir: workspace, state: {} } as any;
    const toolWithoutIdentity = mod.createVideoStudioTool({
      userId: UID,
      turnId: 'turn-no-agent-id',
      userMessage: approvalSubmission('gate_b_decision', 'approve'),
    });
    const incomplete = await toolWithoutIdentity.execute({
      op: 'composition.approve_plan',
      composition_dir: 'project/composition',
    }, ctx);
    expect(incomplete.isError).toBe(true);
    expect(incomplete.content).toContain('E_GATE_B_REQUIREMENTS_INCOMPLETE');

    writePlan();
    expect((await toolWithoutIdentity.execute({
      op: 'composition.approve_plan',
      composition_dir: 'project/composition',
    }, ctx)).isError).toBe(false);
    const prepared = await toolWithoutIdentity.execute({
      op: 'composition.prepare',
      composition_dir: 'project/composition',
    }, ctx);
    expect(prepared.isError).toBe(false);
    expect(parseResult(prepared.content).production_state).toMatchObject({
      stage: 'scaffold_ready',
      capability_check: { status: 'ready' },
    });
  });

  it('uses manifest narration as canonical and rejects conflicting shotlist projections before Gate B', async () => {
    const mod = await import('../../../../src/main/model/core-agent/video-studio-tool');
    const shotlistPath = path.join(workspace, 'project', 'shotlist.json');
    const shotlist = JSON.parse(fs.readFileSync(shotlistPath, 'utf8'));
    delete shotlist.shots[0].narration;
    shotlist.shots[0].narration_text = 'This conflicts with the manifest.';
    fs.writeFileSync(shotlistPath, JSON.stringify(shotlist), 'utf8');

    const tool = mod.createVideoStudioTool({
      userId: UID,
      turnId: 'turn-plan-alignment',
      userMessage: approvalSubmission('gate_b_decision', 'approve'),
    });
    const ctx = { workingDir: workspace, state: {} } as any;
    const conflict = await tool.execute({
      op: 'composition.approve_plan',
      composition_dir: 'project/composition',
    }, ctx);
    expect(conflict.isError).toBe(true);
    expect(conflict.content).toContain('E_GATE_B_REQUIREMENTS_INCOMPLETE');
    expect(conflict.content).toContain('narration_conflicts_with_manifest');

    delete shotlist.shots[0].narration_text;
    fs.writeFileSync(shotlistPath, JSON.stringify(shotlist), 'utf8');
    const canonicalOnly = await tool.execute({
      op: 'composition.approve_plan',
      composition_dir: 'project/composition',
    }, ctx);
    expect(canonicalOnly.isError).toBe(false);
  });

  it('turns an unexpected native-operation rejection into a durable recovery result', async () => {
    const native = await import('../../../../src/main/features/video_studio');
    vi.spyOn(native, 'prepareComposition').mockRejectedValueOnce(new Error('native window closed'));
    const toolMod = await import('../../../../src/main/model/core-agent/video-studio-tool');
    const opts = {
      userId: UID,
      cid: 'cid-native-rejection',
      turnId: 'turn-native-rejection',
      agentId: VIDEO_STUDIO_AGENT_ID,
      agentName: 'VideoStudio',
      userMessage: '确认',
    };
    const tool = toolMod.createVideoStudioTool(opts);
    const ctx = { workingDir: workspace, state: {} } as any;
    expect((await tool.execute({
      op: 'composition.approve_plan',
      composition_dir: 'project/composition',
      decision_evidence: decisionEvidence('plan', 'approve', '确认'),
    }, ctx)).isError).toBe(false);
    expect((await tool.execute({
      op: 'composition.doctor',
      composition_dir: 'project/composition',
    }, ctx)).isError).toBe(false);
    const failed = await tool.execute({
      op: 'composition.prepare',
      composition_dir: 'project/composition',
    }, ctx);
    expect(failed.isError).toBe(true);
    const failedPayload = parseResult(failed.content);
    expect(failedPayload).toMatchObject({
      errorCode: 'E_VIDEO_PRODUCTION_OPERATION_FAILED',
      recovery: ['composition.status', 'composition.reconcile'],
      production_state: {
        last_operation: {
          op: 'composition.prepare',
          status: 'failed',
          error_code: 'E_VIDEO_PRODUCTION_OPERATION_FAILED',
        },
        operation_journal: [expect.objectContaining({
          op: 'composition.prepare',
          status: 'failed',
          input_hash: expect.any(String),
          error_code: 'E_VIDEO_PRODUCTION_OPERATION_FAILED',
        })],
        current_candidate: {
          revision_id: expect.stringMatching(/^candidate-/),
          last_quality_result: {
            ok: false,
            error_code: 'E_VIDEO_PRODUCTION_OPERATION_FAILED',
          },
        },
      },
    });
    expect(failedPayload.production_state.active_operation).toBeUndefined();
  });

  it('blocks repeated snapshot retries until the composition artifact changes', async () => {
    makePlanVisualOnly();
    const videoStudio = await import('../../../../src/main/features/video_studio');
    const toolMod = await import('../../../../src/main/model/core-agent/video-studio-tool');
    const stateMod = await import('../../../../src/main/features/video_studio_state');
    const written: string[] = [];
    const published: string[][] = [];
    const opts = {
      userId: UID,
      cid: 'cid-snapshot-retry',
      turnId: 'turn-preview',
      agentId: VIDEO_STUDIO_AGENT_ID,
      agentName: 'VideoStudio',
      userMessage: '确认',
      onFileWritten: async (filePath: string) => { written.push(filePath); },
      onOutputsPublished: async (filePaths: string[]) => {
        published.push(filePaths);
        return filePaths;
      },
    };
    const statePath = toolMod.videoStudioProductionStatePath(opts, compositionDir);
    const tool = toolMod.createVideoStudioTool(opts);
    expect((await tool.execute({
      op: 'composition.approve_plan',
      composition_dir: 'project/composition',
      decision_evidence: decisionEvidence('plan', 'approve', '确认'),
    }, { workingDir: workspace, state: {} } as any)).isError).toBe(false);
    await stateMod.updateVideoProductionState(statePath, compositionDir, (state) => {
      state.stage = 'visuals_ready';
    });
    const contactSheet = path.join(compositionDir, 'preview-contact-sheet-frames', 'contact-sheet.svg');
    const firstFrame = path.join(compositionDir, 'preview-contact-sheet-frames', '01-first-frame.png');
    const findingsPath = path.join(compositionDir, 'qa', 'snapshot-findings.json');
    fs.mkdirSync(path.dirname(contactSheet), { recursive: true });
    fs.mkdirSync(path.dirname(findingsPath), { recursive: true });
    fs.writeFileSync(contactSheet, '<svg/>');
    fs.writeFileSync(firstFrame, 'frame');
    fs.writeFileSync(findingsPath, JSON.stringify({
      conclusion: 'The cover hierarchy is still unclear.',
      repair_target: 'cover',
    }), 'utf8');
    const snapshot = vi.spyOn(videoStudio, 'snapshotComposition').mockResolvedValue({
      ok: false,
      op: 'composition.snapshot',
      errorCode: 'E_PREVIEW_QA_BLOCKED',
      message: 'Preview frame coverage or scene semantics failed QA.',
      preview_ready: false,
      contact_sheet: contactSheet,
      frame_paths: [firstFrame],
    } as any);

    const ctx = { state: {}, emitProgress: vi.fn() } as any;
    const input = {
      op: 'composition.snapshot',
      composition_dir: 'project/composition',
      output_path: 'project/composition/preview-contact-sheet.mp4',
      findings_path: 'project/composition/qa/snapshot-findings.json',
    };
    const first = await tool.execute(input, ctx);
    expect(first.isError).toBe(true);
    expect(snapshot).toHaveBeenCalledTimes(1);
    expect((snapshot.mock.calls[0]?.[0] as any).snapshotAbsPath).toMatch(/preview-contact-sheet\.png$/);
    const firstPayload = parseResult(first.content);
    expect(firstPayload).toMatchObject({
      current_candidate: {
        revision_id: expect.stringMatching(/^candidate-/),
        locators: {
          html_path: path.join(compositionDir, 'index.html'),
          preview_path: contactSheet,
          frame_paths: [firstFrame],
        },
        last_quality_result: {
          ok: false,
          error_code: 'E_PREVIEW_QA_BLOCKED',
        },
        snapshot: {
          manifest_path: expect.stringMatching(/candidate\.json$/),
          source_file_count: expect.any(Number),
          locators: {
            html_path: expect.stringContaining(path.join('source', 'index.html')),
            preview_path: expect.stringMatching(/contact-sheet-[a-f0-9]{12}\.svg$/),
          },
        },
      },
      review_package: {
        presentation_required: true,
        status: 'current_unapproved',
        conclusion: {
          outcome: 'quality_not_accepted',
          error_code: 'E_PREVIEW_QA_BLOCKED',
        },
        primary_artifact: {
          role: 'preview',
          review_status: 'current_unapproved',
        },
        artifacts: expect.arrayContaining([
          expect.objectContaining({ role: 'preview' }),
          expect.objectContaining({ role: 'findings' }),
        ]),
      },
    });
    const frozenHtmlPath = firstPayload.current_candidate.snapshot.locators.html_path as string;
    const frozenPreviewPath = firstPayload.current_candidate.snapshot.locators.preview_path as string;
    const frozenFindingsPath = firstPayload.current_candidate.snapshot.locators.findings_path as string;
    const frozenHtml = fs.readFileSync(frozenHtmlPath, 'utf8');
    expect(frozenHtmlPath).not.toBe(path.join(compositionDir, 'index.html'));
    expect(fs.readFileSync(frozenPreviewPath, 'utf8')).toBe('<svg/>');
    expect(fs.readFileSync(frozenFindingsPath, 'utf8')).toContain('cover hierarchy');
    expect(written).toEqual(expect.arrayContaining([contactSheet, firstFrame]));
    expect(published).toContainEqual(expect.arrayContaining([
      frozenPreviewPath,
      frozenFindingsPath,
    ]));

    const second = await tool.execute(input, ctx);
    expect(second.isError).toBe(true);
    expect(second.content).toContain('E_SNAPSHOT_RETRY_NO_CHANGE');
    expect(snapshot).toHaveBeenCalledTimes(1);

    fs.appendFileSync(path.join(compositionDir, 'index.html'), '\n<!-- repaired -->\n');
    const third = await tool.execute(input, ctx);
    expect(third.isError).toBe(true);
    expect(snapshot).toHaveBeenCalledTimes(2);
    const thirdPayload = parseResult(third.content);
    expect(thirdPayload.production_state.candidate_history_count).toBeGreaterThan(0);
    expect(thirdPayload.production_state.candidate_history[0]).toMatchObject({
      revision_id: firstPayload.current_candidate.revision_id,
      snapshot: {
        locators: {
          html_path: frozenHtmlPath,
        },
      },
    });
    expect(fs.readFileSync(frozenHtmlPath, 'utf8')).toBe(frozenHtml);
    expect(fs.readFileSync(frozenHtmlPath, 'utf8')).not.toContain('<!-- repaired -->');
    const revisedState = await stateMod.readVideoProductionState(statePath, compositionDir);
    expect(revisedState.candidate_history?.[0]?.snapshot?.locators.html_path).toBe(frozenHtmlPath);

    fs.appendFileSync(path.join(compositionDir, 'index.html'), '\n<!-- repaired again -->\n');
    const fourth = await tool.execute(input, ctx);
    expect(fourth.isError).toBe(true);
    expect(snapshot).toHaveBeenCalledTimes(3);

    fs.appendFileSync(path.join(compositionDir, 'index.html'), '\n<!-- attempted third repair -->\n');
    const exhausted = await tool.execute(input, ctx);
    expect(exhausted.isError).toBe(true);
    expect(exhausted.content).toContain('E_VISUAL_REPAIR_BUDGET_EXCEEDED');
    expect(parseResult(exhausted.content)).toMatchObject({
      recovery_requires_new_user_revision: false,
      requires_user_decision: false,
      next_action: 'composition.begin_visual_revision',
      review_package: {
        presentation_required: true,
        conclusion: {
          outcome: 'quality_not_accepted',
          error_code: 'E_VISUAL_REPAIR_BUDGET_EXCEEDED',
          requires_user_decision: false,
        },
        primary_artifact: {
          role: 'preview',
        },
        artifacts: expect.arrayContaining([
          expect.objectContaining({ role: 'findings' }),
        ]),
      },
    });
    expect(parseResult(exhausted.content)).not.toHaveProperty('recovery_form');
    expect(snapshot).toHaveBeenCalledTimes(3);

    const repeatedExhausted = await tool.execute(input, ctx);
    expect(repeatedExhausted.isError).toBe(true);
    expect(parseResult(repeatedExhausted.content)).toMatchObject({
      errorCode: 'E_VISUAL_REPAIR_BUDGET_EXCEEDED',
      requires_user_decision: false,
      next_action: 'composition.begin_visual_revision',
    });
    expect(snapshot).toHaveBeenCalledTimes(3);
  });

  it('recaptures a legacy passed preview once when it has no revision id', async () => {
    makePlanVisualOnly();
    const videoStudio = await import('../../../../src/main/features/video_studio');
    const toolMod = await import('../../../../src/main/model/core-agent/video-studio-tool');
    const stateMod = await import('../../../../src/main/features/video_studio_state');
    const opts = {
      userId: UID,
      cid: 'cid-legacy-preview-revision',
      turnId: 'turn-preview-revision',
      agentId: VIDEO_STUDIO_AGENT_ID,
      agentName: 'VideoStudio',
      userMessage: '确认',
    };
    const statePath = toolMod.videoStudioProductionStatePath(opts, compositionDir);
    const tool = toolMod.createVideoStudioTool(opts);
    const ctx = { workingDir: workspace, state: {}, emitProgress: vi.fn() } as any;
    expect((await tool.execute({
      op: 'composition.approve_plan',
      composition_dir: 'project/composition',
      decision_evidence: decisionEvidence('plan', 'approve', '确认'),
    }, ctx)).isError).toBe(false);
    await stateMod.updateVideoProductionState(statePath, compositionDir, (state) => {
      state.stage = 'visuals_ready';
    });
    const legacyContactSheet = path.join(compositionDir, 'preview-contact-sheet-frames', 'contact-sheet.svg');
    const revisedContactSheet = path.join(compositionDir, 'preview-contact-sheet-frames', 'revision-2', 'contact-sheet.svg');
    const passingPreview = (contactSheet: string, revision?: string) => ({
      ok: true,
      op: 'composition.snapshot',
      path: contactSheet,
      contact_sheet: contactSheet,
      preview_ready: true,
      preview_qa: { ok: true, error_count: 0 },
      preflight: { status: 'passed', blocking_error_count: 0 },
      ...(revision ? { preview_revision: revision } : {}),
    });
    const snapshot = vi.spyOn(videoStudio, 'snapshotComposition')
      .mockResolvedValueOnce(passingPreview(legacyContactSheet) as any)
      .mockResolvedValueOnce(passingPreview(revisedContactSheet, 'revision-2') as any);
    const input = {
      op: 'composition.snapshot',
      composition_dir: 'project/composition',
      output_path: 'project/composition/preview-contact-sheet.png',
    };

    expect((await tool.execute(input, ctx)).isError).toBe(false);
    const legacyState = await stateMod.readVideoProductionState(statePath, compositionDir);
    expect(legacyState.preview?.revision_id).toBeUndefined();

    const migrated = await tool.execute(input, ctx);
    expect(migrated.isError).toBe(false);
    expect(parseResult(migrated.content)).not.toMatchObject({ reused_result: true });
    expect(snapshot).toHaveBeenCalledTimes(2);
    const migratedState = await stateMod.readVideoProductionState(statePath, compositionDir);
    expect(migratedState.preview).toMatchObject({
      revision_id: 'revision-2',
      path: revisedContactSheet,
    });
  });

  it('blocks repeated inspect retries until visual inputs change', async () => {
    makePlanVisualOnly();
    const videoStudio = await import('../../../../src/main/features/video_studio');
    const toolMod = await import('../../../../src/main/model/core-agent/video-studio-tool');
    const stateMod = await import('../../../../src/main/features/video_studio_state');
    const opts = {
      userId: UID,
      cid: 'cid-inspect-retry',
      turnId: 'turn-inspect',
      agentId: VIDEO_STUDIO_AGENT_ID,
      agentName: 'VideoStudio',
      userMessage: '确认',
    };
    const statePath = toolMod.videoStudioProductionStatePath(opts, compositionDir);
    const tool = toolMod.createVideoStudioTool(opts);
    expect((await tool.execute({
      op: 'composition.approve_plan',
      composition_dir: 'project/composition',
      decision_evidence: decisionEvidence('plan', 'approve', '确认'),
    }, { workingDir: workspace, state: {} } as any)).isError).toBe(false);
    await stateMod.updateVideoProductionState(statePath, compositionDir, (state) => {
      state.stage = 'visuals_ready';
    });
    const inspect = vi.spyOn(videoStudio, 'inspectComposition')
      .mockResolvedValueOnce({
        ok: false,
        op: 'composition.inspect',
        errorCode: 'E_INSPECT_BLOCKED',
        message: 'Text overflow.',
        findings: JSON.stringify({ issues: [{ code: 'TEXT_OVERFLOW', severity: 'error' }] }),
      } as any)
      .mockResolvedValue({
        ok: true,
        op: 'composition.inspect',
        status: 'passed',
        blocking_error_count: 0,
        findings: JSON.stringify({ issues: [] }),
      } as any);
    const ctx = { state: {}, emitProgress: vi.fn() } as any;
    const input = {
      op: 'composition.inspect',
      composition_dir: 'project/composition',
      findings_path: 'project/composition/qa/inspect.json',
    };

    expect((await tool.execute(input, ctx)).isError).toBe(true);
    const repeated = await tool.execute(input, ctx);
    expect(repeated.isError).toBe(true);
    expect(repeated.content).toContain('E_INSPECT_RETRY_NO_CHANGE');
    expect(inspect).toHaveBeenCalledTimes(1);

    fs.appendFileSync(path.join(compositionDir, 'index.html'), '\n<!-- repaired -->\n');
    expect((await tool.execute(input, ctx)).isError).toBe(false);
    expect(inspect).toHaveBeenCalledTimes(2);
    const alreadyPassed = await tool.execute(input, ctx);
    expect(alreadyPassed.isError).toBe(false);
    expect(parseResult(alreadyPassed.content)).toMatchObject({
      ok: true,
      status: 'already_passed',
      reused_result: true,
      next_action: 'composition.snapshot',
    });
    expect(inspect).toHaveBeenCalledTimes(2);
  });

  it('shares one repair cycle across inspect and snapshot', async () => {
    makePlanVisualOnly();
    const videoStudio = await import('../../../../src/main/features/video_studio');
    const toolMod = await import('../../../../src/main/model/core-agent/video-studio-tool');
    const stateMod = await import('../../../../src/main/features/video_studio_state');
    const opts = {
      userId: UID,
      cid: 'cid-shared-visual-cycle',
      turnId: 'turn-shared-cycle',
      agentId: VIDEO_STUDIO_AGENT_ID,
      agentName: 'VideoStudio',
      userMessage: '确认',
    };
    const statePath = toolMod.videoStudioProductionStatePath(opts, compositionDir);
    const tool = toolMod.createVideoStudioTool(opts);
    const ctx = { workingDir: workspace, state: {}, emitProgress: vi.fn() } as any;
    expect((await tool.execute({
      op: 'composition.approve_plan', composition_dir: 'project/composition',
      decision_evidence: decisionEvidence('plan', 'approve', '确认'),
    }, ctx)).isError).toBe(false);
    await stateMod.updateVideoProductionState(statePath, compositionDir, (state) => {
      state.stage = 'visuals_ready';
    });
    const inspect = vi.spyOn(videoStudio, 'inspectComposition').mockResolvedValue({
      ok: false, op: 'composition.inspect', errorCode: 'E_INSPECT_BLOCKED', message: 'overflow',
    } as any);
    const snapshot = vi.spyOn(videoStudio, 'snapshotComposition').mockResolvedValue({
      ok: false, op: 'composition.snapshot', errorCode: 'E_PREVIEW_QA_BLOCKED', message: 'preview',
    } as any);

    expect((await tool.execute({ op: 'composition.inspect', composition_dir: 'project/composition' }, ctx)).isError).toBe(true);
    fs.appendFileSync(path.join(compositionDir, 'index.html'), '\n<!-- repair one -->');
    expect((await tool.execute({
      op: 'composition.snapshot', composition_dir: 'project/composition', output_path: 'project/composition/preview.png',
    }, ctx)).isError).toBe(true);
    fs.appendFileSync(path.join(compositionDir, 'index.html'), '\n<!-- repair two -->');
    expect((await tool.execute({ op: 'composition.inspect', composition_dir: 'project/composition' }, ctx)).isError).toBe(true);
    fs.appendFileSync(path.join(compositionDir, 'index.html'), '\n<!-- attempted repair three -->');
    const exhausted = await tool.execute({
      op: 'composition.snapshot', composition_dir: 'project/composition', output_path: 'project/composition/preview.png',
    }, ctx);

    expect(exhausted.isError).toBe(true);
    expect(exhausted.content).toContain('E_VISUAL_REPAIR_BUDGET_EXCEEDED');
    expect(parseResult(exhausted.content)).toMatchObject({
      visual_revision_recovery_available: true,
      recovery_action: 'composition.begin_visual_revision',
      recovery_requires_new_user_revision: false,
      requires_user_decision: false,
      next_action: 'composition.begin_visual_revision',
    });
    expect(parseResult(exhausted.content)).not.toHaveProperty('recovery_form');
    expect(inspect).toHaveBeenCalledTimes(2);
    expect(snapshot).toHaveBeenCalledTimes(1);
    const state = await stateMod.readVideoProductionState(statePath, compositionDir);
    expect(state.visual_qa?.cycle).toMatchObject({
      inspector_version: 3,
      status: 'exhausted',
      failed_signatures: expect.any(Array),
    });
    expect(state.visual_qa?.cycle?.failed_signatures).toHaveLength(3);
  });

  it('invalidates an exhausted legacy cycle when the inspector version changes', async () => {
    makePlanVisualOnly();
    const videoStudio = await import('../../../../src/main/features/video_studio');
    const toolMod = await import('../../../../src/main/model/core-agent/video-studio-tool');
    const stateMod = await import('../../../../src/main/features/video_studio_state');
    const opts = {
      userId: UID, cid: 'cid-inspector-migration', turnId: 'turn-inspector-migration',
      agentId: VIDEO_STUDIO_AGENT_ID, agentName: 'VideoStudio', userMessage: '确认',
    };
    const statePath = toolMod.videoStudioProductionStatePath(opts, compositionDir);
    const tool = toolMod.createVideoStudioTool(opts);
    const ctx = { workingDir: workspace, state: {}, emitProgress: vi.fn() } as any;
    expect((await tool.execute({
      op: 'composition.approve_plan',
      composition_dir: 'project/composition',
      decision_evidence: decisionEvidence('plan', 'approve', '确认'),
    }, ctx)).isError).toBe(false);
    await stateMod.updateVideoProductionState(statePath, compositionDir, (state) => {
      state.stage = 'visuals_ready';
      state.visual_qa = {
        inspect: {
          status: 'failed', max_repair_passes: 2,
          failed_signatures: ['legacy-1', 'legacy-2', 'legacy-3'],
          last_signature: 'legacy-3', last_error_code: 'E_INSPECT_BLOCKED',
          updated_at: new Date().toISOString(),
        },
      };
    });
    const status = await tool.execute({ op: 'composition.status', composition_dir: 'project/composition' }, ctx);
    expect(parseResult(status.content).visual_qa_cycle_stale).toBe(true);
    const inspect = vi.spyOn(videoStudio, 'inspectComposition').mockResolvedValue({
      ok: true, op: 'composition.inspect', status: 'passed', blocking_error_count: 0,
      findings: JSON.stringify({ issues: [] }),
    } as any);

    const checked = await tool.execute({ op: 'composition.inspect', composition_dir: 'project/composition' }, ctx);
    expect(checked.isError).toBe(false);
    expect(inspect).toHaveBeenCalledTimes(1);
    const migrated = await stateMod.readVideoProductionState(statePath, compositionDir);
    expect(migrated.visual_qa?.cycle).toMatchObject({ inspector_version: 3, failed_signatures: [] });
    expect(migrated.visual_qa?.history?.[0]).toMatchObject({ inspector_version: 1, status: 'exhausted' });
  });

  it('starts fresh QA from an approved Gate B amendment without visual recovery', async () => {
    makePlanVisualOnly();
    const toolMod = await import('../../../../src/main/model/core-agent/video-studio-tool');
    const stateMod = await import('../../../../src/main/features/video_studio_state');
    const initialOpts = {
      userId: UID,
      cid: 'cid-gate-b-amendment-fresh-qa',
      turnId: 'turn-initial-plan',
      agentId: VIDEO_STUDIO_AGENT_ID,
      agentName: 'VideoStudio',
      userMessage: approvalSubmission('gate_b_decision', 'approve'),
    };
    const statePath = toolMod.videoStudioProductionStatePath(initialOpts, compositionDir);
    const ctx = { workingDir: workspace, state: {}, emitProgress: vi.fn() } as any;
    expect((await toolMod.createVideoStudioTool(initialOpts).execute({
      op: 'composition.approve_plan',
      composition_dir: 'project/composition',
    }, ctx)).isError).toBe(false);
    await stateMod.updateVideoProductionState(statePath, compositionDir, (state) => {
      state.stage = 'preview_ready';
      state.visual_qa = {
        cycle: {
          inspector_version: 3,
          cycle_id: 'old-passed-cycle',
          visual_revision: 1,
          status: 'passed',
          max_repair_passes: 2,
          failed_signatures: ['old-failed-signature'],
          passed_signatures: { inspect: 'old-signature', snapshot: 'old-signature' },
          last_signature: 'old-signature',
          started_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        },
      };
    });

    const amendmentOpts = {
      ...initialOpts,
      turnId: 'turn-amendment-approval',
      userMessage: approvalSubmission('gate_b_decision', 'approve'),
    };
    const amendmentTool = toolMod.createVideoStudioTool(amendmentOpts);
    const unapplied = await amendmentTool.execute({
      op: 'composition.approve_plan',
      composition_dir: 'project/composition',
      expected_plan_change: true,
    }, ctx);
    expect(unapplied.isError).toBe(true);
    const unappliedResult = parseResult(unapplied.content);
    expect(unappliedResult).toMatchObject({
      errorCode: 'E_GATE_B_AMENDMENT_NOT_APPLIED',
      expected_plan_change: true,
      plan_changed: false,
      visual_revision_recovery_available: false,
      next_action: 'apply_approved_amendment_then_composition.approve_plan',
    });
    expect(unappliedResult).not.toHaveProperty('recovery_form');

    const manifestPath = path.join(compositionDir, 'composition-manifest.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    manifest.scenes[0].approved_copy = ['Approved amended cover'];
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');
    fs.writeFileSync(path.join(workspace, 'project', 'script.md'), '# Approved amended script\n\nSpeak once.', 'utf8');

    const approved = await amendmentTool.execute({
      op: 'composition.approve_plan',
      composition_dir: 'project/composition',
      expected_plan_change: true,
    }, ctx);
    expect(approved.isError).toBe(false);
    expect(parseResult(approved.content)).toMatchObject({
      status: 'approved',
      plan_changed: true,
      visual_qa_reset: true,
      next_action: 'composition.doctor',
    });

    const amendedState = await stateMod.readVideoProductionState(statePath, compositionDir);
    expect(amendedState.stage).toBe('manifest_ready');
    expect(amendedState.visual_qa).toBeUndefined();

    // Reproduce the erroneous final call from the real six-minute trace. A
    // non-exhausted/new plan must correct control flow, never mint a form.
    const unnecessaryReset = await toolMod.createVideoStudioTool({
      ...amendmentOpts,
      turnId: 'turn-preview-revise-after-amendment',
      userMessage: approvalSubmission('preview_decision', 'revise'),
    }).execute({
      op: 'composition.begin_visual_revision',
      composition_dir: 'project/composition',
    }, ctx);
    expect(unnecessaryReset.isError).toBe(true);
    const unnecessaryResetResult = parseResult(unnecessaryReset.content);
    expect(unnecessaryResetResult).toMatchObject({
      errorCode: 'E_VISUAL_REVISION_NOT_REQUIRED',
      visual_revision_recovery_available: false,
      next_action: 'continue_current_cycle_without_recovery',
    });
    expect(unnecessaryResetResult).not.toHaveProperty('recovery_form');

    const misroutedGateBReset = await amendmentTool.execute({
      op: 'composition.begin_visual_revision',
      composition_dir: 'project/composition',
    }, ctx);
    expect(misroutedGateBReset.isError).toBe(true);
    expect(parseResult(misroutedGateBReset.content)).toMatchObject({
      errorCode: 'E_GATE_B_APPROVE_PLAN_REQUIRED',
      expected_plan_change: true,
      visual_revision_recovery_available: false,
      next_action: 'apply_approved_amendment_then_composition.approve_plan',
    });
    expect(parseResult(misroutedGateBReset.content)).not.toHaveProperty('recovery_form');
  });

  it('starts an internal visual revision from exhausted QA evidence while preserving plan and narration', async () => {
    const narration = materializeNarrationFixture();
    const videoStudio = await import('../../../../src/main/features/video_studio');
    const toolMod = await import('../../../../src/main/model/core-agent/video-studio-tool');
    const stateMod = await import('../../../../src/main/features/video_studio_state');
    const baseOpts = {
      userId: UID,
      cid: 'cid-visual-revision',
      turnId: 'turn-plan',
      agentId: VIDEO_STUDIO_AGENT_ID,
      agentName: 'VideoStudio',
      userMessage: approvalSubmission('gate_b_decision', 'approve'),
    };
    const statePath = toolMod.videoStudioProductionStatePath(baseOpts, compositionDir);
    const ctx = { workingDir: workspace, state: {}, emitProgress: vi.fn() } as any;
    expect((await toolMod.createVideoStudioTool(baseOpts).execute({
      op: 'composition.approve_plan',
      composition_dir: 'project/composition',
    }, ctx)).isError).toBe(false);
    await stateMod.updateVideoProductionState(statePath, compositionDir, (state) => {
      state.stage = 'visuals_ready';
      state.narration = {
        status: 'materialized',
        text_sha256: narration.textSha256,
        audio_sha256: narration.audioSha256,
        path: path.join(compositionDir, 'assets', 'narration.mp3'),
        measured_duration_sec: narration.durationSec,
        backend: 'mock-voice',
        speed: 1,
        materialized_at: new Date().toISOString(),
      };
      state.visual_qa = {
        inspect: {
          status: 'failed',
          max_repair_passes: 2,
          failed_signatures: ['first', 'repair-1', 'repair-2'],
          last_signature: 'repair-2',
          last_error_code: 'E_INSPECT_BLOCKED',
          updated_at: new Date().toISOString(),
        },
      };
    });
    const before = await stateMod.readVideoProductionState(statePath, compositionDir);
    const approvalSignature = before.plan_approval?.signature;

    const internalRecoveryOpts = {
      ...baseOpts,
      turnId: 'turn-unrelated',
      userMessage: '<msg from="agent">@VideoStudio Continue recovery from the recorded QA evidence.</msg>',
    };
    const internalRecoveryTool = toolMod.createVideoStudioTool(internalRecoveryOpts);
    const started = await internalRecoveryTool.execute({
      op: 'composition.begin_visual_revision',
      composition_dir: 'project/composition',
    }, ctx);
    expect(started.isError).toBe(false);
    expect(parseResult(started.content)).toMatchObject({
      status: 'started',
      visual_revision: 1,
      inspector_version: 3,
      recovery_started_automatically: true,
      requires_user_decision: false,
      next_action: 'composition.lint',
    });

    const repeated = await internalRecoveryTool.execute({
      op: 'composition.begin_visual_revision',
      composition_dir: 'project/composition',
    }, ctx);
    expect(repeated.isError).toBe(false);
    expect(parseResult(repeated.content)).toMatchObject({
      status: 'already_started',
      next_action: 'composition.lint',
    });

    const revised = await stateMod.readVideoProductionState(statePath, compositionDir);
    expect(revised.revision).toBeGreaterThan(before.revision);
    expect(revised.stage).toBe('visuals_ready');
    expect(revised.plan_approval?.signature).toBe(approvalSignature);
    expect(revised.narration).toMatchObject({
      text_sha256: narration.textSha256,
      audio_sha256: narration.audioSha256,
    });
    expect(revised.visual_qa?.cycle).toMatchObject({
      inspector_version: 3,
      visual_revision: 1,
      status: 'active',
      failed_signatures: [],
      started_by_turn_id: 'turn-unrelated',
    });
    expect(revised.visual_qa?.history?.[0]).toMatchObject({
      inspector_version: 1,
      status: 'exhausted',
      failed_signatures: ['first', 'repair-1', 'repair-2'],
    });

    const inspect = vi.spyOn(videoStudio, 'inspectComposition').mockResolvedValue({
      ok: true,
      op: 'composition.inspect',
      status: 'passed',
      blocking_error_count: 0,
      findings: JSON.stringify({ issues: [] }),
    } as any);
    const checked = await internalRecoveryTool.execute({
      op: 'composition.inspect',
      composition_dir: 'project/composition',
    }, ctx);
    expect(checked.isError).toBe(false);
    expect(inspect).toHaveBeenCalledTimes(1);
  });

  it('blocks only unchanged full-render retries and allows rendering after canonical inputs change', async () => {
    makePlanVisualOnly();
    const videoStudio = await import('../../../../src/main/features/video_studio');
    const toolMod = await import('../../../../src/main/model/core-agent/video-studio-tool');
    const published: string[][] = [];
    const opts = {
      userId: UID,
      cid: 'cid-render-signature-retry',
      turnId: 'turn-render-retry',
      agentId: VIDEO_STUDIO_AGENT_ID,
      agentName: 'VideoStudio',
      userMessage: '确认',
      onFileWritten: async () => {},
      onOutputsPublished: async (paths: string[]) => {
        published.push(paths);
        return paths;
      },
    };
    const tool = toolMod.createVideoStudioTool(opts);
    const ctx = { workingDir: workspace, state: {}, emitProgress: vi.fn() } as any;
    expect((await tool.execute({
      op: 'composition.approve_plan',
      composition_dir: 'project/composition',
      decision_evidence: decisionEvidence('plan', 'approve', '确认'),
    }, ctx)).isError).toBe(false);
    const failedDraftPath = path.join(workspace, 'project', 'render', 'draft.mp4');
    const draftContactSheet = path.join(workspace, 'project', 'render', 'draft-evidence', 'contact-sheet.svg');
    const draft = vi.spyOn(videoStudio, 'draftComposition').mockImplementation(async (options: any) => {
      fs.mkdirSync(path.dirname(draftContactSheet), { recursive: true });
      fs.writeFileSync(options.outputAbsPath, 'reviewable failed draft');
      fs.writeFileSync(draftContactSheet, '<svg/>');
      return {
        ok: false,
        op: 'composition.draft',
        errorCode: 'E_VIDEO_QA_BLOCKED',
        message: 'frozen frames',
        path: options.outputAbsPath,
        contact_sheet: draftContactSheet,
        draft_ready: false,
        report: { steps: { render: { status: 'passed' }, video_qa: { status: 'failed' } } },
      } as any;
    });
    const input = {
      op: 'composition.draft',
      composition_dir: 'project/composition',
      output_path: 'project/render/draft.mp4',
    };

    const firstFailedDraft = await tool.execute(input, ctx);
    expect(firstFailedDraft.isError).toBe(true);
    const firstFailedDraftPayload = parseResult(firstFailedDraft.content);
    expect(firstFailedDraftPayload).toMatchObject({
      current_candidate: {
        locators: {
          draft_path: failedDraftPath,
          preview_path: draftContactSheet,
        },
        last_quality_result: {
          ok: false,
          error_code: 'E_VIDEO_QA_BLOCKED',
        },
        snapshot: {
          locators: {
            draft_path: expect.stringMatching(/draft-[a-f0-9]{12}\.mp4$/),
          },
        },
      },
    });
    const frozenDraftPath = firstFailedDraftPayload.current_candidate.snapshot.locators.draft_path as string;
    expect(frozenDraftPath).not.toBe(failedDraftPath);
    expect(fs.readFileSync(frozenDraftPath, 'utf8')).toBe('reviewable failed draft');
    expect(published).toContainEqual([frozenDraftPath]);
    expect((await tool.execute(input, {
      workingDir: workspace,
      state: {},
      emitProgress: vi.fn(),
    } as any)).isError).toBe(true);
    const resumedTool = toolMod.createVideoStudioTool(opts);
    const unchanged = await resumedTool.execute(input, {
      workingDir: workspace,
      state: {},
      emitProgress: vi.fn(),
    } as any);
    expect(unchanged.isError).toBe(true);
    expect(parseResult(unchanged.content)).toMatchObject({
      errorCode: 'E_FULL_RENDER_RETRY_NO_CHANGE',
      same_input_retry_allowed: false,
      requires_user_decision: false,
      next_action: 'repair_inputs_then_retry_render',
      operation_journal_evidence: {
        same_input_attempts: 2,
        durable: true,
      },
    });
    expect(draft).toHaveBeenCalledTimes(2);

    fs.appendFileSync(path.join(compositionDir, 'index.html'), '\n<!-- materially different repair -->\n');
    const afterEdit = await tool.execute(input, ctx);
    expect(afterEdit.isError).toBe(true);
    expect(parseResult(afterEdit.content).errorCode).toBe('E_VIDEO_QA_BLOCKED');
    expect(draft).toHaveBeenCalledTimes(3);
  });

  it('registers and publishes an approved export after rendering', async () => {
    const videoStudio = await import('../../../../src/main/features/video_studio');
    makePlanVisualOnly();
    const events: string[] = [];
    const finalPath = path.join(workspace, 'project', 'render', 'final.mp4');
    const draftPath = path.join(workspace, 'project', 'render', 'draft.mp4');
    fs.mkdirSync(path.dirname(finalPath), { recursive: true });
    fs.writeFileSync(draftPath, 'approved draft');

    vi.spyOn(videoStudio, 'draftComposition').mockImplementation(async (options: any) => {
      events.push('render');
      expect(options.fps).toBe(30);
      expect(options.allowFpsFallback).toBe(true);
      fs.writeFileSync(options.outputAbsPath, 'clean final');
      return {
        ok: true,
        op: 'composition.draft',
        path: options.outputAbsPath,
        draft_ready: true,
        report: { steps: { render: { status: 'passed' } } },
      } as any;
    });

    const toolMod = await import('../../../../src/main/model/core-agent/video-studio-tool');
    const opts = {
      userId: UID,
      cid: 'cid-export-order',
      turnId: 'turn-export',
      agentId: VIDEO_STUDIO_AGENT_ID,
      agentName: 'VideoStudio',
      userMessage: '确认',
      onFileWritten: async () => { events.push('written'); },
      onOutputsPublished: async (paths: string[]) => {
        events.push('published');
        return paths;
      },
    };
    const statePath = toolMod.videoStudioProductionStatePath(opts, compositionDir);
    const tool = toolMod.createVideoStudioTool(opts);
    const recoveryTool = toolMod.createVideoStudioTool({
      userId: opts.userId,
      cid: opts.cid,
      turnId: opts.turnId,
      agentId: opts.agentId,
      agentName: opts.agentName,
      userMessage: opts.userMessage,
    });
    expect((await tool.execute({
      op: 'composition.approve_plan',
      composition_dir: 'project/composition',
      decision_evidence: decisionEvidence('plan', 'approve', '确认'),
    }, { workingDir: workspace, state: {} } as any)).isError).toBe(false);
    expect((await recoveryTool.execute({
      op: 'composition.reconcile',
      composition_dir: 'project/composition',
    }, { workingDir: workspace, state: {} } as any)).isError).toBe(false);
    expect(await toolMod.recordVideoStudioGate(
      statePath,
      'draft',
      compositionDir,
      'turn-draft',
      { draft_ready: true, path: draftPath, design_review_required: true },
    )).toBe(true);
    expect((await toolMod.approveVideoStudioGate(
      statePath,
      'draft',
      compositionDir,
      'turn-approve',
      true,
    ))).toMatchObject({ ok: false, errorCode: 'E_DESIGN_REVIEW_REQUIRED' });
    const review = await tool.execute({
      op: 'composition.submit_design_review',
      composition_dir: 'project/composition',
      review_verdict: 'passed',
      review_scope: 'draft contact sheet plus scene midpoint and payoff frames',
      review_findings: [],
      quality_scores: passingDesignScores,
    }, { workingDir: workspace, state: {} } as any);
    expect(review.isError, JSON.stringify(parseResult(review.content))).toBe(false);
    expect(parseResult(review.content)).toMatchObject({ gate_d_ready: true });
    fs.writeFileSync(path.join(compositionDir, 'draft.mp4'), 'runtime draft');
    fs.writeFileSync(path.join(compositionDir, 'draft-qa-report.json'), '{}');
    fs.writeFileSync(path.join(compositionDir, 'draft-findings.json'), '{}');
    fs.writeFileSync(path.join(compositionDir, 'final-qa-report.json'), '{}');
    fs.mkdirSync(path.join(compositionDir, 'contact-sheet-frames'), { recursive: true });
    fs.writeFileSync(path.join(compositionDir, 'contact-sheet-frames', 'contact-sheet.svg'), '<svg/>');
    fs.writeFileSync(path.join(compositionDir, 'contact-sheet.png'), 'runtime preview');
    fs.mkdirSync(path.join(compositionDir, 'preview-contact-sheet-frames'), { recursive: true });
    fs.writeFileSync(path.join(compositionDir, 'preview-contact-sheet-frames', '01-first-frame.png'), 'frame');
    fs.writeFileSync(path.join(compositionDir, 'preview-contact-sheet.png'), 'runtime preview');
    fs.mkdirSync(path.join(compositionDir, 'assets', 'narration-history'), { recursive: true });
    fs.writeFileSync(path.join(compositionDir, 'assets', 'narration-history', 'prior.mp3'), 'history');
    expect((await toolMod.approveVideoStudioGate(
      statePath,
      'draft',
      compositionDir,
      'turn-approve',
      true,
    )).ok).toBe(true);
    expect((await toolMod.validateVideoStudioGate(
      statePath,
      'draft',
      compositionDir,
      'turn-export',
    )).ok).toBe(true);

    const reconciled = await recoveryTool.execute({
      op: 'composition.reconcile',
      composition_dir: 'project/composition',
    }, { workingDir: workspace, state: {} } as any);
    expect(reconciled.isError).toBe(false);
    expect(parseResult(reconciled.content)).toMatchObject({
      changed: false,
      production_state: { stage: 'draft_approved', draft_status: 'approved' },
    });

    const result = await tool.execute({
      op: 'composition.export',
      composition_dir: 'project/composition',
      output_path: 'project/render/final.mp4',
    }, { workingDir: workspace, state: {} } as any);

    expect(result.isError).toBe(false);
    expect(fs.readFileSync(finalPath, 'utf8')).toBe('clean final');
    expect(events).toEqual(['render', 'written', 'published']);
  });

  it('enforces Gate B and prevents authored visuals from bypassing pending narration', async () => {
    const mod = await import('../../../../src/main/model/core-agent/video-studio-tool');
    const stateMod = await import('../../../../src/main/features/video_studio_state');
    const tool = mod.createVideoStudioTool({
      userId: UID,
      turnId: 'turn-approve',
      agentId: VIDEO_STUDIO_AGENT_ID,
      agentName: 'VideoStudio',
      userMessage: approvalSubmission('gate_b_decision', 'approve'),
    });
    const ctx = { workingDir: workspace, state: {} } as any;

    const blockedPlan = await tool.execute({
      op: 'composition.prepare',
      composition_dir: 'project/composition',
    }, ctx);
    expect(blockedPlan.isError).toBe(true);
    expect(blockedPlan.content).toContain('E_GATE_B_APPROVAL_REQUIRED');

    const rejectingTool = mod.createVideoStudioTool({
      userId: UID,
      turnId: 'turn-revise',
      userMessage: approvalSubmission('gate_b_decision', 'revise', VIDEO_STUDIO_AGENT_ID, {
        adjustments: 'Please adjust the captions first.',
      }),
      agentId: VIDEO_STUDIO_AGENT_ID,
      agentName: 'VideoStudio',
    });
    const rejectedApproval = await rejectingTool.execute({
      op: 'composition.approve_plan',
      composition_dir: 'project/composition',
    }, ctx);
    expect(rejectedApproval.isError).toBe(true);
    expect(rejectedApproval.content).toContain('E_GATE_B_EXPLICIT_APPROVAL_REQUIRED');

    const approved = await tool.execute({
      op: 'composition.approve_plan',
      composition_dir: 'project/composition',
      decision_evidence: decisionEvidence('plan', 'approve', '确认'),
    }, ctx);
    expect(approved.isError).toBe(false);
    expect(parseResult(approved.content).production_state).toMatchObject({ stage: 'manifest_ready' });

    const prepared = await tool.execute({
      op: 'composition.prepare',
      composition_dir: 'project/composition',
    }, ctx);
    expect(prepared.isError).toBe(false);
    const preparedResult = parseResult(prepared.content);
    expect(preparedResult.production_state).toMatchObject({
      stage: 'scaffold_ready',
      capability_check: { status: 'ready' },
      next_allowed_ops: expect.arrayContaining(['composition.materialize_narration']),
    });
    expect(preparedResult.next_allowed_ops).toEqual(preparedResult.production_state.next_allowed_ops);
    expect(preparedResult.next_allowed_ops).toEqual(expect.arrayContaining([
      'composition.materialize_narration',
      'composition.lint',
      'composition.inspect',
      'composition.snapshot',
    ]));
    const statePath = mod.videoStudioProductionStatePath({
      userId: UID,
      turnId: 'turn-approve',
      agentId: VIDEO_STUDIO_AGENT_ID,
      agentName: 'VideoStudio',
      userMessage: approvalSubmission('gate_b_decision', 'approve'),
    }, compositionDir);
    const now = new Date().toISOString();
    await stateMod.updateVideoProductionState(statePath, compositionDir, (state) => {
      state.visual_qa = {
        cycle: {
          inspector_version: 3,
          cycle_id: 'visual-cycle-before-narration-recovery',
          visual_revision: 0,
          status: 'active',
          max_repair_passes: 2,
          failed_signatures: ['visual-finding-1'],
          passed_signatures: {},
          last_signature: 'visual-finding-1',
          last_error_code: 'E_PREVIEW_QA_BLOCKED',
          started_at: now,
          updated_at: now,
        },
      };
    });

    const blockedDraft = await tool.execute({
      op: 'composition.draft',
      composition_dir: 'project/composition',
      output_path: 'project/render/draft.mp4',
    }, ctx);
    expect(blockedDraft.isError).toBe(true);
    expect(parseResult(blockedDraft.content)).toMatchObject({
      errorCode: 'E_NARRATION_MATERIALIZATION_REQUIRED',
      current_candidate: {
        revision_id: expect.stringMatching(/^candidate-/),
        locators: {
          html_path: path.join(compositionDir, 'index.html'),
        },
        snapshot: {
          manifest_path: expect.any(String),
        },
      },
      production_state: {
        next_allowed_ops: expect.arrayContaining([
          'composition.materialize_narration',
          'composition.snapshot',
        ]),
      },
    });
    expect((await stateMod.readVideoProductionState(statePath, compositionDir)).visual_qa?.cycle)
      .toMatchObject({
        cycle_id: 'visual-cycle-before-narration-recovery',
        failed_signatures: ['visual-finding-1'],
      });

    const htmlPath = path.join(compositionDir, 'index.html');
    fs.appendFileSync(htmlPath, '\n<!-- authored visual change -->\n', 'utf8');
    const status = parseResult((await tool.execute({
      op: 'composition.status',
      composition_dir: 'project/composition',
    }, ctx)).content);
    expect(status).toMatchObject({ artifact_drift: true, reconciliation_required: true });

    const reconciled = await tool.execute({
      op: 'composition.reconcile',
      composition_dir: 'project/composition',
    }, ctx);
    expect(reconciled.isError).toBe(false);
    expect(parseResult(reconciled.content).production_state).toMatchObject({
      stage: 'scaffold_ready',
      next_allowed_ops: expect.arrayContaining([
        'composition.materialize_narration',
        'composition.snapshot',
      ]),
    });
    expect(parseResult(reconciled.content).production_state.next_allowed_ops).not.toContain('composition.draft');

    await stateMod.updateVideoProductionState(statePath, compositionDir, (state) => {
      // Reproduce the late stage recorded in the production trace. The
      // current-fact admission must ignore this compatibility value.
      state.stage = 'draft_ready';
    });
    ttsMock.generateSpeech.mockImplementation(async ({ outputAbsPath }: { outputAbsPath: string }) => {
      fs.mkdirSync(path.dirname(outputAbsPath), { recursive: true });
      const audio = Buffer.from('late materialized narration');
      fs.writeFileSync(outputAbsPath, audio);
      return { ok: true, bytes: audio.byteLength };
    });
    const materialized = await tool.execute({
      op: 'composition.materialize_narration',
      composition_dir: 'project/composition',
    }, ctx);
    expect(materialized.isError).toBe(false);
    expect(parseResult(materialized.content)).toMatchObject({
      status: 'passed',
      visuals_preserved: true,
      billable_request_sent: true,
    });
    expect(ttsMock.generateSpeech).toHaveBeenCalledTimes(1);
    expect(fs.readFileSync(htmlPath, 'utf8')).toContain('authored visual change');
    expect(fs.existsSync(path.join(compositionDir, 'assets', 'narration.mp3'))).toBe(true);
    expect(fs.existsSync(path.join(compositionDir, 'narration-map.json'))).toBe(true);
  });

  it('preserves the Gate B record through transient plan drift and revalidates it after revert', async () => {
    makePlanVisualOnly();
    const toolMod = await import('../../../../src/main/model/core-agent/video-studio-tool');
    const stateMod = await import('../../../../src/main/features/video_studio_state');
    const opts = {
      userId: UID,
      cid: 'cid-transient-plan-drift',
      turnId: 'turn-plan-approved',
      agentId: VIDEO_STUDIO_AGENT_ID,
      agentName: 'VideoStudio',
      userMessage: approvalSubmission('gate_b_decision', 'approve'),
    };
    const tool = toolMod.createVideoStudioTool(opts);
    const ctx = { workingDir: workspace, state: {} } as any;
    const approved = await tool.execute({
      op: 'composition.approve_plan',
      composition_dir: 'project/composition',
      decision_evidence: decisionEvidence('plan', 'approve', '确认'),
    }, ctx);
    expect(approved.isError).toBe(false);
    const approvedSignature = parseResult(approved.content).production_state.plan_approval.signature;
    const statePath = toolMod.videoStudioProductionStatePath(opts, compositionDir);
    const scriptPath = path.join(workspace, 'project', 'script.md');
    const canonicalScript = fs.readFileSync(scriptPath, 'utf8');

    fs.writeFileSync(scriptPath, `${canonicalScript}\nTransient edit.`, 'utf8');
    expect((await tool.execute({
      op: 'composition.reconcile',
      composition_dir: 'project/composition',
    }, ctx)).isError).toBe(false);
    const drifted = await stateMod.readVideoProductionState(statePath, compositionDir);
    expect(drifted.plan_approval).toMatchObject({
      signature: approvedSignature,
      turn_id: 'turn-plan-approved',
    });
    const blocked = await tool.execute({
      op: 'composition.prepare',
      composition_dir: 'project/composition',
    }, ctx);
    expect(blocked.isError).toBe(true);
    expect(parseResult(blocked.content)).toMatchObject({
      errorCode: 'E_GATE_B_ARTIFACT_CHANGED',
      billable_request_sent: false,
    });

    fs.writeFileSync(scriptPath, canonicalScript, 'utf8');
    expect((await tool.execute({
      op: 'composition.reconcile',
      composition_dir: 'project/composition',
    }, ctx)).isError).toBe(false);
    const restored = await stateMod.readVideoProductionState(statePath, compositionDir);
    expect(restored.plan_approval).toMatchObject({
      signature: approvedSignature,
      turn_id: 'turn-plan-approved',
    });
    const status = await tool.execute({
      op: 'composition.status',
      composition_dir: 'project/composition',
    }, ctx);
    expect(parseResult(status.content)).toMatchObject({
      plan_approval_current: true,
      plan_artifact_conflict: false,
    });
  });

  it('keeps content-addressed plan approval across implementation-only and formatting changes', async () => {
    makePlanVisualOnly();
    const toolMod = await import('../../../../src/main/model/core-agent/video-studio-tool');
    const stateMod = await import('../../../../src/main/features/video_studio_state');
    const opts = {
      userId: UID,
      cid: 'cid-content-addressed-plan',
      turnId: 'turn-content-addressed-plan',
      agentId: VIDEO_STUDIO_AGENT_ID,
      agentName: 'VideoStudio',
      userMessage: approvalSubmission('gate_b_decision', 'approve'),
    };
    const tool = toolMod.createVideoStudioTool(opts);
    const ctx = { workingDir: workspace, state: {} } as any;
    const approved = await tool.execute({
      op: 'composition.approve_plan',
      composition_dir: 'project/composition',
      decision_evidence: decisionEvidence('plan', 'approve', '确认'),
    }, ctx);
    expect(approved.isError).toBe(false);
    const approvedResult = parseResult(approved.content);
    const approvedIntentHash = approvedResult.plan_signature;
    expect(approvedResult).toMatchObject({
      approved_intent_hash: approvedIntentHash,
      plan_identity_kind: 'approved_intent_sha256',
    });
    const statePath = toolMod.videoStudioProductionStatePath(opts, compositionDir);
    const before = await stateMod.readVideoProductionState(statePath, compositionDir);
    expect(before.plan_approval).toMatchObject({
      signature: approvedIntentHash,
      identity_kind: 'approved_intent_sha256',
      validation_version: 3,
      intent_snapshot: {
        manifest: {
          scenes: [expect.objectContaining({ approved_copy: ['Approved'] })],
        },
      },
    });

    const scriptPath = path.join(workspace, 'project', 'script.md');
    fs.writeFileSync(scriptPath, '# Approved script\n\n\n\nVisual only.\n', 'utf8');
    const shotlistPath = path.join(workspace, 'project', 'shotlist.json');
    fs.writeFileSync(
      shotlistPath,
      JSON.stringify(JSON.parse(fs.readFileSync(shotlistPath, 'utf8')), null, 2),
      'utf8',
    );
    const manifestPath = path.join(compositionDir, 'composition-manifest.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    manifest.art_direction = {
      visual_identity: 'editorial information graphics',
      layout_boxes: { safe_area: '5%' },
      typography_tokens: { title: 96, body: 42 },
      depth_layers: ['background', 'content', 'foreground'],
      motion_verbs: ['reveal', 'track', 'resolve'],
    };
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');

    const status = parseResult((await tool.execute({
      op: 'composition.status',
      composition_dir: 'project/composition',
    }, ctx)).content);
    expect(status).toMatchObject({
      plan_approval_current: true,
      plan_artifact_conflict: false,
      plan_record_refresh_required: true,
      approved_intent_hash: approvedIntentHash,
      candidate_intent_hash: approvedIntentHash,
    });
    expect(status.plan_evidence.observations).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: 'script', status: 'changed' }),
      expect.objectContaining({ role: 'shotlist', status: 'changed' }),
      expect.objectContaining({ role: 'manifest', status: 'changed' }),
    ]));

    const prepared = await tool.execute({
      op: 'composition.prepare',
      composition_dir: 'project/composition',
    }, ctx);
    expect(prepared.isError).toBe(false);
    const after = await stateMod.readVideoProductionState(statePath, compositionDir);
    expect(after.plan_approval).toMatchObject({
      signature: approvedIntentHash,
      identity_kind: 'approved_intent_sha256',
      validation_version: 3,
    });
    expect(after.plan_approval?.artifact_records).not.toEqual(before.plan_approval?.artifact_records);
    expect(ttsMock.generateSpeech).not.toHaveBeenCalled();
  });

  it('keeps Gate B across unique source-alias canonicalization but detects a real shot remap', async () => {
    makePlanVisualOnly();
    const shotlistPath = path.join(workspace, 'project', 'shotlist.json');
    const shotlist = JSON.parse(fs.readFileSync(shotlistPath, 'utf8'));
    shotlist.shots = [
      { id: 'hook', source_shots: ['s01'], message: 'Approved hook' },
      { id: 'payoff', source_shots: ['s02'], message: 'Approved payoff' },
    ];
    shotlist.source_shots = [
      { id: 's01', provenance: 'self-authored HTML/CSS/SVG' },
      { id: 's02', provenance: 'self-authored HTML/CSS/SVG' },
    ];
    fs.writeFileSync(shotlistPath, JSON.stringify(shotlist, null, 2), 'utf8');

    const manifestPath = path.join(compositionDir, 'composition-manifest.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    manifest.scenes = [
      {
        id: 'hook',
        start: 0,
        duration: 2.5,
        approved_copy: ['Approved hook'],
        narration_refs: [],
        source_shots: ['s01'],
        roles: ['title', 'visual'],
      },
      {
        id: 'payoff',
        start: 2.5,
        duration: 2.5,
        approved_copy: ['Approved payoff'],
        narration_refs: [],
        source_shots: ['s02'],
        roles: ['title', 'visual'],
      },
    ];
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');

    const toolMod = await import('../../../../src/main/model/core-agent/video-studio-tool');
    const stateMod = await import('../../../../src/main/features/video_studio_state');
    const opts = {
      userId: UID,
      cid: 'cid-source-shot-alias-content-address',
      turnId: 'turn-source-shot-alias-approved',
      agentId: VIDEO_STUDIO_AGENT_ID,
      agentName: 'VideoStudio',
      userMessage: approvalSubmission('gate_b_decision', 'approve'),
    };
    const tool = toolMod.createVideoStudioTool(opts);
    const ctx = { workingDir: workspace, state: {} } as any;
    const approved = await tool.execute({
      op: 'composition.approve_plan',
      composition_dir: 'project/composition',
    }, ctx);
    expect(approved.isError, String(approved.content)).toBe(false);
    const approvedSignature = parseResult(approved.content).approved_intent_hash;
    const statePath = toolMod.videoStudioProductionStatePath(opts, compositionDir);

    // Simulate an approval persisted by an older build before source aliases
    // and semantic shot ids shared one canonical representation.
    await stateMod.updateVideoProductionState(statePath, compositionDir, (state) => {
      if (!state.plan_approval?.intent_snapshot) throw new Error('plan approval snapshot required');
      state.plan_approval.signature = 'f'.repeat(64);
      const snapshotManifest = state.plan_approval.intent_snapshot.manifest as Record<string, any>;
      snapshotManifest.scenes[0].source_shots = ['s01'];
      snapshotManifest.scenes[1].source_shots = ['s02'];
    });

    const directIds = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    directIds.scenes[0].source_shots = ['hook'];
    directIds.scenes[1].source_shots = ['payoff'];
    fs.writeFileSync(manifestPath, JSON.stringify(directIds, null, 2), 'utf8');

    const normalized = parseResult((await tool.execute({
      op: 'composition.status',
      composition_dir: 'project/composition',
    }, ctx)).content);
    expect(normalized).toMatchObject({
      plan_approval_current: true,
      approved_intent_hash: approvedSignature,
      candidate_intent_hash: approvedSignature,
      plan_artifact_conflict: false,
    });
    expect((await stateMod.readVideoProductionState(statePath, compositionDir)).plan_approval)
      .toMatchObject({
        signature: approvedSignature,
        identity_kind: 'approved_intent_sha256',
      });

    const swapped = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    swapped.scenes[0].source_shots = ['payoff'];
    swapped.scenes[1].source_shots = ['hook'];
    fs.writeFileSync(manifestPath, JSON.stringify(swapped, null, 2), 'utf8');
    const realRemap = parseResult((await tool.execute({
      op: 'composition.status',
      composition_dir: 'project/composition',
    }, ctx)).content);
    expect(realRemap).toMatchObject({
      plan_approval_current: false,
      plan_artifact_conflict: true,
    });
    expect(realRemap.candidate_intent_hash).not.toBe(approvedSignature);
  });

  it('treats narration catalog label refresh as metadata instead of reopening plan approval', async () => {
    useSchema2Narration('Vivi');
    const toolMod = await import('../../../../src/main/model/core-agent/video-studio-tool');
    const stateMod = await import('../../../../src/main/features/video_studio_state');
    const opts = {
      userId: UID,
      cid: 'cid-narration-label-refresh',
      turnId: 'turn-narration-label-refresh',
      agentId: VIDEO_STUDIO_AGENT_ID,
      agentName: 'VideoStudio',
      userMessage: '确认',
    };
    const tool = toolMod.createVideoStudioTool(opts);
    const ctx = { workingDir: workspace, state: {} } as any;
    const approved = await tool.execute({
      op: 'composition.approve_plan',
      composition_dir: 'project/composition',
      decision_evidence: decisionEvidence('plan', 'approve', '确认'),
    }, ctx);
    expect(approved.isError, String(approved.content)).toBe(false);
    const approvedSignature = parseResult(approved.content).approved_intent_hash;
    const statePath = toolMod.videoStudioProductionStatePath(opts, compositionDir);
    await stateMod.updateVideoProductionState(statePath, compositionDir, (legacy) => {
      legacy.plan_approval!.signature = 'f'.repeat(64);
      const snapshot = legacy.plan_approval!.intent_snapshot!;
      const snapshotManifest = snapshot.manifest as Record<string, any>;
      snapshotManifest.audio.narration_intent.display_name = 'Vivi';
    });

    const manifestPath = path.join(compositionDir, 'composition-manifest.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    manifest.audio.narration_intent.display_name = 'vivi 2.0';
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');

    const status = parseResult((await tool.execute({
      op: 'composition.status',
      composition_dir: 'project/composition',
    }, ctx)).content);
    expect(status).toMatchObject({
      plan_approval_current: true,
      plan_artifact_conflict: false,
      candidate_intent_hash: approvedSignature,
    });

    const fit = await tool.execute({
      op: 'composition.check_narration_fit',
      composition_dir: 'project/composition',
    }, ctx);
    expect(fit.isError, String(fit.content)).toBe(false);
    expect(parseResult(fit.content)).toMatchObject({
      gate_b_ready: true,
      gate_b_required: false,
      requires_user_decision: false,
    });
    expect(fit.content).not.toContain('E_TTS_INTENT_LABEL_MISMATCH');

    const prepared = await tool.execute({
      op: 'composition.prepare',
      composition_dir: 'project/composition',
    }, ctx);
    expect(prepared.isError, String(prepared.content)).toBe(false);

    const refreshed = await stateMod.readVideoProductionState(statePath, compositionDir);
    expect(refreshed.plan_approval).toMatchObject({
      signature: approvedSignature,
      turn_id: 'turn-narration-label-refresh',
    });
    expect(ttsMock.generateSpeech).not.toHaveBeenCalled();
  });

  it('keeps COMPOSE approval across shotlist execution metadata but invalidates creative intent', async () => {
    makePlanVisualOnly();
    const toolMod = await import('../../../../src/main/model/core-agent/video-studio-tool');
    const opts = {
      userId: UID,
      cid: 'cid-shotlist-intent-projection',
      turnId: 'turn-shotlist-intent-projection',
      agentId: VIDEO_STUDIO_AGENT_ID,
      agentName: 'VideoStudio',
      userMessage: '确认',
    };
    const tool = toolMod.createVideoStudioTool(opts);
    const ctx = { workingDir: workspace, state: {} } as any;
    const approved = await tool.execute({
      op: 'composition.approve_plan',
      composition_dir: 'project/composition',
      decision_evidence: decisionEvidence('plan', 'approve', '确认'),
    }, ctx);
    expect(approved.isError, String(approved.content)).toBe(false);
    const approvedSignature = parseResult(approved.content).approved_intent_hash;

    const shotlistPath = path.join(workspace, 'project', 'shotlist.json');
    const shotlist = JSON.parse(fs.readFileSync(shotlistPath, 'utf8'));
    shotlist.schema_version = 2;
    shotlist._runtime = { worker: 'worker-2', updated_at: '2026-07-28T20:00:00.000Z' };
    shotlist.shots[0].status = 'completed';
    shotlist.shots[0].produced_path = '/relocated/cover.mp4';
    shotlist.shots[0].provider_task_id = 'provider-task-2';
    fs.writeFileSync(shotlistPath, JSON.stringify(shotlist, null, 2), 'utf8');

    const metadataOnly = parseResult((await tool.execute({
      op: 'composition.status',
      composition_dir: 'project/composition',
    }, ctx)).content);
    expect(metadataOnly).toMatchObject({
      plan_approval_current: true,
      approved_intent_hash: approvedSignature,
      candidate_intent_hash: approvedSignature,
      plan_record_refresh_required: true,
    });

    const prepared = await tool.execute({
      op: 'composition.prepare',
      composition_dir: 'project/composition',
    }, ctx);
    expect(prepared.isError, String(prepared.content)).toBe(false);

    shotlist.title = 'A different creative plan';
    fs.writeFileSync(shotlistPath, JSON.stringify(shotlist, null, 2), 'utf8');
    const creativeChange = parseResult((await tool.execute({
      op: 'composition.status',
      composition_dir: 'project/composition',
    }, ctx)).content);
    expect(creativeChange).toMatchObject({
      plan_approval_current: false,
    });
    expect(creativeChange.candidate_intent_hash).not.toBe(approvedSignature);
  });

  it('migrates an unchanged legacy artifact-bundle approval to an approved-intent content address', async () => {
    makePlanVisualOnly();
    const toolMod = await import('../../../../src/main/model/core-agent/video-studio-tool');
    const stateMod = await import('../../../../src/main/features/video_studio_state');
    const opts = {
      userId: UID,
      cid: 'cid-legacy-plan-content-address',
      turnId: 'turn-legacy-plan-content-address',
      agentId: VIDEO_STUDIO_AGENT_ID,
      agentName: 'VideoStudio',
      userMessage: approvalSubmission('gate_b_decision', 'approve'),
    };
    const tool = toolMod.createVideoStudioTool(opts);
    const ctx = { workingDir: workspace, state: {} } as any;
    const approved = await tool.execute({
      op: 'composition.approve_plan',
      composition_dir: 'project/composition',
      decision_evidence: decisionEvidence('plan', 'approve', '确认'),
    }, ctx);
    expect(approved.isError).toBe(false);
    const semanticHash = parseResult(approved.content).approved_intent_hash;
    const statePath = toolMod.videoStudioProductionStatePath(opts, compositionDir);
    await stateMod.updateVideoProductionState(statePath, compositionDir, (state) => {
      state.plan_approval!.signature = legacyCompositionPlanSignature();
      state.plan_approval!.identity_kind = 'legacy_artifact_bundle_sha256';
      delete state.plan_approval!.intent_snapshot;
      state.plan_approval!.validation_version = 2;
    });

    const prepared = await tool.execute({
      op: 'composition.prepare',
      composition_dir: 'project/composition',
    }, ctx);
    expect(prepared.isError).toBe(false);
    expect((await stateMod.readVideoProductionState(statePath, compositionDir)).plan_approval)
      .toMatchObject({
        signature: semanticHash,
        identity_kind: 'approved_intent_sha256',
        validation_version: 3,
        intent_snapshot: expect.any(Object),
      });
  });

  it('recovers legacy late-stage silent narration without reopening Gate B', async () => {
    const toolMod = await import('../../../../src/main/model/core-agent/video-studio-tool');
    const stateMod = await import('../../../../src/main/features/video_studio_state');
    const opts = {
      userId: UID,
      turnId: 'turn-recover-silent',
      agentId: VIDEO_STUDIO_AGENT_ID,
      agentName: 'VideoStudio',
      userMessage: approvalSubmission('gate_b_decision', 'approve'),
    };
    const tool = toolMod.createVideoStudioTool(opts);
    const ctx = { workingDir: workspace, state: {} } as any;
    expect((await tool.execute({ op: 'composition.approve_plan', composition_dir: 'project/composition' }, ctx)).isError).toBe(false);
    expect((await tool.execute({ op: 'composition.prepare', composition_dir: 'project/composition' }, ctx)).isError).toBe(false);

    const statePath = toolMod.videoStudioProductionStatePath(opts, compositionDir);
    await stateMod.updateVideoProductionState(statePath, compositionDir, (state) => {
      const gate = {
        signature: 'legacy-silent-signature',
        turn_id: 'turn-draft',
        created_at: new Date().toISOString(),
        status: 'approved' as const,
        approved_turn_id: 'turn-approve-draft',
        approved_at: new Date().toISOString(),
        validation_version: 3 as const,
      };
      state.preview = { ...gate };
      state.draft = { ...gate };
      state.stage = 'draft_approved';
    });

    const status = parseResult((await tool.execute({
      op: 'composition.status',
      composition_dir: 'project/composition',
    }, ctx)).content);
    expect(status).toMatchObject({
      plan_approval_current: true,
      production_state: {
        stage: 'scaffold_ready',
        preview_status: 'approved',
        draft_status: 'missing',
        blocked_operation: { error_code: 'E_NARRATION_MATERIALIZATION_REQUIRED' },
        next_allowed_ops: expect.arrayContaining(['composition.materialize_narration']),
      },
    });
    expect(status.production_state.next_allowed_ops).not.toContain('composition.export');

    const fit = parseResult((await tool.execute({
      op: 'composition.check_narration_fit',
      composition_dir: 'project/composition',
    }, ctx)).content);
    expect(fit).toMatchObject({
      gate_b_ready: true,
      gate_b_required: false,
      next_action: 'composition.materialize_narration',
      production_state: {
        next_allowed_ops: expect.arrayContaining(['composition.materialize_narration']),
      },
    });
    expect(fit.production_state.next_allowed_ops).toContain('composition.lint');
  });

  it('repairs missing narration map and HTML binding without another speech request or Gate B', async () => {
    const narration = materializeNarrationFixture();
    const toolMod = await import('../../../../src/main/model/core-agent/video-studio-tool');
    const stateMod = await import('../../../../src/main/features/video_studio_state');
    const opts = {
      userId: UID,
      turnId: 'turn-repair-narration-metadata',
      agentId: VIDEO_STUDIO_AGENT_ID,
      agentName: 'VideoStudio',
      userMessage: approvalSubmission('gate_b_decision', 'approve'),
    };
    const tool = toolMod.createVideoStudioTool(opts);
    const ctx = { workingDir: workspace, state: {} } as any;
    expect((await tool.execute({
      op: 'composition.approve_plan',
      composition_dir: 'project/composition',
      decision_evidence: decisionEvidence('plan', 'approve', '确认'),
    }, ctx)).isError).toBe(false);

    const htmlPath = path.join(compositionDir, 'index.html');
    const scaffoldSha = crypto.createHash('sha256').update(fs.readFileSync(htmlPath)).digest('hex');
    const statePath = toolMod.videoStudioProductionStatePath(opts, compositionDir);
    await stateMod.updateVideoProductionState(statePath, compositionDir, (state) => {
      state.stage = 'draft_approved';
      state.narration = {
        status: 'materialized',
        text_sha256: narration.textSha256,
        audio_sha256: narration.audioSha256,
        path: path.join(compositionDir, 'assets', 'narration.mp3'),
        measured_duration_sec: narration.durationSec,
        backend: 'mock-voice',
        speed: 1,
        materialized_at: new Date().toISOString(),
      };
      state.artifacts.html_sha256 = scaffoldSha;
      state.artifacts.scaffold_html_sha256 = scaffoldSha;
    });

    fs.rmSync(path.join(compositionDir, 'narration-map.json'));
    fs.writeFileSync(
      htmlPath,
      fs.readFileSync(htmlPath, 'utf8')
        .replace(/\s*<audio\b[^>]*>\s*<\/audio>/i, '')
        .replace('</section>', '<div data-role="visual">authored visual survives</div>\n</section>'),
      'utf8',
    );

    const status = parseResult((await tool.execute({
      op: 'composition.status',
      composition_dir: 'project/composition',
    }, ctx)).content);
    expect(status).toMatchObject({
      plan_approval_current: true,
      production_state: {
        stage: 'scaffold_ready',
        blocked_operation: { error_code: 'E_NARRATION_MATERIALIZATION_REQUIRED' },
        next_allowed_ops: expect.arrayContaining(['composition.materialize_narration']),
      },
    });
    expect((await stateMod.readVideoProductionState(statePath, compositionDir)).narration).toBeDefined();

    const recovered = await tool.execute({
      op: 'composition.materialize_narration',
      composition_dir: 'project/composition',
    }, ctx);
    expect(recovered.isError).toBe(false);
    expect(parseResult(recovered.content)).toMatchObject({
      status: 'recovered',
      billable_request_sent: false,
      visuals_preserved: true,
      production_state: { stage: 'visuals_ready' },
    });
    expect(ttsMock.generateSpeech).not.toHaveBeenCalled();
    expect(fs.existsSync(path.join(compositionDir, 'narration-map.json'))).toBe(true);
    expect(fs.readFileSync(htmlPath, 'utf8')).toContain('src="./assets/narration.mp3"');
    expect(fs.readFileSync(htmlPath, 'utf8')).toContain('authored visual survives');
    const recoveredState = await stateMod.readVideoProductionState(statePath, compositionDir);
    expect(recoveredState.blocked_operation).toBeUndefined();
    expect(recoveredState.narration).toMatchObject({
      text_sha256: narration.textSha256,
      audio_sha256: narration.audioSha256,
    });
  });

  it('restores a lost narration ledger binding from the content-matched runtime receipt', async () => {
    const narration = materializeNarrationFixture();
    markNarrationMapAsRuntimeReceipt();
    const toolMod = await import('../../../../src/main/model/core-agent/video-studio-tool');
    const stateMod = await import('../../../../src/main/features/video_studio_state');
    const opts = {
      userId: UID,
      turnId: 'turn-recover-runtime-receipt',
      agentId: VIDEO_STUDIO_AGENT_ID,
      agentName: 'VideoStudio',
      userMessage: approvalSubmission('gate_b_decision', 'approve'),
    };
    const tool = toolMod.createVideoStudioTool(opts);
    const ctx = { workingDir: workspace, state: {} } as any;
    expect((await tool.execute({
      op: 'composition.approve_plan',
      composition_dir: 'project/composition',
      decision_evidence: decisionEvidence('plan', 'approve', '确认'),
    }, ctx)).isError).toBe(false);

    const statePath = toolMod.videoStudioProductionStatePath(opts, compositionDir);
    await stateMod.updateVideoProductionState(statePath, compositionDir, (state) => {
      delete state.narration;
      delete state.narration_transaction;
      state.blocked_operation = {
        op: 'composition.materialize_narration',
        error_code: 'E_NARRATION_MATERIALIZATION_REQUIRED',
        message: 'The durable ledger binding was lost.',
        artifacts: state.artifacts,
        created_at: new Date().toISOString(),
      };
      state.stage = 'scaffold_ready';
    });

    const recovered = await tool.execute({
      op: 'composition.materialize_narration',
      composition_dir: 'project/composition',
    }, ctx);
    expect(recovered.isError).toBe(false);
    expect(parseResult(recovered.content)).toMatchObject({
      ok: true,
      status: 'recovered',
      recovery_source: 'materialization_receipt',
      ledger_binding_restored: true,
      billable_request_sent: false,
      measured_duration_sec: narration.durationSec,
    });
    expect(ttsMock.generateSpeech).not.toHaveBeenCalled();
    const finalState = await stateMod.readVideoProductionState(statePath, compositionDir);
    expect(finalState.blocked_operation).toBeUndefined();
    expect(finalState.narration).toMatchObject({
      status: 'materialized',
      text_sha256: narration.textSha256,
      audio_sha256: narration.audioSha256,
      backend: 'materialization_receipt',
    });
  });

  it('does not trust a matching audio filename without a runtime receipt and returns an actionable continuation', async () => {
    materializeNarrationFixture();
    const toolMod = await import('../../../../src/main/model/core-agent/video-studio-tool');
    const opts = {
      userId: UID,
      turnId: 'turn-untrusted-orphan-audio',
      agentId: VIDEO_STUDIO_AGENT_ID,
      agentName: 'VideoStudio',
      userMessage: '继续制作',
    };
    const tool = toolMod.createVideoStudioTool(opts);
    const ctx = { workingDir: workspace, state: {} } as any;
    expect((await tool.execute({
      op: 'composition.approve_plan',
      composition_dir: 'project/composition',
      decision_evidence: decisionEvidence('plan', 'approve', '继续制作'),
    }, ctx)).isError).toBe(false);

    const blocked = await tool.execute({
      op: 'composition.materialize_narration',
      composition_dir: 'project/composition',
    }, ctx);
    expect(blocked.isError).toBe(true);
    expect(parseResult(blocked.content)).toMatchObject({
      errorCode: 'E_NARRATION_OUTPUT_CONFLICT',
      recoverable: true,
      terminal: false,
      retry_same_operation: false,
      billable_request_sent: false,
      requires_user_decision: true,
      next_action: 'show_current_candidate_and_request_narration_conflict_resolution',
      user_options: expect.arrayContaining([
        expect.objectContaining({ id: 'regenerate_current_narration' }),
        expect.objectContaining({ id: 'revise_narration' }),
        expect.objectContaining({ id: 'pause_with_visuals' }),
      ]),
      review_package: {
        presentation_required: true,
        continuation: {
          recoverable: true,
          terminal: false,
          user_action_required: true,
          user_options: expect.arrayContaining([
            expect.objectContaining({ id: 'regenerate_current_narration' }),
          ]),
        },
      },
    });
    expect(ttsMock.generateSpeech).not.toHaveBeenCalled();
  });

  it('recovers a matching synthesized narration transaction without another paid request', async () => {
    const toolMod = await import('../../../../src/main/model/core-agent/video-studio-tool');
    const stateMod = await import('../../../../src/main/features/video_studio_state');
    const opts = {
      userId: UID,
      turnId: 'turn-recover',
      agentId: VIDEO_STUDIO_AGENT_ID,
      agentName: 'VideoStudio',
      userMessage: '确认',
    };
    const tool = toolMod.createVideoStudioTool(opts);
    const ctx = { workingDir: workspace, state: {} } as any;
    for (const op of ['composition.approve_plan', 'composition.doctor', 'composition.prepare']) {
      const result = await tool.execute(compositionInput(op), ctx);
      expect(result.isError).toBe(false);
    }

    const audioPath = path.join(compositionDir, 'assets', 'narration.mp3');
    fs.mkdirSync(path.dirname(audioPath), { recursive: true });
    fs.writeFileSync(audioPath, Buffer.from('already-paid-audio'));
    const manifestPath = path.join(compositionDir, 'composition-manifest.json');
    const htmlPath = path.join(compositionDir, 'index.html');
    const sha = (file: string) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
    const statePath = toolMod.videoStudioProductionStatePath(opts, compositionDir);
    await stateMod.updateVideoProductionState(statePath, compositionDir, (state) => {
      const now = new Date().toISOString();
      state.narration_transaction = {
        transaction_id: 'tx-recover',
        status: 'synthesized',
        text_sha256: crypto.createHash('sha256').update('Speak once.').digest('hex'),
        path: audioPath,
        manifest_sha256: sha(manifestPath),
        scaffold_html_sha256: sha(htmlPath),
        backend: 'mock-previous',
        audio_sha256: crypto.createHash('sha256').update(fs.readFileSync(audioPath)).digest('hex'),
        measured_duration_sec: 4.6,
        started_at: now,
        updated_at: now,
      };
    });
    fs.appendFileSync(htmlPath, '\n<!-- authored visual must survive late narration recovery -->\n', 'utf8');
    await stateMod.updateVideoProductionState(statePath, compositionDir, (state) => {
      state.stage = 'visuals_ready';
    });
    // A paid matching artifact must still be measured/recovered if a later
    // estimator version would call the text too long.
    ttsMock.estimateNarrationDuration.mockImplementation((text: string) => ({
      estimatedSec: 6,
      unit: 'words',
      units: text.split(/\s+/).filter(Boolean).length,
      unitsPerSec: 1,
    }));

    const recovered = await tool.execute({
      op: 'composition.materialize_narration',
      composition_dir: 'project/composition',
    }, ctx);
    expect(recovered.isError).toBe(false);
    expect(parseResult(recovered.content)).toMatchObject({
      status: 'recovered',
      billable_request_sent: false,
      measured_duration_sec: 4.6,
      alignment_method: 'scene_estimate_scaled',
      visuals_preserved: true,
      production_state: { stage: 'visuals_ready' },
    });
    expect(ttsMock.generateSpeech).not.toHaveBeenCalled();
    expect(fs.existsSync(path.join(compositionDir, 'narration-map.json'))).toBe(true);
    expect(fs.readFileSync(htmlPath, 'utf8')).toContain('authored visual must survive late narration recovery');
    const finalState = await stateMod.readVideoProductionState(statePath, compositionDir);
    expect(finalState.narration_transaction).toBeUndefined();
    expect(finalState.narration).toMatchObject({ status: 'materialized', backend: 'mock-previous' });
  });

  it('keeps visual recovery available after an uncertain narration charge without resending speech', async () => {
    useSchema2Narration('Vivi');
    const toolMod = await import('../../../../src/main/model/core-agent/video-studio-tool');
    const opts = {
      userId: UID,
      cid: 'cid-uncertain-narration-charge',
      turnId: 'turn-uncertain-narration-charge',
      agentId: VIDEO_STUDIO_AGENT_ID,
      agentName: 'VideoStudio',
      userMessage: '确认',
    };
    const tool = toolMod.createVideoStudioTool(opts);
    const ctx = { workingDir: workspace, state: {} } as any;
    for (const op of ['composition.approve_plan', 'composition.doctor', 'composition.prepare']) {
      expect((await tool.execute(compositionInput(op), ctx)).isError).toBe(false);
    }
    ttsMock.generateSpeech.mockResolvedValue({
      ok: false,
      errorCode: 'E_TTS_PROVIDER_TIMEOUT',
      message: 'The provider did not return a conclusive result.',
      requestDisposition: 'sent',
      chargeStatus: 'unknown',
      retryPolicy: 'unknown',
    });

    const failed = await tool.execute({
      op: 'composition.materialize_narration',
      composition_dir: 'project/composition',
    }, ctx);
    expect(failed.isError).toBe(true);
    expect(parseResult(failed.content)).toMatchObject({
      errorCode: 'E_TTS_PROVIDER_TIMEOUT',
      requires_user_decision: true,
      blocked_scope: 'narration_and_complete_delivery_only',
      candidate_completeness: 'visual_only',
      next_action: 'continue_visual_preview_then_request_narration_retry_decision',
      allowed_recovery_ops: expect.arrayContaining([
        'composition.lint',
        'composition.inspect',
        'composition.snapshot',
      ]),
      current_candidate: {
        revision_id: expect.stringMatching(/^candidate-/),
        locators: {
          html_path: path.join(compositionDir, 'index.html'),
        },
      },
    });
    expect(ttsMock.generateSpeech).toHaveBeenCalledTimes(1);

    // Simulate a ledger written before the stable request identity stopped
    // including mutable provider implementation metadata.
    const migrationStateMod = await import('../../../../src/main/features/video_studio_state');
    const migrationStatePath = toolMod.videoStudioProductionStatePath(opts, compositionDir);
    await migrationStateMod.updateVideoProductionState(
      migrationStatePath,
      compositionDir,
      (legacy) => {
        legacy.narration_transaction!.request_signature = 'legacy-signature-with-provider-model';
      },
    );

    const manifestPath = path.join(compositionDir, 'composition-manifest.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    manifest.art_direction = completePreviewArtDirection();
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');

    const visualLint = await tool.execute({
      op: 'composition.lint',
      composition_dir: 'project/composition',
    }, ctx);
    expect(visualLint.isError, JSON.stringify(parseResult(visualLint.content))).toBe(false);
    expect(parseResult(visualLint.content)).toMatchObject({
      ok: true,
      preview_completeness: 'visual_only',
      narration_pending: true,
      next_allowed_ops: expect.arrayContaining([
        'composition.inspect',
        'composition.snapshot',
      ]),
    });
    expect(ttsMock.generateSpeech).toHaveBeenCalledTimes(1);

    const stateMod = await import('../../../../src/main/features/video_studio_state');
    const statePath = toolMod.videoStudioProductionStatePath(opts, compositionDir);
    const contactSheet = path.join(workspace, 'project', 'render', 'approved-contact-sheet.svg');
    fs.mkdirSync(path.dirname(contactSheet), { recursive: true });
    fs.writeFileSync(contactSheet, '<svg/>', 'utf8');
    expect(await toolMod.recordVideoStudioGate(
      statePath,
      'preview',
      compositionDir,
      'turn-preview-ready',
      {
        preview_ready: true,
        preview_qa: { ok: true, error_count: 0 },
        preflight: { status: 'passed', blocking_error_count: 0 },
        contact_sheet: contactSheet,
      },
    )).toBe(true);
    expect((await toolMod.approveVideoStudioGate(
      statePath,
      'preview',
      compositionDir,
      'turn-preview-approved',
      true,
    )).ok).toBe(true);
    await stateMod.updateVideoProductionState(statePath, compositionDir, (state) => {
      if (!state.current_candidate) throw new Error('current candidate is required');
      state.current_candidate.locators.preview_path = contactSheet;
      if (state.current_candidate.snapshot) {
        state.current_candidate.snapshot.locators.preview_path = contactSheet;
      }
    });

    const resumed = await tool.execute({
      op: 'composition.materialize_narration',
      composition_dir: 'project/composition',
    }, ctx);
    expect(resumed.isError).toBe(true);
    expect(parseResult(resumed.content)).toMatchObject({
      errorCode: 'E_TTS_RETRY_REQUIRES_USER_ACTION',
      requires_user_decision: true,
      blocked_scope: 'narration_and_complete_delivery_only',
      candidate_completeness: 'visual_only',
      next_action: 'continue_visual_preview_then_request_narration_retry_decision',
      allowed_recovery_ops: expect.arrayContaining([
        'composition.lint',
        'composition.inspect',
        'composition.snapshot',
      ]),
      narration_retry_offer: {
        offer_id: expect.stringMatching(/^[a-f0-9]{64}$/),
        previous_request_outcome: 'unknown',
        new_billable_request_count: 1,
      },
      production_state: {
        preview_status: 'approved',
      },
      review_package: {
        status: 'current_approved',
        primary_artifact: {
          role: 'preview',
          review_status: 'current_approved',
        },
      },
    });
    expect(ttsMock.generateSpeech).toHaveBeenCalledTimes(1);
    expect((await stateMod.readVideoProductionState(statePath, compositionDir))
      .narration_transaction?.request_signature).toMatch(/^[a-f0-9]{64}$/);

    const malformedRetryTool = toolMod.createVideoStudioTool({
      ...opts,
      turnId: 'turn-narration-retry-malformed',
      userMessage: '<msg from="user">继续</msg>',
    });
    const malformedRetry = await malformedRetryTool.execute({
      op: 'composition.materialize_narration',
      composition_dir: 'project/composition',
      decision_evidence: '继续',
    }, ctx);
    expect(malformedRetry.isError).toBe(true);
    expect(parseResult(malformedRetry.content)).toMatchObject({
      errorCode: 'E_DECISION_EVIDENCE_INVALID',
      decision_evidence_valid: false,
      decision_evidence_issue: 'expected_object',
      current_user_message_available: true,
      requires_user_decision: false,
      user_reconfirmation_required: false,
      automatic_recovery_expected: true,
      billable_request_sent: false,
      next_action: 'retry_same_operation_with_structured_decision_evidence',
      narration_retry_offer: {
        previous_request_outcome: 'unknown',
        new_billable_request_count: 1,
      },
      review_package: {
        status: 'current_approved',
      },
    });
    expect(ttsMock.generateSpeech).toHaveBeenCalledTimes(1);
    expect((await stateMod.readVideoProductionState(statePath, compositionDir))
      .narration_transaction_history).toHaveLength(0);

    const retryMessage = '<msg from="user">请重新生成一次旁白</msg>';
    const retryTool = toolMod.createVideoStudioTool({
      ...opts,
      turnId: 'turn-narration-retry-1',
      userMessage: retryMessage,
    });
    ttsMock.generateSpeech.mockResolvedValue({
      ok: false,
      errorCode: 'E_TTS_PROVIDER_TIMEOUT',
      message: 'The provider charged the request but returned no usable audio.',
      requestDisposition: 'sent',
      chargeStatus: 'charged',
      retryPolicy: 'requires_user_action',
    });
    const retried = await retryTool.execute({
      op: 'composition.materialize_narration',
      composition_dir: 'project/composition',
      decision_evidence: JSON.stringify(
        decisionEvidence('narration_retry', 'approve', '请重新生成一次旁白'),
      ),
    }, ctx);
    expect(retried.isError).toBe(true);
    expect(parseResult(retried.content)).toMatchObject({
      errorCode: 'E_TTS_RETRY_EPISODE_EXHAUSTED',
      provider_error_code: 'E_TTS_PROVIDER_TIMEOUT',
      charge_status: 'charged',
      requires_user_decision: false,
      user_reconfirmation_required: false,
      automatic_recovery_expected: true,
      recovery_status: 'completed_with_preserved_visual_candidate',
      narration_retry_episode: {
        status: 'exhausted',
        failed_request_count: 2,
        max_failed_requests: 2,
        reset_condition: 'provider_outcome_reconciled_or_stable_narration_intent_changed',
      },
      next_action: 'show_current_visual_candidate_and_recovery_options',
      review_package: {
        status: 'current_approved',
        conclusion: {
          requires_user_decision: false,
          automatic_recovery_expected: true,
          next_step_owner: 'agent',
        },
      },
    });
    expect(parseResult(retried.content)).not.toHaveProperty('narration_retry_offer');
    expect(ttsMock.generateSpeech).toHaveBeenCalledTimes(2);

    const afterRetryFailure = await stateMod.readVideoProductionState(statePath, compositionDir);
    expect(afterRetryFailure.narration_transaction).toMatchObject({
      status: 'failed',
      retry_of_transaction_id: expect.any(String),
      authorized_turn_id: 'turn-narration-retry-1',
      authorization_source: 'model_interpreted_user_message',
      attempt_number: 2,
      charge_status: 'charged',
    });
    expect(afterRetryFailure.narration_transaction_history).toHaveLength(1);

    const duplicate = await retryTool.execute({
      op: 'composition.materialize_narration',
      composition_dir: 'project/composition',
      decision_evidence: decisionEvidence('narration_retry', 'approve', '请重新生成一次旁白'),
    }, ctx);
    expect(duplicate.isError).toBe(true);
    expect(parseResult(duplicate.content)).toMatchObject({
      errorCode: 'E_TTS_RETRY_EPISODE_EXHAUSTED',
      billable_request_sent: false,
      requires_user_decision: false,
      decision_acknowledged: true,
      decision_applied: false,
      decision_reuse_allowed: false,
      submitted_decision: 'approve',
      submitted_decision_source: 'model_interpreted_user_message',
      submitted_decision_protocol: 'model_interpreted_user_message',
      submitted_decision_status: 'superseded_by_current_transaction_ledger',
      retry_proposal_status: 'superseded',
      compatibility_status: 'stale_retry_decision_resolved_safely',
      narration_retry_episode: {
        failed_request_count: 2,
      },
      next_action: 'acknowledge_superseded_confirmation_show_current_visual_candidate_and_recovery_options',
    });
    expect(ttsMock.generateSpeech).toHaveBeenCalledTimes(2);

    const finalState = await (await import('../../../../src/main/features/video_studio_state'))
      .readVideoProductionState(
        toolMod.videoStudioProductionStatePath(opts, compositionDir),
        compositionDir,
      );
    expect(finalState.narration_transaction).toMatchObject({
      status: 'failed',
      attempt_number: 2,
      charge_status: 'charged',
    });
    expect(finalState.narration_transaction_history).toHaveLength(1);
    expect(finalState.narration).toBeUndefined();
  });

  it.each([
    ['narration_retry_decision', 'narration_retry_form'],
    ['gate_c_decision', 'legacy_gate_c_form'],
  ])(
    'consumes one still-valid %s approval, then safely closes the same stale old-session action',
    async (fieldId, expectedProtocol) => {
      useSchema2Narration('Vivi');
      const toolMod = await import('../../../../src/main/model/core-agent/video-studio-tool');
      const stateMod = await import('../../../../src/main/features/video_studio_state');
      const opts = {
        userId: UID,
        cid: `cid-old-session-${fieldId}`,
        turnId: `turn-old-session-initial-${fieldId}`,
        agentId: VIDEO_STUDIO_AGENT_ID,
        agentName: 'VideoStudio',
        userMessage: '确认',
      };
      const tool = toolMod.createVideoStudioTool(opts);
      const ctx = { workingDir: workspace, state: {} } as any;
      for (const op of ['composition.approve_plan', 'composition.doctor', 'composition.prepare']) {
        expect((await tool.execute(compositionInput(op), ctx)).isError).toBe(false);
      }
      ttsMock.generateSpeech
        .mockResolvedValueOnce({
          ok: false,
          errorCode: 'E_TTS_PROVIDER_TIMEOUT',
          message: 'The first provider outcome is unknown.',
          requestDisposition: 'sent',
          chargeStatus: 'unknown',
          retryPolicy: 'unknown',
        })
        .mockResolvedValueOnce({
          ok: false,
          errorCode: 'E_TTS_PROVIDER_TIMEOUT',
          message: 'The authorized retry outcome is also unknown.',
          requestDisposition: 'sent',
          chargeStatus: 'unknown',
          retryPolicy: 'unknown',
        });

      const initial = await tool.execute({
        op: 'composition.materialize_narration',
        composition_dir: 'project/composition',
      }, ctx);
      expect(initial.isError).toBe(true);
      expect(parseResult(initial.content)).toMatchObject({
        requires_user_decision: true,
        narration_retry_offer: {
          new_billable_request_count: 1,
        },
      });
      expect(ttsMock.generateSpeech).toHaveBeenCalledTimes(1);

      const validApprovalTool = toolMod.createVideoStudioTool({
        ...opts,
        turnId: `turn-old-session-valid-${fieldId}`,
        userMessage: approvalSubmission(fieldId, 'approve'),
      });
      const validApproval = await validApprovalTool.execute({
        op: 'composition.materialize_narration',
        composition_dir: 'project/composition',
      }, ctx);
      expect(validApproval.isError).toBe(true);
      expect(parseResult(validApproval.content)).toMatchObject({
        errorCode: 'E_TTS_RETRY_EPISODE_EXHAUSTED',
        billable_request_sent: true,
        narration_retry_episode: {
          failed_request_count: 2,
          max_failed_requests: 2,
        },
        next_action: 'show_current_visual_candidate_and_recovery_options',
      });
      expect(parseResult(validApproval.content)).not.toHaveProperty('submitted_decision_status');
      expect(ttsMock.generateSpeech).toHaveBeenCalledTimes(2);

      const statePath = toolMod.videoStudioProductionStatePath(opts, compositionDir);
      const afterValidApproval = await stateMod.readVideoProductionState(statePath, compositionDir);
      expect(afterValidApproval.narration_transaction).toMatchObject({
        attempt_number: 2,
        authorization_source: 'form',
        request_disposition: 'sent',
        charge_status: 'unknown',
      });
      expect(afterValidApproval.narration_transaction_history).toHaveLength(1);

      // Display/catalog metadata may change while an old conversation remains
      // open. It must not create a third request episode for the same stable
      // text/route/voice/language/speed/format identity.
      if (fieldId === 'narration_retry_decision') {
        const manifestPath = path.join(compositionDir, 'composition-manifest.json');
        const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
        manifest.audio.narration_intent.display_name = 'vivi 2.0';
        fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');
      }

      const staleApprovalTool = toolMod.createVideoStudioTool({
        ...opts,
        turnId: `turn-old-session-stale-${fieldId}`,
        userMessage: approvalSubmission(fieldId, 'approve'),
      });
      const staleApproval = await staleApprovalTool.execute({
        op: 'composition.materialize_narration',
        composition_dir: 'project/composition',
      }, ctx);
      expect(staleApproval.isError).toBe(true);
      expect(parseResult(staleApproval.content)).toMatchObject({
        errorCode: 'E_TTS_RETRY_EPISODE_EXHAUSTED',
        billable_request_sent: false,
        decision_acknowledged: true,
        decision_applied: false,
        decision_reuse_allowed: false,
        submitted_decision: 'approve',
        submitted_decision_source: 'form',
        submitted_decision_protocol: expectedProtocol,
        submitted_decision_status: 'superseded_by_current_transaction_ledger',
        retry_proposal_status: 'superseded',
        compatibility_status: 'stale_retry_decision_resolved_safely',
        narration_retry_episode: {
          failed_request_count: 2,
        },
        next_action: 'acknowledge_superseded_confirmation_show_current_visual_candidate_and_recovery_options',
        review_package: {
          status: expect.stringMatching(/^current/),
        },
      });
      expect(parseResult(staleApproval.content).message).toContain('Your reply was received');
      expect(parseResult(staleApproval.content)).not.toHaveProperty('narration_retry_offer');
      expect(ttsMock.generateSpeech).toHaveBeenCalledTimes(2);
    },
  );

  it('starts a fresh narration request episode only after a real approved narration-intent change', async () => {
    useSchema2Narration('Vivi');
    const toolMod = await import('../../../../src/main/model/core-agent/video-studio-tool');
    const stateMod = await import('../../../../src/main/features/video_studio_state');
    const opts = {
      userId: UID,
      cid: 'cid-narration-new-intent-after-exhaustion',
      turnId: 'turn-narration-new-intent-initial',
      agentId: VIDEO_STUDIO_AGENT_ID,
      agentName: 'VideoStudio',
      userMessage: '确认',
    };
    const tool = toolMod.createVideoStudioTool(opts);
    const ctx = { workingDir: workspace, state: {} } as any;
    for (const op of ['composition.approve_plan', 'composition.doctor', 'composition.prepare']) {
      expect((await tool.execute(compositionInput(op), ctx)).isError).toBe(false);
    }
    ttsMock.generateSpeech
      .mockResolvedValueOnce({
        ok: false,
        errorCode: 'E_TTS_PROVIDER_TIMEOUT',
        message: 'The first provider outcome is unknown.',
        requestDisposition: 'sent',
        chargeStatus: 'unknown',
        retryPolicy: 'unknown',
      })
      .mockResolvedValueOnce({
        ok: false,
        errorCode: 'E_TTS_PROVIDER_TIMEOUT',
        message: 'The retry provider outcome is unknown.',
        requestDisposition: 'sent',
        chargeStatus: 'unknown',
        retryPolicy: 'unknown',
      });

    expect((await tool.execute({
      op: 'composition.materialize_narration',
      composition_dir: 'project/composition',
    }, ctx)).isError).toBe(true);
    const retryTool = toolMod.createVideoStudioTool({
      ...opts,
      turnId: 'turn-narration-new-intent-retry',
      userMessage: approvalSubmission('narration_retry_decision', 'approve'),
    });
    const exhausted = await retryTool.execute({
      op: 'composition.materialize_narration',
      composition_dir: 'project/composition',
    }, ctx);
    expect(parseResult(exhausted.content)).toMatchObject({
      errorCode: 'E_TTS_RETRY_EPISODE_EXHAUSTED',
      narration_retry_episode: { failed_request_count: 2 },
    });
    expect(ttsMock.generateSpeech).toHaveBeenCalledTimes(2);

    const statePath = toolMod.videoStudioProductionStatePath(opts, compositionDir);
    const oldState = await stateMod.readVideoProductionState(statePath, compositionDir);
    const oldRequestSignature = oldState.narration_transaction?.request_signature;
    expect(oldRequestSignature).toMatch(/^[a-f0-9]{64}$/);

    const revisedNarration = 'Speak once, with one revised closing line.';
    fs.writeFileSync(
      path.join(workspace, 'project', 'script.md'),
      `# Approved amended script\n\n${revisedNarration}`,
      'utf8',
    );
    const shotlistPath = path.join(workspace, 'project', 'shotlist.json');
    const shotlist = JSON.parse(fs.readFileSync(shotlistPath, 'utf8'));
    shotlist.shots[0].narration = revisedNarration;
    fs.writeFileSync(shotlistPath, JSON.stringify(shotlist, null, 2), 'utf8');
    const manifestPath = path.join(compositionDir, 'composition-manifest.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    manifest.scenes[0].narration_text = revisedNarration;
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');

    const amendmentTool = toolMod.createVideoStudioTool({
      ...opts,
      turnId: 'turn-narration-new-intent-approved',
      userMessage: approvalSubmission('gate_b_decision', 'approve'),
    });
    const amended = await amendmentTool.execute({
      op: 'composition.approve_plan',
      composition_dir: 'project/composition',
    }, ctx);
    expect(amended.isError, String(amended.content)).toBe(false);
    expect(parseResult(amended.content)).toMatchObject({
      plan_changed: true,
      next_action: 'composition.doctor',
    });
    for (const op of ['composition.doctor', 'composition.prepare']) {
      expect((await amendmentTool.execute({
        op,
        composition_dir: 'project/composition',
      }, ctx)).isError).toBe(false);
    }

    ttsMock.generateSpeech.mockImplementationOnce(async (request: { outputAbsPath: string }) => {
      fs.writeFileSync(request.outputAbsPath, Buffer.from('fresh narration intent audio'));
      return {
        ok: true,
        path: request.outputAbsPath,
        bytes: fs.statSync(request.outputAbsPath).size,
        backend: 'mock-voice',
      };
    });
    const fresh = await amendmentTool.execute({
      op: 'composition.materialize_narration',
      composition_dir: 'project/composition',
    }, ctx);
    expect(fresh.isError, String(fresh.content)).toBe(false);
    expect(parseResult(fresh.content)).toMatchObject({
      ok: true,
      billable_request_sent: true,
    });
    expect(ttsMock.generateSpeech).toHaveBeenCalledTimes(3);

    const freshState = await stateMod.readVideoProductionState(statePath, compositionDir);
    expect(freshState.narration?.text_sha256).not.toBe(oldState.narration_transaction?.text_sha256);
    expect(freshState.narration_transaction).toBeUndefined();
    expect(freshState.narration_transaction_history).toEqual(expect.arrayContaining([
      expect.objectContaining({ request_signature: oldRequestSignature }),
    ]));
  });

  it('does not redispatch narration after interruption at the provider boundary', async () => {
    useSchema2Narration();
    const toolMod = await import('../../../../src/main/model/core-agent/video-studio-tool');
    const stateMod = await import('../../../../src/main/features/video_studio_state');
    const opts = {
      userId: UID,
      cid: 'cid-narration-provider-boundary-interruption',
      turnId: 'turn-narration-provider-boundary-interruption',
      agentId: VIDEO_STUDIO_AGENT_ID,
      agentName: 'VideoStudio',
      userMessage: '确认',
    };
    const tool = toolMod.createVideoStudioTool(opts);
    const ctx = { workingDir: workspace, state: {} } as any;
    for (const op of ['composition.approve_plan', 'composition.doctor', 'composition.prepare']) {
      expect((await tool.execute(compositionInput(op), ctx)).isError).toBe(false);
    }
    ttsMock.generateSpeech.mockRejectedValue(new Error('simulated process interruption'));

    const interrupted = await tool.execute({
      op: 'composition.materialize_narration',
      composition_dir: 'project/composition',
    }, ctx);
    expect(interrupted.isError).toBe(true);
    expect(parseResult(interrupted.content)).toMatchObject({
      errorCode: 'E_TTS_AUDIO_MISSING',
      billable_request_sent: true,
      request_disposition: 'sent',
      requires_user_decision: true,
      candidate_completeness: 'visual_only',
    });
    expect(ttsMock.generateSpeech).toHaveBeenCalledTimes(1);

    const statePath = toolMod.videoStudioProductionStatePath(opts, compositionDir);
    expect((await stateMod.readVideoProductionState(statePath, compositionDir))
      .narration_transaction).toMatchObject({
      status: 'failed',
      request_disposition: 'sent',
    });
    // Recreate the exact durable boundary left by a hard process stop: the
    // pending ledger is on disk, but no post-dispatch result was recorded.
    await stateMod.updateVideoProductionState(statePath, compositionDir, (state) => {
      if (!state.narration_transaction) throw new Error('narration transaction is required');
      state.narration_transaction.status = 'pending';
      state.narration_transaction.request_disposition = 'not_sent';
      state.narration_transaction.charge_status = 'unknown';
      state.narration_transaction.retry_policy = 'unknown';
      delete state.narration_transaction.error_code;
    });

    const resumed = await tool.execute({
      op: 'composition.materialize_narration',
      composition_dir: 'project/composition',
    }, ctx);
    expect(resumed.isError).toBe(true);
    expect(parseResult(resumed.content)).toMatchObject({
      errorCode: 'E_TTS_AUDIO_MISSING',
      billable_request_sent: false,
      request_disposition: 'sent',
      requires_user_decision: true,
      blocked_scope: 'narration_and_complete_delivery_only',
      candidate_completeness: 'visual_only',
      narration_retry_offer: {
        previous_request_outcome: 'unknown',
        new_billable_request_count: 1,
      },
      next_action: 'continue_visual_preview_then_request_narration_retry_decision',
    });
    expect(ttsMock.generateSpeech).toHaveBeenCalledTimes(1);
    expect((await stateMod.readVideoProductionState(statePath, compositionDir))
      .narration_transaction).toMatchObject({
      status: 'failed',
      error_code: 'E_TTS_AUDIO_MISSING',
      request_disposition: 'sent',
      retry_policy: 'requires_user_action',
    });
  });

  it('does not redispatch when the provider reports success without a readable audio artifact', async () => {
    useSchema2Narration();
    const toolMod = await import('../../../../src/main/model/core-agent/video-studio-tool');
    const opts = {
      userId: UID,
      cid: 'cid-narration-success-without-file',
      turnId: 'turn-narration-success-without-file',
      agentId: VIDEO_STUDIO_AGENT_ID,
      agentName: 'VideoStudio',
      userMessage: '确认',
    };
    const tool = toolMod.createVideoStudioTool(opts);
    const ctx = { workingDir: workspace, state: {} } as any;
    for (const op of ['composition.approve_plan', 'composition.doctor', 'composition.prepare']) {
      expect((await tool.execute(compositionInput(op), ctx)).isError).toBe(false);
    }
    ttsMock.generateSpeech.mockResolvedValue({
      ok: true,
      path: path.join(compositionDir, 'assets', 'narration.mp3'),
      bytes: 42,
      backend: 'mock-voice',
    });

    const missing = await tool.execute({
      op: 'composition.materialize_narration',
      composition_dir: 'project/composition',
    }, ctx);
    expect(missing.isError).toBe(true);
    expect(parseResult(missing.content)).toMatchObject({
      errorCode: 'E_TTS_AUDIO_MISSING',
      billable_request_sent: true,
      request_disposition: 'sent',
      requires_user_decision: true,
      candidate_completeness: 'visual_only',
      next_action: 'continue_visual_preview_then_request_narration_retry_decision',
    });
    expect(ttsMock.generateSpeech).toHaveBeenCalledTimes(1);

    const resumed = await tool.execute({
      op: 'composition.materialize_narration',
      composition_dir: 'project/composition',
    }, ctx);
    expect(resumed.isError).toBe(true);
    expect(parseResult(resumed.content)).toMatchObject({
      errorCode: 'E_TTS_RETRY_REQUIRES_USER_ACTION',
      requires_user_decision: true,
    });
    expect(ttsMock.generateSpeech).toHaveBeenCalledTimes(1);
  });

  it('persists paid narration before local duration probing and resumes without another request', async () => {
    useSchema2Narration();
    const toolMod = await import('../../../../src/main/model/core-agent/video-studio-tool');
    const stateMod = await import('../../../../src/main/features/video_studio_state');
    const opts = {
      userId: UID,
      cid: 'cid-narration-duration-probe-recovery',
      turnId: 'turn-narration-duration-probe-recovery',
      agentId: VIDEO_STUDIO_AGENT_ID,
      agentName: 'VideoStudio',
      userMessage: '确认',
    };
    const tool = toolMod.createVideoStudioTool(opts);
    const ctx = { workingDir: workspace, state: {} } as any;
    for (const op of ['composition.approve_plan', 'composition.doctor', 'composition.prepare']) {
      expect((await tool.execute(compositionInput(op), ctx)).isError).toBe(false);
    }
    ttsMock.generateSpeech.mockImplementation(async (request: { outputAbsPath: string }) => {
      fs.mkdirSync(path.dirname(request.outputAbsPath), { recursive: true });
      fs.writeFileSync(request.outputAbsPath, Buffer.from('paid narration awaiting local probe'));
      return {
        ok: true,
        path: request.outputAbsPath,
        bytes: fs.statSync(request.outputAbsPath).size,
        backend: 'mock-voice',
      };
    });
    mediaProbeMock.duration
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(4.8);

    const probeFailed = await tool.execute({
      op: 'composition.materialize_narration',
      composition_dir: 'project/composition',
    }, ctx);
    expect(probeFailed.isError).toBe(true);
    expect(parseResult(probeFailed.content)).toMatchObject({
      errorCode: 'E_TTS_DURATION_UNAVAILABLE',
      billable_request_sent: true,
      requires_user_decision: false,
      user_reconfirmation_required: false,
      automatic_recovery_expected: true,
      next_action: 'repair_media_probe_then_resume_same_narration_transaction',
    });
    expect(ttsMock.generateSpeech).toHaveBeenCalledTimes(1);

    const statePath = toolMod.videoStudioProductionStatePath(opts, compositionDir);
    expect((await stateMod.readVideoProductionState(statePath, compositionDir))
      .narration_transaction).toMatchObject({
      status: 'synthesized',
      request_disposition: 'sent',
      audio_sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
    });

    const resumed = await tool.execute({
      op: 'composition.materialize_narration',
      composition_dir: 'project/composition',
    }, ctx);
    expect(resumed.isError, String(resumed.content)).toBe(false);
    expect(parseResult(resumed.content)).toMatchObject({
      ok: true,
      status: 'recovered',
      billable_request_sent: false,
      measured_duration_sec: 4.8,
    });
    expect(ttsMock.generateSpeech).toHaveBeenCalledTimes(1);
  });

  it('consumes a direct narration-retry rejection without sending or asking again', async () => {
    useSchema2Narration();
    const toolMod = await import('../../../../src/main/model/core-agent/video-studio-tool');
    const opts = {
      userId: UID,
      cid: 'cid-narration-retry-rejected',
      turnId: 'turn-narration-retry-initial',
      agentId: VIDEO_STUDIO_AGENT_ID,
      agentName: 'VideoStudio',
      userMessage: '确认',
    };
    const tool = toolMod.createVideoStudioTool(opts);
    const ctx = { workingDir: workspace, state: {} } as any;
    for (const op of ['composition.approve_plan', 'composition.doctor', 'composition.prepare']) {
      expect((await tool.execute(compositionInput(op), ctx)).isError).toBe(false);
    }
    ttsMock.generateSpeech.mockResolvedValue({
      ok: false,
      errorCode: 'E_TTS_PROVIDER_TIMEOUT',
      message: 'The provider outcome is unknown.',
      requestDisposition: 'sent',
      chargeStatus: 'unknown',
      retryPolicy: 'unknown',
    });
    expect((await tool.execute({
      op: 'composition.materialize_narration',
      composition_dir: 'project/composition',
    }, ctx)).isError).toBe(true);

    const reply = '不要重试旁白，先保留当前画面。';
    const rejectTool = toolMod.createVideoStudioTool({
      ...opts,
      turnId: 'turn-narration-retry-rejected',
      userMessage: `<msg from="user">${reply}</msg>`,
    });
    const rejected = await rejectTool.execute({
      op: 'composition.materialize_narration',
      composition_dir: 'project/composition',
      decision_evidence: decisionEvidence('narration_retry', 'reject', reply),
    }, ctx);
    expect(rejected.isError).toBe(true);
    expect(parseResult(rejected.content)).toMatchObject({
      errorCode: 'E_TTS_RETRY_NOT_AUTHORIZED',
      billable_request_sent: false,
      requires_user_decision: false,
      decision_source: 'model_interpreted_user_message',
      candidate_completeness: 'visual_only',
      next_action: 'continue_with_current_visual_candidate_without_resending_narration',
    });
    expect(parseResult(rejected.content)).not.toHaveProperty('narration_retry_offer');
    expect(ttsMock.generateSpeech).toHaveBeenCalledTimes(1);
  });

  it('persists one retry authorization across non-billable metadata reconciliation and dispatches it once', async () => {
    useSchema2Narration('Vivi');
    const toolMod = await import('../../../../src/main/model/core-agent/video-studio-tool');
    const stateMod = await import('../../../../src/main/features/video_studio_state');
    const opts = {
      userId: UID,
      cid: 'cid-persisted-narration-retry',
      turnId: 'turn-persisted-narration-initial',
      agentId: VIDEO_STUDIO_AGENT_ID,
      agentName: 'VideoStudio',
      userMessage: '确认',
    };
    const tool = toolMod.createVideoStudioTool(opts);
    const ctx = { workingDir: workspace, state: {} } as any;
    for (const op of ['composition.approve_plan', 'composition.doctor', 'composition.prepare']) {
      expect((await tool.execute(compositionInput(op), ctx)).isError).toBe(false);
    }
    ttsMock.generateSpeech.mockResolvedValueOnce({
      ok: false,
      errorCode: 'E_TTS_PROVIDER_TIMEOUT',
      message: 'The provider did not return a conclusive result.',
      requestDisposition: 'sent',
      chargeStatus: 'unknown',
      retryPolicy: 'unknown',
    });
    expect((await tool.execute({
      op: 'composition.materialize_narration',
      composition_dir: 'project/composition',
    }, ctx)).isError).toBe(true);
    expect(ttsMock.generateSpeech).toHaveBeenCalledTimes(1);

    const manifestPath = path.join(compositionDir, 'composition-manifest.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    manifest.audio.narration_intent.display_name = 'vivi 2.0';
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');

    const retryMessage = '确认，只重新发送一次旁白';
    const retryTool = toolMod.createVideoStudioTool({
      ...opts,
      turnId: 'turn-persisted-narration-approval',
      userMessage: retryMessage,
    });
    const locallyBlocked = await retryTool.execute({
      op: 'composition.materialize_narration',
      composition_dir: 'project/composition',
      decision_evidence: decisionEvidence(
        'narration_retry',
        'approve',
        retryMessage,
      ),
    }, ctx);
    expect(locallyBlocked.isError).toBe(true);
    expect(parseResult(locallyBlocked.content)).toMatchObject({
      errorCode: 'E_NARRATION_PREPARE_STALE',
    });
    expect(locallyBlocked.content).not.toContain('E_TTS_INTENT_LABEL_MISMATCH');
    expect(ttsMock.generateSpeech).toHaveBeenCalledTimes(1);

    const statePath = toolMod.videoStudioProductionStatePath(opts, compositionDir);
    const authorized = await stateMod.readVideoProductionState(statePath, compositionDir);
    expect(authorized.narration_retry_authorization).toMatchObject({
      request_signature: authorized.narration_transaction?.request_signature,
      failed_transaction_id: authorized.narration_transaction?.transaction_id,
      authorized_turn_id: 'turn-persisted-narration-approval',
      consumed_new_requests: 0,
    });

    const reconciled = await tool.execute({
      op: 'composition.reconcile',
      composition_dir: 'project/composition',
    }, ctx);
    expect(reconciled.isError, String(reconciled.content)).toBe(false);

    ttsMock.generateSpeech.mockImplementationOnce(async (request: { outputAbsPath: string }) => {
      fs.writeFileSync(request.outputAbsPath, Buffer.from('authorized-retry-narration'));
      return {
        ok: true,
        path: request.outputAbsPath,
        bytes: fs.statSync(request.outputAbsPath).size,
        backend: 'mock-voice',
      };
    });
    const resumedTool = toolMod.createVideoStudioTool({
      ...opts,
      turnId: 'turn-persisted-narration-resume',
      userMessage: '继续制作',
    });
    const resumed = await resumedTool.execute({
      op: 'composition.materialize_narration',
      composition_dir: 'project/composition',
    }, ctx);
    expect(resumed.isError, String(resumed.content)).toBe(false);
    expect(parseResult(resumed.content)).toMatchObject({
      ok: true,
      status: 'passed',
      billable_request_sent: true,
    });
    expect(ttsMock.generateSpeech).toHaveBeenCalledTimes(2);
    const finalState = await stateMod.readVideoProductionState(statePath, compositionDir);
    expect(finalState.narration_retry_authorization).toBeUndefined();
    expect(finalState.narration).toMatchObject({ status: 'materialized' });
    expect(finalState.narration_transaction_history).toHaveLength(1);
  });

  it('records a local narrated plan and reconstructs missing measured-repair evidence without a second TTS request', async () => {
    const toolMod = await import('../../../../src/main/model/core-agent/video-studio-tool');
    const stateMod = await import('../../../../src/main/features/video_studio_state');
    fs.copyFileSync(
      path.join(workspace, 'project', 'script.md'),
      path.join(compositionDir, 'script.md'),
    );
    fs.copyFileSync(
      path.join(workspace, 'project', 'shotlist.json'),
      path.join(compositionDir, 'shotlist.json'),
    );
    mediaProbeMock.duration.mockResolvedValue(6.2);
    ttsMock.generateSpeech.mockImplementation(async (input: { outputAbsPath: string }) => {
      fs.mkdirSync(path.dirname(input.outputAbsPath), { recursive: true });
      fs.writeFileSync(input.outputAbsPath, Buffer.from('one paid local-layout narration'));
      return {
        ok: true,
        backend: 'mock-voice',
        bytes: fs.statSync(input.outputAbsPath).size,
      };
    });
    const opts = {
      userId: UID,
      cid: 'cid-local-plan-repair',
      turnId: 'turn-local-plan',
      agentId: VIDEO_STUDIO_AGENT_ID,
      agentName: 'VideoStudio',
      userMessage: '确认',
    };
    const tool = toolMod.createVideoStudioTool(opts);
    const ctx = { workingDir: workspace, state: {} } as any;
    for (const op of ['composition.approve_plan', 'composition.doctor', 'composition.prepare']) {
      expect((await tool.execute(compositionInput(op), ctx)).isError).toBe(false);
    }
    const statePath = toolMod.videoStudioProductionStatePath(opts, compositionDir);
    const approved = await stateMod.readVideoProductionState(statePath, compositionDir);
    expect(approved.plan_approval).toMatchObject({
      validation_version: 3,
      artifact_records: {
        script: { path: path.join(compositionDir, 'script.md') },
        shotlist: { path: path.join(compositionDir, 'shotlist.json') },
      },
    });

    const firstMismatch = await tool.execute({
      op: 'composition.materialize_narration',
      composition_dir: 'project/composition',
    }, ctx);
    expect(firstMismatch.isError).toBe(true);
    expect(parseResult(firstMismatch.content)).toMatchObject({
      errorCode: 'E_TTS_MEASURED_DURATION_MISMATCH',
      billable_request_sent: true,
    });
    expect(ttsMock.generateSpeech).toHaveBeenCalledTimes(1);
    expect((await stateMod.readVideoProductionState(statePath, compositionDir)).narration_repair)
      .toMatchObject({ source: 'measured_duration_mismatch' });

    await stateMod.updateVideoProductionState(statePath, compositionDir, (state) => {
      delete state.narration_repair;
    });
    const recoveredMismatch = await tool.execute({
      op: 'composition.materialize_narration',
      composition_dir: 'project/composition',
    }, ctx);
    expect(recoveredMismatch.isError).toBe(true);
    expect(parseResult(recoveredMismatch.content)).toMatchObject({
      errorCode: 'E_TTS_MEASURED_DURATION_MISMATCH',
      billable_request_sent: false,
    });
    expect(ttsMock.generateSpeech).toHaveBeenCalledTimes(1);
    expect((await stateMod.readVideoProductionState(statePath, compositionDir)).narration_repair)
      .toMatchObject({ source: 'measured_duration_mismatch' });
  });

  it('discovers a complete plan bundle outside expected directories instead of selecting an incomplete local file', async () => {
    const toolMod = await import('../../../../src/main/model/core-agent/video-studio-tool');
    const stateMod = await import('../../../../src/main/features/video_studio_state');
    const approvedPlanDir = path.join(workspace, 'project', 'briefs', 'approved');
    fs.mkdirSync(approvedPlanDir, { recursive: true });
    const approvedScriptPath = path.join(approvedPlanDir, 'script.md');
    const approvedShotlistPath = path.join(approvedPlanDir, 'shotlist.json');
    fs.renameSync(path.join(workspace, 'project', 'script.md'), approvedScriptPath);
    fs.renameSync(path.join(workspace, 'project', 'shotlist.json'), approvedShotlistPath);
    fs.writeFileSync(
      path.join(compositionDir, 'script.md'),
      '# Unfinished local draft\n\nThis file has no matching local shotlist.',
      'utf8',
    );
    const opts = {
      userId: UID,
      cid: 'cid-partial-local-plan',
      turnId: 'turn-partial-local-plan',
      agentId: VIDEO_STUDIO_AGENT_ID,
      agentName: 'VideoStudio',
      userMessage: '确认',
    };
    const tool = toolMod.createVideoStudioTool(opts);
    const ctx = { workingDir: workspace, state: {} } as any;
    const approved = await tool.execute({
      op: 'composition.approve_plan',
      composition_dir: 'project/composition',
      decision_evidence: decisionEvidence('plan', 'approve', '确认'),
    }, ctx);
    expect(approved.isError).toBe(false);
    const statePath = toolMod.videoStudioProductionStatePath(opts, compositionDir);
    expect((await stateMod.readVideoProductionState(statePath, compositionDir))
      .plan_approval?.artifact_records).toMatchObject({
      script: { path: approvedScriptPath },
      shotlist: { path: approvedShotlistPath },
    });
  });

  it('reconciles compound state drift and resumes production without a user recovery gate', async () => {
    makePlanVisualOnly();
    const toolMod = await import('../../../../src/main/model/core-agent/video-studio-tool');
    const stateMod = await import('../../../../src/main/features/video_studio_state');
    const opts = {
      userId: UID,
      cid: 'cid-compound-state-recovery',
      turnId: 'turn-compound-state-recovery',
      agentId: VIDEO_STUDIO_AGENT_ID,
      agentName: 'VideoStudio',
      userMessage: '继续',
    };
    const tool = toolMod.createVideoStudioTool(opts);
    const ctx = { workingDir: workspace, state: {}, emitProgress: vi.fn() } as any;
    expect((await tool.execute({
      op: 'composition.approve_plan',
      composition_dir: 'project/composition',
      decision_evidence: decisionEvidence('plan', 'approve', '继续'),
    }, ctx)).isError).toBe(false);

    const statePath = toolMod.videoStudioProductionStatePath(opts, compositionDir);
    const contentHash = await toolMod.videoStudioCompositionSignature(compositionDir);
    const projectDir = path.join(workspace, 'project');
    const relocatedDir = path.join(projectDir, 'planning', 'approved');
    fs.mkdirSync(relocatedDir, { recursive: true });
    const relocatedScript = path.join(relocatedDir, 'script.md');
    const relocatedShotlist = path.join(relocatedDir, 'shotlist.json');
    fs.renameSync(path.join(projectDir, 'script.md'), relocatedScript);
    fs.renameSync(path.join(projectDir, 'shotlist.json'), relocatedShotlist);

    await stateMod.updateVideoProductionState(statePath, compositionDir, (state) => {
      const startedAt = new Date(0).toISOString();
      state.stage = 'draft_approved';
      state.artifacts = { composition_signature: contentHash };
      state.active_operation = {
        operation_id: 'orphaned-snapshot',
        op: 'composition.snapshot',
        input_hash: contentHash,
        stage: 'preview_ready',
        revision: state.revision + 1,
        started_at: startedAt,
      };
      state.operation_journal = [{
        operation_id: 'orphaned-snapshot',
        op: 'composition.snapshot',
        input_hash: contentHash,
        status: 'started',
        started_at: startedAt,
      }];
      state.draft = {
        gate: 'D',
        status: 'approved',
        signature: 'stale-draft-signature',
        turn_id: 'turn-stale-draft',
        created_at: startedAt,
        validation_version: 5,
      };
      state.current_candidate = {
        revision_id: `candidate-${contentHash.slice(0, 16)}`,
        content_hash: contentHash,
        artifacts: { composition_signature: contentHash },
        locators: {
          html_path: path.join(compositionDir, 'index.html'),
          manifest_path: path.join(compositionDir, 'composition-manifest.json'),
        },
        runtime_fingerprint: 'compound-state-fixture',
        created_at: startedAt,
        last_observed_at: startedAt,
        last_observed_op: 'composition.inspect',
      };
    });

    const statusBefore = parseResult((await tool.execute({
      op: 'composition.status',
      composition_dir: 'project/composition',
    }, ctx)).content);
    expect(statusBefore).toMatchObject({
      reconciliation_required: true,
      plan_record_refresh_required: true,
      plan_artifact_conflict: false,
      production_state: {
        active_operation: { operation_id: 'orphaned-snapshot' },
        draft_status: 'approved',
        current_candidate: {
          revision_id: `candidate-${contentHash.slice(0, 16)}`,
        },
      },
    });

    const reconciled = await tool.execute({
      op: 'composition.reconcile',
      composition_dir: 'project/composition',
    }, ctx);
    expect(reconciled.isError).toBe(false);
    const recovered = parseResult(reconciled.content);
    expect(recovered).toMatchObject({
      ok: true,
      status: 'reconciled',
      plan_record_refreshed: true,
      production_state: {
        stage: 'visuals_ready',
        draft_status: 'missing',
        current_candidate: {
          revision_id: expect.stringMatching(/^candidate-/),
          parent_revision_id: `candidate-${contentHash.slice(0, 16)}`,
        },
        candidate_history: [expect.objectContaining({
          revision_id: `candidate-${contentHash.slice(0, 16)}`,
          content_hash: contentHash,
        })],
        operation_journal: [expect.objectContaining({
          operation_id: 'orphaned-snapshot',
          status: 'interrupted',
          error_code: 'E_VIDEO_PRODUCTION_OPERATION_INTERRUPTED',
          consumes_same_input_attempt: false,
        })],
        next_allowed_ops: expect.arrayContaining([
          'composition.prepare',
          'composition.lint',
          'composition.inspect',
          'composition.snapshot',
        ]),
      },
    });
    expect(recovered.production_state).not.toHaveProperty('active_operation');
    expect(recovered.production_state.plan_approval.artifact_records).toMatchObject({
      script: { path: relocatedScript },
      shotlist: { path: relocatedShotlist },
    });

    const statusAfter = parseResult((await tool.execute({
      op: 'composition.status',
      composition_dir: 'project/composition',
    }, ctx)).content);
    expect(statusAfter).toMatchObject({
      reconciliation_required: false,
      plan_record_refresh_required: false,
      plan_artifact_conflict: false,
    });

    const resumed = await tool.execute({
      op: 'composition.prepare',
      composition_dir: 'project/composition',
    }, ctx);
    expect(resumed.isError).toBe(false);
    expect(ttsMock.generateSpeech).not.toHaveBeenCalled();
  });

  it('adopts a completed file write after a crash before the candidate ledger update', async () => {
    makePlanVisualOnly();
    const toolMod = await import('../../../../src/main/model/core-agent/video-studio-tool');
    const stateMod = await import('../../../../src/main/features/video_studio_state');
    const opts = {
      userId: UID,
      cid: 'cid-write-before-ledger-recovery',
      turnId: 'turn-write-before-ledger-recovery',
      agentId: VIDEO_STUDIO_AGENT_ID,
      agentName: 'VideoStudio',
      userMessage: '继续',
    };
    const tool = toolMod.createVideoStudioTool(opts);
    const ctx = { workingDir: workspace, state: {}, emitProgress: vi.fn() } as any;
    expect((await tool.execute({
      op: 'composition.approve_plan',
      composition_dir: 'project/composition',
      decision_evidence: decisionEvidence('plan', 'approve', '继续'),
    }, ctx)).isError).toBe(false);

    const statePath = toolMod.videoStudioProductionStatePath(opts, compositionDir);
    expect((await tool.execute({
      op: 'composition.reconcile',
      composition_dir: 'project/composition',
    }, ctx)).isError).toBe(false);
    const beforeCrash = await stateMod.readVideoProductionState(statePath, compositionDir);
    const oldCandidate = beforeCrash.current_candidate;
    expect(oldCandidate?.content_hash).toMatch(/^[a-f0-9]{64}$/);
    await stateMod.updateVideoProductionState(statePath, compositionDir, (state) => {
      const now = new Date().toISOString();
      state.preview = {
        gate: 'HTML_PREVIEW',
        status: 'approved',
        signature: oldCandidate!.content_hash,
        turn_id: 'turn-old-preview',
        created_at: now,
        approved_turn_id: 'turn-old-preview-approved',
        approved_at: now,
        validation_version: 5,
      };
      state.stage = 'preview_approved';
    });

    const htmlPath = path.join(compositionDir, 'index.html');
    fs.appendFileSync(htmlPath, '\n<!-- durable author edit written before ledger commit -->\n');
    const newContentHash = await toolMod.videoStudioCompositionSignature(compositionDir);
    expect(newContentHash).not.toBe(oldCandidate!.content_hash);

    const reported = parseResult((await tool.execute({
      op: 'composition.status',
      composition_dir: 'project/composition',
    }, ctx)).content);
    expect(reported).toMatchObject({
      artifact_drift: true,
      reconciliation_required: true,
      production_state: {
        preview_status: 'approved',
        current_candidate: {
          content_hash: oldCandidate!.content_hash,
        },
      },
    });

    const reconciled = await tool.execute({
      op: 'composition.reconcile',
      composition_dir: 'project/composition',
    }, ctx);
    expect(reconciled.isError).toBe(false);
    const recovered = parseResult(reconciled.content);
    expect(recovered).toMatchObject({
      status: 'reconciled',
      production_state: {
        stage: 'visuals_ready',
        preview_status: 'missing',
        draft_status: 'missing',
        current_candidate: {
          content_hash: newContentHash,
          parent_revision_id: oldCandidate!.revision_id,
        },
        candidate_history: [expect.objectContaining({
          revision_id: oldCandidate!.revision_id,
          content_hash: oldCandidate!.content_hash,
        })],
      },
    });
    expect(recovered.production_state).not.toHaveProperty('active_operation');
    expect(recovered.production_state.next_allowed_ops).toEqual(expect.arrayContaining([
      'composition.lint',
      'composition.inspect',
      'composition.snapshot',
    ]));
  });

  it('marks a ledger-started operation retryable when a crash produced no output file', async () => {
    makePlanVisualOnly();
    const toolMod = await import('../../../../src/main/model/core-agent/video-studio-tool');
    const stateMod = await import('../../../../src/main/features/video_studio_state');
    const opts = {
      userId: UID,
      cid: 'cid-ledger-before-write-recovery',
      turnId: 'turn-ledger-before-write-recovery',
      agentId: VIDEO_STUDIO_AGENT_ID,
      agentName: 'VideoStudio',
      userMessage: '继续',
    };
    const tool = toolMod.createVideoStudioTool(opts);
    const ctx = { workingDir: workspace, state: {}, emitProgress: vi.fn() } as any;
    expect((await tool.execute({
      op: 'composition.approve_plan',
      composition_dir: 'project/composition',
      decision_evidence: decisionEvidence('plan', 'approve', '继续'),
    }, ctx)).isError).toBe(false);
    expect((await tool.execute({
      op: 'composition.reconcile',
      composition_dir: 'project/composition',
    }, ctx)).isError).toBe(false);

    const statePath = toolMod.videoStudioProductionStatePath(opts, compositionDir);
    const contentHash = await toolMod.videoStudioCompositionSignature(compositionDir);
    await stateMod.updateVideoProductionState(statePath, compositionDir, (state) => {
      const startedAt = new Date(0).toISOString();
      state.preview = {
        gate: 'HTML_PREVIEW',
        status: 'approved',
        signature: contentHash,
        turn_id: 'turn-preview-ready',
        created_at: startedAt,
        approved_turn_id: 'turn-preview-approved',
        approved_at: startedAt,
        validation_version: 5,
      };
      state.stage = 'preview_approved';
      state.active_operation = {
        operation_id: 'draft-started-without-output',
        op: 'composition.draft',
        input_hash: contentHash,
        stage: 'draft_ready',
        revision: state.revision + 1,
        started_at: startedAt,
      };
      state.operation_journal = [{
        operation_id: 'draft-started-without-output',
        op: 'composition.draft',
        input_hash: contentHash,
        status: 'started',
        started_at: startedAt,
      }];
    });

    const reported = parseResult((await tool.execute({
      op: 'composition.status',
      composition_dir: 'project/composition',
    }, ctx)).content);
    expect(reported).toMatchObject({
      artifact_drift: false,
      reconciliation_required: true,
      production_state: {
        stage: 'preview_approved',
        preview_status: 'approved',
        draft_status: 'missing',
        active_operation: {
          operation_id: 'draft-started-without-output',
        },
      },
    });

    const reconciled = await tool.execute({
      op: 'composition.reconcile',
      composition_dir: 'project/composition',
    }, ctx);
    expect(reconciled.isError).toBe(false);
    const recovered = parseResult(reconciled.content);
    expect(recovered).toMatchObject({
      status: 'reconciled',
      production_state: {
        stage: 'preview_approved',
        preview_status: 'approved',
        draft_status: 'missing',
        operation_journal: [expect.objectContaining({
          operation_id: 'draft-started-without-output',
          status: 'interrupted',
          error_code: 'E_VIDEO_PRODUCTION_OPERATION_INTERRUPTED',
          consumes_same_input_attempt: false,
        })],
      },
    });
    expect(recovered.production_state).not.toHaveProperty('active_operation');
    expect(recovered.production_state.next_allowed_ops).toContain('composition.draft');
  });

  it('finds approved plan files by content hash after they move and refreshes their recorded paths', async () => {
    const toolMod = await import('../../../../src/main/model/core-agent/video-studio-tool');
    const stateMod = await import('../../../../src/main/features/video_studio_state');
    const opts = {
      userId: UID,
      cid: 'cid-plan-file-relocation',
      turnId: 'turn-plan-file-relocation',
      agentId: VIDEO_STUDIO_AGENT_ID,
      agentName: 'VideoStudio',
      userMessage: '确认',
    };
    const tool = toolMod.createVideoStudioTool(opts);
    const ctx = { workingDir: workspace, state: {} } as any;
    expect((await tool.execute({
      op: 'composition.approve_plan',
      composition_dir: 'project/composition',
      decision_evidence: decisionEvidence('plan', 'approve', '确认'),
    }, ctx)).isError).toBe(false);

    const relocatedDir = path.join(workspace, 'project', 'planning', 'approved');
    fs.mkdirSync(relocatedDir, { recursive: true });
    const relocatedScript = path.join(relocatedDir, 'script.md');
    const relocatedShotlist = path.join(relocatedDir, 'shotlist.json');
    fs.renameSync(path.join(workspace, 'project', 'script.md'), relocatedScript);
    fs.renameSync(path.join(workspace, 'project', 'shotlist.json'), relocatedShotlist);

    const status = await tool.execute({
      op: 'composition.status',
      composition_dir: 'project/composition',
    }, ctx);
    expect(status.isError).toBe(false);
    expect(parseResult(status.content)).toMatchObject({
      reconciliation_required: true,
      plan_record_refresh_required: true,
      plan_artifact_conflict: false,
    });
    const reconciled = await tool.execute({
      op: 'composition.reconcile',
      composition_dir: 'project/composition',
    }, ctx);
    expect(reconciled.isError).toBe(false);
    const prepared = await tool.execute({
      op: 'composition.prepare',
      composition_dir: 'project/composition',
    }, ctx);
    expect(prepared.isError).toBe(false);
    expect(ttsMock.generateSpeech).not.toHaveBeenCalled();
    const statePath = toolMod.videoStudioProductionStatePath(opts, compositionDir);
    const refreshed = await stateMod.readVideoProductionState(statePath, compositionDir);
    expect(refreshed.plan_approval?.artifact_records).toMatchObject({
      script: { path: relocatedScript },
      shotlist: { path: relocatedShotlist },
    });
  });

  it('finds a moved and reformatted plan bundle by its approved-intent content address', async () => {
    makePlanVisualOnly();
    const toolMod = await import('../../../../src/main/model/core-agent/video-studio-tool');
    const stateMod = await import('../../../../src/main/features/video_studio_state');
    const opts = {
      userId: UID,
      cid: 'cid-plan-relocated-and-formatted',
      turnId: 'turn-plan-relocated-and-formatted',
      agentId: VIDEO_STUDIO_AGENT_ID,
      agentName: 'VideoStudio',
      userMessage: '确认',
    };
    const tool = toolMod.createVideoStudioTool(opts);
    const ctx = { workingDir: workspace, state: {} } as any;
    expect((await tool.execute({
      op: 'composition.approve_plan',
      composition_dir: 'project/composition',
      decision_evidence: decisionEvidence('plan', 'approve', '确认'),
    }, ctx)).isError).toBe(false);
    const statePath = toolMod.videoStudioProductionStatePath(opts, compositionDir);
    const approvedState = await stateMod.readVideoProductionState(statePath, compositionDir);
    const approvedIntentHash = approvedState.plan_approval?.signature;

    const relocatedDir = path.join(workspace, 'project', 'planning', 'published');
    fs.mkdirSync(relocatedDir, { recursive: true });
    const relocatedScript = path.join(relocatedDir, 'script.md');
    const relocatedShotlist = path.join(relocatedDir, 'shotlist.json');
    const sourceScript = path.join(workspace, 'project', 'script.md');
    const sourceShotlist = path.join(workspace, 'project', 'shotlist.json');
    const decoyDir = path.join(workspace, 'project', 'planning', 'decoy');
    fs.mkdirSync(decoyDir, { recursive: true });
    fs.writeFileSync(
      path.join(decoyDir, 'script.md'),
      '# Different plan\n\nThis is not the approved intent.',
      'utf8',
    );
    fs.copyFileSync(sourceShotlist, path.join(decoyDir, 'shotlist.json'));
    fs.writeFileSync(
      relocatedScript,
      `${fs.readFileSync(sourceScript, 'utf8')}\n\n`,
      'utf8',
    );
    fs.writeFileSync(
      relocatedShotlist,
      JSON.stringify(JSON.parse(fs.readFileSync(sourceShotlist, 'utf8')), null, 2),
      'utf8',
    );
    fs.unlinkSync(sourceScript);
    fs.unlinkSync(sourceShotlist);

    const status = parseResult((await tool.execute({
      op: 'composition.status',
      composition_dir: 'project/composition',
    }, ctx)).content);
    expect(status).toMatchObject({
      plan_approval_current: true,
      plan_artifact_conflict: false,
      plan_record_refresh_required: true,
      approved_intent_hash: approvedIntentHash,
      candidate_intent_hash: approvedIntentHash,
    });
    const prepared = await tool.execute({
      op: 'composition.prepare',
      composition_dir: 'project/composition',
    }, ctx);
    expect(prepared.isError).toBe(false);
    expect((await stateMod.readVideoProductionState(statePath, compositionDir)).plan_approval)
      .toMatchObject({
        signature: approvedIntentHash,
        artifact_records: {
          script: { path: relocatedScript },
          shotlist: { path: relocatedShotlist },
        },
      });
    expect(ttsMock.generateSpeech).not.toHaveBeenCalled();
  });

  it.each([
    {
      label: 'script meaning',
      expectedPath: 'script',
      mutate: () => {
        fs.writeFileSync(
          path.join(workspace, 'project', 'script.md'),
          '# Approved script\n\nA materially different message.',
          'utf8',
        );
      },
    },
    {
      label: 'shotlist delivery contract',
      expectedPath: 'shotlist.music_mode',
      mutate: () => {
        const shotlistPath = path.join(workspace, 'project', 'shotlist.json');
        const shotlist = JSON.parse(fs.readFileSync(shotlistPath, 'utf8'));
        shotlist.music_mode = 'background';
        fs.writeFileSync(shotlistPath, JSON.stringify(shotlist), 'utf8');
      },
    },
    {
      label: 'manifest semantic roles',
      expectedPath: 'manifest.scenes[0].roles[2]',
      mutate: () => {
        const manifestPath = path.join(compositionDir, 'composition-manifest.json');
        const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
        manifest.scenes[0].roles.push('body');
        fs.writeFileSync(manifestPath, JSON.stringify(manifest), 'utf8');
      },
    },
  ])('invalidates downstream approvals when approved $label changes', async ({
    expectedPath,
    mutate,
  }) => {
    makePlanVisualOnly();
    const toolMod = await import('../../../../src/main/model/core-agent/video-studio-tool');
    const stateMod = await import('../../../../src/main/features/video_studio_state');
    const published: string[][] = [];
    const opts = {
      userId: UID,
      cid: `cid-semantic-negative-${expectedPath}`,
      turnId: `turn-semantic-negative-${expectedPath}`,
      agentId: VIDEO_STUDIO_AGENT_ID,
      agentName: 'VideoStudio',
      userMessage: '确认',
      onOutputsPublished: async (paths: string[]) => {
        published.push(paths);
        return paths;
      },
    };
    const tool = toolMod.createVideoStudioTool(opts);
    const ctx = { workingDir: workspace, state: {} } as any;
    expect((await tool.execute({
      op: 'composition.approve_plan',
      composition_dir: 'project/composition',
      decision_evidence: decisionEvidence('plan', 'approve', '确认'),
    }, ctx)).isError).toBe(false);
    const statePath = toolMod.videoStudioProductionStatePath(opts, compositionDir);
    const approvedState = await stateMod.readVideoProductionState(statePath, compositionDir);
    const approvedIntentHash = approvedState.plan_approval?.signature;
    const now = new Date().toISOString();
    await stateMod.updateVideoProductionState(statePath, compositionDir, (state) => {
      const downstream = {
        signature: 'stale-downstream-signature',
        turn_id: 'turn-stale-downstream',
        created_at: now,
        status: 'approved' as const,
        approved_turn_id: 'turn-stale-downstream-approved',
        approved_at: now,
        validation_version: 5 as const,
      };
      state.preview = { ...downstream };
      state.draft = { ...downstream };
    });

    mutate();
    const blocked = await tool.execute({
      op: 'composition.prepare',
      composition_dir: 'project/composition',
    }, ctx);
    expect(blocked.isError).toBe(true);
    const blockedResult = parseResult(blocked.content);
    expect(blockedResult).toMatchObject({
      errorCode: 'E_GATE_B_ARTIFACT_CHANGED',
      billable_request_sent: false,
      evidence: {
        conflicts: expect.arrayContaining([
          expect.objectContaining({ code: 'approved_intent_content_changed' }),
        ]),
        intent_changes: expect.arrayContaining([
          expect.objectContaining({ path: expectedPath }),
        ]),
      },
      review_package: {
        presentation_required: true,
        status: 'current_unapproved',
        conclusion: {
          outcome: 'blocked',
          error_code: 'E_GATE_B_ARTIFACT_CHANGED',
          next_action: 'inspect_plan_evidence_and_repair_current_artifacts',
        },
        primary_artifact: {
          role: 'script',
          review_status: 'current_input',
        },
        artifacts: expect.arrayContaining([
          expect.objectContaining({ role: 'script' }),
          expect.objectContaining({ role: 'shotlist' }),
          expect.objectContaining({ role: 'plan_manifest' }),
        ]),
      },
    });
    expect(published.flat()).toEqual(expect.arrayContaining([
      path.join(workspace, 'project', 'script.md'),
      path.join(workspace, 'project', 'shotlist.json'),
      path.join(compositionDir, 'composition-manifest.json'),
    ]));
    const after = await stateMod.readVideoProductionState(statePath, compositionDir);
    expect(after.plan_approval?.signature).toBe(approvedIntentHash);
    expect(after.preview).toBeUndefined();
    expect(after.draft).toBeUndefined();
    expect(ttsMock.generateSpeech).not.toHaveBeenCalled();
  });

  it('returns a semantic intent conflict and preserves approval when approved content changes', async () => {
    const toolMod = await import('../../../../src/main/model/core-agent/video-studio-tool');
    const stateMod = await import('../../../../src/main/features/video_studio_state');
    const opts = {
      userId: UID,
      cid: 'cid-plan-file-conflict',
      turnId: 'turn-plan-file-conflict',
      agentId: VIDEO_STUDIO_AGENT_ID,
      agentName: 'VideoStudio',
      userMessage: '确认',
    };
    const tool = toolMod.createVideoStudioTool(opts);
    const ctx = { workingDir: workspace, state: {} } as any;
    expect((await tool.execute({
      op: 'composition.approve_plan',
      composition_dir: 'project/composition',
      decision_evidence: decisionEvidence('plan', 'approve', '确认'),
    }, ctx)).isError).toBe(false);
    const manifestPath = path.join(compositionDir, 'composition-manifest.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    manifest.scenes[0].approved_copy = ['Different approved message'];
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');

    const blocked = await tool.execute({
      op: 'composition.prepare',
      composition_dir: 'project/composition',
    }, ctx);
    expect(blocked.isError).toBe(true);
    const blockedResult = parseResult(blocked.content);
    expect(blockedResult).toMatchObject({
      errorCode: 'E_GATE_B_ARTIFACT_CHANGED',
      billable_request_sent: false,
      evidence: {
        conflicts: [{
          code: 'approved_intent_content_changed',
        }],
        protected_constraints: expect.arrayContaining([
          'approved_plan_content_must_not_change_without_user_approval',
          'paid_narration_artifacts_must_not_be_overwritten_or_regenerated',
        ]),
      },
    });
    expect(blockedResult.evidence.observations).toContainEqual(expect.objectContaining({
      role: 'manifest',
      status: 'changed',
      path: manifestPath,
    }));
    expect(blockedResult.evidence.intent_changes).toContainEqual({
      path: 'manifest.scenes[0].approved_copy[0]',
      before: 'Approved',
      after: 'Different approved message',
    });
    const statePath = toolMod.videoStudioProductionStatePath(opts, compositionDir);
    expect((await stateMod.readVideoProductionState(statePath, compositionDir)).plan_approval)
      .toBeDefined();
    expect(ttsMock.generateSpeech).not.toHaveBeenCalled();
  });

  it('inherits Gate B for a production-shaped narration_text timing repair without another approval or paid check', async () => {
    const toolMod = await import('../../../../src/main/model/core-agent/video-studio-tool');
    const stateMod = await import('../../../../src/main/features/video_studio_state');
    const originalNarration = 'How did next-word prediction become systems reasoning, seeing, and using tools? In 2017, the Transformer made attention-based training parallel and scalable. In 2018, BERT learned from both sides of context, adapted across language tasks. By 2020, GPT-3 showed scale unlocked few-shot learning from instructions and examples. In 2022, ChatGPT brought prompting to a global audience. In 2024, multimodal models connected text, images, and audio, while reasoning models computed before answering. In 2025, DeepSeek-R1 opened reasoning further, while tool use pushed models toward agents. The pattern: attention enabled scale; scale enabled generality; reasoning and tools turn prediction into problem-solving.';
    const revisedNarration = 'How did next-word prediction become systems that reason, see, and use tools? In 2017, the Transformer made attention-based language training parallel and scalable. In 2018, BERT learned from both sides of context, adapted across language tasks. By 2020, GPT-3 showed scale unlocked few-shot learning from instructions and examples. In 2022, ChatGPT brought prompting to a global audience. In 2024, multimodal models connected text, images, and audio, while reasoning models computed longer before answering. In 2025, DeepSeek-R1 opened reasoning further, while tool use pushed models toward agents. The pattern: attention enabled scale; scale enabled generality; reasoning and tools turn prediction into problem-solving.';
    fs.writeFileSync(path.join(workspace, 'project', 'script.md'), `# Approved script\n\n${originalNarration}`, 'utf8');
    const initialShotlistPath = path.join(workspace, 'project', 'shotlist.json');
    const initialShotlist = JSON.parse(fs.readFileSync(initialShotlistPath, 'utf8'));
    initialShotlist.target_duration_seconds = 60;
    delete initialShotlist.shots[0].narration;
    initialShotlist.shots[0].narration_text = originalNarration;
    fs.writeFileSync(initialShotlistPath, JSON.stringify(initialShotlist), 'utf8');
    const initialManifestPath = path.join(compositionDir, 'composition-manifest.json');
    const initialManifest = JSON.parse(fs.readFileSync(initialManifestPath, 'utf8'));
    initialManifest.composition.duration = 60;
    initialManifest.composition.target_duration = 60;
    initialManifest.scenes[0].duration = 60;
    initialManifest.scenes[0].narration_text = originalNarration;
    fs.writeFileSync(initialManifestPath, JSON.stringify(initialManifest, null, 2), 'utf8');
    const opts = {
      userId: UID,
      cid: 'cid-calibrated-fit',
      turnId: 'turn-initial',
      agentId: VIDEO_STUDIO_AGENT_ID,
      agentName: 'VideoStudio',
      userMessage: '确认',
    };
    const tool = toolMod.createVideoStudioTool(opts);
    const ctx = { workingDir: workspace, state: {} } as any;
    ttsMock.estimateNarrationDuration.mockImplementation((text: string) => ({
      estimatedSec: text.includes('longer') ? 63.01 : 56,
      unit: 'words',
      units: text.includes('longer') ? 101 : 98,
      unitsPerSec: 1,
    }));

    for (const op of ['composition.approve_plan', 'composition.doctor', 'composition.prepare']) {
      const result = await tool.execute(compositionInput(op), ctx);
      expect(result.isError).toBe(false);
    }

    const audioPath = path.join(compositionDir, 'assets', 'narration.mp3');
    fs.mkdirSync(path.dirname(audioPath), { recursive: true });
    fs.writeFileSync(audioPath, Buffer.from('first-paid-audio'));
    const manifestPath = path.join(compositionDir, 'composition-manifest.json');
    const htmlPath = path.join(compositionDir, 'index.html');
    const sha = (file: string) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
    const statePath = toolMod.videoStudioProductionStatePath(opts, compositionDir);
    await stateMod.updateVideoProductionState(statePath, compositionDir, (state) => {
      const now = new Date().toISOString();
      state.narration_transaction = {
        transaction_id: 'tx-measured-overrun',
        status: 'synthesized',
        text_sha256: crypto.createHash('sha256').update(originalNarration).digest('hex'),
        path: audioPath,
        manifest_sha256: sha(manifestPath),
        scaffold_html_sha256: sha(htmlPath),
        backend: 'mock-voice',
        generic_estimated_duration_sec: 56,
        narration_unit: 'words',
        narration_units: 98,
        audio_sha256: sha(audioPath),
        measured_duration_sec: 53.304,
        started_at: now,
        updated_at: now,
      };
    });

    const mismatch = await tool.execute({
      op: 'composition.materialize_narration',
      composition_dir: 'project/composition',
    }, ctx);
    expect(mismatch.isError).toBe(true);
    expect(parseResult(mismatch.content)).toMatchObject({
      errorCode: 'E_TTS_MEASURED_DURATION_MISMATCH',
      billable_request_sent: false,
      narration_fit: { status: 'under', source: 'measured_calibration' },
    });
    const calibrated = await stateMod.readVideoProductionState(statePath, compositionDir);
    expect(calibrated.narration_calibration).toMatchObject({
      backend: 'mock-voice',
      duration_scale: 0.9519,
      narration_units: 98,
    });
    expect(calibrated.narration_repair).toMatchObject({
      source: 'measured_duration_mismatch',
      approval_turn_id: 'turn-initial',
      checks_used: 0,
    });

    await stateMod.updateVideoProductionState(statePath, compositionDir, (state) => {
      if (!state.narration_repair) throw new Error('expected narration repair authorization');
      state.narration_repair.checks_used = state.narration_repair.max_checks;
    });
    const intermediateNarration = originalNarration.replace(
      'systems reasoning, seeing, and using tools',
      'systems that reason, see, and use tools',
    );
    fs.writeFileSync(path.join(workspace, 'project', 'script.md'), `# Approved script\n\n${intermediateNarration}`, 'utf8');
    const intermediateShotlist = JSON.parse(fs.readFileSync(path.join(workspace, 'project', 'shotlist.json'), 'utf8'));
    intermediateShotlist.shots[0].narration_text = intermediateNarration;
    fs.writeFileSync(path.join(workspace, 'project', 'shotlist.json'), JSON.stringify(intermediateShotlist), 'utf8');
    const intermediateManifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    intermediateManifest.scenes[0].narration_text = intermediateNarration;
    fs.writeFileSync(manifestPath, JSON.stringify(intermediateManifest, null, 2), 'utf8');

    const strategyReview = await tool.execute({
      op: 'composition.check_narration_fit',
      composition_dir: 'project/composition',
    }, ctx);
    expect(strategyReview.isError).toBe(false);
    expect(parseResult(strategyReview.content)).toMatchObject({
      gate_b_required: false,
      approval_inherited: false,
      repair_authorization_status: 'pending',
      repair_authorization_reason: 'repair_strategy_review_required',
      requires_user_decision: false,
      next_action: 'revise_narration_then_composition.check_narration_fit',
      billable_request_sent: false,
    });

    const unchangedStrategyRetry = await tool.execute({
      op: 'composition.check_narration_fit',
      composition_dir: 'project/composition',
    }, ctx);
    expect(unchangedStrategyRetry.isError).toBe(true);
    expect(parseResult(unchangedStrategyRetry.content)).toMatchObject({
      errorCode: 'E_NARRATION_FIT_RETRY_NO_CHANGE',
      same_input_retry_allowed: false,
      requires_user_decision: false,
      next_action: 'revise_narration_then_composition.check_narration_fit',
      review_package: {
        presentation_required: true,
        conclusion: {
          outcome: 'blocked',
          error_code: 'E_NARRATION_FIT_RETRY_NO_CHANGE',
          requires_user_decision: false,
        },
        primary_artifact: {
          role: 'script',
          review_status: 'current_input',
        },
        artifacts: expect.arrayContaining([
          expect.objectContaining({ role: 'script' }),
          expect.objectContaining({ role: 'shotlist' }),
          expect.objectContaining({ role: 'plan_manifest' }),
        ]),
      },
    });

    fs.writeFileSync(path.join(workspace, 'project', 'script.md'), `# Approved script\n\n${revisedNarration}`, 'utf8');
    const shotlistPath = path.join(workspace, 'project', 'shotlist.json');
    const shotlist = JSON.parse(fs.readFileSync(shotlistPath, 'utf8'));
    shotlist.shots[0].narration_text = revisedNarration;
    fs.writeFileSync(shotlistPath, JSON.stringify(shotlist), 'utf8');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    manifest.scenes[0].narration_text = revisedNarration;
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');

    const fitCheck = await tool.execute({
      op: 'composition.check_narration_fit',
      composition_dir: 'project/composition',
    }, ctx);
    expect(fitCheck.isError).toBe(false);
    expect(parseResult(fitCheck.content)).toMatchObject({
      gate_b_ready: true,
      gate_b_required: false,
      approval_inherited: true,
      repair_authorization_status: 'inheritable',
      next_action: 'composition.prepare',
      billable_request_sent: false,
      narration_fit: {
        status: 'fits',
        source: 'measured_calibration',
        generic_estimated_duration_sec: 63.01,
        estimated_duration_sec: 59.98,
      },
      production_state: {
        stage: 'manifest_ready',
        plan_approval: { inheritance_reason: 'measured_narration_fit_repair' },
      },
    });

    const afterApproval = await stateMod.readVideoProductionState(statePath, compositionDir);
    expect(afterApproval.narration_transaction).toBeUndefined();
    expect(afterApproval.narration_repair).toBeUndefined();
    expect(afterApproval.narration_calibration?.duration_scale).toBe(0.9519);
    expect(afterApproval.narration_fit).toMatchObject({ status: 'fits', source: 'measured_calibration' });
    expect(afterApproval.plan_approval).toMatchObject({
      turn_id: 'turn-initial',
      inheritance_reason: 'measured_narration_fit_repair',
    });
    expect(fs.existsSync(audioPath)).toBe(false);
    expect(fs.readdirSync(path.join(compositionDir, 'assets', 'narration-history'))).toHaveLength(1);

    const resumedTool = toolMod.createVideoStudioTool({
      ...opts,
      turnId: 'turn-after-repair',
      userMessage: '',
    });
    const prepared = await resumedTool.execute({
      op: 'composition.prepare',
      composition_dir: 'project/composition',
    }, ctx);
    expect(prepared.isError).toBe(false);
    expect(ttsMock.generateSpeech).not.toHaveBeenCalled();
  });

  it('does not inherit Gate B for structural changes or excessive narration rewrites', async () => {
    const toolMod = await import('../../../../src/main/model/core-agent/video-studio-tool');
    const stateMod = await import('../../../../src/main/features/video_studio_state');
    const originalNarration = 'One two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen twenty.';
    const scenarios = [
      {
        cid: 'cid-repair-structure-change',
        revisedNarration: 'One two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen.',
        expectedReason: 'approved_structure_changed',
        changeStructure: true,
      },
      {
        cid: 'cid-repair-large-rewrite',
        revisedNarration: 'Alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu xi omicron pi rho sigma tau.',
        expectedReason: 'narration_change_exceeds_authorized_scope',
        changeStructure: false,
      },
    ];

    for (const scenario of scenarios) {
      fs.rmSync(path.join(workspace, 'project'), { recursive: true, force: true });
      writePlan();
      fs.writeFileSync(path.join(workspace, 'project', 'script.md'), `# Approved script\n\n${originalNarration}`, 'utf8');
      const shotlistPath = path.join(workspace, 'project', 'shotlist.json');
      const shotlist = JSON.parse(fs.readFileSync(shotlistPath, 'utf8'));
      shotlist.shots[0].narration = originalNarration;
      fs.writeFileSync(shotlistPath, JSON.stringify(shotlist), 'utf8');
      const manifestPath = path.join(compositionDir, 'composition-manifest.json');
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      manifest.scenes[0].narration_text = originalNarration;
      fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');

      ttsMock.estimateNarrationDuration.mockImplementation((text: string) => ({
        estimatedSec: text.includes('twenty') ? 5 : 4,
        unit: 'words',
        units: text.includes('twenty') ? 118 : 98,
        unitsPerSec: 1,
      }));
      const opts = {
        userId: UID,
        cid: scenario.cid,
        turnId: 'turn-initial',
        agentId: VIDEO_STUDIO_AGENT_ID,
        agentName: 'VideoStudio',
        userMessage: '确认',
      };
      const tool = toolMod.createVideoStudioTool(opts);
      const ctx = { workingDir: workspace, state: {} } as any;
      // Production state is intentionally scoped to the project artifact rather
      // than the conversation id. Each scenario needs an explicit clean slate.
      const cleanStatePath = toolMod.videoStudioProductionStatePath(opts, compositionDir);
      fs.rmSync(cleanStatePath, { force: true });
      fs.rmSync(`${cleanStatePath}.bak`, { force: true });
      for (const op of ['composition.approve_plan', 'composition.doctor', 'composition.prepare']) {
        const result = await tool.execute(compositionInput(op), ctx);
        expect(result.isError).toBe(false);
      }

      const audioPath = path.join(compositionDir, 'assets', 'narration.mp3');
      fs.mkdirSync(path.dirname(audioPath), { recursive: true });
      fs.writeFileSync(audioPath, Buffer.from(`paid-${scenario.cid}`));
      const htmlPath = path.join(compositionDir, 'index.html');
      const sha = (file: string) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
      const statePath = toolMod.videoStudioProductionStatePath(opts, compositionDir);
      await stateMod.updateVideoProductionState(statePath, compositionDir, (state) => {
        const now = new Date().toISOString();
        state.narration_transaction = {
          transaction_id: `tx-${scenario.cid}`,
          status: 'synthesized',
          text_sha256: crypto.createHash('sha256').update(originalNarration).digest('hex'),
          path: audioPath,
          manifest_sha256: sha(manifestPath),
          scaffold_html_sha256: sha(htmlPath),
          backend: 'mock-voice',
          generic_estimated_duration_sec: 5,
          narration_unit: 'words',
          narration_units: 118,
          audio_sha256: sha(audioPath),
          measured_duration_sec: 6.02,
          started_at: now,
          updated_at: now,
        };
      });
      const mismatch = await tool.execute({
        op: 'composition.materialize_narration',
        composition_dir: 'project/composition',
      }, ctx);
      expect(mismatch.isError).toBe(true);
      expect((await stateMod.readVideoProductionState(statePath, compositionDir)).narration_repair).toBeDefined();

      fs.writeFileSync(
        path.join(workspace, 'project', 'script.md'),
        `# Approved script\n\n${scenario.revisedNarration}`,
        'utf8',
      );
      const revisedShotlist = JSON.parse(fs.readFileSync(shotlistPath, 'utf8'));
      revisedShotlist.shots[0].narration = scenario.revisedNarration;
      if (scenario.changeStructure) revisedShotlist.shots[0].visual = 'A different visual plan.';
      fs.writeFileSync(shotlistPath, JSON.stringify(revisedShotlist), 'utf8');
      const revisedManifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      revisedManifest.scenes[0].narration_text = scenario.revisedNarration;
      fs.writeFileSync(manifestPath, JSON.stringify(revisedManifest, null, 2), 'utf8');

      const checked = await tool.execute({
        op: 'composition.check_narration_fit',
        composition_dir: 'project/composition',
      }, ctx);
      expect(checked.isError).toBe(false);
      expect(parseResult(checked.content)).toMatchObject({
        gate_b_ready: true,
        gate_b_required: true,
        approval_inherited: false,
        repair_authorization_status: 'rejected',
        repair_authorization_reason: scenario.expectedReason,
        next_action: 'open_gate_b',
      });
      const rejectedState = await stateMod.readVideoProductionState(statePath, compositionDir);
      expect(rejectedState.narration_repair).toBeUndefined();
      expect(rejectedState.plan_approval?.inheritance_reason).toBeUndefined();
    }
  });
});
