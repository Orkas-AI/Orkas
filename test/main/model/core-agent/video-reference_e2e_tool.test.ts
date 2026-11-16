import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import sharp from 'sharp';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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

const NOTES = 'These frames stay in your context until this turn ends or six newer images arrive. '
  + 'If this video is the reference, before writing the video list in reference-notes.md what a viewer would name as its look and whether you reuse, recreate or drop each, then build the video from that list.';

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

  it('asks for written notes, and keeps the frames beside later images until six newer ones arrive', async () => {
    const { Session } = await import('../../../../src/core-agent/src/agent/session');
    const session = new Session();
    session.beginUserTurn([{ type: 'text', text: 'Remake this reference for my product.' }]);
    const input = { op: 'reference.inspect', input_path: source, sample_times: [0.25, 1.25] };
    session.addAssistantMessage([{ type: 'tool_use', id: 'inspect', name: 'video_studio', input }]);
    const inspected = await (await tool()).execute(input, ctx());
    expect(inspected.isError, inspected.content).toBeFalsy();
    expect(body(inspected)).toMatchObject({ ok: true, message: NOTES });
    session.addToolResult('inspect', inspected.content, inspected.images, inspected.isError, undefined, inspected.imageRetention);
    const capture = (id: string) => {
      session.addAssistantMessage([{ type: 'tool_use', id, name: 'video_studio', input: { op: 'video.sheet' } }]);
      session.addToolResult(id, '{"ok":true}', [{ type: 'image' as const, data: id, mediaType: 'image/png' }], false, undefined, 'active_turn');
    };
    const modelImages = () => session.getMessagesForModel().flatMap(m => m.content).flatMap(c => c.type === 'tool_result' ? c.images ?? [] : []);
    const sheet = inspected.images![0].data;
    for (const id of ['sheet-1', 'sheet-2', 'sheet-3', 'sheet-4', 'sheet-5']) capture(id);
    expect(modelImages().map(image => image.data)).toEqual([sheet, 'sheet-1', 'sheet-2', 'sheet-3', 'sheet-4', 'sheet-5']);
    capture('sheet-6');
    expect(modelImages().map(image => image.data)).not.toContain(sheet);
  });

  it('freezes a cross-chat source and returns its colored frames without a plan', async () => {
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
    expect(report.source_path.startsWith(path.join(workspace, 'references/assets/references'))).toBe(true);
    expect(report.samples.map((s: any) => s.time_seconds)).toEqual([0.25, 1.25]);
    const pixels = await sharp(Buffer.from(result.images![0].data, 'base64')).raw().toBuffer({ resolveWithObject: true });
    for (const channel of [0, 2]) {
      let count = 0;
      for (let i = 0; i < pixels.data.length; i += pixels.info.channels) {
        if (pixels.data[i + channel] > 180 && pixels.data[i + (2 - channel)] < 70) count++;
      }
      expect(count).toBeGreaterThan(1000);
    }
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

  it.each([[[-1]], [[2]], [[0, 0]], [Array.from({ length: 33 }, (_v, i) => i * 0.05)], [['1']]])('rejects invalid or unbounded timestamps %j', async (sample_times) => {
    const result = await (await tool()).execute({ op: 'reference.inspect', input_path: source, sample_times }, ctx());
    expect(result.isError).toBe(true);
    expect(result.images).toBeUndefined();
    if (sample_times.length === 1 && sample_times[0] === 2) expect(body(result).duration_sec).toBe(2);
  });

  it.each([{ seconds: 2, silent: false }, { seconds: 3.9, silent: false }, { seconds: 4, silent: false }, { seconds: 2, silent: true }])(
    'reports an audio track independently of tempo for $seconds seconds (silent=$silent)', async ({ seconds, silent }) => {
      const { bundledFfmpegPaths } = await import('../../../../src/main/util/bundled-runtime');
      const { runVideoProcessForTest } = await import('../../../../src/main/features/video_studio');
      const file = path.join(sourceDir, 'with-audio.mp4');
      const made = await runVideoProcessForTest(bundledFfmpegPaths().ffmpeg!, ['-v', 'error', '-f', 'lavfi', '-i', `color=s=32x32:d=${seconds}`,
        '-f', 'lavfi', '-i', silent ? `anullsrc=r=11025:cl=mono:d=${seconds}` : `sine=frequency=440:sample_rate=11025:duration=${seconds}`,
        '-c:v', 'mpeg4', '-c:a', 'aac', file], { timeoutMs: 10000 });
      expect(made.code).toBe(0); expect(made.stderr).toBe('');
      const bytes = fs.readFileSync(file);
      const report = body(await (await tool()).execute({ op: 'reference.inspect', input_path: file }, ctx()));
      expect(report.ok).toBe(true); expect(report.audio.present).toBe(true);
      if (seconds < 4 || silent) expect(report.audio).toEqual({ present: true, bpm: null, beat: 'unclear' });
      expect(fs.readFileSync(file)).toEqual(bytes);
    });

  it('samples each detected shot and reports cut times and a silent soundtrack on the default pass', async () => {
    const report = body(await (await tool()).execute({ op: 'reference.inspect', input_path: source }, ctx()));
    expect(report.ok).toBe(true);
    expect(report.shots).toMatchObject({ detected: true, count: 2 });
    expect(report.shots.cuts_sec).toHaveLength(1);
    expect(Math.abs(report.shots.cuts_sec[0] - 1)).toBeLessThan(0.1);
    expect(report.audio).toEqual({ present: false, bpm: null, beat: 'none' });
    const times = report.samples.map((sample: any) => sample.time_seconds);
    expect(times[0]).toBe(0);
    // One still just after the cut, besides the evenly spread fallbacks.
    expect(times.some((t: number) => t > 1 && t <= 1.45)).toBe(true);
  });

  it.skipIf(process.platform === 'win32')('keeps audio presence when rhythm decoding fails and skips it for explicit stills', async () => {
    const { bundledFfmpegPaths } = await import('../../../../src/main/util/bundled-runtime');
    const { runVideoProcessForTest } = await import('../../../../src/main/features/video_studio');
    const real = bundledFfmpegPaths().ffmpeg!;
    const file = path.join(sourceDir, 'undecodable-audio.mp4');
    const made = await runVideoProcessForTest(real, ['-v', 'error', '-i', source, '-f', 'lavfi', '-i', 'sine=duration=2', '-c:v', 'copy', '-c:a', 'aac', file], { timeoutMs: 10000 });
    expect(made.code).toBe(0);
    const wrapper = path.join(root, 'decode-wrapper'), calls = path.join(root, 'audio-calls');
    fs.writeFileSync(wrapper, '#!/usr/bin/env node\nconst fs=require("node:fs"), cp=require("node:child_process"), a=process.argv.slice(2);\n'
      + `if(a.includes('f32le')){fs.appendFileSync(${JSON.stringify(calls)},'1');process.exit(1);}\n`
      + `const r=cp.spawnSync(${JSON.stringify(real)},a,{stdio:'inherit'});process.exit(r.status??1);\n`);
    fs.chmodSync(wrapper, 0o755);
    const previous = process.env.ORKAS_BUNDLED_FFMPEG; process.env.ORKAS_BUNDLED_FFMPEG = wrapper;
    try {
      const t = await tool();
      const report = body(await t.execute({ op: 'reference.inspect', input_path: file }, ctx()));
      expect(report.ok).toBe(true); expect(report.audio).toEqual({ present: true, bpm: null, beat: 'unclear' });
      expect(fs.readFileSync(calls, 'utf8')).toBe('1');
      const stills = body(await t.execute({ op: 'reference.inspect', input_path: file, sample_times: [0] }, ctx()));
      expect(stills.ok).toBe(true); expect(fs.readFileSync(calls, 'utf8')).toBe('1');
    } finally {
      if (previous === undefined) delete process.env.ORKAS_BUNDLED_FFMPEG; else process.env.ORKAS_BUNDLED_FFMPEG = previous;
    }
  });
});

describe('reference rhythm helpers', () => {
  it('takes one still per shot, thins to the cap and tops up sparse cut lists', async () => {
    const { referenceSampleTimes } = await import('../../../../src/main/features/video_studio');
    expect(referenceSampleTimes(10, [2, 2.3, 6])).toEqual([0, 2, 2.15, 2.7, 4, 6, 6.4, 8, 9.8]);
    const many = referenceSampleTimes(50, Array.from({ length: 40 }, (_v, i) => 1 + i));
    expect(many).toHaveLength(24);
    expect(many[0]).toBe(0);
    expect(Math.max(...many)).toBeLessThanOrEqual(49);
  });

  it('marks long shots that change inside themselves, strongest first', async () => {
    const { referenceMovingShots } = await import('../../../../src/main/features/video_studio');
    const scores = [
      ...Array.from({ length: 90 }, (_v, i) => ({ t: i / 30, score: 0.001 })),        // 0-3 s: steady build (0.09)
      ...Array.from({ length: 30 }, (_v, i) => ({ t: 3 + i / 30, score: 0 })),        // 3-4 s: still
      ...Array.from({ length: 60 }, (_v, i) => ({ t: 4 + i / 30, score: i === 30 ? 0.5 : 0.004 })), // 4-6 s: wipe
    ];
    expect(referenceMovingShots(8, [3, 4], scores).map(m => [m.start_sec, m.end_sec])).toEqual([[4, 8], [0, 3]]);
    // A shot under 1.5 s is a cut beat, not an animation to study.
    expect(referenceMovingShots(4, [3], scores)).toEqual([expect.objectContaining({ start_sec: 0, end_sec: 3 })]);
  });

  it('measures a steady beat, a slow one, and withholds a tempo for noise', async () => {
    const { referenceTempo } = await import('../../../../src/main/features/video_studio');
    const rate = 22050;
    /** A kick on every beat. */
    const kicks = (bpm: number, seconds: number) => {
      const out = new Float32Array(rate * seconds);
      for (let i = 0; i < out.length; i += 1) {
        const inBeat = (i / rate) % (60 / bpm);
        out[i] = 0.8 * Math.sin(2 * Math.PI * 60 * inBeat) * Math.exp(-inBeat * 18);
      }
      return out;
    };
    const steady = await referenceTempo(kicks(120, 20), rate);
    expect(steady?.beat).toBe('clear');
    expect(Math.abs(steady!.bpm! - 120)).toBeLessThan(1);
    // The estimator this replaced found no tempo at 64 BPM.
    expect((await referenceTempo(kicks(64, 24), rate))?.bpm).toBeCloseTo(64, 0);
    // 32-bit arithmetic: the float version of this generator loops every 0.47 s,
    // which is a beat.
    let seed = 7;
    const noise = new Float32Array(rate * 20).map(() => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 2147483648 - 1; });
    expect(await referenceTempo(noise, rate)).toEqual({ bpm: null, beat: 'unclear' });
    const cancelled = new AbortController();
    cancelled.abort();
    expect(await referenceTempo(kicks(120, 120), rate, cancelled.signal)).toBeNull();
  });
});
