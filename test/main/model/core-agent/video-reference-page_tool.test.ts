import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ BrowserWindow: function BrowserWindow() {} }));
// The task browser is scripted; saving, measuring and inspection are real.
const browserState = vi.hoisted(() => ({ runId: 'run-1' as string | undefined, browser: null as unknown, calls: 0 }));
vi.mock('../../../../src/main/features/web_assist_lifecycle', () => ({ browserTaskRunId: () => browserState.runId }));
vi.mock('../../../../src/main/features/web_assist', () => ({
  createModelPageVideoBrowser: () => { browserState.calls += 1; return browserState.browser; },
}));

const UID = 'reference-page';
const PAGE = 'https://www.example-video.test/v/1';
const NOTES = 'These frames stay in your context until this turn ends or six newer images arrive. '
  + 'If this video is the reference, before writing the video list in reference-notes.md what a viewer would name as its look and whether you reuse, recreate or drop each, then build the video from that list.';
let root: string;
let previousRoot: string | undefined;
let workspace: string;
let fixtures: string;

beforeAll(async () => {
  fixtures = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-reference-page-'));
  const { bundledFfmpegPaths } = await import('../../../../src/main/util/bundled-runtime');
  const { runVideoProcessForTest } = await import('../../../../src/main/features/video_studio');
  for (const [name, args] of [
    ['both.mp4', ['-f', 'lavfi', '-i', 'testsrc=s=160x90:d=3', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=3', '-c:v', 'libx264', '-c:a', 'aac', '-shortest']],
    ['picture.mp4', ['-f', 'lavfi', '-i', 'testsrc=s=160x90:d=3', '-c:v', 'libx264']],
  ] as const) {
    const made = await runVideoProcessForTest(bundledFfmpegPaths().ffmpeg!, ['-y', '-loglevel', 'error', ...args, path.join(fixtures, name)], { timeoutMs: 20_000 });
    expect(made.code).toBe(0);
  }
}, 60_000);

beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-reference-page-root-'));
  previousRoot = process.env.ORKAS_WORKSPACE_ROOT;
  process.env.ORKAS_WORKSPACE_ROOT = root;
  vi.resetModules();
  (await import('../../../../src/main/features/users')).activateUser(UID);
  workspace = path.join(root, 'workspace');
  fs.mkdirSync(workspace);
  (await import('../../../../src/main/features/user_workspace')).setWorkspacePath(UID, workspace);
  browserState.runId = 'run-1';
  browserState.calls = 0;
});
afterEach(() => {
  if (previousRoot === undefined) delete process.env.ORKAS_WORKSPACE_ROOT;
  else process.env.ORKAS_WORKSPACE_ROOT = previousRoot;
  fs.rmSync(root, { recursive: true, force: true });
});

/** A page that plays one video; `serve` is what each download sends back. */
function page(script: { video?: { durationSec: number; src: string } | null; serve?: string | 'refuse' | 'huge' }) {
  const events: string[] = [];
  browserState.browser = {
    async open() { return { ok: true, tabId: 'tab-1' }; },
    async waitLoaded() {},
    async playingVideo() { return script.video === undefined ? { durationSec: 3, src: '' } : script.video; },
    media() {
      return script.serve === 'huge'
        ? [{ url: 'https://cdn.test/main', contentType: 'video/mp4', totalBytes: 300 * 1024 * 1024, hits: 5 }]
        : [{ url: 'https://cdn.test/main', contentType: 'video/mp4', totalBytes: 5000, hits: 5 }];
    },
    async download(_tab: string, _url: string, savePath: string) {
      if (!script.serve || script.serve === 'refuse') return { state: 'refused' };
      fs.copyFileSync(path.join(fixtures, script.serve), savePath);
      return { state: 'completed' };
    },
    keepOpen() { events.push('keep'); },
    close() { events.push('close'); },
    release() { events.push('release'); },
  };
  return events;
}

async function inspect(input: Record<string, unknown>) {
  const tool = (await import('../../../../src/main/model/core-agent/video-studio-tool')).createVideoStudioTool({ userId: UID, cid: 'current-chat' } as any);
  const result = await tool.execute({ op: 'reference.inspect', ...input }, { workingDir: workspace, state: {} } as any);
  return { result, body: JSON.parse(result.content as string) };
}
const referencesDir = () => path.join(workspace, 'references', 'assets', 'references');

describe('reference.inspect from a page link', () => {
  it('advertises the link on the shared url field and saves into the production through the model-visible tool', async () => {
    page({ serve: 'both.mp4' });
    const { createVideoStudioTool } = await import('../../../../src/main/model/core-agent/video-studio-tool');
    const { createVideoTimelineTool } = await import('../../../../src/main/model/core-agent/video-timeline-tool');
    const opts = { userId: UID, cid: 'current-chat' } as any;
    const tool = createVideoTimelineTool(opts, createVideoStudioTool(opts));
    expect((tool.inputSchema as any).properties.url.description).toBe('product.capture: the http(s) page to capture into assets/product/. reference.inspect: a page playing the reference video, such as a share link, used instead of input_path.');
    const result = await tool.execute({ op: 'reference.inspect', production_dir: 'ad', url: PAGE, sample_times: [1] }, { workingDir: workspace, state: {} } as any);
    const body = JSON.parse(result.content as string);
    expect(body).toMatchObject({ ok: true, saved_from: 'www.example-video.test' });
    expect(body.composition_dir).toBe(path.join(workspace, 'ad', 'videos', 'main'));
    expect(fs.existsSync(path.join(body.composition_dir, body.reference_path))).toBe(true);
  });

  it('inspects the video the page plays, names the site, and keeps only the inspected copy', async () => {
    const events = page({ serve: 'both.mp4' });
    const { result, body } = await inspect({ url: PAGE, sample_times: [0.5, 2.5] });
    expect(result.isError, result.content as string).toBeFalsy();
    expect(body).toMatchObject({ ok: true, saved_from: 'www.example-video.test', visual_evidence: { attached: true } });
    expect(body).not.toHaveProperty('input_path');
    expect(body.message).toBe(NOTES);
    expect(Math.abs(body.duration_sec - 3)).toBeLessThan(0.2);
    expect(fs.existsSync(path.join(body.composition_dir, body.reference_path))).toBe(true);
    expect(fs.readdirSync(referencesDir()).filter(name => name.startsWith('page-'))).toEqual([]);
    expect(result.images).toHaveLength(1);
    expect(events).toEqual(['close', 'release']);
  });

  it('says when the saved copy has no sound', async () => {
    page({ serve: 'picture.mp4' });
    const { body } = await inspect({ url: PAGE, sample_times: [1] });
    expect(body).toMatchObject({ ok: true, message: `No sound track was found for this video on the page, so the saved copy is silent. ${NOTES}` });
  });

  it('refuses a call that names both sources, neither, or a link that is not a plain web address, before any page opens', async () => {
    page({ serve: 'both.mp4' });
    expect((await inspect({ url: PAGE, input_path: 'clip.mp4' })).body).toMatchObject({ ok: false, errorCode: 'E_REFERENCE_INPUT', message: 'Pass input_path or url, not both.' });
    expect((await inspect({})).body).toMatchObject({ ok: false, errorCode: 'E_REFERENCE_INPUT', message: 'input_path or url is required.' });
    for (const url of ['file:///etc/hosts', 'https://user:secret@www.example-video.test/v/1', 'javascript:alert(1)']) {
      expect((await inspect({ url })).body).toMatchObject({ ok: false, errorCode: 'E_REFERENCE_INPUT', message: 'url must be a credential-free http(s) address.' });
    }
    expect(browserState.calls).toBe(0);
  });

  it('asks for the file instead when this task has no browser', async () => {
    const text = 'The built-in browser is not available in this task, so the page was not opened. Ask the user to save the video and attach it.';
    browserState.runId = undefined;
    page({ serve: 'both.mp4' });
    expect((await inspect({ url: PAGE })).body).toMatchObject({ ok: false, errorCode: 'E_REFERENCE_PAGE_UNAVAILABLE', message: text });
    expect(browserState.calls).toBe(0);
    browserState.runId = 'run-1';
    browserState.browser = null;
    expect((await inspect({ url: PAGE })).body).toMatchObject({ ok: false, errorCode: 'E_REFERENCE_PAGE_UNAVAILABLE', message: text });
  });

  it('leaves a page with no playing video open and says how the user can help', async () => {
    const events = page({ video: null });
    const { body } = await inspect({ url: PAGE });
    expect(body).toMatchObject({ ok: false, errorCode: 'E_REFERENCE_PAGE_NO_VIDEO',
      message: 'No video started playing on www.example-video.test. The page stays open in the Browser panel: if it asks the user to sign in or pass a check, ask them to do that there, then call again. Otherwise ask them to save the video and attach it.' });
    expect(events).toEqual(['keep', 'release']);
    expect(fs.readdirSync(referencesDir())).toEqual([]);
  }, 40_000);

  it('names why the playing video could not be saved', async () => {
    const cases = [
      ['effect-free.mp4', 'no file on the page matched its length'],
      ['refuse', 'the site refused the download'],
      ['huge', 'it is larger than 256 MiB'],
    ] as const;
    fs.copyFileSync(path.join(fixtures, 'both.mp4'), path.join(fixtures, 'effect-free.mp4'));
    for (const [serve, reason] of cases) {
      page({ video: serve === 'effect-free.mp4' ? { durationSec: 9, src: '' } : undefined, serve });
      const { body } = await inspect({ url: PAGE });
      expect(body, serve).toMatchObject({ ok: false, errorCode: 'E_REFERENCE_PAGE_NOT_SAVED',
        message: `The video playing on www.example-video.test could not be saved: ${reason}. Ask the user to save it and attach it.` });
      expect(fs.readdirSync(referencesDir())).toEqual([]);
    }
  });
});
