import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { createHash } from 'node:crypto';
import { drainMainRuntimeForTest } from '../../helpers/drain-main-runtime';
import type { TaskDependencies } from '../../../src/main/features/web_apps/tasks';

let root: string, previous: string | undefined;
const runs = vi.hoisted(() => ({ calls: [] as any[], frames: 0, artifactDelivery: '', oversizedIntermediate: false, textOnly: false, hold: false, unresolved: false, pending: [] as Array<{stateAbsPath:string;transactionId:string}>, question: false, form: false, formFile: false, failure:false, fixture: undefined as undefined | {name:string;bytes:string;text:string}, release: undefined as undefined | (() => void) }));
vi.mock('../../../src/main/model/client', () => ({
  async *streamChatWithModel(opts: any) {
    runs.calls.push({ cid: opts.cid, message: opts.message, workingDir: opts.workingDir, systemPrompt: opts.systemPrompt });
    if (runs.hold) await new Promise<void>(resolve => { runs.release = resolve; });
    if(runs.failure){yield{type:'error',text:'The selected service is unavailable. Choose another service and try again.',failureKind:'config',failureCode:'fixture_terminal_failure'};yield{type:'done'};return;}
    await fs.mkdir(opts.workingDir, { recursive: true });
    if (runs.artifactDelivery) {
      const dir = path.join(path.dirname(opts.workingDir), 'artifacts', 'bundle');
      await fs.mkdir(dir, { recursive: true });
      for (let first = 0; first < 1001; first += 32) {
        await Promise.all(Array.from({ length: Math.min(32, 1001 - first) }, (_, i) =>
          fs.writeFile(path.join(dir, `render-${first + i}.txt`), 'working file')));
      }
      // Mark the last real directory entry as delivered, independently of filesystem order.
      runs.artifactDelivery = (await fs.readdir(dir, { withFileTypes: true })).at(-1)!.name;
      const final = path.join(dir, runs.artifactDelivery);
      await fs.writeFile(final, 'published artifact');
      await opts.onFileWritten?.(final);
      const unrelated = path.join(path.dirname(opts.workingDir), 'private-fixture.txt');
      await fs.writeFile(unrelated, 'private fixture');
      await opts.onFileWritten?.(unrelated);
    } else if (!runs.textOnly) {
      const file = path.join(opts.workingDir, runs.fixture?.name || 'final.mp4');
      await fs.writeFile(file, runs.fixture ? Buffer.from(runs.fixture.bytes, 'base64') : 'video-' + runs.calls.length);
      await opts.onFileWritten?.(file);
    }
    if (runs.oversizedIntermediate) {
      const { MAX_TEXT_FILE_BYTES } = await import('../../../src/main/util/file-size-limits');
      const draft = path.join(opts.workingDir, 'preview-intermediate.mov');
      await fs.writeFile(draft, '');
      await fs.truncate(draft, MAX_TEXT_FILE_BYTES + 1);
    }
    // Working files a run leaves without delivering them, such as checked frames.
    for (let n = 0; n < runs.frames; n++) {
      await fs.mkdir(path.join(opts.workingDir, 'frames'), { recursive: true });
      await fs.writeFile(path.join(opts.workingDir, 'frames', `frame-${String(n).padStart(3, '0')}.png`), 'frame-' + n);
    }
    if (runs.unresolved) runs.pending.push(await startPendingGeneration(opts.userId, opts.cid, 'pending-one'));
    yield { type: 'final', text: runs.form ? 'Choose a caption.\n<agent-input-form>\n'+JSON.stringify({ fields: [{ id: 'answer', label: 'Caption', type: runs.formFile ? 'file' : 'textarea', required: true }] })+'\n</agent-input-form>' : runs.question ? 'Which caption should I use?\n<plan-interaction status="open" />' : runs.textOnly ? 'I still need the source footage.' : runs.fixture?.text ?? 'Saved video ' + runs.calls.length };
    yield { type: 'done' };
  },
  async chatWithModel() { throw new Error('Unexpected model request'); },
}));
const uid = 'app-owner', key = 'a'.repeat(64);
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'app-agent-owner-'));
  previous = process.env.ORKAS_WORKSPACE_ROOT;
  process.env.ORKAS_WORKSPACE_ROOT = root;
  vi.resetModules();
  runs.calls = []; runs.frames = 0; runs.artifactDelivery = ''; runs.oversizedIntermediate = false; runs.textOnly = false; runs.hold = false; runs.unresolved = false; runs.pending = []; runs.question = false; runs.form = false; runs.formFile = false; runs.failure=false; runs.fixture=undefined; runs.release = undefined;
  (await import('../../../src/main/features/users')).activateUser(uid);
});
afterEach(async () => {
  runs.release?.();
  await (await import('../../../src/main/features/web_apps/task-host')).stopAppTaskMaintenance();
  for (const call of runs.calls) await (await import('../../../src/main/features/group_chat/bus')).dropConv(uid, call.cid);
  (await import('../../../src/main/model/core-agent/bash-permissions'))._resetForTest();
  (await import('../../../src/main/model/core-agent/bash-permissions'))._setBroadcastForTest(null);
  await drainMainRuntimeForTest();
  await (await import('../../../src/main/features/conversation-history-client')).closeConversationHistoryWorker();
  if (previous === undefined) delete process.env.ORKAS_WORKSPACE_ROOT;
  else process.env.ORKAS_WORKSPACE_ROOT = previous;
  await fs.rm(root, { recursive: true, force: true });
});

// Use the production admission writer and reader so this fixture exercises the
// real public generation schema and app-owned path, without a provider call.
async function startPendingGeneration(userId: string, cid: string, requestId: string) {
  const paths = await import('../../../src/main/paths');
  const control = await import('../../../src/main/features/image_production_control');
  const context = paths.appConversationRoot(userId, cid)!;
  const projectDirAbs = path.join(context, 'generation-fixture');
  await fs.mkdir(projectDirAbs, { recursive: true });
  await fs.writeFile(path.join(projectDirAbs, 'image-manifest.json'), JSON.stringify({
    schema_version: 1, route: 'generate', canvas: { width: 1024, height: 1024 },
    brief: { purpose: 'Campaign image', audience: 'Customers', required_copy: [], must_include: [], must_avoid: [] },
    art_direction: {
      subject_world: 'A physical product studio', one_job: 'Show the hero product',
      visual_tradition: 'Editorial still life', composition: 'Centered object with asymmetric negative space',
      signature_device: 'A single cut-paper halo', typography: 'No raster typography',
      color_light_material: 'Soft daylight, warm paper, cobalt accent',
    },
    generation_budget: { max_calls: 2 },
  }));
  const stateAbsPath = control.imageGenerationControlStatePath(userId, projectDirAbs);
  expect(path.dirname(stateAbsPath)).toBe(path.join(context, 'generation'));
  const admitted = await control.beginImageStudioGeneration({ stateAbsPath, projectDirAbs, requestId,
    outputAbsPath: path.join(projectDirAbs, requestId + '.png') });
  expect(admitted.status).toBe('started');
  expect((await control.readImageGenerationControlState(stateAbsPath))?.transactions)
    .toContainEqual(expect.objectContaining({ transaction_id: admitted.transaction.transaction_id, status: 'pending' }));
  return { stateAbsPath, transactionId: admitted.transaction.transaction_id };
}

async function settlePendingGeneration(pending: { stateAbsPath: string; transactionId: string }) {
  const control = await import('../../../src/main/features/image_production_control');
  await control.finishImageStudioGeneration({ ...pending, ok: false, errorCode: 'fixture_terminal_failure' });
  expect((await control.readImageGenerationControlState(pending.stateAbsPath))?.transactions)
    .toContainEqual(expect.objectContaining({ transaction_id: pending.transactionId, status: 'failed' }));
}

async function finish(host: any, requestId: string) {
  const scope = { userId: uid, key, signal: new AbortController().signal };
  let last: any;
  for (let n = 0; n < 100; n++) {
    const result = await host.taskService.call(scope, 'tasks.get', { requestId });
    last = result;
    if (['completed', 'failed', 'stopped'].includes(result.status)) return result;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error('Controlled executor did not settle: ' + JSON.stringify({ status: last?.status, error: last?.error, storageError: last?.storageError }));
}

it.each([false, true])('scopes direct-delivery guidance to one-shot app calls (retain=%s)', async keepSession => {
  const host = await import('../../../src/main/features/web_apps/task-host');
  await host.appTaskCall(uid, key, 'tasks.start', { requestId: 'guidance', title: 'Video', prompt: 'Make video', agentId: 'commander', files: [], keepSession }, new AbortController().signal);
  await finish(host, 'guidance');
  expect(runs.calls[0].systemPrompt.includes('## Application direct delivery')).toBe(!keepSession);
  expect(runs.calls[0].message).toContain('Make video');
  if (!keepSession) {
    const prompt = runs.calls[0].systemPrompt;
    expect(prompt.indexOf('## Application direct delivery')).toBeLessThan(prompt.lastIndexOf('## User language'));
  }
});

it('preserves pending public generation and its partial output when an unexpected one-shot question cannot be answered', async () => {
  runs.question = true; runs.unresolved = true;
  const host = await import('../../../src/main/features/web_apps/task-host'), signal = new AbortController().signal;
  const directory = (await import('../../../src/main/paths')).agentDir(uid, 'a1b2c3d4e5f6');
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(path.join(directory, 'agent.json'), JSON.stringify({ agent_id: 'a1b2c3d4e5f6', name: 'Question fixture', workflow: 'Produce the requested video.', interactive: true, created_at: 't', updated_at: 't' }));
  await host.appTaskCall(uid, key, 'tasks.start', { requestId: 'once-question', title: 'Video', prompt: 'Make video', agentId: 'a1b2c3d4e5f6', files: [] }, signal);
  const bus = await import('../../../src/main/features/group_chat/bus');
  await vi.waitFor(() => { expect(runs.calls).toHaveLength(1); expect(bus.isQuiescent(uid, runs.calls[0].cid)).toBe(true); });
  expect(await host.appTaskCall(uid, key, 'tasks.get', { requestId: 'once-question' }, signal)).toMatchObject({ status: 'running' });
  const cid = runs.calls[0].cid, context = (await import('../../../src/main/paths')).appConversationRoot(uid, cid)!;
  expect((await fs.stat(context)).isDirectory()).toBe(true);
  expect(runs.pending).toHaveLength(1);
  await settlePendingGeneration(runs.pending[0]);
  let result: any;
  await vi.waitFor(async () => { result = await host.appTaskCall(uid, key, 'tasks.get', { requestId: 'once-question' }, signal); expect(result.status).toBe('failed'); });
  expect(result).toMatchObject({ status: 'failed', error: { code: 'E_INTERACTION_REQUIRED' }, files: [{ name: 'final.mp4' }] });
  expect(result.form).toBeUndefined(); expect(result.interactions).toBeUndefined();
  expect(runs.calls).toHaveLength(1);
  await host.maintainAppTasks(); await expect(fs.stat(context)).rejects.toMatchObject({ code: 'ENOENT' });
});

it('denies a one-shot permission through its real owner and never accepts a synthetic app approval', async () => {
  const host = await import('../../../src/main/features/web_apps/task-host'), signal = new AbortController().signal;
  await host.appTaskCall(uid, key, 'tasks.start', { requestId: 'once-permission', title: 'Private', prompt: 'Create', agentId: 'commander', files: [] }, signal);
  await finish(host, 'once-permission');
  const permissions = await import('../../../src/main/model/core-agent/bash-permissions');
  const events = await import('../../../src/main/util/app-task-events');
  permissions._setBroadcastForTest((channel, payload) => events.captureAppTaskEvent(uid, channel, payload));
  const decision = permissions.requestBashDecision({ uid, cid: runs.calls[0].cid, agentId: 'commander', agentName: 'Commander', command: 'sensitive-operation', reasons: ['destructive'] });
  const interaction = events.appTaskInteractions(uid, runs.calls[0].cid)[0];
  await expect(host.taskService.call({ userId: uid, key, signal }, 'tasks.respond', { requestId: 'once-permission', kind: 'bash:permission', interactionId: interaction.id, decision: 'allow_once' })).rejects.toMatchObject({ code: 'E_TASK' });
  let result: any;
  await vi.waitFor(async () => { result = await host.appTaskCall(uid, key, 'tasks.get', { requestId: 'once-permission' }, signal); expect(result.status).toBe('failed'); });
  expect(await decision).toBe('deny'); expect(result.error.code).toBe('E_INTERACTION_REQUIRED');
  expect(result.interactions).toBeUndefined(); expect(runs.calls).toHaveLength(1);
});

it('returns the reply and the delivered video of a run that leaves more than 100 files', async () => {
  // On 2026-11-17 a VideoStudio run with frames and test renders failed every
  // tasks.get with E_LIMIT, so the user never saw its reply.
  const host = await import('../../../src/main/features/web_apps/task-host'), signal = new AbortController().signal;
  runs.frames = 130;
  await host.appTaskCall(uid, key, 'tasks.start', { requestId: 'many-files', title: 'Video', prompt: 'Make video', agentId: 'commander', files: [] }, signal);
  const settled = await finish(host, 'many-files');
  expect(settled).toMatchObject({ status: 'completed', text: 'Saved video 1' });
  expect(settled.files).toHaveLength(100);
  expect(settled.files[0]).toMatchObject({ name: 'final.mp4', published: true });
  await host.maintainAppTasks();
  const saved = await host.appTaskCall(uid, key, 'tasks.get', { requestId: 'many-files' }, signal);
  expect(saved).toMatchObject({ status: 'completed', saved: true, text: 'Saved video 1' });
  expect(saved.files.map((file: any) => file.id)).toEqual(settled.files.map((file: any) => file.id));
  const video = await host.appTaskCall(uid, key, 'tasks.output', { requestId: 'many-files', outputId: saved.files.find((file: any) => file.name === 'final.mp4').id }, signal);
  expect(Buffer.from(video.base64, 'base64').toString()).toBe('video-1');
  expect(runs.calls).toHaveLength(1);
});

it('returns and archives a declared file past one thousand artifact entries', async () => {
  const host = await import('../../../src/main/features/web_apps/task-host');
  const signal = new AbortController().signal, requestId = 'artifact-delivery';
  runs.artifactDelivery = 'pending';
  const { deps } = host.taskService as unknown as { deps: TaskDependencies };
  const startWatch = deps.watch!;
  // Keep the live checks before the explicit status call settles this fixture.
  const watch = vi.spyOn(deps, 'watch').mockImplementationOnce(async (...args) => {
    await startWatch(...args);
    host.stopAppTaskMaintenance();
  });
  try {
    await host.appTaskCall(uid, key, 'tasks.start', { requestId, title: 'Archive', prompt: 'Deliver the final file', agentId: 'commander', files: [] }, signal);
  } finally {
    watch.mockRestore();
  }
  const inspected = await finish(host, requestId);
  expect(inspected.files).toHaveLength(100);
  const final = inspected.files[0];
  expect(final).toMatchObject({ name: runs.artifactDelivery, published: true });
  const call = (method: string, args: object = {}) => host.appTaskCall(uid, key, method, { requestId, ...args }, signal);
  expect(await call('tasks.output', { outputId: final.id })).toMatchObject({ base64: Buffer.from('published artifact').toString('base64') });
  const unrelated = path.join(path.dirname(runs.calls[0].workingDir), 'private-fixture.txt');
  const { listProducedPaths } = await import('../../../src/main/features/chats');
  expect(await listProducedPaths(uid, runs.calls[0].cid)).toContain(unrelated);
  expect(inspected.files.some((file: any) => file.name === 'private-fixture.txt')).toBe(false);
  await expect(call('tasks.output', { outputId: createHash('sha256').update(unrelated).digest('hex') })).rejects.toMatchObject({ code: 'E_FILE' });
  const saved = await call('tasks.get');
  expect(saved).toMatchObject({ status: 'completed', saved: true, text: inspected.text });
  expect(saved.files.map((file: any) => file.id)).toEqual(inspected.files.map((file: any) => file.id));
  const downloaded = await call('tasks.output', { outputId: final.id });
  expect(Buffer.from(downloaded.base64, 'base64').toString()).toBe('published artifact');
  expect(runs.calls).toHaveLength(1);
}, 60_000);

it.each(['removed', 'replaced'])('keeps the reply and other files if a declared file is %s before archive', async change => {
  const host = await import('../../../src/main/features/web_apps/task-host');
  const signal = new AbortController().signal, requestId = 'lost-delivery';
  const { deps } = host.taskService as unknown as { deps: TaskDependencies };
  const archive = deps.archive!;
  runs.frames = 1;
  const mutation = vi.spyOn(deps, 'archive').mockImplementationOnce(async (...args) => {
    expect(args[2].files).toContainEqual(expect.objectContaining({ name: 'final.mp4', published: true }));
    const file = path.join(runs.calls[0].workingDir, 'final.mp4');
    if (change === 'removed') await fs.unlink(file);
    else await fs.writeFile(file, 'new bytes for a different version', 'utf8');
    return archive(...args);
  });
  await host.appTaskCall(uid, key, 'tasks.start', { requestId, title: 'Clip', prompt: 'Deliver the final clip', agentId: 'commander', files: [] }, signal);
  const inspected = await finish(host, requestId);
  const saved = await host.appTaskCall(uid, key, 'tasks.get', { requestId }, signal);
  expect(mutation).toHaveBeenCalledTimes(1);
  expect(saved).toMatchObject({ status: 'failed', saved: true, text: 'Saved video 1', error: { code: 'E_OUTPUT_SAVE_FAILED' } });
  expect(saved.files).toHaveLength(1);
  expect(saved.files[0]).toMatchObject({ name: 'frame-000.png', published: false });
  await expect(host.appTaskCall(uid, key, 'tasks.output', { requestId, outputId: inspected.files.find((file: any) => file.name === 'final.mp4').id }, signal)).rejects.toMatchObject({ code: 'E_FILE' });
  expect(runs.calls).toHaveLength(1);
});

it.each([false, true])('archives a delivered file beside a non-downloadable working render (retain=%s)', async keepSession => {
  const host = await import('../../../src/main/features/web_apps/task-host');
  const signal = new AbortController().signal;
  const requestId = 'working-render';
  runs.oversizedIntermediate = true;
  await host.appTaskCall(uid, key, 'tasks.start', {
    requestId, title: 'Media review', prompt: 'Save the final review clip', agentId: 'commander', files: [], keepSession,
  }, signal);
  const settled = await finish(host, requestId);
  await host.maintainAppTasks();
  const saved = await host.appTaskCall(uid, key, 'tasks.get', { requestId }, signal);
  expect(saved).toMatchObject({ status: 'completed', saved: true, text: 'Saved video 1' });
  expect(settled.files.map((file: any) => file.id)).toEqual(saved.files.map((file: any) => file.id));
  expect(saved.files).toHaveLength(1);
  expect(saved.files[0]).toMatchObject({ name: 'final.mp4', published: true });
  const clip = await host.appTaskCall(uid, key, 'tasks.output', { requestId, outputId: saved.files[0].id }, signal);
  expect(Buffer.from(clip.base64, 'base64').toString()).toBe('video-1');
  expect(runs.calls).toHaveLength(1);
});

it('saves a text-only reply when a working render exceeds the app download limit', async () => {
  runs.textOnly = true;
  runs.oversizedIntermediate = true;
  const host = await import('../../../src/main/features/web_apps/task-host');
  const signal = new AbortController().signal;
  const requestId = 'text-only-working-render';
  await host.appTaskCall(uid, key, 'tasks.start', {
    requestId, title: 'Check the source', prompt: 'Can this material be used?', agentId: 'commander', files: [],
  }, signal);
  const settled = await finish(host, requestId);
  expect(settled).toMatchObject({ status: 'completed', text: 'I still need the source footage.' });
  await host.maintainAppTasks();
  const saved = await host.appTaskCall(uid, key, 'tasks.get', { requestId }, signal);
  expect(saved).toMatchObject({ status: 'completed', saved: true, text: settled.text, files: [] });
  const context = (await import('../../../src/main/paths')).appConversationRoot(uid, runs.calls[0].cid)!;
  await expect(fs.stat(context)).rejects.toMatchObject({ code: 'ENOENT' });
  expect(runs.calls).toHaveLength(1);
});

it('records an unavailable delivery check separately from missing media and keeps its saved files', async () => {
  const host = await import('../../../src/main/features/web_apps/task-host'), signal = new AbortController().signal;
  await host.appTaskCall(uid, key, 'tasks.start', { requestId: 'output-check', title: 'Video', prompt: 'Make video', agentId: 'commander', files: [], deliverable: 'video' }, signal);
  await finish(host, 'output-check');
  const timeout = vi.spyOn(AbortSignal, 'timeout').mockImplementation(() => AbortSignal.abort());
  try {
    const result = await host.appTaskCall(uid, key, 'tasks.get', { requestId: 'output-check' }, signal);
    expect(result).toMatchObject({ status: 'failed', saved: true, error: { code: 'E_OUTPUT_UNVERIFIED' }, files: [{ name: 'final.mp4' }] });
    const file = await host.appTaskCall(uid, key, 'tasks.output', { requestId: 'output-check', outputId: result.files[0].id }, signal);
    expect(Buffer.from(file.base64, 'base64').toString()).toBe('video-1'); expect(runs.calls).toHaveLength(1);
  } finally { timeout.mockRestore(); }
});

it('retains the user-visible terminal generation failure in its receipt after private execution cleanup',async()=>{
 const host=await import('../../../src/main/features/web_apps/task-host'),signal=new AbortController().signal;runs.failure=true;
 await host.appTaskCall(uid,key,'tasks.start',{requestId:'failed-generation',title:'Image generation',prompt:'Make an image',agentId:'commander',files:[]},signal);
 const before=await finish(host,'failed-generation');expect(before.status).toBe('failed');expect(before.text).toContain('The selected service is unavailable.');
 await host.maintainAppTasks();const saved=await host.appTaskCall(uid,key,'tasks.get',{requestId:'failed-generation'},signal);
 expect(saved).toMatchObject({status:'failed',text:before.text,saved:true,files:[]});expect(runs.calls).toHaveLength(1);
 await expect(fs.stat((await import('../../../src/main/paths')).appConversationRoot(uid,runs.calls[0].cid)!)).rejects.toMatchObject({code:'ENOENT'});
});

it('finalizes after page detachment through the real facade and serves output after the context was removed', async () => {
  const host = await import('../../../src/main/features/web_apps/task-host');
  const controller = new AbortController();
  await host.appTaskCall(uid, key, 'tasks.start', { requestId: 'once', title: 'Private video', prompt: 'Make video', agentId: 'commander', files: [] }, controller.signal);
  controller.abort();
  await finish(host, 'once');
  await host.maintainAppTasks();
  const result = await host.appTaskCall(uid, key, 'tasks.get', { requestId: 'once' }, new AbortController().signal);
  expect(result).toMatchObject({ status: 'completed', text: 'Saved video 1', files: [{ name: 'final.mp4', bytes: 7 }] });
  const paths = await import('../../../src/main/paths');
  await expect(fs.stat(paths.appConversationRoot(uid, runs.calls[0].cid)!)).rejects.toMatchObject({ code: 'ENOENT' });
  const output = await host.appTaskCall(uid, key, 'tasks.output', { requestId: 'once', outputId: result.files[0].id }, new AbortController().signal);
  expect(Buffer.from(output.base64, 'base64').toString()).toBe('video-1');
  await expect((await import('../../../src/main/features/chats')).listConversations(uid)).resolves.toEqual([]);
  expect(runs.calls).toHaveLength(1);
  await host.appTaskCall(uid, key, 'tasks.start', { requestId: 'once', title: 'Private video', prompt: 'Make video', agentId: 'commander', files: [] }, new AbortController().signal);
  expect(runs.calls).toHaveLength(1);
});

it('keeps multi-turn context, snapshots overwritten files and releases only the idle retained session', async () => {
  const host = await import('../../../src/main/features/web_apps/task-host'), signal = new AbortController().signal;
  const start = { requestId: 'turn-1', title: 'Private sequence', prompt: 'First', agentId: 'commander', files: [], keepSession: true };
  const first = await host.appTaskCall(uid, key, 'tasks.start', start, signal);
  await finish(host, 'turn-1'); await host.maintainAppTasks();
  const result1 = await host.appTaskCall(uid, key, 'tasks.get', { requestId: 'turn-1' }, signal);
  await host.appTaskCall(uid, key, 'tasks.start', { ...start, requestId: 'turn-2', prompt: 'Next', sessionId: first.sessionId }, signal);
  await finish(host, 'turn-2'); await host.maintainAppTasks();
  const result2 = await host.appTaskCall(uid, key, 'tasks.get', { requestId: 'turn-2' }, signal);
  expect(runs.calls[0].cid).toBe(runs.calls[1].cid);
  expect(result1.files[0].path).not.toBe(result2.files[0].path);
  for (const [id, result, bytes] of [['turn-1', result1, 'video-1'], ['turn-2', result2, 'video-2']] as const) {
    const value = await host.appTaskCall(uid, key, 'tasks.output', { requestId: id, outputId: result.files[0].id }, signal);
    expect(Buffer.from(value.base64, 'base64').toString()).toBe(bytes);
  }
  const paths = await import('../../../src/main/paths');
  expect((await fs.stat(paths.appConversationRoot(uid, runs.calls[0].cid)!)).isDirectory()).toBe(true);
  await host.appTaskCall(uid, key, 'tasks.release', { requestId: 'turn-1' }, signal);
  await expect(fs.stat(paths.appConversationRoot(uid, runs.calls[0].cid)!)).rejects.toMatchObject({ code: 'ENOENT' });
  await expect(host.appTaskCall(uid, key, 'tasks.start', { ...start, requestId: 'turn-3', sessionId: first.sessionId }, signal)).rejects.toMatchObject({ code: 'E_CONFLICT' });
  expect(runs.calls).toHaveLength(2);
});

it('retains pending public generation until every owning transaction settles, without replay', async () => {
  runs.unresolved = true;
  const host = await import('../../../src/main/features/web_apps/task-host'), signal = new AbortController().signal;
  await host.appTaskCall(uid, key, 'tasks.start', { requestId: 'pending-media', title: 'Video', prompt: 'Generate', agentId: 'commander', files: [] }, signal);
  const bus = await import('../../../src/main/features/group_chat/bus');
  await vi.waitFor(() => { expect(runs.calls).toHaveLength(1); expect(bus.isQuiescent(uid, runs.calls[0].cid)).toBe(true); });
  await host.maintainAppTasks();
  const paths = await import('../../../src/main/paths'), cid = runs.calls[0].cid;
  expect((await fs.stat(paths.appConversationRoot(uid, cid)!)).isDirectory()).toBe(true);
  expect((await host.appTaskCall(uid, key, 'tasks.get', { requestId: 'pending-media' }, signal)).status).toBe('running');
  expect(runs.pending).toHaveLength(1);
  const another = await startPendingGeneration(uid, cid, 'pending-two');
  await settlePendingGeneration(runs.pending[0]);
  await host.maintainAppTasks();
  expect(await host.appTaskCall(uid, key, 'tasks.get', { requestId: 'pending-media' }, signal))
    .toMatchObject({ status: 'running' });
  expect((await fs.stat(paths.appConversationRoot(uid, cid)!)).isDirectory()).toBe(true);
  expect(runs.calls).toHaveLength(1);
  await settlePendingGeneration(another);
  await host.maintainAppTasks();
  const completed = await host.appTaskCall(uid, key, 'tasks.get', { requestId: 'pending-media' }, signal);
  expect(completed.status).toBe('completed'); expect(completed.mediaStage).toBeUndefined();
  await expect(fs.stat(paths.appConversationRoot(uid, cid)!)).rejects.toMatchObject({ code: 'ENOENT' });
  expect(runs.calls).toHaveLength(1);
});

it('keeps generated sources when app result saving fails, then retries only storage', async () => {
  const host = await import('../../../src/main/features/web_apps/task-host'), signal = new AbortController().signal;
  const destination = path.join(root, uid, 'cloud', 'web_apps', key, 'files', 'results');
  await fs.mkdir(path.dirname(destination), { recursive: true }); await fs.writeFile(destination, 'blocked directory');
  await host.appTaskCall(uid, key, 'tasks.start', { requestId: 'save-retry', title: 'Video', prompt: 'Generate', agentId: 'commander', files: [] }, signal);
  await finish(host, 'save-retry');
  expect((await host.appTaskCall(uid, key, 'tasks.get', { requestId: 'save-retry' }, signal)).status).toBe('saving');
  expect(await fs.readFile(path.join(runs.calls[0].workingDir, 'final.mp4'), 'utf8')).toBe('video-1');
  await fs.unlink(destination); await host.maintainAppTasks();
  expect((await host.appTaskCall(uid, key, 'tasks.get', { requestId: 'save-retry' }, signal)).status).toBe('completed');
  expect(runs.calls).toHaveLength(1);
});

// Review 2026-11-16 S9-7: each poll of a running app task reads its conversation state once, not twice.
it('inspects a running one-shot task once per status poll', async () => {
  runs.hold = true;
  const host = await import('../../../src/main/features/web_apps/task-host'), signal = new AbortController().signal;
  await host.appTaskCall(uid, key, 'tasks.start', { requestId: 'one-look', title: 'Video', prompt: 'Make video', agentId: 'commander', files: [] }, signal);
  await vi.waitFor(() => expect(runs.release).toBeTypeOf('function'));
  await host.stopAppTaskMaintenance();
  const chat = await import('../../../src/main/features/group_chat');
  const runtime = vi.spyOn(chat, 'runtimeStatus');
  try {
    expect(await host.appTaskCall(uid, key, 'tasks.get', { requestId: 'one-look' }, signal)).toMatchObject({ status: 'running', saved: false });
    expect(runtime).toHaveBeenCalledOnce();
  } finally { runtime.mockRestore(); }
  runs.release!();
  expect(await finish(host, 'one-look')).toMatchObject({ status: 'completed' });
});

it('answers the existing permission gate only through the owning app task and never auto-approves missing decisions', async () => {
  runs.hold = true;
  const host = await import('../../../src/main/features/web_apps/task-host'), signal = new AbortController().signal;
  await host.appTaskCall(uid, key, 'tasks.start', { requestId: 'approval', title: 'Private', prompt: 'Run', agentId: 'commander', files: [], keepSession: true }, signal);
  await vi.waitFor(() => expect(runs.release).toBeTypeOf('function'));
  const permissions = await import('../../../src/main/model/core-agent/bash-permissions');
  const events = await import('../../../src/main/util/app-task-events');
  permissions._setBroadcastForTest((channel, payload) => events.captureAppTaskEvent(uid, channel, payload));
  const decision = permissions.requestBashDecision({ uid, cid: runs.calls[0].cid, agentId: 'commander', agentName: 'Commander', command: 'reviewed-operation', reasons: ['destructive'] });
  const result = await host.appTaskCall(uid, key, 'tasks.get', { requestId: 'approval' }, signal);
  expect(result.status).toBe('waiting_input'); const interactionId = result.interactions[0].id;
  await expect(host.appTaskCall(uid, key, 'tasks.respond', { requestId: 'approval', kind: 'bash:permission', interactionId }, signal)).rejects.toMatchObject({ code: 'E_INPUT' });
  await expect(host.appTaskCall(uid, 'b'.repeat(64), 'tasks.respond', { requestId: 'approval', kind: 'bash:permission', interactionId, decision: 'allow_once' }, signal)).rejects.toMatchObject({ code: 'E_TASK' });
  expect(events.appTaskInteractions(uid, runs.calls[0].cid)).toHaveLength(1);
  expect(await host.appTaskCall(uid, key, 'tasks.respond', { requestId: 'approval', kind: 'bash:permission', interactionId, decision: 'deny' }, signal)).toEqual({ handled: true });
  expect(await decision).toBe('deny');expect(events.appTaskInteractions(uid, runs.calls[0].cid)).toEqual([]);
  await expect(host.appTaskCall(uid, key, 'tasks.respond', { requestId: 'approval', kind: 'bash:permission', interactionId, decision: 'allow_once' }, signal)).rejects.toMatchObject({ code: 'E_INPUT' });
  runs.release!(); await finish(host, 'approval'); await host.maintainAppTasks();
  expect(runs.calls).toHaveLength(1);
});

it('accepts an exact app-local answer to an unstructured waiting question and rejects stale question identities', async () => {
  runs.question = true;
  const host = await import('../../../src/main/features/web_apps/task-host'), signal = new AbortController().signal;
  const directory = (await import('../../../src/main/paths')).agentDir(uid, 'a1b2c3d4e5f6');
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(path.join(directory, 'agent.json'), JSON.stringify({ agent_id: 'a1b2c3d4e5f6', name: 'Question fixture', description: 'Collects a caption', interactive: true, created_at: 't', updated_at: 't' }));
  await host.appTaskCall(uid, key, 'tasks.start', { requestId: 'question', title: 'Private', prompt: 'Create', agentId: 'a1b2c3d4e5f6', files: [], keepSession: true }, signal);
  let result: any;
  await vi.waitFor(async () => { result = await host.appTaskCall(uid, key, 'tasks.get', { requestId: 'question' }, signal); expect(result.status).toBe('waiting_input'); });
  await expect(host.appTaskCall(uid, key, 'tasks.respond', { requestId: 'question', kind: 'text', inputId: 'stale', responseId: 'answer-one', text: 'Summer launch' }, signal)).rejects.toMatchObject({ code: 'E_INPUT' });
  runs.question = false;
  await host.appTaskCall(uid, key, 'tasks.respond', { requestId: 'question', kind: 'text', inputId: result.inputId, responseId: 'answer-one', text: 'Summer launch' }, signal);
  await finish(host, 'question'); await host.maintainAppTasks();
  expect(runs.calls).toHaveLength(2);expect(runs.calls[1].message).toContain('Summer launch');
  expect((await host.appTaskCall(uid, key, 'tasks.get', { requestId: 'question' }, signal)).text).toBe('Saved video 2');
});

it.each([false, true])('keeps canonical input and execution data inside the owning app (retain=%s)', async keepSession => {
  const chats = await import('../../../src/main/features/chats');
  // Account activation creates the ordinary empty layout. Discovery may also
  // initialize its empty index; capture that baseline before app admission.
  await chats.listConversations(uid);
  const ordinary = async () => {
    const files: string[] = [];
    for (const name of ['chats', 'sessions', 'chat_attachments', 'chat_artifacts']) {
      const dir = path.join(root, uid, 'cloud', name);
      const walk = async (at: string) => {
        for (const entry of await fs.readdir(at, { withFileTypes: true }).catch(() => [])) {
          const file = path.join(at, entry.name);
          if (entry.isDirectory()) await walk(file);
          else files.push(path.relative(dir, file) + ':' + (await fs.readFile(file)).toString('base64'));
        }
      };
      await walk(dir);
    }
    return files.sort();
  };
  const before = await ordinary();
  const conv = await chats.createAppConversation(uid, key, 'Private media', keepSession);
  const cid = conv.conversation_id;
  const layout = await import('../../../src/main/util/project-layout');
  const paths = await import('../../../src/main/paths');
  const { resolveSessionPath, toolResultsDirForSession } = await import('../../../src/main/model/core-agent/session-store');
  const base = path.join(root, uid, keepSession ? 'cloud' : 'local', 'web_apps', key, keepSession ? 'sessions' : 'runs');
  for (const file of [layout.conversationMessageFile(uid, cid), layout.chatAttachmentDirForConversation(uid, cid), layout.chatArtifactCidDirForConversation(uid, cid)]) {
    expect(file.startsWith(base + path.sep)).toBe(true);
  }
  for (const sid of [`gconv-${cid}`, `gmember-${cid}-image-agent`, `gworker-${cid}-worker-one`, `cli-${cid}-agent-one`]) {
    expect(resolveSessionPath(uid, sid).startsWith(base + path.sep)).toBe(true);
    expect(toolResultsDirForSession(uid, sid).startsWith(base + path.sep)).toBe(true);
    expect(paths.sessionAnalysisInputsDir(uid, sid)).toContain(path.join('web_apps', key));
  }
  const attachment = await (await import('../../../src/main/features/chat_attachments')).uploadAttachment(uid, cid, 'source.txt', Buffer.from('private source'));
  expect(attachment.ok).toBe(true);
  await chats.bumpConversationActivity(uid, cid, new Date().toISOString());
  await chats.updateConversation(uid, cid, { title: 'Updated private title' });
  expect((await chats.getConversationMetadata(uid, cid))?.title).toBe('Updated private title');
  expect(await chats.listConversations(uid)).toEqual([]);
  expect(await chats.listConversationDisplayRows(uid, { includeHidden: true })).toEqual([]);
  expect(await ordinary()).toEqual(before);
  const workspace = await (await import('../../../src/main/features/group_chat/conv_workspace')).getConversationWorkspacePath(uid, cid);
  expect(workspace.startsWith(base + path.sep)).toBe(true);
  // Missing app data must not fall back to a legacy ordinary conversation.
  await fs.mkdir(paths.userChatsDir(uid), { recursive: true });
  await fs.writeFile(path.join(paths.userChatsDir(uid), cid + '.jsonl'), 'ordinary decoy');
  expect(layout.conversationMessageReadFile(uid, cid)).toBe(layout.conversationMessageFile(uid, cid));
});

it('rejects caller-assigned internal identities at ordinary conversation creation', async () => {
  const chats = await import('../../../src/main/features/chats');
  const privateConv = await chats.createAppConversation(uid, key, 'Private', false);
  await expect(chats.createConversation(uid, { conversationId: privateConv.conversation_id })).rejects.toThrow();
  expect(await chats.getConversationMetadata('another-account', privateConv.conversation_id)).toBeNull();
});

it('archives a receipt-bound version-one normal conversation without deleting it or replaying generation', async () => {
  const chats = await import('../../../src/main/features/chats'), chat = await import('../../../src/main/features/group_chat');
  const host = await import('../../../src/main/features/web_apps/task-host'), signal = new AbortController().signal;
  const input = { requestId: 'legacy-normal', title: 'Legacy private result', prompt: 'Original request', agentId: 'commander', files: [] };
  const conv = await chats.createConversation(uid, { title: input.title });
  await chat.send({ userId: uid, cid: conv.conversation_id, text: input.prompt, forceTo: ['commander'] });
  const bus = await import('../../../src/main/features/group_chat/bus');
  await vi.waitFor(() => { expect(runs.calls).toHaveLength(1); expect(bus.isQuiescent(uid, conv.conversation_id)).toBe(true); });
  const { createHash } = await import('node:crypto'), hash = (s: string) => createHash('sha256').update(s).digest('hex');
  const receipt = path.join((await import('../../../src/main/paths')).webAppSandboxRoot(uid, key, 'cloud'), 'tasks', hash(input.requestId) + '.json');
  await (await import('../../../src/main/storage')).writeJson(receipt, { version: 1, requestId: input.requestId, fingerprint: hash(JSON.stringify([input.title, input.agentId, input.prompt, input.files])), cid: conv.conversation_id, phase: 'submitted', createdAt: new Date().toISOString() });
  const messageFile = (await import('../../../src/main/util/project-layout')).conversationMessageFile(uid, conv.conversation_id);
  const original = await fs.readFile(messageFile);
  await expect(host.appTaskCall(uid, 'b'.repeat(64), 'tasks.get', { requestId: input.requestId }, signal)).rejects.toMatchObject({ code: 'E_TASK' });
  const result = await host.appTaskCall(uid, key, 'tasks.get', { requestId: input.requestId }, signal);
  expect(result).toMatchObject({ status: 'completed', saved: true, text: 'Saved video 1', files: [{ name: 'final.mp4' }] });
  const output = await host.appTaskCall(uid, key, 'tasks.output', { requestId: input.requestId, outputId: result.files[0].id }, signal);
  expect(Buffer.from(output.base64, 'base64').toString()).toBe('video-1');
  expect(await fs.readFile(messageFile)).toEqual(original);
  expect((await chats.getConversationMetadata(uid, conv.conversation_id))?.kind).toBe('normal');
  await host.appTaskCall(uid, key, 'tasks.start', input, signal);
  expect(runs.calls).toHaveLength(1);
  // A new-format unarchived receipt cannot claim an ordinary conversation.
  const stored = JSON.parse(await fs.readFile(receipt, 'utf8'));
  delete stored.result; delete stored.cleaned;
  await (await import('../../../src/main/storage')).writeJson(receipt, stored);
  await expect(host.appTaskCall(uid, key, 'tasks.get', { requestId: input.requestId }, signal)).rejects.toMatchObject({ code: 'E_TASK' });
});


it.each([false, true])('rejects an execution-parent link before creating private files (retain=%s)', async keepSession => {
  const parent = path.join(root, uid, keepSession ? 'cloud' : 'local', 'web_apps', key);
  const outside = path.join(root, 'outside-authorized-account');
  await fs.mkdir(parent, { recursive: true }); await fs.mkdir(outside);
  await fs.symlink(outside, path.join(parent, keepSession ? 'sessions' : 'runs'), process.platform === 'win32' ? 'junction' : 'dir');
  const host = await import('../../../src/main/features/web_apps/task-host');
  await expect(host.appTaskCall(uid, key, 'tasks.start', { requestId: 'linked-parent', title: 'Private', prompt: 'Create', agentId: 'commander', files: [], keepSession }, new AbortController().signal)).rejects.toMatchObject({ code: 'E_TASK_UNCERTAIN' });
  expect(await fs.readdir(outside)).toEqual([]);
  expect(runs.calls).toHaveLength(0);
});

async function waitingQuestion(requestId: string, keepSession = true, form = false) {
  runs.question = !form; runs.form = form;
  const host = await import('../../../src/main/features/web_apps/task-host'), signal = new AbortController().signal;
  const directory = (await import('../../../src/main/paths')).agentDir(uid, 'a1b2c3d4e5f6');
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(path.join(directory, 'agent.json'), JSON.stringify({ agent_id: 'a1b2c3d4e5f6', name: 'Question fixture', description: 'Collects a caption', interactive: true, created_at: 't', updated_at: 't' }));
  const input = { requestId, title: 'Private', prompt: 'Create', agentId: 'a1b2c3d4e5f6', files: [], keepSession };
  const admitted = await host.appTaskCall(uid, key, 'tasks.start', input, signal);
  let result: any;
  await vi.waitFor(async () => { result = await host.appTaskCall(uid, key, 'tasks.get', { requestId }, signal); expect(result.status).toBe('waiting_input'); });
  if (form) expect(result.form).toMatchObject({ form_id: expect.any(String), fields: [{ id: 'answer' }] });
  return { host, signal, input, admitted, result };
}
it('answers the current structured form through the app and finishes the same request', async () => {
  const { host, signal, input, result } = await waitingQuestion('answer-form', true, true);
  runs.form = false; runs.question = false;
  await host.appTaskCall(uid, key, 'tasks.respond', { requestId: input.requestId, kind: 'form', messageId: result.form.messageId, formId: result.form.form_id, values: { answer: 'Summer caption' } }, signal);
  await finish(host, input.requestId); await host.maintainAppTasks();
  expect((await host.appTaskCall(uid, key, 'tasks.get', { requestId: input.requestId }, signal)).status).toBe('completed');
  expect(runs.calls).toHaveLength(2); expect(runs.calls[1].message).toContain('Summer caption');
});
it.each([{ keepSession: true, form: false }, { keepSession: true, form: true }])('settles cancelled input without execution replay (retain=$keepSession, form=$form)', async ({ keepSession, form }) => {
  const { host, signal, input, admitted } = await waitingQuestion('cancel-question', keepSession, form);
  await host.appTaskCall(uid, key, 'tasks.cancel', { requestId: input.requestId }, signal);
  await host.maintainAppTasks();
  const saved = await host.appTaskCall(uid, key, 'tasks.get', { requestId: input.requestId }, signal);
  expect(saved).toMatchObject({ status: 'stopped', saved: true }); expect(saved.inputId).toBeUndefined();
  expect(runs.calls).toHaveLength(1);
  const context = (await import('../../../src/main/paths')).appConversationRoot(uid, runs.calls[0].cid)!;
  if (!keepSession) await expect(fs.stat(context)).rejects.toMatchObject({ code: 'ENOENT' });
  else {
    runs.question = false; runs.form = false;
    await host.appTaskCall(uid, key, 'tasks.start', { ...input, requestId: 'after-cancel', prompt: 'Next', sessionId: admitted.sessionId }, signal);
    await finish(host, 'after-cancel'); await host.maintainAppTasks();
    expect((await host.appTaskCall(uid, key, 'tasks.get', { requestId: 'after-cancel' }, signal)).status).toBe('completed');
    expect(runs.calls).toHaveLength(2); expect(runs.calls[1].cid).toBe(runs.calls[0].cid);
  }
});
it('rejects a stale answer after cancellation before background finalization', async () => {
  const { host, signal, input, result } = await waitingQuestion('cancel-stale-answer');
  await host.appTaskCall(uid, key, 'tasks.cancel', { requestId: input.requestId }, signal);
  await expect(host.taskService.call({ userId: uid, key, signal }, 'tasks.respond', { requestId: input.requestId, kind: 'text', inputId: result.inputId, responseId: 'late-answer', text: 'Do not restart' })).rejects.toMatchObject({ code: 'E_TASK' });
  expect(runs.calls).toHaveLength(1);
});

it('accepts cancellation when the waiting row already settled at the board boundary', async () => {
  const { host, signal, input } = await waitingQuestion('cancel-settled-row');
  const chat = await import('../../../src/main/features/group_chat'), cancel = chat.cancelTask;
  const spy = vi.spyOn(chat, 'cancelTask').mockImplementation(async (...args) => {
    await cancel(...args); // Another cancellation wins before this adapter's call.
    return cancel(...args);
  });
  try {
    await expect(host.appTaskCall(uid, key, 'tasks.cancel', { requestId: input.requestId }, signal)).resolves.toEqual({ cancelRequested: true });
    await host.maintainAppTasks();
    expect((await host.appTaskCall(uid, key, 'tasks.get', { requestId: input.requestId }, signal)).status).toBe('stopped');
    expect(runs.calls).toHaveLength(1);
  } finally { spy.mockRestore(); }
});

it.each(['process', 'command'])('keeps a cancelled retained context until its real %s child closes and explicit release, independently of another owner', async kind => {
  const { host, signal, input } = await waitingQuestion('cancel-child');
  const core = await import('#core-agent'), { bashTool } = await import('../../../src/core-agent/src/tools/builtin');
  const script = path.join(root, 'retained-child.cjs');
  await fs.writeFile(script, "console.log('READY');process.stdin.resume();");
  const quote = (value: string) => process.platform === 'win32' ? "'" + value.replace(/'/g, "''") + "'" : "'" + value.replace(/'/g, "'\\''") + "'";
  const command = (process.platform === 'win32' ? '& ' : '') + quote(process.env.ORKAS_TEST_NODE!) + ' ' + quote(script);
  const contexts = [runs.calls[0].cid, 'another-context'].map(cid => ({ workingDir: root, state: { processSessionOwner: `${uid}:${cid}`, commandSessionEnabled: kind === 'command' } }));
  const sessions: string[] = [];
  try {
    for (const ctx of contexts) {
      const result = await (kind === 'command' ? bashTool.execute({ command, yield_time_ms: 0 }, ctx) : core.processStartTool.execute({ command }, ctx));
      expect(result.isError, result.content).not.toBe(true); const started = JSON.parse(result.content);
      expect(started.status).toBe('running'); sessions.push(started.session_id);
    }
    await host.appTaskCall(uid, key, 'tasks.cancel', { requestId: input.requestId }, signal);
    await host.maintainAppTasks();
    expect((await host.appTaskCall(uid, key, 'tasks.get', { requestId: input.requestId }, signal)).status).toBe('running');
    const context = (await import('../../../src/main/paths')).appConversationRoot(uid, runs.calls[0].cid)!;
    expect((await fs.stat(context)).isDirectory()).toBe(true);
    await core.processSessionTool.execute({ action: 'stop', session_id: sessions[0] }, contexts[0]);
    await host.maintainAppTasks();
    expect(await host.appTaskCall(uid, key, 'tasks.get', { requestId: input.requestId }, signal)).toMatchObject({ status: 'stopped', saved: true });
    expect((await fs.stat(context)).isDirectory()).toBe(true);
    await host.appTaskCall(uid, key, 'tasks.release', { requestId: input.requestId }, signal);
    await expect(fs.stat(context)).rejects.toMatchObject({ code: 'ENOENT' }); expect(runs.calls).toHaveLength(1);
  } finally {
    for (const [i, session_id] of sessions.entries()) await core.processSessionTool.execute({ action: 'stop', session_id }, contexts[i]);
  }
});

it('rejects an older form addressed through a newer retained request before consuming it', async () => {
  const { host, signal, input, admitted, result: old } = await waitingQuestion('old-retained-form', true, true);
  await host.appTaskCall(uid, key, 'tasks.cancel', { requestId: input.requestId }, signal);
  await host.maintainAppTasks();
  await host.appTaskCall(uid, key, 'tasks.start', { ...input, requestId: 'new-retained-form', sessionId: admitted.sessionId }, signal);
  let current: any;
  await vi.waitFor(async () => {
    current = await host.appTaskCall(uid, key, 'tasks.get', { requestId: 'new-retained-form' }, signal);
    expect(current.status).toBe('waiting_input');
  });
  expect(current.form.messageId).not.toBe(old.form.messageId);
  await expect(host.appTaskCall(uid, key, 'tasks.respond', {
    requestId: 'new-retained-form', kind: 'form', messageId: old.form.messageId,
    formId: old.form.form_id, values: { answer: 'An old cancelled answer' },
  }, signal)).rejects.toMatchObject({ code: 'E_INPUT' });
  expect(runs.calls).toHaveLength(2);
  const chat = await import('../../../src/main/features/group_chat');
  const oldMessage = (await chat.readMessages(uid, runs.calls[0].cid, 100, { strict: true })).find(m => m.id === old.form.messageId);
  expect(oldMessage?.form?.submitted).not.toBe(true);
  runs.form = false; runs.question = false;
  await host.appTaskCall(uid, key, 'tasks.respond', {
    requestId: 'new-retained-form', kind: 'form', messageId: current.form.messageId,
    formId: current.form.form_id, values: { answer: 'The current answer' },
  }, signal);
  await finish(host, 'new-retained-form'); await host.maintainAppTasks();
  expect(await host.appTaskCall(uid, key, 'tasks.get', { requestId: 'new-retained-form' }, signal)).toMatchObject({ status: 'completed', saved: true });
  expect(runs.calls).toHaveLength(3); expect(runs.calls[2].message).toContain('The current answer');
});

it.each([false, true])('keeps an identical current-form retry idempotent while its answer is executing (file=%s)', async file => {
  runs.formFile = file;
  const { host, signal, input, result } = await waitingQuestion('current-form-retry', true, true);
  expect(result.form.fields[0].type).toBe(file ? 'file' : 'textarea');
  const directory = path.join((await import('../../../src/main/paths')).webAppSandboxRoot(uid, key, 'cloud'), 'files', 'inputs');
  if (file) {
    await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(path.join(directory, 'answer.txt'), 'The current file answer');
    await fs.writeFile(path.join(directory, 'other.txt'), 'A different file answer');
  }
  const answer = { requestId: input.requestId, kind: 'form', messageId: result.form.messageId,
    formId: result.form.form_id, values: { answer: file ? 'inputs/answer.txt' : 'One current answer' } };
  runs.hold = true;
  await host.appTaskCall(uid, key, 'tasks.respond', answer, signal);
  await vi.waitFor(() => { expect(runs.calls).toHaveLength(2); expect(runs.release).toBeTypeOf('function'); });
  const chat = await import('../../../src/main/features/group_chat');
  const submitted = (await chat.readMessages(uid, runs.calls[0].cid, 100, { strict: true })).find(m => m.id === result.form.messageId)?.form?.values?.answer;
  if (file) expect(await fs.readFile(String(submitted), 'utf8')).toBe('The current file answer');
  await expect(host.appTaskCall(uid, key, 'tasks.respond', answer, signal)).resolves.toEqual({ handled: true });
  await expect(host.appTaskCall(uid, key, 'tasks.respond', {
    ...answer, values: { answer: file ? 'inputs/other.txt' : 'A different answer' },
  }, signal)).rejects.toMatchObject({ code: 'E_INPUT' });
  expect((await chat.readMessages(uid, runs.calls[0].cid, 100, { strict: true })).find(m => m.id === result.form.messageId)?.form?.values?.answer).toEqual(submitted);
  expect(runs.calls).toHaveLength(2);
  runs.form = false; runs.hold = false; runs.release!();
  await finish(host, input.requestId); await host.maintainAppTasks();
  expect(await host.appTaskCall(uid, key, 'tasks.get', { requestId: input.requestId }, signal)).toMatchObject({ status: 'completed', saved: true });
  expect(runs.calls).toHaveLength(2);
});

it.each(['before', 'after'])('recovers a lost form reply %s dispatch without replaying accepted work', async mode => {
  const { host, signal, input, result } = await waitingQuestion('lost-form-reply', true, true);
  const chat = await import('../../../src/main/features/group_chat'), send = chat.send;
  const answer = { requestId: input.requestId, kind: 'form', messageId: result.form.messageId,
    formId: result.form.form_id, values: { answer: 'One answer after a lost reply' } };
  runs.form = false;
  const spy = vi.spyOn(chat, 'send').mockImplementationOnce(async (...args) => {
    if (mode === 'after') await send(...args);
    throw new Error('controlled lost form reply');
  });
  try {
    await expect(host.appTaskCall(uid, key, 'tasks.respond', answer, signal)).rejects.toThrow('controlled lost form reply');
    if (mode === 'after') await vi.waitFor(() => expect(runs.calls).toHaveLength(2));
    else expect(runs.calls).toHaveLength(1);
    await expect(host.appTaskCall(uid, key, 'tasks.respond', answer, signal)).resolves.toEqual({ handled: true });
    await finish(host, input.requestId); await host.maintainAppTasks();
    expect(await host.appTaskCall(uid, key, 'tasks.get', { requestId: input.requestId }, signal)).toMatchObject({ status: 'completed', saved: true });
    expect(runs.calls).toHaveLength(2);
  } finally { spy.mockRestore(); }
});

// Output preferences guide creation; a different aspect/format must not turn a
// usable result into failure, rewrite its bytes, or trigger another execution.
it.each(['image','audio','text'] as const)('saves %s output despite advisory aspect/format differences and reopens without replay', async deliverable=>{
 const host=await import('../../../src/main/features/web_apps/task-host'),signal=new AbortController().signal;
 const png='iVBORw0KGgoAAAANSUhEUgAAACgAAAAyCAIAAACh0Q7HAAAACXBIWXMAAAABAAAAAQBPJcTWAAAAMklEQVR4nO3NoQ0AAAwCMP6/eWJngGhS31xS0VnFYrFYLBaLxWKxWCwWi8VisVgsHokfqPaxKlhS/5wAAAAASUVORK5CYII=';
 const wav=Buffer.alloc(44+1600);wav.write('RIFF');wav.writeUInt32LE(wav.length-8,4);wav.write('WAVEfmt ',8);wav.writeUInt32LE(16,16);wav.writeUInt16LE(1,20);wav.writeUInt16LE(1,22);wav.writeUInt32LE(8000,24);wav.writeUInt32LE(16000,28);wav.writeUInt16LE(2,32);wav.writeUInt16LE(16,34);wav.write('data',36);wav.writeUInt32LE(1600,40);
 runs.fixture={name:deliverable==='image'?'actual.png':deliverable==='audio'?'actual.wav':'actual.txt',bytes:deliverable==='image'?png:deliverable==='audio'?wav.toString('base64'):Buffer.from('Ordinary transcript.').toString('base64'),text:'Ordinary transcript.'};
 const output=deliverable==='image'?{aspect:'16:9',format:'jpg'}:deliverable==='audio'?{format:'mp3'}:{format:'json'};
 await host.appTaskCall(uid,key,'tasks.start',{requestId:'preferences',title:'Advisory preferences',prompt:'Create from supplied material.',agentId:'commander',files:[],deliverable,output},signal);
 await finish(host,'preferences');
 const saved=await host.appTaskCall(uid,key,'tasks.get',{requestId:'preferences'},signal);
 expect(saved).toMatchObject({status:'completed',saved:true,text:'Ordinary transcript.',files:[{name:runs.fixture.name}]});expect(saved.error).toBeUndefined();
 const actual=await host.appTaskCall(uid,key,'tasks.output',{requestId:'preferences',outputId:saved.files[0].id},signal);expect(actual.base64).toBe(runs.fixture.bytes);
 await host.maintainAppTasks();expect(await host.appTaskCall(uid,key,'tasks.get',{requestId:'preferences'},signal)).toEqual(saved);expect(runs.calls).toHaveLength(1);
});

it('releases private image generation records with their retained app session', async () => {
  const host = await import('../../../src/main/features/web_apps/task-host'), signal = new AbortController().signal;
  await host.appTaskCall(uid, key, 'tasks.start', {
    requestId: 'image-session-record', title: 'Image sequence', prompt: 'Create', agentId: 'commander', files: [], keepSession: true,
  }, signal);
  await finish(host, 'image-session-record'); await host.maintainAppTasks();
  const project = path.join(runs.calls[0].workingDir, 'image-project');
  const { imageGenerationControlStatePath } = await import('../../../src/main/features/image_production_control');
  const record = imageGenerationControlStatePath(uid, project);
  await fs.mkdir(path.dirname(record), { recursive: true });
  await fs.writeFile(record, JSON.stringify({ fixture: 'private generation record' }));
  await host.appTaskCall(uid, key, 'tasks.release', { requestId: 'image-session-record' }, signal);
  await expect(fs.stat(record)).rejects.toMatchObject({ code: 'ENOENT' });
  expect(runs.calls).toHaveLength(1);
});


it.each([false, true])('starts an app CLI in its own workspace without touching the ordinary workspace (retain=%s)', async keepSession => {
  const paths = await import('../../../src/main/paths');
  const workspace = await import('../../../src/main/features/user_workspace');
  const ordinary = path.join(root, 'ordinary-workspace');
  await fs.mkdir(ordinary, { recursive: true });
  await fs.writeFile(path.join(ordinary, 'existing.txt'), 'untouched ordinary workspace');
  expect(workspace.setWorkspacePath(uid, ordinary).ok).toBe(true);
  const agentId = 'a1b2c3d4e5f6';
  const directory = paths.agentDir(uid, agentId);
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(path.join(directory, 'agent.json'), JSON.stringify({
    agent_id: agentId, name: 'App CLI fixture', description: 'Runs a local isolated fixture.',
    runtime: { kind: 'cli', cli: 'hermes' }, created_at: 't', updated_at: 't',
  }));
  const chats = await import('../../../src/main/features/chats');
  const conv = await chats.createAppConversation(uid, key, 'Isolated CLI', keepSession);
  const cid = conv.conversation_id;
  const expected = path.join(paths.appConversationRoot(uid, cid)!, 'workspace');
  await fs.mkdir(expected, { recursive: true });
  const calls: any[] = [];
  vi.doMock('../../../src/main/features/local_agents/runner', async () => ({
    ...(await vi.importActual<any>('../../../src/main/features/local_agents/runner')),
    run: async (opts: any) => {
      calls.push(opts);
      await fs.writeFile(path.join(opts.cwd, 'cli-output.txt'), 'isolated CLI output');
      opts.onEvent({ type: 'done', status: 'completed', output: 'Local CLI fixture completed.' });
      return { runId: 'isolated-app-cli', status: 'completed', output: 'Local CLI fixture completed.' };
    },
  }));
  let bus: typeof import('../../../src/main/features/group_chat/bus') | undefined;
  try {
    bus = await import('../../../src/main/features/group_chat/bus');
    await bus.enqueue({ uid, cid, fromActorId: 'user', forceTo: [agentId], text: 'Run the isolated fixture.' });
    await vi.waitFor(() => {
      expect(calls).toHaveLength(1);
      expect(bus!.isQuiescent(uid, cid)).toBe(true);
    });
    expect(calls[0].cwd).toBe(expected);
    expect(await fs.readFile(path.join(expected, 'cli-output.txt'), 'utf8')).toBe('isolated CLI output');
    expect(await fs.readdir(ordinary)).toEqual(['existing.txt']);
    expect(await fs.readFile(path.join(ordinary, 'existing.txt'), 'utf8')).toBe('untouched ordinary workspace');
    expect(await chats.listConversations(uid)).toEqual([]);
  } finally {
    await bus?.dropConv(uid, cid);
    vi.doUnmock('../../../src/main/features/local_agents/runner');
  }
});


it.each([false, true])('keeps app output observers inside the app workspace (retain=%s)', async keepSession => {
  const hooks = await import('../../../src/main/features/produced_output_hooks');
  const observed: string[] = [], finalized: string[] = [];
  const restore = hooks.registerProducedOutputHooks({
    recordFile: file => { observed.push(file); }, finalizeFile: file => { finalized.push(file); },
  });
  try {
    const host = await import('../../../src/main/features/web_apps/task-host');
    await host.appTaskCall(uid, key, 'tasks.start', {
      requestId: 'app-output-observer', title: 'Scoped output', prompt: 'Create one local file.',
      agentId: 'commander', files: [], keepSession,
    }, new AbortController().signal);
    await finish(host, 'app-output-observer');
    expect(runs.calls).toHaveLength(1);
    const paths = await import('../../../src/main/paths');
    const expected = path.join(paths.appConversationRoot(uid, runs.calls[0].cid)!, 'workspace', 'final.mp4');
    expect(observed).toEqual([expected]);
    expect(finalized).toEqual([expected]);
    expect(await fs.readFile(expected, 'utf8')).toBe('video-1');
  } finally { restore(); }
});
