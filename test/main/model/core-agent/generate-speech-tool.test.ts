import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const speechMock = vi.hoisted(() => ({
  generateSpeech: vi.fn(),
  estimateNarrationDuration: vi.fn(),
  assessNarrationFit: vi.fn(),
  recordVideoProductionNarrationLine: vi.fn(),
}));

vi.mock('../../../../src/main/features/permissions', () => ({
  getLocalExecGranted: () => true,
}));

vi.mock('../../../../src/main/features/tts', () => ({
  hasConfiguredTtsProvider: () => true,
  generateSpeech: speechMock.generateSpeech,
  estimateNarrationDuration: speechMock.estimateNarrationDuration,
  assessNarrationFit: speechMock.assessNarrationFit,
  measureNarrationUnits: (text: string) => ({ unit: 'characters', units: text.length }),
}));

vi.mock('../../../../src/main/features/video_production_control', () => ({
  videoProductionControlStatePath: () => '/tmp/mock-video-production-state.json',
  validateVideoProductionPlanApproval: async () => ({
    identity: { signature: 'sig-approved-edl' },
    state: {},
  }),
  recordVideoProductionNarrationLine: speechMock.recordVideoProductionNarrationLine,
}));

const UID = 'u-gspeech-001';
const CID = 'conv-speech';
const PROJECT_ID = 'project-speech';

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
  speechMock.recordVideoProductionNarrationLine.mockReset();
  speechMock.recordVideoProductionNarrationLine.mockResolvedValue({});
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

async function createTool(opts: { cid?: string; projectId?: string; agentId?: string }) {
  const mod = await import('../../../../src/main/model/core-agent/generate-speech-tool');
  return mod.createGenerateSpeechTool({ userId: UID, ...opts });
}

function lastOutputPath(): string {
  return (speechMock.generateSpeech.mock.calls[0]?.[0] as { outputAbsPath: string }).outputAbsPath;
}

describe('generate_speech output paths', () => {
  it('forces VideoStudio COMPOSE narration through the production-stage operation', async () => {
    const tool = await createTool({ cid: CID, agentId: '79df9cc89f5f' });

    const result = await tool.execute(
      { text: 'approved narration', output_path: 'project/composition/assets/narration.mp3' },
      { workingDir: tmpDir } as any,
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain('E_COMPOSE_NARRATION_STAGE_OWNED');
    expect(result.content).toContain('composition.materialize_narration');
    expect(speechMock.generateSpeech).not.toHaveBeenCalled();
  });

  it('binds VideoStudio EDL speech to the approved plan selection and exact line', async () => {
    const workspace = await import('../../../../src/main/features/user_workspace');
    const workingDir = workspace.getWorkspacePath(UID);
    const planPath = path.join(workingDir, 'project', 'plan.json');
    fs.mkdirSync(path.dirname(planPath), { recursive: true });
    fs.writeFileSync(planPath, JSON.stringify({
      tracks: {
        narration: {
          synthesis: {
            route_ref: 'managed:orkas-voice',
            voice_ref: 'managed:orkas-voice:voice:test-vivi',
            display_name: 'Vivi',
            language: 'zh-CN',
            speed: 1,
          },
          segments: [{ text: 'approved line', target_sec: 3 }],
        },
      },
    }));
    const tool = await createTool({ agentId: '79df9cc89f5f' });

    const rejected = await tool.execute({
      text: 'changed line',
      output_path: 'project/assets/narration/line-00.mp3',
      route_ref: 'managed:orkas-voice',
      voice_ref: 'managed:orkas-voice:voice:test-vivi',
      language: 'zh-CN',
      speed: 1,
      target_duration: 3,
      production_plan_path: 'project/plan.json',
      narration_segment_index: 0,
    }, { workingDir, state: {} } as any);
    expect(rejected.isError).toBe(true);
    expect(rejected.content).toContain('E_TTS_PLAN_TEXT_MISMATCH');
    expect(speechMock.generateSpeech).not.toHaveBeenCalled();

    const accepted = await tool.execute({
      text: 'approved line',
      output_path: 'project/assets/narration/line-00.mp3',
      route_ref: 'managed:orkas-voice',
      voice_ref: 'managed:orkas-voice:voice:test-vivi',
      language: 'zh-CN',
      speed: 1,
      target_duration: 3,
      production_plan_path: 'project/plan.json',
      narration_segment_index: 0,
    }, { workingDir, state: {} } as any);
    expect(accepted.isError).toBeFalsy();
    expect(speechMock.generateSpeech).toHaveBeenCalledWith(expect.objectContaining({
      routeRef: 'managed:orkas-voice',
      voiceRef: 'managed:orkas-voice:voice:test-vivi',
      language: 'zh-CN',
      text: 'approved line',
    }));
  });

  it('tells a plan-bound line to fix the script, not to retime the signed plan', async () => {
    // 2026-08-10 AUTO run: every one of seven plan-bound lines carried
    // "Retime the scene map, HTML timeline, and audio track to this duration"
    // directly under its own shortfall warning. Those windows were signed at
    // Gate B and the video is cut to them, so that instruction is the opposite
    // of the fix — and it is the standing complaint that the agent adapts
    // timing instead of adjusting the narration.
    const workspace = await import('../../../../src/main/features/user_workspace');
    const workingDir = workspace.getWorkspacePath(UID);
    const planPath = path.join(workingDir, 'project', 'plan.json');
    fs.mkdirSync(path.dirname(planPath), { recursive: true });
    fs.writeFileSync(planPath, JSON.stringify({
      tracks: {
        narration: {
          synthesis: {
            route_ref: 'managed:orkas-voice',
            voice_ref: 'managed:orkas-voice:voice:test-vivi',
            display_name: 'Vivi',
            language: 'zh-CN',
            speed: 1,
          },
          segments: [{ text: 'approved line', target_sec: 3 }],
        },
      },
    }));
    const tool = await createTool({ agentId: '79df9cc89f5f' });

    const bound = await tool.execute({
      text: 'approved line',
      output_path: 'project/audio/narration-00.mp3',
      route_ref: 'managed:orkas-voice',
      voice_ref: 'managed:orkas-voice:voice:test-vivi',
      language: 'zh-CN',
      speed: 1,
      target_duration: 3,
      production_plan_path: 'project/plan.json',
      narration_segment_index: 0,
    }, { workingDir, state: {} } as any);

    expect(bound.isError).toBeFalsy();
    expect(bound.content).toContain('measured_duration_sec: 1.00');
    expect(bound.content).toContain('measured_duration_sec is the authority for this approved production line');
    expect(bound.content).not.toContain('Retime the scene map, HTML timeline, and audio track');
  });

  it('does not promise an inherited AUTO script repair when only natural pace is over', async () => {
    // The signed speed makes the produced bytes fit: 5.5s in a 6s window.
    // Backing speed=1.2 out yields 6.6s and used to print an `over` warning plus
    // "the current approval keeps". Gate B records and judges the actual 5.5s,
    // so following that advice invalidated the approval for no measured overrun.
    const workspace = await import('../../../../src/main/features/user_workspace');
    const workingDir = workspace.getWorkspacePath(UID);
    const planPath = path.join(workingDir, 'project', 'plan.json');
    fs.mkdirSync(path.dirname(planPath), { recursive: true });
    fs.writeFileSync(planPath, JSON.stringify({
      tracks: {
        narration: {
          synthesis: {
            route_ref: 'managed:orkas-voice',
            voice_ref: 'managed:orkas-voice:voice:test-vivi',
            display_name: 'Vivi',
            language: 'zh-CN',
            speed: 1.2,
          },
          segments: [{ text: 'approved line', target_sec: 6 }],
        },
      },
    }));
    speechMock.generateSpeech.mockImplementationOnce(async ({ outputAbsPath }: { outputAbsPath: string }) => ({
      ok: true,
      path: outputAbsPath,
      bytes: 12,
      backend: 'mock',
      durationSec: 5.5,
    }));

    const result = await (await createTool({ agentId: '79df9cc89f5f' })).execute({
      text: 'approved line',
      output_path: 'project/audio/narration-fast.mp3',
      route_ref: 'managed:orkas-voice',
      voice_ref: 'managed:orkas-voice:voice:test-vivi',
      language: 'zh-CN',
      speed: 1.2,
      target_duration: 6,
      production_plan_path: 'project/plan.json',
      narration_segment_index: 0,
    }, { workingDir, state: {} } as any);

    expect(result.isError).toBeFalsy();
    expect(speechMock.assessNarrationFit).toHaveBeenCalledWith(expect.objectContaining({
      measuredSec: 5.5,
      targetSec: 6,
    }));
    expect(result.content).toContain('fit basis 5.50s / 6.00s');
    expect(result.content).toContain('quality note only');
    expect(result.content).toContain('it fits target_duration');
    expect(result.content).toContain('quality-driven text or speed change is a plan amendment');
    expect(result.content).not.toContain('timing-repair budget can inherit');
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
    expect(result.content).toContain('Retime the scene map, HTML timeline, and audio track');
  });

  it('records each produced EDL narration line against the plan it was bound to', async () => {
    // 2026-08-06: an assembled 60s promo shipped with five spoken lines and the
    // review drawer read "narration: not started" over the finished player. The
    // assembled route's narration is parent-owned by design — children render
    // silent — but nothing recorded what the parent produced, so the panel's
    // only source was per-child state that an assembled child is forbidden to
    // have. `produced_path` write-back is not a substitute: all five lines
    // shipped with it null. The host performs the synthesis; it records it.
    const workspace = await import('../../../../src/main/features/user_workspace');
    const workingDir = workspace.getWorkspacePath(UID);
    const planPath = path.join(workingDir, 'project', 'plan.json');
    fs.mkdirSync(path.dirname(planPath), { recursive: true });
    fs.writeFileSync(planPath, JSON.stringify({
      tracks: {
        narration: {
          synthesis: {
            route_ref: 'managed:orkas-voice',
            voice_ref: 'managed:orkas-voice:voice:test-vivi',
            display_name: 'Vivi',
            language: 'zh-CN',
            speed: 1,
          },
          segments: [
            { text: 'line one', target_sec: 3 },
            { text: 'line two', target_sec: 4 },
          ],
        },
      },
    }));
    const tool = await createTool({ agentId: '79df9cc89f5f' });
    const line = (index: number, text: string, targetSec: number) => tool.execute({
      text,
      output_path: `project/audio/narration-0${index}.mp3`,
      route_ref: 'managed:orkas-voice',
      voice_ref: 'managed:orkas-voice:voice:test-vivi',
      language: 'zh-CN',
      speed: 1,
      target_duration: targetSec,
      production_plan_path: 'project/plan.json',
      narration_segment_index: index,
    }, { workingDir, state: {} } as any);

    expect((await line(1, 'line two', 4)).isError).toBeFalsy();
    expect(speechMock.recordVideoProductionNarrationLine).toHaveBeenCalledTimes(1);
    expect(speechMock.recordVideoProductionNarrationLine).toHaveBeenLastCalledWith(
      expect.objectContaining({
        planPath,
        planSignature: 'sig-approved-edl',
        line: expect.objectContaining({
          segment_index: 1,
          path: path.join(workingDir, 'project', 'audio', 'narration-01.mp3'),
          measured_duration_sec: 1,
          backend: 'mock',
          language: 'zh-CN',
          speed: 1,
        }),
        // The line's own identity, so a later plan amendment invalidates only
        // the lines it actually changed — these are the binding-validated
        // values, i.e. the approved plan's own.
        identity: {
          text: 'line two',
          routeRef: 'managed:orkas-voice',
          voiceRef: 'managed:orkas-voice:voice:test-vivi',
          language: 'zh-CN',
          speed: 1,
        },
      }),
    );

    // The record follows the bytes. A rejected line produced nothing to record,
    // and a recording failure must never surface as a failed synthesis the
    // model would pay to repeat.
    speechMock.recordVideoProductionNarrationLine.mockReset();
    expect((await line(0, 'not the approved line', 3)).isError).toBe(true);
    expect(speechMock.recordVideoProductionNarrationLine).not.toHaveBeenCalled();

    speechMock.recordVideoProductionNarrationLine.mockRejectedValue(new Error('disk full'));
    expect((await line(0, 'line one', 3)).isError).toBeFalsy();
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
    expect(speechMock.recordVideoProductionNarrationLine).not.toHaveBeenCalled();
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

  it('rejects clearly overlong timed narration before a paid synthesis request', async () => {
    speechMock.estimateNarrationDuration.mockReturnValue({
      estimatedSec: 67,
      unit: 'words',
      units: 160,
      unitsPerSec: 2.5,
    });
    const tool = await createTool({ cid: CID });

    const result = await tool.execute(
      { text: 'long narration', output_path: 'narration.mp3', target_duration: 54 },
      { workingDir: tmpDir } as any,
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain('No speech request was sent');
    expect(speechMock.generateSpeech).not.toHaveBeenCalled();
  });

  it('does not bill twice by overwriting the same output path in one turn', async () => {
    const tool = await createTool({ cid: CID });
    const input = { text: 'hello', output_path: 'narration.mp3', target_duration: 10 };

    const first = await tool.execute(input, { workingDir: tmpDir } as any);
    const second = await tool.execute({ ...input, text: 'revised hello' }, { workingDir: tmpDir } as any);

    expect(first.isError).toBeFalsy();
    expect(first.content).toContain('measured_duration_sec: 1.00');
    expect(first.content).toContain('Retime the scene map, HTML timeline, and audio track');
    expect(first.content).toContain('do not regenerate merely to match target_duration');
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
