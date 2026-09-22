import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { spawnSync } from 'node:child_process';
import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
import * as videoDelivery from '../../../src/main/features/video_studio_delivery';
import { bundledFfmpegPaths } from '../../../src/main/util/bundled-runtime';
import { sha256OfFileStream } from '../../../src/main/util/sha256';
import { userMarketplaceAgentDir } from '../../../src/main/paths';
import { registerProducedOutputHooks } from '../../../src/main/features/produced_output_hooks';
import { editVideoProductionCaptions, videoProductionArtifactBinding, videoProductionIsCaptionEdit } from '../../../src/main/features/video_production_edit';
import {
  approveVideoProductionPlan, approveVideoProductionGeneration, beginVideoProductionGeneration, finishVideoProductionGeneration,
  readVideoProductionControlState, readVideoProductionPlanIdentity, executeVideoProductionLocalEdit,
} from '../../../src/main/features/video_production_control';

let root: string, planPath: string, statePath: string, source: string;
let oldRoot: string | undefined, undo: () => void;
const uid = 'caption-test';
let plan: any;
const request = { operation: 'generate', reference_image_urls: [], reference_image_paths: [], reference_video_urls: [], reference_video_paths: [], prompt: 'Blue cup on a table', ratio: '9:16', duration: 4, resolution: '480p', quality: 'balanced', generate_audio: false };
const save = () => fs.writeFileSync(planPath, JSON.stringify(plan));
const options = () => ({ statePath, planPath, userId: uid, roots: [root] });
const hash = (file: string) => sha256OfFileStream(file);
async function binding(file: string) {
  return videoProductionArtifactBinding({ userId: uid, file, identity: await readVideoProductionPlanIdentity(planPath), state: await readVideoProductionControlState(statePath, planPath) });
}
async function amend(text = 'LUMA 500 · ¥99') {
  plan.tracks = { captions: { lines: [{ text, start_sec: 0, target_sec: 1 }] } };
  save();
  await approveVideoProductionPlan({ statePath, planPath, turnId: 'caption-request' });
}
beforeEach(async () => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'video-bound-edit-')));
  oldRoot = process.env.ORKAS_WORKSPACE_ROOT;
  process.env.ORKAS_WORKSPACE_ROOT = path.join(root, 'data');
  undo = registerProducedOutputHooks({ finalizeFile: () => {} });
  planPath = path.join(root, 'project', 'plan.json'); statePath = path.join(root, 'control.json'); source = path.join(root, 'source.mp4');
  fs.mkdirSync(path.dirname(planPath), { recursive: true });
  plan = { aspect: '9:16', total_target_sec: 4, language: 'en', cost_estimate: { billable_generations: 1 },
    segments: [{ id: 'shot', order: 1, role: 'body', layer: 'primary', source: 'generate', target_sec: 4,
      spec: { media_kind: 'video', prompt: request.prompt, resolution: '480p', quality: 'balanced', generate_audio: false } }], tracks: {} };
  save();
  const core = path.join(userMarketplaceAgentDir(uid, '79df9cc89f5f'), 'skills/stage-edit/scripts/lib/video_edit_core.cjs');
  fs.mkdirSync(path.dirname(core), { recursive: true });
  fs.copyFileSync(path.resolve('resources/builtin/marketplace/agents/79df9cc89f5f/skills/stage-edit/scripts/lib/video_edit_core.cjs'), core);
  await approveVideoProductionPlan({ statePath, planPath, turnId: 'plan' });
  await approveVideoProductionGeneration({ statePath, planPath, turnId: 'generation' });
  const started = await beginVideoProductionGeneration({ statePath, planPath, segmentId: 'shot', kind: 'video', outputPath: source, request });
  const ffmpeg = bundledFfmpegPaths().ffmpeg!;
  const generated = spawnSync(ffmpeg, ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=blue:s=216x384:d=1', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', source], { timeout: 10000 });
  if (generated.status !== 0) throw new Error(String(generated.stderr));
  await finishVideoProductionGeneration({ statePath, planPath, segmentId: 'shot', kind: 'video', transactionId: started.transaction.transaction_id, ok: true, outputPath: source });
});
afterEach(() => {
  vi.restoreAllMocks();
  undo();
  if (oldRoot === undefined) delete process.env.ORKAS_WORKSPACE_ROOT; else process.env.ORKAS_WORKSPACE_ROOT = oldRoot;
  fs.rmSync(root, { recursive: true, force: true });
});

describe('bound generated-video caption revisions', () => {
  it('rejects source replacement after provenance verification and before caption rendering', async () => {
    await amend();
    const probe = videoDelivery.probeDeliveredVideo;
    vi.spyOn(videoDelivery, 'probeDeliveredVideo').mockImplementationOnce(async (...args) => {
      const spec = await probe(...args);
      fs.appendFileSync(source, 'changed after source verification');
      return spec;
    });
    await expect(editVideoProductionCaptions(options())).rejects.toThrow('E_VIDEO_PRODUCTION_EDIT_SOURCE_UNVERIFIED');
    expect((await readVideoProductionControlState(statePath, planPath)).local_outputs).toBeUndefined();
    const renderDir = path.join(path.dirname(planPath), 'render');
    expect(fs.existsSync(renderDir) ? fs.readdirSync(renderDir) : []).toEqual([]);
  });

  it('binds actual provider bytes, accepts byte-identical relocation, and rejects unrelated bytes', async () => {
    expect(await binding(source)).toBe('generation');
    const unrelated = path.join(root, 'other.mp4'); fs.copyFileSync(source, unrelated);
    expect(await binding(unrelated)).toBe('generation');
    fs.appendFileSync(unrelated, 'unregistered edit');
    expect(await binding(unrelated)).toBeNull();
  });

  it('renders captions with the real codec, reuses a completed edit, and rebuilds a revision from the original rather than the captioned version', async () => {
    const original = await hash(source);
    await amend();
    const [first, duplicate] = await Promise.all([editVideoProductionCaptions(options()), editVideoProductionCaptions(options())]);
    expect(duplicate.reused).toBe(true);
    expect(duplicate.artifact.output_path).toBe(first.artifact.output_path);
    expect(first.reused).toBe(false);
    expect(first.artifact.source_path).toBe(source);
    expect(await hash(source)).toBe(original);
    expect(await binding(first.artifact.output_path)).toBe('local_edit');
    expect(await hash(first.artifact.output_path)).not.toBe(original);
    expect((await editVideoProductionCaptions(options())).reused).toBe(true);
    await amend('LUMA 500 · ¥89');
    plan.segments[0].produced_path = first.artifact.output_path; save();
    expect(await binding(first.artifact.output_path)).toBeNull();
    const second = await editVideoProductionCaptions(options());
    expect(second.artifact.source_path).toBe(source);
    expect(second.artifact.output_path).not.toBe(first.artifact.output_path);
    expect(second.artifact.output_sha256).not.toBe(first.artifact.output_sha256);
    expect(fs.readFileSync(path.join(path.dirname(second.artifact.output_path), 'video.srt'), 'utf8')).toContain('¥89');
    expect(await hash(source)).toBe(original);
    const state = await readVideoProductionControlState(statePath, planPath);
    expect(state.local_outputs).toHaveLength(2);
    expect(state.transaction_history).toHaveLength(1);
    expect(state.transactions).toEqual({});
  });

  it('restores legacy generation provenance from its signed request without trusting changed generation intent', async () => {
    const legacy = await readVideoProductionControlState(statePath, planPath);
    delete legacy.transactions['video:shot'].intent_signature;
    fs.writeFileSync(statePath, JSON.stringify(legacy));
    await amend();
    expect(await binding(source)).toBe('generation');
    const result = await editVideoProductionCaptions(options());
    expect(result.artifact.source_path).toBe(source);
    plan.segments[0].spec.prompt = 'Different product'; save();
    await approveVideoProductionPlan({ statePath, planPath, turnId: 'different-product' });
    expect(await binding(source)).toBeNull();
    await expect(editVideoProductionCaptions(options())).rejects.toThrow('E_VIDEO_PRODUCTION_EDIT_SOURCE_UNVERIFIED');
  });

  it('keeps the previous complete output when a later edit fails validation or is cancelled', async () => {
    await amend(); const first = await editVideoProductionCaptions(options());
    await amend('Revision'); plan.tracks.captions.lines[0].target_sec = 10; save();
    await approveVideoProductionPlan({ statePath, planPath, turnId: 'invalid-window' });
    await expect(editVideoProductionCaptions(options())).rejects.toThrow('E_VIDEO_PRODUCTION_CAPTION_INVALID');
    await amend('Valid revision');
    const controller = new AbortController(); controller.abort();
    await expect(editVideoProductionCaptions({ ...options(), signal: controller.signal })).rejects.toThrow();
    expect((await readVideoProductionControlState(statePath, planPath)).local_outputs).toEqual([first.artifact]);
    expect(await hash(first.artifact.output_path)).toBe(first.artifact.output_sha256);
  });

  it('retains the last version after a child codec failure and rejects cancellation at the commit boundary', async () => {
    await amend(); const first = await editVideoProductionCaptions(options());
    await amend('New caption');
    const core = path.join(userMarketplaceAgentDir(uid, '79df9cc89f5f'), 'skills/stage-edit/scripts/lib/video_edit_core.cjs');
    fs.writeFileSync(core, 'exports.editVideo = async () => ({ok:false,errorCode:"E_CODEC_FAILURE"});');
    await expect(editVideoProductionCaptions(options())).rejects.toThrow('E_VIDEO_PRODUCTION_EDIT_FAILED');
    const controller = new AbortController();
    await expect(executeVideoProductionLocalEdit({ statePath, planPath, signal: controller.signal, execute: async () => {
      controller.abort();
      return first.artifact;
    } })).rejects.toThrow('E_VIDEO_PRODUCTION_EDIT_CANCELLED');
    expect((await readVideoProductionControlState(statePath, planPath)).local_outputs).toEqual([first.artifact]);
    expect(await hash(first.artifact.output_path)).toBe(first.artifact.output_sha256);
  });

  it('does not register success when the canonical plan changes during execution', async () => {
    await amend();
    const output = path.join(root, 'candidate.mp4');
    await expect(executeVideoProductionLocalEdit({ statePath, planPath, execute: async () => {
      fs.copyFileSync(source, output);
      plan.tracks.captions.lines[0].text = 'Changed while rendering'; save();
      return { source_path: source, source_sha256: await hash(source), output_path: output, output_sha256: await hash(output) };
    } })).rejects.toThrow('E_VIDEO_PRODUCTION_EDIT_STALE');
    expect((await readVideoProductionControlState(statePath, planPath)).local_outputs).toBeUndefined();
  });

  it('leaves image, provided-footage and audio-mix assemblies with their existing execution path', async () => {
    await amend();
    expect(videoProductionIsCaptionEdit(plan)).toBe(true);
    const imagePlan = structuredClone(plan); imagePlan.segments[0].spec.media_kind = 'image';
    expect(videoProductionIsCaptionEdit(imagePlan)).toBe(false);
    const provided = structuredClone(plan); provided.segments[0].source = 'provided';
    expect(videoProductionIsCaptionEdit(provided)).toBe(false);
    const mixed = structuredClone(plan); mixed.tracks.music = { path: 'bed.mp3' };
    expect(videoProductionIsCaptionEdit(mixed)).toBe(false);
    const joined = structuredClone(plan); joined.segments.push({ ...joined.segments[0], id: 'second' });
    expect(videoProductionIsCaptionEdit(joined)).toBe(false);
  });

  it('requires the current plan approval and never treats a pure plan as a local edit', async () => {
    await expect(editVideoProductionCaptions(options())).rejects.toThrow('E_VIDEO_PRODUCTION_LOCAL_EDIT_REQUIRED');
    await amend(); plan.tracks.captions.lines[0].text = 'Unsigned amendment'; save();
    await expect(editVideoProductionCaptions(options())).rejects.toThrow('E_VIDEO_PRODUCTION_GATE_B_STALE');
    expect((await readVideoProductionControlState(statePath, planPath)).local_outputs).toBeUndefined();
  });
});
