// Real canvas -> tool -> configured provider protocol -> durable request and asset records.
// Network and page rendering are controlled; media bytes, reference reuse, admission,
// physical outputs, failures and explicit retries use the actual public implementations.
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  localRoot: '',
  workspace: '',
  quote: {} as Record<string, unknown>,
  render: vi.fn(),
  ship: vi.fn(),
}));

vi.mock('../../../src/main/features/users', () => ({
  hasActiveUser: () => true, getActiveUserId: () => 'u_1',
}));

vi.mock('../../../src/main/features/auth', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  loadVideoProfiles: () => [{id:'native',provider:'doubao',model:'doubao-seedance-2-0-260128',apiKey:'fixture-key'}],
  saveVideoProfiles: () => {},
}));
vi.mock('../../../src/main/features/video_production_services', () => ({
 checkVideoProductionServices:async()=>h.quote,
}));
vi.mock('../../../src/main/paths', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  userLocalRoot: () => h.localRoot,
}));
vi.mock('../../../src/main/features/user_workspace', () => ({
  getWorkspacePath: () => h.workspace,
}));
vi.mock('../../../src/main/util/project-layout', () => ({
  chatAttachmentDirForConversation: () => path.join(h.workspace, '.attachments'),
}));
vi.mock('../../../src/main/features/group_chat/conv_workspace', () => ({
  getConversationWorkspacePath: async () => h.workspace,
}));
vi.mock('../../../src/main/features/video_timeline_render', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  renderVideoTimeline: h.render,
}));
vi.mock('../../../src/main/features/video_timeline_ship', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  shipVideoFile: h.ship,
}));

const UID = 'u_1';
const CID = 'c1';
const CTX = { uid: UID, cid: CID, dir: 'ad' };

let realClip: Buffer;
let realPhoto: Buffer;

beforeAll(async () => {
  const { bundledFfmpegPaths } = await import('../../../src/main/util/bundled-runtime');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-redo-clip-'));
  const file = path.join(dir, 'clip.mp4');
  execFileSync(bundledFfmpegPaths().ffmpeg as string, [
    '-y', '-hide_banner', '-loglevel', 'error',
    '-f', 'lavfi', '-i', 'testsrc=size=64x64:rate=10:duration=2',
    '-pix_fmt', 'yuv420p', file,
  ]);
  realClip = fs.readFileSync(file);
  const still = path.join(dir, 'photo.png');
  execFileSync(bundledFfmpegPaths().ffmpeg as string, [
    '-y', '-hide_banner', '-loglevel', 'error',
    '-f', 'lavfi', '-i', 'testsrc=size=640x640:rate=1:duration=1', '-frames:v', '1', still,
  ]);
  realPhoto = fs.readFileSync(still);
  fs.rmSync(dir, { recursive: true, force: true });
});

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const configured=()=>({sufficient:true,external_billing_estimate_available:false,externally_billed_segment_ids:['request'],unavailable_segment_ids:[],segments:[]});

function stubProvider(behavior: { download?: (attempt: number) => Response | null } = {}) {
  const counts = { creates: 0, downloads: 0, created: [] as Array<Record<string, unknown>> };
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (url.startsWith('https://video.example/')) {
      counts.downloads += 1;
      return behavior.download?.(counts.downloads) ?? new Response(new Uint8Array(realClip));
    }
    if (url.endsWith('/api/v3/contents/generations/tasks')) {
      counts.creates+=1;counts.created.push(JSON.parse(String(init?.body??'{}')));
      return json({id:`task-${counts.creates}`});
    }
    if (url.includes('/api/v3/contents/generations/tasks/')) {
      return json({status:'succeeded',content:{video_url:'https://video.example/x'}});
    }
    throw new Error(`unexpected fetch ${url}`);
  }));
  return counts;
}

const production = () => path.join(h.workspace, 'ad');
const manifestOf = (id = 'main') => JSON.parse(fs.readFileSync(path.join(production(), 'videos', id, 'manifest.json'), 'utf8'));
const ledgerOf = () => JSON.parse(fs.readFileSync(path.join(production(), 'assets.json'), 'utf8')).assets;
const budget = () => import('../../../src/main/features/video_production_budget');
const spending = async () => (await budget()).productionRequestStatus({ userId: UID, scope: CID });
const events = () => import('../../../src/main/features/video_canvas_jobs');

function writeVideo(id: string, asset: string): void {
  const dir = path.join(production(), 'videos', id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({
    schema_version: 3,
    id,
    label: `Video ${id}`,
    canvas: { width: 64, height: 64, fps: 10 },
    scenes: [{ id: 'one', clips: [{ id: 'c1', asset, in: 0, dur: 2 }] }],
  }));
}

/** A real generated shot, referencing an existing public URL for its local photo. */
async function agentMakesShot(): Promise<string> {
  const photo = path.join(production(), 'media', 'photo.png');
  fs.mkdirSync(path.dirname(photo), { recursive: true });
  fs.writeFileSync(photo, realPhoto);
  (await import('../../../src/main/features/generation_reference_assets')).registerGeneratedMediaUrl(photo,'https://uploads.example/photo.png');
  const { recordProductionAsset } = await import('../../../src/main/features/video_production_spend');
  await recordProductionAsset({ productionDirAbs: production(), fileAbs: photo, record: { kind: 'image', label: 'Photo', origin: 'upload' } });
  const { createVideoGenTool } = await import('../../../src/main/model/core-agent/video-gen-tool');
  const tool = createVideoGenTool({ userId: UID, cid: CID, agentId: '79df9cc89f5f', agentName: 'VideoStudio' });
  const result = await tool.execute({
    prompt: 'Juice pours in slow motion',
    output_path: 'ad/shots/pour.mp4',
    production_dir: 'ad',
    shot: 'pour',
    label: 'Pour',
    duration: 5,
    ratio: '9:16',
    reference_image_paths: ['ad/media/photo.png'],
  }, { workingDir: h.workspace, state: {} });
  expect(result.isError, String(result.content)).toBeFalsy();
  const [firstLine] = String(result.content).split('\n');
  return JSON.parse(firstLine).asset_id;
}

function collectEvents(listen: (next: (event: any) => void) => void): any[] {
  const seen: any[] = [];
  listen((event) => seen.push(event));
  return seen;
}

async function until(condition: () => boolean, label: string, timeoutMs = 15000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolve) => { setTimeout(resolve, 5); });
  }
}

beforeEach(() => {
  h.localRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-redo-local-'));
  process.env.ORKAS_WORKSPACE_ROOT=h.localRoot;
  h.workspace = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-redo-ws-')));
  fs.mkdirSync(path.join(h.workspace, 'ad', 'shots'), { recursive: true });
  h.quote = configured();
  h.render.mockReset();
  h.ship.mockReset();
  h.render.mockResolvedValue({ ok: true, op: 'video.render' });
  h.ship.mockResolvedValue({ ok: true, op: 'video.ship', version: { id: 'v2' } });
});

afterEach(async () => {
  (await events()).resetVideoCanvasJobsForTest();
  (await import('../../../src/main/features/user-switch-hooks')).notifyUserSwitch(UID, 'next-user');
  vi.unstubAllGlobals();
  vi.resetModules();
  fs.rmSync(h.localRoot, { recursive: true, force: true });
  fs.rmSync(h.workspace, { recursive: true, force: true });
  delete process.env.ORKAS_WORKSPACE_ROOT;
});

describe('a shot the Agent made', () => {
  it('keeps the call that made it, and what it was made from', async () => {
    stubProvider();
    const assetId = await agentMakesShot();

    const row = ledgerOf().find((item: { id: string }) => item.id === assetId);
    expect(row.request).toMatchObject({ prompt: 'Juice pours in slow motion', duration: 5, reference_image_paths: ['ad/media/photo.png'] });
    expect(row.refs).toEqual([{ asset: 'photo', role: 'reference' }]);
  });

  it('shows on the canvas as something that can be made again, drawn from its photo', async () => {
    stubProvider();
    const assetId = await agentMakesShot();
    writeVideo('main', assetId);

    const { readVideoCanvasProductions } = await import('../../../src/main/features/video_canvas');
    const [canvas] = await readVideoCanvasProductions(UID, CID);

    expect(canvas.shots[0]).toMatchObject({ key: 'shot:pour', uses: ['asset:photo'] });
    expect(canvas.videos[0].scenes[0]).toMatchObject({ asset_id: assetId, source: 'shot:pour', redoable: true });
  });
});

describe('making it again from the canvas', () => {
  it('creates one new request, keeps the old shot, and puts the new one where the shot was shown without rendering', async () => {
    const counts = stubProvider();
    const assetId = await agentMakesShot();
    writeVideo('main', assetId);
    writeVideo('other', assetId);
    // Both went out with the old take.
    fs.writeFileSync(path.join(production(), 'versions.json'), JSON.stringify({ versions: ['main', 'other'].map((id) => ({ id: `${id}-v1`, video_id: id, path: `versions/${id}-v1.mp4`, sha256: 'x' })) }));
    const { videoUpToDate } = await import('../../../src/main/features/video_canvas');
    const upToDate = () => Promise.all(['main', 'other'].map((id) => videoUpToDate(production(), id)));
    expect(await upToDate()).toEqual([true, true]);
    const oldFile = path.join(production(), 'shots', 'pour.mp4');
    const oldBytes = fs.readFileSync(oldFile);
    const jobs = await events();
    const seen = collectEvents(jobs.onVideoCanvasJob);

    // One explicit redo adds one actual configured-service request.
    expect(await spending()).toEqual({ completed: 1, pending: 0 });
    expect(await jobs.startVideoCanvasRedo({ ctx: CTX, asset: assetId, isBusy: () => false })).toEqual({ ok: true });
    await until(() => seen.some((event) => event.kind === 'redo' && event.status === 'done'), 'the redo');

    expect(counts.creates).toBe(2);
    expect(await spending()).toEqual({ completed: 2, pending: 0 });
    expect(fs.readFileSync(oldFile).equals(oldBytes)).toBe(true);

    const rows = ledgerOf().filter((row: { shot?: string }) => row.shot === 'pour');
    expect(rows).toHaveLength(2);
    const [, fresh] = rows;
    expect(fresh.id).not.toBe(assetId);
    expect(fresh.path).toMatch(/^shots\/pour-redo-\d+\.mp4$/);
    expect(fs.existsSync(path.join(production(), fresh.path))).toBe(true);
    expect(fresh.request.prompt).toBe('Juice pours in slow motion');

    expect(manifestOf('main').scenes[0].clips[0]).toMatchObject({ id: 'c1', asset: fresh.id });
    expect(manifestOf('other').scenes[0].clips[0]).toMatchObject({ id: 'c1', asset: fresh.id });
    expect(seen.find((event) => event.kind === 'redo' && event.status === 'done')).toMatchObject({ shot: 'shot:pour', asset_id: fresh.id, swapped: true });
    expect(h.render).not.toHaveBeenCalled();
    // The user's Update renders them, since neither shows what it went out with any more.
    expect(await upToDate()).toEqual([false, false]);
  });

  

  it('makes a new shot each time rather than handing back the last one', {timeout:60000}, async () => {
    const counts = stubProvider();
    const assetId = await agentMakesShot();
    writeVideo('main', assetId);
    const jobs = await events();
    const seen = collectEvents(jobs.onVideoCanvasJob);
    const redos = () => seen.filter((event) => event.kind === 'redo' && event.status === 'done');

    await jobs.startVideoCanvasRedo({ ctx: CTX, asset: assetId, isBusy: () => false });
    await until(() => redos().length === 1, 'the first redo');
    await new Promise((resolve) => { setTimeout(resolve, 2); });
    await jobs.startVideoCanvasRedo({ ctx: CTX, asset: redos()[0].asset_id, isBusy: () => false });
    await until(() => redos().length === 2, 'the second redo');

    expect(counts.creates).toBe(3);
    expect(new Set(ledgerOf().map((row: { path: string }) => row.path)).size).toBe(4);
    expect(await spending()).toEqual({ completed: 3, pending: 0 });
  });

  it('blocks an unresolved accepted request after its download fails, without issuing another generation', {timeout:60000}, async()=>{
 let downloadsWork=true;
 const counts=stubProvider({download:()=>downloadsWork?null:new Response('gone',{status:500})});
 const assetId=await agentMakesShot();writeVideo('main',assetId);
 const oldPath=path.join(production(),'shots','pour.mp4');const oldBytes=fs.readFileSync(oldPath);
 const jobs=await events();const seen=collectEvents(jobs.onVideoCanvasJob);downloadsWork=false;
 expect(await jobs.startVideoCanvasRedo({ctx:CTX,asset:assetId,isBusy:()=>false})).toEqual({ok:true});
 await until(()=>seen.some(event=>event.kind==='redo'&&event.status==='failed'),'the failed download',30000);
 expect(counts.creates).toBe(2);downloadsWork=true;
 expect(await jobs.quoteVideoCanvasRedo(CTX,assetId)).toEqual({ok:false,code:'in_progress'});
 expect(await jobs.startVideoCanvasRedo({ctx:CTX,asset:assetId,prompt:'new words',isBusy:()=>false})).toEqual({ok:false,code:'in_progress'});
 expect(counts.creates).toBe(2);expect(await spending()).toEqual({completed:1,pending:1});
 expect(manifestOf().scenes[0].clips[0].asset).toBe(assetId);expect(fs.readFileSync(oldPath)).toEqual(oldBytes);
 expect(ledgerOf().filter(row=>row.shot==='pour')).toHaveLength(1);
});

  it('releases an undispatched reference failure and permits an explicit retry once the real reference URL is restored',async()=>{
 const counts=stubProvider();const assetId=await agentMakesShot();writeVideo('main',assetId);
 const jobs=await events();const seen=collectEvents(jobs.onVideoCanvasJob);
 (await import('../../../src/main/features/user-switch-hooks')).notifyUserSwitch(UID,'next-user');
 expect(await jobs.startVideoCanvasRedo({ctx:CTX,asset:assetId,isBusy:()=>false})).toEqual({ok:true});
 await until(()=>seen.some(event=>event.kind==='redo'&&event.status==='failed'),'reference refusal',15000);
 expect(counts.creates).toBe(1);expect(await spending()).toEqual({completed:1,pending:0});
 expect(await jobs.quoteVideoCanvasRedo(CTX,assetId)).toMatchObject({ok:true,sufficient:true,own_key:true});
 (await import('../../../src/main/features/generation_reference_assets')).registerGeneratedMediaUrl(path.join(production(),'media','photo.png'),'https://uploads.example/photo.png');
 expect(await jobs.startVideoCanvasRedo({ctx:CTX,asset:assetId,isBusy:()=>false})).toEqual({ok:true});
 await until(()=>seen.some(event=>event.kind==='redo'&&event.status==='done'),'explicit retry',15000);
 expect(counts.creates).toBe(2);expect(await spending()).toEqual({completed:2,pending:0});
});

  

  it('sends nothing when no configured service is available', async () => {
    const counts = stubProvider();
    const assetId = await agentMakesShot();
    writeVideo('main', assetId);
    h.quote = {...configured(),sufficient:false,externally_billed_segment_ids:[],unavailable_segment_ids:['request']};
    const jobs = await events();

    expect(await jobs.startVideoCanvasRedo({ ctx: CTX, asset: assetId, isBusy: () => false }))
      .toEqual({ok:false,code:'route_unavailable'});

    expect(counts.creates).toBe(1);
    expect(await spending()).toEqual({ completed: 1, pending: 0 });
  });

  it('is not offered for a result from before the call was kept', async () => {
    stubProvider();
    const assetId = await agentMakesShot();
    const ledger = ledgerOf().map(({ request: _request, ...row }: Record<string, unknown>) => row);
    fs.writeFileSync(path.join(production(), 'assets.json'), JSON.stringify({ assets: ledger }));
    writeVideo('main', assetId);

    const { readVideoCanvasProductions } = await import('../../../src/main/features/video_canvas');
    const [canvas] = await readVideoCanvasProductions(UID, CID);
    expect(canvas.videos[0].scenes[0].redoable).toBe(false);
    const jobs = await events();
    expect(await jobs.startVideoCanvasRedo({ ctx: CTX, asset: assetId, isBusy: () => false }))
      .toEqual({ ok: false, code: 'not_found' });
  });

  it('makes it with the words the user changed, on their configured service, and keeps the old words on the old take', async () => {
    const counts = stubProvider();
    const assetId = await agentMakesShot();
    writeVideo('main', assetId);
    const jobs = await events();
    const seen = collectEvents(jobs.onVideoCanvasJob);

    expect(await jobs.videoCanvasRedoOptions(CTX, assetId)).toMatchObject({ ok: true, current: 'native' });
    expect(await jobs.startVideoCanvasRedo({ ctx: CTX, asset: assetId, prompt: 'Juice pours, closer', choice: 'native', isBusy: () => false }))
      .toEqual({ ok: true });
    await until(() => seen.some((event) => event.kind === 'redo' && event.status === 'done'), 'the redo');

    expect(counts.creates).toBe(2);
    expect(counts.created[1]).toMatchObject({content:expect.arrayContaining([{type:'text',text:'Juice pours, closer'}])});
    const [old, fresh] = ledgerOf().filter((row: { shot?: string }) => row.shot === 'pour');
    expect(old.request.prompt).toBe('Juice pours in slow motion');
    expect(fresh).toMatchObject({ prompt: 'Juice pours, closer', request: { prompt: 'Juice pours, closer' } });
    expect(manifestOf('main').scenes[0].clips[0].asset).toBe(fresh.id);
  });
});
