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
  resolveTtsSelection: vi.fn(),
}));

vi.mock('../../../../src/main/features/tts_capabilities', async (original) => ({
  ...await original<typeof import('../../../../src/main/features/tts_capabilities')>(),
  getTtsAvailabilityDetails: () => ({ available: true }),
  listTtsCapabilities: speechMock.listTtsCapabilities,
  resolveTtsSelection: speechMock.resolveTtsSelection,
}));

vi.mock('../../../../src/main/features/tts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../../src/main/features/tts')>();
  return {
    hasConfiguredTtsProvider: () => true,
    generateSpeech: speechMock.generateSpeech,
    estimateNarrationDuration: speechMock.estimateNarrationDuration,
    assessNarrationFit: speechMock.assessNarrationFit,
    measureNarrationUnits: (text: string) => ({ unit: 'characters', units: text.length }),
    narrationDurationCalibrationScale: actual.narrationDurationCalibrationScale,
    NARRATION_ESTIMATE_OVER_RATIO: actual.NARRATION_ESTIMATE_OVER_RATIO,
    NARRATION_FILL_RETRY_LIMIT: actual.NARRATION_FILL_RETRY_LIMIT,
    NARRATION_MEASURED_OVER_RATIO: actual.NARRATION_MEASURED_OVER_RATIO,
  };
});

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
  speechMock.resolveTtsSelection.mockReset().mockResolvedValue({ ok: true });
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
  hasProducedPath?: (absPath: string) => boolean;
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

  // 2026-11-16 merge of release_2.5.0 into release_2.8.0: the requester chose 2.8.0's timing
  // feedback for VideoStudio too (shorten by N% before synthesis; after it, fill a short line
  // and keep its scene, or lengthen the scene for a long one) over 2.5.0's facts-only text.
  it('refuses a VideoStudio line estimated well over its target, says how much to shorten, and spends nothing on it', async () => {
    speechMock.estimateNarrationDuration.mockReturnValueOnce({ estimatedSec: 25, unit: 'words', units: 48, unitsPerSec: 2.5 });
    const cwd = path.join(tmpDir, 'user-workspace');
    const tool = await createTool({ agentId: VIDEO_STUDIO_AGENT_ID });
    const input = { text: 'A complete translation', output_path: 'line.mp3', target_duration: 20 };
    const refused = await tool.execute(input, { workingDir: cwd } as any);
    expect(refused.isError).toBe(true);
    expect(refused.content).toContain('E_TTS_TEXT_TOO_LONG');
    expect(refused.content).toContain('25s');
    expect(refused.content).toContain('20s');
    expect(refused.content).toMatch(/Shorten by about \d+%/);
    expect(speechMock.generateSpeech).not.toHaveBeenCalled();
    const corrected = await tool.execute({ ...input, text: 'Corrected translation' }, { workingDir: cwd } as any);
    expect(corrected.isError).toBeFalsy();
    expect(speechMock.generateSpeech).toHaveBeenCalledOnce();
  });

  it('tells VideoStudio to fill a short line and keep its scene, and to lengthen the scene for a long one', async () => {
    const cwd = path.join(tmpDir, 'user-workspace');
    const written = vi.fn();
    const tool = await createTool({ agentId: VIDEO_STUDIO_AGENT_ID, onFileWritten: written });
    speechMock.generateSpeech.mockImplementationOnce(async ({ outputAbsPath }) => ({ ok: true, path: outputAbsPath, bytes: 12, backend: 'mock', durationSec: 1.25 }));
    const short = await tool.execute({ text: 'An unchanged line', output_path: 'short.mp3', target_duration: 6 }, { workingDir: cwd } as any);
    expect(short.isError).toBeFalsy();
    expect(short.content).toContain('measured_duration_sec: 1.25');
    expect(short.content).toContain('⚠️ fit basis 1.25s / 6.00s');
    expect(short.content).toContain("timing_action: This is the audio's real length. When the user asked for this video's length, keep the scene at its planned length");
    speechMock.generateSpeech.mockImplementationOnce(async ({ outputAbsPath }) => ({ ok: true, path: outputAbsPath, bytes: 12, backend: 'mock', durationSec: 8.4 }));
    const long = await tool.execute({ text: 'Another line', output_path: 'long.mp3', target_duration: 6 }, { workingDir: cwd } as any);
    expect(long.isError).toBeFalsy();
    expect(long.content).toContain('measured_duration_sec: 8.40');
    expect(long.content).toContain('lengthen the scene or shorten the line');
    expect(speechMock.generateSpeech).toHaveBeenCalledTimes(2);
    expect(written).toHaveBeenCalledTimes(2);
  });

  it('does not bill twice by overwriting the same output path in one turn', async () => {
    const tool = await createTool({ cid: CID });
    // The mock voice reads it in 1s, so it fits; only a short line's file takes a second line.
    const input = { text: 'hello', output_path: 'narration.mp3', target_duration: 1 };

    const first = await tool.execute(input, { workingDir: tmpDir } as any);
    const second = await tool.execute({ ...input, text: 'revised hello' }, { workingDir: tmpDir } as any);

    expect(first.isError).toBeFalsy();
    expect(first.content).toContain('measured_duration_sec: 1.00');
    expect(second.isError).toBe(true);
    expect(second.content).toContain('E_TTS_ALREADY_GENERATED_THIS_TURN');
    // On 2026-11-17 a changed line sent to the same path was refused with no way to voice it.
    expect(second.content).toContain('To voice a changed line, give it a new output_path, such as voice/hook-2.mp3.');
    expect(speechMock.generateSpeech).toHaveBeenCalledTimes(1);
  });

  // 2026-11-16: a 72 s explainer the user gave no length kept every planned scene, and each
  // ended in 1.2-2.6 s of silence. Without a requested length a scene ends with its line.
  it('keeps a short line\'s scene when the user asked for a length, else ends each scene with its line', async () => {
    const tool = await createTool({ cid: CID });
    // The mock voice reads every line in 1s; the long line is estimated short enough to pass the precheck.
    const short = await tool.execute({ text: 'hello', output_path: 'short.mp3', target_duration: 10 }, { workingDir: tmpDir } as any);
    const fitting = await tool.execute({ text: 'hello', output_path: 'fitting.mp3', target_duration: 1 }, { workingDir: tmpDir } as any);
    speechMock.estimateNarrationDuration.mockReturnValueOnce({ ...speechMock.estimateNarrationDuration('', 1), estimatedSec: 0.4 });
    const long = await tool.execute({ text: 'hello', output_path: 'long.mp3', target_duration: 0.5 }, { workingDir: tmpDir } as any);

    expect(short.content).toContain("timing_action: This is the audio's real length. When the user asked for this video's length, keep the scene at its planned length: "
      + 'replace this line with the longer one rather than cutting the scene to this audio. Otherwise make the scene this audio plus about half a second and keep this audio.');
    expect(short.content).not.toContain('do not regenerate');
    expect(speechMock.generateSpeech).toHaveBeenCalledTimes(3);
    for (const result of [long, fitting]) {
      expect(result.content).toContain("timing_action: This is the audio's real length. Its scene must be at least that long: "
        + "lengthen the scene or shorten the line. When the user did not ask for this video's length, make the scene this audio plus about half a second. "
        + 'Reuse this audio; do not regenerate it just to change the timing.');
    }
  });

  it('lets a short line take its own file again at most twice a turn, whatever its target, and counts each file apart', async () => {
    const fill = 'keep the scene at its planned length: replace this line with the longer one';
    const capped = "timing_action: This is the audio's real length. Keep this audio and the scene's planned length; do not generate this line again this turn.";
    const say = (tool: any, file: string, target: number) => tool.execute({ text: 'hello', output_path: file, target_duration: target }, { workingDir: tmpDir } as any);
    const tool = await createTool({ cid: CID, hasProducedPath: () => true });
    // The mock voice reads every line in 1s, so each take below is short. A fill may change its target (2026-11-15).
    const takes = [await say(tool, 'a.mp3', 10), await say(tool, 'a.mp3', 12), await say(tool, 'a.mp3', 8)];
    const fourth = await say(tool, 'a.mp3', 8);

    expect(takes.slice(0, 2).every((take) => take.content.includes(fill))).toBe(true);
    expect(takes[2].content).toContain(capped);
    expect(takes[2].content).not.toContain(fill);
    expect(fourth.content).toContain('E_TTS_ALREADY_GENERATED_THIS_TURN');
    expect(speechMock.assessNarrationFit.mock.calls.map(([input]) => input.fillLimitReached)).toEqual([false, false, true]);
    // Each fill overwrote the first take in place.
    expect(new Set(speechMock.generateSpeech.mock.calls.map(([input]) => input.outputAbsPath)).size).toBe(1);
    // Another scene of the same voice and length is its own line (2026-11-15), and a new turn starts over.
    expect((await say(tool, 'b.mp3', 8)).content).toContain(fill);
    expect((await say(await createTool({ cid: CID, hasProducedPath: () => true }), 'a.mp3', 10)).content).toContain(fill);
    expect(speechMock.generateSpeech).toHaveBeenCalledTimes(5);
  });

  it('opens a file again only for the fill a short result asked for, and keeps it open past a refused estimate', async () => {
    const say = (tool: any, file: string, target: number) => tool.execute({ text: 'hello', output_path: file, target_duration: target }, { workingDir: tmpDir } as any);
    const tool = await createTool({ cid: CID });
    await say(tool, 'fitting.mp3', 1);
    speechMock.estimateNarrationDuration.mockReturnValueOnce({ ...speechMock.estimateNarrationDuration('', 1), estimatedSec: 0.4 });
    await say(tool, 'long.mp3', 0.5);
    await say(tool, 'short.mp3', 10);
    expect((await say(tool, 'fitting.mp3', 1)).content).toContain('E_TTS_ALREADY_GENERATED_THIS_TURN');
    expect((await say(tool, 'long.mp3', 1)).content).toContain('E_TTS_ALREADY_GENERATED_THIS_TURN');

    speechMock.estimateNarrationDuration.mockReturnValueOnce({ ...speechMock.estimateNarrationDuration('', 1), estimatedSec: 20 });
    expect((await say(tool, 'short.mp3', 10)).content).toContain('E_TTS_TEXT_TOO_LONG');
    expect((await say(tool, 'short.mp3', 10)).isError).toBeFalsy();
    expect(speechMock.generateSpeech).toHaveBeenCalledTimes(4);
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

// In the 2026-11-14 recreation runs the voice read Chinese about 1.5x faster than the estimate,
// so lines that would have fit were refused, the model cut them short, and two videos went
// silent for their second half. One run's longer retry, after a line had been measured, was
// refused by the same estimate.
describe('generate_speech narration length precheck', () => {
  const VOICE_A = { route_ref: 'env:tts', voice_ref: 'voice-a', language: 'zh-CN' };
  const VOICE_B = { route_ref: 'env:tts', voice_ref: 'voice-b', language: 'zh-CN' };
  /** Estimated and measured seconds per line; a line with no measured value fails or reports no length. */
  function voiceLines(lines: Record<string, { est: number; measured?: number | 'fail' }>) {
    speechMock.estimateNarrationDuration.mockImplementation((text: string) => ({
      estimatedSec: lines[text]?.est ?? 1, unit: 'characters', units: text.length, unitsPerSec: 4,
    }));
    speechMock.generateSpeech.mockImplementation(async ({ text, outputAbsPath }: { text: string; outputAbsPath: string }) => {
      const measured = lines[text]?.measured;
      if (measured === 'fail') {
        return { ok: false, errorCode: 'E_TTS_PROVIDER', message: 'failed', requestDisposition: 'not_sent', chargeStatus: 'not_charged' };
      }
      return { ok: true, path: outputAbsPath, bytes: 12, backend: 'mock', ...(measured ? { durationSec: measured } : {}) };
    });
  }
  async function say(tool: Awaited<ReturnType<typeof createTool>>, text: string, target: number, voice = VOICE_A) {
    return tool.execute({ text, output_path: `${text}.mp3`, target_duration: target, ...voice }, { workingDir: tmpDir } as any);
  }
  function voiced(): string[] {
    return speechMock.generateSpeech.mock.calls.map((call) => (call[0] as { text: string }).text);
  }

  it('voices a first line estimated up to a fifth over its target, and refuses one past that without a request', async () => {
    voiceLines({ below: { est: 11.5, measured: 8 }, at: { est: 12, measured: 8 }, above: { est: 12.1, measured: 8 } });
    const tool = await createTool({ cid: CID });

    expect((await say(tool, 'below', 10)).isError).toBeFalsy();
    expect((await say(tool, 'at', 10, VOICE_B)).isError).toBeFalsy();
    const refused = await say(tool, 'above', 10, { ...VOICE_B, voice_ref: 'voice-c' });

    expect(refused.isError).toBe(true);
    expect(refused.content).toContain('E_TTS_TEXT_TOO_LONG');
    expect(refused.content).toContain('No speech request was sent');
    expect(voiced()).toEqual(['below', 'at']);
  });

  it('judges a later line by the pace this voice was measured at, so a longer retry is voiced', async () => {
    voiceLines({ first: { est: 10, measured: 6.5 }, longer: { est: 15, measured: 9.8 } });
    const tool = await createTool({ cid: CID });

    expect((await say(tool, 'first', 10)).isError).toBeFalsy();
    const longer = await say(tool, 'longer', 10);

    expect(longer.isError).toBeFalsy();
    expect(voiced()).toEqual(['first', 'longer']);
  });

  it('refuses a line this voice reads slower than estimated, before any request, and a new turn starts over', async () => {
    voiceLines({ first: { est: 10, measured: 13 }, same: { est: 10, measured: 13 } });
    const tool = await createTool({ cid: CID });

    expect((await say(tool, 'first', 13)).isError).toBeFalsy();
    const refused = await say(tool, 'same', 10);

    expect(refused.isError).toBe(true);
    expect(refused.content).toContain('Estimated natural narration is 13s for a 10s target');
    expect(voiced()).toEqual(['first']);

    const nextTurn = await createTool({ cid: CID });
    expect((await say(nextTurn, 'same', 10)).isError).toBeFalsy();
    expect(voiced()).toEqual(['first', 'same']);
  });

  it('keeps each voice\'s measured pace to that voice', async () => {
    voiceLines({ slow: { est: 10, measured: 13 }, other: { est: 11, measured: 8 } });
    const tool = await createTool({ cid: CID });

    await say(tool, 'slow', 13);
    const onSlowVoice = await say(tool, 'other', 10);
    const onOtherVoice = await say(tool, 'other', 10, VOICE_B);

    expect(onSlowVoice.isError).toBe(true);
    expect(onOtherVoice.isError).toBeFalsy();
    expect(voiced()).toEqual(['slow', 'other']);
  });

  it('weighs a voice\'s lines by length, so a short line\'s silence does not swing its pace', async () => {
    voiceLines({ long: { est: 10, measured: 6 }, tiny: { est: 1, measured: 1.9 }, next: { est: 13, measured: 9 } });
    const tool = await createTool({ cid: CID });

    await say(tool, 'long', 10);
    await say(tool, 'tiny', 2);
    const next = await say(tool, 'next', 10);

    expect(next.isError).toBeFalsy();
    expect(voiced()).toEqual(['long', 'tiny', 'next']);
  });

  it('learns no pace from a failed line or one with no measured length', async () => {
    voiceLines({ failed: { est: 10, measured: 'fail' }, unmeasured: { est: 10 }, next: { est: 13, measured: 9 } });
    const tool = await createTool({ cid: CID });

    expect((await say(tool, 'failed', 10)).isError).toBe(true);
    expect((await say(tool, 'unmeasured', 10)).isError).toBeFalsy();
    const next = await say(tool, 'next', 10);

    expect(next.isError).toBe(true);
    expect(next.content).toContain('Estimated natural narration is 13s for a 10s target');
    expect(voiced()).toEqual(['failed', 'unmeasured']);
  });

  it('preflights all remaining scenes at the first take’s measured pace without synthesizing them', async () => {
    voiceLines({ opening: { est: 2, measured: 2.6 }, short: { est: 1 }, long: { est: 2 }, longest: { est: 3 } });
    const tool = await createTool({ cid: CID });
    await say(tool, 'opening', 2.6);
    const ctx = { workingDir: tmpDir } as any;
    const result = await tool.execute({ action: 'preflight', ...VOICE_A, lines: [
      { text: 'short', target_duration: 2 },
      { text: 'long', target_duration: 2 },
      { text: 'longest', target_duration: 3 },
    ] }, ctx);

    expect(JSON.parse(result.content as string)).toMatchObject({
      ok: false, code: 'E_TTS_TEXT_TOO_LONG', calibrated: true, lines: [
        { index: 2, estimated_sec: 2.6, target_sec: 2, over_by_sec: 0.6 },
        { index: 3, estimated_sec: 3.9, target_sec: 3, over_by_sec: 0.9 },
      ],
    });
    expect(voiced()).toEqual(['opening']);
    const revised = await tool.execute({ action: 'preflight', ...VOICE_A, lines: [
      { text: 'long', target_duration: 2.6 },
      { text: 'longest', target_duration: 3.9 },
    ] }, ctx);
    expect(JSON.parse(revised.content as string)).toMatchObject({ ok: true, calibrated: true });
    expect(voiced()).toEqual(['opening']);
    expect((await say(tool, 'long', 2.6)).isError).toBeFalsy();
    expect(voiced()).toEqual(['opening', 'long']);
  });

  it('returns one refusal for a missing configured voice before touching any scene', async () => {
    speechMock.resolveTtsSelection.mockResolvedValue({ ok: false, errorCode: 'E_TTS_VOICE_UNRESOLVED', message: 'Select a configured voice.' });
    const tool = await createTool({ cid: CID });
    const result = await tool.execute({ action: 'preflight', ...VOICE_A, lines: [
      { text: 'A', target_duration: 2 }, { text: 'B', target_duration: 2 },
    ] }, { workingDir: tmpDir } as any);

    expect(JSON.parse(result.content as string)).toMatchObject({ ok: false, code: 'E_TTS_VOICE_UNRESOLVED', synthesis_sent: false });
    expect(speechMock.resolveTtsSelection).toHaveBeenCalledTimes(1);
    expect(voiced()).toEqual([]);
  });

  it('checks the last line in a full 50-line batch without generating audio', async () => {
    const tool = await createTool({ cid: CID });
    const lines = Array.from({ length: 50 }, (_, index) => ({
      text: `Line ${index + 1}`, target_duration: index === 49 ? 0.5 : 2,
    }));
    const result = await tool.execute({ action: 'preflight', ...VOICE_A, lines }, { workingDir: tmpDir } as any);

    expect(JSON.parse(result.content as string)).toMatchObject({
      ok: false, calibrated: false, synthesis_sent: false,
      lines: [{ index: 50, target_sec: 0.5, estimated_sec: 1 }],
    });
    expect(voiced()).toEqual([]);
  });

  it.each([
    { name: 'empty list', lines: [] },
    { name: 'blank text', lines: [{ text: ' ', target_duration: 1 }] },
    { name: 'zero duration', lines: [{ text: 'A', target_duration: 0 }] },
    { name: 'unbounded duration', lines: [{ text: 'A', target_duration: Infinity }] },
    { name: '51 lines', lines: Array.from({ length: 51 }, () => ({ text: 'A', target_duration: 1 })) },
  ])('rejects $name before reading the voice catalog', async ({ lines }) => {
    const tool = await createTool({ cid: CID });
    const result = await tool.execute({ action: 'preflight', ...VOICE_A, lines }, { workingDir: tmpDir } as any);

    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content as string)).toMatchObject({ code: 'E_BAD_INPUT' });
    expect(speechMock.resolveTtsSelection).not.toHaveBeenCalled();
    expect(voiced()).toEqual([]);
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
