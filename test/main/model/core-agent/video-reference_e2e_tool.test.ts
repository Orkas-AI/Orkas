import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import sharp from 'sharp';

// Preparation checks browser availability but never opens a render window.
vi.mock('electron', () => ({ BrowserWindow: function BrowserWindow() {} }));

const UID = 'reference-e2e';
let root: string;
let previousRoot: string | undefined;
let workspace: string;
let sourceDir: string;
let source: string;

beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-reference-e2e-'));
  previousRoot = process.env.ORKAS_WORKSPACE_ROOT;
  process.env.ORKAS_WORKSPACE_ROOT = root;
  vi.resetModules();
  (await import('../../../../src/main/features/users')).activateUser(UID);
  workspace = path.join(root, 'workspace');
  fs.mkdirSync(workspace);
  (await import('../../../../src/main/features/user_workspace')).setWorkspacePath(UID, workspace);
  sourceDir = path.join(root, UID, 'cloud/chat_attachments/earlier-chat');
  fs.mkdirSync(sourceDir, { recursive: true });
  source = path.join(sourceDir, 'reference.mp4');
  const { bundledFfmpegPaths } = await import('../../../../src/main/util/bundled-runtime');
  const { runVideoProcessForTest } = await import('../../../../src/main/features/video_studio');
  const generated = await runVideoProcessForTest(bundledFfmpegPaths().ffmpeg!, [
    '-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=blue:s=160x90:d=1',
    '-f', 'lavfi', '-i', 'color=c=red:s=160x90:d=1',
    '-filter_complex', '[0:v][1:v]concat=n=2:v=1:a=0[v]', '-map', '[v]', '-c:v', 'libx264', source,
  ], { timeoutMs: 10_000 });
  expect(generated.code).toBe(0);
});
afterEach(() => {
  if (previousRoot === undefined) delete process.env.ORKAS_WORKSPACE_ROOT;
  else process.env.ORKAS_WORKSPACE_ROOT = previousRoot;
  fs.rmSync(root, { recursive: true, force: true });
});

async function tool(extra: Record<string, unknown> = {}) {
  return (await import('../../../../src/main/model/core-agent/video-studio-tool')).createVideoStudioTool({
    userId: UID, cid: 'current-chat', readOnlyExtraRoots: [sourceDir], ...extra,
  } as any);
}
const ctx = () => ({ workingDir: workspace, state: {} } as any);
function body(result: any) { return JSON.parse(result.content); }

describe('reference video ingestion through the real tool', () => {
  it('keeps inspected source pixels visible while planning after intervening tool reads, then releases them', async () => {
    const { Session } = await import('../../../../src/core-agent/src/agent/session');
    const session = new Session();
    session.beginUserTurn([{ type: 'text', text: 'Plan a product video using the supplied reference.' }]);
    const input = { op: 'reference.inspect', input_path: source, sample_times: [0.25, 1.25] };
    session.addAssistantMessage([{ type: 'tool_use', id: 'inspect', name: 'video_studio', input }]);
    const inspected = await (await tool()).execute(input, ctx());
    expect(inspected.isError, inspected.content).toBeFalsy();
    expect(inspected.images).toHaveLength(1);
    session.addToolResult('inspect', inspected.content, inspected.images, inspected.isError, undefined, inspected.imageRetention);
    for (const id of ['read-skill', 'read-status', 'list-assets']) {
      session.addAssistantMessage([{ type: 'tool_use', id, name: 'metadata', input: {} }]);
      session.addToolResult(id, 'Planning inputs read.');
    }
    const modelImages = () => session.getMessagesForModel().flatMap(m => m.content).flatMap(c =>
      c.type === 'tool_result' ? c.images ?? [] : c.type === 'image' ? [c] : []);
    expect(modelImages().map(image => image.data)).toEqual(inspected.images!.map(image => image.data));
    expect(fs.existsSync(path.join(body(inspected).composition_dir, 'composition-manifest.json'))).toBe(false);
    session.completeActiveTurn();
    session.beginUserTurn([{ type: 'text', text: 'Continue.' }]);
    expect(modelImages()).toEqual([]);
  });

  it('freezes a cross-chat source, delivers colored frames, and feeds later paired review without a plan', async () => {
    const bytes = fs.readFileSync(source);
    const t = await tool();
    const result = await t.execute({ op: 'reference.inspect', input_path: source, sample_times: [0.25, 1.25] }, ctx());
    expect(result.isError, result.content).toBeFalsy();
    const report = body(result);
    expect(report).toMatchObject({ ok: true, op: 'reference.inspect', duration_sec: 2, width: 160, height: 90,
      source_sha256: crypto.createHash('sha256').update(bytes).digest('hex'), visual_evidence: { attached: true } });
    expect(result.images).toHaveLength(1);
    expect(fs.readFileSync(source)).toEqual(bytes);
    expect(fs.readFileSync(report.source_path)).toEqual(bytes);
    expect(report.source_path.startsWith(path.join(workspace, 'project/composition/assets/references'))).toBe(true);
    expect(report.samples.map((s: any) => s.time_seconds)).toEqual([0.25, 1.25]);
    const pixels = await sharp(Buffer.from(result.images![0].data, 'base64')).raw().toBuffer({ resolveWithObject: true });
    for (const channel of [0, 2]) {
      let count = 0;
      for (let i = 0; i < pixels.data.length; i += pixels.info.channels) {
        if (pixels.data[i + channel] > 180 && pixels.data[i + (2 - channel)] < 70) count++;
      }
      expect(count).toBeGreaterThan(1000);
    }
    const { writeReferenceComparison } = await import('../../../../src/main/features/video_studio');
    const comparison = await writeReferenceComparison({ compositionDirAbs: report.composition_dir,
      reviewInputs: { references: [{ id: 'source', path: report.reference_path, media_type: 'video',
        temporal_anchors: [{ source_start_sec: 1, source_end_sec: 1.5, target_scene_id: 'hero' }] }] },
      frameEvidence: { samples: [{ label: 'hero-mid', expected_scene_id: 'hero', path: report.samples[0].path, time_seconds: 0.5 }] },
    });
    expect(comparison).toMatchObject({ status: 'available', pairs: [{ source_time_sec: 1.25, target_scene_id: 'hero' }] });
    const red = await sharp((comparison!.pairs as any[])[0].source_frame).stats();
    expect(red.channels[0].mean - red.channels[2].mean).toBeGreaterThan(180);
    expect(fs.existsSync(path.join(report.composition_dir, 'composition-manifest.json'))).toBe(false);
  });

  it('delivers mapped source pixels at preparation without requiring a target render or another image read', async () => {
    const t = await tool({ turnId: 'prepare-turn', userMessage: '确认' });
    const inspected = body(await t.execute({ op: 'reference.inspect', input_path: source, sample_times: [0.25, 1.25] }, ctx()));
    const composition = inspected.composition_dir;
    const manifest = {
      schema_version: 1,
      composition: { id: 'main', width: 1920, height: 1080, duration: 10, fps: 30, language: 'en' },
      scenes: [{ id: 'hero', start: 0, duration: 10, approved_copy: ['Launch'], narration_refs: [], source_shots: [], roles: ['title', 'visual'] }],
      audio: { owner: 'none', tracks: [] },
      art_direction: { references: [{ id: 'source', path: inspected.reference_path, media_type: 'video',
        temporal_anchors: [{ source_start_sec: 1, source_end_sec: 1.5, target_scene_id: 'hero' }] }] },
    };
    fs.writeFileSync(path.join(composition, 'composition-manifest.json'), JSON.stringify(manifest));
    const approved = await t.execute({ op: 'composition.approve_plan', composition_dir: composition,
      decision_evidence: { source: 'user_message', gate: 'plan', decision: 'approve', quote: '确认' } }, ctx());
    expect(approved.isError, approved.content).toBeFalsy();
    const prepared = await t.execute({ op: 'composition.prepare', composition_dir: composition }, ctx());
    expect(prepared.isError, prepared.content).toBeFalsy();
    expect(prepared.images).toHaveLength(1);
    expect(prepared).toMatchObject({ imageRetention: 'active_turn' });
    expect(body(prepared).reference_authoring).toMatchObject({ status: 'available', attached: true,
      pairs: [{ source_time_sec: 1.25, target_scene_id: 'hero' }] });
    const stats = await sharp(Buffer.from(prepared.images![0].data, 'base64')).stats();
    expect(stats.channels[0].mean - stats.channels[2].mean).toBeGreaterThan(100);
    expect(fs.existsSync(path.join(composition, 'preview', 'first-frame.png'))).toBe(false);
    const manifestPath = path.join(composition, 'composition-manifest.json');
    const saved = fs.readFileSync(manifestPath);
    const { prepareComposition } = await import('../../../../src/main/features/video_studio');
    const cancelled = new AbortController(); cancelled.abort();
    const interrupted = await prepareComposition({ compositionDirAbs: composition, signal: cancelled.signal });
    expect(interrupted).toMatchObject({ ok: true, reference_authoring: { status: 'unavailable', pairs: [], contact_sheet: '' } });
    expect(fs.readFileSync(manifestPath)).toEqual(saved);
    fs.unlinkSync(inspected.source_path);
    fs.symlinkSync(source, inspected.source_path);
    const denied = await prepareComposition({ compositionDirAbs: composition });
    expect(denied).toMatchObject({ ok: true, reference_authoring: { status: 'unavailable',
      pairs: [], contact_sheet: '', issues: [{ reason: 'source_out_of_scope' }] } });
    expect(fs.readFileSync(manifestPath)).toEqual(saved);

  });

  it('accepts a read root appended after tool construction without granting output writes there', async () => {
    const runtimeReadOnlyRoots: string[] = [];
    const t = await tool({ readOnlyExtraRoots: [], runtimeReadOnlyRoots });
    const denied = await t.execute({ op: 'reference.inspect', input_path: source }, ctx());
    expect(denied.isError).toBe(true);
    runtimeReadOnlyRoots.push(sourceDir);
    const accepted = await t.execute({ op: 'reference.inspect', input_path: source, sample_times: [0] }, ctx());
    expect(accepted.isError, accepted.content).toBeFalsy();
    const blocked = await t.execute({ op: 'reference.inspect', input_path: source, composition_dir: sourceDir }, ctx());
    expect(blocked.isError).toBe(true);
    expect(fs.readdirSync(sourceDir)).toEqual(['reference.mp4']);
  });

  it('keeps the workspace writable when a reference grant overlaps it', async () => {
    const localSource = path.join(workspace, 'reference.mp4');
    fs.copyFileSync(source, localSource);
    const t = await tool({ readOnlyExtraRoots: [workspace] });
    const r = await t.execute({ op: 'reference.inspect', input_path: localSource, sample_times: [0] }, ctx());
    expect(r.isError, r.content).toBeFalsy();
    expect(body(r).visual_evidence.attached).toBe(true);
  });

  it('bounds source size before copying or decoding', async () => {
    fs.truncateSync(source, 256 * 1024 * 1024 + 1);
    const r = await (await tool()).execute({ op: 'reference.inspect', input_path: source }, ctx());
    expect(body(r).errorCode).toBe('E_REFERENCE_SIZE');
    expect(r.images).toBeUndefined();
    expect(fs.readdirSync(workspace)).toEqual([]);
  });

  it('rejects source/output symlink escapes and unauthorized sibling attachments', async () => {
    const t = await tool();
    const elsewhere = path.join(root, 'other-chat');
    fs.mkdirSync(elsewhere);
    const hidden = path.join(elsewhere, 'hidden.mp4');
    fs.copyFileSync(source, hidden);
    const link = path.join(sourceDir, 'escape.mp4');
    fs.symlinkSync(hidden, link);
    for (const input_path of [hidden, link]) {
      const r = await t.execute({ op: 'reference.inspect', input_path }, ctx());
      expect(r.isError).toBe(true);
      expect(r.images).toBeUndefined();
    }
    const composition = path.join(workspace, 'composition');
    fs.mkdirSync(composition);
    fs.symlinkSync(elsewhere, path.join(composition, 'assets'), 'dir');
    const r = await t.execute({ op: 'reference.inspect', input_path: source, composition_dir: composition }, ctx());
    expect(r.isError).toBe(true);
    expect(fs.readdirSync(elsewhere)).toEqual(['hidden.mp4']);
  });

  it('does not turn failed decoding or cancellation into stale visual evidence', async () => {
    const t = await tool();
    const success = await t.execute({ op: 'reference.inspect', input_path: source, sample_times: [0] }, ctx());
    expect(success.isError, success.content).toBeFalsy();
    const playlist = path.join(sourceDir, 'playlist.mp4');
    fs.writeFileSync(playlist, `ffconcat version 1.0\nfile '${source}'\n`);
    const broken = await t.execute({ op: 'reference.inspect', input_path: playlist }, ctx());
    expect(broken.isError).toBe(true);
    expect(broken.images).toBeUndefined();
    expect(body(broken)).not.toHaveProperty('contact_sheet');
    const controller = new AbortController(); controller.abort();
    const cancelled = await t.execute({ op: 'reference.inspect', input_path: source }, { ...ctx(), signal: controller.signal });
    expect(cancelled.isError).toBe(true);
    expect(cancelled.images).toBeUndefined();
    expect(fs.existsSync(body(success).contact_sheet)).toBe(true);
  });

  it.each([[[-1]], [[2]], [[0, 0]], [[0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6]], [['1']]])('rejects invalid or unbounded timestamps %j', async (sample_times) => {
    const result = await (await tool()).execute({ op: 'reference.inspect', input_path: source, sample_times }, ctx());
    expect(result.isError).toBe(true);
    expect(result.images).toBeUndefined();
    if (sample_times.length === 1 && sample_times[0] === 2) expect(body(result).duration_sec).toBe(2);
  });
});
