import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { trustedIpcSender } from '../../helpers/trusted-ipc-sender';

// Which conversations see a canvas. Workspace folders are named lazily and can repeat between
// conversations that have not produced a file yet, so a chat that never used VideoStudio must
// not list what is in its folder, or take a folder name just by being opened.

vi.mock('electron', () => ({
  app: { isPackaged: false },
  ipcMain: { handle: vi.fn(), on: vi.fn() },
  dialog: { showOpenDialog: vi.fn(async () => ({ canceled: true, filePaths: [] })), showSaveDialog: vi.fn() },
  BrowserWindow: { getAllWindows: vi.fn(() => []), getFocusedWindow: vi.fn(() => null) },
  shell: { showItemInFolder: vi.fn(), openPath: vi.fn(async () => '') },
  systemPreferences: { getMediaAccessStatus: vi.fn(() => 'granted'), askForMediaAccess: vi.fn(async () => true) },
}));

// The real renderer does not run here: a render stays busy until it is stopped.
const renders = vi.hoisted(() => ({ signals: [] as AbortSignal[] }));
vi.mock('../../../src/main/features/video_timeline_render', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/main/features/video_timeline_render')>();
  return {
    ...actual,
    renderVideoTimeline: vi.fn(({ signal }: { signal: AbortSignal }) => {
      renders.signals.push(signal);
      return new Promise((resolve) => {
        signal.addEventListener('abort', () => resolve({ ok: false, op: 'video.render', errorCode: 'E_RENDER_ABORTED', message: 'aborted' }));
      });
    }),
  };
});

const TEST_UID = 'uVideoCanvasIpc';
const VIDEO_STUDIO = '79df9cc89f5f';
let tmpDir: string;
let prevWs: string | undefined;

async function invoke(channel: string, payload: unknown): Promise<any> {
  const electron = await import('electron') as any;
  const { register } = await import('../../../src/main/ipc/index');
  register();
  const handler = electron.ipcMain.handle.mock.calls.find(([name]: [string]) => name === 'orkas.invoke');
  return handler[1]({ sender: trustedIpcSender() }, { channel, payload });
}

async function conversation(): Promise<string> {
  const chats = await import('../../../src/main/features/chats');
  return (await chats.createConversation(TEST_UID, { title: 'Prepare something' })).conversation_id;
}

async function videoStudioSpokeIn(cid: string): Promise<void> {
  const chats = await import('../../../src/main/features/chats');
  await chats.bumpConversationActivity(TEST_UID, cid, new Date().toISOString(), { senderKind: 'agent', senderId: VIDEO_STUDIO });
}

/** The video went out once, so an Update has something to compare with. */
function wentOut(production: string): void {
  fs.writeFileSync(path.join(production, 'versions.json'), JSON.stringify({ versions: [{ id: 'v1', video_id: 'main', path: 'versions/v1.mp4', sha256: 'x' }] }));
}

function seedProduction(workspace: string): void {
  const video = path.join(workspace, 'ad', 'videos', 'main');
  fs.mkdirSync(video, { recursive: true });
  fs.writeFileSync(path.join(video, 'manifest.json'), JSON.stringify({
    schema_version: 3,
    id: 'main',
    label: 'Main',
    canvas: { width: 64, height: 64, fps: 10 },
    scenes: [{ id: 'one', duration: 1 }],
  }));
}

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-video-canvas-ipc-'));
  prevWs = process.env.ORKAS_WORKSPACE_ROOT;
  process.env.ORKAS_WORKSPACE_ROOT = tmpDir;
  vi.resetModules();
  vi.clearAllMocks();
  renders.signals.length = 0;
  (await import('../../../src/main/features/users')).activateUser(TEST_UID);
});

afterEach(async () => {
  (await import('../../../src/main/features/video_canvas_jobs')).resetVideoCanvasJobsForTest();
  if (prevWs === undefined) delete process.env.ORKAS_WORKSPACE_ROOT;
  else process.env.ORKAS_WORKSPACE_ROOT = prevWs;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('videoCanvas.read', () => {
  it('shows nothing in a conversation VideoStudio never joined, and takes no folder name', async () => {
    const cid = await conversation();

    const result = await invoke('videoCanvas.read', { cid });

    expect(result).toMatchObject({ ok: true, video_studio: false, productions: [], jobs: [] });
    const { readState } = await import('../../../src/main/features/group_chat/state');
    expect((await readState(TEST_UID, cid)).workspace_dir).toBeFalsy();
  });

  it('does not list another conversation\'s production when the folder name repeats', async () => {
    const chatOnly = await conversation();
    const video = await conversation();
    await videoStudioSpokeIn(video);
    const { setWorkspaceDirOnce } = await import('../../../src/main/features/group_chat/state');
    await setWorkspaceDirOnce(TEST_UID, chatOnly, 'chat-same');
    await setWorkspaceDirOnce(TEST_UID, video, 'chat-same');
    const { getConversationWorkspacePath } = await import('../../../src/main/features/group_chat/conv_workspace');
    seedProduction(await getConversationWorkspacePath(TEST_UID, video));

    expect((await invoke('videoCanvas.read', { cid: chatOnly })).productions).toEqual([]);
    expect((await invoke('videoCanvas.read', { cid: video })).productions.map((item: { dir: string }) => item.dir)).toEqual(['ad']);
  });

  it('opens for VideoStudio even with nothing made yet', async () => {
    const cid = await conversation();
    await videoStudioSpokeIn(cid);

    expect(await invoke('videoCanvas.read', { cid })).toMatchObject({ ok: true, video_studio: true, productions: [] });
  });

  it('refuses an invalid conversation', async () => {
    await expect(invoke('videoCanvas.read', { cid: '../nope' })).resolves.toMatchObject({ ok: false });
  });
});

describe('videoCanvas.saveCopy', () => {
  it('refuses a file outside the production', async () => {
    const cid = await conversation();
    await videoStudioSpokeIn(cid);
    const { getConversationWorkspacePath } = await import('../../../src/main/features/group_chat/conv_workspace');
    const workspace = await getConversationWorkspacePath(TEST_UID, cid);
    seedProduction(workspace);
    const outside = path.join(tmpDir, 'private.mp4');
    fs.writeFileSync(outside, 'bytes');

    expect(await invoke('videoCanvas.saveCopy', { cid, dir: 'ad', file: outside, name: 'x' })).toEqual({ ok: false, code: 'not_found' });
    const electron = await import('electron') as any;
    expect(electron.dialog.showSaveDialog).not.toHaveBeenCalled();
  });
});

describe('another take of a shot, from the panel', () => {
  // Decided 2026-11-09: a take put into the videos from the shot's panel waits for the user's
  // Update instead of rendering, and the panel sends the user's words and service with a redo.
  async function seeded(): Promise<{ cid: string; production: string }> {
    const cid = await conversation();
    await videoStudioSpokeIn(cid);
    const { getConversationWorkspacePath } = await import('../../../src/main/features/group_chat/conv_workspace');
    const production = path.join(await getConversationWorkspacePath(TEST_UID, cid), 'ad');
    fs.mkdirSync(path.join(production, 'gen'), { recursive: true });
    fs.writeFileSync(path.join(production, 'gen', 'take-1.png'), 'bytes');
    fs.writeFileSync(path.join(production, 'gen', 'take-2.png'), 'bytes');
    fs.writeFileSync(path.join(production, 'assets.json'), JSON.stringify({ assets: [
      { id: 'take-1', kind: 'image', label: 'Shot', path: 'gen/take-1.png', origin: 'generated', shot: 'shot', request: { prompt: 'a lamp' } },
      { id: 'take-2', kind: 'image', label: 'Shot', path: 'gen/take-2.png', origin: 'generated', shot: 'shot' },
    ] }));
    const video = path.join(production, 'videos', 'main');
    fs.mkdirSync(video, { recursive: true });
    fs.writeFileSync(path.join(video, 'manifest.json'), JSON.stringify({
      schema_version: 3,
      id: 'main',
      label: 'Main',
      canvas: { width: 64, height: 64, fps: 10 },
      scenes: [{ id: 'one', clips: [{ id: 'c1', asset: 'take-1', in: 0, dur: 1 }] }],
    }));
    wentOut(production);
    return { cid, production };
  }

  it('puts another take in the video and leaves the video for the user to update', async () => {
    const { cid, production } = await seeded();

    expect(await invoke('videoCanvas.edit', { cid, dir: 'ad', edit: { kind: 'use_result', asset: 'take-2' } }))
      .toEqual({ ok: true, changed_videos: ['main'] });

    expect(JSON.parse(fs.readFileSync(path.join(production, 'videos', 'main', 'manifest.json'), 'utf8')).scenes[0].clips[0].asset).toBe('take-2');
    const read = await invoke('videoCanvas.read', { cid });
    expect(read.jobs).toEqual([]);
    expect(renders.signals).toHaveLength(0);
    expect(await invoke('videoCanvas.render', { cid, dir: 'ad', video: 'main' })).toEqual({ ok: true });
    await vi.waitFor(() => expect(renders.signals).toHaveLength(1));
  });

  it('offers the services for a take, and refuses empty words before pricing anything', async () => {
    const { cid } = await seeded();

    expect(await invoke('videoCanvas.redoOptions', { cid, dir: 'ad', asset: 'take-1' })).toEqual({ ok: true, choices: [], current: '' });
    expect(await invoke('videoCanvas.redoOptions', { cid, dir: 'ad', asset: 'missing' })).toEqual({ ok: false, code: 'not_found' });
    expect(await invoke('videoCanvas.redo', { cid, dir: 'ad', asset: 'take-1', prompt: '   ', choice: '' })).toEqual({ ok: false, code: 'invalid' });
    expect((await invoke('videoCanvas.read', { cid })).jobs).toEqual([]);
  });

  // Decided 2026-11-10 (plan 27.20): the panel sends the footage the user added, and how the take is made.
  it('passes on the footage added to a take, and refuses frames for a still', async () => {
    const { cid } = await seeded();

    expect(await invoke('videoCanvas.redoOptions', { cid, dir: 'ad', asset: 'take-1', inputs: { added: ['take-2'] } })).toEqual({ ok: true, choices: [], current: '' });
    expect(await invoke('videoCanvas.redoOptions', { cid, dir: 'ad', asset: 'take-1', inputs: { method: 'frames' } })).toEqual({ ok: false, code: 'invalid' });
    expect(await invoke('videoCanvas.quoteRedo', { cid, dir: 'ad', asset: 'take-1', choice: '', inputs: { added: ['missing'] } })).toEqual({ ok: false, code: 'invalid' });
    expect(await invoke('videoCanvas.redo', { cid, dir: 'ad', asset: 'take-1', prompt: 'a lamp', choice: '', inputs: { added: ['missing'] } })).toEqual({ ok: false, code: 'invalid' });
    expect((await invoke('videoCanvas.read', { cid })).jobs).toEqual([]);
  });

  // Decided 2026-11-10 (plan 27.21): and the settings the user picked, which main checks.
  it('passes on the settings picked for a take', async () => {
    const { cid } = await seeded();

    expect(await invoke('videoCanvas.redoOptions', { cid, dir: 'ad', asset: 'take-1', settings: { duration: 'ten' } })).toEqual({ ok: false, code: 'invalid' });
    expect(await invoke('videoCanvas.quoteRedo', { cid, dir: 'ad', asset: 'take-1', choice: '', settings: { resolution: '9000p' } })).toEqual({ ok: false, code: 'invalid' });
    expect(await invoke('videoCanvas.redo', { cid, dir: 'ad', asset: 'take-1', prompt: 'a lamp', choice: '', settings: { audio: 'yes' } })).toEqual({ ok: false, code: 'invalid' });
    expect(await invoke('videoCanvas.redoOptions', { cid, dir: 'ad', asset: 'take-1', settings: { duration: 10, audio: true } })).toEqual({ ok: true, choices: [], current: '' });
    expect((await invoke('videoCanvas.read', { cid })).jobs).toEqual([]);
  });
});

describe('a new shot drawn from footage', () => {
  // Decided 2026-11-10 (plan 27.20): drafts live in canvas.json until generated, as TapNow's new nodes do.
  async function seeded(): Promise<{ cid: string; production: string }> {
    const cid = await conversation();
    await videoStudioSpokeIn(cid);
    const { getConversationWorkspacePath } = await import('../../../src/main/features/group_chat/conv_workspace');
    const production = path.join(await getConversationWorkspacePath(TEST_UID, cid), 'ad');
    fs.mkdirSync(path.join(production, 'media'), { recursive: true });
    fs.writeFileSync(path.join(production, 'media', 'photo.png'), 'bytes');
    fs.writeFileSync(path.join(production, 'assets.json'), JSON.stringify({ assets: [
      { id: 'photo', kind: 'image', label: 'Photo', path: 'media/photo.png', origin: 'upload' },
    ] }));
    return { cid, production };
  }

  it('makes, changes and removes one, and prices nothing without words', async () => {
    const { cid, production } = await seeded();

    const made = await invoke('videoCanvas.draft', { cid, dir: 'ad', change: { kind: 'create', type: 'image', inputs: ['photo'], at: { x: 300, y: 40 } } });
    expect(made).toMatchObject({ ok: true, id: expect.any(String) });
    expect((await invoke('videoCanvas.read', { cid })).productions[0].drafts).toEqual([
      expect.objectContaining({ key: `draft:${made.id}`, kind: 'image', inputs: [expect.objectContaining({ asset_id: 'photo' })] }),
    ]);
    expect(await invoke('videoCanvas.draftOptions', { cid, dir: 'ad', id: made.id })).toEqual({ ok: true, kind: 'image', choices: [], current: '' });
    expect(await invoke('videoCanvas.generateDraft', { cid, dir: 'ad', id: made.id })).toEqual({ ok: false, code: 'invalid' });
    expect(await invoke('videoCanvas.quoteDraft', { cid, dir: 'ad', id: 'missing' })).toEqual({ ok: false, code: 'not_found' });

    expect(await invoke('videoCanvas.draft', { cid, dir: 'ad', change: { kind: 'update', id: made.id, prompt: 'a brass lamp' } })).toEqual({ ok: true, id: made.id });
    expect((await invoke('videoCanvas.read', { cid })).productions[0].drafts[0].prompt).toBe('a brass lamp');
    expect(await invoke('videoCanvas.draft', { cid, dir: 'ad', change: { kind: 'remove', id: made.id } })).toEqual({ ok: true, id: made.id });
    expect((await invoke('videoCanvas.read', { cid })).productions[0].drafts).toEqual([]);
    expect(JSON.parse(fs.readFileSync(path.join(production, 'canvas.json'), 'utf8'))).toEqual({ cards: {} });
    expect(await invoke('videoCanvas.draft', { cid, dir: 'ad', change: { kind: 'paint' } })).toEqual({ ok: false, code: 'invalid' });
  });
});

describe('a change to a video', () => {
  // Decided 2026-11-09: every change waits for the user's Update, as a product fact or a new take
  // does, and stops an update in progress, whose file would no longer match.
  async function seeded(went = true): Promise<{ cid: string; video: string }> {
    const cid = await conversation();
    await videoStudioSpokeIn(cid);
    const { getConversationWorkspacePath } = await import('../../../src/main/features/group_chat/conv_workspace');
    const production = path.join(await getConversationWorkspacePath(TEST_UID, cid), 'ad');
    const video = path.join(production, 'videos', 'main');
    fs.mkdirSync(video, { recursive: true });
    fs.writeFileSync(path.join(video, 'manifest.json'), JSON.stringify({
      schema_version: 3,
      id: 'main',
      label: 'Main',
      canvas: { width: 64, height: 64, fps: 10 },
      scenes: [{ id: 'one', duration: 1, text: { headline: { value: 'A bright idea' } } }],
    }));
    if (went) wentOut(production);
    return { cid, video };
  }
  const update = (cid: string) => invoke('videoCanvas.render', { cid, dir: 'ad', video: 'main' });
  const setWords = (cid: string, value: string) => invoke('videoCanvas.edit', {
    cid,
    dir: 'ad',
    edit: { kind: 'set_text', video: 'main', scene: 'one', slot: 'headline', value },
  });

  it('saves it and leaves the video for the user to update, with no render', async () => {
    const { cid, video } = await seeded();

    expect(await setWords(cid, 'Light your desk')).toEqual({ ok: true, changed_videos: ['main'] });

    expect(JSON.parse(fs.readFileSync(path.join(video, 'manifest.json'), 'utf8')).scenes[0].text.headline.value).toBe('Light your desk');
    const read = await invoke('videoCanvas.read', { cid });
    expect(read.jobs).toEqual([]);
    // Longer than a change used to wait before rendering by itself.
    await new Promise((resolve) => { setTimeout(resolve, 1000); });
    expect(renders.signals).toHaveLength(0);
    expect(await update(cid)).toEqual({ ok: true });
    await vi.waitFor(() => expect(renders.signals).toHaveLength(1));
  });

  // Decided 2026-11-11: Update stays on the card, and one with nothing to show renders nothing.
  it('renders nothing when the video already shows its timeline, or the change was taken back', async () => {
    const { cid } = await seeded();

    expect(await update(cid)).toEqual({ ok: true, unchanged: true });
    expect(await setWords(cid, 'Light your desk')).toMatchObject({ ok: true });
    expect(await setWords(cid, 'A bright idea')).toMatchObject({ ok: true });
    expect(await update(cid)).toEqual({ ok: true, unchanged: true });

    const read = await invoke('videoCanvas.read', { cid });
    expect(read.jobs).toEqual([]);
    expect(renders.signals).toHaveLength(0);
  });

  it('renders a video that never went out', async () => {
    const { cid } = await seeded(false);

    expect(await update(cid)).toEqual({ ok: true });

    await vi.waitFor(() => expect(renders.signals).toHaveLength(1));
  });

  it('refuses a video or a production that is not one, with no render', async () => {
    const { cid } = await seeded();

    expect(await invoke('videoCanvas.render', { cid, dir: 'ad', video: '../main' })).toEqual({ ok: false, code: 'not_found' });
    expect(await invoke('videoCanvas.render', { cid, dir: '../elsewhere', video: 'main' })).toEqual({ ok: false, code: 'not_found' });

    expect((await invoke('videoCanvas.read', { cid })).jobs).toEqual([]);
    expect(renders.signals).toHaveLength(0);
  });

  it('stops an update in progress, and the user can start it again', async () => {
    const { cid } = await seeded();
    expect(await setWords(cid, 'Light your desk')).toMatchObject({ ok: true });
    expect(await update(cid)).toEqual({ ok: true });
    await vi.waitFor(() => expect(renders.signals).toHaveLength(1));

    expect(await setWords(cid, 'Light up your desk')).toMatchObject({ ok: true });

    expect(renders.signals[0].aborted).toBe(true);
    const read = await invoke('videoCanvas.read', { cid });
    expect(read.jobs).toEqual([]);
    expect(await update(cid)).toEqual({ ok: true });
    await vi.waitFor(() => expect(renders.signals).toHaveLength(2));
  });
});
