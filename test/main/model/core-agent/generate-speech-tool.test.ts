import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const appMedia=vi.hoisted(()=>({route:vi.fn()}));
vi.mock('../../../../src/main/features/app_media_route',()=>({appTaskMediaRoute:appMedia.route}));
beforeEach(()=>{appMedia.route.mockReset();});
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const speechMock = vi.hoisted(() => ({
  generateSpeech: vi.fn(),
  estimateNarrationDuration: vi.fn(),
  assessNarrationFit: vi.fn(),
  listTtsCapabilities: vi.fn(),
}));

vi.mock('../../../../src/main/features/tts_capabilities', async (original) => ({
  ...await original<typeof import('../../../../src/main/features/tts_capabilities')>(),
  getTtsAvailabilityDetails: () => ({ available: true }),
  listTtsCapabilities: speechMock.listTtsCapabilities,
}));

vi.mock('../../../../src/main/features/tts', () => ({
  hasConfiguredTtsProvider: () => true,
  generateSpeech: speechMock.generateSpeech,
  estimateNarrationDuration: speechMock.estimateNarrationDuration,
  assessNarrationFit: speechMock.assessNarrationFit,
  measureNarrationUnits: (text: string) => ({ unit: 'characters', units: text.length }),
}));

const UID = 'u-gspeech-001';
const CID = 'conv-speech';
const PROJECT_ID = 'project-speech';
const VIDEO_STUDIO_AGENT_ID = '79df9cc89f5f';

let tmpDir = '';
let prevWsRoot: string | undefined;

beforeEach(async () => {
  tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-gspeech-')));
  prevWsRoot = process.env.ORKAS_WORKSPACE_ROOT;
  process.env.ORKAS_WORKSPACE_ROOT = path.join(tmpDir, 'data');
  vi.resetModules();
  speechMock.generateSpeech.mockReset();
  speechMock.estimateNarrationDuration.mockReset();
  speechMock.assessNarrationFit.mockReset();
  speechMock.estimateNarrationDuration.mockReturnValue({
    estimatedSec: 1,
    unit: 'words',
    units: 2,
    unitsPerSec: 2.5,
  });
  speechMock.assessNarrationFit.mockImplementation(({ measuredSec, targetSec }: {
    measuredSec: number;
    targetSec: number;
  }) => ({
    status: measuredSec > targetSec * 1.05
      ? 'over'
      : measuredSec < targetSec * 0.85
        ? 'under'
        : 'fits',
    message: `fit basis ${measuredSec.toFixed(2)}s / ${targetSec.toFixed(2)}s`,
  }));
  speechMock.generateSpeech.mockImplementation(async ({ outputAbsPath }: { outputAbsPath: string }) => ({
    ok: true,
    path: outputAbsPath,
    bytes: 12,
    backend: 'mock',
    durationSec: 1,
  }));

  const users = await import('../../../../src/main/features/users');
  users.activateUser(UID);

  const workspace = await import('../../../../src/main/features/user_workspace');
  const defaultWs = path.join(tmpDir, 'user-workspace');
  fs.mkdirSync(defaultWs, { recursive: true });
  const res = workspace.setWorkspacePath(UID, defaultWs);
  if (!res.ok) throw new Error(`setWorkspacePath failed: ${res.error}`);
});

afterEach(() => {
  if (prevWsRoot === undefined) delete process.env.ORKAS_WORKSPACE_ROOT;
  else process.env.ORKAS_WORKSPACE_ROOT = prevWsRoot;
  vi.restoreAllMocks();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

async function createTool(opts: {
  cid?: string;
  projectId?: string;
  agentId?: string;
  onFileWritten?: (absPath: string, info?: { billedToOwnAccount?: boolean }) => void;
}) {
  const mod = await import('../../../../src/main/model/core-agent/generate-speech-tool');
  return mod.createGenerateSpeechTool({ userId: UID, ...opts });
}

function lastOutputPath(): string {
  return (speechMock.generateSpeech.mock.calls[0]?.[0] as { outputAbsPath: string }).outputAbsPath;
}

describe('generate_speech output paths', () => {
  it('allows independent narration calls to overlap while other actions remain barriers', async () => {
    const tool = await createTool({});
    expect(tool.executionMode).toBe('parallel');
    expect(tool.parallelWhen?.({ text: 'one', output_path: 'a.mp3' })).toBe(true);
    expect(tool.parallelWhen?.({ action: 'generate' })).toBe(true);
    for (const action of ['capabilities', 'unknown']) {
      expect(tool.parallelWhen?.({ action })).toBe(false);
    }
  });

  it('does not dispatch a second billable request while the same output is in flight', async () => {
    let finish!: () => void;
    const entered = new Promise<void>(resolve => {
      speechMock.generateSpeech.mockImplementationOnce(async ({ outputAbsPath }) => {
        resolve();
        await new Promise<void>(done => { finish = done; });
        return { ok: true, path: outputAbsPath, bytes: 12, backend: 'mock' };
      });
    });
    const tool = await createTool({});
    const input = { text: 'One narration', output_path: 'same.mp3' };
    const first = tool.execute(input, {} as any);
    await entered;
    const second = await tool.execute(input, {} as any);
    finish();
    await first;
    expect(second.isError).toBe(true);
    expect(speechMock.generateSpeech).toHaveBeenCalledOnce();
  });
  it('lets an audio Agent discover paged voices without synthesis or host-only voice ids', async () => {
    speechMock.listTtsCapabilities.mockResolvedValue([{
      routeRef: 'configured:test', provider: 'doubao', model: 'test', displayName: 'Test speech',
      catalogStatus: 'complete', supports: { speed: true, formats: ['wav'], languageContract: true },
      voices: Array.from({ length: 23 }, (_, i) => ({
        voiceRef: `voice-${i}`, displayName: `Voice ${i}`, providerVoiceId: `private-${i}`,
        locale: 'zh-CN', nativeLocale: 'zh-CN', supportedLocales: ['zh-CN'], languageConfidence: 'verified',
        styleTags: [], useCases: [], isDefault: i === 0,
      })),
    }]);
    const tool = await createTool({ agentId: '5f890bd72ac4' });
    const first = await tool.execute({ action: 'capabilities', language: 'zh-CN' }, {} as any);
    const data = JSON.parse(String(first.content));
    expect(data.routes[0]).toMatchObject({ total_voices: 23, next_offset: 20 });
    expect(data.routes[0].voices).toHaveLength(20);
    expect(first.content).not.toContain('providerVoiceId');
    expect(first.content).not.toContain('private-');
    const second = await tool.execute({ action: 'capabilities', offset: 20, route_ref: 'configured:test', language: 'zh-CN' }, {} as any);
    expect(JSON.parse(String(second.content)).routes[0]).toMatchObject({ next_offset: null, voices: [{ voiceRef: 'voice-20' }, { voiceRef: 'voice-21' }, { voiceRef: 'voice-22' }] });
    const foreign = await tool.execute({ action: 'capabilities', route_ref: 'missing' }, {} as any);
    expect(JSON.parse(String(foreign.content)).routes).toEqual([]);
    const invalid = await tool.execute({ action: 'capabilities', offset: -1 }, {} as any);
    expect(invalid.isError).toBe(true);
    expect(speechMock.generateSpeech).not.toHaveBeenCalled();
  });

  it('still rejects missing generation fields and unknown actions without billing', async () => {
    const tool = await createTool({});
    expect((await tool.execute({}, {} as any)).isError).toBe(true);
    expect((await tool.execute({ text: 'hello' }, {} as any)).isError).toBe(true);
    expect((await tool.execute({ action: 'unknown', text: 'hello', output_path: 'test.wav' }, {} as any)).isError).toBe(true);
    expect(speechMock.generateSpeech).not.toHaveBeenCalled();
  });

  it('keeps natural-pace fit advice for speech without a production-plan binding', async () => {
    speechMock.generateSpeech.mockImplementationOnce(async ({ outputAbsPath }: { outputAbsPath: string }) => ({
      ok: true,
      path: outputAbsPath,
      bytes: 12,
      backend: 'mock',
      durationSec: 5.5,
    }));
    const tool = await createTool({ agentId: 'another-agent' });

    const result = await tool.execute({
      text: 'standalone line',
      output_path: 'standalone-fast.mp3',
      speed: 1.2,
      target_duration: 6,
    }, { workingDir: tmpDir, state: {} } as any);

    expect(result.isError).toBeFalsy();
    expect(speechMock.assessNarrationFit).toHaveBeenCalledWith(expect.objectContaining({
      measuredSec: 6.6,
      targetSec: 6,
    }));
    expect(result.content).toContain('speed=1.2 is doing the fitting');
    expect(result.content).toContain('lengthen the scene or shorten the line');
  });

  it('does not record a line for speech that is not bound to a production plan', async () => {
    // The record is the EDL narration ledger, not a log of every synthesis:
    // ordinary voiceover has no plan, no line index, and nothing to reconcile.
    const workspace = await import('../../../../src/main/features/user_workspace');
    const workingDir = workspace.getWorkspacePath(UID);
    const tool = await createTool({ agentId: 'some-other-agent' });
    const result = await tool.execute({
      text: 'just read this out',
      output_path: 'project/audio/aside.mp3',
    }, { workingDir, state: {} } as any);
    expect(result.isError).toBeFalsy();
  });

  it('writes relative output_path to the current conversation attachment dir', async () => {
    const paths = await import('../../../../src/main/paths');
    const tool = await createTool({ cid: CID });
    const cwd = path.join(tmpDir, 'PC', 'bin');
    fs.mkdirSync(cwd, { recursive: true });

    const result = await tool.execute(
      { text: 'hello', output_path: 'morning' },
      { workingDir: cwd } as any,
    );

    expect(result.isError).toBeFalsy();
    expect(speechMock.generateSpeech).toHaveBeenCalledTimes(1);
    expect(lastOutputPath())
      .toBe(path.join(paths.chatAttachmentDir(UID, CID), 'morning.mp3'));
  });

  it('infers WAV synthesis format from the output extension', async () => {
    const tool = await createTool({ cid: CID });
    const result = await tool.execute(
      { text: 'hello', output_path: 'morning.wav' },
      { workingDir: tmpDir } as any,
    );

    expect(result.isError).toBeFalsy();
    expect(speechMock.generateSpeech.mock.calls[0]?.[0]).toMatchObject({ format: 'wav' });
    expect(lastOutputPath()).toMatch(/morning\.wav$/);
  });

  it('preserves VoiceStudio overlength feedback and refusal before a paid synthesis request', async () => {
    speechMock.estimateNarrationDuration.mockReturnValue({
      estimatedSec: 67,
      unit: 'words',
      units: 160,
      unitsPerSec: 2.5,
    });
    const tool = await createTool({ cid: CID, agentId: '5f890bd72ac4' });

    const result = await tool.execute(
      { text: 'long narration', output_path: 'narration.mp3', target_duration: 54 },
      { workingDir: tmpDir } as any,
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain('No speech request was sent');
    expect(result.content).toContain('Shorten by');
    expect(speechMock.generateSpeech).not.toHaveBeenCalled();
  });

  it('keeps VideoStudio estimate refusal factual and permits correction without spending on the refused text', async () => {
    speechMock.estimateNarrationDuration.mockReturnValueOnce({ estimatedSec: 21.78, unit: 'words', units: 48, unitsPerSec: 2.5 });
    const cwd = path.join(tmpDir, 'user-workspace');
    const tool = await createTool({ agentId: VIDEO_STUDIO_AGENT_ID });
    const input = { text: 'A complete translation', output_path: 'line.mp3', target_duration: 20 };
    const refused = await tool.execute(input, { workingDir: cwd } as any);
    expect(refused.isError).toBe(true);
    expect(refused.content).toContain('E_TTS_TEXT_TOO_LONG');
    expect(refused.content).toContain('21.78s');
    expect(refused.content).toContain('20s');
    expect(refused.content).toMatch(/estimate.*not.*measured/i);
    expect(refused.content).not.toMatch(/Shorten by|roughly \d+ words/);
    expect(speechMock.generateSpeech).not.toHaveBeenCalled();
    const corrected = await tool.execute({ ...input, text: 'Corrected translation' }, { workingDir: cwd } as any);
    expect(corrected.isError).toBeFalsy();
    expect(speechMock.generateSpeech).toHaveBeenCalledOnce();
  });

  it.each([1.25, 5.5, 7])('reports VideoStudio measured %ss audio without prescribing picture or script edits', async (seconds) => {
    speechMock.generateSpeech.mockImplementationOnce(async ({ outputAbsPath }) => ({
      ok: true, path: outputAbsPath, bytes: 12, backend: 'mock', durationSec: seconds,
    }));
    const written = vi.fn(), cwd = path.join(tmpDir, 'user-workspace');
    const tool = await createTool({ agentId: VIDEO_STUDIO_AGENT_ID, onFileWritten: written });
    const result = await tool.execute({ text: 'An unchanged line', output_path: 'line.mp3', target_duration: 6, speed: 1.2 }, { workingDir: cwd } as any);
    expect(result.isError).toBeFalsy();
    expect(result.content).toContain(`measured_duration_sec: ${seconds.toFixed(2)}`);
    expect(result.content).toContain('target_duration_sec: 6.00');
    expect(result.content).toContain(`duration_delta_sec: ${(seconds - 6).toFixed(2)}`);
    expect(result.content).not.toMatch(/lengthen|shorten|add ~|trim the|reads better|timing_action:/i);
    expect(speechMock.generateSpeech).toHaveBeenCalledOnce();
    expect(speechMock.generateSpeech.mock.calls[0][0]).toMatchObject({ text: 'An unchanged line', speed: 1.2 });
    expect(written).toHaveBeenCalledOnce();
  });

  it('does not bill twice by overwriting the same output path in one turn', async () => {
    const tool = await createTool({ cid: CID });
    const input = { text: 'hello', output_path: 'narration.mp3', target_duration: 10 };

    const first = await tool.execute(input, { workingDir: tmpDir } as any);
    const second = await tool.execute({ ...input, text: 'revised hello' }, { workingDir: tmpDir } as any);

    expect(first.isError).toBeFalsy();
    expect(first.content).toContain('measured_duration_sec: 1.00');
    expect(first.content).toContain('lengthen the scene or shorten the line');
    expect(first.content).toContain('do not regenerate it just to change the timing');
    expect(second.isError).toBe(true);
    expect(second.content).toContain('E_TTS_ALREADY_GENERATED_THIS_TURN');
    expect(speechMock.generateSpeech).toHaveBeenCalledTimes(1);
  });

  it('does not retry an already-dispatched request whose charge status is unknown', async () => {
    speechMock.generateSpeech.mockResolvedValue({
      ok: false,
      errorCode: 'E_TTS_WRITE',
      message: 'Speech was generated but could not be saved.',
      requestDisposition: 'sent',
      chargeStatus: 'unknown',
      retryPolicy: 'requires_user_action',
    });
    const tool = await createTool({ cid: CID });
    const input = { text: 'hello', output_path: 'uncertain-narration.mp3' };

    const first = await tool.execute(input, { workingDir: tmpDir } as any);
    const second = await tool.execute(input, { workingDir: tmpDir } as any);

    expect(first.isError).toBe(true);
    expect(first.content).toContain('request_disposition=sent');
    expect(first.content).toContain('charge_status=unknown');
    expect(first.content).toContain('retry_policy=requires_user_action');
    expect(second.isError).toBe(true);
    expect(second.content).toContain('E_TTS_ALREADY_GENERATED_THIS_TURN');
    expect(speechMock.generateSpeech).toHaveBeenCalledTimes(1);
  });

  it('writes project-relative output_path under the active workspace even with attachment scope', async () => {
    const paths = await import('../../../../src/main/paths');
    const workspace = await import('../../../../src/main/features/user_workspace');
    const tool = await createTool({ cid: CID });
    const cwd = path.join(workspace.getWorkspacePath(UID), 'video-task');
    fs.mkdirSync(cwd, { recursive: true });

    const result = await tool.execute(
      { text: 'hello', output_path: 'project/assets/narration' },
      { workingDir: cwd } as any,
    );

    expect(result.isError).toBeFalsy();
    expect(speechMock.generateSpeech).toHaveBeenCalledTimes(1);
    expect(lastOutputPath())
      .toBe(path.join(cwd, 'project', 'assets', 'narration.mp3'));
    expect(lastOutputPath())
      .not.toContain(paths.chatAttachmentDir(UID, CID));
  });

  it('writes a VideoStudio line into its production folder, as its shots and images are', async () => {
    // Runs on 2026-11-05 put 76 of 79 lines in chat attachments, and every run that kept its
    // narration copied the files back into the production.
    const paths = await import('../../../../src/main/paths');
    const workspace = await import('../../../../src/main/features/user_workspace');
    const cwd = path.join(workspace.getWorkspacePath(UID), 'lamp-task');
    fs.mkdirSync(path.join(cwd, 'lamp-ad'), { recursive: true });
    const input = { text: '孩子写作业总说眼睛累？', output_path: 'lamp-ad/voice/hook.mp3' };

    const studio = await createTool({ cid: CID, agentId: VIDEO_STUDIO_AGENT_ID });
    expect((studio.inputSchema as any).properties.output_path.description).toContain('workspace-relative');
    expect((await studio.execute(input, { workingDir: cwd } as any)).isError).toBeFalsy();
    expect(lastOutputPath()).toBe(path.join(cwd, 'lamp-ad', 'voice', 'hook.mp3'));

    // Another Agent's relative path still lands in the conversation's attachments.
    const other = await createTool({ cid: CID, agentId: 'another-agent' });
    expect((other.inputSchema as any).properties.output_path.description).toContain('prefer chat attachments');
    expect((await other.execute(input, { workingDir: cwd } as any)).isError).toBeFalsy();
    expect((speechMock.generateSpeech.mock.calls[1]?.[0] as { outputAbsPath: string }).outputAbsPath)
      .toBe(path.join(paths.chatAttachmentDir(UID, CID), 'lamp-ad', 'voice', 'hook.mp3'));
  });

  it('refuses a VideoStudio line outside the workspace before synthesizing it', async () => {
    const workspace = await import('../../../../src/main/features/user_workspace');
    const cwd = path.join(workspace.getWorkspacePath(UID), 'lamp-task');
    fs.mkdirSync(cwd, { recursive: true });
    const tool = await createTool({ cid: CID, agentId: VIDEO_STUDIO_AGENT_ID });

    const result = await tool.execute({ text: 'hello', output_path: '../../outside/hook.mp3' }, { workingDir: cwd } as any);

    expect(result.isError).toBe(true);
    expect(result.content).toContain('E_PATH_OUT_OF_SCOPE');
    expect(speechMock.generateSpeech).not.toHaveBeenCalled();
  });

  it('writes relative output_path to the user workspace when no conversation attachment scope exists', async () => {
    const workspace = await import('../../../../src/main/features/user_workspace');
    const projectWs = path.join(tmpDir, 'project-workspace');
    fs.mkdirSync(projectWs, { recursive: true });
    const projectRes = workspace.setWorkspacePath(UID, projectWs, PROJECT_ID);
    if (!projectRes.ok) throw new Error(`set project workspace failed: ${projectRes.error}`);

    const tool = await createTool({ projectId: PROJECT_ID });
    const cwd = path.join(tmpDir, 'PC', 'bin');
    fs.mkdirSync(cwd, { recursive: true });

    const result = await tool.execute(
      { text: 'hello', output_path: 'morning' },
      { workingDir: cwd } as any,
    );

    expect(result.isError).toBeFalsy();
    expect(speechMock.generateSpeech).toHaveBeenCalledTimes(1);
    expect(lastOutputPath())
      .toBe(path.join(workspace.getWorkspacePath(UID), 'morning.mp3'));
    expect(lastOutputPath())
      .not.toContain(`${path.sep}PC${path.sep}bin${path.sep}`);
    expect(lastOutputPath())
      .not.toBe(path.join(projectWs, 'morning.mp3'));
  });
});

// On 2026-11-07 Luna voiced a 12-second script as one file, could not fit it to its 4-second
// scenes and delivered a silent video. The delivery check can stop that only if the host knows
// narration was made for the production.
describe('generate_speech and the VideoStudio delivery check', () => {
  async function production() {
    const workspace = await import('../../../../src/main/features/user_workspace');
    const cwd = path.join(workspace.getWorkspacePath(UID), 'lamp-task');
    const dir = path.join(cwd, 'lamp-ad');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'assets.json'), '{"assets":[]}');
    return { cwd, dir };
  }
  const voices = (dir: string) => JSON.parse(fs.readFileSync(path.join(dir, 'versions.json'), 'utf8')).voices_since_delivery;
  const lasting = (seconds: number, writes = false) => async ({ outputAbsPath }: { outputAbsPath: string }) => {
    if (writes) {
      fs.mkdirSync(path.dirname(outputAbsPath), { recursive: true });
      fs.writeFileSync(outputAbsPath, 'audio');
    }
    return { ok: true, path: outputAbsPath, bytes: 12, backend: 'mock', durationSec: seconds };
  };

  it('records a VideoStudio line in the production that holds it, with its measured length', async () => {
    const { cwd, dir } = await production();
    speechMock.generateSpeech.mockImplementationOnce(lasting(12.2));
    const tool = await createTool({ cid: CID, agentId: VIDEO_STUDIO_AGENT_ID });

    const result = await tool.execute({ text: '孩子写作业总说眼睛累？', output_path: 'lamp-ad/voice/all.mp3' }, { workingDir: cwd } as any);

    expect(result.isError).toBeFalsy();
    expect(voices(dir)).toEqual([{ path: 'voice/all.mp3', seconds: 12.2 }]);
  });

  it('records nothing for another Agent, a line that failed, or a line outside any production', async () => {
    const { cwd, dir } = await production();
    const other = await createTool({ cid: CID, agentId: 'another-agent' });
    expect((await other.execute({ text: 'one', output_path: path.join(dir, 'voice', 'other.mp3') }, { workingDir: cwd } as any)).isError).toBeFalsy();
    const studio = await createTool({ cid: CID, agentId: VIDEO_STUDIO_AGENT_ID });
    speechMock.generateSpeech.mockResolvedValueOnce({ ok: false, errorCode: 'E_TTS_PROVIDER', message: 'The voice service failed.' });
    expect((await studio.execute({ text: 'two', output_path: 'lamp-ad/voice/failed.mp3' }, { workingDir: cwd } as any)).isError).toBe(true);
    expect((await studio.execute({ text: 'three', output_path: 'loose/line.mp3' }, { workingDir: cwd } as any)).isError).toBeFalsy();

    expect(speechMock.generateSpeech).toHaveBeenCalledTimes(3);
    expect(fs.existsSync(path.join(dir, 'versions.json'))).toBe(false);
    expect(fs.existsSync(path.join(cwd, 'loose', 'versions.json'))).toBe(false);
    expect(fs.existsSync(path.join(cwd, 'versions.json'))).toBe(false);
  });

  it('still returns the line when its record cannot be written, and leaves the list alone', async () => {
    const { cwd, dir } = await production();
    fs.writeFileSync(path.join(dir, 'versions.json'), 'not a list');
    const warn = vi.fn();
    vi.doMock('../../../../src/main/logger', () => ({ createLogger: () => ({ error: vi.fn(), warn, info: vi.fn(), debug: vi.fn() }) }));
    try {
      const tool = await createTool({ cid: CID, agentId: VIDEO_STUDIO_AGENT_ID });

      const result = await tool.execute({ text: 'hello', output_path: 'lamp-ad/voice/all.mp3' }, { workingDir: cwd } as any);

      expect(result.isError).toBeFalsy();
      expect(result.content).toContain('Speech written to');
      expect(fs.readFileSync(path.join(dir, 'versions.json'), 'utf8')).toBe('not a list');
      // Said without the error's own text, which can name a local path.
      expect(warn).toHaveBeenCalledWith('voice not recorded for delivery', { error: expect.objectContaining({ name: 'Error', message_chars: expect.any(Number) }) });
      expect(JSON.stringify(warn.mock.calls)).not.toContain(tmpDir);
    } finally {
      vi.doUnmock('../../../../src/main/logger');
    }
  });

  it('lets the delivery stop a video that plays none of it', async () => {
    const { cwd, dir } = await production();
    const video = path.join(dir, 'videos', 'main');
    fs.mkdirSync(video, { recursive: true });
    fs.writeFileSync(path.join(video, 'manifest.json'), JSON.stringify({
      schema_version: 3, id: 'main', label: 'Ad', canvas: { width: 360, height: 640, fps: 30 },
      scenes: [{ id: 'hook', duration: 2 }, { id: 'cta', duration: 2 }],
    }));
    const { bundledFfmpegPaths } = await import('../../../../src/main/util/bundled-runtime');
    const render = path.join(dir, 'render', 'main.mp4');
    fs.mkdirSync(path.dirname(render), { recursive: true });
    const run = spawnSync(bundledFfmpegPaths().ffmpeg as string, [
      '-y', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=s=360x640:r=30:d=4',
      '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', render,
    ], { encoding: 'utf8' });
    if (run.status !== 0) throw new Error(run.stderr);
    speechMock.generateSpeech.mockImplementationOnce(lasting(12.2, true));
    const tool = await createTool({ cid: CID, agentId: VIDEO_STUDIO_AGENT_ID });
    expect((await tool.execute({ text: '孩子写作业总说眼睛累？', output_path: 'lamp-ad/voice/all.mp3' }, { workingDir: cwd } as any)).isError).toBeFalsy();

    const { shipVideoFile } = await import('../../../../src/main/features/video_timeline_ship');
    const shipped = await shipVideoFile({ productionDirAbs: dir, videoDirAbs: video, allowedRoots: [cwd], videoPathAbs: render });

    expect(shipped).toMatchObject({ ok: false, errorCode: 'E_VIDEO_SHIP_BLOCKED' });
    expect((shipped as { issues?: Array<{ code: string; message: string }> }).issues)
      .toContainEqual(expect.objectContaining({ code: 'DELIVERY_NARRATION_MISSING', message: expect.stringContaining('voice/all.mp3 (12.2 s)') }));
  });
});

// On 2026-11-08 the model wrote these rows itself: one left out a required label and cost a
// round, none kept the voice, and a line voiced again took over the old line's row.
describe('generate_speech and the VideoStudio asset ledger', () => {
  const HOOK = '孩子写作业总说眼睛累？';
  async function production(ledger = '{"assets":[]}') {
    const workspace = await import('../../../../src/main/features/user_workspace');
    const cwd = path.join(workspace.getWorkspacePath(UID), 'lamp-task');
    const dir = path.join(cwd, 'lamp-ad');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'assets.json'), ledger);
    return { cwd, dir };
  }
  const rows = (dir: string) => JSON.parse(fs.readFileSync(path.join(dir, 'assets.json'), 'utf8')).assets;
  const voiced = (extra: Record<string, unknown> = {}) => async ({ outputAbsPath }: { outputAbsPath: string }) => ({
    ok: true, path: outputAbsPath, bytes: 12, backend: 'mock', durationSec: 2.3,
    routeRef: 'tts-route-1', voiceRef: 'tts-route-1:voice:calm', billedToOwnAccount: true, ...extra,
  });

  it('adds the line with the voice it was made with, and names its id right after the file', async () => {
    const { cwd, dir } = await production();
    speechMock.generateSpeech.mockImplementationOnce(voiced());
    const tool = await createTool({ cid: CID, agentId: VIDEO_STUDIO_AGENT_ID });

    // No voice named: the row still records the one the service used.
    const result = await tool.execute({ text: HOOK, output_path: 'lamp-ad/voice/hook.mp3', language: 'zh-CN' }, { workingDir: cwd } as any);

    expect(result.isError).toBeFalsy();
    expect(rows(dir)).toEqual([{
      id: 'hook', kind: 'audio', label: HOOK, path: 'voice/hook.mp3', origin: 'generated', prompt: HOOK,
      request: { route_ref: 'tts-route-1', voice_ref: 'tts-route-1:voice:calm', language: 'zh-CN' },
    }]);
    expect(result.content.split('\n')[1]).toBe('asset_id: hook, already in assets.json with this voice.');
  });

  it('keeps the old line\'s row when the line is voiced again under a new name', async () => {
    const { cwd, dir } = await production();
    speechMock.generateSpeech.mockImplementation(voiced());
    const tool = await createTool({ cid: CID, agentId: VIDEO_STUDIO_AGENT_ID });
    await tool.execute({ text: '售价一百九十九元', output_path: 'lamp-ad/voice/price.mp3' }, { workingDir: cwd } as any);

    const again = await tool.execute({ text: '售价一百七十九元', output_path: 'lamp-ad/voice/price-179.mp3', speed: 1.1 }, { workingDir: cwd } as any);

    expect(again.content).toContain('asset_id: price-179, already in assets.json with this voice.');
    expect(rows(dir).map((row: any) => [row.id, row.path, row.prompt, row.request.speed])).toEqual([
      ['price', 'voice/price.mp3', '售价一百九十九元', undefined],
      ['price-179', 'voice/price-179.mp3', '售价一百七十九元', 1.1],
    ]);
  });

  it('labels a long line with its first 40 characters and keeps every word in prompt', async () => {
    const { cwd, dir } = await production();
    speechMock.generateSpeech.mockImplementationOnce(voiced());
    const tool = await createTool({ cid: CID, agentId: VIDEO_STUDIO_AGENT_ID });
    const text = '这盏台灯有三档色温，白天看书用冷光，晚上写作业换暖光，睡前读绘本调到最柔的一档，眼睛一整天都舒服。';

    await tool.execute({ text, output_path: 'lamp-ad/voice/long.mp3' }, { workingDir: cwd } as any);

    expect(rows(dir)[0].label).toBe(`${Array.from(text).slice(0, 40).join('')}…`);
    expect(rows(dir)[0].prompt).toBe(text);
  });

  it('says to add the line itself when no production holds it, and writes no ledger', async () => {
    const { cwd } = await production();
    speechMock.generateSpeech.mockImplementationOnce(voiced());
    const tool = await createTool({ cid: CID, agentId: VIDEO_STUDIO_AGENT_ID });

    const result = await tool.execute({ text: HOOK, output_path: 'loose/line.mp3' }, { workingDir: cwd } as any);

    expect(result.isError).toBeFalsy();
    expect(result.content.split('\n')[1]).toBe('asset_id: none. No production folder (one holding videos/ or assets.json) contains this file. Add it to assets.json yourself, with its voice in "request".');
    expect(fs.existsSync(path.join(cwd, 'loose', 'assets.json'))).toBe(false);
    expect(fs.existsSync(path.join(cwd, 'assets.json'))).toBe(false);
  });

  it('says the ledger could not be read, and leaves it as it was', async () => {
    const { cwd, dir } = await production('not a ledger');
    speechMock.generateSpeech.mockImplementationOnce(voiced());
    const tool = await createTool({ cid: CID, agentId: VIDEO_STUDIO_AGENT_ID });

    const result = await tool.execute({ text: HOOK, output_path: 'lamp-ad/voice/hook.mp3' }, { workingDir: cwd } as any);

    expect(result.isError).toBeFalsy();
    expect(result.content.split('\n')[1]).toBe('asset_id: none. assets.json could not be read, so this file was not added to it. Add it yourself, with its voice in "request".');
    expect(fs.readFileSync(path.join(dir, 'assets.json'), 'utf8')).toBe('not a ledger');
  });

  it('adds nothing for another Agent, or for a line that failed', async () => {
    const { cwd, dir } = await production();
    const other = await createTool({ cid: CID, agentId: 'another-agent' });
    speechMock.generateSpeech.mockImplementationOnce(voiced());
    const elsewhere = await other.execute({ text: HOOK, output_path: path.join(dir, 'voice', 'other.mp3') }, { workingDir: cwd } as any);
    const studio = await createTool({ cid: CID, agentId: VIDEO_STUDIO_AGENT_ID });
    speechMock.generateSpeech.mockResolvedValueOnce({ ok: false, errorCode: 'E_TTS_PROVIDER', message: 'The voice service failed.' });
    await studio.execute({ text: HOOK, output_path: 'lamp-ad/voice/failed.mp3' }, { workingDir: cwd } as any);

    expect(elsewhere.content).not.toContain('asset_id');
    expect(rows(dir)).toEqual([]);
  });
  it('tells the host which lines the user\'s own speech account paid for', async () => {
    const { cwd, dir } = await production();
    const written = vi.fn();
    const tool = await createTool({ cid: CID, agentId: VIDEO_STUDIO_AGENT_ID, onFileWritten: written });
    speechMock.generateSpeech.mockImplementationOnce(voiced());
    const own = await tool.execute({ text: HOOK, output_path: 'lamp-ad/voice/own.mp3' }, { workingDir: cwd } as any);
    expect(own.content).not.toContain('billedToOwnAccount');
    expect(own.content).not.toContain('own service account');
    speechMock.generateSpeech.mockImplementationOnce(voiced({ billedToOwnAccount: false }));
    await tool.execute({ text: HOOK, output_path: 'lamp-ad/voice/credits.mp3' }, { workingDir: cwd } as any);

    expect(written.mock.calls).toEqual([
      [path.join(dir, 'voice', 'own.mp3'), { billedToOwnAccount: true }],
      [path.join(dir, 'voice', 'credits.mp3')],
    ]);
  });
});

it('pins speech generation to the app-selected voice service',async()=>{
 appMedia.route.mockResolvedValue('selected-voice');const tool=await createTool({cid:CID}),cwd=path.join(tmpDir,'speech');fs.mkdirSync(cwd,{recursive:true});const result=await tool.execute({text:'hello',output_path:'hello.mp3',route_ref:'another-service'},{workingDir:cwd} as any);expect(result.isError).toBeFalsy();expect(speechMock.generateSpeech).toHaveBeenCalledWith(expect.objectContaining({routeRef:'selected-voice'}));
});


it('has an explicit factual own-account notice in every registered locale without fallback', async () => {
  const i18n = await import('../../../../src/main/i18n');
  const key = 'video_budget.own_key_notice';
  const directory = path.resolve(__dirname, '../../../../src/main/locales');
  const english = JSON.parse(fs.readFileSync(path.join(directory, 'en.json'), 'utf8'))[key];
  for (const locale of i18n.LOCALES) {
    const table = JSON.parse(fs.readFileSync(path.join(directory, locale.code + '.json'), 'utf8'));
    expect(Object.hasOwn(table, key), locale.code).toBe(true);
    const text = table[key];
    expect(typeof text, locale.code).toBe('string');
    expect(text.match(/\{count\}/g), locale.code).toHaveLength(1);
    if (locale.code !== 'en') expect(text, locale.code).not.toBe(english);
    expect(i18n.t(key, { count: 2 }, locale.code), locale.code).toBe(text.replace('{count}', '2'));
  }
  expect(english).toBe('Generated {count} file(s) with your own service account, which bills you directly.');
});
