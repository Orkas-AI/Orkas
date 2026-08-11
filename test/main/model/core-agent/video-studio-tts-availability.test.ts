import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const disabledVoice = vi.hoisted(() => ({
  available: false as const,
  reason: 'not_configured' as const,
  errorCode: 'E_TTS_NOT_CONFIGURED',
  message: 'No text-to-speech service is configured. Open Settings > Credentials and add a text-to-speech service before using narration.',
  nextAction: 'ask_user_to_configure_a_speech_provider',
}));

const speechRuntime = vi.hoisted(() => ({
  generateSpeech: vi.fn(),
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

vi.mock('../../../../src/main/features/tts', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../../../src/main/features/tts')>(),
  hasConfiguredTtsProvider: () => false,
  generateSpeech: speechRuntime.generateSpeech,
}));

vi.mock('../../../../src/main/features/tts_capabilities', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../../../src/main/features/tts_capabilities')>(),
  listTtsCapabilities: async () => [],
  getTtsAvailabilityDetails: () => disabledVoice,
  resolveTtsSelection: async () => ({
    ok: false as const,
    errorCode: disabledVoice.errorCode,
    message: disabledVoice.message,
  }),
}));

vi.mock('../../../../src/main/util/bundled-runtime', () => ({
  bundledFfmpegPaths: () => ({ ffmpeg: process.execPath, ffprobe: process.execPath }),
  bundledWhisperPaths: () => ({ cli: process.execPath, model: process.execPath }),
}));

vi.mock('electron', () => ({
  BrowserWindow: function BrowserWindow() {},
  session: {},
}));

const UID = 'voice-disabled-user';
let root = '';
let workspace = '';
let previousWorkspaceRoot: string | undefined;

function writeNarratedComposition(): void {
  const projectDir = path.join(workspace, 'project');
  const compositionDir = path.join(projectDir, 'composition');
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

beforeEach(async () => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-disabled-voice-')));
  workspace = path.join(root, 'workspace');
  fs.mkdirSync(workspace, { recursive: true });
  previousWorkspaceRoot = process.env.ORKAS_WORKSPACE_ROOT;
  process.env.ORKAS_WORKSPACE_ROOT = path.join(root, 'data');
  vi.resetModules();
  speechRuntime.generateSpeech.mockReset();

  const users = await import('../../../../src/main/features/users');
  users.activateUser(UID);
  const userWorkspace = await import('../../../../src/main/features/user_workspace');
  const configured = userWorkspace.setWorkspacePath(UID, workspace);
  if (!configured.ok) throw new Error(configured.error);
  writeNarratedComposition();
});

afterEach(() => {
  if (previousWorkspaceRoot === undefined) delete process.env.ORKAS_WORKSPACE_ROOT;
  else process.env.ORKAS_WORKSPACE_ROOT = previousWorkspaceRoot;
  vi.restoreAllMocks();
  fs.rmSync(root, { recursive: true, force: true });
});

describe('VideoStudio speech availability', () => {
  it('tells the Agent that narration is unavailable until a BYO service is configured', async () => {
    const { createVideoStudioTool } = await import('../../../../src/main/model/core-agent/video-studio-tool');
    const tool = createVideoStudioTool({ userId: UID });

    const result = await tool.execute(
      { op: 'speech.capabilities' },
      { workingDir: workspace, state: {} } as any,
    );
    const payload = JSON.parse(result.content);

    expect(result.isError).toBe(true);
    expect(payload).toMatchObject({
      ok: false,
      status: 'unavailable',
      availability: 'not_configured',
      error_code: 'E_TTS_NOT_CONFIGURED',
      next_action: 'ask_user_to_configure_a_speech_provider',
      routes: [],
    });
    expect(payload.message).toContain('Settings > Credentials');
    expect(payload.message).toContain('add a text-to-speech service');
    expect(speechRuntime.generateSpeech).not.toHaveBeenCalled();
  });

  it('blocks a narrated composition doctor check with an actionable setup reason', async () => {
    const { createVideoStudioTool } = await import('../../../../src/main/model/core-agent/video-studio-tool');
    const tool = createVideoStudioTool({ userId: UID, turnId: 'disabled-voice-doctor' });

    const result = await tool.execute({
      op: 'composition.doctor',
      composition_dir: 'project/composition',
    }, { workingDir: workspace, state: {} } as any);
    const payload = JSON.parse(result.content);

    expect(result.isError).toBe(true);
    expect(payload).toMatchObject({
      ok: false,
      status: 'blocked',
      narration_required: true,
      blocking_capabilities: expect.arrayContaining(['tts_provider', 'tts_selection']),
      checks: {
        tts_provider: {
          ok: false,
          required: true,
          availability: 'not_configured',
          error_code: 'E_TTS_NOT_CONFIGURED',
          next_action: 'ask_user_to_configure_a_speech_provider',
        },
        tts_selection: {
          ok: false,
          required: true,
          error_code: 'E_TTS_NOT_CONFIGURED',
        },
      },
    });
    expect(payload.checks.tts_provider.message).toContain('Settings > Credentials');
    expect(payload.checks.tts_selection.message).toContain('add a text-to-speech service');
    expect(speechRuntime.generateSpeech).not.toHaveBeenCalled();
  });
});
