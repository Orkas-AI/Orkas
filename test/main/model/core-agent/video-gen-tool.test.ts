import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  generateVideo: vi.fn(),
  workspace: '',
}));

vi.mock('../../../../src/main/features/video_gen', () => ({
  generateVideo: h.generateVideo,
}));
vi.mock('../../../../src/main/paths', async importOriginal => ({
  ...await importOriginal(),
  userLocalRoot: (uid: string) => path.join(h.workspace, '.local', uid),
}));
vi.mock('../../../../src/main/features/user_workspace', () => ({
  getWorkspacePath: () => h.workspace,
}));
vi.mock('../../../../src/main/logger', () => ({
  createLogger: () => ({ warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

import { createVideoGenTool } from '../../../../src/main/model/core-agent/video-gen-tool';

let root = '';

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-open-video-tool-'));
  h.workspace = root;
  h.generateVideo.mockReset().mockImplementation(async ({ outputAbsPath }) => ({
    ok: true,
    path: outputAbsPath,
    bytes: 256,
    provider: 'orkas-api',
    model: 'orkas-video',
    taskId: 'video-test-task',
    videoUrl: 'https://cdn.example.test/video.mp4',
    status: 'succeeded',
  }));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('generate_video tool in the open build', () => {
  it('dispatches the configured public provider and publishes an MP4 path', async () => {
    const published: string[] = [];
    const progress = vi.fn();
    const tool = createVideoGenTool({
      userId: 'user-a',
      cid: 'conv_123',
      turnId: 'turn-456',
      onFileWritten: (file) => published.push(file),
    });
    const result = await tool.execute(
      {
        prompt: 'a paper boat crosses a pond',
        output_path: 'clip.mov',
        duration: 6,
        quality: 'quality',
        generate_audio: false,
      },
      { workingDir: root, emitProgress: progress } as any,
    );

    expect(result.isError).not.toBe(true);
    expect(h.generateVideo).toHaveBeenCalledWith(expect.objectContaining({
      prompt: 'a paper boat crosses a pond',
      outputAbsPath: path.join(root, 'clip.mp4'),
      duration: 6,
      quality: 'quality',
      generateAudio: false,
      usageContext: { conversationId: 'conv_123', turnId: 'turn-456' },
    }));
    expect(published).toEqual([path.join(root, 'clip.mp4')]);
    expect(String(result.content)).toContain('orkas-api/orkas-video');
    expect(String(result.content)).toContain('[video](');
  });

  it('rejects out-of-scope outputs and invalid edit requests before dispatch', async () => {
    const tool = createVideoGenTool({ userId: 'user-a' });
    const outside = await tool.execute(
      { prompt: 'a dot', output_path: path.join(root, '..', 'outside.mp4') },
      { workingDir: root } as any,
    );
    const missingReference = await tool.execute(
      { prompt: 'change the ending', output_path: 'edit.mp4', operation: 'edit' },
      { workingDir: root } as any,
    );

    expect(outside.isError).toBe(true);
    expect(String(outside.content)).toContain('E_PATH_OUT_OF_SCOPE');
    expect(missingReference.isError).toBe(true);
    expect(String(missingReference.content)).toContain('requires at least one reference video');
    expect(h.generateVideo).not.toHaveBeenCalled();
  });

  it('turns exhausted public API credits into a non-retry instruction', async () => {
    h.generateVideo.mockResolvedValueOnce({
      ok: false,
      errorCode: 'CREDITS_EXHAUSTED',
      message: 'quota exhausted',
    });
    const tool = createVideoGenTool({ userId: 'user-a' });
    const result = await tool.execute(
      { prompt: 'a quiet landscape', output_path: 'clip.mp4' },
      { workingDir: root } as any,
    );

    expect(result.isError).toBe(true);
    expect(String(result.content)).toContain('E_CREDITS_EXHAUSTED');
    expect(String(result.content)).toContain('Do not retry');
  });
  it.each([false, true, undefined])('preserves approval only for structured undispatched failure (dispatched=%s)',async dispatched=>{
    const prompt='A red product rotates on a clean studio table';
    const planPath=path.join(root,'plan.json');
    fs.writeFileSync(planPath,JSON.stringify({aspect:'9:16',total_target_sec:5,language:'zh',
      delivery_promise:{type:'motion_led',source_required:false,motion_min_ratio:1},
      segments:[{id:'shot-1',order:1,role:'hook',layer:'primary',source:'generate',target_sec:5,
        spec:{media_kind:'video',prompt,resolution:'720p',quality:'balanced',generate_audio:false}}],
      cost_estimate:{billable_generations:1}}));
    const control=await import('../../../../src/main/features/video_production_control');
    const statePath=control.videoProductionControlStatePath({userId:'test-video-owner',planPath});
    await control.approveVideoProductionPlan({statePath,planPath,turnId:'gate-b'});
    await control.approveVideoProductionGeneration({statePath,planPath,turnId:'gate-c'});
    const approved=await control.readVideoProductionControlState(statePath,planPath);
    const tool=createVideoGenTool({userId:'test-video-owner',agentId:'79df9cc89f5f'});
    const generateShot=()=>tool.execute({prompt,output_path:path.join(root,'shot-1.mp4'),ratio:'9:16',duration:5,
      resolution:'720p',quality:'balanced',generate_audio:false,production_plan_path:planPath,production_segment_id:'shot-1'},
      {workingDir:root} as any);
    const error={ok:false,errorCode:'PROVIDER_API_ERROR',message:'fixture terminal failure',...(dispatched===undefined?{}:{dispatched})};
    h.generateVideo.mockResolvedValueOnce(error);
    const result=await generateShot();
    expect(result).toMatchObject({isError:true,content:'[PROVIDER_API_ERROR] fixture terminal failure'});
    const state=await control.readVideoProductionControlState(statePath,planPath);
    expect(state.generation_approval).toEqual(approved.generation_approval);
    if(dispatched===false){
      expect(state.transactions['video:shot-1']).toBeUndefined();
      expect(state.transaction_history).toEqual([expect.objectContaining({status:'released',error_code:'PROVIDER_API_ERROR',approval_id:approved.generation_approval!.approval_id})]);
      // Same explicit approval may make one new attempt, never an automatic replay.
      h.generateVideo.mockImplementationOnce(async()=>{
        const active=await control.readVideoProductionControlState(statePath,planPath);
        expect(active.transactions['video:shot-1']).toMatchObject({status:'pending',approval_id:approved.generation_approval!.approval_id});
        return {...error,dispatched:true};
      });
      await generateShot();expect(h.generateVideo).toHaveBeenCalledTimes(2);
    }else{
      expect(state.transactions['video:shot-1']).toMatchObject({status:'failed',approval_id:approved.generation_approval!.approval_id});
      expect(state.transaction_history).toEqual([]);
    }
    const blocked=await generateShot();expect(blocked.isError).toBe(true);
    expect(blocked.content).toContain('E_VIDEO_PRODUCTION_GENERATION_REAPPROVAL_REQUIRED');
    expect(h.generateVideo).toHaveBeenCalledTimes(dispatched===false?2:1);
  });

});
