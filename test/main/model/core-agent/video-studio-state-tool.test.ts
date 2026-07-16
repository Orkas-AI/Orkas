import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const ttsMock = vi.hoisted(() => ({
  estimateNarrationDuration: vi.fn(),
  generateSpeech: vi.fn(),
}));

vi.mock('../../../../src/main/features/permissions', () => ({
  getLocalExecGranted: () => true,
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
  return JSON.parse(content);
}

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
    expect(mod.explicitVideoStudioGateDecision(
      approvalSubmission('gate_d_decision', 'approve'),
      'draft',
    )).toBe('approve');
    expect(mod.explicitVideoStudioGateDecision(
      approvalSubmission('gate_c_decision', 'approve'),
      'generation',
    )).toBe('approve');
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
    )).toBe('approve');
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
    )).toBe('approve');
    expect(mod.explicitVideoStudioGateDecision(
      '<msg from="user" to="79df9cc89f5f">@VideoStudio\n现在可以继续吗？</msg>',
      'plan',
    )).toBe('unknown');
    expect(mod.explicitVideoStudioGateDecision(
      '<msg from="agent">确认</msg><msg from="user">请先调整字幕</msg>',
      'plan',
    )).toBe('reject');
    expect(mod.explicitVideoStudioGateDecision(
      '<msg from="user">确认</msg><msg from="user">请先调整字幕</msg>',
      'plan',
    )).toBe('reject');
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

  it('does not fork composition state when only project routing metadata changes', async () => {
    const toolMod = await import('../../../../src/main/model/core-agent/video-studio-tool');
    const base = { userId: UID, cid: 'cid-one', projectId: 'project-one' };
    const resumed = { userId: UID, cid: 'cid-two', projectId: 'project-two' };
    expect(toolMod.videoStudioProductionStatePath(base, compositionDir))
      .toBe(toolMod.videoStudioProductionStatePath(resumed, compositionDir));
  });

  it('requires gate-specific approval content, not merely a later turn', async () => {
    const mod = await import('../../../../src/main/model/core-agent/video-studio-tool');
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

    const previewApprovalTool = mod.createVideoStudioTool({
      userId: UID,
      cid: 'cid-explicit-gates',
      turnId: 'turn-preview-approval',
      agentId: VIDEO_STUDIO_AGENT_ID,
      agentName: 'VideoStudio',
      userMessage: approvalSubmission('preview_decision', 'approve'),
    });
    expect((await previewApprovalTool.execute({
      op: 'composition.approve_preview',
      composition_dir: 'project/composition',
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
      },
    });
    expect(failedPayload.production_state.active_operation).toBeUndefined();
  });

  it('blocks repeated snapshot retries until the composition artifact changes', async () => {
    const videoStudio = await import('../../../../src/main/features/video_studio');
    const toolMod = await import('../../../../src/main/model/core-agent/video-studio-tool');
    const stateMod = await import('../../../../src/main/features/video_studio_state');
    const opts = {
      userId: UID,
      cid: 'cid-snapshot-retry',
      turnId: 'turn-preview',
      agentId: VIDEO_STUDIO_AGENT_ID,
      agentName: 'VideoStudio',
      userMessage: '确认',
    };
    const statePath = toolMod.videoStudioProductionStatePath(opts, compositionDir);
    const tool = toolMod.createVideoStudioTool(opts);
    expect((await tool.execute({
      op: 'composition.approve_plan',
      composition_dir: 'project/composition',
    }, { workingDir: workspace, state: {} } as any)).isError).toBe(false);
    await stateMod.updateVideoProductionState(statePath, compositionDir, (state) => {
      state.stage = 'visuals_ready';
    });
    const snapshot = vi.spyOn(videoStudio, 'snapshotComposition').mockResolvedValue({
      ok: false,
      op: 'composition.snapshot',
      errorCode: 'E_PREVIEW_QA_BLOCKED',
      message: 'Preview frame coverage or scene semantics failed QA.',
      preview_ready: false,
    } as any);

    const ctx = { state: {}, emitProgress: vi.fn() } as any;
    const input = {
      op: 'composition.snapshot',
      composition_dir: 'project/composition',
      output_path: 'project/composition/preview-contact-sheet.mp4',
    };
    const first = await tool.execute(input, ctx);
    expect(first.isError).toBe(true);
    expect(snapshot).toHaveBeenCalledTimes(1);
    expect((snapshot.mock.calls[0]?.[0] as any).snapshotAbsPath).toMatch(/preview-contact-sheet\.png$/);

    const second = await tool.execute(input, ctx);
    expect(second.isError).toBe(true);
    expect(second.content).toContain('E_SNAPSHOT_RETRY_NO_CHANGE');
    expect(snapshot).toHaveBeenCalledTimes(1);

    fs.appendFileSync(path.join(compositionDir, 'index.html'), '\n<!-- repaired -->\n');
    const third = await tool.execute(input, ctx);
    expect(third.isError).toBe(true);
    expect(snapshot).toHaveBeenCalledTimes(2);

    fs.appendFileSync(path.join(compositionDir, 'index.html'), '\n<!-- repaired again -->\n');
    const fourth = await tool.execute(input, ctx);
    expect(fourth.isError).toBe(true);
    expect(snapshot).toHaveBeenCalledTimes(3);

    fs.appendFileSync(path.join(compositionDir, 'index.html'), '\n<!-- attempted third repair -->\n');
    const exhausted = await tool.execute(input, ctx);
    expect(exhausted.isError).toBe(true);
    expect(exhausted.content).toContain('E_VISUAL_REPAIR_BUDGET_EXCEEDED');
    expect(snapshot).toHaveBeenCalledTimes(3);
  });

  it('blocks repeated inspect retries until visual inputs change', async () => {
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
    });
    expect(inspect).toHaveBeenCalledTimes(2);
    expect(snapshot).toHaveBeenCalledTimes(1);
    const state = await stateMod.readVideoProductionState(statePath, compositionDir);
    expect(state.visual_qa?.cycle).toMatchObject({
      inspector_version: 2,
      status: 'exhausted',
      failed_signatures: expect.any(Array),
    });
    expect(state.visual_qa?.cycle?.failed_signatures).toHaveLength(3);
  });

  it('invalidates an exhausted legacy cycle when the inspector version changes', async () => {
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
    expect((await tool.execute({ op: 'composition.approve_plan', composition_dir: 'project/composition' }, ctx)).isError).toBe(false);
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
    expect(migrated.visual_qa?.cycle).toMatchObject({ inspector_version: 2, failed_signatures: [] });
    expect(migrated.visual_qa?.history?.[0]).toMatchObject({ inspector_version: 1, status: 'exhausted' });
  });

  it('starts an authorized visual revision atomically while preserving plan and narration', async () => {
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
        text_sha256: 'text-hash',
        audio_sha256: 'audio-hash',
        path: path.join(compositionDir, 'assets', 'narration.mp3'),
        measured_duration_sec: 4.8,
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

    const unauthorized = await toolMod.createVideoStudioTool({
      ...baseOpts,
      turnId: 'turn-unrelated',
      userMessage: '确认',
    }).execute({
      op: 'composition.begin_visual_revision',
      composition_dir: 'project/composition',
    }, ctx);
    expect(unauthorized.isError).toBe(true);
    expect(unauthorized.content).toContain('E_VISUAL_REVISION_EXPLICIT_AUTHORIZATION_REQUIRED');

    const recoveryOpts = {
      ...baseOpts,
      turnId: 'turn-visual-revision',
      userMessage: approvalSubmission('visual_recovery_decision', 'new_visual_revision'),
    };
    const recoveryTool = toolMod.createVideoStudioTool(recoveryOpts);
    const started = await recoveryTool.execute({
      op: 'composition.begin_visual_revision',
      composition_dir: 'project/composition',
    }, ctx);
    expect(started.isError).toBe(false);
    expect(parseResult(started.content)).toMatchObject({
      status: 'started',
      visual_revision: 1,
      inspector_version: 2,
      next_action: 'composition.lint',
    });

    const revised = await stateMod.readVideoProductionState(statePath, compositionDir);
    expect(revised.revision).toBeGreaterThan(before.revision);
    expect(revised.stage).toBe('visuals_ready');
    expect(revised.plan_approval?.signature).toBe(approvalSignature);
    expect(revised.narration).toMatchObject({ text_sha256: 'text-hash', audio_sha256: 'audio-hash' });
    expect(revised.visual_qa?.cycle).toMatchObject({
      inspector_version: 2,
      visual_revision: 1,
      status: 'active',
      failed_signatures: [],
      started_by_turn_id: 'turn-visual-revision',
    });
    expect(revised.visual_qa?.history?.[0]).toMatchObject({
      inspector_version: 1,
      status: 'exhausted',
      failed_signatures: ['first', 'repair-1', 'repair-2'],
    });

    const repeated = await recoveryTool.execute({
      op: 'composition.begin_visual_revision',
      composition_dir: 'project/composition',
    }, ctx);
    expect(repeated.isError).toBe(false);
    expect(parseResult(repeated.content).status).toBe('already_started');

    const inspect = vi.spyOn(videoStudio, 'inspectComposition').mockResolvedValue({
      ok: true,
      op: 'composition.inspect',
      status: 'passed',
      blocking_error_count: 0,
      findings: JSON.stringify({ issues: [] }),
    } as any);
    const checked = await recoveryTool.execute({
      op: 'composition.inspect',
      composition_dir: 'project/composition',
    }, ctx);
    expect(checked.isError).toBe(false);
    expect(inspect).toHaveBeenCalledTimes(1);
  });

  it('registers and publishes an approved export after rendering', async () => {
    const videoStudio = await import('../../../../src/main/features/video_studio');
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
    }, { workingDir: workspace, state: {} } as any);
    expect(review.isError).toBe(false);
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

  it('enforces Gate B, auto-checks capabilities, then reconciles authored visual state', async () => {
    const mod = await import('../../../../src/main/model/core-agent/video-studio-tool');
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
    }, ctx);
    expect(approved.isError).toBe(false);
    expect(parseResult(approved.content).production_state).toMatchObject({ stage: 'manifest_ready' });

    const prepared = await tool.execute({
      op: 'composition.prepare',
      composition_dir: 'project/composition',
    }, ctx);
    expect(prepared.isError).toBe(false);
    expect(parseResult(prepared.content).production_state).toMatchObject({
      stage: 'scaffold_ready',
      capability_check: { status: 'ready' },
    });

    const blockedDraft = await tool.execute({
      op: 'composition.draft',
      composition_dir: 'project/composition',
      output_path: 'project/render/draft.mp4',
    }, ctx);
    expect(blockedDraft.isError).toBe(true);
    expect(blockedDraft.content).toContain('E_VIDEO_PRODUCTION_STAGE_INVALID');

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
      stage: 'visuals_ready',
      next_allowed_ops: expect.arrayContaining(['composition.draft', 'composition.snapshot']),
    });
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
      const result = await tool.execute({ op, composition_dir: 'project/composition' }, ctx);
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
      production_state: { stage: 'narration_ready' },
    });
    expect(ttsMock.generateSpeech).not.toHaveBeenCalled();
    expect(fs.existsSync(path.join(compositionDir, 'narration-map.json'))).toBe(true);
    const finalState = await stateMod.readVideoProductionState(statePath, compositionDir);
    expect(finalState.narration_transaction).toBeUndefined();
    expect(finalState.narration).toMatchObject({ status: 'materialized', backend: 'mock-previous' });
  });

  it('inherits Gate B for a bounded measured-duration repair without another approval or paid check', async () => {
    const toolMod = await import('../../../../src/main/model/core-agent/video-studio-tool');
    const stateMod = await import('../../../../src/main/features/video_studio_state');
    const originalNarration = 'How did next-word prediction become systems that reason, see, and use tools? In 2017, the Transformer made attention-based language training parallel and scalable. In 2018, BERT learned from both sides of context, adapted across language tasks. By 2020, GPT-3 showed scale unlocked few-shot learning from instructions and examples. In 2022, ChatGPT brought prompting to a global audience. In 2024, multimodal models connected text, images, and audio, while reasoning models computed longer before answering. In 2025, DeepSeek-R1 opened reasoning further, while tool use pushed models toward agents. The pattern: attention enabled scale; scale enabled generality; reasoning and tools turn prediction into problem-solving.';
    const revisedNarration = 'How did next-word prediction become systems reasoning, seeing, and using tools? In 2017, the Transformer made attention-based training parallel and scalable. In 2018, BERT learned from both sides of context, adapted across language tasks. By 2020, GPT-3 showed scale unlocked few-shot learning from instructions and examples. In 2022, ChatGPT brought prompting to a global audience. In 2024, multimodal models connected text, images, and audio, while reasoning models computed before answering. In 2025, DeepSeek-R1 opened reasoning further, while tool use pushed models toward agents. The pattern: attention enabled scale; scale enabled generality; reasoning and tools turn prediction into problem-solving.';
    fs.writeFileSync(path.join(workspace, 'project', 'script.md'), `# Approved script\n\n${originalNarration}`, 'utf8');
    const initialShotlistPath = path.join(workspace, 'project', 'shotlist.json');
    const initialShotlist = JSON.parse(fs.readFileSync(initialShotlistPath, 'utf8'));
    initialShotlist.target_duration_seconds = 60;
    initialShotlist.shots[0].narration = originalNarration;
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
      estimatedSec: text.includes('longer') ? 56 : 48.42,
      unit: 'words',
      units: text.includes('longer') ? 101 : 98,
      unitsPerSec: 1,
    }));

    for (const op of ['composition.approve_plan', 'composition.doctor', 'composition.prepare']) {
      const result = await tool.execute({ op, composition_dir: 'project/composition' }, ctx);
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
        generic_estimated_duration_sec: 49.62,
        narration_unit: 'words',
        narration_units: 101,
        audio_sha256: sha(audioPath),
        measured_duration_sec: 61.584,
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
      duration_scale: 1.2411,
      narration_units: 101,
    });

    fs.writeFileSync(path.join(workspace, 'project', 'script.md'), `# Approved script\n\n${revisedNarration}`, 'utf8');
    const shotlistPath = path.join(workspace, 'project', 'shotlist.json');
    const shotlist = JSON.parse(fs.readFileSync(shotlistPath, 'utf8'));
    shotlist.shots[0].narration = revisedNarration;
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
        generic_estimated_duration_sec: 48.42,
        estimated_duration_sec: 60.09,
      },
      production_state: {
        stage: 'manifest_ready',
        plan_approval: { inheritance_reason: 'measured_narration_fit_repair' },
      },
    });

    const afterApproval = await stateMod.readVideoProductionState(statePath, compositionDir);
    expect(afterApproval.narration_transaction).toBeUndefined();
    expect(afterApproval.narration_repair).toBeUndefined();
    expect(afterApproval.narration_calibration?.duration_scale).toBe(1.2411);
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
      fs.rmSync(toolMod.videoStudioProductionStatePath(opts, compositionDir), { force: true });
      for (const op of ['composition.approve_plan', 'composition.doctor', 'composition.prepare']) {
        const result = await tool.execute({ op, composition_dir: 'project/composition' }, ctx);
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
