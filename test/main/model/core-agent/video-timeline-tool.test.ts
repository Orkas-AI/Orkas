import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { VideoStudioToolOpts } from '../../../../src/main/model/core-agent/video-studio-tool';

// Delivery needs no window; the real ffmpeg builds and reads the files.
vi.mock('electron', () => ({}));

const recognizer = vi.hoisted(() => ({ script: '' }));
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    spawn: (...args: Parameters<typeof actual.spawn>) => {
      const [command, commandArgs, options] = args;
      // Win32 cannot invoke a shebang script directly. Start this fake backend with Node.
      if (process.platform === 'win32' && command === recognizer.script && commandArgs) {
        return actual.spawn(process.env.ORKAS_TEST_NODE || process.execPath, [command, ...commandArgs], options);
      }
      return actual.spawn(...args);
    },
  };
});

const quote = vi.hoisted(() => ({
  next: null as Record<string, unknown> | null,
  args: [] as unknown[],
  payload: [] as Record<string, unknown>[],
  videoServices: null as unknown[] | null,
  fails: null as string | Error | null,
}));
vi.mock('../../../../src/main/features/video_production_services', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../../src/main/features/video_production_services')>();
  return {
    ...actual,
    // The real quote checks the plan against the configured service before asking the server.
    checkVideoProductionServices: vi.fn(async (...args: unknown[]) => {
      quote.args = args;
      if (quote.videoServices) quote.payload = actual.videoProductionQuotePayloadSegments(args[0] as never, [], quote.videoServices as never);
      if (quote.fails) throw typeof quote.fails === 'string' ? new Error(quote.fails) : quote.fails;
      return quote.next;
    }),
  };
});

// Rendering needs a window; a case that sets `fake` stands in for it and writes the file it was asked for.
const renderer = vi.hoisted(() => ({
  fake: null as null | ((input: { outputAbsPath: string }) => Promise<Record<string, unknown>>),
  check: null as null | ((input: Record<string, any>) => Promise<Record<string, unknown>>),
}));
vi.mock('../../../../src/main/features/video_timeline_render', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../../src/main/features/video_timeline_render')>();
  return {
    ...actual,
    renderVideoTimeline: vi.fn((input: Parameters<typeof actual.renderVideoTimeline>[0]) => (
      renderer.fake ? renderer.fake(input) : actual.renderVideoTimeline(input)
    )),
    checkVideoTimeline: vi.fn((input: Parameters<typeof actual.checkVideoTimeline>[0]) => (
      renderer.check ? renderer.check(input) : actual.checkVideoTimeline(input)
    )),
  };
});

const UID = 'timeline-tool';
let root: string;
let previousRoot: string | undefined;
let workspace: string;

beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-timeline-tool-'));
  previousRoot = process.env.ORKAS_WORKSPACE_ROOT;
  process.env.ORKAS_WORKSPACE_ROOT = root;
  vi.resetModules();
  quote.videoServices = null;
  quote.payload = [];
  quote.fails = null;
  renderer.fake = null;
  renderer.check = null;
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

async function makeTool(legacyExecute = vi.fn(), turnId = 'turn-1', callbacks: Pick<VideoStudioToolOpts, 'onFileWritten' | 'onOutputsPublished'> = {}) {
  const { createVideoTimelineTool } = await import('../../../../src/main/model/core-agent/video-timeline-tool');
  return createVideoTimelineTool({ userId: UID, cid: 'current-chat', turnId, ...callbacks } as any, { name: 'video_studio', execute: legacyExecute } as any);
}

const ctx = () => ({ workingDir: workspace, state: {} } as any);
const body = (result: any) => JSON.parse(result.content);

async function makeVideo(relative: string, seconds = 2, audio?: string): Promise<void> {
  const { bundledFfmpegPaths } = await import('../../../../src/main/util/bundled-runtime');
  const file = path.join(workspace, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const run = spawnSync(bundledFfmpegPaths().ffmpeg as string, [
    '-y', '-hide_banner', '-loglevel', 'error',
    '-f', 'lavfi', '-i', `testsrc2=s=360x640:r=30:d=${seconds}`,
    '-f', 'lavfi', '-i', audio ?? `sine=frequency=440:sample_rate=48000:duration=${seconds}`,
    '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', file,
  ], { encoding: 'utf8' });
  if (run.status !== 0) throw new Error(run.stderr);
}

describe('speech.transcribe paths', () => {
  // 2026-11-12: `transcript.json` with production_dir set was saved at the workspace
  // root while its input was read from the production; the next call missed it.
  it('saves a transcript named relative to the production in the production', async () => {
    fs.mkdirSync(path.join(workspace, 'ad', 'media'), { recursive: true });
    fs.writeFileSync(path.join(workspace, 'ad', 'media', 'clip.mp4'), 'media');
    const shared = vi.fn().mockResolvedValue({ content: '{"ok":true}' });
    const tool = await makeTool(shared);
    const call = async (input: Record<string, unknown>) => {
      shared.mockClear();
      await tool.execute({ op: 'speech.transcribe', ...input }, ctx());
      return shared.mock.calls[0][0] as Record<string, unknown>;
    };
    const named = await call({ production_dir: 'ad', input_path: 'media/clip.mp4', transcript_path: 'transcript.json' });
    expect(named.input_path).toBe(path.join(workspace, 'ad', 'media', 'clip.mp4'));
    expect(named.transcript_path).toBe(path.join(workspace, 'ad', 'transcript.json'));
    // Already written from the workspace: not doubled.
    expect((await call({ production_dir: 'ad', input_path: 'media/clip.mp4', transcript_path: 'ad/notes/t.json' })).transcript_path)
      .toBe(path.join(workspace, 'ad', 'notes', 't.json'));
    // No production: left for the transcriber to resolve from the workspace.
    expect((await call({ input_path: 'ad/media/clip.mp4', transcript_path: 'transcript.json' })).transcript_path).toBe('transcript.json');
  });
});

// 2026-11-17 benchmark: one tutorial ended on the export spinner while its last line said the
// file was saved; another dropped the "立即备份" click its narration still named. Delivery
// showed twelve evenly spaced frames, none tied to what was being said over it.
describe('video.ship frames matched to what is heard', () => {
  const saved: Record<string, string | undefined> = {};
  let calls: string;
  beforeEach(() => {
    for (const key of ['ORKAS_WHISPER_CPP', 'ORKAS_WHISPER_MODEL']) saved[key] = process.env[key];
    calls = path.join(root, 'whisper-calls.txt');
    const cli = path.join(root, 'fake-whisper.cjs');
    fs.writeFileSync(cli, [
      '#!/usr/bin/env node',
      "const fs = require('node:fs'); const a = process.argv.slice(2);",
      `fs.appendFileSync(${JSON.stringify(calls)}, 'call\\n');`,
      "fs.writeFileSync(a[a.indexOf('-of') + 1] + '.json', JSON.stringify({ result: { language: 'en' }, transcription: [",
      "  { offsets: { from: 100, to: 900 }, text: ' Open the export page.' },",
      "  { offsets: { from: 1100, to: 1900 }, text: ' The file is saved.' } ] }));",
    ].join('\n'));
    fs.chmodSync(cli, 0o755);
    const model = path.join(root, 'ggml-fake.bin');
    fs.writeFileSync(model, 'model');
    recognizer.script = cli;
    process.env.ORKAS_WHISPER_CPP = cli;
    process.env.ORKAS_WHISPER_MODEL = model;
  });
  afterEach(() => {
    recognizer.script = '';
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  async function production(narrated: boolean) {
    fs.mkdirSync(path.join(workspace, 'ad'), { recursive: true });
    fs.writeFileSync(path.join(workspace, 'ad', 'assets.json'), JSON.stringify({ assets: [] }));
    // A pause between the two lines, as narration has.
    await makeVideo('ad/render/final.mp4', 2, "sine=frequency=300:sample_rate=48000:duration=2,volume=enable='between(t,0.9,1.1)':volume=0");
    if (!narrated) return;
    await makeVideo('ad/voice/line.mp4', 1);
    const { recordProductionVoice } = await import('../../../../src/main/features/video_timeline_ship');
    await recordProductionVoice({ workspaceAbs: workspace, fileAbs: path.join(workspace, 'ad', 'voice', 'line.mp4'), seconds: 1 });
  }

  it('lists the words heard at each frame of a narrated delivery and asks each line to be checked against its frame', async () => {
    await production(true);
    const result: any = await (await makeTool()).execute({ op: 'video.ship', production_dir: 'ad', path: 'ad/render/final.mp4' }, ctx());
    const reply = body(result);
    expect(reply.ok).toBe(true);
    expect(result.images).toHaveLength(1);
    expect(reply.version.voiced).toBe(true);
    expect(fs.readFileSync(calls, 'utf8')).toContain('call\n');
    expect(reply.delivered_frames).toEqual([
      { frame: 1, at_sec: 0.8, heard: 'Open the export page.' },
      { frame: 2, at_sec: 1.8, heard: 'The file is saved.' },
    ]);
    expect(reply.message).toContain('a step, a result or an event that its frame does not show');
    expect(reply.message).toContain('Rework is still available');
    expect(reply.message).toContain("video-studio Skill's Deliver section");
  }, 60_000);

  it('does not listen to a delivery made without narration, so a music cut keeps evenly spaced frames', async () => {
    await production(false);
    const result: any = await (await makeTool()).execute({ op: 'video.ship', production_dir: 'ad', path: 'ad/render/final.mp4' }, ctx());
    const reply = body(result);
    expect(reply.ok).toBe(true);
    expect(result.images).toHaveLength(1);
    expect(fs.existsSync(calls)).toBe(false);
    expect(reply.version.voiced).toBeUndefined();
    expect(reply.delivered_frames).toBeUndefined();
    expect(reply.message).toContain('These are frames from the published file. Rework is still available');
  }, 60_000);
});

describe('video.ship', () => {
  // Each delivery inspects the media with real FFmpeg. Several sequential
  // deliveries can exceed the default single-case deadline on Windows.
  const repeatedShipTimeoutMs = 90_000;

  it('does not equate successful delivery with a completed visual review', async () => {
    await makeVideo('ad/render/final.mp4');
    const tool = await makeTool();
    const result: any = await tool.execute({ op: 'video.ship', production_dir: 'ad', path: 'ad/render/final.mp4' }, ctx());
    expect(body(result)).toMatchObject({ ok: true, visual_review: { status: 'not_checked', advisory: true, findings: [] } });
    expect(result.isError).not.toBe(true);
    expect(result.synthesizeAndEndTurn).not.toBe(true);
  });

  // Review 2026-11-16 S4-4: each copy of a finding is reread on every later request.
  it('shows the review once in the reply and keeps it on the stored version', async () => {
    await makeVideo('ad/render/final.mp4');
    const reply = body(await (await makeTool()).execute({ op: 'video.ship', production_dir: 'ad', path: 'ad/render/final.mp4' }, ctx()));
    expect(reply.visual_review).toMatchObject({ status: 'not_checked' });
    expect(reply.version).not.toHaveProperty('visual_review');
    const stored = JSON.parse(fs.readFileSync(path.join(workspace, 'ad', 'versions.json'), 'utf8')).versions;
    expect(stored.at(-1).visual_review).toMatchObject({ status: 'not_checked' });
  });

  it('returns a repairable refusal for digital silence instead of publishing or asking the user to stop', async () => {
    await makeVideo('ad/render/final.mp4', 1, 'anullsrc=r=48000:cl=stereo:d=1');
    const tool = await makeTool();
    const result: any = await tool.execute({ op: 'video.ship', production_dir: 'ad', path: 'ad/render/final.mp4', expect_audio: true }, ctx());
    expect(body(result)).toMatchObject({ ok: false, outcome: 'continue', errorCode: 'E_VIDEO_SHIP_BLOCKED', issues: [{ code: 'DELIVERY_AUDIO_SILENT' }] });
    expect(result.images).toBeUndefined();
    expect(fs.existsSync(path.join(workspace, 'ad', 'versions.json'))).toBe(false);
    expect(fs.existsSync(path.join(workspace, 'ad', 'versions'))).toBe(false);
  });

  it('hands back frames of the delivered file and asks for a look before the reply', async () => {
    await makeVideo('ad/render/final.mp4');
    const tool = await makeTool();
    const result: any = await tool.execute({ op: 'video.ship', production_dir: 'ad', path: 'ad/render/final.mp4' }, ctx());
    const reply = body(result);
    expect(reply.ok).toBe(true);
    expect(result.images).toHaveLength(1);
    expect(reply.visual_evidence).toEqual({ attached: true, role: 'delivered_frames' });
    // The host reports available rework; the Skill owns the repair/blocked/
    // complete decision. Publication alone must not end the actor's turn.
    expect(reply.message).toContain('Rework is still available');
    expect(reply.message).toContain("video-studio Skill's Deliver section");
    expect(reply.message).not.toContain('one for each known gap');
    expect(reply.outcome).toBe('continue');
    expect(result.synthesizeAndEndTurn).not.toBe(true);
  });

  // 2026-11-20 benchmark: 6 of 34 runs copied the delivered file's long absolute link wrong, and
  // the user got a link that opened nothing.
  it('hands back a short link to the delivered file that the reply can carry as it is, and that the app turns into the file', async () => {
    await makeVideo('ad/render/final cut (2).mp4');
    const tool = await makeTool();
    const reply = body(await tool.execute({ op: 'video.ship', production_dir: 'ad', path: 'ad/render/final cut (2).mp4' }, ctx()));
    expect(reply.ok).toBe(true);
    expect(reply.reply_link).toBe(`[${path.basename(reply.version.path)}](ad/${reply.version.path.replace(/ /g, '%20').replace(/\(/g, '%28').replace(/\)/g, '%29')})`);
    expect(reply.message).toContain('Link the video in your reply with reply_link exactly as given; change only the words in brackets.');
    const { versionChatMediaLocalUrlsInText, chatMediaLocalPathFromUrl } = await import('../../../../src/main/util/chat-media-url');
    const shown = versionChatMediaLocalUrlsInText(`成片：${reply.reply_link}`, workspace);
    const url = /\]\((chat-media:\/\/local[^)]+)\)/.exec(shown)?.[1];
    expect(url, shown).toBeTruthy();
    expect(fs.realpathSync(chatMediaLocalPathFromUrl(url!)!)).toBe(fs.realpathSync(path.join(workspace, 'ad', reply.version.path)));
  });

  it('writes no short link for a file outside the folder links are read from', async () => {
    const { replyLinkFor } = await import('../../../../src/main/model/core-agent/video-timeline-tool');
    expect(replyLinkFor(path.join(workspace, 'ad', 'versions', 'main-v1.mp4'), workspace)).toBe('[main-v1.mp4](ad/versions/main-v1.mp4)');
    expect(replyLinkFor(path.join(workspace, 'ad', 'versions', '[x] 50%.mp4'), workspace)).toBe('[x 50%.mp4](ad/versions/[x]%2050%25.mp4)');
    expect(replyLinkFor(path.join(os.tmpdir(), 'elsewhere.mp4'), workspace)).toBeNull();
  });

  it.each([
    { directory: '#draft', filename: 'final.mp4' },
    { directory: 'draft`1`', filename: 'final `take`.mp4' },
  ])('opens the delivered video $filename from $directory', async ({ directory, filename }) => {
    const rendered = `${directory}/render/${filename}`;
    await makeVideo(rendered);
    const reply = body(await (await makeTool()).execute({
      op: 'video.ship', production_dir: directory, path: rendered,
    }, ctx()));
    expect(reply.ok).toBe(true);
    const { versionChatMediaLocalUrlsInText, chatMediaLocalPathFromUrl } = await import('../../../../src/main/util/chat-media-url');
    const shown = versionChatMediaLocalUrlsInText(reply.reply_link, workspace);
    const url = /\]\((chat-media:\/\/local[^)]+)\)/.exec(shown)?.[1];
    expect(url, shown).toBeTruthy();
    expect(fs.realpathSync(chatMediaLocalPathFromUrl(url!))).toBe(fs.realpathSync(path.join(workspace, directory, reply.version.path)));
  });

  it('reports the existing third-delivery rework limit without adding a publication gate', async () => {
    await makeVideo('ad/render/final.mp4');
    const tool = await makeTool();
    const ship = () => tool.execute({ op: 'video.ship', production_dir: 'ad', path: 'ad/render/final.mp4' }, ctx());
    expect(body(await ship()).message).toContain('Rework is still available');
    expect(body(await ship()).message).toContain('Rework is still available');
    for (const attempt of [3, 4]) {
      const result = await ship();
      const delivered = body(result);
      expect(delivered, `delivery attempt ${attempt}`).toMatchObject({ ok: true, outcome: 'continue', version: { id: 'v1' } });
      expect(delivered.message).toContain('rework limit has been reached');
      expect(delivered.message).toContain('do not rework again');
      expect(delivered.message).toContain('honest final status');
      expect(delivered.message).not.toContain('one for each gap');
      expect(result.synthesizeAndEndTurn).not.toBe(true);
    }
    // Repeated publication of unchanged bytes remains idempotent.
    expect(JSON.parse(fs.readFileSync(path.join(workspace, 'ad', 'versions.json'), 'utf8')).versions).toHaveLength(1);
  }, repeatedShipTimeoutMs);

  it('counts repairs per clip, so a batch of clips does not exhaust one limit', async () => {
    // Five clips cut from one recording are five videos: shipping the third must not tell
    // the Agent that rework is over for the fourth and fifth.
    for (const name of ['clip-01', 'clip-02', 'clip-03', 'clip-04']) await makeVideo(`ad/render/${name}.mp4`);
    const tool = await makeTool();
    for (const name of ['clip-01', 'clip-02', 'clip-03', 'clip-04']) {
      const delivered = body(await tool.execute({ op: 'video.ship', production_dir: 'ad', path: `ad/render/${name}.mp4` }, ctx()));
      expect(delivered, name).toMatchObject({ ok: true });
      expect(delivered.message, name).toContain('Rework is still available');
    }
    // The same clip shipped a third time still reaches its own limit.
    const again = () => tool.execute({ op: 'video.ship', production_dir: 'ad', path: 'ad/render/clip-02.mp4' }, ctx());
    expect(body(await again()).message).toContain('Rework is still available');
    expect(body(await again()).message).toContain('rework limit has been reached');
  }, repeatedShipTimeoutMs);

  it('asks for a repair of a silent stretch while rework remains, then for it to be named', async () => {
    // Narration that ends early leaves the rest of the video silent (2026-11-12).
    const silentTail = 'sine=frequency=300:sample_rate=48000:duration=2,apad=whole_dur=6';
    await makeVideo('ad/render/final.mp4', 6, silentTail);
    const tool = await makeTool();
    const ship = async () => body(await tool.execute({ op: 'video.ship', production_dir: 'ad', path: 'ad/render/final.mp4', expect_audio: true }, ctx()));
    const first = await ship();
    expect(first.warnings.map((w: any) => w.code)).toContain('DELIVERY_SILENT_STRETCH');
    expect(first.message).toMatch(/^Repair before you reply: This video should have sound but is silent at 2\.\d–6\.0s/);
    expect(first.message).toContain('Then deliver this video again.');
    expect((await ship()).message).toContain('Repair before you reply');
    const third = await ship();
    expect(third.message).toContain('the rework limit is reached');
    expect(third.message).toContain('Name them in your reply as known problems.');
    expect(third.message).not.toContain('Repair before you reply');
  });

  it('asks for cuts moved onto the beat when a video said to be cut to its music misses it', async () => {
    // 2026-11-13 montages: cuts made by adding up a rounded two-beat length drifted 45–75 ms
    // off the beat, and the one run that measured its file shipped it anyway.
    const { driftingCuts, makeBeatMontage } = await import('../../../fixtures/beat-montage');
    fs.mkdirSync(path.join(workspace, 'ad', 'render'), { recursive: true });
    makeBeatMontage(path.join(workspace, 'ad', 'render', 'montage.mp4'), 16, driftingCuts(16));
    const tool = await makeTool();
    const schema = (tool.inputSchema as { properties: Record<string, { type?: string; description?: string }> }).properties.cut_to_beat;
    expect(schema).toEqual({ type: 'boolean', description: "true when the video is cut to its music's beat (卡点). Delivery then checks every cut of the delivered file against the soundtrack's beats." });
    const unchecked = body(await tool.execute({ op: 'video.ship', production_dir: 'ad', path: 'ad/render/montage.mp4' }, ctx()));
    expect(unchecked.message).not.toContain('Repair before you reply');
    const checked = body(await tool.execute({ op: 'video.ship', production_dir: 'ad', path: 'ad/render/montage.mp4', cut_to_beat: true }, ctx()));
    expect(checked.warnings.map((w: any) => w.code)).toContain('DELIVERY_CUTS_OFF_BEAT');
    expect(checked.message).toMatch(/^Repair before you reply: \d+ of 16 cuts are more than a frame off the beat: \d+\.\d\ds \(beat \d+\.\d\ds\)/);
    expect(checked.message).toContain("Take each cut's frame from the beat list rather than adding up a beat length, then render and deliver again. Then deliver this video again.");
  }, 60_000);

  it('asks for a repair when a video said to be cut to its music shows one picture throughout', async () => {
    // 2026-11-14 baseline: a photo montage built by hand stretched its first photo past the
    // whole 15 s, so the delivered file had no cut, and it shipped with nothing said.
    const { makeBeatMontage } = await import('../../../fixtures/beat-montage');
    fs.mkdirSync(path.join(workspace, 'ad', 'render'), { recursive: true });
    makeBeatMontage(path.join(workspace, 'ad', 'render', 'still.mp4'), 16, []);
    const tool = await makeTool();
    const checked = body(await tool.execute({ op: 'video.ship', production_dir: 'ad', path: 'ad/render/still.mp4', cut_to_beat: true }, ctx()));
    expect(checked.warnings.map((w: any) => w.code)).toContain('DELIVERY_NO_CUTS');
    expect(checked.message.startsWith('Repair before you reply: The delivered file has no cut: one picture runs the whole 16.00s. Check how long each shot was made to last, then render and deliver again. Then deliver this video again.')).toBe(true);
  }, 60_000);

  it('counts a repair saved under a new name against the same video', async () => {
    const silentTail = 'sine=frequency=300:sample_rate=48000:duration=2,apad=whole_dur=6';
    for (const name of ['final', 'final-fixed', 'final-v2']) await makeVideo(`ad/render/${name}.mp4`, 6, silentTail);
    const tool = await makeTool();
    const messages: string[] = [];
    for (const name of ['final', 'final-fixed', 'final-v2']) {
      messages.push(body(await tool.execute({ op: 'video.ship', production_dir: 'ad', path: `ad/render/${name}.mp4`, expect_audio: true }, ctx())).message);
    }
    expect(messages[0]).toContain('Repair before you reply');
    expect(messages[1]).toContain('Repair before you reply');
    expect(messages[2]).toContain('the rework limit is reached');
  }, repeatedShipTimeoutMs);

  it('keeps numbered clips apart when stripping a repair suffix', async () => {
    const { deliveryStem } = await import('../../../../src/main/model/core-agent/video-timeline-tool');
    expect(deliveryStem('final-fixed-v2')).toBe('final');
    expect(deliveryStem('clip-01-final')).toBe('clip-01');
    expect(deliveryStem('clip-02')).toBe('clip-02');
    expect(deliveryStem('final')).toBe('final');
  });

  it('keeps the count per run, so a later turn can fix what a user asked for', async () => {
    await makeVideo('ad/render/final.mp4');
    const earlier = await makeTool();
    for (let index = 0; index < 3; index += 1) {
      await earlier.execute({ op: 'video.ship', production_dir: 'ad', path: 'ad/render/final.mp4' }, ctx());
    }
    const later = await makeTool();
    expect(body(await later.execute({ op: 'video.ship', production_dir: 'ad', path: 'ad/render/final.mp4' }, ctx())).message).toContain('Rework is still available');
  }, repeatedShipTimeoutMs);

  it('asks the first delivery of a video made from a reference to say what it left out, and only then', async () => {
    const drops = 'This video follows a reference. In your reply, name what reference-notes.md drops and why, and for a presenter or character the user has no footage of, offer to add one from footage they film or as an original generated one, priced when they ask.';
    await makeVideo('ad/render/final.mp4');
    const first = await makeTool();
    const ship = (tool: Awaited<ReturnType<typeof makeTool>>) => tool.execute({ op: 'video.ship', production_dir: 'ad', path: 'ad/render/final.mp4' }, ctx());
    // No notes: nothing about a reference.
    expect(body(await ship(first)).message).not.toContain('follows a reference');
    fs.rmSync(path.join(workspace, 'ad', 'versions.json'));
    fs.writeFileSync(path.join(workspace, 'ad', 'reference-notes.md'), '- Presenter talking to camera: drop.\n');
    const reference = await makeTool();
    expect(body(await ship(reference)).message).toContain(drops);
    // A repair in the same run is still the first delivery.
    expect(body(await ship(reference)).message).toContain(drops);
    // A later run changes a video already delivered.
    expect(body(await ship(await makeTool())).message).not.toContain('follows a reference');
  }, repeatedShipTimeoutMs);

  it('attaches nothing when the delivery fails', async () => {
    fs.mkdirSync(path.join(workspace, 'ad'));
    fs.writeFileSync(path.join(workspace, 'ad', 'broken.mp4'), 'not a video');
    const tool = await makeTool();
    const result: any = await tool.execute({ op: 'video.ship', production_dir: 'ad', path: 'ad/broken.mp4' }, ctx());
    expect(body(result).ok).toBe(false);
    expect(result.images).toBeUndefined();
  });

  it('still delivers when the frames cannot be made', async () => {
    await makeVideo('ad/render/final.mp4');
    const tool = await makeTool();
    const saved = { TMPDIR: process.env.TMPDIR, TEMP: process.env.TEMP, TMP: process.env.TMP };
    const missing = path.join(root, 'missing');
    Object.assign(process.env, { TMPDIR: missing, TEMP: missing, TMP: missing });
    try {
      const result: any = await tool.execute({ op: 'video.ship', production_dir: 'ad', path: 'ad/render/final.mp4' }, ctx());
      const reply = body(result);
      expect(reply.ok).toBe(true);
      expect(reply.version.id).toBe('v1');
      expect(result.images).toBeUndefined();
      expect(reply.visual_evidence).toEqual({ attached: false, role: 'delivered_frames' });
      // No frames to look at, so no request to look; only the link to carry in the reply.
      expect(reply.message).toBe('Link the video in your reply with reply_link exactly as given; change only the words in brackets.');
    } finally {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });
});


describe('configured-service preflight without hosted billing',()=>{
 const request=async(planned:unknown=[{kind:'video',count:1,duration:8}])=>(await makeTool()).execute({op:'video.request_budget',production_dir:'ad',planned},ctx());
 const quoted=(sufficient=true)=>({sufficient,externally_billed_segment_ids:sufficient?['planned-1-1']:[],unavailable_segment_ids:sufficient?[]:['planned-1-1'],external_billing_estimate_available:false,segments:[]});
  it('rejects absent or invalid planned input before quoting or producing a price card', async () => {
    const tool = await makeTool(vi.fn(), 'turn-invalid-budget');
    const quoteBefore = quote.args;
    for (const planned of [undefined, [{ kind: 'music', count: 1 }]]) {
      const result = await tool.execute({ op: 'video.request_budget', production_dir: 'ad',
        ...(planned === undefined ? { recommended_shots: 1 } : { planned }) }, ctx());
      expect(body(result)).toMatchObject({ ok: false, errorCode: 'E_BUDGET_PLAN' });
      expect(body(result).budget_request).toBeUndefined();
      expect(result.synthesizeAndEndTurn).not.toBe(true);
    }
    // A plan that costs nothing is answered, not refused, and still shows no card.
    for (const planned of [[], [{ kind: 'video', count: 0 }]]) {
      const result = await tool.execute({ op: 'video.request_budget', production_dir: 'ad', planned }, ctx());
      expect(body(result)).toMatchObject({ ok: true, quoted_credits: 0 });
      expect(body(result).budget_request).toBeUndefined();
      expect(result.synthesizeAndEndTurn).not.toBe(true);
    }
    expect(quote.args).toBe(quoteBefore);
  });

  it('tells a model with nothing to generate that it needs no price, and prices nothing', async () => {
    quote.args = [];
    const emptyResult = await request([]);
    const empty = body(emptyResult);
    expect(empty).toMatchObject({ ok: true, op: 'video.request_budget', quoted_credits: 0, outcome: 'continue' });
    expect(empty).not.toHaveProperty('errorCode');
    expect(empty).not.toHaveProperty('budget_request');
    expect(empty).not.toHaveProperty('covered');
    expect(emptyResult.isError).toBeUndefined();
    expect(emptyResult.synthesizeAndEndTurn).toBeUndefined();
    expect(empty.message).toBe('There is nothing in the plan to generate, so there is no price to confirm. Carry on with what you have.');
    expect(body(await request('two shots')).message).toBe('planned must list what you intend to generate.');
    expect(quote.args).toEqual([]);
  });

  it('prices no entry of none, and says there is nothing to price when every entry is none', async () => {
    quote.args = [];
    const none = await request([{ kind: 'image', count: 0 }, { kind: 'video', count: -1 }]);
    expect(body(none)).toMatchObject({ ok: true, quoted_credits: 0, outcome: 'continue' });
    expect(body(none).message).toBe('There is nothing in the plan to generate, so there is no price to confirm. Carry on with what you have.');
    expect(none.synthesizeAndEndTurn).toBeUndefined();
    expect(quote.args).toEqual([]);

    quote.next = quoted();
    const mixed = await request([{ kind: 'video', count: 2, duration: 8 }, { kind: 'image', count: 0 }]);
    expect(body(mixed)).toMatchObject({ ok: true, covered: true, billed_to_own_key: true });
    expect((quote.args[0] as Array<{ kind: string }>).map((intent) => intent.kind)).toEqual(['video', 'video']);
  });

  it.each([
    { fields: { code: 'E_SERVICE_CONFIG_REQUIRED' }, expected: { source_code: 'E_SERVICE_CONFIG_REQUIRED' } },
    { fields: { code: 'E_VIDEO_PRODUCTION_QUOTE_FAILED', httpStatus: 503, serverCode: 5001 },
      expected: { source_code: 'E_VIDEO_PRODUCTION_QUOTE_FAILED', http_status: 503, server_code: 5001 } },
  ])('retains explicit quote facts and leaves the turn usable: $expected', async ({ fields, expected }) => {
    quote.fails = Object.assign(new Error('Controlled quote failure token=private-fixture-value'), fields);
    const result = await request();
    expect(body(result)).toMatchObject({ ok: false, errorCode: 'E_BUDGET_QUOTE_FAILED', outcome: 'continue',
      quote_error: expected });
    expect(body(result).quote_error.message).not.toContain('private-fixture-value');
    expect(body(result).message).toBe('The configured generation service could not be checked, so this generation request was not sent.');
    expect(result.isError).toBe(true);
    expect(result.synthesizeAndEndTurn).toBeUndefined();
    expect(body(result).budget_request).toBeUndefined();
    await expect((await import('../../../../src/main/features/video_production_budget')).productionRequestStatus({ userId: UID, scope: 'current-chat' }))
      .resolves.toMatchObject({ pending: 0, completed: 0 });
  });


 it('checks every planned shot and reports direct service billing without a fake credit price',async()=>{
  quote.next=quoted();const result=await request([{kind:'video',count:3,duration:8},{kind:'image',count:2}]);
  expect(quote.args[0]).toHaveLength(5);expect(body(result)).toMatchObject({ok:true,covered:true,billed_to_own_key:true,external_billing_estimate_available:false});
  expect(body(result).quoted_credits).toBeUndefined();expect(body(result).budget_request).toBeUndefined();expect(result.synthesizeAndEndTurn).toBeUndefined();
 });
 it('reports unavailable service without inventing a short account balance',async()=>{
  quote.next=quoted(false);const result=await request();expect(body(result)).toMatchObject({ok:false,errorCode:'E_UNAVAILABLE'});
  expect(body(result).available_credits).toBeUndefined();expect(body(result).budget_request).toBeUndefined();
 });
 it.each(['two shots', [{kind:'music'}]])('refuses an invalid plan without checking a service (%j)',async(planned)=>{
  quote.args=[];const result=await request(planned);expect(body(result)).toMatchObject({ok:false,errorCode:'E_BUDGET_PLAN'});expect(quote.args).toEqual([]);
 });
 it('excludes count zero and bounds the expanded batch',async()=>{
  quote.next=quoted();await request([{kind:'video',count:40,duration:5},{kind:'image',count:0}]);expect(quote.args[0]).toHaveLength(20);expect((quote.args[0]as any[]).every(row=>row.kind==='video')).toBe(true);
 });
 it('leaves a failed check usable without exposing credentials or declaring a price',async()=>{
  quote.fails=Object.assign(new Error('Controlled service failure token=private-fixture-value'),{code:'E_SERVICE_CHECK_FAILED'});
  const result=await request();expect(body(result)).toMatchObject({ok:false,errorCode:'E_BUDGET_QUOTE_FAILED',outcome:'continue',quote_error:{source_code:'E_SERVICE_CHECK_FAILED'}});
  expect(body(result).quote_error.message).not.toContain('private-fixture-value');expect(result.isError).toBe(true);expect(result.synthesizeAndEndTurn).toBeUndefined();
 });
});

describe('video.ship paths', () => {
  it.each([false, true])('delivers a shorter cut with an advisory (timeline: %s)', async (useTimeline) => {
    await makeVideo('ad/render/final.mp4', 15);
    if (useTimeline) {
      const video = path.join(workspace, 'ad', 'videos', 'main');
      fs.mkdirSync(video, { recursive: true });
      fs.writeFileSync(path.join(video, 'manifest.json'), JSON.stringify({
        schema_version: 3, id: 'main', label: 'Clip', canvas: { width: 360, height: 640, fps: 30 },
        scenes: [{ id: 'opening', duration: 15 }],
      }));
      fs.writeFileSync(path.join(workspace, 'ad', 'assets.json'), JSON.stringify({ assets: [] }));
    }
    const tool = await makeTool();
    const result = await tool.execute({
      op: 'video.ship', production_dir: 'ad', path: 'render/final.mp4', expect_duration_sec: 30,
      ...(useTimeline ? { video_id: 'main' } : {}),
    }, ctx());
    const delivered = body(result);
    expect(result.isError).toBeUndefined();
    expect(result.synthesizeAndEndTurn).toBeUndefined();
    expect(delivered).toMatchObject({
      ok: true, outcome: 'continue',
      warnings: expect.arrayContaining([expect.objectContaining({
        code: 'DELIVERY_REQUESTED_DURATION_DRIFT', severity: 'warning',
        message: expect.stringMatching(/15\.00s.*30(?:\.00)?s/),
      })]),
      version: { warnings: expect.arrayContaining(['DELIVERY_REQUESTED_DURATION_DRIFT']) },
    });
    expect(delivered.message ?? '').not.toContain('Repair before you reply');
    expect(fs.existsSync(path.join(workspace, 'ad', delivered.version.path))).toBe(true);
  }, 60_000);

  it('returns a timed original-sound advisory without requesting an automatic repair', async () => {
    await makeVideo('ad/media/episode.mp4', 3, 'anoisesrc=d=3:c=pink:r=16000:a=0.3:seed=42');
    await makeVideo('ad/render/final.mp4', 3);
    const production = path.join(workspace, 'ad');
    const video = path.join(production, 'videos', 'main');
    fs.mkdirSync(video, { recursive: true });
    fs.writeFileSync(path.join(video, 'manifest.json'), JSON.stringify({
      schema_version: 3, id: 'main', label: 'Recap', canvas: { width: 360, height: 640, fps: 30 },
      scenes: [{ id: 'dialogue', clips: [{ id: 'quote', asset: 'episode', in: 0, dur: 3, audio: 'keep' }] }],
    }));
    fs.writeFileSync(path.join(production, 'assets.json'), JSON.stringify({ assets: [
      { id: 'episode', label: 'Episode', kind: 'video', origin: 'upload', path: 'media/episode.mp4' },
    ] }));
    const tool = await makeTool();
    const result = await tool.execute({ op: 'video.ship', production_dir: 'ad', path: 'render/final.mp4', video_id: 'main' }, ctx());
    const delivered = body(result);
    expect(result.isError).toBeUndefined();
    expect(delivered).toMatchObject({
      ok: true, outcome: 'continue',
      warnings: expect.arrayContaining([expect.objectContaining({
        code: 'DELIVERY_ORIGINAL_AUDIO_UNVERIFIED', severity: 'warning',
        message: expect.stringMatching(/0\.00s.*3\.00s/),
      })]),
    });
    expect(delivered.message ?? '').not.toContain('Repair before you reply');
  }, 60_000);

  it('takes a path from the production as well as from the workspace', async () => {
    await makeVideo('ad/render/final.mp4');
    const tool = await makeTool();
    for (const relative of ['render/final.mp4', 'ad/render/final.mp4']) {
      expect(body(await tool.execute({ op: 'video.ship', production_dir: 'ad', path: relative }, ctx())).ok).toBe(true);
    }
  });

  it('does not let a path leave through the production', async () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-timeline-outside-'));
    try {
      fs.writeFileSync(path.join(outside, 'x.mp4'), 'x');
      fs.mkdirSync(path.join(workspace, 'ad'));
      const tool = await makeTool();
      const relative = path.relative(path.join(workspace, 'ad'), path.join(outside, 'x.mp4'));
      expect(body(await tool.execute({ op: 'video.ship', production_dir: 'ad', path: relative }, ctx())))
        .toMatchObject({ ok: false, errorCode: 'E_VIDEO_SHIP_OUT_OF_SCOPE' });
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });
});

describe('video.render paths', () => {
  // On 2026-11-08 a render to render/main-179.mp4 landed beside the production, and
  // video.ship, which looks in the production first, would have sent an older file there.
  const rendered: string[] = [];
  beforeEach(async () => {
    rendered.length = 0;
    await makeVideo('source/new.mp4', 3);
    renderer.fake = async ({ outputAbsPath }) => {
      rendered.push(outputAbsPath);
      fs.mkdirSync(path.dirname(outputAbsPath), { recursive: true });
      fs.copyFileSync(path.join(workspace, 'source/new.mp4'), outputAbsPath);
      return { ok: true, op: 'video.render', path: outputAbsPath };
    };
  });
  const render = async (outputPath: string) => body(await (await makeTool()).execute(
    { op: 'video.render', production_dir: 'ad', video_id: 'main', output_path: outputPath }, ctx(),
  ));
  const shipped = async (shipPath: string) => body(await (await makeTool()).execute(
    { op: 'video.ship', production_dir: 'ad', path: shipPath }, ctx(),
  ));

  it('asks the render to hold back a narrated video that would go silent', async () => {
    // 2026-11-17: the canvas re-renders a user's own edit without this check; the Agent's does not.
    const asked: Array<boolean | undefined> = [];
    const fake = renderer.fake!;
    renderer.fake = async (input) => { asked.push(input.requireSound); return fake(input); };
    await render('render/final.mp4');
    expect(asked).toEqual([true]);
  });

  it.each(['render/final.mp4', 'ad/render/final.mp4'])('writes %s into the production, and video.ship delivers that render', async (outputPath) => {
    await makeVideo('ad/render/final.mp4');
    expect(await render(outputPath)).toMatchObject({ ok: true });
    expect(fs.existsSync(path.join(workspace, 'render'))).toBe(false);
    expect(fs.existsSync(path.join(workspace, 'ad', 'ad'))).toBe(false);
    const delivered = await shipped(outputPath);
    expect(delivered.ok).toBe(true);
    expect(delivered.version.duration_sec).toBeCloseTo(3, 0);
  });

  it('ships the exact render receipt when a same-named earlier video exists in the production', async () => {
    await makeVideo('ad/render/final.mp4');
    const previous = fs.readFileSync(path.join(workspace, 'ad', 'render', 'final.mp4'));
    const requested = path.join(workspace, 'render', 'final.mp4');
    const receipt = await render(requested);
    expect(receipt).toMatchObject({ ok: true, path: requested });

    const delivered = await shipped(receipt.path);
    expect(delivered.ok).toBe(true);
    expect(delivered.version.duration_sec).toBeCloseTo(3, 0);
    expect(fs.readFileSync(path.join(workspace, 'ad', 'render', 'final.mp4'))).toEqual(previous);
  });

  it('still refuses a path that leaves the task\'s files, and renders nothing', async () => {
    fs.mkdirSync(path.join(workspace, 'ad'), { recursive: true });
    expect(await render('../../elsewhere.mp4')).toMatchObject({ ok: false, errorCode: 'E_PATH_OUT_OF_SCOPE' });
    expect(rendered).toEqual([]);
  });
});

describe('video.check preview', () => {
  it('attaches readable frames only on request and reports when the attachment is unavailable', async () => {
    const { default: sharp } = await import('../../../helpers/fixture-sharp');
    const png = await sharp({ create: { width: 64, height: 32, channels: 3, background: 'red' } }).png().toBuffer();
    const previewFolders: string[] = [];
    let readable = true;
    renderer.check = async ({ previewOutputDirAbs }) => {
      if (!previewOutputDirAbs) return { ok: true, op: 'video.check' };
      previewFolders.push(previewOutputDirAbs);
      const sheet = path.join(previewOutputDirAbs, 'contact-sheet.png');
      if (readable) fs.writeFileSync(sheet, png);
      return { ok: true, op: 'video.check', contact_sheet: sheet };
    };
    fs.mkdirSync(path.join(workspace, 'ad', 'videos', 'main'), { recursive: true });
    const tool = await makeTool();
    const input = { op: 'video.check', production_dir: 'ad', video_id: 'main' };
    for (const check of [input, { ...input, include_preview: false }]) {
      const diagnostics = await tool.execute(check, ctx());
      expect(body(diagnostics)).not.toHaveProperty('visual_evidence');
      expect(diagnostics.images).toBeUndefined();
    }
    expect(previewFolders).toEqual([]);

    const result = await tool.execute({ ...input, include_preview: true }, ctx());
    expect(body(result)).toMatchObject({
      ok: true, visual_evidence: { attached: true, role: 'video_frames', coverage: 'scene_start_and_end' },
    });
    expect(body(result)).not.toHaveProperty('contact_sheet');
    expect(result.imageRetention).toBe('active_turn');
    expect(result.images).toHaveLength(1);
    const image = await sharp(Buffer.from(result.images![0].data, 'base64')).raw().toBuffer();
    expect([...image.subarray(0, 3)]).toEqual([255, 0, 0]);

    readable = false;
    const unavailable = await tool.execute({ ...input, include_preview: true }, ctx());
    expect(body(unavailable).visual_evidence).toEqual({ attached: false, role: 'video_frames' });
    expect(body(unavailable).ok).toBe(true);
    expect(unavailable.images).toBeUndefined();
    expect(new Set(previewFolders).size).toBe(2);
    expect(previewFolders.some((dir) => fs.existsSync(dir))).toBe(false);
  });
});

describe('video.check asking to move words off the product', () => {
  it('counts the asks in a run, so the check can stop asking after three, and starts again in the next run', async () => {
    const asked: number[] = [];
    renderer.check = async (input) => {
      asked.push(input.wordsOnProductAsked);
      if (input.wordsOnProductAsked < 3) input.onWordsOnProductAsked();
      return { ok: true, op: 'video.check', status: 'passed' };
    };
    fs.mkdirSync(path.join(workspace, 'ad', 'videos', 'main'), { recursive: true });
    const run = await makeTool();
    for (let index = 0; index < 4; index += 1) {
      await run.execute({ op: 'video.check', production_dir: 'ad', video_id: 'main' }, ctx());
    }
    await (await makeTool()).execute({ op: 'video.check', production_dir: 'ad', video_id: 'main' }, ctx());
    expect(asked).toEqual([0, 1, 2, 3, 0]);
  });
  // Review 2026-11-16 S4-3: still scenes and small text were asked about on every check.
  it('counts still-scene and small-text hints separately, per run', async () => {
    const asked: Array<[number, number]> = [];
    renderer.check = async (input) => {
      asked.push([input.stillScenesAsked, input.smallTextAsked]);
      if (input.stillScenesAsked < 3) input.onStillScenesAsked();
      if (asked.length === 1) input.onSmallTextAsked();
      return { ok: true, op: 'video.check', status: 'passed' };
    };
    fs.mkdirSync(path.join(workspace, 'ad', 'videos', 'main'), { recursive: true });
    const run = await makeTool();
    for (let index = 0; index < 4; index += 1) {
      await run.execute({ op: 'video.check', production_dir: 'ad', video_id: 'main' }, ctx());
    }
    await (await makeTool()).execute({ op: 'video.check', production_dir: 'ad', video_id: 'main' }, ctx());
    expect(asked).toEqual([[0, 0], [1, 1], [2, 1], [3, 1], [0, 0]]);
  });
});

describe('renderResultForModel', () => {
  it('drops the render\'s own bookkeeping and clean checks, and keeps what was asked for', async () => {
    const { renderResultForModel } = await import('../../../../src/main/model/core-agent/video-timeline-tool');
    const out = renderResultForModel({
      ok: true,
      op: 'video.render',
      path: '/x.mp4',
      render_profile: { cost_units: 1244 },
      probe: { duration_seconds: 20 },
      media_qa: { ok: true, issue_count: 0 },
      loudness: { skipped: true },
      scene_segments: { total: 2, rendered: 1, reused: 1 },
    });
    expect(out).toEqual({ ok: true, op: 'video.render', path: '/x.mp4', scene_segments: { total: 2, rendered: 1, reused: 1 } });
  });

  it('keeps findings and a real loudness result', async () => {
    const { renderResultForModel } = await import('../../../../src/main/model/core-agent/video-timeline-tool');
    const out = renderResultForModel({ ok: true, media_qa: { issue_count: 1, issues: ['x'] }, loudness: { integrated_lufs: -14 } });
    expect(out).toEqual({ ok: true, media_qa: { issue_count: 1, issues: ['x'] }, loudness: { integrated_lufs: -14 } });
  });
});

describe('video.import', () => {
  it('imports workspace media and keeps prior copies, identities and source bytes on repeated or changed input', async () => {
    await makeVideo('products/source.mp4', 0.3);
    const { default: sharp } = await import('../../../helpers/fixture-sharp');
    await sharp({ create: { width: 40, height: 60, channels: 3, background: 'blue' } }).png().toFile(path.join(workspace, 'products/blue.png'));
    const source = path.join(workspace, 'products/source.mp4');
    const before = fs.readFileSync(source);
    const tool = await makeTool();
    const call = () => tool.execute({ op: 'video.import', production_dir: 'ad', paths: ['products/source.mp4', 'products/blue.png'] }, ctx());
    const first = body(await call());
    expect(first).toMatchObject({ ok: true, assets: [
      { kind: 'video', path: 'media/source.mp4', width: 360, height: 640 },
      { kind: 'image', path: 'media/blue.png', width: 40, height: 60 },
    ] });
    expect(body(await call()).assets[0].asset_id).toBe(first.assets[0].asset_id);
    expect(fs.readFileSync(source)).toEqual(before);
    await makeVideo('products/source.mp4', 0.5);
    const second = body(await call());
    expect(second.assets[0].path).toBe('media/source-2.mp4');
    expect(fs.readFileSync(path.join(workspace, 'ad/media/source.mp4'))).toEqual(before);
    const ledger = JSON.parse(fs.readFileSync(path.join(workspace, 'ad/assets.json'), 'utf8'));
    expect(ledger.assets).toHaveLength(3);
  });

  it('rejects invalid path batches before copying any file and permits correction', async () => {
    await makeVideo('products/source.mp4', 0.3);
    const source = 'products/source.mp4';
    const tool = await makeTool();
    for (const delta of [
      { paths: [source, 'missing.mp4'] }, { paths: [source, 'products'] },
      { paths: [] }, { paths: [4] }, { paths: Array(33).fill(source) },
      { paths: [source], names: ['other.mp4'] },
    ]) {
      const refused = await tool.execute({ op: 'video.import', production_dir: 'ad', ...delta }, ctx());
      expect(refused.isError, JSON.stringify(delta)).toBe(true);
      expect(fs.existsSync(path.join(workspace, 'ad/media'))).toBe(false);
      expect(fs.existsSync(path.join(workspace, 'ad/assets.json'))).toBe(false);
    }
    expect(body(await tool.execute({ op: 'video.import', production_dir: 'ad', paths: [source] }, ctx())).assets).toHaveLength(1);
  });

  // 2026-11-23: a user's file elsewhere on the computer was refused although the access
  // setting the file tools follow allowed it; one run asked for an attachment and stopped.
  it('reads a file elsewhere on the computer by the access setting, and copies it in', async () => {
    const perm = await import('../../../../src/main/features/permissions');
    await makeVideo('products/source.mp4', 0.3);
    // Elsewhere on the computer: not in the workspace, not in Orkas's data folder.
    const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-import-elsewhere-'));
    const outside = path.join(elsewhere, 'outside.mp4');
    fs.copyFileSync(path.join(workspace, 'products/source.mp4'), outside);
    fs.symlinkSync(outside, path.join(workspace, 'escape.mp4'));
    // Another conversation's attachment is Orkas's data, refused whatever the setting.
    const otherChat = path.join(root, UID, 'cloud', 'chat_attachments', 'other-chat', 'clip.mp4');
    fs.mkdirSync(path.dirname(otherChat), { recursive: true });
    fs.copyFileSync(path.join(workspace, 'products/source.mp4'), otherChat);
    const tool = await makeTool();
    try {
      perm.setLocalExecMode('workspace_approval');
      for (const paths of [['products/source.mp4', outside], ['escape.mp4']]) {
        const refused = body(await tool.execute({ op: 'video.import', production_dir: 'ad', paths }, ctx()));
        expect(refused, JSON.stringify(paths)).toMatchObject({ ok: false, errorCode: 'E_PATH_OUT_OF_SCOPE' });
        expect(refused.message).toContain('Ask the user to attach it, or to allow files outside the workspace in Settings.');
        expect(fs.existsSync(path.join(workspace, 'ad/media'))).toBe(false);
      }
      perm.setLocalExecMode('all_files_auto');
      const kept = body(await tool.execute({ op: 'video.import', production_dir: 'ad', paths: [otherChat] }, ctx()));
      expect(kept).toMatchObject({ ok: false, errorCode: 'E_PATH_OUT_OF_SCOPE' });
      expect(kept.message).toContain("is in Orkas's own data");
      perm.setLocalExecMode('all_files_approval');
      const reply = body(await tool.execute({ op: 'video.import', production_dir: 'ad', paths: [outside, 'escape.mp4'] }, ctx()));
      expect(reply.ok).toBe(true);
      expect(reply.assets.length).toBeGreaterThanOrEqual(1);
      for (const asset of reply.assets) expect(fs.existsSync(path.join(workspace, 'ad', asset.path))).toBe(true);
      // The copy is the production's own; the original stays where it was.
      expect(fs.existsSync(outside)).toBe(true);
    } finally {
      perm.setLocalExecMode('all_files_approval');
      fs.rmSync(elsewhere, { recursive: true, force: true });
    }
  });

  it('asks before reading a sensitive place, and copies nothing when the user says no', async () => {
    const perm = await import('../../../../src/main/features/permissions');
    const bashPerms = await import('../../../../src/main/model/core-agent/bash-permissions');
    perm.setLocalExecMode('all_files_approval');
    await makeVideo('products/source.mp4', 0.3);
    const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-import-sensitive-'));
    const secret = path.join(elsewhere, '.ssh', 'clip.mp4');
    fs.mkdirSync(path.dirname(secret), { recursive: true });
    fs.copyFileSync(path.join(workspace, 'products/source.mp4'), secret);
    const tool = await makeTool();
    const asked: any[] = [];
    let answer: 'deny' | 'allow_once' = 'deny';
    bashPerms._setBroadcastForTest((_channel: string, info: any) => {
      asked.push(info);
      bashPerms.respond(info.request_id, answer);
    });
    try {
      const refused = body(await tool.execute({ op: 'video.import', production_dir: 'ad', paths: [secret] }, ctx()));
      expect(refused).toMatchObject({ ok: false, errorCode: 'E_SENSITIVE_PATH_DENIED' });
      expect(asked).toHaveLength(1);
      expect(asked[0]).toMatchObject({ operation: 'video.import', subject: secret, reasons: ['sensitive_path'] });
      expect(fs.existsSync(path.join(workspace, 'ad/media'))).toBe(false);
      answer = 'allow_once';
      const reply = body(await tool.execute({ op: 'video.import', production_dir: 'ad', paths: [secret] }, ctx()));
      expect(reply).toMatchObject({ ok: true });
      expect(reply.assets).toHaveLength(1);
      expect(asked).toHaveLength(2);
    } finally {
      bashPerms._setBroadcastForTest(null);
      bashPerms._resetForTest();
      fs.rmSync(elsewhere, { recursive: true, force: true });
    }
  });
  const attachmentDir = async () => {
    const { chatAttachmentDirForConversation } = await import('../../../../src/main/util/project-layout');
    const dir = chatAttachmentDirForConversation(UID, 'current-chat');
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  };

  it('brings the conversation\'s attachments in, and nothing later needs their long paths', async () => {
    const dir = await attachmentDir();
    fs.writeFileSync(path.join(dir, 'notes.pdf'), 'not media');
    const { bundledFfmpegPaths } = await import('../../../../src/main/util/bundled-runtime');
    const made = spawnSync(bundledFfmpegPaths().ffmpeg as string, ['-y', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=red:s=640x360', '-frames:v', '1', path.join(dir, '台灯.png')], { encoding: 'utf8' });
    expect(made.status).toBe(0);
    const tool = await makeTool();
    const reply = body(await tool.execute({ op: 'video.import', production_dir: 'lamp-ad' }, ctx()));
    expect(reply).toMatchObject({ ok: true, skipped: ['notes.pdf'] });
    expect(reply.assets).toEqual([expect.objectContaining({ kind: 'image', label: '台灯.png', path: 'media/台灯.png', width: 640, height: 360 })]);
    const ledger = JSON.parse(fs.readFileSync(path.join(workspace, 'lamp-ad', 'assets.json'), 'utf8'));
    expect(ledger.assets).toEqual([expect.objectContaining({ id: reply.assets[0].asset_id, path: 'media/台灯.png', origin: 'upload' })]);
    expect(fs.existsSync(path.join(workspace, 'lamp-ad', 'media', '台灯.png'))).toBe(true);
    expect(fs.existsSync(path.join(dir, '台灯.png'))).toBe(true);
    // Footage work has no timeline yet, and a status that said nothing was imported stopped a live run.
    const status = body(await tool.execute({ op: 'video.status', production_dir: 'lamp-ad' }, ctx()));
    expect(status).toMatchObject({ ok: true, videos: [], asset_count: 1 });
  });

  it('says so when there is nothing to bring in', async () => {
    const tool = await makeTool();
    const reply = body(await tool.execute({ op: 'video.import', production_dir: 'lamp-ad' }, ctx()));
    expect(reply).toMatchObject({ ok: true, assets: [] });
    expect(reply.message).toContain('no images');
  });

  it('needs a folder to bring them into', async () => {
    const tool = await makeTool();
    expect(body(await tool.execute({ op: 'video.import' }, ctx()))).toMatchObject({ ok: false, errorCode: 'E_PRODUCTION_DIR' });
  });
});

describe('video.status and the operations carried over', () => {

  it('reports actual pending and completed local identities without replay instructions or credit counters',async()=>{
    fs.mkdirSync(path.join(workspace,'lamp-ad','videos'),{recursive:true});const tool=await makeTool();
    expect(body(await tool.execute({op:'video.status',production_dir:'lamp-ad'},ctx())).generation_requests).toEqual({pending:0,completed:0});
    const budget=await import('../../../../src/main/features/video_production_budget');const key={userId:UID,scope:'current-chat'};
    await budget.reserveProductionRequest({...key,fingerprint:'a'.repeat(64),kind:'video'});await budget.settleProductionRequest({...key,fingerprint:'a'.repeat(64)});
    await budget.reserveProductionRequest({...key,fingerprint:'b'.repeat(64),kind:'image'});
    const status=body(await tool.execute({op:'video.status',production_dir:'lamp-ad'},ctx()));
    expect(status.generation_requests).toEqual({pending:1,completed:1});expect(status.credits).toBeUndefined();expect(status.open_requests).toBeUndefined();expect(status.open_requests_note).toBeUndefined();
  });

  // Review 2026-11-16 S4-4: every version with its findings came back on every later turn.
  it('lists the newest five versions per video with the newest review only, and counts the rest', async () => {
    fs.mkdirSync(path.join(workspace, 'lamp-ad', 'videos'), { recursive: true });
    const review = (n: number) => ({ status: 'has_findings', scope: 'sampled_page', advisory: true, findings: [{ code: `F${n}`, count: 1, scenes: [], examples: [] }] });
    const version = (n: number, videoId: string) => ({ id: `v${n}`, video_id: videoId, path: `render/${videoId}-${n}.mp4`, sha256: 'x'.repeat(64),
      duration_sec: 15, canvas: '1080x1920', fps: 30, integrated_lufs: -14, visual_review: review(n), shipped_at: `2026-11-18T0${n}:00:00Z`, warnings: [`W${n}`] });
    const versions = [1, 2, 3, 4, 5, 6, 7].map((n) => version(n, 'main')).concat([version(8, 'teaser')]);
    fs.writeFileSync(path.join(workspace, 'lamp-ad', 'versions.json'), JSON.stringify({ versions }));
    const status = body(await (await makeTool()).execute({ op: 'video.status', production_dir: 'lamp-ad' }, ctx()));
    expect(status.versions.map((entry: { id: string }) => entry.id)).toEqual(['v3', 'v4', 'v5', 'v6', 'v7', 'v8']);
    expect(status.older_versions).toBe(2);
    expect(status.versions.filter((entry: { visual_review?: unknown }) => entry.visual_review).map((entry: { id: string }) => entry.id)).toEqual(['v7', 'v8']);
    expect(status.versions[0]).toEqual({ id: 'v3', video_id: 'main', path: 'render/main-3.mp4', duration_sec: 15, shipped_at: '2026-11-18T03:00:00Z', warnings: ['W3'] });
    // The file keeps every version and field.
    expect(JSON.parse(fs.readFileSync(path.join(workspace, 'lamp-ad', 'versions.json'), 'utf8')).versions).toHaveLength(8);
  });

  it('lists the productions here when no folder is named, for a turn that lost the name', async () => {
    fs.mkdirSync(path.join(workspace, 'lamp-ad', 'videos'), { recursive: true });
    fs.mkdirSync(path.join(workspace, 'not-a-production'), { recursive: true });
    const tool = await makeTool();
    expect(body(await tool.execute({ op: 'video.status' }, ctx())).productions).toEqual(['lamp-ad']);
  });

  it('refuses an unknown operation with the valid ones, and runs nothing', async () => {
    const legacy = vi.fn();
    const tool = await makeTool(legacy);
    const reply = body(await tool.execute({ op: 'video.generate', production_dir: 'ad' }, ctx()));
    expect(reply).toMatchObject({ ok: false, errorCode: 'E_VIDEO_OP_UNKNOWN' });
    expect(reply.message).toBe('op must be one of: video.status, video.import, video.request_budget, video.check, video.sheet, video.render, video.ship, reference.inspect, product.capture, speech.capabilities, speech.transcribe');
    expect(legacy).not.toHaveBeenCalled();
  });

  // Live runs on 2026-11-17–19 put another tool's name in op twice, this tool's name twice and an
  // op without its prefix once; the bare list did not say which mistake each was.
  it('says which mistake an unknown op is, and still runs nothing', async () => {
    const legacy = vi.fn();
    const tool = await makeTool(legacy);
    const said = async (op: string) => {
      const reply = body(await tool.execute({ op, production_dir: 'ad', text: 'hello' }, ctx()));
      expect(reply).toMatchObject({ ok: false, errorCode: 'E_VIDEO_OP_UNKNOWN' });
      return reply.message;
    };
    expect(await said('generate_speech')).toBe('generate_speech is a tool of its own, not a video_studio op. Call generate_speech with these fields.');
    expect(await said('generate_video')).toBe('generate_video is a tool of its own, not a video_studio op. Call generate_video with these fields.');
    expect(await said('video_studio')).toBe('op names the operation, not this tool. It is one of: video.status, video.import, video.request_budget, video.check, video.sheet, video.render, video.ship, reference.inspect, product.capture, speech.capabilities, speech.transcribe');
    expect(await said('request_budget')).toBe('There is no op request_budget; it is video.request_budget. Run it again with that name.');
    expect(await said('transcribe')).toBe('There is no op transcribe; it is speech.transcribe. Run it again with that name.');
    expect(legacy).not.toHaveBeenCalled();
  });

  it('saves a capture beside the page: the folder named, or the main video of the production', async () => {
    const legacy = vi.fn(async (args: any) => ({ content: JSON.stringify({ ok: true, composition_dir: path.join(workspace, args.composition_dir), capture_dir: 'assets/product/x' }) }));
    const tool = await makeTool(legacy);
    await tool.execute({ op: 'product.capture', url: 'https://example.com', video_dir: 'ad/videos/second' }, ctx());
    const named = (legacy.mock.calls[0] as any[])[0];
    expect(named.composition_dir).toBe('ad/videos/second');
    expect(named).not.toHaveProperty('video_dir');
    const defaulted: any = await tool.execute({ op: 'product.capture', url: 'https://example.com', production_dir: 'ad' }, ctx());
    expect((legacy.mock.calls[1] as any[])[0].composition_dir).toBe(path.join('ad', 'videos', 'main'));
    expect((legacy.mock.calls[1] as any[])[0]).not.toHaveProperty('production_dir');
    expect(body(defaulted).paths_relative_to).toBe(path.join(workspace, 'ad', 'videos', 'main'));
  });

  it('refuses a capture with nowhere to go, rather than the old default folder', async () => {
    const legacy = vi.fn();
    const tool = await makeTool(legacy);
    const reply = body(await tool.execute({ op: 'product.capture', url: 'https://example.com' }, ctx()));
    expect(reply).toMatchObject({ ok: false, errorCode: 'E_PRODUCTION_DIR' });
    expect(legacy).not.toHaveBeenCalled();
  });

  it('tells the model to carry on without voices, and leaves a ready answer alone', async () => {
    const unavailable = vi.fn(async () => ({ content: JSON.stringify({ ok: false, status: 'unavailable', message: 'Sign in first.' }) }));
    const without = await makeTool(unavailable);
    const told = body(await without.execute({ op: 'speech.capabilities', language: 'es' }, ctx()));
    expect(told.message).toBe('Sign in first. Do not stop for this: use on-screen text and captions, and say so in your reply.');
    const ready = { content: JSON.stringify({ ok: true, status: 'ready' }) };
    const withVoices = await makeTool(vi.fn(async () => ready));
    expect(await withVoices.execute({ op: 'speech.capabilities', language: 'es' }, ctx())).toBe(ready);
  });

  // 2026-11-16 review S4-1: the listing tells the model to pass all_voices true for the
  // voices past its sample (as when the user named one), but the schema rewrite dropped the
  // field, so the runtime's input projection removed it before the tool ran.
  it('passes all_voices from a real model call through to the voice listing', async () => {
    const { AgentRunner, createConfig, ProviderRegistry, Session } = await import('#core-agent');
    const shared = vi.fn(async () => ({ content: JSON.stringify({ ok: true, status: 'ready', routes: [] }) }));
    const tool = await makeTool(shared);
    let round = 0;
    const results: string[] = [];
    const provider = {
      id: 'scripted', name: 'scripted',
      async complete() { throw new Error('unused'); },
      async *stream(params: any) {
        if (round++ === 0) {
          yield { type: 'message_end', stopReason: 'tool_use', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
            content: [{ type: 'tool_use', id: 'voices-1', name: 'video_studio',
              input: { op: 'speech.capabilities', language: 'zh-CN', all_voices: true } }] };
          return;
        }
        for (const message of params.messages) {
          for (const block of Array.isArray(message.content) ? message.content : []) {
            if (block.type === 'tool_result') results.push(typeof block.content === 'string' ? block.content : JSON.stringify(block.content));
          }
        }
        yield { type: 'message_end', stopReason: 'end_turn', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
          content: [{ type: 'text', text: 'Listed.' }] };
      },
      async validateAuth() { return true; },
    };
    const providers = new ProviderRegistry();
    providers.registerFactory('scripted', () => provider as any);
    const runner = new AgentRunner({ session: new Session(), providers, tools: [tool], workingDir: workspace,
      config: createConfig({ agent: { defaultProvider: 'scripted', defaultModel: 'scripted', maxRetries: 0 }, evolution: { enabled: false } }) });
    const run = await runner.run({ message: 'List every voice; I want the one called Aria.' });
    expect(run.meta.error).toBeUndefined();
    expect(shared).toHaveBeenCalledTimes(1);
    expect((shared.mock.calls[0] as any[])[0]).toMatchObject({ op: 'speech.capabilities', language: 'zh-CN', all_voices: true });
    expect(results.join('\n')).not.toContain('ignored_fields');
  });

  it('finds a file named relative to the production, as video.import reports it', async () => {
    fs.mkdirSync(path.join(workspace, 'ad', 'media'), { recursive: true });
    fs.writeFileSync(path.join(workspace, 'ad', 'media', 'phone.mp4'), 'video');
    fs.writeFileSync(path.join(workspace, 'other.mp4'), 'video');
    const shared = vi.fn(async () => ({ content: '{}' }));
    const tool = await makeTool(shared);
    const inputOf = (index: number) => ((shared.mock.calls[index] as any[])[0]).input_path;

    await tool.execute({ op: 'reference.inspect', production_dir: 'ad', input_path: 'media/phone.mp4' }, ctx());
    expect(inputOf(0)).toBe(path.join(workspace, 'ad', 'media', 'phone.mp4'));

    await tool.execute({ op: 'speech.transcribe', production_dir: 'ad', input_path: 'media/phone.mp4' }, ctx());
    expect(inputOf(1)).toBe(path.join(workspace, 'ad', 'media', 'phone.mp4'));

    await tool.execute({ op: 'reference.inspect', production_dir: 'ad', input_path: 'other.mp4' }, ctx());
    expect(inputOf(2)).toBe(path.join(workspace, 'other.mp4'));

    await tool.execute({ op: 'reference.inspect', input_path: 'other.mp4' }, ctx());
    expect(inputOf(3)).toBe('other.mp4');
  });

  it('leaves transcription out of it, and passes other failures through untouched', async () => {
    const failed = { content: 'not json', isError: true };
    const legacy = vi.fn(async () => failed);
    const tool = await makeTool(legacy);
    await tool.execute({ op: 'speech.transcribe', input_path: 'ad/talk.mp4', production_dir: 'ad' }, ctx());
    expect((legacy.mock.calls[0] as any[])[0]).not.toHaveProperty('composition_dir');
    expect(await tool.execute({ op: 'product.capture', url: 'https://example.com', production_dir: 'ad' }, ctx())).toBe(failed);
  });
});

describe('an installed Agent from another release', () => {
  async function installAgent(agent: Record<string, unknown>) {
    const { userMarketplaceAgentDir } = await import('../../../../src/main/paths');
    const dir = userMarketplaceAgentDir(UID, '79df9cc89f5f');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'agent.json'), JSON.stringify(agent));
  }

  it('asks for the Agent to be updated when it is older, whichever operation it tries', async () => {
    const shared = vi.fn();
    const tool = await makeTool(shared);
    await installAgent({ version: '1.6.101', video_studio_contract: 2 });
    for (const op of ['video.status', 'composition.draft', 'reference.inspect']) {
      const reply = body(await tool.execute({ op, production_dir: 'ad' }, ctx()));
      expect(reply).toMatchObject({ ok: false, errorCode: 'E_VIDEO_STUDIO_SKILL_OUTDATED' });
      expect(reply.message).toContain('Do not retry');
    }
    expect(shared).not.toHaveBeenCalled();
  });

  it('asks for the App to be updated when the Agent is newer', async () => {
    await installAgent({ version: '9.0.0', video_studio_contract: 4 });
    const reply = body(await (await makeTool()).execute({ op: 'video.status' }, ctx()));
    expect(reply).toMatchObject({ ok: false, errorCode: 'E_VIDEO_STUDIO_HOST_OUTDATED' });
  });

  it('works with the Agent this release ships, and with none installed', async () => {
    const tool = await makeTool();
    expect(body(await tool.execute({ op: 'video.status' }, ctx())).ok).toBe(true);
    await installAgent({ version: '2.0.0', video_studio_contract: 3 });
    expect(body(await tool.execute({ op: 'video.status' }, ctx())).ok).toBe(true);
  });
});

describe('a production an older version made', () => {
  function seedOldProduction(): string {
    const dir = path.join(workspace, 'lamp', 'project', 'composition');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'composition-manifest.json'), JSON.stringify({
      schema_version: 2,
      composition: { id: 'old', width: 360, height: 640, duration: 2, fps: 30 },
      scenes: [{ id: 'hook', start: 0, duration: 2 }],
      audio: { owner: 'none', tracks: [] },
    }));
    return dir;
  }

  it('is upgraded on the first status, which says so once and leaves the old folder as it was', async () => {
    const old = seedOldProduction();
    const before = fs.readFileSync(path.join(old, 'composition-manifest.json'));
    const tool = await makeTool();

    const first = body(await tool.execute({ op: 'video.status' }, ctx()));
    expect(first.upgraded).toEqual([expect.objectContaining({ production_dir: 'lamp' })]);
    expect(first.message).toContain('nothing is waiting for a confirmation');
    expect(first.productions).toContain('lamp');

    const second = body(await tool.execute({ op: 'video.status' }, ctx()));
    expect(second.upgraded).toBeUndefined();
    expect(second.message).toBeUndefined();
    expect(fs.readFileSync(path.join(old, 'composition-manifest.json'))).toEqual(before);
  });

  it('shows the video and what could not be carried over once it is opened', async () => {
    seedOldProduction();
    const tool = await makeTool();
    await tool.execute({ op: 'video.status' }, ctx());

    const opened = body(await tool.execute({ op: 'video.status', production_dir: 'lamp' }, ctx()));

    expect(opened.videos).toEqual([expect.objectContaining({ scenes: ['hook'], duration_seconds: 2 })]);
    expect(typeof opened.videos[0].upgrade_notes).toBe('string');
    expect(opened.videos[0].upgrade_notes.length).toBeLessThanOrEqual(4000);
  });
});


describe('production status filesystem boundary', () => {
  it.each(['assets.json', 'versions.json', 'videos', 'preview', 'render'])(
    'refuses a production with an escaping %s link', async (name) => {
      const production = path.join(workspace, 'ad');
      const foreign = path.join(root, 'foreign');
      fs.mkdirSync(production);
      fs.mkdirSync(foreign);
      const directory = !name.endsWith('.json');
      const target = directory ? foreign : path.join(foreign, name);
      if (!directory) fs.writeFileSync(target, JSON.stringify(name === 'assets.json' ? { assets: [] } : { versions: [] }));
      fs.symlinkSync(target, path.join(production, name), directory ? 'junction' : 'file');
      const tool = await makeTool();
      const result = body(await tool.execute({ op: 'video.status', production_dir: 'ad' }, ctx()));
      expect(result).toMatchObject({ ok: false, errorCode: 'E_PRODUCTION_DIR' });
      expect(result.versions).toBeUndefined();
    });
});

  describe('a plan fitted to the configured video service', () => {
    const h3Lite = [{ entry: { id: 'own-h3', provider: 'minimax', model: 'MiniMax-H3-Lite', apiKey: 'key', label: '', createdAt: 0 } }];
    const shot = { kind: 'video', count: 2, duration: 4, resolution: '480p', ratio: '9:16' };
    const ownKey = () => ({ sufficient: true, externally_billed_segment_ids: ['planned-1-1', 'planned-1-2'], unavailable_segment_ids: [], external_billing_estimate_available: false, segments: [] });
    const request = async (planned: unknown) => (await makeTool()).execute({ op: 'video.request_budget', production_dir: 'ad', planned }, ctx());

    it.each([
      { label: 'silent output', fields: { generate_audio: false }, native: { resolution: '480p', generate_audio: true } },
      { label: 'a non-native output resolution', fields: { resolution: '720p' }, native: { resolution: '768p' } },
      { label: 'silent output at a non-native resolution', fields: { resolution: '720p', generate_audio: false }, native: { resolution: '768p', generate_audio: true } },
    ])('prices $label with native settings while retaining the desired output', async ({ fields, native }) => {
      quote.videoServices = h3Lite;
      quote.next = ownKey();
      const planned = [{ ...shot, ...fields }];
      const wanted = structuredClone(planned);
      const result = await request(planned);
      expect(body(result)).toMatchObject({ ok: true, covered: true, billed_to_own_key: true, external_billing_estimate_available: false });
      expect(quote.payload).toEqual([1, 2].map(copy => ({
        segment_id: `planned-1-${copy}`, kind: 'video', billing_mode: 'external', provider: 'minimax',
        duration: 4, ratio: '9:16', ...native,
      })));
      expect(planned).toEqual(wanted);
      expect(quote.args[0]).toEqual([1, 2].map(copy => ({
        segment_id: `planned-1-${copy}`, kind: 'video', prompt: '', duration: 4,
        ratio: '9:16', resolution: '480p', ...fields,
      })));
      expect(result.isError).not.toBe(true);
      expect(body(result).budget_request).toBeUndefined();
      expect(result.synthesizeAndEndTurn).toBeUndefined();
    });

    it('rejects an overlong shot before pricing instead of truncating its action', async () => {
      quote.videoServices = h3Lite;
      quote.next = ownKey();
      const planned = [{ ...shot, duration: 16, resolution: '720p', generate_audio: false }];
      const result = await request(planned);
      expect(body(result)).toMatchObject({ ok: false, errorCode: 'E_VIDEO_PARAMETERS_INVALID', outcome: 'continue' });
      expect(body(result).message).toContain('duration must be 4-15 seconds');
      expect(quote.payload).toEqual([]);
      expect(planned[0]).toMatchObject({ duration: 16, resolution: '720p', generate_audio: false });
      expect(result.isError).toBe(true);
      expect(body(result).budget_request).toBeUndefined();
      expect(result.synthesizeAndEndTurn).toBeUndefined();
      await expect((await import('../../../../src/main/features/video_production_budget')).productionRequestStatus({ userId: UID, scope: 'current-chat' }))
        .resolves.toMatchObject({ pending: 0, completed: 0 });
    });

    it('keeps its answer for a service set up wrongly, which no change to the request can fix', async () => {
      quote.videoServices = [{ entry: { id: 'own-wan', provider: 'aliyun', model: 'wan3.0-video', apiKey: 'key', label: '', createdAt: 0, region: 'cn-beijing' } }];
      quote.next = ownKey();
      const result = await request([{ kind: 'video', count: 1, duration: 5 }]);
      expect(body(result)).toMatchObject({ ok: false, errorCode: 'E_BUDGET_QUOTE_FAILED', outcome: 'continue' });
      expect(body(result).message).toBe('The configured generation service could not be checked, so this generation request was not sent.');
      expect(body(result).quote_error).toMatchObject({ source_code: 'E_VIDEO_PRODUCTION_VIDEO_PARAMETERS_INVALID', message: expect.stringContaining('Configure the Alibaba Cloud workspace ID') });
    });
  });

describe('credits on delivery', () => {
  const credited = (id: string, credit: string) => ({ id, kind: 'video', label: id, path: `media/stock/${id}.mp4`, origin: 'stock',
    source: { provider: 'wikimedia', id: `wikimedia-video-${id}`, license: 'CC BY 4.0', credit } });

  it('credits only what a timeline plays, and every credited file for a video made with ffmpeg', async () => {
    const dir = path.join(workspace, 'ad');
    fs.mkdirSync(path.join(dir, 'videos', 'main'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'versions'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'assets.json'), JSON.stringify({ assets: [
      credited('rain', '"Rain" by A, CC BY 4.0'),
      credited('snow', '"Snow" by B, CC BY 4.0'),
      { id: 'pour', kind: 'video', label: 'pour', path: 'media/stock/pour.mp4', origin: 'stock', source: { provider: 'pexels', id: 'pexels-video-1', license: 'Pexels License' } },
      { id: 'music', kind: 'audio', label: 'music', path: 'media/stock/music.mp3', origin: 'stock',
        source: { provider: 'wikimedia', id: 'wikimedia-audio-1', license: 'CC BY 3.0', credit: '"Tune" by C, CC BY 3.0' } },
    ] }));
    fs.writeFileSync(path.join(dir, 'videos', 'main', 'manifest.json'), JSON.stringify({ schema_version: 3, id: 'main',
      scenes: [{ id: 'a', clips: [{ id: 'c', asset: 'rain', in: 0, dur: 1 }] }, { id: 'b', clips: [{ id: 'd', asset: 'pour', in: 0, dur: 1 }] }],
      tracks: [{ asset: 'music' }] }));
    const stock = await import('../../../../src/main/features/video_timeline_ship');
    const timeline = await stock.writeStockCredits({ productionDirAbs: dir, deliveredAbs: path.join(dir, 'versions', 'main-v1.mp4'), videoDirAbs: path.join(dir, 'videos', 'main') });
    expect(timeline).toEqual({ lines: ['"Rain" by A, CC BY 4.0', '"Tune" by C, CC BY 3.0'], file: path.join(dir, 'versions', 'main-v1.credits.txt'), timeline: true });
    expect(fs.readFileSync(timeline!.file, 'utf8')).toBe('"Rain" by A, CC BY 4.0\n"Tune" by C, CC BY 3.0\n');
    const loose = await stock.writeStockCredits({ productionDirAbs: dir, deliveredAbs: path.join(dir, 'versions', 'cut-v1.mp4') });
    expect(loose?.lines).toEqual(['"Rain" by A, CC BY 4.0', '"Snow" by B, CC BY 4.0', '"Tune" by C, CC BY 3.0']);
    expect(loose?.timeline).toBe(false);
  });

  it('publishes a credited video with its credits, and a plain revision on its own', async () => {
    await (async () => {
      const file = path.join(workspace, 'ad', 'render', 'cut.mp4');
      fs.mkdirSync(path.dirname(file), { recursive: true });
      await makeVideo('ad/render/cut.mp4', 1);
    })();
    fs.writeFileSync(path.join(workspace, 'ad', 'assets.json'), JSON.stringify({ assets: [credited('rain', '"Rain" by A, CC BY 4.0')] }));
    const onOutputsPublished = vi.fn((files: string[]) => files);
    const tool = await makeTool(undefined, undefined, { onOutputsPublished });
    const shipped = await tool.execute({ op: 'video.ship', production_dir: 'ad', path: 'render/cut.mp4', expect_duration_sec: 1, expect_aspect: '9:16', expect_audio: true }, ctx());
    const result = body(shipped);
    expect(result.ok).toBe(true);
    expect(result.credits).toEqual(['"Rain" by A, CC BY 4.0']);
    expect(result.credits_file).toMatch(/^versions\/.+\.credits\.txt$/);
    expect(fs.readFileSync(path.join(workspace, 'ad', result.credits_file), 'utf8')).toBe('"Rain" by A, CC BY 4.0\n');
    expect(result.message).toContain(`This production has files that need credit. In your reply, give the user the lines for those this video uses, to paste into the post's description; all are saved beside the video as ${path.basename(result.credits_file)}.`);

    fs.writeFileSync(path.join(workspace, 'ad', 'assets.json'), JSON.stringify({ assets: [] }));
    const firstVideo = path.join(workspace, 'ad', result.version.path);
    const firstCredits = path.join(workspace, 'ad', result.credits_file);
    expect(onOutputsPublished).toHaveBeenCalledExactlyOnceWith([firstVideo, firstCredits]);

    await makeVideo('ad/render/cut2.mp4', 2);
    onOutputsPublished.mockClear();
    const plain = body(await tool.execute({ op: 'video.ship', production_dir: 'ad', path: 'render/cut2.mp4', expect_duration_sec: 2, expect_aspect: '9:16', expect_audio: true }, ctx()));
    expect(plain.ok).toBe(true);
    expect(plain).not.toHaveProperty('credits');
    expect(String(plain.message ?? '')).not.toContain('need credit');
    const revisedVideo = path.join(workspace, 'ad', plain.version.path);
    expect(revisedVideo).not.toBe(firstVideo);
    expect(fs.existsSync(firstVideo)).toBe(true);
    expect(onOutputsPublished).toHaveBeenCalledExactlyOnceWith([revisedVideo]);
  });

  it('publishes the video if the credits file cannot be saved', async () => {
    const dir = path.join(workspace, 'ad');
    await makeVideo('ad/render/cut.mp4');
    fs.writeFileSync(path.join(dir, 'assets.json'), JSON.stringify({ assets: [credited('rain', '"Rain" by A, CC BY 4.0')] }));
    const onOutputsPublished = vi.fn((files: string[]) => files);
    const tool = await makeTool(undefined, undefined, {
      onFileWritten: (file) => { fs.mkdirSync(file.replace(/\.mp4$/, '.credits.txt')); },
      onOutputsPublished,
    });
    const result = body(await tool.execute({ op: 'video.ship', production_dir: 'ad', path: 'render/cut.mp4', expect_audio: true }, ctx()));
    expect(result.ok).toBe(true);
    expect(result).not.toHaveProperty('credits_file');
    expect(result.reply_link).toContain(result.version.path);
    expect(onOutputsPublished).toHaveBeenCalledExactlyOnceWith([path.join(dir, result.version.path)]);
  });
});
