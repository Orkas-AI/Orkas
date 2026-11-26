import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Delivery needs no window; the real ffmpeg builds, measures and draws the files.
vi.mock('electron', () => ({}));

const UID = 'reference-compare-tool';
let root: string;
let previousRoot: string | undefined;
let workspace: string;

beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-reference-compare-'));
  previousRoot = process.env.ORKAS_WORKSPACE_ROOT;
  process.env.ORKAS_WORKSPACE_ROOT = root;
  vi.resetModules();
  (await import('../../../../src/main/features/users')).activateUser(UID);
  workspace = path.join(root, 'workspace');
  fs.mkdirSync(workspace, { recursive: true });
  (await import('../../../../src/main/features/user_workspace')).setWorkspacePath(UID, workspace);
});

afterEach(() => {
  if (previousRoot === undefined) delete process.env.ORKAS_WORKSPACE_ROOT;
  else process.env.ORKAS_WORKSPACE_ROOT = previousRoot;
  fs.rmSync(root, { recursive: true, force: true });
});

/** The shared tool stands in for reference.inspect: it reports the source it froze. */
async function makeTool(inspected?: string) {
  const { createVideoTimelineTool } = await import('../../../../src/main/model/core-agent/video-timeline-tool');
  const shared = vi.fn(async () => ({ content: JSON.stringify(inspected ? { ok: true, source_path: inspected } : { ok: false }) }));
  return createVideoTimelineTool({ userId: UID, cid: 'current-chat', turnId: 'turn-1' } as any, { name: 'video_studio', execute: shared } as any);
}
const ctx = () => ({ workingDir: workspace, state: {} } as any);
const body = (result: any) => JSON.parse(result.content);

async function makeVideo(relative: string, inputs: string[], filter?: string): Promise<string> {
  const { bundledFfmpegPaths } = await import('../../../../src/main/util/bundled-runtime');
  const file = path.join(workspace, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const args = ['-y', '-hide_banner', '-loglevel', 'error'];
  for (const input of inputs) args.push('-f', 'lavfi', '-i', input);
  if (filter) args.push('-filter_complex', filter, '-map', '[v]');
  args.push('-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', file);
  const run = spawnSync(bundledFfmpegPaths().ffmpeg as string, args, { encoding: 'utf8' });
  if (run.status !== 0) throw new Error(run.stderr);
  return file;
}
const MOVING = ['testsrc2=s=360x640:r=30:d=4'];
const STILL = ['color=c=0x335577:s=360x640:r=30:d=4'];
const HALF_STILL = { inputs: ['testsrc2=s=360x640:r=30:d=2', 'color=c=0x335577:s=360x640:r=30:d=2'], filter: '[0:v][1:v]concat=n=2:v=1:a=0[v]' };

const SHEET_REPAIR = 'The reference comparison image shows the reference (left) and this video (right) at the same point of each, one row per quarter. Where this video leaves out a part, an end card or on-screen text that the reference has and reference-notes.md does not drop, fix it in this rework; what the notes drop or change is not a defect.';
const SHEET_REPORT = 'The reference comparison image shows the reference (left) and this video (right) at the same point of each, one row per quarter. Where this video still leaves out something the reference has and reference-notes.md does not drop, say so in your reply.';
const MOTION = 'this video moves much less in';

async function followReference(): Promise<string> {
  const reference = await makeVideo('ad/videos/main/assets/references/inspect-a1/source.mp4', MOVING);
  fs.writeFileSync(path.join(workspace, 'ad', 'reference-notes.md'), '- Fast moving pattern: recreate.\n');
  return reference;
}
const ship = (tool: Awaited<ReturnType<typeof makeTool>>, file: string) =>
  tool.execute({ op: 'video.ship', production_dir: 'ad', path: file }, ctx());

describe('video.ship beside its reference', () => {
  it('asks once to repair a still video made from a moving reference, with the two side by side', async () => {
    await followReference();
    await makeVideo('ad/render/final.mp4', STILL);
    const result: any = await ship(await makeTool(), 'ad/render/final.mp4');
    const shown = body(result);
    expect(shown.ok).toBe(true);
    expect(shown.message).toContain(`Repair before you reply: Beside the reference at the same point of each, ${MOTION} row 1`);
    expect(shown.message).toContain(SHEET_REPAIR);
    expect(shown.reference_comparison.rows).toHaveLength(4);
    expect(shown.reference_comparison.motion_score).toBe(0);
    expect(shown.reference_evidence).toEqual({ attached: true, role: 'reference_comparison' });
    // The delivered frames, then the comparison.
    expect(result.images).toHaveLength(2);
    // Recorded on the version, as every other finding is.
    const versions = JSON.parse(fs.readFileSync(path.join(workspace, 'ad', 'versions.json'), 'utf8')).versions;
    expect(versions[0].warnings).toContain('DELIVERY_MOTION_BELOW_REFERENCE');
  });

  it('stops asking when a repair leaves the movement where it was, before the rework runs out', async () => {
    await followReference();
    await makeVideo('ad/render/final.mp4', STILL);
    const tool = await makeTool();
    expect(body(await ship(tool, 'ad/render/final.mp4')).message).toContain('Repair before you reply');
    // The same still file again: nothing moved closer.
    const again = body(await ship(tool, 'ad/render/final.mp4')).message;
    expect(again).not.toContain('Repair before you reply');
    expect(again).toContain('The movement below the reference did not improve enough since the last delivery (0% to 0% of the reference\'s movement), so do not rework it again: name it in your reply as a known difference from the reference.');
    // The comparison is still shown for the reply.
    expect(again).toContain(SHEET_REPAIR);
  });

  it('asks again while each repair moves closer, and stops at the rework limit', async () => {
    await followReference();
    await makeVideo('ad/render/final.mp4', STILL);
    await makeVideo('ad/render/final-v2.mp4', HALF_STILL.inputs, HALF_STILL.filter);
    const tool = await makeTool();
    expect(body(await ship(tool, 'ad/render/final.mp4')).message).toContain('Repair before you reply');
    // Half of it moves now: closer, still short in its second half.
    const closer = body(await ship(tool, 'ad/render/final-v2.mp4')).message;
    expect(closer).toContain(`Repair before you reply: Beside the reference at the same point of each, ${MOTION} row 3`);
    expect(closer).not.toContain('did not improve');
    // Third delivery: the limit, so it is named, not reworked, and the comparison asks for a report.
    const last = body(await ship(tool, 'ad/render/final-v2.mp4')).message;
    expect(last).toContain('These remain and the rework limit is reached:');
    expect(last).toContain(MOTION);
    expect(last).toContain(SHEET_REPORT);
    expect(last).not.toContain('did not improve');
  });

  it('shows the comparison without a repair when the video moves like the reference', async () => {
    await followReference();
    await makeVideo('ad/render/final.mp4', MOVING);
    const shown = body(await ship(await makeTool(), 'ad/render/final.mp4'));
    expect(shown.message).not.toContain('Repair before you reply');
    expect(shown.message).toContain(SHEET_REPAIR);
    expect(shown.reference_comparison.motion_score).toBe(1);
  });

  it('follows the reference this run inspected, wherever it was frozen', async () => {
    const inspected = await makeVideo('references/assets/references/inspect-z9/source.mp4', MOVING);
    fs.mkdirSync(path.join(workspace, 'ad'), { recursive: true });
    fs.writeFileSync(path.join(workspace, 'ad', 'reference-notes.md'), '- Pattern: recreate.\n');
    await makeVideo('ad/render/final.mp4', STILL);
    const tool = await makeTool(inspected);
    await tool.execute({ op: 'reference.inspect', input_path: 'clip.mp4' }, ctx());
    expect(body(await ship(tool, 'ad/render/final.mp4')).message).toContain(MOTION);
  });

  it('leaves a video with no reference notes, or two references to choose between, as before', async () => {
    await makeVideo('ad/videos/main/assets/references/inspect-a1/source.mp4', MOVING);
    await makeVideo('ad/render/final.mp4', STILL);
    const plain: any = await ship(await makeTool(), 'ad/render/final.mp4');
    expect(body(plain).reference_comparison).toBeUndefined();
    expect(plain.images).toHaveLength(1);
    fs.writeFileSync(path.join(workspace, 'ad', 'reference-notes.md'), '- Pattern: recreate.\n');
    await makeVideo('ad/videos/english/assets/references/inspect-b2/source.mp4', ['testsrc2=s=360x640:r=30:d=3']);
    const unsure = body(await ship(await makeTool(), 'ad/render/final.mp4'));
    expect(unsure.reference_comparison).toBeUndefined();
    expect(unsure.message).not.toContain(MOTION);
  });
});
