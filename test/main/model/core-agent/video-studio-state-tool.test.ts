import { spawnSync } from 'node:child_process';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import sharp from 'sharp';

import { bundledFfmpegPaths } from '../../../../src/main/util/bundled-runtime';

const PNG_2X2 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAEUlEQVQImWOQUEj4D8IMMAYAM2QGXeoNXYQAAAAASUVORK5CYII=',
  'base64',
);

const loggerMocks = vi.hoisted(() => ({
  warn: vi.fn(),
}));

const fsPromiseMocks = vi.hoisted(() => ({
  readFile: vi.fn(),
  actualReadFile: undefined as ((...args: unknown[]) => Promise<unknown>) | undefined,
}));

const ttsMock = vi.hoisted(() => ({
  estimateNarrationDuration: vi.fn(),
  generateSpeech: vi.fn(),
  /** Set by a case that needs a catalog other than the single default voice. */
  catalogRoutes: null as any,
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
    warn: loggerMocks.warn,
    error: vi.fn(),
  }),
}));

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  fsPromiseMocks.actualReadFile = actual.readFile as (...args: unknown[]) => Promise<unknown>;
  fsPromiseMocks.readFile.mockImplementation((...args: unknown[]) => (
    fsPromiseMocks.actualReadFile!(...args)
  ));
  return { ...actual, readFile: fsPromiseMocks.readFile };
});

vi.mock('../../../../src/main/util/media_probe', () => ({
  probeMediaDurationSec: mediaProbeMock.duration,
}));

// The delivery band, its overrun tolerance, and the rule about which verdicts
// block production are exactly what these protocol cases assert against, so
// they come from the real module. Re-stating them here would have made the
// suite agree with itself no matter what the tool actually enforces. Only the
// provider-touching entry points and the estimator (whose seconds each case
// sets deliberately) are stubbed.
vi.mock('../../../../src/main/features/tts', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../../../src/main/features/tts')>(),
  hasConfiguredTtsProvider: () => true,
  configuredTtsBackendId: () => 'mock-voice',
  estimateNarrationDuration: ttsMock.estimateNarrationDuration,
  generateSpeech: ttsMock.generateSpeech,
}));

vi.mock('../../../../src/main/features/tts_capabilities', async (importOriginal) => {
  // Only the provider-touching catalog lookup is stubbed. The pure listing and
  // language rules stay real, so a capabilities case observes the projection
  // the Agent actually receives instead of one the fixture invented.
  const actual = await importOriginal<typeof import('../../../../src/main/features/tts_capabilities')>();
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
    ...actual,
    listTtsCapabilities: async () => ttsMock.catalogRoutes ?? [route],
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
// Comfortably under the tool-result inline cap: a compacted result must not
// spill to disk, which is the round trip the compaction exists to remove.
const QA_INLINE_SAFE_CHARS = 24_000;
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

function writeAutoParentPlan(opts: { targetSec?: number; scenes?: number; narration?: boolean } = {}): string {
  const targetSec = opts.targetSec ?? 5;
  const sceneCount = opts.scenes ?? 1;
  const planPath = path.join(workspace, 'project', 'plan.json');
  fs.writeFileSync(planPath, JSON.stringify({
    aspect: '16:9',
    total_target_sec: targetSec,
    language: 'en',
    delivery_promise: { type: 'compose_led', source_required: false, motion_min_ratio: 0 },
    segments: [{
      id: 'intro',
      order: 1,
      role: 'hook',
      layer: 'primary',
      source: 'compose',
      target_sec: targetSec,
      spec: {
        kind: 'title-card',
        composition_plan: {
          scenes: Array.from({ length: sceneCount }, (_, index) => ({
            id: sceneCount === 1 ? 'intro' : `intro-${index + 1}`,
            approved_copy: ['Approved intro'],
            narration_text: '',
            roles: ['title', 'visual'],
          })),
        },
      },
    }],
    cost_estimate: { billable_generations: 0 },
    ...(opts.narration ? {
      tracks: {
        narration: {
          synthesis: {
            route_ref: 'managed:orkas-voice',
            voice_ref: 'managed:orkas-voice:voice:abc123',
            display_name: 'vivi 2.0',
            language: 'zh-CN',
            speed: 1,
          },
          segments: [{ text: '这一段的旁白台词。', start_sec: 0, target_sec: targetSec }],
        },
      },
    } : {}),
  }, null, 2), 'utf8');
  return planPath;
}

function writeAutoChildComposition(opts: { targetSec?: number; scenes?: number } = {}): string {
  const targetSec = opts.targetSec ?? 5;
  const sceneCount = opts.scenes ?? 1;
  const sceneId = (index: number) => (sceneCount === 1 ? 'intro' : `intro-${index + 1}`);
  const sceneSec = targetSec / sceneCount;
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
    composition: {
      id: 'intro', width: 1920, height: 1080,
      duration: targetSec, target_duration: targetSec, fps: 30, language: 'en',
    },
    scenes: Array.from({ length: sceneCount }, (_, index) => ({
      id: sceneId(index),
      start: index * sceneSec,
      duration: sceneSec,
      approved_copy: ['Approved intro'],
      narration_text: '',
      narration_refs: [],
      source_shots: ['intro'],
      roles: ['title', 'visual'],
    })),
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
  ttsMock.catalogRoutes = null;
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
  if (fsPromiseMocks.actualReadFile) {
    fsPromiseMocks.readFile.mockImplementation((...args: unknown[]) => (
      fsPromiseMocks.actualReadFile!(...args)
    ));
  }
  fsPromiseMocks.readFile.mockClear();
  vi.restoreAllMocks();
  fs.rmSync(root, { recursive: true, force: true });
});

describe('VideoStudio production-state tool protocol', () => {
  it('exposes an unambiguous legacy design-review findings contract', async () => {
    // Compatibility callers should complete a passing review in one call.
    // The production trace put positive observations in review_findings because
    // the old description called every observation a finding, then the host
    // rejected that non-empty array as an unresolved repair list.
    const mod = await import('../../../../src/main/model/core-agent/video-studio-tool');
    const tool = mod.createVideoStudioTool({
      userId: UID,
      agentId: VIDEO_STUDIO_AGENT_ID,
    });
    const properties = (tool.inputSchema as any).properties;

    expect(properties.review_verdict.description)
      .toContain('passed requires review_findings to be omitted or []');
    expect(properties.review_findings.description)
      .toContain('For review_verdict=passed, omit this field or send []');
    expect(properties.review_findings.description)
      .toContain('do not put positive observations or a pass summary here');
    expect(properties.review_findings.description)
      .toContain('For repair or blocked, send one or more concrete findings');
  });

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

  it('hands a gate back to the user when the turn was started by another actor', async () => {
    // A commander nested dispatch wakes the agent with `<msg from="commander">`,
    // which carries no user reply. Both ways the model can phrase the approval
    // used to fail as a retryable input error, so the agent looped on the same
    // call and the production line never reached draft.
    makePlanVisualOnly();
    const toolMod = await import('../../../../src/main/model/core-agent/video-studio-tool');
    const stateMod = await import('../../../../src/main/features/video_studio_state');
    const ctx = { workingDir: workspace, state: {} } as any;
    const dispatched = '<msg from="commander" to="79df9cc89f5f">用户已确认制作方案，请继续推进并生成草稿。</msg>';

    const dispatchOpts = {
      userId: UID,
      cid: 'cid-dispatch-gate',
      turnId: 'turn-dispatch-gate',
      agentId: VIDEO_STUDIO_AGENT_ID,
      agentName: 'VideoStudio',
      userMessage: dispatched,
    };
    const dispatchTool = toolMod.createVideoStudioTool(dispatchOpts);
    const quotingDispatch = await dispatchTool.execute({
      op: 'composition.approve_plan',
      composition_dir: 'project/composition',
      decision_evidence: decisionEvidence('plan', 'approve', '用户已确认制作方案'),
    }, ctx);
    const withoutEvidence = await dispatchTool.execute({
      op: 'composition.approve_plan',
      composition_dir: 'project/composition',
    }, ctx);
    for (const attempt of [quotingDispatch, withoutEvidence]) {
      expect(attempt.isError).toBe(true);
      expect(parseResult(attempt.content)).toMatchObject({
        errorCode: 'E_GATE_USER_TURN_REQUIRED',
        gate: 'plan',
        current_user_message_available: false,
        requires_user_decision: true,
        next_step_owner: 'user',
        interaction_required: true,
        automatic_recovery_expected: false,
        same_turn_continuation_required: false,
        billable_request_sent: false,
        form_policy: 'plain_message_no_form',
        next_action: 'show_current_artifact_and_request_user_decision',
      });
    }
    expect((await stateMod.readVideoProductionState(
      toolMod.videoStudioProductionStatePath(dispatchOpts, compositionDir),
      compositionDir,
    )).plan_approval).toBeUndefined();

    // Negative control: the guard must not swallow a real approval. The same
    // evidence in the user's own group turn, and an unwrapped plain-chat reply,
    // both still approve.
    const userTurnOpts = {
      ...dispatchOpts,
      cid: 'cid-dispatch-gate-user-turn',
      turnId: 'turn-dispatch-gate-user-turn',
      userMessage: '<msg from="user" to="79df9cc89f5f">@VideoStudio\n确认，继续制作。</msg>',
    };
    expect((await toolMod.createVideoStudioTool(userTurnOpts).execute({
      op: 'composition.approve_plan',
      composition_dir: 'project/composition',
      decision_evidence: decisionEvidence('plan', 'approve', '确认，继续制作。'),
    }, ctx)).isError).toBe(false);
    expect((await toolMod.createVideoStudioTool({
      ...dispatchOpts,
      cid: 'cid-dispatch-gate-plain-chat',
      turnId: 'turn-dispatch-gate-plain-chat',
      userMessage: '确认，继续制作。',
    }).execute({
      op: 'composition.approve_plan',
      composition_dir: 'project/composition',
      decision_evidence: decisionEvidence('plan', 'approve', '确认，继续制作。'),
    }, ctx)).isError).toBe(false);

    // A later delegated turn on that approved line must not be able to approve
    // the visual preview either, and the recorded preview stays reviewable.
    const previewStatePath = toolMod.videoStudioProductionStatePath(userTurnOpts, compositionDir);
    expect(await toolMod.recordVideoStudioGate(
      previewStatePath,
      'preview',
      compositionDir,
      'turn-dispatch-gate-user-turn',
      {
        preview_ready: true,
        preview_qa: { ok: true, error_count: 0 },
        preflight: { status: 'passed', blocking_error_count: 0 },
        contact_sheet: path.join(compositionDir, 'preview', 'contact-sheet.png'),
      },
    )).toBe(true);
    const dispatchedPreview = await toolMod.createVideoStudioTool({
      ...userTurnOpts,
      turnId: 'turn-dispatch-gate-preview',
      userMessage: dispatched,
    }).execute({
      op: 'composition.approve_draft',
      composition_dir: 'project/composition',
      decision_evidence: decisionEvidence('draft', 'approve', '用户已确认制作方案'),
    }, ctx);
    expect(parseResult(dispatchedPreview.content)).toMatchObject({
      errorCode: 'E_GATE_USER_TURN_REQUIRED',
      gate: 'draft',
      next_step_owner: 'user',
      automatic_recovery_expected: false,
    });
    expect((await stateMod.readVideoProductionState(previewStatePath, compositionDir)).preview)
      .toMatchObject({ status: 'ready' });
  });

  it('breaks a repeated identical-failure loop and hands the turn to the user', async () => {
    // Production loops were the model resending one failing call unchanged,
    // each error result instructing yet another retry. The host must end the
    // loop itself instead of relying on model obedience.
    makePlanVisualOnly();
    const toolMod = await import('../../../../src/main/model/core-agent/video-studio-tool');
    const ctx = { workingDir: workspace, state: {} } as any;
    const tool = toolMod.createVideoStudioTool({
      userId: UID,
      cid: 'cid-breaker',
      turnId: 'turn-breaker',
      agentId: VIDEO_STUDIO_AGENT_ID,
      agentName: 'VideoStudio',
      userMessage: '<msg from="commander" to="79df9cc89f5f">继续推进制作。</msg>',
    });
    const callInput = { op: 'composition.approve_plan', composition_dir: 'project/composition' };

    for (const attempt of [
      await tool.execute({ ...callInput }, ctx),
      await tool.execute({ ...callInput }, ctx),
    ]) {
      expect(attempt.isError).toBe(true);
      expect(parseResult(attempt.content).errorCode).toBe('E_GATE_USER_TURN_REQUIRED');
    }

    const third = await tool.execute({ ...callInput }, ctx);
    expect(third.isError).toBe(true);
    const tripped = parseResult(third.content);
    expect(tripped).toMatchObject({
      errorCode: 'E_REPEATED_FAILURE_USER_DECISION_REQUIRED',
      identical_failed_attempts: 3,
      requires_user_decision: true,
      next_step_owner: 'user',
      interaction_required: true,
      automatic_recovery_expected: false,
      same_turn_continuation_required: false,
      billable_request_sent: false,
    });
    expect(third.synthesizeAndEndTurn).toBe(true);
    expect(tripped.original_error_excerpt).toContain('E_GATE_USER_TURN_REQUIRED');

    // Changed arguments are a fresh attempt, not part of the tripped streak.
    const differentArgs = await tool.execute({
      ...callInput,
      decision_evidence: decisionEvidence('plan', 'approve', '继续推进制作。'),
    }, ctx);
    expect(parseResult(differentArgs.content).errorCode).toBe('E_GATE_USER_TURN_REQUIRED');
  });

  it('records the task title from plan confirmation without touching approval identity', async () => {
    // The review drawer titles a production with what the user asked for
    // instead of its directory path. The title is display metadata: it must
    // persist across later approvals, survive a call that omits it, and
    // never move the approved-intent signature — otherwise renaming what the
    // user called their video would reopen Gate B and invalidate the preview.
    makePlanVisualOnly();
    const toolMod = await import('../../../../src/main/model/core-agent/video-studio-tool');
    const stateMod = await import('../../../../src/main/features/video_studio_state');
    const ctx = { workingDir: workspace, state: {} } as any;
    const opts = {
      userId: UID,
      cid: 'cid-task-title',
      turnId: 'turn-task-title',
      agentId: VIDEO_STUDIO_AGENT_ID,
      agentName: 'VideoStudio',
      userMessage: '<msg from="user" to="79df9cc89f5f">@VideoStudio\n确认，继续制作。</msg>',
    };
    const statePath = toolMod.videoStudioProductionStatePath(opts, compositionDir);
    const approve = async (extra: Record<string, unknown>) => toolMod
      .createVideoStudioTool(opts)
      .execute({ ...compositionInput('composition.approve_plan'), ...extra }, ctx);

    const titled = await approve({ task_title: '  做一条 60 秒的\n  Orkas 产品宣传片  ' });
    expect(titled.isError).toBe(false);
    const firstSignature = parseResult(titled.content).plan_signature;
    // Whitespace is normalized so the drawer's two-line clamp gets one line.
    expect((await stateMod.readVideoProductionState(statePath, compositionDir)).task_title)
      .toBe('做一条 60 秒的 Orkas 产品宣传片');

    // A later approval that sends no title keeps the recorded one rather
    // than blanking the drawer back to a path.
    const untitled = await approve({});
    expect(untitled.isError).toBe(false);
    const afterUntitled = await stateMod.readVideoProductionState(statePath, compositionDir);
    expect(afterUntitled.task_title).toBe('做一条 60 秒的 Orkas 产品宣传片');
    expect(parseResult(untitled.content).plan_signature).toBe(firstSignature);

    // Negative control: a different title is not a plan change.
    const renamed = await approve({ task_title: '换个说法的同一条片子' });
    expect(renamed.isError).toBe(false);
    expect(parseResult(renamed.content)).toMatchObject({
      plan_signature: firstSignature,
      plan_changed: false,
    });
    expect((await stateMod.readVideoProductionState(statePath, compositionDir)).task_title)
      .toBe('换个说法的同一条片子');
  });

  it('does not break a repair-then-identical-retry that ends in success', async () => {
    // gate-control's prescribed recovery is "restore the listed artifact,
    // then retry approval in this same turn" — often with byte-identical
    // arguments. The breaker must judge results after execution, never
    // short-circuit the call, or it would kill this legitimate flow.
    makePlanVisualOnly();
    const toolMod = await import('../../../../src/main/model/core-agent/video-studio-tool');
    const ctx = { workingDir: workspace, state: {} } as any;
    const tool = toolMod.createVideoStudioTool({
      userId: UID,
      cid: 'cid-breaker-repair',
      turnId: 'turn-breaker-repair',
      agentId: VIDEO_STUDIO_AGENT_ID,
      agentName: 'VideoStudio',
      userMessage: '<msg from="user" to="79df9cc89f5f">@VideoStudio\n确认，继续制作。</msg>',
    });
    const brokenPath = path.join(compositionDir, 'composition-manifest.json');
    const manifestBackup = fs.readFileSync(brokenPath, 'utf8');
    fs.writeFileSync(brokenPath, '{"schema_version": 2,', 'utf8');
    const callInput = {
      op: 'composition.approve_plan',
      composition_dir: 'project/composition',
      decision_evidence: decisionEvidence('plan', 'approve', '确认，继续制作。'),
    };

    for (const attempt of [
      await tool.execute({ ...callInput }, ctx),
      await tool.execute({ ...callInput }, ctx),
    ]) {
      expect(attempt.isError).toBe(true);
      expect(String(parseResult(attempt.content).errorCode)).toMatch(/^E_GATE_B_ARTIFACT/);
    }

    fs.writeFileSync(brokenPath, manifestBackup, 'utf8');
    const identicalRetry = await tool.execute({ ...callInput }, ctx);
    expect(identicalRetry.isError).toBe(false);
  });

  it('refuses gate operations against a skill generation older than the host contract', async () => {
    // Production incident: a reconcile downgraded the installed VideoStudio to
    // a generation that predates decision_evidence and signature-bound review
    // forms. Every gate then looped instead of failing visibly. The handshake
    // turns that skew into one explicit, non-retryable result while read and
    // QA ops keep working.
    makePlanVisualOnly();
    const toolMod = await import('../../../../src/main/model/core-agent/video-studio-tool');
    const pathsMod = await import('../../../../src/main/paths');
    const ctx = { workingDir: workspace, state: {} } as any;
    const agentDir = pathsMod.userMarketplaceAgentDir(UID, VIDEO_STUDIO_AGENT_ID);
    fs.mkdirSync(agentDir, { recursive: true });
    const writeInstalledAgent = (spec: Record<string, unknown>) => {
      fs.writeFileSync(path.join(agentDir, 'agent.json'), JSON.stringify({
        agent_id: VIDEO_STUDIO_AGENT_ID,
        name: 'VideoStudio',
        ...spec,
      }), 'utf8');
    };
    const makeTool = (turnId: string) => toolMod.createVideoStudioTool({
      userId: UID,
      cid: 'cid-contract',
      turnId,
      agentId: VIDEO_STUDIO_AGENT_ID,
      agentName: 'VideoStudio',
      userMessage: '<msg from="user" to="79df9cc89f5f">@VideoStudio\n确认，继续制作。</msg>',
    });
    const approveInput = {
      op: 'composition.approve_plan',
      composition_dir: 'project/composition',
      decision_evidence: decisionEvidence('plan', 'approve', '确认，继续制作。'),
    };

    try {
      // Pre-contract-field generation, older than the compatibility floor.
      writeInstalledAgent({ version: '1.1.15' });
      const outdated = await makeTool('turn-contract-outdated').execute({ ...approveInput }, ctx);
      expect(outdated.isError).toBe(true);
      expect(parseResult(outdated.content)).toMatchObject({
        errorCode: 'E_VIDEO_STUDIO_SKILL_OUTDATED',
        installed_agent_version: '1.1.15',
        next_step_owner: 'user',
        interaction_required: true,
        automatic_recovery_expected: false,
        billable_request_sent: false,
      });
      // Degraded mode still produces and reports: read ops are not refused.
      const status = await makeTool('turn-contract-status').execute({
        op: 'composition.status',
        composition_dir: 'project/composition',
      }, ctx);
      expect(status.isError).toBe(false);
      expect(parseResult(status.content).contract_version).toBe(2);

      // A skill declaring a newer contract than this host implements.
      writeInstalledAgent({ version: '9.9.9', video_studio_contract: 99 });
      const newer = await makeTool('turn-contract-newer').execute({ ...approveInput }, ctx);
      expect(parseResult(newer.content)).toMatchObject({
        errorCode: 'E_VIDEO_STUDIO_HOST_OUTDATED',
        declared_contract: 99,
        next_step_owner: 'user',
      });

      // Matching declared contract proceeds to normal gate behavior.
      writeInstalledAgent({ version: '1.1.44', video_studio_contract: 2 });
      const matching = await makeTool('turn-contract-match').execute({ ...approveInput }, ctx);
      expect(matching.isError).toBe(false);

      // Version floor covers correct-content generations that predate the
      // field — they must not be locked out.
      writeInstalledAgent({ version: '1.1.40' });
      const floor = await makeTool('turn-contract-floor').execute({
        op: 'composition.status',
        composition_dir: 'project/composition',
      }, ctx);
      expect(floor.isError).toBe(false);
      const floorGate = await makeTool('turn-contract-floor-gate').execute({ ...approveInput }, ctx);
      expect(parseResult(floorGate.content).errorCode).not.toBe('E_VIDEO_STUDIO_SKILL_OUTDATED');
    } finally {
      fs.rmSync(agentDir, { recursive: true, force: true });
    }
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
      'composition.snapshot',
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
      'composition.snapshot',
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

  // The shipped managed catalog is ~100 voices. Returned whole it estimated at
  // 13.8k tokens against a 7.1k inline budget, so every call spilled to disk
  // and the Agent had to keyword-search a stub for a voice it could have been
  // handed. The listing must fit, and it must stay reachable when the user
  // names a voice the sample leaves out.
  it('answers a narration voice choice within the inline result budget and can still show the rest', async () => {
    ttsMock.catalogRoutes = [{
      routeRef: 'managed:orkas-voice',
      provider: 'orkas-voice',
      model: 'doubao-seed-tts-2-0',
      displayName: 'Orkas · Voice',
      catalogStatus: 'complete',
      defaultVoiceRef: 'managed:orkas-voice:voice:v0',
      supports: { speed: true, formats: ['mp3'], languageContract: true },
      voices: Array.from({ length: 100 }, (_unused, index) => ({
        voiceRef: `managed:orkas-voice:voice:v${index}`,
        displayName: index === 99 ? '云舟' : `播音员 ${index}`,
        locale: index === 98 ? 'en-US' : 'zh-CN',
        nativeLocale: index === 98 ? 'en-US' : 'zh-CN',
        supportedLocales: index === 98 ? ['en-US'] : ['zh-CN'],
        mixedLanguageSupport: false,
        languageConfidence: 'verified',
        gender: index % 2 ? 'male' : 'female',
        styleTags: index % 3 ? [] : ['calm', 'warm'],
        useCases: [index < 60 ? 'general' : index < 90 ? 'role-play' : 'audiobook'],
        isDefault: index === 0,
        providerVoiceId: `provider_voice_${index}`,
      })),
    }];
    const toolMod = await import('../../../../src/main/model/core-agent/video-studio-tool');
    const capMod = await import('../../../../src/main/util/tool-result-cap');
    const tool = toolMod.createVideoStudioTool({ userId: UID, agentId: VIDEO_STUDIO_AGENT_ID });

    const sampled = await tool.execute(
      { op: 'speech.capabilities', language: 'zh-CN' },
      { state: {} } as any,
    );
    const payload = parseResult(sampled.content);
    expect(payload.routes[0].voice_count).toBe(99);
    expect(payload.routes[0].voices_shown).toBeLessThan(99);
    expect(payload.routes[0].voices.length).toBe(payload.routes[0].voices_shown);
    expect(sampled.content).not.toContain('provider_voice_0');
    // en-US is the one voice that cannot narrate Chinese.
    expect(sampled.content).not.toContain('managed:orkas-voice:voice:v98');
    expect(capMod.estimateToolResultTokens(sampled.content))
      .toBeLessThan(capMod.DEFAULT_INLINE_RESULT_TOKENS);

    const everything = await tool.execute(
      { op: 'speech.capabilities', language: 'zh-CN', all_voices: true },
      { state: {} } as any,
    );
    expect(parseResult(everything.content).routes[0].voices).toHaveLength(99);
    expect(everything.content).toContain('云舟');
  });

  // `input is not a file: <path>` answered both a missing production plan_path
  // and a speech.transcribe input_path, with no error code and no next action.
  // A 2026-08-09 run hit it on plan_path and could not tell from the reply
  // which argument was wrong, nor whether the file was absent or a directory.
  // A fresh COMPOSE status read is the exception: after direction confirmation
  // there is intentionally no plan directory yet, so absence means "not
  // started", not a failed correction round trip.
  it('reports a fresh missing composition as not started while diagnosing unreadable path arguments', async () => {
    const toolMod = await import('../../../../src/main/model/core-agent/video-studio-tool');
    const tool = toolMod.createVideoStudioTool({ userId: UID, agentId: VIDEO_STUDIO_AGENT_ID });
    const ctx = { workingDir: workspace, state: {} } as any;

    const missing = await tool.execute({
      op: 'production.status',
      plan_path: 'project/plan-that-was-never-written.json',
    }, ctx);
    const freshCompositionAbs = path.join(workspace, 'project', 'composition-that-does-not-exist');
    expect(fs.existsSync(freshCompositionAbs)).toBe(false);
    const noDir = await tool.execute({
      op: 'composition.status',
      composition_dir: 'project/composition-that-does-not-exist',
    }, ctx);
    expect(parseResult(noDir.content)).toMatchObject({
      ok: true,
      op: 'composition.status',
      status: 'not_started',
      composition_dir_exists: false,
      plan_artifacts_present: false,
      plan_artifacts_complete: false,
      billable_request_sent: false,
      next_action: 'author_composition_manifest',
      production_state: { stage: 'initialized' },
    });
    expect(noDir.isError).toBe(false);
    expect(parseResult(noDir.content).message).toContain('composition-manifest.json');
    expect(parseResult(noDir.content).message).toContain('composition.prepare');
    expect(fs.existsSync(freshCompositionAbs)).toBe(false);

    // Absence after durable state existed is recovery, not a false fresh
    // start. The private ledger survives deletion of the authored directory.
    const startedCompositionAbs = path.join(workspace, 'project', 'deleted-after-start');
    fs.mkdirSync(startedCompositionAbs, { recursive: true });
    const stateMod = await import('../../../../src/main/features/video_studio_state');
    const statePath = toolMod.videoStudioProductionStatePath(
      { userId: UID, agentId: VIDEO_STUDIO_AGENT_ID },
      startedCompositionAbs,
    );
    await stateMod.updateVideoProductionState(statePath, startedCompositionAbs, (state) => {
      state.stage = 'scaffold_ready';
      state.artifacts.composition_signature = 'signature-before-directory-was-deleted';
    });
    fs.rmSync(startedCompositionAbs, { recursive: true, force: true });
    const deletedAfterStart = await tool.execute({
      op: 'composition.status',
      composition_dir: 'project/deleted-after-start',
    }, ctx);
    expect(parseResult(deletedAfterStart.content)).toMatchObject({
      ok: true,
      status: 'reported',
      composition_dir_exists: false,
      artifact_drift: true,
      reconciliation_required: true,
      production_state: { stage: 'scaffold_ready' },
    });

    const filePath = path.join(workspace, 'project', 'not-a-dir.txt');
    fs.writeFileSync(filePath, 'x');
    const notDir = await tool.execute({
      op: 'composition.status',
      composition_dir: 'project/not-a-dir.txt',
    }, ctx);
    expect(parseResult(notDir.content).errorCode).toBe('E_COMPOSITION_DIR_NOT_A_DIRECTORY');
    expect(missing.isError).toBe(true);
    expect(parseResult(missing.content)).toMatchObject({
      ok: false,
      errorCode: 'E_INPUT_FILE_NOT_FOUND',
      next_action: 'retry_with_the_path_that_holds_the_file',
    });
    expect(parseResult(missing.content).message).toContain('plan_path');

    const dirPath = path.join(workspace, 'project', 'a-directory.json');
    fs.mkdirSync(dirPath, { recursive: true });
    const notAFile = await tool.execute({
      op: 'production.status',
      plan_path: 'project/a-directory.json',
    }, ctx);
    // A directory is a different mistake from a missing file and gets its own
    // code, so the model corrects the path instead of re-creating the file.
    expect(parseResult(notAFile.content)).toMatchObject({ errorCode: 'E_INPUT_NOT_A_FILE' });
    expect(parseResult(notAFile.content).message).toContain('directory');

    // The transcribe branch names its own argument, not "input".
    const transcribe = await tool.execute({
      op: 'speech.transcribe',
      input_path: 'project/no-such-audio.mp3',
    }, ctx);
    expect(parseResult(transcribe.content).message).toContain('input_path');
  });

  // The zero-route diagnosis itself (signed out, Orkas Voice switched off, not
  // configured) belongs to video-studio-tts-availability.test.ts. What is
  // pinned here is the one way out that does NOT exist: 2026-08-09 the model
  // offered to accept a narration audio file the user would upload, and a
  // schema_version 2 plan takes narration only from a listed route — no
  // segment or track binds supplied audio, so that upload has nowhere to go.
  it('closes off the recovery that cannot work when no voice is available', async () => {
    ttsMock.catalogRoutes = [];
    const toolMod = await import('../../../../src/main/model/core-agent/video-studio-tool');
    const tool = toolMod.createVideoStudioTool({ userId: UID, agentId: VIDEO_STUDIO_AGENT_ID });
    const result = await tool.execute(
      { op: 'speech.capabilities', language: 'zh-CN' },
      { state: {} } as any,
    );
    const payload = parseResult(result.content);
    expect(payload).toMatchObject({ ok: false, status: 'unavailable', routes: [] });
    // The specific remedy comes from the availability diagnosis, not from here.
    expect(String(payload.next_action || '')).toBeTruthy();
    expect(payload.invariant).toMatch(/captions and no narration track/);
    expect(payload.invariant).toMatch(/NOT one of them/);
    expect(payload.invariant).toMatch(/no segment or track binds supplied audio/);
  });

  it('names the recovery when no configured voice is verified for the narration language', async () => {
    const toolMod = await import('../../../../src/main/model/core-agent/video-studio-tool');
    const tool = toolMod.createVideoStudioTool({ userId: UID, agentId: VIDEO_STUDIO_AGENT_ID });
    const result = await tool.execute(
      { op: 'speech.capabilities', language: 'ja-JP' },
      { state: {} } as any,
    );
    const payload = parseResult(result.content);
    expect(payload.routes[0].voices).toEqual([]);
    expect(payload.routes[0].voice_count).toBe(0);
    // An empty list alone would leave the Agent guessing whether the catalog
    // failed to load; the dead end and both ways out are stated.
    expect(payload.message).toContain('ja-JP');
    expect(payload.message).toContain('all_voices');
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
    // While the plan is unapproved, status carries the plan itself — the
    // operation the model reaches for when someone asks to see it. It used to
    // return only hashes and drift flags, so "方案展示一下" had no answer.
    const status = parseResult(result.content);
    expect(status.plan_approval_current).toBe(false);
    expect(String(status.plan_summary || '')).toContain('Scenes:');
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
      expect.objectContaining({ status: 'interrupted', consumes_same_input_attempt: false }),
    ]);
    const primary = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    // The operation's identity is what recovery restores, and it is a durable
    // fact rather than a model-facing one — a model can neither compute nor act
    // on a uuid, so the summary drops it and this asserts where it lives.
    expect(primary.operation_journal).toEqual([
      expect.objectContaining({ operation_id: 'recover-from-mirror', status: 'interrupted' }),
    ]);
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
    const approvalResult = parseResult(approval.content);
    expect(approvalResult).toMatchObject({
      errorCode: 'E_GATE_B_REQUIREMENTS_INCOMPLETE',
      approval_received: true,
      approval_still_valid: true,
      user_reconfirmation_required: false,
      next_step_owner: 'agent',
      interaction_required: false,
      same_turn_continuation_required: true,
      execution: {
        next_action: 'repair_current_plan_artifacts_before_confirmation',
        next_step_owner: 'agent',
        continue_in_current_turn: true,
        interaction_required: false,
        requires_concrete_mutation_before_retry: true,
      },
      user_guidance: {
        what_happened: expect.stringContaining('production-plan details'),
        what_remains_safe: expect.stringContaining('confirmation remains valid'),
        what_happens_next: expect.stringContaining('correct'),
      },
    });
    expect(approval.content).toContain('COMPOSITION_MANIFEST_PRIMARY_COPY_ALL_CAPS');
    const state = await (await import('../../../../src/main/features/video_studio_state'))
      .readVideoProductionState(mod.videoStudioProductionStatePath(opts, compositionDir), compositionDir);
    expect(state.plan_approval).toBeUndefined();
  });

  it.each([
    {
      label: 'unparseable composition manifest',
      expectedRole: 'manifest',
      expectedCode: 'invalid_manifest',
      mutate: () => {
        fs.writeFileSync(
          path.join(compositionDir, 'composition-manifest.json'),
          '{"schema_version": 2,',
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
      approval_still_valid: true,
      user_reconfirmation_required: false,
      requires_user_decision: false,
      next_step_owner: 'agent',
      interaction_required: false,
      same_turn_continuation_required: true,
      next_action: 'repair_invalid_plan_artifacts_then_retry_composition.approve_plan',
      execution: {
        next_action: 'repair_invalid_plan_artifacts_then_retry_composition.approve_plan',
        next_step_owner: 'agent',
        continue_in_current_turn: true,
        interaction_required: false,
        requires_concrete_mutation_before_retry: true,
      },
      user_guidance: {
        what_happened: expect.stringContaining('formatting or field-validation problem'),
        what_remains_safe: expect.stringContaining('confirmation remains valid'),
        what_happens_next: expect.stringContaining('repair only the listed fields'),
      },
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
          role: 'plan_manifest',
          review_status: 'current_input',
        },
        artifacts: expect.arrayContaining([
          expect.objectContaining({ role: 'plan_manifest' }),
        ]),
      },
    });
    expect(payload.message).toContain('confirmation is still valid');
    expect(published.flat()).toEqual(expect.arrayContaining([
      path.join(compositionDir, 'composition-manifest.json'),
    ]));
  });

  it('repairs an invalid plan file, reuses the same confirmation, and continues production', async () => {
    makePlanVisualOnly();
    const brokenManifestPath = path.join(compositionDir, 'composition-manifest.json');
    const validManifest = fs.readFileSync(brokenManifestPath, 'utf8');
    fs.writeFileSync(brokenManifestPath, '{"schema_version":2,', 'utf8');

    const mod = await import('../../../../src/main/model/core-agent/video-studio-tool');
    const tool = mod.createVideoStudioTool({
      userId: UID,
      cid: 'cid-plan-artifact-auto-repair-continuation',
      turnId: 'turn-plan-artifact-auto-repair-continuation',
      agentId: VIDEO_STUDIO_AGENT_ID,
      agentName: 'VideoStudio',
      userMessage: approvalSubmission('gate_b_decision', 'approve'),
    });
    const ctx = { workingDir: workspace, state: {} } as any;

    const invalid = parseResult((await tool.execute({
      op: 'composition.approve_plan',
      composition_dir: 'project/composition',
    }, ctx)).content);
    expect(invalid).toMatchObject({
      errorCode: 'E_GATE_B_ARTIFACT_INVALID',
      approval_still_valid: true,
      same_turn_continuation_required: true,
      interaction_required: false,
      execution: {
        next_action: 'repair_invalid_plan_artifacts_then_retry_composition.approve_plan',
        continue_in_current_turn: true,
        requires_concrete_mutation_before_retry: true,
      },
    });

    // Simulates the model-owned edit_file mutation named by artifact_issues.
    fs.writeFileSync(brokenManifestPath, validManifest, 'utf8');
    const approved = await tool.execute({
      op: 'composition.approve_plan',
      composition_dir: 'project/composition',
    }, ctx);
    expect(approved.isError).toBe(false);
    expect(parseResult(approved.content)).toMatchObject({
      status: 'approved',
    });

    const doctor = await tool.execute({
      op: 'composition.doctor',
      composition_dir: 'project/composition',
    }, ctx);
    expect(doctor.isError).toBe(false);
    const prepared = await tool.execute({
      op: 'composition.prepare',
      composition_dir: 'project/composition',
    }, ctx);
    expect(prepared.isError).toBe(false);
    expect(parseResult(prepared.content).production_state).toMatchObject({
      stage: 'scaffold_ready',
    });
  });

  it('names the failing manifest fields when a post-approval operation revalidates the plan', async () => {
    // 2026-08-07: composition.inspect after approval returned "requires one
    // coherent script, shotlist, and valid composition manifest" — it named
    // two retired files, did not say the manifest failed schema validation,
    // and dropped the validation detail the host had already computed. The
    // model spent ~4 minutes and a full gate-control re-read discovering by
    // trial what this result could have stated.
    makePlanVisualOnly();
    const mod = await import('../../../../src/main/model/core-agent/video-studio-tool');
    const tool = mod.createVideoStudioTool({
      userId: UID,
      cid: 'cid-post-approval-manifest-detail',
      turnId: 'turn-post-approval-manifest-detail',
      agentId: VIDEO_STUDIO_AGENT_ID,
      agentName: 'VideoStudio',
      userMessage: approvalSubmission('gate_b_decision', 'approve'),
    });
    const ctx = { workingDir: workspace, state: {} } as any;
    expect((await tool.execute({
      op: 'composition.approve_plan',
      composition_dir: 'project/composition',
    }, ctx)).isError).toBe(false);

    const manifestPath = path.join(compositionDir, 'composition-manifest.json');
    const approvedManifest = fs.readFileSync(manifestPath, 'utf8');
    // Parses as JSON, fails the plan schema — the shape a model edit produces.
    const broken = JSON.parse(approvedManifest);
    broken.scenes = 'every scene, as prose';
    fs.writeFileSync(manifestPath, JSON.stringify(broken, null, 2), 'utf8');

    const invalid = parseResult((await tool.execute({
      op: 'composition.inspect',
      composition_dir: 'project/composition',
    }, ctx)).content);
    expect(invalid).toMatchObject({
      errorCode: 'E_GATE_B_ARTIFACT_INVALID',
      plan_gate_class: 'artifact_repair',
    });
    expect(invalid.message).toContain('composition-manifest.json');
    expect(invalid.message).toContain('scenes');
    // The retired artifacts must not reappear in a repair instruction: on
    // 2026-08-06 a host message naming them made the model author a shotlist.
    expect(invalid.message).not.toMatch(/shotlist/i);
    expect(invalid.message).not.toMatch(/\bscript\b/i);
    expect(invalid.artifact_issues?.[0]).toMatchObject({ role: 'manifest', code: 'invalid_manifest' });
    expect(invalid.artifact_issues[0].details.some(
      (detail: { path: string }) => detail.path.includes('scenes'),
    )).toBe(true);

    // Negative control: a manifest that is GONE is a different repair and must
    // not be described as a structure mismatch. Collapsing every incomplete
    // identity into one sentence is what made the old message useless.
    fs.unlinkSync(manifestPath);
    const missing = parseResult((await tool.execute({
      op: 'composition.inspect',
      composition_dir: 'project/composition',
    }, ctx)).content);
    expect(missing).toMatchObject({ errorCode: 'E_GATE_B_ARTIFACT_CONFLICT' });
    expect(missing.message).toMatch(/could not be found/i);
    expect(missing.message).not.toMatch(/does not match the required/i);
    expect(missing.artifact_issues).toBeUndefined();
  });

  it('re-stamps the fs read baseline when a native op rewrites a composition file', async () => {
    // `edit_file` enforces read-before-edit through a run-scoped stamp and
    // refreshes it after its own write, so consecutive edits need no re-read.
    // Native composition writes are another writer in the same run: before
    // this fix, `rename` left the stamp stale and the model's next edit spent
    // a `read_file` round trip on E_STALE. On 2026-08-07, with 29s of model
    // latency per round trip, that pattern ran 30 reads against 21 writes.
    makePlanVisualOnly();
    const htmlPath = path.join(compositionDir, 'index.html');
    // Give the HTML a duration the manifest disagrees with, so reconcile has
    // to rewrite it — and by a different byte length, so the staleness check
    // cannot pass on mtime resolution alone.
    fs.writeFileSync(htmlPath, fs.readFileSync(htmlPath, 'utf8').replace(
      'data-scene-id="cover" data-start="0" data-duration="5"',
      'data-scene-id="cover" data-start="0" data-duration="30"',
    ), 'utf8');

    const tracker = await import('../../../../src/main/model/core-agent/read-tracker');
    const mod = await import('../../../../src/main/model/core-agent/video-studio-tool');
    const ctx = {
      workingDir: workspace,
      state: { [tracker.READ_FILE_STATE_KEY]: new Map() },
    } as any;
    // The model read the file this run: edits are authorized.
    tracker.recordRead(ctx, htmlPath);
    expect(tracker.checkEditFreshness(ctx, htmlPath, fs.statSync(htmlPath))).toBeNull();

    const reconciled = await mod.createVideoStudioTool({
      userId: UID,
      cid: 'cid-native-write-read-baseline',
      turnId: 'turn-native-write-read-baseline',
      agentId: VIDEO_STUDIO_AGENT_ID,
      agentName: 'VideoStudio',
      userMessage: '继续',
    }).execute({
      op: 'composition.reconcile',
      composition_dir: 'project/composition',
    }, ctx);
    expect(reconciled.isError).toBe(false);
    // The op really did rewrite the file; otherwise the assertion below is vacuous.
    expect(parseResult(reconciled.content).changed).toBe(true);
    expect(fs.readFileSync(htmlPath, 'utf8')).not.toContain('data-duration="30"');

    expect(tracker.checkEditFreshness(ctx, htmlPath, fs.statSync(htmlPath))).toBeNull();

    // Negative control: a writer outside the tool must still invalidate the
    // baseline. Re-stamping after our own writes is not disabling OCC.
    fs.writeFileSync(htmlPath, `${fs.readFileSync(htmlPath, 'utf8')}\n<!-- edited elsewhere -->`, 'utf8');
    expect(tracker.checkEditFreshness(ctx, htmlPath, fs.statSync(htmlPath))?.code).toBe('E_STALE');
  });

  it('keeps a genuinely missing plan file distinct from invalid content', async () => {
    makePlanVisualOnly();
    // The manifest is the plan, so a missing plan file means a missing
    // manifest.
    fs.unlinkSync(path.join(compositionDir, 'composition-manifest.json'));
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
          expect.objectContaining({ role: 'manifest', status: 'missing' }),
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
    // The keyframe preview stop is prose-only, so there is no preview
    // approval to reject an off-topic turn on — the operation does not exist.
    const unrelatedPreviewApproval = await unrelatedTurnTool.execute({
      op: 'composition.approve_preview',
      composition_dir: 'project/composition',
    }, ctx);
    expect(unrelatedPreviewApproval.isError).toBe(true);
    expect(unrelatedPreviewApproval.content).toContain('op must be one of');

    const malformedPreviewApprovalTool = mod.createVideoStudioTool({
      userId: UID,
      cid: 'cid-explicit-gates',
      turnId: 'turn-draft-malformed-evidence',
      agentId: VIDEO_STUDIO_AGENT_ID,
      agentName: 'VideoStudio',
      userMessage: '继续',
    });
    const malformedPreviewApproval = await malformedPreviewApprovalTool.execute({
      op: 'composition.approve_draft',
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
        gate: 'draft',
      },
    });
    expect((await stateMod.readVideoProductionState(statePath, compositionDir)).preview)
      .toMatchObject({ status: 'ready' });

    // A quote the user never wrote is a provenance failure, not a shape one.
    // 2026-08-10: the model invented `quote: "确认方案"` for a decision the user
    // had not made, was told its object was malformed and to re-interpret and
    // retry, sent the identical object again, and the no-progress breaker
    // ended the turn with a page of English diagnostics in the user's chat.
    // Reshaping cannot fix a quote that is not there, so this must not read as
    // an agent-owned retry.
    const fabricatedQuoteTool = mod.createVideoStudioTool({
      userId: UID,
      cid: 'cid-explicit-gates',
      turnId: 'turn-fabricated-quote',
      agentId: VIDEO_STUDIO_AGENT_ID,
      agentName: 'VideoStudio',
      userMessage: '继续',
    });
    const fabricated = await fabricatedQuoteTool.execute({
      op: 'composition.approve_draft',
      composition_dir: 'project/composition',
      decision_evidence: decisionEvidence('draft', 'approve', '确认方案'),
    }, ctx);
    expect(fabricated.isError).toBe(true);
    const fabricatedResult = parseResult(fabricated.content);
    expect(fabricatedResult).toMatchObject({
      errorCode: 'E_DECISION_EVIDENCE_NOT_FROM_USER',
      decision_evidence_issue: 'quote_not_in_current_turn',
      requires_user_decision: true,
      automatic_recovery_expected: false,
      next_step_owner: 'user',
      same_turn_continuation_required: false,
      next_action: 'present_review_material_and_end_turn_unless_the_user_already_decided',
    });
    // Says which of the two it is, and forbids the retry that looped.
    expect(String(fabricatedResult.message)).toContain('does not appear in the current user message');
    expect(String(fabricatedResult.message)).toContain('do not reshape it and retry');
    expect(String(fabricatedResult.message)).toContain('present the current review material');
    // A malformed object still gets the agent-owned correction path.
    expect(String(fabricated.content)).not.toContain('retry_same_operation_with_structured_decision_evidence');

    // A JSON-string `decision_evidence` is still accepted on a surviving gate.
    const draftEvidenceTool = mod.createVideoStudioTool({
      userId: UID,
      cid: 'cid-explicit-gates',
      turnId: 'turn-draft-string-evidence',
      agentId: VIDEO_STUDIO_AGENT_ID,
      agentName: 'VideoStudio',
      userMessage: '继续',
    });
    expect(String((await draftEvidenceTool.execute({
      op: 'composition.approve_draft',
      composition_dir: 'project/composition',
      decision_evidence: JSON.stringify(decisionEvidence('draft', 'approve', '继续')),
    }, ctx)).content)).not.toContain('E_DECISION_EVIDENCE_INVALID');

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

    // Right gate, but unbound: a Final decision that names no artifact cannot
    // authorize export, and that holds even here where the project has never
    // been revised.
    // With the form protocol gone there is no unbound-signature rejection left
    // to assert here: a bare `approve` from a real user turn is simply an
    // approval. What still guards the final video is asserted below — the
    // draft must exist and its inputs must not have moved.
    const draftSignature = await mod.videoStudioCompositionSignature(compositionDir);
    const draftApprovalTool = mod.createVideoStudioTool({
      userId: UID,
      cid: 'cid-explicit-gates',
      turnId: 'turn-draft-approval',
      agentId: VIDEO_STUDIO_AGENT_ID,
      agentName: 'VideoStudio',
      userMessage: approvalSubmission('gate_d_decision', `approve::${draftSignature}`),
    });
    expect((await draftApprovalTool.execute({
      op: 'composition.approve_draft',
      composition_dir: 'project/composition',
    }, ctx)).isError).toBe(false);
  });

  it('corrects omitted composition approval evidence in the same turn without reopening confirmation', async () => {
    makePlanVisualOnly();
    const published: string[][] = [];
    const mod = await import('../../../../src/main/model/core-agent/video-studio-tool');
    const ctx = { workingDir: workspace, state: {} } as any;
    const tool = mod.createVideoStudioTool({
      userId: UID,
      cid: 'cid-composition-omitted-evidence',
      turnId: 'turn-composition-omitted-evidence',
      agentId: VIDEO_STUDIO_AGENT_ID,
      agentName: 'VideoStudio',
      userMessage: '<msg from="user">就按这个方案制作</msg>',
      onOutputsPublished: async (paths: string[]) => {
        published.push(paths);
        return paths;
      },
    });

    const omitted = await tool.execute({
      op: 'composition.approve_plan',
      composition_dir: 'project/composition',
    }, ctx);
    expect(omitted.isError).toBe(true);
    expect(omitted.synthesizeAndEndTurn).toBeUndefined();
    expect(parseResult(omitted.content)).toMatchObject({
      errorCode: 'E_DECISION_EVIDENCE_REQUIRED',
      outcome: 'continue',
      presentation_required: false,
      requires_user_decision: false,
      user_reconfirmation_required: false,
      automatic_recovery_expected: true,
      next_step_owner: 'agent',
      interaction_required: false,
      same_turn_continuation_required: true,
      next_action: 'classify_current_reply_then_retry_with_evidence_or_continue_without_gate',
      review_package: {
        presentation_required: false,
        conclusion: {
          requires_user_decision: false,
          next_step_owner: 'agent',
        },
      },
    });
    expect(published).toEqual([]);

    const corrected = await tool.execute({
      op: 'composition.approve_plan',
      composition_dir: 'project/composition',
      decision_evidence: decisionEvidence('plan', 'approve', '就按这个方案制作'),
    }, ctx);
    expect(corrected.isError, corrected.content).toBe(false);
    expect(parseResult(corrected.content)).toMatchObject({ ok: true, status: 'approved' });
  });

  it('binds a structured final-video decision to the displayed draft version', async () => {
    makePlanVisualOnly();
    const mod = await import('../../../../src/main/model/core-agent/video-studio-tool');
    const stateMod = await import('../../../../src/main/features/video_studio_state');
    const ctx = { workingDir: workspace, state: {} } as any;
    const baseOpts = {
      userId: UID,
      cid: 'cid-versioned-draft-decision',
      turnId: 'turn-plan',
      agentId: VIDEO_STUDIO_AGENT_ID,
      agentName: 'VideoStudio',
      userMessage: '确认方案',
    };
    expect((await mod.createVideoStudioTool(baseOpts).execute({
      op: 'composition.approve_plan',
      composition_dir: 'project/composition',
      decision_evidence: decisionEvidence('plan', 'approve', '确认方案'),
    }, ctx)).isError).toBe(false);

    const statePath = mod.videoStudioProductionStatePath(baseOpts, compositionDir);
    const draftPath = path.join(workspace, 'project', 'render', 'draft.mp4');
    fs.mkdirSync(path.dirname(draftPath), { recursive: true });
    fs.writeFileSync(draftPath, 'draft-a');
    expect(await mod.recordVideoStudioGate(statePath, 'draft', compositionDir, 'turn-draft-a', {
      draft_ready: true,
      path: draftPath,
    })).toBe(true);
    const signatureA = (await stateMod.readVideoProductionState(statePath, compositionDir)).draft!.signature;

    fs.appendFileSync(path.join(compositionDir, 'index.html'), '\n<!-- revised visual -->\n');
    fs.writeFileSync(draftPath, 'draft-b');
    expect(await mod.recordVideoStudioGate(statePath, 'draft', compositionDir, 'turn-draft-b', {
      draft_ready: true,
      path: draftPath,
    })).toBe(true);
    const signatureB = (await stateMod.readVideoProductionState(statePath, compositionDir)).draft!.signature;
    expect(signatureB).not.toBe(signatureA);

    const stale = await mod.createVideoStudioTool({
      ...baseOpts,
      turnId: 'turn-stale-form',
      userMessage: approvalSubmission('gate_d_decision', `approve::${signatureA}`),
    }).execute({
      op: 'composition.approve_draft',
      composition_dir: 'project/composition',
    }, ctx);
    expect(parseResult(stale.content)).toMatchObject({
      errorCode: 'E_VIDEO_REVIEW_SUBMISSION_SUPERSEDED',
      submitted_artifact_signature: signatureA,
      current_artifact_signature: signatureB,
      submitted_decision_status: 'superseded',
      current_review_status: 'pending',
      outcome: 'need_user',
    });
    expect(stale.synthesizeAndEndTurn).toBe(true);
    expect((await stateMod.readVideoProductionState(statePath, compositionDir)).draft?.status).toBe('ready');

    const current = await mod.createVideoStudioTool({
      ...baseOpts,
      turnId: 'turn-current-form',
      userMessage: approvalSubmission('gate_d_decision', `approve::${signatureB}`),
    }).execute({
      op: 'composition.approve_draft',
      composition_dir: 'project/composition',
    }, ctx);
    expect(current.isError).toBe(false);
    expect((await stateMod.readVideoProductionState(statePath, compositionDir)).draft?.status).toBe('approved');
  });

  it('keeps every snapshot runtime artifact out of the authored-input signature', async () => {
    // 2026-08-07: composition.snapshot without output_path returned the bare
    // string "output_path is required for composition.snapshot" — no error
    // code, no envelope, no next step — costing a full ~30s model round trip
    // for an argument with exactly one canonical value. `preview/` is excluded
    // from every composition-signature version, so defaulting there cannot
    // perturb an approved plan.
    makePlanVisualOnly();
    const videoStudio = await import('../../../../src/main/features/video_studio');
    const toolMod = await import('../../../../src/main/model/core-agent/video-studio-tool');
    const stateMod = await import('../../../../src/main/features/video_studio_state');
    const ctx = { workingDir: workspace, state: {} } as any;
    const opts = {
      userId: UID,
      cid: 'cid-snapshot-default-output',
      turnId: 'turn-snapshot-default-output',
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
    await stateMod.updateVideoProductionState(statePath, compositionDir, (state) => {
      state.stage = 'visuals_ready';
    });

    const snapshotSpy = vi.spyOn(videoStudio, 'snapshotComposition').mockResolvedValue({
      ok: true,
      op: 'composition.snapshot',
      preview_ready: true,
      preview_qa: { ok: true, error_count: 0 },
      preflight: { status: 'passed', blocking_error_count: 0 },
      contact_sheet: path.join(compositionDir, 'preview', 'contact-sheet.png'),
      frame_paths: [path.join(compositionDir, 'preview', 'first-frame.png')],
    } as any);

    const defaulted = await tool.execute({
      op: 'composition.snapshot',
      composition_dir: 'project/composition',
    }, ctx);
    expect(defaulted.isError).toBe(false);
    expect(snapshotSpy.mock.calls.at(-1)?.[0]).toMatchObject({
      snapshotAbsPath: path.join(compositionDir, 'preview', 'first-frame.png'),
    });

    // Negative control: an explicit destination still wins, so the default
    // never silently overrides a caller that named its own path.
    await tool.execute({
      op: 'composition.snapshot',
      composition_dir: 'project/composition',
      output_path: 'project/composition/preview/second-pass.png',
    }, ctx);
    expect(snapshotSpy.mock.calls.at(-1)?.[0]).toMatchObject({
      snapshotAbsPath: path.join(compositionDir, 'preview', 'second-pass.png'),
    });

    // 2026-08-07 live-lock: the model snapshotted to
    // <composition>/project/render/, which sits inside the authored-input
    // signature. `previewEvidenceRunDir` names each run's frame directory
    // with a fresh random id, so every capture changed the signature the
    // draft preflight compares against — draft answered E_HTML_PREVIEW_STALE,
    // the model re-captured, and the loop never terminated. Four "继续"
    // replies and six frame directories later the user was still at the
    // preview. An in-composition destination must land under the excluded
    // preview/ subtree.
    const relocated = await tool.execute({
      op: 'composition.snapshot',
      composition_dir: 'project/composition',
      output_path: 'project/composition/project/render/snapshot.png',
    }, ctx);
    expect(snapshotSpy.mock.calls.at(-1)?.[0]).toMatchObject({
      snapshotAbsPath: path.join(compositionDir, 'preview', 'snapshot.png'),
    });
    expect(parseResult(relocated.content).output_path_relocated).toMatchObject({
      requested: path.join(compositionDir, 'project', 'render', 'snapshot.png'),
      used: path.join(compositionDir, 'preview', 'snapshot.png'),
    });

    // Negative control: a destination OUTSIDE the composition is already safe
    // and must be left exactly where the caller put it.
    const outside = await tool.execute({
      op: 'composition.snapshot',
      composition_dir: 'project/composition',
      output_path: 'project/render/snapshot.png',
    }, ctx);
    expect(snapshotSpy.mock.calls.at(-1)?.[0]).toMatchObject({
      snapshotAbsPath: path.join(workspace, 'project', 'render', 'snapshot.png'),
    });
    expect(parseResult(outside.content).output_path_relocated).toBeUndefined();

    // findings_path carries the same hazard: runtime evidence written into
    // the signed composition changes the signature the next preflight reads.
    await tool.execute({
      op: 'composition.snapshot',
      composition_dir: 'project/composition',
      findings_path: 'project/composition/snapshot-findings.json',
    }, ctx);
    expect(snapshotSpy.mock.calls.at(-1)?.[0]).toMatchObject({
      findingsAbsPath: path.join(compositionDir, 'qa', 'snapshot-findings.json'),
    });
    await tool.execute({
      op: 'composition.snapshot',
      composition_dir: 'project/composition',
      findings_path: 'project/composition/qa/explicit-findings.json',
    }, ctx);
    expect(snapshotSpy.mock.calls.at(-1)?.[0]).toMatchObject({
      findingsAbsPath: path.join(compositionDir, 'qa', 'explicit-findings.json'),
    });
  });

  it('opens preview review directly from a passing snapshot and keeps design review advisory', async () => {
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
    fs.mkdirSync(path.dirname(framePaths[0]), { recursive: true });
    fs.writeFileSync(contactSheet, PNG_2X2);
    for (const framePath of framePaths) fs.writeFileSync(framePath, PNG_2X2);
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
    expect(snapshot.images).toHaveLength(1);
    const contactSheetPixels = await sharp(fs.readFileSync(contactSheet)).ensureAlpha().raw().toBuffer();
    const attachedPixels = await sharp(Buffer.from(snapshot.images![0].data, 'base64'))
      .ensureAlpha().raw().toBuffer();
    expect(attachedPixels).toEqual(contactSheetPixels);
    // P3: the model-scored design review is advisory. A passing snapshot IS
    // the preview-review moment: the contact sheet publishes immediately and
    // the user review opens without any self-graded submission.
    expect(parseResult(snapshot.content)).toMatchObject({
      design_review_required: false,
      preview_design_review_required: false,
      visual_evidence: {
        attached: true,
        role: 'preview_contact_sheet',
        path: contactSheet,
        policy: 'attached_only_after_native_deterministic_qa_passed',
      },
    });
    expect(published).toEqual([[path.resolve(contactSheet)]]);

    const pending = await stateMod.readVideoProductionState(statePath, compositionDir);
    expect(stateMod.nextVideoProductionOps(pending)).not.toContain('composition.approve_preview');
    expect(stateMod.nextVideoProductionOps(pending)).not.toContain('composition.submit_design_review');

    // Legacy state recorded by a pre-P3 host (pending required review) must
    // not block the user's approval either.
    await stateMod.updateVideoProductionState(statePath, compositionDir, (state) => {
      if (!state.preview) throw new Error('preview missing');
      state.preview.design_review = { required: true, status: 'pending' };
    });

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

    const reviewed = await stateMod.readVideoProductionState(statePath, compositionDir);
    expect(stateMod.nextVideoProductionOps(reviewed)).not.toContain('composition.approve_preview');
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
    // Advisory review: the contact sheet already published at the snapshot.
    expect(published).toEqual([[path.resolve(contactSheet)]]);

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
    // Mirrors the feature: it writes the report wherever the tool points it
    // (writeReportIfRequested) and returns the same bytes inline.
    const draftReport = {
      steps: {
        render: { status: 'passed' },
        video_qa: { ok: true, samples: ['x'.repeat(9000)] },
      },
    };
    vi.spyOn(videoStudio, 'draftComposition').mockImplementation(async (options: any) => {
      fs.mkdirSync(path.dirname(options.outputAbsPath), { recursive: true });
      fs.writeFileSync(options.outputAbsPath, 'rendered draft');
      fs.writeFileSync(path.join(renderDir, 'draft-cover.png'), 'cover');
      fs.mkdirSync(path.join(renderDir, 'draft-evidence'), { recursive: true });
      fs.writeFileSync(path.join(renderDir, 'draft-evidence', '01-first-frame.png'), 'frame');
      if (options.reportAbsPath) {
        fs.mkdirSync(path.dirname(options.reportAbsPath), { recursive: true });
        fs.writeFileSync(options.reportAbsPath, JSON.stringify(draftReport));
      }
      return {
        ok: true,
        op: 'composition.draft',
        path: draftPath,
        cover_path: path.join(renderDir, 'draft-cover.png'),
        draft_ready: true,
        report: { ...draftReport, report_path: options.reportAbsPath || '' },
      } as any;
    });
    // report_path is optional and the model routinely omits it. On 2026-08-09
    // seven passing drafts arrived without it, so no report reached disk, the
    // passing-report projection stayed off because it guards on a disk copy,
    // and each ~95K result spilled instead. The host defaults the path beside
    // the required output rather than leaving its own result size to an
    // argument the model may not pass.
    const draft = await tool.execute({
      op: 'composition.draft',
      composition_dir: 'project/composition',
      output_path: 'project/render/draft.mp4',
    }, ctx);
    expect(draft.isError).toBe(false);
    const draftPayload = parseResult(draft.content);
    expect(draftPayload.report_path).toBe(path.join(renderDir, 'draft-report.json'));
    expect(fs.existsSync(draftPayload.report_path)).toBe(true);
    // With the evidence on disk the passing report projects to its verdicts.
    expect(draftPayload.report.steps).toEqual({ render: 'passed', video_qa: 'ok' });
    expect(draft.content).not.toContain('x'.repeat(200));
    // P3: no static design review after the draft — deterministic render QA
    // passed, so Gate D opens directly.
    expect(parseResult(draft.content)).toMatchObject({
      design_review_required: false,
      gate_d_ready: true,
      next_action: 'open_gate_d',
      production_state: {
        stage: 'draft_ready',
        draft_design_review: {
          required: false,
          status: 'passed',
          verdict: 'not_required',
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

  it('marks which Gate B failures are the user\'s and which are the agent\'s own file repair', async () => {
    // 2026-08-07: one run hit five of the six E_GATE_B_* codes in 43 minutes
    // and read the whole family as "the plan keeps needing re-approval". Only
    // a changed approved intent is the user's; the rest say a FILE is broken.
    // Codes are not renamed (skills, tests and the benchmark read them), so
    // the split travels as a derived field.
    const mod = await import('../../../../src/main/model/core-agent/video-studio-tool');
    for (const code of [
      'E_GATE_B_ARTIFACTS_INCOMPLETE',
      'E_GATE_B_ARTIFACT_INVALID',
      'E_GATE_B_REQUIREMENTS_INCOMPLETE',
      'E_GATE_B_AMENDMENT_NOT_APPLIED',
      'E_GATE_B_ARTIFACT_CONFLICT',
      'E_GATE_B_NARRATION_FIT_REQUIRED',
    ]) {
      expect(mod.deriveVideoStudioPlanGateClass(code), code).toBe('artifact_repair');
    }
    for (const code of [
      'E_GATE_B_ARTIFACT_CHANGED',
      'E_GATE_B_APPROVAL_REQUIRED',
      'E_GATE_B_EXPLICIT_APPROVAL_REQUIRED',
      'E_GATE_B_APPROVE_PLAN_REQUIRED',
    ]) {
      expect(mod.deriveVideoStudioPlanGateClass(code), code).toBe('intent_amendment');
    }
    // Non-plan failures carry no class rather than a misleading default.
    expect(mod.deriveVideoStudioPlanGateClass('E_PREVIEW_QA_BLOCKED')).toBeUndefined();
    expect(mod.deriveVideoStudioPlanGateClass(undefined)).toBeUndefined();

    // And it reaches the serialized result the model actually reads.
    makePlanVisualOnly();
    const ctx = { workingDir: workspace, state: {} } as any;
    fs.writeFileSync(path.join(compositionDir, 'composition-manifest.json'), '{ not json', 'utf8');
    const blocked = await mod.createVideoStudioTool({
      userId: UID,
      cid: 'cid-gate-class',
      turnId: 'turn-gate-class',
      agentId: VIDEO_STUDIO_AGENT_ID,
      agentName: 'VideoStudio',
      userMessage: '确认',
    }).execute({
      op: 'composition.approve_plan',
      composition_dir: 'project/composition',
      decision_evidence: decisionEvidence('plan', 'approve', '确认'),
    }, ctx);
    expect(blocked.isError).toBe(true);
    const payload = parseResult(blocked.content);
    expect(String(payload.errorCode)).toMatch(/^E_GATE_B_/);
    expect(payload.plan_gate_class).toBe('artifact_repair');
  });

  it('says a missing manifest is missing, without quoting the local path', async () => {
    // Four sites passed the raw fs error through as the message: a manifest
    // that did not exist yet answered as "invalid" with the full absolute
    // path inside (ENOENT ... open '/Users/...'). Missing and invalid are
    // different answers — missing points at the step that creates the file.
    // Observed live 2026-08-09 (composition.reconcile on a never-derived
    // child) before the media-segment routing intercepted that instance.
    writeAutoParentPlan();
    const mod = await import('../../../../src/main/model/core-agent/video-studio-tool');
    const ctx = { workingDir: workspace, state: {} } as any;
    const dir = path.join(workspace, 'project', 'compositions', 'intro');
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });

    const reconcile = parseResult(String((await mod.createVideoStudioTool({
      userId: UID, cid: 'cid-missing-manifest', turnId: 'turn-missing',
      agentId: VIDEO_STUDIO_AGENT_ID, agentName: 'VideoStudio',
      userMessage: '<msg from="user">继续</msg>',
    }).execute({ op: 'composition.reconcile', composition_dir: 'project/compositions/intro' }, ctx)).content));
    expect(reconcile.errorCode).toBe('E_COMPOSITION_MANIFEST_INVALID');
    expect(String(reconcile.message)).toContain('no composition-manifest.json here to reconcile');
    expect(String(reconcile.message)).toContain('composition.approve_plan');
    expect(String(reconcile.message)).not.toContain('ENOENT');
    expect(String(reconcile.message)).not.toContain(workspace);

    // A manifest that exists but does not parse keeps the invalid answer,
    // with any fs detail path-redacted rather than dropped.
    fs.writeFileSync(path.join(dir, 'composition-manifest.json'), '{not json', 'utf8');
    const invalid = parseResult(String((await mod.createVideoStudioTool({
      userId: UID, cid: 'cid-missing-manifest', turnId: 'turn-invalid',
      agentId: VIDEO_STUDIO_AGENT_ID, agentName: 'VideoStudio',
      userMessage: '<msg from="user">继续</msg>',
    }).execute({ op: 'composition.reconcile', composition_dir: 'project/compositions/intro' }, ctx)).content));
    expect(invalid.errorCode).toBe('E_COMPOSITION_MANIFEST_INVALID');
    expect(String(invalid.message)).toContain('Cannot reconcile an invalid composition manifest');
    expect(String(invalid.message)).not.toContain('no composition-manifest.json here to reconcile');
    expect(String(invalid.message)).not.toContain(workspace);
  });

  it('tells a media-backed segment it is not a composition, and leaves no directory behind', async () => {
    // 2026-08-09 driven run: the model called composition.approve_plan for an
    // `edit` segment. The artifacts check ran before the segment-kind check,
    // so the answer was "restore composition-manifest.json" — a file that
    // segment must never have — the approval path created an empty directory
    // for it (the manifest derivation refuses non-compose segments), doctor
    // then passed on that empty directory, and reconcile finally died on a
    // raw ENOENT. The parent plan says what the segment is; say that first.
    writeMixedSourcePlan({
      cutProducedPath: writeCutFile(path.join('project', 'cuts', 'cut.mp4'), 'cut bytes'),
      composeIds: ['body'],
    });
    const mod = await import('../../../../src/main/model/core-agent/video-studio-tool');
    const ctx = { workingDir: workspace, state: {} } as any;
    expect((await mod.createVideoStudioTool({
      userId: UID, cid: 'cid-kind-parent', turnId: 'turn-kind-b',
      agentId: VIDEO_STUDIO_AGENT_ID, agentName: 'VideoStudio',
      userMessage: approvalSubmission('gate_b_decision', 'approve'),
    }).execute({ op: 'production.approve_plan', plan_path: 'project/plan.json' }, ctx)).isError).toBe(false);

    const cutDir = path.join(workspace, 'project', 'compositions', 'cut');
    fs.rmSync(cutDir, { recursive: true, force: true });
    const answer = parseResult(String((await mod.createVideoStudioTool({
      userId: UID, cid: 'cid-kind', turnId: 'turn-kind',
      agentId: VIDEO_STUDIO_AGENT_ID, agentName: 'VideoStudio',
      userMessage: '<msg from="user">继续</msg>',
    }).execute({
      op: 'composition.approve_plan',
      composition_dir: 'project/compositions/cut',
      plan_path: 'project/plan.json',
      segment_id: 'cut',
    }, ctx)).content));

    expect(answer.errorCode).toBe('E_PARENT_SEGMENT_NOT_A_COMPOSITION');
    expect(String(answer.message)).toContain('is an edit segment');
    expect(String(answer.message)).toContain('produced_path');
    expect(String(answer.message)).not.toContain('composition-manifest.json.');
    expect(String(answer.message)).not.toMatch(/Restore/i);
    // No empty directory left looking like a composition to later ops.
    expect(fs.existsSync(cutDir)).toBe(false);

    // Every composition operation is covered, not just the approval — doctor
    // used to pass on the empty directory this once created.
    const doctored = parseResult(String((await mod.createVideoStudioTool({
      userId: UID, cid: 'cid-kind', turnId: 'turn-kind-2',
      agentId: VIDEO_STUDIO_AGENT_ID, agentName: 'VideoStudio',
      userMessage: '<msg from="user">继续</msg>',
    }).execute({
      op: 'composition.doctor',
      composition_dir: 'project/compositions/cut',
      plan_path: 'project/plan.json',
      segment_id: 'cut',
    }, ctx)).content));
    expect(doctored.errorCode).toBe('E_PARENT_SEGMENT_NOT_A_COMPOSITION');

    // Negative control: a real compose segment of the same plan is untouched
    // by the kind check and inherits as before.
    const composed = await mod.createVideoStudioTool({
      userId: UID, cid: 'cid-kind', turnId: 'turn-kind-3',
      agentId: VIDEO_STUDIO_AGENT_ID, agentName: 'VideoStudio',
      userMessage: '<msg from="user">继续</msg>',
    }).execute({
      op: 'composition.approve_plan',
      composition_dir: 'project/compositions/body',
      plan_path: 'project/plan.json',
      segment_id: 'body',
    }, ctx);
    expect(String(composed.content)).not.toContain('E_PARENT_SEGMENT_NOT_A_COMPOSITION');
  });

  it('names where an unbound segment goes, not just that it is unbound', async () => {
    // Driven run, 2026-08-08: production.segment_qa answered "Author the
    // segment and inherit the parent plan approval" without naming a
    // directory. The model guessed composition_dir:"composition", got "is not
    // a directory", ran two filesystem searches, then built directories and
    // stub manifests by hand — and the ownership gate rejected those, the
    // same trap the run before it hit. The host computes this path itself in
    // every other branch; it appears in no skill, so the caller cannot infer
    // it.
    writeAutoParentPlan();
    const mod = await import('../../../../src/main/model/core-agent/video-studio-tool');
    const ctx = { workingDir: workspace, state: {} } as any;
    fs.rmSync(path.join(workspace, 'project', 'compositions'), { recursive: true, force: true });
    expect((await mod.createVideoStudioTool({
      userId: UID, cid: 'cid-unbound-parent', turnId: 'turn-unbound-b',
      agentId: VIDEO_STUDIO_AGENT_ID, agentName: 'VideoStudio',
      userMessage: approvalSubmission('gate_b_decision', 'approve'),
    }).execute({ op: 'production.approve_plan', plan_path: 'project/plan.json' }, ctx)).isError).toBe(false);

    const qa = parseResult(String((await mod.createVideoStudioTool({
      userId: UID, cid: 'cid-unbound', turnId: 'turn-unbound-qa',
      agentId: VIDEO_STUDIO_AGENT_ID, agentName: 'VideoStudio',
      userMessage: '<msg from="user">继续</msg>',
    }).execute({ op: 'production.segment_qa', phase: 'lint', plan_path: 'project/plan.json' }, ctx)).content));

    expect(qa.unknown_segment_ids).toEqual(['intro']);
    expect(qa.unbound_segments).toEqual([{
      segment_id: 'intro',
      composition_dir: `${path.posix.join(workspace.split(path.sep).join('/'), 'project', 'compositions', 'intro')}`,
    }]);
    // The instruction names the one operation that creates and derives, and
    // forbids the hand-authoring that produced the ownership rejection.
    expect(String(qa.message)).toContain('composition.approve_plan');
    expect(String(qa.message)).toContain('Do not create the directory or author the manifest by hand');
    // The path it names is the one the operation actually accepts.
    const derived = await mod.createVideoStudioTool({
      userId: UID, cid: 'cid-unbound', turnId: 'turn-unbound-derive',
      agentId: VIDEO_STUDIO_AGENT_ID, agentName: 'VideoStudio',
      userMessage: '<msg from="user">继续</msg>',
    }).execute({
      op: 'composition.approve_plan',
      composition_dir: (qa.unbound_segments as Array<{ composition_dir: string }>)[0].composition_dir,
      plan_path: 'project/plan.json',
      segment_id: 'intro',
    }, ctx);
    expect(derived.isError, String(derived.content)).toBe(false);
  });

  it('routes an underived AUTO child to inheritance instead of hand-authoring', async () => {
    // The 2026-08-08 first failure chain, 20 failed calls across four rounds:
    // (1) the bare "composition_dir is not a directory" -> the model ran mkdir;
    // (2) prepare -> "Restore the canonical plan manifest" -> the model
    //     hand-wrote five manifests, signing a narration voice as one does;
    // (3) prepare -> "approval required" (the right answer, a round late);
    // (4) approve_plan -> E_PARENT_COMPOSITION_AUDIO_OWNERSHIP x5 for the
    //     manifests written in round 2.
    // The host held the plan_path + segment_id from the FIRST call. Both
    // wrong messages now point at the one real actor: composition.approve_plan
    // derives the manifest, and creates the directory itself.
    writeAutoParentPlan();
    const mod = await import('../../../../src/main/model/core-agent/video-studio-tool');
    const ctx = { workingDir: workspace, state: {} } as any;
    const child = path.join(workspace, 'project', 'compositions', 'intro');
    fs.rmSync(child, { recursive: true, force: true });

    expect((await mod.createVideoStudioTool({
      userId: UID, cid: 'cid-route-parent', turnId: 'turn-route-b',
      agentId: VIDEO_STUDIO_AGENT_ID, agentName: 'VideoStudio',
      userMessage: approvalSubmission('gate_b_decision', 'approve'),
    }).execute({ op: 'production.approve_plan', plan_path: 'project/plan.json' }, ctx)).isError).toBe(false);

    const childTool = () => mod.createVideoStudioTool({
      userId: UID, cid: 'cid-route-child', turnId: 'turn-route-child',
      agentId: VIDEO_STUDIO_AGENT_ID, agentName: 'VideoStudio',
      userMessage: '<msg from="user">later turn</msg>',
    });
    const binding = {
      composition_dir: 'project/compositions/intro',
      plan_path: 'project/plan.json',
      segment_id: 'intro',
    };

    // Round 1's ritual, gone: prepare against a directory that does not exist
    // names the real next step instead of demanding mkdir.
    const beforeDerive = parseResult(String((await childTool().execute({
      op: 'composition.prepare', ...binding,
    }, ctx)).content));
    expect(beforeDerive.errorCode).toBe('E_PARENT_SEGMENT_NOT_DERIVED');
    expect(beforeDerive.message).toContain('composition.approve_plan');
    expect(beforeDerive.message).toContain('Do not create the directory or author the manifest by hand');
    expect(fs.existsSync(child)).toBe(false);

    // Round 2's trap, gone: with the directory present but the manifest not
    // yet derived, the message routes to inheritance, never to "restore".
    fs.mkdirSync(child, { recursive: true });
    const beforeManifest = parseResult(String((await childTool().execute({
      op: 'composition.prepare', ...binding,
    }, ctx)).content));
    expect(beforeManifest.errorCode).toBe('E_GATE_B_APPROVAL_REQUIRED');
    expect(beforeManifest.message).toContain('not yours to write');
    expect(beforeManifest.message).toContain('composition.approve_plan');
    expect(beforeManifest.message).not.toContain('Restore the canonical plan manifest');

    // approve_plan itself creates the directory it derives into.
    fs.rmSync(child, { recursive: true, force: true });
    const inherited = await childTool().execute({ op: 'composition.approve_plan', ...binding }, ctx);
    expect(inherited.isError, String(inherited.content)).toBe(false);
    expect(fs.existsSync(path.join(child, 'composition-manifest.json'))).toBe(true);

    // A standalone composition (no parent binding) keeps the plain answer:
    // nothing here may invent directories or reroute to inheritance.
    const stray = await mod.createVideoStudioTool({
      userId: UID, cid: 'cid-route-stray', turnId: 'turn-route-stray',
      agentId: VIDEO_STUDIO_AGENT_ID, agentName: 'VideoStudio',
      userMessage: '<msg from="user">later</msg>',
    }).execute({ op: 'composition.prepare', composition_dir: 'project/compositions/nowhere' }, ctx);
    expect(parseResult(stray.content)).toMatchObject({ ok: false, errorCode: 'E_COMPOSITION_DIR_NOT_FOUND' });
    // Not rerouted to inheritance — there is no parent to inherit from — and
    // nothing was invented on disk to make the call succeed.
    expect(String(stray.content)).not.toContain('composition.approve_plan');
    expect(fs.existsSync(path.join(workspace, 'project', 'compositions', 'nowhere'))).toBe(false);
  });

  it('budgets every narration line before signing the EDL, in one reply', async () => {
    // 2026-08-08 evening: all four narrated lines of an approved plan were
    // over budget (5/5.8/8/5.2s windows), and each surfaced as its own
    // E_TTS_TEXT_TOO_LONG at the paid gate mid-assembly — four round trips
    // against a script the user had already approved. The same estimator and
    // tolerance run at Gate B now, free, and name every line at once.
    writeAutoParentPlan();
    // The suite's default estimator stub returns a flat 5s; this case needs
    // the real property under test — long text estimates long — so it uses a
    // deterministic per-character rate (the real estimator's zh rate).
    ttsMock.estimateNarrationDuration.mockImplementation((text: string) => ({
      estimatedSec: [...text].length / 4,
      unit: 'characters',
      units: [...text].length,
      unitsPerSec: 4,
    }));
    const mod = await import('../../../../src/main/model/core-agent/video-studio-tool');
    const ctx = { workingDir: workspace, state: {} } as any;
    const planPath = path.join(workspace, 'project', 'plan.json');
    const plan = JSON.parse(fs.readFileSync(planPath, 'utf8'));
    plan.tracks = {
      narration: {
        synthesis: {
          route_ref: 'managed:orkas-voice',
          voice_ref: 'managed:orkas-voice:voice:vivi',
          display_name: 'vivi 2.0',
          language: 'zh-CN',
          speed: 1,
        },
        segments: [
          { text: '这一句的台词写得实在是太长太长，五秒钟根本读不完这么多字。', start_sec: 0, target_sec: 5 },
          { text: '短句可以。', start_sec: 5, target_sec: 5 },
          { text: '这一句也明显超出了它自己那扇窗口的时长预算，需要压缩。', start_sec: 10, target_sec: 5 },
        ],
      },
    };
    fs.writeFileSync(planPath, JSON.stringify(plan, null, 2), 'utf8');

    const approve = () => mod.createVideoStudioTool({
      userId: UID, cid: 'cid-budget', turnId: 'turn-budget',
      agentId: VIDEO_STUDIO_AGENT_ID, agentName: 'VideoStudio',
      userMessage: approvalSubmission('gate_b_decision', 'approve'),
    }).execute({ op: 'production.approve_plan', plan_path: 'project/plan.json' }, ctx);

    const refused = parseResult(String((await approve()).content));
    expect(refused.errorCode).toBe('E_VIDEO_PRODUCTION_NARRATION_OVERBUDGET');
    const lines = refused.over_budget_lines as Array<Record<string, unknown>>;
    // Both over-budget lines in ONE reply — not one per paid-gate refusal —
    // and the fitting line is not named.
    expect(lines.map((line) => line.index)).toEqual([0, 2]);
    expect(refused.message).toContain('line 0');
    expect(refused.message).toContain('line 2');
    // Both counts and the delta: a model cannot measure a mixed CJK/Latin
    // line by eye, and on 2026-08-09 "shorten to N" alone had it undershoot
    // six lines twice in a row, each miss costing a full round.
    expect(lines[0]).toMatchObject({
      current_units: expect.any(Number),
      shorten_to_units: expect.any(Number),
      remove_units: expect.any(Number),
    });
    expect(Number(lines[0].current_units)).toBeGreaterThan(Number(lines[0].shorten_to_units));
    expect(Number(lines[0].remove_units))
      .toBe(Number(lines[0].current_units) - Number(lines[0].shorten_to_units));
    expect(refused.message).toMatch(/it has \d+ characters, cut about \d+ to reach/);
    expect(refused.message).toContain('No approval was recorded');
    expect(refused.billable_request_sent).toBe(false);
    // Nothing was signed.
    const control = await import('../../../../src/main/features/video_production_control');
    const statePath = control.videoProductionControlStatePath({ userId: UID, planPath });
    expect((await control.readVideoProductionControlState(statePath, planPath)).plan_approval)
      .toBeUndefined();

    // The repair the message asks for passes in the same turn: shortened
    // lines, windows retimed — the exact shape the fit-repair inheritance
    // covers after approval.
    plan.tracks.narration.segments = [
      { text: '一句话指挥团队。', start_sec: 0, target_sec: 5 },
      { text: '短句可以。', start_sec: 5, target_sec: 4.5 },
      { text: '压缩后的第三句。', start_sec: 9.5, target_sec: 5 },
    ];
    fs.writeFileSync(planPath, JSON.stringify(plan, null, 2), 'utf8');
    const budget = (await import('../../../../src/main/model/core-agent/video-studio-tool'))
      .edlNarrationBudgetIssues(plan);
    expect(budget).toEqual([]);
    // (Live approval of a narrated plan needs a resolvable managed voice,
    // which this environment does not have — validateEdlNarrationSelection
    // is the next gate in line and its own tests cover it. The budget gate
    // sitting in front of it is what this case pins.)
  });

  // COMPOSE reached Gate B with no rendered plan anywhere: the approval
  // refusal said "Show the plan below" and attached only a digest, and
  // composition.status reported hashes and drift flags. Every presentation fix
  // so far had landed on the AUTO/EDL path, which is why this kept coming
  // back. 2026-08-09: the agent asked for approval with "方案已准备好", the user
  // answered "方案展示一下", and it refused to show anything and asked for
  // approval again — the whole turn made no status call, because none of them
  // would have handed it the plan.
  it('hands over the composition plan itself, not just facts about it', async () => {
    const mod = await import('../../../../src/main/model/core-agent/video-studio-tool');
    const manifest = {
      schema_version: 2,
      composition: {
        id: 'physical-ai-explainer', width: 1920, height: 1080,
        duration: 30, target_duration: 30, fps: 30, language: 'zh-CN',
      },
      scenes: [
        {
          id: 'hook_physical_ai', start: 0, duration: 16,
          approved_copy: ['物理 AI，投 Momenta 还是小马智行？', '自动驾驶不是屏幕里的 AI'],
          narration_text: '物理 AI 里，投 Momenta 还是小马智行？自动驾驶不是屏幕里的 AI。',
        },
        {
          id: 'closing', start: 16, duration: 14,
          approved_copy: ['真实道路 / 安全责任 / 监管'],
          narration_text: '车上路后面对的是人、车、天气、安全责任和监管。',
        },
      ],
      audio: {
        owner: 'none',
        narration_intent: {
          route_ref: 'managed:orkas-voice', voice_ref: 'managed:orkas-voice:voice:v0',
          display_name: 'vivi 2.0', language: 'zh-CN', speed: 1,
        },
      },
    };
    const summary = mod.renderCompositionPlanSummary(manifest as any);

    // What the user has to judge: the canvas, every scene's window, the copy
    // on screen, and the words spoken over it.
    expect(summary).toContain('1920x1080');
    expect(summary).toContain('30fps');
    expect(summary).toContain('hook_physical_ai');
    expect(summary).toContain('0–16s');
    expect(summary).toContain('closing');
    expect(summary).toContain('16–30s');
    expect(summary).toContain('物理 AI，投 Momenta');
    expect(summary).toMatch(/narration: 物理 AI 里/);
    expect(summary).toContain('vivi 2.0');
    // The same window-vs-speech accounting the EDL summary carries.
    expect(summary).toMatch(/windows [\d.]+s · speech ~[\d.]+s · silence ~[\d.]+s/);

    // A composition with no narration says so rather than going silent.
    const silent = { ...manifest, audio: { owner: 'none' } };
    expect(mod.renderCompositionPlanSummary(silent as any)).toContain('Narration: none');
  });

  // The 2026-08-09 plan, verbatim. Windows were sized from the visual beats
  // and the copy was written separately; the plan validator only checks that
  // windows do not overlap, and the Gate B budget check only refuses copy too
  // LONG for its window. So 54.2s of windows were signed for copy that speaks
  // in 33.5s, the 20s of slack surfaced at assembly, and it was filled by
  // slowing the narration audio — which the user heard as wrong pacing and
  // spent three rounds correcting. A fill-ratio gate cannot catch this:
  // measured, legitimate short lines fill 0.28–0.41 of their windows while
  // these ran 0.59–0.78. The summary the user approves shows the numbers.
  it('shows how long the narration actually speaks against the windows it was given', async () => {
    const mod = await import('../../../../src/main/model/core-agent/video-studio-tool');
    const plan = {
      aspect: '16:9',
      total_target_sec: 60,
      language: 'zh-CN',
      delivery_promise: { type: 'hybrid' },
      segments: [],
      tracks: {
        narration: {
          synthesis: {
            route_ref: 'managed:orkas-voice',
            voice_ref: 'managed:orkas-voice:voice:v0',
            display_name: 'vivi 2.0',
            language: 'zh-CN',
            speed: 1,
          },
          segments: [
            { text: '复杂任务常被拆成搜索、写作、代码和文件。Orkas 补上断掉的协作。', start_sec: 5.8, target_sec: 9.2 },
            { text: '在 Orkas 里，Commander 协调专家 agents。你说目标，它拆解、分派、汇总。', start_sec: 15, target_sec: 11 },
            { text: '它适合多步骤交付：报告、代码、表格、文档、视频和自动化流程。', start_sec: 26, target_sec: 11 },
            { text: 'Orkas 本地优先、开源 MIT。可接官方模型，也可自带 Key。', start_sec: 37, target_sec: 10 },
            { text: 'Orkas 不是聊天框，而是把目标推进到交付的 AI 协作工作台。去 orkas.ai 看看。', start_sec: 47, target_sec: 13 },
          ],
        },
      },
      cost_estimate: { billable_generations: 0 },
    };
    const summary = mod.renderVideoProductionPlanSummary(plan as any);

    const totals = summary.match(/windows ([\d.]+)s · speech ~([\d.]+)s · silence ~([\d.]+)s/);
    expect(totals, summary).toBeTruthy();
    expect(Number(totals![1])).toBeCloseTo(54.2, 1);
    // The gap that had to be filled by something, stated before approval.
    expect(Number(totals![3])).toBeGreaterThan(15);
    // Every one of these lines is short of its window by more than a second,
    // so the reader can see which windows to retime.
    for (const index of [1, 2, 3, 4, 5]) {
      expect(summary, `line ${index}`).toMatch(new RegExp(`\\n\\s+${index}\\. [\\d.]+s window · ~[\\d.]+s speech`));
    }
  });

  it('hands the plan through status and corrects omitted decision evidence without another user gate', async () => {
    // 2026-08-08: the user approved a plan whose entire on-screen description
    // was "制作方案已准备好". The host holds the plan, so it renders and hands
    // over the text — at production.status for an unapproved plan, and on the
    // no-evidence approval branch.
    //
    // It does NOT refuse an approval that lacks a recorded hand-over. That
    // gate shipped and was withdrawn the same day: presentation is not
    // observable from inside a tool call, and in two live runs both models
    // composed a complete plan themselves and called approve_plan only after
    // the user replied — so both were refused and both cost a confirmation
    // for doing it right. Two false positives, no true positive, against the
    // metric this gate class exists to protect.
    writeAutoParentPlan();
    const mod = await import('../../../../src/main/model/core-agent/video-studio-tool');
    const control = await import('../../../../src/main/features/video_production_control');
    const ctx = { workingDir: workspace, state: {} } as any;
    const planPath = path.join(workspace, 'project', 'plan.json');
    const statePath = control.videoProductionControlStatePath({ userId: UID, planPath });

    // The renderer carries the full information set — the timeline with its
    // copy, narration voice and line count, cost.
    const narrated = JSON.parse(fs.readFileSync(writeAutoParentPlan({ narration: true }), 'utf8'));
    const summary = mod.renderVideoProductionPlanSummary(narrated);
    expect(summary).toContain('Timeline:');
    expect(summary).toContain('Approved intro');
    expect(summary).toContain('Narration: voice=vivi 2.0 (managed:orkas-voice) · language=zh-CN · speed=1, 1 line(s)');
    // How long the copy actually speaks, next to the window it was given.
    // Nothing measured the two against each other while the plan was written —
    // the plan validator only checks that windows do not overlap — so on
    // 2026-08-09 a signed plan handed 54.2s of windows to copy that speaks in
    // 33.5s, and the slack surfaced at assembly as slowed-down narration the
    // user heard as wrong pacing. This summary is what the user approves.
    expect(summary).toMatch(/windows [\d.]+s · speech ~[\d.]+s · silence ~[\d.]+s/);
    expect(summary).toMatch(/Cost: 0 billable/);
    writeAutoParentPlan();

    // status hands it over for an unapproved plan and records the turn.
    const status = parseResult(String((await mod.createVideoStudioTool({
      userId: UID, cid: 'cid-present', turnId: 'turn-status',
      agentId: VIDEO_STUDIO_AGENT_ID, agentName: 'VideoStudio',
      userMessage: '<msg from="user">继续</msg>',
    }).execute({ op: 'production.status', plan_path: 'project/plan.json' }, ctx)).content));
    expect(String(status.plan_summary || '')).toContain('Approved intro');

    // An approval in the very next turn goes straight through — one
    // presentation turn, one approval turn, no third.
    const approve = (turnId: string) => mod.createVideoStudioTool({
      userId: UID, cid: 'cid-present', turnId,
      agentId: VIDEO_STUDIO_AGENT_ID, agentName: 'VideoStudio',
      userMessage: approvalSubmission('gate_b_decision', 'approve'),
    }).execute({ op: 'production.approve_plan', plan_path: 'project/plan.json' }, ctx);
    expect((await approve('turn-approve')).isError).toBe(false);
    // An approved plan's status stops re-offering the presentation.
    const after = parseResult(String((await mod.createVideoStudioTool({
      userId: UID, cid: 'cid-present', turnId: 'turn-status-2',
      agentId: VIDEO_STUDIO_AGENT_ID, agentName: 'VideoStudio',
      userMessage: '<msg from="user">继续</msg>',
    }).execute({ op: 'production.status', plan_path: 'project/plan.json' }, ctx)).content));
    expect(after.plan_summary).toBeUndefined();

    // A model that never asked the host for anything still approves in one
    // turn — the withdrawn gate is what made this cost two.
    const fresh = JSON.parse(fs.readFileSync(planPath, 'utf8'));
    fresh.segments[0].spec.composition_plan.scenes[0].approved_copy = ['Never asked the host'];
    fs.writeFileSync(planPath, JSON.stringify(fresh, null, 2), 'utf8');
    expect((await approve('turn-approve-unasked')).isError).toBe(false);

    // Omitting the model's semantic evidence is an Agent input defect, not a
    // second user decision. The first call stays silent and recoverable; the
    // corrected call consumes the same real user reply in the same turn.
    const noEvidencePlan = JSON.parse(fs.readFileSync(planPath, 'utf8'));
    noEvidencePlan.segments[0].spec.composition_plan.scenes[0].approved_copy = ['Yet another copy'];
    fs.writeFileSync(planPath, JSON.stringify(noEvidencePlan, null, 2), 'utf8');
    const semanticApprovalTool = mod.createVideoStudioTool({
      userId: UID, cid: 'cid-present', turnId: 'turn-no-evidence',
      agentId: VIDEO_STUDIO_AGENT_ID, agentName: 'VideoStudio',
      userMessage: '<msg from="user">就按这个方案制作</msg>',
    });
    const omitted = parseResult(String((await semanticApprovalTool.execute({
      op: 'production.approve_plan',
      plan_path: 'project/plan.json',
    }, ctx)).content));
    expect(omitted).toMatchObject({
      errorCode: 'E_DECISION_EVIDENCE_REQUIRED',
      outcome: 'continue',
      presentation_required: false,
      requires_user_decision: false,
      user_reconfirmation_required: false,
      next_step_owner: 'agent',
      same_turn_continuation_required: true,
      next_action: 'classify_current_reply_then_retry_with_evidence_or_continue_without_gate',
    });
    expect(omitted.plan_summary).toBeUndefined();
    const corrected = await semanticApprovalTool.execute({
      op: 'production.approve_plan',
      plan_path: 'project/plan.json',
      decision_evidence: decisionEvidence('plan', 'approve', '就按这个方案制作'),
    }, ctx);
    expect(corrected.isError, corrected.content).toBe(false);
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

  it('derives an AUTO child\'s plan artifacts from the signed parent instead of grading the model on them', async () => {
    // 2026-08-07, 11:09 run: four compose children, three hand-authored plan
    // files each, and three rounds of E_GATE_B_ARTIFACTS_INCOMPLETE /
    // E_GATE_B_REQUIREMENTS_INCOMPLETE (target_duration_seconds,
    // video_language, audio_mode, caption_mode, music_mode, shots.missing)
    // before the values the signed parent already carried were typed
    // correctly — about ten minutes restating signed facts. The host held the
    // child's complete specification the whole time and used it only to
    // compare. Now it generates from the same specification.
    writeAutoParentPlan();
    const mod = await import('../../../../src/main/model/core-agent/video-studio-tool');
    const ctx = { workingDir: workspace, state: {} } as any;
    const child = path.join(workspace, 'project', 'compositions', 'intro');
    fs.rmSync(child, { recursive: true, force: true });
    fs.mkdirSync(child, { recursive: true });

    expect((await mod.createVideoStudioTool({
      userId: UID,
      cid: 'cid-derive-parent',
      turnId: 'turn-derive-gate-b',
      agentId: VIDEO_STUDIO_AGENT_ID,
      agentName: 'VideoStudio',
      userMessage: approvalSubmission('gate_b_decision', 'approve'),
    }).execute({ op: 'production.approve_plan', plan_path: 'project/plan.json' }, ctx)).isError).toBe(false);

    const inheritTool = mod.createVideoStudioTool({
      userId: UID,
      cid: 'cid-derive-child',
      turnId: 'turn-derive-child',
      agentId: VIDEO_STUDIO_AGENT_ID,
      agentName: 'VideoStudio',
      userMessage: '<msg from="user">unrelated later turn</msg>',
    });
    const inheritInput = {
      op: 'composition.approve_plan',
      composition_dir: 'project/compositions/intro',
      plan_path: 'project/plan.json',
      segment_id: 'intro',
    };
    // The model authored NOTHING here: no script, no manifest.
    const inherited = await inheritTool.execute(inheritInput, ctx);
    expect(inherited.isError).toBe(false);
    expect(parseResult(String(inherited.content)).approval_inherited).toBe(true);

    // No shotlist: the manifest is the whole delivery contract now.
    expect(fs.existsSync(path.join(child, 'shotlist.json'))).toBe(false);
    const manifest = JSON.parse(fs.readFileSync(path.join(child, 'composition-manifest.json'), 'utf8'));
    expect(manifest.composition).toMatchObject({
      id: 'intro', width: 1920, height: 1080, duration: 5, target_duration: 5, language: 'en',
    });
    expect(manifest.audio).toEqual({ owner: 'assembler', tracks: [] });
    expect(manifest.scenes).toEqual([expect.objectContaining({
      id: 'intro',
      start: 0,
      duration: 5,
      approved_copy: ['Approved intro'],
      roles: ['title', 'visual'],
      source_shots: ['intro'],
    })]);
    // The plan is one file. A readable script is rendered into the approval
    // result, not written beside the composition — a file there would change
    // the composition signature and stale the preview.
    expect(fs.existsSync(path.join(child, 'script.md'))).toBe(false);
    expect(String(parseResult(String(inherited.content)).plan_script || ''))
      .toContain('Rendered from composition-manifest.json');

    // The model's own work survives derivation, and a conforming child is not
    // rewritten — re-deriving must not churn the artifact signature.
    const authored = JSON.parse(fs.readFileSync(path.join(child, 'composition-manifest.json'), 'utf8'));
    authored.art_direction = { aesthetic: { signature_device: 'ink-trail wipe' } };
    fs.writeFileSync(path.join(child, 'composition-manifest.json'), `${JSON.stringify(authored, null, 2)}\n`, 'utf8');


    expect((await inheritTool.execute(inheritInput, ctx)).isError).toBe(false);
    const reDerived = JSON.parse(fs.readFileSync(path.join(child, 'composition-manifest.json'), 'utf8'));
    expect(reDerived.art_direction).toEqual({ aesthetic: { signature_device: 'ink-trail wipe' } });


    // Authorization is not laundered: an unapproved parent derives nothing.
    const strayPlan = path.join(workspace, 'project', 'plan-unapproved.json');
    fs.writeFileSync(strayPlan, fs.readFileSync(path.join(workspace, 'project', 'plan.json'), 'utf8'), 'utf8');
    const strayChild = path.join(workspace, 'project', 'compositions', 'stray');
    fs.mkdirSync(strayChild, { recursive: true });
    const stray = await inheritTool.execute({
      op: 'composition.approve_plan',
      composition_dir: 'project/compositions/stray',
      plan_path: 'project/plan-unapproved.json',
      segment_id: 'intro',
    }, ctx);
    expect(stray.isError).toBe(true);
    expect(fs.readdirSync(strayChild)).toEqual([]);
  });

  it('tells a narrated AUTO child to name the assembler instead of signing a voice', async () => {
    // 2026-08-04, 14:54: five consecutive E_GATE_B_ARTIFACT_INVALID on the same
    // child. stage-assemble said "keep it silent, audio.owner:none", while the
    // manifest schema demands a signed narration_intent for any composition
    // that carries narration text and is not owned by the assembler. Nothing
    // the model wrote could satisfy both, and the way out it found — signing a
    // voice for a segment that never speaks — cost the 18:46 confirmation.
    const mod = await import('../../../../src/main/model/core-agent/video-studio-tool');
    const ctx = { workingDir: workspace, state: {} } as any;
    const planPath = writeAutoParentPlan();
    const plan = JSON.parse(fs.readFileSync(planPath, 'utf8'));
    plan.segments[0].spec.composition_plan.scenes[0].narration_text = 'One approved line.';
    fs.writeFileSync(planPath, JSON.stringify(plan, null, 2), 'utf8');

    const child = writeAutoChildComposition();
    const manifestPath = path.join(child, 'composition-manifest.json');
    fs.writeFileSync(path.join(child, 'script.md'), '# Approved intro\n\nOne approved line.', 'utf8');
    const shotlist = JSON.parse(fs.readFileSync(path.join(child, 'shotlist.json'), 'utf8'));
    shotlist.audio_mode = 'narration';
    shotlist.shots[0].narration_text = 'One approved line.';
    fs.writeFileSync(path.join(child, 'shotlist.json'), JSON.stringify(shotlist), 'utf8');
    const writeChildAudio = (audio: Record<string, unknown>) => {
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      manifest.schema_version = 2;
      manifest.scenes[0].narration_text = 'One approved line.';
      manifest.audio = audio;
      fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');
    };

    await mod.createVideoStudioTool({
      userId: UID,
      cid: 'cid-auto-parent-silence',
      turnId: 'turn-auto-gate-b-silence',
      agentId: VIDEO_STUDIO_AGENT_ID,
      agentName: 'VideoStudio',
      userMessage: approvalSubmission('gate_b_decision', 'approve'),
    }).execute({ op: 'production.approve_plan', plan_path: 'project/plan.json' }, ctx);

    const inherit = () => mod.createVideoStudioTool({
      userId: UID,
      cid: 'cid-auto-child-silence',
      turnId: 'turn-auto-compose-silence',
      agentId: VIDEO_STUDIO_AGENT_ID,
      agentName: 'VideoStudio',
      userMessage: '<msg from="user">unrelated later turn</msg>',
    }).execute({
      op: 'composition.approve_plan',
      composition_dir: 'project/compositions/intro',
      plan_path: 'project/plan.json',
      segment_id: 'intro',
    }, ctx);

    // What stage-assemble used to prescribe. The rejection must name the fix
    // rather than send the model to speech.capabilities.
    writeChildAudio({ owner: 'none', tracks: [] });
    const asPrescribed = parseResult(String((await inherit()).content));
    expect(asPrescribed.errorCode).toBe('E_PARENT_COMPOSITION_AUDIO_OWNERSHIP');
    expect(asPrescribed.message).toContain('audio.owner:"assembler"');
    expect(asPrescribed.message).not.toContain('narration_intent selected from speech.capabilities');
    expect(asPrescribed.requires_user_decision).toBe(false);

    // The escape the model actually took: sign a voice so the schema passes.
    // It used to be accepted, and the parent then owned a second voice.
    writeChildAudio({
      owner: 'none',
      tracks: [],
      narration_intent: {
        route_ref: 'managed:orkas-voice',
        voice_ref: 'managed:orkas-voice:voice:test-vivi',
        display_name: 'Vivi',
        language: 'zh-CN',
        speed: 1,
      },
    });
    const signedVoice = parseResult(String((await inherit()).content));
    expect(signedVoice.errorCode).toBe('E_PARENT_COMPOSITION_AUDIO_OWNERSHIP');
    expect(signedVoice.message).toMatch(/never speaks must not sign one/);

    // A baked-in track is the defect the silence rule exists for: it would play
    // on top of the assembler's mix.
    writeChildAudio({
      owner: 'composition',
      tracks: [{ id: 'narration', kind: 'narration', src: 'assets/narration.mp3', start: 0, duration: 5, volume: 1 }],
    });
    const bakedIn = parseResult(String((await inherit()).content));
    expect(bakedIn.errorCode).toBe('E_PARENT_COMPOSITION_AUDIO_OWNERSHIP');
    expect(bakedIn.message).toMatch(/plays twice/);

    // The correct declaration inherits the parent Gate B with no child gate.
    writeChildAudio({ owner: 'assembler', tracks: [] });
    const correct = await inherit();
    expect(correct.isError, String(correct.content)).toBe(false);
    expect(parseResult(String(correct.content))).toMatchObject({
      approval_inherited: true,
      parent_segment_id: 'intro',
    });
    expect(ttsMock.generateSpeech).not.toHaveBeenCalled();

    // 2026-08-05 18:46: the same manifest that approve_plan accepts here was
    // simultaneously rejected by the readiness check, which read the scene's
    // narration text as "this composition needs a voice" and demanded the very
    // `audio.narration_intent` approve_plan forbids. The child could satisfy
    // neither, and the run stopped with nothing the model could repair. Every
    // narration path has to read ownership the same way.
    const doctor = parseResult(String((await mod.createVideoStudioTool({
      userId: UID,
      cid: 'cid-child-silence',
      turnId: 'turn-child-doctor',
      agentId: VIDEO_STUDIO_AGENT_ID,
      agentName: 'VideoStudio',
      userMessage: '<msg from="user">go on</msg>',
    }).execute({ op: 'composition.doctor', composition_dir: 'project/compositions/intro' }, ctx)).content));
    expect(doctor.narration_required).toBe(false);
    expect(JSON.stringify(doctor)).not.toContain('E_TTS_NARRATION_INTENT_REQUIRED');
    expect(doctor.checks?.tts_provider?.required).toBe(false);
    expect(doctor.checks?.tts_selection).toMatchObject({ ok: true, required: false });
  });

  /** A plan whose opening shot is a cut and whose remaining shots are composed. */
  function writeMixedSourcePlan(input: {
    cutProducedPath: string;
    composeIds: string[];
    composeProducedPath?: string;
  }): string {
    const planPath = path.join(workspace, 'project', 'plan.json');
    fs.writeFileSync(planPath, JSON.stringify({
      aspect: '16:9',
      total_target_sec: 5 * (input.composeIds.length + 1),
      language: 'en',
      delivery_promise: { type: 'compose_led', source_required: false, motion_min_ratio: 0 },
      segments: [
        {
          id: 'cut',
          order: 1,
          role: 'hook',
          layer: 'primary',
          source: 'edit',
          target_sec: 5,
          spec: { input_id: 'source_video', in_sec: 0, out_sec: 5 },
          produced_path: input.cutProducedPath,
          status: 'done',
        },
        ...input.composeIds.map((id, index) => ({
          id,
          order: index + 2,
          role: 'body',
          layer: 'primary',
          source: 'compose',
          target_sec: 5,
          spec: {
            kind: 'title-card',
            composition_plan: {
              scenes: [{ id, approved_copy: [`Approved ${id}`], narration_text: '', roles: ['title', 'visual'] }],
            },
          },
          ...(input.composeProducedPath ? { produced_path: input.composeProducedPath, status: 'done' } : {}),
        })),
      ],
      cost_estimate: { billable_generations: 0 },
    }, null, 2), 'utf8');
    return planPath;
  }

  function writeCutFile(relPath: string, bytes: string): string {
    const abs = path.join(workspace, relPath);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, bytes);
    return abs;
  }

  it('captures a produced media segment by its own file', async () => {
    // 2026-08-05: a nine-segment plan whose opening shot was `source:"edit"`.
    // Segment facts were read only from child composition state, so the cut was
    // permanently "uncaptured", `renderable` never became true, and the finished
    // video could not be assembled at all. A cut is already pixels — it needs no
    // snapshot to be reviewable.
    const mod = await import('../../../../src/main/model/core-agent/video-studio-tool');
    const stateMod = await import('../../../../src/main/features/video_studio_state');
    const ctx = { workingDir: workspace, state: {} } as any;
    const composeIds = ['body', 'outro'];
    const cutPath = writeCutFile(path.join('project', 'cuts', 'cut.mp4'), 'first cut bytes');
    writeMixedSourcePlan({ cutProducedPath: cutPath, composeIds });

    const childDirs = new Map<string, string>();
    for (const id of composeIds) {
      const dir = path.join(workspace, 'project', 'compositions', id);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'script.md'), `# Approved ${id}`, 'utf8');
      fs.writeFileSync(path.join(dir, 'shotlist.json'), JSON.stringify({
        target_duration_seconds: 5,
        video_language: 'en',
        audio_mode: 'visual-only',
        caption_mode: 'none',
        music_mode: 'none',
        shots: [{ id }],
      }), 'utf8');
      fs.writeFileSync(path.join(dir, 'composition-manifest.json'), JSON.stringify({
        schema_version: 1,
        composition: { id, width: 1920, height: 1080, duration: 5, target_duration: 5, fps: 30, language: 'en' },
        scenes: [{
          id,
          start: 0,
          duration: 5,
          approved_copy: [`Approved ${id}`],
          narration_text: '',
          narration_refs: [],
          source_shots: [id],
          roles: ['title', 'visual'],
        }],
        audio: { owner: 'none', tracks: [] },
      }, null, 2), 'utf8');
      fs.writeFileSync(path.join(dir, 'index.html'), [
        '<!doctype html><html><body>',
        `<main data-composition-id="${id}" data-width="1920" data-height="1080" data-duration="5">`,
        `<section class="clip" data-scene-id="${id}" data-start="0" data-duration="5">`,
        `<h1 data-role="title">Approved ${id}</h1>`,
        '</section></main></body></html>',
      ].join('\n'), 'utf8');
      childDirs.set(id, dir);
    }

    await mod.createVideoStudioTool({
      userId: UID,
      cid: 'cid-mixed-parent',
      turnId: 'turn-mixed-gate-b',
      agentId: VIDEO_STUDIO_AGENT_ID,
      agentName: 'VideoStudio',
      userMessage: approvalSubmission('gate_b_decision', 'approve'),
    }).execute({ op: 'production.approve_plan', plan_path: 'project/plan.json' }, ctx);

    for (const id of composeIds) {
      const inherited = await mod.createVideoStudioTool({
        userId: UID,
        cid: `cid-mixed-${id}`,
        turnId: `turn-mixed-${id}`,
        agentId: VIDEO_STUDIO_AGENT_ID,
        agentName: 'VideoStudio',
        userMessage: '<msg from="user">later turn</msg>',
      }).execute({
        op: 'composition.approve_plan',
        composition_dir: `project/compositions/${id}`,
        plan_path: 'project/plan.json',
        segment_id: id,
      }, ctx);
      expect(inherited.isError, String(inherited.content)).toBe(false);
    }

    const statusTool = mod.createVideoStudioTool({
      userId: UID,
      cid: 'cid-mixed-parent',
      turnId: 'turn-mixed-review',
      agentId: VIDEO_STUDIO_AGENT_ID,
      agentName: 'VideoStudio',
      userMessage: '<msg from="user">show me the video</msg>',
    });

    // The cut is reviewable the moment its file exists; the compositions are
    // not reviewable until they are rendered.
    const beforeCapture = parseResult((await statusTool.execute({
      op: 'production.status',
      plan_path: 'project/plan.json',
    }, ctx)).content);
    expect(beforeCapture.production_review.uncaptured_segment_ids).toEqual(composeIds);

    for (const id of composeIds) {
      const dir = childDirs.get(id)!;
      const childStatePath = mod.videoStudioProductionStatePath(
        { userId: UID, cid: `cid-mixed-${id}` },
        dir,
      );
      const visualSignature = await mod.videoStudioVisualCompositionSignature(dir);
      await stateMod.updateVideoProductionState(childStatePath, dir, (next) => {
        next.preview = {
          signature: visualSignature,
          visual_signature: visualSignature,
          revision_id: `rev-${id}`,
          turn_id: `turn-mixed-${id}`,
          created_at: new Date().toISOString(),
          status: 'ready',
          validation_version: 5,
          frame_paths: [`/tmp/${id}/01-first-frame.png`],
        };
      });
    }

    const shown = parseResult((await statusTool.execute({
      op: 'production.status',
      plan_path: 'project/plan.json',
    }, ctx)).content);
    // The whole point: a production containing a cut reaches assembly exactly
    // like an all-composed one, with nothing to ask the user about.
    expect(shown.production_review.uncaptured_segment_ids).toEqual([]);
    expect(shown.production_review.renderable).toBe(true);

    const signatureOf = (review: any, id: string) => review.segments
      .find((segment: any) => segment.segment_id === id).visual_signature;
    const cutSignatureBefore = signatureOf(shown.production_review, 'cut');

    // Re-trimming tracks through to the segment's identity — its bytes are its
    // signature. It stays captured, though: a cut is already frames, so unlike
    // an edited composition there is no QA phase waiting to be re-run on it,
    // and the production is still assemblable from the new file.
    fs.writeFileSync(cutPath, 'second cut bytes, a different length');
    const afterRetrim = parseResult((await statusTool.execute({
      op: 'production.status',
      plan_path: 'project/plan.json',
    }, ctx)).content);
    expect(signatureOf(afterRetrim.production_review, 'cut')).not.toBe(cutSignatureBefore);
    expect(signatureOf(afterRetrim.production_review, composeIds[0]))
      .toBe(signatureOf(shown.production_review, composeIds[0]));
    expect(afterRetrim.production_review.uncaptured_segment_ids).toEqual([]);
    expect(afterRetrim.production_review.renderable).toBe(true);

    // Editing a COMPOSITION segment is the case that does need work again: its
    // snapshot no longer matches its bytes, so it alone drops out.
    const bodyHtml = path.join(childDirs.get(composeIds[0])!, 'index.html');
    fs.writeFileSync(bodyHtml, fs.readFileSync(bodyHtml, 'utf8').replace('Approved', 'Reworked'), 'utf8');
    const afterEdit = parseResult((await statusTool.execute({
      op: 'production.status',
      plan_path: 'project/plan.json',
    }, ctx)).content);
    expect(afterEdit.production_review.uncaptured_segment_ids).toEqual([composeIds[0]]);
    expect(afterEdit.production_review.renderable).toBe(false);

    // A media segment has no HTML to check, so naming one for QA is not a
    // missing-composition error that would send the model to re-produce it.
    const qa = parseResult((await statusTool.execute({
      op: 'production.segment_qa',
      plan_path: 'project/plan.json',
      phase: 'snapshot',
      segment_ids: ['cut'],
    }, ctx)).content);
    expect(qa.media_backed_segment_ids).toEqual(['cut']);
    expect(qa.unknown_segment_ids).toBeUndefined();
    expect(qa.message).toMatch(/produced media, not compositions/);
  });

  it('carries a snapshot failure blockers, not just their count', async () => {
    // 2026-08-10 AUTO run: five of six segments came back
    // E_PREVIEW_DESIGN_QA_BLOCKED with error_count 4/4/14/4/6 and NOT ONE
    // issue. The row read only `findings`, which the snapshot phase does not
    // produce — its blockers ride on `inspect_disposition`. The model spent a
    // round reading three of the five 35–55KB findings files (partially, ~9K
    // of 35K each) and then grepped the directory for "code", an 8,915-token
    // result that spilled to disk. All of it to recover a list this row held.
    const mod = await import('../../../../src/main/model/core-agent/video-studio-tool');
    const videoStudio = await import('../../../../src/main/features/video_studio');
    const ctx = { workingDir: workspace, state: {} } as any;
    const cutPath = writeCutFile(path.join('project', 'cuts', 'overview.mp4'), 'cut-bytes');
    writeMixedSourcePlan({ cutProducedPath: cutPath, composeIds: ['body'] });
    const childDir = path.join(workspace, 'project', 'compositions', 'body');
    fs.rmSync(childDir, { recursive: true, force: true });
    fs.mkdirSync(childDir, { recursive: true });

    const blockingIssues = [
      { code: 'TEXT_BOX_OVERFLOW', severity: 'error', message: 'headline overflows its box', scene: 's1' },
      { code: 'LOW_CONTRAST', severity: 'error', message: 'caption fails contrast on the blue field', scene: 's1' },
      { code: 'SAFE_AREA_VIOLATION', severity: 'error', message: 'logo sits outside the safe area', scene: 's2' },
    ];
    vi.spyOn(videoStudio, 'snapshotComposition').mockImplementation(async (options: any) => {
      const dir = path.join(options.compositionDirAbs, 'preview');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'contact-sheet.png'), PNG_2X2);
      // The real shape: no `findings` key anywhere, blockers under
      // inspect_disposition, and a count that exceeds the bounded list.
      return {
        ok: false,
        op: 'composition.snapshot',
        errorCode: 'E_PREVIEW_DESIGN_QA_BLOCKED',
        message: 'Preview frames were captured, but high-confidence visual layout defects still require repair.',
        status: 'review_required',
        stage: 'preview',
        blocking_error_count: 5,
        preview_qa: { ok: false, error_count: 5, issues: blockingIssues },
        inspect_disposition: {
          blocking_error_count: 5,
          advisory_count: 0,
          blocking_issues: blockingIssues,
          advisory_issues: [],
        },
        preflight: { status: 'passed', blocking_error_count: 0 },
        findings_path: path.join(childDir, 'qa', 'segment-qa-snapshot-findings.json'),
        preview_ready: false,
        preview_captured: true,
      } as any;
    });

    await mod.createVideoStudioTool({
      userId: UID,
      cid: 'cid-snapshot-blockers-parent',
      turnId: 'turn-snapshot-blockers-gate-b',
      agentId: VIDEO_STUDIO_AGENT_ID,
      agentName: 'VideoStudio',
      userMessage: approvalSubmission('gate_b_decision', 'approve'),
    }).execute({ op: 'production.approve_plan', plan_path: 'project/plan.json' }, ctx);
    const tool = mod.createVideoStudioTool({
      userId: UID,
      cid: 'cid-snapshot-blockers-child',
      turnId: 'turn-snapshot-blockers-child',
      agentId: VIDEO_STUDIO_AGENT_ID,
      agentName: 'VideoStudio',
      userMessage: '<msg from="user">later turn</msg>',
    });
    expect((await tool.execute({
      op: 'composition.approve_plan',
      composition_dir: 'project/compositions/body',
      plan_path: 'project/plan.json',
      segment_id: 'body',
    }, ctx)).isError).toBe(false);
    fs.writeFileSync(path.join(childDir, 'index.html'), '<html></html>', 'utf8');

    const qa = parseResult((await tool.execute({
      op: 'production.segment_qa',
      plan_path: 'project/plan.json',
      phase: 'snapshot',
      segment_ids: ['body'],
    }, ctx)).content);
    const segment = (qa.segments as Array<Record<string, any>>)
      .find((entry) => entry.segment_id === 'body');

    expect(segment?.ok).toBe(false);
    expect(segment?.error_code).toBe('E_PREVIEW_DESIGN_QA_BLOCKED');
    expect(segment?.error_count).toBe(5);
    expect(segment!.blocking_issues.map((issue: any) => issue.code)).toEqual([
      'TEXT_BOX_OVERFLOW', 'LOW_CONTRAST', 'SAFE_AREA_VIOLATION',
    ]);
    for (const issue of segment!.blocking_issues) expect(issue.severity).toBe('error');
    // The list is bounded, so a segment holding more blockers than it ships
    // says how many are missing instead of reading as the complete set.
    expect(segment?.blocking_issues_omitted).toBe(2);
  });

  it('offers the delivery check on an assembled production and runs it on the named file', async () => {
    // 2026-08-10: the assembly turn wrote its own ffmpeg instead of the
    // stage-edit ops. That fallback is legitimate and stays open, but it took
    // every check those ops carry with it. This pins the wiring — the offer,
    // the refusal, and that a named file reaches the verifier; the judgement
    // itself is unit-tested against real measurements in
    // test/main/features/video_studio_delivery.test.ts.
    const mod = await import('../../../../src/main/model/core-agent/video-studio-tool');
    const ctx = { workingDir: workspace, state: {} } as any;
    const cutPath = writeCutFile(path.join('project', 'cuts', 'overview.mp4'), 'cut-bytes');
    writeMixedSourcePlan({ cutProducedPath: cutPath, composeIds: ['body'], composeProducedPath: cutPath });
    const tool = mod.createVideoStudioTool({
      userId: UID,
      cid: 'cid-delivery',
      turnId: 'turn-delivery',
      agentId: VIDEO_STUDIO_AGENT_ID,
      agentName: 'VideoStudio',
      userMessage: '<msg from="user">done?</msg>',
    });

    // Every segment has produced bytes, so the production has something to
    // deliver and the check announces itself instead of waiting to be guessed.
    const offered = parseResult((await tool.execute({
      op: 'production.status',
      plan_path: 'project/plan.json',
    }, ctx)).content);
    expect(offered.delivery_check.status).toBe('not_run');
    expect(offered.delivery_check.reason).toContain('delivered_video_path');

    // A path that names nothing is a refusal, not a silent skip.
    const missing = await tool.execute({
      op: 'production.status',
      plan_path: 'project/plan.json',
      delivered_video_path: 'final/never-made.mp4',
    }, ctx);
    expect(missing.isError).toBe(true);
    expect(String(missing.content)).toContain('E_INPUT_FILE_NOT_FOUND');
    expect(String(missing.content)).toContain('delivered_video_path');

    // A real path reaches the verifier. ffmpeg is stubbed in this file, so the
    // artifact cannot be probed — the check says so rather than passing it.
    const finalPath = path.join(workspace, 'project', 'final.mp4');
    fs.writeFileSync(finalPath, 'not really a video');
    const checked = parseResult((await tool.execute({
      op: 'production.status',
      plan_path: 'project/plan.json',
      delivered_video_path: 'final.mp4',
    }, ctx)).content);
    expect(checked.delivery_check.ok).toBe(false);
    expect(checked.delivery_check.video_path).toBe(finalPath);
    expect(checked.delivery_check.issues.length).toBeGreaterThan(0);
  });

  it('publishes one contact sheet for the whole production when the last segment is captured', async () => {
    // 2026-08-07: a five-segment production reached its keyframe preview as
    // four separate per-child contact sheets, and the opening segment — a cut
    // of the user's own footage, which has no snapshot — appeared in none of
    // them. The stop exists so the user can judge the whole video in one look;
    // only the host holds every segment's frames and their playback order.
    const mod = await import('../../../../src/main/model/core-agent/video-studio-tool');
    const videoStudio = await import('../../../../src/main/features/video_studio');
    const ctx = { workingDir: workspace, state: {} } as any;
    const cutPath = writeCutFile(path.join('project', 'cuts', 'overview.mp4'), 'cut-bytes');
    writeMixedSourcePlan({ cutProducedPath: cutPath, composeIds: ['body'] });
    const childDir = path.join(workspace, 'project', 'compositions', 'body');
    fs.rmSync(childDir, { recursive: true, force: true });
    fs.mkdirSync(childDir, { recursive: true });

    const sheetCalls: any[] = [];
    const sheetSpy = vi.spyOn(videoStudio, 'writeProductionContactSheet')
      .mockImplementation(async (input: any) => {
        sheetCalls.push(input);
        const out = path.join(input.outputDirAbs, 'contact-sheet.png');
        fs.mkdirSync(input.outputDirAbs, { recursive: true });
        fs.writeFileSync(out, PNG_2X2);
        return out;
      });
    const snapshotSpy = vi.spyOn(videoStudio, 'snapshotComposition')
      .mockImplementation(async (options: any) => {
        const dir = path.join(options.compositionDirAbs, 'preview');
        fs.mkdirSync(dir, { recursive: true });
        const frames = ['01-first-frame.png', '02-body-mid.png']
          .map((name) => path.join(dir, name));
        for (const frame of frames) fs.writeFileSync(frame, PNG_2X2);
        const sheet = path.join(dir, 'contact-sheet.png');
        fs.writeFileSync(sheet, PNG_2X2);
        return {
          ok: true,
          op: 'composition.snapshot',
          status: 'passed',
          stage: 'preview',
          blocking_error_count: 0,
          preview_ready: true,
          preview_qa: { ok: true, error_count: 0 },
          preflight: { status: 'passed', blocking_error_count: 0 },
          first_frame: frames[0],
          contact_sheet: sheet,
          frame_paths: frames,
        } as any;
      });

    await mod.createVideoStudioTool({
      userId: UID,
      cid: 'cid-overview-parent',
      turnId: 'turn-overview-gate-b',
      agentId: VIDEO_STUDIO_AGENT_ID,
      agentName: 'VideoStudio',
      userMessage: approvalSubmission('gate_b_decision', 'approve'),
    }).execute({ op: 'production.approve_plan', plan_path: 'project/plan.json' }, ctx);
    const tool = mod.createVideoStudioTool({
      userId: UID,
      cid: 'cid-overview-child',
      turnId: 'turn-overview-child',
      agentId: VIDEO_STUDIO_AGENT_ID,
      agentName: 'VideoStudio',
      userMessage: '<msg from="user">later turn</msg>',
    });
    expect((await tool.execute({
      op: 'composition.approve_plan',
      composition_dir: 'project/compositions/body',
      plan_path: 'project/plan.json',
      segment_id: 'body',
    }, ctx)).isError).toBe(false);
    fs.writeFileSync(path.join(childDir, 'index.html'), '<html></html>', 'utf8');

    const qaResult = await tool.execute({
      op: 'production.segment_qa',
      plan_path: 'project/plan.json',
      phase: 'snapshot',
      segment_ids: ['body'],
    }, ctx);
    // The batch has to give the capture somewhere to write. It did not, and
    // because this case replaces `snapshotComposition` — the function whose
    // first line rejects a missing destination — nothing noticed: in production
    // on 2026-08-08 every segment came back E_OUTPUT_REQUIRED and the model
    // fell back to running `composition.snapshot` by hand for each child, which
    // is the fan-out this batch exists to remove. Asserting the argument is
    // what a spy owes the contract it stands in for.
    expect(snapshotSpy.mock.calls.at(-1)?.[0]?.snapshotAbsPath)
      .toBe(path.join(childDir, 'preview', 'first-frame.png'));
    const qa = parseResult(qaResult.content);

    expect(qaResult.images).toHaveLength(1);
    expect(qa.production_review.uncaptured_segment_ids).toEqual([]);
    expect(String(qa.production_contact_sheet)).toMatch(/preview[\\/]contact-sheet\.png$/);
    expect(qa.visual_evidence).toMatchObject({
      attached: true,
      role: 'production_contact_sheet',
      path: qa.production_contact_sheet,
      policy: 'attached_only_after_all_segment_snapshot_qa_passed',
    });
    const productionSheetPixels = await sharp(fs.readFileSync(qa.production_contact_sheet))
      .ensureAlpha().raw().toBuffer();
    const attachedProductionPixels = await sharp(Buffer.from(qaResult.images![0].data, 'base64'))
      .ensureAlpha().raw().toBuffer();
    expect(attachedProductionPixels).toEqual(productionSheetPixels);
    expect(sheetCalls).toHaveLength(1);
    // Playback order, and the media segment rides on its own file so the
    // user's footage is in the overview rather than missing from it.
    expect(sheetCalls[0].segments.map((entry: any) => entry.segmentId)).toEqual(['cut', 'body']);
    expect(sheetCalls[0].segments[0].mediaPath).toBe(cutPath);

    // Re-running the phase once everything is captured has nothing to check —
    // the default scope IS the uncaptured set — and that early exit used to
    // skip the sheet entirely. The moment a production becomes ready is
    // exactly the moment this path is taken: on 2026-08-09 the host never
    // produced a production contact sheet and the model hand-built its own to
    // have something to show at the stop.
    const readyAgain = parseResult((await tool.execute({
      op: 'production.segment_qa',
      plan_path: 'project/plan.json',
      phase: 'snapshot',
    }, ctx)).content);
    expect(readyAgain.checked_segment_ids).toEqual([]);
    expect(readyAgain.next_action).toBe('open_production_preview_review');
    expect(String(readyAgain.production_contact_sheet)).toMatch(/preview[\\/]contact-sheet\.png$/);
    expect(sheetCalls).toHaveLength(2);
    expect(sheetCalls[1].segments.map((entry: any) => entry.segmentId)).toEqual(['cut', 'body']);

    // Negative control: an earlier phase with nothing to check composes no
    // sheet — only a ready snapshot does.
    const lintIdle = parseResult((await tool.execute({
      op: 'production.segment_qa',
      plan_path: 'project/plan.json',
      phase: 'lint',
    }, ctx)).content);
    expect(lintIdle.production_contact_sheet).toBeUndefined();
    expect(sheetCalls).toHaveLength(2);
    expect(sheetCalls[0].segments[1].framePaths).toHaveLength(2);

    // A phase that leaves anything uncaptured publishes no overview: a sheet
    // of a half-finished video would misrepresent what is ready to review.
    sheetCalls.length = 0;
    snapshotSpy.mockResolvedValue({
      ok: false,
      op: 'composition.snapshot',
      errorCode: 'E_PREVIEW_QA_BLOCKED',
      message: 'blocked',
      blocking_error_count: 1,
    } as any);
    fs.writeFileSync(path.join(childDir, 'index.html'), '<html><!-- changed --></html>', 'utf8');
    const blockedResult = await tool.execute({
      op: 'production.segment_qa',
      plan_path: 'project/plan.json',
      phase: 'snapshot',
      segment_ids: ['body'],
    }, ctx);
    const blocked = parseResult(blockedResult.content);
    expect(blockedResult.images).toBeUndefined();
    expect(blocked.production_contact_sheet).toBeUndefined();
    expect(sheetCalls).toHaveLength(0);

    sheetSpy.mockRestore();
    snapshotSpy.mockRestore();
  });

  it('hands back every blocking issue a failing segment has, not just the first', async () => {
    // 2026-08-07, 11:09 run: batched segment QA reported `error_count: 3` and
    // exactly ONE message — the first issue's — because `findings` arrives as
    // a serialized JSON blob and an Array.isArray test dropped it. The model
    // repaired that one issue, re-ran the phase across four segments (~2 min),
    // and met the second; three rounds, ~8 minutes, for a list the host had
    // complete on the first call.
    const mod = await import('../../../../src/main/model/core-agent/video-studio-tool');
    const videoStudio = await import('../../../../src/main/features/video_studio');
    const ctx = { workingDir: workspace, state: {} } as any;
    const cutPath = writeCutFile(path.join('project', 'cuts', 'issues.mp4'), 'cut-bytes');
    writeMixedSourcePlan({ cutProducedPath: cutPath, composeIds: ['body'] });
    const childDir = path.join(workspace, 'project', 'compositions', 'body');
    fs.rmSync(childDir, { recursive: true, force: true });
    fs.mkdirSync(childDir, { recursive: true });

    await mod.createVideoStudioTool({
      userId: UID,
      cid: 'cid-issues-parent',
      turnId: 'turn-issues-gate-b',
      agentId: VIDEO_STUDIO_AGENT_ID,
      agentName: 'VideoStudio',
      userMessage: approvalSubmission('gate_b_decision', 'approve'),
    }).execute({ op: 'production.approve_plan', plan_path: 'project/plan.json' }, ctx);
    const childTool = mod.createVideoStudioTool({
      userId: UID,
      cid: 'cid-issues-child',
      turnId: 'turn-issues-child',
      agentId: VIDEO_STUDIO_AGENT_ID,
      agentName: 'VideoStudio',
      userMessage: '<msg from="user">later turn</msg>',
    });
    expect((await childTool.execute({
      op: 'composition.approve_plan',
      composition_dir: 'project/compositions/body',
      plan_path: 'project/plan.json',
      segment_id: 'body',
    }, ctx)).isError).toBe(false);

    // An HTML body with no scaffold contract at all: several independent
    // blocking findings in one preflight.
    fs.writeFileSync(path.join(childDir, 'index.html'), '<html><body><p>tiny</p></body></html>', 'utf8');
    const qa = parseResult((await childTool.execute({
      op: 'production.segment_qa',
      plan_path: 'project/plan.json',
      phase: 'lint',
      segment_ids: ['body'],
    }, ctx)).content);

    const segment = (qa.segments as Array<Record<string, any>>).find((entry) => entry.segment_id === 'body');
    expect(segment?.ok).toBe(false);
    expect(segment?.error_count).toBeGreaterThan(1);
    // Every blocking issue travels with the failure, each with its code, so
    // one repair pass can address the whole list.
    expect(Array.isArray(segment?.blocking_issues)).toBe(true);
    expect(segment!.blocking_issues.length).toBe(segment!.error_count);
    for (const issue of segment!.blocking_issues) {
      expect(issue.code, JSON.stringify(issue)).toEqual(expect.any(String));
      // Compaction carries an advisory tail now; this row is the blocker
      // list, and an advisory entry here reads as something that must be
      // fixed before the segment can proceed.
      expect(issue.severity, JSON.stringify(issue)).toBe('error');
    }
    // `findings_path` is a promise that the complete evidence is readable
    // there. lint returned the path but never wrote the file: on 2026-08-07
    // the model read it twice, got E_NOT_FOUND both times, and — with only
    // the first issue in the summary — edited manifests blind for twelve
    // minutes. The path must name a real file whose issues match what the
    // result reported.
    const findingsPath = String(segment?.findings_path || '');
    expect(path.relative(childDir, findingsPath)).toBe(
      path.join('qa', 'segment-qa-lint-findings.json'),
    );
    expect(fs.existsSync(findingsPath)).toBe(true);
    const findingsDoc = JSON.parse(fs.readFileSync(findingsPath, 'utf8'));
    const fileErrorCodes = (findingsDoc.issues as Array<Record<string, any>>)
      .filter((issue) => issue.severity === 'error')
      .map((issue) => issue.code)
      .sort();
    expect(fileErrorCodes).toEqual(
      segment!.blocking_issues.map((issue: any) => issue.code).sort(),
    );

    // An identical retry with nothing touched is refused BEFORE the phase
    // runs. The repeated-failure breaker judges after execution — on
    // 2026-08-07 three such rounds each ran QA across four segments and were
    // only then rejected. A segment whose bytes did not move cannot return a
    // different verdict.
    const lintSpy = vi.spyOn(videoStudio, 'lintComposition');
    const retry = parseResult((await childTool.execute({
      op: 'production.segment_qa',
      plan_path: 'project/plan.json',
      phase: 'lint',
      segment_ids: ['body'],
    }, ctx)).content);
    expect(lintSpy).not.toHaveBeenCalled();
    const retrySegment = (retry.segments as Array<Record<string, any>>)
      .find((entry) => entry.segment_id === 'body');
    expect(retrySegment).toMatchObject({
      ok: false,
      error_code: 'E_LINT_RETRY_NO_CHANGE',
      same_input_retry_allowed: false,
    });

    // Touching the segment makes it run again: the guard keys on the bytes,
    // not on the call.
    fs.appendFileSync(path.join(childDir, 'index.html'), '\n<!-- repaired -->\n', 'utf8');
    await childTool.execute({
      op: 'production.segment_qa',
      plan_path: 'project/plan.json',
      phase: 'lint',
      segment_ids: ['body'],
    }, ctx);
    expect(lintSpy).toHaveBeenCalledTimes(1);
    lintSpy.mockRestore();
  });

  it('refuses to count media a review could not show', async () => {
    // Every one of these would book a confirmation for something the panel
    // cannot display. `captured` has to stay fail-closed in each.
    const mod = await import('../../../../src/main/model/core-agent/video-studio-tool');
    const ctx = { workingDir: workspace, state: {} } as any;
    const statusTool = mod.createVideoStudioTool({
      userId: UID,
      cid: 'cid-media-guard',
      turnId: 'turn-media-guard',
      agentId: VIDEO_STUDIO_AGENT_ID,
      agentName: 'VideoStudio',
      userMessage: '<msg from="user">status</msg>',
    });
    const uncaptured = async () => parseResult((await statusTool.execute({
      op: 'production.status',
      plan_path: 'project/plan.json',
    }, ctx)).content).production_review.uncaptured_segment_ids;

    writeMixedSourcePlan({
      cutProducedPath: path.join(workspace, 'project', 'cuts', 'never-produced.mp4'),
      composeIds: [],
    });
    expect(await uncaptured(), 'a produced_path with no file behind it').toEqual(['cut']);

    writeMixedSourcePlan({
      cutProducedPath: writeCutFile(path.join('project', 'cuts', 'empty.mp4'), ''),
      composeIds: [],
    });
    expect(await uncaptured(), 'a zero-byte cut').toEqual(['cut']);

    writeMixedSourcePlan({
      cutProducedPath: writeCutFile(path.join('project', 'cuts', 'notes.txt'), 'not media'),
      composeIds: [],
    });
    expect(await uncaptured(), 'an extension the panel cannot serve').toEqual(['cut']);

    writeMixedSourcePlan({
      cutProducedPath: path.join(root, 'outside-the-agent-scope.mp4'),
      composeIds: [],
    });
    fs.writeFileSync(path.join(root, 'outside-the-agent-scope.mp4'), 'bytes');
    expect(await uncaptured(), 'a path outside the agent scope').toEqual(['cut']);

    // The negative control that keeps this fix from weakening the rule it
    // extends: a compose segment's artifact is HTML, so a produced_path on it
    // is a render output, never evidence that anything was reviewed.
    const realMedia = writeCutFile(path.join('project', 'cuts', 'real.mp4'), 'real cut bytes');
    writeMixedSourcePlan({
      cutProducedPath: realMedia,
      composeIds: ['body'],
      composeProducedPath: realMedia,
    });
    expect(await uncaptured(), 'a compose segment carrying produced_path').toEqual(['body']);
  });

  it('stops an assembled production once for its preview, then lets every segment render', async () => {
    // The segment exemption deferred to "the production's single preview stop"
    // that nothing hosted: there is no production-level render operation, the
    // assembly is ffmpeg driven by the model, so nothing ever asked. Measured
    // twice in one production run on 2026-08-08 — first delivery went from
    // capture straight to finished video, and a frame fix the user asked for
    // was captured at 16:37:51 and rendered at 16:38:49 inside one turn, so
    // the change they requested became the final video without being shown.
    const mod = await import('../../../../src/main/model/core-agent/video-studio-tool');
    const stateMod = await import('../../../../src/main/features/video_studio_state');
    const controlMod = await import('../../../../src/main/features/video_production_control');
    const videoStudio = await import('../../../../src/main/features/video_studio');
    const ctx = { workingDir: workspace, state: {} } as any;
    // The stop only applies where a preview is required at all — 20s or more,
    // or three scenes — and the child manifest is derived from this plan, so
    // the length has to come from here.
    writeAutoParentPlan({ targetSec: 24, scenes: 3 });
    const child = writeAutoChildComposition({ targetSec: 24, scenes: 3 });

    await mod.createVideoStudioTool({
      userId: UID, cid: 'cid-preview-parent', turnId: 'turn-parent-gate-b',
      agentId: VIDEO_STUDIO_AGENT_ID, agentName: 'VideoStudio',
      userMessage: approvalSubmission('gate_b_decision', 'approve'),
    }).execute({ op: 'production.approve_plan', plan_path: 'project/plan.json' }, ctx);

    const opts = {
      userId: UID, cid: 'cid-preview-child', turnId: 'turn-child-inherit',
      agentId: VIDEO_STUDIO_AGENT_ID, agentName: 'VideoStudio',
      userMessage: '<msg from="user">later turn</msg>',
    };
    expect((await mod.createVideoStudioTool(opts).execute({
      op: 'composition.approve_plan',
      composition_dir: 'project/compositions/intro',
      plan_path: 'project/plan.json',
      segment_id: 'intro',
    }, ctx)).isError).toBe(false);

    const statePath = mod.videoStudioProductionStatePath(opts, child);
    const frames = ['01-first-frame.png', '02-mid.png'].map((n) => path.join(child, 'preview', n));
    fs.mkdirSync(path.join(child, 'preview'), { recursive: true });
    for (const f of frames) fs.writeFileSync(f, 'png');
    const sheet = path.join(child, 'preview', 'contact-sheet.png');
    fs.writeFileSync(sheet, 'png');
    await mod.recordVideoStudioGate(statePath, 'preview', child, 'turn-capture', {
      preview_ready: true,
      preview_qa: { ok: true, error_count: 0 },
      preflight: { status: 'passed', blocking_error_count: 0 },
      contact_sheet: sheet,
      frame_paths: frames,
    });
    // Real trajectory times: the capture predates the user's reply by human
    // latency, never by the sub-millisecond gap a test's own writes have.
    await stateMod.updateVideoProductionState(statePath, child, (next) => {
      if (next.preview) next.preview.created_at = new Date(Date.now() - 60_000).toISOString();
    });
    const draftSpy = vi.spyOn(videoStudio, 'draftComposition').mockResolvedValue({
      ok: false, op: 'composition.draft', errorCode: 'E_TEST_RENDER_STUB', message: 'stub',
    } as any);
    const draftInput = {
      op: 'composition.draft',
      composition_dir: 'project/compositions/intro',
      output_path: 'project/parts/intro.mp4',
    };

    expect(await mod.videoStudioPreviewRequired(child)).toBe(true);
    expect((await stateMod.readVideoProductionState(statePath, child)).plan_approval?.inheritance_reason)
      .toBe('parent_edl_segment');
    // Captured in this turn: the user cannot have seen them, so the first
    // segment to render carries the production's stop.
    const inCaptureTurn = await mod.createVideoStudioTool({ ...opts, turnId: 'turn-capture' })
      .execute(draftInput, ctx);
    expect(parseResult(inCaptureTurn.content)).toMatchObject({
      errorCode: 'E_PREVIEW_GO_AHEAD_REQUIRED',
      next_action: 'present_keyframe_preview_and_end_turn',
    });
    expect(draftSpy).not.toHaveBeenCalled();

    // Status is read-only: even in a real user turn it must not silently turn
    // a question into production authorization. Choosing draft is the model's
    // semantic decision and records the production-level go-ahead.
    const replyTool = mod.createVideoStudioTool({
      ...opts, turnId: 'turn-user-reply', userMessage: '<msg from="user">看过了，继续</msg>',
    });
    await replyTool.execute({ op: 'composition.status', composition_dir: 'project/compositions/intro' }, ctx);
    const controlPath = controlMod.videoProductionControlStatePath({
      userId: UID, planPath: path.join(workspace, 'project', 'plan.json'),
    });
    expect((await controlMod.readVideoProductionControlState(
      controlPath, path.join(workspace, 'project', 'plan.json'),
    )).preview_go_ahead).toBeUndefined();
    const replyDraft = await replyTool.execute(draftInput, ctx);
    expect(String(replyDraft.content)).not.toContain('E_PREVIEW_GO_AHEAD_REQUIRED');
    expect(draftSpy).toHaveBeenCalledTimes(1);
    const control = await controlMod.readVideoProductionControlState(
      controlPath, path.join(workspace, 'project', 'plan.json'),
    );
    expect(control.preview_go_ahead?.turn_id).toBe('turn-user-reply');

    // Now every segment renders straight through — per-segment stops are what
    // the protocol forbids, and the sibling never captured frames of its own.
    const afterGoAhead = await mod.createVideoStudioTool({ ...opts, turnId: 'turn-render' })
      .execute(draftInput, ctx);
    expect(String(afterGoAhead.content)).not.toContain('E_PREVIEW_GO_AHEAD_REQUIRED');
    expect(draftSpy).toHaveBeenCalledTimes(2);

    // A real visual edit changes the aggregate production identity even while
    // the approved plan stays the same. Capturing those new bytes does not let
    // the old go-ahead authorize them: the changed whole-video preview must be
    // shown once.
    fs.appendFileSync(path.join(child, 'index.html'), '<div id="changed-arrow">→</div>');
    await mod.recordVideoStudioGate(statePath, 'preview', child, 'turn-user-asked-for-a-fix', {
      preview_ready: true,
      preview_qa: { ok: true, error_count: 0 },
      preflight: { status: 'passed', blocking_error_count: 0 },
      contact_sheet: sheet,
      frame_paths: frames,
    });
    const afterUserRequestedFix = await mod.createVideoStudioTool({
      ...opts, turnId: 'turn-user-asked-for-a-fix', userMessage: '<msg from="user">这个箭头改一下</msg>',
    }).execute(draftInput, ctx);
    expect(parseResult(afterUserRequestedFix.content)).toMatchObject({
      errorCode: 'E_PREVIEW_GO_AHEAD_REQUIRED',
      frames_captured_this_turn: true,
    });
    expect(draftSpy).toHaveBeenCalledTimes(2);

    // A later reply to the changed complete preview records its exact aggregate
    // identity and admits the draft.
    const afterChangedPreviewReply = await mod.createVideoStudioTool({
      ...opts, turnId: 'turn-changed-preview-reply', userMessage: '<msg from="user">新画面看过了，继续</msg>',
    }).execute(draftInput, ctx);
    expect(String(afterChangedPreviewReply.content)).not.toContain('E_PREVIEW_GO_AHEAD_REQUIRED');
    expect(draftSpy).toHaveBeenCalledTimes(3);

    // Negative control: recapturing identical visual bytes does not create a
    // new identity, regardless of its timestamp or turn id.
    await mod.recordVideoStudioGate(statePath, 'preview', child, 'turn-identical-recapture', {
      preview_ready: true,
      preview_qa: { ok: true, error_count: 0 },
      preflight: { status: 'passed', blocking_error_count: 0 },
      contact_sheet: sheet,
      frame_paths: frames,
    });
    const afterIdenticalRecapture = await mod.createVideoStudioTool({
      ...opts, turnId: 'turn-identical-recapture', userMessage: '<msg from="user">继续</msg>',
    }).execute(draftInput, ctx);
    expect(String(afterIdenticalRecapture.content)).not.toContain('E_PREVIEW_GO_AHEAD_REQUIRED');
    expect(draftSpy).toHaveBeenCalledTimes(4);

    // A plan amendment is the user changing what they approved, so the next
    // render stops again. Re-approving the SAME plan does not: the go-ahead is
    // keyed on the visual identity, so an idempotent re-approval keeps it.
    const planFile = path.join(workspace, 'project', 'plan.json');
    const amendedPlan = JSON.parse(fs.readFileSync(planFile, 'utf8'));
    amendedPlan.segments[0].spec.composition_plan.scenes[0].approved_copy = ['Amended intro'];
    fs.writeFileSync(planFile, JSON.stringify(amendedPlan, null, 2), 'utf8');
    await controlMod.approveVideoProductionPlan({
      statePath: controlPath,
      planPath: path.join(workspace, 'project', 'plan.json'),
      turnId: 'turn-amendment',
    });
    const amendedControl = await controlMod.readVideoProductionControlState(
      controlPath, path.join(workspace, 'project', 'plan.json'),
    );
    expect(amendedControl.preview_go_ahead).toBeUndefined();
    await stateMod.updateVideoProductionState(statePath, child, (next) => {
      if (next.preview) next.preview.turn_id = 'turn-refix-capture';
    });
    const afterAmendment = await mod.createVideoStudioTool({ ...opts, turnId: 'turn-refix-capture' })
      .execute(draftInput, ctx);
    expect(parseResult(afterAmendment.content)).toMatchObject({
      errorCode: 'E_PREVIEW_GO_AHEAD_REQUIRED',
    });
    expect(draftSpy).toHaveBeenCalledTimes(4);
  });

  it('keeps the rest of a production moving when one segment exhausts its repair budget', async () => {
    // 15:47 on 2026-08-04: s1's visual repair budget ran out, the whole video
    // stopped to ask, and the user answered at 17:52. The six untouched
    // segments could have been finished in those two hours. The user still gets
    // the creative fork — it just travels with the one production review.
    const mod = await import('../../../../src/main/model/core-agent/video-studio-tool');
    const stateMod = await import('../../../../src/main/features/video_studio_state');
    const controlMod = await import('../../../../src/main/features/video_production_control');
    const ctx = { workingDir: workspace, state: {} } as any;
    writeAutoParentPlan();
    const child = writeAutoChildComposition();

    await mod.createVideoStudioTool({
      userId: UID,
      cid: 'cid-exhausted-parent',
      turnId: 'turn-exhausted-gate-b',
      agentId: VIDEO_STUDIO_AGENT_ID,
      agentName: 'VideoStudio',
      userMessage: approvalSubmission('gate_b_decision', 'approve'),
    }).execute({ op: 'production.approve_plan', plan_path: 'project/plan.json' }, ctx);

    const opts = {
      userId: UID,
      cid: 'cid-exhausted-child',
      turnId: 'turn-exhausted-child',
      agentId: VIDEO_STUDIO_AGENT_ID,
      agentName: 'VideoStudio',
      userMessage: '<msg from="user">later turn</msg>',
    };
    const tool = mod.createVideoStudioTool(opts);
    const inherited = await tool.execute({
      op: 'composition.approve_plan',
      composition_dir: 'project/compositions/intro',
      plan_path: 'project/plan.json',
      segment_id: 'intro',
    }, ctx);
    expect(inherited.isError, String(inherited.content)).toBe(false);

    const statePath = mod.videoStudioProductionStatePath(opts, child);
    const approvedVisualSignature = await mod.videoStudioVisualCompositionSignature(child);
    const snapshotRoot = path.join(workspace, 'snapshots', 'intro-approved');
    fs.mkdirSync(snapshotRoot, { recursive: true });
    await stateMod.updateVideoProductionState(statePath, child, (state) => {
      // A revision the user approved, preserved the way candidate snapshots
      // preserve one, plus a spent repair cycle on the current bytes.
      state.candidate_history = [{
        revision_id: 'rev-approved',
        content_hash: 'c'.repeat(64),
        visual_signature: approvedVisualSignature,
        artifacts: { composition_signature: 'c'.repeat(64) },
        locators: {},
        snapshot: {
          root_path: snapshotRoot,
          manifest_path: path.join(snapshotRoot, 'composition-manifest.json'),
          source_file_count: 2,
          source_total_bytes: 256,
          locators: {},
          updated_at: new Date().toISOString(),
        },
        runtime_fingerprint: 'fingerprint',
        created_at: new Date().toISOString(),
        last_observed_at: new Date().toISOString(),
        last_observed_op: 'composition.snapshot',
      }];
      state.visual_qa = {
        cycle: {
          inspector_version: 1_000_000,
          cycle_id: 'cycle-exhausted',
          visual_revision: 1,
          status: 'exhausted',
          max_repair_passes: 2,
          failed_signatures: ['1'.repeat(64), '2'.repeat(64), '3'.repeat(64)],
          passed_signatures: {},
          started_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        },
      };
    });

    const controlPath = controlMod.videoProductionControlStatePath({
      userId: UID,
      planPath: path.join(workspace, 'project', 'plan.json'),
    });
    const identity = await controlMod.readVideoProductionPlanIdentity(path.join(workspace, 'project', 'plan.json'));
    const status = controlMod.videoProductionReviewStatus({
      identity,
      facts: [{ segment_id: 'intro', visual_signature: approvedVisualSignature, captured: true }],
    });
    expect(status.renderable).toBe(true);

    // Being a segment is the whole signal: the other segments are untouched, so
    // the exhausted budget travels with the one production review instead of
    // halting the video. There is deliberately no "fall back to the version the
    // user approved for this scene" here — nothing restores a segment from a
    // preserved snapshot, and a segment never stops on its own frames, so a
    // per-scene approval to fall back to cannot exist. That option shipped
    // unreachable for as long as it did partly because this case proved the
    // producer while nothing exercised the consumer, which read a different key.
    const asSegment = await mod.exhaustedSegmentProductionContext({
      opts,
      state: await stateMod.readVideoProductionState(statePath, child),
    });
    expect(asSegment.production_segment).toEqual({
      plan_path: path.join(workspace, 'project', 'plan.json'),
      segment_id: 'intro',
    });

    // An earlier rendered revision changes nothing: it is not restorable and
    // the guidance does not depend on it.
    await stateMod.updateVideoProductionState(statePath, child, (next) => {
      next.candidate_history = [];
      if (next.current_candidate) delete (next.current_candidate as any).snapshot;
    });
    const withoutHistory = await mod.exhaustedSegmentProductionContext({
      opts,
      state: await stateMod.readVideoProductionState(statePath, child),
    });
    expect(withoutHistory.production_segment).toEqual({
      plan_path: path.join(workspace, 'project', 'plan.json'),
      segment_id: 'intro',
    });

    // A standalone COMPOSE composition is not a segment of anything, so the
    // exhausted budget keeps its original whole-project meaning.
    const standalone = await mod.exhaustedSegmentProductionContext({
      opts: { userId: UID, agentId: VIDEO_STUDIO_AGENT_ID },
      state: await stateMod.readVideoProductionState(
        mod.videoStudioProductionStatePath({ userId: UID, cid: 'cid-standalone' }, compositionDir),
        compositionDir,
      ),
    });
    expect(standalone).toEqual({});
  });

  it('applies a change the user named without asking them to confirm it again', async () => {
    // 12:11 the user asked for a brand animation; 12:12 the model applied it
    // and opened a confirmation asking whether to do what they had just asked
    // for. That round trip is pure loss. The exemption is bounded by things the
    // host can check: the quote must be in this turn's user message, the caller
    // must declare a change, and the plan must actually differ.
    const mod = await import('../../../../src/main/model/core-agent/video-studio-tool');
    const ctx = { workingDir: workspace, state: {} } as any;
    const opts = {
      userId: UID,
      cid: 'cid-user-instruction',
      turnId: 'turn-plan-approve',
      agentId: VIDEO_STUDIO_AGENT_ID,
      agentName: 'VideoStudio',
      userMessage: '确认',
    };
    // The exemption is amendment-only. Before any approval exists, a revise
    // quote plus expected_plan_change must NOT mint the first Gate B — for a
    // brand-new plan `plan_changed` is vacuously true, so without this guard a
    // plan the user never reviewed would become the signed baseline.
    const firstViaInstruction = await mod.createVideoStudioTool({
      ...opts,
      turnId: 'turn-first-via-instruction',
      userMessage: '<msg from="user">开头加个钩子</msg>',
    }).execute({
      op: 'composition.approve_plan',
      composition_dir: 'project/composition',
      expected_plan_change: true,
      decision_evidence: decisionEvidence('plan', 'revise', '开头加个钩子'),
    }, ctx);
    expect(firstViaInstruction.isError).toBe(true);
    expect(String(firstViaInstruction.content)).toContain('E_GATE_B_EXPLICIT_APPROVAL_REQUIRED');

    const approved = await mod.createVideoStudioTool(opts).execute({
      op: 'composition.approve_plan',
      composition_dir: 'project/composition',
      decision_evidence: decisionEvidence('plan', 'approve', '确认'),
    }, ctx);
    expect(approved.isError, String(approved.content)).toBe(false);
    expect(parseResult(approved.content).plan_authorization).toBe('explicit_approval');

    const instruction = '虎鲸跃出时加品牌动效';
    const applyInstruction = (turnId: string) => mod.createVideoStudioTool({
      ...opts,
      turnId,
      userMessage: `<msg from="user">${instruction}</msg>`,
    }).execute({
      op: 'composition.approve_plan',
      composition_dir: 'project/composition',
      expected_plan_change: true,
      decision_evidence: decisionEvidence('plan', 'revise', instruction),
    }, ctx);

    // Nothing changed yet: the host must not book an approval for a plan that
    // does not carry the instruction, or the exemption would be a blank cheque.
    const notApplied = await applyInstruction('turn-instruction-not-applied');
    expect(notApplied.isError).toBe(true);
    expect(String(notApplied.content)).toContain('E_GATE_B_AMENDMENT_NOT_APPLIED');

    const manifestPath = path.join(compositionDir, 'composition-manifest.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    manifest.scenes[0].approved_copy = ['Approved', '品牌动效'];
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');
    const shotlistPath = path.join(workspace, 'project', 'shotlist.json');
    const shotlist = JSON.parse(fs.readFileSync(shotlistPath, 'utf8'));
    shotlist.shots[0].brand_motion = instruction;
    fs.writeFileSync(shotlistPath, JSON.stringify(shotlist), 'utf8');

    const applied = await applyInstruction('turn-instruction-applied');
    expect(applied.isError, String(applied.content)).toBe(false);
    const payload = parseResult(String(applied.content));
    expect(payload).toMatchObject({
      status: 'approved',
      plan_changed: true,
      plan_authorization: 'user_instruction',
    });
    expect(payload.message).toMatch(/do not ask them to confirm the change they just asked for/);

    // Negative control: the same call with a quote the user never said in this
    // turn is a model-initiated rewrite and still needs a confirmation.
    manifest.scenes[0].approved_copy = ['Approved', '模型自己想加的'];
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');
    const modelInitiated = await mod.createVideoStudioTool({
      ...opts,
      turnId: 'turn-model-initiated',
      userMessage: '<msg from="user">好的</msg>',
    }).execute({
      op: 'composition.approve_plan',
      composition_dir: 'project/composition',
      expected_plan_change: true,
      decision_evidence: decisionEvidence('plan', 'revise', '旁白超时，我替你精简了'),
    }, ctx);
    expect(modelInitiated.isError).toBe(true);
    expect(String(modelInitiated.content)).toMatch(/E_GATE_B_EXPLICIT_APPROVAL_REQUIRED|quote_not_in_current_turn/);
  });

  it('compacts QA-blocked results to the repair focus without touching passing ones', async () => {
    // A QA-blocked snapshot result ran to ~100KB (per-frame visible_elements,
    // the whole preflight report), spilled past the inline cap, and cost the
    // model two extra round trips before every repair. The returned payload
    // keeps exactly what a repair needs — error findings with fix hints —
    // while the full evidence stays in the findings/report files on disk.
    const mod = await import('../../../../src/main/model/core-agent/video-studio-tool');
    const bulkySamples = Array.from({ length: 9 }, (_, i) => ({
      label: i === 0 ? 'first-frame' : `sample-${i}`,
      time_seconds: i,
      path: `/ws/preview/frames/${i}.png`,
      visible_elements: Array.from({ length: 40 }, (_, k) => ({
        role: 'body', text: `element ${k} with a reasonably long copy line for bulk`, width_ratio: 0.4,
      })),
    }));
    const blocked = {
      ok: false,
      op: 'composition.snapshot',
      errorCode: 'E_PREVIEW_QA_BLOCKED',
      message: 'Preview frame coverage or scene semantics failed QA.',
      blocking_error_count: 2,
      contact_sheet: '/ws/preview/contact-sheet.png',
      frame_paths: bulkySamples.map((sample) => sample.path),
      frame_evidence: { evidence_dir: '/ws/preview', contact_sheet: '/ws/preview/contact-sheet.png', samples: bulkySamples },
      preview_qa: {
        ok: false,
        error_count: 2,
        warning_count: 1,
        issue_count: 3,
        samples: bulkySamples,
        issues: [
          { code: 'EMPTY_HOOK_FRAME', severity: 'error', message: 'blank first frame', fixHint: 'design the resolved 0s state' },
          { code: 'HOOK_PROMISE_NOT_VISIBLE', severity: 'error', message: 'no visible title', fixHint: 'render the approved headline at 0s' },
          { code: 'SCENE_VARIATION_LOW', severity: 'warning', message: 'advisory only' },
        ],
      },
      preflight: {
        status: 'passed',
        blocking_error_count: 0,
        contract_html: { issues: Array.from({ length: 30 }, () => ({ code: 'X', severity: 'warning', message: 'noise' })) },
      },
      design_review_inputs: { huge: 'x'.repeat(2000) },
      visual_regression: { status: 'skipped', detail: 'y'.repeat(2000) },
      preview_ready: false,
    } as any;

    const compact = mod.compactQaBlockedVideoStudioResult(blocked) as any;
    expect(JSON.stringify(compact).length).toBeLessThan(JSON.stringify(blocked).length / 4);
    // Errors first, then the advisory tail: a warning is repair material too,
    // and dropping every one of them made a passing inspect report
    // `issueCount: 13, issues: []` on 2026-08-07 — a count and nothing to act
    // on, so the model rediscovered the defects one frame pass at a time.
    expect(compact.preview_qa.issues.map((issue: any) => issue.code)).toEqual([
      'EMPTY_HOOK_FRAME', 'HOOK_PROMISE_NOT_VISIBLE', 'SCENE_VARIATION_LOW',
    ]);
    expect(compact.preview_qa.issues.filter((issue: any) => issue.severity === 'error')
      .every((issue: any) => !!issue.fixHint)).toBe(true);
    expect(compact.preview_qa.issues_omitted).toBeUndefined();
    expect(compact.preview_qa.samples).toBeUndefined();
    expect(compact.frame_evidence).toEqual({
      evidence_dir: '/ws/preview',
      contact_sheet: '/ws/preview/contact-sheet.png',
      sample_count: 9,
    });
    expect(compact.design_review_inputs).toBeUndefined();
    expect(compact.visual_regression).toBeUndefined();
    // Locators the repair needs stay.
    expect(compact.contact_sheet).toBe('/ws/preview/contact-sheet.png');
    expect(compact.frame_paths).toHaveLength(9);

    // Small results and non-QA errors are returned untouched.
    const otherError = { ok: false, op: 'composition.snapshot', errorCode: 'E_SNAPSHOT_FAILED' } as any;
    expect(mod.compactQaBlockedVideoStudioResult(otherError)).toBe(otherError);
    const smallPass = { ok: true, op: 'composition.lint', status: 'passed', blocking_error_count: 0 } as any;
    expect(mod.compactQaBlockedVideoStudioResult(smallPass)).toBe(smallPass);
  });

  it('drops the design-review inputs from a passing render that opens no review', async () => {
    // 2026-08-10: a passing composition.draft was 15.7KB, of which 3.9KB was
    // `design_review_inputs` sitting beside `design_review_required: false`,
    // and the identical bytes had just been written to report_path. Export was
    // the same at 7.2KB of 29.6KB. Six drafts in one round came to ~4,095
    // tokens each against a 7,027 round budget, so three of six verdicts
    // reached the model as refs; the export exceeded the per-result budget on
    // its own. The existing deletion sits after the QA-compaction return and
    // never runs for a passing result.
    const mod = await import('../../../../src/main/model/core-agent/video-studio-tool');
    const passing = {
      ok: true,
      op: 'composition.draft',
      path: '/ws/project/parts/s4.mp4',
      bytes: 310763,
      report_path: '/ws/project/render/s4-draft-report.json',
      probe: { duration_seconds: 12, video: { codec: 'h264', width: 1920, height: 1080 } },
      design_review_required: false,
      design_review_inputs: { version: 1, scenes: Array.from({ length: 40 }, (_, i) => ({ id: `s${i}`, copy: 'x'.repeat(120) })) },
      draft_ready: true,
      gate_d_ready: true,
      next_action: 'open_gate_d',
      next_allowed_ops: ['composition.approve_draft'],
      report: { steps: { lint: 'ok', authoring: 'ok' }, samples: Array.from({ length: 9 }, () => ({ blob: 'y'.repeat(900) })) },
    } as any;

    const compact = mod.compactQaBlockedVideoStudioResult(passing) as any;
    expect(compact.design_review_inputs).toBeUndefined();
    expect(String(compact.design_review_inputs_note)).toContain('report_path');
    // Everything the caller acts on at Gate D survives.
    expect(compact).toMatchObject({
      ok: true,
      path: '/ws/project/parts/s4.mp4',
      report_path: '/ws/project/render/s4-draft-report.json',
      gate_d_ready: true,
      next_action: 'open_gate_d',
    });
    expect(compact.probe).toEqual(passing.probe);

    // export carries no `design_review_required` at all — absent is not a
    // review, and its inputs were the same 24% of the payload.
    const exported = { ...passing, op: 'composition.export', design_review_required: undefined } as any;
    delete exported.design_review_required;
    expect((mod.compactQaBlockedVideoStudioResult(exported) as any).design_review_inputs).toBeUndefined();

    // A review that IS open keeps its inputs: that caller has to act on them.
    const reviewOpen = { ...passing, design_review_required: true } as any;
    expect((mod.compactQaBlockedVideoStudioResult(reviewOpen) as any).design_review_inputs)
      .toEqual(passing.design_review_inputs);

    // With no disk copy named, the inline copy is the only one and survives.
    const noDiskCopy = { ...passing } as any;
    delete noDiskCopy.report_path;
    expect((mod.compactQaBlockedVideoStudioResult(noDiskCopy) as any).design_review_inputs)
      .toEqual(passing.design_review_inputs);
  });

  it('blocks the render at the keyframe preview and lets the model author the stop', async () => {
    // What must be structural is that nothing RENDERS before the user has the
    // frames; verifying it from tool-call-local evidence failed twice (a
    // fabricated quote, then a genuine "继续" said before the frames existed).
    // What must NOT be structural is the message: terminating the turn from
    // the host produced "Snapshot 通过（0 阻断）。直接渲染草稿。" as the user's
    // entire reply, because the host cannot author text — only the model can.
    // So the refusal blocks and redirects, and the model writes the stop.
    const mod = await import('../../../../src/main/model/core-agent/video-studio-tool');
    const videoStudio = await import('../../../../src/main/features/video_studio');
    const ctx = { workingDir: workspace, state: {} } as any;
    const opts = {
      userId: UID,
      cid: 'cid-preview-stop',
      turnId: 'turn-preview-approve',
      agentId: VIDEO_STUDIO_AGENT_ID,
      agentName: 'VideoStudio',
      userMessage: '确认',
    };
    const manifestPath = path.join(compositionDir, 'composition-manifest.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    manifest.composition.duration = 30;
    manifest.scenes[0].duration = 30;
    manifest.scenes[0].narration_text = '';
    manifest.audio = { owner: 'none', tracks: [] };
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');
    expect(await mod.videoStudioPreviewRequired(compositionDir)).toBe(true);

    await mod.createVideoStudioTool(opts).execute({
      op: 'composition.approve_plan',
      composition_dir: 'project/composition',
      decision_evidence: decisionEvidence('plan', 'approve', '确认'),
    }, ctx);

    const statePath = mod.videoStudioProductionStatePath(opts, compositionDir);
    const framePaths = ['01-first-frame.png', '02-cover-mid.png'].map(
      (name) => path.join(compositionDir, 'preview', name),
    );
    fs.mkdirSync(path.join(compositionDir, 'preview'), { recursive: true });
    for (const framePath of framePaths) fs.writeFileSync(framePath, 'png');
    const contactSheet = path.join(compositionDir, 'preview', 'contact-sheet.png');
    fs.writeFileSync(contactSheet, 'png');
    expect(await mod.recordVideoStudioGate(statePath, 'preview', compositionDir, 'turn-capture', {
      preview_ready: true,
      preview_qa: { ok: true, error_count: 0 },
      preflight: { status: 'passed', blocking_error_count: 0 },
      contact_sheet: contactSheet,
      frame_paths: framePaths,
    })).toBe(true);

    const draftInput = {
      op: 'composition.draft',
      composition_dir: 'project/composition',
      output_path: 'project/render/draft.mp4',
    };
    const draftSpy = vi.spyOn(videoStudio, 'draftComposition').mockResolvedValue({
      ok: false,
      op: 'composition.draft',
      errorCode: 'E_TEST_RENDER_STUB',
      message: 'render stubbed for the stop test',
    } as any);

    // Rendering in the capture turn: refused, and the turn ends with it.
    // Evidence does not help — a real verbatim quote is offered here and
    // changes nothing, which is the whole point of the redesign.
    const sameTurn = await mod.createVideoStudioTool({
      ...opts,
      turnId: 'turn-capture',
      userMessage: '<msg from="user">继续</msg>',
    }).execute({
      ...draftInput,
      decision_evidence: decisionEvidence('preview', 'approve', '继续'),
    }, ctx);
    expect(sameTurn.isError).toBe(true);
    // The runner permits exactly one tool-free synthesis so the model can
    // write the message carrying these frames, then ends the turn.
    expect(sameTurn.endTurn).toBeUndefined();
    expect(sameTurn.synthesizeAndEndTurn).toBe(true);
    const payload = parseResult(sameTurn.content);
    expect(payload).toMatchObject({
      errorCode: 'E_PREVIEW_GO_AHEAD_REQUIRED',
      frames_captured_this_turn: true,
      next_action: 'present_keyframe_preview_and_end_turn',
      contact_sheet: contactSheet,
    });
    expect(payload.frame_paths).toEqual(framePaths);
    expect(draftSpy).not.toHaveBeenCalled();

    // Before any go-ahead, a turn with no real user message behind it (a
    // dispatch, a resumed background turn) is not a reply and cannot open
    // the stop.
    const dispatched = await mod.createVideoStudioTool({
      ...opts,
      turnId: 'turn-dispatched',
      userMessage: '<msg from="commander" to="79df9cc89f5f">继续推进</msg>',
    }).execute(draftInput, ctx);
    expect(parseResult(dispatched.content)).toMatchObject({
      errorCode: 'E_PREVIEW_GO_AHEAD_REQUIRED',
      frames_captured_this_turn: false,
    });
    expect(dispatched.endTurn).toBeUndefined();
    expect(dispatched.synthesizeAndEndTurn).toBe(true);

    // A user can ask about the preview without approving it. Status exposes
    // one clear productive frontier, omits an absent design-review record,
    // and leaves durable authorization untouched.
    const questionStatus = parseResult((await mod.createVideoStudioTool({
      ...opts,
      turnId: 'turn-preview-question',
      userMessage: '<msg from="user">第二帧是什么意思？</msg>',
    }).execute({
      op: 'composition.status',
      composition_dir: 'project/composition',
    }, ctx)).content);
    expect(questionStatus.production_state.next_allowed_ops).toEqual(['composition.draft']);
    expect(questionStatus.production_state).not.toHaveProperty('preview_design_review');
    const stateAfterQuestion = await (await import('../../../../src/main/features/video_studio_state'))
      .readVideoProductionState(statePath, compositionDir);
    expect(stateAfterQuestion.preview_go_ahead).toBeUndefined();

    // The anti-loop backstop: a model that retries the identical call instead
    // of presenting is stopped by the repeated-failure breaker, still with
    // nothing rendered.
    const looper = mod.createVideoStudioTool({
      ...opts,
      turnId: 'turn-capture',
      userMessage: '<msg from="user">继续</msg>',
    });
    let last = sameTurn;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      last = await looper.execute(draftInput, ctx);
    }
    expect(parseResult(last.content).errorCode).toBe('E_REPEATED_FAILURE_USER_DECISION_REQUIRED');
    expect(draftSpy).not.toHaveBeenCalled();

    // A later real user turn is the go-ahead, with no evidence to construct:
    // the user spoke after a turn that ended on the frames. Passing the stop
    // records the go-ahead against the signed plan.
    const laterTurn = await mod.createVideoStudioTool({
      ...opts,
      turnId: 'turn-after-user-reply',
      userMessage: '<msg from="user">继续</msg>',
    }).execute(draftInput, ctx);
    expect(String(laterTurn.content)).not.toContain('E_PREVIEW_GO_AHEAD_REQUIRED');
    expect(draftSpy).toHaveBeenCalledTimes(1);
    const afterGoAhead = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    expect(afterGoAhead.preview_go_ahead).toMatchObject({
      plan_signature: afterGoAhead.plan_approval.signature,
      turn_id: 'turn-after-user-reply',
    });

    // Re-capturing the same visual source bytes does not create a new visual
    // identity, even if the generated frame files and their capture turn are
    // new. The source identity, not timestamps or PNG encoding, owns the stop.
    const stateModule = await import('../../../../src/main/features/video_studio_state');
    await stateModule.updateVideoProductionState(statePath, compositionDir, (next) => {
      next.visual_qa = {
        cycle: {
          inspector_version: 3,
          cycle_id: 'cycle-repair',
          visual_revision: 1,
          status: 'active',
          max_repair_passes: 2,
          failed_signatures: ['a'.repeat(64)],
          passed_signatures: {},
          last_failure_turn_id: 'turn-repair-capture',
          started_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        },
      } as any;
    });
    for (const framePath of framePaths) fs.writeFileSync(framePath, 'png-repaired');
    fs.writeFileSync(contactSheet, 'sheet-repaired');
    await mod.recordVideoStudioGate(statePath, 'preview', compositionDir, 'turn-repair-capture', {
      preview_ready: true,
      preview_qa: { ok: true, error_count: 0 },
      preflight: { status: 'passed', blocking_error_count: 0 },
      contact_sheet: contactSheet,
      frame_paths: framePaths,
    });
    const repairTurn = await mod.createVideoStudioTool({
      ...opts,
      turnId: 'turn-repair-capture',
      userMessage: '<msg from="user">继续</msg>',
    }).execute(draftInput, ctx);
    expect(String(repairTurn.content)).not.toContain('E_PREVIEW_GO_AHEAD_REQUIRED');
    expect(draftSpy).toHaveBeenCalledTimes(2);

    // A plan amendment changes the signature; the stale go-ahead no longer
    // matches and the new plan's preview stops once again.
    const amended = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    amended.plan_approval.signature = 'amended-signature';
    fs.writeFileSync(statePath, JSON.stringify(amended), 'utf8');
    const afterAmendment = await mod.createVideoStudioTool({
      ...opts,
      turnId: 'turn-repair-capture',
      userMessage: '<msg from="user">继续</msg>',
    }).execute(draftInput, ctx);
    expect(parseResult(afterAmendment.content)).toMatchObject({
      errorCode: 'E_PREVIEW_GO_AHEAD_REQUIRED',
      frames_captured_this_turn: true,
    });
    expect(draftSpy).toHaveBeenCalledTimes(2);
    draftSpy.mockRestore();
  });

  it('keeps status read-only and accepts direct draft after the preview reply', async () => {
    // The 2026-08-10 trace spent a long process turn oscillating after status:
    // the user had clearly replied to an earlier preview, but status both hid
    // the go-ahead and advertised many unrelated operations. The intended
    // path is status (read-only) followed directly by draft; no recapture.
    const mod = await import('../../../../src/main/model/core-agent/video-studio-tool');
    const videoStudio = await import('../../../../src/main/features/video_studio');
    const ctx = { workingDir: workspace, state: {} } as any;
    const opts = {
      userId: UID,
      cid: 'cid-preview-recapture-deadlock',
      turnId: 'turn-plan-approve',
      agentId: VIDEO_STUDIO_AGENT_ID,
      agentName: 'VideoStudio',
      userMessage: '确认',
    };
    const manifestPath = path.join(compositionDir, 'composition-manifest.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    manifest.composition.duration = 30;
    manifest.scenes[0].duration = 30;
    manifest.scenes[0].narration_text = '';
    manifest.audio = { owner: 'none', tracks: [] };
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');
    expect(await mod.videoStudioPreviewRequired(compositionDir)).toBe(true);
    await mod.createVideoStudioTool(opts).execute({
      op: 'composition.approve_plan',
      composition_dir: 'project/composition',
      decision_evidence: decisionEvidence('plan', 'approve', '确认'),
    }, ctx);

    const statePath = mod.videoStudioProductionStatePath(opts, compositionDir);
    fs.mkdirSync(path.join(compositionDir, 'preview'), { recursive: true });
    const framePaths = ['01-first-frame.png', '02-cover-mid.png'].map(
      (name) => path.join(compositionDir, 'preview', name),
    );
    const contactSheet = path.join(compositionDir, 'preview', 'contact-sheet.png');
    const capture = async (turnId: string, body: string): Promise<void> => {
      for (const framePath of framePaths) fs.writeFileSync(framePath, body);
      fs.writeFileSync(contactSheet, body);
      expect(await mod.recordVideoStudioGate(statePath, 'preview', compositionDir, turnId, {
        preview_ready: true,
        preview_qa: { ok: true, error_count: 0 },
        preflight: { status: 'passed', blocking_error_count: 0 },
        contact_sheet: contactSheet,
        frame_paths: framePaths,
      })).toBe(true);
    };
    const draftInput = {
      op: 'composition.draft',
      composition_dir: 'project/composition',
      output_path: 'project/render/draft.mp4',
    };
    const draftSpy = vi.spyOn(videoStudio, 'draftComposition').mockResolvedValue({
      ok: false,
      op: 'composition.draft',
      errorCode: 'E_TEST_RENDER_STUB',
      message: 'render stubbed for the deadlock test',
    } as any);

    // Turn 1: the model captures and the host refuses the render, correctly —
    // the user has not seen these frames yet.
    await capture('turn-1-capture', 'png');
    const firstTurn = await mod.createVideoStudioTool({
      ...opts,
      turnId: 'turn-1-capture',
      userMessage: '<msg from="user">继续</msg>',
    }).execute(draftInput, ctx);
    expect(parseResult(firstTurn.content)).toMatchObject({
      errorCode: 'E_PREVIEW_GO_AHEAD_REQUIRED',
      frames_captured_this_turn: true,
    });
    expect(draftSpy).not.toHaveBeenCalled();

    // Turn 2: status does not mutate authorization. The model then interprets
    // the user's reply by choosing draft, which records the go-ahead and
    // renders against the earlier current frames.
    const replyTool = mod.createVideoStudioTool({
      ...opts,
      turnId: 'turn-2-user-reply',
      userMessage: '<msg from="user">继续</msg>',
    });
    expect((await replyTool.execute({
      op: 'composition.status',
      composition_dir: 'project/composition',
    }, ctx)).isError).toBe(false);
    expect(JSON.parse(fs.readFileSync(statePath, 'utf8')).preview_go_ahead).toBeUndefined();
    const replyTurn = await replyTool.execute(draftInput, ctx);
    expect(String(replyTurn.content)).not.toContain('E_PREVIEW_GO_AHEAD_REQUIRED');
    expect(draftSpy).toHaveBeenCalledTimes(1);
    expect(JSON.parse(fs.readFileSync(statePath, 'utf8')).preview_go_ahead)
      .toMatchObject({ turn_id: 'turn-2-user-reply' });

    draftSpy.mockRestore();
  });

  it('grants the next visual QA cycle from the user reply, never from the agent', async () => {
    // The per-cycle budget bounds retrying ONE strategy. It used to be
    // reopened by composition.begin_visual_revision, which the model called on
    // its own — so a cycle was bounded and the cycles were not. On 2026-08-07
    // a CTA scene alternated between "never visible" and "visible in every
    // frame" across three self-granted cycles and ~12 minutes, never stopping
    // to ask, and the run ended with the model inventing a QA waiver it had no
    // authority to grant. The operation is gone; a person is now the bound.
    makePlanVisualOnly();
    const mod = await import('../../../../src/main/model/core-agent/video-studio-tool');
    const stateMod = await import('../../../../src/main/features/video_studio_state');
    const ctx = { workingDir: workspace, state: {} } as any;
    const opts = {
      userId: UID,
      cid: 'cid-visual-cycle-grant',
      turnId: 'turn-plan-approve',
      agentId: VIDEO_STUDIO_AGENT_ID,
      agentName: 'VideoStudio',
      userMessage: '确认',
    };
    expect((await mod.createVideoStudioTool(opts).execute({
      op: 'composition.approve_plan',
      composition_dir: 'project/composition',
      decision_evidence: decisionEvidence('plan', 'approve', '确认'),
    }, ctx)).isError).toBe(false);
    const statePath = mod.videoStudioProductionStatePath(opts, compositionDir);

    // The operation itself no longer exists.
    const removed = await mod.createVideoStudioTool({ ...opts, turnId: 'turn-removed-op' })
      .execute({ op: 'composition.begin_visual_revision', composition_dir: 'project/composition' }, ctx);
    expect(removed.isError).toBe(true);
    expect(String(removed.content)).not.toContain('"status": "started"');

    const exhaustInTurn = async (turnId: string): Promise<void> => {
      await stateMod.updateVideoProductionState(statePath, compositionDir, (state) => {
        state.visual_qa = {
          cycle: {
            cycle_id: `cycle-${turnId}`,
            inspector_version: 3,
            visual_revision: 1,
            status: 'exhausted',
            max_repair_passes: 2,
            started_by_turn_id: turnId,
            exhausted_by_turn_id: turnId,
            failed_signatures: ['sig-a', 'sig-b', 'sig-c'],
            passed_signatures: {},
          },
          history: [],
        } as any;
      });
    };

    // Same turn as the exhaustion: nothing is granted — that turn owes the
    // user the findings, and no reply has happened yet.
    await exhaustInTurn('turn-exhausted');
    await mod.createVideoStudioTool({ ...opts, turnId: 'turn-exhausted' })
      .execute({ op: 'composition.status', composition_dir: 'project/composition' }, ctx);
    expect((await stateMod.readVideoProductionState(statePath, compositionDir)).visual_qa?.cycle)
      .toMatchObject({ visual_revision: 1, status: 'exhausted' });

    // A turn with no real user message behind it is not a reply either.
    await mod.createVideoStudioTool({
      ...opts,
      turnId: 'turn-dispatched',
      userMessage: '<msg from="commander" to="79df9cc89f5f">继续推进</msg>',
    }).execute({ op: 'composition.status', composition_dir: 'project/composition' }, ctx);
    expect((await stateMod.readVideoProductionState(statePath, compositionDir)).visual_qa?.cycle)
      .toMatchObject({ visual_revision: 1, status: 'exhausted' });

    // The user replies: the next cycle opens before the turn's first call, and
    // the spent cycle moves to history so its failed strategies stay readable.
    const granted = await mod.createVideoStudioTool({
      ...opts,
      turnId: 'turn-user-reply',
      userMessage: '<msg from="user">再试一次，换个做法</msg>',
    }).execute({ op: 'composition.status', composition_dir: 'project/composition' }, ctx);
    expect(granted.isError).toBe(false);
    const afterReply = await stateMod.readVideoProductionState(statePath, compositionDir);
    expect(afterReply.visual_qa?.cycle).toMatchObject({
      visual_revision: 2,
      status: 'active',
      started_by_turn_id: 'turn-user-reply',
    });
    expect(afterReply.visual_qa?.history?.some(
      (cycle) => cycle.failed_signatures?.includes('sig-a'),
    )).toBe(true);
  });

  it('stops a short segment of a long production: the promise is per video, not per segment', async () => {
    // The exact 2026-08-08 production shape: a 60s promo built from segments
    // each under 20 seconds with one scene each. Judged per segment, every one
    // of them was "short and simple — skip the preview", so the production
    // stop the segment exemption defers to was never evaluated and all five
    // went snapshot -> draft -> assembly with preview_go_ahead still null,
    // twice in one day. The requirement is judged on the parent EDL for a
    // segment of an assembled production; the segment-level thresholds keep
    // governing standalone compositions and genuinely small productions.
    const mod = await import('../../../../src/main/model/core-agent/video-studio-tool');
    const stateMod = await import('../../../../src/main/features/video_studio_state');
    const videoStudio = await import('../../../../src/main/features/video_studio');
    const ctx = { workingDir: workspace, state: {} } as any;
    const planPath = writeAutoParentPlan({ targetSec: 12, scenes: 1 });
    // The plan carries the whole video's duration; this segment is one twelfth
    // of a minute of it. (Only total_target_sec matters to the production
    // judgement here — the fixture's single segment stands in for six.)
    const plan = JSON.parse(fs.readFileSync(planPath, 'utf8'));
    plan.total_target_sec = 60;
    fs.writeFileSync(planPath, JSON.stringify(plan, null, 2), 'utf8');
    const child = writeAutoChildComposition({ targetSec: 12, scenes: 1 });

    expect((await mod.createVideoStudioTool({
      userId: UID, cid: 'cid-short-seg-parent', turnId: 'turn-short-b',
      agentId: VIDEO_STUDIO_AGENT_ID, agentName: 'VideoStudio',
      userMessage: approvalSubmission('gate_b_decision', 'approve'),
    }).execute({ op: 'production.approve_plan', plan_path: 'project/plan.json' }, ctx)).isError).toBe(false);
    const opts = {
      userId: UID, cid: 'cid-short-seg', turnId: 'turn-short-inherit',
      agentId: VIDEO_STUDIO_AGENT_ID, agentName: 'VideoStudio',
      userMessage: '<msg from="user">later turn</msg>',
    };
    expect((await mod.createVideoStudioTool(opts).execute({
      op: 'composition.approve_plan',
      composition_dir: 'project/compositions/intro',
      plan_path: 'project/plan.json',
      segment_id: 'intro',
    }, ctx)).isError).toBe(false);

    // The trap: judged alone this segment needs no preview at all.
    expect(await mod.videoStudioPreviewRequired(child)).toBe(false);

    const statePath = mod.videoStudioProductionStatePath(opts, child);
    const framePath = path.join(child, 'preview', '01-first-frame.png');
    fs.mkdirSync(path.dirname(framePath), { recursive: true });
    fs.writeFileSync(framePath, 'png');
    await mod.recordVideoStudioGate(statePath, 'preview', child, 'turn-short-capture', {
      preview_ready: true,
      preview_qa: { ok: true, error_count: 0 },
      preflight: { status: 'passed', blocking_error_count: 0 },
      frame_paths: [framePath],
    });
    const draftSpy = vi.spyOn(videoStudio, 'draftComposition').mockResolvedValue({
      ok: false, op: 'composition.draft', errorCode: 'E_TEST_RENDER_STUB', message: 'stub',
    } as any);

    // Same turn as capture, no go-ahead recorded: the production's one stop
    // fires here, on its first rendering segment.
    const blocked = await mod.createVideoStudioTool({ ...opts, turnId: 'turn-short-capture' })
      .execute({
        op: 'composition.draft',
        composition_dir: 'project/compositions/intro',
        output_path: 'project/parts/intro.mp4',
      }, ctx);
    expect(parseResult(blocked.content)).toMatchObject({ errorCode: 'E_PREVIEW_GO_AHEAD_REQUIRED' });
    expect(draftSpy).not.toHaveBeenCalled();

    // Negative control: a production that is genuinely small keeps rendering
    // without a forced screenshot confirmation — the rule the short-video
    // exemption exists for.
    const smallPlan = JSON.parse(fs.readFileSync(planPath, 'utf8'));
    smallPlan.total_target_sec = 12;
    fs.writeFileSync(planPath, JSON.stringify(smallPlan, null, 2), 'utf8');
    await stateMod.updateVideoProductionState(statePath, child, (next) => {
      if (next.preview) next.preview.created_at = new Date(Date.now() - 60_000).toISOString();
    });
    const small = await mod.createVideoStudioTool({ ...opts, turnId: 'turn-short-capture' })
      .execute({
        op: 'composition.draft',
        composition_dir: 'project/compositions/intro',
        output_path: 'project/parts/intro-2.mp4',
      }, ctx);
    expect(String(small.content)).not.toContain('E_PREVIEW_GO_AHEAD_REQUIRED');
  });

  it('exempts an assembled production segment from its own keyframe stop', async () => {
    // One video, one preview stop. A child of a parent EDL renders its part
    // under the production's single stop; asking per segment is the churn the
    // protocol forbids. The exemption is the production's go-ahead — recorded
    // here by this very draft call, because the user is replying after frames
    // captured in an earlier turn — never the bare presence of a user
    // message: this fixture used to run without any parent production at all
    // and passed through the generic escape, which is the hole the 2026-08-08
    // run went through.
    const mod = await import('../../../../src/main/model/core-agent/video-studio-tool');
    const stateMod = await import('../../../../src/main/features/video_studio_state');
    const ctx = { workingDir: workspace, state: {} } as any;
    writeAutoParentPlan({ targetSec: 30, scenes: 3 });
    expect((await mod.createVideoStudioTool({
      userId: UID, cid: 'cid-child-preview-parent', turnId: 'turn-parent-b',
      agentId: VIDEO_STUDIO_AGENT_ID, agentName: 'VideoStudio',
      userMessage: approvalSubmission('gate_b_decision', 'approve'),
    }).execute({ op: 'production.approve_plan', plan_path: 'project/plan.json' }, ctx)).isError).toBe(false);
    const opts = {
      userId: UID,
      cid: 'cid-child-preview',
      turnId: 'turn-child-approve',
      agentId: VIDEO_STUDIO_AGENT_ID,
      agentName: 'VideoStudio',
      userMessage: '确认',
    };
    const manifestPath = path.join(compositionDir, 'composition-manifest.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    manifest.composition.duration = 30;
    manifest.scenes[0].duration = 30;
    manifest.scenes[0].narration_text = '';
    manifest.audio = { owner: 'none', tracks: [] };
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');
    await mod.createVideoStudioTool(opts).execute({
      op: 'composition.approve_plan',
      composition_dir: 'project/composition',
      decision_evidence: decisionEvidence('plan', 'approve', '确认'),
    }, ctx);

    const statePath = mod.videoStudioProductionStatePath(opts, compositionDir);
    const framePath = path.join(compositionDir, 'preview', '01-first-frame.png');
    fs.mkdirSync(path.dirname(framePath), { recursive: true });
    fs.writeFileSync(framePath, 'png');
    await mod.recordVideoStudioGate(statePath, 'preview', compositionDir, 'turn-snapshot', {
      preview_ready: true,
      preview_qa: { ok: true, error_count: 0 },
      preflight: { status: 'passed', blocking_error_count: 0 },
      frame_paths: [framePath],
    });
    // Mark it as a segment of a parent EDL, captured a human beat earlier.
    const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    state.plan_approval.inheritance_reason = 'parent_edl_segment';
    state.plan_approval.parent_plan_path = path.join(workspace, 'project', 'plan.json');
    state.plan_approval.parent_segment_id = 'intro';
    state.preview.created_at = new Date(Date.now() - 60_000).toISOString();
    fs.writeFileSync(statePath, JSON.stringify(state), 'utf8');

    const rendered = await mod.createVideoStudioTool({
      ...opts,
      turnId: 'turn-child-draft',
      userMessage: '<msg from="user">继续</msg>',
    }).execute({
      op: 'composition.draft',
      composition_dir: 'project/composition',
      output_path: 'project/parts/intro.mp4',
    }, ctx);
    expect(String(rendered.content)).not.toContain('E_PREVIEW_GO_AHEAD_REQUIRED');
  });

  it('keeps a QA-blocked result inline-able by bounding its durable-state sections', async () => {
    // The 2026-08-07 blocked draft was 71KB and spilled: 36KB production_state
    // (superseded candidate history, a duplicate of the candidate already at
    // top level, the approved-intent snapshot), 10KB current_candidate (mostly
    // private content-store bookkeeping), 11KB review package — against 257
    // bytes of actual findings. Spilling costs the model a search round trip
    // for evidence it never needed; all of it is recoverable from
    // composition.status on demand.
    const mod = await import('../../../../src/main/model/core-agent/video-studio-tool');
    const bulk = (n: number) => 'x'.repeat(n);
    const candidate = {
      revision_id: 'candidate-r7',
      parent_revision_id: 'candidate-r6',
      content_hash: 'hash',
      visual_signature: 'vis',
      last_quality_result: { ok: false, error_code: 'E_VIDEO_QA_BLOCKED' },
      locators: {
        html_path: '/ws/index.html',
        draft_path: '/ws/render/main-draft.mp4',
        frame_paths: ['/ws/render/evidence/01.png', '/ws/render/evidence/02.png'],
      },
      snapshot: {
        root_path: '/store',
        manifest_path: '/store/m.json',
        locators: { draft_path: '/ws/render/frozen-draft.mp4' },
        source_index: bulk(6000),
      },
      artifacts: { manifest_sha256: 'a', html_sha256: 'b', extra: bulk(200) },
    };
    const blocked = {
      ok: false,
      op: 'composition.draft',
      errorCode: 'E_VIDEO_QA_BLOCKED',
      message: 'video-level QA failed.',
      path: '/ws/render/main-draft.mp4',
      video_qa: {
        ok: false,
        error_count: 1,
        issues: [{ code: 'EMPTY_HOOK_FRAME', severity: 'error', message: 'blank first frame', fixHint: 'design the 0s state' }],
      },
      current_candidate: candidate,
      production_state: {
        stage: 'draft_blocked',
        next_allowed_ops: ['composition.inspect'],
        plan_approval: { gate: 'B', signature: 'sig', approved_at: 'now' },
        current_candidate: candidate,
        // Journal and history entries at their real weight: an entry carries an
        // op, a status, the turn, and the findings file it wrote.
        operation_journal: Array.from({ length: 40 }, (_, i) => ({
          op: 'composition.snapshot', status: 'failed', turn_id: `turn-${i}`, findings_path: bulk(220),
        })),
        history: Array.from({ length: 40 }, (_, i) => ({ op: 'composition.draft', turn: i, detail: bulk(220) })),
        visual_qa: { cycle: { status: 'active' } },
      },
      review_package: {
        status: 'blocked',
        conclusion: { summary: 'repair the first frame' },
        primary_artifact: '/ws/render/main-draft.mp4',
        artifacts: Array.from({ length: 30 }, (_, i) => ({ path: `/ws/a${i}.png`, detail: bulk(280) })),
      },
    } as any;

    const before = JSON.stringify(blocked).length;
    expect(before).toBeGreaterThan(40_000);
    const compact = mod.compactQaBlockedVideoStudioResult(blocked) as any;
    const after = JSON.stringify(compact).length;
    // The whole point: the result no longer needs the spill path.
    expect(after).toBeLessThan(QA_INLINE_SAFE_CHARS);

    // What a repair actually uses survives.
    expect(compact.video_qa.issues[0]).toMatchObject({ code: 'EMPTY_HOOK_FRAME', fixHint: expect.any(String) });
    expect(compact.current_candidate.locators.draft_path).toBe('/ws/render/main-draft.mp4');
    expect(compact.current_candidate.revision_id).toBe('candidate-r7');
    expect(compact.production_state).toMatchObject({
      stage: 'draft_blocked',
      next_allowed_ops: ['composition.inspect'],
    });
    expect(compact.production_state.plan_approval).toMatchObject({ gate: 'B', signature: 'sig' });
    expect(compact.review_package).toMatchObject({
      status: 'blocked',
      primary_artifact: '/ws/render/main-draft.mp4',
    });

    // What it never needed is gone, and bounded lists say what they dropped.
    // A candidate's live locators are the reviewable paths, so its frozen-store
    // copies and the private store's index go.
    expect(compact.current_candidate.snapshot.locators).toBeUndefined();
    expect(compact.current_candidate.snapshot.root_path).toBe('/store');
    expect(compact.current_candidate.snapshot.source_index).toBeUndefined();
    expect(compact.current_candidate.artifacts).toBeUndefined();
    expect(compact.production_state.current_candidate).toBeUndefined();
    expect(compact.production_state.operation_journal).toHaveLength(6);
    expect(compact.production_state.history).toHaveLength(6);
    expect(compact.review_package.artifacts).toHaveLength(8);
    expect(compact.review_package.artifacts_omitted).toBe(22);

    // The original object is not mutated — callers persist the full result.
    expect(JSON.stringify(blocked).length).toBe(before);
  });

  it('compacts a SUCCESS result that carries blockers or an oversized findings blob', async () => {
    // 2026-08-06, second miss: composition.inspect returns ok:true with
    // status "review_required", blocking_error_count 1, and `findings` as a
    // ~68KB pretty-printed JSON STRING. It never matched the ok:false
    // trigger, spilled to disk, and the model burned eight minutes on six
    // searches plus a chunk read hunting the one error inside its own result.
    const mod = await import('../../../../src/main/model/core-agent/video-studio-tool');
    const bulkIssues = [
      {
        code: 'TEXT_BOX_OVERFLOW',
        severity: 'error',
        sceneId: 's2_body',
        selector: '.claim',
        message: 'copy overflows its box',
        fixHint: 'shorten the line or raise the box',
        evidence: { rect: 'x'.repeat(1500) },
      },
      ...Array.from({ length: 25 }, (_, i) => ({
        code: 'TEXT_DENSITY_HIGH',
        severity: 'warning',
        sceneId: `s${i}`,
        message: 'advisory noise',
        evidence: { detail: 'y'.repeat(1200) },
      })),
    ];
    const reviewRequired = {
      ok: true,
      op: 'composition.inspect',
      status: 'review_required',
      blocking_error_count: 1,
      fatal_error_count: 0,
      preview_capture_allowed: true,
      findings: JSON.stringify({
        ok: false,
        errorCount: 1,
        warningCount: 25,
        issueCount: 26,
        issues: bulkIssues,
        samples: Array.from({ length: 9 }, (_, i) => ({ path: `/f/${i}.png`, blob: 'z'.repeat(1500) })),
        sample_plan: Array.from({ length: 9 }, (_, i) => ({ label: `p${i}`, detail: 'w'.repeat(800) })),
        preflight: { report: 'v'.repeat(4000) },
      }, null, 2),
      inspect_disposition: {
        blocking_error_count: 1,
        advisory_count: 25,
        blocking_issues: [{ code: 'TEXT_BOX_OVERFLOW', severity: 'error', message: 'copy overflows its box' }],
        advisory_issues: [],
      },
      next_allowed_ops: ['composition.snapshot'],
    } as any;

    const compact = mod.compactQaBlockedVideoStudioResult(reviewRequired) as any;
    expect(JSON.stringify(compact).length).toBeLessThan(JSON.stringify(reviewRequired).length / 4);
    // The one blocker survives with its fix hint, and it comes FIRST — the
    // advisory tail must never push a blocker past the cap.
    expect(compact.findings.issues[0]).toEqual(
      expect.objectContaining({ code: 'TEXT_BOX_OVERFLOW', severity: 'error', fixHint: expect.any(String) }),
    );
    // 25 warnings, bounded to 8, so 17 are reported as dropped.
    expect(compact.findings.issues.filter((issue: any) => issue.severity === 'warning')).toHaveLength(8);
    expect(compact.findings.issues_omitted).toBe(17);
    expect(compact.findings.errorCount).toBe(1);
    // inspect's own bounded verdict is the repair material and stays.
    expect(compact.inspect_disposition.blocking_issues).toHaveLength(1);
    // Control-flow fields a caller acts on are untouched.
    expect(compact).toMatchObject({
      ok: true,
      status: 'review_required',
      blocking_error_count: 1,
      preview_capture_allowed: true,
      next_allowed_ops: ['composition.snapshot'],
    });

    // A clean, oversized findings payload compacts on size alone — a passing
    // inspect returns the same blob and should not spill either.
    const passingButHuge = {
      ...reviewRequired,
      status: 'passed',
      blocking_error_count: 0,
      inspect_disposition: undefined,
    } as any;
    const compactPass = mod.compactQaBlockedVideoStudioResult(passingButHuge) as any;
    expect(JSON.stringify(compactPass).length).toBeLessThan(QA_INLINE_SAFE_CHARS);

    // Unparseable findings degrade to a note instead of throwing.
    const broken = mod.compactQaBlockedVideoStudioResult({
      ok: true,
      op: 'composition.inspect',
      blocking_error_count: 1,
      findings: '{ not json',
    } as any) as any;
    expect(broken.findings).toMatchObject({ omitted_chars: expect.any(Number) });
  });

  it('projects the durable-state echo on ordinary working results; status alone returns it whole', async () => {
    // Measured over the 2026-08-06 case run: 29 native calls, ~43KB each,
    // ok:true included — production_state alone was 32KB of every lint,
    // reconcile and snapshot result, all of it state the model had already
    // been handed. 14 of the run's 96 tool calls were tool_result_search
    // digging through spilled copies. A working result answers "what did this
    // call do"; the full picture is what composition.status is FOR.
    const mod = await import('../../../../src/main/model/core-agent/video-studio-tool');
    const bulk = (n: number) => 'x'.repeat(n);
    const candidate = {
      revision_id: 'candidate-r3',
      locators: { html_path: '/ws/index.html', preview_path: '/ws/preview/contact-sheet.png' },
      snapshot: {
        root_path: '/store',
        manifest_path: '/store/m.json',
        locators: { preview_path: '/store/frozen-sheet.png' },
        source_index: bulk(5000),
      },
      artifacts: { manifest_sha256: 'a' },
    };
    const stateEcho = {
      stage: 'preview_ready',
      next_allowed_ops: ['composition.draft'],
      plan_approval: { gate: 'B', signature: 'sig' },
      current_candidate: candidate,
      operation_journal: Array.from({ length: 10 }, (_, i) => ({ operation_id: `op-${i}` })),
      narration_transaction_history: Array.from({ length: 8 }, (_, i) => ({ transaction_id: `tx-${i}` })),
    };
    const okResult = {
      ok: true,
      op: 'composition.lint',
      status: 'passed',
      blocking_error_count: 0,
      current_candidate: candidate,
      production_state: stateEcho,
    } as any;

    const compact = mod.compactQaBlockedVideoStudioResult(okResult) as any;
    expect(compact.production_state.current_candidate).toBeUndefined();
    expect(compact.production_state.operation_journal).toHaveLength(6);
    expect(compact.production_state.narration_transaction_history).toHaveLength(3);
    // The current candidate keeps its live locators; frozen-store copies go.
    expect(compact.current_candidate.locators.preview_path).toBe('/ws/preview/contact-sheet.png');
    expect(compact.current_candidate.snapshot.locators).toBeUndefined();
    // A passing result keeps its non-state payload untouched — no QA
    // compaction, no evidence note.
    expect(compact).toMatchObject({ ok: true, status: 'passed' });
    expect(compact.evidence_note).toBeUndefined();
    // The original object is not mutated — callers persist the full result.
    expect(okResult.production_state.operation_journal).toHaveLength(10);

    // composition.status IS the full picture and passes through by reference.
    const statusResult = { ...okResult, op: 'composition.status' } as any;
    expect(mod.compactQaBlockedVideoStudioResult(statusResult)).toBe(statusResult);
  });

  it('keeps a snapshot that inspect re-confirms, and drops one it outdates', async () => {
    // 2026-08-09: the model snapshotted, then ran inspect again to
    // double-check, and a successful inspect deleted the preview
    // unconditionally — so the next draft answered "this composition
    // requires a passing composition.snapshot", the frames had to be
    // re-captured (the most expensive operation here), and the precise
    // staleness message could never fire because the evidence was gone
    // before it could speak. Inspect normally precedes the snapshot, where
    // dropping an older preview is right; the same visual signature the
    // draft checks decides it now.
    const mod = await import('../../../../src/main/model/core-agent/video-studio-tool');
    const stateMod = await import('../../../../src/main/features/video_studio_state');
    const videoStudio = await import('../../../../src/main/features/video_studio');
    const ctx = { workingDir: workspace, state: {} } as any;
    const opts = {
      userId: UID, cid: 'cid-inspect-keep', turnId: 'turn-recheck',
      agentId: VIDEO_STUDIO_AGENT_ID, agentName: 'VideoStudio',
      userMessage: '<msg from="user">继续</msg>',
    };
    // inspect needs a signed plan like any production operation.
    await mod.createVideoStudioTool({ ...opts, userMessage: approvalSubmission('gate_b_decision', 'approve') })
      .execute({
        op: 'composition.approve_plan',
        composition_dir: 'project/composition',
        decision_evidence: decisionEvidence('plan', 'approve', '确认'),
      }, ctx);
    const statePath = mod.videoStudioProductionStatePath(opts, compositionDir);
    const visual = await mod.videoStudioVisualCompositionSignature(compositionDir);
    const framePath = path.join(compositionDir, 'preview', '01-first-frame.png');
    fs.mkdirSync(path.dirname(framePath), { recursive: true });
    fs.writeFileSync(framePath, 'png');
    await mod.recordVideoStudioGate(statePath, 'preview', compositionDir, 'turn-capture', {
      preview_ready: true,
      preview_qa: { ok: true, error_count: 0 },
      preflight: { status: 'passed', blocking_error_count: 0 },
      frame_paths: [framePath],
    });
    await stateMod.updateVideoProductionState(statePath, compositionDir, (next) => {
      if (next.preview) next.preview.visual_signature = visual;
    });
    vi.spyOn(videoStudio, 'inspectComposition').mockResolvedValue({
      ok: true, op: 'composition.inspect', status: 'passed', blocking_error_count: 0, issues: [],
    } as any);
    const inspect = (turnId: string) => mod.createVideoStudioTool({ ...opts, turnId })
      .execute({ op: 'composition.inspect', composition_dir: 'project/composition' }, ctx);

    // A passing inspect over unchanged bytes keeps the frames.
    expect((await inspect('turn-recheck')).isError).toBe(false);
    expect((await stateMod.readVideoProductionState(statePath, compositionDir)).preview).toBeTruthy();

    // Authoring changes the visuals, so the next passing inspect drops them.
    const htmlPath = path.join(compositionDir, 'index.html');
    fs.writeFileSync(htmlPath, `${fs.readFileSync(htmlPath, 'utf8')}\n<!-- authored -->`, 'utf8');
    expect((await inspect('turn-after-edit')).isError).toBe(false);
    expect((await stateMod.readVideoProductionState(statePath, compositionDir)).preview).toBeUndefined();
  });

  it('does not report the same blocking finding twice', async () => {
    // A preflight carries its findings in more than one place — the result's
    // own `issues` and the same array again under `report` — and the walker
    // that gathers blocking findings visited both. 2026-08-09: a run was told
    // it had six problems when it had three, every repair line printed twice,
    // against a QA_COMPACT_MAX_ISSUES budget that then held half as much real
    // material.
    const mod = await import('../../../../src/main/model/core-agent/video-studio-tool');
    const finding = (code: string, selector: string, message: string) => ({
      code, selector, message, severity: 'error', fixHint: `fix ${code}`,
    });
    const shared = [
      finding('SCENE_DEPTH_LAYERS_MISSING', 'manifest#art_direction.scenes', 'depth layers missing for s2'),
      finding('SEMANTIC_ROLE_HOOKS_MISSING', 'index.html', 'no data-role hooks'),
    ];
    const blocked = {
      ok: false,
      op: 'composition.inspect',
      errorCode: 'E_PREFLIGHT_BLOCKED',
      blocking_error_count: 2,
      preflight: {
        status: 'failed',
        issues: shared,
        // The same findings again, as the real payload carries them.
        report: { issues: shared.map((issue) => ({ ...issue })) },
      },
    } as any;

    const compact = mod.compactQaBlockedVideoStudioResult(blocked) as any;
    const codes = (compact.preflight.error_issues as Array<{ code: string }>).map((issue) => issue.code);
    expect(codes).toEqual(['SCENE_DEPTH_LAYERS_MISSING', 'SEMANTIC_ROLE_HOOKS_MISSING']);

    // Two genuinely different findings sharing a code are both kept — the key
    // is what a reader tells apart, not the code alone.
    const twoScenes = {
      ...blocked,
      preflight: {
        status: 'failed',
        issues: [
          finding('SCENE_DEPTH_LAYERS_MISSING', 'manifest#art_direction.scenes', 'depth layers missing for s2'),
          finding('SCENE_DEPTH_LAYERS_MISSING', 'manifest#art_direction.scenes', 'depth layers missing for s3'),
        ],
      },
    } as any;
    expect((mod.compactQaBlockedVideoStudioResult(twoScenes) as any).preflight.error_issues)
      .toHaveLength(2);
  });

  it('summarizes a PASSING draft report the host just wrote to disk', async () => {
    // 2026-08-08 run: five passing composition.draft results at ~100K chars
    // each — report alone 61K, holding per-frame samples, render frame
    // evidence, passing inspect findings, and video_qa/design_review_inputs a
    // second time each under steps. Every one of the five PASSING results
    // exceeded the tool-result cap, so the model received search refs where
    // verdicts should have been, and the turn compacted three times. The
    // failing paths were already projected; this pins the passing path.
    const mod = await import('../../../../src/main/model/core-agent/video-studio-tool');
    const bulk = (n: number) => 'x'.repeat(n);
    const fullReport = {
      report_path: '/ws/project/render/s2-draft-report.json',
      steps: {
        preflight: { status: 'passed', issues: [bulk(2000)] },
        lint: { ok: true },
        inspect: { ok: true, findings: [bulk(7000)] },
        render: { ok: true, frame_evidence: { samples: [bulk(9000)] } },
        video_qa: { ok: true, samples: [bulk(8000)] },
        // Data stored beside steps: no verdict, not a step. The top-level
        // result already carries it once; the summary must not re-list it.
        design_review_inputs: { first_frame: '/f/0.png' },
      },
      video_qa: {
        ok: true,
        issue_count: 1,
        error_count: 0,
        warning_count: 1,
        samples: [bulk(4000), bulk(4000)],
        issues: [{ code: 'AUDIO_TIMING_ESTIMATE_SKIPPED', severity: 'warning' }],
      },
      design_review_inputs: { first_frame: '/f/0.png' },
    };
    const passingDraft = {
      ok: true,
      op: 'composition.draft',
      path: '/ws/project/parts/s2.mp4',
      report_path: '/ws/project/render/s2-draft-report.json',
      report: fullReport,
      design_review_inputs: { first_frame: '/f/0.png' },
      production_state: { stage: 'draft_ready', next_allowed_ops: [] },
    } as any;

    const compact = mod.compactQaBlockedVideoStudioResult(passingDraft) as any;
    // The verdict survives, the bulk points at the disk copy.
    expect(compact.report.steps).toEqual({
      preflight: 'passed', lint: 'ok', inspect: 'ok', render: 'ok', video_qa: 'ok',
    });
    expect(compact.report.video_qa).toMatchObject({
      ok: true, issue_count: 1, warning_count: 1, sample_count: 2,
      issues: [{ code: 'AUDIO_TIMING_ESTIMATE_SKIPPED', severity: 'warning' }],
    });
    expect(compact.report.note).toContain('report_path');
    // The note must not read as an invitation to load the file. 2026-08-09:
    // a bare "the rest is at report_path" got a 311,495-character report
    // pulled back in one read_file — larger than the inline report this
    // projection had just removed.
    expect(compact.report.note).toMatch(/reading it whole costs more/);
    expect(compact.report.note).toMatch(/search or seek/);
    expect(JSON.stringify(compact.report).length).toBeLessThan(1500);
    // This kept the top-level copy on the theory that design review consumes
    // it. No review is open on a passing draft — `design_review_required` is
    // false, or absent on export — and the same bytes are in the file named
    // one line above. Measured on 2026-08-10 it was 24% of both payloads and
    // pushed three of six drafts, and export outright, past their budgets. A
    // review that IS open still keeps its inputs; that case is pinned in
    // 'drops the design-review inputs from a passing render that opens no
    // review'.
    expect(compact.design_review_inputs).toBeUndefined();
    expect(String(compact.design_review_inputs_note)).toContain('report_path');
    // The caller persists the full result — the original is not mutated.
    expect(passingDraft.report.steps.inspect.findings).toHaveLength(1);

    // Negative control: no report_path on disk means the inline report is the
    // only copy, and a projection that dropped it would destroy the report.
    const noDiskCopy = { ...passingDraft, report_path: undefined } as any;
    expect((mod.compactQaBlockedVideoStudioResult(noDiskCopy) as any).report.steps.render.frame_evidence)
      .toBeDefined();

    // Negative control: a FAILING draft keeps its existing projection — the
    // report is dropped entirely and the error issues carry the repair
    // material (pinned by the qa_blocked cases above), never the summary.
    const failingDraft = {
      ...passingDraft,
      ok: false,
      errorCode: 'E_DRAFT_VIDEO_QA_FAILED',
      findings: [{ code: 'CONTENT_CLIPPED', severity: 'error' }],
    } as any;
    const failed = mod.compactQaBlockedVideoStudioResult(failingDraft) as any;
    expect(failed.report).toBeUndefined();
  });


  it('records user-authorized QA waivers and fails closed on bad requests', async () => {
    // "跳过这个检测" is a user decision: the codes arrive with the user's
    // verbatim current-turn quote, persist on the production, and every later
    // QA phase reports them as informational. Anything less fails closed
    // without writing state.
    const mod = await import('../../../../src/main/model/core-agent/video-studio-tool');
    const stateMod = await import('../../../../src/main/features/video_studio_state');
    const ctx = { workingDir: workspace, state: {} } as any;
    const opts = {
      userId: UID,
      cid: 'cid-qa-waiver',
      turnId: 'turn-qa-waiver',
      agentId: VIDEO_STUDIO_AGENT_ID,
      agentName: 'VideoStudio',
      userMessage: '<msg from="user">封面那两条检查跳过，就按现在的画面继续。</msg>',
    };
    const statePath = mod.videoStudioProductionStatePath(opts, compositionDir);
    const waiverEvidence = {
      source: 'user_message',
      gate: 'qa_waiver',
      decision: 'approve',
      quote: '封面那两条检查跳过，就按现在的画面继续。',
    };

    // Evidence-integrity codes are refused outright.
    const nonWaivable = await mod.createVideoStudioTool(opts).execute({
      op: 'composition.lint',
      composition_dir: 'project/composition',
      waive_qa_findings: ['VIDEO_SAMPLE_FRAMES_MISSING'],
      decision_evidence: waiverEvidence,
    }, ctx);
    expect(nonWaivable.isError).toBe(true);
    expect(String(nonWaivable.content)).toContain('E_QA_WAIVER_NOT_ALLOWED');

    // A waiver without user evidence is not a waiver.
    const noEvidence = await mod.createVideoStudioTool(opts).execute({
      op: 'composition.lint',
      composition_dir: 'project/composition',
      waive_qa_findings: ['COVER_CONTENT_SIGNALS_NOT_VISIBLE'],
    }, ctx);
    expect(noEvidence.isError).toBe(true);
    expect(String(noEvidence.content)).toContain('E_QA_WAIVER_EVIDENCE_REQUIRED');

    // A quote the user never said this turn is rejected by provenance.
    const wrongQuote = await mod.createVideoStudioTool(opts).execute({
      op: 'composition.lint',
      composition_dir: 'project/composition',
      waive_qa_findings: ['COVER_CONTENT_SIGNALS_NOT_VISIBLE'],
      decision_evidence: { ...waiverEvidence, quote: '模型自己编的授权' },
    }, ctx);
    expect(wrongQuote.isError).toBe(true);
    expect(String(wrongQuote.content)).toContain('quote_not_in_current_turn');
    expect((await stateMod.readVideoProductionState(statePath, compositionDir)).qa_waivers)
      .toBeUndefined();

    // The real thing: codes recorded once, deduplicated, with the quote.
    await mod.createVideoStudioTool(opts).execute({
      op: 'composition.lint',
      composition_dir: 'project/composition',
      waive_qa_findings: [
        'COVER_CONTENT_SIGNALS_NOT_VISIBLE',
        'COVER_HERO_NOT_VISIBLE',
        'COVER_CONTENT_SIGNALS_NOT_VISIBLE',
      ],
      decision_evidence: waiverEvidence,
    }, ctx);
    const recorded = (await stateMod.readVideoProductionState(statePath, compositionDir)).qa_waivers;
    expect(recorded?.map((waiver) => waiver.code).sort()).toEqual([
      'COVER_CONTENT_SIGNALS_NOT_VISIBLE',
      'COVER_HERO_NOT_VISIBLE',
    ]);
    expect(recorded?.every((waiver) => waiver.quote === '封面那两条检查跳过，就按现在的画面继续。')).toBe(true);

    // Re-waiving an already-recorded code stays a single entry.
    await mod.createVideoStudioTool({ ...opts, turnId: 'turn-qa-waiver-2' }).execute({
      op: 'composition.lint',
      composition_dir: 'project/composition',
      waive_qa_findings: ['COVER_HERO_NOT_VISIBLE'],
      decision_evidence: waiverEvidence,
    }, ctx);
    expect((await stateMod.readVideoProductionState(statePath, compositionDir)).qa_waivers)
      .toHaveLength(2);
  });

  it('carries the parent EDL linkage through a re-signed plan approval', async () => {
    // Being a segment of a parent plan is structural identity. 2026-08-06: a
    // mid-run amendment re-signed four child approvals without resolving the
    // parent again, the linkage fields vanished, and the review drawer
    // scattered one assembled video into five standalone productions.
    const mod = await import('../../../../src/main/model/core-agent/video-studio-tool');
    const stateMod = await import('../../../../src/main/features/video_studio_state');
    const ctx = { workingDir: workspace, state: {} } as any;
    const opts = {
      userId: UID,
      cid: 'cid-linkage',
      turnId: 'turn-linkage-approve',
      agentId: VIDEO_STUDIO_AGENT_ID,
      agentName: 'VideoStudio',
      userMessage: '确认',
    };
    const approved = await mod.createVideoStudioTool(opts).execute({
      op: 'composition.approve_plan',
      composition_dir: 'project/composition',
      decision_evidence: decisionEvidence('plan', 'approve', '确认'),
    }, ctx);
    expect(approved.isError, String(approved.content)).toBe(false);

    // Inject the inheritance record the gate-control parent resolution writes.
    const statePath = mod.videoStudioProductionStatePath(opts, compositionDir);
    const parentPlanPath = path.join(workspace, 'project', 'plan.json');
    const stateRaw = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    stateRaw.plan_approval.inheritance_reason = 'parent_edl_segment';
    stateRaw.plan_approval.parent_plan_path = parentPlanPath;
    stateRaw.plan_approval.parent_segment_id = 'intro';
    fs.writeFileSync(statePath, JSON.stringify(stateRaw), 'utf8');
    const signatureBefore = stateRaw.plan_approval.signature as string;

    // A user-instructed amendment re-signs the plan without any parent
    // resolution in the call — the exact writer that used to drop the link.
    const instruction = '标题改成品牌口号';
    const manifestPath = path.join(compositionDir, 'composition-manifest.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    manifest.scenes[0].approved_copy = ['品牌口号'];
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');
    const resigned = await mod.createVideoStudioTool({
      ...opts,
      turnId: 'turn-linkage-amend',
      userMessage: `<msg from="user">${instruction}</msg>`,
    }).execute({
      op: 'composition.approve_plan',
      composition_dir: 'project/composition',
      expected_plan_change: true,
      decision_evidence: decisionEvidence('plan', 'revise', instruction),
    }, ctx);
    expect(resigned.isError, String(resigned.content)).toBe(false);

    const after = await stateMod.readVideoProductionState(statePath, compositionDir);
    expect(after.plan_approval?.signature).not.toBe(signatureBefore);
    expect(after.plan_approval).toMatchObject({
      inheritance_reason: 'parent_edl_segment',
      parent_plan_path: parentPlanPath,
      parent_segment_id: 'intro',
    });
    // The stale inherited-signature audit fields belong to the approval that
    // actually inherited; a re-sign must not fabricate them.
    expect(after.plan_approval?.inherited_from_signature).toBeUndefined();
  });

  it('keeps every narration operation inert on an assembler-owned segment', async () => {
    // The silence contract has three doors, and 2026-08-04 walked through two
    // of them. approve_plan is guarded; these are the other two: the free fit
    // check must not answer "sign an audio.narration_intent" (the instruction
    // that made a silent segment sign a voice), and materialize must not bake
    // a second narration into a segment the parent will mix over — with a v1
    // manifest and a legacy voice parameter it previously reached synthesis.
    const mod = await import('../../../../src/main/model/core-agent/video-studio-tool');
    const ctx = { workingDir: workspace, state: {} } as any;
    // Script and shotlist carry the same narration line so the plan-alignment
    // requirements pass; the point under test is the audio ownership.
    fs.writeFileSync(path.join(workspace, 'project', 'script.md'), '# Approved script\n\nOne approved line.', 'utf8');
    const shotlistPath = path.join(workspace, 'project', 'shotlist.json');
    const shotlist = JSON.parse(fs.readFileSync(shotlistPath, 'utf8'));
    shotlist.audio_mode = 'narration';
    shotlist.shots[0].narration = 'One approved line.';
    fs.writeFileSync(shotlistPath, JSON.stringify(shotlist), 'utf8');
    const manifestPath = path.join(compositionDir, 'composition-manifest.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    manifest.scenes[0].narration_text = 'One approved line.';
    manifest.audio = { owner: 'assembler', tracks: [] };
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');

    const tool = mod.createVideoStudioTool({
      userId: UID,
      cid: 'cid-assembler-inert',
      turnId: 'turn-assembler-inert',
      agentId: VIDEO_STUDIO_AGENT_ID,
      agentName: 'VideoStudio',
      userMessage: '确认',
    });
    const planned = await tool.execute({
      op: 'composition.approve_plan',
      composition_dir: 'project/composition',
      decision_evidence: decisionEvidence('plan', 'approve', '确认'),
    }, ctx);
    expect(planned.isError, String(planned.content)).toBe(false);

    const fit = await tool.execute({
      op: 'composition.check_narration_fit',
      composition_dir: 'project/composition',
    }, ctx);
    expect(fit.isError, String(fit.content)).toBe(false);
    const fitPayload = parseResult(String(fit.content));
    expect(fitPayload).toMatchObject({ status: 'not_applicable', gate_b_ready: true });
    expect(fitPayload.message).not.toContain('narration_intent selected from speech.capabilities');
    expect(fitPayload.message).toMatch(/parent production owns narration/);

    const materialized = await tool.execute({
      op: 'composition.materialize_narration',
      composition_dir: 'project/composition',
      voice: 'legacy-voice',
    }, ctx);
    expect(materialized.isError).toBe(true);
    const materializedPayload = parseResult(String(materialized.content));
    expect(materializedPayload.errorCode).toBe('E_NARRATION_NOT_OWNED');
    expect(materializedPayload.billable_request_sent).toBe(false);
    expect(ttsMock.generateSpeech).not.toHaveBeenCalled();
  });

  it('never names a next_action that looks like an operation but is not one', async () => {
    // Protocol inventory, 2026-08-09: four next_action / op strings were
    // shaped exactly like real operations (`namespace.verb`) while being no
    // operation at all — production.segment_qa_inspect, .segment_qa_snapshot,
    // .status_then_continue_assembly, composition.recover_narration_invariant.
    // Every other hint is a phrase a caller cannot mistake for a call. gpt-5.5
    // read the intent and called segment_qa with a phase; a literal caller
    // would have called something that does not exist. Hints are phrases.
    const mod = await import('../../../../src/main/model/core-agent/video-studio-tool');
    const hints = [
      mod.productionSegmentQaOutcome({ phase: 'lint', failed: [], checkedCount: 2, uncaptured: [] }).next_action,
      mod.productionSegmentQaOutcome({ phase: 'inspect', failed: [], checkedCount: 2, uncaptured: [] }).next_action,
      mod.productionSegmentQaOutcome({ phase: 'snapshot', failed: [], checkedCount: 2, uncaptured: [] }).next_action,
      mod.productionSegmentQaOutcome({ phase: 'snapshot', failed: ['a'], checkedCount: 2, uncaptured: [] }).next_action,
      mod.productionSegmentQaOutcome({ phase: 'snapshot', failed: [], checkedCount: 2, uncaptured: ['a'] }).next_action,
    ];
    for (const hint of hints) {
      expect(hint, `next_action "${hint}" is shaped like an operation`)
        .not.toMatch(/^(composition|production|speech)\.[a-z_]+$/);
    }
    // And the phase hints still say which phase to run next.
    expect(hints[0]).toContain('inspect');
    expect(hints[1]).toContain('snapshot');
  });

  it('does not send the model to the preview stop while a segment is unproduced', async () => {
    // 2026-08-08 driven run: five compositions captured, one edit segment
    // with no produced file. The snapshot batch answered "snapshot passed for
    // all 5" + next_action open_production_preview_review, while correctly
    // withholding the whole-video contact sheet — it cannot be composed until
    // every segment has frames. The model opened the stop as instructed and
    // the user got "The visual preview is ready" with nothing to look at.
    const mod = await import('../../../../src/main/model/core-agent/video-studio-tool');
    const ready = mod.productionSegmentQaOutcome({
      phase: 'snapshot', failed: [], checkedCount: 5, uncaptured: [],
    });
    expect(ready.next_action).toBe('open_production_preview_review');

    const notReady = mod.productionSegmentQaOutcome({
      phase: 'snapshot', failed: [], checkedCount: 5, uncaptured: ['s3_source_motion'],
    });
    expect(notReady.next_action).toBe('produce_uncaptured_segments_then_recheck');
    // The message names what is missing and what each kind of segment needs,
    // so the reply is not "passed" with a contradiction hidden underneath.
    expect(notReady.message).toContain('s3_source_motion');
    expect(notReady.message).toContain('produced_path');
    expect(notReady.message).not.toMatch(/^snapshot passed for all 5 checked segment\(s\)\.$/);

    // A failure still outranks readiness — repair first.
    expect(mod.productionSegmentQaOutcome({
      phase: 'snapshot', failed: ['body'], checkedCount: 5, uncaptured: ['s3_source_motion'],
    }).next_action).toBe('repair_failed_segments_then_recheck');
    // Earlier phases are unaffected: uncaptured segments are the normal state
    // before snapshot, and lint/inspect chain on regardless.
    expect(mod.productionSegmentQaOutcome({
      phase: 'lint', failed: [], checkedCount: 5, uncaptured: ['s3_source_motion'],
    }).next_action).toBe('run_segment_qa_inspect_phase');
    expect(mod.productionSegmentQaOutcome({
      phase: 'inspect', failed: [], checkedCount: 5, uncaptured: ['s3_source_motion'],
    }).next_action).toBe('run_segment_qa_snapshot_phase');
  });

  it('runs one QA phase across segments and reports each without repeating the production state', async () => {
    // 2026-08-05: the model issued six-to-eight per-segment QA calls at a time
    // and each returned the whole durable state again — 1084KB of the 1.25MB
    // that run returned, six context compactions, one convergence nudge. The
    // batch must cover the same segments, keep every failure diagnosable, and
    // stop repeating what is identical across them.
    const mod = await import('../../../../src/main/model/core-agent/video-studio-tool');
    const ctx = { workingDir: workspace, state: {} } as any;
    const segmentIds = ['intro', 'body', 'outro'];
    const planPath = writeAutoParentPlan();
    const plan = JSON.parse(fs.readFileSync(planPath, 'utf8'));
    plan.total_target_sec = 15;
    plan.segments = segmentIds.map((id, index) => ({
      ...plan.segments[0],
      id,
      order: index + 1,
      spec: {
        kind: 'title-card',
        composition_plan: {
          scenes: [{ id, approved_copy: [`Approved ${id}`], narration_text: '', roles: ['title', 'visual'] }],
        },
      },
    }));
    fs.writeFileSync(planPath, JSON.stringify(plan, null, 2), 'utf8');

    for (const id of segmentIds) {
      const dir = path.join(workspace, 'project', 'compositions', id);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'script.md'), `# Approved ${id}`, 'utf8');
      fs.writeFileSync(path.join(dir, 'shotlist.json'), JSON.stringify({
        target_duration_seconds: 5,
        video_language: 'en',
        audio_mode: 'visual-only',
        caption_mode: 'none',
        music_mode: 'none',
        shots: [{ id }],
      }), 'utf8');
      fs.writeFileSync(path.join(dir, 'composition-manifest.json'), JSON.stringify({
        schema_version: 1,
        composition: { id, width: 1920, height: 1080, duration: 5, target_duration: 5, fps: 30, language: 'en' },
        scenes: [{
          id, start: 0, duration: 5, approved_copy: [`Approved ${id}`],
          narration_text: '', narration_refs: [], source_shots: [id], roles: ['title', 'visual'],
        }],
        audio: { owner: 'none', tracks: [] },
      }, null, 2), 'utf8');
      fs.writeFileSync(path.join(dir, 'index.html'), [
        '<!doctype html><html><body>',
        `<main data-composition-id="${id}" data-width="1920" data-height="1080" data-duration="5">`,
        `<section class="clip" data-scene-id="${id}" data-start="0" data-duration="5">`,
        `<h1 data-role="title">Approved ${id}</h1>`,
        '</section></main></body></html>',
      ].join('\n'), 'utf8');
    }

    await mod.createVideoStudioTool({
      userId: UID,
      cid: 'cid-batch-parent',
      turnId: 'turn-batch-gate-b',
      agentId: VIDEO_STUDIO_AGENT_ID,
      agentName: 'VideoStudio',
      userMessage: approvalSubmission('gate_b_decision', 'approve'),
    }).execute({ op: 'production.approve_plan', plan_path: 'project/plan.json' }, ctx);

    for (const id of segmentIds) {
      await mod.createVideoStudioTool({
        userId: UID,
        cid: `cid-batch-${id}`,
        turnId: `turn-batch-${id}`,
        agentId: VIDEO_STUDIO_AGENT_ID,
        agentName: 'VideoStudio',
        userMessage: '<msg from="user">later turn</msg>',
      }).execute({
        op: 'composition.approve_plan',
        composition_dir: `project/compositions/${id}`,
        plan_path: 'project/plan.json',
        segment_id: id,
      }, ctx);
    }

    const tool = mod.createVideoStudioTool({
      userId: UID,
      cid: 'cid-batch-parent',
      turnId: 'turn-batch-qa',
      agentId: VIDEO_STUDIO_AGENT_ID,
      agentName: 'VideoStudio',
      userMessage: '继续',
    });

    // Default scope comes from the ledger: nothing is approved yet, so every
    // segment is uncaptured and therefore in scope.
    const batch = parseResult(String((await tool.execute({
      op: 'production.segment_qa',
      plan_path: 'project/plan.json',
      phase: 'lint',
    }, ctx)).content));
    expect(batch.checked_segment_ids).toEqual(segmentIds);
    expect(batch.segments.map((s: any) => s.segment_id)).toEqual(segmentIds);

    // Differential: the batch reports the same per-segment verdict a single
    // call reports for the same composition.
    for (const id of segmentIds) {
      const single = parseResult(String((await tool.execute({
        op: 'composition.lint',
        composition_dir: `project/compositions/${id}`,
      }, ctx)).content));
      const fromBatch = batch.segments.find((s: any) => s.segment_id === id);
      expect(fromBatch.ok, id).toBe(single.ok);
    }

    // The state repeated per segment is what filled the context: the batch
    // carries the production ledger once and no per-segment production_state.
    for (const segment of batch.segments) {
      expect(segment.production_state, segment.segment_id).toBeUndefined();
      expect(segment.candidate_history, segment.segment_id).toBeUndefined();
    }
    expect(JSON.stringify(batch).length)
      .toBeLessThan(segmentIds.length * 4000);

    // An explicit list overrides the ledger default; an unknown id is named
    // rather than silently dropped.
    const targeted = parseResult(String((await tool.execute({
      op: 'production.segment_qa',
      plan_path: 'project/plan.json',
      phase: 'lint',
      segment_ids: ['body', 'not_a_segment'],
    }, ctx)).content));
    expect(targeted.checked_segment_ids).toEqual(['body']);
    expect(targeted.unknown_segment_ids).toEqual(['not_a_segment']);

    // Isolation, measured against this fixture's own baseline rather than an
    // assumption that a fresh child lints clean: breaking ONE segment may
    // change only that segment's outcome, and every segment must still be
    // reported. That is the rule that keeps a batch from hiding siblings.
    const baseline = parseResult(String((await tool.execute({
      op: 'production.segment_qa',
      plan_path: 'project/plan.json',
      phase: 'lint',
      segment_ids: segmentIds,
    }, ctx)).content));
    const baselineOk = new Map(baseline.segments.map((s: any) => [s.segment_id, s.ok]));

    fs.writeFileSync(
      path.join(workspace, 'project', 'compositions', 'body', 'composition-manifest.json'),
      '{ not valid json',
      'utf8',
    );
    const partial = parseResult(String((await tool.execute({
      op: 'production.segment_qa',
      plan_path: 'project/plan.json',
      phase: 'lint',
      segment_ids: segmentIds,
    }, ctx)).content));
    expect(partial.ok).toBe(false);
    expect(partial.checked_segment_ids).toEqual(segmentIds);
    expect(partial.failed_segment_ids).toContain('body');
    const failedSegment = partial.segments.find((s: any) => s.segment_id === 'body');
    expect(failedSegment.ok).toBe(false);
    // A failure stays fully diagnosable.
    expect(failedSegment.findings || failedSegment.message || failedSegment.error_code).toBeTruthy();
    for (const id of ['intro', 'outro']) {
      const sibling = partial.segments.find((s: any) => s.segment_id === id);
      expect(sibling, id).toBeDefined();
      expect(sibling.ok, id).toBe(baselineOk.get(id));
      if (sibling.ok) expect(sibling.findings, id).toBeUndefined();
    }
    expect(partial.message).toMatch(/Repair those segments only/);

    const badPhase = await tool.execute({
      op: 'production.segment_qa',
      plan_path: 'project/plan.json',
      phase: 'draft',
    }, ctx);
    expect(badPhase.isError).toBe(true);
    expect(String(badPhase.content)).toContain('E_SEGMENT_QA_PHASE_REQUIRED');
  });

  it('gives an assembled segment no user gate of its own', async () => {
    // Reported 2026-08-05: the user asked for one scene's background colour to
    // match the previous shot, and VideoStudio answered with a preview
    // confirmation for that scene. The model was doing what the host offered —
    // a segment's snapshot advertised composition.approve_preview in
    // next_allowed_ops — so the fix has to be that the host stops offering it
    // and refuses it, not only that the skill discourages it.
    const mod = await import('../../../../src/main/model/core-agent/video-studio-tool');
    const stateMod = await import('../../../../src/main/features/video_studio_state');
    const ctx = { workingDir: workspace, state: {} } as any;
    writeAutoParentPlan();
    const child = writeAutoChildComposition();

    await mod.createVideoStudioTool({
      userId: UID,
      cid: 'cid-segment-gate-parent',
      turnId: 'turn-segment-gate-b',
      agentId: VIDEO_STUDIO_AGENT_ID,
      agentName: 'VideoStudio',
      userMessage: approvalSubmission('gate_b_decision', 'approve'),
    }).execute({ op: 'production.approve_plan', plan_path: 'project/plan.json' }, ctx);

    const opts = {
      userId: UID,
      cid: 'cid-segment-gate-child',
      turnId: 'turn-segment-gate-child',
      agentId: VIDEO_STUDIO_AGENT_ID,
      agentName: 'VideoStudio',
      userMessage: '<msg from="user">later turn</msg>',
    };
    const tool = mod.createVideoStudioTool(opts);
    expect((await tool.execute({
      op: 'composition.approve_plan',
      composition_dir: 'project/compositions/intro',
      plan_path: 'project/plan.json',
      segment_id: 'intro',
    }, ctx)).isError).toBe(false);

    const statePath = mod.videoStudioProductionStatePath(opts, child);
    const visualSignature = await mod.videoStudioVisualCompositionSignature(child);
    await stateMod.updateVideoProductionState(statePath, child, (next) => {
      next.preview = {
        signature: visualSignature,
        visual_signature: visualSignature,
        revision_id: 'rev-intro',
        turn_id: 'turn-segment-gate-child',
        created_at: new Date().toISOString(),
        status: 'ready',
        validation_version: 5,
        frame_paths: ['/tmp/intro/01-first-frame.png'],
      };
    });

    // The host must not advertise a per-segment gate: that list is what the
    // model reads as "you may do this now".
    const status = parseResult(String((await tool.execute({
      op: 'composition.status',
      composition_dir: 'project/compositions/intro',
    }, ctx)).content));
    expect(status.production_state.preview_status).toBe('ready');
    expect(status.production_state.next_allowed_ops).not.toContain('composition.approve_preview');
    expect(status.production_state.next_allowed_ops).not.toContain('composition.approve_draft');

    // And calling a segment's own final-video gate is refused, naming the
    // assembled production as the thing the user actually decides on.
    const perSegment = parseResult(String((await mod.createVideoStudioTool({
      ...opts,
      turnId: 'turn-segment-gate-approve',
      userMessage: '<msg from="user" to="79df9cc89f5f">@VideoStudio 这段可以</msg>',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any).execute({
      op: 'composition.approve_draft',
      composition_dir: 'project/compositions/intro',
      decision_evidence: decisionEvidence('draft', 'approve', '这段可以'),
    }, ctx)).content));
    expect(perSegment.errorCode).toBe('E_SEGMENT_HAS_NO_USER_GATE');
    expect(perSegment.requires_user_decision).toBe(false);
    expect(perSegment.message).toMatch(/reviewed as one video/);
    expect(perSegment.next_action).toMatch(/read_production_status_then_continue_assembly/);
    // A refusal whose point is "do not put this segment to the user" carries no
    // presentation payload either. On 2026-08-09 seven of these arrived in one
    // round, each with a full artifact listing — 65% of 48,237 characters — and
    // all seven spilled past the inline budget, so the sentence above reached
    // the model as a search ref instead of an instruction.
    expect(perSegment.review_package.presentation_required).toBe(false);
    expect(perSegment.review_package.artifacts).toBeUndefined();
    expect(perSegment.review_package.visible_artifact_paths).toBeUndefined();
    expect(perSegment.review_package.primary_artifact).toBeUndefined();
    // What tells the model how to continue survives.
    expect(perSegment.review_package.conclusion).toMatchObject({
      requires_user_decision: false,
      next_step_owner: 'agent',
      next_action: 'read_production_status_then_continue_assembly',
    });
    expect(perSegment.review_package.continuation.user_action_required).toBe(false);
    // The segment's own gate state stays untouched: it is evidence, not a
    // decision anyone recorded.
    expect((await stateMod.readVideoProductionState(statePath, child)).preview?.status).toBe('ready');

    // A standalone COMPOSE keeps its own gate untouched.
    const standalone = parseResult(String((await mod.createVideoStudioTool({
      userId: UID,
      cid: 'cid-standalone-gate',
      turnId: 'turn-standalone-gate',
      agentId: VIDEO_STUDIO_AGENT_ID,
      agentName: 'VideoStudio',
      userMessage: '确认',
    }).execute({ op: 'composition.status', composition_dir: 'project/composition' }, ctx)).content));
    expect(standalone.production_state.next_allowed_ops).toContain('composition.approve_plan');
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
    // Protocol inventory, 2026-08-09: this refusal used to list four
    // candidate fields — copy, narration, scene ids, roles — and leave the
    // caller to find which one drifted, while the host had just compared
    // them. It names the field and both values now.
    expect(String(inherited.content)).toContain('approved_copy');
    expect(String(inherited.content)).toContain('Approved intro');
    expect(String(inherited.content)).toContain('Unapproved replacement');
    expect(String(inherited.content)).not.toMatch(/copy, narration, scene ids, or semantic roles/);
  });

  it('keeps Gate B requirements mandatory and auto-runs doctor when caller identity is absent', async () => {
    const mod = await import('../../../../src/main/model/core-agent/video-studio-tool');
    // The manifest owns the delivery contract, so a broken scene window is
    // what an incomplete plan looks like now.
    const reqManifestPath = path.join(compositionDir, 'composition-manifest.json');
    const reqManifest = JSON.parse(fs.readFileSync(reqManifestPath, 'utf8'));
    reqManifest.scenes[0].start = reqManifest.composition.duration + 5;
    fs.writeFileSync(reqManifestPath, JSON.stringify(reqManifest), 'utf8');

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
      // The result carries the candidate once, at top level; production_state
      // no longer duplicates it (2026-08-07 result projection).
      current_candidate: {
        revision_id: expect.stringMatching(/^candidate-/),
        last_quality_result: {
          ok: false,
          error_code: 'E_VIDEO_PRODUCTION_OPERATION_FAILED',
        },
      },
      production_state: {
        last_operation: {
          op: 'composition.prepare',
          status: 'failed',
          error_code: 'E_VIDEO_PRODUCTION_OPERATION_FAILED',
        },
        operation_journal: [expect.objectContaining({
          op: 'composition.prepare',
          status: 'failed',
          error_code: 'E_VIDEO_PRODUCTION_OPERATION_FAILED',
        })],
      },
    });
    expect(failedPayload.production_state.current_candidate).toBeUndefined();
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
        // The current candidate's live locators above are the reviewable
        // paths; its frozen-store copies leave the payload (2026-08-07
        // result projection) and stay recorded in durable state.
        snapshot: {
          manifest_path: expect.stringMatching(/candidate\.json$/),
          source_file_count: expect.any(Number),
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
    // Frozen-store paths left the payload with the 2026-08-07 result
    // projection; durable state remains their source of truth.
    expect(firstPayload.current_candidate.snapshot.locators).toBeUndefined();
    const stateAfterFirst = await stateMod.readVideoProductionState(statePath, compositionDir);
    const frozenLocators = stateAfterFirst.current_candidate?.snapshot?.locators as Record<string, string>;
    const frozenHtmlPath = frozenLocators.html_path;
    const frozenPreviewPath = frozenLocators.preview_path;
    const frozenFindingsPath = frozenLocators.findings_path;
    expect(frozenHtmlPath).toContain(path.join('source', 'index.html'));
    expect(frozenPreviewPath).toMatch(/contact-sheet-[a-f0-9]{12}\.svg$/);
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
    // The superseded revision is counted for the model and preserved in full on
    // disk. Its entry stopped travelling in the payload once the segment
    // fallback that read it was removed; the frozen copy below is the fact that
    // matters, and it is asserted against durable state.
    expect(thirdPayload.production_state.candidate_history_count).toBeGreaterThan(0);
    expect(thirdPayload.production_state).not.toHaveProperty('candidate_history');
    expect(fs.readFileSync(frozenHtmlPath, 'utf8')).toBe(frozenHtml);
    expect(fs.readFileSync(frozenHtmlPath, 'utf8')).not.toContain('<!-- repaired -->');
    const revisedState = await stateMod.readVideoProductionState(statePath, compositionDir);
    expect(revisedState.candidate_history?.[0]?.snapshot?.locators.html_path).toBe(frozenHtmlPath);

    fs.appendFileSync(path.join(compositionDir, 'index.html'), '\n<!-- repaired again -->\n');
    const fourth = await tool.execute(input, ctx);
    expect(fourth.isError).toBe(true);
    expect(snapshot).toHaveBeenCalledTimes(3);

    // The repair the model wrote while the budget was running out is measured
    // once. It had already written it: the check that would have told it to
    // stop runs at the entry of the call it makes to verify. Handing back the
    // fork here would present pre-repair findings and ask the user to choose
    // between another round and skipping a check while nobody — including the
    // host — knows whether this repair already fixed it (2026-08-08).
    fs.appendFileSync(path.join(compositionDir, 'index.html'), '\n<!-- attempted third repair -->\n');
    const finalRepair = await tool.execute(input, ctx);
    expect(finalRepair.isError).toBe(true);
    expect(finalRepair.content).toContain('E_PREVIEW_QA_BLOCKED');
    expect(snapshot).toHaveBeenCalledTimes(4);

    // One, and bounded by a failure: editing again does not buy another.
    fs.appendFileSync(path.join(compositionDir, 'index.html'), '\n<!-- attempted fourth repair -->\n');
    const exhausted = await tool.execute(input, ctx);
    expect(exhausted.isError).toBe(true);
    expect(exhausted.content).toContain('E_VISUAL_REPAIR_BUDGET_EXCEEDED');
    expect(snapshot).toHaveBeenCalledTimes(4);
    // Budget exhaustion is a creative fork handed to the user. There is no
    // self-service restart to offer any more: "try again" is a thing the user
    // says, and saying it is what buys the next cycle.
    expect(parseResult(exhausted.content)).toMatchObject({
      visual_revision_recovery_available: false,
      recovery_requires_new_user_revision: true,
      requires_user_decision: true,
      next_step_owner: 'user',
      automatic_recovery_expected: false,
      next_action: 'present_findings_and_ask_user_direction',
      user_options: [
        expect.objectContaining({ id: 'guide_revision' }),
        expect.objectContaining({ id: 'simplify_scene' }),
        expect.objectContaining({ id: 'retry_internal' }),
        // Skipping the check is the user's call, and it is exactly what the
        // model faked on 2026-08-07 — so the host must offer it in writing.
        expect.objectContaining({ id: 'waive_findings' }),
      ],
      review_package: {
        presentation_required: true,
        conclusion: {
          outcome: 'quality_not_accepted',
          error_code: 'E_VISUAL_REPAIR_BUDGET_EXCEEDED',
          requires_user_decision: true,
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
    expect(snapshot).toHaveBeenCalledTimes(4);

    const repeatedExhausted = await tool.execute(input, ctx);
    expect(repeatedExhausted.isError).toBe(true);
    expect(parseResult(repeatedExhausted.content)).toMatchObject({
      errorCode: 'E_VISUAL_REPAIR_BUDGET_EXCEEDED',
      requires_user_decision: true,
      next_action: 'present_findings_and_ask_user_direction',
    });
    expect(snapshot).toHaveBeenCalledTimes(4);
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
    // Measured once, across the shared cycle: the repair written while the
    // budget ran out is evaluated by whichever operation verifies it next.
    fs.appendFileSync(path.join(compositionDir, 'index.html'), '\n<!-- attempted repair three -->');
    const finalRepair = await tool.execute({
      op: 'composition.snapshot', composition_dir: 'project/composition', output_path: 'project/composition/preview.png',
    }, ctx);
    expect(finalRepair.isError).toBe(true);
    expect(finalRepair.content).toContain('E_PREVIEW_QA_BLOCKED');

    fs.appendFileSync(path.join(compositionDir, 'index.html'), '\n<!-- attempted repair four -->');
    const exhausted = await tool.execute({
      op: 'composition.snapshot', composition_dir: 'project/composition', output_path: 'project/composition/preview.png',
    }, ctx);

    expect(exhausted.isError).toBe(true);
    expect(exhausted.content).toContain('E_VISUAL_REPAIR_BUDGET_EXCEEDED');
    expect(parseResult(exhausted.content)).toMatchObject({
      visual_revision_recovery_available: false,
      recovery_requires_new_user_revision: true,
      requires_user_decision: true,
      next_action: 'present_findings_and_ask_user_direction',
    });
    expect(parseResult(exhausted.content)).not.toHaveProperty('recovery_action');
    expect(parseResult(exhausted.content)).not.toHaveProperty('recovery_form');
    expect(inspect).toHaveBeenCalledTimes(2);
    expect(snapshot).toHaveBeenCalledTimes(2);
    const state = await stateMod.readVideoProductionState(statePath, compositionDir);
    expect(state.visual_qa?.cycle).toMatchObject({
      inspector_version: 3,
      status: 'exhausted',
      final_repair_measured: true,
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

    // The erroneous final call from the real six-minute trace used to be
    // `composition.begin_visual_revision`. That operation is gone: a newly
    // signed plan clears `visual_qa` on its own, which the assertion above
    // proves, so there is nothing left to reset and nothing to mint a form.
  });

  it('records a blocked snapshot on disk even when no findings_path was asked for', async () => {
    // 2026-08-08: a blocked snapshot wrote nothing, because findings_path is
    // optional and the call omitted it. `qa/snapshot.json` kept the PREVIOUS
    // evening's conclusions — a stale file answers confidently, which is worse
    // than a missing one, and the failing result itself survives only as long
    // as the turn that produced it.
    makePlanVisualOnly();
    const videoStudio = await import('../../../../src/main/features/video_studio');
    const toolMod = await import('../../../../src/main/model/core-agent/video-studio-tool');
    const stateMod = await import('../../../../src/main/features/video_studio_state');
    const opts = {
      userId: UID,
      cid: 'cid-default-findings',
      turnId: 'turn-default-findings',
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
    const findingsPath = path.join(compositionDir, 'qa', 'snapshot.json');
    fs.mkdirSync(path.dirname(findingsPath), { recursive: true });
    fs.writeFileSync(findingsPath, JSON.stringify({ ok: true, verdict: 'from an earlier run' }), 'utf8');
    vi.spyOn(videoStudio, 'snapshotComposition').mockImplementation(async (p: any) => {
      const result = {
        ok: false,
        op: 'composition.snapshot',
        errorCode: 'E_PREVIEW_QA_BLOCKED',
        message: 'Preview frame coverage or scene semantics failed QA.',
        preview_ready: false,
        preview_qa: { ok: false, error_count: 1, issues: [{ code: 'EXPECTED_SCENE_NOT_VISIBLE', severity: 'error' }] },
      };
      if (p.findingsAbsPath) {
        fs.mkdirSync(path.dirname(p.findingsAbsPath), { recursive: true });
        fs.writeFileSync(p.findingsAbsPath, JSON.stringify(result), 'utf8');
      }
      return result as any;
    });

    const blocked = await tool.execute({
      op: 'composition.snapshot',
      composition_dir: 'project/composition',
    }, ctx);

    expect(blocked.isError).toBe(true);
    const recorded = JSON.parse(fs.readFileSync(findingsPath, 'utf8'));
    expect(recorded).toMatchObject({ ok: false, errorCode: 'E_PREVIEW_QA_BLOCKED' });
    expect(recorded).not.toHaveProperty('verdict');
  });

  it('does not charge an abandoned repair episode to the run the user just started', async () => {
    // 2026-08-08: a cycle opened the previous evening carried 2 of its 2 passes
    // into a fresh session. The first QA failure of the new run hit the wall
    // seven minutes in, and the model told the user it had done "3 repair
    // rounds" — two of them belonged to a conversation the user had left.
    makePlanVisualOnly();
    const toolMod = await import('../../../../src/main/model/core-agent/video-studio-tool');
    const stateMod = await import('../../../../src/main/features/video_studio_state');
    const baseOpts = {
      userId: UID,
      cid: 'cid-abandoned-cycle',
      turnId: 'turn-yesterday',
      agentId: VIDEO_STUDIO_AGENT_ID,
      agentName: 'VideoStudio',
      userMessage: '确认',
    };
    const statePath = toolMod.videoStudioProductionStatePath(baseOpts, compositionDir);
    const ctx = { workingDir: workspace, state: {}, emitProgress: vi.fn() } as any;
    expect((await toolMod.createVideoStudioTool(baseOpts).execute({
      op: 'composition.approve_plan',
      composition_dir: 'project/composition',
      decision_evidence: decisionEvidence('plan', 'approve', '确认'),
    }, ctx)).isError).toBe(false);
    const seedCycle = (extra: Record<string, unknown>) => stateMod.updateVideoProductionState(
      statePath,
      compositionDir,
      (state) => {
        state.stage = 'visuals_ready';
        state.visual_qa = {
          cycle: {
            cycle_id: 'cycle-from-yesterday',
            inspector_version: 3,
            visual_revision: 1,
            status: 'active',
            max_repair_passes: 2,
            failed_signatures: ['yesterday-1', 'yesterday-2'],
            passed_signatures: {},
            last_signature: 'yesterday-2',
            last_error_code: 'E_PREVIEW_QA_BLOCKED',
            started_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
            ...extra,
          },
        } as any;
      },
    );
    const cycleNow = async () => (await stateMod.readVideoProductionState(statePath, compositionDir)).visual_qa?.cycle;
    const status = (opts: Record<string, unknown>) => toolMod.createVideoStudioTool({ ...baseOpts, ...opts } as any)
      .execute({ op: 'composition.status', composition_dir: 'project/composition' }, ctx);

    // Still inside the episode that spent it: the budget is doing its job.
    await seedCycle({ last_failure_turn_id: 'turn-yesterday' });
    await status({ turnId: 'turn-yesterday', userMessage: '<msg from="user">继续</msg>' });
    expect(await cycleNow()).toMatchObject({ cycle_id: 'cycle-from-yesterday', failed_signatures: ['yesterday-1', 'yesterday-2'] });

    // A cycle that predates the stamp cannot be proven abandoned, and erasing a
    // live episode's failed strategies would lose what makes "try something
    // different" enforceable. Fail closed.
    await seedCycle({});
    await status({ turnId: 'turn-today', userMessage: '<msg from="user">继续</msg>' });
    expect(await cycleNow()).toMatchObject({ cycle_id: 'cycle-from-yesterday' });

    // A later real user turn: the episode was abandoned, so this run starts
    // with its own budget and the spent strategies move to history.
    await seedCycle({ last_failure_turn_id: 'turn-yesterday' });
    await status({ turnId: 'turn-today', userMessage: '<msg from="user">继续</msg>' });
    const granted = await cycleNow();
    expect(granted).toMatchObject({
      status: 'active',
      visual_revision: 2,
      failed_signatures: [],
      started_by_turn_id: 'turn-today',
    });
    expect(granted?.cycle_id).not.toBe('cycle-from-yesterday');
    expect((await stateMod.readVideoProductionState(statePath, compositionDir)).visual_qa?.history?.[0])
      .toMatchObject({ cycle_id: 'cycle-from-yesterday', failed_signatures: ['yesterday-1', 'yesterday-2'] });
  });

  it('opens the next visual QA cycle on the user reply while preserving plan and narration', async () => {
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
        cycle: {
          cycle_id: 'cycle-exhausted',
          inspector_version: 3,
          visual_revision: 1,
          status: 'exhausted',
          max_repair_passes: 2,
          started_by_turn_id: 'turn-earlier',
          exhausted_by_turn_id: 'turn-earlier',
          failed_signatures: ['first', 'repair-1', 'repair-2'],
          passed_signatures: {},
          last_signature: 'repair-2',
          last_error_code: 'E_INSPECT_BLOCKED',
          updated_at: new Date().toISOString(),
        },
      } as any;
    });
    const before = await stateMod.readVideoProductionState(statePath, compositionDir);
    const approvalSignature = before.plan_approval?.signature;

    // A dispatched turn is not a user reply, so it grants nothing.
    await toolMod.createVideoStudioTool({
      ...baseOpts,
      turnId: 'turn-dispatched',
      userMessage: '<msg from="agent">@VideoStudio Continue recovery from the recorded QA evidence.</msg>',
    }).execute({ op: 'composition.status', composition_dir: 'project/composition' }, ctx);
    expect((await stateMod.readVideoProductionState(statePath, compositionDir)).visual_qa?.cycle)
      .toMatchObject({ status: 'exhausted', visual_revision: 1 });

    const internalRecoveryOpts = {
      ...baseOpts,
      turnId: 'turn-unrelated',
      userMessage: '<msg from="user">再修一轮，换个思路</msg>',
    };
    const internalRecoveryTool = toolMod.createVideoStudioTool(internalRecoveryOpts);
    const started = await internalRecoveryTool.execute({
      op: 'composition.status',
      composition_dir: 'project/composition',
    }, ctx);
    expect(started.isError).toBe(false);

    // Idempotent within the turn: the grant already happened, so a second call
    // in the same turn must not mint yet another cycle.
    const repeated = await internalRecoveryTool.execute({
      op: 'composition.status',
      composition_dir: 'project/composition',
    }, ctx);
    expect(repeated.isError).toBe(false);

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
      visual_revision: 2,
      status: 'active',
      failed_signatures: [],
      started_by_turn_id: 'turn-unrelated',
    });
    // The spent cycle keeps its failed strategies so the next one can be told
    // not to repeat them.
    expect(revised.visual_qa?.history?.[0]).toMatchObject({
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
    const stateMod = await import('../../../../src/main/features/video_studio_state');
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
      },
    });
    // The payload names the live failed draft; the frozen copy stays in
    // durable state (2026-08-07 result projection) and is still published so
    // the failed version remains reviewable after later repairs.
    expect(firstFailedDraftPayload.current_candidate.snapshot?.locators).toBeUndefined();
    const draftStatePath = toolMod.videoStudioProductionStatePath(opts, compositionDir);
    const stateAfterDraft = await stateMod.readVideoProductionState(draftStatePath, compositionDir);
    const frozenDraftPath = String(stateAfterDraft.current_candidate?.snapshot?.locators.draft_path || '');
    expect(frozenDraftPath).toMatch(/draft-[a-f0-9]{12}\.mp4$/);
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

  it('finalizes an approved export before registering or publishing its path', async () => {
    const videoStudio = await import('../../../../src/main/features/video_studio');
    const hooks = await import('../../../../src/main/features/produced_output_hooks');
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
      // The legacy required flag from a pre-P3 producer is ignored: design
      // review is advisory and never blocks the user's final confirmation.
      { draft_ready: true, path: draftPath, design_review_required: true },
    )).toBe(true);
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

    const unregister = hooks.registerProducedOutputHooks({
      finalizeFile: async (file) => {
        events.push('finalized');
        fs.appendFileSync(file, ' + watermark');
      },
    });
    try {
      const result = await tool.execute({
        op: 'composition.export',
        composition_dir: 'project/composition',
        output_path: 'project/render/final.mp4',
      }, { workingDir: workspace, state: {} } as any);

      expect(result.isError).toBe(false);
      expect(fs.readFileSync(finalPath, 'utf8')).toBe('clean final + watermark');
      expect(events).toEqual(['render', 'finalized', 'written', 'published']);
      const exported = parseResult(result.content);
      expect(exported.deliver_markdown).toBe(`[final.mp4](chat-media://local${finalPath})`);
      expect(exported.next_action).toBe('deliver_final');
    } finally {
      unregister();
    }
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
    // The refusal says the user must approve "the displayed plan", so it has to
    // hand over a plan to display. 2026-08-08: it did not, and the model asked
    // the user to approve six segments, sixty seconds and a language by showing
    // them two sentences and a file path.
    const refusal = parseResult(rejectedApproval.content);
    expect(refusal.presentation_required).toBe(true);
    expect(refusal.next_action).toBe('present_plan_then_await_user_decision');
    expect(refusal.plan_digest).toMatchObject({
      duration_sec: expect.any(Number),
      scenes: expect.arrayContaining([expect.objectContaining({ id: expect.any(String) })]),
    });

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
      narration_audition: {
        action: 'share_audio_with_user_for_audition_now',
      },
    });
    expect(parseResult(materialized.content).narration_audition.audio_path).toContain('narration.mp3');
    expect(ttsMock.generateSpeech).toHaveBeenCalledTimes(1);
    expect(fs.readFileSync(htmlPath, 'utf8')).toContain('authored visual change');
    expect(fs.existsSync(path.join(compositionDir, 'assets', 'narration.mp3'))).toBe(true);
    expect(fs.existsSync(path.join(compositionDir, 'narration-map.json'))).toBe(true);
  });

  it('inherits the preview go-ahead across a narration-only amendment and re-materialization', async () => {
    // P1 sub-identity split: the preview is silent, so its approval attests
    // visual content only. Before the split any narration change invalidated
    // a visually identical preview and the user re-confirmed an unchanged
    // contact sheet; now the visual signature decides survival.
    const mod = await import('../../../../src/main/model/core-agent/video-studio-tool');
    const stateMod = await import('../../../../src/main/features/video_studio_state');
    const videoStudio = await import('../../../../src/main/features/video_studio');
    const ctx = { workingDir: workspace, state: {} } as any;
    const baseOpts = {
      userId: UID,
      cid: 'cid-narration-inherit',
      agentId: VIDEO_STUDIO_AGENT_ID,
      agentName: 'VideoStudio',
    };
    const approveTool = mod.createVideoStudioTool({
      ...baseOpts,
      turnId: 'turn-ni-approve',
      userMessage: '<msg from="user" to="79df9cc89f5f">@VideoStudio\n确认</msg>',
    });
    expect((await approveTool.execute({
      op: 'composition.approve_plan',
      composition_dir: 'project/composition',
      decision_evidence: decisionEvidence('plan', 'approve', '确认'),
    }, ctx)).isError).toBe(false);
    expect((await approveTool.execute({
      op: 'composition.prepare',
      composition_dir: 'project/composition',
    }, ctx)).isError).toBe(false);

    const htmlPath = path.join(compositionDir, 'index.html');
    fs.appendFileSync(htmlPath, '\n<div class="authored-brand">brand mark</div>\n', 'utf8');
    const statePath = mod.videoStudioProductionStatePath({ ...baseOpts, turnId: 'turn-ni-approve' }, compositionDir);
    expect(await mod.recordVideoStudioGate(statePath, 'preview', compositionDir, 'turn-ni-approve', {
      preview_ready: true,
      preview_qa: { ok: true, error_count: 0 },
      preflight: { status: 'passed', blocking_error_count: 0 },
      contact_sheet: path.join(compositionDir, 'preview', 'contact-sheet.png'),
    })).toBe(true);
    expect((await stateMod.readVideoProductionState(statePath, compositionDir)).preview?.visual_signature)
      .toMatch(/^[a-f0-9]{64}$/);
    expect((await mod.validateCompositionFrameEvidence(statePath, compositionDir)).ok).toBe(true);

    // Starting state from the real journey: the user already continued from
    // these exact silent frames. Seed that durable boundary fact explicitly;
    // the behavior under test is whether later narration work preserves and
    // re-keys it, not whether draft admission can create it again.
    const stateAtPreview = await stateMod.readVideoProductionState(statePath, compositionDir);
    expect(stateAtPreview.plan_approval?.signature).toMatch(/^[a-f0-9]{64}$/);
    await stateMod.updateVideoProductionState(statePath, compositionDir, (state) => {
      state.preview_go_ahead = {
        plan_signature: state.plan_approval!.signature,
        turn_id: 'turn-ni-preview-reply',
        created_at: new Date().toISOString(),
      };
    });
    const previewStatus = parseResult((await mod.createVideoStudioTool({
      ...baseOpts,
      turnId: 'turn-ni-status',
      userMessage: '<msg from="commander" to="79df9cc89f5f">读取当前状态</msg>',
    }).execute({
      op: 'composition.status',
      composition_dir: 'project/composition',
    }, ctx)).content);
    expect(previewStatus.production_state.next_allowed_ops).toEqual(expect.arrayContaining([
      'composition.materialize_narration',
    ]));
    const afterPreviewReply = await stateMod.readVideoProductionState(statePath, compositionDir);
    expect(afterPreviewReply.preview_go_ahead).toMatchObject({
      plan_signature: afterPreviewReply.plan_approval?.signature,
      turn_id: 'turn-ni-preview-reply',
    });

    // Seed the facts whose survival is under test: an audio asset (excluded
    // from the visual identity), a recorded draft (must always invalidate),
    // and an active visual-QA cycle (visual-bound, must survive).
    fs.mkdirSync(path.join(compositionDir, 'assets'), { recursive: true });
    fs.writeFileSync(path.join(compositionDir, 'assets', 'bgm.mp3'), 'bgm-bytes', 'utf8');
    expect(await mod.recordVideoStudioGate(statePath, 'draft', compositionDir, 'turn-ni-preview-approve', {
      draft_ready: true,
      path: path.join(workspace, 'project', 'render', 'draft.mp4'),
    })).toBe(true);
    const now = new Date().toISOString();
    await stateMod.updateVideoProductionState(statePath, compositionDir, (state) => {
      state.visual_qa = {
        cycle: {
          inspector_version: 3,
          cycle_id: 'cycle-narration-inherit',
          visual_revision: 0,
          status: 'active',
          max_repair_passes: 2,
          failed_signatures: [],
          passed_signatures: {},
          last_signature: 'sig',
          started_at: now,
          updated_at: now,
        },
      };
    });

    // Narration-only change across all three plan artifacts.
    const projectDir = path.join(workspace, 'project');
    fs.writeFileSync(path.join(projectDir, 'script.md'), '# Approved script\n\nSpeak twice now.', 'utf8');
    const shotlist = JSON.parse(fs.readFileSync(path.join(projectDir, 'shotlist.json'), 'utf8'));
    shotlist.shots[0].narration = 'Speak twice now.';
    fs.writeFileSync(path.join(projectDir, 'shotlist.json'), JSON.stringify(shotlist), 'utf8');
    const manifestPath = path.join(compositionDir, 'composition-manifest.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    manifest.scenes[0].narration_text = 'Speak twice now.';
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');

    const amended = await mod.createVideoStudioTool({
      ...baseOpts,
      turnId: 'turn-ni-amend',
      userMessage: '<msg from="user" to="79df9cc89f5f">@VideoStudio\n确认修订</msg>',
    }).execute({
      op: 'composition.approve_plan',
      composition_dir: 'project/composition',
      expected_plan_change: true,
      decision_evidence: decisionEvidence('plan', 'approve', '确认修订'),
    }, ctx);
    expect(amended.isError).toBe(false);
    expect(parseResult(amended.content).visual_qa_reset).toBe(false);

    const afterAmend = await stateMod.readVideoProductionState(statePath, compositionDir);
    expect(afterAmend.preview).toMatchObject({ status: 'ready' });
    expect(afterAmend.preview_go_ahead).toMatchObject({
      plan_signature: afterAmend.plan_approval?.signature,
      turn_id: 'turn-ni-preview-reply',
    });
    expect(afterAmend.visual_qa?.cycle).toMatchObject({ cycle_id: 'cycle-narration-inherit' });
    expect(afterAmend.draft).toBeUndefined();

    // Exact production order from the trace: status/plan amendment -> prepare
    // -> materialize. Prepare used to delete the preview
    // unconditionally even though the visual signature was identical.
    expect((await mod.createVideoStudioTool({
      ...baseOpts,
      turnId: 'turn-ni-prepare-after-amend',
      userMessage: '继续',
    }).execute({
      op: 'composition.prepare',
      composition_dir: 'project/composition',
    }, ctx)).isError).toBe(false);
    expect((await stateMod.readVideoProductionState(statePath, compositionDir)).preview)
      .toMatchObject({ status: 'ready' });

    ttsMock.generateSpeech.mockImplementation(async ({ outputAbsPath }: { outputAbsPath: string }) => {
      fs.mkdirSync(path.dirname(outputAbsPath), { recursive: true });
      const audio = Buffer.from('revised narration audio');
      fs.writeFileSync(outputAbsPath, audio);
      return { ok: true, bytes: audio.byteLength };
    });
    const rematerialized = await mod.createVideoStudioTool({
      ...baseOpts,
      turnId: 'turn-ni-materialize',
      userMessage: '继续',
    }).execute({
      op: 'composition.materialize_narration',
      composition_dir: 'project/composition',
    }, ctx);
    expect(rematerialized.isError ? String(rematerialized.content).slice(0, 500) : '').toBe('');
    expect(parseResult(rematerialized.content)).toMatchObject({
      scaffold_retimed: false,
      retiming_action: expect.stringContaining('Scene windows did not move'),
    });

    // Core inheritance: retimed manifest, reconciled audio markup, and the
    // new narration audio leave the visual identity — and therefore the
    // captured frames — untouched. The draft stays invalidated.
    const afterMaterialize = await stateMod.readVideoProductionState(statePath, compositionDir);
    expect(afterMaterialize.preview).toMatchObject({ status: 'ready' });
    expect(afterMaterialize.preview_go_ahead).toMatchObject({
      plan_signature: afterMaterialize.plan_approval?.signature,
      turn_id: 'turn-ni-preview-reply',
    });
    expect((await mod.validateCompositionFrameEvidence(statePath, compositionDir)).ok).toBe(true);
    expect(afterMaterialize.draft).toBeUndefined();
    expect(afterMaterialize.narration).toMatchObject({ status: 'materialized' });

    const draftSpy = vi.spyOn(videoStudio, 'draftComposition').mockResolvedValue({
      ok: false,
      op: 'composition.draft',
      errorCode: 'E_TEST_RENDER_STUB',
      message: 'render stubbed after narration amendment',
    } as any);
    const draftAfterNarration = await mod.createVideoStudioTool({
      ...baseOpts,
      turnId: 'turn-ni-background-draft',
      userMessage: '<msg from="commander" to="79df9cc89f5f">继续制作</msg>',
    }).execute({
      op: 'composition.draft',
      composition_dir: 'project/composition',
      output_path: 'project/render/draft-after-narration.mp4',
    }, ctx);
    expect(String(draftAfterNarration.content)).not.toContain('E_PREVIEW_GO_AHEAD_REQUIRED');
    expect(draftSpy).toHaveBeenCalledTimes(1);
    const afterInheritedDraft = await stateMod.readVideoProductionState(statePath, compositionDir);
    expect(afterInheritedDraft.preview).toMatchObject({ status: 'ready' });
    expect(afterInheritedDraft.preview_go_ahead).toMatchObject({
      plan_signature: afterInheritedDraft.plan_approval?.signature,
      turn_id: 'turn-ni-preview-reply',
    });
    draftSpy.mockRestore();

    // Negative control: a real visual change must still invalidate the
    // preview, or the guard would be inert.
    fs.appendFileSync(htmlPath, '\n<div class="authored-brand-2">new visual</div>\n', 'utf8');
    expect(await mod.validateCompositionFrameEvidence(statePath, compositionDir))
      .toMatchObject({ ok: false, errorCode: 'E_HTML_PREVIEW_STALE' });
    expect((await mod.createVideoStudioTool({
      ...baseOpts,
      turnId: 'turn-ni-visual-reconcile',
      userMessage: '继续',
    }).execute({
      op: 'composition.reconcile',
      composition_dir: 'project/composition',
    }, ctx)).isError).toBe(false);
    const afterVisualChange = await stateMod.readVideoProductionState(statePath, compositionDir);
    expect(afterVisualChange.preview).toBeUndefined();
    expect(afterVisualChange.preview_go_ahead).toBeUndefined();
    expect(afterVisualChange.visual_qa).toBeUndefined();
  });

  it('derives the single-channel outcome and error class from legacy protocol fields', async () => {
    // P3 additive stage: `outcome` collapses the dozen behavior fields into
    // the three states that exist; `error_class` collapses the error-code
    // taxonomy. Both are derived, never contradict the legacy fields, and
    // must stay stable — contract-3 skills will read only these.
    const mod = await import('../../../../src/main/model/core-agent/video-studio-tool');

    expect(mod.deriveVideoStudioOutcome({ ok: true, op: 'composition.snapshot' })).toBe('continue');
    expect(mod.deriveVideoStudioOutcome({ ok: true, op: 'composition.export' })).toBe('stop');
    expect(mod.deriveVideoStudioOutcome({ ok: false, next_step_owner: 'user' })).toBe('need_user');
    expect(mod.deriveVideoStudioOutcome({ ok: false, requires_user_decision: true })).toBe('need_user');
    expect(mod.deriveVideoStudioOutcome({ ok: false, interaction_required: true })).toBe('need_user');
    // Agent-recoverable failures keep the turn.
    expect(mod.deriveVideoStudioOutcome({
      ok: false, next_step_owner: 'agent', automatic_recovery_expected: true,
    })).toBe('continue');

    expect(mod.deriveVideoStudioErrorClass('E_DECISION_EVIDENCE_INVALID')).toBe('input_error');
    expect(mod.deriveVideoStudioErrorClass('E_DESIGN_REVIEW_SCORE_INVALID')).toBe('input_error');
    expect(mod.deriveVideoStudioErrorClass('E_GATE_USER_TURN_REQUIRED')).toBe('user_turn_required');
    expect(mod.deriveVideoStudioErrorClass('E_HTML_PREVIEW_EXPLICIT_APPROVAL_REQUIRED')).toBe('user_turn_required');
    expect(mod.deriveVideoStudioErrorClass('E_TTS_RETRY_EPISODE_EXHAUSTED')).toBe('budget');
    expect(mod.deriveVideoStudioErrorClass('E_SNAPSHOT_RETRY_NO_CHANGE')).toBe('budget');
    expect(mod.deriveVideoStudioErrorClass('E_TTS_TEXT_TOO_LONG')).toBe('input_error');
    expect(mod.deriveVideoStudioErrorClass('E_TTS_MEASURED_DURATION_MISMATCH')).toBe('narration_timing');
    expect(mod.deriveVideoStudioErrorClass('E_VIDEO_QA_BLOCKED')).toBe('provider_error');
    expect(mod.deriveVideoStudioErrorClass('E_GATE_B_ARTIFACTS_INCOMPLETE')).toBe('precondition');
    expect(mod.deriveVideoStudioErrorClass(undefined)).toBeUndefined();
  });

  it('fails legacy preview entries closed when they cannot prove visual identity', async () => {
    // Entries without visual_signature cannot participate in selective
    // inheritance. One new preview is safer than either retaining stale pixels
    // or guessing from the full audio+visual signature.
    const mod = await import('../../../../src/main/model/core-agent/video-studio-tool');
    const stateMod = await import('../../../../src/main/features/video_studio_state');
    const ctx = { workingDir: workspace, state: {} } as any;
    const opts = {
      userId: UID,
      cid: 'cid-legacy-preview',
      turnId: 'turn-legacy',
      agentId: VIDEO_STUDIO_AGENT_ID,
      agentName: 'VideoStudio',
      userMessage: '<msg from="user" to="79df9cc89f5f">@VideoStudio\n确认</msg>',
    };
    const tool = mod.createVideoStudioTool(opts);
    expect((await tool.execute({
      op: 'composition.approve_plan',
      composition_dir: 'project/composition',
      decision_evidence: decisionEvidence('plan', 'approve', '确认'),
    }, ctx)).isError).toBe(false);
    const statePath = mod.videoStudioProductionStatePath(opts, compositionDir);
    const fullSignature = await mod.videoStudioCompositionSignature(compositionDir);
    await stateMod.updateVideoProductionState(statePath, compositionDir, (state) => {
      state.preview = {
        signature: fullSignature,
        turn_id: 'turn-earlier',
        created_at: new Date().toISOString(),
        status: 'approved',
        approved_turn_id: 'turn-earlier-2',
        approved_at: new Date().toISOString(),
        validation_version: 5,
      };
    });

    // An audio asset is invisible to the preview, so a current entry survives
    // it (covered above). The legacy entry still fails closed because it lacks
    // the visual sub-identity proof.
    fs.mkdirSync(path.join(compositionDir, 'assets'), { recursive: true });
    fs.writeFileSync(path.join(compositionDir, 'assets', 'legacy-bgm.mp3'), 'legacy-bgm-bytes', 'utf8');

    const approval = await mod.createVideoStudioTool({
      ...opts,
      turnId: 'turn-legacy-approve',
    }).execute({ op: 'composition.status', composition_dir: 'project/composition' }, ctx);
    expect(approval.isError).toBe(false);
    // The legacy entry carries no visual_signature, so it cannot be inherited.
    expect((await mod.validateCompositionFrameEvidence(statePath, compositionDir)))
      .toMatchObject({ ok: false, errorCode: 'E_HTML_PREVIEW_STALE' });
  });

  it('clears an orphaned preview go-ahead without discarding an active visual QA cycle', async () => {
    const mod = await import('../../../../src/main/model/core-agent/video-studio-tool');
    const stateMod = await import('../../../../src/main/features/video_studio_state');
    const ctx = { workingDir: workspace, state: {} } as any;
    const opts = {
      userId: UID,
      cid: 'cid-orphan-preview-go-ahead',
      turnId: 'turn-orphan-preview-go-ahead',
      agentId: VIDEO_STUDIO_AGENT_ID,
      agentName: 'VideoStudio',
      userMessage: '确认',
    };
    const tool = mod.createVideoStudioTool(opts);
    expect((await tool.execute({
      op: 'composition.approve_plan',
      composition_dir: 'project/composition',
      decision_evidence: decisionEvidence('plan', 'approve', '确认'),
    }, ctx)).isError).toBe(false);
    const statePath = mod.videoStudioProductionStatePath(opts, compositionDir);
    const approved = await stateMod.readVideoProductionState(statePath, compositionDir);
    await stateMod.updateVideoProductionState(statePath, compositionDir, (state) => {
      state.preview_go_ahead = {
        plan_signature: approved.plan_approval!.signature,
        turn_id: 'turn-old-reply',
        created_at: new Date().toISOString(),
      };
      state.visual_qa = {
        cycle: {
          inspector_version: 3,
          cycle_id: 'cycle-still-active',
          visual_revision: 0,
          status: 'active',
          max_repair_passes: 2,
          failed_signatures: [],
          passed_signatures: {},
          started_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        },
      };
    });

    expect((await tool.execute({
      op: 'composition.prepare',
      composition_dir: 'project/composition',
    }, ctx)).isError).toBe(false);
    const repaired = await stateMod.readVideoProductionState(statePath, compositionDir);
    expect(repaired.preview_go_ahead).toBeUndefined();
    expect(repaired.visual_qa?.cycle).toMatchObject({ cycle_id: 'cycle-still-active' });
  });

  it('does not record a preview identity when the visual manifest cannot be read', async () => {
    const mod = await import('../../../../src/main/model/core-agent/video-studio-tool');
    const stateMod = await import('../../../../src/main/features/video_studio_state');
    const opts = {
      userId: UID,
      cid: 'cid-visual-manifest-read-failure',
      turnId: 'turn-visual-manifest-read-failure',
    };
    const statePath = mod.videoStudioProductionStatePath(opts, compositionDir);
    const manifestPath = path.join(compositionDir, 'composition-manifest.json');
    const readError = Object.assign(new Error('visual-manifest-unreadable'), { code: 'EACCES' });
    fsPromiseMocks.readFile.mockImplementation(async (...args: unknown[]) => {
      const [file, encoding] = args;
      if (typeof file === 'string' && path.resolve(file) === manifestPath && encoding === 'utf8') {
        throw readError;
      }
      return fsPromiseMocks.actualReadFile!(...args);
    });

    await expect(mod.recordVideoStudioGate(statePath, 'preview', compositionDir, opts.turnId, {
      preview_ready: true,
      preview_qa: { ok: true, error_count: 0 },
      preflight: { status: 'passed', blocking_error_count: 0 },
      contact_sheet: path.join(compositionDir, 'preview', 'contact-sheet.png'),
    })).rejects.toThrow('visual-manifest-unreadable');

    expect((await stateMod.readVideoProductionState(statePath, compositionDir)).preview).toBeUndefined();
    expect(loggerMocks.warn).toHaveBeenCalledWith(
      'visual manifest signature read failed',
      expect.objectContaining({
        error: expect.objectContaining({ code: 'EACCES', name: 'Error' }),
      }),
    );
  });

  it('does not approve a persisted empty-HTML visual identity when HTML is unreadable again', async () => {
    const mod = await import('../../../../src/main/model/core-agent/video-studio-tool');
    const contract = await import('../../../../src/main/features/video_studio_contract');
    const stateMod = await import('../../../../src/main/features/video_studio_state');
    const opts = {
      userId: UID,
      cid: 'cid-visual-html-read-failure',
      turnId: 'turn-preview-recorded',
      agentId: VIDEO_STUDIO_AGENT_ID,
      agentName: 'VideoStudio',
      userMessage: '<msg from="user" to="79df9cc89f5f">@VideoStudio\nPreview approved.</msg>',
    };
    const ctx = { workingDir: workspace, state: {} } as any;
    const planApproval = await mod.createVideoStudioTool(opts).execute({
      op: 'composition.approve_plan',
      composition_dir: 'project/composition',
      decision_evidence: decisionEvidence('plan', 'approve', 'Preview approved.'),
    }, ctx);
    expect(planApproval.isError).toBe(false);
    const statePath = mod.videoStudioProductionStatePath(opts, compositionDir);
    const manifestRaw = fs.readFileSync(
      path.join(compositionDir, 'composition-manifest.json'),
      'utf8',
    );
    const persistedEmptyHtmlSignature = crypto.createHash('sha256')
      .update('composition-manifest.json')
      .update('\0')
      .update(contract.visualProjectionOfCompositionManifest(JSON.parse(manifestRaw)))
      .update('\0')
      .update('index.html')
      .update('\0')
      .update('')
      .update('\0')
      .digest('hex');
    await stateMod.updateVideoProductionState(statePath, compositionDir, (state) => {
      state.preview = {
        signature: 'f'.repeat(64),
        visual_signature: persistedEmptyHtmlSignature,
        turn_id: opts.turnId,
        created_at: new Date().toISOString(),
        status: 'ready',
        validation_version: 5,
      };
    });

    const htmlPath = path.join(compositionDir, 'index.html');
    const readError = Object.assign(new Error('visual-html-unreadable'), { code: 'EACCES' });
    fsPromiseMocks.readFile.mockImplementation(async (...args: unknown[]) => {
      const [file, encoding] = args;
      if (typeof file === 'string' && path.resolve(file) === htmlPath && encoding === 'utf8') {
        throw readError;
      }
      return fsPromiseMocks.actualReadFile!(...args);
    });

    // Frame currency must fail closed when the HTML cannot be read: an
    // unreadable input can never be proved to match the persisted identity.
    await expect(mod.validateCompositionFrameEvidence(statePath, compositionDir))
      .rejects.toThrow('visual-html-unreadable');

    expect((await stateMod.readVideoProductionState(statePath, compositionDir)).preview).toMatchObject({
      status: 'ready',
      visual_signature: persistedEmptyHtmlSignature,
    });
    expect(loggerMocks.warn).toHaveBeenCalledWith(
      'visual HTML signature read failed',
      expect.objectContaining({
        error: expect.objectContaining({ code: 'EACCES', name: 'Error' }),
      }),
    );
  });

  it('ignores narration/audio identity but keeps visual timing and visible edits', async () => {
    const contract = await import('../../../../src/main/features/video_studio_contract');
    const baseHtml = [
      '<main data-composition-id="main" data-width="1920" data-height="1080" data-start="0" data-duration="5">',
      '<section class="clip" data-scene-id="cover" data-start="0" data-duration="5">',
      '<h1>Approved</h1>',
      '</section>',
      '<script>tl.set("#scene-cover", { autoAlpha: 1 }, 0);</script>',
      '</main>',
    ].join('\n');
    const retimedHtml = baseHtml
      .replace('data-start="0" data-duration="5">\n<section', 'data-start="0" data-duration="6.8">\n<section')
      .replace('data-scene-id="cover" data-start="0" data-duration="5"', 'data-scene-id="cover" data-start="0" data-duration="6.8"')
      .replace('{ autoAlpha: 1 }, 0);', '{ autoAlpha: 1 }, 1.25);')
      .replace('</main>', '<audio id="audio-narration" src="./assets/narration.mp3" data-start="0" data-duration="6.8"></audio>\n</main>');
    expect(contract.normalizeCompositionHtmlForVisualIdentity(retimedHtml))
      .not.toBe(contract.normalizeCompositionHtmlForVisualIdentity(baseHtml));
    const audioOnlyHtml = baseHtml.replace(
      '</main>',
      '<audio id="audio-narration" src="./assets/narration.mp3" data-start="0" data-duration="5"></audio>\n</main>',
    );
    expect(contract.normalizeCompositionHtmlForVisualIdentity(audioOnlyHtml))
      .toBe(contract.normalizeCompositionHtmlForVisualIdentity(baseHtml));
    const visualEdit = baseHtml.replace('<h1>Approved</h1>', '<h1>Changed</h1>');
    expect(contract.normalizeCompositionHtmlForVisualIdentity(visualEdit))
      .not.toBe(contract.normalizeCompositionHtmlForVisualIdentity(baseHtml));

    const manifest = {
      schema_version: 1,
      composition: { id: 'main', width: 1920, height: 1080, duration: 5, fps: 30 },
      scenes: [{ id: 'cover', start: 0, duration: 5, approved_copy: ['Approved'], narration_text: 'Speak once.' }],
      audio: { owner: 'none', tracks: [] },
    };
    const retimed = {
      ...manifest,
      composition: { ...manifest.composition, duration: 6.8, target_duration: 5 },
      scenes: [{ ...manifest.scenes[0], start: 0, duration: 6.8, narration_text: 'Speak twice now.' }],
      audio: { owner: 'composition', tracks: [{ id: 'narration', kind: 'narration', src: 'assets/narration.mp3', start: 0, duration: 6.8, volume: 1 }] },
    };
    expect(contract.visualProjectionOfCompositionManifest(retimed))
      .not.toBe(contract.visualProjectionOfCompositionManifest(manifest));
    const narrationOnly = {
      ...manifest,
      scenes: [{ ...manifest.scenes[0], narration_text: 'Speak twice now.' }],
      audio: { owner: 'composition', tracks: [{ id: 'narration', kind: 'narration', src: 'assets/narration.mp3', start: 0, duration: 5, volume: 1 }] },
    };
    expect(contract.visualProjectionOfCompositionManifest(narrationOnly))
      .toBe(contract.visualProjectionOfCompositionManifest(manifest));
    const copyEdit = {
      ...manifest,
      scenes: [{ ...manifest.scenes[0], approved_copy: ['Changed'] }],
    };
    expect(contract.visualProjectionOfCompositionManifest(copyEdit))
      .not.toBe(contract.visualProjectionOfCompositionManifest(manifest));
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
    // Drift is a change to the plan, and the plan is the manifest.
    const driftPath = path.join(compositionDir, 'composition-manifest.json');
    const canonicalManifest = fs.readFileSync(driftPath, 'utf8');
    const drift = JSON.parse(canonicalManifest);
    drift.scenes[0].approved_copy = [...drift.scenes[0].approved_copy, 'Transient edit.'];
    fs.writeFileSync(driftPath, JSON.stringify(drift, null, 2), 'utf8');
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

    fs.writeFileSync(driftPath, canonicalManifest, 'utf8');
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
    // Explicit silence owns no narration reference. Placeholder/ref ids are
    // implementation metadata and must not churn an already approved plan.
    const initialManifestPath = path.join(compositionDir, 'composition-manifest.json');
    const initialManifest = JSON.parse(fs.readFileSync(initialManifestPath, 'utf8'));
    initialManifest.scenes[0].narration_text = '';
    initialManifest.scenes[0].narration_refs = ['stale-silent-ref-before-approval'];
    fs.writeFileSync(initialManifestPath, JSON.stringify(initialManifest, null, 2), 'utf8');
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
          scenes: [expect.objectContaining({
            approved_copy: ['Approved'],
            narration_text: '',
            narration_refs: [],
          })],
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
    manifest.scenes[0].narration_refs = ['another-stale-silent-ref'];
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
    // The manifest is the plan, so it is the only observed artifact.
    expect(status.plan_evidence.observations).toEqual([
      expect.objectContaining({ role: 'manifest', status: 'changed' }),
    ]);

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

  it('rejects interstitial silence before any continuous narration request is billed', async () => {
    const manifestPath = path.join(compositionDir, 'composition-manifest.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    manifest.schema_version = 2;
    manifest.scenes = [
      {
        ...manifest.scenes[0],
        id: 'opening-voice', start: 0, duration: 2,
        narration_text: 'Opening line.', narration_refs: [],
      },
      {
        ...manifest.scenes[0],
        id: 'silent-gap', start: 2, duration: 1,
        narration_text: '', narration_refs: ['stale-gap-ref'],
      },
      {
        ...manifest.scenes[0],
        id: 'closing-voice', start: 3, duration: 2,
        narration_text: 'Closing line.', narration_refs: [],
      },
    ];
    manifest.audio = {
      owner: 'none',
      tracks: [],
      narration_intent: {
        route_ref: 'provider:doubao',
        voice_ref: 'provider:doubao:voice:test-vivi',
        display_name: 'Vivi',
        language: 'en',
        speed: 1,
      },
    };
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');
    ttsMock.estimateNarrationDuration.mockReturnValue({
      estimatedSec: 4,
      unit: 'words',
      units: 4,
      unitsPerSec: 1,
    });

    const toolMod = await import('../../../../src/main/model/core-agent/video-studio-tool');
    const opts = {
      userId: UID,
      turnId: 'turn-interstitial-silence',
      agentId: VIDEO_STUDIO_AGENT_ID,
      agentName: 'VideoStudio',
      userMessage: '确认并继续制作',
    };
    const tool = toolMod.createVideoStudioTool(opts);
    const ctx = { workingDir: workspace, state: {} } as any;
    const planApproval = await tool.execute({
      op: 'composition.approve_plan',
      composition_dir: 'project/composition',
      decision_evidence: decisionEvidence('plan', 'approve', '确认并继续制作'),
    }, ctx);
    expect(planApproval.isError, planApproval.content).toBe(false);

    const blocked = await tool.execute({
      op: 'composition.materialize_narration',
      composition_dir: 'project/composition',
    }, ctx);
    expect(blocked.isError).toBe(true);
    expect(parseResult(blocked.content)).toMatchObject({
      errorCode: 'E_NARRATION_INTERSTITIAL_SILENCE_UNSUPPORTED',
      scene_ids: ['silent-gap'],
      billable_request_sent: false,
      requires_user_decision: false,
      next_action: 'repair_narration_timeline_then_composition.check_narration_fit',
    });
    expect(ttsMock.generateSpeech).not.toHaveBeenCalled();
  });

  it('names the intent fields that reopened the plan confirmation', async () => {
    // 2026-08-08: the user confirmed, the model then rewrote scene narration
    // text, that invalidated the approval it had just been given, and it
    // re-presented the entire plan twice — never learning that its own edit
    // was the cause, because `plan_approval_current: false` is all it got.
    makePlanVisualOnly();
    const manifestPath = path.join(compositionDir, 'composition-manifest.json');
    const toolMod = await import('../../../../src/main/model/core-agent/video-studio-tool');
    const opts = {
      userId: UID,
      cid: 'cid-intent-diff',
      turnId: 'turn-intent-diff',
      agentId: VIDEO_STUDIO_AGENT_ID,
      agentName: 'VideoStudio',
      userMessage: approvalSubmission('gate_b_decision', 'approve'),
    };
    const tool = toolMod.createVideoStudioTool(opts);
    const ctx = { workingDir: workspace, state: {} } as any;
    expect((await tool.execute({
      op: 'composition.approve_plan',
      composition_dir: 'project/composition',
    }, ctx)).isError).toBe(false);

    const status = async () => parseResult((await tool.execute({
      op: 'composition.status',
      composition_dir: 'project/composition',
    }, ctx)).content);

    // Nothing changed: the field is absent rather than an empty list, so a
    // current approval carries no diff payload at all.
    const unchanged = await status();
    expect(unchanged.plan_approval_current).toBe(true);
    expect(unchanged).not.toHaveProperty('plan_intent_changes');

    const edited = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    const editedSceneId = edited.scenes[0].id;
    edited.scenes[0].narration_text = 'A rewritten line that fits the measured duration better.';
    fs.writeFileSync(manifestPath, JSON.stringify(edited, null, 2), 'utf8');

    const reopened = await status();
    expect(reopened.plan_approval_current).toBe(false);
    // Addressed by scene id, so the model can show the one line that changed.
    expect(reopened.plan_intent_changes).toEqual([`manifest.scenes.${editedSceneId}.narration_text`]);
    expect(reopened.plan_intent_changes_note).toContain('Confirm only what changed');

    // Art direction is outside the approved intent, so touching it must not
    // report a change — the diff has to agree with the currency check that
    // produced it, or it becomes a second, contradictory answer.
    const restyled = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    restyled.scenes[0].narration_text = edited.scenes[0].narration_text;
    restyled.art_direction = { ...(restyled.art_direction || {}), aesthetic: 'warm dusk palette' };
    fs.writeFileSync(manifestPath, JSON.stringify(restyled, null, 2), 'utf8');
    const afterRestyle = await status();
    expect(afterRestyle.plan_intent_changes).toEqual([`manifest.scenes.${editedSceneId}.narration_text`]);
  });

  it('treats a manifest source_shots remap as a plan amendment', async () => {
    // shotlist.json is retired, so `source_shots` ids have nothing to alias:
    // they name the approved beat directly. Renaming one is a change of what
    // the user approved and must reopen the plan confirmation — the alias
    // canonicalization this case used to cover no longer has an input.
    makePlanVisualOnly();
    const manifestPath = path.join(compositionDir, 'composition-manifest.json');
    const toolMod = await import('../../../../src/main/model/core-agent/video-studio-tool');
    const opts = {
      userId: UID,
      cid: 'cid-source-shot-remap',
      turnId: 'turn-source-shot-remap',
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

    const remapped = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    remapped.scenes[0].source_shots = ['a-different-beat'];
    fs.writeFileSync(manifestPath, JSON.stringify(remapped, null, 2), 'utf8');

    const afterRemap = parseResult((await tool.execute({
      op: 'composition.status',
      composition_dir: 'project/composition',
    }, ctx)).content);
    expect(afterRemap.plan_approval_current).toBe(false);

    // Re-approving the amended plan signs a different intent.
    const reApproved = await tool.execute({
      op: 'composition.approve_plan',
      composition_dir: 'project/composition',
      expected_plan_change: true,
    }, ctx);
    expect(reApproved.isError, String(reApproved.content)).toBe(false);
    expect(parseResult(reApproved.content).approved_intent_hash).not.toBe(approvedSignature);
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
      // Earliest audible checkpoint: the result must direct the agent to
      // share the audio for audition — the visual preview is silent, so
      // without this the user first hears the voice at the rendered draft.
      narration_audition: {
        duration_sec: narration.durationSec,
        action: 'share_audio_with_user_for_audition_now',
      },
    });
    expect(parseResult(recovered.content).narration_audition.audio_path).toContain('narration.mp3');
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

  it('lets an explicit approval clear an unattributable narration artifact instead of dead-ending on it', async () => {
    // Regression: the retry-authorization block is gated on `!existingOutput`,
    // so while unattributable audio sat in assets/ a user approval could
    // neither be recorded nor consumed — every call returned the same
    // E_NARRATION_OUTPUT_CONFLICT and no code path ever moved the file.
    // Observed 2026-08-04/05: a charged narration was invalidated by a silent
    // rebind, the user confirmed a retry, and got the identical refusal back.
    materializeNarrationFixture();
    const toolMod = await import('../../../../src/main/model/core-agent/video-studio-tool');
    const stateMod = await import('../../../../src/main/features/video_studio_state');
    const baseOpts = {
      userId: UID,
      agentId: VIDEO_STUDIO_AGENT_ID,
      agentName: 'VideoStudio',
    };
    const ctx = { workingDir: workspace, state: {} } as any;
    const audioPath = path.join(compositionDir, 'assets', 'narration.mp3');
    const orphanBytes = fs.readFileSync(audioPath);
    const orphanSha = crypto.createHash('sha256').update(orphanBytes).digest('hex');

    const planTool = toolMod.createVideoStudioTool({
      ...baseOpts, turnId: 'turn-conflict-plan', userMessage: '继续制作',
    });
    expect((await planTool.execute({
      op: 'composition.approve_plan',
      composition_dir: 'project/composition',
      decision_evidence: decisionEvidence('plan', 'approve', '继续制作'),
    }, ctx)).isError).toBe(false);

    // Without an approval the artifact stays exactly where it is.
    const refusedTool = toolMod.createVideoStudioTool({
      ...baseOpts, turnId: 'turn-conflict-no-approval', userMessage: '继续制作',
    });
    const refused = await refusedTool.execute({
      op: 'composition.materialize_narration',
      composition_dir: 'project/composition',
    }, ctx);
    expect(refused.isError).toBe(true);
    expect(parseResult(refused.content)).toMatchObject({
      errorCode: 'E_NARRATION_OUTPUT_CONFLICT',
      billable_request_sent: false,
    });
    expect(fs.existsSync(audioPath)).toBe(true);
    expect(ttsMock.generateSpeech).not.toHaveBeenCalled();

    // An explicit approval in the current turn breaks the loop.
    ttsMock.generateSpeech.mockImplementation(async ({ outputAbsPath }: { outputAbsPath: string }) => {
      fs.mkdirSync(path.dirname(outputAbsPath), { recursive: true });
      const audio = Buffer.from('regenerated narration audio');
      fs.writeFileSync(outputAbsPath, audio);
      return { ok: true, bytes: audio.byteLength };
    });
    const approvedTool = toolMod.createVideoStudioTool({
      ...baseOpts,
      turnId: 'turn-conflict-approved',
      userMessage: approvalSubmission('narration_retry_decision', 'approve'),
    });
    const regenerated = await approvedTool.execute({
      op: 'composition.materialize_narration',
      composition_dir: 'project/composition',
    }, ctx);

    expect(regenerated.isError).toBe(false);
    expect(ttsMock.generateSpeech).toHaveBeenCalledTimes(1);
    // The old audio is preserved, not deleted: it was paid for.
    const preserved = path.join(
      compositionDir, 'assets', 'narration-history', `unmatched-${orphanSha.slice(0, 16)}.mp3`,
    );
    expect(fs.existsSync(preserved)).toBe(true);
    expect(fs.readFileSync(preserved)).toEqual(orphanBytes);
    // And the composition now carries the freshly synthesized audio instead.
    expect(fs.readFileSync(audioPath).toString()).toBe('regenerated narration audio');
    const finalState = await stateMod.readVideoProductionState(
      toolMod.videoStudioProductionStatePath(baseOpts, compositionDir),
      compositionDir,
    );
    expect(finalState.narration).toMatchObject({ status: 'materialized' });
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
      automatic_recovery_expected: false,
      next_step_owner: 'external',
      same_turn_continuation_required: false,
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
          automatic_recovery_expected: false,
          next_step_owner: 'external',
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
    expect(finalState.narration_transaction_history[0]).toMatchObject({ status: 'failed' });
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
    expect(finalState.narration_transaction_history).toHaveLength(2);
    expect(finalState.narration_transaction_history.map(transaction => transaction.status))
      .toEqual(['failed', 'synthesized']);
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
    mediaProbeMock.duration.mockResolvedValue(10.2);
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
        manifest: { path: path.join(compositionDir, 'composition-manifest.json') },
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

  it('accepts a 48.24s narration for an approximately 45s target and expands delivery without retrying', async () => {
    const toolMod = await import('../../../../src/main/model/core-agent/video-studio-tool');
    const stateMod = await import('../../../../src/main/features/video_studio_state');
    const manifestPath = path.join(compositionDir, 'composition-manifest.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    manifest.composition.duration = 45;
    manifest.composition.target_duration = 45;
    manifest.scenes[0].duration = 45;
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');
    const shotlistPath = path.join(workspace, 'project', 'shotlist.json');
    const shotlist = JSON.parse(fs.readFileSync(shotlistPath, 'utf8'));
    shotlist.target_duration_seconds = 45;
    fs.writeFileSync(shotlistPath, JSON.stringify(shotlist), 'utf8');
    ttsMock.estimateNarrationDuration.mockImplementation((text: string) => ({
      estimatedSec: 45,
      unit: 'words',
      units: text.split(/\s+/).filter(Boolean).length,
      unitsPerSec: 1,
    }));
    mediaProbeMock.duration.mockResolvedValue(48.24);
    ttsMock.generateSpeech.mockImplementation(async (request: { outputAbsPath: string }) => {
      fs.mkdirSync(path.dirname(request.outputAbsPath), { recursive: true });
      fs.writeFileSync(request.outputAbsPath, Buffer.from('48.24-second-narration'));
      return {
        ok: true,
        path: request.outputAbsPath,
        bytes: fs.statSync(request.outputAbsPath).size,
        backend: 'mock-voice',
      };
    });
    const opts = {
      userId: UID,
      cid: 'cid-45-second-band',
      turnId: 'turn-45-second-band',
      agentId: VIDEO_STUDIO_AGENT_ID,
      agentName: 'VideoStudio',
      userMessage: '确认',
    };
    const tool = toolMod.createVideoStudioTool(opts);
    const ctx = { workingDir: workspace, state: {} } as any;
    for (const op of ['composition.approve_plan', 'composition.doctor', 'composition.prepare']) {
      expect((await tool.execute(compositionInput(op), ctx)).isError).toBe(false);
    }

    const result = await tool.execute({
      op: 'composition.materialize_narration',
      composition_dir: 'project/composition',
    }, ctx);
    expect(result.isError, String(result.content)).toBe(false);
    expect(parseResult(result.content)).toMatchObject({
      measured_duration_sec: 48.24,
      target_duration_sec: 45,
      billable_request_sent: true,
      production_state: {
        artifact_readiness: {
          visuals: 'scaffold_only',
          narration: 'materialized',
          complete_delivery_ready: false,
        },
      },
    });
    expect(ttsMock.generateSpeech).toHaveBeenCalledTimes(1);
    const deliveredManifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    expect(deliveredManifest.composition).toMatchObject({
      target_duration: 45,
      duration: 48.24,
    });
    expect(deliveredManifest.audio.tracks).toContainEqual(expect.objectContaining({
      kind: 'narration',
      duration: 48.24,
    }));
    const narrationMap = JSON.parse(fs.readFileSync(
      path.join(compositionDir, 'narration-map.json'),
      'utf8',
    ));
    expect(narrationMap).toMatchObject({
      total_duration: 48.24,
      narration_audio_duration: 48.24,
    });
    const finalState = await stateMod.readVideoProductionState(
      toolMod.videoStudioProductionStatePath(opts, compositionDir),
      compositionDir,
    );
    expect(finalState.narration_timing_episode).toBeUndefined();
    expect(finalState.narration_transaction_history).toHaveLength(1);
    expect(finalState.narration_transaction_history[0]).toMatchObject({
      attempt_kind: 'initial',
      status: 'synthesized',
      measured_duration_sec: 48.24,
    });
  });

  it('allows one automatic timing retry across text hashes, then requires a user decision', async () => {
    const toolMod = await import('../../../../src/main/model/core-agent/video-studio-tool');
    const stateMod = await import('../../../../src/main/features/video_studio_state');
    const manifestPath = path.join(compositionDir, 'composition-manifest.json');
    const originalNarration = 'This approved narration has enough stable words for one small measured timing correction now.';
    const revisedNarration = 'This narration has enough stable words for one small measured timing correction now.';
    const userRevisedNarration = 'This narration has enough words for one small measured timing correction now.';
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    manifest.composition.duration = 45;
    manifest.composition.target_duration = 45;
    manifest.scenes[0].duration = 45;
    manifest.scenes[0].narration_text = originalNarration;
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');
    const shotlistPath = path.join(workspace, 'project', 'shotlist.json');
    const shotlist = JSON.parse(fs.readFileSync(shotlistPath, 'utf8'));
    shotlist.target_duration_seconds = 45;
    shotlist.shots[0].narration = originalNarration;
    fs.writeFileSync(shotlistPath, JSON.stringify(shotlist), 'utf8');
    fs.writeFileSync(path.join(workspace, 'project', 'script.md'), `# Approved script\n\n${originalNarration}`, 'utf8');
    useSchema2Narration();
    ttsMock.estimateNarrationDuration.mockImplementation((text: string) => ({
      estimatedSec: text.includes('approved') ? 45 : text.includes('stable') ? 44 : 42,
      unit: 'words',
      units: text.split(/\s+/).filter(Boolean).length,
      unitsPerSec: 1,
    }));
    mediaProbeMock.duration.mockResolvedValueOnce(51).mockResolvedValue(52);
    ttsMock.generateSpeech.mockImplementation(async (request: { outputAbsPath: string }) => {
      fs.mkdirSync(path.dirname(request.outputAbsPath), { recursive: true });
      fs.writeFileSync(request.outputAbsPath, Buffer.from(`timing-attempt-${ttsMock.generateSpeech.mock.calls.length}`));
      return {
        ok: true,
        path: request.outputAbsPath,
        bytes: fs.statSync(request.outputAbsPath).size,
        backend: 'mock-voice',
      };
    });
    const opts = {
      userId: UID,
      cid: 'cid-one-automatic-timing-retry',
      turnId: 'turn-one-automatic-timing-retry',
      agentId: VIDEO_STUDIO_AGENT_ID,
      agentName: 'VideoStudio',
      userMessage: '确认',
    };
    const tool = toolMod.createVideoStudioTool(opts);
    const ctx = { workingDir: workspace, state: {} } as any;
    for (const op of ['composition.approve_plan', 'composition.doctor', 'composition.prepare']) {
      expect((await tool.execute(compositionInput(op), ctx)).isError).toBe(false);
    }
    const first = await tool.execute({
      op: 'composition.materialize_narration',
      composition_dir: 'project/composition',
    }, ctx);
    expect(first.isError).toBe(true);
    expect(parseResult(first.content)).toMatchObject({
      errorCode: 'E_TTS_MEASURED_DURATION_MISMATCH',
      automatic_timing_retries_remaining: 1,
    });

    const revised = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    revised.scenes[0].narration_text = revisedNarration;
    fs.writeFileSync(manifestPath, JSON.stringify(revised, null, 2), 'utf8');
    fs.writeFileSync(path.join(workspace, 'project', 'script.md'), `# Approved script\n\n${revisedNarration}`, 'utf8');
    const revisedShotlist = JSON.parse(fs.readFileSync(shotlistPath, 'utf8'));
    revisedShotlist.shots[0].narration = revisedNarration;
    fs.writeFileSync(shotlistPath, JSON.stringify(revisedShotlist), 'utf8');
    const checked = await tool.execute({
      op: 'composition.check_narration_fit',
      composition_dir: 'project/composition',
    }, ctx);
    expect(checked.isError, String(checked.content)).toBe(false);
    const checkedResult = parseResult(checked.content);
    expect(checkedResult.repair_authorization_status, JSON.stringify(checkedResult)).toBe('inheritable');
    expect(checkedResult).toMatchObject({ approval_inherited: true });
    expect((await tool.execute({
      op: 'composition.prepare',
      composition_dir: 'project/composition',
    }, ctx)).isError).toBe(false);

    const second = await tool.execute({
      op: 'composition.materialize_narration',
      composition_dir: 'project/composition',
    }, ctx);
    expect(second.isError).toBe(true);
    expect(parseResult(second.content)).toMatchObject({
      errorCode: 'E_NARRATION_TIMING_USER_DECISION_REQUIRED',
      requires_user_decision: true,
      automatic_retries_used: 1,
      automatic_retry_limit: 1,
    });
    const repeated = await tool.execute({
      op: 'composition.materialize_narration',
      composition_dir: 'project/composition',
    }, ctx);
    expect(parseResult(repeated.content)).toMatchObject({
      errorCode: 'E_NARRATION_TIMING_USER_DECISION_REQUIRED',
    });
    expect(ttsMock.generateSpeech).toHaveBeenCalledTimes(2);
    const blockedState = await stateMod.readVideoProductionState(
      toolMod.videoStudioProductionStatePath(opts, compositionDir),
      compositionDir,
    );
    expect(blockedState.narration_timing_episode).toMatchObject({
      automatic_retry_limit: 1,
      automatic_retries_used: 1,
      status: 'awaiting_user_decision',
    });
    expect(blockedState.narration_transaction_history).toHaveLength(1);
    expect(blockedState.narration_transaction_history[0]).toMatchObject({
      attempt_kind: 'initial',
      status: 'synthesized',
    });
    expect(blockedState.narration_transaction).toMatchObject({
      attempt_kind: 'automatic_timing_retry',
      status: 'synthesized',
    });

    const userRevised = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    userRevised.scenes[0].narration_text = userRevisedNarration;
    fs.writeFileSync(manifestPath, JSON.stringify(userRevised, null, 2), 'utf8');
    fs.writeFileSync(path.join(workspace, 'project', 'script.md'), `# Approved script\n\n${userRevisedNarration}`, 'utf8');
    const userRevisedShotlist = JSON.parse(fs.readFileSync(shotlistPath, 'utf8'));
    userRevisedShotlist.shots[0].narration = userRevisedNarration;
    fs.writeFileSync(shotlistPath, JSON.stringify(userRevisedShotlist), 'utf8');
    const continueTool = toolMod.createVideoStudioTool({
      ...opts,
      turnId: 'turn-continue-timing-revision',
      userMessage: '继续修改旁白',
    });
    const userChecked = await continueTool.execute({
      op: 'composition.check_narration_fit',
      composition_dir: 'project/composition',
      decision_evidence: decisionEvidence('narration_retry', 'approve', '继续修改旁白'),
    }, ctx);
    expect(userChecked.isError, String(userChecked.content)).toBe(false);
    expect(parseResult(userChecked.content)).toMatchObject({ approval_inherited: true });
    expect((await continueTool.execute({
      op: 'composition.prepare',
      composition_dir: 'project/composition',
    }, ctx)).isError).toBe(false);
    const userAuthorizedAttempt = await continueTool.execute({
      op: 'composition.materialize_narration',
      composition_dir: 'project/composition',
    }, ctx);
    expect(userAuthorizedAttempt.isError).toBe(true);
    expect(parseResult(userAuthorizedAttempt.content)).toMatchObject({
      errorCode: 'E_NARRATION_TIMING_USER_DECISION_REQUIRED',
      requires_user_decision: true,
    });
    expect(ttsMock.generateSpeech).toHaveBeenCalledTimes(3);
    const afterUserAttempt = await stateMod.readVideoProductionState(
      toolMod.videoStudioProductionStatePath(opts, compositionDir),
      compositionDir,
    );
    expect(afterUserAttempt.narration_transaction).toMatchObject({
      attempt_kind: 'user_authorized_timing_retry',
      status: 'synthesized',
    });
    expect(afterUserAttempt.narration_timing_episode).toMatchObject({
      status: 'awaiting_user_decision',
      user_authorized_requests: 1,
      user_authorization_consumed: 1,
    });

    const waiverTool = toolMod.createVideoStudioTool({
      ...opts,
      turnId: 'turn-accept-current-timing',
      userMessage: '推进下一步',
    });
    const accepted = await waiverTool.execute({
      op: 'composition.materialize_narration',
      composition_dir: 'project/composition',
      decision_evidence: decisionEvidence('narration_retry', 'reject', '推进下一步'),
    }, ctx);
    expect(accepted.isError, String(accepted.content)).toBe(false);
    expect(ttsMock.generateSpeech).toHaveBeenCalledTimes(3);
    const acceptedManifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    expect(acceptedManifest.composition).toMatchObject({ target_duration: 45, duration: 52 });
    const finalState = await stateMod.readVideoProductionState(
      toolMod.videoStudioProductionStatePath(opts, compositionDir),
      compositionDir,
    );
    expect(finalState.narration_timing_episode).toMatchObject({
      status: 'accepted_by_user_waiver',
      automatic_retries_used: 1,
      user_waiver: { turn_id: 'turn-accept-current-timing' },
    });
    expect(finalState.narration_transaction).toBeUndefined();
    expect(finalState.narration_transaction_history).toHaveLength(3);
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
    // Relocating retired plan files is no longer drift: the plan is the
    // manifest, and it lives inside the composition it describes. What
    // remains here is the real compound drift — an orphaned operation plus a
    // superseded candidate.

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
      plan_record_refresh_required: false,
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
      // Nothing to refresh: the plan is one file at a known path.
      plan_record_refreshed: false,
      // The candidate travels once, at top level; superseded candidates
      // travel as their count on working results (2026-08-07 projection) and
      // stay reviewable through composition.status and durable state.
      current_candidate: {
        revision_id: expect.stringMatching(/^candidate-/),
        parent_revision_id: `candidate-${contentHash.slice(0, 16)}`,
      },
      production_state: {
        stage: 'visuals_ready',
        draft_status: 'missing',
        candidate_history_count: 1,
        operation_journal: [expect.objectContaining({
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

    const statusAfter = parseResult((await tool.execute({
      op: 'composition.status',
      composition_dir: 'project/composition',
    }, ctx)).content);
    expect(statusAfter).toMatchObject({
      reconciliation_required: false,
      plan_record_refresh_required: false,
      plan_artifact_conflict: false,
    });
    // The plan records are a status fact: working results carry
    // plan_approval without artifact_records (2026-08-07 projection);
    // composition.status returns the full picture, and the plan is one file.
    expect(statusAfter.production_state.plan_approval.artifact_records).toMatchObject({
      manifest: { path: path.join(compositionDir, 'composition-manifest.json') },
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
      // Top level is the candidate's one place on working results
      // (2026-08-07 projection); the superseded candidate travels as its
      // count and stays reviewable through composition.status.
      current_candidate: {
        content_hash: newContentHash,
        parent_revision_id: oldCandidate!.revision_id,
      },
      production_state: {
        stage: 'visuals_ready',
        preview_status: 'missing',
        draft_status: 'missing',
        candidate_history_count: 1,
      },
    });
    // The superseded revision is counted, not carried: nothing reads its
    // entry, and its bytes were mostly frozen-store paths.
    expect(recovered.production_state).not.toHaveProperty('candidate_history');
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
    const visualHash = await toolMod.videoStudioVisualCompositionSignature(compositionDir);
    await stateMod.updateVideoProductionState(statePath, compositionDir, (state) => {
      const startedAt = new Date(0).toISOString();
      state.preview = {
        gate: 'HTML_PREVIEW',
        status: 'approved',
        signature: contentHash,
        visual_signature: visualHash,
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
          status: 'interrupted',
          error_code: 'E_VIDEO_PRODUCTION_OPERATION_INTERRUPTED',
          consumes_same_input_attempt: false,
        })],
      },
    });
    expect(recovered.production_state).not.toHaveProperty('active_operation');
    expect(recovered.production_state.next_allowed_ops).toContain('composition.draft');
  });

  it.each([
    {
      // What the retired script.md row used to cover: the words the video
      // speaks are approved intent, and they live in the manifest now.
      label: 'manifest narration meaning',
      expectedPath: 'manifest.scenes[0].narration_text',
      mutate: () => {
        const manifestPath = path.join(compositionDir, 'composition-manifest.json');
        const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
        manifest.scenes[0].narration_text = 'A materially different message.';
        fs.writeFileSync(manifestPath, JSON.stringify(manifest), 'utf8');
      },
    },
    {
      label: 'manifest delivery contract',
      expectedPath: 'manifest.composition.caption_mode',
      mutate: () => {
        const manifestPath = path.join(compositionDir, 'composition-manifest.json');
        const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
        manifest.composition.caption_mode = 'burned';
        fs.writeFileSync(manifestPath, JSON.stringify(manifest), 'utf8');
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
          role: 'plan_manifest',
          review_status: 'current_input',
        },
        artifacts: expect.arrayContaining([
          expect.objectContaining({ role: 'plan_manifest' }),
        ]),
      },
    });
    expect(published.flat()).toEqual(expect.arrayContaining([
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

  it('opens Gate B for narration that finishes early and still stops a real overrun', async () => {
    // 2026-08-04 production run: one turn raised ten narration-fit failures,
    // six of them "under" ("6.63s for an 8s target"), and three Gate B
    // reopenings existed only to pad scripts to a word count. Trailing silence
    // is a normal edit; an overrun is speech past the composition's end that
    // nobody hears. Only the second one may stop the plan.
    const toolMod = await import('../../../../src/main/model/core-agent/video-studio-tool');
    const ctx = { workingDir: workspace, state: {} } as any;
    const planFor = async (cid: string, estimatedSec: number) => {
      ttsMock.estimateNarrationDuration.mockImplementation(() => ({
        estimatedSec,
        unit: 'words',
        units: 12,
        unitsPerSec: 1,
      }));
      const tool = toolMod.createVideoStudioTool({
        userId: UID,
        cid,
        turnId: `turn-${cid}`,
        agentId: VIDEO_STUDIO_AGENT_ID,
        agentName: 'VideoStudio',
        userMessage: '确认',
      });
      const check = await tool.execute({
        op: 'composition.check_narration_fit',
        composition_dir: 'project/composition',
      }, ctx);
      const approval = await tool.execute({
        op: 'composition.approve_plan',
        composition_dir: 'project/composition',
        decision_evidence: decisionEvidence('plan', 'approve', '确认'),
      }, ctx);
      return { check: parseResult(check.content), approval, approvalResult: parseResult(approval.content) };
    };

    // The five-second floor makes a 5s target accept any positive read up to 10s.
    const early = await planFor('cid-fit-early-finish', 3.5);
    expect(early.check).toMatchObject({
      status: 'fits',
      gate_b_ready: true,
      next_action: 'open_gate_b',
    });
    expect(early.approval.isError, String(early.approval.content)).toBe(false);
    expect(early.approval.content).not.toContain('E_GATE_B_NARRATION_FIT_REQUIRED');

    // 5.3s: inside the estimator's own error on a 5s target, so it is not worth
    // a revision round. The retired flat 150ms band called this an overrun.
    const marginal = await planFor('cid-fit-marginal-overrun', 5.3);
    expect(marginal.check).toMatchObject({ status: 'fits', gate_b_ready: true });
    expect(marginal.approval.isError, String(marginal.approval.content)).toBe(false);

    // Negative control: exceeding the five-second floor still blocks.
    const overrun = await planFor('cid-fit-real-overrun', 10.01);
    expect(overrun.check).toMatchObject({
      status: 'over',
      gate_b_ready: false,
      next_action: 'revise_narration_then_composition.check_narration_fit',
    });
    expect(overrun.approval.isError).toBe(true);
    expect(overrun.approvalResult).toMatchObject({
      errorCode: 'E_GATE_B_NARRATION_FIT_REQUIRED',
      gate_b_ready: false,
      requires_user_decision: false,
    });
    expect(ttsMock.generateSpeech).not.toHaveBeenCalled();
  });

  it('inherits Gate B for a production-shaped narration_text timing repair without another approval or paid check', async () => {
    const toolMod = await import('../../../../src/main/model/core-agent/video-studio-tool');
    const stateMod = await import('../../../../src/main/features/video_studio_state');
    const originalNarration = 'How did next-word prediction become systems reasoning, seeing, and using tools? In 2017, the Transformer made attention-based training parallel and scalable. In 2018, BERT learned from both sides of context, adapted across language tasks. By 2020, GPT-3 showed scale unlocked few-shot learning from instructions and examples. In 2022, ChatGPT brought prompting to a global audience. In 2024, multimodal models connected text, images, and audio, while reasoning models computed before answering. In 2025, DeepSeek-R1 opened reasoning further, while tool use pushed models toward agents. The pattern: attention enabled scale; scale enabled generality; reasoning and tools turn prediction into problem-solving.';
    // The converging repair trims one clause: a measured overrun is the only
    // verdict that blocks delivery, because anything past the composition's
    // approved end is speech the viewer never hears.
    const revisedNarration = originalNarration.replace(', adapted across language tasks', '');
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
    const trimmed = (text: string) => !text.includes('adapted across language tasks');
    ttsMock.estimateNarrationDuration.mockImplementation((text: string) => ({
      estimatedSec: trimmed(text) ? 50 : 56,
      unit: 'words',
      units: trimmed(text) ? 94 : 98,
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
        measured_duration_sec: 67.2,
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
      narration_fit: { status: 'over', source: 'measured_calibration' },
    });
    const calibrated = await stateMod.readVideoProductionState(statePath, compositionDir);
    expect(calibrated.narration_calibration).toMatchObject({
      backend: 'mock-voice',
      duration_scale: 1.2,
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
          role: 'plan_manifest',
          review_status: 'current_input',
        },
        artifacts: expect.arrayContaining([
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
        generic_estimated_duration_sec: 50,
        estimated_duration_sec: 60,
      },
      production_state: {
        stage: 'manifest_ready',
        plan_approval: { inheritance_reason: 'measured_narration_fit_repair' },
      },
    });

    const afterApproval = await stateMod.readVideoProductionState(statePath, compositionDir);
    expect(afterApproval.narration_transaction).toBeUndefined();
    expect(afterApproval.narration_repair).toBeUndefined();
    expect(afterApproval.narration_calibration?.duration_scale).toBe(1.2);
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
          measured_duration_sec: 10.02,
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
      const revisedManifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      revisedManifest.scenes[0].narration_text = scenario.revisedNarration;
      // Structure now lives entirely in the manifest: approved on-screen copy
      // is signed intent, so changing it is the structural change this
      // scenario used to make through a shotlist field.
      if (scenario.changeStructure) revisedManifest.scenes[0].approved_copy = ['A different visual plan.'];
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

  it('consumes a confirmed reviewed plan even when the model chooses the fit check and rewrites the manifest first', async () => {
    // 2026-08-10 production trace: the model twice said it understood
    // "可以继续" / "确认", rewrote the manifest, called the free fit check,
    // and then showed the same plan confirmation again. The user decision must
    // survive both mistakes and remain bound to the candidate they actually saw.
    const toolMod = await import('../../../../src/main/model/core-agent/video-studio-tool');
    const stateMod = await import('../../../../src/main/features/video_studio_state');
    const ctx = { workingDir: workspace, state: {} } as any;
    const planningOpts = {
      userId: UID,
      cid: 'cid-reviewed-plan-decision-handoff',
      turnId: 'turn-plan-presented',
      agentId: VIDEO_STUDIO_AGENT_ID,
      agentName: 'VideoStudio',
      userMessage: '选择生活场景方向',
    };
    const planningTool = toolMod.createVideoStudioTool(planningOpts);
    const checked = await planningTool.execute({
      op: 'composition.check_narration_fit',
      composition_dir: 'project/composition',
    }, ctx);
    expect(checked.isError, String(checked.content)).toBe(false);
    const checkedResult = parseResult(checked.content);
    expect(checkedResult).toMatchObject({
      gate_b_ready: true,
      gate_b_required: true,
      next_action: 'open_gate_b',
      production_state: {
        plan_review_candidate: {
          checked_turn_id: 'turn-plan-presented',
          validation_version: 1,
        },
      },
    });
    expect(checkedResult.production_state.plan_review_candidate.manifest_json).toBeUndefined();

    const statePath = toolMod.videoStudioProductionStatePath(planningOpts, compositionDir);
    const reviewedState = await stateMod.readVideoProductionState(statePath, compositionDir);
    const reviewedSignature = reviewedState.plan_review_candidate?.signature;
    expect(reviewedSignature).toMatch(/^[a-f0-9]{64}$/);
    expect(reviewedState.plan_review_candidate?.checked_turn_id).toBe('turn-plan-presented');

    const sourceAsset = path.join(workspace, 'project', 'source-assets', 'reference.bin');
    fs.mkdirSync(path.dirname(sourceAsset), { recursive: true });
    fs.writeFileSync(sourceAsset, Buffer.from('existing user material'));
    const sourceAssetSha = crypto.createHash('sha256').update(fs.readFileSync(sourceAsset)).digest('hex');

    // Reproduce the unauthorized rewrite from the real trace before the first
    // VideoStudio call in the confirmation turn.
    const manifestPath = path.join(compositionDir, 'composition-manifest.json');
    const rewritten = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    rewritten.scenes[0].approved_copy = ['Agent-authored replacement'];
    fs.writeFileSync(manifestPath, JSON.stringify(rewritten, null, 2), 'utf8');

    const approvalOpts = {
      ...planningOpts,
      turnId: 'turn-user-approved',
      userMessage: '可以继续',
    };
    const approvalTool = toolMod.createVideoStudioTool(approvalOpts);
    const unresolved = await approvalTool.execute({
      op: 'composition.check_narration_fit',
      composition_dir: 'project/composition',
    }, ctx);
    expect(unresolved.isError).toBe(true);
    expect(parseResult(unresolved.content)).toMatchObject({
      errorCode: 'E_DECISION_EVIDENCE_REQUIRED',
      requires_user_decision: false,
      user_reconfirmation_required: false,
      next_step_owner: 'agent',
      presentation_required: false,
      next_action: 'classify_current_reply_then_retry_with_evidence_or_continue_without_gate',
    });

    // The model is free to retry the operation it originally chose. The tool
    // consumes the turn-scoped approval first, restores the reviewed candidate,
    // and records its signature without another user interaction.
    const approved = await approvalTool.execute({
      op: 'composition.check_narration_fit',
      composition_dir: 'project/composition',
      decision_evidence: decisionEvidence('plan', 'approve', '可以继续'),
    }, ctx);
    expect(approved.isError, String(approved.content)).toBe(false);
    expect(parseResult(approved.content)).toMatchObject({
      status: 'approved',
      plan_signature: reviewedSignature,
      decision_routed_from_op: 'composition.check_narration_fit',
      reviewed_plan_restored: true,
      requires_user_decision: false,
    });
    const restoredManifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    expect(restoredManifest.scenes[0].approved_copy).toEqual(['Approved']);
    expect(crypto.createHash('sha256').update(fs.readFileSync(sourceAsset)).digest('hex')).toBe(sourceAssetSha);

    const approvedState = await stateMod.readVideoProductionState(statePath, compositionDir);
    expect(approvedState.plan_approval?.signature).toBe(reviewedSignature);
    expect(approvedState.plan_review_candidate).toBeUndefined();
    expect(ttsMock.generateSpeech).not.toHaveBeenCalled();
  });

  it('removes a reviewed plan candidate when the free narration fit is no longer ready', async () => {
    const toolMod = await import('../../../../src/main/model/core-agent/video-studio-tool');
    const stateMod = await import('../../../../src/main/features/video_studio_state');
    const ctx = { workingDir: workspace, state: {} } as any;
    const opts = {
      userId: UID,
      cid: 'cid-reviewed-plan-fit-regressed',
      turnId: 'turn-plan-authoring',
      agentId: VIDEO_STUDIO_AGENT_ID,
      agentName: 'VideoStudio',
      userMessage: '准备制作方案',
    };
    const tool = toolMod.createVideoStudioTool(opts);
    expect((await tool.execute({
      op: 'composition.check_narration_fit',
      composition_dir: 'project/composition',
    }, ctx)).isError).toBe(false);
    const statePath = toolMod.videoStudioProductionStatePath(opts, compositionDir);
    expect((await stateMod.readVideoProductionState(statePath, compositionDir)).plan_review_candidate)
      .toBeDefined();

    ttsMock.estimateNarrationDuration.mockReturnValue({
      estimatedSec: 20,
      unit: 'words',
      units: 20,
      unitsPerSec: 1,
    });
    const blocked = await tool.execute({
      op: 'composition.check_narration_fit',
      composition_dir: 'project/composition',
    }, ctx);
    expect(blocked.isError, String(blocked.content)).toBe(false);
    expect(parseResult(blocked.content)).toMatchObject({
      gate_b_ready: false,
      gate_b_required: true,
      next_action: 'revise_narration_then_composition.check_narration_fit',
    });
    expect((await stateMod.readVideoProductionState(statePath, compositionDir)).plan_review_candidate)
      .toBeUndefined();
    expect(ttsMock.generateSpeech).not.toHaveBeenCalled();
  });

  it('keeps an explicit user revision flexible and refreshes only the reviewed plan candidate', async () => {
    const toolMod = await import('../../../../src/main/model/core-agent/video-studio-tool');
    const stateMod = await import('../../../../src/main/features/video_studio_state');
    const ctx = { workingDir: workspace, state: {} } as any;
    const planningOpts = {
      userId: UID,
      cid: 'cid-reviewed-plan-explicit-revision',
      turnId: 'turn-plan-presented',
      agentId: VIDEO_STUDIO_AGENT_ID,
      agentName: 'VideoStudio',
      userMessage: '选择方向',
    };
    const planningTool = toolMod.createVideoStudioTool(planningOpts);
    expect((await planningTool.execute({
      op: 'composition.check_narration_fit',
      composition_dir: 'project/composition',
    }, ctx)).isError).toBe(false);
    const statePath = toolMod.videoStudioProductionStatePath(planningOpts, compositionDir);
    const before = await stateMod.readVideoProductionState(statePath, compositionDir);
    const priorSignature = before.plan_review_candidate?.signature;

    const sourceAsset = path.join(workspace, 'project', 'source-assets', 'reference.bin');
    fs.mkdirSync(path.dirname(sourceAsset), { recursive: true });
    fs.writeFileSync(sourceAsset, Buffer.from('existing user material'));
    const sourceAssetSha = crypto.createHash('sha256').update(fs.readFileSync(sourceAsset)).digest('hex');
    const manifestPath = path.join(compositionDir, 'composition-manifest.json');
    const revised = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    revised.scenes[0].approved_copy = ['Use the shorter title'];
    fs.writeFileSync(manifestPath, JSON.stringify(revised, null, 2), 'utf8');

    const revisionTool = toolMod.createVideoStudioTool({
      ...planningOpts,
      turnId: 'turn-user-revised',
      userMessage: '标题改短一点',
    });
    const rechecked = await revisionTool.execute({
      op: 'composition.check_narration_fit',
      composition_dir: 'project/composition',
      decision_evidence: decisionEvidence('plan', 'revise', '标题改短一点'),
    }, ctx);
    expect(rechecked.isError, String(rechecked.content)).toBe(false);
    expect(parseResult(rechecked.content)).toMatchObject({
      gate_b_ready: true,
      gate_b_required: true,
      next_action: 'open_gate_b',
    });
    expect(JSON.parse(fs.readFileSync(manifestPath, 'utf8')).scenes[0].approved_copy)
      .toEqual(['Use the shorter title']);
    expect(crypto.createHash('sha256').update(fs.readFileSync(sourceAsset)).digest('hex')).toBe(sourceAssetSha);

    const after = await stateMod.readVideoProductionState(statePath, compositionDir);
    expect(after.plan_approval).toBeUndefined();
    expect(after.plan_review_candidate?.signature).toMatch(/^[a-f0-9]{64}$/);
    expect(after.plan_review_candidate?.signature).not.toBe(priorSignature);
    expect(after.plan_review_candidate?.checked_turn_id).toBe('turn-user-revised');
    expect(ttsMock.generateSpeech).not.toHaveBeenCalled();
  });
});
